'use strict';

const { EventEmitter } = require('events');
const http = require('http');

function createMockResponse() {
  let resolve;
  const done = new Promise((res) => { resolve = res; });
  const responseHeaders = {};
  const listeners = {};
  const writtenChunks = [];

  const response = {
    statusCode: null,
    headers: null,
    body: '',
    on: vi.fn((event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    emit: vi.fn((event, ...args) => {
      (listeners[event] || []).forEach((cb) => cb(...args));
    }),
    setHeader: vi.fn((name, value) => {
      responseHeaders[name.toLowerCase()] = value;
    }),
    getHeader: vi.fn((name) => responseHeaders[name.toLowerCase()]),
    write: vi.fn((chunk) => {
      writtenChunks.push(typeof chunk === 'string' ? chunk : String(chunk || ''));
      response.body = writtenChunks.join('');
    }),
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      if (body) {
        writtenChunks.push(typeof body === 'string' ? body : String(body));
      }
      response.body = writtenChunks.join('');
      resolve();
    }),
  };

  return { response, done };
}

async function dispatchRequest(handler, { method, url, headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();
  req.socket = { remoteAddress: '127.0.0.1' };
  req.connection = { remoteAddress: '127.0.0.1' };

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

function parseJson(response) {
  return JSON.parse(response.body);
}

describe('REST passthrough route dispatch', () => {
  let apiServer;
  let requestHandler;
  let handleToolCallSpy;

  const mockServer = {
    on: vi.fn(),
    listen: vi.fn((port, host, cb) => {
      if (cb) cb();
      return mockServer;
    }),
    close: vi.fn(),
  };

  beforeAll(async () => {
    vi.resetModules();

    const serverConfig = require('../config');
    const tools = require('../tools');
    const originalGet = serverConfig.get.bind(serverConfig);

    vi.spyOn(serverConfig, 'get').mockImplementation((key, fallback) => {
      if (key === 'api_key') return null;
      if (key === 'v2_auth_mode') return 'permissive';
      return originalGet(key, fallback);
    });

    handleToolCallSpy = vi.spyOn(tools, 'handleToolCall').mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      requestHandler = handler;
      return mockServer;
    });

    apiServer = require('../api-server');
    await apiServer.start({ port: 4101 });
  });

  afterAll(() => {
    apiServer?.stop();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    handleToolCallSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  it('passes POST request bodies to tool-passthrough routes and returns a 200 response', async () => {
    handleToolCallSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'pong' }],
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/system/ping',
      body: { message: 'hello', count: 2 },
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('ping', { message: 'hello', count: 2 });
    expect(response.statusCode).toBe(200);
    expect(parseJson(response)).toEqual({
      tool: 'ping',
      result: 'pong',
    });
  });

  it('passes GET query params to tool-passthrough routes', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/advanced/get-artifact?artifact_id=artifact-42&format=full',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('get_artifact', {
      artifact_id: 'artifact-42',
      format: 'full',
    });
    expect(response.statusCode).toBe(200);
  });

  it('passes DELETE query params to tool-passthrough routes', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'DELETE',
      url: '/api/v2/advanced/invalidate-cache?scope=global&force=true',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('invalidate_cache', {
      scope: 'global',
      force: 'true',
    });
    expect(response.statusCode).toBe(200);
  });

  it('extracts regex path params and merges them into tool args', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/advanced/get-resource-usage/task-123?window=1h',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('get_resource_usage', {
      window: '1h',
      task_id: 'task-123',
    });
    expect(response.statusCode).toBe(200);
  });

  it('maps tool isError results to a 400 REST response', async () => {
    handleToolCallSpy.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'Tool rejected the request' }],
    });

    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/advanced/get-artifact?artifact_id=artifact-404',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('get_artifact', {
      artifact_id: 'artifact-404',
    });
    expect(response.statusCode).toBe(400);
    expect(parseJson(response)).toEqual({
      error: 'Tool rejected the request',
    });
  });

  it('maps thrown tool errors to a 500 REST response', async () => {
    handleToolCallSpy.mockRejectedValue(new Error('Tool exploded'));

    const response = await dispatchRequest(requestHandler, {
      method: 'POST',
      url: '/api/v2/system/ping',
      body: { message: 'boom' },
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('ping', { message: 'boom' });
    expect(response.statusCode).toBe(500);

    const payload = parseJson(response);
    expect(payload.error.message).toBe('Tool exploded');
    expect(payload.error.code).toEqual(expect.any(String));
    expect(payload.error.request_id).toEqual(expect.any(String));
    expect(payload.meta).toEqual(expect.objectContaining({
      request_id: payload.error.request_id,
    }));
  });
});
