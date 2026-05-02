'use strict';

const MIN_TIMEOUT_DELAY_MS = 1;

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

module.exports = {
  createActivityTimeout,
  normalizeTimeoutMs,
};
