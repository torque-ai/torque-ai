'use strict';

const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');

describe('codegraph schema', () => {
  let db;

  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => db.close());

  it('creates cg_files, cg_symbols, cg_references, cg_index_state, cg_dispatch_edges, cg_class_edges tables', () => {
    ensureSchema(db);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cg_%'"
    ).all().map((r) => r.name).sort();
    expect(tables).toEqual([
      'cg_class_edges',
      'cg_dispatch_edges',
      'cg_files',
      'cg_index_state',
      'cg_references',
      'cg_symbols',
    ]);
  });

  it('cg_symbols has is_exported column', () => {
    ensureSchema(db);
    const cols = db.prepare("PRAGMA table_info('cg_symbols')").all().map((c) => c.name);
    expect(cols).toContain('is_exported');
  });

  it('cg_dispatch_edges has case_string + handler_name columns', () => {
    ensureSchema(db);
    const cols = db.prepare("PRAGMA table_info('cg_dispatch_edges')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['case_string', 'handler_name', 'file_path', 'line']));
  });

  it('migrates is_exported column onto an existing pre-migration cg_symbols', () => {
    // Simulate an old schema: cg_symbols without is_exported.
    db.prepare(`
      CREATE TABLE cg_symbols (
        id INTEGER PRIMARY KEY, repo_path TEXT, file_path TEXT, name TEXT, kind TEXT,
        start_line INTEGER, start_col INTEGER, end_line INTEGER, end_col INTEGER
      )
    `).run();
    ensureSchema(db);
    const cols = db.prepare("PRAGMA table_info('cg_symbols')").all().map((c) => c.name);
    expect(cols).toContain('is_exported');
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
