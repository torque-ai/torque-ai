'use strict';

/**
 * Task Status Updater capability.
 *
 * Wraps task-core.updateTaskStatus with the soft-fail + state-conflict
 * recovery behavior that consumers across the system need: returning the
 * current task on `Cannot transition` errors and logging-without-throwing
 * for other errors. Status transitions go through here so consumers don't
 * have to reimplement the same protective wrapper everywhere.
 *
 * Capability decomposition follow-on to the taskCanceller pilot
 * (memory: project_di_taskmanager_decomposition_pilot.md). Consumers that
 * previously bound `taskManager.safeUpdateTaskStatus` should now resolve
 * `defaultContainer.get('taskStatusUpdater').safeUpdateTaskStatus` so they
 * depend on a focused interface rather than the whole task-manager handle.
 *
 * The factory resolves db lazily from the container at call time (not at
 * boot) so consumers booted before db is registered still work — db gets
 * peeked on the first safeUpdateTaskStatus call.
 */

const logger = require('../logger').child({ component: 'task-status-updater' });

let _db = null;
let _taskCore = null;

function ensureDeps() {
  if (!_db) {
    try {
      _db = require('../container').defaultContainer.peek('db') || null;
    } catch { /* container not yet available */ }
  }
  if (!_taskCore) {
    try { _taskCore = require('../db/task-core'); } catch { /* fall through */ }
  }
}

/**
 * Update a task's status with graceful handling of terminal-state conflicts.
 *
 * Uses softFail mode on task-core.updateTaskStatus so transitions that hit a
 * terminal state (e.g. cancelled → completed) return the existing row instead
 * of throwing. On `Cannot transition` errors, returns the current task. On
 * any other error, logs and returns null.
 *
 * @param {string} taskId
 * @param {string} status
 * @param {object} fields - additional fields to update
 * @returns {object|null} The updated task, or null if update was skipped.
 */
function safeUpdateTaskStatus(taskId, status, fields = {}) {
  ensureDeps();
  if (!_taskCore) return null;
  try {
    return _taskCore.updateTaskStatus(taskId, status, { ...fields, _softFail: true });
  } catch (err) {
    if (err.message.includes('Cannot transition')) {
      logger.info(`[SafeUpdate] State conflict for ${taskId}: ${err.message.slice(0, 80)}`);
      try {
        return _taskCore.getTask(taskId);
      } catch {
        return null;
      }
    }
    logger.info(`[SafeUpdate] Error updating ${taskId}: ${err.message}`);
    return null;
  }
}

/**
 * Factory shape for the taskStatusUpdater capability.
 * Test fixtures with explicit deps win over the lazy container peek.
 */
function createTaskStatusUpdater(deps = {}) {
  const localDb = deps.db || null;
  const localTaskCore = deps.taskCore || null;
  return {
    safeUpdateTaskStatus(taskId, status, fields = {}) {
      const tc = localTaskCore || _taskCore || (() => {
        try { return require('../db/task-core'); } catch { return null; }
      })();
      if (!tc) return null;
      try {
        return tc.updateTaskStatus(taskId, status, { ...fields, _softFail: true });
      } catch (err) {
        if (err.message.includes('Cannot transition')) {
          logger.info(`[SafeUpdate] State conflict for ${taskId}: ${err.message.slice(0, 80)}`);
          try { return tc.getTask(taskId); } catch { return null; }
        }
        logger.info(`[SafeUpdate] Error updating ${taskId}: ${err.message}`);
        return null;
      }
      // localDb retained for symmetry with other capability factories — not
      // currently read because task-core owns the SQL. Reserved for future
      // status-write logic that needs a direct db handle.
      // eslint-disable-next-line no-unreachable
      void localDb;
    },
  };
}

/**
 * Register this capability with a DI container under the name
 * 'taskStatusUpdater'. task-manager.js overrides this registration with
 * a single-instance value at module load (same pattern as taskCanceller),
 * so the factory shape only fires for tests that boot the container
 * without loading task-manager.
 */
function register(container) {
  container.register(
    'taskStatusUpdater',
    [],
    () => createTaskStatusUpdater()
  );
}

module.exports = {
  createTaskStatusUpdater,
  register,
  // Raw export — task-manager registers an inline instance as the
  // canonical container value; this raw export self-bootstraps via
  // ensureDeps() for callers that reach for it directly.
  safeUpdateTaskStatus,
};
