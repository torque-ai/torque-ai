// EXECUTE-stage deferral helpers — Phase 3 slice 5 re-scope (3a).
//
// When a project is paused mid-EXECUTE, the loop defers the next plan task
// instead of submitting it; on resume it inspects, validates, and re-logs
// the deferral. This module is the lifted execute-deferral cluster (12
// members) from loop-controller.js. createExecuteDeferral(deps) injects the
// 10 loop-controller-internal helpers + the EXECUTE_DEFERRED_STALE_MS
// constant; leaf modules are required directly. loop-controller keeps a
// one-line wiring and destructures the 8 names its PLAN/EXECUTE block calls.

const fs = require('fs');
const { LOOP_STATES } = require('./loop-states');
const { parsePlanFile } = require('./plan-parser');
const { getProjectConfigForPlanGate } = require('./shared/project-config');
const factoryNotifications = require('./notifications');
const logger = require('../logger').child({ component: 'factory-execute-deferral' });

const DEFERRAL_FN_DEPS = [
  'findExistingPlanTaskSubmission',
  'getDatabaseHandle',
  'getDecisionRowWorkItemId',
  'getProjectOrThrow',
  'getWorkItemDecisionContext',
  'hydrateDecisionRow',
  'normalizeWorkItemId',
  'parseJsonObject',
  'routePlanQualityGateFailureToNeedsReplan',
  'safeLogDecision',
];

