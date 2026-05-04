/**
 * providers/execute-cli.js — CLI builders for claude-cli and codex
 * Extracted from providers/execution.js Phase decomposition
 *
 * Contains buildClaudeCliCommand, buildCodexCommand, spawnAndTrackProcess.
 * Uses init() dependency injection for database, dashboard, and task-manager internals.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
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
const { classifyReasoningEffort } = require('../execution/codex-reasoning-effort');
const { resolveActivityAwareTimeoutDecision } = require('../utils/activity-timeout');
const { isSubprocessDetachmentEnabled } = require('../utils/subprocess-detachment');
const { getTaskLogDir } = require('../data-dir');
const { Tail } = require('../utils/file-tail');
const { isPidAlive } = require('../utils/pid-liveness');

// Subprocess exit-code sentinels for cases where there is no real exit code
// (the subprocess either never ran, was torn down before tracking, or the
// close handler itself threw). Distinct values let the classifier in
// fallback-retry.js produce a specific reason instead of the generic
// "Unknown error" fallthrough. Negative values don't collide with real exit
// codes (0..255 on POSIX, up to ~4 billion on Windows).
const EXIT_SPAWN_INSTANT_EXIT = -101;   // proc entry gone but task row still running
const EXIT_CLOSE_HANDLER_EXCEPTION = -102; // close handler itself threw
const EXIT_SPAWN_ERROR = -103;          // child.on('error') fired (ENOENT, EACCES, etc.)

function computeActivityAwareTimeoutDelay(proc, timeoutMs, now = Date.now()) {
  const decision = resolveActivityAwareTimeoutDecision({ proc, timeoutMs, now });
  return decision.action === 'extend' ? decision.delayMs : 0;
}

function describeTimeoutDecisionReason(reason) {
  return reason === 'factory_plan_generation_hard_cap'
    ? 'factory plan-generation hard cap'
    : 'idle timeout';
}

function formatElapsedMinutes(ms) {
  return (Math.max(0, ms) / 60000).toFixed(1);
}

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

function readDetachedLogRemainder(logPath, offset) {
  if (!logPath || typeof logPath !== 'string') {
    return { text: '', offset: Number(offset) || 0 };
  }

  let stat;
  try {
    stat = fs.statSync(logPath);
  } catch {
    return { text: '', offset: Number(offset) || 0 };
  }

  const start = Math.max(0, Math.min(Number(offset) || 0, stat.size));
  if (stat.size <= start) {
    return { text: '', offset: stat.size };
  }

  let fd;
  try {
    fd = fs.openSync(logPath, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.toString('utf8'), offset: stat.size };
  } catch (err) {
    logger.info(`[Detached] Failed to flush log remainder ${logPath}: ${err.message}`);
    return { text: '', offset: start };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function flushDetachedLogRemainders(taskId, proc, streamId) {
  if (!proc) return;

  const stdoutFlush = readDetachedLogRemainder(proc.outputLogPath, proc.outputLogOffset);
  if (stdoutFlush.text) {
    processStdoutChunk(taskId, stdoutFlush.text, streamId);
  }
  proc.outputLogOffset = stdoutFlush.offset;

  const stderrFlush = readDetachedLogRemainder(proc.errorLogPath, proc.errorLogOffset);
  if (stderrFlush.text) {
    processStderrChunk(taskId, stderrFlush.text, streamId);
  }
  proc.errorLogOffset = stderrFlush.offset;

  try {
    db.updateTaskStatus(taskId, 'running', {
      output_log_offset: proc.outputLogOffset,
      error_log_offset: proc.errorLogOffset,
      last_activity_at: new Date().toISOString(),
    });
  } catch { /* best-effort flush bookkeeping */ }
}

/**
 * Force-terminate the subprocess associated with `taskId` after the
 * completion-grace window expired without a natural exit. Works for both
 * the legacy pipe-based spawn (where we hold a child handle) and the
 * detached spawn (where we only have the OS pid). Extracted from the
 * inline grace-handler logic in `spawnAndTrackProcess` so the new
 * detached path can reuse the same kill semantics.
 *
 * The pipe path emits a synthetic 'close' event after the kill so the
 * existing `child.on('close')` finalizer fires; the detached path
 * intentionally skips that emit because its PID-liveness watcher will
 * pick up the death naturally and run the same finalize pipeline.
 *
 * @param {string} taskId
 * @param {Object} capturedProc - the runningProcesses entry captured at
 *   grace-timer arming time. Used to detect "still the same proc" when
 *   the timer fires (a stale entry could indicate finalize already ran).
 * @param {string} source - 'output' or 'stderr', for diagnostic logging
 *   only — distinguishes which detector fired the grace.
 */
