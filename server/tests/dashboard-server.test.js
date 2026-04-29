const { EventEmitter } = require('events');
const _fs = require('fs');
const path = require('path');
const _vm = require('vm');
const eventBus = require('../event-bus');
function createMockResponse() {
  let resolve;
  const done = new Promise((res) => { resolve = res; });

  const response = {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
      response.headersSent = true;
    }),
    end: vi.fn((body = '') => {
      response.body = Buffer.isBuffer(body) ? body.toString('utf8') : body;
      resolve();
    }),
  };

  return { response, done };
}

function createMockStats({ size = 32, mtimeMs = 1000 } = {}) {
  return {
    size,
    mtimeMs,
    isFile: () => true,
  };
}

function createMissingStatError(candidate) {
  const err = new Error(`ENOENT: no such file or directory, stat '${candidate}'`);
  err.code = 'ENOENT';
  return err;
}

function createMockReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();

  process.nextTick(() => {
    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', payload);
    }
    req.emit('end');
  });

  return req;
}

async function dispatchRequest(handler, reqOptions = {}) {
  const req = createMockReq(reqOptions);
  const { response, done } = createMockResponse();
  handler(req, response);
  await done;
  return response;
}

function createMockWsClient() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = vi.fn();
  ws.close = vi.fn(() => {
    ws.emit('close');
  });
  return ws;
}

function sentEvents(ws) {
  return ws.send.mock.calls.map((call) => JSON.parse(call[0]));
}

function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModuleCache(modulePaths) {
  for (const mod of modulePaths) {
    try {
      delete require.cache[require.resolve(mod)];
    } catch { /* ignore */ }
  }
}

const DASHBOARD_SERVER_TEST_MODULES = [
  '../dashboard-server',
  '../database',
  '../db/task-core',
  '../db/host-management',
  '../dashboard/router',
  '../dashboard/utils',
  '../task-manager',
  'ws',
];

function resetDashboardServerTestState() {
  clearModuleCache(DASHBOARD_SERVER_TEST_MODULES);
  wsInstances = [];
}

// Shared state for WebSocket mock instances
let wsInstances = [];

class MockWebSocketServer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.handlers = {};
    this.close = vi.fn();
    wsInstances.push(this);
  }

  on(event, handler) {
    this.handlers[event] = handler;
    super.on(event, handler);
    return this;
  }
}

let activeDashboardServer = null;

