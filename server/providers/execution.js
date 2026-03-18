/**
 * providers/execution.js — Provider execution aggregator
 *
 * Thin aggregator that delegates to sub-modules:
 * - execute-api.js      — executeApiProvider (API-based providers)
 * - execute-ollama.js   — executeOllamaTask, estimateRequiredContext (plain Ollama)
 * - execute-hashline.js — executeHashlineOllamaTask, error-feedback helpers
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
const _executeHashlineModule = require('./execute-hashline');
const _executeCliModule = require('./execute-cli');

// Agentic pipeline components
const { runAgenticLoop } = require('./ollama-agentic');
const { isAgenticCapable, needsPromptInjection, init: initCapability } = require('./agentic-capability');
const { createToolExecutor, TOOL_DEFINITIONS } = require('./ollama-tools');
const { captureSnapshot, checkAndRevert } = require('./agentic-git-safety');
const ollamaChatAdapter = require('./adapters/ollama-chat');
const openaiChatAdapter = require('./adapters/openai-chat');
const googleChatAdapter = require('./adapters/google-chat');

const logger = require('../logger').child({ component: 'execution-agentic' });

// ── Lazy reference to recordProviderOutcome from provider-routing-core ──
// Loaded in init() to avoid circular-require during startup.
let _recordProviderOutcome = null;

// ── Cloud provider base URL map (for OpenAI-compatible adapters) ───────
const PROVIDER_HOST_MAP = {
  groq: 'https://api.groq.com/openai',
  cerebras: 'https://api.cerebras.ai',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  openrouter: 'https://openrouter.ai/api',
  hyperbolic: 'https://api.hyperbolic.xyz/v1',
  'ollama-cloud': 'https://api.ollama.com',
  'google-ai': 'https://generativelanguage.googleapis.com',
};

// Default models per provider — chosen from comprehensive baseline testing (2026-03-18)
const PROVIDER_DEFAULT_MODEL = {
  groq: 'llama-3.3-70b-versatile',                  // matches groq.js default — qwen3-32b may have intermittent failures
  cerebras: 'qwen-3-235b-a22b-instruct-2507',       // Grade A, 779ms, best overall
  deepinfra: 'Qwen/Qwen2.5-72B-Instruct',
  openrouter: 'nvidia/nemotron-3-nano-30b-a3b:free', // Grade A, 3.9s, best free model
  hyperbolic: 'Qwen/Qwen2.5-72B-Instruct',
  'ollama-cloud': 'kimi-k2:1t',                     // Grade A, 4.5s, most reliable (devstral intermittent)
  'google-ai': 'gemini-2.5-flash',                  // Grade A, 3.6s, only model with quota
};

// ── Deps captured at init time for the agentic wrapper ────────────────
let _agenticDeps = null;

/**
 * Initialize all sub-modules with dependencies from task-manager.js.
 * Accepts the same deps object as the original monolithic init().
 */
