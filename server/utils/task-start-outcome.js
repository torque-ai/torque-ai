'use strict';

function normalizeTaskStartOutcome(result) {
  if (result && typeof result === 'object' && (
    Object.prototype.hasOwnProperty.call(result, 'started')
    || Object.prototype.hasOwnProperty.call(result, 'queued')
    || Object.prototype.hasOwnProperty.call(result, 'pendingAsync')
    || Object.prototype.hasOwnProperty.call(result, 'failed')
  )) {
    return {
      started: result.started === true,
      queued: result.queued === true,
      pendingAsync: result.pendingAsync === true,
      failed: result.failed === true,
      reason: result.reason,
      code: result.code,
      error: result.error,
    };
  }

  return {
    started: Boolean(result),
    queued: false,
    pendingAsync: false,
    failed: !result,
  };
}

module.exports = { normalizeTaskStartOutcome };
