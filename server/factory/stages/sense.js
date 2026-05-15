// SENSE stage adapter (Phase 2c-adapt slice 1).
//
// The legacy `executeSenseStage(project_id, instance)` lives in
// loop-controller.js. The dispatcher (Phase 2c-dispatcher) will call
// stages via the (ctx) => StageOutcome contract documented in
// docs/factory-stage-interface.md.
//
// This adapter bridges the two: it takes the legacy executor as a
// constructor dep and returns a `(ctx) => Promise<StageOutcome>`
// function. Loop-controller is unchanged — the adapter is a
// proof-of-shape that locks the contract via a unit test. Phase
// 2c-dispatcher wires it into runAdvanceLoop. Phase 3 moves the
// executor body in here entirely.
//
// SENSE's outcome:
//   - disposition: 'continue'. The loop always falls through to
//     PRIORITIZE after SENSE — the "starved" check happens in
//     PRIORITIZE, not here.
//   - nextState: null. applyOutcome picks next-in-order = PRIORITIZE.
//   - stageResult: { summary }. The project-health summary that
//     executeSenseStage already returns, preserved verbatim.

/**
 * Build a SENSE stage runner that conforms to the StageContext /
 * StageOutcome contract.
 *
 * @param {{
 *   executeSenseStage: (projectId: number|string, instance: object|null) => any
 * }} deps
 * @returns {(ctx: import('./types').StageContext) => Promise<import('./types').StageOutcome>}
 */
function createSenseStageRunner({ executeSenseStage } = {}) {
  if (typeof executeSenseStage !== 'function') {
    throw new TypeError('createSenseStageRunner: executeSenseStage is required');
  }

  return async function runSenseStage(ctx) {
    if (!ctx || !ctx.project || ctx.project.id == null) {
      throw new TypeError('runSenseStage: ctx with project.id is required');
    }
    const summary = executeSenseStage(ctx.project.id, ctx.instance ?? null);
    return {
      disposition: 'continue',
      nextState: null,
      stageResult: { summary: summary ?? null },
    };
  };
}

module.exports = { createSenseStageRunner };
