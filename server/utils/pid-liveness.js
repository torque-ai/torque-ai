'use strict';

/**
 * Cross-platform PID liveness check.
 *
 * Used by the subprocess-detachment arc (see
 * docs/design/2026-05-03-subprocess-detachment-codex-spike.md §4.4)
 * to determine whether a previously-spawned subprocess is still alive
 * after a TORQUE restart. The new TORQUE instance reads `subprocess_pid`
 * from each running task row and calls `isPidAlive(pid)` to decide
 * whether to re-adopt the subprocess (alive) or fall through to the
 * existing reconciler-cancellation path (dead).
 *
 * Implementation: `process.kill(pid, 0)` sends signal 0, which is a
 * no-op on every supported platform. The kernel still does the
 * permission check before the (no-op) delivery, which is exactly the
 * "does this process exist" probe we want.
 *
 *   - ESRCH → "no such process" → not alive.
 *   - EPERM → "process exists but you can't signal it" → counts as
 *     alive. EPERM cannot occur for a non-existent PID; the only way
 *     to get EPERM is if the PID exists in the process table but is
 *     owned by another user (Linux strict signaling, sticky bits on
 *     some BSDs). On Windows node maps `OpenProcess` failure to ESRCH
 *     for missing PIDs, so EPERM is rare on win32 but defensible.
 *   - any other code → treat as not alive (defensive default; in
 *     practice this branch is unreachable).
 *
 * Phase A only ships this helper; no caller is wired to it yet.
 *
 * @param {number} pid
 * @returns {boolean} true if the OS reports the PID exists.
 */
function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0 || !Number.isInteger(pid)) {
    return false;
  }
  try {
    // signal 0 — existence probe, no-op delivery on every platform.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    if (err && err.code === 'ESRCH') return false;
    return false;
  }
}

module.exports = { isPidAlive };
