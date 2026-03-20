'use strict';

const http = require('http');
const { handleToolCall } = require('../tools');
const { listTools } = require('./catalog-v1');
const schemaRegistry = require('./schema-registry');
const db = require('../database');
const serverConfig = require('../config');
const telemetry = require('./telemetry');
const { createCorrelationId, okEnvelope, errorEnvelope } = require('./envelope');
const logger = require('../logger').child({ component: 'mcp-gateway' });
const { v4: uuidv4 } = require('uuid');
const { createHash } = require('crypto');
const {
  createEventSubscription,
  pollSubscription,
  deleteEventSubscription,
  pollSubscriptionAfterCursor,
  cleanupEventData,
} = require('../database');

let server = null;
let port = 3459;
let idempotencyCleanupInterval = null;
let sessionCleanupInterval = null;
let eventDataCleanupInterval = null;
let rateLimitCleanupInterval = null;
const STALE_SESSION_TTL_MS = 90 * 60 * 1000;
const STALE_SESSION_POLL_INTERVAL_MS = 5 * 60 * 1000;
const EVENT_DATA_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const EVENT_DATA_RETENTION_DAYS = 7;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const STREAM_EVENT_TYPES = [
  'status_change',
  'completed',
  'failed',
  'started',
  'cancelled',
  'output',
  'output_update',
  '*',
];

const SESSION_STORE = new Map();

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const idempotencyStore = new Map();
const idempotencyInFlight = new Map();
const TASK_TOOL_NAMES = new Set([
  'torque.task.submit',
  'torque.task.get',
  'torque.task.list',
  'torque.task.cancel',
  'torque.task.retry',
  'torque.task.review',
  'torque.task.approve',
  'torque.task.reject',
]);
const WORKFLOW_TOOL_NAMES = new Set([
  'torque.workflow.create',
  'torque.workflow.get',
  'torque.workflow.list',
  'torque.workflow.pause',
  'torque.workflow.resume',
  'torque.workflow.cancel',
  'torque.workflow.retryNode',
]);
const PROVIDER_TOOL_NAMES = new Set([
  'torque.provider.list',
  'torque.provider.get',
  'torque.provider.enable',
  'torque.provider.disable',
  'torque.provider.setWeight',
  'torque.provider.setDefault',
]);
const ROUTE_TOOL_NAMES = new Set([
  'torque.route.preview',
  'torque.route.explain',
]);
const POLICY_TOOL_NAMES = new Set([
  'torque.policy.get',
  'torque.policy.set',
]);
const DIAGNOSTIC_TOOL_NAMES = new Set([
  'torque.audit.query',
  'torque.telemetry.summary',
]);
const MUTATION_KILLSWITCH_TOOL_NAMES = new Set([
  'torque.task.submit',
  'torque.task.cancel',
  'torque.task.retry',
  'torque.task.review',
  'torque.task.approve',
  'torque.task.reject',
  'torque.workflow.create',
  'torque.workflow.pause',
  'torque.workflow.resume',
  'torque.workflow.cancel',
  'torque.workflow.retryNode',
  'torque.provider.enable',
  'torque.provider.disable',
  'torque.provider.setWeight',
  'torque.provider.setDefault',
]);
const SESSION_TOOL_NAMES = new Set([
  'torque.session.open',
  'torque.session.close',
]);
const STREAM_TOOL_NAMES = new Set([
  'torque.stream.subscribe',
  'torque.stream.unsubscribe',
  'torque.stream.poll',
]);
const SUPPORTED_TOOL_NAMES = new Set([
  ...TASK_TOOL_NAMES,
  ...WORKFLOW_TOOL_NAMES,
  ...PROVIDER_TOOL_NAMES,
  ...ROUTE_TOOL_NAMES,
  ...POLICY_TOOL_NAMES,
  ...DIAGNOSTIC_TOOL_NAMES,
  ...SESSION_TOOL_NAMES,
  ...STREAM_TOOL_NAMES,
]);
const MUTATION_TOOL_NAMES = new Set(
  listTools().filter((tool) => tool.mutation).map((tool) => tool.name),
);
const TOOL_RATE_LIMITS = Object.freeze({
  'torque.task.get': 120,
  'torque.task.list': 120,
  'torque.task.submit': 60,
  'torque.task.cancel': 60,
  'torque.task.retry': 60,
  'torque.task.review': 60,
  'torque.task.approve': 60,
  'torque.task.reject': 60,
  'torque.workflow.create': 60,
  'torque.workflow.get': 120,
  'torque.workflow.list': 120,
  'torque.workflow.pause': 60,
  'torque.workflow.resume': 60,
  'torque.workflow.cancel': 60,
  'torque.workflow.retryNode': 60,
  'torque.provider.list': 120,
  'torque.provider.get': 120,
  'torque.provider.enable': 20,
  'torque.provider.disable': 20,
  'torque.provider.setWeight': 20,
  'torque.provider.setDefault': 20,
  'torque.route.preview': 120,
  'torque.route.explain': 120,
  'torque.policy.get': 60,
  'torque.policy.set': 20,
  'torque.audit.query': 60,
  'torque.telemetry.summary': 120,
  'torque.session.open': 60,
  'torque.session.close': 60,
  'torque.stream.subscribe': 60,
  'torque.stream.poll': 120,
  'torque.stream.unsubscribe': 60,
});
const ALLOWED_ROLES = new Set(['viewer', 'operator', 'admin']);
const ADMIN_ONLY_TOOL_NAMES = new Set([
  'torque.policy.get',
  'torque.policy.set',
  'torque.audit.query',
  'torque.provider.enable',
  'torque.provider.disable',
  'torque.provider.setWeight',
  'torque.provider.setDefault',
]);
const OPERATOR_ONLY_TOOL_NAMES = new Set([
  'torque.task.submit',
  'torque.task.cancel',
  'torque.task.retry',
  'torque.task.review',
  'torque.task.approve',
  'torque.task.reject',
  'torque.workflow.create',
  'torque.workflow.pause',
  'torque.workflow.resume',
  'torque.workflow.cancel',
  'torque.workflow.retryNode',
]);
const MCP_POLICY_STORE_KEY = 'mcp_policy_store';
const MCP_KILL_SWITCH_POLICY_KEY = 'mcp_kill_switch';
const rateLimitBuckets = new Map();

