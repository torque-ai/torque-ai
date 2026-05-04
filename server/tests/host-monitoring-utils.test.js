const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

const hostManagement = require('../db/host/management');
const { TEST_MODELS } = require('./test-helpers');

let db;
let configCore;
let monitoring;
const { setupTestDbOnly } = require('./vitest-setup');

function loadHostMonitoring() {
  const monitoringPath = require.resolve('../utils/host-monitoring');
  delete require.cache[monitoringPath];
  return require('../utils/host-monitoring');
}

function loadHostMonitoringWithChildProcessPatches(patches = {}) {
  const originalExecFile = childProcess.execFile;
  const originalSpawnSync = childProcess.spawnSync;

  if (patches.execFile) childProcess.execFile = patches.execFile;
  if (patches.spawnSync) childProcess.spawnSync = patches.spawnSync;

  try {
    return loadHostMonitoring();
  } finally {
    childProcess.execFile = originalExecFile;
    childProcess.spawnSync = originalSpawnSync;
  }
}

function mockRequestResponse({ statusCode = 200, body = '', error = null, timeout = false }) {
  const req = new EventEmitter();
  req.setTimeout = vi.fn();
  req.destroy = vi.fn();

  const res = new EventEmitter();
  res.statusCode = statusCode;

  process.nextTick(() => {
    if (timeout) {
      req.emit('timeout');
      return;
    }
    if (error) {
      req.emit('error', error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (typeof body !== 'string') {
      res.emit('data', JSON.stringify(body));
    } else if (body) {
      res.emit('data', body);
    }
    res.emit('end');
  });

  return { req, res };
}

function addHost(overrides = {}) {
  const id = overrides.id || `hm-host-${Math.random().toString(36).slice(2, 10)}`;

  hostManagement.addOllamaHost({
    id,
    name: overrides.name || id,
    url: overrides.url || `http://203.0.113.${Math.floor(Math.random() * 200) + 1}:11434`,
    max_concurrent: overrides.maxConcurrent || 4,
    memory_limit_mb: overrides.memoryLimitMb,
  });

  if (overrides.status || overrides.consecutiveFailures != null || overrides.models || overrides.gpu_metrics_port) {
    const updates = {};
    if (overrides.status) updates.status = overrides.status;
    if (overrides.consecutiveFailures != null) updates.consecutive_failures = overrides.consecutiveFailures;
    if (overrides.models) {
      updates.models_cache = JSON.stringify(overrides.models);
      updates.models_updated_at = new Date().toISOString();
    }
    if (overrides.memoryLimitMb != null) updates.memory_limit_mb = overrides.memoryLimitMb;
    if (overrides.gpu_metrics_port != null) updates.gpu_metrics_port = overrides.gpu_metrics_port;

    if (Object.keys(updates).length > 0) {
      hostManagement.updateOllamaHost(id, updates);
    }
  }

  return id;
}

describe('host-monitoring utility module', () => {
  beforeAll(() => {
    ({ db } = setupTestDbOnly('host-monitoring'));
    configCore = require('../db/config-core');
  });

  beforeEach(() => {
    const conn = db.getDb ? db.getDb() : db.getDbInstance();
    for (const table of ['tasks', 'ollama_hosts']) {
      try { conn.prepare(`DELETE FROM ${table}`).run(); } catch { /* ignore */ }
    }

    monitoring = loadHostMonitoring();
    monitoring.init({
      db,
      dashboard: { notifyHostActivityUpdated: vi.fn() },
      cleanupOrphanedHostTasks: vi.fn(),
      queueLockHolderId: 'monitoring-utils',
    });

    monitoring.hostActivityCache.clear();
  });

  afterEach(() => {
    if (monitoring && monitoring.stopTimers) {
      monitoring.stopTimers();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (monitoring && monitoring.hostActivityCache) {
      monitoring.hostActivityCache.clear();
    }
  });

  afterAll(() => {
    if (db && db.close) {
      try { db.close(); } catch { /* ignore */ }
    }
  });

  describe('normalizeModelName', () => {
    it('normalizes case and strips :latest', () => {
      expect(monitoring.normalizeModelName('QWEN3:7B:latest')).toBe('qwen3:7b');
      expect(monitoring.normalizeModelName('gpt-4')).toBe('gpt-4');
      expect(monitoring.normalizeModelName(null)).toBe('');
    });
  });

  describe('isModelLoadedOnHost', () => {
    it('returns null when no activity is available', () => {
      expect(monitoring.isModelLoadedOnHost('missing-host', TEST_MODELS.SMALL)).toBeNull();
    });

    it('returns false for malformed cache data', () => {
      monitoring.hostActivityCache.set('bad-cache', {
        models: null,
      });

      expect(monitoring.isModelLoadedOnHost('bad-cache', TEST_MODELS.SMALL)).toBeNull();
    });

    it('detects loaded models using name and model fields', () => {
      monitoring.hostActivityCache.set('good-cache', {
        models: [
          { model: 'codellama:latest' },
          { name: TEST_MODELS.SMALL },
        ],
      });

      expect(monitoring.isModelLoadedOnHost('good-cache', TEST_MODELS.SMALL)).toBe(true);
      expect(monitoring.isModelLoadedOnHost('good-cache', 'codellama')).toBe(true);
      expect(monitoring.isModelLoadedOnHost('good-cache', 'missing')).toBe(false);
    });
  });

  describe('getHostActivity', () => {
    it('returns normalized activity payload with totals', () => {
      const polledAt = Date.now();
      monitoring.hostActivityCache.set('h1', {
        models: [
          { name: TEST_MODELS.DEFAULT, size_vram: 2_000_000_000, expires_at: '2026-01-01T00:00:00Z' },
          { name: 'mistral:7b', size_vram: 500_000_000, expires_at: '2026-01-01T00:00:00Z' },
        ],
        polledAt,
        gpuMetrics: {
          gpuUtilizationPercent: 12,
          vramUsedMb: 120,
          vramTotalMb: 8192,
          synthetic: true,
        },
      });
      monitoring.hostActivityCache.set('h2', {
        models: [{ name: 'llama3:8b', size_vram: 200_000_000 }],
        polledAt,
        gpuMetrics: null,
      });

      const activity = monitoring.getHostActivity();
      expect(activity).toHaveProperty('h1');
      expect(activity).toHaveProperty('h2');
      expect(activity.h1.totalVramUsed).toBe(2500000000);
      expect(activity.h1.loadedModels).toHaveLength(2);
      expect(activity.h1.gpuMetrics.synthetic).toBe(true);
      expect(activity.h2.loadedModels).toEqual([{ name: 'llama3:8b', sizeVram: 200000000, expiresAt: undefined }]);
    });

    it('includes cached cpuPercent and ramPercent in gpuMetrics', () => {
      monitoring.hostActivityCache.set('h1', {
        models: [],
        polledAt: Date.now(),
        gpuMetrics: {
          gpuUtilizationPercent: 12,
          vramUsedMb: 120,
          vramTotalMb: 8192,
          cpuPercent: 48,
          ramPercent: 73,
        },
      });

      const activity = monitoring.getHostActivity();
      expect(activity.h1.gpuMetrics.cpuPercent).toBe(48);
      expect(activity.h1.gpuMetrics.ramPercent).toBe(73);
    });

    it('returns undefined cpuPercent and ramPercent when gpuMetrics does not include them', () => {
      monitoring.hostActivityCache.set('h1', {
        models: [],
        polledAt: Date.now(),
        gpuMetrics: {
          gpuUtilizationPercent: 12,
          vramUsedMb: 120,
          vramTotalMb: 8192,
        },
      });

      const activity = monitoring.getHostActivity();
      expect(activity.h1.gpuMetrics.cpuPercent).toBeUndefined();
      expect(activity.h1.gpuMetrics.ramPercent).toBeUndefined();
    });
  });

  describe('runHostHealthChecks', () => {
    it('marks a host healthy and refreshes model cache', async () => {
      const hostId = addHost({ url: 'http://127.0.0.1:11434', status: 'unknown' });

      const getSpy = vi.spyOn(http, 'get');
      getSpy.mockImplementation((url, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        const { req, res } = mockRequestResponse({
          statusCode: 200,
          body: { models: [{ name: TEST_MODELS.SMALL }, { name: 'codellama:latest' }] },
        });
        cb(res);
        return req;
      });

      await monitoring.runHostHealthChecks();

      const host = hostManagement.getOllamaHost(hostId);
      expect(host.status).toBe('healthy');
      expect(host.consecutive_failures).toBe(0);
      expect(host.models).toEqual([TEST_MODELS.SMALL, 'codellama:latest']);
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it('tracks consecutive failures and transitions healthy→degraded→down', async () => {
      const hostId = addHost({ url: 'http://127.0.0.1:11435', status: 'unknown' });

      const getSpy = vi.spyOn(http, 'get').mockImplementation((url, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        const { req, res } = mockRequestResponse({
          statusCode: 503,
          body: { error: 'down' },
        });
        cb(res);
        return req;
      });

      await monitoring.runHostHealthChecks();
      expect(hostManagement.getOllamaHost(hostId).status).toBe('degraded');
      expect(hostManagement.getOllamaHost(hostId).consecutive_failures).toBe(1);

      await monitoring.runHostHealthChecks();
      expect(hostManagement.getOllamaHost(hostId).status).toBe('degraded');
      expect(hostManagement.getOllamaHost(hostId).consecutive_failures).toBe(2);

      await monitoring.runHostHealthChecks();
      expect(hostManagement.getOllamaHost(hostId).status).toBe('down');
      expect(hostManagement.getOllamaHost(hostId).consecutive_failures).toBe(3);
      expect(getSpy).toHaveBeenCalledTimes(3);
    });

    it('calls orphan cleanup callback once when host transitions to down', async () => {
      const hostId = addHost({ url: 'http://127.0.0.1:11436', status: 'healthy' });
      const cleanupSpy = vi.fn();
      monitoring.init({
        db,
        dashboard: { notifyHostActivityUpdated: vi.fn() },
        cleanupOrphanedHostTasks: cleanupSpy,
        queueLockHolderId: 'monitoring-utils',
      });

      const getSpy = vi.spyOn(http, 'get').mockImplementation((url, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        const { req, res } = mockRequestResponse({ statusCode: 500, body: 'error' });
        cb(res);
        return req;
      });

      await monitoring.runHostHealthChecks();
      await monitoring.runHostHealthChecks();
      await monitoring.runHostHealthChecks();

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith(hostId, hostId);
      expect(getSpy).toHaveBeenCalledTimes(3);
    });

    it('auto-recovers down hosts and does not trigger orphan cleanup', async () => {
      const hostId = addHost({
        id: 'recover-host',
        url: 'http://127.0.0.1:11437',
        status: 'down',
        consecutiveFailures: 4,
        models: [{ name: 'old-model' }],
      });
      const cleanupSpy = vi.fn();
      monitoring.init({
        db,
        dashboard: { notifyHostActivityUpdated: vi.fn() },
        cleanupOrphanedHostTasks: cleanupSpy,
        queueLockHolderId: 'monitoring-utils',
      });

      const recoverSpy = vi.spyOn(db, 'recoverOllamaHost');
      const getSpy = vi.spyOn(http, 'get').mockImplementation((url, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        const { req, res } = mockRequestResponse({
          statusCode: 200,
          body: { models: [{ name: 'new-model' }] },
        });
        cb(res);
        return req;
      });

      await monitoring.runHostHealthChecks();

      const host = hostManagement.getOllamaHost(hostId);
      expect(recoverSpy).toHaveBeenCalledWith(hostId);
      expect(cleanupSpy).not.toHaveBeenCalled();
      expect(host.status).toBe('healthy');
      expect(host.consecutive_failures).toBe(0);
      expect(host.models).toEqual(['new-model']);
      expect(getSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('probeCodexRecovery', () => {
    const originalApiKey = process.env.OPENAI_API_KEY;

    afterEach(() => {
      if (originalApiKey !== undefined) {
        process.env.OPENAI_API_KEY = originalApiKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });

    it('clears exhausted flag when API probe returns 200', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      configCore.setConfig('codex_exhausted', '1');
      configCore.setConfig('codex_probe_interval_minutes', '0');
      configCore.setConfig('codex_exhausted_at', new Date(Date.now() - 3600_000).toISOString());

      const spawnSpy = vi.spyOn(childProcess, 'spawnSync');
      const requestSpy = vi.spyOn(https, 'request').mockImplementation((options, callback) => {
        const { req, res } = mockRequestResponse({ statusCode: 200, body: { data: [] } });
        callback(res);
        return req;
      });

      await monitoring.probeCodexRecovery();

      expect(configCore.getConfig('codex_exhausted')).toBe('1');
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('keeps exhausted flag when API returns 429 and reschedules', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      configCore.setConfig('codex_exhausted', '1');
      configCore.setConfig('codex_probe_interval_minutes', '0');
      configCore.setConfig('codex_exhausted_at', new Date(Date.now() - 3600_000).toISOString());

      const requestSpy = vi.spyOn(https, 'request').mockImplementation((options, callback) => {
        const { req, res } = mockRequestResponse({ statusCode: 429, body: { error: { message: 'rate limit' } } });
        callback(res);
        return req;
      });

      await monitoring.probeCodexRecovery();

      expect(configCore.getConfig('codex_exhausted')).toBe('1');
      expect(configCore.getConfig('codex_exhausted_at')).toBeTruthy();
      expect(requestSpy).toHaveBeenCalledTimes(1);
    });

    it('respects interval backoff before probing', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      configCore.setConfig('codex_exhausted', '1');
      configCore.setConfig('codex_probe_interval_minutes', '15');
      configCore.setConfig('codex_exhausted_at', new Date().toISOString());

      const requestSpy = vi.spyOn(https, 'request');
      const spawnSpy = vi.spyOn(childProcess, 'spawnSync');

      await monitoring.probeCodexRecovery();

      expect(requestSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('falls back to CLI probe when OpenAI key is missing', async () => {
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 0 });
      monitoring = loadHostMonitoringWithChildProcessPatches({
        spawnSync: spawnSyncMock,
      });
      monitoring.init({
        db,
        dashboard: { notifyHostActivityUpdated: vi.fn() },
        cleanupOrphanedHostTasks: vi.fn(),
        queueLockHolderId: 'monitoring-utils',
      });

      delete process.env.OPENAI_API_KEY;
      configCore.setConfig('codex_exhausted', '1');
      configCore.setConfig('codex_probe_interval_minutes', '0');
      configCore.setConfig('codex_exhausted_at', new Date(Date.now() - 3600_000).toISOString());

      await monitoring.probeCodexRecovery();

      expect(spawnSyncMock).toHaveBeenCalledWith('npx', ['codex', '--version'], expect.any(Object));
      expect(configCore.getConfig('codex_exhausted')).toBe('1');
    });
  });

  describe('pollHostActivity', () => {
    it('polls healthy hosts, prunes stale cache entries, and notifies dashboard', async () => {
      addHost({ id: 'healthy-host', url: 'http://203.0.113.10:11434', status: 'healthy' });
      addHost({ id: 'down-host', url: 'http://203.0.113.11:11434', status: 'down' });

      monitoring.hostActivityCache.set('stale-host', {
        models: [{ name: 'stale', size_vram: 100 }],
      });

      const dashboard = { notifyHostActivityUpdated: vi.fn() };
      monitoring.init({
        db,
        dashboard,
        cleanupOrphanedHostTasks: vi.fn(),
        queueLockHolderId: 'monitoring-utils',
      });

      const getSpy = vi.spyOn(http, 'get').mockImplementation((target, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        const { pathname } = new URL(typeof target === 'string' ? target : target.href);
        if (pathname !== '/api/ps') {
          const { req: errReq, res: errRes } = mockRequestResponse({ statusCode: 404, body: 'not found' });
          cb(errRes);
          return errReq;
        }

        const { req, res } = mockRequestResponse({
          statusCode: 200,
          body: { models: [{ name: TEST_MODELS.SMALL, size_vram: 100 }] },
        });
        cb(res);
        return req;
      });

      await monitoring.pollHostActivity();

      const activity = monitoring.getHostActivity();
      const hostIds = Object.keys(activity);
      expect(hostIds).toContain('healthy-host');
      expect(hostIds).not.toContain('stale-host');
      expect(activity['healthy-host'].loadedModels).toEqual([{ name: TEST_MODELS.SMALL, sizeVram: 100, expiresAt: undefined }]);
      expect(dashboard.notifyHostActivityUpdated).toHaveBeenCalledTimes(1);
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it('emits host_overloaded event when CPU/RAM exceeds threshold', async () => {
      addHost({ id: 'overloaded-host', url: 'http://203.0.113.12:11434', status: 'healthy' });

      const dashboard = {
        notifyHostActivityUpdated: vi.fn(),
        broadcast: vi.fn(),
      };
      monitoring.init({
        db,
        dashboard,
        cleanupOrphanedHostTasks: vi.fn(),
        queueLockHolderId: 'monitoring-utils',
      });

      monitoring.hostActivityCache.set('overloaded-host', {
        models: [],
        polledAt: Date.now(),
        gpuMetrics: {
          gpuUtilizationPercent: 12,
          vramUsedMb: 256,
          vramTotalMb: 8192,
          cpuPercent: 91,
          ramPercent: 88,
        },
      });

      const getSpy = vi.spyOn(http, 'get').mockImplementation((target, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        const { pathname } = new URL(typeof target === 'string' ? target : target.href);
        if (pathname !== '/api/ps') {
          const { req: errReq, res: errRes } = mockRequestResponse({ statusCode: 404, body: 'not found' });
          cb(errRes);
          return errReq;
        }

        const { req, res } = mockRequestResponse({
          statusCode: 200,
          body: { models: [{ name: TEST_MODELS.SMALL, size_vram: 100 }] },
        });
        cb(res);
        return req;
      });

      await monitoring.pollHostActivity();

      expect(dashboard.notifyHostActivityUpdated).toHaveBeenCalledTimes(1);
      expect(dashboard.broadcast).toHaveBeenCalledTimes(1);
      expect(dashboard.notifyHostActivityUpdated.mock.invocationCallOrder[0]).toBeLessThan(
        dashboard.broadcast.mock.invocationCallOrder[0]
      );
      expect(dashboard.broadcast).toHaveBeenCalledWith('hosts:resource-pressure', {
        hostId: 'overloaded-host',
        cpuPercent: 91,
        ramPercent: 88,
        timestamp: expect.any(Number),
      });
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it('hydrates GPU metrics from remote endpoint and synthetic fallback', async () => {
      addHost({
        id: 'remote-metrics',
        url: 'http://203.0.113.20:11434',
        status: 'healthy',
        gpu_metrics_port: 9443,
      });
      addHost({
        id: 'remote-synthetic',
        url: 'http://203.0.113.21:11434',
        status: 'healthy',
        memoryLimitMb: 8192,
      });

      vi.spyOn(http, 'get').mockImplementation((target, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        const parsed = new URL(typeof target === 'string' ? target : target.href);

        if (parsed.pathname === '/api/ps') {
          const hostId = parsed.port === '11434' ? parsed.hostname : null;
          const responseBody = {
            models: [{
              name: hostId === '203.0.113.20' ? TEST_MODELS.SMALL : 'llama3:latest',
              size_vram: hostId === '203.0.113.20' ? 1_000_000_000 : 500_000_000,
            }],
          };
          const { req, res } = mockRequestResponse({ statusCode: 200, body: responseBody });
          cb(res);
          return req;
        }

        if (parsed.pathname === '/metrics') {
          const { req, res } = mockRequestResponse({
            statusCode: 200,
            body: {
              gpuUtilizationPercent: 17,
              vramUsedMb: 2048,
              vramTotalMb: 8192,
              temperatureC: 70,
              powerDrawW: 120,
              synthetic: false,
            },
          });
          cb(res);
          return req;
        }

        const { req, res } = mockRequestResponse({ statusCode: 404, body: 'not found' });
        cb(res);
        return req;
      });

      await monitoring.pollHostActivity();

      const activity = monitoring.getHostActivity();
      expect(activity['remote-metrics'].gpuMetrics).toEqual({
        gpuUtilizationPercent: 17,
        vramUsedMb: 2048,
        vramTotalMb: 8192,
        temperatureC: 70,
        powerDrawW: 120,
        synthetic: false,
      });
      expect(activity['remote-synthetic'].gpuMetrics.synthetic).toBe(true);
      expect(activity['remote-synthetic'].gpuMetrics.vramTotalMb).toBe(8192);
      expect(activity['remote-synthetic'].gpuMetrics.gpuUtilizationPercent).toBeNull();
    });
  });

  describe('probeLocalGpuMetrics', () => {
    it('parses nvidia-smi output into gpuMetrics when available', async () => {
      const hostId = addHost({ id: 'local-gpu', url: 'http://127.0.0.1:11434', status: 'healthy' });
      const execFileMock = vi.fn((command, args, _options, callback) => {
        if (Array.isArray(args) && args[0] === '--version') {
          callback(null, 'nvidia-smi 3.0');
          return;
        }

        callback(null, '27, 12345, 8192, 61, 145.2');
      });

      monitoring = loadHostMonitoringWithChildProcessPatches({
        execFile: execFileMock,
      });

      monitoring.init({
        db,
        dashboard: { notifyHostActivityUpdated: vi.fn() },
        cleanupOrphanedHostTasks: vi.fn(),
        queueLockHolderId: 'monitoring-utils',
      });

      const host = hostManagement.getOllamaHost(hostId);

      await monitoring.probeLocalGpuMetrics([host]);

      const after = monitoring.getHostActivity();
      expect(after[hostId].gpuMetrics.gpuUtilizationPercent).toBe(27);
      expect(after[hostId].gpuMetrics.vramUsedMb).toBe(12345);
      expect(after[hostId].gpuMetrics.vramTotalMb).toBe(8192);
      expect(after[hostId].gpuMetrics.temperatureC).toBe(61);
      expect(after[hostId].gpuMetrics.powerDrawW).toBe(145.2);
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('probeRemoteGpuMetrics', () => {
    it('preserves existing gpuMetrics until endpoint updates succeed', async () => {
      const hostId = addHost({
        id: 'remote-fallback-host',
        url: 'http://203.0.113.30:11434',
        status: 'healthy',
        gpu_metrics_port: 9009,
        models: [{ name: TEST_MODELS.SMALL, size_vram: 1000_000_000 }],
        memoryLimitMb: 8192,
      });

      const host = hostManagement.getOllamaHost(hostId);
      monitoring.hostActivityCache.set(hostId, {
        models: host.models,
        polledAt: Date.now(),
        gpuMetrics: null,
      });

      const getSpy = vi.spyOn(http, 'get').mockImplementation((target, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        const { req, res } = mockRequestResponse({
          statusCode: 200,
          body: {
            gpuUtilizationPercent: 11,
            vramUsedMb: 1000,
            vramTotalMb: 8192,
            temperatureC: 50,
            powerDrawW: 80,
          },
        });
        cb(res);
        return req;
      });

      await monitoring.probeRemoteGpuMetrics([host]);

      const activity = monitoring.getHostActivity();
      expect(activity[hostId].gpuMetrics.gpuUtilizationPercent).toBe(11);
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it('clears gpuMetrics when /metrics endpoint errors', async () => {
      const hostId = addHost({
        id: 'remote-errors',
        url: 'http://203.0.113.31:11434',
        status: 'healthy',
        gpu_metrics_port: 9010,
        memoryLimitMb: 8192,
      });
      const host = hostManagement.getOllamaHost(hostId);
      monitoring.hostActivityCache.set(hostId, {
        models: host.models,
        polledAt: Date.now(),
        gpuMetrics: { gpuUtilizationPercent: 10 },
      });

      const getSpy = vi.spyOn(http, 'get').mockImplementation((target, _options, callback) => {
        const cb = typeof _options === 'function' ? _options : callback;
        const { req, res } = mockRequestResponse({ statusCode: 500, error: new Error('metrics unavailable') });
        cb(res);
        return req;
      });

      await monitoring.probeRemoteGpuMetrics([host]);

      const activity = monitoring.getHostActivity();
      expect(activity[hostId].gpuMetrics).toEqual({
        gpuUtilizationPercent: null,
        temperatureC: null,
        powerDrawW: null,
        synthetic: true,
        vramUsedMb: 0,
        vramTotalMb: 8192,
      });
      expect(getSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('findNvidiaSmi', () => {
    it('returns a valid command path when one command succeeds', async () => {
      const execFileMock = vi.fn((command, args, _options, callback) => {
        if (Array.isArray(args) && args[0] === '--version') {
          callback(null, 'nvidia-smi 3.0');
          return;
        }

        callback(null, '');
      });
      const moduleWithMock = loadHostMonitoringWithChildProcessPatches({
        execFile: execFileMock,
      });

      moduleWithMock.init({
        db,
        dashboard: { notifyHostActivityUpdated: vi.fn() },
        cleanupOrphanedHostTasks: vi.fn(),
        queueLockHolderId: 'monitoring-utils',
      });

      const result = await moduleWithMock.findNvidiaSmi();
      expect(execFileMock).toHaveBeenCalled();
      expect(typeof result).toBe('string');
      expect(result).toContain('nvidia-smi');
      monitoring = moduleWithMock;
    });

    it('returns null when all candidates fail', async () => {
      const execFileMock = vi.fn((_command, _args, _options, callback) => {
        callback(new Error('missing'));
      });
      const moduleWithMock = loadHostMonitoringWithChildProcessPatches({
        execFile: execFileMock,
      });
      moduleWithMock.init({
        db,
        dashboard: { notifyHostActivityUpdated: vi.fn() },
        cleanupOrphanedHostTasks: vi.fn(),
        queueLockHolderId: 'monitoring-utils',
      });

      const result = await moduleWithMock.findNvidiaSmi();
      expect(result).toBeNull();
      monitoring = moduleWithMock;
    });
  });

  describe('initializeDiscovery', () => {
    const discoveryModulePath = require.resolve('../discovery');
    let discoveryBackup;

    function withFakeDiscovery(disabled, callback) {
      const fakeDiscovery = {
        initDiscovery: vi.fn(),
        initAutoScanFromConfig: vi.fn(),
        stopAutoScan: vi.fn(),
        shutdownDiscovery: vi.fn(),
      };
      const serverConfig = require('../config');
      const getBoolSpy = vi.spyOn(serverConfig, 'getBool').mockImplementation((key) => {
        if (key === 'discovery_enabled') return !disabled;
        return true;
      });
      discoveryBackup = require.cache[discoveryModulePath];
      require.cache[discoveryModulePath] = { exports: fakeDiscovery };

      const discoveryDb = {
        getConfig: vi.fn((key) => (key === 'discovery_enabled' ? (disabled ? '0' : '1') : '1')),
      };

      const fakeMon = loadHostMonitoring();
      fakeMon.init({
        db: discoveryDb,
        dashboard: { notifyHostActivityUpdated: vi.fn() },
        cleanupOrphanedHostTasks: vi.fn(),
        queueLockHolderId: 'monitoring-utils',
      });

      const restore = () => {
        getBoolSpy.mockRestore();
        if (discoveryBackup) {
          require.cache[discoveryModulePath] = discoveryBackup;
        } else {
          delete require.cache[discoveryModulePath];
        }
      };

      return callback(fakeMon, fakeDiscovery, restore);
    }

    it('skips discovery init when discovery_enabled=0', () => {
      vi.useFakeTimers();

      withFakeDiscovery(true, (fakeMon, fakeDiscovery, restore) => {
        fakeMon.initializeDiscovery();
        vi.advanceTimersByTime(1000);

        expect(fakeDiscovery.initDiscovery).not.toHaveBeenCalled();
        expect(fakeDiscovery.initAutoScanFromConfig).not.toHaveBeenCalled();
        restore();
      });
    });

    it('initializes discovery and registers shutdown handlers', () => {
      vi.useFakeTimers();

      const signalBefore = process.listenerCount('SIGTERM');
      withFakeDiscovery(false, (fakeMon, fakeDiscovery, restore) => {
        fakeMon.initializeDiscovery();
        vi.advanceTimersByTime(1000);

        expect(fakeDiscovery.initDiscovery).toHaveBeenCalledTimes(1);
        expect(fakeDiscovery.initAutoScanFromConfig).toHaveBeenCalledTimes(1);

        process.emit('SIGTERM');
        expect(fakeDiscovery.stopAutoScan).toHaveBeenCalledTimes(1);
        expect(fakeDiscovery.shutdownDiscovery).toHaveBeenCalledTimes(1);

        fakeMon.stopTimers();
        restore();
        expect(process.listenerCount('SIGTERM')).toBeLessThanOrEqual(signalBefore);
      });
    });
  });

  describe('startTimers and stopTimers', () => {
    it('schedules startup checks and stops when stopTimers is called', async () => {
      vi.useFakeTimers();

      const mockDb = {
        getConfig: vi.fn((key) => {
          const map = {
            discovery_enabled: '0',
            health_check_interval_seconds: '9999',
            activity_poll_interval_seconds: '9999',
          };
          return map[key] || null;
        }),
        acquireLock: vi.fn().mockReturnValue({ acquired: true }),
        listOllamaHosts: vi.fn().mockReturnValue([]),
        ensureModelsLoaded: vi.fn(),
      };

      const fakeMon = loadHostMonitoring();
      fakeMon.init({
        db: mockDb,
        dashboard: { notifyHostActivityUpdated: vi.fn() },
        cleanupOrphanedHostTasks: vi.fn(),
        queueLockHolderId: 'timer-suite',
      });

      fakeMon.startTimers();
      vi.advanceTimersByTime(7000);

      expect(mockDb.listOllamaHosts).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10000);

      expect(mockDb.listOllamaHosts).toHaveBeenCalledTimes(3);

      fakeMon.stopTimers();
      const currentCalls = mockDb.listOllamaHosts.mock.calls.length;
      vi.advanceTimersByTime(20000);

      expect(mockDb.listOllamaHosts).toHaveBeenCalledTimes(currentCalls);
      fakeMon.stopTimers();
      vi.useRealTimers();
    });

    it('starts no timers if canceled before bootstrap timeouts fire', () => {
      vi.useFakeTimers();

      const mockDb = {
        getConfig: vi.fn((key) => {
          const map = {
            discovery_enabled: '0',
            health_check_interval_seconds: '1',
            activity_poll_interval_seconds: '1',
          };
          return map[key] || null;
        }),
        acquireLock: vi.fn().mockReturnValue({ acquired: true }),
        listOllamaHosts: vi.fn().mockReturnValue([]),
        ensureModelsLoaded: vi.fn(),
      };

      const fakeMon = loadHostMonitoring();
      fakeMon.init({
        db: mockDb,
        dashboard: { notifyHostActivityUpdated: vi.fn() },
        cleanupOrphanedHostTasks: vi.fn(),
        queueLockHolderId: 'timer-suite',
      });

      fakeMon.startTimers();
      fakeMon.stopTimers();
      vi.advanceTimersByTime(20000);

      expect(mockDb.listOllamaHosts).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
