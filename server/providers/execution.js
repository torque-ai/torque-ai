/**
 * providers/execution.js — Provider execution aggregator
 *
 * Thin aggregator that delegates to sub-modules:
 * - execute-api.js      — executeApiProvider (API-based providers)
 * - execute-ollama.js   — executeOllamaTask, estimateRequiredContext (plain Ollama)
 * - execute-hashline.js — executeHashlineOllamaTask, error-feedback helpers
 * - execute-cli.js      — buildAiderOllamaCommand, buildClaudeCliCommand, buildCodexCommand, spawnAndTrackProcess
 *
 * Preserves the original init() DI interface — all dependencies are forwarded to sub-modules.
 */

'use strict';

const _executeApiModule = require('./execute-api');
const _executeOllamaModule = require('./execute-ollama');
const _executeHashlineModule = require('./execute-hashline');
const _executeCliModule = require('./execute-cli');
const { runAgenticLoop } = require('./ollama-agentic');

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
  };

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
// Module exports — re-export all functions from sub-modules
// ============================================================

// Deps captured at init time for the agentic wrapper
let _agenticDeps = null;

/**
 * Agentic wrapper around executeOllamaTask.
 * When ollama_agentic_enabled !== '0', intercepts the task and runs it
 * through /api/chat with tool calling instead of /api/generate.
 */
async function executeOllamaTaskWithAgentic(task) {
  const serverConfig = require('../config');
  const agenticEnabled = serverConfig.get('ollama_agentic_enabled') !== '0';

  if (!agenticEnabled || !_agenticDeps) {
    return _executeOllamaModule.executeOllamaTask(task);
  }

  const { db, dashboard, safeUpdateTaskStatus, processQueue } = _agenticDeps;
  const providerConfig = require('./config');
  const ollamaShared = require('./ollama-shared');
  const logger = require('../logger').child({ component: 'ollama-agentic-wrapper' });
  const taskId = task.id;

  // Let the original function handle host selection + slot reservation
  // by running it but intercepting at the generate step.
  // Simpler approach: do host resolution here minimally, then run agentic loop.

  // Resolve model
  let model = task.model;
  if (!model) {
    try {
      const registry = require('../models/registry');
      const best = registry.selectBestApprovedModel('ollama');
      if (best) model = best.model_name;
    } catch { /* ignore */ }
  }
  if (!model) model = serverConfig.get('ollama_model') || '';
  if (!model || !ollamaShared.hasModelOnAnyHost(model)) {
    const best = ollamaShared.findBestAvailableModel();
    if (best) model = best;
  }
  if (!model) model = 'qwen2.5-coder:32b';

  // Resolve host
  const hosts = db.listOllamaHosts ? db.listOllamaHosts() : [];
  let ollamaHost = null;
  let selectedHostId = null;

  if (hosts.length > 0) {
    const selection = db.selectOllamaHostForModel(model);
    if (selection.host) {
      ollamaHost = selection.host.url;
      selectedHostId = selection.host.id;
    }
  }
  if (!ollamaHost) {
    ollamaHost = serverConfig.get('ollama_host') || 'http://localhost:11434';
  }

  // Resolve working directory
  let workingDir = task.working_directory;
  if (!workingDir) workingDir = process.cwd();

  // Resolve tuning
  const tuning = providerConfig.resolveOllamaTuning({
    hostId: selectedHostId,
    model,
    task,
    adaptiveCtx: null,
    includeAutoTuning: true,
    includeHardware: true,
  });
  const options = {
    temperature: tuning.temperature,
    num_ctx: tuning.numCtx,
    num_predict: tuning.numPredict,
    top_p: tuning.topP,
    top_k: tuning.topK,
    repeat_penalty: tuning.repeatPenalty,
  };

  const systemPrompt = providerConfig.resolveSystemPrompt(model) + `

You are an autonomous coding agent with tool access. Complete the task using ONLY the provided tools.

RULES:
1. Use tools to read files, make edits, list directories, search code, and run commands.
2. NEVER describe what you would do — actually do it with tools.
3. ONLY modify files explicitly mentioned in the task. Do NOT touch unrelated files.
4. If a build/test fails for reasons UNRELATED to your change, report the failure and stop. Do NOT try to fix pre-existing issues.
5. If a tool call fails, try ONE alternative approach. If that also fails, report the error and stop.
6. When done, respond with a brief summary of what you did and what changed.
7. Be efficient — you have limited iterations. Read the file, make the edit, verify if needed, done.
8. This is a Windows environment. Use PowerShell or cmd syntax for commands (dir, Get-ChildItem), not Unix (ls, find, wc).

Working directory: ${workingDir}`;

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
    logger.info(`[Agentic] Starting task ${taskId} with model ${model} on ${ollamaHost}`);

    const result = await runAgenticLoop({
      host: ollamaHost,
      model,
      systemPrompt,
      taskPrompt: task.task_description,
      options,
      workingDir,
      timeoutMs,
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
      onChunk: (text) => {
        try {
          db.addStreamChunk(ollamaStreamId, text, 'stdout');
          dashboard.notifyTaskOutput(taskId, text);
        } catch { /* ignore */ }
      },
      signal: abortController.signal,
    });

    safeUpdateTaskStatus(taskId, 'completed', {
      output: result.output,
      exit_code: 0,
      progress_percent: 100,
      completed_at: new Date().toISOString(),
    });

    logger.info(`[Agentic] Task ${taskId} completed: ${result.iterations} iterations, ${result.toolLog.length} tool calls, ${result.changedFiles.length} files changed`);

  } catch (error) {
    logger.info(`[Agentic] Task ${taskId} failed: ${error.message}`);
    safeUpdateTaskStatus(taskId, 'failed', {
      error_output: error.message,
      exit_code: 1,
      completed_at: new Date().toISOString(),
    });
  } finally {
    clearInterval(cancelCheckInterval);
    clearTimeout(timeoutHandle);
    if (selectedHostId) {
      try { db.decrementHostTasks(selectedHostId); } catch { /* ignore */ }
    }
    dashboard.notifyTaskUpdated(taskId);
    processQueue();
  }
}

module.exports = {
  init,
  // From execute-ollama.js (wrapped with agentic interceptor)
  estimateRequiredContext: _executeOllamaModule.estimateRequiredContext,
  executeOllamaTask: executeOllamaTaskWithAgentic,
  // From execute-api.js
  executeApiProvider: _executeApiModule.executeApiProvider,
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
};
