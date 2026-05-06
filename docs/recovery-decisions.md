# Recovery Decision Reference

This document is the canonical reference for how TORQUE decides what to do when work fails or stalls. It exists because the recovery layer has accreted across `factory/`, `execution/`, and `routing/templates/` over weeks of incident-driven additions, and the implicit precedence between subsystems is not obvious from any single file.

If you are about to add a recovery rule, change a classification, or wire a new strategy, you should be able to point at the cell in this document where your change belongs *before* you write it.

---

## TL;DR — Three subsystems, three contracts

TORQUE has **three loosely-coupled recovery subsystems**. Each owns a different scope and uses a different decision shape. They do not share a registry.

| # | Subsystem | Scope | Lives in | Contract |
|---|-----------|-------|----------|----------|
| **A** | Auto-recovery engine | Paused **factory project** | `server/factory/auto-recovery/` + `server/plugins/auto-recovery-core/rules.js` | `(latest decision row) → classification → suggested_strategies[] → strategy.run(deps)` |
| **B** | Replan / rejected sweeps | Rejected or unactionable **work item** | `server/factory/replan-recovery.js`, `rejected-recovery.js`, `recovery-strategies/` | `(reject_reason) → strategy lookup → strategy.run() → outcome (rewrote/escalated/split/unrecoverable)` |
| **C** | Execution-layer retry/fallback | Failed **task** (single execution) | `server/execution/fallback-retry.js`, `retry-framework.js`, `task-finalizer.js` | `(exitCode, errorOutput) → classifyError → {retryable, reason} → retry/fallback/escalate` |

Subsystems run **bottom-up** in time but **top-down** in scope: a task fails (C), its work item gets rejected (B), eventually the project pauses (A). Each subsystem can short-circuit the next — a successful retry in C never escalates to B; a successful rewrite in B never reaches A.

---

## Subsystem A — Auto-recovery engine (paused projects)

**Trigger.** A factory project enters `status=paused` (gate paused, learn-blocked, exhausted, etc.) and the engine's tick fires.

**Contract.** `engine.recoverOne(project)`:
1. Read the latest non-auto-recovery decision row for the project.
2. If the decision is **terminal** (e.g., `auto_shipped_*`, `auto_rejected_*`) → log `auto_recovery_skipped_terminal`, return.
3. If the decision is **benign-flow** (`advance_from_*`, `started_*`, `selected_work_item`, etc.) → log `auto_recovery_skipped_benign`, bump `last_action_at`, return. ([`isBenignFlowDecision`](../server/factory/auto-recovery/engine.js), added 2026-05-03 in `ac964a15`.)
4. Otherwise classify the decision against the priority-sorted rule registry (first match wins).
5. Pick the highest-priority strategy from `suggested_strategies` whose per-project budget is not exhausted.
6. Run the strategy. Log outcome. If `MAX_ATTEMPTS=5` reached → mark `auto_recovery_exhausted=1`.

**Decision shape.** Match against fields of a `factory_decisions` row: `stage`, `action`, `reasoning` (regex), `outcome` (path + regex), or a `match_fn` predicate.

**Registered rules** — see `server/plugins/auto-recovery-core/rules.js` for the full list with in-line evidence references. **18 explicit rules + 1 implicit `UNKNOWN_CLASSIFICATION` fallback.** Categories: `transient`, `await_self_heal`, `sandbox_interrupt`, `plan_failure`, `structural_failure`, `provider_overload`, `never_started`, `unknown`. Priority order: 200 → 10.

**Strategies** — registered separately in `engine.js`:

| Strategy | Action |
|---|---|
| `retry` | `approveGate()` if paused at gate, else `advanceLoop()` |
| `clean_and_retry` | Clean tech-stack-specific build artifacts, re-enter EXECUTE |
| `retry_with_fresh_session` | Cancel current task, fresh session |
| `fallback_provider` | Bump to next provider in `provider_chain_json` |
| `retry_plan_generation` | Retry PLAN stage |
| `fresh_worktree` | Discard worktree, recreate |
| `reject_and_advance` | Reject the work item and advance |
| `escalate` | Pause project, await operator |

**Empty-strategies pattern.** Some rules (e.g. `learn_merge_target_dirty`, `execute_paused_active_worktree_owner`) intentionally return `suggested_strategies: []`. The engine then marks `auto_recovery_exhausted=1` without touching the project, deferring to factory-tick rearm logic. **This is the "do nothing; let the operator or the next tick fix it" channel.** See open question #1 below.

---

## Subsystem B — Replan / rejected sweeps (work-item recovery)

