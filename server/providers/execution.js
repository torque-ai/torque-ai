/**
 * providers/execution.js — Provider execution aggregator
 *
 * Thin aggregator that delegates to sub-modules:
 * - execute-api.js      — executeApiProvider (API-based providers)
 * - execute-ollama.js   — executeOllamaTask, estimateRequiredContext (plain Ollama)
 * - execute-cli.js      — buildAiderOllamaCommand, buildClaudeCliCommand, buildCodexCommand, spawnAndTrackProcess
 *
 * Also hosts the agentic tool-calling pipeline that wraps Ollama and cloud API
 * providers with adapter-agnostic tool calling (Task 8 integration).
 *
 * Agentic tasks now run in isolated worker_threads via spawnAgenticWorker()
 * to prevent the agentic loop from starving the main-thread event loop
 * (4 HTTP servers + synchronous DB ops).
 *
 * Preserves the original init() DI interface — all dependencies are forwarded to sub-modules.
 */

'use strict';

const path = require('path');

const _executeApiModule = require('./execute-api');
const _executeOllamaModule = require('./execute-ollama');
const _executeCliModule = require('./execute-cli');

// Agentic pipeline components
const { runAgenticLoop } = require('./ollama-agentic');
const { isAgenticCapable, needsPromptInjection, init: initCapability } = require('./agentic-capability');
const { createToolExecutor, selectToolsForTask } = require('./ollama-tools');
const {
  captureSnapshot,
  checkAndRevert,
  revertScopedChanges,
  serializeSnapshot,
} = require('./agentic-git-safety');
const { resolveOllamaModel } = require('./ollama-shared');
const {
  getProviderLanePolicyFromMetadata,
  isProviderLaneHandoffAllowed,
  providerLaneHandoffBlockReason,
} = require('../factory/provider-lane-policy');
const { isJsonModeRequested } = require('./shared');

const { acquireHostLock } = require('./host-mutex');
const ollamaChatAdapter = require('./adapters/ollama-chat');
const openaiChatAdapter = require('./adapters/openai-chat');
const googleChatAdapter = require('./adapters/google-chat');

const logger = require('../logger').child({ component: 'execution-agentic' });

// ── Lazy reference to recordProviderOutcome from provider-routing-core ──
// Loaded in init() to avoid circular-require during startup.
let _recordProviderOutcome = null;

// ── Cloud provider base URL map (for OpenAI-compatible adapters) ───────
const PROVIDER_HOST_MAP = {
  anthropic: 'https://api.anthropic.com',
  groq: 'https://api.groq.com/openai',
  cerebras: 'https://api.cerebras.ai',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  openrouter: 'https://openrouter.ai/api',
  hyperbolic: 'https://api.hyperbolic.xyz/v1',
  'ollama-cloud': 'https://api.ollama.com',
  'google-ai': 'https://generativelanguage.googleapis.com',
};

// Default models per provider
const PROVIDER_DEFAULT_MODEL = {
  groq: null,
  cerebras: null,
  deepinfra: null,
  openrouter: null,
  hyperbolic: null,
  'ollama-cloud': null,
  'google-ai': 'gemini-2.5-flash-lite',
};

const AGENTIC_WORKER_UNSUPPORTED_PROVIDERS = new Set(['codex', 'codex-spark', 'claude-cli', 'claude-code-sdk']);
const AGENTIC_CLOUD_TO_CODEX_FALLBACKS = new Set(['google-ai', 'groq', 'openrouter', 'ollama-cloud', 'cerebras']);
const FREE_AGENTIC_TOOL_EVIDENCE_PROVIDERS = new Set(['cerebras', 'google-ai', 'groq', 'openrouter', 'ollama-cloud', 'ollama']);
const PROPOSAL_APPLY_MODE = 'proposal_apply';
const PROPOSAL_MODE_READ_TOOLS = new Set(['read_file', 'list_directory', 'search_files']);
const FACTORY_INTERNAL_STRUCTURED_KINDS = new Set(['architect_cycle', 'plan_generation', 'verify_review']);
const OPENROUTER_FALLBACK_SCORE_LIMIT = 8;
const READ_ONLY_PLAN_TITLE_RE = /^(?:verify|confirm|inspect|audit|review|scout|survey|check)\b/i;
const MUTATING_PLAN_TITLE_RE = /\b(?:fix|repair|recover|retry|implement|update|change|modify|edit|add|create|write|replace|remove|delete|refactor)\b/i;
function dedupeValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (typeof value !== 'string') return false;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

// ── Deps captured at init time for the agentic wrapper ────────────────
let _agenticDeps = null;

/**
 * Initialize all sub-modules with dependencies from task-manager.js.
 * Accepts the same deps object as the original monolithic init().
 */
function init(deps) {
  // Capture deps for the agentic wrapper
  // Issue #6 fix: include apiAbortControllers so _agenticDeps.apiAbortControllers is defined.
  // Without this, cancelTask() cannot abort in-flight agentic API requests — it falls back to
  // _executeApiModule._apiAbortControllers, but that only works if the module ref is live.
  _agenticDeps = {
    db: deps.db,
    dashboard: deps.dashboard,
    runningProcesses: deps.runningProcesses,
    safeUpdateTaskStatus: deps.safeUpdateTaskStatus,
    processQueue: deps.processQueue,
    handleWorkflowTermination: deps.handleWorkflowTermination,
    apiAbortControllers: deps.apiAbortControllers,
    getFreeQuotaTracker: deps.getFreeQuotaTracker,
  };

  // Import recordProviderOutcome from provider-routing-core if available
  try {
    const routingCore = require('../db/provider-routing-core');
    _recordProviderOutcome = routingCore.recordProviderOutcome;
  } catch { /* module may not be ready */ }

  // Initialize capability detection with DB + serverConfig
  initCapability({ db: deps.db, serverConfig: require('../config') });

  // execute-api.js needs: db, dashboard, apiAbortControllers, processQueue, handleWorkflowTermination
  _executeApiModule.init({
    db: deps.db,
    dashboard: deps.dashboard,
    apiAbortControllers: deps.apiAbortControllers,
    processQueue: deps.processQueue,
    recordTaskStartedAuditEvent: deps.recordTaskStartedAuditEvent,
    handleWorkflowTermination: deps.handleWorkflowTermination,
  });

  // execute-ollama.js needs: db, dashboard, safeUpdateTaskStatus, tryReserveHostSlotWithFallback,
  //   tryOllamaCloudFallback, isLargeModelBlockedOnHost, buildFileContext, processQueue
  _executeOllamaModule.init({
    db: deps.db,
    dashboard: deps.dashboard,
    safeUpdateTaskStatus: deps.safeUpdateTaskStatus,
    recordTaskStartedAuditEvent: deps.recordTaskStartedAuditEvent,
    tryReserveHostSlotWithFallback: deps.tryReserveHostSlotWithFallback,
    tryOllamaCloudFallback: deps.tryOllamaCloudFallback,
    isLargeModelBlockedOnHost: deps.isLargeModelBlockedOnHost,
    buildFileContext: deps.buildFileContext,
    processQueue: deps.processQueue,
  });

   // execute-cli.js needs: db, dashboard, runningProcesses, safeUpdateTaskStatus,
   //   tryReserveHostSlotWithFallback, markTaskCleanedUp, tryOllamaCloudFallback,
   //   tryLocalFirstFallback, attemptFuzzySearchRepair, tryHashlineTieredFallback,
   //   shellEscape, processQueue, isLargeModelBlockedOnHost, helpers, NVM_NODE_PATH,
   //   QUEUE_LOCK_HOLDER_ID, MAX_OUTPUT_BUFFER, pendingRetryTimeouts, taskCleanupGuard,
   //   finalizeTask,
   //   stallRecoveryAttempts
  _executeCliModule.init({
    db: deps.db,
    dashboard: deps.dashboard,
    runningProcesses: deps.runningProcesses,
    safeUpdateTaskStatus: deps.safeUpdateTaskStatus,
    tryReserveHostSlotWithFallback: deps.tryReserveHostSlotWithFallback,
    markTaskCleanedUp: deps.markTaskCleanedUp,
    tryOllamaCloudFallback: deps.tryOllamaCloudFallback,
    tryLocalFirstFallback: deps.tryLocalFirstFallback,
    attemptFuzzySearchRepair: deps.attemptFuzzySearchRepair,
    tryHashlineTieredFallback: deps.tryHashlineTieredFallback,
    shellEscape: deps.shellEscape,
    processQueue: deps.processQueue,
    isLargeModelBlockedOnHost: deps.isLargeModelBlockedOnHost,
    helpers: deps.helpers,
    NVM_NODE_PATH: deps.NVM_NODE_PATH,
    QUEUE_LOCK_HOLDER_ID: deps.QUEUE_LOCK_HOLDER_ID,
    MAX_OUTPUT_BUFFER: deps.MAX_OUTPUT_BUFFER,
    pendingRetryTimeouts: deps.pendingRetryTimeouts,
    taskCleanupGuard: deps.taskCleanupGuard,
    finalizeTask: deps.finalizeTask,
    stallRecoveryAttempts: deps.stallRecoveryAttempts,
  });
}

// ============================================================
// Agentic pipeline helpers
// ============================================================

/**
 * Select the appropriate chat adapter for a provider.
 * Returns null for providers that don't support the agentic pipeline.
 *
 * @param {string} provider
 * @returns {{ chatCompletion: Function }|null}
 */
function selectAdapter(provider) {
  // Ollama-format APIs (NDJSON streaming, /api/chat)
  if (provider === 'ollama' || provider === 'ollama-cloud') return ollamaChatAdapter;
  // Google Gemini API
  if (provider === 'google-ai') return googleChatAdapter;
  // OpenAI-compatible APIs (JSON or SSE, /v1/chat/completions)
  if (['groq', 'cerebras', 'deepinfra', 'openrouter', 'hyperbolic'].includes(provider)) {
    return openaiChatAdapter;
  }
  return null;
}

function resolveAgenticAdapterType(provider) {
  if (provider === 'ollama' || provider === 'ollama-cloud') return 'ollama';
  if (provider === 'google-ai') return 'google';
  return 'openai';
}

/**
 * Resolve API key for a cloud provider.
 * Checks DB config first, then environment variables.
 *
 * @param {string} provider
 * @returns {string|null}
 */
function resolveApiKey(provider) {
  // Delegate to config.js getApiKey which handles:
  // 1. Environment variables (highest priority)
  // 2. Encrypted keys in provider_config.api_key_encrypted
  // 3. Legacy DB config table
  const serverConfig = require('../config');
  return serverConfig.getApiKey(provider);
}

function resolveApiProviderModel(provider, requestedModel = null) {
  const explicitModel = typeof requestedModel === 'string' ? requestedModel.trim() : requestedModel;
  if (explicitModel) return explicitModel;

  try {
    const modelRoles = require('../db/model-roles');
    const roleModel = modelRoles.getModelForRole(provider, 'default');
    if (roleModel) return roleModel;
  } catch { /* role store may not be initialized in tests or early startup */ }

  const defaultModel = PROVIDER_DEFAULT_MODEL[provider];
  if (defaultModel) return defaultModel;

  try {
    const registry = require('../models/registry');
    const best = registry.selectBestApprovedModel(provider);
    if (best?.model_name) return best.model_name;
  } catch { /* registry may not be initialized in tests or early startup */ }

  return '';
}

function resolveProviderRoleModel(provider, role) {
  try {
    const modelRoles = require('../db/model-roles');
    return modelRoles.getModelForRole(provider, role) || null;
  } catch {
    return null;
  }
}

function parseProviderModelMetadata(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeSupportedParameters(value) {
  const metadata = parseProviderModelMetadata(value);
  const supportedParameters = Array.isArray(metadata?.supported_parameters)
    ? metadata.supported_parameters
    : (Array.isArray(metadata?.supportedParameters) ? metadata.supportedParameters : []);
  return supportedParameters
    .map((parameter) => {
      if (typeof parameter === 'string') return parameter.trim().toLowerCase();
      if (parameter && typeof parameter === 'object' && typeof parameter.name === 'string') return parameter.name.trim().toLowerCase();
      return '';
    })
    .filter(Boolean);
}

function modelSupportsOpenRouterResponseFormat(metadataJson) {
  const metadata = parseProviderModelMetadata(metadataJson);
  if (metadata.supports_response_format === true || metadata.supportsResponseFormat === true) return true;
  const supportedParameters = normalizeSupportedParameters(metadataJson);
  return supportedParameters.some((parameter) => {
    if (parameter === 'response_format') return true;
    if (parameter === 'json_schema') return true;
    if (parameter.includes('response_format')) return true;
    return false;
  });
}

function resolveOpenRouterFallbackRows(rows, options = {}) {
  const preferParser = options.preferParserModels === true;
  const fallbackLimit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : OPENROUTER_FALLBACK_SCORE_LIMIT;
  const scoredRows = (Array.isArray(rows) ? rows : [])
    .map((row, sortOrder) => {
      const model = typeof row?.model_name === 'string' ? row.model_name.trim() : '';
      if (!model) return null;
      const metadataJson = row?.metadata_json || row?.metadata;
      return {
        model,
        isFree: isFreeOpenRouterModelCandidate(model, metadataJson),
        supportsParser: modelSupportsOpenRouterResponseFormat(metadataJson),
        sortOrder,
      };
    })
    .filter(Boolean);

  if (scoredRows.length === 0) return [];

  const orderedRows = preferParser
    ? [...scoredRows].sort((a, b) => {
      if (a.supportsParser !== b.supportsParser) return b.supportsParser - a.supportsParser;
      return a.sortOrder - b.sortOrder;
    })
    : scoredRows;

  const freeRows = orderedRows.filter((row) => row.isFree);
  const fallbackRows = freeRows.length > 0 ? freeRows : orderedRows;
  return dedupeValues(fallbackRows.slice(0, fallbackLimit).map((row) => row.model));
}

function isFreeOpenRouterModelCandidate(modelName, metadataJson) {
  if (/:free$/i.test(modelName)) return true;
  const metadata = parseProviderModelMetadata(metadataJson);
  return metadata.free === true || metadata.free === 1 || metadata.free === '1';
}

function getTopScoredOpenRouterFallbackModels(limit = OPENROUTER_FALLBACK_SCORE_LIMIT, options = {}) {
  if (typeof limit === 'object' && limit !== null && !Array.isArray(limit)) {
    options = limit;
    limit = options.limit;
  }
  const fallbackLimit = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : OPENROUTER_FALLBACK_SCORE_LIMIT);
  const preferParserModels = isJsonModeRequested({
    responseFormat: parseProviderModelMetadata(options.taskMetadata)?.response_format,
  });

  const agenticDb = _agenticDeps?.db;
  if (!agenticDb || typeof agenticDb.prepare !== 'function') return [];
  const hasSqliteHandle = typeof agenticDb.exec === 'function';

  try {
    const providerModelScores = require('../db/provider-model-scores');
    if (hasSqliteHandle && typeof providerModelScores.init === 'function') {
      try {
        providerModelScores.init(agenticDb);
      } catch {
        return [];
      }
    }

    const fetchTopModels = providerModelScores.getTopModelScores || providerModelScores.listModelScores;
    if (typeof fetchTopModels !== 'function') return [];

    const topRows = fetchTopModels.call(providerModelScores, 'openrouter', {
      rateLimited: false,
      limit: fallbackLimit,
    }) || [];
    const fallbackRows = resolveOpenRouterFallbackRows(topRows, {
      limit: fallbackLimit,
      preferParserModels,
      taskMetadata: options.taskMetadata,
    });
    return fallbackRows;
  } catch (err) {
    logger.debug(`[Agentic OpenRouter Fallback] Failed to fetch scored models: ${err.message}`);
    return [];
  }
}

function buildOpenRouterModelFallbackChain(provider, primaryModel, taskMetadata = null) {
  if (provider !== 'openrouter') return null;

  const seen = new Set();
  const chain = [];
  const add = (modelName) => {
    const normalized = typeof modelName === 'string' ? modelName.trim() : '';
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    chain.push({ provider: 'openrouter', model: normalized });
  };

  add(primaryModel);
  for (const role of ['fallback', 'balanced', 'fast', 'quality']) {
    add(resolveProviderRoleModel('openrouter', role));
  }
  for (const model of getTopScoredOpenRouterFallbackModels(OPENROUTER_FALLBACK_SCORE_LIMIT, { taskMetadata })) {
    add(model);
  }

  return chain.length > 1 ? chain : null;
}

/**
 * Build the platform-aware agentic system prompt.
 *
 * @param {string} basePrompt - Model-specific system prompt from config
 * @param {string} workingDir
 * @returns {string}
 */
function buildAgenticSystemPrompt(basePrompt, workingDir) {
  const platformRule = process.platform === 'win32'
    ? 'PLATFORM: WINDOWS. NEVER use Unix commands (ls, find, wc, grep, cat, tail, head, sed, awk, chmod). Use PowerShell (dir/Get-ChildItem, Select-String, Get-Content, Select-Object) or — preferably — the provided tools (list_directory, search_files, read_file) which work on all platforms.'
    : 'PLATFORM: Linux/macOS. Bash commands available via run_command, but prefer the provided tools (list_directory, search_files, read_file) when they fit.';

  return basePrompt + `

You are an autonomous coding agent with tool access. Complete the task using ONLY the provided tools.

CRITICAL — TOOL CALLS ARE THE ONLY WAY TO MAKE PROGRESS.
Your first response MUST invoke a tool. Use the structured tool-call mechanism the API gives you (a real tool_calls field, or the JSON-array tool-call format if your model uses prompt-injected tools). Do NOT type the words "read_file" or "search_files" inside the message body — that is text, not a tool call, and the task will be killed and retried on a different model. If you reply with a prose plan, an outline, or "I'll start by...", the task fails. The right move is to invoke read_file, list_directory, or search_files immediately to gather information.

RULES:
1. Use tools to read files, make edits, list directories, search code, and run commands.
2. NEVER describe what you would do — actually do it with tools.
3. ONLY modify files explicitly mentioned in the task. Do NOT touch unrelated files.
4. If a build/test fails for reasons UNRELATED to your change, report the failure and stop. Do NOT try to fix pre-existing issues.
5. If a tool call fails, try ONE alternative approach. If that also fails, report the error and stop.
6. LARGE FILES: For files over ~300 lines, use read_file with start_line/end_line to read ONLY the section you need (e.g., read_file({path, start_line: 150, end_line: 200})). Then use replace_lines to edit by line number. NEVER read an entire large file — it wastes context and slows inference. Use search_files first to find the right line numbers if needed.
7. EDIT FAILURES: If edit_file fails with "old_text not found", the file may have been modified by a prior edit. Re-read the file with read_file to see the current content, then retry. For large files, switch to replace_lines instead.
8. When done, respond with a COMPLETE summary that includes the actual data from tool results. Do NOT just say "I called list_directory" — include the actual file/folder names, counts, and content you found.
9. Be efficient — you have limited iterations. Do ONLY what the task asks. If the task says "list directory", just call list_directory once and report. Do NOT write files, run commands, or do extra work unless explicitly asked.
${platformRule}
11. INDENTATION: When editing code, match the file's existing indentation EXACTLY. Read the file first to see its indent style (spaces/tabs and width). Your new_text must use the same indentation as the surrounding code.
12. SEARCH: Use search_files and list_directory for finding files and content. NEVER use find, grep, or rg via run_command — they are slow and may timeout on large projects.
13. READ-ONLY FINAL ANSWERS: If the task asks to inspect, list, summarize, report, scout, or otherwise read only, do not ask what to create or modify. Report the observed tool results and state that no edits were made.

Working directory: ${workingDir}`;
}

function normalizeTaskMetadata(task) {
  if (!task?.metadata) return {};
  if (typeof task.metadata === 'string') {
    try {
      return JSON.parse(task.metadata);
    } catch {
      return {};
    }
  }
  return (task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata))
    ? task.metadata
    : {};
}

function persistAgenticGitSnapshot(task, workingDir, snapshot) {
  const serialized = serializeSnapshot(snapshot, workingDir);
  if (!serialized?.isGitRepo || !task?.id) return;

  const metadata = {
    ...normalizeTaskMetadata(_agenticDeps?.db?.getTask?.(task.id) || task),
    agentic_git_snapshot: serialized,
  };

  try {
    if (typeof _agenticDeps?.db?.updateTask === 'function') {
      _agenticDeps.db.updateTask(task.id, { metadata });
      task.metadata = metadata;
    }
  } catch (err) {
    logger.warn(`[Agentic] Failed to persist git snapshot for task ${task.id}: ${err.message}`);
  }
}