function forceCompleteAfterGrace(taskId, capturedProc, source) {
  const stillRunning = runningProcesses.get(taskId);
  if (!stillRunning || stillRunning !== capturedProc) {
    // Already finalized or replaced — nothing to kill.
    return;
  }
  const haveChildHandle = Boolean(stillRunning.process);
  const pid = haveChildHandle
    ? stillRunning.process.pid
    : stillRunning.subprocessPid;
  logger.info(
    `[Completion] Task ${taskId} ${source} grace expired — force-completing (mode=${haveChildHandle ? 'pipe' : 'detached'} pid=${pid || 'unknown'})`
  );
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    const { execFile } = require('child_process');
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, (err) => {
      if (err) {
        logger.info(`[Completion] taskkill failed for task ${taskId}: ${err.message}`);
      }
      if (haveChildHandle) {
        // RB-013: emit synthetic close so the close-phase pipeline runs
        // (validation, build checks, terminalization). markTaskCleanedUp
        // guards against double-fire if the real close arrived first.
        setTimeout(() => {
          if (capturedProc.process && !capturedProc.process.killed) {
            capturedProc.process.emit('close', 1, null);
          }
        }, 1000);
        setTimeout(() => {
          const yetRunning = runningProcesses.get(taskId);
          if (yetRunning && yetRunning === capturedProc && yetRunning.completionDetected) {
            logger.info(`[Completion] Task ${taskId} emitting synthetic close after taskkill.`);
            capturedProc.process.emit('close', 1, null);
          }
        }, 2000);
      }
      // Detached: nothing more to do — PID-liveness watcher handles the rest.
    });
  } else {
    // POSIX: SIGTERM, then SIGKILL after a 5s grace.
    if (haveChildHandle) {
      try {
        stillRunning.process.kill('SIGTERM');
      } catch (killErr) {
        if (killErr.code !== 'ESRCH') {
          logger.info(`[Completion] Failed to SIGTERM task ${taskId}: ${killErr.message}`);
        }
      }
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (killErr) {
        if (killErr.code !== 'ESRCH') {
          logger.info(`[Completion] Failed to SIGTERM detached pid ${pid} for task ${taskId}: ${killErr.message}`);
        }
      }
    }
    setTimeout(() => {
      const yetRunning = runningProcesses.get(taskId);
      if (yetRunning) {
        if (haveChildHandle) {
          try { yetRunning.process.kill('SIGKILL'); } catch { /* ignore */ }
        } else {
          try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
        }
      }
    }, 5000);
  }
}

/**
 * Per-chunk stdout handler — invoked once per buffered stdout fragment.
 * Identical for the pipe path (called from child.stdout.on('data', ...))
 * and the detached path (called from Tail.on('chunk', ...)). Encapsulates
 * the buffer-cap, progress, completion-detect, stream-chunk, breakpoint,
 * and step-mode logic that used to live inline.
 *
 * @param {string} taskId
 * @param {string} text - already a JS string; pipe path converts via
 *   data.toString() before calling, detached path passes the Tail chunk
 *   directly.
 * @param {string} streamId
 */
function processStdoutChunk(taskId, text, streamId) {
  const proc = runningProcesses.get(taskId);
  if (!proc) return;

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

  if (!proc.completionDetected && _helpers.detectOutputCompletion(proc.output, proc.provider)) {
    proc.completionDetected = true;
    const graceMs = proc.provider === 'codex' ? COMPLETION_GRACE_CODEX_MS : COMPLETION_GRACE_MS;
    logger.info(`[Completion] Task ${taskId} output indicates work is complete (provider: ${proc.provider}). Starting ${graceMs / 1000}s grace period for natural exit.`);
    const capturedProc = proc;
    proc.completionGraceHandle = setTimeout(() => {
      forceCompleteAfterGrace(taskId, capturedProc, 'output');
    }, graceMs);
  }

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

  const hitBreakpoint = _helpers.checkBreakpoints(taskId, text, 'output');
  if (hitBreakpoint && hitBreakpoint.action === 'pause') {
    _helpers.pauseTaskForDebug(taskId, hitBreakpoint);
  }

  if (proc.stepMode === 'step' && proc.stepRemaining > 0) {
    proc.stepRemaining--;
    if (proc.stepRemaining === 0) {
      _helpers.pauseTask(taskId, 'Step mode complete');
    }
  }
}

/**
 * Per-chunk stderr handler — symmetric to {@link processStdoutChunk}.
 * Handles codex banner filtering (banner lines must NOT reset the stall
 * timer), stderr-side completion detection (codex CLI writes its task
 * summary to stderr, not stdout), and the stderr stream-chunk write.
 */
