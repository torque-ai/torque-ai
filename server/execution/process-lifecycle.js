'use strict';

/**
 * Process lifecycle helpers — DRY patterns extracted from task-manager.js
 *
 * Consolidates repeated process cleanup, timeout clearing, host slot
 * decrement, and webhook trigger patterns used across close handlers,
 * error handlers, cancelTask, and stopTaskForRestart.
 *
 * D4.3: Also includes spawnAndTrackProcess and handleCloseCleanup,
 * extracted from task-manager.js to isolate all ChildProcess lifecycle
 * management in one cohesive module.
 */

const { spawn } = require('child_process');
// Lazy-load db to survive test-time module cache resets (setupTestDb)
function getDb() { return require('../database'); }
const logger = require('../logger').child({ component: 'process-lifecycle' });
const { redactCommandArgs } = require('../utils/sanitize');
const { buildCombinedProcessOutput, detectSuccessFromOutput } = require('../validation/completion-detection');
const { extractModifiedFiles } = require('../utils/file-resolution');

// Dependencies injected via init() from task-manager.js
let deps = null;

/**
 * Initialize module with dependencies from task-manager.js context.
 *
 * @param {Object} d
 * @param {Object} d.dashboard - Dashboard server module
 * @param {Map}    d.runningProcesses - ProcessTracker instance
 * @param {Function} d.finalizeTask - Task finalization function
 * @param {Function} d.cancelTask - Task cancellation function
 * @param {Function} d.processQueue - Queue processing function
 * @param {Function} d.markTaskCleanedUp - Cleanup guard function
 * @param {Function} d.safeUpdateTaskStatus - Safe status updater
 * @param {Function} d.setupStdoutHandler - Stdout handler attachment
 * @param {Function} d.setupStderrHandler - Stderr handler attachment
 * @param {Object}   d.closeHandlerState - Mutable counter { count, resolvers, drain }
 */
function init(d) {
  deps = d;
}

/**
 * Clear all timer handles on a running process tracker.
 * Safely no-ops for missing handles.
 *
 * @param {Object} proc - runningProcesses entry
 */
function clearProcTimeouts(proc) {
  if (!proc) return;
  if (proc.timeoutHandle) clearTimeout(proc.timeoutHandle);
  if (proc.startupTimeoutHandle) clearTimeout(proc.startupTimeoutHandle);
  if (proc.completionGraceHandle) clearTimeout(proc.completionGraceHandle);
}

/**
 * Decrement the host task counter for a process, swallowing errors.
 * Prevents host slot leaks on cancel, error, and restart paths.
 *
 * @param {Object} proc - runningProcesses entry (needs ollamaHostId)
 */
function safeDecrementHostSlot(proc) {
  if (proc && proc.ollamaHostId) {
    try {
      getDb().decrementHostTasks(proc.ollamaHostId);
    } catch (e) {
      logger.info(`Failed to decrement host tasks for ${proc.ollamaHostId}: ${e.message}`);
    }
  }
}

/**
 * Gracefully kill a child process: SIGTERM, then SIGKILL after a delay.
 * Both signals swallow ESRCH (process already exited).
 *
 * @param {Object} proc - runningProcesses entry (needs proc.process)
 * @param {string} taskId - For logging
 * @param {number} [killDelayMs=5000] - Delay before SIGKILL
 * @param {string} [label=''] - Log prefix (e.g. 'StallRecovery')
 */
function killProcessGraceful(proc, taskId, killDelayMs = 5000, label = '') {
  if (!proc || !proc.process) return;
  const prefix = label ? `[${label}] ` : '';

  try {
    proc.process.kill('SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      logger.info(`${prefix}Failed to send SIGTERM to task ${taskId}: ${err.message}`);
    }
  }

  // Force kill after delay — stored so callers may cancel it if the process
  // exits cleanly before killDelayMs elapses (prevents event-loop hold-open).
  const sigkillHandle = setTimeout(() => {
    try {
      proc.process.kill('SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') {
        logger.info(`${prefix}Failed to send SIGKILL to task ${taskId}: ${err.message}`);
      }
    }
  }, killDelayMs);
  // Allow tests / process-exit handlers to cancel if the process exits first
  if (proc.process.once) {
    proc.process.once('exit', () => clearTimeout(sigkillHandle));
  }
  return sigkillHandle;
}

