import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const providerHealthHistory = require('../db/provider-health-history');

const FIXED_NOW = new Date('2026-03-10T12:00:00.000Z');

function isoDaysAgo(days, hours = 0) {
  return new Date(FIXED_NOW.getTime() - (((days * 24) + hours) * 60 * 60 * 1000)).toISOString();
}

describe('db/provider-health-history', () => {
  let dbModule;
  let db;

  beforeEach(() => {
    ({ db: dbModule } = setupTestDbOnly('provider-health-history'));
    db = dbModule.getDbInstance();
    providerHealthHistory.setDb(db);
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('setDb plus ensureHealthTable creates the provider health history table', () => {
    providerHealthHistory.setDb(db);
    providerHealthHistory.ensureHealthTable();

    const table = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'provider_health_history'
    `).get();
    const providerIndex = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_provider_health_history_provider_window'
    `).get();

    expect(table).toEqual({ name: 'provider_health_history' });
    expect(providerIndex).toEqual({ name: 'idx_provider_health_history_provider_window' });
  });

  it('persistHealthWindow inserts a new record with normalized dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const windowStartInput = '2026-03-01T01:30:00-05:00';
    const windowEndInput = '2026-03-01T02:00:00-05:00';

    const inserted = providerHealthHistory.persistHealthWindow('openai', {
      window_start: windowStartInput,
      window_end: windowEndInput,
      total_checks: 20,
      successes: 18,
      failures: 2,
    });

    const stored = db.prepare(`
      SELECT provider, window_start, window_end, total_checks, successes, failures, failure_rate, created_at, updated_at
      FROM provider_health_history
      WHERE provider = ?
    `).get('openai');

    expect(inserted).toMatchObject({
      provider: 'openai',
      window_start: new Date(windowStartInput).toISOString(),
      window_end: new Date(windowEndInput).toISOString(),
      total_checks: 20,
      successes: 18,
      failures: 2,
      created_at: FIXED_NOW.toISOString(),
      updated_at: FIXED_NOW.toISOString(),
    });
    expect(inserted.failure_rate).toBeCloseTo(0.1, 5);
    expect(stored).toEqual({
      provider: 'openai',
      window_start: new Date(windowStartInput).toISOString(),
      window_end: new Date(windowEndInput).toISOString(),
      total_checks: 20,
      successes: 18,
      failures: 2,
      failure_rate: 0.1,
      created_at: FIXED_NOW.toISOString(),
      updated_at: FIXED_NOW.toISOString(),
    });
  });

  it('persistHealthWindow upserts on the same provider and window_start', () => {
    vi.useFakeTimers();

    const windowStart = '2026-03-09T09:00:00.000Z';
    const firstWriteAt = new Date('2026-03-10T12:00:00.000Z');
    const secondWriteAt = new Date('2026-03-10T13:00:00.000Z');

    vi.setSystemTime(firstWriteAt);
    const original = providerHealthHistory.persistHealthWindow('anthropic', {
      window_start: windowStart,
      window_end: '2026-03-09T09:30:00.000Z',
      total_checks: 10,
      successes: 6,
      failures: 4,
    });

    vi.setSystemTime(secondWriteAt);
    const updated = providerHealthHistory.persistHealthWindow('anthropic', {
      windowStart,
      windowEnd: '2026-03-09T09:45:00.000Z',
      success_count: 7,
      failureCount: 3,
      sampleCount: 10,
    });

    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM provider_health_history
      WHERE provider = ? AND window_start = ?
    `).get('anthropic', windowStart);

    expect(count.count).toBe(1);
    expect(original.created_at).toBe(firstWriteAt.toISOString());
    expect(updated).toMatchObject({
      provider: 'anthropic',
      window_start: windowStart,
      window_end: '2026-03-09T09:45:00.000Z',
      total_checks: 10,
      successes: 7,
      failures: 3,
      created_at: firstWriteAt.toISOString(),
      updated_at: secondWriteAt.toISOString(),
    });
    expect(updated.failure_rate).toBeCloseTo(0.3, 5);
  });

  it('getHealthHistory returns records within the requested date range', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    providerHealthHistory.persistHealthWindow('groq', {
      window_start: isoDaysAgo(8),
      total_checks: 10,
      successes: 7,
      failures: 3,
    });
    providerHealthHistory.persistHealthWindow('groq', {
      window_start: isoDaysAgo(3),
      total_checks: 10,
      successes: 8,
      failures: 2,
    });
    providerHealthHistory.persistHealthWindow('groq', {
      window_start: isoDaysAgo(1, 6),
      total_checks: 10,
      successes: 9,
      failures: 1,
    });
    providerHealthHistory.persistHealthWindow('codex', {
      window_start: isoDaysAgo(2),
      total_checks: 10,
      successes: 1,
      failures: 9,
    });

    const history = providerHealthHistory.getHealthHistory('groq', 5);

    expect(history).toHaveLength(2);
    expect(history.map((row) => row.provider)).toEqual(['groq', 'groq']);
    expect(history.map((row) => row.window_start)).toEqual([
      isoDaysAgo(3),
      isoDaysAgo(1, 6),
    ]);
    expect(history.map((row) => row.failure_rate)).toEqual([0.2, 0.1]);
  });

  it('getHealthHistory returns an empty array for an unknown provider', () => {
    providerHealthHistory.persistHealthWindow('codex', {
      window_start: isoDaysAgo(1),
      total_checks: 10,
      successes: 9,
      failures: 1,
    });

    expect(providerHealthHistory.getHealthHistory('missing-provider', 7)).toEqual([]);
  });

  it('getHealthTrend returns insufficient_data when fewer than two windows exist', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    providerHealthHistory.persistHealthWindow('claude-cli', {
      window_start: isoDaysAgo(2),
      total_checks: 4,
      successes: 3,
      failures: 1,
    });

    const trend = providerHealthHistory.getHealthTrend('claude-cli', 30);

    expect(trend).toEqual({
      provider: 'claude-cli',
      days: 30,
      trend: 'insufficient_data',
      window_count: 1,
      previous_failure_rate: null,
      recent_failure_rate: null,
    });
  });

  it('getHealthTrend returns improving when recent failure rates drop', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    providerHealthHistory.persistHealthWindow('ollama', {
      window_start: isoDaysAgo(12),
      total_checks: 10,
      successes: 5,
      failures: 5,
    });
    providerHealthHistory.persistHealthWindow('ollama', {
      window_start: isoDaysAgo(9),
      total_checks: 10,
      successes: 6,
      failures: 4,
    });
    providerHealthHistory.persistHealthWindow('ollama', {
      window_start: isoDaysAgo(4),
      total_checks: 10,
      successes: 9,
      failures: 1,
    });
    providerHealthHistory.persistHealthWindow('ollama', {
      window_start: isoDaysAgo(1),
      total_checks: 10,
      successes: 10,
      failures: 0,
    });

    const trend = providerHealthHistory.getHealthTrend('ollama', 30);

    expect(trend.trend).toBe('improving');
    expect(trend.window_count).toBe(4);
    expect(trend.previous_failure_rate).toBeCloseTo(0.45, 5);
    expect(trend.recent_failure_rate).toBeCloseTo(0.05, 5);
  });

  it('getHealthTrend returns degrading when recent failure rates rise', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    providerHealthHistory.persistHealthWindow('deepinfra', {
      window_start: isoDaysAgo(12),
      total_checks: 10,
      successes: 10,
      failures: 0,
    });
    providerHealthHistory.persistHealthWindow('deepinfra', {
      window_start: isoDaysAgo(9),
      total_checks: 10,
      successes: 9,
      failures: 1,
    });
    providerHealthHistory.persistHealthWindow('deepinfra', {
      window_start: isoDaysAgo(4),
      total_checks: 10,
      successes: 6,
      failures: 4,
    });
    providerHealthHistory.persistHealthWindow('deepinfra', {
      window_start: isoDaysAgo(1),
      total_checks: 10,
      successes: 5,
      failures: 5,
    });

    const trend = providerHealthHistory.getHealthTrend('deepinfra', 30);

    expect(trend.trend).toBe('degrading');
    expect(trend.window_count).toBe(4);
    expect(trend.previous_failure_rate).toBeCloseTo(0.05, 5);
    expect(trend.recent_failure_rate).toBeCloseTo(0.45, 5);
  });

  it('pruneHealthHistory deletes rows older than the retention window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    providerHealthHistory.persistHealthWindow('codex', {
      window_start: isoDaysAgo(45),
      total_checks: 10,
      successes: 8,
      failures: 2,
    });
    providerHealthHistory.persistHealthWindow('codex', {
      window_start: isoDaysAgo(7),
      total_checks: 10,
      successes: 7,
      failures: 3,
    });
    providerHealthHistory.persistHealthWindow('anthropic', {
      window_start: isoDaysAgo(2),
      total_checks: 10,
      successes: 9,
      failures: 1,
    });

    const deleted = providerHealthHistory.pruneHealthHistory(30);
    const remaining = db.prepare(`
      SELECT provider, window_start
      FROM provider_health_history
      ORDER BY provider, window_start
    `).all();

    expect(deleted).toBe(1);
    expect(remaining).toEqual([
      { provider: 'anthropic', window_start: isoDaysAgo(2) },
      { provider: 'codex', window_start: isoDaysAgo(7) },
    ]);
  });

  it('persistHealthWindow computes failure_rate from successes and failures aliases', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const inserted = providerHealthHistory.persistHealthWindow('google-ai', {
      windowStart: new Date('2026-03-08T08:15:00.000Z'),
      successCount: 8,
      failure_count: 2,
    });

    expect(inserted).toMatchObject({
      provider: 'google-ai',
      window_start: '2026-03-08T08:15:00.000Z',
      window_end: null,
      total_checks: 10,
      successes: 8,
      failures: 2,
    });
    expect(inserted.failure_rate).toBeCloseTo(0.2, 5);
  });
});
