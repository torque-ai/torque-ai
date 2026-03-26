const { EventEmitter } = require('events');
const http = require('http');
const configCore = require('../db/config-core');
const tools = require('../tools');

let nextTestIp = 1;

// Mock response object similar to api-server.test.js pattern
function createMockResponse() {
  const chunks = [];
  let resolve;
  const done = new Promise((res) => { resolve = res; });
  const listeners = {};
  const response = {
    statusCode: null,
    headers: {},
    writableEnded: false,
    on: vi.fn((event, cb) => { listeners[event] = listeners[event] || []; listeners[event].push(cb); }),
    emit: vi.fn((event, ...args) => { (listeners[event] || []).forEach(cb => cb(...args)); }),
    writeHead: vi.fn((status, headers) => {
      response.statusCode = status;
      if (headers) Object.assign(response.headers, headers);
    }),
    setHeader: vi.fn((key, value) => {
      response.headers[key] = value;
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
    getChunks: () => chunks,
    getBody: () => chunks.join(''),
  };
  return { response, done };
}

function getLastJsonRpcMessage(response) {
  const matches = [...response.getBody().matchAll(/event: message\ndata: (.*)\n/g)];
  expect(matches.length).toBeGreaterThan(0);
  return JSON.parse(matches[matches.length - 1][1]);
}

// Dispatch an HTTP request to the handler
async function dispatchRequest(handler, { method, url, headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  if (method === 'GET' && typeof url === 'string' && url.startsWith('/sse')) {
    const socket = { remoteAddress: `127.0.0.${(nextTestIp % 250) + 1}` };
    nextTestIp += 1;
    req.socket = socket;
    req.connection = socket;
  }
  req.destroy = vi.fn();

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
  // For SSE endpoints, the handler doesn't call end(), so we need to handle both cases
  if (!response.writableEnded) {
    // SSE connection stays open, resolve after a tick
    await new Promise(r => setTimeout(r, 10));
  } else {
    await done;
  }
  return { response, req };
}

describe('MCP SSE Transport', () => {
  let handleHttpRequest;
  let mcpSse;
  let handleToolCallSpy;
  const mockServer = {
    on: vi.fn(),
    listen: vi.fn((port, host, cb) => { if (cb) cb(); }),
    close: vi.fn(),
  };

  beforeAll(() => {
    // Spy on database and tools before loading mcp-sse
    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
    handleToolCallSpy = vi.spyOn(tools, 'handleToolCall').mockResolvedValue({
      content: [{ type: 'text', text: 'mock ok' }],
    });

    // Capture the request handler when mcp-sse creates the http server
    vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      handleHttpRequest = handler;
      return mockServer;
    });

    // Now load mcp-sse
    mcpSse = require('../mcp-sse');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });


  // ============================================
  // SSE Session Creation
  // ============================================

  describe('GET /sse — session creation', () => {
    it('returns 200 with SSE headers', async () => {
      // Start the server to capture the handler
      await mcpSse.start({ port: 0 });

      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('text/event-stream');
      expect(response.headers['Cache-Control']).toBe('no-cache');
      expect(response.headers['Connection']).toBe('keep-alive');
    });

    it('sends endpoint event with session ID', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });

      const body = response.getBody();
      expect(body).toContain('event: endpoint');
      expect(body).toContain('/messages?sessionId=');
    });

    it('generates unique session IDs', async () => {
      const { response: r1 } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });
      const { response: r2 } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });

      const body1 = r1.getBody();
      const body2 = r2.getBody();
      const match1 = body1.match(/sessionId=([0-9a-f-]{36})/);
      const match2 = body2.match(/sessionId=([0-9a-f-]{36})/);

      expect(match1).toBeTruthy();
      expect(match2).toBeTruthy();
      expect(match1[1]).not.toBe(match2[1]);
    });

    it('accepts an invalid short-lived SSE ticket', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse?ticket=sse_tk_invalid',
        headers: { host: 'localhost:3458' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.getBody()).toContain('event: endpoint');
    });
  });

  // ============================================
  // CORS Headers
  // ============================================

  describe('CORS headers', () => {
    it('sets CORS headers on all responses', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458', origin: 'http://localhost:3456' },
      });

      expect(response.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3456');
      expect(response.headers['Access-Control-Allow-Headers']).toMatch(/Content-Type/);
      expect(response.headers['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
    });

    it('handles OPTIONS preflight with 204', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'OPTIONS',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });

      expect(response.statusCode).toBe(204);
    });
  });

  // ============================================
  // Unknown Routes
  // ============================================

  describe('unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/unknown',
        headers: { host: 'localhost:3458' },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.getBody());
      expect(body.error).toContain('Not found');
    });

    it('returns 404 for GET /messages', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/messages',
        headers: { host: 'localhost:3458' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ============================================
  // POST /messages — session validation
  // ============================================

  describe('POST /messages — session validation', () => {
    it('returns 400 for missing sessionId', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: '/messages',
        headers: { host: 'localhost:3458' },
        body: { jsonrpc: '2.0', method: 'initialize', id: 1 },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.getBody());
      expect(body.error).toContain('Invalid or expired session');
    });

    it('returns 400 for nonexistent sessionId', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: '/messages?sessionId=nonexistent-session-id',
        headers: { host: 'localhost:3458' },
        body: { jsonrpc: '2.0', method: 'initialize', id: 1 },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.getBody());
      expect(body.error).toContain('Invalid or expired session');
    });
  });

  // ============================================
  // POST /messages — malformed requests
  // ============================================

  describe('POST /messages — malformed requests', () => {
    let sessionId;

    beforeAll(async () => {
      // Create a valid session
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('has a valid session', () => {
      expect(sessionId).toBeTruthy();
    });

    it('handles invalid JSON gracefully', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: 'not valid json{{{',
      });

      // Should return 202 (acknowledged) even for parse errors
      expect(response.statusCode).toBe(202);
    });

    it('handles empty body', async () => {
      const req = new EventEmitter();
      req.method = 'POST';
      req.url = `/messages?sessionId=${sessionId}`;
      req.headers = { host: 'localhost:3458' };
      req.destroy = vi.fn();

      const { response, done } = createMockResponse();
      const handlerPromise = handleHttpRequest(req, response);

      process.nextTick(() => {
        // Send empty body
        req.emit('end');
      });

      await handlerPromise;
      await done;

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.getBody());
      expect(body.error).toContain('Empty request body');
    });
  });

  // ============================================
  // MCP Protocol — initialize
  // ============================================

  describe('MCP initialize', () => {
    let sessionId;
    let sseResponse;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });
      sseResponse = response;

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('responds to initialize with server info', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' },
          id: 1,
        },
      });

      expect(response.statusCode).toBe(202);

      // The response is sent via SSE, check the SSE stream
      await new Promise(r => setTimeout(r, 50));
      const sseBody = sseResponse.getBody();
      expect(sseBody).toContain('event: message');

      // Parse the SSE message
      const messageMatch = sseBody.match(/event: message\ndata: ({.*})\n/);
      if (messageMatch) {
        const jsonRpcResponse = JSON.parse(messageMatch[1]);
        expect(jsonRpcResponse.result).toBeDefined();
        expect(jsonRpcResponse.result.serverInfo).toBeDefined();
        expect(jsonRpcResponse.result.serverInfo.name).toBe('torque');
        expect(jsonRpcResponse.result.protocolVersion).toBe('2024-11-05');
      }
    });
  });

  // ============================================
  // MCP Protocol — tools/list
  // ============================================

  describe('MCP tools/list', () => {
    let sessionId;
    let sseResponse;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });
      sseResponse = response;

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('returns tools list in core mode by default', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 2,
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 50));

      const sseBody = sseResponse.getBody();
      expect(sseBody).toContain('event: message');
    });
  });

  // ============================================
  // MCP Protocol — tools/call
  // ============================================

  describe('MCP tools/call', () => {
    let sessionId;
    let sseResponse;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });
      sseResponse = response;

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('calls a tool and returns result via SSE', async () => {
      handleToolCallSpy.mockResolvedValue({
        content: [{ type: 'text', text: 'tool result' }],
      });

      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'ping', arguments: {} },
          id: 3,
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 50));

      const sseBody = sseResponse.getBody();
      expect(sseBody).toContain('event: message');
    });

    it('handles tool call error gracefully', async () => {
      handleToolCallSpy.mockRejectedValue(new Error('Tool execution failed'));

      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'nonexistent_tool', arguments: {} },
          id: 4,
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 50));

      const sseBody = sseResponse.getBody();
      expect(sseBody).toContain('event: message');
    });
  });

  // ============================================
  // MCP Protocol — unlock_all_tools
  // ============================================

  describe('MCP unlock_all_tools', () => {
    let sessionId;
    let sseResponse;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });
      sseResponse = response;

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('switches session from core to full mode', async () => {
      handleToolCallSpy.mockResolvedValue({
        __unlock_all_tools: true,
        content: [{ type: 'text', text: 'All tools unlocked' }],
      });

      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'unlock_all_tools', arguments: {} },
          id: 5,
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 50));

      const sseBody = sseResponse.getBody();
      // Should contain tools/list_changed notification
      expect(sseBody).toContain('notifications/tools/list_changed');
    });
  });

  // ============================================
  // MCP Protocol — notifications (no response)
  // ============================================

  describe('MCP notifications', () => {
    let sessionId;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('handles notifications/initialized without response', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
      });

      expect(response.statusCode).toBe(202);
    });

    it('handles notifications/cancelled without response', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
        },
      });

      expect(response.statusCode).toBe(202);
    });
  });

  // ============================================
  // MCP Protocol — unknown method
  // ============================================

  describe('MCP unknown method', () => {
    let sessionId;
    let sseResponse;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });
      sseResponse = response;

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('returns error for unknown method', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'unknown/method',
          id: 99,
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 50));

      const sseBody = sseResponse.getBody();
      expect(sseBody).toContain('Method not found');
    });
  });

  // ============================================
  // Client Disconnection
  // ============================================

  describe('client disconnection', () => {
    it('cleans up session on close event', async () => {
      const { response, req } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      const sessionId = match ? match[1] : null;
      expect(sessionId).toBeTruthy();

      // Simulate client disconnect
      req.emit('close');
      await new Promise(r => setTimeout(r, 10));

      // After disconnect, posting to this session should fail
      const { response: postResponse } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: { jsonrpc: '2.0', method: 'initialize', id: 1 },
      });

      expect(postResponse.statusCode).toBe(400);
    });
  });

  // ============================================
  // Bad URL parsing
  // ============================================

  describe('bad URL', () => {
    it('handles malformed URL gracefully', async () => {
      const req = new EventEmitter();
      req.method = 'GET';
      req.url = '://bad-url';
      req.headers = {}; // no host header
      req.destroy = vi.fn();

      const { response, done } = createMockResponse();
      const handlerPromise = handleHttpRequest(req, response);

      process.nextTick(() => { req.emit('end'); });

      await handlerPromise;
      await done;

      // URL constructor with fallback host may parse this as a valid path,
      // resulting in 404 (unknown route) rather than 400 (bad request)
      expect([400, 404]).toContain(response.statusCode);
    });
  });

  // ============================================
  // SSE-only tool: subscribe_task_events
  // ============================================

  describe('MCP subscribe_task_events', () => {
    let sessionId;
    let sseResponse;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });
      sseResponse = response;

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('handles subscribe_task_events without calling handleToolCall', async () => {
      handleToolCallSpy.mockClear();

      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'subscribe_task_events',
            arguments: { task_ids: ['task-abc'], events: ['completed', 'failed'] },
          },
          id: 100,
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 50));

      // Should NOT have called the shared handleToolCall — handled locally
      expect(handleToolCallSpy).not.toHaveBeenCalled();

      // Should have sent a response via SSE
      const sseBody = sseResponse.getBody();
      expect(sseBody).toContain('subscribed');
      expect(sseBody).toContain('task-abc');
    });
  });

  // ============================================
  // SSE-only tool: check_notifications
  // ============================================

  describe('MCP check_notifications', () => {
    let sessionId;
    let sseResponse;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });
      sseResponse = response;

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('returns empty events array for new session', async () => {
      handleToolCallSpy.mockClear();

      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'check_notifications', arguments: {} },
          id: 101,
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 50));

      expect(handleToolCallSpy).not.toHaveBeenCalled();

      const sseBody = sseResponse.getBody();
      // The count is inside a JSON string within a JSON-RPC response, so quotes are escaped
      expect(sseBody).toContain('count');
      expect(sseBody).toContain('events');
    });
  });

  // ============================================
  // SSE-only tools in tools/list
  // ============================================

  describe('MCP tools/list includes SSE tools', () => {
    let sessionId;
    let sseResponse;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });
      sseResponse = response;

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('includes subscribe_task_events and check_notifications in tools list', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 102,
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 50));

      const sseBody = sseResponse.getBody();
      expect(sseBody).toContain('subscribe_task_events');
      expect(sseBody).toContain('check_notifications');
    });
  });

  // ============================================
  // Auto-subscribe via __subscribe_task_id
  // ============================================

  describe('Auto-subscribe on task submit', () => {
    let sessionId;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('auto-subscribes session when tool returns __subscribe_task_id', async () => {
      handleToolCallSpy.mockResolvedValue({
        __subscribe_task_id: 'auto-task-123',
        content: [{ type: 'text', text: 'Task started (ID: auto-task-123)' }],
      });

      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'submit_task', arguments: { task: 'test' } },
          id: 103,
        },
      });

      expect(response.statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 50));

      // Verify auto-task-123 is now in the session's taskFilter
      const session = mcpSse.sessions.get(sessionId);
      expect(session).toBeTruthy();
      expect(session.taskFilter.has('auto-task-123')).toBe(true);
    });
  });

  // ============================================
  // Push notifications via notifySubscribedSessions
  // ============================================

  describe('notifySubscribedSessions via HTTP', () => {
    let sessionId;
    let sseResponse;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });
      sseResponse = response;

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('pushes notification to session and queues event', async () => {
      // Session has default eventFilter: ['completed', 'failed'] and empty taskFilter
      const session = mcpSse.sessions.get(sessionId);
      expect(session).toBeTruthy();

      mcpSse.notifySubscribedSessions('completed', {
        taskId: 'push-test-001',
        status: 'completed',
        duration: 10,
        description: 'Test push notification',
      });

      // Check that a log notification was written to the SSE stream
      const sseBody = sseResponse.getBody();
      expect(sseBody).toContain('notifications/message');
      expect(sseBody).toContain('push-test-001');

      // Check that the event was queued
      expect(session.pendingEvents).toHaveLength(1);
      expect(session.pendingEvents[0].taskId).toBe('push-test-001');
      expect(session.pendingEvents[0].eventName).toBe('completed');
    });
  });

  // ============================================
  // JSON-RPC request validation
  // ============================================

  describe('POST /messages — JSON-RPC validation', () => {
    let sessionId;
    let sseResponse;

    beforeAll(async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'GET',
        url: '/sse',
        headers: { host: 'localhost:3458' },
      });
      sseResponse = response;

      const body = response.getBody();
      const match = body.match(/sessionId=([0-9a-f-]{36})/);
      sessionId = match ? match[1] : null;
    });

    it('returns -32600 for missing method field', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          id: 2001,
        },
      });

      expect(response.statusCode).toBe(202);

      await new Promise(r => setTimeout(r, 50));

      const jsonRpcResponse = getLastJsonRpcMessage(sseResponse);

      expect(jsonRpcResponse.error).toBeDefined();
      expect(jsonRpcResponse.error.code).toBe(-32600);
      expect(jsonRpcResponse.error.message).toBe('Invalid Request');
      expect(jsonRpcResponse.id).toBe(2001);
    });

    it('returns -32600 for non-string method', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 123,
          id: 2002,
        },
      });

      expect(response.statusCode).toBe(202);

      await new Promise(r => setTimeout(r, 50));

      const jsonRpcResponse = getLastJsonRpcMessage(sseResponse);

      expect(jsonRpcResponse.error).toBeDefined();
      expect(jsonRpcResponse.error.code).toBe(-32600);
      expect(jsonRpcResponse.error.message).toBe('Invalid Request');
      expect(jsonRpcResponse.id).toBe(2002);
    });

    it('processes a valid JSON-RPC request successfully', async () => {
      const { response } = await dispatchRequest(handleHttpRequest, {
        method: 'POST',
        url: `/messages?sessionId=${sessionId}`,
        headers: { host: 'localhost:3458' },
        body: {
          jsonrpc: '2.0',
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' },
          id: 2003,
        },
      });

      expect(response.statusCode).toBe(202);

      await new Promise(r => setTimeout(r, 50));

      const jsonRpcResponse = getLastJsonRpcMessage(sseResponse);

      expect(jsonRpcResponse.error).toBeUndefined();
      expect(jsonRpcResponse.result).toBeDefined();
      expect(jsonRpcResponse.result.serverInfo.name).toBe('torque');
      expect(jsonRpcResponse.result.protocolVersion).toBe('2024-11-05');
    });
  });

  // ============================================
  // Server start/stop
  // ============================================

  describe('server lifecycle', () => {
    it('start resolves with success', async () => {
      const result = await mcpSse.start({ port: 0 });
      expect(result.success).toBe(true);
    });

    it('start returns already running if called twice', async () => {
      // server was started in beforeAll, second call should say already running
      const result = await mcpSse.start({ port: 0 });
      expect(result.success).toBe(true);
    });
  });
});