logger.warn('MCP Gateway transport is deprecated — use SSE transport (port 3458) instead. Gateway will be removed in a future release.');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    const MAX_BODY = 1024 * 1024;

    const bodyTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Body parse timeout'));
      }
      req.destroy();
    }, 30000);

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        clearTimeout(bodyTimeout);
        if (!settled) { settled = true; reject(new Error('Payload too large')); }
        req.destroy();
        return;
      }
    });

    req.on('end', () => {
      clearTimeout(bodyTimeout);
      if (settled) return;
      if (!body) { settled = true; return resolve({}); }
      try {
        settled = true;
        resolve(JSON.parse(body));
      } catch {
        settled = true;
        reject(new Error('Invalid JSON payload'));
      }
    });

    req.on('error', (err) => {
      clearTimeout(bodyTimeout);
      if (!settled) { settled = true; reject(err); }
    });
  });
}

function readCorrelationId(req) {
  const header = req.headers['x-correlation-id'];
  if (Array.isArray(header)) {
    return header[0] || createCorrelationId();
  }
  return header || createCorrelationId();
}

function writeJson(res, statusCode, payload, correlationId) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'X-Correlation-ID': correlationId,
    'Deprecation': 'true',
    'Sunset': '2026-06-01',
  });
  res.end(JSON.stringify(payload));
}

function getSchemaId(toolName, direction) {
  return `${toolName}.${direction}.schema`;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function computeHashDigest(value) {
  return createHash('sha256').update(safeJsonStringify(value || {})).digest('hex');
}

function recordMutationAudit(toolName, args, execution, actor, role, correlationId, idempotencyKey) {
  const metadata = {
    mcp: {
      mutation: true,
      correlation_id: correlationId,
      role,
    },
    input_hash: computeHashDigest(args),
    result_hash: computeHashDigest(execution.data || null),
    idempotency_key: idempotencyKey || null,
  };

  db.recordAuditLog(
    'mcp_tool',
    toolName,
    toolName,
    actor,
    null,
    null,
    metadata,
  );
}

function readActor(req) {
  const actor = req.headers['x-mcp-actor'];
  if (Array.isArray(actor)) return actor[0] || 'local';
  return actor || 'local';
}

function readSessionId(req) {
  const sessionId = req.headers['x-session-id'];
  if (Array.isArray(sessionId)) return sessionId[0] || 'default';
  return sessionId || 'default';
}

function readRole(req) {
  const roleHeader = req.headers['x-mcp-role'];
  const rawRole = Array.isArray(roleHeader) ? roleHeader[0] : roleHeader;
  const normalized = String(rawRole || 'viewer').trim().toLowerCase();
  return normalized || 'viewer';
}

function getToolRateLimit(toolName) {
  return TOOL_RATE_LIMITS[toolName] || 120;
}

function getRateLimitBucketKey(role, actor, toolName) {
  return `${role}:${actor || 'local'}:${toolName}`;
}

function pruneRateLimits() {
  const now = Date.now();
  for (const [bucket, entry] of rateLimitBuckets.entries()) {
    if (now > entry.resetAt) {
      rateLimitBuckets.delete(bucket);
    }
  }
}

function checkRateLimitState(role, actor, toolName) {
  const limitPerMinute = getToolRateLimit(toolName);
  const bucket = getRateLimitBucketKey(role, actor || 'local', toolName);
  const now = Date.now();

  let state = rateLimitBuckets.get(bucket);
  if (!state || now >= state.resetAt) {
    state = {
      count: 0,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    };
    rateLimitBuckets.set(bucket, state);
  }

  state.count += 1;
  const remaining = Math.max(0, limitPerMinute - state.count);
  const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));

  return {
    allowed: state.count <= limitPerMinute,
    limit: limitPerMinute,
    remaining,
    resetAt: state.resetAt,
    retryAfter,
  };
}

function normalizePolicyKey(rawKey) {
  if (rawKey === undefined || rawKey === null) return null;
  const value = String(rawKey).trim();
  return value.length > 0 ? value : null;
}

function loadPolicyStore() {
  const raw = serverConfig.get(MCP_POLICY_STORE_KEY);
  if (!raw) return {};

  if (typeof raw !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    logger.warn(`Invalid policy store JSON in config key: ${MCP_POLICY_STORE_KEY}`);
  }

  return {};
}

function persistPolicyStore(store) {
  db.setConfig(MCP_POLICY_STORE_KEY, JSON.stringify(store || {}));
}

function valuesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeBooleanishValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return false;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}

function normalizeKillSwitchPolicy(raw) {
  const defaultReason = 'MCP kill-switch is active for high-risk mutation tools.';

  if (raw === null || raw === undefined) {
    return { enabled: false, reason: defaultReason, blockedTools: null };
  }

  if (Array.isArray(raw)) {
    return { enabled: false, reason: defaultReason, blockedTools: null };
  }

  if (typeof raw === 'boolean' || typeof raw === 'number' || typeof raw === 'string') {
    const enabled = normalizeBooleanishValue(raw);
    return {
      enabled,
      reason: defaultReason,
      blockedTools: enabled ? [] : null,
    };
  }

  if (!raw || typeof raw !== 'object') {
    return { enabled: false, reason: defaultReason, blockedTools: null };
  }

  const enabled = normalizeBooleanishValue(raw.enabled);
  if (!enabled) {
    return { enabled: false, reason: defaultReason, blockedTools: null };
  }

  const scope = raw.blocked_tools || raw.tools || raw.scope || null;
  let blockedTools = [];
  if (typeof scope === 'string') {
    blockedTools = scope.split(',').map((entry) => entry.trim()).filter(Boolean);
  } else if (Array.isArray(scope)) {
    blockedTools = scope
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return {
    enabled: true,
    reason:
      typeof raw.reason === 'string' && raw.reason.trim()
        ? raw.reason.trim()
        : defaultReason,
    blockedTools,
  };
}

function isKillSwitchBlockingTool(toolName) {
  const policyStore = loadPolicyStore();
  const normalized = normalizeKillSwitchPolicy(policyStore[MCP_KILL_SWITCH_POLICY_KEY]);

  if (!normalized.enabled) {
    return null;
  }

  const blockedTools = normalized.blockedTools || [];
  if (!blockedTools.length) {
    return MUTATION_KILLSWITCH_TOOL_NAMES.has(toolName) ? normalized : null;
  }

  const normalizedTool = String(toolName || '').toLowerCase();
  for (const rawBlockedTool of blockedTools) {
    const blockedTool = String(rawBlockedTool || '').trim().toLowerCase();
    if (!blockedTool) continue;

    if (blockedTool === 'all' || blockedTool === '*') {
      return normalized;
    }

    if (blockedTool === normalizedTool) {
      return normalized;
    }

    if (!blockedTool.includes('.')
      && normalizedTool.startsWith(`torque.${blockedTool}.`)) {
      return normalized;
    }
  }

  return null;
}

function getIdempotencyScope(req, toolName, idempotencyKey) {
  const actor = readActor(req);
  const sessionId = readSessionId(req);
  return `${actor}:${sessionId}:${toolName}:${idempotencyKey}`;
}

function parseToolContent(result) {
  if (!result || !Array.isArray(result.content)) return result;

  if (result.content.length === 1 && result.content[0].type === 'text') {
    const raw = result.content[0].text;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
  }

  return result.content;
}

function normalizeEventTypes(eventTypes) {
  const requested = Array.isArray(eventTypes) && eventTypes.length > 0
    ? eventTypes
    : ['status_change'];

  const normalized = [];
  const seen = new Set();

  for (const raw of requested) {
    if (typeof raw !== 'string') {
      return null;
    }

    const value = raw.trim();
    if (!value) {
      return null;
    }

    if (!STREAM_EVENT_TYPES.includes(value)) {
      return null;
    }

    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }

  return normalized;
}

function createSessionRecord(actor = 'local') {
  const sessionId = uuidv4();
  const now = new Date().toISOString();

  const session = {
    session_id: sessionId,
    actor,
    opened_at: now,
    last_seen_at: now,
    subscriptions: new Set(),
  };

  SESSION_STORE.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  return SESSION_STORE.get(sessionId);
}

function touchSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;

  session.last_seen_at = new Date().toISOString();
  return session;
}

function closeSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;

  if (session.subscriptions && session.subscriptions.size > 0) {
    for (const subscriptionId of session.subscriptions) {
      deleteEventSubscription(subscriptionId);
    }
  }

  SESSION_STORE.delete(sessionId);
  return true;
}

function cleanupStaleSessions() {
  const now = Date.now();
  for (const [sessionId, session] of SESSION_STORE.entries()) {
    const lastSeen = new Date(session.last_seen_at).getTime();
    if (Number.isNaN(lastSeen)) {
      continue;
    }

    if (now - lastSeen > STALE_SESSION_TTL_MS) {
      closeSession(sessionId);
    }
  }
}

function mapTaskToolCall(toolName, args) {
  const payload = args || {};

  switch (toolName) {
    case 'torque.task.submit':
      return {
        tool: 'submit_task',
        args: {
          task: payload.task || payload.prompt,
          working_directory: payload.working_directory,
          timeout_minutes: payload.timeout_minutes,
          auto_approve: payload.auto_approve,
          priority: payload.priority,
          provider: payload.provider,
          model: payload.model,
        },
      };

    case 'torque.task.get':
      return {
        tool: 'get_result',
        args: {
          task_id: payload.task_id,
        },
      };

    case 'torque.task.list':
      return {
        tool: 'list_tasks',
        args: {
          status: payload.status,
          tags: payload.tags,
          project: payload.project,
          all_projects: payload.all_projects,
          project_id: payload.project_id,
          limit: payload.limit,
        },
      };

    case 'torque.task.cancel':
      return {
        tool: 'cancel_task',
        args: {
          task_id: payload.task_id,
          reason: payload.reason,
          confirm: payload.confirm !== undefined ? payload.confirm : true,
        },
      };

    case 'torque.task.retry':
      return {
        tool: 'retry_task',
        args: {
          task_id: payload.task_id,
          modified_task: payload.modified_task,
        },
      };

    case 'torque.task.review':
      return {
        tool: 'set_task_review_status',
        args: {
          task_id: payload.task_id,
          status: payload.status || payload.review_status,
          notes: payload.notes,
        },
      };

    case 'torque.task.approve': {
      if (payload.approval_id) {
        return {
          tool: 'approve_task',
          args: {
            approval_id: payload.approval_id,
            notes: payload.notes,
          },
        };
      }

      return {
        tool: 'set_task_review_status',
        args: {
          task_id: payload.task_id,
          status: 'approved',
          notes: payload.notes,
        },
      };
    }

    case 'torque.task.reject': {
      if (payload.approval_id) {
        return {
          tool: 'reject_task',
          args: {
            approval_id: payload.approval_id,
            notes: payload.notes,
          },
        };
      }

      return {
        tool: 'set_task_review_status',
        args: {
          task_id: payload.task_id,
          status: 'needs_correction',
          notes: payload.notes,
        },
      };
    }

    case 'torque.workflow.create':
      return {
        tool: 'create_workflow',
        args: {
          name: payload.name,
          description: payload.description,
          working_directory: payload.working_directory,
        },
      };

    case 'torque.workflow.get':
      return {
        tool: 'workflow_status',
        args: {
          workflow_id: payload.workflow_id,
        },
      };

    case 'torque.workflow.list':
      return {
        tool: 'list_workflows',
        args: {
          status: payload.status,
          template_id: payload.template_id,
          since: payload.since,
          limit: payload.limit,
        },
      };

    case 'torque.workflow.pause':
      return {
        tool: 'pause_workflow',
        args: {
          workflow_id: payload.workflow_id,
        },
      };

    case 'torque.workflow.resume':
      return {
        tool: 'run_workflow',
        args: {
          workflow_id: payload.workflow_id,
        },
      };

    case 'torque.workflow.cancel':
      return {
        tool: 'cancel_workflow',
        args: {
          workflow_id: payload.workflow_id,
          reason: payload.reason,
        },
      };

    case 'torque.workflow.retryNode':
      return {
        tool: 'retry_workflow_from',
        args: {
          workflow_id: payload.workflow_id,
          from_task_id: payload.from_task_id || payload.node_task_id,
        },
      };

    case 'torque.provider.list':
      return {
        tool: 'list_providers',
        args: {},
      };

    case 'torque.provider.get':
      return {
        tool: 'provider_stats',
        args: {
          provider: payload.provider || payload.provider_id,
          days: payload.days,
        },
      };

    case 'torque.provider.enable':
      return {
        tool: 'configure_provider',
        args: {
          provider: payload.provider || payload.provider_id,
          enabled: true,
        },
      };

    case 'torque.provider.disable':
      return {
        tool: 'configure_provider',
        args: {
          provider: payload.provider || payload.provider_id,
          enabled: false,
        },
      };

    case 'torque.provider.setWeight':
      return {
        tool: 'configure_provider',
        args: {
          provider: payload.provider || payload.provider_id,
          max_concurrent: payload.max_concurrent ?? payload.weight,
        },
      };

    case 'torque.provider.setDefault':
      return {
        tool: 'set_default_provider',
        args: {
          provider: payload.provider || payload.provider_id,
        },
      };

    case 'torque.route.preview':
    case 'torque.route.explain':
      return {
        tool: 'test_routing',
        args: {
          task: payload.task,
          files: payload.files,
        },
      };

    case 'torque.audit.query':
      return {
        tool: '__mcp_audit_query',
        args: {
          entity_type: payload.entity_type,
          entity_id: payload.entity_id,
          action: payload.action,
          actor: payload.actor,
          since: payload.since,
          until: payload.until,
          limit: payload.limit,
          offset: payload.offset,
          include_stats: payload.include_stats,
        },
      };

    case 'torque.telemetry.summary':
      return {
        tool: '__mcp_telemetry_summary',
        args: {
          include_tools: payload.include_tools,
          include_errors: payload.include_errors,
        },
      };

    case 'torque.policy.get':
      return {
        tool: '__mcp_policy_get',
        args: {
          key: payload.key || payload.policy_key,
        },
      };

    case 'torque.policy.set':
      return {
        tool: '__mcp_policy_set',
        args: {
          key: payload.key || payload.policy_key,
          value: payload.value,
        },
      };

    case 'torque.session.open':
      return {
        tool: '__mcp_session_open',
        args: {
          actor: payload.actor,
        },
      };

    case 'torque.session.close':
      return {
        tool: '__mcp_session_close',
        args: {
          session_id: payload.session_id,
        },
      };

    case 'torque.stream.subscribe':
      return {
        tool: '__mcp_stream_subscribe',
        args: {
          task_id: payload.task_id,
          event_types: payload.event_types,
          expires_in_minutes: payload.expires_in_minutes,
          session_id: payload.session_id,
        },
      };

    case 'torque.stream.unsubscribe':
      return {
        tool: '__mcp_stream_unsubscribe',
        args: {
          subscription_id: payload.subscription_id,
        },
      };

    case 'torque.stream.poll':
      return {
        tool: '__mcp_stream_poll',
        args: {
          subscription_id: payload.subscription_id,
          cursor_token: payload.cursor_token,
        },
      };

    default:
      return null;
  }
}

