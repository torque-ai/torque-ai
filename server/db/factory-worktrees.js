'use strict';

let db = null;
const tableColumnCache = new Map();

function setDb(dbInstance) {
  db = dbInstance;
  tableColumnCache.clear();
}

function resolveDbHandle(candidate) {
  if (!candidate) {
    return null;
  }
  if (typeof candidate.prepare === 'function') {
    return candidate;
  }
  if (typeof candidate.getDbInstance === 'function') {
    return candidate.getDbInstance();
  }
  if (typeof candidate.getDb === 'function') {
    return candidate.getDb();
  }
  return null;
}

function getDb() {
  let instance = resolveDbHandle(db);
  if (!instance) {
    try {
      const { defaultContainer } = require('../container');
      if (defaultContainer && typeof defaultContainer.has === 'function' && defaultContainer.has('db')) {
        instance = resolveDbHandle(defaultContainer.get('db'));
      }
    } catch {
      // Fall through to the database.js fallback below.
    }
  }
  if (!instance) {
    try {
      const database = require('../database');
      instance = resolveDbHandle(database);
    } catch {
      // Let the explicit error below surface if no active DB is available.
    }
  }

  if (instance) {
    db = instance;
  }
  if (!instance || typeof instance.prepare !== 'function') {
    throw new Error('Factory worktrees requires an active database connection');
  }
  return instance;
}

function isMissingTableError(error) {
  return Boolean(error && typeof error.message === 'string' && error.message.includes('no such table: factory_worktrees'));
}

function hasColumn(tableName, columnName) {
  const cacheKey = `${tableName}.${columnName}`;
  if (tableColumnCache.has(cacheKey)) {
    return tableColumnCache.get(cacheKey);
  }
  if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
    return false;
  }
  try {
    const columns = getDb().prepare(`PRAGMA table_info(${tableName})`).all();
    const present = columns.some((column) => column.name === columnName);
    tableColumnCache.set(cacheKey, present);
    return present;
  } catch (error) {
    if (isMissingTableError(error)) {
      tableColumnCache.set(cacheKey, false);
      return false;
    }
    throw error;
  }
}

function parseWorktree(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    batchId: row.batch_id,
    vcWorktreeId: row.vc_worktree_id,
    workItemId: row.work_item_id,
    worktreePath: row.worktree_path,
    owningTaskId: row.owning_task_id || null,
    baseBranch: row.base_branch || row.baseBranch || null,
  };
}

function getWorktree(id) {
  const row = getDb().prepare('SELECT * FROM factory_worktrees WHERE id = ?').get(id);
  return parseWorktree(row);
}

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function requireInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function recordWorktree({
  project_id,
  work_item_id,
  batch_id,
  vc_worktree_id,
  branch,
  worktree_path,
  base_branch,
  baseBranch,
}) {
  const dbHandle = getDb();
  const branchBase = base_branch || baseBranch || null;
  const fields = [
    'project_id',
    'work_item_id',
    'batch_id',
    'vc_worktree_id',
    'branch',
    'worktree_path',
  ];
  const values = [
    requireText(project_id, 'project_id'),
    requireInteger(work_item_id, 'work_item_id'),
    requireText(batch_id, 'batch_id'),
    requireText(vc_worktree_id, 'vc_worktree_id'),
    requireText(branch, 'branch'),
    requireText(worktree_path, 'worktree_path'),
  ];
  if (branchBase && hasColumn('factory_worktrees', 'base_branch')) {
    fields.push('base_branch');
    values.push(requireText(branchBase, 'base_branch'));
  }

  const placeholders = fields.map(() => '?').join(', ');
  const info = dbHandle.prepare(`
    INSERT INTO factory_worktrees (
      ${fields.join(',\n      ')}
    )
    VALUES (${placeholders})
  `).run(...values);

  return getWorktree(info.lastInsertRowid);
}

