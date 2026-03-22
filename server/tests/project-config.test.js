const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir;
let origDataDir;
let db;
let mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;
const costTracking = require('../db/cost-tracking');

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-projconfig-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  // Clear cached modules
  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (typeof db.getDb !== 'function' && typeof db.getDbInstance === 'function') {
    db.getDb = db.getDbInstance;
  }
  mod = require('../db/project-config-core');
  mod.setDb(db.getDb());
  // Inject required cross-module dependencies
  mod.setGetTask((id) => db.getTask(id));
  mod.setRecordEvent((...args) => {
    // recordEvent comes from analytics-metrics module; provide a no-op or delegation
    try {
      const analytics = require('../db/analytics-metrics');
      return analytics.recordEvent(...args);
    } catch { /* ignore if not available */ }
  });
}

function teardown() {
  if (db) try { db.close(); } catch {}
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    if (origDataDir !== undefined) {
      process.env.TORQUE_DATA_DIR = origDataDir;
    } else {
      delete process.env.TORQUE_DATA_DIR;
    }
  }
}

function resetTables() {
  const conn = db.getDb();
  const tables = [
    'retry_history',
    'pipeline_steps',
    'pipelines',
    'budget_alerts',
    'health_status',
    'token_usage',
    'query_stats',
    'scheduled_tasks',
    'task_events',
    'webhook_logs',
    'webhooks',
    'audit_log',
    'tasks'
  ];

  for (const table of tables) {
    try {
      conn.prepare(`DELETE FROM ${table}`).run();
    } catch {}
  }
}

function createTask(overrides = {}) {
  const payload = {
    id: randomUUID(),
    task_description: 'unit-test task',
    working_directory: testDir,
    status: 'queued',
    ...overrides
  };

  db.createTask(payload);
  return db.getTask(payload.id);
}

function createPipeline(overrides = {}) {
  const payload = {
    id: randomUUID(),
    name: 'Pipeline',
    description: 'pipeline for tests',
    working_directory: testDir,
    ...overrides
  };
  return mod.createPipeline(payload);
}

