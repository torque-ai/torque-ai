'use strict';

/**
 * Webhooks & Streaming Module
 *
 * Extracted from database.js — webhooks, real-time streaming,
 * event subscriptions, and checkpoint/pause functionality.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

const credCrypto = require('../utils/credential-crypto');
const { safeJsonParse } = require('../utils/json');

let db;

function setDb(dbInstance) { db = dbInstance; }

/**
 * Encrypt a webhook secret for storage using ENC: prefix pattern.
 */
function encryptSecret(secret) {
  if (!secret || secret.startsWith('ENC:')) return secret;
  try {
    const encKey = credCrypto.getOrCreateKey();
    const { encrypted_value, iv, auth_tag } = credCrypto.encrypt(secret, encKey);
    return `ENC:${encrypted_value}:${iv}:${auth_tag}`;
  } catch {
    return secret;
  }
}

/**
 * Decrypt a webhook secret from storage using ENC: prefix pattern.
 */
function decryptSecret(storedSecret) {
  if (!storedSecret || !storedSecret.startsWith('ENC:')) return storedSecret;
  try {
    const encKey = credCrypto.getOrCreateKey();
    const parts = storedSecret.slice(4).split(':');
    if (parts.length === 3) {
      return credCrypto.decrypt(parts[0], parts[1], parts[2], encKey);
    }
  } catch {
    // Fall through
  }
  return storedSecret;
}


// ============================================
// WEBHOOK MANAGEMENT
// ============================================

/**
 * Create a new webhook
 */
