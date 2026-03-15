/**
 * providers/execution.js — Provider execution aggregator
 *
 * Thin aggregator that delegates to sub-modules:
 * - execute-api.js      — executeApiProvider (API-based providers)
 * - execute-ollama.js   — executeOllamaTask, estimateRequiredContext (plain Ollama)
 * - execute-hashline.js — executeHashlineOllamaTask, executeHashlineOpenaiTask, error-feedback helpers
 * - execute-cli.js      — buildAiderOllamaCommand, buildClaudeCliCommand, buildCodexCommand, spawnAndTrackProcess
 *
 * Preserves the original init() DI interface — all dependencies are forwarded to sub-modules.
 */

'use strict';

const _executeApiModule = require('./execute-api');
const _executeOllamaModule = require('./execute-ollama');
const _executeHashlineModule = require('./execute-hashline');
const _executeCliModule = require('./execute-cli');

/**
 * Initialize all sub-modules with dependencies from task-manager.js.
 * Accepts the same deps object as the original monolithic init().
 */
function init(deps) {
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

module.exports = {
  init,
  // From execute-ollama.js
  estimateRequiredContext: _executeOllamaModule.estimateRequiredContext,
  executeOllamaTask: _executeOllamaModule.executeOllamaTask,
  // From execute-api.js
  executeApiProvider: _executeApiModule.executeApiProvider,
  // From execute-hashline.js
  executeHashlineOllamaTask: _executeHashlineModule.executeHashlineOllamaTask,
  executeHashlineOpenaiTask: _executeHashlineModule.executeHashlineOpenaiTask,
  runOllamaGenerate: _executeHashlineModule.runOllamaGenerate,
  parseAndApplyEdits: _executeHashlineModule.parseAndApplyEdits,
  runErrorFeedbackLoop: _executeHashlineModule.runErrorFeedbackLoop,
  // From execute-cli.js
  buildAiderOllamaCommand: _executeCliModule.buildAiderOllamaCommand,
  buildClaudeCliCommand: _executeCliModule.buildClaudeCliCommand,
  buildCodexCommand: _executeCliModule.buildCodexCommand,
  spawnAndTrackProcess: _executeCliModule.spawnAndTrackProcess,
};
