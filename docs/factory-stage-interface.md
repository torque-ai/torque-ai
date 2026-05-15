# Factory Stage Interface — Spec

**Status:** Draft. Reflection checkpoint for the loop-controller refactor arc (see [`docs/findings/2026-05-14-loop-controller-baseline.md`](findings/2026-05-14-loop-controller-baseline.md)). Captures what a clean `Stage` interface should look like before Phase 2c (lifecycle mutating) and Phase 3 (stage executors) start moving code.

## Why this doc exists

After 22 mechanical-extraction phases the loop controller is **15,200 lines** of which **4,300+** are the seven stage executors:

| Stage | Lines | Signature (current) | Returns (current) |
|---|--:|---|---|
| `executeSenseStage` | ~60 | `(project_id, instance = null) -> sync` | `{ scan_summary, ... }` |
| `executePrioritizeStage` | ~170 | `(project, instance, selectedWorkItem) -> async` | `{ work_item, stage_result, reason }` |
| `executePlanStage` | ~250 | `(project, instance, selectedWorkItem) -> async` | `{ work_item, stage_result, reason }` |
| `executeNonPlanFileStage` | ~1,100 | `(project, instance, workItem) -> async` | `{ work_item, stage_result, reason, batch_id, ... }` |
| `executePlanFileStage` | ~1,400 | `(project, instance, workItem) -> async` | same shape as NonPlanFile |
| `executeVerifyStage` | ~1,300 | `(project_id, batch_id, instance) -> async` | `{ next_state, stage_result, ... }` |
| `executeLearnStage` | ~60 | `(project_id, batch_id, instance) -> async` | `{ shipping_result, next_state, ... }` |

The signatures are **already broken in three ways** that the next mechanical extraction would freeze in place if we don't pause to design first:

1. **Heterogeneous argument types.** Sense, Verify, Learn take `project_id` (number). Prioritize, Plan, ExecuteNonPlanFile, ExecutePlanFile take `project` (resolved object). The same dispatcher (`runAdvanceLoop`) resolves the project twice on the same loop tick because half the stages re-resolve it and half don't.
2. **Heterogeneous work-item handling.** Three stages receive `workItem` as a parameter. Three look it up via the instance's selected-work-item cache. One (Sense) doesn't have a work item at all. This makes the dispatcher's "did the stage produce a different work item?" check require per-stage knowledge.
3. **Heterogeneous return shapes.** Prioritize / Plan / ExecuteNonPlanFile / ExecutePlanFile share `{ work_item, stage_result, reason }`. Verify and Learn use `{ next_state, stage_result, ... }`. Sense returns the raw scan summary. The dispatcher then does shape-tests on the result to decide what to do next.

These aren't bugs — every stage works correctly today. But the lack of a contract means **extracting each stage into its own file produces seven different "what does a stage look like?" answers**, and the dispatcher logic that knows how to talk to each of the seven shapes gets pinned to its current location instead of becoming a single small router.

The architecturally-strong move is to define the contract first, then lift the stages into files that implement it.

## Proposed contract

### `StageContext` (input)

Everything a stage needs, passed as a single object. Resolved once per loop tick by the dispatcher, never re-resolved inside a stage.

```js
/**
 * @typedef {Object} StageContext
 * @property {ProjectRow} project              — already-resolved project row (never null inside a stage)
 * @property {InstanceRow} instance            — already-resolved loop instance (never null inside a stage)
 * @property {WorkItem|null} workItem          — currently-selected work item, or null for Sense
 * @property {string|null} batchId             — current execution batch, or null pre-EXECUTE
 * @property {WorkItemStore} workItemStore     — load, update, claim, routeToNeedsReplan, listOpen
 * @property {InstanceStore} instanceStore     — load, updateAndSync, rememberSelectedWorkItem, clearSelectedWorkItem
 * @property {DecisionStore} decisionStore     — log, getLatestForStage, listForBatch
 * @property {BatchStore} batchStore           — getOrCreate, listTasks
 * @property {WorktreeStore} worktreeStore     — getActiveByBatch, getActiveByProject, markMerged
 * @property {Logger} logger                   — pre-bound child logger with project/instance/stage tags
 */
```

Stages never see a raw `db` handle — they consume the typed store interfaces. This boundary is decided (see "Decisions" section below) because it keeps stages domain-shaped: a stage edit doesn't need to know SQL schema, just the operations its store exposes.