/**
 * Kill an orphaned process by PID (no proc object available).
 * SIGTERM first, then SIGKILL after delay. Swallows ESRCH.
 * On Windows, uses taskkill for tree kill.
 *
 * @param {number} pid - Process ID to kill
 * @param {string} taskId - For logging
 * @param {number} [killDelayMs=5000] - Delay before SIGKILL
 * @param {string} [label=''] - Log prefix
 */
function killOrphanByPid(pid, taskId, killDelayMs = 5000, label = '') {
  if (!pid) return;
  const prefix = label ? `[${label}] ` : '';

  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 5000 });
      logger.info(`${prefix}Killed orphan PID ${pid} (task ${taskId}) via taskkill`);
    } catch (err) {
      if (!err.message.includes('not found')) {
        logger.info(`${prefix}Failed to kill orphan PID ${pid}: ${err.message}`);
      }
    }
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    logger.info(`${prefix}Sent SIGTERM to orphan PID ${pid} (task ${taskId})`);
  } catch (err) {
    if (err.code !== 'ESRCH') {
      logger.info(`${prefix}Failed to send SIGTERM to orphan PID ${pid}: ${err.message}`);
    }
    return; // Process already gone, no need for SIGKILL
  }

  setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') {
        logger.info(`${prefix}Failed to send SIGKILL to orphan PID ${pid}: ${err.message}`);
      }
    }
  }, killDelayMs);
}

/**
 * Pause a process: SIGSTOP on Unix, SIGTERM on Windows (no SIGSTOP support).
 * Swallows ESRCH. On Windows, falls back to taskkill for tree kill.
 *
 * @param {Object} proc - runningProcesses entry (needs proc.process)
 * @param {string} taskId - For logging
 * @param {string} [label=''] - Log prefix
 */
function pauseProcess(proc, taskId, label = '') {
  if (!proc || !proc.process) return;
  const prefix = label ? `[${label}] ` : '';

  if (process.platform === 'win32') {
    // Windows: SIGSTOP not supported. Kill process tree — resumeTask will restart from DB.
    try {
      const { execFileSync } = require('child_process');
      execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.process.pid)], { timeout: 5000 });
    } catch {
      try {
        proc.process.kill('SIGTERM');
      } catch (err) {
        if (err.code !== 'ESRCH') {
          logger.info(`${prefix}Failed to pause task ${taskId}: ${err.message}`);
        }
      }
    }
  } else {
    try {
      proc.process.kill('SIGSTOP');
    } catch (err) {
      if (err.code !== 'ESRCH') {
        logger.info(`${prefix}Failed to SIGSTOP task ${taskId}: ${err.message}`);
      }
    }
  }
}

/**
 * Trigger webhooks for a task event, swallowing errors.
 * Deduplicates the try/catch + require('./tools') pattern.
 *
 * @param {string} taskId - Task to look up
 * @param {string} eventName - Webhook event ('failed', 'completed', 'cancelled', 'timeout')
 */
function safeTriggerWebhook(taskId, eventName) {
  try {
    const updatedTask = getDb().getTask(taskId);
    const { triggerWebhooks } = require('../handlers/webhook-handlers');
    triggerWebhooks(eventName, updatedTask).catch(err => {
      logger.info('Webhook trigger error:', err.message);
    });
  } catch (webhookErr) {
    logger.info('Webhook setup error:', webhookErr.message);
  }
}

/**
 * Full process cleanup: clear timeouts + decrement host slot + remove from maps.
 * Used by close handler, error handler, and stopTaskForRestart.
 *
 * @param {Object} proc - runningProcesses entry
 * @param {string} taskId - Task ID
 * @param {Map} runningProcesses - The running processes map
 * @param {Map} stallRecoveryAttempts - The stall recovery map
 */
function cleanupProcessTracking(proc, taskId, runningProcesses, stallRecoveryAttempts) {
  if (!proc) return;
  clearProcTimeouts(proc);
  if (proc._outputBuffer) {
    proc._outputBuffer.destroy();
    proc._outputBuffer = null;
  }
  safeDecrementHostSlot(proc);
  runningProcesses.delete(taskId);
  stallRecoveryAttempts.delete(taskId);
}

/**
 * Clean up event listeners on a child process to prevent memory leaks.
 * Should be called when a process is cancelled, exits, or errors.
 *
 * @param {Object} child - Child process (from spawn/exec)
 */
