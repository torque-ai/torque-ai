# Factory Auto-Pilot

The software factory runs autonomously only after its control plane is ready: projects must be running, dark-trust, not operator-paused, configured with `loop.auto_continue=true`, and have the recurring factory tick armed.

## Preparing the Factory

Inspect readiness without processing registered project work:

    factory_automation_plan { blocked_only: true }

Apply the returned control-plane steps directly when the scope is explicit:

    apply_factory_automation_plan { project: "torque-public" }

For all registered projects, the apply call requires `all_projects=true` so the blast radius is explicit. Non-dry-run applies without a single `project` scope also require `confirm_scope=true` or `confirm_all_projects=true`. Use `dry_run=true` to preview the same apply list without mutation. Pass `blocked_only=true` to keep the project list focused on blocked projects while still applying required scheduler-arm steps for ready projects in the scoped plan. Readiness plan and apply steps use `processes_project_work=false`; `resume_project` steps include `immediate_tick=false`, and scheduler steps use `arm_factory_tick` so arming does not run an immediate tick.

Explicit loop starts remain available for operator-driven work, but they are not the persisted unattended automation path:

    start_factory_loop { project: "torque-public", auto_advance: true }

## Configuration

Enable continuous cycling and dark trust (no gates) via `set_factory_trust_level`:

    set_factory_trust_level {
      project: "torque-public",
      trust_level: "dark",
      config: { loop: { auto_continue: true } }
    }

`set_factory_trust_level` deep-merges nested config objects, so setting `config.loop.auto_continue=true` preserves sibling loop keys like `tick_interval_ms`.

If a `set_factory_trust_level` update disables automation readiness, TORQUE stops that project's recurring factory tick. Enabling readiness does not run or arm the tick by itself; use `arm_factory_tick` when the readiness plan calls for scheduler arming.

`factory_project_work_enabled` is the global project-work switch. It defaults to enabled for normal operation and can be set to `0` with the config key or `TORQUE_FACTORY_PROJECT_WORK_ENABLED=0` in the server environment to keep startup reconcile, recurring ticks, config-driven auto-advance, LEARN auto-continue, auto-recovery, direct loop start/advance/gate retry tools, baseline resume probes, and generic queued task starts from processing registered project work. Queue guards classify factory project work from `factory:*` task tags or from a task `working_directory` at or under a registered `factory_projects.path`, including `.worktrees` children. Readiness and apply-plan tools still operate in control-plane mode while this switch is off, and `automation_readiness.project_work_enabled=false` plus `manual_intervention.reason_codes=["factory_project_work_disabled"]` make that state visible to operators. When that switch is the only remaining blocker, readiness rollups and `factory_automation_plan` also return `blocked_only_by_project_work_disabled=true` so clients can distinguish "ready but intentionally disabled" from other manual intervention.

When cutting over automation-readiness changes without allowing registered project processing, preflight first with `scripts/worktree-cutover.sh --preflight --disable-project-work <feature-name>`, then run the approved cutover with `--disable-project-work` or `CUTOVER_DISABLE_PROJECT_WORK=1`. The cutover writes a one-shot successor restart environment override so the new TORQUE process starts with `TORQUE_FACTORY_PROJECT_WORK_ENABLED=0` even if the old server process did not have that environment variable.

- **auto_advance** — explicit loop-start option that chains stage transitions automatically via setTimeout. Fires instantly on stage completion and retries after 30s on transient failures for that manually started loop.
- **auto_continue** — LEARN wraps back to SENSE instead of terminating, picking the next backlog item.
- **factory tick** — 5-min setInterval safety net (`server/factory/factory-tick.js`). Catches anything auto_advance missed. Startup arms running automation-ready projects without an immediate tick and keeps paused baseline/VERIFY recovery projects ticking for recovery checks. Tick advancement and fresh-loop auto-starts require automation readiness unless the tick is clearing a paused VERIFY batch wait.
- **startup resume** — on server restart, scans active loop instances and re-kicks config-driven auto_advance only when unattended automation controls are ready.

## Operator Tools

