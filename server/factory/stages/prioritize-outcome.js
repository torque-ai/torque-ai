// derivePrioritizeOutcome — Phase 2c Step B (PRIORITIZE).
//
// The PRIORITIZE policy already lives in `handlePrioritizeTransition`
// (loop-controller.js), which always returns a transition descriptor:
//   { instance, transitionWorkItem, stageResult, transitionReason, nextState }
// PRIORITIZE never early-returns from runAdvanceLoop and never pauses —
// it always `break`s, having moved the instance to `nextState`
// (IDLE / STARVED on the no-work path, PLAN on the success path).
//
// Step B reads that descriptor and maps it to a StageOutcome the
// dispatcher feeds to `applyOutcome` for the uniform `stage_complete`
// decision:
//   nextState IDLE     → 'terminate'
//   nextState STARVED  → 'starved'
//   otherwise          → 'continue' (nextState carried through)

const { LOOP_STATES } = require('../loop-states');

/**
 * @param {{
 *   instance?: object,
 *   transitionWorkItem?: object|null,
 *   stageResult?: object|null,
 *   transitionReason?: string|null,
 *   nextState?: string|null,
 * }} prioritizeTransition  — the value returned by handlePrioritizeTransition.
 * @returns {import('./types').StageOutcome}
 */
function derivePrioritizeOutcome(prioritizeTransition) {
  if (!prioritizeTransition || typeof prioritizeTransition !== 'object') {
    throw new TypeError('derivePrioritizeOutcome: prioritizeTransition object is required');
  }

  const nextState = prioritizeTransition.nextState || null;
  const reason = prioritizeTransition.transitionReason ?? null;
  const stageResult = prioritizeTransition.stageResult ?? null;
  const workItem = prioritizeTransition.transitionWorkItem ?? null;

  if (nextState === LOOP_STATES.IDLE) {
    return { disposition: 'terminate', nextState: LOOP_STATES.IDLE, reason, stageResult, workItem };
  }
  if (nextState === LOOP_STATES.STARVED) {
    return { disposition: 'starved', nextState: LOOP_STATES.STARVED, reason, stageResult, workItem };
  }
  return { disposition: 'continue', nextState, reason, stageResult, workItem };
}

module.exports = { derivePrioritizeOutcome };
