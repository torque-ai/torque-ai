'use strict';

/**
 * Retry framework — Phase 1 of the close-handler sequence.
 *
 * Handles:
 *   - Error classification (retryable vs non-retryable)
 *   - Retry scheduling with exponential backoff
 *   - Retry attempt recording
 *   - Retry webhook dispatch
 *   - MCP SSE notification for retry events
 *
 * Extracted from task-manager.js (D4.2 optional extraction).
 */

const logger = require('../logger').child({ component: 'retry-framework' });
const {
  buildResumeContext,
  prependResumeContextToPrompt,
} = require('../utils/resume-context');

// ── Module-level deps slot ─────────────────────────────────────────────────
// Production callers reach handleRetryLogic through createRetryFramework's
// per-instance withLocalDeps swap (driven by container.get('retryFramework')),
// so this slot stays empty at runtime in normal flows. Tests that still
// drive the raw export populate it through init().
let deps = {};

/**
 * @internal — test-only override path. Production resolves all deps via
 * createRetryFramework(localDeps) inside the container factory and reaches
 * handleRetryLogic through its swap wrapper. Test fixtures that still call
 * the raw module export use this entry point until they migrate to
 * createRetryFramework(deps).
 */
function init(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
  if (!deps.taskCleanupGuard || !deps.pendingRetryTimeouts) {
    const { defaultContainer } = require('../container');
    const tracker = defaultContainer.peek('processTracker');
    if (tracker) {
      if (!deps.taskCleanupGuard && tracker.cleanupGuard) {
        deps.taskCleanupGuard = tracker.cleanupGuard;
      }
      if (!deps.pendingRetryTimeouts && tracker.retryTimeouts) {
        deps.pendingRetryTimeouts = tracker.retryTimeouts;
      }
    }
  }
}

function getRetryAttemptDurationMs(task) {
  const startedAt = task?.started_at ? new Date(task.started_at).getTime() : NaN;
  if (Number.isFinite(startedAt)) {
    return Math.max(0, Date.now() - startedAt);
  }
  return 0;
}

function sanitizeOutput(text) {
  return typeof deps.sanitizeTaskOutput === 'function'
    ? deps.sanitizeTaskOutput(text || '')
    : (text || '');
}

function buildRetryResumeFields(task, proc, sanitizedOutput) {
  try {
    const resumeContext = buildResumeContext(
      sanitizedOutput,
      proc.errorOutput || '',
      {
        task_description: task.task_description,
        durationMs: getRetryAttemptDurationMs(task),
        provider: task.provider,
      },
    );
    // prependResumeContextToPrompt strips any existing `## Previous Attempt`
    // preamble before re-prepending (default options.replaceExisting=true).
    // This is the contract that prevents this call from stacking on top of
    // fallback-retry.js's withResumeContextPrompt when both fire in the same
    // task lifetime (recovery-decisions.md conflict #3). Both consumers pass
    // the same task.task_description and rely on the strip-first behavior in
    // server/utils/resume-context.js.
    const taskDescription = prependResumeContextToPrompt(task.task_description, resumeContext);
    return {
      resume_context: resumeContext,
      ...(taskDescription !== task.task_description ? { task_description: taskDescription } : {}),
    };
  } catch (err) {
    logger.info(`Failed to build retry resume context for task ${task.id}:`, err.message);
    return {};
  }
}

/**
 * Phase 1: Error classification, retry scheduling, retry webhook.
 * Only runs when code !== 0. Sets ctx.earlyExit = true if retry is scheduled.
 */
