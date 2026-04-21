import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const { createTables } = require('../db/schema-tables');

describe('migration 030 — factory_attempt_history + verify_silent_reruns', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    // Seed the full base schema first — runMigrations applies all numbered
    // migrations in order (e.g. #2 adds an index on provider_task_stats),
    // so every migration's target table must exist before runMigrations runs.
    // This mirrors how the production server starts up.
    createTables(db, { debug() {}, warn() {}, error() {}, info() {} });
  });

  afterEach(() => { db.close(); });

  it('creates factory_attempt_history with required columns and indices', () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info('factory_attempt_history')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'batch_id', 'work_item_id', 'attempt', 'kind', 'task_id',
      'files_touched', 'file_count', 'stdout_tail', 'zero_diff_reason',
      'classifier_source', 'classifier_conf', 'verify_output_tail', 'created_at',
    ]));
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='factory_attempt_history'").all().map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining([
      'idx_factory_attempt_history_batch',
      'idx_factory_attempt_history_work_item',
    ]));
  });

  it('adds verify_silent_reruns column to factory_loop_instances with default 0', () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info('factory_loop_instances')").all();
    const col = cols.find((c) => c.name === 'verify_silent_reruns');
    expect(col).toBeDefined();
    expect(col.dflt_value).toBe('0');
    db.prepare('INSERT INTO factory_loop_instances (id, project_id) VALUES (?, ?)').run('inst-1', 'proj-1');
    const row = db.prepare('SELECT verify_silent_reruns FROM factory_loop_instances WHERE id=?').get('inst-1');
    expect(row.verify_silent_reruns).toBe(0);
  });

  it('is idempotent — running migrations twice does not error', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
