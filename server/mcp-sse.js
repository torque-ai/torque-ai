/**
 * TORQUE MCP SSE Transport
 *
 * Provides MCP protocol over Server-Sent Events (SSE) instead of stdio.
 * SSE connections survive Claude Code context rollovers because they use
 * HTTP networking rather than process pipes.
 *
 * Protocol:
 *   GET  /sse              -> Establishes SSE stream, sends endpoint event
 *   POST /messages?sessionId=xxx -> Receives JSON-RPC requests, responds via SSE
 *
 * Session management, notification delivery, and protocol handling are
 * delegated to:
 *   - transports/sse/session.js  (state, subscriptions, notifications)
 *   - transports/sse/protocol.js (JSON-RPC dispatch, tool definitions)
 */

const http = require('http');
const { randomUUID } = require('crypto');
const serverConfig = require('./config');
const logger = require('./logger').child({ component: 'mcp-sse' });
const { validateJsonRpcRequest } = require('./utils/jsonrpc-validation');
const eventBus = require('./event-bus');

// Extracted modules
const sessionMod = require('./transports/sse/session');
const protocolMod = require('./transports/sse/protocol');

// Re-export shared state for backward compatibility
const {
  sessions,
  taskSubscriptions,
  notificationMetrics,
  _perIpSessionCount,
  aggregationBuffers,
  JSONRPC_VERSION,
  MAX_SSE_SESSIONS,
  MAX_SESSIONS_PER_IP,
} = sessionMod;

const KEEPALIVE_INTERVAL_MS = 30000;

// Standard security headers applied to all responses
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
};

// ── Pending server->client requests (elicitation, sampling) ──
const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;

// Abort controller — fires on server shutdown so blocking handlers can return early
let shutdownAbort = new AbortController();

let sseServer = null;
let ssePort = 3458;
let shuttingDown = false;
const TRACKED_INTERVALS = new Set();

// Wire tracked intervals into session module
sessionMod.setTrackedIntervals(TRACKED_INTERVALS);

// ──────────────────────────────────────────────────────────────
// Interval tracking
// ──────────────────────────────────────────────────────────────

function trackInterval(timer) {
  TRACKED_INTERVALS.add(timer);
  return timer;
}

function clearTrackedInterval(timer) {
  if (!timer) return;
  clearInterval(timer);
  TRACKED_INTERVALS.delete(timer);
}

function clearAllTrackedIntervals() {
  for (const timer of TRACKED_INTERVALS) {
    clearInterval(timer);
  }
  TRACKED_INTERVALS.clear();
}

// ──────────────────────────────────────────────────────────────
// CORS / origin helpers
// ──────────────────────────────────────────────────────────────

function getAllowedOrigins() {
  if (process.env.MCP_ALLOWED_ORIGINS) {
    return parseAllowedOrigins(process.env.MCP_ALLOWED_ORIGINS);
  }
  const dashboardPort = serverConfig ? serverConfig.getInt('dashboard_port', 3456) : 3456;
  return new Set([
    `http://127.0.0.1:${dashboardPort}`,
    `http://localhost:${dashboardPort}`,
  ]);
}

function parseAllowedOrigins(rawOrigins) {
  if (typeof rawOrigins !== 'string') return new Set();
  const parsed = rawOrigins.split(',').map((item) => item.trim()).filter(Boolean);
  return new Set(parsed);
}

function resolveMcpAllowedOrigin(requestOrigin) {
  if (typeof requestOrigin !== 'string') return null;
  const normalized = requestOrigin.trim();
  return getAllowedOrigins().has(normalized) ? normalized : null;
}

// ──────────────────────────────────────────────────────────────
// Core SSE helpers
// ──────────────────────────────────────────────────────────────

function debugLog(message, data = {}) {
  logger.debug(message, data);
}

function generateSessionId() {
  return randomUUID();
}

