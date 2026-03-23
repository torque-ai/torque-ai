'use strict';

const { setupTestDbModule, teardownTestDb, rawDb } = require('./vitest-setup');

let mod;

function setup() {
  ({ mod } = setupTestDbModule('../db/cost-tracking', 'free-tier-history'));
}

function teardown() {
  teardownTestDb();
}

function resetState() {
  rawDb().prepare('DELETE FROM free_tier_daily_usage').run();
}

/** Helper: returns YYYY-MM-DD for today minus N days */
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

describe('free-tier-history module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  // ── recordDailySnapshot ──────────────────────────────────────────────

  describe('recordDailySnapshot', () => {
    it('inserts a new daily snapshot', () => {
      mod.recordDailySnapshot('groq', {
        date: '2026-03-01',
        total_requests: 100,
        total_tokens: 5000,
        rate_limit_hits: 3,
        avg_latency_ms: 42.5,
      });

      const rows = rawDb().prepare('SELECT * FROM free_tier_daily_usage WHERE provider = ?').all('groq');
      expect(rows).toHaveLength(1);
      expect(rows[0].provider).toBe('groq');
      expect(rows[0].date).toBe('2026-03-01');
      expect(rows[0].total_requests).toBe(100);
      expect(rows[0].total_tokens).toBe(5000);
      expect(rows[0].rate_limit_hits).toBe(3);
      expect(rows[0].avg_latency_ms).toBeCloseTo(42.5);
    });

    it('upserts on same provider + date (ON CONFLICT UPDATE)', () => {
      mod.recordDailySnapshot('groq', {
        date: '2026-03-01',
        total_requests: 50,
        total_tokens: 2000,
      });
      mod.recordDailySnapshot('groq', {
        date: '2026-03-01',
        total_requests: 120,
        total_tokens: 8000,
        rate_limit_hits: 5,
        avg_latency_ms: 33.3,
      });

      const rows = rawDb().prepare('SELECT * FROM free_tier_daily_usage WHERE provider = ? AND date = ?').all('groq', '2026-03-01');
      expect(rows).toHaveLength(1);
      expect(rows[0].total_requests).toBe(120);
      expect(rows[0].total_tokens).toBe(8000);
      expect(rows[0].rate_limit_hits).toBe(5);
      expect(rows[0].avg_latency_ms).toBeCloseTo(33.3);
    });

    it('supports multiple providers on the same date', () => {
      mod.recordDailySnapshot('groq', { date: '2026-03-01', total_requests: 10 });
      mod.recordDailySnapshot('deepinfra', { date: '2026-03-01', total_requests: 20 });
      mod.recordDailySnapshot('hyperbolic', { date: '2026-03-01', total_requests: 30 });

      const rows = rawDb().prepare('SELECT * FROM free_tier_daily_usage WHERE date = ?').all('2026-03-01');
      expect(rows).toHaveLength(3);
    });

    it('defaults date to today when not provided', () => {
      const today = new Date().toISOString().slice(0, 10);
      mod.recordDailySnapshot('groq', { total_requests: 7 });

      const rows = rawDb().prepare('SELECT * FROM free_tier_daily_usage WHERE provider = ?').all('groq');
      expect(rows).toHaveLength(1);
      expect(rows[0].date).toBe(today);
    });

    it('defaults numeric stats to 0 when not provided', () => {
      mod.recordDailySnapshot('groq', { date: '2026-03-01' });

      const row = rawDb().prepare('SELECT * FROM free_tier_daily_usage WHERE provider = ? AND date = ?').get('groq', '2026-03-01');
      expect(row.total_requests).toBe(0);
      expect(row.total_tokens).toBe(0);
      expect(row.rate_limit_hits).toBe(0);
      expect(row.avg_latency_ms).toBe(0);
    });

    it('defaults stats to 0 when stats object is omitted entirely', () => {
      mod.recordDailySnapshot('groq');

      const rows = rawDb().prepare('SELECT * FROM free_tier_daily_usage WHERE provider = ?').all('groq');
      expect(rows).toHaveLength(1);
      expect(rows[0].total_requests).toBe(0);
      expect(rows[0].total_tokens).toBe(0);
    });

    it('coerces NaN / non-numeric stats to 0', () => {
      mod.recordDailySnapshot('groq', {
        date: '2026-03-01',
        total_requests: 'not-a-number',
        total_tokens: undefined,
        rate_limit_hits: null,
        avg_latency_ms: NaN,
      });

      const row = rawDb().prepare('SELECT * FROM free_tier_daily_usage WHERE provider = ? AND date = ?').get('groq', '2026-03-01');
      expect(row.total_requests).toBe(0);
      expect(row.total_tokens).toBe(0);
      expect(row.rate_limit_hits).toBe(0);
      expect(row.avg_latency_ms).toBe(0);
    });

    it('throws when provider is missing', () => {
      expect(() => mod.recordDailySnapshot(null, { date: '2026-03-01' })).toThrow('provider is required');
      expect(() => mod.recordDailySnapshot('', { date: '2026-03-01' })).toThrow('provider is required');
    });

    it('throws when provider is not a string', () => {
      expect(() => mod.recordDailySnapshot(123, {})).toThrow('provider is required');
      expect(() => mod.recordDailySnapshot(undefined, {})).toThrow('provider is required');
    });
  });

  // ── getUsageHistory ──────────────────────────────────────────────────

  describe('getUsageHistory', () => {
    it('returns rows within the default 7-day window', () => {
      mod.recordDailySnapshot('groq', { date: daysAgo(3), total_requests: 10 });
      mod.recordDailySnapshot('groq', { date: daysAgo(6), total_requests: 20 });

      const rows = mod.getUsageHistory();
      expect(rows).toHaveLength(2);
    });

    it('excludes rows older than the requested window', () => {
      mod.recordDailySnapshot('groq', { date: daysAgo(2), total_requests: 10 });
      mod.recordDailySnapshot('groq', { date: daysAgo(10), total_requests: 20 });

      const rows = mod.getUsageHistory(5);
      expect(rows).toHaveLength(1);
      expect(rows[0].total_requests).toBe(10);
    });

    it('orders by date ASC then provider ASC', () => {
      mod.recordDailySnapshot('groq', { date: daysAgo(2), total_requests: 1 });
      mod.recordDailySnapshot('deepinfra', { date: daysAgo(2), total_requests: 2 });
      mod.recordDailySnapshot('groq', { date: daysAgo(1), total_requests: 3 });

      const rows = mod.getUsageHistory(7);
      expect(rows).toHaveLength(3);
      // date ASC: daysAgo(2) first, then daysAgo(1)
      expect(rows[0].date).toBe(daysAgo(2));
      expect(rows[0].provider).toBe('deepinfra'); // alphabetical within same date
      expect(rows[1].date).toBe(daysAgo(2));
      expect(rows[1].provider).toBe('groq');
      expect(rows[2].date).toBe(daysAgo(1));
      expect(rows[2].provider).toBe('groq');
    });

    it('returns empty array when no data exists', () => {
      const rows = mod.getUsageHistory(30);
      expect(rows).toEqual([]);
    });

    it('clamps days to minimum 1', () => {
      mod.recordDailySnapshot('groq', { date: daysAgo(0), total_requests: 5 });

      const rows = mod.getUsageHistory(0);
      // days=0 is clamped to 1, today should still be within 1-day window
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it('falls back to 7 for non-finite days', () => {
      mod.recordDailySnapshot('groq', { date: daysAgo(5), total_requests: 5 });
      mod.recordDailySnapshot('groq', { date: daysAgo(10), total_requests: 9 });

      const rows = mod.getUsageHistory('abc');
      // 'abc' → NaN → falls back to 7; daysAgo(5) is within 7, daysAgo(10) is not
      expect(rows).toHaveLength(1);
      expect(rows[0].total_requests).toBe(5);
    });

    it('includes rows from multiple providers', () => {
      mod.recordDailySnapshot('groq', { date: daysAgo(1), total_requests: 10 });
      mod.recordDailySnapshot('deepinfra', { date: daysAgo(1), total_requests: 20 });
      mod.recordDailySnapshot('hyperbolic', { date: daysAgo(1), total_requests: 30 });

      const rows = mod.getUsageHistory(3);
      expect(rows).toHaveLength(3);
      const providers = rows.map(r => r.provider).sort();
      expect(providers).toEqual(['deepinfra', 'groq', 'hyperbolic']);
    });
  });

  // ── getProviderHistory ───────────────────────────────────────────────

  describe('getProviderHistory', () => {
    it('returns only rows for the requested provider', () => {
      mod.recordDailySnapshot('groq', { date: daysAgo(1), total_requests: 10 });
      mod.recordDailySnapshot('deepinfra', { date: daysAgo(1), total_requests: 20 });

      const rows = mod.getProviderHistory('groq', 7);
      expect(rows).toHaveLength(1);
      expect(rows[0].provider).toBe('groq');
      expect(rows[0].total_requests).toBe(10);
    });

    it('respects the days window', () => {
      mod.recordDailySnapshot('groq', { date: daysAgo(2), total_requests: 10 });
      mod.recordDailySnapshot('groq', { date: daysAgo(15), total_requests: 20 });

      const rows = mod.getProviderHistory('groq', 5);
      expect(rows).toHaveLength(1);
      expect(rows[0].total_requests).toBe(10);
    });

    it('orders results by date ASC', () => {
      mod.recordDailySnapshot('groq', { date: daysAgo(3), total_requests: 30 });
      mod.recordDailySnapshot('groq', { date: daysAgo(1), total_requests: 10 });
      mod.recordDailySnapshot('groq', { date: daysAgo(2), total_requests: 20 });

      const rows = mod.getProviderHistory('groq', 7);
      expect(rows).toHaveLength(3);
      expect(rows[0].total_requests).toBe(30); // oldest first
      expect(rows[1].total_requests).toBe(20);
      expect(rows[2].total_requests).toBe(10);
    });

    it('returns empty array for a provider with no data', () => {
      mod.recordDailySnapshot('groq', { date: daysAgo(1), total_requests: 5 });

      const rows = mod.getProviderHistory('nonexistent', 7);
      expect(rows).toEqual([]);
    });

    it('returns empty array for null/undefined provider', () => {
      expect(mod.getProviderHistory(null)).toEqual([]);
      expect(mod.getProviderHistory(undefined)).toEqual([]);
      expect(mod.getProviderHistory('')).toEqual([]);
    });

    it('returns empty array for non-string provider', () => {
      expect(mod.getProviderHistory(123)).toEqual([]);
      expect(mod.getProviderHistory({})).toEqual([]);
    });
  });

  // ── Row mapping (numeric types) ─────────────────────────────────────

  describe('mapRow — numeric type coercion', () => {
    it('returns numeric types for all stat fields via getUsageHistory', () => {
      mod.recordDailySnapshot('groq', {
        date: daysAgo(0),
        total_requests: 42,
        total_tokens: 9001,
        rate_limit_hits: 7,
        avg_latency_ms: 123.456,
      });

      const rows = mod.getUsageHistory(1);
      expect(rows).toHaveLength(1);
      const row = rows[0];

      expect(typeof row.total_requests).toBe('number');
      expect(typeof row.total_tokens).toBe('number');
      expect(typeof row.rate_limit_hits).toBe('number');
      expect(typeof row.avg_latency_ms).toBe('number');
      expect(row.total_requests).toBe(42);
      expect(row.total_tokens).toBe(9001);
      expect(row.rate_limit_hits).toBe(7);
      expect(row.avg_latency_ms).toBeCloseTo(123.456);
    });

    it('returns numeric types via getProviderHistory', () => {
      mod.recordDailySnapshot('deepinfra', {
        date: daysAgo(0),
        total_requests: 88,
        total_tokens: 12345,
        rate_limit_hits: 0,
        avg_latency_ms: 0,
      });

      const rows = mod.getProviderHistory('deepinfra', 1);
      expect(rows).toHaveLength(1);
      const row = rows[0];

      expect(typeof row.total_requests).toBe('number');
      expect(typeof row.total_tokens).toBe('number');
      expect(typeof row.rate_limit_hits).toBe('number');
      expect(typeof row.avg_latency_ms).toBe('number');
    });

    it('preserves provider and date strings in mapped rows', () => {
      const date = daysAgo(0);
      mod.recordDailySnapshot('groq', { date, total_requests: 1 });

      const rows = mod.getUsageHistory(1);
      expect(rows[0].provider).toBe('groq');
      expect(rows[0].date).toBe(date);
      expect(typeof rows[0].created_at).toBe('string');
    });

    it('coerces null/undefined stat values to 0 in mapped output', () => {
      // Insert directly with NULL values to test mapRow coercion
      rawDb().prepare(`
        INSERT INTO free_tier_daily_usage (provider, date, total_requests, total_tokens, rate_limit_hits, avg_latency_ms)
        VALUES (?, ?, NULL, NULL, NULL, NULL)
      `).run('test-null', daysAgo(0));

      const rows = mod.getUsageHistory(1);
      const row = rows.find(r => r.provider === 'test-null');
      expect(row).toBeDefined();
      expect(row.total_requests).toBe(0);
      expect(row.total_tokens).toBe(0);
      expect(row.rate_limit_hits).toBe(0);
      expect(row.avg_latency_ms).toBe(0);
    });
  });

  // ── setDb ────────────────────────────────────────────────────────────

  describe('setDb', () => {
    it('creates the table on setDb call', () => {
      // Table already exists from setup, verify it's queryable
      const count = rawDb().prepare('SELECT COUNT(*) as cnt FROM free_tier_daily_usage').get();
      expect(count.cnt).toBe(0);
    });
  });
});
