// Pins the decisionStore.log normalization contract that 2c-dispatcher
// will depend on. The store must:
//   - lowercase + membership-check `stage` (drop unknown stages with no write)
//   - default `actor` from the stage→actor map when not specified
//   - drop records missing `action` (defensive — matches safeLogDecision)
//   - never throw into the stage even when the DB layer is unavailable
//
// Inject the inner logDecision call so the test runs without a DB and without
// relying on Vitest to intercept nested CommonJS require() calls.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createDecisionStore } = await import('../factory/stages/stores/decision.js');

describe('decisionStore.log — normalization contract', () => {
  let decisionLog;
  let factoryDecisions;

  beforeEach(() => {
    decisionLog = {
      logDecision: vi.fn(() => ({ id: 'fake-decision' })),
    };
    factoryDecisions = {
      getDb: vi.fn(() => ({ prepare: vi.fn() })),
      setDb: vi.fn(),
      getLatestDecisionForStage: vi.fn(),
      listDecisionsForBatch: vi.fn(),
    };
  });

  function createInjectedStore() {
    return createDecisionStore({
      decisionLog,
      factoryDecisions,
      resolveContainerDbHandle: vi.fn(() => ({ prepare: vi.fn() })),
    });
  }

  it('lowercases recognized stage names and defaults actor from the map', () => {
    const store = createInjectedStore();
    store.log({ stage: 'SENSE', action: 'scanned_plans', project_id: 1 });

    expect(decisionLog.logDecision).toHaveBeenCalledTimes(1);
    const call = decisionLog.logDecision.mock.calls[0][0];
    expect(call.stage).toBe('sense');
    expect(call.actor).toBe('health_model');
    expect(call.action).toBe('scanned_plans');
  });

  it('preserves an explicit actor over the stage→actor map', () => {
    const store = createInjectedStore();
    store.log({ stage: 'plan', action: 'replanned', actor: 'human_operator', project_id: 1 });

    const call = decisionLog.logDecision.mock.calls[0][0];
    expect(call.actor).toBe('human_operator');
  });

  it('drops decisions for unknown stages with no DB write', () => {
    const store = createInjectedStore();
    const result = store.log({ stage: 'idle', action: 'no_op', project_id: 1 });

    expect(result).toBeNull();
    expect(decisionLog.logDecision).not.toHaveBeenCalled();
  });

  it('drops decisions missing action with no DB write', () => {
    const store = createInjectedStore();
    const result = store.log({ stage: 'sense', project_id: 1 });

    expect(result).toBeNull();
    expect(decisionLog.logDecision).not.toHaveBeenCalled();
  });

  it('drops decisions whose stage resolves to no actor', () => {
    const store = createInjectedStore();
    const result = store.log({ stage: null, action: 'whatever', project_id: 1 });

    expect(result).toBeNull();
    expect(decisionLog.logDecision).not.toHaveBeenCalled();
  });
});
