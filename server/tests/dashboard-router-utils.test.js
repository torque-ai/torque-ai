'use strict';

const { EventEmitter } = require('events');
const { TEST_MODELS } = require('./test-helpers');

const UTILS_MODULES = [
  '../dashboard/utils',
  '../database',
  '../task-manager',
];

const ROUTER_MODULES = [
  '../dashboard/router',
  '../dashboard/utils',
  '../dashboard/routes/tasks',
  '../dashboard/routes/infrastructure',
  '../dashboard/routes/analytics',
  '../dashboard/routes/admin',
];

function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModules(modulePaths) {
  for (const modulePath of modulePaths) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that were not loaded.
    }
  }
}

function createMockReq({
  method = 'GET',
  url = '/',
  headers = {},
  body,
  chunks,
  remoteAddress = '127.0.0.1',
  useSocket = true,
  useConnection = true,
  error,
} = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  if (useSocket) req.socket = { remoteAddress };
  if (useConnection) req.connection = { remoteAddress };
  req.destroy = vi.fn();

  const payloadChunks = Array.isArray(chunks)
    ? chunks
    : body === undefined
      ? []
      : [typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)];

  process.nextTick(() => {
    if (error) {
      req.emit('error', error);
      return;
    }

    for (const chunk of payloadChunks) {
      req.emit('data', chunk);
    }
    req.emit('end');
  });

  return req;
}

function createMockRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    _corsOrigin: null,
    writeHead: vi.fn((statusCode, headers) => {
      res.statusCode = statusCode;
      res.headers = headers;
    }),
    end: vi.fn((body = '') => {
      res.body = body;
    }),
  };
  return res;
}

function readJson(body) {
  return body ? JSON.parse(body) : null;
}

function createHandlerProxy() {
  const target = {};
  return new Proxy(target, {
    get(obj, prop) {
      if (!(prop in obj)) {
        obj[prop] = vi.fn().mockName(String(prop));
      }
      return obj[prop];
    },
  });
}

const mockDb = {
  getOllamaHost: vi.fn(),
};

const mockTaskManager = {
  isModelLoadedOnHost: vi.fn(),
};

function loadUtils() {
  clearModules(UTILS_MODULES);
  installMock('../database', mockDb);
  installMock('../task-manager', mockTaskManager);
  return require('../dashboard/utils');
}

function createRouterMocks() {
  const tasks = createHandlerProxy();
  const infrastructure = createHandlerProxy();
  const analytics = createHandlerProxy();
  const admin = createHandlerProxy();

  const utils = {
    parseQuery: vi.fn((url) => ({ parsedFrom: url })),
    parseBody: vi.fn(),
    isLocalhostOrigin: vi.fn((origin) => {
      if (!origin) return false;
      return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
    }),
    sendJson: vi.fn((res, payload, statusCode = 200) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }),
    sendError: vi.fn((res, message, statusCode = 400) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }),
  };

  return { tasks, infrastructure, analytics, admin, utils };
}

function loadRouter(mocks) {
  clearModules(ROUTER_MODULES);
  installMock('../dashboard/utils', mocks.utils);
  installMock('../dashboard/routes/tasks', mocks.tasks);
  installMock('../dashboard/routes/infrastructure', mocks.infrastructure);
  installMock('../dashboard/routes/analytics', mocks.analytics);
  installMock('../dashboard/routes/admin', mocks.admin);
  return require('../dashboard/router');
}

