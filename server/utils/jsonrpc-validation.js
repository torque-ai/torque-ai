/**
 * Shared JSON-RPC 2.0 request validation for MCP transports.
 * Used by both server/index.js (stdio) and server/mcp-sse.js (SSE).
 */

const JSON_RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
};

/**
 * Validate a parsed JSON-RPC 2.0 request object.
 * @param {object} request - Parsed JSON object
 * @returns {{ valid: boolean, error?: object, id?: string|number }} Validation result
 */
function validateJsonRpcRequest(request) {
  if (!request || typeof request !== 'object') {
    return { valid: false, error: JSON_RPC_ERRORS.INVALID_REQUEST };
  }

  const id = request.id !== undefined ? request.id : null;

  if (request.jsonrpc !== '2.0') {
    return { valid: false, error: JSON_RPC_ERRORS.INVALID_REQUEST, id };
  }

  if (request.id !== null && request.id !== undefined) {
    const idType = typeof request.id;
    if (idType !== 'string' && idType !== 'number') {
      return { valid: false, error: JSON_RPC_ERRORS.INVALID_REQUEST, id };
    }
  }

  if (!request.method || typeof request.method !== 'string') {
    return { valid: false, error: JSON_RPC_ERRORS.INVALID_REQUEST, id };
  }

  // params must be object or array if present
  if (request.params !== undefined && request.params !== null) {
    if (typeof request.params !== 'object') {
      return { valid: false, error: JSON_RPC_ERRORS.INVALID_PARAMS, id };
    }
  }

  return { valid: true, id };
}

/**
 * Build a JSON-RPC 2.0 error response.
 * @param {string|number|null} id - Request ID
 * @param {{ code: number, message: string }} error - Error definition
 * @param {string} [detail] - Additional error detail
 * @returns {object} JSON-RPC error response
 */
function makeJsonRpcError(id, error, detail) {
  return {
    jsonrpc: '2.0',
    id: id || null,
    error: {
      code: error.code,
      message: detail ? `${error.message}: ${detail}` : error.message,
    },
  };
}

/**
 * Try to parse JSON, returning a parse error response on failure.
 * @param {string} raw - Raw JSON string
 * @returns {{ parsed?: object, error?: object }} Parse result
 */
function tryParseJsonRpc(raw) {
  try {
    const parsed = JSON.parse(raw);
    return { parsed };
  } catch (e) {
    return { error: makeJsonRpcError(null, JSON_RPC_ERRORS.PARSE_ERROR, e.message) };
  }
}

module.exports = {
  JSON_RPC_ERRORS,
  validateJsonRpcRequest,
  makeJsonRpcError,
  tryParseJsonRpc,
};