function validateToolArgumentsSemantics(toolName, args) {
  const payload = args || {};

  if (toolName === 'torque.task.submit' && !payload.task && !payload.prompt) {
    return {
      valid: false,
      code: 'VALIDATION_TASK_REQUIRED',
      message: 'Either task or prompt is required',
    };
  }

  if ((toolName === 'torque.task.approve' || toolName === 'torque.task.reject')
    && !payload.approval_id && !payload.task_id) {
    return {
      valid: false,
      code: 'VALIDATION_APPROVAL_OR_TASK_REQUIRED',
      message: 'Either approval_id or task_id is required',
    };
  }

  if (toolName === 'torque.workflow.create' && !payload.name) {
    return {
      valid: false,
      code: 'VALIDATION_WORKFLOW_NAME_REQUIRED',
      message: 'name is required',
    };
  }

  if (
    (toolName === 'torque.workflow.get'
      || toolName === 'torque.workflow.pause'
      || toolName === 'torque.workflow.resume'
      || toolName === 'torque.workflow.cancel')
    && !payload.workflow_id
  ) {
    return {
      valid: false,
      code: 'VALIDATION_WORKFLOW_ID_REQUIRED',
      message: 'workflow_id is required',
    };
  }

  if (toolName === 'torque.workflow.retryNode' && (!payload.workflow_id || (!payload.from_task_id && !payload.node_task_id))) {
    return {
      valid: false,
      code: 'VALIDATION_WORKFLOW_RETRYNODE_REQUIRED',
      message: 'workflow_id and from_task_id (or node_task_id) are required',
    };
  }

  if ((toolName === 'torque.route.preview' || toolName === 'torque.route.explain') && !payload.task) {
    return {
      valid: false,
      code: 'VALIDATION_ROUTING_TASK_REQUIRED',
      message: 'task is required',
    };
  }

  if (toolName === 'torque.session.open' && !payload.actor) {
    return {
      valid: false,
      code: 'VALIDATION_SESSION_ACTOR_REQUIRED',
      message: 'actor is required',
    };
  }

  if (toolName === 'torque.session.close' && !payload.session_id) {
    return {
      valid: false,
      code: 'VALIDATION_SESSION_ID_REQUIRED',
      message: 'session_id is required',
    };
  }

  if (toolName === 'torque.stream.subscribe' && !payload.task_id && !payload.session_id) {
    return {
      valid: false,
      code: 'VALIDATION_STREAM_TARGET_REQUIRED',
      message: 'task_id or session_id is required',
    };
  }

  if (toolName === 'torque.stream.subscribe' && payload.event_types !== undefined && !Array.isArray(payload.event_types)) {
    return {
      valid: false,
      code: 'VALIDATION_STREAM_EVENT_TYPES_ARRAY',
      message: 'event_types must be an array',
    };
  }

  if (toolName === 'torque.stream.subscribe' && normalizeEventTypes(payload.event_types) === null) {
    return {
      valid: false,
      code: 'VALIDATION_STREAM_EVENT_TYPES_INVALID',
      message: `event_types must be a subset of: ${STREAM_EVENT_TYPES.join(', ')}`,
    };
  }

  if (
    toolName === 'torque.stream.subscribe'
    && payload.expires_in_minutes !== undefined
    && (typeof payload.expires_in_minutes !== 'number' || payload.expires_in_minutes <= 0 || payload.expires_in_minutes > 10080)
  ) {
    return {
      valid: false,
      code: 'VALIDATION_STREAM_TTL_INVALID',
      message: 'expires_in_minutes must be a positive number up to 10080',
    };
  }

  if (toolName === 'torque.stream.unsubscribe' && !payload.subscription_id) {
    return {
      valid: false,
      code: 'VALIDATION_SUBSCRIPTION_ID_REQUIRED',
      message: 'subscription_id is required',
    };
  }

  if (toolName === 'torque.stream.poll' && !payload.subscription_id) {
    return {
      valid: false,
      code: 'VALIDATION_SUBSCRIPTION_ID_REQUIRED',
      message: 'subscription_id is required',
    };
  }

  if (toolName === 'torque.stream.poll' && payload.cursor_token !== undefined && typeof payload.cursor_token !== 'string') {
    return {
      valid: false,
      code: 'VALIDATION_CURSOR_TOKEN_TYPE',
      message: 'cursor_token must be a string',
    };
  }

  if (toolName === 'torque.stream.poll' && payload.cursor_token !== undefined) {
    const cursorToken = payload.cursor_token.trim();
    if (!cursorToken || Number.isNaN(Date.parse(cursorToken))) {
      return {
        valid: false,
        code: 'VALIDATION_CURSOR_TOKEN_INVALID',
        message: 'cursor_token must be a valid timestamp string',
      };
    }
  }

  if (toolName === 'torque.policy.get'
    && (payload.key !== undefined || payload.policy_key !== undefined)
  ) {
    const policyKey = normalizePolicyKey(payload.key || payload.policy_key);
    if (policyKey === null) {
      return {
        valid: false,
        code: 'VALIDATION_POLICY_KEY_REQUIRED',
        message: 'policy_key must be a non-empty string when provided',
      };
    }
  }

  if (toolName === 'torque.policy.set') {
    const policyKey = normalizePolicyKey(payload.key || payload.policy_key);
    if (policyKey === null) {
      return {
        valid: false,
        code: 'VALIDATION_POLICY_KEY_REQUIRED',
        message: 'policy key is required',
      };
    }

    if (!Object.prototype.hasOwnProperty.call(payload, 'value')) {
      return {
        valid: false,
        code: 'VALIDATION_POLICY_VALUE_REQUIRED',
        message: 'value is required',
      };
    }
  }

  if (
    (toolName === 'torque.provider.get'
      || toolName === 'torque.provider.enable'
      || toolName === 'torque.provider.disable'
      || toolName === 'torque.provider.setWeight'
      || toolName === 'torque.provider.setDefault')
    && !payload.provider && !payload.provider_id
  ) {
    return {
      valid: false,
      code: 'VALIDATION_PROVIDER_REQUIRED',
      message: 'provider or provider_id is required',
    };
  }

  if (toolName === 'torque.provider.setWeight' && payload.weight === undefined && payload.max_concurrent === undefined) {
    return {
      valid: false,
      code: 'VALIDATION_PROVIDER_WEIGHT_REQUIRED',
      message: 'weight or max_concurrent is required',
    };
  }

  if (toolName === 'torque.audit.query') {
    if (payload.limit !== undefined
      && (!Number.isFinite(payload.limit) || payload.limit <= 0 || !Number.isInteger(payload.limit))) {
      return {
        valid: false,
        code: 'VALIDATION_AUDIT_LIMIT_INVALID',
        message: 'limit must be a positive integer',
      };
    }

    if (payload.offset !== undefined
      && (!Number.isFinite(payload.offset) || payload.offset < 0 || !Number.isInteger(payload.offset))) {
      return {
        valid: false,
        code: 'VALIDATION_AUDIT_OFFSET_INVALID',
        message: 'offset must be a non-negative integer',
      };
    }

    if (payload.since !== undefined && Number.isNaN(Date.parse(payload.since))) {
      return {
        valid: false,
        code: 'VALIDATION_AUDIT_SINCE_INVALID',
        message: 'since must be an ISO8601 timestamp',
      };
    }

    if (payload.until !== undefined && Number.isNaN(Date.parse(payload.until))) {
      return {
        valid: false,
        code: 'VALIDATION_AUDIT_UNTIL_INVALID',
        message: 'until must be an ISO8601 timestamp',
      };
    }
  }

  return { valid: true };
}

