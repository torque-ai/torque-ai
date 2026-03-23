const http = require('http');
const configCore = require('../db/config-core');
const { EventEmitter } = require('events');

const MAX_SSE_SESSIONS = 50;
let mcpSse;
let toolsModulePath;

function createMockResponse() {
  const chunks = [];
  let resolve;
  const done = new Promise(resolveFn => {
    resolve = resolveFn;
  });
  const listeners = {};

  const response = {
    statusCode: null,
    headers: {},
    writableEnded: false,
    on: vi.fn((event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    setHeader: vi.fn((key, value) => {
      response.headers[key] = value;
    }),
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      if (headers) Object.assign(response.headers, headers);
    }),
    write: vi.fn((data) => {
      chunks.push(data);
      return true;
    }),
    end: vi.fn((body = '') => {
      if (body) chunks.push(body);
      response.writableEnded = true;
      resolve();
    }),
    emit: vi.fn((event, ...args) => {
      (listeners[event] || []).forEach(cb => cb(...args));
    }),
    getBody: () => chunks.join(''),
  };

  return { response, done };
}

async function dispatchRequest(handler, { method, url, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  req.destroy = vi.fn();

  const { response, done } = createMockResponse();
  const handlerPromise = handler(req, response);

  process.nextTick(() => {
    req.emit('end');
  });

  await handlerPromise;
  if (!response.writableEnded) {
    await new Promise(resolve => setTimeout(resolve, 10));
  } else {
    await done;
  }

  return { response, req };
}

describe('MCP SSE session cap', () => {
  let handleHttpRequest;
  const mockServer = {
    on: vi.fn(),
    close: vi.fn(),
    listen: vi.fn((port, host, cb) => {
      if (cb) cb();
    }),
  };

  beforeAll(async () => {
    toolsModulePath = require.resolve('../tools');
    require.cache[toolsModulePath] = {
      id: toolsModulePath,
      filename: toolsModulePath,
      loaded: true,
      exports: {
        TOOLS: [],
        handleToolCall: vi.fn(),
      },
    };

    mcpSse = require('../mcp-sse');

    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
    vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      handleHttpRequest = handler;
      return mockServer;
    });

    await mcpSse.start({ port: 0 });
  });

  afterAll(() => {
    mcpSse.stop();
    if (toolsModulePath) {
      delete require.cache[toolsModulePath];
      toolsModulePath = undefined;
    }
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mcpSse.sessions.clear();
  });

  it('returns 503 when attempting to open more than the SSE session cap', async () => {
    const openRequests = [];

    for (let i = 0; i < MAX_SSE_SESSIONS; i++) {
      const request = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
        remoteAddress: `10.0.${Math.floor(i / 255)}.${i % 255}`,
      });

      openRequests.push(request.req);
      expect(request.response.statusCode).toBe(200);
    }

    const overflow = await dispatchRequest(handleHttpRequest, {
      method: 'GET',
      url: '/sse',
      headers: { host: 'localhost:3458' },
      remoteAddress: '10.99.99.99',
    });

    expect(overflow.response.statusCode).toBe(503);
    expect(JSON.parse(overflow.response.getBody())).toEqual({
      error: 'Too many active sessions',
      max: MAX_SSE_SESSIONS,
    });

    for (const req of openRequests) {
      req.emit('close');
    }
  });
});
