'use strict';

const MIN_TIMEOUT_DELAY_MS = 1;
const MIN_TIMEOUT_RESCHEDULE_MS = 1000;

function normalizeTimeoutMs(timeoutMs) {
  const parsed = Number(timeoutMs);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseMetadataObject(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_err) {
    return null;
  }
}

function firstMetadataObject(...candidates) {
  for (const candidate of candidates) {
    const parsed = parseMetadataObject(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function resolvePlanGenerationHardCapMs(...metadataCandidates) {
  const metadata = firstMetadataObject(...metadataCandidates);
  if (!metadata || metadata.factory_internal !== true || metadata.kind !== 'plan_generation') {
    return 0;
  }
  const policy = parseMetadataObject(metadata.activity_timeout_policy);
  if (!policy || policy.kind !== 'plan_generation') {
    return 0;
  }
  const maxWallClockMinutes = Number(policy.max_wall_clock_minutes);
  if (!Number.isFinite(maxWallClockMinutes) || maxWallClockMinutes <= 0) {
    return 0;
  }
  return maxWallClockMinutes * 60 * 1000;
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
 * @param {Object} [params.task] - Task row fallback for metadata
 * @param {Object} [params.metadata] - Parsed task metadata (may contain activity_timeout_policy)
 * @param {number} [params.now] - Current timestamp (default: Date.now())
 * @returns {{ action: 'extend', delayMs: number, idleMs: number, elapsedMs: number }
 *         | { action: 'timeout', idleMs: number, elapsedMs: number, reason: string }}
 */
function resolveActivityAwareTimeoutDecision({
  proc,
  timeoutMs,
  task = null,
  metadata = null,
  now = Date.now(),
} = {}) {
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const nowMs = Number(now);
  const currentTime = Number.isFinite(nowMs) ? nowMs : Date.now();

  if (!proc || typeof proc !== 'object') {
    return { action: 'timeout', idleMs: 0, elapsedMs: 0, reason: 'missing_process' };
  }
  if (!normalizedTimeoutMs) {
    return { action: 'timeout', idleMs: 0, elapsedMs: 0, reason: 'invalid_timeout' };
  }

  const startTime = Number(proc.startTime);
  if (!Number.isFinite(startTime)) {
    return { action: 'timeout', idleMs: 0, elapsedMs: 0, reason: 'missing_start_time' };
  }

  const lastOutputAt = Number(proc.lastOutputAt);
  const lastActivity = Number.isFinite(lastOutputAt) ? lastOutputAt : startTime;
  const idleMs = Math.max(0, currentTime - lastActivity);
  const elapsedMs = Math.max(0, currentTime - startTime);
  const hardCapMs = resolvePlanGenerationHardCapMs(
    metadata,
    proc.metadata,
    task?.metadata,
    task?.task_metadata
  );

  if (hardCapMs > 0 && elapsedMs >= hardCapMs) {
    return {
      action: 'timeout',
      idleMs,
      elapsedMs,
      reason: 'factory_plan_generation_hard_cap',
    };
  }

  if (idleMs >= normalizedTimeoutMs) {
    return { action: 'timeout', idleMs, elapsedMs, reason: 'idle_timeout' };
  }

  const activityDelayMs = Math.max(MIN_TIMEOUT_RESCHEDULE_MS, normalizedTimeoutMs - idleMs);
  const delayMs = hardCapMs > 0
    ? Math.min(activityDelayMs, Math.max(MIN_TIMEOUT_DELAY_MS, hardCapMs - elapsedMs))
    : activityDelayMs;

  return { action: 'extend', delayMs, idleMs, elapsedMs };
}

module.exports = {
  createActivityTimeout,
  firstMetadataObject,
  normalizeTimeoutMs,
  parseMetadataObject,
  resolveActivityAwareTimeoutDecision,
  resolvePlanGenerationHardCapMs,
};
