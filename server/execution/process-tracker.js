'use strict';

/**
 * ProcessTracker — typed Map wrapper for running process tracking.
 *
 * Extends Map to maintain API compatibility with all existing consumers
 * (get, set, has, delete, keys, entries, clear, size) while adding
 * domain-specific accessor methods for process lifecycle management.
 *
 * Each entry value is a process record with these fields:
 *   process              — ChildProcess instance
 *   output               — accumulated stdout string
 *   errorOutput          — accumulated stderr string
 *   startTime            — Date.now() when process was spawned
 *   lastOutputAt         — timestamp of last stdout/stderr activity
 *   stallWarned          — boolean, true after first stall warning
 *   timeoutHandle        — setTimeout handle for main timeout
 *   startupTimeoutHandle — setTimeout handle for startup timeout
 *   streamErrorCount     — count of consecutive stream errors
 *   streamErrorWarned    — boolean
 *   ollamaHostId         — host ID running this task
 *   model                — model name
 *   stall_timeout_seconds — custom stall threshold
 *   provider             — provider name
 *   taskType             — parsed task type
 *   metadata             — parsed task metadata object
 *   contextTokenEstimate — estimated context tokens
 *   editFormat           — hashline/hashline-lite/diff etc.
 *   completionDetected   — boolean
 *   completionGraceHandle — setTimeout handle for grace period
 *   lastProgress         — last reported progress percentage
 *   baselineCommit       — git SHA before task started
 *   workingDirectory     — task working directory
 *   paused               — boolean (set during pause)
 *   pausedAt             — timestamp when paused
 *   pauseReason          — string reason for pause
 *   debugBreakpoint      — breakpoint record (debug mode)
 *   stepMode             — step mode string (debug mode)
 *   stepCount            — step count (debug mode)
 *   stepRemaining        — remaining steps (debug mode)
 */
class ProcessTracker extends Map {
  /**
   * Get the child process for a task.
   * @param {string} taskId
   * @returns {ChildProcess|undefined}
   */
  getProcess(taskId) {
    const entry = this.get(taskId);
    return entry?.process;
  }

  /**
   * Get accumulated stdout output for a task.
   * @param {string} taskId
   * @returns {string|undefined}
   */
  getOutput(taskId) {
    const entry = this.get(taskId);
    return entry?.output;
  }

  /**
   * Get accumulated stderr output for a task.
   * @param {string} taskId
   * @returns {string|undefined}
   */
  getErrorOutput(taskId) {
    const entry = this.get(taskId);
    return entry?.errorOutput;
  }

  /**
   * Get elapsed time in milliseconds for a running task.
   * @param {string} taskId
   * @returns {number|undefined}
   */
  getElapsedMs(taskId) {
    const entry = this.get(taskId);
    return entry ? Date.now() - entry.startTime : undefined;
  }

  /**
   * Get the provider name for a running task.
   * @param {string} taskId
   * @returns {string|undefined}
   */
  getProvider(taskId) {
    const entry = this.get(taskId);
    return entry?.provider;
  }

  /**
   * Get the Ollama host ID for a running task.
   * @param {string} taskId
   * @returns {string|undefined}
   */
  getHostId(taskId) {
    const entry = this.get(taskId);
    return entry?.ollamaHostId;
  }

  /**
   * Update the heartbeat timestamp (last output activity).
   * @param {string} taskId
   */
  updateHeartbeat(taskId) {
    const entry = this.get(taskId);
    if (entry) {
      entry.lastOutputAt = Date.now();
    }
  }

  /**
   * Get seconds since last output activity.
   * @param {string} taskId
   * @returns {number|undefined} Seconds since last output, or undefined if not tracked
   */
  getIdleSeconds(taskId) {
    const entry = this.get(taskId);
    if (!entry) return undefined;
    return (Date.now() - entry.lastOutputAt) / 1000;
  }

  /**
   * Get count of running processes (alias for size).
   * @returns {number}
   */
  get count() {
    return this.size;
  }

  /**
   * Clear all timeout handles for a task before removing it.
   * Prevents timer leaks when processes are cleaned up.
   * @param {string} taskId
   * @returns {boolean} True if entry existed and was deleted
   */
  clearAndDelete(taskId) {
    const entry = this.get(taskId);
    if (!entry) return false;
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    if (entry.startupTimeoutHandle) clearTimeout(entry.startupTimeoutHandle);
    if (entry.completionGraceHandle) clearTimeout(entry.completionGraceHandle);
    return this.delete(taskId);
  }

  /**
   * Kill the child process for a task.
   * @param {string} taskId
   * @param {string} [signal='SIGTERM'] — signal to send
   * @returns {boolean} True if the process was killed, false if not found or already dead
   */
  killProcess(taskId, signal = 'SIGTERM') {
    const entry = this.get(taskId);
    if (!entry?.process) return false;
    try {
      entry.process.kill(signal);
      return true;
    } catch {
      // Process may already be dead — silently ignore
      return false;
    }
  }

