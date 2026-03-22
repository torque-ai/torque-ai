/**
 * TORQUE MCP SSE Transport
 *
 * Provides MCP protocol over Server-Sent Events (SSE) instead of stdio.
 * SSE connections survive Claude Code context rollovers because they use
 * HTTP networking rather than process pipes.
 *
 * Protocol:
 *   GET  /sse              → Establishes SSE stream, sends endpoint event
 *   POST /messages?sessionId=xxx → Receives JSON-RPC requests, responds via SSE
 */

const http = require('http');
const { randomUUID } = require('crypto');
const { TOOLS, handleToolCall } = require('./tools');
const db = require('./database');
const serverConfig = require('./config');
const logger = require('./logger').child({ component: 'mcp-sse' });
const { validateJsonRpcRequest } = require('./utils/jsonrpc-validation');
const mcpProtocol = require('./mcp-protocol');

const JSONRPC_VERSION = '2.0';
const KEEPALIVE_INTERVAL_MS = 30000; // 30 seconds
const MAX_PENDING_EVENTS = 100;
const CHECK_NOTIFICATIONS_MIN_INTERVAL_MS = 1000; // 1s minimum between check_notifications calls
const DEDUP_WINDOW_MS = 5000; // 5s window: replace existing event for same task instead of queuing duplicate

// Event priority for eviction — higher number = higher priority (kept longer under MAX_PENDING_EVENTS)
// When the queue is full, lowest-priority events are evicted first.
// task_failed > task_completed: failures are more actionable and must not be silently dropped.
const EVENT_PRIORITY = {
  failed: 10,
  task_failed: 10,
  completed: 5,
  task_completed: 5,
  cancelled: 3,
  retry: 2,
  batch_summary: 1,
};
const DEFAULT_EVENT_PRIORITY = 5;
const DEFAULT_NOTIFICATION_TEMPLATE = '[TORQUE] Task {taskId} {status}{ (}{duration}s{)}{ : }{description}';
const EVENT_AGGREGATION_WINDOW_MS = 10000; // 10s window for grouping rapid-fire events
const MAX_SSE_SESSIONS = 50;

// Per-IP session tracking for connection limiting
const _perIpSessionCount = new Map();
const MAX_SESSIONS_PER_IP = 10;

function getAllowedOrigins() {
  if (process.env.MCP_ALLOWED_ORIGINS) {
    return parseAllowedOrigins(process.env.MCP_ALLOWED_ORIGINS);
  }
  // Dynamic: derive from configured dashboard port so the dashboard always works
  const dashboardPort = serverConfig ? serverConfig.getInt('dashboard_port', 3456) : 3456;
  return new Set([
    `http://127.0.0.1:${dashboardPort}`,
    `http://localhost:${dashboardPort}`,
  ]);
}

// Abort controller — fires on server shutdown so blocking handlers (await_task, await_workflow) can return early
let shutdownAbort = new AbortController();

// Monotonic event counter for SSE event IDs (enables replay on reconnect)
let eventIdCounter = 0;

// Monotonic sequence counter for structured notification events.
// Each pendingEvent gets a unique sequence number so consumers can detect gaps
// and distinguish two separate 'completed' events for the same task.
// Distinct from eventIdCounter (which tracks SSE wire-protocol event IDs).
let _notificationSequence = 0;

// Notification delivery metrics — intentionally cumulative over server lifetime.
// Counters are monotonically increasing integers exposed via /telemetry for
// operational dashboards. They will not overflow Number.MAX_SAFE_INTEGER in
// practice (would require ~9 quadrillion deliveries). No periodic reset needed.
const notificationMetrics = {
  totalDelivered: 0,
  totalDeduplicated: 0,
  totalDroppedDisconnected: 0,
  totalDroppedFiltered: 0,
  totalAcknowledged: 0,
  deliveryErrors: 0,
  lastDeliveryAt: null,
  deadSessionsCleaned: 0,
};

// Single source of truth — shared with index.js
const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('./core-tools');
const eventBus = require('./event-bus');

let sseServer = null;
let ssePort = 3458;
let shuttingDown = false;
const TRACKED_INTERVALS = new Set();
const ALL_TASKS_SUBSCRIPTION_KEY = '__all_tasks__';

/**
 * Standard security headers applied to all responses
 */
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
};

// Active SSE sessions: sessionId → { res, toolMode, keepaliveTimer, pendingEvents, eventFilter, taskFilter }
const sessions = new Map();
// taskSubscriptions: taskId → Set<sessionId>, with ALL_TASKS_SUBSCRIPTION_KEY for sessions with empty taskFilter
const taskSubscriptions = new Map();

// ── Pending server→client requests (elicitation, sampling) ──
// Per-session Map: requestId → { resolve, timeout }
// Each session gets its own pendingRequests Map on first use.

const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Send a JSON-RPC request TO the client and wait for response.
 * @param {string} sessionId
 * @param {string} method - e.g., 'elicitation/create'
 * @param {object} params
 * @param {number} [timeoutMs=ELICITATION_TIMEOUT_MS]
 * @returns {Promise<object>} The client's response result
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

    // Send JSON-RPC request via SSE
    const request = { jsonrpc: JSONRPC_VERSION, id: requestId, method, params: params || {} };
    sendSseEvent(session, 'message', JSON.stringify(request));
  });
}

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

function normalizeTaskId(taskId) {
  if (taskId == null) return null;
  const normalized = String(taskId).trim();
  return normalized.length > 0 ? normalized : null;
}

function getTaskSubscriptionKeys(taskFilter) {
  if (!taskFilter || taskFilter.size === 0) {
    return [ALL_TASKS_SUBSCRIPTION_KEY];
  }

  const keys = [];
  for (const rawTaskId of taskFilter) {
    const key = normalizeTaskId(rawTaskId);
    if (key !== null) keys.push(key);
  }

  return keys.length > 0 ? keys : [ALL_TASKS_SUBSCRIPTION_KEY];
}

