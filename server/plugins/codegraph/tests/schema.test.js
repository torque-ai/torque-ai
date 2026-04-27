'use strict';

const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');

describe('codegraph schema', () => {
  let db;

  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => db.close());

  it('creates cg_files, cg_symbols, cg_references, cg_index_state tables', () => {
    ensureSchema(db);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cg_%'"
    ).all().map((r) => r.name).sort();
    expect(tables).toEqual(['cg_files', 'cg_index_state', 'cg_references', 'cg_symbols']);
  });

  it('is idempotent — second call does not throw', () => {
    ensureSchema(db);
    expect(() => ensureSchema(db)).not.toThrow();
  });

  it('cg_symbols supports the columns queries will read', () => {
    ensureSchema(db);
    const cols = db.prepare("PRAGMA table_info('cg_symbols')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'repo_path', 'file_path', 'name', 'kind', 'start_line', 'start_col', 'end_line', 'end_col',
    ]));
  });

  it('cg_references supports caller_symbol_id + target_name', () => {
    ensureSchema(db);
    const cols = db.prepare("PRAGMA table_info('cg_references')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'repo_path', 'file_path', 'caller_symbol_id', 'target_name', 'line', 'col',
    ]));
  });
});
