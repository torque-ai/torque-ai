'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { runIndex } = require('../indexer');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'tiny-repo');

describe('codegraph indexer', () => {
  let db;

  beforeEach(() => { db = new Database(':memory:'); ensureSchema(db); });
  afterEach(() => db.close());

  it('indexes the fixture repo and writes cg_files rows', async () => {
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
    const rows = db.prepare(
      "SELECT file_path FROM cg_files WHERE repo_path = ? ORDER BY file_path"
    ).all(FIXTURE);
    expect(rows.map((r) => r.file_path)).toEqual(['a.js', 'b.js']);
  });

  it('writes cg_symbols rows for every function in the fixture', async () => {
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
    const names = db.prepare(
      "SELECT name FROM cg_symbols WHERE repo_path = ? ORDER BY name"
    ).all(FIXTURE).map((r) => r.name);
    expect(names).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });

  it('writes cg_references rows linked to caller_symbol_id', async () => {
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
    const refs = db.prepare(`
      SELECT s.name AS caller, r.target_name AS target
      FROM cg_references r
      JOIN cg_symbols s ON s.id = r.caller_symbol_id
      WHERE r.repo_path = ?
      ORDER BY caller, target
    `).all(FIXTURE);
    expect(refs).toEqual([
      { caller: 'alpha', target: 'beta' },
      { caller: 'delta', target: 'beta' },
      { caller: 'gamma', target: 'alpha' },
    ]);
  });

  it('updates cg_index_state with file/symbol/reference counts', async () => {
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'], commitSha: 'abc123' });
    const state = db.prepare("SELECT * FROM cg_index_state WHERE repo_path = ?").get(FIXTURE);
    expect(state.commit_sha).toBe('abc123');
    expect(state.files).toBe(2);
    expect(state.symbols).toBe(4);
    expect(state.references_count).toBe(3);
  });

  it('is idempotent: re-running on the same files replaces rows, no duplicates', async () => {
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
    await runIndex({ db, repoPath: FIXTURE, files: ['a.js', 'b.js'] });
    const count = db.prepare(
      "SELECT COUNT(*) AS n FROM cg_symbols WHERE repo_path = ?"
    ).get(FIXTURE).n;
    expect(count).toBe(4);
  });
});
