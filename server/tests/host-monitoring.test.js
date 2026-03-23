'use strict';

const { EventEmitter } = require('events');
const realHttp = require('node:http');
const { TEST_MODELS } = require('./test-helpers');
const realHttps = require('node:https');

const monitoringPath = require.resolve('../utils/host-monitoring');
const originalHttpGet = realHttp.get;
const originalHttpRequest = realHttp.request;
const originalHttpsGet = realHttps.get;
const originalHttpsRequest = realHttps.request;

const mockHttpModule = {
  get: vi.fn(),
  request: vi.fn(),
};

const mockHttpsModule = {
  get: vi.fn(),
  request: vi.fn(),
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

const configStore = {};

const mockConfigModule = {
  init: vi.fn(),
  get: vi.fn((key) => (
    Object.prototype.hasOwnProperty.call(configStore, key) ? configStore[key] : null
  )),
  getInt: vi.fn((key, fallback) => {
    if (!Object.prototype.hasOwnProperty.call(configStore, key)) return fallback;
    const parsed = Number.parseInt(configStore[key], 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  }),
  getBool: vi.fn((key) => {
    const value = configStore[key];
    return value === true || value === '1' || value === 1 || value === 'true';
  }),
  isOptIn: vi.fn((key) => {
    const value = configStore[key];
    return value === true || value === '1' || value === 1 || value === 'true';
  }),
};

const mockResourceGateModule = {
  isHostOverloaded: vi.fn(() => false),
};

vi.mock('http', () => mockHttpModule);
vi.mock('https', () => mockHttpsModule);
vi.mock('../logger', () => ({
  child: vi.fn(() => mockLogger),
}));
vi.mock('../config', () => mockConfigModule);
vi.mock('../constants', () => ({
  TASK_TIMEOUTS: {
    HEALTH_CHECK: 25,
    PROCESS_QUERY: 50,
  },
}));
vi.mock('../utils/resource-gate', () => mockResourceGateModule);

function resetMockModules(overrides = {}) {
  mockHttpModule.get.mockReset();
  mockHttpModule.request.mockReset();
  mockHttpsModule.get.mockReset();
  mockHttpsModule.request.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.debug.mockReset();
  mockLogger.error.mockReset();
  mockConfigModule.init.mockReset();
  mockConfigModule.get.mockClear();
  mockConfigModule.getInt.mockClear();
  mockConfigModule.getBool.mockClear();
  mockConfigModule.isOptIn.mockClear();
  mockResourceGateModule.isHostOverloaded.mockReset();
  mockResourceGateModule.isHostOverloaded.mockImplementation(overrides.isHostOverloaded || (() => false));

  Object.keys(configStore).forEach((key) => {
    delete configStore[key];
  });
  Object.assign(configStore, overrides.configStore || {});
}

function createMockDb(initialHosts = []) {
  const hosts = new Map(
    initialHosts.map((host) => [host.id, {
      enabled: true,
      status: 'unknown',
      consecutive_failures: 0,
      models: [],
      ...host,
    }])
  );

  return {
    __hosts: hosts,
    listOllamaHosts: vi.fn((filter = {}) => Array
      .from(hosts.values())
      .filter((host) => filter.enabled == null || host.enabled === filter.enabled)
      .map((host) => ({ ...host }))),
    recordHostHealthCheck: vi.fn((hostId, healthy, models = null) => {
      const host = hosts.get(hostId);
      if (!host) return null;

      if (healthy) {
        host.status = 'healthy';
        host.consecutive_failures = 0;
        if (models) host.models = models;
      } else {
        host.consecutive_failures = (host.consecutive_failures || 0) + 1;
        host.status = host.consecutive_failures >= 3 ? 'down' : 'degraded';
      }

      return { ...host };
    }),
    getOllamaHost: vi.fn((hostId) => {
      const host = hosts.get(hostId);
      return host ? { ...host } : null;
    }),
    recoverOllamaHost: vi.fn((hostId) => {
      const host = hosts.get(hostId);
      if (!host) throw new Error(`Unknown host ${hostId}`);
      host.status = 'healthy';
      host.consecutive_failures = 0;
      return { ...host };
    }),
    ensureModelsLoaded: vi.fn(),
    acquireLock: vi.fn(() => ({ acquired: true })),
    isReady: vi.fn(() => true),
    setCodexExhausted: vi.fn(),
    setConfig: vi.fn(),
  };
}

function createHost(id, overrides = {}) {
  return {
    id,
    name: overrides.name || id,
    url: overrides.url || `http://203.0.113.${id.length + 10}:11434`,
    ...overrides,
  };
}

function createMockRequest(spec = {}) {
  const {
    statusCode = 200,
    body = '',
    error = null,
    timeout = false,
    invokeCallback = !error && !timeout,
  } = spec;

  const req = new EventEmitter();
  req.destroy = vi.fn();
  req.end = vi.fn();

  const res = new EventEmitter();
  res.statusCode = statusCode;

  return {
    req,
    res,
    invoke(callback) {
      if (invokeCallback && callback) callback(res);

      process.nextTick(() => {
        if (timeout) {
          req.emit('timeout');
          return;
        }

        if (error) {
          req.emit('error', error instanceof Error ? error : new Error(String(error)));
          return;
        }

        if (body !== '' && body !== undefined && body !== null) {
          const payload = typeof body === 'string' ? body : JSON.stringify(body);
          res.emit('data', payload);
        }
        res.emit('end');
      });

      return req;
    },
  };
}

function getCallback(optionsOrCallback, maybeCallback) {
  return typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
}

function setupTest(options = {}) {
  resetMockModules(options.moduleOverrides);
  realHttp.get = mockHttpModule.get;
  realHttp.request = mockHttpModule.request;
  realHttps.get = mockHttpsModule.get;
  realHttps.request = mockHttpsModule.request;

  vi.resetModules();
  delete require.cache[monitoringPath];

  const monitoring = require('../utils/host-monitoring');
  const db = options.db || createMockDb(options.hosts || []);
  const dashboard = options.dashboard || {
    notifyHostActivityUpdated: vi.fn(),
    broadcast: vi.fn(),
  };
  const cleanupOrphanedHostTasks = options.cleanupOrphanedHostTasks || vi.fn();

  monitoring.init({
    db,
    dashboard,
    cleanupOrphanedHostTasks,
    queueLockHolderId: 'host-monitoring-test',
  });
  monitoring.hostActivityCache.clear();

  return {
    monitoring,
    db,
    dashboard,
    cleanupOrphanedHostTasks,
    logger: mockLogger,
    mocks: {
      httpModule: mockHttpModule,
      httpsModule: mockHttpsModule,
      configModule: mockConfigModule,
      resourceGateModule: mockResourceGateModule,
    },
  };
}

describe('host-monitoring.js', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.resetModules();
    realHttp.get = originalHttpGet;
    realHttp.request = originalHttpRequest;
    realHttps.get = originalHttpsGet;
    realHttps.request = originalHttpsRequest;
    resetMockModules();
  });

  describe('model cache helpers', () => {
    it('normalizes model names by lowercasing and stripping :latest', () => {
      const { monitoring } = setupTest();

      expect(monitoring.normalizeModelName('QWEN3:7B:latest')).toBe('qwen3:7b');
      expect(monitoring.normalizeModelName('llama3')).toBe('llama3');
      expect(monitoring.normalizeModelName(null)).toBe('');
    });

    it('returns null when a host has not been polled yet', () => {
      const { monitoring } = setupTest();

      expect(monitoring.isModelLoadedOnHost('missing-host', TEST_MODELS.SMALL)).toBeNull();
    });

    it('matches loaded models using either name or model fields', () => {
      const { monitoring } = setupTest();

      monitoring.hostActivityCache.set('host-a', {
        models: [
          { model: 'codellama:latest' },
          { name: TEST_MODELS.SMALL.toUpperCase() },
        ],
      });

      expect(monitoring.isModelLoadedOnHost('host-a', 'codellama')).toBe(true);
      expect(monitoring.isModelLoadedOnHost('host-a', TEST_MODELS.SMALL)).toBe(true);
      expect(monitoring.isModelLoadedOnHost('host-a', 'missing')).toBe(false);
    });

    it('returns dashboard-friendly activity payloads with total VRAM usage', () => {
      const { monitoring } = setupTest();

      monitoring.hostActivityCache.set('host-a', {
        models: [
          { name: TEST_MODELS.SMALL, size_vram: 1_500_000_000, expires_at: '2026-01-01T00:00:00Z' },
          { name: TEST_MODELS.DEFAULT, size_vram: 500_000_000 },
        ],
        polledAt: 12345,
        gpuMetrics: {
          gpuUtilizationPercent: 17,
          vramUsedMb: 2048,
          vramTotalMb: 8192,
        },
      });

      expect(monitoring.getHostActivity()).toEqual({
        'host-a': {
          loadedModels: [
            { name: TEST_MODELS.SMALL, sizeVram: 1_500_000_000, expiresAt: '2026-01-01T00:00:00Z' },
            { name: TEST_MODELS.DEFAULT, sizeVram: 500_000_000, expiresAt: undefined },
          ],
          totalVramUsed: 2_000_000_000,
          gpuMetrics: {
            gpuUtilizationPercent: 17,
            vramUsedMb: 2048,
            vramTotalMb: 8192,
          },
          polledAt: 12345,
        },
      });
    });
  });

  describe('runHostHealthChecks', () => {
    it('uses https.get for HTTPS hosts', async () => {
      const host = createHost('secure-host', { url: 'https://gpu.example:11434', status: 'unknown' });
      const { monitoring, db: _db, mocks } = setupTest({ hosts: [host] });

      mocks.httpsModule.get.mockImplementation((_url, options, callback) => {
        expect(options).toMatchObject({ timeout: 25 });
        return createMockRequest({
          statusCode: 200,
          body: { models: [{ name: 'llama3:8b' }] },
        }).invoke(getCallback(options, callback));
      });

      await monitoring.runHostHealthChecks();

      expect(mocks.httpsModule.get).toHaveBeenCalledTimes(1);
      expect(mocks.httpModule.get).not.toHaveBeenCalled();
    });

    it('parses successful health checks into a model list', async () => {
      const host = createHost('host-a', { status: 'unknown' });
      const { monitoring, db, mocks } = setupTest({ hosts: [host] });

      mocks.httpModule.get.mockImplementation((_url, _options, callback) => createMockRequest({
        statusCode: 200,
        body: {
          models: [
            { name: TEST_MODELS.SMALL },
            { model: 'codellama:latest' },
            { name: '' },
          ],
        },
      }).invoke(getCallback(_options, callback)));

      await monitoring.runHostHealthChecks();

      expect(db.recordHostHealthCheck).toHaveBeenCalledWith('host-a', true, [TEST_MODELS.SMALL, 'codellama:latest']);
      expect(db.getOllamaHost('host-a').models).toEqual([TEST_MODELS.SMALL, 'codellama:latest']);
    });

    it('treats invalid JSON as healthy without replacing cached models', async () => {
      const host = createHost('host-b', {
        status: 'healthy',
        models: ['existing-model'],
      });
      const { monitoring, db, mocks } = setupTest({ hosts: [host] });

      mocks.httpModule.get.mockImplementation((_url, _options, callback) => createMockRequest({
        statusCode: 200,
        body: '{invalid',
      }).invoke(getCallback(_options, callback)));

      await monitoring.runHostHealthChecks();

      expect(db.recordHostHealthCheck).toHaveBeenCalledWith('host-b', true, null);
      expect(db.getOllamaHost('host-b').models).toEqual(['existing-model']);
    });

    it('marks non-200 responses as unhealthy', async () => {
      const host = createHost('host-c', { status: 'healthy' });
      const { monitoring, db, mocks } = setupTest({ hosts: [host] });

      mocks.httpModule.get.mockImplementation((_url, _options, callback) => createMockRequest({
        statusCode: 503,
        body: { error: 'down' },
      }).invoke(getCallback(_options, callback)));

      await monitoring.runHostHealthChecks();

      expect(db.recordHostHealthCheck).toHaveBeenCalledWith('host-c', false, null);
      expect(db.getOllamaHost('host-c').status).toBe('degraded');
    });

    it('records request errors as unhealthy', async () => {
      const host = createHost('host-d', { status: 'healthy' });
      const { monitoring, db, mocks } = setupTest({ hosts: [host] });

      mocks.httpModule.get.mockImplementation((_url, _options, callback) => createMockRequest({
        error: new Error('ECONNREFUSED'),
      }).invoke(getCallback(_options, callback)));

      await monitoring.runHostHealthChecks();

      expect(db.recordHostHealthCheck).toHaveBeenCalledWith('host-d', false, null);
      expect(db.getOllamaHost('host-d').status).toBe('degraded');
    });

    it('destroys timed out health check requests and records the host unhealthy', async () => {
      const host = createHost('host-e', { status: 'healthy' });
      const { monitoring, db, mocks } = setupTest({ hosts: [host] });

      const request = createMockRequest({ timeout: true });
      mocks.httpModule.get.mockImplementation((_url, _options, callback) => request.invoke(getCallback(_options, callback)));

      await monitoring.runHostHealthChecks();

      expect(request.req.destroy).toHaveBeenCalledTimes(1);
      expect(db.recordHostHealthCheck).toHaveBeenCalledWith('host-e', false, null);
      expect(db.getOllamaHost('host-e').status).toBe('degraded');
    });

    it('recovers hosts that were already down after a successful probe', async () => {
      const host = createHost('host-f', {
        status: 'down',
        consecutive_failures: 4,
      });
      const { monitoring, db, mocks } = setupTest({ hosts: [host] });

      mocks.httpModule.get.mockImplementation((_url, _options, callback) => createMockRequest({
        statusCode: 200,
        body: { models: [{ name: 'recovered-model' }] },
      }).invoke(getCallback(_options, callback)));

      await monitoring.runHostHealthChecks();

      expect(db.recoverOllamaHost).toHaveBeenCalledWith('host-f');
      expect(db.getOllamaHost('host-f')).toMatchObject({
        status: 'healthy',
        consecutive_failures: 0,
        models: ['recovered-model'],
      });
    });

    it('calls orphan cleanup only when a host transitions into down status', async () => {
      const host = createHost('host-g', { status: 'healthy' });
      const cleanupOrphanedHostTasks = vi.fn();
      const { monitoring, db, mocks } = setupTest({
        hosts: [host],
        cleanupOrphanedHostTasks,
      });

      mocks.httpModule.get.mockImplementation((_url, _options, callback) => createMockRequest({
        statusCode: 500,
        body: 'down',
      }).invoke(getCallback(_options, callback)));

      await monitoring.runHostHealthChecks();
      await monitoring.runHostHealthChecks();
      await monitoring.runHostHealthChecks();
      await monitoring.runHostHealthChecks();

      expect(db.getOllamaHost('host-g').status).toBe('down');
      expect(cleanupOrphanedHostTasks).toHaveBeenCalledTimes(1);
      expect(cleanupOrphanedHostTasks).toHaveBeenCalledWith('host-g', 'host-g');
    });
  });

  describe('pollHostActivity', () => {
    it('polls only healthy hosts and prunes stale cache entries', async () => {
      const hosts = [
        createHost('healthy-host', { status: 'healthy' }),
        createHost('down-host', { status: 'down' }),
      ];
      const { monitoring, dashboard, mocks } = setupTest({ hosts });

      monitoring.hostActivityCache.set('stale-host', {
        models: [{ name: 'stale-model', size_vram: 100 }],
      });

      mocks.httpModule.get.mockImplementation((url, _options, callback) => {
        expect(url).toContain('/api/ps');
        return createMockRequest({
          statusCode: 200,
          body: { models: [{ name: TEST_MODELS.SMALL, size_vram: 100 }] },
        }).invoke(getCallback(_options, callback));
      });

      await monitoring.pollHostActivity();

      const activity = monitoring.getHostActivity();
      expect(mocks.httpModule.get).toHaveBeenCalledTimes(1);
      expect(activity['healthy-host'].loadedModels).toEqual([
        { name: TEST_MODELS.SMALL, sizeVram: 100, expiresAt: undefined },
      ]);
      expect(activity['down-host']).toBeUndefined();
      expect(activity['stale-host']).toBeUndefined();
      expect(dashboard.notifyHostActivityUpdated).toHaveBeenCalledTimes(1);
    });

    it('keeps prior models when /api/ps returns invalid JSON', async () => {
      const host = createHost('poll-host', { status: 'healthy' });
      const { monitoring, mocks } = setupTest({ hosts: [host] });

      monitoring.hostActivityCache.set('poll-host', {
        models: [{ name: 'existing-model', size_vram: 50 }],
        polledAt: 111,
      });

      mocks.httpModule.get.mockImplementation((_url, _options, callback) => createMockRequest({
        statusCode: 200,
        body: '{broken',
      }).invoke(getCallback(_options, callback)));

      await monitoring.pollHostActivity();

      expect(monitoring.getHostActivity()['poll-host'].loadedModels).toEqual([
        { name: 'existing-model', sizeVram: 50, expiresAt: undefined },
      ]);
    });

    it('destroys timed out /api/ps requests and still notifies the dashboard', async () => {
      const host = createHost('timeout-host', { status: 'healthy' });
      const { monitoring, dashboard, mocks } = setupTest({ hosts: [host] });

      const request = createMockRequest({ timeout: true });
      mocks.httpModule.get.mockImplementation((_url, _options, callback) => request.invoke(getCallback(_options, callback)));

      await monitoring.pollHostActivity();

      expect(request.req.destroy).toHaveBeenCalledTimes(1);
      expect(dashboard.notifyHostActivityUpdated).toHaveBeenCalledTimes(1);
      expect(monitoring.getHostActivity()['timeout-host']).toBeUndefined();
    });

    it('broadcasts resource pressure after notifying dashboard listeners', async () => {
      const host = createHost('pressure-host', { status: 'healthy' });
      const { monitoring, dashboard, mocks } = setupTest({
        hosts: [host],
        moduleOverrides: {
          isHostOverloaded: vi.fn(() => true),
        },
      });

      monitoring.hostActivityCache.set('pressure-host', {
        models: [],
        polledAt: Date.now(),
        gpuMetrics: {
          cpuPercent: 92,
          ramPercent: 88,
          gpuUtilizationPercent: 12,
          vramUsedMb: 512,
          vramTotalMb: 8192,
        },
      });

      mocks.httpModule.get.mockImplementation((_url, _options, callback) => createMockRequest({
        statusCode: 200,
        body: { models: [{ name: TEST_MODELS.SMALL, size_vram: 100 }] },
      }).invoke(getCallback(_options, callback)));

      await monitoring.pollHostActivity();

      expect(dashboard.notifyHostActivityUpdated).toHaveBeenCalledTimes(1);
      expect(dashboard.broadcast).toHaveBeenCalledWith('hosts:resource-pressure', {
        hostId: 'pressure-host',
        cpuPercent: 92,
        ramPercent: 88,
        timestamp: expect.any(Number),
      });
      expect(dashboard.notifyHostActivityUpdated.mock.invocationCallOrder[0]).toBeLessThan(
        dashboard.broadcast.mock.invocationCallOrder[0]
      );
    });
  });

  describe('probeRemoteGpuMetrics', () => {
    it('parses remote metrics and flattens CPU/RAM percentages', async () => {
      const host = createHost('remote-host', {
        gpu_metrics_port: 9000,
        status: 'healthy',
      });
      const { monitoring, mocks } = setupTest({ hosts: [host] });

      monitoring.hostActivityCache.set('remote-host', {
        models: [{ name: TEST_MODELS.SMALL, size_vram: 1_000_000_000 }],
      });

      mocks.httpModule.get.mockImplementation((url, _options, callback) => {
        expect(url).toBe('http://203.0.113.21:9000/metrics');
        return createMockRequest({
          statusCode: 200,
          body: {
            gpuUtilizationPercent: 47,
            vramUsedMb: 4096,
            vramTotalMb: 8192,
            temperatureC: 68,
            powerDrawW: 175.5,
            cpu: { usage_percent: 81 },
            memory: { usage_percent: 73 },
          },
        }).invoke(getCallback(_options, callback));
      });

      await monitoring.probeRemoteGpuMetrics([host]);

      expect(monitoring.getHostActivity()['remote-host'].gpuMetrics).toEqual({
        gpuUtilizationPercent: 47,
        vramUsedMb: 4096,
        vramTotalMb: 8192,
        temperatureC: 68,
        powerDrawW: 175.5,
        cpu: { usage_percent: 81 },
        memory: { usage_percent: 73 },
        cpuPercent: 81,
        ramPercent: 73,
      });
    });

    it('keeps existing GPU metrics when the endpoint returns invalid JSON', async () => {
      const host = createHost('remote-invalid', {
        gpu_metrics_port: 9001,
        status: 'healthy',
      });
      const { monitoring, mocks } = setupTest({ hosts: [host] });

      monitoring.hostActivityCache.set('remote-invalid', {
        models: [],
        gpuMetrics: {
          gpuUtilizationPercent: 12,
          vramUsedMb: 512,
          vramTotalMb: 8192,
        },
      });

      mocks.httpModule.get.mockImplementation((_url, _options, callback) => createMockRequest({
        statusCode: 200,
        body: '{bad-json',
      }).invoke(getCallback(_options, callback)));

      await monitoring.probeRemoteGpuMetrics([host]);

      expect(monitoring.getHostActivity()['remote-invalid'].gpuMetrics).toEqual({
        gpuUtilizationPercent: 12,
        vramUsedMb: 512,
        vramTotalMb: 8192,
      });
    });

    it('clears stale GPU metrics when the endpoint errors', async () => {
      const host = createHost('remote-error', {
        gpu_metrics_port: 9002,
        status: 'healthy',
      });
      const { monitoring, mocks } = setupTest({ hosts: [host] });

      monitoring.hostActivityCache.set('remote-error', {
        models: [],
        gpuMetrics: {
          gpuUtilizationPercent: 99,
          vramUsedMb: 8192,
          vramTotalMb: 8192,
        },
      });

      mocks.httpModule.get.mockImplementation((_url, _options, callback) => createMockRequest({
        error: new Error('ECONNRESET'),
      }).invoke(getCallback(_options, callback)));

      await monitoring.probeRemoteGpuMetrics([host]);

      expect(monitoring.getHostActivity()['remote-error'].gpuMetrics).toBeNull();
    });

    it('synthesizes VRAM metrics when no remote endpoint is configured', async () => {
      const host = createHost('remote-synthetic', {
        memory_limit_mb: 6144,
        status: 'healthy',
      });
      const { monitoring, mocks } = setupTest({ hosts: [host] });

      monitoring.hostActivityCache.set('remote-synthetic', {
        models: [
          { name: 'model-a', size_vram: 256 * 1024 * 1024 },
          { name: 'model-b', size_vram: 512 * 1024 * 1024 },
        ],
      });

      await monitoring.probeRemoteGpuMetrics([host]);

      expect(mocks.httpModule.get).not.toHaveBeenCalled();
      expect(monitoring.getHostActivity()['remote-synthetic'].gpuMetrics).toEqual({
        vramUsedMb: 768,
        vramTotalMb: 6144,
        gpuUtilizationPercent: null,
        temperatureC: null,
        powerDrawW: null,
        synthetic: true,
      });
    });
  });
});
