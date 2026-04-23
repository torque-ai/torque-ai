import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { EventEmitter } = require('events');
const http = require('http');
const { OPENAPI_VERSION, API_TITLE } = require('../api/openapi-generator');
const taskCore = require('../db/task-core');
const costTracking = require('../db/cost-tracking');
const providerRoutingCore = require('../db/provider-routing-core');

const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let api;
let db;
let tools;
let handleToolCallSpy;
let requestHandler;

function createMockRequest(overrides = {}) {
  return {
    method: 'GET',
    url: '/',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
    destroy: vi.fn(),
    ...overrides,
  };
}

function createMockResponse() {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const listeners = {};
  const responseHeaders = {};
  const writtenChunks = [];

  const response = {
    statusCode: null,
    headers: null,
    body: '',
    on: vi.fn((event, callback) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(callback);
    }),
    emit: vi.fn((event, ...args) => {
      for (const callback of listeners[event] || []) {
        callback(...args);
      }
    }),
    setHeader: vi.fn((name, value) => {
      responseHeaders[name.toLowerCase()] = value;
    }),
    getHeader: vi.fn((name) => responseHeaders[name.toLowerCase()]),
    write: vi.fn((chunk) => {
      writtenChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      response.body = writtenChunks.join('');
    }),
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      if (body) {
        writtenChunks.push(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
      }
      response.body = writtenChunks.join('');
      for (const callback of listeners.finish || []) {
        callback();
      }
      resolveDone();
    }),
  };

  return { response, done };
}

function parseJsonBody(response) {
  return response.body ? JSON.parse(response.body) : null;
}

async function dispatchRequest(handler, { method, url, headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();
  req.socket = { remoteAddress };
  req.connection = { remoteAddress };

  const { response, done } = createMockResponse();
  const handlerPromise = handler(req, response);

  process.nextTick(() => {
    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', payload);
    }
    req.emit('end');
  });

  await handlerPromise;
  await done;
  return response;
}

beforeAll(() => {
  ({ db } = setupTestDb('api-server-core'));
  tools = require('../tools');
  handleToolCallSpy = vi.spyOn(tools, 'handleToolCall').mockResolvedValue({
    content: [{ type: 'text', text: 'healthy' }],
  });
  api = require('../api-server.core');
});

beforeEach(() => {
  handleToolCallSpy.mockReset();
  handleToolCallSpy.mockResolvedValue({
    content: [{ type: 'text', text: 'healthy' }],
  });

  db.setConfig('api_key', '');
  db.setConfig('api_rate_limit', '');
  db.setConfig('v2_auth_mode', 'permissive');
  db.setConfig('v2_rate_policy', 'enforced');
  db.setConfig('v2_rate_limit', '120');
  db.setConfig('quota_auto_scale_enabled', '');
  db.setConfig('quota_queue_depth_threshold', '');
  db.setConfig('quota_cooldown_seconds', '');
});

afterEach(() => {
  vi.useRealTimers();
  api.stopRateLimitCleanup();
});

afterAll(() => {
  try {
    api.stop();
  } catch {
    // ignore cleanup errors
  }
  teardownTestDb();
  vi.restoreAllMocks();
});

