'use strict';

const { randomUUID } = require('crypto');
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
const eventBus = require('../event-bus');
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

const CLOSED_WORK_ITEM_STATUSES = new Set(['completed', 'shipped', 'rejected']);
const EXECUTION_TERMINAL_DECISION_ACTIONS = Object.freeze([
  'completed_execution',
  'execution_failed',
  'started_execution',
]);

const selectedWorkItemIds = new Map();
const loopAdvanceJobs = new Map();
const activeLoopAdvanceJobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function getLoopAdvanceJobKey(project_id, job_id) {
  return `${project_id}:${job_id}`;
}

function snapshotLoopAdvanceJob(job) {
  if (!job) {
    return null;
  }

  return {
    job_id: job.job_id,
    started_at: job.started_at,
    current_state: job.current_state,
    status: job.status,
    new_state: job.new_state ?? null,
    paused_at_stage: job.paused_at_stage ?? null,
    stage_result: job.stage_result ?? null,
    reason: job.reason ?? null,
    completed_at: job.completed_at ?? null,
    error: job.error ?? null,
  };
}

function emitLoopAdvanceJobEvent(job) {
  eventBus.emitTaskEvent({
    type: 'factory_loop_job',
    project_id: job.project_id,
    job_id: job.job_id,
    status: job.status,
    current_state: job.current_state,
    new_state: job.new_state ?? null,
    paused_at_stage: job.paused_at_stage ?? null,
    completed_at: job.completed_at ?? null,
    error: job.error ?? null,
    timestamp: nowIso(),
  });
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

function getFactorySubmissionBatchId(project, workItem) {
  return getDecisionBatchId(project, workItem)
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

function hydrateDecisionRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    inputs: row.inputs ?? parseJsonObject(row.inputs_json),
    outcome: row.outcome ?? parseJsonObject(row.outcome_json),
  };
}

function getDecisionRowWorkItemId(row) {
  const hydrated = hydrateDecisionRow(row);
  return normalizeWorkItemId(
    hydrated?.outcome?.work_item_id
    ?? hydrated?.inputs?.work_item_id
  );
}

function getLatestStartedExecutionDecision(project_id) {
  const db = database.getDbInstance();
  if (!db || !project_id) {
    return null;
  }

  try {
    const row = db.prepare(`
      SELECT id, stage, actor, action, reasoning, inputs_json, outcome_json, batch_id
      FROM factory_decisions
      WHERE project_id = ?
        AND stage = 'execute'
        AND action = 'started_execution'
      ORDER BY id DESC
      LIMIT 1
    `).get(project_id);

    return hydrateDecisionRow(row);
  } catch (error) {
    logger.debug({ err: error.message, project_id }, 'Unable to restore started_execution decision');
    return null;
  }
}

