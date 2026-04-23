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
const { parseMentions } = require('../repo-graph/mention-parser');
const { createTaskTranscriptLog } = require('../transcripts/transcript-log');
const { validateTranscript } = require('../transcripts/transcript-validator');
const { PreflightError, isPreflightError } = require('./preflight-error');

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

function resolveRunnableOllamaModel(task) {
  try {
    let requestedModel = task?.model || null;

    if (!requestedModel) {
      try {
        const registry = require('../models/registry');
        const best = registry.selectBestApprovedModel('ollama');
        if (best?.model_name) requestedModel = best.model_name;
      } catch { /* non-fatal */ }
    }

    const ollamaShared = require('../providers/ollama-shared');
    if (!requestedModel) {
      requestedModel = ollamaShared.resolveOllamaModel(task, null) || '';
    }

    if (!requestedModel || !ollamaShared.hasModelOnAnyHost(requestedModel)) {
      const bestAvailable = ollamaShared.findBestAvailableModel();
      if (bestAvailable) requestedModel = bestAvailable;
    }

    const normalized = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    return normalized || null;
  } catch (err) {
    logger.info(`[startTask] Failed to resolve Ollama model for task ${task?.id || 'unknown'}: ${err.message}`);
    return null;
  }
}

function getRunDirManager() {
  try {
    const { defaultContainer } = require('../container');
    if (defaultContainer && typeof defaultContainer.has === 'function' && defaultContainer.has('runDirManager')) {
      return defaultContainer.get('runDirManager');
    }
  } catch {
    // Container is best-effort here; startup can proceed without run-dir indexing support.
  }
  return null;
}

function getMentionResolver() {
  try {
    const { defaultContainer } = require('../container');
    if (defaultContainer && typeof defaultContainer.has === 'function' && defaultContainer.has('mentionResolver')) {
      return defaultContainer.get('mentionResolver');
    }
  } catch {
    // The container is optional here; startup can continue without mention resolution.
  }

  try {
    const { createMentionResolver } = require('../repo-graph/mention-resolver');
    const rawDb = typeof db?.getDbInstance === 'function' ? db.getDbInstance() : db;
    return createMentionResolver({ db: rawDb, logger });
  } catch {
    return null;
  }
}

function formatResolvedMentionContext(result) {
  const body = typeof result?.content === 'string' && result.content.trim()
    ? result.content
    : typeof result?.body_preview === 'string' && result.body_preview.trim()
      ? result.body_preview
      : JSON.stringify(result);

  if (!body) return null;
  return `## Context: ${result.raw}\n${body}`;
}

async function buildExecutionDescriptionWithMentions(task, taskId) {
  const description = typeof task?.task_description === 'string' ? task.task_description : '';
  if (!description.trim()) {
    return description;
  }

  const parsed = parseMentions(description);
  if (!Array.isArray(parsed.mentions) || parsed.mentions.length === 0) {
    return description;
  }

  const resolver = getMentionResolver();
  if (!resolver || typeof resolver.resolve !== 'function') {
    logger.debug(`[MentionContext] Mention resolver unavailable for task ${taskId}`);
    return description;
  }

  try {
    const resolved = await resolver.resolve(parsed.mentions);
    const resolvedBlocks = resolved
      .filter((entry) => entry && entry.resolved)
      .map(formatResolvedMentionContext)
      .filter(Boolean);
    const unresolvedCount = resolved.filter((entry) => !entry || !entry.resolved).length;

    if (unresolvedCount > 0 && typeof db.addTaskTags === 'function') {
      try {
        db.addTaskTags(taskId, [`mentions:unresolved:${unresolvedCount}`]);
      } catch (err) {
        logger.debug(`[MentionContext] Failed to tag unresolved mentions for ${taskId}: ${err.message}`);
      }
    }

    if (resolvedBlocks.length === 0) {
      return description;
    }

    logger.info(`[MentionContext] Resolved ${resolvedBlocks.length}/${resolved.length} @-mention(s) for task ${taskId}`);
    return `${resolvedBlocks.join('\n\n')}\n\n---\n\n${description}`;
  } catch (err) {
    logger.info(`[MentionContext] Non-fatal mention resolution error for task ${taskId}: ${err.message}`);
    return description;
  }
}

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

