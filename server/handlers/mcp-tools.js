'use strict';

const { randomUUID } = require('crypto');
const vm = require('vm');
const { defaultContainer } = require('../container');
const { createAction } = require('../actions/action');
const { createApplication } = require('../actions/application');
const { createStatePersister } = require('../actions/state-persister');
const { translateToAction } = require('../dispatch/translator');
const { createTaskTranscriptLog } = require('../transcripts/transcript-log');
const { validateTranscript } = require('../transcripts/transcript-validator');
const {
  ErrorCodes,
  makeError,
  optionalString,
  requireTask,
  requireString,
} = require('./shared');

const SURFACE_TOOL_ALIASES = Object.freeze({
  workflow: Object.freeze({
    start: 'run_workflow',
  }),
});

function buildToolResult(payload) {
  return {
    ...payload,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateStringArray(value, field) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    return makeError(ErrorCodes.INVALID_PARAM, `${field} must be an array of non-empty strings`);
  }
  return null;
}

function getStatePersister() {
  try {
    if (
      defaultContainer
      && typeof defaultContainer.has === 'function'
      && defaultContainer.has('statePersister')
    ) {
      return defaultContainer.get('statePersister');
    }
  } catch (error) {
    void error;
  }

  const database = require('../database');
  const db = typeof database.getDbInstance === 'function'
    ? database.getDbInstance()
    : database;
  return createStatePersister({ db });
}

function looksLikeFunctionExpression(source) {
  const trimmed = source.trim();
  return trimmed.startsWith('function')
    || trimmed.startsWith('async function')
    || trimmed.startsWith('(')
    || trimmed.includes('=>');
}

function compileActionRun(runJs, actionName) {
  if (typeof runJs !== 'string' || !runJs.trim()) {
    throw new Error(`action ${actionName}: run_js must be a non-empty string`);
  }

  const source = runJs.trim();
  const runnerExpression = looksLikeFunctionExpression(source)
    ? `(${source})`
    : `(async (state, inputs) => { ${source} })`;

  return async (state, inputs = {}) => {
    const script = new vm.Script(
      `(async () => {
        const run = ${runnerExpression};
        if (typeof run !== 'function') throw new Error('run_js did not evaluate to a function');
        return await run(__state, __inputs);
      })()`,
      { filename: `action-app-${actionName}.vm.js` },
    );
    return script.runInNewContext({
      __state: state,
      __inputs: inputs,
      console: Object.freeze({
        log() {},
        warn() {},
        error() {},
      }),
    }, { timeout: 1000 });
  };
}

function buildActionAppActions(actionDefs) {
  if (!Array.isArray(actionDefs) || actionDefs.length === 0) {
    return { error: makeError(ErrorCodes.INVALID_PARAM, 'actions must be a non-empty array') };
  }

  const actions = [];
  for (const [index, actionDef] of actionDefs.entries()) {
    if (!isPlainObject(actionDef)) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `actions[${index}] must be an object`) };
    }
    if (!actionDef.name || typeof actionDef.name !== 'string') {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `actions[${index}].name must be a non-empty string`) };
    }
    const readError = validateStringArray(actionDef.reads, `actions[${index}].reads`);
    if (readError) return { error: readError };
    const writeError = validateStringArray(actionDef.writes, `actions[${index}].writes`);
    if (writeError) return { error: writeError };

    try {
      actions.push(createAction({
        name: actionDef.name.trim(),
        reads: actionDef.reads.map((entry) => entry.trim()),
        writes: actionDef.writes.map((entry) => entry.trim()),
        run: compileActionRun(actionDef.run_js, actionDef.name.trim()),
      }));
    } catch (error) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, error.message || String(error)) };
    }
  }

  return { actions };
}

function validateStringArrayArg(args, field) {
  const value = args[field];
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    return makeError(ErrorCodes.INVALID_PARAM, `${field} must be an array of non-empty strings`);
  }
  return null;
}

