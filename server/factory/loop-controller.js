'use strict';

const fs = require('fs');
const path = require('path');
const {
  LOOP_STATES,
  TRANSITIONS,
  getNextState,
  getPendingGateStage,
  getResumeStateForApprovedGate,
  isValidState,
  getGatesForTrustLevel,
} = require('./loop-states');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const architectRunner = require('../factory/architect-runner');
const guardrailRunner = require('../factory/guardrail-runner');
const { logDecision } = require('./decision-log');
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

const DECISION_STAGE_ACTORS = Object.freeze({
  sense: 'health_model',
  prioritize: 'architect',
  plan: 'planner',
  execute: 'executor',
  verify: 'verifier',
  learn: 'verifier',
});

const PRIORITIZE_SOURCE_BASE_SCORES = Object.freeze({
  plan_file: 82,
  manual: 76,
  api: 72,
  webhook: 72,
  github_issue: 68,
  github: 68,
  conversation: 64,
  conversational: 64,
  ci: 60,
  scheduled_scan: 56,
  scout: 56,
  self_generated: 52,
});

const SELECTED_WORK_ITEM_DECISION_ACTIONS = Object.freeze([
  'starting',
  'skipped_for_plan_file',
  'selected_work_item',
  'scored_work_item',
  'generated_plan',
]);

const selectedWorkItemIds = new Map();

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

