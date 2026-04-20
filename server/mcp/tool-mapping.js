'use strict';

// ===================================================================
// Tool Mapping & Validation — extracted from mcp/index.js
// ===================================================================
//
// Pure-data functions that translate v1 namespaced tool names
// (torque.task.submit, torque.workflow.create, ...) into internal
// tool calls, and validate argument semantics before dispatch.
// ===================================================================

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePolicyKey(rawKey) {
  if (rawKey === undefined || rawKey === null) return null;
  const value = String(rawKey).trim();
  return value.length > 0 ? value : null;
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

// ---------------------------------------------------------------------------
// mapTaskToolCall — translate v1 namespaced tool name to internal tool + args
// ---------------------------------------------------------------------------

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

    case 'torque.workflow.reopen':
      return {
        tool: 'reopen_workflow',
        args: {
          workflow_id: payload.workflow_id,
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

// ---------------------------------------------------------------------------
// validateToolArgumentsSemantics — semantic validation for v1 tool arguments
// ---------------------------------------------------------------------------

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

module.exports = {
  STREAM_EVENT_TYPES,
  normalizePolicyKey,
  normalizeEventTypes,
  mapTaskToolCall,
  validateToolArgumentsSemantics,
};
