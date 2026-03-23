/**
 * TORQUE Dashboard Server
 *
 * HTTP + WebSocket server for the real-time dashboard.
 * Provides REST API for task management and WebSocket for live updates.
 *
 * Route handlers are in dashboard/routes/*.js, dispatched via dashboard/router.js.
 * Shared utilities (parseQuery, sendJson, etc.) are in dashboard/utils.js.
 *
 * AUTH MODEL:
 * - Dashboard port (3456): Binds to 127.0.0.1 only (see httpServer.listen below).
 *   No API key is required — localhost-only binding is the security boundary.
 *   This is intentional for single-user deployments where only the local user
 *   (or browser on the same machine) accesses the dashboard.
 * - API port (3457): Handled by api-server.core.js and uses API key authentication
 *   (Authorization: Bearer or X-API-Key header). Intended for programmatic access
 *   from external tools, CI, or other machines on the network.
 *
 * Do not expose port 3456 externally without adding authentication — it relies
 * entirely on network-level isolation (localhost binding + firewall).
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { execFile } = require('child_process');
const { WS_MSG_RATE_LIMIT, WS_MSG_RATE_WINDOW_MS } = require('./constants');
const { redactSecrets } = require('./utils/sanitize');
const db = require('./database');
const taskCore = require('./db/task-core');
const hostManagement = require('./db/host-management');
const serverConfig = require('./config');
const { dispatch } = require('./dashboard/router');
const { sendError } = require('./dashboard/utils');
const { dispatchV2, init: initV2Dispatch } = require('./api/v2-dispatch');
const eventBus = require('./event-bus');

// ============================================
// Auth handlers (dashboard port)
// ============================================

/**
 * POST /api/auth/login — validate API key and issue a session cookie.
 * Mirrors the handler in api-server.core.js, scoped to the dashboard port.
 */