function buildProviderStartupEnv({ taskId, task, taskMetadata = {}, runDir, env, nvmNodePath, nativeCodex = null }) {
  const envPath = env.PATH || '';
  let updatedPath = (nvmNodePath && !envPath.includes(nvmNodePath))
    ? `${nvmNodePath}${path.delimiter}${envPath}`
    : envPath;

  // When launching the native codex.exe directly (bypassing the node wrapper),
  // the wrapper's PATH augmentation for the bundled vendor tools (rg.exe) is
  // lost. Mirror it here: prepend the vendor path dir if the resolver returned
  // one and it isn't already on PATH.
  if (nativeCodex && nativeCodex.pathPrepend && !envPath.split(path.delimiter).includes(nativeCodex.pathPrepend)) {
    updatedPath = `${nativeCodex.pathPrepend}${path.delimiter}${updatedPath}`;
  }

  const base = {
    ...env,
    PATH: updatedPath,
    // Ensure HOME is set (required by many tools)
    HOME: env.HOME || env.USERPROFILE || '/tmp',
    // Disable TTY detection and interactive prompts
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    CI: '1',  // Many tools check for CI environment to disable prompts
    CODEX_NON_INTERACTIVE: '1',  // Custom flag for our use
    CLAUDE_NON_INTERACTIVE: '1', // Custom flag for Claude
    TORQUE_TASK_ID: taskId,
    TORQUE_WORKFLOW_ID: task.workflow_id || '',
    TORQUE_WORKFLOW_NODE_ID: task.workflow_node_id || '',
    TORQUE_RUN_DIR: runDir || '',
    TORQUE_TRANSCRIPT_PATH: taskMetadata.transcript_path || '',
    // Ensure git works properly
    GIT_TERMINAL_PROMPT: '0',  // Disable git credential prompts
    // Fix Windows cp1252 encoding crash when LLM output contains emoji/unicode (P59)
    PYTHONIOENCODING: 'utf-8'
  };

  // Carry the npm-managed marker the node wrapper would normally set, so
  // codex.exe behaves identically whether launched via wrapper or direct.
  if (nativeCodex && nativeCodex.envAdditions) {
    Object.assign(base, nativeCodex.envAdditions);
  }

  return base;
}

function resolvePlatformProviderCommand({
  cliPath,
  finalArgs,
  platform,
  resolveCmdToNode,
  log,
}) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    const resolved = resolveCmdToNode(cliPath);
    if (resolved) {
      log.info(`[TaskManager] Resolved ${cliPath} → node ${resolved.scriptPath}`);
      return {
        cliPath: resolved.nodePath,
        finalArgs: [resolved.scriptPath, ...finalArgs],
      };
    }

    // Fallback: cmd.exe wrapping (stdin piping may fail, window may appear)
    log.info(`[TaskManager] WARNING: Could not resolve ${cliPath} to node script — falling back to cmd.exe`);
    return {
      cliPath: 'cmd.exe',
      finalArgs: ['/c', cliPath, ...finalArgs],
    };
  }

  return { cliPath, finalArgs };
}

function buildBaselineCommitCapture(cwd) {
  return {
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    options: {
      cwd,
      encoding: 'utf-8',
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      windowsHide: true,
    },
  };
}

function captureBaselineHead({ taskId, baselineCapture, skipGit, log }) {
  if (skipGit) return null;
  try {
    return execFileSync(
      baselineCapture.command,
      baselineCapture.args,
      baselineCapture.options
    ).trim();
  } catch (e) {
    log.info(`[TaskManager] Could not capture baseline HEAD for task ${taskId}: ${e.message}`);
    return null;
  }
}

