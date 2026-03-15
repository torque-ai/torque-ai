const { EventEmitter } = require('events');
const http = require('http');
const db = require('../database');

const { dispatch } = require('../dashboard/router');

function createSseMockResponse() {
  const chunks = [];
  let resolve;
  const done = new Promise((res) => {
    resolve = res;
  });
  const response = {
    statusCode: null,
    headers: {},
    writableEnded: false,
    on: vi.fn(() => {}),
    setHeader: vi.fn((key, value) => {
      response.headers[key] = value;
    }),
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      if (headers) Object.assign(response.headers, headers);
    }),
    write: vi.fn((data) => {
      chunks.push(data);
    }),
    end: vi.fn((body = '') => {
      if (body) chunks.push(body);
      response.writableEnded = true;
      resolve();
    }),
    getBody: () => chunks.join(''),
  };
  return { response, done };
}

async function dispatchSseRequest(handler, { method, url, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();

  const { response, done } = createSseMockResponse();
  const handlerPromise = handler(req, response);
  process.nextTick(() => {
    req.emit('end');
  });

  await handlerPromise;
  if (!response.writableEnded) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  } else {
    await done;
  }

  return { response };
}

function createDashboardReq({
  method = 'GET',
  url = '/',
  headers = {},
  remoteAddress = '127.0.0.1',
  body,
} = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  req.connection = { remoteAddress };
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

function createDashboardRes() {
  let resolve;
  const done = new Promise((res) => {
    resolve = res;
  });
  const response = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      response.body = body;
      resolve();
    }),
  };
  return { response, done };
}

function parseJson(body) {
  return body ? JSON.parse(body) : null;
}

describe('Security: MCP SSE CORS and dashboard API auth/CSRF', () => {
  let mcpSse;
  let handleHttpRequest;
  const mockServer = {
    on: vi.fn(),
    listen: vi.fn((port, host, cb) => {
      if (cb) cb();
    }),
    close: vi.fn(),
  };

  beforeAll(() => {
    // Mock DB so mcp-sse.start() can call getConfig without a real database
    vi.spyOn(db, 'getConfig').mockReturnValue(null);
    vi.spyOn(db, 'getDbInstance').mockReturnValue({});
    if (typeof db.isDbClosed === 'function') {
      vi.spyOn(db, 'isDbClosed').mockReturnValue(false);
    }

    vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      handleHttpRequest = handler;
      return mockServer;
    });
    mcpSse = require('../mcp-sse');
  });

  afterAll(() => {
    if (mcpSse?.stop) mcpSse.stop();
    vi.restoreAllMocks();
  });

  describe('MCP SSE CORS origin allow-list', () => {
    beforeAll(async () => {
      await mcpSse.start({ port: 0 });
    });

    it('rejects non-allowlisted origins', async () => {
      const { response } = await dispatchSseRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458', origin: 'http://malicious.example' },
      });

      expect(response.statusCode).toBe(403);
      expect(parseJson(response.getBody())).toEqual({ error: 'Origin not allowed' });
      expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('accepts localhost origins', async () => {
      const { response } = await dispatchSseRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458', origin: 'http://localhost:3456' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3456');
    });
  });

  describe('dashboard/router auth and CSRF guards', () => {
    const context = { broadcastTaskUpdate: vi.fn(), clients: new Set(), serverPort: 3456 };

    it('rejects non-localhost requests', async () => {
      const req = createDashboardReq({
        method: 'GET',
        url: '/api/tasks',
        remoteAddress: '203.0.113.77',
      });
      const { response, done } = createDashboardRes();

      await dispatch(req, response, context);
      await done;

      expect(response.statusCode).toBe(403);
      expect(parseJson(response.body)).toEqual({ error: 'Forbidden' });
    });

    it('requires X-Requested-With for POST/DELETE/PUT', async () => {
      const req = createDashboardReq({
        method: 'POST',
        url: '/api/not-a-real-route',
        remoteAddress: '127.0.0.1',
      });
      const { response, done } = createDashboardRes();

      await dispatch(req, response, context);
      await done;

      expect(response.statusCode).toBe(403);
      expect(parseJson(response.body)).toEqual({ error: 'Forbidden' });
    });

    it('allows local mutation requests with X-Requested-With', async () => {
      const req = createDashboardReq({
        method: 'POST',
        url: '/api/not-a-real-route',
        remoteAddress: '127.0.0.1',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
      });
      const { response, done } = createDashboardRes();

      await dispatch(req, response, context);
      await done;

      expect(response.statusCode).toBe(404);
    });
  });
});
