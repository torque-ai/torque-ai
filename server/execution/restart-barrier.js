'use strict';

/**
 * Shared restart-barrier check used by both the legacy queue scheduler and the
 * slot-pull scheduler. A barrier task is a task with `provider = 'system'` in
 * status `queued` or `running`; while one exists, no other task should be
 * promoted from queued to running, so the currently-running set can drain and
 * the server can restart cleanly.
 *
 * Returns the barrier task row ({ id, ... }) if one is active, or null.
 */
function isRestartBarrierActive(db) {
  if (!db || typeof db.listTasks !== 'function') return null;
  try {
    const running = db.listTasks({ status: 'running', limit: 50 });
    const runningBarrier = Array.isArray(running)
      ? running.find(t => t && t.provider === 'system')
      : null;
    if (runningBarrier) return runningBarrier;
    const queued = db.listTasks({ status: 'queued', limit: 50 });
    const queuedBarrier = Array.isArray(queued)
      ? queued.find(t => t && t.provider === 'system')
      : null;
    return queuedBarrier || null;
  } catch {
    return null;
  }
}

module.exports = { isRestartBarrierActive };
