'use strict';
/* global describe, it, expect, beforeEach, afterEach */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createSharedFactoryStore,
  resolveSharedFactoryDbPath,
  SHARED_FACTORY_DB_ENV,
  SHARED_FACTORY_DB_CONFIG_KEY,
  DEFAULT_SHARED_FACTORY_DB_FILENAME,
} = require('../db/shared-factory-store');

describe('shared-factory-store', () => {
  let tempDir;
  let stores;
  let originalEnvPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-shared-factory-'));
    stores = [];
    originalEnvPath = process.env[SHARED_FACTORY_DB_ENV];
    delete process.env[SHARED_FACTORY_DB_ENV];
  });

  afterEach(() => {
    for (const store of stores) {
      try { store.close(); } catch {}
    }
    if (originalEnvPath === undefined) {
      delete process.env[SHARED_FACTORY_DB_ENV];
    } else {
      process.env[SHARED_FACTORY_DB_ENV] = originalEnvPath;
    }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  function openStore(dbPath) {
    const store = createSharedFactoryStore({ dbPath });
    stores.push(store);
    return store;
  }

  it('resolves path by env, config key, then user data default', () => {
    const envPath = path.join(tempDir, 'env.db');
    process.env[SHARED_FACTORY_DB_ENV] = envPath;
    expect(resolveSharedFactoryDbPath({
      config: { get: () => path.join(tempDir, 'config.db') },
      dataDir: tempDir,
    })).toBe(path.resolve(envPath));

    delete process.env[SHARED_FACTORY_DB_ENV];
    const configPath = path.join(tempDir, 'config.db');
    expect(resolveSharedFactoryDbPath({
      config: { get: (key) => (key === SHARED_FACTORY_DB_CONFIG_KEY ? configPath : null) },
      dataDir: tempDir,
    })).toBe(path.resolve(configPath));

    expect(resolveSharedFactoryDbPath({ dataDir: tempDir })).toBe(
      path.join(tempDir, DEFAULT_SHARED_FACTORY_DB_FILENAME),
    );
  });

  it('creates the shared WAL-backed schemas outside the project-local database', () => {
    const store = openStore(path.join(tempDir, 'shared.db'));
    const db = store.getDbInstance();

    expect(store.getDbPath()).toBe(path.join(tempDir, 'shared.db'));
    expect(db.pragma('journal_mode', { simple: true }).toLowerCase()).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBeGreaterThan(0);

    const learningColumns = db.prepare("PRAGMA table_info('factory_learnings')").all().map((column) => column.name);
    expect(learningColumns).toEqual(expect.arrayContaining([
      'provider',
      'tech_stack',
      'failure_pattern',
      'confidence',
      'sample_count',
      'project_source',
      'payload_json',
      'last_seen_at',
      'expires_at',
    ]));

    const claimColumns = db.prepare("PRAGMA table_info('factory_resource_claims')").all().map((column) => column.name);
    expect(claimColumns).toEqual(expect.arrayContaining([
      'project_id',
      'provider',
      'task_id',
      'claimed_at',
      'expires_at',
    ]));
  });

  it('lets independent store instances observe shared learning writes', () => {
    const dbPath = path.join(tempDir, 'shared.db');
    const first = openStore(dbPath);
    const second = openStore(dbPath);

    first.upsertLearning({
      // Pin the upsert's wall-clock to a value strictly before
      // `expires_at`. upsertLearningTxn calls expireStaleRowsNow with
      // this value, and without an explicit `now` it falls back to
      // Date.now(). Any test run after 2026-04-30T10:00Z would expire
      // the row before the downstream getLearning observes it.
      now: '2026-04-29T10:00:00.000Z',
      provider: 'codex',
      tech_stack: 'node',
      failure_pattern: 'verify-timeout',
      confidence: 0.75,
      sample_count: 2,
      project_source: 'torque-public',
      payload: { command: 'npm test' },
      last_seen_at: '2026-04-29T10:00:00.000Z',
      expires_at: '2026-04-30T10:00:00.000Z',
    });

    const row = second.getLearning({
      provider: 'codex',
      tech_stack: 'node',
      failure_pattern: 'verify-timeout',
    });

    expect(row).toMatchObject({
      provider: 'codex',
      tech_stack: 'node',
      failure_pattern: 'verify-timeout',
      confidence: 0.75,
      sample_count: 2,
      project_source: 'torque-public',
    });
    expect(JSON.parse(row.payload_json)).toEqual({ command: 'npm test' });
  });

  it('upserts learning rows transactionally and increments sample counts', () => {
    const store = openStore(path.join(tempDir, 'shared.db'));
    const key = {
      provider: 'ollama',
      tech_stack: 'dotnet',
      failure_pattern: 'missing-sdk',
      project_source: 'SpudgetBooks',
      expires_at: '2026-05-01T00:00:00.000Z',
      // Same pin as the case above — upsertLearningTxn's
      // expireStaleRowsNow sweep would otherwise delete the first row
      // on the second upsert, turning the increment-by-3 into a fresh
      // INSERT once the wall-clock crosses expires_at.
      now: '2026-04-30T10:00:00.000Z',
    };

    store.upsertLearning({ ...key, confidence: 0.4, sample_count: 1, payload: { first: true } });
    const updated = store.upsertLearning({ ...key, confidence: 0.9, sample_count: 3, payload: { second: true } });

    expect(updated.sample_count).toBe(4);
    expect(updated.confidence).toBe(0.9);
    expect(JSON.parse(updated.payload_json)).toEqual({ second: true });
  });

  it('shares resource claims between independent instances and filters expired claims', () => {
    const dbPath = path.join(tempDir, 'shared.db');
    const first = openStore(dbPath);
    const second = openStore(dbPath);

    const claim = first.claimResource({
      project_id: 'torque-public',
      provider: 'codex',
      task_id: 'task-123',
      claimed_by: 'factory-a',
      claimed_at: '2026-04-29T10:00:00.000Z',
      expires_at: '2026-04-29T10:30:00.000Z',
    });

    expect(second.getResourceClaim(claim.id)).toMatchObject({
      project_id: 'torque-public',
      provider: 'codex',
      task_id: 'task-123',
      status: 'active',
    });

    expect(second.listResourceClaims({
      provider: 'codex',
      now: '2026-04-29T10:10:00.000Z',
    })).toHaveLength(1);

    second.expireStaleRows('2026-04-29T10:31:00.000Z');

    expect(first.listResourceClaims({
      provider: 'codex',
      now: '2026-04-29T10:31:00.000Z',
    })).toHaveLength(0);
    expect(first.getResourceClaim(claim.id).status).toBe('expired');
  });

  it('expires stale learning rows with TTL cleanup', () => {
    const store = openStore(path.join(tempDir, 'shared.db'));
    store.upsertLearning({
      provider: 'groq',
      tech_stack: 'node',
      failure_pattern: 'rate-limit',
      confidence: 0.5,
      sample_count: 1,
      project_source: 'SpudgetBooks',
      expires_at: '2026-04-29T09:00:00.000Z',
    });

    expect(store.expireStaleRows('2026-04-29T10:00:00.000Z').learnings).toBe(1);
    expect(store.listLearnings({ includeExpired: true })).toHaveLength(0);
  });
});
