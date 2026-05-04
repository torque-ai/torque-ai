'use strict';

const Database = require('better-sqlite3');

const FIXED_NOW = new Date('2026-03-13T12:00:00.000Z');
const THROUGHPUT_MODULE = require.resolve('../db/throughput-metrics');

let db;
let mod;
let taskCounter = 0;

function rawDb() {
  if (!db) {
    throw new Error('Test database is not initialized');
  }

  return db;
}

function createSchema() {
  rawDb().exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT,
      provider TEXT,
      created_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS providers (
      provider TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      max_concurrent INTEGER DEFAULT 3
    );
  `);
}

function patchTask(taskId, fields) {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return;
  }

  const setClause = entries.map(([key]) => `${key} = ?`).join(', ');
  rawDb().prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(
    ...entries.map(([, value]) => value),
    taskId,
  );
}

function saveProvider(provider, { enabled = true, maxConcurrent = 3 } = {}) {
  rawDb().prepare(`
    INSERT INTO providers (provider, enabled, max_concurrent)
    VALUES (?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      enabled = excluded.enabled,
      max_concurrent = excluded.max_concurrent
  `).run(provider, enabled ? 1 : 0, maxConcurrent);
}

function createTask({
  id,
  status = 'queued',
  provider = 'codex',
  created_at = null,
  completed_at = null,
} = {}) {
  const taskId = id || `throughput-task-${++taskCounter}`;
  rawDb().prepare(`
    INSERT INTO tasks (id, status, provider, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, status, provider, created_at, completed_at);
  return taskId;
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
}

function isoSecondsAfter(isoTimestamp, seconds) {
  return new Date(new Date(isoTimestamp).getTime() + (seconds * 1000)).toISOString();
}

function seedThroughputFixture() {
  saveProvider('codex', { enabled: true, maxConcurrent: 4 });
  saveProvider('ollama', { enabled: true, maxConcurrent: 2 });

  createTask({
    status: 'completed',
    provider: 'codex',
    created_at: isoHoursAgo(0.95),
    completed_at: isoSecondsAfter(isoHoursAgo(0.95), 120),
  });
  createTask({
    status: 'completed',
    provider: 'codex',
    created_at: isoHoursAgo(0.85),
    completed_at: isoSecondsAfter(isoHoursAgo(0.85), 300),
  });
  createTask({
    status: 'completed',
    provider: 'codex',
    created_at: isoHoursAgo(0.75),
    completed_at: isoSecondsAfter(isoHoursAgo(0.75), 180),
  });
  createTask({
    status: 'completed',
    provider: 'ollama',
    created_at: isoHoursAgo(0.65),
    completed_at: isoSecondsAfter(isoHoursAgo(0.65), 60),
  });
  createTask({
    status: 'completed',
    provider: 'ollama',
    created_at: isoHoursAgo(0.55),
    completed_at: isoSecondsAfter(isoHoursAgo(0.55), 120),
  });

  const codexRunningTask = createTask({
    status: 'queued',
    provider: 'codex',
    created_at: isoHoursAgo(0.2),
  });
  patchTask(codexRunningTask, { status: 'running' });

  createTask({
    status: 'running',
    provider: 'ollama',
    created_at: isoHoursAgo(0.1),
  });
}

describe('throughput metrics db module', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    db = new Database(':memory:');
    createSchema();
    delete require.cache[THROUGHPUT_MODULE];
    mod = require('../db/throughput-metrics');
    mod.setDb(db);
    taskCounter = 0;
  });

  afterEach(() => {
    if (mod && typeof mod.setDb === 'function') {
      mod.setDb(null);
    }
    delete require.cache[THROUGHPUT_MODULE];

    if (db) {
      db.close();
      db = null;
    }

    vi.useRealTimers();
  });

  it('getTasksPerHour returns correct total and per-provider breakdown', () => {
    seedThroughputFixture();

    const result = mod.getTasksPerHour(1);

    expect(result).toEqual({
      total: 5,
      perHour: 5,
      byProvider: {
        codex: 3,
        ollama: 2,
      },
    });
  });

  it('getProviderUtilization returns utilization percentages', () => {
    seedThroughputFixture();

    const result = mod.getProviderUtilization(1);

    expect(result).toEqual({
      providers: [
        { provider: 'codex', running: 1, maxConcurrent: 4, utilization: 25 },
        { provider: 'ollama', running: 1, maxConcurrent: 2, utilization: 50 },
      ],
    });
  });

  it('getAverageDuration returns correct averages', () => {
    seedThroughputFixture();

    const result = mod.getAverageDuration(1);

    expect(result.overall).toBeCloseTo(156, 5);
    expect(result.byProvider.codex).toBeCloseTo(200, 5);
    expect(result.byProvider.ollama).toBeCloseTo(90, 5);
    expect(Object.keys(result.byProvider)).toEqual(['codex', 'ollama']);
  });

  it('getThroughputSummary combines all metrics', () => {
    seedThroughputFixture();

    const summary = mod.getThroughputSummary(1);

    expect(summary).toEqual({
      tasksPerHour: {
        total: 5,
        perHour: 5,
        byProvider: {
          codex: 3,
          ollama: 2,
        },
      },
      providerUtilization: {
        providers: [
          { provider: 'codex', running: 1, maxConcurrent: 4, utilization: 25 },
          { provider: 'ollama', running: 1, maxConcurrent: 2, utilization: 50 },
        ],
      },
      averageDuration: {
        overall: 156,
        byProvider: {
          codex: 200,
          ollama: 90,
        },
      },
    });
  });

  it('empty database returns zeroes, not errors', () => {
    expect(mod.getTasksPerHour(1)).toEqual({
      total: 0,
      perHour: 0,
      byProvider: {},
    });

    expect(mod.getProviderUtilization(1)).toEqual({
      providers: [],
    });

    expect(mod.getAverageDuration(1)).toEqual({
      overall: 0,
      byProvider: {},
    });

    expect(mod.getThroughputSummary(1)).toEqual({
      tasksPerHour: {
        total: 0,
        perHour: 0,
        byProvider: {},
      },
      providerUtilization: {
        providers: [],
      },
      averageDuration: {
        overall: 0,
        byProvider: {},
      },
    });
  });

  it('throws a database-unavailable error when no db is injected', () => {
    mod.setDb(null);

    expect(() => mod.getTasksPerHour(1)).toThrow('Database instance is not available');
  });

  it('restores metric reads after re-injecting a db', () => {
    seedThroughputFixture();
    mod.setDb(null);

    expect(() => mod.getTasksPerHour(1)).toThrow('Database instance is not available');

    mod.setDb(db);
    expect(mod.getTasksPerHour(1)).toEqual({
      total: 5,
      perHour: 5,
      byProvider: {
        codex: 3,
        ollama: 2,
      },
    });
  });
});
