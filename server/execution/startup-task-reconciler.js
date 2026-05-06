'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');
const { buildResumeContext, prependResumeContextToPrompt } = require('../utils/resume-context');
const {
  buildCombinedProcessOutput,
  detectSuccessFromOutput,
} = require('../validation/completion-detection');
const defaultLogger = require('../logger').child({ component: 'startup-task-reconciler' });
const {
  appendRollbackReport,
  rollbackAgenticTaskChanges,
} = require('./agentic-orphan-rollback');
const { isRestartBarrierTask } = require('./restart-barrier');

// Subprocess-detachment Phase C: PID-reuse defense window. If a row's
// subprocess_pid is still alive but the on-disk log file hasn't been
// written to in this window, treat the PID as recycled (a different
// process now owns it) and fall through to the normal orphan path.
// 5 min default — tuned against codex's typical idle-output cadence
// (sub-banner → tool output every 1-3 min for active work). Override via
// TORQUE_READOPT_LOG_STALE_MS.
const READOPT_LOG_STALE_MS_DEFAULT = 5 * 60 * 1000;

// Restart-resubmit cap. The original 3 was tuned for the codex-only
// world where most providers re-adopt their subprocess on restart —
// non-detachable providers (ollama, ollama-agentic, anthropic, etc.)
// burn through the cap quickly because they get cloned anew on every
// restart. With multiple cutovers per hour observed in practice, 3
// caused real ollama-agentic work to be abandoned (DLPhone WI #161
// 10bc5f57 was at restart_resubmit_count=3 on 2026-05-05).
// Override via TORQUE_RESTART_RESUBMIT_CAP. Detachable subprocesses
// (codex/codex-spark/claude-cli) don't increment the counter at all
// — they re-adopt via PID-liveness, no clone needed — so this cap
// only governs HTTP/agentic providers.
const RESTART_RESUBMIT_CAP = (() => {
  const parsed = Number.parseInt(process.env.TORQUE_RESTART_RESUBMIT_CAP || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
})();

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

function isPidAlive(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function hasCompletedOutput(task) {
  const combinedOutput = buildCombinedProcessOutput(task?.output || '', task?.error_output || '');
  if (!/^Commit:\s*`?[0-9a-f]{7,40}`?/im.test(combinedOutput)) {
    return false;
  }
  return detectSuccessFromOutput(combinedOutput, task?.provider || 'default');
}

function releaseCompletionSideEffects(taskId, logger) {
  try {
    const fileBaselines = require('../db/file/baselines');
    fileBaselines.releaseAllFileLocks(taskId);
  } catch (err) {
    safeLog(logger, 'debug', 'Startup task reconciler could not release file locks for completed orphan', {
      task_id: taskId,
      error: err.message,
    });
  }

  try {
    const coordination = require('../db/coordination');
    const claims = coordination.listClaims({ task_id: taskId, status: 'active' });
    for (const claim of claims) {
      coordination.releaseTaskClaim(claim.id);
    }
  } catch (err) {
    safeLog(logger, 'debug', 'Startup task reconciler could not release coordination claims for completed orphan', {
      task_id: taskId,
      error: err.message,
    });
  }
}

function completeFinishedOrphan({ original, taskCore, logger }) {
  if (original?.status !== 'running') {
    return false;
  }
  if (isPidAlive(original.pid)) {
    return false;
  }
  if (!hasCompletedOutput(original)) {
    return false;
  }

  taskCore.updateTaskStatus(original.id, 'completed', {
    exit_code: 0,
    pid: null,
    ollama_host_id: null,
    mcp_instance_id: null,
  });
  releaseCompletionSideEffects(original.id, logger);
  safeLog(logger, 'info', 'Startup task reconciler marked dead-PID task completed from persisted final output', {
    task_id: original.id,
    provider: original.provider || null,
  });
  return true;
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

function getTaskTags(task) {
  return normalizeTagsForCreate(task?.tags);
}

function tagsContainFactory(tags) {
  if (Array.isArray(tags)) {
    return tags.some(tag => String(tag).includes('factory'));
  }
  return String(tags || '').includes('factory');
}

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getTaskTagValue(task, prefix) {
  const tags = getTaskTags(task);
  const tag = tags.find(item => typeof item === 'string' && item.startsWith(prefix));
  const value = tag ? tag.slice(prefix.length).trim() : '';
  return value || null;
}

function getFactoryProjectIdFromTask(task) {
  const direct = getTaskTagValue(task, 'factory:project_id=');
  if (direct) return direct;

  const batchId = getTaskTagValue(task, 'factory:batch_id=');
  if (batchId) {
    const match = batchId.match(/^factory-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i);
    if (match) return match[1];
  }

  const metadata = parseMetadata(task?.metadata);
  const metadataProjectId = normalizeNonEmptyString(metadata.project_id);
  if (metadataProjectId) return metadataProjectId;

  return null;
}

function getFactoryTargetProjectName(task) {
  const targetName = getTaskTagValue(task, 'factory:target_project=');
  if (targetName) return targetName;

  const tags = getTaskTags(task);
  const projectTag = tags.find(tag => typeof tag === 'string' && tag.startsWith('project:'));
  if (projectTag) {
    const projectName = projectTag.slice('project:'.length).trim();
    if (projectName && !projectName.startsWith('factory-')) return projectName;
  }

  const metadata = parseMetadata(task?.metadata);
  const metadataTargetProject = normalizeNonEmptyString(metadata.target_project);
  if (metadataTargetProject) return metadataTargetProject;

  return null;
}

function isFactoryPlanGenerationTask(task, metadata = parseMetadata(task?.metadata)) {
  if (metadata.kind === 'plan_generation') return true;
  return getTaskTags(task).includes('factory:plan_generation');
}

function getFactoryPlanGenerationProjectKey(task, metadata = parseMetadata(task?.metadata)) {
  if (!isFactoryPlanGenerationTask(task, metadata)) return null;

  const projectId = normalizeNonEmptyString(metadata.project_id) || getFactoryProjectIdFromTask(task);
  if (projectId) return `project_id:${projectId.toLowerCase()}`;

  const targetProject = normalizeNonEmptyString(metadata.target_project) || getFactoryTargetProjectName(task);
  if (targetProject) return `target_project:${targetProject.toLowerCase()}`;

  const workingDirectory = normalizeNonEmptyString(metadata.working_directory)
    || normalizeNonEmptyString(task?.working_directory);
  if (workingDirectory) return `working_directory:${workingDirectory.toLowerCase()}`;

  return null;
}

function findActiveFactoryPlanGenerationForProject(rawDb, original, metadata, excludeIds = new Set()) {
  const projectKey = getFactoryPlanGenerationProjectKey(original, metadata);
  if (!projectKey || !rawDb || typeof rawDb.prepare !== 'function') return null;

  let rows = [];
  try {
    rows = rawDb.prepare(`
      SELECT *
      FROM tasks
      WHERE status IN ('pending','queued','running','claimed','waiting','retry_scheduled','pending_provider_switch')
        AND (
          tags LIKE '%factory:plan_generation%'
          OR json_extract(metadata, '$.kind') = 'plan_generation'
        )
      ORDER BY
        CASE status
          WHEN 'running' THEN 0
          WHEN 'claimed' THEN 1
          WHEN 'queued' THEN 2
          WHEN 'pending' THEN 3
          ELSE 4
        END,
        created_at DESC
      LIMIT 200
    `).all();
  } catch {
    return null;
  }

  return rows.find((row) => {
    if (!row?.id || row.id === original.id || excludeIds.has(row.id)) return false;
    const rowMetadata = parseMetadata(row.metadata);
    return getFactoryPlanGenerationProjectKey(row, rowMetadata) === projectKey;
  }) || null;
}

function markFactoryPlanGenerationDuplicate({
  original,
  metadata,
  taskCore,
  rawDb,
  logger,
  supersededByTaskId,
  reason,
}) {
  const nextMetadata = {
    ...metadata,
    reconciler: 'startup',
    restart_resubmit_skipped: reason,
    superseded_by_task_id: supersededByTaskId,
    resubmitted_as: supersededByTaskId,
  };
  patchOriginalMetadata(taskCore, rawDb, original.id, nextMetadata);
  safeLog(logger, 'info', `Startup task reconciler skipped duplicate factory plan-generation task ${original.id}`, {
    task_id: original.id,
    superseded_by_task_id: supersededByTaskId,
    reason,
  });
}

function isFactoryProjectPaused(task, rawDb) {
  if (!tagsContainFactory(task?.tags)) return false;
  if (!rawDb || typeof rawDb.prepare !== 'function') return false;

  try {
    const projectId = getFactoryProjectIdFromTask(task);
    if (projectId) {
      const row = rawDb.prepare('SELECT status FROM factory_projects WHERE id = ?').get(projectId);
      if (row && String(row.status || '').toLowerCase() === 'paused') return true;
    }

    const targetName = getFactoryTargetProjectName(task);
    if (targetName) {
      const row = rawDb.prepare('SELECT status FROM factory_projects WHERE name = ?').get(targetName);
      if (row && String(row.status || '').toLowerCase() === 'paused') return true;
    }
  } catch {
    return false;
  }

  return false;
}

function getRestartResubmitCount(metadata) {
  const count = Number(metadata.restart_resubmit_count || 0);
  return Number.isFinite(count) ? count : 0;
}

function isEligibleForClone(original, metadata, db, rawDb) {
  // Project being paused is the right gate for accepting NEW work, not
  // for preserving in-flight work that was already running when the
  // restart hit. The clone lands in `queued` and the queue scheduler
  // already refuses to promote queued tasks for paused projects, so we
  // can safely clone now and let the gate fire later when the project
  // actually resumes. Skipping the clone here loses the prior partial
  // output for no benefit.
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
    // eslint-disable-next-line torque/no-sync-fs-on-hot-paths -- startup reconciler — runs once at server boot.
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
  delete cloneMetadata.resubmitted_as;
  delete cloneMetadata.restart_resubmit_skipped;
  delete cloneMetadata.superseded_by_task_id;

  taskCore.createTask({
    id: newId,
    status: 'queued',
    task_description: prependResumeContextToPrompt(original.task_description, resumeContext),
    // Preserve the original task's project so dashboard kanban cards
    // keep the project chip on every restart-resubmit. Without this,
    // task-core.createTask sees no top-level `project`, persists null,
    // and the chip silently disappears from clones — even though the
    // `project:<name>` tag is still on the row (via tags pass-through).
    // Live observation 2026-05-05: 10bc5f57 cloned from bde04606 lost
    // its `project:torque-public` chip after restart-resubmit cycles.
    project: original.project || undefined,
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

/**
 * Subprocess-detachment Phase C: try to re-adopt a still-alive detached
 * subprocess instead of treating it as an orphan to cancel + clone.
 *
 * Three guards must all pass before we hand off to execute-cli:
 *   1. Persisted state — the row must have subprocess_pid + both log
 *      paths set. Tasks that ran under the legacy pipe path (no
 *      detachment) won't have these and will fall through.
 *   2. PID liveness — process.kill(pid, 0) returns true (or EPERM).
 *      A non-existent PID means the subprocess actually died with the
 *      previous parent.
 *   3. Log freshness — the subprocess wrote to its stdout/stderr log
 *      within READOPT_LOG_STALE_MS. If the PID is alive but the log is
 *      stale, the OS has likely recycled the PID for an unrelated
 *      process and we'd be re-adopting the wrong subprocess.
 *
 * Returns true on a successful re-adoption (caller should skip the
 * cancel-and-clone path); false otherwise.
 */
function tryReAdoptDetachedSubprocess(original, executeCli, options = {}) {
  if (!original || !executeCli || typeof executeCli.reAdoptDetachedSubprocess !== 'function') {
    return false;
  }
  const subprocessPid = Number(original.subprocess_pid);
  const stdoutPath = original.output_log_path;
  const stderrPath = original.error_log_path;
  if (!Number.isFinite(subprocessPid) || subprocessPid <= 0 || !stdoutPath || !stderrPath) {
    return false;
  }
  if (!isPidAlive(subprocessPid)) {
    return false;
  }

  const staleMs = Number.isFinite(options.staleMs) && options.staleMs > 0
    ? options.staleMs
    : (Number(process.env.TORQUE_READOPT_LOG_STALE_MS) || READOPT_LOG_STALE_MS_DEFAULT);
  // PID-reuse defense: log mtime must be within the freshness window
  // for the PID to be plausibly the same process that owned the row.
  let newestMtimeMs = 0;
  for (const candidatePath of [stdoutPath, stderrPath]) {
    try {
      const stat = fs.statSync(candidatePath);
      if (stat && stat.mtimeMs && stat.mtimeMs > newestMtimeMs) {
        newestMtimeMs = stat.mtimeMs;
      }
    } catch {
      // Missing or unreadable log file — treat as stale.
    }
  }
  if (!newestMtimeMs || (Date.now() - newestMtimeMs) > staleMs) {
    return false;
  }

  try {
    return Boolean(executeCli.reAdoptDetachedSubprocess(original.id, original));
  } catch (err) {
    safeLog(options.logger, 'warn', 'Re-adopt of detached subprocess threw', {
      task_id: original.id,
      pid: subprocessPid,
      error: err.message,
    });
    return false;
  }
}

function reconcileOrphanedTasksOnStartup({
  db,
  taskCore,
  getMcpInstanceId,
  isInstanceAlive,
  logger = defaultLogger,
  eligibleOnly = false,
  executeCli = null,
  staleMs = null,
} = {}) {
  if (!db) throw new Error('db is required');
  if (!taskCore) throw new Error('taskCore is required');

  // Lazy-resolve the execute-cli module so tests can inject a mock and
  // production gets the real DI'd singleton without circular imports.
  const resolvedExecuteCli = executeCli || (() => {
    try {
      return require('../providers/execute-cli');
    } catch {
      return null;
    }
  })();

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
    completed_from_output: 0,
    missing_workdir_failed: 0,
    re_adopted: 0,
    deduped: 0,
    errors: 0,
  };

  const orphanedOrDrainCancelled = rawDb
    .prepare(`
      SELECT * FROM tasks
      WHERE status IN ('running','claimed','retry_scheduled')
         OR (status = 'cancelled' AND cancel_reason = 'server_restart')
      ORDER BY created_at DESC
    `)
    .all();
  actions.scanned = orphanedOrDrainCancelled.length;

  const candidates = orphanedOrDrainCancelled.filter(task => (
    !isRestartBarrierTask(task)
    && isCandidateOwnedByDeadOrRestartedInstance(task, currentInstanceId, isInstanceAlive)
  ));
  actions.candidates = candidates.length;
  const candidateIds = new Set(candidates.map(task => task.id).filter(Boolean));
  const handledFactoryPlanKeys = new Map();

  for (const original of candidates) {
    try {
      if (original.status === 'retry_scheduled') {
        const retryCount = (typeof original.retry_count === 'number') ? original.retry_count : 0;
        const maxRetries = (typeof original.max_retries === 'number') ? original.max_retries : null;
        // 2026-05-03 (bba865d8 fix): a retry_scheduled task whose timer was
        // lost to a server restart hasn't actually consumed the SCHEDULED
        // retry's budget — that retry never ran. retry-framework's
        // `shouldRetry: retryCount <= maxRetries` lets the task into the
        // scheduled state when retryCount==maxRetries (the final retry).
        // The reconciler must mirror that: only treat the task as exhausted
        // when retryCount EXCEEDS maxRetries (i.e. an additional failure
        // beyond the budget-allowed retries). Using `>=` here would punish
        // server-side restarts as if they were task-side failures, which
        // led to plan_generation tasks being marked failed instead of
        // re-queued every time a TORQUE cutover interrupted them.
        const exhausted = maxRetries !== null && retryCount > maxRetries;
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

      // Subprocess-detachment Phase C: a row carrying subprocess_pid +
      // log paths from the previous parent might still own a live
      // subprocess if it was spawned via spawnAndTrackProcessDetached.
      // Try to re-adopt it before we cancel and clone — re-adoption
      // attaches a fresh Tail watcher + PID-liveness loop so the new
      // parent can finish it normally.
      if (tryReAdoptDetachedSubprocess(original, resolvedExecuteCli, { staleMs, logger })) {
        actions.re_adopted++;
        safeLog(logger, 'info', `Startup task reconciler re-adopted detached subprocess for task ${original.id}`, {
          task_id: original.id,
          subprocess_pid: original.subprocess_pid,
        });
        continue;
      }

      if (completeFinishedOrphan({ original, taskCore, logger })) {
        actions.completed_from_output++;
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

      const rollbackResult = rollbackAgenticTaskChanges(original, { logger });
      // Restart-killed tasks land here regardless of whether the drain
      // actually held them — the subprocess died with the parent process.
      // Mark `cancelled` with cancel_reason='server_restart' rather than
      // `failed` so dashboards and failure-rate counters that already
      // segregate `cancelled` don't conflate restart casualties with real
      // task failures. Eligible tasks still get cloned by the path below;
      // the visible original just stops looking like an error someone
      // needs to triage.
      const restartOutput = appendRollbackReport(
        `${original.error_output || ''}\n[startup-reconciler] task cancelled by server restart`,
        rollbackResult
      );
      const completedAt = new Date().toISOString();
      rawDb.prepare(`
        UPDATE tasks
        SET status = 'cancelled',
            cancel_reason = 'server_restart',
            error_output = ?,
            completed_at = ?
        WHERE id = ?
      `).run(restartOutput, completedAt, original.id);
      actions.cancelled++;

      if (!eligible) {
        continue;
      }

      const restartCount = getRestartResubmitCount(metadata);
      if (restartCount >= RESTART_RESUBMIT_CAP) {
        actions.capped++;
        safeLog(logger, 'warn', `Startup task reconciler skipped resubmit cap for ${original.id}`, {
          task_id: original.id,
          restart_resubmit_count: restartCount,
          cap: RESTART_RESUBMIT_CAP,
        });
        continue;
      }

      const factoryPlanKey = getFactoryPlanGenerationProjectKey(original, metadata);
      if (factoryPlanKey && handledFactoryPlanKeys.has(factoryPlanKey)) {
        const supersededByTaskId = handledFactoryPlanKeys.get(factoryPlanKey);
        markFactoryPlanGenerationDuplicate({
          original,
          metadata,
          taskCore,
          rawDb,
          logger,
          supersededByTaskId,
          reason: 'duplicate_factory_plan_generation_restart_candidate',
        });
        actions.deduped++;
        continue;
      }

      const activeFactoryPlan = factoryPlanKey
        ? findActiveFactoryPlanGenerationForProject(rawDb, original, metadata, candidateIds)
        : null;
      if (activeFactoryPlan) {
        markFactoryPlanGenerationDuplicate({
          original,
          metadata,
          taskCore,
          rawDb,
          logger,
          supersededByTaskId: activeFactoryPlan.id,
          reason: 'active_factory_plan_generation_exists',
        });
        actions.deduped++;
        continue;
      }

      const resumeContext = buildResumeContext(
        original.output || '',
        original.error_output || '',
        {
          task_description: original.task_description,
          provider: original.provider,
          duration_ms: null,
          // Pass cancel_reason so the resume-context formatter switches
          // from "(failed)" to "(interrupted by server restart)" — keeps
          // the model in resume mode rather than fix-the-bug mode.
          cancel_reason: 'server_restart',
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
      if (factoryPlanKey) {
        handledFactoryPlanKeys.set(factoryPlanKey, newId);
      }
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
    reconciled:
      actions.cancelled > 0
      || actions.cloned > 0
      || actions.constraint_skipped > 0
      || actions.completed_from_output > 0
      || actions.missing_workdir_failed > 0
      || actions.re_adopted > 0
      || actions.deduped > 0,
    actions,
  };
}

module.exports = {
  reconcileOrphanedTasksOnStartup,
  tryReAdoptDetachedSubprocess,
};