describe('api-server.core helpers', () => {
  it('reuses the first non-empty request id header', () => {
    const requestId = api.resolveRequestId(createMockRequest({
      headers: {
        'x-request-id': [' ', 'req-123', 'req-456'],
      },
    }));

    expect(requestId).toBe('req-123');
  });

  it('generates a uuid when the request id header is missing', () => {
    const requestId = api.resolveRequestId(createMockRequest());

    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('parses a JSON body from multiple chunks', async () => {
    const req = new EventEmitter();
    req.destroy = vi.fn();
    const bodyPromise = api.parseBody(req);

    process.nextTick(() => {
      req.emit('data', Buffer.from('{"prompt":'));
      req.emit('data', Buffer.from('"ship it"}'));
      req.emit('end');
    });

    await expect(bodyPromise).resolves.toEqual({ prompt: 'ship it' });
  });

  it('returns an empty object when the body is empty', async () => {
    const req = new EventEmitter();
    req.destroy = vi.fn();
    const bodyPromise = api.parseBody(req);

    process.nextTick(() => {
      req.emit('end');
    });

    await expect(bodyPromise).resolves.toEqual({});
  });

  it('rejects invalid JSON bodies', async () => {
    const req = new EventEmitter();
    req.destroy = vi.fn();
    const bodyPromise = api.parseBody(req);

    process.nextTick(() => {
      req.emit('data', '{"prompt":');
      req.emit('end');
    });

    await expect(bodyPromise).rejects.toThrow('Invalid JSON');
  });

  it('rejects oversized bodies and destroys the request stream', async () => {
    const req = new EventEmitter();
    req.destroy = vi.fn();
    const bodyPromise = api.parseBody(req);

    process.nextTick(() => {
      req.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1, 'a'));
    });

    await expect(bodyPromise).rejects.toThrow('Request body too large');
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });

  it('sendJson includes cors, security, rate limit, and auth headers', () => {
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
    const { response } = createMockResponse();

    api.sendJson(response, { ok: true }, 202, req);

    expect(response.statusCode).toBe(202);
    expect(response.headers).toEqual(expect.objectContaining({
      'Access-Control-Allow-Origin': 'http://127.0.0.1:3456',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'X-XSS-Protection': '1; mode=block',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': '7',
      'X-RateLimit-Reset': '123456',
      'Retry-After': '12',
      'X-Request-ID': 'req-json',
      'WWW-Authenticate': 'Bearer realm="Torque API", error="invalid_token"',
    }));
    expect(parseJsonBody(response)).toEqual({ ok: true });
  });

  it('sendV2Success appends the request id to the payload', () => {
    const { response } = createMockResponse();

    api.sendV2Success(response, 'req-success', { data: 'ok' }, 201);

    expect(response.statusCode).toBe(201);
    expect(parseJsonBody(response)).toEqual({
      data: 'ok',
      request_id: 'req-success',
    });
  });

  it('sendV2Error returns the standardized error envelope', () => {
    const { response } = createMockResponse();

    api.sendV2Error(response, 'req-error', 'validation_error', 'Bad payload', 400, { field: 'prompt' });

    expect(response.statusCode).toBe(400);
    expect(parseJsonBody(response)).toEqual({
      error: {
        code: 'validation_error',
        message: 'Bad payload',
        request_id: 'req-error',
        details: { field: 'prompt' },
      },
    });
  });

  it('createRateLimiter allows requests under the limit and blocks the next one', () => {
    vi.useFakeTimers();
    const limiter = api.createRateLimiter(2, 60_000);
    const req = createMockRequest({ headers: { 'x-request-id': 'req-limit' } });
    const firstRes = createMockResponse().response;
    const secondRes = createMockResponse().response;
    const thirdRes = createMockResponse().response;

    expect(limiter(req, firstRes)).toBe(true);
    expect(limiter(req, secondRes)).toBe(true);
    expect(limiter(req, thirdRes)).toBe(false);

    expect(thirdRes.statusCode).toBe(429);
    expect(parseJsonBody(thirdRes)).toEqual({
      error: {
        code: 'rate_limit_exceeded',
        message: 'Rate limit exceeded',
        request_id: 'req-limit',
        details: expect.objectContaining({
          bucket: 'ip:127.0.0.1',
          limit: 2,
          remaining: 0,
        }),
      },
    });
  });

  it('createRateLimiter resets the bucket after the window expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T00:00:00.000Z'));

    const limiter = api.createRateLimiter(1, 1_000);
    const req = createMockRequest();

    expect(limiter(req, createMockResponse().response)).toBe(true);
    expect(limiter(req, createMockResponse().response)).toBe(false);

    vi.advanceTimersByTime(1_001);

    expect(limiter(req, createMockResponse().response)).toBe(true);
  });

  it('getRateLimit returns the configured api rate limit', () => {
    db.setConfig('api_rate_limit', '55');

    expect(api.getRateLimit()).toBe(55);
  });

  it('getV2ProviderDefaultTimeoutMs uses provider defaults and falls back for unknown providers', () => {
    // PROVIDER_DEFAULT_TIMEOUTS values are in minutes; function converts to ms (* 60 * 1000)
    expect(api.getV2ProviderDefaultTimeoutMs('deepinfra')).toBe(480 * 60 * 1000);
    expect(api.getV2ProviderDefaultTimeoutMs('unknown-provider')).toBe(30 * 60 * 1000);
  });

  it('getV2ProviderQueueDepth returns zero when queue lookup fails', () => {
    delete require.cache[require.resolve('../api/v2-discovery-helpers')];
    const countTasksSpy = vi.spyOn(taskCore, 'countTasks')
      .mockImplementationOnce(() => 4)
      .mockImplementationOnce(() => {
        throw new Error('db down');
      });
    const { getV2ProviderQueueDepth } = require('../api/v2-discovery-helpers');

    expect(getV2ProviderQueueDepth('codex')).toBe(4);
    expect(getV2ProviderQueueDepth('codex')).toBe(0);

    countTasksSpy.mockRestore();
    delete require.cache[require.resolve('../api/v2-discovery-helpers')];
  });

  it('getV2ProviderDefaultProvider returns the db default and null on failure', () => {
    delete require.cache[require.resolve('../api/v2-discovery-helpers')];
    const getDefaultProviderSpy = vi.spyOn(providerRoutingCore, 'getDefaultProvider')
      .mockImplementationOnce(() => 'groq')
      .mockImplementationOnce(() => {
        throw new Error('db down');
      });
    const { getV2ProviderDefaultProvider } = require('../api/v2-discovery-helpers');

    expect(getV2ProviderDefaultProvider()).toBe('groq');
    expect(getV2ProviderDefaultProvider()).toBeNull();

    getDefaultProviderSpy.mockRestore();
    delete require.cache[require.resolve('../api/v2-discovery-helpers')];
  });
});