**Trigger.** A periodic sweep scans for work items in terminal-but-recoverable states.

Two parallel sweeps:

### B1 — `replan-recovery.js` (rewrites, splits, escalates rejected items)
- **Eligibility:** `recovery_attempts < hardCap` AND cooldown elapsed AND open-items backpressure under threshold.
- **Strategy lookup:** Pattern-match `reject_reason` against the `recovery-strategies/registry.js` table.
- **Strategies:** `decompose` (split into 2–5 children), `discard-regenerable-merge-block` (clean + retry merge), `escalate-architect` (next provider in chain), `rewrite-description` (reframe the task).
- **Outcomes:** `rewrote` / `escalated` / `split` / `unrecoverable`.

### B2 — `rejected-recovery.js` (auto-reopens auto-rejected items)
- Auto-reject reason patterns (`auto_*`, `verify_failed_after_\d+_retries`, `task_*.+_failed`, `consecutive_empty_executions`, `stuck_executing_over_1h_no_progress`) → eligible for reopen.
- Non-recoverable patterns (`cannot_generate_plan:*`, `pre_written_plan_rejected_by_quality_gate`, `replan_generation_failed`) → never retried automatically.
- **Action:** Reset status to `pending`, clear `reject_reason`, bump `reopens` counter.

**Two sweeps coexist** because they have different change shapes: B1 *modifies* the work item (new title, split children, new constraints); B2 just *reopens* it. They do not coordinate.

---

## Subsystem C — Execution-layer retry/fallback (single-task scope)

**Trigger.** A task subprocess exits, the close handler fires, `finalizeTask()` runs.

**Contract.** Two phases gate the retry decision:

### C1 — `retry-framework.js` `handleRetryLogic(ctx)` (Phase 1, runs **before** finalizer stages)
1. `classifyError(errorOutput, exitCode)` → `{retryable, reason}`.
2. If `retryable` AND `incrementRetry(taskId).shouldRetry` → write `retry_scheduled`, schedule retry timer, set `ctx.earlyExit=true`.
3. After delay → transition to `queued`, call `startTask()` again.

### C2 — `fallback-retry.js` (provider/model fallback chains)
Called from C1's retry path *or* directly by the queue scheduler when capacity changes:
- `tryStallRecovery()` — escalate edit format → larger model → local-first fallback → cloud.
- `tryHashlineTieredFallback()` — escalate within hashline-capable models only.
- `tryOllamaCloudFallback()`, `tryLocalFirstFallback()` — provider-level swaps.

### C3 — `task-finalizer.js` `runStage` gates (Phase 2+, runs **after** retry decision when not early-exited)
13+ stages — each is a `(ctx, deps) → ctx` function gated on a condition. Notable: `phantom_success_detection`, `codex_banner_only_detection`, `smart_diagnosis`, `strategic_review`, `verification_ledger`, `adversarial_review`. These produce signals that feed into B (work-item rejection reasons) and A (project-pause reasons), but they do not themselves retry.

### `classifyError` branches (the exit-code → retry contract)

Predicates are checked in order; first match wins. Sample (not exhaustive — see `server/execution/fallback-retry.js` for the full list):

| Predicate | Retryable? | Reason |
|---|---|---|
| `exitCode === 0` | n/a | success path, classifier not called |
| structured signal annotation `[process-exit] signal=…` | yes | `Process killed by signal X` |
| `exitCode === -101` | yes | `Subprocess spawned but exited before tracking…` |
| `exitCode === -102` | yes | `Close-handler internal exception…` |
| `exitCode === -103` | yes | `Subprocess spawn error (ENOENT/EACCES/…)` |
| `exitCode === -1 && errorText.length < 50` | yes | `Premature exit with no output…` |
| `errorText` matches `sourcelink\|EBUSY` | yes | transient FS lock |
| `errorText` matches `Reconnecting\|sandbox` | yes | sandbox/quota |
| (long unknown error, retry disabled) | no | `Long unknown error treated as non-retryable` |
| (anything else) | yes | `Unknown error - attempting retry` |

---

## Subsystem D — Routing templates (provider chains, *not* recovery)

`server/routing/templates/*.json` are **not** part of the recovery layer — they map task category → provider chain *before* execution. But they interact with recovery: a chain whose first provider is wrong silently routes work to the wrong specialist, which then fails into A/B/C.

Documented here for completeness. Templates: `system-default`, `quality-first`, `codex-primary`, `cost-saver`, `cloud-sprint`, `free-agentic`, `free-speed`, `all-local`, `ollama-cloud-primary`, `codex-down-failover`, `legacy-fallback`.

