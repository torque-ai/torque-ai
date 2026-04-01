const { EventEmitter } = require('events');
const http = require('http');
const configCore = require('../db/config-core');
const tools = require('../tools');

let nextTestIp = 1;

function createMockResponse() {
  const chunks = [];
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const listeners = {};

  const response = {
    statusCode: null,
    headers: {},
    writableEnded: false,
    on: vi.fn((event, callback) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(callback);
    }),
    emit: vi.fn((event, ...args) => {
      (listeners[event] || []).forEach((callback) => callback(...args));
    }),
    writeHead: vi.fn((statusCode, headers) => {
      response.statusCode = statusCode;
      if (headers) Object.assign(response.headers, headers);
    }),
    setHeader: vi.fn((key, value) => {
      response.headers[key] = value;
    }),
    write: vi.fn((chunk) => {
      chunks.push(chunk);
      return true;
    }),
    end: vi.fn((body = '') => {
      if (body) chunks.push(body);
      response.writableEnded = true;
      response.emit('finish');
      resolveDone();
    }),
    getBody: () => chunks.join(''),
    getJson: () => JSON.parse(chunks.join('')),
  };

  return { response, done };
}

async function dispatchRequest(handler, { method, url, headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = vi.fn();

  const socket = { remoteAddress: `127.0.0.${(nextTestIp % 250) + 1}` };
  nextTestIp += 1;
  req.socket = socket;
  req.connection = socket;

  const { response, done } = createMockResponse();
  const handlerPromise = handler(req, response);

  process.nextTick(() => {
    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', Buffer.from(payload, 'utf8'));
    }
    req.emit('end');
  });

  await handlerPromise;
  if (!response.writableEnded) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  } else {
    await done;
  }
  return { response, req };
}

function getSessionId(response) {
  return response.headers['Mcp-Session-Id'] || response.headers['mcp-session-id'];
}

function getSseMessages(response) {
  return [...response.getBody().matchAll(/event: message\ndata: (.*)\n/g)].map((match) => JSON.parse(match[1]));
}

describe('MCP streamable HTTP transport', () => {
  let handleHttpRequest;
  let mcpSse;
  let handleToolCallSpy;
  const mockServer = {
    on: vi.fn(),
    listen: vi.fn((port, host, callback) => {
      if (callback) callback();
    }),
    close: vi.fn(),
  };

  beforeAll(async () => {
    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
    handleToolCallSpy = vi.spyOn(tools, 'handleToolCall').mockResolvedValue({
      content: [{ type: 'text', text: 'mock ok' }],
    });

    vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      handleHttpRequest = handler;
      return mockServer;
    });

    mcpSse = require('../mcp-sse');
    await mcpSse.start({ port: 0 });
  });

  afterAll(() => {
    try { mcpSse.stop(); } catch {}
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    handleToolCallSpy.mockReset();
    handleToolCallSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'mock ok' }],
    });
  });

  it('POST /mcp initialize returns JSON and a session header', async () => {
    const { response } = await dispatchRequest(handleHttpRequest, {
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'localhost:3458',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { capabilities: {} },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toContain('application/json');
    expect(response.headers['MCP-Protocol-Version']).toBe('2025-06-18');
    expect(getSessionId(response)).toMatch(/[0-9a-f-]{36}/i);
    expect(response.getJson().result.protocolVersion).toBe('2025-06-18');
  });

  it('POST /mcp tools/list works after initialize when Mcp-Session-Id is provided', async () => {
    const initResponse = await dispatchRequest(handleHttpRequest, {
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'localhost:3458',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { capabilities: {} },
      },
    });
    const sessionId = getSessionId(initResponse.response);

    const { response } = await dispatchRequest(handleHttpRequest, {
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'localhost:3458',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-06-18',
      },
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toContain('application/json');
    expect(response.getJson().result.tools.map((tool) => tool.name)).toContain('ping');
  });

  it('POST /mcp rejects non-initialize requests without Mcp-Session-Id', async () => {
    const { response } = await dispatchRequest(handleHttpRequest, {
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'localhost:3458',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.getJson().error).toContain('Missing Mcp-Session-Id');
  });

  it('GET /mcp opens an SSE stream for an existing session', async () => {
    const initResponse = await dispatchRequest(handleHttpRequest, {
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'localhost:3458',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { capabilities: {} },
      },
    });
    const sessionId = getSessionId(initResponse.response);

    const { response } = await dispatchRequest(handleHttpRequest, {
      method: 'GET',
      url: '/mcp',
      headers: {
        host: 'localhost:3458',
        accept: 'text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-06-18',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('text/event-stream');
    expect(response.headers['Mcp-Session-Id']).toBe(sessionId);
  });

  it('POST /mcp can stream tools/list_changed before the final response', async () => {
    handleToolCallSpy.mockImplementationOnce(async (name) => {
      if (name === 'unlock_all_tools') {
        return {
          __unlock_all_tools: true,
          content: [{ type: 'text', text: 'All tools unlocked' }],
        };
      }
      return { content: [{ type: 'text', text: 'mock ok' }] };
    });

    const initResponse = await dispatchRequest(handleHttpRequest, {
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'localhost:3458',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { capabilities: {} },
      },
    });
    const sessionId = getSessionId(initResponse.response);

    const { response } = await dispatchRequest(handleHttpRequest, {
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'localhost:3458',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-06-18',
      },
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'unlock_all_tools',
          arguments: {},
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('text/event-stream');

    const messages = getSseMessages(response);
    expect(messages[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });
    expect(messages[1]).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: {
        content: [{ type: 'text', text: 'All tools unlocked' }],
      },
    });
  });
});
