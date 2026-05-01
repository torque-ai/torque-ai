# Factory Auto-Recovery Engine — Design

**Date:** 2026-04-21
**Status:** Approved (design) — ready for writing-plans
**Trigger:** Two projects stuck mid-session on distinct, recoverable failure classes:
- **SpudgetBooks** — 10h paused at `VERIFY_FAIL` from a transient dotnet SourceLink file lock on the remote workstation. The existing stall-recovery reconciler never saw it (SQL bug: matches `loop_paused_at_stage = 'VERIFY'` only, never `VERIFY_FAIL`).
- **StateTrace** — freshly-onboarded project stranded at `status='paused' + loop_state='IDLE'` after one interrupted Codex plan-generation attempt. `factory-tick.js` bails early on `status='paused'`, so nothing ever re-attempts.

Both failure classes are tactically fixable, but the root problem is that TORQUE's self-heal surface is a set of single-purpose reconcilers with duplicated retry logic and no shared classification of *why* a project got stuck. Every new failure class today becomes a new reconciler and a new pause blind spot tomorrow.

This design replaces the ad-hoc reconciler set with a pluggable Auto-Recovery Engine: declarative error classification + named recovery strategies, both registered via the existing plugin contract.

## Goals

1. **Unstick today's failures.** SpudgetBooks VERIFY_FAIL is auto-retried with a build-artifact clean. StateTrace plan-generation retries with a provider fallback.
2. **Generalize the pattern.** Every future paused-project failure class is a one-rule, one-strategy patch — not a new reconciler.
3. **Stay observable.** Every classification, strategy selection, and recovery attempt writes to the existing decision log. Dashboard surfaces state and escalations.
4. **Don't regress existing self-heal.** `verify-stall-recovery.js` keeps running indefinitely as a belt-and-suspenders safety net.
5. **Make the operator path first-class.** When auto-recovery exhausts, dashboard/MCP exposes a one-click clear.

## Non-goals

- Multi-tenant plugin marketplace or sandboxing. The plugin contract supports third-party extensions, but hardening is not in scope.
- Rewriting `loop-controller.js`. The engine works alongside the existing state machine, not inside it.
- Cross-project recovery coordination. Each project's recovery state is independent.

## Architecture

Three layers, dependency order bottom-up.

### Layer 1 — Plugin contract extension

Extend `server/plugins/plugin-contract.js` with two optional fields, shipped alongside existing `mcpTools`, `eventHandlers`, etc.:

    classifierRules: Array<ClassifierRule>
    recoveryStrategies: Array<RecoveryStrategy>

Both are optional. Plugins that don't register recovery behavior are unaffected.

### Layer 2 — Auto-Recovery engine core

New module tree under `server/factory/auto-recovery/`:

    auto-recovery/
      index.js       — public entrypoint, exposes tick() and reconcileOnStartup()
      registry.js    — merges rules+strategies from all loaded plugins
      classifier.js  — given (project, decision), returns classification
      engine.js      — recon loop: candidates -> classify -> pick -> run -> log
      services.js    — builds the services bundle passed into strategy.run(ctx)

The engine is NOT itself a plugin — it's core infrastructure that *uses* plugin registrations.

### Layer 3 — Built-in plugin `auto-recovery-core`

New plugin at `server/plugins/auto-recovery-core/index.js`. **Always loaded** — added to `DEFAULT_PLUGIN_NAMES` in `server/index.js` as a permanent entry (removable only by editing source, unlike the three existing default plugins).

Ships the classifier rules and strategies that cover today's known failure classes.

#### Built-in classifier rules (day-one set)

| Rule name | Category | Match on |
|-----------|----------|----------|
| `dotnet_sourcelink_file_lock` | `transient` | verify stage, `worktree_verify_failed` action, outcome contains `being used by another process` or `sourcelink.json` |
| `codex_phantom_success` | `sandbox_interrupt` | execute or plan stage, `cannot_generate_plan` / phantom completion patterns (per `feedback_codex_phantom_success` memory) |
| `plan_generation_failed` | `plan_failure` | plan stage, `cannot_generate_plan` action |
| `never_started_paused_project` | `never_started` | `status='paused'` + `loop_last_action_at IS NULL` OR only one failure decision total |
| `verify_fail_unclassified` | `unknown` | VERIFY_FAIL pause where no other rule matched (catch-all) |