describe('dashboard/utils', () => {
  let utils;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockDb.getOllamaHost.mockReset().mockReturnValue(null);
    mockTaskManager.isModelLoadedOnHost.mockReset().mockReturnValue(false);
    utils = loadUtils();
  });

  afterEach(() => {
    clearModules(UTILS_MODULES);
    vi.restoreAllMocks();
  });

  describe('parseQuery', () => {
    it('returns an empty object when no query string is present', () => {
      expect(utils.parseQuery('/api/tasks')).toEqual({});
    });

    it('decodes keys and values and keeps the last value for duplicate keys', () => {
      expect(utils.parseQuery('/api/tasks?state=queued&task%20id=task-1&state=running')).toEqual({
        state: 'running',
        'task id': 'task-1',
      });
    });

    it('treats keys without values as empty strings', () => {
      expect(utils.parseQuery('/api/tasks?verbose')).toEqual({ verbose: '' });
    });

    it('skips malformed pairs and empty keys without throwing', () => {
      expect(utils.parseQuery('/api/tasks?=missing&good=1&bad=%E0%A4%A')).toEqual({ good: '1' });
    });
  });

  describe('safeDecodeParam', () => {
    it('decodes a valid path parameter', () => {
      expect(utils.safeDecodeParam('project%2Falpha')).toBe('project/alpha');
    });

    it('returns an empty string for undefined input', () => {
      expect(utils.safeDecodeParam(undefined)).toBe('');
    });

    it('returns null and sends a 400 response for URI errors', () => {
      const res = createMockRes();

      expect(utils.safeDecodeParam('%E0%A4%A', res)).toBeNull();
      expect(res.statusCode).toBe(400);
      expect(readJson(res.body)).toEqual({ error: 'Invalid identifier encoding' });
    });

    it('returns null for URI errors when no response object is provided', () => {
      expect(utils.safeDecodeParam('%E0%A4%A')).toBeNull();
    });

    it('rethrows non-URI decode errors', () => {
      const originalDecodeURIComponent = global.decodeURIComponent;
      global.decodeURIComponent = () => {
        throw new TypeError('decode exploded');
      };

      try {
        expect(() => utils.safeDecodeParam('abc')).toThrow('decode exploded');
      } finally {
        global.decodeURIComponent = originalDecodeURIComponent;
      }
    });
  });

  describe('parseBody', () => {
    it('parses chunked JSON payloads', async () => {
      const req = createMockReq({ chunks: ['{"hello":', '"world"}'] });

      await expect(utils.parseBody(req)).resolves.toEqual({ hello: 'world' });
    });

    it('parses buffer chunks', async () => {
      const req = createMockReq({ chunks: [Buffer.from('{'), Buffer.from('"ok":true}')] });

      await expect(utils.parseBody(req)).resolves.toEqual({ ok: true });
    });

    it('returns an empty object for an empty request body', async () => {
      const req = createMockReq();

      await expect(utils.parseBody(req)).resolves.toEqual({});
    });

    it('returns null for an explicit JSON null body', async () => {
      const req = createMockReq({ body: 'null' });

      await expect(utils.parseBody(req)).resolves.toBeNull();
    });

    it('rejects invalid JSON bodies', async () => {
      const req = createMockReq({ body: '{"broken": }' });

      await expect(utils.parseBody(req)).rejects.toThrow('Invalid JSON body');
    });

    it('rejects oversized request bodies and destroys the request', async () => {
      const req = createMockReq({ body: 'x'.repeat((10 * 1024 * 1024) + 1) });

      await expect(utils.parseBody(req)).rejects.toThrow('Request body too large');
      expect(req.destroy).toHaveBeenCalledTimes(1);
    });

    it('rejects when the request emits an error', async () => {
      const req = createMockReq({ error: new Error('socket closed') });

      await expect(utils.parseBody(req)).rejects.toThrow('socket closed');
    });
  });

  describe('origin and response helpers', () => {
    it.each([
      'http://localhost:3000',
      'https://127.0.0.1:8443',
      'http://[::1]:9090',
    ])('accepts localhost origin %s', (origin) => {
      expect(utils.isLocalhostOrigin(origin)).toBe(true);
    });

    it.each([
      null,
      undefined,
      'http://example.com',
      'notaurl',
    ])('rejects non-local origin %s', (origin) => {
      expect(utils.isLocalhostOrigin(origin)).toBe(false);
    });

    it('sendJson writes JSON with security headers and default status 200', () => {
      const res = createMockRes();

      utils.sendJson(res, { ok: true });

      expect(res.statusCode).toBe(200);
      expect(res.headers).toEqual(expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'X-XSS-Protection': '1; mode=block',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      }));
      expect(readJson(res.body)).toEqual({ ok: true });
    });

    it('sendJson respects a custom status code and optional CORS origin', () => {
      const res = createMockRes();
      res._corsOrigin = 'http://localhost:4000';

      utils.sendJson(res, { accepted: true }, 202);

      expect(res.statusCode).toBe(202);
      expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:4000');
      expect(readJson(res.body)).toEqual({ accepted: true });
    });

    it('sendError wraps the message in an error object', () => {
      const res = createMockRes();

      utils.sendError(res, 'Forbidden', 403);

      expect(res.statusCode).toBe(403);
      expect(readJson(res.body)).toEqual({ error: 'Forbidden' });
    });

    it('successResponse returns the standard success envelope with optional meta', () => {
      expect(utils.successResponse(['a', 'b'], { total: 2 })).toEqual({
        success: true,
        data: ['a', 'b'],
        meta: { total: 2 },
      });
    });

    it('successResponse omits meta when none is provided', () => {
      expect(utils.successResponse({ ok: true })).toEqual({
        success: true,
        data: { ok: true },
      });
    });

    it('errorResponse includes the code when provided', () => {
      expect(utils.errorResponse('Bad request', 400)).toEqual({
        success: false,
        error: 'Bad request',
        code: 400,
      });
    });

    it('errorResponse omits the code when not provided', () => {
      expect(utils.errorResponse('Bad request')).toEqual({
        success: false,
        error: 'Bad request',
      });
    });
  });

  describe('enrichTaskWithHostName', () => {
    it('returns null unchanged', () => {
      expect(utils.enrichTaskWithHostName(null)).toBeNull();
      expect(mockDb.getOllamaHost).not.toHaveBeenCalled();
    });

    it('returns the same task object unchanged when no host id is present', () => {
      const task = { id: 'task-1', status: 'queued' };

      const result = utils.enrichTaskWithHostName(task);

      expect(result).toBe(task);
      expect(result).toEqual({ id: 'task-1', status: 'queued' });
      expect(mockDb.getOllamaHost).not.toHaveBeenCalled();
    });

    it('adds the host name from the database', () => {
      mockDb.getOllamaHost.mockReturnValue({ id: 'host-1', name: 'Primary Host' });
      const task = { id: 'task-1', status: 'queued', ollama_host_id: 'host-1' };

      const result = utils.enrichTaskWithHostName(task);

      expect(result).toBe(task);
      expect(result.ollama_host_name).toBe('Primary Host');
      expect(mockTaskManager.isModelLoadedOnHost).not.toHaveBeenCalled();
    });

    it('falls back to the host id when the database returns no host record', () => {
      mockDb.getOllamaHost.mockReturnValue(null);
      const task = { id: 'task-1', status: 'queued', ollama_host_id: 'host-missing' };

      const result = utils.enrichTaskWithHostName(task);

      expect(result.ollama_host_name).toBe('host-missing');
    });

    it('falls back to the host id when host lookup throws', () => {
      mockDb.getOllamaHost.mockImplementation(() => {
        throw new Error('db offline');
      });
      const task = { id: 'task-1', status: 'queued', ollama_host_id: 'host-err' };

      const result = utils.enrichTaskWithHostName(task);

      expect(result.ollama_host_name).toBe('host-err');
    });

    it('adds gpu_active for running tasks using task-manager state', () => {
      mockDb.getOllamaHost.mockReturnValue({ id: 'host-1', name: 'Primary Host' });
      mockTaskManager.isModelLoadedOnHost.mockReturnValue(true);
      const task = {
        id: 'task-1',
        status: 'running',
        model: TEST_MODELS.SMALL,
        ollama_host_id: 'host-1',
      };

      const result = utils.enrichTaskWithHostName(task);

      expect(result.gpu_active).toBe(true);
      expect(mockTaskManager.isModelLoadedOnHost).toHaveBeenCalledWith('host-1', TEST_MODELS.SMALL);
    });

    it('sets gpu_active to null when task-manager lookup throws', () => {
      mockDb.getOllamaHost.mockReturnValue({ id: 'host-1', name: 'Primary Host' });
      mockTaskManager.isModelLoadedOnHost.mockImplementation(() => {
        throw new Error('gpu lookup failed');
      });
      const task = {
        id: 'task-1',
        status: 'running',
        model: TEST_MODELS.SMALL,
        ollama_host_id: 'host-1',
      };

      const result = utils.enrichTaskWithHostName(task);

      expect(result.gpu_active).toBeNull();
    });
  });

  describe('formatUptime', () => {
    it('formats minute-only uptime values', () => {
      expect(utils.formatUptime(3599)).toBe('59m');
    });

    it('formats hour and minute uptime values', () => {
      expect(utils.formatUptime(3660)).toBe('1h 1m');
    });

    it('formats day, hour, and minute uptime values', () => {
      expect(utils.formatUptime(90060)).toBe('1d 1h 1m');
    });
  });
});