async function handleAuthLogin(req, res) {
  const keyManager = require('./auth/key-manager');
  const sessionManager = require('./auth/session-manager');
  const { loginLimiter } = require('./auth/rate-limiter');
  const { parseBody } = require('./dashboard/utils');

  const ip = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';

  if (loginLimiter.isLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ error: 'Too many login attempts. Please try again later.' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { key, username, password } = body || {};

    // Open mode: no keys AND no users configured — auto-login as admin
    const { isOpenMode } = require('./auth/middleware');
    if (isOpenMode()) {
      const identity = { id: 'open-mode', name: 'Open Mode', role: 'admin', type: 'open' };
      const { sessionId, csrfToken } = sessionManager.createSession(identity);
      res.setHeader('Set-Cookie', [
        `torque_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
        `torque_csrf=${csrfToken}; SameSite=Strict; Path=/`,
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ success: true, role: identity.role, csrfToken }));
      return;
    }

    // Username/password login
    if (username && password) {
      const userManager = require('./auth/user-manager');
      const identity = await userManager.validatePassword(username, password);
      if (!identity) {
        loginLimiter.recordFailure(ip);
        res.writeHead(401, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: 'Invalid username or password' }));
        return;
      }
      const { sessionId, csrfToken } = sessionManager.createSession(identity);
      res.setHeader('Set-Cookie', [
        `torque_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
        `torque_csrf=${csrfToken}; SameSite=Strict; Path=/`,
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
      res.end(JSON.stringify({
        success: true,
        role: identity.role,
        csrfToken,
        user: { id: identity.id, username: identity.username, displayName: identity.name },
      }));
      return;
    }

    // API key login (existing flow — backward compat)
    if (!key) {
      loginLimiter.recordFailure(ip);
      res.writeHead(401, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: 'API key is required' }));
      return;
    }

    const identity = keyManager.validateKey(key);
    if (!identity) {
      loginLimiter.recordFailure(ip);
      res.writeHead(401, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: 'Invalid API key' }));
      return;
    }

    const { sessionId, csrfToken } = sessionManager.createSession(identity);
    res.setHeader('Set-Cookie', [
      `torque_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
      `torque_csrf=${csrfToken}; SameSite=Strict; Path=/`,
    ]);
    res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ success: true, role: identity.role, csrfToken }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ error: err.message }));
  }
}

/**
 * POST /api/auth/logout — destroy the session and clear cookies.
 */
function handleAuthLogout(req, res) {
  const sessionManager = require('./auth/session-manager');
  const { parseCookie } = require('./auth/middleware');

  const sessionId = parseCookie(req.headers?.cookie, 'torque_session');
  if (sessionId) {
    sessionManager.destroySession(sessionId);
  }

  res.setHeader('Set-Cookie', [
    'torque_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    'torque_csrf=; SameSite=Strict; Path=/; Max-Age=0',
  ]);
  res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify({ success: true }));
}

/**
 * GET /api/auth/status — returns 200 if authenticated or in open mode, 401 otherwise.
 * Used by the React app to determine whether to show the login screen on load.
 */
function handleAuthStatus(req, res) {
  const { isOpenMode } = require('./auth/middleware');
  const userManager = require('./auth/user-manager');

  // Open mode: no keys AND no users configured — everyone is authenticated
  if (isOpenMode()) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ authenticated: true, mode: 'open', needsSetup: false }));
    return;
  }

  const needsSetup = !userManager.hasAnyUsers();
  const { parseCookie } = require('./auth/middleware');
  const sessionManager = require('./auth/session-manager');
  const sessionId = parseCookie(req.headers?.cookie, 'torque_session');
  const session = sessionId ? sessionManager.getSession(sessionId) : null;

  if (session) {
    const identity = session.identity;
    const response = {
      authenticated: true,
      mode: 'authenticated',
      needsSetup: false,
      role: identity?.role,
      csrfToken: session.csrfToken,
    };
    if (identity?.type === 'user') {
      response.user = { id: identity.id, username: identity.username, displayName: identity.name, role: identity.role };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify(response));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ authenticated: false, needsSetup }));
  }
}

/**
 * POST /api/auth/setup — create the first admin user (setup wizard).
 * Only works when no users exist yet. Rate-limited.
 */
/**
 * PATCH /api/auth/me — update own password or display name.
 * Requires session cookie + CSRF token.
 */
async function handleAuthUpdateMe(req, res) {
  const userManager = require('./auth/user-manager');
  const sessionManager = require('./auth/session-manager');
  const { parseCookie } = require('./auth/middleware');
  const { parseBody } = require('./dashboard/utils');

  const sessionId = parseCookie(req.headers?.cookie, 'torque_session');
  const session = sessionId ? sessionManager.getSession(sessionId) : null;
  if (!session || !session.identity || session.identity.type !== 'user') {
    res.writeHead(401, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ error: 'Not authenticated as a user' }));
    return;
  }

  // CSRF check
  const csrfToken = req.headers?.['x-csrf-token'];
  if (!csrfToken || session.csrfToken !== csrfToken) {
    res.writeHead(403, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ error: 'Invalid CSRF token' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { currentPassword, newPassword, displayName } = body || {};
    const identity = session.identity;
    const updates = {};

    if (displayName !== undefined) updates.displayName = displayName;
    if (newPassword) {
      if (!currentPassword) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: 'Current password required to change password' }));
        return;
      }
      const valid = await userManager.validatePassword(identity.username, currentPassword);
      if (!valid) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: 'Current password is incorrect' }));
        return;
      }
      updates.password = newPassword;
    }

    if (Object.keys(updates).length > 0) {
      await userManager.updateUser(identity.id, updates);
    }
    const updated = userManager.getUserById(identity.id);
    res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ user: updated }));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleAuthSetup(req, res) {
  const userManager = require('./auth/user-manager');
  const sessionManager = require('./auth/session-manager');
  const { loginLimiter } = require('./auth/rate-limiter');
  const { parseBody } = require('./dashboard/utils');

  const ip = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  if (loginLimiter.isLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ error: 'Too many attempts. Try again later.' }));
    return;
  }

  if (userManager.hasAnyUsers()) {
    res.writeHead(403, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ error: 'Setup already completed — users exist' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { username, password, displayName } = body || {};
    const user = await userManager.createUser({ username, password, role: 'admin', displayName });

    const identity = { id: user.id, name: user.displayName || user.username, username: user.username, role: 'admin', type: 'user' };
    const { sessionId, csrfToken } = sessionManager.createSession(identity);
    res.setHeader('Set-Cookie', [
      `torque_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
      `torque_csrf=${csrfToken}; SameSite=Strict; Path=/`,
    ]);
    res.writeHead(201, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({
      success: true,
      role: 'admin',
      csrfToken,
      user: { id: user.id, username: user.username, displayName: user.displayName },
    }));
  } catch (err) {
    loginLimiter.recordFailure(ip);
    res.writeHead(400, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// Server state
let httpServer = null;
let wss = null;
let isRunning = false;
let serverPort = 3456;

/**
 * Standard security headers applied to all responses
 */
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  // RB-068: Content Security Policy — restrict resource origins to self
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:",
};

// Connected WebSocket clients
const clients = new Set();

// Per-IP WebSocket connection tracking
const _perIpWsCount = new Map();
const MAX_WS_PER_IP = 20;

// WebSocket topic subscriptions (topic -> Set of clients)
const topicSubscriptions = new Map();
const clientTopicSubscriptions = new Map();

const DEFAULT_WS_TOPICS = [
  'task:created',
  'tasks:batch-updated',
  'task:deleted',
  'stats:updated',
  'task:event',
  'hosts:activity-updated',
];

const STATIC_FILE_CACHE_MAX_BYTES = 1024 * 1024;
const staticFileCache = new Map();
const TASK_UPDATED_LISTENER_TAG = Symbol.for('torque.dashboardTaskUpdatedListener');
let taskUpdatedProcessListener = null;

function addTopicSubscription(topic, client) {
  if (!topic || !client) return;
  if (!topicSubscriptions.has(topic)) {
    topicSubscriptions.set(topic, new Set());
  }
  topicSubscriptions.get(topic).add(client);

  if (!clientTopicSubscriptions.has(client)) {
    clientTopicSubscriptions.set(client, new Set());
  }
  clientTopicSubscriptions.get(client).add(topic);
}

function removeTopicSubscription(topic, client) {
  if (!topic || !client) return;
  const subscribers = topicSubscriptions.get(topic);
  if (!subscribers) return;

  subscribers.delete(client);
  if (subscribers.size === 0) {
    topicSubscriptions.delete(topic);
  }

  const clientTopics = clientTopicSubscriptions.get(client);
  if (!clientTopics) return;
  clientTopics.delete(topic);
  if (clientTopics.size === 0) {
    clientTopicSubscriptions.delete(client);
  }
}

function collectTopicSubscribers(topics) {
  const subscribers = new Set();
  for (const topic of topics) {
    const topicClients = topicSubscriptions.get(topic);
    if (!topicClients) continue;
    for (const client of topicClients) {
      subscribers.add(client);
    }
  }
  return subscribers;
}

function sendToSubscribers(subscribers, message, options = {}) {
  const skipBackpressureCheck = options.skipBackpressureCheck || false;
  for (const client of subscribers) {
    if (client.readyState !== 1) {
      continue;
    }
    if (!skipBackpressureCheck && client.bufferedAmount > 65536) {
      continue;
    }
    try {
      client.send(message);
    } catch {
      // Client disconnected, will be cleaned up
    }
  }
}

function sendToTopics(topics, message, options = {}) {
  sendToSubscribers(collectTopicSubscribers(topics), message, options);
}

function removeStaleTaskUpdatedListeners() {
  for (const listener of eventBus.listeners('task-updated')) {
    if (listener && listener[TASK_UPDATED_LISTENER_TAG]) {
      eventBus.removeListener('task-updated', listener);
    }
  }
}

function installTaskUpdatedListener() {
  removeStaleTaskUpdatedListeners();
  if (taskUpdatedProcessListener) {
    eventBus.removeListener('task-updated', taskUpdatedProcessListener);
  }

  taskUpdatedProcessListener = (update) => {
    const taskId = update && typeof update === 'object' ? update.taskId : null;
    if (!taskId) return;
    notifyTaskUpdated(taskId);
  };
  taskUpdatedProcessListener[TASK_UPDATED_LISTENER_TAG] = true;
  eventBus.onTaskUpdated(taskUpdatedProcessListener);
}

function removeTaskUpdatedListener() {
  if (!taskUpdatedProcessListener) return;
  eventBus.removeListener('task-updated', taskUpdatedProcessListener);
  taskUpdatedProcessListener = null;
}

// Debouncing for task updates - prevents flooding with rapid updates
const pendingTaskUpdates = new Set();
let taskUpdateTimer = null;
const TASK_UPDATE_DEBOUNCE_MS = 500; // Batch updates every 500ms

// Throttling for stats updates
let lastStatsUpdate = 0;
const STATS_UPDATE_THROTTLE_MS = 2000; // Max once per 2 seconds
let pendingStatsUpdate = false;

/**
 * MIME types for static file serving
 */
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Serve static files from dashboard/dist
 * @param {http.IncomingMessage} req - The incoming HTTP request
 * @param {http.ServerResponse} res - The HTTP response object
 * @returns {void}
 */
function serveStatic(req, res) {
  // Try React build first, fall back to lightweight static dashboard
  const reactDir = path.join(__dirname, '..', 'dashboard', 'dist');
  const staticDir = path.join(__dirname, 'dashboard');
  const dashboardDir = fs.existsSync(reactDir) ? reactDir : staticDir;
  let filePath = path.join(dashboardDir, req.url === '/' ? 'index.html' : req.url.split('?')[0]);

  // Security: prevent directory traversal (use path.sep to avoid prefix bypass)
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(dashboardDir);
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(resolvedRoot + path.sep)) {
    sendError(res, 'Forbidden', 403);
    return;
  }

  // If file doesn't exist and it's not an API route, serve index.html (SPA routing)
  if (!fs.existsSync(filePath) && !req.url.startsWith('/api/')) {
    filePath = path.join(dashboardDir, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    sendError(res, 'Not found', 404);
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const cacheControl = filePath.endsWith('index.html')
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=31536000, immutable';

  const sendFile = (data, cacheControlValue, contentTypeValue) => {
    res.writeHead(200, {
      'Content-Type': contentTypeValue,
      'Cache-Control': cacheControlValue,
      ...SECURITY_HEADERS,
    });
    res.end(data);
  };

  const completeRead = (canCache, cacheMtime) => {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (canCache) {
          staticFileCache.delete(filePath);
        }
        sendError(res, 'Internal error', 500);
        return;
      }

      if (canCache && data.length <= STATIC_FILE_CACHE_MAX_BYTES) {
        staticFileCache.set(filePath, {
          content: data,
          contentType,
          mtimeMs: cacheMtime,
          size: data.length,
        });
        if (staticFileCache.size > 200) {
          const firstKey = staticFileCache.keys().next().value;
          staticFileCache.delete(firstKey);
        }
      } else {
        staticFileCache.delete(filePath);
      }

      sendFile(data, cacheControl, contentType);
    });
  };

  if (typeof fs.stat !== 'function') {
    completeRead(false, undefined);
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats) {
      completeRead(false, undefined);
      return;
    }

    const cacheMtime = Number(stats.mtimeMs);
    const canCache = typeof cacheMtime === 'number' && stats.size <= STATIC_FILE_CACHE_MAX_BYTES;
    const cached = canCache ? staticFileCache.get(filePath) : null;

    if (!canCache) {
      staticFileCache.delete(filePath);
      completeRead(false, undefined);
      return;
    }

    if (cached && cached.mtimeMs === cacheMtime && cached.contentType === contentType) {
      sendFile(cached.content, cacheControl, contentType);
      return;
    }

    completeRead(true, cacheMtime);
  });
}

