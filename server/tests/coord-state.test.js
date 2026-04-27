'use strict';
import { describe, it, expect, beforeEach } from 'vitest';
const { createStateStore } = require('../coord/state');

const HOLDER = { host: 'omen', pid: 1234, user: 'kenten' };

describe('coord state store', () => {
  let store;

  beforeEach(() => {
    store = createStateStore({ max_concurrent_runs: 2 });
  });

  it('acquire on a free project returns acquired:true with a lock_id', () => {
    const result = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    expect(result.acquired).toBe(true);
    expect(typeof result.lock_id).toBe('string');
    expect(store.listActive()).toHaveLength(1);
  });

  it('second acquire on same project returns 202 wait_for the existing lock_id', () => {
    const first = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const second = store.acquire({ project: 'torque-public', sha: 'def', suite: 'gate', holder: HOLDER });
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe('project_held');
    expect(second.wait_for).toBe(first.lock_id);
  });

  it('acquire on a different project succeeds independently', () => {
    store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const other = store.acquire({ project: 'dlphone', sha: 'xyz', suite: 'gate', holder: HOLDER });
    expect(other.acquired).toBe(true);
    expect(store.listActive()).toHaveLength(2);
  });

  it('global semaphore blocks the third acquire when max_concurrent_runs is 2', () => {
    store.acquire({ project: 'p1', sha: 'a', suite: 'gate', holder: HOLDER });
    store.acquire({ project: 'p2', sha: 'b', suite: 'gate', holder: HOLDER });
    const third = store.acquire({ project: 'p3', sha: 'c', suite: 'gate', holder: HOLDER });
    expect(third.acquired).toBe(false);
    expect(third.reason).toBe('global_semaphore_full');
    expect(third.wait_for).toBeNull();
  });

  it('release frees the project lock so a new acquire succeeds', () => {
    const first = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const released = store.release(first.lock_id, { exit_code: 0, suite_status: 'pass', output_tail: 'ok' });
    expect(released.released).toBe(true);
    expect(store.listActive()).toHaveLength(0);
    const next = store.acquire({ project: 'torque-public', sha: 'def', suite: 'gate', holder: HOLDER });
    expect(next.acquired).toBe(true);
  });

  it('heartbeat updates last_heartbeat_at and appends bounded log_chunk', () => {
    const first = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const before = store.getLock(first.lock_id).last_heartbeat_at;
    const fakeNow = Date.parse(before) + 1000;
    store.heartbeat(first.lock_id, { log_chunk: 'still running\n', now: fakeNow });
    const after = store.getLock(first.lock_id);
    expect(Date.parse(after.last_heartbeat_at)).toBe(fakeNow);
    expect(after.output_buffer).toContain('still running');
  });

  it('heartbeat output_buffer is bounded to ~1MB', () => {
    const first = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const big = 'x'.repeat(600 * 1024);
    store.heartbeat(first.lock_id, { log_chunk: big });
    store.heartbeat(first.lock_id, { log_chunk: big });
    const lock = store.getLock(first.lock_id);
    expect(lock.output_buffer.length).toBeLessThanOrEqual(1024 * 1024);
    expect(lock.output_buffer.endsWith(big)).toBe(true);
  });

  it('release on unknown lock_id returns released:false', () => {
    const result = store.release('does-not-exist', { exit_code: 0 });
    expect(result.released).toBe(false);
    expect(result.reason).toBe('unknown_lock');
  });

  it('forceRelease marks the lock crashed and frees the project slot', () => {
    const first = store.acquire({ project: 'torque-public', sha: 'abc', suite: 'gate', holder: HOLDER });
    const out = store.forceRelease(first.lock_id, { reason: 'stale_heartbeat' });
    expect(out.released).toBe(true);
    expect(out.crashed).toBe(true);
    expect(store.listActive()).toHaveLength(0);
  });
});