function getClaudeCodeSdkProvider() {
  try {
    const providerRegistry = defaultContainer.get('providerRegistry');
    const provider = providerRegistry?.getProviderInstance?.('claude-code-sdk');
    if (provider) {
      return provider;
    }
  } catch (error) {
    void error;
    // Fall through to direct registry access when the DI container is not booted.
  }

  const providerRegistry = require('../providers/registry');
  providerRegistry.registerProviderClass('claude-code-sdk', require('../providers/claude-code-sdk'));
  return providerRegistry.getProviderInstance('claude-code-sdk');
}

function getRunDirManager() {
  try {
    if (defaultContainer && typeof defaultContainer.has === 'function' && defaultContainer.has('runDirManager')) {
      return defaultContainer.get('runDirManager');
    }
  } catch (error) {
    void error;
  }
  return null;
}

function parseTaskMetadata(task) {
  if (!task || task.metadata == null) {
    return {};
  }

  if (typeof task.metadata === 'object' && !Array.isArray(task.metadata)) {
    return { ...task.metadata };
  }

  if (typeof task.metadata !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(task.metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function getTranscriptLogForTask(taskId) {
  return createTaskTranscriptLog({
    taskId,
    runDirManager: getRunDirManager(),
  });
}

function normalizeTagList(task) {
  if (Array.isArray(task?.tags)) {
    return task.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim());
  }

  if (typeof task?.tags === 'string' && task.tags.trim()) {
    try {
      const parsed = JSON.parse(task.tags);
      if (Array.isArray(parsed)) {
        return parsed.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim());
      }
    } catch {
      return [];
    }
  }

  return [];
}

function normalizeReplayDescription(taskDescription, metadata) {
  if (typeof taskDescription !== 'string' || !taskDescription) {
    return '';
  }

  const previousRunDir = typeof metadata?.run_dir === 'string' ? metadata.run_dir.trim() : '';
  if (!previousRunDir) {
    return taskDescription;
  }

  return taskDescription.split(previousRunDir).join('$run_dir');
}

function resolveReplayProvider(task, metadata) {
  const candidates = [
    task?.provider,
    metadata?.requested_provider,
    metadata?.original_provider,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

function toToolFragment(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function collectActionNames(schema, actionNames) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return;
  }

  const actionName = schema.properties?.actionName?.const;
  if (typeof actionName === 'string' && actionName.trim()) {
    actionNames.add(actionName.trim());
  }

  for (const branchName of ['oneOf', 'anyOf', 'allOf']) {
    if (!Array.isArray(schema[branchName])) {
      continue;
    }
    for (const nestedSchema of schema[branchName]) {
      collectActionNames(nestedSchema, actionNames);
    }
  }
}

function extractActionNames(schema) {
  const actionNames = new Set();
  collectActionNames(schema, actionNames);
  return Array.from(actionNames).sort();
}

function getKnownToolNames() {
  const tools = require('../tools');
  return new Set([
    ...tools.TOOLS.map((tool) => tool && tool.name).filter(Boolean),
    ...(typeof tools.getRuntimeRegisteredToolDefs === 'function'
      ? tools.getRuntimeRegisteredToolDefs().map((tool) => tool && tool.name).filter(Boolean)
      : []),
    ...tools.routeMap.keys(),
  ]);
}

function inferToolForAction(surface, actionName) {
  const normalizedSurface = toToolFragment(surface);
  const normalizedAction = toToolFragment(actionName);
  const aliases = SURFACE_TOOL_ALIASES[normalizedSurface] || {};
  const toolNames = getKnownToolNames();
  const candidates = [];

  if (aliases[normalizedAction]) {
    candidates.push(aliases[normalizedAction]);
  }

  candidates.push(`${normalizedAction}_${normalizedSurface}`);

  if (normalizedSurface.endsWith('s')) {
    candidates.push(`${normalizedAction}_${normalizedSurface.slice(0, -1)}`);
  }

  return candidates.find((candidate) => toolNames.has(candidate)) || null;
}

function extractToolText(result) {
  if (!result || typeof result !== 'object') {
    return '';
  }

  const textBlock = Array.isArray(result.content)
    ? result.content.find((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
    : null;
  if (textBlock?.text) {
    return textBlock.text;
  }

  return typeof result.error === 'string' ? result.error : '';
}

function normalizeModelOutput(raw) {
  if (typeof raw === 'string') {
    return raw;
  }

  if (raw && typeof raw === 'object') {
    if (typeof raw.output === 'string') {
      return raw.output;
    }
    if (typeof raw.content === 'string') {
      return raw.content;
    }
  }

  return JSON.stringify(raw ?? '');
}

function createHandlerError(message, code = ErrorCodes.INTERNAL_ERROR) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function callTranslatorModel(provider, prompt) {
  if (!provider) {
    throw createHandlerError('codex provider is unavailable', ErrorCodes.NO_HOSTS_AVAILABLE);
  }

  if (typeof provider.runPrompt === 'function') {
    const result = await provider.runPrompt({ prompt, format: 'json', max_tokens: 500 });
    return normalizeModelOutput(result);
  }

  if (typeof provider.submit === 'function') {
    const result = await provider.submit(prompt, null, { transport: 'api', maxTokens: 500 });
    return normalizeModelOutput(result);
  }

  throw createHandlerError('codex provider does not support prompt execution', ErrorCodes.INVALID_PARAM);
}

function normalizeHandlerSpec({ surface, actionName, handlerSpec }) {
  const knownToolNames = getKnownToolNames();

  if (typeof handlerSpec === 'string' && handlerSpec.trim()) {
    const toolName = handlerSpec.trim();
    if (!knownToolNames.has(toolName)) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" references unknown tool "${toolName}"`) };
    }

    return {
      tool: toolName,
      arg_map: null,
      fixed_args: null,
      include_action: false,
      include_context: false,
    };
  }

  if (handlerSpec && typeof handlerSpec === 'object' && !Array.isArray(handlerSpec)) {
    const toolName = typeof handlerSpec.tool === 'string' ? handlerSpec.tool.trim() : '';
    if (!toolName) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" must include a non-empty tool name`) };
    }
    if (!knownToolNames.has(toolName)) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" references unknown tool "${toolName}"`) };
    }

    if (handlerSpec.arg_map !== undefined && (!handlerSpec.arg_map || typeof handlerSpec.arg_map !== 'object' || Array.isArray(handlerSpec.arg_map))) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" arg_map must be an object`) };
    }
    if (handlerSpec.arg_map && Object.values(handlerSpec.arg_map).some((value) => typeof value !== 'string' || !value.trim())) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" arg_map values must be non-empty strings`) };
    }

    if (handlerSpec.fixed_args !== undefined && (!handlerSpec.fixed_args || typeof handlerSpec.fixed_args !== 'object' || Array.isArray(handlerSpec.fixed_args))) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" fixed_args must be an object`) };
    }

    return {
      tool: toolName,
      arg_map: handlerSpec.arg_map || null,
      fixed_args: handlerSpec.fixed_args || null,
      include_action: handlerSpec.include_action === true,
      include_context: handlerSpec.include_context === true,
    };
  }

  if (handlerSpec !== undefined) {
    return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" must be a tool name string or object`) };
  }

  const inferredTool = inferToolForAction(surface, actionName);
  if (!inferredTool) {
    return {
      error: makeError(
        ErrorCodes.INVALID_PARAM,
        `No handler registered for action "${actionName}" on surface "${surface}" and no matching TORQUE tool could be inferred`,
      ),
    };
  }

  return {
    tool: inferredTool,
    arg_map: null,
    fixed_args: null,
    include_action: false,
    include_context: false,
  };
}

