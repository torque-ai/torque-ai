/**
 * MCP Tools definitions and handlers for TORQUE
 *
 * Tool definitions live in ./tool-defs/ (one file per handler module).
 * Handler implementations live in ./handlers/ modules.
 * Dispatch is auto-built from handler exports via pascalToSnake mapping.
 */

const path = require('path');
const logger = require('./logger').child({ component: 'tools' });
const { fireHook } = require('./hooks/post-tool-hooks');
const eventBus = require('./event-bus');
const comparisonHandlers = require('./handlers/comparison-handler');
const evidenceRiskHandlers = require('./handlers/evidence-risk-handlers');
const governanceHandlers = require('./handlers/governance-handlers');
const reviewHandlers = require('./handlers/review-handler');
const symbolIndexerHandlers = require('./handlers/symbol-indexer-handlers');
const templateHandlers = require('./handlers/template-handlers');
const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('./core-tools');
const competitiveFeatureDefs = require('./tool-defs/competitive-feature-defs');

let _remoteAgentPluginDefs = null;
let _remoteAgentPluginHandlers = null;

// ── Tool definitions (JSON schemas) ──
const TOOLS = [
  ...require('./tool-defs/core-defs'),
  ...require('./tool-defs/task-submission-defs'),
  ...require('./tool-defs/task-management-defs'),
  ...require('./tool-defs/task-defs'),
  ...require('./tool-defs/workflow-defs'),
  ...require('./tool-defs/baseline-defs'),
  ...require('./tool-defs/approval-defs'),
  ...require('./tool-defs/validation-defs'),
  ...require('./tool-defs/provider-defs'),
  ...require('./tool-defs/provider-crud-defs'),
  ...require('./tool-defs/ci-defs'),
  ...require('./tool-defs/webhook-defs'),
  ...require('./tool-defs/intelligence-defs'),
  ...require('./tool-defs/advanced-defs'),
  ...require('./tool-defs/integration-defs'),
  ...require('./tool-defs/automation-defs'),
  ...require('./tool-defs/comparison-defs'),
  ...require('./tool-defs/hashline-defs'),
  ...require('./tool-defs/tsserver-defs'),
  ...require('./tool-defs/policy-defs'),
  ...require('./tool-defs/governance-defs'),
  ...require('./tool-defs/evidence-risk-defs'),
  ...require('./tool-defs/conflict-resolution-defs'),
  ...require('./tool-defs/orchestrator-defs'),
  ...require('./tool-defs/experiment-defs'),
  ...require('./tool-defs/audit-defs'),
  ...require('./tool-defs/workstation-defs'),
  ...require('./tool-defs/concurrency-defs'),
  ...require('./tool-defs/model-defs'),
  ...require('./tool-defs/discovery-defs'),
  ...require('./tool-defs/agent-discovery-defs'),
  ...require('./tool-defs/circuit-breaker-defs'),
  ...require('./tool-defs/budget-watcher-defs'),
  ...require('./tool-defs/provider-scoring-defs'),
  ...require('./tool-defs/routing-template-defs'),
  ...require('./tool-defs/strategic-config-defs'),
  ...require('./tool-defs/context-defs'),
  ...require('./tool-defs/codebase-study-defs'),
  ...competitiveFeatureDefs,
  ...require('./tool-defs/review-defs'),
  ...require('./tool-defs/symbol-indexer-defs'),
  ...require('./tool-defs/template-defs'),
  ...require('./tool-defs/diffusion-defs'),
];

// ── Merge MCP tool annotations (Phase: MCP ecosystem improvements) ──
const { getAnnotations, validateCoverage } = require('./tool-annotations');

for (const tool of TOOLS) {
  if (tool && tool.name) {
    tool.annotations = getAnnotations(tool.name);
  }
}

