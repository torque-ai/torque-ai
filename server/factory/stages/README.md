# `server/factory/stages/`

Stage executors and the stage-interface scaffolding for the factory loop. This
directory is the output of the loop-controller refactor arc (Phases 2c-3): the
five-stage executors that used to live inline in the 16,748-line
`server/factory/loop-controller.js` god-object now have their own files, and
the dispatcher talks to them through a uniform `StageContext` / `StageOutcome`
contract.

Spec: [`docs/factory-stage-interface.md`](../../../docs/factory-stage-interface.md).
Baseline + phase history: [`docs/findings/2026-05-14-loop-controller-baseline.md`](../../../docs/findings/2026-05-14-loop-controller-baseline.md).

## What's here

### Contract scaffolding (Phase 2c-scaffold)

| File | Owns |
|---|---|
| `types.js` | JSDoc typedefs (`StageContext`, `StageOutcome`, `WorkItemStore`, `InstanceStore`, `DecisionStore`, `BatchStore`, `WorktreeStore`, per-stage `*StageResult`). Exports nothing at runtime. |
| `context.js` | `resolveStageContext(...)` factory. Builds the single resolved-once context object every stage receives. |
| `apply-outcome.js` | `applyOutcome(ctx, currentStage, outcome)` — emits the uniform `stage_complete` decision + any `outcome.extraDecisions`, returns the transition descriptor for the dispatcher. Also exports `STAGE_ORDER` / `nextInOrder`. Pure (no instance writes). |
| `stores/` | Thin facades over the `factoryIntake` / `factoryLoopInstances` / `factoryDecisions` / `factoryWorktrees` DB modules. Stages consume these instead of touching DB modules directly. |
| `stores/index.js` | `buildStores(deps)` aggregator. |
| `index.js` | Public re-exports for the dispatcher (`resolveStageContext`, `applyOutcome`, `STAGE_ORDER`, the stores, the two Step B runners). |

### Stage executors (Phase 3)

| File | Lines | Factory | Owns |
|---|--:|---|---|
| `sense.js` | ~120 | `createSenseStage(deps)` | `executeSenseStage` — scans the plans directory for new plan files, records a `scanned_plans` decision, returns project health. |
| `prioritize.js` | ~510 | `createPrioritizeStage(deps)` | `executePrioritizeStage` + `handlePrioritizeTransition` — claims/scores the next work item, auto-rejects stuck items, auto-ships done ones, then advances to PLAN (or short-circuits to STARVED/IDLE). |
| `verify.js` | ~1,500 | `createVerifyStage(deps)` + `createVerifyStageRunner(deps)` | `executeVerifyStage` plus the Step B runner that lifted the post-VERIFY dispatcher policy (already-verified short-circuit, pause / terminal / move-to-LEARN routing) in. |
| `learn.js` | ~280 | `createLearnStage(deps)` + `createLearnStageRunner(deps)` | `executeLearnStage` plus the Step B runner that lifted the post-LEARN policy (shipping-pause, project-pause termination, `auto_continue` → SENSE recycle, terminate → IDLE) in. |
| `prioritize-outcome.js` | ~50 | `derivePrioritizeOutcome(...)` | Pure mapper: reads `handlePrioritizeTransition`'s descriptor and produces the `StageOutcome` the dispatcher feeds to `applyOutcome`. |
| `plan-execute-outcome.js` | ~60 | `derivePlanExecuteOutcome(...)` | Pure mapper: reads `handlePlanExecuteTransition`'s result and produces the `StageOutcome`. |

The combined **PLAN/EXECUTE** executor is large enough (and its dependency
cluster deep enough) that it lives one directory up as a sibling module — see
below.

## Sibling cluster modules in `server/factory/`

Phase 3 also extracted four helper clusters that the stages depend on. They
live in `server/factory/` (not `stages/`) because they are require-path
neighbors of `loop-controller.js` — keeping them as siblings means zero
require-path rebasing for the dozens of leaf modules they pull in.

| File | Lines | Factory | Owns |
|---|--:|---|---|
| `plan-execute.js` | ~3,800 | `createPlanExecuteStage(deps)` | `executePlanStage`, `executeNonPlanFileStage`, `executePlanFileStage`, `handlePlanExecuteTransition` + 13 cluster-internal helpers. The PLAN and both EXECUTE stage executors. |
| `plan-generation-cluster.js` | ~2,500 | `createPlanGenerationCluster(deps)` | 71 plan-generation functions + 13 module consts (`PLAN_GENERATOR_LABEL`, `WORK_ITEM_STATUS_ORDER`, …). |
| `worktree-owner.js` | ~680 | `createWorktreeOwner(deps)` | 21 worktree-lifecycle functions across 6 zones. |
| `execute-deferral.js` | ~580 | `createExecuteDeferral(deps)` | 12 members covering deferred-plan / file-lock handling on the EXECUTE path. |

## How the stages are wired

Every extracted module exports a `createXxx(deps)` factory rather than the
functions directly. `loop-controller.js` calls each factory once, injecting:

- **Leaf modules** — `require`d directly inside the extracted module (DB
  modules, `loop-states`, builders). No injection needed.
- **loop-controller-internal helpers** — the ~24 helpers that have *not* been
  extracted (`getProjectOrThrow`, `safeLogDecision`, `getDecisionBatchId`,
  `updateInstanceAndSync`, …). These are injected as deps so the extracted
  module never `require`s back into `loop-controller.js` — that would be a
  cycle.

Phase 2c Step B settled on **two stage-wiring shapes**, not the single uniform
runner the early Phase 2c-adapt sketch assumed:

- **LEARN / VERIFY** — the post-tick dispatcher policy was inline in the
  `switch` case. It was lifted into a deps-injected runner
  (`createLearnStageRunner`, `createVerifyStageRunner`) that returns a complete
  decision (a real `disposition` + the transition the dispatcher records).
- **PRIORITIZE / PLAN / EXECUTE** — the policy already lived in an extracted
  transition helper (`handlePrioritizeTransition`,
  `handlePlanExecuteTransition`), so a post-hoc `derive*Outcome()` pure
  function maps the helper's result to a `StageOutcome`. No runner needed.

`applyOutcome` then fires the uniform `stage_complete` decision on all five
stage paths.

## What still lives in `loop-controller.js`

After Phase 3 the controller is **~7,350 lines** (down from 16,748). It is no
longer a god-object but it is not yet a thin dispatcher either. It still holds:

- `runAdvanceLoop` — the per-stage dispatcher / state machine.
- The lifecycle getters (`getLoopState`, `getActiveInstances`, …) and the
  public `module.exports` surface every external caller imports.
- The ~24 stage-injected helpers that have not been extracted, plus the
  `createXxx({...})` wiring calls.
- Recovery / Codex-fallback integration glue.

Shrinking this further (a thin dispatcher + a separate state-machine module,
and extracting the remaining injected helpers so the `deps` bags shrink) is
follow-on work, not part of the Phase 0-4 extraction arc.

## Contract reminder

Stages return **one of five dispositions**:

| `disposition` | Meaning |
|---|---|
| `'continue'` | Advance to `nextState` (or next-in-order if `nextState` is null) |
| `'pause'` | Hold at `pausedAtStage`; wait for external signal (gate, file lock, deferred plan) |
| `'terminate'` | Instance is done (success or unrecoverable failure) |
| `'idle'` | No work to do; release the slot |
| `'starved'` | Intake is empty; route to recovery scouts |

Read [`docs/factory-stage-interface.md`](../../../docs/factory-stage-interface.md)
for the full contract and its validation against each stage.
