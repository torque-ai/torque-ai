'use strict';

const DECISION_STAGE_ACTORS = Object.freeze({
  sense: 'health_model',
  prioritize: 'architect',
  plan: 'planner',
  plan_review: 'reviewer',
  execute: 'executor',
  verify: 'verifier',
  learn: 'verifier',
});

function normalizeDecisionStage(stage) {
  if (!stage || typeof stage !== 'string') {
    return null;
  }
  const normalized = stage.toLowerCase();
  return DECISION_STAGE_ACTORS[normalized] ? normalized : null;
}

function getDecisionActor(stage, actor) {
  const normalizedStage = normalizeDecisionStage(stage);
  if (actor) {
    return actor;
  }
  return normalizedStage ? DECISION_STAGE_ACTORS[normalizedStage] : null;
}

function getDecisionBatchId(project, workItem, explicitBatchId, instance = null) {
  return explicitBatchId
    || workItem?.batch_id
    || instance?.batch_id
    || project?.loop_batch_id
    || null;
}

function getFactorySubmissionBatchId(project, workItem, instance = null) {
  return getDecisionBatchId(project, workItem, null, instance)
    || (project?.id && workItem?.id != null ? `factory-${project.id}-${workItem.id}` : null);
}

function getWorkItemDecisionContext(workItem) {
  if (!workItem) {
    return {
      work_item_id: null,
      priority: null,
      work_item_status: null,
      work_item_source: null,
      plan_path: null,
    };
  }

  return {
    work_item_id: workItem.id ?? null,
    priority: workItem.priority ?? null,
    work_item_status: workItem.status || null,
    work_item_source: workItem.source || null,
    plan_path: workItem.origin?.plan_path || null,
  };
}

function buildLoopAdvanceResult({
  project,
  instance,
  instance_id = null,
  previousState,
  newState,
  pausedAtStage,
  stageResult = null,
  reason = null,
}) {
  return {
    project_id: project.id,
    instance_id: instance?.id ?? instance_id,
    previous_state: previousState,
    new_state: newState,
    paused_at_stage: pausedAtStage,
    stage_result: stageResult,
    reason,
  };
}

function createStageSharedContext(overrides = {}) {
  return Object.freeze({
    buildLoopAdvanceResult,
    getDecisionActor,
    getDecisionBatchId,
    getFactorySubmissionBatchId,
    getWorkItemDecisionContext,
    normalizeDecisionStage,
    ...overrides,
  });
}

module.exports = {
  DECISION_STAGE_ACTORS,
  buildLoopAdvanceResult,
  createStageSharedContext,
  getDecisionActor,
  getDecisionBatchId,
  getFactorySubmissionBatchId,
  getWorkItemDecisionContext,
  normalizeDecisionStage,
};