// Startup validator: warn on uncovered tools and stale overrides
const _allToolNames = TOOLS.filter(t => t && t.name).map(t => t.name);
const _coverage = validateCoverage(_allToolNames);
if (_coverage.uncovered.length > 0) {
  logger.warn(`[tool-annotations] ${_coverage.uncovered.length} tool(s) have no annotation coverage (fallback used): ${_coverage.uncovered.join(', ')}`);
}
if (_coverage.stale.length > 0) {
  logger.warn(`[tool-annotations] ${_coverage.stale.length} stale override(s) reference nonexistent tools: ${_coverage.stale.join(', ')}`);
}

// ── Merge MCP output schemas (Phase: structured tool outputs) ──
const { getOutputSchema, validateSchemaCoverage } = require('./tool-output-schemas');

for (const tool of TOOLS) {
  if (tool && tool.name) {
    const schema = getOutputSchema(tool.name);
    if (schema) tool.outputSchema = schema;
  }
}

// Startup validator: warn on stale schemas
const _schemaCoverage = validateSchemaCoverage(_allToolNames);
if (_schemaCoverage.stale.length > 0) {
  logger.warn(`[tool-output-schemas] ${_schemaCoverage.stale.length} stale schema(s) reference nonexistent tools: ${_schemaCoverage.stale.join(', ')}`);
}

const TOOL_TIER_LABELS = {
  1: `core (~${CORE_TOOL_NAMES.length} tools)`,
  2: `extended (~${EXTENDED_TOOL_NAMES.length} tools)`,
  3: `all (~${TOOLS.length} tools)`,
};

// ── Handler modules ──
const HANDLER_MODULES = [
  require('./handlers/task'),
  require('./handlers/workflow'),
  require('./handlers/validation'),
  require('./handlers/provider-handlers'),
  require('./handlers/provider-crud-handlers'),
  require('./handlers/ci-handlers'),
  require('./handlers/webhook-handlers'),
  require('./handlers/inbound-webhook-handlers'),
  require('./handlers/advanced'),
  require('./handlers/integration'),
  require('./handlers/automation-handlers'),
  require('./handlers/hashline-handlers'),
  require('./handlers/tsserver-handlers'),
  require('./handlers/policy-handlers'),
  require('./handlers/conflict-resolution-handlers'),
  require('./handlers/evidence-risk-handlers'),
  require('./handlers/orchestrator-handlers'),
  require('./handlers/experiment-handlers'),
  require('./handlers/competitive-feature-handlers'),
  require('./handlers/audit-handlers'),
  require('./handlers/workstation-handlers'),
  require('./handlers/concurrency-handlers'),
  require('./handlers/model-handlers'),
  require('./handlers/discovery-handlers'),
  require('./handlers/agent-discovery-handlers'),
  require('./handlers/circuit-breaker-handlers'),
  require('./handlers/model-registry-handlers'),
  require('./handlers/routing-template-handlers'),
  require('./handlers/strategic-config-handlers'),
  require('./handlers/context-handler'),
  require('./handlers/budget-handlers'),
  require('./handlers/provider-scoring-handlers'),
  require('./handlers/diffusion-handlers'),
  require('./handlers/codebase-study-handlers'),
  evidenceRiskHandlers,
  reviewHandlers,
];

// ── Schema lookup map (tool name → inputSchema) ──
const schemaMap = new Map();
for (const def of TOOLS) {
  if (def && def.name && def.inputSchema) {
    schemaMap.set(def.name, def.inputSchema);
  }
}

// ── Centralized JSON Schema validation ──

/**
 * Validate args against a JSON Schema inputSchema.
 * Returns null if valid, or an error object { message, details[] } if invalid.
 *
 * Strict for `required` fields (missing → error).
 * Strict for `type` checks on present fields (wrong type → error).
 * Validates `enum` constraints on present fields.
 */