function handleRetryLogic(ctx) {
  const { taskId, code, proc } = ctx;
  const errorClassification = deps.classifyError(proc.errorOutput, code);

  let retryInfo = null;
  if (errorClassification.retryable) {
    try {
      retryInfo = deps.db.incrementRetry(taskId);
    } catch (retryErr) {
      logger.info(`Failed to check retry for task ${taskId}:`, retryErr.message);
    }
  } else {
    logger.info(`Task ${taskId} failed with non-retryable error: ${errorClassification.reason}`);
  }

  if (!(retryInfo && retryInfo.shouldRetry && errorClassification.retryable)) {
    return; // Fall through to normal failure handling
  }

  const task = deps.db.getTask(taskId);
  if (!task) {
    logger.info(`Task ${taskId} not found during retry - skipping retry`);
    return;
  }
  // stall-and-retry.md #1 — opt-in joint cap. When `combined_max_attempts`
  // is set (>0), refuse to schedule a retry if the SUM of retry_count and
  // stall_recovery_attempts meets it. Default 0 = disabled (preserves
  // independent counters; existing budgets continue to apply unchanged).
  // We check AFTER incrementRetry so retry_count reflects the just-bumped
  // value; if cap is hit, the task falls through to normal failure
  // handling (close handler marks it failed).
  //
  // Resolves serverConfig from deps when injected, otherwise lazy-requires
  // the production module. The lazy path is best-effort: any error is
  // logged once and the cap is treated as disabled so the test/legacy
  // path never accidentally trips with an unconfigured 0 default.
  try {
    let combinedMax = 0;
    if (deps.serverConfig && typeof deps.serverConfig.getInt === 'function') {
      combinedMax = deps.serverConfig.getInt('combined_max_attempts', 0);
    } else {
      try {
        combinedMax = require('../config').getInt('combined_max_attempts', 0);
      } catch {
        combinedMax = 0; // production config unavailable — default to disabled
      }
    }
    if (combinedMax > 0) {
      const stallAttempts = Number.isFinite(Number(task.stall_recovery_attempts))
        ? Number(task.stall_recovery_attempts)
        : 0;
      const combined = (task.retry_count || 0) + stallAttempts;
      if (combined >= combinedMax) {
        logger.info(`Task ${taskId} retry refused: combined attempt cap reached (retry=${task.retry_count} + stall=${stallAttempts} = ${combined} >= ${combinedMax}) — falling through to failure`);
        return; // close handler will mark failed
      }
    }
  } catch (capErr) {
    logger.info(`Task ${taskId} combined-cap check skipped: ${capErr.message}`);
  }
  // stall-and-retry.md #10 — when classifyError extracted a Retry-After
  // hint from the error output (`retry_after_seconds=N`), honor it as a
  // floor on the retry delay. Without this, a 429 with `Retry-After: 300`
  // and a task at attempt 1 would retry in 5s (the exponential base),
  // get rate-limited again, and burn through the retry budget. The
  // exponential schedule is still respected for later attempts where it
  // exceeds the server's hint.
  const baseDelaySec = deps.db.calculateRetryDelay(task);
  const retryAfterSec = Number.isFinite(errorClassification.retryAfterSeconds)
    && errorClassification.retryAfterSeconds > 0
    ? errorClassification.retryAfterSeconds
    : 0;
  const delayMs = Math.max(baseDelaySec, retryAfterSec) * 1000;

  if (retryAfterSec > 0 && retryAfterSec > baseDelaySec) {
    logger.info(`Task ${taskId} retry delay raised by Retry-After hint: ${baseDelaySec}s base → ${retryAfterSec}s server-suggested`);
  }
  logger.info(`Task ${taskId} will retry in ${delayMs/1000}s (attempt ${retryInfo.retryCount}/${retryInfo.maxRetries}): ${errorClassification.reason}`);
  const sanitizedOutput = sanitizeOutput(proc.output);

  // Record retry attempt
  try {
    deps.db.recordRetryAttempt(taskId, {
      attempt_number: retryInfo.retryCount,
      delay_used: Math.floor(delayMs / 1000),
      error_message: `${errorClassification.reason}: ${proc.errorOutput.substring(0, 400)}`
    });
  } catch (recordErr) {
    logger.info(`Failed to record retry attempt for task ${taskId}:`, recordErr.message);
  }

  // stall-and-retry.md #9 — record a failover_events row for this retry
  // so analytics queries that aggregate provider-switch behavior see Phase
  // 1 retries alongside stall-recovery requeues. Today the retry is
  // same-provider (handleRetryLogic doesn't change task.provider), so
  // from_provider == to_provider; the row still surfaces "this task
  // retried with reason=<class>" for retry-rate dashboards. When a future
  // change adds provider switching here, the audit trail is already in
  // place — no need to retrofit recording at that point. Best-effort:
  // missing recordFailoverEvent (legacy db shapes) is silently skipped.
  try {
    if (typeof deps.db.recordFailoverEvent === 'function') {
      deps.db.recordFailoverEvent({
        task_id: taskId,
        from_provider: task.provider,
        to_provider: task.provider, // same-provider retry today
        from_model: task.model,
        to_model: task.model,
        reason: `Retry: ${errorClassification.reason}`,
        failover_type: 'retry',
        attempt_num: retryInfo.retryCount,
      });
    }
  } catch (failoverErr) {
    logger.info(`Failed to record retry failover_event for task ${taskId}: ${failoverErr.message}`);
  }

  // Keep task in current non-running status during retry delay to prevent premature scheduling.
  // Transition to 'queued' only after the delay fires (inside the setTimeout below).
  if (deps.taskCleanupGuard) deps.taskCleanupGuard.delete(taskId);
  deps.db.updateTaskStatus(taskId, 'retry_scheduled', {
    exit_code: code,
    output: sanitizedOutput,
    error_output: `[Retry ${retryInfo.retryCount}/${retryInfo.maxRetries} - ${errorClassification.reason}] ${proc.errorOutput}`,
    ...buildRetryResumeFields(task, proc, sanitizedOutput),
  });

  // Push MCP SSE notification for retry event
  try {
    const { dispatchTaskEvent } = require('../hooks/event-dispatch');
    dispatchTaskEvent('retry', deps.db.getTask(taskId));
  } catch (mcpErr) {
    logger.info('[MCP Notify] Non-fatal error:', mcpErr.message);
  }

  // Schedule retry after delay
  const retryTimeoutHandle = setTimeout(() => {
    deps.pendingRetryTimeouts.delete(taskId);
    const currentTask = deps.db.getTask(taskId);
    if (!currentTask) {
      logger.info(`Retry cancelled for task ${taskId} - task no longer exists`);
      return;
    }
    // Only resume retry if the task is still parked at retry_scheduled. If
    // any other code path (stale-check requeue/fail in orphan-cleanup,
    // batch_cancel, factory-tick rejection sweep, manual API cancel, etc.)
    // has moved the task to a different status, do NOT resurrect it.
    //
    // Pre-2026-05-06 this only checked for `cancelled` — so a task that
    // orphan-cleanup marked `failed` after maxRetries exhaustion (line ~532
    // in maintenance/orphan-cleanup.js) would get reset to `queued` and
    // re-run when the retry timer fired. Same shape applies to `completed`
    // / `shipped` / `unactionable` / `escalation_exhausted` / etc.
    if (currentTask.status !== 'retry_scheduled') {
      logger.info(
        `Retry skipped for task ${taskId} - task moved to '${currentTask.status}' during retry delay (no longer eligible to resume)`
      );
      return;
    }
    // Transition from retry_scheduled → queued now that the delay has fired
    deps.db.updateTaskStatus(taskId, 'queued', { retry_count: (currentTask.retry_count || 0) + 1 });
    try {
      const p = deps.startTask(taskId);
      if (p && typeof p.catch === 'function') {
        p.catch(err => {
          logger.info(`Retry async failure for task ${taskId}:`, err.message);
        });
      }
    } catch (err) {
      logger.info(`Retry failed for task ${taskId}:`, err.message);
      try {
        deps.db.updateTaskStatus(taskId, 'failed', {
          error_output: `Retry failed: ${err.message}`
        });
      } catch (dbErr) {
        logger.info(`Failed to update task status: ${dbErr.message}`);
      }
    }
  }, delayMs);

  deps.pendingRetryTimeouts.set(taskId, retryTimeoutHandle);

  // Trigger retry webhook
  try {
    const updatedTask = deps.db.getTask(taskId);
    const { triggerWebhooks } = require('../handlers/webhook-handlers');
    triggerWebhooks('retry', updatedTask).catch(err => {
      logger.info('Webhook trigger error:', err.message);
    });
  } catch (webhookErr) {
    logger.info('Webhook setup error:', webhookErr.message);
  }

  deps.processQueue();
  ctx.earlyExit = true;
}

