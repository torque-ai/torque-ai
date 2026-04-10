'use strict';

/**
 * Sleep Watchdog — detects system sleep/wake via timer gap analysis.
 *
 * Problem: When the workstation sleeps, Date.now() jumps forward on wake.
 * Stale/stall checks see running tasks as exceeding their timeouts and kill them.
 *
 * Solution: A 30-second watchdog timer detects gaps > 60s as sleep events.
 * On wake:
 *   1. Activates a grace period (skips stale/stall checks)
 *   2. Extends running task timeouts by the sleep duration
 *   3. Resets activity baselines so stall detection doesn't false-fire
 *   4. Logs the event
 */

const logger = require('../logger').child({ component: 'sleep-watchdog' });

const WATCHDOG_INTERVAL_MS = 30_000;        // Tick every 30s
const SLEEP_THRESHOLD_MS = 60_000;           // >60s gap = sleep detected
const GRACE_PERIOD_MS = 120_000;             // 2 min grace after wake

let lastTick = Date.now();
let gracePeriodEnd = 0;
let watchdogTimer = null;

// Injected dependencies
let _db = null;
let _runningProcesses = null;
let _logger = logger;

/**
 * Returns true if we're inside the post-wake grace period.
 * Stale and stall checks should skip when this returns true.
 */
function isInSleepGracePeriod() {
  return Date.now() < gracePeriodEnd;
}

/**
 * Returns the timestamp when the current grace period ends (0 if not active).
 */
function getGracePeriodEnd() {
  return gracePeriodEnd;
}

/**
 * Called on each watchdog tick. Detects sleep by comparing wall-clock gap
 * against the expected 30-second interval.
 */
function onTick() {
  const now = Date.now();
  const elapsed = now - lastTick;

  if (elapsed > SLEEP_THRESHOLD_MS) {
    const sleepMs = elapsed - WATCHDOG_INTERVAL_MS;
    const sleepSec = Math.round(sleepMs / 1000);
    const graceSec = Math.round(GRACE_PERIOD_MS / 1000);

    _logger.warn(`[SleepWatchdog] System wake detected — slept ~${sleepSec}s. Grace period active for ${graceSec}s.`);

    gracePeriodEnd = now + GRACE_PERIOD_MS;

    // Extend timeout_minutes for all running tasks by the sleep duration
    try {
      extendRunningTaskTimeouts(sleepMs);
    } catch (err) {
      _logger.warn(`[SleepWatchdog] Failed to extend task timeouts: ${err.message}`);
    }

    // Reset activity baselines so stall detection doesn't false-fire
    try {
      resetActivityBaselines(now);
    } catch (err) {
      _logger.warn(`[SleepWatchdog] Failed to reset activity baselines: ${err.message}`);
    }
  }

  lastTick = now;
}

/**
 * Extend timeout_minutes for all running tasks by the sleep duration.
 * This prevents the stale check from killing tasks that were paused by sleep.
 */
function extendRunningTaskTimeouts(sleepMs) {
  if (!_db) return;
  const extendMinutes = Math.ceil(sleepMs / 60_000);

  let running;
  try {
    running = typeof _db.getRunningTasks === 'function'
      ? _db.getRunningTasks()
      : (_db.prepare ? _db.prepare("SELECT * FROM tasks WHERE status = 'running'").all() : []);
  } catch {
    return;
  }

  let extended = 0;
  for (const task of running) {
    const currentTimeout = task.timeout_minutes || 480;
    const newTimeout = currentTimeout + extendMinutes;
    try {
      if (typeof _db.updateTask === 'function') {
        _db.updateTask(task.id, { timeout_minutes: newTimeout });
      } else if (_db.prepare) {
        _db.prepare('UPDATE tasks SET timeout_minutes = ? WHERE id = ?').run(newTimeout, task.id);
      }
      extended++;
    } catch {
      // Non-fatal — individual task update failure
    }
  }

  if (extended > 0) {
    _logger.info(`[SleepWatchdog] Extended timeouts for ${extended} running task(s) by ${extendMinutes}min`);
  }
}

/**
 * Reset lastOutputAt for all running processes to `now` so stall detection
 * measures from wake time, not pre-sleep time.
 */
function resetActivityBaselines(now) {
  if (!_runningProcesses) return;

  let reset = 0;
  for (const [taskId, proc] of _runningProcesses) {
    if (proc && proc.lastOutputAt) {
      proc.lastOutputAt = now;
      reset++;
    }
  }

  if (reset > 0) {
    _logger.info(`[SleepWatchdog] Reset activity baselines for ${reset} running process(es)`);
  }
}

/**
 * Start the watchdog timer.
 */
function start(deps = {}) {
  if (deps.db) _db = deps.db;
  if (deps.runningProcesses) _runningProcesses = deps.runningProcesses;
  if (deps.logger) _logger = deps.logger;

  lastTick = Date.now();
  gracePeriodEnd = 0;

  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(onTick, WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref(); // Don't prevent process exit
}

/**
 * Stop the watchdog timer.
 */
function stop() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

module.exports = {
  start,
  stop,
  isInSleepGracePeriod,
  getGracePeriodEnd,
  // Exposed for testing
  _onTick: onTick,
  _resetLastTick: (t) => { lastTick = t; },
  _setGracePeriodEnd: (t) => { gracePeriodEnd = t; },
};