| Tool | Purpose |
|------|---------|
| `reset_factory_loop` | Clear stuck loop state, terminate instances, free stage occupancy |
| `terminate_factory_loop_instance` | Force-terminate any instance (frees stage claims + worktree cleanup) |
| `retry_factory_verify` | Resume from VERIFY_FAIL after operator fixes the issue; blocked while `factory_project_work_enabled=0` |
| `approve_factory_gate` / `reject_factory_gate` | Gate approval for supervised/guided trust levels; approval is blocked while `factory_project_work_enabled=0` |
| `resume_project` | Resume a paused project. Pass `immediate_tick=false` when applying readiness plans so the call does not run the tick immediately. The recurring tick is only armed when the resumed project is automation-ready |
| `apply_factory_automation_plan` | Apply the bounded readiness control-plane plan for an explicit project, status scope, or `all_projects=true`; accepts `blocked_only=true`; never runs immediate project work |
| `arm_factory_tick` | Arm the recurring tick for an automation-ready project without running an immediate tick |

### Long-running task config: `finalizing_task_stale_minutes`

Factory plan generation and verify steps can legitimately run 30–60 minutes for large repos. The close-handler / finalization pipeline tracks whether a task is mid-finalize via the `finalizingTasks` heartbeat; idle longer than `finalizing_task_stale_minutes` (default 15 min) triggers stale-task abandonment.

**The 15-min default is sized for general-purpose Codex/Claude tasks, not factory-scale work.** If your factory regularly runs plan-generation tasks longer than 15 minutes (large impact-set, slow remote, expensive Codex sessions), raise `finalizing_task_stale_minutes` to comfortably exceed your longest expected finalization. A typical factory-friendly value is `30` (30 min) or `60` (60 min); the upper bound is "longer than any legitimate run, shorter than 'abandoned forever'."

**Symptom of too-low value**: tasks that legitimately finished work get marked failed because their close handler took >15 min to run (e.g. auto-verify-retry on a slow remote test suite). The close handler proceeds normally on its next heartbeat, but the stale-check has already beat it to the DB update.

**Related cleanup TTL**: `TORQUE_CLEANUP_GUARD_TTL_MS` (default 900000ms = 15 min) governs the in-memory cleanupGuard window inside ProcessTracker. Both default to the same 15 min by design — they together protect against double-finalize for long-line close handlers. Raising `finalizing_task_stale_minutes` while leaving cleanupGuard at 15 min reopens the gap that #3 closed; raise both to the same target value when tuning for factory workloads.

## Factory Status Coherence

`factory_status` reports `loop_state` from the active `factory_loop_instances` row, not from the legacy project cache. It also reports:

- `active_stage` — the effective current stage. This can be `PLAN` while `loop_state` is `EXECUTE` when EXECUTE is blocked on an internal plan-generation task.
- `active_task` — the active internal support task, currently `kind: "plan_generation"`, including task id, status, provider, model, and timestamps.
- `state_consistency` — compares the project cache state, active instance state, and effective active stage. `state_consistency.ok=false` means the dashboard should show the mismatch instead of implying smooth progress.
- `work_item_status_counts` — per-project intake counts by status, with summary totals plus `needs_review_work_items` and `needs_replan_work_items` rollups.

Summary fields include `active_internal_tasks`, `state_mismatch_projects`, and work-item status counts so operators can distinguish productive internal work from stale, blocked, or review-owned backlog.

When registered project work is intentionally disabled, `factory_status.summary.idle_diagnosis.reason_code` reports `factory_project_work_disabled` instead of the generic `work_waiting_for_loop`. The diagnosis count payload includes `factory_project_work_enabled=0`, and any recommended action stays read-only/control-plane with `processes_project_work=false`.

## Automation Readiness

`factory_status` includes an `automation_readiness` object for each project and a summary-level rollup. `list_factory_projects` can include the same read-only fields with `include_automation_readiness=true`. `factory_automation_plan` returns the readiness rollup, dry-run control-plane plan, and work-item status counts directly for automation clients that do not need the full air-traffic-control status payload. These fields and tools do not start loops, resume projects, or advance registered project work.

A project is marked ready when all hands-off factory controls are in place:

- project status is `running`
- `config_json.loop.auto_continue` is boolean `true`
- no `loop.operator_paused` marker is present
- trust level has no approval gates (`dark`)

Blocked projects include machine-readable `blocker_codes`, human-readable `blockers`, one `next_control_plane_action`, and an ordered `control_plane_actions` list for projects with multiple blockers. `next_control_plane_action` is the first entry from that ordered list. Example actions include `resume_project with clear_operator_pause=true immediate_tick=false`, `set_factory_trust_level trust_level=dark`, or `set_factory_trust_level trust_level=dark config.loop.auto_continue=true`.

