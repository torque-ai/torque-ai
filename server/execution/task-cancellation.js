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
    const isTimeout = reason.toLowerCase().includes('timeout');
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

    const apiController = apiAbortControllers.get(fullId);
    if (apiController) {
      apiController.abort();
      apiAbortControllers.delete(fullId);
    }

    const task = db.getTask(fullId);
    if (task && task.status === 'queued') {
      db.updateTaskStatus(fullId, 'cancelled', {
        error_output: reason
      });

      triggerCancellationWebhook(fullId, webhookEvent);
      dispatchCancelEvent(fullId, webhookEvent);

      handleWorkflowTermination(fullId);
      return true;
    }

    if (task && (task.status === 'blocked' || task.status === 'pending')) {
      db.updateTaskStatus(fullId, 'cancelled', {
        error_output: reason
      });
      triggerCancellationWebhook(fullId, webhookEvent);
      dispatchCancelEvent(fullId, webhookEvent);
      handleWorkflowTermination(fullId);
      return true;
    }

    if (task && task.status === 'running') {
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
