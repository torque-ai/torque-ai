'use strict';

const { randomUUID } = require('crypto');
const logger = require('../logger').child({ component: 'mcp-streamable-http' });
const mcpProtocol = require('../mcp/protocol');
const { validateJsonRpcRequest } = require('../utils/jsonrpc-validation');
const { parseBody } = require('./sse/protocol');

const JSONRPC_VERSION = '2.0';
const STREAMABLE_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const KEEPALIVE_INTERVAL_MS = 30000;
const DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

const sessions = new Map();

function getHeader(req, headerName) {
  const value = req.headers?.[headerName.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : null;
}

function acceptsEventStream(req) {
  const accept = getHeader(req, 'accept') || '';
  return accept.includes('text/event-stream');
}

function makeHeaders(session, extraHeaders = {}) {
  return {
    'MCP-Protocol-Version': session?.protocolVersion || STREAMABLE_PROTOCOL_VERSION,
    ...extraHeaders,
  };
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function sendJsonRpcError(res, statusCode, id, code, message, headers = {}) {
  sendJson(res, statusCode, {
    jsonrpc: JSONRPC_VERSION,
    id: id !== undefined ? id : null,
    error: { code, message },
  }, headers);
}

function validateProtocolVersionHeader(req, res) {
  const version = getHeader(req, 'mcp-protocol-version');
  if (!version) return true;
  if (SUPPORTED_PROTOCOL_VERSIONS.has(version)) return true;
  sendJson(res, 400, {
    error: `Unsupported MCP-Protocol-Version: ${version}`,
    supported_versions: [...SUPPORTED_PROTOCOL_VERSIONS],
  }, { 'MCP-Protocol-Version': STREAMABLE_PROTOCOL_VERSION });
  return false;
}

function createSession(req) {
  const sessionId = randomUUID();
  return {
    _sessionId: sessionId,
    __sessionId: sessionId,
    _remoteAddress: req.socket?.remoteAddress || req.connection?.remoteAddress || null,
    _origin: getHeader(req, 'origin'),
    _eventCounter: 0,
    authenticated: true,
    toolMode: 'core',
    protocolVersion: STREAMABLE_PROTOCOL_VERSION,
    pendingMessages: [],
    pendingRequests: new Map(),
    notificationStream: null,
    currentResponse: null,
  };
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function nextEventId(session) {
  session._eventCounter = (session._eventCounter || 0) + 1;
  return session._eventCounter;
}

function writeSseMessage(session, res, payload) {
  if (!res || res.writableEnded) return false;
  const eventId = nextEventId(session);
  res.write(`id: ${eventId}\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`);
  return true;
}

function ensureCurrentResponseStream(session) {
  const currentResponse = session.currentResponse;
  if (!currentResponse || currentResponse.streamOpened || !currentResponse.wantsSse) {
    return currentResponse;
  }

  currentResponse.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Referrer-Policy': 'no-referrer',
    'Mcp-Session-Id': session._sessionId,
    ...makeHeaders(session),
  });
  currentResponse.streamOpened = true;
  return currentResponse;
}

function dispatchMessage(session, payload) {
  if (!session) return false;

  if (session.currentResponse?.wantsSse) {
    const currentResponse = ensureCurrentResponseStream(session);
    if (currentResponse?.streamOpened) {
      return writeSseMessage(session, currentResponse.res, payload);
    }
  }

  const notificationStream = session.notificationStream;
  if (notificationStream?.res && !notificationStream.res.writableEnded) {
    return writeSseMessage(session, notificationStream.res, payload);
  }

  return false;
}

function queueOrDispatchMessage(session, payload) {
  if (!dispatchMessage(session, payload)) {
    session.pendingMessages.push(payload);
  }
}

function flushPendingMessages(session) {
  while (session.pendingMessages.length > 0) {
    if (!dispatchMessage(session, session.pendingMessages[0])) {
      break;
    }
    session.pendingMessages.shift();
  }
}

function clearNotificationStream(session) {
  if (!session?.notificationStream) return;
  clearInterval(session.notificationStream.keepaliveTimer);
  session.notificationStream = null;
}

function terminateSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  clearNotificationStream(session);
  if (session.currentResponse?.streamOpened && !session.currentResponse.res.writableEnded) {
    try {
      session.currentResponse.res.end();
    } catch {}
  }
  session.currentResponse = null;

  for (const pending of session.pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.resolve({ action: 'cancel' });
  }
  session.pendingRequests.clear();
  session.pendingMessages.length = 0;
  sessions.delete(sessionId);
  return true;
}

