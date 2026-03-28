const Database = require('better-sqlite3');

describe('file-risk policy adapter', () => {
  let db;
  let adapter;
  let fileRisk;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE file_risk_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL, working_directory TEXT NOT NULL,
        risk_level TEXT NOT NULL, risk_reasons TEXT NOT NULL,
        auto_scored INTEGER NOT NULL DEFAULT 1, scored_at TEXT NOT NULL, scored_by TEXT,
        UNIQUE(file_path, working_directory)
      )
    `);
    db.exec(`
      CREATE TABLE task_file_changes (
        id INTEGER PRIMARY KEY, task_id TEXT, file_path TEXT,
        change_type TEXT, file_size_bytes INTEGER, working_directory TEXT,
        relative_path TEXT, is_outside_workdir INTEGER, created_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE file_baselines (
        id INTEGER PRIMARY KEY, file_path TEXT, working_directory TEXT,
        size_bytes INTEGER, line_count INTEGER, checksum TEXT,
        captured_at TEXT, task_id TEXT,
        UNIQUE(file_path, working_directory)
      )
    `);

    const { createFileRisk } = require('../db/file-risk');
    fileRisk = createFileRisk({ db });

    const { createFileRiskAdapter } = require('../policy-engine/adapters/file-risk');
    adapter = createFileRiskAdapter({ db, fileRisk });
  });

  it('collectEvidence scores changed files and returns evidence', () => {
    const context = {
      stage: 'task_complete',
      changed_files: ['server/auth/session.js', 'src/utils/format.js'],
      project_path: '/project',
    };

    const evidence = adapter.collectEvidence(context);

    expect(evidence).toHaveLength(1);
    expect(evidence[0].type).toBe('file_risk_assessed');
    expect(evidence[0].satisfied).toBe(true);
    expect(evidence[0].total_files).toBe(2);
    expect(evidence[0].high_risk_files).toHaveLength(1);
    expect(evidence[0].high_risk_files[0]).toBe('server/auth/session.js');
  });

  it('scoreAndPersist writes scores to DB', () => {
    adapter.scoreAndPersist(['server/auth/session.js', 'docs/README.md'], '/project');

    const high = fileRisk.getFileRisk('server/auth/session.js', '/project');
    expect(high.risk_level).toBe('high');
    expect(high.auto_scored).toBe(1);

    const low = fileRisk.getFileRisk('docs/README.md', '/project');
    expect(low.risk_level).toBe('low');
    expect(low.auto_scored).toBe(1);
  });

  it('respects manual overrides - does not overwrite auto_scored=0', () => {
    fileRisk.setManualOverride('src/utils/format.js', '/project', 'high', 'custom-reason');
    adapter.scoreAndPersist(['src/utils/format.js'], '/project');

    const result = fileRisk.getFileRisk('src/utils/format.js', '/project');
    expect(result.risk_level).toBe('high');
    expect(result.auto_scored).toBe(0);
  });

  it('returns empty evidence when no files provided', () => {
    const evidence = adapter.collectEvidence({ stage: 'task_complete', changed_files: [], project_path: '/p' });
    expect(evidence[0].high_risk_files).toHaveLength(0);
    expect(evidence[0].medium_risk_files).toHaveLength(0);
    expect(evidence[0].low_risk_files).toHaveLength(0);
    expect(evidence[0].total_files).toBe(0);
  });
});
