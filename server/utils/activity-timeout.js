'use strict';

const MIN_TIMEOUT_DELAY_MS = 1;
const MIN_TIMEOUT_RESCHEDULE_MS = 1000;

function normalizeTimeoutMs(timeoutMs) {
  const parsed = Number(timeoutMs);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function createActivityTimeout({ timeoutMs, onTimeout, now = () => Date.now() }) {
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  if (!normalizedTimeoutMs || typeof onTimeout !== 'function') {
    return {
      touch() {},
      cancel() {},
      getIdleMs() { return 0; },
    };
  }

  let lastActivityAt = now();
  let timer = null;
  let cancelled = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delayMs) {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (cancelled) return;

      const idleMs = Math.max(0, now() - lastActivityAt);
      if (idleMs >= normalizedTimeoutMs) {
        onTimeout({ idleMs, timeoutMs: normalizedTimeoutMs });
        return;
      }

      schedule(normalizedTimeoutMs - idleMs);
    }, Math.max(MIN_TIMEOUT_DELAY_MS, delayMs));
    timer.unref?.();
  }

  schedule(normalizedTimeoutMs);

  return {
    touch() {
      lastActivityAt = now();
    },
    cancel() {
      cancelled = true;
      clearTimer();
    },
    getIdleMs() {
      return Math.max(0, now() - lastActivityAt);
    },
  };
}

/**
 * Resolve whether a process timeout check should extend or fire.
 *
 * For ordinary tasks: extends indefinitely as long as the process produced
 * output within the timeout window (activity-aware extension).
 *
 * For factory plan_generation tasks with an activity_timeout_policy in their
 * metadata: enforces a hard wall-clock ceiling (max_wall_clock_minutes).
 * Even if the process is still producing output, the timeout fires once
 * elapsed wall time exceeds the ceiling.
 *
 * @param {Object} params
 * @param {Object} params.proc - Process tracker entry (needs lastOutputAt, startTime)
 * @param {number} params.timeoutMs - Configured idle timeout in milliseconds
 * @param {Object} [params.metadata] - Parsed task metadata (may contain activity_timeout_policy)
 * @param {number} [params.now] - Current timestamp (default: Date.now())
 * @returns {{ action: 'extend', delayMs: number, idleMs: number, elapsedMs: number }
 *         | { action: 'timeout', idleMs: number, elapsedMs: number, reason: string }}
 */
function resolveActivityAwareTimeoutDecision({ proc, timeoutMs, metadata, now }) {
  const currentTime = now ?? Date.now();

  // Invalid inputs → immediate timeout
  if (!proc || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { action: 'timeout', idleMs: 0, elapsedMs: 0, reason: 'invalid_input' };
  }

  const startTime = proc.startTime || currentTime;
  const lastActivity = proc.lastOutputAt || startTime;
  const idleMs = Math.max(0, currentTime - lastActivity);
  const elapsedMs = Math.max(0, currentTime - startTime);

  // Check factory plan_generation hard wall-clock cap
  const policy = metadata?.activity_timeout_policy;
  if (policy && policy.kind === 'plan_generation') {
    const maxWallClockMs = (Number(policy.max_wall_clock_minutes) || 0) * 60 * 1000;
    if (maxWallClockMs > 0 && elapsedMs >= maxWallClockMs) {
      return {
        action: 'timeout',
        idleMs,
        elapsedMs,
        reason: 'factory_plan_generation_wall_clock_cap',
      };
    }
  }

  // Standard activity-aware extension: if output was recent, extend
  if (idleMs >= timeoutMs) {
    return { action: 'timeout', idleMs, elapsedMs, reason: 'idle_timeout' };
  }

  const delayMs = Math.max(MIN_TIMEOUT_RESCHEDULE_MS, timeoutMs - idleMs);
  return { action: 'extend', delayMs, idleMs, elapsedMs };
}

module.exports = {
  createActivityTimeout,
  normalizeTimeoutMs,
  resolveActivityAwareTimeoutDecision,
};