function processStderrChunk(taskId, text, streamId) {
  const proc = runningProcesses.get(taskId);
  if (!proc) return;

  if (proc.startupTimeoutHandle) {
    clearTimeout(proc.startupTimeoutHandle);
    proc.startupTimeoutHandle = null;
  }
  proc.errorOutput += text;
  if (proc.errorOutput.length > _MAX_OUTPUT_BUFFER) {
    proc.errorOutput = '[...truncated...]\n' + proc.errorOutput.slice(-_MAX_OUTPUT_BUFFER / 2);
  }

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
    if (!proc.completionDetected && _helpers.detectOutputCompletion(combinedOutput, proc.provider)) {
      proc.completionDetected = true;
      const graceMs = proc.provider === 'codex' ? COMPLETION_GRACE_CODEX_MS : COMPLETION_GRACE_MS;
      logger.info(`[Completion] Task ${taskId} stderr indicates work complete (provider: ${proc.provider}). Starting ${graceMs / 1000}s grace period.`);
      const capturedProc = proc;
      proc.completionGraceHandle = setTimeout(() => {
        forceCompleteAfterGrace(taskId, capturedProc, 'stderr');
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

    // Pick reasoning_effort via the centralized classifier. See
    // server/execution/codex-reasoning-effort.js — kinds like
    // plan_quality_review/replan_rewrite/verify_review and bounded
    // starvation-recovery scouts run on `low`; generic factory_internal +
    // scouts run on `high`; shell-execute-only tasks run on `low`;
    // everything else falls through to the user's xhigh default. Mirrors
    // the same logic in command-builders.js.
    const effortDecision = classifyReasoningEffort(task);
    if (effortDecision.reasoning_effort) {
      codexArgs.push('-c', `model_reasoning_effort=${effortDecision.reasoning_effort}`);
      logger.debug('Codex reasoning_effort override applied', {
        task_id: task.id,
        tier: effortDecision.tier,
        reasoning_effort: effortDecision.reasoning_effort,
        reason: effortDecision.reason,
      });
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
  // --- Subprocess-detachment dispatch (Phase B, flag-gated) ---
  // When TORQUE_DETACHED_SUBPROCESSES=1 AND the provider is codex/codex-spark,
  // delegate to the new detached spawn path that (a) writes stdio to per-task
  // log files instead of pipes and (b) uses PID-liveness polling instead of
  // child.on('close'). Result: a TORQUE restart no longer kills the in-flight
  // codex subprocess. See docs/design/2026-05-03-subprocess-detachment-codex-spike.md
  // §4 for the full design and §8 phase plan.
  //
  // Non-codex providers and the flag-off case keep the legacy pipe path below
  // unchanged. Phase F extends detachment to claude-cli / ollama-agentic /
  // claude-code-sdk; Phase G flips the default; Phase H deletes this branch.
  const isCodexProviderDispatch = (provider === 'codex' || provider === 'codex-spark');
  if (isCodexProviderDispatch && isSubprocessDetachmentEnabled()) {
    return spawnAndTrackProcessDetached(taskId, task, cmdSpec, provider);
  }

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
    metadata: task.metadata || task.task_metadata || null,
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

  // Handle stdout — body is in the shared `processStdoutChunk` helper so
  // the detached-spawn path (Tail-driven) can route through identical logic.
  child.stdout.on('data', (data) => {
    processStdoutChunk(taskId, data.toString(), streamId);
  });

  // Handle stderr errors
  child.stderr.on('error', (err) => {
    logger.info(`[TaskManager] stderr error for task ${taskId}: ${err.message}`);
  });

  // Handle stderr — body is in the shared `processStderrChunk` helper.
  child.stderr.on('data', (data) => {
    processStderrChunk(taskId, data.toString(), streamId);
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
      // Annotate the error output with a structured exit summary on any
      // non-zero/abnormal exit so diagnostics always preserve enough context
      // to classify the failure (signal-kill vs genuine non-zero exit vs
      // silent crash). The CLI's own stderr is often just an echo of the
      // prompt and any successful exec calls; without this annotation a
      // codex CLI that dies mid-stream (network blip, OOM, sandbox kill)
      // leaves no record of when or why it ended. Live evidence 2026-05-03
      // task 65072ba9: error_output had only the prompt-echo, no exit
      // reason — investigation had to reconstruct timing from the factory
      // decision log.
      let exitSuffix = '';
      if (effectiveSignal || (typeof code === 'number' && code !== 0)) {
        const durationMs = proc?.startTime ? (Date.now() - proc.startTime) : null;
        const parts = [
          `code=${typeof code === 'number' ? code : 'null'}`,
          `signal=${effectiveSignal || 'none'}`,
          durationMs != null ? `duration_ms=${durationMs}` : null,
          proc?.provider ? `provider=${proc.provider}` : (provider ? `provider=${provider}` : null),
          proc?.model ? `model=${proc.model}` : null,
        ].filter(Boolean);
        exitSuffix = `\n[process-exit] ${parts.join(' ')}`;
      }
      const annotatedErrorOutput = rawErrorOutput + exitSuffix;
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
    const scheduleTimeoutCheck = (delayMs) => {
      procRef.timeoutHandle = setTimeout(() => {
        const proc = runningProcesses.get(taskId);
        if (!proc) {
          return;
        }
        const decision = resolveActivityAwareTimeoutDecision({
          proc,
          timeoutMs,
          task,
          metadata: task.metadata,
          now: Date.now(),
        });
        if (decision.action === 'extend') {
          const idleSeconds = Math.round(decision.idleMs / 1000);
          const nextDelaySeconds = Math.round(decision.delayMs / 1000);
          logger.info(
            `[TaskManager] Task ${taskId} exceeded ${boundedTimeout}min timeout budget but had activity ${idleSeconds}s ago; elapsed=${formatElapsedMinutes(decision.elapsedMs)}min next_delay=${nextDelaySeconds}s`
          );
          scheduleTimeoutCheck(decision.delayMs);
          return;
        }
        logger.info(
          `[TaskManager] Task ${taskId} timeout decision: ${describeTimeoutDecisionReason(decision.reason)}; elapsed=${formatElapsedMinutes(decision.elapsedMs)}min idle=${Math.round(decision.idleMs / 1000)}s`
        );
        _helpers.cancelTask(taskId, 'Timeout exceeded', { cancel_reason: 'timeout' });
      }, delayMs);
    };
    scheduleTimeoutCheck(timeoutMs);
  }

  return { queued: false, task: db.getTask(taskId) };
}

// ============================================================
// Subprocess-detachment arc — Phase B (codex / codex-spark)
// ============================================================

/**
 * Parse the LAST `[process-exit] code=X signal=Y duration_ms=Z provider=W
 * model=M` annotation from a stderr-log buffer. The wrapper script
 * (server/utils/process-exit-wrapper.js) writes one such line on every
 * child exit. Returns null when the annotation is absent (e.g. wrapper
 * itself was SIGKILL'd before it could write — extremely rare; the
 * caller treats this as `code=null signal=detached_exit`).
 *
 * @param {string} text
 * @returns {{code: number|null, signal: string|null, duration_ms: number|null}|null}
 */
function parseProcessExitAnnotation(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\[process-exit\] (.+)$/.exec(lines[i]);
    if (!m) continue;
    const fields = {};
    for (const part of m[1].split(' ')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    const codeRaw = fields.code;
    const code = (codeRaw === 'null' || codeRaw === undefined) ? null : Number(codeRaw);
    const signal = fields.signal === 'none' ? null : (fields.signal || null);
    const dur = fields.duration_ms !== undefined ? Number(fields.duration_ms) : null;
    return { code, signal, duration_ms: dur };
  }
  return null;
}

const DETACHED_LIVENESS_POLL_MS = 2000;
const DETACHED_FINAL_DRAIN_MS = 1500; // give Tail a couple more polls after PID death

/**
 * Spawn a codex / codex-spark subprocess in detached mode. The TORQUE
 * parent does NOT hold a stdio pipe to the child; instead, stdout and
 * stderr are redirected to per-task log files under
 * `<data-dir>/task-logs/<taskId>/`, and the parent uses a polled `Tail`
 * watcher to feed the same chunk handlers (processStdoutChunk /
 * processStderrChunk) the legacy pipe path uses.
 *
 * The child is wrapped in `process-exit-wrapper.js` so the
 * `[process-exit] code=X signal=Y duration_ms=Z provider=W model=M`
 * annotation we ship today is preserved on the stderr.log even though
 * the parent never sees `child.on('close')`. PID-liveness polling
 * (process.kill(pid, 0)) detects exit; the finalizer reads the
 * annotation back from the log to recover the exit code.
 *
 * Side effects: creates the per-task log directory, opens stdout.log /
 * stderr.log as append handles, persists `subprocess_pid`,
 * `output_log_path`, `error_log_path`, and the running-process map
 * entry. On startup re-adoption (Phase C) the same persisted state is
 * what makes attaching a new Tail to a still-alive PID safe.
 */
function spawnAndTrackProcessDetached(taskId, task, cmdSpec, provider) {
  const { cliPath, finalArgs, stdinPrompt, envExtras, selectedOllamaHostId, usedEditFormat } = cmdSpec;
  const isCodexProvider = (provider === 'codex' || provider === 'codex-spark');

  // 1) Per-task log directory + open append handles for stdout / stderr.
  const logDir = getTaskLogDir(taskId);
  fs.mkdirSync(logDir, { recursive: true });
  const stdoutPath = path.join(logDir, 'stdout.log');
  const stderrPath = path.join(logDir, 'stderr.log');
  // 'a' (append) so re-adoption after a parent restart resumes at the
  // saved offset without truncating in-flight content. Phase A persists
  // output_log_offset / error_log_offset for that resume.
  const stdoutFd = fs.openSync(stdoutPath, 'a');
  const stderrFd = fs.openSync(stderrPath, 'a');

  // 2) Optional prompt-file for codex `exec -` (it reads from stdin).
  // Detached spawn ignores parent stdin, so the wrapper streams the
  // prompt into the child via a file path passed in TORQUE_PEW_STDIN_FILE.
  let promptFilePath = '';
  if (typeof stdinPrompt === 'string' && stdinPrompt.length > 0) {
    promptFilePath = path.join(logDir, 'prompt.txt');
    fs.writeFileSync(promptFilePath, stdinPrompt);
  }

  // 3) PATH + env construction — mirrors the pipe path so the bundled
  // codex.exe vendor `path/` directory still resolves rg.exe etc.
  const envPath = process.env.PATH || '';
  let updatedPath = (_NVM_NODE_PATH && !envPath.includes(_NVM_NODE_PATH))
    ? `${_NVM_NODE_PATH}:${envPath}`
    : envPath;
  const baseEnvExtras = { ...(envExtras || {}) };
  const nativeVendorPath = baseEnvExtras.__TORQUE_CODEX_VENDOR_PATH || '';
  delete baseEnvExtras.__TORQUE_CODEX_VENDOR_PATH;
  if (nativeVendorPath && !updatedPath.split(path.delimiter).includes(nativeVendorPath)) {
    updatedPath = `${nativeVendorPath}${path.delimiter}${updatedPath}`;
  }
  const gitCeiling = task.working_directory ? path.dirname(task.working_directory) : undefined;
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
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.autocrlf',
    GIT_CONFIG_VALUE_0: 'input',
    PYTHONIOENCODING: 'utf-8',
    ...(gitCeiling ? { GIT_CEILING_DIRECTORIES: gitCeiling } : {}),
    ...baseEnvExtras,
    // Wrapper-only env vars — stripped by the wrapper before it execs codex.
    TORQUE_PEW_PROGRAM: cliPath,
    TORQUE_PEW_ARGS: JSON.stringify(finalArgs),
    TORQUE_PEW_PROVIDER: provider,
    TORQUE_PEW_MODEL: task.model || '',
    ...(promptFilePath ? { TORQUE_PEW_STDIN_FILE: promptFilePath } : {}),
  });

  const wrapperPath = path.join(__dirname, '..', 'utils', 'process-exit-wrapper.js');
  const effectiveCwd = task.working_directory || process.cwd();
  const spawnOptions = {
    cwd: effectiveCwd,
    env: envVars,
    shell: false,
    stdio: ['ignore', stdoutFd, stderrFd],
    windowsHide: true,
    detached: true,
  };

  // Capture baseline HEAD SHA before spawning (parity with pipe path).
  let baselineCommit = null;
  try {
    baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: effectiveCwd, encoding: 'utf-8', timeout: 15000, windowsHide: true,
    }).trim();
  } catch (e) {
    logger.info(`[TaskManager] Could not capture baseline HEAD for task ${taskId}: ${e.message}`);
  }

  logger.info(`[TaskManager] Spawning DETACHED via wrapper: ${process.execPath} ${wrapperPath} (real: ${cliPath} ${redactCommandArgs(finalArgs).join(' ')})`);
  logger.info(`[TaskManager] Provider: ${provider}, Working dir: ${effectiveCwd}, log dir: ${logDir}`);

  const child = spawn(process.execPath, [wrapperPath], spawnOptions);

  // 4) Detach — close stdio fds parent-side and unref so TORQUE can exit
  // without taking the codex subprocess down with it.
  try { fs.closeSync(stdoutFd); } catch { /* ignore */ }
  try { fs.closeSync(stderrFd); } catch { /* ignore */ }
  try { child.unref(); } catch { /* ignore */ }

  let earlySpawnError = null;
  child.on('error', (err) => {
    if (!earlySpawnError) earlySpawnError = err;
    logger.info(`[TaskManager] Detached wrapper spawn error for task ${taskId}: ${err.message}`);
  });

  if (!child.pid) {
    logger.info(`[TaskManager] WARNING: detached spawn returned no PID for task ${taskId}`);
  }

  const subprocessPid = child.pid || null;
  const startTime = Date.now();
  const nowIso = new Date(startTime).toISOString();

  // 5) Persist subprocess identity to the task row immediately so a
  // parent crash between here and the next status update still leaves
  // enough breadcrumbs for re-adoption.
  db.updateTaskStatus(taskId, 'running', {
    pid: subprocessPid,
    ollama_host_id: selectedOllamaHostId,
    subprocess_pid: subprocessPid,
    output_log_path: stdoutPath,
    error_log_path: stderrPath,
    output_log_offset: 0,
    error_log_offset: 0,
    last_activity_at: nowIso,
  });

  const streamId = db.getOrCreateTaskStream(taskId, 'output');

  // 6) Build the runningProcesses entry. Note process: null and the
  // detachment-specific fields. Same field names the pipe path uses
  // (output, errorOutput, lastOutputAt, etc.) so chunk handlers and
  // close-handler logic don't need to branch on mode.
  const procEntry = {
    process: null,
    output: '',
    errorOutput: '',
    startTime,
    lastOutputAt: startTime,
    stallWarned: false,
    timeoutHandle: null,
    startupTimeoutHandle: null,
    streamErrorCount: 0,
    streamErrorWarned: false,
    ollamaHostId: selectedOllamaHostId,
    model: task.model,
    provider,
    metadata: task.metadata || task.task_metadata || null,
    editFormat: usedEditFormat,
    completionDetected: false,
    completionGraceHandle: null,
    lastProgress: 0,
    baselineCommit,
    workingDirectory: effectiveCwd,
    lastFsFingerprint: null,
    worktreeInfo: null,
    originalWorkingDirectory: null,
    // Detachment-specific fields:
    detached: true,
    subprocessPid,
    outputLogPath: stdoutPath,
    errorLogPath: stderrPath,
    outputLogOffset: 0,
    errorLogOffset: 0,
    outputTail: null,
    errorTail: null,
    livenessHandle: null,
    finalizing: false,
  };
  runningProcesses.set(taskId, procEntry);

  dashboard.notifyTaskUpdated(taskId);

  // 7) Tail watchers feed the SAME shared chunk handlers used by the
  // pipe path. Offset persistence is throttled to avoid hammering the DB.
  const offsetPersistThrottleMs = 2000;
  let lastStdoutPersistAt = 0;
  let lastStderrPersistAt = 0;

  const outputTail = new Tail(stdoutPath, { startOffset: 0, pollIntervalMs: 250 });
  outputTail.on('chunk', (text, newOffset) => {
    processStdoutChunk(taskId, text, streamId);
    procEntry.outputLogOffset = newOffset;
    const now = Date.now();
    if (now - lastStdoutPersistAt >= offsetPersistThrottleMs) {
      lastStdoutPersistAt = now;
      try {
        db.updateTaskStatus(taskId, 'running', {
          output_log_offset: newOffset,
          last_activity_at: new Date(now).toISOString(),
        });
      } catch { /* offset persistence is best-effort */ }
    }
  });
  outputTail.on('error', (err) => {
    if (err && err.code === 'ENOENT') return; // pre-spawn race; Tail itself retries
    logger.info(`[Tail] stdout error for task ${taskId}: ${err.message}`);
  });

  const errorTail = new Tail(stderrPath, { startOffset: 0, pollIntervalMs: 250 });
  errorTail.on('chunk', (text, newOffset) => {
    processStderrChunk(taskId, text, streamId);
    procEntry.errorLogOffset = newOffset;
    const now = Date.now();
    if (now - lastStderrPersistAt >= offsetPersistThrottleMs) {
      lastStderrPersistAt = now;
      try {
        db.updateTaskStatus(taskId, 'running', {
          error_log_offset: newOffset,
          last_activity_at: new Date(now).toISOString(),
        });
      } catch { /* best-effort */ }
    }
  });
  errorTail.on('error', (err) => {
    if (err && err.code === 'ENOENT') return;
    logger.info(`[Tail] stderr error for task ${taskId}: ${err.message}`);
  });

  outputTail.start();
  errorTail.start();
  procEntry.outputTail = outputTail;
  procEntry.errorTail = errorTail;

  // 8) PID-liveness watcher — replaces child.on('close') for detached
  // mode. The wrapper subprocess's own 'close' event also fires (we
  // still hold a child handle until Node GCs it) and serves as a fast
  // path; the PID poller is the reliable fallback for re-adopted
  // subprocesses where we never had a child handle.
  const triggerFinalize = () => {
    if (procEntry.finalizing) return;
    procEntry.finalizing = true;
    if (procEntry.livenessHandle) {
      clearInterval(procEntry.livenessHandle);
      procEntry.livenessHandle = null;
    }
    // Give the tailers a moment to drain remaining bytes before we read
    // the final state — the PID died but the OS may not have flushed
    // the last write yet.
    setTimeout(() => {
      void finalizeDetachedTask({ taskId, task, provider, isCodexProvider })
        .catch((err) => {
          logger.info(`[Detached] finalize failed for task ${taskId}: ${err.message}`);
        });
    }, DETACHED_FINAL_DRAIN_MS);
  };

  child.on('close', () => { triggerFinalize(); });
  child.on('exit', () => { setTimeout(() => { triggerFinalize(); }, 500); });
  procEntry.livenessHandle = setInterval(() => {
    if (procEntry.finalizing) return;
    if (subprocessPid != null && !isPidAlive(subprocessPid)) {
      logger.info(`[Detached] task ${taskId} pid ${subprocessPid} no longer alive — finalizing`);
      triggerFinalize();
    }
  }, DETACHED_LIVENESS_POLL_MS);

  if (earlySpawnError) {
    triggerFinalize();
  }

  // 9) Startup timeout (parity with pipe path).
  const startupTimeoutMs = PROVIDER_DEFAULTS.STARTUP_TIMEOUT_MS;
  procEntry.startupTimeoutHandle = setTimeout(() => {
    const proc = runningProcesses.get(taskId);
    if (proc && proc.output.length === 0 && proc.errorOutput.length === 0) {
      logger.info(`Task ${taskId} produced no output in ${startupTimeoutMs / 1000}s - may be hung`);
    }
  }, startupTimeoutMs);

  // 10) Main timeout — same activity-aware logic as the pipe path.
  const MIN_TIMEOUT_MINUTES = 1;
  const MAX_TIMEOUT_MINUTES = PROVIDER_DEFAULTS.MAX_TIMEOUT_MINUTES;
  const parsedTimeout = parseInt(task.timeout_minutes, 10);
  const rawTimeout = Number.isFinite(parsedTimeout) ? parsedTimeout : 30;
  if (rawTimeout > 0) {
    const boundedTimeout = Math.max(MIN_TIMEOUT_MINUTES, Math.min(rawTimeout, MAX_TIMEOUT_MINUTES));
    const timeoutMs = boundedTimeout * 60 * 1000;
    const scheduleTimeoutCheck = (delayMs) => {
      procEntry.timeoutHandle = setTimeout(() => {
        const proc = runningProcesses.get(taskId);
        if (!proc) return;
        const decision = resolveActivityAwareTimeoutDecision({
          proc, timeoutMs, task, metadata: task.metadata, now: Date.now(),
        });
        if (decision.action === 'extend') {
          const idleSeconds = Math.round(decision.idleMs / 1000);
          const nextDelaySeconds = Math.round(decision.delayMs / 1000);
          logger.info(
            `[TaskManager] Task ${taskId} exceeded ${boundedTimeout}min timeout budget but had activity ${idleSeconds}s ago; elapsed=${formatElapsedMinutes(decision.elapsedMs)}min next_delay=${nextDelaySeconds}s`
          );
          scheduleTimeoutCheck(decision.delayMs);
          return;
        }
        logger.info(
          `[TaskManager] Task ${taskId} timeout decision: ${describeTimeoutDecisionReason(decision.reason)}; elapsed=${formatElapsedMinutes(decision.elapsedMs)}min idle=${Math.round(decision.idleMs / 1000)}s`
        );
        _helpers.cancelTask(taskId, 'Timeout exceeded', { cancel_reason: 'timeout' });
      }, delayMs);
    };
    scheduleTimeoutCheck(timeoutMs);
  }

  return { queued: false, task: db.getTask(taskId) };
}

/**
 * Finalizer for the detached spawn path. Runs when PID-liveness polling
 * (or the wrapper's own 'close' event) detects the subprocess has
 * exited. Mirrors the pipe-path close handler's downstream pipeline
 * (codex auto-commit, finalizeTask, queue-process), but recovers the
 * exit code by parsing the `[process-exit]` annotation written by
 * process-exit-wrapper.js into stderr.log.
 *
 * The wrapper writes its own `[process-exit]` annotation, so we do NOT
 * append a second one here (the pipe-path close handler appends one
 * itself; that's only needed when the parent observed the exit
 * directly).
 */
async function finalizeDetachedTask({ taskId, task, provider, isCodexProvider }) {
  if (!markTaskCleanedUp(taskId)) return;
  const proc = runningProcesses.get(taskId);
  let queueManaged = false;

  if (proc) {
    if (proc.timeoutHandle) clearTimeout(proc.timeoutHandle);
    if (proc.startupTimeoutHandle) clearTimeout(proc.startupTimeoutHandle);
    if (proc.completionGraceHandle) clearTimeout(proc.completionGraceHandle);
    if (proc.livenessHandle) {
      clearInterval(proc.livenessHandle);
      proc.livenessHandle = null;
    }
    const streamId = db.getOrCreateTaskStream(taskId, 'output');
    flushDetachedLogRemainders(taskId, proc, streamId);
    if (proc.outputTail) {
      try { proc.outputTail.stop(); } catch { /* ignore */ }
    }
    if (proc.errorTail) {
      try { proc.errorTail.stop(); } catch { /* ignore */ }
    }

    if (!proc.completionDetected) {
      const combinedOutput = (proc.output || '') + (proc.errorOutput || '');
      if (combinedOutput) {
        proc.completionDetected = _helpers.detectOutputCompletion(combinedOutput, proc.provider);
      }
    }
  }

  // Recover exit code from the wrapper's annotation. When absent (wrapper
  // itself was killed mid-write — extremely rare), fall back to null +
  // detached_exit so the downstream classifier can still produce a
  // distinct reason.
  const annotation = parseProcessExitAnnotation(proc?.errorOutput || '');
  let code = annotation && annotation.code !== null ? annotation.code : null;
  const effectiveSignal = annotation ? (annotation.signal || null) : 'detached_exit';

  if (proc && proc.completionDetected && code !== 0) {
    logger.info(`[Detached] Task ${taskId} exited with code ${code} but output indicated success (provider: ${proc.provider}). Treating as code 0.`);
    code = 0;
  }

  if (proc && proc.ollamaHostId) {
    try { db.decrementHostTasks(proc.ollamaHostId); } catch { /* ignore */ }
  }

  // Codex auto-commit (no worktree path — codex never uses worktree
  // isolation; see spawnAndTrackProcess top-comment).
  if (proc && isCodexProvider && code === 0 && task.working_directory) {
    try {
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

  if (proc) {
    runningProcesses.delete(taskId);
    stallRecoveryAttempts.delete(taskId);
  }

  try {
    const currentTask = db.getTask(taskId);
    if (currentTask && currentTask.status === 'cancelled') {
      logger.info(`[Detached] Task ${taskId} finalize skipped because task is already cancelled`);
      return;
    }
    const rawErrorOutput = proc
      ? proc.errorOutput
      : (currentTask?.error_output || 'Process tracking lost - task completed without captured output');
    // No additional annotation: the wrapper already wrote one to the
    // log, which we just parsed. Annotating again would duplicate the
    // line on every detached completion.
    const result = await finalizeTask(taskId, {
      exitCode: code,
      output: proc?.output ?? currentTask?.output ?? '',
      errorOutput: redactSecrets(rawErrorOutput),
      procState: proc
        ? {
            output: proc.output,
            errorOutput: redactSecrets(proc.errorOutput),
            baselineCommit: proc.baselineCommit,
            provider: proc.provider,
            state: proc.state,
            stateVersion: proc.stateVersion,
            completionDetected: proc.completionDetected,
            detached: true,
            exitSignal: effectiveSignal,
          }
        : { provider: currentTask?.provider || provider, detached: true },
      filesModified: proc
        ? extractModifiedFiles((proc.output || '') + (proc.errorOutput || ''))
        : [],
    });
    queueManaged = Boolean(result?.queueManaged);
  } catch (err) {
    logger.info(`Critical error in detached finalize for task ${taskId}: ${err.message}`);
    const result = await finalizeTask(taskId, {
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
            detached: true,
          }
        : { provider, detached: true },
    });
    queueManaged = queueManaged || Boolean(result?.queueManaged);
  } finally {
    try { dashboard.notifyTaskUpdated(taskId); } catch { /* non-critical */ }
    if (!queueManaged) {
      try { processQueue(); } catch (queueErr) {
        logger.info('Failed to process queue:', queueErr.message);
      }
    }
  }
}

/**
 * Re-adopt a still-alive detached subprocess after a TORQUE restart.
 *
 * When Phase B's detached spawn path persisted `subprocess_pid` +
 * `output_log_path` + `error_log_path` for a task and the parent process
 * has now restarted, the subprocess is still running but the in-memory
 * `runningProcesses` map is empty. This function rebuilds that entry —
 * `process: null`, `subprocessPid` set, Tail watchers attached at the
 * persisted log offsets, PID-liveness watcher polling — so the new
 * parent can drive the same chunk handlers + finalize pipeline as the
 * original spawn did.
 *
 * Caller (startup-task-reconciler) is responsible for verifying
 * `isPidAlive(pid)` and the log-mtime PID-reuse defense before invoking
 * us. If we get here, those checks already passed.
 *
 * @param {string} taskId
 * @param {Object} persistedTask - the row read from the tasks table; we
 *   read subprocess_pid, output_log_path, error_log_path,
 *   output_log_offset, error_log_offset, provider, model,
 *   working_directory, ollama_host_id, started_at, metadata,
 *   task_metadata, baseline_commit (may be undefined).
 * @returns {boolean} true on success; false if dependencies missing
 *   (init not run yet, or persisted state incomplete).
 */
function reAdoptDetachedSubprocess(taskId, persistedTask) {
  if (!runningProcesses || !db || !dashboard) {
    logger.info(`[Detached] re-adopt declined for task ${taskId}: execute-cli not initialized`);
    return false;
  }
  if (runningProcesses.has(taskId)) {
    // Already tracked (defensive — should not happen on cold startup).
    return true;
  }
  const subprocessPid = Number(persistedTask?.subprocess_pid);
  const stdoutPath = persistedTask?.output_log_path;
  const stderrPath = persistedTask?.error_log_path;
  if (!Number.isFinite(subprocessPid) || subprocessPid <= 0 || !stdoutPath || !stderrPath) {
    return false;
  }

  const startOutputOffset = Number.isFinite(Number(persistedTask?.output_log_offset))
    ? Number(persistedTask.output_log_offset)
    : 0;
  const startErrorOffset = Number.isFinite(Number(persistedTask?.error_log_offset))
    ? Number(persistedTask.error_log_offset)
    : 0;

  const provider = persistedTask?.provider || 'codex';
  const isCodexProvider = (provider === 'codex' || provider === 'codex-spark');
  const startTime = persistedTask?.started_at
    ? new Date(persistedTask.started_at).getTime() || Date.now()
    : Date.now();

  const procEntry = {
    process: null,
    output: '',
    errorOutput: '',
    startTime,
    lastOutputAt: Date.now(),
    stallWarned: false,
    timeoutHandle: null,
    startupTimeoutHandle: null,
    streamErrorCount: 0,
    streamErrorWarned: false,
    ollamaHostId: persistedTask?.ollama_host_id || null,
    model: persistedTask?.model || null,
    provider,
    metadata: persistedTask?.metadata || persistedTask?.task_metadata || null,
    editFormat: null,
    completionDetected: false,
    completionGraceHandle: null,
    lastProgress: 0,
    baselineCommit: persistedTask?.baseline_commit || null,
    workingDirectory: persistedTask?.working_directory || null,
    lastFsFingerprint: null,
    worktreeInfo: null,
    originalWorkingDirectory: null,
    detached: true,
    reAdopted: true,
    subprocessPid,
    outputLogPath: stdoutPath,
    errorLogPath: stderrPath,
    outputTail: null,
    errorTail: null,
    livenessHandle: null,
    finalizing: false,
  };
  runningProcesses.set(taskId, procEntry);

  const taskShape = {
    id: taskId,
    task_description: persistedTask?.task_description || '',
    working_directory: persistedTask?.working_directory || null,
    metadata: persistedTask?.metadata || persistedTask?.task_metadata || null,
    timeout_minutes: persistedTask?.timeout_minutes,
    model: persistedTask?.model,
  };

  const streamId = db.getOrCreateTaskStream(taskId, 'output');
  const offsetPersistThrottleMs = 2000;
  let lastStdoutPersistAt = 0;
  let lastStderrPersistAt = 0;

  const outputTail = new Tail(stdoutPath, { startOffset: startOutputOffset, pollIntervalMs: 250 });
  outputTail.on('chunk', (text, newOffset) => {
    processStdoutChunk(taskId, text, streamId);
    const now = Date.now();
    if (now - lastStdoutPersistAt >= offsetPersistThrottleMs) {
      lastStdoutPersistAt = now;
      try {
        db.updateTaskStatus(taskId, 'running', {
          output_log_offset: newOffset,
          last_activity_at: new Date(now).toISOString(),
        });
      } catch { /* best-effort */ }
    }
  });
  outputTail.on('error', (err) => {
    if (err && err.code === 'ENOENT') return;
    logger.info(`[Tail] re-adopted stdout error for task ${taskId}: ${err.message}`);
  });

  const errorTail = new Tail(stderrPath, { startOffset: startErrorOffset, pollIntervalMs: 250 });
  errorTail.on('chunk', (text, newOffset) => {
    processStderrChunk(taskId, text, streamId);
    const now = Date.now();
    if (now - lastStderrPersistAt >= offsetPersistThrottleMs) {
      lastStderrPersistAt = now;
      try {
        db.updateTaskStatus(taskId, 'running', {
          error_log_offset: newOffset,
          last_activity_at: new Date(now).toISOString(),
        });
      } catch { /* best-effort */ }
    }
  });
  errorTail.on('error', (err) => {
    if (err && err.code === 'ENOENT') return;
    logger.info(`[Tail] re-adopted stderr error for task ${taskId}: ${err.message}`);
  });

  outputTail.start();
  errorTail.start();
  procEntry.outputTail = outputTail;
  procEntry.errorTail = errorTail;

  const triggerFinalize = () => {
    if (procEntry.finalizing) return;
    procEntry.finalizing = true;
    if (procEntry.livenessHandle) {
      clearInterval(procEntry.livenessHandle);
      procEntry.livenessHandle = null;
    }
    setTimeout(() => {
      void finalizeDetachedTask({ taskId, task: taskShape, provider, isCodexProvider })
        .catch((err) => {
          logger.info(`[Detached] re-adopted finalize failed for task ${taskId}: ${err.message}`);
        });
    }, DETACHED_FINAL_DRAIN_MS);
  };
  procEntry.livenessHandle = setInterval(() => {
    if (procEntry.finalizing) return;
    if (!isPidAlive(subprocessPid)) {
      logger.info(`[Detached] re-adopted task ${taskId} pid ${subprocessPid} no longer alive — finalizing`);
      triggerFinalize();
    }
  }, DETACHED_LIVENESS_POLL_MS);

  try { dashboard.notifyTaskUpdated(taskId); } catch { /* non-critical */ }

  logger.info(`[Detached] re-adopted task ${taskId} pid=${subprocessPid} stdout_offset=${startOutputOffset} stderr_offset=${startErrorOffset}`);
  return true;
}

module.exports = {
  init,
  buildClaudeCliCommand,
  buildCodexCommand,
  spawnAndTrackProcess,
  spawnAndTrackProcessDetached,
  finalizeDetachedTask,
  reAdoptDetachedSubprocess,
  computeActivityAwareTimeoutDelay,
  parseProcessExitAnnotation,
  EXIT_SPAWN_INSTANT_EXIT,
  EXIT_CLOSE_HANDLER_EXCEPTION,
  EXIT_SPAWN_ERROR,
};