function isTruthyMetadataFlag(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function taskExplicitlyReadOnly(taskDescription, metadata) {
  const safeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {};
  if (
    isTruthyMetadataFlag(safeMetadata.read_only)
    || isTruthyMetadataFlag(safeMetadata.readOnly)
    || isTruthyMetadataFlag(safeMetadata.agentic_read_only)
  ) {
    return true;
  }

  const mode = String(safeMetadata.mode || safeMetadata.task_mode || '').trim().toLowerCase();
  if (mode === 'scout') {
    return true;
  }

  const planTitle = String(
    safeMetadata.plan_task_title
    || safeMetadata.task_title
    || safeMetadata.title
    || ''
  ).trim();
  if (READ_ONLY_PLAN_TITLE_RE.test(planTitle) && !MUTATING_PLAN_TITLE_RE.test(planTitle)) {
    return true;
  }

  return /\bread[-\s]?only\b/i.test(taskDescription)
    || /\b(?:do not|don't)\s+(?:edit|create|delete|modify|write|move|format|change|update)\b[^.!\n\r]*\bfiles?\b/i.test(taskDescription)
    || /\bno\s+(?:file\s+)?(?:edits?|changes?|writes?|modifications?)\b/i.test(taskDescription);
}

function normalizeProviderName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeOptionalModel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isAgenticWorkerCompatibleProvider(provider) {
  const normalizedProvider = normalizeProviderName(provider);
  return !!normalizedProvider && !AGENTIC_WORKER_UNSUPPORTED_PROVIDERS.has(normalizedProvider);
}

function isProviderEnabledAndHealthyForHandoff(db, provider) {
  const normalizedProvider = normalizeProviderName(provider);
  if (!normalizedProvider) return false;

  try {
    const providerConfig = typeof db?.getProvider === 'function'
      ? db.getProvider(normalizedProvider)
      : null;
    if (!providerConfig || !providerConfig.enabled) {
      return false;
    }
  } catch {
    return false;
  }

  if (typeof db?.isProviderHealthy === 'function') {
    try {
      if (!db.isProviderHealthy(normalizedProvider)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

function getNextAgenticChainTarget(chain, currentProvider, currentModel, currentChainPosition = null) {
  if (!Array.isArray(chain) || chain.length === 0) return null;

  if (Number.isInteger(currentChainPosition) && currentChainPosition >= 1 && currentChainPosition < chain.length) {
    return {
      entry: chain[currentChainPosition],
      remainingChain: chain.slice(currentChainPosition),
    };
  }

  const normalizedProvider = normalizeProviderName(currentProvider);
  const normalizedModel = normalizeOptionalModel(currentModel);
  const currentIndex = chain.findIndex((entry) => {
    if (normalizeProviderName(entry?.provider) !== normalizedProvider) return false;
    const entryModel = normalizeOptionalModel(entry?.model);
    if (!normalizedModel || !entryModel) return true;
    return entryModel === normalizedModel;
  });

  if (currentIndex === -1 || currentIndex + 1 >= chain.length) {
    return null;
  }

  return {
    entry: chain[currentIndex + 1],
    remainingChain: chain.slice(currentIndex + 1),
  };
}

function taskLikelyRequiresFileChanges(task) {
  const metadata = normalizeTaskMetadata(task);
  if (metadata.diffusion_role === 'compute') return false;
  if (metadata.factory_internal === true && FACTORY_INTERNAL_STRUCTURED_KINDS.has(String(metadata.kind || '').trim().toLowerCase())) {
    return false;
  }

  const taskDescription = String(task?.task_description || '');
  if (taskExplicitlyReadOnly(taskDescription, metadata)) {
    return false;
  }

  if (/\b(create|add|write|implement|generate|edit|modify|change|update|refactor|rename|fix|remove|delete|replace)\b/i.test(taskDescription)) {
    return true;
  }

  const filePaths = normalizeStringList(metadata.file_paths);
  const requiredPaths = normalizeStringList(metadata.agentic_required_modified_paths ?? metadata.required_modified_paths);
  return filePaths.length > 0 || requiredPaths.length > 0;
}

const NON_CONVERGED_AGENTIC_STOP_REASONS = new Set([
  'actionless_iterations',
  'consecutive_tool_errors',
  'max_iterations',
  'no_progress',
  'output_limit',
  'stuck_loop',
]);

const HARD_FAIL_AGENTIC_STOP_REASONS = new Set([
  'consecutive_tool_errors',
  'empty_final_output',
  'missing_tool_evidence',
]);

function inspectHardFailAgenticStopReason(task, workingDir, agenticPolicy, result) {
  const stopReason = String(result?.stopReason || '').trim();
  const toolCount = Array.isArray(result?.toolLog) ? result.toolLog.length : 0;
  const output = String(result?.output || '').trim();
  if (!output && toolCount === 0 && (!stopReason || stopReason === 'model_finished')) {
    return {
      message: 'Agentic task returned no output and no repository tool evidence (empty_toolless_result).',
      stopReason: 'empty_toolless_result',
      verificationCommand: resolveTaskVerificationCommand(task, workingDir, agenticPolicy),
    };
  }

  if (!HARD_FAIL_AGENTIC_STOP_REASONS.has(stopReason)) {
    return null;
  }

  const taskKind = taskLikelyRequiresFileChanges(task) ? 'modification' : 'inspection';
  const reason = stopReason === 'missing_tool_evidence'
    ? 'stopped without required repository tool evidence'
    : stopReason === 'empty_final_output'
      ? 'stopped without a final answer after repository tool use'
      : 'stopped after repeated tool execution errors';

  return {
    message: `Agentic ${taskKind} task ${reason} (${stopReason}).`,
    stopReason,
    verificationCommand: resolveTaskVerificationCommand(task, workingDir, agenticPolicy),
  };
}

function didAgenticReachMaxIterations(result) {
  const stopReason = String(result?.stopReason || '').trim();
  const output = String(result?.output || '');
  return stopReason === 'max_iterations' || /Task reached maximum iterations/i.test(output);
}

function isNonConvergedAgenticResult(result) {
  const stopReason = String(result?.stopReason || '').trim();
  return didAgenticReachMaxIterations(result) || NON_CONVERGED_AGENTIC_STOP_REASONS.has(stopReason);
}

function shouldEscalateNoOpAgenticResult(task, result) {
  if (!taskLikelyRequiresFileChanges(task)) return false;

  const toolCount = Array.isArray(result?.toolLog) ? result.toolLog.length : 0;
  const changedFileCount = Array.isArray(result?.changedFiles) ? result.changedFiles.length : 0;
  if (changedFileCount > 0) return false;
  if (toolCount === 0) return true;

  return !(result.toolLog || []).some((entry) =>
    ['write_file', 'edit_file', 'replace_lines'].includes(entry?.name)
    && entry?.error !== true
  );
}

function buildIncompleteAgenticFailure(task, workingDir, agenticPolicy, result, maxIterations, provider, model) {
  if (!taskLikelyRequiresFileChanges(task)) return null;

  const stopReason = String(result?.stopReason || '').trim();
  const reachedMaxIterations = didAgenticReachMaxIterations(result);

  if (!isNonConvergedAgenticResult(result)) {
    return null;
  }

  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  if (reachedMaxIterations && !coerceOptionalBoolean(metadata.agentic_fail_on_max_iterations, true)) {
    return null;
  }
  if (!reachedMaxIterations && !coerceOptionalBoolean(metadata.agentic_fail_on_non_convergence, true)) {
    return null;
  }

  const toolCount = Array.isArray(result?.toolLog) ? result.toolLog.length : 0;
  const changedFileCount = Array.isArray(result?.changedFiles) ? result.changedFiles.length : 0;
  const iterationBudget = Number.isFinite(maxIterations) && maxIterations > 0
    ? maxIterations
    : (Number.isFinite(result?.iterations) ? result.iterations : 'unknown');
  const reason = reachedMaxIterations
    ? `exhausted its iteration budget (${iterationBudget}) without converging`
    : `stopped before convergence (${stopReason || 'unknown reason'})`;
  const providerLabel = `${provider || result?.provider || 'agentic'}/${model || result?.model || 'default'}`;

  return {
    message: `Agentic task from ${providerLabel} ${reason}. ${toolCount} tool calls, ${changedFileCount} files changed.`,
    verificationCommand: resolveTaskVerificationCommand(task, workingDir, agenticPolicy),
  };
}

function isProposalApplyMode(task, agenticPolicy = null) {
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  return metadata.ollama_cloud_repo_write_mode === PROPOSAL_APPLY_MODE
    || metadata.cloud_repo_write_mode === PROPOSAL_APPLY_MODE;
}

function proposalModeHasReadOnlyTools(agenticPolicy) {
  const tools = normalizeStringList(agenticPolicy?.toolAllowlist);
  return tools.length > 0 && tools.every((toolName) => PROPOSAL_MODE_READ_TOOLS.has(toolName));
}

function shouldUseProposalApplyMode(task, agenticPolicy = null) {
  return isProposalApplyMode(task, agenticPolicy)
    && taskLikelyRequiresFileChanges(task)
    && proposalModeHasReadOnlyTools(agenticPolicy);
}

function buildProposalApplyComputePrompt(taskDescription, workingDir, metadata = {}) {
  const priorProposalFailure = typeof metadata?.proposal_apply_deterministic_failure_reason === 'string'
    ? metadata.proposal_apply_deterministic_failure_reason
    : (typeof metadata?.agentic_handoff_reason === 'string' && /proposal apply skipped|deterministic proposal apply failed/i.test(metadata.agentic_handoff_reason)
      ? metadata.agentic_handoff_reason
      : (typeof metadata?.fallback_reason === 'string' && /proposal apply skipped|deterministic proposal apply failed/i.test(metadata.fallback_reason)
        ? metadata.fallback_reason
        : ''));
  const priorFailureSection = priorProposalFailure
    ? `\n\n## Prior Proposal Failure\nThe previous proposal was rejected before apply:\n${priorProposalFailure}\n\nCorrect the proposal. Re-read or use the provided current file contents, and make old_text an exact current substring. Do not repeat an old_text block that was already reported as not found. Prefer one larger containing block around the changed symbol when small snippets are fragile.\n`
    : '';

  return `You are the proposal phase for a repository-writing task.

Do not modify files. Inspect or reason about the requested change, then return exact edit instructions for a separate apply agent.

## Original Task
${taskDescription}
${priorFailureSection}

## Output Format
Output ONLY a JSON object, with no Markdown fence and no explanation:
{
  "file_edits": [
    {
      "file": "relative/path/to/file.ext",
      "operations": [
        {
          "type": "replace",
          "old_text": "exact text to find",
          "new_text": "exact replacement text"
        }
      ]
    }
  ]
}

Rules:
- The response must be valid JSON. Escape newlines inside old_text and new_text as \\n, quotes as \\", and backslashes as \\\\.
- Start the response with {"file_edits":[ and end it at the final }.
- Return one file_edits entry per file. The operations field must always be an array, even when there is only one operation.
- Use "type": "create", "old_text": "", and "new_text" equal to the full file content for a new file.
- Use "type": "replace" for edits to existing files. old_text must be an exact substring when the file exists.
- Use "type": "delete" and "new_text": "" only for deletions.
- Deterministic apply processes operations in order. If two edits touch the same method, class, or nearby block, combine them into one larger replace operation instead of returning overlapping old_text snippets.
- For each replace/delete operation, old_text must be unique in the current file before that operation is applied. Do not reuse old_text from the pre-edit version after an earlier operation has changed the same region.
- Prefer one complete function/class replacement over many small replacements when changing signatures, properties, enums, or call sites inside the same symbol. For multi-site edits in one file, use the smallest exact containing block you can quote once.
- Keep paths relative to the working directory.
- Include only the files required by the original task.

Working directory: ${workingDir}`;
}

function buildAgenticTaskPrompt(task, workingDir, budgetChars, agenticPolicy = null) {
  let taskDescription = shouldUseProposalApplyMode(task, agenticPolicy)
    ? buildProposalApplyComputePrompt(task.task_description, workingDir, agenticPolicy?.metadata || normalizeTaskMetadata(task))
    : task.task_description;
  if (agenticPolicy?.readOnly) {
    taskDescription += '\n\nRead-only completion rule: inspect with read tools only, do not create or modify files, and finish by reporting observed facts from the tools. Do not ask what should be created.';
  }
  return preStuffFileContents(taskDescription, workingDir, budgetChars);
}

function shouldRequireToolEvidence(provider, task, workingDir) {
  if (!FREE_AGENTIC_TOOL_EVIDENCE_PROVIDERS.has(normalizeProviderName(provider))) return false;
  if (!workingDir) return false;
  if (!String(task?.task_description || '').trim()) return false;

  // Structured-output tasks (JSON mode) deliberately answer from the
  // prompt alone — they're verdict/classification calls, not exploration.
  // Forcing them to call repository tools first stops the model with
  // missing_tool_evidence even though the model behaved correctly.
  // Observed live on StateTrace 2026-04-26: cerebras/zai-glm-4.7 verify
  // reviewer task killed for "missing_tool_evidence" because the JSON
  // prompt told it not to use tools.
  const metadata = normalizeTaskMetadata(task);
  if (metadata.kind === 'verify_review') return false;
  const rf = metadata.response_format;
  if (rf === 'json_object' || rf === 'json' || (rf && typeof rf === 'object' && rf.type === 'json_object')) {
    return false;
  }
  return true;
}

function isSafeRelativeProposalPath(workingDir, filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  if (path.isAbsolute(filePath)) return false;
  const base = path.resolve(workingDir || process.cwd());
  const resolved = path.resolve(base, filePath);
  const relative = path.relative(base, resolved);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function validateProposalApplyOutput(output, workingDir) {
  const { parseComputeOutput, validateComputeSchema, semanticValidateEdits } = require('../diffusion/compute-output-parser');
  const parsed = parseComputeOutput(output || '');
  if (!parsed) {
    return { valid: false, reason: 'no file_edits JSON found' };
  }

  const validation = validateComputeSchema(parsed);
  if (!validation.valid) {
    return { valid: false, reason: validation.errors.join('; ') };
  }

  const fs = require('fs');
  const semantic = semanticValidateEdits(parsed, (filePath) => {
    const fullPath = path.resolve(workingDir, filePath);
    return fs.readFileSync(fullPath, 'utf-8');
  });

  const warnings = semantic.warnings || [];
  const fileEdits = [];
  for (const edit of semantic.file_edits || []) {
    if (!isSafeRelativeProposalPath(workingDir, edit.file)) {
      warnings.push(`${edit.file}: skipped unsafe path`);
      continue;
    }
    const operations = Array.isArray(edit.operations)
      ? edit.operations.filter((operation) => operation && operation.old_text !== undefined && operation.new_text !== undefined)
      : [];
    if (operations.length === 0) {
      warnings.push(`${edit.file}: skipped empty operations`);
      continue;
    }
    fileEdits.push({ ...edit, operations });
  }

  if (fileEdits.length === 0) {
    return { valid: false, reason: 'proposal contained no safe file edits', warnings };
  }

  return {
    valid: true,
    computeOutput: { ...parsed, file_edits: fileEdits },
    warnings,
  };
}

function countExactOccurrences(content, searchText) {
  if (typeof content !== 'string' || typeof searchText !== 'string' || searchText.length === 0) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while (offset < content.length) {
    const index = content.indexOf(searchText, offset);
    if (index === -1) break;
    count += 1;
    offset = index + searchText.length;
  }
  return count;
}

function normalizeTextEol(text, eol) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function inferTextEol(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n';
}

function buildLineEndingCandidates(text) {
  const candidates = [];
  const seen = new Set();
  for (const candidate of [
    String(text),
    normalizeTextEol(text, '\n'),
    normalizeTextEol(text, '\r\n'),
  ]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

function findUniqueReplacementMatch(content, oldText) {
  const exactOccurrences = countExactOccurrences(content, oldText);
  if (exactOccurrences === 1) {
    return { matchedText: oldText, eolNormalized: false };
  }
  if (exactOccurrences > 1) {
    return { error: `exact old_text matched ${exactOccurrences} times` };
  }

  const matches = [];
  for (const candidate of buildLineEndingCandidates(oldText).slice(1)) {
    const occurrences = countExactOccurrences(content, candidate);
    if (occurrences > 1) {
      return { error: `line-ending-normalized old_text matched ${occurrences} times` };
    }
    if (occurrences === 1) {
      matches.push(candidate);
    }
  }

  if (matches.length === 1) {
    return { matchedText: matches[0], eolNormalized: true };
  }
  if (matches.length > 1) {
    return { error: 'line-ending-normalized old_text matched multiple variants' };
  }

  return { error: 'exact old_text was not found' };
}

function applyProposalEditsDeterministically(computeOutput, workingDir) {
  const fs = require('fs');
  const staged = new Map();
  const changedFiles = [];
  const warnings = [];
  let operationCount = 0;

  for (const edit of computeOutput?.file_edits || []) {
    if (!isSafeRelativeProposalPath(workingDir, edit.file)) {
      return { applied: false, reason: `${edit?.file || '(unknown file)'}: unsafe path` };
    }

    const relativePath = edit.file.replace(/\\/g, '/');
    const absolutePath = path.resolve(workingDir, relativePath);
    let content = staged.has(absolutePath)
      ? staged.get(absolutePath)
      : (fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf-8') : null);

    for (const operation of edit.operations || []) {
      const type = String(operation?.type || 'replace').trim().toLowerCase();
      const oldText = operation?.old_text ?? '';
      const newText = operation?.new_text ?? '';

      if (type === 'create' || oldText === '') {
        content = String(newText);
        operationCount += 1;
        continue;
      }

      if (type !== 'replace' && type !== 'delete') {
        return { applied: false, reason: `${relativePath}: unsupported operation type '${type}'` };
      }
      if (content === null) {
        return { applied: false, reason: `${relativePath}: file does not exist` };
      }

      const replacementText = type === 'delete' ? '' : String(newText);
      const match = findUniqueReplacementMatch(content, String(oldText));
      if (match.error) {
        return { applied: false, reason: `${relativePath}: ${match.error}` };
      }
      const finalReplacementText = match.eolNormalized
        ? normalizeTextEol(replacementText, inferTextEol(match.matchedText))
        : replacementText;
      if (match.eolNormalized) {
        warnings.push(`${relativePath}: applied replacement after line-ending normalization`);
      }

      content = content.replace(match.matchedText, finalReplacementText);
      operationCount += 1;
    }

    staged.set(absolutePath, content);
  }

  for (const [absolutePath, nextContent] of staged.entries()) {
    const previousContent = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf-8') : null;
    if (previousContent === nextContent) continue;
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, nextContent, 'utf-8');
    changedFiles.push(path.relative(workingDir, absolutePath).replace(/\\/g, '/'));
  }

  if (changedFiles.length === 0) {
    return { applied: false, reason: 'proposal edits produced no file changes' };
  }

  return { applied: true, changedFiles, operationCount, warnings };
}

function buildProposalApplyTaskDescription(computeOutput, workingDir, originalTaskDescription) {
  const sections = [];
  for (const edit of computeOutput.file_edits || []) {
    sections.push(`### File: ${edit.file}`);
    for (const op of edit.operations || []) {
      const type = typeof op.type === 'string' ? op.type.toLowerCase() : 'replace';
      if (type === 'create' || op.old_text === '') {
        sections.push(`Create or overwrite this file with the exact content below:\n\`\`\`\n${op.new_text || ''}\n\`\`\``);
      } else if (type === 'delete' || op.new_text === '') {
        sections.push(`Delete the following exact block:\n\`\`\`\n${op.old_text}\n\`\`\``);
      } else {
        sections.push(`Replace this exact block:\n\`\`\`\n${op.old_text}\n\`\`\`\nWith this exact block:\n\`\`\`\n${op.new_text}\n\`\`\``);
      }
    }
  }

  return `Apply the following repository edits drafted by the proposal phase.
Make only the listed edits. If an exact replacement block is not found, re-read the target file and apply the smallest equivalent edit.

## Original Task
${originalTaskDescription}

${sections.join('\n\n')}

Working directory: ${workingDir}`;
}

function resolveAgenticHandoffTarget({
  task,
  chain,
  db,
  currentProvider,
  currentModel,
  currentChainPosition = null,
  preferredTarget = null,
}) {
  if (preferredTarget?.provider) {
    return enforceProviderLaneForHandoff(task, {
      entry: preferredTarget,
      remainingChain: Array.isArray(chain) && Number.isInteger(currentChainPosition) && currentChainPosition >= 1
        ? chain.slice(currentChainPosition)
        : [preferredTarget],
    });
  }

  const chainTarget = getNextAgenticChainTarget(chain, currentProvider, currentModel, currentChainPosition);
  if (chainTarget?.entry?.provider) {
    return enforceProviderLaneForHandoff(task, chainTarget);
  }

  const normalizedProvider = normalizeProviderName(currentProvider || task?.provider);
  if (AGENTIC_CLOUD_TO_CODEX_FALLBACKS.has(normalizedProvider) && isProviderEnabledAndHealthyForHandoff(db, 'codex')) {
    return enforceProviderLaneForHandoff(task, {
      entry: { provider: 'codex', model: null },
      remainingChain: [{ provider: 'codex' }],
    });
  }

  return null;
}

// Providers that count as legitimate proposal-apply escape targets. Codex
// is the default; codex-spark is the same CLI with a faster model. Both
// can apply file_edits proposals from a free agentic compute pass.
const PROPOSAL_APPLY_ESCAPE_PROVIDERS = new Set(['codex', 'codex-spark']);

function isProposalApplyEscapeHandoff(task, provider) {
  if (!isProposalApplyMode(task)) return false;
  const metadata = normalizeTaskMetadata(task);
  const configuredApplyProvider = normalizeProviderName(metadata.proposal_apply_provider) || 'codex';
  const target = normalizeProviderName(provider);
  return target === configuredApplyProvider || PROPOSAL_APPLY_ESCAPE_PROVIDERS.has(target);
}

function enforceProviderLaneForHandoff(task, target) {
  const provider = target?.entry?.provider;
  if (!provider) return target;
  const metadata = normalizeTaskMetadata(task);
  if (isProviderLaneHandoffAllowed(metadata, provider)) return target;
  // Proposal-apply escape: when a task is in compute→apply mode (free
  // agentic provider runs the compute pass, codex applies the file_edits),
  // a lane policy that blocks codex defeats the entire mode. Observed live
  // 2026-04-25/26: 22 ollama-cloud/mistral-large-3 tasks failed when their
  // proposal-apply mismatched the source file (the compute model couldn't
  // quote exact old_text), and the lane policy then refused codex handoff,
  // leaving no recovery path. The escape is narrowly scoped to the
  // proposal-apply-target providers, so general lane enforcement still
  // blocks unrelated escalations.
  if (isProposalApplyEscapeHandoff(task, provider)) {
    logger.info(`[Agentic] Lane policy bypassed for proposal-apply recovery → ${provider}`);
    return target;
  }
  logger.info(`[Agentic] ${providerLaneHandoffBlockReason(metadata, provider)}`);
  return null;
}

function resolveProviderLaneHandoffBlockReason({
  task,
  chain,
  currentProvider,
  currentModel,
  currentChainPosition = null,
  preferredTarget = null,
}) {
  const metadata = normalizeTaskMetadata(task);
  let targetProvider = normalizeProviderName(preferredTarget?.provider);
  if (!targetProvider) {
    const chainTarget = getNextAgenticChainTarget(chain, currentProvider, currentModel, currentChainPosition);
    targetProvider = normalizeProviderName(chainTarget?.entry?.provider);
  }
  if (!targetProvider) {
    const normalizedProvider = normalizeProviderName(currentProvider || task?.provider);
    if (AGENTIC_CLOUD_TO_CODEX_FALLBACKS.has(normalizedProvider)) {
      targetProvider = 'codex';
    }
  }
  if (!targetProvider) return null;
  // Mirror the proposal-apply escape from enforceProviderLaneForHandoff:
  // if the lane would block but this is a legitimate proposal-apply
  // recovery handoff, there is no real block to report.
  if (isProposalApplyEscapeHandoff(task, targetProvider)) return null;
  return providerLaneHandoffBlockReason(metadata, targetProvider);
}

function buildAgenticHandoffPatch(task, targetEntry, remainingChain, reason, options = {}) {
  const existingMetadata = normalizeTaskMetadata(task);
  const sourceProvider = normalizeProviderName(task?.provider || existingMetadata.intended_provider || existingMetadata.requested_provider);
  const targetProvider = normalizeProviderName(targetEntry.provider) || targetEntry.provider;
  const originalUserOverride = Boolean(existingMetadata.user_provider_override || existingMetadata.original_user_provider_override);
  const handoffMode = options.mode || 'button_up';
  const metadata = {
    ...existingMetadata,
    user_provider_override: false,
    ...(originalUserOverride ? { original_user_provider_override: true } : {}),
    provider_selection_locked: true,
    provider_selection_lock_reason: 'agentic_handoff',
    agentic_handoff: true,
    agentic_handoff_mode: handoffMode,
    agentic_handoff_from: sourceProvider || task?.provider || null,
    agentic_handoff_to: targetProvider,
    agentic_handoff_target_model: targetEntry.model || null,
    agentic_button_up: handoffMode === 'button_up' || undefined,
    fallback_provider: targetProvider,
    fallback_from_provider: sourceProvider || task?.provider || null,
    fallback_reason: reason,
    intended_provider: targetProvider,
    requested_provider: targetProvider,
    requested_model: targetEntry.model || null,
    eligible_providers: [targetProvider],
    agentic_handoff_reason: reason,
    agentic_handoff_at: new Date().toISOString(),
  };

  if (!metadata.original_requested_provider) {
    metadata.original_requested_provider = existingMetadata.requested_provider
      || sourceProvider
      || task?.provider
      || targetProvider;
  }

  if (Array.isArray(remainingChain) && remainingChain.length > 1) {
    metadata._routing_chain = remainingChain;
  } else {
    delete metadata._routing_chain;
  }

  return {
    started_at: null,
    completed_at: null,
    pid: null,
    progress_percent: null,
    exit_code: null,
    mcp_instance_id: null,
    ollama_host_id: null,
    output: null,
    error_output: null,
    provider: targetEntry.provider,
    model: targetEntry.model || null,
    metadata,
    _provider_switch_reason: reason,
  };
}

function requeueAgenticTaskForHandoff(db, taskId, task, targetEntry, remainingChain, reason) {
  if (!db || typeof db.updateTaskStatus !== 'function') {
    throw new Error(`Cannot hand off task ${taskId}: database updateTaskStatus is unavailable`);
  }

  const patch = buildAgenticHandoffPatch(task, targetEntry, remainingChain, reason);
  return db.updateTaskStatus(taskId, 'queued', patch);
}

function resolveProviderLaneProposalApplyTarget(task, metadata) {
  const policy = getProviderLanePolicyFromMetadata(metadata);
  const laneProvider = normalizeProviderName(policy?.expected_provider);
  if (!policy?.enforce_handoffs || !laneProvider) {
    return null;
  }
  if (!isAgenticWorkerCompatibleProvider(laneProvider)) {
    return null;
  }
  if (!isProviderLaneHandoffAllowed(metadata, laneProvider)) {
    return null;
  }

  const laneModel = normalizeOptionalModel(metadata.proposal_apply_lane_model)
    || normalizeOptionalModel(task?.model)
    || normalizeOptionalModel(metadata.requested_model);
  const entry = {
    provider: laneProvider,
    ...(laneModel ? { model: laneModel } : {}),
  };
  return {
    entry,
    remainingChain: [entry],
  };
}

function resolveProposalApplyTarget(task, db) {
  const metadata = normalizeTaskMetadata(task);
  const preferredProvider = normalizeProviderName(metadata.proposal_apply_provider || 'codex') || 'codex';
  const preferredModel = normalizeOptionalModel(metadata.proposal_apply_model);
  if (preferredProvider && isProviderEnabledAndHealthyForHandoff(db, preferredProvider)) {
    const preferredTarget = enforceProviderLaneForHandoff(task, {
      entry: { provider: preferredProvider, model: preferredModel },
      remainingChain: [{ provider: preferredProvider, ...(preferredModel ? { model: preferredModel } : {}) }],
    });
    if (preferredTarget?.entry?.provider) {
      return preferredTarget;
    }
  }

  const chainTarget = resolveAgenticHandoffTarget({
    task,
    chain: metadata._routing_chain,
    db,
    currentProvider: task?.provider,
    currentModel: task?.model || null,
  });
  if (chainTarget?.entry?.provider) {
    return chainTarget;
  }

  return resolveProviderLaneProposalApplyTarget(task, metadata);
}

function buildProposalApplyHandoffPatch(task, targetEntry, remainingChain, reason, proposalResult, sourceResult) {
  const patch = buildAgenticHandoffPatch(task, targetEntry, remainingChain, reason, { mode: 'proposal_apply' });
  const originalMetadata = normalizeTaskMetadata(task);
  const targetProvider = normalizeProviderName(targetEntry?.provider) || targetEntry?.provider || null;
  const metadata = {
    ...patch.metadata,
    proposal_apply: true,
    proposal_apply_provider: targetProvider,
    proposal_apply_parse_status: 'valid',
    proposal_apply_from: sourceResult?.provider || task?.provider || null,
    proposal_apply_source_model: sourceResult?.model || task?.model || null,
    proposal_apply_mode: 'provider_handoff',
    proposal_apply_warnings: proposalResult.warnings || [],
    proposal_compute_output: proposalResult.computeOutput,
    original_task_description: originalMetadata.original_task_description || task?.task_description || '',
  };
  const deterministicFailureReason = sourceResult?.deterministic_apply_failure_reason
    || sourceResult?.deterministicApplyFailureReason
    || null;
  if (deterministicFailureReason) {
    metadata.proposal_apply_deterministic_apply_failed = true;
    metadata.proposal_apply_deterministic_failure_reason = deterministicFailureReason;
  }

  delete metadata.ollama_cloud_repo_write_mode;
  delete metadata.cloud_repo_write_mode;
  delete metadata.agentic_allowed_tools;
  delete metadata.agentic_tool_allowlist;
  delete metadata.allowed_tools;
  delete metadata.tool_allowlist;

  return {
    ...patch,
    task_description: buildProposalApplyTaskDescription(
      proposalResult.computeOutput,
      task?.working_directory || process.cwd(),
      task?.task_description || ''
    ),
    metadata,
  };
}

function requeueAgenticTaskForProposalApply(db, taskId, task, proposalResult, sourceResult, reason) {
  if (!db || typeof db.updateTaskStatus !== 'function') {
    throw new Error(`Cannot hand off task ${taskId}: database updateTaskStatus is unavailable`);
  }
  const target = resolveProposalApplyTarget(task, db);
  if (!target?.entry?.provider) {
    const metadata = normalizeTaskMetadata(task);
    const preferredProvider = normalizeProviderName(metadata.proposal_apply_provider || 'codex') || 'codex';
    return {
      requeued: false,
      reason: providerLaneHandoffBlockReason(metadata, preferredProvider)
        || 'no proposal apply provider available',
    };
  }

  const patch = buildProposalApplyHandoffPatch(task, target.entry, target.remainingChain, reason, proposalResult, sourceResult);
  db.updateTaskStatus(taskId, 'queued', patch);
  return { requeued: true, target };
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeUniqueStrings(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const entry of group || []) {
      const normalized = entry.replace(/\\/g, '/').toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(entry);
    }
  }
  return merged;
}

function collectMarkdownBullets(markdown, headings) {
  const targetHeadings = new Set(headings.map((heading) => heading.toLowerCase()));
  const lines = String(markdown || '').split(/\r?\n/);
  const bullets = [];
  let inTargetSection = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const headingMatch = /^##\s+(.+?)\s*$/.exec(trimmed);
    if (headingMatch) {
      const heading = headingMatch[1].trim().toLowerCase();
      if (inTargetSection && !targetHeadings.has(heading)) break;
      inTargetSection = targetHeadings.has(heading);
      continue;
    }
    if (!inTargetSection) continue;
    const bulletMatch = /^\s*[-*]\s+`?(.+?)`?\s*$/.exec(rawLine);
    if (bulletMatch) bullets.push(bulletMatch[1].trim());
  }

  return bullets;
}

function collectMarkdownSectionLines(markdown, headings) {
  const targetHeadings = new Set(headings.map((heading) => heading.toLowerCase()));
  const lines = String(markdown || '').split(/\r?\n/);
  const sectionLines = [];
  let inTargetSection = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const headingMatch = /^##\s+(.+?)\s*$/.exec(trimmed);
    if (headingMatch) {
      const heading = headingMatch[1].trim().toLowerCase();
      if (inTargetSection && !targetHeadings.has(heading)) break;
      inTargetSection = targetHeadings.has(heading);
      continue;
    }
    if (!inTargetSection) continue;
    sectionLines.push(rawLine);
  }

  return sectionLines;
}

function stripWrappingBackticks(value) {
  const trimmed = String(value || '').trim();
  const backtickMatch = /^`([^`]+)`$/.exec(trimmed);
  return backtickMatch ? backtickMatch[1].trim() : trimmed;
}

function collectMarkdownSectionText(markdown, headings) {
  return collectMarkdownSectionLines(markdown, headings)
    .map((line) => stripWrappingBackticks(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

function collectJsonSpecList(spec, keys) {
  for (const key of keys) {
    const value = spec?.[key];
    if (Array.isArray(value)) {
      return value
        .map((entry) => typeof entry === 'string' ? entry.trim() : '')
        .filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }
  }
  return [];
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNextTaskMarkdownSpec(markdown) {
  return {
    goal: collectMarkdownSectionText(markdown, ['Goal']),
    why_now: collectMarkdownSectionText(markdown, ['Why Now']),
    read_files: collectMarkdownBullets(markdown, ['Read Files', 'Read Paths']),
    specific_actions: collectMarkdownBullets(markdown, ['Specific Actions']),
    allowed_files: collectMarkdownBullets(markdown, ['Allowed Files', 'Allowed Paths', 'Write Files', 'Write Paths']),
    allowed_tools: collectMarkdownBullets(markdown, ['Allowed Tools', 'Tool Allowlist']),
    required_modified_paths: collectMarkdownBullets(markdown, ['Required Modified Paths', 'Required Modified Files']),
    verification_command: collectMarkdownSectionText(markdown, ['Verification Command']),
    actionless_iteration_limit: collectMarkdownSectionText(markdown, ['Actionless Iteration Limit']),
    stop_conditions: collectMarkdownBullets(markdown, ['Stop Conditions']),
  };
}

function normalizeComparableString(value) {
  return stripWrappingBackticks(String(value || ''))
    .replace(/`/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => stripWrappingBackticks(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function normalizeComparableList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeComparableString(entry))
    .filter(Boolean);
}

function compareNextTaskSpecs(markdownSpec, jsonSpec) {
  const fieldComparisons = [
    ['goal', normalizeComparableString(markdownSpec.goal), normalizeComparableString(jsonSpec.goal)],
    ['why_now', normalizeComparableString(markdownSpec.why_now), normalizeComparableString(jsonSpec.why_now)],
    ['read_files', normalizeComparableList(markdownSpec.read_files), normalizeComparableList(collectJsonSpecList(jsonSpec, ['read_files', 'readFiles', 'read_paths', 'readPaths']))],
    ['specific_actions', normalizeComparableList(markdownSpec.specific_actions), normalizeComparableList(collectJsonSpecList(jsonSpec, ['specific_actions', 'specificActions']))],
    ['allowed_files', normalizeComparableList(markdownSpec.allowed_files), normalizeComparableList(collectJsonSpecList(jsonSpec, ['allowed_files', 'allowedFiles', 'write_files', 'writeFiles', 'allowed_paths', 'allowedPaths', 'write_paths', 'writePaths']))],
    ['allowed_tools', normalizeComparableList(markdownSpec.allowed_tools), normalizeComparableList(collectJsonSpecList(jsonSpec, ['allowed_tools', 'allowedTools', 'tool_allowlist', 'toolAllowlist']))],
    ['required_modified_paths', normalizeComparableList(markdownSpec.required_modified_paths), normalizeComparableList(collectJsonSpecList(jsonSpec, ['required_modified_paths', 'requiredModifiedPaths']))],
    ['verification_command', normalizeComparableString(markdownSpec.verification_command), normalizeComparableString(jsonSpec.verification_command ?? jsonSpec.verificationCommand)],
    ['actionless_iteration_limit', normalizeComparableString(markdownSpec.actionless_iteration_limit), normalizeComparableString(jsonSpec.actionless_iteration_limit ?? jsonSpec.actionlessIterationLimit)],
    ['stop_conditions', normalizeComparableList(markdownSpec.stop_conditions), normalizeComparableList(collectJsonSpecList(jsonSpec, ['stop_conditions', 'stopConditions']))],
  ];

  const mismatchedFields = fieldComparisons
    .filter(([, markdownValue, jsonValue]) => JSON.stringify(markdownValue) !== JSON.stringify(jsonValue))
    .map(([fieldName]) => fieldName);

  return {
    synced: mismatchedFields.length === 0,
    comparedFields: fieldComparisons.map(([fieldName]) => fieldName),
    mismatchedFields,
  };
}

function extractNextTaskPathPolicy(nextTaskPath, nextTaskJsonPath, workingDir) {
  const fs = require('fs');
  const baseReadPaths = mergeUniqueStrings(
    nextTaskJsonPath ? [nextTaskJsonPath] : [],
    nextTaskPath ? [nextTaskPath] : [],
  );

  if (nextTaskJsonPath) {
    const resolvedNextTaskJsonPath = path.resolve(workingDir, nextTaskJsonPath);
    if (fs.existsSync(resolvedNextTaskJsonPath)) {
      try {
        const spec = JSON.parse(fs.readFileSync(resolvedNextTaskJsonPath, 'utf-8'));
        const readPaths = collectJsonSpecList(spec, ['read_files', 'readFiles', 'read_paths', 'readPaths']);
        const writePaths = collectJsonSpecList(spec, [
          'allowed_files',
          'allowedFiles',
          'write_files',
          'writeFiles',
          'allowed_paths',
          'allowedPaths',
          'write_paths',
          'writePaths',
        ]);
        return {
          readPaths: mergeUniqueStrings(baseReadPaths, readPaths, writePaths),
          writePaths,
        };
      } catch {
        // Fall back to the markdown task spec if the JSON file is missing or invalid.
      }
    }
  }

  if (!nextTaskPath) {
    return { readPaths: baseReadPaths, writePaths: [] };
  }

  const resolvedNextTaskPath = path.resolve(workingDir, nextTaskPath);
  if (!fs.existsSync(resolvedNextTaskPath)) {
    return { readPaths: baseReadPaths, writePaths: [] };
  }
  const markdown = fs.readFileSync(resolvedNextTaskPath, 'utf-8');
  const readPaths = collectMarkdownBullets(markdown, ['Read Files', 'Read Paths']);
  const writePaths = collectMarkdownBullets(markdown, ['Allowed Files', 'Allowed Paths', 'Write Files', 'Write Paths']);

  return {
    readPaths: mergeUniqueStrings(baseReadPaths, readPaths, writePaths),
    writePaths,
  };
}

function buildTaskAgenticPolicy(task, workingDir, serverConfig) {
  const metadata = buildEffectiveAgenticMetadata(task, workingDir);
  const constraintsFromNextTask = coerceOptionalBoolean(metadata.agentic_constraints_from_next_task, false);
  let readAllowlist = normalizeStringList(metadata.agentic_allowed_read_paths);
  let writeAllowlist = normalizeStringList(metadata.agentic_allowed_write_paths);
  const writeAfterReadPaths = normalizeStringList(
    metadata.agentic_write_after_read_paths ?? metadata.agentic_initial_read_paths
  );
  let toolAllowlist = normalizeStringList(
    metadata.agentic_allowed_tools ?? metadata.allowed_tools ?? metadata.agentic_tool_allowlist ?? metadata.tool_allowlist
  );
  const taskSpec = constraintsFromNextTask ? loadTaskSpecFromMetadata(metadata, workingDir) : null;

  if (constraintsFromNextTask) {
    const nextTaskPath = (typeof metadata.agentic_next_task_path === 'string' && metadata.agentic_next_task_path.trim())
      ? metadata.agentic_next_task_path.trim()
      : 'docs/autodev/NEXT_TASK.md';
    const nextTaskJsonPath = (typeof metadata.agentic_next_task_json_path === 'string' && metadata.agentic_next_task_json_path.trim())
      ? metadata.agentic_next_task_json_path.trim()
      : (nextTaskPath.endsWith('.md') ? `${nextTaskPath.slice(0, -3)}.json` : '');
    const nextTaskPolicy = extractNextTaskPathPolicy(nextTaskPath, nextTaskJsonPath, workingDir);
    readAllowlist = mergeUniqueStrings(readAllowlist, nextTaskPolicy.readPaths);
    writeAllowlist = mergeUniqueStrings(writeAllowlist, nextTaskPolicy.writePaths);
  }

  if (toolAllowlist.length === 0) {
    if (taskSpec?.spec) {
      toolAllowlist = taskSpec.source === 'json'
        ? collectJsonSpecList(taskSpec.spec, ['allowed_tools', 'allowedTools', 'tool_allowlist', 'toolAllowlist'])
        : normalizeStringList(taskSpec.spec.allowed_tools);
    }
  }

  const metadataCommandAllowlist = normalizeStringList(
    metadata.agentic_allowed_commands ?? metadata.agentic_command_allowlist
  );
  let commandMode = typeof metadata.agentic_command_mode === 'string'
    ? metadata.agentic_command_mode
    : (serverConfig.get('agentic_command_mode') || 'unrestricted');
  const commandAllowlist = metadataCommandAllowlist.length > 0 || Array.isArray(metadata.agentic_allowed_commands)
    ? metadataCommandAllowlist
    : (serverConfig.get('agentic_command_allowlist') || '').split(',').filter(Boolean);
  if (Array.isArray(metadata.agentic_allowed_commands)) {
    commandMode = 'allowlist';
  }

  const specMaxIterations = (() => {
    if (!taskSpec?.spec) return null;
    return taskSpec.source === 'json'
      ? parsePositiveInteger(taskSpec.spec.max_iterations ?? taskSpec.spec.maxIterations)
      : parsePositiveInteger(taskSpec.spec.max_iterations);
  })();
  const parsedMaxIterations = parsePositiveInteger(
    metadata.agentic_max_iterations
      ?? metadata.max_iterations
      ?? specMaxIterations
  );
  const specActionlessLimit = (() => {
    if (!taskSpec?.spec) return null;
    return taskSpec.source === 'json'
      ? parsePositiveInteger(taskSpec.spec.actionless_iteration_limit ?? taskSpec.spec.actionlessIterationLimit)
      : parsePositiveInteger(taskSpec.spec.actionless_iteration_limit);
  })();
  const actionlessIterationLimit = parsePositiveInteger(
    metadata.agentic_actionless_iteration_limit
      ?? metadata.actionless_iteration_limit
      ?? specActionlessLimit
  );
  const diagnosticReadLimitAfterFailedCommand = parsePositiveInteger(
    metadata.agentic_diagnostic_read_limit_after_failed_command
      ?? metadata.agentic_read_budget_after_failed_command
  );

  return {
    metadata,
    readOnly: taskExplicitlyReadOnly(task.task_description || '', metadata),
    readAllowlist,
    writeAllowlist,
    writeAfterReadPaths,
    toolAllowlist,
    commandMode,
    commandAllowlist,
    actionlessIterationLimit,
    diagnosticReadLimitAfterFailedCommand,
    maxIterations: parsedMaxIterations,
  };
}

function resolveAutodevSessionLogPath(metadata, nextTaskPath) {
  const explicitPath = typeof metadata?.agentic_session_log_path === 'string' && metadata.agentic_session_log_path.trim()
    ? metadata.agentic_session_log_path.trim()
    : null;
  if (explicitPath) return explicitPath;

  const normalizedNextTaskPath = typeof nextTaskPath === 'string' && nextTaskPath.trim()
    ? nextTaskPath.trim().replace(/\\/g, '/')
    : null;
  if (!normalizedNextTaskPath) return null;

  const nextTaskDir = path.posix.dirname(normalizedNextTaskPath);
  return nextTaskDir && nextTaskDir !== '.'
    ? `${nextTaskDir}/SESSION_LOG.md`
    : 'SESSION_LOG.md';
}

function maybeShortCircuitPlanningTask(task, workingDir, agenticPolicy) {
  const fs = require('fs');
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  if (!metadata.agentic_noop_when_task_spec_synced) return null;
  if (resolveRequiredModifiedPaths(task, workingDir, agenticPolicy).length > 0) return null;

  const nextTaskPath = (typeof metadata.agentic_next_task_path === 'string' && metadata.agentic_next_task_path.trim())
    ? metadata.agentic_next_task_path.trim()
    : 'docs/autodev/NEXT_TASK.md';
  const nextTaskJsonPath = (typeof metadata.agentic_next_task_json_path === 'string' && metadata.agentic_next_task_json_path.trim())
    ? metadata.agentic_next_task_json_path.trim()
    : (nextTaskPath.endsWith('.md') ? `${nextTaskPath.slice(0, -3)}.json` : '');
  if (!nextTaskJsonPath) return null;

  const resolvedMarkdownPath = path.resolve(workingDir, nextTaskPath);
  const resolvedJsonPath = path.resolve(workingDir, nextTaskJsonPath);
  if (!fs.existsSync(resolvedMarkdownPath) || !fs.existsSync(resolvedJsonPath)) return null;

  try {
    const markdown = fs.readFileSync(resolvedMarkdownPath, 'utf-8');
    const jsonSpec = JSON.parse(fs.readFileSync(resolvedJsonPath, 'utf-8'));
    const comparison = compareNextTaskSpecs(parseNextTaskMarkdownSpec(markdown), jsonSpec);
    if (!comparison.synced) return null;

    const sessionLogPath = resolveAutodevSessionLogPath(metadata, nextTaskPath);
    if (sessionLogPath) {
      const resolvedSessionLogPath = path.resolve(workingDir, sessionLogPath);
      if (fs.existsSync(resolvedSessionLogPath)) {
        const sessionLogMtime = fs.statSync(resolvedSessionLogPath).mtimeMs;
        const latestSpecMtime = Math.max(
          fs.statSync(resolvedMarkdownPath).mtimeMs,
          fs.statSync(resolvedJsonPath).mtimeMs,
        );
        if (Number.isFinite(sessionLogMtime) && sessionLogMtime > latestSpecMtime) {
          return null;
        }
      }
    }

    return {
      output: `Planning short-circuit: ${nextTaskPath} already matches ${nextTaskJsonPath}. No planning changes required.`,
      taskMetadata: {
        agentic_noop_planning: true,
        agentic_noop_reason: 'task_spec_synced',
        compared_fields: comparison.comparedFields,
        next_task_path: nextTaskPath,
        next_task_json_path: nextTaskJsonPath,
      },
    };
  } catch {
    return null;
  }
}

function coerceOptionalBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return defaultValue;
}

function resolveNextTaskSpecPaths(metadata) {
  const nextTaskPath = (typeof metadata?.agentic_next_task_path === 'string' && metadata.agentic_next_task_path.trim())
    ? metadata.agentic_next_task_path.trim()
    : 'docs/autodev/NEXT_TASK.md';
  const nextTaskJsonPath = (typeof metadata?.agentic_next_task_json_path === 'string' && metadata.agentic_next_task_json_path.trim())
    ? metadata.agentic_next_task_json_path.trim()
    : (nextTaskPath.endsWith('.md') ? `${nextTaskPath.slice(0, -3)}.json` : '');
  return { nextTaskPath, nextTaskJsonPath };
}

function loadTaskSpecFromMetadata(metadata, workingDir) {
  const fs = require('fs');
  const { nextTaskPath, nextTaskJsonPath } = resolveNextTaskSpecPaths(metadata);

  if (nextTaskJsonPath) {
    const resolvedJsonPath = path.resolve(workingDir, nextTaskJsonPath);
    if (fs.existsSync(resolvedJsonPath)) {
      try {
        return {
          source: 'json',
          path: nextTaskJsonPath,
          spec: JSON.parse(fs.readFileSync(resolvedJsonPath, 'utf-8')),
        };
      } catch {
        // Fall through to markdown when the JSON spec is invalid.
      }
    }
  }

  if (nextTaskPath) {
    const resolvedMarkdownPath = path.resolve(workingDir, nextTaskPath);
    if (fs.existsSync(resolvedMarkdownPath)) {
      return {
        source: 'markdown',
        path: nextTaskPath,
        spec: parseNextTaskMarkdownSpec(fs.readFileSync(resolvedMarkdownPath, 'utf-8')),
      };
    }
  }

  return null;
}

function buildEffectiveAgenticMetadata(task, workingDir) {
  const metadata = normalizeTaskMetadata(task);
  const effectiveMetadata = { ...metadata };
  if (!coerceOptionalBoolean(metadata.agentic_constraints_from_next_task, false)) {
    return effectiveMetadata;
  }

  const { nextTaskPath, nextTaskJsonPath } = resolveNextTaskSpecPaths(metadata);
  const nextTaskPolicy = extractNextTaskPathPolicy(nextTaskPath, nextTaskJsonPath, workingDir);
  const taskSpec = loadTaskSpecFromMetadata(metadata, workingDir);

  const readAllowlist = mergeUniqueStrings(
    normalizeStringList(metadata.agentic_allowed_read_paths),
    nextTaskPolicy.readPaths,
  );
  const writeAllowlist = mergeUniqueStrings(
    normalizeStringList(metadata.agentic_allowed_write_paths),
    nextTaskPolicy.writePaths,
  );
  if (readAllowlist.length > 0 || Array.isArray(metadata.agentic_allowed_read_paths)) {
    effectiveMetadata.agentic_allowed_read_paths = readAllowlist;
  }
  if (writeAllowlist.length > 0 || Array.isArray(metadata.agentic_allowed_write_paths)) {
    effectiveMetadata.agentic_allowed_write_paths = writeAllowlist;
  }

  const explicitToolAllowlist = normalizeStringList(
    metadata.agentic_allowed_tools ?? metadata.allowed_tools ?? metadata.agentic_tool_allowlist ?? metadata.tool_allowlist
  );
  const specToolAllowlist = !taskSpec?.spec
    ? []
    : (taskSpec.source === 'json'
      ? collectJsonSpecList(taskSpec.spec, ['allowed_tools', 'allowedTools', 'tool_allowlist', 'toolAllowlist'])
      : normalizeStringList(taskSpec.spec.allowed_tools));
  if (explicitToolAllowlist.length > 0) {
    effectiveMetadata.agentic_allowed_tools = explicitToolAllowlist;
  } else if (specToolAllowlist.length > 0) {
    effectiveMetadata.agentic_allowed_tools = specToolAllowlist;
  }

  const explicitRequiredPaths = normalizeStringList(
    metadata.agentic_required_modified_paths ?? metadata.required_modified_paths
  );
  const specRequiredPaths = !taskSpec?.spec
    ? []
    : (taskSpec.source === 'json'
      ? collectJsonSpecList(taskSpec.spec, ['required_modified_paths', 'requiredModifiedPaths'])
      : normalizeStringList(taskSpec.spec.required_modified_paths));
  if (
    explicitRequiredPaths.length > 0
    || specRequiredPaths.length > 0
    || Array.isArray(metadata.agentic_required_modified_paths)
  ) {
    effectiveMetadata.agentic_required_modified_paths = mergeUniqueStrings(explicitRequiredPaths, specRequiredPaths);
  }

  const explicitVerificationCommand = typeof metadata.agentic_verification_command === 'string'
    ? metadata.agentic_verification_command
    : metadata.verification_command;
  const specVerificationCommand = !taskSpec?.spec
    ? ''
    : (taskSpec.source === 'json'
      ? (taskSpec.spec.verification_command ?? taskSpec.spec.verificationCommand ?? '')
      : (taskSpec.spec.verification_command || ''));
  const verificationCommand = stripWrappingBackticks(explicitVerificationCommand || specVerificationCommand || '');
  if (verificationCommand) {
    effectiveMetadata.agentic_verification_command = verificationCommand;
  }

  const explicitCommandAllowlist = normalizeStringList(
    metadata.agentic_allowed_commands ?? metadata.agentic_command_allowlist
  );
  if (explicitCommandAllowlist.length > 0 || Array.isArray(metadata.agentic_allowed_commands)) {
    effectiveMetadata.agentic_allowed_commands = explicitCommandAllowlist;
    effectiveMetadata.agentic_command_mode = 'allowlist';
  } else if (verificationCommand) {
    // Constrained NEXT_TASK executors should not get arbitrary shell access.
    effectiveMetadata.agentic_allowed_commands = [verificationCommand];
    effectiveMetadata.agentic_command_mode = 'allowlist';
  }

  const explicitActionlessLimit = parsePositiveInteger(
    metadata.agentic_actionless_iteration_limit ?? metadata.actionless_iteration_limit
  );
  const specActionlessLimit = !taskSpec?.spec
    ? null
    : (taskSpec.source === 'json'
      ? parsePositiveInteger(taskSpec.spec.actionless_iteration_limit ?? taskSpec.spec.actionlessIterationLimit)
      : parsePositiveInteger(taskSpec.spec.actionless_iteration_limit));
  if (explicitActionlessLimit) {
    effectiveMetadata.agentic_actionless_iteration_limit = explicitActionlessLimit;
  } else if (specActionlessLimit) {
    effectiveMetadata.agentic_actionless_iteration_limit = specActionlessLimit;
  }

  return effectiveMetadata;
}

function maybePersistEffectiveAgenticMetadata(task, db, workingDir) {
  const originalMetadata = normalizeTaskMetadata(task);
  const effectiveMetadata = buildEffectiveAgenticMetadata(task, workingDir);
  task.metadata = effectiveMetadata;

  if (!db || typeof db.updateTask !== 'function' || !task?.id) {
    return effectiveMetadata;
  }
  if (JSON.stringify(originalMetadata) === JSON.stringify(effectiveMetadata)) {
    return effectiveMetadata;
  }

  try {
    db.updateTask(task.id, { metadata: effectiveMetadata });
  } catch (err) {
    logger.info(`[Agentic] Failed to persist synced metadata for task ${task.id}: ${err.message}`);
  }

  return effectiveMetadata;
}

function normalizeChangedFileList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeChangedFiles(...groups) {
  return mergeUniqueStrings(...groups.map((group) => normalizeChangedFileList(group)));
}

function toRelativeDisplayPath(filePath, workingDir) {
  if (typeof filePath !== 'string' || !filePath.trim()) return '';
  const absolutePath = path.resolve(workingDir, filePath);
  const relativePath = path.relative(workingDir, absolutePath);
  return (relativePath && !relativePath.startsWith('..'))
    ? relativePath.replace(/\\/g, '/')
    : absolutePath.replace(/\\/g, '/');
}

function resolveAgenticSessionLogTarget(task, workingDir, agenticPolicy) {
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  const writeAllowlist = normalizeStringList(agenticPolicy?.writeAllowlist);
  const explicitPath = typeof metadata.agentic_session_log_path === 'string' && metadata.agentic_session_log_path.trim()
    ? metadata.agentic_session_log_path.trim()
    : null;
  const normalizedExplicitPath = explicitPath ? explicitPath.replace(/\\/g, '/').toLowerCase() : null;

  let relativePath = null;
  if (normalizedExplicitPath && writeAllowlist.some((entry) => entry.replace(/\\/g, '/').toLowerCase() === normalizedExplicitPath)) {
    relativePath = explicitPath;
  }
  if (!relativePath) {
    relativePath = writeAllowlist.find((entry) => /(^|\/)session_log\.md$/i.test(entry.replace(/\\/g, '/'))) || null;
  }
  if (!relativePath) return null;

  return {
    relativePath,
    absolutePath: path.resolve(workingDir, relativePath),
  };
}

function summarizeVerificationStatus(verificationCommand, toolLog) {
  if (!verificationCommand) {
    return 'not required';
  }
  const verificationResult = inspectVerificationToolLog(toolLog, verificationCommand);
  if (!verificationResult) {
    return 'passed';
  }
  if (verificationResult.status === 'missing') {
    return 'not run';
  }
  return 'failed';
}

function appendAgenticOutputSection(result, title, message) {
  if (!result || typeof result !== 'object' || !title || !message) return;
  const prefix = typeof result.output === 'string' && result.output.length > 0 ? `${result.output}\n\n` : '';
  result.output = `${prefix}--- ${title} ---\n${message}`;
}

function maybeAppendAgenticSessionLog(task, workingDir, agenticPolicy, result, summary, sessionLogTarget = null) {
  const target = sessionLogTarget || resolveAgenticSessionLogTarget(task, workingDir, agenticPolicy);
  if (!target) return null;

  const fs = require('fs');
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  const taskSpec = loadTaskSpecFromMetadata(metadata, workingDir);
  const goal = stripWrappingBackticks(taskSpec?.spec?.goal || '') || stripWrappingBackticks(task.task_description || '');
  const verificationCommand = summary?.verificationCommand || resolveTaskVerificationCommand(task, workingDir, agenticPolicy);
  const verificationStatus = summarizeVerificationStatus(verificationCommand, result?.toolLog);
  const changedFiles = mergeChangedFiles(result?.changedFiles).filter((entry) => normalizeComparablePath(entry, workingDir) !== normalizeComparablePath(target.absolutePath, workingDir));
  const changedFilesSummary = changedFiles.length > 0
    ? changedFiles.map((entry) => toRelativeDisplayPath(entry, workingDir)).join(', ')
    : 'none';
  const status = summary?.status === 'failed' ? 'failed' : 'completed';
  const outcomeMessage = stripWrappingBackticks(String(summary?.outcomeMessage || (status === 'failed' ? 'Task failed.' : 'Task completed.')))
    .replace(/\s+/g, ' ')
    .trim();
  const marker = `<!-- torque-autodev-log:${task.id} -->`;
  const entryLines = [
    marker,
    `## ${summary?.timestamp || new Date().toISOString()} | ${status} | ${task.id}`,
    `- Goal: ${goal}`,
    `- Files Changed: ${changedFilesSummary}`,
    `- Verification Command: ${verificationCommand || 'not required'}`,
    `- Verification Result: ${verificationStatus}`,
    `- Outcome: ${outcomeMessage}`,
  ];
  if (summary?.revertReport) {
    entryLines.push(`- Notes: ${String(summary.revertReport).replace(/\s+/g, ' ').trim()}`);
  }
  const entry = `${entryLines.join('\n')}\n`;

  try {
    fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
    const existingContent = fs.existsSync(target.absolutePath)
      ? fs.readFileSync(target.absolutePath, 'utf-8')
      : '';
    if (existingContent.includes(marker)) {
      return { appended: false, alreadyPresent: true, ...target };
    }
    const baseContent = existingContent.trim().length > 0
      ? `${existingContent.replace(/\s*$/, '')}\n\n`
      : '# Session Log\n\n';
    fs.writeFileSync(target.absolutePath, `${baseContent}${entry}`, 'utf-8');
    return { appended: true, ...target };
  } catch (error) {
    return {
      appended: false,
      error: error.message,
      ...target,
    };
  }
}

function resolveTaskVerificationCommand(task, workingDir, agenticPolicy) {
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  const explicitCommand = typeof metadata.agentic_verification_command === 'string'
    ? metadata.agentic_verification_command
    : metadata.verification_command;
  if (typeof explicitCommand === 'string' && explicitCommand.trim()) {
    return stripWrappingBackticks(explicitCommand);
  }

  const taskSpec = loadTaskSpecFromMetadata(metadata, workingDir);
  if (!taskSpec?.spec) return null;
  if (taskSpec.source === 'json') {
    return stripWrappingBackticks(taskSpec.spec.verification_command ?? taskSpec.spec.verificationCommand ?? '');
  }
  return stripWrappingBackticks(taskSpec.spec.verification_command || '');
}

function resolveRequiredModifiedPaths(task, workingDir, agenticPolicy) {
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  const explicitPaths = normalizeStringList(
    metadata.agentic_required_modified_paths ?? metadata.required_modified_paths
  );
  const taskSpec = loadTaskSpecFromMetadata(metadata, workingDir);
  const specPaths = !taskSpec?.spec
    ? []
    : (taskSpec.source === 'json'
      ? collectJsonSpecList(taskSpec.spec, ['required_modified_paths', 'requiredModifiedPaths'])
      : normalizeStringList(taskSpec.spec.required_modified_paths));

  if (coerceOptionalBoolean(metadata.agentic_constraints_from_next_task, false)) {
    return mergeUniqueStrings(explicitPaths, specPaths);
  }
  if (explicitPaths.length > 0 || Array.isArray(metadata.agentic_required_modified_paths)) {
    return explicitPaths;
  }
  return specPaths;
}

function normalizeCommandForComparison(value) {
  return stripWrappingBackticks(String(value || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractLoggedCommand(toolEntry) {
  if (typeof toolEntry?.command === 'string' && toolEntry.command.trim()) {
    return toolEntry.command.trim();
  }
  if (typeof toolEntry?.arguments_preview !== 'string') return '';
  try {
    const parsed = JSON.parse(toolEntry.arguments_preview);
    return typeof parsed?.command === 'string' ? parsed.command.trim() : '';
  } catch {
    return '';
  }
}

function inspectVerificationToolLog(toolLog, verificationCommand) {
  const normalizedVerificationCommand = normalizeCommandForComparison(verificationCommand);
  if (!normalizedVerificationCommand) return null;

  const verificationEntries = Array.isArray(toolLog)
    ? toolLog.filter((entry) => entry?.name === 'run_command'
        && normalizeCommandForComparison(extractLoggedCommand(entry)) === normalizedVerificationCommand)
    : [];

  if (verificationEntries.length === 0) {
    return {
      status: 'missing',
      message: `Verification command was required but never executed: ${verificationCommand}`,
    };
  }

  const failedVerification = verificationEntries.find((entry) => {
    if (entry?.error) return true;
    const preview = String(entry?.result_preview || '');
    return /Command failed \(exit|Build FAILED|error CS\d+|MSBUILD : error|Test Run Failed|Unhandled exception/i.test(preview);
  });

  if (failedVerification) {
    return {
      status: 'failed',
      message: `Verification command failed: ${verificationCommand}`,
    };
  }

  return null;
}

function buildGitSafetyOptions(agenticPolicy) {
  return {
    authorizedPaths: Array.isArray(agenticPolicy?.writeAllowlist) ? agenticPolicy.writeAllowlist : [],
  };
}

function shouldRevertFailedAgenticChanges(task, agenticPolicy, result = null) {
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  if (metadata.agentic_revert_changes_on_failure !== undefined && metadata.agentic_revert_changes_on_failure !== null) {
    return coerceOptionalBoolean(metadata.agentic_revert_changes_on_failure, false);
  }
  if (isNonConvergedAgenticResult(result) && taskLikelyRequiresFileChanges(task)) {
    return true;
  }
  const strictExecution = coerceOptionalBoolean(
    metadata.agentic_strict_completion,
    coerceOptionalBoolean(metadata.agentic_constraints_from_next_task, false),
  );
  return strictExecution;
}

function maybeRevertFailedAgenticChanges(task, workingDir, agenticPolicy, snapshot, result) {
  if (!shouldRevertFailedAgenticChanges(task, agenticPolicy, result)) {
    return null;
  }
  if (!snapshot?.isGitRepo) {
    return null;
  }
  const changedFiles = mergeChangedFiles(result?.changedFiles);
  const preservedFiles = new Set(
    mergeChangedFiles(result?.frameworkPreservedFiles)
      .map((entry) => normalizeComparablePath(entry, workingDir))
  );
  const revertCandidates = changedFiles.filter((entry) => !preservedFiles.has(normalizeComparablePath(entry, workingDir)));
  if (revertCandidates.length === 0) {
    return null;
  }
  return revertScopedChanges(workingDir, snapshot, revertCandidates);
}

function normalizeComparablePath(value, workingDir) {
  const resolved = path.resolve(workingDir, String(value || '').trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function inspectRequiredModifiedPaths(changedFiles, requiredPaths, workingDir) {
  if (!Array.isArray(requiredPaths) || requiredPaths.length === 0) return null;
  const changedSet = new Set(
    (Array.isArray(changedFiles) ? changedFiles : [])
      .map((entry) => normalizeComparablePath(entry, workingDir))
  );
  const missing = requiredPaths.filter((entry) => !changedSet.has(normalizeComparablePath(entry, workingDir)));
  if (missing.length === 0) return null;
  return {
    missing,
    message: `Required files were not modified: ${missing.join(', ')}`,
  };
}

function evaluateAgenticCompletion(task, workingDir, agenticPolicy, result, maxIterations, gitReport, options = {}) {
  const metadata = agenticPolicy?.metadata || normalizeTaskMetadata(task);
  const hardStopFailure = inspectHardFailAgenticStopReason(task, workingDir, agenticPolicy, result);
  if (hardStopFailure) return hardStopFailure;

  const strictExecution = coerceOptionalBoolean(
    metadata.agentic_strict_completion,
    coerceOptionalBoolean(metadata.agentic_constraints_from_next_task, false),
  );
  if (!strictExecution) return null;

  const failOnMaxIterations = coerceOptionalBoolean(metadata.agentic_fail_on_max_iterations, true);
  const failOnVerification = coerceOptionalBoolean(metadata.agentic_fail_on_verification_error, true);
  const failOnGitRevert = coerceOptionalBoolean(metadata.agentic_fail_on_git_revert, true);
  const failOnMissingRequiredPaths = coerceOptionalBoolean(metadata.agentic_fail_on_missing_required_paths, true);

  const failureMessages = [];
  const verificationCommand = resolveTaskVerificationCommand(task, workingDir, agenticPolicy);
  const requiredModifiedPaths = resolveRequiredModifiedPaths(task, workingDir, agenticPolicy);
  const changedFiles = Array.isArray(options.changedFilesOverride)
    ? options.changedFilesOverride
    : result?.changedFiles;

  if (failOnVerification && verificationCommand) {
    const verificationResult = inspectVerificationToolLog(result?.toolLog, verificationCommand);
    if (verificationResult) failureMessages.push(verificationResult.message);
  }

  const stoppedForActionlessIterations = result?.stopReason === 'actionless_iterations';
  if (stoppedForActionlessIterations) {
    const limit = agenticPolicy?.actionlessIterationLimit;
    const limitSuffix = Number.isFinite(limit) && limit > 0 ? ` (${limit})` : '';
    failureMessages.push(`Agentic task stopped after hitting the actionless iteration limit${limitSuffix} without any write or verification attempt.`);
  }

  const reachedMaxIterations = result?.stopReason === 'max_iterations'
    || /Task reached maximum iterations/i.test(String(result?.output || ''));
  if (failOnMaxIterations && reachedMaxIterations) {
    failureMessages.push(`Agentic task exhausted its iteration budget (${maxIterations}) without converging.`);
  }

  if (failOnGitRevert && Array.isArray(gitReport?.reverted) && gitReport.reverted.length > 0) {
    failureMessages.push(`Git Safety reverted unauthorized changes: ${gitReport.reverted.join(', ')}`);
  }

  if (failOnMissingRequiredPaths && !options.skipRequiredModifiedPaths) {
    const requiredPathResult = inspectRequiredModifiedPaths(changedFiles, requiredModifiedPaths, workingDir);
    if (requiredPathResult) failureMessages.push(requiredPathResult.message);
  }

  if (failureMessages.length === 0) return null;

  return {
    message: failureMessages.join('\n'),
    verificationCommand,
  };
}

function appendTaskPolicyGuidance(systemPrompt, agenticPolicy) {
  const guidance = [];
  if (agenticPolicy?.readOnly) {
    guidance.push('This is a read-only task. Do not create, edit, delete, move, or format files; answer with the observed facts from read tools.');
  }
  if (Array.isArray(agenticPolicy.readAllowlist) && agenticPolicy.readAllowlist.length > 0) {
    guidance.push(`Read scope is restricted to: ${agenticPolicy.readAllowlist.join(', ')}`);
  }
  if (Array.isArray(agenticPolicy.writeAllowlist) && agenticPolicy.writeAllowlist.length > 0) {
    guidance.push(`Write scope is restricted to: ${agenticPolicy.writeAllowlist.join(', ')}`);
  }
  if (Array.isArray(agenticPolicy.writeAfterReadPaths) && agenticPolicy.writeAfterReadPaths.length > 0) {
    guidance.push(`After you read all of these paths, your next tool call must be write_file, edit_file, or replace_lines before any more reads or commands: ${agenticPolicy.writeAfterReadPaths.join(', ')}`);
  }
  if (Number.isFinite(agenticPolicy.diagnosticReadLimitAfterFailedCommand) && agenticPolicy.diagnosticReadLimitAfterFailedCommand > 0) {
    guidance.push(`After a failed run_command, you may use at most ${agenticPolicy.diagnosticReadLimitAfterFailedCommand} diagnostic read_file call(s) before your next tool call must be write_file, edit_file, or replace_lines.`);
  }
  if (agenticPolicy.commandMode === 'allowlist') {
    const commandSummary = agenticPolicy.commandAllowlist.length > 0
      ? agenticPolicy.commandAllowlist.join(', ')
      : 'no commands are allowed';
    guidance.push(`Commands must match this allowlist: ${commandSummary}`);
  }
  if (Array.isArray(agenticPolicy.toolAllowlist) && agenticPolicy.toolAllowlist.length > 0) {
    guidance.push(`Only these tools may be used: ${agenticPolicy.toolAllowlist.join(', ')}`);
  }
  if (Number.isFinite(agenticPolicy.actionlessIterationLimit) && agenticPolicy.actionlessIterationLimit > 0) {
    guidance.push(`Stop after ${agenticPolicy.actionlessIterationLimit} consecutive iterations without any write or verification attempt`);
  }
  if (guidance.length === 0) return systemPrompt;
  return `${systemPrompt}\n\nTask-specific hard constraints:\n- ${guidance.join('\n- ')}`;
}

/**
 * Pre-stuff file contents into the task prompt for agentic providers.
 * Extracts file paths from the task description, reads them, and appends
 * their contents. Converts multi-iteration exploration into single-shot analysis.
 * @param {string} taskDescription - Original task description
 * @param {string} workingDir - Working directory for file resolution
 * @param {number} budgetChars - Max characters to stuff (default: 200000 ≈ 50K tokens)
 * @returns {string} Enriched task prompt
 */
function preStuffFileContents(taskDescription, workingDir, budgetChars = 200000) {
  if (!taskDescription || !workingDir) return taskDescription;
  try {
    const fs = require('fs');
    const filePattern = /\b((?:src|tests?|server|lib|app|docs|scripts?|config|build)\/[\w./-]+\.(?:cs|ts|js|py|java|go|rs|xaml|json|md|sh|yaml|yml|toml))\b/gi;
    const referencedFiles = [...new Set((taskDescription.match(filePattern) || []))];
    if (referencedFiles.length === 0) return taskDescription;

    const stuffedParts = [];
    let totalChars = 0;
    for (const relPath of referencedFiles) {
      const absPath = path.resolve(workingDir, relPath);
      if (!absPath.startsWith(path.resolve(workingDir))) continue;
      try {
        const content = fs.readFileSync(absPath, 'utf-8');
        if (content.length > 100000) continue; // ~25K tokens max per file
        if (totalChars + content.length > budgetChars) continue; // would exceed budget
        stuffedParts.push(`\n--- FILE: ${relPath} ---\n${content}\n--- END FILE ---`);
        totalChars += content.length;
      } catch { /* file doesn't exist, skip */ }
    }
    if (stuffedParts.length > 0) {
      logger.info(`[Agentic] Pre-stuffed ${stuffedParts.length}/${referencedFiles.length} files (${Math.round(totalChars/1024)}KB)`);
      return taskDescription +
        `\n\n[PRE-LOADED FILES — you do NOT need to call read_file for these, their contents are below]\n` +
        stuffedParts.join('\n');
    }
  } catch (err) {
    logger.info(`[Agentic] Pre-stuff failed (non-fatal): ${err.message}`);
  }
  return taskDescription;
}

// ============================================================
// Worker-based agentic execution
// ============================================================

/**
 * Spawn a worker_threads worker that runs the agentic loop in isolation.
 *
 * The worker communicates back via postMessage with a typed protocol:
 *   progress, toolCall, chunk, log, result, error
 *
 * @param {Object} config - workerData passed to agentic-worker.js
 * @param {Object} [callbacks] - optional message handlers
 * @param {Function} [callbacks.onProgress]
 * @param {Function} [callbacks.onToolCall]
 * @param {Function} [callbacks.onChunk]
 * @param {Function} [callbacks.onLog]
 * @returns {{ promise: Promise, abort: Function, terminate: Function, worker: Worker }}
 */
function spawnAgenticWorker(config, callbacks = {}) {
  const { onProgress, onToolCall, onChunk, onLog } = callbacks;
  let settled = false;

  // Lazy lookup — allows vi.spyOn(require('worker_threads'), 'Worker') to intercept
  const { Worker } = require('worker_threads');
  const worker = new Worker(
    path.join(__dirname, 'agentic-worker.js'),
    { workerData: config }
  );

  const abort = () => worker.postMessage({ type: 'abort' });
  const terminate = () => worker.terminate();

  const promise = new Promise((resolve, reject) => {
    worker.on('message', (msg) => {
      if (settled) return;
      if (msg.type === 'result' || msg.type === 'error') logger.debug(`[MAIN-RECV] ${msg.type} from worker`);
      switch (msg.type) {
        case 'progress': if (onProgress) onProgress(msg); break;
        case 'toolCall': if (onToolCall) onToolCall(msg); break;
        case 'chunk': if (onChunk) onChunk(msg); break;
        case 'log': if (onLog) onLog(msg); break;
        case 'quotaHeaders':
          try {
            const { getQuotaStore } = require('../db/provider-quotas');
            getQuotaStore().updateFromHeaders(msg.provider, msg.headers);
          } catch { /* non-critical */ }
          break;
        case 'quota429':
          try {
            const { getQuotaStore } = require('../db/provider-quotas');
            getQuotaStore().record429(msg.provider);
          } catch { /* non-critical */ }
          break;
        case 'result': settled = true; resolve(msg); break;
        case 'error': settled = true; reject(new Error(msg.message)); break;
      }
    });
    worker.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        settled = true;
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });

  return { promise, abort, terminate, worker };
}

function getAgenticRunningProcesses() {
  return _agenticDeps?.runningProcesses || null;
}

function appendTrackedOutput(entry, chunk, maxChars = 8192) {
  if (!entry || !chunk) return;
  const next = `${entry.output || ''}${chunk}`;
  entry.output = next.length > maxChars ? next.slice(-maxChars) : next;
}

function touchTrackedAgenticWorker(taskId, mutate) {
  const runningProcesses = getAgenticRunningProcesses();
  const entry = runningProcesses?.get?.(taskId);
  if (!entry) return;
  if (typeof mutate === 'function') mutate(entry);
  entry.lastOutputAt = Date.now();
}

function clearTrackedAgenticStartupTimeout(entry) {
  if (!entry?.startupTimeoutHandle) return;
  clearTimeout(entry.startupTimeoutHandle);
  entry.startupTimeoutHandle = null;
}

function buildTrackedAgenticCallbacks(taskId, callbacks = {}) {
  return {
    onProgress: (msg) => {
      touchTrackedAgenticWorker(taskId, (entry) => {
        entry.lastProgress = msg.iteration;
        entry.output = `[Agentic: iteration ${msg.iteration}/${msg.maxIterations}, last tool: ${msg.lastTool || 'none'}]`;
      });
      callbacks.onProgress?.(msg);
    },
    onToolCall: (msg) => {
      touchTrackedAgenticWorker(taskId, (entry) => {
        clearTrackedAgenticStartupTimeout(entry);
        appendTrackedOutput(entry, `[tool:${msg.name}] `);
      });
      callbacks.onToolCall?.(msg);
    },
    onChunk: (msg) => {
      touchTrackedAgenticWorker(taskId, (entry) => {
        clearTrackedAgenticStartupTimeout(entry);
        appendTrackedOutput(entry, msg.text || '');
      });
      callbacks.onChunk?.(msg);
    },
    onLog: (msg) => callbacks.onLog?.(msg),
  };
}

function createScoutSignalParserForTask(task, taskId) {
  const meta = normalizeTaskMetadata(task);
  if (meta.mode !== 'scout') {
    return null;
  }
  try {
    const { StreamSignalParser } = require('../diffusion/stream-signal-parser');
    const { processScoutSignal } = require('../factory/scout-signal-consumer');
    return new StreamSignalParser((type, data) => {
      logger.info(`[Agentic] Scout signal detected for task ${taskId}: ${type}`);
      processScoutSignal({ task, taskId, signalType: type, signalData: data, logger });
    });
  } catch (err) {
    logger.info(`[Agentic] Scout parser setup error for task ${taskId}: ${err.message}`);
    return null;
  }
}

function feedScoutSignalParser(parser, text, taskId) {
  if (!parser || !text) {
    return;
  }
  try {
    parser.feed(String(text));
  } catch (err) {
    logger.info(`[Agentic] Scout signal parser error for task ${taskId}: ${err.message}`);
  }
}

function destroyScoutSignalParser(parser, taskId) {
  if (!parser || typeof parser.destroy !== 'function') {
    return;
  }
  try {
    parser.destroy();
  } catch (err) {
    logger.info(`[Agentic] Scout signal parser cleanup error for task ${taskId}: ${err.message}`);
  }
}

const AGENTIC_WORKER_SILENT_HEARTBEAT_MS = 60 * 1000;

function trackAgenticWorkerTask(taskId, {
  workerHandle,
  abortController = null,
  provider = null,
  model = null,
  workingDir = null,
  timeoutHandle = null,
  timeoutMs = null,
  firstResponseTimeoutMs = null,
}) {
  const runningProcesses = getAgenticRunningProcesses();
  const worker = workerHandle?.worker;
  if (!runningProcesses?.set || !worker) return () => {};

  const originalKill = typeof worker.kill === 'function' ? worker.kill.bind(worker) : null;
  if (typeof worker.kill !== 'function') {
    worker.kill = (signal = 'SIGTERM') => {
      if (signal === 'SIGTERM') {
        try { abortController?.abort?.(); } catch { /* ignore */ }
        try { workerHandle.abort?.(); } catch { /* ignore */ }
        return true;
      }
      try { workerHandle.terminate?.(); } catch { /* ignore */ }
      return true;
    };
  }

  const now = Date.now();
  const procRecord = {
    process: worker,
    output: '',
    errorOutput: '',
    startTime: now,
    lastOutputAt: now,
    stallWarned: false,
    timeoutHandle,
    provider,
    model,
    workingDirectory: workingDir,
    isAgenticWorker: true,
    timeoutMs,
    firstResponseTimeoutMs,
  };

  const trackerState = {
    firstResponseTimedOut: false,
    timeoutMessage: null,
  };

  if (Number.isFinite(firstResponseTimeoutMs) && firstResponseTimeoutMs > 0) {
    procRecord.startupTimeoutHandle = setTimeout(() => {
      const current = runningProcesses.get(taskId);
      if (current !== procRecord) return;

      const timeoutSeconds = Math.ceil(firstResponseTimeoutMs / 1000);
      trackerState.firstResponseTimedOut = true;
      trackerState.timeoutMessage = `Agentic worker timed out after ${timeoutSeconds}s without model output or tool calls`;
      current.errorOutput = trackerState.timeoutMessage;
      current.output = current.output || `[Agentic: waiting on ${provider || 'provider'}${model ? ` ${model}` : ''}]`;
      try { abortController?.abort?.(); } catch { /* ignore */ }
      try { workerHandle.abort?.(); } catch { /* ignore */ }
    }, firstResponseTimeoutMs);
    procRecord.startupTimeoutHandle.unref?.();
  }

  procRecord.silentHeartbeatHandle = setInterval(() => {
    const current = runningProcesses.get(taskId);
    if (current !== procRecord) {
      clearInterval(procRecord.silentHeartbeatHandle);
      return;
    }
    current.lastOutputAt = Date.now();
    current.output = current.output || `[Agentic: waiting on ${provider || 'provider'}${model ? ` ${model}` : ''}]`;
  }, AGENTIC_WORKER_SILENT_HEARTBEAT_MS);
  procRecord.silentHeartbeatHandle.unref?.();

  runningProcesses.set(taskId, procRecord);

  const cleanup = () => {
    const current = runningProcesses.get(taskId);
    if (current === procRecord) {
      if (current.timeoutHandle) clearTimeout(current.timeoutHandle);
      if (current.startupTimeoutHandle) clearTimeout(current.startupTimeoutHandle);
      if (current.completionGraceHandle) clearTimeout(current.completionGraceHandle);
      if (current.silentHeartbeatHandle) clearInterval(current.silentHeartbeatHandle);
      runningProcesses.delete(taskId);
      runningProcesses.stallAttempts?.delete?.(taskId);
    }

    if (originalKill) worker.kill = originalKill;
    else delete worker.kill;
  };
  cleanup.getState = () => trackerState;
  return cleanup;
}

function normalizeAgenticWorkerError(error, cleanupTrackedWorker) {
  const state = cleanupTrackedWorker?.getState?.();
  if (!state?.firstResponseTimedOut) return error;
  const timeoutError = new Error(state.timeoutMessage || 'Agentic worker first response timed out');
  timeoutError.name = 'AgenticFirstResponseTimeoutError';
  timeoutError.cause = error;
  return timeoutError;
}

function resolveAgenticFirstResponseTimeoutMs(provider) {
  if (provider !== 'openrouter') return null;
  const serverConfig = require('../config');
  const raw = serverConfig.get('openrouter_agentic_first_response_timeout_seconds')
    || serverConfig.get('agentic_first_response_timeout_seconds')
    || '180';
  const seconds = parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * Run the full agentic pipeline: create executor, capture git snapshot,
 * run the agentic loop, check/revert unauthorized changes, store metadata.
 *
 * @deprecated Use spawnAgenticWorker() instead. Retained for backward compatibility
 * with any code that references runAgenticPipeline directly.
 *
 * @param {Object} params
 * @param {Object} params.adapter - Chat adapter
 * @param {string} params.systemPrompt - Full system prompt (already built)
 * @param {Object} params.task - Task record
 * @param {Object} params.adapterOptions - Options to pass to adapter (host, apiKey, model, providerName, plus tuning)
 * @param {string} params.workingDir - Working directory
 * @param {number} params.timeoutMs - Timeout in ms
 * @param {number} params.maxIterations - Max loop iterations
 * @param {number} params.contextBudget - Context budget for truncation
 * @param {string} params.ollamaStreamId - Stream ID for output
 * @param {AbortSignal} params.signal - Abort signal
 * @returns {Promise<{ output: string, toolLog: Array, changedFiles: string[], iterations: number, tokenUsage: Object }>}
 */
async function runAgenticPipeline({
  adapter, systemPrompt, task, adapterOptions, workingDir,
  timeoutMs, maxIterations, contextBudget, ollamaStreamId, signal,
  promptInjectedTools = false,
}) {
  const serverConfig = require('../config');
  const { db, dashboard } = _agenticDeps;
  const taskId = task.id;
  const agenticPolicy = buildTaskAgenticPolicy(task, workingDir, serverConfig);
  const proposalOutputMode = shouldUseProposalApplyMode(task, agenticPolicy);

  // Create tool executor
  const executor = createToolExecutor(workingDir, {
    commandMode: agenticPolicy.commandMode,
    commandAllowlist: agenticPolicy.commandAllowlist,
    readAllowlist: agenticPolicy.readAllowlist,
    writeAllowlist: agenticPolicy.writeAllowlist,
    writeAfterReadPaths: agenticPolicy.writeAfterReadPaths,
    diagnosticReadLimitAfterFailedCommand: agenticPolicy.diagnosticReadLimitAfterFailedCommand,
  });

  // Capture git snapshot (non-git repos return null)
  let snapshot = null;
  try {
    snapshot = captureSnapshot(workingDir);
    persistAgenticGitSnapshot(task, workingDir, snapshot);
  } catch (e) {
    logger.info(`[Agentic] Git snapshot failed (non-git repo?): ${e.message}`);
  }

  // Pre-stuff referenced files
  const enrichedPromptInline = preStuffFileContents(task.task_description, workingDir);

  // Run agentic loop
  // For prompt-injected tools: pass empty tools array (tools are in the system prompt)
  const result = await runAgenticLoop({
    adapter,
    systemPrompt: appendTaskPolicyGuidance(systemPrompt, agenticPolicy),
    taskPrompt: enrichedPromptInline,
    tools: promptInjectedTools ? [] : selectToolsForTask(task.task_description, {
      commandMode: agenticPolicy.commandMode,
      commandAllowlist: agenticPolicy.commandAllowlist,
      toolAllowlist: agenticPolicy.toolAllowlist,
    }),
    promptInjectedTools,
    toolExecutor: executor,
    options: adapterOptions,
    workingDir,
    timeoutMs,
    maxIterations: agenticPolicy.maxIterations || maxIterations,
    contextBudget,
    actionlessIterationLimit: agenticPolicy.actionlessIterationLimit,
    requireToolUseBeforeFinal: shouldRequireToolEvidence(adapterOptions?.providerName, task, workingDir),
    proposalOutputMode,
    onProgress: (iteration, max, lastTool) => {
      const pct = Math.min(85, 10 + Math.floor((iteration / max) * 75));
      try {
        db.updateTaskStatus(taskId, 'running', {
          progress_percent: pct,
          output: `[Agentic: iteration ${iteration}/${max}, last tool: ${lastTool || 'none'}]`,
        });
        dashboard.notifyTaskUpdated(taskId);
      } catch { /* ignore */ }
    },
    onToolCall: (name, args, execResult) => {
      try {
        const status = execResult.error ? 'ERROR' : 'OK';
        db.addStreamChunk(ollamaStreamId, `[tool:${name}] ${status}\n`, 'stdout');
        dashboard.notifyTaskOutput(taskId, `[tool:${name}] ${status}\n`);
      } catch { /* ignore */ }
    },
    signal,
  });

  // Check and revert unauthorized git changes
  logger.info(`[Agentic] Pipeline complete, checking git safety`);
  if (snapshot && snapshot.isGitRepo) {
    const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
    // Map 'on' to 'enforce' for the git safety module
    const mode = safetyMode === 'on' ? 'enforce' : safetyMode === 'warn' ? 'warn' : 'off';
    const gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode, buildGitSafetyOptions(agenticPolicy));
    if (gitReport.report) {
      result.output += `\n\n--- Git Safety ---\n${gitReport.report}`;
    }
  }

  logger.info(`[Agentic] Returning: output=${result.output?.length || 0} bytes, tools=${result.toolLog?.length || 0}, files=${result.changedFiles?.length || 0}`);
  return result;
}

// ============================================================
// Agentic wrappers
// ============================================================

/**
 * Agentic wrapper around executeOllamaTask.
 * When the model is agentic-capable and the pipeline is enabled,
 * intercepts the task and runs it through /api/chat with tool calling.
 * Falls back to legacy /api/generate via executeOllamaTask otherwise.
 */
async function executeOllamaTaskWithAgentic(task) {
  const serverConfig = require('../config');
  const provider = task.provider || 'ollama';

  // Check capability (handles excluded providers, kill switch, whitelist, probe cache)
  const model = resolveOllamaModel(task, null) || '';
  const capability = isAgenticCapable(provider, model);

  if (!capability.capable || !_agenticDeps) {
    logger.info(`[Agentic] Skipping agentic for ${provider}/${model}: ${capability.reason}`);
    return _executeOllamaModule.executeOllamaTask(task);
  }

  // Diffusion compute tasks need raw text output, not agentic tool-calling.
  try {
    const taskMeta = task.metadata ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata) : {};
    if (taskMeta.diffusion_role === 'compute') {
      logger.info(`[Agentic] Ollama compute task ${task.id} — bypassing agentic loop for raw text output`);
      return _executeOllamaModule.executeOllamaTask(task);
    }
  } catch (_e) { /* non-fatal — continue to agentic */ }

  // Legacy kill switch backward compat
  if (serverConfig.get('ollama_agentic_enabled') === '0') {
    return _executeOllamaModule.executeOllamaTask(task);
  }

  // Select adapter
  const adapter = selectAdapter(provider);
  if (!adapter) {
    logger.info(`[Agentic] No adapter for provider ${provider}, falling back to legacy`);
    return _executeOllamaModule.executeOllamaTask(task);
  }

  const { db, dashboard, safeUpdateTaskStatus, processQueue, handleWorkflowTermination } = _agenticDeps;
  const providerConfig = require('./config');
  const ollamaShared = require('./ollama-shared');
  const taskId = task.id;

  // Resolve working directory
  let workingDir = task.working_directory;
  if (!workingDir) workingDir = process.cwd();
  maybePersistEffectiveAgenticMetadata(task, db, workingDir);
  const agenticPolicy = buildTaskAgenticPolicy(task, workingDir, serverConfig);
  const proposalOutputMode = shouldUseProposalApplyMode(task, agenticPolicy);

  const noopPlanningResult = maybeShortCircuitPlanningTask(task, workingDir, agenticPolicy);
  if (noopPlanningResult) {
    const completedAt = new Date().toISOString();
    safeUpdateTaskStatus(taskId, 'completed', {
      output: noopPlanningResult.output,
      exit_code: 0,
      progress_percent: 100,
      started_at: completedAt,
      completed_at: completedAt,
      task_metadata: JSON.stringify(noopPlanningResult.taskMetadata),
    });

    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('completed', db.getTask(taskId));
    } catch { /* non-fatal */ }

    logger.info(`[Agentic] Ollama task ${taskId} short-circuited: ${noopPlanningResult.taskMetadata.agentic_noop_reason}`);
    dashboard.notifyTaskUpdated(taskId);
    if (typeof handleWorkflowTermination === 'function') {
      try { handleWorkflowTermination(taskId); } catch (e) {
        logger.info(`[Agentic] handleWorkflowTermination error for Ollama task ${taskId}: ${e.message}`);
      }
    }
    processQueue();
    return;
  }

  // Resolve model
  let resolvedModel = task.model;
  if (!resolvedModel) {
    try {
      const registry = require('../models/registry');
      const best = registry.selectBestApprovedModel('ollama');
      if (best) resolvedModel = best.model_name;
    } catch { /* ignore */ }
  }
  if (!resolvedModel) resolvedModel = resolveOllamaModel(task, null) || '';
  if (!resolvedModel || !ollamaShared.hasModelOnAnyHost(resolvedModel)) {
    const best = ollamaShared.findBestAvailableModel();
    if (best) resolvedModel = best;
  }
  if (!resolvedModel) {
    try {
      const modelRoles = require('../db/model-roles');
      resolvedModel = modelRoles.getModelForRole('ollama', 'default') || null;
    } catch { resolvedModel = null; }
  }

  // Resolve host
  const hosts = db.listOllamaHosts ? db.listOllamaHosts() : [];
  let ollamaHost = null;
  let selectedHostId = null;

  if (hosts.length > 0) {
    const selection = db.selectOllamaHostForModel(resolvedModel);
    if (selection.host) {
      ollamaHost = selection.host.url;
      selectedHostId = selection.host.id;
    }
  }
  if (!ollamaHost) {
    // Check if there's a configured host before falling back to localhost
    const configuredHost = serverConfig.get('ollama_host');
    if (configuredHost) {
      ollamaHost = configuredHost;
    } else {
      // No host found for model — fail with clear error instead of trying localhost
      const availableModels = ollamaShared.findBestAvailableModel();
      const errorMsg = `No Ollama host has model '${resolvedModel}'${availableModels ? `. Available: ${availableModels}` : ' and no models are available on any host'}. Check that the model is pulled on a registered host.`;
      logger.info(`[Agentic] ${errorMsg}`);
      safeUpdateTaskStatus(taskId, 'failed', {
        error_output: errorMsg,
        exit_code: 1,
        completed_at: new Date().toISOString(),
      });
      try {
        const { dispatchTaskEvent } = require('../hooks/event-dispatch');
        dispatchTaskEvent('failed', db.getTask(taskId));
      } catch { /* non-fatal */ }
      dashboard.notifyTaskUpdated(taskId);
      processQueue();
      return;
    }
  }

  let releaseSelectedHostSlot = null;
  if (selectedHostId && typeof db.tryReserveHostSlot === 'function') {
    const reservation = db.tryReserveHostSlot(selectedHostId, resolvedModel);
    if (!reservation?.acquired) {
      const reason = reservation?.error
        || reservation?.vramReason
        || (reservation?.maxCapacity
          ? `Ollama host at capacity (${reservation.currentLoad || 0}/${reservation.maxCapacity})`
          : 'Unable to reserve Ollama host slot');
      throw new Error(reason);
    }

    releaseSelectedHostSlot = () => {
      if (typeof db.releaseHostSlot === 'function') {
        db.releaseHostSlot(selectedHostId);
      } else if (typeof db.decrementHostTasks === 'function') {
        db.decrementHostTasks(selectedHostId);
      }
    };
  }

  // Resolve tuning
  const tuning = providerConfig.resolveOllamaTuning({
    hostId: selectedHostId,
    model: resolvedModel,
    task,
    adaptiveCtx: null,
    includeAutoTuning: true,
    includeHardware: true,
  });
  // Agentic tasks need larger context than single-shot — multi-turn tool conversations
  // accumulate messages fast. Scale the minimum to 50% of the configured max context,
  // floored at 16K. This way upgrading VRAM and raising ollama_max_ctx automatically
  // gives agentic tasks more room without code changes.
  const maxCtxConfig = parseInt(serverConfig.get('ollama_max_ctx') || '32768', 10);
  const AGENTIC_MIN_CTX = Math.max(16384, Math.floor(maxCtxConfig / 2));
  const effectiveNumCtx = Math.max(tuning.numCtx || AGENTIC_MIN_CTX, AGENTIC_MIN_CTX);
  const tuningOptions = {
    temperature: tuning.temperature,
    num_ctx: effectiveNumCtx,
    num_predict: tuning.numPredict,
    num_keep: 1024, // Preserve system prompt + tool definitions during context sliding
    top_p: tuning.topP,
    top_k: tuning.topK,
    repeat_penalty: tuning.repeatPenalty,
  };

  // Check if model needs prompt-injected tools
  const usePromptInjection = needsPromptInjection(resolvedModel);

  // Build system prompt
  const basePrompt = providerConfig.resolveSystemPrompt(resolvedModel);
  let systemPrompt = appendTaskPolicyGuidance(
    buildAgenticSystemPrompt(basePrompt, workingDir),
    agenticPolicy
  );

  // For prompt-injected tools: append tool definitions to system prompt
  if (usePromptInjection) {
    const selectedTools = selectToolsForTask(task.task_description, {
      commandMode: agenticPolicy.commandMode,
      commandAllowlist: agenticPolicy.commandAllowlist,
      toolAllowlist: agenticPolicy.toolAllowlist,
    });
    const toolDefs = selectedTools.map(t => JSON.stringify({
      type: t.type, function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
    })).join(',');
    systemPrompt = `[AVAILABLE_TOOLS][${toolDefs}][/AVAILABLE_TOOLS]\n${systemPrompt}\nTo call a tool, respond with ONLY a JSON array: [{"name":"tool_name","arguments":{}}]\nAfter receiving [TOOL_RESULTS], give a clear summary with the ACTUAL data returned.`;
    logger.info(`[Agentic] Model ${resolvedModel} uses prompt-injected tools`);
  }

  // Update status — persist the resolved model so performance tracking works
  db.updateTaskStatus(taskId, 'running', {
    started_at: new Date().toISOString(),
    progress_percent: 10,
    ollama_host_id: selectedHostId,
    model: resolvedModel,
  });
  dashboard.notifyTaskUpdated(taskId);

  const ollamaStreamId = db.getOrCreateTaskStream(taskId, 'output');
  const scoutSignalParser = createScoutSignalParserForTask(task, taskId);
  // timeout_minutes === 0 → no enforced timeout (opt-in unbounded). Preserve
  // 0, skip the setTimeout; downstream HTTP client receives timeoutMs=0 which
  // also means "no timeout" for node http.
  const parsedTimeout = parseInt(task.timeout_minutes, 10);
  const timeoutMinutes = Number.isFinite(parsedTimeout) ? parsedTimeout : 30;
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const abortController = new AbortController();
  // Register abort controller so cancelTask() can find and abort agentic tasks
  const apiAbortControllers = _agenticDeps.apiAbortControllers;
  if (apiAbortControllers) apiAbortControllers.set(taskId, abortController);
  const timeoutHandle = timeoutMinutes === 0
    ? null
    : setTimeout(() => abortController.abort(), timeoutMs);
  const cancelCheckInterval = setInterval(() => {
    try {
      const t = db.getTask(taskId);
      if (t && t.status === 'cancelled') {
        abortController.abort();
        clearInterval(cancelCheckInterval);
      }
    } catch { /* ignore */ }
  }, 2000);
  // Hoisted so the finally block can call removeEventListener for cleanup
  let origAbortHandler = null;
  let cleanupTrackedWorker = null;

  // Per-host mutex — wait for any prior task on this host to finish.
  // Prevents GPU contention when multi-instance scheduling races occur.
  let releaseHostLock = null;
  if (selectedHostId) {
    releaseHostLock = await acquireHostLock(selectedHostId);
  }

  try {
    logger.info(`[Agentic] Starting Ollama task ${taskId} with model ${resolvedModel} on ${ollamaHost}`);

    // Category-aware max iterations: complex tasks get more room
    const baseMaxIter = parseInt(serverConfig.get('agentic_max_iterations') || '25', 10);
    const taskComplexity = task.complexity || 'normal';
    const defaultMaxIterations = taskComplexity === 'complex' ? Math.max(baseMaxIter, 20) : baseMaxIter;
    const maxIterations = agenticPolicy.maxIterations || defaultMaxIterations;
    const contextBudget = Math.floor(effectiveNumCtx * 0.8);

    // Capture git snapshot in main thread (git ops need main process context)
    let snapshot = null;
    try {
      snapshot = captureSnapshot(workingDir);
      persistAgenticGitSnapshot(task, workingDir, snapshot);
    } catch (e) {
      logger.info(`[Agentic] Git snapshot failed (non-git repo?): ${e.message}`);
    }

    // Pre-stuff referenced files into the prompt so the model doesn't
    // burn iterations calling read_file for files already mentioned in the task.
    const enrichedTaskPrompt = preStuffFileContents(task.task_description, workingDir, contextBudget * 3);

    // Spawn worker thread for the agentic loop
    logger.debug(`[WORKER-DEBUG] Spawning worker for Ollama task ${taskId}, model=${resolvedModel}, host=${ollamaHost}`);
    const workerHandle = spawnAgenticWorker({
      adapterType: 'ollama',
      adapterOptions: {
        host: ollamaHost,
        apiKey: resolveApiKey(provider),
        providerName: provider,
        model: resolvedModel,
        ...tuningOptions,
      },
      systemPrompt,
      taskPrompt: enrichedTaskPrompt,
      workingDir,
      timeoutMs,
      maxIterations,
      contextBudget,
      promptInjectedTools: usePromptInjection,
      proposalOutputMode,
      commandMode: agenticPolicy.commandMode,
      commandAllowlist: agenticPolicy.commandAllowlist,
      toolAllowlist: agenticPolicy.toolAllowlist,
      actionlessIterationLimit: agenticPolicy.actionlessIterationLimit,
      readAllowlist: agenticPolicy.readAllowlist,
      writeAllowlist: agenticPolicy.writeAllowlist,
      writeAfterReadPaths: agenticPolicy.writeAfterReadPaths,
      diagnosticReadLimitAfterFailedCommand: agenticPolicy.diagnosticReadLimitAfterFailedCommand,
    }, buildTrackedAgenticCallbacks(taskId, {
      onProgress: (msg) => {
        try {
          db.updateTaskStatus(taskId, 'running', {
            progress_percent: Math.min(85, 10 + Math.floor((msg.iteration / msg.maxIterations) * 75)),
            output: `[Agentic: iteration ${msg.iteration}/${msg.maxIterations}, last tool: ${msg.lastTool || 'none'}]`,
          });
          dashboard.notifyTaskUpdated(taskId);
        } catch { /* ignore */ }
      },
      onToolCall: (msg) => {
        try {
          dashboard.notifyTaskOutput(taskId, `[tool:${msg.name}] ${msg.result?.slice(0, 50) || 'ok'}\n`);
        } catch { /* ignore */ }
      },
      onChunk: (msg) => {
        feedScoutSignalParser(scoutSignalParser, msg.text, taskId);
        try {
          db.addStreamChunk(ollamaStreamId, msg.text, 'stdout');
          dashboard.notifyTaskOutput(taskId, msg.text);
        } catch { /* ignore */ }
      },
      onLog: (msg) => {
        logger[msg.level || 'info'](msg.message);
      },
    }));
    cleanupTrackedWorker = trackAgenticWorkerTask(taskId, {
      workerHandle,
      abortController,
      provider,
      model: resolvedModel,
      workingDir,
      timeoutHandle,
      timeoutMs,
    });

    // Wire abort: forward AbortController.abort() → worker abort message
    origAbortHandler = () => workerHandle.abort();
    abortController.signal.addEventListener('abort', origAbortHandler);

    const result = await workerHandle.promise;
    let gitReport = null;

    // Git safety check in main thread (after worker completes)
    if (snapshot && snapshot.isGitRepo) {
      const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
      const mode = safetyMode === 'on' ? 'enforce' : safetyMode === 'warn' ? 'warn' : 'off';
      gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode, buildGitSafetyOptions(agenticPolicy));
      if (gitReport.report) {
        result.output += '\n\n--- Git Safety ---\n' + gitReport.report;
      }
    }

    const sessionLogTarget = resolveAgenticSessionLogTarget(task, workingDir, agenticPolicy);
    const reviewedChangedFiles = sessionLogTarget
      ? mergeChangedFiles(result?.changedFiles, [sessionLogTarget.absolutePath])
      : mergeChangedFiles(result?.changedFiles);
    const strictCompletionFailure = evaluateAgenticCompletion(
      task,
      workingDir,
      agenticPolicy,
      result,
      maxIterations,
      gitReport,
      { changedFilesOverride: reviewedChangedFiles }
    );
    const incompleteCompletionFailure = !strictCompletionFailure
      ? buildIncompleteAgenticFailure(task, workingDir, agenticPolicy, result, maxIterations, provider, resolvedModel)
      : null;
    const noOpCompletionFailure = !strictCompletionFailure && !incompleteCompletionFailure && shouldEscalateNoOpAgenticResult(task, result)
      ? {
          message: `Agentic no-op from ${provider}/${resolvedModel}: ${(result?.toolLog || []).length} tool calls, ${(result?.changedFiles || []).length} files changed`,
          verificationCommand: resolveTaskVerificationCommand(task, workingDir, agenticPolicy),
        }
      : null;
    const completionFailure = strictCompletionFailure || incompleteCompletionFailure || noOpCompletionFailure;
    const revertResult = completionFailure
      ? maybeRevertFailedAgenticChanges(task, workingDir, agenticPolicy, snapshot, result)
      : null;
    let failureMessage = completionFailure?.message || '';
    if (revertResult?.report) {
      failureMessage = failureMessage ? `${failureMessage}\n${revertResult.report}` : revertResult.report;
    }
    const completedAt = new Date().toISOString();
    const sessionLogResult = maybeAppendAgenticSessionLog(task, workingDir, agenticPolicy, result, {
      status: completionFailure ? 'failed' : 'completed',
      outcomeMessage: failureMessage || 'Task completed successfully.',
      verificationCommand: completionFailure?.verificationCommand || resolveTaskVerificationCommand(task, workingDir, agenticPolicy),
      revertReport: revertResult?.report || '',
      timestamp: completedAt,
    }, sessionLogTarget);
    if (sessionLogResult?.appended) {
      result.changedFiles = reviewedChangedFiles;
      result.frameworkPreservedFiles = mergeChangedFiles(result?.frameworkPreservedFiles, [sessionLogResult.absolutePath]);
      appendAgenticOutputSection(result, 'Framework Session Log', `Appended ${sessionLogResult.relativePath}`);
    } else if (sessionLogTarget && sessionLogResult?.error) {
      const sessionLogError = `Framework session log append failed: ${sessionLogResult.relativePath} (${sessionLogResult.error})`;
      failureMessage = failureMessage ? `${failureMessage}\n${sessionLogError}` : sessionLogError;
      appendAgenticOutputSection(result, 'Framework Session Log', `Failed to append ${sessionLogResult.relativePath}: ${sessionLogResult.error}`);
    }
    if (completionFailure || (sessionLogTarget && sessionLogResult?.error)) {
      safeUpdateTaskStatus(taskId, 'failed', {
        output: result.output,
        error_output: failureMessage,
        exit_code: 1,
        progress_percent: 100,
        files_modified: result?.changedFiles || [],
        completed_at: completedAt,
        task_metadata: JSON.stringify({
          agentic_log: result.toolLog,
          agentic_token_usage: result.tokenUsage,
          agentic_failure_reason: failureMessage,
          ...(revertResult ? { agentic_reverted_changes: revertResult.reverted, agentic_revert_report: revertResult.report } : {}),
          ...(completionFailure?.verificationCommand ? { verification_command: completionFailure.verificationCommand } : {}),
        }),
      });

      try {
        const { dispatchTaskEvent } = require('../hooks/event-dispatch');
        dispatchTaskEvent('failed', db.getTask(taskId));
      } catch { /* non-fatal */ }

      logger.info(`[Agentic] Ollama task ${taskId} marked failed after completion review: ${failureMessage}`);
      return;
    }

    // Store result + metadata in a single status update (avoid double-complete race)
    safeUpdateTaskStatus(taskId, 'completed', {
      output: result.output,
      exit_code: 0,
      progress_percent: 100,
      files_modified: result?.changedFiles || [],
      completed_at: completedAt,
      task_metadata: JSON.stringify({
        agentic_log: result.toolLog,
        agentic_token_usage: result.tokenUsage,
      }),
    });

    // Dispatch completion event so await_task/await_workflow wake up immediately
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('completed', db.getTask(taskId));
    } catch { /* non-fatal */ }

    logger.info(`[Agentic] Ollama task ${taskId} completed: ${result.iterations} iterations, ${(result.toolLog || []).length} tool calls, ${(result.changedFiles || []).length} files changed`);

  } catch (error) {
    logger.info(`[Agentic] Ollama task ${taskId} failed: ${error.message}`);
    safeUpdateTaskStatus(taskId, 'failed', {
      error_output: error.message,
      exit_code: 1,
      completed_at: new Date().toISOString(),
    });

    // Dispatch failure event so await_task/await_workflow wake up immediately
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('failed', db.getTask(taskId));
    } catch { /* non-fatal */ }
  } finally {
    if (origAbortHandler) abortController.signal.removeEventListener('abort', origAbortHandler);
    clearInterval(cancelCheckInterval);
    clearTimeout(timeoutHandle);
    if (apiAbortControllers) apiAbortControllers.delete(taskId);
    cleanupTrackedWorker?.();
    if (typeof releaseSelectedHostSlot === 'function') {
      try { releaseSelectedHostSlot(); } catch { /* ignore */ }
    }
    destroyScoutSignalParser(scoutSignalParser, taskId);
    // Release per-host mutex so the next queued task can proceed
    if (releaseHostLock) releaseHostLock();
    dashboard.notifyTaskUpdated(taskId);
    // Workflow termination in both success and failure paths
    if (typeof handleWorkflowTermination === 'function') {
      try { handleWorkflowTermination(taskId); } catch (e) {
        logger.info(`[Agentic] handleWorkflowTermination error for Ollama task ${taskId}: ${e.message}`);
      }
    }
    processQueue();
  }
}

/**
 * Agentic wrapper around executeApiProvider.
 * When the provider+model is agentic-capable, intercepts the task and runs it
 * through the adapter-agnostic agentic loop with tool calling.
 * Falls back to the standard API provider execution otherwise.
 */
async function executeApiProviderWithAgentic(task, providerInstance) {
  const serverConfig = require('../config');
  const provider = task.provider || '';
  const model = resolveApiProviderModel(provider, task.model);
  logger.debug(`[API-WRAP] provider=${provider} model=${model} taskId=${task.id}`);

  // Check capability
  const capability = isAgenticCapable(provider, model);
  logger.debug(`[API-WRAP] capable=${capability.capable} reason=${capability.reason} hasDeps=${!!_agenticDeps}`);

  if (!capability.capable || !_agenticDeps) {
    logger.debug(`[API-WRAP] FALLBACK to legacy`);
    return _executeApiModule.executeApiProvider(task, providerInstance);
  }

  // Tasks that need raw chat-completion output, not agentic tool-calling:
  //   - Diffusion compute tasks (compute→apply pipeline).
  //   - Factory-internal structured kinds (architect_cycle, plan_generation,
  //     verify_review): all three are treated as "no file actions" by
  //     taskLikelyRequiresFileChanges (see FACTORY_INTERNAL_STRUCTURED_KINDS
  //     above). Their prompts produce structured text — a plan, a verdict,
  //     an architect cycle JSON — directly from the model. Wrapping them
  //     in the agentic loop adds a system prompt demanding tool calls,
  //     which conflicts with the structured-output prompt and produces
  //     `0 tool calls, 0 files changed` no-ops or `empty_toolless_result`
  //     kills. Observed live: verify_review on StateTrace 2026-04-26
  //     04:35-04:45 (cerebras/zai-glm-4.7), then 11 plan_generation
  //     tasks 2026-04-26 with the verdict prompt mis-labeled as
  //     plan_generation kind on ollama/qwen3-coder:30b.
  //   - Any task that explicitly requested response_format=json_object:
  //     by definition a structured-output call, not exploration.
  try {
    const taskMeta = task.metadata ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata) : {};
    if (taskMeta.diffusion_role === 'compute') {
      logger.info(`[API-WRAP] Compute task ${task.id} — bypassing agentic loop for raw text output`);
      return _executeApiModule.executeApiProvider(task, providerInstance);
    }
    const kind = String(taskMeta.kind || '').trim().toLowerCase();
    if (taskMeta.factory_internal === true && FACTORY_INTERNAL_STRUCTURED_KINDS.has(kind)) {
      logger.info(`[API-WRAP] ${kind} task ${task.id} — bypassing agentic loop for structured-output prompt`);
      return _executeApiModule.executeApiProvider(task, providerInstance);
    }
    // Bare kind === 'verify_review' as a fallback for non-factory-internal
    // verify_review tasks that bbd5fd71 already covered (preserve that path).
    if (kind === 'verify_review') {
      logger.info(`[API-WRAP] verify_review task ${task.id} — bypassing agentic loop for JSON-mode chat completion`);
      return _executeApiModule.executeApiProvider(task, providerInstance);
    }
    const rf = taskMeta.response_format;
    if (rf === 'json_object' || rf === 'json' || (rf && typeof rf === 'object' && rf.type === 'json_object')) {
      logger.info(`[API-WRAP] JSON-mode task ${task.id} — bypassing agentic loop for structured output`);
      return _executeApiModule.executeApiProvider(task, providerInstance);
    }
  } catch (_e) { /* non-fatal — continue to agentic */ }

  // Select adapter
  const adapter = selectAdapter(provider);
  if (!adapter) {
    return _executeApiModule.executeApiProvider(task, providerInstance);
  }

  // Resolve API key
  const apiKey = resolveApiKey(provider);
  if (!apiKey && provider !== 'ollama') {
    logger.info(`[Agentic] No API key for provider ${provider}, falling back to standard API execution`);
    return _executeApiModule.executeApiProvider(task, providerInstance);
  }

  const { db, dashboard, safeUpdateTaskStatus, processQueue, handleWorkflowTermination } = _agenticDeps;
  const providerConfig = require('./config');
  const taskId = task.id;

  // Resolve working directory
  let workingDir = task.working_directory;
  if (!workingDir) workingDir = process.cwd();
  maybePersistEffectiveAgenticMetadata(task, db, workingDir);
  const agenticPolicy = buildTaskAgenticPolicy(task, workingDir, serverConfig);
  const proposalOutputMode = shouldUseProposalApplyMode(task, agenticPolicy);

  const noopPlanningResult = maybeShortCircuitPlanningTask(task, workingDir, agenticPolicy);
  if (noopPlanningResult) {
    const completedAt = new Date().toISOString();
    safeUpdateTaskStatus(taskId, 'completed', {
      output: noopPlanningResult.output,
      exit_code: 0,
      progress_percent: 100,
      started_at: completedAt,
      completed_at: completedAt,
      task_metadata: JSON.stringify(noopPlanningResult.taskMetadata),
    });

    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('completed', db.getTask(taskId));
    } catch { /* non-fatal */ }

    logger.info(`[Agentic] API task ${taskId} short-circuited: ${noopPlanningResult.taskMetadata.agentic_noop_reason}`);
    dashboard.notifyTaskUpdated(taskId);
    if (typeof handleWorkflowTermination === 'function') {
      try { handleWorkflowTermination(taskId); } catch (e) {
        logger.info(`[Agentic] handleWorkflowTermination error for API task ${taskId}: ${e.message}`);
      }
    }
    processQueue();
    return;
  }

  // Resolve host URL for the provider
  const host = PROVIDER_HOST_MAP[provider] || '';

  // Build system prompt (use default for cloud providers)
  const basePrompt = providerConfig.resolveSystemPrompt(model);
  const systemPrompt = appendTaskPolicyGuidance(
    buildAgenticSystemPrompt(basePrompt, workingDir),
    agenticPolicy
  );

  // Update status
  db.updateTaskStatus(taskId, 'running', {
    started_at: new Date().toISOString(),
    progress_percent: 10,
    model,
  });
  dashboard.notifyTaskUpdated(taskId);

  const ollamaStreamId = db.getOrCreateTaskStream(taskId, 'output');
  const scoutSignalParser = createScoutSignalParserForTask(task, taskId);
  // timeout_minutes === 0 → no enforced timeout (opt-in unbounded). Preserve
  // 0, skip the setTimeout; downstream receives timeoutMs=0 which also means
  // "no timeout" for node http.
  const parsedTimeout = parseInt(task.timeout_minutes, 10);
  const timeoutMinutes = Number.isFinite(parsedTimeout) ? parsedTimeout : 30;
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const abortController = new AbortController();
  // Register abort controller for cancellation support
  const apiAbortControllers2 = _agenticDeps.apiAbortControllers || (_executeApiModule && _executeApiModule._apiAbortControllers);
  if (apiAbortControllers2) apiAbortControllers2.set(taskId, abortController);
  const timeoutHandle = timeoutMinutes === 0
    ? null
    : setTimeout(() => abortController.abort(), timeoutMs);
  const cancelCheckInterval = setInterval(() => {
    try {
      const t = db.getTask(taskId);
      if (t && t.status === 'cancelled') {
        abortController.abort();
        clearInterval(cancelCheckInterval);
      }
    } catch { /* ignore */ }
  }, 2000);
  // Hoisted so the finally block can call removeEventListener for cleanup
  let origAbortHandler2 = null;
  let cleanupTrackedWorker = null;

  let chain = null;

  try {
    logger.info(`[Agentic] Starting API task ${taskId} with provider ${provider}, model ${model}`);

    // Category-aware max iterations: complex tasks get more room
    const baseMaxIter2 = parseInt(serverConfig.get('agentic_max_iterations') || '25', 10);
    const taskComplexity2 = task.complexity || 'normal';
    const defaultMaxIterations = taskComplexity2 === 'complex' ? Math.max(baseMaxIter2, 20) : baseMaxIter2;
    const maxIterations = agenticPolicy.maxIterations || defaultMaxIterations;

    // Derive context budget from provider capabilities
    const PROVIDER_CONTEXT_BUDGETS = {
      'google-ai': 200000, 'deepinfra': 64000, 'hyperbolic': 64000,
      'groq': 32000, 'cerebras': 32000, 'openrouter': 64000, 'ollama-cloud': 64000,
    };
    const contextBudget = PROVIDER_CONTEXT_BUDGETS[provider] || 16000;

    // Check if task has a routing chain (set by smart routing template resolution)
    let meta = {};
    try {
      meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata || {});
      chain = meta._routing_chain;
    } catch { /* ignore parse errors */ }
    if (!Array.isArray(chain) || chain.length <= 1) {
      const openRouterChain = buildOpenRouterModelFallbackChain(provider, model, meta);
      if (openRouterChain) chain = openRouterChain;
    }

    // Shared callbacks for both single-provider and fallback-chain paths
    const workerCallbacks = {
      onProgress: (msg) => {
        try {
          db.updateTaskStatus(taskId, 'running', {
            progress_percent: Math.min(85, 10 + Math.floor((msg.iteration / msg.maxIterations) * 75)),
            output: `[Agentic: iteration ${msg.iteration}/${msg.maxIterations}, last tool: ${msg.lastTool || 'none'}]`,
          });
          dashboard.notifyTaskUpdated(taskId);
        } catch { /* ignore */ }
      },
      onToolCall: (msg) => {
        try {
          dashboard.notifyTaskOutput(taskId, `[tool:${msg.name}] ${msg.result?.slice(0, 50) || 'ok'}\n`);
        } catch { /* ignore */ }
      },
      onChunk: (msg) => {
        feedScoutSignalParser(scoutSignalParser, msg.text, taskId);
        try {
          db.addStreamChunk(ollamaStreamId, msg.text, 'stdout');
          dashboard.notifyTaskOutput(taskId, msg.text);
        } catch { /* ignore */ }
      },
      onLog: (msg) => {
        logger[msg.level || 'info'](msg.message);
      },
    };

    let result;
    let snapshot = null;
    let completionGitReport = null;

    // Capture git snapshot ONCE before chain/single-provider branch so the
    // completion-failure revert path always has access to it (fixes null-snapshot
    // bug where chain-routed tasks never reverted on failure).
    try {
      snapshot = captureSnapshot(workingDir);
      persistAgenticGitSnapshot(task, workingDir, snapshot);
    } catch (e) {
      logger.info(`[Agentic] Git snapshot failed (non-git repo?): ${e.message}`);
    }

    if (chain && Array.isArray(chain) && chain.length > 1) {
      // Multi-provider fallback chain — delegate to executeWithFallback
      logger.info(`[Agentic] API task ${taskId} using fallback chain (${chain.length} entries): ${chain.map(e => e.provider).join(' -> ')}`);

      const buildConfig = (entry) => {
        const localOllamaTarget = entry.provider === 'ollama'
          ? resolveLocalOllamaAgenticTarget(task, entry.model)
          : null;
        const entryModel = localOllamaTarget?.model || resolveApiProviderModel(entry.provider, entry.model);
        return {
          adapterType: resolveAgenticAdapterType(entry.provider),
          adapterOptions: {
            host: localOllamaTarget?.host || PROVIDER_HOST_MAP[entry.provider] || '',
            apiKey: entry.provider === 'ollama' ? null : resolveApiKey(entry.provider),
            providerName: entry.provider,
            model: entryModel,
            temperature: 0.3,
          },
          systemPrompt,
          taskPrompt: buildAgenticTaskPrompt(task, workingDir, (PROVIDER_CONTEXT_BUDGETS[entry.provider] || contextBudget) * 3, agenticPolicy),
          workingDir,
          timeoutMs,
          maxIterations,
          contextBudget: PROVIDER_CONTEXT_BUDGETS[entry.provider] || contextBudget,
          promptInjectedTools: needsPromptInjection(entryModel || ''),
          proposalOutputMode,
          requireToolUseBeforeFinal: shouldRequireToolEvidence(entry.provider, task, workingDir),
          commandMode: agenticPolicy.commandMode,
          commandAllowlist: agenticPolicy.commandAllowlist,
          toolAllowlist: agenticPolicy.toolAllowlist,
          actionlessIterationLimit: agenticPolicy.actionlessIterationLimit,
          readAllowlist: agenticPolicy.readAllowlist,
          writeAllowlist: agenticPolicy.writeAllowlist,
          writeAfterReadPaths: agenticPolicy.writeAfterReadPaths,
          diagnosticReadLimitAfterFailedCommand: agenticPolicy.diagnosticReadLimitAfterFailedCommand,
        };
      };

      result = await executeWithFallback(task, chain, buildConfig, workerCallbacks, agenticPolicy);
      logger.info(`[Agentic] API task ${taskId} completed via chain position ${result.chainPosition}: ${result.provider}/${result.model || 'default'}`);
    } else {
      // Single-provider path (no chain or single-entry chain)
      // Resolve adapter type for the worker
      const adapterType = resolveAgenticAdapterType(provider);

      // Spawn worker thread for the agentic loop
      logger.debug(`[WORKER-DEBUG] Spawning worker for API task ${taskId}, provider=${provider}, model=${model}, adapterType=${adapterType}`);
      const workerHandle = spawnAgenticWorker({
        adapterType,
        adapterOptions: {
          host,
          apiKey,
          providerName: provider,
          model,
          temperature: 0.3,
        },
        systemPrompt,
        taskPrompt: buildAgenticTaskPrompt(task, workingDir, contextBudget * 3, agenticPolicy),
        workingDir,
        timeoutMs,
        maxIterations,
        contextBudget,
        promptInjectedTools: false,
        proposalOutputMode,
        requireToolUseBeforeFinal: shouldRequireToolEvidence(provider, task, workingDir),
        commandMode: agenticPolicy.commandMode,
        commandAllowlist: agenticPolicy.commandAllowlist,
        toolAllowlist: agenticPolicy.toolAllowlist,
        actionlessIterationLimit: agenticPolicy.actionlessIterationLimit,
        readAllowlist: agenticPolicy.readAllowlist,
        writeAllowlist: agenticPolicy.writeAllowlist,
        writeAfterReadPaths: agenticPolicy.writeAfterReadPaths,
        diagnosticReadLimitAfterFailedCommand: agenticPolicy.diagnosticReadLimitAfterFailedCommand,
      }, buildTrackedAgenticCallbacks(taskId, workerCallbacks));
      cleanupTrackedWorker = trackAgenticWorkerTask(taskId, {
        workerHandle,
        abortController,
        provider,
        model,
        workingDir,
        timeoutHandle,
        timeoutMs,
        firstResponseTimeoutMs: resolveAgenticFirstResponseTimeoutMs(provider),
      });

      // Wire abort: forward AbortController.abort() → worker abort message
      origAbortHandler2 = () => workerHandle.abort();
      abortController.signal.addEventListener('abort', origAbortHandler2);

      result = await workerHandle.promise;

      // Git safety check in main thread (after worker completes)
      if (snapshot && snapshot.isGitRepo) {
        const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
        const mode = safetyMode === 'on' ? 'enforce' : safetyMode === 'warn' ? 'warn' : 'off';
        const gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode, buildGitSafetyOptions(agenticPolicy));
        completionGitReport = gitReport;
        if (gitReport.report) {
          result.output += '\n\n--- Git Safety ---\n' + gitReport.report;
        }
      }
    }

    const shouldEscalateNoOp = shouldEscalateNoOpAgenticResult(task, result);
    let proposalApplySkipReason = '';
    let proposalAppliedDeterministically = false;
    let proposalApplyCompletionMetadata = null;
    if (shouldEscalateNoOp) {
      const currentTask = db.getTask(taskId) || task;
      if (shouldUseProposalApplyMode(currentTask, agenticPolicy)) {
        const proposalResult = validateProposalApplyOutput(result?.output || '', currentTask.working_directory || workingDir);
        if (proposalResult.valid) {
          const sourceProvider = result?.provider || provider;
          const sourceModel = result?.model || model || null;
          const deterministicApply = applyProposalEditsDeterministically(
            proposalResult.computeOutput,
            currentTask.working_directory || workingDir
          );

          if (deterministicApply.applied) {
            proposalAppliedDeterministically = true;
            result.changedFiles = mergeChangedFiles(result?.changedFiles, deterministicApply.changedFiles);
            result.output = `${result?.output || ''}\n\n--- Proposal Apply ---\nApplied ${deterministicApply.operationCount} exact edit operation(s) from ${sourceProvider}/${sourceModel || 'default'} to ${deterministicApply.changedFiles.length} file(s): ${deterministicApply.changedFiles.join(', ')}`;
            proposalApplyCompletionMetadata = {
              proposal_apply: true,
              proposal_apply_mode: 'deterministic',
              proposal_apply_parse_status: 'valid',
              proposal_apply_from: sourceProvider,
              proposal_apply_source_model: sourceModel,
              proposal_apply_warnings: mergeUniqueStrings(proposalResult.warnings || [], deterministicApply.warnings || []),
              proposal_apply_operation_count: deterministicApply.operationCount,
              proposal_compute_output: proposalResult.computeOutput,
              original_task_description: normalizeTaskMetadata(currentTask).original_task_description || currentTask?.task_description || '',
            };

            if (snapshot && snapshot.isGitRepo) {
              const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
              const mode = safetyMode === 'on' ? 'enforce' : safetyMode === 'warn' ? 'warn' : 'off';
              const gitReport = checkAndRevert(currentTask.working_directory || workingDir, snapshot, currentTask.task_description, mode, buildGitSafetyOptions(agenticPolicy));
              completionGitReport = gitReport;
              if (gitReport.report) {
                result.output += '\n\n--- Git Safety ---\n' + gitReport.report;
              }
            }
          } else {
            const proposalReason = `Proposal/apply handoff from ${sourceProvider}/${sourceModel || 'default'}: ${proposalResult.computeOutput.file_edits.length} file edit proposal(s)`;
            const proposalHandoff = requeueAgenticTaskForProposalApply(db, taskId, currentTask, proposalResult, {
              provider: sourceProvider,
              model: sourceModel,
              deterministic_apply_failure_reason: deterministicApply.reason || null,
            }, proposalReason);
            if (proposalHandoff.requeued) {
              logger.info(`[Agentic] API task ${taskId} requeued to ${proposalHandoff.target.entry.provider}${proposalHandoff.target.entry.model ? `/${proposalHandoff.target.entry.model}` : ''} for proposal apply`);
              return;
            }
            proposalApplySkipReason = deterministicApply.reason
              ? `deterministic proposal apply failed: ${deterministicApply.reason}`
              : (proposalHandoff.reason || 'proposal apply handoff unavailable');
          }
        } else {
          proposalApplySkipReason = proposalResult.reason || 'proposal parse failed';
        }
      }
    }

    const handoffTarget = shouldEscalateNoOp && !proposalAppliedDeterministically
      ? resolveAgenticHandoffTarget({
          task: db.getTask(taskId) || task,
          chain,
          db,
          currentProvider: result?.provider || provider,
          currentModel: result?.model || model || null,
          currentChainPosition: result?.chainPosition || (Array.isArray(chain) && chain.length > 1 ? 1 : null),
        })
      : null;
    if (handoffTarget) {
      const currentTask = db.getTask(taskId) || task;
      const reason = `Agentic no-op from ${(result?.provider || provider)}/${result?.model || model || 'default'}: ${(result?.toolLog || []).length} tool calls, ${(result?.changedFiles || []).length} files changed${proposalApplySkipReason ? `; proposal apply skipped: ${proposalApplySkipReason}` : ''}`;
      recordOpenRouterModelTaskOutcome({
        task: currentTask,
        provider: result?.provider || provider,
        model: result?.model || model || null,
        success: false,
        result,
        stopReason: result?.stopReason || 'agentic_noop_handoff',
        error: reason,
      });
      requeueAgenticTaskForHandoff(db, taskId, currentTask, handoffTarget.entry, handoffTarget.remainingChain, reason);
      logger.info(`[Agentic] API task ${taskId} requeued to ${handoffTarget.entry.provider}${handoffTarget.entry.model ? `/${handoffTarget.entry.model}` : ''} after no-op result from ${result?.provider || provider}`);
      return;
    }
    if (shouldEscalateNoOp && !proposalAppliedDeterministically) {
      const currentTask = db.getTask(taskId) || task;
      const laneBlockReason = resolveProviderLaneHandoffBlockReason({
        task: currentTask,
        chain,
        currentProvider: result?.provider || provider,
        currentModel: result?.model || model || null,
        currentChainPosition: result?.chainPosition || (Array.isArray(chain) && chain.length > 1 ? 1 : null),
      });
      if (laneBlockReason) {
        const reason = `Agentic no-op from ${(result?.provider || provider)}/${result?.model || model || 'default'}: ${(result?.toolLog || []).length} tool calls, ${(result?.changedFiles || []).length} files changed${proposalApplySkipReason ? `; proposal apply skipped: ${proposalApplySkipReason}` : ''}; ${laneBlockReason}`;
        recordOpenRouterModelTaskOutcome({
          task: currentTask,
          provider: result?.provider || provider,
          model: result?.model || model || null,
          success: false,
          result,
          stopReason: result?.stopReason || 'agentic_noop_lane_blocked',
          error: reason,
        });
        safeUpdateTaskStatus(taskId, 'failed', {
          error_output: reason,
          exit_code: 1,
          completed_at: new Date().toISOString(),
        });
        logger.info(`[Agentic] API task ${taskId} failed after no-op because ${laneBlockReason}`);
        try {
          const { dispatchTaskEvent } = require('../hooks/event-dispatch');
          dispatchTaskEvent('failed', db.getTask(taskId));
        } catch (dispatchErr) {
          logger.debug(`[EventDispatch] Failed to dispatch lane-blocked no-op event: ${dispatchErr.message}`);
        }
        return;
      }
    }

    const sessionLogTarget = resolveAgenticSessionLogTarget(task, workingDir, agenticPolicy);
    const reviewedChangedFiles = sessionLogTarget
      ? mergeChangedFiles(result?.changedFiles, [sessionLogTarget.absolutePath])
      : mergeChangedFiles(result?.changedFiles);
    const completionFailure = evaluateAgenticCompletion(
      task,
      workingDir,
      agenticPolicy,
      result,
      maxIterations,
      result?.gitReport || completionGitReport,
      { changedFilesOverride: reviewedChangedFiles }
    ) || buildIncompleteAgenticFailure(task, workingDir, agenticPolicy, result, maxIterations, provider, model);
    const revertResult = completionFailure
      ? maybeRevertFailedAgenticChanges(task, workingDir, agenticPolicy, snapshot, result)
      : null;
    let failureMessage = completionFailure?.message || '';
    if (revertResult?.report) {
      failureMessage = failureMessage ? `${failureMessage}\n${revertResult.report}` : revertResult.report;
    }
    const completedAt = new Date().toISOString();
    const sessionLogResult = maybeAppendAgenticSessionLog(task, workingDir, agenticPolicy, result, {
      status: completionFailure ? 'failed' : 'completed',
      outcomeMessage: failureMessage || 'Task completed successfully.',
      verificationCommand: completionFailure?.verificationCommand || resolveTaskVerificationCommand(task, workingDir, agenticPolicy),
      revertReport: revertResult?.report || '',
      timestamp: completedAt,
    }, sessionLogTarget);
    if (sessionLogResult?.appended) {
      result.changedFiles = reviewedChangedFiles;
      result.frameworkPreservedFiles = mergeChangedFiles(result?.frameworkPreservedFiles, [sessionLogResult.absolutePath]);
      appendAgenticOutputSection(result, 'Framework Session Log', `Appended ${sessionLogResult.relativePath}`);
    } else if (sessionLogTarget && sessionLogResult?.error) {
      const sessionLogError = `Framework session log append failed: ${sessionLogResult.relativePath} (${sessionLogResult.error})`;
      failureMessage = failureMessage ? `${failureMessage}\n${sessionLogError}` : sessionLogError;
      appendAgenticOutputSection(result, 'Framework Session Log', `Failed to append ${sessionLogResult.relativePath}: ${sessionLogResult.error}`);
    }
    if (completionFailure || (sessionLogTarget && sessionLogResult?.error)) {
      recordOpenRouterModelTaskOutcome({
        task,
        provider: result?.provider || provider,
        model: result?.model || model || null,
        success: false,
        result,
        stopReason: result?.stopReason || 'completion_review_failed',
        error: failureMessage,
      });
      safeUpdateTaskStatus(taskId, 'failed', {
        output: result.output || '',
        error_output: failureMessage,
        exit_code: 1,
        progress_percent: 100,
        model: result?.model || model || null,
        files_modified: result?.changedFiles || [],
        completed_at: completedAt,
        task_metadata: JSON.stringify({
          agentic_log: result.toolLog,
          agentic_token_usage: result.tokenUsage,
          ...(proposalApplyCompletionMetadata || {}),
          agentic_failure_reason: failureMessage,
          ...(revertResult ? { agentic_reverted_changes: revertResult.reverted, agentic_revert_report: revertResult.report } : {}),
          ...(result.chainPosition ? { chain_provider: result.provider, chain_position: result.chainPosition } : {}),
          ...(completionFailure?.verificationCommand ? { verification_command: completionFailure.verificationCommand } : {}),
        }),
      });

      try {
        const { dispatchTaskEvent } = require('../hooks/event-dispatch');
        dispatchTaskEvent('failed', db.getTask(taskId));
      } catch { /* non-fatal */ }

      logger.info(`[Agentic] API task ${taskId} marked failed after completion review: ${failureMessage}`);
      return;
    }

    // Store result + metadata in a single status update (avoid double-complete race)
    recordOpenRouterModelTaskOutcome({
      task,
      provider: result?.provider || provider,
      model: result?.model || model || null,
      success: true,
      result,
    });
    safeUpdateTaskStatus(taskId, 'completed', {
      output: result.output || '',
      exit_code: 0,
      progress_percent: 100,
      model: result?.model || model || null,
      files_modified: result?.changedFiles || [],
      completed_at: completedAt,
      task_metadata: JSON.stringify({
        agentic_log: result.toolLog,
        agentic_token_usage: result.tokenUsage,
        ...(proposalApplyCompletionMetadata || {}),
        ...(result.chainPosition ? { chain_provider: result.provider, chain_position: result.chainPosition } : {}),
      }),
    });

    // Dispatch completion event so await_task/await_workflow wake up immediately
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('completed', db.getTask(taskId));
    } catch { /* non-fatal */ }

    logger.info(`[Agentic] API task ${taskId} completed: ${result.iterations} iterations, ${(result.toolLog || []).length} tool calls, ${(result.changedFiles || []).length} files changed`);

    // Diffusion compute→apply: if this is a compute task, create the apply task dynamically
    try {
      const completedTask = db.getTask(taskId);
      const meta = completedTask?.metadata ? (typeof completedTask.metadata === 'string' ? JSON.parse(completedTask.metadata) : completedTask.metadata) : {};
      if (meta.diffusion_role === 'compute') {
        const computeRawOutput = result.output || '';
        logger.info(`[Diffusion] Agentic compute task ${taskId} output: ${computeRawOutput.length} chars`);
        const { parseComputeOutput, validateComputeSchema, semanticValidateEdits } = require('../diffusion/compute-output-parser');
        const { expandApplyTaskDescription } = require('../diffusion/planner');
        const parsed = parseComputeOutput(computeRawOutput);
        logger.info(`[Diffusion] Compute parse result: ${parsed ? `valid (${parsed.file_edits?.length} edits)` : 'null (parse failed)'}`);
        if (parsed) {
          const validation = validateComputeSchema(parsed);
          if (validation.valid) {
            // Semantic validation: filter out unsafe edits, log warnings
            const semantic = semanticValidateEdits(parsed, (filePath) => {
              const fullPath = require('path').resolve(completedTask.working_directory, filePath);
              return require('fs').readFileSync(fullPath, 'utf-8');
            });
            if (semantic.warnings.length > 0) {
              logger.info(`[Diffusion] Semantic warnings for compute ${taskId}: ${semantic.warnings.join('; ')}`);
            }
            const filteredOutput = { ...parsed, file_edits: semantic.file_edits };
            if (filteredOutput.file_edits.length === 0) {
              logger.info(`[Diffusion] All edits filtered by semantic validation for compute ${taskId} — skipping apply`);
            } else {
            const applyId = require('uuid').v4();
            // Round-robin across available apply providers
            const applyProviderList = Array.isArray(meta.apply_providers) && meta.apply_providers.length > 0
              ? meta.apply_providers
              : [meta.apply_provider || 'ollama'];
            const applyIndex = parseInt(taskId.replace(/[^0-9a-f]/g, '').slice(-4), 16) % applyProviderList.length;
            const applyProvider = applyProviderList[applyIndex];
            const applyDesc = expandApplyTaskDescription(filteredOutput, completedTask.working_directory);
            db.createTask({
              id: applyId,
              status: 'queued',
              task_description: applyDesc,
              working_directory: completedTask.working_directory,
              workflow_id: completedTask.workflow_id,
              provider: applyProvider,
              metadata: JSON.stringify({
                diffusion: true,
                diffusion_role: 'apply',
                compute_task_id: taskId,
                compute_output: parsed,
                // auto_verify_on_completion: false — verify runs at workflow level, not per-task
                verify_command: meta.verify_command || null,
                user_provider_override: true,
                requested_provider: applyProvider,
              }),
            });
            logger.info(`[Diffusion] Created apply task ${applyId} from agentic compute ${taskId}`);
            // Update workflow counts so await_workflow tracks the new apply task
            if (completedTask.workflow_id) {
              try {
                const workflowEngine = require('../db/workflow-engine');
                workflowEngine.updateWorkflowCounts(completedTask.workflow_id);
                // Reset workflow to running if it completed prematurely (all computes done but applies pending)
                const wf = workflowEngine.getWorkflow(completedTask.workflow_id);
                if (wf && wf.status === 'completed') {
                  workflowEngine.updateWorkflow(completedTask.workflow_id, { status: 'running' });
                  logger.info(`[Diffusion] Reopened workflow ${completedTask.workflow_id} — apply tasks still pending`);
                }
              } catch (wfErr) {
                logger.info(`[Diffusion] Workflow count update error: ${wfErr.message}`);
              }
            }
            try {
              const startPromise = require('../task-manager').startTask(applyId);
              if (startPromise && typeof startPromise.catch === 'function') {
                startPromise.catch(err => logger.info(`[Diffusion] Async failure starting apply task ${applyId}: ${err.message}`));
              }
            } catch (startErr) {
              logger.info(`[Diffusion] Failed to auto-start apply task ${applyId}: ${startErr.message}`);
            }
            } // close: if (filteredOutput.file_edits.length > 0)
          } else {
            logger.info(`[Diffusion] Agentic compute ${taskId} schema invalid: ${validation.errors.join('; ')}`);
          }
        }
      }
    } catch (diffusionErr) {
      logger.debug(`[Diffusion] Agentic compute→apply hook error: ${diffusionErr.message}`);
    }

  } catch (error) {
    const handledError = normalizeAgenticWorkerError(error, cleanupTrackedWorker);
    const currentTask = db.getTask(taskId) || task;
    recordAgenticRateLimit(handledError.agenticFailedProvider || provider, handledError);
    const handoffTarget = resolveAgenticHandoffTarget({
      task: currentTask,
      chain,
      db,
      currentProvider: handledError.agenticFailedProvider || provider,
      currentModel: handledError.agenticFailedModel || model || null,
      currentChainPosition: handledError.agenticChainPosition || null,
      preferredTarget: handledError.agenticHandoffTarget || null,
    });
    if (handoffTarget) {
      const reason = handledError.agenticHandoffReason
        || `Agentic provider ${(handledError.agenticFailedProvider || provider)}/${handledError.agenticFailedModel || model || 'default'} failed: ${handledError.message}`;
      if (!handledError.agenticFailedProvider) {
        recordOpenRouterModelTaskOutcome({
          task: currentTask,
          provider,
          model,
          success: false,
          error: handledError,
          stopReason: handledError.name || 'provider_error',
        });
      }
      requeueAgenticTaskForHandoff(db, taskId, currentTask, handoffTarget.entry, handoffTarget.remainingChain, reason);
      logger.info(`[Agentic] API task ${taskId} requeued to ${handoffTarget.entry.provider}${handoffTarget.entry.model ? `/${handoffTarget.entry.model}` : ''} after provider failure: ${handledError.message}`);
      return;
    }

    logger.info(`[Agentic] API task ${taskId} failed: ${handledError.message}`);
    const laneBlockReason = resolveProviderLaneHandoffBlockReason({
      task: currentTask,
      chain,
      currentProvider: handledError.agenticFailedProvider || provider,
      currentModel: handledError.agenticFailedModel || model || null,
      currentChainPosition: handledError.agenticChainPosition || null,
      preferredTarget: handledError.agenticHandoffTarget || null,
    });
    const failureMessage = laneBlockReason
      ? `${handledError.message}; ${laneBlockReason}`
      : handledError.message;
    if (!handledError.agenticFailedProvider) {
      recordOpenRouterModelTaskOutcome({
        task: currentTask,
        provider,
        model,
        success: false,
        error: handledError,
        stopReason: handledError.name || 'provider_error',
      });
    }
    safeUpdateTaskStatus(taskId, 'failed', {
      error_output: failureMessage,
      exit_code: 1,
      completed_at: new Date().toISOString(),
    });

    // Dispatch failure event so await_task/await_workflow wake up immediately
    try {
      const { dispatchTaskEvent } = require('../hooks/event-dispatch');
      dispatchTaskEvent('failed', db.getTask(taskId));
    } catch { /* non-fatal */ }
  } finally {
    if (origAbortHandler2) abortController.signal.removeEventListener('abort', origAbortHandler2);
    clearInterval(cancelCheckInterval);
    clearTimeout(timeoutHandle);
    if (apiAbortControllers2) apiAbortControllers2.delete(taskId);
    cleanupTrackedWorker?.();
    destroyScoutSignalParser(scoutSignalParser, taskId);
    dashboard.notifyTaskUpdated(taskId);
    // Workflow termination in both success and failure paths
    if (typeof handleWorkflowTermination === 'function') {
      try { handleWorkflowTermination(taskId); } catch (e) {
        logger.info(`[Agentic] handleWorkflowTermination error for API task ${taskId}: ${e.message}`);
      }
    }
    processQueue();
  }
}

