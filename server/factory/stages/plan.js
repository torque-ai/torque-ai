// PLAN stage adapter (Phase 2c-adapt slice 3).
//
// Legacy signature: executePlanStage(project, instance, selectedWorkItem = null)
// Legacy return shape (current): mixed — either a plan-result object with
// a plan_path / next_state, or a deferred-wait object indicating the loop
// should pause until a plan-generation task finishes.
//
// Adapter contract (StageOutcome):
//   - materialized plan       → disposition: 'continue', stageResult.status: 'materialized'
//   - deferred plan generation → disposition: 'pause', pausedAtStage: 'EXECUTE_DEFERRED',
//                                stageResult.status: 'deferred'
//   - failed plan generation   → disposition: 'pause' with reason, stageResult.status: 'failed'
//
// The thin translation below is best-effort. Phase 2c-dispatcher refines edge
// cases as it actually wires this runner; this slice exists to lock the contract
// surface and the file location.

/**
 * @param {{
 *   executePlanStage: (project: object, instance: object, selectedWorkItem: object|null) => Promise<any>
 * }} deps
 */
function createPlanStageRunner({ executePlanStage } = {}) {
  if (typeof executePlanStage !== 'function') {
    throw new TypeError('createPlanStageRunner: executePlanStage is required');
  }

  return async function runPlanStage(ctx) {
    if (!ctx || !ctx.project || ctx.project.id == null) {
      throw new TypeError('runPlanStage: ctx with project.id is required');
    }
    if (!ctx.instance || ctx.instance.id == null) {
      throw new TypeError('runPlanStage: ctx with instance.id is required');
    }
    const legacy = await executePlanStage(ctx.project, ctx.instance, ctx.workItem ?? null);

    const deferred = Boolean(legacy?.deferred || legacy?.plan_generation_task_id);
    const planPath = legacy?.plan_path ?? legacy?.workItem?.origin?.plan_path ?? null;
    const taskId = legacy?.plan_generation_task_id ?? null;
    const status = deferred ? 'deferred' : (planPath ? 'materialized' : 'failed');

    if (deferred) {
      return {
        disposition: 'pause',
        pausedAtStage: 'EXECUTE_DEFERRED',
        reason: legacy?.reason || 'plan generation deferred to TORQUE',
        stageResult: { plan_path: planPath, plan_generation_task_id: taskId, status },
      };
    }

    return {
      disposition: 'continue',
      nextState: null,
      reason: legacy?.reason ?? null,
      stageResult: { plan_path: planPath, plan_generation_task_id: taskId, status },
    };
  };
}

module.exports = { createPlanStageRunner };
