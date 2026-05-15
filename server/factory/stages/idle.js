// IDLE stage adapter (Phase 2c-adapt slice 7).
//
// IDLE has no legacy executor — the dispatcher just stays put when an
// instance reaches IDLE. This runner formalizes that: ctx in, idle outcome
// out. Phase 2c-dispatcher uses it to terminate the per-tick state machine
// uniformly with the other stages.
//
// No deps because there's no underlying executor to wrap.

/**
 * @returns {(ctx: import('./types').StageContext) => Promise<import('./types').StageOutcome>}
 */
function createIdleStageRunner() {
  return async function runIdleStage(ctx) {
    if (!ctx || !ctx.project || ctx.project.id == null) {
      throw new TypeError('runIdleStage: ctx with project.id is required');
    }
    return {
      disposition: 'idle',
      reason: 'IDLE — terminal state; no work to perform this tick',
      stageResult: null,
    };
  };
}

module.exports = { createIdleStageRunner };
