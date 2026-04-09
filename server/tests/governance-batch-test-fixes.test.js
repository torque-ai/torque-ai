const Database = require('better-sqlite3');
const { BUILTIN_RULES, createGovernanceRules } = require('../db/governance-rules');
const { createGovernanceHooks } = require('../governance/hooks');
const {
  BATCH_TEST_FIXES_RULE,
  evaluateBatchTestFixes,
  resetInvocationCountersForTesting,
} = require('../governance/rules/batch-test-fixes');

function createLoggerMock() {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    child: vi.fn(() => child),
    __child: child,
  };
}

describe('governance batch-test-fixes', () => {
  let db;
  let rules;

  beforeEach(() => {
    resetInvocationCountersForTesting();
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS governance_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        stage TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'warn',
        default_mode TEXT NOT NULL DEFAULT 'warn',
        enabled INTEGER NOT NULL DEFAULT 1,
        violation_count INTEGER NOT NULL DEFAULT 0,
        checker_id TEXT NOT NULL,
        config TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_governance_rules_stage ON governance_rules(stage);
      CREATE INDEX IF NOT EXISTS idx_governance_rules_enabled ON governance_rules(enabled);
    `);
    rules = createGovernanceRules({ db });
  });

  afterEach(() => {
    resetInvocationCountersForTesting();
    if (db) {
      db.close();
      db = null;
    }
  });

  it('exists in the builtin rules list and loads into the rules store', () => {
    expect(BUILTIN_RULES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'batch-test-fixes',
          stage: 'pre-verify',
          default_mode: 'warn',
          checker_id: 'checkBatchTestFixes',
        }),
      ]),
    );

    rules.seedBuiltinRules();

    expect(rules.getRule('batch-test-fixes')).toMatchObject({
      id: 'batch-test-fixes',
      description: BATCH_TEST_FIXES_RULE.description,
      stage: 'pre-verify',
      mode: 'warn',
      default_mode: 'warn',
      enabled: true,
      checker_id: 'checkBatchTestFixes',
    });
  });

  it('emits an advisory warning after the third full-suite run for the same change set', async () => {
    rules.seedBuiltinRules();
    const hooks = createGovernanceHooks({ governanceRules: rules, logger: createLoggerMock() });
    const task = {
      id: 'task-batch-verify',
      workflow_id: 'wf-batch-verify',
      working_directory: 'C:/repo',
    };

    const first = await hooks.evaluate('pre-verify', task, {
      verify_command: 'npx vitest run',
      change_set: 'wf-batch-verify::head-1',
    });
    const second = await hooks.evaluate('pre-verify', task, {
      verify_command: 'npx vitest run',
      change_set: 'wf-batch-verify::head-1',
    });
    const third = await hooks.evaluate('pre-verify', task, {
      verify_command: 'npx vitest run',
      change_set: 'wf-batch-verify::head-1',
    });

    expect(first.warned).toEqual([]);
    expect(second.warned).toEqual([]);
    expect(third.warned).toHaveLength(1);
    expect(third.warned[0]).toMatchObject({
      rule_id: 'batch-test-fixes',
      checker_id: 'checkBatchTestFixes',
      mode: 'warn',
      invocation_count: 3,
      change_set: 'wf-batch-verify::head-1',
    });
    expect(third.warned[0].message).toBe(
      'Test suite has been run 3 times for this change set. Consider batching all fixes before re-running.',
    );
  });

  it('increments the evaluator counter for the same change set and warns on run three', () => {
    const task = { id: 'task-counter', working_directory: 'C:/repo' };
    const rule = {
      ...BATCH_TEST_FIXES_RULE,
      config: {
        ...BATCH_TEST_FIXES_RULE.config,
      },
    };

    const first = evaluateBatchTestFixes({
      task,
      rule,
      context: {
        verify_command: 'npm test',
        change_set: 'set-a',
      },
    });
    const second = evaluateBatchTestFixes({
      task,
      rule,
      context: {
        verify_command: 'npm test',
        change_set: 'set-a',
      },
    });
    const third = evaluateBatchTestFixes({
      task,
      rule,
      context: {
        verify_command: 'npm test',
        change_set: 'set-a',
      },
    });
    const targetedRun = evaluateBatchTestFixes({
      task,
      rule,
      context: {
        verify_command: 'npx vitest run server/tests/governance-batch-test-fixes.test.js',
        change_set: 'set-a',
      },
    });

    expect(first).toMatchObject({ pass: true, tracked: true, invocation_count: 1, change_set: 'set-a' });
    expect(second).toMatchObject({ pass: true, tracked: true, invocation_count: 2, change_set: 'set-a' });
    expect(third).toMatchObject({ pass: false, invocation_count: 3, change_set: 'set-a' });
    expect(third.message).toBe(
      'Test suite has been run 3 times for this change set. Consider batching all fixes before re-running.',
    );
    expect(targetedRun).toMatchObject({ pass: true, tracked: false });
  });
});
