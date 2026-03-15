'use strict';

const { EventEmitter } = require('events');
const http = require('http');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let currentMocks = null;
let activeGateway = null;

function primeModuleCache(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

function buildToolCatalog() {
  return [
    { name: 'torque.task.submit', mutation: true },
    { name: 'torque.task.get', mutation: false },
    { name: 'torque.provider.enable', mutation: true },
    { name: 'torque.policy.get', mutation: false },
    { name: 'torque.session.open', mutation: false },
    { name: 'torque.session.close', mutation: false },
    { name: 'torque.stream.subscribe', mutation: false },
    { name: 'torque.stream.unsubscribe', mutation: false },
    { name: 'torque.stream.poll', mutation: false },
    { name: 'torque.unsupported.test', mutation: false },
  ].map((tool) => ({ ...tool }));
}

function createMockServer({ autoListen = true } = {}) {
  const listeners = new Map();
  const server = {
    listenArgs: null,
    on: vi.fn((event, callback) => {
      listeners.set(event, callback);
      return server;
    }),
    listen: vi.fn((port, host, callback) => {
      server.listenArgs = { port, host };
      if (autoListen && callback) {
        callback();
      }
      return server;
    }),
    close: vi.fn((callback) => {
      if (callback) {
        callback();
      }
    }),
    emit(event, ...args) {
      const callback = listeners.get(event);
      if (callback) {
        callback(...args);
      }
    },
  };
  return server;
}

function createGatewayMocks() {
  const state = {
    handler: null,
    server: createMockServer(),
    loggerChild: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };

  state.http = {
    createServer: vi.fn((handler) => {
      state.handler = handler;
      return state.server;
    }),
  };
  state.httpSpy = vi.spyOn(http, 'createServer').mockImplementation((handler) => (
    state.http.createServer(handler)
  ));
  state.tools = {
    handleToolCall: vi.fn(async (tool, args) => ({
      content: [{ type: 'text', text: JSON.stringify({ tool, args }) }],
    })),
  };
  state.catalog = {
    listTools: vi.fn(() => buildToolCatalog()),
  };
  state.database = {
    getConfig: vi.fn(() => null),
    setConfig: vi.fn(),
    recordAuditLog: vi.fn(),
    getAuditLog: vi.fn(() => []),
    getAuditStats: vi.fn(() => ({ total: 0 })),
    createEventSubscription: vi.fn(() => 'sub-1'),
    pollSubscription: vi.fn(() => ({ events: [], expired: false })),
    deleteEventSubscription: vi.fn(() => true),
    pollSubscriptionAfterCursor: vi.fn(() => ({ events: [], expired: false })),
    cleanupEventData: vi.fn(),
  };
  state.telemetry = {
    incrementToolCall: vi.fn(),
    incrementError: vi.fn(),
    observeLatency: vi.fn(),
    snapshot: vi.fn(() => ({
      generated_at: '2026-03-09T18:00:00.000Z',
      counters: {
        tool_calls: {},
        errors: {},
      },
      latency: {},
    })),
  };
  state.schemaRegistry = {
    loadSchemas: vi.fn(() => 2),
    validate: vi.fn(() => ({ valid: true, errors: [] })),
    getLoadedSchemaIds: vi.fn(() => [
      'torque.task.submit.request.schema',
      'torque.task.submit.response.schema',
    ]),
  };
  state.logger = {
    child: vi.fn(() => state.loggerChild),
  };

  currentMocks = {
    http: state.http,
    tools: state.tools,
    catalog: state.catalog,
    database: state.database,
    telemetry: state.telemetry,
    schemaRegistry: state.schemaRegistry,
    logger: state.logger,
  };

  primeModuleCache('../tools', currentMocks.tools);
  primeModuleCache('../mcp/catalog-v1', currentMocks.catalog);
  primeModuleCache('../database', currentMocks.database);
  primeModuleCache('../mcp/telemetry', currentMocks.telemetry);
  primeModuleCache('../mcp/schema-registry', currentMocks.schemaRegistry);
  primeModuleCache('../logger', currentMocks.logger);

  return state;
}

function loadGateway(configure) {
  vi.resetModules();
  const mocks = createGatewayMocks();
  if (configure) {
    configure(mocks);
  }
  delete require.cache[require.resolve('../mcp/index.js')];
  const gateway = require('../mcp/index.js');
  activeGateway = gateway;
  return { gateway, mocks };
}

async function bootGateway(configure, options = { port: 4567 }) {
  const { gateway, mocks } = loadGateway(configure);
  const result = await gateway.start(options);
  return {
    gateway,
    mocks,
    result,
    handler: mocks.handler,
  };
}

function createMockResponse() {
  const chunks = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const response = {
    statusCode: null,
    headers: {},
    writableEnded: false,
    writeHead: vi.fn((statusCode, headers) => {
      response.statusCode = statusCode;
      if (headers) {
        Object.assign(response.headers, headers);
      }
    }),
    setHeader: vi.fn((key, value) => {
      response.headers[key] = value;
    }),
    write: vi.fn((chunk) => {
      chunks.push(chunk);
      return true;
    }),
    end: vi.fn((chunk = '') => {
      if (chunk) {
        chunks.push(chunk);
      }
      response.writableEnded = true;
      resolveDone();
    }),
    getBody() {
      return chunks.join('');
    },
    getJson() {
      return JSON.parse(response.getBody());
    },
    done,
  };
  return response;
}

async function dispatchRequest(handler, {
  method = 'POST',
  url = '/tools/call',
  headers = {},
  body,
  chunks,
} = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost:3459',
    ...headers,
  };
  req.destroy = vi.fn();

  const response = createMockResponse();
  const requestPromise = handler(req, response);

  process.nextTick(() => {
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        req.emit('data', chunk);
      }
    } else if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', payload);
    }
    req.emit('end');
  });

  await requestPromise;
  await response.done;
  return { req, response };
}