function buildToolArgs(action, handlerConfig, context) {
  const actionFields = { ...action };
  delete actionFields.actionName;

  let toolArgs = {};
  if (handlerConfig.arg_map && typeof handlerConfig.arg_map === 'object') {
    for (const [targetArg, sourceField] of Object.entries(handlerConfig.arg_map)) {
      if (typeof sourceField !== 'string') {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(actionFields, sourceField)) {
        toolArgs[targetArg] = actionFields[sourceField];
      }
    }
  } else {
    toolArgs = { ...actionFields };
  }

  if (handlerConfig.fixed_args) {
    Object.assign(toolArgs, handlerConfig.fixed_args);
  }

  if (handlerConfig.include_action) {
    toolArgs.action = { ...action };
  }

  if (handlerConfig.include_context && context && typeof context === 'object') {
    toolArgs.context = { ...context };
  }

  return toolArgs;
}

function createActionHandler(handlerConfig) {
  return async (action, context = {}) => {
    const tools = require('../tools');
    const toolArgs = buildToolArgs(action, handlerConfig, context);
    const result = await tools.handleToolCall(handlerConfig.tool, toolArgs);
    if (result?.isError) {
      throw createHandlerError(extractToolText(result) || `tool ${handlerConfig.tool} failed`);
    }
    return result;
  };
}