// ============================================
// Broadcast & WebSocket
// ============================================

/**
 * Broadcast task update to all connected clients (debounced).
 * Batches updates to prevent flooding with rapid changes.
 */
function broadcastTaskUpdate(taskId) {
  // Add to pending updates (emergency valve: clear if set grows unbounded)
  if (pendingTaskUpdates.size > 1000) pendingTaskUpdates.clear();
  pendingTaskUpdates.add(taskId);

  // If no timer running, start one
  if (!taskUpdateTimer) {
    taskUpdateTimer = setTimeout(flushTaskUpdates, TASK_UPDATE_DEBOUNCE_MS);
  }
}

/**
 * Flush all pending task updates
 */
function flushTaskUpdates() {
  taskUpdateTimer = null;

  if (pendingTaskUpdates.size === 0) return;
  if (clients.size === 0) {
    pendingTaskUpdates.clear();
    return;
  }

  // RB-092: Send minimal delta payloads instead of full task rows
  // TDA-07/TDA-08: Include provider/model/host so placement changes propagate live
  const DELTA_FIELDS = ['id', 'status', 'progress_percent', 'exit_code', 'completed_at', 'started_at', 'output', 'error_output', 'provider', 'model', 'ollama_host_id'];
  const updates = [];
  for (const taskId of pendingTaskUpdates) {
    const task = taskCore.getTask(taskId);
    if (task) {
      // Only include essential fields for delta update
      const delta = {};
      for (const field of DELTA_FIELDS) {
        if (task[field] !== undefined) delta[field] = task[field];
      }
      // Truncate large output fields for WS broadcast
      if (delta.output && delta.output.length > 2000) {
        delta.output = delta.output.slice(-2000);
        delta.output_truncated = true;
      }
      if (delta.error_output && delta.error_output.length > 2000) {
        delta.error_output = delta.error_output.slice(-2000);
        delta.error_output_truncated = true;
      }
      // SECURITY: redact secrets before broadcasting to WS clients
      if (delta.output) { delta.output = redactSecrets(delta.output); }
      if (delta.error_output) { delta.error_output = redactSecrets(delta.error_output); }
      updates.push(delta);
    }
  }
  pendingTaskUpdates.clear();

  if (updates.length === 0) return;

  const message = JSON.stringify({
    event: 'tasks:batch-updated',
    data: updates,
  });

  const topics = new Set(['tasks:batch-updated']);
  for (const update of updates) {
    topics.add(`task:${update.id}`);
  }
  const recipients = collectTopicSubscribers(topics);
  if (recipients.size > 0) {
    sendToSubscribers(recipients, message);
  }

  scheduleStatsUpdate();
}