Why a context object instead of positional arguments:
- The dispatcher resolves the heavyweight values (project, instance, stores) **once**. Stages stop calling `getProjectOrThrow`, `factoryHealth.getProject`, or `defaultContainer.get('db')` on every entry.
- Tests construct a fake context once and reuse it across stage invocations.
- Adding a new piece of cross-cutting context (e.g. a feature-flag service, a trace span) is one edit to the typedef + one edit at the dispatcher's resolve site, instead of N stage-signature changes.
- The DI container becomes the **resolver**, not a global lookup performed inside each stage.
- Swapping the DB facade, adding a read replica, or wiring up observability is one edit per store, zero per stage.

### `StageOutcome` (output)

Every stage returns a single discriminated-union shape that the dispatcher reads to decide what to do next. **No more per-stage shape tests.**

```js
/**
 * @typedef {Object} StageOutcome
 * @property {'continue'|'pause'|'terminate'|'idle'|'starved'} disposition
 *   What should happen next:
 *   - 'continue':  advance to the next state in LOOP_STATES order (or `nextState` if set)
 *   - 'pause':     hold at `pausedAtStage`, awaiting external signal (gate, file lock, deferred plan)
 *   - 'terminate': the instance is done (success or unrecoverable failure)
 *   - 'idle':      no work to do; release the slot
 *   - 'starved':   intake is empty; route to recovery scouts
 *
 * @property {string|null} nextState     — explicit override; defaults to next-in-order for 'continue'
 * @property {string|null} pausedAtStage — required when disposition === 'pause'
 *
 * @property {WorkItem|null} workItem    — updated selected work item; null clears the selection
 * @property {string|null} batchId       — set when this stage produced a new batch (EXECUTE → VERIFY)
 *
 * @property {string|null} reason        — short human-readable reason, recorded in the decision log
 * @property {Object} stageResult        — stage-specific payload (scan summary, plan path, verify output…)
 *                                          — opaque to the dispatcher; visible to operators via decision log
 *
 * @property {DecisionRecord[]} [extraDecisions]
 *   — additional decision-log rows the stage wants emitted. The dispatcher writes them after the
 *     stage's primary `stage_complete` decision so they appear in causal order.
 */
```

**The dispatcher logic collapses to:**

```js
const ctx = await resolveStageContext({ project, instance });
const outcome = await stages[currentState](ctx);
await applyOutcome(ctx, outcome);  // emit decisions, update instance, transition state
```

That replaces ~800 lines of bespoke per-stage handling in `runAdvanceLoop`.

### Per-stage stage_result shape

Each stage gets its own typedef for what `stageResult` carries. The dispatcher does not read these — only operators and tests do.

```js
/** @typedef {{ plans_dir: string|null, scanned: number, created_count: number, shipped_count: number, skipped_count: number }} SenseStageResult */
/** @typedef {{ work_item_id: string|number|null, open_count: number }} PrioritizeStageResult */
/** @typedef {{ plan_path: string|null, plan_generation_task_id: string|null, status: 'materialized'|'deferred'|'failed' }} PlanStageResult */
/** @typedef {{ batch_id: string, tasks_submitted: number, mode: 'plan_file'|'non_plan_file' }} ExecuteStageResult */
/** @typedef {{ status: 'passed'|'failed'|'paused', exit_code: number|null, output_tail: string|null, fix_task_id: string|null }} VerifyStageResult */
/** @typedef {{ shipped_as_noop: boolean, feedback_id: string|null, summary: string|null }} LearnStageResult */
```

## Validation against the actual stages

A spec is only useful if it survives contact with reality. Walking each stage:

### Sense
- **Inputs needed:** `project`, `db` (for `createPlanFileIntake`), `logger`. No work item, no instance state mutation.
- **Outputs:** scan summary + decision-log entry.
- **Fit with proposed contract:** Clean. `disposition: 'continue'`, `nextState: PRIORITIZE`, `workItem: null`, `stageResult` = scan summary.
- **What goes away:** `getProjectOrThrow(project_id)` lookup inside the stage. Caller resolved it already.

