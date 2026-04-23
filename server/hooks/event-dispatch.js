/**
 * TORQUE MCP Event Dispatch
 *
 * Central dispatcher for pushing task completion/failure notifications
 * through the MCP SSE transport to subscribed sessions.
 *
 * Also exposes an internal EventEmitter (`taskEvents`) so server-side
 * consumers (e.g. await_workflow) can wake up immediately on task
 * completion instead of polling on a fixed interval.
 *
 * Persists events to the task_events DB table for history/auditability.
 *
 * Non-fatal — errors are logged but never block task completion.
 */

const { EventEmitter } = require('events');
const database = require('../database');
const serverConfig = require('../config');
const logger = require('../logger').child({ component: 'event-dispatch' });

/**
 * Internal event bus for server-side consumers.
 * Emits 'task:<status>' events (e.g. 'task:completed', 'task:failed')
 * with the task record as the argument.
 */
const taskEvents = new EventEmitter();
taskEvents.setMaxListeners(100); // Multiple await_workflow calls may listen concurrently

/** Terminal events — task has reached a final state */
const TERMINAL_EVENTS = ['completed', 'failed', 'cancelled', 'skipped'];

/** Non-terminal notable events — interesting state changes worth reporting */
const NOTABLE_EVENTS = ['started', 'stall_warning', 'retry', 'fallback'];

