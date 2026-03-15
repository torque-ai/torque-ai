/**
 * Structured error codes for TORQUE handler responses.
 *
 * Provides machine-readable error_code fields alongside human-readable messages,
 * enabling programmatic error handling by MCP clients and dashboards.
 */

const ErrorCodes = {
  // Input validation
  MISSING_REQUIRED_PARAM: {
    code: 'MISSING_REQUIRED_PARAM',
    message: 'Missing required parameter',
    recovery: 'Check required arguments and their types in the tool schema. Use list_tools to confirm required fields.',
  },
  INVALID_PARAM: {
    code: 'INVALID_PARAM',
    message: 'Invalid parameter',
    recovery: 'Check parameter types and values. Use list_tools to see expected schema.',
  },
  PARAM_TOO_LONG: {
    code: 'PARAM_TOO_LONG',
    message: 'Parameter too long',
    recovery: 'Reduce the parameter length to match the documented limits. Check the tool schema for size constraints.',
  },

  // Resource errors
  TASK_NOT_FOUND: {
    code: 'TASK_NOT_FOUND',
    message: 'Task not found',
    recovery: 'Verify the task ID. Use list_tasks to see available tasks.',
  },
  HOST_NOT_FOUND: {
    code: 'HOST_NOT_FOUND',
    message: 'Host not found',
    recovery: 'Check host ID. Use list_ollama_hosts to see registered hosts.',
  },
  WORKFLOW_NOT_FOUND: {
    code: 'WORKFLOW_NOT_FOUND',
    message: 'Workflow not found',
    recovery: 'Verify the workflow ID. Use list_workflows to see available workflows.',
  },
  TEMPLATE_NOT_FOUND: {
    code: 'TEMPLATE_NOT_FOUND',
    message: 'Template not found',
    recovery: 'Verify the template ID or name. Use list_templates to find existing templates.',
  },
  AGENT_NOT_FOUND: {
    code: 'AGENT_NOT_FOUND',
    message: 'Agent not found',
    recovery: 'Verify the agent ID. Use list_agents to inspect active agents.',
  },
  RESOURCE_NOT_FOUND: {
    code: 'RESOURCE_NOT_FOUND',
    message: 'Resource not found',
    recovery: 'Check that the target ID is correct and still exists. Use relevant list_* tool to verify available resources.',
  },
  PIPELINE_NOT_FOUND: {
    code: 'PIPELINE_NOT_FOUND',
    message: 'Pipeline not found',
    recovery: 'Verify the pipeline ID. Use list_pipelines to inspect available pipelines.',
  },
  EXPERIMENT_NOT_FOUND: {
    code: 'EXPERIMENT_NOT_FOUND',
    message: 'Experiment not found',
    recovery: 'Verify the experiment ID. Use list_experiments to check currently active experiments.',
  },
  SUBSCRIPTION_NOT_FOUND: {
    code: 'SUBSCRIPTION_NOT_FOUND',
    message: 'Subscription not found',
    recovery: 'Verify the subscription ID. Use list_subscriptions to see active subscriptions.',
  },

  // State errors
  INVALID_STATUS_TRANSITION: {
    code: 'INVALID_STATUS_TRANSITION',
    message: 'Invalid status transition',
    recovery: 'Check current status first (for example with get_task) and request a valid transition only.',
  },
  TASK_ALREADY_RUNNING: {
    code: 'TASK_ALREADY_RUNNING',
    message: 'Task already running',
    recovery: 'Only one active execution is allowed. Check task status and either wait for completion or cancel the existing run.',
  },
  TASK_ALREADY_COMPLETED: {
    code: 'TASK_ALREADY_COMPLETED',
    message: 'Task already completed',
    recovery: 'This task cannot be rerun directly. Create a new task or use retry_task if supported.',
  },
  CONFLICT: {
    code: 'CONFLICT',
    message: 'Conflict',
    recovery: 'Retry after resolving the conflicting state or use a fresh identifier/retry token.',
  },

  // Capacity errors
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    message: 'Rate limited',
    recovery: 'Too many requests. Wait briefly and retry, or review rate_limit_config.',
  },
  BUDGET_EXCEEDED: {
    code: 'BUDGET_EXCEEDED',
    message: 'Budget exceeded',
    recovery: 'Current spending exceeds budget. Use get_budget_status to check, or increase budget with set_budget.',
  },
  AT_CAPACITY: {
    code: 'AT_CAPACITY',
    message: 'At capacity',
    recovery: 'Increase capacity or reduce concurrent work. Check active load and scale workers/hosts if possible.',
  },
  NO_HOSTS_AVAILABLE: {
    code: 'NO_HOSTS_AVAILABLE',
    message: 'No hosts available',
    recovery: 'Register and enable at least one host. Use list_ollama_hosts and check host health.',
  },

  // Security errors
  INVALID_URL: {
    code: 'INVALID_URL',
    message: 'Invalid URL',
    recovery: 'Validate URL format and protocol. For providers, run check_provider_status to confirm endpoints.',
  },
  PATH_TRAVERSAL: {
    code: 'PATH_TRAVERSAL',
    message: 'Path traversal',
    recovery: 'Use canonical, safe file paths within allowed directories only.',
  },
  SSRF_BLOCKED: {
    code: 'SSRF_BLOCKED',
    message: 'SSRF blocked',
    recovery: 'Use a safe allowlisted URL and avoid private/internal hostnames.',
  },
  UNSAFE_REGEX: {
    code: 'UNSAFE_REGEX',
    message: 'Unsafe regex',
    recovery: 'Simplify the regular expression and avoid nested quantifiers or unbounded patterns.',
  },

  // System errors
  DATABASE_ERROR: {
    code: 'DATABASE_ERROR',
    message: 'Database error',
    recovery: 'Internal database error. Try again. If persistent, check server logs and disk space.',
  },
  PROVIDER_ERROR: {
    code: 'PROVIDER_ERROR',
    message: 'Provider error',
    recovery: 'The execution provider is not responding. Check provider status with check_provider_status or try a different provider.',
  },
  TIMEOUT: {
    code: 'TIMEOUT',
    message: 'Timeout',
    recovery: 'Retry with a longer timeout or retry during lower load.',
  },
  OPERATION_FAILED: {
    code: 'OPERATION_FAILED',
    message: 'Operation failed',
    recovery: 'Check server logs for context and retry. If the failure repeats, verify upstream prerequisites and permissions.',
  },
  // Backward-compatible and commonly surfaced aliases
  DB_ERROR: {
    code: 'DB_ERROR',
    message: 'Database error',
    recovery: 'Internal database error. Try again. If persistent, check server logs and disk space.',
  },
  PROVIDER_UNAVAILABLE: {
    code: 'PROVIDER_UNAVAILABLE',
    message: 'Provider unavailable',
    recovery: 'The execution provider is not responding. Check provider status with check_provider_status or try a different provider.',
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    message: 'Internal error',
    recovery: 'Unexpected server failure. Check server logs and retry. If it continues, contact support with the task ID and timestamp.',
  },
};

/**
 * Build a structured MCP error response with an error_code field.
 *
 * @param {object|string} errorCode  - One of the ErrorCodes objects or its code string.
 * @param {string} [detail] - Human-readable error description.
 * @param {*} [details]  - Optional extra context (serialised as JSON).
 * @returns {{ content: Array, isError: boolean, error_code: string }}
 */
function makeError(errorCode, detail, details = null) {
  const fallback = { code: 'UNKNOWN_ERROR', message: 'Unknown error', recovery: null };
  const resolvedCode = typeof errorCode === 'string'
    ? { code: errorCode, message: errorCode, recovery: null }
    : {
        code: errorCode?.code || fallback.code,
        message: errorCode?.message || fallback.message,
        recovery: errorCode?.recovery || null,
      };

  const message = detail || resolvedCode.message;
  let text = `${resolvedCode.code}: ${message}`;

  if (resolvedCode.recovery) {
    text += `\nRecovery: ${resolvedCode.recovery}`;
  }

  if (details) {
    text += `\n\nDetails: ${JSON.stringify(details)}`;
  }

  return {
    content: [{ type: 'text', text }],
    isError: true,
    error_code: resolvedCode.code,
  };
}

module.exports = { ErrorCodes, makeError };
