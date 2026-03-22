import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = require('../database');
const serverConfig = require('../config');
const middleware = require('../api/middleware');

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

function parseJson(bodyText) {
  if (!bodyText) return null;
  return JSON.parse(bodyText);
}

beforeEach(() => {
  vi.useRealTimers();
  getConfigSpy = vi.spyOn(db, 'getConfig').mockImplementation(() => null);
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

describe('extractApiKey', () => {
  it('returns null when no API key headers are present', () => {
    const req = createMockRequest();
    expect(middleware.extractApiKey(req)).toBeNull();
  });

  it('extracts key from Authorization: Bearer header', () => {
    const req = createMockRequest({
      headers: { authorization: 'Bearer my-secret-key' },
    });
    expect(middleware.extractApiKey(req)).toBe('my-secret-key');
  });

  it('extracts key from X-API-Key header', () => {
    const req = createMockRequest({
      headers: { 'x-api-key': 'my-api-key' },
    });
    expect(middleware.extractApiKey(req)).toBe('my-api-key');
  });

  it('prefers Authorization: Bearer over X-API-Key', () => {
    const req = createMockRequest({
      headers: {
        authorization: 'Bearer bearer-key',
        'x-api-key': 'x-api-key-value',
      },
    });
    expect(middleware.extractApiKey(req)).toBe('bearer-key');
  });

  it('is case-insensitive for the Bearer prefix', () => {
    const req = createMockRequest({
      headers: { authorization: 'bearer my-key' },
    });
    expect(middleware.extractApiKey(req)).toBe('my-key');
  });

  it('handles array-valued Authorization header', () => {
    const req = createMockRequest({
      headers: { authorization: ['Bearer first-key', 'Bearer second-key'] },
    });
    expect(middleware.extractApiKey(req)).toBe('first-key');
  });

  it('handles array-valued X-API-Key header', () => {
    const req = createMockRequest({
      headers: { 'x-api-key': ['key-one', 'key-two'] },
    });
    expect(middleware.extractApiKey(req)).toBe('key-one');
  });

  it('returns null for Authorization header without Bearer scheme', () => {
    const req = createMockRequest({
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(middleware.extractApiKey(req)).toBeNull();
  });

  it('returns null for empty Bearer token', () => {
    const req = createMockRequest({
      headers: { authorization: 'Bearer ' },
    });
    expect(middleware.extractApiKey(req)).toBeNull();
  });

  it('returns null for empty X-API-Key header', () => {
    const req = createMockRequest({
      headers: { 'x-api-key': '   ' },
    });
    expect(middleware.extractApiKey(req)).toBeNull();
  });

  it('trims whitespace from Bearer token', () => {
    const req = createMockRequest({
      headers: { authorization: 'Bearer   my-key  ' },
    });
    expect(middleware.extractApiKey(req)).toBe('my-key');
  });

  it('trims whitespace from X-API-Key value', () => {
    const req = createMockRequest({
      headers: { 'x-api-key': '  my-key  ' },
    });
    expect(middleware.extractApiKey(req)).toBe('my-key');
  });

  it('falls back to X-API-Key when Authorization is not Bearer', () => {
    const req = createMockRequest({
      headers: {
        authorization: 'Basic dXNlcjpwYXNz',
        'x-api-key': 'fallback-key',
      },
    });
    expect(middleware.extractApiKey(req)).toBe('fallback-key');
  });
});

describe('per-API-key rate limiting', () => {
  it('uses API key as rate limit bucket when Authorization: Bearer is present', () => {
    const limiter = middleware.createRateLimiter(2, 60_000);
    const req = createMockRequest({
      headers: { authorization: 'Bearer key-alpha' },
    });
    const res = createMockResponse();

    expect(limiter(req, res)).toBe(true);
    expect(limiter(req, res)).toBe(true);

    const overLimitRes = createMockResponse();
    expect(limiter(req, overLimitRes)).toBe(false);

    const body = parseJson(overLimitRes.body);
    expect(body.error.details.bucket).toBe('key:key-alpha');
  });

  it('uses API key as rate limit bucket when X-API-Key is present', () => {
    const limiter = middleware.createRateLimiter(1, 60_000);
    const req = createMockRequest({
      headers: { 'x-api-key': 'key-beta' },
    });

    expect(limiter(req, createMockResponse())).toBe(true);

    const overLimitRes = createMockResponse();
    expect(limiter(req, overLimitRes)).toBe(false);

    const body = parseJson(overLimitRes.body);
    expect(body.error.details.bucket).toBe('key:key-beta');
  });

  it('falls back to IP-based rate limiting when no API key is present', () => {
    const limiter = middleware.createRateLimiter(1, 60_000);
    const ip = '192.0.2.100';
    const req = createMockRequest({
      socket: { remoteAddress: ip },
      connection: { remoteAddress: ip },
    });

    expect(limiter(req, createMockResponse())).toBe(true);

    const overLimitRes = createMockResponse();
    expect(limiter(req, overLimitRes)).toBe(false);

    const body = parseJson(overLimitRes.body);
    expect(body.error.details.bucket).toBe(`ip:${ip}`);
  });

  it('different API keys have independent rate limits', () => {
    const limiter = middleware.createRateLimiter(1, 60_000);

    const reqA = createMockRequest({
      headers: { authorization: 'Bearer key-one' },
    });
    const reqB = createMockRequest({
      headers: { authorization: 'Bearer key-two' },
    });

    // Exhaust key-one's limit
    expect(limiter(reqA, createMockResponse())).toBe(true);
    expect(limiter(reqA, createMockResponse())).toBe(false);

    // key-two should still be allowed
    expect(limiter(reqB, createMockResponse())).toBe(true);
  });

  it('API key bucket is independent from IP bucket', () => {
    const limiter = middleware.createRateLimiter(1, 60_000);
    const ip = '10.0.0.1';

    // Request with API key from same IP
    const reqWithKey = createMockRequest({
      socket: { remoteAddress: ip },
      connection: { remoteAddress: ip },
      headers: { authorization: 'Bearer my-key' },
    });

    // Request without API key from same IP
    const reqWithoutKey = createMockRequest({
      socket: { remoteAddress: ip },
      connection: { remoteAddress: ip },
    });

    // Exhaust the API key bucket
    expect(limiter(reqWithKey, createMockResponse())).toBe(true);
    expect(limiter(reqWithKey, createMockResponse())).toBe(false);

    // IP bucket should still be available since they're independent
    expect(limiter(reqWithoutKey, createMockResponse())).toBe(true);
  });

  it('same API key from different IPs shares the same rate limit bucket', () => {
    const limiter = middleware.createRateLimiter(1, 60_000);

    const reqFromIpA = createMockRequest({
      socket: { remoteAddress: '10.0.0.1' },
      connection: { remoteAddress: '10.0.0.1' },
      headers: { 'x-api-key': 'shared-key' },
    });

    const reqFromIpB = createMockRequest({
      socket: { remoteAddress: '10.0.0.2' },
      connection: { remoteAddress: '10.0.0.2' },
      headers: { 'x-api-key': 'shared-key' },
    });

    // Use the one allowed request from IP A
    expect(limiter(reqFromIpA, createMockResponse())).toBe(true);

    // Same key from IP B should be rate limited (shares the key bucket)
    expect(limiter(reqFromIpB, createMockResponse())).toBe(false);
  });

  it('rate limit info is attached to request for API key buckets', () => {
    const limiter = middleware.createRateLimiter(3, 60_000);
    const req = createMockRequest({
      headers: { authorization: 'Bearer track-key' },
    });

    limiter(req, createMockResponse());

    expect(req._rateLimit).toEqual({
      limit: 3,
      remaining: 2,
      reset: expect.any(Number),
    });
  });

  it('API key bucket resets after the window expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T00:00:00.000Z'));

    const limiter = middleware.createRateLimiter(1, 1_000);
    const req = createMockRequest({
      headers: { authorization: 'Bearer expiry-key' },
    });

    expect(limiter(req, createMockResponse())).toBe(true);
    expect(limiter(req, createMockResponse())).toBe(false);

    vi.advanceTimersByTime(1_001);

    expect(limiter(req, createMockResponse())).toBe(true);
  });

  it('429 response includes correct retry_after and reset for API key bucket', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T00:00:00.000Z'));

    const limiter = middleware.createRateLimiter(1, 30_000);
    const req = createMockRequest({
      requestId: 'req-key-429',
      headers: {
        authorization: 'Bearer rate-key',
        'x-request-id': 'req-key-429',
      },
    });

    limiter(req, createMockResponse());

    const overLimitRes = createMockResponse();
    limiter(req, overLimitRes);

    expect(overLimitRes.statusCode).toBe(429);
    const body = parseJson(overLimitRes.body);
    expect(body.error).toEqual({
      code: 'rate_limit_exceeded',
      message: 'Rate limit exceeded',
      request_id: 'req-key-429',
      details: expect.objectContaining({
        bucket: 'key:rate-key',
        limit: 1,
        remaining: 0,
        retry_after: expect.any(Number),
        reset: expect.any(Number),
      }),
    });
    expect(body.error.details.retry_after).toBeGreaterThan(0);
    expect(overLimitRes.headers['Retry-After']).toBeDefined();
  });

  it('cleanup removes expired API key buckets', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T00:00:00.000Z'));

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    const limiter = middleware.createRateLimiter(1, 1_000);
    const req = createMockRequest({
      headers: { authorization: 'Bearer cleanup-key' },
    });

    limiter(req, createMockResponse());

    middleware.startRateLimitCleanup();
    const cleanup = setIntervalSpy.mock.calls[0][0];

    vi.advanceTimersByTime(1_001);
    cleanup();

    expect(deleteSpy).toHaveBeenCalledWith('key:cleanup-key');
  });
});