function getLatestExecutionDecisionForWorkItem(project_id, workItemId) {
  const db = database.getDbInstance();
  if (!db || !project_id || !workItemId) {
    return null;
  }

  try {
    const placeholders = EXECUTION_TERMINAL_DECISION_ACTIONS.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT id, stage, actor, action, reasoning, inputs_json, outcome_json, batch_id
      FROM factory_decisions
      WHERE project_id = ?
        AND stage = 'execute'
        AND action IN (${placeholders})
      ORDER BY id DESC
      LIMIT 25
    `).all(project_id, ...EXECUTION_TERMINAL_DECISION_ACTIONS);

    for (const row of rows) {
      const hydrated = hydrateDecisionRow(row);
      if (getDecisionRowWorkItemId(hydrated) === workItemId) {
        return hydrated;
      }
    }
  } catch (error) {
    logger.debug({ err: error.message, project_id, work_item_id: workItemId }, 'Unable to inspect execute decisions');
  }

  return null;
}

function evaluateWorkItemShipping(project_id, workItemId) {
  const executionDecision = getLatestExecutionDecisionForWorkItem(project_id, workItemId);
  if (!executionDecision) {
    return {
      should_ship: false,
      reason: 'no_execute_result',
      decision_action: null,
      decision_batch_id: null,
    };
  }

  const outcome = executionDecision.outcome || {};
  const decisionAction = executionDecision.action || null;

  if (decisionAction === 'execution_failed') {
    return {
      should_ship: false,
      reason: outcome.failed_task ? `task_${outcome.failed_task}_failed` : 'execution_failed',
      decision_action: decisionAction,
      decision_batch_id: executionDecision.batch_id || null,
    };
  }

  if (decisionAction !== 'completed_execution') {
    return {
      should_ship: false,
      reason: `unfinished_${decisionAction || 'execution'}`,
      decision_action: decisionAction,
      decision_batch_id: executionDecision.batch_id || null,
    };
  }

  if (outcome.failed_task) {
    return {
      should_ship: false,
      reason: `task_${outcome.failed_task}_failed`,
      decision_action: decisionAction,
      decision_batch_id: executionDecision.batch_id || null,
    };
  }

  if (outcome.dry_run === true) {
    const submittedTasks = Array.isArray(outcome.submitted_tasks) ? outcome.submitted_tasks : [];
    if ((outcome.execution_mode || null) === 'pending_approval' && submittedTasks.length > 0) {
      return {
        should_ship: false,
        reason: 'pending_approval_tasks_unfinished',
        decision_action: decisionAction,
        decision_batch_id: executionDecision.batch_id || null,
      };
    }

    return {
      should_ship: false,
      reason: `${outcome.execution_mode || 'dry_run'}_execution_not_final`,
      decision_action: decisionAction,
      decision_batch_id: executionDecision.batch_id || null,
    };
  }

  if (outcome.execution_mode && outcome.execution_mode !== 'live') {
    return {
      should_ship: false,
      reason: `${outcome.execution_mode}_execution_not_final`,
      decision_action: decisionAction,
      decision_batch_id: executionDecision.batch_id || null,
    };
  }

  return {
    should_ship: true,
    reason: 'execute_completed_successfully',
    decision_action: decisionAction,
    decision_batch_id: executionDecision.batch_id || null,
  };
}

function maybeShipWorkItemAfterLearn(project_id, batch_id) {
  try {
    const rememberedWorkItemId = normalizeWorkItemId(selectedWorkItemIds.get(project_id));
    const startedExecutionDecision = rememberedWorkItemId
      ? null
      : getLatestStartedExecutionDecision(project_id);
    const workItemId = rememberedWorkItemId || getDecisionRowWorkItemId(startedExecutionDecision);
    const resolutionSource = rememberedWorkItemId ? 'tracked_selection' : 'started_execution';
    const decisionBatchId = batch_id || startedExecutionDecision?.batch_id || null;

    if (!workItemId) {
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.LEARN,
        action: 'no_selected_work_item',
        reasoning: 'LEARN stage could not resolve a selected work item to close.',
        inputs: {
          batch_id: batch_id || null,
          resolution_source: rememberedWorkItemId ? 'tracked_selection' : 'started_execution',
        },
        outcome: {
          reason: 'no_selected_work_item',
          work_item_id: null,
          batch_id: batch_id || null,
        },
        confidence: 1,
        batch_id: decisionBatchId,
      });
      return {
        status: 'skipped',
        reason: 'no_selected_work_item',
        work_item_id: null,
      };
    }

    const workItem = factoryIntake.getWorkItemForProject(project_id, workItemId, {
      includeClosed: true,
    });

    if (!workItem) {
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.LEARN,
        action: 'no_selected_work_item',
        reasoning: 'LEARN stage found a selected work item id, but the record is no longer available.',
        inputs: {
          batch_id: batch_id || null,
          resolution_source: resolutionSource,
        },
        outcome: {
          reason: 'work_item_missing',
          work_item_id: workItemId,
          batch_id: batch_id || null,
        },
        confidence: 1,
        batch_id: decisionBatchId,
      });
      return {
        status: 'skipped',
        reason: 'work_item_missing',
        work_item_id: workItemId,
      };
    }

    rememberSelectedWorkItem(project_id, workItem);

    if (CLOSED_WORK_ITEM_STATUSES.has(workItem.status)) {
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.LEARN,
        action: 'already_closed',
        reasoning: 'LEARN stage skipped shipping because the selected work item is already closed.',
        inputs: {
          batch_id: batch_id || null,
          resolution_source: resolutionSource,
          work_item_status: workItem.status,
        },
        outcome: {
          work_item_id: workItem.id,
          work_item_status: workItem.status,
          reason: 'already_closed',
        },
        confidence: 1,
        batch_id: decisionBatchId,
      });
      return {
        status: 'skipped',
        reason: 'already_closed',
        work_item_id: workItem.id,
      };
    }

    const shippingDecision = evaluateWorkItemShipping(project_id, workItem.id);
    if (!shippingDecision.should_ship) {
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.LEARN,
        action: 'skipped_shipping',
        reasoning: 'LEARN stage left the selected work item open because EXECUTE did not finish successfully.',
        inputs: {
          batch_id: batch_id || null,
          resolution_source: resolutionSource,
          work_item_status: workItem.status,
        },
        outcome: {
          work_item_id: workItem.id,
          work_item_status: workItem.status,
          reason: shippingDecision.reason,
          execution_action: shippingDecision.decision_action,
        },
        confidence: 1,
        batch_id: shippingDecision.decision_batch_id || decisionBatchId,
      });
      return {
        status: 'skipped',
        reason: shippingDecision.reason,
        work_item_id: workItem.id,
      };
    }

    const updatedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
      status: 'shipped',
    });
    rememberSelectedWorkItem(project_id, updatedWorkItem);

    safeLogDecision({
      project_id,
      stage: LOOP_STATES.LEARN,
      action: 'shipped_work_item',
      reasoning: 'LEARN stage marked the selected work item as shipped after successful execution.',
      inputs: {
        batch_id: batch_id || null,
        resolution_source: resolutionSource,
        previous_status: workItem.status,
      },
      outcome: {
        work_item_id: updatedWorkItem.id,
        previous_status: workItem.status,
        new_status: updatedWorkItem.status,
        reason: shippingDecision.reason,
      },
      confidence: 1,
      batch_id: shippingDecision.decision_batch_id || decisionBatchId,
    });

    return {
      status: 'shipped',
      reason: shippingDecision.reason,
      work_item_id: updatedWorkItem.id,
    };
  } catch (error) {
    logger.warn(`LEARN stage shipping check failed: ${error.message}`, { project_id, batch_id });
    safeLogDecision({
      project_id,
      stage: LOOP_STATES.LEARN,
      action: 'skipped_shipping',
      reasoning: 'LEARN stage shipping check failed unexpectedly.',
      inputs: {
        batch_id: batch_id || null,
      },
      outcome: {
        reason: 'shipping_check_failed',
        error: error.message,
      },
      confidence: 1,
      batch_id: batch_id || null,
    });
    return {
      status: 'skipped',
      reason: 'shipping_check_failed',
      error: error.message,
      work_item_id: null,
    };
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

function resolveExecuteMode(project) {
  if (project?.config?.execute_live === true) {
    return 'live';
  }
  if (project?.trust_level !== 'supervised') {
    return 'live';
  }
  return project?.config?.execute_mode === 'suppress'
    ? 'suppress'
    : 'pending_approval';
}

function slugifyAutoGeneratedPlanSegment(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    return 'work-item';
  }

  return normalized.slice(0, 80).replace(/-+$/g, '') || 'work-item';
}

function inferAutoGeneratedPlanTechStack(projectPath) {
  const root = projectPath ? path.resolve(projectPath) : process.cwd();

  if (fs.existsSync(path.join(root, 'package.json'))) {
    return 'Node.js';
  }
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) {
    return 'Python';
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    return 'Rust';
  }

  try {
    const entries = fs.readdirSync(root);
    if (entries.some((entry) => entry.endsWith('.csproj') || entry.endsWith('.sln'))) {
      return '.NET';
    }
  } catch {
    // Ignore tech-stack inference failures and fall back to a generic value.
  }

  return 'application code';
}

function buildAutoGeneratedPlanPath(project, workItem) {
  const plansDirHint = path.join(
    path.resolve(project?.path || process.cwd()),
    'docs',
    'superpowers',
    'plans'
  );
  const repoRoot = resolvePlansRepoRoot(project?.path, plansDirHint);
  const fileName = `${workItem.id}-${slugifyAutoGeneratedPlanSegment(workItem?.title)}.md`;
  return path.join(repoRoot, 'docs', 'superpowers', 'plans', 'auto-generated', fileName);
}

function buildAutoGeneratedPlanPrompt(project, workItem) {
  const projectBrief = typeof project?.brief === 'string' && project.brief.trim()
    ? project.brief.trim()
    : 'No project brief provided.';
  const description = String(workItem?.description || '').trim();
  const techStack = inferAutoGeneratedPlanTechStack(project?.path);

  return [
    'You are generating an execution plan for a single factory work item.',
    '',
    'Return Markdown only. Do not wrap the response in code fences.',
    'Do not include commentary before or after the plan.',
    'Use this exact structure:',
    `# ${workItem?.title || `Work Item ${workItem?.id}`} Plan`,
    `**Source:** auto-generated from work_item #${workItem?.id}`,
    `**Tech Stack:** ${techStack}`,
    '',
    '## Task 1: <task title>',
    '',
    '- [ ] **Step 1: <step title>**',
    '',
    '    Concrete implementation instructions, including relevant file paths.',
    '',
    '- [ ] **Step 2: Commit**',
    '',
    '    git commit -m "<scoped commit message>"',
    '',
    'Rules:',
    '- Use `## Task N:` headings exactly.',
    '- Use `- [ ] **Step N: ...**` checkbox lines exactly.',
    '- Use 1 to 5 tasks total.',
    '- Keep every task specific and executable.',
    '- Include file paths whenever the work item implies a code location.',
    '- Use indented detail lines under steps. Do not use fenced code blocks.',
    '- Preserve the `**Source:** auto-generated from work_item #<id>` line.',
    '',
    'Project context:',
    `- Project ID: ${project?.id || 'unknown'}`,
    `- Project name: ${project?.name || 'unknown'}`,
    `- Project path: ${project?.path || 'unknown'}`,
    `- Project brief: ${projectBrief}`,
    '',
    'Work item context:',
    `- Work item ID: ${workItem?.id || 'unknown'}`,
    `- Source: ${workItem?.source || 'unknown'}`,
    `- Title: ${workItem?.title || 'Untitled work item'}`,
    'Description:',
    description,
  ].join('\n');
}

