/**
 * Task Manager for TORQUE
 * Handles spawning, tracking, and managing Codex CLI processes
 *
 * Note: Uses spawn() (not exec()) for security - no shell injection possible
 */

// spawn moved to execution/process-lifecycle.js (D4.3)
const crypto = require('crypto');
const db = require('./database');
const taskCore = require('./db/task-core');
const coordination = require('./db/coordination');
const providerRoutingCore = require('./db/provider-routing-core');
const dashboard = require('./dashboard-server');
const logger = require('./logger').child({ component: 'task-manager' });
const providerRegistry = require('./providers/registry');
const providerCfg = require('./providers/config');
const serverConfig = require('./config');
const FreeQuotaTracker = require('./free-quota-tracker');
const gpuMetrics = require('./scripts/gpu-metrics-server');
const eventBus = require('./event-bus');

// ── Early dependency initialization ───────────────────────────────────────
// Called explicitly from index.js:init() before provider usage.
// Also auto-called on first use if db is available (backward compat for tests).
let _earlyDepsInitialized = false;

function initEarlyDeps() {
  if (_earlyDepsInitialized) return;
  // Guard: don't init if db isn't ready yet
  if (!db || !db.isReady || !db.isReady()) return;
  _earlyDepsInitialized = true;

  // Register API provider classes for lazy initialization via registry
  providerRegistry.init({ db });
  providerCfg.init({ db });
  serverConfig.init({ db });
  providerRegistry.registerProviderClass('anthropic', require('./providers/anthropic'));
  providerRegistry.registerProviderClass('groq', require('./providers/groq'));
  providerRegistry.registerProviderClass('hyperbolic', require('./providers/hyperbolic'));
  providerRegistry.registerProviderClass('deepinfra', require('./providers/deepinfra'));
  providerRegistry.registerProviderClass('ollama-cloud', require('./providers/ollama-cloud'));
  providerRegistry.registerProviderClass('cerebras', require('./providers/cerebras'));
  providerRegistry.registerProviderClass('google-ai', require('./providers/google-ai'));
  providerRegistry.registerProviderClass('openrouter', require('./providers/openrouter'));
}
const { TASK_TIMEOUTS, PROVIDER_DEFAULT_TIMEOUTS
} = require('./constants');
const { sanitizeLLMOutput } = require('./utils/sanitize');
const { parseModelSizeB, isSmallModel, getModelSizeCategory, isThinkingModel } = require('./utils/model');
const { parseGitStatusLine, getModifiedFiles } = require('./utils/git');
const _fileResolution = require('./utils/file-resolution');
const hostMonitoring = require('./utils/host-monitoring');
const contextEnrichment = require('./utils/context-enrichment');
const tsserverClient = require('./utils/tsserver-client');
const activityMonitoring = require('./utils/activity-monitoring');
const _taskExecutionHooks = require('./policy-engine/task-execution-hooks');

// TIMEOUT MECHANISM OVERLAP — authoritative summary:
//
// TORQUE has three partially-overlapping timeout/cleanup mechanisms for running tasks.
// Understanding which is authoritative prevents confusion when diagnosing stuck tasks:
//
// 1. STALL DETECTION (execution/stall-detection.js) — per-task, real-time, AUTHORITATIVE for timeouts
//    Watches stdout/stderr for inactivity. Threshold: provider-specific (Ollama=180s, Codex=600s).
//    When triggered: cancels the task and resubmits with provider fallback.
//    This is the primary mechanism — it fires while the task is running and has provider context.
//
// 2. STARTUP ORPHAN CLEANUP (index.js init()) — one-shot at server start, catch-up only
//    At startup, scans all tasks in 'running' state that belong to dead/missing instances.
//    Uses task.timeout_minutes (per-task config, default 30min) as the grace threshold.
//    Requeues tasks (up to max_retries) rather than failing, since the owning instance crashed.
//    NOT a real-time mechanism — only fires once per server start.
//
// 3. MAINTENANCE SCHEDULER (index.js startMaintenanceScheduler, 'cleanup_stale_tasks') — periodic sweep
//    Runs every minute (maintenance interval) when 'cleanup_stale_tasks' is due.
//    Uses DB config: stale_running_minutes (default 60), stale_queued_minutes (default 1440).
//    Marks tasks failed if they exceed these thresholds regardless of active instance.
//    This is the long-stop — catches tasks that stall detection missed (e.g., Ollama provider
//    that lost its stall handler due to a partial crash).
//
// PRECEDENCE: Stall detection > Startup orphan cleanup > Maintenance sweep.
// If all three agree a task is dead, maintenance sweep wins by sheer time elapsed.
// If stall detection is disabled for a provider, maintenance sweep becomes the authority.

// Extracted modules (Phase 3 decomposition — re-wired)
const _executionModule = require('./providers/execution');
const executeApi = require('./providers/execute-api');
const _postTaskModule = require('./validation/post-task');
const createCancellationHandler = require('./execution/task-cancellation');
const createStallDetectionHandler = require('./execution/stall-detection');
const _fallbackRetryModule = require('./execution/fallback-retry');
const _workflowRuntimeModule = require('./execution/workflow-runtime');
const _outputSafeguards = require('./validation/output-safeguards');
const _orphanCleanup = require('./maintenance/orphan-cleanup');
const _instanceManager = require('./coordination/instance-manager');

// Phase 7-10 extracted modules
const _promptsModule = require('./providers/prompts');
const _closePhases = require('./validation/close-phases');
const _autoVerifyRetry = require('./validation/auto-verify-retry');
const _retryFramework = require('./execution/retry-framework');
const _safeguardGates = require('./validation/safeguard-gates');
const completionDetection = require('./validation/completion-detection');
const _queueScheduler = require('./execution/queue-scheduler');
const _taskFinalizer = require('./execution/task-finalizer');
const _sandboxRevertDetection = require('./execution/sandbox-revert-detection');
const _completionPipeline = require('./execution/completion-pipeline');
const _fileContextBuilder = require('./execution/file-context-builder');
const _providerRouter = require('./execution/provider-router');
const _taskUtils = require('./execution/task-utils');
const _planProjectResolver = require('./execution/plan-project-resolver');
const _processLifecycle = require('./execution/process-lifecycle');
const { safeDecrementHostSlot, killProcessGraceful, safeTriggerWebhook, cleanupProcessTracking, cleanupChildProcessListeners } = _processLifecycle;
const debugLifecycle = require('./execution/debug-lifecycle');
const _processStreams = require('./execution/process-streams');
const _commandBuilders = require('./execution/command-builders');
const ProcessTracker = require('./execution/process-tracker');
const _taskStartup = require('./execution/task-startup');
const codexIntelligence = require('./providers/codex-intelligence');

