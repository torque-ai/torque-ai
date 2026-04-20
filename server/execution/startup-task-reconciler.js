'use strict';

const { randomUUID } = require('crypto');
const { buildResumeContext } = require('../utils/resume-context');
const defaultLogger = require('../logger').child({ component: 'startup-task-reconciler' });

function getDbHandle(db) {
  if (db && typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }
  return db;
}

function safeLog(logger, level, message, meta) {
  const target = logger || defaultLogger;
  const fn = target && typeof target[level] === 'function' ? target[level] : null;
  if (!fn) return;
  try {
    if (meta !== undefined) fn.call(target, message, meta);
    else fn.call(target, message);
  } catch {
    // Startup reconciliation must never fail because logging failed.
  }
}

function parseMetadata(rawMetadata) {
  if (!rawMetadata) return {};
  if (typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
    return { ...rawMetadata };
  }
  if (typeof rawMetadata !== 'string') return {};
  try {
    const parsed = JSON.parse(rawMetadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getTask(taskCore, rawDb, taskId) {
  if (!taskId) return null;
  if (taskCore && typeof taskCore.getTask === 'function') {
    return taskCore.getTask(taskId);
  }
  return rawDb.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) || null;
}

function getWorkflow(db, rawDb, workflowId) {
  if (!workflowId) return null;
  if (db && typeof db.getWorkflow === 'function') {
    return db.getWorkflow(workflowId);
  }
  try {
    return rawDb.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) || null;
  } catch {
    return null;
  }
}

function normalizeTagsForCreate(tags) {
  if (Array.isArray(tags)) return tags.filter(Boolean);
  if (typeof tags !== 'string' || tags.trim() === '') return [];
  try {
    const parsed = JSON.parse(tags);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {
    // Fall back to comma-separated legacy tags below.
  }
  return tags.split(',').map(tag => tag.trim()).filter(Boolean);
}

function tagsContainFactory(tags) {
  if (Array.isArray(tags)) {
    return tags.some(tag => String(tag).includes('factory'));
  }
  return String(tags || '').includes('factory');
}

function getRestartResubmitCount(metadata) {
  const count = Number(metadata.restart_resubmit_count || 0);
  return Number.isFinite(count) ? count : 0;
}

function isEligibleForClone(original, metadata, db, rawDb) {
  if (metadata.auto_resubmit_on_restart === true) return true;
  if (tagsContainFactory(original.tags)) return true;
  if (original.workflow_id != null) {
    const workflow = getWorkflow(db, rawDb, original.workflow_id);
    return workflow && workflow.status === 'running';
  }
  return false;
}

function isCandidateOwnedByDeadOrRestartedInstance(original, currentInstanceId, isInstanceAlive) {
  const owner = original.mcp_instance_id;
  if (!owner) return true;
  if (currentInstanceId && owner === currentInstanceId) return true;
  if (typeof isInstanceAlive !== 'function') return false;
  try {
    return !isInstanceAlive(owner);
  } catch {
    return false;
  }
}

function isSqliteConstraint(err) {
  return err && (
    err.code === 'SQLITE_CONSTRAINT'
    || err.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || /SQLITE_CONSTRAINT|UNIQUE constraint failed/i.test(String(err.message || ''))
  );
}

function updateResumeContext(rawDb, taskId, resumeContext) {
  rawDb.prepare('UPDATE tasks SET resume_context = ? WHERE id = ?').run(
    JSON.stringify(resumeContext),
    taskId,
  );
}

function patchOriginalMetadata(taskCore, rawDb, taskId, metadata) {
  if (taskCore && typeof taskCore.patchTaskMetadata === 'function') {
    return taskCore.patchTaskMetadata(taskId, metadata);
  }
  const result = rawDb.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(
    JSON.stringify(metadata),
    taskId,
  );
  return result.changes > 0;
}

function rewireWorkflowDependencies(rawDb, original, newTaskId) {
  if (!original.workflow_id) return;
  try {
    rawDb.prepare(`
      UPDATE task_dependencies
      SET task_id = ?
      WHERE task_id = ? AND workflow_id = ?
    `).run(newTaskId, original.id, original.workflow_id);
    rawDb.prepare(`
      UPDATE task_dependencies
      SET depends_on_task_id = ?
      WHERE depends_on_task_id = ? AND workflow_id = ?
    `).run(newTaskId, original.id, original.workflow_id);
  } catch {
    // Some focused tests do not create task_dependencies; Task 3 also sweeps this.
  }
}

function createClone({ original, metadata, resumeContext, taskCore, rawDb }) {
  const newId = randomUUID();
  const restartCount = getRestartResubmitCount(metadata);
  const cloneMetadata = {
    ...metadata,
    restart_resubmit_count: restartCount + 1,
    resubmitted_from: original.id,
    reconciler: 'startup',
  };

  taskCore.createTask({
    id: newId,
    status: 'queued',
    task_description: original.task_description,
    provider: original.original_provider || original.provider,
    model: original.model,
    working_directory: original.working_directory,
    timeout_minutes: original.timeout_minutes,
    priority: original.priority,
    tags: normalizeTagsForCreate(original.tags),
    workflow_id: original.workflow_id,
    workflow_node_id: original.workflow_node_id,
    resume_context: JSON.stringify(resumeContext),
    metadata: JSON.stringify(cloneMetadata),
  });

  updateResumeContext(rawDb, newId, resumeContext);
  return newId;
}

function reconcileOrphanedTasksOnStartup({
  db,
  taskCore,
  getMcpInstanceId,
  isInstanceAlive,
  logger = defaultLogger,
  eligibleOnly = false,
} = {}) {
  if (!db) throw new Error('db is required');
  if (!taskCore) throw new Error('taskCore is required');

  const rawDb = getDbHandle(db);
  const currentInstanceId = typeof getMcpInstanceId === 'function' ? getMcpInstanceId() : null;
  const actions = {
    scanned: 0,
    candidates: 0,
    cancelled: 0,
    cloned: 0,
    skipped: 0,
    capped: 0,
    constraint_skipped: 0,
    errors: 0,
  };

  const orphanedOrDrainCancelled = rawDb
    .prepare(`
      SELECT * FROM tasks
      WHERE status IN ('running','claimed')
         OR (status = 'cancelled' AND cancel_reason = 'server_restart')
    `)
    .all();
  actions.scanned = orphanedOrDrainCancelled.length;

  const candidates = orphanedOrDrainCancelled.filter(task => (
    isCandidateOwnedByDeadOrRestartedInstance(task, currentInstanceId, isInstanceAlive)
  ));
  actions.candidates = candidates.length;

  for (const original of candidates) {
    try {
      const metadata = parseMetadata(original.metadata);
      const pointedTask = metadata.resubmitted_as
        ? getTask(taskCore, rawDb, metadata.resubmitted_as)
        : null;
      if (pointedTask && pointedTask.status !== 'cancelled') {
        actions.skipped++;
        continue;
      }

      const eligible = isEligibleForClone(original, metadata, db, rawDb);
      if (eligibleOnly && !eligible) {
        actions.skipped++;
        continue;
      }

      if (original.status !== 'cancelled') {
        taskCore.updateTaskStatus(original.id, 'cancelled', {
          cancel_reason: 'server_restart',
          error_output: `${original.error_output || ''}\n[startup-reconciler] task cancelled by server restart`,
          completed_at: new Date().toISOString(),
        });
        actions.cancelled++;
      }

      if (!eligible) {
        continue;
      }

      const restartCount = getRestartResubmitCount(metadata);
      if (restartCount >= 3) {
        actions.capped++;
        safeLog(logger, 'warn', `Startup task reconciler skipped resubmit cap for ${original.id}`, {
          task_id: original.id,
          restart_resubmit_count: restartCount,
        });
        continue;
      }

      const resumeContext = buildResumeContext(
        original.output || '',
        original.error_output || '',
        {
          task_description: original.task_description,
          provider: original.provider,
          duration_ms: null,
        },
      );

      let newId;
      try {
        newId = createClone({ original, metadata, resumeContext, taskCore, rawDb });
      } catch (err) {
        if (isSqliteConstraint(err)) {
          actions.constraint_skipped++;
          safeLog(logger, 'warn', `Startup task reconciler skipped duplicate resubmit for ${original.id}`, {
            task_id: original.id,
            error: err.message,
          });
          continue;
        }
        throw err;
      }

      patchOriginalMetadata(taskCore, rawDb, original.id, {
        ...metadata,
        resubmitted_as: newId,
      });
      rewireWorkflowDependencies(rawDb, original, newId);
      actions.cloned++;
      safeLog(logger, 'info', `Startup task reconciler cloned orphaned task ${original.id}`, {
        task_id: original.id,
        clone_task_id: newId,
      });
    } catch (err) {
      actions.errors++;
      safeLog(logger, 'warn', `Startup task reconciler failed for ${original.id}: ${err.message}`, {
        task_id: original.id,
        error: err.message,
      });
    }
  }

  return {
    reconciled: actions.cancelled > 0 || actions.cloned > 0 || actions.constraint_skipped > 0,
    actions,
  };
}

module.exports = {
  reconcileOrphanedTasksOnStartup,
};
