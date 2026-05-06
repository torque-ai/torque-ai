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

These are real ambiguities surfaced by this audit. Each one is worth resolving before adding more rules to that area. **All five conflicts are now resolved (2026-05-05 → 2026-05-06).** Three of them turned out to mask real bugs (#1 merge-target-dirty unreachable strategy; #2 B1 reading a never-written field; #4 phantom-detector emitting an action no rule matched). The other two were doc/test gaps. Section preserved as a record of the audit→fix arc.

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

### 4. ~~`task-finalizer.js` stage proliferation~~ ✅ RESOLVED 2026-05-06 (catalog written + 1 real bug fixed)

**Real bug uncovered during investigation**: `phantom_success_detection` (server/validation/phantom-success-detector.js) emits `action: 'phantom_completion_detected'`, but the matching A-side rule `codex_phantom_success` (server/plugins/auto-recovery-core/rules.js) was looking for `action: 'cannot_generate_plan'` — a different action emitted by loop-controller.js's plan-generation gate. The rule never fired on phantom-detector decisions. Phantom completions fell through to `UNKNOWN_CLASSIFICATION` → `['retry', 'escalate']`; plain `retry` re-spawned the same task on the same provider that had just phantom-succeeded.

**Fix**: added a new rule `phantom_completion_detected` (priority 150, category `sandbox_interrupt`) that matches `stage: 'execute', action: 'phantom_completion_detected'` and routes through `[retry_with_fresh_session, fallback_provider, escalate]` — same cure as `codex_phantom_success`, but for the post-execution phantom shape rather than the plan-generation shape.

#### Stage catalog

The 17 stages of `finalizeTask` (`server/execution/task-finalizer.js` ~line 998–1090), in execution order:

| # | Stage | Enable predicate | Handler location | Can flip ctx.status? |
|---|---|---|---|---|
| 1 | `retry_logic` | `ctx.code !== 0` | `retry-framework.js handleRetryLogic` | sets `earlyExit` (skips 2–17) on retry |
| 2 | `safeguard_checks` | `typeof deps.handleSafeguardChecks === 'function'` | `validation/safeguard-gates.js` | sets `earlyExit` |
| 3 | `diffusion_signal_detection` | `ctx.code === 0` | inline (handleDiffusionSignalDetection) | no |
| 4 | `compute_apply_creation` | `ctx.code === 0` | inline (handleComputeApplyCreation) | yes — schema error → failed |
| 5 | `fuzzy_repair` | `typeof deps.handleFuzzyRepair === 'function'` | legacy no-op | no |
| 6 | `no_file_change_detection` | `typeof deps.handleNoFileChangeDetection === 'function'` | legacy no-op | no |
| 7 | `phantom_success_detection` | `ctx.status === 'completed'` | `validation/phantom-success-detector.js` | yes — completed → failed (emits decision) |
| 8 | `codex_banner_only_detection` | `ctx.status === 'failed' \|\| 'cancelled'` | `validation/phantom-success-detector.js` | no (rewrites errorOutput only) |
| 9 | `sandbox_revert_detection` | `typeof deps.handleSandboxRevertDetection === 'function'` | `execution/sandbox-revert-detection.js` | yes |
| 10 | `auto_validation` | `typeof deps.handleAutoValidation === 'function'` | `validation/close-phases.js` | yes |
| 11 | `build_test_style_commit` | `typeof deps.handleBuildTestStyleCommit === 'function'` | `validation/close-phases.js` | yes |
| 12 | `auto_verify_retry` | `typeof deps.handleAutoVerifyRetry === 'function'` | `validation/auto-verify-retry.js` | sets `earlyExit` on auto-resubmit |
| 13 | `verification_ledger` | `typeof handleVerificationLedger === 'function'` | `execution/verification-ledger-stage.js` | yes |
| 14 | `adversarial_review` | `... && ctx.status === 'completed'` | `execution/adversarial-review-stage.js` | yes |
| 15 | `smart_diagnosis` | `ctx.status === 'failed'` | `execution/smart-diagnosis-stage.js` | no (writes `metadata.suggested_provider`) |
| 16 | `strategic_review` | `ctx.status === 'completed'` | `execution/strategic-review-stage.js` | yes |
| 17 | `provider_failover` | `... && !ctx.pipelineError` | `validation/close-phases.js` | sets `earlyExit` on provider swap |

**Stages that emit `factory_decisions` rows** (the decisions A-side classifier rules can match): only `phantom_success_detection` (action `phantom_completion_detected`). All other stages either set `ctx` fields, write task metadata, or update task status without logging a project-level decision row.

**Stages whose status flip changes downstream gating**: 4, 7, 9, 10, 11, 13, 14, 16. Stage 14 (adversarial_review, line ~1071) requires `ctx.status === 'completed'`; stage 15 (smart_diagnosis, line ~1075) requires `ctx.status === 'failed'`; stage 16 (strategic_review, line ~1079) requires `ctx.status === 'completed'`. So a stage 4–13 flip from completed → failed makes 14/16 skip and 15 fire instead.

**Soft-dependency silent-skip stages** (run only if their handler is wired into DI; otherwise no-op): 2, 5, 6, 9, 10, 11, 12, 13, 17. If `createTaskFinalizer` is constructed without one of these handlers, that stage becomes a silent skip — no error, no log. Worth keeping in mind when tracing why a validation stage didn't fire.

#### Producer-consumer table

| Producer (stage) | Signal emitted | Where | Consumer | Consumer subsystem |
|---|---|---|---|---|
| `phantom_success_detection` | `action: 'phantom_completion_detected'` | factory_decisions | `phantom_completion_detected` rule (added 2026-05-06) | A — auto-recovery engine |
| `smart_diagnosis` | `metadata.suggested_provider` | task row | `provider_failover` stage (stage 17 in same pipeline) | C — execution-layer fallback |
| `smart_diagnosis` | `metadata.needs_escalation` | task row | B-side recovery (replan/rejected sweeps) on terminal failure | B — work-item recovery |
| `auto_validation` / `build_test_style_commit` | `ctx.validationStages` entries | ctx (in-memory) | `strategic_review` stage (stage 16 in same pipeline) | C — execution-layer validation |
| `verification_ledger` | DB ledger rows | DB | future task routing heuristics | (informational only) |

**Stages with no downstream auto-recovery consumer** (observability / orchestration only): `codex_banner_only_detection`, `diffusion_signal_detection`, `compute_apply_creation`, `fuzzy_repair`, `no_file_change_detection`, `sandbox_revert_detection`, `verification_ledger`, `adversarial_review`, `strategic_review`. These can fail tasks (set `ctx.status='failed'`), which feeds into stages 15/17 in the same pipeline and may trigger B-side recovery on terminal rejection — but they don't emit decisions A-side rules match against.

#### When adding a new stage

If your stage emits a `factory_decisions` row, the rule registry in `server/plugins/auto-recovery-core/rules.js` MUST have a matching rule — otherwise the decision routes to UNKNOWN classification with default `['retry', 'escalate']`, which often loops on the same provider. Two checks before merging:

1. Does your stage call `logFactoryDecision({ stage, action, ... })`? If yes, identify or add a matching rule.
2. Does your stage flip `ctx.status` mid-pipeline? If yes, walk stages 14–17 to confirm the new ordering is intentional (stages with `ctx.status === 'completed'` predicates will skip; `=== 'failed'` will fire).

### 5. ~~Two reject-reason regex registries~~ ✅ RESOLVED 2026-05-06

**Resolution**: documented the partition + made the cross-registry disjointness check use a single source of truth.

**The pattern partition (now codified):**

| Set | Lives in | Action on match |
|---|---|---|
| **B1** strategy `reasonPatterns` (4 strategies — rewrite-description, decompose, escalate-architect, discard-regenerable-merge-block) | `factory/recovery-strategies/*.js` | **Modify the work item** — rewrite, split, escalate provider, discard files. |
| **B2 AUTO** (`AUTO_REJECT_REASON_PATTERNS` + `AUTO_UNACTIONABLE_REASON_PATTERNS`) | `factory/rejected-recovery.js` | **Reopen the work item** — reset status to pending. |
| **NON_RECOVERABLE** (`NON_RECOVERABLE_REJECT_REASON_PATTERNS`) | `factory/rejected-recovery.js` | **B2-veto list** — `matchesRecoverableReason` checks NON_RECOVERABLE first and returns false (B2 will not auto-reopen). It does NOT prevent B1 from acting. |

**Disjointness contract** (enforced at startup by `bootstrapReplanRecovery → assertDisjointReasonPatterns`, in `factory/replan-recovery-bootstrap.js`):

- `B1 ∩ B2 = ∅` — hard requirement. Overlap would double-dispatch (a single tick both rewrites AND reopens the same work item).
- `B2 AUTO ∩ NON_RECOVERABLE = ∅` — code hygiene. NON_RECOVERABLE is checked first, so an AUTO entry that overlaps it is dead. Throw to flag the redundant listing.
- `B1 ∩ NON_RECOVERABLE` is **allowed and expected** — `rewrite-description` (B1) intentionally matches `cannot_generate_plan:` (which is in NON_RECOVERABLE) because rewriting the description is the right cure. The two paths cooperate: B1 fixes the cause; if B1 declines or is unavailable, B2's veto keeps the item rejected so the operator owns it.

**What landed**:

- `rejected-recovery.js` now exports the three pattern arrays (`AUTO_REJECT_REASON_PATTERNS`, `AUTO_UNACTIONABLE_REASON_PATTERNS`, `NON_RECOVERABLE_REJECT_REASON_PATTERNS`).
- `replan-recovery-bootstrap.js` imports those arrays as the live source of truth instead of maintaining a hand-rolled copy of `REJECTED_RECOVERY_PATTERNS`. A new B2 pattern automatically participates in the disjointness check on next bootstrap; nothing to wire by hand.
- `assertDisjointReasonPatterns` extended with the B2 AUTO ∩ NON_RECOVERABLE redundant-listing check.
- New `tests/replan-recovery-bootstrap.test.js` exercises: live patterns are disjoint (regression guard), B1 ∩ B2 overlap throws, B1 ∩ NON_RECOVERABLE overlap is allowed, B2 AUTO ∩ NON_RECOVERABLE overlap throws, every B2 AUTO pattern would block a colliding B1 strategy (coverage proof).

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
