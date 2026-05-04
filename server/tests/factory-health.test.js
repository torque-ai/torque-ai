import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';

const path = require('path');
const Database = require('better-sqlite3');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const factoryHealth = require('../db/factory/health');

let testDir;

describe('factory health database handle', () => {
  beforeEach(() => {
    ({ testDir } = setupTestDbOnly(`factory-health-${Date.now()}`));
  });

  afterEach(() => {
    factoryHealth.setDb(null);
    teardownTestDb();
  });

  test('falls back to the active database module when its module handle is cleared', () => {
    factoryHealth.setDb(null);

    const project = factoryHealth.registerProject({
      name: 'Fallback DB',
      path: path.join(testDir, 'repo'),
      trust_level: 'supervised',
    });

    expect(factoryHealth.getProject(project.id)).toMatchObject({
      id: project.id,
      name: 'Fallback DB',
    });
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
