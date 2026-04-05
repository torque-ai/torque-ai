/**
 * db/plan-projects.js — Plan project CRUD and dependency tracking
 *
 * Extracted from project-config-core.js to keep that file under 1500 lines.
 */

'use strict';

const crypto = require('crypto');
const { safeJsonParse } = require('../utils/json');

// Late-bound dependencies (set via init())
let db = null;
let _getTask = null;

function setDb(dbInstance) {
  db = dbInstance;
}

function setGetTask(fn) {
  _getTask = fn;
}

// Proxy helper for injected getTask
function getTask(...args) { if (!_getTask) return null; return _getTask(...args); }

/**
 * Create a new plan project
 */
function createPlanProject(project) {
  const id = project.id || crypto.randomUUID();
  const stmt = db.prepare(`
    INSERT INTO plan_projects (id, name, description, source_file, status, total_tasks, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `);
  stmt.run(
    id,
    project.name,
    project.description || null,
    project.source_file || null,
    project.total_tasks || 0,
    new Date().toISOString()
  );
  return getPlanProject(id);
}

/**
 * Get plan project by ID
 */
function getPlanProject(projectId) {
  const stmt = db.prepare('SELECT * FROM plan_projects WHERE id = ?');
  return stmt.get(projectId) || null;
}

/**
 * List plan projects with optional filtering
 */
function listPlanProjects(options = {}) {
  let query = 'SELECT * FROM plan_projects WHERE 1=1';
  const values = [];

  if (options.status) {
    query += ' AND status = ?';
    values.push(options.status);
  }

  query += ' ORDER BY created_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  }

  const stmt = db.prepare(query);
  return stmt.all(...values);
}

/**
 * Update plan project status and counters
 */
function updatePlanProject(projectId, updates) {
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (['status', 'completed_tasks', 'failed_tasks', 'completed_at', 'total_tasks'].includes(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getPlanProject(projectId);

  values.push(projectId);
  const stmt = db.prepare(`UPDATE plan_projects SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);
  return getPlanProject(projectId);
}

/**
 * Link a task to a plan project with dependencies
 * @param {string} projectId - Plan project identifier.
 * @param {string} taskId - Task identifier.
 * @param {number} sequenceNumber - Task sequence number.
 * @param {Array<string>} [dependsOn=[]] - Task dependencies within the plan.
 * @returns {void}
 */
function addTaskToPlanProject(projectId, taskId, sequenceNumber, dependsOn = []) {
  const stmt = db.prepare(`
    INSERT INTO plan_project_tasks (project_id, task_id, sequence_number, depends_on)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(projectId, taskId, sequenceNumber, JSON.stringify(dependsOn));
}

/**
 * Get plan project task link
 */
function getPlanProjectTask(taskId) {
  const stmt = db.prepare('SELECT * FROM plan_project_tasks WHERE task_id = ?');
  const row = stmt.get(taskId);
  if (row && row.depends_on) {
    row.depends_on = JSON.parse(row.depends_on);
  }
  return row;
}

/**
 * Get all tasks for a plan project with their dependencies
 */
function getPlanProjectTasks(projectId) {
  const stmt = db.prepare(`
    SELECT pt.*, t.status, t.task_description, t.provider, t.created_at as task_created_at
    FROM plan_project_tasks pt
    JOIN tasks t ON pt.task_id = t.id
    WHERE pt.project_id = ?
    ORDER BY pt.sequence_number
  `);
  const rows = stmt.all(projectId);
  return rows.map(row => ({
    ...row,
    depends_on: safeJsonParse(row.depends_on, [])
  }));
}

/**
 * Get tasks that depend on a given task (within same plan project)
 */
function getDependentPlanTasks(taskId) {
  const projectTask = getPlanProjectTask(taskId);
  if (!projectTask) return [];

  const stmt = db.prepare(`
    SELECT pt.task_id, pt.depends_on
    FROM plan_project_tasks pt
    WHERE pt.project_id = ?
  `);
  const rows = stmt.all(projectTask.project_id);

  // Find tasks where depends_on includes this taskId
  return rows.filter(row => {
    const deps = safeJsonParse(row.depends_on, []);
    return deps.includes(taskId);
  }).map(row => row.task_id);
}

/**
 * Check if all dependencies of a plan project task are completed
 * @param {string} taskId - Task identifier.
 * @returns {boolean} True when all dependencies are completed.
 */
function areAllPlanDependenciesComplete(taskId) {
  const projectTask = getPlanProjectTask(taskId);
  if (!projectTask || !projectTask.depends_on || projectTask.depends_on.length === 0) {
    return true;
  }

  for (const depTaskId of projectTask.depends_on) {
    const depTask = getTask(depTaskId);
    if (!depTask || depTask.status !== 'completed') {
      return false;
    }
  }
  return true;
}

/**
 * Check if any dependency of a plan project task has failed
 */
function hasFailedPlanDependency(taskId) {
  const projectTask = getPlanProjectTask(taskId);
  if (!projectTask || !projectTask.depends_on || projectTask.depends_on.length === 0) {
    return false;
  }

  for (const depTaskId of projectTask.depends_on) {
    const depTask = getTask(depTaskId);
    if (depTask && (depTask.status === 'failed' || depTask.status === 'blocked')) {
      return true;
    }
  }
  return false;
}

/**
 * Delete a plan project and its task associations
 * @param {string} projectId
 */
function deletePlanProject(projectId) {
  const delTasks = db.prepare('DELETE FROM plan_project_tasks WHERE project_id = ?');
  const delProject = db.prepare('DELETE FROM plan_projects WHERE id = ?');
  delTasks.run(projectId);
  delProject.run(projectId);
}

module.exports = {
  setDb,
  setGetTask,
  createPlanProject,
  getPlanProject,
  listPlanProjects,
  updatePlanProject,
  addTaskToPlanProject,
  getPlanProjectTask,
  getPlanProjectTasks,
  getDependentPlanTasks,
  areAllPlanDependenciesComplete,
  hasFailedPlanDependency,
  deletePlanProject,
};
