'use strict';

/**
 * Plan Project Resolver
 *
 * Extracted from task-manager.js — resolves plan project task dependencies
 * after a task reaches a terminal state. Keeps counters and downstream task
 * statuses in sync.
 *
 * Uses the container-resolved factory shape.
 */

function getContainerDeps() {
  try {
    const { defaultContainer } = require('../container');
    return {
      db: defaultContainer.peek('db') || null,
      dashboard: defaultContainer.peek('dashboard') || null,
    };
  } catch {
    return { db: null, dashboard: null };
  }
}

/**
 * Resolve plan project dependencies after a task reaches a terminal state.
 * This keeps plan project counters and downstream task statuses in sync even
 * when tasks are completed or failed outside the main close handler.
 * @param {string} taskId - Task identifier.
 * @param {string} newStatus - New task status ('completed' or 'failed').
 * @returns {void}
 */
function handleProjectDependencyResolutionWithDeps(deps, taskId, newStatus) {
  if (!['completed', 'failed'].includes(newStatus)) return;

  const db = deps?.db;
  if (!db) {
    throw new Error('plan-project-resolver requires db dependency');
  }
  const dashboard = deps.dashboard || null;

  const projectTask = db.getPlanProjectTask(taskId);
  if (!projectTask) return;

  const project = db.getPlanProject(projectTask.project_id);
  if (!project) return;

  const updateProjectCounts = () => {
    const projectTasks = db.getPlanProjectTasks(projectTask.project_id);
    const completedTasks = projectTasks.filter(t => t.status === 'completed').length;
    const failedTasks = projectTasks.filter(t => t.status === 'failed').length;
    db.updatePlanProject(projectTask.project_id, {
      completed_tasks: completedTasks,
      failed_tasks: failedTasks
    });
    return { projectTasks, completedTasks, failedTasks };
  };

  const notifyTaskUpdated = (dependentTaskId) => {
    if (!dashboard) return;
    try {
      dashboard.notifyTaskUpdated(dependentTaskId);
    } catch {
      // Dashboard notifications are best-effort for dependency updates.
    }
  };

  const { completedTasks } = updateProjectCounts();

  if (newStatus === 'completed') {
    const dependentTaskIds = db.getDependentPlanTasks(taskId);

    for (const depTaskId of dependentTaskIds) {
      const depTask = db.getTask(depTaskId);
      if (!depTask || depTask.status !== 'waiting') continue;

      if (db.areAllPlanDependenciesComplete(depTaskId)) {
        db.updateTaskStatus(depTaskId, 'queued');
        notifyTaskUpdated(depTaskId);
      }
    }

    if (completedTasks >= project.total_tasks) {
      db.updatePlanProject(projectTask.project_id, {
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
    const dependentTaskIds = db.getDependentPlanTasks(currentId);

    for (const depTaskId of dependentTaskIds) {
      if (toBlock.has(depTaskId)) continue;

      const depTask = db.getTask(depTaskId);
      if (depTask && ['waiting', 'queued'].includes(depTask.status)) {
        toBlock.add(depTaskId);
        queue.push(depTaskId);
      }
    }
  }

  for (const depTaskId of toBlock) {
    db.updateTaskStatus(depTaskId, 'blocked');
    notifyTaskUpdated(depTaskId);
  }

  const remainingTasks = db.getPlanProjectTasks(projectTask.project_id);
  const canProceed = remainingTasks.some(t => ['queued', 'running', 'waiting'].includes(t.status));

  if (!canProceed && completedTasks < project.total_tasks) {
    db.updatePlanProject(projectTask.project_id, { status: 'failed' });
  }
}

function handleProjectDependencyResolution(taskId, newStatus) {
  return handleProjectDependencyResolutionWithDeps(getContainerDeps(), taskId, newStatus);
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
  const local = { db: deps.db, dashboard: deps.dashboard };
  return {
    handleProjectDependencyResolution: (...args) => handleProjectDependencyResolutionWithDeps(local, ...args),
    handlePlanProjectTaskCompletion: (taskId) => handleProjectDependencyResolutionWithDeps(local, taskId, 'completed'),
    handlePlanProjectTaskFailure: (taskId) => handleProjectDependencyResolutionWithDeps(local, taskId, 'failed'),
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
  createPlanProjectResolver,
  register,
  handleProjectDependencyResolution,
  handlePlanProjectTaskCompletion,
  handlePlanProjectTaskFailure,
};