function createWebhook({ id, name, url, type = 'http', events, project = null, headers = null, secret = null, retryCount = 3 }) {
  const stmt = db.prepare(`
    INSERT INTO webhooks (id, name, url, type, events, project, headers, secret, retry_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const eventsJson = Array.isArray(events) ? JSON.stringify(events) : events;
  const headersJson = headers ? JSON.stringify(headers) : null;

  // SECURITY: encrypt secret before storing
  const encryptedSecret = encryptSecret(secret);
  stmt.run(id, name, url, type, eventsJson, project, headersJson, encryptedSecret, retryCount, new Date().toISOString());

  return getWebhook(id);
}

/**
 * Get a webhook by ID
 * @param {any} id
 * @returns {any}
 */
function getWebhook(id) {
  const stmt = db.prepare('SELECT * FROM webhooks WHERE id = ?');
  const row = stmt.get(id);

  if (!row) return null;

  return {
    ...row,
    secret: decryptSecret(row.secret),
    events: safeJsonParse(row.events, []),
    headers: safeJsonParse(row.headers, null),
    enabled: !!row.enabled
  };
}

/**
 * List all webhooks, optionally filtered by project
 * @param {any} project
 * @returns {any}
 */
function listWebhooks(project = null) {
  let stmt;
  let rows;

  if (project) {
    stmt = db.prepare('SELECT * FROM webhooks WHERE project = ? OR project IS NULL ORDER BY created_at DESC');
    rows = stmt.all(project);
  } else {
    stmt = db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC');
    rows = stmt.all();
  }

  return rows.map(row => ({
    ...row,
    secret: decryptSecret(row.secret),
    events: safeJsonParse(row.events, []),
    headers: safeJsonParse(row.headers, null),
    enabled: !!row.enabled
  }));
}

/**
 * Update a webhook
 * @param {any} id
 * @param {any} updates
 * @returns {any}
 */
function updateWebhook(id, updates) {
  const webhook = getWebhook(id);
  if (!webhook) return null;

  const fields = [];
  const values = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.url !== undefined) {
    fields.push('url = ?');
    values.push(updates.url);
  }
  if (updates.type !== undefined) {
    fields.push('type = ?');
    values.push(updates.type);
  }
  if (updates.events !== undefined) {
    fields.push('events = ?');
    values.push(JSON.stringify(updates.events));
  }
  if (updates.project !== undefined) {
    fields.push('project = ?');
    values.push(updates.project);
  }
  if (updates.headers !== undefined) {
    fields.push('headers = ?');
    values.push(updates.headers ? JSON.stringify(updates.headers) : null);
  }
  if (updates.secret !== undefined) {
    fields.push('secret = ?');
    // SECURITY: encrypt secret before storing
    values.push(encryptSecret(updates.secret));
  }
  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }
  if (updates.retryCount !== undefined) {
    fields.push('retry_count = ?');
    values.push(updates.retryCount);
  }

  if (fields.length === 0) return webhook;

  values.push(id);
  const stmt = db.prepare(`UPDATE webhooks SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getWebhook(id);
}

/**
 * Delete a webhook
 */
function deleteWebhook(id) {
  const doDelete = db.transaction(() => {
    db.prepare('DELETE FROM webhook_logs WHERE webhook_id = ?').run(id);
    const result = db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return result.changes > 0;
  });
  return doDelete();
}

/**
 * Get webhooks that should be triggered for an event
 * @param {any} event
 * @param {any} project
 * @returns {any}
 */
function getWebhooksForEvent(event, project = null) {
  const stmt = db.prepare(`
    SELECT * FROM webhooks
    WHERE enabled = 1
    AND (project IS NULL OR project = ?)
  `);

  const rows = stmt.all(project);

  return rows
    .map(row => ({
      ...row,
      secret: decryptSecret(row.secret),
      events: safeJsonParse(row.events, []),
      headers: safeJsonParse(row.headers, null),
      enabled: !!row.enabled
    }))
    .filter(webhook => webhook.events.includes(event) || webhook.events.includes('*'));
}

/**
 * Log a webhook delivery attempt
 * @param {any} options
 * @returns {any}
 */
function scheduleWebhookRetry(webhookId, attempt, maxRetries = 3, context = {}) {
  if (attempt >= maxRetries) {
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
  setTimeout(() => {
    executeWebhookDelivery(webhookId, context);
  }, delay);
}

let webhookDeliveryExecutor = null;

function executeWebhookDelivery(webhookId, context = {}) {
  if (typeof webhookDeliveryExecutor !== 'function') {
    return;
  }

  const {
    event,
    taskId,
    attempt = 0,
    maxRetries = 3,
  } = context;

  try {
    webhookDeliveryExecutor({
      webhookId,
      event,
      taskId,
      attempt,
      maxRetries,
    });
  } catch (_e) {
    // Execution is best-effort; retry bookkeeping is kept in the delivery function
    void _e;
  }
}

function setWebhookDeliveryExecutor(fn) {
  webhookDeliveryExecutor = typeof fn === 'function' ? fn : null;
}

function logWebhookDelivery({ webhookId, event, taskId, payload, responseStatus, responseBody, success, error, attempt = 0, maxRetries, retryable = false }) {
  const stmt = db.prepare(`
    INSERT INTO webhook_logs (webhook_id, event, task_id, payload, response_status, response_body, success, error, triggered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    webhookId,
    event,
    taskId,
    JSON.stringify(payload),
    responseStatus,
    responseBody,
    success ? 1 : 0,
    error,
    new Date().toISOString()
  );

  // Update webhook stats
  if (success) {
    db.prepare('UPDATE webhooks SET success_count = success_count + 1, last_triggered_at = ? WHERE id = ?')
      .run(new Date().toISOString(), webhookId);
  } else {
    db.prepare('UPDATE webhooks SET failure_count = failure_count + 1, last_triggered_at = ? WHERE id = ?')
      .run(new Date().toISOString(), webhookId);
    const webhook = getWebhook(webhookId);
    const resolvedMaxRetries = typeof maxRetries === 'number' ? maxRetries : (webhook && webhook.retry_count) || 3;
    if (retryable && attempt < resolvedMaxRetries) {
      scheduleWebhookRetry(webhookId, attempt, resolvedMaxRetries, {
        event,
        taskId,
        attempt: attempt + 1,
        maxRetries: resolvedMaxRetries,
      });
    }
  }
}

/**
 * Get webhook delivery logs
 * @param {any} webhookId
 * @param {any} limit
 * @returns {any}
 */
function getWebhookLogs(webhookId, limit = 50) {
  const stmt = db.prepare(`
    SELECT * FROM webhook_logs
    WHERE webhook_id = ?
    ORDER BY triggered_at DESC
    LIMIT ?
  `);

  return stmt.all(webhookId, limit).map(row => ({
    ...row,
    payload: safeJsonParse(row.payload, null),
    success: !!row.success
  }));
}

/**
 * Get webhook statistics
 * @returns {any}
 */
function getWebhookStats() {
  const webhooks = db.prepare('SELECT COUNT(*) as total, SUM(enabled) as active FROM webhooks').get();
  const deliveries = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(success) as successful,
      COUNT(*) - SUM(success) as failed
    FROM webhook_logs
    WHERE triggered_at > datetime('now', '-24 hours')
  `).get();

  return {
    webhooks: {
      total: webhooks.total,
      active: webhooks.active || 0
    },
    deliveries_24h: {
      total: deliveries.total,
      successful: deliveries.successful || 0,
      failed: deliveries.failed || 0
    }
  };
}

/**
 * Clean up old webhook logs
 * Pre-calculates cutoff time to avoid race conditions with concurrent cleanup
 */
function cleanupWebhookLogs(daysToKeep = 30) {
  // Bound daysToKeep to reasonable range (1-3650 days)
  const boundedDays = Math.max(1, Math.min(parseInt(daysToKeep, 10) || 30, 3650));

  // Pre-calculate cutoff time for consistent behavior
  const cutoffMs = Date.now() - (boundedDays * 24 * 60 * 60 * 1000);
  const cutoffDate = new Date(cutoffMs).toISOString();

  const stmt = db.prepare(`
    DELETE FROM webhook_logs
    WHERE triggered_at < ?
  `);
  const result = stmt.run(cutoffDate);
  return result.changes;
}

/**
 * Enforce hard limits on webhook_logs table size
 * Prevents unbounded growth by removing oldest entries when limit exceeded
 * Default: 50,000 logs max
 */
function enforceWebhookLogLimits(maxLogs = 50000) {
  const boundedMax = Math.max(1000, Math.min(parseInt(maxLogs, 10) || 50000, 500000));

  const countStmt = db.prepare('SELECT COUNT(*) as count FROM webhook_logs');
  const { count } = countStmt.get();

  if (count <= boundedMax) {
    return 0;
  }

  // Delete oldest logs beyond the limit
  const toDelete = count - boundedMax;
  const stmt = db.prepare(`
    DELETE FROM webhook_logs
    WHERE id IN (
      SELECT id FROM webhook_logs
      ORDER BY triggered_at ASC
      LIMIT ?
    )
  `);
  const result = stmt.run(toDelete);
  return result.changes;
}

/**
 * Clean up stale webhook retry entries
 * Removes failed webhook logs older than specified days that have exhausted retries
 * This prevents accumulation of permanently failed webhooks
 */
function cleanupStaleWebhookRetries(daysOld = 7) {
  const boundedDays = Math.max(1, Math.min(parseInt(daysOld, 10) || 7, 90));

  const cutoffMs = Date.now() - (boundedDays * 24 * 60 * 60 * 1000);
  const cutoffDate = new Date(cutoffMs).toISOString();

  // Delete old failed webhook logs (success = 0)
  const stmt = db.prepare(`
    DELETE FROM webhook_logs
    WHERE success = 0
    AND triggered_at < ?
  `);
  const result = stmt.run(cutoffDate);
  return result.changes;
}

// ============================================================
// Wave 2 Phase 1: Real-time Streaming Functions
// ============================================================

/**
 * Create a new task stream for output tracking
 */
function createTaskStream(taskId, streamType = 'output') {
  const id = require('uuid').v4();
  const stmt = db.prepare(`
    INSERT INTO task_streams (id, task_id, stream_type, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `);
  stmt.run(id, taskId, streamType);
  _streamToTask.set(id, taskId);
  return id;
}

/**
 * Get existing stream for a task, or create one
 * Uses a transaction to prevent TOCTOU race condition
 * @param {any} taskId
 * @param {any} streamType
 * @returns {any}
 */
function getOrCreateTaskStream(taskId, streamType = 'output') {
  const transaction = db.transaction(() => {
    // Check for existing stream
    const stmt = db.prepare(`
      SELECT id FROM task_streams WHERE task_id = ? AND stream_type = ?
      ORDER BY created_at DESC LIMIT 1
    `);
    const existing = stmt.get(taskId, streamType);
    if (existing) {
      _streamToTask.set(existing.id, taskId);
      return existing.id;
    }

    // Create new stream atomically
    const id = require('uuid').v4();
    db.prepare(`
      INSERT INTO task_streams (id, task_id, stream_type, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(id, taskId, streamType);
    _streamToTask.set(id, taskId);

    return id;
  });

  return transaction();
}

// ============================================================
// StreamId-to-TaskId Cache (Phase 2 Task 1)
// ============================================================

/**
 * In-memory cache mapping streamId → taskId.
 * Populated by createTaskStream and getOrCreateTaskStream so that
 * downstream consumers (e.g. output accumulator) can resolve the owning
 * task without hitting the database on every chunk.
 */
const _streamToTask = new Map();

/**
 * Return the taskId associated with a streamId, or null if not cached.
 * Exported as a test helper; also used by the accumulator in Task 2.
 * @param {string} streamId
 * @returns {string|null}
 */
function getStreamTaskId(streamId) {
  return _streamToTask.get(streamId) || null;
}

// ============================================================
// Partial Output Ring Buffer (Phase 2 Task 2)
// ============================================================

/**
 * In-memory ring buffer accumulating streaming output per task.
 * Periodically flushed to tasks.partial_output so that heartbeat
 * check-ins can report real task progress.
 */
const _partialOutputBuffers = new Map(); // taskId → { buffer, lastFlushAt, streamId }
const FLUSH_INTERVAL_MS = 10000;         // 10 seconds
const MAX_BUFFER_SIZE = 32 * 1024;       // 32 KB

/**
 * Final flush + cleanup for a task's partial output buffer.
 * Called from the completion pipeline after a task reaches a terminal state.
 * Flushes any remaining buffered data, removes the Map entries, and NULLs
 * partial_output in the DB (the full output is now in the output column).
 * @param {string} taskId
 */
function clearPartialOutputBuffer(taskId) {
  const entry = _partialOutputBuffers.get(taskId);
  if (entry) {
    // Final flush — don't lose buffered data
    if (entry.buffer.length > 0) {
      flushPartialOutput(taskId, entry.buffer);
    }
    // Clean up _streamToTask
    if (entry.streamId) {
      _streamToTask.delete(entry.streamId);
    }
    _partialOutputBuffers.delete(taskId);
  }
  // NULL out partial_output — full output is in the output column now
  try {
    db.prepare('UPDATE tasks SET partial_output = NULL WHERE id = ?').run(taskId);
  } catch {
    // Non-fatal
  }
}

/**
 * Return the current partial output buffer for a task, or null.
 * @param {string} taskId
 * @returns {string|null}
 */
function getPartialOutputBuffer(taskId) {
  const entry = _partialOutputBuffers.get(taskId);
  return entry ? entry.buffer : null;
}

/**
 * Write the accumulated buffer to tasks.partial_output in the DB.
 * Non-fatal — never blocks chunk processing.
 * @param {string} taskId
 * @param {string} buffer
 */
function flushPartialOutput(taskId, buffer) {
  try {
    db.prepare('UPDATE tasks SET partial_output = ? WHERE id = ?').run(buffer, taskId);
  } catch {
    // Non-fatal — never block chunk processing
  }
}

/**
 * Truncate a buffer to MAX_BUFFER_SIZE, preferring a newline boundary.
 * @param {string} buffer
 * @returns {string}
 */
function truncateBuffer(buffer) {
  if (buffer.length <= MAX_BUFFER_SIZE) return buffer;
  const excess = buffer.length - MAX_BUFFER_SIZE;
  const newlineIdx = buffer.indexOf('\n', excess);
  if (newlineIdx !== -1) {
    return buffer.slice(newlineIdx + 1);
  }
  return buffer.slice(-MAX_BUFFER_SIZE);
}

// Stream storage limits to prevent unbounded growth
const MAX_STREAM_CHUNKS = 10000;        // Maximum chunks per stream
const MAX_STREAM_SIZE_BYTES = 10 * 1024 * 1024; // 10MB per stream
const MAX_CHUNK_SIZE_BYTES = 64 * 1024; // 64KB per chunk

/**
 * Add a chunk to a stream
 * Uses a transaction to prevent sequence number race condition
 * Enforces storage limits to prevent unbounded growth
 * @param {string} streamId - Stream identifier.
 * @param {string} chunkData - Chunk data payload.
 * @param {string} [chunkType='stdout'] - Chunk type.
 * @returns {number} Next sequence number for the stream.
 */
function addStreamChunk(streamId, chunkData, chunkType = 'stdout') {
  // Truncate chunk if too large
  let truncatedData = chunkData;
  if (typeof chunkData === 'string' && chunkData.length > MAX_CHUNK_SIZE_BYTES) {
    truncatedData = chunkData.slice(0, MAX_CHUNK_SIZE_BYTES) + '\n[...truncated...]';
  }

  const transaction = db.transaction(() => {
    // Check current stream size and chunk count
    const statsStmt = db.prepare(`
      SELECT COUNT(*) as chunk_count, COALESCE(SUM(LENGTH(chunk_data)), 0) as total_size
      FROM stream_chunks WHERE stream_id = ?
    `);
    const stats = statsStmt.get(streamId);

    // If at chunk limit or size limit, remove oldest chunks
    if (stats.chunk_count >= MAX_STREAM_CHUNKS || stats.total_size >= MAX_STREAM_SIZE_BYTES) {
      // Remove oldest 10% of chunks to make room
      const toDelete = Math.max(100, Math.floor(stats.chunk_count * 0.1));
      db.prepare(`
        DELETE FROM stream_chunks
        WHERE stream_id = ? AND id IN (
          SELECT id FROM stream_chunks WHERE stream_id = ?
          ORDER BY sequence_num ASC LIMIT ?
        )
      `).run(streamId, streamId, toDelete);
    }

    // Get next sequence number atomically within transaction
    const seqStmt = db.prepare(`
      SELECT COALESCE(MAX(sequence_num), 0) + 1 as next_seq
      FROM stream_chunks WHERE stream_id = ?
    `);
    const { next_seq } = seqStmt.get(streamId);

    const stmt = db.prepare(`
      INSERT INTO stream_chunks (stream_id, chunk_data, chunk_type, sequence_num, timestamp)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(streamId, truncatedData, chunkType, next_seq);

    return next_seq;
  });

  const seqResult = transaction();

  // --- Partial output accumulation (outside transaction) ---
  try {
    let taskId = _streamToTask.get(streamId);
    if (!taskId) {
      // DB fallback for post-restart orphaned streams
      const row = db.prepare('SELECT task_id FROM task_streams WHERE id = ?').get(streamId);
      if (row) {
        taskId = row.task_id;
        _streamToTask.set(streamId, taskId);
      }
    }
    if (taskId) {
      let entry = _partialOutputBuffers.get(taskId);
      if (!entry) {
        entry = { buffer: '', lastFlushAt: Date.now(), streamId };
        _partialOutputBuffers.set(taskId, entry);
      }
      // Use truncatedData (post-truncation variable) to match stream_chunks storage
      entry.buffer += (typeof truncatedData === 'string' ? truncatedData : String(truncatedData));
      entry.buffer = truncateBuffer(entry.buffer);

      const now = Date.now();
      if (now - entry.lastFlushAt >= FLUSH_INTERVAL_MS) {
        flushPartialOutput(taskId, entry.buffer);
        entry.lastFlushAt = now;
      }
    }
  } catch {
    // Non-fatal — never block chunk processing
  }

  return seqResult;
}

/**
 * Get stream chunks with optional filtering
 * @param {any} taskId
 * @param {any} options
 * @returns {any}
 */
function getStreamChunks(taskId, options = {}) {
  const { since, chunkType, limit = 100, offset = 0 } = options;

  let query = `
    SELECT sc.*, ts.task_id
    FROM stream_chunks sc
    JOIN task_streams ts ON sc.stream_id = ts.id
    WHERE ts.task_id = ?
  `;
  const params = [taskId];

  if (since) {
    query += ` AND sc.timestamp > ?`;
    params.push(since);
  }

  if (chunkType) {
    query += ` AND sc.chunk_type = ?`;
    params.push(chunkType);
  }

  query += ` ORDER BY sc.sequence_num ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get latest chunks from a stream (for streaming output)
 * @param {any} taskId
 * @param {any} lastSequence
 * @param {any} limit
 * @returns {any}
 */
function getLatestStreamChunks(taskId, lastSequence = 0, limit = 50) {
  const stmt = db.prepare(`
    SELECT sc.*, ts.task_id
    FROM stream_chunks sc
    JOIN task_streams ts ON sc.stream_id = ts.id
    WHERE ts.task_id = ? AND sc.sequence_num > ?
    ORDER BY sc.sequence_num ASC
    LIMIT ?
  `);
  return stmt.all(taskId, lastSequence, limit);
}

/**
 * Get task logs with filtering
 * @param {any} taskId
 * @param {any} options
 * @returns {any}
 */
function getTaskLogs(taskId, options = {}) {
  const { level, search, limit = 500 } = options;

  const chunks = getStreamChunks(taskId, { limit: 10000 });

  // Combine all chunks into logs
  let logs = chunks.map(c => ({
    timestamp: c.timestamp,
    type: c.chunk_type,
    content: c.chunk_data,
    sequence: c.sequence_num
  }));

  // Filter by level (stdout=info, stderr=error/warn)
  if (level) {
    if (level === 'error') {
      logs = logs.filter(l => l.type === 'stderr' || l.content.toLowerCase().includes('error'));
    } else if (level === 'warn') {
      logs = logs.filter(l => l.type === 'stderr' || l.content.toLowerCase().includes('warn'));
    }
  }

  // Filter by search pattern
  if (search) {
    function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    const regex = new RegExp(escapeRegex(search), 'i');
    logs = logs.filter(l => regex.test(l.content));
  }

  return logs.slice(0, limit);
}

/**
 * Clean up old stream data
 * Pre-calculates cutoff time to avoid race conditions with concurrent cleanup
 */
function cleanupStreamData(daysToKeep = 7) {
  // Bound daysToKeep to reasonable range (1-3650 days)
  const boundedDays = Math.max(1, Math.min(parseInt(daysToKeep, 10) || 7, 3650));

  // Pre-calculate cutoff time for consistent behavior
  const cutoffMs = Date.now() - (boundedDays * 24 * 60 * 60 * 1000);
  const cutoffDate = new Date(cutoffMs).toISOString();

  const chunksStmt = db.prepare(`
    DELETE FROM stream_chunks
    WHERE stream_id IN (
      SELECT id FROM task_streams WHERE created_at < ?
    )
  `);
  chunksStmt.run(cutoffDate);

  const streamsStmt = db.prepare(`
    DELETE FROM task_streams WHERE created_at < ?
  `);
  const result = streamsStmt.run(cutoffDate);
  return result.changes;
}

// ============================================================
// Wave 2 Phase 1: Event Subscription Functions
// ============================================================

/**
 * Create an event subscription
 */
function createEventSubscription(taskId, eventTypes, expiresInMinutes = 60) {
  const id = require('uuid').v4();
  const expiresAt = expiresInMinutes
    ? new Date(Date.now() + expiresInMinutes * 60000).toISOString()
    : null;

  const stmt = db.prepare(`
    INSERT INTO task_event_subscriptions (id, task_id, event_types, created_at, expires_at)
    VALUES (?, ?, ?, datetime('now'), ?)
  `);
  stmt.run(id, taskId, JSON.stringify(eventTypes), expiresAt);
  return id;
}

/**
 * Get events for a subscription (polling)
 * @param {any} subscriptionId
 * @returns {any}
 */
function pollSubscription(subscriptionId) {
  // Get subscription
  const subStmt = db.prepare(`
    SELECT * FROM task_event_subscriptions WHERE id = ?
  `);
  const sub = subStmt.get(subscriptionId);

  if (!sub) {
    return null;
  }

  // Check expiration
  if (sub.expires_at && new Date(sub.expires_at) < new Date()) {
    deleteEventSubscription(subscriptionId);
    return { expired: true, events: [] };
  }

  const lastPoll = sub.last_poll_at || sub.created_at;
  const eventTypes = safeJsonParse(sub.event_types, []);

  // Get events since last poll
  let query = `
    SELECT * FROM task_events
    WHERE created_at > ?
  `;
  const params = [lastPoll];

  if (sub.task_id) {
    query += ` AND task_id = ?`;
    params.push(sub.task_id);
  }

  if (eventTypes.length > 0 && !eventTypes.includes('*')) {
    query += ` AND event_type IN (${eventTypes.map(() => '?').join(',')})`;
    params.push(...eventTypes);
  }

  query += ` ORDER BY created_at ASC`;

  const eventsStmt = db.prepare(query);
  const events = eventsStmt.all(...params);

  // Update last poll time
  const updateStmt = db.prepare(`
    UPDATE task_event_subscriptions SET last_poll_at = datetime('now') WHERE id = ?
  `);
  updateStmt.run(subscriptionId);

  return { expired: false, events };
}

/**
 * Get events for a subscription after a resume cursor.
 * Cursor is expected to be a timestamp string matching task_events.created_at format.
 * @param {any} subscriptionId
 * @param {string} cursorToken
 * @returns {any}
 */
function pollSubscriptionAfterCursor(subscriptionId, cursorToken) {
  if (!subscriptionId) return null;
  const cursor = String(cursorToken).trim();
  if (!cursor || Number.isNaN(new Date(cursor).getTime())) {
    return pollSubscription(subscriptionId);
  }

  // Get subscription
  const subStmt = db.prepare(`
    SELECT * FROM task_event_subscriptions WHERE id = ?
  `);
  const sub = subStmt.get(subscriptionId);

  if (!sub) {
    return null;
  }

  // Check expiration
  if (sub.expires_at && new Date(sub.expires_at) < new Date()) {
    deleteEventSubscription(subscriptionId);
    return { expired: true, events: [] };
  }

  const eventTypes = safeJsonParse(sub.event_types, []);

  // Get events after cursor token
  let query = `
    SELECT * FROM task_events
    WHERE created_at > ?
  `;
  const params = [cursor];

  if (sub.task_id) {
    query += ` AND task_id = ?`;
    params.push(sub.task_id);
  }

  if (eventTypes.length > 0 && !eventTypes.includes('*')) {
    query += ` AND event_type IN (${eventTypes.map(() => '?').join(',')})`;
    params.push(...eventTypes);
  }

  query += ` ORDER BY created_at ASC`;

  const eventsStmt = db.prepare(query);
  const events = eventsStmt.all(...params);

  // Update last poll time
  const updateStmt = db.prepare(`
    UPDATE task_event_subscriptions SET last_poll_at = datetime('now') WHERE id = ?
  `);
  updateStmt.run(subscriptionId);

  return { expired: false, events };
}

/**
 * Record a task event
 * @param {any} taskId
 * @param {any} eventType
 * @param {any} oldValue
 * @param {any} newValue
 * @param {any} eventData
 * @returns {any}
 */
function recordTaskEvent(taskId, eventType, oldValue, newValue, eventData = null) {
  const stmt = db.prepare(`
    INSERT INTO task_events (task_id, event_type, old_value, new_value, event_data, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(taskId, eventType, oldValue, newValue, eventData ? JSON.stringify(eventData) : null);
}

/**
 * Get events for a task
 * @param {any} taskId
 * @param {any} options
 * @returns {any}
 */
function getTaskEvents(taskId, options = {}) {
  const { eventType, since, limit = 100 } = options;

  let query = `SELECT * FROM task_events WHERE task_id = ?`;
  const params = [taskId];

  if (eventType) {
    query += ` AND event_type = ?`;
    params.push(eventType);
  }

  if (since) {
    query += ` AND created_at > ?`;
    params.push(since);
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Delete an event subscription
 */
function deleteEventSubscription(subscriptionId) {
  const stmt = db.prepare(`DELETE FROM task_event_subscriptions WHERE id = ?`);
  const result = stmt.run(subscriptionId);
  return result.changes > 0;
}

/**
 * Clean up expired subscriptions and old events
 */
function cleanupEventData(eventDaysToKeep = 7) {
  // Bound daysToKeep to reasonable range (1-3650 days)
  const boundedDays = Math.max(1, Math.min(parseInt(eventDaysToKeep, 10) || 7, 3650));
  // Delete expired subscriptions
  const subStmt = db.prepare(`
    DELETE FROM task_event_subscriptions WHERE expires_at < datetime('now')
  `);
  subStmt.run();

  // Delete old events
  const eventStmt = db.prepare(`
    DELETE FROM task_events WHERE created_at < datetime('now', '-' || ? || ' days')
  `);
  const result = eventStmt.run(boundedDays);
  return result.changes;
}

/**
 * Cleanup analytics data to prevent unbounded growth
 * Enforces retention limits on analytics table
 */
function cleanupAnalytics(daysToKeep = 30) {
  // Bound daysToKeep to reasonable range (1-365 days for analytics)
  const boundedDays = Math.max(1, Math.min(parseInt(daysToKeep, 10) || 30, 365));

  const stmt = db.prepare(`
    DELETE FROM analytics WHERE timestamp < datetime('now', '-' || ? || ' days')
  `);
  const result = stmt.run(boundedDays);
  return result.changes;
}

/**
 * Cleanup coordination events to prevent unbounded growth
 */
function cleanupCoordinationEvents(daysToKeep = 14) {
  // Bound daysToKeep to reasonable range (1-90 days)
  const boundedDays = Math.max(1, Math.min(parseInt(daysToKeep, 10) || 14, 90));

  const stmt = db.prepare(`
    DELETE FROM coordination_events WHERE created_at < datetime('now', '-' || ? || ' days')
  `);
  const result = stmt.run(boundedDays);
  return result.changes;
}

// Maximum analytics records to keep (prevents unbounded growth even within retention period)
const MAX_ANALYTICS_RECORDS = 100000;
const MAX_COORDINATION_EVENTS = 50000;

/**
 * Enforce hard limits on event table sizes
 * Removes oldest records when tables exceed limits
 */
function enforceEventTableLimits() {
  let deleted = 0;

  // Check analytics table size
  const analyticsCount = db.prepare('SELECT COUNT(*) as count FROM analytics').get().count;
  if (analyticsCount > MAX_ANALYTICS_RECORDS) {
    const toDelete = analyticsCount - MAX_ANALYTICS_RECORDS + 1000; // Delete extra 1000 for buffer
    const result = db.prepare(`
      DELETE FROM analytics WHERE id IN (
        SELECT id FROM analytics ORDER BY timestamp ASC LIMIT ?
      )
    `).run(toDelete);
    deleted += result.changes;
  }

  // Check coordination_events table size
  const coordCount = db.prepare('SELECT COUNT(*) as count FROM coordination_events').get().count;
  if (coordCount > MAX_COORDINATION_EVENTS) {
    const toDelete = coordCount - MAX_COORDINATION_EVENTS + 500; // Delete extra 500 for buffer
    const result = db.prepare(`
      DELETE FROM coordination_events WHERE id IN (
        SELECT id FROM coordination_events ORDER BY created_at ASC LIMIT ?
      )
    `).run(toDelete);
    deleted += result.changes;
  }

  return deleted;
}

// ============================================================
// Wave 2 Phase 1: Checkpoint Functions for Pause/Resume
// ============================================================

/**
 * Save a checkpoint for a paused task
 * @param {any} taskId
 * @param {any} checkpointData
 * @param {any} checkpointType
 * @returns {any}
 */
function saveTaskCheckpoint(taskId, checkpointData, checkpointType = 'pause') {
  const stmt = db.prepare(`
    INSERT INTO task_checkpoints (task_id, checkpoint_data, checkpoint_type, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `);
  const result = stmt.run(taskId, JSON.stringify(checkpointData), checkpointType);
  return result.lastInsertRowid;
}

/**
 * Get the latest checkpoint for a task
 * @param {any} taskId
 * @returns {any}
 */
function getTaskCheckpoint(taskId) {
  const stmt = db.prepare(`
    SELECT * FROM task_checkpoints WHERE task_id = ?
    ORDER BY created_at DESC LIMIT 1
  `);
  const checkpoint = stmt.get(taskId);
  if (checkpoint && checkpoint.checkpoint_data) {
    checkpoint.checkpoint_data = safeJsonParse(checkpoint.checkpoint_data, null);
  }
  return checkpoint;
}

/**
 * Get all checkpoints for a task
 * @param {any} taskId
 * @returns {any}
 */
function getTaskCheckpoints(taskId) {
  const stmt = db.prepare(`
    SELECT * FROM task_checkpoints WHERE task_id = ?
    ORDER BY created_at DESC
  `);
  const checkpoints = stmt.all(taskId);
  return checkpoints.map(c => ({
    ...c,
    checkpoint_data: safeJsonParse(c.checkpoint_data, null)
  }));
}

/**
 * Delete checkpoints for a task
 */
function deleteTaskCheckpoints(taskId) {
  const stmt = db.prepare(`DELETE FROM task_checkpoints WHERE task_id = ?`);
  const result = stmt.run(taskId);
  return result.changes;
}

/**
 * Update task pause state
 * @param {any} taskId
 * @param {any} reason
 * @returns {any}
 */
function pauseTask(taskId, reason = null) {
  const stmt = db.prepare(`
    UPDATE tasks
    SET status = 'paused', paused_at = datetime('now'), pause_reason = ?
    WHERE id = ?
  `);
  const result = stmt.run(reason, taskId);
  if (result.changes > 0) {
    recordTaskEvent(taskId, 'status_change', 'running', 'paused', { reason });
  }
  return result.changes > 0;
}

/**
 * Clear pause state when resuming
 */
function clearPauseState(taskId) {
  const stmt = db.prepare(`
    UPDATE tasks
    SET paused_at = NULL, pause_reason = NULL
    WHERE id = ?
  `);
  return stmt.run(taskId);
}

/**
 * List all paused tasks
 * @param {any} options
 * @returns {any}
 */
function listPausedTasks(options = {}) {
  const { project, limit = 50 } = options;

  let query = `
    SELECT *,
      ROUND((JULIANDAY('now') - JULIANDAY(paused_at)) * 24 * 60, 1) as paused_minutes
    FROM tasks
    WHERE status = 'paused'
  `;
  const params = [];

  if (project) {
    query += ` AND project = ?`;
    params.push(project);
  }

  query += ` ORDER BY paused_at DESC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Factory function for DI container.
 * @param {{ db: object }} deps
 */
function createWebhooksStreaming({ db: dbInstance }) {
  setDb(dbInstance);
  return {
    createWebhook,
    getWebhook,
    setWebhookDeliveryExecutor,
    listWebhooks,
    updateWebhook,
    deleteWebhook,
    getWebhooksForEvent,
    logWebhookDelivery,
    getWebhookLogs,
    getWebhookStats,
    cleanupWebhookLogs,
    enforceWebhookLogLimits,
    cleanupStaleWebhookRetries,
    createTaskStream,
    getOrCreateTaskStream,
    getStreamTaskId,
    getPartialOutputBuffer,
    clearPartialOutputBuffer,
    addStreamChunk,
    getStreamChunks,
    getLatestStreamChunks,
    getTaskLogs,
    cleanupStreamData,
    createEventSubscription,
    pollSubscription,
    pollSubscriptionAfterCursor,
    recordTaskEvent,
    getTaskEvents,
    deleteEventSubscription,
    cleanupEventData,
    cleanupAnalytics,
    cleanupCoordinationEvents,
    enforceEventTableLimits,
    saveTaskCheckpoint,
    getTaskCheckpoint,
    getTaskCheckpoints,
    deleteTaskCheckpoints,
    pauseTask,
    clearPauseState,
    listPausedTasks,
  };
}

module.exports = {
  setDb,
  createWebhooksStreaming,
  // Webhooks
  createWebhook,
  getWebhook,
  setWebhookDeliveryExecutor,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  getWebhooksForEvent,
  logWebhookDelivery,
  getWebhookLogs,
  getWebhookStats,
  cleanupWebhookLogs,
  enforceWebhookLogLimits,
  cleanupStaleWebhookRetries,
  // Real-time Streaming
  createTaskStream,
  getOrCreateTaskStream,
  getStreamTaskId,
  getPartialOutputBuffer,
  clearPartialOutputBuffer,
  addStreamChunk,
  getStreamChunks,
  getLatestStreamChunks,
  getTaskLogs,
  cleanupStreamData,
  // Event Subscriptions
  createEventSubscription,
  pollSubscription,
  pollSubscriptionAfterCursor,
  recordTaskEvent,
  getTaskEvents,
  deleteEventSubscription,
  cleanupEventData,
  cleanupAnalytics,
  cleanupCoordinationEvents,
  enforceEventTableLimits,
  // Checkpoints / Pause
  saveTaskCheckpoint,
  getTaskCheckpoint,
  getTaskCheckpoints,
  deleteTaskCheckpoints,
  pauseTask,
  clearPauseState,
  listPausedTasks,
};
