/**
 * providers/execute-cli.js — CLI builders for claude-cli and codex
 * Extracted from providers/execution.js Phase decomposition
 *
 * Contains buildClaudeCliCommand, buildCodexCommand, spawnAndTrackProcess.
 * Uses init() dependency injection for database, dashboard, and task-manager internals.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const logger = require('../logger').child({ component: 'execute-cli' });
const { PROVIDER_DEFAULTS, COMPLETION_GRACE_MS, COMPLETION_GRACE_CODEX_MS } = require('../constants');
const { extractModifiedFiles } = require('../utils/file-resolution');
const { redactCommandArgs, redactSecrets } = require('../utils/sanitize');
const gitWorktree = require('../utils/git-worktree');
const { safeGitExec } = require('../utils/git');
const { buildSafeEnv } = require('../utils/safe-env');
const serverConfig = require('../config');
const { applyStudyContextPrompt } = require('../integrations/codebase-study-engine');
const { resolveCodexNativeBinary } = require('../execution/codex-native-resolve');

// Subprocess exit-code sentinels for cases where there is no real exit code
// (the subprocess either never ran, was torn down before tracking, or the
// close handler itself threw). Distinct values let the classifier in
// fallback-retry.js produce a specific reason instead of the generic
// "Unknown error" fallthrough. Negative values don't collide with real exit
// codes (0..255 on POSIX, up to ~4 billion on Windows).
const EXIT_SPAWN_INSTANT_EXIT = -101;   // proc entry gone but task row still running
const EXIT_CLOSE_HANDLER_EXCEPTION = -102; // close handler itself threw
const EXIT_SPAWN_ERROR = -103;          // child.on('error') fired (ENOENT, EACCES, etc.)

/**
 * Extract unified diffs from codex's stderr output.
 * Codex writes "file update:\ndiff --git a/... b/...\n..." blocks.
 * Returns an array of complete unified diff strings ready for `git apply`.
 */
