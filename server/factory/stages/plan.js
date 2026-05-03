'use strict';

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`Missing PLAN stage dependency: ${name}`);
  }
}

function createPlanStage({
  LOOP_STATES,
  architectRunner,
  factoryIntake,
  fs,
  getDecisionBatchId,
  getHandleExecuteTransition,
  getProjectConfigForPlanGate,
  getSelectedWorkItem,
  getWorkItemDecisionContext,
  logger,
  rememberSelectedWorkItem,
  routePlanQualityGateFailureToNeedsReplan,
  safeLogDecision,
  tryMoveInstanceToStage,
  updateInstanceAndSync,
} = {}) {
  assertFunction(architectRunner?.runArchitectCycle, 'architectRunner.runArchitectCycle');
  assertFunction(factoryIntake?.updateWorkItem, 'factoryIntake.updateWorkItem');
  assertFunction(fs?.existsSync, 'fs.existsSync');
  assertFunction(fs?.readFileSync, 'fs.readFileSync');
  assertFunction(getDecisionBatchId, 'getDecisionBatchId');
  assertFunction(getHandleExecuteTransition, 'getHandleExecuteTransition');
  assertFunction(getProjectConfigForPlanGate, 'getProjectConfigForPlanGate');
  assertFunction(getSelectedWorkItem, 'getSelectedWorkItem');
  assertFunction(getWorkItemDecisionContext, 'getWorkItemDecisionContext');
  assertFunction(rememberSelectedWorkItem, 'rememberSelectedWorkItem');
  assertFunction(routePlanQualityGateFailureToNeedsReplan, 'routePlanQualityGateFailureToNeedsReplan');
  assertFunction(safeLogDecision, 'safeLogDecision');
  assertFunction(tryMoveInstanceToStage, 'tryMoveInstanceToStage');
  assertFunction(updateInstanceAndSync, 'updateInstanceAndSync');

  async function executePlanStage(project, instance, selectedWorkItem = null) {
    let workItem = selectedWorkItem || getSelectedWorkItem(instance, project.id, {
      fallbackToLoopSelection: true,
    });

    if (workItem) {
      rememberSelectedWorkItem(instance.id, workItem);
      updateInstanceAndSync(instance.id, { work_item_id: workItem.id });
    }

    if (workItem?.origin?.plan_path && fs.existsSync(workItem.origin.plan_path)) {
      // Bug D fix: pre-written plans previously bypassed plan-quality-gate
      // entirely, so plans containing bare `dotnet test` (and other heavy local
      // validation that governance rejects at execution time) reached EXECUTE
      // and the resulting tasks failed in 1s on the heavy-validation guard,
      // thrashing the worktree-reclaim loop. Run the gate against the
      // pre-written plan so it has the same quality bar as architect-generated.
      const planQualityGate = require('../plan-quality-gate');
      let preWrittenGateVerdict = null;
      let preWrittenPlanText = '';
      try {
        preWrittenPlanText = fs.readFileSync(workItem.origin.plan_path, 'utf8');
        preWrittenGateVerdict = await planQualityGate.evaluatePlan({
          plan: preWrittenPlanText,
          workItem,
          project,
          projectConfig: getProjectConfigForPlanGate(project),
        });
      } catch (err) {
        logger.warn('pre-written plan-quality-gate evaluation failed; treating as pass (fail-open)', {
          project_id: project.id,
          work_item_id: workItem.id,
          plan_path: workItem.origin.plan_path,
          err: err.message,
        });
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.PLAN,
          action: 'plan_quality_gate_fail_open',
          reasoning: `Pre-written plan gate threw: ${err.message}`,
          outcome: {
            work_item_id: workItem.id,
            plan_path: workItem.origin.plan_path,
          },
          confidence: 1,
          batch_id: getDecisionBatchId(project, workItem, null, instance),
        });
      }

      if (preWrittenGateVerdict && !preWrittenGateVerdict.passed) {
        const failedRules = preWrittenGateVerdict.hardFails.map((h) => h.rule);
        logger.warn('PLAN stage: pre-written plan rejected by quality gate', {
          project_id: project.id,
          work_item_id: workItem.id,
          plan_path: workItem.origin.plan_path,
          rules: failedRules,
        });
        const routed = routePlanQualityGateFailureToNeedsReplan(workItem, preWrittenGateVerdict);
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.PLAN,
          action: 'pre_written_plan_quality_rejected',
          reasoning: `Pre-written plan failed quality gate and was routed to needs_replan: ${failedRules.join(', ')}.`,
          inputs: {
            ...getWorkItemDecisionContext(workItem),
            plan_path: workItem.origin.plan_path,
          },
          outcome: {
            // architect_skipped is false here - neither architect nor the
            // executor ran; the gate caught the plan early and we're bailing.
            gate_only_evaluated: true,
            rule_violations: preWrittenGateVerdict.hardFails,
            plan_path: workItem.origin.plan_path,
            next_status: routed.status,
            ...getWorkItemDecisionContext(workItem),
          },
          confidence: 1,
          batch_id: getDecisionBatchId(project, workItem, null, instance),
        });
        return {
          reason: 'pre-written plan rejected by quality gate',
          work_item: routed,
          stop_execution: true,
          // Match architect-side rejection: PRIORITIZE picks the next work
          // item next tick rather than re-running SENSE's full plan-file scan.
          next_state: LOOP_STATES.PRIORITIZE,
          stage_result: {
            status: 'needs_replan',
            reason: 'pre_written_plan_rejected_by_quality_gate',
            work_item_id: routed.id,
            plan_path: workItem.origin.plan_path,
            rule_violations: failedRules,
          },
        };
      }

      workItem = factoryIntake.updateWorkItem(workItem.id, { status: 'executing' });
      rememberSelectedWorkItem(instance.id, workItem);
      logger.info('PLAN stage: pre-written plan detected, skipping architect', {
        project_id: project.id,
        work_item_id: workItem.id,
        plan_path: workItem.origin.plan_path,
      });
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.PLAN,
        action: 'skipped_for_plan_file',
        reasoning: 'pre-written plan detected; quality gate passed',
        inputs: {
          ...getWorkItemDecisionContext(workItem),
        },
        outcome: {
          architect_skipped: true,
          reason: 'pre-written plan detected',
          gate_passed: Boolean(preWrittenGateVerdict?.passed),
          ...getWorkItemDecisionContext(workItem),
        },
        confidence: 1,
        batch_id: getDecisionBatchId(project, workItem, null, instance),
      });
      return {
        skip_to_execute: true,
        reason: 'pre-written plan detected',
        work_item: workItem,
        stage_result: {
          reason: 'pre-written plan detected',
          work_item_id: workItem.id,
          plan_path: workItem.origin.plan_path,
        },
      };
    }

    const cycle = await architectRunner.runArchitectCycle(project.id, 'loop_plan');
    workItem = getSelectedWorkItem(instance, project.id, { fallbackToLoopSelection: true });
    if (workItem && workItem.status !== 'planned') {
      workItem = factoryIntake.updateWorkItem(workItem.id, { status: 'planned' });
      rememberSelectedWorkItem(instance.id, workItem);
      updateInstanceAndSync(instance.id, { work_item_id: workItem.id });
    }

    logger.info('PLAN stage: architect cycle completed', {
      project_id: project.id,
      cycle_id: cycle?.id ?? null,
      work_item_id: workItem?.id ?? null,
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.PLAN,
      action: 'generated_plan',
      reasoning: 'architect cycle completed',
      inputs: {
        ...getWorkItemDecisionContext(workItem),
      },
      outcome: {
        architect_skipped: false,
        cycle_id: cycle?.id ?? null,
        ...getWorkItemDecisionContext(workItem),
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, workItem, null, instance),
    });

    return {
      skip_to_execute: false,
      reason: 'architect cycle completed',
      work_item: workItem,
      stage_result: cycle,
    };
  }

  async function handlePlanTransition(context) {
    const { instance, transitionWorkItem = null } = context;
    const moveToExecute = tryMoveInstanceToStage(instance, LOOP_STATES.EXECUTE, {
      work_item_id: instance.work_item_id,
    });
    if (moveToExecute.blocked) {
      return {
        instance: moveToExecute.instance,
        transitionWorkItem,
        stageResult: null,
        transitionReason: 'stage_occupied',
      };
    }

    const executeHandler = getHandleExecuteTransition();
    assertFunction(executeHandler, 'getHandleExecuteTransition()');
    return executeHandler({
      ...context,
      instance: moveToExecute.instance,
      transitionWorkItem,
    });
  }

  return {
    executePlanStage,
    handlePlanTransition,
  };
}

module.exports = {
  createPlanStage,
};
