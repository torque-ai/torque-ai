/**
 * Process stream handlers — stdout/stderr attachment for child processes.
 *
 * Extracted from task-manager.js setupStdoutHandler / setupStderrHandler.
 * Handles output buffering, progress estimation, completion detection,
 * stream chunk persistence, breakpoints, and step mode.
 */

const logger = require('../logger').child({ component: 'process-streams' });
const { COMPLETION_GRACE_MS, COMPLETION_GRACE_CODEX_MS } = require('../constants');
const { OutputBuffer } = require('./output-buffer');
const { normalizeMetadata } = require('../utils/normalize-metadata');
const { buildCombinedProcessOutput } = require('../validation/completion-detection');

// Dependencies injected via init()
let deps = null;

/**
 * Initialize module with dependencies from task-manager.js context.
 *
 * @param {Object} d
 * @param {Object} d.db - Database module
 * @param {Object} d.dashboard - Dashboard server module
 * @param {Map}    d.runningProcesses - Running processes map
 * @param {Map}    d.stallRecoveryAttempts - Stall recovery attempts map
 * @param {Function} d.estimateProgress - Progress estimation function
 * @param {Function} d.detectOutputCompletion - Output completion detection
 * @param {Function} d.checkBreakpoints - Breakpoint checker
 * @param {Function} d.pauseTaskForDebug - Pause task at breakpoint
 * @param {Function} d.pauseTask - Pause task (step mode)
 * @param {Function} d.extractModifiedFiles - Extract modified file paths from output
 * @param {Function} d.safeUpdateTaskStatus - Safe task status updater
 * @param {Function} d.safeDecrementHostSlot - Decrement host slot counter
 * @param {Function} d.killProcessGraceful - Graceful process kill
 * @param {number}   d.MAX_OUTPUT_BUFFER - Max output buffer size
 */
function init(d) {
  deps = d;
}

function getOrCreateOutputBuffer(taskId, fallbackProc = null) {
  const proc = deps.runningProcesses.get(taskId) || fallbackProc;
  if (!proc) {
    return null;
  }
  if (proc._outputBuffer) {
    return proc._outputBuffer;
  }

  proc._outputBuffer = new OutputBuffer({
    flushCallback: (batch) => {
      try {
        const currentProc = deps.runningProcesses.get(taskId) || proc;
        if (!currentProc) {
          return;
        }

        const estimatedProgress = deps.estimateProgress(currentProc.output || '', currentProc.provider);
        const progress = Math.max(currentProc.lastProgress || 0, estimatedProgress);
        currentProc.lastProgress = progress;
        deps.db.updateTaskProgress(taskId, progress, batch);
      } catch (err) {
        logger.info(`[Streams] Batched progress update error for task ${taskId}: ${err.message}`);
      }
    },
    maxLines: 20,
    flushIntervalMs: 500,
  });

  return proc._outputBuffer;
}

function isTaskRowStillRunning(taskId) {
  try {
    if (!deps.db || typeof deps.db.getTask !== 'function') {
      return false;
    }
    const task = deps.db.getTask(taskId);
    return task && task.status === 'running';
  } catch (err) {
    logger.info(`[Completion] Failed to read task ${taskId} during grace reconciliation: ${err.message}`);
    return false;
  }
}

function emitSyntheticCloseAfterCompletion(taskId, proc, reason) {
  if (!proc || !proc.process || typeof proc.process.emit !== 'function') {
    return false;
  }
  if (proc._completionSyntheticCloseEmitted) {
    return false;
  }

  proc._completionSyntheticCloseEmitted = true;
  logger.info(`[Completion] Task ${taskId} ${reason}. Emitting synthetic close.`);
  proc.process.emit('close', 0);
  return true;
}