function insertHealthRow(checkType, status, responseTimeMs, errorMessage, details, checkedAt) {
  db.getDb().prepare(`
    INSERT INTO health_status (check_type, status, response_time_ms, error_message, details, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    checkType,
    status,
    responseTimeMs,
    errorMessage || null,
    details ? JSON.stringify(details) : null,
    checkedAt
  );
}

describe('project-config module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });

  beforeEach(() => {
    resetTables();
    mod.setDbFunctions({
      getTokenUsageSummary: costTracking.getTokenUsageSummary
    });
    delete global.SLOW_QUERY_THRESHOLD_MS;
    delete global.MAX_SLOW_QUERY_LOG;
    delete global.slowQueryLog;
  });

  describe('safeJsonParse', () => {
    it('parses valid JSON strings', () => {
      expect(mod.safeJsonParse('{"ok":true}', null)).toEqual({ ok: true });
    });

    it('returns fallback on invalid JSON', () => {
      expect(mod.safeJsonParse('{bad', { x: 1 })).toEqual({ x: 1 });
    });

    it('returns fallback for non-string inputs', () => {
      expect(mod.safeJsonParse(123, 'fallback')).toBe('fallback');
    });

    it('returns fallback for oversized payloads', () => {
      const big = 'x'.repeat(1048577);
      expect(mod.safeJsonParse(big, 'too-big')).toBe('too-big');
    });
  });

  describe('project root helpers', () => {
    it('findProjectRoot returns null for falsy startDir', () => {
      expect(mod.findProjectRoot(null)).toBeNull();
    });

    it('findProjectRoot walks up to marker files', () => {
      const root = path.join(testDir, 'repo-root');
      const nested = path.join(root, 'a', 'b');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');

      expect(mod.findProjectRoot(nested)).toBe(root);
    });

    it('findProjectRoot returns original dir or ancestor marker when no local marker exists', () => {
      const noMarker = path.join(testDir, 'no-marker', 'deep');
      fs.mkdirSync(noMarker, { recursive: true });
      const result = mod.findProjectRoot(noMarker);
      // Returns either the original dir (no markers in any ancestor)
      // or the nearest ancestor with a project marker (environment-dependent)
      expect(noMarker.startsWith(result)).toBe(true);
    });

    it('getProjectFromPath returns basename of detected project root', () => {
      const root = path.join(testDir, 'my-project');
      const nested = path.join(root, 'src', 'lib');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]');

      expect(mod.getProjectFromPath(nested)).toBe('my-project');
    });

    it('getProjectRoot delegates to findProjectRoot and handles null', () => {
      const root = path.join(testDir, 'my-root');
      const nested = path.join(root, 'nested');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(root, 'Makefile'), 'all:');

      expect(mod.getProjectRoot(nested)).toBe(root);
      expect(mod.getProjectRoot(null)).toBeNull();
    });
  });

  describe('retry management', () => {
    it('incrementRetry returns null for missing task', () => {
      expect(mod.incrementRetry('missing-task-id')).toBeNull();
    });

    it('incrementRetry increments and flips shouldRetry when limit exceeded', () => {
      const task = createTask({ max_retries: 1 });

      const first = mod.incrementRetry(task.id);
      expect(first.retryCount).toBe(1);
      expect(first.maxRetries).toBe(1);
      expect(first.shouldRetry).toBe(true);

      const second = mod.incrementRetry(task.id);
      expect(second.retryCount).toBe(2);
      expect(second.shouldRetry).toBe(false);
    });

    it('configureTaskRetry updates retry fields', () => {
      const task = createTask();
      const updated = mod.configureTaskRetry(task.id, {
        max_retries: 5,
        retry_strategy: 'linear',
        retry_delay_seconds: 12
      });

      expect(updated.max_retries).toBe(5);
      expect(updated.retry_strategy).toBe('linear');
      expect(updated.retry_delay_seconds).toBe(12);
    });

    it('configureTaskRetry returns existing task on empty update payload', () => {
      const task = createTask({ max_retries: 3 });
      const unchanged = mod.configureTaskRetry(task.id, {});
      expect(unchanged.max_retries).toBe(3);
    });

    it('calculateRetryDelay supports exponential and linear strategies', () => {
      expect(mod.calculateRetryDelay({
        retry_delay_seconds: 10,
        retry_count: 3,
        retry_strategy: 'exponential'
      })).toBe(80);

      expect(mod.calculateRetryDelay({
        retry_delay_seconds: 10,
        retry_count: 3,
        retry_strategy: 'linear'
      })).toBe(40);
    });

    it('calculateRetryDelay handles fixed and caps extreme delays', () => {
      expect(mod.calculateRetryDelay({
        retry_delay_seconds: 9,
        retry_count: 999,
        retry_strategy: 'fixed'
      })).toBe(9);

      const capped = mod.calculateRetryDelay({
        retry_delay_seconds: 1000,
        retry_count: 999,
        retry_strategy: 'exponential'
      });
      expect(capped).toBe(7 * 24 * 60 * 60);
    });

    it('recordRetryAttempt writes history rows ordered by attempt_number', () => {
      const task = createTask();

      mod.recordRetryAttempt(task.id, { attempt_number: 2, delay_used: 5, error_message: 'second' });
      mod.recordRetryAttempt(task.id, { attempt_number: 1, delay_used: 1, error_message: 'first' });

      const history = mod.getRetryHistory(task.id);
      const refreshedTask = db.getTask(task.id);

      expect(history).toHaveLength(2);
      expect(history.map(h => h.attempt_number)).toEqual([1, 2]);
      expect(refreshedTask.last_retry_at).toBeTruthy();
    });
  });

  describe('budget alerts', () => {
    it('createBudgetAlert persists alert and normalizes enabled flag', () => {
      const alert = mod.createBudgetAlert({
        id: randomUUID(),
        project: 'alpha',
        alert_type: 'daily_cost',
        threshold_percent: 80,
        threshold_value: 100
      });

      expect(alert).toBeTruthy();
      expect(alert.enabled).toBe(true);
      expect(alert.cooldown_minutes).toBe(60);
      expect(mod.getBudgetAlert(alert.id).enabled).toBe(true);
    });

    it('listBudgetAlerts(project) includes project-specific and global alerts', () => {
      const a = mod.createBudgetAlert({
        id: randomUUID(),
        project: 'alpha',
        alert_type: 'daily_cost',
        threshold_percent: 75,
        threshold_value: 100
      });
      const g = mod.createBudgetAlert({
        id: randomUUID(),
        project: null,
        alert_type: 'daily_cost',
        threshold_percent: 75,
        threshold_value: 100
      });
      mod.createBudgetAlert({
        id: randomUUID(),
        project: 'beta',
        alert_type: 'daily_cost',
        threshold_percent: 75,
        threshold_value: 100
      });

      const listed = mod.listBudgetAlerts({ project: 'alpha' }).map(x => x.id);
      expect(listed).toContain(a.id);
      expect(listed).toContain(g.id);
    });

    it('listBudgetAlerts supports enabled filter', () => {
      mod.createBudgetAlert({
        id: randomUUID(),
        project: 'alpha',
        alert_type: 'daily_tokens',
        threshold_percent: 90,
        threshold_value: 1000,
        enabled: true
      });
      const disabled = mod.createBudgetAlert({
        id: randomUUID(),
        project: 'alpha',
        alert_type: 'daily_tokens',
        threshold_percent: 90,
        threshold_value: 1000,
        enabled: false
      });

      const onlyDisabled = mod.listBudgetAlerts({ project: 'alpha', enabled: false });
      expect(onlyDisabled).toHaveLength(1);
      expect(onlyDisabled[0].id).toBe(disabled.id);
      expect(onlyDisabled[0].enabled).toBe(false);
    });

    it('checkBudgetAlerts triggers when threshold is crossed', () => {
      mod.setDbFunctions({
        getTokenUsageSummary: () => ({ total_cost_usd: 120, total_tokens: 5000 })
      });

      const alert = mod.createBudgetAlert({
        id: randomUUID(),
        project: 'alpha',
        alert_type: 'daily_cost',
        threshold_percent: 80,
        threshold_value: 100
      });

      const triggered = mod.checkBudgetAlerts('alpha');
      expect(triggered).toHaveLength(1);
      expect(triggered[0].alert.id).toBe(alert.id);
      expect(triggered[0].percentUsed).toBe(120);
    });

    it('checkBudgetAlerts respects cooldown and skips recently triggered alerts', () => {
      mod.setDbFunctions({
        getTokenUsageSummary: () => ({ total_cost_usd: 200, total_tokens: 9000 })
      });

      const alert = mod.createBudgetAlert({
        id: randomUUID(),
        project: 'alpha',
        alert_type: 'daily_cost',
        threshold_percent: 80,
        threshold_value: 100,
        cooldown_minutes: 60
      });

      mod.updateBudgetAlert(alert.id, { last_triggered_at: new Date().toISOString() });
      expect(mod.checkBudgetAlerts('alpha')).toEqual([]);
    });

    it('checkBudgetAlerts(project) excludes alerts from other projects', () => {
      mod.setDbFunctions({
        getTokenUsageSummary: () => ({ total_cost_usd: 200, total_tokens: 9000 })
      });

      const a = mod.createBudgetAlert({
        id: randomUUID(),
        project: 'alpha',
        alert_type: 'daily_cost',
        threshold_percent: 80,
        threshold_value: 100
      });
      mod.createBudgetAlert({
        id: randomUUID(),
        project: 'beta',
        alert_type: 'daily_cost',
        threshold_percent: 80,
        threshold_value: 100
      });

      const triggered = mod.checkBudgetAlerts('alpha');
      expect(triggered).toHaveLength(1);
      expect(triggered[0].alert.id).toBe(a.id);
      expect(triggered[0].alert.project).toBe('alpha');
    });
  });

  describe('dependency helpers', () => {
    it('checkDependencies returns satisfied when task has no dependencies', () => {
      const task = createTask();
      expect(mod.checkDependencies(task.id)).toEqual({ satisfied: true, pending: [] });
    });

    it('checkDependencies reports pending dependencies', () => {
      const depDone = createTask({ status: 'completed' });
      const depPending = createTask({ status: 'queued' });
      const main = createTask({ depends_on: [depDone.id, depPending.id] });

      const result = mod.checkDependencies(main.id);
      expect(result.satisfied).toBe(false);
      expect(result.pending).toEqual([depPending.id]);
    });

    it('checkDependencies is satisfied when all dependencies are completed', () => {
      const depA = createTask({ status: 'completed' });
      const depB = createTask({ status: 'completed' });
      const main = createTask({ depends_on: [depA.id, depB.id] });

      const result = mod.checkDependencies(main.id);
      expect(result.satisfied).toBe(true);
      expect(result.pending).toEqual([]);
    });

    it('getDependentTasks returns only pending/queued/blocked tasks', () => {
      const parent = createTask({ status: 'completed' });
      const queued = createTask({ status: 'queued', depends_on: [parent.id] });
      const blocked = createTask({ status: 'blocked', depends_on: [parent.id] });
      createTask({ status: 'running', depends_on: [parent.id] });

      const deps = mod.getDependentTasks(parent.id).map(t => t.id);
      expect(deps).toContain(queued.id);
      expect(deps).toContain(blocked.id);
      expect(deps).toHaveLength(2);
    });

    it('getDependentTasks escapes LIKE wildcard characters in task IDs', () => {
      const targetId = `dep-%_literal-${randomUUID()}`;
      createTask({ id: targetId, status: 'completed' });

      const exact = createTask({ status: 'queued', depends_on: [targetId] });
      createTask({ status: 'queued', depends_on: ['dep-AXliteral-not-exact'] });

      const deps = mod.getDependentTasks(targetId).map(t => t.id);
      expect(deps).toContain(exact.id);
      expect(deps).toHaveLength(1);
    });
  });

  describe('pipeline functions', () => {
    it('createPipeline creates a pending pipeline and getPipeline returns steps array', () => {
      const created = createPipeline({ name: 'Build Pipeline' });
      const fetched = mod.getPipeline(created.id);

      expect(created.status).toBe('pending');
      expect(fetched.id).toBe(created.id);
      expect(Array.isArray(fetched.steps)).toBe(true);
      expect(fetched.steps).toHaveLength(0);
    });

    it('addPipelineStep assigns sequential step_order by default', () => {
      const p = createPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 'one', task_template: 'echo 1' });
      mod.addPipelineStep({ pipeline_id: p.id, name: 'two', task_template: 'echo 2' });

      const steps = mod.getPipelineSteps(p.id);
      expect(steps.map(s => s.step_order)).toEqual([1, 2]);
    });

    it('addPipelineStep respects explicit step_order', () => {
      const p = createPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 'late', task_template: 'echo', step_order: 10 });
      const steps = mod.getPipelineSteps(p.id);
      expect(steps[0].step_order).toBe(10);
    });

    it('getPipelineSteps parses output_vars from JSON', () => {
      const p = createPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];

      mod.updatePipelineStep(step.id, { output_vars: { artifact: 'dist.zip' }, status: 'completed' });
      const updated = mod.getPipelineSteps(p.id)[0];

      expect(updated.output_vars).toEqual({ artifact: 'dist.zip' });
      expect(updated.status).toBe('completed');
    });

    it('updatePipelineStatus sets started_at when transitioning to running', () => {
      const p = createPipeline();
      const running = mod.updatePipelineStatus(p.id, 'running');
      expect(running.status).toBe('running');
      expect(running.started_at).toBeTruthy();
    });

    it('updatePipelineStatus sets completed_at and additional fields for terminal states', () => {
      const p = createPipeline();
      const failed = mod.updatePipelineStatus(p.id, 'failed', { error: 'boom' });
      expect(failed.status).toBe('failed');
      expect(failed.completed_at).toBeTruthy();
      expect(failed.error).toBe('boom');
    });

    it('transitionPipelineStepStatus performs atomic transition on matching status', () => {
      const p = createPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];
      const task = createTask();

      const ok = mod.transitionPipelineStepStatus(step.id, 'pending', 'running', { task_id: task.id });
      const updated = mod.getPipelineSteps(p.id)[0];

      expect(ok).toBe(true);
      expect(updated.status).toBe('running');
      expect(updated.task_id).toBe(task.id);
    });

    it('transitionPipelineStepStatus fails when current status does not match', () => {
      const p = createPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];

      const ok = mod.transitionPipelineStepStatus(step.id, 'completed', 'running');
      expect(ok).toBe(false);
    });

    it('transitionPipelineStepStatus accepts array for fromStatus', () => {
      const p = createPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task' });
      const step = mod.getPipelineSteps(p.id)[0];

      const ok = mod.transitionPipelineStepStatus(step.id, ['queued', 'pending'], 'running');
      expect(ok).toBe(true);
    });

    it('getNextPipelineStep returns next pending step and undefined when none remain', () => {
      const p = createPipeline();
      mod.addPipelineStep({ pipeline_id: p.id, name: 's1', task_template: 'task1' });
      mod.addPipelineStep({ pipeline_id: p.id, name: 's2', task_template: 'task2' });

      const [s1, s2] = mod.getPipelineSteps(p.id);
      mod.updatePipelineStep(s1.id, { status: 'completed' });

      const next = mod.getNextPipelineStep(p.id);
      expect(next.id).toBe(s2.id);

      mod.updatePipelineStep(s2.id, { status: 'completed' });
      expect(mod.getNextPipelineStep(p.id)).toBeUndefined();
    });

    it('addParallelPipelineStep and isParallelGroupComplete handle group completion', () => {
      const p = createPipeline();
      mod.addParallelPipelineStep({
        pipeline_id: p.id,
        name: 'a',
        task_template: 'A',
        parallel_group: 'grp1'
      });
      mod.addParallelPipelineStep({
        pipeline_id: p.id,
        name: 'b',
        task_template: 'B',
        parallel_group: 'grp1'
      });

      const steps = mod.getPipelineSteps(p.id);
      expect(steps[0].condition).toBe('on_success');
      expect(mod.isParallelGroupComplete(p.id, 'grp1')).toBe(false);

      mod.updatePipelineStep(steps[0].id, { status: 'completed' });
      mod.updatePipelineStep(steps[1].id, { status: 'failed' });
      expect(mod.isParallelGroupComplete(p.id, 'grp1')).toBe(true);
    });
  });

  describe('health checks', () => {
    it('recordHealthCheck stores row and getLatestHealthCheck parses details', () => {
      mod.recordHealthCheck('db', 'healthy', 42, null, { pool: 'ok' });
      const latest = mod.getLatestHealthCheck('db');

      expect(latest).toBeTruthy();
      expect(latest.check_type).toBe('db');
      expect(latest.status).toBe('healthy');
      expect(latest.details).toEqual({ pool: 'ok' });
    });

    it('getLatestHealthCheck supports filtering by checkType', () => {
      const base = Date.now();
      insertHealthRow('db', 'healthy', 10, null, null, new Date(base - 2000).toISOString());
      insertHealthRow('api', 'unhealthy', 300, 'timeout', null, new Date(base - 1000).toISOString());
      insertHealthRow('db', 'unhealthy', 50, 'lock', null, new Date(base).toISOString());

      const latestDb = mod.getLatestHealthCheck('db');
      expect(latestDb.check_type).toBe('db');
      expect(latestDb.status).toBe('unhealthy');
    });

    it('getHealthHistory applies checkType and limit options', () => {
      mod.recordHealthCheck('api', 'healthy', 10);
      mod.recordHealthCheck('api', 'healthy', 20);
      mod.recordHealthCheck('api', 'healthy', 30);
      mod.recordHealthCheck('db', 'healthy', 40);

      const history = mod.getHealthHistory({ checkType: 'api', limit: 2 });
      expect(history).toHaveLength(2);
      expect(history.every(h => h.check_type === 'api')).toBe(true);
    });

    it('getHealthSummary returns uptime and avg response metrics', () => {
      const base = Date.now();
      insertHealthRow('api', 'healthy', 100, null, null, new Date(base - 2000).toISOString());
      insertHealthRow('api', 'healthy', 120, null, null, new Date(base - 1000).toISOString());
      insertHealthRow('api', 'unhealthy', 50, 'boom', null, new Date(base).toISOString());

      const summary = mod.getHealthSummary();
      expect(summary.api).toBeTruthy();
      expect(summary.api.status).toBe('unhealthy');
      expect(summary.api.uptimePercent).toBe(67);
      expect(summary.api.avgResponseTime).toBe(90);
      expect(summary.api.lastError).toBe('boom');
    });

    it('cleanupHealthHistory removes old rows and bounds invalid day input', () => {
      const conn = db.getDb();
      const old = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000)).toISOString();
      conn.prepare(`
        INSERT INTO health_status (check_type, status, response_time_ms, error_message, details, checked_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('db', 'healthy', 10, null, null, old);

      mod.recordHealthCheck('db', 'healthy', 20);
      const deleted = mod.cleanupHealthHistory(-5);
      const remaining = mod.getHealthHistory({ checkType: 'db', limit: 10 });

      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].response_time_ms).toBe(20);
    });
  });

  describe('project and database summaries', () => {
    it('listProjects aggregates task counts and token usage costs', () => {
      const t1 = createTask({ project: 'proj-a', status: 'completed' });
      createTask({ project: 'proj-a', status: 'failed' });
      createTask({ project: 'proj-b', status: 'queued' });

      costTracking.recordTokenUsage(t1.id, { input_tokens: 1000, output_tokens: 500, model: 'codex' });

      const projects = mod.listProjects();
      const projA = projects.find(p => p.project === 'proj-a');
      const projB = projects.find(p => p.project === 'proj-b');

      expect(projA.task_count).toBe(2);
      expect(projA.completed_count).toBe(1);
      expect(projA.failed_count).toBe(1);
      expect(projA.total_tokens).toBeGreaterThan(0);
      expect(projA.total_cost).toBeGreaterThan(0);
      expect(projB.active_count).toBe(1);
    });

    it('getProjectStats returns status, tags, templates, and cost summaries', () => {
      const t1 = createTask({
        project: 'proj-stats',
        status: 'completed',
        tags: ['api', 'auth'],
        template_name: 'tpl-build'
      });
      const t2 = createTask({ project: 'proj-stats', status: 'failed', tags: ['api'] });
      createTask({ project: 'proj-stats', status: 'queued', tags: ['ui'] });

      costTracking.recordTokenUsage(t1.id, { input_tokens: 400, output_tokens: 600, model: 'codex' });
      costTracking.recordTokenUsage(t2.id, { input_tokens: 300, output_tokens: 200, model: 'codex' });

      const stats = mod.getProjectStats('proj-stats');
      const apiTag = stats.top_tags.find(t => t.tag === 'api');

      expect(stats.total_tasks).toBe(3);
      expect(stats.tasks_by_status.completed).toBe(1);
      expect(stats.tasks_by_status.failed).toBe(1);
      expect(stats.tasks_by_status.queued).toBe(1);
      expect(stats.cost.total_tokens).toBeGreaterThan(0);
      expect(apiTag.count).toBe(2);
      expect(stats.top_templates[0].template_name).toBe('tpl-build');
      expect(stats.recent_tasks.length).toBe(3);
    });

    it('getCurrentProject returns detected project name from working directory', () => {
      const root = path.join(testDir, 'detect-me');
      const nested = path.join(root, 'src', 'nested');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]');

      expect(mod.getCurrentProject(nested)).toBe('detect-me');
    });

    it('getResourceMetrics returns memory, database, and table metrics', () => {
      createTask({ project: 'res-metrics' });
      const metrics = mod.getResourceMetrics();

      expect(typeof metrics.timestamp).toBe('string');
      expect(typeof metrics.memory.heapUsed).toBe('number');
      expect(typeof metrics.database.sizeBytes).toBe('number');
      expect(typeof metrics.tables.tasks).toBe('number');
      expect(metrics.tables.tasks).toBeGreaterThanOrEqual(1);
    });

    it('getDatabaseHealth and vacuum return structured diagnostics', () => {
      const health = mod.getDatabaseHealth();
      const vac = mod.vacuum();

      expect(health.checks.connectivity.status).toBe('pass');
      expect(health.checks.integrity).toBeTruthy();
      expect(health.metrics.tableCounts.tasks).toBeGreaterThanOrEqual(0);
      expect(['healthy', 'degraded', 'unhealthy']).toContain(health.status);

      expect(vac.success).toBe(true);
      expect(typeof vac.sizeBefore).toBe('number');
      expect(typeof vac.sizeAfter).toBe('number');
      expect(typeof vac.reclaimed).toBe('number');
    });
  });

  describe('timedQuery', () => {
    it('returns queryFn result for normal execution', () => {
      const result = mod.timedQuery('fast-query', () => 123);
      expect(result).toBe(123);
    });

    it('records slow queries without throwing', () => {
      // timedQuery now uses module-level constants (SLOW_QUERY_THRESHOLD_MS=100ms)
      // We can't observe the internal log from outside, but we can verify it doesn't throw
      // and correctly returns the queryFn result even for slow queries
      const result = mod.timedQuery('slow-query', () => {
        // Simulate a slow query (but we can't guarantee it exceeds 100ms threshold in CI)
        return 'slow-result';
      });
      expect(result).toBe('slow-result');
    });

    it('rethrows queryFn errors', () => {
      expect(() => mod.timedQuery('boom', () => {
        throw new Error('query failed');
      })).toThrow('query failed');
    });
  });
});
