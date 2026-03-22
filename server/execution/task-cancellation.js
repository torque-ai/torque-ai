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
  sanitizeAiderOutput,
  safeTriggerWebhook,
  killProcessGraceful,
  cleanupChildProcessListeners,
  cleanupProcessTracking,
  safeDecrementHostSlot,
  handleWorkflowTermination,
  processQueue
}) {
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

  function cancelTask(taskId, reason = 'Cancelled by user') {
    const fullId = db.resolveTaskId(taskId);
    if (!fullId) {
      throw new Error(`No task found matching ID prefix: ${taskId}`);
    }

    const proc = runningProcesses.get(fullId);
    const isTimeout = reason?.toLowerCase().includes('timeout') ?? false;
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
          output: sanitizeAiderOutput(proc.output),
          error_output: proc.errorOutput + `\n${reason}`
        });
      } catch (dbErr) {
        logger.info(`Failed to update task ${fullId} status:`, dbErr.message);
      }

      cleanupChildProcessListeners(proc.process);
      cleanupProcessTracking(proc, fullId, runningProcesses, stallRecoveryAttempts);

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
        error_output: reason
      });

      triggerCancellationWebhook(fullId, webhookEvent);
      dispatchCancelEvent(fullId, webhookEvent);

      handleWorkflowTermination(fullId);
      return true;
    }

    if (task && (task.status === 'blocked' || task.status === 'pending')) {
      stallRecoveryAttempts.delete(fullId);
      db.updateTaskStatus(fullId, 'cancelled', {
        error_output: reason
      });
      triggerCancellationWebhook(fullId, webhookEvent);
      dispatchCancelEvent(fullId, webhookEvent);
      handleWorkflowTermination(fullId);
      return true;
    }

    if (task && task.status === 'retry_scheduled') {
      stallRecoveryAttempts.delete(fullId);
      // pendingRetryTimeouts already cleared above (lines 46-51)
      db.updateTaskStatus(fullId, 'cancelled', {
        error_output: reason
      });
      triggerCancellationWebhook(fullId, webhookEvent);
      dispatchCancelEvent(fullId, webhookEvent);
      handleWorkflowTermination(fullId);
      return true;
    }

    if (task && task.status === 'running') {
      stallRecoveryAttempts.delete(fullId);
      safeDecrementHostSlot({ ollamaHostId: task.ollama_host_id });
      db.updateTaskStatus(fullId, 'cancelled', {
        error_output: `${reason}\nNote: Process was not found in memory (likely exited without cleanup)`
      });
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
