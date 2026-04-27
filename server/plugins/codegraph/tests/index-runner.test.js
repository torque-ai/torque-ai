'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../schema');
const { indexRepoAtHead, getIndexState } = require('../index-runner');
const { setupTinyRepo, destroyTinyRepo } = require('../test-helpers');

describe('codegraph index-runner', () => {
  let db;
  let repo;

  beforeEach(() => { db = new Database(':memory:'); ensureSchema(db); repo = setupTinyRepo(); });
  afterEach(() => { db.close(); destroyTinyRepo(repo); });

  it('indexes the repo at HEAD and reports state', async () => {
    const result = await indexRepoAtHead({ db, repoPath: repo });
    expect(result.files).toBe(2);
    expect(result.symbols).toBe(2);
    expect(result.references).toBe(1);
    const state = getIndexState({ db, repoPath: repo });
    expect(state.commitSha.length).toBe(40);
  });

  it('skips re-indexing when commit_sha is unchanged', async () => {
    await indexRepoAtHead({ db, repoPath: repo });
    const result = await indexRepoAtHead({ db, repoPath: repo });
    expect(result.skipped).toBe(true);
  });

  it('re-indexes when force=true even if commit unchanged', async () => {
    await indexRepoAtHead({ db, repoPath: repo });
    const result = await indexRepoAtHead({ db, repoPath: repo, force: true });
    expect(result.skipped).toBeUndefined();
    expect(result.files).toBe(2);
  });

  it('only reads HEAD; ignores dirty worktree files', async () => {
    fs.writeFileSync(path.join(repo, 'a.js'),
      'function alpha() { return broken_after_index(); }\n');
    await indexRepoAtHead({ db, repoPath: repo });
    const targets = db.prepare(
      "SELECT target_name FROM cg_references WHERE repo_path = ?"
    ).all(repo).map((r) => r.target_name);
    expect(targets).toContain('beta');
    expect(targets).not.toContain('broken_after_index');
  });
});