/**
 * Schedule a stats update (throttled)
 */
function scheduleStatsUpdate() {
  const now = Date.now();
  if (now - lastStatsUpdate < STATS_UPDATE_THROTTLE_MS) {
    // Too soon, mark as pending
    if (!pendingStatsUpdate) {
      pendingStatsUpdate = true;
      setTimeout(() => {
        pendingStatsUpdate = false;
        broadcastStatsUpdateNow();
      }, STATS_UPDATE_THROTTLE_MS - (now - lastStatsUpdate));
    }
    return;
  }
  broadcastStatsUpdateNow();
}

/**
 * Immediately broadcast stats update
 */
function broadcastStatsUpdateNow() {
  lastStatsUpdate = Date.now();

  if (clients.size === 0) return;

  const allCounts = typeof taskCore.countTasksByStatus === 'function'
    ? taskCore.countTasksByStatus()
    : {
      running: taskCore.countTasks({ status: 'running' }),
      queued: taskCore.countTasks({ status: 'queued' }),
      completed: taskCore.countTasks({ status: 'completed' }),
      failed: taskCore.countTasks({ status: 'failed' }),
    };
  const stats = {
    running: allCounts.running,
    queued: allCounts.queued,
    completed: allCounts.completed,
    failed: allCounts.failed,
  };

  const message = JSON.stringify({
    event: 'stats:updated',
    data: stats,
  });

  sendToTopics(['stats:updated'], message, { skipBackpressureCheck: true });
}

