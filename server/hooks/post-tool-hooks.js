'use strict';

const logger = require('../logger').child({ component: 'post-tool-hooks' });

const VALID_EVENT_TYPES = new Set(['file_write', 'task_complete', 'task_fail']);
const hooksByEventType = new Map();
const builtInHookFactories = new Map();

for (const eventType of VALID_EVENT_TYPES) {
  hooksByEventType.set(eventType, new Map());
}

function normalizeEventType(eventType) {
  if (typeof eventType !== 'string') return null;
  const normalized = eventType.trim().toLowerCase();
  return VALID_EVENT_TYPES.has(normalized) ? normalized : null;
}

function normalizeHookName(hookName) {
  if (typeof hookName !== 'string') return null;
  const normalized = hookName.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function assertValidEventType(eventType) {
  const normalized = normalizeEventType(eventType);
  if (!normalized) {
    throw new Error(`Unsupported hook event type: ${eventType}`);
  }
  return normalized;
}

function buildHookId(eventType, hookName) {
  return `${eventType}:${hookName}`;
}

function toHookSummary(hook) {
  return {
    id: hook.id,
    event_type: hook.eventType,
    hook_name: hook.name,
    built_in: hook.builtIn === true,
    description: hook.description || null,
  };
}

function listHooks(eventType = null) {
  if (eventType) {
    const normalized = assertValidEventType(eventType);
    return [...hooksByEventType.get(normalized).values()]
      .map(toHookSummary)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  const hooks = [];
  for (const eventTypeKey of VALID_EVENT_TYPES) {
    hooks.push(...listHooks(eventTypeKey));
  }
  return hooks;
}

function registerHook(eventType, callback, options = {}) {
  const normalizedEventType = assertValidEventType(eventType);
  if (typeof callback !== 'function') {
    throw new TypeError('callback must be a function');
  }

  const hookName = normalizeHookName(options.name) || `hook_${Date.now()}`;
  const hookId = typeof options.id === 'string' && options.id.trim().length > 0
    ? options.id.trim()
    : buildHookId(normalizedEventType, hookName);
  const registry = hooksByEventType.get(normalizedEventType);

  if (registry.has(hookId)) {
    return toHookSummary(registry.get(hookId));
  }

  const existingByName = [...registry.values()].find((hook) => hook.name === hookName);
  if (existingByName) {
    return toHookSummary(existingByName);
  }

  const hook = {
    id: hookId,
    eventType: normalizedEventType,
    name: hookName,
    callback,
    builtIn: options.builtIn === true,
    description: typeof options.description === 'string' ? options.description : null,
  };

  registry.set(hookId, hook);
  return toHookSummary(hook);
}

function removeHook(hookId) {
  if (typeof hookId !== 'string' || hookId.trim().length === 0) {
    return null;
  }

  const normalizedId = hookId.trim();
  for (const registry of hooksByEventType.values()) {
    const hook = registry.get(normalizedId);
    if (hook) {
      registry.delete(normalizedId);
      return toHookSummary(hook);
    }
  }

  return null;
}

function getDefaultHookName(eventType) {
  const normalized = assertValidEventType(eventType);
  if (normalized === 'file_write') return 'syntax_check';
  if (normalized === 'task_complete') return 'validate_task_output';
  return 'learn_failure_pattern';
}

function registerBuiltInHook(eventType, hookName = null) {
  const normalizedEventType = assertValidEventType(eventType);
  const normalizedHookName = normalizeHookName(hookName) || getDefaultHookName(normalizedEventType);
  const factory = builtInHookFactories.get(buildHookId(normalizedEventType, normalizedHookName));

  if (!factory) {
    throw new Error(`No built-in hook registered for ${normalizedEventType}:${normalizedHookName}`);
  }

  return registerHook(normalizedEventType, factory(), {
    id: buildHookId(normalizedEventType, normalizedHookName),
    name: normalizedHookName,
    builtIn: true,
    description: factory.description,
  });
}

async function fireHook(eventType, context = {}) {
  const normalizedEventType = assertValidEventType(eventType);
  const registry = hooksByEventType.get(normalizedEventType);
  const results = [];

  for (const hook of registry.values()) {
    try {
      const result = await hook.callback(context);
      results.push({
        hook_id: hook.id,
        hook_name: hook.name,
        ok: true,
        result,
      });
    } catch (err) {
      logger.info(`[Hook] ${hook.id} failed: ${err.message}`);
      results.push({
        hook_id: hook.id,
        hook_name: hook.name,
        ok: false,
        error: err.message || String(err),
      });
    }
  }

  return results;
}

function clearHooks() {
  for (const registry of hooksByEventType.values()) {
    registry.clear();
  }
}

function registerBuiltInHookFactory(eventType, hookName, factory, description) {
  const normalizedEventType = assertValidEventType(eventType);
  const normalizedHookName = normalizeHookName(hookName);
  if (!normalizedHookName) {
    throw new Error(`Invalid built-in hook name for ${normalizedEventType}`);
  }
  if (typeof factory !== 'function') {
    throw new TypeError('Built-in hook factory must be a function');
  }

  factory.description = description || null;
  builtInHookFactories.set(buildHookId(normalizedEventType, normalizedHookName), factory);
}

function registerDefaultHooks() {
  registerBuiltInHook('file_write', 'syntax_check');
  registerBuiltInHook('task_complete', 'validate_task_output');
  registerBuiltInHook('task_fail', 'learn_failure_pattern');
}

function resetHooksForTest() {
  clearHooks();
  registerDefaultHooks();
}

registerBuiltInHookFactory(
  'file_write',
  'syntax_check',
  () => async (context = {}) => {
    const filePath = typeof context.file_path === 'string' ? context.file_path : context.filePath;
    const workingDirectory = typeof context.working_directory === 'string'
      ? context.working_directory
      : context.workingDirectory;

    if (!filePath || !workingDirectory) {
      return {
        skipped: true,
        reason: 'file_path and working_directory are required',
      };
    }

    return require('../handlers/validation').handleRunSyntaxCheck({
      file_path: filePath,
      working_directory: workingDirectory,
    });
  },
  'Runs run_syntax_check on the modified file.'
);

registerBuiltInHookFactory(
  'task_complete',
  'validate_task_output',
  () => (context = {}) => {
    const taskId = typeof context.taskId === 'string'
      ? context.taskId
      : (typeof context.task_id === 'string' ? context.task_id : null);

    if (!taskId) {
      return {
        skipped: true,
        reason: 'taskId is required',
      };
    }

    return require('../handlers/validation').handleValidateTaskOutput({
      task_id: taskId,
    });
  },
  'Runs validate_task_output for the completed task.'
);

registerBuiltInHookFactory(
  'task_fail',
  'learn_failure_pattern',
  () => (context = {}) => {
    const taskId = typeof context.taskId === 'string'
      ? context.taskId
      : (typeof context.task_id === 'string' ? context.task_id : null);
    const errorText = typeof context.error === 'string'
      ? context.error
      : (typeof context.error_output === 'string' ? context.error_output : 'Task failed');

    if (!taskId) {
      return {
        skipped: true,
        reason: 'taskId is required',
      };
    }

    return require('../handlers/advanced/intelligence').handleLearnFailurePattern({
      task_id: taskId,
      name: `auto_failure_${taskId.slice(0, 8)}`,
      description: `Auto-learned from failed task output: ${errorText.slice(0, 160)}`,
    });
  },
  'Runs learn_failure_pattern for failed task output.'
);

registerDefaultHooks();

module.exports = {
  VALID_EVENT_TYPES,
  fireHook,
  getDefaultHookName,
  listHooks,
  registerBuiltInHook,
  registerHook,
  removeHook,
  resetHooksForTest,
};