function loadDashboardServer({
  dispatchImpl,
  sendErrorImpl,
  dbOverrides = {},
  fsOverrides,
  instanceId = 'instance-abc123',
} = {}) {
  // Clear all module caches for modules we need to re-mock
  resetDashboardServerTestState();

  wsInstances = [];

  const http = require('http');
  const net = require('net');

  let requestHandler;

  const mockHttpServer = new EventEmitter();
  const nativeOn = mockHttpServer.on.bind(mockHttpServer);
  mockHttpServer.on = vi.fn((event, cb) => {
    nativeOn(event, cb);
    return mockHttpServer;
  });
  mockHttpServer.listen = vi.fn((port, host, cb) => {
    if (cb) cb();
    return mockHttpServer;
  });
  mockHttpServer.close = vi.fn();

  const createServerMock = vi.spyOn(http, 'createServer').mockImplementation((handler) => {
    requestHandler = handler;
    return mockHttpServer;
  });

  const dispatchMock = dispatchImpl || vi.fn(async () => {});
  const sendErrorMock = sendErrorImpl || vi.fn((res, message, status = 400) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  });

  const mockTaskCore = {
    getTask: vi.fn(() => null),
    countTasks: vi.fn(() => 0),
    listTasks: vi.fn(() => []),
    ...Object.fromEntries(Object.entries(dbOverrides).filter(([key]) => (
      ['getTask', 'countTasks', 'countTasksByStatus', 'listTasks'].includes(key)
    ))),
  };
  if (typeof mockTaskCore.countTasksByStatus !== 'function') {
    mockTaskCore.countTasksByStatus = vi.fn(() => ({
      running: mockTaskCore.countTasks({ status: 'running' }),
      queued: mockTaskCore.countTasks({ status: 'queued' }),
      completed: mockTaskCore.countTasks({ status: 'completed' }),
      failed: mockTaskCore.countTasks({ status: 'failed' }),
    }));
  }

  const mockHostManagement = {
    listOllamaHosts: vi.fn(() => []),
    ...Object.fromEntries(Object.entries(dbOverrides).filter(([key]) => (
      ['listOllamaHosts'].includes(key)
    ))),
  };

  const mockDb = {
    getConfig: vi.fn(() => null),
    getTask: mockTaskCore.getTask,
    countTasks: mockTaskCore.countTasks,
    countTasksByStatus: mockTaskCore.countTasksByStatus,
    listTasks: mockTaskCore.listTasks,
    listOllamaHosts: mockHostManagement.listOllamaHosts,
  };

  const mockTaskManager = {
    getMcpInstanceId: vi.fn(() => instanceId),
    getHostActivity: vi.fn(() => ({})),
    isModelLoadedOnHost: vi.fn(() => false),
  };

  const netCreateServerMock = vi.spyOn(net, 'createServer').mockImplementation(() => {
    const listeners = {};
    return {
      once(event, handler) {
        listeners[event] = handler;
        return this;
      },
      listen() {
        process.nextTick(() => {
          if (listeners.listening) listeners.listening();
        });
        return this;
      },
      close(cb) {
        if (cb) cb();
      },
    };
  });

  // Monkey-patch module objects directly in require.cache
  // ws: replace WebSocketServer on the cached module exports
  const ws = require('ws');
  ws.WebSocketServer = MockWebSocketServer;

  // Load the real database facade against mocked task/host sub-modules.
  installMock('../db/task-core', mockTaskCore);
  installMock('../db/host-management', mockHostManagement);

  // dashboard/router: replace with dispatch mock
  installMock('../dashboard/router', { dispatch: dispatchMock });

  // dashboard/utils: replace with sendError mock
  installMock('../dashboard/utils', { sendError: sendErrorMock });

  // task-manager: replace with mock
  installMock('../task-manager', mockTaskManager);

  // fs: if overrides, monkey-patch the fs module
  if (fsOverrides) {
    const fs = require('fs');
    for (const [key, value] of Object.entries(fsOverrides)) {
      if (key === 'promises') {
        for (const [promiseKey, promiseValue] of Object.entries(value)) {
          vi.spyOn(fs.promises, promiseKey).mockImplementation(promiseValue);
        }
      } else {
        vi.spyOn(fs, key).mockImplementation(value);
      }
    }
  }

  // Now load dashboard-server fresh — it will pick up all our mocked modules
  const dashboardServer = require('../dashboard-server');
  activeDashboardServer = dashboardServer;

  return {
    dashboardServer,
    createServerMock,
    netCreateServerMock,
    mockHttpServer,
    wsInstances,
    dispatchMock,
    sendErrorMock,
    mockDb,
    getRequestHandler: () => requestHandler || createServerMock.mock.calls[0]?.[0],
  };
}