/**
 * Broadcast new task output to subscribed clients
 */
function broadcastTaskOutput(taskId, chunk) {
  const taskTopic = `task:${taskId}`;
  const subscribers = collectTopicSubscribers([taskTopic, 'task:output']);
  if (subscribers.size === 0) return;

  const message = JSON.stringify({
    event: 'task:output',
    data: { taskId, chunk },
  });

  sendToSubscribers(subscribers, message, { skipBackpressureCheck: true });
}

/**
 * Broadcast stats update (called periodically - now just schedules throttled update)
 */
function broadcastStatsUpdate() {
  scheduleStatsUpdate();
}

/**
 * Handle WebSocket connection
 */
const MAX_WS_CONNECTIONS = 100;

function handleWebSocket(ws) {
  if (clients.size >= MAX_WS_CONNECTIONS) {
    ws.close(1013, 'Too many connections');
    return;
  }

  const wsIp = ws._socket?.remoteAddress || 'unknown';
  const currentIpWsCount = _perIpWsCount.get(wsIp) || 0;
  if (currentIpWsCount >= MAX_WS_PER_IP) {
    ws.close(1013, 'Too many connections from this IP');
    return;
  }
  _perIpWsCount.set(wsIp, currentIpWsCount + 1);

  clients.add(ws);

  // Send initial connection success with instance identity
  const taskManager = require('./task-manager');
  const instanceId = taskManager.getMcpInstanceId();
  ws.send(JSON.stringify({
    event: 'connected',
    data: {
      clients: clients.size,
      instanceId,
      shortId: instanceId.slice(-6),
      port: serverPort
    }
  }));

  for (const topic of DEFAULT_WS_TOPICS) {
    addTopicSubscription(topic, ws);
  }

  // RB-055: Per-connection message rate limiting
  const msgTimestamps = [];
  let msgTimestampHead = 0;

  const sanitizeMessage = (message) => {
    if (!message || typeof message !== 'object') return [];
    const topics = [];

    if (message.taskId) {
      topics.push(`task:${message.taskId}`);
    }
    if (message.topic) {
      topics.push(message.topic);
    }
    if (message.eventType) {
      topics.push(message.eventType);
    }

    return topics;
  };

  ws.on('message', (data) => {
    // Rate limit incoming messages
    const now = Date.now();
    while (msgTimestampHead < msgTimestamps.length && msgTimestamps[msgTimestampHead] < now - WS_MSG_RATE_WINDOW_MS) {
      msgTimestampHead += 1;
    }

    const activeMessageCount = msgTimestamps.length - msgTimestampHead;
    // Compact once 64 expired entries accumulate (instead of 128) to keep array smaller
    if (msgTimestampHead > 64) {
      msgTimestamps.splice(0, msgTimestampHead);
      msgTimestampHead = 0;
    }

    if (activeMessageCount >= WS_MSG_RATE_LIMIT) {
      ws.send(JSON.stringify({ event: 'error', data: { message: 'Rate limit exceeded, slow down' } }));
      return;
    }
    msgTimestamps.push(now);

      try {
        const message = JSON.parse(data.toString());
        const topics = sanitizeMessage(message);

        switch (message.event) {
          case 'subscribe':
            // Subscribe to a topic (task ID or event type)
            for (const topic of topics) {
              addTopicSubscription(topic, ws);
            }
            if (topics.length === 0) {
              ws.send(JSON.stringify({ event: 'error', data: { message: 'Invalid subscription payload' } }));
            }
            break;

          case 'unsubscribe':
            // Unsubscribe from a topic (task ID or event type)
            for (const topic of topics) {
              removeTopicSubscription(topic, ws);
            }
            break;
        }
    } catch {
      // Ignore invalid messages
    }
  });

  function removeClient(ws) {
    clients.delete(ws);
    // Decrement per-IP WebSocket counter
    const closedIp = ws._socket?.remoteAddress || wsIp;
    const ipWsCount = _perIpWsCount.get(closedIp) || 1;
    if (ipWsCount <= 1) _perIpWsCount.delete(closedIp);
    else _perIpWsCount.set(closedIp, ipWsCount - 1);
    // Remove from all topic subscriptions and prune empty sets
    const clientTopics = clientTopicSubscriptions.get(ws);
    if (clientTopics) {
      for (const topic of clientTopics) {
        const subscribers = topicSubscriptions.get(topic);
        if (subscribers) {
          subscribers.delete(ws);
          if (subscribers.size === 0) {
            topicSubscriptions.delete(topic);
          }
        }
      }
      clientTopicSubscriptions.delete(ws);
    }
  }

  ws.on('close', () => {
    removeClient(ws);
  });

  ws.on('error', (err) => {
    process.stderr.write(`WebSocket error: ${err.message}\n`);
    removeClient(ws);
  });
}

