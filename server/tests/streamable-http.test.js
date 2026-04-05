'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const TRANSPORT_MODULE = '../transports/streamable-http';
const LOGGER_MODULE = '../logger';
const MCP_PROTOCOL_MODULE = '../mcp-protocol';
const JSONRPC_VALIDATION_MODULE = '../utils/jsonrpc-validation';
const SSE_PROTOCOL_MODULE = '../transports/sse/protocol';
const MODULE_PATHS = [
  TRANSPORT_MODULE,
  LOGGER_MODULE,
  MCP_PROTOCOL_MODULE,
  JSONRPC_VALIDATION_MODULE,
  SSE_PROTOCOL_MODULE,
];

let transport;
let mockLogger;
let mockLoggerModule;
let mockMcpProtocol;
let mockJsonRpcValidation;
let mockSseProtocol;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore modules that were not loaded in this test process.
  }
}

function clearModules() {
  for (const modulePath of MODULE_PATHS) {
    clearModule(modulePath);
  }
}

function createMockMcpProtocol() {
  const mockProtocol = {
    handleToolCall: vi.fn(async (name, args, session) => ({
      content: [{ type: 'text', text: `${name} ok` }],
      receivedArgs: args,
      sessionId: session?._sessionId || null,
    })),
  };

  mockProtocol.handleRequest = vi.fn(async (request, session) => {
    if (request.method === 'initialize') {
      return {
        protocolVersion: session.protocolVersion,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'test-server', version: '0.0.0' },
      };
    }

    if (request.method === 'tools/call') {
      return mockProtocol.handleToolCall(
        request.params?.name,
        request.params?.arguments || {},
        session,
      );
    }

    return { ok: true };
  });

  return mockProtocol;
}

function loadTransport() {
  clearModules();
  installCjsModuleMock(LOGGER_MODULE, mockLoggerModule);
  installCjsModuleMock(MCP_PROTOCOL_MODULE, mockMcpProtocol);
  installCjsModuleMock(JSONRPC_VALIDATION_MODULE, mockJsonRpcValidation);
  installCjsModuleMock(SSE_PROTOCOL_MODULE, mockSseProtocol);
  return require(TRANSPORT_MODULE);
}

function createReq(overrides = {}) {
  const listeners = new Map();
  const req = {
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    socket: { remoteAddress: '127.0.0.1' },
    on: vi.fn((event, callback) => {
      listeners.set(event, callback);
      return req;
    }),
    emit(event, ...args) {
      listeners.get(event)?.(...args);
    },
    ...overrides,
  };

  if (!req.connection) req.connection = req.socket;
  return req;
}

function createRes(overrides = {}) {
  const listeners = new Map();
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead: vi.fn((statusCode, headers = {}) => {
      res.statusCode = statusCode;
      Object.assign(res.headers, headers);
      res.headersSent = true;
      return res;
    }),
    write: vi.fn((chunk) => {
      chunks.push(String(chunk));
      return true;
    }),
    end: vi.fn((body = '') => {
      if (body) chunks.push(String(body));
      res.writableEnded = true;
      listeners.get('finish')?.();
    }),
    on: vi.fn((event, callback) => {
      listeners.set(event, callback);
      return res;
    }),
    writableEnded: false,
    headersSent: false,
    ...overrides,
  };

  res.getBodyText = () => chunks.join('');
  res.getJson = () => JSON.parse(res.getBodyText());
  return res;
}

function createInitializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { capabilities: { elicitation: true } },
  };
}

async function invokePost(body, reqOverrides = {}, resOverrides = {}) {
  const req = createReq(reqOverrides);
  const res = createRes(resOverrides);

  mockSseProtocol.parseBody.mockResolvedValueOnce(body);

  expect(transport.handleHttpRequest(req, res, { pathname: '/mcp' })).toBe(true);
  await vi.waitFor(() => expect(res.end).toHaveBeenCalled());

  return { req, res };
}

async function initializeSession(extraHeaders = {}) {
  const { res } = await invokePost(createInitializeBody(), {
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...extraHeaders,
    },
  });

  const sessionId = res.headers['Mcp-Session-Id'];
  return {
    res,
    sessionId,
    session: transport.getSession(sessionId),
  };
}

beforeEach(() => {
  mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  mockLoggerModule = {
    child: vi.fn(() => mockLogger),
  };
  mockMcpProtocol = createMockMcpProtocol();
  mockJsonRpcValidation = {
    validateJsonRpcRequest: vi.fn((request) => ({
      valid: true,
      id: request?.id ?? null,
    })),
  };
  mockSseProtocol = {
    parseBody: vi.fn(),
  };
  transport = loadTransport();
});

