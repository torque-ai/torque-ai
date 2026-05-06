/**
 * Task Manager for TORQUE
 * Handles spawning, tracking, and managing Codex CLI processes
 *
 * Note: Uses spawn() (not exec()) for security - no shell injection possible
 */

// spawn moved to execution/process-lifecycle.js (D4.3)
const crypto = require('crypto');
const { getModule: getContainerModule } = require('./container');
const taskCore = require('./db/task-core');
const coordination = require('./db/coordination');
const providerRoutingCore = require('./db/provider/routing-core');
const _sleepWatchdog = require('./maintenance/sleep-watchdog');
const { getDashboardBroadcaster } = require('./tasks/dashboard-bridge');
const logger = require('./logger').child({ component: 'task-manager' });
const providerRegistry = require('./providers/registry');
const providerCfg = require('./providers/config');
const serverConfig = require('./config');
const gpuMetrics = require('./scripts/gpu-metrics-server');
const eventBus = require('./event-bus');

function getDbDependency() {
  return getContainerModule('db') || null;
}

function requireDbDependency() {
  const database = getDbDependency();
  if (!database) {
    throw new Error('task-manager database dependency is not initialized');
  }
  return database;
}

const db = new Proxy({}, {
  get(_target, prop) {
    if (prop === '__isTaskManagerDbProxy') return true;
    if (prop === 'toJSON') return () => '[task-manager db dependency]';

    const database = getDbDependency();
    if (!database) return undefined;

    const value = database[prop];
    return typeof value === 'function' ? value.bind(database) : value;
  },
  set(_target, prop, value) {
    requireDbDependency()[prop] = value;
    return true;
  },
  has(_target, prop) {
    const database = getDbDependency();
    return Boolean(database && prop in database);
  },
});

// ── Early dependency initialization ───────────────────────────────────────
// Called explicitly from index.js:init() before provider usage.
// Also auto-called on first use if db is available (backward compat for tests).
let _earlyDepsInitialized = false;

