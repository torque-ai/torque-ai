'use strict';

const { EVENT_TYPES } = require('./event-types');
const eventBus = require('../event-bus');
const logger = require('../logger').child({ component: 'event-emitter' });

const KNOWN_TYPES = new Set(Object.values(EVENT_TYPES));
const MAX_PAYLOAD_BYTES = 100000;
const STRING_TRUNCATE_LENGTH = 4000;

function resolveFacade() {
  try {
    const { defaultContainer } = require('../container');
    return defaultContainer.get('db');
  } catch {
    return require('../database');
  }
}

function getDb() {
  const facade = resolveFacade();
  const db = typeof facade.getDbInstance === 'function' ? facade.getDbInstance() : facade;
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('Database is not initialized');
  }
  return db;
}

function stringifyPayload(payload) {
  try {
    return JSON.stringify(payload || {});
  } catch (err) {
    return JSON.stringify({
      _serialization_error: err.message,
      _truncated: true,
    });
  }
}

function truncateValue(value) {
  if (typeof value === 'string' && value.length > STRING_TRUNCATE_LENGTH) {
    return `${value.slice(0, STRING_TRUNCATE_LENGTH)}... [truncated]`;
  }
  return value;
}

function truncatePayload(payload) {
  const normalizedPayload = payload || {};
  const json = stringifyPayload(normalizedPayload);
  if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return json;

  const truncated = {};
  for (const [key, value] of Object.entries(normalizedPayload)) {
    truncated[key] = truncateValue(value);
  }
  truncated._truncated = true;
  truncated._original_size = Buffer.byteLength(json, 'utf8');

  const truncatedJson = stringifyPayload(truncated);
  if (Buffer.byteLength(truncatedJson, 'utf8') <= MAX_PAYLOAD_BYTES) return truncatedJson;
  return JSON.stringify({
    _truncated: true,
    _original_size: Buffer.byteLength(json, 'utf8'),
    _payload_keys: Object.keys(normalizedPayload).slice(0, 100),
  });
}

function emitRealtimeEvent(evt) {
  try {
    if (typeof eventBus.emitTaskEvent === 'function') {
      eventBus.emitTaskEvent(evt);
      return;
    }
    if (typeof eventBus.emit === 'function') {
      eventBus.emit('task.event', evt);
    }
  } catch (err) {
    logger.info(`[events] bus emit failed: ${err.message}`);
  }
}

function emitTaskEvent({ task_id, workflow_id = null, type, actor = null, payload = {} }) {
  if (!KNOWN_TYPES.has(type)) {
    throw new Error(`Unknown event type: ${type}`);
  }
  if (!task_id || typeof task_id !== 'string') {
    throw new Error('task_id is required');
  }

  const db = getDb();
  const ts = new Date().toISOString();
  const payloadJson = truncatePayload(payload);

  const result = db.prepare(`
    INSERT INTO task_events (
      task_id, workflow_id, ts, type, actor, payload_json,
      event_type, event_data, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(task_id, workflow_id, ts, type, actor, payloadJson, type, payloadJson, ts);

  const evt = {
    id: result.lastInsertRowid,
    task_id,
    workflow_id,
    ts,
    type,
    actor,
    payload: payload || {},
  };

  emitRealtimeEvent(evt);
  return evt;
}

function parsePayload(payloadJson) {
  if (!payloadJson) return {};
  try {
    return JSON.parse(payloadJson);
  } catch {
    return {};
  }
}

function listEvents({ task_id = null, workflow_id = null, type = null, since = null, limit = 1000 } = {}) {
  const where = [];
  const params = [];

  if (task_id) {
    where.push('task_id = ?');
    params.push(task_id);
  }
  if (workflow_id) {
    where.push('workflow_id = ?');
    params.push(workflow_id);
  }
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (since) {
    where.push('ts >= ?');
    params.push(since);
  }

  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : 1000;
  params.push(normalizedLimit);

  const rows = getDb().prepare(`
    SELECT * FROM task_events
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ts ASC, id ASC
    LIMIT ?
  `).all(...params);

  return rows.map((row) => ({
    ...row,
    payload: parsePayload(row.payload_json),
  }));
}

module.exports = { emitTaskEvent, listEvents };
