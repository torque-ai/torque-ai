# Factory Auto-Pilot

The software factory runs autonomously when configured. One API call starts a self-driving cycle.

## Starting the Factory

    # Start with auto-advance (zero operator calls needed)
    start_factory_loop { project: "torque-public", auto_advance: true }

    # Or via REST
    curl -X POST http://127.0.0.1:3457/api/v2/factory/projects/<id>/loop/start \
      -H "Content-Type: application/json" -d '{"auto_advance":true}'

## Configuration

Enable continuous cycling and dark trust (no gates) via `set_factory_trust_level`:

    set_factory_trust_level {
      project: "torque-public",
      trust_level: "dark",
      config: { loop: { auto_continue: true } }
    }

- **auto_advance** — server chains stage transitions automatically via setTimeout. Fires instantly on stage completion. Retries after 30s on transient failures.
- **auto_continue** — LEARN wraps back to SENSE instead of terminating, picking the next backlog item.
- **factory tick** — 5-min setInterval safety net (`server/factory/factory-tick.js`). Catches anything auto_advance missed. Starts/stops with `pause_project`/`resume_project`. Auto-starts new loops for auto_continue projects with no active instances.
- **startup resume** — on server restart, scans for active auto_continue instances and re-kicks auto_advance.

## Operator Tools

| Tool | Purpose |
|------|---------|
| `reset_factory_loop` | Clear stuck loop state, terminate instances, free stage occupancy |
| `terminate_factory_loop_instance` | Force-terminate any instance (frees stage claims + worktree cleanup) |
| `retry_factory_verify` | Resume from VERIFY_FAIL after operator fixes the issue |
| `approve_factory_gate` / `reject_factory_gate` | Gate approval for supervised/guided trust levels |

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

## Auto-Recovery Decision Actions

The factory emits named decisions for each auto-recovery path so stuck loops are diagnosable from the decision log alone. When debugging a stalled project, query the decisions endpoint first:

| Action | Stage | Triggered by | What it means |
|---|---|---|---|
| `auto_shipped_at_prioritize` | prioritize | Shipped-detector finds matching commits on main before EXECUTE starts | Item was shipped manually; loop skipped it |
| `auto_shipped_at_verify_fail` | verify | Verify fails after N retries AND shipped-detector matches on main | Loop treats it as already shipped instead of stalling |
| `auto_shipped_empty_branch` | learn | Merge fails with "no commits ahead" AND shipped-detector matches | LEARN ships instead of looping on an empty branch |
| `auto_rejected_empty_branch` | learn | Merge fails with "no commits ahead" AND shipped-detector does NOT match | LEARN rejects to prevent infinite re-entry |
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

When a project's loop is stuck, start with: `GET /api/v2/factory/projects/<id>/decisions?limit=50`. The action name tells you which safety net fired (or didn't).