function addSessionToTaskSubscription(taskId, sessionId) {
  let set = taskSubscriptions.get(taskId);
  if (!set) {
    set = new Set();
    taskSubscriptions.set(taskId, set);
  }
  set.add(sessionId);
}

function removeSessionFromTaskSubscription(taskId, sessionId) {
  const set = taskSubscriptions.get(taskId);
  if (!set) return;

  set.delete(sessionId);
  if (set.size === 0) {
    taskSubscriptions.delete(taskId);
  }
}

function updateTaskFilterSubscriptions(sessionId, previousTaskFilter, nextTaskFilter) {
  const previousKeys = new Set(getTaskSubscriptionKeys(previousTaskFilter));
  const nextKeys = new Set(getTaskSubscriptionKeys(nextTaskFilter));

  for (const taskId of previousKeys) {
    if (!nextKeys.has(taskId)) {
      removeSessionFromTaskSubscription(taskId, sessionId);
    }
  }

  for (const taskId of nextKeys) {
    if (!previousKeys.has(taskId)) {
      addSessionToTaskSubscription(taskId, sessionId);
    }
  }
}

function addSessionToTaskSubscriptions(sessionId, taskFilter) {
  const keys = getTaskSubscriptionKeys(taskFilter);
  for (const taskId of keys) {
    addSessionToTaskSubscription(taskId, sessionId);
  }
}

function removeSessionFromTaskSubscriptions(sessionId, taskFilter) {
  const keys = getTaskSubscriptionKeys(taskFilter);
  for (const taskId of keys) {
    removeSessionFromTaskSubscription(taskId, sessionId);
  }
}

function purgeSessionFromTaskSubscriptions(sessionId) {
  for (const [taskId, set] of taskSubscriptions) {
    set.delete(sessionId);
    if (set.size === 0) {
      taskSubscriptions.delete(taskId);
    }
  }
}

function normalizeSubscriptionTaskIds(taskIds) {
  if (!Array.isArray(taskIds)) {
    return [];
  }

  const normalizedTaskIds = [];
  const seen = new Set();
  for (const rawTaskId of taskIds) {
    const taskId = normalizeTaskId(rawTaskId);
    if (!taskId || seen.has(taskId)) {
      continue;
    }
    seen.add(taskId);
    normalizedTaskIds.push(taskId);
  }

  return normalizedTaskIds;
}

function buildSubscriptionTargetFromResult(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const explicitTarget = (result.subscription_target && typeof result.subscription_target === 'object')
    ? result.subscription_target
    : null;

  const workflowId = normalizeTaskId(
    explicitTarget?.workflow_id
    || result.workflow_id
    || result.__subscribe_workflow_id
    || null,
  );

  let taskIds = normalizeSubscriptionTaskIds(explicitTarget?.task_ids);

  if (taskIds.length === 0) {
    taskIds = normalizeSubscriptionTaskIds(result.__subscribe_task_ids);
  }

  if (taskIds.length === 0 && result.__subscribe_task_id) {
    taskIds = normalizeSubscriptionTaskIds([result.__subscribe_task_id]);
  }

  if (taskIds.length === 0 && workflowId && typeof db.getWorkflowTasks === 'function') {
    const workflowTaskIds = db.getWorkflowTasks(workflowId) || [];
    taskIds = normalizeSubscriptionTaskIds(workflowTaskIds.map(task => task && task.id));
  }

  if (!explicitTarget && !workflowId && taskIds.length === 0) {
    return null;
  }

  return {
    kind: explicitTarget?.kind || (workflowId ? 'workflow' : 'task'),
    workflow_id: workflowId,
    task_id: explicitTarget?.task_id || (workflowId ? null : (taskIds[0] || null)),
    task_ids: taskIds,
    subscribe_tool: explicitTarget?.subscribe_tool || 'subscribe_task_events',
    subscribe_args: explicitTarget?.subscribe_args || { task_ids: taskIds },
  };
}

function applySubscriptionTargetToSession(session, subscriptionTarget) {
  if (!session || !subscriptionTarget || !Array.isArray(subscriptionTarget.task_ids) || subscriptionTarget.task_ids.length === 0) {
    return;
  }

  const previousTaskFilter = new Set(session.taskFilter);
  const newIds = subscriptionTarget.task_ids.filter(id => !session.taskFilter.has(id));
  if (session.taskFilter.size + newIds.length > MAX_SUBSCRIPTIONS_PER_SESSION) {
    // Silently cap — auto-subscribe is best-effort, don't fail the task submission
    return;
  }
  for (const taskId of newIds) {
    session.taskFilter.add(taskId);
  }
  updateTaskFilterSubscriptions(session._sessionId, previousTaskFilter, session.taskFilter);
}

function mergeSubscriptionTargetIntoResult(result, subscriptionTarget) {
  if (!result || typeof result !== 'object' || !subscriptionTarget) {
    return result;
  }

  return {
    ...result,
    workflow_id: result.workflow_id || subscriptionTarget.workflow_id || null,
    task_id: result.task_id || subscriptionTarget.task_id || null,
    task_ids: Array.isArray(result.task_ids) && result.task_ids.length > 0
      ? result.task_ids
      : subscriptionTarget.task_ids,
    subscription_target: subscriptionTarget,
  };
}

// ──────────────────────────────────────────────────────────────
// SSE-only tools — only available via SSE transport (not stdio)
// ──────────────────────────────────────────────────────────────

