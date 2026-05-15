import { describe, it, expect } from 'vitest';
import { derivePlanExecuteOutcome } from '../factory/stages/plan-execute-outcome.js';

describe('derivePlanExecuteOutcome (Phase 2c Step B — PLAN/EXECUTE)', () => {
  it('earlyReturn with new_state IDLE → disposition=terminate', () => {
    const outcome = derivePlanExecuteOutcome({
      earlyReturn: { new_state: 'IDLE', paused_at_stage: null, reason: 'no_work_item_selected', stage_result: null },
    });
    expect(outcome.disposition).toBe('terminate');
    expect(outcome.nextState).toBe('IDLE');
    expect(outcome.reason).toBe('no_work_item_selected');
  });

  it('earlyReturn with new_state VERIFY → disposition=continue', () => {
    const outcome = derivePlanExecuteOutcome({
      earlyReturn: { new_state: 'VERIFY', paused_at_stage: null, reason: 'execute_zero_diff_short_circuit', stage_result: { x: 1 } },
    });
    expect(outcome.disposition).toBe('continue');
    expect(outcome.nextState).toBe('VERIFY');
    expect(outcome.stageResult).toEqual({ x: 1 });
  });

  it('earlyReturn with paused_at_stage → disposition=pause', () => {
    const outcome = derivePlanExecuteOutcome({
      earlyReturn: { new_state: 'PAUSED', paused_at_stage: 'PLAN_REVIEW', reason: 'gate', stage_result: null },
    });
    expect(outcome.disposition).toBe('pause');
    expect(outcome.pausedAtStage).toBe('PLAN_REVIEW');
  });

  it('break path with a paused instance → disposition=pause', () => {
    const outcome = derivePlanExecuteOutcome({
      earlyReturn: null,
      instance: { id: 'i', paused_at_stage: 'EXECUTE' },
      transitionWorkItem: null,
      stageResult: { status: 'paused' },
      transitionReason: 'paused_at_gate',
    });
    expect(outcome.disposition).toBe('pause');
    expect(outcome.pausedAtStage).toBe('EXECUTE');
    expect(outcome.reason).toBe('paused_at_gate');
  });

  it('break path with a non-paused instance → disposition=continue', () => {
    const outcome = derivePlanExecuteOutcome({
      earlyReturn: null,
      instance: { id: 'i', paused_at_stage: null, loop_state: 'EXECUTE' },
      transitionWorkItem: { id: 'wi' },
      stageResult: null,
      transitionReason: null,
    });
    expect(outcome.disposition).toBe('continue');
    expect(outcome.nextState).toBeNull();
    expect(outcome.reason).toBeNull();
  });

  it('never yields disposition=pause without a pausedAtStage (applyOutcome safety)', () => {
    // applyOutcome throws on disposition='pause' with no pausedAtStage.
    const samples = [
      { earlyReturn: { new_state: 'IDLE', paused_at_stage: null } },
      { earlyReturn: { new_state: 'VERIFY', paused_at_stage: null } },
      { earlyReturn: null, instance: { id: 'i', paused_at_stage: null } },
      { earlyReturn: null, instance: { id: 'i' } },
    ];
    for (const s of samples) {
      const outcome = derivePlanExecuteOutcome(s);
      if (outcome.disposition === 'pause') {
        expect(outcome.pausedAtStage).toBeTruthy();
      }
    }
  });

  it('throws when planExec is not an object', () => {
    expect(() => derivePlanExecuteOutcome(null)).toThrow(/planExec object is required/);
    expect(() => derivePlanExecuteOutcome(undefined)).toThrow(/planExec object is required/);
  });
});
