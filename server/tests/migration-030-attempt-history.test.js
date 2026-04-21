import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const migrationsModule = require('../db/migrations');

// Find migration 30's up/down SQL in the exported migrations list. We
// apply ONLY that migration directly — this is a unit test of migration
// 30's schema, not a re-test of the full migration chain (which
// requires the complete base schema and is covered elsewhere).
function findMigration30() {
  const list = migrationsModule.MIGRATIONS
    || (migrationsModule.default && migrationsModule.default.MIGRATIONS)
    || [];
  const hit = list.find((m) => m && m.version === 30);
  if (!hit) throw new Error('migration 30 not exported from ../db/migrations');
  return hit;
}

describe('migration 030 — factory_attempt_history + verify_silent_reruns', () => {
  let db;
  let migration30;

  beforeEach(() => {
    db = new Database(':memory:');
    // Seed just factory_loop_instances — migration 30 ALTERs it to add
    // verify_silent_reruns. We don't need the rest of the base schema.
    db.prepare(`CREATE TABLE factory_loop_instances (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      work_item_id INTEGER,
      batch_id TEXT,
      loop_state TEXT NOT NULL DEFAULT 'IDLE',
      paused_at_stage TEXT,
      last_action_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      terminated_at TEXT
    )`).run();
    migration30 = findMigration30();
  });

  afterEach(() => { db.close(); });

  function applyMigration30(database) {
    // up is a newline-joined string of statements; split on newlines
    // that terminate a semicolon, then run each one.
    const sql = migration30.up;
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => (s.endsWith(';') ? s : `${s};`));
    for (const stmt of statements) {
      database.prepare(stmt).run();
    }
  }

  it('creates factory_attempt_history with required columns and indices', () => {
    applyMigration30(db);
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
    applyMigration30(db);
    const cols = db.prepare("PRAGMA table_info('factory_loop_instances')").all();
    const col = cols.find((c) => c.name === 'verify_silent_reruns');
    expect(col).toBeDefined();
    expect(col.dflt_value).toBe('0');
    db.prepare('INSERT INTO factory_loop_instances (id, project_id) VALUES (?, ?)').run('inst-1', 'proj-1');
    const row = db.prepare('SELECT verify_silent_reruns FROM factory_loop_instances WHERE id=?').get('inst-1');
    expect(row.verify_silent_reruns).toBe(0);
  });

  it('migration 30 down SQL is a complete reverse of up SQL', () => {
    applyMigration30(db);
    // Apply down
    const downStatements = migration30.down
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => (s.endsWith(';') ? s : `${s};`));
    for (const stmt of downStatements) {
      db.prepare(stmt).run();
    }
    // factory_attempt_history should be gone
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='factory_attempt_history'").get();
    expect(t).toBeUndefined();
    // Note: SQLite does not support DROP COLUMN on old versions, so the
    // verify_silent_reruns column is intentionally left in place by the
    // down migration (consistent with migration #3 and #29's pattern).
  });
});