// Phase D3: All pure pass-through delegation stubs extracted to task-manager-delegations.js
const {
  computeLineHash, lineSimilarity,
  isShellSafe, extractTargetFilesFromDescription,
  buildFileIndex, extractFileReferencesExpanded, resolveFileReferences,
  isValidFilePath, extractModifiedFiles,
  isModelLoadedOnHost, getHostActivity, pollHostActivity,
  probeLocalGpuMetrics, probeRemoteGpuMetrics,
  getTaskActivity, getAllTaskActivity, canAcceptTask,
  registerInstance, startInstanceHeartbeat, stopInstanceHeartbeat,
  unregisterInstance, updateInstanceInfo, isInstanceAlive, getMcpInstanceId,
  cleanupJunkFiles, getFileChangesForValidation, findPlaceholderArtifacts,
  checkFileQuality, checkDuplicateFiles, checkSyntax, runLLMSafeguards,
  runBuildVerification, runTestVerification, runStyleCheck,
  rollbackTaskChanges, revertScopedFiles, scopedRollback,
  detectTaskTypes, getInstructionTemplate, wrapWithInstructions,
  executeApiProvider, executeOllamaTask,
  tryOllamaCloudFallback, tryLocalFirstFallback, classifyError,
  handlePipelineStepCompletion, handleWorkflowTermination,
  evaluateWorkflowDependencies, unblockTask, applyFailureAction,
  cancelDependentTasks, checkWorkflowCompletion,
  runOutputSafeguards,
  handleSandboxRevertDetection,
  handleAutoValidation, handleBuildTestStyleCommit, handleProviderFailover,
  recordModelOutcome, recordProviderHealth,
  handlePostCompletion,
  finalizeTask,
  categorizeQueuedTasks, processQueueInternal,
  cleanupOrphanedHostTasks, getStallThreshold,
} = require('./task-manager-delegations');

const WORKFLOW_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);

let workflowTransitionListenerRegistered = false;

// Policy evaluation hooks — delegated to policy-engine/task-execution-hooks.js
function buildPolicyTaskData(...args) { return _taskExecutionHooks.buildPolicyTaskData(...args); }
function getPolicyBlockReason(...args) { return _taskExecutionHooks.getPolicyBlockReason(...args); }
function evaluateTaskSubmissionPolicy(...args) { return _taskExecutionHooks.evaluateTaskSubmissionPolicy(...args); }
function evaluateTaskPreExecutePolicy(...args) { return _taskExecutionHooks.evaluateTaskPreExecutePolicy(...args); }
function fireTaskCompletionPolicyHook(...args) { return _taskExecutionHooks.fireTaskCompletionPolicyHook(...args); }

function handleTaskStatusTransitionForWorkflow(taskId, status, previousStatus) {
  if (WORKFLOW_TERMINAL_STATUSES.has(status) && previousStatus !== status) {
    try {
      const updatedTask = taskCore.getTask(taskId);
      fireTaskCompletionPolicyHook(updatedTask || { id: taskId, status });
    } catch (err) {
      logger.info(`[TaskManager] Failed to fire completion policy hook for ${taskId}: ${err.message}`);
    }
  }

  try {
    if (!WORKFLOW_TERMINAL_STATUSES.has(status) || previousStatus === status) return;
    handleProjectDependencyResolution(taskId, status);
    if (typeof handleWorkflowTermination === 'function') {
      handleWorkflowTermination(taskId);
    }
  } catch (err) {
    logger.info(`[TaskManager] Failed to trigger terminal dependency resolution for ${taskId}: ${err.message}`);
  }
}

function registerTaskStatusTransitionListener() {
  if (workflowTransitionListenerRegistered) return;
  if (typeof db.addTaskStatusTransitionListener !== 'function') return;
  db.addTaskStatusTransitionListener(handleTaskStatusTransitionForWorkflow);
  workflowTransitionListenerRegistered = true;
}

/**
 * Parse metadata on task rows into a normalised object.
 * Handles JSON strings, already-parsed objects, and malformed values safely.
 * @param {Object|string|null} rawMetadata
 * @returns {Object}
 */
// Task metadata / token utilities — delegated to execution/task-utils.js
function parseTaskMetadata(...args) { return _taskUtils.parseTaskMetadata(...args); }
function getTaskContextTokenEstimate(...args) { return _taskUtils.getTaskContextTokenEstimate(...args); }


// Provider instances now managed by providerRegistry.getProviderInstance()
// Legacy getters below delegate to registry for backward compatibility
let freeQuotaTracker = null;

// NOTE: getFreeQuotaTracker uses a lazy singleton. Node.js is single-threaded
// so there is no concurrent-init race in the event loop, but if this function
// is ever called from multiple worker threads the `if (!freeQuotaTracker)`
// check would not be atomic. Currently safe — only called from the main thread.
function getFreeQuotaTracker() {
  if (!freeQuotaTracker) {
    const limits = db.getProviderRateLimits ? db.getProviderRateLimits() : [];
    freeQuotaTracker = new FreeQuotaTracker(limits);
    // Wire DB module so daily snapshots persist when quota windows reset
    if (db.recordDailySnapshot) {
      freeQuotaTracker.setDb(db);
    }
  }
  return freeQuotaTracker;
}

if (executeApi.setFreeQuotaTracker) executeApi.setFreeQuotaTracker(getFreeQuotaTracker);

// Provider getters removed — queue-scheduler uses providerRegistry.getProviderInstance() directly

// Track running processes by task ID
const runningProcesses = new ProcessTracker();

// All process-tracking Maps are now consolidated inside ProcessTracker:
//   runningProcesses (the Map itself)     — process records
//   runningProcesses.abortControllers     — API task abort controllers
//   runningProcesses.retryTimeouts        — pending retry timeout handles
//   runningProcesses.stallAttempts         — stall recovery state
//   runningProcesses.cleanupGuard         — double-cleanup prevention with TTL
// Backward-compatible aliases for DI consumers:
const apiAbortControllers = runningProcesses.abortControllers;
const pendingRetryTimeouts = runningProcesses.retryTimeouts;
const stallRecoveryAttempts = runningProcesses.stallAttempts;
const taskCleanupGuard = runningProcesses.cleanupGuard;