function isSessionOwner(session, req) {
  const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress;
  if (session._origin && req.headers.origin && session._origin !== req.headers.origin) return false;
  if (session._remoteAddress && remoteAddress && session._remoteAddress !== remoteAddress) return false;
  return true;
}

function resolveRequestId(req) {
  const headerValue = req.headers['x-request-id'];
  if (Array.isArray(headerValue)) {
    const first = headerValue.find(value => typeof value === 'string' && value.trim());
    if (first) return first.trim();
  } else if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }
  return randomUUID();
}

/**
 * Send an SSE event to a client.
 */
function sendSseEvent(res, event, data) {
  const isSession = res && typeof res === 'object' && res.res;
  const stream = isSession ? res.res : res;
  if (!stream || stream.writableEnded) return;

  if (isSession) {
    res._eventCounter = (res._eventCounter || 0) + 1;
    stream.write(`id: ${res._eventCounter}\nevent: ${event}\ndata: ${data}\n\n`);
    return;
  }

  const eventId = sessionMod.nextEventId();
  stream.write(`id: ${eventId}\nevent: ${event}\ndata: ${data}\n\n`);
}

/**
 * Send a JSON-RPC response through the SSE stream.
 */
function sendJsonRpcResponse(session, id, result, error) {
  const response = { jsonrpc: JSONRPC_VERSION, id };
  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }
  sendSseEvent(session, 'message', JSON.stringify(response));
}

/**
 * Send a JSON-RPC notification through the SSE stream.
 */
function sendJsonRpcNotification(session, method, params) {
  const notification = { jsonrpc: JSONRPC_VERSION, method };
  if (params) notification.params = params;
  sendSseEvent(session, 'message', JSON.stringify(notification));
}

// Inject send helpers into session and protocol modules
sessionMod.injectSendHelpers({ sendSseEvent, sendJsonRpcNotification });
protocolMod.injectNotificationSender(sendJsonRpcNotification);

/**
 * Send a JSON-RPC request TO the client and wait for response.
 */
