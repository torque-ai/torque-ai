'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const breaker = require('../execution/circuit-breaker');

const {
  STATES,
  FAILURE_THRESHOLD,
  BASE_RECOVERY_MS,
  classifyFailure,
} = breaker;

function tripCircuit(provider, errorOutput = 'ECONNREFUSED: connection refused') {
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    breaker.recordFailure(provider, errorOutput);
  }
}

describe('circuit-breaker', () => {
  beforeEach(() => {
    breaker._reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T00:00:00.000Z'));
  });

  afterEach(() => {
    breaker._reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts in CLOSED state', () => {
    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.CLOSED,
      consecutiveFailures: 0,
      lastFailureCategory: null,
      trippedAt: null,
      recoveryTimeoutMs: BASE_RECOVERY_MS,
    });
  });

  it('stays CLOSED below threshold', () => {
    breaker.recordFailure('deepinfra', 'ECONNREFUSED: refused');
    breaker.recordFailure('deepinfra', 'ETIMEDOUT while connecting');

    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.CLOSED,
      consecutiveFailures: 2,
      lastFailureCategory: 'connectivity',
      trippedAt: null,
      recoveryTimeoutMs: BASE_RECOVERY_MS,
    });
  });

  it('trips to OPEN after 3 consecutive failures', () => {
    tripCircuit('deepinfra');

    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.OPEN,
      consecutiveFailures: 3,
      lastFailureCategory: 'connectivity',
      trippedAt: Date.now(),
      recoveryTimeoutMs: BASE_RECOVERY_MS,
    });
  });

  it('blocks requests when OPEN', () => {
    tripCircuit('deepinfra');

    expect(breaker.allowRequest('deepinfra')).toBe(false);
  });

  it('transitions to HALF_OPEN after recovery timeout', () => {
    tripCircuit('deepinfra');

    vi.advanceTimersByTime(BASE_RECOVERY_MS);

    expect(breaker.allowRequest('deepinfra')).toBe(true);
    expect(breaker.getState('deepinfra').state).toBe(STATES.HALF_OPEN);
  });

  it('closes on probe success', () => {
    tripCircuit('deepinfra');
    vi.advanceTimersByTime(BASE_RECOVERY_MS);

    expect(breaker.allowRequest('deepinfra')).toBe(true);

    breaker.recordSuccess('deepinfra');

    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.CLOSED,
      consecutiveFailures: 0,
      lastFailureCategory: null,
      trippedAt: null,
      recoveryTimeoutMs: BASE_RECOVERY_MS,
    });
  });

  it('re-trips on probe failure with doubled timeout', () => {
    tripCircuit('deepinfra');
    vi.advanceTimersByTime(BASE_RECOVERY_MS);

    expect(breaker.allowRequest('deepinfra')).toBe(true);

    breaker.recordFailure('deepinfra', '429 too many requests');

    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.OPEN,
      consecutiveFailures: 1,
      lastFailureCategory: 'rate_limit',
      trippedAt: Date.now(),
      recoveryTimeoutMs: BASE_RECOVERY_MS * 2,
    });
  });

  it('resets on success', () => {
    breaker.recordFailure('deepinfra', 'ECONNREFUSED');
    breaker.recordFailure('deepinfra', 'ETIMEDOUT');

    breaker.recordSuccess('deepinfra');

    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.CLOSED,
      consecutiveFailures: 0,
      lastFailureCategory: null,
      trippedAt: null,
      recoveryTimeoutMs: BASE_RECOVERY_MS,
    });
  });

  it.each([
    ['ECONNREFUSED while dialing', 'connectivity'],
    ['429 too many requests from upstream', 'rate_limit'],
    ['403 forbidden for this API key', 'auth'],
    ['Worker hit OOM during execution', 'resource'],
    ['unexpected provider failure', 'unknown'],
  ])('classifies failure categories correctly: %s', (message, expectedCategory) => {
    expect(classifyFailure(message)).toBe(expectedCategory);
  });

  it('getAllOpenCircuits returns only non-CLOSED', () => {
    tripCircuit('deepinfra');
    tripCircuit('anthropic');
    breaker.recordFailure('ollama', 'ECONNREFUSED');
    breaker.recordFailure('ollama', 'ETIMEDOUT');

    vi.advanceTimersByTime(BASE_RECOVERY_MS);
    expect(breaker.allowRequest('anthropic')).toBe(true);

    expect(breaker.getAllOpenCircuits().sort()).toEqual(['anthropic', 'deepinfra']);
  });
});