  /**
   * Append a string chunk to the task's accumulated stdout.
   * Also updates the lastOutputAt timestamp.
   * @param {string} taskId
   * @param {string} chunk — data to append
   * @returns {number} New total output length, or -1 if entry not found
   */
  appendOutput(taskId, chunk) {
    const entry = this.get(taskId);
    if (!entry) return -1;
    entry.output = (entry.output || '') + chunk;
    entry.lastOutputAt = Date.now();
    return entry.output.length;
  }

  /**
   * Append a string chunk to the task's accumulated stderr.
   * Also updates the lastOutputAt timestamp.
   * @param {string} taskId
   * @param {string} chunk — data to append
   * @returns {number} New total error output length, or -1 if entry not found
   */
  appendErrorOutput(taskId, chunk) {
    const entry = this.get(taskId);
    if (!entry) return -1;
    entry.errorOutput = (entry.errorOutput || '') + chunk;
    entry.lastOutputAt = Date.now();
    return entry.errorOutput.length;
  }

  /**
   * Return a frozen shallow copy of the entry for safe read-only inspection.
   * @param {string} taskId
   * @returns {Readonly<Object>|null} Frozen copy of the entry, or null if not found
   */
  snapshot(taskId) {
    const entry = this.get(taskId);
    if (!entry) return null;
    return Object.freeze({ ...entry });
  }

  // ─── Stall Recovery Tracking ──────────────────────────────────────────────

  /**
   * Internal stall recovery attempts map.
   * Absorbs the standalone `stallRecoveryAttempts` Map from task-manager.
   * @private
   */
  _stallAttempts = new Map();

  /**
   * Backward-compatible accessor for the stall attempts Map.
   * Consumers that previously received stallRecoveryAttempts as a separate
   * dependency can use this getter transparently.
   * @returns {Map}
   */
  get stallAttempts() {
    return this._stallAttempts;
  }

  /**
   * Get stall recovery state for a task.
   * @param {string} taskId
   * @returns {{ attempts: number, lastStrategy: string }|undefined}
   */
  getStallAttempts(taskId) {
    return this._stallAttempts.get(taskId);
  }

  /**
   * Set stall recovery state for a task.
   * @param {string} taskId
   * @param {{ attempts: number, lastStrategy: string }} record
   */
  setStallAttempts(taskId, record) {
    this._stallAttempts.set(taskId, record);
  }

  /**
   * Delete stall recovery state for a task.
   * @param {string} taskId
   * @returns {boolean}
   */
  deleteStallAttempts(taskId) {
    return this._stallAttempts.delete(taskId);
  }

  // ─── API Abort Controllers ──────────────────────────────────────────────

  /**
   * Internal abort controller map for API provider tasks.
   * Absorbs the standalone `apiAbortControllers` Map from task-manager.
   * @private
   */
  _abortControllers = new Map();

  /**
   * Backward-compatible accessor for the abort controllers Map.
   * @returns {Map}
   */
  get abortControllers() {
    return this._abortControllers;
  }

  /**
   * Register an abort controller for an API task.
   * @param {string} taskId
   * @param {AbortController} controller
   */
  setAbortController(taskId, controller) {
    this._abortControllers.set(taskId, controller);
  }

  /**
   * Get the abort controller for an API task.
   * @param {string} taskId
   * @returns {AbortController|undefined}
   */
  getAbortController(taskId) {
    return this._abortControllers.get(taskId);
  }

  /**
   * Remove and return the abort controller for an API task.
   * @param {string} taskId
   * @returns {boolean}
   */
  deleteAbortController(taskId) {
    return this._abortControllers.delete(taskId);
  }

  // ─── Pending Retry Timeouts ────────────────────────────────────────────

  /**
   * Internal map of pending retry timeout handles.
   * Absorbs the standalone `pendingRetryTimeouts` Map from task-manager.
   * @private
   */
  _retryTimeouts = new Map();

  /**
   * Backward-compatible accessor for the retry timeouts Map.
   * @returns {Map}
   */
  get retryTimeouts() {
    return this._retryTimeouts;
  }

  /**
   * Schedule a retry timeout for a task.
   * @param {string} taskId
   * @param {NodeJS.Timeout} handle
   */
  setRetryTimeout(taskId, handle) {
    this._retryTimeouts.set(taskId, handle);
  }

  /**
   * Get the retry timeout handle for a task.
   * @param {string} taskId
   * @returns {NodeJS.Timeout|undefined}
   */
  getRetryTimeout(taskId) {
    return this._retryTimeouts.get(taskId);
  }

