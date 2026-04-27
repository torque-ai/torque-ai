'use strict';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const CANARY_TASK_DESCRIPTION =
  'Read-only canary check: confirm Codex CLI is reachable. List files in /src and report counts only — do not modify any files.';

function createCanaryScheduler({ eventBus, submitTask, logger, intervalMs }) {
  if (!eventBus) throw new Error('createCanaryScheduler requires eventBus');
  if (typeof submitTask !== 'function') throw new Error('createCanaryScheduler requires submitTask function');
  const log = logger || { info() {}, warn() {} };
  const interval = intervalMs || DEFAULT_INTERVAL_MS;
  let pendingTimer = null;
  let active = false;

  function schedule() {
    if (pendingTimer) return; // already scheduled
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      runCanary();
    }, interval);
  }

  function runCanary() {
    if (!active) return;
    log.info('[codex-fallback-2] canary probe firing');
    // Call submitTask directly (not wrapped in Promise.resolve) so the call
    // is synchronous for fake-timer tests while still supporting async results.
    submitTask({
      provider: 'codex',
      description: CANARY_TASK_DESCRIPTION,
      is_canary: true,
    }).then(() => {
      log.info('[codex-fallback-2] canary submitted successfully');
      // On success, the submitted canary task will eventually complete and
      // the close-handler's recordSuccess path will untrip the breaker,
      // emitting circuit:recovered. Do NOT reschedule here — wait for that
      // event. Rescheduling on success would cause duplicate probes while
      // the task is still running.
    }).catch((err) => {
      log.warn('[codex-fallback-2] canary submission failed', { error: err.message });
      // Submission itself failed (not the canary task). Reschedule to retry.
      if (active) schedule();
    });
  }

  function cancel() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    active = false;
  }

  eventBus.on('circuit:tripped', (payload) => {
    if (!payload || payload.provider !== 'codex') return;
    if (active) return; // already scheduled; ignore duplicate
    active = true;
    log.info('[codex-fallback-2] canary scheduler armed', { intervalMs: interval });
    schedule();
  });

  eventBus.on('circuit:recovered', (payload) => {
    if (!payload || payload.provider !== 'codex') return;
    log.info('[codex-fallback-2] canary scheduler disarmed');
    cancel();
  });

  return {};
}

module.exports = { createCanaryScheduler, DEFAULT_INTERVAL_MS, CANARY_TASK_DESCRIPTION };