#### Built-in strategies

| Strategy | Applicable categories | Behavior |
|----------|-----------------------|----------|
| `retry` | `transient`, `unknown` | Resubmits the failing step via `retryFactoryVerify` or equivalent stage hook |
| `clean_and_retry` | `transient`, `infrastructure` | Calls a new helper `cleanupWorktreeBuildArtifacts(project, batch_id)` living in `server/factory/auto-recovery/services.js` that inspects project tech stack (`.NET`, Node, Python, Rust, Go) and deletes the corresponding stale build output (`obj/`, `bin/`, `node_modules/.cache`, `__pycache__`, `target/`, `pkg/`) inside the batch's worktree before calling `retryFactoryVerify`. |
| `retry_with_fresh_session` | `sandbox_interrupt` | Cancels any lingering stuck task, resubmits with new session_id/working_dir |
| `fallback_provider` | `plan_failure`, `sandbox_interrupt` | Resubmits via `smart_submit_task` forcing a different provider chain (Codex → DeepInfra, etc.) |
| `retry_plan_generation` | `plan_failure`, `never_started` | Re-invokes `architect-runner.runArchitectLLM` path for current work item |
| `fresh_worktree` | `infrastructure` | Abandons current worktree, cuts a new one from the plan, resumes execute stage |
| `reject_and_advance` | `transient` (after N fails), `structural_failure` | Marks work item rejected, advances loop past it |
| `escalate` | terminal | Sets `auto_recovery_exhausted = 1`, logs `auto_recovery_exhausted`, emits event, no further auto-attempts |

### Integration points

- `factory-tick.js` — one new line per tick: `await autoRecoveryEngine.tick({ db, logger, eventBus, services })`. Runs after the existing `status === 'paused'` gate so the engine can revive legitimately-paused projects.
- `startup-reconciler.js` — one new line on startup: `await autoRecoveryEngine.reconcileOnStartup({ db, logger, eventBus, services })`. Catches anything paused through a server restart.
- `server/index.js` — adds `auto-recovery-core` to `DEFAULT_PLUGIN_NAMES`; engine is wired into the DI container.

`verify-stall-recovery.js` keeps running on its current SQL as a safety net. One small addition is made to it: a `skip_if_engine_touched_within_cooldown` check at the top of its loop that reads `auto_recovery_last_action_at` and skips projects the engine is actively handling. This is the only line of legacy code touched.

## Component contracts

### ClassifierRule

```
{
  name: 'dotnet_sourcelink_file_lock',  // unique within plugin
  category: 'transient',                 // enum, see below
  priority: 100,                         // higher wins on multi-match
  confidence: 0.9,                       // 0..1, surfaced in decision log
  match: {
    stage: 'verify',                     // optional: decision.stage filter
    action: 'worktree_verify_failed',    // optional: decision.action filter
    reasoning_regex: '...',              // optional
    outcome_path: 'output_preview',      // optional: JSON path into outcome
    outcome_regex: 'being used by another process|sourcelink\\.json',
  },
  suggested_strategies: ['clean_and_retry', 'retry', 'reject_and_advance'],
}
```

**Category enum (fixed, extensible in future migrations):**
`transient | infrastructure | sandbox_interrupt | plan_failure | never_started | structural_failure | unknown`

`provider_overload` and other categories may be added in follow-up migrations as concrete failures surface. The initial set covers only what has real classifier rules and strategies on day one.

Rules are declarative-first. An optional `match_fn(decision, project) -> bool` escape hatch exists for cases regex can't express; the built-in plugin stays declarative.

### RecoveryStrategy

```
{
  name: 'clean_and_retry',
  applicable_categories: ['transient', 'infrastructure'],
  max_attempts_per_project: 3,

  async run(ctx) {
    // ctx: { project, decision, classification, services, logger }
    // services bundle (injected, not imported):
    //   db, eventBus, retryFactoryVerify, internalTaskSubmit,
    //   smartSubmitTask, worktreeManager,
    //   cleanupWorktreeBuildArtifacts, architectRunner

    await ctx.services.cleanupWorktreeBuildArtifacts(
      ctx.project, ctx.decision.batch_id
    );
    await ctx.services.retryFactoryVerify({ project_id: ctx.project.id });

    return {
      success: true,
      next_action: 'retry',   // retry | advance | escalate | wait
      outcome: { cleaned_paths: [...], retry_submitted: true },
    };
  },
}
```