function pruneExpiredIdempotency() {
  const now = Date.now();
  for (const [key, record] of idempotencyStore.entries()) {
    if (!record || record.expiresAt <= now) {
      idempotencyStore.delete(key);
    }
  }
}

function executeInternalMcpTool(mappedTool, args) {
  const normalized = {
    ...args,
  };

  if (mappedTool === '__mcp_session_open') {
    const session = createSessionRecord(normalized.actor || 'local');
    return {
      ok: true,
      statusCode: 200,
      data: {
        session_id: session.session_id,
        actor: session.actor,
        opened_at: session.opened_at,
      },
    };
  }

  if (mappedTool === '__mcp_session_close') {
    const sessionId = normalized.session_id;
    const closed = closeSession(sessionId);
    if (!closed) {
      return {
        ok: false,
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `Session not found: ${sessionId}`,
      };
    }

    return {
      ok: true,
      statusCode: 200,
      data: {
        session_id: sessionId,
        status: 'closed',
      },
    };
  }

  if (mappedTool === '__mcp_stream_subscribe') {
    const eventTypes = normalizeEventTypes(normalized.event_types);
    const sessionId = normalized.session_id;

    if (sessionId) {
      const session = getSession(sessionId);
      if (!session) {
        return {
          ok: false,
          statusCode: 404,
          code: 'NOT_FOUND',
          message: `Session not found: ${sessionId}`,
        };
      }

      touchSession(sessionId);
    }

    const subscriptionId = createEventSubscription(
      normalized.task_id || null,
      eventTypes,
      normalized.expires_in_minutes,
    );

    if (sessionId) {
      const session = touchSession(sessionId);
      if (session) {
        session.subscriptions.add(subscriptionId);
      }
    }

    return {
      ok: true,
      statusCode: 200,
      data: {
        subscription_id: subscriptionId,
        task_id: normalized.task_id || null,
        session_id: sessionId || null,
        event_types: eventTypes,
        expires_in_minutes: normalized.expires_in_minutes || 60,
        created_at: new Date().toISOString(),
      },
    };
  }

  if (mappedTool === '__mcp_audit_query') {
    const limit = Number.isFinite(Number(normalized.limit)) && Number.isInteger(normalized.limit)
      ? Math.max(1, Math.trunc(normalized.limit))
      : 100;
    const offset = Number.isFinite(Number(normalized.offset)) && Number.isInteger(normalized.offset)
      ? Math.max(0, Math.trunc(normalized.offset))
      : 0;

    const records = db.getAuditLog({
      entityType: normalized.entity_type,
      entityId: normalized.entity_id,
      action: normalized.action,
      actor: normalized.actor,
      since: normalized.since,
      until: normalized.until,
      limit,
      offset,
    });

    const response = {
      logs: records,
      count: records.length,
      limit,
      offset,
    };

    if (normalized.include_stats) {
      response.stats = db.getAuditStats({
        since: normalized.since,
        until: normalized.until,
      });
    }

    return {
      ok: true,
      statusCode: 200,
      data: response,
    };
  }

  if (mappedTool === '__mcp_telemetry_summary') {
    const baseSnapshot = telemetry.snapshot();

    return {
      ok: true,
      statusCode: 200,
      data: {
        generated_at: baseSnapshot.generated_at,
        tools: normalized.include_tools === false ? null : baseSnapshot.counters.tool_calls,
        errors: normalized.include_errors === false ? null : baseSnapshot.counters.errors,
        latency: baseSnapshot.latency,
      },
    };
  }

  if (mappedTool === '__mcp_stream_unsubscribe') {
    const subscriptionId = normalized.subscription_id;
    const deleted = deleteEventSubscription(subscriptionId);

    if (!deleted) {
      return {
        ok: false,
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `Subscription not found: ${subscriptionId}`,
      };
    }

    for (const session of SESSION_STORE.values()) {
      if (session.subscriptions && session.subscriptions.delete(subscriptionId)) {
        touchSession(session.session_id);
      }
    }

    return {
      ok: true,
      statusCode: 200,
      data: {
        subscription_id: subscriptionId,
        status: 'unsubscribed',
      },
    };
  }

  if (mappedTool === '__mcp_stream_poll') {
    const subscriptionId = normalized.subscription_id;
    const cursorToken = normalized.cursor_token;
    const result = cursorToken
      ? pollSubscriptionAfterCursor(subscriptionId, cursorToken)
      : pollSubscription(subscriptionId);

    if (!result) {
      return {
        ok: false,
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `Subscription not found: ${subscriptionId}`,
      };
    }

    if (result.expired) {
      for (const session of SESSION_STORE.values()) {
        if (session.subscriptions) {
          session.subscriptions.delete(subscriptionId);
        }
      }

      return {
        ok: true,
        statusCode: 200,
        data: {
          subscription_id: subscriptionId,
          expired: true,
          events: [],
          event_count: 0,
          next_cursor: null,
        },
      };
    }

    const events = result.events || [];
    for (const event of events) {
      if (event.event_data && typeof event.event_data === 'string') {
        try {
          event.event_data = JSON.parse(event.event_data);
        } catch {
          // Keep as string when parse fails.
        }
      }
    }

    const nextCursor = events.length > 0
      ? events[events.length - 1].created_at
      : null;

    return {
      ok: true,
      statusCode: 200,
      data: {
        subscription_id: subscriptionId,
        event_count: events.length,
        events,
        has_more: false, // All matching events are returned in a single batch (no pagination limit)
        next_cursor: nextCursor,
      },
    };
  }

  if (mappedTool === '__mcp_policy_get') {
    const policyStore = loadPolicyStore();
    const policyKey = normalizePolicyKey(normalized.key);

    if (!policyKey) {
      return {
        ok: true,
        statusCode: 200,
        data: {
          policies: policyStore,
        },
      };
    }

    if (!Object.prototype.hasOwnProperty.call(policyStore, policyKey)) {
      return {
        ok: false,
        statusCode: 404,
        code: 'POLICY_NOT_FOUND',
        message: `Policy key not found: ${policyKey}`,
      };
    }

    return {
      ok: true,
      statusCode: 200,
      data: {
        key: policyKey,
        value: policyStore[policyKey],
      },
    };
  }

  if (mappedTool === '__mcp_policy_set') {
    const policyStore = loadPolicyStore();
    const policyKey = normalizePolicyKey(normalized.key);
    const policyValue = normalized.value;
    const previous = Object.prototype.hasOwnProperty.call(policyStore, policyKey)
      ? policyStore[policyKey]
      : null;

    if (!policyKey) {
      return {
        ok: false,
        statusCode: 400,
        code: 'VALIDATION_POLICY_KEY_REQUIRED',
        message: 'policy key is required',
      };
    }

    policyStore[policyKey] = policyValue;
    persistPolicyStore(policyStore);

    return {
      ok: true,
      statusCode: 200,
      data: {
        key: policyKey,
        value: policyValue,
        previous,
        changed: !valuesEqual(previous, policyValue),
      },
    };
  }

  return {
    ok: false,
    statusCode: 501,
    code: 'NOT_IMPLEMENTED',
    message: `Tool is not implemented yet: ${mappedTool}`,
  };
}