**Hot zone:** the `plan_generation` category. Several templates lead with cerebras/groq for plan_generation — appropriate for fast text-gen, but `bitsy` WI 470 (memory entry: `project_codex_primary_plan_routing.md`) showed claude-cli silently writing the plan to a file instead of returning inline markdown, which fed directly into `plan_generation_unusable_output` rule firings in A. Routing-template choice is upstream of recovery rule load.

---

## Boundaries and precedence

When recovery fires, it fires at the lowest scope that owns the failure:

```
task fails
  → C1 (retry?) ──yes──→ retry_scheduled, requeue, restart task
       │
       └──no──→ task ends in failed/rejected
                  → B1/B2 (work-item recoverable?) ──yes──→ rewrite/split/escalate, reset to pending
                       │
                       └──no──→ work item exhausted; project may pause
                                  → A (project paused, classifiable?) ──yes──→ run strategy
                                       │
                                       └──no/exhausted──→ auto_recovery_exhausted=1, await operator
```

**The bidirectional path.** Some signals flow upward only (a task failure becomes a work-item reject_reason becomes a project pause reason). Others can short-circuit downward — A's `escalate` strategy can `pause project + reject work item`, which then makes C irrelevant for the next attempt.

---

## Open questions / known conflicts

These are real ambiguities surfaced by this audit. Each one is worth resolving before adding more rules to that area.

### 1. ~~`learn_merge_target_dirty` empty strategies — intentional or stale?~~ ✅ RESOLVED 2026-05-05

**Resolution**: factory-self-heal won. The original "operator-self-heal" claim was disproven by live evidence (DLPhone WI #762, 2026-05-04): `auto_recovery_exhausted=1` parked the project at READY_FOR_LEARN and rearm did **not** fire even after the operator cleaned main — manual `approveGate({stage:"LEARN"})` was always required. Separately, the discard strategy in B1 was architecturally unreachable because `merge_target_dirty` is emitted only as a project-level pause action (`safeLogDecision({ stage: LEARN, action: 'merge_target_dirty', ... })` in loop-controller.js), never as a work-item `reject_reason`.

**Fix landed**: A-side strategy `discard-regenerable-merge-block` added in `server/plugins/auto-recovery-core/strategies/`, sharing core logic with the B1 strategy via the new `server/factory/recovery-strategies/discard-regenerable-merge-block-core.js`. The rule now suggests `['discard-regenerable-merge-block', 'escalate']`. The strategy is conservative — refuses when any dirty file is non-regenerable (falls through to `escalate` so the operator still gets notified for genuine work-in-progress on main). B1 strategy stays registered as defense-in-depth in case a future codepath sets `merge_target_dirty` as a `reject_reason`.

### 2. ~~Provider escalation in two places~~ ✅ RESOLVED 2026-05-05 (reframed: B1-vs-X5, not C2-vs-B1)

**Resolution**: the audit's original framing was off. C2 and B1 are not actually duplicating provider escalation — they operate at different scopes with separate state:

- **C2** (`fallback-retry.js tryOllamaCloudFallback / tryLocalFirstFallback`) — **task-scoped**: swaps `task.provider`, increments `task.metadata.local_first_attempts` and `task.retry_count`. Requeues the SAME task with a different provider. Uses the task-execution fallback chain (`getProviderFallbackChain` + `CLOUD_PROVIDERS` + `serverConfig.ollama_fallback_provider`).
- **B1** (`recovery-strategies/escalate-architect.js`) — **work-item-scoped**: writes `constraints.architect_provider_override` so the next task spawned for this work item gets a different architect. Uses the project's `provider_chain_json` (the architect-escalation chain — a separate concept from C2's fallback chain).

These don't conflict — they're two separate provider chains for two different concerns.

**The actual conflict surfaced during this investigation** was between two same-shape escalation paths that DO share state:

- **B1** (`recovery-strategies/escalate-architect.js`) — was reading `constraints.last_used_provider`, but `last_used_provider` is **never written by any production code path** (only the test fixture set it). On second escalation, `lastUsed=null` → `lastIdx=0` → bump to `chain[1]` again — looped on the same provider. The recovery would never advance past `chain[1]`.
- **X5** (`loop-controller.js routeWorkItemToNeedsReplan` ~line 7331) — reads `constraints.architect_provider_override`, the field both X5 and B1 actually write. Works correctly.

