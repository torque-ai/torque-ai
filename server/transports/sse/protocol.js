/**
 * SSE Protocol Handler
 *
 * JSON-RPC dispatch, MCP request handling, SSE-only tool definitions,
 * body parsing, and auto-subscription logic.
 *
 * Extracted from mcp-sse.js to keep the transport module under 1000 lines.
 */

const mcpProtocol = require('../../mcp-protocol');
const { TOOLS, handleToolCall } = require('../../tools');
const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('../../core-tools');
const db = require('../../database');
const session = require('./session');

// ──────────────────────────────────────────────────────────────
// SSE-only tool definitions
// ──────────────────────────────────────────────────────────────

const SSE_TOOLS = [
  {
    name: 'subscribe_task_events',
    description: 'Subscribe this session to task completion/failure notifications. Events are pushed as MCP log messages and queued for check_notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs to watch (empty or omitted = all tasks)',
        },
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'Event types: completed, failed, cancelled, retry (default: completed, failed)',
        },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only receive events for these projects (empty = all projects)',
        },
        providers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only receive events from these providers (empty = all providers)',
        },
      },
    },
  },
  {
    name: 'check_notifications',
    description: 'Return and clear pending task notifications for this session. Call after receiving a push notification, or poll periodically.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ack_notification',
    description: 'Acknowledge specific notifications without clearing the entire queue. Remove events by task ID or by index.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Remove all pending events for these task IDs',
        },
        indices: {
          type: 'array',
          items: { type: 'number' },
          description: 'Remove events at these 0-based indices in the pending queue',
        },
      },
    },
  },
];

const SSE_TOOL_NAMES = new Set(SSE_TOOLS.map(t => t.name));

function requireAuthenticatedSession(method, sess) {
  if (method !== 'initialize' && method !== 'notifications/initialized' && !sess?.authenticated) {
    throw { code: -32600, message: 'Authentication required. Provide API key via X-Torque-Key header.' };
  }
}

// ──────────────────────────────────────────────────────────────
// Body parsing
// ──────────────────────────────────────────────────────────────

/**
 * Parse JSON body from an HTTP request.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    let settled = false;
    const MAX_BODY = 10 * 1024 * 1024;
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(bodyTimeout);
      resolve(value);
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(bodyTimeout);
      reject(err);
    };
    const bodyTimeout = setTimeout(() => {
      const err = new Error('Body parse timeout');
      finishReject(err);
      req.destroy(err);
    }, 30000);

    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY) {
        finishReject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const body = Buffer.concat(chunks).toString('utf-8');
      if (!body) return finishResolve(null);
      try {
        finishResolve(JSON.parse(body));
      } catch {
        finishReject(new Error('Invalid JSON'));
      }
    });
    req.on('error', (err) => {
      finishReject(err);
    });
  });
}

// ──────────────────────────────────────────────────────────────
// MCP request handler
// ──────────────────────────────────────────────────────────────

// Injected reference to sendJsonRpcNotification
let _sendJsonRpcNotification = null;

function injectNotificationSender(fn) {
  _sendJsonRpcNotification = fn;
}

/**
 * Handle an MCP JSON-RPC request within an SSE session.
 * Delegates initialize, tools/list, and tools/call to the shared mcp-protocol handler.
 * SSE-specific tools (subscribe, notifications, ack) are intercepted before delegation.
 */
async function handleMcpRequest(request, sess) {
  const { method, params } = request;

  requireAuthenticatedSession(method, sess);

  // SSE-only tools need the full session context — intercept before delegation
  if (method === 'tools/call' && params != null && typeof params === 'object' && !Array.isArray(params)) {
    const name = params.name;
    if (name && SSE_TOOL_NAMES.has(name)) {
      const normalizedArgs = params.arguments || {};
      if (name === 'subscribe_task_events') return session.handleSubscribeTaskEvents(sess, normalizedArgs);
      if (name === 'check_notifications') return session.handleCheckNotifications(sess);
      if (name === 'ack_notification') return session.handleAckNotification(sess, normalizedArgs);
    }
  }

  // Delegate to shared protocol handler
  const result = await mcpProtocol.handleRequest(request, sess);

  // SSE transport-specific post-processing: notify client when tool mode changed
  if (sess._toolsChanged) {
    sess._toolsChanged = false;
    if (_sendJsonRpcNotification) {
      _sendJsonRpcNotification(sess, 'notifications/tools/list_changed');
    }
  }

  // Append SSE-only tools to tools/list responses
  if (method === 'tools/list' && result && result.tools && SSE_TOOLS) {
    result.tools = [...result.tools, ...SSE_TOOLS];
  }

  // Auto-subscribe session to tasks returned by tool calls
  if (method === 'tools/call' && result) {
    const subscriptionTarget = session.buildSubscriptionTargetFromResult(result);
    if (subscriptionTarget) {
      session.applySubscriptionTargetToSession(sess, subscriptionTarget);
      return session.mergeSubscriptionTargetIntoResult(result, subscriptionTarget);
    }
  }

  return result;
}

/**
 * Initialize the shared MCP protocol handler with SSE-aware tool dispatch.
 */
function initProtocol(shutdownAbort) {
  mcpProtocol.init({
    tools: TOOLS,
    coreToolNames: Array.isArray(CORE_TOOL_NAMES) ? CORE_TOOL_NAMES : [...CORE_TOOL_NAMES],
    extendedToolNames: Array.isArray(EXTENDED_TOOL_NAMES) ? EXTENDED_TOOL_NAMES : [...EXTENDED_TOOL_NAMES],
    handleToolCall: async (name, args, sess) => {
      const argsWithSignal = {
        ...args,
        __shutdownSignal: shutdownAbort ? shutdownAbort.signal : undefined,
        __sessionId: sess?._sessionId || null,
      };

      // Lazy agent name update on first tool call with working_directory
      if (args.working_directory && sess && !sess._nameUpdated) {
        try {
          const projectName = require('path').basename(args.working_directory);
          const coord = require('../../db/coordination');
          coord.updateAgent(sess._sessionId, { name: `claude-code@${projectName}` });
          sess._nameUpdated = true;
        } catch {
          // Non-fatal
        }
      }

      return handleToolCall(name, argsWithSignal);
    },
    onInitialize: (_sess) => {
      // Economy mode removed — routing templates handle cost-aware provider selection
    },
    isAuthConfigured: () => Boolean(db.getConfig('api_key')),
  });
}

module.exports = {
  SSE_TOOLS,
  SSE_TOOL_NAMES,
  parseBody,
  handleMcpRequest,
  initProtocol,
  injectNotificationSender,
};