async function executeTaskTool(toolName, args) {
  const mapped = mapTaskToolCall(toolName, args);
  if (!mapped) {
    return {
      ok: false,
      code: 'NOT_IMPLEMENTED',
      message: `Tool is not implemented yet: ${toolName}`,
      statusCode: 501,
    };
  }

  if (mapped.tool.startsWith('__mcp_')) {
    return executeInternalMcpTool(mapped.tool, mapped.args);
  }

  const toolResult = await handleToolCall(mapped.tool, mapped.args);
  const data = parseToolContent(toolResult);

  if (toolResult && toolResult.isError) {
    return {
      ok: false,
      code: 'TOOL_EXECUTION_ERROR',
      message: typeof data === 'string' ? data : 'Tool execution failed',
      details: data,
      statusCode: 400,
    };
  }

  return {
    ok: true,
    data,
    statusCode: 200,
  };
}

async function handleToolCallRoute(req, res, routeToolName = null) {
  const correlationId = readCorrelationId(req);
  const startedAt = Date.now();

  try {
    const body = await parseBody(req);
    const toolName = routeToolName || body.tool;
    const args = {
      ...(body.arguments || body.args || {}),
    };

    if (toolName === 'torque.session.open' && !args.actor) {
      args.actor = readActor(req);
    }

    if (!toolName || typeof toolName !== 'string') {
      telemetry.incrementError('VALIDATION_TOOL_NAME_REQUIRED');
      writeJson(res, 400, errorEnvelope({
        code: 'VALIDATION_TOOL_NAME_REQUIRED',
        message: 'tool is required',
        retryable: false,
      }, { correlation_id: correlationId }), correlationId);
      return;
    }

    if (!SUPPORTED_TOOL_NAMES.has(toolName)) {
      telemetry.incrementError('TOOL_UNSUPPORTED');
      writeJson(res, 404, errorEnvelope({
        code: 'TOOL_UNSUPPORTED',
        message: `Unsupported tool for current sprint: ${toolName}`,
        retryable: false,
      }, { correlation_id: correlationId }), correlationId);
      return;
    }

    const role = readRole(req);
    if (!ALLOWED_ROLES.has(role)) {
      telemetry.incrementError('POLICY_INVALID_ROLE');
      writeJson(res, 403, errorEnvelope({
        code: 'POLICY_INVALID_ROLE',
        message: `Unsupported role: ${role}`,
        retryable: false,
      }, { correlation_id: correlationId }), correlationId);
      return;
    }

    const actor = readActor(req);
    const rateLimitCheck = checkRateLimitState(role, actor, toolName);
    if (!rateLimitCheck.allowed) {
      telemetry.incrementError('POLICY_RATE_LIMIT_EXCEEDED');
      writeJson(res, 429, errorEnvelope({
        code: 'POLICY_RATE_LIMIT_EXCEEDED',
        message: `Rate limit exceeded for tool: ${toolName}`,
        retryable: true,
        details: {
          role,
          actor,
          tool: toolName,
          limit_per_minute: rateLimitCheck.limit,
          remaining: rateLimitCheck.remaining,
          retry_after_seconds: rateLimitCheck.retryAfter,
          reset_at_ms: rateLimitCheck.resetAt,
        },
      }, { correlation_id: correlationId }), correlationId);
      return;
    }

    if (ADMIN_ONLY_TOOL_NAMES.has(toolName) && role !== 'admin') {
      telemetry.incrementError('POLICY_FORBIDDEN');
      writeJson(res, 403, errorEnvelope({
        code: 'POLICY_FORBIDDEN',
        message: `Tool requires admin role: ${toolName}`,
        retryable: false,
      }, { correlation_id: correlationId }), correlationId);
      return;
    }

    if (OPERATOR_ONLY_TOOL_NAMES.has(toolName) && role === 'viewer') {
      telemetry.incrementError('POLICY_FORBIDDEN');
      writeJson(res, 403, errorEnvelope({
        code: 'POLICY_FORBIDDEN',
        message: `Tool requires operator role: ${toolName}`,
        retryable: false,
      }, { correlation_id: correlationId }), correlationId);
      return;
    }

    const killSwitch = isKillSwitchBlockingTool(toolName);
    if (killSwitch) {
      telemetry.incrementError('POLICY_KILL_SWITCH');
      writeJson(res, 403, errorEnvelope({
        code: 'POLICY_KILL_SWITCH',
        message: 'Tool blocked by active MCP kill-switch',
        retryable: false,
        details: {
          tool: toolName,
          policy_key: MCP_KILL_SWITCH_POLICY_KEY,
          reason: killSwitch.reason,
        },
      }, { correlation_id: correlationId }), correlationId);
      return;
    }

    const requestSchemaId = getSchemaId(toolName, 'request');
    const requestValidation = schemaRegistry.validate(requestSchemaId, args);
    if (!requestValidation.valid) {
      telemetry.incrementError('VALIDATION_REQUEST_SCHEMA_FAILED');
      writeJson(res, 400, errorEnvelope({
        code: 'VALIDATION_REQUEST_SCHEMA_FAILED',
        message: 'Request payload failed schema validation',
        retryable: false,
        details: requestValidation.errors,
      }, { correlation_id: correlationId }), correlationId);
      return;
    }

    const semanticValidation = validateToolArgumentsSemantics(toolName, args);
    if (!semanticValidation.valid) {
      telemetry.incrementError(semanticValidation.code);
      writeJson(res, 400, errorEnvelope({
        code: semanticValidation.code,
        message: semanticValidation.message,
        retryable: false,
      }, { correlation_id: correlationId }), correlationId);
      return;
    }

    telemetry.incrementToolCall(toolName);

    const isMutation = MUTATION_TOOL_NAMES.has(toolName);
    const idempotencyKey = args.idempotency_key || body.idempotency_key || null;
    let idempotencyScope = null;

    const executeAndCacheResult = async () => {
      const execution = await executeTaskTool(toolName, args);
      if (!execution.ok) {
        telemetry.incrementError(execution.code);
        const errorPayload = errorEnvelope({
          code: execution.code,
          message: execution.message,
          retryable: false,
          details: execution.details || null,
        }, {
          correlation_id: correlationId,
          idempotency_key: idempotencyKey || null,
        });

        if (idempotencyScope) {
          idempotencyStore.set(idempotencyScope, {
            statusCode: execution.statusCode || 400,
            payload: errorPayload,
            expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
          });
        }

        return { statusCode: execution.statusCode || 400, payload: errorPayload };
      }

      const responseEnvelope = okEnvelope(execution.data, {
        correlation_id: correlationId,
        idempotency_key: idempotencyKey || null,
      });

      const responseSchemaId = getSchemaId(toolName, 'response');
      const responseValidation = schemaRegistry.validate(responseSchemaId, responseEnvelope);
      if (!responseValidation.valid) {
        telemetry.incrementError('VALIDATION_RESPONSE_SCHEMA_FAILED');
        const errorPayload = errorEnvelope({
          code: 'VALIDATION_RESPONSE_SCHEMA_FAILED',
          message: 'Internal response failed schema validation',
          retryable: true,
          details: responseValidation.errors,
        }, { correlation_id: correlationId });
        return { statusCode: 500, payload: errorPayload };
      }

      if (isMutation) {
        try {
          recordMutationAudit(toolName, args, execution, actor, role, correlationId, idempotencyKey);
        } catch (auditErr) {
          telemetry.incrementError('AUDIT_LOG_WRITE_FAILED');
          logger.warn(`Failed to record MCP mutation audit event for ${toolName}: ${auditErr.message}`);
        }
      }

      if (idempotencyScope) {
        idempotencyStore.set(idempotencyScope, {
          statusCode: 200,
          payload: responseEnvelope,
          expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
        });
      }

      return { statusCode: 200, payload: responseEnvelope };
    };

    if (isMutation && idempotencyKey) {
      idempotencyScope = getIdempotencyScope(req, toolName, idempotencyKey);
      pruneExpiredIdempotency();
      const existing = idempotencyStore.get(idempotencyScope);
      if (existing) {
        const replayPayload = {
          ...existing.payload,
          metadata: {
            ...existing.payload.metadata,
            idempotency_key: idempotencyKey,
            idempotent_replay: true,
          },
        };
        telemetry.observeLatency(toolName, Date.now() - startedAt);
        writeJson(res, existing.statusCode, replayPayload, correlationId);
        return;
      }

      const inFlight = idempotencyInFlight;
      if (inFlight.has(idempotencyScope)) {
        const sharedResult = await inFlight.get(idempotencyScope);
        const replayPayload = {
          ...sharedResult.payload,
          metadata: {
            ...sharedResult.payload.metadata,
            idempotency_key: idempotencyKey,
            idempotent_replay: true,
          },
        };
        telemetry.observeLatency(toolName, Date.now() - startedAt);
        writeJson(res, sharedResult.statusCode, replayPayload, correlationId);
        return;
      }

      const promise = executeAndCacheResult();
      inFlight.set(idempotencyScope, promise);
      try {
        const sharedResult = await promise;
        const responsePayload = sharedResult.payload;
        telemetry.observeLatency(toolName, Date.now() - startedAt);
        writeJson(res, sharedResult.statusCode, responsePayload, correlationId);
        return;
      } finally {
        inFlight.delete(idempotencyScope);
      }
    }

    const executionResult = await executeAndCacheResult();
    telemetry.observeLatency(toolName, Date.now() - startedAt);
    writeJson(res, executionResult.statusCode, executionResult.payload, correlationId);
  } catch (err) {
    telemetry.incrementError('TOOL_CALL_ROUTE_ERROR');
    writeJson(res, 400, errorEnvelope({
      code: 'TOOL_CALL_ROUTE_ERROR',
      message: err.message || 'Failed to process tool call',
      retryable: false,
    }, { correlation_id: correlationId }), correlationId);
  }
}