function getActiveWorktree(project_id) {
  try {
    const row = getDb().prepare(`
      SELECT *
      FROM factory_worktrees
      WHERE project_id = ?
        AND status = 'active'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(requireText(project_id, 'project_id'));
    return parseWorktree(row);
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }
}

function getActiveWorktreeByBatch(batch_id) {
  try {
    const row = getDb().prepare(`
      SELECT *
      FROM factory_worktrees
      WHERE batch_id = ?
        AND status = 'active'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(requireText(batch_id, 'batch_id'));
    return parseWorktree(row);
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }
}

function getWorktreeByBranch(branch) {
  try {
    const row = getDb().prepare(`
      SELECT *
      FROM factory_worktrees
      WHERE branch = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(requireText(branch, 'branch'));
    return parseWorktree(row);
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }
}

function getActiveWorktreeByBranch(branch) {
  try {
    const row = getDb().prepare(`
      SELECT *
      FROM factory_worktrees
      WHERE branch = ?
        AND status = 'active'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(requireText(branch, 'branch'));
    return parseWorktree(row);
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }
}

function markMerged(id) {
  try {
    const result = getDb().prepare(`
      UPDATE factory_worktrees
      SET status = 'merged',
          merged_at = datetime('now')
      WHERE id = ?
    `).run(requireInteger(id, 'id'));
    if (result.changes === 0) {
      return null;
    }
    return getWorktree(id);
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }
}

function markAbandoned(id, reason) {
  void reason;
  try {
    const result = getDb().prepare(`
      UPDATE factory_worktrees
      SET status = 'abandoned',
          abandoned_at = datetime('now')
      WHERE id = ?
    `).run(requireInteger(id, 'id'));
    if (result.changes === 0) {
      return null;
    }
    return getWorktree(id);
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }
}

function setOwningTask(id, task_id) {
  try {
    // When a non-null task is being attached, also bump created_at so the
    // factory loop's pre-reclaim grace window starts from "current owner
    // attached" rather than "row first inserted". Without this, a long-lived
    // worktree row that gets a fresh task attached would fail the grace
    // check (loop-controller.js pre_reclaim_before_create path) and have its
    // freshly-running task killed mid-flight. Clearing the owner (null) is
    // not a slot reuse, so leave created_at alone there.
    const sql = task_id
      ? `UPDATE factory_worktrees
         SET owning_task_id = ?,
             created_at = datetime('now')
         WHERE id = ?`
      : `UPDATE factory_worktrees
         SET owning_task_id = ?
         WHERE id = ?`;
    const result = getDb().prepare(sql).run(
      task_id ? requireText(task_id, 'task_id') : null,
      requireInteger(id, 'id'),
    );
    if (result.changes === 0) {
      return null;
    }
    return getWorktree(id);
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }
}

function clearOwningTask(id) {
  return setOwningTask(id, null);
}

/**
 * Reset the pre-reclaim grace window for whichever active row currently
 * owns a given task_id. Used by stall recovery, which keeps the same
 * task_id but starts a fresh attempt — without bumping created_at, the
 * loop-controller pre-reclaim sweep would see the row as old, decide the
 * owner has overstayed its welcome, and cancel the in-flight retry
 * (pre_reclaim_before_create). Returns the refreshed row, or null when
 * no active row matches.
 */
function refreshGraceForOwningTask(task_id) {
  try {
    const taskId = requireText(task_id, 'task_id');
    const result = getDb().prepare(`
      UPDATE factory_worktrees
      SET created_at = datetime('now')
      WHERE owning_task_id = ?
        AND status = 'active'
    `).run(taskId);
    if (result.changes === 0) {
      return null;
    }
    const row = getDb().prepare(`
      SELECT *
      FROM factory_worktrees
      WHERE owning_task_id = ?
        AND status = 'active'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(taskId);
    return parseWorktree(row);
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }
}

function getLatestWorktreeForWorkItem(project_id, work_item_id) {
  try {
    const row = getDb().prepare(`
      SELECT *
      FROM factory_worktrees
      WHERE project_id = ?
        AND work_item_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(
      requireText(project_id, 'project_id'),
      requireInteger(work_item_id, 'work_item_id'),
    );
    return parseWorktree(row);
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }
}

function listActiveWorktrees() {
  try {
    return getDb().prepare(`
      SELECT *
      FROM factory_worktrees
      WHERE status = 'active'
      ORDER BY created_at DESC, id DESC
    `).all().map(parseWorktree);
  } catch (error) {
    if (isMissingTableError(error)) {
      return [];
    }
    throw error;
  }
}

function pruneAbandonedWorktrees({ olderThanHours = 24, limit = 1000 } = {}) {
  const retentionHours = Number(olderThanHours);
  const rowLimit = Number(limit);
  const safeRetentionHours = Number.isFinite(retentionHours) && retentionHours > 0 ? retentionHours : 24;
  const safeLimit = Number.isInteger(rowLimit) && rowLimit > 0 ? Math.min(rowLimit, 5000) : 1000;
  const cutoff = new Date(Date.now() - safeRetentionHours * 60 * 60 * 1000).toISOString();
  try {
    const result = getDb().prepare(`
      DELETE FROM factory_worktrees
      WHERE id IN (
        SELECT id
        FROM factory_worktrees
        WHERE status = 'abandoned'
          AND datetime(COALESCE(abandoned_at, created_at)) < datetime(?)
        ORDER BY datetime(COALESCE(abandoned_at, created_at)) ASC, id ASC
        LIMIT ?
      )
    `).run(cutoff, safeLimit);
    return result.changes;
  } catch (error) {
    if (isMissingTableError(error)) {
      return 0;
    }
    throw error;
  }
}

module.exports = {
  setDb,
  recordWorktree,
  getActiveWorktree,
  getActiveWorktreeByBatch,
  getWorktreeByBranch,
  getActiveWorktreeByBranch,
  getLatestWorktreeForWorkItem,
  markMerged,
  markAbandoned,
  listActiveWorktrees,
  pruneAbandonedWorktrees,
  setOwningTask,
  clearOwningTask,
  refreshGraceForOwningTask,
};
