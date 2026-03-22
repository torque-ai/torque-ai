/**
 * SSE Session Management
 *
 * Session state, event queue, dedup, priority eviction, per-IP tracking,
 * subscription management, notification delivery, event aggregation,
 * subscription persistence, and SSE-only tool handlers.
 *
 * Extracted from mcp-sse.js to keep the transport module under 1000 lines.
 */

const { getDbInstance } = require('../../database');
const workflowEngine = require('../../db/workflow-engine');
const serverConfig = require('../../config');
const logger = require('../../logger').child({ component: 'mcp-sse:session' });

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const MAX_PENDING_EVENTS = 100;
const CHECK_NOTIFICATIONS_MIN_INTERVAL_MS = 1000;
const DEDUP_WINDOW_MS = 5000;
const MAX_SSE_SESSIONS = 50;
const MAX_SESSIONS_PER_IP = 10;
const MAX_SUBSCRIPTIONS_PER_SESSION = 200;
const EVENT_AGGREGATION_WINDOW_MS = 10000;
const ALL_TASKS_SUBSCRIPTION_KEY = '__all_tasks__';

// Event priority for eviction — higher number = higher priority (kept longer under MAX_PENDING_EVENTS)
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

// ──────────────────────────────────────────────────────────────
// Shared state
// ──────────────────────────────────────────────────────────────

// Active SSE sessions: sessionId -> session object
const sessions = new Map();
// taskSubscriptions: taskId -> Set<sessionId>
const taskSubscriptions = new Map();
// Per-IP session tracking
const _perIpSessionCount = new Map();
// Per-session aggregation buffers
const aggregationBuffers = new Map();

// Monotonic event counter for SSE event IDs (enables replay on reconnect)
let eventIdCounter = 0;
// Monotonic sequence counter for structured notification events
let _notificationSequence = 0;

// Notification delivery metrics — cumulative over server lifetime
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

// ──────────────────────────────────────────────────────────────
// Interval tracking (shared with server.js via injection)
// ──────────────────────────────────────────────────────────────

let _trackedIntervals = null;

function setTrackedIntervals(set) {
  _trackedIntervals = set;
}

function clearTrackedInterval(timer) {
  if (!timer) return;
  clearInterval(timer);
  if (_trackedIntervals) _trackedIntervals.delete(timer);
}

// ──────────────────────────────────────────────────────────────
// SSE send helpers (injected from mcp-sse.js)
// ──────────────────────────────────────────────────────────────

let _sendSseEvent = null;
let _sendJsonRpcNotification = null;

function injectSendHelpers({ sendSseEvent, sendJsonRpcNotification }) {
  _sendSseEvent = sendSseEvent;
  _sendJsonRpcNotification = sendJsonRpcNotification;
}

// ──────────────────────────────────────────────────────────────
// Task subscription management
// ──────────────────────────────────────────────────────────────

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
  if (!Array.isArray(taskIds)) return [];
  const normalizedTaskIds = [];
  const seen = new Set();
  for (const rawTaskId of taskIds) {
    const taskId = normalizeTaskId(rawTaskId);
    if (!taskId || seen.has(taskId)) continue;
    seen.add(taskId);
    normalizedTaskIds.push(taskId);
  }
  return normalizedTaskIds;
}

function buildSubscriptionTargetFromResult(result) {
  if (!result || typeof result !== 'object') return null;

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
  if (taskIds.length === 0 && workflowId && typeof workflowEngine.getWorkflowTasks === 'function') {
    const workflowTaskIds = workflowEngine.getWorkflowTasks(workflowId) || [];
    taskIds = normalizeSubscriptionTaskIds(workflowTaskIds.map(task => task && task.id));
  }

  if (!explicitTarget && !workflowId && taskIds.length === 0) return null;

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
    return;
  }
  for (const taskId of newIds) {
    session.taskFilter.add(taskId);
  }
  updateTaskFilterSubscriptions(session._sessionId, previousTaskFilter, session.taskFilter);
}