function validateArgsAgainstSchema(args, schema) {
  if (!schema || schema.type !== 'object') return null;

  const errors = [];
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  // Check required fields
  for (const field of required) {
    if (args[field] === undefined || args[field] === null) {
      const propDef = properties[field];
      const desc = propDef && propDef.description ? ` (${propDef.description})` : '';
      errors.push(`Missing required parameter: "${field}"${desc}`);
    }
  }

  // Check type and enum constraints on present fields
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith('__')) continue; // skip internal context fields
    const propDef = properties[key];
    if (!propDef) continue; // extra fields are allowed (no additionalProperties enforcement)

    if (value === undefined || value === null) continue;

    // Type checking
    if (propDef.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      let typeValid = false;

      switch (propDef.type) {
        case 'string':
          typeValid = actualType === 'string';
          break;
        case 'number':
        case 'integer':
          typeValid = actualType === 'number' && !Number.isNaN(value);
          break;
        case 'boolean':
          typeValid = actualType === 'boolean';
          break;
        case 'array':
          typeValid = actualType === 'array';
          break;
        case 'object':
          typeValid = actualType === 'object';
          break;
        default:
          typeValid = true; // unknown type — skip
      }

      if (!typeValid) {
        errors.push(`Parameter "${key}" must be of type ${propDef.type}, got ${actualType}`);
      }
    }

    // Enum checking
    if (propDef.enum && Array.isArray(propDef.enum)) {
      if (!propDef.enum.includes(value)) {
        errors.push(`Parameter "${key}" must be one of [${propDef.enum.join(', ')}], got "${value}"`);
      }
    }
  }

  if (errors.length === 0) return null;

  return {
    message: `Validation failed for ${errors.length} parameter(s)`,
    details: errors,
  };
}

// ── Auto-build dispatch map from handler exports ──

function pascalToSnake(s) {
  return s.replace(/([A-Z])/g, (m, c, i) => (i > 0 ? '_' : '') + c.toLowerCase());
}

// Fixups for acronyms/proper nouns that pascalToSnake mis-converts
const FIXUPS = {
  'export_report_c_s_v': 'export_report_csv',
  'export_report_j_s_o_n': 'export_report_json',
};

// Exported handle* functions that are internal callbacks, not MCP tools.
// These get auto-discovered by the pascalToSnake loop but should be excluded.
const INTERNAL_HANDLER_EXPORTS = new Set([
]);

const routeMap = new Map();

for (const mod of HANDLER_MODULES) {
  for (const [fnName, fn] of Object.entries(mod)) {
    if (!fnName.startsWith('handle') || typeof fn !== 'function') continue;
    if (INTERNAL_HANDLER_EXPORTS.has(fnName)) continue;
    let toolName = pascalToSnake(fnName.slice(6));
    toolName = FIXUPS[toolName] || toolName;
    if (routeMap.has(toolName)) {
      logger.warn(`[tools] routeMap collision: "${toolName}" — overwriting previous handler`);
    }
    routeMap.set(toolName, fn);
  }
}

routeMap.set('get_adversarial_reviews', evidenceRiskHandlers.handleGetAdversarialReviews);
routeMap.set('request_adversarial_review', evidenceRiskHandlers.handleRequestAdversarialReview);
routeMap.set('compare_providers', comparisonHandlers.handleCompareProviders);
routeMap.set('search_symbols', symbolIndexerHandlers.handleSearchSymbols);
routeMap.set('get_file_outline', symbolIndexerHandlers.handleGetFileOutline);
routeMap.set('index_project', symbolIndexerHandlers.handleIndexProject);
routeMap.set('get_project_template', templateHandlers.handleGetProjectTemplate);
routeMap.set('list_project_templates', templateHandlers.handleListTemplates);
routeMap.set('detect_project_type', templateHandlers.handleDetectProjectType);
routeMap.set('get_governance_rules', governanceHandlers.handleGetGovernanceRules);
routeMap.set('set_governance_rule_mode', governanceHandlers.handleSetGovernanceRuleMode);
routeMap.set('toggle_governance_rule', governanceHandlers.handleToggleGovernanceRule);

function getRemoteAgentPluginDefs() {
  if (!_remoteAgentPluginDefs) {
    _remoteAgentPluginDefs = require('./plugins/remote-agents/tool-defs');
  }
  return _remoteAgentPluginDefs;
}

