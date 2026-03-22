import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { EventEmitter } = require('events');

const configCore = require('../db/config-core');
const serverConfig = require('../config');
const middleware = require('../api/middleware');
const { RATE_LIMIT_CLEANUP_MS } = require('../constants');
let getConfigSpy;
let getConfigOriginal;

function createMockRequest(overrides = {}) {
  return {
    method: 'GET',
    url: '/api/tasks',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
    destroy: vi.fn(),
    ...overrides,
  };
}

function createMockResponse() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
  };

  res.writeHead = vi.fn((status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  });
  res.end = vi.fn((body = '') => {
    res.body = body;
  });

  return res;
}

function createBodyRequest({ chunks = [], error } = {}) {
  const req = new EventEmitter();
  req.destroy = vi.fn();

  process.nextTick(() => {
    if (error) {
      req.emit('error', error);
      return;
    }

    for (const chunk of chunks) {
      req.emit('data', chunk);
    }
    req.emit('end');
  });

  return req;
}

function parseJson(bodyText) {
  if (!bodyText) return null;
  return JSON.parse(bodyText);
}

function runMiddlewareChain({ helpers, req, res, handler = vi.fn() }) {
  const baseLimiter = helpers.getEndpointRateLimiter(req.url);
  const limiter = baseLimiter
    ? vi.fn((request, response) => baseLimiter(request, response))
    : vi.fn();

  if (helpers.handleCorsPreflight(req, res)) {
    return { outcome: 'preflight', handler, limiter };
  }

  if (baseLimiter && limiter(req, res) === false) {
    return { outcome: 'blocked', handler, limiter };
  }

  handler(req, res);
  return { outcome: 'handled', handler, limiter };
}

beforeEach(() => {
  vi.useRealTimers();
  getConfigSpy = vi.spyOn(configCore, 'getConfig').mockImplementation(() => null);
  // serverConfig.get() delegates to db.getConfig internally, but holds its own db ref.
  // Spy on serverConfig.get so tests that check config reads still work.
  getConfigOriginal = serverConfig.get;
  serverConfig.get = vi.fn((key, fallback) => {
    const val = getConfigSpy(key);
    return val !== null && val !== undefined ? val : (fallback !== undefined ? fallback : null);
  });
});

afterEach(() => {
  middleware.stopRateLimitCleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  serverConfig.get = getConfigOriginal;
});

describe('utility helpers', () => {
  it('reads the configured api rate limit from the database', () => {
    getConfigSpy.mockImplementation((key) => (key === 'api_rate_limit' ? '55' : null));

    expect(middleware.getRateLimit()).toBe(55);
    expect(getConfigSpy).toHaveBeenCalledWith('api_rate_limit');
  });

  it('prefers an injected config database when one is provided', () => {
    const configDb = {
      getConfig: vi.fn((key) => (key === 'api_rate_limit' ? '42' : null)),
    };

    expect(middleware.getRateLimit(configDb)).toBe(42);
    expect(configDb.getConfig).toHaveBeenCalledWith('api_rate_limit');
    expect(getConfigSpy).not.toHaveBeenCalledWith('api_rate_limit');
  });

  it('falls back to the default rate limit when config lookup throws', () => {
    const configDb = {
      getConfig: () => {
        throw new Error('db unavailable');
      },
    };

    expect(middleware.getRateLimit(configDb)).toBe(200);
  });

  it('parses query strings with decoding, empty values, and duplicate keys', () => {
    expect(middleware.parseQuery('/api/tasks?verbose&name=hello%20world&x=1&x=2')).toEqual({
      verbose: '',
      name: 'hello world',
      x: '2',
    });
  });

  it('returns an empty object for URLs without a query string', () => {
    expect(middleware.parseQuery('/api/tasks')).toEqual({});
  });
});