// ============================================================
// Fallback retry loop
// ============================================================

/**
 * Internal helper — delegates to _recordProviderOutcome when loaded.
 * Silently no-ops if the module is not available yet.
 *
 * @param {string} provider
 * @param {boolean} success
 */
function recordProviderOutcome(provider, success) {
  if (_recordProviderOutcome) _recordProviderOutcome(provider, success);
}

function getTaskDurationMs(task) {
  const startedAt = task?.started_at ? Date.parse(task.started_at) : NaN;
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, Date.now() - startedAt);
}

function recordOpenRouterModelTaskOutcome({
  task,
  provider,
  model,
  success,
  result = null,
  error = null,
  stopReason = null,
}) {
  if (normalizeProviderName(provider) !== 'openrouter') return;

  const modelName = typeof model === 'string' && model.trim()
    ? model.trim()
    : (typeof task?.model === 'string' && task.model.trim() ? task.model.trim() : null);
  if (!modelName) return;

  try {
    const providerModelScores = require('../db/provider-model-scores');
    const db = _agenticDeps?.db;
    if (db && typeof providerModelScores.init === 'function') {
      providerModelScores.init(db);
    }

    const metadata = normalizeTaskMetadata(task);
    const toolLog = Array.isArray(result?.toolLog) ? result.toolLog : [];
    providerModelScores.recordModelTaskOutcome({
      provider: 'openrouter',
      modelName,
      success,
      stopReason: stopReason || result?.stopReason || null,
      toolLog,
      toolCount: toolLog.length,
      readOnly: taskExplicitlyReadOnly(task?.task_description || '', metadata),
      durationMs: getTaskDurationMs(task),
      output: result?.output ? String(result.output).slice(0, 4000) : null,
      error: error ? String(error.message || error).slice(0, 2000) : null,
    });
  } catch (err) {
    logger.info(`[OpenRouterScore] Failed to record model outcome for ${modelName}: ${err.message}`);
  }
}

