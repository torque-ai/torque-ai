# `server/factory/stages/`

Stage interface scaffolding for the loop-controller refactor arc. Phase 2c-scaffold (this commit) lands the contract before any stage executor moves. Phase 2c-adapt wraps each existing executor in place. Phase 3 then moves the wrapped executors into this directory one file at a time.

Spec: [`docs/factory-stage-interface.md`](../../../docs/factory-stage-interface.md).
Baseline + phase checklist: [`docs/findings/2026-05-14-loop-controller-baseline.md`](../../../docs/findings/2026-05-14-loop-controller-baseline.md).

## What's here

| File | Owns |
|---|---|
| `types.js` | JSDoc typedefs (`StageContext`, `StageOutcome`, `WorkItemStore`, `InstanceStore`, `DecisionStore`, `BatchStore`, `WorktreeStore`, per-stage `*StageResult`). Exports nothing at runtime. |
| `context.js` | `resolveStageContext(...)` factory. Builds the single resolved-once context object every stage receives. |
| `apply-outcome.js` | `applyOutcome(ctx, currentStage, outcome)` — emits the uniform `stage_complete` decision + any `outcome.extraDecisions`, returns the transition descriptor for the dispatcher. Pure (no instance writes). |
| `stores/` | Five thin facades over the existing `factoryIntake` / `factoryLoopInstances` / `factoryDecisions` / `factoryWorktrees` modules. Stages consume these instead of touching DB modules directly. |
| `stores/index.js` | `buildStores(deps)` aggregator. |
| `index.js` | Public re-exports for the dispatcher and (eventually) the stage executors. |

## What's NOT here yet

- **Stage executors** (`executeSenseStage`, `executePrioritizeStage`, …). All seven still live in `server/factory/loop-controller.js`. Phase 2c-adapt wraps each in place to consume `StageContext` and return `StageOutcome` via a thin adapter. Phase 3 lifts each into its own file under this directory.
- **The dispatcher rewrite.** `runAdvanceLoop` in loop-controller still handles per-stage dispatch directly. Phase 2c-dispatcher (after all seven are adapted) lifts the dispatch into a stage-map + `applyOutcome` round-trip.

## How a stage consumes its context (preview)

After Phase 2c-adapt, every executor matches this shape:

```js
/**
 * @param {import('./types').StageContext} ctx
 * @returns {Promise<import('./types').StageOutcome>}
 */
async function executeFooStage(ctx) {
  const { project, instance, workItem, workItemStore, instanceStore, decisionStore, logger } = ctx;

  // ... stage-specific logic, no longer reaches into factoryIntake or
  // safeLogDecision directly ...

  return {
    disposition: 'continue',
    nextState: 'BAR',
    workItem: updatedWorkItem,
    reason: 'foo succeeded',
    stageResult: { /* per-stage shape */ },
  };
}
```

## Open seams (will close in later phases)

A few stores take callbacks as constructor deps where the underlying helper still lives in loop-controller:

- `instanceStore` takes `updateInstanceAndSync`, `rememberSelectedWorkItem`, `clearSelectedWorkItem`, `getSelectedWorkItem` as deps. Once those helpers extract (Phase 2c-adapt or a sibling phase), `createInstanceStore` will require those modules directly and the deps shrink.
- `batchStore` takes `listTasksForFactoryBatch` as a dep. Same pattern.
- `workItemStore.claimNext(...)` and `workItemStore.routeToNeedsReplan(...)` take the implementation function as a final argument. Once those helpers extract, the methods will call the extracted version directly.

These callbacks exist so Phase 2c-scaffold can land without touching loop-controller. They get tightened as later phases extract the helpers.

## Contract reminder

Stages return **one of five dispositions**:

| `disposition` | Meaning |
|---|---|
| `'continue'` | Advance to `nextState` (or next-in-order if `nextState` is null) |
| `'pause'` | Hold at `pausedAtStage`; wait for external signal (gate, file lock, deferred plan) |
| `'terminate'` | Instance is done (success or unrecoverable failure) |
| `'idle'` | No work to do; release the slot |
| `'starved'` | Intake is empty; route to recovery scouts |

Read `docs/factory-stage-interface.md` for the full validation against each existing stage.
