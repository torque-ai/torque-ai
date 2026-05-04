'use strict';

/**
 * Single source of truth for the subprocess-detachment feature flag.
 *
 * When enabled, codex / codex-spark / claude-cli spawns run with
 * `detached: true` and stdio redirected to per-task log files under
 * `<data-dir>/task-logs/<taskId>/`. The TORQUE parent then uses a polled
 * `Tail` watcher (server/utils/file-tail.js) to feed the same chunk
 * handlers the pipe-based path uses, and a `process.kill(pid, 0)` PID
 * liveness loop replaces `child.on('close')` for finalization.
 *
 * The flag is consulted at two distinct moments:
 *   1. spawn time, in execute-cli.js (Phases B+F), to choose between the
 *      legacy pipe-based path and the new detached path.
 *   2. startup re-adoption (Phase C), to decide whether persisted
 *      `subprocess_pid` rows from a previous TORQUE process should be
 *      re-attached or treated as orphaned.
 *
 * **Phase G — default ON (2026-05-04).** Detachment is now the default
 * because re-adoption (Phase C) catches subprocess survivors across
 * restarts and removes the data-loss risk that used to gate this
 * behavior. Operators who hit a bug in the detached path can opt out
 * by setting `TORQUE_DETACHED_SUBPROCESSES=0` (or `=false`) — the legacy
 * pipe path is still in place until Phase H deletes it.
 *
 * Recognized values:
 *   unset / empty           → enabled (Phase G default)
 *   "1", "true", "yes", "on" (case-insensitive) → enabled
 *   "0", "false", "no", "off" (case-insensitive) → disabled (opt-out)
 *
 * @returns {boolean}
 */
function isSubprocessDetachmentEnabled() {
  const raw = process.env.TORQUE_DETACHED_SUBPROCESSES;
  if (typeof raw !== 'string' || raw === '') return true; // Phase G: default on
  const normalized = raw.toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  // Anything else (including the historical '1' / 'true' values) keeps
  // the default-on behavior so operators who explicitly opted in pre-G
  // get exactly what they expected.
  return true;
}

module.exports = {
  isSubprocessDetachmentEnabled,
};
