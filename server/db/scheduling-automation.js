'use strict';

/**
 * Scheduling & Automation Module
 *
 * Extracted from database.js — templates, maintenance schedules, task scheduling,
 * approval workflows, collaboration & audit, cron/extended scheduling,
 * resource usage tracking, and reporting functions.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 * Uses setter injection for cross-module dependencies (getTask, recordTaskEvent, etc.)
 */

let db;
let _getTaskFn;
let recordTaskEventFn;
let getPipelineFn;
let createPipelineFn;
const { createHash } = require('crypto');
const { safeJsonParse } = require('../utils/json');
const eventBus = require('../event-bus');

function setDb(dbInstance) {
  db = dbInstance;
}

function setGetTask(fn) {
  _getTaskFn = fn;
}

function setRecordTaskEvent(fn) {
  recordTaskEventFn = fn;
}

function setGetPipeline(fn) {
  getPipelineFn = fn;
}

function setCreatePipeline(fn) {
  createPipelineFn = fn;
}

function getAuditLogColumns() {
  if (!db) {
    return { chainSupported: false, previousHashColumn: false, chainHashColumn: false };
  }

  const pragmaResult = db.prepare('PRAGMA table_info(audit_log)').all();
  const columns = new Set(pragmaResult.map((column) => column.name));

  const hasPreviousHash = columns.has('previous_hash');
  const hasChainHash = columns.has('chain_hash');

  return {
    chainSupported: hasPreviousHash && hasChainHash,
    previousHashColumn: hasPreviousHash,
    chainHashColumn: hasChainHash,
  };
}

function getLatestAuditChainHash() {
  const columns = getAuditLogColumns();
  if (!columns.chainSupported) return null;

  const row = db.prepare('SELECT chain_hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return row ? row.chain_hash : null;
}

function normalizeAuditField(value) {
  if (value === undefined) return null;
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

function computeAuditChainHash(payload) {
  const text = JSON.stringify(payload);
  return createHash('sha256').update(text).digest('hex');
}


// ============================================
// Templates
// ============================================

/**
 * Create or update a template
 * @param {any} template
 * @returns {any}
 */
function saveTemplate(template) {
  const stmt = db.prepare(`
    INSERT INTO templates (
      name, description, task_template, default_timeout,
      default_priority, auto_approve, created_at, usage_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(name) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      task_template = excluded.task_template,
      default_timeout = excluded.default_timeout,
      default_priority = excluded.default_priority,
      auto_approve = excluded.auto_approve,
      usage_count = usage_count
  `);

  stmt.run(
    template.name,
    template.description || null,
    template.task_template,
    template.default_timeout || 30,
    template.default_priority || 0,
    template.auto_approve ? 1 : 0,
    new Date().toISOString()
  );

  return getTemplate(template.name);
}

/**
 * Get a template by name
 * @param {any} name
 * @returns {any}
 */
function getTemplate(name) {
  const stmt = db.prepare('SELECT * FROM templates WHERE name = ?');
  const row = stmt.get(name);
  if (row) {
    row.auto_approve = Boolean(row.auto_approve);
  }
  return row;
}

/**
 * List all templates
 * @returns {any}
 */
function listTemplates() {
  const stmt = db.prepare('SELECT * FROM templates ORDER BY usage_count DESC');
  return stmt.all().map(row => ({
    ...row,
    auto_approve: Boolean(row.auto_approve)
  }));
}

/**
 * Increment template usage count
 * @param {any} name
 * @returns {any}
 */
function incrementTemplateUsage(name) {
  const stmt = db.prepare('UPDATE templates SET usage_count = usage_count + 1 WHERE name = ?');
  stmt.run(name);
}

/**
 * Delete a template
 */
function deleteTemplate(name) {
  const stmt = db.prepare('DELETE FROM templates WHERE name = ?');
  const result = stmt.run(name);
  return result.changes > 0;
}

// ============================================
// Maintenance Schedules
// ============================================

/**
 * Create or update a maintenance schedule
 * @param {any} schedule
 * @returns {any}
 */
function setMaintenanceSchedule(schedule) {
  const intervalMinutes = normalizeMaintenanceInterval(schedule);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO maintenance_schedule (id, task_type, schedule_type, interval_minutes, cron_expression, next_run_at, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM maintenance_schedule WHERE id = ?), ?))
  `);

  const now = new Date().toISOString();
  const nextRun = schedule.next_run_at || calculateNextMaintenanceRun(schedule);

  stmt.run(
    schedule.id,
    schedule.task_type,
    schedule.schedule_type,
    intervalMinutes,
    schedule.cron_expression || null,
    nextRun,
    schedule.enabled !== false ? 1 : 0,
    schedule.id,
    now
  );

  return getMaintenanceSchedule(schedule.id);
}

function normalizeMaintenanceInterval(schedule) {
  const isInterval = schedule?.schedule_type === 'interval';
  if (!isInterval) {
    return null;
  }

  if (schedule.interval_minutes === undefined || schedule.interval_minutes === null) {
    throw new Error('INTERVAL_MINUTES_REQUIRED: interval_minutes is required for interval schedules');
  }

  if (
    typeof schedule.interval_minutes !== 'number' ||
    !Number.isFinite(schedule.interval_minutes) ||
    !Number.isInteger(schedule.interval_minutes) ||
    schedule.interval_minutes <= 0
  ) {
    throw new Error('INTERVAL_MINUTES_INVALID: interval_minutes must be a positive integer');
  }

  return schedule.interval_minutes;
}

/**
 * Get a maintenance schedule
 * @param {any} id
 * @returns {any}
 */
function getMaintenanceSchedule(id) {
  const stmt = db.prepare('SELECT * FROM maintenance_schedule WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.enabled = Boolean(row.enabled);
  }
  return row;
}

/**
 * List maintenance schedules
 * @returns {any}
 */
function listMaintenanceSchedules() {
  return db.prepare('SELECT * FROM maintenance_schedule ORDER BY task_type').all().map(row => ({
    ...row,
    enabled: Boolean(row.enabled)
  }));
}

/**
 * Get due maintenance tasks
 * @returns {any}
 */
function getDueMaintenanceTasks() {
  // Exclude NULL next_run_at — cron schedules with no parser return NULL,
  // and including them would fire the task on every tick
  const stmt = db.prepare(`
    SELECT * FROM maintenance_schedule
    WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
  `);
  return stmt.all(new Date().toISOString()).map(row => ({
    ...row,
    enabled: Boolean(row.enabled)
  }));
}

/**
 * Mark maintenance task as run
 * @param {any} id
 * @returns {any}
 */
function markMaintenanceRun(id) {
  const schedule = getMaintenanceSchedule(id);
  if (!schedule) return null;

  const nextRun = calculateNextMaintenanceRun(schedule);
  db.prepare('UPDATE maintenance_schedule SET last_run_at = ?, next_run_at = ? WHERE id = ?')
    .run(new Date().toISOString(), nextRun, id);

  return getMaintenanceSchedule(id);
}

/**
 * Calculate next maintenance run time
 */
function calculateNextMaintenanceRun(schedule) {
  if (schedule.schedule_type === 'interval') {
    const intervalMinutes = normalizeMaintenanceInterval(schedule);
    return new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString();
  }
  // For cron, would need a cron parser - for now just use interval
  return null;
}

/**
 * Delete a maintenance schedule
 */
function deleteMaintenanceSchedule(id) {
  const result = db.prepare('DELETE FROM maintenance_schedule WHERE id = ?').run(id);
  return result.changes > 0;
}

// ============================================
// Approval Workflows
// ============================================

/**
 * Create an approval rule
 */
function createApprovalRule(name, ruleType, condition, options = {}) {
  const id = require('uuid').v4();
  const { project, requiredApprovers = 1, autoApproveAfterMinutes } = options;

  const stmt = db.prepare(`
    INSERT INTO approval_rules (id, name, project, rule_type, condition, required_approvers, auto_approve_after_minutes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, name, project, ruleType, JSON.stringify(condition), requiredApprovers, autoApproveAfterMinutes, new Date().toISOString());
  return id;
}

