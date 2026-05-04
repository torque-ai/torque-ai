'use strict';

const TERMINAL_WORKFLOW_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'skipped',
]);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);
const UNBLOCKING_DEPENDENCY_STATUSES = new Set(['completed', 'skipped']);

// ── Legacy module-level state, written only by init() (deprecated) ─────────
// Phase 3 of the universal-DI migration. Coexistence pattern.
let db = null;
let eventBus = { emitQueueChanged: () => {} };
let logger = { info: () => {} };

/** @deprecated Use createWorkflowResume(deps) or container.get('workflowResume'). */
function init(deps = {}) {
  if (deps.db) db = deps.db;
  if (deps.eventBus) eventBus = deps.eventBus;
  if (deps.logger) logger = deps.logger;
}

function getDb() {
  if (!db) {
    throw new Error('workflow-resume requires init({ db }) before use');
  }
  return db;
}

function getRawDb() {
  const dbHandle = getDb();
  if (dbHandle && typeof dbHandle.getDbInstance === 'function') return dbHandle.getDbInstance();
  if (dbHandle && typeof dbHandle.getDb === 'function') return dbHandle.getDb();
  if (dbHandle && typeof dbHandle.prepare === 'function') return dbHandle;
  return null;
}

function getDependencyRows(taskId) {
  const dbHandle = getDb();
  if (dbHandle && typeof dbHandle.getTaskDependencies === 'function') {
    return dbHandle.getTaskDependencies(taskId) || [];
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
  const dbHandle = getDb();
  if (!dep) return null;
  if (dep.depends_on_status) return dep.depends_on_status;
  if (dep.status) return dep.status;
  if (dep.depends_on_task_id && typeof dbHandle.getTask === 'function') {
    const task = dbHandle.getTask(dep.depends_on_task_id);
    return task?.status || null;
  }
  return null;
}

function dependenciesAreSatisfied(taskId) {
  const dbHandle = getDb();
  if (typeof dbHandle.isTaskUnblockable === 'function') {
    return Boolean(dbHandle.isTaskUnblockable(taskId));
  }

  const deps = getDependencyRows(taskId);
  return deps.every(dep => UNBLOCKING_DEPENDENCY_STATUSES.has(getDependencyStatus(dep)));
}

function finalizeWorkflowIfTerminal(workflowId) {
  const dbHandle = getDb();
  const tasks = dbHandle.getWorkflowTasks(workflowId) || [];
  const allTerminal = tasks.length > 0 && tasks.every(task => TERMINAL_TASK_STATUSES.has(task.status));
  if (!allTerminal) return false;

  const failedCount = tasks.filter(task => task.status === 'failed').length;
  const newStatus = failedCount > 0 ? 'failed' : 'completed';
  dbHandle.updateWorkflow(workflowId, {
    status: newStatus,
    completed_at: new Date().toISOString(),
  });
  logger.info(`[resume] Finalized workflow ${workflowId} as ${newStatus} (${failedCount} failed tasks)`);
  return true;
}

function resumeWorkflow(workflowId) {
  const dbHandle = getDb();
  const workflow = dbHandle.getWorkflow(workflowId);
  if (!workflow) return { error: 'not_found' };
  if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
    return { skipped: true, reason: `workflow status=${workflow.status}` };
  }

  const tasks = dbHandle.getWorkflowTasks(workflowId) || [];
  let unblocked = 0;

  for (const task of tasks) {
    if (task.status !== 'blocked') continue;
    if (!dependenciesAreSatisfied(task.id)) continue;

    dbHandle.updateTaskStatus(task.id, 'queued');
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
  const dbHandle = getDb();
  const rawDb = getRawDb();
  if (rawDb && typeof rawDb.prepare === 'function') {
    return rawDb.prepare("SELECT id FROM workflows WHERE status = 'running'").all();
  }

  if (typeof dbHandle.listWorkflows === 'function') {
    return (dbHandle.listWorkflows({ status: 'running' }) || []).map(workflow => ({ id: workflow.id }));
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

// ── New factory shape (preferred) ─────────────────────────────────────────
function createWorkflowResume(deps = {}) {
  const local = {
    db: deps.db,
    eventBus: deps.eventBus || { emitQueueChanged: () => {} },
    logger: deps.logger || { info: () => {} },
  };
  function withLocalDeps(fn) {
    const prev = { db, eventBus, logger };
    db = local.db; eventBus = local.eventBus; logger = local.logger;
    try { return fn(); } finally { ({ db, eventBus, logger } = prev); }
  }
  return {
    resumeWorkflow: (...args) => withLocalDeps(() => resumeWorkflow(...args)),
    resumeAllRunningWorkflows: (...args) => withLocalDeps(() => resumeAllRunningWorkflows(...args)),
  };
}

function register(container) {
  container.register(
    'workflowResume',
    ['db', 'eventBus', 'logger'],
    (deps) => createWorkflowResume(deps)
  );
}

module.exports = {
  // New shape (preferred)
  createWorkflowResume,
  register,
  // Legacy shape (kept until task-manager.js migrates)
  init,
  resumeWorkflow,
  resumeAllRunningWorkflows,
};