const SSE_TOOLS = [
  {
    name: 'subscribe_task_events',
    description: 'Subscribe this session to task completion/failure notifications. Events are pushed as MCP log messages and queued for check_notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs to watch (empty or omitted = all tasks)',
        },
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'Event types: completed, failed, cancelled, retry (default: completed, failed)',
        },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only receive events for these projects (empty = all projects)',
        },
        providers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only receive events from these providers (empty = all providers)',
        },
      },
    },
  },
  {
    name: 'check_notifications',
    description: 'Return and clear pending task notifications for this session. Call after receiving a push notification, or poll periodically.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ack_notification',
    description: 'Acknowledge specific notifications without clearing the entire queue. Remove events by task ID or by index.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Remove all pending events for these task IDs',
        },
        indices: {
          type: 'array',
          items: { type: 'number' },
          description: 'Remove events at these 0-based indices in the pending queue',
        },
      },
    },
  },
];

const SSE_TOOL_NAMES = new Set(SSE_TOOLS.map(t => t.name));

// ──────────────────────────────────────────────────────────────
// Core helpers
// ──────────────────────────────────────────────────────────────

/**
 * Write debug output through the structured logger.
 */
function debugLog(message, data = {}) {
  logger.debug(message, data);
}

/**
 * Generate a unique session ID.
 */
function generateSessionId() {
  return randomUUID();
}

/**
 * Parse allowed MCP SSE CORS origins from config string.
 */
function parseAllowedOrigins(rawOrigins) {
  if (typeof rawOrigins !== 'string') {
    return new Set();
  }

  const parsed = rawOrigins
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return new Set(parsed);
}

/**
 * Return request origin if it is allow-listed for MCP CORS.
 */
function resolveMcpAllowedOrigin(requestOrigin) {
  if (typeof requestOrigin !== 'string') return null;
  const normalized = requestOrigin.trim();
  return getAllowedOrigins().has(normalized) ? normalized : null;
}

/**
 * Basic session ownership check to avoid session id theft.
 */
function isSessionOwner(session, req) {
  const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress;

  if (session._origin && req.headers.origin && session._origin !== req.headers.origin) {
    return false;
  }

  if (session._remoteAddress && remoteAddress && session._remoteAddress !== remoteAddress) {
    return false;
  }

  return true;
}

/**
 * Resolve a request ID from incoming headers or generate a new one.
 */
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
 * @param {http.ServerResponse|object} res - SSE response stream or session object.
 * @param {string} event - SSE event name.
 * @param {string} data - Raw data string to send.
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

  const eventId = ++eventIdCounter;
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

/**
 * Render a notification message from a template string.
 * Tokens: {taskId}, {status}, {duration}, {project}, {exitCode}, {description}
 * Conditional blocks: { (}{duration}s{)} — only included when the token has a value.
 */
function renderNotificationTemplate(template, data) {
  // Replace conditional blocks: { prefix}{token}{suffix} — omitted if token is null/undefined
  let result = template.replace(/\{([^}]*)\}\{(\w+)\}\{([^}]*)\}/g, (match, prefix, token, suffix) => {
    const value = data[token];
    if (value == null || value === '') return '';
    return `${prefix}${value}${suffix}`;
  });

  // Replace remaining simple tokens
  result = result.replace(/\{(\w+)\}/g, (match, token) => {
    const value = data[token];
    return value != null ? String(value) : '';
  });

  return result.trim();
}

// ──────────────────────────────────────────────────────────────
// Push notification infrastructure
// ──────────────────────────────────────────────────────────────

/**
 * Notify all subscribed SSE sessions about a task event.
 *
 * For each session:
 * 1. Check eventFilter matches eventName (or '*')
 * 2. Check taskFilter is empty (all tasks) or contains taskData.taskId
 * 3. Push MCP log notification (notifications/message — human-visible)
 * 4. Queue structured event in pendingEvents (for check_notifications)
 *
 * @param {string} eventName - Event type: 'completed', 'failed', 'cancelled', etc.
 * @param {object} taskData - Structured event payload.
 */
