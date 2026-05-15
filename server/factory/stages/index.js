// `server/factory/stages/` — public surface.
//
// Phase 2c-scaffold (b2c0b3f3 + 53df812e) re-exports the contract
// scaffolding:
//   - `resolveStageContext()` for building a StageContext from a resolved
//     project + instance + the deps callbacks loop-controller passes in.
//   - `applyOutcome()` for the terminal dispatcher step that emits the
//     uniform `stage_complete` decision + extras and returns the
//     transition descriptor.
//   - Store factories (mostly used internally by resolveStageContext).
//   - The stage-order constant the dispatcher and `applyOutcome` share.
//
// Phase 2c-adapt adds one `create*StageRunner` per stage. Each runner
// wraps the legacy executor in loop-controller into a
// (ctx: StageContext) => Promise<StageOutcome>. The runner is the
// shape Phase 2c-dispatcher will dispatch through. Phase 3 then moves
// the legacy executor body into stages/<stage>.js and the runner can
// drop its `executeSenseStage` dep.

const { resolveStageContext } = require('./context');
const { applyOutcome, STAGE_ORDER, nextInOrder } = require('./apply-outcome');
const stores = require('./stores');
const { createSenseStageRunner } = require('./sense');
const { createPrioritizeStageRunner } = require('./prioritize');
const { createPlanStageRunner } = require('./plan');
const { createExecuteStageRunner, isPlanFileWorkItem } = require('./execute');
const { createVerifyStageRunner } = require('./verify');
const { createLearnStageRunner } = require('./learn');
const { createIdleStageRunner } = require('./idle');

module.exports = {
  resolveStageContext,
  applyOutcome,
  STAGE_ORDER,
  nextInOrder,
  ...stores,
  createSenseStageRunner,
  createPrioritizeStageRunner,
  createPlanStageRunner,
  createExecuteStageRunner,
  isPlanFileWorkItem,
  createVerifyStageRunner,
  createLearnStageRunner,
  createIdleStageRunner,
};
