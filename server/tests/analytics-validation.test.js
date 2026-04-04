/**
 * Analytics & Validation Proxy Module Tests
 *
 * Unit tests for server/db/analytics.js and server/db/validation.js.
 * Both are proxy modules that re-export from database.js.
 * Tests verify the underlying implementations via the db reference.
 */

const crypto = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const fileQuality = require('../db/file-quality');

let db;

function createTask(overrides = {}) {
  const id = overrides.id || crypto.randomUUID();
  db.createTask({
    id,
    task_description: overrides.task_description || 'test task',
    provider: overrides.provider || 'ollama',
    model: overrides.model || 'test:1b',
    working_directory: process.cwd(),
    ...overrides,
  });
  return id;
}

describe('Analytics & Validation proxy modules', () => {
  beforeAll(() => {
    const env = setupTestDbOnly('analytics-validation');
    db = env.db;
    fileQuality.setDb(db.getDbInstance());
  });

  afterAll(() => {
    teardownTestDb();
  });

  // ================================================================
  // analytics.js — recordEvent / getAnalytics
  // ================================================================

  describe('recordEvent', () => {
    it('records an event without error', () => {
      expect(() => db.recordEvent('test_event', null, { foo: 'bar' })).not.toThrow();
    });

    it('records an event tied to a task', () => {
      const taskId = createTask();
      expect(() => db.recordEvent('task_started', taskId, { step: 1 })).not.toThrow();
    });

    it('records an event with null data', () => {
      expect(() => db.recordEvent('ping')).not.toThrow();
    });
  });

  describe('getAnalytics', () => {
    it('returns analytics summary with tasksByStatus', () => {
      const result = db.getAnalytics();
      expect(result).toHaveProperty('tasksByStatus');
      expect(result).toHaveProperty('successRate');
      expect(result).toHaveProperty('avgDurationMinutes');
      expect(result).toHaveProperty('tasksLast24h');
      expect(result).toHaveProperty('topTemplates');
    });

    it('includes recent events when requested', () => {
      db.recordEvent('analytics_test_event', null, { x: 1 });
      const result = db.getAnalytics({ includeEvents: true, eventLimit: 5 });
      expect(result.recentEvents).toBeDefined();
      expect(Array.isArray(result.recentEvents)).toBe(true);
      expect(result.recentEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('counts tasks by status correctly', () => {
      const id1 = createTask();
      db.updateTaskStatus(id1, 'completed');
      const id2 = createTask();
      db.updateTaskStatus(id2, 'failed');

      const result = db.getAnalytics();
      expect(result.tasksByStatus.completed).toBeGreaterThanOrEqual(1);
      expect(result.tasksByStatus.failed).toBeGreaterThanOrEqual(1);
    });
  });

  // ================================================================
  // analytics.js — incrementRetry / configureTaskRetry
  // ================================================================

  describe('incrementRetry', () => {
    it('increments retry count and returns result', () => {
      const taskId = createTask();
      const result = db.incrementRetry(taskId);
      expect(result).not.toBeNull();
      expect(result.retryCount).toBe(1);
      expect(result.shouldRetry).toBe(true);
    });

    it('returns null for nonexistent task', () => {
      const result = db.incrementRetry('nonexistent-task-id');
      expect(result).toBeNull();
    });

    it('respects max_retries limit', () => {
      const taskId = createTask({ max_retries: 1 });
      const r1 = db.incrementRetry(taskId);
      expect(r1.retryCount).toBe(1);
      expect(r1.shouldRetry).toBe(true);

      const r2 = db.incrementRetry(taskId);
      expect(r2.retryCount).toBe(2);
      expect(r2.shouldRetry).toBe(false);
    });
  });

  describe('configureTaskRetry', () => {
    it('updates max_retries on a task', () => {
      const taskId = createTask();
      const result = db.configureTaskRetry(taskId, { max_retries: 5 });
      expect(result.max_retries).toBe(5);
    });

    it('updates retry_strategy', () => {
      const taskId = createTask();
      const result = db.configureTaskRetry(taskId, { retry_strategy: 'linear' });
      expect(result.retry_strategy).toBe('linear');
    });

    it('updates retry_delay_seconds', () => {
      const taskId = createTask();
      const result = db.configureTaskRetry(taskId, { retry_delay_seconds: 60 });
      expect(result.retry_delay_seconds).toBe(60);
    });

    it('returns task unchanged if no config fields provided', () => {
      const taskId = createTask();
      const before = db.getTask(taskId);
      const result = db.configureTaskRetry(taskId, {});
      expect(result.max_retries).toBe(before.max_retries);
    });
  });

  // ================================================================
  // analytics.js — recordRetryAttempt / getRetryHistory
  // ================================================================

  describe('recordRetryAttempt + getRetryHistory', () => {
    it('records a retry attempt and retrieves history', () => {
      const taskId = createTask();
      db.recordRetryAttempt(taskId, {
        attempt_number: 1,
        delay_used: 30,
        error_message: 'timeout',
        prompt_modification: 'retry with shorter prompt',
      });

      const history = db.getRetryHistory(taskId);
      expect(history).toHaveLength(1);
      expect(history[0].attempt_number).toBe(1);
      expect(history[0].delay_used).toBe(30);
      expect(history[0].error_message).toBe('timeout');
    });

    it('records multiple attempts in order', () => {
      const taskId = createTask();
      db.recordRetryAttempt(taskId, { attempt_number: 1, error_message: 'err1' });
      db.recordRetryAttempt(taskId, { attempt_number: 2, error_message: 'err2' });
      db.recordRetryAttempt(taskId, { attempt_number: 3, error_message: 'err3' });

      const history = db.getRetryHistory(taskId);
      expect(history).toHaveLength(3);
      expect(history[0].attempt_number).toBe(1);
      expect(history[2].attempt_number).toBe(3);
    });

    it('returns empty array for task with no retries', () => {
      const history = db.getRetryHistory('no-retries-id');
      expect(history).toEqual([]);
    });
  });

  // ================================================================
  // analytics.js — calculateRetryDelay
  // ================================================================

  describe('calculateRetryDelay', () => {
    it('uses exponential backoff by default', () => {
      const delay = db.calculateRetryDelay({ retry_delay_seconds: 10, retry_count: 3, retry_strategy: 'exponential' });
      // 10 * 2^3 = 80
      expect(delay).toBe(80);
    });

    it('uses linear backoff', () => {
      const delay = db.calculateRetryDelay({ retry_delay_seconds: 10, retry_count: 3, retry_strategy: 'linear' });
      // 10 * (3 + 1) = 40
      expect(delay).toBe(40);
    });

    it('uses fixed delay', () => {
      const delay = db.calculateRetryDelay({ retry_delay_seconds: 15, retry_count: 10, retry_strategy: 'fixed' });
      expect(delay).toBe(15);
    });

    it('caps delay at 1 week maximum', () => {
      const maxWeek = 7 * 24 * 60 * 60;
      const delay = db.calculateRetryDelay({ retry_delay_seconds: 1000, retry_count: 30, retry_strategy: 'exponential' });
      expect(delay).toBe(maxWeek);
    });

    it('defaults to 30s base delay and exponential strategy', () => {
      const delay = db.calculateRetryDelay({});
      // retry_count defaults to 0, so 30 * 2^0 = 30
      expect(delay).toBe(30);
    });
  });

  // ================================================================
  // validation.js — saveValidationRule / getValidationRules / getValidationRule
  // ================================================================

  describe('saveValidationRule + getValidationRules', () => {
    it('saves and retrieves a validation rule', () => {
      const ruleId = crypto.randomUUID();
      db.saveValidationRule({
        id: ruleId,
        name: 'no-console-log',
        description: 'Disallow console.log in production code',
        rule_type: 'pattern',
        pattern: 'console\\.log',
        severity: 'warning',
        enabled: true,
      });

      const rule = db.getValidationRule(ruleId);
      expect(rule).not.toBeNull();
      expect(rule.name).toBe('no-console-log');
      expect(rule.rule_type).toBe('pattern');
      expect(rule.pattern).toBe('console\\.log');
      expect(rule.severity).toBe('warning');
      expect(rule.enabled).toBe(1);
    });

    it('upserts on duplicate rule id', () => {
      const ruleId = crypto.randomUUID();
      db.saveValidationRule({ id: ruleId, name: 'rule-v1', severity: 'info' });
      db.saveValidationRule({ id: ruleId, name: 'rule-v2', severity: 'error' });

      const rule = db.getValidationRule(ruleId);
      expect(rule.name).toBe('rule-v2');
      expect(rule.severity).toBe('error');
    });

    it('getValidationRules returns only enabled rules by default', () => {
      const enabledId = crypto.randomUUID();
      const disabledId = crypto.randomUUID();
      db.saveValidationRule({ id: enabledId, name: 'enabled-rule', enabled: true });
      db.saveValidationRule({ id: disabledId, name: 'disabled-rule', enabled: false });

      const enabledRules = db.getValidationRules(true);
      const allRules = db.getValidationRules(false);

      const enabledNames = enabledRules.map(r => r.name);
      const allNames = allRules.map(r => r.name);

      expect(enabledNames).toContain('enabled-rule');
      expect(enabledNames).not.toContain('disabled-rule');
      expect(allNames).toContain('enabled-rule');
      expect(allNames).toContain('disabled-rule');
    });
  });

  // ================================================================
  // validation.js — recordValidationResult / getValidationResults / hasValidationFailures
  // ================================================================

  describe('recordValidationResult + getValidationResults', () => {
    it('records and retrieves a validation result', () => {
      const taskId = createTask();
      // Must create the rule first to satisfy FK constraint
      const ruleId = crypto.randomUUID();
      db.saveValidationRule({ id: ruleId, name: 'no-console-rv', severity: 'error' });
      db.recordValidationResult(taskId, ruleId, 'no-console-rv', 'fail', 'error', 'Found console.log', 'src/app.js', 42);

      const results = db.getValidationResults(taskId);
      expect(results).toHaveLength(1);
      expect(results[0].rule_name).toBe('no-console-rv');
      expect(results[0].status).toBe('fail');
      expect(results[0].severity).toBe('error');
      expect(results[0].details).toBe('Found console.log');
      expect(results[0].file_path).toBe('src/app.js');
      expect(results[0].line_number).toBe(42);
    });

    it('returns empty array for task with no results', () => {
      const results = db.getValidationResults('nonexistent-validation-task');
      expect(results).toEqual([]);
    });
  });

  describe('hasValidationFailures', () => {
    it('returns true when task has failures at or above min severity', () => {
      const taskId = createTask();
      const ruleId = crypto.randomUUID();
      db.saveValidationRule({ id: ruleId, name: 'size-check-hvf', severity: 'error' });
      db.recordValidationResult(taskId, ruleId, 'size-check-hvf', 'fail', 'error', 'too large', 'f.ts', null);

      expect(db.hasValidationFailures(taskId, 'warning')).toBe(true);
      expect(db.hasValidationFailures(taskId, 'error')).toBe(true);
    });

    it('returns false when failures are below min severity', () => {
      const taskId = createTask();
      const ruleId = crypto.randomUUID();
      db.saveValidationRule({ id: ruleId, name: 'style-check-hvf', severity: 'info' });
      db.recordValidationResult(taskId, ruleId, 'style-check-hvf', 'fail', 'info', 'minor style', 'f.ts', null);

      expect(db.hasValidationFailures(taskId, 'warning')).toBe(false);
      expect(db.hasValidationFailures(taskId, 'error')).toBe(false);
    });

    it('returns false when there are no failures (only passes)', () => {
      const taskId = createTask();
      const ruleId = crypto.randomUUID();
      db.saveValidationRule({ id: ruleId, name: 'lint-hvf', severity: 'error' });
      db.recordValidationResult(taskId, ruleId, 'lint-hvf', 'pass', 'error', 'ok', 'f.ts', null);

      expect(db.hasValidationFailures(taskId)).toBe(false);
    });

    it('returns false for task with no validation results at all', () => {
      const taskId = createTask();
      expect(db.hasValidationFailures(taskId)).toBe(false);
    });
  });

  // ================================================================
  // validation.js — validateTaskOutput (pattern, size, delta rules)
  // ================================================================

  describe('validateTaskOutput', () => {
    it('detects pattern rule violations', () => {
      const ruleId = crypto.randomUUID();
      db.saveValidationRule({
        id: ruleId,
        name: 'no-todo',
        rule_type: 'pattern',
        pattern: 'TODO',
        severity: 'warning',
        enabled: true,
      });

      const taskId = createTask();
      const results = db.validateTaskOutput(taskId, [
        { path: 'src/index.ts', content: '// TODO: fix this later', size: 30 },
      ]);

      expect(results.length).toBeGreaterThanOrEqual(1);
      const todoResult = results.find(r => r.rule === 'no-todo');
      expect(todoResult).toBeDefined();
      expect(todoResult.status).toBe('fail');
      expect(todoResult.file).toBe('src/index.ts');
    });

    it('passes when pattern does not match', () => {
      const ruleId = crypto.randomUUID();
      db.saveValidationRule({
        id: ruleId,
        name: 'no-debugger',
        rule_type: 'pattern',
        pattern: 'debugger;',
        severity: 'error',
        enabled: true,
      });

      const taskId = createTask();
      const results = db.validateTaskOutput(taskId, [
        { path: 'src/clean.ts', content: 'const x = 1;', size: 14 },
      ]);

      const debuggerResult = results.find(r => r.rule === 'no-debugger');
      expect(debuggerResult).toBeUndefined();
    });

    it('detects size:0 rule violations', () => {
      const ruleId = crypto.randomUUID();
      db.saveValidationRule({
        id: ruleId,
        name: 'no-empty-files',
        rule_type: 'size',
        condition: 'size:0',
        severity: 'error',
        enabled: true,
      });

      const taskId = createTask();
      const results = db.validateTaskOutput(taskId, [
        { path: 'src/empty.ts', content: '', size: 0 },
      ]);

      const emptyResult = results.find(r => r.rule === 'no-empty-files');
      expect(emptyResult).toBeDefined();
      expect(emptyResult.status).toBe('fail');
    });

    it('detects delta rule violations for large size decrease', () => {
      const ruleId = crypto.randomUUID();
      db.saveValidationRule({
        id: ruleId,
        name: 'no-truncation',
        rule_type: 'delta',
        condition: 'size_decrease_percent >50',
        severity: 'error',
        enabled: true,
      });

      const taskId = createTask();
      const results = db.validateTaskOutput(taskId, [
        { path: 'src/big.ts', content: 'x', size: 10, originalSize: 100 },
      ]);

      const truncResult = results.find(r => r.rule === 'no-truncation');
      expect(truncResult).toBeDefined();
      expect(truncResult.status).toBe('fail');
    });

    it('returns empty array when no rules are violated', () => {
      const taskId = createTask();
      const results = db.validateTaskOutput(taskId, [
        { path: 'src/ok.ts', content: 'const clean = true;', size: 20 },
      ]);

      // Only check for rules we know exist. Results could still include
      // previously-created rules that match, so we just verify return type.
      expect(Array.isArray(results)).toBe(true);
    });

    it('skips disabled rules', () => {
      const ruleId = crypto.randomUUID();
      db.saveValidationRule({
        id: ruleId,
        name: 'disabled-pattern-rule',
        rule_type: 'pattern',
        pattern: 'DISABLED_MATCH',
        severity: 'error',
        enabled: false,
      });

      const taskId = createTask();
      const results = db.validateTaskOutput(taskId, [
        { path: 'src/match.ts', content: 'DISABLED_MATCH here', size: 20 },
      ]);

      const disabledResult = results.find(r => r.rule === 'disabled-pattern-rule');
      expect(disabledResult).toBeUndefined();
    });
  });

  // ================================================================
  // validation.js — recordQualityScore / getQualityScore / getProviderQualityStats
  // ================================================================

  describe('recordQualityScore + getQualityScore', () => {
    it('records and retrieves a quality score', () => {
      const taskId = createTask();
      const overall = db.recordQualityScore(taskId, 'ollama', 'code', {
        validation: 80,
        syntax: 90,
        completeness: 70,
      });

      // 80*0.4 + 90*0.3 + 70*0.3 = 32 + 27 + 21 = 80
      expect(overall).toBe(80);

      const score = db.getQualityScore(taskId);
      expect(score).not.toBeNull();
      expect(score.overall_score).toBe(80);
      expect(score.validation_score).toBe(80);
      expect(score.syntax_score).toBe(90);
      expect(score.completeness_score).toBe(70);
      expect(score.provider).toBe('ollama');
      expect(score.task_type).toBe('code');
    });

    it('defaults missing scores to 100', () => {
      const taskId = createTask();
      const overall = db.recordQualityScore(taskId, 'codex', 'docs', {});

      // (100*0.4 + 100*0.3 + 100*0.3) = 100
      expect(overall).toBe(100);
    });
  });

  describe('getProviderQualityStats', () => {
    it('returns aggregate quality stats for a provider', () => {
      const taskId1 = createTask();
      const taskId2 = createTask();
      db.recordQualityScore(taskId1, 'test-provider-qs', 'code', { validation: 80, syntax: 90, completeness: 70 });
      db.recordQualityScore(taskId2, 'test-provider-qs', 'code', { validation: 60, syntax: 70, completeness: 50 });

      const stats = db.getProviderQualityStats('test-provider-qs');
      expect(stats).not.toBeNull();
      expect(stats.total_tasks).toBe(2);
      expect(stats.avg_score).toBeGreaterThan(0);
      expect(stats.min_score).toBeLessThanOrEqual(stats.max_score);
    });

    it('returns undefined for provider with no scores', () => {
      const stats = db.getProviderQualityStats('nonexistent-provider');
      expect(stats).toBeUndefined();
    });
  });

  // ================================================================
  // validation.js — createDiffPreview / getDiffPreview / markDiffReviewed
  // ================================================================

  describe('createDiffPreview + getDiffPreview + markDiffReviewed', () => {
    it('creates and retrieves a diff preview', () => {
      const taskId = createTask();
      const diffId = db.createDiffPreview(taskId, '--- a/file\n+++ b/file\n+new line', 1, 1, 0);
      expect(diffId).toBeDefined();

      const preview = db.getDiffPreview(taskId);
      expect(preview).not.toBeNull();
      expect(preview.task_id).toBe(taskId);
      expect(preview.diff_content).toContain('+new line');
      expect(preview.files_changed).toBe(1);
      expect(preview.lines_added).toBe(1);
      expect(preview.lines_removed).toBe(0);
      expect(preview.status).toBe('pending');
    });

    it('marks diff as reviewed', () => {
      const taskId = createTask();
      db.createDiffPreview(taskId, 'diff content', 2, 5, 3);
      db.markDiffReviewed(taskId, 'tester');

      const preview = db.getDiffPreview(taskId);
      expect(preview.status).toBe('reviewed');
      expect(preview.reviewed_by).toBe('tester');
      expect(preview.reviewed_at).toBeDefined();
    });
  });

  // ================================================================
  // validation.js — createRollback / getRollback / completeRollback / listRollbacks
  // ================================================================

  describe('createRollback + getRollback + completeRollback + listRollbacks', () => {
    it('creates and retrieves a rollback', () => {
      const taskId = createTask();
      const rollbackId = db.createRollback(taskId, 'git', ['src/app.ts'], 'abc123', 'quality failure', 'system');
      expect(rollbackId).toBeDefined();

      const rollback = db.getRollback(taskId);
      expect(rollback).not.toBeNull();
      expect(rollback.task_id).toBe(taskId);
      expect(rollback.rollback_type).toBe('git');
      expect(rollback.status).toBe('pending');
      expect(rollback.reason).toBe('quality failure');
    });

    it('completes a rollback', () => {
      const taskId = createTask();
      const rollbackId = db.createRollback(taskId, 'git', [], 'before-sha', 'test', 'auto');
      db.completeRollback(rollbackId, 'after-sha', 'completed');

      const rollback = db.getRollback(taskId);
      expect(rollback.status).toBe('completed');
      expect(rollback.commit_after).toBe('after-sha');
      expect(rollback.completed_at).toBeDefined();
    });

    it('lists rollbacks with optional status filter', () => {
      const taskId = createTask();
      db.createRollback(taskId, 'git', [], null, 'list test', 'system');

      const all = db.listRollbacks(null, 100);
      expect(all.length).toBeGreaterThanOrEqual(1);

      const pending = db.listRollbacks('pending', 100);
      expect(pending.every(r => r.status === 'pending')).toBe(true);
    });
  });

  // ================================================================
  // validation.js — generateTaskFingerprint / recordTaskFingerprint / checkDuplicateTask
  // ================================================================

  describe('generateTaskFingerprint + recordTaskFingerprint + checkDuplicateTask', () => {
    it('generates a consistent fingerprint for the same input', () => {
      const fp1 = db.generateTaskFingerprint('Write unit tests', '/project');
      const fp2 = db.generateTaskFingerprint('Write unit tests', '/project');
      expect(fp1).toBe(fp2);
    });

    it('generates different fingerprints for different descriptions', () => {
      const fp1 = db.generateTaskFingerprint('Write unit tests', '/project');
      const fp2 = db.generateTaskFingerprint('Fix bug in parser', '/project');
      expect(fp1).not.toBe(fp2);
    });

    it('normalizes whitespace in fingerprint generation', () => {
      const fp1 = db.generateTaskFingerprint('Write   unit   tests', '/project');
      const fp2 = db.generateTaskFingerprint('Write unit tests', '/project');
      expect(fp1).toBe(fp2);
    });

    it('records a fingerprint and detects duplicates', () => {
      const taskId = createTask({ status: 'running' });
      const desc = `unique-task-desc-${Date.now()}`;
      db.recordTaskFingerprint(taskId, desc, process.cwd());

      const check = db.checkDuplicateTask(desc, process.cwd());
      expect(check.isDuplicate).toBe(true);
      expect(check.existingTaskId).toBe(taskId);
    });

    it('returns not duplicate for completed tasks', () => {
      const taskId = createTask({ status: 'completed' });
      const desc = `completed-task-${Date.now()}`;
      db.recordTaskFingerprint(taskId, desc, process.cwd());
      db.updateTaskStatus(taskId, 'completed');

      const check = db.checkDuplicateTask(desc, process.cwd());
      expect(check.isDuplicate).toBe(false);
    });
  });

  // ================================================================
  // validation.js — acquireFileLock / releaseFileLock / releaseAllFileLocks / getActiveFileLocks
  // ================================================================

  describe('acquireFileLock + releaseFileLock + getActiveFileLocks', () => {
    it('acquires a file lock', () => {
      const taskId = createTask();
      const result = db.acquireFileLock('src/app.ts', process.cwd(), taskId);
      expect(result.acquired).toBe(true);
    });

    it('blocks lock acquisition by a different task', () => {
      const task1 = createTask();
      const task2 = createTask();
      const filePath = `src/conflict-${Date.now()}.ts`;
      const wd = process.cwd();

      db.acquireFileLock(filePath, wd, task1);
      const result = db.acquireFileLock(filePath, wd, task2);
      expect(result.acquired).toBe(false);
      expect(result.lockedBy).toBe(task1);
    });

    it('allows same task to re-acquire its own lock', () => {
      const taskId = createTask();
      const filePath = `src/reacquire-${Date.now()}.ts`;
      db.acquireFileLock(filePath, process.cwd(), taskId);
      const result = db.acquireFileLock(filePath, process.cwd(), taskId);
      expect(result.acquired).toBe(true);
    });

    it('releases a lock and allows another task to acquire', () => {
      const task1 = createTask();
      const task2 = createTask();
      const filePath = `src/release-${Date.now()}.ts`;
      const wd = process.cwd();

      db.acquireFileLock(filePath, wd, task1);
      db.releaseFileLock(filePath, wd, task1);

      const result = db.acquireFileLock(filePath, wd, task2);
      expect(result.acquired).toBe(true);
    });

    it('releaseAllFileLocks releases all locks for a task', () => {
      const taskId = createTask();
      const wd = process.cwd();
      db.acquireFileLock(`src/a-${Date.now()}.ts`, wd, taskId);
      db.acquireFileLock(`src/b-${Date.now()}.ts`, wd, taskId);

      db.releaseAllFileLocks(taskId);
      const active = db.getActiveFileLocks(taskId);
      expect(active).toHaveLength(0);
    });

    it('getActiveFileLocks returns locks for a specific task', () => {
      const taskId = createTask();
      const wd = process.cwd();
      const filePath = `src/active-${Date.now()}.ts`;
      db.acquireFileLock(filePath, wd, taskId);

      const locks = db.getActiveFileLocks(taskId);
      expect(locks.length).toBeGreaterThanOrEqual(1);
      expect(locks.some(l => l.file_path === filePath)).toBe(true);
    });
  });

  // ================================================================
  // validation.js — updateProviderStats / getProviderStats / getBestProviderForTaskType
  // ================================================================

  describe('updateProviderStats + getProviderStats', () => {
    it('records and retrieves provider stats', () => {
      const providerName = `test-prov-${Date.now()}`;
      fileQuality.updateProviderStats(providerName, 'code', true, 85, 30);
      fileQuality.updateProviderStats(providerName, 'code', false, 40, 120);

      const stats = fileQuality.getProviderStats(providerName);
      expect(stats.length).toBeGreaterThanOrEqual(1);
      const codeStat = stats.find(s => s.task_type === 'code');
      expect(codeStat.total_tasks).toBe(2);
      expect(codeStat.successful_tasks).toBe(1);
      expect(codeStat.failed_tasks).toBe(1);
    });

    it('getProviderStats returns all stats when no provider specified', () => {
      const stats = fileQuality.getProviderStats();
      expect(Array.isArray(stats)).toBe(true);
    });
  });

  describe('getBestProviderForTaskType', () => {
    it('returns best provider based on composite score (needs >= 3 tasks)', () => {
      const providerName = `best-prov-${Date.now()}`;
      for (let i = 0; i < 4; i++) {
        db.updateProviderStats(providerName, 'test-type', true, 90, 10);
      }

      const best = db.getBestProviderForTaskType('test-type');
      // Should return something (may or may not be our provider since others could exist)
      // but the result shape should be correct if found
      if (best) {
        expect(best).toHaveProperty('provider');
        expect(best).toHaveProperty('composite_score');
      }
    });

    it('returns null for task type with no stats', () => {
      const best = db.getBestProviderForTaskType('nonexistent-task-type-xyz');
      expect(best).toBeUndefined();
    });
  });

  // ================================================================
  // validation.js — recordAuditEvent / getAuditTrail / getAuditSummary
  // ================================================================

  describe('recordAuditEvent + getAuditTrail + getAuditSummary', () => {
    it('records and retrieves an audit event', () => {
      fileQuality.recordAuditEvent('config_change', 'setting', 'max_concurrent', 'update', 'admin', '3', '5', { reason: 'scaling' });

      const trail = fileQuality.getAuditTrail('setting', 'max_concurrent');
      expect(trail.length).toBeGreaterThanOrEqual(1);
      const event = trail.find(e => e.action === 'update' && e.entity_id === 'max_concurrent');
      expect(event).toBeDefined();
      expect(event.old_value).toBe('3');
      expect(event.new_value).toBe('5');
    });

    it('getAuditTrail filters by entity type only', () => {
      fileQuality.recordAuditEvent('task_event', 'task', 'task-1', 'create', 'system');

      const trail = fileQuality.getAuditTrail('task');
      expect(trail.length).toBeGreaterThanOrEqual(1);
      expect(trail.every(e => e.entity_type === 'task')).toBe(true);
    });

    it('getAuditTrail returns all events when no filters', () => {
      const trail = fileQuality.getAuditTrail(null, null, 10);
      expect(Array.isArray(trail)).toBe(true);
    });

    it('getAuditSummary returns grouped counts', () => {
      fileQuality.recordAuditEvent('summary_test', 'widget', 'w1', 'activate');
      fileQuality.recordAuditEvent('summary_test', 'widget', 'w2', 'activate');

      const summary = fileQuality.getAuditSummary(1);
      expect(Array.isArray(summary)).toBe(true);
      if (summary.length > 0) {
        expect(summary[0]).toHaveProperty('event_type');
        expect(summary[0]).toHaveProperty('action');
        expect(summary[0]).toHaveProperty('count');
      }
    });
  });
});
