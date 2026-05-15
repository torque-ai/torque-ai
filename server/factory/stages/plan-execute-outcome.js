// derivePlanExecuteOutcome — Phase 2c Step B (PLAN/EXECUTE).
//
// The combined PLAN/EXECUTE policy already lives in a helper:
// `handlePlanExecuteTransition` (loop-controller.js), extracted with 22
// exit points. It returns one of:
//   { earlyReturn: <runAdvanceLoop advance-result> }   — terminating/branching
//   { earlyReturn: null, instance, transitionWorkItem,
//     stageResult, transitionReason }                  — the legacy `break`
//
// Step B does NOT thread a `disposition` through those 22 exit points.
// Instead this pure function reads the helper's result after the fact
// and maps it to a StageOutcome the dispatcher feeds to `applyOutcome`
// for the uniform `stage_complete` decision. The mapping is exact
// enough for a benign informational decision and never produces a
// 'pause' without a `pausedAtStage` (which applyOutcome would reject):
//
//   earlyReturn with paused_at_stage  → 'pause'
//   earlyReturn new_state === IDLE    → 'terminate'
//   earlyReturn (other new_state)     → 'continue' (nextState = new_state)
//   break path, instance paused       → 'pause'
//   break path, not paused            → 'continue'

const { LOOP_STATES } = require('../loop-states');

/**
 * @param {{
 *   earlyReturn?: object|null,
 *   instance?: object,
 *   transitionWorkItem?: object|null,
 *   stageResult?: object|null,
 *   transitionReason?: string|null,
 * }} planExec  — the value returned by handlePlanExecuteTransition.
 * @returns {import('./types').StageOutcome}
 */
function derivePlanExecuteOutcome(planExec) {
  if (!planExec || typeof planExec !== 'object') {
    throw new TypeError('derivePlanExecuteOutcome: planExec object is required');
  }

  const earlyReturn = planExec.earlyReturn || null;
  if (earlyReturn) {
    const reason = earlyReturn.reason ?? null;
    const stageResult = earlyReturn.stage_result ?? null;
    if (earlyReturn.paused_at_stage) {
      return {
        disposition: 'pause',
        pausedAtStage: earlyReturn.paused_at_stage,
        nextState: earlyReturn.new_state || null,
        reason,
        stageResult,
      };
    }
    if (earlyReturn.new_state === LOOP_STATES.IDLE) {
      return { disposition: 'terminate', nextState: LOOP_STATES.IDLE, reason, stageResult };
    }
    return {
      disposition: 'continue',
      nextState: earlyReturn.new_state || null,
      reason,
      stageResult,
    };
  }

  // Break path — runAdvanceLoop continues to the post-switch code. If the
  // helper left the instance paused (several break branches set
  // paused_at_stage), record that as a pause; otherwise it's a plain
  // continue and the post-switch code computes the next state.
  const pausedAtStage = planExec.instance && planExec.instance.paused_at_stage;
  const reason = planExec.transitionReason ?? null;
  const stageResult = planExec.stageResult ?? null;
  if (pausedAtStage) {
    return { disposition: 'pause', pausedAtStage, reason, stageResult };
  }
  return { disposition: 'continue', nextState: null, reason, stageResult };
}

module.exports = { derivePlanExecuteOutcome };
