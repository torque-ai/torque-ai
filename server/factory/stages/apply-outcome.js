// applyOutcome — the dispatcher's terminal step after a stage returns.
//
// Reads the StageOutcome the stage produced, then:
//   1. Emits the uniform `stage_complete` decision (always exactly one).
//   2. Emits any outcome.extraDecisions in order (preserves causal order).
//   3. Returns a transition descriptor the dispatcher uses to mutate
//      instance state (loop_state / paused_at_stage / work_item_id /
//      batch_id).
//
// The dispatcher applies the transition itself via
// `ctx.instanceStore.updateAndSync(...)`. applyOutcome stays pure: no
// instance writes, no async work, just decision emission + transition
// computation. That keeps it trivially testable.

const STAGE_ORDER = Object.freeze([
  'SENSE',
  'PRIORITIZE',
  'PLAN',
  'EXECUTE',
  'VERIFY',
  'LEARN',
  'IDLE',
]);

function nextInOrder(currentStage) {
  const i = STAGE_ORDER.indexOf(String(currentStage || '').toUpperCase());
  if (i < 0 || i >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[i + 1];
}

/**
 * @param {import('./types').StageContext} ctx
 * @param {string} currentStage          — the stage name that just ran (e.g. 'PRIORITIZE')
 * @param {import('./types').StageOutcome} outcome
 * @returns {{
 *   nextState: string|null,
 *   pausedAtStage: string|null,
 *   workItemId: string|number|null|undefined,
 *   batchId: string|null|undefined,
 *   stopExecution: boolean,
 * }}
 */
function applyOutcome(ctx, currentStage, outcome) {
  if (!ctx || !ctx.decisionStore) {
    throw new Error('applyOutcome: StageContext with decisionStore required');
  }
  if (!outcome || !outcome.disposition) {
    throw new Error('applyOutcome: outcome.disposition is required');
  }

  const {
    disposition,
    nextState = null,
    pausedAtStage = null,
    workItem,
    batchId,
    reason = null,
    stageResult = null,
    extraDecisions = [],
  } = outcome;

  // 1. Compute the transition. 'continue' falls through to next-in-order
  //    unless the stage named an explicit nextState.
  let computedNextState = nextState;
  if (disposition === 'continue' && !computedNextState) {
    computedNextState = nextInOrder(currentStage);
  }
  if (disposition === 'pause' && !pausedAtStage) {
    throw new Error(`applyOutcome: disposition='pause' requires pausedAtStage (stage=${currentStage})`);
  }

  // 2. Emit the primary stage_complete decision.
  ctx.decisionStore.log({
    project_id: ctx.project.id,
    instance_id: ctx.instance.id,
    stage: currentStage,
    action: 'stage_complete',
    reasoning: reason || `${currentStage} completed with disposition=${disposition}`,
    inputs: {
      work_item_id: ctx.workItem?.id ?? null,
      batch_id: ctx.batchId ?? null,
    },
    outcome: {
      disposition,
      next_state: computedNextState,
      paused_at_stage: pausedAtStage,
      work_item_id: workItem === undefined ? (ctx.workItem?.id ?? null) : (workItem ? workItem.id : null),
      batch_id: batchId === undefined ? (ctx.batchId ?? null) : batchId,
      stage_result: stageResult,
    },
    confidence: 1,
    batch_id: batchId === undefined ? (ctx.batchId ?? null) : batchId,
  });

  // 3. Emit extraDecisions in order.
  for (const extra of extraDecisions) {
    if (!extra) continue;
    ctx.decisionStore.log(extra);
  }

  // 4. Compute the transition the dispatcher applies.
  const stopExecution = disposition === 'pause'
    || disposition === 'terminate'
    || disposition === 'idle'
    || disposition === 'starved';

  return {
    nextState: computedNextState,
    pausedAtStage,
    workItemId: workItem === undefined ? undefined : (workItem ? workItem.id : null),
    batchId,
    stopExecution,
  };
}

module.exports = { applyOutcome, STAGE_ORDER, nextInOrder };