function normalizeHandlers({ surface, schema, handlers }) {
  const actionNames = extractActionNames(schema);
  if (actionNames.length === 0) {
    return {
      error: makeError(
        ErrorCodes.INVALID_PARAM,
        'schema must include at least one actionName const in a properties block',
      ),
    };
  }

  const normalizedHandlers = {};
  const handlerTools = {};
  for (const actionName of actionNames) {
    const normalized = normalizeHandlerSpec({
      surface,
      actionName,
      handlerSpec: handlers && Object.prototype.hasOwnProperty.call(handlers, actionName)
        ? handlers[actionName]
        : undefined,
    });
    if (normalized.error) {
      return { error: normalized.error };
    }

    normalizedHandlers[actionName] = createActionHandler(normalized);
    handlerTools[actionName] = normalized.tool;
  }

  return {
    actionNames,
    normalizedHandlers,
    handlerTools,
  };
}

function getDispatchServices() {
  return {
    actionRegistry: defaultContainer.get('actionRegistry'),
    constructionCache: defaultContainer.get('constructionCache'),
    executor: defaultContainer.get('executor'),
    providerRegistry: defaultContainer.get('providerRegistry'),
  };
}

async function handleRegisterActionSchema(args) {
  try {
    const surfaceError = requireString(args, 'surface', 'surface');
    if (surfaceError) return surfaceError;

    const descriptionError = optionalString(args, 'description', 'description');
    if (descriptionError) return descriptionError;

    if (!args.schema || typeof args.schema !== 'object' || Array.isArray(args.schema)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'schema must be a JSON schema object');
    }

    if (args.handlers !== undefined && (!args.handlers || typeof args.handlers !== 'object' || Array.isArray(args.handlers))) {
      return makeError(ErrorCodes.INVALID_PARAM, 'handlers must be an object when provided');
    }

    const { actionRegistry } = getDispatchServices();
    const normalized = normalizeHandlers({
      surface: args.surface.trim(),
      schema: args.schema,
      handlers: args.handlers || null,
    });
    if (normalized.error) {
      return normalized.error;
    }

    actionRegistry.register({
      surface: args.surface.trim(),
      schema: args.schema,
      handlers: normalized.normalizedHandlers,
      description: args.description || null,
    });

    return buildToolResult({
      ok: true,
      surface: args.surface.trim(),
      description: args.description || null,
      action_names: normalized.actionNames,
      handler_tools: normalized.handlerTools,
    });
  } catch (error) {
    return makeError(ErrorCodes.INVALID_PARAM, error.message || String(error));
  }
}

