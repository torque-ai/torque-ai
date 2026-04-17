'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { createTables } = require('../db/schema-tables');
const { runMigrations } = require('../db/migrations');
const { createRepoRegistry } = require('../repo-graph/repo-registry');
const { createMentionResolver } = require('../repo-graph/mention-resolver');

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

describe('repo-graph/mention-resolver', () => {
  let db;
  let reg;
  let resolver;
  let repoDir;
  let tempDirs;

  beforeEach(() => {
    tempDirs = [];
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db, createLogger());
    seedLegacyMigrationTables(db);
    runMigrations(db);

    reg = createRepoRegistry({ db });
    repoDir = makeTempRepo('mention-resolver-');
    tempDirs = [repoDir];

    fs.mkdirSync(path.join(repoDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'server', 'app.js'), 'const x = 1;\n', 'utf8');

    reg.register({ name: 'test-repo', rootPath: repoDir });
    resolver = createMentionResolver({ db, repoRegistry: reg, logger: createLogger() });
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves @file:path to file content', async () => {
    const result = await resolver.resolve([
      { kind: 'file', value: 'server/app.js', raw: '@file:server/app.js' },
    ]);

    expect(result[0].content).toMatch(/const x/);
    expect(result[0].resolved).toBe(true);
  });

  it('resolves @file:repo:path with explicit repo', async () => {
    const result = await resolver.resolve([
      { kind: 'file', value: 'test-repo:server/app.js', raw: '@file:test-repo:server/app.js' },
    ]);

    expect(result[0].resolved).toBe(true);
  });

  it('resolves @symbol:qualifiedName from repo_symbols', async () => {
    const repoId = reg.getByName('test-repo').repo_id;

    db.prepare(`
      INSERT INTO repo_symbols (
        repo_id,
        symbol_id,
        kind,
        name,
        qualified_name,
        file_path,
        body_preview
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(repoId, 's1', 'function', 'hello', 'utils.hello', 'utils.js', 'return hi');

    const result = await resolver.resolve([
      { kind: 'symbol', value: 'utils.hello', raw: '@symbol:utils.hello' },
    ]);

    expect(result[0].resolved).toBe(true);
    expect(result[0].body_preview).toMatch(/hi/);
  });

  it('unresolved mention returns resolved=false + reason', async () => {
    const result = await resolver.resolve([
      { kind: 'file', value: 'missing.js', raw: '@file:missing.js' },
    ]);

    expect(result[0].resolved).toBe(false);
    expect(result[0].reason).toMatch(/not found/i);
  });

  it('url mentions use provided fetcher', async () => {
    const fetcher = vi.fn(async () => 'fetched body');
    const urlResolver = createMentionResolver({
      db,
      repoRegistry: reg,
      urlFetcher: fetcher,
      logger: createLogger(),
    });

    const result = await urlResolver.resolve([
      { kind: 'url', value: 'https://example.com', raw: '@url:https://example.com' },
    ]);

    expect(result[0].content).toBe('fetched body');
    expect(fetcher).toHaveBeenCalled();
  });
});
