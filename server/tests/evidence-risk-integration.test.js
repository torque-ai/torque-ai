const Database = require('better-sqlite3');

describe('evidence-risk integration', () => {
  let db;
  let fileRisk;
  let ledger;
  let reviews;
  let fileRiskAdapter;

  beforeEach(() => {
    db = new Database(':memory:');

    db.exec(`
      CREATE TABLE file_risk_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, working_directory TEXT NOT NULL,
        risk_level TEXT NOT NULL, risk_reasons TEXT NOT NULL, auto_scored INTEGER NOT NULL DEFAULT 1,
        scored_at TEXT NOT NULL, scored_by TEXT, UNIQUE(file_path, working_directory)
      );
      CREATE TABLE verification_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, workflow_id TEXT,
        phase TEXT NOT NULL, check_name TEXT NOT NULL, tool TEXT, command TEXT,
        exit_code INTEGER, output_snippet TEXT, passed INTEGER NOT NULL,
        duration_ms INTEGER, created_at TEXT NOT NULL
      );
      CREATE TABLE adversarial_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, review_task_id TEXT,
        reviewer_provider TEXT NOT NULL, reviewer_model TEXT, verdict TEXT, confidence TEXT,
        issues TEXT, diff_snippet TEXT, duration_ms INTEGER, created_at TEXT NOT NULL
      );
      CREATE TABLE task_file_changes (
        id INTEGER PRIMARY KEY, task_id TEXT, file_path TEXT, change_type TEXT,
        file_size_bytes INTEGER, working_directory TEXT, relative_path TEXT,
        is_outside_workdir INTEGER, created_at TEXT
      );
    `);

    const { createFileRisk } = require('../db/file/risk');
    fileRisk = createFileRisk({ db });

    const { createVerificationLedger } = require('../db/verification-ledger');
    ledger = createVerificationLedger({ db });

    const { createAdversarialReviews } = require('../db/adversarial-reviews');
    reviews = createAdversarialReviews({ db });

    const { createFileRiskAdapter } = require('../policy-engine/adapters/file-risk');
    fileRiskAdapter = createFileRiskAdapter({ db, fileRisk });
  });

  it('file risk -> ledger -> adversarial review data flow', () => {
    // 1. Score files via adapter
    const scored = fileRiskAdapter.scoreAndPersist(
      ['server/auth/session.js', 'src/utils/format.js'],
      '/project',
      'task-1'
    );
    expect(scored[0].risk_level).toBe('high');
    expect(scored[1].risk_level).toBe('low');

    // 2. Scores persisted and queryable
    const risk = fileRisk.getFileRisk('server/auth/session.js', '/project');
    expect(risk.risk_level).toBe('high');

    // 3. Ledger records checks
    ledger.insertChecks([
      { task_id: 'task-1', phase: 'after', check_name: 'build', tool: 'tsc', passed: 1, duration_ms: 1000 },
      { task_id: 'task-1', phase: 'after', check_name: 'test', tool: 'vitest', passed: 1, duration_ms: 5000 },
    ]);
    expect(ledger.getChecksForTask('task-1')).toHaveLength(2);

    // 4. Adversarial review records result
    reviews.insertReview({
      task_id: 'task-1',
      review_task_id: 'review-1',
      reviewer_provider: 'deepinfra',
      verdict: 'concerns',
      confidence: 'medium',
      issues: JSON.stringify([{ file: 'server/auth/session.js', line: 42, severity: 'warning', category: 'security', description: 'Missing rate limit', suggestion: 'Add rate limiting' }]),
    });

    // 5. Review also goes into ledger
    ledger.insertCheck({
      task_id: 'task-1',
      phase: 'review',
      check_name: 'adversarial_review',
      tool: 'deepinfra',
      passed: 1,
    });

    // 6. Full ledger shows pipeline + review
    const allChecks = ledger.getChecksForTask('task-1');
    expect(allChecks).toHaveLength(3);
    expect(allChecks.filter(c => c.phase === 'after')).toHaveLength(2);
    expect(allChecks.filter(c => c.phase === 'review')).toHaveLength(1);

    // 7. Task risk summary via file_changes join
    db.prepare('INSERT INTO task_file_changes (task_id, file_path, working_directory, change_type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('task-1', 'server/auth/session.js', '/project', 'modified', new Date().toISOString());
    db.prepare('INSERT INTO task_file_changes (task_id, file_path, working_directory, change_type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('task-1', 'src/utils/format.js', '/project', 'modified', new Date().toISOString());

    const summary = fileRisk.getTaskRiskSummary('task-1');
    expect(summary.overall_risk).toBe('high');
    expect(summary.high).toHaveLength(1);
  });
});
