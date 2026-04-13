'use strict';

const fs = require('fs');
const path = require('path');
const {
  LOOP_STATES,
  TRANSITIONS,
  getNextState,
  isValidState,
  getGatesForTrustLevel,
} = require('./loop-states');
const database = require('../database');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const architectRunner = require('../factory/architect-runner');
const guardrailRunner = require('../factory/guardrail-runner');
const { createPlanFileIntake } = require('./plan-file-intake');
const { createShippedDetector } = require('./shipped-detector');
const logger = require('../logger').child({ component: 'loop-controller' });

const WORK_ITEM_STATUS_ORDER = Object.freeze([
  'executing',
  'verifying',
  'planned',
  'prioritized',
  'in_progress',
  'pending',
  'triaged',
  'intake',
]);

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

function resolvePlansRepoRoot(projectPath, plansDir) {
  const candidates = [];

  if (projectPath) {
    candidates.push(path.resolve(projectPath));
  }

  if (plansDir) {
    let current = path.resolve(plansDir);
    while (current && !candidates.includes(current)) {
      candidates.push(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, '.git'))) {
      return candidate;
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'server'))) {
      return candidate;
    }
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) || path.resolve(plansDir || projectPath || process.cwd());
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
  const project = getProjectOrThrow(project_id);
  const summary = factoryHealth.getProjectHealthSummary(project_id);

  if (project.config && project.config.plans_dir) {
    const db = database.getDbInstance();
    const shippedDetector = createShippedDetector({
      repoRoot: resolvePlansRepoRoot(project.path, project.config.plans_dir),
    });
    const planIntake = createPlanFileIntake({ db, factoryIntake, shippedDetector });
    const result = planIntake.scan({
      project_id: project.id,
      plans_dir: project.config.plans_dir,
    });
    logger.info(
      `SENSE: scanned ${result.scanned} plan files - ${result.created.length} new, ${result.shipped_count} shipped, ${result.skipped.length} skipped`,
      { project_id }
    );
  }

  logger.info('SENSE stage executed', { project_id });
  return summary;
}

function getLoopWorkItem(project_id) {
  const items = factoryIntake.listOpenWorkItems({ project_id, limit: 100 });
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  for (const status of WORK_ITEM_STATUS_ORDER) {
    const match = items.find((item) => item && item.status === status);
    if (match) {
      return match;
    }
  }

  return items[0] || null;
}

function getPostStageTransition(currentState, trustLevel) {
  const pendingState = getNextState(currentState, trustLevel, 'pending');
  if (pendingState === LOOP_STATES.PAUSED) {
    return {
      next_state: LOOP_STATES.PAUSED,
      paused_at_stage: TRANSITIONS[currentState] || null,
    };
  }

  return {
    next_state: getNextState(currentState, trustLevel, 'approved'),
    paused_at_stage: null,
  };
}

async function awaitTaskToStructuredResult(handleAwaitTask, taskCore, args) {
  const awaitResult = await handleAwaitTask(args);
  const task = taskCore.getTask(args.task_id);

  if (!task) {
    return {
      status: 'failed',
      verify_status: 'failed',
      error: awaitResult?.content?.[0]?.text || `Task not found after await: ${args.task_id}`,
      task_id: args.task_id,
    };
  }

  return {
    status: task.status,
    verify_status: task.status === 'completed' ? 'passed' : 'failed',
    error: task.error_output || null,
    task_id: task.id,
  };
}

