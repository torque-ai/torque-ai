'use strict';

/**
 * PreflightError — thrown by execution preflight checks when a task cannot start.
 *
 * `deterministic: true` means the error will recur on every attempt (missing
 * working directory, empty task description, unknown provider, etc.) and the
 * task should transition straight to `failed` rather than staying queued.
 *
 * `deterministic: false` is for transient conditions (fs error with EBUSY/EAGAIN,
 * temporary permission blip) that may resolve on retry.
 *
 * `code` is a stable machine-readable identifier (e.g. `WORKING_DIR_MISSING`)
 * used by the scheduler to format operator-facing messages.
 */
class PreflightError extends Error {
  constructor(message, { code, deterministic, cause } = {}) {
    super(message);
    this.name = 'PreflightError';
    this.code = code || 'PREFLIGHT_FAILED';
    this.deterministic = deterministic === true;
    this.retryable = !this.deterministic;
    if (cause) this.cause = cause;
  }
}

function isPreflightError(err) {
  return err instanceof PreflightError;
}

module.exports = { PreflightError, isPreflightError };
