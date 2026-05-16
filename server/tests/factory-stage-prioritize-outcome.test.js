import { describe, it, expect } from 'vitest';
import { derivePrioritizeOutcome } from '../factory/stages/prioritize-outcome.js';

describe('derivePrioritizeOutcome (Phase 2c Step B — PRIORITIZE)', () => {
  it('nextState IDLE → disposition=terminate', () => {
    const outcome = derivePrioritizeOutcome({
      instance: { id: 'i' },
      transitionWorkItem: null,
      stageResult: { open_count: 0 },
      transitionReason: 'no_open_work_item',
      nextState: 'IDLE',
    });
    expect(outcome.disposition).toBe('terminate');
    expect(outcome.nextState).toBe('IDLE');
    expect(outcome.reason).toBe('no_open_work_item');
    expect(outcome.workItem).toBeNull();
  });

  it('nextState STARVED → disposition=starved', () => {
    const outcome = derivePrioritizeOutcome({
      instance: { id: 'i' },
      transitionWorkItem: null,
      stageResult: null,
      transitionReason: 'no_open_work_item',
      nextState: 'STARVED',
    });
    expect(outcome.disposition).toBe('starved');
    expect(outcome.nextState).toBe('STARVED');
  });

  it('nextState PLAN (work item picked) → disposition=continue, workItem carried', () => {
    const workItem = { id: 'wi-7', priority: 90 };
    const outcome = derivePrioritizeOutcome({
      instance: { id: 'i', loop_state: 'PLAN' },
      transitionWorkItem: workItem,
      stageResult: { work_item_id: 'wi-7' },
      transitionReason: null,
      nextState: 'PLAN',
    });
    expect(outcome.disposition).toBe('continue');
    expect(outcome.nextState).toBe('PLAN');
    expect(outcome.workItem).toBe(workItem);
  });

  it('parked-codex transition (nextState stays PRIORITIZE) → disposition=continue', () => {
    const outcome = derivePrioritizeOutcome({
      instance: { id: 'i', loop_state: 'PRIORITIZE' },
      transitionWorkItem: null,
      stageResult: null,
      transitionReason: 'parked_codex_unavailable',
      nextState: 'PRIORITIZE',
    });
    expect(outcome.disposition).toBe('continue');
    expect(outcome.nextState).toBe('PRIORITIZE');
    expect(outcome.reason).toBe('parked_codex_unavailable');
  });

  it('throws when prioritizeTransition is not an object', () => {
    expect(() => derivePrioritizeOutcome(null)).toThrow(/prioritizeTransition object is required/);
    expect(() => derivePrioritizeOutcome(undefined)).toThrow(/prioritizeTransition object is required/);
  });
});
