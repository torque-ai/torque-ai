'use strict';

const { randomUUID } = require('crypto');
const { parseBody } = require('./middleware');
const logger = require('../logger');

const DEFAULT_ERROR_CODE = 'provider_unavailable';
const DEFAULT_ERROR_MESSAGE = 'Internal server error';
const ERROR_STATUS_BY_CODE = Object.freeze({
  validation_error: 400,
  unauthorized: 401,
  provider_not_found: 404,
  model_not_found: 404,
  task_not_found: 404,
  stream_not_supported: 400,
  rate_limit_exceeded: 429,
  timeout: 504,
  not_implemented: 501,
  provider_unavailable: 500,
  // Used by v2-dispatch throwToolResultError and control-plane handlers:
  operation_failed: 500,  // Generic operation error from tool results
  task_blocked: 409,      // Task cannot proceed due to a conflict or block
  invalid_status: 422,    // Invalid status transition or unrecognised status value
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function resolveRequestId(req) {
  const headerValue = req?.headers?.['x-request-id'];

  if (Array.isArray(headerValue)) {
    const first = headerValue.find((value) => typeof value === 'string' && value.trim());
    if (first) {
      return first.trim();
    }
  } else if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }

  return randomUUID();
}

function buildMetaEnvelope(requestId) {
  return {
    request_id: requestId,
    timestamp: new Date().toISOString(),
  };
}

function coerceDetails(details) {
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    return details;
  }
  return {};
}

function defaultStatusForCode(code) {
  return ERROR_STATUS_BY_CODE[code] || 500;
}

function createV2Error(code, message, status, details) {
  const error = new Error(message);
  error.v2 = true;
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function applyValidationResult(target, result, req) {
  if (!result || typeof result !== 'object') {
    return;
  }

  if (result.valid === false) {
    throw createV2Error(
      'validation_error',
      'Request validation failed',
      400,
      { errors: Array.isArray(result.errors) ? result.errors : [] },
    );
  }

  const normalizedValue = hasOwn(result, 'value') ? result.value : undefined;
  if (normalizedValue === undefined) {
    return;
  }

  req[target] = normalizedValue;
  req.validated = req.validated || {};
  req.validated[target] = normalizedValue;
}

function resolveValidatorEntry(entry) {
  if (!entry) {
    return null;
  }

  if (typeof entry === 'function') {
    return {
      validator: entry,
      options: undefined,
    };
  }

  if (typeof entry === 'object' && typeof entry.validator === 'function') {
    return {
      validator: entry.validator,
      options: entry.options,
    };
  }

  return null;
}

function resolveValidatorOptions(options, req) {
  if (typeof options === 'function') {
    return options(req);
  }
  return options;
}

async function runValidator(target, entry, req) {
  const resolved = resolveValidatorEntry(entry);
  if (!resolved) {
    return;
  }

  if (target === 'body' && !hasOwn(req, 'body')) {
    req.body = await parseBody(req);
  }

  const result = await resolved.validator(
    req[target] || {},
    resolveValidatorOptions(resolved.options, req),
    req,
  );

  applyValidationResult(target, result, req);
}

function requestId(req, res, next) {
  req.requestId = req.requestId || resolveRequestId(req);

  if (typeof res?.setHeader === 'function') {
    res.setHeader('X-Request-ID', req.requestId);
  }

  next();
}

function validateRequest(schema = {}) {
  return async function validateV2Request(req, _res, next) {
    try {
      req.params = req.params && typeof req.params === 'object' ? req.params : {};
      req.query = req.query && typeof req.query === 'object' ? req.query : {};

      await runValidator('params', schema.params, req);
      await runValidator('query', schema.query, req);
      await runValidator('body', schema.body, req);

      next();
    } catch (err) {
      next(err);
    }
  };
}

function normalizeError(err, req) {
  const requestId = req?.requestId || resolveRequestId(req);
  let code = DEFAULT_ERROR_CODE;
  let message = DEFAULT_ERROR_MESSAGE;
  let status = defaultStatusForCode(code);
  let details = {};

  if (err?.v2 === true) {
    code = typeof err.code === 'string' ? err.code : DEFAULT_ERROR_CODE;
    message = err.message || DEFAULT_ERROR_MESSAGE;
    status = Number.isInteger(err.status) ? err.status : defaultStatusForCode(code);
    details = coerceDetails(err.details);
  } else if (err instanceof URIError) {
    code = 'validation_error';
    message = err.message || 'Invalid request encoding';
    status = 400;
    details = { context: 'request_path' };
  } else if (err?.message === 'Invalid JSON' || err?.message === 'Request body too large') {
    code = 'validation_error';
    message = err.message;
    status = 400;
    details = { context: 'request_body' };
  } else if (typeof err?.code === 'string') {
    code = err.code;
    message = DEFAULT_ERROR_MESSAGE; // Don't leak internal error messages
    if (err.message && err.message !== DEFAULT_ERROR_MESSAGE) {
      logger.debug(`[v2-middleware] Internal error: ${err.message}`);
    }
    status = Number.isInteger(err.status) ? err.status : defaultStatusForCode(code);
    details = coerceDetails(err.details);
  } else if (err instanceof Error) {
    if (err.message && err.message !== DEFAULT_ERROR_MESSAGE) {
      logger.debug(`[v2-middleware] Internal error: ${err.message}`);
    }
    message = DEFAULT_ERROR_MESSAGE; // Don't leak internal error messages
    details = coerceDetails(err.details);
    status = Number.isInteger(err.status) ? err.status : 500;
  }

  return {
    status,
    body: {
      error: {
        code,
        message,
        details,
        request_id: requestId,
      },
      meta: buildMetaEnvelope(requestId),
    },
  };
}

module.exports = {
  validateRequest,
  normalizeError,
  requestId,
};
