'use strict';

const { readRestartHandoff } = require('./restart-handoff');

/**
 * Shared restart-barrier check used by both the legacy queue scheduler and the
 * slot-pull scheduler. A barrier task is a task with `provider = 'system'` in
 * status `queued` or `running`; while one exists, no other task should be
 * promoted from queued to running, so the currently-running set can drain and
 * the server can restart cleanly.
 *
 * Also honors `process._torqueRestartPending`. Restart handlers flip that
 * flag right before calling `eventBus.emitShutdown` (and often with a
 * `RESTART_RESPONSE_GRACE_MS` delay before the shutdown actually fires).
 * Without the flag check, the scheduler could tick between "barrier marked
 * completed" and "shutdown actually kills subprocesses" — promoting queued
 * tasks that then get cancelled mid-spawn. The flag closes that window at
 * every call site, regardless of DB state.
 *
 * Returns the barrier task row ({ id, ... }) if one is active, or null.
 * When only the in-memory flag is set (no DB row), returns a synthetic
 * row so callers that log `barrier.id` still have something to log.
 *
 * Prefers `db.prepare(sql).get()` for speed (one indexed query) and falls back
 * to `db.listTasks(...)` for db facades that don't expose raw prepare.
 */
function isRestartBarrierActive(db) {
  if (typeof process !== 'undefined' && process._torqueRestartPending) {
    return { id: 'restart-pending-flag', provider: 'system', status: 'pending-shutdown' };
  }
  if (!db) {
    const handoff = readRestartHandoff();
    return handoff && handoff.barrier_id
      ? {
        id: handoff.barrier_id,
        provider: 'system',
        status: 'pending-startup',
        started_at: handoff.requested_at || null,
        created_at: handoff.requested_at || null,
      }
      : null;
  }
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
      // Fall through to persisted restart handoff below
    }
  }
  const handoff = readRestartHandoff();
  if (handoff && handoff.barrier_id) {
    return {
      id: handoff.barrier_id,
      provider: 'system',
      status: 'pending-startup',
      started_at: handoff.requested_at || null,
      created_at: handoff.requested_at || null,
    };
  }
  return null;
}

module.exports = { isRestartBarrierActive };
