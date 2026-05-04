'use strict';

/**
 * Plan Project Resolver
 *
 * Extracted from task-manager.js — resolves plan project task dependencies
 * after a task reaches a terminal state. Keeps counters and downstream task
 * statuses in sync.
 *
 * Uses init() dependency injection.
 */

// ── Legacy module-level state, written only by init() (deprecated) ─────────
// Phase 3 of the universal-DI migration: this module exposes both the new
// createPlanProjectResolver factory + register(container) and the legacy
// init({…}) shape. Legacy state removed when task-manager.js migrates.
let _db = null;
let _dashboard = null;

/** @deprecated Use createPlanProjectResolver(deps) or container.get('planProjectResolver'). */
function init(deps = {}) {
  if (deps.db) _db = deps.db;
  if (deps.dashboard) _dashboard = deps.dashboard;
}

/**
 * Resolve plan project dependencies after a task reaches a terminal state.
 * This keeps plan project counters and downstream task statuses in sync even
 * when tasks are completed or failed outside the main close handler.
 * @param {string} taskId - Task identifier.
 * @param {string} newStatus - New task status ('completed' or 'failed').
 * @returns {void}
 */
function handleProjectDependencyResolution(taskId, newStatus) {
  if (!['completed', 'failed'].includes(newStatus)) return;

  const projectTask = _db.getPlanProjectTask(taskId);
  if (!projectTask) return;

  const project = _db.getPlanProject(projectTask.project_id);
  if (!project) return;

  const updateProjectCounts = () => {
    const projectTasks = _db.getPlanProjectTasks(projectTask.project_id);
    const completedTasks = projectTasks.filter(t => t.status === 'completed').length;
    const failedTasks = projectTasks.filter(t => t.status === 'failed').length;
    _db.updatePlanProject(projectTask.project_id, {
      completed_tasks: completedTasks,
      failed_tasks: failedTasks
    });
    return { projectTasks, completedTasks, failedTasks };
  };

  const notifyTaskUpdated = (dependentTaskId) => {
    if (!_dashboard) return;
    try {
      _dashboard.notifyTaskUpdated(dependentTaskId);
    } catch {
      // Dashboard notifications are best-effort for dependency updates.
    }
  };

  const { completedTasks } = updateProjectCounts();

  if (newStatus === 'completed') {
    const dependentTaskIds = _db.getDependentPlanTasks(taskId);

    for (const depTaskId of dependentTaskIds) {
      const depTask = _db.getTask(depTaskId);
      if (!depTask || depTask.status !== 'waiting') continue;

      if (_db.areAllPlanDependenciesComplete(depTaskId)) {
        _db.updateTaskStatus(depTaskId, 'queued');
        notifyTaskUpdated(depTaskId);
      }
    }

    if (completedTasks >= project.total_tasks) {
      _db.updatePlanProject(projectTask.project_id, {
        status: 'completed',
        completed_at: new Date().toISOString()
      });
    }

    return;
  }

  const toBlock = new Set();
  const queue = [taskId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const dependentTaskIds = _db.getDependentPlanTasks(currentId);

    for (const depTaskId of dependentTaskIds) {
      if (toBlock.has(depTaskId)) continue;

      const depTask = _db.getTask(depTaskId);
      if (depTask && ['waiting', 'queued'].includes(depTask.status)) {
        toBlock.add(depTaskId);
        queue.push(depTaskId);
      }
    }
  }

  for (const depTaskId of toBlock) {
    _db.updateTaskStatus(depTaskId, 'blocked');
    notifyTaskUpdated(depTaskId);
  }

  const remainingTasks = _db.getPlanProjectTasks(projectTask.project_id);
  const canProceed = remainingTasks.some(t => ['queued', 'running', 'waiting'].includes(t.status));

  if (!canProceed && completedTasks < project.total_tasks) {
    _db.updatePlanProject(projectTask.project_id, { status: 'failed' });
  }
}

/**
 * Handle plan project task completion — queue dependent tasks if ready.
 * @param {string} taskId
 */
function handlePlanProjectTaskCompletion(taskId) {
  return handleProjectDependencyResolution(taskId, 'completed');
}

/**
 * Handle plan project task failure — block dependent tasks.
 * @param {string} taskId
 */
function handlePlanProjectTaskFailure(taskId) {
  return handleProjectDependencyResolution(taskId, 'failed');
}

// ── New factory shape (preferred) ─────────────────────────────────────────
function createPlanProjectResolver(deps = {}) {
  const local = { _db: deps.db, _dashboard: deps.dashboard };
  function withLocalDeps(fn) {
    const prev = { _db, _dashboard };
    _db = local._db; _dashboard = local._dashboard;
    try { return fn(); } finally { ({ _db, _dashboard } = prev); }
  }
  return {
    handleProjectDependencyResolution: (...args) => withLocalDeps(() => handleProjectDependencyResolution(...args)),
    handlePlanProjectTaskCompletion: (...args) => withLocalDeps(() => handlePlanProjectTaskCompletion(...args)),
    handlePlanProjectTaskFailure: (...args) => withLocalDeps(() => handlePlanProjectTaskFailure(...args)),
  };
}

function register(container) {
  container.register(
    'planProjectResolver',
    ['db', 'dashboard'],
    (deps) => createPlanProjectResolver(deps)
  );
}

module.exports = {
  // New shape (preferred)
  createPlanProjectResolver,
  register,
  // Legacy shape (kept until task-manager.js migrates)
  init,
  handleProjectDependencyResolution,
  handlePlanProjectTaskCompletion,
  handlePlanProjectTaskFailure,
};