async function buildProviderStartupCommand({
  taskId,
  task,
  provider,
  providerConfig,
  executionTask,
  resolvedFileContext,
  resolvedFiles,
  runDir,
  taskMetadata = {},
  usedEditFormat,
  taskType,
  contextTokenEstimate,
  env = process.env,
  platform = process.platform,
  nvmNodePath = NVM_NODE_PATH,
  resolveCmdToNode = resolveWindowsCmdToNode,
  captureBaselineCommit = captureBaselineHead,
  log = logger,
} = {}) {
  if (provider === 'ollama') {
    return {
      mode: 'ollama',
      provider,
      executionTask,
    };
  }

  const command = provider === 'claude-cli'
    ? buildClaudeCliCommand(executionTask, providerConfig, resolvedFileContext)
    : await buildCodexCommand(executionTask, providerConfig, resolvedFileContext, resolvedFiles);

  const envVars = buildProviderStartupEnv({
    taskId,
    task,
    taskMetadata,
    runDir,
    env,
    nvmNodePath,
    nativeCodex: command.nativeCodex || null,
  });

  // When buildCodexCommand returned a native binary path, skip the .cmd →
  // node-script rewrite: cliPath is already an absolute .exe, not a shim.
  const platformCommand = command.nativeCodex
    ? { cliPath: command.cliPath, finalArgs: [...command.finalArgs] }
    : resolvePlatformProviderCommand({
        cliPath: command.cliPath,
        finalArgs: [...command.finalArgs],
        platform,
        resolveCmdToNode,
        log,
      });

  const options = {
    cwd: task.working_directory || process.cwd(),
    env: envVars,
    shell: false,
    windowsHide: true,
    // Explicitly configure stdio: stdin is piped (we'll close it), stdout/stderr are piped
    stdio: ['pipe', 'pipe', 'pipe']
  };

  const baselineCapture = buildBaselineCommitCapture(options.cwd);
  const baselineCommit = captureBaselineCommit({
    taskId,
    baselineCapture,
    skipGit: skipGitInCloseHandler,
    log,
  });

  return {
    mode: 'spawn',
    cliPath: platformCommand.cliPath,
    finalArgs: platformCommand.finalArgs,
    stdinPrompt: command.stdinPrompt,
    options,
    provider,
    selectedOllamaHostId: null,
    usedEditFormat,
    taskMetadata,
    taskType,
    contextTokenEstimate,
    baselineCommit,
  };
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
        throw new PreflightError(`Working directory is not a directory: ${task.working_directory}`, {
          code: 'WORKING_DIR_NOT_DIRECTORY',
          deterministic: true,
        });
      }
    } catch (err) {
      if (err instanceof PreflightError) throw err;
      if (err.code === 'ENOENT') {
        throw new PreflightError(`Working directory does not exist: ${task.working_directory}`, {
          code: 'WORKING_DIR_MISSING',
          deterministic: true,
          cause: err,
        });
      }
      throw new PreflightError(
        `Failed to stat working directory (${err.code || 'UNKNOWN'}): ${task.working_directory}`,
        { code: 'WORKING_DIR_STAT_FAILED', deterministic: false, cause: err },
      );
    }
  }
  if (!task.task_description || task.task_description.trim().length === 0) {
    throw new PreflightError('Task description cannot be empty', {
      code: 'TASK_DESCRIPTION_EMPTY',
      deterministic: true,
    });
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

function runStartupPreflight({
  task,
  taskId,
  getMaxConcurrent,
  config,
  metrics,
  preflight,
  log,
}) {
  const maxConcurrent = getMaxConcurrent();
  const resourceGatingEnabled = config.get('resource_gating_enabled');
  if (resourceGatingEnabled === '1') {
    const pressureLevel = metrics.getPressureLevel();
    if (pressureLevel === 'critical') {
      throw new Error(`Cannot start task ${taskId}: critical resource pressure - CPU/RAM above 95%`);
    }
    if (pressureLevel === 'high') {
      log.warn(`Starting task ${taskId} under high resource pressure - performance may be degraded`);
    }
  }

  preflight(task);
  return { maxConcurrent, usedEditFormat: null };
}

function resolveStartupProvider({
  task,
  taskId,
  resolveRouting,
  registry,
  failInvalidProvider,
  parseMetadata,
  patchMetadata,
  log,
}) {
  const routing = resolveRouting(task, taskId);
  const provider = routing.provider;
  if (!registry.isKnownProvider(provider)) {
    const errorMessage = failInvalidProvider(taskId, provider);
    throw new Error(errorMessage);
  }

  if (routing.switchReason) {
    const currentMeta = parseMetadata(task.metadata);
    currentMeta._provider_switch_reason = routing.switchReason;
    currentMeta.intended_provider = provider;
    try {
      patchMetadata(taskId, currentMeta);
    } catch (metaErr) {
      log.debug(`[startTask] Failed to persist routing switch metadata for ${taskId}: ${metaErr.message}`);
    }
  }

  return { provider, routing };
}

function propagateRoutingChain({
  task,
  taskId,
  provider,
  parseMetadata,
  log,
}) {
  const routingMeta = parseMetadata(task.metadata);
  const routingChain = Array.isArray(routingMeta._routing_chain)
    ? routingMeta._routing_chain
    : [];
  if (routingChain.length === 0) {
    return;
  }

  const matchingEntry = routingChain.find(entry => entry.provider === provider) || routingChain[0];
  if (matchingEntry && matchingEntry.model && !task.model) {
    task.model = matchingEntry.model;
    log.debug(`[startTask] Propagated model '${matchingEntry.model}' from routing chain for task ${taskId}`);
  }
}

function evaluateStartupSafeguards({
  task,
  taskId,
  provider,
  runSafeguards,
  parseMetadata,
  classifyTaskType,
  estimateContextTokens,
}) {
  const safeguardResult = runSafeguards(task, taskId, provider);
  if (safeguardResult) {
    return { earlyResult: safeguardResult };
  }

  const taskMetadata = parseMetadata(task.metadata);
  const taskType = classifyTaskType(task.task_description || '');
  const contextTokenEstimate = estimateContextTokens(taskMetadata, task.context);
  return {
    earlyResult: null,
    taskMetadata,
    taskType,
    contextTokenEstimate,
  };
}

const SANDBOXED_PROVIDERS = new Set(['codex', 'codex-spark', 'claude-cli']);

function createTaskStartupResourceLifecycle({
  taskId,
  task,
  provider,
  maxConcurrent,
}) {
  let slotClaimed = false;
  let providerConfig = null;
  const acquiredFileLocks = [];
  const releasedFileLocks = new Set();

  function releaseAcquiredFileLocks() {
    for (let index = acquiredFileLocks.length - 1; index >= 0; index--) {
      const lock = acquiredFileLocks[index];
      const lockKey = `${lock.workingDirectory}\0${lock.filePath}`;
      if (releasedFileLocks.has(lockKey)) {
        continue;
      }
      releasedFileLocks.add(lockKey);
      try {
        if (typeof db.releaseFileLock === 'function') {
          db.releaseFileLock(lock.filePath, lock.workingDirectory, taskId);
        }
      } catch (err) {
        logger.info(`[FileLock] Non-fatal release error for ${lock.filePath}: ${err.message}`);
      }
    }
  }

  function releaseClaimedSlot(status, fields) {
    if (!slotClaimed) {
      return;
    }
    const currentTask = db.getTask(taskId);
    if (currentTask && currentTask.status === 'running' && !currentTask.pid) {
      safeUpdateTaskStatus(taskId, status, {
        ...fields,
        pid: null,
        mcp_instance_id: null,
        ollama_host_id: null,
      });
    }
  }

  function releaseOnStartupFailure(err) {
    releaseAcquiredFileLocks();
    try {
      releaseClaimedSlot('failed', { error_output: err.message });
    } catch (releaseErr) {
      logger.info(`[startTask] Failed to release claimed slot for ${taskId}: ${releaseErr.message}`);
    }
  }

  function releaseForPolicyBlock(cancelReason) {
    releaseAcquiredFileLocks();
    try {
      releaseClaimedSlot('cancelled', { error_output: cancelReason });
    } catch (releaseErr) {
      logger.info(`[Policy] Failed to release claimed slot for ${taskId}: ${releaseErr.message}`);
    }
  }

  function claimSlot() {
    providerConfig = db.getProvider(provider);
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
        db.updateTaskStatus(taskId, 'queued');
        return { earlyResult: { queued: true, task: db.getTask(taskId) } };
      }
      if (claimResult.reason === 'already_running') {
        return { earlyResult: { queued: false, alreadyRunning: true } };
      }
      if (claimResult.reason === 'not_found') {
        throw new Error(`Task not found: ${taskId}`);
      }
      if (claimResult.reason === 'invalid_status') {
        throw new Error(`Task in invalid status for starting: ${claimResult.status}`);
      }
      throw new Error(`Failed to claim task slot: ${claimResult.reason}`);
    }

    slotClaimed = true;
    return { earlyResult: null, claimResult, providerConfig };
  }

  async function resolveAndLockFiles(currentProvider) {
    let resolvedFileContext = '';
    let resolvedFilePaths = [];
    let resolvedFiles = [];

    if (task.working_directory) {
      try {
        const resolution = resolveFileReferences(task.task_description, task.working_directory);
        const resolved = Array.isArray(resolution?.resolved) ? resolution.resolved : [];
        if (resolved.length > 0) {
          resolvedFilePaths = resolved.map(r => r.actual);
          resolvedFiles = resolved;
          if (currentProvider !== 'ollama' && currentProvider !== 'codex') {
            resolvedFileContext = await buildFileContext(resolved, task.working_directory, 30000, task.task_description);
          }
          logger.info(`[FileResolve] Pre-resolved ${resolved.length} file(s) for task ${taskId}`);
        }
      } catch (err) {
        logger.info(`[FileResolve] Non-fatal error for task ${taskId}: ${err.message}`);
      }
    }

    const isSandboxed = SANDBOXED_PROVIDERS.has(currentProvider);
    if (resolvedFilePaths.length > 0) {
      const wd = task.working_directory || '';
      for (const filePath of resolvedFilePaths) {
        try {
          const lockResult = db.acquireFileLock(filePath, wd, taskId);
          if (lockResult.acquired) {
            acquiredFileLocks.push({ filePath, workingDirectory: wd });
            continue;
          }

          if (isSandboxed) {
            logger.info(`[FileLock] Task ${taskId.slice(0,8)} (${currentProvider}): file '${filePath}' locked by task ${lockResult.lockedBy?.slice(0,8) || 'unknown'} - requeuing to prevent sandbox conflict`);
            releaseAcquiredFileLocks();
            db.requeueTaskAfterAttemptedStart(taskId, {
              error_output: (task.error_output || '') + `\nRequeued: file '${filePath}' is being edited by task ${lockResult.lockedBy || 'unknown'}. Will retry when the lock is released.`,
            });
            dashboard.notifyTaskUpdated(taskId);
            processQueue();
            return {
              earlyResult: {
                queued: true,
                fileLockConflict: true,
                conflictFile: filePath,
                conflictTask: lockResult.lockedBy,
              },
            };
          }

          logger.warn(`[FileLock] Task ${taskId.slice(0,8)}: file '${filePath}' already locked by task ${lockResult.lockedBy?.slice(0,8) || 'unknown'} - proceeding (non-sandboxed provider)`);
        } catch (err) {
          logger.info(`[FileLock] Non-fatal lock error for ${filePath}: ${err.message}`);
        }
      }
    }

    return {
      earlyResult: null,
      resolvedFileContext,
      resolvedFilePaths,
      resolvedFiles,
    };
  }

  return {
    claimSlot,
    resolveAndLockFiles,
    releaseAcquiredFileLocks,
    releaseOnStartupFailure,
    releaseForPolicyBlock,
    get acquiredFileLocks() { return acquiredFileLocks.slice(); },
  };
}