/**
 * Get an approval rule by ID
 */
function getApprovalRule(ruleId) {
  const stmt = db.prepare(`SELECT * FROM approval_rules WHERE id = ?`);
  const rule = stmt.get(ruleId);
  if (rule && rule.condition) {
    rule.condition = safeJsonParse(rule.condition, {});
  }
  return rule;
}

/**
 * List approval rules with optional filtering
 * @param {any} options
 * @returns {any}
 */
function listApprovalRules(options = {}) {
  const { project, ruleType, enabledOnly = true, limit = 50 } = options;

  let query = `SELECT * FROM approval_rules WHERE 1=1`;
  const params = [];

  if (enabledOnly) {
    query += ` AND enabled = 1`;
  }

  if (project) {
    query += ` AND (project = ? OR project IS NULL)`;
    params.push(project);
  }

  if (ruleType) {
    query += ` AND rule_type = ?`;
    params.push(ruleType);
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(query);
  const rules = stmt.all(...params);

  return rules.map(r => ({
    ...r,
    condition: safeJsonParse(r.condition, null)
  }));
}

/**
 * Update an approval rule
 * @param {any} ruleId
 * @param {any} updates
 * @returns {any}
 */
function updateApprovalRule(ruleId, updates) {
  const fields = [];
  const params = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    params.push(updates.name);
  }
  if (updates.condition !== undefined) {
    fields.push('condition = ?');
    params.push(JSON.stringify(updates.condition));
  }
  if (updates.requiredApprovers !== undefined) {
    fields.push('required_approvers = ?');
    params.push(updates.requiredApprovers);
  }
  if (updates.autoApproveAfterMinutes !== undefined) {
    fields.push('auto_approve_after_minutes = ?');
    params.push(updates.autoApproveAfterMinutes);
  }
  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    params.push(updates.enabled ? 1 : 0);
  }

  if (fields.length === 0) return false;

  fields.push('updated_at = datetime(\'now\')');
  params.push(ruleId);

  const stmt = db.prepare(`UPDATE approval_rules SET ${fields.join(', ')} WHERE id = ?`);
  return stmt.run(...params).changes > 0;
}

/**
 * Delete an approval rule
 */
function deleteApprovalRule(ruleId) {
  const stmt = db.prepare(`DELETE FROM approval_rules WHERE id = ?`);
  return stmt.run(ruleId).changes > 0;
}

/**
 * Check if a task requires approval based on rules
 * @param {object|string} taskOrId - Task record or task id.
 * @returns {object} Approval requirement result.
 */
function checkApprovalRequired(taskOrId) {
  const taskId = typeof taskOrId === 'string' ? taskOrId : (taskOrId ? taskOrId.id : null);
  const task = taskOrId && typeof taskOrId !== 'string' ? taskOrId : (taskId ? _getTaskFn(taskId) : null);
  if (!task) return { required: false, status: 'not_required', rule: null };

  const existingApproval = db.prepare(
    `SELECT * FROM approval_requests WHERE task_id = ? ORDER BY requested_at DESC LIMIT 1`
  ).get(task.id);

  if (existingApproval) {
    return {
      required: true,
      status: existingApproval.status || 'pending',
      rule: getApprovalRule(existingApproval.rule_id)
    };
  }

  const rules = listApprovalRules({ project: task.project });
  if (rules.length === 0) {
    return { required: false, status: 'not_required', rule: null };
  }

  for (const rule of rules) {
    if (evaluateApprovalRule(rule, task)) {
      if (taskId) {
        const approvalId = `apr-${taskId}-${rule.id}`;
        const createRequestTxn = db.transaction(() => {
          db.prepare(
            `INSERT OR IGNORE INTO approval_requests (id, task_id, rule_id, status, requested_at) VALUES (?, ?, ?, 'pending', ?)`
          ).run(approvalId, task.id, rule.id, new Date().toISOString());
          db.prepare(`UPDATE tasks SET approval_status = 'pending' WHERE id = ?`).run(task.id);
        });

        createRequestTxn();
      }
      return { required: true, status: 'pending', rule };
    }
  }

  return { required: false, status: 'not_required', rule: null };
}

/**
 * Backward-compatible rule evaluation alias for queue enforcement.
 * @param {any} rule
 * @param {any} task
 * @returns {boolean}
 */
function evaluateApprovalRule(rule, task) {
  return matchesApprovalRule(task, rule);
}

/**
 * Check if a task matches an approval rule condition
 * @param {any} task
 * @param {any} rule
 * @returns {any}
 */
function matchesApprovalRule(task, rule) {
  const condition = rule.condition;
  if (!condition) return false;

  // Match by rule type
  switch (rule.rule_type) {
    case 'auto_approve':
      // Tasks with auto_approve=true require approval
      return task.auto_approve === 1 || task.auto_approve === true;

    case 'directory':
      // Tasks in specific directories require approval
      if (condition.directories && task.working_directory) {
        return condition.directories.some(dir =>
          task.working_directory.includes(dir)
        );
      }
      return false;

    case 'keyword':
      // Tasks with specific keywords require approval
      if (condition.keywords && task.task_description) {
        const desc = task.task_description.toLowerCase();
        return condition.keywords.some(kw =>
          desc.includes(kw.toLowerCase())
        );
      }
      return false;

    case 'priority':
      // Tasks above priority threshold require approval
      return condition.minPriority !== undefined && task.priority >= condition.minPriority;

    case 'all':
      // All tasks require approval
      return true;

    default:
      return false;
  }
}

/**
 * Create an approval request for a task
 */
