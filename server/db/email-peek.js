'use strict';

/**
 * Email notification + Peek host + Failover event tracking
 * Extracted from database.js (Phase 5.2 / D1.2)
 */
const logger = require('../logger').child({ component: 'email-peek' });

let _db = null;

function setDb(dbInstance) {
  _db = dbInstance;
}

// ============================================================
// Failover event tracking (RB-029)
// ============================================================

/**
 * Record a structured failover event.
 */
function recordFailoverEvent(event) {
  if (!event || !event.task_id || !event.reason) return;
  try {
    _db.prepare(`
      INSERT INTO failover_events (task_id, from_provider, to_provider, from_model, to_model, from_host, to_host, reason, failover_type, attempt_num, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.task_id,
      event.from_provider || null,
      event.to_provider || null,
      event.from_model || null,
      event.to_model || null,
      event.from_host || null,
      event.to_host || null,
      event.reason,
      event.failover_type || 'provider',
      event.attempt_num || 1,
      new Date().toISOString()
    );
  } catch (err) {
    logger.debug(`Failed to record failover event: ${err.message}`);
  }
}

/**
 * Get failover history for a task.
 */
function getFailoverEvents(taskId) {
  return _db.prepare('SELECT * FROM failover_events WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
}

// ============================================================
// Email notification operations
// ============================================================

/**
 * Record an email notification in the database.
 */
function recordEmailNotification(notification) {
  if (!notification.id || !notification.recipient || !notification.subject) {
    throw new Error('id, recipient, and subject are required');
  }
  const stmt = _db.prepare(`
    INSERT INTO email_notifications (id, task_id, recipient, subject, status, error, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    notification.id,
    notification.task_id || null,
    notification.recipient,
    notification.subject,
    notification.status || 'pending',
    notification.error || null,
    notification.sent_at || new Date().toISOString()
  );
  return getEmailNotification(notification.id);
}

/**
 * List email notifications with optional filters.
 */
function listEmailNotifications(options = {}) {
  let query = 'SELECT * FROM email_notifications';
  const conditions = [];
  const values = [];

  if (options.status) {
    conditions.push('status = ?');
    values.push(options.status);
  }

  if (options.task_id) {
    conditions.push('task_id = ?');
    values.push(options.task_id);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY sent_at DESC';

  const MAX_LIMIT = 1000;
  const DEFAULT_LIMIT = 100;
  const limit = Math.max(1, Math.min(parseInt(options.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT));
  query += ' LIMIT ?';
  values.push(limit);

  if (options.offset && options.offset > 0) {
    query += ' OFFSET ?';
    values.push(parseInt(options.offset, 10));
  }

  return _db.prepare(query).all(...values);
}

/**
 * Get a single email notification by ID.
 */
function getEmailNotification(id) {
  if (!id) return null;
  return _db.prepare('SELECT * FROM email_notifications WHERE id = ?').get(id) || null;
}

/**
 * Update the status of an email notification.
 */
function updateEmailNotificationStatus(id, status, error = null) {
  if (!id || !status) {
    throw new Error('id and status are required');
  }
  _db.prepare('UPDATE email_notifications SET status = ?, error = ? WHERE id = ?').run(status, error, id);
  return getEmailNotification(id);
}

// ============================================================
// Peek host operations
// ============================================================

function registerPeekHost(name, url, ssh, isDefault, platform) {
  if (isDefault) {
    _db.prepare('UPDATE peek_hosts SET is_default = 0').run();
  }
  _db.prepare('INSERT OR REPLACE INTO peek_hosts (name, url, ssh, is_default, platform) VALUES (?, ?, ?, ?, ?)').run(name, url, ssh || null, isDefault ? 1 : 0, platform || null);
}

function unregisterPeekHost(name) {
  const result = _db.prepare('DELETE FROM peek_hosts WHERE name = ?').run(name);
  return result.changes > 0;
}

function listPeekHosts() {
  return _db.prepare('SELECT * FROM peek_hosts ORDER BY is_default DESC, name ASC').all();
}

function getDefaultPeekHost() {
  // @full-scan: peek_hosts is operator-managed with one row per email
  // host; .get() short-circuits at the first match anyway.
  return _db.prepare('SELECT * FROM peek_hosts WHERE is_default = 1').get() || null;
}

function getPeekHost(name) {
  return _db.prepare('SELECT * FROM peek_hosts WHERE name = ?').get(name) || null;
}

function updatePeekHost(name, updates) {
  const allowedFields = ['url', 'ssh', 'is_default', 'platform', 'enabled'];
  const sets = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      sets.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (sets.length === 0) return false;
  values.push(name);
  return _db.prepare(`UPDATE peek_hosts SET ${sets.join(', ')} WHERE name = ?`).run(...values).changes > 0;
}

function createEmailPeek({ db: dbInst }) {
  setDb(dbInst);
  return {
    recordFailoverEvent,
    getFailoverEvents,
    recordEmailNotification,
    listEmailNotifications,
    getEmailNotification,
    updateEmailNotificationStatus,
    registerPeekHost,
    unregisterPeekHost,
    listPeekHosts,
    getDefaultPeekHost,
    getPeekHost,
    updatePeekHost,
  };
}

module.exports = {
  setDb,
  createEmailPeek,
  recordFailoverEvent,
  getFailoverEvents,
  recordEmailNotification,
  listEmailNotifications,
  getEmailNotification,
  updateEmailNotificationStatus,
  registerPeekHost,
  unregisterPeekHost,
  listPeekHosts,
  getDefaultPeekHost,
  getPeekHost,
  updatePeekHost,
};
