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
  ...require('./tool-defs/hashline-defs'),
  ...require('./tool-defs/tsserver-defs'),
  ...require('./tool-defs/snapscope-defs'),
  ...require('./tool-defs/remote-agent-defs'),
  ...require('./tool-defs/policy-defs'),
  ...require('./tool-defs/conflict-resolution-defs'),
  ...require('./tool-defs/orchestrator-defs'),
  ...require('./tool-defs/experiment-defs'),
  ...require('./tool-defs/audit-defs'),
  ...require('./tool-defs/workstation-defs'),
  ...require('./tool-defs/concurrency-defs'),
  ...require('./tool-defs/model-defs'),
  ...require('./tool-defs/routing-template-defs'),
  ...require('./tool-defs/strategic-config-defs'),
  ...require('./tool-defs/auth-defs'),
];

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
  require('./handlers/snapscope-handlers'),
  require('./handlers/peek-handlers'),
  require('./handlers/remote-agent-handlers'),
  require('./handlers/policy-handlers'),
  require('./handlers/conflict-resolution-handlers'),
  require('./handlers/orchestrator-handlers'),
  require('./handlers/experiment-handlers'),
  require('./handlers/audit-handlers'),
  require('./handlers/workstation-handlers'),
  require('./handlers/concurrency-handlers'),
  require('./handlers/model-handlers'),
  require('./handlers/routing-template-handlers'),
  require('./handlers/strategic-config-handlers'),
  require('./handlers/auth-handlers'),
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
  'handleContinuousBatchSubmission', // workflow-runtime callback, not user-facing
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
  'wire_events_to_eventsystem',
  'wire_notifications_to_bridge',
  'wire_system_to_gamescene',
]);

const DEFAULT_FILE_WRITE_PATHS = {
  wire_events_to_eventsystem: (args) => {
    if (typeof args.file_path === 'string' && args.file_path.trim()) return [args.file_path.trim()];
    if (typeof args.working_directory !== 'string' || !args.working_directory.trim()) return [];
    return [path.join(args.working_directory.trim(), 'src', 'systems', 'EventSystem.ts')];
  },
  wire_notifications_to_bridge: (args) => {
    if (typeof args.file_path === 'string' && args.file_path.trim()) return [args.file_path.trim()];
    if (typeof args.working_directory !== 'string' || !args.working_directory.trim()) return [];
    return [path.join(args.working_directory.trim(), 'src', 'systems', 'NotificationBridge.ts')];
  },
  wire_system_to_gamescene: (args) => {
    if (typeof args.file_path === 'string' && args.file_path.trim()) return [args.file_path.trim()];
    if (typeof args.working_directory !== 'string' || !args.working_directory.trim()) return [];
    return [path.join(args.working_directory.trim(), 'src', 'scenes', 'GameScene.ts')];
  },
};

function isToolError(result) {
  return !!(result && typeof result === 'object' && result.isError === true);
}

