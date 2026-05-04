const Database = require('better-sqlite3');

describe('file-risk', () => {
  let db;
  let fileRisk;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE file_risk_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        risk_reasons TEXT NOT NULL,
        auto_scored INTEGER NOT NULL DEFAULT 1,
        scored_at TEXT NOT NULL,
        scored_by TEXT,
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

    db.exec('CREATE INDEX idx_risk_scores_level ON file_risk_scores(risk_level)');
    db.exec('CREATE INDEX idx_risk_scores_path ON file_risk_scores(file_path)');

    const { createFileRisk } = require('../db/file/risk');
    fileRisk = createFileRisk({ db });
  });

  it('upserts and retrieves a file risk score', () => {
    fileRisk.upsertScore({
      file_path: 'server/auth/session.js',
      working_directory: '/project',
      risk_level: 'high',
      risk_reasons: JSON.stringify(['auth_module']),
      scored_by: 'pattern',
    });

    const result = fileRisk.getFileRisk('server/auth/session.js', '/project');
    expect(result).toBeTruthy();
    expect(result.risk_level).toBe('high');
    expect(JSON.parse(result.risk_reasons)).toEqual(['auth_module']);
  });

  it('upsert replaces existing score for same file+dir', () => {
    fileRisk.upsertScore({
      file_path: 'server/auth/session.js',
      working_directory: '/project',
      risk_level: 'medium',
      risk_reasons: JSON.stringify(['cross_cutting']),
      scored_by: 'pattern',
    });
    fileRisk.upsertScore({
      file_path: 'server/auth/session.js',
      working_directory: '/project',
      risk_level: 'high',
      risk_reasons: JSON.stringify(['auth_module']),
      scored_by: 'pattern',
    });

    const results = db.prepare('SELECT * FROM file_risk_scores WHERE file_path = ?').all('server/auth/session.js');
    expect(results).toHaveLength(1);
    expect(results[0].risk_level).toBe('high');
  });

  it('does not overwrite a manual override', () => {
    fileRisk.upsertScore({
      file_path: 'server/auth/session.js',
      working_directory: '/project',
      risk_level: 'high',
      risk_reasons: JSON.stringify(['auth_module']),
      scored_by: 'pattern',
    });
    fileRisk.setManualOverride('server/auth/session.js', '/project', 'medium', 'manual-override');
    fileRisk.upsertScore({
      file_path: 'server/auth/session.js',
      working_directory: '/project',
      risk_level: 'low',
      risk_reasons: JSON.stringify(['low-risk']),
      scored_by: 'pattern',
    });

    const result = fileRisk.getFileRisk('server/auth/session.js', '/project');
    expect(result.risk_level).toBe('medium');
    expect(result.auto_scored).toBe(0);
    expect(JSON.parse(result.risk_reasons)).toContain('manual-override');
  });

  it('returns null for unknown file', () => {
    const result = fileRisk.getFileRisk('unknown.js', '/project');
    expect(result).toBeNull();
  });

  it('getFilesAtRisk filters by minimum level', () => {
    fileRisk.upsertScore({ file_path: 'auth.js', working_directory: '/p', risk_level: 'high', risk_reasons: '["auth_module"]', scored_by: 'pattern' });
    fileRisk.upsertScore({ file_path: 'config.js', working_directory: '/p', risk_level: 'medium', risk_reasons: '["configuration"]', scored_by: 'pattern' });
    fileRisk.upsertScore({ file_path: 'readme.md', working_directory: '/p', risk_level: 'low', risk_reasons: '["documentation"]', scored_by: 'pattern' });

    const highOnly = fileRisk.getFilesAtRisk('/p', 'high');
    expect(highOnly).toHaveLength(1);
    expect(highOnly[0].file_path).toBe('auth.js');

    const mediumUp = fileRisk.getFilesAtRisk('/p', 'medium');
    expect(mediumUp).toHaveLength(2);
  });

  it('setManualOverride sets auto_scored to 0', () => {
    fileRisk.upsertScore({ file_path: 'utils.js', working_directory: '/p', risk_level: 'low', risk_reasons: '["styling"]', scored_by: 'pattern' });
    fileRisk.setManualOverride('utils.js', '/p', 'high', 'contains-secrets');

    const result = fileRisk.getFileRisk('utils.js', '/p');
    expect(result.risk_level).toBe('high');
    expect(result.auto_scored).toBe(0);
    expect(JSON.parse(result.risk_reasons)).toContain('contains-secrets');
  });

  it('getTaskRiskSummary aggregates risk levels', () => {
    db.prepare('INSERT INTO task_file_changes (task_id, file_path, working_directory, change_type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('task-1', 'auth.js', '/p', 'modified', new Date().toISOString());
    db.prepare('INSERT INTO task_file_changes (task_id, file_path, working_directory, change_type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('task-1', 'readme.md', '/p', 'modified', new Date().toISOString());

    fileRisk.upsertScore({ file_path: 'auth.js', working_directory: '/p', risk_level: 'high', risk_reasons: '["auth_module"]', scored_by: 'pattern' });
    fileRisk.upsertScore({ file_path: 'readme.md', working_directory: '/p', risk_level: 'low', risk_reasons: '["documentation"]', scored_by: 'pattern' });

    const summary = fileRisk.getTaskRiskSummary('task-1');
    expect(summary.high).toHaveLength(1);
    expect(summary.low).toHaveLength(1);
    expect(summary.overall_risk).toBe('high');
  });
});