function getRemoteAgentPluginHandlers() {
  if (_remoteAgentPluginHandlers) {
    return _remoteAgentPluginHandlers;
  }

  const { getInstalledRegistry } = require('./plugins/remote-agents');
  const agentRegistry = getInstalledRegistry();
  if (!agentRegistry) return null;

  let database;
  try {
    const { defaultContainer } = require('./container');
    database = defaultContainer.get('db');
  } catch {
    database = require('./database');
  }
  const { createHandlers } = require('./plugins/remote-agents/handlers');

  _remoteAgentPluginHandlers = createHandlers({
    agentRegistry,
    db: database,
  });
  return _remoteAgentPluginHandlers;
}

function getPluginToolDef(toolName) {
  return getRemoteAgentPluginDefs().find((tool) => tool && tool.name === toolName) || null;
}

function getPluginToolHandler(toolName) {
  if (!getPluginToolDef(toolName)) {
    return null;
  }

  const handlers = getRemoteAgentPluginHandlers();
  return handlers && typeof handlers[toolName] === 'function'
    ? handlers[toolName]
    : null;
}

const FILE_WRITE_TOOL_NAMES = new Set([
  'add_import_statement',
  'add_ts_enum_members',
  'add_ts_interface_members',
  'add_ts_method_to_class',
  'add_ts_union_members',
  'hashline_edit',
  'inject_class_dependency',
  'inject_method_calls',
  'normalize_interface_formatting',
  'replace_ts_method_body',
]);

function isToolError(result) {
  return !!(result && typeof result === 'object' && result.isError === true);
}

function resolveWrittenFilePaths(toolName, args) {
  const filePaths = [];
  if (typeof args.file_path === 'string' && args.file_path.trim()) {
    filePaths.push(args.file_path.trim());
  }
  if (Array.isArray(args.file_paths)) {
    for (const filePath of args.file_paths) {
      if (typeof filePath === 'string' && filePath.trim()) {
        filePaths.push(filePath.trim());
      }
    }
  }
  return [...new Set(filePaths)];
}

function readTaskExecutionContextFromEnv() {
  const taskId = typeof process.env.TORQUE_TASK_ID === 'string' && process.env.TORQUE_TASK_ID.trim()
    ? process.env.TORQUE_TASK_ID.trim()
    : null;
  if (!taskId) {
    return null;
  }

  return {
    __taskId: taskId,
    __workflowId: typeof process.env.TORQUE_WORKFLOW_ID === 'string' && process.env.TORQUE_WORKFLOW_ID.trim()
      ? process.env.TORQUE_WORKFLOW_ID.trim()
      : null,
    __workflowNodeId: typeof process.env.TORQUE_WORKFLOW_NODE_ID === 'string' && process.env.TORQUE_WORKFLOW_NODE_ID.trim()
      ? process.env.TORQUE_WORKFLOW_NODE_ID.trim()
      : null,
  };
}

function applyTaskExecutionContext(args) {
  const envContext = readTaskExecutionContextFromEnv();
  if (!envContext) {
    return args || {};
  }

  const normalizedArgs = (args && typeof args === 'object' && !Array.isArray(args))
    ? { ...args }
    : {};
  if (!normalizedArgs.__taskId) {
    normalizedArgs.__taskId = envContext.__taskId;
  }
  if (!normalizedArgs.__workflowId && envContext.__workflowId) {
    normalizedArgs.__workflowId = envContext.__workflowId;
  }
  if (!normalizedArgs.__workflowNodeId && envContext.__workflowNodeId) {
    normalizedArgs.__workflowNodeId = envContext.__workflowNodeId;
  }
  return normalizedArgs;
}

function resolveHookWorkingDirectory(args, filePath) {
  if (typeof args.working_directory === 'string' && args.working_directory.trim()) {
    return args.working_directory.trim();
  }

  if (typeof filePath === 'string' && path.isAbsolute(filePath)) {
    return path.dirname(filePath);
  }

  return null;
}