function getDecisionBatchId(project, workItem, explicitBatchId) {
  return explicitBatchId || workItem?.batch_id || project?.loop_batch_id || null;
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

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeWorkItemId(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function rememberSelectedWorkItem(project_id, workItem) {
  const workItemId = normalizeWorkItemId(workItem?.id ?? workItem);
  if (!project_id || !workItemId) {
    selectedWorkItemIds.delete(project_id);
    return null;
  }

  selectedWorkItemIds.set(project_id, workItemId);
  return workItemId;
}

function clearSelectedWorkItem(project_id) {
  if (!project_id) {
    return;
  }
  selectedWorkItemIds.delete(project_id);
}

function getSelectedWorkItemIdFromDecisionLog(project_id) {
  const db = database.getDbInstance();
  if (!db) {
    return null;
  }

  try {
    const placeholders = SELECTED_WORK_ITEM_DECISION_ACTIONS.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT inputs_json, outcome_json
      FROM factory_decisions
      WHERE project_id = ?
        AND action IN (${placeholders})
      ORDER BY id DESC
      LIMIT 20
    `).all(project_id, ...SELECTED_WORK_ITEM_DECISION_ACTIONS);

    for (const row of rows) {
      const inputs = parseJsonObject(row.inputs_json);
      const outcome = parseJsonObject(row.outcome_json);
      const workItemId = normalizeWorkItemId(
        outcome?.work_item_id
        ?? inputs?.work_item_id
      );
      if (workItemId) {
        return workItemId;
      }
    }
  } catch (error) {
    logger.debug({ err: error.message, project_id }, 'Unable to restore selected work item from decision log');
  }

  return null;
}

function getSelectedWorkItemId(project_id) {
  const remembered = selectedWorkItemIds.get(project_id);
  if (remembered) {
    return remembered;
  }

  const restored = getSelectedWorkItemIdFromDecisionLog(project_id);
  if (restored) {
    selectedWorkItemIds.set(project_id, restored);
  }
  return restored;
}

function getSelectedWorkItem(project_id, { fallbackToLoopSelection = false } = {}) {
  const selectedWorkItemId = getSelectedWorkItemId(project_id);
  if (selectedWorkItemId) {
    const workItem = factoryIntake.getWorkItemForProject(project_id, selectedWorkItemId, {
      includeClosed: true,
    });
    if (!workItem) {
      throw new Error(`Selected work item ${selectedWorkItemId} is no longer available for project ${project_id}`);
    }
    return workItem;
  }

  return fallbackToLoopSelection ? getLoopWorkItem(project_id) : null;
}

function tryGetSelectedWorkItem(project_id, options = {}) {
  try {
    return getSelectedWorkItem(project_id, options);
  } catch (error) {
    logger.debug({ err: error.message, project_id }, 'Unable to resolve selected work item');
    return null;
  }
}

function safeLogDecision(entry) {
  const normalizedStage = normalizeDecisionStage(entry?.stage);
  const actor = getDecisionActor(normalizedStage, entry?.actor);
  if (!normalizedStage || !actor || !entry?.action) {
    return null;
  }

  try {
    const db = database.getDbInstance();
    if (db) {
      factoryDecisions.setDb(db);
    }

    return logDecision({
      ...entry,
      stage: normalizedStage,
      actor,
    });
  } catch (error) {
    logger.warn(
      {
        err: error.message,
        project_id: entry?.project_id,
        stage: normalizedStage,
        action: entry?.action,
      },
      'Failed to log factory decision'
    );
    return null;
  }
}

function logTransitionDecision({
  project,
  currentState,
  nextState,
  pausedAtStage,
  reason,
  workItem,
  batchId,
}) {
  const effectiveBatchId = getDecisionBatchId(project, workItem, batchId);

  if (nextState === LOOP_STATES.PAUSED) {
    safeLogDecision({
      project_id: project.id,
      stage: pausedAtStage,
      actor: 'human',
      action: 'paused_at_gate',
      reasoning: `Loop paused awaiting approval for ${pausedAtStage}.`,
      inputs: {
        previous_state: currentState,
        trust_level: project.trust_level,
      },
      outcome: {
        from_state: currentState,
        to_state: nextState,
        gate_stage: pausedAtStage || null,
        reason: reason || null,
        ...getWorkItemDecisionContext(workItem),
      },
      confidence: 1,
      batch_id: effectiveBatchId,
    });
    return;
  }

  if (nextState === LOOP_STATES.EXECUTE && currentState !== LOOP_STATES.EXECUTE) {
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'started_execution',
      reasoning: `Loop advanced into ${LOOP_STATES.EXECUTE}.`,
      inputs: {
        previous_state: currentState,
        trust_level: project.trust_level,
      },
      outcome: {
        from_state: currentState,
        to_state: nextState,
        reason: reason || null,
        batch_id: effectiveBatchId,
        ...getWorkItemDecisionContext(workItem),
      },
      confidence: 1,
      batch_id: effectiveBatchId,
    });
    return;
  }

  if (nextState === LOOP_STATES.VERIFY && currentState === LOOP_STATES.EXECUTE) {
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.VERIFY,
      action: 'entered_from_execute',
      reasoning: `Loop advanced from ${currentState} to ${nextState}.`,
      inputs: {
        previous_state: currentState,
        trust_level: project.trust_level,
      },
      outcome: {
        from_state: currentState,
        to_state: nextState,
        paused_at_stage: pausedAtStage || null,
        reason: reason || null,
        batch_id: effectiveBatchId,
        ...getWorkItemDecisionContext(workItem),
      },
      confidence: 1,
      batch_id: effectiveBatchId,
    });
    return;
  }

  safeLogDecision({
    project_id: project.id,
    stage: currentState,
    action: `advance_from_${String(currentState).toLowerCase()}`,
    reasoning: `Loop advanced from ${currentState} to ${nextState}.`,
    inputs: {
      previous_state: currentState,
      trust_level: project.trust_level,
    },
    outcome: {
      from_state: currentState,
      to_state: nextState,
      paused_at_stage: pausedAtStage || null,
      reason: reason || null,
      batch_id: effectiveBatchId,
      ...getWorkItemDecisionContext(workItem),
    },
    confidence: 1,
    batch_id: effectiveBatchId,
  });
}

function executeSenseStage(project_id) {
  const project = getProjectOrThrow(project_id);
  const summary = factoryHealth.getProjectHealthSummary(project_id);
  const scanSummary = {
    plans_dir: project.config?.plans_dir || null,
    scanned: 0,
    created_count: 0,
    shipped_count: 0,
    skipped_count: 0,
  };

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
    scanSummary.scanned = result.scanned;
    scanSummary.created_count = result.created.length;
    scanSummary.shipped_count = result.shipped_count;
    scanSummary.skipped_count = result.skipped.length;
    logger.info(
      `SENSE: scanned ${result.scanned} plan files - ${result.created.length} new, ${result.shipped_count} shipped, ${result.skipped.length} skipped`,
      { project_id }
    );
  }

  safeLogDecision({
    project_id,
    stage: LOOP_STATES.SENSE,
    action: 'scanned_plans',
    reasoning: scanSummary.plans_dir
      ? 'SENSE stage scanned the configured plans directory.'
      : 'SENSE stage completed without a configured plans directory.',
    inputs: {
      plans_dir: scanSummary.plans_dir,
    },
    outcome: {
      ...scanSummary,
      balance: summary?.balance ?? null,
      dimension_count: summary?.dimension_count ?? 0,
      weakest_dimension: summary?.weakest_dimension || null,
    },
    confidence: 1,
    batch_id: project.loop_batch_id || null,
  });

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

function tryGetLoopWorkItem(project_id) {
  try {
    return getLoopWorkItem(project_id);
  } catch (error) {
    logger.debug({ err: error.message, project_id }, 'Unable to resolve loop work item for decision context');
    return null;
  }
}

function getCreatedAtValue(item) {
  const createdAt = item?.created_at ? Date.parse(item.created_at) : Number.NaN;
  if (Number.isFinite(createdAt)) {
    return createdAt;
  }

  const numericId = Number(item?.id);
  return Number.isFinite(numericId) ? numericId : Number.MAX_SAFE_INTEGER;
}

function compareByIntakeOrder(left, right) {
  const leftCreatedAt = getCreatedAtValue(left);
  const rightCreatedAt = getCreatedAtValue(right);

  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }

  const leftId = Number(left?.id);
  const rightId = Number(right?.id);
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return leftId - rightId;
  }

  return String(left?.id || '').localeCompare(String(right?.id || ''));
}

function clampPriority(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return factoryIntake.normalizePriority(undefined);
  }

  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function scoreWorkItemForPrioritize(workItem, openItems = []) {
  if (!workItem) {
    return null;
  }

  const oldPriority = factoryIntake.normalizePriority(
    workItem.priority,
    factoryIntake.normalizePriority(undefined)
  );
  const sourceBase = PRIORITIZE_SOURCE_BASE_SCORES[workItem.source] ?? 62;
  const createdAt = getCreatedAtValue(workItem);
  const ageMs = Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) : 0;
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const ageBoost = Math.min(12, ageDays);

  const intakeOrder = openItems
    .slice()
    .sort(compareByIntakeOrder)
    .findIndex((item) => item?.id === workItem.id);
  const intakeIndex = intakeOrder === -1 ? openItems.length : intakeOrder;
  const backlogBoost = Math.max(0, Math.min(6, openItems.length - intakeIndex - 1));

  const newPriority = clampPriority(sourceBase + ageBoost + backlogBoost);

  return {
    oldPriority,
    newPriority,
    scoreReason: `source=${workItem.source || 'unknown'} base=${sourceBase}; age_days=${ageDays}; intake_order=${intakeIndex + 1}/${Math.max(openItems.length, 1)}`,
  };
}

function executePrioritizeStage(project, selectedWorkItem = null) {
  const openItems = factoryIntake.listOpenWorkItems({ project_id: project.id, limit: 100 });
  const workItem = selectedWorkItem || getLoopWorkItem(project.id);

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.PRIORITIZE,
    action: 'selected_work_item',
    reasoning: workItem
      ? 'PRIORITIZE selected the highest-priority open work item.'
      : 'PRIORITIZE found no open work item to select.',
    outcome: {
      selection_status: workItem ? 'selected' : 'not_found',
      ...getWorkItemDecisionContext(workItem),
    },
    confidence: 1,
    batch_id: getDecisionBatchId(project, workItem),
  });

  if (!workItem) {
    clearSelectedWorkItem(project.id);
    return {
      work_item: null,
      reason: 'no open work item selected',
      stage_result: null,
    };
  }

  const scoring = scoreWorkItemForPrioritize(workItem, openItems);
  const updatedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
    priority: scoring.newPriority,
  });
  rememberSelectedWorkItem(project.id, updatedWorkItem);

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.PRIORITIZE,
    action: 'scored_work_item',
    reasoning: 'PRIORITIZE rescored the selected work item before planning.',
    inputs: {
      open_work_item_count: openItems.length,
    },
    outcome: {
      work_item_id: updatedWorkItem.id,
      old_priority: scoring.oldPriority,
      new_priority: updatedWorkItem.priority,
      score_reason: scoring.scoreReason,
      ...getWorkItemDecisionContext(updatedWorkItem),
    },
    confidence: 1,
    batch_id: getDecisionBatchId(project, updatedWorkItem),
  });

  return {
    work_item: updatedWorkItem,
    reason: 'scored selected work item',
    stage_result: {
      work_item_id: updatedWorkItem.id,
      old_priority: scoring.oldPriority,
      new_priority: updatedWorkItem.priority,
      score_reason: scoring.scoreReason,
    },
  };
}

function getPostStageTransition(currentState, trustLevel) {
  const pendingGateStage = getPendingGateStage(currentState, trustLevel);
  if (pendingGateStage) {
    return {
      next_state: LOOP_STATES.PAUSED,
      paused_at_stage: pendingGateStage,
    };
  }

  return {
    next_state: getNextState(currentState, trustLevel, 'approved'),
    paused_at_stage: null,
  };
}

function shouldDryRunExecute(project) {
  return project?.trust_level === 'supervised' && project?.config?.execute_live !== true;
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

async function executePlanStage(project, selectedWorkItem = null) {
  let workItem = selectedWorkItem || getSelectedWorkItem(project.id, {
    fallbackToLoopSelection: true,
  });

  if (workItem) {
    rememberSelectedWorkItem(project.id, workItem);
  }

  if (workItem?.origin?.plan_path && fs.existsSync(workItem.origin.plan_path)) {
    workItem = factoryIntake.updateWorkItem(workItem.id, { status: 'executing' });
    rememberSelectedWorkItem(project.id, workItem);
    logger.info('PLAN stage: pre-written plan detected, skipping architect', {
      project_id: project.id,
      work_item_id: workItem.id,
      plan_path: workItem.origin.plan_path,
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.PLAN,
      action: 'skipped_for_plan_file',
      reasoning: 'pre-written plan detected',
      inputs: {
        ...getWorkItemDecisionContext(workItem),
      },
      outcome: {
        architect_skipped: true,
        reason: 'pre-written plan detected',
        ...getWorkItemDecisionContext(workItem),
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, workItem),
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
  workItem = getSelectedWorkItem(project.id, { fallbackToLoopSelection: true });
  if (workItem && workItem.status !== 'planned') {
    workItem = factoryIntake.updateWorkItem(workItem.id, { status: 'planned' });
    rememberSelectedWorkItem(project.id, workItem);
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
    batch_id: getDecisionBatchId(project, workItem),
  });

  return {
    skip_to_execute: false,
    reason: 'architect cycle completed',
    work_item: workItem,
    stage_result: cycle,
  };
}

async function executePlanFileStage(project, workItem) {
  const targetItem = workItem || getSelectedWorkItem(project.id, {
    fallbackToLoopSelection: true,
  });
  if (!targetItem?.origin?.plan_path || !fs.existsSync(targetItem.origin.plan_path)) {
    return null;
  }
  rememberSelectedWorkItem(project.id, targetItem);

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.EXECUTE,
    action: 'starting',
    reasoning: 'EXECUTE stage started for the selected work item.',
    inputs: {
      ...getWorkItemDecisionContext(targetItem),
    },
    outcome: {
      ...getWorkItemDecisionContext(targetItem),
    },
    confidence: 1,
    batch_id: getDecisionBatchId(project, targetItem),
  });

  const { createPlanExecutor } = require('./plan-executor');
  const { handleSmartSubmitTask } = require('../handlers/integration/routing');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');
  const dry_run = shouldDryRunExecute(project);
  const decisionBatchId = getDecisionBatchId(project, targetItem);

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
    onDryRunTask: dry_run ? async ({ task, prompt, file_paths }) => {
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'dry_run_task',
        reasoning: `dry-run recorded task ${task.task_number} without submission`,
        inputs: {
          ...getWorkItemDecisionContext(targetItem),
          dry_run: true,
          task_number: task.task_number,
          task_title: task.task_title,
        },
        outcome: {
          plan_path: targetItem.origin.plan_path,
          dry_run: true,
          simulated: true,
          task_number: task.task_number,
          task_title: task.task_title,
          planned_task_description: prompt,
          file_paths,
        },
        confidence: 1,
        batch_id: decisionBatchId,
      });
    } : null,
  });

  const result = await executor.execute({
    plan_path: targetItem.origin.plan_path,
    project: project.name,
    working_directory: project.path,
    dry_run,
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
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'execution_failed',
      reasoning: `task ${result.failed_task} failed`,
      inputs: {
        ...getWorkItemDecisionContext(targetItem),
      },
      outcome: {
        failed_task: result.failed_task,
        final_state: LOOP_STATES.IDLE,
        plan_path: targetItem.origin.plan_path,
      },
      confidence: 1,
      batch_id: decisionBatchId,
    });
    return {
      next_state: LOOP_STATES.IDLE,
      paused_at_stage: null,
      reason: `task ${result.failed_task} failed`,
      stage_result: result,
      work_item: targetItem,
    };
  }

  factoryIntake.updateWorkItem(targetItem.id, { status: 'verifying' });
  logger.info('EXECUTE stage: plan executor completed successfully', {
    project_id: project.id,
    work_item_id: targetItem.id,
    completed_tasks: result.completed_tasks,
  });
  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.EXECUTE,
    action: 'completed_execution',
    reasoning: 'plan execution completed',
    inputs: {
      ...getWorkItemDecisionContext(targetItem),
    },
    outcome: {
      completed_tasks: result.completed_tasks || 0,
      dry_run: result.dry_run === true,
      task_count: result.task_count ?? null,
      simulated: result.simulated === true,
      final_state: getPostStageTransition(LOOP_STATES.EXECUTE, project.trust_level).next_state,
      plan_path: targetItem.origin.plan_path,
    },
    confidence: 1,
    batch_id: decisionBatchId,
  });

  return {
    ...getPostStageTransition(LOOP_STATES.EXECUTE, project.trust_level),
    reason: 'plan execution completed',
    stage_result: result,
    work_item: targetItem,
  };
}

async function executeVerifyStage(project_id, batch_id) {
  if (!batch_id) {
    logger.info('VERIFY stage: no batch_id, skipping guardrail checks', { project_id });
    safeLogDecision({
      project_id,
      stage: LOOP_STATES.VERIFY,
      action: 'skipped_verification',
      reasoning: 'VERIFY stage skipped because no batch_id is attached.',
      outcome: {
        status: 'skipped',
        reason: 'no_batch_id',
      },
      confidence: 1,
      batch_id: null,
    });
    return { status: 'skipped', reason: 'no_batch_id' };
  }
  try {
    const result = guardrailRunner.runPostBatchChecks(project_id, batch_id, []);
    logger.info('VERIFY stage: guardrail checks complete', { project_id, batch_id, result });
    safeLogDecision({
      project_id,
      stage: LOOP_STATES.VERIFY,
      action: 'verified_batch',
      reasoning: 'VERIFY stage completed post-batch guardrail checks.',
      outcome: {
        batch_id,
        status: result?.status || null,
        passed: result?.passed ?? null,
      },
      confidence: 1,
      batch_id,
    });
    return result;
  } catch (err) {
    logger.warn(`VERIFY stage guardrail check failed: ${err.message}`, { project_id });
    safeLogDecision({
      project_id,
      stage: LOOP_STATES.VERIFY,
      action: 'verify_failed',
      reasoning: err.message,
      outcome: {
        batch_id,
        status: 'error',
        error: err.message,
      },
      confidence: 1,
      batch_id,
    });
    return { status: 'error', error: err.message };
  }
}

async function executeLearnStage(project_id, batch_id) {
  try {
    const feedback = require('./feedback');
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
    logger.info('LEARN stage: batch analysis complete', { project_id, batch_id });
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
  const previousState = getCurrentLoopState(project);
  clearSelectedWorkItem(project.id);

  factoryHealth.updateProject(project.id, {
    loop_state: LOOP_STATES.SENSE,
    loop_batch_id: null,
    loop_last_action_at: nowIso(),
    loop_paused_at_stage: null,
  });

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.SENSE,
    action: 'started_loop',
    reasoning: 'Factory loop started and entered SENSE.',
    inputs: {
      previous_state: previousState,
      trust_level: project.trust_level,
    },
    outcome: {
      from_state: previousState,
      to_state: LOOP_STATES.SENSE,
    },
    confidence: 1,
    batch_id: null,
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

  const pendingGateStage = getPendingGateStage(currentState, project.trust_level);
  let nextState = pendingGateStage
    ? LOOP_STATES.PAUSED
    : getNextState(currentState, project.trust_level, 'approved');
  let pausedAtStage = pendingGateStage || null;

  // Execute stage-specific logic before transitioning
  let stageResult = null;
  let transitionReason = null;
  let transitionWorkItem = null;

  if (currentState === LOOP_STATES.PRIORITIZE) {
    const prioritizeStage = executePrioritizeStage(project, transitionWorkItem);
    if (prioritizeStage?.work_item) {
      transitionWorkItem = prioritizeStage.work_item;
    }
    if (prioritizeStage?.reason) {
      transitionReason = prioritizeStage.reason;
    }
    if (!stageResult && prioritizeStage?.stage_result) {
      stageResult = prioritizeStage.stage_result;
    }
  }

  if (currentState === LOOP_STATES.PRIORITIZE || nextState === LOOP_STATES.PLAN) {
    const planStage = await executePlanStage(project, transitionWorkItem);
    if (planStage?.stage_result) {
      stageResult = planStage.stage_result;
    }
    if (planStage?.reason) {
      transitionReason = planStage.reason;
    }
    if (planStage?.work_item) {
      transitionWorkItem = planStage.work_item;
    }
    if (planStage?.skip_to_execute) {
      nextState = LOOP_STATES.EXECUTE;
      pausedAtStage = null;
    }
  } else if (currentState === LOOP_STATES.PLAN || currentState === LOOP_STATES.EXECUTE) {
    const executeStage = await executePlanFileStage(project, transitionWorkItem);
    if (executeStage) {
      stageResult = executeStage.stage_result;
      nextState = executeStage.next_state;
      pausedAtStage = executeStage.paused_at_stage || null;
      transitionReason = executeStage.reason;
      transitionWorkItem = executeStage.work_item || transitionWorkItem;
    }
  }

  if (currentState === LOOP_STATES.LEARN && nextState === LOOP_STATES.IDLE) {
    const cfg = project.config_json ? (() => { try { return JSON.parse(project.config_json); } catch { return {}; } })() : {};
    if (cfg && cfg.loop && cfg.loop.auto_continue === true) {
      nextState = LOOP_STATES.SENSE;
      pausedAtStage = null;
    }
  }

  if (nextState === LOOP_STATES.VERIFY) {
    stageResult = await executeVerifyStage(project.id, project.loop_batch_id);
  } else if (nextState === LOOP_STATES.LEARN || currentState === LOOP_STATES.LEARN) {
    stageResult = await executeLearnStage(project.id, project.loop_batch_id);
  }

  transitionWorkItem = transitionWorkItem || tryGetSelectedWorkItem(project.id) || tryGetLoopWorkItem(project.id);

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
  if (nextState === LOOP_STATES.IDLE || nextState === LOOP_STATES.SENSE) {
    clearSelectedWorkItem(project.id);
  }
  logTransitionDecision({
    project,
    currentState,
    nextState,
    pausedAtStage,
    reason: transitionReason,
    workItem: transitionWorkItem,
    batchId: getDecisionBatchId(project, transitionWorkItem),
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
  const resumeState = getResumeStateForApprovedGate(stage, project.trust_level);

  factoryHealth.updateProject(project.id, {
    loop_state: resumeState,
    loop_paused_at_stage: null,
    loop_last_action_at: nowIso(),
  });

  logger.info('Factory gate approved', {
    project_id: project.id,
    state: resumeState,
    approved_stage: stage,
  });
  safeLogDecision({
    project_id: project.id,
    stage,
    actor: 'human',
    action: 'gate_approved',
    reasoning: `Approval gate cleared for ${stage}.`,
    inputs: {
      previous_state: LOOP_STATES.PAUSED,
      paused_at_stage: stage,
    },
    outcome: {
      from_state: LOOP_STATES.PAUSED,
      to_state: resumeState,
      approved_stage: stage,
      batch_id: project.loop_batch_id || null,
    },
    confidence: 1,
    batch_id: project.loop_batch_id || null,
  });

  return {
    project_id: project.id,
    state: resumeState,
    message: 'Gate approved, loop continuing',
  };
}

function rejectGate(project_id, stage) {
  const project = getProjectOrThrow(project_id);
  assertValidGateStage(stage);
  assertPausedAtStage(project, stage);
  clearSelectedWorkItem(project.id);

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