Strategies receive everything through `services` injection — no singleton imports. Makes them unit-testable with a mock services bundle.

## Data flow per tick

    factory-tick
      └─> autoRecoveryEngine.tick()
            │
            ├─ candidates = pausedProjectsPastCooldown(db)
            │     (SQL matches VERIFY_FAIL, any paused_at_stage, never-started)
            │
            └─ for each candidate:
                 ├─ if exhausted -> skip
                 ├─ if within cooldown window -> skip
                 ├─ lastDecision = factoryDecisions.latest(project_id)
                 ├─ classification = classifier.classify(project, lastDecision)
                 │     -> logs 'auto_recovery_classified' decision
                 ├─ strategy = registry.pick(classification, attempts_so_far)
                 │     -> logs 'auto_recovery_strategy_selected' decision
                 ├─ result = strategy.run(ctx)
                 │     -> logs 'auto_recovery_strategy_succeeded|_failed'
                 └─ engine updates counters + sets cooldown anchor
                     -> on exhaustion: logs 'auto_recovery_exhausted' + emits event

## Persistence

### Schema additions (`factory_projects` table)

| Column | Type | Purpose |
|--------|------|---------|
| `auto_recovery_attempts` | INTEGER default 0 | Total attempts across all strategies for current pause |
| `auto_recovery_last_action_at` | TEXT | Cooldown anchor (engine skips if within backoff window) |
| `auto_recovery_exhausted` | INTEGER default 0 | 0/1 — set when max attempts reached, cleared by operator |
| `auto_recovery_last_strategy` | TEXT | Last strategy attempted (debug) |

Migration runs additive with existing `verify_recovery_attempts` column left untouched. `verify-stall-recovery.js` continues reading its own column; engine writes to the new columns. Both coexist indefinitely.

### Decision log verbs

Recovery decisions reuse the existing `stage` field of the decision being recovered (e.g. `verify`, `plan`, `execute`) to preserve continuity with upstream decisions — no new `stage` value is introduced. The `actor` field is set to `auto-recovery` on every recovery-authored row, so decision-log queries can filter cleanly with `WHERE actor = 'auto-recovery'`.

Action verbs:

- `auto_recovery_classified` — classifier output, includes matched rule + confidence
- `auto_recovery_strategy_selected` — strategy pick + reasoning
- `auto_recovery_strategy_succeeded` — strategy completed, `next_action`, outcome
- `auto_recovery_strategy_failed` — strategy threw, exception stack in outcome
- `auto_recovery_no_strategy` — classification produced a category with no registered strategy (misconfig)
- `auto_recovery_exhausted` — max attempts reached, escalation
- `auto_recovery_operator_cleared` — dashboard/MCP button reset the counter

## Budgeting and backoff

- **Single counter across all strategies per pause.** `auto_recovery_attempts` increments on every strategy run (success or failure). Pause ends → counter resets.
- **Global cap:** 5 attempts. After the 5th, engine logs `auto_recovery_exhausted` and stops.
- **Per-strategy cap:** each strategy declares `max_attempts_per_project` (typically 2-3). Engine respects whichever is tighter.
- **Exponential backoff between attempts:** `30s * 2^attempts`, capped at 30 minutes.
  - attempt 0 → 1: 30s
  - attempt 1 → 2: 60s
  - attempt 2 → 3: 2min
  - attempt 3 → 4: 4min
  - attempt 4 → 5: 8min
  - exhaustion after attempt 5
- Cooldown is enforced via `auto_recovery_last_action_at` — engine refuses to re-enter a project inside the window.

## Error handling (engine-level)

Engine tick must never crash the factory-tick loop.

