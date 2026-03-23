/**
 * Debug lifecycle helpers — pause/resume/step/breakpoint functions
 * extracted from task-manager.js (Step 5 of ProcessTracker extraction).
 *
 * Uses DI via init() for circular deps (startTask, estimateProgress)
 * and lazy-load for database access (same pattern as process-lifecycle.js).
 */

const taskCore = require('../db/task-core');
const taskMetadata = require('../db/task-metadata');
const logger = require('../logger').child({ component: 'debug-lifecycle' });
const { pauseProcess } = require('./process-lifecycle');

// DI slots — set via init()
let _runningProcesses = null;
let _startTask = null;
let _estimateProgress = null;

/**
 * Initialize with dependencies that would be circular if required directly.
 *
 * @param {Object} deps
 * @param {Object} deps.runningProcesses - ProcessTracker instance
 * @param {Function} deps.startTaskFn - task-manager.startTask
 * @param {Function} deps.estimateProgressFn - task-manager.estimateProgress
 */
function init({ runningProcesses, startTaskFn, estimateProgressFn }) {
  _runningProcesses = runningProcesses;
  _startTask = startTaskFn;
  _estimateProgress = estimateProgressFn;
}

/**
 * Pause a running task (sends SIGSTOP)
 * @param {string} taskId - Task ID
 * @param {string|null} reason - Optional reason for pausing
 * @returns {boolean} True if the task was paused
 */
function pauseTask(taskId, reason = null) {
  const proc = _runningProcesses.get(taskId);
  if (!proc) {
    return false;
  }

  try {
    pauseProcess(proc, taskId, 'PauseTask');
    proc.paused = true;
    proc.pausedAt = Date.now();
    proc.pauseReason = reason;

    return true;
  } catch (err) {
    logger.info(`Failed to pause task ${taskId}:`, err.message);
    return false;
  }
}

/**
 * Resume a paused task (sends SIGCONT)
 * @param {string} taskId - Task ID
 * @returns {boolean|{ queued: boolean, task?: Object, rateLimited?: boolean, retryAfter?: number }} True if resumed, false if not, or startTask result when restarted
 */
function resumeTask(taskId) {
  const proc = _runningProcesses.get(taskId);
  if (!proc || (process.platform === 'win32' && proc.paused)) {
    // Task not in memory, or on Windows after pause (process was killed).
    // Restart from DB.
    const task = taskCore.getTask(taskId);
    if (task && (task.status === 'paused' || (proc && proc.paused))) {
      if (proc) {
        _runningProcesses.delete(taskId);
      }
      taskCore.updateTaskStatus(taskId, 'pending');
      return _startTask(taskId);
    }
    return false;
  }

  try {
    // Send SIGCONT to resume the process (Unix only — Windows handled above)
    proc.process.kill('SIGCONT');
    proc.paused = false;
    proc.pausedAt = null;
    proc.pauseReason = null;

    // Update task status
    taskCore.updateTaskStatus(taskId, 'running');

    return true;
  } catch (err) {
    logger.info(`Failed to resume task ${taskId}:`, err.message);
    return false;
  }
}

/**
 * Check if a regex pattern is safe from ReDoS attacks
 * @param {string} pattern - The regex pattern to check
 * @returns {boolean} True if pattern is safe
 */
function isSafeRegexPattern(pattern) {
  // Limit pattern length
  if (typeof pattern !== 'string' || pattern.length > 200) {
    return false;
  }
  // Detect potentially dangerous nested quantifiers like (a+)+, (a*)*
  // These can cause exponential backtracking
  if (/(\+|\*|\?|\{[^}]+\})\s*\)(\+|\*|\{[^}]+\})/.test(pattern) ||
      /\(\?[^)]*\)\+/.test(pattern)) {
    return false;
  }
  // Try to compile the pattern
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check breakpoints against output text
 * Returns the first matching breakpoint with action 'pause', or null
 * @param {string} taskId - Task ID
 * @param {string} text - Output text to scan
 * @param {string} type - Breakpoint pattern type ('output' or 'error')
 * @returns {Object|null} Matching breakpoint or null
 */