function extractCodexDiffs(output) {
  if (!output || typeof output !== 'string') return [];
  const diffs = [];
  // Match "diff --git" blocks — each one ends at the next "diff --git", "exec\n", "codex\n", "tokens used", or end of string
  const regex = /diff --git [^\n]+\n(?:(?!diff --git |^exec\n|^codex\n|^tokens used)[\s\S])*?(?=\ndiff --git |\nexec\n|\ncodex\n|\ntokens used|\n\n[A-Z]|\s*$)/gm;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const diff = match[0].trim();
    if (diff && diff.includes('@@')) {
      diffs.push(diff + '\n');
    }
  }
  // Deduplicate — codex sometimes emits the same diff twice
  const seen = new Set();
  return diffs.filter(d => {
    const key = d.slice(0, 200);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Dependency injection
let db = null;
let dashboard = null;
let runningProcesses = null;
let _tryReserveHostSlotWithFallback = null;
let _markTaskCleanedUp = null;
let _tryOllamaCloudFallback = null;
let _shellEscape = null;
let _processQueue = null;
let _isLargeModelBlockedOnHost = null;
let _finalizeTask = null;
let _helpers = {};
let _NVM_NODE_PATH = null;
let _QUEUE_LOCK_HOLDER_ID = '';
let _MAX_OUTPUT_BUFFER = 10 * 1024 * 1024;
let _pendingRetryTimeouts = new Map();
let _taskCleanupGuard = new Map();

let stallRecoveryAttempts = new Map();

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 */
function init(deps) {
  if (deps.db) db = deps.db;
  if (deps.db) serverConfig.init({ db: deps.db });
  if (deps.dashboard) dashboard = deps.dashboard;
  if (deps.runningProcesses) runningProcesses = deps.runningProcesses;
  if (deps.tryReserveHostSlotWithFallback) _tryReserveHostSlotWithFallback = deps.tryReserveHostSlotWithFallback;
  if (deps.markTaskCleanedUp) _markTaskCleanedUp = deps.markTaskCleanedUp;
  if (deps.tryOllamaCloudFallback) _tryOllamaCloudFallback = deps.tryOllamaCloudFallback;
  if (deps.shellEscape) _shellEscape = deps.shellEscape;
  if (deps.processQueue) _processQueue = deps.processQueue;
  if (deps.isLargeModelBlockedOnHost) _isLargeModelBlockedOnHost = deps.isLargeModelBlockedOnHost;
  if (deps.finalizeTask) _finalizeTask = deps.finalizeTask;
  if (deps.helpers) _helpers = deps.helpers;
  if (deps.NVM_NODE_PATH !== undefined) _NVM_NODE_PATH = deps.NVM_NODE_PATH;
  if (deps.QUEUE_LOCK_HOLDER_ID) _QUEUE_LOCK_HOLDER_ID = deps.QUEUE_LOCK_HOLDER_ID;
  if (deps.MAX_OUTPUT_BUFFER) _MAX_OUTPUT_BUFFER = deps.MAX_OUTPUT_BUFFER;
  if (deps.pendingRetryTimeouts) _pendingRetryTimeouts = deps.pendingRetryTimeouts;
  if (deps.taskCleanupGuard) _taskCleanupGuard = deps.taskCleanupGuard;
  if (deps.stallRecoveryAttempts) stallRecoveryAttempts = deps.stallRecoveryAttempts;

}

// Proxy helpers
function markTaskCleanedUp(...args) { if (!_markTaskCleanedUp) throw new Error('execute-cli not initialized'); return _markTaskCleanedUp(...args); }
function processQueue(...args) { return _processQueue ? _processQueue(...args) : undefined; }
function finalizeTask(...args) { if (!_finalizeTask) throw new Error('execute-cli not initialized'); return _finalizeTask(...args); }

/**
 * Build claude-cli command specification.
 * @param {Object} task - Full task object
 * @param {string} resolvedFileContext - Pre-resolved file context string
 * @param {Object} providerConfig - Provider config from DB
 * @returns {{ cliPath, finalArgs, stdinPrompt, envExtras, selectedOllamaHostId, usedEditFormat }}
 */
function buildClaudeCliCommand(task, resolvedFileContext, providerConfig) {
    const effectiveTaskDescription = applyStudyContextPrompt(task.task_description, task.metadata);
    const wrappedDescription = _helpers.wrapWithInstructions(
      effectiveTaskDescription,
      'claude-cli',
      null,
      { files: task.files, project: task.project, fileContext: resolvedFileContext }
    );
    // Flags for non-interactive autonomous execution:
    // --dangerously-skip-permissions: auto-approve all file writes and commands
    // --disable-slash-commands: prevent model from invoking slash commands
    // --strict-mcp-config: only use explicitly configured MCP servers
    // --bare: skip hooks, CLAUDE.md, plugins for faster deterministic startup
    // --output-format json: structured output for programmatic parsing
    // --max-turns 15: limit agentic iterations (matches TORQUE agentic_max_iterations)
    // -p: print mode (non-interactive, output to stdout)
    const claudeArgs = [
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--bare',                    // Skip hooks, CLAUDE.md, plugins for faster deterministic startup
      '--output-format', 'json',   // Structured JSON output for programmatic parsing
      '--max-turns', '15',         // Limit agentic iterations (matches TORQUE default)
      '-p'
    ];
    const stdinPrompt = wrappedDescription;

    let cliPath;
    if (providerConfig && providerConfig.cli_path) {
      cliPath = providerConfig.cli_path;
      if (process.platform === 'win32' && !path.extname(cliPath)) {
        cliPath = cliPath + '.cmd';
      }
    } else if (process.platform === 'win32') {
      cliPath = 'claude.cmd';
    } else {
      cliPath = 'claude';
    }

    return { cliPath, finalArgs: claudeArgs, stdinPrompt, envExtras: {}, selectedOllamaHostId: null, usedEditFormat: null };
}

/**
 * Build codex command specification.
 *
 * NOTE: This function is intentionally distinct from the one in
 * server/execution/command-builders.js. The two have different argument
 * order and different behaviour:
 *   - execute-cli.js  (task, resolvedFileContext, providerConfig, opts)
 *     → simple "wrap with instructions" path; used for legacy/direct CLI
 *       invocations and re-exported via execution.js for backward compat.
 *   - command-builders.js (task, providerConfig, resolvedFileContext, resolvedFiles)
 *     → enriched-prompt path used by task-manager.js at runtime.
 * Do NOT deduplicate without also updating every call-site signature.
 *
 * @param {Object} task - Full task object
 * @param {string} resolvedFileContext - Pre-resolved file context string
 * @param {Object} providerConfig - Provider config from DB
 * @param {Object} [opts] - Optional overrides
 * @param {string} [opts.workingDirectoryOverride] - Override working directory (e.g., worktree path)
 * @returns {{ cliPath, finalArgs, stdinPrompt, envExtras, selectedOllamaHostId, usedEditFormat }}
 */
function buildCodexCommand(task, resolvedFileContext, providerConfig, opts = {}) {
    logger.info(`[BuildCodex PATH=PROVIDERS/EXECUTE-CLI] entered for task ${task && task.id ? String(task.id).slice(0,8) : '<no-id>'} platform=${process.platform} hasProviderConfigCliPath=${Boolean(providerConfig && providerConfig.cli_path)}`);
    const effectiveTaskDescription = applyStudyContextPrompt(task.task_description, task.metadata);
    const wrappedDescription = _helpers.wrapWithInstructions(
      effectiveTaskDescription,
      'codex',
      null,
      {
        files: task.files,
        project: task.project,
        fileContext: resolvedFileContext,
        workingDirectory: opts.workingDirectoryOverride || task.working_directory,
      }
    );
    const codexArgs = ['exec'];

    codexArgs.push('--skip-git-repo-check');

    // JSON output for structured event parsing (file changes, progress, errors)
    codexArgs.push('--json');

    // Only pass -m when user specified a real model name.
    // Skip when model matches the provider name — let the CLI use its own default.
    if (task.model && task.model !== 'codex') {
      codexArgs.push('-m', task.model);
    }

    if (task.auto_approve) {
      codexArgs.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      codexArgs.push('--full-auto');
    }

    // Factory-internal Codex prompts (Architect, scout, plan-gen, etc.) are
    // template-driven structured-output tasks. The user's default Codex
    // reasoning_effort (often "xhigh") burns the whole timeout window on
    // reasoning before emitting any output, producing silent stalls. Override
    // to "high" for these — still strong reasoning, but actually emits the
    // structured response within the window. Real code-execute work-item
    // tasks aren't submitted via submitFactoryInternalTask, so they keep
    // whatever the user configured globally in ~/.codex/config.toml.
    const taskMetadata = (() => {
      if (!task.metadata) return null;
      if (typeof task.metadata === 'object') return task.metadata;
      try { return JSON.parse(task.metadata); } catch { return null; }
    })();
    // Scout tasks (mode:'scout') hit the same xhigh-default trap as
    // factory_internal — observed live 2026-05-02 on torque-public
    // starvation-recovery scouts that ran 30 minutes with zero output.
    const isFactoryInternal = taskMetadata && taskMetadata.factory_internal === true;
    const isFactoryScout = taskMetadata && taskMetadata.mode === 'scout';
    const factoryKind = typeof taskMetadata?.kind === 'string' ? taskMetadata.kind : null;
    const lowReasoningFactoryKinds = new Set([
      'plan_quality_review',
      'replan_rewrite',
      'verify_review',
    ]);
    if (isFactoryInternal || isFactoryScout) {
      const effort = lowReasoningFactoryKinds.has(factoryKind) ? 'low' : 'high';
      codexArgs.push('-c', `model_reasoning_effort=${effort}`);
    }

    // Use worktree path if provided, otherwise use original working directory
    const effectiveWorkDir = opts.workingDirectoryOverride || task.working_directory;
    if (effectiveWorkDir) {
      codexArgs.push('-C', effectiveWorkDir);
    }

    codexArgs.push('-');
    const stdinPrompt = wrappedDescription;

    let cliPath;
    let finalArgs;
    const envExtras = {};
    if (providerConfig && providerConfig.cli_path) {
      cliPath = providerConfig.cli_path;
      // Prefer the bundled native codex.exe when the configured cli_path is
      // a bare name (e.g. "codex" or "codex.cmd"). Absolute paths are
      // honored as-is — user chose a specific binary deliberately.
      if (process.platform === 'win32' && !path.isAbsolute(cliPath)) {
        const native = resolveCodexNativeBinary();
        logger.info(`[BuildCodex EXECUTE-CLI cli_path-branch] cli_path=${JSON.stringify(cliPath)} native-resolve=${native ? 'OK' : 'NULL'}`);
        if (native) {
          cliPath = native.binaryPath;
          finalArgs = codexArgs;
          envExtras.__TORQUE_CODEX_VENDOR_PATH = native.vendorPathDir || '';
          envExtras.CODEX_MANAGED_BY_NPM = '1';
        } else {
          if (!path.extname(cliPath)) {
            cliPath = cliPath + '.cmd';
          }
          finalArgs = codexArgs;
        }
      } else {
        finalArgs = codexArgs;
      }
    } else if (process.platform === 'win32') {
      // Prefer launching the bundled native codex.exe directly. The `codex.cmd`
      // shim invokes `node codex.js` which spawns `codex.exe` which spawns a
      // visible `pwsh.exe` for the command-safety AST parser. windowsHide:true
      // on our own spawn doesn't propagate through the node wrapper, so every
      // factory task flashes a PowerShell window. Skipping the node layer puts
      // us in the best position to control descendant-window semantics.
      const native = resolveCodexNativeBinary();
      logger.info(`[BuildCodex EXECUTE-CLI] native-resolve result: ${native ? 'OK binary=' + native.binaryPath : 'NULL (will fall back to codex.cmd)'}`);
      if (native) {
        logger.info(`[BuildCodex EXECUTE-CLI] RETURN native path. cliPath=${native.binaryPath}`);
        cliPath = native.binaryPath;
        finalArgs = codexArgs;
        envExtras.__TORQUE_CODEX_VENDOR_PATH = native.vendorPathDir || '';
        envExtras.CODEX_MANAGED_BY_NPM = '1';
      } else {
        logger.info('[BuildCodex EXECUTE-CLI] RETURN codex.cmd fallback');
        cliPath = 'codex.cmd';
        finalArgs = codexArgs;
      }
    } else if (_NVM_NODE_PATH) {
      cliPath = path.join(_NVM_NODE_PATH, 'node');
      finalArgs = [path.join(_NVM_NODE_PATH, 'codex'), ...codexArgs];
    } else {
      cliPath = 'codex';
      finalArgs = codexArgs;
    }

    logger.info(`[BuildCodex EXECUTE-CLI] EXIT final cliPath=${cliPath}`);
    return { cliPath, finalArgs, stdinPrompt, envExtras, selectedOllamaHostId: null, usedEditFormat: null };
}

/**
 * Spawn a CLI process and manage its lifecycle (stdout/stderr/close/error handlers).
 * Unified handler for claude-cli and codex providers.
 *
 * @param {string} taskId - Task ID
 * @param {Object} task - Full task object
 * @param {Object} cmdSpec - Command specification from builder function
 * @param {string} provider - Provider name
 * @returns {{ queued: boolean, task: Object }}
 */
function spawnAndTrackProcess(taskId, task, cmdSpec, provider) {
  let { cliPath, finalArgs, stdinPrompt, envExtras, selectedOllamaHostId, usedEditFormat } = cmdSpec;

  // --- Worktree isolation ---
  // Codex exec mode persists file writes directly to the -C directory.
  // Worktree isolation is DISABLED for codex because:
  // 1. codex exec --full-auto already persists changes to disk
  // 2. The sandbox reverts writes in worktrees on exit (sandbox cleanup)
  // 3. mergeWorktreeChanges then sees 0 changes → all work is lost
  // Worktree isolation remains available for non-codex CLI providers if needed.
  let worktreeInfo = null;
  const isCodexProvider = (provider === 'codex' || provider === 'codex-spark');
  const worktreeIsolationEnabled = !isCodexProvider
    && task.working_directory
    && gitWorktree.isGitRepo(task.working_directory)
    && serverConfig.get('cli_worktree_isolation') === '1';

  if (worktreeIsolationEnabled) {
    worktreeInfo = gitWorktree.createWorktree(taskId, task.working_directory);
    if (worktreeInfo) {
      const dashCIndex = finalArgs.indexOf('-C');
      if (dashCIndex !== -1 && dashCIndex + 1 < finalArgs.length) {
        finalArgs[dashCIndex + 1] = worktreeInfo.worktreePath;
      }
      logger.info(`[TaskManager] Task ${taskId} using worktree isolation at ${worktreeInfo.worktreePath}`);
    } else {
      logger.info(`[TaskManager] Worktree creation failed for task ${taskId} — falling back to direct execution`);
    }
  }

  // Ensure nvm node path is in PATH if available
  const envPath = process.env.PATH || '';
  let updatedPath = (_NVM_NODE_PATH && !envPath.includes(_NVM_NODE_PATH))
    ? `${_NVM_NODE_PATH}:${envPath}`
    : envPath;

  // Native Codex launches ship with bundled tools (rg.exe) in a vendor `path/`
  // dir that the npm shim normally prepends to PATH. Mirror that when we
  // bypass the shim so the native binary finds its companions. Marker is
  // stripped from envExtras so it never reaches the child process directly.
  const nativeVendorPath = envExtras ? envExtras.__TORQUE_CODEX_VENDOR_PATH : '';
  if (envExtras && '__TORQUE_CODEX_VENDOR_PATH' in envExtras) {
    delete envExtras.__TORQUE_CODEX_VENDOR_PATH;
  }
  if (nativeVendorPath && !updatedPath.split(path.delimiter).includes(nativeVendorPath)) {
    updatedPath = `${nativeVendorPath}${path.delimiter}${updatedPath}`;
  }

  // SECURITY: Set GIT_CEILING_DIRECTORIES to prevent git from traversing above
  // the working directory. For worktree-isolated Codex tasks, this limits git
  // to the worktree; for others, it limits to the task working directory.
  const gitCeiling = worktreeInfo
    ? path.dirname(worktreeInfo.worktreePath)
    : (task.working_directory ? path.dirname(task.working_directory) : undefined);

  // Build environment variables — SECURITY: only pass safe env vars + provider-specific keys
  const envVars = buildSafeEnv(provider, {
    PATH: updatedPath,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    CI: '1',
    CODEX_NON_INTERACTIVE: '1',
    CLAUDE_NON_INTERACTIVE: '1',
    TORQUE_TASK_ID: taskId,
    TORQUE_WORKFLOW_ID: task.workflow_id || '',
    TORQUE_WORKFLOW_NODE_ID: task.workflow_node_id || '',
    GIT_TERMINAL_PROMPT: '0',
    // Force LF line endings on all platforms — prevents CRLF commits from Windows Codex tasks
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.autocrlf',
    GIT_CONFIG_VALUE_0: 'input',
    PYTHONIOENCODING: 'utf-8',
    ...(gitCeiling ? { GIT_CEILING_DIRECTORIES: gitCeiling } : {}),
    ...envExtras
  });

  // Resolve Windows .cmd wrappers to underlying node script
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    const resolved = _helpers.resolveWindowsCmdToNode(cliPath);
    if (resolved) {
      logger.info(`[TaskManager] Resolved ${cliPath} → node ${resolved.scriptPath}`);
      cliPath = resolved.nodePath;
      finalArgs = [resolved.scriptPath, ...finalArgs];
    } else {
      logger.info(`[TaskManager] WARNING: Could not resolve ${cliPath} to node script — falling back to cmd.exe`);
      finalArgs = ['/c', cliPath, ...finalArgs];
      cliPath = 'cmd.exe';
    }
  }

  // When using worktree isolation, the cwd should be the worktree path
  // so that any relative path operations by the process also stay inside it
  const effectiveCwd = worktreeInfo
    ? worktreeInfo.worktreePath
    : (task.working_directory || process.cwd());

  const options = {
    cwd: effectiveCwd,
    env: envVars,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,  // Prevent visible console windows on Windows
  };

  // Capture baseline HEAD SHA before spawning
  let baselineCommit = null;
  try {
    const { execFileSync } = require('child_process');
    baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: options.cwd, encoding: 'utf-8', timeout: 15000, windowsHide: true
    }).trim();
  } catch (e) {
    logger.info(`[TaskManager] Could not capture baseline HEAD for task ${taskId}: ${e.message}`);
  }

  // Debug: log the actual command being executed (redact prompt-bearing args)
  logger.info(`[TaskManager] Spawning: ${cliPath} ${redactCommandArgs(finalArgs).join(' ')}`);
  logger.info(`[TaskManager] Provider: ${provider}, Working dir: ${options.cwd}`);

  // SECURITY NOTE: spawn() uses streaming stdio, not buffered exec/execFile, so
  // maxBuffer is not applicable. Process output is capped at _MAX_OUTPUT_BUFFER
  // (10 MB) in the stdout/stderr 'data' handlers below — any excess is truncated
  // to the trailing half of the buffer. This prevents runaway child processes from
  // consuming unbounded memory in the TORQUE server process.

  // Spawn the process
  const child = spawn(cliPath, finalArgs, options);

  // CRITICAL: Attach error listener IMMEDIATELY after spawn to prevent
  // unhandled 'error' events (e.g., ENOENT) from crashing the process.
  // The full error handler is defined later — this early listener captures
  // the error so the later handler can process it.
  let earlySpawnError = null;
  child.on('error', (err) => {
    if (!earlySpawnError) earlySpawnError = err;
  });

  // Pipe stdin prompt for claude-cli and codex
  if (child.stdin) {
    child.stdin.on('error', (err) => {
      logger.info(`[TaskManager] stdin error for task ${taskId}: ${err.message}`);
    });
    if (typeof stdinPrompt === 'string' && stdinPrompt.length > 0) {
      child.stdin.write(stdinPrompt);
      logger.info(`[TaskManager] Wrote ${stdinPrompt.length} chars to stdin for task ${taskId}`);
    }
    child.stdin.end();
  }

  // Track the process with timeout handles for cleanup
  const now = Date.now();
  runningProcesses.set(taskId, {
    process: child,
    output: '',
    errorOutput: '',
    startTime: now,
    lastOutputAt: now,
    stallWarned: false,
    timeoutHandle: null,
    startupTimeoutHandle: null,
    streamErrorCount: 0,
    streamErrorWarned: false,
    ollamaHostId: selectedOllamaHostId,
    model: task.model,
    provider: provider,
    editFormat: usedEditFormat,
    completionDetected: false,
    completionGraceHandle: null,
    lastProgress: 0,
    baselineCommit: baselineCommit,
    workingDirectory: options.cwd,
    lastFsFingerprint: null,
    // Worktree isolation state (null when not using worktrees)
    worktreeInfo: worktreeInfo,
    originalWorkingDirectory: worktreeInfo ? task.working_directory : null,
  });

  // Check if spawn actually started
  if (!child.pid) {
    logger.info(`[TaskManager] WARNING: spawn returned no PID for task ${taskId} - process may not have started`);
  }

  // Update task with process ID and host tracking
  db.updateTaskStatus(taskId, 'running', {
    pid: child.pid,
    ollama_host_id: selectedOllamaHostId
  });

  // Detect instant-exit
  setTimeout(() => {
    const proc = runningProcesses.get(taskId);
    if (!proc) {
      const task = db.getTask(taskId);
      if (task && task.status === 'running') {
        logger.info(`[TaskManager] Task ${taskId} process exited instantly but status is still 'running' - marking failed`);
        void finalizeTask(taskId, {
          exitCode: EXIT_SPAWN_INSTANT_EXIT,
          output: task.output || '',
          errorOutput: 'Process exited immediately with no output (possible spawn failure or crash)',
          procState: {
            provider: task.provider || provider,
          },
        }).then((result) => {
          try { dashboard.notifyTaskUpdated(taskId); } catch { /* non-critical */ }
          if (!result?.queueManaged) {
            processQueue();
          }
        }).catch((finalizeErr) => {
          logger.info(`[TaskManager] Instant-exit finalization failed for ${taskId}: ${finalizeErr.message}`);
        });
      }
    }
  }, 2000);

  // Notify dashboard of task start
  dashboard.notifyTaskUpdated(taskId);

  // Get or create stream for this task
  const streamId = db.getOrCreateTaskStream(taskId, 'output');

  // Handle stdout errors
  child.stdout.on('error', (err) => {
    logger.info(`[TaskManager] stdout error for task ${taskId}: ${err.message}`);
  });

  // Handle stdout
  child.stdout.on('data', (data) => {
    const text = data.toString();
    const proc = runningProcesses.get(taskId);
    if (proc) {
      if (proc.startupTimeoutHandle) {
        clearTimeout(proc.startupTimeoutHandle);
        proc.startupTimeoutHandle = null;
      }
      proc.output += text;
      proc.lastOutputAt = Date.now();
      if (proc.output.length > _MAX_OUTPUT_BUFFER) {
        proc.output = '[...truncated...]\n' + proc.output.slice(-_MAX_OUTPUT_BUFFER / 2);
      }
      const progress = _helpers.estimateProgress(proc.output, proc.provider);
      db.updateTaskProgress(taskId, progress, text);

      // Output-based completion detection
      if (!proc.completionDetected && _helpers.detectOutputCompletion(proc.output, proc.provider)) {
        proc.completionDetected = true;
        const graceMs = proc.provider === 'codex' ? COMPLETION_GRACE_CODEX_MS : COMPLETION_GRACE_MS;
        logger.info(`[Completion] Task ${taskId} output indicates work is complete (provider: ${proc.provider}). Starting ${graceMs / 1000}s grace period for natural exit.`);

        const capturedProc = proc;
        proc.completionGraceHandle = setTimeout(() => {
          const stillRunning = runningProcesses.get(taskId);
          if (stillRunning && stillRunning === capturedProc) {
            logger.info(`[Completion] Task ${taskId} process still alive after grace period. Force-completing.`);
            const pid = stillRunning.process.pid;
            if (process.platform === 'win32' && pid) {
              logger.info(`[Completion] Task ${taskId} using taskkill /F /T /PID ${pid}`);
              const { execFile } = require('child_process');
              execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, (err) => {
                if (err) {
                  logger.info(`[Completion] taskkill failed for task ${taskId}: ${err.message}`);
                }
                setTimeout(() => { if (capturedProc && capturedProc.process && !capturedProc.process.killed) capturedProc.process.emit('close', 1, null); }, 1000);
                // RB-013: Emit synthetic close event so the close-phase pipeline
                // handles validation, build checks, and status terminalization.
                // The markTaskCleanedUp guard in the close handler prevents double-fire.
                setTimeout(() => {
                  const yetRunning = runningProcesses.get(taskId);
                  if (yetRunning && yetRunning === capturedProc && yetRunning.completionDetected) {
                    logger.info(`[Completion] Task ${taskId} emitting synthetic close after taskkill.`);
                    capturedProc.process.emit('close', 1, null);
                  }
                }, 2000);
              });
            } else {
              try {
                stillRunning.process.kill('SIGTERM');
              } catch (killErr) {
                if (killErr.code !== 'ESRCH') {
                  logger.info(`[Completion] Failed to SIGTERM task ${taskId}: ${killErr.message}`);
                }
              }
              setTimeout(() => {
                const yetRunning = runningProcesses.get(taskId);
                if (yetRunning) {
                  logger.info(`[Completion] Task ${taskId} SIGTERM ignored, sending SIGKILL.`);
                  try {
                    yetRunning.process.kill('SIGKILL');
                  } catch { /* ignore */ }
                }
              }, 5000);
            }
          }
        }, graceMs);
      }

      // Buffer output chunk for streaming
      try {
        db.addStreamChunk(streamId, text, 'stdout');
        proc.streamErrorCount = 0;
        dashboard.notifyTaskOutput(taskId, text);
      } catch (err) {
        proc.streamErrorCount++;
        logger.info(`Stream chunk error (${proc.streamErrorCount}): ${err.message}`);
        if (proc.streamErrorCount >= 10 && !proc.streamErrorWarned) {
          proc.streamErrorWarned = true;
          logger.info(`WARNING: Task ${taskId} has ${proc.streamErrorCount} consecutive stream errors - output may be incomplete`);
        }
      }

      // Check breakpoints
      const hitBreakpoint = _helpers.checkBreakpoints(taskId, text, 'output');
      if (hitBreakpoint && hitBreakpoint.action === 'pause') {
        _helpers.pauseTaskForDebug(taskId, hitBreakpoint);
      }

      // Handle step mode
      if (proc.stepMode === 'step' && proc.stepRemaining > 0) {
        proc.stepRemaining--;
        if (proc.stepRemaining === 0) {
          _helpers.pauseTask(taskId, 'Step mode complete');
        }
      }
    }
  });

  // Handle stderr errors
  child.stderr.on('error', (err) => {
    logger.info(`[TaskManager] stderr error for task ${taskId}: ${err.message}`);
  });

  // Handle stderr
  child.stderr.on('data', (data) => {
    const text = data.toString();
    const proc = runningProcesses.get(taskId);
    if (proc) {
      if (proc.startupTimeoutHandle) {
        clearTimeout(proc.startupTimeoutHandle);
        proc.startupTimeoutHandle = null;
      }
      proc.errorOutput += text;
      // lastOutputAt is set below after banner filtering
      if (proc.errorOutput.length > _MAX_OUTPUT_BUFFER) {
        proc.errorOutput = '[...truncated...]\n' + proc.errorOutput.slice(-_MAX_OUTPUT_BUFFER / 2);
      }

      // Codex banner filtering — prevent session banner lines from resetting
      // the stall timer (same logic as process-streams.js stderr handler)
      const isCodexBanner = (proc.provider === 'codex') &&
        /^(OpenAI Codex|[-]{4,}|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|\s*$)/m.test(text);
      if (!isCodexBanner) {
        proc.lastOutputAt = Date.now();
      }

      if (proc.provider === 'codex' || proc.provider === 'claude-cli') {
        const combinedOutput = (proc.output || '') + proc.errorOutput;
        const progress = _helpers.estimateProgress(combinedOutput, proc.provider);
        if (progress > (proc.lastProgress || 0)) {
          proc.lastProgress = progress;
          db.updateTaskProgress(taskId, progress, text);
        }

        // Completion detection on stderr — Codex CLI writes its task summary
        // ("Changes made:", "Implemented X", etc.) to stderr, not stdout.
        // Without checking stderr, completion is never detected for Codex tasks.
        if (!proc.completionDetected && _helpers.detectOutputCompletion(combinedOutput, proc.provider)) {
          proc.completionDetected = true;
          const graceMs = proc.provider === 'codex' ? COMPLETION_GRACE_CODEX_MS : COMPLETION_GRACE_MS;
          logger.info(`[Completion] Task ${taskId} stderr indicates work complete (provider: ${proc.provider}). Starting ${graceMs / 1000}s grace period.`);

          const capturedProc = proc;
          proc.completionGraceHandle = setTimeout(() => {
            const stillRunning = runningProcesses.get(taskId);
            if (stillRunning && stillRunning === capturedProc) {
              logger.info(`[Completion] Task ${taskId} still alive after stderr grace period. Force-completing.`);
              const pid = stillRunning.process.pid;
              if (process.platform === 'win32' && pid) {
                const { execFile } = require('child_process');
                execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, (killErr) => {
                  if (killErr) logger.info(`[Completion] taskkill failed for task ${taskId}: ${killErr.message}`);
                  setTimeout(() => { if (capturedProc && capturedProc.process && !capturedProc.process.killed) capturedProc.process.emit('close', 1, null); }, 1000);
                  setTimeout(() => {
                    const yetRunning = runningProcesses.get(taskId);
                    if (yetRunning && yetRunning === capturedProc && yetRunning.completionDetected) {
                      logger.info(`[Completion] Task ${taskId} emitting synthetic close after stderr taskkill.`);
                      capturedProc.process.emit('close', 1, null);
                    }
                  }, 2000);
                });
              } else {
                try { stillRunning.process.kill('SIGTERM'); } catch { /* ESRCH ok */ }
              }
            }
          }, graceMs);
        }
      }

      try {
        const sequence = db.addStreamChunk(streamId, text, 'stderr');
        dashboard.notifyTaskOutput(taskId, {
          content: text,
          type: 'stderr',
          chunk_type: 'stderr',
          sequence,
          sequence_num: sequence,
          isStderr: true,
        });
        proc.streamErrorCount = 0;
      } catch (err) {
        proc.streamErrorCount++;
        logger.info(`Stream chunk error (${proc.streamErrorCount}): ${err.message}`);
        if (proc.streamErrorCount >= 10 && !proc.streamErrorWarned) {
          proc.streamErrorWarned = true;
          logger.info(`WARNING: Task ${taskId} has ${proc.streamErrorCount} consecutive stream errors - output may be incomplete`);
        }
      }

      const hitBreakpoint = _helpers.checkBreakpoints(taskId, text, 'error');
      if (hitBreakpoint && hitBreakpoint.action === 'pause') {
        _helpers.pauseTaskForDebug(taskId, hitBreakpoint);
      }
    }
  });

  // Handle process completion
  let closeEventFired = false;
  let exitSignal = null;
  child.on('exit', (exitCode, signal) => {
    // Capture signal so subprocesses killed by SIGKILL/SIGTERM/etc. are
    // distinguishable from normal non-zero exits in the classifier.
    if (signal) exitSignal = signal;
    setTimeout(() => {
      if (!closeEventFired) {
        logger.info(`[Completion] Task ${taskId}: 'exit' fired (code ${exitCode}${signal ? `, signal ${signal}` : ''}) but 'close' did not — forcing completion`);
        child.emit('close', exitCode, signal);
      }
    }, 5000);
  });

  child.on('close', async (code, signal) => {
    closeEventFired = true;
    const effectiveSignal = signal || exitSignal;
    if (!markTaskCleanedUp(taskId)) {
      return;
    }

    const proc = runningProcesses.get(taskId);
    let queueManaged = false;

    if (proc) {
      if (proc.timeoutHandle) clearTimeout(proc.timeoutHandle);
      if (proc.startupTimeoutHandle) clearTimeout(proc.startupTimeoutHandle);
      if (proc.completionGraceHandle) clearTimeout(proc.completionGraceHandle);

      // Check combined stdout+stderr for completion — Codex writes summaries to stderr
      if (!proc.completionDetected) {
        const combinedOutput = (proc.output || '') + (proc.errorOutput || '');
        if (combinedOutput) {
          proc.completionDetected = _helpers.detectOutputCompletion(combinedOutput, proc.provider);
        }
      }
      if (proc.completionDetected && code !== 0) {
        logger.info(`[Completion] Task ${taskId} exited with code ${code} but output indicated success (provider: ${proc.provider}). Treating as code 0.`);
        code = 0;
      }

      if (proc.ollamaHostId) {
        try {
          db.decrementHostTasks(proc.ollamaHostId);
        } catch (decrementErr) {
          logger.info(`Failed to decrement host tasks for ${proc.ollamaHostId}:`, decrementErr.message);
        }
      }

      // --- Worktree merge/cleanup ---
      // If this task used worktree isolation, merge changes back on success
      // and always clean up the worktree directory.
      if (proc.worktreeInfo) {
        const wt = proc.worktreeInfo;
        const origDir = proc.originalWorkingDirectory;
        try {
          if (code === 0 && origDir) {
            const mergeResult = gitWorktree.mergeWorktreeChanges(wt.worktreePath, origDir, taskId);
            let filesChanged = mergeResult.success ? mergeResult.filesChanged : 0;

            // Codex sandbox reverts file writes on exit, so the worktree often
            // shows 0 changes. Fallback: extract unified diffs from codex's stderr
            // output (the "file update: diff --git ..." blocks) and apply them.
            if (filesChanged === 0 && (proc.errorOutput || '').includes('file update')) {
              logger.info(`[Worktree] Task ${taskId} worktree had 0 changes — extracting diffs from codex output`);
              const diffs = extractCodexDiffs(proc.errorOutput || '');
              if (diffs.length > 0) {
                const { execFileSync } = require('child_process');
                let applied = 0;
                for (const patch of diffs) {
                  try {
                    execFileSync('git', ['apply', '--whitespace=nowarn'], {
                      cwd: origDir, encoding: 'utf-8', timeout: 10000,
                      input: patch, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
                    });
                    applied++;
                  } catch (_e) {
                    // Try with --3way for files that diverged
                    try {
                      execFileSync('git', ['apply', '--3way', '--whitespace=nowarn'], {
                        cwd: origDir, encoding: 'utf-8', timeout: 10000,
                        input: patch, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
                      });
                      applied++;
                    } catch (_e2) {
                      logger.info(`[Worktree] Task ${taskId} failed to apply extracted diff: ${_e2.message?.slice(0, 100)}`);
                    }
                  }
                }
                if (applied > 0) {
                  logger.info(`[Worktree] Task ${taskId} applied ${applied}/${diffs.length} extracted diffs from codex output`);
                  filesChanged = applied;
                }
              }
            }

            if (filesChanged > 0) {
              logger.info(`[Worktree] Task ${taskId} merge complete: ${filesChanged} file(s)`);
              // Auto-commit so the next parallel task's worktree starts from updated HEAD.
              try {
                const { execFileSync } = require('child_process');
                execFileSync('git', ['add', '-A'], {
                  cwd: origDir, encoding: 'utf-8', timeout: 10000,
                  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
                });
                const shortDesc = (task.task_description || '').substring(0, 50).replace(/["\n\r]/g, ' ').trim();
                execFileSync('git', ['commit', '-m', `fix(torque): ${shortDesc} [${task.model || provider}]`], {
                  cwd: origDir, encoding: 'utf-8', timeout: 10000,
                  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
                });
                logger.info(`[Worktree] Task ${taskId} auto-committed merged changes`);
              } catch (commitErr) {
                logger.info(`[Worktree] Task ${taskId} auto-commit failed: ${commitErr.message}`);
              }
            } else if (!mergeResult.success) {
              logger.info(`[Worktree] Task ${taskId} worktree merge failed: ${mergeResult.error}`);
              proc.errorOutput += `\n[Worktree] Merge failed: ${mergeResult.error}`;
            }
          } else {
            logger.info(`[Worktree] Task ${taskId} exited with code ${code} — skipping worktree merge`);
          }
        } catch (mergeErr) {
          logger.info(`[Worktree] Task ${taskId} merge exception: ${mergeErr.message}`);
          proc.errorOutput += `\n[Worktree] Merge exception: ${mergeErr.message}`;
        } finally {
          // Always clean up the worktree
          try {
            gitWorktree.removeWorktree(wt.worktreePath, origDir || task.working_directory, taskId);
          } catch (cleanupErr) {
            logger.info(`[Worktree] Task ${taskId} cleanup exception: ${cleanupErr.message}`);
          }
        }
      }

      // --- Auto-commit for codex exec tasks (no worktree) ---
      // codex exec --full-auto writes directly to the working directory.
      // Auto-commit advances HEAD so parallel tasks see each other's changes.
      if (isCodexProvider && !proc.worktreeInfo && code === 0 && task.working_directory) {
        try {
          const { execFileSync } = require('child_process');
          const workDir = task.working_directory;
          const statusOut = safeGitExec(['status', '--porcelain'], {
            cwd: workDir, encoding: 'utf-8', timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          }).trim();
          if (statusOut) {
            execFileSync('git', ['add', '-A'], {
              cwd: workDir, encoding: 'utf-8', timeout: 10000,
              stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            });
            const shortDesc = (task.task_description || '').substring(0, 50).replace(/["\n\r]/g, ' ').trim();
            execFileSync('git', ['commit', '-m', `fix(torque): ${shortDesc} [${task.model || provider}]`], {
              cwd: workDir, encoding: 'utf-8', timeout: 10000,
              stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            });
            logger.info(`[Codex] Task ${taskId} auto-committed ${statusOut.split('\n').length} changed file(s)`);
          }
        } catch (commitErr) {
          logger.info(`[Codex] Task ${taskId} auto-commit failed: ${commitErr.message}`);
        }
      }

      runningProcesses.delete(taskId);
      stallRecoveryAttempts.delete(taskId);
    }

    try {
      const currentTask = db.getTask(taskId);
      if (currentTask && currentTask.status === 'cancelled') {
        logger.info(`[Completion] Task ${taskId} close handler skipped because task is already cancelled`);
        // Still clean up worktree for cancelled tasks
        if (proc?.worktreeInfo && proc.originalWorkingDirectory) {
          try {
            gitWorktree.removeWorktree(proc.worktreeInfo.worktreePath, proc.originalWorkingDirectory, taskId);
          } catch { /* already cleaned above in most cases */ }
        }
        return;
      }

      if (!proc && currentTask && currentTask.status === 'running') {
        logger.info(`Close handler: proc not found for task ${taskId}, routing through task finalizer`);
      }

      const rawErrorOutput = proc
          ? proc.errorOutput
          : (currentTask?.error_output || 'Process tracking lost - task completed without captured output');
      // Annotate the error output with the signal name when the subprocess
      // was killed by signal (SIGKILL/SIGTERM/etc.) so diagnostics can tell a
      // signal-killed process apart from a genuine non-zero exit.
      const signalSuffix = effectiveSignal
        ? `\n[process-exit] terminated by signal ${effectiveSignal}`
        : '';
      const annotatedErrorOutput = rawErrorOutput + signalSuffix;
      const result = await finalizeTask(taskId, {
        exitCode: code,
        output: proc?.output ?? currentTask?.output ?? '',
        errorOutput: redactSecrets(annotatedErrorOutput),
        procState: proc
          ? {
              output: proc.output,
              errorOutput: redactSecrets(proc.errorOutput),
              baselineCommit: proc.baselineCommit,
              provider: proc.provider,
              state: proc.state,
              stateVersion: proc.stateVersion,
              completionDetected: proc.completionDetected,
            }
          : {
              provider: currentTask?.provider || provider,
            },
        filesModified: proc
          ? extractModifiedFiles((proc.output || '') + (proc.errorOutput || ''))
          : [],
      });
      queueManaged = Boolean(result?.queueManaged);
    } catch (err) {
      logger.info(`Critical error in close handler for task ${taskId}:`, err.message);
      const result = await finalizeTask(taskId, {
        // Preserve the real exit code when one was observed — only fall back
        // to the close-handler-exception sentinel when there wasn't one.
        exitCode: (typeof code === 'number' && code !== 0) ? code : EXIT_CLOSE_HANDLER_EXCEPTION,
        output: proc?.output || '',
        errorOutput: redactSecrets(proc?.errorOutput
          ? `${proc.errorOutput}\nInternal error: ${err.message}`
          : `Internal error: ${err.message}`),
        procState: proc
          ? {
              output: proc.output,
              errorOutput: redactSecrets(proc.errorOutput),
              baselineCommit: proc.baselineCommit,
              provider: proc.provider,
              state: proc.state,
              stateVersion: proc.stateVersion,
            }
          : {
              provider,
            },
      });
      queueManaged = queueManaged || Boolean(result?.queueManaged);
    } finally {
      try {
        dashboard.notifyTaskUpdated(taskId);
      } catch {
        // Dashboard notification is non-critical
      }
      if (!queueManaged) {
        try {
          processQueue();
        } catch (queueErr) {
          logger.info('Failed to process queue:', queueErr.message);
        }
      }
    }
  });

  // Handle process errors
  child.on('error', async (err) => {
    let queueManaged = false;
    if (!markTaskCleanedUp(taskId)) {
      return;
    }

    const proc = runningProcesses.get(taskId);

    if (proc) {
      if (proc.timeoutHandle) clearTimeout(proc.timeoutHandle);
      if (proc.startupTimeoutHandle) clearTimeout(proc.startupTimeoutHandle);
      if (proc.completionGraceHandle) clearTimeout(proc.completionGraceHandle);
      if (proc.ollamaHostId) {
        try { db.decrementHostTasks(proc.ollamaHostId); } catch { /* ignore */ }
      }
      // Clean up worktree on error (no merge — task failed)
      if (proc.worktreeInfo && proc.originalWorkingDirectory) {
        try {
          gitWorktree.removeWorktree(proc.worktreeInfo.worktreePath, proc.originalWorkingDirectory, taskId);
        } catch (cleanupErr) {
          logger.info(`[Worktree] Error-handler cleanup failed for task ${taskId}: ${cleanupErr.message}`);
        }
      }
      runningProcesses.delete(taskId);
      stallRecoveryAttempts.delete(taskId);
    }

    if (provider === 'ollama') {
      db.invalidateOllamaHealth();
      logger.info(`[${provider}] Invalidated health cache due to process error`);
    }

    try {
      const result = await finalizeTask(taskId, {
        exitCode: EXIT_SPAWN_ERROR,
        output: proc?.output || '',
        errorOutput: redactSecrets(`Process error: ${err.message}`),
        procState: {
          output: proc?.output || '',
          errorOutput: redactSecrets(proc?.errorOutput || ''),
          baselineCommit: proc?.baselineCommit || null,
          state: proc?.state,
          stateVersion: proc?.stateVersion,
          provider,
        },
      });
      queueManaged = Boolean(result?.queueManaged);
    } catch (dbErr) {
      logger.info(`Failed to finalize task ${taskId} after process error:`, dbErr.message);
    } finally {
      try {
        dashboard.notifyTaskUpdated(taskId);
      } catch {
        // Dashboard notification is non-critical
      }
      if (!queueManaged) {
        try {
          processQueue();
        } catch (queueErr) {
          logger.info('Failed to process queue:', queueErr.message);
        }
      }
    }
  });

  // Re-emit early spawn error so the full error handler processes it (RB-020 parity)
  if (earlySpawnError) {
    child.emit('error', earlySpawnError);
  }

  // Set up startup timeout
  const procRef = runningProcesses.get(taskId);
  if (procRef) {
    const startupTimeoutMs = PROVIDER_DEFAULTS.STARTUP_TIMEOUT_MS;
    procRef.startupTimeoutHandle = setTimeout(() => {
      const proc = runningProcesses.get(taskId);
      if (proc && proc.output.length === 0 && proc.errorOutput.length === 0) {
        logger.info(`Task ${taskId} produced no output in ${startupTimeoutMs/1000}s - may be hung`);
      }
    }, startupTimeoutMs);
  }

  // Set up main timeout — timeout_minutes=0 means no timeout enforcement
  const MIN_TIMEOUT_MINUTES = 1;
  const MAX_TIMEOUT_MINUTES = PROVIDER_DEFAULTS.MAX_TIMEOUT_MINUTES;
  const parsedTimeout = parseInt(task.timeout_minutes, 10);
  const rawTimeout = Number.isFinite(parsedTimeout) ? parsedTimeout : 30;
  if (rawTimeout > 0 && procRef) {
    const boundedTimeout = Math.max(MIN_TIMEOUT_MINUTES, Math.min(rawTimeout, MAX_TIMEOUT_MINUTES));
    const timeoutMs = boundedTimeout * 60 * 1000;
    procRef.timeoutHandle = setTimeout(() => {
      if (runningProcesses.has(taskId)) {
        _helpers.cancelTask(taskId, 'Timeout exceeded');
      }
    }, timeoutMs);
  }

  return { queued: false, task: db.getTask(taskId) };
}

module.exports = {
  init,
  buildClaudeCliCommand,
  buildCodexCommand,
  spawnAndTrackProcess,
  EXIT_SPAWN_INSTANT_EXIT,
  EXIT_CLOSE_HANDLER_EXCEPTION,
  EXIT_SPAWN_ERROR,
};