const PROCESS_QUEUE_DEBOUNCE_MS = 15;
let _processQueueTimer = null;
let _processQueuePending = false;
let _lastProcessQueueCall = 0;

// Track pending close handlers to allow tests to wait for all async work to finish.
// On Windows, vitest kills worker forks without propagating signals, so any
// in-flight execFileSync('git', ...) calls inside the close handler become orphans.
let pendingCloseHandlers = 0;
let closeHandlerResolvers = []; // Callbacks to notify when pendingCloseHandlers hits 0

// Test mode flag: when true, getActualModifiedFiles() returns null immediately,
// preventing git process spawning in close handlers during E2E tests with mock processes.
let skipGitInCloseHandler = false;

/** Resolve any promises waiting for close handlers to finish. */
function drainCloseHandlerResolvers() {
  if (pendingCloseHandlers <= 0) {
    pendingCloseHandlers = 0; // clamp
    const resolvers = closeHandlerResolvers;
    closeHandlerResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

/**
 * Wait for all in-flight close handlers to complete.
 * Returns immediately if none are pending.
 * @param {number} timeout - Max wait time in ms (default 15000)
 */
function waitForPendingHandlers(timeout = 15000) {
  if (pendingCloseHandlers <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Remove ourselves from the list if we time out
      closeHandlerResolvers = closeHandlerResolvers.filter(r => r !== wrappedResolve);
      resolve(); // Don't reject — just stop waiting
    }, timeout);
    const wrappedResolve = () => { clearTimeout(timer); resolve(); };
    closeHandlerResolvers.push(wrappedResolve);
  });
}

// File index cache moved to utils/file-resolution.js

/**
 * Mark a task as cleaned up and check if it was already cleaned
 * Returns true if this is the first cleanup (should proceed), false if already cleaned
 * Delegates to ProcessTracker.markCleanedUp() which handles TTL sweep.
 * @param {string} taskId - The task ID to check/mark
 * @returns {boolean} True if cleanup should proceed, false if already cleaned up
 */
function markTaskCleanedUp(taskId) {
  return runningProcesses.markCleanedUp(taskId);
}

// Lock flag to prevent concurrent processQueue() calls within the same process
// This prevents race conditions when multiple event handlers trigger processQueue simultaneously
let processQueueLock = false;
let isShuttingDown = false;