function evaluateClaimedStartupPolicy({
  task,
  taskId,
  provider,
  evaluatePolicy,
  describePolicyBlock,
  cancelBlockedTask,
  updateTaskStatus,
  notifyTaskUpdated,
  drainQueue,
  getTask,
  resourceLifecycle,
  log,
}) {
  const preExecutePolicyResult = evaluatePolicy({
    ...task,
    id: taskId,
    provider,
  });

  if (preExecutePolicyResult?.blocked !== true) {
    return { earlyResult: null };
  }

  const cancelReason = `[Policy] ${describePolicyBlock(preExecutePolicyResult, 'pre-execute')}`;
  try {
    cancelBlockedTask(taskId, cancelReason);
  } catch (cancelErr) {
    log.info(`[Policy] Failed to cancel blocked task ${taskId}: ${cancelErr.message}`);
    updateTaskStatus(taskId, 'cancelled', { error_output: cancelReason });
  }
  resourceLifecycle.releaseForPolicyBlock(cancelReason);
  try { notifyTaskUpdated(taskId); } catch { /* non-critical */ }
  try { drainQueue(); } catch (queueErr) { log.info('Failed to process queue:', queueErr.message); }
  return {
    earlyResult: {
      queued: false,
      blocked: true,
      cancelled: true,
      reason: cancelReason,
      task: getTask(taskId),
    },
  };
}

