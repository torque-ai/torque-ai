/**
 * Tests for server/db/validation-rules.js
 *
 * Validation rules, approval rules, failure patterns,
 * retry rules, and their interactions.
 */

const { randomUUID } = require('crypto');
const { setupTestDbModule, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');

let db;
let mod;
let testDir;

/**
 * Patch failure_patterns table to work around Wave 5 vs Wave 9 schema mismatch.
 *
 * Wave 5 created the table with `pattern_definition TEXT NOT NULL` but Wave 9's
 * saveFailurePattern() inserts into the migrated `signature` column without
 * providing `pattern_definition`. We recreate the table with a DEFAULT on
 * pattern_definition so the INSERT succeeds (matching production behavior where
 * the column would be pre-populated or unused).
 */
function patchFailurePatternsTable() {
  const conn = rawDb();
  try {
    // Get current column info
    const cols = conn.prepare("PRAGMA table_info('failure_patterns')").all();
    const hasPatternDef = cols.some(c => c.name === 'pattern_definition');
    if (!hasPatternDef) return;

    // Recreate the table with pattern_definition having a default value
    conn.exec(`
      CREATE TABLE IF NOT EXISTS failure_patterns_new (
        id TEXT PRIMARY KEY,
        pattern_type TEXT NOT NULL DEFAULT 'output',
        pattern_definition TEXT NOT NULL DEFAULT '',
        failure_count INTEGER DEFAULT 0,
        total_matches INTEGER DEFAULT 0,
        failure_rate REAL,
        suggested_intervention TEXT,
        confidence REAL DEFAULT 0.5,
        last_updated_at TEXT,
        created_at TEXT NOT NULL DEFAULT '',
        name TEXT,
        description TEXT,
        signature TEXT,
        task_types TEXT,
        provider TEXT,
        occurrence_count INTEGER DEFAULT 1,
        last_seen_at TEXT,
        recommended_action TEXT,
        auto_learned INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        updated_at TEXT
      )
    `);
    // Copy existing data (if any)
    conn.exec('INSERT OR IGNORE INTO failure_patterns_new SELECT * FROM failure_patterns');
    conn.exec('DROP TABLE failure_patterns');
    conn.exec('ALTER TABLE failure_patterns_new RENAME TO failure_patterns');
  } catch {
    // If patching fails, tests will fail with the original NOT NULL error
  }
}

function createTask(overrides = {}) {
  const payload = {
    id: randomUUID(),
    task_description: overrides.task_description || 'validation test task',
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'completed',
    provider: overrides.provider || 'codex',
    ...overrides,
  };
  db.createTask(payload);
  return db.getTask(payload.id);
}

describe('validation-rules module', () => {
  beforeAll(() => {
    ({ db, mod, testDir } = setupTestDbModule('../db/validation-rules', 'valrules'));
    mod.setGetTask((id) => db.getTask(id));

    // Disable FK enforcement (matches production init behavior)
    rawDb().pragma('foreign_keys = OFF');

    // Patch failure_patterns table to fix Wave 5/9 schema mismatch
    patchFailurePatternsTable();
  });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    resetTables([
      'retry_attempts', 'retry_rules', 'failure_matches', 'failure_patterns',
      'pending_approvals', 'approval_rules', 'validation_results',
      'validation_rules', 'tasks'
    ]);
  });

  // ====================================================
  // Validation rules CRUD
  // ====================================================
  describe('saveValidationRule / getValidationRule / getValidationRules', () => {
    it('creates a validation rule and retrieves it by id', () => {
      const id = randomUUID();
      mod.saveValidationRule({
        id,
        name: 'No console.log',
        description: 'Disallow console.log in production code',
        rule_type: 'pattern',
        pattern: 'console\\.log',
        severity: 'warning',
        enabled: true,
      });

      const rule = mod.getValidationRule(id);
      expect(rule).toBeTruthy();
      expect(rule.name).toBe('No console.log');
      expect(rule.pattern).toBe('console\\.log');
      expect(rule.severity).toBe('warning');
      expect(rule.enabled).toBe(1);
    });

    it('updates existing rule with same id (upsert)', () => {
      const id = randomUUID();
      mod.saveValidationRule({ id, name: 'Rule V1', rule_type: 'pattern', pattern: 'old' });
      mod.saveValidationRule({ id, name: 'Rule V2', rule_type: 'pattern', pattern: 'new' });

      const rule = mod.getValidationRule(id);
      expect(rule.name).toBe('Rule V2');
      expect(rule.pattern).toBe('new');
    });

    it('getValidationRules returns only enabled rules by default', () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      mod.saveValidationRule({ id: id1, name: 'Enabled', rule_type: 'pattern', enabled: true });
      mod.saveValidationRule({ id: id2, name: 'Disabled', rule_type: 'pattern', enabled: false });

      const enabled = mod.getValidationRules(true);
      const all = mod.getValidationRules(false);

      expect(enabled.every(r => r.enabled === 1)).toBe(true);
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('getValidationRules sorts by severity descending (alphabetical)', () => {
      mod.saveValidationRule({ id: randomUUID(), name: 'Info', rule_type: 'pattern', severity: 'info' });
      mod.saveValidationRule({ id: randomUUID(), name: 'Error', rule_type: 'pattern', severity: 'error' });
      mod.saveValidationRule({ id: randomUUID(), name: 'Warning', rule_type: 'pattern', severity: 'warning' });

      const rules = mod.getValidationRules(false);
      expect(rules.length).toBe(3);
      // SQLite sorts severity strings alphabetically DESC: warning > info > error
      expect(rules.map(r => r.severity)).toEqual(['warning', 'info', 'error']);
    });

    it('defaults enabled to 1, auto_fail to 0, severity to warning', () => {
      const id = randomUUID();
      mod.saveValidationRule({ id, name: 'Defaults', rule_type: 'pattern' });
      const rule = mod.getValidationRule(id);
      expect(rule.enabled).toBe(1);
      expect(rule.auto_fail).toBe(0);
      expect(rule.severity).toBe('warning');
    });
  });

  // ====================================================
  // Validation results
  // ====================================================
  describe('recordValidationResult / getValidationResults / hasValidationFailures', () => {
    it('records and retrieves validation results for a task', () => {
      const task = createTask();
      mod.recordValidationResult(task.id, 'rule-1', 'Rule One', 'fail', 'error', 'Pattern matched', '/src/app.js', 42);

      const results = mod.getValidationResults(task.id);
      expect(results.length).toBe(1);
      expect(results[0].rule_name).toBe('Rule One');
      expect(results[0].status).toBe('fail');
      expect(results[0].severity).toBe('error');
      expect(results[0].file_path).toBe('/src/app.js');
      expect(results[0].line_number).toBe(42);
    });

    it('hasValidationFailures returns true when failures exist at given severity', () => {
      const task = createTask();
      mod.recordValidationResult(task.id, 'rule-1', 'Rule', 'fail', 'error', 'details', null, null);

      expect(mod.hasValidationFailures(task.id, 'error')).toBe(true);
      expect(mod.hasValidationFailures(task.id, 'warning')).toBe(true);
    });

    it('hasValidationFailures returns false when no failures', () => {
      const task = createTask();
      mod.recordValidationResult(task.id, 'rule-1', 'Rule', 'pass', 'info', 'ok', null, null);

      expect(mod.hasValidationFailures(task.id, 'warning')).toBe(false);
    });

    it('hasValidationFailures respects minSeverity filter', () => {
      const task = createTask();
      mod.recordValidationResult(task.id, 'rule-1', 'Rule', 'fail', 'info', 'details', null, null);

      // info severity (0) < warning (1) so should not trigger for minSeverity=warning
      expect(mod.hasValidationFailures(task.id, 'warning')).toBe(false);
      // With ?? instead of ||, info severity (0) is now correctly handled
      expect(mod.hasValidationFailures(task.id, 'info')).toBe(true);
    });

    it('hasValidationFailures detects warning-level failures with minSeverity=warning', () => {
      const task = createTask();
      mod.recordValidationResult(task.id, 'rule-1', 'Rule', 'fail', 'warning', 'warn details', null, null);

      expect(mod.hasValidationFailures(task.id, 'warning')).toBe(true);
      expect(mod.hasValidationFailures(task.id, 'error')).toBe(false);
    });

    it('handles multiple validation results for same task', () => {
      const task = createTask();
      mod.recordValidationResult(task.id, 'r1', 'Rule 1', 'fail', 'warning', 'd1', null, null);
      mod.recordValidationResult(task.id, 'r2', 'Rule 2', 'pass', 'info', 'd2', null, null);
      mod.recordValidationResult(task.id, 'r3', 'Rule 3', 'fail', 'error', 'd3', null, null);

      const results = mod.getValidationResults(task.id);
      expect(results.length).toBe(3);
    });
  });

  // ====================================================
  // validateTaskOutput
  // ====================================================
  describe('validateTaskOutput', () => {
    it('detects pattern-based violations in file content', () => {
      const task = createTask();
      const ruleId = randomUUID();
      mod.saveValidationRule({
        id: ruleId,
        name: 'No TODO',
        rule_type: 'pattern',
        pattern: 'TODO:',
        severity: 'warning',
      });

      const results = mod.validateTaskOutput(task.id, [
        { path: '/src/app.js', content: '// TODO: fix this later', size: 100 }
      ]);

      expect(results.length).toBe(1);
      expect(results[0].rule).toBe('No TODO');
      expect(results[0].status).toBe('fail');
      expect(results[0].file).toBe('/src/app.js');
    });

    it('skips ReDoS-risky patterns in validateTaskOutput', () => {
      const task = createTask();
      mod.saveValidationRule({
        id: randomUUID(),
        name: 'Potential ReDoS',
        rule_type: 'pattern',
        pattern: '(a+)+$',
        severity: 'error',
      });

      const results = mod.validateTaskOutput(task.id, [
        { path: '/src/app.js', content: 'aaaaaaaaaaaa', size: 12 }
      ]);

      expect(results).toEqual([]);
    });

    it('truncates very long file content before pattern matching', () => {
      const task = createTask();
      mod.saveValidationRule({
        id: randomUUID(),
        name: 'Tail marker',
        rule_type: 'pattern',
        pattern: 'TAIL_MARKER',
        severity: 'warning',
      });

      const longContent = 'a'.repeat(50010) + 'TAIL_MARKER';

      const results = mod.validateTaskOutput(task.id, [
        { path: '/src/big.js', content: longContent, size: longContent.length }
      ]);

      expect(results).toEqual([]);
    });

    it('still matches normal patterns without ReDoS risk', () => {
      const task = createTask();
      mod.saveValidationRule({
        id: randomUUID(),
        name: 'No FIXME',
        rule_type: 'pattern',
        pattern: 'FIXME',
        severity: 'warning',
      });

      const results = mod.validateTaskOutput(task.id, [
        { path: '/src/app.js', content: 'TODO fixed; FIXME here', size: 20 }
      ]);

      expect(results.length).toBe(1);
      expect(results[0].rule).toBe('No FIXME');
      expect(results[0].status).toBe('fail');
    });

    it('detects size-based violations (empty file)', () => {
      const task = createTask();
      mod.saveValidationRule({
        id: randomUUID(),
        name: 'No empty files',
        rule_type: 'size',
        condition: 'size:0',
        severity: 'error',
      });

      const results = mod.validateTaskOutput(task.id, [
        { path: '/src/empty.js', content: '', size: 0 }
      ]);

      expect(results.length).toBe(1);
      expect(results[0].rule).toBe('No empty files');
    });

    it('detects size threshold violations for specific extensions', () => {
      const task = createTask();
      mod.saveValidationRule({
        id: randomUUID(),
        name: 'Min .cs file size',
        rule_type: 'size',
        condition: 'size:<100 extension:.cs',
        severity: 'warning',
      });

      const results = mod.validateTaskOutput(task.id, [
        { path: '/src/App.cs', content: 'x', size: 50 },
        { path: '/src/App.js', content: 'x', size: 50 }, // should not match
      ]);

      expect(results.length).toBe(1);
      expect(results[0].file).toBe('/src/App.cs');
    });

    it('detects delta-based violations (size decrease)', () => {
      const task = createTask();
      mod.saveValidationRule({
        id: randomUUID(),
        name: 'Size decrease check',
        rule_type: 'delta',
        condition: 'size_decrease_percent>50',
        severity: 'error',
      });

      const results = mod.validateTaskOutput(task.id, [
        { path: '/src/big.js', content: 'small', size: 100, originalSize: 1000 }
      ]);

      expect(results.length).toBe(1);
      expect(results[0].rule).toBe('Size decrease check');
    });

    it('returns empty array when no rules match', () => {
      const task = createTask();
      mod.saveValidationRule({
        id: randomUUID(),
        name: 'Check debugger',
        rule_type: 'pattern',
        pattern: 'debugger;',
        severity: 'warning',
      });

      const results = mod.validateTaskOutput(task.id, [
        { path: '/src/clean.js', content: 'function clean() {}', size: 50 }
      ]);

      expect(results).toEqual([]);
    });

    it('skips disabled rules', () => {
      const task = createTask();
      mod.saveValidationRule({
        id: randomUUID(),
        name: 'Disabled rule',
        rule_type: 'pattern',
        pattern: '.*',
        severity: 'error',
        enabled: false,
      });

      const results = mod.validateTaskOutput(task.id, [
        { path: '/src/any.js', content: 'anything', size: 10 }
      ]);
      expect(results).toEqual([]);
    });
  });

  // ====================================================
  // Approval rules
  // ====================================================
  describe('saveApprovalRule / getApprovalRules', () => {
    it('creates an approval rule', () => {
      const id = randomUUID();
      mod.saveApprovalRule({
        id,
        name: 'Prod deploy approval',
        rule_type: 'condition',
        condition: 'environment=production',
        required_approvers: 2,
      });

      const rules = mod.getApprovalRules(false);
      const rule = rules.find(r => r.id === id);
      expect(rule).toBeTruthy();
      expect(rule.name).toBe('Prod deploy approval');
      expect(rule.required_approvers).toBe(2);
    });

    it('getApprovalRules filters enabled only by default', () => {
      mod.saveApprovalRule({ id: randomUUID(), name: 'enabled', rule_type: 'condition', condition: 'x', enabled: true });
      mod.saveApprovalRule({ id: randomUUID(), name: 'disabled', rule_type: 'condition', condition: 'y', enabled: false });

      const enabled = mod.getApprovalRules(true);
      const all = mod.getApprovalRules(false);
      expect(enabled.every(r => r.enabled === 1)).toBe(true);
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getPendingApprovals / decideApproval / hasAllApprovals', () => {
    it('returns empty for task with no pending approvals', () => {
      const task = createTask();
      expect(mod.getPendingApprovals(task.id)).toEqual([]);
      expect(mod.hasAllApprovals(task.id)).toBe(true);
    });

    it('returns pending approvals and decides them', () => {
      const task = createTask();
      const approvalId = randomUUID();

      rawDb().prepare(`
        INSERT INTO pending_approvals (id, task_id, rule_id, rule_name, reason, status, requested_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(approvalId, task.id, 'rule-1', 'Test Rule', 'needs review', new Date().toISOString());

      expect(mod.hasAllApprovals(task.id)).toBe(false);
      const pending = mod.getPendingApprovals(task.id);
      expect(pending.length).toBe(1);

      mod.decideApproval(approvalId, true, 'admin', 'looks good');

      expect(mod.hasAllApprovals(task.id)).toBe(true);
      const afterDecision = rawDb().prepare('SELECT * FROM pending_approvals WHERE id = ?').get(approvalId);
      expect(afterDecision.status).toBe('approved');
      expect(afterDecision.decided_by).toBe('admin');
    });

    it('decideApproval handles rejection', () => {
      const task = createTask();
      const approvalId = randomUUID();

      rawDb().prepare(`
        INSERT INTO pending_approvals (id, task_id, rule_id, rule_name, status, requested_at)
        VALUES (?, ?, 'rule-1', 'Rule', 'pending', ?)
      `).run(approvalId, task.id, new Date().toISOString());

      mod.decideApproval(approvalId, false, 'reviewer', 'not acceptable');

      const row = rawDb().prepare('SELECT * FROM pending_approvals WHERE id = ?').get(approvalId);
      expect(row.status).toBe('rejected');
    });
  });

  // ====================================================
  // Failure patterns
  // ====================================================
  describe('saveFailurePattern / getFailurePatterns / matchFailurePatterns', () => {
    it('creates a failure pattern', () => {
      const id = randomUUID();
      mod.saveFailurePattern({
        id,
        name: 'OOM Pattern',
        pattern_type: 'output',
        signature: 'OutOfMemoryError',
        recommended_action: 'retry_with_cloud',
      });

      const patterns = mod.getFailurePatterns(false);
      const found = patterns.find(p => p.id === id);
      expect(found).toBeTruthy();
      expect(found.name).toBe('OOM Pattern');
    });

    it('getFailurePatterns filters enabled only by default', () => {
      mod.saveFailurePattern({ id: randomUUID(), name: 'Enabled', pattern_type: 'output', signature: 'err1', enabled: true });
      mod.saveFailurePattern({ id: randomUUID(), name: 'Disabled', pattern_type: 'output', signature: 'err2', enabled: false });

      const enabled = mod.getFailurePatterns(true);
      const all = mod.getFailurePatterns(false);
      expect(enabled.every(p => p.enabled === 1)).toBe(true);
      expect(all.length).toBeGreaterThan(enabled.length);
    });

    it('matchFailurePatterns detects matching output', () => {
      const patternId = randomUUID();
      mod.saveFailurePattern({
        id: patternId,
        name: 'Timeout Match',
        pattern_type: 'output',
        signature: 'ETIMEDOUT|connection timed out',
        recommended_action: 'retry_with_cloud',
      });

      const task = createTask();
      const matches = mod.matchFailurePatterns(task.id, 'Error: ETIMEDOUT connecting to host', null);

      expect(matches.length).toBe(1);
      expect(matches[0].pattern).toBe('Timeout Match');
      expect(matches[0].recommended_action).toBe('retry_with_cloud');
    });

    it('skips ReDoS-risky failure patterns', () => {
      const patternId = randomUUID();
      mod.saveFailurePattern({
        id: patternId,
        name: 'ReDoS Failure Pattern',
        pattern_type: 'output',
        signature: '(a+)+$',
        recommended_action: 'retry_with_cloud',
      });

      const task = createTask();
      const matches = mod.matchFailurePatterns(task.id, 'aaaaaaaaaaaa', null);

      expect(matches).toEqual([]);
      const row = rawDb().prepare('SELECT occurrence_count FROM failure_patterns WHERE id = ?').get(patternId);
      expect(row.occurrence_count).toBe(1);
    });

    it('matchFailurePatterns filters by provider', () => {
      mod.saveFailurePattern({
        id: randomUUID(),
        name: 'Ollama specific',
        pattern_type: 'output',
        signature: 'specific-error',
        provider: 'ollama',
      });

      const task = createTask();
      const matchesOllama = mod.matchFailurePatterns(task.id, 'specific-error here', 'ollama');
      const matchesCodex = mod.matchFailurePatterns(task.id, 'specific-error here', 'codex');

      expect(matchesOllama.length).toBe(1);
      expect(matchesCodex.length).toBe(0);
    });

    it('matchFailurePatterns increments occurrence_count', () => {
      const patternId = randomUUID();
      mod.saveFailurePattern({
        id: patternId,
        name: 'Increment test',
        pattern_type: 'output',
        signature: 'increment-me',
        occurrence_count: 1,
      });

      const task = createTask();
      mod.matchFailurePatterns(task.id, 'increment-me error', null);

      const updated = rawDb().prepare('SELECT occurrence_count FROM failure_patterns WHERE id = ?').get(patternId);
      expect(updated.occurrence_count).toBe(2);
    });

    it('matchFailurePatterns returns empty for no matches', () => {
      mod.saveFailurePattern({
        id: randomUUID(),
        name: 'No match',
        pattern_type: 'output',
        signature: 'very-specific-error-xyz',
      });

      const task = createTask();
      const matches = mod.matchFailurePatterns(task.id, 'something else entirely', null);
      expect(matches).toEqual([]);
    });
  });

  describe('getFailureMatches', () => {
    it('returns matches for a task joined with pattern info', () => {
      const patternId = randomUUID();
      mod.saveFailurePattern({
        id: patternId,
        name: 'Test Pattern',
        pattern_type: 'output',
        signature: 'match-this',
        recommended_action: 'retry',
      });

      const task = createTask();
      mod.matchFailurePatterns(task.id, 'match-this error', null);

      const matches = mod.getFailureMatches(task.id);
      expect(matches.length).toBe(1);
      expect(matches[0].pattern_name).toBe('Test Pattern');
      expect(matches[0].recommended_action).toBe('retry');
    });
  });

  // ====================================================
  // Retry rules
  // ====================================================
  describe('saveRetryRule / getRetryRules', () => {
    it('creates a retry rule', () => {
      const id = randomUUID();
      mod.saveRetryRule({
        id,
        name: 'Retry on timeout',
        trigger_type: 'pattern',
        trigger_condition: 'ETIMEDOUT',
        action: 'retry_with_cloud',
        fallback_provider: 'claude-cli',
        max_retries: 2,
        retry_delay_seconds: 10,
      });

      const rules = mod.getRetryRules(false);
      const found = rules.find(r => r.id === id);
      expect(found).toBeTruthy();
      expect(found.name).toBe('Retry on timeout');
      expect(found.max_retries).toBe(2);
    });

    it('getRetryRules filters enabled by default', () => {
      mod.saveRetryRule({ id: randomUUID(), name: 'enabled', trigger_type: 'pattern', trigger_condition: 'err', enabled: true });
      mod.saveRetryRule({ id: randomUUID(), name: 'disabled', trigger_type: 'pattern', trigger_condition: 'err', enabled: false });

      const enabled = mod.getRetryRules(true);
      const all = mod.getRetryRules(false);
      expect(enabled.every(r => r.enabled === 1)).toBe(true);
      expect(all.length).toBeGreaterThan(enabled.length);
    });
  });

  describe('shouldRetryWithCloud', () => {
    it('recommends retry when pattern matches output', () => {
      mod.saveRetryRule({
        id: randomUUID(),
        name: 'Pattern retry',
        trigger_type: 'pattern',
        trigger_condition: 'EAGAIN',
        fallback_provider: 'claude-cli',
        max_retries: 3,
        retry_delay_seconds: 5,
      });

      const task = createTask({ provider: 'ollama' });
      const result = mod.shouldRetryWithCloud(task.id, 'Error: EAGAIN resource temporarily unavailable');

      expect(result.shouldRetry).toBe(true);
      expect(result.fallbackProvider).toBe('claude-cli');
      expect(result.delaySeconds).toBe(5);
    });

    it('does not retry when max retries exceeded', () => {
      const ruleId = randomUUID();
      mod.saveRetryRule({
        id: ruleId,
        name: 'One retry only',
        trigger_type: 'pattern',
        trigger_condition: 'fail-once',
        max_retries: 1,
      });

      const task = createTask({ provider: 'ollama' });

      // First call should succeed
      const first = mod.shouldRetryWithCloud(task.id, 'fail-once error');
      expect(first.shouldRetry).toBe(true);

      // Second call should not retry (already at max)
      const second = mod.shouldRetryWithCloud(task.id, 'fail-once error');
      expect(second.shouldRetry).toBe(false);
    });

    it('recommends retry when output_empty condition matches', () => {
      mod.saveRetryRule({
        id: randomUUID(),
        name: 'Empty output retry',
        trigger_type: 'condition',
        trigger_condition: 'output_empty',
        fallback_provider: 'codex',
        max_retries: 2,
      });

      const task = createTask({ provider: 'ollama' });
      const result = mod.shouldRetryWithCloud(task.id, '');

      expect(result.shouldRetry).toBe(true);
      expect(result.reason).toMatch(/Output is empty/);
    });

    it('returns shouldRetry=false when no rules match', () => {
      mod.saveRetryRule({
        id: randomUUID(),
        name: 'Unmatched rule',
        trigger_type: 'pattern',
        trigger_condition: 'very-specific-error-abc',
        max_retries: 3,
      });

      const task = createTask({ provider: 'ollama' });
      const result = mod.shouldRetryWithCloud(task.id, 'some other error');
      expect(result.shouldRetry).toBe(false);
    });

    it('checks file_size condition in context', () => {
      mod.saveRetryRule({
        id: randomUUID(),
        name: 'Small file retry',
        trigger_type: 'condition',
        trigger_condition: 'file_size < 5',
        fallback_provider: 'claude-cli',
        max_retries: 2,
      });

      const task = createTask({ provider: 'ollama' });
      const result = mod.shouldRetryWithCloud(task.id, 'output', { fileSize: 3 });
      expect(result.shouldRetry).toBe(true);
    });
  });

  describe('updateRetryOutcome / getRetryAttempts', () => {
    it('records retry attempt and updates outcome', () => {
      mod.saveRetryRule({
        id: randomUUID(),
        name: 'Outcome test',
        trigger_type: 'pattern',
        trigger_condition: 'outcome-test-err',
        max_retries: 3,
      });

      const task = createTask({ provider: 'ollama' });
      mod.shouldRetryWithCloud(task.id, 'outcome-test-err');

      const attempts = mod.getRetryAttempts(task.id);
      expect(attempts.length).toBe(1);
      expect(attempts[0].outcome).toBe('pending');

      mod.updateRetryOutcome(task.id, 'success');

      const updated = mod.getRetryAttempts(task.id);
      expect(updated[0].outcome).toBe('success');
    });

    it('getRetryAttempts returns empty for task with no attempts', () => {
      expect(mod.getRetryAttempts('no-retry-task')).toEqual([]);
    });
  });
});