function mergeSubscriptionTargetIntoResult(result, subscriptionTarget) {
  if (!result || typeof result !== 'object' || !subscriptionTarget) return result;
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
// Notification template rendering
// ──────────────────────────────────────────────────────────────

/**
 * Render a notification message from a template string.
 * Tokens: {taskId}, {status}, {duration}, {project}, {exitCode}, {description}
 * Conditional blocks: { (}{duration}s{)} — only included when the token has a value.
 */
function renderNotificationTemplate(template, data) {
  let result = template.replace(/\{([^}]*)\}\{(\w+)\}\{([^}]*)\}/g, (match, prefix, token, suffix) => {
    const value = data[token];
    if (value == null || value === '') return '';
    return `${prefix}${value}${suffix}`;
  });
  result = result.replace(/\{(\w+)\}/g, (match, token) => {
    const value = data[token];
    return value != null ? String(value) : '';
  });
  return result.trim();
}

// ──────────────────────────────────────────────────────────────
// Push notification infrastructure
// ──────────────────────────────────────────────────────────────

const JSONRPC_VERSION = '2.0';

/**
 * Notify all subscribed SSE sessions about a task event.
 */
function notifySubscribedSessions(eventName, taskData) {
  const deadSessions = [];
  const taskId = normalizeTaskId(taskData && taskData.taskId);
  const subscriberSessionIds = new Set();

  if (taskId) {
    const specificSubscribers = taskSubscriptions.get(taskId);
    if (specificSubscribers) {
      for (const sessionId of specificSubscribers) subscriberSessionIds.add(sessionId);
    }
  }
  const allSubscribers = taskSubscriptions.get(ALL_TASKS_SUBSCRIPTION_KEY);
  if (allSubscribers) {
    for (const sessionId of allSubscribers) subscriberSessionIds.add(sessionId);
  }

  // Fallback: broadcast to all sessions if no task subscriptions registered (legacy/test compat)
  if (subscriberSessionIds.size === 0 && taskSubscriptions.size === 0) {
    for (const sessionId of sessions.keys()) subscriberSessionIds.add(sessionId);
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
      params: { level: 'info', logger: 'torque', data: logMessage },
    });
  } catch {
    serializedNotificationPayload = null;
  }

  for (const sessionId of subscriberSessionIds) {
    const session = sessions.get(sessionId);
    if (!session) { deadSessions.push(sessionId); continue; }

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
      if (!session.taskFilter.has(taskId)) { notificationMetrics.totalDroppedFiltered++; continue; }
    }

    // Check project filter
    if (session.projectFilter && session.projectFilter.size > 0) {
      if (taskData.project && !session.projectFilter.has(taskData.project)) {
        notificationMetrics.totalDroppedFiltered++;
        continue;
      }
    }

    // Check provider filter
    if (session.providerFilter && session.providerFilter.size > 0) {
      if (taskData.provider && !session.providerFilter.has(taskData.provider)) {
        notificationMetrics.totalDroppedFiltered++;
        continue;
      }
    }

    // 1. Push MCP standard log notification
    try {
      if (serializedNotificationPayload && _sendSseEvent) {
        _sendSseEvent(session, 'message', serializedNotificationPayload);
      }
    } catch {
      notificationMetrics.deliveryErrors++;
    }

    // 2. Queue structured event for check_notifications
    const now = new Date();
    const evtId = ++eventIdCounter;
    const seq = ++_notificationSequence;
    const event = {
      id: evtId,
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

    // Dedup: replace existing event for same taskId/eventName/status within window
    const existingIdx = session.pendingEvents.findIndex(e =>
      e.taskId === taskId &&
      e.eventName === eventName &&
      e.status === taskData.status &&
      (now.getTime() - new Date(e.timestamp).getTime()) < DEDUP_WINDOW_MS
    );

    if (existingIdx >= 0) {
      session.pendingEvents[existingIdx] = event;
      notificationMetrics.totalDeduplicated++;
    } else {
      session.pendingEvents.push(event);
      notificationMetrics.totalDelivered++;
    }

    // Cap at MAX_PENDING_EVENTS — evict lowest-priority events first
    while (session.pendingEvents.length > MAX_PENDING_EVENTS) {
      let evictIdx = 0;
      let evictPriority = session.pendingEvents[0].priority ?? DEFAULT_EVENT_PRIORITY;
      for (let i = 1; i < session.pendingEvents.length; i++) {
        const p = session.pendingEvents[i].priority ?? DEFAULT_EVENT_PRIORITY;
        if (p < evictPriority) { evictPriority = p; evictIdx = i; }
      }
      session.pendingEvents.splice(evictIdx, 1);
    }

    notificationMetrics.lastDeliveryAt = now.toISOString();
    trackEventForAggregation(sessionId, event);
  }

  // Clean up dead sessions
  for (const id of deadSessions) {
    const dead = sessions.get(id);
    if (dead) {
      removeSessionFromTaskSubscriptions(id, dead.taskFilter);
      if (dead.keepaliveTimer) clearTrackedInterval(dead.keepaliveTimer);
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
// Event aggregation
// ──────────────────────────────────────────────────────────────

function getAggregationKey(event) {
  return event.project || '_default';
}

function flushAggregation(sessionId) {
  const buf = aggregationBuffers.get(sessionId);
  if (!buf) return;
  aggregationBuffers.delete(sessionId);

  const session = sessions.get(sessionId);
  if (!session || session.res.writableEnded) return;

  for (const [groupKey, group] of buf.events) {
    if (group.count < 3) continue;

    const statusCounts = {};
    for (const s of group.statuses) statusCounts[s] = (statusCounts[s] || 0) + 1;
    const parts = Object.entries(statusCounts).map(([s, c]) => `${c} ${s}`);
    const summaryText = `[TORQUE] Batch summary (${groupKey}): ${parts.join(', ')} — ${group.count} events in ${EVENT_AGGREGATION_WINDOW_MS / 1000}s`;

    try {
      if (_sendJsonRpcNotification) {
        _sendJsonRpcNotification(session, 'notifications/message', {
          level: 'info',
          logger: 'torque',
          data: summaryText,
        });
      }
    } catch {}

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

  if (buf.timer) { clearTimeout(buf.timer); if (_trackedIntervals) _trackedIntervals.delete(buf.timer); }
  buf.timer = setTimeout(() => {
    if (_trackedIntervals) _trackedIntervals.delete(buf.timer);
    buf.timer = null;
    flushAggregation(sessionId);
  }, EVENT_AGGREGATION_WINDOW_MS);
  if (_trackedIntervals) _trackedIntervals.add(buf.timer);

  return group.count >= 3;
}

// ──────────────────────────────────────────────────────────────
// Push notification helper
// ──────────────────────────────────────────────────────────────

function pushNotification(notification) {
  if (!notification || typeof notification !== 'object') return;
  const eventName = typeof notification.type === 'string' && notification.type
    ? notification.type
    : 'ci';
  const payload = notification.data && typeof notification.data === 'object'
    ? notification.data
    : {};
  const taskData = { taskId: payload.taskId || payload.run_id || null, ...payload };
  notifySubscribedSessions(eventName, taskData);
}

// ──────────────────────────────────────────────────────────────
// Subscription persistence
// ──────────────────────────────────────────────────────────────

function persistSubscription(sessionId, session) {
  try {
    const knownSession = sessions.get(sessionId);
    if (!knownSession || knownSession !== session) {
      logger.warn(`[mcp-sse] Refusing to persist subscription for unowned session ${sessionId}`);
      return;
    }
    const rawDb = getDbInstance && getDbInstance();
    if (!rawDb) return;
    const eventTypes = JSON.stringify([...session.eventFilter]);
    const taskIds = session.taskFilter.size > 0 ? JSON.stringify([...session.taskFilter]) : null;
    rawDb.prepare(`
      INSERT OR REPLACE INTO task_event_subscriptions (id, task_id, event_types, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sessionId,
      taskIds,
      eventTypes,
      new Date().toISOString(),
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    );
  } catch {
    // Non-fatal
  }
}

function restoreSubscription(sessionId) {
  try {
    const rawDb = getDbInstance && getDbInstance();
    if (!rawDb) return null;
    const row = rawDb.prepare(
      'SELECT event_types, task_id FROM task_event_subscriptions WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)'
    ).get(sessionId, new Date().toISOString());
    if (!row) return null;
    const eventFilter = row.event_types ? JSON.parse(row.event_types) : ['completed', 'failed'];
    const taskFilter = row.task_id ? JSON.parse(row.task_id) : [];
    const normalizedTaskFilter = taskFilter.map((id) => normalizeTaskId(id)).filter(Boolean);
    return { eventFilter: new Set(eventFilter), taskFilter: new Set(normalizedTaskFilter) };
  } catch {
    return null;
  }
}

function cleanExpiredSubscriptions() {
  try {
    const rawDb = getDbInstance && getDbInstance();
    if (!rawDb) return;
    rawDb.prepare("DELETE FROM task_event_subscriptions WHERE expires_at < ?").run(new Date().toISOString());
  } catch {
    // Non-fatal
  }
}

// ──────────────────────────────────────────────────────────────
// SSE-only tool handlers
// ──────────────────────────────────────────────────────────────

function handleSubscribeTaskEvents(session, args) {
  const previousTaskFilter = new Set(session.taskFilter);

  if (args.events && args.events.length > 0) {
    session.eventFilter = new Set(args.events);
  }

  if (Array.isArray(args.task_ids)) {
    if (args.task_ids.length > MAX_SUBSCRIPTIONS_PER_SESSION) {
      return {
        content: [{ type: 'text', text: `Subscription limit: max ${MAX_SUBSCRIPTIONS_PER_SESSION} task IDs per session. Requested: ${args.task_ids.length}` }],
        isError: true,
      };
    }
    session.taskFilter.clear();
    for (const id of args.task_ids) {
      const normalized = normalizeTaskId(id);
      if (normalized) session.taskFilter.add(normalized);
    }
  }
  if (args.task_ids && args.task_ids.length === 0) {
    session.taskFilter.clear();
  }
  updateTaskFilterSubscriptions(session._sessionId, previousTaskFilter, session.taskFilter);

  if (Array.isArray(args.projects)) {
    session.projectFilter = new Set(args.projects);
  }
  if (Array.isArray(args.providers)) {
    session.providerFilter = new Set(args.providers);
  }

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
      text: JSON.stringify({ events, count: events.length }),
    }],
  };
}

function handleAckNotification(session, args) {
  let removed = 0;

  if (args.task_ids && args.task_ids.length > 0) {
    const taskIdSet = new Set(args.task_ids);
    const before = session.pendingEvents.length;
    session.pendingEvents = session.pendingEvents.filter(e => !taskIdSet.has(e.taskId));
    removed += before - session.pendingEvents.length;
  }

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
      text: JSON.stringify({ acknowledged: removed, remaining: session.pendingEvents.length }),
    }],
  };
}

// ──────────────────────────────────────────────────────────────
// Session helpers
// ──────────────────────────────────────────────────────────────

function getActiveSessionCount() {
  return sessions.size;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function nextEventId() {
  return ++eventIdCounter;
}

// ──────────────────────────────────────────────────────────────
// Cleanup (called from stop())
// ──────────────────────────────────────────────────────────────

function clearAllSessionState() {
  sessions.clear();
  taskSubscriptions.clear();
  for (const [, buf] of aggregationBuffers) {
    if (buf.timer) clearTimeout(buf.timer);
  }
  aggregationBuffers.clear();
}

module.exports = {
  // Constants
  MAX_PENDING_EVENTS,
  MAX_SSE_SESSIONS,
  MAX_SESSIONS_PER_IP,
  MAX_SUBSCRIPTIONS_PER_SESSION,
  ALL_TASKS_SUBSCRIPTION_KEY,
  EVENT_AGGREGATION_WINDOW_MS,
  JSONRPC_VERSION,

  // Shared state
  sessions,
  taskSubscriptions,
  notificationMetrics,
  aggregationBuffers,
  _perIpSessionCount,

  // Injection
  setTrackedIntervals,
  injectSendHelpers,

  // Subscription management
  normalizeTaskId,
  addSessionToTaskSubscriptions,
  removeSessionFromTaskSubscriptions,
  purgeSessionFromTaskSubscriptions,
  updateTaskFilterSubscriptions,
  buildSubscriptionTargetFromResult,
  applySubscriptionTargetToSession,
  mergeSubscriptionTargetIntoResult,

  // Notification delivery
  renderNotificationTemplate,
  notifySubscribedSessions,
  pushNotification,

  // Subscription persistence
  persistSubscription,
  restoreSubscription,
  cleanExpiredSubscriptions,

  // SSE tool handlers
  handleSubscribeTaskEvents,
  handleCheckNotifications,
  handleAckNotification,

  // Session helpers
  getActiveSessionCount,
  getSession,
  nextEventId,
  clearAllSessionState,
  clearTrackedInterval,
};