For automation clients, the same sequence is exposed as `control_plane_plan`, an ordered list of `{ action, tool, args, description, effect_scope, mutates_control_plane, processes_project_work, enables_future_processing }` steps. Readiness queries never execute those tools. `apply_factory_automation_plan` is the bounded mutating companion: it recomputes the plan for an explicit scope, refuses steps outside the allowlisted control-plane tools, and executes only steps with `processes_project_work=false`. When `blocked_only=true`, `before.projects` stays focused on blocked projects, while `after.projects` reports every project touched by the apply steps. Readiness plan steps are classified as `effect_scope="control_plane"`, `mutates_control_plane=true`, `processes_project_work=false`, and `enables_future_processing=true`, so clients can distinguish factory setup from backlog execution. A project that needs dark trust and continuous cycling produces one `set_factory_trust_level` step with `args.trust_level="dark"` and `args.config.loop.auto_continue=true`; a separately paused project adds a following `resume_project` step with `args.clear_operator_pause=true` and `args.immediate_tick=false`. The summary-level `automation_readiness.control_plane_plan` concatenates blocked-project setup steps plus scheduler-arm steps for ready projects whose recurring tick is not armed. For running projects that will become ready after config/trust steps, the summary plan appends `arm_factory_tick immediate=false` immediately after those setup steps when the scheduler is currently unarmed.

`arm_factory_tick` is the bounded mutating companion to the read-only plan. It only arms the recurring scheduler with `immediate=false`, so the call itself does not start a loop, resume a project, advance a stage, or process registered project work. It enables future unattended processing and refuses projects that are not automation-ready.

The summary counts ready/blocked projects plus blocker totals so dashboards and operators can tell whether the factory is truly configured for autonomous cycling before allowing it to process backlog.

The rollup also distinguishes `ready` from `hands_off_ready`. `ready` means the project-level control plane can cycle autonomously. `hands_off_ready` additionally requires global project work to be enabled, no operator-owned queues to remain, and the factory tick scheduler to be armed for every ready project. If `ready=true`, `hands_off_ready=false`, and `blocked_only_by_project_work_disabled=true`, the only remaining blocker is the global project-work switch; all control-plane readiness and scheduler arming checks are otherwise satisfied. Operator-owned queues include pending approval tasks, `needs_review` work items, and `escalation_exhausted` work items. For project- or status-scoped plans, pending approval task counts use factory project identifiers and target-project tags so unrelated approvals do not block the requested scope. The `manual_intervention` object reports those counts, unarmed tick project ids, reason codes, capped per-project `work_item_blockers` arrays for `needs_review` / `escalation_exhausted`, and `auto_recovery_coverage` totals without mutating projects. Each blocker may include `oldest_created_at`, `oldest_updated_at`, and `newest_updated_at` timestamps, capped `reject_reason_counts`, `unmatched_auto_recovery_reasons`, a capped `oldest_items` preview with work item id/title/priority/reject reason/timestamps, and `known_auto_recovery` candidate metadata for rows that the factory tick already knows how to clear later, such as stranded zero-diff review rows or no-provider-chain escalation rows. The coverage rollup reports `total_count`, `eligible_count`, `unmatched_count`, `unmatched_reasons`, `deferred_count`, and `fully_covered` per operator-owned status so automation clients can distinguish known future recovery from specific gaps that still need a strategy. These hints identify candidates only; readiness and plan calls do not run recovery, reclassify work items, or process project work.

Readiness `project_ids` arrays are short previews for operators; counts remain authoritative. `control_plane_plan` is the executable-sized plan and includes every required control-plane step for the requested scope, including all scheduler arm steps, rather than only the previewed ids.

The runtime uses the same readiness criteria for config-driven automation. Persisted unattended automation requires boolean `loop.auto_continue=true`; `loop.auto_advance=true` by itself does not re-arm unattended stage chaining or restart stranded projects on startup. LEARN only recycles into a fresh SENSE pass for automation-ready projects while `factory_project_work_enabled` is on, startup only advances active loop instances when readiness is satisfied and project work is enabled, and scheduled config-driven auto-advance timers re-check both conditions before firing. The auto-recovery engine skips strategy execution for projects that are not automation-ready or when project work is globally disabled. The task queue and slot-pull scheduler also defer queued factory project tasks while the switch is off, and `startTask` requeues any direct start attempt before provider routing or process spawn. The tick does not advance active loops or auto-start fresh continuous loops unless the project is running, dark, not operator-paused, has boolean `loop.auto_continue=true`, and global project work is enabled. Explicit project-processing operator commands such as `start_factory_loop`, `advance_factory_loop`, `approve_factory_gate`, `retry_factory_verify`, their instance variants, `scan_project_health`, `poll_github_issues`, `trigger_architect`, `attach_factory_batch`, and `resume_project_baseline_fixed` also refuse while `factory_project_work_enabled=0`; read-only/status, recovery/safety resets, and bounded control-plane readiness tools remain available. `resume_project` remains available as a control-plane resume, but while project work is disabled it does not requeue parked tasks and reports `queue_resume_skipped_reason="factory_project_work_disabled"`.