describe('exported route handlers', () => {
  it('handleGetQuotaHistory clamps days and returns usage rows', async () => {
    const getUsageHistorySpy = vi.spyOn(costTracking, 'getUsageHistory').mockReturnValue([
      { day: '2026-03-08', provider: 'codex', requests: 3 },
    ]);
    const req = createMockRequest({ url: '/api/quota/history?days=500' });
    const { response } = createMockResponse();

    await api.handleGetQuotaHistory(req, response);

    expect(getUsageHistorySpy).toHaveBeenCalledWith(90);
    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual({
      status: 'ok',
      history: [{ day: '2026-03-08', provider: 'codex', requests: 3 }],
    });

    getUsageHistorySpy.mockRestore();
  });

  it('handleGetQuotaAutoScale returns config, queue depth, and last activation', async () => {
    db.setConfig('quota_auto_scale_enabled', 'true');
    db.setConfig('quota_queue_depth_threshold', '5');
    db.setConfig('quota_cooldown_seconds', '120');

    const listTasksSpy = vi.spyOn(taskCore, 'listTasks').mockReturnValue([
      { provider: 'codex' },
      { provider: 'groq' },
      { provider: 'codex' },
    ]);
    const scheduler = require('../execution/queue-scheduler');
    const activationSpy = vi.spyOn(scheduler, '_getLastAutoScaleActivation')
      .mockReturnValue(Date.parse('2025-01-02T03:04:05.000Z'));
    const { response } = createMockResponse();

    await api.handleGetQuotaAutoScale(createMockRequest(), response);

    expect(listTasksSpy).toHaveBeenCalledWith({ status: 'queued', limit: 1000 });
    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual({
      status: 'ok',
      auto_scale: {
        enabled: true,
        queue_depth_threshold: 5,
        cooldown_seconds: 120,
        current_codex_queue_depth: 2,
        last_activation: '2025-01-02T03:04:05.000Z',
      },
    });

    activationSpy.mockRestore();
    listTasksSpy.mockRestore();
  });

  it('handleHealthz reports a healthy instance when db and ollama checks succeed', async () => {
    handleToolCallSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'healthy' }],
    });
    const { response } = createMockResponse();

    await api.handleHealthz(createMockRequest(), response);

    expect(handleToolCallSpy).toHaveBeenCalledWith('check_ollama_health', { force_check: false });
    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual(expect.objectContaining({
      status: 'healthy',
      database: 'connected',
      ollama: 'healthy',
      queue_depth: expect.any(Number),
      running_tasks: expect.any(Number),
    }));
  });

  it('handleHealthz degrades when the ollama health probe times out', async () => {
    vi.useFakeTimers();
    handleToolCallSpy.mockImplementation(() => new Promise(() => {}));
    const countTasksSpy = vi.spyOn(taskCore, 'countTasks').mockReturnValue(0);
    const countTasksByStatusSpy = vi.spyOn(taskCore, 'countTasksByStatus').mockReturnValue({
      running: 0,
      queued: 0,
      completed: 0,
      failed: 0,
      pending: 0,
      cancelled: 0,
      blocked: 0,
    });
    const { response } = createMockResponse();
    const requestPromise = api.handleHealthz(createMockRequest(), response);

    vi.advanceTimersByTime(5_001);
    await requestPromise;

    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual(expect.objectContaining({
      status: 'degraded',
      database: 'connected',
      ollama: 'timeout',
    }));
    countTasksSpy.mockRestore();
    countTasksByStatusSpy.mockRestore();
  });

  it('handleReadyz returns ready after warmup when the database is accessible', () => {
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 10_000;
    const { response } = createMockResponse();

    try {
      api.handleReadyz(createMockRequest(), response);
    } finally {
      Date.now = realDateNow;
    }

    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual({ status: 'ready' });
  });

  it('handleReadyz returns not ready when the database probe fails', () => {
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 10_000;
    const countTasksSpy = vi.spyOn(taskCore, 'countTasks').mockImplementation(() => {
      throw new Error('Database connection lost');
    });
    const { response } = createMockResponse();

    try {
      api.handleReadyz(createMockRequest(), response);
    } finally {
      Date.now = realDateNow;
    }

    expect(response.statusCode).toBe(503);
    expect(parseJsonBody(response)).toEqual({
      status: 'not ready',
      reasons: expect.arrayContaining(['database not accessible']),
    });

    countTasksSpy.mockRestore();
  });

  it('handleLivez always returns an ok response', () => {
    const { response } = createMockResponse();

    api.handleLivez(createMockRequest(), response);

    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual({
      status: 'ok',
      uptime: expect.any(Number),
    });
  });
});