function armCompletionGraceIfDetected(taskId, proc) {
  if (!proc || proc.completionDetected) {
    return;
  }

  const combinedOutput = buildCombinedProcessOutput(proc.output, proc.errorOutput);
  if (!deps.detectOutputCompletion(combinedOutput, proc.provider)) {
    return;
  }

  proc.completionDetected = true;
  const graceMs = proc.provider === 'codex' ? COMPLETION_GRACE_CODEX_MS : COMPLETION_GRACE_MS;
  logger.info(`[Completion] Task ${taskId} output indicates work is complete (provider: ${proc.provider}). Starting ${graceMs / 1000}s grace period for natural exit.`);

  const capturedProc = proc;
  proc.completionGraceHandle = setTimeout(() => {
    const stillRunning = deps.runningProcesses.get(taskId);
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
          // RB-013: Emit synthetic close event so the close-phase pipeline
          // handles validation, build checks, and status terminalization.
          // The markTaskCleanedUp guard in the close handler prevents double-fire.
          setTimeout(() => {
            const yetRunning = deps.runningProcesses.get(taskId);
            if (yetRunning && yetRunning === capturedProc && yetRunning.completionDetected) {
              logger.info(`[Completion] Task ${taskId} emitting synthetic close after taskkill.`);
              capturedProc.process.emit('close', 0);
            }
          }, 2000);
        });
      } else {
        deps.killProcessGraceful(stillRunning, taskId, 5000, 'Completion');
      }
      return;
    }

    if (!stillRunning && capturedProc.completionDetected && isTaskRowStillRunning(taskId)) {
      emitSyntheticCloseAfterCompletion(taskId, capturedProc, 'process tracking disappeared after completion grace');
    }
  }, graceMs);
}

/**
 * Attach stdout handler to child process — output buffering, progress estimation,
 * completion detection, streaming, breakpoints, and step mode.
 *
 * @param {ChildProcess} child - Spawned child process
 * @param {string} taskId - Task ID
 * @param {string} streamId - Stream ID for chunk persistence
 * @param {string} provider - Execution provider name
 */
function setupStdoutHandler(child, taskId, streamId) {
  const proc = deps.runningProcesses.get(taskId);
  getOrCreateOutputBuffer(taskId, proc);

  // Attach scout signal parser for streaming scout tasks
  if (proc && !proc._scoutSignalParser) {
    try {
      const task = deps.db.getTask(taskId);
      const meta = normalizeMetadata(task?.metadata);
      if (meta.mode === 'scout') {
        const { StreamSignalParser } = require('../diffusion/stream-signal-parser');
        const { processScoutSignal } = require('../factory/scout-signal-consumer');
        proc._scoutSignalParser = new StreamSignalParser((type, data) => {
          logger.info(`[Streams] Scout signal detected for task ${taskId}: ${type}`);
          processScoutSignal({ task, taskId, signalType: type, signalData: data, logger });
        });
      }
    } catch (err) {
      logger.info(`[Streams] Scout parser setup error for task ${taskId}: ${err.message}`);
    }
  }

  child.stdout.on('error', (err) => {
    logger.info(`[TaskManager] stdout error for task ${taskId}: ${err.message}`);
  });
  child.stdout.on('data', (data) => {
    const text = data.toString();
    const proc = deps.runningProcesses.get(taskId);
    if (!proc) return;

    if (proc.startupTimeoutHandle) {
      clearTimeout(proc.startupTimeoutHandle);
      proc.startupTimeoutHandle = null;
    }
    proc.output += text;
    proc.lastOutputAt = Date.now();
    // Scout signal detection — parse streaming markers before truncation
    if (proc._scoutSignalParser) {
      try {
        proc._scoutSignalParser.feed(text);
      } catch (err) {
        logger.info(`[Streams] Scout signal parser error for task ${taskId}: ${err.message}`);
      }
    }
    if (proc.output.length > deps.MAX_OUTPUT_BUFFER) {
      proc.output = '[...truncated...]\n' + proc.output.slice(-deps.MAX_OUTPUT_BUFFER / 2);
    }
    try {
      getOrCreateOutputBuffer(taskId, proc)?.append(text);
    } catch (err) {
      logger.info(`[Streams] Progress update error for task ${taskId}: ${err.message}`);
    }

    // Output-based completion detection for providers whose processes may linger.
    // On Windows, Codex processes often fail to emit 'exit'/'close' events reliably,
    // so completion detection is enabled for ALL providers. Provider-aware thresholds
    // in detectOutputCompletion() prevent false matches on prompt echo / banner text.
    armCompletionGraceIfDetected(taskId, proc);

    try {
      deps.db.addStreamChunk(streamId, text, 'stdout');
      proc.streamErrorCount = 0;
      deps.dashboard.notifyTaskOutput(taskId, text);
    } catch (err) {
      proc.streamErrorCount++;
      logger.info(`Stream chunk error (${proc.streamErrorCount}): ${err.message}`);
      if (proc.streamErrorCount >= 10 && !proc.streamErrorWarned) {
        proc.streamErrorWarned = true;
        logger.info(`WARNING: Task ${taskId} has ${proc.streamErrorCount} consecutive stream errors - output may be incomplete`);
      }
    }

    try {
      const hitBreakpoint = deps.checkBreakpoints(taskId, text, 'output');
      if (hitBreakpoint && hitBreakpoint.action === 'pause') {
        deps.pauseTaskForDebug(taskId, hitBreakpoint);
      }
    } catch (err) {
      if (!err.message || !err.message.includes('not open')) {
        logger.info(`[Streams] stdout breakpoint check error for task ${taskId}: ${err.message}`);
      }
    }

    if (proc.stepMode === 'step' && proc.stepRemaining > 0) {
      proc.stepRemaining--;
      if (proc.stepRemaining === 0) {
        deps.pauseTask(taskId, 'Step mode complete');
      }
    }
  });
}