async function handleListActions(args = {}) {
  try {
    const descriptionError = optionalString(args, 'surface', 'surface');
    if (descriptionError) return descriptionError;

    const { actionRegistry } = getDispatchServices();
    const surfaces = [];

    if (typeof args.surface === 'string' && args.surface.trim()) {
      const surfaceName = args.surface.trim();
      const surface = actionRegistry.getSurface(surfaceName);
      if (surface) {
        surfaces.push({
          surface: surfaceName,
          description: surface.description || null,
          action_names: actionRegistry.listActionNames(surfaceName).sort(),
        });
      }
    } else {
      for (const surfaceName of actionRegistry.listSurfaces()) {
        const surface = actionRegistry.getSurface(surfaceName);
        surfaces.push({
          surface: surfaceName,
          description: surface?.description || null,
          action_names: actionRegistry.listActionNames(surfaceName).sort(),
        });
      }
    }

    return buildToolResult({
      count: surfaces.length,
      surfaces,
    });
  } catch (error) {
    return makeError(ErrorCodes.INTERNAL_ERROR, error.message || String(error));
  }
}

async function handleDispatchNl(args) {
  try {
    const surfaceError = requireString(args, 'surface', 'surface');
    if (surfaceError) return surfaceError;

    const utteranceError = requireString(args, 'utterance', 'utterance');
    if (utteranceError) return utteranceError;

    const surfaceName = args.surface.trim();
    const utterance = args.utterance.trim();
    const {
      actionRegistry,
      constructionCache,
      executor,
      providerRegistry,
    } = getDispatchServices();

    const surface = actionRegistry.getSurface(surfaceName);
    if (!surface) {
      return buildToolResult({
        ok: false,
        surface: surfaceName,
        utterance,
        error: 'unknown surface',
      });
    }

    const cached = constructionCache.lookup({ utterance, surface: surfaceName });
    if (cached) {
      const result = await executor.execute({ surface: surfaceName, action: cached });
      return buildToolResult({
        ...result,
        surface: surfaceName,
        utterance,
        action: cached,
        source: 'cache',
      });
    }

    const provider = providerRegistry.getProviderInstance('codex');
    if (!provider) {
      return buildToolResult({
        ok: false,
        surface: surfaceName,
        utterance,
        error: 'translation provider unavailable',
        provider: 'codex',
      });
    }

    const translation = await translateToAction({
      utterance,
      schema: surface.schema,
      callModel: async ({ prompt }) => callTranslatorModel(provider, prompt),
    });

    if (!translation.ok) {
      return buildToolResult({
        ok: false,
        surface: surfaceName,
        utterance,
        error: 'translation failed',
        details: translation.errors || [],
        attempts: translation.attempts || 0,
      });
    }

    const result = await executor.execute({ surface: surfaceName, action: translation.action });
    if (args.learn_on_success !== false && result.ok) {
      // Future enhancement: derive normalized templates from accepted translations.
    }

    return buildToolResult({
      ...result,
      surface: surfaceName,
      utterance,
      action: translation.action,
      source: 'llm',
      attempts: translation.attempts || 0,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      surface: typeof args.surface === 'string' ? args.surface.trim() : null,
      utterance: typeof args.utterance === 'string' ? args.utterance.trim() : null,
      error: error.message || String(error),
    });
  }
}

async function handleActionAppRun(args = {}) {
  try {
    const built = buildActionAppActions(args.actions);
    if (built.error) return built.error;

    if (!isPlainObject(args.initial_state)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'initial_state must be an object');
    }
    if (args.transitions !== undefined && !isPlainObject(args.transitions)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'transitions must be an object');
    }

    const appIdError = optionalString(args, 'app_id', 'app_id');
    if (appIdError) return appIdError;
    const partitionKeyError = optionalString(args, 'partition_key', 'partition_key');
    if (partitionKeyError) return partitionKeyError;

    const persister = getStatePersister();
    const app = createApplication({
      actions: built.actions,
      transitions: args.transitions || {},
      initialState: args.initial_state,
      persister,
      app_id: args.app_id || undefined,
      partition_key: args.partition_key || '',
    });

    const results = [];
    for (const action of built.actions) {
      const stepResult = await app.step(action.name);
      results.push({
        action_name: action.name,
        result: stepResult.result,
        state: stepResult.nextState,
      });
    }

    return buildToolResult({
      ok: true,
      app_id: app.app_id,
      partition_key: app.partition_key,
      sequence_id: app.getSequence() - 1,
      final_state: app.getState(),
      results,
    });
  } catch (error) {
    return makeError(ErrorCodes.INVALID_PARAM, error.message || String(error));
  }
}

