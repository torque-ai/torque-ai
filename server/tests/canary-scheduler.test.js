'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const { createCanaryScheduler } = require('../factory/canary-scheduler');

function makeEventBus() {
  const subs = new Map();
  return {
    on(event, fn) {
      const arr = subs.get(event) || [];
      arr.push(fn);
      subs.set(event, arr);
    },
    emit(event, payload) {
      (subs.get(event) || []).forEach((fn) => fn(payload));
    },
  };
}

describe('canary-scheduler', () => {
  let eventBus, submitTask, logger;

  beforeEach(() => {
    eventBus = makeEventBus();
    submitTask = vi.fn(() => Promise.resolve({ task_id: 'canary-123' }));
    logger = { info: vi.fn(), warn: vi.fn() };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('on circuit:tripped for codex, schedules a canary at intervalMs', () => {
    createCanaryScheduler({ eventBus, submitTask, logger, intervalMs: 100 });
    eventBus.emit('circuit:tripped', { provider: 'codex' });
    expect(submitTask).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(submitTask).toHaveBeenCalledTimes(1);
    const args = submitTask.mock.calls[0][0];
    expect(args.provider).toBe('codex');
    expect(args.is_canary).toBe(true);
  });

  it('does not schedule for non-codex providers', () => {
    createCanaryScheduler({ eventBus, submitTask, logger, intervalMs: 100 });
    eventBus.emit('circuit:tripped', { provider: 'groq' });
    vi.advanceTimersByTime(100);
    expect(submitTask).not.toHaveBeenCalled();
  });

  it('on circuit:recovered for codex, cancels the pending canary', () => {
    createCanaryScheduler({ eventBus, submitTask, logger, intervalMs: 100 });
    eventBus.emit('circuit:tripped', { provider: 'codex' });
    eventBus.emit('circuit:recovered', { provider: 'codex' });
    vi.advanceTimersByTime(200);
    expect(submitTask).not.toHaveBeenCalled();
  });

  it('reschedules if canary fails (still tripped)', async () => {
    submitTask.mockImplementationOnce(() => Promise.reject(new Error('still down')));
    createCanaryScheduler({ eventBus, submitTask, logger, intervalMs: 100 });
    eventBus.emit('circuit:tripped', { provider: 'codex' });
    vi.advanceTimersByTime(100);
    // Wait for the rejection to settle (it's async).
    await vi.runAllTimersAsync();
    expect(submitTask).toHaveBeenCalledTimes(2);
  });

  it('duplicate trip while already scheduled does not double-schedule', () => {
    createCanaryScheduler({ eventBus, submitTask, logger, intervalMs: 100 });
    eventBus.emit('circuit:tripped', { provider: 'codex' });
    eventBus.emit('circuit:tripped', { provider: 'codex' });
    vi.advanceTimersByTime(100);
    expect(submitTask).toHaveBeenCalledTimes(1);
  });

  it('throws on missing eventBus or submitTask', () => {
    expect(() => createCanaryScheduler({ submitTask, logger })).toThrow(/eventBus/);
    expect(() => createCanaryScheduler({ eventBus, logger })).toThrow(/submitTask/);
  });

  it('handles null payload without throwing', () => {
    createCanaryScheduler({ eventBus, submitTask, logger, intervalMs: 100 });
    expect(() => eventBus.emit('circuit:tripped', null)).not.toThrow();
    expect(() => eventBus.emit('circuit:recovered', undefined)).not.toThrow();
  });
});