  /**
   * Cancel and remove a pending retry timeout.
   * @param {string} taskId
   * @returns {boolean}
   */
  cancelRetryTimeout(taskId) {
    const handle = this._retryTimeouts.get(taskId);
    if (handle !== undefined) {
      clearTimeout(handle);
    }
    return this._retryTimeouts.delete(taskId);
  }

  /**
   * Cancel all pending retry timeouts.
   */
  cancelAllRetryTimeouts() {
    for (const [, handle] of this._retryTimeouts) {
      clearTimeout(handle);
    }
    this._retryTimeouts.clear();
  }

  // ─── Cleanup Guard ─────────────────────────────────────────────────────

  /**
   * Internal cleanup guard map (taskId -> timestamp).
   * Prevents double processing of close/error handlers.
   * Absorbs the standalone `taskCleanupGuard` Map from task-manager.
   * @private
   */
  _cleanupGuard = new Map();
  _cleanupGuardTtlMs = 60000;
  _cleanupSweepIntervalMs = 30000;
  _lastCleanupSweep = 0;

  /**
   * Backward-compatible accessor for the cleanup guard Map.
   * @returns {Map}
   */
  get cleanupGuard() {
    return this._cleanupGuard;
  }

  /**
   * Mark a task as cleaned up. Returns true if this is the first cleanup
   * (should proceed), false if already cleaned up.
   * Includes periodic TTL sweep of expired entries.
   * @param {string} taskId
   * @returns {boolean}
   */
  markCleanedUp(taskId) {
    const now = Date.now();

    // Periodically sweep expired entries
    if (this._cleanupGuard.size > 0 && now - this._lastCleanupSweep > this._cleanupSweepIntervalMs) {
      this._lastCleanupSweep = now;
      for (const [id, timestamp] of this._cleanupGuard) {
        if (now - timestamp > this._cleanupGuardTtlMs) {
          this._cleanupGuard.delete(id);
        }
      }
    }

    if (this._cleanupGuard.has(taskId)) {
      return false; // Already cleaned up
    }

    this._cleanupGuard.set(taskId, now);
    return true; // First cleanup, proceed
  }

  /**
   * Remove cleanup guard for a task (e.g., before retry).
   * @param {string} taskId
   * @returns {boolean}
   */
  clearCleanupGuard(taskId) {
    return this._cleanupGuard.delete(taskId);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  /**
   * Full cleanup for a task: clear timeouts, delete from all maps.
   * Consolidates the pattern from cleanupProcessTracking in process-lifecycle.js.
   * @param {string} taskId
   * @returns {boolean} True if the entry existed and was cleaned up
   */
  cleanup(taskId) {
    const entry = this.get(taskId);
    if (!entry) {
      this._stallAttempts.delete(taskId);
      return false;
    }
    // Clear all timeout handles
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    if (entry.startupTimeoutHandle) clearTimeout(entry.startupTimeoutHandle);
    if (entry.completionGraceHandle) clearTimeout(entry.completionGraceHandle);
    // Cancel any pending retry timeout
    this.cancelRetryTimeout(taskId);
    // Remove from all maps
    this.delete(taskId);
    this._stallAttempts.delete(taskId);
    this._abortControllers.delete(taskId);
    return true;
  }

  /**
   * Clean up all tracked processes (for shutdown).
   * Iterates all entries and clears their timeouts.
   */
  cleanupAll() {
    for (const taskId of this.keys()) {
      this.cleanup(taskId);
    }
  }

  /**
   * Reset all internal state (for testing).
   */
  resetAll() {
    // Test resets must not silently orphan real child processes. Several
    // integration tests replace child_process.spawn with mocks; if a real
    // process slipped through, clear it before dropping the only handle.
    for (const entry of this.values()) {
      if (entry?.timeoutHandle) clearTimeout(entry.timeoutHandle);
      if (entry?.startupTimeoutHandle) clearTimeout(entry.startupTimeoutHandle);
      if (entry?.completionGraceHandle) clearTimeout(entry.completionGraceHandle);
      const child = entry?.process;
      if (child && typeof child.kill === 'function' && !child.killed) {
        try { child.kill('SIGTERM'); } catch { /* process may already be gone */ }
      }
    }
    // Clear pending retry timeouts first (cancel timers)
    this.cancelAllRetryTimeouts();
    this.clear();
    this._stallAttempts.clear();
    this._abortControllers.clear();
    this._cleanupGuard.clear();
  }

  // ─── Query Methods ────────────────────────────────────────────────────────

  /**
   * Get count of running processes.
   * @returns {number}
   */
  getRunningCount() {
    return this.size;
  }

  /**
   * Check if a process is tracked for the given task.
   * @param {string} taskId
   * @returns {boolean}
   */
  hasProcess(taskId) {
    return this.has(taskId);
  }
}

module.exports = ProcessTracker;
