'use strict';

// Spy on decision-log.logDecision rather than vi.mock the whole module.
// vi.mock hoisting + CJS module caching is unreliable when decision-log's
// transitive deps (db/factory/decisions, event-bus) are loaded by the
// global setup. vi.spyOn modifies the already-cached module export object
// in place, which is reliable in pool:threads CJS mode.
const decisionLog = require('../factory/decision-log');
const { emitAutoShipped, AUTO_SHIPPED_REASONS } = require('../factory/auto-ship');

const recorded = [];
let spy;

beforeEach(() => {
  recorded.length = 0;
  spy = vi.spyOn(decisionLog, 'logDecision').mockImplementation((entry) => {
    recorded.push(entry);
    return { id: recorded.length };
  });
});

afterEach(() => {
  spy.mockRestore();
});

describe('AUTO_SHIPPED_REASONS', () => {
  it('exposes three reason values', () => {
    expect(AUTO_SHIPPED_REASONS.AT_PRIORITIZE).toBe('at_prioritize');
    expect(AUTO_SHIPPED_REASONS.EMPTY_BRANCH_MERGE_FAIL).toBe('empty_branch_merge_fail');
    expect(AUTO_SHIPPED_REASONS.AT_VERIFY_FAIL).toBe('at_verify_fail');
  });

  it('is frozen — cannot mutate or add reasons at runtime', () => {
    expect(Object.isFrozen(AUTO_SHIPPED_REASONS)).toBe(true);
    expect(() => { AUTO_SHIPPED_REASONS.NEW_REASON = 'foo'; }).toThrow();
  });
});

describe('emitAutoShipped', () => {
  it('emits a decision with action=auto_shipped and reason in outcome', () => {
    emitAutoShipped({
      project_id: 1,
      stage: 'PRIORITIZE',
      reason: AUTO_SHIPPED_REASONS.AT_PRIORITIZE,
      work_item_id: 'wi-7',
      confidence: 'high',
      signals: ['commit-match', 'title-match'],
    });
    expect(recorded.length).toBe(1);
    expect(recorded[0].action).toBe('auto_shipped');
    expect(recorded[0].stage).toBe('PRIORITIZE');
    expect(recorded[0].actor).toBe('factory-loop');
    expect(recorded[0].confidence).toBe(1);
    expect(recorded[0].outcome.reason).toBe('at_prioritize');
    expect(recorded[0].outcome.work_item_id).toBe('wi-7');
    expect(recorded[0].outcome.confidence).toBe('high');
    expect(recorded[0].outcome.signals).toEqual(['commit-match', 'title-match']);
    expect(recorded[0].inputs.reason).toBe('at_prioritize');
  });

  it('does not let extra override validated core keys (shadowing prevention)', () => {
    emitAutoShipped({
      project_id: 1,
      stage: 'PRIORITIZE',
      reason: AUTO_SHIPPED_REASONS.AT_PRIORITIZE,
      work_item_id: 'wi-7',
      confidence: 'high',
      signals: ['real-signal'],
      extra: {
        // These attempts to override core keys must lose to the validated values.
        reason: 'forged_bypass_value',
        work_item_id: 'wi-99',
        confidence: 'low',
        signals: ['forged-signal'],
        // Stage-specific extension fields still flow through.
        factory_worktree_id: 'wt-1',
      },
    });
    expect(recorded[0].outcome.reason).toBe('at_prioritize');
    expect(recorded[0].outcome.work_item_id).toBe('wi-7');
    expect(recorded[0].outcome.confidence).toBe('high');
    expect(recorded[0].outcome.signals).toEqual(['real-signal']);
    expect(recorded[0].outcome.factory_worktree_id).toBe('wt-1');
  });

  it('throws on unknown reason with a clear message listing valid values', () => {
    expect(() => emitAutoShipped({
      project_id: 1,
      stage: 'PRIORITIZE',
      reason: 'made_up_reason',
      work_item_id: 'wi-7',
      confidence: 'high',
      signals: [],
    })).toThrow(/unknown reason "made_up_reason"/);

    expect(() => emitAutoShipped({
      project_id: 1,
      stage: 'PRIORITIZE',
      reason: 'made_up_reason',
      work_item_id: 'wi-7',
      confidence: 'high',
      signals: [],
    })).toThrow(/at_prioritize/);
  });

  it('accepts every declared reason without error (parametric coverage)', () => {
    for (const value of Object.values(AUTO_SHIPPED_REASONS)) {
      expect(() => emitAutoShipped({
        project_id: 1,
        stage: 'PRIORITIZE',
        reason: value,
        work_item_id: 'wi-7',
        confidence: 'high',
        signals: [],
      })).not.toThrow();
    }
    expect(recorded.length).toBe(Object.values(AUTO_SHIPPED_REASONS).length);
  });

  it('merges extra keys into outcome (preserves stage-specific context)', () => {
    emitAutoShipped({
      project_id: 1,
      stage: 'LEARN',
      reason: AUTO_SHIPPED_REASONS.EMPTY_BRANCH_MERGE_FAIL,
      work_item_id: 'wi-7',
      confidence: 'medium',
      signals: ['title-match'],
      batch_id: 'batch-42',
      extra: {
        factory_worktree_id: 'wt-1',
        resolution_source: 'auto-detector',
        error: 'no commits ahead',
      },
    });
    expect(recorded[0].outcome.factory_worktree_id).toBe('wt-1');
    expect(recorded[0].outcome.resolution_source).toBe('auto-detector');
    expect(recorded[0].outcome.error).toBe('no commits ahead');
    expect(recorded[0].outcome.work_item_id).toBe('wi-7');
    expect(recorded[0].outcome.reason).toBe('empty_branch_merge_fail');
    expect(recorded[0].batch_id).toBe('batch-42');
  });

  it('generates default reasoning when caller does not pass one', () => {
    emitAutoShipped({
      project_id: 1,
      stage: 'VERIFY',
      reason: AUTO_SHIPPED_REASONS.AT_VERIFY_FAIL,
      work_item_id: 'wi-7',
      confidence: 'high',
      signals: [],
    });
    expect(recorded[0].reasoning).toMatch(/Auto-shipped at VERIFY/);
    expect(recorded[0].reasoning).toMatch(/reason=at_verify_fail/);
    expect(recorded[0].reasoning).toMatch(/confidence=high/);
  });

  it('preserves caller-provided reasoning override', () => {
    emitAutoShipped({
      project_id: 1,
      stage: 'PRIORITIZE',
      reason: AUTO_SHIPPED_REASONS.AT_PRIORITIZE,
      work_item_id: 'wi-7',
      confidence: 'high',
      signals: [],
      reasoning: 'Custom reasoning string for this site',
    });
    expect(recorded[0].reasoning).toBe('Custom reasoning string for this site');
  });
});