describe('parseBody', () => {
  it('parses JSON bodies delivered across multiple chunks', async () => {
    const req = createBodyRequest({ chunks: ['{"prompt":', '"ship it"}'] });

    await expect(middleware.parseBody(req)).resolves.toEqual({ prompt: 'ship it' });
  });

  it('returns an empty object when no body is provided', async () => {
    const req = createBodyRequest();

    await expect(middleware.parseBody(req)).resolves.toEqual({});
  });

  it('parses Buffer chunks', async () => {
    const req = createBodyRequest({ chunks: [Buffer.from('{'), Buffer.from('"count":2}')] });

    await expect(middleware.parseBody(req)).resolves.toEqual({ count: 2 });
  });

  it('accepts explicit JSON null payloads', async () => {
    const req = createBodyRequest({ chunks: ['null'] });

    await expect(middleware.parseBody(req)).resolves.toBeNull();
  });

  it('rejects invalid JSON', async () => {
    const req = createBodyRequest({ chunks: ['{"prompt":'] });

    await expect(middleware.parseBody(req)).rejects.toThrow('Invalid JSON');
  });

  it('propagates request stream errors', async () => {
    const req = createBodyRequest({ error: new Error('socket broke') });

    await expect(middleware.parseBody(req)).rejects.toThrow('socket broke');
  });

  it('rejects oversized bodies and destroys the request stream', async () => {
    const req = createBodyRequest({
      chunks: [Buffer.alloc(10 * 1024 * 1024 + 1, 'a')],
    });

    await expect(middleware.parseBody(req)).rejects.toThrow('Request body too large');
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('sendJson', () => {
  it('writes JSON responses with CORS and security headers', () => {
    const res = createMockResponse();

    middleware.sendJson(res, { ok: true });

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'http://127.0.0.1:3456',
      'Access-Control-Allow-Headers': 'Content-Type, X-Torque-Key, X-Request-ID, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      ...middleware.SECURITY_HEADERS,
    }));
    expect(parseJson(res.body)).toEqual({ ok: true });
  });

  it('omits optional headers when request metadata is not present', () => {
    const req = createMockRequest({
      _rateLimit: {
        limit: 5,
        remaining: 4,
        reset: 123456,
      },
    });
    const res = createMockResponse();

    middleware.sendJson(res, { ok: true }, 200, req);

    expect(res.headers).toEqual(expect.objectContaining({
      'X-RateLimit-Limit': '5',
      'X-RateLimit-Remaining': '4',
      'X-RateLimit-Reset': '123456',
    }));
    expect(res.headers).not.toHaveProperty('Retry-After');
    expect(res.headers).not.toHaveProperty('WWW-Authenticate');
    expect(res.headers).not.toHaveProperty('X-Request-ID');
  });

  it('includes request id, auth challenge, and rate limit headers when present', () => {
    const req = createMockRequest({
      requestId: 'req-json',
      _authChallenge: 'Bearer realm="Torque API", error="invalid_token"',
      _rateLimit: {
        limit: 10,
        remaining: 7,
        reset: 123456,
        retryAfter: 12,
      },
    });
    const res = createMockResponse();

    middleware.sendJson(res, { status: 'ok' }, 202, req);

    expect(res.writeHead).toHaveBeenCalledWith(202, expect.objectContaining({
      'X-Request-ID': 'req-json',
      'WWW-Authenticate': 'Bearer realm="Torque API", error="invalid_token"',
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': '7',
      'X-RateLimit-Reset': '123456',
      'Retry-After': '12',
    }));
  });
});

describe('rate limiting helpers', () => {
  it('tracks remaining requests on allowed requests', () => {
    const limiter = middleware.createRateLimiter(2, 60_000);
    const req = createMockRequest();

    expect(limiter(req, createMockResponse())).toBe(true);
    expect(req._rateLimit).toEqual({
      limit: 2,
      remaining: 1,
      reset: expect.any(Number),
    });

    expect(limiter(req, createMockResponse())).toBe(true);
    expect(req._rateLimit.remaining).toBe(0);
  });

  it('tracks rate limits independently per remote address', () => {
    const limiter = middleware.createRateLimiter(1, 60_000);
    const reqA = createMockRequest({
      socket: { remoteAddress: '10.0.0.1' },
      connection: { remoteAddress: '10.0.0.1' },
    });
    const reqB = createMockRequest({
      socket: { remoteAddress: '10.0.0.2' },
      connection: { remoteAddress: '10.0.0.2' },
    });

    expect(limiter(reqA, createMockResponse())).toBe(true);
    expect(limiter(reqA, createMockResponse())).toBe(false);
    expect(limiter(reqB, createMockResponse())).toBe(true);
    expect(reqB._rateLimit).toEqual({
      limit: 1,
      remaining: 0,
      reset: expect.any(Number),
    });
  });

  it('returns a 429 JSON response after the limit is exceeded', () => {
    const limiter = middleware.createRateLimiter(2, 60_000);
    const req = createMockRequest({
      requestId: 'req-limit',
      headers: {
        'x-request-id': 'req-limit',
      },
    });
    const overLimitRes = createMockResponse();

    expect(limiter(req, createMockResponse())).toBe(true);
    expect(limiter(req, createMockResponse())).toBe(true);
    expect(limiter(req, overLimitRes)).toBe(false);

    expect(overLimitRes.statusCode).toBe(429);
    expect(parseJson(overLimitRes.body)).toEqual({
      error: {
        code: 'rate_limit_exceeded',
        message: 'Rate limit exceeded',
        request_id: 'req-limit',
        details: expect.objectContaining({
          bucket: 'ip:127.0.0.1',
          limit: 2,
          remaining: 0,
          retry_after: expect.any(Number),
          reset: expect.any(Number),
        }),
      },
    });
  });

  it('falls back to an unknown bucket when no remote address is available', () => {
    const limiter = middleware.createRateLimiter(1, 60_000);
    const req = createMockRequest({
      requestId: 'req-unknown',
      socket: undefined,
      connection: undefined,
      headers: {
        'x-request-id': 'req-unknown',
      },
    });
    const overLimitRes = createMockResponse();

    expect(limiter(req, createMockResponse())).toBe(true);
    expect(limiter(req, overLimitRes)).toBe(false);
    expect(parseJson(overLimitRes.body).error.details.bucket).toBe('ip:unknown');
  });

  it('uses the first x-request-id header value when requestId is absent', () => {
    const limiter = middleware.createRateLimiter(1, 60_000);
    const req = createMockRequest({
      requestId: undefined,
      headers: {
        'x-request-id': ['req-array-1', 'req-array-2'],
      },
    });
    const overLimitRes = createMockResponse();

    expect(limiter(req, createMockResponse())).toBe(true);
    expect(limiter(req, overLimitRes)).toBe(false);

    expect(parseJson(overLimitRes.body).error.request_id).toBe('req-array-1');
  });

  it('resets a bucket after the window expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T00:00:00.000Z'));

    const limiter = middleware.createRateLimiter(1, 1_000);
    const req = createMockRequest();

    expect(limiter(req, createMockResponse())).toBe(true);
    expect(limiter(req, createMockResponse())).toBe(false);

    vi.advanceTimersByTime(1_001);

    expect(limiter(req, createMockResponse())).toBe(true);
  });

  it('clears active limiter state when cleanup is stopped', () => {
    const limiter = middleware.createRateLimiter(1, 60_000);
    const req = createMockRequest();

    expect(limiter(req, createMockResponse())).toBe(true);
    expect(limiter(req, createMockResponse())).toBe(false);

    middleware.stopRateLimitCleanup();

    expect(limiter(req, createMockResponse())).toBe(true);
  });

  it('deletes expired buckets when the cleanup callback runs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T00:00:00.000Z'));

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    const limiter = middleware.createRateLimiter(1, 1_000);
    const req = createMockRequest({
      socket: { remoteAddress: '10.20.30.40' },
      connection: { remoteAddress: '10.20.30.40' },
    });

    expect(limiter(req, createMockResponse())).toBe(true);

    middleware.startRateLimitCleanup();
    const cleanup = setIntervalSpy.mock.calls[0][0];

    vi.advanceTimersByTime(1_001);
    cleanup();

    expect(deleteSpy).toHaveBeenCalledWith('ip:10.20.30.40');
  });

  it('schedules one unrefed cleanup interval', () => {
    const timer = { unref: vi.fn() };
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    middleware.startRateLimitCleanup();
    middleware.startRateLimitCleanup();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), RATE_LIMIT_CLEANUP_MS);
    expect(timer.unref).toHaveBeenCalledTimes(1);

    middleware.stopRateLimitCleanup();

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it('uses the global checkRateLimit wrapper for shared api limiting', () => {
    const req = createMockRequest();
    const res = createMockResponse();

    expect(middleware.checkRateLimit(req, res)).toBe(true);
    expect(req._rateLimit).toEqual({
      limit: expect.any(Number),
      remaining: expect.any(Number),
      reset: expect.any(Number),
    });
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});

