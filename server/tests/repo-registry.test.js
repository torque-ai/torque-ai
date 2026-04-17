'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { describe, it, expect, beforeEach, afterEach } = require('vitest');

const { createTables } = require('../db/schema-tables');
const { runMigrations } = require('../db/migrations');
const { createRepoRegistry } = require('../repo-graph/repo-registry');

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function makeTempRepo(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('repo-graph/repo-registry', () => {
  let db;
  let registry;
  let tempDirs;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db, createLogger());
    runMigrations(db);
    registry = createRepoRegistry({ db });
    tempDirs = [];
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('register is idempotent by repo name', () => {
    const firstRoot = makeTempRepo('repo-registry-a-');
    const secondRoot = makeTempRepo('repo-registry-b-');
    tempDirs.push(firstRoot, secondRoot);

    const first = registry.register({
      name: 'torque-public',
      rootPath: firstRoot,
      remoteUrl: 'https://example.com/torque-public.git',
    });
    const second = registry.register({
      name: 'torque-public',
      rootPath: secondRoot,
      remoteUrl: 'https://example.com/renamed.git',
    });

    expect(second.repo_id).toBe(first.repo_id);
    expect(second.root_path).toBe(firstRoot);
    expect(registry.list()).toHaveLength(1);
  });

  it('unregister deletes the repo and cascades repo_symbols', () => {
    const repoRoot = makeTempRepo('repo-registry-cascade-');
    tempDirs.push(repoRoot);

    const repo = registry.register({
      name: 'torque-core',
      rootPath: repoRoot,
    });

    db.prepare(`
      INSERT INTO repo_symbols (
        repo_id,
        symbol_id,
        kind,
        name,
        qualified_name,
        file_path,
        start_line,
        end_line,
        body_preview
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      repo.repo_id,
      'sym-1',
      'function',
      'hello',
      'utils.hello',
      'utils.js',
      1,
      2,
      'return "hi";',
    );

    expect(registry.unregister(repo.repo_id)).toBe(true);
    expect(registry.get(repo.repo_id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM repo_symbols').get().count).toBe(0);
  });

  it('list orders repos by name', () => {
    const betaRoot = makeTempRepo('repo-registry-beta-');
    const alphaRoot = makeTempRepo('repo-registry-alpha-');
    tempDirs.push(betaRoot, alphaRoot);

    registry.register({ name: 'zeta', rootPath: betaRoot });
    registry.register({ name: 'alpha', rootPath: alphaRoot });

    expect(registry.list().map((repo) => repo.name)).toEqual(['alpha', 'zeta']);
  });

  it('markIndexed updates the repo timestamp', () => {
    const repoRoot = makeTempRepo('repo-registry-indexed-');
    tempDirs.push(repoRoot);

    const repo = registry.register({ name: 'indexed-repo', rootPath: repoRoot });
    expect(repo.last_indexed_at).toBeNull();

    const updated = registry.markIndexed(repo.repo_id, '2026-04-16T12:34:56.000Z');

    expect(updated.last_indexed_at).toBe('2026-04-16T12:34:56.000Z');
    expect(registry.get(repo.repo_id).lastIndexedAt).toBe('2026-04-16T12:34:56.000Z');
  });
});
