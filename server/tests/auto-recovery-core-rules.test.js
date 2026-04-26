'use strict';
const { createPlugin } = require('../plugins/auto-recovery-core');
const { createClassifier } = require('../factory/auto-recovery/classifier');

describe('auto-recovery-core day-one rules', () => {
  const plugin = createPlugin();
  const classifier = createClassifier({ rules: plugin.classifierRules });

  it('classifies the SpudgetBooks sourcelink file-lock as transient', () => {
    const decision = {
      stage: 'verify', action: 'worktree_verify_failed',
      reasoning: 'Worktree remote verify FAILED ... pausing loop at VERIFY_FAIL.',
      outcome: {
        output_preview: `error : Error writing to source link file 'obj\\Debug\\net8.0\\SpudgetBooks.Application.Tests.sourcelink.json' ... because it is being used by another process.`,
        retry_attempts: 1,
      },
    };
    const r = classifier.classify(decision);
    expect(r.category).toBe('transient');
    expect(r.matched_rule).toBe('dotnet_sourcelink_file_lock');
    expect(r.suggested_strategies[0]).toBe('clean_and_retry');
  });

  it('classifies a plan generation failure', () => {
    const r = classifier.classify({
      stage: 'execute', action: 'cannot_generate_plan',
      reasoning: 'Codex exited mid-task', outcome: { work_item_id: 659 },
    });
    expect(['plan_failure', 'sandbox_interrupt']).toContain(r.category);
  });

  it('classifies execute worktree creation failures as structural failures', () => {
    const r = classifier.classify({
      stage: 'execute',
      action: 'worktree_creation_failed',
      reasoning: 'git worktree creation failed',
      outcome: { work_item_id: 545, error: 'UNIQUE constraint failed: factory_worktrees.branch' },
    });
    expect(r.category).toBe('structural_failure');
    expect(r.matched_rule).toBe('execute_worktree_creation_failed');
    expect(r.suggested_strategies[0]).toBe('reject_and_advance');
  });

  it('classifies execute gates caused by worktree creation failures', () => {
    const r = classifier.classify({
      stage: 'execute',
      action: 'paused_at_gate',
      reasoning: 'Loop paused awaiting approval for EXECUTE.',
      outcome: {
        reason: 'worktree_creation_failed',
        work_item_id: 545,
      },
    });
    expect(r.category).toBe('structural_failure');
    expect(r.matched_rule).toBe('execute_worktree_creation_gate');
  });

  it('classifies an unclassified VERIFY_FAIL as verify_fail_unclassified', () => {
    const r = classifier.classify({
      stage: 'verify', action: 'worktree_verify_failed',
      reasoning: 'something unusual',
      outcome: { output_preview: 'new failure kind' },
    });
    expect(r.matched_rule).toBe('verify_fail_unclassified');
  });

  it('classifies VERIFY waiting_for_batch_tasks as transient (not unknown)', () => {
    const r = classifier.classify({
      stage: 'verify',
      action: 'waiting_for_batch_tasks',
      reasoning: 'VERIFY waiting for 16 non-terminal batch task(s) to finish before remote verify.',
      outcome: { batch_id: 'factory-x-708', pending_count: 16, pending_statuses: ['skipped', 'skipped'] },
    });
    expect(r.category).toBe('transient');
    expect(r.matched_rule).toBe('verify_batch_tasks_not_terminal');
    expect(r.suggested_strategies[0]).toBe('retry');
  });

  it('classifies VERIFY paused_at_gate(reason=batch_tasks_not_terminal) via the same rule', () => {
    const r = classifier.classify({
      stage: 'verify',
      action: 'paused_at_gate',
      reasoning: 'Loop paused awaiting approval for VERIFY.',
      outcome: { reason: 'batch_tasks_not_terminal', from_state: 'VERIFY', to_state: 'PAUSED' },
    });
    expect(r.matched_rule).toBe('verify_batch_tasks_not_terminal');
    expect(r.category).toBe('transient');
  });

  it('classifies an EXECUTE-stage execute_exception as unknown but with a rule attached', () => {
    const r = classifier.classify({
      stage: 'execute',
      action: 'execute_exception',
      reasoning: 'Plan executor threw: smart_submit_task did not return task_id',
      outcome: { error: 'plan executor threw', paused_at_stage: 'EXECUTE', next_state: 'PAUSED' },
    });
    expect(r.matched_rule).toBe('execute_exception_unclassified');
    expect(r.category).toBe('unknown');
    expect(r.suggested_strategies[0]).toBe('retry');
    expect(r.suggested_strategies).toContain('reject_and_advance');
  });

  it('classifies execute auto_commit_skipped_clean as sandbox_interrupt and prefers a fresh-session retry', () => {
    const r = classifier.classify({
      stage: 'execute',
      action: 'auto_commit_skipped_clean',
      reasoning: 'Approved plan task completed, but the factory worktree was already clean.',
      outcome: { batch_id: 'factory-test-1', work_item_id: 42 },
    });
    expect(r.matched_rule).toBe('execute_auto_commit_skipped_clean');
    expect(r.category).toBe('sandbox_interrupt');
    expect(r.suggested_strategies[0]).toBe('retry_with_fresh_session');
    expect(r.suggested_strategies).toContain('reject_and_advance');
  });

  it('classifies verify_reviewed_ambiguous_paused as transient with reject_and_advance fallback', () => {
    const r = classifier.classify({
      stage: 'verify',
      action: 'verify_reviewed_ambiguous_paused',
      reasoning: 'Classifier says ambiguous (confidence=low); pausing instead of auto-retrying.',
      outcome: { classification: 'ambiguous', confidence: 'low' },
    });
    expect(r.matched_rule).toBe('verify_reviewer_ambiguous');
    expect(r.category).toBe('transient');
    expect(r.suggested_strategies[0]).toBe('retry');
    expect(r.suggested_strategies).toContain('reject_and_advance');
    expect(r.suggested_strategies).toContain('escalate');
  });

  it('classifies reviewer timeout pauses as provider overload and prefers a fresh-session retry', () => {
    const r = classifier.classify({
      stage: 'verify',
      action: 'verify_reviewer_timeout_paused',
      reasoning: 'Verify reviewer timed out and the loop paused for controlled recovery.',
      outcome: { task_id: 'review-llm-timeout-1' },
    });
    expect(r.category).toBe('provider_overload');
    expect(r.matched_rule).toBe('verify_reviewer_timeout');
    expect(r.suggested_strategies[0]).toBe('retry_with_fresh_session');
  });

  it('every rule suggests strategies known to the plugin', () => {
    const strategyNames = new Set(plugin.recoveryStrategies.map(s => s.name));
    for (const rule of plugin.classifierRules) {
      for (const s of rule.suggested_strategies || []) {
        expect(strategyNames.has(s)).toBe(true);
      }
    }
  });

  it('plugin validates against plugin-contract', () => {
    const { validatePlugin } = require('../plugins/plugin-contract');
    expect(validatePlugin(plugin).valid).toBe(true);
  });
});
