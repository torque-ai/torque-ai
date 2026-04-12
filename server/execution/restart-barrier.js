'use strict';

/**
 * Shared restart-barrier check used by both the legacy queue scheduler and the
 * slot-pull scheduler. A barrier task is a task with `provider = 'system'` in
 * status `queued` or `running`; while one exists, no other task should be
 * promoted from queued to running, so the currently-running set can drain and
 * the server can restart cleanly.
 *
 * Returns the barrier task row ({ id, ... }) if one is active, or null.
 *
 * Prefers `db.prepare(sql).get()` for speed (one indexed query) and falls back
 * to `db.listTasks(...)` for db facades that don't expose raw prepare.
 */
function isRestartBarrierActive(db) {
  if (!db) return null;
  if (typeof db.prepare === 'function') {
    try {
      const row = db.prepare(
        "SELECT id, provider, status FROM tasks WHERE provider = 'system' AND status IN ('queued', 'running') LIMIT 1"
      ).get();
      return row || null;
    } catch {
      // Fall through to listTasks path below on any prepare-path error
    }
  }
  if (typeof db.listTasks === 'function') {
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
  return null;
}

module.exports = { isRestartBarrierActive };
