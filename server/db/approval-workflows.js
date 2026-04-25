'use strict';

/**
 * Approval Workflows Module
 *
 * Extracted from scheduling-automation.js — approval rules CRUD,
 * approval request creation/processing, auto-approval, and rule matching.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 * Uses setter injection for cross-module dependencies (getTask, recordTaskEvent, recordAuditLog).
 */

let db;
let _getTaskFn;
let recordTaskEventFn;
let recordAuditLogFn;

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

function setRecordAuditLog(fn) {
  recordAuditLogFn = fn;
}

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

function getApprovalRequestById(approvalId) {
  const stmt = db.prepare(`
    SELECT ar.*, t.task_description, t.project, t.priority, t.auto_approve, t.created_at as task_created_at, t.metadata as task_metadata,
           r.name as rule_name, r.rule_type, r.auto_approve_after_minutes
    FROM approval_requests ar
    JOIN tasks t ON ar.task_id = t.id
    JOIN approval_rules r ON ar.rule_id = r.id
    WHERE ar.id = ?
    LIMIT 1
  `);
  return stmt.get(approvalId) || null;
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

    if (recordAuditLogFn) {
      recordAuditLogFn(
        'task',
        taskId,
        'approval',
        approvedBy,
        null,
        JSON.stringify({ approvalStatus: 'approved', requestStatus: 'approved' })
      );
    }

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
        cancel_reason = CASE WHEN status IN ('pending', 'queued') THEN 'human_rejected' ELSE cancel_reason END,
        error_output = CASE WHEN status IN ('pending', 'queued') THEN ? ELSE error_output END
      WHERE id = ?
    `).run(rejectionMessage, taskId);

    // Record event
    if (recordTaskEventFn) {
      recordTaskEventFn(taskId, 'approval', 'pending', 'rejected', { rejectedBy, comment });
    }

    if (recordAuditLogFn) {
      recordAuditLogFn(
        'task',
        taskId,
        'approval',
        rejectedBy,
        null,
        JSON.stringify({ approvalStatus: 'rejected', requestStatus: 'rejected' })
      );
    }

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
    SELECT ar.*, t.task_description, t.project, t.priority, t.auto_approve, t.created_at as task_created_at, t.metadata as task_metadata,
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

function listApprovalHistory(options = {}) {
  const { project, limit = 50 } = options;

  let query = `
    SELECT ar.*, t.task_description, t.project, t.priority, t.auto_approve, t.created_at as task_created_at, t.metadata as task_metadata,
           r.name as rule_name, r.rule_type, r.auto_approve_after_minutes
    FROM approval_requests ar
    JOIN tasks t ON ar.task_id = t.id
    JOIN approval_rules r ON ar.rule_id = r.id
    WHERE ar.status != 'pending'
  `;
  const params = [];

  if (project) {
    query += ` AND t.project = ?`;
    params.push(project);
  }

  query += ` ORDER BY COALESCE(ar.approved_at, ar.updated_at, ar.requested_at) DESC LIMIT ?`;
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
// Exports
// ============================================

module.exports = {
  setDb,
  setGetTask,
  setRecordTaskEvent,
  setRecordAuditLog,

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
  getApprovalRequestById,
  approveTask,
  rejectApproval,
  listPendingApprovals,
  listApprovalHistory,
  processAutoApprovals,
  getApprovalHistory,
};
