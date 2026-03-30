const { setupE2eDb, resetE2eDb, teardownE2eDb } = require('./e2e-helpers');
const healthHistory = require('../db/provider-routing-core');

const FIXED_NOW = new Date('2026-03-08T12:00:00.000Z');

let ctx;

function rawDb() {
  return ctx.db.getDb ? ctx.db.getDb() : ctx.db.getDbInstance();
}

function bindModule() {
  healthHistory.setDb(rawDb());
}

function isoHoursAgo(hoursAgo) {
  return new Date(FIXED_NOW.getTime() - (hoursAgo * 60 * 60 * 1000)).toISOString();
}

function isoHoursAfter(hoursAgo, minutesAfter = 30) {
  return new Date(
    FIXED_NOW.getTime() - (hoursAgo * 60 * 60 * 1000) + (minutesAfter * 60 * 1000)
  ).toISOString();
}

function persistWindow(provider, hoursAgo, overrides = {}) {
  const failures = overrides.failures ?? 2;
  const totalChecks = overrides.total_checks ?? 10;
  const successes = overrides.successes ?? Math.max(0, totalChecks - failures);
  const failureRate = overrides.failure_rate ?? (totalChecks > 0 ? failures / totalChecks : 0);

  return healthHistory.persistHealthWindow(provider, {
    window_start: isoHoursAgo(hoursAgo),
    window_end: isoHoursAfter(hoursAgo),
    total_checks: totalChecks,
    successes,
    failures,
    failure_rate: failureRate,
    ...overrides,
  });
}

beforeAll(() => {
  ctx = setupE2eDb('provider-health-history');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  resetE2eDb();
  bindModule();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  if (ctx) {
    await teardownE2eDb(ctx);
  }
});

