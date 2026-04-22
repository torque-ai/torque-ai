'use strict';

const db = require('../database');
const eventBus = require('../event-bus');
const logger = require('../logger').child({ component: 'workflow-resume' });

const TERMINAL_WORKFLOW_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'skipped',
]);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);
const UNBLOCKING_DEPENDENCY_STATUSES = new Set(['completed', 'skipped']);

function getRawDb() {
  if (db && typeof db.getDbInstance === 'function') return db.getDbInstance();
  if (db && typeof db.getDb === 'function') return db.getDb();
  if (db && typeof db.prepare === 'function') return db;
  return null;
}

function getDependencyRows(taskId) {
  if (db && typeof db.getTaskDependencies === 'function') {
    return db.getTaskDependencies(taskId) || [];
  }

  const rawDb = getRawDb();
  if (!rawDb || typeof rawDb.prepare !== 'function') return [];

  return rawDb.prepare(`
    SELECT t.status
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id
    WHERE d.task_id = ?
  `).all(taskId);
}

function getDependencyStatus(dep) {
  if (!dep) return null;
  if (dep.depends_on_status) return dep.depends_on_status;
  if (dep.status) return dep.status;
  if (dep.depends_on_task_id && typeof db.getTask === 'function') {
    const task = db.getTask(dep.depends_on_task_id);
    return task?.status || null;
  }
  return null;
}

function dependenciesAreSatisfied(taskId) {
  if (typeof db.isTaskUnblockable === 'function') {
    return Boolean(db.isTaskUnblockable(taskId));
  }

  const deps = getDependencyRows(taskId);
  return deps.every(dep => UNBLOCKING_DEPENDENCY_STATUSES.has(getDependencyStatus(dep)));
}

function finalizeWorkflowIfTerminal(workflowId) {
  const tasks = db.getWorkflowTasks(workflowId) || [];
  const allTerminal = tasks.length > 0 && tasks.every(task => TERMINAL_TASK_STATUSES.has(task.status));
  if (!allTerminal) return false;

  const failedCount = tasks.filter(task => task.status === 'failed').length;
  const newStatus = failedCount > 0 ? 'failed' : 'completed';
  db.updateWorkflow(workflowId, {
    status: newStatus,
    completed_at: new Date().toISOString(),
  });
  logger.info(`[resume] Finalized workflow ${workflowId} as ${newStatus} (${failedCount} failed tasks)`);
  return true;
}

function resumeWorkflow(workflowId) {
  const workflow = db.getWorkflow(workflowId);
  if (!workflow) return { error: 'not_found' };
  if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
    return { skipped: true, reason: `workflow status=${workflow.status}` };
  }

  const tasks = db.getWorkflowTasks(workflowId) || [];
  let unblocked = 0;

  for (const task of tasks) {
    if (task.status !== 'blocked') continue;
    if (!dependenciesAreSatisfied(task.id)) continue;

    db.updateTaskStatus(task.id, 'queued');
    unblocked++;
  }

  const finalized = finalizeWorkflowIfTerminal(workflowId);

  if (unblocked > 0) {
    try {
      eventBus.emitQueueChanged();
    } catch {
      // Queue-change notification is best effort; persisted task state is authoritative.
    }
  }

  return { unblocked, finalized, workflow_id: workflowId };
}

function getRunningWorkflowRows() {
  const rawDb = getRawDb();
  if (rawDb && typeof rawDb.prepare === 'function') {
    return rawDb.prepare("SELECT id FROM workflows WHERE status = 'running'").all();
  }

  if (typeof db.listWorkflows === 'function') {
    return (db.listWorkflows({ status: 'running' }) || []).map(workflow => ({ id: workflow.id }));
  }

  return [];
}

function resumeAllRunningWorkflows() {
  const rows = getRunningWorkflowRows();
  let totalUnblocked = 0;
  let evaluated = 0;

  for (const row of rows) {
    evaluated++;
    const result = resumeWorkflow(row.id);
    if (result.unblocked) totalUnblocked += result.unblocked;
  }

  return { workflows_evaluated: evaluated, tasks_unblocked: totalUnblocked };
}

module.exports = {
  resumeWorkflow,
  resumeAllRunningWorkflows,
};