function createApprovalRequest(taskId, ruleId) {
  if (!taskId || !ruleId) {
    throw new Error('taskId and ruleId are required');
  }

  const id = require('uuid').v4();

  const transaction = db.transaction(() => {
    // Check if an approval already exists for this task+rule
    const existing = db.prepare(`
      SELECT id, status
      FROM approval_requests
      WHERE task_id = ? AND rule_id = ?
    `).get(taskId, ruleId);

    if (existing) {
      // Duplicate request — return existing ID without reverting approval state
      return existing.id;
    }

    // New request — insert and set task to pending
    db.prepare(`
      INSERT INTO approval_requests (id, task_id, rule_id, status, requested_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(id, taskId, ruleId, new Date().toISOString());

    db.prepare(`UPDATE tasks SET approval_status = 'pending' WHERE id = ?`).run(taskId);

    return id;
  });

  return transaction();
}

/**
 * Get approval request for a task
 */
function getApprovalRequest(taskId) {
  const stmt = db.prepare(`
    SELECT ar.*, r.name as rule_name, r.rule_type, r.auto_approve_after_minutes
    FROM approval_requests ar
    JOIN approval_rules r ON ar.rule_id = r.id
    WHERE ar.task_id = ?
    ORDER BY ar.requested_at DESC
    LIMIT 1
  `);
  return stmt.get(taskId);
}

/**
 * Approve a task
 * @param {string} taskId - Task identifier.
 * @param {string} approvedBy - Approver identifier.
 * @param {string|null} [comment=null] - Optional approval comment.
 * @returns {boolean} True when approval is recorded.
 */
function approveTask(taskId, approvedBy, comment = null) {
  const transaction = db.transaction(() => {
    const request = getApprovalRequest(taskId);
    if (!request) {
      throw new Error(`No approval request found for task: ${taskId}`);
    }

    // Use atomic UPDATE with WHERE status = 'pending' to prevent race conditions
    // If another process already approved/rejected, changes will be 0
    const stmt = db.prepare(`
      UPDATE approval_requests
      SET status = 'approved', approved_at = datetime('now'), approved_by = ?, comment = ?
      WHERE id = ? AND status = 'pending'
    `);
    const result = stmt.run(approvedBy, comment, request.id);

    // If no rows changed, the approval was already processed
    if (result.changes === 0) {
      // Re-fetch to get the actual status for error message
      const current = getApprovalRequest(taskId);
      throw new Error(`Approval request is not pending (status: ${current?.status || 'unknown'})`);
    }

    // Update task approval status
    db.prepare(`UPDATE tasks SET approval_status = 'approved' WHERE id = ?`).run(taskId);

    // Record event
    if (recordTaskEventFn) {
      recordTaskEventFn(taskId, 'approval', 'pending', 'approved', { approvedBy, comment });
    }

    recordAuditLog(
      'task',
      taskId,
      'approval',
      approvedBy,
      null,
      JSON.stringify({ approvalStatus: 'approved', requestStatus: 'approved' })
    );

    eventBus.emitQueueChanged();

    return true;
  });

  return transaction();
}

/**
 * Reject a task approval
 * @param {any} taskId
 * @param {any} rejectedBy
 * @param {any} comment
 * @returns {any}
 */
function rejectApproval(taskId, rejectedBy, comment = null) {
  const transaction = db.transaction(() => {
    const request = getApprovalRequest(taskId);
    if (!request) {
      throw new Error(`No approval request found for task: ${taskId}`);
    }

    // Use atomic UPDATE with WHERE status = 'pending' to prevent race conditions
    // If another process already approved/rejected, changes will be 0
    const stmt = db.prepare(`
      UPDATE approval_requests
      SET status = 'rejected', updated_at = datetime('now'), approved_by = ?, comment = ?
      WHERE id = ? AND status = 'pending'
    `);
    const result = stmt.run(rejectedBy, comment, request.id);

    // If no rows changed, the approval was already processed
    if (result.changes === 0) {
      // Re-fetch to get the actual status for error message
      const current = getApprovalRequest(taskId);
      throw new Error(`Approval request is not pending (status: ${current?.status || 'unknown'})`);
    }

    const rejectionMessage = `Approval rejected by ${rejectedBy}: ${comment || 'no reason'}`;

    // Update task approval status and cancel queued/pending tasks
    db.prepare(`
      UPDATE tasks
      SET
        approval_status = 'rejected',
        status = CASE WHEN status IN ('pending', 'queued') THEN 'cancelled' ELSE status END,
        error_output = CASE WHEN status IN ('pending', 'queued') THEN ? ELSE error_output END
      WHERE id = ?
    `).run(rejectionMessage, taskId);

    // Record event
    if (recordTaskEventFn) {
      recordTaskEventFn(taskId, 'approval', 'pending', 'rejected', { rejectedBy, comment });
    }

    recordAuditLog(
      'task',
      taskId,
      'approval',
      rejectedBy,
      null,
      JSON.stringify({ approvalStatus: 'rejected', requestStatus: 'rejected' })
    );

    return true;
  });

  return transaction();
}

/**
 * List pending approvals
 * @param {any} options
 * @returns {any}
 */
function listPendingApprovals(options = {}) {
  const { project, limit = 50 } = options;

  let query = `
    SELECT ar.*, t.task_description, t.project, t.priority, t.auto_approve, t.created_at as task_created_at,
           r.name as rule_name, r.rule_type, r.auto_approve_after_minutes,
           ROUND((JULIANDAY('now') - JULIANDAY(ar.requested_at)) * 24 * 60, 1) as waiting_minutes
    FROM approval_requests ar
    JOIN tasks t ON ar.task_id = t.id
    JOIN approval_rules r ON ar.rule_id = r.id
    WHERE ar.status = 'pending'
  `;
  const params = [];

  if (project) {
    query += ` AND t.project = ?`;
    params.push(project);
  }

  query += ` ORDER BY ar.requested_at ASC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Check and process auto-approvals
 * @returns {any}
 */
function processAutoApprovals() {
  const pending = db.prepare(`
    SELECT ar.*, r.auto_approve_after_minutes
    FROM approval_requests ar
    JOIN approval_rules r ON ar.rule_id = r.id
    WHERE ar.status = 'pending'
      AND r.auto_approve_after_minutes IS NOT NULL
      AND r.auto_approve_after_minutes > 0
      AND datetime(ar.requested_at, '+' || r.auto_approve_after_minutes || ' minutes') <= datetime('now')
  `).all();

  let autoApproved = 0;
  const approveRequestStmt = db.prepare(`
    UPDATE approval_requests
    SET status = 'approved', approved_at = ?, approved_by = 'auto', auto_approved = 1
    WHERE id = ?
  `);
  const approveTaskStmt = db.prepare(`UPDATE tasks SET approval_status = 'approved' WHERE id = ?`);
  for (const request of pending) {
    approveRequestStmt.run(new Date().toISOString(), request.id);
    approveTaskStmt.run(request.task_id);
    if (recordTaskEventFn) {
      recordTaskEventFn(request.task_id, 'approval', 'pending', 'auto_approved', null);
    }
    autoApproved++;
  }

  // Wake the scheduler so auto-approved tasks get picked up immediately
  if (autoApproved > 0) {
    eventBus.emitQueueChanged();
  }

  return autoApproved;
}

/**
 * Get approval history for a task
 */
function getApprovalHistory(taskId) {
  const stmt = db.prepare(`
    SELECT ar.*, r.name as rule_name, r.rule_type
    FROM approval_requests ar
    JOIN approval_rules r ON ar.rule_id = r.id
    WHERE ar.task_id = ?
    ORDER BY ar.requested_at DESC
  `);
  return stmt.all(taskId);
}

// ============================================
// Collaboration & Audit
// ============================================

// Comments and Timeline functions are in db/task-metadata.js

/**
 * Record an audit log entry
 * @param {any} entityType
 * @param {any} entityId
 * @param {any} action
 * @param {any} actor
 * @param {any} oldValue
 * @param {any} newValue
 * @param {any} metadata
 * @returns {any}
 */
function recordAuditLog(entityType, entityId, action, actor = 'system', oldValue = null, newValue = null, metadata = null) {
  // Check if auditing is enabled for this action
  const auditEnabled = getAuditConfig('enabled');
  if (auditEnabled === '0') return null;

  const trackedActions = getAuditConfig('tracked_actions');
  if (trackedActions && trackedActions !== '*') {
    const actions = safeJsonParse(trackedActions, []);
    if (Array.isArray(actions) && !actions.includes(action) && !actions.includes('*')) return null;
  }

  const eventTimestamp = new Date().toISOString();
  const normalizedOldValue = normalizeAuditField(oldValue);
  const normalizedNewValue = normalizeAuditField(newValue);
  const normalizedMetadata = normalizeAuditField(metadata);

  const columns = getAuditLogColumns();
  if (columns.chainSupported) {
    const insertChainedAudit = db.transaction(() => {
      const previousHash = getLatestAuditChainHash();
      const chainHash = computeAuditChainHash({
        entityType,
        entityId,
        action,
        actor,
        oldValue: normalizedOldValue,
        newValue: normalizedNewValue,
        metadata: normalizedMetadata,
        previousHash,
        timestamp: eventTimestamp,
      });

      const stmt = db.prepare(`
        INSERT INTO audit_log (entity_type, entity_id, action, actor, old_value, new_value, metadata, previous_hash, chain_hash, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        entityType,
        entityId,
        action,
        actor,
        normalizedOldValue,
        normalizedNewValue,
        normalizedMetadata,
        previousHash,
        chainHash,
        eventTimestamp,
      );

      return result.lastInsertRowid;
    });

    return insertChainedAudit();
  }

  const stmt = db.prepare(`
    INSERT INTO audit_log (entity_type, entity_id, action, actor, old_value, new_value, metadata, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    entityType,
    entityId,
    action,
    actor,
    normalizedOldValue,
    normalizedNewValue,
    normalizedMetadata,
    eventTimestamp,
  );

  return result.lastInsertRowid;
}

/**
 * Query audit log
 * @param {any} options
 * @returns {any}
 */
function getAuditLog(options = {}) {
  const { entityType, entityId, action, actor, since, until, limit = 100, offset = 0 } = options;

  let query = `SELECT * FROM audit_log WHERE 1=1`;
  const params = [];

  if (entityType) {
    query += ` AND entity_type = ?`;
    params.push(entityType);
  }

  if (entityId) {
    query += ` AND entity_id = ?`;
    params.push(entityId);
  }

  if (action) {
    query += ` AND action = ?`;
    params.push(action);
  }

  if (actor) {
    query += ` AND actor = ?`;
    params.push(actor);
  }

  if (since) {
    query += ` AND timestamp >= ?`;
    params.push(since);
  }

  if (until) {
    query += ` AND timestamp <= ?`;
    params.push(until);
  }

  query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get audit log count for filtering
 * @param {any} options
 * @returns {any}
 */
function getAuditLogCount(options = {}) {
  const { entityType, entityId, action, actor, since, until } = options;

  let query = `SELECT COUNT(*) as count FROM audit_log WHERE 1=1`;
  const params = [];

  if (entityType) {
    query += ` AND entity_type = ?`;
    params.push(entityType);
  }

  if (entityId) {
    query += ` AND entity_id = ?`;
    params.push(entityId);
  }

  if (action) {
    query += ` AND action = ?`;
    params.push(action);
  }

  if (actor) {
    query += ` AND actor = ?`;
    params.push(actor);
  }

  if (since) {
    query += ` AND timestamp >= ?`;
    params.push(since);
  }

  if (until) {
    query += ` AND timestamp <= ?`;
    params.push(until);
  }

  const stmt = db.prepare(query);
  return stmt.get(...params).count;
}

/**
 * Export audit log to various formats
 */
function exportAuditLog(options = {}) {
  const { format = 'json', since, until, limit = 10000 } = options;

  const logs = getAuditLog({ since, until, limit });

  if (format === 'json') {
    return JSON.stringify(logs, null, 2);
  }

  if (format === 'csv') {
    if (logs.length === 0) return 'id,entity_type,entity_id,action,actor,old_value,new_value,timestamp\n';

    const headers = ['id', 'entity_type', 'entity_id', 'action', 'actor', 'old_value', 'new_value', 'timestamp'];
    const rows = logs.map(log =>
      headers.map(h => {
        const val = log[h];
        if (val === null || val === undefined) return '';
        const str = String(val).replace(/"/g, '""');
        return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
      }).join(',')
    );

    return [headers.join(','), ...rows].join('\n');
  }

  return logs;
}

/**
 * Get audit configuration
 * @param {any} key
 * @returns {any}
 */
function getAuditConfig(key) {
  const stmt = db.prepare(`SELECT value FROM audit_config WHERE key = ?`);
  const row = stmt.get(key);
  return row ? row.value : null;
}

/**
 * Set audit configuration
 * @param {any} key
 * @param {any} value
 * @returns {any}
 */
function setAuditConfig(key, value) {
  const stmt = db.prepare(`
    INSERT INTO audit_config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `);
  stmt.run(key, value, value);
  return true;
}

/**
 * Get all audit configuration
 */
function getAllAuditConfig() {
  const stmt = db.prepare(`SELECT * FROM audit_config`);
  const rows = stmt.all();
  const config = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

/**
 * Clean up old audit logs
 */
function cleanupAuditLog(daysToKeep = 90) {
  const retentionDays = getAuditConfig('retention_days');
  const rawDays = retentionDays ? parseInt(retentionDays, 10) : daysToKeep;
  // Bound daysToKeep to reasonable range (1-3650 days)
  const boundedDays = Math.max(1, Math.min(rawDays || 90, 3650));

  const stmt = db.prepare(`
    DELETE FROM audit_log
    WHERE timestamp < datetime('now', '-' || ? || ' days')
  `);
  const result = stmt.run(boundedDays);
  return result.changes;
}

/**
 * Get audit statistics
 * @param {any} options
 * @returns {any}
 */
function getAuditStats(options = {}) {
  const { since, until } = options;

  let whereClause = '1=1';
  const params = [];

  if (since) {
    whereClause += ` AND timestamp >= ?`;
    params.push(since);
  }

  if (until) {
    whereClause += ` AND timestamp <= ?`;
    params.push(until);
  }

  const totalStmt = db.prepare(`SELECT COUNT(*) as count FROM audit_log WHERE ${whereClause}`);
  const total = totalStmt.get(...params).count;

  const byEntityStmt = db.prepare(`
    SELECT entity_type, COUNT(*) as count
    FROM audit_log WHERE ${whereClause}
    GROUP BY entity_type ORDER BY count DESC
  `);
  const byEntity = byEntityStmt.all(...params);

  const byActionStmt = db.prepare(`
    SELECT action, COUNT(*) as count
    FROM audit_log WHERE ${whereClause}
    GROUP BY action ORDER BY count DESC LIMIT 20
  `);
  const byAction = byActionStmt.all(...params);

  const byActorStmt = db.prepare(`
    SELECT actor, COUNT(*) as count
    FROM audit_log WHERE ${whereClause}
    GROUP BY actor ORDER BY count DESC LIMIT 10
  `);
  const byActor = byActorStmt.all(...params);

  return { total, byEntity, byAction, byActor };
}

// ============================================
// Cron & Extended Scheduling
// ============================================

// Cron field validation ranges
const CRON_FIELD_RANGES = {
  minute: { min: 0, max: 59, name: 'minute' },
  hour: { min: 0, max: 23, name: 'hour' },
  day: { min: 1, max: 31, name: 'day of month' },
  month: { min: 1, max: 12, name: 'month' },
  dayOfWeek: { min: 0, max: 7, name: 'day of week' }  // 0 and 7 both mean Sunday
};

/**
 * Validate a single cron field value is within valid range
 * Returns { valid: true } or { valid: false, error: string }
 */
function validateCronFieldValue(value, range) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num) || num < range.min || num > range.max) {
    return { valid: false, error: `${range.name} must be ${range.min}-${range.max}, got ${value}` };
  }
  return { valid: true };
}

/**
 * Validate a single cron field syntax and values
 * Returns { valid: true } or { valid: false, error: string }
 */
function validateCronField(field, range) {
  // Allow wildcard
  if (field === '*') return { valid: true };

  // Check for invalid characters first
  if (!/^[\d*,\-/]+$/.test(field)) {
    return { valid: false, error: `${range.name} contains invalid characters` };
  }

  // Handle */n syntax
  if (field.startsWith('*/')) {
    const interval = parseInt(field.substring(2), 10);
    if (!Number.isFinite(interval) || interval <= 0 || interval > range.max) {
      return { valid: false, error: `${range.name} step must be 1-${range.max}, got ${field.substring(2)}` };
    }
    return { valid: true };
  }

  // Handle comma-separated values
  if (field.includes(',')) {
    const values = field.split(',');
    for (const v of values) {
      const result = validateCronFieldValue(v.trim(), range);
      if (!result.valid) return result;
    }
    return { valid: true };
  }

  // Handle range (e.g., 1-5)
  if (field.includes('-')) {
    const parts = field.split('-');
    if (parts.length !== 2) {
      return { valid: false, error: `${range.name} has invalid range syntax: ${field}` };
    }
    const startResult = validateCronFieldValue(parts[0].trim(), range);
    if (!startResult.valid) return startResult;
    const endResult = validateCronFieldValue(parts[1].trim(), range);
    if (!endResult.valid) return endResult;
    const start = parseInt(parts[0].trim(), 10);
    const end = parseInt(parts[1].trim(), 10);
    if (start > end) {
      return { valid: false, error: `${range.name} range start (${start}) must be <= end (${end})` };
    }
    return { valid: true };
  }

  // Single value
  return validateCronFieldValue(field, range);
}

/**
 * Parse and validate cron expression
 * Supports: minute hour day month dayOfWeek
 * Examples: "0 * * * *" (every hour), "star/15 * * * *" (every 15 mins, star=asterisk)
 * Throws Error with detailed message on invalid input
 */
function parseCronExpression(expression) {
  if (typeof expression !== 'string') {
    throw new Error('CRON_INVALID_TYPE: cron expression must be a string');
  }

  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    throw new Error('CRON_EMPTY: cron expression cannot be empty');
  }

  if (trimmed.length > 100) {
    throw new Error('CRON_TOO_LONG: cron expression exceeds maximum length of 100 characters');
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`CRON_FIELD_COUNT: cron expression must have 5 fields (minute hour day month dayOfWeek), got ${parts.length}`);
  }

  const fieldNames = ['minute', 'hour', 'day', 'month', 'dayOfWeek'];
  for (let i = 0; i < 5; i++) {
    const result = validateCronField(parts[i], CRON_FIELD_RANGES[fieldNames[i]]);
    if (!result.valid) {
      throw new Error(`CRON_INVALID_FIELD: ${result.error}`);
    }
  }

  return {
    minute: parts[0],
    hour: parts[1],
    day: parts[2],
    month: parts[3],
    dayOfWeek: parts[4]
  };
}

/**
 * Calculate next run time from cron expression
 * Implements correct cron semantics:
 * - If both day-of-month and day-of-week are specified (not '*'), use OR logic
 * - This matches standard cron behavior where a date can match either field
 * Returns null on invalid cron expression instead of throwing
 */
function calculateNextRun(cronExpression, fromDate = new Date(), timezone = null) {
  let cron;
  try {
    cron = parseCronExpression(cronExpression);
  } catch {
    // Invalid cron expression - return null instead of throwing
    return null;
  }
  const next = new Date(fromDate);
  next.setSeconds(0);
  next.setMilliseconds(0);

  // Helper to get date components in the target timezone using Intl.DateTimeFormat
  let getDateParts;
  if (timezone) {
    try {
      // Validate timezone by creating a formatter — throws on invalid IANA timezone
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        hour12: false,
      });
      getDateParts = (date) => {
        const parts = {};
        for (const { type, value } of fmt.formatToParts(date)) {
          parts[type] = parseInt(value, 10);
        }
        return {
          minute: parts.minute,
          hour: parts.hour === 24 ? 0 : parts.hour,
          day: parts.day,
          month: parts.month,
          dayOfWeek: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
        };
      };
    } catch {
      // Invalid timezone — fall back to local time
      getDateParts = null;
    }
  }

  if (!getDateParts) {
    getDateParts = (date) => ({
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      dayOfWeek: date.getDay(),
    });
  }

  // Determine day matching mode
  // Per cron spec: if both day-of-month and day-of-week are restricted (not '*'),
  // match if EITHER condition is true (OR logic)
  const daySpecified = cron.day !== '*';
  const dayOfWeekSpecified = cron.dayOfWeek !== '*';
  const useDayOrLogic = daySpecified && dayOfWeekSpecified;

  // Simple implementation: advance by 1 minute and check each slot
  // For production, use a proper cron library
  for (let i = 0; i < 1440 * 366; i++) { // Check up to 366 days
    next.setMinutes(next.getMinutes() + 1);

    const p = getDateParts(next);
    const minute = p.minute;
    const hour = p.hour;
    const day = p.day;
    const month = p.month;
    const dayOfWeek = p.dayOfWeek;
    const normalizedDayOfWeek = dayOfWeek % 7;

    // Check minute, hour, and month (always AND logic)
    // Pass rangeMin: minute=0, hour=0, month=1 (months are 1-12)
    if (!matchesCronField(cron.minute, minute, 0) ||
        !matchesCronField(cron.hour, hour, 0) ||
        !matchesCronField(cron.month, month, 1)) {
      continue;
    }

    // Check day-of-month and day-of-week
    // Use OR logic when both are specified, otherwise AND
    // rangeMin: day=1 (days are 1-31), dayOfWeek=0 (days are 0-6)
    let dayMatches;
    if (useDayOrLogic) {
      // OR: match if either day-of-month OR day-of-week matches
      dayMatches = matchesCronField(cron.day, day, 1) || matchesCronField(cron.dayOfWeek, normalizedDayOfWeek, 0);
    } else {
      // AND: match if both match (one or both may be '*' which always matches)
      dayMatches = matchesCronField(cron.day, day, 1) && matchesCronField(cron.dayOfWeek, normalizedDayOfWeek, 0);
    }

    if (dayMatches) {
      return next;
    }
  }

  return null;
}

/**
 * Check if a value matches a cron field
 * Returns false for invalid field syntax rather than throwing
 * @param {string} field - The cron field pattern
 * @param {number} value - The current value to check
 * @param {number} rangeMin - Minimum value for this field (0 for minute/hour, 1 for day/month)
 */
function matchesCronField(field, value, rangeMin = 0) {
  if (field === '*') return true;

  try {
    // Handle */n syntax
    // For fields starting at 0 (minute, hour, dayOfWeek): value % n == 0
    // For fields starting at 1 (day, month): (value - 1) % n == 0
    if (field.startsWith('*/')) {
      const interval = parseInt(field.substring(2), 10);
      // Guard against division by zero and NaN
      if (!Number.isFinite(interval) || interval <= 0) {
        return false;
      }
      // Adjust for 1-based fields (day, month) so */2 matches 1,3,5,7,9,11 for months
      const adjustedValue = rangeMin === 1 ? value - 1 : value;
      return adjustedValue % interval === 0;
    }

    // Handle comma-separated values
    if (field.includes(',')) {
      const values = field.split(',').map(v => parseInt(v.trim(), 10));
      // Check all values are valid numbers
      if (values.some(v => !Number.isFinite(v))) {
        return false;
      }
      return values.includes(value);
    }

    // Handle range (e.g., 1-5)
    if (field.includes('-')) {
      const parts = field.split('-');
      if (parts.length !== 2) return false;
      const start = parseInt(parts[0].trim(), 10);
      const end = parseInt(parts[1].trim(), 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return false;
      }
      return value >= start && value <= end;
    }

    // Single value
    const parsed = parseInt(field, 10);
    if (!Number.isFinite(parsed)) {
      return false;
    }
    return parsed === value;
  } catch {
    // Safety catch for any unexpected errors
    return false;
  }
}

/**
 * Detect schedule overlaps by computing next N run times and checking for collisions
 * @param {string} cronExpression - Cron expression to check
 * @param {Object} options - Options
 * @param {number} options.checkCount - Number of future runs to check (default 10)
 * @param {number} options.toleranceMinutes - Minutes within which runs are considered overlapping (default 5)
 * @param {string[]} options.excludeIds - Schedule IDs to exclude from comparison
 * @returns {Array} Array of overlapping schedules with overlap times
 */
function detectScheduleOverlaps(cronExpression, options = {}) {
  const { checkCount = 10, toleranceMinutes = 5, excludeIds = [] } = options;
  const toleranceMs = toleranceMinutes * 60 * 1000;

  // Get all enabled schedules except excluded ones
  const schedules = listScheduledTasks({ enabled_only: true });
  const compareSchedules = schedules.filter(s => !excludeIds.includes(String(s.id)));

  if (compareSchedules.length === 0) return [];

  // Calculate next N run times for the new expression
  const newRunTimes = [];
  let nextTime = new Date();
  for (let i = 0; i < checkCount; i++) {
    const next = calculateNextRun(cronExpression, nextTime);
    if (!next) break;
    newRunTimes.push(next.getTime());
    nextTime = new Date(next.getTime() + 60000); // Move 1 minute forward
  }

  if (newRunTimes.length === 0) return [];

  // Check for overlaps with existing schedules
  const overlaps = [];
  for (const schedule of compareSchedules) {
    let schedNextTime = new Date();
    const scheduleOverlaps = [];

    for (let i = 0; i < checkCount; i++) {
      const schedNext = calculateNextRun(schedule.cron_expression, schedNextTime);
      if (!schedNext) break;
      const schedNextMs = schedNext.getTime();

      // Check if this run time is within tolerance of any new run time
      for (const newRunMs of newRunTimes) {
        if (Math.abs(schedNextMs - newRunMs) <= toleranceMs) {
          scheduleOverlaps.push({
            existingTime: new Date(schedNextMs).toISOString(),
            newTime: new Date(newRunMs).toISOString(),
            differenceMinutes: Math.round(Math.abs(schedNextMs - newRunMs) / 60000)
          });
        }
      }

      schedNextTime = new Date(schedNextMs + 60000);
    }

    if (scheduleOverlaps.length > 0) {
      overlaps.push({
        schedule_id: schedule.id,
        schedule_name: schedule.name,
        cron_expression: schedule.cron_expression,
        overlaps: scheduleOverlaps
      });
    }
  }

  return overlaps;
}

/**
 * Create a scheduled task (cron-based)
 * Compatible with existing scheduled_tasks schema
 */
function createCronScheduledTask(data) {
  const now = new Date().toISOString();
  const { v4: uuidv4 } = require('uuid');

  // Validate cron expression
  parseCronExpression(data.cron_expression);

  // Calculate next run (timezone-aware if provided)
  const timezone = data.timezone || null;
  const nextRun = calculateNextRun(data.cron_expression, new Date(), timezone);

  const scheduleId = uuidv4();
  const taskConfig = data.task_config || {};

  const stmt = db.prepare(`
    INSERT INTO scheduled_tasks (
      id, name, task_description, working_directory, timeout_minutes,
      auto_approve, schedule_type, cron_expression, next_run_at, enabled, created_at, task_config, updated_at, timezone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    scheduleId,
    data.name,
    taskConfig.task || 'Scheduled task',
    taskConfig.working_directory || null,
    taskConfig.timeout_minutes || 30,
    taskConfig.auto_approve ? 1 : 0,
    'cron',
    data.cron_expression,
    nextRun ? nextRun.toISOString() : null,
    data.enabled !== false ? 1 : 0,
    now,
    JSON.stringify(taskConfig),
    now,
    timezone
  );

  return {
    id: scheduleId,
    name: data.name,
    cron_expression: data.cron_expression,
    timezone: timezone,
    task_config: taskConfig,
    enabled: data.enabled !== false,
    next_run_at: nextRun ? nextRun.toISOString() : null
  };
}

/**
 * Toggle scheduled task enabled state
 * @param {any} id
 * @param {any} enabled
 * @returns {any}
 */
function toggleScheduledTask(id, enabled) {
  const now = new Date().toISOString();
  const schedule = getScheduledTask(id);
  if (!schedule) return null;

  const newEnabled = enabled !== undefined ? enabled : !schedule.enabled;

  // If enabling, recalculate next run
  let nextRun = schedule.next_run_at;
  if (newEnabled && !schedule.enabled) {
    const next = calculateNextRun(schedule.cron_expression, new Date(), schedule.timezone || null);
    nextRun = next ? next.toISOString() : null;
  }

  const stmt = db.prepare(`
    UPDATE scheduled_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(newEnabled ? 1 : 0, nextRun, now, id);

  return getScheduledTask(id);
}

// Enhanced versions (Wave 2 Phase 5 — replaces basic L6448-6626 versions)

/**
 * Get a scheduled task by ID or name
 * @param {any} identifier
 * @returns {any}
 */
function getScheduledTask(identifier) {
  const stmt = db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE id = ? OR name = ?
  `);
  const row = stmt.get(identifier, identifier);

  if (row) {
    row.task_config = safeJsonParse(row.task_config, {});
    row.enabled = Boolean(row.enabled);
  }

  return row;
}

/**
 * List scheduled tasks
 * @param {any} options
 * @returns {any}
 */
function listScheduledTasks(options = {}) {
  const { enabled_only = false, limit = 50 } = options;

  let query = 'SELECT * FROM scheduled_tasks';
  const params = [];

  if (enabled_only) {
    query += ' WHERE enabled = 1';
  }

  query += ' ORDER BY next_run_at ASC NULLS LAST LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);

  return rows.map(row => ({
    ...row,
    task_config: safeJsonParse(row.task_config, {}),
    enabled: Boolean(row.enabled)
  }));
}

/**
 * Update a scheduled task
 * @param {any} id
 * @param {any} updates
 * @returns {any}
 */
function updateScheduledTask(id, updates) {
  const now = new Date().toISOString();
  const fields = [];
  const params = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    params.push(updates.name);
  }

  if (updates.timezone !== undefined) {
    fields.push('timezone = ?');
    params.push(updates.timezone || null);
  }

  if (updates.cron_expression !== undefined) {
    parseCronExpression(updates.cron_expression);
    fields.push('cron_expression = ?');
    params.push(updates.cron_expression);

    // Recalculate next run (use updated timezone if provided, else fetch existing schedule's timezone)
    let tz = updates.timezone !== undefined ? (updates.timezone || null) : null;
    if (tz === null && updates.cron_expression !== undefined && updates.timezone === undefined) {
      const existing = getScheduledTask(id);
      tz = existing?.timezone || null;
    }
    const nextRun = calculateNextRun(updates.cron_expression, new Date(), tz);
    fields.push('next_run_at = ?');
    params.push(nextRun ? nextRun.toISOString() : null);
  }

  if (updates.task_config !== undefined) {
    fields.push('task_config = ?');
    params.push(JSON.stringify(updates.task_config));
  }

  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    params.push(updates.enabled ? 1 : 0);
  }

  if (fields.length === 0) return null;

  fields.push('updated_at = ?');
  params.push(now);
  params.push(id);

  const stmt = db.prepare(`
    UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?
  `);
  stmt.run(...params);

  return getScheduledTask(id);
}

/**
 * Delete a scheduled task
 */
function deleteScheduledTask(id) {
  const stmt = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Get scheduled tasks that are due to run
 * @returns {any}
 */
function getDueScheduledTasks() {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at <= ?
    ORDER BY next_run_at ASC
  `);
  const rows = stmt.all(now);

  return rows.map(row => ({
    ...row,
    task_config: safeJsonParse(row.task_config, {}),
    enabled: Boolean(row.enabled)
  }));
}

/**
 * Mark a scheduled task as run and update next run time
 * @param {any} id
 * @returns {any}
 */
function markScheduledTaskRun(id) {
  const now = new Date();
  const schedule = getScheduledTask(id);
  if (!schedule) return null;

  const nextRun = calculateNextRun(schedule.cron_expression, now, schedule.timezone || null);

  const stmt = db.prepare(`
    UPDATE scheduled_tasks
    SET last_run_at = ?, next_run_at = ?, run_count = run_count + 1, updated_at = ?
    WHERE id = ?
  `);
  stmt.run(now.toISOString(), nextRun ? nextRun.toISOString() : null, now.toISOString(), id);

  return getScheduledTask(id);
}

// ============================================
// Resource Usage Tracking
// ============================================

/**
 * Record resource usage for a task
 * @param {any} data
 * @returns {any}
 */
function recordResourceUsage(data) {
  const stmt = db.prepare(`
    INSERT INTO resource_usage (task_id, cpu_percent, memory_mb, disk_io_mb, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    data.task_id,
    data.cpu_percent || null,
    data.memory_mb || null,
    data.disk_io_mb || null,
    data.timestamp || new Date().toISOString()
  );

  return { id: result.lastInsertRowid };
}

/**
 * Get resource usage for a task
 * @param {any} taskId
 * @param {any} options
 * @returns {any}
 */
function getResourceUsage(taskId, options = {}) {
  const { limit = 100, start_time, end_time } = options;

  let query = 'SELECT * FROM resource_usage WHERE task_id = ?';
  const params = [taskId];

  if (start_time) {
    query += ' AND timestamp >= ?';
    params.push(start_time);
  }

  if (end_time) {
    query += ' AND timestamp <= ?';
    params.push(end_time);
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get aggregated resource usage for a project
 * @param {any} project
 * @param {any} options
 * @returns {any}
 */
function getResourceUsageByProject(project, options = {}) {
  const { start_time, end_time } = options;

  let whereClause = 't.project = ?';
  const params = [project];

  if (start_time) {
    whereClause += ' AND r.timestamp >= ?';
    params.push(start_time);
  }

  if (end_time) {
    whereClause += ' AND r.timestamp <= ?';
    params.push(end_time);
  }

  const stmt = db.prepare(`
    SELECT
      COUNT(DISTINCT r.task_id) as task_count,
      COUNT(r.id) as sample_count,
      AVG(r.cpu_percent) as avg_cpu,
      MAX(r.cpu_percent) as max_cpu,
      AVG(r.memory_mb) as avg_memory,
      MAX(r.memory_mb) as max_memory,
      SUM(r.disk_io_mb) as total_disk_io
    FROM resource_usage r
    JOIN tasks t ON r.task_id = t.id
    WHERE ${whereClause}
  `);

  return stmt.get(...params);
}

/**
 * Set resource limits for a project
 * @param {any} project
 * @param {any} limits
 * @returns {any}
 */
function setResourceLimits(project, limits) {
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO resource_limits (project, max_cpu_percent, max_memory_mb, max_concurrent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project) DO UPDATE SET
      max_cpu_percent = COALESCE(excluded.max_cpu_percent, resource_limits.max_cpu_percent),
      max_memory_mb = COALESCE(excluded.max_memory_mb, resource_limits.max_memory_mb),
      max_concurrent = COALESCE(excluded.max_concurrent, resource_limits.max_concurrent),
      updated_at = excluded.updated_at
  `);
  stmt.run(
    project,
    limits.max_cpu_percent !== undefined ? limits.max_cpu_percent : null,
    limits.max_memory_mb !== undefined ? limits.max_memory_mb : null,
    limits.max_concurrent !== undefined ? limits.max_concurrent : null,
    now,
    now
  );

  return getResourceLimits(project);
}

/**
 * Get resource limits for a project
 * @param {any} project
 * @returns {any}
 */
function getResourceLimits(project) {
  const stmt = db.prepare('SELECT * FROM resource_limits WHERE project = ?');
  return stmt.get(project);
}

/**
 * Get all resource limits
 */
function getAllResourceLimits() {
  const stmt = db.prepare('SELECT * FROM resource_limits ORDER BY project');
  return stmt.all();
}

/**
 * Delete resource limits for a project
 */
function deleteResourceLimits(project) {
  const stmt = db.prepare('DELETE FROM resource_limits WHERE project = ?');
  const result = stmt.run(project);
  return result.changes > 0;
}

/**
 * Generate resource usage report
 * @param {any} options
 * @returns {any}
 */
function getResourceReport(options = {}) {
  const { project, start_time, end_time, group_by = 'day' } = options;

  // Build time grouping
  let timeGroup;
  switch (group_by) {
    case 'hour':
      timeGroup = "strftime('%Y-%m-%d %H:00', r.timestamp)";
      break;
    case 'day':
      timeGroup = "strftime('%Y-%m-%d', r.timestamp)";
      break;
    case 'week':
      timeGroup = "strftime('%Y-W%W', r.timestamp)";
      break;
    default:
      timeGroup = "strftime('%Y-%m-%d', r.timestamp)";
  }

  let whereClause = '1=1';
  const params = [];

  if (project) {
    whereClause += ' AND t.project = ?';
    params.push(project);
  }

  if (start_time) {
    whereClause += ' AND r.timestamp >= ?';
    params.push(start_time);
  }

  if (end_time) {
    whereClause += ' AND r.timestamp <= ?';
    params.push(end_time);
  }

  const stmt = db.prepare(`
    SELECT
      ${timeGroup} as period,
      COUNT(DISTINCT r.task_id) as task_count,
      COUNT(r.id) as sample_count,
      ROUND(AVG(r.cpu_percent), 2) as avg_cpu,
      ROUND(MAX(r.cpu_percent), 2) as max_cpu,
      ROUND(AVG(r.memory_mb), 2) as avg_memory,
      ROUND(MAX(r.memory_mb), 2) as max_memory,
      ROUND(SUM(r.disk_io_mb), 2) as total_disk_io
    FROM resource_usage r
    JOIN tasks t ON r.task_id = t.id
    WHERE ${whereClause}
    GROUP BY period
    ORDER BY period DESC
  `);

  return stmt.all(...params);
}

// ============================================
// Reporting & Pipeline Duplication
// ============================================

/**
 * Export tasks report in various formats
 */
function exportTasksReport(options = {}) {
  const { project, status, start_date, end_date, tags, include_output = false } = options;

  let whereClause = '1=1';
  const params = [];

  if (project) {
    whereClause += ' AND project = ?';
    params.push(project);
  }

  if (status) {
    if (Array.isArray(status)) {
      whereClause += ` AND status IN (${status.map(() => '?').join(',')})`;
      params.push(...status);
    } else {
      whereClause += ' AND status = ?';
      params.push(status);
    }
  }

  if (start_date) {
    whereClause += ' AND created_at >= ?';
    params.push(start_date);
  }

  if (end_date) {
    whereClause += ' AND created_at <= ?';
    params.push(end_date);
  }

  // Select columns based on include_output
  const columns = include_output
    ? '*'
    : 'id, status, task_description, project, priority, progress_percent, exit_code, created_at, started_at, completed_at, files_modified';

  const stmt = db.prepare(`
    SELECT ${columns} FROM tasks
    WHERE ${whereClause}
    ORDER BY created_at DESC
  `);

  let tasks = stmt.all(...params);

  // Filter by tags if specified (tags stored as JSON array in tasks.tags column)
  if (tags && tags.length > 0) {
    tasks = tasks.filter(t => {
      if (!t.tags) return false;
      try {
        const taskTags = JSON.parse(t.tags);
        return Array.isArray(taskTags) && tags.some(tag => taskTags.includes(tag));
      } catch { return false; }
    });
  }

  // Get summary stats
  const summary = {
    total: tasks.length,
    by_status: {},
    by_project: {}
  };

  for (const task of tasks) {
    summary.by_status[task.status] = (summary.by_status[task.status] || 0) + 1;
    if (task.project) {
      summary.by_project[task.project] = (summary.by_project[task.project] || 0) + 1;
    }
  }

  return { tasks, summary };
}

/**
 * Clone a pipeline with new parameters
 */
function duplicatePipeline(pipelineId, newName, paramOverrides = {}) {
  const pipeline = getPipelineFn ? getPipelineFn(pipelineId) : null;
  if (!pipeline) return null;

  // Parse and modify the pipeline definition
  const definition = safeJsonParse(pipeline.definition, []);
  if (!Array.isArray(definition)) return null;

  // Apply parameter overrides to each step
  if (paramOverrides.working_directory) {
    definition.forEach(step => {
      step.working_directory = paramOverrides.working_directory;
    });
  }

  if (paramOverrides.auto_approve !== undefined) {
    definition.forEach(step => {
      step.auto_approve = paramOverrides.auto_approve;
    });
  }

  if (paramOverrides.timeout_minutes) {
    definition.forEach(step => {
      step.timeout_minutes = paramOverrides.timeout_minutes;
    });
  }

  // Create new pipeline
  if (createPipelineFn) {
    return createPipelineFn({
      name: newName,
      description: `Clone of ${pipeline.name}${paramOverrides.description ? ': ' + paramOverrides.description : ''}`,
      definition
    });
  }
  return null;
}

// ============================================
// Factory function — one-call DI setup
// ============================================

/**
 * Create a fully-wired scheduling-automation instance.
 * @param {{ db: any, taskCore?: object, recordTaskEvent?: Function, getPipeline?: Function, createPipeline?: Function }} options
 * @returns {object} All public functions from this module
 */
function createSchedulingAutomation({ db: dbInstance, taskCore, recordTaskEvent, getPipeline, createPipeline } = {}) {
  if (dbInstance) setDb(dbInstance);
  if (taskCore?.getTask) setGetTask(taskCore.getTask);
  if (recordTaskEvent) setRecordTaskEvent(recordTaskEvent);
  if (getPipeline) setGetPipeline(getPipeline);
  if (createPipeline) setCreatePipeline(createPipeline);
  return module.exports;
}

// ============================================
// Exports
// ============================================

module.exports = {
  createSchedulingAutomation,
  // Dependency injection
  setDb,
  setGetTask,
  setRecordTaskEvent,
  setGetPipeline,
  setCreatePipeline,

  // Templates
  saveTemplate,
  getTemplate,
  listTemplates,
  incrementTemplateUsage,
  deleteTemplate,

  // Maintenance Schedules
  setMaintenanceSchedule,
  getMaintenanceSchedule,
  listMaintenanceSchedules,
  getDueMaintenanceTasks,
  markMaintenanceRun,
  calculateNextMaintenanceRun,
  deleteMaintenanceSchedule,

  // Approval Workflows
  createApprovalRule,
  getApprovalRule,
  listApprovalRules,
  updateApprovalRule,
  deleteApprovalRule,
  checkApprovalRequired,
  matchesApprovalRule,
  createApprovalRequest,
  getApprovalRequest,
  approveTask,
  rejectApproval,
  listPendingApprovals,
  processAutoApprovals,
  getApprovalHistory,

  // Audit
  recordAuditLog,
  getAuditLog,
  getAuditLogCount,
  exportAuditLog,
  getAuditConfig,
  setAuditConfig,
  getAllAuditConfig,
  cleanupAuditLog,
  getAuditStats,

  // Cron & Extended Scheduling
  CRON_FIELD_RANGES,
  validateCronFieldValue,
  validateCronField,
  parseCronExpression,
  calculateNextRun,
  matchesCronField,
  detectScheduleOverlaps,
  createCronScheduledTask,
  toggleScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
  deleteScheduledTask,
  getDueScheduledTasks,
  markScheduledTaskRun,

  // Resource Usage
  recordResourceUsage,
  getResourceUsage,
  getResourceUsageByProject,
  setResourceLimits,
  getResourceLimits,
  getAllResourceLimits,
  deleteResourceLimits,
  getResourceReport,

  // Reporting & Pipeline
  exportTasksReport,
  duplicatePipeline,
};