async function handleActionAppFork(args = {}) {
  try {
    const appIdError = requireString(args, 'app_id', 'app_id');
    if (appIdError) return appIdError;
    const partitionKeyError = optionalString(args, 'partition_key', 'partition_key');
    if (partitionKeyError) return partitionKeyError;
    const newAppIdError = optionalString(args, 'new_app_id', 'new_app_id');
    if (newAppIdError) return newAppIdError;
    const newPartitionKeyError = optionalString(args, 'new_partition_key', 'new_partition_key');
    if (newPartitionKeyError) return newPartitionKeyError;
    if (!Number.isInteger(args.sequence_id)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'sequence_id must be an integer');
    }

    const persister = getStatePersister();
    const sourceAppId = args.app_id.trim();
    const sourcePartitionKey = args.partition_key || '';
    const snapshot = persister.loadAt({
      app_id: sourceAppId,
      partition_key: sourcePartitionKey,
      sequence_id: args.sequence_id,
    });
    if (!snapshot) {
      return makeError(
        ErrorCodes.RESOURCE_NOT_FOUND,
        `no snapshot at ${sourceAppId}:${sourcePartitionKey}:${args.sequence_id}`,
      );
    }

    const newAppId = args.new_app_id || `app_${randomUUID().slice(0, 10)}`;
    const newPartitionKey = args.new_partition_key || '';
    persister.save({
      app_id: newAppId,
      partition_key: newPartitionKey,
      sequence_id: 0,
      action_name: `fork:${snapshot.action_name}`,
      state: snapshot.state,
      result: {
        forked_from: {
          app_id: sourceAppId,
          partition_key: sourcePartitionKey,
          sequence_id: args.sequence_id,
        },
      },
    });

    return buildToolResult({
      ok: true,
      app_id: newAppId,
      partition_key: newPartitionKey,
      sequence_id: 0,
      forked_from: {
        app_id: sourceAppId,
        partition_key: sourcePartitionKey,
        sequence_id: args.sequence_id,
      },
      state: snapshot.state,
    });
  } catch (error) {
    return makeError(ErrorCodes.INVALID_PARAM, error.message || String(error));
  }
}

async function handleActionAppHistory(args = {}) {
  try {
    const appIdError = requireString(args, 'app_id', 'app_id');
    if (appIdError) return appIdError;
    const partitionKeyError = optionalString(args, 'partition_key', 'partition_key');
    if (partitionKeyError) return partitionKeyError;

    const appId = args.app_id.trim();
    const partitionKey = args.partition_key || '';
    const history = getStatePersister().history({
      app_id: appId,
      partition_key: partitionKey,
    });

    return buildToolResult({
      ok: true,
      app_id: appId,
      partition_key: partitionKey,
      count: history.length,
      history,
    });
  } catch (error) {
    return makeError(ErrorCodes.INVALID_PARAM, error.message || String(error));
  }
}

