const { EventEmitter } = require('events');
const fs = require('fs');

function normalizePath(candidate) {
  return String(candidate).replace(/\\/g, '/');
}

function endsWithPath(candidate, parts) {
  return normalizePath(candidate).endsWith(parts.join('/'));
}

function createMissingError(candidate) {
  const err = new Error(`ENOENT: no such file or directory, stat '${candidate}'`);
  err.code = 'ENOENT';
  return err;
}

function createStats({ size = 24, mtimeMs = 1000 } = {}) {
  return {
    size,
    mtimeMs,
    isFile: () => true,
  };
}

function createMockResponse() {
  let resolve;
  const done = new Promise((res) => { resolve = res; });

  const response = {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
      response.headersSent = true;
    }),
    end: vi.fn((body = '') => {
      response.body = Buffer.isBuffer(body) ? body.toString('utf8') : body;
      response.writableEnded = true;
      resolve();
    }),
  };

  return { response, done };
}

function createMockReq({ method = 'GET', url = '/', headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();
  return req;
}

async function dispatchRequest(handler, reqOptions = {}) {
  const req = createMockReq(reqOptions);
  const { response, done } = createMockResponse();
  handler(req, response);
  await done;
  return response;
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

const DASHBOARD_SERVER_MODULES = [
  '../dashboard/server',
  '../database',
  '../db/task-core',
  '../db/host-management',
  '../dashboard/router',
  '../dashboard/utils',
  '../api/v2-dispatch',
  '../config',
  '../event-bus',
  '../task-manager',
  'ws',
];

function clearDashboardServerModules() {
  for (const modulePath of DASHBOARD_SERVER_MODULES) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Module may not have been loaded by this test.
    }
  }
}

function staticExistsCalls(existsSync) {
  return existsSync.mock.calls.filter(([candidate]) => {
    const value = normalizePath(candidate);
    return value.includes('/dashboard/dist/') || value.includes('/server/dashboard/');
  });
}

class MockWebSocketServer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.close = vi.fn();
  }
}

let activeDashboardServer = null;

