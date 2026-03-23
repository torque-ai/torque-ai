'use strict';
/* global describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi */

const http = require('http');
const Database = require('better-sqlite3');
const { TEST_MODELS } = require('./test-helpers');
const { setupTestDb, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');

const SUBJECT_PATH = '../db/host-benchmarking';
const RESET_TABLES = ['benchmark_results', 'ollama_hosts'];

let _db;
let mod;
let logger;
let activeServers = [];
let hostSeq = 0;

function ensureColumn(tableName, columnName, definition) {
  const exists = rawDb()
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);

  if (!exists) {
    rawDb().exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function createLoggerMock() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function loadSubject(customLogger = createLoggerMock()) {
  delete require.cache[require.resolve(SUBJECT_PATH)];
  const loggerModule = require('../logger');
  const childSpy = vi.spyOn(loggerModule, 'child').mockReturnValue(customLogger);
  const subject = require(SUBJECT_PATH);
  childSpy.mockRestore();
  subject.setDb(rawDb());
  return { mod: subject, logger: customLogger };
}

function getHostRow(hostId) {
  return rawDb().prepare('SELECT * FROM ollama_hosts WHERE id = ?').get(hostId);
}

function insertHost(overrides = {}) {
  hostSeq += 1;
  const id = overrides.id || `bench-host-${hostSeq}`;
  const row = {
    id,
    name: overrides.name || `Bench Host ${hostSeq}`,
    url: overrides.url || `http://127.0.0.1:${17000 + hostSeq}`,
    enabled: overrides.enabled !== undefined ? (overrides.enabled ? 1 : 0) : 1,
    status: overrides.status || 'healthy',
    consecutive_failures: overrides.consecutive_failures ?? 0,
    last_health_check: overrides.last_health_check ?? null,
    last_healthy: overrides.last_healthy ?? null,
    running_tasks: overrides.running_tasks ?? 0,
    models_cache: overrides.models_cache ?? null,
    models_updated_at: overrides.models_updated_at ?? null,
    created_at: overrides.created_at || new Date().toISOString(),
    memory_limit_mb: overrides.memory_limit_mb ?? null,
    max_concurrent: overrides.max_concurrent ?? 1,
    priority: overrides.priority ?? 10,
    settings: overrides.settings ?? null,
    gpu_metrics_port: overrides.gpu_metrics_port ?? null,
  };

  rawDb().prepare(`
    INSERT INTO ollama_hosts (
      id, name, url, enabled, status, consecutive_failures, last_health_check,
      last_healthy, running_tasks, models_cache, models_updated_at, created_at,
      memory_limit_mb, max_concurrent, priority, settings, gpu_metrics_port
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.name,
    row.url,
    row.enabled,
    row.status,
    row.consecutive_failures,
    row.last_health_check,
    row.last_healthy,
    row.running_tasks,
    row.models_cache,
    row.models_updated_at,
    row.created_at,
    row.memory_limit_mb,
    row.max_concurrent,
    row.priority,
    row.settings,
    row.gpu_metrics_port,
  );

  return getHostRow(id);
}

function insertBenchmark(overrides = {}) {
  rawDb().prepare(`
    INSERT INTO benchmark_results (
      host_id, model, test_type, prompt_type, tokens_per_second,
      prompt_tokens, output_tokens, eval_duration_seconds,
      num_gpu, num_ctx, temperature, success, error_message, raw_result, benchmarked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.host_id || 'bench-host',
    overrides.model || TEST_MODELS.SMALL,
    overrides.test_type || 'basic',
    overrides.prompt_type ?? null,
    Object.prototype.hasOwnProperty.call(overrides, 'tokens_per_second')
      ? overrides.tokens_per_second
      : null,
    overrides.prompt_tokens ?? null,
    overrides.output_tokens ?? null,
    overrides.eval_duration_seconds ?? null,
    Object.prototype.hasOwnProperty.call(overrides, 'num_gpu') ? overrides.num_gpu : null,
    Object.prototype.hasOwnProperty.call(overrides, 'num_ctx') ? overrides.num_ctx : null,
    Object.prototype.hasOwnProperty.call(overrides, 'temperature') ? overrides.temperature : null,
    Object.prototype.hasOwnProperty.call(overrides, 'success') ? overrides.success : 1,
    overrides.error_message ?? null,
    Object.prototype.hasOwnProperty.call(overrides, 'raw_result') ? overrides.raw_result : null,
    overrides.benchmarked_at || new Date().toISOString(),
  );
}

function createStandaloneBenchmarkDb() {
  const conn = new Database(':memory:');
  conn.exec(`
    CREATE TABLE benchmark_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL,
      model TEXT NOT NULL,
      test_type TEXT NOT NULL,
      prompt_type TEXT,
      tokens_per_second REAL,
      prompt_tokens INTEGER,
      output_tokens INTEGER,
      eval_duration_seconds REAL,
      num_gpu INTEGER,
      num_ctx INTEGER,
      temperature REAL,
      success INTEGER DEFAULT 1,
      error_message TEXT,
      raw_result TEXT,
      benchmarked_at TEXT NOT NULL
    )
  `);
  return conn;
}

async function startHttpServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    handler(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  activeServers.push(server);
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
  };
}

async function closeActiveServers() {
  const servers = activeServers;
  activeServers = [];
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1000000n;
  while (process.hrtime.bigint() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for async condition');
}

describe('db/host-benchmarking (real DB)', () => {
  beforeAll(() => {
    ({ db: _db } = setupTestDb('db-host-bench'));
    ensureColumn('ollama_hosts', 'memory_limit_mb', 'memory_limit_mb INTEGER');
    ensureColumn('ollama_hosts', 'max_concurrent', 'max_concurrent INTEGER DEFAULT 1');
    ensureColumn('ollama_hosts', 'priority', 'priority INTEGER DEFAULT 10');
    ensureColumn('ollama_hosts', 'settings', 'settings TEXT');
    ensureColumn('ollama_hosts', 'gpu_metrics_port', 'gpu_metrics_port INTEGER');
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetTables(RESET_TABLES);
    hostSeq = 0;
    ({ mod, logger } = loadSubject());
  });

  afterEach(async () => {
    await closeActiveServers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete require.cache[require.resolve(SUBJECT_PATH)];
  });

  describe('benchmark persistence and scoring', () => {
    it('setDb routes writes through the provided sqlite handle', () => {
      const alternateDb = createStandaloneBenchmarkDb();

      try {
        mod.setDb(alternateDb);
        mod.recordBenchmarkResult({
          hostId: 'alt-host',
          model: 'alt:model',
          tokensPerSecond: 19.75,
          success: true,
        });

        const alternateCount = alternateDb.prepare('SELECT COUNT(*) as count FROM benchmark_results').get().count;
        const primaryCount = rawDb().prepare('SELECT COUNT(*) as count FROM benchmark_results').get().count;

        expect(alternateCount).toBe(1);
        expect(primaryCount).toBe(0);
      } finally {
        mod.setDb(rawDb());
        alternateDb.close();
      }
    });

    it('setHostSettings merges JSON settings and removes nullish overrides', () => {
      insertHost({
        id: 'host-settings',
        settings: JSON.stringify({ temperature: 0.2, keep_alive: '5m', stale: true }),
      });

      const updated = mod.setHostSettings('host-settings', {
        temperature: 0.6,
        stale: null,
        keep_alive: undefined,
        num_gpu: 2,
      });

      expect(JSON.parse(updated.settings)).toEqual({
        temperature: 0.6,
        num_gpu: 2,
      });
      expect(JSON.parse(getHostRow('host-settings').settings)).toEqual({
        temperature: 0.6,
        num_gpu: 2,
      });
    });

    it('setHostSettings recovers from invalid stored JSON', () => {
      insertHost({
        id: 'host-invalid-settings',
        settings: '{not-json',
      });

      const updated = mod.setHostSettings('host-invalid-settings', { num_ctx: 8192 });

      expect(JSON.parse(updated.settings)).toEqual({ num_ctx: 8192 });
    });

    it('recordBenchmarkResult round-trips parsed benchmark data', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      mod.recordBenchmarkResult({
        hostId: 'bench-host',
        model: TEST_MODELS.SMALL,
        testType: 'stream',
        promptType: 'code',
        tokensPerSecond: 42.125,
        promptTokens: 128,
        outputTokens: 256,
        evalDurationSeconds: 6.5,
        numGpu: 2,
        numCtx: 8192,
        temperature: 0.1,
        success: true,
        rawResult: { latencyMs: 321 },
      });

      const [result] = mod.getBenchmarkResults('bench-host');

      expect(result).toMatchObject({
        host_id: 'bench-host',
        model: TEST_MODELS.SMALL,
        test_type: 'stream',
        prompt_type: 'code',
        tokens_per_second: 42.125,
        prompt_tokens: 128,
        output_tokens: 256,
        eval_duration_seconds: 6.5,
        num_gpu: 2,
        num_ctx: 8192,
        temperature: 0.1,
        success: true,
        rawResult: { latencyMs: 321 },
        benchmarked_at: '2026-01-01T00:00:00.000Z',
      });
    });

    it('getBenchmarkResults returns newest results first and respects the limit', () => {
      insertBenchmark({
        host_id: 'bench-order',
        model: 'm1',
        tokens_per_second: 10,
        success: 1,
        benchmarked_at: '2026-01-01T00:00:00.000Z',
      });
      insertBenchmark({
        host_id: 'bench-order',
        model: 'm2',
        tokens_per_second: 20,
        success: 1,
        benchmarked_at: '2026-01-01T00:00:01.000Z',
      });
      insertBenchmark({
        host_id: 'bench-order',
        model: 'm3',
        tokens_per_second: 30,
        success: 1,
        benchmarked_at: '2026-01-01T00:00:02.000Z',
      });

      const results = mod.getBenchmarkResults('bench-order', 2);

      expect(results).toHaveLength(2);
      expect(results.map((row) => row.model)).toEqual(['m3', 'm2']);
    });

    it('getBenchmarkResults falls back to null for invalid raw_result JSON', () => {
      insertBenchmark({
        host_id: 'bench-invalid-json',
        model: 'broken:1b',
        success: 1,
        raw_result: '{broken',
      });

      const [result] = mod.getBenchmarkResults('bench-invalid-json');

      expect(result.rawResult).toBeNull();
      expect(result.success).toBe(true);
    });

    it('getOptimalSettingsFromBenchmarks selects the fastest successful model-specific config', () => {
      insertBenchmark({
        host_id: 'bench-best-model',
        model: TEST_MODELS.DEFAULT,
        num_gpu: 1,
        num_ctx: 4096,
        tokens_per_second: 38.441,
        success: 1,
      });
      insertBenchmark({
        host_id: 'bench-best-model',
        model: TEST_MODELS.DEFAULT,
        num_gpu: 2,
        num_ctx: 8192,
        tokens_per_second: 51.129,
        success: 1,
      });
      insertBenchmark({
        host_id: 'bench-best-model',
        model: TEST_MODELS.DEFAULT,
        num_gpu: 4,
        num_ctx: 16384,
        tokens_per_second: 90,
        success: 0,
      });

      const optimal = mod.getOptimalSettingsFromBenchmarks('bench-best-model', TEST_MODELS.DEFAULT);

      expect(optimal).toEqual({
        numGpu: 2,
        numCtx: 8192,
        tokensPerSecond: 51.13,
        model: TEST_MODELS.DEFAULT,
      });
    });

    it('getOptimalSettingsFromBenchmarks averages configurations when model is omitted', () => {
      insertBenchmark({
        host_id: 'bench-average',
        model: 'm1',
        num_gpu: 1,
        num_ctx: 4096,
        tokens_per_second: 40.111,
        success: 1,
      });
      insertBenchmark({
        host_id: 'bench-average',
        model: 'm2',
        num_gpu: 1,
        num_ctx: 4096,
        tokens_per_second: 50.141,
        success: 1,
      });
      insertBenchmark({
        host_id: 'bench-average',
        model: 'm3',
        num_gpu: 2,
        num_ctx: 8192,
        tokens_per_second: 42.499,
        success: 1,
      });

      const optimal = mod.getOptimalSettingsFromBenchmarks('bench-average');

      expect(optimal).toEqual({
        numGpu: 1,
        numCtx: 4096,
        tokensPerSecond: 45.13,
        model: undefined,
      });
    });

    it('getOptimalSettingsFromBenchmarks returns null when only failed or empty runs exist', () => {
      insertBenchmark({
        host_id: 'bench-empty',
        model: 'm1',
        num_gpu: 1,
        num_ctx: 4096,
        tokens_per_second: null,
        success: 1,
      });
      insertBenchmark({
        host_id: 'bench-empty',
        model: 'm1',
        num_gpu: 2,
        num_ctx: 8192,
        tokens_per_second: 55,
        success: 0,
      });

      expect(mod.getOptimalSettingsFromBenchmarks('bench-empty')).toBeNull();
      expect(mod.getOptimalSettingsFromBenchmarks('bench-empty', 'm1')).toBeNull();
    });

    it('applyBenchmarkResults writes the optimal GPU and ctx settings back onto the host', () => {
      insertHost({
        id: 'apply-host',
        settings: JSON.stringify({ temperature: 0.3, num_ctx: 2048 }),
      });
      insertBenchmark({
        host_id: 'apply-host',
        model: TEST_MODELS.SMALL,
        num_gpu: 2,
        num_ctx: 16384,
        tokens_per_second: 61.234,
        success: 1,
      });

      const applied = mod.applyBenchmarkResults('apply-host', TEST_MODELS.SMALL);

      expect(applied).toEqual({
        applied: true,
        settings: { num_gpu: 2, num_ctx: 16384 },
        tokensPerSecond: 61.23,
        reason: 'Applied optimal settings: {"num_gpu":2,"num_ctx":16384}',
      });
      expect(JSON.parse(getHostRow('apply-host').settings)).toEqual({
        temperature: 0.3,
        num_ctx: 16384,
        num_gpu: 2,
      });
    });

    it('applyBenchmarkResults reports when no benchmark data exists', () => {
      insertHost({ id: 'empty-apply-host' });

      expect(mod.applyBenchmarkResults('empty-apply-host')).toEqual({
        applied: false,
        settings: null,
        reason: 'No benchmark results found',
      });
    });

    it('applyBenchmarkResults reports when the best result has no tunable settings', () => {
      insertHost({
        id: 'no-settings-host',
        settings: JSON.stringify({ keep_alive: '15m' }),
      });
      insertBenchmark({
        host_id: 'no-settings-host',
        model: 'tiny:1b',
        num_gpu: null,
        num_ctx: null,
        tokens_per_second: 12.345,
        success: 1,
      });

      const result = mod.applyBenchmarkResults('no-settings-host', 'tiny:1b');

      expect(result).toEqual({
        applied: false,
        settings: null,
        reason: 'No optimizable settings found',
      });
      expect(JSON.parse(getHostRow('no-settings-host').settings)).toEqual({ keep_alive: '15m' });
    });

    it('getBenchmarkStats returns summary statistics and best-model averages', () => {
      insertBenchmark({
        host_id: 'stats-host',
        model: 'fast:4b',
        tokens_per_second: 20.111,
        success: 1,
        benchmarked_at: '2026-01-01T00:00:00.000Z',
      });
      insertBenchmark({
        host_id: 'stats-host',
        model: 'fast:4b',
        tokens_per_second: 30.111,
        success: 1,
        benchmarked_at: '2026-01-01T00:10:00.000Z',
      });
      insertBenchmark({
        host_id: 'stats-host',
        model: 'slow:32b',
        tokens_per_second: 10.222,
        success: 1,
        benchmarked_at: '2026-01-01T00:20:00.000Z',
      });
      insertBenchmark({
        host_id: 'stats-host',
        model: 'error:7b',
        tokens_per_second: 999,
        success: 0,
        benchmarked_at: '2026-01-01T00:30:00.000Z',
      });

      expect(mod.getBenchmarkStats('stats-host')).toEqual({
        totalRuns: 3,
        avgTps: 20.15,
        maxTps: 30.11,
        bestModel: 'fast:4b',
        bestModelTps: 25.11,
        firstRun: '2026-01-01T00:00:00.000Z',
        lastRun: '2026-01-01T00:20:00.000Z',
      });
    });

    it('getBenchmarkStats returns empty stats when there are no successful runs', () => {
      insertBenchmark({
        host_id: 'stats-empty',
        model: 'broken:1b',
        tokens_per_second: 1,
        success: 0,
      });

      expect(mod.getBenchmarkStats('stats-empty')).toEqual({
        totalRuns: 0,
        avgTps: null,
        maxTps: null,
        bestModel: null,
        bestModelTps: null,
        firstRun: null,
        lastRun: null,
      });
    });
  });

  describe('refresh logging and model discovery', () => {
    it('logThrottledModelRefreshFailure suppresses repeats and reports the suppressed count after the window', () => {
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => now);

      mod.logThrottledModelRefreshFailure('refresh-key', 'Benchmark refresh failed', { hostId: 'host-1' });
      mod.logThrottledModelRefreshFailure('refresh-key', 'Benchmark refresh failed', { hostId: 'host-1' });
      mod.logThrottledModelRefreshFailure('refresh-key', 'Benchmark refresh failed', { hostId: 'host-1' });

      now = 60000;
      mod.logThrottledModelRefreshFailure('refresh-key', 'Benchmark refresh failed', { hostId: 'host-1' });

      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn.mock.calls[0][0]).toBe('Benchmark refresh failed');
      expect(logger.warn.mock.calls[1][0]).toContain('2 similar failures suppressed');
    });

    it('clearThrottledModelRefreshFailure resets the throttle bucket', () => {
      mod.logThrottledModelRefreshFailure('clear-key', 'Refresh failed');
      mod.logThrottledModelRefreshFailure('clear-key', 'Refresh failed');
      mod.clearThrottledModelRefreshFailure('clear-key');
      mod.logThrottledModelRefreshFailure('clear-key', 'Refresh failed');

      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('fetchModelsFromHost resolves parsed JSON responses', async () => {
      const server = await startHttpServer((req, res) => {
        expect(req.url).toBe('/api/tags');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: TEST_MODELS.SMALL }] }));
      });

      await expect(mod.fetchModelsFromHost(`${server.baseUrl}/api/tags`)).resolves.toEqual({
        models: [{ name: TEST_MODELS.SMALL }],
      });
    });

    it('fetchModelsFromHost rejects invalid JSON responses', async () => {
      const server = await startHttpServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end('{broken');
      });

      await expect(mod.fetchModelsFromHost(`${server.baseUrl}/api/tags`)).rejects.toThrow('Invalid JSON from host');
    });

    it('fetchHostModelsSync returns null for invalid URLs and logs the skip', async () => {
      const result = await mod.fetchHostModelsSync('not-a-url');

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain('Skipping model refresh for invalid host URL');
    });

    it('fetchHostModelsSync returns parsed models from localhost hosts', async () => {
      const server = await startHttpServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: TEST_MODELS.SMALL }, { name: 'mistral:7b' }] }));
      });

      const result = await mod.fetchHostModelsSync(server.baseUrl);

      expect(result).toEqual([{ name: TEST_MODELS.SMALL }, { name: 'mistral:7b' }]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('fetchHostModelsSync returns null when the host response has no models array', async () => {
      const server = await startHttpServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ items: [] }));
      });

      const result = await mod.fetchHostModelsSync(server.baseUrl);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain('returned no models during refresh');
    });

    it('ensureModelsLoaded refreshes eligible hosts in load and name order and persists their cache', async () => {
      const requestOrder = [];
      const server = await startHttpServer((req, res) => {
        requestOrder.push(req.url);

        const payloads = {
          '/alpha/api/tags': { models: [{ name: 'alpha:model' }] },
          '/bravo/api/tags': { models: [{ name: 'bravo:model' }] },
          '/charlie/api/tags': { models: [{ name: 'charlie:model' }] },
        };

        if (!payloads[req.url]) {
          res.statusCode = 404;
          res.end('missing');
          return;
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payloads[req.url]));
      });

      insertHost({
        id: 'loaded-host',
        name: 'Loaded',
        url: `${server.baseUrl}/loaded`,
        enabled: 1,
        running_tasks: 0,
        models_cache: JSON.stringify([{ name: 'already:cached' }]),
      });
      insertHost({
        id: 'down-host',
        name: 'Down',
        url: `${server.baseUrl}/down`,
        enabled: 1,
        running_tasks: 0,
        status: 'down',
      });
      insertHost({
        id: 'alpha-host',
        name: 'Alpha',
        url: `${server.baseUrl}/alpha`,
        enabled: 1,
        running_tasks: 0,
      });
      insertHost({
        id: 'bravo-host',
        name: 'Bravo',
        url: `${server.baseUrl}/bravo`,
        enabled: 1,
        running_tasks: 0,
      });
      insertHost({
        id: 'charlie-host',
        name: 'Charlie',
        url: `${server.baseUrl}/charlie`,
        enabled: 1,
        running_tasks: 2,
      });
      insertHost({
        id: 'disabled-host',
        name: 'Disabled',
        url: `${server.baseUrl}/disabled`,
        enabled: 0,
        running_tasks: 0,
      });

      const refreshedCount = mod.ensureModelsLoaded();

      expect(refreshedCount).toBe(3);

      await waitFor(() => (
        Boolean(getHostRow('alpha-host').models_updated_at) &&
        Boolean(getHostRow('bravo-host').models_updated_at) &&
        Boolean(getHostRow('charlie-host').models_updated_at)
      ));

      expect(requestOrder).toEqual([
        '/alpha/api/tags',
        '/bravo/api/tags',
        '/charlie/api/tags',
      ]);
      expect(JSON.parse(getHostRow('alpha-host').models_cache)).toEqual([{ name: 'alpha:model' }]);
      expect(JSON.parse(getHostRow('bravo-host').models_cache)).toEqual([{ name: 'bravo:model' }]);
      expect(JSON.parse(getHostRow('charlie-host').models_cache)).toEqual([{ name: 'charlie:model' }]);
      expect(getHostRow('alpha-host').status).toBe('healthy');
      expect(getHostRow('alpha-host').consecutive_failures).toBe(0);
      expect(getHostRow('disabled-host').models_cache).toBeNull();
      expect(JSON.parse(getHostRow('loaded-host').models_cache)).toEqual([{ name: 'already:cached' }]);
    });

    it('ensureModelsLoaded respects its 30 second TTL before probing again', async () => {
      const server = await startHttpServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ items: [] }));
      });

      insertHost({
        id: 'ttl-host',
        name: 'TTL',
        url: `${server.baseUrl}/ttl`,
        enabled: 1,
      });

      let now = 60000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);

      expect(mod.ensureModelsLoaded()).toBe(1);
      await waitFor(() => server.requests.length === 1);

      now += 10000;
      expect(mod.ensureModelsLoaded()).toBe(0);
      expect(server.requests).toEqual(['/ttl/api/tags']);

      now += 30001;
      expect(mod.ensureModelsLoaded()).toBe(1);
      await waitFor(() => server.requests.length === 2);
      expect(server.requests).toEqual(['/ttl/api/tags', '/ttl/api/tags']);
    });
  });
});
