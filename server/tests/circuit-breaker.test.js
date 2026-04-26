'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const { createCircuitBreaker, classifyFailure, STATES } = require('../execution/circuit-breaker');

const TEST_CONFIG = {
  threshold: 3,
  baseRecoveryTimeoutMs: 100,
  maxRecoveryTimeoutMs: 1000,
  backoffMultiplier: 2,
};

function tripCircuit(breaker, provider, errorOutput = 'ECONNREFUSED: connection refused', count = 3) {
  for (let index = 0; index < count; index += 1) {
    breaker.recordFailure(provider, errorOutput);
  }
}

describe('circuit-breaker', () => {
  let breaker;
  let eventBus;

  beforeEach(() => {
    eventBus = {
      emit: vi.fn(),
    };
    breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts in CLOSED state', () => {
    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.CLOSED,
      consecutiveFailures: 0,
      lastFailureCategory: null,
      trippedAt: null,
      recoveryTimeoutMs: TEST_CONFIG.baseRecoveryTimeoutMs,
      currentProbeAllowed: false,
    });
  });

  it('CLOSED by default, allowRequest returns true', () => {
    expect(breaker.allowRequest('deepinfra')).toBe(true);
  });

  it('recordSuccess is a no-op on CLOSED circuit', () => {
    breaker.recordSuccess('deepinfra');

    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.CLOSED,
      consecutiveFailures: 0,
      lastFailureCategory: null,
      trippedAt: null,
      recoveryTimeoutMs: TEST_CONFIG.baseRecoveryTimeoutMs,
      currentProbeAllowed: false,
    });
  });

  it('single failure does not trip', () => {
    breaker.recordFailure('deepinfra', 'ECONNREFUSED: refused');

    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.CLOSED,
      consecutiveFailures: 1,
      lastFailureCategory: 'connectivity',
      trippedAt: null,
      recoveryTimeoutMs: TEST_CONFIG.baseRecoveryTimeoutMs,
      currentProbeAllowed: false,
    });
  });

  it('3 consecutive same-category failures trip the circuit', () => {
    tripCircuit(breaker, 'deepinfra');

    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.OPEN,
      consecutiveFailures: 3,
      lastFailureCategory: 'connectivity',
      trippedAt: Date.now(),
      recoveryTimeoutMs: TEST_CONFIG.baseRecoveryTimeoutMs,
      currentProbeAllowed: false,
    });
  });

  it('isOpen returns true after tripping', () => {
    tripCircuit(breaker, 'deepinfra');

    expect(breaker.isOpen('deepinfra')).toBe(true);
  });

  it('allowRequest returns false when OPEN', () => {
    tripCircuit(breaker, 'deepinfra');

    expect(breaker.allowRequest('deepinfra')).toBe(false);
  });

  it('after recovery timeout, isHalfOpen returns true', () => {
    tripCircuit(breaker, 'deepinfra');
    vi.advanceTimersByTime(TEST_CONFIG.baseRecoveryTimeoutMs);

    expect(breaker.isHalfOpen('deepinfra')).toBe(true);
  });

  it('allowRequest returns true for first request in HALF_OPEN', () => {
    tripCircuit(breaker, 'deepinfra');
    vi.advanceTimersByTime(TEST_CONFIG.baseRecoveryTimeoutMs);

    expect(breaker.allowRequest('deepinfra')).toBe(true);
  });

  it('allowRequest returns false for second request in HALF_OPEN', () => {
    tripCircuit(breaker, 'deepinfra');
    vi.advanceTimersByTime(TEST_CONFIG.baseRecoveryTimeoutMs);

    expect(breaker.allowRequest('deepinfra')).toBe(true);
    expect(breaker.allowRequest('deepinfra')).toBe(false);
  });

  it('recordSuccess in HALF_OPEN closes the circuit', () => {
    tripCircuit(breaker, 'deepinfra');
    vi.advanceTimersByTime(TEST_CONFIG.baseRecoveryTimeoutMs);

    expect(breaker.allowRequest('deepinfra')).toBe(true);
    breaker.recordSuccess('deepinfra');

    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.CLOSED,
      consecutiveFailures: 0,
      lastFailureCategory: null,
      trippedAt: null,
      recoveryTimeoutMs: TEST_CONFIG.baseRecoveryTimeoutMs,
      currentProbeAllowed: false,
    });
  });

  it('recordFailure in HALF_OPEN re-trips with doubled timeout', () => {
    tripCircuit(breaker, 'deepinfra');
    vi.advanceTimersByTime(TEST_CONFIG.baseRecoveryTimeoutMs);

    expect(breaker.allowRequest('deepinfra')).toBe(true);
    breaker.recordFailure('deepinfra', '429 too many requests');

    expect(breaker.getState('deepinfra')).toEqual({
      state: STATES.OPEN,
      consecutiveFailures: 1,
      lastFailureCategory: 'rate_limit',
      trippedAt: Date.now(),
      recoveryTimeoutMs: TEST_CONFIG.baseRecoveryTimeoutMs * TEST_CONFIG.backoffMultiplier,
      currentProbeAllowed: false,
    });
  });

  it('max recovery timeout is capped', () => {
    tripCircuit(breaker, 'deepinfra');
    vi.advanceTimersByTime(TEST_CONFIG.baseRecoveryTimeoutMs);
    breaker.recordFailure('deepinfra', '429 too many requests');

    vi.advanceTimersByTime(TEST_CONFIG.baseRecoveryTimeoutMs * 2);
    breaker.recordFailure('deepinfra', '429 too many requests');

    vi.advanceTimersByTime(TEST_CONFIG.baseRecoveryTimeoutMs * 4);
    breaker.recordFailure('deepinfra', '429 too many requests');

    vi.advanceTimersByTime(TEST_CONFIG.baseRecoveryTimeoutMs * 8);
    breaker.recordFailure('deepinfra', '429 too many requests');

    expect(breaker.getState('deepinfra').recoveryTimeoutMs).toBe(1000);
  });

  it('classifyFailure: ECONNREFUSED => connectivity', () => {
    expect(classifyFailure('connect ECONNREFUSED')).toBe('connectivity');
  });

  it('classifyFailure: 429 => rate_limit', () => {
    expect(classifyFailure('429')).toBe('rate_limit');
  });

  it('classifyFailure: 401 => auth', () => {
    expect(classifyFailure('401')).toBe('auth');
  });

  it('classifyFailure: OOM => resource', () => {
    expect(classifyFailure('OOM')).toBe('resource');
  });

  it('classifyFailure: random text => unknown', () => {
    expect(classifyFailure('random gibberish')).toBe('unknown');
  });

  it('mixed categories reset consecutive failure count', () => {
    breaker.recordFailure('deepinfra', 'ECONNREFUSED');
    breaker.recordFailure('deepinfra', 'ECONNREFUSED');
    breaker.recordFailure('deepinfra', 'ECONNREFUSED');
    breaker.recordFailure('deepinfra', '401 unauthorized');

    expect(breaker.getState('deepinfra').consecutiveFailures).toBe(1);
    expect(breaker.getState('deepinfra').lastFailureCategory).toBe('auth');
  });

  it('eventBus emits on trip and recovery', () => {
    tripCircuit(breaker, 'deepinfra');

    expect(eventBus.emit).toHaveBeenCalledWith('circuit:tripped', {
      provider: 'deepinfra',
      category: 'connectivity',
      consecutiveFailures: 3,
      recoveryTimeoutMs: TEST_CONFIG.baseRecoveryTimeoutMs,
    });

    vi.advanceTimersByTime(TEST_CONFIG.baseRecoveryTimeoutMs);
    breaker.allowRequest('deepinfra');

    expect(eventBus.emit).toHaveBeenCalledWith('circuit:recovered', {
      provider: 'deepinfra',
    });
  });

  it('getAllStates returns only non-CLOSED', () => {
    tripCircuit(breaker, 'deepinfra');
    tripCircuit(breaker, 'anthropic');
    tripCircuit(breaker, 'ollama', 'ECONNREFUSED', 1);

    vi.advanceTimersByTime(TEST_CONFIG.baseRecoveryTimeoutMs);
    breaker.allowRequest('anthropic');

    const allStates = breaker.getAllStates();

    expect(Object.keys(allStates).sort()).toEqual(['anthropic', 'deepinfra'].sort());
    expect(allStates).not.toHaveProperty('ollama');
    // Both were tripped at the same time with the same timeout,
    // so advancing by baseRecoveryTimeoutMs transitions both to HALF_OPEN
    expect(allStates.deepinfra.state).toBe(STATES.HALF_OPEN);
    expect(allStates.anthropic.state).toBe(STATES.HALF_OPEN);
  });

  describe('persistence', () => {
    let store;
    beforeEach(() => {
      const persisted = new Map();
      store = {
        getState: vi.fn((id) => persisted.get(id) ?? null),
        persist: vi.fn((id, patch) => {
          const existing = persisted.get(id) ?? { provider_id: id };
          const next = { ...existing };
          if (patch.state !== undefined) next.state = patch.state;
          if (patch.trippedAt !== undefined) next.tripped_at = patch.trippedAt;
          if (patch.untrippedAt !== undefined) next.untripped_at = patch.untrippedAt;
          if (patch.tripReason !== undefined) next.trip_reason = patch.tripReason;
          if (patch.lastCanaryAt !== undefined) next.last_canary_at = patch.lastCanaryAt;
          if (patch.lastCanaryStatus !== undefined) next.last_canary_status = patch.lastCanaryStatus;
          persisted.set(id, next);
        }),
        listAll: vi.fn(() => Array.from(persisted.values())),
      };
    });

    it('loads persisted OPEN state on construction', () => {
      store.persist('codex', {
        state: 'OPEN',
        trippedAt: new Date('2026-04-26T19:55:00.000Z').toISOString(),
        tripReason: 'manual_disabled',
      });
      const breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG, store });
      expect(breaker.getState('codex').state).toBe(STATES.OPEN);
      expect(store.listAll).toHaveBeenCalled();
    });

    it('writes through to store on trip', () => {
      const breaker = createCircuitBreaker({ eventBus, config: TEST_CONFIG, store });
      tripCircuit(breaker, 'codex');
      expect(store.persist).toHaveBeenCalledWith('codex', expect.objectContaining({
        state: 'OPEN',
      }));
    });

    it('survives breaker recreation (state loaded from store)', () => {
      const breaker1 = createCircuitBreaker({ eventBus, config: TEST_CONFIG, store });
      tripCircuit(breaker1, 'codex');
      const breaker2 = createCircuitBreaker({ eventBus, config: TEST_CONFIG, store });
      expect(breaker2.getState('codex').state).toBe(STATES.OPEN);
    });
  });
});
