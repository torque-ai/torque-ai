'use strict';

const { normalizeTaskStartOutcome } = require('../utils/task-start-outcome');

describe('normalizeTaskStartOutcome', () => {
  it('preserves legacy true semantics', () => {
    expect(normalizeTaskStartOutcome(true)).toEqual({
      started: true,
      queued: false,
      pendingAsync: false,
      failed: false,
    });
  });

  it('preserves legacy falsey semantics', () => {
    expect(normalizeTaskStartOutcome(false)).toEqual({
      started: false,
      queued: false,
      pendingAsync: false,
      failed: true,
    });
  });

  it('normalizes structured started, queued, pending async, and failed flags', () => {
    expect(normalizeTaskStartOutcome({
      started: true,
      queued: true,
      pendingAsync: true,
      failed: true,
    })).toEqual({
      started: true,
      queued: true,
      pendingAsync: true,
      failed: true,
      reason: undefined,
      code: undefined,
      error: undefined,
    });
  });

  it('preserves structured failure details', () => {
    const error = new Error('preflight rejected');

    expect(normalizeTaskStartOutcome({
      failed: true,
      reason: 'preflight_failed',
      code: 'PREFLIGHT_FAILED',
      error,
    })).toEqual({
      started: false,
      queued: false,
      pendingAsync: false,
      failed: true,
      reason: 'preflight_failed',
      code: 'PREFLIGHT_FAILED',
      error,
    });
  });

  it('treats unstructured objects as legacy truthy results', () => {
    expect(normalizeTaskStartOutcome({ task: { id: 'task-1' } })).toEqual({
      started: true,
      queued: false,
      pendingAsync: false,
      failed: false,
    });
  });
});