function loadTaskForStartup(taskId) {
  const currentTask = db.getTask(taskId);
  if (!currentTask) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const task = { ...currentTask };
  if (task.metadata && typeof task.metadata === 'object') {
    task.metadata = { ...task.metadata };
  }
  return task;
}

function prepareStartupPreClaim(task, taskId) {
  const { maxConcurrent, usedEditFormat } = runStartupPreflight({
    task,
    taskId,
    getMaxConcurrent: getEffectiveGlobalMaxConcurrent,
    config: serverConfig,
    metrics: gpuMetrics,
    preflight: runPreflightChecks,
    log: logger,
  });

  const { provider: startupProvider } = resolveStartupProvider({
    task,
    taskId,
    resolveRouting: resolveProviderRouting,
    registry: providerRegistry,
    failInvalidProvider: failTaskForInvalidProvider,
    parseMetadata: parseTaskMetadata,
    patchMetadata: (id, metadata) => db.patchTaskMetadata(id, metadata),
    log: logger,
  });

  propagateRoutingChain({
    task,
    taskId,
    provider: startupProvider,
    parseMetadata: parseTaskMetadata,
    log: logger,
  });

  const startupSafeguards = evaluateStartupSafeguards({
    task,
    taskId,
    provider: startupProvider,
    runSafeguards: runSafeguardPreChecks,
    parseMetadata: parseTaskMetadata,
    classifyTaskType: description => db.classifyTaskType(description),
    estimateContextTokens: getTaskContextTokenEstimate,
  });

  return {
    ...startupSafeguards,
    provider: startupProvider,
    maxConcurrent,
    usedEditFormat,
  };
}

function applyClaimedTaskState(task, claimResult) {
  if (!claimResult.task) {
    return;
  }

  Object.assign(task, claimResult.task);
  if (Object.prototype.hasOwnProperty.call(claimResult.task, 'metadata')) {
    task.metadata = parseTaskMetadata(claimResult.task.metadata);
  }
}

function claimStartupResourcesForTask({
  task,
  taskId,
  provider,
  maxConcurrent,
}) {
  const startupResources = createTaskStartupResourceLifecycle({
    taskId,
    task,
    provider,
    maxConcurrent,
  });
  const resourceClaim = startupResources.claimSlot();
  if (resourceClaim.earlyResult) {
    return { earlyResult: resourceClaim.earlyResult, startupResources };
  }

  applyClaimedTaskState(task, resourceClaim.claimResult);
  return {
    earlyResult: null,
    startupResources,
    claimResult: resourceClaim.claimResult,
    providerConfig: resourceClaim.providerConfig,
  };
}

function requeueIfClaimedProviderDisabled(taskId, provider, providerConfig) {
  if (!providerConfig || providerConfig.enabled) {
    return null;
  }

  logger.info(`[startTask] Provider ${provider} is disabled, re-queuing task ${taskId}`);
  db.requeueTaskAfterAttemptedStart(taskId);
  return { queued: true, task: db.getTask(taskId) };
}