// ============================================
// Browser / Port helpers
// ============================================

/**
 * Open URL in default browser (cross-platform).
 * Uses execFile for security (no shell injection risk).
 */
function openBrowser(url) {
  const platform = process.platform;

  let command;
  let args;

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    // Linux and others
    command = 'xdg-open';
    args = [url];
  }

  execFile(command, args, (err) => {
    if (err) {
      process.stderr.write(`Failed to open browser: ${err.message}\n`);
    }
  });
}

/**
 * Check if a port is available
 */
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const tester = net.createServer()
      .once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          resolve(false); // Treat other errors as unavailable too
        }
      })
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port, '127.0.0.1');
  });
}

// ============================================
// Server lifecycle
// ============================================

/**
 * Start the dashboard server
 */
async function start(options = {}) {
  if (isRunning) {
    return { success: false, error: 'Dashboard already running', url: `http://127.0.0.1:${serverPort}` };
  }

  const basePort = options.port || serverConfig.getInt('dashboard_port', 3456);
  const openInBrowser = options.openBrowser !== false;
  const MAX_PORT_ATTEMPTS = 5;

  // Try base port first, then auto-increment up to MAX_PORT_ATTEMPTS
  // Multiple Claude Code sessions can each get their own dashboard instance
  let foundPort = null;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const candidatePort = basePort + attempt;
    const portAvailable = await checkPortAvailable(candidatePort);
    if (portAvailable) {
      foundPort = candidatePort;
      break;
    }
    if (attempt === 0) {
      process.stderr.write(`Dashboard port ${candidatePort} is in use, trying next ports...\n`);
    }
  }

  if (foundPort === null) {
    process.stderr.write(
      `\nDashboard ports ${basePort}-${basePort + MAX_PORT_ATTEMPTS - 1} all in use. Dashboard disabled.\n\n` +
      `Options:\n` +
      `  1. Stop existing TORQUE: bash stop-torque.sh\n` +
      `  2. Use different base port: TORQUE_DASHBOARD_PORT=${basePort + MAX_PORT_ATTEMPTS} torque start\n` +
      `  3. Find what's using them: lsof -i :${basePort} (Linux/Mac) or netstat -ano | findstr :${basePort} (Windows)\n\n`
    );
    return {
      success: false,
      error: `Ports ${basePort}-${basePort + MAX_PORT_ATTEMPTS - 1} all in use`,
      url: `http://127.0.0.1:${basePort}` // Existing dashboard might still work
    };
  }

  serverPort = foundPort;

  // Initialize v2 dispatch with task manager (enables v2 task operations on dashboard port)
  if (options.taskManager) {
    initV2Dispatch(options.taskManager);
  }
  installTaskUpdatedListener();

  // Context object passed to route handlers that need server state
  const routeContext = {
    broadcastTaskUpdate,
    clients,
    serverPort,
  };

  // Create HTTP server
  httpServer = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];

    // Auth routes — handled directly here so they're available on the dashboard port
    if (urlPath === '/api/auth/login' && req.method === 'POST') {
      handleAuthLogin(req, res);
      return;
    }
    if (urlPath === '/api/auth/logout' && req.method === 'POST') {
      handleAuthLogout(req, res);
      return;
    }
    if (urlPath === '/api/auth/status' && req.method === 'GET') {
      handleAuthStatus(req, res);
      return;
    }
    if (urlPath === '/api/auth/setup' && req.method === 'POST') {
      handleAuthSetup(req, res);
      return;
    }
    if (urlPath === '/api/auth/me' && req.method === 'PATCH') {
      handleAuthUpdateMe(req, res);
      return;
    }

    // Cookie auth check for all other API requests
    if (urlPath.startsWith('/api/')) {
      const { isOpenMode: isOpen } = require('./auth/middleware');
      // In open mode (no keys AND no users configured), allow everything through
      if (!isOpen()) {
        const { parseCookie } = require('./auth/middleware');
        const sessionManager = require('./auth/session-manager');
        const sessionId = parseCookie(req.headers?.cookie, 'torque_session');
        const session = sessionId ? sessionManager.getSession(sessionId) : null;
        if (!session) {
          res.writeHead(401, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        // For mutating requests, validate CSRF token
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
          const csrfToken = req.headers?.['x-csrf-token'];
          if (!csrfToken || session.csrfToken !== csrfToken) {
            res.writeHead(403, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
            res.end(JSON.stringify({ error: 'Invalid CSRF token' }));
            return;
          }
        }
      }
    }

    if (urlPath.startsWith('/api/v2/')) {
      // V2 control-plane routes — served directly from v2 handler modules
      dispatchV2(req, res).then(handled => {
        if (!handled) {
          // No v2 route matched — fall through to legacy dashboard router
          dispatch(req, res, routeContext).catch(err => {
            process.stderr.write(`Unhandled API error: ${err.message}\n`);
            if (!res.headersSent) {
              sendError(res, 'Internal server error', 500);
            }
          });
        }
      }).catch(err => {
        process.stderr.write(`V2 dispatch error: ${err.message}\n`);
        if (!res.headersSent) {
          sendError(res, 'Internal server error', 500);
        }
      });
    } else if (urlPath.startsWith('/api/')) {
      dispatch(req, res, routeContext).catch(err => {
        process.stderr.write(`Unhandled API error: ${err.message}\n`);
        if (!res.headersSent) {
          sendError(res, 'Internal server error', 500);
        }
      });
    } else {
      serveStatic(req, res);
    }
  });

  // Create WebSocket server
  wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', handleWebSocket);

  // Start listening
  httpServer.listen(serverPort, '127.0.0.1', () => {
    isRunning = true;
    process.stderr.write(`Dashboard running at http://127.0.0.1:${serverPort}\n`);

    if (openInBrowser) {
      openBrowser(`http://127.0.0.1:${serverPort}`);
    }
  });

  httpServer.on('error', (err) => {
    process.stderr.write(`Dashboard server error: ${err.message}\n`);
    isRunning = false;
  });

  // Periodic stats broadcast (60 seconds - main updates come from task changes)
  const statsInterval = setInterval(() => {
    if (isRunning) {
      broadcastStatsUpdate();
    }
  }, 60000);

  // Store interval for cleanup
  httpServer.statsInterval = statsInterval;

  return {
    success: true,
    url: `http://127.0.0.1:${serverPort}`,
    port: serverPort,
  };
}