describe('mcp gateway http transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T18:00:00.000Z'));
    activeGateway = null;
    currentMocks = null;
  });

  afterEach(() => {
    try {
      activeGateway?.stop?.();
    } catch {
      // Ignore cleanup failures in test teardown.
    }
    activeGateway = null;
    currentMocks = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('exports start, stop, and telemetry', () => {
    const { gateway, mocks } = loadGateway();

    expect(typeof gateway.start).toBe('function');
    expect(typeof gateway.stop).toBe('function');
    expect(gateway.telemetry).toBe(mocks.telemetry);
  });

  it('starts the server, loads schemas, schedules cleanup intervals, and runs startup cleanup', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const beforeCalls = setIntervalSpy.mock.calls.length;
    const { mocks, result, handler } = await bootGateway();

    expect(result).toEqual({ success: true, port: 4567 });
    expect(handler).toEqual(expect.any(Function));
    expect(mocks.http.createServer).toHaveBeenCalledTimes(1);
    expect(mocks.server.listen).toHaveBeenCalledWith(4567, '127.0.0.1', expect.any(Function));
    expect(mocks.schemaRegistry.loadSchemas).toHaveBeenCalledTimes(1);
    expect(mocks.database.cleanupEventData).toHaveBeenCalledTimes(1);
    expect(mocks.database.cleanupEventData).toHaveBeenCalledWith(7);

    const newIntervalCalls = setIntervalSpy.mock.calls.slice(beforeCalls);
    expect(newIntervalCalls).toHaveLength(4);
    expect(newIntervalCalls.map(([, ms]) => ms)).toEqual([
      60 * 1000,
      5 * 60 * 1000,
      60 * 60 * 1000,
      60 * 1000,
    ]);
  });

  it('returns Already running when started twice', async () => {
    const { gateway, mocks } = await bootGateway();

    const secondStart = await gateway.start({ port: 9001 });

    expect(secondStart).toEqual({
      success: true,
      port: 4567,
      message: 'Already running',
    });
    expect(mocks.http.createServer).toHaveBeenCalledTimes(1);
  });

  it('clears cleanup intervals and closes the server on stop', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const { gateway, mocks } = await bootGateway();

    gateway.stop();
    const cleanupCalls = mocks.database.cleanupEventData.mock.calls.length;

    expect(mocks.server.close).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(mocks.database.cleanupEventData).toHaveBeenCalledTimes(cleanupCalls);
  });

  it('treats stop as a no-op when the gateway is not running', () => {
    const { gateway } = loadGateway();

    expect(() => gateway.stop()).not.toThrow();
  });

  it('returns a port-in-use error when the server emits EADDRINUSE', async () => {
    const { gateway, mocks } = loadGateway((state) => {
      state.server = createMockServer({ autoListen: false });
      state.http.createServer.mockImplementation((handler) => {
        state.handler = handler;
        return state.server;
      });
    });

    const startPromise = gateway.start({ port: 4999 });
    mocks.server.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' }));

    await expect(startPromise).resolves.toEqual({
      success: false,
      error: 'Port in use',
      port: 4999,
    });
  });

  it('returns a startup error for non-EADDRINUSE server failures', async () => {
    const { gateway, mocks } = loadGateway((state) => {
      state.server = createMockServer({ autoListen: false });
      state.http.createServer.mockImplementation((handler) => {
        state.handler = handler;
        return state.server;
      });
    });

    const startPromise = gateway.start({ port: 5001 });
    mocks.server.emit('error', new Error('listen failed'));

    await expect(startPromise).resolves.toEqual({
      success: false,
      error: 'listen failed',
      port: 5001,
    });
  });

  it('continues serving when event-data cleanup throws on the scheduled interval', async () => {
    const { handler, mocks } = await bootGateway((state) => {
      state.database.cleanupEventData
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error('cleanup failed');
        });
    });

    expect(() => vi.advanceTimersByTime(60 * 60 * 1000)).not.toThrow();
    expect(mocks.database.cleanupEventData).toHaveBeenCalledTimes(2);

    const { response } = await dispatchRequest(handler, {
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
  });

  it('turns unexpected route failures into INTERNAL_GATEWAY_ERROR responses', async () => {
    const { handler, mocks } = await bootGateway((state) => {
      state.schemaRegistry.getLoadedSchemaIds.mockImplementation(() => {
        throw new Error('boom');
      });
    });

    const { response } = await dispatchRequest(handler, {
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(500);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'INTERNAL_GATEWAY_ERROR',
      },
    });
    expect(mocks.loggerChild.error).toHaveBeenCalledTimes(1);
  });

  it('returns health metadata and telemetry snapshots', async () => {
    const { handler, mocks } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'corr-123' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['X-Correlation-ID']).toBe('corr-123');
    expect(response.getJson()).toEqual({
      ok: true,
      data: {
        status: 'ok',
        transport: 'loopback-http',
        version: 'v1',
        loaded_schemas: [
          'torque.task.submit.request.schema',
          'torque.task.submit.response.schema',
        ],
        telemetry: {
          generated_at: '2026-03-09T18:00:00.000Z',
          counters: {
            tool_calls: {},
            errors: {},
          },
          latency: {},
        },
      },
      metadata: {
        schema_version: 'v1',
        tool_version: 'v1',
        timestamp: '2026-03-09T18:00:00.000Z',
        correlation_id: 'corr-123',
      },
    });
    expect(mocks.telemetry.snapshot).toHaveBeenCalledTimes(1);
  });

  it('lists only supported catalog tools', async () => {
    const { handler } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'GET',
      url: '/tools',
    });

    const toolNames = response.getJson().data.tools.map((tool) => tool.name);

    expect(response.statusCode).toBe(200);
    expect(toolNames).toContain('torque.task.submit');
    expect(toolNames).toContain('torque.stream.poll');
    expect(toolNames).not.toContain('torque.unsupported.test');
  });

  it('dispatches POST /tools/call through handleToolCall and parses JSON tool output', async () => {
    const { handler, mocks } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      body: {
        tool: 'torque.task.submit',
        arguments: {
          task: 'ship sprint',
          working_directory: 'C:\\repo',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.tools.handleToolCall).toHaveBeenCalledWith('submit_task', {
      task: 'ship sprint',
      working_directory: 'C:\\repo',
      timeout_minutes: undefined,
      auto_approve: undefined,
      priority: undefined,
      provider: undefined,
      model: undefined,
    });
    expect(response.getJson()).toMatchObject({
      ok: true,
      data: {
        tool: 'submit_task',
        args: {
          task: 'ship sprint',
          working_directory: 'C:\\repo',
        },
      },
    });
  });

  it('prefers the tool name from the /call/:tool path over the body', async () => {
    const { handler, mocks } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/call/torque.task.get',
      body: {
        tool: 'torque.task.submit',
        arguments: {
          task_id: 'task-42',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.tools.handleToolCall).toHaveBeenCalledWith('get_result', {
      task_id: 'task-42',
    });
  });

  it('returns request and response validation summaries for /validate/:tool', async () => {
    const { handler, mocks } = await bootGateway((state) => {
      state.schemaRegistry.validate.mockImplementation((schemaId) => ({
        valid: schemaId.endsWith('.request.schema'),
        errors: schemaId.endsWith('.request.schema')
          ? []
          : [{ path: '$.data', message: 'missing response field' }],
      }));
    });

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/validate/torque.task.submit',
      body: {
        request: { task: 'ship sprint' },
        response: { ok: true },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.getJson()).toMatchObject({
      ok: true,
      data: {
        tool: 'torque.task.submit',
        request_schema: 'torque.task.submit.request.schema',
        response_schema: 'torque.task.submit.response.schema',
        request: { valid: true, errors: [] },
        response: {
          valid: false,
          errors: [{ path: '$.data', message: 'missing response field' }],
        },
      },
    });
    expect(mocks.telemetry.incrementToolCall).toHaveBeenCalledWith('validate.request');
  });

  it('returns NOT_FOUND for unknown routes', async () => {
    const { handler } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'GET',
      url: '/missing',
    });

    expect(response.statusCode).toBe(404);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Unknown route: GET /missing',
      },
    });
  });

  it('returns TOOL_CALL_ROUTE_ERROR for malformed JSON payloads', async () => {
    const { handler } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      body: '{"tool":"torque.task.get",',
    });

    expect(response.statusCode).toBe(400);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'TOOL_CALL_ROUTE_ERROR',
        message: 'Invalid JSON payload',
      },
    });
  });

  it('returns TOOL_CALL_ROUTE_ERROR for oversized payloads', async () => {
    const { handler } = await bootGateway();

    const { req, response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      chunks: ['x'.repeat(1024 * 1024 + 1)],
    });

    expect(req.destroy).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(400);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'TOOL_CALL_ROUTE_ERROR',
        message: 'Payload too large',
      },
    });
  });

  it('requires a tool name for POST /tools/call', async () => {
    const { handler } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      body: { arguments: {} },
    });

    expect(response.statusCode).toBe(400);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_TOOL_NAME_REQUIRED',
        message: 'tool is required',
      },
    });
  });

  it('rejects unsupported tool names', async () => {
    const { handler } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      body: {
        tool: 'torque.unsupported.test',
        arguments: {},
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'TOOL_UNSUPPORTED',
      },
    });
  });

  it('rejects unsupported caller roles', async () => {
    const { handler } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      headers: { 'x-mcp-role': 'guest' },
      body: {
        tool: 'torque.task.get',
        arguments: { task_id: 'task-1' },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'POLICY_INVALID_ROLE',
        message: 'Unsupported role: guest',
      },
    });
  });

  it('blocks viewer callers from operator-only tools', async () => {
    const { handler } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      headers: { 'x-mcp-role': 'viewer' },
      body: {
        tool: 'torque.task.submit',
        arguments: { task: 'blocked' },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'POLICY_FORBIDDEN',
      },
    });
  });

  it('blocks non-admin callers from admin-only tools', async () => {
    const { handler } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      headers: { 'x-mcp-role': 'operator' },
      body: {
        tool: 'torque.policy.get',
        arguments: {},
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'POLICY_FORBIDDEN',
      },
    });
  });

  it('returns request schema validation failures', async () => {
    const { handler } = await bootGateway((state) => {
      state.schemaRegistry.validate.mockImplementation((schemaId) => {
        if (schemaId.endsWith('.request.schema')) {
          return {
            valid: false,
            errors: [{ path: '$.task', message: 'Missing required property' }],
          };
        }
        return { valid: true, errors: [] };
      });
    });

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      body: {
        tool: 'torque.task.submit',
        arguments: { task: 'ship sprint' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_REQUEST_SCHEMA_FAILED',
        details: [{ path: '$.task', message: 'Missing required property' }],
      },
    });
  });

  it('returns semantic validation failures for invalid session requests', async () => {
    const { handler } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      body: {
        tool: 'torque.session.close',
        arguments: {},
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_SESSION_ID_REQUIRED',
        message: 'session_id is required',
      },
    });
  });

  it('returns TOOL_EXECUTION_ERROR when the downstream tool reports isError', async () => {
    const { handler, mocks } = await bootGateway((state) => {
      state.tools.handleToolCall.mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'tool failed hard' }],
      });
    });

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      body: {
        tool: 'torque.task.get',
        arguments: { task_id: 'task-1' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'TOOL_EXECUTION_ERROR',
        message: 'tool failed hard',
      },
    });
    expect(mocks.tools.handleToolCall).toHaveBeenCalledTimes(1);
  });

  it('returns VALIDATION_RESPONSE_SCHEMA_FAILED when the response envelope is invalid', async () => {
    const { handler } = await bootGateway((state) => {
      state.schemaRegistry.validate.mockImplementation((schemaId) => {
        if (schemaId.endsWith('.response.schema')) {
          return {
            valid: false,
            errors: [{ path: '$.data', message: 'Missing result' }],
          };
        }
        return { valid: true, errors: [] };
      });
    });

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      body: {
        tool: 'torque.task.get',
        arguments: { task_id: 'task-1' },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_RESPONSE_SCHEMA_FAILED',
      },
    });
  });

  it('opens a session and falls back to x-mcp-actor when the body omits actor', async () => {
    const { handler, mocks } = await bootGateway();

    const { response } = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      headers: { 'x-mcp-actor': 'alice' },
      body: {
        tool: 'torque.session.open',
        arguments: {},
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.getJson()).toMatchObject({
      ok: true,
      data: {
        actor: 'alice',
        opened_at: '2026-03-09T18:00:00.000Z',
      },
    });
    expect(response.getJson().data.session_id).toMatch(UUID_PATTERN);
    expect(mocks.tools.handleToolCall).not.toHaveBeenCalled();
  });

  it('closes session subscriptions when a session is closed', async () => {
    const { handler, mocks } = await bootGateway();

    const openResponse = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      headers: { 'x-mcp-actor': 'alice' },
      body: {
        tool: 'torque.session.open',
        arguments: {},
      },
    });
    const sessionId = openResponse.response.getJson().data.session_id;

    await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      body: {
        tool: 'torque.stream.subscribe',
        arguments: {
          session_id: sessionId,
          task_id: 'task-1',
        },
      },
    });

    const closeResponse = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      body: {
        tool: 'torque.session.close',
        arguments: {
          session_id: sessionId,
        },
      },
    });

    expect(closeResponse.response.statusCode).toBe(200);
    expect(closeResponse.response.getJson()).toMatchObject({
      ok: true,
      data: {
        session_id: sessionId,
        status: 'closed',
      },
    });
    expect(mocks.database.deleteEventSubscription).toHaveBeenCalledWith('sub-1');
  });

  it('prunes stale sessions on the cleanup interval', async () => {
    const { handler } = await bootGateway();

    const openResponse = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      headers: { 'x-mcp-actor': 'alice' },
      body: {
        tool: 'torque.session.open',
        arguments: {},
      },
    });
    const sessionId = openResponse.response.getJson().data.session_id;

    vi.advanceTimersByTime((95 * 60 * 1000) + 1);

    const closeResponse = await dispatchRequest(handler, {
      method: 'POST',
      url: '/tools/call',
      body: {
        tool: 'torque.session.close',
        arguments: {
          session_id: sessionId,
        },
      },
    });

    expect(closeResponse.response.statusCode).toBe(404);
    expect(closeResponse.response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `Session not found: ${sessionId}`,
      },
    });
  });

  it('enforces rate limits per actor and allows requests again after the window resets', async () => {
    const { handler, mocks } = await bootGateway();
    const baseRequest = {
      method: 'POST',
      url: '/tools/call',
      headers: { 'x-mcp-role': 'admin', 'x-mcp-actor': 'alice' },
      body: {
        tool: 'torque.provider.enable',
        arguments: {
          provider: 'codex',
        },
      },
    };

    for (let index = 0; index < 20; index += 1) {
      const result = await dispatchRequest(handler, baseRequest);
      expect(result.response.statusCode).toBe(200);
    }

    const limited = await dispatchRequest(handler, baseRequest);
    expect(limited.response.statusCode).toBe(429);
    expect(limited.response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'POLICY_RATE_LIMIT_EXCEEDED',
        details: {
          role: 'admin',
          actor: 'alice',
          tool: 'torque.provider.enable',
          limit_per_minute: 20,
          remaining: 0,
          retry_after_seconds: 60,
          reset_at_ms: expect.any(Number),
        },
      },
    });

    const differentActor = await dispatchRequest(handler, {
      ...baseRequest,
      headers: { 'x-mcp-role': 'admin', 'x-mcp-actor': 'bob' },
    });
    expect(differentActor.response.statusCode).toBe(200);

    vi.advanceTimersByTime((60 * 1000) + 1);
    const afterReset = await dispatchRequest(handler, baseRequest);
    expect(afterReset.response.statusCode).toBe(200);
    expect(mocks.tools.handleToolCall).toHaveBeenCalledTimes(22);
  });

  it('replays cached mutation responses for matching idempotency keys', async () => {
    const { handler, mocks } = await bootGateway();
    const request = {
      method: 'POST',
      url: '/tools/call',
      headers: { 'x-mcp-actor': 'alice', 'x-session-id': 'sess-1' },
      body: {
        tool: 'torque.task.submit',
        arguments: {
          task: 'ship sprint',
          idempotency_key: 'dup-1',
        },
      },
    };

    const first = await dispatchRequest(handler, request);
    const second = await dispatchRequest(handler, request);

    expect(first.response.statusCode).toBe(200);
    expect(second.response.statusCode).toBe(200);
    expect(second.response.getJson()).toMatchObject({
      ok: true,
      metadata: {
        idempotency_key: 'dup-1',
        idempotent_replay: true,
      },
    });
    expect(mocks.tools.handleToolCall).toHaveBeenCalledTimes(1);
    expect(mocks.database.recordAuditLog).toHaveBeenCalledTimes(1);
  });

  it('replays cached mutation failures for matching idempotency keys', async () => {
    const { handler, mocks } = await bootGateway((state) => {
      state.tools.handleToolCall.mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'duplicate failure' }],
      });
    });
    const request = {
      method: 'POST',
      url: '/tools/call',
      headers: { 'x-mcp-actor': 'alice', 'x-session-id': 'sess-1' },
      body: {
        tool: 'torque.task.submit',
        arguments: {
          task: 'ship sprint',
          idempotency_key: 'dup-2',
        },
      },
    };

    const first = await dispatchRequest(handler, request);
    const second = await dispatchRequest(handler, request);

    expect(first.response.statusCode).toBe(400);
    expect(second.response.statusCode).toBe(400);
    expect(second.response.getJson()).toMatchObject({
      ok: false,
      error: {
        code: 'TOOL_EXECUTION_ERROR',
        message: 'duplicate failure',
      },
      metadata: {
        idempotency_key: 'dup-2',
        idempotent_replay: true,
      },
    });
    expect(mocks.tools.handleToolCall).toHaveBeenCalledTimes(1);
  });

  it('prunes expired idempotency entries so the same key executes again after TTL expiry', async () => {
    const { handler, mocks } = await bootGateway();
    const request = {
      method: 'POST',
      url: '/tools/call',
      headers: { 'x-mcp-actor': 'alice', 'x-session-id': 'sess-1' },
      body: {
        tool: 'torque.task.submit',
        arguments: {
          task: 'ship sprint',
          idempotency_key: 'dup-3',
        },
      },
    };

    await dispatchRequest(handler, request);
    vi.advanceTimersByTime((24 * 60 * 60 * 1000) + (60 * 1000) + 1);
    const replayAfterExpiry = await dispatchRequest(handler, request);

    expect(replayAfterExpiry.response.statusCode).toBe(200);
    expect(replayAfterExpiry.response.getJson().metadata.idempotent_replay).toBeUndefined();
    expect(mocks.tools.handleToolCall).toHaveBeenCalledTimes(2);
    expect(mocks.database.recordAuditLog).toHaveBeenCalledTimes(2);
  });
});
