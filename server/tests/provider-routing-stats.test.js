const os = require('os');
const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const FIXED_NOW = new Date('2026-03-09T18:00:00.000Z');

let db;
let statsMod;
let seq = 0;

function rawDb() {
  return db.getDb ? db.getDb() : db.getDbInstance();
}

function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}-${randomUUID()}`;
}

function createTask(overrides = {}) {
  const id = overrides.id || nextId('task');
  db.createTask({
    task_description: overrides.task_description || `Task ${id}`,
    working_directory: overrides.working_directory || os.tmpdir(),
    status: overrides.status || 'queued',
    project: overrides.project || 'provider-routing-stats-tests',
    provider: overrides.provider || 'codex',
    model: overrides.model || overrides.provider || 'codex',
    priority: overrides.priority ?? 0,
    timeout_minutes: overrides.timeout_minutes || 30,
    ...overrides,
    id,
  });
  return id;
}

function recordUsage(provider, options) {
  const taskId = createTask({ provider });
  statsMod.recordProviderUsage(provider, taskId, options);
  return taskId;
}

function updateRecordedAt(taskId, iso) {
  rawDb().prepare(`
    UPDATE provider_usage
    SET recorded_at = ?
    WHERE task_id = ?
  `).run(iso, taskId);
}

function getUsageRow(taskId) {
  return rawDb().prepare(`
    SELECT provider, task_id, tokens_used, cost_estimate, duration_seconds, elapsed_ms,
           transport, retry_count, failure_reason, success, error_type, recorded_at
    FROM provider_usage
    WHERE task_id = ?
  `).get(taskId);
}

function listUsage(provider, days = 30) {
  const cutoff = new Date(FIXED_NOW.getTime() - (days * 24 * 60 * 60 * 1000)).toISOString();
  return rawDb().prepare(`
    SELECT provider, task_id, cost_estimate, duration_seconds, elapsed_ms, transport,
           success, error_type, recorded_at
    FROM provider_usage
    WHERE provider = ? AND recorded_at >= ?
    ORDER BY recorded_at ASC, id ASC
  `).all(provider, cutoff);
}

function percentile(values, pct) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * pct / 100)];
}

function getLatencyPercentiles(provider, days = 30) {
  const latencies = listUsage(provider, days)
    .map((row) => row.elapsed_ms)
    .filter((value) => value !== null && value !== undefined)
    .sort((a, b) => a - b);

  return {
    count: latencies.length,
    p50: percentile(latencies, 50),
    p90: percentile(latencies, 90),
    p99: percentile(latencies, 99),
    min: latencies[0] ?? null,
    max: latencies[latencies.length - 1] ?? null,
  };
}

function getRankedProviders(days = 30) {
  const cutoff = new Date(FIXED_NOW.getTime() - (days * 24 * 60 * 60 * 1000)).toISOString();
  return rawDb().prepare(`
    SELECT
      provider,
      COUNT(*) AS total_tasks,
      COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS successes,
      COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failures,
      COALESCE(AVG(
        CASE
          WHEN elapsed_ms IS NOT NULL THEN elapsed_ms
          WHEN duration_seconds IS NOT NULL THEN duration_seconds * 1000
          ELSE NULL
        END
      ), 0) AS avg_latency_ms,
      COALESCE(SUM(cost_estimate), 0) AS total_cost
    FROM provider_usage
    WHERE recorded_at >= ?
    GROUP BY provider
  `).all(cutoff).map((row) => ({
    ...row,
    success_rate: row.total_tasks > 0 ? row.successes / row.total_tasks : 0,
  })).sort((a, b) => (
    (b.success_rate - a.success_rate)
    || (a.avg_latency_ms - b.avg_latency_ms)
    || (a.total_cost - b.total_cost)
    || a.provider.localeCompare(b.provider)
  ));
}

function getOutcomeBreakdown(provider, days = 30) {
  const cutoff = new Date(FIXED_NOW.getTime() - (days * 24 * 60 * 60 * 1000)).toISOString();
  const rows = rawDb().prepare(`
    SELECT
      COALESCE(error_type, 'none') AS error_type,
      COUNT(*) AS count
    FROM provider_usage
    WHERE provider = ? AND recorded_at >= ? AND success = 0
    GROUP BY COALESCE(error_type, 'none')
  `).all(provider, cutoff);

  return rows.reduce((acc, row) => {
    acc[row.error_type] = row.count;
    return acc;
  }, {});
}

beforeEach(() => {
  ({ db } = setupTestDbOnly('provider-routing-stats'));
  statsMod = require('../db/provider-routing-core');
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  statsMod.resetProviderHealth();
});

afterEach(() => {
  statsMod.resetProviderHealth();
  vi.useRealTimers();
  teardownTestDb();
});

describe('db/provider-routing-stats', () => {
  describe('provider usage recording', () => {
    it('records a successful usage row from an object payload', () => {
      const taskId = recordUsage('codex', {
        tokens_used: 120,
        cost_estimate: 0.42,
        duration_seconds: 12,
        elapsed_ms: 980,
        success: true,
        transport: 'api',
      });

      expect(getUsageRow(taskId)).toMatchObject({
        provider: 'codex',
        task_id: taskId,
        tokens_used: 120,
        cost_estimate: 0.42,
        duration_seconds: 12,
        elapsed_ms: 980,
        transport: 'api',
        retry_count: null,
        failure_reason: null,
        success: 1,
        error_type: null,
      });
    });

    it('records failed timeout outcomes with retry metadata', () => {
      const taskId = recordUsage('anthropic', {
        tokens_used: 55,
        cost_estimate: 0.33,
        duration_seconds: 30,
        elapsed_ms: 3050,
        transport: 'cli',
        retry_count: 2,
        failure_reason: 'deadline_exceeded',
        success: false,
        error_type: 'timeout',
      });

      expect(getUsageRow(taskId)).toMatchObject({
        provider: 'anthropic',
        task_id: taskId,
        retry_count: 2,
        failure_reason: 'deadline_exceeded',
        success: 0,
        error_type: 'timeout',
        transport: 'cli',
      });
    });

    it('supports legacy positional arguments', () => {
      const provider = 'groq';
      const taskId = createTask({ provider });
      statsMod.recordProviderUsage(provider, taskId, 90, 1.25, 18, true, null);

      expect(getUsageRow(taskId)).toMatchObject({
        provider,
        task_id: taskId,
        tokens_used: 90,
        cost_estimate: 1.25,
        duration_seconds: 18,
        success: 1,
        elapsed_ms: null,
      });
    });

    it('records minimal usage payloads with null analytics fields', () => {
      const taskId = recordUsage('deepinfra');

      expect(getUsageRow(taskId)).toMatchObject({
        provider: 'deepinfra',
        task_id: taskId,
        tokens_used: null,
        cost_estimate: null,
        duration_seconds: null,
        elapsed_ms: null,
        transport: null,
        retry_count: null,
        failure_reason: null,
        success: null,
        error_type: null,
      });
    });

    it('preserves zero-valued usage metrics instead of coercing them to null', () => {
      const taskId = recordUsage('hyperbolic', {
        tokens_used: 0,
        cost_estimate: 0,
        duration_seconds: 0,
        elapsed_ms: 0,
        success: true,
      });
      const stats = statsMod.getProviderStats('hyperbolic', 30);

      expect(getUsageRow(taskId)).toMatchObject({
        tokens_used: 0,
        cost_estimate: 0,
        duration_seconds: 0,
        elapsed_ms: 0,
      });
      expect(stats.total_tokens).toBe(0);
      expect(stats.total_cost).toBe(0);
      expect(stats.avg_duration_seconds).toBe(0);
      expect(stats.successful_tasks).toBe(1);
    });
  });

  describe('provider stats queries', () => {
    it('aggregates stats across successes, failures, and unknown outcomes', () => {
      recordUsage('codex', {
        tokens_used: 100,
        cost_estimate: 0.4,
        duration_seconds: 10,
        success: true,
      });
      recordUsage('codex', {
        tokens_used: 50,
        cost_estimate: 0.2,
        duration_seconds: 30,
        success: false,
        error_type: 'timeout',
      });
      recordUsage('codex', {
        tokens_used: 25,
        cost_estimate: 0.1,
        duration_seconds: 20,
      });

      const stats = statsMod.getProviderStats('codex', 30);

      expect(stats.total_tasks).toBe(3);
      expect(stats.successful_tasks).toBe(1);
      expect(stats.failed_tasks).toBe(1);
      expect(stats.total_tokens).toBe(175);
      expect(stats.total_cost).toBeCloseTo(0.7, 10);
      expect(stats.avg_duration_seconds).toBe(20);
      expect(stats.success_rate).toBe(33);
    });

    it('isolates stats by provider', () => {
      recordUsage('codex', { tokens_used: 80, cost_estimate: 0.5, duration_seconds: 12, success: true });
      recordUsage('anthropic', { tokens_used: 20, cost_estimate: 0.1, duration_seconds: 40, success: false });

      const codex = statsMod.getProviderStats('codex', 30);
      const anthropic = statsMod.getProviderStats('anthropic', 30);

      expect(codex.total_tasks).toBe(1);
      expect(codex.successful_tasks).toBe(1);
      expect(codex.failed_tasks).toBe(0);
      expect(anthropic.total_tasks).toBe(1);
      expect(anthropic.successful_tasks).toBe(0);
      expect(anthropic.failed_tasks).toBe(1);
    });

    it('filters stats by the requested day window', () => {
      const oldTaskId = recordUsage('codex', {
        tokens_used: 10,
        cost_estimate: 0.05,
        duration_seconds: 5,
        success: true,
      });
      recordUsage('codex', {
        tokens_used: 20,
        cost_estimate: 0.10,
        duration_seconds: 10,
        success: true,
      });
      updateRecordedAt(oldTaskId, new Date(FIXED_NOW.getTime() - (45 * 24 * 60 * 60 * 1000)).toISOString());

      const recent = statsMod.getProviderStats('codex', 30);
      const allTimeWindow = statsMod.getProviderStats('codex', 60);

      expect(recent.total_tasks).toBe(1);
      expect(recent.total_tokens).toBe(20);
      expect(allTimeWindow.total_tasks).toBe(2);
      expect(allTimeWindow.total_tokens).toBe(30);
    });

    it('returns a zeroed structure for unused providers', () => {
      expect(statsMod.getProviderStats('missing-provider', 30)).toEqual({
        provider: 'missing-provider',
        total_tasks: 0,
        successful_tasks: 0,
        failed_tasks: 0,
        success_rate: 0,
        total_tokens: 0,
        total_cost: 0,
        avg_duration_seconds: 0,
      });
    });

    it('returns numeric zero aggregates for a single sparse row', () => {
      recordUsage('sparse-provider');

      expect(statsMod.getProviderStats('sparse-provider', 30)).toMatchObject({
        provider: 'sparse-provider',
        total_tasks: 1,
        successful_tasks: 0,
        failed_tasks: 0,
        success_rate: 0,
        total_tokens: 0,
        total_cost: 0,
        avg_duration_seconds: 0,
      });
    });

    it('aggregates decimal costs across multiple usage rows', () => {
      recordUsage('claude-cli', { cost_estimate: 0.125, success: true });
      recordUsage('claude-cli', { cost_estimate: 0.375, success: true });
      recordUsage('claude-cli', { cost_estimate: 0.5, success: false });

      const stats = statsMod.getProviderStats('claude-cli', 30);
      expect(stats.total_cost).toBeCloseTo(1.0, 10);
    });

    it('captures transport usage patterns for downstream analytics', () => {
      recordUsage('codex', { transport: 'api', elapsed_ms: 120, success: true });
      recordUsage('codex', { transport: 'api', elapsed_ms: 140, success: false, error_type: 'timeout' });
      recordUsage('codex', { transport: 'cli', elapsed_ms: 160, success: true });

      const transportCounts = rawDb().prepare(`
        SELECT transport, COUNT(*) AS count
        FROM provider_usage
        WHERE provider = ?
        GROUP BY transport
        ORDER BY transport
      `).all('codex');

      expect(transportCounts).toEqual([
        { transport: 'api', count: 2 },
        { transport: 'cli', count: 1 },
      ]);
    });

    it('rounds success rate to the nearest whole percent', () => {
      recordUsage('groq', { success: true });
      recordUsage('groq', { success: true });
      recordUsage('groq', { success: false });

      expect(statsMod.getProviderStats('groq', 30).success_rate).toBe(67);
    });
  });

  describe('latency percentiles and provider comparison', () => {
    it('calculates p50, p90, and p99 latency percentiles from elapsed_ms samples', () => {
      [100, 200, 300, 400, 500].forEach((elapsedMs) => {
        recordUsage('codex', { elapsed_ms: elapsedMs, duration_seconds: elapsedMs / 1000, success: true });
      });

      expect(getLatencyPercentiles('codex', 30)).toEqual({
        count: 5,
        p50: 300,
        p90: 500,
        p99: 500,
        min: 100,
        max: 500,
      });
    });

    it('returns identical percentile values for a single latency sample', () => {
      recordUsage('anthropic', { elapsed_ms: 240, duration_seconds: 0.24, success: true });

      expect(getLatencyPercentiles('anthropic', 30)).toEqual({
        count: 1,
        p50: 240,
        p90: 240,
        p99: 240,
        min: 240,
        max: 240,
      });
    });

    it('excludes very old latency samples from percentile windows', () => {
      const staleTaskId = recordUsage('deepinfra', { elapsed_ms: 9000, duration_seconds: 9, success: false });
      recordUsage('deepinfra', { elapsed_ms: 100, duration_seconds: 0.1, success: true });
      recordUsage('deepinfra', { elapsed_ms: 200, duration_seconds: 0.2, success: true });
      updateRecordedAt(staleTaskId, new Date(FIXED_NOW.getTime() - (90 * 24 * 60 * 60 * 1000)).toISOString());

      expect(getLatencyPercentiles('deepinfra', 30)).toEqual({
        count: 2,
        p50: 200,
        p90: 200,
        p99: 200,
        min: 100,
        max: 200,
      });
    });

    it('ranks providers by success rate before average latency', () => {
      recordUsage('codex', { success: true, elapsed_ms: 350, cost_estimate: 0.4 });
      recordUsage('codex', { success: true, elapsed_ms: 450, cost_estimate: 0.4 });
      recordUsage('codex', { success: true, elapsed_ms: 400, cost_estimate: 0.4 });
      recordUsage('codex', { success: false, elapsed_ms: 400, cost_estimate: 0.4, error_type: 'timeout' });

      recordUsage('anthropic', { success: true, elapsed_ms: 900, cost_estimate: 0.8 });
      recordUsage('anthropic', { success: true, elapsed_ms: 950, cost_estimate: 0.8 });

      recordUsage('groq', { success: true, elapsed_ms: 90, cost_estimate: 0.2 });
      recordUsage('groq', { success: true, elapsed_ms: 110, cost_estimate: 0.2 });
      recordUsage('groq', { success: true, elapsed_ms: 100, cost_estimate: 0.2 });
      recordUsage('groq', { success: false, elapsed_ms: 100, cost_estimate: 0.2, error_type: 'provider_error' });

      expect(getRankedProviders(30).map((row) => row.provider)).toEqual([
        'anthropic',
        'groq',
        'codex',
      ]);
    });

    it('uses lower cost as the tiebreaker when success rate and latency tie', () => {
      recordUsage('cheap-provider', { success: true, elapsed_ms: 200, cost_estimate: 0.25 });
      recordUsage('cheap-provider', { success: true, elapsed_ms: 200, cost_estimate: 0.25 });

      recordUsage('expensive-provider', { success: true, elapsed_ms: 200, cost_estimate: 0.75 });
      recordUsage('expensive-provider', { success: true, elapsed_ms: 200, cost_estimate: 0.75 });

      expect(getRankedProviders(30).map((row) => row.provider)).toEqual([
        'cheap-provider',
        'expensive-provider',
      ]);
    });

    it('supports provider failure comparisons including timeout counts', () => {
      recordUsage('codex', { success: false, error_type: 'timeout' });
      recordUsage('codex', { success: false, error_type: 'timeout' });
      recordUsage('codex', { success: false, error_type: 'provider_error' });
      recordUsage('codex', { success: true });

      recordUsage('anthropic', { success: false, error_type: 'provider_error' });
      recordUsage('anthropic', { success: true });

      expect(getOutcomeBreakdown('codex', 30)).toEqual({
        provider_error: 1,
        timeout: 2,
      });
      expect(getOutcomeBreakdown('anthropic', 30)).toEqual({
        provider_error: 1,
      });
    });
  });

  describe('provider health scoring', () => {
    it('records outcome counts and failure rate', () => {
      statsMod.recordProviderOutcome('codex', true);
      statsMod.recordProviderOutcome('codex', false);
      statsMod.recordProviderOutcome('codex', false);

      expect(statsMod.getProviderHealth('codex')).toEqual({
        successes: 1,
        failures: 2,
        failureRate: 2 / 3,
      });
    });

    it('treats providers with fewer than three samples as healthy', () => {
      statsMod.recordProviderOutcome('groq', false);
      statsMod.recordProviderOutcome('groq', false);

      expect(statsMod.isProviderHealthy('groq')).toBe(true);
    });

    it('marks providers unhealthy at a 30 percent failure rate', () => {
      for (let i = 0; i < 7; i += 1) {
        statsMod.recordProviderOutcome('anthropic', true);
      }
      for (let i = 0; i < 3; i += 1) {
        statsMod.recordProviderOutcome('anthropic', false);
      }

      expect(statsMod.isProviderHealthy('anthropic')).toBe(false);
    });

    it('resets provider health counters', () => {
      statsMod.recordProviderOutcome('deepinfra', true);
      statsMod.recordProviderOutcome('deepinfra', false);
      statsMod.resetProviderHealth();

      expect(statsMod.getProviderHealth('deepinfra')).toEqual({
        successes: 0,
        failures: 0,
        failureRate: 0,
      });
    });

    it('persists expired health windows and resets the in-memory counters', () => {
      statsMod.recordProviderOutcome('codex', true);
      statsMod.recordProviderOutcome('codex', false);
      statsMod.recordProviderOutcome('codex', false);

      vi.advanceTimersByTime((61 * 60 * 1000));

      expect(statsMod.getProviderHealth('codex')).toEqual({
        successes: 0,
        failures: 0,
        failureRate: 0,
      });

      const history = rawDb().prepare(`
        SELECT provider, total_checks, successes, failures, failure_rate
        FROM provider_health_history
        WHERE provider = ?
      `).all('codex');

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        provider: 'codex',
        total_checks: 3,
        successes: 1,
        failures: 2,
      });
      expect(history[0].failure_rate).toBeCloseTo(2 / 3, 10);
    });
  });
});