function sendClientRequest(sessionId, method, params, timeoutMs = ELICITATION_TIMEOUT_MS) {
  const session = sessions.get(sessionId);
  if (!session || session.res.writableEnded) {
    return Promise.resolve({ action: 'decline' });
  }

  if (!session.pendingRequests) {
    session.pendingRequests = new Map();
  }

  const requestId = `elicit-${randomUUID()}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      session.pendingRequests.delete(requestId);
      resolve({ action: 'cancel' });
    }, timeoutMs);

    session.pendingRequests.set(requestId, { resolve, timeout });

    const request = { jsonrpc: JSONRPC_VERSION, id: requestId, method, params: params || {} };
    sendSseEvent(session, 'message', JSON.stringify(request));
  });
}

// ──────────────────────────────────────────────────────────────
// HTTP server
// ──────────────────────────────────────────────────────────────

/**
 * Handle incoming HTTP requests.
 */
async function handleHttpRequest(req, res) {
  const requestId = resolveRequestId(req);
  const requestStart = Date.now();
  res.setHeader('X-Request-ID', requestId);

  if (shuttingDown) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SSE service is shutting down' }));
    return;
  }

  logger.info(`Incoming SSE request ${req.method} ${req.url}`, {
    requestId,
    method: req.method,
    path: req.url,
  });

  res.on('finish', () => {
    logger.info(`Completed SSE request ${req.method} ${req.url}`, {
      requestId,
      method: req.method,
      path: req.url,
      statusCode: res.statusCode,
      durationMs: Date.now() - requestStart,
    });
  });

  // Parse URL safely
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

    const requestOrigin = req.headers.origin;
  const allowedOrigin = resolveMcpAllowedOrigin(requestOrigin);
  if (requestOrigin && !allowedOrigin) {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(key, value);
    }
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(403);
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /sse — establish SSE connection
  if (req.method === 'GET' && url.pathname === '/sse') {
    return handleSseConnection(req, res, url, requestId);
  }

  // POST /messages?sessionId=xxx — receive JSON-RPC request
  if (req.method === 'POST' && url.pathname === '/messages') {
    return handleMessagePost(req, res, url, requestId);
  }

  // Unknown route
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found. Use GET /sse to connect.' }));
}

/**
 * Handle GET /sse — establish SSE connection.
 */
async function handleSseConnection(req, res, url, requestId) {
  const requestedSessionId = url.searchParams.get('sessionId');
  const existingSession = requestedSessionId ? sessions.get(requestedSessionId) : null;
  const sessionId = existingSession ? requestedSessionId : generateSessionId();

  // Local mode: accept all connections unconditionally
  const identity = { id: 'local', name: 'Local User', role: 'admin', type: 'local' };

  if (!existingSession && sessions.size >= MAX_SSE_SESSIONS) {
    logger.warn('[SSE] Session cap reached');
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many active sessions', max: MAX_SSE_SESSIONS }));
    return;
  }

  const ip = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  if (!existingSession && ip !== 'unknown') {
    const currentIpCount = _perIpSessionCount.get(ip) || 0;
    if (currentIpCount >= MAX_SESSIONS_PER_IP) {
      logger.warn(`[SSE] Per-IP session limit reached for ${ip}`);
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('Too many sessions from this IP');
      return;
    }
    _perIpSessionCount.set(ip, currentIpCount + 1);
  }

  const lastEventIdHeader = (() => {
    const headerValue = req.headers['last-event-id'] || req.headers['Last-Event-ID'] || req.headers['LAST-EVENT-ID'];
    if (!headerValue) return 0;
    return parseInt(Array.isArray(headerValue) ? headerValue[0] : headerValue, 10);
  })();
  const queryLastEventId = parseInt(url.searchParams.get('lastEventId'), 10);
  const queryHeaderEventId = Number.isInteger(lastEventIdHeader) ? lastEventIdHeader : 0;
  const lastEventId = Number.isInteger(queryLastEventId) ? queryLastEventId : queryHeaderEventId;
  const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress || null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Referrer-Policy': 'no-referrer',
  });

  // Keepalive timer to prevent silent connection drops
  const keepaliveTimer = trackInterval(setInterval(() => {
    if (res.writableEnded) {
      clearTrackedInterval(keepaliveTimer);
      return;
    }
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearTrackedInterval(keepaliveTimer);
      const deadSession = sessions.get(sessionId);
      if (deadSession && deadSession.res === res) {
        sessions.delete(sessionId);
        sessionMod.removeSessionFromTaskSubscriptions(sessionId, deadSession.taskFilter);
        const sessionIp = deadSession._ip;
        if (sessionIp) {
          const ipCount = _perIpSessionCount.get(sessionIp) || 1;
          if (ipCount <= 1) _perIpSessionCount.delete(sessionIp);
          else _perIpSessionCount.set(sessionIp, ipCount - 1);
        }
        const aggrBuf = aggregationBuffers.get(sessionId);
        if (aggrBuf) {
          if (aggrBuf.timer) clearTimeout(aggrBuf.timer);
          aggregationBuffers.delete(sessionId);
        }
        debugLog(`Session cleaned up by keepalive failure: ${sessionId} (${sessions.size} active)`, {
          sessionId,
          activeSessions: sessions.size,
        });
      }
    }
  }, KEEPALIVE_INTERVAL_MS));

  // Try to restore subscription from a previous session (brand-new sessions only)
  const restored = existingSession ? null : sessionMod.restoreSubscription(sessionId);

  // If this sessionId already has an active connection, reattach
  if (existingSession) {
    if (existingSession.keepaliveTimer) {
      clearTrackedInterval(existingSession.keepaliveTimer);
    }
    const oldRes = existingSession.res;
    existingSession.res = res;
    if (oldRes && !oldRes.writableEnded) {
      try { oldRes.end(); } catch {}
    }
  }

  const session = existingSession || {
    keepaliveTimer,
    res,
    toolMode: 'core',
    authenticated: true,
    pendingEvents: [],
    eventFilter: restored ? restored.eventFilter : new Set(['completed', 'failed']),
    taskFilter: restored ? restored.taskFilter : new Set(),
    projectFilter: new Set(),
    providerFilter: new Set(),
    _sessionId: sessionId,
    _remoteAddress: remoteAddress,
    _origin: req.headers.origin || null,
    _eventCounter: 0,
    _ip: ip,
  };
  session.res = res;
  session.keepaliveTimer = keepaliveTimer;
  session._remoteAddress = remoteAddress;
  session._origin = req.headers.origin || null;
  if (existingSession) {
    session.authenticated = true;
  }

  if (!existingSession) {
    sessions.set(sessionId, session);
    sessionMod.addSessionToTaskSubscriptions(sessionId, session.taskFilter);

    // Auto-register session as coordination agent
    try {
      const coord = require('./db/coordination');
      coord.registerAgent({
        id: sessionId,
        name: 'claude-code@unknown',
        agent_type: 'mcp-session',
        capabilities: ['submit', 'await', 'workflow'],
        max_concurrent: 10,
        priority: 0,
        metadata: { transport: 'sse', connected_at: new Date().toISOString() },
      });
      coord.recordCoordinationEvent('session_connected', sessionId, null, null);
    } catch {
      // Non-fatal
    }

    debugLog(`Session connected: ${sessionId} (${sessions.size} active)${restored ? ' [restored]' : ''}`, {
      requestId,
      sessionId,
      activeSessions: sessions.size,
      restored,
    });
  } else {
    debugLog(`Session ${sessionId} reattached`, {
      requestId,
      sessionId,
    });
  }

  // Replay missed events from DB if client provides lastEventId
  if (lastEventId > 0) {
    try {
      const { getTaskEvents } = require('./hooks/event-dispatch');
      const missedEvents = getTaskEvents({
        sinceId: lastEventId,
        limit: Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 100, 1000))
      });
      const seen = new Set();
      for (const evt of missedEvents.slice().reverse()) {
        const dedup = `${evt.task_id}:${evt.event_type}:${evt.created_at}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);

        let parsed = {};
        try {
          parsed = evt.event_data ? JSON.parse(evt.event_data) : {};
        } catch (parseErr) {
          logger.warn(`Skipping corrupted replay event ${evt.id}: ${parseErr.message}`);
          continue;
        }
        session.pendingEvents.push({
          id: sessionMod.nextEventId(),
          eventName: evt.event_type,
          taskId: evt.task_id,
          status: evt.new_value || evt.event_type,
          exitCode: parsed.exit_code ?? null,
          project: parsed.project || null,
          provider: parsed.provider || null,
          duration: parsed.duration ?? null,
          description: null,
          timestamp: evt.created_at,
          replayed: true,
        });
      }
    } catch {
      // Non-fatal — replay is best-effort
    }
  }

  // Send the endpoint event — tells the client where to POST messages
  sendSseEvent(session, 'endpoint', `/messages?sessionId=${sessionId}`);

  // Handle client disconnect
  req.on('close', () => {
    clearTrackedInterval(keepaliveTimer);
    const current = sessions.get(sessionId);
    if (current && current.res === res) {
      sessions.delete(sessionId);
      sessionMod.removeSessionFromTaskSubscriptions(sessionId, current.taskFilter);
      const sessionIp = current._ip;
      if (sessionIp) {
        const ipCount = _perIpSessionCount.get(sessionIp) || 1;
        if (ipCount <= 1) _perIpSessionCount.delete(sessionIp);
        else _perIpSessionCount.set(sessionIp, ipCount - 1);
      }
      const aggrBuf = aggregationBuffers.get(sessionId);
      if (aggrBuf) {
        if (aggrBuf.timer) clearTimeout(aggrBuf.timer);
        aggregationBuffers.delete(sessionId);
      }
      // Mark coordination agent offline
      try {
        const coord = require('./db/coordination');
        coord.updateAgent(sessionId, { status: 'offline' });
        coord.recordCoordinationEvent('session_disconnected', sessionId, null, null);
      } catch {
        // Non-fatal
      }

      // Clean up pending elicitation requests
      if (current.pendingRequests) {
        for (const pending of current.pendingRequests.values()) {
          clearTimeout(pending.timeout);
          pending.resolve({ action: 'cancel' });
        }
        current.pendingRequests.clear();
      }

      debugLog(`Session disconnected: ${sessionId} (${sessions.size} active)`, {
        requestId,
        sessionId,
        activeSessions: sessions.size,
      });
    } else {
      debugLog(`Session ${sessionId} close handler skipped — session already replaced by reconnect`, {
        requestId,
        sessionId,
      });
    }
  });
}

