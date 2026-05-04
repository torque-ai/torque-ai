'use strict';

/**
 * Provider Routing Extras — extracted from provider-routing-core.js
 *
 * Contains Task Replay and Workflow Forks CRUD operations.
 * Uses dependency injection for the database instance.
 */

const { safeJsonParse } = require('../../utils/json');

let db;

function setDb(dbInstance) {
  db = dbInstance;
}

// ============================================================
// Task Replay
// ============================================================

/**
 * Create a task replay
 */
function createTaskReplay(replay) {
  const stmt = db.prepare(`
    INSERT INTO task_replays (id, original_task_id, replay_task_id, modified_inputs, diff_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    replay.id,
    replay.original_task_id,
    replay.replay_task_id,
    replay.modified_inputs ? JSON.stringify(replay.modified_inputs) : null,
    replay.diff_summary || null,
    new Date().toISOString()
  );

  return getTaskReplay(replay.id);
}

/**
 * Get a task replay by ID
 * @param {any} id
 * @returns {any}
 */
function getTaskReplay(id) {
  const stmt = db.prepare('SELECT * FROM task_replays WHERE id = ?');
  const row = stmt.get(id);
  if (row && row.modified_inputs) {
    row.modified_inputs = safeJsonParse(row.modified_inputs, {});
  }
  return row;
}

/**
 * List replays for a task
 * @param {any} originalTaskId
 * @returns {any}
 */
function listTaskReplays(originalTaskId) {
  const stmt = db.prepare('SELECT * FROM task_replays WHERE original_task_id = ? ORDER BY created_at DESC');
  const rows = stmt.all(originalTaskId);
  return rows.map(row => {
    if (row.modified_inputs) {
      row.modified_inputs = safeJsonParse(row.modified_inputs, {});
    }
    return row;
  });
}

// ============================================================
// Workflow Forks
// ============================================================

/**
 * Create a workflow fork
 */
function createWorkflowFork(fork) {
  const stmt = db.prepare(`
    INSERT INTO workflow_forks (id, workflow_id, fork_point_task_id, branch_count, branches, merge_strategy, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    fork.id,
    fork.workflow_id,
    fork.fork_point_task_id || null,
    fork.branch_count || 2,
    JSON.stringify(fork.branches),
    fork.merge_strategy || 'all',
    'pending',
    new Date().toISOString()
  );

  return getWorkflowFork(fork.id);
}

/**
 * Get a workflow fork by ID
 * @param {any} id
 * @returns {any}
 */
function getWorkflowFork(id) {
  const stmt = db.prepare('SELECT * FROM workflow_forks WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.branches = safeJsonParse(row.branches, []);
  }
  return row;
}

/**
 * List forks for a workflow
 * @param {any} workflowId
 * @returns {any}
 */
function listWorkflowForks(workflowId) {
  const stmt = db.prepare('SELECT * FROM workflow_forks WHERE workflow_id = ? ORDER BY created_at ASC');
  const rows = stmt.all(workflowId);
  return rows.map(row => {
    row.branches = safeJsonParse(row.branches, []);
    return row;
  });
}

/**
 * Update workflow fork status
 * @param {any} id
 * @param {any} status
 * @returns {any}
 */
function updateWorkflowForkStatus(id, status) {
  const stmt = db.prepare('UPDATE workflow_forks SET status = ? WHERE id = ?');
  const result = stmt.run(status, id);
  return result.changes > 0 ? getWorkflowFork(id) : null;
}

module.exports = {
  setDb,
  // Task Replay
  createTaskReplay,
  getTaskReplay,
  listTaskReplays,
  // Workflow Forks
  createWorkflowFork,
  getWorkflowFork,
  listWorkflowForks,
  updateWorkflowForkStatus,
};