function checkBreakpoints(taskId, text, type = 'output') {
  // Use listBreakpoints with task_id and enabled filters
  const breakpoints = taskMetadata.listBreakpoints({ task_id: taskId, enabled: true });

  for (const bp of breakpoints) {
    if (bp.pattern_type !== type) continue;

    // Check max_hits limit
    if (bp.max_hits && bp.hit_count >= bp.max_hits) continue;

    // Security: Validate pattern against ReDoS before using
    if (!isSafeRegexPattern(bp.pattern)) {
      logger.info(`Unsafe or invalid breakpoint pattern (ReDoS protection): ${bp.pattern?.substring(0, 50)}`);
      continue;
    }

    try {
      const regex = new RegExp(bp.pattern, 'i');
      if (regex.test(text)) {
        // Increment hit count atomically to prevent race conditions
        taskMetadata.updateBreakpoint(bp.id, { hit_count: 'increment' });
        return bp;
      }
    } catch {
      // Invalid regex, skip
      logger.info(`Invalid breakpoint pattern: ${bp.pattern}`);
    }
  }

  return null;
}

/**
 * Pause task for debugging when breakpoint hits
 * @param {string} taskId - Task ID
 * @param {Object} breakpoint - Breakpoint record
 * @returns {boolean} True if the task was paused for debugging
 */
function pauseTaskForDebug(taskId, breakpoint) {
  const proc = _runningProcesses.get(taskId);
  if (!proc) return false;

  try {
    pauseProcess(proc, taskId, 'PauseDebug');
    proc.paused = true;
    proc.pausedAt = Date.now();
    proc.pauseReason = `Breakpoint hit: ${breakpoint.pattern}`;
    proc.debugBreakpoint = breakpoint;

    // Get or create debug session
    let session = taskMetadata.getDebugSessionByTask(taskId);
    if (!session) {
      session = taskMetadata.createDebugSession({
        id: require('crypto').randomUUID(),
        task_id: taskId,
        status: 'paused',
        current_breakpoint_id: breakpoint.id
      });
    } else {
      taskMetadata.updateDebugSession(session.id, {
        status: 'paused',
        current_breakpoint_id: breakpoint.id
      });
    }

    // Capture state
    taskMetadata.recordDebugCapture({
      session_id: session.id,
      breakpoint_id: breakpoint.id,
      output_snapshot: proc?.output?.slice(-5000) || '', // Last 5KB
      error_snapshot: proc?.errorOutput?.slice(-2000) || '', // Last 2KB
      progress_percent: _estimateProgress(proc.output, proc.provider),
      elapsed_seconds: Math.round((Date.now() - proc.startTime) / 1000)
    });

    // Update task status
    taskCore.updateTaskStatus(taskId, 'paused');

    return true;
  } catch (err) {
    logger.info(`Failed to pause task ${taskId} for debug:`, err.message);
    return false;
  }
}

/**
 * Step execution - resume to next chunk or breakpoint
 * @param {string} taskId - Task ID
 * @param {string} stepMode - Step mode (e.g., 'continue' or 'step')
 * @param {number} count - Number of chunks to step
 * @returns {{ success: boolean, error?: string, stepMode?: string, count?: number }} Result info
 */
function stepExecution(taskId, stepMode = 'continue', count = 1) {
  const proc = _runningProcesses.get(taskId);
  if (!proc || (process.platform === 'win32' && proc.paused)) {
    // Task not in memory, or on Windows after pause (process was killed).
    // Restart from DB.
    const task = taskCore.getTask(taskId);
    if (task && (task.status === 'paused' || (proc && proc.paused))) {
      if (proc) {
        _runningProcesses.delete(taskId);
      }
      taskCore.updateTaskStatus(taskId, 'pending');
      return _startTask(taskId);
    }
    return { success: false, error: 'Task not found or not paused' };
  }

  // Update debug session
  const session = taskMetadata.getDebugSessionByTask(taskId);
  if (session) {
    taskMetadata.updateDebugSession(session.id, {
      status: 'stepping',
      step_mode: stepMode
    });
  }

  // Set step mode on process
  proc.stepMode = stepMode;
  proc.stepCount = count;
  proc.stepRemaining = count;

  try {
    // Send SIGCONT to resume (Unix only — Windows handled above)
    proc.process.kill('SIGCONT');
    proc.paused = false;
    proc.pausedAt = null;
    proc.debugBreakpoint = null;

    // Update task status
    taskCore.updateTaskStatus(taskId, 'running');

    return { success: true, stepMode, count };
  } catch (err) {
    logger.info(`Failed to step task ${taskId}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ── Factory (DI Phase 3) ─────────────────────────────────────────────────

function createDebugLifecycle(_deps) {
  // _deps reserved for Phase 5 when database.js facade is removed
  return {
    init,
    pauseTask,
    resumeTask,
    isSafeRegexPattern,
    checkBreakpoints,
    pauseTaskForDebug,
    stepExecution,
  };
}

module.exports = {
  init,
  pauseTask,
  resumeTask,
  isSafeRegexPattern,
  checkBreakpoints,
  pauseTaskForDebug,
  stepExecution,
  createDebugLifecycle,
};
