'use strict';

const SERVER_INFO = { name: 'torque', version: '1.0.0' };
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const SECURITY_WARNING_MESSAGE = 'TORQUE is running without authentication. Run configure to set an API key.';

// ── Legacy module-level state, written only by init() (deprecated) ────────────
// Phase 4 of the universal-DI migration. Coexistence pattern.
let _tools = [];
let _coreToolNames = [];
let _extendedToolNames = [];
let _handleToolCall = null;
let _onInitialize = null;
let _isAuthConfigured = null;

/**
 * @deprecated Use createMcpProtocol(deps) or container.get('mcpProtocol').
 *
 * Initialize the protocol handler with tool registry and dispatch function.
 *
 * @param {object} opts
 * @param {Array}   opts.tools             - Full tool list (MCP tool descriptor objects).
 * @param {string[]} opts.coreToolNames    - Names visible in 'core' mode.
 * @param {string[]} opts.extendedToolNames- Names visible in 'extended' mode.
 * @param {Function} opts.handleToolCall   - async (name, args, session) => result
 * @param {Function} [opts.onInitialize]   - Optional callback invoked on 'initialize' with (session, params).
 * @param {Function} [opts.isAuthConfigured] - Optional callback that returns true when server auth is configured.
 */
function init({ tools, coreToolNames, extendedToolNames, handleToolCall, onInitialize, isAuthConfigured }) {
  _tools = tools || [];
  _coreToolNames = coreToolNames || [];
  _extendedToolNames = extendedToolNames || [];
  _handleToolCall = handleToolCall;
  _onInitialize = onInitialize || null;
  _isAuthConfigured = typeof isAuthConfigured === 'function' ? isAuthConfigured : null;
}

function isAuthConfiguredForWarning() {
  if (!_isAuthConfigured) return false;
  try {
    return Boolean(_isAuthConfigured());
  } catch {
    return false;
  }
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

  // Allow connection setup before authentication is attached to the session.
  if (method !== 'initialize' && method !== 'notifications/initialized' && !session?.authenticated) {
    throw { code: -32600, message: 'Authentication required. Provide API key via X-Torque-Key header.' };
  }

  switch (method) {
    case 'initialize': {
      // Capture client capabilities for elicitation/sampling support
      session.clientCapabilities = params?.capabilities || {};
      session.supportsElicitation = Boolean(params?.capabilities?.elicitation);
      session.supportsSampling = Boolean(params?.capabilities?.sampling);

      const response = {
        protocolVersion: session?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
      if (!isAuthConfiguredForWarning()) {
        response._meta = { security_warning: SECURITY_WARNING_MESSAGE };
      }
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
      const { getOutputSchema } = require('../tool-output-schemas');
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

// ── New factory shape (preferred) ─────────────────────────────────────────────
function createMcpProtocol(deps = {}) {
  const local = {
    _tools: deps.tools,
    _coreToolNames: deps.coreToolNames,
    _extendedToolNames: deps.extendedToolNames,
    _handleToolCall: deps.handleToolCall,
    _onInitialize: deps.onInitialize,
    _isAuthConfigured: deps.isAuthConfigured,
  };
  function withLocalDeps(fn) {
    const prev = {
      _tools, _coreToolNames, _extendedToolNames,
      _handleToolCall, _onInitialize, _isAuthConfigured,
    };
    if (local._tools !== undefined) _tools = local._tools || [];
    if (local._coreToolNames !== undefined) _coreToolNames = local._coreToolNames || [];
    if (local._extendedToolNames !== undefined) _extendedToolNames = local._extendedToolNames || [];
    if (local._handleToolCall !== undefined) _handleToolCall = local._handleToolCall;
    if (local._onInitialize !== undefined) _onInitialize = local._onInitialize || null;
    if (local._isAuthConfigured !== undefined) {
      _isAuthConfigured = typeof local._isAuthConfigured === 'function' ? local._isAuthConfigured : null;
    }
    try { return fn(); } finally {
      _tools = prev._tools;
      _coreToolNames = prev._coreToolNames;
      _extendedToolNames = prev._extendedToolNames;
      _handleToolCall = prev._handleToolCall;
      _onInitialize = prev._onInitialize;
      _isAuthConfigured = prev._isAuthConfigured;
    }
  }
  return {
    handleRequest: (...args) => withLocalDeps(() => handleRequest(...args)),
    SERVER_INFO,
    DEFAULT_PROTOCOL_VERSION,
    SECURITY_WARNING_MESSAGE,
  };
}

function register(container) {
  // The MCP protocol's deps are non-DI service references (tools, handleToolCall),
  // wired by the boot path in server/index.js. We register a no-arg factory so
  // consumers can resolve the module shape, but boot still calls
  // mcpProtocol.init({...}) for the legacy in-place wiring during the
  // coexistence window.
  container.register('mcpProtocol', [], () => createMcpProtocol());
}

module.exports = {
  // New shape (preferred)
  createMcpProtocol,
  register,
  // Legacy shape (kept until server/index.js boot wires deps via container)
  init,
  handleRequest,
  SERVER_INFO,
  DEFAULT_PROTOCOL_VERSION,
  SECURITY_WARNING_MESSAGE,
};
