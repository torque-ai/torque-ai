import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';

const path = require('path');
const Database = require('better-sqlite3');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const factoryHealth = require('../db/factory/health');

let database;
let testDir;

function primeModuleCache(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

describe('factory health database handle', () => {
  beforeEach(() => {
    ({ db: database, testDir } = setupTestDbOnly(`factory-health-${Date.now()}`));
  });

  afterEach(() => {
    factoryHealth.setDb(null);
    database = null;
    delete require.cache[require.resolve('../container')];
    teardownTestDb();
  });

  test('uses the registered container database when its module handle is cleared before boot', () => {
    factoryHealth.setDb(null);
    const defaultContainer = {
      peek: vi.fn((name) => (name === 'db' ? database : undefined)),
      has: vi.fn(() => false),
      get: vi.fn(() => {
        throw new Error('defaultContainer.get called before boot()');
      }),
    };
    primeModuleCache('../container', { defaultContainer });

    const project = factoryHealth.registerProject({
      name: 'Container DB',
      path: path.join(testDir, 'repo'),
      trust_level: 'supervised',
    });

    expect(factoryHealth.getProject(project.id)).toMatchObject({
      id: project.id,
      name: 'Container DB',
    });
    expect(defaultContainer.peek).toHaveBeenCalledWith('db');
    expect(defaultContainer.get).not.toHaveBeenCalled();
  });

  test('does not fall back to the active database module when DI is unavailable', () => {
    factoryHealth.setDb(null);
    const defaultContainer = {
      peek: vi.fn(() => undefined),
      has: vi.fn(() => false),
      get: vi.fn(() => {
        throw new Error('defaultContainer.get called before boot()');
      }),
    };
    primeModuleCache('../container', { defaultContainer });

    expect(() => factoryHealth.registerProject({
      name: 'No DI DB',
      path: path.join(testDir, 'repo'),
      trust_level: 'supervised',
    })).toThrow('Factory health requires an active database connection');
  });
});

describe('getLatestScoresBatch', () => {
  let memDb;

  beforeEach(() => {
    memDb = new Database(':memory:');
    memDb.exec(
      'CREATE TABLE factory_health_snapshots (' +
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      '  project_id TEXT NOT NULL,' +
      '  dimension TEXT NOT NULL,' +
      '  score REAL NOT NULL,' +
      "  created_at TEXT DEFAULT (datetime('now'))" +
      ')'
    );
    factoryHealth.setDb(memDb);
  });

  afterEach(() => {
    factoryHealth.setDb(null);
    memDb.close();
  });

  it('returns a Map keyed by project_id with latest score per dimension', () => {
    memDb.prepare(
      'INSERT INTO factory_health_snapshots (project_id, dimension, score) VALUES (?, ?, ?)'
    ).run('proj-1', 'quality', 0.8);
    memDb.prepare(
      'INSERT INTO factory_health_snapshots (project_id, dimension, score) VALUES (?, ?, ?)'
    ).run('proj-1', 'quality', 0.9);
    memDb.prepare(
      'INSERT INTO factory_health_snapshots (project_id, dimension, score) VALUES (?, ?, ?)'
    ).run('proj-2', 'velocity', 0.5);

    const result = factoryHealth.getLatestScoresBatch(['proj-1', 'proj-2']);

    expect(result).toBeInstanceOf(Map);
    expect(result.get('proj-1')?.quality).toBeCloseTo(0.9, 4);
    expect(result.get('proj-2')?.velocity).toBeCloseTo(0.5, 4);
  });

  it('returns empty Map for empty input', () => {
    const result = factoryHealth.getLatestScoresBatch([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('returns empty Map for unknown project ids', () => {
    const result = factoryHealth.getLatestScoresBatch(['no-such-project']);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});

describe('getScoreHistoryBatch', () => {
  let memDb;

  beforeEach(() => {
    memDb = new Database(':memory:');
    memDb.exec(
      'CREATE TABLE factory_health_snapshots (' +
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      '  project_id TEXT NOT NULL,' +
      '  dimension TEXT NOT NULL,' +
      '  score REAL NOT NULL,' +
      "  created_at TEXT DEFAULT (datetime('now'))" +
      ')'
    );
    factoryHealth.setDb(memDb);
  });

  afterEach(() => {
    factoryHealth.setDb(null);
    memDb.close();
  });

  it('returns history keyed by dimension, newest first, up to limit', () => {
    for (let i = 0; i < 5; i++) {
      memDb.prepare(
        'INSERT INTO factory_health_snapshots (project_id, dimension, score) VALUES (?, ?, ?)'
      ).run('proj-1', 'quality', i * 0.1);
      memDb.prepare(
        'INSERT INTO factory_health_snapshots (project_id, dimension, score) VALUES (?, ?, ?)'
      ).run('proj-1', 'velocity', i * 0.2);
    }

    const result = factoryHealth.getScoreHistoryBatch('proj-1', ['quality', 'velocity'], 3);

    expect(result).toHaveProperty('quality');
    expect(result).toHaveProperty('velocity');
    expect(result.quality).toHaveLength(3);
    expect(result.velocity).toHaveLength(3);
    // Newest first — highest id = highest score (i=4 gives 0.4)
    expect(result.quality[0].score).toBeCloseTo(0.4, 4);
  });

  it('returns empty arrays for dimensions with no data', () => {
    const result = factoryHealth.getScoreHistoryBatch('no-project', ['quality'], 10);
    expect(result.quality).toEqual([]);
  });
});