function seedStartupTranscript({
  _taskId,
  taskMetadata,
  transcriptLog,
  runDirManager,
}) {
  const seedTaskId = typeof taskMetadata.transcript_seed_from_task_id === 'string'
    ? taskMetadata.transcript_seed_from_task_id.trim()
    : '';
  const currentTranscriptMessages = transcriptLog.read();
  if (!seedTaskId || currentTranscriptMessages.length !== 0) {
    return;
  }

  const sourceTranscriptLog = createTaskTranscriptLog({ taskId: seedTaskId, runDirManager });
  const seedMessages = sourceTranscriptLog.read();
  const seedValidation = validateTranscript(seedMessages);
  if (!seedValidation.ok) {
    throw new Error(`Transcript seed for task ${seedTaskId} is invalid: ${seedValidation.errors.join('; ')}`);
  }
  if (seedMessages.length > 0) {
    transcriptLog.replace(seedMessages);
  }
}

function applyRunDirectoryState({
  task,
  taskId,
  claimResult,
  taskMetadata,
  runDir,
  transcriptLog,
}) {
  const previousMetadata = parseTaskMetadata(claimResult.task?.metadata);
  const previousRunDir = previousMetadata.run_dir;
  const rewrittenDescription = typeof task.task_description === 'string'
    ? task.task_description.replace(/\$run_dir/g, runDir)
    : task.task_description;
  const nextMetadata = {
    ...taskMetadata,
    run_dir: runDir,
    transcript_path: transcriptLog.filePath,
  };

  task.task_description = rewrittenDescription;
  task.metadata = nextMetadata;
  task.__transcript = transcriptLog;

  if (
    rewrittenDescription !== claimResult.task?.task_description
    || previousRunDir !== runDir
    || previousMetadata.transcript_path !== transcriptLog.filePath
  ) {
    const updatedTask = db.updateTask(taskId, {
      task_description: rewrittenDescription,
      metadata: nextMetadata,
    });
    if (updatedTask) {
      Object.assign(task, updatedTask);
    }
    task.metadata = nextMetadata;
    task.__transcript = transcriptLog;
  }

  return nextMetadata;
}

function prepareStartupRunDirectory({
  task,
  taskId,
  claimResult,
  taskMetadata,
}) {
  const runDirManager = getRunDirManager();
  if (!runDirManager) {
    return { runDir: null, taskMetadata };
  }

  const runDir = runDirManager.openRunDir(taskId);
  const transcriptLog = createTaskTranscriptLog({ taskId, runDir, runDirManager });
  seedStartupTranscript({ _taskId: taskId, taskMetadata, transcriptLog, runDirManager });
  return {
    runDir,
    taskMetadata: applyRunDirectoryState({
      task,
      taskId,
      claimResult,
      taskMetadata,
      runDir,
      transcriptLog,
    }),
  };
}

function evaluateClaimedPolicyForStartup({
  task,
  taskId,
  provider,
  startupResources,
}) {
  const policyResult = evaluateClaimedStartupPolicy({
    task,
    taskId,
    provider,
    evaluatePolicy: evaluateTaskPreExecutePolicy,
    describePolicyBlock: getPolicyBlockReason,
    cancelBlockedTask: cancelTask,
    updateTaskStatus: safeUpdateTaskStatus,
    notifyTaskUpdated: id => dashboard.notifyTaskUpdated(id),
    drainQueue: processQueue,
    getTask: id => db.getTask(id),
    resourceLifecycle: startupResources,
    log: logger,
  });
  return policyResult.earlyResult || null;
}

async function buildStartupExecutionTask(task, taskId) {
  const executionDescription = await buildExecutionDescriptionWithMentions(task, taskId);
  return executionDescription === task.task_description
    ? task
    : { ...task, execution_description: executionDescription };
}

function prepareOllamaExecutionTask(task, taskId, executionTask) {
  const resolvedOllamaModel = resolveRunnableOllamaModel(task);
  if (resolvedOllamaModel && task.model !== resolvedOllamaModel) {
    const updatedTask = db.updateTaskStatus(taskId, 'running', {
      model: resolvedOllamaModel,
    });
    if (updatedTask) {
      Object.assign(task, updatedTask);
    } else {
      task.model = resolvedOllamaModel;
    }
  }
  if (executionTask !== task) {
    executionTask.model = task.model;
  }
}

function claimCodexFallbackSlot(taskId, maxConcurrent, codexConfig) {
  const codexSlotLimits = getProviderSlotLimits('codex', codexConfig);
  return db.tryClaimTaskSlot(
    taskId,
    maxConcurrent,
    QUEUE_LOCK_HOLDER_ID,
    'codex',
    codexSlotLimits.providerLimit,
    codexSlotLimits.providerGroup,
    codexSlotLimits.categoryLimit,
    codexSlotLimits.categoryProviderGroup,
  );
}

