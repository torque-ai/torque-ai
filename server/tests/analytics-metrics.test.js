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

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-analytics-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  mod = require('../db/analytics-metrics');
  mod.setDb(db.getDb());
  mod.setGetTask(db.getTask);
  mod.setDbFunctions({
    getCacheStats: db.getCacheStats,
    setCacheConfig: db.setCacheConfig,
    getTemplate: db.getTemplate,
    saveTemplate: db.saveTemplate,
    deleteTemplate: db.deleteTemplate,
    getPipeline: db.getPipeline,
    createPipeline: db.createPipeline,
    addPipelineStep: db.addPipelineStep,
    getPipelineSteps: db.getPipelineSteps,
    getScheduledTask: db.getScheduledTask,
    deleteScheduledTask: db.deleteScheduledTask,
    createScheduledTask: db.createScheduledTask,
    getAllConfig: db.getAllConfig,
    createTask: db.createTask,
    getConfig: db.getConfig
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

function rawDb() {
  if (db.getDb) return db.getDb();
  return db.getDbInstance();
}

function patchTask(taskId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  rawDb().prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...entries.map(([, v]) => v), taskId);
}

function mkTask(overrides = {}) {
  const task = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || `task-${Math.random().toString(36).slice(2)}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    timeout_minutes: overrides.timeout_minutes ?? 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    context: overrides.context,
    max_retries: overrides.max_retries ?? 2,
    retry_count: overrides.retry_count ?? 0,
    tags: overrides.tags,
    project: overrides.project || null,
    provider: overrides.provider || 'codex',
    template_name: overrides.template_name || null
  };
  db.createTask(task);
  return db.getTask(task.id);
}

function isoNowMinusHours(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

function resetState() {
  const tables = [
    'analytics',
    'success_metrics',
    'format_success_rates',
    'task_suggestions',
    'similar_tasks',
    'task_patterns',
    'bulk_operations',
    'duration_predictions',
    'prediction_models',
    'task_artifacts',
    'pipeline_steps',
    'pipelines',
    'scheduled_tasks',
    'templates',
    'config',
    'tasks'
  ];
  for (const table of tables) {
    rawDb().prepare(`DELETE FROM ${table}`).run();
  }
  mod.setArtifactConfig('max_per_task', '20');
  mod.setArtifactConfig('retention_days', '30');
}

describe('analytics-metrics module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  describe('recordEvent + getAnalytics', () => {
    it('records analytics events and returns parsed recent event payloads', () => {
      const task = mkTask({ task_description: 'event task' });
      mod.recordEvent('custom_event', task.id, { foo: 'bar', n: 7 });

      const result = mod.getAnalytics({ includeEvents: true, eventLimit: 10 });
      const row = result.recentEvents.find(e => e.event_type === 'custom_event');

      expect(row).toBeTruthy();
      expect(row.task_id).toBe(task.id);
      expect(row.data).toEqual({ foo: 'bar', n: 7 });
    });

    it('computes tasksByStatus and successRate from task states', () => {
      mkTask({ status: 'completed' });
      mkTask({ status: 'completed' });
      mkTask({ status: 'failed' });
      mkTask({ status: 'queued' });

      const result = mod.getAnalytics();
      expect(result.tasksByStatus.completed).toBe(2);
      expect(result.tasksByStatus.failed).toBe(1);
      expect(result.tasksByStatus.queued).toBe(1);
      expect(result.successRate).toBe(67);
    });

    it('computes avgDurationMinutes for completed tasks with timestamps', () => {
      const t1 = mkTask({ status: 'completed' });
      const t2 = mkTask({ status: 'completed' });
      patchTask(t1.id, {
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:10:00.000Z'
      });
      patchTask(t2.id, {
        started_at: '2026-01-01T01:00:00.000Z',
        completed_at: '2026-01-01T01:20:00.000Z'
      });

      const result = mod.getAnalytics();
      expect(result.avgDurationMinutes).toBe(15);
    });

    it('counts only tasks created in the last 24 hours for tasksLast24h', () => {
      const oldTask = mkTask({ status: 'queued' });
      const newTask = mkTask({ status: 'queued' });
      patchTask(oldTask.id, { created_at: isoNowMinusHours(48) });
      patchTask(newTask.id, { created_at: isoNowMinusHours(1) });

      const result = mod.getAnalytics();
      expect(result.tasksLast24h).toBe(1);
    });
  });

  describe('success metrics', () => {
    it('records success metrics and aggregates by project', () => {
      mod.recordSuccessMetrics({
        period_start: '2026-01-01T00:00:00.000Z',
        period_type: 'day',
        project: 'alpha',
        total_tasks: 10,
        successful_tasks: 8,
        failed_tasks: 2
      });
      mod.recordSuccessMetrics({
        period_start: '2026-01-02T00:00:00.000Z',
        period_type: 'day',
        project: 'beta',
        total_tasks: 5,
        successful_tasks: 2,
        failed_tasks: 3
      });

      const rows = mod.getSuccessRates({ groupBy: 'project' });
      const alpha = rows.find(r => r.group_key === 'alpha');
      const beta = rows.find(r => r.group_key === 'beta');

      expect(alpha.total).toBe(10);
      expect(alpha.success_rate).toBe(80);
      expect(beta.success_rate).toBe(40);
    });

    it('applies project/template/period/date filters in getSuccessRates', () => {
      mod.recordSuccessMetrics({
        period_start: '2026-01-01T00:00:00.000Z',
        period_type: 'day',
        project: 'proj-1',
        template: 'tpl-a',
        total_tasks: 4,
        successful_tasks: 3,
        failed_tasks: 1
      });
      mod.recordSuccessMetrics({
        period_start: '2026-02-01T00:00:00.000Z',
        period_type: 'month',
        project: 'proj-1',
        template: 'tpl-b',
        total_tasks: 6,
        successful_tasks: 6
      });

      const rows = mod.getSuccessRates({
        groupBy: 'project',
        project: 'proj-1',
        template: 'tpl-a',
        period_type: 'day',
        from_date: '2026-01-01T00:00:00.000Z',
        to_date: '2026-01-31T23:59:59.999Z'
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].group_key).toBe('proj-1');
      expect(rows[0].total).toBe(4);
      expect(rows[0].success_rate).toBe(75);
    });

    it('falls back to project grouping for invalid groupBy values', () => {
      mod.recordSuccessMetrics({
        period_start: '2026-01-03T00:00:00.000Z',
        period_type: 'day',
        project: 'fallback-group',
        total_tasks: 3,
        successful_tasks: 2,
        failed_tasks: 1
      });

      const rows = mod.getSuccessRates({ groupBy: 'project; DROP TABLE tasks' });
      expect(rows).toHaveLength(1);
      expect(rows[0].group_key).toBe('fallback-group');
    });

    it('aggregateSuccessMetrics(day) summarizes current tasks by project', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-16T12:00:00.000Z'));
      try {
      const c1 = mkTask({ project: 'pA', status: 'completed' });
      const f1 = mkTask({ project: 'pA', status: 'failed' });
      const x1 = mkTask({ project: 'pA', status: 'cancelled' });
      const c2 = mkTask({ project: 'pB', status: 'completed' });
      patchTask(c1.id, {
        created_at: '2026-01-16T10:00:00.000Z',
        started_at: '2026-01-16T10:00:00.000Z',
        completed_at: '2026-01-16T10:10:00.000Z'
      });
      patchTask(c2.id, {
        created_at: '2026-01-16T10:20:00.000Z',
        started_at: '2026-01-16T10:20:00.000Z',
        completed_at: '2026-01-16T10:30:00.000Z'
      });
      patchTask(f1.id, { created_at: '2026-01-16T11:00:00.000Z' });
      patchTask(x1.id, { created_at: '2026-01-16T11:10:00.000Z' });

      const aggregated = mod.aggregateSuccessMetrics('day');
      const rowA = aggregated.find(r => r.project === 'pA');
      const rowB = aggregated.find(r => r.project === 'pB');

      expect(rowA.total_tasks).toBe(3);
      expect(rowA.successful_tasks).toBe(1);
      expect(rowA.failed_tasks).toBe(1);
      expect(rowA.cancelled_tasks).toBe(1);
      expect(rowB.total_tasks).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('aggregateSuccessMetrics(month) stores monthly period rows', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-16T12:00:00.000Z'));
      try {
      const monthlyTask = mkTask({ project: 'pMonthly', status: 'completed' });
      patchTask(monthlyTask.id, { created_at: '2026-01-16T10:00:00.000Z' });
      mod.aggregateSuccessMetrics('month');

      const rows = rawDb().prepare('SELECT * FROM success_metrics WHERE project = ?').all('pMonthly');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].period_type).toBe('month');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('format success tracking', () => {
    it('returns zeroed stats for unknown model/format combinations', () => {
      const result = mod.getFormatSuccessRate('model-none', 'hashline');
      expect(result).toEqual({ total: 0, successes: 0, rate: 0, avg_duration: 0 });
    });

    it('records format success/failure and computes aggregate stats', () => {
      mod.recordFormatSuccess('m1', 'hashline', true, null, 10);
      mod.recordFormatSuccess('m1', 'hashline', false, 'parse_error', 20);
      mod.recordFormatSuccess('m1', 'hashline', true, null, 30);

      const result = mod.getFormatSuccessRate('m1', 'hashline');
      expect(result.total).toBe(3);
      expect(result.successes).toBe(2);
      expect(result.rate).toBe(0.67);
      expect(result.avg_duration).toBe(20);
    });

    it('returns insufficient_data when neither format has minimum samples', () => {
      mod.recordFormatSuccess('m2', 'hashline', true, null, 10);
      mod.recordFormatSuccess('m2', 'hashline-lite', true, null, 11);

      const result = mod.getBestFormatForModel('m2');
      expect(result.format).toBeNull();
      expect(result.reason).toBe('insufficient_data');
    });

    it('recommends hashline-lite when hashline is below threshold', () => {
      db.setConfig('hashline_lite_min_samples', '3');
      db.setConfig('hashline_lite_threshold', '0.8');
      mod.recordFormatSuccess('m3', 'hashline', true, null, 9);
      mod.recordFormatSuccess('m3', 'hashline', false, 'bad_edit', 9);
      mod.recordFormatSuccess('m3', 'hashline', false, 'bad_edit', 9);

      const result = mod.getBestFormatForModel('m3');
      expect(result.format).toBe('hashline-lite');
      expect(result.reason).toBe('hashline_below_threshold');
    });

    it('recommends hashline-lite when lite outperforms with enough samples', () => {
      db.setConfig('hashline_lite_min_samples', '3');
      db.setConfig('hashline_lite_threshold', '0.5');

      mod.recordFormatSuccess('m4', 'hashline', true, null, 8);
      mod.recordFormatSuccess('m4', 'hashline', true, null, 8);
      mod.recordFormatSuccess('m4', 'hashline', false, 'oops', 8);

      mod.recordFormatSuccess('m4', 'hashline-lite', true, null, 7);
      mod.recordFormatSuccess('m4', 'hashline-lite', true, null, 7);
      mod.recordFormatSuccess('m4', 'hashline-lite', true, null, 7);

      const result = mod.getBestFormatForModel('m4');
      expect(result.format).toBe('hashline-lite');
      expect(result.reason).toBe('lite_outperforms');
    });
  });

  describe('output search and stats', () => {
    it('searchTaskOutputs finds output and error snippets', () => {
      const t1 = mkTask({ status: 'completed', task_description: 'out task' });
      const t2 = mkTask({ status: 'failed', task_description: 'err task' });
      patchTask(t1.id, { output: 'prefix Needle42 suffix' });
      patchTask(t2.id, { error_output: 'Error: Needle42 was missing' });

      const results = mod.searchTaskOutputs('Needle42');
      const hit1 = results.find(r => r.id === t1.id);
      const hit2 = results.find(r => r.id === t2.id);

      expect(hit1.snippets.some(s => s.source === 'output')).toBe(true);
      expect(hit2.snippets.some(s => s.source === 'error')).toBe(true);
    });

    it('searchTaskOutputs applies status and tag filters', () => {
      const a = mkTask({ status: 'failed', tags: ['network'], task_description: 'a' });
      const b = mkTask({ status: 'failed', tags: ['db'], task_description: 'b' });
      const c = mkTask({ status: 'completed', tags: ['network'], task_description: 'c' });
      patchTask(a.id, { error_output: 'fatal TOKEN_X' });
      patchTask(b.id, { error_output: 'fatal TOKEN_X' });
      patchTask(c.id, { output: 'TOKEN_X done' });

      const results = mod.searchTaskOutputs('TOKEN_X', { status: 'failed', tags: ['network'] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(a.id);
    });

    it('searchTaskOutputs safely handles regex-special patterns', () => {
      const t = mkTask({ status: 'completed', task_description: 'regex task' });
      patchTask(t.id, { output: 'literal token: a+b(c)' });

      const results = mod.searchTaskOutputs('a+b(c)');
      expect(results).toHaveLength(1);
      expect(results[0].snippets[0].text).toContain('a+b(c)');
    });

    it('getOutputStats counts only completed/failed tasks and byte totals', () => {
      const c = mkTask({ status: 'completed' });
      const f = mkTask({ status: 'failed' });
      const q = mkTask({ status: 'queued' });
      patchTask(c.id, { output: 'abc' });
      patchTask(f.id, { error_output: 'wxyz' });
      patchTask(q.id, { output: '12345', error_output: '12345' });

      const stats = mod.getOutputStats();
      expect(stats.total_tasks).toBe(2);
      expect(stats.tasks_with_output).toBe(1);
      expect(stats.tasks_with_errors).toBe(1);
      expect(stats.total_output_bytes).toBe(3);
      expect(stats.total_error_bytes).toBe(4);
    });
  });

  describe('export and import', () => {
    it('exportData supports status filtering and parses structured task fields', () => {
      const done = mkTask({
        status: 'completed',
        tags: ['exp'],
        context: { x: 1 },
        task_description: 'export me'
      });
      mkTask({ status: 'queued', task_description: 'skip me' });
      patchTask(done.id, { output: 'done' });

      const out = mod.exportData({
        status: 'completed',
        tasks: true,
        templates: false,
        pipelines: false,
        scheduled: false,
        config: false
      });

      expect(out.version).toBe('2.0');
      expect(out.data.tasks).toHaveLength(1);
      expect(out.data.tasks[0].tags).toEqual(['exp']);
      expect(out.data.tasks[0].context).toEqual({ x: 1 });
    });

    it('exportData includes templates, pipelines, scheduled tasks, and config', () => {
      db.saveTemplate({
        name: 'tpl-export',
        description: 'template export',
        task_template: 'echo hi',
        default_timeout: 15
      });
      db.createPipeline({
        id: 'pipe-export',
        name: 'pipeline export',
        description: 'desc',
        working_directory: testDir
      });
      db.addPipelineStep({
        pipeline_id: 'pipe-export',
        step_order: 1,
        name: 'step1',
        task_template: 'run step',
        timeout_minutes: 5
      });
      db.createScheduledTask({
        id: 'sched-export',
        name: 'nightly',
        task_description: 'scheduled task',
        working_directory: testDir,
        schedule_type: 'once',
        next_run_at: new Date().toISOString()
      });
      db.setConfig('export_key', 'export_val');

      const out = mod.exportData();
      expect(out.data.templates.length).toBeGreaterThanOrEqual(1);
      expect(out.data.pipelines.length).toBe(1);
      expect(out.data.pipelines[0].steps).toHaveLength(1);
      expect(out.data.scheduled_tasks).toHaveLength(1);
      expect(out.data.config.export_key).toBe('export_val');
    });

    it('importData skips existing tasks by default', () => {
      const existing = mkTask({ id: 'task-existing', task_description: 'old desc', status: 'queued' });
      const importObj = {
        data: {
          tasks: [
            {
              id: existing.id,
              task_description: 'new desc',
              working_directory: testDir,
              status: 'queued'
            },
            {
              id: 'task-new',
              task_description: 'imported',
              working_directory: testDir,
              status: 'queued'
            }
          ]
        }
      };

      const result = mod.importData(importObj, {
        templates: false,
        pipelines: false,
        scheduled: false
      });

      expect(result.tasks.skipped).toBe(1);
      expect(result.tasks.imported).toBe(1);
      expect(db.getTask(existing.id).task_description).toBe('old desc');
      expect(db.getTask('task-new')).toBeTruthy();
    });

    it('importData replaces existing tasks when skipExisting is false', () => {
      mkTask({ id: 'task-overwrite', task_description: 'before overwrite', status: 'queued' });
      const importObj = {
        data: {
          tasks: [
            {
              id: 'task-overwrite',
              task_description: 'after overwrite',
              working_directory: testDir,
              status: 'queued'
            }
          ]
        }
      };

      const result = mod.importData(importObj, {
        skipExisting: false,
        templates: false,
        pipelines: false,
        scheduled: false
      });

      expect(result.tasks.imported).toBe(1);
      expect(result.tasks.skipped).toBe(0);
      expect(db.getTask('task-overwrite').task_description).toBe('after overwrite');
    });
  });

  describe('suggestions and similarity', () => {
    it('addTaskSuggestion and getTaskSuggestions return confidence-sorted rows', () => {
      const task = mkTask({ task_description: 'suggestions task' });
      const id1 = mod.addTaskSuggestion(task.id, 'retry', 'Try again', 0.6);
      const id2 = mod.addTaskSuggestion(task.id, 'timeout', 'Increase timeout', 0.9);

      const suggestions = mod.getTaskSuggestions(task.id);
      expect(suggestions).toHaveLength(2);
      expect(suggestions[0].id).toBe(id2);
      expect(suggestions[1].id).toBe(id1);
    });

    it('markSuggestionApplied updates applied flag and returns true on success', () => {
      const task = mkTask({ task_description: 'apply suggestion task' });
      const sid = mod.addTaskSuggestion(task.id, 'retry', 'One more try', 0.7);

      const applied = mod.markSuggestionApplied(sid);
      const row = rawDb().prepare('SELECT applied FROM task_suggestions WHERE id = ?').get(sid);

      expect(applied).toBe(true);
      expect(row.applied).toBe(1);
    });

    it('calculateTextSimilarity returns positive overlap for related texts', () => {
      const score = mod.calculateTextSimilarity(
        'Add unit tests for parser module',
        'Create parser unit tests and fixtures'
      );
      expect(score).toBeGreaterThan(0.2);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('calculateTextSimilarity returns zero when normalized tokens are empty', () => {
      const score = mod.calculateTextSimilarity('an to be', 'if or do');
      expect(score).toBe(0);
    });

    it('findSimilarTasks returns similar items and caches them', () => {
      const source = mkTask({ task_description: 'Build and run parser unit tests', status: 'failed' });
      const similar = mkTask({ task_description: 'Run unit tests for parser build', status: 'completed' });
      mkTask({ task_description: 'Deploy production infrastructure', status: 'completed' });

      const found = mod.findSimilarTasks(source.id, { minSimilarity: 0.2, limit: 5 });
      const cached = mod.getCachedSimilarTasks(source.id, 10);

      expect(found.length).toBeGreaterThan(0);
      expect(found[0].task.id).toBe(similar.id);
      expect(cached.some(c => c.similar_task_id === similar.id)).toBe(true);
    });

    it('findSimilarTasks respects statusFilter', () => {
      const source = mkTask({ task_description: 'Fix parser tests', status: 'queued' });
      const completed = mkTask({ task_description: 'Fix parser unit tests quickly', status: 'completed' });
      mkTask({ task_description: 'Fix parser tests with retries', status: 'failed' });

      const found = mod.findSimilarTasks(source.id, {
        minSimilarity: 0.1,
        limit: 10,
        statusFilter: 'completed'
      });

      expect(found).toHaveLength(1);
      expect(found[0].task.id).toBe(completed.id);
    });
  });

  describe('bulk operations', () => {
    it('createBulkOperation and getBulkOperation round-trip JSON fields', () => {
      const created = mod.createBulkOperation({
        id: 'bulk-1',
        operation_type: 'cancel',
        status: 'pending',
        filter_criteria: { status: ['queued'] },
        affected_task_ids: ['t1', 't2'],
        total_tasks: 2,
        dry_run: true,
        results: { preview: true }
      });

      expect(created.id).toBe('bulk-1');
      expect(created.filter_criteria).toEqual({ status: ['queued'] });
      expect(created.affected_task_ids).toEqual(['t1', 't2']);
      expect(created.dry_run).toBe(true);
      expect(created.results).toEqual({ preview: true });
    });

    it('updateBulkOperation stores progress and stamps completed_at on completion', () => {
      mod.createBulkOperation({ id: 'bulk-2', operation_type: 'tag', filter_criteria: {}, dry_run: false });
      const updated = mod.updateBulkOperation('bulk-2', {
        status: 'completed',
        total_tasks: 3,
        succeeded_tasks: 2,
        failed_tasks: 1,
        results: { ok: ['a', 'b'], failed: ['c'] }
      });

      expect(updated.status).toBe('completed');
      expect(updated.total_tasks).toBe(3);
      expect(updated.results.failed).toEqual(['c']);
      expect(updated.completed_at).toBeTruthy();
    });

    it('dryRunBulkOperation returns affected ids and preview payload', () => {
      const t1 = mkTask({ status: 'queued', task_description: 'first queued task description that is long enough' });
      const t2 = mkTask({ status: 'queued', task_description: 'second queued task description that is long enough' });

      const preview = mod.dryRunBulkOperation('cancel', { status: 'queued' });
      expect(preview.operation_type).toBe('cancel');
      expect(preview.total_tasks).toBe(2);
      expect(preview.affected_task_ids.sort()).toEqual([t1.id, t2.id].sort());
      expect(preview.preview[0].description.endsWith('...')).toBe(true);
    });

    it('getTasksMatchingFilter supports status arrays, tags, project, and age filters', () => {
      const oldQueued = mkTask({ status: 'queued', project: 'bulk-proj', tags: ['tag-a'] });
      const newQueued = mkTask({ status: 'queued', project: 'bulk-proj', tags: ['tag-a'] });
      const oldFailed = mkTask({ status: 'failed', project: 'bulk-proj', tags: ['tag-a'] });
      patchTask(oldQueued.id, { created_at: isoNowMinusHours(3) });
      patchTask(newQueued.id, { created_at: isoNowMinusHours(1) });
      patchTask(oldFailed.id, { created_at: isoNowMinusHours(3) });

      const rows = mod.getTasksMatchingFilter({
        status: ['queued', 'failed'],
        tags: ['tag-a'],
        project: 'bulk-proj',
        older_than_hours: 2
      });

      const ids = rows.map(r => r.id);
      expect(ids).toContain(oldQueued.id);
      expect(ids).toContain(oldFailed.id);
      expect(ids).not.toContain(newQueued.id);
    });
  });

  describe('duration prediction', () => {
    it('recordDurationPrediction and updatePredictionActual persist prediction outcomes', () => {
      const t = mkTask({ status: 'completed', task_description: 'prediction task' });
      const predId = mod.recordDurationPrediction({
        task_id: t.id,
        predicted_seconds: 100,
        confidence: 0.8,
        factors: [{ source: 'test', value: 100 }]
      });
      mod.updatePredictionActual(t.id, 80);

      const row = rawDb().prepare('SELECT * FROM duration_predictions WHERE id = ?').get(predId);
      expect(row.actual_seconds).toBe(80);
      expect(row.error_percent).toBeCloseTo(25, 5);
    });

    it('predictDuration uses fallback defaults when no models are available', () => {
      const result = mod.predictDuration('Do a generic task');
      expect(result.predicted_seconds).toBe(300);
      expect(result.confidence).toBe(0.2);
      expect(result.factors[0].source).toBe('fallback');
    });

    it('predictDuration combines pattern, keyword, and global factors', () => {
      mod.updatePredictionModel({
        model_type: 'pattern',
        model_key: 'test',
        sample_count: 5,
        avg_seconds: 120
      });
      mod.updatePredictionModel({
        model_type: 'global',
        sample_count: 12,
        avg_seconds: 240
      });

      const result = mod.predictDuration('Write unit test coverage for parser');
      const sources = result.factors.map(f => f.source);

      expect(sources).toContain('pattern');
      expect(sources).toContain('keywords');
      expect(sources).toContain('global');
      expect(result.predicted_seconds).toBeGreaterThan(90);
      expect(result.predicted_seconds).toBeLessThan(200);
    });

    it('extractPatternKey classifies task descriptions into expected buckets', () => {
      expect(mod.extractPatternKey('Fix crash on startup')).toBe('fix');
      expect(mod.extractPatternKey('Create a helper module')).toBe('create');
      expect(mod.extractPatternKey('Unknown phrasing')).toBe('general');
    });

    it('calibratePredictionModels derives global, pattern, and template models', () => {
      db.saveTemplate({
        name: 'tpl-cal',
        task_template: 'echo calibrate',
        description: 'template for calibration'
      });

      const a = mkTask({ status: 'completed', task_description: 'test parser one', template_name: 'tpl-cal' });
      const b = mkTask({ status: 'completed', task_description: 'test parser two', template_name: 'tpl-cal' });
      const c = mkTask({ status: 'completed', task_description: 'test parser three' });

      patchTask(a.id, { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:01:00.000Z' });
      patchTask(b.id, { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:02:00.000Z' });
      patchTask(c.id, { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:03:00.000Z' });

      const summary = mod.calibratePredictionModels();
      expect(summary.models_updated).toBeGreaterThanOrEqual(2);
      expect(mod.getPredictionModel('global')).toBeTruthy();
      expect(mod.getPredictionModel('pattern', 'test')).toBeTruthy();
      expect(mod.getPredictionModel('template', 'tpl-cal')).toBeTruthy();
    });
  });

  describe('task artifacts', () => {
    it('storeArtifact and getArtifact round-trip metadata', () => {
      const t = mkTask({ task_description: 'artifact task' });
      const id = randomUUID();
      const stored = mod.storeArtifact({
        id,
        task_id: t.id,
        name: 'report.json',
        file_path: '/tmp/report.json',
        mime_type: 'application/json',
        size_bytes: 1234,
        checksum: 'abc123',
        metadata: { source: 'unit-test' }
      });

      const loaded = mod.getArtifact(id);
      expect(stored.id).toBe(id);
      expect(loaded.metadata).toEqual({ source: 'unit-test' });
    });

    it('listArtifacts returns only artifacts for the requested task', () => {
      const t1 = mkTask({ task_description: 'artifact owner 1' });
      const t2 = mkTask({ task_description: 'artifact owner 2' });
      mod.storeArtifact({ id: randomUUID(), task_id: t1.id, name: 'a.txt', file_path: '/tmp/a.txt' });
      mod.storeArtifact({ id: randomUUID(), task_id: t1.id, name: 'b.txt', file_path: '/tmp/b.txt' });
      mod.storeArtifact({ id: randomUUID(), task_id: t2.id, name: 'c.txt', file_path: '/tmp/c.txt' });

      const list1 = mod.listArtifacts(t1.id);
      expect(list1).toHaveLength(2);
      expect(list1.every(a => a.task_id === t1.id)).toBe(true);
    });

    it('deleteArtifact removes existing artifacts and returns false when missing', () => {
      const t = mkTask({ task_description: 'artifact delete task' });
      const aid = randomUUID();
      mod.storeArtifact({ id: aid, task_id: t.id, name: 'to-delete.txt', file_path: '/tmp/del.txt' });

      expect(mod.deleteArtifact(aid)).toBe(true);
      expect(mod.getArtifact(aid)).toBeFalsy();
      expect(mod.deleteArtifact('does-not-exist')).toBe(false);
    });

    it('storeArtifact enforces max_per_task limits from artifact config', () => {
      const t = mkTask({ task_description: 'artifact limit task' });
      mod.setArtifactConfig('max_per_task', '1');

      mod.storeArtifact({ id: randomUUID(), task_id: t.id, name: 'first.txt', file_path: '/tmp/first.txt' });
      expect(() => mod.storeArtifact({
        id: randomUUID(),
        task_id: t.id,
        name: 'second.txt',
        file_path: '/tmp/second.txt'
      })).toThrow(/Maximum artifacts per task/);
    });
  });

  describe('utility helpers', () => {
    it('escapeRegex escapes regex metacharacters', () => {
      const escaped = mod.escapeRegex('a+b(c)?[d]');
      const re = new RegExp(escaped);
      expect(re.test('a+b(c)?[d]')).toBe(true);
    });

    it('escapeLikePattern escapes SQL LIKE wildcards and backslashes', () => {
      expect(mod.escapeLikePattern('100%_done\\x')).toBe('100\\%\\_done\\\\x');
      expect(mod.escapeLikePattern(null)).toBe('');
    });

    it('estimateFromKeywords returns null when no known keywords are found', () => {
      expect(mod.estimateFromKeywords('miscellaneous prose without matches')).toBeNull();
    });

    it('estimateFromKeywords applies keyword base and multipliers', () => {
      const result = mod.estimateFromKeywords('quick integration test');
      expect(result.keywords).toContain('integration');
      expect(result.keywords).toContain('quick');
      expect(result.seconds).toBe(135);
    });
  });
});
