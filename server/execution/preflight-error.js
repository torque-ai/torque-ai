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
 * ── Error code convention ─────────────────────────────────────────────────
 * Codes are stable, machine-readable identifiers surfaced in error_output and
 * logs. Format: UPPER_SNAKE_CASE, 3-40 chars, matching `/^[A-Z][A-Z0-9_]+$/`.
 *
 * Shape: `<SUBJECT>[_<ACTION>]_<STATE>`
 *   - SUBJECT: the thing being validated (e.g. WORKING_DIR, TASK_DESCRIPTION).
 *   - ACTION (optional): the operation that failed (e.g. STAT).
 *   - STATE: the outcome that triggered the error (e.g. MISSING, EMPTY,
 *     NOT_DIRECTORY, FAILED).
 *
 * New codes must be added to PREFLIGHT_ERROR_CODES below so the guardrail
 * test (`preflight-error-codes.test.js`) can validate them. Existing callers
 * should never be removed from the set without a deliberate deprecation —
 * operators grep for these strings in log history.
 */

const PREFLIGHT_ERROR_CODES = Object.freeze({
  PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
  WORKING_DIR_MISSING: 'WORKING_DIR_MISSING',
  WORKING_DIR_NOT_DIRECTORY: 'WORKING_DIR_NOT_DIRECTORY',
  WORKING_DIR_STAT_FAILED: 'WORKING_DIR_STAT_FAILED',
  TASK_DESCRIPTION_EMPTY: 'TASK_DESCRIPTION_EMPTY',
});

const PREFLIGHT_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/;

class PreflightError extends Error {
  constructor(message, { code, deterministic, cause } = {}) {
    super(message);
    this.name = 'PreflightError';
    this.code = code || PREFLIGHT_ERROR_CODES.PREFLIGHT_FAILED;
    this.deterministic = deterministic === true;
    this.retryable = !this.deterministic;
    if (cause) this.cause = cause;
  }
}

function isPreflightError(err) {
  return err instanceof PreflightError;
}

module.exports = {
  PreflightError,
  isPreflightError,
  PREFLIGHT_ERROR_CODES,
  PREFLIGHT_ERROR_CODE_PATTERN,
};