- **Strategy throws** → caught, logged as `auto_recovery_strategy_failed` with exception stack, counter increments, next tick tries the next strategy in chain.
- **No classifier rule matches** → category `unknown`, confidence 0. Falls through to the `unknown` chain: `retry` (once) → `escalate`.
- **Category has no registered strategy** → `auto_recovery_no_strategy` logged, escalate immediately. Catches misconfiguration in CI.
- **DB write fails mid-recovery** → engine is idempotent per-attempt: counter and strategy selection are re-read at top of each tick, decision-log writes are best-effort. Worst case: a dropped log row and one duplicate attempt.
- **Plugin load failure** (malformed rule, missing strategy function) → `plugin-contract.js` validator rejects at startup, plugin is skipped with a loader warning. `auto-recovery-core` being always-loaded guarantees at minimum the built-in chain still works.

## MCP tools

Small surface, scoped to operator use:

- `list_recovery_strategies` — dumps registered strategies + rules (read-only, useful for diagnosing routing decisions)
- `get_recovery_history { project_id, limit? }` — returns `auto_recovery_*` decisions for a project
- `clear_auto_recovery { project_id }` — resets counter + exhausted flag, logs `auto_recovery_operator_cleared`
- `trigger_auto_recovery { project_id }` — manually kick engine on one project, bypassing cooldown (operator escape hatch)

## Dashboard surfacing

Minimal additions to the existing factory project tile:

- **Red banner** when `auto_recovery_exhausted = 1`: *"Auto-recovery exhausted — operator action required"*. Includes a "Clear & retry" button that calls `clear_auto_recovery`.
- **Amber badge** when `auto_recovery_attempts > 0` and not exhausted: *"Auto-recovering: attempt N/5"* with last strategy name on hover.
- **New detail panel** `Recovery History` on the project page, populated from `GET /api/v2/factory/projects/:id/recovery_history` (filtered decision log).

## Rollout

- **Day 1:** Ship engine + `auto-recovery-core` plugin live. No shadow mode.
- **verify-stall-recovery.js stays in place indefinitely** as a second safety net. Its loop gets one addition: skip projects whose `auto_recovery_last_action_at` is within the engine's cooldown window, to prevent double-retries.
- **Migration:** additive only. `verify_recovery_attempts` column stays. No data loss path.
- **Feature flag:** `factory.auto_recovery.enabled` (default `true`). Kill-switch available via `set_project_defaults` if a classifier rule goes rogue in prod.

## Testing

| Layer | Test approach |
|-------|---------------|
| `classifier.js` | Table-driven unit tests: `[decision fixture] -> [expected category]`. Rules are data → tests are data-driven. Covers every built-in rule + multi-match priority tiebreak. |
| Each strategy | Unit test with mocked `services` — assert DB writes, retry submissions, event emissions. One happy-path + one failure-path per strategy. |
| `engine.js` | Integration test with in-memory DB + seeded paused project fixtures + mock strategies → assert full tick produces expected decision log rows in expected order. |
| Plugin contract | `plugin-contract.js` validator gets schema checks for `classifierRules`/`recoveryStrategies`. Add malformed-plugin regression test. |
| End-to-end | Seed a SpudgetBooks-shaped paused project with a sourcelink-lock decision → run `autoRecoveryEngine.tick()` → assert `dotnet_sourcelink_file_lock` matched, `clean_and_retry` fired, worktree `obj/` cleaned, retry submitted. |
| Deconfliction | Seed a project that matches both engine + legacy reconciler → assert only engine acts, legacy skips due to cooldown gate. |

## Risks

- **Classifier false positives** — a rule misclassifies a real bug as transient, causing infinite cheap retries until exhaustion. Mitigation: global 5-attempt cap, exponential backoff, escalation banner. Rules are data so bad ones can be disabled without redeploy.
- **Strategy side effects bleed between attempts** — e.g. `clean_and_retry` deletes an `obj/` the remote is mid-building. Mitigation: cleanup hooks must be idempotent + safe to no-op. Covered by strategy unit tests.
- **Deconfliction with legacy reconciler drifts** — if someone edits `verify-stall-recovery.js` and removes the cooldown skip, double-retries return. Mitigation: comment + test asserting the skip exists.
- **Plugin API creep** — once `classifierRules`/`recoveryStrategies` exist, pressure to add more extension points. Mitigation: resist until a second legitimate plugin needs it. Built-in plugin is the only consumer for at least one release cycle.

## Open questions (none for initial ship)

All questions resolved during brainstorming. Any new classes that surface post-ship become one-rule, one-strategy patches.