// Unique holder ID for distributed locking (process ID + random suffix for uniqueness)
// SECURITY (M7): Use crypto.randomUUID() instead of Math.random() for lock IDs
const QUEUE_LOCK_HOLDER_ID = `mcp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const QUEUE_LOCK_NAME = 'queue_processor';
// SINGLE-MACHINE ASSUMPTION: The distributed lock lease expiry (30s) does not account for
// cross-machine clock skew. This is intentional — TORQUE's SQLite DB is a local file and
// is not shared across machines. Multiple TORQUE instances coordinate via the mcp_instances
// table (process.pid + instance UUID) on the same host only. If a shared-disk multi-host
// deployment were added in the future, lease expiry logic would need NTP-synchronized clocks
// or a clock-skew tolerance margin added to QUEUE_LOCK_LEASE_SECONDS.
const QUEUE_LOCK_LEASE_SECONDS = 30; // Lock expires after 30 seconds if not released

// Shell escaping — delegated to execution/task-utils.js
function shellEscape(...args) { return _taskUtils.shellEscape(...args); }

// TASK_TIMEOUTS and PROVIDER_DEFAULT_TIMEOUTS imported from ./constants.js

// Task output sanitization — delegated to execution/task-utils.js
function sanitizeTaskOutput(...args) { return _taskUtils.sanitizeTaskOutput(...args); }

/**
 * Safely update task status with automatic recovery from state conflicts
 * Uses softFail mode to prevent crashes when tasks are already in terminal states
 * @param {string} taskId - The task ID to update
 * @param {string} status - The target status
 * @param {object} fields - Additional fields to update
 * @returns {object|null} The updated task, or null if update was skipped
 */
function safeUpdateTaskStatus(taskId, status, fields = {}) {
  try {
    // Use softFail mode to gracefully handle terminal state conflicts
    return taskCore.updateTaskStatus(taskId, status, { ...fields, _softFail: true });
  } catch (err) {
    // Even with softFail, some errors may still occur (db corruption, etc.)
    if (err.message.includes('Cannot transition')) {
      logger.info(`[SafeUpdate] State conflict for ${taskId}: ${err.message.slice(0, 80)}`);
      try {
        return taskCore.getTask(taskId);
      } catch {
        return null;
      }
    }
    // Log but don't crash for other errors
    logger.info(`[SafeUpdate] Error updating ${taskId}: ${err.message}`);
    return null;
  }
}

// execFileSync moved to execution/task-startup.js

/**
 * Atomically try to reserve a host slot with proper race handling.
 * Delegated to execution/provider-router.js
 */
function tryReserveHostSlotWithFallback(...args) { return _providerRouter.tryReserveHostSlotWithFallback(...args); }

// Retry cleanup delegated to execution/task-startup.js

// ============================================================
// LLM Output Safeguards
// ============================================================

/**
 * Extract function boundaries from a JS/TS file.
 * Delegated to execution/file-context-builder.js
 */
function extractJsFunctionBoundaries(...args) { return _fileContextBuilder.extractJsFunctionBoundaries(...args); }

/**
 * Ensure target files exist on disk (create stubs if needed).
 * Delegated to execution/file-context-builder.js
 */
function ensureTargetFilesExist(...args) { return _fileContextBuilder.ensureTargetFilesExist(...args); }


// ============================================================
// Pre-Execution File Resolution (delegated to utils/file-resolution.js)
// ============================================================

/**
 * Build formatted file context block from resolved files.
 * Delegated to execution/file-context-builder.js
 */
function buildFileContext(...args) { return _fileContextBuilder.buildFileContext(...args); }


// Delegated to providers/prompts.js (Phase 7A)
const DEFAULT_INSTRUCTION_TEMPLATES = _promptsModule.DEFAULT_INSTRUCTION_TEMPLATES;

// Dead code removed (Round 44): detectTaskComplexity() and selectModelForTaskComplexity()
// were superseded by database.js determineTaskComplexity() + getModelTierForComplexity()
// which are used by the smart submit flow in integration-handlers.js.

// isSmallModel, isThinkingModel imported from ./utils/model.js

/**
 * Try to create an automatic PR after successful task completion.
 * Delegated to execution/provider-router.js
 */
function tryCreateAutoPR(...args) { return _providerRouter.tryCreateAutoPR(...args); }

// cleanupOrphanedRetryTimeouts delegated to execution/task-startup.js
function cleanupOrphanedRetryTimeouts() { return _taskStartup.cleanupOrphanedRetryTimeouts(); }

// MAX_OUTPUT_BUFFER, getNvmNodePath, NVM_NODE_PATH, resolveWindowsCmdToNode
// delegated to execution/task-startup.js
const MAX_OUTPUT_BUFFER = _taskStartup.MAX_OUTPUT_BUFFER;
const NVM_NODE_PATH = _taskStartup.NVM_NODE_PATH;
function resolveWindowsCmdToNode(...args) { return _taskStartup.resolveWindowsCmdToNode(...args); }

// PROVIDER_DEFAULT_TIMEOUTS imported from ./constants.js

/**
 * Safely parse config integer value with bounds checking.
 * Delegated to execution/provider-router.js
 */
function safeConfigInt(...args) { return _providerRouter.safeConfigInt(...args); }

/**
 * Resolve plan project dependencies after a task reaches a terminal state.
 * This keeps plan project counters and downstream task statuses in sync even
 * when tasks are completed or failed outside the main close handler.
 * @param {string} taskId - Task identifier.
 * @param {string} newStatus - New task status.
 * @returns {void}
 */
// Plan project dependency resolution — delegated to execution/plan-project-resolver.js
function handleProjectDependencyResolution(...args) { return _planProjectResolver.handleProjectDependencyResolution(...args); }
function handlePlanProjectTaskCompletion(...args) { return _planProjectResolver.handlePlanProjectTaskCompletion(...args); }
function handlePlanProjectTaskFailure(...args) { return _planProjectResolver.handlePlanProjectTaskFailure(...args); }

// ═══════════════════════════════════════════════════════════════════════════
// Close-handler helpers (extracted from startTask's child.on('close', ...))
// Each reads/writes a shared `ctx` object instead of deeply nested closures.
// ═══════════════════════════════════════════════════════════════════════════

// Phase 0: Race guard + cleanup — delegated to execution/process-lifecycle.js
function handleCloseCleanup(taskId, code) {
  return _processLifecycle.handleCloseCleanup(taskId, code);
}

// Phase 1: Retry logic — delegated to execution/retry-framework.js
function handleRetryLogic(ctx) {
  return _retryFramework.handleRetryLogic(ctx);
}

// Phase 2: Safeguard checks — delegated to validation/safeguard-gates.js
function handleSafeguardChecks(ctx) {
  return _safeguardGates.handleSafeguardChecks(ctx);
}

/**
 * Phase 3: Fuzzy SEARCH/REPLACE repair (no-op — legacy phase removed).
 */
function handleFuzzyRepair(_ctx) {
  // No-op — legacy phase removed
}

/**
 * Conversational refusal detection — LLM asks for info instead of doing work.
 * Exported for testing.
 */
const CONVERSATIONAL_REFUSAL_PATTERN = /\b(I'm ready to|share the files|provide more information|which files you want)\b/i;

/**
 * Phase 4: Detect no-file-change tasks (no-op — legacy phase removed).
 */
function handleNoFileChangeDetection(_ctx) {
  // No-op — legacy phase removed
}


// ──────────────────────────────────────────────────────────────
// Provider command builders — extracted from startTask dispatch
// ──────────────────────────────────────────────────────────────

// buildClaudeCliCommand and buildCodexCommand delegated to execution/command-builders.js

/**
 * Build claude-cli CLI command and arguments.
 *
 * @param {object} task - Task record from DB
 * @param {object} providerConfig - Provider configuration from DB
 * @param {string} resolvedFileContext - Pre-resolved file context string
 * @returns {{ cliPath: string, finalArgs: string[], stdinPrompt: string }}
 */
// D4.1: Delegated to execution/command-builders.js
function buildClaudeCliCommand(...args) { return _commandBuilders.buildClaudeCliCommand(...args); }
function buildCodexCommand(...args) { return _commandBuilders.buildCodexCommand(...args); }

// === startTask phase helpers — delegated to execution/task-startup.js ===
function recordTaskStartedAuditEvent(...args) { return _taskStartup.recordTaskStartedAuditEvent(...args); }

// Provider routing — delegated to execution/provider-router.js
function resolveProviderRouting(...args) { return _providerRouter.resolveProviderRouting(...args); }
function normalizeProviderOverride(...args) { return _providerRouter.normalizeProviderOverride(...args); }
function failTaskForInvalidProvider(...args) { return _providerRouter.failTaskForInvalidProvider(...args); }
function getProviderSlotLimits(...args) { return _providerRouter.getProviderSlotLimits(...args); }
function getEffectiveGlobalMaxConcurrent(...args) { return _providerRouter.getEffectiveGlobalMaxConcurrent(...args); }

// Delegated to execution/process-lifecycle.js (D4.3)
function spawnAndTrackProcess(taskId, task, config) {
  return _processLifecycle.spawnAndTrackProcess(taskId, task, config);
}

// startTask — delegated to execution/task-startup.js
function startTask(taskId) { return _taskStartup.startTask(taskId); }

const { cancelTask, triggerCancellationWebhook } = createCancellationHandler({
  db,
  runningProcesses,
  apiAbortControllers,
  pendingRetryTimeouts,
  stallRecoveryAttempts,
  logger,
  sanitizeTaskOutput,
  safeTriggerWebhook,
  killProcessGraceful,
  cleanupChildProcessListeners,
  cleanupProcessTracking,
  safeDecrementHostSlot,
  handleWorkflowTermination,
  processQueue,
});

/**
 * Process the queue - start next queued task if possible
 * Uses smart scheduling to find tasks that can run on available hosts
 * @returns {void}
 */
function processQueue() {
  const now = Date.now();
  if (_processQueuePending) {
    return;
  }

  if (processQueueLock || (_lastProcessQueueCall && (now - _lastProcessQueueCall) < PROCESS_QUEUE_DEBOUNCE_MS)) {
    _processQueuePending = true;
    if (_processQueueTimer) {
      clearTimeout(_processQueueTimer);
    }
    _processQueueTimer = setTimeout(() => {
      _processQueuePending = false;
      _processQueueTimer = null;
      processQueue();
    }, PROCESS_QUEUE_DEBOUNCE_MS);
    return;
  }

  _lastProcessQueueCall = now;

  // Don't start new tasks during shutdown
  if (isShuttingDown) {
    return;
  }
  // Prevent concurrent processQueue() calls within the same process
  // This avoids race conditions when multiple event handlers trigger simultaneously
  if (processQueueLock) {
    return;
  }
  processQueueLock = true;

  try {
    // Try to acquire distributed lock for cross-process coordination
    const lockResult = coordination.acquireLock(
      QUEUE_LOCK_NAME,
      QUEUE_LOCK_HOLDER_ID,
      QUEUE_LOCK_LEASE_SECONDS,
      `MCP server pid=${process.pid}`
    );

    if (!lockResult.acquired) {
      // P91: Log lock contention for diagnostics
      logger.debug(`processQueue: lock held by ${lockResult.holder || 'unknown'}, skipping (expires ${lockResult.expiresAt || 'unknown'})`);
      return;
    }

    try {
      processQueueInternal();
    } finally {
      // Release the distributed lock (guarded to prevent stalling queue on DB error)
      try {
        coordination.releaseLock(QUEUE_LOCK_NAME, QUEUE_LOCK_HOLDER_ID);
      } catch (lockErr) {
        logger.info(`[Queue] Failed to release lock: ${lockErr.message}`);
      }
    }
  } catch (err) {
    // Guard against DB-closed errors from lingering setTimeout callbacks
    if (err.message && err.message.includes('not open')) {
      return; // DB connection closed — silently ignore
    }
    logger.info(`[Queue] processQueue error: ${err.message}`);
  } finally {
    processQueueLock = false;
  }
}

// attemptTaskStart, safeStartTask — delegated to execution/task-startup.js
function attemptTaskStart(taskId, label) { return _taskStartup.attemptTaskStart(taskId, label); }
function safeStartTask(taskId, label) { return _taskStartup.safeStartTask(taskId, label); }


// estimateProgress — delegated to execution/task-startup.js
function estimateProgress(output, provider) { return _taskStartup.estimateProgress(output, provider); }

// Delegated to validation/completion-detection.js
const {
  detectSuccessFromOutput,
  detectOutputCompletion,
  COMPLETION_OUTPUT_THRESHOLDS,
  SHARED_COMPLETION_PATTERNS,
  PROVIDER_COMPLETION_PATTERNS,
} = completionDetection;

// getActualModifiedFiles — delegated to execution/task-startup.js
function getActualModifiedFiles(workingDir) { return _taskStartup.getActualModifiedFiles(workingDir); }

// getTaskProgress, getRunningTaskCount, hasRunningProcess — delegated to execution/task-startup.js
function getTaskProgress(taskId) { return _taskStartup.getTaskProgress(taskId); }
function getRunningTaskCount() { return _taskStartup.getRunningTaskCount(); }
function hasRunningProcess(taskId) { return _taskStartup.hasRunningProcess(taskId); }

const {
  isLargeModelBlockedOnHost,
  checkStalledTasks,
  tryStallRecovery
} = createStallDetectionHandler({
  db,
  runningProcesses,
  stallRecoveryAttempts,
  safeConfigInt,
  parseModelSizeB,
  logger,
  activityMonitoring,
  orphanCleanupModule: _orphanCleanup,
  fallbackRetryModule: _fallbackRetryModule,
});

/**
 * Stop a running task for restart (doesn't mark as cancelled)
 * @param {string} taskId - Task ID
 * @param {string} reason - Reason for stopping
 */
function stopTaskForRestart(taskId, reason) {
  const proc = runningProcesses.get(taskId);
  if (!proc) return;

  logger.info(`[StallRecovery] Stopping task ${taskId} for restart: ${reason}`);

  killProcessGraceful(proc, taskId, 3000, 'StallRecovery');
  cleanupChildProcessListeners(proc.process);
  cleanupProcessTracking(proc, taskId, runningProcesses, stallRecoveryAttempts);
}

/**
 * Shutdown - optionally cancel running tasks and pending retries
 * @param {Object} options - Shutdown options
 * @param {boolean} options.cancelTasks - Whether to cancel running tasks (default: true)
 *   Set to false for connection-loss scenarios where tasks should continue in background
 * @returns {void}
 */
function shutdown(options = {}) {
  const { cancelTasks = true } = options;
  isShuttingDown = true;

  // Clear all pending retry timeouts first
  for (const [taskId, timeoutHandle] of pendingRetryTimeouts.entries()) {
    clearTimeout(timeoutHandle);
    logger.info(`Cancelled pending retry for task ${taskId} (shutdown)`);
  }
  pendingRetryTimeouts.clear();

  // Clear cleanup guard to release memory
  taskCleanupGuard.clear();

  // Only cancel running tasks if explicitly requested
  // When MCP connection drops (stdin-close), tasks should continue running
  if (cancelTasks) {
    for (const taskId of runningProcesses.keys()) {
      cancelTask(taskId, 'Server shutdown', { cancel_reason: 'server_restart' });
    }
  } else {
    const runningCount = runningProcesses.size;
    if (runningCount > 0) {
      logger.info(`MCP connection lost - ${runningCount} task(s) will continue running in background`);
    }
  }

  // Explicitly clear all background intervals/timeouts for clean shutdown
  _orphanCleanup.stopTimers();
  clearInterval(_queuePollInterval);
  _queuePollInterval = null;
  // Stop health check and activity poll intervals (managed by host-monitoring)
  hostMonitoring.stopTimers();
  stopInstanceHeartbeat();
  // healthCheckStartup now managed by hostMonitoring.stopTimers()
  // Stop event-dispatch retention-policy timers (initial 30s prune + 24h interval)
  try { require('./hooks/event-dispatch').stopRetentionPolicy(); } catch { /* non-fatal */ }
}

// Initialize debug lifecycle with DI deps (after startTask and estimateProgress are defined)
debugLifecycle.init({
  runningProcesses,
  startTaskFn: (...args) => startTask(...args),
  estimateProgressFn: (...args) => estimateProgress(...args),
});

// ─── Debug Lifecycle Facades ──────────────────────────────────────────────────
// Thin wrappers delegating to ./execution/debug-lifecycle.js (Step 5 extraction)
function pauseTask(taskId, reason = null) { return debugLifecycle.pauseTask(taskId, reason); }
function resumeTask(taskId) { return debugLifecycle.resumeTask(taskId); }
function checkBreakpoints(taskId, text, type = 'output') { return debugLifecycle.checkBreakpoints(taskId, text, type); }
function pauseTaskForDebug(taskId, breakpoint) { return debugLifecycle.pauseTaskForDebug(taskId, breakpoint); }
function stepExecution(taskId, stepMode = 'continue', count = 1) { return debugLifecycle.stepExecution(taskId, stepMode, count); }

// Initialize host monitoring with dependencies and start timers
hostMonitoring.init({
  db,
  dashboard,
  cleanupOrphanedHostTasks,
  queueLockHolderId: QUEUE_LOCK_HOLDER_ID
});
hostMonitoring.startTimers();

activityMonitoring.init({
  runningProcesses,
  getStallThreshold: (...args) => _orphanCleanup.getStallThreshold(...args),
  safeConfigInt,
  getSkipGitInCloseHandler: () => skipGitInCloseHandler,
});

// Periodic queue processor — started explicitly by index.js:init() via startQueuePoll().
// Previously ran at require()-time; now runs only when called.
let _queuePollInterval = null;

function startQueuePoll() {
  if (_queuePollInterval) return; // idempotent
  _queuePollInterval = setInterval(() => {
    if (!db.isReady || !db.isReady()) return; // Skip until database is initialized
    try {
      processQueue();
    } catch (err) {
      logger.error(`QueuePoll error`, { error: err.message });
    }
  }, 30000); // Every 30 seconds
  // unref so this timer doesn't prevent process exit in test workers.
  // The server stays alive via HTTP listeners, not this interval.
  _queuePollInterval.unref();
}

// ============================================================
// Initialize extracted modules with dependency injection
// Called explicitly from index.js:init() via initSubModules().
// Previously ran at require()-time; now runs only when called.
// ============================================================

let _subModulesInitialized = false;

function initSubModules() {
  if (_subModulesInitialized) return;
  _subModulesInitialized = true;

_taskExecutionHooks.init({ db });

_planProjectResolver.init({ db, dashboard });

_fileContextBuilder.init({
  db,
  serverConfig,
  providerCfg,
  contextEnrichment,
  computeLineHash,
});

_providerRouter.init({
  db,
  serverConfig,
  providerRegistry,
  parseTaskMetadata,
  safeUpdateTaskStatus,
});

_taskStartup.init({
  db,
  dashboard,
  serverConfig,
  providerRegistry,
  providerCfg,
  gpuMetrics,
  runningProcesses,
  apiAbortControllers,
  pendingRetryTimeouts,
  stallRecoveryAttempts,
  taskCleanupGuard,
  parseTaskMetadata,
  getTaskContextTokenEstimate,
  safeUpdateTaskStatus,
  resolveProviderRouting,
  normalizeProviderOverride,
  failTaskForInvalidProvider,
  getProviderSlotLimits,
  getEffectiveGlobalMaxConcurrent,
  spawnAndTrackProcess,
  buildClaudeCliCommand,
  buildCodexCommand,
  buildFileContext,
  resolveFileReferences,
  executeOllamaTask,
  executeApiProvider,
  evaluateTaskPreExecutePolicy,
  getPolicyBlockReason,
  cancelTask,
  processQueue,
  sanitizeTaskOutput,
  detectOutputCompletion,
  shellEscape,
  QUEUE_LOCK_HOLDER_ID,
});

_executionModule.init({
  db, dashboard, runningProcesses, apiAbortControllers,
  safeUpdateTaskStatus,
  recordTaskStartedAuditEvent,
  tryReserveHostSlotWithFallback,
  markTaskCleanedUp,
  tryOllamaCloudFallback: _fallbackRetryModule.tryOllamaCloudFallback,
  tryLocalFirstFallback: _fallbackRetryModule.tryLocalFirstFallback,
  shellEscape,
  processQueue,
  handleWorkflowTermination,
  isLargeModelBlockedOnHost,
  buildFileContext,
  helpers: {
    wrapWithInstructions,
    detectTaskTypes,
    extractTargetFilesFromDescription,
    ensureTargetFilesExist,
    isLargeModelBlockedOnHost,
    resolveWindowsCmdToNode,
    estimateProgress,
    detectOutputCompletion,
    checkBreakpoints,
    pauseTaskForDebug,
    pauseTask,
    classifyError,
    sanitizeTaskOutput,
    startTask,
    getActualModifiedFiles,
    runLLMSafeguards,
    scopedRollback,
    checkFileQuality,
    runBuildVerification,
    runTestVerification,
    runStyleCheck,
    isValidFilePath,
    isShellSafe,
    tryCreateAutoPR,
    handlePlanProjectTaskCompletion,
    handlePlanProjectTaskFailure,
    handlePipelineStepCompletion,
    runOutputSafeguards,
    cancelTask,
  },
  finalizeTask,
  stallRecoveryAttempts,
});

_postTaskModule.init({
  db,
  getModifiedFiles,
  parseGitStatusLine,
  sanitizeLLMOutput,
});

tsserverClient.init({ db, logger });

_fallbackRetryModule.init({
  db,
  dashboard,
  processQueue,
  cancelTask,
  stopTaskForRestart,
  markTaskCleanedUp,
  stallRecoveryAttempts,
  runningProcesses,
});

_workflowRuntimeModule.init({
  db,
  startTask,
  cancelTask,
  processQueue,
  dashboard,
});
registerTaskStatusTransitionListener();

_outputSafeguards.init({
  db,
  getFileChangesForValidation,
  checkFileQuality,
  findPlaceholderArtifacts,
  cleanupJunkFiles,
});

_orphanCleanup.init({
  db,
  dashboard,
  logger,
  runningProcesses,
  stallRecoveryAttempts,
  TASK_TIMEOUTS,
  cancelTask,
  processQueue,
  tryLocalFirstFallback,
  getTaskActivity,
  tryStallRecovery,
  safeConfigInt,
  detectOutputCompletion,
  COMPLETION_OUTPUT_THRESHOLDS,
  SHARED_COMPLETION_PATTERNS,
  PROVIDER_COMPLETION_PATTERNS,
});
_orphanCleanup.startTimers();

_instanceManager.init({
  db,
  logger,
  instanceId: QUEUE_LOCK_HOLDER_ID,
});

// Phase 7-10 module initialization
_promptsModule.init({ db });
codexIntelligence.init({ db, prompts: _promptsModule });
_commandBuilders.init({
  wrapWithInstructions,
  providerCfg,
  contextEnrichment,
  codexIntelligence,
  db,
  nvmNodePath: NVM_NODE_PATH,
});
_closePhases.init({
  db,
  dashboard,
  checkFileQuality,
  scopedRollback,
  runBuildVerification,
  rollbackTaskChanges,
  runTestVerification,
  runStyleCheck,
  tryCreateAutoPR,
  extractModifiedFiles,
  isValidFilePath,
  isShellSafe,
  sanitizeTaskOutput,
  safeUpdateTaskStatus,
  tryLocalFirstFallback,
  processQueue,
});
_retryFramework.init({
  db,
  classifyError,
  sanitizeTaskOutput,
  taskCleanupGuard,
  pendingRetryTimeouts,
  startTask,
  processQueue,
});
_safeguardGates.init({
  db,
  getActualModifiedFiles,
  runLLMSafeguards,
  scopedRollback,
  safeUpdateTaskStatus,
  taskCleanupGuard,
  dashboard,
  processQueue,
});
_autoVerifyRetry.init({
  db,
  startTask: safeStartTask,
  processQueue,
});
_completionPipeline.init({
  db,
  parseTaskMetadata,
  handleWorkflowTermination,
  handleProjectDependencyResolution,
  handlePipelineStepCompletion,
  runOutputSafeguards,
});
_taskFinalizer.init({
  db,
  safeUpdateTaskStatus,
  sanitizeTaskOutput,
  extractModifiedFiles,
  handleRetryLogic,
  handleSafeguardChecks,
  handleFuzzyRepair,
  handleNoFileChangeDetection,
  handleSandboxRevertDetection,
  handleAutoValidation,
  handleBuildTestStyleCommit,
  handleAutoVerifyRetry: _autoVerifyRetry.handleAutoVerifyRetry,
  handleProviderFailover,
  handlePostCompletion,
});
_queueScheduler.init({
  db,
  attemptTaskStart,
  safeStartTask,
  safeConfigInt,
  isLargeModelBlockedOnHost,
  getProviderInstance: (name) => providerRegistry.getProviderInstance(name),
  getFreeQuotaTracker,
  cleanupOrphanedRetryTimeouts,
  analyzeTaskForRouting: providerRoutingCore.analyzeTaskForRouting,
  notifyDashboard: (taskId, updates = {}) => {
    if (!taskId) return;
    const payload = updates && typeof updates === 'object' ? updates : {};
    eventBus.emitTaskUpdated({ taskId, ...payload });
  },
});
// Register queue-scheduler cleanup on DB close (prevents timer leaks in tests)
if (typeof db.onClose === 'function') {
  db.onClose(() => _queueScheduler.stop());
}
// RB-035: Resolve any tasks stuck in codex-pending dead state on startup
try { _queueScheduler.resolveCodexPendingTasks(); } catch { /* ignore */ }
_processStreams.init({
  db,
  dashboard,
  runningProcesses,
  stallRecoveryAttempts,
  estimateProgress,
  detectOutputCompletion,
  checkBreakpoints,
  pauseTaskForDebug,
  pauseTask,
  extractModifiedFiles,
  safeUpdateTaskStatus,
  safeDecrementHostSlot,
  killProcessGraceful,
  MAX_OUTPUT_BUFFER,
});

_processLifecycle.init({
  dashboard,
  runningProcesses,
  finalizeTask,
  cancelTask,
  processQueue,
  markTaskCleanedUp,
  safeUpdateTaskStatus,
  setupStdoutHandler: _processStreams.setupStdoutHandler,
  setupStderrHandler: _processStreams.setupStderrHandler,
  closeHandlerState: {
    get count() { return pendingCloseHandlers; },
    set count(v) { pendingCloseHandlers = v; },
    drain: drainCloseHandlerResolvers,
  },
});
} // end initSubModules

// Use Object.assign to preserve the original module.exports reference.
// dashboard/routes/tasks.js → tools.js → handlers → task-manager creates a
// circular dependency chain.  Modules that require('./task-manager') during
// that cycle receive the *original* exports object; replacing it with a new
// object via `module.exports = {...}` leaves those references pointing at
// an empty object.  Object.assign populates the existing reference in-place.
Object.assign(module.exports, {
  startTask,
  cancelTask,
  processQueue,
  getTaskProgress,
  getRunningTaskCount,
  getTaskActivity,
  getAllTaskActivity,
  getStallThreshold,
  checkStalledTasks,
  tryStallRecovery,
  cleanupOrphanedHostTasks,
  canAcceptTask,
  shutdown,
  pauseTask,
  resumeTask,
  checkBreakpoints,
  pauseTaskForDebug,
  stepExecution,
  // Workflow functions
  evaluateWorkflowDependencies,
  unblockTask,
  applyFailureAction,
  cancelDependentTasks,
  checkWorkflowCompletion,
  // Safeguard functions
  cleanupJunkFiles,
  runLLMSafeguards,
  checkFileQuality,
  checkDuplicateFiles,
  checkSyntax,
  // Instruction template functions
  DEFAULT_INSTRUCTION_TEMPLATES,
  getInstructionTemplate,
  wrapWithInstructions,
  // Fix F3: Per-provider timeout defaults
  PROVIDER_DEFAULT_TIMEOUTS,
  // Fix F5: Expose for startup orphan cleanup
  hasRunningProcess,
  // Pre-execution file resolution
  buildFileIndex,
  resolveFileReferences,
  buildFileContext,
  extractFileReferencesExpanded,
  extractJsFunctionBoundaries,
  // GPU/model activity monitoring
  getHostActivity,
  isModelLoadedOnHost,
  pollHostActivity,
  probeLocalGpuMetrics,
  probeRemoteGpuMetrics,
  // Multi-session instance management
  getMcpInstanceId,
  registerInstance,
  unregisterInstance,
  isInstanceAlive,
  startInstanceHeartbeat,
  stopInstanceHeartbeat,
  updateInstanceInfo,
  // Free-tier quota tracking
  getFreeQuotaTracker,
  buildPolicyTaskData,
  evaluateTaskSubmissionPolicy,
  evaluateTaskPreExecutePolicy,
  fireTaskCompletionPolicyHook,
  // Harness improvement internals (exported for testing)
  computeLineHash,
  detectTaskTypes,
  lineSimilarity,
  // Local-first fallback chain (exported for testing)
  tryLocalFirstFallback,
  tryOllamaCloudFallback,
  // Model-size / VRAM helpers (exported for testing)
  parseModelSizeB,
  isSmallModel,
  isThinkingModel,
  getModelSizeCategory,
  isLargeModelBlockedOnHost,
  // Queue processing helpers (exported for testing)
  attemptTaskStart,
  safeStartTask,
  categorizeQueuedTasks,
  // Cancellation helpers (exported for testing)
  triggerCancellationWebhook,
  // Provider command builders (exported for testing)
  buildClaudeCliCommand,
  buildCodexCommand,
  // Close-handler helpers (exported for testing)
  revertScopedFiles,
  scopedRollback,
  handleCloseCleanup,
  handleRetryLogic,
  handleSafeguardChecks,
  handleFuzzyRepair,
  handleNoFileChangeDetection,
  handleSandboxRevertDetection,
  handleAutoValidation,
  handleBuildTestStyleCommit,
  handleProviderFailover,
  handlePostCompletion,
  handleProjectDependencyResolution,
  detectOutputCompletion,
  detectSuccessFromOutput,
  CONVERSATIONAL_REFUSAL_PATTERN,
  recordModelOutcome,
  recordProviderHealth,
  // Internal state (exported for testing only)
  _testing: {
    get runningProcesses() { return runningProcesses; },
    get apiAbortControllers() { return apiAbortControllers; },
    get stallRecoveryAttempts() { return stallRecoveryAttempts; },
    get pendingRetryTimeouts() { return pendingRetryTimeouts; },
    get taskCleanupGuard() { return taskCleanupGuard; },
    get queuePollInterval() { return _queuePollInterval; },
    resetForTest() {
      if (_processQueueTimer) {
        clearTimeout(_processQueueTimer);
        _processQueueTimer = null;
      }
      if (_queuePollInterval) {
        clearInterval(_queuePollInterval);
        _queuePollInterval = null;
      }
      providerRegistry.resetInstances();
      _processQueuePending = false;
      _lastProcessQueueCall = 0;
      runningProcesses.resetAll();
      pendingCloseHandlers = 0;
      closeHandlerResolvers = [];
      isShuttingDown = false;
      skipGitInCloseHandler = false;
      _taskStartup.setSkipGitInCloseHandler(false);
    },
    waitForPendingHandlers,
    set skipGitInCloseHandler(v) { skipGitInCloseHandler = v; _taskStartup.setSkipGitInCloseHandler(v); },
    get skipGitInCloseHandler() { return skipGitInCloseHandler; },
  },
  // Explicit initialization functions (previously module-level side effects)
  initEarlyDeps,
  initSubModules,
  startQueuePoll,
  // DI factory (Phase 3) — deps reserved for Phase 5 when database.js facade is removed
  createTaskManager,
});

function createTaskManager(_deps) {
  return {
    startTask,
    cancelTask,
    processQueue,
    getTaskProgress,
    getRunningTaskCount,
    getTaskActivity,
    getAllTaskActivity,
    getStallThreshold,
    checkStalledTasks,
    tryStallRecovery,
    cleanupOrphanedHostTasks,
    canAcceptTask,
    shutdown,
    pauseTask,
    resumeTask,
    checkBreakpoints,
    pauseTaskForDebug,
    stepExecution,
    evaluateWorkflowDependencies,
    unblockTask,
    applyFailureAction,
    cancelDependentTasks,
    checkWorkflowCompletion,
    cleanupJunkFiles,
    runLLMSafeguards,
    checkFileQuality,
    checkDuplicateFiles,
    checkSyntax,
    DEFAULT_INSTRUCTION_TEMPLATES,
    getInstructionTemplate,
    wrapWithInstructions,
    PROVIDER_DEFAULT_TIMEOUTS,
    hasRunningProcess,
    buildFileIndex,
    resolveFileReferences,
    buildFileContext,
    extractFileReferencesExpanded,
    extractJsFunctionBoundaries,
    getHostActivity,
    isModelLoadedOnHost,
    pollHostActivity,
    probeLocalGpuMetrics,
    probeRemoteGpuMetrics,
    getMcpInstanceId,
    registerInstance,
    unregisterInstance,
    isInstanceAlive,
    startInstanceHeartbeat,
    stopInstanceHeartbeat,
    updateInstanceInfo,
    getFreeQuotaTracker,
    buildPolicyTaskData,
    evaluateTaskSubmissionPolicy,
    evaluateTaskPreExecutePolicy,
    fireTaskCompletionPolicyHook,
    computeLineHash,
    detectTaskTypes,
    lineSimilarity,
    tryLocalFirstFallback,
    tryOllamaCloudFallback,
    parseModelSizeB,
    isSmallModel,
    isThinkingModel,
    getModelSizeCategory,
    isLargeModelBlockedOnHost,
    attemptTaskStart,
    safeStartTask,
    categorizeQueuedTasks,
    triggerCancellationWebhook,
    buildClaudeCliCommand,
    buildCodexCommand,
    revertScopedFiles,
    scopedRollback,
    handleCloseCleanup,
    handleRetryLogic,
    handleSafeguardChecks,
    handleFuzzyRepair,
    handleNoFileChangeDetection,
    handleSandboxRevertDetection,
    handleAutoValidation,
    handleBuildTestStyleCommit,
    handleProviderFailover,
    handlePostCompletion,
    handleProjectDependencyResolution,
    detectOutputCompletion,
    detectSuccessFromOutput,
    CONVERSATIONAL_REFUSAL_PATTERN,
    recordModelOutcome,
    recordProviderHealth,
    initEarlyDeps,
    initSubModules,
    startQueuePoll,
  };
}

// Backward compatibility: auto-init early deps if db is already ready when this module loads.
// This handles test files that require('./task-manager') after db.init() without calling initEarlyDeps().
try { initEarlyDeps(); } catch { /* db not ready yet — index.js will call explicitly */ }
