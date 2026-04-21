'use strict';
const { createClassifier, UNKNOWN_CLASSIFICATION } =
  require('../factory/auto-recovery/classifier');

const rule1 = {
  name: 'file_lock', category: 'transient', priority: 100, confidence: 0.9,
  match: {
    stage: 'verify', action: 'worktree_verify_failed',
    outcome_path: 'output_preview',
    outcome_regex: 'being used by another process',
  },
  suggested_strategies: ['clean_and_retry', 'retry'],
};

const rule2 = {
  name: 'fallback_phantom', category: 'sandbox_interrupt', priority: 50, confidence: 0.7,
  match: { action: 'cannot_generate_plan' },
  suggested_strategies: ['retry_with_fresh_session'],
};

const rule3 = {
  name: 'catch_all', category: 'unknown', priority: 10, confidence: 0.1,
  match: {},
  suggested_strategies: ['escalate'],
};

const fnRule = {
  name: 'by_function', category: 'transient', priority: 200, confidence: 1.0,
  match_fn: (d) => d.outcome?.retry_attempts === 99,
  suggested_strategies: ['retry'],
};

describe('classifier', () => {
  it('returns UNKNOWN when no rules are registered', () => {
    const c = createClassifier({ rules: [] });
    expect(c.classify({ stage: 'verify' })).toEqual(UNKNOWN_CLASSIFICATION);
  });

  it('matches a rule by stage + action + outcome regex', () => {
    const c = createClassifier({ rules: [rule1] });
    const r = c.classify({
      stage: 'verify', action: 'worktree_verify_failed',
      outcome: { output_preview: 'error: being used by another process' },
    });
    expect(r.category).toBe('transient');
    expect(r.matched_rule).toBe('file_lock');
    expect(r.suggested_strategies).toEqual(['clean_and_retry', 'retry']);
  });

  it('does not match when outcome regex fails', () => {
    const c = createClassifier({ rules: [rule1] });
    const r = c.classify({
      stage: 'verify', action: 'worktree_verify_failed',
      outcome: { output_preview: 'different error' },
    });
    expect(r.category).toBe('unknown');
  });

  it('picks highest-priority rule on multi-match', () => {
    const c = createClassifier({ rules: [rule3, rule2] });
    const r = c.classify({ action: 'cannot_generate_plan' });
    expect(r.matched_rule).toBe('fallback_phantom');
  });

  it('match_fn rules are honored', () => {
    const c = createClassifier({ rules: [fnRule] });
    const r = c.classify({
      stage: 'verify', action: 'worktree_verify_failed',
      outcome: { retry_attempts: 99 },
    });
    expect(r.matched_rule).toBe('by_function');
  });

  it('malformed rules are skipped', () => {
    const c = createClassifier({ rules: [{ name: 'broken' }] });
    expect(c.classify({ action: 'anything' }).category).toBe('unknown');
  });

  it('classification surfaces confidence from matched rule', () => {
    const c = createClassifier({ rules: [rule1] });
    const r = c.classify({
      stage: 'verify', action: 'worktree_verify_failed',
      outcome: { output_preview: 'being used by another process' },
    });
    expect(r.confidence).toBe(0.9);
  });
});