function notifySubscribedSessions(eventName, taskData) {
  const deadSessions = [];
  const taskId = normalizeTaskId(taskData && taskData.taskId);
  const subscriberSessionIds = new Set();

  if (taskId) {
    const specificSubscribers = taskSubscriptions.get(taskId);
    if (specificSubscribers) {
      for (const sessionId of specificSubscribers) {
        subscriberSessionIds.add(sessionId);
      }
    }
  }
  const allSubscribers = taskSubscriptions.get(ALL_TASKS_SUBSCRIPTION_KEY);
  if (allSubscribers) {
    for (const sessionId of allSubscribers) {
      subscriberSessionIds.add(sessionId);
    }
  }

  // Fallback: if no task subscriptions registered at all, broadcast to all sessions (legacy/test compat)
  if (subscriberSessionIds.size === 0 && taskSubscriptions.size === 0) {
    for (const sessionId of sessions.keys()) {
      subscriberSessionIds.add(sessionId);
    }
  }

  let template = DEFAULT_NOTIFICATION_TEMPLATE;
  try { template = serverConfig.get('notification_template') || template; } catch {}
  let serializedNotificationPayload;
  try {
    const logMessage = renderNotificationTemplate(template, {
      taskId,
      status: eventName,
      duration: taskData.duration,
      project: taskData.project,
      exitCode: taskData.exitCode,
      description: taskData.description ? taskData.description.slice(0, 80) : null,
    });
    serializedNotificationPayload = JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/message',
      params: {
        level: 'info',
        logger: 'torque',
        data: logMessage,
      },
    });
  } catch {
    serializedNotificationPayload = null;
  }

  for (const sessionId of subscriberSessionIds) {
    const session = sessions.get(sessionId);
    if (!session) {
      deadSessions.push(sessionId);
      continue;
    }

    // Skip and track disconnected sessions for cleanup
    if (session.res.writableEnded) {
      deadSessions.push(sessionId);
      notificationMetrics.totalDroppedDisconnected++;
      continue;
    }

    // Check event filter
    if (!session.eventFilter) { notificationMetrics.totalDroppedFiltered++; continue; }
    if (!session.eventFilter.has(eventName) && !session.eventFilter.has('*')) {
      notificationMetrics.totalDroppedFiltered++;
      continue;
    }

    // Check task filter (empty = all tasks)
    if (session.taskFilter && session.taskFilter.size > 0) {
      if (!session.taskFilter.has(taskId)) {
        notificationMetrics.totalDroppedFiltered++;
        continue;
      }
    }

    // Check project filter (empty = all projects)
    if (session.projectFilter && session.projectFilter.size > 0) {
      if (taskData.project && !session.projectFilter.has(taskData.project)) {
        notificationMetrics.totalDroppedFiltered++;
        continue;
      }
    }

    // Check provider filter (empty = all providers)
    if (session.providerFilter && session.providerFilter.size > 0) {
      if (taskData.provider && !session.providerFilter.has(taskData.provider)) {
        notificationMetrics.totalDroppedFiltered++;
        continue;
      }
    }

    // 1. Push MCP standard log notification (human-visible in Claude Code)
    try {
      if (serializedNotificationPayload) {
        sendSseEvent(session, 'message', serializedNotificationPayload);
      }
    } catch {
      notificationMetrics.deliveryErrors++;
    }

    // 2. Queue structured event for check_notifications
    const now = new Date();
    const eventId = ++eventIdCounter;
    const seq = ++_notificationSequence; // Monotonic per-server sequence number
    const event = {
      id: eventId,
      seq,
      eventName,
      taskId,
      status: taskData.status,
      exitCode: taskData.exitCode,
      project: taskData.project,
      provider: taskData.provider || null,
      duration: taskData.duration,
      description: taskData.description,
      timestamp: now.toISOString(),
      priority: EVENT_PRIORITY[eventName] ?? DEFAULT_EVENT_PRIORITY,
    };

    // Deduplication: if same taskId/eventName/status has a pending event within DEDUP_WINDOW_MS, replace it.
    // Uses seq to distinguish genuinely distinct events — two 'completed' events for the same task at
    // different sequence numbers are different events even if they share taskId/eventName/status.
    const existingIdx = session.pendingEvents.findIndex(e =>
      e.taskId === taskId &&
      e.eventName === eventName &&
      e.status === taskData.status &&
      (now.getTime() - new Date(e.timestamp).getTime()) < DEDUP_WINDOW_MS
    );

    if (existingIdx >= 0) {
      // Replace with updated event (preserve seq of incoming — it is newer)
      session.pendingEvents[existingIdx] = event;
      notificationMetrics.totalDeduplicated++;
    } else {
      session.pendingEvents.push(event);
      notificationMetrics.totalDelivered++;
    }

    // Cap at MAX_PENDING_EVENTS — evict lowest-priority events first.
    // failed events (priority 10) survive longer than completed (5) or batch_summary (1).
    // This ensures actionable failures are never silently dropped in favor of informational events.
    while (session.pendingEvents.length > MAX_PENDING_EVENTS) {
      // Find index of lowest-priority event (stable: pick earliest if tied)
      let evictIdx = 0;
      let evictPriority = session.pendingEvents[0].priority ?? DEFAULT_EVENT_PRIORITY;
      for (let i = 1; i < session.pendingEvents.length; i++) {
        const p = session.pendingEvents[i].priority ?? DEFAULT_EVENT_PRIORITY;
        if (p < evictPriority) {
          evictPriority = p;
          evictIdx = i;
        }
      }
      session.pendingEvents.splice(evictIdx, 1);
    }

    notificationMetrics.lastDeliveryAt = now.toISOString();

    // Track for aggregation (batch summaries for rapid-fire events)
    trackEventForAggregation(sessionId, event);
  }

  // Clean up dead sessions
  for (const id of deadSessions) {
    const dead = sessions.get(id);
    if (dead) {
      removeSessionFromTaskSubscriptions(id, dead.taskFilter);
      if (dead.keepaliveTimer) clearTrackedInterval(dead.keepaliveTimer);
      // Decrement per-IP counter
      if (dead._ip) {
        const ipCount = _perIpSessionCount.get(dead._ip) || 1;
        if (ipCount <= 1) _perIpSessionCount.delete(dead._ip);
        else _perIpSessionCount.set(dead._ip, ipCount - 1);
      }
      sessions.delete(id);
    } else {
      purgeSessionFromTaskSubscriptions(id);
    }
    notificationMetrics.deadSessionsCleaned++;
  }
}

// ──────────────────────────────────────────────────────────────
// Event aggregation — groups rapid-fire events into summaries
// ──────────────────────────────────────────────────────────────

// Per-session aggregation buffers: sessionId -> { timer, events: Map<groupKey, {count, statuses, taskIds}> }
const aggregationBuffers = new Map();

/**
 * Get aggregation group key for an event (workflow-based or time-window).
 * Events with same project are grouped together.
 */
function getAggregationKey(event) {
  return event.project || '_default';
}

/**
 * Flush aggregated events for a session — emits summary notifications
 * for groups that had 3+ events in the aggregation window.
 */
function flushAggregation(sessionId) {
  const buf = aggregationBuffers.get(sessionId);
  if (!buf) return;
  aggregationBuffers.delete(sessionId);

  const session = sessions.get(sessionId);
  if (!session || session.res.writableEnded) return;

  for (const [groupKey, group] of buf.events) {
    if (group.count < 3) continue; // Only aggregate 3+ events

    const statusCounts = {};
    for (const s of group.statuses) {
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    }
    const parts = Object.entries(statusCounts).map(([s, c]) => `${c} ${s}`);
    const summaryText = `[TORQUE] Batch summary (${groupKey}): ${parts.join(', ')} — ${group.count} events in ${EVENT_AGGREGATION_WINDOW_MS / 1000}s`;

    try {
      sendJsonRpcNotification(session, 'notifications/message', {
        level: 'info',
        logger: 'torque',
        data: summaryText,
      });
    } catch {}

    // Queue a summary event
    const summaryEvent = {
      id: ++eventIdCounter,
      eventName: 'batch_summary',
      taskId: null,
      status: 'summary',
      project: groupKey === '_default' ? null : groupKey,
      count: group.count,
      statusCounts,
      taskIds: group.taskIds.slice(0, 20),
      description: summaryText,
      timestamp: new Date().toISOString(),
    };
    session.pendingEvents.push(summaryEvent);
    while (session.pendingEvents.length > MAX_PENDING_EVENTS) {
      session.pendingEvents.shift();
    }
  }
}

