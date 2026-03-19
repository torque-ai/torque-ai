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

let deps = {};

function init(nextDeps = {}) {
  deps = { ...deps, ...nextDeps };
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
    ctx.earlyExit = true;
    return;
  }
  const delayMs = deps.db.calculateRetryDelay(task) * 1000;

  logger.info(`Task ${taskId} will retry in ${delayMs/1000}s (attempt ${retryInfo.retryCount}/${retryInfo.maxRetries}): ${errorClassification.reason}`);

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

  // Update task status to pending for retry
  if (deps.taskCleanupGuard) deps.taskCleanupGuard.delete(taskId);
  deps.db.updateTaskStatus(taskId, 'pending', {
    exit_code: code,
    output: deps.sanitizeAiderOutput(proc.output),
    error_output: `[Retry ${retryInfo.retryCount}/${retryInfo.maxRetries} - ${errorClassification.reason}] ${proc.errorOutput}`
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

module.exports = { init, handleRetryLogic };