function resolveWrittenFilePaths(toolName, args) {
  if (DEFAULT_FILE_WRITE_PATHS[toolName]) {
    return [...new Set(DEFAULT_FILE_WRITE_PATHS[toolName](args).filter(Boolean))];
  }

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

function handleRestartServer(args) {
  const reason = args.reason || 'Manual restart requested';
  // Use module-level logger (not a re-require) to avoid shadowing the top-level binding.
  const taskManager = require('./task-manager');
  const db = require('./database'); // Phase 3: migrate to container.js init(deps) pattern

  logger.info(`[Restart] Server restart requested: ${reason}`);

  const localRunning = taskManager.getRunningTaskCount();
  const allRunningTasks = db.listTasks({ status: 'running', limit: 1000 });
  const totalRunning = allRunningTasks.length;

  if (totalRunning > 0) {
    const siblingRunning = totalRunning - localRunning;
    let errorMsg = `Cannot restart: ${totalRunning} task(s) still running`;
    if (siblingRunning > 0) {
      errorMsg += ` (${localRunning} local, ${siblingRunning} from other sessions)`;
    }
    errorMsg += '. Cancel them first or wait for completion.';
    return {
      success: false,
      content: [{ type: 'text', text: errorMsg }],
      error: errorMsg,
      running_tasks: totalRunning,
      local_running: localRunning,
      sibling_running: siblingRunning
    };
  }

  // Return success to the caller BEFORE triggering shutdown. This is intentional:
  // the MCP response must be flushed to the client before the process exits.
  // The setTimeout gives the response time to be sent, then triggers shutdown.
  // Note: rapid consecutive restart calls will each schedule a shutdown timeout.
  // The torque:shutdown handler is idempotent (no-op on second call), so this is safe.

  // Spawn a replacement process BEFORE shutting down.
  // Write a restarter script to a temp file that waits for the old server
  // to release ports, then starts the new one with the correct env vars.
  const { spawn } = require('child_process');
  const fs_ = require('fs');
  const path_ = require('path');
  const serverScript = path_.resolve(__dirname, 'index.js');
  const dataDir = process.env.TORQUE_DATA_DIR || '';
  const restarterScript = path_.join(require('os').tmpdir(), `torque-restart-${process.pid}.js`);

  fs_.writeFileSync(restarterScript, `
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const env = Object.assign({}, process.env, ${dataDir ? `{ TORQUE_DATA_DIR: ${JSON.stringify(dataDir)} }` : '{}'});
function probe(cb) {
  const req = http.get('http://127.0.0.1:3458/sse', { timeout: 500 }, () => cb(true));
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}
let attempts = 0;
const check = setInterval(() => {
  attempts++;
  probe((alive) => {
    if (!alive || attempts > 20) {
      clearInterval(check);
      const child = spawn(process.execPath, [${JSON.stringify(serverScript)}], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.unref();
      try { fs.unlinkSync(${JSON.stringify(restarterScript)}); } catch {}
      process.exit(0);
    }
  });
}, 500);
`);

  const restarter = spawn(process.execPath, [restarterScript], {
    detached: true,
    stdio: 'ignore',
  });
  restarter.unref();
  logger.info(`[Restart] Spawned restarter process (PID ${restarter.pid})`);

  // Trigger full graceful shutdown via process event (avoids circular dependency with index.js)
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
    case 'ping':
      return { pong: true, timestamp: new Date().toISOString(), message: args.message || 'keepalive' };
    case 'restart_server':
      return handleRestartServer(args);
    case 'unlock_all_tools':
      return { __unlock_all_tools: true, content: [{ type: 'text', text: 'All TORQUE tools are now unlocked (Tier 3). The tools list has been refreshed.' }] };
    case 'unlock_tier': {
      const tier = parseInt(args.tier, 10);
      if (![1, 2, 3].includes(tier)) {
        return { content: [{ type: 'text', text: 'Invalid tier. Use 1 (core, ~25 tools), 2 (extended, ~78 tools), or 3 (all, ~488 tools).' }], isError: true };
      }
      const labels = { 1: 'core (~25 tools)', 2: 'extended (~78 tools)', 3: 'all (~488 tools)' };
      if (tier >= 3) {
        return { __unlock_all_tools: true, content: [{ type: 'text', text: `Unlocked Tier 3: ${labels[3]}. The tools list has been refreshed.` }] };
      }
      return { __unlock_tier: tier, content: [{ type: 'text', text: `Unlocked Tier ${tier}: ${labels[tier]}. The tools list has been refreshed.` }] };
    }
  }

  // Centralized JSON Schema validation (Phase 2)
  const schema = schemaMap.get(name);
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
  const handler = routeMap.get(name);
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

module.exports = {
  TOOLS,
  routeMap,
  schemaMap,
  handleToolCall,
  validateArgsAgainstSchema,
  INTERNAL_HANDLER_EXPORTS,
};