/**
 * Stop the dashboard server
 */
function stop() {
  if (!isRunning) {
    return { success: false, error: 'Dashboard not running' };
  }

  // Clear stats interval
  if (httpServer.statsInterval) {
    clearInterval(httpServer.statsInterval);
  }

  // Clear debounce/throttle timers to prevent post-stop firing
  if (taskUpdateTimer) { clearTimeout(taskUpdateTimer); taskUpdateTimer = null; }
  pendingTaskUpdates.clear();
  pendingStatsUpdate = false;

  // Close all WebSocket connections
  for (const client of clients) {
    client.close();
  }
  clients.clear();
  topicSubscriptions.clear();
  clientTopicSubscriptions.clear();
  staticFileCache.clear();
  removeTaskUpdatedListener();

  // Close servers
  if (wss) {
    wss.close();
    wss = null;
  }

  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }

  isRunning = false;
  process.stderr.write('Dashboard stopped\n');

  return { success: true };
}

/**
 * Check if dashboard is running
 */
function getStatus() {
  return {
    running: isRunning,
    port: isRunning ? serverPort : null,
    url: isRunning ? `http://127.0.0.1:${serverPort}` : null,
    clients: clients.size,
  };
}

// ============================================
// Notify functions (called from task-manager)
// ============================================