function fallbackMissingApiProviderToCodex({
  task,
  taskId,
  provider,
  executionTask,
  taskMetadata,
  maxConcurrent,
  startupResources,
}) {
  const originalProvider = provider;
  const errorMessage = `Provider "${originalProvider}" has no registered instance`;
  if (taskMetadata.user_provider_override) {
    logger.error(`[startTask] ${errorMessage}`);
    failTaskForInvalidProvider(taskId, originalProvider, errorMessage);
    throw new Error(errorMessage);
  }

  const providerSwitchedAt = new Date().toISOString();
  logger.warn(`[startTask] No provider instance for "${originalProvider}" — falling back to codex for task ${taskId}`);

  const codexConfig = db.getProvider('codex');
  if (!codexConfig?.enabled) {
    logger.error(`[startTask] Codex provider is not enabled — cannot fall back from "${originalProvider}" for task ${taskId}`);
    failTaskForInvalidProvider(taskId, originalProvider, `${errorMessage} and codex fallback is disabled`);
    throw new Error(`${errorMessage} and codex fallback is disabled`);
  }

  const codexClaim = claimCodexFallbackSlot(taskId, maxConcurrent, codexConfig);
  if (!codexClaim.success) {
    logger.warn(`[startTask] Codex at capacity — re-queuing task ${taskId} (was falling back from "${originalProvider}")`);
    startupResources.releaseAcquiredFileLocks();
    db.requeueTaskAfterAttemptedStart(taskId, { provider: null });
    return {
      completed: true,
      value: { queued: true, task: db.getTask(taskId) },
    };
  }

  const updatedTask = db.updateTaskStatus(taskId, 'running', {
    provider: 'codex',
    model: null,
    provider_switched_at: providerSwitchedAt,
    _provider_switch_reason: `${originalProvider} -> codex (missing instance)`,
  });

  if (updatedTask) {
    Object.assign(task, updatedTask);
  } else {
    task.provider = 'codex';
    task.model = null;
  }
  if (executionTask !== task) {
    executionTask.provider = task.provider;
    executionTask.model = task.model;
  }

  return {
    completed: false,
    provider: 'codex',
    providerConfig: codexConfig,
    executionTask,
  };
}

function prepareApiProviderExecution({
  task,
  taskId,
  provider,
  executionTask,
  taskMetadata,
  maxConcurrent,
  startupResources,
}) {
  const instance = providerRegistry.getProviderInstance(provider);
  if (instance) {
    return {
      completed: true,
      value: executeApiProvider(executionTask, instance),
    };
  }

  return fallbackMissingApiProviderToCodex({
    task,
    taskId,
    provider,
    executionTask,
    taskMetadata,
    maxConcurrent,
    startupResources,
  });
}

function prepareProviderExecution({
  task,
  taskId,
  provider,
  providerConfig,
  executionTask,
  taskMetadata,
  maxConcurrent,
  startupResources,
}) {
  if (provider === 'ollama') {
    prepareOllamaExecutionTask(task, taskId, executionTask);
    return { completed: false, provider, providerConfig, executionTask };
  }

  if (providerRegistry.isApiProvider(provider)) {
    return prepareApiProviderExecution({
      task,
      taskId,
      provider,
      executionTask,
      taskMetadata,
      maxConcurrent,
      startupResources,
    });
  }

  return { completed: false, provider, providerConfig, executionTask };
}

async function constructStartupCommand({
  taskId,
  task,
  provider,
  providerConfig,
  executionTask,
  resolvedFileContext,
  resolvedFiles,
  runDir,
  taskMetadata,
  usedEditFormat,
  taskType,
  contextTokenEstimate,
}) {
  return buildProviderStartupCommand({
    taskId,
    task,
    provider,
    providerConfig,
    executionTask,
    resolvedFileContext,
    resolvedFiles,
    runDir,
    taskMetadata,
    usedEditFormat,
    taskType,
    contextTokenEstimate,
  });
}

function spawnStartupProcess(taskId, task, startupCommand) {
  const { mode: _mode, ...spawnConfig } = startupCommand;
  return spawnAndTrackProcess(taskId, task, spawnConfig);
}

function executeStartupCommand(taskId, task, provider, startupCommand) {
  if (startupCommand.mode === 'ollama') {
    return executeOllamaTask(startupCommand.executionTask);
  }

  recordTaskStartedAuditEvent(task, taskId, provider);
  return spawnStartupProcess(taskId, task, startupCommand);
}

function cleanupFailedStartupResources(startupResources, err) {
  startupResources.releaseOnStartupFailure(err);
}

// ── startTask ──────────────────────────────────────────────────────────────

/**
 * Start a task - spawns a Codex process
 * @param {string} taskId - Task ID to start
 * @returns {{ queued: boolean, task?: Object, rateLimited?: boolean, retryAfter?: number }}
 */
