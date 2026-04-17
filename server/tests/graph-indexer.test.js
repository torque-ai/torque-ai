'use strict';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { createTables } = require('../db/schema-tables');
const { runMigrations } = require('../db/migrations');
const { createRepoRegistry } = require('../repo-graph/repo-registry');
const { createGraphIndexer } = require('../repo-graph/graph-indexer');

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

function seedLegacyMigrationTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_family_templates (
      family TEXT PRIMARY KEY,
      tuning_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS model_registry (
      model_name TEXT PRIMARY KEY,
      status TEXT DEFAULT 'pending'
    );
  `);
}

describe('repo-graph/graph-indexer', () => {
  let db;
  let registry;
  let graphIndexer;
  let tempDirs;

  beforeEach(() => {
    tempDirs = [];
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db, createLogger());
    seedLegacyMigrationTables(db);
    runMigrations(db);
    registry = createRepoRegistry({ db });
    graphIndexer = createGraphIndexer({ db, repoRegistry: registry, logger: createLogger() });
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('indexRepo stores repo symbols with qualified names and updates last_indexed_at', async () => {
    const repoRoot = makeTempRepo('graph-indexer-one-');
    tempDirs.push(repoRoot);

    fs.writeFileSync(path.join(repoRoot, 'utils.js'), 'export function hello() {\n  return "hi";\n}\n', 'utf8');
    fs.mkdirSync(path.join(repoRoot, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'node_modules', 'ignored.js'), 'export function ignored() {}', 'utf8');

    const repo = registry.register({ name: 'graph-fixture', rootPath: repoRoot });
    const result = await graphIndexer.indexRepo(repo.repo_id);
    const rows = db.prepare(`
      SELECT *
      FROM repo_symbols
      WHERE repo_id = ?
      ORDER BY qualified_name
    `).all(repo.repo_id);

    expect(result.repo_id).toBe(repo.repo_id);
    expect(result.files_scanned).toBe(1);
    expect(result.total_symbols).toBeGreaterThanOrEqual(1);
    expect(result.last_indexed_at).toEqual(expect.any(String));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'function',
          name: 'hello',
          qualified_name: 'utils.hello',
          file_path: 'utils.js',
          body_preview: expect.stringContaining('return "hi";'),
        }),
      ]),
    );
  });

  it('indexRepo replaces stale symbols on reindex', async () => {
    const repoRoot = makeTempRepo('graph-indexer-two-');
    tempDirs.push(repoRoot);

    const filePath = path.join(repoRoot, 'utils.js');
    fs.writeFileSync(filePath, 'export function hello() {\n  return "hi";\n}\n', 'utf8');

    const repo = registry.register({ name: 'replace-fixture', rootPath: repoRoot });
    await graphIndexer.indexRepo(repo.repo_id);

    fs.writeFileSync(filePath, 'export function goodbye() {\n  return "bye";\n}\n', 'utf8');
    await graphIndexer.indexRepo(repo.repo_id);

    const qualifiedNames = db.prepare(`
      SELECT qualified_name
      FROM repo_symbols
      WHERE repo_id = ?
      ORDER BY qualified_name
    `).all(repo.repo_id).map((row) => row.qualified_name);

    expect(qualifiedNames).toContain('utils.goodbye');
    expect(qualifiedNames).not.toContain('utils.hello');
  });

  it('indexAll indexes every registered repo', async () => {
    const firstRoot = makeTempRepo('graph-indexer-three-');
    const secondRoot = makeTempRepo('graph-indexer-four-');
    tempDirs.push(firstRoot, secondRoot);

    fs.writeFileSync(path.join(firstRoot, 'alpha.js'), 'export function alpha() { return 1; }\n', 'utf8');
    fs.writeFileSync(path.join(secondRoot, 'beta.js'), 'export function beta() { return 2; }\n', 'utf8');

    registry.register({ name: 'alpha-repo', rootPath: firstRoot });
    registry.register({ name: 'beta-repo', rootPath: secondRoot });

    const result = await graphIndexer.indexAll();
    const distinctRepoCount = db.prepare('SELECT COUNT(DISTINCT repo_id) AS count FROM repo_symbols').get().count;

    expect(result.repo_count).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.total_symbols).toBeGreaterThanOrEqual(2);
    expect(distinctRepoCount).toBe(2);
  });
});