describe('db/provider-health-history', () => {
  it('persistHealthWindow inserts a health window record', () => {
    const inserted = persistWindow('codex', 6, {
      total_checks: 20,
      successes: 17,
      failures: 3,
      failure_rate: 0.15,
    });

    const row = rawDb().prepare(`
      SELECT provider, window_start, total_checks, successes, failures, failure_rate
      FROM provider_health_history
      WHERE provider = ?
    `).get('codex');

    expect(inserted.provider).toBe('codex');
    expect(row.provider).toBe('codex');
    expect(row.window_start).toBe(isoHoursAgo(6));
    expect(row.total_checks).toBe(20);
    expect(row.successes).toBe(17);
    expect(row.failures).toBe(3);
    expect(row.failure_rate).toBeCloseTo(0.15, 5);
  });

  it('persistHealthWindow upserts on same provider and window_start', () => {
    const windowStart = isoHoursAgo(4);

    healthHistory.persistHealthWindow('anthropic', {
      window_start: windowStart,
      window_end: isoHoursAfter(4),
      total_checks: 10,
      successes: 6,
      failures: 4,
      failure_rate: 0.4,
    });

    healthHistory.persistHealthWindow('anthropic', {
      window_start: windowStart,
      window_end: isoHoursAfter(4, 45),
      total_checks: 20,
      successes: 18,
      failures: 2,
      failure_rate: 0.1,
    });

    const count = rawDb().prepare(`
      SELECT COUNT(*) AS count
      FROM provider_health_history
      WHERE provider = ?
    `).get('anthropic');
    const row = rawDb().prepare(`
      SELECT total_checks, successes, failures, failure_rate
      FROM provider_health_history
      WHERE provider = ? AND window_start = ?
    `).get('anthropic', windowStart);

    expect(count.count).toBe(1);
    expect(row.total_checks).toBe(20);
    expect(row.successes).toBe(18);
    expect(row.failures).toBe(2);
    expect(row.failure_rate).toBeCloseTo(0.1, 5);
  });

  it('getHealthHistory returns windows for a provider within date range', () => {
    persistWindow('groq', 36, { failure_rate: 0.3, failures: 3 });
    persistWindow('groq', 12, { failure_rate: 0.1, failures: 1 });
    persistWindow('codex', 8, { failure_rate: 0.7, failures: 7 });

    const history = healthHistory.getHealthHistory('groq', 7);

    expect(history).toHaveLength(2);
    expect(history.map((row) => row.window_start)).toEqual([
      isoHoursAgo(36),
      isoHoursAgo(12),
    ]);
    expect(history.every((row) => row.provider === 'groq')).toBe(true);
  });

  it('getHealthHistory returns empty array for unknown provider', () => {
    persistWindow('codex', 4, { failure_rate: 0.2, failures: 2 });

    expect(healthHistory.getHealthHistory('missing-provider', 7)).toEqual([]);
  });

  it('getHealthHistory respects days parameter', () => {
    persistWindow('deepinfra', 12, { failure_rate: 0.1, failures: 1 });
    persistWindow('deepinfra', 60, { failure_rate: 0.6, failures: 6 });

    const history = healthHistory.getHealthHistory('deepinfra', 1);

    expect(history).toHaveLength(1);
    expect(history[0].window_start).toBe(isoHoursAgo(12));
  });

  it('getHealthTrend returns insufficient_data for fewer than 2 windows', () => {
    persistWindow('claude-cli', 6, { failure_rate: 0.25, failures: 1, total_checks: 4 });

    const trend = healthHistory.getHealthTrend('claude-cli', 7);

    expect(trend.trend).toBe('insufficient_data');
    expect(trend.window_count).toBe(1);
    expect(trend.previous_failure_rate).toBeNull();
    expect(trend.recent_failure_rate).toBeNull();
  });

  it('getHealthTrend returns stable for consistent failure rates', () => {
    persistWindow('codex', 24, { failure_rate: 0.2, failures: 2 });
    persistWindow('codex', 18, { failure_rate: 0.2, failures: 2 });
    persistWindow('codex', 12, { failure_rate: 0.2, failures: 2 });
    persistWindow('codex', 6, { failure_rate: 0.2, failures: 2 });

    const trend = healthHistory.getHealthTrend('codex', 7);

    expect(trend.trend).toBe('stable');
    expect(trend.previous_failure_rate).toBeCloseTo(0.2, 5);
    expect(trend.recent_failure_rate).toBeCloseTo(0.2, 5);
  });

  it('getHealthTrend returns improving when recent failure rate is lower', () => {
    persistWindow('ollama', 24, { failure_rate: 0.6, failures: 6 });
    persistWindow('ollama', 18, { failure_rate: 0.5, failures: 5 });
    persistWindow('ollama', 12, { failure_rate: 0.2, failures: 2 });
    persistWindow('ollama', 6, { failure_rate: 0.1, failures: 1 });

    const trend = healthHistory.getHealthTrend('ollama', 7);

    expect(trend.trend).toBe('improving');
    expect(trend.recent_failure_rate).toBeLessThan(trend.previous_failure_rate);
  });

  it('getHealthTrend returns degrading when recent failure rate is higher', () => {
    persistWindow('ollama', 24, { failure_rate: 0.1, failures: 1 });
    persistWindow('ollama', 18, { failure_rate: 0.2, failures: 2 });
    persistWindow('ollama', 12, { failure_rate: 0.5, failures: 5 });
    persistWindow('ollama', 6, { failure_rate: 0.6, failures: 6 });

    const trend = healthHistory.getHealthTrend('ollama', 7);

    expect(trend.trend).toBe('degrading');
    expect(trend.recent_failure_rate).toBeGreaterThan(trend.previous_failure_rate);
  });

  it('pruneHealthHistory removes records older than N days', () => {
    persistWindow('codex', 12, { failure_rate: 0.2, failures: 2 });
    persistWindow('codex', 30, { failure_rate: 0.4, failures: 4 });
    persistWindow('anthropic', 40, { failure_rate: 0.5, failures: 5 });

    const pruned = healthHistory.pruneHealthHistory(1);
    const remaining = rawDb().prepare(`
      SELECT provider, window_start
      FROM provider_health_history
      ORDER BY provider, window_start
    `).all();

    expect(pruned).toBe(2);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toEqual({
      provider: 'codex',
      window_start: isoHoursAgo(12),
    });
  });
});