function init(deps) {
  // Capture deps for the agentic wrapper
  _agenticDeps = {
    db: deps.db,
    dashboard: deps.dashboard,
    safeUpdateTaskStatus: deps.safeUpdateTaskStatus,
    processQueue: deps.processQueue,
    handleWorkflowTermination: deps.handleWorkflowTermination,
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

  // execute-hashline.js needs: db, dashboard, safeUpdateTaskStatus, tryReserveHostSlotWithFallback,
  //   tryHashlineTieredFallback, selectHashlineFormat, isHashlineCapableModel,
  //   isLargeModelBlockedOnHost, processQueue, hashlineOllamaSystemPrompt, hashlineLiteSystemPrompt,
  //   handleWorkflowTermination,
  //   executeOllamaTask (for fallback)
  _executeHashlineModule.init({
    db: deps.db,
    dashboard: deps.dashboard,
    safeUpdateTaskStatus: deps.safeUpdateTaskStatus,
    tryReserveHostSlotWithFallback: deps.tryReserveHostSlotWithFallback,
    tryHashlineTieredFallback: deps.tryHashlineTieredFallback,
    selectHashlineFormat: deps.selectHashlineFormat,
    isHashlineCapableModel: deps.isHashlineCapableModel,
    isLargeModelBlockedOnHost: deps.isLargeModelBlockedOnHost,
    processQueue: deps.processQueue,
    hashlineOllamaSystemPrompt: deps.hashlineOllamaSystemPrompt,
    hashlineLiteSystemPrompt: deps.hashlineLiteSystemPrompt,
    handleWorkflowTermination: deps.handleWorkflowTermination,
    executeOllamaTask: _executeOllamaModule.executeOllamaTask,
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

/**
 * Build the platform-aware agentic system prompt.
 *
 * @param {string} basePrompt - Model-specific system prompt from config
 * @param {string} workingDir
 * @returns {string}
 */
function buildAgenticSystemPrompt(basePrompt, workingDir) {
  const platformRule = process.platform === 'win32'
    ? '8. This is a Windows environment. Use PowerShell or cmd syntax for commands (dir, Get-ChildItem), not Unix (ls, find, wc).'
    : '8. This is a Linux/macOS environment. Use bash commands.';

  return basePrompt + `

You are an autonomous coding agent with tool access. Complete the task using ONLY the provided tools.

RULES:
1. Use tools to read files, make edits, list directories, search code, and run commands.
2. NEVER describe what you would do — actually do it with tools.
3. ONLY modify files explicitly mentioned in the task. Do NOT touch unrelated files.
4. If a build/test fails for reasons UNRELATED to your change, report the failure and stop. Do NOT try to fix pre-existing issues.
5. If a tool call fails, try ONE alternative approach. If that also fails, report the error and stop.
6. When done, respond with a COMPLETE summary that includes the actual data from tool results. Do NOT just say "I called list_directory" — include the actual file/folder names, counts, and content you found.
7. Be efficient — you have limited iterations. Do ONLY what the task asks. If the task says "list directory", just call list_directory once and report. Do NOT write files, run commands, or do extra work unless explicitly asked.
${platformRule}

Working directory: ${workingDir}`;
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
 * @param {Object} params.adapterOptions - Options to pass to adapter (host, apiKey, model, plus tuning)
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

  // Create tool executor
  const executor = createToolExecutor(workingDir, {
    commandMode: serverConfig.get('agentic_command_mode') || 'unrestricted',
    commandAllowlist: (serverConfig.get('agentic_command_allowlist') || '').split(',').filter(Boolean),
  });

  // Capture git snapshot (non-git repos return null)
  let snapshot = null;
  try {
    snapshot = captureSnapshot(workingDir);
  } catch (e) {
    logger.info(`[Agentic] Git snapshot failed (non-git repo?): ${e.message}`);
  }

  // Run agentic loop
  // For prompt-injected tools: pass empty tools array (tools are in the system prompt)
  const result = await runAgenticLoop({
    adapter,
    systemPrompt,
    taskPrompt: task.task_description,
    tools: promptInjectedTools ? [] : TOOL_DEFINITIONS,
    promptInjectedTools,
    toolExecutor: executor,
    options: adapterOptions,
    workingDir,
    timeoutMs,
    maxIterations,
    contextBudget,
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
    const gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode);
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
  const model = task.model || serverConfig.get('ollama_model') || '';
  const capability = isAgenticCapable(provider, model);

  if (!capability.capable || !_agenticDeps) {
    logger.info(`[Agentic] Skipping agentic for ${provider}/${model}: ${capability.reason}`);
    return _executeOllamaModule.executeOllamaTask(task);
  }

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

  // Resolve model
  let resolvedModel = task.model;
  if (!resolvedModel) {
    try {
      const registry = require('../models/registry');
      const best = registry.selectBestApprovedModel('ollama');
      if (best) resolvedModel = best.model_name;
    } catch { /* ignore */ }
  }
  if (!resolvedModel) resolvedModel = serverConfig.get('ollama_model') || '';
  if (!resolvedModel || !ollamaShared.hasModelOnAnyHost(resolvedModel)) {
    const best = ollamaShared.findBestAvailableModel();
    if (best) resolvedModel = best;
  }
  if (!resolvedModel) resolvedModel = 'qwen2.5-coder:32b';

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
    ollamaHost = serverConfig.get('ollama_host') || 'http://localhost:11434';
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

  // Resolve working directory
  let workingDir = task.working_directory;
  if (!workingDir) workingDir = process.cwd();

  // Resolve tuning
  const tuning = providerConfig.resolveOllamaTuning({
    hostId: selectedHostId,
    model: resolvedModel,
    task,
    adaptiveCtx: null,
    includeAutoTuning: true,
    includeHardware: true,
  });
  const tuningOptions = {
    temperature: tuning.temperature,
    num_ctx: tuning.numCtx,
    num_predict: tuning.numPredict,
    top_p: tuning.topP,
    top_k: tuning.topK,
    repeat_penalty: tuning.repeatPenalty,
  };

  // Check if model needs prompt-injected tools
  const usePromptInjection = needsPromptInjection(resolvedModel);

  // Build system prompt
  const basePrompt = providerConfig.resolveSystemPrompt(resolvedModel);
  let systemPrompt = buildAgenticSystemPrompt(basePrompt, workingDir);

  // For prompt-injected tools: append tool definitions to system prompt
  if (usePromptInjection) {
    const toolDefs = TOOL_DEFINITIONS.map(t => JSON.stringify({
      type: t.type, function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
    })).join(',');
    systemPrompt = `[AVAILABLE_TOOLS][${toolDefs}][/AVAILABLE_TOOLS]\n${systemPrompt}\nTo call a tool, respond with ONLY a JSON array: [{"name":"tool_name","arguments":{}}]\nAfter receiving [TOOL_RESULTS], give a clear summary with the ACTUAL data returned.`;
    logger.info(`[Agentic] Model ${resolvedModel} uses prompt-injected tools`);
  }

  // Update status
  db.updateTaskStatus(taskId, 'running', {
    started_at: new Date().toISOString(),
    progress_percent: 10,
    ollama_host_id: selectedHostId,
  });
  dashboard.notifyTaskUpdated(taskId);

  const ollamaStreamId = db.getOrCreateTaskStream(taskId, 'output');
  const timeoutMs = (task.timeout_minutes || 30) * 60 * 1000;
  const abortController = new AbortController();
  // Register abort controller so cancelTask() can find and abort agentic tasks
  const apiAbortControllers = _agenticDeps.apiAbortControllers || (_executeApiModule && _executeApiModule._apiAbortControllers);
  if (apiAbortControllers) apiAbortControllers.set(taskId, abortController);
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  const cancelCheckInterval = setInterval(() => {
    try {
      const t = db.getTask(taskId);
      if (t && t.status === 'cancelled') {
        abortController.abort();
        clearInterval(cancelCheckInterval);
      }
    } catch { /* ignore */ }
  }, 2000);

  try {
    logger.info(`[Agentic] Starting Ollama task ${taskId} with model ${resolvedModel} on ${ollamaHost}`);

    // Category-aware max iterations: complex tasks get more room
    const baseMaxIter = parseInt(serverConfig.get('agentic_max_iterations') || '15', 10);
    const taskComplexity = task.complexity || 'normal';
    const maxIterations = taskComplexity === 'complex' ? Math.max(baseMaxIter, 20) : baseMaxIter;
    const contextBudget = tuning.numCtx ? Math.floor(tuning.numCtx * 0.8) : 16000;

    // Capture git snapshot in main thread (git ops need main process context)
    let snapshot = null;
    try {
      snapshot = captureSnapshot(workingDir);
    } catch (e) {
      logger.info(`[Agentic] Git snapshot failed (non-git repo?): ${e.message}`);
    }

    // Spawn worker thread for the agentic loop
    logger.debug(`[WORKER-DEBUG] Spawning worker for Ollama task ${taskId}, model=${resolvedModel}, host=${ollamaHost}`);
    const workerHandle = spawnAgenticWorker({
      adapterType: 'ollama',
      adapterOptions: {
        host: ollamaHost,
        apiKey: resolveApiKey(provider),
        model: resolvedModel,
        ...tuningOptions,
      },
      systemPrompt,
      taskPrompt: task.task_description,
      workingDir,
      timeoutMs,
      maxIterations,
      contextBudget,
      promptInjectedTools: usePromptInjection,
      commandMode: serverConfig.get('agentic_command_mode') || 'unrestricted',
      commandAllowlist: (serverConfig.get('agentic_command_allowlist') || '').split(',').filter(Boolean),
    }, {
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
        try {
          db.addStreamChunk(ollamaStreamId, msg.text, 'stdout');
          dashboard.notifyTaskOutput(taskId, msg.text);
        } catch { /* ignore */ }
      },
      onLog: (msg) => {
        logger[msg.level || 'info'](msg.message);
      },
    });

    // Wire abort: forward AbortController.abort() → worker abort message
    const origAbortHandler = () => workerHandle.abort();
    abortController.signal.addEventListener('abort', origAbortHandler);

    const result = await workerHandle.promise;

    // Git safety check in main thread (after worker completes)
    if (snapshot && snapshot.isGitRepo) {
      const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
      const mode = safetyMode === 'on' ? 'enforce' : safetyMode === 'warn' ? 'warn' : 'off';
      const gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode);
      if (gitReport.report) {
        result.output += '\n\n--- Git Safety ---\n' + gitReport.report;
      }
    }

    // Store result + metadata in a single status update (avoid double-complete race)
    safeUpdateTaskStatus(taskId, 'completed', {
      output: result.output,
      exit_code: 0,
      progress_percent: 100,
      completed_at: new Date().toISOString(),
      task_metadata: JSON.stringify({
        agentic_log: result.toolLog,
        agentic_token_usage: result.tokenUsage,
      }),
    });

    logger.info(`[Agentic] Ollama task ${taskId} completed: ${result.iterations} iterations, ${(result.toolLog || []).length} tool calls, ${(result.changedFiles || []).length} files changed`);

  } catch (error) {
    logger.info(`[Agentic] Ollama task ${taskId} failed: ${error.message}`);
    safeUpdateTaskStatus(taskId, 'failed', {
      error_output: error.message,
      exit_code: 1,
      completed_at: new Date().toISOString(),
    });
  } finally {
    clearInterval(cancelCheckInterval);
    clearTimeout(timeoutHandle);
    if (apiAbortControllers) apiAbortControllers.delete(taskId);
    if (typeof releaseSelectedHostSlot === 'function') {
      try { releaseSelectedHostSlot(); } catch { /* ignore */ }
    }
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
  const model = task.model || PROVIDER_DEFAULT_MODEL[provider] || '';
  logger.debug(`[API-WRAP] provider=${provider} model=${model} taskId=${task.id}`);

  // Check capability
  const capability = isAgenticCapable(provider, model);
  logger.debug(`[API-WRAP] capable=${capability.capable} reason=${capability.reason} hasDeps=${!!_agenticDeps}`);

  if (!capability.capable || !_agenticDeps) {
    logger.debug(`[API-WRAP] FALLBACK to legacy`);
    return _executeApiModule.executeApiProvider(task, providerInstance);
  }

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

  // Resolve host URL for the provider
  const host = PROVIDER_HOST_MAP[provider] || '';

  // Build system prompt (use default for cloud providers)
  const basePrompt = providerConfig.resolveSystemPrompt(model);
  const systemPrompt = buildAgenticSystemPrompt(basePrompt, workingDir);

  // Update status
  db.updateTaskStatus(taskId, 'running', {
    started_at: new Date().toISOString(),
    progress_percent: 10,
  });
  dashboard.notifyTaskUpdated(taskId);

  const ollamaStreamId = db.getOrCreateTaskStream(taskId, 'output');
  const timeoutMs = (task.timeout_minutes || 30) * 60 * 1000;
  const abortController = new AbortController();
  // Register abort controller for cancellation support
  const apiAbortControllers2 = _agenticDeps.apiAbortControllers || (_executeApiModule && _executeApiModule._apiAbortControllers);
  if (apiAbortControllers2) apiAbortControllers2.set(taskId, abortController);
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  const cancelCheckInterval = setInterval(() => {
    try {
      const t = db.getTask(taskId);
      if (t && t.status === 'cancelled') {
        abortController.abort();
        clearInterval(cancelCheckInterval);
      }
    } catch { /* ignore */ }
  }, 2000);

  try {
    logger.info(`[Agentic] Starting API task ${taskId} with provider ${provider}, model ${model}`);

    // Category-aware max iterations: complex tasks get more room
    const baseMaxIter2 = parseInt(serverConfig.get('agentic_max_iterations') || '15', 10);
    const taskComplexity2 = task.complexity || 'normal';
    const maxIterations = taskComplexity2 === 'complex' ? Math.max(baseMaxIter2, 20) : baseMaxIter2;

    // Derive context budget from provider capabilities
    const PROVIDER_CONTEXT_BUDGETS = {
      'google-ai': 200000, 'deepinfra': 64000, 'hyperbolic': 64000,
      'groq': 32000, 'cerebras': 6000, 'openrouter': 64000, 'ollama-cloud': 64000,
    };
    const contextBudget = PROVIDER_CONTEXT_BUDGETS[provider] || 16000;

    // Check if task has a routing chain (set by smart routing template resolution)
    let chain = null;
    try {
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata || {});
      chain = meta._routing_chain;
    } catch { /* ignore parse errors */ }

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

    if (chain && Array.isArray(chain) && chain.length > 1) {
      // Multi-provider fallback chain — delegate to executeWithFallback
      logger.info(`[Agentic] API task ${taskId} using fallback chain (${chain.length} entries): ${chain.map(e => e.provider).join(' -> ')}`);

      const buildConfig = (entry) => {
        const entryAdapterType = entry.provider === 'ollama-cloud' ? 'ollama'
          : entry.provider === 'google-ai' ? 'google'
          : 'openai';
        return {
          adapterType: entryAdapterType,
          adapterOptions: {
            host: PROVIDER_HOST_MAP[entry.provider] || '',
            apiKey: resolveApiKey(entry.provider),
            model: entry.model || PROVIDER_DEFAULT_MODEL[entry.provider] || '',
            temperature: 0.3,
          },
          systemPrompt,
          taskPrompt: task.task_description,
          workingDir,
          timeoutMs,
          maxIterations,
          contextBudget: PROVIDER_CONTEXT_BUDGETS[entry.provider] || contextBudget,
          promptInjectedTools: needsPromptInjection(entry.model || ''),
          commandMode: serverConfig.get('agentic_command_mode') || 'unrestricted',
          commandAllowlist: (serverConfig.get('agentic_command_allowlist') || '').split(',').filter(Boolean),
        };
      };

      result = await executeWithFallback(task, chain, buildConfig, workerCallbacks);
      logger.info(`[Agentic] API task ${taskId} completed via chain position ${result.chainPosition}: ${result.provider}/${result.model || 'default'}`);
    } else {
      // Single-provider path (no chain or single-entry chain)
      // Capture git snapshot in main thread (git ops need main process context)
      let snapshot = null;
      try {
        snapshot = captureSnapshot(workingDir);
      } catch (e) {
        logger.info(`[Agentic] Git snapshot failed (non-git repo?): ${e.message}`);
      }

      // Resolve adapter type for the worker
      const adapterType = provider === 'ollama-cloud' ? 'ollama'
        : provider === 'google-ai' ? 'google'
        : 'openai';

      // Spawn worker thread for the agentic loop
      logger.debug(`[WORKER-DEBUG] Spawning worker for API task ${taskId}, provider=${provider}, model=${model}, adapterType=${adapterType}`);
      const workerHandle = spawnAgenticWorker({
        adapterType,
        adapterOptions: {
          host,
          apiKey,
          model,
          temperature: 0.3,
        },
        systemPrompt,
        taskPrompt: task.task_description,
        workingDir,
        timeoutMs,
        maxIterations,
        contextBudget,
        promptInjectedTools: false,
        commandMode: serverConfig.get('agentic_command_mode') || 'unrestricted',
        commandAllowlist: (serverConfig.get('agentic_command_allowlist') || '').split(',').filter(Boolean),
      }, workerCallbacks);

      // Wire abort: forward AbortController.abort() → worker abort message
      const origAbortHandler = () => workerHandle.abort();
      abortController.signal.addEventListener('abort', origAbortHandler);

      result = await workerHandle.promise;

      // Git safety check in main thread (after worker completes)
      if (snapshot && snapshot.isGitRepo) {
        const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
        const mode = safetyMode === 'on' ? 'enforce' : safetyMode === 'warn' ? 'warn' : 'off';
        const gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode);
        if (gitReport.report) {
          result.output += '\n\n--- Git Safety ---\n' + gitReport.report;
        }
      }
    }

    // Store result + metadata in a single status update (avoid double-complete race)
    safeUpdateTaskStatus(taskId, 'completed', {
      output: result.output,
      exit_code: 0,
      progress_percent: 100,
      completed_at: new Date().toISOString(),
      task_metadata: JSON.stringify({
        agentic_log: result.toolLog,
        agentic_token_usage: result.tokenUsage,
        ...(result.chainPosition ? { chain_provider: result.provider, chain_position: result.chainPosition } : {}),
      }),
    });

    logger.info(`[Agentic] API task ${taskId} completed: ${result.iterations} iterations, ${(result.toolLog || []).length} tool calls, ${(result.changedFiles || []).length} files changed`);

  } catch (error) {
    logger.info(`[Agentic] API task ${taskId} failed: ${error.message}`);
    safeUpdateTaskStatus(taskId, 'failed', {
      error_output: error.message,
      exit_code: 1,
      completed_at: new Date().toISOString(),
    });
  } finally {
    clearInterval(cancelCheckInterval);
    clearTimeout(timeoutHandle);
    if (apiAbortControllers2) apiAbortControllers2.delete(taskId);
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
  return /429|503|timeout|timed out|econnrefused|econnreset|quota|rate.limit|overloaded|provider returned error/.test(msg);
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
async function executeWithFallback(task, chain, buildWorkerConfig, callbacks) {
  const workingDir = task.working_directory || process.cwd();

  // Capture git snapshot ONCE before any attempts
  let snapshot = null;
  try { snapshot = captureSnapshot(workingDir); } catch { /* non-git dir */ }

  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const config = buildWorkerConfig(entry);

    logger.info(`[Routing] Trying ${entry.provider}/${entry.model || 'default'} (${i + 1}/${chain.length})`);

    let workerHandle;
    try {
      workerHandle = spawnAgenticWorker(config, callbacks);
      const result = await workerHandle.promise;

      // Success — run git safety and return
      if (snapshot && snapshot.isGitRepo) {
        const serverConfig = require('../config');
        const safetyMode = serverConfig.get('agentic_git_safety') || 'on';
        const mode = safetyMode === 'warn' ? 'warn' : safetyMode === 'off' ? 'off' : 'enforce';
        const gitReport = checkAndRevert(workingDir, snapshot, task.task_description, mode);
        if (gitReport.report) result.output += '\n\n--- Git Safety ---\n' + gitReport.report;
      }

      // Record success
      try { recordProviderOutcome(entry.provider, true); } catch { /* non-critical */ }

      return { ...result, provider: entry.provider, model: entry.model, chainPosition: i + 1 };

    } catch (error) {
      lastError = error;

      // Terminate the stuck worker
      if (workerHandle) try { workerHandle.terminate(); } catch { /* ignore */ }

      // Revert any partial changes before retrying
      if (snapshot && snapshot.isGitRepo) {
        try { checkAndRevert(workingDir, snapshot, task.task_description, 'enforce'); } catch { /* ignore */ }
      }

      // Record failure
      try { recordProviderOutcome(entry.provider, false); } catch { /* non-critical */ }

      if (!isRetryableError(error) || i === chain.length - 1) {
        logger.info(`[Routing] ${entry.provider} failed (non-retryable or last in chain): ${error.message}`);
        throw error;
      }

      logger.info(`[Routing] Fallback: ${entry.provider}/${entry.model || 'default'} failed (${error.message.slice(0, 80)}), trying next (${i + 2}/${chain.length})`);
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
  // From execute-hashline.js
  executeHashlineOllamaTask: _executeHashlineModule.executeHashlineOllamaTask,
  runOllamaGenerate: _executeHashlineModule.runOllamaGenerate,
  parseAndApplyEdits: _executeHashlineModule.parseAndApplyEdits,
  runErrorFeedbackLoop: _executeHashlineModule.runErrorFeedbackLoop,
  // From execute-cli.js
  buildAiderOllamaCommand: _executeCliModule.buildAiderOllamaCommand,
  buildClaudeCliCommand: _executeCliModule.buildClaudeCliCommand,
  buildCodexCommand: _executeCliModule.buildCodexCommand,
  spawnAndTrackProcess: _executeCliModule.spawnAndTrackProcess,
  // Legacy backward compat
  runAgenticPipeline,
};
