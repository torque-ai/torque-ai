'use strict';

// Catalog of valid factory_decisions actions.
//
// Source of truth for action shape, classifier kind, and outcome key list.
// New emission sites must add a corresponding entry; the audit at
// server/tests/factory-decision-actions-catalog.test.js enforces this.
//
// Schema per entry:
//   stage: SENSE | PRIORITIZE | PLAN | EXECUTE | VERIFY | LEARN | IDLE | PAUSED | STARVED | ANY
//   classifier: 'benign' | 'recovery-rule' | 'b-side-reject' | 'terminal' | 'engine'
//   rule_id: required when classifier === 'recovery-rule'
//   outcome: array of documented outcome keys (informational only in v1)
//
// See docs/factory-loop-states.md for the loop's state machine and
// docs/recovery-decisions.md for the recovery subsystems consuming these.

const DECISION_ACTIONS = {

  // ─── SENSE ────────────────────────────────────────────────────────────────

  scanned_plans: {
    stage: 'SENSE',
    classifier: 'benign',
    outcome: ['plans_dir', 'scanned', 'created_count', 'shipped_count'],
  },
  started_loop: {
    stage: 'SENSE',
    classifier: 'benign',
    outcome: ['from_state', 'to_state', 'instance_id'],
  },
  starting: {
    stage: 'SENSE',
    classifier: 'benign',
    outcome: [],
  },
  start_loop_blocked_project_paused: {
    stage: 'SENSE',
    classifier: 'benign',
    outcome: ['started', 'status'],
  },

  // ─── PRIORITIZE ───────────────────────────────────────────────────────────

  selected_work_item: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['work_item_id', 'priority', 'status', 'source', 'batch_id'],
  },
  scored_work_item: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['work_item_id', 'score', 'factors'],
  },
  no_selected_work_item: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['reason', 'work_item_id', 'batch_id'],
  },
  auto_shipped_at_prioritize: {
    stage: 'PRIORITIZE',
    classifier: 'terminal',
    outcome: ['work_item_id', 'status'],
  },
  healed_already_shipped: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['work_item_id', 'previous_status', 'new_status', 'factory_worktree_id', 'branch', 'merged_at'],
  },
  stale_probe_budget_exhausted: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['skipped', 'max_repicks', 'fallback_work_item_id'],
  },
  skipped_stale_scout_item: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['work_item_id', 'stale_reason', 'commits_since_scan', 'probe_ms'],
  },
  stale_probe_starvation: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['skipped'],
  },
  scout_promoted: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['work_item_id', 'scout_id'],
  },
  decompose_would_yield_eligible: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['work_item_id', 'eligibleCount', 'subtaskCount', 'decomposed'],
  },
  parked_codex_unavailable: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['work_item_id', 'reason'],
  },
  marked_for_failover_routing: {
    stage: 'PRIORITIZE',
    classifier: 'benign',
    outcome: ['work_item_id', 'instance_id', 'fallback_template'],
  },
  auto_rejected_stuck_executing: {
    stage: 'PRIORITIZE',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'reason', 'stuck_since'],
  },

  // ─── PLAN ─────────────────────────────────────────────────────────────────

  generated_plan: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['work_item_id', 'plan_path', 'task_count', 'description_quality'],
  },
  plan_generated: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['work_item_id', 'plan_path', 'task_count'],
  },
  cannot_generate_plan: {
    stage: 'PLAN',
    classifier: 'recovery-rule',
    rule_id: 'codex_phantom_success',
    outcome: ['work_item_id', 'error', 'attempt'],
  },
  cannot_generate_plan_routed_to_needs_replan: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['work_item_id', 'reason'],
  },
  skipped_for_plan_file: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['work_item_id', 'plan_path'],
  },
  plan_review_started: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['reviewers', 'reviewer_count'],
  },
  plan_review_verdict: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['reviewer', 'provider', 'verdict', 'confidence', 'concerns', 'suggestions', 'task_id', 'reason'],
  },
  plan_review_aggregated: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['overall', 'reviewer_count', 'has_warnings', 'blocked'],
  },
  plan_lint_rejected: {
    stage: 'PLAN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'reason', 'lint_errors'],
  },
  plan_lint_warnings: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['work_item_id', 'warnings'],
  },
  plan_description_quality_rejected: {
    stage: 'PLAN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'quality_score', 'reason'],
  },
  plan_description_quality_routed_to_needs_replan: {
    stage: 'PLAN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'quality_score', 'reason'],
  },
  plan_quality_passed: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['work_item_id', 'quality_score'],
  },
  plan_quality_rejected_will_replan: {
    stage: 'PLAN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'quality_score', 'reason', 'retry_count'],
  },
  plan_quality_routed_to_needs_replan_after_intrabatch_retries: {
    stage: 'PLAN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'quality_score', 'retry_count'],
  },
  plan_quality_gate_fail_open: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['work_item_id', 'reason'],
  },
  plan_quality_skipped_by_metadata: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['work_item_id', 'reason'],
  },
  plan_quality_soft_threshold_crossed: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['work_item_id', 'quality_score', 'threshold'],
  },
  resumed_plan_quality_rejected: {
    stage: 'PLAN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'quality_score', 'reason'],
  },
  stale_generated_plan_cleared_before_replan: {
    stage: 'PLAN',
    classifier: 'benign',
    outcome: ['work_item_id', 'plan_path'],
  },
  pre_written_plan_quality_rejected: {
    stage: 'PLAN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'quality_score', 'reason'],
  },
  pre_written_plan_quality_rejected_before_execute: {
    stage: 'PLAN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'quality_score', 'reason'],
  },
  plan_generation_deferred_project_active: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['reason', 'plan_path', 'generation_task_id', 'blocking_work_item_id', 'task_status', 'work_item_id'],
  },
  plan_generation_retry_unusable_output: {
    stage: 'EXECUTE',
    classifier: 'recovery-rule',
    rule_id: 'plan_generation_unusable_output',
    outcome: ['work_item_id', 'provider'],
  },

  // ─── EXECUTE ──────────────────────────────────────────────────────────────

  started_execution: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['from_state', 'to_state', 'reason', 'batch_id', 'work_item_id'],
  },
  entered_from_execute: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['from_state', 'to_state', 'paused_at_stage', 'reason', 'batch_id'],
  },
  completed_execution: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'task_count', 'execution_time_ms'],
  },
  execute_completed_after_no_op_retries: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'retry_count'],
  },
  execute_completed_with_agent_self_commits: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'commit_count'],
  },
  execute_deferred_paused: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'plan_path', 'plan_task_number', 'remaining_plan_task_number', 'plan_task_title', 'project_status', 'next_state'],
  },
  execute_deferred_paused_stale_warning: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'plan_task_number', 'deferred_at'],
  },
  execute_deferred_resumed: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'plan_task_number', 'resumed_at'],
  },
  execute_deferred_worktree_reused: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['factory_worktree_id', 'worktree_id', 'worktree_path', 'branch', 'batch_id'],
  },
  execute_exception: {
    stage: 'EXECUTE',
    classifier: 'recovery-rule',
    rule_id: 'execute_exception_unclassified',
    outcome: ['work_item_id', 'error'],
  },
  execute_wait_owner_completed: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['owning_task_id', 'owning_status'],
  },
  execute_zero_diff_short_circuit: {
    stage: 'EXECUTE',
    classifier: 'recovery-rule',
    rule_id: 'execute_zero_diff_short_circuit',
    outcome: ['work_item_id', 'reason'],
  },
  execution_failed: {
    stage: 'EXECUTE',
    classifier: 'recovery-rule',
    rule_id: 'execute_execution_failed',
    outcome: ['work_item_id'],
  },
  intake_generation_meta_rejected: {
    stage: 'EXECUTE',
    classifier: 'b-side-reject',
    outcome: ['title', 'reason'],
  },
  worktree_created: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['factory_worktree_id', 'worktree_id', 'worktree_path', 'branch', 'batch_id'],
  },
  worktree_creation_failed: {
    stage: 'EXECUTE',
    classifier: 'recovery-rule',
    rule_id: 'execute_worktree_creation_fs_lock',
    outcome: ['work_item_id', 'error', 'reason'],
  },
  worktree_reclaimed: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'factory_worktree_id', 'branch'],
  },
  worktree_reclaim_skipped_in_flight_same_wi: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'factory_worktree_id'],
  },
  worktree_reclaim_skipped_live_owner: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'factory_worktree_id', 'owning_task_id'],
  },
  auto_rejected_spin_loop: {
    stage: 'EXECUTE',
    classifier: 'b-side-reject',
    outcome: ['starts_in_window', 'threshold', 'window_since', 'next_state'],
  },
  dry_run_task: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'task_number', 'simulated', 'submitted_task_id', 'execution_mode'],
  },
  auto_commit_skipped_clean: {
    stage: 'EXECUTE',
    classifier: 'recovery-rule',
    rule_id: 'execute_auto_commit_skipped_clean',
    outcome: ['work_item_id'],
  },
  auto_commit_failed: {
    stage: 'EXECUTE',
    classifier: 'recovery-rule',
    rule_id: 'auto_commit_failed',
    outcome: ['work_item_id', 'error'],
  },
  auto_commit_rejected_off_scope: {
    stage: 'EXECUTE',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'off_scope_files'],
  },
  auto_committed_task: {
    stage: 'EXECUTE',
    classifier: 'benign',
    outcome: ['work_item_id', 'commit_sha'],
  },

  // ─── VERIFY ───────────────────────────────────────────────────────────────

  verified_batch: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'batch_id', 'verification_result'],
  },
  verify_failed: {
    stage: 'VERIFY',
    classifier: 'recovery-rule',
    rule_id: 'verify_failed',
    outcome: ['work_item_id', 'error', 'retry_count'],
  },
  verify_retry_submitted: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'retry_count', 'feedback'],
  },
  verify_passed_on_silent_rerun: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'first_failure', 'rerun_result'],
  },
  verify_reviewer_timeout_paused: {
    stage: 'VERIFY',
    classifier: 'recovery-rule',
    rule_id: 'verify_reviewer_timeout',
    outcome: ['task_id', 'error'],
  },
  verify_reviewed_ambiguous_paused: {
    stage: 'VERIFY',
    classifier: 'recovery-rule',
    rule_id: 'verify_reviewer_ambiguous',
    outcome: ['work_item_id', 'confidence'],
  },
  waiting_for_batch_tasks: {
    stage: 'VERIFY',
    classifier: 'recovery-rule',
    rule_id: 'verify_batch_tasks_not_terminal',
    outcome: ['batch_id', 'task_count'],
  },
  auto_rejected_verify_fail: {
    stage: 'VERIFY',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'retry_count'],
  },
  verify_empty_branch_routed_to_needs_replan: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'reason'],
  },
  verify_empty_branch_auto_shipped: {
    stage: 'VERIFY',
    classifier: 'terminal',
    outcome: ['work_item_id', 'reason'],
  },
  verify_aborted_project_paused: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'project_status'],
  },
  verify_silent_rerun_started: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'attempt'],
  },
  verify_silent_rerun_failed: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'error'],
  },
  verify_rerun_same_failure: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'failure_match'],
  },
  verify_rerun_different_failure: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'first_failure', 'second_failure'],
  },
  verify_retry_branch_recreated_from_origin: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'branch', 'retry_count'],
  },
  verify_retry_worktree_recovered: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'worktree_path', 'retry_count'],
  },
  verify_retry_worktree_recovery_failed: {
    stage: 'VERIFY',
    classifier: 'recovery-rule',
    rule_id: 'verify_retry_worktree_recovery_failed',
    outcome: ['work_item_id', 'error', 'retry_count'],
  },
  auto_rejected_worktree_lost: {
    stage: 'VERIFY',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'reason'],
  },
  verify_retry_escalated_to_codex: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'retry_count', 'provider'],
  },
  verify_retry_submission_failed: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'error', 'retry_count'],
  },
  verify_retry_task_failed: {
    stage: 'VERIFY',
    classifier: 'recovery-rule',
    rule_id: 'verify_retry_task_failed',
    outcome: ['work_item_id', 'task_id', 'error', 'retry_count'],
  },
  verify_retry_task_completed: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'task_id', 'retry_count'],
  },
  verify_retry_suppressed_zero_diff: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'reason'],
  },
  verify_skipped_plan_already_satisfied: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'reason'],
  },
  verify_reviewer_fail_open: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'reason'],
  },
  branch_stale_detected: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'branch', 'commits_behind'],
  },
  branch_auto_rebased: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'branch', 'commits_behind'],
  },
  branch_stale_rebase_conflict: {
    stage: 'VERIFY',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'branch', 'error'],
  },
  branch_stale_detected_post_verify: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'branch', 'commits_behind'],
  },
  branch_auto_rebased_post_verify: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'branch', 'commits_behind'],
  },
  branch_stale_rebase_conflict_post_verify: {
    stage: 'VERIFY',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'branch', 'error'],
  },
  retry_off_scope: {
    stage: 'VERIFY',
    classifier: 'b-side-reject',
    outcome: ['off_scope_files', 'envelope'],
  },
  retry_verify_requested: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'retry_count'],
  },
  skipped_verification: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'reason'],
  },
  worktree_verify_passed: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'verify_output'],
  },
  worktree_verify_failed: {
    stage: 'VERIFY',
    classifier: 'recovery-rule',
    rule_id: 'dotnet_sourcelink_file_lock',
    outcome: ['work_item_id', 'output_preview', 'error'],
  },
  worktree_verify_errored: {
    stage: 'VERIFY',
    classifier: 'recovery-rule',
    rule_id: 'worktree_verify_errored',
    outcome: ['work_item_id', 'error'],
  },
  auto_shipped_at_verify_fail: {
    stage: 'VERIFY',
    classifier: 'terminal',
    outcome: ['work_item_id', 'reason'],
  },
  factory_verify_unrecoverable: {
    stage: 'VERIFY',
    classifier: 'terminal',
    outcome: ['work_item_id', 'error', 'reason'],
  },
  factory_verify_auto_retry: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'retry_count'],
  },
  dep_resolver_no_adapter: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'dep_type'],
  },
  dep_resolver_pending_approval: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'dep_type', 'dependency'],
  },
  dep_resolver_disabled: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'reason'],
  },
  dep_resolver_cascade_exhausted: {
    stage: 'VERIFY',
    classifier: 'terminal',
    outcome: ['work_item_id', 'dep_type', 'attempts'],
  },
  dep_resolver_detected: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'dep_type', 'dependency'],
  },
  dep_resolver_escalated: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'dep_type', 'reason'],
  },
  dep_resolver_escalation_retry: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'dep_type', 'attempt'],
  },
  dep_resolver_escalation_pause: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'dep_type', 'reason'],
  },
  dep_resolver_reverify_passed: {
    stage: 'VERIFY',
    classifier: 'benign',
    outcome: ['work_item_id', 'dep_type'],
  },

  // ─── LEARN ────────────────────────────────────────────────────────────────

  learned: {
    stage: 'LEARN',
    classifier: 'benign',
    outcome: ['feedback_id', 'summary'],
  },
  learn_failed: {
    stage: 'LEARN',
    classifier: 'recovery-rule',
    rule_id: 'learn_failed',
    outcome: ['batch_id', 'status', 'error'],
  },
  shipped_work_item: {
    stage: 'LEARN',
    classifier: 'terminal',
    outcome: ['work_item_id', 'batch_id', 'merge_status', 'commit_sha'],
  },
  skipped_shipping: {
    stage: 'LEARN',
    classifier: 'benign',
    outcome: ['work_item_id', 'work_item_status', 'reason', 'execution_action'],
  },
  already_closed: {
    stage: 'LEARN',
    classifier: 'benign',
    outcome: ['work_item_id', 'work_item_status', 'reason'],
  },
  worktree_path_missing_abandoned: {
    stage: 'LEARN',
    classifier: 'benign',
    outcome: ['work_item_id', 'worktree_path'],
  },
  auto_rejected_no_worktree: {
    stage: 'LEARN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'reason'],
  },
  worktree_merged: {
    stage: 'LEARN',
    classifier: 'terminal',
    outcome: ['work_item_id', 'branch', 'merge_sha', 'factory_worktree_id'],
  },
  worktree_merged_cleanup_failed: {
    stage: 'LEARN',
    classifier: 'benign',
    outcome: ['work_item_id', 'branch', 'error'],
  },
  worktree_merge_failed: {
    stage: 'LEARN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'error'],
  },
  auto_shipped_empty_branch: {
    stage: 'LEARN',
    classifier: 'terminal',
    outcome: ['work_item_id', 'reason'],
  },
  empty_branch_routed_to_needs_replan: {
    stage: 'LEARN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'reason'],
  },
  auto_quarantined_empty_merges: {
    stage: 'LEARN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'reason'],
  },
  auto_resolved_stranded_needs_review_shipped: {
    stage: 'LEARN',
    classifier: 'terminal',
    outcome: ['work_item_id', 'batch_id', 'merge_status'],
  },
  auto_resolved_stranded_needs_review_replan: {
    stage: 'LEARN',
    classifier: 'b-side-reject',
    outcome: ['work_item_id', 'reason'],
  },

  // ─── ANY (cross-stage) ────────────────────────────────────────────────────

  paused_at_gate: {
    stage: 'ANY',
    classifier: 'recovery-rule',
    rule_id: 'execute_worktree_creation_fs_lock',
    outcome: ['from_state', 'to_state', 'gate_stage', 'reason', 'work_item_id'],
  },
  gate_approved: {
    stage: 'ANY',
    classifier: 'benign',
    outcome: ['approved_stage', 'from_state', 'to_state'],
  },
  closed_work_item_loop_stopped: {
    stage: 'ANY',
    classifier: 'benign',
    outcome: ['work_item_id', 'work_item_status', 'reject_reason'],
  },

  // ─── ENGINE (auto-recovery self-reporting) ───────────────────────────────

  auto_recovery_classified: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['category', 'matched_rule', 'suggested_strategies'],
  },
  auto_recovery_exhausted: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['reason'],
  },
  auto_recovery_rearmed: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['reason'],
  },
  auto_recovery_skipped_benign: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['action'],
  },
  auto_recovery_skipped_terminal: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['action'],
  },
  auto_recovery_strategy_failed: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['strategy', 'error'],
  },
  auto_recovery_strategy_selected: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['strategy', 'classification'],
  },
  auto_recovery_strategy_succeeded: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['strategy', 'classification'],
  },
  auto_recovery_unknown_action: {
    stage: 'ANY',
    classifier: 'engine',
    outcome: ['original_action', 'original_stage', 'outcome_keys', 'work_item_id', 'task_id', 'engine_decided_strategies'],
  },
};

module.exports = { DECISION_ACTIONS };