async function maybeFireFileWriteHooks(toolName, args, result) {
  if (!FILE_WRITE_TOOL_NAMES.has(toolName) || isToolError(result)) {
    return;
  }

  const filePaths = resolveWrittenFilePaths(toolName, args || {});
  for (const filePath of filePaths) {
    const workingDirectory = resolveHookWorkingDirectory(args || {}, filePath);
    if (!workingDirectory) continue;

    try {
      await fireHook('file_write', {
        tool_name: toolName,
        file_path: filePath,
        working_directory: workingDirectory,
        args,
        result,
      });
    } catch (hookErr) {
      logger.info(`[Hooks] file_write hook failed after ${toolName}: ${hookErr.message}`);
    }
  }
}

// ── Inline handlers (server-level, not delegated) ──

const RESTART_RESPONSE_GRACE_MS = 1500;

async function handleRestartServer(args) {
  const reason = args.reason || 'Manual restart requested';
  const drain = args.drain === true;
  const drainTimeoutMinutes = args.drain_timeout_minutes || 10;
  const taskManager = require('./task-manager');
  const taskCore = require('./db/task-core');

  logger.info(`[Restart] Server restart requested: ${reason}${drain ? ' (drain mode)' : ''}`);

  // Count the FULL pipeline — not just running tasks.
  // A restart is only safe when nothing is in-flight or waiting to execute.
  const localRunning = taskManager.getRunningTaskCount();
  const allRunningTasks = taskCore.listTasks({ status: 'running', limit: 1000 });
  const allQueuedTasks = taskCore.listTasks({ status: 'queued', limit: 1000 });

  // Governance: block force-restart when tasks are running
  if (!drain && (allRunningTasks.length > 0 || allQueuedTasks.length > 0)) {
    try {
      const { createGovernanceHooks } = require('./governance/hooks');
      const governanceRules = require('./db/governance-rules');
      const governance = createGovernanceHooks({ governanceRules, logger });
      const result = await governance.evaluate('server_restart', {}, {
        force: true,
        running: allRunningTasks.length,
        queued: allQueuedTasks.length,
      });
      if (result.blocked && result.blocked.length > 0) {
        const msg = result.blocked.map(b => b.message).join('; ');
        logger.warn(`[Restart] Governance blocked: ${msg}`);
        return {
          success: false,
          content: [{ type: 'text', text: `Governance blocked: ${msg}\n\nUse await_restart to drain the pipeline safely.` }],
        };
      }
    } catch (govErr) {
      logger.debug(`[Restart] Governance check failed (non-fatal): ${govErr.message}`);
    }
  }
  const allPendingTasks = taskCore.listTasks({ status: 'pending', limit: 1000 });
  const allBlockedRaw = taskCore.listTasks({ status: 'blocked', limit: 1000 });
  // Filter out orphaned blocked tasks whose workflows no longer exist or aren't running
  const workflowEngine = require('./db/workflow-engine');
  const allBlockedTasks = allBlockedRaw.filter(t => {
    if (!t.workflow_id) return true;
    try {
      const wf = workflowEngine.getWorkflow(t.workflow_id);
      return wf && wf.status === 'running';
    } catch { return true; }
  });
  const totalRunning = allRunningTasks.length;
  const totalQueued = allQueuedTasks.length;
  const totalPending = allPendingTasks.length;
  const totalBlocked = allBlockedTasks.length;
  const totalActive = totalRunning + totalQueued + totalPending + totalBlocked;

  if (totalActive > 0 && !drain) {
    const parts = [];
    if (totalRunning > 0) parts.push(`${totalRunning} running`);
    if (totalQueued > 0) parts.push(`${totalQueued} queued`);
    if (totalPending > 0) parts.push(`${totalPending} pending`);
    if (totalBlocked > 0) parts.push(`${totalBlocked} blocked`);
    let errorMsg = `Cannot restart: pipeline is not empty (${parts.join(', ')})`;
    errorMsg += '. Cancel them first, wait for completion, or use drain: true to wait for the full pipeline.';
    return {
      success: false,
      content: [{ type: 'text', text: errorMsg }],
      error: errorMsg,
      running_tasks: totalRunning,
      queued_tasks: totalQueued,
      pending_tasks: totalPending,
      blocked_tasks: totalBlocked,
    };
  }

  if (totalActive > 0 && drain) {
    logger.info(`[Restart] Drain mode: waiting for full pipeline to empty — ${totalRunning} running, ${totalQueued} queued, ${totalPending} pending, ${totalBlocked} blocked (timeout: ${drainTimeoutMinutes}min)`);

    const drainTimeoutMs = drainTimeoutMinutes * 60 * 1000;
    const drainStarted = Date.now();
    const DRAIN_POLL_INTERVAL = 10000;

    const drainPoll = setInterval(() => {
      const running = taskCore.listTasks({ status: 'running', limit: 1000 }).length;
      const queued = taskCore.listTasks({ status: 'queued', limit: 1000 }).length;
      const pending = taskCore.listTasks({ status: 'pending', limit: 1000 }).length;
      const blockedRaw = taskCore.listTasks({ status: 'blocked', limit: 1000 });
      const blocked = blockedRaw.filter(t => {
        if (!t.workflow_id) return true;
        try { const wf = workflowEngine.getWorkflow(t.workflow_id); return wf && wf.status === 'running'; } catch { return true; }
      }).length;
      const remaining = running + queued + pending + blocked;

      if (remaining === 0) {
        clearInterval(drainPoll);
        logger.info('[Restart] Drain complete — full pipeline empty. Restarting...');
        process._torqueRestartPending = true;
        eventBus.emitShutdown(`restart (drain complete): ${reason}`);
        return;
      }

      const elapsed = Date.now() - drainStarted;
      if (elapsed >= drainTimeoutMs) {
        clearInterval(drainPoll);
        logger.info(`[Restart] Drain timeout after ${drainTimeoutMinutes}min — ${remaining} task(s) still in pipeline. Aborting restart.`);
        return;
      }

      logger.info(`[Restart] Drain: ${running} running, ${queued} queued, ${pending} pending, ${blocked} blocked (${Math.round(elapsed / 1000)}s elapsed)`);
    }, DRAIN_POLL_INTERVAL);

    return {
      success: true,
      status: 'drain_started',
      content: [{ type: 'text', text: `Pipeline drain started — waiting for ${totalActive} task(s) to complete (${totalRunning} running, ${totalQueued} queued, ${totalPending} pending, ${totalBlocked} blocked). Timeout: ${drainTimeoutMinutes}min. Server will restart automatically when pipeline is empty.` }],
      running_tasks: totalRunning,
      queued_tasks: totalQueued,
      pending_tasks: totalPending,
      blocked_tasks: totalBlocked,
      drain_timeout_minutes: drainTimeoutMinutes,
    };
  }

  process._torqueRestartPending = true;
  logger.info(`[Restart] Restart flag set — server will respawn after shutdown`);

  setTimeout(() => {
    logger.info(`[Restart] Triggering graceful shutdown (reason: ${reason}). MCP client will auto-reconnect.`);
    eventBus.emitShutdown(`restart: ${reason}`);
  }, RESTART_RESPONSE_GRACE_MS);

  return {
    success: true,
    status: 'restart_scheduled',
    message: `Server restart scheduled in ${RESTART_RESPONSE_GRACE_MS}ms. MCP client should reconnect with fresh code.`,
    content: [{
      type: 'text',
      text: `Server restart scheduled in ${RESTART_RESPONSE_GRACE_MS}ms. MCP client should reconnect with fresh code.`
    }],
    reason
  };
}