function initEarlyDeps() {
  if (_earlyDepsInitialized) return;
  // Guard: don't init if db isn't ready yet
  if (!db || !db.isReady || !db.isReady()) return;
  _earlyDepsInitialized = true;

  providerRegistry.init({ db });
  providerCfg.init({ db });
  serverConfig.init({ db });
  // Register the 11 built-in provider classes (codex, claude-*, anthropic,
  // groq, hyperbolic, deepinfra, ollama-cloud, cerebras, google-ai, openrouter).
  const { registerBuiltinProviders } = require('./providers/builtin-providers');
  registerBuiltinProviders(providerRegistry);
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
const _instanceManager = require('./maintenance/instance-manager');

// Phase 7-10 extracted modules
const _promptsModule = require('./providers/prompts');
const _closePhases = require('./validation/close-phases');
const _autoVerifyRetry = require('./validation/auto-verify-retry');
const completionDetection = require('./validation/completion-detection');
const _sandboxRevertDetection = require('./execution/sandbox-revert-detection');
const _taskUtils = require('./execution/task-utils');
// execution/process-lifecycle.js: production accesses methods through
// defaultContainer.get('processLifecycle'). The factory self-bootstraps deps
// (taskManager methods + process-streams handlers + container singletons).
function safeDecrementHostSlot(...args) { return defaultContainer.get('processLifecycle').safeDecrementHostSlot(...args); }
function killProcessGraceful(...args) { return defaultContainer.get('processLifecycle').killProcessGraceful(...args); }
function safeTriggerWebhook(...args) { return defaultContainer.get('processLifecycle').safeTriggerWebhook(...args); }
function cleanupProcessTracking(...args) { return defaultContainer.get('processLifecycle').cleanupProcessTracking(...args); }
function cleanupChildProcessListeners(...args) { return defaultContainer.get('processLifecycle').cleanupChildProcessListeners(...args); }
const debugLifecycle = require('./execution/debug-lifecycle');
const ProcessTracker = require('./execution/process-tracker');
const codexIntelligence = require('./providers/codex-intelligence');

// Sub-module function imports — these used to flow through task-manager-delegations.js
// (Phase D3 extraction), but the indirection added no value: every entry was a pure
// pass-through. Now bound directly to the underlying modules.
const { computeLineHash, lineSimilarity } = require('./handlers/hashline-handlers');
const {
  isShellSafe, extractTargetFilesFromDescription,
  buildFileIndex, extractFileReferencesExpanded, resolveFileReferences,
  isValidFilePath, extractModifiedFiles,
} = _fileResolution;
const {
  isModelLoadedOnHost, getHostActivity, pollHostActivity,
  probeLocalGpuMetrics, probeRemoteGpuMetrics,
} = hostMonitoring;
const { getTaskActivity, getAllTaskActivity, canAcceptTask } = activityMonitoring;
const {
  registerInstance, startInstanceHeartbeat, stopInstanceHeartbeat,
  unregisterInstance, updateInstanceInfo, isInstanceAlive, getMcpInstanceId,
} = _instanceManager;
const {
  cleanupJunkFiles, getFileChangesForValidation, findPlaceholderArtifacts,
  checkFileQuality, checkDuplicateFiles, checkSyntax, runLLMSafeguards,
  runBuildVerification, runTestVerification, runStyleCheck,
  rollbackTaskChanges, revertScopedFiles, scopedRollback,
} = _postTaskModule;
const { detectTaskTypes, getInstructionTemplate, wrapWithInstructions } = _promptsModule;
const { executeApiProvider, executeOllamaTask } = _executionModule;
const {
  tryOllamaCloudFallback, tryLocalFirstFallback, classifyError,
} = _fallbackRetryModule;
const {
  handlePipelineStepCompletion, handleWorkflowTermination,
  evaluateWorkflowDependencies, unblockTask, applyFailureAction,
  cancelDependentTasks, checkWorkflowCompletion,
} = _workflowRuntimeModule;
const { runOutputSafeguards } = _outputSafeguards;
// detectSandboxReverts was historically aliased to handleSandboxRevertDetection;
// the alias is preserved here to avoid touching every call site.
const { detectSandboxReverts: handleSandboxRevertDetection } = _sandboxRevertDetection;
const {
  handleAutoValidation, handleBuildTestStyleCommit, handleProviderFailover,
} = _closePhases;
// execution/completion-pipeline.js: production accesses methods via the
// container. Factory self-bootstraps utility deps (parseTaskMetadata ←
// task-utils; runOutputSafeguards ← output-safeguards) and handler
// functions (handleWorkflowTermination ← workflowRuntime;
// handleProjectDependencyResolution ← planProjectResolver).
function recordModelOutcome(...args) { return defaultContainer.get('completionPipeline').recordModelOutcome(...args); }
function recordProviderHealth(...args) { return defaultContainer.get('completionPipeline').recordProviderHealth(...args); }
function handlePostCompletion(...args) { return defaultContainer.get('completionPipeline').handlePostCompletion(...args); }
// execution/task-finalizer.js: production accesses methods via the container.
// Factory self-bootstraps stage handlers via require() (handleSafeguardChecks,
// handleAutoValidation, etc.) and binds taskManager methods.
function finalizeTask(...args) { return defaultContainer.get('taskFinalizer').finalizeTask(...args); }
// execution/queue-scheduler.js: factory self-bootstraps deps (taskManager
// methods, eventBus, providerRegistry, safeConfigInt, analyzeTaskForRouting,
// cleanupOrphanedRetryTimeouts, getFreeQuotaTracker).
function categorizeQueuedTasks(...args) { return defaultContainer.get('queueScheduler').categorizeQueuedTasks(...args); }
function processQueueInternal(...args) { return defaultContainer.get('queueScheduler').processQueueInternal(...args); }
const { cleanupOrphanedHostTasks, getStallThreshold } = _orphanCleanup;

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


// Free-tier provider quota tracker — singleton lives in tasks/free-quota-tracker-singleton.js.
// Lazy-resolves db via defaultContainer.peek('db') in ensureDb() inside getFreeQuotaTracker.
const _freeQuotaSingleton = require('./tasks/free-quota-tracker-singleton');
const { getFreeQuotaTracker } = _freeQuotaSingleton;

if (executeApi.setFreeQuotaTracker) executeApi.setFreeQuotaTracker(getFreeQuotaTracker);

// Provider getters removed — queue-scheduler uses providerRegistry.getProviderInstance() directly

// Track running processes by task ID. The instance is owned by the DI
// container (server/container.js registerValue('processTracker', ...)) so
// every consumer reaches the same registry via the container instead of
// receiving it through init({runningProcesses}) distribution. peek()
// works pre-boot for registered values, which matches task-manager's
// module-load timing.
const { defaultContainer } = require('./container');
const runningProcesses = defaultContainer.peek('processTracker');
// Duck-type check: instanceof ProcessTracker fails under vitest module
// isolation when the test's ProcessTracker class identity differs from
// task-manager's. ProcessTracker is a Map subclass with markCleanedUp;
// checking against the global Map (identity-stable across module
// boundaries) plus the domain-specific method is robust to test mocks
// while still catching real registration bugs.
if (!(runningProcesses instanceof Map) || typeof runningProcesses.markCleanedUp !== 'function') {
  throw new Error('container missing processTracker registration — server/container.js must registerValue it before task-manager.js loads');
}

// All process-tracking Maps are now consolidated inside ProcessTracker:
//   runningProcesses (the Map itself)     — process records
//   runningProcesses.abortControllers     — API task abort controllers
//   runningProcesses.retryTimeouts        — pending retry timeout handles
//   runningProcesses.stallAttempts        — stall recovery state
//   runningProcesses.cleanupGuard         — double-cleanup prevention with TTL
// Internal uses access these as accessors on the tracker directly;
// the four shadow aliases the file used to maintain (apiAbortControllers,
// pendingRetryTimeouts, stallRecoveryAttempts, taskCleanupGuard) have
// been inlined now that consumer modules pull from the container default
// instead of being threaded the maps via init({…}).

const PROCESS_QUEUE_DEBOUNCE_MS = 15;
let _processQueueTimer = null;
let _processQueuePending = false;
let _lastProcessQueueCall = 0;

// Pending close-handler bookkeeping (counter + drain + waitForPendingHandlers)
// lives in tasks/close-handler-state.js. The lifecycle module mutates the
// counter through the accessor passed via DI in initSubModules.
const _closeHandlerState = require('./tasks/close-handler-state');
const {
  drainCloseHandlerResolvers,
  waitForPendingHandlers,
} = _closeHandlerState;

// Tasks currently in the finalization pipeline (close handler running).
// The orphan checker must skip active finalizers — the process has exited but
// the close handler (which includes auto-verify) is still running async.
// Values carry a heartbeat so a leaked or wedged finalizer marker can be
// recovered instead of leaving a DB row stuck as running forever.
//
// Owned by the DI container (server/container.js registerValue
// 'finalizationTracker') so process-lifecycle.js and orphan-cleanup.js
// reach the same instance via the container. Extends Map, so the
// existing .set/.get/.has/.delete consumer contract is unchanged;
// .start/.touch/.idleMs/.getMarker are the preferred new entry points.
const FinalizationTracker = require('./execution/finalization-tracker');
const finalizingTasks = defaultContainer.peek('finalizationTracker');
// Duck-type check (same rationale as processTracker above): FinalizationTracker
// extends Map and exposes .start/.touch/.idleMs/.getMarker. Check Map +
// one branded method to stay robust to vitest module isolation.
if (!(finalizingTasks instanceof Map) || typeof finalizingTasks.start !== 'function') {
  throw new Error('container missing finalizationTracker registration — server/container.js must registerValue it before task-manager.js loads');
}

// Test mode flag: when true, getActualModifiedFiles() returns null immediately,
// preventing git process spawning in close handlers during E2E tests with mock processes.
let skipGitInCloseHandler = false;

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
function tryReserveHostSlotWithFallback(...args) { return defaultContainer.get('providerRouter').tryReserveHostSlotWithFallback(...args); }

// Retry cleanup delegated to execution/task-startup.js

// ============================================================
// LLM Output Safeguards
// ============================================================

/**
 * Extract function boundaries from a JS/TS file.
 * Delegated to execution/file-context-builder.js
 */
function extractJsFunctionBoundaries(...args) { return defaultContainer.get('fileContextBuilder').extractJsFunctionBoundaries(...args); }

/**
 * Ensure target files exist on disk (create stubs if needed).
 * Delegated to execution/file-context-builder.js
 */
function ensureTargetFilesExist(...args) { return defaultContainer.get('fileContextBuilder').ensureTargetFilesExist(...args); }


// ============================================================
// Pre-Execution File Resolution (delegated to utils/file-resolution.js)
// ============================================================

/**
 * Build formatted file context block from resolved files.
 * Delegated to execution/file-context-builder.js
 */
function buildFileContext(...args) { return defaultContainer.get('fileContextBuilder').buildFileContext(...args); }


// Delegated to providers/prompts.js (Phase 7A)
const DEFAULT_INSTRUCTION_TEMPLATES = _promptsModule.DEFAULT_INSTRUCTION_TEMPLATES;

// Dead code removed (Round 44): detectTaskComplexity() and selectModelForTaskComplexity()
// were superseded by the database facade determineTaskComplexity() + getModelTierForComplexity()
// which are used by the smart submit flow in integration-handlers.js.

// isSmallModel, isThinkingModel imported from ./utils/model.js

/**
 * Try to create an automatic PR after successful task completion.
 * Delegated to execution/provider-router.js
 */
function tryCreateAutoPR(...args) { return defaultContainer.get('providerRouter').tryCreateAutoPR(...args); }

// cleanupOrphanedRetryTimeouts delegated to execution/task-startup.js
function cleanupOrphanedRetryTimeouts() { return defaultContainer.get('taskStartup').cleanupOrphanedRetryTimeouts(); }

// MAX_OUTPUT_BUFFER, NVM_NODE_PATH are static constants — pull from the raw
// module export at module-load time (the container isn't booted yet).
// resolveWindowsCmdToNode is a pure utility — same pattern.
const _taskStartupConsts = require('./execution/task-startup');
const MAX_OUTPUT_BUFFER = _taskStartupConsts.MAX_OUTPUT_BUFFER;
const NVM_NODE_PATH = _taskStartupConsts.NVM_NODE_PATH;
function resolveWindowsCmdToNode(...args) { return _taskStartupConsts.resolveWindowsCmdToNode(...args); }

// PROVIDER_DEFAULT_TIMEOUTS imported from ./constants.js

/**
 * Safely parse config integer value with bounds checking.
 * Delegated to execution/provider-router.js
 */
function safeConfigInt(...args) { return defaultContainer.get('providerRouter').safeConfigInt(...args); }

/**
 * Resolve plan project dependencies after a task reaches a terminal state.
 * This keeps plan project counters and downstream task statuses in sync even
 * when tasks are completed or failed outside the main close handler.
 * @param {string} taskId - Task identifier.
 * @param {string} newStatus - New task status.
 * @returns {void}
 */
// Plan project dependency resolution — delegated to execution/plan-project-resolver.js
function handleProjectDependencyResolution(...args) { return defaultContainer.get('planProjectResolver').handleProjectDependencyResolution(...args); }
function handlePlanProjectTaskCompletion(...args) { return defaultContainer.get('planProjectResolver').handlePlanProjectTaskCompletion(...args); }
function handlePlanProjectTaskFailure(...args) { return defaultContainer.get('planProjectResolver').handlePlanProjectTaskFailure(...args); }

// ═══════════════════════════════════════════════════════════════════════════
// Close-handler helpers (extracted from startTask's child.on('close', ...))
// Each reads/writes a shared `ctx` object instead of deeply nested closures.
// ═══════════════════════════════════════════════════════════════════════════

// Phase 0: Race guard + cleanup — delegated to execution/process-lifecycle.js
function handleCloseCleanup(taskId, code) {
  return defaultContainer.get('processLifecycle').handleCloseCleanup(taskId, code);
}

// Phase 1: Retry logic — resolved from the DI container.
function handleRetryLogic(ctx) {
  return defaultContainer.get('retryFramework').handleRetryLogic(ctx);
}

// Phase 2: Safeguard checks — resolved from the DI container.
function handleSafeguardChecks(ctx) {
  try {
    return defaultContainer.get('safeguardGates').handleSafeguardChecks(ctx);
  } catch (err) {
    if (!/called before boot|not registered/i.test(String(err?.message || err))) {
      throw err;
    }
    return require('./validation/safeguard-gates').handleSafeguardChecks(ctx);
  }
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
function buildClaudeCliCommand(...args) { return defaultContainer.get('commandBuilders').buildClaudeCliCommand(...args); }
function buildCodexCommand(...args) { return defaultContainer.get('commandBuilders').buildCodexCommand(...args); }

// === startTask phase helpers — delegated to execution/task-startup.js ===
function recordTaskStartedAuditEvent(...args) { return defaultContainer.get('taskStartup').recordTaskStartedAuditEvent(...args); }
function createTaskStartupResourceLifecycle(...args) { return defaultContainer.get('taskStartup').createTaskStartupResourceLifecycle(...args); }
function evaluateClaimedStartupPolicy(...args) { return defaultContainer.get('taskStartup').evaluateClaimedStartupPolicy(...args); }
function buildProviderStartupCommand(...args) { return defaultContainer.get('taskStartup').buildProviderStartupCommand(...args); }

// Provider routing — delegated to execution/provider-router.js
function resolveProviderRouting(...args) { return defaultContainer.get('providerRouter').resolveProviderRouting(...args); }
function normalizeProviderOverride(...args) { return defaultContainer.get('providerRouter').normalizeProviderOverride(...args); }
function failTaskForInvalidProvider(...args) { return defaultContainer.get('providerRouter').failTaskForInvalidProvider(...args); }
function getProviderSlotLimits(...args) { return defaultContainer.get('providerRouter').getProviderSlotLimits(...args); }
function getEffectiveGlobalMaxConcurrent(...args) { return defaultContainer.get('providerRouter').getEffectiveGlobalMaxConcurrent(...args); }

// Delegated to execution/process-lifecycle.js (D4.3)
function spawnAndTrackProcess(taskId, task, config) {
  return defaultContainer.get('processLifecycle').spawnAndTrackProcess(taskId, task, config);
}

// startTask — delegated to execution/task-startup.js
function startTask(taskId) { return defaultContainer.get('taskStartup').startTask(taskId); }

// ── taskCanceller capability: single registration, single instance ──
//
// Construct the cancellation handler once and register it as the
// canonical `taskCanceller` container value, overriding the deferred
// factory entry registered by execution/register.js. This eliminates
// the dual-handler concern from the taskCanceller pilot: the inline
// construction here and the factory registration there used to produce
// two independently-built handlers that happened to share state via
// processTracker. After this change, every consumer — task-manager's
// own export, workflow-runtime, fallback-retry, process-lifecycle, and
// any future caller of defaultContainer.get('taskCanceller') — sees the
// same instance.
//
// The execution/register.js factory still exists as a fallback for
// isolated tests that boot the container without loading task-manager;
// the override path runs whenever task-manager.js is in the require
// graph (production + most integration tests).
const _cancellationHandler = createCancellationHandler({
  db,
  // runningProcesses / apiAbortControllers / pendingRetryTimeouts /
  // stallRecoveryAttempts default to container's processTracker —
  // task-cancellation peeks it on construct unless overridden.
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
const { cancelTask, triggerCancellationWebhook } = _cancellationHandler;
defaultContainer.registerValue('taskCanceller', _cancellationHandler);

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
function attemptTaskStart(taskId, label) { return defaultContainer.get('taskStartup').attemptTaskStart(taskId, label); }
function safeStartTask(taskId, label) { return defaultContainer.get('taskStartup').safeStartTask(taskId, label); }


// estimateProgress — delegated to execution/task-startup.js
function estimateProgress(output, provider) { return defaultContainer.get('taskStartup').estimateProgress(output, provider); }

// Delegated to validation/completion-detection.js
const {
  detectSuccessFromOutput,
  detectOutputCompletion,
  COMPLETION_OUTPUT_THRESHOLDS,
  SHARED_COMPLETION_PATTERNS,
  PROVIDER_COMPLETION_PATTERNS,
} = completionDetection;

// getActualModifiedFiles — delegated to execution/task-startup.js
function getActualModifiedFiles(workingDir) { return defaultContainer.get('taskStartup').getActualModifiedFiles(workingDir); }

// getTaskProgress, getRunningTaskCount, hasRunningProcess — delegated to execution/task-startup.js
function getTaskProgress(taskId) { return defaultContainer.get('taskStartup').getTaskProgress(taskId); }
function getRunningTaskCount() { return defaultContainer.get('taskStartup').getRunningTaskCount(); }
function hasRunningProcess(taskId) { return defaultContainer.get('taskStartup').hasRunningProcess(taskId); }

const {
  isLargeModelBlockedOnHost,
  checkStalledTasks,
  tryStallRecovery
} = createStallDetectionHandler({
  db,
  // runningProcesses + stallRecoveryAttempts were silently dropped at
  // the destructure of createStallDetectionHandler — neither is used
  // there. Removed to make the actual surface explicit.
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
  cleanupProcessTracking(proc, taskId, runningProcesses, runningProcesses.stallAttempts);
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
  for (const [taskId, timeoutHandle] of runningProcesses.retryTimeouts.entries()) {
    clearTimeout(timeoutHandle);
    logger.info(`Cancelled pending retry for task ${taskId} (shutdown)`);
  }
  runningProcesses.retryTimeouts.clear();

  // Clear cleanup guard to release memory
  runningProcesses.cleanupGuard.clear();

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
  try { _sleepWatchdog.stop(); } catch { /* non-fatal */ }
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
  dashboard: getDashboardBroadcaster(),
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

// policy-engine/task-execution-hooks.js: db lazy-resolves via container peek
// in ensureDb() inside buildPolicyTaskData. No imperative init() needed.

// execution/plan-project-resolver.js: db + dashboard come from the container
// at boot via createPlanProjectResolver. Production resolves via
// defaultContainer.get('planProjectResolver').

// execution/file-context-builder.js: utility deps (providerCfg,
// contextEnrichment, computeLineHash) resolve at module load via require();
// db + serverConfig lazy-resolve through defaultContainer.peek() in
// ensureContainerDeps(). Production resolves the service via
// defaultContainer.get('fileContextBuilder').

// execution/provider-router.js: utility deps (parseTaskMetadata) resolve at
// module load via require(); db / serverConfig / providerRegistry /
// safeUpdateTaskStatus lazy-resolve through the container in ensureDeps().
// Production resolves the service via defaultContainer.get('providerRouter').

// execution/task-startup.js: 28 deps resolve inside createTaskStartup —
// utility functions via require() from canonical modules; runningProcesses +
// pendingRetryTimeouts via processTracker peek; cancelTask / processQueue /
// safeUpdateTaskStatus via taskManager binding (cancelTask preferring the
// registered taskCanceller capability). Production resolves the service via
// defaultContainer.get('taskStartup').

// providers/execution.js + sub-modules (execute-api, execute-ollama, execute-cli):
// agentic deps and per-sub-module deps lazy-resolve at first call. db / dashboard /
// processTracker maps come from the container; safeUpdateTaskStatus / processQueue /
// isLargeModelBlockedOnHost / recordTaskStartedAuditEvent / markTaskCleanedUp /
// helpers tree bind through the registered taskManager value;
// tryReserveHostSlotWithFallback ← providerRouter; finalizeTask ← taskFinalizer;
// buildFileContext ← fileContextBuilder; tryOllamaCloudFallback /
// tryLocalFirstFallback ← fallback-retry (via thunks, paired with the routing-core
// load-order fix in 0ab8f244); handleWorkflowTermination ← workflowRuntime;
// getFreeQuotaTracker ← free-quota-tracker-singleton; shellEscape + NVM_NODE_PATH
// resolve at module load via require(). No imperative init() needed.

// validation/post-task.js: utility deps (getModifiedFiles, parseGitStatusLine,
// sanitizeLLMOutput) resolve at module load via require(); db lazy-resolves
// through defaultContainer.peek('db'). No imperative init() needed.

tsserverClient.init({ db, logger });

// execution/fallback-retry.js: raw exports (tryOllamaCloudFallback,
// tryLocalFirstFallback, tryStallRecovery, tryHashlineTieredFallback) lazy-
// resolve deps via ensureDeps() at call time — db/dashboard from the
// container; processQueue/cancelTask/stopTaskForRestart/markTaskCleanedUp
// from the registered taskManager value (cancelTask preferring the
// taskCanceller capability); processTracker maps from the singleton;
// getFreeQuotaTracker via require(). The container service self-bootstraps
// the same deps for callers that go through defaultContainer.get('fallbackRetry').

// execution/workflow-runtime.js: db / dashboard / startTask / cancelTask /
// processQueue all lazy-resolve through the container in ensureDeps().
// Production resolves the service via defaultContainer.get('workflowRuntime').
try {
  const workflowResume = require('./execution/workflow-resume');
  workflowResume.init({
    db,
    eventBus,
    logger: typeof logger.child === 'function' ? logger.child({ component: 'workflow-resume' }) : logger,
  });
  const result = workflowResume.resumeAllRunningWorkflows();
  if (result.tasks_unblocked > 0) {
    logger.info(`[startup] Resumed ${result.workflows_evaluated} workflow(s), unblocked ${result.tasks_unblocked} task(s)`);
  }
} catch (err) {
  logger.info(`[startup] Workflow resume failed: ${err.message}`);
}
registerTaskStatusTransitionListener();

// validation/output-safeguards.js: utility deps (getFileChangesForValidation,
// checkFileQuality, findPlaceholderArtifacts, cleanupJunkFiles) resolve at
// module load via require() from validation/post-task; db lazy-resolves
// through defaultContainer.peek('db'). No imperative init() needed.

// maintenance/orphan-cleanup.js: every dep lazy-resolves via ensureDeps() —
// db/dashboard/logger/processTracker maps from the container; cancelTask,
// processQueue, getTaskActivity, isInstanceAlive, getMcpInstanceId,
// tryStallRecovery from the registered taskManager value (cancelTask
// preferring the taskCanceller capability); tryLocalFirstFallback ←
// fallback-retry; detectOutputCompletion ← validation/completion-detection;
// reportRuntimeTaskProblem ← factory/runtime-problem-intake;
// TASK_TIMEOUTS ← constants. No imperative init() needed.
_orphanCleanup.startTimers();

// Sleep watchdog — detects system sleep/wake and shields tasks from false timeouts
_sleepWatchdog.start({ db, runningProcesses, logger });

// maintenance/instance-manager.js: db, logger, and QUEUE_LOCK_HOLDER_ID
// (via taskManager.queueLockHolderId) lazy-resolve through the container in
// ensureDeps(). No imperative init() needed.

// providers/prompts.js: serverConfig is initialized by index.js; the legacy
// _db slot in prompts is unused in production code paths.
codexIntelligence.init({ db, prompts: _promptsModule });
// execution/command-builders.js: utility deps (wrapWithInstructions,
// providerCfg, contextEnrichment, codexIntelligence) resolve at module load
// via require() from canonical sources; nvmNodePath comes from
// task-startup at module load. Production resolves the service via
// defaultContainer.get('commandBuilders').
// validation/close-phases.js: utility deps (checkFileQuality, scopedRollback,
// runBuildVerification, runTestVerification, runStyleCheck, tryCreateAutoPR,
// extractModifiedFiles, isValidFilePath, isShellSafe, sanitizeTaskOutput,
// tryLocalFirstFallback) resolve at module load via require() from their
// canonical sources; db, dashboard, and taskManager-bound methods
// (safeUpdateTaskStatus, processQueue) lazy-resolve through the container.

// execution/retry-framework.js: classifyError + sanitizeTaskOutput resolve
// at module load via require() (from fallback-retry / task-utils);
// taskCleanupGuard + pendingRetryTimeouts come from processTracker;
// startTask + processQueue bind from the registered taskManager handle.
// Production no longer calls retryFramework.init().
// safeguardGates: now resolved via defaultContainer.get('safeguardGates').
// register() declares [db, dashboard, taskManager]; the factory resolves
// utility deps (runLLMSafeguards, scopedRollback) via require() from
// validation/post-task and binds taskManager methods (getActualModifiedFiles,
// safeUpdateTaskStatus, processQueue) from the registered taskManager handle.
// validation/auto-verify-retry.js: db / startTask / processQueue / sandboxManager /
// testRunnerRegistry all lazy-resolve through the container at first call.
// execution/completion-pipeline.js: db comes from the container at boot;
// parseTaskMetadata + runOutputSafeguards via require() inside the factory;
// handleWorkflowTermination + handleProjectDependencyResolution +
// handlePipelineStepCompletion resolved from the workflowRuntime and
// planProjectResolver container services. No imperative init() needed.
// execution/task-finalizer.js: stage handlers (handleRetryLogic,
// handleSafeguardChecks, handleFuzzyRepair, handleNoFileChangeDetection,
// handleSandboxRevertDetection, handleAutoValidation, handleBuildTestStyleCommit,
// handleAutoVerifyRetry, handleProviderFailover, handlePostCompletion) all
// resolve via require() inside createTaskFinalizer; safeUpdateTaskStatus +
// sanitizeTaskOutput bind from the taskManager value. No imperative init().
// execution/queue-scheduler.js: factory self-resolves all deps —
// attemptTaskStart, safeStartTask, isLargeModelBlockedOnHost via taskManager
// binding; safeConfigInt ← provider-router; cleanupOrphanedRetryTimeouts ←
// task-startup; analyzeTaskForRouting ← db/smart-routing; getProviderInstance
// ← providers/registry; getFreeQuotaTracker ← fallback-retry; notifyDashboard
// from the registered eventBus value. No imperative init() needed.
// Register queue-scheduler cleanup on DB close (prevents timer leaks in tests)
if (typeof db.onClose === 'function') {
  db.onClose(() => defaultContainer.get('queueScheduler').stop());
}
// RB-035: Resolve any tasks stuck in codex-pending dead state on startup
try { defaultContainer.get('queueScheduler').resolveCodexPendingTasks(); } catch { /* ignore */ }
// execution/process-streams.js: raw setupStdoutHandler/setupStderrHandler
// exports lazy-resolve their deps via ensureDeps() at call time. The
// container service createProcessStreams self-bootstraps the same deps for
// callers that go through defaultContainer.get('processStreams').

// execution/process-lifecycle.js: dashboard / finalizeTask / cancelTask /
// processQueue / markTaskCleanedUp / safeUpdateTaskStatus / setupStdoutHandler /
// setupStderrHandler all resolve inside createProcessLifecycle via container
// peek + taskManager binding + require()s. Production resolves the service
// via defaultContainer.get('processLifecycle').

// Boot the container so DI-resolved subsystem services (taskStartup,
// commandBuilders, providerRouter, retryFramework, etc.) are reachable via
// defaultContainer.get(...) from this module's wrappers. Production paths
// boot via index.js → bootContainer(); this is the secondary boot for test
// fixtures and any caller that drives initSubModules without going through
// index.js. failFast:false keeps boot tolerant of missing optional deps.
try {
  // Register taskManager's own module.exports as the container value before
  // boot — services that declare a 'taskManager' dep need it present at
  // boot. In production index.js does this; in tests that drive only
  // initSubModules we register it here.
  if (!defaultContainer.has('taskManager')) {
    defaultContainer.registerValue('taskManager', module.exports);
  }
  // Same for serverConfig + dashboard + testRunnerRegistry + sandboxManager
  // + providerRegistry + gpuMetrics + sharedFactoryStore — services that
  // depend on these need stubs at boot for the test path. Production paths
  // register the real values.
  if (!defaultContainer.has('eventBus')) {
    defaultContainer.registerValue('eventBus', eventBus);
  }
  if (!defaultContainer.has('logger')) {
    defaultContainer.registerValue('logger', logger);
  }
  if (!defaultContainer.has('serverConfig')) {
    defaultContainer.registerValue('serverConfig', serverConfig);
  }
  if (!defaultContainer.has('dashboard')) {
    defaultContainer.registerValue('dashboard', { broadcast: () => {}, notifyTaskUpdated: () => {} });
  }
  if (!defaultContainer.has('testRunnerRegistry')) {
    defaultContainer.registerValue('testRunnerRegistry', { resolve: () => null, getRunner: () => null });
  }
  if (!defaultContainer.has('sandboxManager')) {
    defaultContainer.registerValue('sandboxManager', { isAvailable: () => false });
  }
  if (!defaultContainer.has('providerRegistry')) {
    defaultContainer.registerValue('providerRegistry', { getProviderInstance: () => null });
  }
  if (!defaultContainer.has('gpuMetrics')) {
    defaultContainer.registerValue('gpuMetrics', { probe: () => ({}) });
  }
  if (!defaultContainer.has('sharedFactoryStore')) {
    defaultContainer.registerValue('sharedFactoryStore', { get: () => null, set: () => {} });
  }
  defaultContainer.boot({ failFast: false });
} catch (err) { logger.warn(`[task-manager] container boot in initSubModules failed: ${err.message}`); }
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
  stopTaskForRestart,
  markTaskCleanedUp,
  processQueue,
  // stopTaskForRestart was MIA from the export block prior to 2026-05-06 even
  // though fallback-retry.js's ensureDeps() resolves it via
  // tm.stopTaskForRestart. Without the export, tm[name] === undefined and
  // _stopTaskForRestart stayed null in fallback-retry. The first periodic
  // checkStalledTasks tick after every server start (5min interval) hit
  // _stopTaskForRestart(taskId, ...) — TypeError → uncaughtException →
  // gracefulShutdown. With the auto-restart fix landed earlier on 2026-05-06,
  // the system loop-crashed every 5min indefinitely until this export.
  stopTaskForRestart,
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
  QUEUE_LOCK_HOLDER_ID,
  queueLockHolderId: QUEUE_LOCK_HOLDER_ID,
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
  // Capability methods consumed by registered services that bind through
  // the taskManager handle (safeguardGates, closePhases, etc.).
  safeUpdateTaskStatus,
  getActualModifiedFiles,
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
  createTaskStartupResourceLifecycle,
  evaluateClaimedStartupPolicy,
  buildProviderStartupCommand,
  // Internal state (exported for testing only)
  _testing: {
    get runningProcesses() { return runningProcesses; },
    get apiAbortControllers() { return runningProcesses.abortControllers; },
    get stallRecoveryAttempts() { return runningProcesses.stallAttempts; },
    get pendingRetryTimeouts() { return runningProcesses.retryTimeouts; },
    get taskCleanupGuard() { return runningProcesses.cleanupGuard; },
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
      _closeHandlerState._resetForTest();
      isShuttingDown = false;
      skipGitInCloseHandler = false;
      defaultContainer.get('taskStartup').setSkipGitInCloseHandler(false);
    },
    waitForPendingHandlers,
    getDashboardBroadcaster,
    set skipGitInCloseHandler(v) { skipGitInCloseHandler = v; defaultContainer.get('taskStartup').setSkipGitInCloseHandler(v); },
    get skipGitInCloseHandler() { return skipGitInCloseHandler; },
  },
  // Explicit initialization functions (previously module-level side effects)
  initEarlyDeps,
  initSubModules,
  startQueuePoll,
});

// Backward compatibility: auto-init early deps if db is already ready when this module loads.
// This handles test files that require('./task-manager') after db.init() without calling initEarlyDeps().
try { initEarlyDeps(); } catch { /* db not ready yet — index.js will call explicitly */ }
