'use strict';

let db = null;

function setDb(dbInstance) {
  db = dbInstance;
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
}) {
  const info = getDb().prepare(`
    INSERT INTO factory_worktrees (
      project_id,
      work_item_id,
      batch_id,
      vc_worktree_id,
      branch,
      worktree_path
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    requireText(project_id, 'project_id'),
    requireInteger(work_item_id, 'work_item_id'),
    requireText(batch_id, 'batch_id'),
    requireText(vc_worktree_id, 'vc_worktree_id'),
    requireText(branch, 'branch'),
    requireText(worktree_path, 'worktree_path'),
  );

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

module.exports = {
  setDb,
  recordWorktree,
  getActiveWorktree,
  getWorktreeByBranch,
  markMerged,
  markAbandoned,
  listActiveWorktrees,
};