function cleanupChildProcessListeners(child) {
  if (!child) return;
  try {
    if (child.stdout) {
      child.stdout.removeAllListeners('data');
      child.stdout.removeAllListeners('error');
    }
    if (child.stderr) {
      child.stderr.removeAllListeners('data');
      child.stderr.removeAllListeners('error');
    }
    child.removeAllListeners('close');
    child.removeAllListeners('error');
    child.removeAllListeners('exit');
  } catch {
    // Ignore errors during cleanup - process may already be gone
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// D4.3: Spawn + handler attachment (extracted from task-manager.js)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Phase 0: Race guard, timeout clearing, completion detection, host decrement, map cleanup.
 * Returns { shouldContinue, code, proc } or { shouldContinue: false }.
 *
 * @param {string} taskId - Task ID
 * @param {number} code - Process exit code
 * @returns {{ shouldContinue: boolean, code?: number, proc?: Object }}
 */
function handleCloseCleanup(taskId, code) {
  if (!deps.markTaskCleanedUp(taskId)) {
    return { shouldContinue: false };
  }

  const proc = deps.runningProcesses.get(taskId);

  if (proc) {
    clearProcTimeouts(proc);
    if (proc._outputBuffer) {
      proc._outputBuffer.destroy();
      proc._outputBuffer = null;
    }

    // Check combined stdout+stderr — Codex CLI writes summaries to stderr
    if (!proc.completionDetected) {
      const combinedOutput = buildCombinedProcessOutput(proc.output, proc.errorOutput);
      if (combinedOutput) {
        proc.completionDetected = detectSuccessFromOutput(combinedOutput, proc.provider);
      }
    }
    if (proc.completionDetected && code !== 0) {
      logger.info(`[Completion] Task ${taskId} exited with code ${code} but output indicated success (provider: ${proc.provider}). Treating as code 0.`);
      code = 0;
    }

    safeDecrementHostSlot(proc);
    deps.runningProcesses.delete(taskId);
    deps.runningProcesses.stallAttempts.delete(taskId);
  }

  return { shouldContinue: true, code, proc };
}

/**
 * Spawn a child process and attach lifecycle management.
 *
 * Handles: early error safety listener, stdin piping, process tracking entry
 * creation (via ProcessTracker), stream handler attachment, close/error handlers
 * (with race-guard and queue management), instant-exit detection, and timeout setup.
 *
 * Requires init() to have been called with dependencies.
 *
 * @param {string} taskId - Task ID
 * @param {Object} task - Task record from DB
 * @param {Object} config - Spawn configuration
 * @param {string} config.cliPath - Path to CLI executable
 * @param {string[]} config.finalArgs - Command arguments
 * @param {string|null} config.stdinPrompt - Prompt to pipe via stdin (claude-cli)
 * @param {Object} config.options - spawn() options (cwd, env, shell, stdio)
 * @param {string} config.provider - Execution provider name
 * @param {string|null} config.selectedOllamaHostId - Host ID for Ollama-based tasks
 * @param {string|null} config.usedEditFormat - Edit format used
 * @param {Object} config.taskMetadata - Parsed task metadata
 * @param {string} config.taskType - Classified task type
 * @param {number|null} config.contextTokenEstimate - Estimated context tokens
 * @param {string|null} config.baselineCommit - HEAD SHA before task started
 * @returns {{ queued: boolean, task?: Object }}
 */
function spawnAndTrackProcess(taskId, task, {
  cliPath, finalArgs, stdinPrompt, options, provider,
  selectedOllamaHostId, usedEditFormat, taskMetadata,
  taskType, contextTokenEstimate, baselineCommit
}) {
  const db = getDb();

  // Debug: log the actual command being executed (redact prompt-bearing args)
  logger.info(`[TaskManager] Spawning: ${cliPath} ${redactCommandArgs(finalArgs).join(' ')}`);
  logger.info(`[TaskManager] Provider: ${provider}, Working dir: ${options.cwd}`);

  // Spawn the process (using spawn, not exec, for security)
  const child = spawn(cliPath, finalArgs, options);

  // CRITICAL: Attach error listener IMMEDIATELY after spawn to prevent
  // unhandled 'error' events from crashing the process (e.g., ENOENT when
  // the CLI binary doesn't exist). The full error handler body is defined
  // later after process tracking is set up — this early listener defers
  // to it by storing the error and letting the later handler process it.
  let earlySpawnError = null;
  child.on('error', (err) => {
    if (!earlySpawnError) earlySpawnError = err;
  });

  // For claude-cli: pipe prompt via stdin to avoid cmd.exe argument mangling on Windows.
  // For all others: close stdin immediately to signal no user input.
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
  deps.runningProcesses.set(taskId, {
    process: child,
    output: '',
    errorOutput: '',
    startTime: now,
    lastOutputAt: now,          // Heartbeat: track last output activity
    stallWarned: false,         // Only warn once about stalling
    timeoutHandle: null,        // Main timeout handle
    startupTimeoutHandle: null, // Startup timeout handle
    streamErrorCount: 0,        // Track consecutive stream errors
    streamErrorWarned: false,   // Only warn once per task
    ollamaHostId: selectedOllamaHostId,  // Multi-host: track which host is running this task
    model: task.model,          // Store model for dynamic stall threshold calculation
    stall_timeout_seconds: task.stall_timeout_seconds,
    provider: provider,         // Store provider for stall detection exclusions
    taskType,                  // Store task type for stall heuristics
    metadata: taskMetadata,     // Store parsed task metadata
    contextTokenEstimate,       // Parsed context token estimate for stall thresholds
    editFormat: usedEditFormat, // Store edit format for stall recovery
    completionDetected: false,  // Output-based completion detection flag
    completionGraceHandle: null, // Timer: grace period before force-completing a lingering process
    lastProgress: 0,            // Fix F4: track last progress to avoid regression
    baselineCommit: baselineCommit,  // HEAD SHA before task started (for scoped validation)
    workingDirectory: options.cwd || null  // For filesystem-activity stall detection
  });

  // Check if spawn actually started a process (undefined PID = spawn failure on Windows)
  if (!child.pid) {
    logger.info(`[TaskManager] WARNING: spawn returned no PID for task ${taskId} - process may not have started`);
  }

  // Update task with process ID and host tracking (status already set to 'running' by tryClaimTaskSlot)
  const statusUpdate = { ollama_host_id: selectedOllamaHostId };
  if (child.pid) {
    statusUpdate.pid = child.pid;
  }
  db.updateTaskStatus(taskId, 'running', statusUpdate);
  if (baselineCommit) {
    try {
      db.updateTaskGitState(taskId, { before_sha: baselineCommit });
    } catch (err) {
      logger.info(`[TaskManager] Failed to store baseline git SHA for task ${taskId}: ${err.message}`);
    }
  }

  // Detect instant-exit: if the process entry is gone within 2 s yet the DB
  // status is still 'running', the close/error handler did not fire (or was
  // skipped). Guard: we only act when proc is absent AND status hasn't moved,
  // so a normal fast exit that the close handler already finalized is ignored.
  setTimeout(() => {
    try {
      const proc = deps.runningProcesses.get(taskId);
      if (!proc) {
        // Already cleaned up by close/error handler - check DB status
        const currentTask = db.getTask(taskId);
        if (currentTask && currentTask.status === 'running') {
          logger.info(`[TaskManager] Task ${taskId} process exited instantly but status is still 'running' - marking failed`);
          void deps.finalizeTask(taskId, {
            exitCode: -1,
            output: currentTask.output || '',
            errorOutput: 'Process exited immediately with no output (possible spawn failure or crash)',
            procState: {
              provider: currentTask.provider || provider,
            },
          }).then((result) => {
            try { deps.dashboard.notifyTaskUpdated(taskId); } catch { /* non-critical */ }
            if (!result?.queueManaged) {
              deps.processQueue();
            }
          }).catch((finalizeErr) => {
            logger.info(`[TaskManager] Instant-exit finalization failed for ${taskId}: ${finalizeErr.message}`);
          });
        }
      }
    } catch (err) {
      logger.info(`[TaskManager] Error in instant-exit check for ${taskId}: ${err.message}`);
    }
  }, 2000);

  // Notify dashboard of task start
  deps.dashboard.notifyTaskUpdated(taskId);

  // Get or create stream for this task
  const streamId = db.getOrCreateTaskStream(taskId, 'output');

  // Attach stdout/stderr handlers (output buffering, progress, completion detection)
  deps.setupStdoutHandler(child, taskId, streamId, provider);
  deps.setupStderrHandler(child, taskId, streamId);

  // Handle process completion.
  // On Windows, 'close' may never fire if stdio streams aren't properly closed
  // (common with node.exe spawns via resolved .cmd wrappers). Listen for 'exit'
  // as a fallback: if 'exit' fires but 'close' hasn't after 5s, force cleanup.
  // Guard: closeEventFired ensures the synthetic 'close' emit from the 'exit'
  // handler and the real 'close' event don't both drive finalization. The real
  // 'close' handler sets closeEventFired=true, so the setTimeout no-ops after
  // the normal path completes.
  let closeEventFired = false;
  child.on('exit', (exitCode) => {
    setTimeout(() => {
      if (!closeEventFired) {
        logger.info(`[Completion] Task ${taskId}: 'exit' fired (code ${exitCode}) but 'close' did not — forcing completion`);
        child.emit('close', exitCode);
      }
    }, 5000);
  });

  const chs = deps.closeHandlerState;

  child.on('close', async (code) => {
    chs.count++;
    closeEventFired = true;
    const cleanup = handleCloseCleanup(taskId, code);
    if (!cleanup.shouldContinue) { chs.count--; chs.drain(); return; }
    const { proc } = cleanup;
    code = cleanup.code;
    let handlerManagedQueue = false;

    try {
      const currentTask = db.getTask(taskId);
      if (currentTask && currentTask.status === 'cancelled') {
        logger.info(`[Completion] Task ${taskId} close handler skipped because task is already cancelled`);
        handlerManagedQueue = true;
        return;
      }

      if (!proc && currentTask && currentTask.status === 'running') {
        logger.info(`Close handler: proc not found for task ${taskId}, routing through task finalizer`);
      }

      const result = await deps.finalizeTask(taskId, {
        exitCode: code,
        output: proc?.output ?? currentTask?.output ?? '',
        errorOutput: proc
          ? proc.errorOutput
          : (currentTask?.error_output || 'Process tracking lost - task completed without captured output'),
        procState: proc
          ? {
              output: proc.output,
              errorOutput: proc.errorOutput,
              baselineCommit: proc.baselineCommit,
              provider: proc.provider,
              completionDetected: proc.completionDetected,
            }
          : {
              provider: currentTask?.provider || provider,
            },
        filesModified: proc
          ? extractModifiedFiles(buildCombinedProcessOutput(proc.output, proc.errorOutput))
          : [],
      });
      handlerManagedQueue = Boolean(result?.queueManaged);
    } catch (err) {
      logger.info(`Critical error in close handler for task ${taskId}:`, err.message);
      const result = await deps.finalizeTask(taskId, {
        exitCode: code || -1,
        output: proc?.output || '',
        errorOutput: proc?.errorOutput
          ? `${proc.errorOutput}\nInternal error: ${err.message}`
          : `Internal error: ${err.message}`,
        procState: proc
          ? {
              output: proc.output,
              errorOutput: proc.errorOutput,
              baselineCommit: proc.baselineCommit,
              provider: proc.provider,
            }
          : {},
      });
      handlerManagedQueue = handlerManagedQueue || Boolean(result?.queueManaged);
    } finally {
      try { deps.dashboard.notifyTaskUpdated(taskId); } catch { /* non-critical */ }
      // Skip processQueue if a handler already managed queue processing (retry/failover with backoff)
      if (!handlerManagedQueue) {
        try { deps.processQueue(); } catch (queueErr) { logger.info('Failed to process queue:', queueErr.message); }
      }
      chs.count--;
      chs.drain();
    }
  });

  // Handle process errors — replaces the early safety listener with full handler.
  // Node allows multiple listeners; remove the early one to avoid double-processing.
  child.removeAllListeners('error');
  child.on('error', async (err) => {
    let handlerManagedQueue = false;
    try {
      // SECURITY: Guard against close/error handler race condition
      // If task was already cleaned up by close handler, skip this handler
      if (!deps.markTaskCleanedUp(taskId)) {
        return; // Already cleaned up by close handler
      }

      const proc = deps.runningProcesses.get(taskId);

      // Clear timeouts and clean up process map
      cleanupProcessTracking(proc, taskId, deps.runningProcesses, deps.runningProcesses.stallAttempts);

      // If this was an Ollama-based task, invalidate health cache
      if (provider === 'ollama' || provider === 'aider-ollama') {
        db.invalidateOllamaHealth();
        logger.info(`[${provider}] Invalidated health cache due to process error`);
      }

      const result = await deps.finalizeTask(taskId, {
        exitCode: -1,
        output: proc?.output || '',
        errorOutput: `Process error: ${err.message}`,
        procState: {
          output: proc?.output || '',
          errorOutput: proc?.errorOutput || '',
          baselineCommit: proc?.baselineCommit || null,
          provider,
        },
      });
      handlerManagedQueue = Boolean(result?.queueManaged);
    } catch (handlerErr) {
      logger.error(`[StartTask] Error handler crashed for ${taskId}: ${handlerErr.message}`);
      try {
        const result = await deps.finalizeTask(taskId, {
          exitCode: -1,
          output: '',
          errorOutput: `Error handler crash: ${handlerErr.message}`,
          procState: {
            provider,
          },
        });
        handlerManagedQueue = handlerManagedQueue || Boolean(result?.queueManaged);
      } catch {
        // Finalizer is the canonical last resort; if it also fails, only log.
      }
    }
    try { deps.dashboard.notifyTaskUpdated(taskId); } catch { /* non-critical */ }
    if (!handlerManagedQueue) {
      try { deps.processQueue(); } catch (queueErr) { logger.info('Failed to process queue:', queueErr.message); }
    }
  });

  // If an error occurred during spawn before the full handler was attached,
  // re-emit it now so the proper handler processes it
  if (earlySpawnError) {
    child.emit('error', earlySpawnError);
  }

  // Get proc reference for storing timeout handles
  const procRef = deps.runningProcesses.get(taskId);
  if (!procRef) {
    logger.info(`[TaskManager] WARNING: procRef missing for task ${taskId} after spawn — error handler may have fired first`);
    return { queued: false, task: db.getTask(taskId) };
  }

  // Set up startup timeout - if no output within 60 seconds, process may be hung
  // This timeout is cleared in the stdout/stderr handlers above when output is received
  const startupTimeoutMs = 60000;
  procRef.startupTimeoutHandle = setTimeout(() => {
    try {
      const proc = deps.runningProcesses.get(taskId);
      if (proc && proc.output.length === 0 && proc.errorOutput.length === 0) {
        logger.info(`Task ${taskId} produced no output in ${startupTimeoutMs/1000}s - may be hung`);
        // Don't cancel yet, just log - the main timeout will handle it
      }
    } catch (err) {
      logger.info(`[TaskManager] Error in startup timeout callback for ${taskId}: ${err.message}`);
    }
  }, startupTimeoutMs);

  // Set up main timeout with configurable value, default 30 minutes
  // Bound timeout between 1 minute and 480 minutes (8 hours) to prevent resource exhaustion
  const MIN_TIMEOUT_MINUTES = 1;
  const MAX_TIMEOUT_MINUTES = 480;
  const rawTimeout = parseInt(task.timeout_minutes, 10) || 30;
  const boundedTimeout = Math.max(MIN_TIMEOUT_MINUTES, Math.min(rawTimeout, MAX_TIMEOUT_MINUTES));
  const timeoutMs = boundedTimeout * 60 * 1000;
  procRef.timeoutHandle = setTimeout(() => {
    try {
      if (deps.runningProcesses.has(taskId)) {
        deps.cancelTask(taskId, 'Timeout exceeded');
      }
    } catch (err) {
      logger.info(`[TaskManager] Error in timeout callback for ${taskId}: ${err.message}`);
      deps.safeUpdateTaskStatus(taskId, 'failed', {
        error_output: `Timeout cancellation error: ${err.message}`,
        exit_code: -1
      });
    }
  }, timeoutMs);

  return { queued: false, task: db.getTask(taskId) };
}

module.exports = {
  // Init
  init,
  // Original helpers
  clearProcTimeouts,
  safeDecrementHostSlot,
  killProcessGraceful,
  killOrphanByPid,
  pauseProcess,
  safeTriggerWebhook,
  cleanupProcessTracking,
  cleanupChildProcessListeners,
  // D4.3: Spawn + handler lifecycle
  handleCloseCleanup,
  spawnAndTrackProcess,
};
