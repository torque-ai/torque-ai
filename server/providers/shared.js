'use strict';

function buildErrorMessage(service, status, errorBody, retryAfterSeconds) {
  const isAuthError = status === 401 || status === 403;
  let message = `${service} API error (${status}): ${isAuthError ? 'authentication failed or unauthorized: ' : ''}${errorBody}`;

  if (retryAfterSeconds !== null) {
    message += ` retry_after_seconds=${retryAfterSeconds}`;
  }

  return message;
}

module.exports = { buildErrorMessage };