function isTaskRecord(task) {
  return !!task && typeof task === 'object' && !Array.isArray(task);
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTaskId(task) {
  if (!isTaskRecord(task)) return null;

  const candidates = [task.id, task.taskId, task.task_id];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const normalized = String(candidate).trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
}

function normalizeNumber(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeDuration(task) {
  if (!isTaskRecord(task)) return null;

  const explicitDuration = normalizeNumber(task.duration);
  if (explicitDuration !== null) {
    return explicitDuration;
  }

  if (!task.started_at) return null;

  const startedAt = new Date(task.started_at).getTime();
  if (!Number.isFinite(startedAt)) {
    return null;
  }

  const endTime = task.completed_at
    ? new Date(task.completed_at).getTime()
    : Date.now();

  return Number.isFinite(endTime)
    ? Math.round((endTime - startedAt) / 1000)
    : Math.round((Date.now() - startedAt) / 1000);
}

function normalizeEventDetails(task) {
  if (!isTaskRecord(task)) {
    return null;
  }
  const details = task.event_data ?? task.eventData ?? task.details ?? null;
  if (details == null) {
    return null;
  }
  if (typeof details === 'string') {
    const trimmed = details.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return details;
}

function collectTaskPayloadIssues(eventStatus, task) {
  const issues = [];
  if (!isTaskRecord(task)) {
    issues.push('task must be an object');
    return issues;
  }

  if (!normalizeTaskId(task)) {
    issues.push('task.id is required');
  }

  if (!normalizeString(task.status)) {
    issues.push('task.status missing');
  }

  if (task.started_at && normalizeDuration(task) === null) {
    issues.push('task.started_at invalid');
  }

  if ((task.exitCode != null || task.exit_code != null)
      && normalizeNumber(task.exitCode ?? task.exit_code) === null) {
    issues.push('task exit code invalid');
  }

  if (!normalizeString(eventStatus)) {
    issues.push('eventName missing');
  }

  return issues;
}

function buildTaskEventContext(eventName, task) {
  const taskRecord = isTaskRecord(task) ? task : null;
  const eventStatus = normalizeString(eventName) || 'unknown';
  const taskId = normalizeTaskId(taskRecord);
  const taskStatus = normalizeString(taskRecord && taskRecord.status);
  const exitCode = taskRecord
    ? normalizeNumber(taskRecord.exitCode ?? taskRecord.exit_code)
    : null;
  const descriptionSource = taskRecord
    ? (taskRecord.task_description ?? taskRecord.description ?? '')
    : '';
  const description = typeof descriptionSource === 'string'
    ? descriptionSource.slice(0, 200)
    : '';
  const taskPayloadIssues = collectTaskPayloadIssues(eventName, task);
  const malformedTaskPayload = taskPayloadIssues.length > 0;
  const details = normalizeEventDetails(taskRecord);

  return {
    rawTask: taskRecord,
    eventName: eventStatus,
    taskId,
    status: eventStatus, // Compatibility alias: existing consumers treat status as the event name.
    eventStatus,
    taskStatus,
    exitCode,
    exit_code: exitCode,
    project: normalizeString(taskRecord && taskRecord.project),
    provider: normalizeString(taskRecord && taskRecord.provider),
    duration: normalizeDuration(taskRecord),
    description,
    malformedTaskPayload,
    taskPayloadIssues,
    details,
    emitterTask: taskRecord || {
      id: taskId,
      status: taskStatus || eventStatus,
      eventStatus,
      taskStatus,
      malformedTaskPayload: true,
      taskPayloadIssues,
    },
    _malformedLogged: false,
  };
}

function logMalformedTaskEvent(context, phase) {
  if (!context.malformedTaskPayload || context._malformedLogged) {
    return;
  }

  context._malformedLogged = true;
  logger.warn('[MCP Notify] Malformed task event payload', {
    phase,
    eventName: context.eventName,
    taskId: context.taskId,
    taskStatus: context.taskStatus,
    issues: context.taskPayloadIssues,
  });
}

/**
 * Persist a task event to the task_events DB table.
 * Non-fatal — silently logs on error.
 */
function persistTaskEvent(eventName, task) {
  const context = task && task.eventStatus && Array.isArray(task.taskPayloadIssues)
    ? task
    : buildTaskEventContext(eventName, task);

  try {
    const rawDb = database.getDbInstance();
    if (!rawDb) return;

    logMalformedTaskEvent(context, 'persist');

    if (!context.taskId) {
      logger.warn('[MCP Notify] Skipping task event persist without task ID', {
        eventName: context.eventName,
        issues: context.taskPayloadIssues,
      });
      return;
    }

    const eventData = JSON.stringify({
      exitCode: context.exitCode,
      exit_code: context.exit_code,
      status: context.status,
      eventStatus: context.eventStatus,
      taskStatus: context.taskStatus,
      malformedTaskPayload: context.malformedTaskPayload,
      taskPayloadIssues: context.taskPayloadIssues,
      project: context.project,
      provider: context.provider,
      duration: context.duration,
      details: context.details,
    });

    rawDb.prepare(`
      INSERT INTO task_events (task_id, event_type, old_value, new_value, event_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      context.taskId,
      context.eventName,
      null,                                        // old_value — not applicable for completion events
      context.taskStatus || context.eventStatus,    // new_value — the resulting task status when available
      eventData,
      new Date().toISOString()
    );
  } catch (err) {
    logger.info('[MCP Notify] Non-fatal DB persist error:', err.message);
  }
}

/**
 * Dispatch a task event to all subscribed MCP SSE sessions,
 * emit on the internal event bus, and persist to DB.
 *
 * @param {string} eventName - Event type: 'completed', 'failed', 'cancelled', etc.
 * @param {object} task - Task record from DB.
 */
function dispatchTaskEvent(eventName, task) {
  const payload = buildTaskEventContext(eventName, task);
  logMalformedTaskEvent(payload, 'dispatch');

  // Always emit on internal bus (for await_workflow wakeup) regardless of config
  try {
    taskEvents.emit(`task:${payload.eventName}`, payload.emitterTask);
  } catch {
    // Non-fatal
  }

  // Persist to DB for history
  persistTaskEvent(payload.eventName, payload);

  try {
    // Config gate — allow disabling MCP SSE push via config
    const enabled = serverConfig.get('mcp_notifications_enabled');
    if (enabled === 'false' || enabled === '0') {
      return;
    }

    const { notifySubscribedSessions } = require('../mcp-sse');

    notifySubscribedSessions(payload.eventName, payload);

    // Also push to dashboard WebSocket clients for live event feed
    try {
      const dashboard = require('../dashboard-server');
      dashboard.notifyTaskEvent(payload);
    } catch {
      // Dashboard may not be running — non-fatal
    }

    // Record coordination event
    try {
      const coord = require('../db/coordination');
      const taskMeta = task?.metadata ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata) : {};
      const agentId = taskMeta?.submitted_by_agent || null;
      coord.recordCoordinationEvent(eventName, agentId, task?.id || null,
        JSON.stringify({ status: task?.status, provider: task?.provider }));
    } catch {
      // Non-fatal
    }
  } catch (err) {
    logger.info('[MCP Notify] Non-fatal dispatch error:', err.message);
  }
}

/**
 * Retrieve recent task events from the DB.
 *
 * @param {object} options - Filter options.
 * @param {string} [options.task_id] - Filter by task ID.
 * @param {string} [options.event_type] - Filter by event type.
 * @param {number} [options.limit=50] - Max events to return.
 * @returns {Array} Event records.
 */
function getTaskEvents(options = {}) {
  try {
    const rawDb = database.getDbInstance();
    if (!rawDb) return [];

    let sql = 'SELECT * FROM task_events WHERE 1=1';
    const params = [];

    if (options.task_id) {
      sql += ' AND task_id = ?';
      params.push(options.task_id);
    }
    if (Number.isInteger(options.sinceId) && options.sinceId > 0) {
      sql += ' AND id > ?';
      params.push(options.sinceId);
    }
    if (options.event_type) {
      sql += ' AND event_type = ?';
      params.push(options.event_type);
    }

    sql += ' ORDER BY id DESC LIMIT ?';
    // Validate limit is a positive integer; reject non-integers and values ≤ 0
    const rawLimit = options.limit;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 50;
    params.push(limit);

    return rawDb.prepare(sql).all(...params);
  } catch (err) {
    logger.info('[MCP Notify] Error reading task events:', err.message);
    return [];
  }
}

/**
 * Prune task events older than the configured retention period.
 * Default: 30 days. Configurable via 'event_retention_days' DB config.
 *
 * @returns {number} Number of rows deleted.
 */
function pruneOldTaskEvents() {
  try {
    const rawDb = database.getDbInstance();
    if (!rawDb) return 0;

    const retentionDays = serverConfig.getInt('event_retention_days', 30);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    const result = rawDb.prepare(
      'DELETE FROM task_events WHERE created_at < ?'
    ).run(cutoff);

    const deleted = result.changes || 0;
    if (deleted > 0) {
      logger.info(`[Event Retention] Pruned ${deleted} events older than ${retentionDays} days`);
    }
    return deleted;
  } catch (err) {
    logger.info('[Event Retention] Non-fatal prune error:', err.message);
    return 0;
  }
}

// Run initial prune after 30s, then every 24 hours
let _pruneTimer = null;
let _initialPruneTimer = null;
function startRetentionPolicy() {
  if (_pruneTimer) return;
  _initialPruneTimer = setTimeout(() => pruneOldTaskEvents(), 30000);
  _pruneTimer = setInterval(() => pruneOldTaskEvents(), 24 * 60 * 60 * 1000);
  // unref() so these timers don't prevent process exit (e.g. in test workers)
  if (_initialPruneTimer.unref) _initialPruneTimer.unref();
  if (_pruneTimer.unref) _pruneTimer.unref();
}

function stopRetentionPolicy() {
  if (_initialPruneTimer) {
    clearTimeout(_initialPruneTimer);
    _initialPruneTimer = null;
  }
  if (_pruneTimer) {
    clearInterval(_pruneTimer);
    _pruneTimer = null;
  }
}

// Auto-start retention policy on module load
startRetentionPolicy();

function createEventDispatch() {
  return {
    TERMINAL_EVENTS,
    NOTABLE_EVENTS,
    persistTaskEvent,
    dispatchTaskEvent,
    taskEvents,
    getTaskEvents,
    pruneOldTaskEvents,
    startRetentionPolicy,
    stopRetentionPolicy,
  };
}

module.exports = {
  TERMINAL_EVENTS,
  NOTABLE_EVENTS,
  persistTaskEvent,
  dispatchTaskEvent,
  taskEvents,
  getTaskEvents,
  pruneOldTaskEvents,
  startRetentionPolicy,
  stopRetentionPolicy,
  createEventDispatch,
};
