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
    writtenChunks,
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

async function dispatchRequest(handler, { method, url, headers = {}, body, remoteAddress } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();
  req.socket = { remoteAddress: remoteAddress || '127.0.0.1' };
  req.connection = { remoteAddress: remoteAddress || '127.0.0.1' };

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

describe('REST passthrough schema coercion', () => {
  let apiServer;
  let requestHandler;
  let handleToolCallSpy;
  let getConfigSpy;
  let countTasksSpy;
  let getDbInstanceSpy;

  const mockServer = {
    on: vi.fn(),
    listen: vi.fn((port, host, cb) => {
      if (typeof host === 'function') {
        host();
        return;
      }
      if (cb) cb();
    }),
    close: vi.fn(),
  };

  beforeAll(async () => {
    vi.resetModules();

    const tools = require('../tools');
    const configCore = require('../db/config-core');
    const taskCore = require('../db/task-core');
    const db = require('../database');

    getConfigSpy = vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
      if (key === 'v2_auth_mode') return 'permissive';
      return null;
    });
    countTasksSpy = vi.spyOn(taskCore, 'countTasks').mockReturnValue(0);
    getDbInstanceSpy = vi.spyOn(db, 'getDbInstance').mockReturnValue({});
    handleToolCallSpy = vi.spyOn(tools, 'handleToolCall').mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });

    vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      requestHandler = handler;
      return mockServer;
    });

    apiServer = require('../api-server');
    await apiServer.start({ port: 4001 });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getConfigSpy.mockImplementation((key) => {
      if (key === 'v2_auth_mode') return 'permissive';
      return null;
    });
    countTasksSpy.mockReturnValue(0);
    getDbInstanceSpy.mockReturnValue({});
    handleToolCallSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  afterAll(() => {
    if (apiServer && typeof apiServer.stop === 'function') {
      apiServer.stop();
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('coerces integer path params for PUT /api/v2/factory/intake/:id', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'PUT',
      url: '/api/v2/factory/intake/42',
      body: { status: 'triaged' },
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('update_work_item', {
      id: 42,
      status: 'triaged',
    });
    expect(response.statusCode).toBe(200);
  });

  it('returns 400 for invalid integer path params and skips the tool call', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'PUT',
      url: '/api/v2/factory/intake/abc',
      body: { status: 'triaged' },
    });

    expect(handleToolCallSpy).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain('integer');
    expect(JSON.parse(response.body).error).toContain('id');
  });

  it('coerces boolean query params for routes with mapQuery enabled', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/ollama/hosts?enabled_only=true',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('list_ollama_hosts', { enabled_only: true });
    expect(response.statusCode).toBe(200);
  });

  it('keeps string path params unchanged for string-typed schema properties', async () => {
    const response = await dispatchRequest(requestHandler, {
      method: 'GET',
      url: '/api/v2/factory/projects/project-uuid/intake',
    });

    expect(handleToolCallSpy).toHaveBeenCalledWith('list_work_items', { project: 'project-uuid' });
    expect(response.statusCode).toBe(200);
  });
});
