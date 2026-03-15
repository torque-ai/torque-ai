'use strict';

let db;

function setDb(dbInstance) {
  db = dbInstance;
}

function requireDb() {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('Peek recovery approvals database is not initialized');
  }

  return db;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeApprovalId(approvalId) {
  const numericId = Number(approvalId);
  return Number.isInteger(numericId) && numericId > 0 ? numericId : null;
}

function mapApprovalRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number.isInteger(row.id) ? row.id : Number(row.id),
    action: normalizeOptionalString(row.action),
    task_id: normalizeOptionalString(row.task_id),
    requested_by: normalizeOptionalString(row.requested_by),
    approved_by: normalizeOptionalString(row.approved_by),
    status: normalizeOptionalString(row.status) || 'pending',
    requested_at: normalizeOptionalString(row.requested_at),
    resolved_at: normalizeOptionalString(row.resolved_at),
  };
}

function selectLatestApproval(handle, action, taskId) {
  const normalizedAction = normalizeOptionalString(action);
  if (!normalizedAction) {
    return null;
  }

  const normalizedTaskId = normalizeOptionalString(taskId);
  if (normalizedTaskId) {
    return handle.prepare(`
      SELECT *
      FROM peek_recovery_approvals
      WHERE action = ? AND task_id = ?
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `).get(normalizedAction, normalizedTaskId);
  }

  return handle.prepare(`
    SELECT *
    FROM peek_recovery_approvals
    WHERE action = ? AND task_id IS NULL
    ORDER BY requested_at DESC, id DESC
    LIMIT 1
  `).get(normalizedAction);
}

function requestApproval(action, taskId = null, requestedBy = null) {
  const handle = requireDb();
  const normalizedAction = normalizeOptionalString(action);
  if (!normalizedAction) {
    throw new Error('action is required');
  }

  const normalizedTaskId = normalizeOptionalString(taskId);
  const normalizedRequestedBy = normalizeOptionalString(requestedBy) || 'system';
  const transaction = handle.transaction(() => {
    const existing = mapApprovalRow(selectLatestApproval(handle, normalizedAction, normalizedTaskId));
    if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
      return existing;
    }

    const result = handle.prepare(`
      INSERT INTO peek_recovery_approvals (
        action,
        task_id,
        requested_by
      )
      VALUES (?, ?, ?)
    `).run(
      normalizedAction,
      normalizedTaskId,
      normalizedRequestedBy,
    );

    return mapApprovalRow(handle.prepare(`
      SELECT *
      FROM peek_recovery_approvals
      WHERE id = ?
    `).get(Number(result.lastInsertRowid)));
  });

  return transaction();
}

function updateApprovalDecision(approvalId, status, approvedBy) {
  const handle = requireDb();
  const normalizedApprovalId = normalizeApprovalId(approvalId);
  if (!normalizedApprovalId) {
    throw new Error('approvalId must be a positive integer');
  }

  const normalizedApprovedBy = normalizeOptionalString(approvedBy) || 'system';
  const transaction = handle.transaction(() => {
    const current = mapApprovalRow(handle.prepare(`
      SELECT *
      FROM peek_recovery_approvals
      WHERE id = ?
    `).get(normalizedApprovalId));
    if (!current) {
      return null;
    }

    if (current.status === 'pending') {
      handle.prepare(`
        UPDATE peek_recovery_approvals
        SET status = ?, approved_by = ?, resolved_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
      `).run(status, normalizedApprovedBy, normalizedApprovalId);
    }

    return mapApprovalRow(handle.prepare(`
      SELECT *
      FROM peek_recovery_approvals
      WHERE id = ?
    `).get(normalizedApprovalId));
  });

  return transaction();
}

function grantApproval(approvalId, approvedBy) {
  return updateApprovalDecision(approvalId, 'approved', approvedBy);
}

function denyApproval(approvalId, approvedBy) {
  return updateApprovalDecision(approvalId, 'denied', approvedBy);
}

function getApprovalStatus(approvalId) {
  const handle = requireDb();
  const normalizedApprovalId = normalizeApprovalId(approvalId);
  if (!normalizedApprovalId) {
    return null;
  }

  return mapApprovalRow(handle.prepare(`
    SELECT *
    FROM peek_recovery_approvals
    WHERE id = ?
  `).get(normalizedApprovalId));
}

function getApprovalForAction(action, taskId = null) {
  const handle = requireDb();
  return mapApprovalRow(selectLatestApproval(handle, action, taskId));
}

module.exports = {
  setDb,
  requestApproval,
  grantApproval,
  denyApproval,
  getApprovalStatus,
  getApprovalForAction,
};
