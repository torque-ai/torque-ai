'use strict';

function reapStaleLocks(store, { stale_lock_threshold_ms, now = Date.now() }) {
  const reaped = [];
  for (const lock of store.listActive()) {
    const age = now - Date.parse(lock.last_heartbeat_at);
    if (age > stale_lock_threshold_ms) {
      store.forceRelease(lock.lock_id, { reason: 'stale_heartbeat' });
      reaped.push(lock.lock_id);
    }
  }
  return { reaped };
}

function startReaper(store, { stale_lock_threshold_ms, reaper_tick_ms }) {
  const timer = setInterval(() => {
    reapStaleLocks(store, { stale_lock_threshold_ms });
  }, reaper_tick_ms);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}

module.exports = { reapStaleLocks, startReaper };