/**
 * Returns true for transient / rate-limit / infrastructure errors that should
 * trigger a provider fallback retry.  Returns false for permanent errors (bad
 * request, auth failure, tool logic errors) where retrying the same prompt on
 * another provider would not help.
 *
 * @param {Error} error
 * @returns {boolean}
 */
function isRetryableError(error) {
  const msg = (error.message || '').toLowerCase();
  // Auth errors are permanent — retrying on another provider won't help
  if (/invalid api key|unauthorized|authentication|forbidden/.test(msg)) return false;
  // Network-layer TypeErrors (e.g. "Failed to fetch", "fetch failed") are transient
  if (error instanceof TypeError && /fetch|network|connect/i.test(msg)) return true;
  // Use word-bounded status code matching to avoid false positives like "429 items" or "500 records"
  return /\b429\b|\b503\b|timeout|timed out|econnrefused|econnreset|quota|rate.?limit|overloaded|provider returned error|failed to fetch/.test(msg);
}

function isQuotaOrRateLimitError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return /\b429\b|quota|rate.?limit|usage limit|too many requests/.test(msg);
}

function parseRetryAfterSeconds(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getRetryAfterSeconds(error) {
  const direct = parseRetryAfterSeconds(error?.retryAfterSeconds ?? error?.retry_after_seconds ?? error?.retryAfter);
  if (direct) return direct;

  const headers = error?.response?.headers || error?.headers;
  const headerValue = typeof headers?.get === 'function'
    ? headers.get('retry-after')
    : (headers?.['retry-after'] || headers?.['Retry-After']);
  const fromHeader = parseRetryAfterSeconds(headerValue);
  if (fromHeader) return fromHeader;

  const msg = String(error?.message || '');
  const match = msg.match(/retry[-\s]?after[:=\s]+(\d+)/i);
  return match ? parseRetryAfterSeconds(match[1]) : null;
}

function getAgenticFreeQuotaTracker() {
  try {
    return typeof _agenticDeps?.getFreeQuotaTracker === 'function'
      ? _agenticDeps.getFreeQuotaTracker()
      : null;
  } catch {
    return null;
  }
}

function isAgenticProviderInQuotaCooldown(provider) {
  if (!provider) return false;
  const tracker = getAgenticFreeQuotaTracker();
  if (!tracker || typeof tracker.getStatus !== 'function' || typeof tracker.canSubmit !== 'function') return false;

  try {
    const status = tracker.getStatus();
    if (!status || !Object.prototype.hasOwnProperty.call(status, provider)) return false;
    return !tracker.canSubmit(provider);
  } catch {
    return false;
  }
}

function recordAgenticRateLimit(provider, error) {
  if (!provider || !isQuotaOrRateLimitError(error)) return;
  const tracker = getAgenticFreeQuotaTracker();
  if (!tracker || typeof tracker.recordRateLimit !== 'function') return;

  try {
    tracker.recordRateLimit(provider, getRetryAfterSeconds(error));
    logger.info(`[Routing] Recorded quota cooldown for ${provider} after agentic failure`);
  } catch (err) {
    logger.debug(`[Routing] Failed to record quota cooldown for ${provider}: ${err.message}`);
  }
}

function resolveLocalOllamaAgenticTarget(task, requestedModel = null) {
  const serverConfig = require('../config');
  const db = _agenticDeps?.db;
  const ollamaShared = require('./ollama-shared');

  let model = resolveApiProviderModel('ollama', requestedModel)
    || resolveOllamaModel(task, null)
    || '';

  if (model && typeof ollamaShared.hasModelOnAnyHost === 'function' && !ollamaShared.hasModelOnAnyHost(model)) {
    const best = typeof ollamaShared.findBestAvailableModel === 'function'
      ? ollamaShared.findBestAvailableModel()
      : null;
    if (best) model = best;
  }

  if (!model) {
    try {
      const modelRoles = require('../db/model-roles');
      model = modelRoles.getModelForRole('ollama', 'default') || '';
    } catch { /* ignore */ }
  }

  let host = null;
  if (model && db && typeof db.listOllamaHosts === 'function') {
    const hosts = db.listOllamaHosts();
    if (hosts.length > 0 && typeof db.selectOllamaHostForModel === 'function') {
      const selection = db.selectOllamaHostForModel(model);
      if (selection?.host?.url) host = selection.host.url;
    }
  }

  if (!host) {
    host = serverConfig.get('ollama_host') || process.env.OLLAMA_HOST || 'http://localhost:11434';
  }

  if (!model) {
    throw new Error('No local Ollama model is configured or discoverable for agentic fallback');
  }

  return { host, model };
}

/**
 * Execute a task against a provider chain, falling back to the next entry
 * whenever a retryable error occurs.
 *
 * A git snapshot is captured ONCE before the first attempt.  Any partial
 * changes are reverted between attempts so each provider starts from a clean
 * state.  On success the normal git-safety check is applied (warn/enforce/off
 * per server config).
 *
 * @param {Object} task                          — task record
 * @param {Array<{provider:string,model?:string}>} chain — ordered fallback list
 * @param {function(entry): Object} buildWorkerConfig — builds workerData for spawnAgenticWorker
 * @param {Object} callbacks                     — {onProgress, onToolCall, onChunk, onLog}
 * @returns {Promise<Object>} result augmented with .provider, .model, .chainPosition
 */
async function executeWithFallback(task, chain, buildWorkerConfig, callbacks, agenticPolicy = null) {
  const workingDir = task.working_directory || process.cwd();

  // Capture git snapshot ONCE before any attempts
  let snapshot = null;
  try {
    snapshot = captureSnapshot(workingDir);
    persistAgenticGitSnapshot(task, workingDir, snapshot);
  } catch { /* non-git dir */ }

  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    if (isAgenticProviderInQuotaCooldown(entry.provider)) {
      lastError = new Error(`Provider ${entry.provider} is in quota cooldown`);
      logger.info(`[Routing] Skipping ${entry.provider}: quota cooldown is active (${i + 1}/${chain.length})`);
      continue;
    }

    let config;
    let resolvedModel = entry.model || null;

    let workerHandle;
    let cleanupTrackedWorker = null;
    try {
      config = buildWorkerConfig(entry);
      resolvedModel = config?.adapterOptions?.model || entry.model || null;
      logger.info(`[Routing] Trying ${entry.provider}/${resolvedModel || 'default'} (${i + 1}/${chain.length})`);

      workerHandle = spawnAgenticWorker(config, buildTrackedAgenticCallbacks(task.id, callbacks));
      cleanupTrackedWorker = trackAgenticWorkerTask(task.id, {
        workerHandle,
        provider: entry.provider,
        model: resolvedModel,
        workingDir,
        timeoutMs: config.timeoutMs,
        firstResponseTimeoutMs: resolveAgenticFirstResponseTimeoutMs(entry.provider),
      });
      const result = await workerHandle.promise;
      let gitReport = null;
      const resultFailure = inspectHardFailAgenticStopReason(task, workingDir, agenticPolicy, result)
        || buildIncompleteAgenticFailure(task, workingDir, agenticPolicy, result, config?.maxIterations, entry.provider, resolvedModel);
      if (resultFailure) {
        const stopReason = resultFailure.stopReason || result?.stopReason || 'completion_review_failed';
        const resultError = new Error(resultFailure.message);
        resultError.name = stopReason;
        lastError = resultError;

        if (snapshot && snapshot.isGitRepo) {
          try { checkAndRevert(workingDir, snapshot, task.task_description, 'enforce', buildGitSafetyOptions(agenticPolicy)); } catch { /* ignore */ }
        }

        try { recordProviderOutcome(entry.provider, false); } catch { /* non-critical */ }
        recordOpenRouterModelTaskOutcome({
          task,
          provider: entry.provider,
          model: resolvedModel,
          success: false,
          result,
          error: resultFailure.message,
          stopReason,
        });

        const nextEntry = chain[i + 1];
        if (nextEntry && !isAgenticWorkerCompatibleProvider(nextEntry.provider)) {
          const handoffError = new Error(`Provider ${entry.provider}/${resolvedModel || 'default'} stopped with ${stopReason}; handoff to ${nextEntry.provider} is required`);
          handoffError.agenticHandoffTarget = nextEntry;
          handoffError.agenticHandoffReason = `Provider ${entry.provider}/${resolvedModel || 'default'} stopped with ${stopReason}: ${resultFailure.message}`;
          handoffError.agenticChainPosition = i + 1;
          handoffError.agenticFailedProvider = entry.provider;
          handoffError.agenticFailedModel = resolvedModel;
          throw handoffError;
        }

        if (i === chain.length - 1) {
          return { ...result, provider: entry.provider, model: resolvedModel, chainPosition: i + 1, gitReport };
        }

        logger.info(`[Routing] Fallback: ${entry.provider}/${resolvedModel || 'default'} stopped with ${stopReason}, trying next (${i + 2}/${chain.length})`);
        continue;
      }

      // Success — run git safety and return
      if (snapshot && snapshot.isGitRepo) {
        const serverConfig = require('../config');
        const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
        const mode = safetyMode === 'warn' ? 'warn' : safetyMode === 'off' ? 'off' : 'enforce';
        gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode, buildGitSafetyOptions(agenticPolicy));
        if (gitReport.report) result.output += '\n\n--- Git Safety ---\n' + gitReport.report;
      }

      // Record success
      try { recordProviderOutcome(entry.provider, true); } catch { /* non-critical */ }

      return { ...result, provider: entry.provider, model: resolvedModel, chainPosition: i + 1, gitReport };

    } catch (error) {
      const handledError = normalizeAgenticWorkerError(error, cleanupTrackedWorker);
      lastError = handledError;

      // Terminate the stuck worker
      if (workerHandle) try { workerHandle.terminate(); } catch { /* ignore */ }

      // Revert any partial changes before retrying
      if (snapshot && snapshot.isGitRepo) {
        try { checkAndRevert(workingDir, snapshot, task.task_description, 'enforce', buildGitSafetyOptions(agenticPolicy)); } catch { /* ignore */ }
      }

      // Record failure
      try { recordProviderOutcome(entry.provider, false); } catch { /* non-critical */ }
      recordAgenticRateLimit(entry.provider, handledError);
      recordOpenRouterModelTaskOutcome({
        task,
        provider: entry.provider,
        model: resolvedModel,
        success: false,
        error: handledError,
        stopReason: handledError.name || 'provider_error',
      });

      const nextEntry = chain[i + 1];
      if (nextEntry && !isAgenticWorkerCompatibleProvider(nextEntry.provider)) {
        const handoffError = new Error(`Provider ${entry.provider}/${resolvedModel || 'default'} failed; handoff to ${nextEntry.provider} is required`);
        handoffError.agenticHandoffTarget = nextEntry;
        handoffError.agenticHandoffReason = `Provider ${entry.provider}/${resolvedModel || 'default'} failed: ${handledError.message}`;
        handoffError.agenticChainPosition = i + 1;
        handoffError.agenticFailedProvider = entry.provider;
        handoffError.agenticFailedModel = resolvedModel;
        throw handoffError;
      }

      const providerSetupFailure = !workerHandle;
      if ((!providerSetupFailure && !isRetryableError(handledError)) || i === chain.length - 1) {
        handledError.agenticChainPosition = i + 1;
        handledError.agenticFailedProvider = entry.provider;
        handledError.agenticFailedModel = resolvedModel;
        logger.info(`[Routing] ${entry.provider} failed (non-retryable or last in chain): ${handledError.message}`);
        throw handledError;
      }

      logger.info(`[Routing] Fallback: ${entry.provider}/${resolvedModel || 'default'} failed (${handledError.message.slice(0, 80)}), trying next (${i + 2}/${chain.length})`);
    } finally {
      cleanupTrackedWorker?.();
    }
  }

  throw lastError || new Error('All providers in chain failed');
}

// ============================================================
// Module exports — re-export all functions from sub-modules
// ============================================================

module.exports = {
  init,
  // Worker spawner (for tests and direct use)
  spawnAgenticWorker,
  // Fallback retry loop
  isRetryableError,
  executeWithFallback,
  // From execute-ollama.js (wrapped with agentic interceptor)
  estimateRequiredContext: _executeOllamaModule.estimateRequiredContext,
  executeOllamaTask: executeOllamaTaskWithAgentic,
  // From execute-api.js (wrapped with agentic interceptor for capable providers)
  executeApiProvider: executeApiProviderWithAgentic,
  // Hashline compatibility now routes through plain Ollama execution.
  executeHashlineOllamaTask: executeOllamaTaskWithAgentic,
  // From execute-cli.js
  buildAiderOllamaCommand: _executeCliModule.buildAiderOllamaCommand,
  buildClaudeCliCommand: _executeCliModule.buildClaudeCliCommand,
  buildCodexCommand: _executeCliModule.buildCodexCommand,
  spawnAndTrackProcess: _executeCliModule.spawnAndTrackProcess,
  // Legacy backward compat
  runAgenticPipeline,
  // Exported for tests
  shouldRequireToolEvidence,
};
