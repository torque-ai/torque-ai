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
 * Calculate factorial for a non-negative integer.
 * @param {number} n - Non-negative integer.
 * @returns {number} Factorial of n.
 * @throws {Error} If n is not a non-negative integer.
 */
function factorial(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('factorial expects a non-negative integer');
  }
  if (n === 0) return 1;
  let result = 1;
  for (let i = 1; i <= n; i++) {
    result *= i;
  }
  return result;
}

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

module.exports = { failoverBackoffMs, MAX_BACKOFF_MS, BASE_BACKOFF_MS, factorial };
