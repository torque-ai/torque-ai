// VERIFY stage adapter (Phase 2c-adapt slice 5, refined in 2c-dispatcher).
//
// Legacy signature: executeVerifyStage(project_id, batch_id, instance = null)
// Legacy return: mixed — { next_state, fix_task_id, exit_code, output_tail,
// pause_at_stage, reason, ... } or null. The current dispatcher reads many
// of those fields plus consults `isTerminalVerifyOutcome(legacy)` and
// `finalizeTerminalVerifyOutcome({stageResult: legacy})`.
//
// Adapter contract (StageOutcome):
//   - passed → disposition: 'continue', nextState: legacy.next_state || 'LEARN'
//   - failed without fix → disposition: 'pause', pausedAtStage from legacy
//   - failed with auto-fix submitted → disposition: 'pause' (the loop waits
//     on the fix task) with stageResult.fix_task_id populated
//
// stageResult exposes the contracted convenience fields plus the legacy
// return verbatim under `.legacy`. The dispatcher's verify-fail and
// terminal-outcome routing still reads from `.legacy` until Phase 3 lifts
// the policy into the runner.

/**
 * @param {{
 *   executeVerifyStage: (projectId: number|string, batchId: string|null, instance: object|null) => Promise<any>
 * }} deps
 */
function createVerifyStageRunner({ executeVerifyStage } = {}) {
  if (typeof executeVerifyStage !== 'function') {
    throw new TypeError('createVerifyStageRunner: executeVerifyStage is required');
  }

  return async function runVerifyStage(ctx) {
    if (!ctx || !ctx.project || ctx.project.id == null) {
      throw new TypeError('runVerifyStage: ctx with project.id is required');
    }
    const batchId = ctx.batchId ?? ctx.instance?.batch_id ?? null;
    const legacy = await executeVerifyStage(ctx.project.id, batchId, ctx.instance ?? null);

    const verifyStatus = legacy?.status || (legacy?.next_state === 'LEARN' ? 'passed' : 'failed');
    const fixTaskId = legacy?.fix_task_id ?? null;

    const stageResult = {
      status: verifyStatus,
      exit_code: legacy?.exit_code ?? null,
      output_tail: legacy?.output_tail ?? null,
      fix_task_id: fixTaskId,
      legacy: legacy ?? null,
    };

    if (verifyStatus === 'failed') {
      return {
        disposition: 'pause',
        pausedAtStage: legacy?.paused_at_stage || 'VERIFY',
        batchId,
        reason: legacy?.reason || 'VERIFY stage failed',
        stageResult,
      };
    }

    return {
      disposition: 'continue',
      nextState: legacy?.next_state || null,
      batchId,
      reason: legacy?.reason ?? null,
      stageResult,
    };
  };
}

module.exports = { createVerifyStageRunner };