/**
 * Handle POST /messages?sessionId=xxx — receive JSON-RPC request.
 */
async function handleMessagePost(req, res, url, requestId) {
  const sessionId = url.searchParams.get('sessionId');
  const session = sessions.get(sessionId);

  if (!session) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired session' }));
    return;
  }

  if (!isSessionOwner(session, req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session ownership mismatch' }));
    return;
  }

  let request;
  try {
    request = await protocolMod.parseBody(req);
    if (!request) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Empty request body' }));
      return;
    }
  } catch {
    sendJsonRpcResponse(session, null, null, {
      code: -32700,
      message: 'Parse error: Invalid JSON',
    });
    res.writeHead(202);
    res.end();
    return;
  }

  // Check if this is a response to a server-initiated request (elicitation/sampling)
  if (request && !request.method && request.id !== undefined) {
    if (session.pendingRequests && session.pendingRequests.has(request.id)) {
      const pending = session.pendingRequests.get(request.id);
      clearTimeout(pending.timeout);
      session.pendingRequests.delete(request.id);
      pending.resolve(request.result || { action: 'cancel' });
      res.writeHead(202);
      res.end();
      return;
    }
  }

  const validation = validateJsonRpcRequest(request);
  if (!validation.valid) {
    sendJsonRpcResponse(session, validation.id, null, {
      code: validation.error.code,
      message: validation.error.message,
    });
    res.writeHead(202);
    res.end();
    return;
  }

  // Acknowledge the POST immediately — actual response comes via SSE
  res.writeHead(202);
  res.end();

  try {
    const result = await protocolMod.handleMcpRequest(request, session);

    if (request.id !== undefined && result !== null) {
      sendJsonRpcResponse(session, request.id, result);
    }
  } catch (err) {
    if (request.id !== undefined) {
      if (session.res.writableEnded) {
        debugLog(`Session ${sessionId}: SSE stream ended, cannot send error response for request ${request.id}`, {
          requestId,
          sessionId,
          rpcRequestId: request.id,
        });
      } else {
        sendJsonRpcResponse(session, request.id, null, {
          code: err.code || -32603,
          message: err.message || 'Internal error',
        });
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Server lifecycle
// ──────────────────────────────────────────────────────────────

/**
 * Start the MCP SSE server.
 */
function start(options = {}) {
  return new Promise((resolve) => {
    if (sseServer) {
      resolve({ success: true, port: ssePort, message: 'Already running' });
      return;
    }
    shutdownAbort = new AbortController();

    // Initialize shared protocol handler
    protocolMod.initProtocol(shutdownAbort);

    ssePort = options.port || serverConfig.getInt('mcp_sse_port', 3458);

    sseServer = http.createServer(handleHttpRequest);

    sseServer.on('error', (err) => {
      sseServer = null;
      if (err.code === 'EADDRINUSE') {
        debugLog(`Port ${ssePort} already in use`);
        process.stderr.write(
          `\nMCP SSE port ${ssePort} is already in use.\n\n` +
          `Options:\n` +
          `  1. Stop existing TORQUE: bash stop-torque.sh\n` +
          `  2. Use different port: TORQUE_SSE_PORT=${ssePort + 2} torque start\n` +
          `  3. Find what's using it: lsof -i :${ssePort} (Linux/Mac) or netstat -ano | findstr :${ssePort} (Windows)\n\n`
        );
        resolve({ success: false, error: 'Port in use' });
      } else {
        debugLog(`Server error: ${err.message}`);
        resolve({ success: false, error: err.message });
      }
    });

    sseServer.listen(ssePort, '127.0.0.1', () => {
      debugLog(`Listening on http://127.0.0.1:${ssePort}/sse`);
      sessionMod.cleanExpiredSubscriptions();
      trackInterval(setInterval(sessionMod.cleanExpiredSubscriptions, 60 * 60 * 1000));
      // Reap stale sessions every 60s to prevent per-IP counter drift
      trackInterval(setInterval(() => {
        const reaped = sessionMod.reapStaleSessions();
        if (reaped > 0) debugLog(`Reaped ${reaped} stale session(s) (${sessions.size} remaining)`);
      }, 60000));
      resolve({ success: true, port: ssePort });
    });
  });
}

/**
 * Stop the MCP SSE server and close all sessions.
 */
function stop() {
  shutdownAbort.abort();

  if (sseServer) {
    clearAllTrackedIntervals();

    for (const [_id, session] of sessions) {
      clearTrackedInterval(session.keepaliveTimer);
      if (session.res && !session.res.writableEnded) {
        session.res.end();
      }
    }
    sessionMod.clearAllSessionState();
    const server = sseServer;
    sseServer = null;
    server.close(() => {
      debugLog('Server fully closed');
    });
    if (_modelDiscoveredHandler) {
      eventBus.removeListener('model-discovered', _modelDiscoveredHandler);
      _modelDiscoveredHandler = null;
    }
    if (_modelRemovedHandler) {
      eventBus.removeListener('model-removed', _modelRemovedHandler);
      _modelRemovedHandler = null;
    }
    debugLog('Server stopping');
  }
}

function setShuttingDown(value) {
  shuttingDown = Boolean(value);
}

// ── Model registry notifications ─────────────────────────────

let _modelDiscoveredHandler = null;
let _modelRemovedHandler = null;

_modelDiscoveredHandler = (data) => {
  for (const [, session] of sessions) {
    try {
      sendJsonRpcNotification(session, 'notifications/message', {
        level: 'info',
        logger: 'torque',
        data: {
          type: 'model_discovered',
          provider: data.provider,
          model: data.modelName,
          host_id: data.hostId || 'cloud',
        },
      });
    } catch (_e) { void _e; }
  }
};
eventBus.onModelDiscovered(_modelDiscoveredHandler);

_modelRemovedHandler = (data) => {
  for (const [, session] of sessions) {
    try {
      sendJsonRpcNotification(session, 'notifications/message', {
        level: 'warning',
        logger: 'torque',
        data: {
          type: 'model_removed',
          provider: data.provider,
          model: data.modelName,
          host_id: data.hostId || 'cloud',
          rerouted: data.rerouted || 0,
        },
      });
    } catch (_e) { void _e; }
  }
};
eventBus.onModelRemoved(_modelRemovedHandler);

// ──────────────────────────────────────────────────────────────
// Exports — backward compatible with original mcp-sse.js
// ──────────────────────────────────────────────────────────────

module.exports = {
  start,
  stop,
  notifySubscribedSessions: sessionMod.notifySubscribedSessions,
  pushNotification: sessionMod.pushNotification,
  getActiveSessionCount: sessionMod.getActiveSessionCount,
  setShuttingDown,
  sessions,
  notificationMetrics,
  taskSubscriptions,
  addSessionToTaskSubscriptions: sessionMod.addSessionToTaskSubscriptions,
  sendClientRequest,
  getSession: sessionMod.getSession,
};
