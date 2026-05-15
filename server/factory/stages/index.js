// `server/factory/stages/` — public surface.
//
// During Phase 2c-scaffold this just re-exports the contract scaffolding:
//   - `resolveStageContext()` for building a StageContext from a resolved
//     project + instance + the deps callbacks loop-controller passes in.
//   - `applyOutcome()` for the terminal dispatcher step that emits the
//     uniform `stage_complete` decision + extras and returns the
//     transition descriptor.
//   - Store factories (mostly used internally by resolveStageContext).
//   - The stage-order constant the dispatcher and `applyOutcome` share.
//
// Stage executors join this surface during Phase 3 as
// `executeSenseStage`, `executePrioritizeStage`, etc., each a function of
// (ctx: StageContext) => Promise<StageOutcome>.

const { resolveStageContext } = require('./context');
const { applyOutcome, STAGE_ORDER, nextInOrder } = require('./apply-outcome');
const stores = require('./stores');

module.exports = {
  resolveStageContext,
  applyOutcome,
  STAGE_ORDER,
  nextInOrder,
  ...stores,
};