async function executePlanStage(project) {
  let workItem = getLoopWorkItem(project.id);

  if (workItem?.origin?.plan_path && fs.existsSync(workItem.origin.plan_path)) {
    workItem = factoryIntake.updateWorkItem(workItem.id, { status: 'executing' });
    logger.info('PLAN stage: pre-written plan detected, skipping architect', {
      project_id: project.id,
      work_item_id: workItem.id,
      plan_path: workItem.origin.plan_path,
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
  workItem = getLoopWorkItem(project.id);
  if (workItem && workItem.status !== 'planned') {
    workItem = factoryIntake.updateWorkItem(workItem.id, { status: 'planned' });
  }

  logger.info('PLAN stage: architect cycle completed', {
    project_id: project.id,
    cycle_id: cycle?.id ?? null,
    work_item_id: workItem?.id ?? null,
  });

  return {
    skip_to_execute: false,
    reason: 'architect cycle completed',
    work_item: workItem,
    stage_result: cycle,
  };
}

async function executePlanFileStage(project, workItem) {
  const targetItem = workItem || getLoopWorkItem(project.id);
  if (!targetItem?.origin?.plan_path || !fs.existsSync(targetItem.origin.plan_path)) {
    return null;
  }

  const { createPlanExecutor } = require('./plan-executor');
  const { handleSmartSubmitTask } = require('../handlers/integration/routing');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');

  const executor = createPlanExecutor({
    submit: async (args) => {
      const result = await handleSmartSubmitTask(args);
      if (!result?.task_id) {
        throw new Error(result?.content?.[0]?.text || 'smart_submit_task did not return task_id');
      }
      return { task_id: result.task_id };
    },
    awaitTask: (args) => awaitTaskToStructuredResult(handleAwaitTask, taskCore, args),
    projectDefaults: project.config || {},
  });

  const result = await executor.execute({
    plan_path: targetItem.origin.plan_path,
    project: project.name,
    working_directory: project.path,
  });

  if (result.failed_task) {
    factoryIntake.updateWorkItem(targetItem.id, {
      status: 'in_progress',
      reject_reason: `task_${result.failed_task}_failed`,
    });
    logger.warn('EXECUTE stage: plan executor stopped on failed task', {
      project_id: project.id,
      work_item_id: targetItem.id,
      failed_task: result.failed_task,
      plan_path: targetItem.origin.plan_path,
    });
    return {
      next_state: LOOP_STATES.IDLE,
      paused_at_stage: null,
      reason: `task ${result.failed_task} failed`,
      stage_result: result,
    };
  }

  factoryIntake.updateWorkItem(targetItem.id, { status: 'verifying' });
  logger.info('EXECUTE stage: plan executor completed successfully', {
    project_id: project.id,
    work_item_id: targetItem.id,
    completed_tasks: result.completed_tasks,
  });

  return {
    ...getPostStageTransition(LOOP_STATES.EXECUTE, project.trust_level),
    reason: 'plan execution completed',
    stage_result: result,
  };
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

function attachBatchId(project_id, batch_id) {
  if (!project_id) {
    throw new Error('project_id is required');
  }
  if (!batch_id || typeof batch_id !== 'string') {
    throw new Error('batch_id must be a non-empty string');
  }
  const project = getProjectOrThrow(project_id);
  const currentState = getCurrentLoopState(project);
  if (currentState !== LOOP_STATES.PLAN && currentState !== LOOP_STATES.EXECUTE) {
    throw new Error(
      `Cannot attach batch_id while loop is in ${currentState}; must be PLAN or EXECUTE`
    );
  }
  factoryHealth.updateProject(project.id, {
    loop_batch_id: batch_id,
    loop_last_action_at: nowIso(),
  });
  logger.info('Factory loop batch_id attached', {
    project_id: project.id,
    batch_id,
    state: currentState,
  });
  return {
    project_id: project.id,
    loop_batch_id: batch_id,
    state: currentState,
  };
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
  let nextState = pendingState === LOOP_STATES.PAUSED
    ? LOOP_STATES.PAUSED
    : getNextState(currentState, project.trust_level, 'approved');
  let pausedAtStage = nextState === LOOP_STATES.PAUSED
    ? TRANSITIONS[currentState] || null
    : null;

  // Execute stage-specific logic before transitioning
  let stageResult = null;
  let transitionReason = null;
  let executeStageRan = false;

  if (currentState === LOOP_STATES.PRIORITIZE || nextState === LOOP_STATES.PLAN) {
    const planStage = await executePlanStage(project);
    if (planStage?.stage_result) {
      stageResult = planStage.stage_result;
    }
    if (planStage?.reason) {
      transitionReason = planStage.reason;
    }
    if (planStage?.skip_to_execute) {
      nextState = LOOP_STATES.EXECUTE;
      pausedAtStage = null;
    }
  } else if (currentState === LOOP_STATES.PLAN || currentState === LOOP_STATES.EXECUTE) {
    const executeStage = await executePlanFileStage(project);
    if (executeStage) {
      executeStageRan = true;
      stageResult = executeStage.stage_result;
      nextState = executeStage.next_state;
      pausedAtStage = executeStage.paused_at_stage || null;
      transitionReason = executeStage.reason;
    }
  }

  if (currentState === LOOP_STATES.LEARN && nextState === LOOP_STATES.IDLE) {
    const cfg = project.config_json ? (() => { try { return JSON.parse(project.config_json); } catch { return {}; } })() : {};
    if (cfg && cfg.loop && cfg.loop.auto_continue === true) {
      nextState = LOOP_STATES.SENSE;
      pausedAtStage = null;
    }
  }

  if (!executeStageRan && (nextState === LOOP_STATES.VERIFY || currentState === LOOP_STATES.EXECUTE)) {
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
    reason: transitionReason,
  });

  return {
    project_id: project.id,
    previous_state: currentState,
    new_state: nextState,
    paused_at_stage: pausedAtStage,
    stage_result: stageResult,
    reason: transitionReason,
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
  attachBatchId,
};
