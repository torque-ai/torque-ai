'use strict';

const {
  LOOP_STATES,
  TRANSITIONS,
  getNextState,
  isValidState,
  getGatesForTrustLevel,
} = require('./loop-states');
const factoryHealth = require('../db/factory-health');
const architectRunner = require('../factory/architect-runner');
const guardrailRunner = require('../factory/guardrail-runner');
const logger = require('../logger').child({ component: 'loop-controller' });

function nowIso() {
  return new Date().toISOString();
}

function getProjectOrThrow(project_id) {
  const project = factoryHealth.getProject(project_id);
  if (!project) {
    throw new Error(`Project not found: ${project_id}`);
  }
  return project;
}

function getCurrentLoopState(project) {
  const raw = project.loop_state || 'IDLE';
  const loopState = raw.toUpperCase();
  if (!isValidState(loopState)) {
    throw new Error(`Invalid loop state for project ${project.id}: ${String(raw)}`);
  }
  return loopState;
}

function assertValidGateStage(stage) {
  if (!isValidState(stage) || stage === LOOP_STATES.IDLE || stage === LOOP_STATES.PAUSED) {
    throw new Error(`Invalid gate stage: ${String(stage)}`);
  }
}

function assertPausedAtStage(project, stage) {
  const currentState = getCurrentLoopState(project);
  if (currentState !== LOOP_STATES.PAUSED) {
    throw new Error('Loop is not paused');
  }

  if (!project.loop_paused_at_stage) {
    throw new Error('Loop has no pending approval stage');
  }

  if (project.loop_paused_at_stage !== stage) {
    throw new Error(`Loop is paused at ${project.loop_paused_at_stage}, not ${stage}`);
  }
}

function executeSenseStage(project_id) {
  const summary = factoryHealth.getProjectHealthSummary(project_id);
  logger.info('SENSE stage executed', { project_id });
  return summary;
}

async function executeVerifyStage(project_id, batch_id) {
  if (!batch_id) {
    logger.info('VERIFY stage: no batch_id, skipping guardrail checks', { project_id });
    return { status: 'skipped', reason: 'no_batch_id' };
  }
  try {
    const result = guardrailRunner.runPostBatchChecks(project_id, batch_id, []);
    logger.info('VERIFY stage: guardrail checks complete', { project_id, batch_id, result });
    return result;
  } catch (err) {
    logger.warn(`VERIFY stage guardrail check failed: ${err.message}`, { project_id });
    return { status: 'error', error: err.message };
  }
}

async function executeLearnStage(project_id, batch_id) {
  try {
    const feedback = require('./feedback');
    const analysis = feedback.analyzeBatch(project_id, batch_id);
    logger.info('LEARN stage: batch analysis complete', { project_id, batch_id });
    return analysis;
  } catch (err) {
    logger.warn(`LEARN stage analysis failed: ${err.message}`, { project_id });
    return { status: 'error', error: err.message };
  }
}

function scheduleLoop(project_id, interval_minutes) {
  const project = getProjectOrThrow(project_id);
  const config = project.config_json ? JSON.parse(project.config_json) : {};
  config.loop_schedule = { interval_minutes, enabled: true };
  factoryHealth.updateProject(project.id, {
    config_json: JSON.stringify(config),
  });
  logger.info('Factory loop scheduled', { project_id, interval_minutes });
  return { project_id, interval_minutes, message: `Loop scheduled every ${interval_minutes} minutes` };
}

function startLoop(project_id) {
  const project = getProjectOrThrow(project_id);

  factoryHealth.updateProject(project.id, {
    loop_state: LOOP_STATES.SENSE,
    loop_batch_id: null,
    loop_last_action_at: nowIso(),
    loop_paused_at_stage: null,
  });

  executeSenseStage(project.id);

  logger.info('Factory loop started', {
    project_id: project.id,
    state: LOOP_STATES.SENSE,
  });

  return {
    project_id: project.id,
    state: LOOP_STATES.SENSE,
    message: 'Factory loop started',
  };
}

async function advanceLoop(project_id) {
  const project = getProjectOrThrow(project_id);
  const currentState = getCurrentLoopState(project);

  if (currentState === LOOP_STATES.IDLE) {
    throw new Error('Loop not started for this project');
  }

  if (currentState === LOOP_STATES.PAUSED) {
    throw new Error('Loop is paused — use approveGate to continue');
  }

  const pendingState = getNextState(currentState, project.trust_level, 'pending');
  const nextState = pendingState === LOOP_STATES.PAUSED
    ? LOOP_STATES.PAUSED
    : getNextState(currentState, project.trust_level, 'approved');
  const pausedAtStage = nextState === LOOP_STATES.PAUSED
    ? TRANSITIONS[currentState] || null
    : null;

  // Execute stage-specific logic before transitioning
  let stageResult = null;
  if (nextState === LOOP_STATES.VERIFY || currentState === LOOP_STATES.EXECUTE) {
    stageResult = await executeVerifyStage(project.id, project.loop_batch_id);
  } else if (nextState === LOOP_STATES.LEARN || currentState === LOOP_STATES.VERIFY) {
    stageResult = await executeLearnStage(project.id, project.loop_batch_id);
  }

  factoryHealth.updateProject(project.id, {
    loop_state: nextState,
    loop_last_action_at: nowIso(),
    loop_paused_at_stage: pausedAtStage,
  });

  logger.info('Factory loop advanced', {
    project_id: project.id,
    previous_state: currentState,
    new_state: nextState,
    paused_at_stage: pausedAtStage,
  });

  return {
    project_id: project.id,
    previous_state: currentState,
    new_state: nextState,
    paused_at_stage: pausedAtStage,
    stage_result: stageResult,
  };
}

function approveGate(project_id, stage) {
  const project = getProjectOrThrow(project_id);
  assertValidGateStage(stage);
  assertPausedAtStage(project, stage);

  factoryHealth.updateProject(project.id, {
    loop_state: stage,
    loop_paused_at_stage: null,
    loop_last_action_at: nowIso(),
  });

  logger.info('Factory gate approved', {
    project_id: project.id,
    state: stage,
  });

  return {
    project_id: project.id,
    state: stage,
    message: 'Gate approved, loop continuing',
  };
}

function rejectGate(project_id, stage) {
  const project = getProjectOrThrow(project_id);
  assertValidGateStage(stage);
  assertPausedAtStage(project, stage);

  factoryHealth.updateProject(project.id, {
    loop_state: LOOP_STATES.IDLE,
    loop_paused_at_stage: null,
    loop_last_action_at: nowIso(),
  });

  logger.info('Factory gate rejected', {
    project_id: project.id,
    rejected_stage: stage,
    state: LOOP_STATES.IDLE,
  });

  return {
    project_id: project.id,
    state: LOOP_STATES.IDLE,
    message: 'Gate rejected, loop stopped',
  };
}

function getLoopState(project_id) {
  const project = getProjectOrThrow(project_id);
  const loopState = getCurrentLoopState(project);

  return {
    project_id: project.id,
    loop_state: loopState,
    loop_batch_id: project.loop_batch_id || null,
    loop_last_action_at: project.loop_last_action_at || null,
    loop_paused_at_stage: project.loop_paused_at_stage || null,
    trust_level: project.trust_level,
    gates: getGatesForTrustLevel(project.trust_level),
  };
}

module.exports = {
  startLoop,
  advanceLoop,
  approveGate,
  rejectGate,
  getLoopState,
  scheduleLoop,
};
