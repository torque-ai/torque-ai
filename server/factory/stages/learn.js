// LEARN stage adapter (Phase 2c-adapt slice 6, refined in 2c-dispatcher).
//
// Legacy signature: executeLearnStage(project_id, batch_id, instance)
// Legacy return: the feedback analysis object (with shipping_result attached)
// or null on error.
//
// Adapter contract (StageOutcome):
//   - normal completion → disposition: 'continue', nextState: 'IDLE'
//                          stageResult.shipped_as_noop derived from shipping_result.status
//   - error → disposition: 'continue', nextState: 'IDLE' (legacy already
//             swallows; the loop advances regardless)
//
// stageResult exposes both the contracted convenience fields and the
// legacy `analysis` object verbatim. The dispatcher's post-LEARN policy
// (auto-continue branching, shipping_result.status === 'paused' check,
// project-pause check) still reads from `analysis` — that's the seam
// Phase 2c-dispatcher uses while the policy stays in loop-controller.
// Phase 3 lifts the policy in here and `analysis` becomes private.

/**
 * @param {{
 *   executeLearnStage: (projectId: number|string, batchId: string|null, instance: object|null) => Promise<any>
 * }} deps
 */
function createLearnStageRunner({ executeLearnStage } = {}) {
  if (typeof executeLearnStage !== 'function') {
    throw new TypeError('createLearnStageRunner: executeLearnStage is required');
  }

  return async function runLearnStage(ctx) {
    if (!ctx || !ctx.project || ctx.project.id == null) {
      throw new TypeError('runLearnStage: ctx with project.id is required');
    }
    const batchId = ctx.batchId ?? ctx.instance?.batch_id ?? null;
    const analysis = await executeLearnStage(ctx.project.id, batchId, ctx.instance ?? null);

    const shippedAsNoop = analysis?.shipping_result?.status === 'noop_shipped';
    const feedbackId = analysis?.feedback_id ?? null;
    const summary = analysis?.summary ?? null;

    return {
      disposition: 'continue',
      nextState: 'IDLE',
      batchId,
      reason: null,
      stageResult: {
        shipped_as_noop: shippedAsNoop,
        feedback_id: feedbackId,
        summary,
        analysis: analysis ?? null,
      },
    };
  };
}

module.exports = { createLearnStageRunner };
