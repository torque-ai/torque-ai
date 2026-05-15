// Pins the decisionStore.log normalization contract that 2c-dispatcher
// will depend on. The store must:
//   - lowercase + membership-check `stage` (drop unknown stages with no write)
//   - default `actor` from the stage→actor map when not specified
//   - drop records missing `action` (defensive — matches safeLogDecision)
//   - never throw into the stage even when the DB layer is unavailable
//
// We mock the inner logDecision call so the test runs without a DB.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../factory/decision-log.js', () => ({
  logDecision: vi.fn(() => ({ id: 'fake-decision' })),
}));

vi.mock('../db/factory/decisions.js', () => ({
  getDb: vi.fn(() => ({ prepare: vi.fn() })),  // fake db handle so resolveDecisionDb returns it
  setDb: vi.fn(),
  getLatestDecisionForStage: vi.fn(),
  listDecisionsForBatch: vi.fn(),
}));

vi.mock('../db/db-handle-resolver.js', () => ({
  resolveContainerDbHandle: vi.fn(() => ({ prepare: vi.fn() })),
}));

const decisionLog = await import('../factory/decision-log.js');
const { createDecisionStore } = await import('../factory/stages/stores/decision.js');

describe('decisionStore.log — normalization contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lowercases recognized stage names and defaults actor from the map', () => {
    const store = createDecisionStore();
    store.log({ stage: 'SENSE', action: 'scanned_plans', project_id: 1 });

    expect(decisionLog.logDecision).toHaveBeenCalledTimes(1);
    const call = decisionLog.logDecision.mock.calls[0][0];
    expect(call.stage).toBe('sense');
    expect(call.actor).toBe('health_model');
    expect(call.action).toBe('scanned_plans');
  });

  it('preserves an explicit actor over the stage→actor map', () => {
    const store = createDecisionStore();
    store.log({ stage: 'plan', action: 'replanned', actor: 'human_operator', project_id: 1 });

    const call = decisionLog.logDecision.mock.calls[0][0];
    expect(call.actor).toBe('human_operator');
  });

  it('drops decisions for unknown stages with no DB write', () => {
    const store = createDecisionStore();
    const result = store.log({ stage: 'idle', action: 'no_op', project_id: 1 });

    expect(result).toBeNull();
    expect(decisionLog.logDecision).not.toHaveBeenCalled();
  });

  it('drops decisions missing action with no DB write', () => {
    const store = createDecisionStore();
    const result = store.log({ stage: 'sense', project_id: 1 });

    expect(result).toBeNull();
    expect(decisionLog.logDecision).not.toHaveBeenCalled();
  });

  it('drops decisions whose stage resolves to no actor', () => {
    const store = createDecisionStore();
    const result = store.log({ stage: null, action: 'whatever', project_id: 1 });

    expect(result).toBeNull();
    expect(decisionLog.logDecision).not.toHaveBeenCalled();
  });
});