async function handleDispatchSubagent(args = {}) {
  try {
    const promptError = requireString(args, 'prompt', 'prompt');
    if (promptError) return promptError;

    const modelError = optionalString(args, 'model', 'model');
    if (modelError) return modelError;

    const skillError = optionalString(args, 'skill', 'skill');
    if (skillError) return skillError;

    const allowedToolsError = validateStringArrayArg(args, 'allowed_tools');
    if (allowedToolsError) return allowedToolsError;

    const disallowedToolsError = validateStringArrayArg(args, 'disallowed_tools');
    if (disallowedToolsError) return disallowedToolsError;

    if (
      args.timeout_ms !== undefined
      && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1)
    ) {
      return makeError(ErrorCodes.INVALID_PARAM, 'timeout_ms must be a positive integer');
    }

    const provider = getClaudeCodeSdkProvider();
    if (!provider || typeof provider.dispatchSubagent !== 'function') {
      return makeError(ErrorCodes.NO_HOSTS_AVAILABLE, 'claude-code-sdk provider is unavailable');
    }

    const result = await provider.dispatchSubagent({
      prompt: args.prompt.trim(),
      model: args.model || null,
      allowed_tools: Array.isArray(args.allowed_tools) ? args.allowed_tools : [],
      disallowed_tools: Array.isArray(args.disallowed_tools) ? args.disallowed_tools : [],
      mode: args.mode,
      skill: args.skill || null,
      timeout_ms: args.timeout_ms,
      working_directory: process.cwd(),
    });

    return buildToolResult({
      ok: true,
      ...result,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleResumeSession(args = {}) {
  try {
    const sessionError = requireString(args, 'session_id', 'session_id');
    if (sessionError) return sessionError;

    const provider = getClaudeCodeSdkProvider();
    if (!provider || typeof provider.resumeSession !== 'function') {
      return makeError(ErrorCodes.NO_HOSTS_AVAILABLE, 'claude-code-sdk provider is unavailable');
    }

    return buildToolResult({
      ok: true,
      session: provider.resumeSession(args.session_id.trim()),
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleForkSession(args = {}) {
  try {
    const sessionError = requireString(args, 'source_session_id', 'source_session_id');
    if (sessionError) return sessionError;

    const nameError = optionalString(args, 'name', 'name');
    if (nameError) return nameError;

    const provider = getClaudeCodeSdkProvider();
    if (!provider || typeof provider.forkSession !== 'function') {
      return makeError(ErrorCodes.NO_HOSTS_AVAILABLE, 'claude-code-sdk provider is unavailable');
    }

    return buildToolResult({
      ok: true,
      session: provider.forkSession(args.source_session_id.trim(), {
        name: args.name || null,
      }),
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleListSessions() {
  try {
    const provider = getClaudeCodeSdkProvider();
    if (!provider || typeof provider.listSessions !== 'function') {
      return makeError(ErrorCodes.NO_HOSTS_AVAILABLE, 'claude-code-sdk provider is unavailable');
    }

    const sessions = provider.listSessions();
    return buildToolResult({
      ok: true,
      count: sessions.length,
      sessions,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleReadTranscript(args = {}) {
  try {
    const taskError = requireString(args, 'task_id', 'task_id');
    if (taskError) return taskError;

    const taskId = args.task_id.trim();
    const { error: taskLookupError } = requireTask(taskId);
    if (taskLookupError) return taskLookupError;

    const transcriptLog = getTranscriptLogForTask(taskId);
    const messages = transcriptLog.read();
    const validation = validateTranscript(messages);

    return buildToolResult({
      ok: validation.ok,
      task_id: taskId,
      file_path: transcriptLog.filePath,
      count: messages.length,
      messages,
      errors: validation.errors,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleEditTranscript(args = {}) {
  try {
    const taskError = requireString(args, 'task_id', 'task_id');
    if (taskError) return taskError;

    const taskId = args.task_id.trim();
    const { error: taskLookupError } = requireTask(taskId);
    if (taskLookupError) return taskLookupError;

    if (!Array.isArray(args.messages)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'messages must be an array');
    }

    const validation = validateTranscript(args.messages);
    if (!validation.ok) {
      return buildToolResult({
        ok: false,
        task_id: taskId,
        errors: validation.errors,
      });
    }

    const transcriptLog = getTranscriptLogForTask(taskId);
    transcriptLog.replace(args.messages);

    return buildToolResult({
      ok: true,
      task_id: taskId,
      file_path: transcriptLog.filePath,
      count: args.messages.length,
      messages: args.messages,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleReplayFromTranscript(args = {}) {
  try {
    const taskError = requireString(args, 'task_id', 'task_id');
    if (taskError) return taskError;

    const taskId = args.task_id.trim();
    const { task, error: taskLookupError } = requireTask(taskId);
    if (taskLookupError) return taskLookupError;

    const transcriptLog = getTranscriptLogForTask(taskId);
    const messages = transcriptLog.read();
    if (messages.length === 0) {
      return buildToolResult({
        ok: false,
        task_id: taskId,
        file_path: transcriptLog.filePath,
        error: `No transcript found for task ${taskId}`,
      });
    }

    const validation = validateTranscript(messages);
    if (!validation.ok) {
      return buildToolResult({
        ok: false,
        task_id: taskId,
        file_path: transcriptLog.filePath,
        errors: validation.errors,
      });
    }

    const metadata = parseTaskMetadata(task);
    const provider = resolveReplayProvider(task, metadata);
    if (provider !== 'claude-code-sdk') {
      return buildToolResult({
        ok: false,
        task_id: taskId,
        provider: provider || null,
        error: 'replay_from_transcript currently supports claude-code-sdk tasks only',
      });
    }

    const replayTaskId = randomUUID();
    const taskCore = require('../db/task-core');
    const providerRoutingCore = require('../db/provider-routing-core');
    const taskManager = require('../task-manager');

    const replayMetadata = {
      ...metadata,
      requested_provider: provider,
      user_provider_override: true,
      transcript_seed_from_task_id: taskId,
      transcript_replay_of: taskId,
    };
    delete replayMetadata.run_dir;
    delete replayMetadata.transcript_path;
    delete replayMetadata.claude_session_id;
    delete replayMetadata.claude_local_session_id;
    delete replayMetadata.fork_from_claude_session_id;

    const replayTags = normalizeTagList(task);
    if (!replayTags.includes(`replay_of:${taskId}`)) {
      replayTags.push(`replay_of:${taskId}`);
    }

    taskCore.createTask({
      id: replayTaskId,
      status: 'queued',
      task_description: normalizeReplayDescription(task.task_description, metadata),
      working_directory: task.working_directory || null,
      timeout_minutes: task.timeout_minutes,
      auto_approve: Boolean(task.auto_approve),
      priority: task.priority || 0,
      max_retries: task.max_retries,
      template_name: task.template_name || null,
      isolated_workspace: task.isolated_workspace || null,
      project: task.project || null,
      tags: replayTags,
      provider,
      model: task.model || null,
      complexity: task.complexity || 'normal',
      metadata: replayMetadata,
    });

    providerRoutingCore.createTaskReplay({
      id: randomUUID(),
      original_task_id: taskId,
      replay_task_id: replayTaskId,
      modified_inputs: {
        transcript_seed_from_task_id: taskId,
        transcript_message_count: messages.length,
      },
      diff_summary: 'Replay from transcript',
    });

    try {
      taskManager.processQueue();
    } catch (error) {
      void error;
    }

    return buildToolResult({
      ok: true,
      task_id: taskId,
      replay_task_id: replayTaskId,
      provider,
      status: 'queued',
      file_path: transcriptLog.filePath,
      transcript_message_count: messages.length,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

module.exports = {
  handleRegisterActionSchema,
  handleListActions,
  handleDispatchNl,
  handleActionAppRun,
  handleActionAppFork,
  handleActionAppHistory,
  handleDispatchSubagent,
  handleResumeSession,
  handleForkSession,
  handleListSessions,
  handleReadTranscript,
  handleEditTranscript,
  handleReplayFromTranscript,
};