function notifyTaskCreated(task) {
  if (!isRunning) return;

  const message = JSON.stringify({
    event: 'task:created',
    data: task,
  });

  sendToTopics(['task:created'], message, { skipBackpressureCheck: true });
}

function notifyTaskUpdated(taskId) {
  if (!isRunning) return;
  broadcastTaskUpdate(taskId);
}

function notifyTaskOutput(taskId, chunk) {
  if (!isRunning) return;
  broadcastTaskOutput(taskId, chunk);
}

function notifyTaskDeleted(taskId) {
  if (!isRunning) return;

  const message = JSON.stringify({
    event: 'task:deleted',
    data: { taskId },
  });

  sendToTopics(['task:deleted'], message, { skipBackpressureCheck: true });
}

/**
 * Notify all connected WebSocket clients of updated host GPU/model activity
 */
function notifyHostActivityUpdated() {
  if (!isRunning || clients.size === 0) return;
  const taskManager = require('./task-manager');
  const hostActivity = taskManager.getHostActivity();

  // Merge memory_limit_mb so dashboard can show VRAM bars for remote hosts
  try {
    const allHosts = hostManagement.listOllamaHosts({ enabled: true });
    for (const host of (allHosts || [])) {
      if (hostActivity[host.id]) {
        hostActivity[host.id].memoryLimitMb = host.memory_limit_mb || 0;
      }
    }
  } catch { /* best-effort */ }

  const runningTasks = taskCore.listTasks({ status: 'running', limit: 100 });
  const taskList = runningTasks.tasks || runningTasks;
  const taskGpuStatus = {};
  for (const t of (Array.isArray(taskList) ? taskList : [])) {
    if (t.ollama_host_id) {
      taskGpuStatus[t.id] = taskManager.isModelLoadedOnHost(t.ollama_host_id, t.model);
    }
  }
  const message = JSON.stringify({
    event: 'hosts:activity-updated',
    data: { hosts: hostActivity, taskGpuStatus }
  });
  sendToTopics(['hosts:activity-updated'], message, { skipBackpressureCheck: true });
}

/**
 * Notify all connected WebSocket clients of a task event (for live event feed).
 */
function notifyTaskEvent(eventData) {
  if (!isRunning || clients.size === 0) return;

  const message = JSON.stringify({
    event: 'task:event',
    data: eventData,
  });

  sendToTopics(['task:event'], message, { skipBackpressureCheck: true });
}

module.exports = {
  start,
  stop,
  getStatus,
  notifyTaskCreated,
  notifyTaskUpdated,
  notifyTaskOutput,
  notifyTaskDeleted,
  notifyHostActivityUpdated,
  notifyTaskEvent,
};

// CLI entry point - run directly with: node dashboard-server.js
if (require.main === module) {
  // Initialize database when running standalone
  db.init();

  const port = parseInt(process.env.PORT, 10) || 3456;
  console.log(`Starting dashboard on port ${port}...`);
  start({ port, openBrowser: false });

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('\nShutting down dashboard...');
    stop();
    process.exit(0);
  });
}