describe('dashboard/router', () => {
  let router;
  let mocks;
  let context;

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks = createRouterMocks();
    router = loadRouter(mocks);
    context = {
      broadcastTaskUpdate: vi.fn(),
      clients: new Set(['client-1']),
      serverPort: 4310,
    };
  });

  afterEach(() => {
    clearModules(ROUTER_MODULES);
    vi.restoreAllMocks();
  });

  describe('route registration', () => {
    it('exports a large route table covering the dashboard API surface', () => {
      expect(Array.isArray(router.routes)).toBe(true);
      expect(router.routes.length).toBeGreaterThanOrEqual(80);
      expect(router.routes.filter((route) => route.compat).length).toBeGreaterThanOrEqual(60);
    });

    it.each([
      ['GET', '/api/tasks', 'tasks', 'handleListTasks', true],
      ['GET', '/api/tasks/task-1/diff', 'tasks', 'handleTaskDiff', true],
      ['POST', '/api/providers/openai/toggle', 'infrastructure', 'handleProviderToggle', true],
      ['GET', '/api/provider-quotas', 'infrastructure', 'handleProviderQuotas', false],
      ['GET', '/api/hosts/activity', 'infrastructure', 'handleHostActivity', false],
      ['GET', '/api/workflows/wf-1/history', 'analytics', 'handleGetWorkflowHistory', true],
      ['POST', '/api/plan-projects/import', 'admin', 'handleImportPlanApi', true],
      ['GET', '/api/coordination', 'admin', 'handleGetDashboard', false],
      ['GET', '/api/free-tier/auto-scale', 'analytics', 'handleFreeTierAutoScale', false],
    ])('registers %s %s on %s.%s', (method, url, group, handlerName, compat) => {
      const route = router.routes.find((entry) => entry.method === method && entry.pattern.test(url));

      expect(route).toBeDefined();
      expect(route.handler).toBe(mocks[group][handlerName]);
      expect(Boolean(route.compat)).toBe(compat);
    });

    it('orders task diff and task logs routes before the generic task detail route', () => {
      const diffIndex = router.routes.findIndex((route) => route.method === 'GET' && route.pattern.test('/api/tasks/task-1/diff'));
      const logsIndex = router.routes.findIndex((route) => route.method === 'GET' && route.pattern.test('/api/tasks/task-1/logs'));
      const detailIndex = router.routes.findIndex((route) => route.method === 'GET' && route.pattern.test('/api/tasks/task-1'));

      expect(diffIndex).toBeLessThan(detailIndex);
      expect(logsIndex).toBeLessThan(detailIndex);
    });

    it('orders workflow sub-routes before the generic workflow detail route', () => {
      const tasksIndex = router.routes.findIndex((route) => route.method === 'GET' && route.pattern.test('/api/workflows/wf-1/tasks'));
      const historyIndex = router.routes.findIndex((route) => route.method === 'GET' && route.pattern.test('/api/workflows/wf-1/history'));
      const detailIndex = router.routes.findIndex((route) => route.method === 'GET' && route.pattern.test('/api/workflows/wf-1'));

      expect(tasksIndex).toBeLessThan(detailIndex);
      expect(historyIndex).toBeLessThan(detailIndex);
    });

    it('orders host activity and agent health routes before their generic detail routes', () => {
      const hostActivityIndex = router.routes.findIndex((route) => route.method === 'GET' && route.pattern.test('/api/hosts/activity'));
      const hostDetailIndex = router.routes.findIndex((route) => route.method === 'GET' && route.pattern.test('/api/hosts/host-1'));
      const agentHealthIndex = router.routes.findIndex((route) => route.method === 'GET' && route.pattern.test('/api/agents/agent-1/health'));
      const agentDetailIndex = router.routes.findIndex((route) => route.method === 'GET' && route.pattern.test('/api/agents/agent-1'));

      expect(hostActivityIndex).toBeLessThan(hostDetailIndex);
      expect(agentHealthIndex).toBeLessThan(agentDetailIndex);
    });
  });

  describe('dispatch', () => {
    it('parses the query string before rejecting non-local requests and does not run CORS origin validation', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/tasks?status=queued',
        remoteAddress: '10.0.0.9',
      });
      const res = createMockRes();

      await router.dispatch(req, res, context);

      expect(mocks.utils.parseQuery).toHaveBeenCalledWith('/api/tasks?status=queued');
      expect(mocks.utils.isLocalhostOrigin).not.toHaveBeenCalled();
      expect(mocks.utils.sendError).toHaveBeenCalledWith(res, 'Forbidden', 403);
      expect(mocks.tasks.handleListTasks).not.toHaveBeenCalled();
      expect(readJson(res.body)).toEqual({ error: 'Forbidden' });
    });

    it('accepts localhost requests using the connection remoteAddress fallback', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/tasks',
        useSocket: false,
        useConnection: true,
        remoteAddress: '::1',
      });
      const res = createMockRes();

      await router.dispatch(req, res, context);

      expect(mocks.tasks.handleListTasks).toHaveBeenCalledTimes(1);
      expect(mocks.utils.sendError).not.toHaveBeenCalled();
    });

    it('accepts IPv4-mapped localhost addresses', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/tasks',
        remoteAddress: '::ffff:127.0.0.1',
      });
      const res = createMockRes();

      await router.dispatch(req, res, context);

      expect(mocks.tasks.handleListTasks).toHaveBeenCalledTimes(1);
      expect(mocks.utils.sendError).not.toHaveBeenCalled();
    });

    it('stores an allowed localhost origin on the response before invoking the handler', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/tasks',
        headers: { origin: 'http://127.0.0.1:9090' },
      });
      const res = createMockRes();

      await router.dispatch(req, res, context);

      expect(mocks.utils.isLocalhostOrigin).toHaveBeenCalledWith('http://127.0.0.1:9090');
      expect(res._corsOrigin).toBe('http://127.0.0.1:9090');
      expect(mocks.tasks.handleListTasks).toHaveBeenCalledTimes(1);
    });

    it('stores a null CORS origin for disallowed origins', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/tasks',
        headers: { origin: 'http://example.com' },
      });
      const res = createMockRes();

      await router.dispatch(req, res, context);

      expect(res._corsOrigin).toBeNull();
      expect(mocks.tasks.handleListTasks).toHaveBeenCalledTimes(1);
    });

    it('handles CORS preflight requests for local callers without requiring AJAX headers', async () => {
      const req = createMockReq({
        method: 'OPTIONS',
        url: '/api/tasks',
        headers: { origin: 'http://localhost:3000' },
      });
      const res = createMockRes();

      await router.dispatch(req, res, context);

      expect(res.statusCode).toBe(204);
      expect(res.headers).toEqual({
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Origin': 'http://localhost:3000',
      });
      expect(mocks.tasks.handleListTasks).not.toHaveBeenCalled();
      expect(mocks.utils.sendError).not.toHaveBeenCalled();
    });

    it('omits Access-Control-Allow-Origin on preflight when the origin is not localhost', async () => {
      const req = createMockReq({
        method: 'OPTIONS',
        url: '/api/tasks',
        headers: { origin: 'http://evil.example' },
      });
      const res = createMockRes();

      await router.dispatch(req, res, context);

      expect(res.statusCode).toBe(204);
      expect(res.headers).toEqual({
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
    });

    it('rejects non-AJAX mutation requests before hitting route handlers', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/tasks/submit',
      });
      const res = createMockRes();

      await router.dispatch(req, res, context);

      expect(mocks.tasks.handleSubmitTask).not.toHaveBeenCalled();
      expect(mocks.utils.sendError).toHaveBeenCalledWith(res, 'Forbidden', 403);
      expect(readJson(res.body)).toEqual({ error: 'Forbidden' });
    });

    it.each([
      ['POST', '/api/tasks/submit', 'tasks', 'handleSubmitTask'],
      ['PUT', '/api/peek-hosts/host-1', 'infrastructure', 'handleUpdatePeekHost'],
      ['DELETE', '/api/hosts/host-1', 'infrastructure', 'handleDeleteHost'],
    ])('accepts AJAX %s requests with case-insensitive X-Requested-With headers', async (method, url, group, handlerName) => {
      const req = createMockReq({
        method,
        url,
        headers: { 'X-ReQuEsTeD-WiTh': 'XMLHTTPREQUEST' },
      });
      const res = createMockRes();

      await router.dispatch(req, res, context);

      expect(mocks[group][handlerName]).toHaveBeenCalledTimes(1);
      expect(mocks.utils.sendError).not.toHaveBeenCalled();
    });

    it('passes parsed query values, captures, and context to a matched route handler', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/tasks/task-42/diff?mode=full',
      });
      const res = createMockRes();
      mocks.utils.parseQuery.mockReturnValue({ mode: 'full' });

      await router.dispatch(req, res, context);

      expect(mocks.tasks.handleTaskDiff).toHaveBeenCalledWith(req, res, { mode: 'full' }, 'task-42', context);
    });

    it('passes all route captures to action handlers in order', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/tasks/task-77/retry?source=dashboard',
        headers: { 'x-requested-with': 'xmlhttprequest' },
      });
      const res = createMockRes();
      mocks.utils.parseQuery.mockReturnValue({ source: 'dashboard' });

      await router.dispatch(req, res, context);

      expect(mocks.tasks.handleTaskAction).toHaveBeenCalledWith(
        req,
        res,
        { source: 'dashboard' },
        'task-77',
        'retry',
        context,
      );
    });

    it('returns a 404 error when no route matches', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/does-not-exist',
      });
      const res = createMockRes();

      await router.dispatch(req, res, context);

      expect(mocks.utils.sendError).toHaveBeenCalledWith(res, 'Not found', 404);
      expect(readJson(res.body)).toEqual({ error: 'Not found' });
    });

    it('maps Invalid JSON body errors to HTTP 400', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/tasks/submit',
        headers: { 'x-requested-with': 'xmlhttprequest' },
      });
      const res = createMockRes();
      mocks.tasks.handleSubmitTask.mockImplementation(async () => {
        throw new Error('Invalid JSON body');
      });

      await router.dispatch(req, res, context);

      expect(mocks.utils.sendError).toHaveBeenCalledWith(res, 'Invalid JSON body', 400);
    });

    it('maps Request body too large errors to HTTP 400', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/tasks/submit',
        headers: { 'x-requested-with': 'xmlhttprequest' },
      });
      const res = createMockRes();
      mocks.tasks.handleSubmitTask.mockImplementation(async () => {
        throw new Error('Request body too large');
      });

      await router.dispatch(req, res, context);

      expect(mocks.utils.sendError).toHaveBeenCalledWith(res, 'Request body too large', 400);
    });

    it('maps unexpected handler errors to HTTP 500 and logs to stderr', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/tasks',
      });
      const res = createMockRes();
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      mocks.tasks.handleListTasks.mockImplementation(async () => {
        throw new Error('database offline');
      });

      await router.dispatch(req, res, context);

      expect(stderrSpy).toHaveBeenCalledWith('Dashboard API error: database offline\n');
      expect(mocks.utils.sendError).toHaveBeenCalledWith(res, 'database offline', 500);
    });
  });
});
