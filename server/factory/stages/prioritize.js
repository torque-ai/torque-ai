// PRIORITIZE stage adapter (Phase 2c-adapt slice 2).
//
// Legacy signature: executePrioritizeStage(project, instance, selectedWorkItem = null)
// Legacy return: { work_item, stage_result, reason } | null
//
// Adapter contract (StageOutcome):
//   - work_item present → disposition: 'continue', workItem: legacyResult.work_item
//   - work_item absent  → disposition: 'idle' (dispatcher routes to recovery scouts
//                          if the open-work-item count is actually zero; that
//                          starvation refinement is dispatcher-side and lands in
//                          Phase 2c-dispatcher)
//
// The runner is dead code at this commit. Phase 2c-dispatcher wires it.

/**
 * @param {{
 *   executePrioritizeStage: (project: object, instance: object, selectedWorkItem: object|null) => Promise<any>
 * }} deps
 * @returns {(ctx: import('./types').StageContext) => Promise<import('./types').StageOutcome>}
 */
function createPrioritizeStageRunner({ executePrioritizeStage } = {}) {
  if (typeof executePrioritizeStage !== 'function') {
    throw new TypeError('createPrioritizeStageRunner: executePrioritizeStage is required');
  }

  return async function runPrioritizeStage(ctx) {
    if (!ctx || !ctx.project || ctx.project.id == null) {
      throw new TypeError('runPrioritizeStage: ctx with project.id is required');
    }
    if (!ctx.instance || ctx.instance.id == null) {
      throw new TypeError('runPrioritizeStage: ctx with instance.id is required');
    }
    const legacy = await executePrioritizeStage(ctx.project, ctx.instance, ctx.workItem ?? null);
    const workItem = legacy?.work_item ?? null;
    return {
      disposition: workItem ? 'continue' : 'idle',
      nextState: null,
      workItem,
      reason: legacy?.reason ?? null,
      stageResult: legacy?.stage_result ?? null,
    };
  };
}

module.exports = { createPrioritizeStageRunner };
