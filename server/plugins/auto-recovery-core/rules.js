'use strict';

module.exports = [
  {
    name: 'dotnet_sourcelink_file_lock',
    category: 'transient',
    priority: 200,
    confidence: 0.9,
    match: {
      stage: 'verify', action: 'worktree_verify_failed',
      outcome_path: 'output_preview',
      outcome_regex: 'being used by another process|sourcelink\\.json',
    },
    suggested_strategies: ['clean_and_retry', 'retry', 'reject_and_advance'],
  },
  {
    name: 'codex_phantom_success',
    category: 'sandbox_interrupt',
    priority: 150,
    confidence: 0.7,
    match: {
      action: 'cannot_generate_plan',
      outcome_regex: 'Reconnecting|high[- ]demand|workspace-write|\\bsandbox\\b',
    },
    suggested_strategies: ['retry_with_fresh_session', 'fallback_provider', 'escalate'],
  },
  {
    name: 'plan_generation_failed',
    category: 'plan_failure',
    priority: 100,
    confidence: 0.8,
    match: { action: 'cannot_generate_plan' },
    suggested_strategies: ['retry_plan_generation', 'fallback_provider', 'reject_and_advance'],
  },
  {
    name: 'execute_worktree_creation_failed',
    category: 'structural_failure',
    priority: 95,
    confidence: 0.9,
    match: {
      stage: 'execute',
      action: 'worktree_creation_failed',
    },
    suggested_strategies: ['reject_and_advance', 'escalate'],
  },
  {
    name: 'execute_worktree_creation_gate',
    category: 'structural_failure',
    priority: 94,
    confidence: 0.8,
    match_fn: (d) => {
      if (!d || d.stage !== 'execute' || d.action !== 'paused_at_gate') return false;
      const text = `${d.reasoning || ''} ${JSON.stringify(d.outcome || {})}`.toLowerCase();
      return text.includes('worktree_creation_failed')
        || text.includes('worktree creation failed')
        || text.includes('factory_worktrees')
        || text.includes('forcermsync')
        || text.includes('permission denied');
    },
    suggested_strategies: ['reject_and_advance', 'escalate'],
  },
  {
    name: 'never_started_paused_project',
    category: 'never_started',
    priority: 90,
    confidence: 0.9,
    match_fn: (d) => d && d.action === 'never_started',
    suggested_strategies: ['retry_plan_generation', 'escalate'],
  },
  {
    name: 'verify_reviewer_timeout',
    category: 'provider_overload',
    priority: 80,
    confidence: 0.8,
    match: { stage: 'verify', action: 'verify_reviewer_timeout_paused' },
    suggested_strategies: ['retry_with_fresh_session', 'escalate'],
  },
  {
    name: 'verify_fail_unclassified',
    category: 'unknown',
    priority: 10,
    confidence: 0.3,
    match: { stage: 'verify', action: 'worktree_verify_failed' },
    suggested_strategies: ['retry', 'escalate'],
  },
  {
    // VERIFY paused waiting on non-terminal batch tasks. With factory-tick
    // auto-clear (commit 5275d2c1) and the `skipped`-as-terminal fix
    // (commit fac72c3f), this normally heals on its own once the batch
    // turns fully terminal. The rule still fires so the decision log shows
    // a deterministic category instead of "unknown", and so retry (now
    // stage-aware → retryFactoryVerify on VERIFY) re-checks the gate after
    // recovery rather than waiting for the next factory tick.
    name: 'verify_batch_tasks_not_terminal',
    category: 'transient',
    priority: 70,
    confidence: 0.7,
    match_fn: (d) => {
      if (!d || d.stage !== 'verify') return false;
      if (d.action === 'waiting_for_batch_tasks') return true;
      if (d.action === 'paused_at_gate') {
        const reason = d.outcome?.reason || '';
        return reason === 'batch_tasks_not_terminal';
      }
      return false;
    },
    suggested_strategies: ['retry', 'escalate'],
  },
  {
    // EXECUTE-stage exception catch-all. Mirrors verify_fail_unclassified
    // for the EXECUTE side. Most execute_exception decisions today are
    // transient (codex hiccup, fs ENOENT, smart_submit anomalies); the
    // first move is retry — which after the stage-aware fix (commit
    // 5ac34709) calls approveGate on EXECUTE pause and lets the loop tick
    // re-enter EXECUTE. If progress isn't made, reject_and_advance moves
    // past the offending work item; escalate is the final fallback.
    // Without this rule the classifier labels execute_exception "unknown"
    // with confidence 0 (still picks retry by default, but yields no
    // signal in the decision log).
    name: 'execute_exception_unclassified',
    category: 'unknown',
    priority: 10,
    confidence: 0.3,
    match: { stage: 'execute', action: 'execute_exception' },
    suggested_strategies: ['retry', 'reject_and_advance', 'escalate'],
  },
  {
    // EXECUTE finished but the worktree was clean — Codex produced no
    // diff. Common shapes: prompt-output mismatch (plan wasn't actionable
    // as written), Codex hit a sandbox/quota issue mid-task and bailed
    // silently, or the model genuinely thinks the change is already in
    // place. The 2-strikes safety net (`maybeShortCircuitZeroDiffExecute`,
    // loop-controller.js:6251) eventually rejects the work item, but it
    // requires consecutive zero-diffs in the SAME batch — projects often
    // pause at the gate after the first miss and sit there until human
    // approval. Routing through retry_with_fresh_session gives Codex a
    // clean context (no stale session state) before falling through to
    // reject_and_advance, which lets the short-circuit's intent fire
    // sooner via the same code path it would have used anyway.
    //
    // Observed live on StateTrace 2026-04-25: paused at EXECUTE for
    // ~10min before auto-recovery picked it up as `unknown` and chose
    // plain `retry`. Naming the rule keeps the decision log honest and
    // the strategy chain stronger.
    name: 'execute_auto_commit_skipped_clean',
    category: 'sandbox_interrupt',
    priority: 75,
    confidence: 0.7,
    match: { stage: 'execute', action: 'auto_commit_skipped_clean' },
    suggested_strategies: ['retry_with_fresh_session', 'reject_and_advance', 'escalate'],
  },
  {
    // VERIFY paused because the reviewer returned an ambiguous (low-
    // confidence) verdict. Most often this means the failing-tests
    // parser returned [] AND the modified-files set was [] — the
    // reviewer's early-exit fires (verify-review.js:393) without
    // invoking the LLM tiebreak at all, because there is literally
    // nothing to attribute.
    //
    // Observed live on StateTrace 2026-04-25: PowerShell/Pester verify
    // output wasn't being parsed (parser only handled pytest / vitest /
    // dotnet at the time), so the loop ran ambiguous→retry→ambiguous→
    // retry indefinitely. The Pester parser landed alongside this rule —
    // the parser is the ROOT-cause fix; this rule is the resilience
    // layer for any future test runner the parser doesn't yet know
    // about, and it gives the decision log a deterministic category
    // instead of anonymous `unknown` / `none`.
    //
    // Categorized as `transient` so retry is the first move (verify
    // runs themselves can flake) AND reject_and_advance stays applicable
    // for the post-MAX_ATTEMPTS path.
    name: 'verify_reviewer_ambiguous',
    category: 'transient',
    priority: 65,
    confidence: 0.6,
    match: { stage: 'verify', action: 'verify_reviewed_ambiguous_paused' },
    suggested_strategies: ['retry', 'reject_and_advance', 'escalate'],
  },
];
