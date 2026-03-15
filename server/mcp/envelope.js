'use strict';

const { randomUUID } = require('crypto');

function createCorrelationId() {
  return randomUUID();
}

function okEnvelope(data, metadata = {}) {
  return {
    ok: true,
    data: data ?? null,
    metadata: {
      schema_version: 'v1',
      tool_version: 'v1',
      timestamp: new Date().toISOString(),
      ...metadata,
    },
  };
}

function errorEnvelope(error, metadata = {}) {
  const safeError = error || {};
  return {
    ok: false,
    isError: true,
    error: {
      code: safeError.code || 'INTERNAL_ERROR',
      message: safeError.message || 'Unknown error',
      retryable: Boolean(safeError.retryable),
      details: safeError.details || null,
    },
    metadata: {
      schema_version: 'v1',
      tool_version: 'v1',
      timestamp: new Date().toISOString(),
      ...metadata,
    },
  };
}

module.exports = {
  createCorrelationId,
  okEnvelope,
  errorEnvelope,
};