describe('applyMiddleware', () => {
  it('returns route-specific limiters and null for non-api routes', () => {
    const helpers = middleware.applyMiddleware(null, {
      getRateLimit: () => 2,
    });

    expect(typeof helpers.getEndpointRateLimiter('/api/shutdown')).toBe('function');
    expect(typeof helpers.getEndpointRateLimiter('/api/metrics')).toBe('function');
    expect(typeof helpers.getEndpointRateLimiter('/api/tasks')).toBe('function');
    expect(helpers.getEndpointRateLimiter('/docs')).toBeNull();
  });

  it('uses the configured rate limit for task routes', () => {
    const helpers = middleware.applyMiddleware(null, {
      getRateLimit: () => 2,
    });
    const limiter = helpers.getEndpointRateLimiter('/api/tasks');
    const req = createMockRequest({
      url: '/api/tasks',
      requestId: 'req-tasks',
    });
    const overLimitRes = createMockResponse();

    expect(limiter(req, createMockResponse())).toBe(true);
    expect(limiter(req, createMockResponse())).toBe(true);
    expect(limiter(req, overLimitRes)).toBe(false);
    expect(overLimitRes.statusCode).toBe(429);
  });

  it('treats health routes as rate-limited API endpoints', () => {
    const helpers = middleware.applyMiddleware(null, {
      getRateLimit: () => 1,
    });
    const limiter = helpers.getEndpointRateLimiter('/healthz');

    expect(limiter(createMockRequest({ url: '/healthz' }), createMockResponse())).toBe(true);
    expect(limiter(createMockRequest({ url: '/healthz' }), createMockResponse())).toBe(false);
  });

  it('disables v2 rate limiting when the v2 policy is disabled', () => {
    const getV2RateLimiter = vi.fn(() => vi.fn(() => false));
    const helpers = middleware.applyMiddleware(null, {
      getV2RatePolicy: () => 'disabled',
      getV2RateLimiter,
    });
    const limiter = helpers.getEndpointRateLimiter('/api/v2/tasks');

    expect(limiter(createMockRequest({ url: '/api/v2/tasks' }), createMockResponse())).toBe(true);
    expect(getV2RateLimiter).not.toHaveBeenCalled();
  });

  it('treats non-function v2 policy dependencies as enforced', () => {
    const customLimiter = vi.fn(() => true);
    const getV2RateLimiter = vi.fn(() => customLimiter);
    const helpers = middleware.applyMiddleware(null, {
      getV2RatePolicy: 'disabled',
      getV2RateLimiter,
    });

    expect(helpers.getEndpointRateLimiter('/api/v2/tasks')).toBe(customLimiter);
    expect(getV2RateLimiter).toHaveBeenCalledTimes(1);
  });

  it('uses a provided v2 limiter and falls back to the global limiter otherwise', () => {
    const customLimiter = vi.fn(() => true);
    const getV2RateLimiter = vi.fn(() => customLimiter);
    const withCustomLimiter = middleware.applyMiddleware(null, {
      getV2RatePolicy: () => 'enforced',
      getV2RateLimiter,
    });
    const withFallbackLimiter = middleware.applyMiddleware(null, {
      getV2RatePolicy: () => 'enforced',
      getV2RateLimiter: null,
    });

    expect(withCustomLimiter.getEndpointRateLimiter('/api/v2/tasks')).toBe(customLimiter);
    expect(getV2RateLimiter).toHaveBeenCalledTimes(1);
    expect(withFallbackLimiter.getEndpointRateLimiter('/api/v2/tasks')).toBe(middleware.checkRateLimit);
  });

  it('supports overriding unauthenticated health routes', () => {
    const helpers = middleware.applyMiddleware(null, {
      getRateLimit: () => 1,
      unauthenticatedHealthRoutes: ['/statusz'],
    });

    expect(typeof helpers.getEndpointRateLimiter('/statusz')).toBe('function');
    expect(helpers.getEndpointRateLimiter('/healthz')).toBeNull();
  });

  it('handles CORS preflight requests with a 204 response', () => {
    const helpers = middleware.applyMiddleware(null);
    const req = createMockRequest({
      method: 'OPTIONS',
      url: '/api/tasks',
    });
    const res = createMockResponse();

    expect(helpers.handleCorsPreflight(req, res)).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(parseJson(res.body)).toEqual({});
  });

  it('returns false for non-OPTIONS preflight checks', () => {
    const helpers = middleware.applyMiddleware(null);

    expect(helpers.handleCorsPreflight(createMockRequest(), createMockResponse())).toBe(false);
  });

  it('short-circuits middleware chains on OPTIONS requests', () => {
    const helpers = middleware.applyMiddleware(null, {
      getRateLimit: () => 1,
    });
    const req = createMockRequest({
      method: 'OPTIONS',
      url: '/api/tasks',
    });
    const res = createMockResponse();
    const { outcome, handler, limiter } = runMiddlewareChain({ helpers, req, res });

    expect(outcome).toBe('preflight');
    expect(limiter).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(204);
  });

  it('continues middleware chains for non-OPTIONS requests', () => {
    const helpers = middleware.applyMiddleware(null, {
      getRateLimit: () => 1,
    });
    const req = createMockRequest({
      method: 'GET',
      url: '/api/tasks',
    });
    const res = createMockResponse();
    const { outcome, handler, limiter } = runMiddlewareChain({ helpers, req, res });

    expect(outcome).toBe('handled');
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(req, res);
  });
});
