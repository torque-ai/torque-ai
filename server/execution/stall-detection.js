/**
 * Stall detection helpers extracted from task-manager.js.
 */

'use strict';

function createStallDetectionHandler({
  db,
  safeConfigInt,
  parseModelSizeB,
  logger,
  activityMonitoring,
  orphanCleanupModule,
  fallbackRetryModule
}) {
  function isLargeModelBlockedOnHost(modelName, hostId) {
    const largeModelThreshold = safeConfigInt('large_model_threshold_b', 30, 1, 200);
    const maxLargePerHost = safeConfigInt('max_large_models_per_host', 1, 1, 10);
    const taskModelSize = parseModelSizeB(modelName);

    if (taskModelSize < largeModelThreshold) {
      return { blocked: false };
    }

    try {
      const hostTasks = db.getRunningTasksForHost(hostId);
      const largeRunning = hostTasks.filter(t => parseModelSizeB(t.model) >= largeModelThreshold).length;
      if (largeRunning >= maxLargePerHost) {
        return {
          blocked: true,
          reason: `VRAM guard: ${modelName} (${taskModelSize}B) blocked — host already has ${largeRunning} large model(s) (>=${largeModelThreshold}B) running`
        };
      }
    } catch (e) {
      logger.debug(`isLargeModelBlockedOnHost: query failed: ${e.message}`);
    }

    return { blocked: false };
  }

  function checkFilesystemActivity(...args) {
    return activityMonitoring.checkFilesystemActivity(...args);
  }

  function checkStalledTasks(...args) {
    return orphanCleanupModule.checkStalledTasks(...args);
  }

  function tryStallRecovery(...args) {
    return fallbackRetryModule.tryStallRecovery(...args);
  }

  return {
    isLargeModelBlockedOnHost,
    checkFilesystemActivity,
    checkStalledTasks,
    tryStallRecovery
  };
}

module.exports = createStallDetectionHandler;
