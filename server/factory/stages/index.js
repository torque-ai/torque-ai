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
// Phase 2c Step B settled on two stage-wiring shapes, not the single
// uniform runner Phase 2c-adapt first sketched:
//   - LEARN / VERIFY — inline dispatcher policy was lifted into a
//     deps-injected runner: `createLearnStageRunner`, `createVerifyStageRunner`.
//   - PRIORITIZE / PLAN / EXECUTE — policy already lived in an extracted
//     loop-controller helper, so a post-hoc `derive*Outcome()` maps the
//     helper's result to a StageOutcome (see stages/plan-execute-outcome.js
//     and stages/prioritize-outcome.js); no runner needed.
// The five speculative `create*StageRunner` adapters from Phase 2c-adapt
// (sense / prioritize / plan / execute / idle) were never wired and have
// been removed.

const { resolveStageContext } = require('./context');
const { applyOutcome, STAGE_ORDER, nextInOrder } = require('./apply-outcome');
const stores = require('./stores');
const { createVerifyStageRunner } = require('./verify');
const { createLearnStageRunner } = require('./learn');

module.exports = {
  resolveStageContext,
  applyOutcome,
  STAGE_ORDER,
  nextInOrder,
  ...stores,
  createVerifyStageRunner,
  createLearnStageRunner,
};