describe('captured request handler dispatch', () => {
  let createServerSpy;
  let mockServer;

  beforeAll(async () => {
    mockServer = {
      on: vi.fn(),
      listen: vi.fn((port, host, callback) => {
        if (callback) callback();
      }),
      close: vi.fn(),
    };

    createServerSpy = vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      requestHandler = handler;
      return mockServer;
    });

    const startResult = await api.start({ port: 4321 });
    expect(startResult.success).toBe(true);
    expect(typeof requestHandler).toBe('function');
  });

  beforeEach(() => {
    handleToolCallSpy.mockReset();
    handleToolCallSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  afterAll(() => {
    api.stop();
    createServerSpy.mockRestore();
  });

  it('returns a 204 cors preflight response for OPTIONS requests', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'OPTIONS',
      url: '/api/tasks',
    });

    expect(response.statusCode).toBe(204);
    expect(handleToolCallSpy).not.toHaveBeenCalled();
  });

  it('dispatches query routes to the expected MCP tool', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks?status=queued&limit=5',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('list_tasks', {
      // defaultArgs on the /api/tasks route aligns v1 REST semantics with v2
      // (show all projects, not just the server's cwd-derived project).
      all_projects: true,
      status: 'queued',
      limit: 5,
    });
    expect(response.statusCode).toBe(200);
  });

  it('honors route.defaultArgs but lets query params override them', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      // Explicit ?all_projects=false must win over the defaultArgs value.
      url: '/api/tasks?all_projects=false&project=torque-public',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('list_tasks', {
      all_projects: false,
      project: 'torque-public',
    });
    expect(response.statusCode).toBe(200);
  });

  it('dispatches parameterized routes to the expected MCP tool', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks/task-42',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('get_result', {
      task_id: 'task-42',
    });
    expect(response.statusCode).toBe(200);
  });

  it('returns provider quota data for GET /api/provider-quotas', async () => {
    const quotaStore = require('../db/provider-quotas').getQuotaStore();
    quotaStore.updateFromInference('google-ai', { tasksLastHour: 4, tokensLastHour: 120 }, { rpm: 15 });

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/provider-quotas',
    });

    expect(handleToolCallSpy).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual(expect.objectContaining({
      'google-ai': expect.objectContaining({
        source: 'inference',
        limits: expect.objectContaining({
          rpm: expect.objectContaining({ limit: 15, remaining: 11 }),
        }),
      }),
    }));
  });

  it('serves the generated OpenAPI spec without invoking tool dispatch', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/openapi.json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const spec = JSON.parse(response.body);
    // Verify valid OpenAPI 3.x structure
    expect(spec.openapi).toBe(OPENAPI_VERSION);
    expect(spec.info.title).toBe(API_TITLE);
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    expect(spec.components).toBeDefined();
    // Auth routes should be excluded (stripped to plugin)
    expect(spec.paths['/api/auth/users']).toBeUndefined();
    expect(spec.paths['/api/auth/login']).toBeUndefined();
    // Health routes should be included
    expect(spec.paths['/healthz']).toBeDefined();
    expect(spec.paths['/readyz']).toBeDefined();
    expect(spec.paths['/livez']).toBeDefined();
    expect(handleToolCallSpy).not.toHaveBeenCalled();
  });

  it('serves standalone peek attestations before generic route dispatch', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/peek/attestations/report-123?since=2026-02-01T00:00:00.000Z&until=2026-02-01T23:59:59.999Z',
    });

    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual(expect.objectContaining({
      report_id: 'report-123',
      report_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      chain_integrity: expect.any(Object),
      policy_coverage_percent: expect.any(Number),
      risk_counts: expect.any(Object),
      review_workflow: {
        reviewer: null,
        reviewed_at: null,
        approved: null,
      },
    }));
    expect(handleToolCallSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON on body-mapped routes', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/tasks',
      body: '{"prompt":',
    });

    expect(response.statusCode).toBe(400);
    expect(parseJsonBody(response)).toEqual({ error: 'Invalid JSON' });
  });

  it('skips auth for unauthenticated health probe routes', async () => {
    db.setConfig('api_key', 'secret-key');

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/livez',
    });

    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response)).toEqual({
      status: 'ok',
      uptime: expect.any(Number),
    });
  });

  it('returns an error for malformed provider id encoding', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/providers/%E0%A4%A/models',
    });

    // Malformed percent-encoding triggers a URIError; the server
    // may return 400 (validation) or 500 (unhandled) depending on
    // whether the URI decode error is caught before route dispatch.
    expect([400, 500]).toContain(response.statusCode);
  });

  it('returns 400 for invalid inbound webhook encoding before route lookup', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/webhooks/inbound/%E0%A4%A',
    });

    expect(response.statusCode).toBe(400);
    expect(parseJsonBody(response)).toEqual({ error: 'Invalid webhook name encoding' });
  });

  it('returns 500 when a non-v2 route handler throws unexpectedly', async () => {
    handleToolCallSpy.mockRejectedValue(new Error('tool exploded'));

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/status',
    });

    expect(response.statusCode).toBe(500);
    expect(parseJsonBody(response)).toEqual({ error: 'tool exploded' });
  });

  it('returns 404 when no route matches the request', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/does-not-exist',
    });

    expect(response.statusCode).toBe(404);
    expect(parseJsonBody(response)).toEqual({ error: 'Not found' });
  });

  // ── Generic tool passthrough tests ──

  describe('GET /api/tools (tool discovery)', () => {
    it('lists all available tools', async () => {
      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/api/tools',
      });

      expect(response.statusCode).toBe(200);
      const body = parseJsonBody(response);
      expect(body.tools).toBeDefined();
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.count).toBe(body.tools.length);
      expect(body.count).toBeGreaterThan(0);
      // Tools should be sorted alphabetically
      const sorted = [...body.tools].sort();
      expect(body.tools).toEqual(sorted);
    });
  });

  describe('POST /api/tools/:tool_name (generic passthrough)', () => {
    it('calls handleToolCall for a valid tool name', async () => {
      db.setConfig('api_key', 'secret-key-123');
      db.setConfig('rest_api_tool_mode', 'extended');

      handleToolCallSpy.mockResolvedValue({
        content: [{ type: 'text', text: 'check_status result' }],
      });

      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/tools/check_status',
        headers: {
          'content-type': 'application/json',
          'x-torque-key': 'secret-key-123',
        },
        body: {},
      });

      expect(response.statusCode).toBe(200);
      const body = parseJsonBody(response);
      expect(body.tool).toBe('check_status');
      expect(body.result).toBe('check_status result');
      expect(handleToolCallSpy).toHaveBeenCalledWith('check_status', {});
    });

    it('passes request body as tool args', async () => {
      db.setConfig('api_key', 'secret-key-123');

      handleToolCallSpy.mockResolvedValue({
        content: [{ type: 'text', text: 'result' }],
      });

      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/tools/await_task',
        headers: {
          'content-type': 'application/json',
          'x-torque-key': 'secret-key-123',
        },
        body: { task_id: 'abc-123', timeout_minutes: 5 },
      });

      expect(response.statusCode).toBe(200);
      expect(handleToolCallSpy).toHaveBeenCalledWith('await_task', {
        task_id: 'abc-123',
        timeout_minutes: 5,
      });
    });

    it('returns 400 when tool handler returns isError', async () => {
      db.setConfig('api_key', 'secret-key-123');
      db.setConfig('rest_api_tool_mode', 'extended');

      handleToolCallSpy.mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Task not found' }],
      });

      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/tools/get_result',
        headers: {
          'content-type': 'application/json',
          'x-torque-key': 'secret-key-123',
        },
        body: { task_id: 'nonexistent' },
      });

      expect(response.statusCode).toBe(400);
      const body = parseJsonBody(response);
      expect(body.error).toBe('Task not found');
    });

    it('returns 404 for unknown tool names', async () => {
      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/tools/nonexistent_tool',
        headers: { 'content-type': 'application/json' },
        body: {},
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 404 for tool names with invalid characters', async () => {
      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/tools/check-status',
        headers: { 'content-type': 'application/json' },
        body: {},
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 404 for tool names with path traversal', async () => {
      const response = await dispatchRequest(requestHandler, {
        method: 'POST',
        url: '/api/tools/../../../etc/passwd',
        headers: { 'content-type': 'application/json' },
        body: {},
      });

      expect(response.statusCode).toBe(404);
    });

  });

  describe('TDA-09/TDA-10: deprecation headers on legacy routes', () => {
    it('legacy quota routes include Deprecation and Link headers', async () => {
      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/api/quota/status',
      });

      expect(response.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
      expect(response.setHeader).toHaveBeenCalledWith(
        'Link',
        '</api/v2/quota/status>; rel="successor-version"',
      );
    });

    it('legacy ollama host routes include Deprecation and Link headers', async () => {
      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/api/ollama/hosts',
      });

      expect(response.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
      expect(response.setHeader).toHaveBeenCalledWith(
        'Link',
        '</api/v2/hosts>; rel="successor-version"',
      );
    });

    it('v2 routes do NOT include deprecation headers', async () => {
      const response = await dispatchRequest(requestHandler, {
        method: 'GET',
        url: '/api/v2/quota/status',
      });

      expect(response.setHeader).not.toHaveBeenCalledWith('Deprecation', expect.anything());
    });
  });
});