afterEach(() => {
  try {
    transport?.stop();
  } catch {
    // Transport cleanup is best-effort for test isolation.
  }
  transport = null;
  vi.restoreAllMocks();
  clearModules();
});

describe('transports/streamable-http', () => {
  it('getSession returns null for unknown ids and returns the session after initialize', async () => {
    expect(transport.getSession('missing-session')).toBeNull();

    const { sessionId } = await initializeSession();

    expect(sessionId).toEqual(expect.any(String));
    expect(transport.getSession(sessionId)).toMatchObject({
      _sessionId: sessionId,
    });
  });

  it('creates an authenticated session with a session id and protocol version on initialize', async () => {
    const { sessionId, session } = await initializeSession();

    expect(session).toMatchObject({
      _sessionId: sessionId,
      __sessionId: sessionId,
      protocolVersion: transport.STREAMABLE_PROTOCOL_VERSION,
      authenticated: true,
    });
  });

  it('accepts supported MCP-Protocol-Version headers', async () => {
    const { res } = await initializeSession({
      'mcp-protocol-version': transport.STREAMABLE_PROTOCOL_VERSION,
    });

    expect(res.statusCode).toBe(200);
    expect(mockSseProtocol.parseBody).toHaveBeenCalledTimes(1);
    expect(mockMcpProtocol.handleRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported MCP-Protocol-Version headers with a 400 response', async () => {
    const req = createReq({
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'mcp-protocol-version': '2099-01-01',
      },
    });
    const res = createRes();

    expect(transport.handleHttpRequest(req, res, { pathname: '/mcp' })).toBe(true);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());

    expect(res.statusCode).toBe(400);
    expect(res.getJson()).toMatchObject({
      error: 'Unsupported MCP-Protocol-Version: 2099-01-01',
    });
    expect(res.getJson().supported_versions).toContain(transport.STREAMABLE_PROTOCOL_VERSION);
    expect(mockSseProtocol.parseBody).not.toHaveBeenCalled();
    expect(mockMcpProtocol.handleRequest).not.toHaveBeenCalled();
  });

  it('POST initialize creates a session and returns capabilities in the JSON-RPC response', async () => {
    const { res, sessionId } = await initializeSession();

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': transport.STREAMABLE_PROTOCOL_VERSION,
      'Mcp-Session-Id': sessionId,
    });
    expect(res.getJson()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: transport.STREAMABLE_PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'test-server', version: '0.0.0' },
      },
    });
  });

  it('POST tools/call routes through the mocked protocol and returns the tool result', async () => {
    const { sessionId } = await initializeSession();
    const toolResult = {
      content: [{ type: 'text', text: 'tool ok' }],
      structuredContent: { ok: true },
    };

    mockMcpProtocol.handleToolCall.mockResolvedValueOnce(toolResult);

    const { res } = await invokePost({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'ping',
        arguments: { message: 'hello' },
      },
    }, {
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': transport.STREAMABLE_PROTOCOL_VERSION,
      },
    });

    expect(mockMcpProtocol.handleToolCall).toHaveBeenCalledWith(
      'ping',
      { message: 'hello' },
      expect.objectContaining({ _sessionId: sessionId }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.getJson()).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: toolResult,
    });
  });

  it('sendJsonRpcNotification writes an SSE message to the session notification stream', async () => {
    const { session } = await initializeSession();
    const notificationRes = createRes();

    session.notificationStream = {
      res: notificationRes,
      keepaliveTimer: null,
    };

    expect(
      transport.sendJsonRpcNotification(session, 'notifications/test', { ok: true }),
    ).toBe(true);
    expect(notificationRes.write).toHaveBeenCalledWith(
      `id: 1\nevent: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/test',
        params: { ok: true },
      })}\n\n`,
    );
  });

  it('stop clears active sessions and notification stream intervals', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {});
    const { sessionId, session } = await initializeSession();
    const keepaliveTimer = { id: 'keepalive-timer' };

    session.notificationStream = {
      res: createRes(),
      keepaliveTimer,
    };

    expect(transport.sessions.size).toBe(1);

    transport.stop();

    expect(clearIntervalSpy).toHaveBeenCalledWith(keepaliveTimer);
    expect(transport.sessions.size).toBe(0);
    expect(transport.getSession(sessionId)).toBeNull();
  });
});