function handleHealth(req, res) {
  const correlationId = readCorrelationId(req);
  const payload = okEnvelope({
    status: 'ok',
    deprecated: true,
    transport: 'loopback-http',
    version: 'v1',
    loaded_schemas: schemaRegistry.getLoadedSchemaIds(),
    telemetry: telemetry.snapshot(),
  }, { correlation_id: correlationId });
  writeJson(res, 200, payload, correlationId);
}

function handleTools(req, res) {
  const correlationId = readCorrelationId(req);
  const payload = okEnvelope({
    tools: listTools().filter((tool) => SUPPORTED_TOOL_NAMES.has(tool.name)),
  }, { correlation_id: correlationId });
  writeJson(res, 200, payload, correlationId);
}

async function handleValidate(req, res, toolName) {
  const correlationId = readCorrelationId(req);
  const start = Date.now();

  try {
    const body = await parseBody(req);
    telemetry.incrementToolCall('validate.request');

    const requestSchemaId = getSchemaId(toolName, 'request');
    const responseSchemaId = getSchemaId(toolName, 'response');

    const requestValidation = schemaRegistry.validate(requestSchemaId, body.request || {});
    const responseValidation = schemaRegistry.validate(responseSchemaId, body.response || {});

    const latencyMs = Date.now() - start;
    telemetry.observeLatency('validate.request', latencyMs);

    const payload = okEnvelope({
      tool: toolName,
      request_schema: requestSchemaId,
      response_schema: responseSchemaId,
      request: requestValidation,
      response: responseValidation,
    }, { correlation_id: correlationId });
    writeJson(res, 200, payload, correlationId);
  } catch (err) {
    telemetry.incrementError('VALIDATION_PAYLOAD_ERROR');
    const payload = errorEnvelope({
      code: 'VALIDATION_PAYLOAD_ERROR',
      message: err.message || 'Failed to validate payload',
      retryable: false,
    }, { correlation_id: correlationId });
    writeJson(res, 400, payload, correlationId);
  }
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch (_e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Malformed request URL' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    handleHealth(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/tools') {
    handleTools(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/tools/call') {
    await handleToolCallRoute(req, res, null);
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/call/')) {
    const toolName = decodeURIComponent(url.pathname.replace('/call/', '').trim());
    await handleToolCallRoute(req, res, toolName);
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/validate/')) {
    const toolName = decodeURIComponent(url.pathname.replace('/validate/', '').trim());
    await handleValidate(req, res, toolName);
    return;
  }

  const correlationId = readCorrelationId(req);
  writeJson(res, 404, errorEnvelope({
    code: 'NOT_FOUND',
    message: `Unknown route: ${req.method} ${url.pathname}`,
    retryable: false,
  }, { correlation_id: correlationId }), correlationId);
}

function start(options = {}) {
  return new Promise((resolve) => {
    if (server) {
      resolve({ success: true, port, message: 'Already running' });
      return;
    }

    port = options.port || 3459;
    schemaRegistry.loadSchemas();

  server = http.createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        const correlationId = readCorrelationId(req);
        telemetry.incrementError('INTERNAL_GATEWAY_ERROR');
        logger.error('Unhandled MCP gateway error', {
          message: err.message,
          stack: err.stack,
          correlationId,
        });

        writeJson(res, 500, errorEnvelope({
          code: 'INTERNAL_GATEWAY_ERROR',
          message: 'Internal MCP gateway error',
          retryable: true,
        }, { correlation_id: correlationId }), correlationId);
      });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`MCP gateway port already in use: ${port}`);
        process.stderr.write(
          `\nMCP gateway port ${port} is already in use.\n\n` +
          `Options:\n` +
          `  1. Stop existing TORQUE: bash stop-torque.sh\n` +
          `  2. Use different port: TORQUE_MCP_PORT=${port + 2} torque start\n` +
          `  3. Find what's using it: lsof -i :${port} (Linux/Mac) or netstat -ano | findstr :${port} (Windows)\n\n`
        );
        server = null;
        resolve({ success: false, error: 'Port in use', port });
        return;
      }

      logger.error('Failed to start MCP gateway', { message: err.message, stack: err.stack });
      server = null;
      resolve({ success: false, error: err.message, port });
    });

    server.listen(port, '127.0.0.1', () => {
      if (idempotencyCleanupInterval) {
        clearInterval(idempotencyCleanupInterval);
      }
      if (sessionCleanupInterval) {
        clearInterval(sessionCleanupInterval);
      }
      if (eventDataCleanupInterval) {
        clearInterval(eventDataCleanupInterval);
      }
      if (rateLimitCleanupInterval) {
        clearInterval(rateLimitCleanupInterval);
      }

      idempotencyCleanupInterval = setInterval(pruneExpiredIdempotency, 60 * 1000);
      sessionCleanupInterval = setInterval(cleanupStaleSessions, STALE_SESSION_POLL_INTERVAL_MS);
      eventDataCleanupInterval = setInterval(() => {
        try {
          cleanupEventData(EVENT_DATA_RETENTION_DAYS);
        } catch {
          // Non-fatal: retention cleanup should not prevent gateway operation.
        }
      }, EVENT_DATA_CLEANUP_INTERVAL_MS);
      rateLimitCleanupInterval = setInterval(pruneRateLimits, 60 * 1000);

      cleanupStaleSessions();
      try {
        cleanupEventData(EVENT_DATA_RETENTION_DAYS);
      } catch {
        // Non-fatal startup cleanup; continue serving.
      }
      pruneRateLimits();
      logger.info(`MCP gateway listening on http://127.0.0.1:${port}`);
      resolve({ success: true, port });
    });
  });
}

