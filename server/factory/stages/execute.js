// EXECUTE stage adapter (Phase 2c-adapt slice 4).
//
// EXECUTE has two legacy variants depending on the work-item kind:
//   - plan-file backed → executePlanFileStage(project, instance, workItem)
//   - everything else → executeNonPlanFileStage(project, instance, workItem)
//
// The dispatcher picks based on workItem.kind / workItem.origin. Phase 3 will
// move both variants into stages/execute/ as siblings. This adapter exposes
// a single runner that dispatches between them at runtime — the same pattern
// the legacy dispatcher uses today.
//
// Adapter contract (StageOutcome):
//   - normal path → disposition: 'continue', batchId, stageResult: ExecuteStageResult
//   - stop_execution exit path → disposition: 'pause', pausedAtStage
//   - null return (no executable work) → disposition: 'idle'
//
// Phase 2c-dispatcher refines stop_execution → pause translation per-call-site.

function isPlanFileWorkItem(workItem) {
  return Boolean(workItem?.origin?.plan_path);
}

/**
 * @param {{
 *   executeNonPlanFileStage: (project: object, instance: object, workItem: object) => Promise<any>,
 *   executePlanFileStage:    (project: object, instance: object, workItem: object) => Promise<any>,
 * }} deps
 */
function createExecuteStageRunner({ executeNonPlanFileStage, executePlanFileStage } = {}) {
  if (typeof executeNonPlanFileStage !== 'function') {
    throw new TypeError('createExecuteStageRunner: executeNonPlanFileStage is required');
  }
  if (typeof executePlanFileStage !== 'function') {
    throw new TypeError('createExecuteStageRunner: executePlanFileStage is required');
  }

  return async function runExecuteStage(ctx) {
    if (!ctx || !ctx.project || ctx.project.id == null) {
      throw new TypeError('runExecuteStage: ctx with project.id is required');
    }
    if (!ctx.instance || ctx.instance.id == null) {
      throw new TypeError('runExecuteStage: ctx with instance.id is required');
    }
    if (!ctx.workItem) {
      throw new TypeError('runExecuteStage: ctx.workItem is required');
    }

    const mode = isPlanFileWorkItem(ctx.workItem) ? 'plan_file' : 'non_plan_file';
    const executor = mode === 'plan_file' ? executePlanFileStage : executeNonPlanFileStage;
    const legacy = await executor(ctx.project, ctx.instance, ctx.workItem);

    if (legacy === null) {
      return {
        disposition: 'idle',
        reason: 'EXECUTE stage returned null — no work to execute',
        stageResult: { batch_id: null, tasks_submitted: 0, mode },
      };
    }

    if (legacy?.stop_execution) {
      return {
        disposition: 'pause',
        pausedAtStage: legacy?.paused_at_stage || 'EXECUTE',
        batchId: legacy?.batch_id ?? null,
        reason: legacy?.reason || 'EXECUTE stage signalled stop_execution',
        stageResult: {
          batch_id: legacy?.batch_id ?? null,
          tasks_submitted: legacy?.tasks_submitted ?? 0,
          mode,
        },
      };
    }

    return {
      disposition: 'continue',
      nextState: null,
      batchId: legacy?.batch_id ?? null,
      reason: legacy?.reason ?? null,
      stageResult: {
        batch_id: legacy?.batch_id ?? null,
        tasks_submitted: legacy?.tasks_submitted ?? 0,
        mode,
      },
    };
  };
}

module.exports = { createExecuteStageRunner, isPlanFileWorkItem };
