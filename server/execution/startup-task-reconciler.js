'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');
const { buildResumeContext, prependResumeContextToPrompt } = require('../utils/resume-context');
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

function isMissingWorkingDirectory(workingDirectory) {
  if (typeof workingDirectory !== 'string' || workingDirectory.trim() === '') {
    return false;
  }
  try {
    return !fs.existsSync(workingDirectory);
  } catch {
    return true;
  }
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

function failMissingWorkingDirectory({ original, metadata, taskCore, rawDb, logger }) {
  const message = `[startup-reconciler] task was not resubmitted because working_directory no longer exists: ${original.working_directory}`;
  const completedAt = new Date().toISOString();
  const errorOutput = `${original.error_output || ''}\n${message}`;
  const nextMetadata = {
    ...metadata,
    reconciler: 'startup',
    restart_resubmit_skipped: 'missing_working_directory',
    missing_working_directory: original.working_directory,
  };

  try {
    if (original.status === 'cancelled') {
      rawDb.prepare(`
        UPDATE tasks
        SET status = 'failed', cancel_reason = NULL, error_output = ?, completed_at = ?, metadata = ?
        WHERE id = ?
      `).run(errorOutput, completedAt, JSON.stringify(nextMetadata), original.id);
    } else {
      taskCore.updateTaskStatus(original.id, 'failed', {
        error_output: errorOutput,
        completed_at: completedAt,
      });
    }
  } finally {
    patchOriginalMetadata(taskCore, rawDb, original.id, nextMetadata);
  }

  safeLog(logger, 'info', `Startup task reconciler marked missing-workdir task terminal ${original.id}`, {
    task_id: original.id,
    working_directory: original.working_directory,
  });
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
    task_description: prependResumeContextToPrompt(original.task_description, resumeContext),
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
    retry_requeued: 0,
    retry_exhausted_failed: 0,
    missing_workdir_failed: 0,
    errors: 0,
  };

  const orphanedOrDrainCancelled = rawDb
    .prepare(`
      SELECT * FROM tasks
      WHERE status IN ('running','claimed','retry_scheduled')
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
      if (original.status === 'retry_scheduled') {
        const retryCount = (typeof original.retry_count === 'number') ? original.retry_count : 0;
        const maxRetries = (typeof original.max_retries === 'number') ? original.max_retries : null;
        const exhausted = maxRetries !== null && retryCount >= maxRetries;
        if (exhausted) {
          taskCore.updateTaskStatus(original.id, 'failed', {
            error_output: `${original.error_output || ''}\n[startup-reconciler] retry budget exhausted (${retryCount}/${maxRetries}); retry_scheduled timer was lost to server restart`,
            completed_at: new Date().toISOString(),
          });
          actions.retry_exhausted_failed++;
          safeLog(logger, 'warn', `Startup task reconciler failed retry_scheduled task ${original.id} — budget exhausted`, {
            task_id: original.id,
            retry_count: retryCount,
            max_retries: maxRetries,
          });
        } else {
          taskCore.updateTaskStatus(original.id, 'queued', {
            error_output: `${original.error_output || ''}\n[startup-reconciler] re-queued after retry_scheduled timer was lost to server restart`,
          });
          actions.retry_requeued++;
          safeLog(logger, 'info', `Startup task reconciler re-queued retry_scheduled task ${original.id}`, {
            task_id: original.id,
            retry_count: retryCount,
            max_retries: maxRetries,
          });
        }
        continue;
      }

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

      if (eligible && isMissingWorkingDirectory(original.working_directory)) {
        failMissingWorkingDirectory({ original, metadata, taskCore, rawDb, logger });
        actions.missing_workdir_failed++;
        continue;
      }

      const failedOutput = `${original.error_output || ''}\n[startup-reconciler] task marked failed by server restart`;
      const completedAt = new Date().toISOString();
      if (original.status === 'cancelled') {
        rawDb.prepare(`
          UPDATE tasks
          SET status = 'failed', cancel_reason = NULL, error_output = ?, completed_at = ?
          WHERE id = ?
        `).run(failedOutput, completedAt, original.id);
      } else {
        taskCore.updateTaskStatus(original.id, 'failed', {
          error_output: failedOutput,
          completed_at: completedAt,
        });
      }
      actions.cancelled++;

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
    reconciled: actions.cancelled > 0 || actions.cloned > 0 || actions.constraint_skipped > 0 || actions.missing_workdir_failed > 0,
    actions,
  };
}

module.exports = {
  reconcileOrphanedTasksOnStartup,
};