## Auto-Ship Detection

At PRIORITIZE, the shipped-detector checks if git commit subjects already match the work item's title. Items that were fixed manually in a prior session are auto-marked shipped and skipped — no wasted execution cycles.

At VERIFY_FAIL (after exhausting retries), the same check runs as a recovery path: if the work is already on main, ship it instead of stalling.

## Worktree Lifecycle

- **Creation:** auto-detects default branch (master vs main) per project
- **Stale branch:** force-deletes orphan git branches on collision (`git branch -D` + retry)
- **Stale DB rows:** reclaims active `factory_worktrees` rows from prior failed runs
- **Merge:** cleans both source worktree AND target repo before merge (handles CRLF drift)
- **Internal commits:** use `--no-verify` (the pre-commit PII hook reports-and-blocks findings since 571bb53c; without the bypass, factory commits that legitimately contain PII-adjacent strings would be rejected)
- **Termination:** only abandons worktrees on failure/operator-kill, not on clean LEARN completion

## Plan File Intake Dedup

Plan intake skips re-ingest when the prior work item for the same plan_path is still active (pending, in_progress, verifying). This prevents duplicate work items from factory's own checkbox ticking changing the content hash.

## Close-Handler Observability (2026-04)

Every factory Codex task writes one row to `factory_attempt_history` on completion. The table captures: which plan task, files touched, last 1200 chars of Codex stdout, and (when no files changed) a classifier verdict — `already_in_place` / `blocked` / `precondition_missing` / `unknown`. Query the table to debug why a work item cycled through the loop without producing diffs.

Two feature flags on `factory_projects.config_json.feature_flags` gate behavioral changes:

- `auto_ship_noop_enabled` — classifier reason `already_in_place` with conf >= 0.8 now pauses EXECUTE for operator review instead of skipping VERIFY. Unknown or low-confidence zero-diff results also pause for review instead of being treated as progress.
- `verify_silent_rerun_enabled` — on ambiguous verify classifier verdict, rerun verify once silently before spending a Codex retry slot. Budget: one per batch, tracked on `factory_loop_instances.verify_silent_reruns`.

Decision-log actions to watch:
- `auto_commit_skipped_clean` — now carries `zero_diff_reason`, `classifier_source`, `classifier_conf`.
- `paused_at_gate` with `paused_reason: 'already_in_place_review_required' | 'blocked_by_codex' | 'precondition_missing' | 'unknown_zero_diff_review_required' | 'low_confidence_zero_diff_review_required'` — classifier-triggered pause at EXECUTE.
- `verify_silent_rerun_started` / `verify_passed_on_silent_rerun` / `verify_rerun_same_failure` / `verify_rerun_different_failure` / `verify_silent_rerun_failed` — silent rerun lifecycle.

Retry fix prompts now include a "Prior attempts on this work item:" block (last 3 attempts, file counts, Codex summaries) and a "Verify error progression:" diff between the prior and current verify runs. See `server/factory/verify-helpers/index.js` (`buildVerifyFixPrompt`) for the budget + rendering rules.

Design: `docs/superpowers/specs/2026-04-20-close-handler-retry-observability-design.md`
Plan:   `docs/superpowers/plans/2026-04-20-close-handler-observability.md`

## Intake / Plan Pipeline (2026-04)

PRIORITIZE now ranks intake items by `(promotion_tier, severity_within_tier, priority, source, age)` before claiming one. Scout findings promote ahead of plan_files when:
- The finding is CRITICAL (always promotes), or
- The finding is at or above `severity_floor` (default `HIGH`) AND at least one relevant project score is below its `score_trigger` threshold.

