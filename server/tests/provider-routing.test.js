const path = require('path');
const os = require('os');
const fs = require('fs');

let testDir;
let origDataDir;
let db;
let taskCore;
let configCore;
let mod;
let seq = 0;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-provrouting-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');

  taskCore = require('../db/task-core');

  configCore = require('../db/config-core');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  mod = require('../db/provider-routing-core');
  mod.setDb(db.getDb());
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

function id(prefix) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

function rawDb() {
  return db.getDb ? db.getDb() : db.getDbInstance();
}

function createTask(overrides = {}) {
  const taskId = overrides.id || id('task');
  taskCore.createTask({
    id: taskId,
    task_description: overrides.task_description || `Task ${taskId}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    project: overrides.project || 'proj-tests',
    provider: overrides.provider || 'codex',
    ...overrides,
  });
  return taskId;
}

function createWorkflow(overrides = {}) {
  const workflowId = overrides.id || id('workflow');
  rawDb().prepare(
    'INSERT INTO workflows (id, name, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(
    workflowId,
    overrides.name || `Workflow ${workflowId}`,
    overrides.status || 'pending',
    overrides.created_at || new Date().toISOString()
  );
  return workflowId;
}

function loadFreshProviderRouting() {
  // Clear cached module to get truly fresh module state
  delete require.cache[require.resolve('../db/provider-routing-core')];
  const fresh = require('../db/provider-routing-core');
  fresh.setDb(rawDb());
  if (fresh.setGetTask) fresh.setGetTask(taskCore.getTask);
  return fresh;
}

async function startMockOllama(statusCode = 200) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.statusCode = statusCode;
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return {
    host: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

describe('provider-routing module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });

  describe('provider CRUD and defaults', () => {
    it('getProvider returns seeded provider with parsed fields', () => {
      const provider = mod.getProvider('codex');
      expect(provider).toBeTruthy();
      expect(provider.provider).toBe('codex');
      expect(provider.transport).toBe('hybrid');
      expect(typeof provider.enabled).toBe('boolean');
      expect(Array.isArray(provider.quota_error_patterns)).toBe(true);
    });

    it('getProvider returns null for unknown provider', () => {
      expect(mod.getProvider(id('missing-provider'))).toBeFalsy();
    });

    it('listProviders returns providers sorted by priority ascending', () => {
      const providers = mod.listProviders();
      expect(Array.isArray(providers)).toBe(true);
      expect(providers.length).toBeGreaterThan(0);
      for (let i = 1; i < providers.length; i += 1) {
        expect(providers[i - 1].priority).toBeLessThanOrEqual(providers[i].priority);
      }
      for (const p of providers) {
        expect(['api', 'cli', 'hybrid']).toContain(p.transport);
        expect(typeof p.enabled).toBe('boolean');
        expect(Array.isArray(p.quota_error_patterns)).toBe(true);
      }
    });

    it('updateProvider updates scalar fields', () => {
      const updated = mod.updateProvider('codex', {
        enabled: 0,
        priority: 77,
        cli_path: '/tmp/codex-cli',
        cli_args: '--json',
        max_concurrent: 9,
      });
      expect(updated.enabled).toBe(false);
      expect(updated.priority).toBe(77);
      expect(updated.cli_path).toBe('/tmp/codex-cli');
      expect(updated.cli_args).toBe('--json');
      expect(updated.max_concurrent).toBe(9);

      mod.updateProvider('codex', { enabled: 1, priority: 1 });
    });

    it('updateProvider updates transport', () => {
      const updated = mod.updateProvider('codex', { transport: 'api' });
      expect(updated.transport).toBe('api');
      const reverted = mod.updateProvider('codex', { transport: 'hybrid' });
      expect(reverted.transport).toBe('hybrid');
    });

    it('updateProvider rejects invalid transport', () => {
      expect(() => mod.updateProvider('codex', { transport: 'webrtc' })).toThrow(/Invalid transport/i);
    });

    it('updateProvider serializes quota_error_patterns arrays', () => {
      const patterns = ['429', 'limit exceeded'];
      const updated = mod.updateProvider('claude-cli', { quota_error_patterns: patterns });
      expect(updated.quota_error_patterns).toEqual(patterns);
    });

    it('setDefaultProvider updates default provider', () => {
      const previous = mod.getDefaultProvider();
      const next = previous === 'codex' ? 'claude-cli' : 'codex';
      const set = mod.setDefaultProvider(next);
      expect(set).toBe(next);
      // Clear config cache so getDatabaseConfig reads the freshly written value
      require('../db/config-core').clearConfigCache();
      expect(mod.getDefaultProvider()).toBe(next);
      mod.setDefaultProvider(previous);
    });

    it('setDefaultProvider throws on unknown provider', () => {
      expect(() => mod.setDefaultProvider(id('unknown-provider'))).toThrow(/Unknown provider/i);
    });

    it('setDefaultProvider throws when provider is disabled', () => {
      mod.updateProvider('anthropic', { enabled: 0 });
      const disabled = mod.getProvider('anthropic');
      expect(disabled).toBeTruthy();
      expect(disabled.enabled).toBe(false);
      expect(() => mod.setDefaultProvider('anthropic')).toThrow(/disabled/i);
    });
  });

  describe('fallback provider selection', () => {
    function restoreFallbackChain(provider, previousValue) {
      const key = `fallback_chain_${provider}`;
      if (previousValue === null || previousValue === undefined) {
        rawDb().prepare('DELETE FROM config WHERE key = ?').run(key);
      } else {
        configCore.setConfig(key, previousValue);
      }
    }

    it('getNextFallbackProvider skips providers already recorded in failover_events', () => {
      const provider = 'codex';
      const key = `fallback_chain_${provider}`;
      const previousChain = configCore.getConfig(key);
      const previousClaude = mod.getProvider('claude-cli')?.enabled;
      const previousOllama = mod.getProvider('ollama')?.enabled;
      const taskId = createTask({ provider, original_provider: provider });

      try {
        mod.updateProvider('claude-cli', { enabled: 1 });
        mod.updateProvider('ollama', { enabled: 1 });
        mod.setProviderFallbackChain(provider, ['claude-cli', 'ollama']);
        // Clear config cache so getProviderFallbackChain reads the freshly written chain
        require('../db/config-core').clearConfigCache();
        db.recordFailoverEvent({
          task_id: taskId,
          from_provider: provider,
          to_provider: 'claude-cli',
          reason: 'quota',
          failover_type: 'provider',
        });
        db.recordFailoverEvent({
          task_id: taskId,
          from_provider: provider,
          to_provider: 'claude-cli',
          reason: 'quota',
          failover_type: 'provider',
        });

        expect(mod.getNextFallbackProvider(taskId)).toBe('ollama');
      } finally {
        if (previousClaude !== undefined) mod.updateProvider('claude-cli', { enabled: previousClaude ? 1 : 0 });
        if (previousOllama !== undefined) mod.updateProvider('ollama', { enabled: previousOllama ? 1 : 0 });
        restoreFallbackChain(provider, previousChain);
      }
    });

    it('getNextFallbackProvider no longer parses Auto-Failover text from error_output', () => {
      const provider = 'codex';
      const key = `fallback_chain_${provider}`;
      const previousChain = configCore.getConfig(key);
      const previousClaude = mod.getProvider('claude-cli')?.enabled;
      const previousOllama = mod.getProvider('ollama')?.enabled;
      const taskId = createTask({
        provider,
        original_provider: provider,
        error_output: '[Auto-Failover] Switching from codex to claude-cli',
      });

      try {
        mod.updateProvider('claude-cli', { enabled: 1 });
        mod.updateProvider('ollama', { enabled: 1 });
        mod.setProviderFallbackChain(provider, ['claude-cli', 'ollama']);
        expect(mod.getNextFallbackProvider(taskId)).toBe('claude-cli');
      } finally {
        if (previousClaude !== undefined) mod.updateProvider('claude-cli', { enabled: previousClaude ? 1 : 0 });
        if (previousOllama !== undefined) mod.updateProvider('ollama', { enabled: previousOllama ? 1 : 0 });
        restoreFallbackChain(provider, previousChain);
      }
    });
  });

  describe('usage tracking', () => {
    it('recordProviderUsage aggregates usage and success stats', () => {
      const provider = id('usage-provider');
      mod.recordProviderUsage(provider, createTask(), {
        tokens_used: 100,
        cost_estimate: 0.25,
        duration_seconds: 10,
        success: true,
      });
      mod.recordProviderUsage(provider, createTask(), {
        tokens_used: 50,
        cost_estimate: 0.75,
        duration_seconds: 30,
        success: false,
        error_type: 'timeout',
        transport: 'api',
        elapsed_ms: 420,
        retry_count: 2,
        failure_reason: 'provider_unavailable',
      });

      const stats = mod.getProviderStats(provider, 30);
      expect(stats.total_tasks).toBe(2);
      expect(stats.successful_tasks).toBe(1);
      expect(stats.failed_tasks).toBe(1);
      expect(stats.total_tokens).toBe(150);
      expect(stats.total_cost).toBeCloseTo(1.0, 5);
      expect(stats.avg_duration_seconds).toBe(20);
      expect(stats.success_rate).toBe(50);
    });

    it('getProviderStats returns zeroed structure for providers with no usage', () => {
      const provider = id('unused-provider');
      const stats = mod.getProviderStats(provider, 30);
      expect(stats.provider).toBe(provider);
      expect(stats.total_tasks).toBe(0);
      expect(stats.successful_tasks).toBe(0);
      expect(stats.failed_tasks).toBe(0);
      expect(stats.success_rate).toBe(0);
      expect(stats.total_tokens).toBe(0);
    });

    it('getProviderStats respects days cutoff', () => {
      const provider = id('cutoff-provider');
      mod.recordProviderUsage(provider, createTask(), { success: true, tokens_used: 10 });
      mod.recordProviderUsage(provider, createTask(), { success: true, tokens_used: 20 });

      rawDb().prepare(
        'UPDATE provider_usage SET recorded_at = ? WHERE provider = ? ORDER BY id ASC LIMIT 1'
      ).run(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), provider);

      const stats = mod.getProviderStats(provider, 30);
      expect(stats.total_tasks).toBe(1);
      expect(stats.total_tokens).toBe(20);
    });

    it('recordProviderUsage handles minimal input payload', () => {
      const provider = id('minimal-provider');
      mod.recordProviderUsage(provider, createTask());
      const stats = mod.getProviderStats(provider, 30);
      expect(stats.total_tasks).toBe(1);
      expect(stats.successful_tasks).toBe(0);
      expect(stats.failed_tasks).toBe(0);
      expect(stats.success_rate).toBe(0);
    });
  });

  describe('rate limiting', () => {
    it('setRateLimit creates and getRateLimit retrieves rate limit', () => {
      const rid = id('rl');
      mod.setRateLimit({
        id: rid,
        project_id: 'proj-rate-a',
        limit_type: 'task_submit',
        max_value: 3,
        window_seconds: 60,
      });
      const row = mod.getRateLimit(rid);
      expect(row).toBeTruthy();
      expect(row.project_id).toBe('proj-rate-a');
      expect(row.limit_type).toBe('task_submit');
      expect(row.max_value).toBe(3);
      expect(row.window_seconds).toBe(60);
    });

    it('setRateLimit updates existing row and keeps current window counter', () => {
      const rid = id('rl-update');
      mod.setRateLimit({
        id: rid,
        project_id: 'proj-rate-b',
        limit_type: 'task_submit',
        max_value: 2,
        window_seconds: 60,
      });
      rawDb().prepare('UPDATE rate_limits SET current_value = 1 WHERE id = ?').run(rid);
      mod.setRateLimit({
        id: rid,
        project_id: 'proj-rate-b',
        limit_type: 'task_submit',
        max_value: 10,
        window_seconds: 120,
      });
      const row = mod.getRateLimit(rid);
      expect(row.max_value).toBe(10);
      expect(row.window_seconds).toBe(120);
      expect(row.current_value).toBe(1);
    });

    it('getProjectRateLimits includes project-specific and global limits', () => {
      mod.setRateLimit({
        id: id('rl-global'),
        project_id: null,
        limit_type: 'global_submit',
        max_value: 99,
        window_seconds: 60,
      });
      mod.setRateLimit({
        id: id('rl-project'),
        project_id: 'proj-rate-c',
        limit_type: 'project_submit',
        max_value: 5,
        window_seconds: 60,
      });
      const rows = mod.getProjectRateLimits('proj-rate-c');
      expect(rows.some(r => r.project_id === null)).toBe(true);
      expect(rows.some(r => r.project_id === 'proj-rate-c')).toBe(true);
    });

    it('checkRateLimit returns allowed when no limit exists', () => {
      const result = mod.checkRateLimit('proj-rate-none', id('unknown-limit-type'));
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('no_limit_configured');
    });

    it('checkRateLimit increments and blocks at max value', () => {
      const rid = id('rl-block');
      mod.setRateLimit({
        id: rid,
        project_id: 'proj-rate-d',
        limit_type: 'submit',
        max_value: 2,
        window_seconds: 3600,
      });
      const one = mod.checkRateLimit('proj-rate-d', 'submit');
      const two = mod.checkRateLimit('proj-rate-d', 'submit');
      const three = mod.checkRateLimit('proj-rate-d', 'submit');
      expect(one.allowed).toBe(true);
      expect(two.allowed).toBe(true);
      expect(three.allowed).toBe(false);
      expect(three.reason).toBe('rate_limit_exceeded');
    });

    it('checkRateLimit resets expired window', () => {
      const rid = id('rl-reset');
      mod.setRateLimit({
        id: rid,
        project_id: 'proj-rate-e',
        limit_type: 'submit',
        max_value: 3,
        window_seconds: 10,
      });
      rawDb().prepare(
        'UPDATE rate_limits SET current_value = 3, window_start = ? WHERE id = ?'
      ).run(new Date(Date.now() - 60000).toISOString(), rid);

      const result = mod.checkRateLimit('proj-rate-e', 'submit');
      const row = mod.getRateLimit(rid);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
      expect(row.current_value).toBe(1);
    });

    it('checkRateLimit prefers project-specific limit over global limit', () => {
      mod.setRateLimit({
        id: id('rl-global-pref'),
        project_id: null,
        limit_type: 'pref-test',
        max_value: 10,
        window_seconds: 3600,
      });
      mod.setRateLimit({
        id: id('rl-project-pref'),
        project_id: 'proj-rate-f',
        limit_type: 'pref-test',
        max_value: 1,
        window_seconds: 3600,
      });

      const first = mod.checkRateLimit('proj-rate-f', 'pref-test');
      const second = mod.checkRateLimit('proj-rate-f', 'pref-test');
      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(false);
      expect(second.reason).toBe('rate_limit_exceeded');
    });

    it('deleteRateLimit returns true for delete and false when already missing', () => {
      const rid = id('rl-delete');
      mod.setRateLimit({
        id: rid,
        project_id: null,
        limit_type: 'delete-me',
        max_value: 1,
        window_seconds: 1,
      });
      expect(mod.deleteRateLimit(rid)).toBe(true);
      expect(mod.deleteRateLimit(rid)).toBe(false);
    });
  });

  describe('task quotas', () => {
    it('setTaskQuota creates and getTaskQuota retrieves quota', () => {
      const qid = id('quota');
      mod.setTaskQuota({
        id: qid,
        project_id: 'proj-quota-a',
        quota_type: 'daily_tasks',
        max_value: 5,
        reset_period: 'daily',
      });
      const row = mod.getTaskQuota(qid);
      expect(row).toBeTruthy();
      expect(row.project_id).toBe('proj-quota-a');
      expect(row.quota_type).toBe('daily_tasks');
      expect(row.max_value).toBe(5);
      expect(row.reset_period).toBe('daily');
    });

    it('setTaskQuota updates existing row and keeps current value', () => {
      const qid = id('quota-update');
      mod.setTaskQuota({
        id: qid,
        project_id: 'proj-quota-b',
        quota_type: 'daily_tasks',
        max_value: 2,
        reset_period: 'daily',
      });
      rawDb().prepare('UPDATE task_quotas SET current_value = 1 WHERE id = ?').run(qid);
      mod.setTaskQuota({
        id: qid,
        project_id: 'proj-quota-b',
        quota_type: 'daily_tasks',
        max_value: 10,
        reset_period: 'weekly',
      });
      const row = mod.getTaskQuota(qid);
      expect(row.max_value).toBe(10);
      expect(row.reset_period).toBe('weekly');
      expect(row.current_value).toBe(1);
    });

    it('checkTaskQuota returns allowed when no quota exists', () => {
      const result = mod.checkTaskQuota('proj-quota-none', id('quota-type-none'));
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('no_quota_configured');
    });

    it('checkTaskQuota increments with created tasks and blocks at max', () => {
      const qid = id('quota-block');
      mod.setTaskQuota({
        id: qid,
        project_id: 'proj-quota-c',
        quota_type: 'task_submit',
        max_value: 2,
        reset_period: null,
      });

      createTask({ project: 'proj-quota-c' });
      const one = mod.checkTaskQuota('proj-quota-c', 'task_submit');
      createTask({ project: 'proj-quota-c' });
      const two = mod.checkTaskQuota('proj-quota-c', 'task_submit');
      createTask({ project: 'proj-quota-c' });
      const three = mod.checkTaskQuota('proj-quota-c', 'task_submit');

      expect(one.allowed).toBe(true);
      expect(two.allowed).toBe(true);
      expect(three.allowed).toBe(false);
      expect(three.reason).toBe('quota_exceeded');
    });

    it('checkTaskQuota resets daily quota when day changes', () => {
      const qid = id('quota-daily');
      mod.setTaskQuota({
        id: qid,
        project_id: 'proj-quota-d',
        quota_type: 'daily_reset',
        max_value: 3,
        reset_period: 'daily',
      });
      rawDb().prepare(
        'UPDATE task_quotas SET current_value = 3, last_reset = ? WHERE id = ?'
      ).run(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), qid);

      const result = mod.checkTaskQuota('proj-quota-d', 'daily_reset');
      const row = mod.getTaskQuota(qid);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
      expect(row.current_value).toBe(1);
    });

    it('checkTaskQuota resets weekly quota when seven days elapse', () => {
      const qid = id('quota-weekly');
      mod.setTaskQuota({
        id: qid,
        project_id: 'proj-quota-e',
        quota_type: 'weekly_reset',
        max_value: 4,
        reset_period: 'weekly',
      });
      rawDb().prepare(
        'UPDATE task_quotas SET current_value = 4, last_reset = ? WHERE id = ?'
      ).run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), qid);

      const result = mod.checkTaskQuota('proj-quota-e', 'weekly_reset');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(3);
    });

    it('checkTaskQuota resets monthly quota when month changes', () => {
      const qid = id('quota-monthly');
      mod.setTaskQuota({
        id: qid,
        project_id: 'proj-quota-f',
        quota_type: 'monthly_reset',
        max_value: 2,
        reset_period: 'monthly',
      });
      rawDb().prepare(
        'UPDATE task_quotas SET current_value = 2, last_reset = ? WHERE id = ?'
      ).run('2021-01-01T00:00:00.000Z', qid);

      const result = mod.checkTaskQuota('proj-quota-f', 'monthly_reset');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });

    it('getProjectQuotas includes project-specific and global quotas', () => {
      mod.setTaskQuota({
        id: id('quota-global'),
        project_id: null,
        quota_type: 'global_q',
        max_value: 100,
      });
      mod.setTaskQuota({
        id: id('quota-project'),
        project_id: 'proj-quota-g',
        quota_type: 'project_q',
        max_value: 5,
      });

      const rows = mod.getProjectQuotas('proj-quota-g');
      expect(rows.some(r => r.project_id === null)).toBe(true);
      expect(rows.some(r => r.project_id === 'proj-quota-g')).toBe(true);
    });

    it('deleteTaskQuota returns true for delete and false when missing', () => {
      const qid = id('quota-delete');
      mod.setTaskQuota({
        id: qid,
        project_id: null,
        quota_type: 'delete_q',
        max_value: 1,
      });
      expect(mod.deleteTaskQuota(qid)).toBe(true);
      expect(mod.deleteTaskQuota(qid)).toBe(false);
    });
  });

  describe('routing rules', () => {
    it('createRoutingRule applies defaults and can be read by id', () => {
      const created = mod.createRoutingRule({
        name: id('rule'),
        pattern: 'foo|bar',
        target_provider: 'codex',
      });
      expect(created).toBeTruthy();
      expect(created.rule_type).toBe('keyword');
      expect(created.priority).toBe(50);
      expect(created.enabled).toBe(true);
      expect(mod.getRoutingRule(created.id).name).toBe(created.name);
    });

    it('getRoutingRule can lookup by rule name', () => {
      const name = id('rule-name');
      mod.createRoutingRule({
        name,
        description: 'name lookup',
        rule_type: 'extension',
        pattern: '.js|.ts',
        target_provider: 'hashline-ollama',
        priority: 44,
        enabled: true,
      });
      const rule = mod.getRoutingRule(name);
      expect(rule).toBeTruthy();
      expect(rule.name).toBe(name);
      expect(rule.rule_type).toBe('extension');
    });

    it('getRoutingRules filters by enabled/type and preserves priority order', () => {
      const base = id('filter-rule');
      mod.createRoutingRule({
        name: `${base}-a`,
        rule_type: 'keyword',
        pattern: 'alpha',
        target_provider: 'codex',
        priority: 5,
        enabled: true,
      });
      mod.createRoutingRule({
        name: `${base}-b`,
        rule_type: 'keyword',
        pattern: 'beta',
        target_provider: 'codex',
        priority: 10,
        enabled: false,
      });
      mod.createRoutingRule({
        name: `${base}-c`,
        rule_type: 'regex',
        pattern: 'g.*',
        target_provider: 'claude-cli',
        priority: 7,
        enabled: true,
      });

      const enabledKeyword = mod.getRoutingRules({ enabled: true, rule_type: 'keyword' });
      expect(enabledKeyword.every(r => r.enabled && r.rule_type === 'keyword')).toBe(true);
      for (let i = 1; i < enabledKeyword.length; i += 1) {
        expect(enabledKeyword[i - 1].priority).toBeLessThanOrEqual(enabledKeyword[i].priority);
      }
    });

    it('updateRoutingRule updates mutable fields and enabled flag', () => {
      const name = id('rule-update');
      const created = mod.createRoutingRule({
        name,
        rule_type: 'keyword',
        pattern: 'before',
        target_provider: 'codex',
      });
      const updated = mod.updateRoutingRule(created.id, {
        description: 'after',
        pattern: 'after',
        target_provider: 'claude-cli',
        enabled: false,
        priority: 1,
      });
      expect(updated.description).toBe('after');
      expect(updated.pattern).toBe('after');
      expect(updated.target_provider).toBe('claude-cli');
      expect(updated.enabled).toBe(false);
      expect(updated.priority).toBe(1);
    });

    it('updateRoutingRule returns existing rule when update payload is empty', () => {
      const created = mod.createRoutingRule({
        name: id('rule-empty-update'),
        rule_type: 'keyword',
        pattern: 'noop',
        target_provider: 'codex',
      });
      const updated = mod.updateRoutingRule(created.id, {});
      expect(updated.id).toBe(created.id);
      expect(updated.pattern).toBe('noop');
    });

    it('updateRoutingRule throws if rule does not exist', () => {
      expect(() => mod.updateRoutingRule(id('missing-rule'), { pattern: 'x' }))
        .toThrow(/not found/i);
    });

    it('deleteRoutingRule removes rule and throws when deleting again', () => {
      const created = mod.createRoutingRule({
        name: id('rule-delete'),
        rule_type: 'keyword',
        pattern: 'delete',
        target_provider: 'codex',
      });
      const result = mod.deleteRoutingRule(created.name);
      expect(result.deleted).toBe(true);
      expect(result.rule.id).toBe(created.id);
      expect(mod.getRoutingRule(created.id)).toBeFalsy();
      expect(() => mod.deleteRoutingRule(created.id)).toThrow(/not found/i);
    });
  });

  describe('stale task cleanup', () => {
    it('cleanupStaleTasks marks stale running and queued tasks', () => {
      const runningId = createTask({ status: 'running', project: 'cleanup' });
      const queuedId = createTask({ status: 'queued', project: 'cleanup' });
      const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      rawDb().prepare('UPDATE tasks SET started_at = ?, created_at = ? WHERE id = ?')
        .run(old, old, runningId);
      rawDb().prepare('UPDATE tasks SET created_at = ? WHERE id = ?')
        .run(old, queuedId);

      const cleaned = mod.cleanupStaleTasks(60, 120);
      expect(cleaned.running_cleaned).toBeGreaterThanOrEqual(1);
      expect(cleaned.queued_cleaned).toBeGreaterThanOrEqual(1);

      expect(taskCore.getTask(runningId).status).toBe('failed');
      expect(taskCore.getTask(queuedId).status).toBe('cancelled');
    });

    it('cleanupStaleTasks handles running tasks with null started_at', () => {
      const runningId = createTask({ status: 'running', project: 'cleanup-null-start' });
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      rawDb().prepare('UPDATE tasks SET started_at = NULL, created_at = ? WHERE id = ?')
        .run(old, runningId);

      const cleaned = mod.cleanupStaleTasks(60, 1440);
      expect(cleaned.running_cleaned).toBeGreaterThanOrEqual(1);
      expect(taskCore.getTask(runningId).status).toBe('failed');
    });

    it('cleanupStaleTasks leaves fresh tasks untouched', () => {
      const runningId = createTask({ status: 'running', project: 'cleanup-fresh' });
      const queuedId = createTask({ status: 'queued', project: 'cleanup-fresh' });
      const cleaned = mod.cleanupStaleTasks(99999, 99999);
      expect(cleaned.total).toBeGreaterThanOrEqual(0);
      expect(taskCore.getTask(runningId).status).toBe('running');
      expect(taskCore.getTask(queuedId).status).toBe('queued');
    });
  });

  describe('template conditions', () => {
    it('createTemplateCondition + getTemplateCondition round-trip', () => {
      const cid = id('cond');
      const created = mod.createTemplateCondition({
        id: cid,
        template_id: 'template-a',
        condition_type: 'if',
        condition_expr: 'x > 1',
        then_block: 'then',
        else_block: 'else',
        order_index: 7,
      });
      expect(created.id).toBe(cid);
      expect(created.template_id).toBe('template-a');
      expect(created.order_index).toBe(7);

      const fetched = mod.getTemplateCondition(cid);
      expect(fetched.condition_expr).toBe('x > 1');
    });

    it('listTemplateConditions orders by order_index and delete works', () => {
      const t = id('template');
      const a = id('cond-a');
      const b = id('cond-b');
      mod.createTemplateCondition({
        id: a,
        template_id: t,
        condition_type: 'if',
        condition_expr: 'a',
        order_index: 2,
      });
      mod.createTemplateCondition({
        id: b,
        template_id: t,
        condition_type: 'if',
        condition_expr: 'b',
        order_index: 1,
      });
      const list = mod.listTemplateConditions(t);
      expect(list[0].id).toBe(b);
      expect(list[1].id).toBe(a);
      expect(mod.deleteTemplateCondition(a)).toBe(true);
      expect(mod.deleteTemplateCondition(a)).toBe(false);
    });
  });

  describe('task replay system', () => {
    it('createTaskReplay + getTaskReplay round-trip with JSON parsing', () => {
      const original = createTask({ project: 'replay' });
      const replayTask = createTask({ project: 'replay' });
      const rid = id('replay');
      const created = mod.createTaskReplay({
        id: rid,
        original_task_id: original,
        replay_task_id: replayTask,
        modified_inputs: { retries: 2, mode: 'strict' },
        diff_summary: 'minor diff',
      });
      expect(created.id).toBe(rid);
      expect(created.modified_inputs).toEqual({ retries: 2, mode: 'strict' });
      expect(mod.getTaskReplay(rid).diff_summary).toBe('minor diff');
    });

    it('listTaskReplays returns latest replay first', () => {
      const original = createTask({ project: 'replay-order' });
      const replayTask1 = createTask({ project: 'replay-order' });
      const replayTask2 = createTask({ project: 'replay-order' });
      const r1 = id('replay-old');
      const r2 = id('replay-new');
      mod.createTaskReplay({ id: r1, original_task_id: original, replay_task_id: replayTask1, modified_inputs: { a: 1 } });
      mod.createTaskReplay({ id: r2, original_task_id: original, replay_task_id: replayTask2, modified_inputs: { b: 2 } });
      rawDb().prepare('UPDATE task_replays SET created_at = ? WHERE id = ?')
        .run('2020-01-01T00:00:00.000Z', r1);
      rawDb().prepare('UPDATE task_replays SET created_at = ? WHERE id = ?')
        .run('2030-01-01T00:00:00.000Z', r2);

      const list = mod.listTaskReplays(original);
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list[0].id).toBe(r2);
      expect(list.find(r => r.id === r1).modified_inputs).toEqual({ a: 1 });
    });

    it('listTaskReplays returns empty array when no replays exist', () => {
      expect(mod.listTaskReplays(id('replay-none'))).toEqual([]);
    });
  });

  describe('integration config', () => {
    it('save/getIntegrationConfig round-trip and parse booleans/json', () => {
      const iid = id('integration');
      mod.saveIntegrationConfig({
        id: iid,
        integration_type: 'slack',
        config: { webhook: 'abc', channel: '#alerts' },
        enabled: true,
      });
      const row = mod.getIntegrationConfig(iid);
      expect(row.integration_type).toBe('slack');
      expect(row.config).toEqual({ webhook: 'abc', channel: '#alerts' });
      expect(row.enabled).toBe(true);
    });

    it('listIntegrationConfigs supports type filter, getEnabledIntegration, and delete', () => {
      const enabledId = id('integration-enabled');
      const disabledId = id('integration-disabled');
      mod.saveIntegrationConfig({
        id: enabledId,
        integration_type: 'email',
        config: { smtp: 'localhost' },
        enabled: true,
      });
      mod.saveIntegrationConfig({
        id: disabledId,
        integration_type: 'email',
        config: { smtp: 'localhost' },
        enabled: false,
      });

      const all = mod.listIntegrationConfigs();
      const emailOnly = mod.listIntegrationConfigs('email');
      expect(all.length).toBeGreaterThanOrEqual(emailOnly.length);
      expect(emailOnly.every(r => r.integration_type === 'email')).toBe(true);
      expect(mod.getEnabledIntegration('email').id).toBe(enabledId);
      expect(mod.deleteIntegrationConfig(enabledId)).toBe(true);
      expect(mod.deleteIntegrationConfig(enabledId)).toBe(false);
    });
  });

  describe('workflow forks', () => {
    it('createWorkflowFork + getWorkflowFork round-trip with defaults', () => {
      const fid = id('fork');
      const workflowId = createWorkflow();
      mod.createWorkflowFork({
        id: fid,
        workflow_id: workflowId,
        branches: [{ name: 'A' }, { name: 'B' }],
      });
      const row = mod.getWorkflowFork(fid);
      expect(row.id).toBe(fid);
      expect(row.branch_count).toBe(2);
      expect(row.merge_strategy).toBe('all');
      expect(row.status).toBe('pending');
      expect(Array.isArray(row.branches)).toBe(true);
    });

    it('listWorkflowForks returns rows ordered by created_at ASC', () => {
      const workflowId = createWorkflow({ id: id('workflow-order') });
      const f1 = id('fork-old');
      const f2 = id('fork-new');
      mod.createWorkflowFork({ id: f1, workflow_id: workflowId, branches: [{ name: 'X' }] });
      mod.createWorkflowFork({ id: f2, workflow_id: workflowId, branches: [{ name: 'Y' }] });
      rawDb().prepare('UPDATE workflow_forks SET created_at = ? WHERE id = ?')
        .run('2021-01-01T00:00:00.000Z', f1);
      rawDb().prepare('UPDATE workflow_forks SET created_at = ? WHERE id = ?')
        .run('2021-01-02T00:00:00.000Z', f2);
      const list = mod.listWorkflowForks(workflowId);
      expect(list[0].id).toBe(f1);
      expect(list[1].id).toBe(f2);
    });

    it('updateWorkflowForkStatus updates existing fork and returns null for missing', () => {
      const fid = id('fork-status');
      const workflowId = createWorkflow({ id: id('workflow-status') });
      mod.createWorkflowFork({
        id: fid,
        workflow_id: workflowId,
        branches: [{ name: 'A' }],
      });
      const updated = mod.updateWorkflowForkStatus(fid, 'running');
      expect(updated.status).toBe('running');
      expect(mod.updateWorkflowForkStatus(id('missing-fork'), 'done')).toBeNull();
    });
  });

  describe('metrics and infrastructure', () => {
    it('getPrometheusMetrics exports task/workflow/agent/token metrics', () => {
      const t1 = createTask({ status: 'completed', project: 'metrics' });
      const t2 = createTask({ status: 'running', project: 'metrics' });
      rawDb().prepare('UPDATE tasks SET started_at = ?, completed_at = ? WHERE id = ?')
        .run('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:30.000Z', t1);
      rawDb().prepare(
        'INSERT INTO agents (id, name, status, registered_at) VALUES (?, ?, ?, ?)'
      ).run(id('agent'), 'agent-1', 'online', new Date().toISOString());
      rawDb().prepare(
        'INSERT INTO workflows (id, name, status, created_at) VALUES (?, ?, ?, ?)'
      ).run(id('workflow-metrics'), 'wf-metrics', 'pending', new Date().toISOString());
      rawDb().prepare(
        'INSERT INTO token_usage (task_id, total_tokens, estimated_cost_usd, recorded_at) VALUES (?, ?, ?, ?)'
      ).run(t2, 321, 1.23, new Date().toISOString());

      const metrics = mod.getPrometheusMetrics();
      expect(metrics).toContain('codexbridge_tasks_total{status="completed"}');
      expect(metrics).toContain('codexbridge_tasks_total{status="running"}');
      expect(metrics).toContain('codexbridge_active_agents 1');
      expect(metrics).toContain('codexbridge_workflows_total{status="pending"}');
      expect(metrics).toContain('codexbridge_tokens_daily_total');
      expect(metrics).toContain('codexbridge_cost_daily_usd');
      expect(metrics).toContain('codexbridge_task_duration_seconds_bucket');

      const provider = id('provider-metrics');
      const taskId = id('metrics-task');
      rawDb().prepare(
        'INSERT INTO provider_usage (provider, task_id, tokens_used, cost_estimate, duration_seconds, elapsed_ms, transport, retry_count, failure_reason, success, error_type, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        provider,
        taskId,
        88,
        1.2,
        12,
        2500,
        'api',
        1,
        'provider_unavailable',
        0,
        'provider_unavailable',
        new Date().toISOString(),
      );

      rawDb().prepare(
        'INSERT INTO provider_usage (provider, task_id, tokens_used, cost_estimate, duration_seconds, elapsed_ms, transport, retry_count, success, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        provider,
        id('metrics-task-2'),
        45,
        0.4,
        7,
        1200,
        'cli',
        0,
        1,
        new Date().toISOString(),
      );

      const refreshedMetrics = mod.getPrometheusMetrics();
      expect(refreshedMetrics).toContain(`codexbridge_provider_transport_calls_total{provider="${provider}",transport="api",outcome="failure"} 1`);
      expect(refreshedMetrics).toContain(`codexbridge_provider_transport_calls_total{provider="${provider}",transport="cli",outcome="success"} 1`);
      expect(refreshedMetrics).toContain(`codexbridge_provider_transport_elapsed_ms_sum{provider="${provider}",transport="api"} 2500`);
      expect(refreshedMetrics).toContain(`codexbridge_provider_transport_elapsed_ms_avg{provider="${provider}",transport="api"} 2500.00`);
      expect(refreshedMetrics).toContain(`codexbridge_provider_transport_elapsed_ms_sum{provider="${provider}",transport="cli"} 1200`);
      expect(refreshedMetrics).toContain(`codexbridge_provider_transport_elapsed_ms_avg{provider="${provider}",transport="cli"} 1200.00`);
      expect(refreshedMetrics).toContain(`codexbridge_provider_transport_retry_count_sum{provider="${provider}",transport="api"} 1`);
      expect(refreshedMetrics).toContain(`codexbridge_provider_transport_retry_count_avg{provider="${provider}",transport="api"} 1.00`);
      expect(refreshedMetrics).toContain(`codexbridge_provider_transport_retry_count_sum{provider="${provider}",transport="cli"} 0`);
      expect(refreshedMetrics).toContain(`codexbridge_provider_transport_retry_count_avg{provider="${provider}",transport="cli"} 0.00`);
      expect(refreshedMetrics).toContain(`codexbridge_provider_transport_failure_reason_total{provider="${provider}",transport="api",failure_reason="provider_unavailable"} 1`);
    });

    it('checkOllamaHealth returns true against healthy mock endpoint', async () => {
      const mock = await startMockOllama(200);
      try {
        configCore.setConfig('ollama_host', mock.host);
        const healthy = await mod.checkOllamaHealth(true);
        expect(healthy).toBe(true);
      } finally {
        await mock.close();
      }
    });

    it('checkOllamaHealth uses cache when not forced and refreshes when forced', async () => {
      const mock = await startMockOllama(200);
      configCore.setConfig('ollama_host', mock.host);
      const first = await mod.checkOllamaHealth(true);
      await mock.close();

      const cached = await mod.checkOllamaHealth(false);
      expect(first).toBe(true);
      expect(cached).toBe(true);

      configCore.setConfig('ollama_host', 'http://127.0.0.1:9');
      const refreshed = await mod.checkOllamaHealth(true);
      expect(refreshed).toBe(false);
    });

    it('isOllamaHealthy supports cache state and healthy-host fallback', () => {
      mod.setOllamaHealthy(true);
      expect(mod.isOllamaHealthy()).toBe(true);
      mod.invalidateOllamaHealth();
      expect(mod.isOllamaHealthy()).toBe(false);

      const fresh = loadFreshProviderRouting();
      expect(fresh.isOllamaHealthy()).toBeNull();
      fresh.setHostManagement({
        listOllamaHosts: () => [{ enabled: true, status: 'healthy' }],
      });
      expect(fresh.isOllamaHealthy()).toBe(true);
    });

    it('detectWSL2HostIP returns null or an IPv4 address', () => {
      const value = mod.detectWSL2HostIP();
      if (value === null) {
        expect(value).toBeNull();
      } else {
        expect(value).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      }
    });

    it('findOllamaBinary prefers configured path and ignores tiny placeholder paths', () => {
      const validPath = path.join(testDir, `${id('ollama-valid')}.bin`);
      const tinyPath = path.join(testDir, `${id('ollama-tiny')}.bin`);
      fs.writeFileSync(validPath, Buffer.alloc(2048, 1));
      fs.writeFileSync(tinyPath, Buffer.alloc(10, 2));

      configCore.setConfig('ollama_binary_path', validPath);
      expect(mod.findOllamaBinary()).toBe(validPath);

      configCore.setConfig('ollama_binary_path', tinyPath);
      const found = mod.findOllamaBinary();
      expect(found).not.toBe(tinyPath);
    });
  });

  describe('Codex Exhaustion Helpers', () => {
    it('isCodexExhausted returns false when flag is not set', () => {
      expect(mod.isCodexExhausted()).toBe(false);
    });

    it('isCodexExhausted returns true when flag is "1"', () => {
      configCore.setConfig('codex_exhausted', '1');
      expect(mod.isCodexExhausted()).toBe(true);
    });

    it('setCodexExhausted(true) sets flag and timestamp', () => {
      const before = new Date().toISOString();
      mod.setCodexExhausted(true);
      expect(mod.isCodexExhausted()).toBe(true);
      const ts = configCore.getConfig('codex_exhausted_at');
      expect(ts).toBeTruthy();
      expect(ts >= before).toBe(true);
    });

    it('setCodexExhausted(false) clears the flag', () => {
      mod.setCodexExhausted(true);
      // Clear config cache so isCodexExhausted reads the freshly written value
      require('../db/config-core').clearConfigCache();
      expect(mod.isCodexExhausted()).toBe(true);
      mod.setCodexExhausted(false);
      // Clear config cache again after clearing the flag
      require('../db/config-core').clearConfigCache();
      expect(mod.isCodexExhausted()).toBe(false);
    });
  });

  describe('hasHealthyOllamaHost', () => {
    function insertHost(overrides = {}) {
      const hostId = overrides.id || id('host');
      const now = new Date().toISOString();
      rawDb().prepare(`
        INSERT INTO ollama_hosts (id, name, url, enabled, status, running_tasks, max_concurrent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        hostId,
        overrides.name || `Host-${hostId}`,
        overrides.url || `http://127.0.0.1:${11434 + seq}`,
        overrides.enabled !== undefined ? (overrides.enabled ? 1 : 0) : 1,
        overrides.status || 'healthy',
        overrides.running_tasks || 0,
        overrides.max_concurrent || 2,
        now
      );
      return hostId;
    }

    function clearHosts() {
      rawDb().prepare('DELETE FROM ollama_hosts').run();
    }

    beforeEach(() => {
      clearHosts();
      // Wire host management so hasHealthyOllamaHost can use listOllamaHosts
      const hostMgmt = require('../db/host-management');
      hostMgmt.setDb(rawDb());
      mod.setHostManagement(hostMgmt);
    });

    it('returns false when no hosts exist', () => {
      expect(mod.hasHealthyOllamaHost()).toBe(false);
    });

    it('returns true when a healthy enabled host has capacity', () => {
      insertHost({ enabled: true, status: 'healthy', running_tasks: 0, max_concurrent: 2 });
      expect(mod.hasHealthyOllamaHost()).toBe(true);
    });

    it('returns false when all hosts are disabled', () => {
      insertHost({ enabled: false, status: 'healthy', running_tasks: 0, max_concurrent: 2 });
      expect(mod.hasHealthyOllamaHost()).toBe(false);
    });

    it('returns false when all hosts are down', () => {
      insertHost({ enabled: true, status: 'down', running_tasks: 0, max_concurrent: 2 });
      expect(mod.hasHealthyOllamaHost()).toBe(false);
    });

    it('returns false when all hosts are degraded', () => {
      insertHost({ enabled: true, status: 'degraded', running_tasks: 0, max_concurrent: 2 });
      expect(mod.hasHealthyOllamaHost()).toBe(false);
    });

    it('returns false when all healthy hosts are at max capacity', () => {
      insertHost({ enabled: true, status: 'healthy', running_tasks: 2, max_concurrent: 2 });
      expect(mod.hasHealthyOllamaHost()).toBe(false);
    });

    it('returns true when at least one host among many has capacity', () => {
      insertHost({ enabled: true, status: 'healthy', running_tasks: 2, max_concurrent: 2 }); // full
      insertHost({ enabled: true, status: 'down', running_tasks: 0, max_concurrent: 2 });     // down
      insertHost({ enabled: true, status: 'healthy', running_tasks: 1, max_concurrent: 3 });   // has capacity
      expect(mod.hasHealthyOllamaHost()).toBe(true);
    });

    it('returns false when hostManagementFns is not wired', () => {
      const fresh = loadFreshProviderRouting();
      // fresh instance has no hostManagementFns set
      expect(fresh.hasHealthyOllamaHost()).toBe(false);
    });

    it('treats null running_tasks as unknown (no capacity assumed)', () => {
      // Insert host with NULL running_tasks via raw SQL
      // SQL NULL comparison: NULL < 2 evaluates to NULL (falsy), so host is not matched
      const hostId = id('host');
      rawDb().prepare(`
        INSERT INTO ollama_hosts (id, name, url, enabled, status, running_tasks, max_concurrent, created_at)
        VALUES (?, ?, ?, 1, 'healthy', NULL, 2, ?)
      `).run(hostId, 'NullTasks', 'http://127.0.0.1:19999', new Date().toISOString());
      expect(mod.hasHealthyOllamaHost()).toBe(false);
    });

    it('treats null max_concurrent as 1', () => {
      const hostId = id('host');
      rawDb().prepare(`
        INSERT INTO ollama_hosts (id, name, url, enabled, status, running_tasks, max_concurrent, created_at)
        VALUES (?, ?, ?, 1, 'healthy', 1, NULL, ?)
      `).run(hostId, 'NullMax', 'http://127.0.0.1:19998', new Date().toISOString());
      // running_tasks=1 >= max_concurrent=1 (default), so no capacity
      expect(mod.hasHealthyOllamaHost()).toBe(false);
    });
  });
});
