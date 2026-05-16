// LEARN stage runner — Phase 2c Step B (post-tick policy lifted in).
//
// Before Step B the dispatcher's `case LOOP_STATES.LEARN` ran the
// post-LEARN policy inline — shipping-pause check, project-pause
// termination, auto_continue → SENSE recycle, terminate → IDLE — and
// this runner merely wrapped the executor. Step B moves that policy
// here so the runner returns a complete decision: a real `disposition`
// plus the transition the dispatcher records.
//
// The runner performs the same instance side effects the legacy case
// did (terminate / move / update) — stages are allowed side effects.
// It also returns three bridge fields the dispatcher consumes directly:
//   - instance:       the (possibly mutated/replaced) instance row.
//   - analysis:       the legacy feedback-analysis object; the dispatcher
//                     keeps exposing it as its `stageResult` local.
//   - advanceResult:  the runAdvanceLoop early-return object for the two
//                     terminating branches; null when the loop continues
//                     (the dispatcher then breaks to the post-switch path).
// The bridge fields exist because the dispatcher still owns the
// runAdvanceLoop return contract. They retire when the dispatcher moves
// to applying applyOutcome's transition descriptor declaratively.
//
// `stageResult` stays the lean LearnStageResult shape so the
// `stage_complete` decision applyOutcome writes is not bloated with the
// whole analysis object; the full analysis rides the `analysis` bridge.

const { LOOP_STATES } = require('../loop-states');
const logger = require('../../logger').child({ component: 'factory-learn-stage' });

// ─── LEARN executor — Phase 3 (body lifted out of loop-controller) ───────────
//
// `executeLearnStage` runs the post-batch feedback analysis, records the
// `learned` decision, ships the work item if eligible, and returns the
// analysis object (with `shipping_result` attached). The body is verbatim
// from loop-controller.js; loop-controller keeps a one-line wiring:
//   const executeLearnStage = createLearnStage({ ...injected deps });
//
// `feedback` is lazy-required inside the executor (as the original was —
// it avoids a module-load cycle). `safeLogDecision` and
// `maybeShipWorkItemAfterLearn` are loop-controller-internal and injected.

const LEARN_EXECUTOR_DEPS = ['safeLogDecision', 'maybeShipWorkItemAfterLearn'];

/**
 * @param {{
 *   safeLogDecision: (entry: object) => any,
 *   maybeShipWorkItemAfterLearn: (projectId, batchId, instance) => Promise<any>,
 * }} deps
 * @returns {(projectId: number|string, batchId: string|null, instance: object|null) => Promise<any>}
 */
function createLearnStage(deps = {}) {
  for (const name of LEARN_EXECUTOR_DEPS) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`createLearnStage: dep '${name}' is required`);
    }
  }
  const { safeLogDecision, maybeShipWorkItemAfterLearn } = deps;

  return async function executeLearnStage(project_id, batch_id, instance) {
    try {
      const feedback = require('../feedback');
      const analysis = feedback.analyzeBatch(project_id, batch_id);
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.LEARN,
        action: 'learned',
        reasoning: 'LEARN stage analyzed post-batch feedback.',
        inputs: {
          batch_id,
          signals: {
            health_dimensions: Object.keys(analysis?.health_delta || {}).length,
            task_count: analysis?.execution_metrics?.task_count ?? null,
            guardrail_events: analysis?.guardrail_activity?.total ?? 0,
          },
        },
        outcome: {
          feedback_id: analysis?.feedback_id ?? null,
          summary: analysis?.summary || null,
        },
        confidence: 1,
        batch_id,
      });
      const shippingResult = await maybeShipWorkItemAfterLearn(project_id, batch_id, instance);
      if (analysis && typeof analysis === 'object') {
        analysis.shipping_result = shippingResult || null;
      }
      logger.info('LEARN stage: batch analysis complete', {
        project_id,
        batch_id,
        shipping_status: shippingResult?.status || null,
        shipping_reason: shippingResult?.reason || null,
        work_item_id: shippingResult?.work_item_id || null,
      });
      return analysis;
    } catch (err) {
      logger.warn(`LEARN stage analysis failed: ${err.message}`, { project_id });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.LEARN,
        action: 'learn_failed',
        reasoning: err.message,
        inputs: {
          batch_id,
          signals: null,
        },
        outcome: {
          status: 'error',
          error: err.message,
        },
        confidence: 1,
        batch_id,
      });
      return { status: 'error', error: err.message };
    }
  };
}

// ─── LEARN runner — Phase 2c Step B (post-tick policy) ───────────────────────

const REQUIRED_DEPS = [
  'executeLearnStage',
  'getProjectOrThrow',
  'isProjectPauseActive',
  'parseProjectConfigObject',
  'tryMoveInstanceToStage',
  'terminateInstanceAndSync',
  'recordFactoryIdleIfExhausted',
  'updateInstanceAndSync',
  'nowIso',
];

