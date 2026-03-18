/**
 * Shared failover backoff calculation for TORQUE provider failover.
 *
 * Centralizes the backoff formula previously duplicated in:
 * - execute-ollama.js (failoverCount + 1)
 * - execute-cli.js (task.retry_count || 1)
 * - close-phases.js (task.retry_count || 1)
 */

const MAX_BACKOFF_MS = 60000;
const BASE_BACKOFF_MS = 5000;

/**
 * Calculate failover backoff delay in milliseconds.
 * Linear backoff capped at MAX_BACKOFF_MS.
 * @param {number} attempt - The attempt number (1-based, minimum 1)
 * @returns {number} Backoff delay in milliseconds
 */
function failoverBackoffMs(attempt) {
  const safeAttempt = Math.max(1, attempt || 1);
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * safeAttempt);
}

module.exports = { failoverBackoffMs, MAX_BACKOFF_MS, BASE_BACKOFF_MS };
