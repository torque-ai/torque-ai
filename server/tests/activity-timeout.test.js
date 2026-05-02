'use strict';

const { createActivityTimeout, normalizeTimeoutMs } = require('../utils/activity-timeout');

// Focused unit tests for the activity-aware timeout helper introduced in
// d4a8bda1 ("fix(verify): keep streaming commands from timing out"). The
// helper is used by test-runner-registry.js, plugins/remote-agents/
// agent-server.js, and remote-test-routing.js — all live verification paths.
// Coverage was indirect (via consumers); these tests pin the contract so a
// future refactor of the helper itself doesn't silently break the
// per-output-bytes timeout extension behavior.

describe('normalizeTimeoutMs', () => {
  it('returns the number unchanged for positive finite values', () => {
    expect(normalizeTimeoutMs(1000)).toBe(1000);
    expect(normalizeTimeoutMs(1.5)).toBe(1.5);
  });

  it('returns 0 for non-positive, non-finite, or non-numeric inputs', () => {
    expect(normalizeTimeoutMs(0)).toBe(0);
    expect(normalizeTimeoutMs(-1)).toBe(0);
    expect(normalizeTimeoutMs(NaN)).toBe(0);
    expect(normalizeTimeoutMs(Infinity)).toBe(0);
    expect(normalizeTimeoutMs('not a number')).toBe(0);
    expect(normalizeTimeoutMs(null)).toBe(0);
    expect(normalizeTimeoutMs(undefined)).toBe(0);
  });

  it('coerces numeric strings', () => {
    expect(normalizeTimeoutMs('250')).toBe(250);
  });
});

describe('createActivityTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onTimeout exactly once when no activity occurs', () => {
    const onTimeout = vi.fn();
    const t = createActivityTimeout({ timeoutMs: 1000, onTimeout });

    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith({ idleMs: 1000, timeoutMs: 1000 });

    // Confirm it doesn't double-fire even on long advances.
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    t.cancel();
  });

  it('extends the window when touch() is called before the deadline', () => {
    const onTimeout = vi.fn();
    let now = 0;
    const t = createActivityTimeout({
      timeoutMs: 1000,
      onTimeout,
      now: () => now,
    });

    // 700ms in: still pre-deadline. touch() resets the activity clock.
    now = 700;
    vi.advanceTimersByTime(700);
    t.touch();
    expect(onTimeout).not.toHaveBeenCalled();

    // 1700ms wall time but only 1000ms since last touch — should NOT fire yet.
    now = 1699;
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();

    // 1700ms wall time, 1000ms since last touch — fires now.
    now = 1700;
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    t.cancel();
  });

  it('reports current idle time via getIdleMs', () => {
    let now = 0;
    const t = createActivityTimeout({
      timeoutMs: 5000,
      onTimeout: () => {},
      now: () => now,
    });

    now = 100;
    expect(t.getIdleMs()).toBe(100);

    t.touch();
    expect(t.getIdleMs()).toBe(0);

    now = 300;
    expect(t.getIdleMs()).toBe(200);

    t.cancel();
  });

  it('cancel() stops the timer permanently', () => {
    const onTimeout = vi.fn();
    const t = createActivityTimeout({ timeoutMs: 1000, onTimeout });

    vi.advanceTimersByTime(500);
    t.cancel();

    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('returns a noop handle when timeoutMs is 0', () => {
    const onTimeout = vi.fn();
    const t = createActivityTimeout({ timeoutMs: 0, onTimeout });

    vi.advanceTimersByTime(60_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(t.getIdleMs()).toBe(0);

    // touch() and cancel() on a noop handle should be safe.
    expect(() => t.touch()).not.toThrow();
    expect(() => t.cancel()).not.toThrow();
  });

  it('returns a noop handle when onTimeout is not a function', () => {
    const t = createActivityTimeout({ timeoutMs: 1000, onTimeout: null });

    vi.advanceTimersByTime(2000);
    expect(t.getIdleMs()).toBe(0);
    expect(() => t.touch()).not.toThrow();
  });

  it('passes the actual idleMs in the onTimeout payload', () => {
    const onTimeout = vi.fn();
    let now = 0;
    createActivityTimeout({
      timeoutMs: 1000,
      onTimeout,
      now: () => now,
    });

    // Drift the clock so idleMs > timeoutMs at the moment the timer
    // fires (e.g. event-loop blocked, sleep grace period, etc).
    now = 1500;
    vi.advanceTimersByTime(1500);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith({ idleMs: 1500, timeoutMs: 1000 });
  });

  it('does not fire when activity keeps coming in faster than the window', () => {
    const onTimeout = vi.fn();
    let now = 0;
    const t = createActivityTimeout({
      timeoutMs: 500,
      onTimeout,
      now: () => now,
    });

    // Steady stream of activity every 100ms for 5 seconds.
    for (let elapsed = 100; elapsed <= 5000; elapsed += 100) {
      now = elapsed;
      vi.advanceTimersByTime(100);
      t.touch();
    }
    expect(onTimeout).not.toHaveBeenCalled();

    // Activity stops — fires after timeoutMs of silence.
    now = 5500;
    vi.advanceTimersByTime(500);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    t.cancel();
  });
});
