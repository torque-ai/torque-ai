'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const HEALTH_PROBES_MODULE = '../api/health-probes';
const DATABASE_MODULE = '../database';
const TOOLS_MODULE = '../tools';
const MIDDLEWARE_MODULE = '../api/middleware';
const MODULE_PATHS = [
  HEALTH_PROBES_MODULE,
  DATABASE_MODULE,
  TOOLS_MODULE,
  MIDDLEWARE_MODULE,
];

let mockDb;
let mockTools;
let mockMiddleware;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore modules that were never loaded in this test process.
  }
}

function clearModules() {
  for (const modulePath of MODULE_PATHS) {
    clearModule(modulePath);
  }
}

function createMockDb() {
  return {
    getDbInstance: vi.fn(() => ({ open: true })),
    isDbClosed: vi.fn(() => false),
    countTasks: vi.fn(({ status } = {}) => {
      if (status === 'queued') return 3;
      if (status === 'running') return 1;
      return 0;
    }),
  };
}

function createMockTools() {
  return {
    handleToolCall: vi.fn(async () => ({
      content: [{ type: 'text', text: 'healthy' }],
    })),
  };
}

function createMockMiddleware() {
  return {
    sendJson: vi.fn((res, payload, status = 200, req) => {
      res.statusCode = status;
      res.body = payload;
      res.request = req;
    }),
  };
}

function loadHealthProbes() {
  clearModules();
  installCjsModuleMock(DATABASE_MODULE, mockDb);
  installCjsModuleMock(TOOLS_MODULE, mockTools);
  installCjsModuleMock(MIDDLEWARE_MODULE, mockMiddleware);
  return require(HEALTH_PROBES_MODULE);
}

