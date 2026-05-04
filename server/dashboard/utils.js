/**
 * Shared utilities for dashboard route handlers.
 *
 * Provides request parsing, response helpers, and task enrichment
 * used across all route modules.
 */
const hostManagement = require('../db/host/management');

/**
 * Standard security headers applied to all responses
 */
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

const BODY_PARSE_TIMEOUT_MS = 30000;

/**
 * Parse URL query parameters
 * @param {string} url - The full URL string to extract query parameters from
 * @returns {Object<string, string>} Key-value map of decoded query parameters
 */
function parseQuery(url) {
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return {};

  const queryString = url.slice(queryIndex + 1);
  const params = {};

  for (const pair of queryString.split('&')) {
    const eqIdx = pair.indexOf('=');
    const key = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
    const value = eqIdx === -1 ? '' : pair.slice(eqIdx + 1);
    if (key) {
      try {
        params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
      } catch {
        // Skip malformed percent-encoded pairs
      }
    }
  }

  return params;
}

function safeDecodeParam(value, res) {
  try {
    return decodeURIComponent(value || '');
  } catch (err) {
    if (err instanceof URIError) {
      if (res) {
        sendError(res, 'Invalid identifier encoding', 400);
      }
      return null;
    }
    throw err;
  }
}

/**
 * Parse JSON body from request
 * @param {http.IncomingMessage} req - The incoming HTTP request
 * @returns {Promise<Object>} Parsed JSON body, or empty object if body is empty
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    const finishResolve = (value) => {
      if (rejected) return;
      rejected = true;
      clearTimeout(bodyTimeout);
      resolve(value);
    };
    const finishReject = (err) => {
      if (rejected) return;
      rejected = true;
      clearTimeout(bodyTimeout);
      reject(err);
    };
    const bodyTimeout = setTimeout(() => {
      const err = new Error('Body parse timeout');
      finishReject(err);
      req.destroy(err);
    }, BODY_PARSE_TIMEOUT_MS);

    req.on('data', chunk => {
      body += chunk.toString();
      // Use Buffer.byteLength for accurate byte count (multi-byte chars inflate string length)
      if (Buffer.byteLength(body, 'utf8') > 10 * 1024 * 1024 && !rejected) {
        req.destroy();
        finishReject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        finishResolve(body ? JSON.parse(body) : {});
      } catch (err) {
        finishReject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', finishReject);
  });
}

/**
 * Check if an origin is a localhost origin (safe for CORS)
 */
function isLocalhostOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

/**
 * Send JSON response
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {*} data - The data to serialize as JSON
 * @param {number} [status=200] - HTTP status code
 * @returns {void}
 */
function sendJson(res, data, status = 200) {
  const headers = {
    'Content-Type': 'application/json',
    ...SECURITY_HEADERS,
  };
  if (res._corsOrigin) {
    headers['Access-Control-Allow-Origin'] = res._corsOrigin;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

/**
 * Send error response
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {string} message - Error message to include in the response body
 * @param {number} [status=400] - HTTP status code
 * @returns {void}
 */
function sendError(res, message, status = 400) {
  sendJson(res, { error: message }, status);
}

/**
 * Wrap a successful response in standard envelope.
 * @param {*} data - Response payload
 * @param {Object} [meta] - Optional metadata (pagination, counts)
 * @returns {{ success: true, data: *, meta?: Object }}
 */
function successResponse(data, meta) {
  const response = { success: true, data };
  if (meta) response.meta = meta;
  return response;
}

/**
 * Wrap an error response in standard envelope.
 * @param {string} message - Error message
 * @param {number} [code] - HTTP status code
 * @returns {{ success: false, error: string }}
 */
function errorResponse(message, code) {
  return { success: false, error: message, ...(code ? { code } : {}) };
}

/**
 * Enrich task objects with ollama host name (for display)
 * @param {Object} task - The task object to enrich
 * @returns {Object} The task object with ollama_host_name added if applicable
 */
function enrichTaskWithHostName(task) {
  if (task && task.ollama_host_id) {
    try {
      const host = hostManagement.getOllamaHost(task.ollama_host_id);
      task.ollama_host_name = host ? host.name : task.ollama_host_id;
    } catch {
      task.ollama_host_name = task.ollama_host_id;
    }
    // GPU activity for running tasks
    if (task.status === 'running') {
      try {
        const taskManager = require('../task-manager');
        task.gpu_active = taskManager.isModelLoadedOnHost(task.ollama_host_id, task.model);
      } catch { task.gpu_active = null; }
    }
  }
  return task;
}

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function createDashboardUtils() {
  return {
    parseQuery,
    parseBody,
    isLocalhostOrigin,
    safeDecodeParam,
    sendJson,
    sendError,
    successResponse,
    errorResponse,
    enrichTaskWithHostName,
    formatUptime,
  };
}

module.exports = {
  parseQuery,
  parseBody,
  isLocalhostOrigin,
  safeDecodeParam,
  sendJson,
  sendError,
  successResponse,
  errorResponse,
  enrichTaskWithHostName,
  formatUptime,
  createDashboardUtils,
};
