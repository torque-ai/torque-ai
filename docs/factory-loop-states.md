# Factory Loop State Machine Reference

This document is the canonical reference for TORQUE's factory loop state machine. It exists because the *declared* states in `server/factory/loop-states.js` are a small clean subset of what the *implementation* in `server/factory/loop-controller.js` (14k+ LOC) actually does. The implicit complexity — pseudo-states, pause variants, re-entry rules, decision-action emissions — has accreted across many sessions and was previously only legible by reading the code.

This is the layer one level beneath `docs/recovery-decisions.md`: that doc covers what to do when work fails; this doc covers the loop the recovery layer is reasoning about.

---

## TL;DR

- **10 declared states** (`loop-states.js`): SENSE, PRIORITIZE, PLAN, PLAN_REVIEW, EXECUTE, VERIFY, LEARN, IDLE, PAUSED, STARVED.
- **6 declared forward transitions** (linear chain SENSE → … → LEARN → IDLE).
- **Pseudo-states the implementation actually uses** that are NOT in the declared set: `READY_FOR_<stage>` (queued for a stage that's currently occupied), `VERIFY_FAIL` (a paused-at-stage value, not a `loop_state` value), and `paused_at_gate` (an action, not a state). PAUSED itself is encoded via two orthogonal fields, not one.
- **Multiple pause variants** that don't always co-set the related fields. Operator-experience cliffs hide here.

---

## States (declared + actual)

### Declared (in `server/factory/loop-states.js`)

| State | Meaning |
|---|---|
| `SENSE` | Scan work intake (plans dir, factory-intake queue). |
| `PRIORITIZE` | Select next work item; score by priority. |
| `PLAN` | Generate a plan via Codex (or use stored plan file). |
| `PLAN_REVIEW` | Approval-gate placeholder. Not entered during normal flow. |
| `EXECUTE` | Run plan tasks. |
| `VERIFY` | Run verify command / test suite. |
| `LEARN` | Ship the work item (merge worktree, record outcome). |
| `IDLE` | Loop not running; instance terminated. Terminal. |
| `PAUSED` | Operator pause OR awaiting gate approval. Encoded via two fields — see "Pause variants" below. |
| `STARVED` | No open work items in intake. Triggers starvation recovery. |

`FORWARD_TRANSITIONS` declares only the normal linear chain: `SENSE → PRIORITIZE → PLAN → EXECUTE → VERIFY → LEARN → IDLE`. The legacy `TRANSITIONS` export remains as an alias for older imports, but new code should use `FORWARD_TRANSITIONS` so backward/self/parking edges are not mistaken for missing entries.

### Pseudo-states the implementation uses

These are NOT in `LOOP_STATES`. They live in `factory_loop_instances.paused_at_stage` (a column whose values overlap with but extend beyond `loop_state`):

| Pseudo-state | What it means | Set by |
|---|---|---|
| `READY_FOR_<stage>` (e.g., `READY_FOR_PLAN`, `READY_FOR_EXECUTE`) | The instance wants to advance to `<stage>` but the stage is currently occupied by another instance. Parked until the next `advanceLoop()` retries `tryMoveInstanceToStage()`. | `parkInstanceForStage()` after a `StageOccupiedError`. |
| `EXECUTE_DEFERRED` | The instance is paused only to wait for deferred plan-generation state to clear, while still deriving to the real `EXECUTE` loop state. | Explicit deferred EXECUTE recovery rows; legacy bare `EXECUTE` rows with plan-generation evidence are still accepted for compatibility. |
| `VERIFY_FAIL` | Verification failed terminally (auto-retries exhausted, ambiguous failure, reviewer timeout, retry-submission errors, worktree-and-branch lost). Cleared by operator via `retryVerifyFromFailure()`. | Multiple sites in `executeVerifyStage` (loop-controller.js lines ~12121, 12185, 12391, 12441, 12489, 12525, 12551). |
| `<concrete stage>` (e.g., `PRIORITIZE`, `PLAN`, `VERIFY`, `LEARN`) | Awaiting operator approval at this gate. Cleared by `approveGate(<stage>)`. | Trust-level gate logic in `getNextState()`. |

Implementation reads back to a declared state via `deriveInstanceStateFromLegacyProject()` (loop-controller.js:1527): `paused_at_stage` starting with `READY_FOR_` strips the prefix to get the target stage; `VERIFY_FAIL` maps back to `VERIFY`; `EXECUTE_DEFERRED` maps back to `EXECUTE`; bare stage names map to themselves.

---

## Storage schema

State lives across two tables. The split is partly historical (multi-instance support was added on top of a single-instance model) and partly intentional (project-wide vs instance-scoped concerns).

### `factory_loop_instances` (per-instance state — current)

| Column | What |
|---|---|
| `id` | Instance PK. |
| `project_id` | FK. |
| `loop_state` | Current declared state (one of the 10 in `LOOP_STATES`). |
| `paused_at_stage` | Pseudo-state for pause: a gate stage name (e.g., `LEARN`), `READY_FOR_<stage>`, or `VERIFY_FAIL`. NULL when not paused. |
| `batch_id` | Current batch ID (Codex task batch, auto-commit, worktree, etc.). |
| `work_item_id` | Currently claimed work item. |
| `last_action_at` | ISO timestamp of last state transition. |
| `terminated_at` | When set, instance is dead. Distinguishes "terminated → IDLE" from "transient idle". |

### `factory_projects` (project-wide state)

| Column | What |
|---|---|
| `loop_state` | **Legacy mirror** of the oldest active instance's `loop_state`. Kept for backward compat. New code should read the instance directly. |
| `loop_paused_at_stage` | Legacy mirror of instance's `paused_at_stage`. |
| `loop_batch_id`, `loop_last_action_at` | More legacy mirrors. |
| `status` | `'idle'`, `'paused'`, `'running'`, `'failed'`. **Operator-set; orthogonal to instance state.** |
| `auto_recovery_exhausted` | `0` or `1`. Set by the auto-recovery engine when its retry rules have been burned. Read by the recovery layer (not by the loop directly). |
| `auto_recovery_attempts`, `auto_recovery_last_action_at`, `auto_recovery_last_strategy` | Recovery bookkeeping. |

---

## Pause variants

The audit's most important finding: **PAUSED is not a single state — it's the cross-product of two orthogonal pause flags**. They don't always co-set, and approving one without the other leaves the loop stuck.

| Variant | Set by | Field touched | Cleared by | Loop-advance check |
|---|---|---|---|---|
| **Gate pause** | Trust-level gate fires in `getNextState()` | `instance.paused_at_stage = <stage>` | `approveGate(<stage>)` | If set, `advanceLoop()` refuses to advance until cleared. |
| **Project-wide operator pause** | `pause_project()` API | `project.status = 'paused'` | `resume_project()` API | `isProjectStatusPaused()` checked at every advance — returns early if true, **regardless of instance.paused_at_stage**. |
| **Stage occupancy park** | `parkInstanceForStage()` after `StageOccupiedError` | `instance.paused_at_stage = 'READY_FOR_<stage>'` | Next `advanceLoop()` or startup reconciliation retries `tryMoveInstanceToStage()` | If both the park and occupant exceed the watchdog threshold, and the occupant has no live batch tasks, `advanceLoop()` terminates the occupant and retries with a diagnostic decision. |
| **Plan-generation deferral wait** | Deferred plan-generation recovery paths | `instance.paused_at_stage = 'EXECUTE_DEFERRED'` for explicit paused rows; current submit-boundary deferrals usually stay in `EXECUTE` with `paused_at_stage = NULL`; legacy bare `EXECUTE` rows with plan-generation task evidence are still recoverable | `maybeClearDeferredPlanGenerationWait()` when task finishes / timeout | Distinct from fail-loud bare `EXECUTE` pauses; readers no longer need the decision log to identify explicit deferred rows. |
| **VERIFY_FAIL pause** | Multiple `pause_at_stage: 'VERIFY_FAIL'` writes in `executeVerifyStage` | `instance.paused_at_stage = 'VERIFY_FAIL'` | `retryVerifyFromFailure()` operator API | Same column; treated as VERIFY for state-derivation. |

### The cliff: gate approval vs project-wide pause

`approveGate()` clears `instance.paused_at_stage`. It does NOT clear `project.status`. So this sequence breaks operator expectation:

1. Loop pauses at LEARN (gate). `instance.paused_at_stage = 'LEARN'`, `project.status = 'idle'`.
2. Operator (or another session) calls `pause_project()`. `project.status = 'paused'`.
3. Operator calls `approve_gate(LEARN)` thinking they're resuming. `instance.paused_at_stage = null`.
4. Next `advanceLoop()` — returns early via `isProjectStatusPaused()`. Loop doesn't advance.
5. Operator: "I approved the gate. Why isn't it running?"

**Fix landed 2026-05-06** (commit landing with this doc): `approveGate()` now refuses on operator-paused projects with a clear error message — same shape as `startFactoryLoop`'s pre-flight check at line ~12795. Auto-recovery's `retry` strategy (which calls `services.approveGate()` for non-VERIFY paused stages — `plugins/auto-recovery-core/strategies/retry.js:54`) inherits this guard, so recovery cannot silently fight an operator pause either.

---

## Transition catalog

Declared transitions (linear chain) plus the implicit edges discovered in the implementation:

| From | To | Trigger | Predicate | Decisions emitted | Side effects |
|---|---|---|---|---|---|
| `SENSE` | `PRIORITIZE` (or gated stage) | `advanceLoop` | Next state per `FORWARD_TRANSITIONS` | `scanned_plans`, `paused_at_gate` | Stage claim |
| `PRIORITIZE` | `PLAN` | `handlePrioritizeTransition` | Work item selected, no gate | `selected_work_item` | Remember work item |
| `PRIORITIZE` | `IDLE` | `handlePrioritizeTransition` | No work items | `no_selected_work_item` | Terminate |
| `PRIORITIZE` | `IDLE` | `handlePrioritizeTransition` | Auto-shipped detected | `auto_shipped` (`reason=at_prioritize`) | Mark shipped + terminate |
| `PRIORITIZE` | `STARVED` | `advanceLoop` (if no work) | `countOpenWorkItems() === 0` | `stale_probe_starvation` | Set `loop_state = STARVED` |
| `PLAN` | `EXECUTE` | `executeNonPlanFileStage` / `executePlanFileStage` | Plan generated | `generated_plan` or `skipped_for_plan_file` | Write plan file |
| `PLAN` | `IDLE` | `executeNonPlanFileStage` | Cannot generate plan | `cannot_generate_plan` | Route work item to needs_replan |
| `EXECUTE` | `VERIFY` | `executePlanFileStage` | All tasks completed, diff > 0 | `completed_execution` | Submit verify task |
| `EXECUTE` | `LEARN` | `maybeShipNoop` | Zero diff + noop-ship allowed | `shipped_as_noop` | Skip VERIFY |
| `EXECUTE` | `IDLE` | zero-diff short-circuit | Prior retries produced no diff | `execute_zero_diff_short_circuit` | Terminate |
| `EXECUTE` | `EXECUTE` (deferral) | `deferExecutePlanTaskIfProjectPaused` | Project paused mid-execute | `execute_deferred_paused` | Defer plan task |
| `VERIFY` | `LEARN` | `runExecuteVerifyStage` | Verify passed | `verified_batch` | Mark batch verified |
| `VERIFY` | `VERIFY` (retry) | `runExecuteVerifyStage` | Verify failed, retry allowed | `verify_retry_submitted` | Submit verify retry |
| `VERIFY` | (paused) `VERIFY_FAIL` | `runExecuteVerifyStage` | Auto-retries exhausted / ambiguous / reviewer timeout / submission errors | `auto_rejected_verify_fail` or `verify_failed` | Set `paused_at_stage = VERIFY_FAIL` |
| `VERIFY_FAIL` | `VERIFY` | `retryVerifyFromFailure()` | Operator API call | `retry_verify_requested` | Clear `paused_at_stage`; resubmit verify |
| `LEARN` | `SENSE` | `executeLearnStage` + `auto_continue=true` | Ship success | `learned`, `shipped_work_item` | Merge, ship, loop back |
| `LEARN` | `IDLE` | `executeLearnStage` (default) | Ship success | `learned`, `shipped_work_item` | Merge, ship, terminate |
| `LEARN` | (paused) | `assertWorktreeIsClean` fails | `merge_target_dirty` or `merge_target_in_conflict_state` | `merge_target_dirty` / `merge_target_in_conflict_state` | Set `project.status = 'paused'`. Recovery: see `recovery-decisions.md` conflict #1 — A-side `discard-regenerable-merge-block` strategy may auto-clean. |
| Any | (paused gate) | gate predicate | Trust-level gates this stage | `paused_at_gate` | Set `instance.paused_at_stage = <stage>` |
| (paused gate) | (previous stage) | `approveGate` | Operator approves; project not paused | `gate_approved` | Clear `paused_at_stage`; advance |
| (paused gate) | `IDLE` | `rejectGate` | Operator rejects | (route via recovery) | Move work item to rejected |
| Any | `STARVED` | `advanceLoop` | No open work items after PRIORITIZE | `stale_probe_starvation` | Set `loop_state = STARVED` |
| `STARVED` | `PRIORITIZE` | `triggerImmediateStarvationRecovery` | Recovery scout found new work | `starvation_recovered` | Clear starvation |

**Backward/self edges** outside `FORWARD_TRANSITIONS` that the code does take:
- `PLAN` / `EXECUTE` → `PRIORITIZE` on `stop_execution` events (via `moveInstanceToStage(...)`, multiple call sites).
- `VERIFY` → `VERIFY` (retry within stage).
- `EXECUTE` → `EXECUTE` (deferral).

---

## Decision-action emission map

Every `safeLogDecision({ action: '...', stage, outcome })` call site produces a row in the `factory_decisions` table. These are the matchers A-side classifier rules (`server/plugins/auto-recovery-core/rules.js`) listen for. **An action with no matching rule routes to `UNKNOWN_CLASSIFICATION` and the engine's default `['retry', 'escalate']` chain** — which often loops on the same provider that just failed (the conflict #4 fix in `recovery-decisions.md` covered exactly this shape).

Frequently-emitted actions, by stage:

<!-- BEGIN AUTOGEN: decision-actions-table -->
| Stage | Action | Classifier | Outcome shape |
|---|---|---|---|
| SENSE | `scanned_plans` | `benign` | `plans_dir`, `scanned`, `created_count`, `shipped_count` |
| SENSE | `started_loop` | `benign` | `from_state`, `to_state`, `instance_id` |
| SENSE | `starting` | `benign` | _(none)_ |
| SENSE | `start_loop_blocked_project_paused` | `benign` | `started`, `status` |
| PRIORITIZE | `selected_work_item` | `benign` | `work_item_id`, `priority`, `status`, `source`, `batch_id` |
| PRIORITIZE | `scored_work_item` | `benign` | `work_item_id`, `score`, `factors` |
| PRIORITIZE | `no_selected_work_item` | `benign` | `reason`, `work_item_id`, `batch_id` |
| PRIORITIZE | `healed_already_shipped` | `benign` | `work_item_id`, `previous_status`, `new_status`, `factory_worktree_id`, `branch`, `merged_at` |
| PRIORITIZE | `stale_probe_budget_exhausted` | `benign` | `skipped`, `max_repicks`, `fallback_work_item_id` |
| PRIORITIZE | `skipped_stale_scout_item` | `benign` | `work_item_id`, `stale_reason`, `commits_since_scan`, `probe_ms` |
| PRIORITIZE | `stale_probe_starvation` | `benign` | `skipped` |
| PRIORITIZE | `scout_promoted` | `benign` | `work_item_id`, `scout_id` |
| PRIORITIZE | `decompose_would_yield_eligible` | `benign` | `work_item_id`, `eligibleCount`, `subtaskCount`, `decomposed` |
| PRIORITIZE | `parked_codex_unavailable` | `benign` | `work_item_id`, `reason` |
| PRIORITIZE | `marked_for_failover_routing` | `benign` | `work_item_id`, `instance_id`, `fallback_template` |
| PRIORITIZE | `auto_rejected_stuck_executing` | `b-side-reject` | `work_item_id`, `reason`, `stuck_since` |
| PLAN | `generated_plan` | `benign` | `work_item_id`, `plan_path`, `task_count`, `description_quality` |
| PLAN | `plan_generated` | `benign` | `work_item_id`, `plan_path`, `task_count` |
| PLAN | `cannot_generate_plan` | `recovery-rule` (rule: `codex_phantom_success`) | `work_item_id`, `error`, `attempt` |
| PLAN | `cannot_generate_plan_routed_to_needs_replan` | `benign` | `work_item_id`, `reason` |
| PLAN | `skipped_for_plan_file` | `benign` | `work_item_id`, `plan_path` |
| PLAN | `plan_review_started` | `benign` | `reviewers`, `reviewer_count` |
| PLAN | `plan_review_verdict` | `benign` | `reviewer`, `provider`, `verdict`, `confidence`, `concerns`, `suggestions`, `task_id`, `reason` |
| PLAN | `plan_review_aggregated` | `benign` | `overall`, `reviewer_count`, `has_warnings`, `blocked` |
| PLAN | `plan_lint_rejected` | `b-side-reject` | `work_item_id`, `reason`, `lint_errors` |
| PLAN | `plan_lint_warnings` | `benign` | `work_item_id`, `warnings` |
| PLAN | `plan_description_quality_rejected` | `b-side-reject` | `work_item_id`, `quality_score`, `reason` |
| PLAN | `plan_description_quality_routed_to_needs_replan` | `b-side-reject` | `work_item_id`, `quality_score`, `reason` |
| PLAN | `plan_quality_passed` | `benign` | `work_item_id`, `quality_score` |
| PLAN | `plan_quality_rejected_will_replan` | `b-side-reject` | `work_item_id`, `quality_score`, `reason`, `retry_count` |
| PLAN | `plan_quality_routed_to_needs_replan_after_intrabatch_retries` | `b-side-reject` | `work_item_id`, `quality_score`, `retry_count` |
| PLAN | `plan_quality_gate_fail_open` | `benign` | `work_item_id`, `reason` |
| PLAN | `plan_quality_skipped_by_metadata` | `benign` | `work_item_id`, `reason` |
| PLAN | `plan_quality_soft_threshold_crossed` | `benign` | `work_item_id`, `quality_score`, `threshold` |
| PLAN | `resumed_plan_quality_rejected` | `b-side-reject` | `work_item_id`, `quality_score`, `reason` |
| PLAN | `stale_generated_plan_cleared_before_replan` | `benign` | `work_item_id`, `plan_path` |
| PLAN | `pre_written_plan_quality_rejected` | `b-side-reject` | `work_item_id`, `quality_score`, `reason` |
| PLAN | `pre_written_plan_quality_rejected_before_execute` | `b-side-reject` | `work_item_id`, `quality_score`, `reason` |
| EXECUTE | `plan_generation_deferred_project_active` | `benign` | `reason`, `plan_path`, `generation_task_id`, `blocking_work_item_id`, `task_status`, `work_item_id` |
| EXECUTE | `plan_generation_retry_unusable_output` | `recovery-rule` (rule: `plan_generation_unusable_output`) | `work_item_id`, `provider` |
| EXECUTE | `started_execution` | `benign` | `from_state`, `to_state`, `reason`, `batch_id`, `work_item_id` |
| VERIFY | `entered_from_execute` | `benign` | `from_state`, `to_state`, `paused_at_stage`, `reason`, `batch_id` |
| EXECUTE | `completed_execution` | `benign` | `work_item_id`, `task_count`, `execution_time_ms` |
| EXECUTE | `execute_completed_after_no_op_retries` | `benign` | `work_item_id`, `retry_count` |
| EXECUTE | `execute_completed_with_agent_self_commits` | `benign` | `work_item_id`, `commit_count` |
| EXECUTE | `execute_deferred_paused` | `benign` | `work_item_id`, `plan_path`, `plan_task_number`, `remaining_plan_task_number`, `plan_task_title`, `project_status`, `next_state` |
| EXECUTE | `execute_deferred_paused_stale_warning` | `benign` | `work_item_id`, `plan_task_number`, `deferred_at` |
| EXECUTE | `execute_deferred_resumed` | `benign` | `work_item_id`, `plan_task_number`, `resumed_at` |
| EXECUTE | `execute_deferred_worktree_reused` | `benign` | `factory_worktree_id`, `worktree_id`, `worktree_path`, `branch`, `batch_id` |
| EXECUTE | `execute_exception` | `recovery-rule` (rule: `execute_exception_unclassified`) | `work_item_id`, `error` |
| EXECUTE | `execute_wait_owner_completed` | `benign` | `owning_task_id`, `owning_status` |
| EXECUTE | `execute_zero_diff_short_circuit` | `recovery-rule` (rule: `execute_zero_diff_short_circuit`) | `work_item_id`, `reason` |
| EXECUTE | `execution_failed` | `recovery-rule` (rule: `execute_execution_failed`) | `work_item_id` |
| EXECUTE | `intake_generation_meta_rejected` | `b-side-reject` | `title`, `reason` |
| EXECUTE | `worktree_created` | `benign` | `factory_worktree_id`, `worktree_id`, `worktree_path`, `branch`, `batch_id` |
| EXECUTE | `worktree_creation_failed` | `recovery-rule` (rule: `execute_worktree_creation_fs_lock`) | `work_item_id`, `error`, `reason` |
| EXECUTE | `worktree_reclaimed` | `benign` | `work_item_id`, `factory_worktree_id`, `branch` |
| EXECUTE | `worktree_reclaim_skipped_in_flight_same_wi` | `benign` | `work_item_id`, `factory_worktree_id` |
| EXECUTE | `worktree_reclaim_skipped_live_owner` | `benign` | `work_item_id`, `factory_worktree_id`, `owning_task_id` |
| EXECUTE | `auto_rejected_spin_loop` | `b-side-reject` | `starts_in_window`, `threshold`, `window_since`, `next_state` |
| EXECUTE | `dry_run_task` | `benign` | `work_item_id`, `task_number`, `simulated`, `submitted_task_id`, `execution_mode` |
| EXECUTE | `auto_commit_skipped_clean` | `recovery-rule` (rule: `execute_auto_commit_skipped_clean`) | `work_item_id` |
| EXECUTE | `auto_commit_failed` | `recovery-rule` (rule: `auto_commit_failed`) | `work_item_id`, `error` |
| EXECUTE | `auto_commit_rejected_off_scope` | `b-side-reject` | `work_item_id`, `off_scope_files` |
| EXECUTE | `auto_committed_task` | `benign` | `work_item_id`, `commit_sha` |
| VERIFY | `verified_batch` | `benign` | `work_item_id`, `batch_id`, `verification_result` |
| VERIFY | `verify_failed` | `recovery-rule` (rule: `verify_failed`) | `work_item_id`, `error`, `retry_count` |
| VERIFY | `verify_retry_submitted` | `benign` | `work_item_id`, `retry_count`, `feedback` |
| VERIFY | `verify_passed_on_silent_rerun` | `benign` | `work_item_id`, `first_failure`, `rerun_result` |
| VERIFY | `verify_reviewer_timeout_paused` | `recovery-rule` (rule: `verify_reviewer_timeout`) | `task_id`, `error` |
| VERIFY | `verify_reviewed_ambiguous_paused` | `recovery-rule` (rule: `verify_reviewer_ambiguous`) | `work_item_id`, `confidence` |
| VERIFY | `waiting_for_batch_tasks` | `recovery-rule` (rule: `verify_batch_tasks_not_terminal`) | `batch_id`, `task_count` |
| VERIFY | `auto_rejected_verify_fail` | `b-side-reject` | `work_item_id`, `retry_count` |
| VERIFY | `verify_empty_branch_routed_to_needs_replan` | `benign` | `work_item_id`, `reason` |
| VERIFY | `verify_empty_branch_auto_shipped` | `terminal` | `work_item_id`, `reason` |
| VERIFY | `verify_aborted_project_paused` | `benign` | `work_item_id`, `project_status` |
| VERIFY | `verify_silent_rerun_started` | `benign` | `work_item_id`, `attempt` |
| VERIFY | `verify_silent_rerun_failed` | `benign` | `work_item_id`, `error` |
| VERIFY | `verify_rerun_same_failure` | `benign` | `work_item_id`, `failure_match` |
| VERIFY | `verify_rerun_different_failure` | `benign` | `work_item_id`, `first_failure`, `second_failure` |
| VERIFY | `verify_retry_branch_recreated_from_origin` | `benign` | `work_item_id`, `branch`, `retry_count` |
| VERIFY | `verify_retry_worktree_recovered` | `benign` | `work_item_id`, `worktree_path`, `retry_count` |
| VERIFY | `verify_retry_worktree_recovery_failed` | `recovery-rule` (rule: `verify_retry_worktree_recovery_failed`) | `work_item_id`, `error`, `retry_count` |
| VERIFY | `auto_rejected_worktree_lost` | `b-side-reject` | `work_item_id`, `reason` |
| VERIFY | `verify_retry_escalated_to_codex` | `benign` | `work_item_id`, `retry_count`, `provider` |
| VERIFY | `verify_retry_submission_failed` | `benign` | `work_item_id`, `error`, `retry_count` |
| VERIFY | `verify_retry_task_failed` | `recovery-rule` (rule: `verify_retry_task_failed`) | `work_item_id`, `task_id`, `error`, `retry_count` |
| VERIFY | `verify_retry_task_completed` | `benign` | `work_item_id`, `task_id`, `retry_count` |
| VERIFY | `verify_retry_suppressed_zero_diff` | `benign` | `work_item_id`, `reason` |
| VERIFY | `verify_skipped_plan_already_satisfied` | `benign` | `work_item_id`, `reason` |
| VERIFY | `verify_reviewer_fail_open` | `benign` | `work_item_id`, `reason` |
| VERIFY | `branch_stale_detected` | `benign` | `work_item_id`, `branch`, `commits_behind` |
| VERIFY | `branch_auto_rebased` | `benign` | `work_item_id`, `branch`, `commits_behind` |
| VERIFY | `branch_stale_rebase_conflict` | `b-side-reject` | `work_item_id`, `branch`, `error` |
| VERIFY | `branch_stale_detected_post_verify` | `benign` | `work_item_id`, `branch`, `commits_behind` |
| VERIFY | `branch_auto_rebased_post_verify` | `benign` | `work_item_id`, `branch`, `commits_behind` |
| VERIFY | `branch_stale_rebase_conflict_post_verify` | `b-side-reject` | `work_item_id`, `branch`, `error` |
| VERIFY | `retry_off_scope` | `b-side-reject` | `off_scope_files`, `envelope` |
| VERIFY | `retry_verify_requested` | `benign` | `work_item_id`, `retry_count` |
| VERIFY | `skipped_verification` | `benign` | `work_item_id`, `reason` |
| VERIFY | `worktree_verify_passed` | `benign` | `work_item_id`, `verify_output` |
| VERIFY | `worktree_verify_failed` | `recovery-rule` (rule: `dotnet_sourcelink_file_lock`) | `work_item_id`, `output_preview`, `error` |
| VERIFY | `worktree_verify_errored` | `recovery-rule` (rule: `worktree_verify_errored`) | `work_item_id`, `error` |
| VERIFY | `factory_verify_unrecoverable` | `terminal` | `work_item_id`, `error`, `reason` |
| VERIFY | `factory_verify_auto_retry` | `benign` | `work_item_id`, `retry_count` |
| VERIFY | `dep_resolver_no_adapter` | `benign` | `work_item_id`, `dep_type` |
| VERIFY | `dep_resolver_pending_approval` | `benign` | `work_item_id`, `dep_type`, `dependency` |
| VERIFY | `dep_resolver_disabled` | `benign` | `work_item_id`, `reason` |
| VERIFY | `dep_resolver_cascade_exhausted` | `terminal` | `work_item_id`, `dep_type`, `attempts` |
| VERIFY | `dep_resolver_detected` | `benign` | `work_item_id`, `dep_type`, `dependency` |
| VERIFY | `dep_resolver_escalated` | `benign` | `work_item_id`, `dep_type`, `reason` |
| VERIFY | `dep_resolver_escalation_retry` | `benign` | `work_item_id`, `dep_type`, `attempt` |
| VERIFY | `dep_resolver_escalation_pause` | `benign` | `work_item_id`, `dep_type`, `reason` |
| VERIFY | `dep_resolver_reverify_passed` | `benign` | `work_item_id`, `dep_type` |
| LEARN | `learned` | `benign` | `feedback_id`, `summary` |
| LEARN | `learn_failed` | `recovery-rule` (rule: `learn_failed`) | `batch_id`, `status`, `error` |
| LEARN | `shipped_work_item` | `terminal` | `work_item_id`, `batch_id`, `merge_status`, `commit_sha` |
| LEARN | `skipped_shipping` | `benign` | `work_item_id`, `work_item_status`, `reason`, `execution_action` |
| LEARN | `already_closed` | `benign` | `work_item_id`, `work_item_status`, `reason` |
| LEARN | `worktree_path_missing_abandoned` | `benign` | `work_item_id`, `worktree_path` |
| LEARN | `auto_rejected_no_worktree` | `b-side-reject` | `work_item_id`, `reason` |
| LEARN | `worktree_merged` | `terminal` | `work_item_id`, `branch`, `merge_sha`, `factory_worktree_id` |
| LEARN | `worktree_merged_cleanup_failed` | `benign` | `work_item_id`, `branch`, `error` |
| LEARN | `worktree_merge_failed` | `b-side-reject` | `work_item_id`, `error` |
| LEARN | `empty_branch_routed_to_needs_replan` | `b-side-reject` | `work_item_id`, `reason` |
| LEARN | `auto_quarantined_empty_merges` | `b-side-reject` | `work_item_id`, `reason` |
| LEARN | `auto_resolved_stranded_needs_review_shipped` | `terminal` | `work_item_id`, `batch_id`, `merge_status` |
| LEARN | `auto_resolved_stranded_needs_review_replan` | `b-side-reject` | `work_item_id`, `reason` |
| ANY | `auto_shipped` | `terminal` | `work_item_id`, `confidence`, `signals`, `reason` |
| ANY | `paused_at_gate` | `recovery-rule` (rule: `execute_worktree_creation_fs_lock`) | `from_state`, `to_state`, `gate_stage`, `reason`, `work_item_id` |
| ANY | `gate_approved` | `benign` | `approved_stage`, `from_state`, `to_state` |
| ANY | `ready_for_stage_watchdog_released_occupant` | `benign` | `released_instance_id`, `target_stage`, `parked_stalled_minutes`, `occupant_stalled_minutes` |
| ANY | `closed_work_item_loop_stopped` | `benign` | `work_item_id`, `work_item_status`, `reject_reason` |
| ANY | `auto_recovery_classified` | `engine` | `category`, `matched_rule`, `suggested_strategies` |
| ANY | `auto_recovery_exhausted` | `engine` | `reason` |
| ANY | `auto_recovery_rearmed` | `engine` | `reason` |
| ANY | `auto_recovery_skipped_benign` | `engine` | `action` |
| ANY | `auto_recovery_skipped_terminal` | `engine` | `action` |
| ANY | `auto_recovery_strategy_failed` | `engine` | `strategy`, `error` |
| ANY | `auto_recovery_strategy_selected` | `engine` | `strategy`, `classification` |
| ANY | `auto_recovery_strategy_succeeded` | `engine` | `strategy`, `classification` |
| ANY | `auto_recovery_unknown_action` | `engine` | `original_action`, `original_stage`, `outcome_keys`, `work_item_id`, `task_id`, `engine_decided_strategies` |
<!-- END AUTOGEN: decision-actions-table -->

**When adding a new decision action**: pair the emit site with a classifier rule. If the rule's strategy chain doesn't apply, at minimum add it to `isBenignFlowDecision` so recovery skips it. Pattern that keeps biting: a new action emitted with no matching rule routes to UNKNOWN → plain retry → re-spawn the same failing provider on the same task. Three of the five `recovery-decisions.md` conflicts were variations of this.

---

## Finding production drift

The CI gate at `server/tests/factory-decision-actions-catalog.test.js` catches static-analysis-detectable drift — emit sites without catalog entries, catalog entries without classifier wiring, broken rule_id references. For dynamic action names and any change that landed without going through CI, the recovery engine emits `auto_recovery_unknown_action` whenever the classifier returns `matched_rule = null`. Query `factory_decisions` for these:

```sql
-- Anything that slipped past CI in the last 24h
SELECT created_at,
       json_extract(outcome, '$.original_action') AS original_action,
       json_extract(outcome, '$.original_stage') AS original_stage
FROM factory_decisions
WHERE action = 'auto_recovery_unknown_action'
  AND created_at > datetime('now', '-1 day')
ORDER BY created_at DESC;

-- Frequency by original_action — find the recurring offenders
SELECT json_extract(outcome, '$.original_action') AS original_action,
       COUNT(*) AS hits
FROM factory_decisions
WHERE action = 'auto_recovery_unknown_action'
GROUP BY original_action
ORDER BY hits DESC;
```

When you find a hit:

1. Confirm the `original_action` is still emitted (`grep -rn "action: '<name>'" server/`).
2. If the action is real and frequent: add it to `server/factory/decision-actions.js` with the appropriate classifier kind (see "When changing the loop" below).
3. Pair the catalog entry with classifier wiring (rule, benign-skip, terminal, b-side-reject, or engine).
4. The CI gate will pass once the catalog and wiring agree.

### Migration note: auto-ship action rename (2026-05-08)

The three previous auto-ship actions (`auto_shipped_at_prioritize`, `auto_shipped_empty_branch`, `auto_shipped_at_verify_fail`) were collapsed into a single `auto_shipped` action with a `reason` discriminator. Historical rows in `factory_decisions` retain their original action names; new rows use the unified shape.

Operator query patterns:

```sql
-- All auto-ship rows (combines historical + new)
SELECT created_at, action,
       json_extract(outcome, '$.reason') AS reason,
       json_extract(outcome, '$.work_item_id') AS work_item_id
FROM factory_decisions
WHERE action IN ('auto_shipped', 'auto_shipped_at_prioritize',
                 'auto_shipped_empty_branch', 'auto_shipped_at_verify_fail')
ORDER BY created_at DESC;

-- Frequency by reason (new rows only)
SELECT json_extract(outcome, '$.reason') AS reason, COUNT(*) AS hits
FROM factory_decisions
WHERE action = 'auto_shipped'
GROUP BY reason
ORDER BY hits DESC;
```

Reason values map 1:1 to the previous action names: `at_prioritize` ↔ `auto_shipped_at_prioritize`, `empty_branch_merge_fail` ↔ `auto_shipped_empty_branch`, `at_verify_fail` ↔ `auto_shipped_at_verify_fail`.

---

## Open questions / known risks

These are real ambiguities the audit surfaced. Each is worth addressing the next time their area comes up.

### 1. ✅ ~~Project-pause + gate-approval cliff~~ RESOLVED 2026-05-06

Operator approves a gate but project is also operator-paused → gate clears but `advanceLoop` returns early → loop appears wedged. Fixed: `approveGate()` now refuses on `project.status === 'paused'` with a clear error mirroring `startFactoryLoop`'s pre-flight check.

### 2. ✅ ~~`READY_FOR_<stage>` parking has no explicit watchdog~~ RESOLVED 2026-05-09

`advanceLoop()` now runs a bounded watchdog before retrying a `READY_FOR_<stage>` move. If both the parked instance and the blocking stage occupant are older than the watchdog threshold, and the occupant has no non-terminal factory batch tasks, the occupant is terminated with `abandonWorktree: true`, a `ready_for_stage_watchdog_released_occupant` decision is recorded, and the parked instance retries the stage claim immediately. Occupants with live batch tasks remain untouched.

### 3. ✅ ~~Two distinct meanings for `paused_at_stage = 'EXECUTE'`~~ RESOLVED 2026-05-09

- Fail-loud/operator EXECUTE pause (worktree creation failure, no executable tasks, noop shipping pause, etc.).
- Plan-generation deferral wait (project paused mid-execute, plan-task submission held).

Explicit deferred EXECUTE pause rows now use `EXECUTE_DEFERRED`, while fail-loud/operator pauses keep bare `EXECUTE`. `deriveInstanceStateFromLegacyProject()` maps `EXECUTE_DEFERRED` back to real loop state `EXECUTE`, and the tick/advance guards allow only `READY_FOR_*`, `EXECUTE_DEFERRED`, and legacy bare `EXECUTE` rows with plan-generation evidence to self-recover. Old rows that used bare `EXECUTE` for plan generation remain compatible, but new readers can distinguish explicit deferrals without consulting the decision log.

### 4. ✅ ~~Three auto-ship decision actions~~ RESOLVED 2026-05-08

`server/factory/auto-ship.js` now emits the single canonical decision action `auto_shipped` with an `AUTO_SHIPPED_REASONS` reason enum. The former action names remain only as historical `factory_decisions` rows; new auto-ship emit sites add a reason value instead of minting a new decision action. The decision-action catalog and audit gate are wired to the unified action.

### 5. ✅ ~~Backward edges undeclared~~ RESOLVED 2026-05-08

`loop-states.js` now names the canonical linear-chain map `FORWARD_TRANSITIONS` and keeps `TRANSITIONS` only as a backward-compatible alias. Backward/self/parking edges remain documented in the transition catalog above instead of being forced into the simple forward map.

### 6. ✅ ~~`factory_projects.loop_state` is a legacy mirror~~ RESOLVED 2026-05-08

Public/runtime loop-state summaries now read the oldest active `factory_loop_instances` row first. The project row remains as an explicitly named legacy mirror fallback for compatibility with no-active-instance/backfill paths, startup migration, recovery probes, and drift reporting (`project_row_loop_state_drift`).

### 7. ✅ ~~Auto-recovery interaction at restart~~ RESOLVED 2026-05-09

`startup-reconciler.js` now treats `READY_FOR_<stage>` as recoverable work instead of a terminal skip. On startup it schedules `advanceLoopAsync(instance.id, { autoAdvance: true })` for the parked instance, so the normal `READY_FOR_<stage>` retry path runs after restart. The instance does not restart from SENSE; it keeps its paused target, retries the stage claim, and relies on the bounded watchdog from Q#2 if the blocking occupant is stale and has no live batch tasks.

---

## When changing the loop

If you're adding a new state, transition, or decision action:

1. **New state** — add to `LOOP_STATES` in `loop-states.js`. Decide whether it goes in `FORWARD_TRANSITIONS` (normal forward edge) or is a backward/self/parking edge (document it here instead of polluting the linear chain). Add to `APPROVAL_GATES` if it's gateable.
2. **New transition** — add to `FORWARD_TRANSITIONS` if linear; otherwise document in this doc's transition table with the predicate. Make sure the source state's exit predicate covers your case.
3. **New decision action** — three-step contract:
   1. Add an entry to `server/factory/decision-actions.js` (the canonical catalog) with `stage`, `classifier`, optional `rule_id`, and `outcome` keys. The five classifier kinds are: `benign`, `recovery-rule`, `b-side-reject`, `terminal`, `engine`.
   2. Wire the classifier:
      - `classifier: 'benign'` → add the action to `BENIGN_FLOW_ACTION_EXACT` or extend a prefix in `server/factory/auto-recovery/engine.js`.
      - `classifier: 'recovery-rule'` → add a rule to `server/plugins/auto-recovery-core/rules.js` with the appropriate strategy chain. Set the catalog `rule_id` to match. Use `recovery-decisions.md` conflict #4 stage-catalog as the checklist.
      - `classifier: 'b-side-reject'` → add a pattern in `server/factory/replan-recovery.js` or `rejected-recovery.js` — see `recovery-decisions.md` conflict #5.
      - `classifier: 'terminal'` or `'engine'` → no further wiring; the catalog entry is the contract.
   3. Emit at the call site via `safeLogDecision({ ..., action: 'X' })` (or `logDecision({...})` for engine-internal calls).

   The CI gate at `server/tests/factory-decision-actions-catalog.test.js` will fail if any of the three steps is missing. The doc table above is auto-generated from the catalog; regenerate after adding entries:

   ```
   node server/factory/scripts/render-decision-actions-doc.js --write
   ```
4. **New pause variant** — pick an existing variant or add a new one. Document in the "Pause variants" table above. Cross-check with `approveGate` and `advanceLoop` to confirm the new variant's clear path is wired.
5. **State machine drift check** — `tests/factory-loop.test.js` and `tests/loop-states-transitions.test.js` have assertions for `LOOP_STATES` and `FORWARD_TRANSITIONS` shape. Update them.

---

## Related references

- `docs/recovery-decisions.md` — what to do when work fails. The 3 recovery subsystems (auto-recovery engine, replan/rejected sweeps, execution-layer retry/fallback) are downstream of the decisions emitted by the loop. Conflict #4's stage catalog covers the 17 task-finalizer stages and their producer-consumer pairs with recovery rules.
- `docs/factory.md` — operator-facing factory runbook. The "Auto-Recovery Decision Actions" section there covers a subset of the actions cataloged in this doc.
- `server/factory/loop-states.js` — declared states + helper functions. Authoritative for what's "valid".
- `server/factory/loop-controller.js` — the implementation. Per-stage handlers (`executePlanFileStage`, `executeVerifyStage`, `executeLearnStage`, `handlePrioritizeTransition`) own the dense logic.
- `server/factory/factory-tick.js` — the periodic tick that drives `advanceLoop` and the recovery sweeps.