### Prioritize
- **Inputs needed:** `project`, `instance`, `selectedWorkItem`-or-null.
- **Outputs:** new work item OR a "no open work item" signal. Mutates instance.work_item_id.
- **Fit:** Clean. The current `{ work_item, stage_result, reason }` becomes `{ disposition, workItem, reason, stageResult }`.
- **What goes away:** the dispatcher's special-case "if prioritizeStage.work_item is null, route to idle/starved" disappears — Prioritize now returns `disposition: 'idle'` or `disposition: 'starved'` directly.

### Plan
- **Inputs needed:** `project`, `instance`, optional `selectedWorkItem` for re-entry.
- **Outputs:** plan path (materialized) OR a deferred wait state. Mutates work-item origin.
- **Fit:** Clean. Deferred-wait becomes `disposition: 'pause'`, `pausedAtStage: 'EXECUTE_DEFERRED'`, `stageResult.status: 'deferred'`.

### ExecuteNonPlanFile, ExecutePlanFile
- **Inputs needed:** `project`, `instance`, `workItem`.
- **Outputs:** new batch_id, submitted task ids, branch info. Most complex stages by far.
- **Fit:** Clean. Both produce `{ disposition: 'continue', nextState: VERIFY, batchId, stageResult: ExecuteStageResult }`.
- **Caveat:** Several internal exit paths today return early with `stop_execution: true`, which the dispatcher uses to abort the tick. Under the contract, that becomes `disposition: 'pause'` with an explicit `pausedAtStage`.

### Verify
- **Inputs needed:** `project`, `instance`, `batchId`. Does NOT touch the work item directly — works off the batch.
- **Outputs:** verify result + optional fix-task submission. Returns `next_state` already.
- **Fit:** Clean. The current `next_state` becomes `nextState` on the outcome.
- **Note:** the auto-verify-retry path inside this stage currently mutates state and submits a follow-up task before returning. That's fine; the contract just says "what state are we in when you finish." How the stage gets there is the stage's business.

### Learn
- **Inputs needed:** `project`, `instance`, `batchId`. Last stage before IDLE.
- **Outputs:** feedback analysis + maybe-ship verdict. Returns `next_state: IDLE` or `next_state: PRIORITIZE` for re-cycle.
- **Fit:** Clean. `disposition: 'continue'`, `nextState` = IDLE or PRIORITIZE based on auto-continue policy.

**All seven stages fit the proposed contract** with a behavior-preserving translation. Nothing in the current code requires more flexibility than `StageOutcome` provides.

## What the contract intentionally does NOT specify

These remain stage-private and don't appear in the contract:

- **How a stage records progress.** Stages can call `ctx.decisions.log(...)` as many times as they want during execution. The contract just says the **terminal** decision (the one that records the outcome) is emitted by the dispatcher from the returned `StageOutcome`.
- **How a stage handles errors.** Throwing propagates to the dispatcher, which has its own error envelope. Catching and returning `disposition: 'pause'` with a `paused_reason` is the way to keep the loop alive across recoverable problems.
- **How a stage submits TORQUE tasks, talks to providers, or runs remote commands.** Those are internal implementation details of EXECUTE and VERIFY. The contract only constrains the interface.
- **Whether a stage is sync or async.** All stages become `async` under the contract (Sense is the only sync one today — its body has no awaits but making it async costs nothing). Uniformity is worth more than the one microsecond of synchronous return.

## Phase plan revision

With the contract in place, the remaining refactor phases change shape:

### Phase 2c (revised) — Stage interface scaffolding

**Before** moving any stage executor, land the contract as code:

1. `server/factory/stages/types.js` — JSDoc typedefs for `StageContext`, `StageOutcome`, and the six `*StageResult` shapes. Mirrors `plan-builders/types.js`.
2. `server/factory/stages/context.js` — `resolveStageContext({ project, instance })` factory. Resolves the DB handle, logger, decision recorder, and instance mutator. Single entry point for tests.
3. `server/factory/stages/apply-outcome.js` — `applyOutcome(ctx, outcome)` that the dispatcher uses to emit decisions, update instance state, and pick the next state.

Loop-controller still contains all seven stages, but they all start with `function executeFooStage(ctx) { ... }` after a thin adapter wraps each old signature. **The contract becomes the law before any extraction happens.**

### Phase 3 (revised) — Stage extraction

Now mechanical. Each stage moves to `server/factory/stages/<name>.js`, exports a single `executeFooStage(ctx)` function matching the contract. The dispatcher imports them from a `stages/index.js` map keyed by `LOOP_STATES`.

