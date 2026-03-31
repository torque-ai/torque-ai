'use strict';

const SERVER_INFO = { name: 'torque', version: '1.0.0' };

let _tools = [];
let _coreToolNames = [];
let _extendedToolNames = [];
let _handleToolCall = null;
let _onInitialize = null;

/**
 * Initialize the protocol handler with tool registry and dispatch function.
 *
 * @param {object} opts
 * @param {Array}   opts.tools             - Full tool list (MCP tool descriptor objects).
 * @param {string[]} opts.coreToolNames    - Names visible in 'core' mode.
 * @param {string[]} opts.extendedToolNames- Names visible in 'extended' mode.
 * @param {Function} opts.handleToolCall   - async (name, args, session) => result
 * @param {Function} [opts.onInitialize]   - Optional callback invoked on 'initialize' with (session, params).
 */
function init({ tools, coreToolNames, extendedToolNames, handleToolCall, onInitialize }) {
  _tools = tools || [];
  _coreToolNames = coreToolNames || [];
  _extendedToolNames = extendedToolNames || [];
  _handleToolCall = handleToolCall;
  _onInitialize = onInitialize || null;
}

/**
 * Handle a single MCP JSON-RPC request.
 *
 * @param {object} request - Parsed JSON-RPC request object.
 * @param {object} session - Session object; must have at least `{ toolMode: 'core'|'extended'|'full' }`.
 * @returns {Promise<object|null>} Response payload (null for notifications that need no reply).
 * @throws {{ code: number, message: string }} JSON-RPC error object on protocol-level failures.
 */
async function handleRequest(request, session) {
  if (!request || typeof request !== 'object') {
    throw { code: -32600, message: 'Invalid request: expected JSON object' };
  }
  const { method, params } = request;

  switch (method) {
    case 'initialize': {
      // Capture client capabilities for elicitation/sampling support
      session.clientCapabilities = params?.capabilities || {};
      session.supportsElicitation = Boolean(params?.capabilities?.elicitation);
      session.supportsSampling = Boolean(params?.capabilities?.sampling);

      const response = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
      if (_onInitialize) _onInitialize(session, params);
      return response;
    }

    case 'tools/list': {
      if (session.toolMode === 'core' || session.toolMode === 'extended') {
        const allowedNames = session.toolMode === 'core' ? _coreToolNames : _extendedToolNames;
        const allowedSet = new Set(allowedNames);
        const filtered = [];
        for (const tool of _tools) {
          if (allowedSet.has(tool.name)) {
            filtered.push(tool);
          }
        }
        return { tools: filtered };
      }
      return { tools: [..._tools] };
    }

    case 'tools/call':
      return await _handleToolCallInternal(params, session);

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

/**
 * Internal dispatcher for tools/call requests.
 * Validates params, enforces tool mode, delegates to _handleToolCall, and processes
 * unlock responses.
 *
 * @param {*}      params  - Raw params value from the JSON-RPC request.
 * @param {object} session - Session object (mutated on unlock).
 * @returns {Promise<object>}
 */
async function _handleToolCallInternal(params, session) {
  if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
    throw { code: -32602, message: 'Invalid params: "name" (string) is required' };
  }
  const { name, arguments: args } = params;
  const normalizedArgs = args || {};

  if (session.toolMode !== 'full') {
    const allowedNames = session.toolMode === 'core' ? _coreToolNames : _extendedToolNames;
    if (!allowedNames.includes(name)) {
      return {
        content: [{ type: 'text', text: `Tool '${name}' is not available in ${session.toolMode} mode. Call 'unlock_tier' or 'unlock_all_tools' to access more tools.` }],
        isError: true,
      };
    }
  }

  if (!_handleToolCall) {
    throw { code: -32603, message: 'Protocol handler not initialized' };
  }

  try {
    const result = await _handleToolCall(name, normalizedArgs, session);

    // Handle unlock responses
    if (result && (result.__unlock_all_tools || result.__unlock_tier)) {
      const newMode = result.__unlock_all_tools ? 'full'
        : (result.__unlock_tier <= 1 ? 'core' : result.__unlock_tier <= 2 ? 'extended' : 'full');
      if (newMode !== session.toolMode) {
        session.toolMode = newMode;
        session._toolsChanged = true;
      }
      return { content: result.content };
    }

    // Promote structuredData → structuredContent for tools with outputSchema
    if (result && result.structuredData && !result.isError) {
      const { getOutputSchema } = require('./tool-output-schemas');
      if (getOutputSchema(name)) {
        result.structuredContent = result.structuredData;
      }
      delete result.structuredData; // always clean up internal field
    }

    return result;
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message || err}` }],
      isError: true,
    };
  }
}

module.exports = { init, handleRequest, SERVER_INFO };
