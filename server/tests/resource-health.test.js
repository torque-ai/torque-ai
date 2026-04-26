import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const resourceHealth = require('../db/resource-health');
const { assertMaxPrepares } = require('./perf-test-helpers.test');

function createDeps(overrides = {}) {
  return {
    getConfig: vi.fn(() => null),
    cleanupWebhookLogs: vi.fn(() => 0),
    cleanupStreamData: vi.fn(() => 0),
    cleanupCoordinationEvents: vi.fn(() => 0),
    getSlowQueries: vi.fn(() => []),
    ...overrides,
  };
}

describe('db/resource-health', () => {
  let dbModule;
  let db;

  function insertHealthRow(checkType, status, responseTimeMs, errorMessage = null, details = null, checkedAt = new Date().toISOString()) {
    db.prepare(`
      INSERT INTO health_status (check_type, status, response_time_ms, error_message, details, checked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      checkType,
      status,
      responseTimeMs,
      errorMessage,
      details ? JSON.stringify(details) : null,
      checkedAt,
    );
  }

  beforeEach(() => {
    ({ db: dbModule } = setupTestDbOnly('resource-health'));
    db = dbModule.getDbInstance();
    resourceHealth.setDb(db);
    resourceHealth.init(createDeps());
    db.prepare('DELETE FROM health_status').run();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('records a health check and returns the latest row with parsed details', () => {
    vi.useFakeTimers();
    const checkedAt = new Date('2026-02-03T04:05:06.000Z');
    vi.setSystemTime(checkedAt);

    resourceHealth.recordHealthCheck('database', 'healthy', 42, null, { pool: 'ok', replicas: 2 });

    const latest = resourceHealth.getLatestHealthCheck();

    expect(latest).toMatchObject({
      check_type: 'database',
      status: 'healthy',
      response_time_ms: 42,
      error_message: null,
      details: { pool: 'ok', replicas: 2 },
      checked_at: checkedAt.toISOString(),
    });
    expect(latest.id).toEqual(expect.any(Number));
  });

  it('filters getLatestHealthCheck by check type', () => {
    const base = Date.parse('2026-02-03T04:05:06.000Z');

    insertHealthRow('database', 'healthy', 15, null, { seq: 1 }, new Date(base - 2_000).toISOString());
    insertHealthRow('api', 'unhealthy', 320, 'timeout', { seq: 2 }, new Date(base - 1_000).toISOString());
    insertHealthRow('database', 'unhealthy', 55, 'lock timeout', { seq: 3 }, new Date(base).toISOString());

    const latestDatabase = resourceHealth.getLatestHealthCheck('database');

    expect(latestDatabase).toMatchObject({
      check_type: 'database',
      status: 'unhealthy',
      response_time_ms: 55,
      error_message: 'lock timeout',
      details: { seq: 3 },
      checked_at: new Date(base).toISOString(),
    });
  });

  it('returns health history filtered by type and limited to the most recent rows', () => {
    const base = Date.parse('2026-02-03T04:05:06.000Z');

    insertHealthRow('api', 'healthy', 10, null, { seq: 1 }, new Date(base - 3_000).toISOString());
    insertHealthRow('api', 'healthy', 20, null, { seq: 2 }, new Date(base - 2_000).toISOString());
    insertHealthRow('api', 'unhealthy', 30, 'timeout', { seq: 3 }, new Date(base - 1_000).toISOString());
    insertHealthRow('database', 'healthy', 40, null, { seq: 4 }, new Date(base).toISOString());

    const history = resourceHealth.getHealthHistory({ checkType: 'api', limit: 2 });

    expect(history).toHaveLength(2);
    expect(history.map((row) => row.check_type)).toEqual(['api', 'api']);
    expect(history.map((row) => row.response_time_ms)).toEqual([30, 20]);
    expect(history[0].details).toEqual({ seq: 3 });
    expect(history[1].details).toEqual({ seq: 2 });
  });

  it('summarizes uptime, average response time, and last error across check types', () => {
    const base = Date.parse('2026-02-03T04:05:06.000Z');

    insertHealthRow('api', 'healthy', 100, null, null, new Date(base - 3_000).toISOString());
    insertHealthRow('api', 'healthy', 120, null, null, new Date(base - 2_000).toISOString());
    insertHealthRow('api', 'unhealthy', 50, 'boom', null, new Date(base - 1_000).toISOString());
    insertHealthRow('database', 'unhealthy', 40, 'busy', null, new Date(base - 500).toISOString());
    insertHealthRow('database', 'healthy', 20, null, null, new Date(base).toISOString());

    const summary = resourceHealth.getHealthSummary();

    expect(summary.api).toEqual({
      status: 'unhealthy',
      lastCheck: new Date(base - 1_000).toISOString(),
      uptimePercent: 67,
      avgResponseTime: 90,
      lastError: 'boom',
    });
    expect(summary.database).toEqual({
      status: 'healthy',
      lastCheck: new Date(base).toISOString(),
      uptimePercent: 50,
      avgResponseTime: 30,
      lastError: null,
    });
  });

  it('deletes only health rows older than the bounded retention window', () => {
    const now = Date.now();
    const oldCheckedAt = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    const recentCheckedAt = new Date(now - 12 * 60 * 60 * 1000).toISOString();

    insertHealthRow('database', 'healthy', 10, null, { age: 'old' }, oldCheckedAt);
    insertHealthRow('database', 'healthy', 20, null, { age: 'recent' }, recentCheckedAt);

    const deleted = resourceHealth.cleanupHealthHistory(0);
    const remaining = resourceHealth.getHealthHistory({ checkType: 'database', limit: 10 });

    expect(deleted).toBe(1);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      response_time_ms: 20,
      details: { age: 'recent' },
      checked_at: recentCheckedAt,
    });
  });

  it('stores injected deps via init and uses getConfig in memory pressure checks', () => {
    const getConfig = vi.fn((key) => ({
      memory_warning_percent: '40',
      memory_critical_percent: '80',
      max_rss_mb: '2048',
    })[key] ?? null);
    const getSlowQueries = vi.fn(() => [{
      description: 'SELECT * FROM tasks',
      durationMs: 250,
      timestamp: '2026-02-03T04:05:06.000Z',
    }]);

    resourceHealth.init(createDeps({ getConfig, getSlowQueries }));
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 200 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      heapUsed: 50 * 1024 * 1024,
      external: 5 * 1024 * 1024,
      arrayBuffers: 0,
    });

    const pressure = resourceHealth.checkMemoryPressure();
    const health = resourceHealth.getDatabaseHealth();

    expect(getConfig).toHaveBeenCalledWith('memory_warning_percent');
    expect(getConfig).toHaveBeenCalledWith('memory_critical_percent');
    expect(getConfig).toHaveBeenCalledWith('max_rss_mb');
    expect(pressure).toMatchObject({
      underPressure: true,
      level: 'warning',
      metrics: {
        heapPercent: 50,
        warningThreshold: 40,
        criticalThreshold: 80,
        maxRssMB: 2048,
      },
    });
    expect(getSlowQueries).toHaveBeenCalledWith(5);
    expect(health.metrics.recentSlowQueries).toBe(1);
    expect(health.checks.performance).toMatchObject({
      status: 'warn',
      message: '1 slow queries recently',
    });
  });

  it('returns the wrapped query result from timedQuery for synchronous work', () => {
    const queryFn = vi.fn(() => ({ rows: 3, ok: true }));

    const result = resourceHealth.timedQuery('SELECT 1', queryFn);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ rows: 3, ok: true });
  });

  it('returns database health metrics derived from SQLite pragmas', () => {
    const pageCount = db.prepare('PRAGMA page_count').get().page_count;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    const freelistCount = db.prepare('PRAGMA freelist_count').get().freelist_count;

    const health = resourceHealth.getDatabaseHealth(db);

    expect(['healthy', 'degraded']).toContain(health.status);
    expect(health.checks.connectivity).toEqual({
      status: 'pass',
      message: 'Database is responsive',
    });
    expect(health.checks.integrity).toEqual({
      status: 'pass',
      message: 'Database integrity OK',
    });
    expect(health.checks.tables).toEqual({
      status: 'pass',
      message: 'Table counts retrieved',
    });
    expect(health.metrics.totalPages).toBe(pageCount);
    expect(health.metrics.freePages).toBe(freelistCount);
    expect(health.metrics.sizeBytes).toBe(pageCount * pageSize);
    expect(health.metrics.sizeMB).toBe(Math.round((pageCount * pageSize) / 1024 / 1024 * 10) / 10);
    expect(health.metrics.fragmentationPercent).toBeTypeOf('number');
    expect(health.metrics.tableCounts).toEqual(expect.objectContaining({
      tasks: expect.any(Number),
      task_events: expect.any(Number),
      webhooks: expect.any(Number),
      webhook_logs: expect.any(Number),
      health_status: expect.any(Number),
    }));
  });

  describe('prepare-in-loop regressions', () => {
    it('getSystemMetrics uses 0 prepares after first call (module-level cache)', async () => {
      // First call initializes cache
      resourceHealth.getSystemMetrics();
      // Second call should use 0 prepares for the table-count loop
      const count = await assertMaxPrepares(db, 0, () => {
        resourceHealth.getSystemMetrics();
      });
      expect(count).toBe(0);
    });

    it('getDatabaseHealth uses 0 prepares after first call (module-level cache)', async () => {
      resourceHealth.getDatabaseHealth();
      const count = await assertMaxPrepares(db, 0, () => {
        resourceHealth.getDatabaseHealth();
      });
      expect(count).toBe(0);
    });

    it('getHealthSummary issues at most 2 queries total regardless of check type count', async () => {
      // Insert 3 types x 5 entries each
      const base = Date.parse('2026-02-03T04:05:06.000Z');
      const types = ['cpu', 'memory', 'disk'];
      for (const type of types) {
        for (let i = 0; i < 5; i++) {
          insertHealthRow(type, i % 2 === 0 ? 'healthy' : 'degraded', 10 + i, null, null, new Date(base + i * 1000).toISOString());
        }
      }

      let queryCount = 0;
      const origPrepare = db.prepare.bind(db);
      db.prepare = (...args) => { queryCount++; return origPrepare(...args); };

      resourceHealth.getHealthSummary();

      db.prepare = origPrepare;
      // Old 2N+1 pattern: 1 DISTINCT + 2*3 = 7. New: at most 2.
      expect(queryCount).toBeLessThanOrEqual(2);
    });
  });
});