Order stays smallest-first (Sense → Learn → Prioritize → Plan → Verify → ExecutePlanFile → ExecuteNonPlanFile), but each phase is now a true `git mv`-shaped commit because the contract has already absorbed the heterogeneity.

### Phase 2b/2c (revised) — Lifecycle entry points

`startLoop`, `advanceLoop`, `awaitFactoryLoop`, `approveGate`, `rejectGate`, `terminateInstanceAndSync` etc. become consumers of `resolveStageContext` + `stages[state]` + `applyOutcome`. They lose their per-stage knowledge and become pure dispatch.

## Decisions (resolved 2026-05-15)

These were posed as open questions during the spec draft. The lens for each is "what survives the most change over the next 2-3 years."

### 1. `StageContext` carries **pre-wrapped stores**, not a raw `db` handle

Stages take typed store interfaces, never a raw `db`:

```
workItemStore   — load, update, claim, routeToNeedsReplan, listOpen
instanceStore   — load, updateAndSync, rememberSelectedWorkItem, clearSelectedWorkItem
decisionStore   — log, getLatestForStage, listForBatch
batchStore      — getOrCreate, listTasks
worktreeStore   — getActiveByBatch, getActiveByProject, markMerged
```

Each is a thin wrapper over the existing `factoryIntake` / `factoryLoopInstances` / `factoryDecisions` / `factoryWorktrees` modules — paid once in Phase 2c-scaffold, benefit compounds forever:

- Read replica, sharding, or DB facade swap: one edit per store, zero per stage.
- Per-store observability (tracing, timing): wrap once, get it everywhere.
- Tests fake a store interface, not a whole DB.
- Stages become functions of their context interface — domain logic, not DB clients with logic on top.

### 2. `applyOutcome` auto-emits a uniform `stage_complete` decision; `extraDecisions` is the escape hatch

The dispatcher writes one `stage_complete` row per stage tick with uniform fields (`project_id`, `instance_id`, `stage`, `disposition`, `next_state`, `paused_at_stage`, `reason`, `batch_id`, `work_item_id`, `stage_result`, `timestamp`).

Stages that need to emit additional causal events (e.g. EXECUTE submitting N tasks, VERIFY recording a fix-task submission) return them on `outcome.extraDecisions: DecisionRecord[]`. The dispatcher writes them **after** the primary `stage_complete` so causal order is preserved in the log.

Why: the dashboard and the `docs/recovery-decisions.md` audit tool both benefit from uniformity, and the addendum already calls out "silent UNKNOWN routing is the most common bug class." Uniform structured decisions narrow that surface. `extraDecisions` keeps signal-richness available where stages genuinely need it.

### 3. Keep `disposition` as the discriminator name

`nextAction` collides with `factory_decisions.action` (a different concept already alive in the codebase — that collision is exactly the kind of overload that produces real bugs). `verdict` implies judgment, not control flow. `disposition` has no overloads in this codebase and means precisely what it says here: "how should this tick be disposed of?" JSDoc the enum values inline next to the property and the jargon cost drops to zero.

### 4. Tests update in lockstep with each Phase 3 commit

Each `feat/refactor-3X-stage-*` worktree includes the stage's file move plus updates to its direct importers (~25 test files total, one or two per phase). No deprecation adapter, no hard cutover.

Why: deprecation adapters accumulate as silent technical debt — "we'll clean it up later" never happens reliably. Hard cutover breaks CI for unbounded time. Lockstep keeps each commit's blast radius predictable and tests on the new contract actually test the new contract.

## How to apply this doc

When picking up the next phase:

1. Read this doc.
2. Ship **Phase 2c-scaffold** first (types + `resolveStageContext` + `applyOutcome`) as a docs-and-scaffolding-only commit. Loop-controller behavior unchanged.
3. Adapt each existing stage in place to consume the context object via a thin wrapper, validating the contract holds. One phase per stage. Behavior still unchanged.
4. Once all seven stages use the context shape, lift the dispatcher logic into the new helpers. Loop-controller's dispatch code shrinks dramatically.
5. Then start Phase 3 stage extraction — by this point every move is `git mv` + delete-the-stub.

The work between this doc and the end of Phase 3 should be roughly 8-10 more focused phases. The result is a `loop-controller.js` of ~500-800 lines that's pure dispatch, with each stage in its own file implementing a clear interface.