function sendJsonRpcNotification(sessionOrId, method, params) {
  const session = typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId;
  if (!session) return false;

  const payload = { jsonrpc: JSONRPC_VERSION, method };
  if (params !== undefined) payload.params = params;
  queueOrDispatchMessage(session, payload);
  return true;
}

function sendClientRequest(sessionId, method, params, timeoutMs = DEFAULT_CLIENT_REQUEST_TIMEOUT_MS) {
  const session = getSession(sessionId);
  if (!session) {
    return Promise.resolve({ action: 'decline' });
  }

  const requestId = `http-${randomUUID()}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      session.pendingRequests.delete(requestId);
      resolve({ action: 'cancel' });
    }, timeoutMs);

    session.pendingRequests.set(requestId, { resolve, timeout });

    const payload = {
      jsonrpc: JSONRPC_VERSION,
      id: requestId,
      method,
      params: params || {},
    };

    if (!dispatchMessage(session, payload)) {
      clearTimeout(timeout);
      session.pendingRequests.delete(requestId);
      resolve({ action: 'decline' });
    }
  });
}

function resolveSessionForRequest(req, request, res) {
  const sessionId = getHeader(req, 'mcp-session-id');
  if (request.method === 'initialize' && !sessionId) {
    const session = createSession(req);
    sessions.set(session._sessionId, session);
    return { session, created: true };
  }

  if (!sessionId) {
    sendJson(res, 400, {
      error: 'Missing Mcp-Session-Id header',
    }, makeHeaders(null));
    return { session: null, created: false };
  }

  const session = getSession(sessionId);
  if (!session) {
    sendJson(res, 404, {
      error: `Session not found: ${sessionId}`,
    }, makeHeaders(null));
    return { session: null, created: false };
  }

  return { session, created: false };
}

async function handlePost(req, res) {
  if (!validateProtocolVersionHeader(req, res)) return;

  let request;
  try {
    request = await parseBody(req);
  } catch {
    sendJsonRpcError(res, 400, null, -32700, 'Parse error: Invalid JSON', makeHeaders(null));
    return;
  }

  if (!request) {
    sendJsonRpcError(res, 400, null, -32600, 'Invalid Request: empty body', makeHeaders(null));
    return;
  }

  const sessionId = getHeader(req, 'mcp-session-id');
  if (!request.method && request.id !== undefined) {
    if (!sessionId) {
      sendJson(res, 400, { error: 'Missing Mcp-Session-Id header' }, makeHeaders(null));
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: `Session not found: ${sessionId}` }, makeHeaders(null));
      return;
    }

    const pending = session.pendingRequests.get(request.id);
    if (pending) {
      clearTimeout(pending.timeout);
      session.pendingRequests.delete(request.id);
      pending.resolve(request.result || request.error || { action: 'cancel' });
    }

    res.writeHead(202, makeHeaders(session));
    res.end();
    return;
  }

  const validation = validateJsonRpcRequest(request);
  if (!validation.valid) {
    sendJsonRpcError(
      res,
      400,
      validation.id,
      validation.error.code,
      validation.error.message,
      makeHeaders(null),
    );
    return;
  }

  const { session, created } = resolveSessionForRequest(req, request, res);
  if (!session) return;

  if (request.id !== undefined) {
    session.currentResponse = {
      res,
      wantsSse: acceptsEventStream(req),
      streamOpened: false,
    };
  }

  try {
    const result = await mcpProtocol.handleRequest(request, session);
    const responseHeaders = makeHeaders(
      session,
      request.method === 'initialize'
        ? { 'Mcp-Session-Id': session._sessionId }
        : {},
    );

    if (session._toolsChanged) {
      session._toolsChanged = false;
      const notification = {
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/tools/list_changed',
      };
      if (session.currentResponse?.wantsSse) {
        ensureCurrentResponseStream(session);
        writeSseMessage(session, session.currentResponse.res, notification);
      } else {
        queueOrDispatchMessage(session, notification);
      }
    }

    if (request.id === undefined || result === null) {
      if (session.currentResponse?.streamOpened) {
        session.currentResponse.res.end();
      } else {
        res.writeHead(202, responseHeaders);
        res.end();
      }
      return;
    }

    const payload = {
      jsonrpc: JSONRPC_VERSION,
      id: request.id,
      result,
    };

    if (session.currentResponse?.streamOpened) {
      writeSseMessage(session, session.currentResponse.res, payload);
      session.currentResponse.res.end();
      return;
    }

    sendJson(res, 200, payload, responseHeaders);
  } catch (err) {
    const responseHeaders = makeHeaders(
      session,
      request.method === 'initialize'
        ? { 'Mcp-Session-Id': session._sessionId }
        : {},
    );
    const payload = {
      jsonrpc: JSONRPC_VERSION,
      id: request.id !== undefined ? request.id : null,
      error: {
        code: err.code || -32603,
        message: err.message || 'Internal error',
      },
    };

    if (session.currentResponse?.streamOpened) {
      writeSseMessage(session, session.currentResponse.res, payload);
      session.currentResponse.res.end();
    } else if (request.id !== undefined) {
      sendJson(res, 200, payload, responseHeaders);
    } else {
      res.writeHead(202, responseHeaders);
      res.end();
    }

    if (created && request.method === 'initialize') {
      terminateSession(session._sessionId);
    }
  } finally {
    session.currentResponse = null;
  }
}

function handleGet(req, res) {
  if (!validateProtocolVersionHeader(req, res)) return;

  const sessionId = getHeader(req, 'mcp-session-id');
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing Mcp-Session-Id header' }, makeHeaders(null));
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    sendJson(res, 404, { error: `Session not found: ${sessionId}` }, makeHeaders(null));
    return;
  }

  clearNotificationStream(session);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Referrer-Policy': 'no-referrer',
    'Mcp-Session-Id': session._sessionId,
    ...makeHeaders(session),
  });

  const keepaliveTimer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
      return;
    }
    clearNotificationStream(session);
  }, KEEPALIVE_INTERVAL_MS);

  session.notificationStream = { res, keepaliveTimer };
  flushPendingMessages(session);

  req.on('close', () => {
    if (session.notificationStream?.res === res) {
      clearNotificationStream(session);
    }
  });
}

function handleDelete(req, res) {
  if (!validateProtocolVersionHeader(req, res)) return;

  const sessionId = getHeader(req, 'mcp-session-id');
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing Mcp-Session-Id header' }, makeHeaders(null));
    return;
  }

  if (!terminateSession(sessionId)) {
    sendJson(res, 404, { error: `Session not found: ${sessionId}` }, makeHeaders(null));
    return;
  }

  res.writeHead(204, makeHeaders(null));
  res.end();
}

function handleHttpRequest(req, res, url) {
  if (url.pathname !== '/mcp') return false;

  logger.info(`Incoming streamable MCP request ${req.method} ${req.url}`, {
    method: req.method,
    path: req.url,
  });

  if (req.method === 'POST') {
    void handlePost(req, res);
    return true;
  }

  if (req.method === 'GET') {
    handleGet(req, res);
    return true;
  }

  if (req.method === 'DELETE') {
    handleDelete(req, res);
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' }, makeHeaders(null));
  return true;
}

function stop() {
  for (const sessionId of [...sessions.keys()]) {
    terminateSession(sessionId);
  }
}

module.exports = {
  STREAMABLE_PROTOCOL_VERSION,
  sessions,
  getSession,
  sendJsonRpcNotification,
  sendClientRequest,
  handleHttpRequest,
  stop,
};