function createExecuteDeferral(deps = {}) {
  for (const name of DEFERRAL_FN_DEPS) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`createExecuteDeferral: dep '${name}' is required`);
    }
  }
  if (typeof deps.EXECUTE_DEFERRED_STALE_MS !== 'number') {
    throw new TypeError("createExecuteDeferral: dep 'EXECUTE_DEFERRED_STALE_MS' (number) is required");
  }
  const {
    findExistingPlanTaskSubmission,
    getDatabaseHandle,
    getDecisionRowWorkItemId,
    getProjectOrThrow,
    getWorkItemDecisionContext,
    hydrateDecisionRow,
    normalizeWorkItemId,
    parseJsonObject,
    routePlanQualityGateFailureToNeedsReplan,
    safeLogDecision,
    EXECUTE_DEFERRED_STALE_MS,
  } = deps;

  class ExecuteDeferredPausedError extends Error {
    constructor(deferral) {
      super('Project paused before next EXECUTE plan task submission');
      this.name = 'ExecuteDeferredPausedError';
      this.code = 'FACTORY_EXECUTE_DEFERRED_PAUSED';
      Object.assign(this, deferral || {});
    }
  }

  function deferExecutePlanTaskIfProjectPaused({
    project_id,
    batch_id,
    workItem,
    planPath,
    planTaskNumber,
    planTaskTitle,
  }) {
    const latestProject = getProjectOrThrow(project_id);
    if (latestProject.status !== 'paused') {
      return null;
    }

    const deferral = {
      project_id,
      batch_id: batch_id || null,
      work_item_id: workItem?.id ?? null,
      plan_path: planPath || workItem?.origin?.plan_path || null,
      plan_task_number: planTaskNumber ?? null,
      remaining_plan_task_number: planTaskNumber ?? null,
      plan_task_title: planTaskTitle || null,
    };

    safeLogDecision({
      project_id,
      stage: LOOP_STATES.EXECUTE,
      action: 'execute_deferred_paused',
      reasoning: 'Project is paused; deferring the next EXECUTE plan task instead of submitting a new Codex task.',
      inputs: {
        ...getWorkItemDecisionContext(workItem),
        plan_task_number: deferral.plan_task_number,
        remaining_plan_task_number: deferral.remaining_plan_task_number,
        plan_task_title: deferral.plan_task_title,
      },
      outcome: {
        work_item_id: deferral.work_item_id,
        plan_path: deferral.plan_path,
        plan_task_number: deferral.plan_task_number,
        remaining_plan_task_number: deferral.remaining_plan_task_number,
        plan_task_title: deferral.plan_task_title,
        project_status: latestProject.status,
        next_state: LOOP_STATES.EXECUTE,
      },
      confidence: 1,
      batch_id: deferral.batch_id,
    });

    return deferral;
  }

  function getLatestExecutePausedDeferral({ project_id, batch_id, work_item_id } = {}) {
    const db = getDatabaseHandle();
    if (!db || !project_id || !batch_id) {
      return null;
    }

    try {
      const rows = db.prepare(`
        SELECT id, stage, actor, action, reasoning, inputs_json, outcome_json, batch_id, created_at
        FROM factory_decisions
        WHERE project_id = ?
          AND stage = 'execute'
          AND batch_id = ?
        ORDER BY id DESC
        LIMIT 50
      `).all(project_id, batch_id);

      for (const row of rows) {
        const hydrated = hydrateDecisionRow(row);
        if (work_item_id && getDecisionRowWorkItemId(hydrated) !== normalizeWorkItemId(work_item_id)) {
          continue;
        }
        if (hydrated.action === 'completed_execution' || hydrated.action === 'execution_failed') {
          return null;
        }
        if (hydrated.action === 'execute_deferred_paused') {
          return hydrated;
        }
      }
    } catch (error) {
      logger.debug('Unable to inspect deferred EXECUTE decisions', {
        project_id,
        batch_id,
        err: error.message,
      });
    }

    return null;
  }

  function hasExecuteDeferralFollowup({ project_id, batch_id, action, deferral_id } = {}) {
    const db = getDatabaseHandle();
    if (!db || !project_id || !batch_id || !action || !deferral_id) {
      return false;
    }

    try {
      const rows = db.prepare(`
        SELECT id, outcome_json
        FROM factory_decisions
        WHERE project_id = ?
          AND stage = 'execute'
          AND batch_id = ?
          AND action = ?
        ORDER BY id DESC
        LIMIT 25
      `).all(project_id, batch_id, action);

      return rows.some((row) => {
        const outcome = parseJsonObject(row.outcome_json);
        return Number(outcome?.deferral_decision_id) === Number(deferral_id);
      });
    } catch (error) {
      logger.debug('Unable to inspect deferred EXECUTE follow-up decisions', {
        project_id,
        batch_id,
        action,
        err: error.message,
      });
      return false;
    }
  }

  function logExecuteDeferredResume({ project, instance, workItem, batchId, deferral }) {
    if (!deferral || hasExecuteDeferralFollowup({
      project_id: project.id,
      batch_id: batchId,
      action: 'execute_deferred_resumed',
      deferral_id: deferral.id,
    })) {
      return;
    }

    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'execute_deferred_resumed',
      reasoning: 'Project resumed; continuing the deferred EXECUTE batch from its existing plan-task position.',
      inputs: {
        ...getWorkItemDecisionContext(workItem),
        instance_id: instance?.id || null,
        deferral_decision_id: deferral.id,
        deferred_at: deferral.created_at || null,
        deferred_plan_task_number: deferral.outcome?.plan_task_number ?? null,
        remaining_plan_task_number: getDeferredRemainingPlanTaskNumber(deferral),
      },
      outcome: {
        ...getWorkItemDecisionContext(workItem),
        instance_id: instance?.id || null,
        deferral_decision_id: deferral.id,
        batch_id: batchId,
        remaining_plan_task_number: getDeferredRemainingPlanTaskNumber(deferral),
        next_state: LOOP_STATES.EXECUTE,
      },
      confidence: 1,
      batch_id: batchId,
    });
  }

  function normalizePlanTaskNumber(value) {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
  }

  function getDeferredRemainingPlanTaskNumber(deferral) {
    return normalizePlanTaskNumber(
      deferral?.outcome?.remaining_plan_task_number
      ?? deferral?.inputs?.remaining_plan_task_number
      ?? deferral?.outcome?.plan_task_number
      ?? deferral?.inputs?.plan_task_number,
    );
  }

  async function getNextExecutablePlanTask(parsedPlan, workingDirectory) {
    const tasks = Array.isArray(parsedPlan?.tasks) ? parsedPlan.tasks : [];
    if (tasks.length === 0) {
      return null;
    }

    let verifyCompletedTaskArtifacts = null;
    try {
      ({ verifyCompletedTaskArtifacts } = require('./plan-executor'));
    } catch (_err) {
      void _err;
    }

    for (const task of tasks) {
      if (task.completed && typeof verifyCompletedTaskArtifacts === 'function') {
        const verification = await verifyCompletedTaskArtifacts(task, workingDirectory);
        if (verification.trust) {
          continue;
        }
      } else if (task.completed) {
        continue;
      }
      return task;
    }
    return null;
  }

  async function inspectExecuteDeferredResume({
    project,
    workItem,
    batchId,
    deferral,
    planPath,
    workingDirectory,
    taskCore,
  }) {
    if (!deferral) {
      return null;
    }

    const remainingPlanTaskNumber = getDeferredRemainingPlanTaskNumber(deferral);
    const base = {
      deferral,
      remaining_plan_task_number: remainingPlanTaskNumber,
      next_executable_plan_task_number: null,
      existing_task_id: null,
      existing_task_status: null,
      stale_reason: null,
      valid: false,
    };

    if (!remainingPlanTaskNumber) {
      return {
        ...base,
        stale_reason: 'missing_remaining_plan_task_number',
      };
    }

    let parsedPlan = null;
    try {
      parsedPlan = parsePlanFile(fs.readFileSync(planPath, 'utf8'));
    } catch (error) {
      return {
        ...base,
        stale_reason: 'plan_unreadable',
        error: error.message,
      };
    }

    const tasks = Array.isArray(parsedPlan?.tasks) ? parsedPlan.tasks : [];
    const remainingTask = tasks.find((task) => (
      normalizePlanTaskNumber(task?.task_number) === remainingPlanTaskNumber
    ));
    if (!remainingTask) {
      return {
        ...base,
        stale_reason: 'remaining_plan_task_missing',
      };
    }

    const reusableTask = findExistingPlanTaskSubmission(taskCore, {
      projectName: project?.name || null,
      workingDirectory: null,
      workItemId: workItem?.id,
      planTaskNumber: remainingPlanTaskNumber,
      batchId,
    });
    if (reusableTask?.task_id) {
      return {
        ...base,
        existing_task_id: reusableTask.task_id,
        existing_task_status: reusableTask.status || null,
        stale_reason: reusableTask.status === 'completed'
          ? 'remaining_plan_task_already_completed'
          : 'remaining_plan_task_already_started',
      };
    }

    const nextExecutableTask = await getNextExecutablePlanTask(parsedPlan, workingDirectory);
    const nextExecutablePlanTaskNumber = normalizePlanTaskNumber(nextExecutableTask?.task_number);
    if (!nextExecutablePlanTaskNumber) {
      return {
        ...base,
        stale_reason: 'no_next_executable_plan_task',
      };
    }

    if (nextExecutablePlanTaskNumber !== remainingPlanTaskNumber) {
      return {
        ...base,
        next_executable_plan_task_number: nextExecutablePlanTaskNumber,
        stale_reason: 'remaining_plan_task_not_next_executable',
      };
    }

    return {
      ...base,
      next_executable_plan_task_number: nextExecutablePlanTaskNumber,
      valid: true,
    };
  }

  function logExecuteDeferredPausedStaleWarning({ project, instance, workItem, batchId, inspection }) {
    const deferral = inspection?.deferral;
    if (!deferral || hasExecuteDeferralFollowup({
      project_id: project.id,
      batch_id: batchId,
      action: 'execute_deferred_paused_stale_warning',
      deferral_id: deferral.id,
    })) {
      return null;
    }

    const warning = {
      work_item_id: workItem?.id ?? null,
      instance_id: instance?.id || null,
      batch_id: batchId,
      deferral_decision_id: deferral.id,
      deferred_at: deferral.created_at || null,
      stale_reason: inspection.stale_reason || 'unknown',
      remaining_plan_task_number: inspection.remaining_plan_task_number ?? null,
      next_executable_plan_task_number: inspection.next_executable_plan_task_number ?? null,
      existing_task_id: inspection.existing_task_id || null,
      existing_task_status: inspection.existing_task_status || null,
      ignored: true,
    };

    logger.warn('EXECUTE stage: ignoring stale paused deferral', {
      project_id: project.id,
      ...warning,
    });

    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'execute_deferred_paused_stale_warning',
      reasoning: `Ignored stale paused EXECUTE deferral: ${warning.stale_reason}.`,
      inputs: {
        ...getWorkItemDecisionContext(workItem),
        instance_id: instance?.id || null,
        deferral_decision_id: deferral.id,
        deferred_at: deferral.created_at || null,
        remaining_plan_task_number: warning.remaining_plan_task_number,
      },
      outcome: {
        ...warning,
        next_state: LOOP_STATES.EXECUTE,
      },
      confidence: 1,
      batch_id: batchId,
    });

    return warning;
  }

  async function maybeRejectResumedDeferredPlan({ project, workItem, batchId }) {
    // Bug D-extension: when resuming a deferred EXECUTE batch (e.g. after
    // a project pause/restart) the loop bypasses PLAN entirely, so the
    // plan-quality-gate that the executePlanStage Bug D fix runs is never
    // exercised on these items. Items that were approved under the older
    // gate rule-set (or by an architect prior to the gate existing) get
    // stuck looping EXECUTE -> governance-reject -> reclaim -> EXECUTE.
    // Re-evaluate the persisted plan file here so legacy items get the same
    // quality bar as freshly-planned ones, and bail out of EXECUTE if it
    // would now be rejected.
    const planQualityGateResume = require('./plan-quality-gate');
    let resumeGateVerdict = null;
    try {
      const planText = fs.readFileSync(workItem.origin.plan_path, 'utf8');
      resumeGateVerdict = await planQualityGateResume.evaluatePlan({
        plan: planText,
        workItem,
        project,
        projectConfig: getProjectConfigForPlanGate(project),
      });
    } catch (err) {
      logger.warn('resume-deferred plan-quality-gate evaluation failed; proceeding (fail-open)', {
        project_id: project.id,
        work_item_id: workItem.id,
        plan_path: workItem.origin.plan_path,
        err: err.message,
      });
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'plan_quality_gate_fail_open',
        reasoning: `Resume-deferred plan gate threw: ${err.message}`,
        outcome: {
          work_item_id: workItem.id,
          plan_path: workItem.origin.plan_path,
        },
        confidence: 1,
        batch_id: batchId,
      });
    }
    if (!resumeGateVerdict || resumeGateVerdict.passed) {
      return null;
    }

    const failedRules = resumeGateVerdict.hardFails.map((h) => h.rule);
    const routed = routePlanQualityGateFailureToNeedsReplan(workItem, resumeGateVerdict);
    logger.warn('EXECUTE stage: resumed deferred plan rejected by quality gate', {
      project_id: project.id,
      work_item_id: workItem.id,
      plan_path: workItem.origin.plan_path,
      rules: failedRules,
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'resumed_plan_quality_rejected',
      reasoning: `Resumed deferred plan failed quality gate on re-evaluation: ${failedRules.join(', ')}.`,
      inputs: {
        ...getWorkItemDecisionContext(workItem),
        plan_path: workItem.origin.plan_path,
      },
      outcome: {
        rule_violations: resumeGateVerdict.hardFails,
        plan_path: workItem.origin.plan_path,
        next_status: routed.status,
        ...getWorkItemDecisionContext(workItem),
      },
      confidence: 1,
      batch_id: batchId,
    });
    return {
      next_state: LOOP_STATES.PRIORITIZE,
      stop_execution: true,
      stage_result: {
        status: 'needs_replan',
        reason: 'pre_written_plan_rejected_by_quality_gate',
        work_item_id: routed.id,
        plan_path: workItem.origin.plan_path,
        rule_violations: failedRules,
      },
    };
  }

  function maybeWarnStaleExecuteDeferral({ project, instance, workItem, batchId, deferral }) {
    if (!deferral?.created_at) {
      return null;
    }

    const deferredAtMs = Date.parse(deferral.created_at);
    if (!Number.isFinite(deferredAtMs)) {
      return null;
    }

    const ageMs = Date.now() - deferredAtMs;
    if (ageMs < EXECUTE_DEFERRED_STALE_MS || hasExecuteDeferralFollowup({
      project_id: project.id,
      batch_id: batchId,
      action: 'execute_deferred_paused_stale_warning',
      deferral_id: deferral.id,
    })) {
      return null;
    }

    const staleHours = Math.floor(ageMs / (60 * 60 * 1000));
    const warning = {
      work_item_id: workItem?.id ?? null,
      instance_id: instance?.id || null,
      batch_id: batchId,
      deferral_decision_id: deferral.id,
      deferred_at: deferral.created_at,
      stale_hours: staleHours,
      threshold_hours: 24,
      plan_task_number: deferral.outcome?.plan_task_number ?? null,
    };

    logger.warn('EXECUTE stage: resuming stale paused deferral', {
      project_id: project.id,
      ...warning,
    });

    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'execute_deferred_paused_stale_warning',
      reasoning: `Deferred EXECUTE batch has been paused for ${staleHours} hour(s); warning only, cancellation semantics unchanged.`,
      inputs: {
        ...getWorkItemDecisionContext(workItem),
        instance_id: instance?.id || null,
        deferral_decision_id: deferral.id,
        deferred_at: deferral.created_at,
      },
      outcome: {
        ...warning,
        next_state: LOOP_STATES.EXECUTE,
        cancellation_changed: false,
      },
      confidence: 1,
      batch_id: batchId,
    });

    try {
      factoryNotifications.notify({
        project_id: project.id,
        event_type: 'execute_deferred_paused_stale',
        data: warning,
      });
    } catch (error) {
      logger.debug('Failed to emit stale EXECUTE deferral notification', {
        project_id: project.id,
        batch_id: batchId,
        err: error.message,
      });
    }

    return warning;
  }

  return {
    ExecuteDeferredPausedError,
    deferExecutePlanTaskIfProjectPaused,
    getLatestExecutePausedDeferral,
    hasExecuteDeferralFollowup,
    logExecuteDeferredResume,
    normalizePlanTaskNumber,
    getDeferredRemainingPlanTaskNumber,
    getNextExecutablePlanTask,
    inspectExecuteDeferredResume,
    logExecuteDeferredPausedStaleWarning,
    maybeRejectResumedDeferredPlan,
    maybeWarnStaleExecuteDeferral,
  };
}

module.exports = { createExecuteDeferral };