function createReq(overrides = {}) {
  return {
    method: 'GET',
    url: '/healthz',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

function createRes() {
  return {};
}

function freezeNow(startMs = 1_000_000) {
  let nowMs = startMs;
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  return {
    set(value) {
      nowMs = value;
    },
    advance(ms) {
      nowMs += ms;
    },
  };
}

beforeEach(() => {
  vi.useRealTimers();
  mockDb = createMockDb();
  mockTools = createMockTools();
  mockMiddleware = createMockMiddleware();
  clearModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearModules();
});

describe('api/health-probes', () => {
  describe('module surface', () => {
    it('exports only the current liveness, readiness, and health handlers', () => {
      const probes = loadHealthProbes();

      expect(Object.keys(probes).sort()).toEqual([
        'handleHealthz',
        'handleLivez',
        'handleReadyz',
      ]);
    });
  });

  describe('handleLivez', () => {
    it('returns 200 with ok status and the raw process uptime', () => {
      const probes = loadHealthProbes();
      const req = createReq({ url: '/livez' });
      const res = createRes();

      vi.spyOn(process, 'uptime').mockReturnValue(42.5);

      probes.handleLivez(req, res);

      expect(mockMiddleware.sendJson).toHaveBeenCalledWith(
        res,
        { status: 'ok', uptime: 42.5 },
        200,
        req,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ status: 'ok', uptime: 42.5 });
    });

    it('does not touch the database or Ollama dependencies', () => {
      const probes = loadHealthProbes();

      probes.handleLivez(createReq({ url: '/livez' }), createRes(), { ignored: true });

      expect(mockDb.getDbInstance).not.toHaveBeenCalled();
      expect(mockDb.countTasks).not.toHaveBeenCalled();
      expect(mockTools.handleToolCall).not.toHaveBeenCalled();
    });
  });

  describe('handleReadyz', () => {
    it('returns ready once startup warm-up reaches 5 seconds and the database is accessible', () => {
      const clock = freezeNow(10_000);
      const probes = loadHealthProbes();
      const req = createReq({ url: '/readyz' });
      const res = createRes();

      clock.advance(5_000);
      probes.handleReadyz(req, res);

      expect(mockDb.countTasks).toHaveBeenCalledTimes(1);
      expect(mockDb.countTasks).toHaveBeenCalledWith({ status: 'running' });
      expect(mockMiddleware.sendJson).toHaveBeenCalledWith(res, { status: 'ready' }, 200, req);
      expect(res.body).toEqual({ status: 'ready' });
    });

    it('returns not ready just before the 5 second warm-up threshold even when the database is accessible', () => {
      const clock = freezeNow(20_000);
      const probes = loadHealthProbes();
      const res = createRes();

      clock.advance(4_999);
      probes.handleReadyz(createReq({ url: '/readyz' }), res);

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        status: 'not ready',
        reasons: ['server warming up (5s < 5s)'],
      });
    });

    it('includes both database initialization and warm-up reasons during startup', () => {
      const clock = freezeNow(30_000);
      mockDb.getDbInstance.mockReturnValue(null);
      const probes = loadHealthProbes();
      const res = createRes();

      clock.advance(2_000);
      probes.handleReadyz(createReq({ url: '/readyz' }), res);

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        status: 'not ready',
        reasons: [
          'database not initialized',
          'server warming up (2s < 5s)',
        ],
      });
    });

    it('treats a closed database handle as not initialized', () => {
      const clock = freezeNow(40_000);
      mockDb.isDbClosed.mockReturnValue(true);
      const probes = loadHealthProbes();
      const res = createRes();

      clock.advance(6_000);
      probes.handleReadyz(createReq({ url: '/readyz' }), res);

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        status: 'not ready',
        reasons: ['database not initialized'],
      });
    });

    it('reports database not accessible when the readiness probe query throws', () => {
      const clock = freezeNow(50_000);
      mockDb.countTasks.mockImplementation(() => {
        throw new Error('readiness probe failed');
      });
      const probes = loadHealthProbes();
      const res = createRes();

      clock.advance(6_000);
      probes.handleReadyz(createReq({ url: '/readyz' }), res);

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        status: 'not ready',
        reasons: ['database not accessible'],
      });
    });

    it('treats a missing isDbClosed helper as an open database', () => {
      const clock = freezeNow(60_000);
      delete mockDb.isDbClosed;
      const probes = loadHealthProbes();
      const res = createRes();

      clock.advance(6_000);
      probes.handleReadyz(createReq({ url: '/readyz' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ status: 'ready' });
    });

    it('treats a missing getDbInstance helper as a not initialized database', () => {
      const clock = freezeNow(70_000);
      delete mockDb.getDbInstance;
      const probes = loadHealthProbes();
      const res = createRes();

      clock.advance(6_000);
      probes.handleReadyz(createReq({ url: '/readyz' }), res);

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        status: 'not ready',
        reasons: ['database not initialized'],
      });
    });

    it('passes the originating request object to sendJson', () => {
      const clock = freezeNow(80_000);
      const probes = loadHealthProbes();
      const req = createReq({
        url: '/readyz',
        headers: { 'x-request-id': 'req-readyz' },
      });
      const res = createRes();

      clock.advance(6_000);
      probes.handleReadyz(req, res);

      expect(res.request).toBe(req);
    });

    it('rounds warm-up duration in the not ready reason', () => {
      const clock = freezeNow(90_000);
      const probes = loadHealthProbes();
      const res = createRes();

      clock.advance(3_400);
      probes.handleReadyz(createReq({ url: '/readyz' }), res);

      expect(res.body).toEqual({
        status: 'not ready',
        reasons: ['server warming up (3s < 5s)'],
      });
    });
  });

  describe('handleHealthz', () => {
    it('returns healthy when the database is accessible and Ollama is healthy', async () => {
      const probes = loadHealthProbes();
      const req = createReq({ url: '/healthz' });
      const res = createRes();

      vi.spyOn(process, 'uptime').mockReturnValue(12.6);
      mockDb.countTasks.mockImplementation(({ status } = {}) => {
        if (status === 'queued') return 7;
        if (status === 'running') return 2;
        return 0;
      });

      await probes.handleHealthz(req, res);

      expect(mockTools.handleToolCall).toHaveBeenCalledWith('check_ollama_health', {
        force_check: false,
      });
      expect(mockDb.countTasks.mock.calls).toEqual([
        [{ status: 'running' }],
        [{ status: 'queued' }],
        [{ status: 'running' }],
      ]);
      expect(mockMiddleware.sendJson).toHaveBeenCalledWith(
        res,
        {
          status: 'healthy',
          uptime_seconds: 13,
          database: 'connected',
          ollama: 'healthy',
          queue_depth: 7,
          running_tasks: 2,
        },
        200,
        req,
      );
    });

    it('omits database_reason when the database probe succeeds', async () => {
      const probes = loadHealthProbes();
      const res = createRes();

      mockDb.countTasks.mockImplementation(({ status } = {}) => {
        if (status === 'queued') return 0;
        if (status === 'running') return 0;
        return 0;
      });

      await probes.handleHealthz(createReq({ url: '/healthz' }), res);

      expect(res.body).not.toHaveProperty('database_reason');
      expect(res.body.queue_depth).toBe(0);
      expect(res.body.running_tasks).toBe(0);
    });

    it('returns degraded when Ollama reports an unhealthy status', async () => {
      const probes = loadHealthProbes();
      const res = createRes();

      mockTools.handleToolCall.mockResolvedValue({
        content: [{ type: 'text', text: 'service unhealthy' }],
      });

      await probes.handleHealthz(createReq({ url: '/healthz' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.ollama).toBe('unhealthy');
    });

    it('treats a missing Ollama health text payload as unhealthy', async () => {
      const probes = loadHealthProbes();
      const res = createRes();

      mockTools.handleToolCall.mockResolvedValue({});

      await probes.handleHealthz(createReq({ url: '/healthz' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.ollama).toBe('unhealthy');
    });

    it('treats uppercase healthy text as unhealthy because the match is case sensitive', async () => {
      const probes = loadHealthProbes();
      const res = createRes();

      mockTools.handleToolCall.mockResolvedValue({
        content: [{ type: 'text', text: 'HEALTHY' }],
      });

      await probes.handleHealthz(createReq({ url: '/healthz' }), res);

      expect(res.body.status).toBe('degraded');
      expect(res.body.ollama).toBe('unhealthy');
    });

    it('returns degraded when the Ollama health check throws a non-timeout error', async () => {
      const probes = loadHealthProbes();
      const res = createRes();

      mockTools.handleToolCall.mockRejectedValue(new Error('transport failed'));

      await probes.handleHealthz(createReq({ url: '/healthz' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.ollama).toBe('error');
    });

    it('returns degraded when the Ollama health check times out after 5 seconds', async () => {
      vi.useFakeTimers();
      const probes = loadHealthProbes();
      const res = createRes();

      mockTools.handleToolCall.mockImplementation(() => new Promise(() => {}));

      const probePromise = probes.handleHealthz(createReq({ url: '/healthz' }), res);
      await vi.advanceTimersByTimeAsync(5_000);
      await probePromise;

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.ollama).toBe('timeout');
    });

    it('returns unhealthy when the database is not initialized', async () => {
      const probes = loadHealthProbes();
      const res = createRes();

      vi.spyOn(process, 'uptime').mockReturnValue(0.2);
      mockDb.getDbInstance.mockReturnValue(null);

      await probes.handleHealthz(createReq({ url: '/healthz' }), res);

      expect(mockTools.handleToolCall).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        status: 'unhealthy',
        uptime_seconds: 0,
        database: 'not_initialized',
        database_reason: 'database not initialized',
        ollama: 'healthy',
        queue_depth: null,
        running_tasks: null,
      });
    });

    it('returns unhealthy when the initial database probe throws', async () => {
      const probes = loadHealthProbes();
      const res = createRes();

      vi.spyOn(process, 'uptime').mockReturnValue(0.2);
      mockDb.countTasks.mockImplementation(() => {
        throw new Error('database query failed');
      });

      await probes.handleHealthz(createReq({ url: '/healthz' }), res);

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        status: 'unhealthy',
        uptime_seconds: 0,
        database: 'error',
        database_reason: 'database query failed',
        ollama: 'healthy',
        queue_depth: null,
        running_tasks: null,
      });
    });

    it('falls back to the generic database failure reason when the thrown error has no message', async () => {
      const probes = loadHealthProbes();
      const res = createRes();

      mockDb.countTasks.mockImplementation(() => {
        throw {};
      });

      await probes.handleHealthz(createReq({ url: '/healthz' }), res);

      expect(res.statusCode).toBe(503);
      expect(res.body.database_reason).toBe('database query failed');
    });

    it('sets both queue metrics to null when the queued task count fails after a successful probe', async () => {
      const probes = loadHealthProbes();
      const res = createRes();
      let callCount = 0;

      mockDb.countTasks.mockImplementation(({ status } = {}) => {
        callCount += 1;
        if (callCount === 1 && status === 'running') return 4;
        if (callCount === 2 && status === 'queued') {
          throw new Error('queue count failed');
        }
        return 99;
      });

      await probes.handleHealthz(createReq({ url: '/healthz' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.queue_depth).toBeNull();
      expect(res.body.running_tasks).toBeNull();
    });

    it('resets queue metrics to null when the running task count fails after queued tasks succeeded', async () => {
      const probes = loadHealthProbes();
      const res = createRes();
      let callCount = 0;

      mockDb.countTasks.mockImplementation(({ status } = {}) => {
        callCount += 1;
        if (callCount === 1 && status === 'running') return 4;
        if (callCount === 2 && status === 'queued') return 9;
        if (callCount === 3 && status === 'running') {
          throw new Error('running count failed');
        }
        return 0;
      });

      await probes.handleHealthz(createReq({ url: '/healthz' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.queue_depth).toBeNull();
      expect(res.body.running_tasks).toBeNull();
    });

    it('passes the originating request object to sendJson', async () => {
      const probes = loadHealthProbes();
      const req = createReq({
        url: '/healthz',
        headers: { 'x-request-id': 'req-healthz' },
      });
      const res = createRes();

      await probes.handleHealthz(req, res);

      expect(res.request).toBe(req);
    });

    it('keeps the instance unhealthy when the database is down even if the Ollama check also fails', async () => {
      const probes = loadHealthProbes();
      const res = createRes();

      mockDb.getDbInstance.mockReturnValue(null);
      mockTools.handleToolCall.mockRejectedValue(new Error('ollama offline'));

      await probes.handleHealthz(createReq({ url: '/healthz' }), res);

      expect(res.statusCode).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.database).toBe('not_initialized');
      expect(res.body.ollama).toBe('error');
    });
  });
});
