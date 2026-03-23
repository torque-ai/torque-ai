'use strict';

const engine = require('./engine');
const shadowEnforcer = require('./shadow-enforcer');
const logger = require('../logger').child({ component: 'policy-task-hooks' });

function evaluateAtStage(stage, taskData, options = {}) {
  if (!shadowEnforcer.isEngineEnabled()) {
    return { skipped: true, reason: 'policy_engine_disabled' };
  }

  const targetType = options.target_type
    || options.targetType
    || taskData.target_type
    || taskData.targetType
    || 'task';
  const targetId = options.target_id
    || options.targetId
    || taskData.target_id
    || taskData.targetId
    || taskData.id
    || taskData.taskId
    || 'unknown';

  const context = {
    stage,
    target_type: targetType,
    target_id: targetId,
    project_id: taskData.project || taskData.project_id || null,
    project_path: taskData.working_directory || taskData.workingDirectory || null,
    provider: taskData.provider || null,
    changed_files: taskData.changed_files || taskData.changedFiles || null,
    command: taskData.command || null,
    release_id: taskData.release_id || taskData.releaseId || null,
    evidence: taskData.evidence || {},
    persist: true,
  };

  try {
    const result = engine.evaluatePolicies(context);
    if (shadowEnforcer.isShadowOnly()) {
      if (result.summary.failed > 0 || result.summary.warned > 0) {
        logger.info(`[Shadow] ${stage}: ${result.summary.failed} fail, ${result.summary.warned} warn (non-blocking)`);
      }
      return { ...result, shadow: true, blocked: false };
    }

    try {
      const { applyActiveEffects } = require('./active-effects');
      const effectResult = applyActiveEffects(result, taskData);
      if (effectResult.applied.length > 0) {
        result.activeEffectsApplied = effectResult.applied;
      }
    } catch {
      // Active effects are non-critical
    }

    const blocked = result.summary.blocked > 0;
    return { ...result, shadow: false, blocked };
  } catch (err) {
    logger.warn(`Policy evaluation error at ${stage}: ${err.message}`);
    return { skipped: true, reason: 'evaluation_error', error: err.message };
  }
}

function onTaskSubmit(taskData) {
  return evaluateAtStage('task_submit', taskData);
}

function evaluateTaskSubmissionPolicy(taskData) {
  return onTaskSubmit(taskData);
}

function onTaskPreExecute(taskData) {
  return evaluateAtStage('task_pre_execute', taskData);
}

function onTaskComplete(taskData) {
  return evaluateAtStage('task_complete', taskData);
}

function onManualReview(taskData) {
  return evaluateAtStage('manual_review', taskData, {
    target_type: taskData.target_type || taskData.targetType || 'release',
    target_id: taskData.release_id
      || taskData.releaseId
      || taskData.target_id
      || taskData.targetId
      || taskData.id
      || taskData.taskId
      || 'unknown',
  });
}

module.exports = {
  evaluateAtStage,
  evaluateTaskSubmissionPolicy,
  onTaskSubmit,
  onTaskPreExecute,
  onTaskComplete,
  onManualReview,
};
