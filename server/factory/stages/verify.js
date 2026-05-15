// VERIFY stage runner — Phase 2c Step B (post-tick policy lifted in).
//
// Before Step B the dispatcher's `case LOOP_STATES.VERIFY` ran the
// policy inline: the already-verified short-circuit (skip the executor
// when the batch already has a verified-batch decision and this is not
// an approved rerun), then pause-at-stage / terminal-outcome /
// move-to-LEARN routing. Step B moves all of that here so the runner
// returns a complete decision.
//
// The runner performs the same instance side effects the legacy case
// did (updateInstanceAndSync on pause, tryMoveInstanceToStage on the
// LEARN advance). It also returns three bridge fields the dispatcher
// consumes directly:
//   - instance:       the (possibly mutated/replaced) instance row.
//   - legacy:         the legacy verify return (or the synthesized
//                     `skipped` object); the dispatcher keeps exposing
//                     it as its `stageResult` local.
//   - advanceResult:  finalizeTerminalVerifyOutcome's runAdvanceLoop
//                     return object for the terminal branch; null when
//                     the loop pauses or continues to LEARN.
// The bridge fields exist because the dispatcher still owns the
// runAdvanceLoop return contract.
//
// `stageResult` stays the lean VerifyStageResult shape so the
// `stage_complete` decision applyOutcome writes is not bloated; the
// full legacy object rides the `legacy` bridge.

const { LOOP_STATES } = require('../loop-states');

const REQUIRED_DEPS = [
  'executeVerifyStage',
  'getLatestStageDecision',
  'hasVerifiedBatchDecision',
  'isTerminalVerifyOutcome',
  'finalizeTerminalVerifyOutcome',
  'tryMoveInstanceToStage',
  'updateInstanceAndSync',
  'nowIso',
];

const RERUN_APPROVED_ACTIONS = ['gate_approved', 'retry_verify_requested'];

/**
 * @param {{
 *   executeVerifyStage: (projectId, batchId, instance) => Promise<any>,
 *   getLatestStageDecision: (projectId, stage) => object|null,
 *   hasVerifiedBatchDecision: (projectId, batchId) => boolean,
 *   isTerminalVerifyOutcome: (legacy) => boolean,
 *   finalizeTerminalVerifyOutcome: (args) => object,
 *   tryMoveInstanceToStage: (instance, stage, fields) => { instance: object, blocked: boolean },
 *   updateInstanceAndSync: (instanceId, fields) => object,
 *   nowIso: () => string,
 * }} deps
 * @returns {(ctx: import('./types').StageContext) => Promise<import('./types').StageOutcome>}
 */
function createVerifyStageRunner(deps = {}) {
  for (const name of REQUIRED_DEPS) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`createVerifyStageRunner: dep '${name}' is required`);
    }
  }
  const {
    executeVerifyStage,
    getLatestStageDecision,
    hasVerifiedBatchDecision,
    isTerminalVerifyOutcome,
    finalizeTerminalVerifyOutcome,
    tryMoveInstanceToStage,
    updateInstanceAndSync,
    nowIso,
  } = deps;

  return async function runVerifyStage(ctx) {
    if (!ctx || !ctx.project || ctx.project.id == null) {
      throw new TypeError('runVerifyStage: ctx with project.id is required');
    }
    if (!ctx.instance || ctx.instance.id == null) {
      throw new TypeError('runVerifyStage: ctx with instance.id is required');
    }
    const { project, previousState = null } = ctx;
    let instance = ctx.instance;
    const batchId = ctx.batchId ?? instance.batch_id ?? null;

    // Already-verified short-circuit: skip the executor when this batch
    // already produced a verified-batch decision and the current tick is
    // not an operator-approved rerun.
    const latestVerifyDecision = getLatestStageDecision(project.id, LOOP_STATES.VERIFY);
    const rerunApprovedVerify = RERUN_APPROVED_ACTIONS.includes(latestVerifyDecision?.action);
    const currentBatchAlreadyVerified = Boolean(
      instance.batch_id
      && !rerunApprovedVerify
      && hasVerifiedBatchDecision(project.id, instance.batch_id),
    );

    const legacy = currentBatchAlreadyVerified
      ? { status: 'skipped', reason: 'batch_already_verified', batch_id: instance.batch_id }
      : await executeVerifyStage(project.id, batchId, instance);

    const stageResult = {
      status: legacy?.status ?? null,
      exit_code: legacy?.exit_code ?? null,
      output_tail: legacy?.output_tail ?? null,
      fix_task_id: legacy?.fix_task_id ?? null,
    };

    // 1. Verify asked to pause — hold the instance at the named stage.
    //    Non-terminal: the dispatcher breaks to the post-switch path.
    if (legacy && legacy.pause_at_stage) {
      instance = updateInstanceAndSync(instance.id, {
        paused_at_stage: legacy.pause_at_stage,
        last_action_at: nowIso(),
      });
      return {
        disposition: 'pause',
        pausedAtStage: legacy.pause_at_stage,
        reason: legacy.reason || null,
        stageResult,
        legacy,
        instance,
        advanceResult: null,
      };
    }

    // 2. Terminal verify outcome — finalizeTerminalVerifyOutcome builds
    //    the runAdvanceLoop return object (it decides the new_state).
    if (isTerminalVerifyOutcome(legacy)) {
      const advanceResult = finalizeTerminalVerifyOutcome({
        project,
        instance,
        previousState,
        stageResult: legacy,
      });
      return {
        disposition: 'terminate',
        nextState: advanceResult?.new_state ?? null,
        reason: legacy?.reason || null,
        stageResult,
        legacy,
        instance,
        advanceResult,
      };
    }

    // 3. Verified — advance to LEARN.
    const moveToLearn = tryMoveInstanceToStage(instance, LOOP_STATES.LEARN, {
      batch_id: instance.batch_id,
      work_item_id: instance.work_item_id,
    });
    instance = moveToLearn.instance;
    return {
      disposition: 'continue',
      nextState: LOOP_STATES.LEARN,
      reason: moveToLearn.blocked
        ? 'stage_occupied'
        : (rerunApprovedVerify ? 'verify_rerun_completed' : 'verified_batch'),
      stageResult,
      legacy,
      instance,
      advanceResult: null,
    };
  };
}

module.exports = { createVerifyStageRunner };
