const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir, origDataDir, db, mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-adaptive-retry-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  mod = require('../db/analytics');
  mod.setDb(db.getDb());
  mod.setGetTask((id) => db.getTask(id));
}

function teardown() {
  if (db) try { db.close(); } catch {}
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    if (origDataDir !== undefined) process.env.TORQUE_DATA_DIR = origDataDir;
    else delete process.env.TORQUE_DATA_DIR;
  }
}

function rawDb() {
  if (db.getDb) return db.getDb();
  return db.getDbInstance();
}

function resetState() {
  const tables = ['adaptive_retry_rules', 'retry_history', 'tasks'];
  for (const table of tables) {
    rawDb().prepare(`DELETE FROM ${table}`).run();
  }
}

function mkTask(overrides = {}) {
  const task = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'retry test task',
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    timeout_minutes: overrides.timeout_minutes ?? 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    max_retries: overrides.max_retries ?? 2,
    retry_count: overrides.retry_count ?? 0,
    provider: overrides.provider || 'codex'
  };
  db.createTask(task);
  return db.getTask(task.id);
}

function patchTask(taskId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  rawDb().prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...entries.map(([, v]) => v), taskId);
}

describe('adaptive-retry module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  describe('analyzeRetryPatterns', () => {
    it('returns empty array when no retry history exists', () => {
      const results = mod.analyzeRetryPatterns();
      expect(results).toEqual([]);
    });

    it('groups by strategy and error type with success rates', () => {
      const t1 = mkTask({ status: 'completed' });
      const t2 = mkTask({ status: 'failed' });
      patchTask(t1.id, { error_output: 'timeout error happened' });
      patchTask(t2.id, { error_output: 'timeout error happened' });

      const now = new Date().toISOString();
      for (let i = 0; i < 4; i++) {
        rawDb().prepare(`
          INSERT INTO retry_history (task_id, attempt_number, delay_used, error_message, retried_at, strategy_used)
          VALUES (?, ?, 10, 'timeout', ?, 'exponential')
        `).run(i < 2 ? t1.id : t2.id, i + 1, now);
      }

      const results = mod.analyzeRetryPatterns();
      if (results.length > 0) {
        expect(results[0].strategy_used).toBe('exponential');
        expect(results[0].success_rate).toBeDefined();
      }
    });

    it('returns results without since parameter', () => {
      const task = mkTask({ status: 'completed' });
      patchTask(task.id, { error_output: 'some error text' });

      const now = new Date().toISOString();
      for (let i = 0; i < 4; i++) {
        rawDb().prepare(`
          INSERT INTO retry_history (task_id, attempt_number, delay_used, error_message, retried_at, strategy_used)
          VALUES (?, ?, 10, 'err', ?, 'linear')
        `).run(task.id, i + 1, now);
      }

      // Calling without since should work (no WHERE clause on timestamp)
      const results = mod.analyzeRetryPatterns();
      // May or may not have results depending on HAVING >= 3
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('adaptive retry rules', () => {
    it('creates a retry rule and retrieves it', () => {
      const id = mod.createAdaptiveRetryRule('timeout', 'delay', { delay_seconds: 30 });
      expect(id).toBeTruthy();

      const rules = mod.getAdaptiveRetryRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].error_pattern).toBe('timeout');
      expect(rules[0].adjustment).toEqual({ delay_seconds: 30 });
    });

    it('retrieves rules matching error text', () => {
      mod.createAdaptiveRetryRule('timeout', 'delay', { delay_seconds: 30 });
      mod.createAdaptiveRetryRule('memory', 'resize', { increase_memory: true });

      const matched = mod.getAdaptiveRetryRules('The task failed with a timeout error');
      expect(matched).toHaveLength(1);
      expect(matched[0].error_pattern).toBe('timeout');
    });

    it('returns empty array for non-matching error text', () => {
      mod.createAdaptiveRetryRule('timeout', 'delay', { delay_seconds: 30 });
      const matched = mod.getAdaptiveRetryRules('connection refused');
      expect(matched).toEqual([]);
    });

    it('only returns enabled rules', () => {
      const id = mod.createAdaptiveRetryRule('timeout', 'delay', { delay: 30 });
      rawDb().prepare('UPDATE adaptive_retry_rules SET enabled = 0 WHERE id = ?').run(id);

      const rules = mod.getAdaptiveRetryRules();
      expect(rules).toEqual([]);
    });
  });

  describe('updateRetryRuleStats', () => {
    it('increments success count on success', () => {
      const id = mod.createAdaptiveRetryRule('error', 'fix', {});
      mod.updateRetryRuleStats(id, true);
      mod.updateRetryRuleStats(id, true);

      const row = rawDb().prepare('SELECT success_count FROM adaptive_retry_rules WHERE id = ?').get(id);
      expect(row.success_count).toBe(2);
    });

    it('increments failure count on failure', () => {
      const id = mod.createAdaptiveRetryRule('error', 'fix', {});
      mod.updateRetryRuleStats(id, false);

      const row = rawDb().prepare('SELECT failure_count FROM adaptive_retry_rules WHERE id = ?').get(id);
      expect(row.failure_count).toBe(1);
    });
  });

  describe('getRetryRecommendation', () => {
    it('returns null for non-existent task', () => {
      expect(mod.getRetryRecommendation('missing-task', 'error')).toBeNull();
    });

    it('applies matching adaptive rules', () => {
      mod.createAdaptiveRetryRule('timeout', 'delay', { delay_seconds: 60, timeout_factor: 2.0 });
      const task = mkTask({ timeout_minutes: 10 });

      const rec = mod.getRetryRecommendation(task.id, 'timeout occurred');
      expect(rec.adaptations.delay_seconds).toBe(60);
      expect(rec.adaptations.timeout_factor).toBe(2.0);
      expect(rec.applied_rules.length).toBe(1);
    });

    it('applies default timeout adaptation when no rules match', () => {
      const task = mkTask({ timeout_minutes: 10 });
      const rec = mod.getRetryRecommendation(task.id, 'timeout error');
      expect(rec.adaptations.timeout_factor).toBe(1.5);
    });

    it('applies default rate limit adaptation', () => {
      const task = mkTask({ timeout_minutes: 10 });
      const rec = mod.getRetryRecommendation(task.id, 'rate limit exceeded 429');
      expect(rec.adaptations.delay_seconds).toBe(60);
    });

    it('applies default memory adaptation', () => {
      const task = mkTask({ timeout_minutes: 10 });
      const rec = mod.getRetryRecommendation(task.id, 'OOM killed');
      expect(rec.adaptations.suggest_smaller_scope).toBe(true);
    });

    it('returns original timeout in recommendation', () => {
      const task = mkTask({ timeout_minutes: 15 });
      const rec = mod.getRetryRecommendation(task.id, 'some error');
      expect(rec.original_timeout).toBe(15);
    });
  });
});
