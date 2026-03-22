/**
 * Task Manager for TORQUE
 * Handles spawning, tracking, and managing Codex CLI processes
 *
 * Note: Uses spawn() (not exec()) for security - no shell injection possible
 */

// spawn moved to execution/process-lifecycle.js (D4.3)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./database');
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
const _hashlineParser = require('./utils/hashline-parser');
const _fileResolution = require('./utils/file-resolution');
const hostMonitoring = require('./utils/host-monitoring');
const contextEnrichment = require('./utils/context-enrichment');
const tsserverClient = require('./utils/tsserver-client');
const activityMonitoring = require('./utils/activity-monitoring');
const taskHooks = require('./policy-engine/task-hooks');
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
const _hashlineVerify = require('./validation/hashline-verify');
const _aiderCommand = require('./providers/aider-command');
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
const codexIntelligence = require('./providers/codex-intelligence');

// Phase D3: All pure pass-through delegation stubs extracted to task-manager-delegations.js
const {
  computeLineHash, lineSimilarity,
  parseHashlineLiteEdits, findSearchMatch, applyHashlineLiteEdits,
  parseHashlineEdits, applyHashlineEdits,
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
  executeHashlineOllamaTask,
  tryOllamaCloudFallback, tryLocalFirstFallback, classifyError,
  findNextHashlineModel, tryHashlineTieredFallback, selectHashlineFormat,
  handlePipelineStepCompletion, handleWorkflowTermination,
  evaluateWorkflowDependencies, unblockTask, applyFailureAction,
  cancelDependentTasks, checkWorkflowCompletion,
  runOutputSafeguards,
  handleSandboxRevertDetection,
  handleAutoValidation, handleBuildTestStyleCommit, handleProviderFailover,
  recordModelOutcome, recordProviderHealth,
  handlePostCompletion,
  finalizeTask,
  buildAiderCommand, configureAiderHost,
  categorizeQueuedTasks, processQueueInternal,
  verifyHashlineReferences, attemptFuzzySearchRepair,
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
      const updatedTask = db.getTask(taskId);
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

// Aider output sanitization — delegated to execution/task-utils.js
function sanitizeAiderOutput(...args) { return _taskUtils.sanitizeAiderOutput(...args); }

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
    return db.updateTaskStatus(taskId, status, { ...fields, _softFail: true });
  } catch (err) {
    // Even with softFail, some errors may still occur (db corruption, etc.)
    if (err.message.includes('Cannot transition')) {
      logger.info(`[SafeUpdate] State conflict for ${taskId}: ${err.message.slice(0, 80)}`);
      try {
        return db.getTask(taskId);
      } catch {
        return null;
      }
    }
    // Log but don't crash for other errors
    logger.info(`[SafeUpdate] Error updating ${taskId}: ${err.message}`);
    return null;
  }
}

const { execFileSync } = require('child_process');

/**
 * Atomically try to reserve a host slot with proper race handling.
 * Delegated to execution/provider-router.js
 */
function tryReserveHostSlotWithFallback(...args) { return _providerRouter.tryReserveHostSlotWithFallback(...args); }

// Track last cleanup time to avoid excessive cleanup overhead
let lastRetryCleanupTime = 0;
const RETRY_CLEANUP_INTERVAL_MS = 30000; // Cleanup at most once per 30s (reduced from 60s for faster leak recovery)

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

/**
 * Parse aider output to detect real edits vs conversational text.
 * Delegated to execution/file-context-builder.js
 */
function parseAiderOutput(...args) { return _fileContextBuilder.parseAiderOutput(...args); }

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

/**
 * Clean up orphaned retry timeouts - entries for tasks that are no longer pending
 * This prevents memory leaks from edge cases where cleanup was missed
 */