function stop() {
  if (!server) return;
  if (idempotencyCleanupInterval) {
    clearInterval(idempotencyCleanupInterval);
    idempotencyCleanupInterval = null;
  }
  if (sessionCleanupInterval) {
    clearInterval(sessionCleanupInterval);
    sessionCleanupInterval = null;
  }
  if (eventDataCleanupInterval) {
    clearInterval(eventDataCleanupInterval);
    eventDataCleanupInterval = null;
  }
  if (rateLimitCleanupInterval) {
    clearInterval(rateLimitCleanupInterval);
    rateLimitCleanupInterval = null;
  }
  rateLimitBuckets.clear();
  const activeServer = server;
  server = null;
  activeServer.close(() => {
    logger.info('MCP gateway stopped');
  });
}

/**
 * Alias for stop() — clears all three cleanup intervals
 * (idempotency, session, and rate-limit) started by start().
 * Exported separately so callers that only want timer teardown
 * (e.g. tests or a future partial-shutdown path) don't have to
 * close the HTTP server.
 */
function stopCleanupTimers() {
  if (idempotencyCleanupInterval) {
    clearInterval(idempotencyCleanupInterval);
    idempotencyCleanupInterval = null;
  }
  if (sessionCleanupInterval) {
    clearInterval(sessionCleanupInterval);
    sessionCleanupInterval = null;
  }
  if (eventDataCleanupInterval) {
    clearInterval(eventDataCleanupInterval);
    eventDataCleanupInterval = null;
  }
  if (rateLimitCleanupInterval) {
    clearInterval(rateLimitCleanupInterval);
    rateLimitCleanupInterval = null;
  }
}

module.exports = {
  start,
  stop,
  stopCleanupTimers,
  telemetry,
};