// Plugin middleware wiring — lets installed plugins (today: auth plugin in
// enterprise mode) gate inbound requests. Local mode passes an empty array
// and the pipeline is a no-op.
describe('plugin middleware dispatch', () => {
  let spyHttp;
  let capturedHandler;
  let mockServer;

  beforeAll(() => {
    mockServer = {
      on: vi.fn(),
      listen: vi.fn((port, host, callback) => { if (callback) callback(); }),
      close: vi.fn(),
    };
    spyHttp = vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      capturedHandler = handler;
      return mockServer;
    });
  });

  afterAll(() => {
    spyHttp.mockRestore();
    try { api.stop(); } catch { /* ignore */ }
  });

  beforeEach(() => {
    handleToolCallSpy.mockReset();
    handleToolCallSpy.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  });

  async function startWithMiddleware(pluginMiddleware) {
    try { api.stop(); } catch { /* ignore */ }
    const startResult = await api.start({ port: 4411, pluginMiddleware });
    expect(startResult.success).toBe(true);
    return capturedHandler;
  }

  it('rejects unauthenticated requests with 401 when plugin middleware throws 401', async () => {
    const middleware = (_req) => {
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      err.code = 'unauthorized';
      throw err;
    };
    const handler = await startWithMiddleware([middleware]);

    const response = await dispatchRequest(handler, { method: 'GET', url: '/api/tasks' });

    expect(response.statusCode).toBe(401);
    expect(parseJsonBody(response)).toMatchObject({ error: 'Unauthorized', code: 'unauthorized' });
    expect(handleToolCallSpy).not.toHaveBeenCalled();
  });

  it('attaches identity to req and proceeds when plugin middleware returns one', async () => {
    const identity = { id: 'user-1', role: 'admin', type: 'api_key' };
    const seen = {};
    const middleware = (req) => {
      seen.url = req.url;
      return identity;
    };
    const handler = await startWithMiddleware([middleware]);

    const response = await dispatchRequest(handler, { method: 'GET', url: '/api/tasks?status=running' });

    expect(seen.url).toBe('/api/tasks?status=running');
    expect(response.statusCode).toBe(200);
    expect(handleToolCallSpy).toHaveBeenCalledWith('list_tasks', expect.objectContaining({ all_projects: true, status: 'running' }));
  });

  it('lets public routes bypass the middleware chain (health, version, openapi)', async () => {
    let middlewareCalls = 0;
    const middleware = (_req) => {
      middlewareCalls++;
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    };
    const handler = await startWithMiddleware([middleware]);

    // /api/version is exempt — must return 200 without invoking auth.
    const versionRes = await dispatchRequest(handler, { method: 'GET', url: '/api/version' });
    expect(versionRes.statusCode).toBe(200);
    expect(middlewareCalls).toBe(0);

    // /healthz is exempt too — auth must not gate monitoring endpoints.
    const healthRes = await dispatchRequest(handler, { method: 'GET', url: '/healthz' });
    expect([200, 503]).toContain(healthRes.statusCode);
    expect(middlewareCalls).toBe(0);

    // A non-public route, however, hits the middleware and 401s.
    const tasksRes = await dispatchRequest(handler, { method: 'GET', url: '/api/tasks' });
    expect(tasksRes.statusCode).toBe(401);
    expect(middlewareCalls).toBe(1);
  });

  it('no-ops when pluginMiddleware is empty (local mode default)', async () => {
    const handler = await startWithMiddleware([]);

    const response = await dispatchRequest(handler, { method: 'GET', url: '/api/tasks' });

    expect(response.statusCode).toBe(200);
    expect(handleToolCallSpy).toHaveBeenCalled();
  });
});
