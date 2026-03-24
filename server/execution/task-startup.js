/**
 * Task Startup & Query Module
 * Extracted from task-manager.js — handles task startup pipeline,
 * queue processing helpers, and task progress/status queries.
 *
 * Uses dependency injection via init() to avoid circular requires.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const logger = require('../logger').child({ component: 'task-startup' });
const { TASK_TIMEOUTS } = require('../constants');
const { parseGitStatusLine } = require('../utils/git');

// ── Injected Dependencies ──────────────────────────────────────────────────
let db;
let dashboard;
let serverConfig;
let providerRegistry;
let gpuMetrics;
let runningProcesses;
let pendingRetryTimeouts;

// Injected functions
let parseTaskMetadata;
let getTaskContextTokenEstimate;
let safeUpdateTaskStatus;
let resolveProviderRouting;
let failTaskForInvalidProvider;
let getProviderSlotLimits;
let getEffectiveGlobalMaxConcurrent;
let spawnAndTrackProcess;
let buildClaudeCliCommand;
let buildCodexCommand;
let buildFileContext;
let resolveFileReferences;
let executeOllamaTask;
let executeHashlineOllamaTask;
let executeApiProvider;
let evaluateTaskPreExecutePolicy;
let getPolicyBlockReason;
let cancelTask;
let processQueue;
let sanitizeTaskOutput;
let detectOutputCompletion;
let QUEUE_LOCK_HOLDER_ID;

// State
let skipGitInCloseHandler = false;

// Track last cleanup time to avoid excessive cleanup overhead
let lastRetryCleanupTime = 0;
const RETRY_CLEANUP_INTERVAL_MS = 30000;

// Maximum output buffer size (10MB) to prevent memory exhaustion
const MAX_OUTPUT_BUFFER = 10 * 1024 * 1024;

/**
 * Initialize with dependencies. Called from task-manager.js initSubModules().
 */
function init(deps) {
  db = deps.db;
  dashboard = deps.dashboard;
  serverConfig = deps.serverConfig;
  providerRegistry = deps.providerRegistry;
  gpuMetrics = deps.gpuMetrics;
  runningProcesses = deps.runningProcesses;
  pendingRetryTimeouts = deps.pendingRetryTimeouts;
  parseTaskMetadata = deps.parseTaskMetadata;
  getTaskContextTokenEstimate = deps.getTaskContextTokenEstimate;
  safeUpdateTaskStatus = deps.safeUpdateTaskStatus;
  resolveProviderRouting = deps.resolveProviderRouting;
  failTaskForInvalidProvider = deps.failTaskForInvalidProvider;
  getProviderSlotLimits = deps.getProviderSlotLimits;
  getEffectiveGlobalMaxConcurrent = deps.getEffectiveGlobalMaxConcurrent;
  spawnAndTrackProcess = deps.spawnAndTrackProcess;
  buildClaudeCliCommand = deps.buildClaudeCliCommand;
  buildCodexCommand = deps.buildCodexCommand;
  buildFileContext = deps.buildFileContext;
  resolveFileReferences = deps.resolveFileReferences;
  executeOllamaTask = deps.executeOllamaTask;
  executeHashlineOllamaTask = deps.executeHashlineOllamaTask;
  executeApiProvider = deps.executeApiProvider;
  evaluateTaskPreExecutePolicy = deps.evaluateTaskPreExecutePolicy;
  getPolicyBlockReason = deps.getPolicyBlockReason;
  cancelTask = deps.cancelTask;
  processQueue = deps.processQueue;
  sanitizeTaskOutput = deps.sanitizeTaskOutput;
  detectOutputCompletion = deps.detectOutputCompletion;
  QUEUE_LOCK_HOLDER_ID = deps.QUEUE_LOCK_HOLDER_ID;
}

// ── NVM / Windows helpers ──────────────────────────────────────────────────

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

// ── Preflight & Safeguard Checks ───────────────────────────────────────────

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

// ── startTask ──────────────────────────────────────────────────────────────

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
  const usedEditFormat = null;

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

  const selectedOllamaHostId = null;

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

// ── Queue Processing Helpers ───────────────────────────────────────────────

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

// ── Task Progress & Status Queries ─────────────────────────────────────────

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
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });

    const files = [];
    for (const line of result.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseGitStatusLine(line);
      if (!parsed) continue;
      // Only include modified/added files, not deleted or untracked
      // Untracked files (?) are excluded because:
      // 1. For review tasks, they're likely temporary files from the LLM
      // 2. They weren't part of the original codebase to begin with
      // 3. New files should be added via git add, not just created
      // P99: Also exclude files with D (deleted) in either column — these are
      // "ghost" files (e.g., AD = staged but deleted from disk). They fool the
      // no-file-change detector into thinking code was modified.
      if ((parsed.isModified || parsed.indexStatus === 'A') && !parsed.isDeleted) {
        // Skip obvious non-code files
        // P96: Also skip .gitignore — LLMs sometimes create it, which fools
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
      output: sanitizeTaskOutput(proc.output),
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

// ── Retry Timeout Cleanup ──────────────────────────────────────────────────

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

// ── Setters for test-mode flags ────────────────────────────────────────────

function setSkipGitInCloseHandler(v) { skipGitInCloseHandler = v; }
function getSkipGitInCloseHandler() { return skipGitInCloseHandler; }

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  init,
  // Startup pipeline
  startTask,
  runPreflightChecks,
  runSafeguardPreChecks,
  recordTaskStartedAuditEvent,
  // Queue helpers
  attemptTaskStart,
  safeStartTask,
  // Progress / queries
  estimateProgress,
  getActualModifiedFiles,
  getTaskProgress,
  getRunningTaskCount,
  hasRunningProcess,
  // Utility
  getNvmNodePath,
  resolveWindowsCmdToNode,
  cleanupOrphanedRetryTimeouts,
  // Constants
  NVM_NODE_PATH,
  MAX_OUTPUT_BUFFER,
  // Test-mode flag accessors
  setSkipGitInCloseHandler,
  getSkipGitInCloseHandler,
};
