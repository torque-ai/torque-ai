'use strict';
import { describe, it, expect } from 'vitest';
const { createStateStore } = require('../coord/state');
const { reapStaleLocks, startReaper } = require('../coord/reaper');

const HOLDER = { host: 'omen', pid: 1, user: 'k' };

describe('coord reaper', () => {
  it('force-releases locks whose last_heartbeat_at is older than threshold', () => {
    const store = createStateStore({ max_concurrent_runs: 2 });
    const fresh = store.acquire({ project: 'p1', sha: 'a', suite: 'gate', holder: HOLDER });
    const stale = store.acquire({ project: 'p2', sha: 'b', suite: 'gate', holder: HOLDER });
    store.getLock(stale.lock_id).last_heartbeat_at =
      new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const result = reapStaleLocks(store, { stale_lock_threshold_ms: 90 * 1000, now: Date.now() });
    expect(result.reaped).toEqual([stale.lock_id]);
    expect(store.listActive().map((l) => l.lock_id)).toEqual([fresh.lock_id]);
  });

  it('reaps zero locks when all heartbeats are fresh', () => {
    const store = createStateStore({ max_concurrent_runs: 2 });
    store.acquire({ project: 'p1', sha: 'a', suite: 'gate', holder: HOLDER });
    const result = reapStaleLocks(store, { stale_lock_threshold_ms: 90 * 1000, now: Date.now() });
    expect(result.reaped).toEqual([]);
  });

  it('startReaper schedules periodic scans and stop() halts them', async () => {
    const store = createStateStore({ max_concurrent_runs: 2 });
    const stale = store.acquire({ project: 'p1', sha: 'a', suite: 'gate', holder: HOLDER });
    store.getLock(stale.lock_id).last_heartbeat_at =
      new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const handle = startReaper(store, { stale_lock_threshold_ms: 90 * 1000, reaper_tick_ms: 30 });
    await new Promise((r) => setTimeout(r, 100));
    expect(store.listActive()).toHaveLength(0);
    handle.stop();
  });
});
