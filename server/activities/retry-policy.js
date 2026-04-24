'use strict';

function computeBackoff({ attempt, initial_ms = 100, max_ms = 60000, multiplier = 2 }) {
  if (attempt <= 1) {
    return 0;
  }

  const raw = initial_ms * Math.pow(multiplier, attempt - 2);
  return Math.min(max_ms, raw);
}

function shouldRetry({ attempt, max_attempts, error, policy = {} }) {
  if (attempt >= max_attempts) {
    return false;
  }

  if (error?.retriable === false) {
    return false;
  }

  if (Array.isArray(policy.non_retryable_errors) && error?.name && policy.non_retryable_errors.includes(error.name)) {
    return false;
  }

  return true;
}

module.exports = { computeBackoff, shouldRetry };
