# Factory Loop State Machine Reference

This document is the canonical reference for TORQUE's factory loop state machine. It exists because the *declared* states in `server/factory/loop-states.js` are a small clean subset of what the *implementation* in `server/factory/loop-controller.js` (14k+ LOC) actually does. The implicit complexity — pseudo-states, pause variants, re-entry rules, decision-action emissions — has accreted across many sessions and was previously only legible by reading the code.

This is the layer one level beneath `docs/recovery-decisions.md`: that doc covers what to do when work fails; this doc covers the loop the recovery layer is reasoning about.

---

## TL;DR

- **10 declared states** (`loop-states.js`): SENSE, PRIORITIZE, PLAN, PLAN_REVIEW, EXECUTE, VERIFY, LEARN, IDLE, PAUSED, STARVED.
- **6 declared transitions** (linear chain SENSE → … → LEARN → IDLE).
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

`TRANSITIONS` map declares only the linear chain: `SENSE → PRIORITIZE → PLAN → EXECUTE → VERIFY → LEARN → IDLE`.

### Pseudo-states the implementation uses

These are NOT in `LOOP_STATES`. They live in `factory_loop_instances.paused_at_stage` (a column whose values overlap with but extend beyond `loop_state`):

| Pseudo-state | What it means | Set by |
|---|---|---|
| `READY_FOR_<stage>` (e.g., `READY_FOR_PLAN`, `READY_FOR_EXECUTE`) | The instance wants to advance to `<stage>` but the stage is currently occupied by another instance. Parked until the next `advanceLoop()` retries `tryMoveInstanceToStage()`. | `parkInstanceForStage()` after a `StageOccupiedError`. |
| `VERIFY_FAIL` | Verification failed terminally (auto-retries exhausted, ambiguous failure, reviewer timeout, retry-submission errors, worktree-and-branch lost). Cleared by operator via `retryVerifyFromFailure()`. | Multiple sites in `executeVerifyStage` (loop-controller.js lines ~12121, 12185, 12391, 12441, 12489, 12525, 12551). |
| `<concrete stage>` (e.g., `PRIORITIZE`, `PLAN`, `VERIFY`, `LEARN`) | Awaiting operator approval at this gate. Cleared by `approveGate(<stage>)`. | Trust-level gate logic in `getNextState()`. |

Implementation reads back to a declared state via `deriveInstanceStateFromLegacyProject()` (loop-controller.js:1527): `paused_at_stage` starting with `READY_FOR_` strips the prefix to get the target stage; `VERIFY_FAIL` maps back to `VERIFY`; bare stage names map to themselves.

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
| **Stage occupancy park** | `parkInstanceForStage()` after `StageOccupiedError` | `instance.paused_at_stage = 'READY_FOR_<stage>'` | Next `advanceLoop()` retries `tryMoveInstanceToStage()` | If still blocked, stays parked indefinitely. (Watchdog: `stuck-loop-detector.js` may alert; no auto-resolution.) |
| **Plan-generation deferral wait** | `deferExecutePlanTaskIfProjectPaused()` | `instance.paused_at_stage = 'EXECUTE'` (with a different reasoning than the gate variant) | `maybeClearDeferredPlanGenerationWait()` when task finishes / timeout | Same column as gate pause; readers must distinguish via the decision log's `action`. |
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
| `SENSE` | `PRIORITIZE` (or gated stage) | `advanceLoop` | Next state per TRANSITIONS | `scanned_plans`, `paused_at_gate` | Stage claim |
| `PRIORITIZE` | `PLAN` | `handlePrioritizeTransition` | Work item selected, no gate | `selected_work_item` | Remember work item |
| `PRIORITIZE` | `IDLE` | `handlePrioritizeTransition` | No work items | `no_selected_work_item` | Terminate |
| `PRIORITIZE` | `IDLE` | `handlePrioritizeTransition` | Auto-shipped detected | `auto_shipped_at_prioritize` | Mark shipped + terminate |
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

**Backward edges** the declared `TRANSITIONS` map doesn't show but the code does take:
- `PLAN` / `EXECUTE` → `PRIORITIZE` on `stop_execution` events (via `moveInstanceToStage(...)`, multiple call sites).
- `VERIFY` → `VERIFY` (retry within stage).
- `EXECUTE` → `EXECUTE` (deferral).

---

## Decision-action emission map

Every `safeLogDecision({ action: '...', stage, outcome })` call site produces a row in the `factory_decisions` table. These are the matchers A-side classifier rules (`server/plugins/auto-recovery-core/rules.js`) listen for. **An action with no matching rule routes to `UNKNOWN_CLASSIFICATION` and the engine's default `['retry', 'escalate']` chain** — which often loops on the same provider that just failed (the conflict #4 fix in `recovery-decisions.md` covered exactly this shape).

Frequently-emitted actions, by stage:

| Stage | Action | Approx outcome shape | Matched by recovery rule? |
|---|---|---|---|
| SENSE | `scanned_plans` | `plans_dir, scanned, created_count, shipped_count` | Benign — skipped via `isBenignFlowDecision` |
| PRIORITIZE | `selected_work_item` | `work_item_id, priority, status, source, batch_id` | Benign — `started_*` prefix |
| PRIORITIZE | `no_selected_work_item` | `work_item_status` | Benign |
| PRIORITIZE | `auto_shipped_at_prioritize` | `work_item_id, status` | Terminal — skipped (auto-ship is success path) |
| PLAN | `generated_plan` | `work_item_id, plan_path, task_count, description_quality` | Benign |
| PLAN | `cannot_generate_plan` | `work_item_id, error, attempt` | A: `codex_phantom_success` (with sandbox outcome) and `plan_generation_failed` (catch-all) |
| PLAN | `plan_lint_rejected` | `work_item_id, reason, lint_errors` | B-side replan-recovery (`rewrite-description` strategy) |
| PLAN | `plan_description_quality_rejected` | `work_item_id, quality_score, reason` | B-side |
| EXECUTE | `started_execution` | `work_item_id, batch_id, trust_level` | Benign |
| EXECUTE | `completed_execution` | `work_item_id, task_count, execution_time_ms` | Benign |
| EXECUTE | `execute_zero_diff_short_circuit` | `work_item_id, reason` | A: `execute_zero_diff_short_circuit` rule |
| EXECUTE | `execute_deferred_paused` | `work_item_id, plan_task_number, project_status` | Benign — informational |
| EXECUTE | `auto_shipped_at_execute` | `work_item_id, reason` | Terminal |
| EXECUTE | `phantom_completion_detected` | `task_id, final_status, raw_exit_code` | A: `phantom_completion_detected` rule (added 2026-05-06 — recovery-decisions.md conflict #4) |
| EXECUTE | `execute_exception` | `work_item_id, error` | A: `execute_exception_unclassified` rule |
| EXECUTE | `auto_commit_skipped_clean` | `work_item_id` | A: `execute_auto_commit_skipped_clean` rule |
| EXECUTE | `execute_execution_failed` | `work_item_id` | A: `execute_execution_failed` rule |
| EXECUTE | `plan_generation_retry_unusable_output` | `work_item_id, provider` | A: `plan_generation_unusable_output` rule |
| VERIFY | `verified_batch` | `work_item_id, batch_id, verification_result` | Benign |
| VERIFY | `verify_failed` | `work_item_id, error, retry_count` | A: `verify_fail_unclassified` rule (catch-all) |
| VERIFY | `verify_retry_submitted` | `work_item_id, retry_count, feedback` | Benign |
| VERIFY | `verify_passed_on_silent_rerun` | `work_item_id, first_failure, rerun_result` | Benign |
| VERIFY | `verify_reviewer_timeout_paused` | `task_id, error` | A: `verify_reviewer_timeout` rule |
| VERIFY | `verify_reviewed_ambiguous_paused` | `work_item_id, confidence` | A: `verify_reviewer_ambiguous` rule |
| VERIFY | `waiting_for_batch_tasks` | `batch_id, task_count` | A: `verify_batch_tasks_not_terminal` rule |
| VERIFY | `auto_rejected_verify_fail` | `work_item_id, retry_count` | B-side rejected-recovery |
| LEARN | `learned`, `shipped_work_item` | `work_item_id, batch_id, merge_status, commit_sha` | Benign — terminal success |
| LEARN | `merge_target_dirty` | `paused_at_stage, dirty_files, untracked_files` | A: `learn_merge_target_dirty` rule (with `discard-regenerable-merge-block` + `escalate` strategies — recovery-decisions.md conflict #1) |
| LEARN | `merge_target_in_conflict_state` | `paused_at_stage, op` | A: same rule as merge_target_dirty |
| LEARN | `worktree_merge_failed` | `work_item_id, error` | B-side replan-recovery |
| Any | `paused_at_gate` | `from_state, to_state, gate_stage, trust_level` | A: many rules dispatch on this with `outcome.reason` |
| Any | `gate_approved` | `approved_stage, from_state, to_state` | Benign |
| Any | `auto_recovery_classified` | `category, matched_rule, suggested_strategies` | Engine-emitted; not consumed by rules |
| Any | `auto_recovery_strategy_selected` / `auto_recovery_no_strategy` | `strategy, classification` | Engine-emitted |
| Any | `auto_recovery_exhausted` / `auto_recovery_rearmed` | `reason` | Engine-emitted |

**When adding a new decision action**: pair the emit site with a classifier rule. If the rule's strategy chain doesn't apply, at minimum add it to `isBenignFlowDecision` so recovery skips it. Pattern that keeps biting: a new action emitted with no matching rule routes to UNKNOWN → plain retry → re-spawn the same failing provider on the same task. Three of the five `recovery-decisions.md` conflicts were variations of this.

---

## Open questions / known risks

These are real ambiguities the audit surfaced. Each is worth addressing the next time their area comes up.

### 1. ✅ ~~Project-pause + gate-approval cliff~~ RESOLVED 2026-05-06

Operator approves a gate but project is also operator-paused → gate clears but `advanceLoop` returns early → loop appears wedged. Fixed: `approveGate()` now refuses on `project.status === 'paused'` with a clear error mirroring `startFactoryLoop`'s pre-flight check.

### 2. `READY_FOR_<stage>` parking has no explicit watchdog

If a stage occupant crashes or is orphaned, an instance parked at `READY_FOR_<stage>` waits forever. `stuck-loop-detector.js` may alert but doesn't auto-resolve. Worth adding a "park older than X min → force advance with diagnostic" rule, or wiring the existing detector to call `cancel_task` on the stale occupant.

### 3. Two distinct meanings for `paused_at_stage = 'EXECUTE'`

- Gate-pause (operator approval pending at EXECUTE).
- Plan-generation deferral wait (project paused mid-execute, plan-task submission held).

Both encode as the same column value. Readers distinguish via the most recent decision log entry, which is fragile. Worth either splitting the encoding (e.g., `EXECUTE` vs `EXECUTE_DEFERRED`) or making the deferral wait a separate column.

### 4. Three auto-ship decision actions

`auto_shipped_at_prioritize`, `auto_shipped_empty_branch`, `auto_shipped_at_verify_fail` (and possibly more) — spread across `loop-controller.js` lines 3449, 4665, 12266. Each is correct in its context but the contract for "what does auto-ship at this stage mean?" is implicit. Worth a small helper that emits all three through one code path with a `reason` field, so future stages add an enum value rather than a new decision action.

### 5. Backward edges undeclared

`TRANSITIONS` (in `loop-states.js`) declares only the linear chain. Code takes backward edges (PLAN/EXECUTE → PRIORITIZE on `stop_execution`, VERIFY → VERIFY on retry). The declared map could either grow to include them (with the predicates) or be renamed to something like `FORWARD_TRANSITIONS` to make the partial nature explicit.

### 6. `factory_projects.loop_state` is a legacy mirror

Per the storage table, project-row `loop_state` is supposed to mirror the oldest active instance's state. Some readers still go through the project row (`getCurrentLoopState(project)`); some go through the instance directly. Worth a sweep to confirm all readers consult the instance, with the project mirror documented as backward-compat-only or removed.

### 7. Auto-recovery interaction at restart

Memory entry `project_subprocess_detach_phase_c_shipped` covers re-adoption of detached subprocesses post-restart. The factory loop's state-machine re-entry on restart is similar: `startup-task-reconciler.js` re-classifies tasks, but the LOOP instance's `paused_at_stage` recovery on restart is less explicit. Worth confirming what happens to a project stuck at `READY_FOR_PLAN` if TORQUE restarts mid-park — does the new instance pick up where the old one was, or restart from SENSE?

---

## When changing the loop

If you're adding a new state, transition, or decision action:

1. **New state** — add to `LOOP_STATES` in `loop-states.js`. Decide whether it goes in `TRANSITIONS` (forward edge) or is a backward/parking edge (don't pollute the linear chain). Add to `APPROVAL_GATES` if it's gateable.
2. **New transition** — add to `TRANSITIONS` if linear; otherwise document in this doc's transition table with the predicate. Make sure the source state's exit predicate covers your case.
3. **New decision action** — emit via `safeLogDecision`. Decide which classifier path consumes it:
   - Recovery action (retry, escalate, fallback) → add a rule in `server/plugins/auto-recovery-core/rules.js`. Use `recovery-decisions.md` conflict #4 stage-catalog as the checklist for paired emission + rule.
   - Benign forward progress → add prefix/match to `isBenignFlowDecision` in `server/factory/auto-recovery/engine.js`.
   - B-side reject reason → add pattern to `recovery-strategies/registry.js` (modify) or `rejected-recovery.js` (reopen) — see `recovery-decisions.md` conflict #5.
4. **New pause variant** — pick an existing variant or add a new one. Document in the "Pause variants" table above. Cross-check with `approveGate` and `advanceLoop` to confirm the new variant's clear path is wired.
5. **State machine drift check** — `tests/factory-loop.test.js` has assertions for `LOOP_STATES` and `TRANSITIONS` shape. Update them.

---

## Related references

- `docs/recovery-decisions.md` — what to do when work fails. The 3 recovery subsystems (auto-recovery engine, replan/rejected sweeps, execution-layer retry/fallback) are downstream of the decisions emitted by the loop. Conflict #4's stage catalog covers the 17 task-finalizer stages and their producer-consumer pairs with recovery rules.
- `docs/factory.md` — operator-facing factory runbook. The "Auto-Recovery Decision Actions" section there covers a subset of the actions cataloged in this doc.
- `server/factory/loop-states.js` — declared states + helper functions. Authoritative for what's "valid".
- `server/factory/loop-controller.js` — the implementation. Per-stage handlers (`executePlanFileStage`, `executeVerifyStage`, `executeLearnStage`, `handlePrioritizeTransition`) own the dense logic.
- `server/factory/factory-tick.js` — the periodic tick that drives `advanceLoop` and the recovery sweeps.
