const http = require('http');
const crypto = require('crypto');
const db = require('../database');
const tools = require('../tools');

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
  const VALID_API_KEY = 'timing-safe-key-01';
  const INVALID_API_KEY = 'timing-safe-key-zz';

  let requestHandler;
  let getConfigSpy;
  let handleToolCallSpy;
  let timingSafeEqualSpy;

  const mockServer = {
    on: vi.fn(),
    listen: vi.fn((port, host, cb) => { if (cb) cb(); }),
    close: vi.fn(),
  };

  beforeAll(() => {
    getConfigSpy = vi.spyOn(db, 'getConfig').mockReturnValue(null);
    vi.spyOn(db, 'countTasks').mockReturnValue(0);
    vi.spyOn(db, 'getDbInstance').mockReturnValue({});
    if (typeof db.isDbClosed === 'function') {
      vi.spyOn(db, 'isDbClosed').mockReturnValue(false);
    }

    handleToolCallSpy = vi.spyOn(tools, 'handleToolCall').mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });

    timingSafeEqualSpy = vi.spyOn(crypto, 'timingSafeEqual');

    vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      requestHandler = handler;
      return mockServer;
    });

    const apiServer = require('../api-server');
    apiServer.start({ port: 5001 });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getConfigSpy.mockImplementation((key) => key === 'api_key' ? VALID_API_KEY : null);
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

  it('uses crypto.timingSafeEqual for API key comparisons', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/tasks',
      headers: { 'x-torque-key': INVALID_API_KEY },
    });

    expect(response.statusCode).toBe(401);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
    const [a, b] = timingSafeEqualSpy.mock.calls[0];
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(a.toString()).toBe(INVALID_API_KEY);
    expect(b.toString()).toBe(VALID_API_KEY);
  });
});