/**
 * Track an event for aggregation. Returns true if the event was added to
 * a group with 3+ events (meaning a summary will be emitted on flush).
 */
function trackEventForAggregation(sessionId, event) {
  let buf = aggregationBuffers.get(sessionId);
  if (!buf) {
    buf = { timer: null, events: new Map() };
    aggregationBuffers.set(sessionId, buf);
  }

  const key = getAggregationKey(event);
  let group = buf.events.get(key);
  if (!group) {
    group = { count: 0, statuses: [], taskIds: [] };
    buf.events.set(key, group);
  }

  group.count++;
  group.statuses.push(event.eventName);
  if (group.taskIds.length < 20) group.taskIds.push(event.taskId);

  // Reset the flush timer on each new event
  if (buf.timer) { clearTimeout(buf.timer); TRACKED_INTERVALS.delete(buf.timer); }
  buf.timer = setTimeout(() => {
    TRACKED_INTERVALS.delete(buf.timer);
    buf.timer = null;
    flushAggregation(sessionId);
  }, EVENT_AGGREGATION_WINDOW_MS);
  TRACKED_INTERVALS.add(buf.timer);

  return group.count >= 3;
}

/**
 * Get the number of active SSE sessions.
 */
function getActiveSessionCount() {
  return sessions.size;
}

/**
 * Push a structured notification payload to subscribed MCP SSE clients.
 *
 * This helper is intentionally lightweight and forwards to the task/event
 * notification path so callers can mock a single MCP-facing contract.
 *
 * @param {object} notification
 * @param {string} notification.type - Event type used for SSE task filters.
 * @param {object} notification.data - Notification payload.
 * @returns {void}
 */
function pushNotification(notification) {
  if (!notification || typeof notification !== 'object') {
    return;
  }

  const eventName = typeof notification.type === 'string' && notification.type
    ? notification.type
    : 'ci';

  const payload = notification.data && typeof notification.data === 'object'
    ? notification.data
    : {};

  // Keep compatibility with existing task-based filters.
  const taskData = {
    taskId: payload.taskId || payload.run_id || null,
    ...payload,
  };

  notifySubscribedSessions(eventName, taskData);
}

// ──────────────────────────────────────────────────────────────
// Subscription persistence
// ──────────────────────────────────────────────────────────────

/**
 * Persist session subscription to DB for restore after server restart.
 * Uses the existing task_event_subscriptions table.
 */