function loadDashboardServer({ existsSyncImpl, readFileImpl, statImpl }) {
  clearDashboardServerModules();

  const http = require('http');
  const net = require('net');

  let requestHandler;
  const mockHttpServer = new EventEmitter();
  mockHttpServer.listen = vi.fn((port, host, cb) => {
    if (cb) cb();
    return mockHttpServer;
  });
  mockHttpServer.close = vi.fn();

  vi.spyOn(http, 'createServer').mockImplementation((handler) => {
    requestHandler = handler;
    return mockHttpServer;
  });

  vi.spyOn(net, 'createServer').mockImplementation(() => {
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

  const eventBus = new EventEmitter();
  eventBus.onTaskUpdated = vi.fn((listener) => eventBus.on('task-updated', listener));

  const sendError = vi.fn((res, message, status = 400) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  });

  installMock('../database', {});
  installMock('../db/task-core', {
    listTasks: vi.fn(() => []),
    countTasks: vi.fn(() => 0),
    countTasksByStatus: vi.fn(() => ({ running: 0, queued: 0, completed: 0, failed: 0 })),
    getTask: vi.fn(() => null),
  });
  installMock('../db/host-management', { listOllamaHosts: vi.fn(() => []) });
  installMock('../dashboard/router', { dispatch: vi.fn(async () => {}) });
  installMock('../dashboard/utils', {
    sendError,
    isLocalhostOrigin: vi.fn(() => true),
  });
  installMock('../api/v2-dispatch', {
    dispatchV2: vi.fn(async () => false),
    init: vi.fn(),
    MAX_BODY_SIZE: 1024 * 1024,
    validateJsonDepth: vi.fn(),
  });
  installMock('../config', { getInt: vi.fn((key, fallback) => fallback) });
  installMock('../event-bus', eventBus);
  installMock('../task-manager', {
    getMcpInstanceId: vi.fn(() => 'static-test-instance'),
    getHostActivity: vi.fn(() => ({})),
    isModelLoadedOnHost: vi.fn(() => false),
  });
  installMock('ws', { WebSocketServer: MockWebSocketServer });

  const existsSync = vi.spyOn(fs, 'existsSync').mockImplementation(existsSyncImpl);
  const readFile = vi.spyOn(fs, 'readFile').mockImplementation(readFileImpl);
  const stat = vi.spyOn(fs.promises, 'stat').mockImplementation(statImpl);

  const dashboardServer = require('../dashboard/server');
  activeDashboardServer = dashboardServer;

  return {
    dashboardServer,
    existsSync,
    readFile,
    stat,
    sendError,
    getRequestHandler: () => requestHandler,
  };
}

function createReactExistsSync({ hasReactIndex = true } = {}) {
  return vi.fn((candidate) => (
    hasReactIndex && endsWithPath(candidate, ['dashboard', 'dist', 'index.html'])
  ));
}

describe('dashboard-server static serving', () => {
  afterEach(() => {
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
    clearDashboardServerModules();
  });

  it('selects the React dashboard directory once and reuses it for repeated asset requests', async () => {
    const existsSyncImpl = createReactExistsSync({ hasReactIndex: true });
    const readFileImpl = vi.fn((filePath, cb) => {
      if (endsWithPath(filePath, ['dashboard', 'dist', 'app.js'])) {
        cb(null, Buffer.from('console.log("ok")'));
        return;
      }
      cb(createMissingError(filePath));
    });
    const statImpl = vi.fn(async (filePath) => {
      if (endsWithPath(filePath, ['dashboard', 'dist', 'app.js'])) {
        return createStats();
      }
      throw createMissingError(filePath);
    });

    const { dashboardServer, existsSync, readFile, getRequestHandler } = loadDashboardServer({
      existsSyncImpl,
      readFileImpl,
      statImpl,
    });

    await dashboardServer.start({ port: 4590, openBrowser: false });
    const existsCallsAfterStartup = staticExistsCalls(existsSync).length;
    existsSync.mockImplementation(() => false);

    const first = await dispatchRequest(getRequestHandler(), { url: '/app.js' });
    const second = await dispatchRequest(getRequestHandler(), { url: '/app.js?cache-bust=1' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(readFile).toHaveBeenCalledWith(expect.stringMatching(/[\\/]dashboard[\\/]dist[\\/]app\.js$/),
      expect.any(Function));
    expect(staticExistsCalls(existsSync)).toHaveLength(existsCallsAfterStartup);
    expect(staticExistsCalls(existsSync)).toHaveLength(1);

    dashboardServer.stop();
  });

  it('serves index.html for extensionless SPA routes when the route file is absent', async () => {
    const existsSyncImpl = createReactExistsSync({ hasReactIndex: true });
    const readFileImpl = vi.fn((filePath, cb) => {
      if (endsWithPath(filePath, ['dashboard', 'dist', 'index.html'])) {
        cb(null, Buffer.from('<main>dashboard shell</main>'));
        return;
      }
      cb(createMissingError(filePath));
    });
    const statImpl = vi.fn(async (filePath) => {
      if (endsWithPath(filePath, ['dashboard', 'dist', 'index.html'])) {
        return createStats();
      }
      throw createMissingError(filePath);
    });

    const { dashboardServer, readFile, getRequestHandler } = loadDashboardServer({
      existsSyncImpl,
      readFileImpl,
      statImpl,
    });

    await dashboardServer.start({ port: 4591, openBrowser: false });
    const response = await dispatchRequest(getRequestHandler(), { url: '/tasks/active' });

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(expect.objectContaining({ 'Content-Type': 'text/html' }));
    expect(response.body).toBe('<main>dashboard shell</main>');
    expect(readFile).toHaveBeenCalledWith(expect.stringMatching(/[\\/]dashboard[\\/]dist[\\/]index\.html$/),
      expect.any(Function));

    dashboardServer.stop();
  });

  it('returns 404 for a missing static asset without per-request existsSync checks', async () => {
    const existsSyncImpl = createReactExistsSync({ hasReactIndex: true });
    const readFileImpl = vi.fn((filePath, cb) => cb(createMissingError(filePath)));
    const statImpl = vi.fn(async (filePath) => {
      throw createMissingError(filePath);
    });

    const { dashboardServer, existsSync, readFile, stat, sendError, getRequestHandler } = loadDashboardServer({
      existsSyncImpl,
      readFileImpl,
      statImpl,
    });

    await dashboardServer.start({ port: 4592, openBrowser: false });
    const existsCallsAfterStartup = staticExistsCalls(existsSync).length;

    const response = await dispatchRequest(getRequestHandler(), { url: '/assets/missing.js' });

    expect(response.statusCode).toBe(404);
    expect(sendError).toHaveBeenCalledWith(response, 'Not found', 404);
    expect(readFile).not.toHaveBeenCalled();
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith(expect.stringMatching(/[\\/]dashboard[\\/]dist[\\/]assets[\\/]missing\.js$/));
    expect(staticExistsCalls(existsSync)).toHaveLength(existsCallsAfterStartup);
    expect(staticExistsCalls(existsSync)).toHaveLength(1);

    dashboardServer.stop();
  });
});