Per-project config lives on `factory_projects.config_json.scout_promotion`; defaults are sensible. Severity only breaks ties **within** the promoted tier, so a HIGH scout with healthy scores does not pre-empt a higher-priority plan_file.

After ranking, each top candidate goes through a cheap stale probe:
1. Is the scout's `target_file` still present?
2. How many commits have landed against it since scan time?
   - 0 commits → finding still valid, keep.
   - `< stale_churn_threshold` (default 5) → minor churn, probably valid, keep.
   - `>=` threshold → substantial churn, mark `shipped_stale` and re-pick.

At most `stale_max_repicks` (default 3) consecutive stales per advance; after that, the selector returns no claim and PRIORITIZE re-enters on the next tick.

Decisions emitted:
- `scout_promoted` — when ranking actually lifted a scout ahead of a plan_file. Outcome: `promoted_ids`, `project_scores`.
- `skipped_stale_scout_item` — when a candidate was skipped as stale. Outcome: `stale_reason`, `commits_since_scan`, `probe_ms`.
- `stale_probe_starvation` — when stale_max_repicks exhausted and the selector gave up.

Plan-gen preemption: `architect-runner.js` now composes a plan-authoring guide from the `RULES` const in `plan-quality-gate.js` + a hand-written examples block (via `server/factory/plan-authoring-guide.js`). The composed guide is injected ahead of the architect prompt so the LLM sees the quality-gate rules up front and produces compliant plans on first pass. On any compose error, the file-based guide loads as a fallback.

Design: `docs/superpowers/specs/2026-04-21-intake-plan-pipeline-design.md`
Plan:   `docs/superpowers/plans/2026-04-21-intake-plan-pipeline.md`

## Verify-Stall Recovery (peer subsystem)

The factory has its own stall-recovery layer for projects whose verify loop has been pinned in `running` state for too long. It is **distinct from** the execution-layer stall recovery documented in [`docs/stall-and-retry.md`](stall-and-retry.md), and the two share no code beyond the conceptual pattern. When debugging "task stalled" issues, identify which layer is responsible before changing thresholds — they have separate config, separate attempt counters, and separate decision sets.

| Layer | Owner | Trigger | Threshold | Counter | Doc |
|-------|-------|---------|-----------|---------|-----|
| **Execution-layer stall** | `server/maintenance/orphan-cleanup.js checkStalledTasks` | Subprocess produced no stdout/stderr for the configured per-provider window | `stall_threshold_<provider>` (default 120s for ollama-class; NULL for codex/claude-cli) | `tasks.stall_recovery_attempts` (persisted; max via `stall_recovery_max_attempts`, default 3) | [`stall-and-retry.md`](stall-and-retry.md) |
| **Factory-loop verify-stall** | `server/factory/verify-stall-recovery.js recoverStalledVerifyLoops` | Factory loop pinned in verify-running for longer than `VERIFY_STALL_THRESHOLD_MS` | Hardcoded `45 * 60 * 1000` (45 min) in `verify-stall-recovery.js:7` | `factory_projects.verify_recovery_attempts` (when column present); `getRecoveryAttempts` reads it | this file + `verify-stall-recovery.js` |

The execution layer fires every 60s on the per-task subprocess output stream. The factory layer fires on the loop-controller tick when the project is in a verify-running state. They can fire concurrently for different work items in the same project — they don't coordinate, and that's intentional: the execution layer protects single-task budgets; the factory layer protects whole-loop progress.

**Don't add a third stall layer.** When the next "X is stalled" complaint comes in, ask which layer should own it before writing new code. If the execution layer's threshold is wrong for a provider, change it via `configure_stall_detection`. If the factory's 45-minute window is wrong, change `VERIFY_STALL_THRESHOLD_MS` in `verify-stall-recovery.js` (and add a config knob if it's worth making operator-tunable).

## Auto-Recovery Decision Actions

> **See also:**
> - [`docs/recovery-decisions.md`](recovery-decisions.md) — canonical reference for the three recovery subsystems (auto-recovery engine, replan/rejected sweeps, execution-layer retry/fallback) and the precedence between them.
> - [`docs/factory-loop-states.md`](factory-loop-states.md) — canonical state-machine reference: declared states, pseudo-states (`READY_FOR_<stage>`, `VERIFY_FAIL`), pause variants, transition catalog, and the decision-action emission map paired with consumer rules.
>
> The table below covers the **observability** view — the named decisions emitted into the `factory_decisions` log. The two reference docs cover the **rule registry** view (what consumes each path) and the **state machine** view (which state emits each path).

