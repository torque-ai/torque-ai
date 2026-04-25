/**
 * Task cancellation helpers extracted from task-manager.js.
 */

'use strict';

function createCancellationHandler({
  db,
  runningProcesses,
  apiAbortControllers,
  pendingRetryTimeouts,
  stallRecoveryAttempts,
  logger,
  sanitizeTaskOutput,
  safeTriggerWebhook,
  killProcessGraceful,
  cleanupChildProcessListeners,
  cleanupProcessTracking,
  safeDecrementHostSlot,
  handleWorkflowTermination,
  processQueue
}) {
  function isTimeoutReason(reason) {
    const timeoutPattern = /\b(?:timeout|timed\s*out|timing\s*out|time\s*out|timed-out|timedout)\b/i;
    return timeoutPattern.test(String(reason || ''));
  }

  function triggerCancellationWebhook(taskId, webhookEvent) {
    safeTriggerWebhook(taskId, webhookEvent);
  }

  function dispatchCancelEvent(taskId, webhookEvent) {
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent(webhookEvent, db.getTask(taskId));
    } catch (mcpErr) {
      logger.info('[MCP Notify] Non-fatal error:', mcpErr.message);
    }
  }

  /**
   * Combine prior error_output with the cancel reason so diagnostic signal
   * (e.g. a retry-scheduled provider failure message) survives cancellation.
   * Centralizing avoids drift between the running / retry_scheduled / orphan
   * branches, which historically used three different append conventions.
   */
  function combineErrorForCancel(priorErrorOutput, reason, extraNote = null) {
    const prior = typeof priorErrorOutput === 'string' ? priorErrorOutput : '';
    const suffix = extraNote ? `${reason}\n${extraNote}` : reason;
    return prior
      ? `${prior}\n[cancelled] ${suffix}`
      : suffix;
  }

  function releaseFileLocksForCancel(taskId) {
    if (!db || typeof db.releaseAllFileLocks !== 'function') {
      return 0;
    }

    try {
      const released = db.releaseAllFileLocks(taskId);
      if (released > 0) {
        logger.info(`[FileLock] Released ${released} lock(s) for ${taskId} on cancellation`);
      }
      return released;
    } catch (lockErr) {
      logger.warn(`[FileLock] Non-fatal error releasing locks for cancelled task ${taskId}: ${lockErr.message}`);
      return 0;
    }
  }

  function cancelTask(taskId, reason = 'Cancelled by user', options = {}) {
    const isTimeout = isTimeoutReason(reason);
    const cancelReason = options.cancel_reason || (isTimeout ? 'timeout' : 'user');
    const fullId = db.resolveTaskId(taskId);
    if (!fullId) {
      throw new Error(`No task found matching ID prefix: ${taskId}`);
    }

    const proc = runningProcesses.get(fullId);
    const webhookEvent = isTimeout ? 'timeout' : 'cancelled';

    const pendingRetry = pendingRetryTimeouts.get(fullId);
    if (pendingRetry) {
      clearTimeout(pendingRetry);
      pendingRetryTimeouts.delete(fullId);
      logger.info(`Cancelled pending retry for task ${fullId}`);
    }

    if (proc) {
      killProcessGraceful(proc, fullId, 5000);

      try {
        db.updateTaskStatus(fullId, 'cancelled', {
          output: sanitizeTaskOutput(proc.output),
          error_output: combineErrorForCancel(proc.errorOutput, reason),
          cancel_reason: cancelReason
        });
      } catch (dbErr) {
        logger.info(`Failed to update task ${fullId} status:`, dbErr.message);
      }

      cleanupChildProcessListeners(proc.process);
      cleanupProcessTracking(proc, fullId, runningProcesses, stallRecoveryAttempts);
      releaseFileLocksForCancel(fullId);

      triggerCancellationWebhook(fullId, webhookEvent);
      dispatchCancelEvent(fullId, webhookEvent);

      handleWorkflowTermination(fullId);
      processQueue();
      return true;
    }

    // Abort any in-flight API request for this task.
    const apiController = apiAbortControllers.get(fullId);
    if (apiController) {
      apiController.abort();
      apiAbortControllers.delete(fullId);
    }

    // TOCTOU note: the task status is read here after the abort signal is sent.
    // A task that was 'running' an API call may have already transitioned to
    // 'completed' between the abort and this re-read. The 'queued' guard below
    // is intentionally narrow — only queued tasks need an explicit status update
    // here; running tasks are handled by their abort signal and close handlers.
    const task = db.getTask(fullId);
    if (task && task.status === 'queued') {
      stallRecoveryAttempts.delete(fullId);
      db.updateTaskStatus(fullId, 'cancelled', {
        error_output: combineErrorForCancel(task.error_output, reason),
        cancel_reason: cancelReason
      });
      releaseFileLocksForCancel(fullId);

      triggerCancellationWebhook(fullId, webhookEvent);
      dispatchCancelEvent(fullId, webhookEvent);

      handleWorkflowTermination(fullId);
      return true;
    }

    if (task && (task.status === 'blocked' || task.status === 'pending' || task.status === 'pending_approval')) {
      stallRecoveryAttempts.delete(fullId);
      db.updateTaskStatus(fullId, 'cancelled', {
        error_output: combineErrorForCancel(task.error_output, reason),
        cancel_reason: cancelReason
      });
      releaseFileLocksForCancel(fullId);
      triggerCancellationWebhook(fullId, webhookEvent);
      dispatchCancelEvent(fullId, webhookEvent);
      handleWorkflowTermination(fullId);
      return true;
    }

    if (task && task.status === 'retry_scheduled') {
      stallRecoveryAttempts.delete(fullId);
      // pendingRetryTimeouts already cleared above. Preserving task.error_output
      // here keeps the provider's original failure message (which triggered
      // retry_scheduled) visible after cancellation.
      db.updateTaskStatus(fullId, 'cancelled', {
        error_output: combineErrorForCancel(task.error_output, reason),
        cancel_reason: cancelReason
      });
      releaseFileLocksForCancel(fullId);
      triggerCancellationWebhook(fullId, webhookEvent);
      dispatchCancelEvent(fullId, webhookEvent);
      handleWorkflowTermination(fullId);
      return true;
    }

    if (task && task.status === 'running') {
      stallRecoveryAttempts.delete(fullId);
      safeDecrementHostSlot({ ollamaHostId: task.ollama_host_id });
      db.updateTaskStatus(fullId, 'cancelled', {
        error_output: combineErrorForCancel(
          task.error_output,
          reason,
          'Note: Process was not found in memory (likely exited without cleanup)',
        ),
        cancel_reason: cancelReason
      });
      releaseFileLocksForCancel(fullId);
      triggerCancellationWebhook(fullId, webhookEvent);
      dispatchCancelEvent(fullId, webhookEvent);
      handleWorkflowTermination(fullId);
      processQueue();
      return true;
    }

    return false;
  }

  return {
    cancelTask,
    dispatchCancelEvent,
    triggerCancellationWebhook
  };
}

module.exports = createCancellationHandler;