**Fix landed**: aligned B1 to read `architect_provider_override` (same field X5 reads). Single state model now drives both same-shape escalation paths. Added regression tests covering second/third escalation cycles plus a "ignores legacy `last_used_provider`" no-op test. The legacy field can be deleted from any older fixtures or seeds without behavioral effect.

### 3. ~~Resume-context double-prepend~~ ✅ RESOLVED 2026-05-05 (verified, no bug)

**Resolution**: not actually a bug. `prependResumeContextToPrompt` in `server/utils/resume-context.js` defaults to `options.replaceExisting=true`, which calls `stripExistingResumeContextPreamble` to strip any existing `## Previous Attempt` block (recognizing both `(failed)` and `(interrupted by server restart)` heading variants) before re-prepending. Both consumers (`fallback-retry.js withResumeContextPrompt` and `retry-framework.js buildRetryResumeFields`) use the default options, so the second call replaces the first preamble — never stacks.

**What landed**: in-line comments at both consumer call sites pointing to the strip-first contract; both helpers exported for testability; three new integration tests in `server/tests/resume-context.test.js` that exercise sequential cross-call-site prepend cycles (fallback → retry, fallback → retry → fallback) and assert exactly one preamble at the end. 19/19 tests pass. Strip-first contract is now codified — a future regression that flips either consumer to `replaceExisting: false` would fail the integration test.

### 4. `task-finalizer.js` stage proliferation

13+ stages in one file, each a `runStage` gate with its own enable predicate. No documented order rationale for the chain. Several stages produce signals that feed into A's classifier (e.g., `phantom_success_detection` → `codex_phantom_success` rule), but the producer-consumer link is implicit. **Action item:** document the producer-consumer pairs (which stage emits which decision shape) — this is the layer where an unintended new stage can silently change A's rule firings.

### 5. Two reject-reason regex registries

- B1's `recovery-strategies/registry.js` does pattern lookup on `reject_reason`.
- B2's `rejected-recovery.js` does pattern lookup on `reject_reason`.

Different patterns, different actions. A new reject_reason added by some other layer (e.g., a new task-finalizer stage) needs to be tested against both. **Action item:** consolidate or document the split (B1 = "modify the item", B2 = "reopen the item").

---

## Adding a new recovery rule — where does it go?

Use this ladder. Pick the **lowest scope** that captures your failure mode.

| Failure shape | Goes in |
|---|---|
| A specific exit code or stderr pattern from a single task subprocess | C — extend `classifyError` in `fallback-retry.js`. Add a test case in `tests/fallback-retry.test.js`. |
| A retryable error that needs a different *provider* on next attempt | C2 (`tryStallRecovery` / `tryOllamaCloudFallback` / `tryLocalFirstFallback`). |
| A `reject_reason` that should auto-reopen the same work item | B2 (`rejected-recovery.js`). Just add the pattern. No strategy needed. |
| A `reject_reason` that needs the work item *modified* (split, rewritten, escalated) before retry | B1 (`recovery-strategies/`). Either extend an existing strategy or add a new one + register. |
| A `factory_decisions` shape that puts a project in `paused` and the operator shouldn't have to intervene | A — add a rule to `server/plugins/auto-recovery-core/rules.js` with priority + `suggested_strategies`. Reference live evidence (project + decision row) in the in-line comment. |
| A pause shape that should *not* trigger recovery (forward progress, intentional pause) | A — extend `isBenignFlowDecision` in `engine.js`. |
| The provider chain itself is wrong for a task category | D — edit the appropriate template in `server/routing/templates/*.json`. **This is upstream of every other recovery layer; fixing it here removes the load from A/B/C.** |

**Always cite live evidence** in the rule's in-line comment: project name, decision row's stage+action+reasoning excerpt, link to the memory entry or ticket. The rules.js file is the most legible recovery surface in TORQUE specifically because every rule has a "Live evidence" paragraph.

---

## Related references

- `docs/factory.md` § Auto-Recovery Decision Actions — the **observability** view (action names emitted into `factory_decisions`); complements the **rule registry** view here.
- `docs/safeguards.md` — task-level safeguards (baselines, validation, approval gates) that fire before C.
- `docs/factory.md` § Close-Handler Observability (2026-04) — Cluster A wiring; the upstream of C3.
- Memory entries (in `~/.claude/projects/.../memory/`) — chronology of why each rule was added: `project_recovery_rules_unknown_classification_shipped`, `project_recovery_skip_benign_decisions_shipped`, `project_executor_failed_needs_replan_shipped`, `project_factory_recovery_rule_overrides_strategy`, `project_sweep_stranded_needs_review_shipped`.
