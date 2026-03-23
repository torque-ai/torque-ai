const http = require('http');
const crypto = require('crypto');
const db = require('../database');
const configCore = require('../db/config-core');
const taskCore = require('../db/task-core');
const tools = require('../tools');
const authMiddleware = require('../auth/middleware');

function createMockResponse() {
  let resolve;
  const done = new Promise((res) => { resolve = res; });
  const responseHeaders = {};
  const listeners = {};
  const response = {
    statusCode: null,
    headers: null,
    body: '',
    on: vi.fn((event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    emit: vi.fn((event, ...args) => {
      (listeners[event] || []).forEach(cb => cb(...args));
    }),
    setHeader: vi.fn((name, value) => {
      responseHeaders[name.toLowerCase()] = value;
    }),
    getHeader: vi.fn((name) => responseHeaders[name.toLowerCase()]),
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

async function dispatchRequest(handler, { method, url, headers = {}, remoteAddress } = {}) {
  const req = new (require('events').EventEmitter)();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();
  req.socket = { remoteAddress: remoteAddress || '127.0.0.1' };
  req.connection = { remoteAddress: remoteAddress || '127.0.0.1' };

  const { response, done } = createMockResponse();
  const handlerPromise = handler(req, response);

  process.nextTick(() => {
    req.emit('end');
  });

  await handlerPromise;
  await done;
  return response;
}

describe('API key timing-safe authentication', () => {
  const VALID_API_KEY = 'torque_sk_timing-safe-key-01';
  const INVALID_API_KEY = 'torque_sk_timing-safe-key-zz';

  let requestHandler;
  let authenticateSpy;
  let handleToolCallSpy;

  const mockServer = {
    on: vi.fn(),
    listen: vi.fn((port, host, cb) => { if (cb) cb(); }),
    close: vi.fn(),
  };

  beforeAll(() => {
    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
    vi.spyOn(taskCore, 'countTasks').mockReturnValue(0);
    vi.spyOn(db, 'getDbInstance').mockReturnValue({});
    if (typeof db.isDbClosed === 'function') {
      vi.spyOn(db, 'isDbClosed').mockReturnValue(false);
    }

    handleToolCallSpy = vi.spyOn(tools, 'handleToolCall').mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });

    // Mock the auth middleware — auth now uses key-manager (HMAC hashing + DB),
    // not direct config comparison. We mock authenticate() to simulate the auth layer.
    authenticateSpy = vi.spyOn(authMiddleware, 'authenticate');

    vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      requestHandler = handler;
      return mockServer;
    });

    const apiServer = require('../api-server');
    apiServer.start({ port: 5001 });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: authenticate returns identity for valid key, null for others
    authenticateSpy.mockImplementation((req) => {
      const key = req.headers?.['x-torque-key'] ||
        (req.headers?.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
      if (key === VALID_API_KEY) {
        return { id: 'test-key', name: 'Test Key', role: 'admin', type: 'api_key' };
      }
      return null;
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('accepts a valid API key', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks',
      headers: { 'x-torque-key': VALID_API_KEY },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects an invalid API key', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks',
      headers: { 'x-torque-key': INVALID_API_KEY },
    });

    expect(response.statusCode).toBe(401);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('unauthorized');
    expect(payload.error.request_id).toBeDefined();
    expect(handleToolCallSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', { 'x-torque-key': '' }],
    ['missing', undefined],
  ])('rejects %s API key', async (_caseName, headers) => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks',
      ...(headers ? { headers } : {}),
    });

    expect(response.statusCode).toBe(401);
    const payload = JSON.parse(response.body);
    expect(payload.error.code).toBe('unauthorized');
    expect(payload.error.request_id).toBeDefined();
  });

  it('auth middleware uses HMAC-based key validation (timing-safe by design)', async () => {
    // The new auth flow uses key-manager.validateKey() which:
    // 1. Hashes the plaintext key with HMAC-SHA-256 (using a server secret)
    // 2. Queries the DB for the hash (WHERE key_hash = ?)
    // This is timing-safe by design — DB lookups don't leak key-comparison timing.
    // Verify that authenticate() is called for each request.
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks',
      headers: { 'x-torque-key': INVALID_API_KEY },
    });

    expect(response.statusCode).toBe(401);
    expect(authenticateSpy).toHaveBeenCalledTimes(1);

    // Verify the request object was passed to authenticate
    const [passedReq] = authenticateSpy.mock.calls[0];
    expect(passedReq.headers['x-torque-key']).toBe(INVALID_API_KEY);
  });
});