async function startTask(taskId) {
  const task = loadTaskForStartup(taskId);
  if (task.status === 'running') {
    logger.info(`Task already running: ${taskId}, skipping duplicate start`);
    return { queued: false, alreadyRunning: true };
  }

  const preClaim = prepareStartupPreClaim(task, taskId);
  if (preClaim.earlyResult) return preClaim.earlyResult;

  let { provider, taskMetadata } = preClaim;
  const claimed = claimStartupResourcesForTask({
    task,
    taskId,
    provider,
    maxConcurrent: preClaim.maxConcurrent,
  });
  if (claimed.earlyResult) return claimed.earlyResult;

  let { providerConfig } = claimed;

  try {
    const unavailable = requeueIfClaimedProviderDisabled(taskId, provider, providerConfig);
    if (unavailable) return unavailable;

    const runContext = prepareStartupRunDirectory({
      task,
      taskId,
      claimResult: claimed.claimResult,
      taskMetadata,
    });
    taskMetadata = runContext.taskMetadata;

    const fileResources = await claimed.startupResources.resolveAndLockFiles(provider);
    if (fileResources.earlyResult) return fileResources.earlyResult;

    const blocked = evaluateClaimedPolicyForStartup({
      task,
      taskId,
      provider,
      startupResources: claimed.startupResources,
    });
    if (blocked) return blocked;

    let executionTask = await buildStartupExecutionTask(task, taskId);
    const providerExecution = prepareProviderExecution({
      task,
      taskId,
      provider,
      providerConfig,
      executionTask,
      taskMetadata,
      maxConcurrent: preClaim.maxConcurrent,
      startupResources: claimed.startupResources,
    });
    if (providerExecution.completed) return providerExecution.value;

    provider = providerExecution.provider;
    providerConfig = providerExecution.providerConfig;
    executionTask = providerExecution.executionTask;

    const startupCommand = await constructStartupCommand({
      taskId,
      task,
      provider,
      providerConfig,
      executionTask,
      resolvedFileContext: fileResources.resolvedFileContext,
      resolvedFiles: fileResources.resolvedFiles,
      runDir: runContext.runDir,
      taskMetadata,
      usedEditFormat: preClaim.usedEditFormat,
      taskType: preClaim.taskType,
      contextTokenEstimate: preClaim.contextTokenEstimate,
    });

    return executeStartupCommand(taskId, task, provider, startupCommand);
  } catch (err) {
    cleanupFailedStartupResources(claimed.startupResources, err);
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
 * @returns {{ started: boolean, queued: boolean, pendingAsync: boolean, failed?: boolean, reason?: string, code?: string, error?: string }}
 */
function markPreflightFailed(taskId, err) {
  const fields = {
    error_output: err.message,
    pid: null,
    mcp_instance_id: null,
    ollama_host_id: null,
  };
  const update = typeof safeUpdateTaskStatus === 'function'
    ? safeUpdateTaskStatus
    : db.updateTaskStatus.bind(db);
  update(taskId, 'failed', fields);
  try { dashboard.notifyTaskUpdated(taskId); } catch { /* ignore */ }
  return {
    started: false,
    queued: false,
    pendingAsync: false,
    failed: true,
    reason: 'preflight_failed',
    code: err.code || 'PREFLIGHT_FAILED',
    deterministic: true,
    error: err.message,
  };
}

function handleTaskStartFailure(taskId, label, err) {
  logger.error(`processQueue: failed to start ${label} task ${taskId}`, { error: err.message });
  if (isPreflightError(err)) {
    if (err.deterministic) {
      return markPreflightFailed(taskId, err);
    }
    return {
      started: false,
      queued: false,
      pendingAsync: false,
      failed: true,
      reason: 'preflight_failed',
      code: err.code || 'PREFLIGHT_FAILED',
      deterministic: false,
      error: err.message,
    };
  }
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

function attemptTaskStart(taskId, label) {
  try {
    const task = db.getTask(taskId);
    if (task) {
      runPreflightChecks(task);
    }
    const maybePromise = startTask(taskId);
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch((asyncErr) => {
        logger.error(`processQueue: async failure for ${label} task ${taskId}`, { error: asyncErr.message });
        if (isPreflightError(asyncErr) && asyncErr.deterministic) {
          try {
            markPreflightFailed(taskId, asyncErr);
            return;
          } catch (preflightErr) {
            logger.info(`processQueue: failed to mark preflight failure for ${taskId.slice(0, 8)}: ${preflightErr.message}`);
          }
        }
        try {
          const t = db.getTask(taskId);
          if (t && t.status === 'running' && !t.pid) {
            safeUpdateTaskStatus(taskId, 'failed', {
              error_output: asyncErr.message,
              pid: null,
              mcp_instance_id: null,
              ollama_host_id: null,
            });
            try { dashboard.notifyTaskUpdated(taskId); } catch { /* ignore */ }
            try { processQueue(); } catch { /* ignore */ }
          }
        } catch (revertErr) {
          logger.info(`processQueue: failed to revert async-start task ${taskId.slice(0, 8)}: ${revertErr.message}`);
        }
      });
      return { started: false, queued: false, pendingAsync: true };
    }
    if (maybePromise && typeof maybePromise === 'object' && maybePromise.queued === true) {
      return { started: false, queued: true, pendingAsync: false };
    }
    return { started: true, queued: false, pendingAsync: false };
  } catch (err) {
    return handleTaskStartFailure(taskId, label, err);
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
  createTaskStartupResourceLifecycle,
  evaluateClaimedStartupPolicy,
  buildProviderStartupCommand,
  buildProviderStartupEnv,
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