// ── Main dispatch ──

async function handleToolCall(name, args) {
  // Inline handlers (server-level)
  switch (name) {
    case 'ping': {
      const pingData = { pong: true, timestamp: new Date().toISOString(), message: args.message || 'keepalive' };
      return { content: [{ type: 'text', text: JSON.stringify(pingData) }] };
    }
    case 'restart_server':
      return handleRestartServer(args);
    case 'unlock_all_tools':
      return { __unlock_all_tools: true, content: [{ type: 'text', text: 'All TORQUE tools are now unlocked (Tier 3). The tools list has been refreshed.' }] };
    case 'get_tool_schema': {
      const toolName = args.tool_name;
      if (!toolName) return { content: [{ type: 'text', text: 'tool_name is required' }], isError: true };
      const match = TOOLS.find(t => t.name === toolName) || getPluginToolDef(toolName);
      if (!match) return { content: [{ type: 'text', text: `Tool not found: ${toolName}` }], isError: true };
      return {
        content: [{ type: 'text', text: JSON.stringify({ name: match.name, description: match.description, inputSchema: match.inputSchema }, null, 2) }],
        structuredData: { name: match.name, description: match.description, inputSchema: match.inputSchema },
      };
    }
    case 'unlock_tier': {
      const tier = parseInt(args.tier, 10);
      if (![1, 2, 3].includes(tier)) {
        return { content: [{ type: 'text', text: `Invalid tier. Use 1 (${TOOL_TIER_LABELS[1]}), 2 (${TOOL_TIER_LABELS[2]}), or 3 (${TOOL_TIER_LABELS[3]}).` }], isError: true };
      }
      if (tier >= 3) {
        return { __unlock_all_tools: true, content: [{ type: 'text', text: `Unlocked Tier 3: ${TOOL_TIER_LABELS[3]}. The tools list has been refreshed.` }] };
      }
      return { __unlock_tier: tier, content: [{ type: 'text', text: `Unlocked Tier ${tier}: ${TOOL_TIER_LABELS[tier]}. The tools list has been refreshed.` }] };
    }
  }

  // Centralized JSON Schema validation (Phase 2)
  const schema = schemaMap.get(name) || getPluginToolDef(name)?.inputSchema;
  if (schema) {
    const validationError = validateArgsAgainstSchema(args || {}, schema);
    if (validationError) {
      return {
        content: [{
          type: 'text',
          text: `${validationError.message}:\n${validationError.details.map(d => `  - ${d}`).join('\n')}`,
        }],
        isError: true,
      };
    }
  }

  // Centralized file_path traversal guard for all tool handlers
  if (args.file_path && typeof args.file_path === 'string') {
    const { isPathTraversalSafe } = require('./handlers/shared');
    if (!isPathTraversalSafe(args.file_path)) {
      return { content: [{ type: 'text', text: 'File path rejected: potential path traversal' }], isError: true };
    }
  }

  // Auto-routed handlers
  const handler = routeMap.get(name) || getPluginToolHandler(name);
  if (handler) {
    const effectiveArgs = applyTaskExecutionContext(args);
    const result = await handler(effectiveArgs);
    await maybeFireFileWriteHooks(name, effectiveArgs, result);
    return result;
  }

  // Throw a proper Error (not a plain object) so the stack trace is preserved.
  // Sanitize the tool name in the message to prevent log injection.
  const safeName = String(name || '').replace(/[\r\n\t]/g, '_').slice(0, 128);
  const err = new Error(`Unknown tool: ${safeName}`);
  err.code = -32602;
  throw err;
}

// ── Factory (DI Phase 3) ─────────────────────────────────────────────────

function createTools(_deps) {
  // deps reserved for Phase 5 when database.js facade is removed
  return { TOOLS, routeMap, schemaMap, handleToolCall, validateArgsAgainstSchema, INTERNAL_HANDLER_EXPORTS };
}

module.exports = {
  TOOLS,
  routeMap,
  schemaMap,
  handleToolCall,
  validateArgsAgainstSchema,
  INTERNAL_HANDLER_EXPORTS,
  createTools,
};