The factory emits named decisions for each auto-recovery path so stuck loops are diagnosable from the decision log alone. When debugging a stalled project, query the decisions endpoint first:

| Action | Stage | Triggered by | What it means |
|---|---|---|---|
| `auto_shipped_at_prioritize` | prioritize | Shipped-detector finds matching commits on main before EXECUTE starts | Item was shipped manually; loop skipped it |
| `auto_shipped_at_verify_fail` | verify | Verify fails after N retries AND shipped-detector matches on main | Loop treats it as already shipped instead of stalling |
| `auto_shipped_empty_branch` | learn | Merge fails with "no commits ahead" AND shipped-detector matches | LEARN ships instead of looping on an empty branch |
| `auto_rejected_empty_branch` | learn | Merge fails with "no commits ahead" AND shipped-detector does NOT match | LEARN rejects to prevent infinite re-entry |
| `merge_target_in_conflict_state` | learn | `assertWorktreeIsClean` detected `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` / `rebase-merge` / `rebase-apply` on the target repo (err.code `IN_PROGRESS_GIT_OPERATION`) | Pauses the project (`status=paused`) so the operator aborts or resolves the in-progress op; prevents the one-retry-per-minute loop against unrecoverable UU state |
| `auto_rejected_unparseable_plan` | execute | Plan parses to zero tasks (deterministic failure) | EXECUTE auto-rejects; retrying would fail the same way |
| `auto_rejected_verify_fail` | verify | Worktree remote verify FAILED after all auto-retries | Operator-visible rejection path |
| `auto_rejected_spin_loop` | execute | `>= 5` `starting` decisions for the same batch in 5 min | Safety-net detector caught an EXECUTE re-entry loop |
| `auto_rejected_plan_quality_exhausted` | plan | Plan-quality gate rejected the auto-generated plan `>= 5` times in a row | Caps the Shape-3 re-plan starvation pattern |
| `execute_exception` | execute | `executor.execute(...)` threw (submit failure, await timeout, fs ENOENT, etc.) | Pauses at EXECUTE instead of silent-retrying every 30s |
| `execution_failed_no_tasks` | execute | Live executor produced no completed and no failed tasks (and the no-tasks reason is not deterministic) | Pauses for operator; distinct from the unparseable-plan auto-reject |
| `dep_resolver_detected` | verify | `reviewVerifyFailure` returned `missing_dep` with high/medium confidence | Missing-package classification; resolver about to fire |
| `dep_resolver_task_submitted` | verify | Factory submitted Codex resolver task | Resolver in flight |
| `dep_resolver_task_completed` | verify | Codex resolver task completed + manifest validated | Ready to re-verify |
| `dep_resolver_validation_failed` | verify | Codex claimed done but `validateManifestUpdate` disagreed | Treated as resolver failure; escalation may fire |
| `dep_resolver_escalated` | verify | Resolver failed; escalation LLM called | One-shot fallback in flight |
| `dep_resolver_escalation_retry` | verify | Escalation LLM returned `retry`; new resolver task with revised prompt | Last-chance resolution |
| `dep_resolver_escalation_pause` | verify | Escalation LLM returned `pause`, or escalation itself failed | Project pausing; baseline_broken_reason = dep_resolver_unresolvable |
| `dep_resolver_reverify_passed` | verify | Resolution succeeded; verify command re-ran and passed (or cascade continuing) | Factory advancing to LEARN (or next dep resolution) |
| `dep_resolver_cascade_exhausted` | verify | 3 dep resolutions done, 4th missing_dep detected | Pausing project with baseline_broken_reason = dep_cascade_exhausted |
| `dep_resolver_disabled` | verify | Missing dep detected but `config_json.dep_resolver.enabled === false` | Falling through to existing classifier; no resolver involvement |
| `dep_resolver_pending_approval` | verify | Missing dep detected on supervised/guided trust project | Operator must approve before install |
| `dep_resolver_no_adapter` | verify | Manager field unknown to registry (should not happen in v1) | Falling through to existing retry |
| `baseline_blocked_work_item_requeued` | verify | Baseline probe passed after a baseline/environment failure paused the project | Reopens the rejected work item as `pending` so it can run again after the unrelated failure clears |

When a project's loop is stuck, start with: `GET /api/v2/factory/projects/<id>/decisions?limit=50`. The action name tells you which safety net fired (or didn't).
