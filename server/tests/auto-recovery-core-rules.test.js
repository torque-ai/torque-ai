'use strict';
const { createPlugin } = require('../plugins/auto-recovery-core');
const { createClassifier } = require('../factory/auto-recovery/classifier');

describe('auto-recovery-core day-one rules', () => {
  const plugin = createPlugin();
  const classifier = createClassifier({ rules: plugin.classifierRules });

  it('classifies the example-project sourcelink file-lock as transient', () => {
    const decision = {
      stage: 'verify', action: 'worktree_verify_failed',
      reasoning: 'Worktree remote verify FAILED ... pausing loop at VERIFY_FAIL.',
      outcome: {
        output_preview: `error : Error writing to source link file 'obj\\Debug\\net8.0\\example-project.Application.Tests.sourcelink.json' ... because it is being used by another process.`,
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

  it('classifies Permission-denied worktree-creation failures as transient (fs_lock rule)', () => {
    // Regression for task 65072ba9-6b7b-4886-937b-d6fb665db468 (2026-05-03):
    // Codex EXECUTE finished with exit 1; the next attempt's
    // pre_reclaim_before_create hit a Windows file-lock on the prior
    // worktree dir, threw "Permission denied" from `git worktree remove
    // --force`, and the structural-failure rule rejected the work item.
    // The FS-lock subset is recoverable (the layered cleanup retries +
    // factory tick re-enters EXECUTE), so it should classify as transient
    // with retry first, reject_and_advance only as a final fallback.
    const r = classifier.classify({
      stage: 'execute',
      action: 'worktree_creation_failed',
      reasoning: `Worktree creation failed: Command failed: git worktree remove --force C:\\repo\\.worktrees\\fea-e4596ecd error: failed to delete 'C:/repo/.worktrees/fea-e4596ecd': Permission denied`,
      outcome: { work_item_id: 209, error: 'Permission denied' },
    });
    expect(r.matched_rule).toBe('execute_worktree_creation_fs_lock');
    expect(r.category).toBe('transient');
    expect(r.suggested_strategies[0]).toBe('retry');
    expect(r.suggested_strategies).toContain('reject_and_advance');
  });

  it('classifies EBUSY paused-at-gate worktree creation failures as transient (fs_lock rule)', () => {
    const r = classifier.classify({
      stage: 'execute',
      action: 'paused_at_gate',
      reasoning: 'Loop paused awaiting approval for EXECUTE.',
      outcome: {
        reason: 'worktree_creation_failed',
        work_item_id: 545,
        error: 'EBUSY: resource busy or locked, unlink',
      },
    });
    expect(r.matched_rule).toBe('execute_worktree_creation_fs_lock');
    expect(r.category).toBe('transient');
    expect(r.suggested_strategies[0]).toBe('retry');
  });

  it('keeps non-fs-lock worktree-creation failures (e.g. UNIQUE constraint) on the structural rule', () => {
    // The FS-lock rule must NOT swallow genuinely structural failures
    // like UNIQUE constraint collisions on factory_worktrees.branch —
    // retry cannot fix those.
    const r = classifier.classify({
      stage: 'execute',
      action: 'worktree_creation_failed',
      reasoning: 'git worktree creation failed',
      outcome: { work_item_id: 545, error: 'UNIQUE constraint failed: factory_worktrees.branch' },
    });
    expect(r.matched_rule).toBe('execute_worktree_creation_failed');
    expect(r.category).toBe('structural_failure');
  });

  it('classifies "active worktree owner still running" as await_self_heal with empty strategies', () => {
    // Regression for the bitsy work_item 2161 spin (2026-05-01 03:18-03:31):
    // pre-execute reclaim found the worktree owned by a live task, the loop
    // transitioned to PAUSED, auto-recovery picked retry → approveGate → un-paused,
    // loop ticked → same condition → paused again, in a tight ~5 min cycle.
    // This rule routes the fingerprint to no-action, letting
    // maybeClearCompletedExecuteOwnerWait clear the pause naturally when the
    // owning task terminates.
    const r = classifier.classify({
      stage: 'execute',
      action: 'paused_at_gate',
      reasoning: 'Loop paused awaiting approval for EXECUTE.',
      outcome: {
        from_state: 'EXECUTE',
        to_state: 'PAUSED',
        gate_stage: 'EXECUTE',
        reason: 'active worktree owner still running',
        work_item_id: 2161,
      },
    });
    expect(r.matched_rule).toBe('execute_paused_active_worktree_owner');
    expect(r.category).toBe('await_self_heal');
    expect(r.suggested_strategies).toEqual([]);
  });

  it('does NOT match execute_paused_active_worktree_owner on other execute paused gates', () => {
    // Sanity: the rule should be specific to the live-owner reason; it must not
    // swallow other execute pauses (e.g. zero-diff, worktree-creation).
    const zeroDiff = classifier.classify({
      stage: 'execute',
      action: 'paused_at_gate',
      outcome: { reason: 'unknown_zero_diff_review_required' },
    });
    expect(zeroDiff.matched_rule).not.toBe('execute_paused_active_worktree_owner');

    const wtCreate = classifier.classify({
      stage: 'execute',
      action: 'paused_at_gate',
      outcome: { reason: 'worktree_creation_failed' },
    });
    expect(wtCreate.matched_rule).not.toBe('execute_paused_active_worktree_owner');
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

  it('classifies LEARN merge_target_dirty as await_self_heal with empty strategies', () => {
    // Regression for bitsy WI 732 (2026-05-03): main had uncommitted
    // .gitignore + tests/test_ci_parity.py from a prior factory run; the
    // LEARN merge check fired merge_target_dirty + paused_at_gate. Without
    // a rule, recovery's retry strategy approveGate-cleared the pause every
    // cycle, the next tick re-fired the dirty check, and the project burned
    // all 5 attempts before exhausting. Empty strategies routes through the
    // 'no_strategy' branch so the engine marks exhausted=1 without touching
    // the project; operator commits main → next tick passes the check →
    // advance_from_learn → rearm.
    const direct = classifier.classify({
      stage: 'learn',
      action: 'merge_target_dirty',
      reasoning: 'Merge target /repo has uncommitted or untracked files; pausing project.',
      outcome: { paused_at_stage: 'LEARN', next_state: 'PAUSED', dirty_files: ['.gitignore'] },
    });
    expect(direct.matched_rule).toBe('learn_merge_target_dirty');
    expect(direct.category).toBe('await_self_heal');
    expect(direct.suggested_strategies).toEqual([]);

    const conflictDirect = classifier.classify({
      stage: 'learn',
      action: 'merge_target_in_conflict_state',
      reasoning: 'Merge target /repo is mid-rebase; pausing project.',
      outcome: { op: 'rebase', paused_at_stage: 'LEARN' },
    });
    expect(conflictDirect.matched_rule).toBe('learn_merge_target_dirty');

    const gate = classifier.classify({
      stage: 'learn',
      action: 'paused_at_gate',
      reasoning: 'Merge target /repo has uncommitted or untracked files; pausing project.',
      outcome: { reason: 'merge_target_dirty', from_state: 'LEARN', to_state: 'PAUSED' },
    });
    expect(gate.matched_rule).toBe('learn_merge_target_dirty');
    expect(gate.suggested_strategies).toEqual([]);
  });

  it('does NOT match learn_merge_target_dirty on unrelated learn pauses', () => {
    const r = classifier.classify({
      stage: 'learn',
      action: 'paused_at_gate',
      reasoning: 'Loop paused awaiting approval for LEARN.',
      outcome: { reason: 'manual_review_required' },
    });
    expect(r.matched_rule).not.toBe('learn_merge_target_dirty');
  });

  it('classifies plan_generation_retry_unusable_output as plan_failure with fallback_provider first', () => {
    // Regression for bitsy WI 470 (2026-05-03): claude-cli's plan_generation
    // returned a summary string ("The plan has been written to plan.md...")
    // because Claude Code is a tool-using agent and treated "Return Markdown
    // only" as "do work and produce a file". The factory's parser rejected
    // the output (no `## Task N:` sections). Without this rule, recovery's
    // retry chain re-runs the SAME provider on the SAME prompt — same output
    // shape, same parse failure. fallback_provider switches to the next
    // provider in the chain (e.g. claude-cli → codex) so a new agent can
    // produce inline markdown.
    const r = classifier.classify({
      stage: 'execute',
      action: 'plan_generation_retry_unusable_output',
      reasoning: 'plan-generation task completed without executable plan markdown',
      outcome: {
        reason: 'unusable_plan_generation_output',
        plan_path: 'C:/repo/docs/plans/470-x.md',
        generation_task_id: 'task-uuid',
        retry_count: 1,
      },
    });
    expect(r.matched_rule).toBe('plan_generation_unusable_output');
    expect(r.category).toBe('plan_failure');
    expect(r.suggested_strategies[0]).toBe('fallback_provider');
    expect(r.suggested_strategies).toContain('retry_plan_generation');
  });

  it('classifies execute execution_failed as transient with retry first', () => {
    // Regression for bitsy task ce75e955 (2026-05-03): WI 536 task 1
    // cancelled by a concurrent Claude session that saw bitsy as paused
    // and triaged the running task as 'leaked'. The cancellation surfaced
    // as execute/execution_failed with reasoning 'task 1 failed'. Without
    // this rule, the default unknown-classification picked retry, then
    // escalate, exhausted recovery, and the project auto-paused — which
    // caused the next attempt's task to get cancelled by the same
    // concurrent session. retry advances the loop (the executor returns
    // IDLE, not paused-at-gate), and reject_and_advance moves past the
    // WI if retry's budget runs out — instead of escalating to a
    // project-pause that compounds.
    const r = classifier.classify({
      stage: 'execute',
      action: 'execution_failed',
      reasoning: 'task 1 failed',
      outcome: {
        failed_task: 1,
        final_state: 'IDLE',
        plan_path: '/repo/docs/plans/536-x.md',
        work_item_id: 536,
      },
    });
    expect(r.matched_rule).toBe('execute_execution_failed');
    expect(r.category).toBe('transient');
    expect(r.suggested_strategies[0]).toBe('retry');
    expect(r.suggested_strategies).toContain('reject_and_advance');
  });

  it('classifies execute_zero_diff_short_circuit as transient with retry first', () => {
    // Regression for bitsy WI 2170 (2026-05-03): work item was already
    // shipped via a prior gitignore commit; both EXECUTE attempts produced
    // zero-diff (auto_commit_skipped_clean), the short-circuit fired and
    // marked WI unactionable, and the loop transitioned to IDLE. Without
    // this rule, the default unknown-classification picked retry, which hit
    // "Loop not started for this project" because the IDLE transition had
    // already terminated the loop instance. retry's advanceLoop branch is
    // the right move here; naming the rule keeps the decision log honest.
    const r = classifier.classify({
      stage: 'execute',
      action: 'execute_zero_diff_short_circuit',
      reasoning: 'Work item produced 2 consecutive zero-diff executes; skipping VERIFY and marking it unactionable.',
      outcome: {
        work_item_id: 2170,
        reject_reason: 'zero_diff_across_retries',
        zero_diff_attempts: 2,
        next_state: 'IDLE',
      },
    });
    expect(r.matched_rule).toBe('execute_zero_diff_short_circuit');
    expect(r.category).toBe('transient');
    expect(r.suggested_strategies[0]).toBe('retry');
    expect(r.suggested_strategies).toContain('reject_and_advance');
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