function cleanupOrphanedRetryTimeouts() {
  const now = Date.now();

  // Don't cleanup too frequently
  if (now - lastRetryCleanupTime < RETRY_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastRetryCleanupTime = now;

  let cleaned = 0;
  for (const [taskId, timeoutHandle] of pendingRetryTimeouts.entries()) {
    const task = db.getTask(taskId);
    // Clean up if task doesn't exist or is no longer in a retryable state
    if (!task || !['pending', 'queued'].includes(task.status)) {
      clearTimeout(timeoutHandle);
      pendingRetryTimeouts.delete(taskId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} orphaned retry timeouts`);
  }
}

// Maximum output buffer size (10MB) to prevent memory exhaustion
const MAX_OUTPUT_BUFFER = 10 * 1024 * 1024;

// PROVIDER_DEFAULT_TIMEOUTS imported from ./constants.js

/**
 * Safely parse config integer value with bounds checking.
 * Delegated to execution/provider-router.js
 */
function safeConfigInt(...args) { return _providerRouter.safeConfigInt(...args); }

/**
 * Detect NVM node path dynamically
 * Falls back to using 'codex' from PATH if NVM not available
 */
function getNvmNodePath() {
  // Check for explicit override via environment
  if (process.env.CODEX_NODE_PATH) {
    return process.env.CODEX_NODE_PATH;
  }

  // Check for NVM_BIN (set by nvm when shell is initialized)
  if (process.env.NVM_BIN) {
    return process.env.NVM_BIN;
  }

  // Try to construct from NVM_DIR
  if (process.env.NVM_DIR) {
    const nodeVersion = process.version.slice(1); // Remove 'v' prefix
    const nvmPath = path.join(process.env.NVM_DIR, 'versions/node', `v${nodeVersion}`, 'bin');
    return nvmPath;
  }

  // Fallback: try common NVM locations
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const commonPaths = [
    path.join(homeDir, '.nvm/versions/node', process.version, 'bin'),
    path.join(homeDir, '.nvm/current/bin'),
    '/usr/local/bin',
    '/usr/bin'
  ];

  for (const p of commonPaths) {
    try {
      fs.accessSync(path.join(p, 'node'));
      return p;
    } catch {
      // Path doesn't exist or not accessible
    }
  }

  // If nothing found, return null and we'll try codex from PATH
  return null;
}

const NVM_NODE_PATH = getNvmNodePath();

/**
 * Resolve a Windows .cmd npm wrapper to its underlying node + script path.
 * npm-installed CLIs on Windows use .cmd wrappers that run via cmd.exe.
 * When we need to pipe stdin to the underlying node process, cmd.exe
 * intercepts/consumes the stdin data before the node process gets it.
 * This function parses the .cmd file to find the actual node script,
 * allowing us to spawn node directly and bypass cmd.exe entirely.
 *
 * @param {string} cmdPath - Path to the .cmd file (e.g. 'codex.cmd')
 * @returns {{ nodePath: string, scriptPath: string } | null}
 */
function resolveWindowsCmdToNode(cmdPath) {
  try {
    // Resolve the full path if it's just a filename
    let fullCmdPath = cmdPath;
    if (!path.isAbsolute(cmdPath)) {
      // Search PATH for the .cmd file using execFileSync (no shell injection)
      try {
        fullCmdPath = execFileSync('where.exe', [cmdPath], { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0].trim();
      } catch {
        return null; // Not found in PATH
      }
    }

    const cmdContent = fs.readFileSync(fullCmdPath, 'utf-8');
    const cmdDir = path.dirname(fullCmdPath);

    // npm .cmd wrappers have a line like:
    //   "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
    // Extract the script path from between the second set of quotes
    const match = cmdContent.match(/"%_prog%"\s+"?%dp0%\\([^"]+)"?\s+%\*/);
    if (!match) return null;

    const relativeScriptPath = match[1].replace(/\\/g, '/');
    const scriptPath = path.resolve(cmdDir, relativeScriptPath);

    if (!fs.existsSync(scriptPath)) return null;

    // Determine node path: check if node.exe exists alongside the .cmd
    const localNode = path.join(cmdDir, 'node.exe');
    const nodePath = fs.existsSync(localNode) ? localNode : 'node';

    return { nodePath, scriptPath };
  } catch {
    return null; // Any error: fall back to cmd.exe wrapping
  }
}

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
 * Phase 3: Fuzzy SEARCH/REPLACE repair for aider failures.
 * Mutates ctx.status and ctx.code on successful repair.
 */
function handleFuzzyRepair(ctx) {
  const { taskId, proc, task } = ctx;
  const fuzzyRepairEnabled = serverConfig.getBool('fuzzy_search_repair_enabled');
  if (!fuzzyRepairEnabled || !task || task.provider !== 'aider-ollama') return;

  const taskOutput = proc?.output || '';
  const hasSearchFailure = /Can't edit|FAILED to apply|SearchReplaceNoExactMatch/i.test(taskOutput);
  if (!hasSearchFailure || !task.working_directory) return;

  try {
    const repairResult = attemptFuzzySearchRepair(taskId, taskOutput, task.working_directory);
    if (repairResult.repaired) {
      logger.info(`[FuzzyRepair] Task ${taskId}: successfully repaired SEARCH block in ${repairResult.file} — upgrading to completed`);
      if (ctx.status === 'failed' || ctx.code !== 0) {
        ctx.status = 'completed';
        ctx.code = 0;
      }
    } else if (repairResult.similarity > 0) {
      logger.info(`[FuzzyRepair] Task ${taskId}: best match similarity ${(repairResult.similarity * 100).toFixed(1)}% — below 80% threshold, falling through to retry`);
    }
  } catch (e) {
    logger.info(`[FuzzyRepair] Task ${taskId}: repair attempt error: ${e.message}`);
  }
}

/**
 * Phase 4: Detect no-file-change aider tasks, trigger local fallback.
 * Sets ctx.earlyExit = true if fallback is triggered.
 */
const CONVERSATIONAL_REFUSAL_PATTERN = /\b(I'm ready to|share the files|provide more information|which files you want)\b/i;

function handleNoFileChangeDetection(ctx) {
  const { taskId, proc, task } = ctx;
  if (ctx.status !== 'completed' || !proc || !task || task.provider !== 'aider-ollama') return;

  const workingDir = task.working_directory || process.cwd();
  const actuallyModified = getActualModifiedFiles(workingDir);
  const noFilesChanged = !actuallyModified || actuallyModified.length === 0;
  const taskDesc = task.task_description || '';
  const codeGenVerbs = /\b(implement|build|create|wire|add|write|generate|make)\b/i;
  const hasRefusal = CONVERSATIONAL_REFUSAL_PATTERN.test(proc?.output || '');

  if (!(noFilesChanged && (codeGenVerbs.test(taskDesc) || hasRefusal))) return;

  const reason = hasRefusal ? 'conversational refusal detected' : 'code-gen verb matched but no files produced';
  logger.info(`[No-File-Change] Task ${taskId} completed with no file changes (${reason}) — marking failed`);
  ctx.status = 'failed';
  ctx.errorOutput = (ctx.errorOutput || '') +
    `\n\n[NO FILES MODIFIED] Task expected code changes but aider produced only conversational output (${reason}).`;

  const retryCount = (task.retry_count ?? 0);
  const maxRetries = (task.max_retries ?? 2);
  const taskMeta = parseTaskMetadata(task.metadata);
  if (retryCount < maxRetries && !taskMeta.user_provider_override) {
    logger.info(`[No-File-Change] Auto-retrying task ${taskId} via local-first fallback (attempt ${retryCount + 1}/${maxRetries})`);
    taskCleanupGuard.delete(taskId);
    tryLocalFirstFallback(taskId, task, `[NO FILES MODIFIED] ${reason}`);
    ctx.earlyExit = true;
  } else if (retryCount < maxRetries) {
    logger.info(`[No-File-Change] Task ${taskId} has user_provider_override — skipping local-first fallback, retrying on same provider`);
  }
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

// === startTask phase helpers ===

/**
 * Validate task working directory and description before claiming a slot.
 * Throws on invalid state; logs warnings for missing API keys.
 */
function runPreflightChecks(task) {
  if (task.working_directory) {
    try {
      const stats = fs.statSync(task.working_directory);
      if (!stats.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${task.working_directory}`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Working directory does not exist: ${task.working_directory}`);
      }
      throw err;
    }
  }
  if (!task.task_description || task.task_description.trim().length === 0) {
    throw new Error('Task description cannot be empty');
  }
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    logger.info(`Warning: Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set - Codex may fail`);
  }
}

/**
 * Run rate-limit, duplicate, and budget checks before execution.
 * @returns {Object|null} Early-exit result if rate-limited (queued), or null to continue.
 */
function runSafeguardPreChecks(task, taskId, providerOverride = null) {
  const provider = providerOverride || task.provider || db.getDefaultProvider() || 'codex';
  const rateLimitEnabled = serverConfig.getBool('rate_limit_enabled');
  if (rateLimitEnabled) {
    const rateCheck = db.checkRateLimit(provider, taskId);
    if (!rateCheck.allowed) {
      db.updateTaskStatus(taskId, 'queued');
      logger.info(`[Safeguard] Rate limit exceeded for ${provider}, task ${taskId} queued. Wait ${rateCheck.retryAfter}s`);
      return { queued: true, rateLimited: true, retryAfter: rateCheck.retryAfter, task: db.getTask(taskId) };
    }
  }
  const duplicateCheckEnabled = serverConfig.getBool('duplicate_check_enabled');
  if (duplicateCheckEnabled) {
    const duplicateCheck = db.checkDuplicateTask(task.task_description, task.working_directory);
    if (duplicateCheck.isDuplicate) {
      logger.info(`[Safeguard] Duplicate task detected: ${taskId} matches ${duplicateCheck.existingTaskId}`);
    }
    db.recordTaskFingerprint(taskId, task.task_description, task.working_directory);
  }
  const budgetCheckEnabled = serverConfig.getBool('budget_check_enabled');
  if (budgetCheckEnabled) {
    const budgetCheck = db.isBudgetExceeded(provider);
    if (budgetCheck.exceeded) {
      throw new Error(`Budget exceeded for ${budgetCheck.budget}: $${budgetCheck.spent.toFixed(2)}/$${budgetCheck.limit.toFixed(2)}`);
    }
    if (budgetCheck.warning) {
      logger.info(`[Safeguard] Budget warning for ${budgetCheck.budget}: $${budgetCheck.spent.toFixed(2)}/$${budgetCheck.limit.toFixed(2)}`);
    }
  }
  return null;
}

function recordTaskStartedAuditEvent(task, taskId, provider) {
  const backupEnabled = serverConfig.getBool('backup_before_modify_enabled');
  if (!backupEnabled || !task.working_directory) {
    return;
  }

  const auditEnabled = serverConfig.getBool('audit_trail_enabled');
  if (!auditEnabled) {
    return;
  }

  db.recordAuditEvent('task_started', 'task', taskId, 'start', provider || 'system', null, {
    task_description: task.task_description,
    working_directory: task.working_directory,
    provider
  });
}

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

/**
 * Start a task - spawns a Codex process
 * @param {string} taskId - Task ID to start
 * @returns {{ queued: boolean, task?: Object, rateLimited?: boolean, retryAfter?: number }}
 */
function startTask(taskId) {
  let task = db.getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  task = { ...task };
  if (task.metadata && typeof task.metadata === 'object') {
    task.metadata = { ...task.metadata };
  }

  if (task.status === 'running') {
    logger.info(`Task already running: ${taskId}, skipping duplicate start`);
    return { queued: false, alreadyRunning: true };
  }

  const maxConcurrent = getEffectiveGlobalMaxConcurrent();
  // Resource pressure gating - block/warn based on system load
  const resourceGatingEnabled = serverConfig.get('resource_gating_enabled');
  if (resourceGatingEnabled === '1') {
    const pressureLevel = gpuMetrics.getPressureLevel();
    if (pressureLevel === 'critical') {
      throw new Error(`Cannot start task ${taskId}: critical resource pressure - CPU/RAM above 95%`);
    }
    if (pressureLevel === 'high') {
      logger.warn(`Starting task ${taskId} under high resource pressure - performance may be degraded`);
    }
  }
  let usedEditFormat = null;

  // === PRE-FLIGHT CHECKS ===
  runPreflightChecks(task);

  // === PROVIDER ROUTING ===
  // Resolve the final execution provider before provider-aware safeguards so
  // budget and rate-limit checks apply to the provider that will actually run.
  const routing = resolveProviderRouting(task, taskId);
  let provider = routing.provider;
  if (!providerRegistry.isKnownProvider(provider)) {
    const errorMessage = failTaskForInvalidProvider(taskId, provider);
    throw new Error(errorMessage);
  }
  // TDA-11: Persist movement narrative when routing changes the provider.
  // Provider is NOT set here — deferred assignment means tryClaimTaskSlot sets it atomically.
  // Only record the switch reason so the audit trail explains the routing decision.
  if (routing.switchReason) {
    const currentMeta = parseTaskMetadata(task.metadata);
    currentMeta._provider_switch_reason = routing.switchReason;
    currentMeta.intended_provider = provider;
    try {
      db.patchTaskMetadata(taskId, currentMeta);
    } catch (metaErr) {
      logger.debug(`[startTask] Failed to persist routing switch metadata for ${taskId}: ${metaErr.message}`);
    }
  }

  // === ROUTING CHAIN PROPAGATION ===
  // If a routing chain was stored at submission time (from template-based routing),
  // propagate model from the chain's primary entry to the task if not already set.
  {
    const routingMeta = parseTaskMetadata(task.metadata);
    if (routingMeta._routing_chain && Array.isArray(routingMeta._routing_chain) && routingMeta._routing_chain.length > 0) {
      // Find the chain entry matching the resolved provider, or use the first entry
      const matchingEntry = routingMeta._routing_chain.find(e => e.provider === provider) || routingMeta._routing_chain[0];
      if (matchingEntry && matchingEntry.model && !task.model) {
        task.model = matchingEntry.model;
        logger.debug(`[startTask] Propagated model '${matchingEntry.model}' from routing chain for task ${taskId}`);
      }
    }
  }

  // === EXTENDED SAFEGUARD PRE-CHECKS ===
  const safeguardResult = runSafeguardPreChecks(task, taskId, provider);
  if (safeguardResult) return safeguardResult;

  const taskMetadata = parseTaskMetadata(task.metadata);
  const taskType = db.classifyTaskType(task.task_description || '');
  const contextTokenEstimate = getTaskContextTokenEstimate(taskMetadata, task.context);
  const preExecutePolicyResult = evaluateTaskPreExecutePolicy({
    ...task,
    id: taskId,
    provider,
  });
  if (preExecutePolicyResult?.blocked === true) {
    const cancelReason = `[Policy] ${getPolicyBlockReason(preExecutePolicyResult, 'pre-execute')}`;
    try {
      cancelTask(taskId, cancelReason);
    } catch (cancelErr) {
      logger.info(`[Policy] Failed to cancel blocked task ${taskId}: ${cancelErr.message}`);
      safeUpdateTaskStatus(taskId, 'cancelled', { error_output: cancelReason });
    }
    try { dashboard.notifyTaskUpdated(taskId); } catch { /* non-critical */ }
    try { processQueue(); } catch (queueErr) { logger.info('Failed to process queue:', queueErr.message); }
    return {
      queued: false,
      blocked: true,
      cancelled: true,
      reason: cancelReason,
      task: db.getTask(taskId),
    };
  }

  // === ATOMIC SLOT CLAIM ===
  // Atomically check concurrency and claim the slot to prevent race conditions
  // Stamp with our instance ID so sibling sessions can identify task ownership
  let providerConfig = db.getProvider(provider);
  const {
    providerLimit,
    providerGroup,
    categoryLimit,
    categoryProviderGroup,
  } = getProviderSlotLimits(provider, providerConfig);
  const claimResult = db.tryClaimTaskSlot(
    taskId,
    maxConcurrent,
    QUEUE_LOCK_HOLDER_ID,
    provider,
    providerLimit,
    providerGroup,
    categoryLimit,
    categoryProviderGroup,
  );
  if (!claimResult.success) {
    if (claimResult.reason === 'at_capacity' || claimResult.reason === 'provider_at_capacity') {
      // Queue the task instead - concurrency limit reached
      db.updateTaskStatus(taskId, 'queued');
      return { queued: true, task: db.getTask(taskId) };
    }
    if (claimResult.reason === 'already_running') {
      return { queued: false, alreadyRunning: true };
    }
    if (claimResult.reason === 'not_found') {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (claimResult.reason === 'invalid_status') {
      throw new Error(`Task in invalid status for starting: ${claimResult.status}`);
    }
    throw new Error(`Failed to claim task slot: ${claimResult.reason}`);
  }
  if (claimResult.task) {
    Object.assign(task, claimResult.task);
    if (Object.prototype.hasOwnProperty.call(claimResult.task, 'metadata')) {
      task.metadata = parseTaskMetadata(claimResult.task.metadata);
    }
  }

  try {
  // === PROVIDER ROUTING ===
  // (resolved pre-claim so provider-aware cap enforcement is atomic)
  // === PROVIDER AVAILABILITY CHECK (post-routing) ===
  // Check the final routed provider is still enabled
  if (providerConfig && !providerConfig.enabled) {
    logger.info(`[startTask] Provider ${provider} is disabled, re-queuing task ${taskId}`);
    db.requeueTaskAfterAttemptedStart(taskId);
    return { queued: true, task: db.getTask(taskId) };
  }

  // Provider-specific caps are enforced during claim with `tryClaimTaskSlot`.

  // === PRE-EXECUTION FILE RESOLUTION ===
  let resolvedFileContext = '';
  let resolvedFilePaths = [];
  let resolvedFiles = [];

  if (task.working_directory) {
    try {
      const resolution = resolveFileReferences(task.task_description, task.working_directory);
      if (resolution.resolved.length > 0) {
        resolvedFilePaths = resolution.resolved.map(r => r.actual);
        resolvedFiles = resolution.resolved;
        // Build context for non-ollama, non-codex providers
        // Codex reads files itself — buildCodexCommand uses lightweight context + enrichment
        if (provider !== 'ollama' && provider !== 'codex') {
          resolvedFileContext = buildFileContext(resolution.resolved, task.working_directory, 30000, task.task_description);
        }
        logger.info(`[FileResolve] Pre-resolved ${resolution.resolved.length} file(s) for task ${taskId}`);


      }
    } catch (e) {
      logger.info(`[FileResolve] Non-fatal error for task ${taskId}: ${e.message}`);
    }
  }

  // === FILE LOCKING (EXP7: cross-session file overwrite protection) ===
  // Acquire locks for resolved files before execution starts.
  // Locks are released on task completion (output-safeguards.js).
  if (resolvedFilePaths.length > 0 && serverConfig.isOptIn('file_locking_enabled')) {
    const wd = task.working_directory || '';
    for (const filePath of resolvedFilePaths) {
      try {
        const lockResult = db.acquireFileLock(filePath, wd, taskId);
        if (!lockResult.acquired) {
          logger.warn(`[FileLock] Task ${taskId.slice(0,8)}: file '${filePath}' already locked by task ${lockResult.holder} (expires ${lockResult.expiresAt || 'never'}) — proceeding with warning`);
        }
      } catch (e) {
        logger.info(`[FileLock] Non-fatal lock error for ${filePath}: ${e.message}`);
      }
    }
  }

  // Build command arguments based on provider
  let cliPath;
  let finalArgs;
  let stdinPrompt;

  if (provider === 'ollama') {
    return executeOllamaTask(task);
  } else if (provider === 'hashline-ollama') {
    recordTaskStartedAuditEvent(task, taskId, provider);
    return executeHashlineOllamaTask(task);
  } else if (provider === 'aider-ollama') {
    const aiderResult = buildAiderCommand(task, resolvedFileContext, resolvedFilePaths);
    cliPath = aiderResult.cliPath;
    finalArgs = aiderResult.finalArgs;
    usedEditFormat = aiderResult.usedEditFormat;
  } else if (providerRegistry.isApiProvider(provider)) {
    // All cloud API providers use the same execution path via registry
    const instance = providerRegistry.getProviderInstance(provider);
    if (!instance) {
      const originalProvider = provider;
      const errorMessage = `Provider "${originalProvider}" has no registered instance`;
      if (taskMetadata.user_provider_override) {
        logger.error(`[startTask] ${errorMessage}`);
        failTaskForInvalidProvider(taskId, originalProvider, errorMessage);
        throw new Error(errorMessage);
      }

      const providerSwitchedAt = new Date().toISOString();
      logger.warn(`[startTask] No provider instance for "${originalProvider}" — falling back to codex for task ${taskId}`);

      // Verify codex is enabled before falling back
      const codexConfig = db.getProvider('codex');
      if (!codexConfig?.enabled) {
        logger.error(`[startTask] Codex provider is not enabled — cannot fall back from "${originalProvider}" for task ${taskId}`);
        failTaskForInvalidProvider(taskId, originalProvider, `${errorMessage} and codex fallback is disabled`);
        throw new Error(`${errorMessage} and codex fallback is disabled`);
      }

      // Claim a slot for codex to respect concurrency limits
      const codexSlotLimits = getProviderSlotLimits('codex', codexConfig);
      const codexClaim = db.tryClaimTaskSlot(
        taskId,
        maxConcurrent,
        QUEUE_LOCK_HOLDER_ID,
        'codex',
        codexSlotLimits.providerLimit,
        codexSlotLimits.providerGroup,
        codexSlotLimits.categoryLimit,
        codexSlotLimits.categoryProviderGroup,
      );
      if (!codexClaim.success) {
        logger.warn(`[startTask] Codex at capacity — re-queuing task ${taskId} (was falling back from "${originalProvider}")`);
        // Release the original provider's slot by clearing provider + resetting start fields.
        // The original tryClaimTaskSlot set status='running' and provider=originalProvider;
        // without this, the original provider's concurrency counter stays inflated until the
        // task eventually completes or is cancelled (slot leak).
        db.requeueTaskAfterAttemptedStart(taskId, { provider: null });
        return { queued: true, task: db.getTask(taskId) };
      }

      const updatedTask = db.updateTaskStatus(taskId, 'running', {
        provider: 'codex',
        model: null,
        provider_switched_at: providerSwitchedAt,
        _provider_switch_reason: `${originalProvider} -> codex (missing instance)`,
      });

      provider = 'codex';
      providerConfig = codexConfig;
      if (updatedTask) {
        Object.assign(task, updatedTask);
      } else {
        task.provider = 'codex';
        task.model = null;
      }

      const codexResult = buildCodexCommand(task, providerConfig, resolvedFileContext, resolvedFiles);
      cliPath = codexResult.cliPath;
      finalArgs = codexResult.finalArgs;
      stdinPrompt = codexResult.stdinPrompt;
    } else {
      return executeApiProvider(task, instance);
    }
  } else if (provider === 'claude-cli') {
    const claudeResult = buildClaudeCliCommand(task, providerConfig, resolvedFileContext);
    cliPath = claudeResult.cliPath;
    finalArgs = claudeResult.finalArgs;
    stdinPrompt = claudeResult.stdinPrompt;
  } else {
    // Codex (default)
    const codexResult = buildCodexCommand(task, providerConfig, resolvedFileContext, resolvedFiles);
    cliPath = codexResult.cliPath;
    finalArgs = codexResult.finalArgs;
    stdinPrompt = codexResult.stdinPrompt;
  }

  // Ensure nvm node path is in PATH if available
  const envPath = process.env.PATH || '';
  const updatedPath = (NVM_NODE_PATH && !envPath.includes(NVM_NODE_PATH))
    ? `${NVM_NODE_PATH}${path.delimiter}${envPath}`
    : envPath;

  // Build environment variables
  const envVars = {
    ...process.env,
    PATH: updatedPath,
    // Ensure HOME is set (required by many tools)
    HOME: process.env.HOME || process.env.USERPROFILE || '/tmp',
    // Disable TTY detection and interactive prompts
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    CI: '1',  // Many tools check for CI environment to disable prompts
    CODEX_NON_INTERACTIVE: '1',  // Custom flag for our use
    CLAUDE_NON_INTERACTIVE: '1', // Custom flag for Claude
    // Ensure git works properly
    GIT_TERMINAL_PROMPT: '0',  // Disable git credential prompts
    // Fix Windows cp1252 encoding crash when LLM output contains emoji/unicode (P59)
    PYTHONIOENCODING: 'utf-8'
  };

  // Add Ollama-specific env vars for aider (with multi-host routing)
  let selectedOllamaHostId = null;
  if (provider === 'aider-ollama') {
    const hostResult = configureAiderHost(task, taskId, envVars);
    if (hostResult.requeued) return hostResult.result;
    selectedOllamaHostId = hostResult.selectedHostId;
  }

  recordTaskStartedAuditEvent(task, taskId, provider);

  // On Windows, .cmd/.bat files must be launched via cmd.exe — BUT cmd.exe
  // creates a visible console window AND can break process 'close' events.
  // Always try to resolve the .cmd wrapper to its underlying node script
  // and spawn node.exe directly. This avoids both problems.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    const resolved = resolveWindowsCmdToNode(cliPath);
    if (resolved) {
      logger.info(`[TaskManager] Resolved ${cliPath} → node ${resolved.scriptPath}`);
      cliPath = resolved.nodePath;
      finalArgs = [resolved.scriptPath, ...finalArgs];
    } else {
      // Fallback: cmd.exe wrapping (stdin piping may fail, window may appear)
      logger.info(`[TaskManager] WARNING: Could not resolve ${cliPath} to node script — falling back to cmd.exe`);
      finalArgs = ['/c', cliPath, ...finalArgs];
      cliPath = 'cmd.exe';
    }
  }

  const options = {
    cwd: task.working_directory || process.cwd(),
    env: envVars,
    shell: false,
    // windowsHide hides the console window on Windows but breaks the 'close' event
    // when combined with cmd.exe or certain .exe spawns. Instead, we only use it
    // for non-long-running spawns (spawnSync). For task processes, we accept that
    // resolved node.exe spawns don't create windows, and cmd.exe wrapping is avoided
    // via resolveWindowsCmdToNode above.
    // Explicitly configure stdio: stdin is piped (we'll close it), stdout/stderr are piped
    stdio: ['pipe', 'pipe', 'pipe']
  };

  // Capture baseline HEAD SHA before spawning so post-task validation can diff
  // only the files this task changed, not files from a prior unrelated commit.
  // Without this, `git diff HEAD~1 HEAD` may return files from a manual commit
  // made between sessions, causing false-positive validation failures.
  let baselineCommit = null;
  if (!skipGitInCloseHandler) try {
    baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: options.cwd, encoding: 'utf-8', timeout: TASK_TIMEOUTS.GIT_STATUS, windowsHide: true
    }).trim();
  } catch (e) {
    logger.info(`[TaskManager] Could not capture baseline HEAD for task ${taskId}: ${e.message}`);
  }

  // === SPAWN AND TRACK ===
  return spawnAndTrackProcess(taskId, task, {
    cliPath, finalArgs, stdinPrompt, options, provider,
    selectedOllamaHostId, usedEditFormat, taskMetadata,
    taskType, contextTokenEstimate, baselineCommit
  });
  } catch (err) {
    try {
      const currentTask = db.getTask(taskId);
      if (currentTask && currentTask.status === 'running' && !currentTask.pid) {
        safeUpdateTaskStatus(taskId, 'failed', {
          error_output: err.message,
          pid: null,
          mcp_instance_id: null,
          ollama_host_id: null,
        });
      }
    } catch (releaseErr) {
      logger.info(`[startTask] Failed to release claimed slot for ${taskId}: ${releaseErr.message}`);
    }
    throw err;
  }
}

const { cancelTask, triggerCancellationWebhook } = createCancellationHandler({
  db,
  runningProcesses,
  apiAbortControllers,
  pendingRetryTimeouts,
  stallRecoveryAttempts,
  logger,
  sanitizeAiderOutput,
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
    const lockResult = db.acquireLock(
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
        db.releaseLock(QUEUE_LOCK_NAME, QUEUE_LOCK_HOLDER_ID);
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

/**
 * Attempt to start a task with outcome details for queue accounting.
 * Wraps startTask() to catch both sync throws and async rejections,
 * and reverts tasks that get stuck in 'running' without a PID.
 *
 * @param {string} taskId - Task ID to start
 * @param {string} label - Logging label (e.g., 'ollama', 'codex', 'API', 'fallback')
 * @returns {{ started: boolean, queued: boolean, pendingAsync: boolean, failed?: boolean, error?: string }}
 */
function attemptTaskStart(taskId, label) {
  try {
    const maybePromise = startTask(taskId);
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch((asyncErr) => {
        logger.error(`processQueue: async failure for ${label} task ${taskId}`, { error: asyncErr.message });
      });
      return { started: false, queued: false, pendingAsync: true };
    }
    if (maybePromise && typeof maybePromise === 'object' && maybePromise.queued === true) {
      return { started: false, queued: true, pendingAsync: false };
    }
    return { started: true, queued: false, pendingAsync: false };
  } catch (err) {
    logger.error(`processQueue: failed to start ${label} task ${taskId}`, { error: err.message });
    try {
      const t = db.getTask(taskId);
      if (t && t.status === 'running' && !t.pid) {
        db.updateTaskStatus(taskId, 'failed', { error_output: err.message });
        logger.info(`processQueue: reverted stuck task ${taskId.slice(0, 8)} to failed`);
      }
    } catch { /* ignore revert errors */ }
    return {
      started: false,
      queued: false,
      pendingAsync: false,
      failed: true,
      error: err.message,
    };
  }
}

/**
 * Safely start a task with boolean semantics for legacy callers.
 * @param {string} taskId
 * @param {string} label
 * @returns {boolean}
 */
function safeStartTask(taskId, label) {
  return attemptTaskStart(taskId, label).started;
}


/**
 * Estimate progress based on output patterns
 */
function estimateProgress(output, provider) {
  // Check for completion patterns first — these indicate the task is done
  // even if the process hasn't exited yet (common with claude-cli on Windows)
  if (detectOutputCompletion(output, provider)) {
    return 95; // Task is effectively done, process just hasn't exited
  }

  // Look for common progress indicators
  const lines = output.split('\n');
  const totalLines = lines.length;

  // Simple heuristic: more output = more progress
  // Cap at 90% until completion patterns are detected
  const progress = Math.min(90, Math.floor(totalLines / 2));

  return progress;
}

// Delegated to validation/completion-detection.js
const {
  detectSuccessFromOutput,
  detectOutputCompletion,
  COMPLETION_OUTPUT_THRESHOLDS,
  SHARED_COMPLETION_PATTERNS,
  PROVIDER_COMPLETION_PATTERNS,
} = completionDetection;

/**
 * Get actual modified files from git status (most accurate method)
 * This avoids false positives from parsing LLM output where files are mentioned but not modified
 * @param {string} workingDir - The working directory (must be in a git repo)
 * @returns {string[]} Array of actually modified file paths
 */
function getActualModifiedFiles(workingDir) {
  if (skipGitInCloseHandler) return null;
  try {
    // SECURITY: Using execFileSync with array args (safe from injection)
    const result = execFileSync('git', ['status', '--porcelain'], {
      cwd: workingDir,
      encoding: 'utf8',
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      maxBuffer: 1024 * 1024
    });

    const files = [];
    for (const line of result.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseGitStatusLine(line);
      if (!parsed) continue;
      // Only include modified/added files, not deleted or untracked
      // Untracked files (?) are excluded because:
      // 1. For review tasks, they're likely temporary files from aider
      // 2. They weren't part of the original codebase to begin with
      // 3. New files should be added via git add, not just created
      // P99: Also exclude files with D (deleted) in either column — these are
      // "ghost" files (e.g., AD = staged but deleted from disk). They fool the
      // no-file-change detector into thinking code was modified.
      if ((parsed.isModified || parsed.indexStatus === 'A') && !parsed.isDeleted) {
        // Skip obvious non-code files
        // P96: Also skip .gitignore — aider always creates it, which fools
        // the no-file-change detector into thinking code was produced
        if (!parsed.filePath.endsWith('.db') && !parsed.filePath.startsWith('.git/') && parsed.filePath !== '.gitignore') {
          files.push(parsed.filePath);
        }
      }
    }

    return files;
  } catch (err) {
    logger.info(`[ModifiedFiles] Git status failed: ${err.message}`);
    return []; // Return empty on error - don't run safeguards if we can't verify
  }
}

/**
 * Get progress/status of a running task
 * @param {string} taskId - Task ID (full or prefix)
 * @returns {Object|null} Progress details or null when task not found
 */
function getTaskProgress(taskId) {
  // Resolve partial ID to full ID
  const fullId = db.resolveTaskId(taskId) || taskId;

  const proc = runningProcesses.get(fullId);
  if (proc) {
    return {
      running: true,
      output: sanitizeAiderOutput(proc.output),
      errorOutput: proc.errorOutput,
      elapsedSeconds: Math.round((Date.now() - proc.startTime) / 1000),
      progress: estimateProgress(proc.output, proc.provider)
    };
  }

  const task = db.getTask(fullId);
  if (task) {
    // If DB says 'running' but process is not in memory, it's an orphan — report accurately
    const isRunning = task.status === 'running';
    return {
      running: isRunning,
      output: task.output || '',
      errorOutput: task.error_output || '',
      progress: isRunning ? 0 : task.progress_percent
    };
  }

  return null;
}

/**
 * Get count of currently running tasks
 * @returns {number} Count of running tasks in memory
 */
function getRunningTaskCount() {
  return runningProcesses.size;
}

/**
 * Fix F5: Check if a task has a running process in this server instance
 * @param {string} taskId - Task ID
 * @returns {boolean} True if the task has an active process
 */
function hasRunningProcess(taskId) {
  return runningProcesses.has(taskId);
}

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
      cancelTask(taskId, 'Server shutdown');
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

// ─── Hashline-Ollama Provider ─────────────────────────────────────────────────
// Direct Ollama API + hashline edits — bypasses aider entirely.
// Hash verification catches hallucinated edits before writing to disk.

const HASHLINE_OLLAMA_SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/hashline-ollama-system.txt'), 'utf-8');

const HASHLINE_LITE_SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/hashline-lite-system.txt'), 'utf-8');

/**
 * Execute a task using the hashline-ollama provider.
 * Calls Ollama API directly with hashline-annotated file context,
 * parses structured edit blocks from the response, and applies them.
 * Falls back to regular executeOllamaTask if no file can be resolved.
 */
/**
 * Check if a model is on the hashline-capable allowlist.
 * Models not on the list hallucinate hashes and should not be used for hashline editing.
 */

/**
 * Find the next larger hashline-capable model available on any healthy host.
 * Prefers the smallest model larger than the current one.
 * Falls back to any untried hashline-capable model if no larger one exists.
 * @param {string} currentModel - Current model name (e.g., 'qwen2.5-coder:7b')
 * @param {string} priorErrors - Accumulated error_output to check for already-tried models
 * @returns {{ name: string, hostId: string|null } | null}
 */

/**
 * Tiered fallback for hashline tasks.
 * Now tries local model escalation before leaving the machine:
 *   1. Same model on different host (for host-related failures)
 *   2. Larger hashline-capable local model
 *   3. codex (always available)
 *
 * Tracks attempts via [Hashline-Local] markers in error_output.
 * Configurable max retries via max_hashline_local_retries (default: 2).
 */

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

_executionModule.init({
  db, dashboard, runningProcesses, apiAbortControllers,
  safeUpdateTaskStatus,
  recordTaskStartedAuditEvent,
  tryReserveHostSlotWithFallback,
  markTaskCleanedUp,
  tryOllamaCloudFallback: _fallbackRetryModule.tryOllamaCloudFallback,
  tryLocalFirstFallback: _fallbackRetryModule.tryLocalFirstFallback,
  verifyHashlineReferences,
  attemptFuzzySearchRepair,
  tryHashlineTieredFallback: _fallbackRetryModule.tryHashlineTieredFallback,
  selectHashlineFormat: _fallbackRetryModule.selectHashlineFormat,
  findNextHashlineModel: _fallbackRetryModule.findNextHashlineModel,
  isHashlineCapableModel: _fallbackRetryModule.isHashlineCapableModel,
  shellEscape,
  processQueue,
  hashlineOllamaSystemPrompt: HASHLINE_OLLAMA_SYSTEM_PROMPT,
  hashlineLiteSystemPrompt: HASHLINE_LITE_SYSTEM_PROMPT,
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
    sanitizeAiderOutput,
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
  handleContinuousBatchSubmission: require('./handlers/automation-batch-orchestration').handleContinuousBatchSubmission,
});
registerTaskStatusTransitionListener();

_outputSafeguards.init({
  db,
  getFileChangesForValidation,
  checkFileQuality,
  findPlaceholderArtifacts,
  parseAiderOutput,
  verifyHashlineReferences,
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
_hashlineVerify.init({
  computeLineHash,
  getFileChangesForValidation,
  lineSimilarity,
});
_aiderCommand.init({
  db,
  dashboard,
  wrapWithInstructions,
  detectTaskTypes,
  isLargeModelBlockedOnHost,
  tryReserveHostSlotWithFallback,
  processQueue,
  extractTargetFilesFromDescription,
  ensureTargetFilesExist,
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
  sanitizeAiderOutput,
  safeUpdateTaskStatus,
  tryLocalFirstFallback,
  tryHashlineTieredFallback,
  processQueue,
});
_retryFramework.init({
  db,
  classifyError,
  sanitizeAiderOutput,
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
  sanitizeAiderOutput,
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
  analyzeTaskForRouting: db.analyzeTaskForRouting,
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
  evaluateTaskSubmissionPolicy,
  evaluateTaskPreExecutePolicy,
  fireTaskCompletionPolicyHook,
  // Harness improvement internals (exported for testing)
  computeLineHash,
  detectTaskTypes,
  verifyHashlineReferences,
  attemptFuzzySearchRepair,
  lineSimilarity,
  // Hashline-Ollama provider internals (exported for testing)
  parseHashlineEdits,
  applyHashlineEdits,
  HASHLINE_OLLAMA_SYSTEM_PROMPT,
  // Hashline-Lite provider internals (exported for testing)
  HASHLINE_LITE_SYSTEM_PROMPT,
  parseHashlineLiteEdits,
  applyHashlineLiteEdits,
  selectHashlineFormat,
  findSearchMatch,
  // Hashline local fallback (exported for testing)
  tryHashlineTieredFallback,
  findNextHashlineModel,
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
  buildAiderCommand,
  configureAiderHost,
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
    },
    waitForPendingHandlers,
    set skipGitInCloseHandler(v) { skipGitInCloseHandler = v; },
    get skipGitInCloseHandler() { return skipGitInCloseHandler; },
  },
  // Explicit initialization functions (previously module-level side effects)
  initEarlyDeps,
  initSubModules,
  startQueuePoll,
  // DI factory (Phase 3) — deps reserved for Phase 5 when database.js facade is removed
  createTaskManager,
});

function createTaskManager(deps) {
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
    evaluateTaskSubmissionPolicy,
    evaluateTaskPreExecutePolicy,
    fireTaskCompletionPolicyHook,
    computeLineHash,
    detectTaskTypes,
    verifyHashlineReferences,
    attemptFuzzySearchRepair,
    lineSimilarity,
    parseHashlineEdits,
    applyHashlineEdits,
    HASHLINE_OLLAMA_SYSTEM_PROMPT,
    HASHLINE_LITE_SYSTEM_PROMPT,
    parseHashlineLiteEdits,
    applyHashlineLiteEdits,
    selectHashlineFormat,
    findSearchMatch,
    tryHashlineTieredFallback,
    findNextHashlineModel,
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
    buildAiderCommand,
    configureAiderHost,
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
