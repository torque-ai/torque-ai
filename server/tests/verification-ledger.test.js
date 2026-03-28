const Database = require('better-sqlite3');

describe('verification-ledger', () => {
  let db;
  let ledger;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE verification_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        workflow_id TEXT,
        phase TEXT NOT NULL,
        check_name TEXT NOT NULL,
        tool TEXT,
        command TEXT,
        exit_code INTEGER,
        output_snippet TEXT,
        passed INTEGER NOT NULL,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX idx_verif_checks_task ON verification_checks(task_id)');
    db.exec('CREATE INDEX idx_verif_checks_phase ON verification_checks(phase)');

    const { createVerificationLedger } = require('../db/verification-ledger');
    ledger = createVerificationLedger({ db });
  });

  it('insertCheck writes a single row', () => {
    ledger.insertCheck({
      task_id: 'task-1',
      phase: 'after',
      check_name: 'build',
      tool: 'tsc',
      command: 'npx tsc --noEmit',
      exit_code: 0,
      output_snippet: 'Build succeeded',
      passed: 1,
      duration_ms: 1200,
    });

    const rows = db.prepare('SELECT * FROM verification_checks WHERE task_id = ?').all('task-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].check_name).toBe('build');
    expect(rows[0].passed).toBe(1);
  });

  it('insertChecks batch-inserts in a transaction', () => {
    const checks = [
      { task_id: 'task-1', phase: 'after', check_name: 'build', tool: 'tsc', passed: 1 },
      { task_id: 'task-1', phase: 'after', check_name: 'test', tool: 'vitest', passed: 0, exit_code: 1, output_snippet: '2 tests failed' },
      { task_id: 'task-1', phase: 'after', check_name: 'safeguard', tool: 'safeguard-gates', passed: 1 },
    ];
    ledger.insertChecks(checks);

    const rows = db.prepare('SELECT * FROM verification_checks WHERE task_id = ?').all('task-1');
    expect(rows).toHaveLength(3);
  });

  it('getChecksForTask returns all checks, filterable by phase and check_name', () => {
    ledger.insertCheck({ task_id: 't1', phase: 'baseline', check_name: 'build', tool: 'tsc', passed: 1 });
    ledger.insertCheck({ task_id: 't1', phase: 'after', check_name: 'build', tool: 'tsc', passed: 1 });
    ledger.insertCheck({ task_id: 't1', phase: 'after', check_name: 'test', tool: 'vitest', passed: 0 });
    ledger.insertCheck({ task_id: 't1', phase: 'review', check_name: 'adversarial_review', tool: 'deepinfra', passed: 1 });

    expect(ledger.getChecksForTask('t1')).toHaveLength(4);
    expect(ledger.getChecksForTask('t1', { phase: 'after' })).toHaveLength(2);
    expect(ledger.getChecksForTask('t1', { checkName: 'build' })).toHaveLength(2);
    expect(ledger.getChecksForTask('t1', { phase: 'after', checkName: 'test' })).toHaveLength(1);
  });

  it('getCheckSummary aggregates across a workflow', () => {
    ledger.insertCheck({ task_id: 't1', workflow_id: 'wf1', phase: 'after', check_name: 'build', passed: 1 });
    ledger.insertCheck({ task_id: 't2', workflow_id: 'wf1', phase: 'after', check_name: 'build', passed: 1 });
    ledger.insertCheck({ task_id: 't3', workflow_id: 'wf1', phase: 'after', check_name: 'build', passed: 0 });
    ledger.insertCheck({ task_id: 't1', workflow_id: 'wf1', phase: 'after', check_name: 'test', passed: 1 });

    const summary = ledger.getCheckSummary('wf1');
    expect(summary.build).toEqual({ total: 3, passed: 2, failed: 1 });
    expect(summary.test).toEqual({ total: 1, passed: 1, failed: 0 });
  });

  it('pruneOldChecks deletes rows older than retention', () => {
    const old = new Date(Date.now() - 100 * 86400000).toISOString();
    db.prepare('INSERT INTO verification_checks (task_id, phase, check_name, passed, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('old-task', 'after', 'build', 1, old);
    ledger.insertCheck({ task_id: 'new-task', phase: 'after', check_name: 'build', passed: 1 });

    const deleted = ledger.pruneOldChecks(90);
    expect(deleted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) as c FROM verification_checks').get().c).toBe(1);
  });
});
