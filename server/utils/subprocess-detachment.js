'use strict';

/**
 * Single source of truth for the subprocess-detachment feature flag.
 *
 * When enabled, codex / codex-spark spawns run with `detached: true` and
 * stdio redirected to per-task log files under
 * `<data-dir>/task-logs/<taskId>/`. The TORQUE parent then uses a polled
 * `Tail` watcher (server/utils/file-tail.js) to feed the same chunk
 * handlers the pipe-based path uses, and a `process.kill(pid, 0)` PID
 * liveness loop replaces `child.on('close')` for finalization.
 *
 * The flag is consulted at two distinct moments:
 *   1. spawn time, in execute-cli.js (Phase B), to choose between the
 *      legacy pipe-based path and the new detached path.
 *   2. startup re-adoption (Phase C), to decide whether persisted
 *      `subprocess_pid` rows from a previous TORQUE process should be
 *      re-attached or treated as orphaned.
 *
 * Default OFF until Phase G flips the default. Until then the flag must
 * be explicitly opted into via `TORQUE_DETACHED_SUBPROCESSES=1`.
 *
 * @returns {boolean}
 */
function isSubprocessDetachmentEnabled() {
  const raw = process.env.TORQUE_DETACHED_SUBPROCESSES;
  if (typeof raw !== 'string') return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

module.exports = {
  isSubprocessDetachmentEnabled,
};