function persistSubscription(sessionId, session) {
  try {
    // Validate session ownership: ensure sessionId maps to an active session
    const knownSession = sessions.get(sessionId);
    if (!knownSession || knownSession !== session) {
      // Session not owned by this connection — do not persist
      logger.warn(`[mcp-sse] Refusing to persist subscription for unowned session ${sessionId}`);
      return;
    }

    const rawDb = db.getDbInstance && db.getDbInstance();
    if (!rawDb) return;

    // Storage note: both eventFilter (a Set of event-type strings) and taskFilter
    // (a Set of task-id strings) are serialised as JSON arrays into single TEXT columns
    // (`event_types` and `task_id` respectively). This is compact and sufficient for the
    // current workload (typically 1-5 event types and <100 task IDs per session), but
    // it means the DB cannot filter or index individual event types or task IDs without
    // deserialising the column. If subscriptions grow to hundreds of tasks per session,
    // consider a normalised join table (subscription_id → task_id) to allow indexed lookups.
    const eventTypes = JSON.stringify([...session.eventFilter]);
    const taskIds = session.taskFilter.size > 0 ? JSON.stringify([...session.taskFilter]) : null;

    // Upsert — replace if session already has a subscription
    rawDb.prepare(`
      INSERT OR REPLACE INTO task_event_subscriptions (id, task_id, event_types, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sessionId,
      taskIds,
      eventTypes,
      new Date().toISOString(),
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24h expiry
    );
  } catch {
    // Non-fatal — subscription persistence is best-effort
  }
}

/**
 * Restore subscription from DB when a session reconnects.
 * Returns { eventFilter, taskFilter } or null if no saved subscription.
 */
function restoreSubscription(sessionId) {
  try {
    const rawDb = db.getDbInstance && db.getDbInstance();
    if (!rawDb) return null;

    const row = rawDb.prepare(
      'SELECT event_types, task_id FROM task_event_subscriptions WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)'
    ).get(sessionId, new Date().toISOString());

    if (!row) return null;

    const eventFilter = row.event_types ? JSON.parse(row.event_types) : ['completed', 'failed'];
    const taskFilter = row.task_id ? JSON.parse(row.task_id) : [];
    const normalizedTaskFilter = taskFilter
      .map((taskId) => normalizeTaskId(taskId))
      .filter(Boolean);

    return { eventFilter: new Set(eventFilter), taskFilter: new Set(normalizedTaskFilter) };
  } catch {
    return null;
  }
}

/**
 * Remove expired subscriptions from DB.
 */
function cleanExpiredSubscriptions() {
  try {
    const rawDb = db.getDbInstance && db.getDbInstance();
    if (!rawDb) return;
    rawDb.prepare("DELETE FROM task_event_subscriptions WHERE expires_at < ?").run(new Date().toISOString());
  } catch {
    // Non-fatal
  }
}

// ──────────────────────────────────────────────────────────────
// SSE-only tool handlers
// ──────────────────────────────────────────────────────────────

/**
 * Handle subscribe_task_events tool call.
 */
// SECURITY (M3): Prevent subscription flood — limit task subscriptions per session
const MAX_SUBSCRIPTIONS_PER_SESSION = 200;

function handleSubscribeTaskEvents(session, args) {
  const previousTaskFilter = new Set(session.taskFilter);

  // Update event filter
  if (args.events && args.events.length > 0) {
    session.eventFilter = new Set(args.events);
  }
  // Default is already set on session creation: completed, failed

  // Update task filter
  if (Array.isArray(args.task_ids)) {
    // SECURITY (M3): Check incoming array size against subscription limit
    if (args.task_ids.length > MAX_SUBSCRIPTIONS_PER_SESSION) {
      return {
        content: [{ type: 'text', text: `Subscription limit: max ${MAX_SUBSCRIPTIONS_PER_SESSION} task IDs per session. Requested: ${args.task_ids.length}` }],
        isError: true,
      };
    }
    session.taskFilter.clear();
    for (const id of args.task_ids) {
      const normalized = normalizeTaskId(id);
      if (normalized) {
        session.taskFilter.add(normalized);
      }
    }
  }
  // Empty taskFilter means "all tasks"
  if (args.task_ids && args.task_ids.length === 0) {
    session.taskFilter.clear();
  }
  updateTaskFilterSubscriptions(session._sessionId, previousTaskFilter, session.taskFilter);

  // Update project filter
  if (Array.isArray(args.projects)) {
    session.projectFilter = new Set(args.projects);
  }

  // Update provider filter
  if (Array.isArray(args.providers)) {
    session.providerFilter = new Set(args.providers);
  }

  // Persist subscription for restore after restart
  if (session._sessionId) {
    persistSubscription(session._sessionId, session);
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        subscribed: true,
        eventFilter: [...session.eventFilter],
        taskFilter: session.taskFilter.size > 0 ? [...session.taskFilter] : 'all',
        projectFilter: session.projectFilter.size > 0 ? [...session.projectFilter] : 'all',
        providerFilter: session.providerFilter.size > 0 ? [...session.providerFilter] : 'all',
        pendingCount: session.pendingEvents.length,
      }),
    }],
  };
}

/**
 * Handle check_notifications tool call.
 * Rate-limited to 1 call per second per session.
 */
function handleCheckNotifications(session) {
  const now = Date.now();
  if (session.lastCheckNotificationsAt && (now - session.lastCheckNotificationsAt) < CHECK_NOTIFICATIONS_MIN_INTERVAL_MS) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          events: [],
          count: 0,
          rate_limited: true,
          retry_after_ms: CHECK_NOTIFICATIONS_MIN_INTERVAL_MS - (now - session.lastCheckNotificationsAt),
        }),
      }],
    };
  }
  session.lastCheckNotificationsAt = now;

  const events = session.pendingEvents.splice(0);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        events,
        count: events.length,
      }),
    }],
  };
}

/**
 * Handle ack_notification tool call.
 * Selectively remove events by task ID or index without clearing the entire queue.
 */
function handleAckNotification(session, args) {
  let removed = 0;

  // Remove by task IDs
  if (args.task_ids && args.task_ids.length > 0) {
    const taskIdSet = new Set(args.task_ids);
    const before = session.pendingEvents.length;
    session.pendingEvents = session.pendingEvents.filter(e => !taskIdSet.has(e.taskId));
    removed += before - session.pendingEvents.length;
  }

  // Remove by indices (descending to avoid shifting issues)
  if (args.indices && args.indices.length > 0) {
    const sortedIndices = [...args.indices].sort((a, b) => b - a);
    for (const idx of sortedIndices) {
      if (idx >= 0 && idx < session.pendingEvents.length) {
        session.pendingEvents.splice(idx, 1);
        removed++;
      }
    }
  }

  notificationMetrics.totalAcknowledged += removed;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        acknowledged: removed,
        remaining: session.pendingEvents.length,
      }),
    }],
  };
}

// ──────────────────────────────────────────────────────────────
// Body parsing
// ──────────────────────────────────────────────────────────────

/**
 * Parse JSON body from an HTTP request.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    const MAX_BODY = 10 * 1024 * 1024;

    const bodyTimeout = setTimeout(() => {
      req.destroy(new Error('Body parse timeout (30s)'));
    }, 30000);

    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY) {
        clearTimeout(bodyTimeout);
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(bodyTimeout);
      const body = Buffer.concat(chunks).toString('utf-8');
      if (!body) return resolve(null);
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', (err) => {
      clearTimeout(bodyTimeout);
      reject(err);
    });
  });
}

// ──────────────────────────────────────────────────────────────
// MCP request handler
// ──────────────────────────────────────────────────────────────

/**
 * Handle an MCP JSON-RPC request within an SSE session.
 * Delegates initialize, tools/list, and tools/call to the shared mcp-protocol handler.
 * SSE-specific tools (subscribe, notifications, ack) are intercepted before delegation.
 */
async function handleMcpRequest(request, session) {
  const { method, params } = request;

  // SSE-only tools need the full session context — intercept before delegation
  if (method === 'tools/call' && params != null && typeof params === 'object' && !Array.isArray(params)) {
    const name = params.name;
    if (name && SSE_TOOL_NAMES.has(name)) {
      const normalizedArgs = params.arguments || {};
      if (name === 'subscribe_task_events') return handleSubscribeTaskEvents(session, normalizedArgs);
      if (name === 'check_notifications') return handleCheckNotifications(session);
      if (name === 'ack_notification') return handleAckNotification(session, normalizedArgs);
    }
  }

  // Delegate to shared protocol handler
  const result = await mcpProtocol.handleRequest(request, session);

  // SSE transport-specific post-processing: notify client when tool mode changed
  if (session._toolsChanged) {
    session._toolsChanged = false;
    sendJsonRpcNotification(session, 'notifications/tools/list_changed');
  }

  // Append SSE-only tools to tools/list responses
  if (method === 'tools/list' && result && result.tools && SSE_TOOLS) {
    result.tools = [...result.tools, ...SSE_TOOLS];
  }

  // Auto-subscribe session to tasks returned by tool calls
  if (method === 'tools/call' && result) {
    const subscriptionTarget = buildSubscriptionTargetFromResult(result);
    if (subscriptionTarget) {
      applySubscriptionTargetToSession(session, subscriptionTarget);
      return mergeSubscriptionTargetIntoResult(result, subscriptionTarget);
    }
  }

  return result;
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

  // Security headers
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
    const requestedSessionId = url.searchParams.get('sessionId');
    const existingSession = requestedSessionId ? sessions.get(requestedSessionId) : null;
    const sessionId = existingSession ? requestedSessionId : generateSessionId();

    // Auth: SSE ticket > legacy ticket > apiKey/header > open mode
    const keyManager = require('./auth/key-manager');
    const legacyTicketManager = require('./auth/ticket-manager');
    const sseTicketManager = require('./auth/sse-tickets');
    const { isOpenMode } = require('./auth/middleware');

    let identity = null;
    const ticket = url.searchParams.get('ticket');
    const authHeader = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : (req.headers.authorization || req.headers.Authorization || '');
    const bearerMatch = typeof authHeader === 'string'
      ? authHeader.match(/^Bearer\s+(.+)$/i)
      : null;
    const apiKey = url.searchParams.get('apiKey') || req.headers['x-torque-key'] || (bearerMatch ? bearerMatch[1] : null);
    let ticketValidation = null;

    if (ticket) {
      if (ticket.startsWith(sseTicketManager.TICKET_PREFIX)) {
        ticketValidation = sseTicketManager.validateTicket(ticket);
        if (ticketValidation.valid) {
          identity = { id: ticketValidation.apiKeyId, type: 'api_key' };
        }
      } else {
        identity = legacyTicketManager.consumeTicket(ticket);
        if (!identity) {
          ticketValidation = { valid: false, reason: 'unknown' };
        }
      }
    } else if (apiKey) {
      identity = keyManager.validateKey(apiKey);
    }

    if (ticket && !identity) {
      const reason = ticketValidation?.reason === 'expired'
        ? 'expired'
        : 'invalid';
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `SSE ticket ${reason}` }));
      return;
    }

    // Open mode: no keys AND no users = admin
    if (!identity && isOpenMode()) {
      identity = { id: 'open-mode', name: 'Open Mode', role: 'admin', type: 'open' };
    }

    if (!existingSession && sessions.size >= MAX_SSE_SESSIONS) {
      logger.warn('[SSE] Session cap reached');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many active sessions', max: MAX_SSE_SESSIONS }));
      return;
    }

    const isAuthenticated = !!identity;
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

    // No SSE `retry:` field is sent. This intentionally leaves the client's
    // reconnection interval at its browser/runtime default (typically 3 seconds
    // for EventSource). TORQUE's SSE server is expected to be always available
    // on the loopback interface, so unbounded client reconnection is safe and
    // desirable — it means Claude Code sessions automatically recover after
    // transient server restarts without any manual intervention.
    // If a bounded retry policy becomes necessary (e.g. for remote deployments),
    // add `res.write('retry: 5000\n\n')` here to set a 5-second floor.
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
        // Stream closed between writableEnded check and write — clean up session from all maps
        clearTrackedInterval(keepaliveTimer);
        const deadSession = sessions.get(sessionId);
        if (deadSession && deadSession.res === res) {
          sessions.delete(sessionId);
          removeSessionFromTaskSubscriptions(sessionId, deadSession.taskFilter);
          // Decrement per-IP counter on keepalive-detected disconnect
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

    // Try to restore subscription from a previous session only for brand-new sessions.
    const restored = existingSession ? null : restoreSubscription(sessionId);

    // If this sessionId already has an active connection, reattach to it instead of replacing subscriptions.
    if (existingSession) {
      if (existingSession.keepaliveTimer) {
        clearTrackedInterval(existingSession.keepaliveTimer);
      }
      // Assign new res BEFORE ending old to avoid a window where the session has no active response stream.
      const oldRes = existingSession.res;
      existingSession.res = res; // assign new FIRST
      if (oldRes && !oldRes.writableEnded) {
        try { oldRes.end(); } catch {} // then close old
      }
    }

    const session = existingSession || {
      keepaliveTimer,
      res,
      toolMode: 'core',
      authenticated: isAuthenticated,
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
    // Re-check auth on reconnect in case the key changed
    if (existingSession) {
      session.authenticated = isAuthenticated;
    }

    if (!existingSession) {
      sessions.set(sessionId, session);
      addSessionToTaskSubscriptions(sessionId, session.taskFilter);

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
      } catch (e) {
        // Non-fatal — coordination is additive
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
        for (const evt of missedEvents.slice().reverse()) { // .slice() prevents mutating the shared array in-place
          // Deduplicate by task_id + event_type to avoid replaying events the client already has
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
            id: ++eventIdCounter,
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

    // Handle client disconnect — only delete session if it still belongs to THIS connection.
    // A reconnect with the same sessionId may have already replaced the entry.
    req.on('close', () => {
      clearTrackedInterval(keepaliveTimer);
      const current = sessions.get(sessionId);
      if (current && current.res === res) {
        sessions.delete(sessionId);
        removeSessionFromTaskSubscriptions(sessionId, current.taskFilter);
        // Decrement per-IP session counter
        const sessionIp = current._ip;
        if (sessionIp) {
          const ipCount = _perIpSessionCount.get(sessionIp) || 1;
          if (ipCount <= 1) _perIpSessionCount.delete(sessionIp);
          else _perIpSessionCount.set(sessionIp, ipCount - 1);
        }
        // Clean up aggregation buffers for this session
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
        } catch (e) {
          // Non-fatal
        }

        // Clean up pending elicitation requests — resolve with 'cancel'
        if (current.pendingRequests) {
          for (const [id, pending] of current.pendingRequests) {
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

    return;
  }

  // POST /messages?sessionId=xxx — receive JSON-RPC request
  if (req.method === 'POST' && url.pathname === '/messages') {
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
      request = await parseBody(req);
      if (!request) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Empty request body' }));
        return;
      }
    } catch {
      // JSON-RPC Parse error
      sendJsonRpcResponse(session, null, null, {
        code: -32700,
        message: 'Parse error: Invalid JSON',
      });
      res.writeHead(202);
      res.end();
      return;
    }

    // Check if this is a response to a server-initiated request (elicitation/sampling)
    // Responses have no 'method' field, just 'id' + 'result'/'error'
    if (request && !request.method && request.id !== undefined) {
      if (session.pendingRequests && session.pendingRequests.has(request.id)) {
        const pending = session.pendingRequests.get(request.id);
        clearTimeout(pending.timeout);
        session.pendingRequests.delete(request.id);
        pending.resolve(request.result || { action: 'cancel' });
        // Acknowledge and return — don't process as a request
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

    // Reject tool calls from unauthenticated sessions when auth is configured
    if (request.method === 'tools/call' && !session.authenticated) {
      const { isOpenMode: isOpen } = require('./auth/middleware');
      if (!isOpen()) {
        sendJsonRpcResponse(session, request.id, null, {
          code: -32001,
          message: 'Authentication required — mint a ticket via POST /api/auth/sse-ticket and connect with /sse?ticket=..., or use the legacy apiKey/header auth',
        });
        res.writeHead(202);
        res.end();
        return;
      }
    }

    // Acknowledge the POST immediately — actual response comes via SSE
    res.writeHead(202);
    res.end();

    try {
      const result = await handleMcpRequest(request, session);

      // Send response via SSE (only if request has an id — notifications don't)
      if (request.id !== undefined && result !== null) {
        sendJsonRpcResponse(session, request.id, result);
      }
    } catch (err) {
      if (request.id !== undefined) {
        // Guard against double-fail: if SSE stream is already dead, don't attempt another write
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

    return;
  }

  // Unknown route
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found. Use GET /sse to connect.' }));
}

/**
 * Start the MCP SSE server.
 */
function start(options = {}) {
  return new Promise((resolve) => {
    if (sseServer) {
      resolve({ success: true, port: ssePort, message: 'Already running' });
      return;
    }
    // Fresh abort controller for this server lifecycle
    shutdownAbort = new AbortController();

    // Initialize shared protocol handler with SSE-aware tool dispatch
    mcpProtocol.init({
      tools: TOOLS,
      coreToolNames: Array.isArray(CORE_TOOL_NAMES) ? CORE_TOOL_NAMES : [...CORE_TOOL_NAMES],
      extendedToolNames: Array.isArray(EXTENDED_TOOL_NAMES) ? EXTENDED_TOOL_NAMES : [...EXTENDED_TOOL_NAMES],
      handleToolCall: async (name, args, session) => {
        const argsWithSignal = {
          ...args,
          __shutdownSignal: shutdownAbort ? shutdownAbort.signal : undefined,
          __sessionId: session?._sessionId || null,
        };

        // Lazy agent name update on first tool call with working_directory
        if (args.working_directory && session && !session._nameUpdated) {
          try {
            const projectName = require('path').basename(args.working_directory);
            const coord = require('./db/coordination');
            coord.updateAgent(session._sessionId, { name: `claude-code@${projectName}` });
            session._nameUpdated = true;
          } catch (e) {
            // Non-fatal
          }
        }

        return handleToolCall(name, argsWithSignal);
      },
      onInitialize: (_session) => {
        // Economy mode removed — routing templates handle cost-aware provider selection
      },
    });

    ssePort = options.port || serverConfig.getInt('mcp_sse_port', 3458);

    sseServer = http.createServer(handleHttpRequest);

    sseServer.on('error', (err) => {
      sseServer = null; // Reset so future start() attempts don't falsely report "Already running"
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
      // Clean expired subscriptions on startup and every hour
      cleanExpiredSubscriptions();
      trackInterval(setInterval(cleanExpiredSubscriptions, 60 * 60 * 1000));
      resolve({ success: true, port: ssePort });
    });
  });
}

/**
 * Stop the MCP SSE server and close all sessions.
 */
function stop() {
  // Signal all blocking handlers (await_task, await_workflow) to return immediately
  shutdownAbort.abort();

  if (sseServer) {
    clearAllTrackedIntervals();

    for (const [_id, session] of sessions) {
      clearTrackedInterval(session.keepaliveTimer);
      if (session.res && !session.res.writableEnded) {
        session.res.end();
      }
    }
    sessions.clear();
    taskSubscriptions.clear();
    // Clear aggregation buffers and their timers to prevent leaks
    for (const [, buf] of aggregationBuffers) {
      if (buf.timer) clearTimeout(buf.timer);
    }
    aggregationBuffers.clear();
    // Capture reference and null out before close to prevent race with start()
    const server = sseServer;
    sseServer = null;
    server.close(() => {
      debugLog('Server fully closed');
    });
    // Remove model event listeners to prevent leaks across restart cycles
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

// ── Model registry notifications ─────────────────────────────────────────────

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
    } catch (_e) { void _e; /* ignore disconnected sessions */ }
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

/**
 * Look up a live session by session ID.
 * @param {string} sessionId
 * @returns {object|null}
 */
function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

module.exports = {
  start,
  stop,
  notifySubscribedSessions,
  pushNotification,
  getActiveSessionCount,
  setShuttingDown,
  sessions,
  notificationMetrics,
  taskSubscriptions,
  addSessionToTaskSubscriptions,
  sendClientRequest,
  getSession,
};
