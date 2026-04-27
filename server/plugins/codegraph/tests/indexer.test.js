'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { runIndex, runIncrementalIndex } = require('../indexer');
const { languageFor } = require('../extractors');

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

  describe('runIncrementalIndex', () => {
    // Synthetic readFileAtSha: returns the contents stored in `files` map.
    // Simulates `git show <sha>:<path>` without touching git for these unit
    // tests. The integration path is exercised end-to-end via index-runner.
    function makeReader(files) {
      return (filePath) => {
        if (!(filePath in files)) {
          const err = new Error(`fatal: path '${filePath}' does not exist`);
          throw err;
        }
        return Buffer.from(files[filePath]);
      };
    }

    async function seed(repoPath) {
      // Initial state: 3 files, full reindex via fixture.
      await runIndex({
        db, repoPath, files: ['a.js', 'b.js'], commitSha: 'sha-1',
      });
    }

    it('replaces rows for modified files only', async () => {
      await seed(FIXTURE);

      const result = await runIncrementalIndex({
        db, repoPath: FIXTURE,
        fromSha: 'sha-1', toSha: 'sha-2',
        added: [], modified: ['a.js'], deleted: [],
        readFileAtSha: makeReader({ 'a.js': 'function alphaPrime() { return 42; }\n' }),
        languageFor,
      });

      expect(result.incremental).toBe(true);
      expect(result.files_modified).toBe(1);
      expect(result.from_sha).toBe('sha-1');
      expect(result.to_sha).toBe('sha-2');

      const names = db.prepare(
        "SELECT name FROM cg_symbols WHERE repo_path = ? ORDER BY name"
      ).all(FIXTURE).map((r) => r.name);
      // a.js originally has [alpha, gamma]; replaced contents have only alphaPrime.
      // b.js's symbols (beta, delta) are untouched by the modify-a.js path.
      expect(names).toEqual(['alphaPrime', 'beta', 'delta']);
    });

    it('removes rows for deleted files', async () => {
      await seed(FIXTURE);

      await runIncrementalIndex({
        db, repoPath: FIXTURE,
        fromSha: 'sha-1', toSha: 'sha-2',
        added: [], modified: [], deleted: ['b.js'],
        readFileAtSha: makeReader({}),  // no files needed; nothing to extract
        languageFor,
      });

      const names = db.prepare(
        "SELECT name FROM cg_symbols WHERE repo_path = ? ORDER BY name"
      ).all(FIXTURE).map((r) => r.name);
      // a.js's symbols [alpha, gamma] survive; b.js's [beta, delta] gone.
      expect(names).toEqual(['alpha', 'gamma']);
      const fileRows = db.prepare(
        "SELECT file_path FROM cg_files WHERE repo_path = ?"
      ).all(FIXTURE).map((r) => r.file_path);
      expect(fileRows).toEqual(['a.js']);
    });

    it('inserts rows for added files', async () => {
      await seed(FIXTURE);

      await runIncrementalIndex({
        db, repoPath: FIXTURE,
        fromSha: 'sha-1', toSha: 'sha-2',
        added: ['c.js'], modified: [], deleted: [],
        readFileAtSha: makeReader({ 'c.js': 'function epsilon() { return 99; }\n' }),
        languageFor,
      });

      const names = db.prepare(
        "SELECT name FROM cg_symbols WHERE repo_path = ? ORDER BY name"
      ).all(FIXTURE).map((r) => r.name);
      expect(names).toContain('epsilon');
    });

    it('updates cg_index_state with new sha and recomputed totals', async () => {
      await seed(FIXTURE);

      await runIncrementalIndex({
        db, repoPath: FIXTURE,
        fromSha: 'sha-1', toSha: 'sha-2',
        added: [], modified: [], deleted: ['b.js'],
        readFileAtSha: makeReader({}),
        languageFor,
      });

      const state = db.prepare(
        "SELECT commit_sha, files, symbols FROM cg_index_state WHERE repo_path = ?"
      ).get(FIXTURE);
      expect(state.commit_sha).toBe('sha-2');
      expect(state.files).toBe(1);     // only a.js left
      expect(state.symbols).toBe(2);   // alpha + gamma (a.js content)
    });

    it('handles renames as delete-old + add-new', async () => {
      await seed(FIXTURE);

      await runIncrementalIndex({
        db, repoPath: FIXTURE,
        fromSha: 'sha-1', toSha: 'sha-2',
        // git --name-status -M decomposed the rename into these.
        added: ['renamed.js'], modified: [], deleted: ['a.js'],
        readFileAtSha: makeReader({ 'renamed.js': 'function alpha() { return beta(); }\n' }),
        languageFor,
      });

      const fileRows = db.prepare(
        "SELECT file_path FROM cg_files WHERE repo_path = ? ORDER BY file_path"
      ).all(FIXTURE).map((r) => r.file_path);
      expect(fileRows).toEqual(['b.js', 'renamed.js']);
    });

    it('skips non-indexable files in added/modified', async () => {
      await seed(FIXTURE);

      const result = await runIncrementalIndex({
        db, repoPath: FIXTURE,
        fromSha: 'sha-1', toSha: 'sha-2',
        added: ['README.md'], modified: ['package.json'], deleted: [],
        readFileAtSha: makeReader({ 'README.md': '# x\n', 'package.json': '{}\n' }),
        languageFor,
      });
      // Neither indexable; toExtract is empty; no rows added.
      expect(result.files_added).toBe(0);
      expect(result.files_modified).toBe(0);
    });

    it('records skipped files when readFileAtSha throws', async () => {
      await seed(FIXTURE);

      const result = await runIncrementalIndex({
        db, repoPath: FIXTURE,
        fromSha: 'sha-1', toSha: 'sha-2',
        added: ['ghost.js'], modified: [], deleted: [],
        readFileAtSha: makeReader({}),  // ghost.js missing → throws
        languageFor,
      });
      expect(result.skipped).toEqual([
        expect.objectContaining({ file: 'ghost.js', reason: 'read' }),
      ]);
    });
  });

  it('skips unreadable files and continues indexing', async () => {
    const result = await runIndex({
      db,
      repoPath: FIXTURE,
      files: ['a.js', 'does-not-exist.js', 'b.js'],
    });
    expect(result.files).toBe(2);
    expect(result.skipped).toEqual([
      expect.objectContaining({ file: 'does-not-exist.js', reason: 'read' }),
    ]);
    const names = db.prepare(
      "SELECT name FROM cg_symbols WHERE repo_path = ? ORDER BY name"
    ).all(FIXTURE).map((r) => r.name);
    expect(names).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });
});