describe('dashboard-server', () => {
  beforeEach(() => {
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      if (activeDashboardServer && activeDashboardServer.getStatus().running) {
        activeDashboardServer.stop();
      }
    } catch {
      // Ignore cleanup failures.
    } finally {
      activeDashboardServer = null;
    }
    vi.restoreAllMocks();
    resetDashboardServerTestState();
  });

  it('exports start/stop functions', async () => {
    const { dashboardServer } = await loadDashboardServer();
    expect(typeof dashboardServer.start).toBe('function');
    expect(typeof dashboardServer.stop).toBe('function');
  });

  it('initializes HTTP server on configured port', async () => {
    const { dashboardServer, createServerMock, mockHttpServer } = await loadDashboardServer();

    const result = await dashboardServer.start({ port: 4567, openBrowser: false });

    expect(result).toEqual({
      success: true,
      url: 'http://127.0.0.1:4567',
      port: 4567,
    });
    expect(createServerMock).toHaveBeenCalledTimes(1);
    expect(mockHttpServer.listen).toHaveBeenCalledWith(4567, '127.0.0.1', expect.any(Function));

    dashboardServer.stop();
  });

  it('serves static files from dashboard/dist', async () => {
    const distSuffix = path.join('dashboard', 'dist');
    const indexFileSuffix = path.join('dashboard', 'dist', 'index.html');
    const jsFileSuffix = path.join('dashboard', 'dist', 'app.js');

    const existsSync = vi.fn((candidate) => {
      const value = String(candidate);
      return value.endsWith(distSuffix) || value.endsWith(indexFileSuffix) || value.endsWith(jsFileSuffix);
    });

    const readFile = vi.fn((filePath, cb) => cb(null, Buffer.from('console.log("ok")')));
    const stat = vi.fn(async (filePath) => {
      if (String(filePath).endsWith(jsFileSuffix)) {
        return createMockStats();
      }
      throw createMissingStatError(filePath);
    });

    const { dashboardServer, getRequestHandler } = await loadDashboardServer({
      fsOverrides: { existsSync, readFile, promises: { stat } },
    });

    await dashboardServer.start({ port: 4568, openBrowser: false });
    const response = await dispatchRequest(getRequestHandler(), { method: 'GET', url: '/app.js' });

    expect(readFile).toHaveBeenCalledWith(expect.stringContaining(jsFileSuffix), expect.any(Function));
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(expect.objectContaining({
      'Content-Type': 'application/javascript',
    }));

    dashboardServer.stop();
  });

  it('returns 404 for unknown static paths when index fallback is unavailable', async () => {
    const distSuffix = path.join('dashboard', 'dist');
    const existsSync = vi.fn((candidate) => String(candidate).endsWith(distSuffix));
    const stat = vi.fn(async (filePath) => {
      throw createMissingStatError(filePath);
    });

    const { dashboardServer, getRequestHandler, sendErrorMock } = await loadDashboardServer({
      fsOverrides: {
        existsSync,
        readFile: vi.fn(),
        promises: { stat },
      },
    });

    await dashboardServer.start({ port: 4569, openBrowser: false });
    const response = await dispatchRequest(getRequestHandler(), { method: 'GET', url: '/missing.js' });

    expect(response.statusCode).toBe(404);
    expect(sendErrorMock).toHaveBeenCalledWith(response, 'Not found', 404);

    dashboardServer.stop();
  });

  it('handles WebSocket connections through WebSocketServer', async () => {
    const { dashboardServer, mockHttpServer } = await loadDashboardServer({ instanceId: 'instance-xyz987' });

    await dashboardServer.start({ port: 4570, openBrowser: false });

    expect(wsInstances.length).toBeGreaterThanOrEqual(1);
    const wss = wsInstances[wsInstances.length - 1];
    expect(wss.options).toEqual({ server: mockHttpServer });
    expect(typeof wss.handlers.connection).toBe('function');

    const ws = createMockWsClient();
    wss.handlers.connection(ws);

    const messages = sentEvents(ws);
    expect(messages[0]).toEqual(expect.objectContaining({
      event: 'connected',
      data: expect.objectContaining({
        port: 4570,
        shortId: 'xyz987',
      }),
    }));

    dashboardServer.stop();
  });

  it('broadcasts task-created message to all connected clients', async () => {
    const { dashboardServer } = await loadDashboardServer();

    await dashboardServer.start({ port: 4571, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const ws1 = createMockWsClient();
    const ws2 = createMockWsClient();
    wss.handlers.connection(ws1);
    wss.handlers.connection(ws2);

    dashboardServer.notifyTaskCreated({ id: 'task-1', status: 'queued' });

    const ws1Events = sentEvents(ws1).filter((evt) => evt.event === 'task:created');
    const ws2Events = sentEvents(ws2).filter((evt) => evt.event === 'task:created');

    expect(ws1Events).toHaveLength(1);
    expect(ws2Events).toHaveLength(1);
    expect(ws1Events[0].data.id).toBe('task-1');

    dashboardServer.stop();
  });

  it('broadcasts task output only to subscribed clients', async () => {
    const { dashboardServer } = await loadDashboardServer();

    await dashboardServer.start({ port: 4579, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const subscriber = createMockWsClient();
    const otherClient = createMockWsClient();
    wss.handlers.connection(subscriber);
    wss.handlers.connection(otherClient);

    subscriber.emit('message', Buffer.from(JSON.stringify({ event: 'subscribe', taskId: 'task-2' })));

    dashboardServer.notifyTaskOutput('task-2', 'stream chunk');

    const subscriberEvents = sentEvents(subscriber).filter((evt) => evt.event === 'task:output');
    const otherEvents = sentEvents(otherClient).filter((evt) => evt.event === 'task:output');

    expect(subscriberEvents).toHaveLength(1);
    expect(subscriberEvents[0].data).toEqual({ taskId: 'task-2', chunk: 'stream chunk' });
    expect(otherEvents).toHaveLength(0);

    dashboardServer.stop();
  });

  it('preserves structured stderr task output chunks', async () => {
    const { dashboardServer } = await loadDashboardServer();

    await dashboardServer.start({ port: 4572, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const subscriber = createMockWsClient();
    wss.handlers.connection(subscriber);

    subscriber.emit('message', Buffer.from(JSON.stringify({ event: 'subscribe', taskId: 'task-2' })));
    const chunk = { content: 'codex stderr chunk', type: 'stderr', isStderr: true, sequence: 3 };
    dashboardServer.notifyTaskOutput('task-2', chunk);

    const subscriberEvents = sentEvents(subscriber).filter((evt) => evt.event === 'task:output');

    expect(subscriberEvents).toHaveLength(1);
    expect(subscriberEvents[0].data).toEqual({ taskId: 'task-2', chunk });

    dashboardServer.stop();
  });

  it('removes disconnected clients from broadcast list', async () => {
    const { dashboardServer } = await loadDashboardServer();

    await dashboardServer.start({ port: 4573, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const staleClient = createMockWsClient();
    const liveClient = createMockWsClient();
    wss.handlers.connection(staleClient);
    wss.handlers.connection(liveClient);

    staleClient.emit('close');
    dashboardServer.notifyTaskCreated({ id: 'task-3' });

    expect(sentEvents(staleClient).filter((evt) => evt.event === 'task:created')).toHaveLength(0);
    expect(sentEvents(liveClient).filter((evt) => evt.event === 'task:created')).toHaveLength(1);
    expect(dashboardServer.getStatus().clients).toBe(1);

    dashboardServer.stop();
  });

  it('handles malformed WebSocket messages without crashing', async () => {
    const { dashboardServer } = await loadDashboardServer();

    await dashboardServer.start({ port: 4574, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const ws = createMockWsClient();
    wss.handlers.connection(ws);

    expect(() => ws.emit('message', Buffer.from('{not-json'))).not.toThrow();

    dashboardServer.notifyTaskCreated({ id: 'task-4' });
    const created = sentEvents(ws).find((evt) => evt.event === 'task:created');
    expect(created).toBeDefined();

    dashboardServer.stop();
  });

  it('notifyTaskUpdated sends tasks:batch-updated event', async () => {
    vi.useFakeTimers();

    const { dashboardServer, mockDb } = await loadDashboardServer({
      dbOverrides: {
        getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      },
    });

    await dashboardServer.start({ port: 4575, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const ws = createMockWsClient();
    wss.handlers.connection(ws);

    dashboardServer.notifyTaskUpdated('task-5');
    vi.advanceTimersByTime(500);

    const updates = sentEvents(ws).filter((evt) => evt.event === 'tasks:batch-updated');
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toEqual([{ id: 'task-5', status: 'running' }]);
    expect(mockDb.getTask).toHaveBeenCalledWith('task-5');

    dashboardServer.stop();
  });

  it('notifyTaskUpdated triggers stats:updated event', async () => {
    vi.useFakeTimers();

    const { dashboardServer } = await loadDashboardServer({
      dbOverrides: {
        getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
        countTasks: vi.fn(({ status }) => ({ running: 2, queued: 1, completed: 4, failed: 1 }[status] || 0)),
      },
    });

    await dashboardServer.start({ port: 4576, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const ws = createMockWsClient();
    wss.handlers.connection(ws);

    dashboardServer.notifyTaskUpdated('task-6');
    vi.advanceTimersByTime(500);

    const statsUpdate = sentEvents(ws).find((evt) => evt.event === 'stats:updated');
    expect(statsUpdate).toBeDefined();
    expect(statsUpdate.data).toEqual({
      running: 2,
      queued: 1,
      completed: 4,
      failed: 1,
    });

    dashboardServer.stop();
  });

  it('broadcasts torque:task-updated process events to websocket clients', async () => {
    vi.useFakeTimers();

    const { dashboardServer, mockDb } = await loadDashboardServer({
      dbOverrides: {
        getTask: vi.fn((taskId) => ({ id: taskId, status: 'queued' })),
      },
    });

    await dashboardServer.start({ port: 45765, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const ws = createMockWsClient();
    wss.handlers.connection(ws);

    eventBus.emitTaskUpdated({ taskId: 'task-8', status: 'queued' });
    vi.advanceTimersByTime(500);

    const updates = sentEvents(ws).filter((evt) => evt.event === 'tasks:batch-updated');
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toEqual([{ id: 'task-8', status: 'queued' }]);
    expect(mockDb.getTask).toHaveBeenCalledWith('task-8');

    dashboardServer.stop();
  });

  it('TDA-07: delta includes provider/model/host when present on task', async () => {
    vi.useFakeTimers();

    const { dashboardServer, mockDb: _mockDb } = await loadDashboardServer({
      dbOverrides: {
        getTask: vi.fn(() => ({
          id: 'task-reassigned',
          status: 'queued',
          provider: 'deepinfra',
          model: 'Qwen/Qwen2.5-72B-Instruct',
          ollama_host_id: null,
        })),
      },
    });

    await dashboardServer.start({ port: 45770, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const ws = createMockWsClient();
    wss.handlers.connection(ws);

    dashboardServer.notifyTaskUpdated('task-reassigned');
    vi.advanceTimersByTime(500);

    const updates = sentEvents(ws).filter((evt) => evt.event === 'tasks:batch-updated');
    expect(updates).toHaveLength(1);
    expect(updates[0].data[0]).toEqual(expect.objectContaining({
      id: 'task-reassigned',
      status: 'queued',
      provider: 'deepinfra',
      model: 'Qwen/Qwen2.5-72B-Instruct',
    }));

    dashboardServer.stop();
  });

  it('notifyTaskDeleted sends task:deleted event', async () => {
    const { dashboardServer } = await loadDashboardServer();

    await dashboardServer.start({ port: 4577, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const ws = createMockWsClient();
    wss.handlers.connection(ws);

    dashboardServer.notifyTaskDeleted('task-7');

    const deleted = sentEvents(ws).find((evt) => evt.event === 'task:deleted');
    expect(deleted).toEqual({
      event: 'task:deleted',
      data: { taskId: 'task-7' },
    });

    dashboardServer.stop();
  });

  it('creates static responses with security headers', async () => {
    const distSuffix = path.join('dashboard', 'dist');
    const indexFileSuffix = path.join('dashboard', 'dist', 'index.html');
    const cssFileSuffix = path.join('dashboard', 'dist', 'style.css');

    const existsSync = vi.fn((candidate) => {
      const value = String(candidate);
      return value.endsWith(distSuffix) || value.endsWith(indexFileSuffix) || value.endsWith(cssFileSuffix);
    });

    const readFile = vi.fn((filePath, cb) => cb(null, Buffer.from('body {}')));
    const stat = vi.fn(async (filePath) => {
      if (String(filePath).endsWith(cssFileSuffix)) {
        return createMockStats();
      }
      throw createMissingStatError(filePath);
    });

    const { dashboardServer, getRequestHandler } = await loadDashboardServer({
      fsOverrides: { existsSync, readFile, promises: { stat } },
    });

    await dashboardServer.start({ port: 4578, openBrowser: false });
    const response = await dispatchRequest(getRequestHandler(), { method: 'GET', url: '/style.css' });

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(expect.objectContaining({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'X-XSS-Protection': '1; mode=block',
    }));

    dashboardServer.stop();
  });

  it('routes /api/* requests to dashboard router dispatch', async () => {
    const dispatchMock = vi.fn(async () => {});
    const { dashboardServer, getRequestHandler } = await loadDashboardServer({ dispatchImpl: dispatchMock });

    await dashboardServer.start({ port: 4579, openBrowser: false });

    const req = createMockReq({ method: 'GET', url: '/api/tasks?limit=5' });
    const { response } = createMockResponse();

    getRequestHandler()(req, response);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      req,
      response,
      expect.objectContaining({
        broadcastTaskUpdate: expect.any(Function),
        clients: expect.any(Set),
        serverPort: 4579,
      }),
    );

    dashboardServer.stop();
  });

  it('returns structured 500 error when API dispatch throws', async () => {
    const dispatchMock = vi.fn(() => Promise.reject(new Error('boom')));
    const { dashboardServer, getRequestHandler, sendErrorMock } = await loadDashboardServer({
      dispatchImpl: dispatchMock,
    });

    await dashboardServer.start({ port: 4580, openBrowser: false });

    const req = createMockReq({ method: 'GET', url: '/api/tasks' });
    const { response, done } = createMockResponse();

    getRequestHandler()(req, response);
    await done;

    expect(sendErrorMock).toHaveBeenCalledWith(response, 'Internal server error', 500);

    dashboardServer.stop();
  });

  it('stop closes websocket clients and HTTP server', async () => {
    const { dashboardServer, mockHttpServer } = await loadDashboardServer();

    await dashboardServer.start({ port: 4581, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const ws1 = createMockWsClient();
    const ws2 = createMockWsClient();
    wss.handlers.connection(ws1);
    wss.handlers.connection(ws2);

    const result = dashboardServer.stop();

    expect(result).toEqual({ success: true });
    expect(ws1.close).toHaveBeenCalledTimes(1);
    expect(ws2.close).toHaveBeenCalledTimes(1);
    expect(wss.close).toHaveBeenCalledTimes(1);
    expect(mockHttpServer.close).toHaveBeenCalledTimes(1);
  });

  it('getStatus reports running state, port, and connected client count', async () => {
    const { dashboardServer } = await loadDashboardServer();

    expect(dashboardServer.getStatus()).toEqual({
      running: false,
      port: null,
      url: null,
      clients: 0,
    });

    await dashboardServer.start({ port: 4582, openBrowser: false });

    const wss = wsInstances[wsInstances.length - 1];
    const ws = createMockWsClient();
    wss.handlers.connection(ws);

    expect(dashboardServer.getStatus()).toEqual({
      running: true,
      port: 4582,
      url: 'http://127.0.0.1:4582',
      clients: 1,
    });

    dashboardServer.stop();
  });
});


describe('dashboard router/utils helpers', () => {
  beforeEach(() => {
    // Clear require.cache entries that were monkey-patched by dashboard-server tests
    for (const mod of [
      '../db/host-management',
      '../dashboard/router',
      '../dashboard/utils',
      '../dashboard/routes/tasks',
      '../dashboard/routes/infrastructure',
      '../dashboard/routes/analytics',
      '../dashboard/routes/admin',
    ]) {
      try {
        const resolved = require.resolve(mod);
        delete require.cache[resolved];
      } catch { /* ignore */ }
    }

    const hostManagementMock = new Proxy({
      getOllamaHost: vi.fn(() => null),
    }, {
      get(target, prop) {
        if (!(prop in target)) {
          target[prop] = vi.fn(() => null);
        }
        return target[prop];
      },
    });

    const createRouteModuleMock = () => new Proxy({}, {
      get(target, prop) {
        if (!(prop in target)) {
          target[prop] = vi.fn();
        }
        return target[prop];
      },
    });

    installMock('../db/host-management', hostManagementMock);
    installMock('../dashboard/routes/tasks', createRouteModuleMock());
    installMock('../dashboard/routes/infrastructure', createRouteModuleMock());
    installMock('../dashboard/routes/analytics', createRouteModuleMock());
    installMock('../dashboard/routes/admin', createRouteModuleMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const mod of [
      '../db/host-management',
      '../dashboard/router',
      '../dashboard/utils',
      '../dashboard/routes/tasks',
      '../dashboard/routes/infrastructure',
      '../dashboard/routes/analytics',
      '../dashboard/routes/admin',
    ]) {
      try {
        delete require.cache[require.resolve(mod)];
      } catch { /* ignore */ }
    }
  });

  it('handles CORS preflight OPTIONS requests', async () => {
    const { dispatch } = require('../dashboard/router');

    const req = createMockReq({
      method: 'OPTIONS',
      url: '/api/tasks',
      headers: { origin: 'http://localhost:3456' },
    });
    req.socket = { remoteAddress: '127.0.0.1' };
    req.connection = { remoteAddress: '127.0.0.1' };
    const { response, done } = createMockResponse();

    await dispatch(req, response, {});
    await done;

    expect(response.statusCode).toBe(204);
    expect(response.headers).toEqual(expect.objectContaining({
      'Access-Control-Allow-Origin': 'http://localhost:3456',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    }));
  });

  it('returns 404 for unknown API routes', async () => {
    const { dispatch } = require('../dashboard/router');

    const req = createMockReq({ method: 'GET', url: '/api/not-a-route', headers: {} });
    req.socket = { remoteAddress: '127.0.0.1' };
    req.connection = { remoteAddress: '127.0.0.1' };
    const { response, done } = createMockResponse();

    await dispatch(req, response, {});
    await done;

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: 'Not found' });
  });

  it('parseQuery extracts query parameters', () => {
    const utils = require('../dashboard/utils');

    expect(utils.parseQuery('/api/tasks?status=running&limit=10')).toEqual({
      status: 'running',
      limit: '10',
    });
  });

  it('parseBody reads JSON POST body', async () => {
    const utils = require('../dashboard/utils');

    const req = createMockReq({
      method: 'POST',
      url: '/api/tasks',
      body: { taskId: 'abc', action: 'retry' },
    });

    const body = await utils.parseBody(req);

    expect(body).toEqual({ taskId: 'abc', action: 'retry' });
  });

  it('sendJson sets application/json content-type and status', () => {
    const utils = require('../dashboard/utils');
    const { response } = createMockResponse();

    utils.sendJson(response, { ok: true }, 201);

    expect(response.writeHead).toHaveBeenCalledWith(201, expect.objectContaining({
      'Content-Type': 'application/json',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    }));
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });

  it('sendError returns structured JSON error response', () => {
    const utils = require('../dashboard/utils');
    const { response } = createMockResponse();

    utils.sendError(response, 'Bad request', 400);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'Bad request' });
  });

  it('enrichTaskWithHostName adds computed host name', () => {
    const hostMgmt = require('../db/host-management');
    const utils = require('../dashboard/utils');

    vi.spyOn(hostMgmt, 'getOllamaHost').mockReturnValue({ id: 'host-1', name: 'GPU Host 1' });

    const task = {
      id: 'task-8',
      ollama_host_id: 'host-1',
      status: 'completed',
    };

    const enriched = utils.enrichTaskWithHostName(task);
    expect(enriched.ollama_host_name).toBe('GPU Host 1');
  });

  it('enrichTaskWithHostName falls back to host id when lookup fails', () => {
    const hostMgmt = require('../db/host-management');
    const utils = require('../dashboard/utils');

    vi.spyOn(hostMgmt, 'getOllamaHost').mockImplementation(() => {
      throw new Error('lookup failed');
    });

    const task = {
      id: 'task-9',
      ollama_host_id: 'host-missing',
      status: 'completed',
    };

    const enriched = utils.enrichTaskWithHostName(task);
    expect(enriched.ollama_host_name).toBe('host-missing');
  });
});

describe('dashboard routes stats handlers', () => {
  it('handleEventHistory returns null for malformed event_data', async () => {
    const eventsPath = require.resolve('../hooks/event-dispatch');
    const originalEventDispatch = require.cache[eventsPath];
    require.cache[eventsPath] = {
      id: eventsPath,
      filename: eventsPath,
      loaded: true,
      exports: {
        getTaskEvents: vi.fn(() => ([
          { id: 'event-1', event_data: '{"name":"ok","value":1}' },
          { id: 'event-2', event_data: '{ this is broken' },
          { id: 'event-3', event_data: null },
        ])),
      },
    };

    try {
      const { handleEventHistory } = require('../dashboard/routes/analytics');
      const { response, done } = createMockResponse();

      handleEventHistory({}, response, {});
      await done;

      const payload = JSON.parse(response.body);
      expect(payload.events).toEqual([
        { id: 'event-1', event_data: { name: 'ok', value: 1 } },
        { id: 'event-2', event_data: null },
        { id: 'event-3', event_data: null },
      ]);
      expect(payload.count).toBe(3);
      expect(payload.error).toBeUndefined();
    } finally {
      if (originalEventDispatch) {
        require.cache[eventsPath] = originalEventDispatch;
      } else {
        delete require.cache[eventsPath];
      }
      delete require.cache[require.resolve('../dashboard/routes/analytics')];
    }
  });
});
