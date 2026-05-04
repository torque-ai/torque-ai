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

// ── Legacy module-level state, written only by init() (deprecated) ─────────
// Phase 3 of the universal-DI migration. retry-framework uses a slightly
// different shape than its peers — a single `deps` object as state — but
// the same coexistence pattern applies.
let deps = {};

/** @deprecated Use createRetryFramework(deps) or container.get('retryFramework'). */
function init(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
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
  const delayMs = deps.db.calculateRetryDelay(task) * 1000;

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
    if (!currentTask || currentTask.status === 'cancelled') {
      logger.info(`Retry cancelled for task ${taskId} - task was cancelled during retry delay`);
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
  function withLocalDeps(fn) {
    const prev = deps;
    deps = localDeps;
    try { return fn(); } finally { deps = prev; }
  }
  return {
    handleRetryLogic: (...args) => withLocalDeps(() => handleRetryLogic(...args)),
  };
}

/**
 * Register with a DI container under the name 'retryFramework'.
 * Declared deps are the function signatures retry-framework reads off
 * its `deps` object: db, classifyError, sanitizeTaskOutput, taskCleanupGuard,
 * pendingRetryTimeouts, startTask, processQueue.
 */
function register(container) {
  container.register(
    'retryFramework',
    [
      'db', 'classifyError', 'sanitizeTaskOutput', 'taskCleanupGuard',
      'pendingRetryTimeouts', 'startTask', 'processQueue',
    ],
    (resolved) => createRetryFramework(resolved)
  );
}

module.exports = {
  // New shape (preferred)
  createRetryFramework,
  register,
  // Legacy shape (kept until task-manager.js migrates)
  init,
  handleRetryLogic,
};