function extractTextContent(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (entry && typeof entry.text === 'string') {
          return entry.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (value && typeof value === 'object' && Array.isArray(value.content)) {
    return extractTextContent(value.content);
  }

  return '';
}

function unwrapWholeMarkdownFence(value) {
  const trimmed = String(value || '').trim();
  const match = trimmed.match(/^```(?:[a-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```$/i);
  return match ? match[1].trim() : trimmed;
}

function convertFencedBlocksToIndented(value) {
  const lines = String(value || '').split(/\r?\n/);
  const converted = [];
  let inFence = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      converted.push(line.length > 0 ? `    ${line}` : '');
      continue;
    }

    converted.push(line);
  }

  return converted.join('\n');
}

function normalizeAutoGeneratedPlanMarkdown(markdown, workItem, project) {
  const raw = convertFencedBlocksToIndented(unwrapWholeMarkdownFence(markdown));
  const taskMatch = raw.match(/^##\s+Task\s+\d+\s*[:.]\s*.+$/m);
  if (!taskMatch || typeof taskMatch.index !== 'number') {
    return null;
  }

  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const goalMatch = raw.match(/\*\*Goal:\*\*\s*([^\n]+)/i);
  const techStackMatch = raw.match(/\*\*Tech Stack:\*\*\s*([^\n]+)/i);
  const taskSection = raw.slice(taskMatch.index).trim();
  const lines = [
    `# ${(titleMatch?.[1] || `${workItem?.title || `Work Item ${workItem?.id}`} Plan`).trim()}`,
    '',
    `**Source:** auto-generated from work_item #${workItem?.id}`,
  ];

  if (goalMatch?.[1]?.trim()) {
    lines.push(`**Goal:** ${goalMatch[1].trim()}`);
  }

  lines.push(`**Tech Stack:** ${(techStackMatch?.[1] || inferAutoGeneratedPlanTechStack(project?.path)).trim()}`);
  lines.push('', taskSection);

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
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

async function executeNonPlanFileStage(project, workItem) {
  const targetItem = workItem || getSelectedWorkItem(project.id, {
    fallbackToLoopSelection: true,
  });
  if (!targetItem) {
    return null;
  }

  rememberSelectedWorkItem(project.id, targetItem);
  const description = typeof targetItem.description === 'string'
    ? targetItem.description.trim()
    : '';
  if (!description) {
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'cannot_generate_plan',
      reasoning: 'no description',
      inputs: {
        ...getWorkItemDecisionContext(targetItem),
      },
      outcome: {
        reason: 'no description',
        generator: 'codex',
        generation_task_id: null,
        ...getWorkItemDecisionContext(targetItem),
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, targetItem),
    });
    return {
      reason: 'no description',
      work_item: targetItem,
    };
  }

  const planPath = buildAutoGeneratedPlanPath(project, targetItem);
  const nextOrigin = {
    ...(targetItem.origin && typeof targetItem.origin === 'object' ? targetItem.origin : {}),
    plan_path: planPath,
  };

  if (fs.existsSync(planPath)) {
    const updatedWorkItem = factoryIntake.updateWorkItem(targetItem.id, {
      origin_json: nextOrigin,
      status: 'executing',
    });
    rememberSelectedWorkItem(project.id, updatedWorkItem);
    return {
      reason: 'reused auto-generated plan',
      work_item: updatedWorkItem,
    };
  }

  const { handleSmartSubmitTask } = require('../handlers/integration/routing');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');
  const prompt = buildAutoGeneratedPlanPrompt(project, targetItem);
  let generationTaskId = null;

  try {
    const submitResult = await handleSmartSubmitTask({
      task: prompt,
      project: 'factory-architect',
      provider: 'codex',
      working_directory: project.path || process.cwd(),
      timeout_minutes: 10,
      // Plan generation is internal factory bookkeeping — never bumps the
      // versioned project's semver.
      version_intent: 'internal',
      tags: [
        'factory:internal',
        'factory:plan_generation',
        `factory:project_id=${project.id}`,
        `factory:work_item_id=${targetItem.id}`,
      ],
      task_metadata: {
        factory_internal: true,
        execute_plan_generation: true,
        project_id: project.id,
        work_item_id: targetItem.id,
      },
    });

    generationTaskId = submitResult?.task_id || null;
    if (!generationTaskId) {
      throw new Error(submitResult?.content?.[0]?.text || 'smart_submit_task did not return task_id');
    }

    const awaitResult = await handleAwaitTask({ task_id: generationTaskId, timeout_minutes: 10 });
    const generationTask = taskCore.getTask(generationTaskId);
    if (!generationTask || generationTask.status !== 'completed') {
      throw new Error(
        generationTask?.error_output
        || extractTextContent(awaitResult)
        || `plan generation task ${generationTaskId} did not complete successfully`
      );
    }

    const rawPlanMarkdown = extractTextContent(generationTask.output) || extractTextContent(awaitResult);
    const normalizedPlanMarkdown = normalizeAutoGeneratedPlanMarkdown(rawPlanMarkdown, targetItem, project);
    if (!normalizedPlanMarkdown) {
      throw new Error('generated plan output did not contain any "## Task N:" sections');
    }

    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, normalizedPlanMarkdown);

    const updatedWorkItem = factoryIntake.updateWorkItem(targetItem.id, {
      origin_json: nextOrigin,
      status: 'executing',
    });
    rememberSelectedWorkItem(project.id, updatedWorkItem);

    logger.info('EXECUTE stage: generated plan for non-plan-file work item', {
      project_id: project.id,
      work_item_id: updatedWorkItem.id,
      plan_path: planPath,
      generation_task_id: generationTaskId,
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'plan_generated',
      reasoning: 'generated plan via Codex for non-plan-file work item',
      inputs: {
        ...getWorkItemDecisionContext(targetItem),
      },
      outcome: {
        work_item_id: updatedWorkItem.id,
        plan_path: planPath,
        generator: 'codex',
        generation_task_id: generationTaskId,
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, updatedWorkItem),
    });

    return {
      reason: 'generated plan via Codex',
      work_item: updatedWorkItem,
      stage_result: {
        plan_path: planPath,
        generator: 'codex',
        generation_task_id: generationTaskId,
      },
    };
  } catch (error) {
    logger.warn('EXECUTE stage: failed to generate plan for non-plan-file work item', {
      project_id: project.id,
      work_item_id: targetItem.id,
      generation_task_id: generationTaskId,
      error: error.message,
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'cannot_generate_plan',
      reasoning: error.message,
      inputs: {
        ...getWorkItemDecisionContext(targetItem),
      },
      outcome: {
        reason: error.message,
        generator: 'codex',
        generation_task_id: generationTaskId,
        ...getWorkItemDecisionContext(targetItem),
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, targetItem),
    });
    return {
      reason: error.message,
      work_item: targetItem,
    };
  }
}

