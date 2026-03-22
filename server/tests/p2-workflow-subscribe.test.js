const { EventEmitter } = require('events');
const http = require('http');
const db = require('../database');
const tools = require('../tools');
const authMiddleware = require('../auth/middleware');

// Mock response object for in-process HTTP dispatch.
function createMockResponse() {
  const chunks = [];
  let resolve;
  const done = new Promise((res) => { resolve = res; });
  const listeners = {};

  const response = {
    statusCode: null,
    headers: {},
    writableEnded: false,
    on: vi.fn((event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    emit: vi.fn((event, ...args) => {
      (listeners[event] || []).forEach(cb => cb(...args));
    }),
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

// Dispatch an HTTP request to the handler.
async function dispatchRequest(handler, { method, url, headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
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
  // SSE requests stay open; non-SSE requests close via response.end().
  if (!response.writableEnded) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  } else {
    await done;
  }

  return { response, req };
}

function getLastJsonRpcResponse(body) {
  const matches = [...body.matchAll(/data: (.*)\n/g)];
  return matches.length > 0 ? JSON.parse(matches[matches.length - 1][1]) : null;
}

describe('MCP SSE workflow auto-subscribe', () => {
  let handleHttpRequest;
  let mcpSse;
  let handleToolCallSpy;
  let getWorkflowTasksSpy;

  beforeAll(async () => {
    vi.spyOn(db, 'getConfig').mockReturnValue(null);
    // Auth now uses key-manager (not config). Mock isOpenMode to allow unauthenticated access.
    vi.spyOn(authMiddleware, 'isOpenMode').mockReturnValue(true);

    handleToolCallSpy = vi.spyOn(tools, 'handleToolCall');
    getWorkflowTasksSpy = vi.spyOn(db, 'getWorkflowTasks');

    const mockServer = {
      on: vi.fn(),
      listen: vi.fn((port, host, cb) => { if (cb) cb(); }),
      close: vi.fn(),
    };

    vi.spyOn(http, 'createServer').mockImplementation((handler) => {
      handleHttpRequest = handler;
      return mockServer;
    });

    mcpSse = require('../mcp-sse');
    await mcpSse.start({ port: 0 });
  });

  afterAll(() => {
    mcpSse.stop();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    handleToolCallSpy.mockReset().mockResolvedValue({
      content: [{ type: 'text', text: 'mock task started' }],
    });
    getWorkflowTasksSpy.mockReset().mockReturnValue([]);
  });

  it('subscribes session to all workflow tasks when tool returns __subscribe_workflow_id', async () => {
    handleToolCallSpy.mockResolvedValue({
      __subscribe_workflow_id: 'workflow-123',
      content: [{ type: 'text', text: 'Workflow submitted' }],
    });

    getWorkflowTasksSpy.mockReturnValue([
      { id: 'workflow-task-1' },
      { id: 'workflow-task-2' },
    ]);

    const { response: sseResponse } = await dispatchRequest(handleHttpRequest, {
      method: 'GET',
      url: '/sse',
      headers: { host: 'localhost:3458' },
    });

    const body = sseResponse.getBody();
    const match = body.match(/sessionId=([0-9a-f-]{36})/);
    const sessionId = match ? match[1] : null;
    expect(sessionId).toBeTruthy();

    const { response } = await dispatchRequest(handleHttpRequest, {
      method: 'POST',
      url: `/messages?sessionId=${sessionId}`,
      headers: { host: 'localhost:3458' },
      body: {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'submit_task',
          arguments: { task: 'mock task' },
        },
        id: 104,
      },
    });

    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const session = mcpSse.sessions.get(sessionId);
    expect(session).toBeTruthy();
    expect(session.taskFilter.has('workflow-task-1')).toBe(true);
    expect(session.taskFilter.has('workflow-task-2')).toBe(true);
    expect(session.taskFilter.has('workflow-task-3')).toBe(false);
    expect(getWorkflowTasksSpy).toHaveBeenCalledWith('workflow-123');
  });

  it('returns actionable subscription metadata and skips workflow lookup when task ids are explicit', async () => {
    handleToolCallSpy.mockResolvedValue({
      __subscribe_workflow_id: 'workflow-abc',
      workflow_id: 'workflow-abc',
      task_ids: ['workflow-task-a', 'workflow-task-b'],
      subscription_target: {
        kind: 'workflow',
        workflow_id: 'workflow-abc',
        task_ids: ['workflow-task-a', 'workflow-task-b'],
        subscribe_tool: 'subscribe_task_events',
        subscribe_args: { task_ids: ['workflow-task-a', 'workflow-task-b'] },
      },
      content: [{ type: 'text', text: 'Workflow submitted' }],
    });

    const { response: sseResponse } = await dispatchRequest(handleHttpRequest, {
      method: 'GET',
      url: '/sse',
      headers: { host: 'localhost:3458' },
    });

    const body = sseResponse.getBody();
    const match = body.match(/sessionId=([0-9a-f-]{36})/);
    const sessionId = match ? match[1] : null;
    expect(sessionId).toBeTruthy();

    const { response } = await dispatchRequest(handleHttpRequest, {
      method: 'POST',
      url: `/messages?sessionId=${sessionId}`,
      headers: { host: 'localhost:3458' },
      body: {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'submit_task',
          arguments: { task: 'mock task' },
        },
        id: 105,
      },
    });

    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const session = mcpSse.sessions.get(sessionId);
    expect(session).toBeTruthy();
    expect(session.taskFilter.has('workflow-task-a')).toBe(true);
    expect(session.taskFilter.has('workflow-task-b')).toBe(true);
    expect(getWorkflowTasksSpy).not.toHaveBeenCalled();

    const jsonRpcResponse = getLastJsonRpcResponse(sseResponse.getBody());
    expect(jsonRpcResponse.result.subscription_target).toEqual({
      kind: 'workflow',
      workflow_id: 'workflow-abc',
      task_id: null,
      task_ids: ['workflow-task-a', 'workflow-task-b'],
      subscribe_tool: 'subscribe_task_events',
      subscribe_args: { task_ids: ['workflow-task-a', 'workflow-task-b'] },
    });
    expect(jsonRpcResponse.result.task_ids).toEqual(['workflow-task-a', 'workflow-task-b']);
  });
});