/**
 * Attach stderr handler to child process — error buffering and progress for codex/claude-cli.
 *
 * @param {ChildProcess} child - Spawned child process
 * @param {string} taskId - Task ID
 * @param {string} streamId - Stream ID for chunk persistence
 */
function setupStderrHandler(child, taskId, streamId) {
  child.stderr.on('error', (err) => {
    logger.info(`[TaskManager] stderr error for task ${taskId}: ${err.message}`);
  });
  child.stderr.on('data', (data) => {
    const text = data.toString();
    const proc = deps.runningProcesses.get(taskId);
    if (!proc) return;

    if (proc.startupTimeoutHandle) {
      clearTimeout(proc.startupTimeoutHandle);
      proc.startupTimeoutHandle = null;
    }
    proc.errorOutput += text;
    if (proc.errorOutput.length > deps.MAX_OUTPUT_BUFFER) {
      proc.errorOutput = '[...truncated...]\n' + proc.errorOutput.slice(-deps.MAX_OUTPUT_BUFFER / 2);
    }

    // Only update lastOutputAt for substantive stderr content.
    // Codex emits a session banner to stderr at startup (session id, model, workdir, etc.)
    // which is NOT real output. If we keep resetting lastOutputAt on banner lines, the
    // zombie checker's 10-minute inactivity timeout never fires for stuck Codex processes.
    const isCodexBanner = (proc.provider === 'codex') &&
      text.split(/\r?\n/).every(line =>
        /^(?:OpenAI Codex|[-]{4,}|(?:workdir|model|provider|approval|sandbox|reasoning|session id):.*|\s*)$/i.test(line)
      );
    if (!isCodexBanner) {
      proc.lastOutputAt = Date.now();
    }

    if (proc.provider === 'codex' || proc.provider === 'claude-cli') {
      try {
        // Use stdout only for progress estimation — stderr banner inflates line count
        const progress = deps.estimateProgress(proc.output || '', proc.provider);
        if (progress > (proc.lastProgress || 0)) {
          proc.lastProgress = progress;
          deps.db.updateTaskProgress(taskId, progress, text);
        }
      } catch (err) {
        logger.info(`[Streams] stderr progress update error for task ${taskId}: ${err.message}`);
      }
    }

    if (!isCodexBanner) {
      armCompletionGraceIfDetected(taskId, proc);
    }

    try {
      const sequence = deps.db.addStreamChunk(streamId, text, 'stderr');
      proc.streamErrorCount = 0;
      deps.dashboard.notifyTaskOutput(taskId, {
        content: text,
        type: 'stderr',
        chunk_type: 'stderr',
        sequence,
        sequence_num: sequence,
        isStderr: true,
      });
    } catch (err) {
      proc.streamErrorCount++;
      logger.info(`Stream chunk error (${proc.streamErrorCount}): ${err.message}`);
      if (proc.streamErrorCount >= 10 && !proc.streamErrorWarned) {
        proc.streamErrorWarned = true;
        logger.info(`WARNING: Task ${taskId} has ${proc.streamErrorCount} consecutive stream errors - output may be incomplete`);
      }
    }

    try {
      const hitBreakpoint = deps.checkBreakpoints(taskId, text, 'error');
      if (hitBreakpoint && hitBreakpoint.action === 'pause') {
        deps.pauseTaskForDebug(taskId, hitBreakpoint);
      }
    } catch (err) {
      // Guard against DB-closed errors from lingering stream callbacks after test teardown
      if (!err.message || !err.message.includes('not open')) {
        logger.info(`[Streams] stderr breakpoint check error for task ${taskId}: ${err.message}`);
      }
    }
  });
}

module.exports = {
  init,
  setupStdoutHandler,
  setupStderrHandler,
};