async function executePlanFileStage(project, workItem) {
  const targetItem = workItem || getSelectedWorkItem(project.id, {
    fallbackToLoopSelection: true,
  });
  if (!targetItem?.origin?.plan_path || !fs.existsSync(targetItem.origin.plan_path)) {
    return null;
  }
  rememberSelectedWorkItem(project.id, targetItem);
  const executeLogBatchId = getFactorySubmissionBatchId(project, targetItem);

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
    batch_id: executeLogBatchId,
  });

  const { createPlanExecutor } = require('./plan-executor');
  const { handleSmartSubmitTask } = require('../handlers/integration/routing');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');
  const executeMode = resolveExecuteMode(project);
  const dry_run = executeMode !== 'live';
  const decisionBatchId = getDecisionBatchId(project, targetItem);
  const submissionBatchId = getFactorySubmissionBatchId(project, targetItem);
  const executeDecisionBatchId = executeMode === 'pending_approval' ? submissionBatchId : decisionBatchId;

  const executor = createPlanExecutor({
    submit: async (args) => {
      const tags = Array.isArray(args.tags) ? [...args.tags] : [];
      if (args.initial_status === 'pending_approval') {
        if (submissionBatchId) tags.push(`factory:batch_id=${submissionBatchId}`);
        tags.push(`factory:work_item_id=${targetItem.id}`);
        tags.push(`factory:plan_task_number=${args.plan_task_number}`);
        tags.push('factory:pending_approval');
      }

      const result = await handleSmartSubmitTask({
        ...args,
        tags: [...new Set(tags)],
      });
      if (!result?.task_id) {
        throw new Error(result?.content?.[0]?.text || 'smart_submit_task did not return task_id');
      }
      return { task_id: result.task_id };
    },
    awaitTask: (args) => awaitTaskToStructuredResult(handleAwaitTask, taskCore, args),
    projectDefaults: project.config || {},
    onDryRunTask: dry_run ? async ({ task, prompt, file_paths, simulated, submitted_task_id, initial_status, execution_mode }) => {
      const heldForApproval = execution_mode === 'pending_approval';
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'dry_run_task',
        reasoning: heldForApproval
          ? `submitted task ${task.task_number} and held it for human approval`
          : `dry-run recorded task ${task.task_number} without submission`,
        inputs: {
          ...getWorkItemDecisionContext(targetItem),
          dry_run: true,
          simulated: simulated === true,
          execution_mode,
          task_number: task.task_number,
          task_title: task.task_title,
        },
        outcome: {
          plan_path: targetItem.origin.plan_path,
          dry_run: true,
          simulated: simulated === true,
          execution_mode,
          initial_status: initial_status || null,
          held_for_approval: heldForApproval,
          task_id: submitted_task_id || null,
          batch_id: submissionBatchId,
          task_number: task.task_number,
          task_title: task.task_title,
          planned_task_description: prompt,
          file_paths,
        },
        confidence: 1,
        batch_id: executeDecisionBatchId,
      });
    } : null,
  });

  const result = await executor.execute({
    plan_path: targetItem.origin.plan_path,
    project: project.name,
    working_directory: project.path,
    execution_mode: executeMode,
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
      execution_mode: result.execution_mode || executeMode,
      task_count: result.task_count ?? null,
      simulated: result.simulated === true,
      submitted_tasks: Array.isArray(result.submitted_tasks) ? result.submitted_tasks : [],
      final_state: getPostStageTransition(LOOP_STATES.EXECUTE, project.trust_level).next_state,
      plan_path: targetItem.origin.plan_path,
    },
    confidence: 1,
    batch_id: executeDecisionBatchId,
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
    const shippingResult = maybeShipWorkItemAfterLearn(project_id, batch_id);
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

async function runAdvanceLoop(project_id) {
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
    let targetItem = transitionWorkItem || tryGetSelectedWorkItem(project.id, {
      fallbackToLoopSelection: true,
    });
    if (targetItem && (!targetItem.origin?.plan_path || !fs.existsSync(targetItem.origin.plan_path))) {
      const generated = await executeNonPlanFileStage(project, targetItem);
      if (generated?.work_item) {
        targetItem = generated.work_item;
      }
    }

    const executeStage = await executePlanFileStage(project, targetItem);
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

async function advanceLoop(project_id) {
  return runAdvanceLoop(project_id);
}

function advanceLoopAsync(project_id) {
  const project = getProjectOrThrow(project_id);
  const currentState = getCurrentLoopState(project);

  if (currentState === LOOP_STATES.IDLE) {
    throw new Error('Loop not started for this project');
  }

  if (currentState === LOOP_STATES.PAUSED) {
    throw new Error('Loop is paused — use approveGate to continue');
  }

  const activeJobId = activeLoopAdvanceJobs.get(project.id);
  if (activeJobId) {
    const activeJob = loopAdvanceJobs.get(getLoopAdvanceJobKey(project.id, activeJobId));
    if (activeJob?.status === 'running') {
      return snapshotLoopAdvanceJob(activeJob);
    }
    activeLoopAdvanceJobs.delete(project.id);
  }

  const job = {
    project_id: project.id,
    job_id: randomUUID(),
    started_at: nowIso(),
    current_state: currentState,
    status: 'running',
    new_state: null,
    paused_at_stage: null,
    stage_result: null,
    reason: null,
    completed_at: null,
    error: null,
  };

  loopAdvanceJobs.set(getLoopAdvanceJobKey(project.id, job.job_id), job);
  activeLoopAdvanceJobs.set(project.id, job.job_id);
  emitLoopAdvanceJobEvent(job);

  void runAdvanceLoop(project.id)
    .then((result) => {
      job.status = 'completed';
      job.new_state = result.new_state ?? null;
      job.paused_at_stage = result.paused_at_stage ?? null;
      job.stage_result = result.stage_result ?? null;
      job.reason = result.reason ?? null;
      job.completed_at = nowIso();
      emitLoopAdvanceJobEvent(job);
    })
    .catch((error) => {
      job.status = 'failed';
      try {
        const latestProject = getProjectOrThrow(project.id);
        job.new_state = getCurrentLoopState(latestProject);
        job.paused_at_stage = latestProject.loop_paused_at_stage || null;
      } catch {
        job.new_state = null;
        job.paused_at_stage = null;
      }
      job.completed_at = nowIso();
      job.error = error instanceof Error ? error.message : String(error);
      logger.warn('Factory loop async advance failed', {
        project_id: project.id,
        job_id: job.job_id,
        error: job.error,
      });
      emitLoopAdvanceJobEvent(job);
    })
    .finally(() => {
      if (activeLoopAdvanceJobs.get(project.id) === job.job_id) {
        activeLoopAdvanceJobs.delete(project.id);
      }
    });

  return snapshotLoopAdvanceJob(job);
}

function getLoopAdvanceJobStatus(project_id, job_id) {
  if (!project_id || !job_id) {
    return null;
  }

  return snapshotLoopAdvanceJob(loopAdvanceJobs.get(getLoopAdvanceJobKey(project_id, job_id)));
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
  advanceLoopAsync,
  approveGate,
  rejectGate,
  getLoopState,
  getLoopAdvanceJobStatus,
  scheduleLoop,
  attachBatchId,
};