/**
 * @param {{
 *   executeLearnStage: (projectId, batchId, instance) => Promise<any>,
 *   getProjectOrThrow: (projectId) => object,
 *   isProjectPauseActive: (project) => boolean,
 *   parseProjectConfigObject: (project) => object,
 *   tryMoveInstanceToStage: (instance, stage, fields) => { instance: object, blocked: boolean },
 *   terminateInstanceAndSync: (instanceId) => any,
 *   recordFactoryIdleIfExhausted: (projectId, opts) => any,
 *   updateInstanceAndSync: (instanceId, fields) => object,
 *   nowIso: () => string,
 * }} deps
 * @returns {(ctx: import('./types').StageContext) => Promise<import('./types').StageOutcome>}
 */
function createLearnStageRunner(deps = {}) {
  for (const name of REQUIRED_DEPS) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`createLearnStageRunner: dep '${name}' is required`);
    }
  }
  const {
    executeLearnStage,
    getProjectOrThrow,
    isProjectPauseActive,
    parseProjectConfigObject,
    tryMoveInstanceToStage,
    terminateInstanceAndSync,
    recordFactoryIdleIfExhausted,
    updateInstanceAndSync,
    nowIso,
  } = deps;

  return async function runLearnStage(ctx) {
    if (!ctx || !ctx.project || ctx.project.id == null) {
      throw new TypeError('runLearnStage: ctx with project.id is required');
    }
    if (!ctx.instance || ctx.instance.id == null) {
      throw new TypeError('runLearnStage: ctx with instance.id is required');
    }
    const { project, previousState = null } = ctx;
    const instanceId = ctx.instance_id ?? ctx.instance.id;
    let instance = ctx.instance;
    const batchId = ctx.batchId ?? instance.batch_id ?? null;

    const analysis = await executeLearnStage(project.id, batchId, instance);
    const stageResult = {
      shipped_as_noop: analysis?.shipping_result?.status === 'noop_shipped',
      feedback_id: analysis?.feedback_id ?? null,
      summary: analysis?.summary ?? null,
    };

    // 1. Shipping paused — the loop holds at LEARN (or the gate the
    //    shipping result names). Non-terminal: the dispatcher breaks to
    //    the post-switch path, which records the pause.
    if (analysis?.shipping_result?.status === 'paused') {
      const pausedAtStage = analysis.shipping_result.pause_at_stage || LOOP_STATES.LEARN;
      instance = updateInstanceAndSync(instance.id, {
        paused_at_stage: pausedAtStage,
        last_action_at: nowIso(),
      });
      return {
        disposition: 'pause',
        pausedAtStage,
        reason: analysis.shipping_result.reason || 'shipping_paused',
        stageResult,
        analysis,
        instance,
        advanceResult: null,
      };
    }

    // 2. Project paused after LEARN — terminate the instance to IDLE.
    const latestProject = getProjectOrThrow(project.id);
    if (isProjectPauseActive(latestProject)) {
      const lastActionAt = instance.last_action_at || null;
      terminateInstanceAndSync(instance.id);
      recordFactoryIdleIfExhausted(project.id, {
        last_action_at: lastActionAt,
        reason: 'project_paused_after_learn',
      });
      return {
        disposition: 'terminate',
        nextState: LOOP_STATES.IDLE,
        reason: 'project_paused_after_learn',
        stageResult,
        analysis,
        instance,
        advanceResult: {
          project_id: project.id,
          instance_id: instanceId,
          previous_state: previousState,
          new_state: LOOP_STATES.IDLE,
          paused_at_stage: null,
          stage_result: analysis,
          reason: 'project_paused_after_learn',
        },
      };
    }

    // 3. auto_continue — recycle the loop back to SENSE for another pass.
    const cfg = parseProjectConfigObject(latestProject);
    if (cfg && cfg.loop && cfg.loop.auto_continue === true) {
      const moveToSense = tryMoveInstanceToStage(instance, LOOP_STATES.SENSE, {
        batch_id: null,
        work_item_id: null,
        paused_at_stage: null,
      });
      instance = moveToSense.instance;
      return {
        disposition: 'continue',
        nextState: LOOP_STATES.SENSE,
        // Legacy parity: only `stage_occupied` is set explicitly; the
        // success path left transitionReason untouched (null).
        reason: moveToSense.blocked ? 'stage_occupied' : null,
        stageResult,
        analysis,
        instance,
        advanceResult: null,
      };
    }

    // 4. Default — LEARN completed and the project does not auto-continue:
    //    terminate the instance to IDLE.
    const lastActionAt = instance.last_action_at || null;
    terminateInstanceAndSync(instance.id);
    recordFactoryIdleIfExhausted(project.id, {
      last_action_at: lastActionAt,
      reason: 'learn_completed',
    });
    return {
      disposition: 'terminate',
      nextState: LOOP_STATES.IDLE,
      reason: 'learn_completed',
      stageResult,
      analysis,
      instance,
      advanceResult: {
        project_id: project.id,
        instance_id: instanceId,
        previous_state: previousState,
        new_state: LOOP_STATES.IDLE,
        paused_at_stage: null,
        stage_result: analysis,
        reason: 'learn_completed',
      },
    };
  };
}

module.exports = { createLearnStage, createLearnStageRunner };