// ── New factory shape (preferred) ─────────────────────────────────────────
function createRetryFramework(localDeps = {}) {
  // Resolve task-manager closures, processTracker maps, and pure
  // utility functions from container values + module requires when
  // explicit overrides aren't supplied. Test fixtures still win via
  // localDeps overrides.
  const tm = localDeps.taskManager || null;
  const tmMethod = (name) => (tm && typeof tm[name] === 'function' ? tm[name].bind(tm) : null);
  const trackerCandidate = localDeps.runningProcesses
    || (() => {
      try {
        const { defaultContainer } = require('../container');
        return defaultContainer.peek('processTracker');
      } catch { return null; }
    })()
    || null;
  const resolved = {
    ...localDeps,
    db: localDeps.db,
    classifyError: localDeps.classifyError || require('./fallback-retry').classifyError,
    sanitizeTaskOutput: localDeps.sanitizeTaskOutput || require('./task-utils').sanitizeTaskOutput,
    taskCleanupGuard: localDeps.taskCleanupGuard
      || (trackerCandidate && trackerCandidate.cleanupGuard)
      || null,
    pendingRetryTimeouts: localDeps.pendingRetryTimeouts
      || (trackerCandidate && trackerCandidate.retryTimeouts)
      || null,
    startTask: localDeps.startTask || tmMethod('startTask'),
    processQueue: localDeps.processQueue || tmMethod('processQueue'),
  };
  function withLocalDeps(fn) {
    const prev = deps;
    deps = resolved;
    try { return fn(); } finally { deps = prev; }
  }
  return {
    handleRetryLogic: (...args) => withLocalDeps(() => handleRetryLogic(...args)),
  };
}

/**
 * Register with a DI container under the name 'retryFramework'.
 * classifyError/sanitizeTaskOutput resolve via require() inside the
 * factory; taskCleanupGuard/pendingRetryTimeouts resolve from the
 * container's processTracker; startTask/processQueue resolve from
 * the registered taskManager handle.
 */
function register(container) {
  container.register(
    'retryFramework',
    ['db', 'taskManager'],
    (resolved) => createRetryFramework(resolved)
  );
}

module.exports = {
  createRetryFramework,
  register,
  // @internal — test-only override path (see init() jsdoc)
  init,
  handleRetryLogic,
  // Exposed for cross-call-site integration tests (resume-context strip-first
  // contract — recovery-decisions.md conflict #3).
  buildRetryResumeFields,
};
