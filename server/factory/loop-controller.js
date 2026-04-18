'use strict';

const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  LOOP_STATES,
  getNextState,
  getPendingGateStage,
  isValidState,
  getGatesForTrustLevel,
} = require('./loop-states');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const factoryWorktrees = require('../db/factory-worktrees');
const architectRunner = require('../factory/architect-runner');
const guardrailRunner = require('../factory/guardrail-runner');
const { logDecision } = require('./decision-log');
const { createPlanFileIntake } = require('./plan-file-intake');
const { createPlanReviewer, selectReviewers } = require('./plan-reviewer');
const { createShippedDetector } = require('./shipped-detector');
const { createWorktreeRunner } = require('./worktree-runner');
const { createWorktreeManager } = require('../plugins/version-control/worktree-manager');
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
  plan_review: 'reviewer',
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

let sharedWorktreeRunner = null;
let worktreeRunnerTestOverride = undefined; // undefined = auto; null = disabled; object = forced runner
function getWorktreeRunner() {
  if (worktreeRunnerTestOverride !== undefined) return worktreeRunnerTestOverride;
  if (sharedWorktreeRunner) return sharedWorktreeRunner;
  try {
    const db = database.getDbInstance();
    if (!db || typeof db.prepare !== 'function') return null;
    const worktreeManager = createWorktreeManager({ db });
    sharedWorktreeRunner = createWorktreeRunner({ worktreeManager, logger });
    return sharedWorktreeRunner;
  } catch (err) {
    logger.warn('factory worktree-runner unavailable; EXECUTE will run in main worktree', { err: err.message });
    return null;
  }
}

function setWorktreeRunnerForTests(runner) {
  // Convention: null = explicitly disable worktree flow in tests; an object
  // forces that runner; passing undefined (or no arg) clears the override so
  // the lazy resolver rebuilds on next call.
  if (runner === undefined) {
    worktreeRunnerTestOverride = undefined;
    sharedWorktreeRunner = null;
  } else {
    worktreeRunnerTestOverride = runner;
    sharedWorktreeRunner = runner;
  }
}
const PENDING_APPROVAL_SUCCESS_TASK_STATUSES = new Set(['completed', 'shipped']);
const PENDING_APPROVAL_FAILURE_TASK_STATUSES = new Set(['failed', 'cancelled']);
const EXECUTION_TERMINAL_DECISION_ACTIONS = Object.freeze([
  'completed_execution',
  'execution_failed',
  'started_execution',
]);
const POLL_MS = 2000;

class StageOccupiedError extends Error {
  constructor(project_id, stage) {
    super(`Stage ${stage} is already occupied for project ${project_id}`);
    this.name = 'StageOccupiedError';
    this.code = 'FACTORY_STAGE_OCCUPIED';
    this.project_id = project_id;
    this.stage = stage;
  }
}

const selectedWorkItemIds = new Map();
const loopAdvanceJobs = new Map();
const activeLoopAdvanceJobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function getLoopAdvanceJobKey(instance_id, job_id) {
  return `${instance_id}:${job_id}`;
}

function snapshotLoopAdvanceJob(job) {
  if (!job) {
    return null;
  }

  return {
    job_id: job.job_id,
    started_at: job.started_at,
    current_state: job.current_state,
    // previous_state mirrors current_state — it's the state captured before the
    // async advance started running. Provided as a convenience for clients that
    // want the terminology from the sync advance result shape.
    previous_state: job.current_state,
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
    instance_id: job.instance_id,
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

function getInstanceOrThrow(instance_id) {
  const instance = factoryLoopInstances.getInstance(instance_id);
  if (!instance) {
    throw new Error(`Factory loop instance not found: ${instance_id}`);
  }
  return instance;
}

function getLoopContextOrThrow(instance_id) {
  const instance = getInstanceOrThrow(instance_id);
  const project = getProjectOrThrow(instance.project_id);
  return { instance, project };
}

function getActiveInstances(project_id) {
  return factoryLoopInstances.listInstances({ project_id, active_only: true });
}

function getOldestActiveInstance(project_id) {
  return getActiveInstances(project_id)[0] || null;
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

function getPausedAtStage(loopRecord) {
  if (!loopRecord || typeof loopRecord !== 'object') {
    return null;
  }
  return loopRecord.paused_at_stage || loopRecord.loop_paused_at_stage || null;
}

function getCurrentLoopState(loopRecord) {
  const raw = loopRecord.loop_state || 'IDLE';
  const loopState = raw.toUpperCase();
  if (!isValidState(loopState)) {
    const ref = loopRecord.id || loopRecord.project_id || 'unknown';
    throw new Error(`Invalid loop state for ${ref}: ${String(raw)}`);
  }
  return loopState;
}

function isReadyForStage(pausedAtStage) {
  return typeof pausedAtStage === 'string' && pausedAtStage.startsWith('READY_FOR_');
}

function toReadyForStage(stage) {
  return `READY_FOR_${stage}`;
}

function getReadyStage(pausedAtStage) {
  return isReadyForStage(pausedAtStage)
    ? pausedAtStage.slice('READY_FOR_'.length)
    : null;
}

function assertValidGateStage(stage) {
  if (!isValidState(stage) || stage === LOOP_STATES.IDLE || stage === LOOP_STATES.PAUSED) {
    throw new Error(`Invalid gate stage: ${String(stage)}`);
  }
}

function assertPausedAtStage(loopRecord, stage) {
  const pausedAtStage = getPausedAtStage(loopRecord);
  if (!pausedAtStage) {
    throw new Error('Loop is not paused');
  }

  if (pausedAtStage !== stage) {
    throw new Error(`Loop is paused at ${pausedAtStage}, not ${stage}`);
  }
}

function mapInstanceToLegacyLoopView(instance) {
  if (!instance) {
    return {
      loop_state: LOOP_STATES.IDLE,
      loop_batch_id: null,
      loop_last_action_at: null,
      loop_paused_at_stage: null,
    };
  }

  return {
    loop_state: getPausedAtStage(instance) ? LOOP_STATES.PAUSED : getCurrentLoopState(instance),
    loop_batch_id: instance.batch_id || null,
    loop_last_action_at: instance.last_action_at || null,
    loop_paused_at_stage: getPausedAtStage(instance),
  };
}

function syncLegacyProjectLoopState(project_id) {
  const oldestActiveInstance = getOldestActiveInstance(project_id);
  return factoryHealth.updateProject(project_id, mapInstanceToLegacyLoopView(oldestActiveInstance));
}

function deriveInstanceStateFromLegacyProject(project) {
  const pausedStage = String(project?.loop_paused_at_stage || '').toUpperCase();
  let instanceState = String(project?.loop_state || LOOP_STATES.IDLE).toUpperCase();

  if (instanceState === LOOP_STATES.PAUSED) {
    if (pausedStage.startsWith('READY_FOR_')) {
      instanceState = pausedStage.slice('READY_FOR_'.length) || LOOP_STATES.IDLE;
    } else if (pausedStage === 'VERIFY_FAIL') {
      instanceState = LOOP_STATES.VERIFY;
    } else if (pausedStage) {
      instanceState = pausedStage;
    } else {
      instanceState = LOOP_STATES.IDLE;
    }
  }

  return isValidState(instanceState) ? instanceState : LOOP_STATES.IDLE;
}

function backfillLegacyProjectLoopInstance(project_id) {
  const project = getProjectOrThrow(project_id);
  const legacyState = deriveInstanceStateFromLegacyProject(project);
  if (legacyState === LOOP_STATES.IDLE) {
    return null;
  }

  const instance = factoryLoopInstances.createInstance({
    project_id: project.id,
    batch_id: project.loop_batch_id || null,
  });

  const updated = updateInstanceAndSync(instance.id, {
    loop_state: legacyState,
    paused_at_stage: project.loop_paused_at_stage || null,
    last_action_at: project.loop_last_action_at || instance.last_action_at,
    batch_id: project.loop_batch_id || null,
  });

  logger.info('Backfilled legacy project loop state into factory loop instance', {
    project_id: project.id,
    instance_id: updated.id,
    legacy_state: project.loop_state || LOOP_STATES.IDLE,
    instance_state: legacyState,
    paused_at_stage: project.loop_paused_at_stage || null,
  });

  return updated;
}

function updateInstanceAndSync(id, updates) {
  const updated = factoryLoopInstances.updateInstance(id, updates);
  if (updated) {
    syncLegacyProjectLoopState(updated.project_id);
    eventBus.emitFactoryLoopChanged({
      type: 'state_changed',
      project_id: updated.project_id,
      instance_id: updated.id,
      loop_state: updated.loop_state,
      paused_at_stage: updated.paused_at_stage || null,
    });
  }
  return updated;
}

function claimStageForInstanceOrThrow(instance_id, stage) {
  try {
    const claimed = factoryLoopInstances.claimStageForInstance(instance_id, stage);
    syncLegacyProjectLoopState(claimed.project_id);
    return claimed;
  } catch (error) {
    if (error && error.code === 'FACTORY_STAGE_OCCUPIED') {
      throw new StageOccupiedError(error.project_id, error.stage || stage);
    }
    throw error;
  }
}

function terminateInstanceAndSync(instance_id, { abandonWorktree = false } = {}) {
  const before = getInstanceOrThrow(instance_id);
  factoryIntake.releaseClaimForInstance(instance_id);
  clearSelectedWorkItem(instance_id);

  // Only abandon the factory_worktrees row when explicitly requested
  // (operator force-terminate) or when the instance died mid-flight
  // (paused_at_stage indicates it never completed LEARN). Clean LEARN
  // terminations either already markMerged the row (successful merge)
  // or left it active for operator resolution (failed merge with <git-user>
  // work still on the branch). Unconditionally abandoning here was
  // destroying shipped <git-user> work when the merge had failed — the
  // worktree and its commits vanished with no recovery path.
  const shouldAbandon = abandonWorktree || Boolean(before.paused_at_stage);
  if (shouldAbandon && before.batch_id) {
    try {
      const active = factoryWorktrees.getActiveWorktreeByBatch(before.batch_id);
      if (active) {
        factoryWorktrees.markAbandoned(active.id, 'instance_terminated');
        const worktreeRunner = getWorktreeRunner();
        if (worktreeRunner && typeof worktreeRunner.abandon === 'function' && active.vcWorktreeId) {
          Promise.resolve(worktreeRunner.abandon({
            id: active.vcWorktreeId,
            branch: active.branch,
            reason: 'instance_terminated',
          })).catch((err) => {
            logger.warn('factory worktree: vc cleanup after termination failed', {
              instance_id,
              stale_vc_worktree_id: active.vcWorktreeId,
              err: err.message,
            });
          });
        }
      }
    } catch (err) {
      logger.warn('factory worktree: failed to abandon active row during termination', {
        instance_id,
        batch_id: before.batch_id,
        err: err.message,
      });
    }
  }

  const terminated = factoryLoopInstances.terminateInstance(instance_id);
  syncLegacyProjectLoopState(before.project_id);
  eventBus.emitFactoryLoopChanged({
    type: 'terminated',
    project_id: before.project_id,
    instance_id: instance_id,
  });
  return terminated;
}

function parkInstanceForStage(instance, stage) {
  return updateInstanceAndSync(instance.id, {
    paused_at_stage: toReadyForStage(stage),
    last_action_at: nowIso(),
  });
}

function moveInstanceToStage(instance, stage, updates = {}) {
  let claimed = instance;
  if (getCurrentLoopState(instance) !== stage) {
    claimed = claimStageForInstanceOrThrow(instance.id, stage);
  }
  return updateInstanceAndSync(claimed.id, {
    paused_at_stage: Object.prototype.hasOwnProperty.call(updates, 'paused_at_stage')
      ? updates.paused_at_stage
      : null,
    last_action_at: Object.prototype.hasOwnProperty.call(updates, 'last_action_at')
      ? updates.last_action_at
      : nowIso(),
    batch_id: Object.prototype.hasOwnProperty.call(updates, 'batch_id')
      ? updates.batch_id
      : claimed.batch_id,
    work_item_id: Object.prototype.hasOwnProperty.call(updates, 'work_item_id')
      ? updates.work_item_id
      : claimed.work_item_id,
  });
}

function tryMoveInstanceToStage(instance, stage, updates = {}) {
  try {
    return {
      instance: moveInstanceToStage(instance, stage, updates),
      blocked: false,
    };
  } catch (error) {
    if (error instanceof StageOccupiedError) {
      return {
        instance: parkInstanceForStage(instance, stage),
        blocked: true,
        error,
      };
    }
    throw error;
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

function rememberSelectedWorkItem(instance_id, workItem) {
  const workItemId = normalizeWorkItemId(workItem?.id ?? workItem);
  if (!instance_id || !workItemId) {
    selectedWorkItemIds.delete(instance_id);
    return null;
  }

  selectedWorkItemIds.set(instance_id, workItemId);
  return workItemId;
}

function clearSelectedWorkItem(instance_id) {
  if (!instance_id) {
    return;
  }
  selectedWorkItemIds.delete(instance_id);
}

function getSelectedWorkItemIdFromDecisionLog(project_id, batch_id = null) {
  const db = database.getDbInstance();
  if (!db) {
    return null;
  }

  try {
    const placeholders = SELECTED_WORK_ITEM_DECISION_ACTIONS.map(() => '?').join(', ');
    const batchFilter = batch_id ? 'AND batch_id = ?' : '';
    const rows = db.prepare(`
      SELECT inputs_json, outcome_json
      FROM factory_decisions
      WHERE project_id = ?
        AND action IN (${placeholders})
        ${batchFilter}
      ORDER BY id DESC
      LIMIT 20
    `).all(
      project_id,
      ...SELECTED_WORK_ITEM_DECISION_ACTIONS,
      ...(batch_id ? [batch_id] : []),
    );

    for (const row of rows) {
      const inputs = parseJsonObject(row.inputs_json);
      const outcome = parseJsonObject(row.outcome_json);
      const workItemId = normalizeWorkItemId(
        outcome?.work_item_id
        ?? inputs?.work_item_id
      );
      if (!workItemId) {
        continue;
      }
      // Skip decisions that point at items which are now closed. Without
      // this guard, a fresh instance with no batch_id can resurrect the
      // last-selected work item from an earlier (shipped) loop run —
      // PRIORITIZE then claims it, PLAN flips its status back to
      // 'executing', and we're back in the flip-back cycle.
      const workItem = factoryIntake.getWorkItemForProject(project_id, workItemId, {
        includeClosed: true,
      });
      if (!workItem) {
        continue;
      }
      if (CLOSED_WORK_ITEM_STATUSES.has(workItem.status)) {
        continue;
      }
      return workItemId;
    }
  } catch (error) {
    logger.debug({ err: error.message, project_id, batch_id }, 'Unable to restore selected work item from decision log');
  }

  return null;
}

function getSelectedWorkItemId(instance, project_id) {
  const instanceId = typeof instance === 'string' ? instance : instance?.id;
  const remembered = instanceId ? selectedWorkItemIds.get(instanceId) : null;
  if (remembered) {
    return remembered;
  }

  const persisted = normalizeWorkItemId(typeof instance === 'object' ? instance?.work_item_id : null);
  if (persisted) {
    if (instanceId) {
      selectedWorkItemIds.set(instanceId, persisted);
    }
    return persisted;
  }

  const restored = getSelectedWorkItemIdFromDecisionLog(project_id, typeof instance === 'object' ? instance?.batch_id || null : null);
  if (restored) {
    if (instanceId) {
      selectedWorkItemIds.set(instanceId, restored);
    }
  }
  return restored;
}

function getSelectedWorkItem(instance, project_id, { fallbackToLoopSelection = false } = {}) {
  const selectedWorkItemId = getSelectedWorkItemId(instance, project_id);
  if (selectedWorkItemId) {
    const workItem = factoryIntake.getWorkItemForProject(project_id, selectedWorkItemId, {
      includeClosed: true,
    });
    if (!workItem) {
      throw new Error(`Selected work item ${selectedWorkItemId} is no longer available for project ${project_id}`);
    }
    // Don't resurrect closed items. getSelectedWorkItemId can restore the
    // most recent selection from the decision log — which, across loop
    // restarts, includes items that have since been shipped/completed/
    // rejected. If we returned a closed item here, PRIORITIZE (which trusts
    // this value and skips listOpenWorkItems) would claim it and PLAN would
    // flip its status back to 'executing'. Clear the stale in-memory hint
    // and fall through to the open-item queue.
    if (CLOSED_WORK_ITEM_STATUSES.has(workItem.status)) {
      const instanceId = typeof instance === 'string' ? instance : instance?.id;
      if (instanceId) {
        selectedWorkItemIds.delete(instanceId);
      }
      return fallbackToLoopSelection ? getLoopWorkItem(project_id) : null;
    }
    return workItem;
  }

  return fallbackToLoopSelection ? getLoopWorkItem(project_id) : null;
}

function tryGetSelectedWorkItem(instance, project_id, options = {}) {
  try {
    return getSelectedWorkItem(instance, project_id, options);
  } catch (error) {
    logger.debug({ err: error.message, project_id, instance_id: typeof instance === 'object' ? instance?.id : instance }, 'Unable to resolve selected work item');
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

function getLatestStageDecision(project_id, stage) {
  const db = database.getDbInstance();
  const normalizedStage = normalizeDecisionStage(stage);
  if (!db || !project_id || !normalizedStage) {
    return null;
  }

  try {
    const row = db.prepare(`
      SELECT id, stage, actor, action, reasoning, inputs_json, outcome_json, batch_id
      FROM factory_decisions
      WHERE project_id = ?
        AND stage = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(project_id, normalizedStage);

    return hydrateDecisionRow(row);
  } catch (error) {
    logger.debug({ err: error.message, project_id, stage: normalizedStage }, 'Unable to inspect latest stage decision');
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

function escapeSqlLikeValue(value) {
  return String(value || '').replace(/[\\%_]/g, '\\$&');
}

function listTasksForFactoryBatch(batchId) {
  const db = database.getDbInstance();
  if (!db || !batchId) {
    return [];
  }

  try {
    const batchTag = `factory:batch_id=${batchId}`;
    return db.prepare(`
      SELECT id, status
      FROM tasks
      WHERE tags LIKE ? ESCAPE '\\'
    `).all(`%"${escapeSqlLikeValue(batchTag)}"%`);
  } catch (error) {
    logger.debug({ err: error.message, batch_id: batchId }, 'Unable to inspect factory batch tasks');
    return [];
  }
}

function resolvePendingApprovalBatchId(project, workItem, executionDecision, startedExecutionDecision) {
  return startedExecutionDecision?.outcome?.batch_id
    || executionDecision?.batch_id
    || workItem?.batch_id
    || project?.loop_batch_id
    || startedExecutionDecision?.batch_id
    || null;
}

function evaluatePendingApprovalExecution(project, workItem, executionDecision, startedExecutionDecision) {
  const decisionAction = executionDecision?.action || null;
  const decisionBatchId = resolvePendingApprovalBatchId(
    project,
    workItem,
    executionDecision,
    startedExecutionDecision
  );

  if (!decisionBatchId) {
    return {
      should_ship: false,
      reason: 'pending_approval_not_submitted',
      decision_action: decisionAction,
      decision_batch_id: null,
    };
  }

  const batchTasks = listTasksForFactoryBatch(decisionBatchId);
  if (batchTasks.length === 0) {
    return {
      should_ship: false,
      reason: 'pending_approval_not_submitted',
      decision_action: decisionAction,
      decision_batch_id: decisionBatchId,
    };
  }

  const failedTask = batchTasks.find((task) => PENDING_APPROVAL_FAILURE_TASK_STATUSES.has(task.status));
  if (failedTask) {
    return {
      should_ship: false,
      reason: `pending_approval_task_${failedTask.status}`,
      decision_action: decisionAction,
      decision_batch_id: decisionBatchId,
    };
  }

  const unfinishedTask = batchTasks.find((task) => !PENDING_APPROVAL_SUCCESS_TASK_STATUSES.has(task.status));
  if (unfinishedTask) {
    return {
      should_ship: false,
      reason: 'pending_approval_in_progress',
      decision_action: decisionAction,
      decision_batch_id: decisionBatchId,
    };
  }

  return {
    should_ship: true,
    reason: 'execute_completed_successfully',
    decision_action: decisionAction,
    decision_batch_id: decisionBatchId,
  };
}

function evaluateWorkItemShipping(project, workItem, options = {}) {
  const projectId = typeof project === 'string' ? project : project?.id;
  const normalizedWorkItemId = normalizeWorkItemId(workItem?.id ?? workItem);
  const executionDecision = getLatestExecutionDecisionForWorkItem(projectId, normalizedWorkItemId);
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
    if ((outcome.execution_mode || null) === 'pending_approval') {
      return evaluatePendingApprovalExecution(
        typeof project === 'string' ? null : project,
        typeof workItem === 'object' ? workItem : { id: normalizedWorkItemId },
        executionDecision,
        options.startedExecutionDecision || null
      );
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

async function maybeShipWorkItemAfterLearn(project_id, batch_id, instance) {
  try {
    const project = getProjectOrThrow(project_id);
    const rememberedWorkItemId = normalizeWorkItemId(selectedWorkItemIds.get(instance.id));
    const startedExecutionDecision = getLatestStartedExecutionDecision(project_id);
    const workItemId = rememberedWorkItemId || normalizeWorkItemId(instance?.work_item_id) || getDecisionRowWorkItemId(startedExecutionDecision);
    const resolutionSource = rememberedWorkItemId ? 'tracked_selection' : 'started_execution';
    const decisionBatchId = batch_id
      || startedExecutionDecision?.outcome?.batch_id
      || instance?.batch_id
      || project.loop_batch_id
      || startedExecutionDecision?.batch_id
      || null;

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

    rememberSelectedWorkItem(instance.id, workItem);

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

    const shippingDecision = evaluateWorkItemShipping(project, workItem, {
      startedExecutionDecision,
    });
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

    // Merge the factory worktree into main before marking the work item
    // shipped. If merge fails, leave the item open with a skipped_shipping
    // decision so the operator can resolve the conflict.
    const worktreeRecord = (batch_id || instance?.batch_id)
      ? factoryWorktrees.getActiveWorktreeByBatch(batch_id || instance?.batch_id)
      : factoryWorktrees.getActiveWorktree(project_id);
    const worktreeRunnerAvailable = getWorktreeRunner();
    const worktreeRunner = worktreeRecord ? worktreeRunnerAvailable : null;

    // Fail loud when the runner is available but no active worktree is
    // found. Either the worktree was abandoned manually, cleaned up by a
    // restart janitor, or the EXECUTE batch never created one — none of
    // which are states where we should silently mark the item shipped.
    // Exception: if a prior loop already merged a worktree for this item,
    // it's genuinely done and marking shipped is correct.
    if (worktreeRunnerAvailable && !worktreeRecord) {
      const priorWorktree = factoryWorktrees.getLatestWorktreeForWorkItem(
        project_id,
        workItem.id,
      );
      if (!priorWorktree || priorWorktree.status !== 'merged') {
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.LEARN,
          action: 'skipped_shipping',
          reasoning: 'LEARN found no active worktree to merge and no prior merged worktree for this work item. Refusing to ship without landing code on main.',
          inputs: {
            batch_id: batch_id || instance?.batch_id || null,
            resolution_source: resolutionSource,
            work_item_status: workItem.status,
          },
          outcome: {
            work_item_id: workItem.id,
            reason: priorWorktree
              ? `prior_worktree_status=${priorWorktree.status}`
              : 'no_worktree_record',
            prior_worktree_id: priorWorktree ? priorWorktree.id : null,
            prior_worktree_status: priorWorktree ? priorWorktree.status : null,
          },
          confidence: 1,
          batch_id: shippingDecision.decision_batch_id || decisionBatchId,
        });
        return {
          status: 'skipped',
          reason: priorWorktree
            ? `worktree_not_merged_status=${priorWorktree.status}`
            : 'no_worktree_for_batch',
          work_item_id: workItem.id,
        };
      }
      // priorWorktree is merged → the code already landed in a prior
      // loop, this LEARN is just catching up the work item status.
    }

    if (worktreeRecord && worktreeRunner) {
      try {
        // Use the worktree's base_branch as merge target — not all projects
        // use 'main' (example-project uses 'master').
        const mergeTarget = worktreeRecord.base_branch || worktreeRecord.baseBranch || 'main';
        const mergeResult = await worktreeRunner.mergeToMain({
          id: worktreeRecord.vcWorktreeId,
          branch: worktreeRecord.branch,
          target: mergeTarget,
          strategy: 'merge',
        });
        factoryWorktrees.markMerged(worktreeRecord.id);
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.LEARN,
          action: 'worktree_merged',
          reasoning: `Merged factory worktree ${worktreeRecord.branch} into main.`,
          outcome: {
            branch: worktreeRecord.branch,
            target_branch: 'main',
            strategy: mergeResult && mergeResult.strategy,
            cleaned: mergeResult && mergeResult.cleaned,
            worktree_id: worktreeRecord.vcWorktreeId,
            factory_worktree_id: worktreeRecord.id,
          },
          confidence: 1,
          batch_id: shippingDecision.decision_batch_id || decisionBatchId,
        });
        if (mergeResult && mergeResult.cleanup_failed) {
          logger.warn('worktree cleanup failed after successful merge; marking work item shipped', {
            project_id,
            branch: worktreeRecord.branch,
            worktree_path: worktreeRecord.worktreePath,
            err: mergeResult.cleanup_error,
          });
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.LEARN,
            action: 'worktree_merged_cleanup_failed',
            reasoning: `Merged factory worktree ${worktreeRecord.branch} into main, but cleanup failed afterward.`,
            outcome: {
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              worktree_id: worktreeRecord.vcWorktreeId,
              factory_worktree_id: worktreeRecord.id,
              target_branch: 'main',
              strategy: mergeResult.strategy,
              cleaned: false,
              cleanup_failed: true,
              cleanup_error: mergeResult.cleanup_error || null,
            },
            confidence: 1,
            batch_id: shippingDecision.decision_batch_id || decisionBatchId,
          });
        }
      } catch (err) {
        logger.warn('worktree merge failed; leaving work item open', {
          project_id,
          branch: worktreeRecord.branch,
          err: err.message,
        });
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.LEARN,
          action: 'worktree_merge_failed',
          reasoning: `Merge failed: ${err.message}. Work item stays open for operator resolution.`,
          outcome: {
            branch: worktreeRecord.branch,
            worktree_path: worktreeRecord.worktreePath,
            worktree_id: worktreeRecord.vcWorktreeId,
            factory_worktree_id: worktreeRecord.id,
            error: err.message,
          },
          confidence: 1,
          batch_id: shippingDecision.decision_batch_id || decisionBatchId,
        });
        return {
          status: 'skipped',
          reason: 'worktree_merge_failed',
          work_item_id: workItem.id,
          error: err.message,
        };
      }
    }

    const updatedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
      status: 'shipped',
    });
    rememberSelectedWorkItem(instance.id, updatedWorkItem);
    factoryIntake.releaseClaimForInstance(instance.id);

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

function executeSenseStage(project_id, instance = null) {
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
    batch_id: getDecisionBatchId(project, null, null, instance),
  });

  logger.info('SENSE stage executed', { project_id });
  return summary;
}

function getLoopWorkItem(project_id, options = {}) {
  const allowedClaimedBy = options.allowedClaimedBy || null;
  const items = factoryIntake.listOpenWorkItems({ project_id, limit: 100 })
    .filter((item) => !item.claimed_by_instance_id || item.claimed_by_instance_id === allowedClaimedBy);
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

function tryGetLoopWorkItem(project_id, options = {}) {
  try {
    return getLoopWorkItem(project_id, options);
  } catch (error) {
    logger.debug({ err: error.message, project_id }, 'Unable to resolve loop work item for decision context');
  }
  return null;
}

function healAlreadyShippedWorkItem(project_id, item) {
  // Self-heal: if an open work item already has a merged factory_worktrees
  // row, its EXECUTE batch shipped but the work-item status update didn't
  // land (crash between markMerged and updateWorkItem, or loop interrupted
  // at LEARN). Advance the item to 'shipped' now so PRIORITIZE won't
  // re-pick it and trigger a duplicate EXECUTE.
  try {
    const latest = factoryWorktrees.getLatestWorktreeForWorkItem(project_id, item.id);
    if (!latest || latest.status !== 'merged') {
      return null;
    }
    const healed = factoryIntake.updateWorkItem(item.id, { status: 'shipped' });
    safeLogDecision({
      project_id,
      stage: LOOP_STATES.PRIORITIZE,
      action: 'healed_already_shipped',
      reasoning: 'Self-heal: work item had a merged factory worktree but status was non-terminal. Advancing to shipped before PRIORITIZE re-picks.',
      inputs: {
        work_item_id: item.id,
        previous_status: item.status,
      },
      outcome: {
        work_item_id: item.id,
        previous_status: item.status,
        new_status: 'shipped',
        factory_worktree_id: latest.id,
        branch: latest.branch,
        merged_at: latest.mergedAt || latest.merged_at || null,
      },
      confidence: 1,
      batch_id: latest.batchId || latest.batch_id || null,
    });
    return healed;
  } catch (err) {
    logger.warn('factory self-heal check for merged worktree failed', {
      project_id,
      work_item_id: item?.id,
      err: err.message,
    });
    return null;
  }
}

function claimNextWorkItemForInstance(project_id, instance_id) {
  const openItems = factoryIntake.listOpenWorkItems({ project_id, limit: 100 });
  if (!Array.isArray(openItems) || openItems.length === 0) {
    return { openItems: [], workItem: null };
  }

  // Pre-pass: heal any items whose worktrees already merged. These must not
  // be considered for PRIORITIZE — they already shipped; the EXECUTE was
  // just never closed out cleanly.
  const survivors = [];
  for (const item of openItems) {
    if (!item) continue;
    const healed = healAlreadyShippedWorkItem(project_id, item);
    if (healed) {
      continue; // dropped from candidates
    }
    survivors.push(item);
  }

  const orderedCandidates = [];
  for (const status of WORK_ITEM_STATUS_ORDER) {
    orderedCandidates.push(...survivors.filter((item) => item && item.status === status));
  }
  orderedCandidates.push(...survivors.filter((item) => !orderedCandidates.includes(item)));

  for (const item of orderedCandidates) {
    if (!item) {
      continue;
    }
    if (item.claimed_by_instance_id === instance_id) {
      return { openItems: survivors, workItem: item };
    }
    if (item.claimed_by_instance_id) {
      continue;
    }

    const claimed = factoryIntake.claimWorkItem(item.id, instance_id);
    if (claimed) {
      return { openItems: survivors, workItem: claimed };
    }
  }

  return { openItems: survivors, workItem: null };
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

function executePrioritizeStage(project, instance, selectedWorkItem = null) {
  const claimResult = selectedWorkItem
    ? { openItems: factoryIntake.listOpenWorkItems({ project_id: project.id, limit: 100 }), workItem: selectedWorkItem }
    : claimNextWorkItemForInstance(project.id, instance.id);
  const openItems = claimResult.openItems;
  const workItem = claimResult.workItem;

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
    batch_id: getDecisionBatchId(project, workItem, null, instance),
  });

  if (!workItem) {
    clearSelectedWorkItem(instance.id);
    updateInstanceAndSync(instance.id, { work_item_id: null });
    return {
      work_item: null,
      reason: 'no open work item selected',
      stage_result: null,
    };
  }

  // Auto-detect already-shipped items before wasting execution cycles.
  // If git commit subjects match the item's title (meaning a human or
  // prior session already fixed this), mark it shipped and re-select.
  try {
    const { createShippedDetector } = require('./shipped-detector');
    const detector = createShippedDetector({ repoRoot: project.path });
    const planContent = workItem.origin?.plan_path && fs.existsSync(workItem.origin.plan_path)
      ? fs.readFileSync(workItem.origin.plan_path, 'utf8')
      : workItem.description || '';
    const detection = detector.detectShipped({ content: planContent, title: workItem.title });
    if (detection.shipped && detection.confidence !== 'low') {
      factoryIntake.updateWorkItem(workItem.id, { status: 'shipped' });
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.PRIORITIZE,
        action: 'auto_shipped_at_prioritize',
        reasoning: `Shipped-detector found existing commits matching "${workItem.title}" with ${detection.confidence} confidence — skipping to next item.`,
        inputs: { ...getWorkItemDecisionContext(workItem) },
        outcome: {
          work_item_id: workItem.id,
          confidence: detection.confidence,
          signals: detection.signals,
        },
        confidence: 1,
        batch_id: getDecisionBatchId(project, workItem, null, instance),
      });
      logger.info('PRIORITIZE auto-shipped already-done item', {
        project_id: project.id,
        work_item_id: workItem.id,
        title: workItem.title,
        confidence: detection.confidence,
      });
      // Re-select next item recursively (bounded by open item count)
      return executePrioritizeStage(project, instance);
    }
  } catch (_e) { void _e; }

  const scoring = scoreWorkItemForPrioritize(workItem, openItems);
  const updatedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
    priority: scoring.newPriority,
  });
  rememberSelectedWorkItem(instance.id, updatedWorkItem);
  updateInstanceAndSync(instance.id, { work_item_id: updatedWorkItem.id });

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
    batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
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
  // Accept common variations: "## Task 1:", "## Task 1.", "## Task 1 -",
  // "### Task 1:", "## Step 1:", "## 1.", "## 1:"
  const taskMatch = raw.match(/^#{2,3}\s+(?:Task|Step)?\s*\d+\s*[:.—\-]\s*.+$/m)
    || raw.match(/^#{2,3}\s+\d+[.:]\s*.+$/m);
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
  // handleAwaitTask returns a heartbeat response every `heartbeat_minutes`
  // (default 5) while the task is still running. Pre-fix, the first
  // heartbeat ended this function with task.status='running' →
  // verify_status='failed' → plan-executor declared the task a failure
  // even though <git-user> was making progress. Loop on heartbeat responses
  // until the task actually reaches a terminal state (or the underlying
  // timeout_minutes budget — default 60 — is exhausted).
  const terminalStates = new Set(['completed', 'failed', 'cancelled', 'skipped']);
  // Cap at 20 iterations so a misbehaving heartbeat stream can't spin
  // forever. At 5-min heartbeats that's ~100 minutes, which exceeds the
  // default timeout_minutes=60 anyway — we'll exit via timeout first.
  const MAX_ITERATIONS = 20;

  let awaitResult = null;
  let task = null;
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    awaitResult = await handleAwaitTask(args);
    task = taskCore.getTask(args.task_id);
    if (!task) break;
    if (terminalStates.has(task.status)) break;
  }

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

function getPlanReviewProvidersHealth() {
  try {
    const providerRoutingCore = require('../db/provider-routing-core');
    const serverConfig = require('../config');
    const providerNames = ['claude-cli', 'anthropic', 'deepinfra'];

    return providerNames.map((providerName) => {
      let providerConfig = null;
      try {
        providerConfig = providerRoutingCore.getProvider(providerName);
      } catch {
        providerConfig = null;
      }

      const apiKeyConfigured = providerName === 'claude-cli'
        ? Boolean(serverConfig.getApiKey('anthropic'))
        : Boolean(serverConfig.getApiKey(providerName));
      const enabled = providerName === 'anthropic'
        ? (providerConfig ? Boolean(providerConfig.enabled) : apiKeyConfigured)
        : Boolean(providerConfig?.enabled);

      return {
        provider: providerName,
        enabled,
        healthy: typeof providerRoutingCore.isProviderHealthy === 'function'
          ? providerRoutingCore.isProviderHealthy(providerName)
          : true,
        api_key_configured: apiKeyConfigured,
      };
    });
  } catch (error) {
    logger.debug({ err: error.message }, 'Unable to resolve plan review providers');
    return [];
  }
}

async function reviewAutoGeneratedPlan(project, workItem, planContent) {
  const providerHealth = getPlanReviewProvidersHealth();
  const generatorProvider = workItem?.origin?.plan_generator_provider || '<git-user>';
  const selectedReviewers = selectReviewers(providerHealth, generatorProvider);
  if (selectedReviewers.length === 0) {
    return {
      overall: 'approve',
      reviews: [],
      skipped: true,
    };
  }

  const { handleSmartSubmitTask } = require('../handlers/integration/routing');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');
  const reviewer = createPlanReviewer({
    submit: async (args) => {
      const result = await handleSmartSubmitTask({
        ...args,
        project: 'factory-review',
        working_directory: project.path || process.cwd(),
      });
      return { task_id: result?.task_id || null, content: result?.content || [] };
    },
    awaitTask: async (args) => {
      const awaitResult = await handleAwaitTask(args);
      const task = taskCore.getTask(args.task_id);

      return {
        task_id: args.task_id,
        status: task?.status || 'failed',
        output: extractTextContent(task?.output) || extractTextContent(awaitResult),
        error: task?.error_output || extractTextContent(awaitResult) || null,
      };
    },
    getProvidersHealth: () => providerHealth,
  });

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.PLAN,
    action: 'plan_review_started',
    reasoning: `submitted plan review to ${selectedReviewers.length} reviewer(s)`,
    inputs: {
      ...getWorkItemDecisionContext(workItem),
      reviewer_count: selectedReviewers.length,
    },
    outcome: {
      reviewers: selectedReviewers.map((entry) => entry.name),
      reviewer_count: selectedReviewers.length,
    },
    confidence: 1,
    batch_id: getDecisionBatchId(project, workItem),
  });

  const result = await reviewer.review({ workItem, planContent });
  for (const review of result.reviews) {
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.PLAN,
      action: 'plan_review_verdict',
      reasoning: `reviewer=${review.name} verdict=${review.verdict}`,
      inputs: {
        ...getWorkItemDecisionContext(workItem),
        reviewer: review.name,
      },
      outcome: {
        reviewer: review.name,
        provider: review.provider,
        verdict: review.verdict,
        confidence: review.confidence,
        concerns: review.concerns,
        suggestions: review.suggestions,
        task_id: review.task_id || null,
        reason: review.reason || null,
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, workItem),
    });
  }

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.PLAN,
    action: 'plan_review_aggregated',
    reasoning: `overall=${result.overall}`,
    inputs: {
      ...getWorkItemDecisionContext(workItem),
      reviewer_count: result.reviews.length,
    },
    outcome: {
      overall: result.overall,
      reviewer_count: result.reviews.length,
      has_warnings: result.overall === 'request_changes',
      blocked: result.overall === 'block',
    },
    confidence: 1,
    batch_id: getDecisionBatchId(project, workItem),
  });

  if (result.overall === 'block') {
    logger.warn('PLAN review blocked execution of auto-generated plan', {
      project_id: project.id,
      work_item_id: workItem.id,
      reviewer_count: result.reviews.length,
    });
  } else if (result.overall === 'request_changes') {
    logger.warn('PLAN review requested changes but execution will proceed', {
      project_id: project.id,
      work_item_id: workItem.id,
      reviewer_count: result.reviews.length,
    });
  } else {
    logger.info('PLAN review approved auto-generated plan', {
      project_id: project.id,
      work_item_id: workItem.id,
      reviewer_count: result.reviews.length,
    });
  }

  return result;
}

function lintAutoGeneratedPlan(project, workItem, planContent) {
  const lintResult = architectRunner.lintPlanContent(planContent);
  const batchId = getDecisionBatchId(project, workItem);

  if (lintResult.errors.length > 0) {
    logger.warn('PLAN lint rejected auto-generated plan', {
      project_id: project.id,
      work_item_id: workItem?.id ?? null,
      error_count: lintResult.errors.length,
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.PLAN,
      action: 'plan_lint_rejected',
      reasoning: `plan lint rejected auto-generated plan with ${lintResult.errors.length} error(s)`,
      inputs: {
        ...getWorkItemDecisionContext(workItem),
      },
      outcome: {
        errors: lintResult.errors,
      },
      confidence: 1,
      batch_id: batchId,
    });
    return {
      blocked: true,
      lintResult,
    };
  }

  if (lintResult.warnings.length > 0) {
    logger.warn('PLAN lint produced warnings for auto-generated plan', {
      project_id: project.id,
      work_item_id: workItem?.id ?? null,
      warning_count: lintResult.warnings.length,
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.PLAN,
      action: 'plan_lint_warnings',
      reasoning: `plan lint produced ${lintResult.warnings.length} warning(s)`,
      inputs: {
        ...getWorkItemDecisionContext(workItem),
      },
      outcome: {
        warnings: lintResult.warnings,
      },
      confidence: 1,
      batch_id: batchId,
    });
  }

  return {
    blocked: false,
    lintResult,
  };
}

async function executePlanStage(project, instance, selectedWorkItem = null) {
  let workItem = selectedWorkItem || getSelectedWorkItem(instance, project.id, {
    fallbackToLoopSelection: true,
  });

  if (workItem) {
    rememberSelectedWorkItem(instance.id, workItem);
    updateInstanceAndSync(instance.id, { work_item_id: workItem.id });
  }

  if (workItem?.origin?.plan_path && fs.existsSync(workItem.origin.plan_path)) {
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

async function executeNonPlanFileStage(project, instance, workItem) {
  const targetItem = workItem || getSelectedWorkItem(instance, project.id, {
    fallbackToLoopSelection: true,
  });
  if (!targetItem) {
    return null;
  }

  rememberSelectedWorkItem(instance.id, targetItem);
  updateInstanceAndSync(instance.id, { work_item_id: targetItem.id });
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
        generator: '<git-user>',
        generation_task_id: null,
        ...getWorkItemDecisionContext(targetItem),
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, targetItem, null, instance),
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
    plan_generator_provider: '<git-user>',
  };

  if (fs.existsSync(planPath)) {
    const updatedWorkItem = factoryIntake.updateWorkItem(targetItem.id, {
      origin_json: nextOrigin,
      status: 'executing',
    });
    rememberSelectedWorkItem(instance.id, updatedWorkItem);
    const existingPlanContent = fs.readFileSync(planPath, 'utf8');
    const lint = lintAutoGeneratedPlan(project, updatedWorkItem, existingPlanContent);
    if (lint.blocked) {
      return {
        reason: 'plan lint rejected execution',
        work_item: updatedWorkItem,
        stop_execution: true,
        next_state: LOOP_STATES.PAUSED,
        paused_at_stage: LOOP_STATES.PLAN_REVIEW,
        stage_result: {
          status: 'paused',
          reason: 'plan_lint_rejected',
          errors: lint.lintResult.errors,
          plan_path: planPath,
        },
      };
    }
    // Skip plan review for autonomous/dark trust — these projects opted
    // out of human approval gates. Log the review but don't block.
    const trustLevel = project.trust_level || 'supervised';
    if (trustLevel !== 'autonomous' && trustLevel !== 'dark') {
      const planReview = await reviewAutoGeneratedPlan(project, updatedWorkItem, existingPlanContent);
      if (planReview.overall === 'block') {
        return {
          reason: 'plan review blocked execution',
          work_item: updatedWorkItem,
          stop_execution: true,
          next_state: LOOP_STATES.PAUSED,
          paused_at_stage: LOOP_STATES.PLAN_REVIEW,
          stage_result: {
            status: 'paused',
            reason: 'plan_review_blocked',
            overall: planReview.overall,
            reviews: planReview.reviews,
            plan_path: planPath,
          },
        };
      }
    }
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
      provider: '<git-user>',
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

    // heartbeat_minutes: 0 disables periodic heartbeat returns — we want
    // handleAwaitTask to block until the task is truly terminal, not yield
    // at 5 minutes for a status snapshot we'd misinterpret as failure.
    const awaitResult = await handleAwaitTask({ task_id: generationTaskId, timeout_minutes: 10, heartbeat_minutes: 0 });
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
    rememberSelectedWorkItem(instance.id, updatedWorkItem);

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
      reasoning: 'generated plan via <git-user> for non-plan-file work item',
      inputs: {
        ...getWorkItemDecisionContext(targetItem),
      },
      outcome: {
        work_item_id: updatedWorkItem.id,
        plan_path: planPath,
        generator: '<git-user>',
        generation_task_id: generationTaskId,
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
    });

    const lint = lintAutoGeneratedPlan(project, updatedWorkItem, normalizedPlanMarkdown);
    if (lint.blocked) {
      return {
        reason: 'plan lint rejected execution',
        work_item: updatedWorkItem,
        stop_execution: true,
        next_state: LOOP_STATES.PAUSED,
        paused_at_stage: LOOP_STATES.PLAN_REVIEW,
        stage_result: {
          status: 'paused',
          reason: 'plan_lint_rejected',
          errors: lint.lintResult.errors,
          plan_path: planPath,
          generator: '<git-user>',
          generation_task_id: generationTaskId,
        },
      };
    }

    if (trustLevel !== 'autonomous' && trustLevel !== 'dark') {
      const planReview = await reviewAutoGeneratedPlan(project, updatedWorkItem, normalizedPlanMarkdown);
      if (planReview.overall === 'block') {
        return {
          reason: 'plan review blocked execution',
          work_item: updatedWorkItem,
          stop_execution: true,
          next_state: LOOP_STATES.PAUSED,
          paused_at_stage: LOOP_STATES.PLAN_REVIEW,
          stage_result: {
            status: 'paused',
            reason: 'plan_review_blocked',
            overall: planReview.overall,
            reviews: planReview.reviews,
            plan_path: planPath,
            generator: '<git-user>',
            generation_task_id: generationTaskId,
          },
        };
      }
    }

    return {
      reason: 'generated plan via <git-user>',
      work_item: updatedWorkItem,
      stage_result: {
        plan_path: planPath,
        generator: '<git-user>',
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
    // Reject the work item so the factory moves to the next one instead
    // of retrying plan generation forever in an infinite loop.
    try {
      factoryIntake.updateWorkItem(targetItem.id, {
        status: 'rejected',
        reject_reason: `cannot_generate_plan: ${error.message}`.slice(0, 200),
      });
    } catch (_e) { void _e; }
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
        generator: 'plan-generator',
        generation_task_id: generationTaskId,
        ...getWorkItemDecisionContext(targetItem),
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, targetItem, null, instance),
    });
    return {
      reason: error.message,
      work_item: targetItem,
      stop_execution: true,
      next_state: LOOP_STATES.IDLE,
    };
  }
}

async function executePlanFileStage(project, instance, workItem) {
  const targetItem = workItem || getSelectedWorkItem(instance, project.id, {
    fallbackToLoopSelection: true,
  });
  if (!targetItem?.origin?.plan_path || !fs.existsSync(targetItem.origin.plan_path)) {
    return null;
  }
  rememberSelectedWorkItem(instance.id, targetItem);
  const executeLogBatchId = getFactorySubmissionBatchId(project, targetItem, instance);
  updateInstanceAndSync(instance.id, {
    work_item_id: targetItem.id,
    batch_id: executeLogBatchId,
  });

  // Create an isolated worktree for this batch so <git-user> edits never touch the
  // live project.path. Falls back to project.path only when the worktree
  // runner is unavailable (e.g. db not wired in a test environment) — the
  // warning is surfaced by getWorktreeRunner.
  const worktreeRunner = getWorktreeRunner();
  let worktreeRecord = null;
  let executionWorkingDirectory = project.path;
  if (worktreeRunner) {
    let createdWorktree = null;
    try {
      createdWorktree = await worktreeRunner.createForBatch({
        project,
        workItem: targetItem,
        batchId: executeLogBatchId,
      });
      // Reclaim any stale 'active' factory_worktrees row that would block
      // the UNIQUE(branch, status='active') index. This happens when a
      // previous EXECUTE failed mid-flight (or its instance got terminated)
      // and the row was never marked merged/abandoned. Without this, the
      // retry deterministically fails with UNIQUE constraint failed —
      // blocking the same work item forever.
      const stale = factoryWorktrees.getActiveWorktreeByBranch(createdWorktree.branch);
      if (stale) {
        logger.warn('factory worktree: reclaiming stale active row before retry', {
          project_id: project.id,
          work_item_id: targetItem.id,
          branch: createdWorktree.branch,
          stale_factory_worktree_id: stale.id,
          stale_batch_id: stale.batch_id,
        });
        factoryWorktrees.markAbandoned(stale.id, 'reclaim_before_retry');
        if (typeof worktreeRunner.abandon === 'function' && stale.vcWorktreeId) {
          try {
            await worktreeRunner.abandon({
              id: stale.vcWorktreeId,
              branch: stale.branch,
              reason: 'reclaim_before_retry',
            });
          } catch (cleanupErr) {
            logger.warn('factory worktree: stale vc cleanup best-effort failed', {
              project_id: project.id,
              stale_vc_worktree_id: stale.vcWorktreeId,
              err: cleanupErr.message,
            });
          }
        }
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.EXECUTE,
          action: 'worktree_reclaimed',
          reasoning: 'Abandoned stale active factory_worktrees row so new EXECUTE can proceed.',
          inputs: { ...getWorkItemDecisionContext(targetItem) },
          outcome: {
            stale_factory_worktree_id: stale.id,
            stale_batch_id: stale.batch_id,
            branch: stale.branch,
          },
          confidence: 1,
          batch_id: executeLogBatchId,
        });
      }
      worktreeRecord = factoryWorktrees.recordWorktree({
        project_id: project.id,
        work_item_id: targetItem.id,
        batch_id: executeLogBatchId,
        vc_worktree_id: createdWorktree.id,
        branch: createdWorktree.branch,
        worktree_path: createdWorktree.worktreePath,
      });
      executionWorkingDirectory = worktreeRecord.worktreePath;
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'worktree_created',
        reasoning: `Created isolated worktree for factory batch ${executeLogBatchId}.`,
        inputs: { ...getWorkItemDecisionContext(targetItem) },
        outcome: {
          worktree_id: worktreeRecord.vcWorktreeId,
          factory_worktree_id: worktreeRecord.id,
          worktree_path: worktreeRecord.worktreePath,
          branch: worktreeRecord.branch,
          batch_id: executeLogBatchId,
        },
        confidence: 1,
        batch_id: executeLogBatchId,
      });
    } catch (err) {
      if (createdWorktree && !worktreeRecord && typeof worktreeRunner.abandon === 'function') {
        try {
          await worktreeRunner.abandon({
            id: createdWorktree.id,
            branch: createdWorktree.branch,
            reason: 'persistence_failed',
          });
        } catch (cleanupErr) {
          logger.warn('factory worktree cleanup failed after persistence error', {
            project_id: project.id,
            work_item_id: targetItem.id,
            branch: createdWorktree.branch,
            err: cleanupErr.message,
          });
        }
      }
      logger.error('factory worktree creation failed; pausing instance at EXECUTE', {
        project_id: project.id,
        work_item_id: targetItem.id,
        err: err.message,
      });
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'worktree_creation_failed',
        reasoning: `Worktree creation failed: ${err.message}. Pausing at EXECUTE — operator must resolve before retry. Running against main worktree would risk workspace corruption.`,
        inputs: { ...getWorkItemDecisionContext(targetItem) },
        outcome: { error: err.message, next_state: LOOP_STATES.PAUSED, paused_at_stage: LOOP_STATES.EXECUTE },
        confidence: 1,
        batch_id: executeLogBatchId,
      });
      factoryIntake.updateWorkItem(targetItem.id, {
        status: 'in_progress',
        reject_reason: `worktree_creation_failed: ${err.message}`,
      });
      return {
        reason: `worktree creation failed: ${err.message}`,
        work_item: targetItem,
        stop_execution: true,
        next_state: LOOP_STATES.PAUSED,
        paused_at_stage: LOOP_STATES.EXECUTE,
        stage_result: {
          status: 'paused',
          reason: 'worktree_creation_failed',
          error: err.message,
        },
      };
    }
  }

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
      worktree_path: executionWorkingDirectory,
      worktree_branch: worktreeRecord ? worktreeRecord.branch : null,
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
  const decisionBatchId = getDecisionBatchId(project, targetItem, null, instance);
  const submissionBatchId = getFactorySubmissionBatchId(project, targetItem, instance);
  const executeDecisionBatchId = executeMode === 'pending_approval' ? submissionBatchId : decisionBatchId;

  const executor = createPlanExecutor({
    submit: async (args) => {
      const tags = Array.isArray(args.tags) ? [...args.tags] : [];
      // Factory-provenance tags must be attached on EVERY submission,
      // not just pending_approval. The factory-worktree-auto-commit
      // listener keys off factory:batch_id and factory:plan_task_number
      // to correlate a completed <git-user> task back to its worktree. In
      // live/autonomous mode the tags were being dropped, so the
      // listener never committed — untracked <git-user> output piled up in
      // the worktree and LEARN's merge step threw "uncommitted
      // changes" even though the code was ready to ship.
      if (submissionBatchId) tags.push(`factory:batch_id=${submissionBatchId}`);
      tags.push(`factory:work_item_id=${targetItem.id}`);
      tags.push(`factory:plan_task_number=${args.plan_task_number}`);
      if (args.initial_status === 'pending_approval') {
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

  // Resolve the plan file to its copy inside the worktree. Writing ticks
  // (and reading prior tick state) against main's working tree is wrong in
  // two ways: it (1) pollutes main with per-batch progress before the merge
  // commits, and (2) lets phantom [x] markers carried over from a prior
  // corrupted run be treated as "already done", which causes plan-executor
  // to skip every task and ship an empty batch.
  const planPathForExecutor = (() => {
    if (!executionWorkingDirectory || executionWorkingDirectory === project.path) {
      return targetItem.origin.plan_path;
    }
    try {
      const relative = path.relative(project.path, targetItem.origin.plan_path);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return targetItem.origin.plan_path;
      }
      const worktreeCopy = path.join(executionWorkingDirectory, relative);
      return fs.existsSync(worktreeCopy) ? worktreeCopy : targetItem.origin.plan_path;
    } catch (_err) {
      void _err;
      return targetItem.origin.plan_path;
    }
  })();

  const result = await executor.execute({
    plan_path: planPathForExecutor,
    project: project.name,
    working_directory: executionWorkingDirectory,
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

const MAX_AUTO_VERIFY_RETRIES = 3;

function stripAnsi(text) {
  return typeof text === 'string'
    ? text.replace(/\u001b\[[0-9;]*m/g, '')
    : '';
}

function buildVerifyFixPrompt({ planPath, planTitle, branch, verifyCommand, verifyOutput }) {
  const tail = stripAnsi(String(verifyOutput || '')).slice(-4000);
  const lines = [
    `Plan: ${planTitle || '(unknown)'}`,
    planPath ? `Plan path: ${planPath}` : null,
    `Factory branch: ${branch}`,
    `Verify command: ${verifyCommand}`,
    '',
    'The plan tasks for this batch were implemented, but the verify step failed. Read the error output below and make the minimum changes needed to turn the failures green. Common issues: a test that references a module the plan forgot to update, an alignment/invariant test that needs the new entry registered, a stale snapshot, a missing import, a type mismatch, or a lint rule violation.',
    '',
    'Constraints:',
    '- Edit only files in this worktree.',
    '- Do NOT revert the plan\'s intended changes — fix forward.',
    '- Prefer updating the failing test assertions ONLY if the plan is clearly the authoritative spec and the test is out of date. Otherwise update the production code so the test passes.',
    '- Do not run the full verify suite yourself. Targeted re-runs of the specific failing file are fine.',
    '',
    'Verify output (tail):',
    '```',
    tail,
    '```',
    '',
    'After making the edits, stop.',
  ].filter((x) => x !== null);
  return lines.join('\n');
}

async function submitVerifyFixTask({
  project_id,
  batch_id,
  worktreeRecord,
  workItem,
  verifyCommand,
  verifyOutput,
  attempt,
}) {
  const { handleSmartSubmitTask } = require('../handlers/integration/routing');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');

  const project = factoryHealth.getProject(project_id);
  const planPath = workItem?.origin?.plan_path || null;
  const planTitle = workItem?.title || workItem?.origin?.title || null;

  const prompt = buildVerifyFixPrompt({
    planPath,
    planTitle,
    branch: worktreeRecord.branch,
    verifyCommand,
    verifyOutput,
  });

  // plan_task_number tag makes factory-worktree-auto-commit listener
  // commit this task's output to the branch. Without it, <git-user>'s retry
  // edits sit uncommitted in the worktree and the re-run of remote
  // verify runs against the same failing state. Use a synthetic
  // number beyond the plan's real task range so it doesn't collide.
  const retryPlanTaskNumber = 1000 + attempt;
  const tags = [
    `factory:batch_id=${batch_id}`,
    `factory:work_item_id=${workItem?.id ?? 'unknown'}`,
    `factory:plan_task_number=${retryPlanTaskNumber}`,
    `factory:verify_retry=${attempt}`,
  ];

  safeLogDecision({
    project_id,
    stage: LOOP_STATES.VERIFY,
    action: 'verify_retry_submitted',
    reasoning: `Auto-retry #${attempt}: submitting a fix task to <git-user> with the verify error as context.`,
    inputs: {
      branch: worktreeRecord.branch,
      attempt,
      plan_path: planPath,
    },
    outcome: {
      attempt,
      branch: worktreeRecord.branch,
      max_retries: MAX_AUTO_VERIFY_RETRIES,
    },
    confidence: 1,
    batch_id,
  });

  let submission;
  try {
    submission = await handleSmartSubmitTask({
      task: prompt,
      project: project?.name,
      working_directory: worktreeRecord.worktreePath,
      tags,
      task_metadata: {
        plan_path: planPath,
        plan_title: planTitle,
        plan_task_title: `verify auto-retry #${attempt}`,
        factory_retry_attempt: attempt,
        factory_batch_id: batch_id,
      },
    });
  } catch (err) {
    return { submitted: false, reason: 'submit_threw', error: err.message };
  }
  const task_id = submission?.task_id;
  if (!task_id) {
    return { submitted: false, reason: 'no_task_id', error: submission?.content?.[0]?.text || 'submit returned no task_id' };
  }

  const awaitResult = await awaitTaskToStructuredResult(handleAwaitTask, taskCore, {
    task_id,
    verify_command: verifyCommand,
    working_directory: worktreeRecord.worktreePath,
  });

  return { submitted: true, task_id, awaitStatus: awaitResult.status, verifyStatus: awaitResult.verify_status, error: awaitResult.error };
}

async function executeVerifyStage(project_id, batch_id, instance = null) {
  // First: run worktree remote verification if there's an active factory
  // worktree for this project. Failure here blocks the loop from reaching
  // LEARN so the operator can decide remediation vs. abandonment before any
  // merge to main.
  const activeBatchId = batch_id || instance?.batch_id || null;
  const worktreeRecord = activeBatchId
    ? factoryWorktrees.getActiveWorktreeByBatch(activeBatchId)
    : factoryWorktrees.getActiveWorktree(project_id);
  const worktreeRunner = worktreeRecord ? getWorktreeRunner() : null;

  // Under pending_approval mode the plan-executor submits tasks and returns
  // immediately. If we reach VERIFY before those tasks actually complete, a
  // remote verify run against the empty branch will fail. Guard: if any batch
  // task is still in a non-terminal state, pause at VERIFY without running
  // the remote tests. The operator re-advances once tasks finish.
  const batchIdForGate = (worktreeRecord && worktreeRecord.batchId) || activeBatchId;
  if (batchIdForGate) {
    const batchTasks = listTasksForFactoryBatch(batchIdForGate);
    if (batchTasks.length > 0) {
      const nonTerminal = batchTasks.filter(
        (t) => !['completed', 'shipped', 'cancelled', 'failed'].includes(t.status),
      );
      if (nonTerminal.length > 0) {
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'waiting_for_batch_tasks',
          reasoning: `VERIFY waiting for ${nonTerminal.length} non-terminal batch task(s) to finish before remote verify.`,
          outcome: {
            batch_id: batchIdForGate,
            pending_count: nonTerminal.length,
            pending_statuses: nonTerminal.map((t) => t.status),
          },
          confidence: 1,
          batch_id: batchIdForGate,
        });
        return {
          status: 'waiting',
          reason: 'batch_tasks_not_terminal',
          pause_at_stage: 'VERIFY',
          pending_count: nonTerminal.length,
        };
      }
    }
  }

  if (worktreeRecord && worktreeRunner) {
    const project = factoryHealth.getProject(project_id);
    const verifyCommand = (project && project.config && project.config.verify_command)
      || 'cd server && npx vitest run';

    // Pull the associated work item so the retry prompt can reference the
    // plan. Best-effort: if we can't resolve it, the retry still runs
    // with less context.
    let workItemForRetry = null;
    try {
      if (instance && instance.work_item_id) {
        workItemForRetry = factoryIntake.getWorkItem(instance.work_item_id);
      } else if (worktreeRecord.workItemId) {
        workItemForRetry = factoryIntake.getWorkItem(worktreeRecord.workItemId);
      }
    } catch (_err) {
      workItemForRetry = null;
    }

    // Auto-retry: if verify fails, submit a fix task to <git-user> with the
    // error output as context, then re-run verify. Bounded at
    // MAX_AUTO_VERIFY_RETRIES. If still failing after that, auto-reject
    // the work item so the loop can advance to the next item.
    let res = null;
    let retryAttempt = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        res = await worktreeRunner.verify({
          worktreePath: worktreeRecord.worktreePath,
          branch: worktreeRecord.branch,
          verifyCommand,
        });
        if (res.passed) {
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'worktree_verify_passed',
            reasoning: `Worktree remote verify passed for branch ${worktreeRecord.branch}${retryAttempt > 0 ? ` (after ${retryAttempt} retry attempt${retryAttempt === 1 ? '' : 's'})` : ''}.`,
            outcome: {
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              duration_ms: res.durationMs,
              verify_command: verifyCommand,
              retry_attempt: retryAttempt,
            },
            confidence: 1,
            batch_id,
          });
          break;
        }
        if (retryAttempt >= MAX_AUTO_VERIFY_RETRIES) {
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'worktree_verify_failed',
            reasoning: `Worktree remote verify FAILED for branch ${worktreeRecord.branch} after ${retryAttempt} auto-retry attempt${retryAttempt === 1 ? '' : 's'}; auto-rejecting the work item and advancing.`,
            outcome: {
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              duration_ms: res.durationMs,
              verify_command: verifyCommand,
              output_preview: String(res.output || '').slice(-1500),
              retry_attempts: retryAttempt,
            },
            confidence: 1,
            batch_id,
          });
          // Before auto-rejecting: check if the work was already done on
          // main (manual fix in a different session). If so, ship it.
          try {
            const { createShippedDetector } = require('./shipped-detector');
            const project = getProjectOrThrow(project_id);
            const wi = instance.work_item_id
              ? factoryIntake.getWorkItem(instance.work_item_id)
              : null;
            if (wi) {
              const detector = createShippedDetector({ repoRoot: project.path });
              const detection = detector.detectShipped({
                content: wi.description || wi.title || '',
                title: wi.title,
              });
              if (detection.shipped && detection.confidence !== 'low') {
                factoryIntake.updateWorkItem(wi.id, { status: 'shipped' });
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'auto_shipped_at_verify_fail',
                  reasoning: `Verify failed but shipped-detector found matching commits on main (${detection.confidence} confidence). Marking shipped instead of auto-rejecting.`,
                  inputs: { work_item_id: wi.id },
                  outcome: { confidence: detection.confidence, signals: detection.signals },
                  confidence: 1,
                  batch_id,
                });
                return { status: 'passed', reason: 'auto_shipped_at_verify_fail' };
              }
            }
          } catch (_e) { void _e; }

          // Auto-reject: mark the work item as rejected and let the loop
          // advance past this item instead of stalling at VERIFY_FAIL.
          if (instance && instance.work_item_id) {
            try {
              factoryIntake.updateWorkItem(instance.work_item_id, {
                status: 'rejected',
                reject_reason: `verify_failed_after_${retryAttempt}_retries`,
              });
            } catch (_e) { void _e; }
          }
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'auto_rejected_verify_fail',
            reasoning: `Auto-rejected work item after ${retryAttempt} verify retries. Advancing to LEARN to process next item.`,
            outcome: { work_item_id: instance?.work_item_id || null, retry_attempts: retryAttempt },
            confidence: 1,
            batch_id,
          });
          return { status: 'passed', reason: 'auto_rejected_after_max_retries' };
        }
        retryAttempt += 1;
        const retryResult = await submitVerifyFixTask({
          project_id,
          batch_id,
          worktreeRecord,
          workItem: workItemForRetry,
          verifyCommand,
          verifyOutput: res.output,
          attempt: retryAttempt,
        });
        if (!retryResult.submitted || retryResult.awaitStatus !== 'completed') {
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'verify_retry_task_failed',
            reasoning: `Auto-retry #${retryAttempt} task did not complete successfully; abandoning retry loop and pausing at VERIFY_FAIL.`,
            outcome: {
              attempt: retryAttempt,
              submitted: retryResult.submitted,
              reason: retryResult.reason || retryResult.awaitStatus || null,
              error: retryResult.error || null,
              branch: worktreeRecord.branch,
            },
            confidence: 1,
            batch_id,
          });
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'worktree_verify_failed',
            reasoning: `Worktree remote verify FAILED and auto-retry #${retryAttempt} did not produce a completed task; pausing loop at VERIFY_FAIL.`,
            outcome: {
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              duration_ms: res.durationMs,
              verify_command: verifyCommand,
              output_preview: String(res.output || '').slice(-1500),
              retry_attempts: retryAttempt,
            },
            confidence: 1,
            batch_id,
          });
          return {
            status: 'failed',
            reason: 'worktree_verify_failed_retry_task_error',
            pause_at_stage: 'VERIFY_FAIL',
            branch: worktreeRecord.branch,
            worktree_path: worktreeRecord.worktreePath,
            verify_output: String(res.output || '').slice(-1500),
            retry_attempts: retryAttempt,
          };
        }
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'verify_retry_task_completed',
          reasoning: `Auto-retry #${retryAttempt} task completed; re-running remote verify.`,
          outcome: {
            attempt: retryAttempt,
            task_id: retryResult.task_id,
            branch: worktreeRecord.branch,
          },
          confidence: 1,
          batch_id,
        });
      }
    } catch (err) {
      logger.warn('worktree verify threw; treating as verify failure', {
        project_id,
        branch: worktreeRecord.branch,
        err: err.message,
      });
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.VERIFY,
        action: 'worktree_verify_errored',
        reasoning: `Worktree verify threw: ${err.message}`,
        outcome: { branch: worktreeRecord.branch, error: err.message },
        confidence: 0.5,
        batch_id,
      });
      return {
        status: 'failed',
        reason: 'worktree_verify_errored',
        pause_at_stage: 'VERIFY_FAIL',
        error: err.message,
      };
    }
  }

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

async function executeLearnStage(project_id, batch_id, instance) {
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
    const shippingResult = await maybeShipWorkItemAfterLearn(project_id, batch_id, instance);
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

function getLoopInstanceForProjectOrThrow(project_id) {
  const instance = getOldestActiveInstance(project_id) || backfillLegacyProjectLoopInstance(project_id);
  if (!instance) {
    throw new Error('Loop not started for this project');
  }
  return instance;
}

function summarizeInstanceState(project, instance) {
  return {
    instance_id: instance.id,
    project_id: project.id,
    loop_state: getCurrentLoopState(instance),
    loop_batch_id: instance.batch_id || null,
    loop_last_action_at: instance.last_action_at || null,
    loop_paused_at_stage: getPausedAtStage(instance),
    work_item_id: instance.work_item_id || null,
    trust_level: project.trust_level,
    gates: getGatesForTrustLevel(project.trust_level),
  };
}

function attachBatchId(project_id, batch_id, instance_id = null) {
  if (!project_id) {
    throw new Error('project_id is required');
  }
  if (!batch_id || typeof batch_id !== 'string') {
    throw new Error('batch_id must be a non-empty string');
  }

  const instance = instance_id
    ? getInstanceOrThrow(instance_id)
    : getLoopInstanceForProjectOrThrow(project_id);
  const project = getProjectOrThrow(instance.project_id);
  const currentState = getCurrentLoopState(instance);
  if (currentState !== LOOP_STATES.PLAN && currentState !== LOOP_STATES.EXECUTE && currentState !== LOOP_STATES.VERIFY) {
    throw new Error(
      `Cannot attach batch_id while loop is in ${currentState}; must be PLAN, EXECUTE, or VERIFY`
    );
  }

  const updated = updateInstanceAndSync(instance.id, {
    batch_id,
    last_action_at: nowIso(),
  });

  logger.info('Factory loop batch_id attached', {
    project_id: project.id,
    instance_id: updated.id,
    batch_id,
    state: currentState,
  });
  return {
    project_id: project.id,
    instance_id: updated.id,
    loop_batch_id: batch_id,
    state: currentState,
  };
}

function attachBatchIdForProject(project_id, batch_id) {
  return attachBatchId(project_id, batch_id, getLoopInstanceForProjectOrThrow(project_id).id);
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
  try {
    const { initFactoryWorktreeAutoCommit } = require('./worktree-auto-commit');
    initFactoryWorktreeAutoCommit({ project });
  } catch (error) {
    logger.warn({ err: error.message, project_id: project.id }, 'Factory worktree auto-commit listener init failed');
  }
  let instance;
  try {
    instance = factoryLoopInstances.createInstance({ project_id: project.id });
  } catch (error) {
    if (error && error.code === 'FACTORY_STAGE_OCCUPIED') {
      throw new StageOccupiedError(project.id, LOOP_STATES.SENSE);
    }
    throw error;
  }

  clearSelectedWorkItem(instance.id);
  syncLegacyProjectLoopState(project.id);

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
      instance_id: instance.id,
    },
    confidence: 1,
    batch_id: null,
  });

  try {
    executeSenseStage(project.id, instance);
  } catch (error) {
    // SENSE failed — terminate the instance we just created so the stage
    // occupancy lock releases. Otherwise the next startLoop attempt hits
    // "Stage SENSE is already occupied" even though the instance is
    // orphaned (never reached PRIORITIZE, no decision log progress).
    try {
      terminateInstanceAndSync(instance.id);
    } catch (cleanupErr) {
      logger.warn('failed to clean up zombie instance after SENSE error', {
        project_id: project.id,
        instance_id: instance.id,
        original_error: error.message,
        cleanup_error: cleanupErr.message,
      });
    }
    logger.warn('Factory loop start failed during SENSE; instance terminated', {
      project_id: project.id,
      instance_id: instance.id,
      err: error.message,
    });
    throw error;
  }

  logger.info('Factory loop started', {
    project_id: project.id,
    instance_id: instance.id,
    state: LOOP_STATES.SENSE,
  });

  return {
    project_id: project.id,
    instance_id: instance.id,
    state: LOOP_STATES.SENSE,
    message: 'Factory loop started',
  };
}

// Start + auto-advance: creates the instance at SENSE, then kicks off the
// auto-advance chain so the entire cycle runs without operator intervention.
// The chain stops at any gate pause (trust-level dependent) or on termination.
function startLoopAutoAdvance(project_id) {
  const result = startLoop(project_id);
  advanceLoopAsync(result.instance_id, { autoAdvance: true });
  return {
    ...result,
    auto_advance: true,
    message: 'Factory loop started with auto-advance',
  };
}

function startLoopForProject(project_id) {
  return startLoop(project_id);
}

function startLoopAutoAdvanceForProject(project_id) {
  return startLoopAutoAdvance(project_id);
}

async function runAdvanceLoop(instance_id) {
  const { project } = getLoopContextOrThrow(instance_id);
  let instance = getInstanceOrThrow(instance_id);
  const previousState = getCurrentLoopState(instance);
  let currentState = previousState;
  let pausedAtStage = getPausedAtStage(instance);

  if (instance.terminated_at || currentState === LOOP_STATES.IDLE) {
    throw new Error('Loop not started for this project');
  }

  if (isReadyForStage(pausedAtStage)) {
    const targetStage = getReadyStage(pausedAtStage);
    const moved = tryMoveInstanceToStage(instance, targetStage, {
      paused_at_stage: getPendingGateStage(previousState, project.trust_level) === targetStage ? targetStage : null,
      batch_id: instance.batch_id,
      work_item_id: instance.work_item_id,
    });
    instance = moved.instance;
    return {
      project_id: project.id,
      instance_id: instance.id,
      previous_state: previousState,
      new_state: getCurrentLoopState(instance),
      paused_at_stage: getPausedAtStage(instance),
      stage_result: null,
      reason: moved.blocked ? 'stage_occupied' : 'stage_ready',
    };
  }

  if (pausedAtStage) {
    throw new Error('Loop is paused — use approveGate to continue');
  }

  let stageResult = null;
  let transitionReason = null;
  let transitionWorkItem = tryGetSelectedWorkItem(instance, project.id) || null;

  switch (currentState) {
    case LOOP_STATES.SENSE: {
      const targetStage = getPendingGateStage(currentState, project.trust_level) || getNextState(currentState, project.trust_level, 'approved');
      const moved = tryMoveInstanceToStage(instance, targetStage, {
        paused_at_stage: getPendingGateStage(currentState, project.trust_level) === targetStage ? targetStage : null,
      });
      instance = moved.instance;
      transitionReason = moved.blocked ? 'stage_occupied' : 'sense_completed';
      break;
    }

    case LOOP_STATES.PRIORITIZE: {
      const prioritizeStage = executePrioritizeStage(project, instance, transitionWorkItem);
      transitionWorkItem = prioritizeStage?.work_item || transitionWorkItem;
      stageResult = prioritizeStage?.stage_result || null;
      transitionReason = prioritizeStage?.reason || null;
      instance = getInstanceOrThrow(instance.id);

      const enterPlan = tryMoveInstanceToStage(instance, LOOP_STATES.PLAN, {
        work_item_id: transitionWorkItem?.id ?? instance.work_item_id,
      });
      if (enterPlan.blocked) {
        instance = enterPlan.instance;
        transitionReason = 'stage_occupied';
        break;
      }

      instance = enterPlan.instance;
      const planStage = await executePlanStage(project, instance, transitionWorkItem);
      if (planStage?.stage_result) {
        stageResult = planStage.stage_result;
      }
      if (planStage?.reason) {
        transitionReason = planStage.reason;
      }
      if (planStage?.work_item) {
        transitionWorkItem = planStage.work_item;
      }
      instance = getInstanceOrThrow(instance.id);

      if (planStage?.skip_to_execute) {
        const moveToExecute = tryMoveInstanceToStage(instance, LOOP_STATES.EXECUTE, {
          work_item_id: transitionWorkItem?.id ?? instance.work_item_id,
        });
        instance = moveToExecute.instance;
        if (moveToExecute.blocked) {
          transitionReason = 'stage_occupied';
        }
      } else if (getPendingGateStage(currentState, project.trust_level) === LOOP_STATES.PLAN) {
        instance = updateInstanceAndSync(instance.id, {
          paused_at_stage: LOOP_STATES.PLAN,
          last_action_at: nowIso(),
        });
      }
      break;
    }

    case LOOP_STATES.PLAN:
    case LOOP_STATES.EXECUTE: {
      if (currentState === LOOP_STATES.PLAN) {
        const moveToExecute = tryMoveInstanceToStage(instance, LOOP_STATES.EXECUTE, {
          work_item_id: instance.work_item_id,
        });
        if (moveToExecute.blocked) {
          instance = moveToExecute.instance;
          transitionReason = 'stage_occupied';
          break;
        }
        instance = moveToExecute.instance;
      }

      let targetItem = transitionWorkItem || tryGetSelectedWorkItem(instance, project.id, {
        fallbackToLoopSelection: true,
      });
      if (targetItem && (!targetItem.origin?.plan_path || !fs.existsSync(targetItem.origin.plan_path))) {
        const generated = await executeNonPlanFileStage(project, instance, targetItem);
        if (generated?.work_item) {
          targetItem = generated.work_item;
          transitionWorkItem = generated.work_item;
        }
        if (generated?.stage_result) {
          stageResult = generated.stage_result;
        }
        if (generated?.reason) {
          transitionReason = generated.reason;
        }
        if (generated?.stop_execution) {
          instance = updateInstanceAndSync(instance.id, {
            paused_at_stage: generated.paused_at_stage || LOOP_STATES.PLAN_REVIEW,
            last_action_at: nowIso(),
          });
          break;
        }
      }

      const executeStage = await executePlanFileStage(project, instance, targetItem);
      if (executeStage) {
        stageResult = executeStage.stage_result;
        transitionReason = executeStage.reason;
        transitionWorkItem = executeStage.work_item || transitionWorkItem;
      }
      instance = getInstanceOrThrow(instance.id);

      if (executeStage?.stop_execution) {
        instance = updateInstanceAndSync(instance.id, {
          paused_at_stage: executeStage.paused_at_stage || LOOP_STATES.EXECUTE,
          last_action_at: nowIso(),
        });
        break;
      }

      const executeNextState = executeStage?.next_state || LOOP_STATES.EXECUTE;
      if (executeNextState === LOOP_STATES.IDLE) {
        terminateInstanceAndSync(instance.id);
        return {
          project_id: project.id,
          instance_id,
          previous_state: previousState,
          new_state: LOOP_STATES.IDLE,
          paused_at_stage: null,
          stage_result: stageResult,
          reason: transitionReason,
        };
      }

      if (executeNextState === LOOP_STATES.VERIFY) {
        const moveToVerify = tryMoveInstanceToStage(instance, LOOP_STATES.VERIFY, {
          batch_id: executeStage?.work_item?.batch_id || instance.batch_id,
          work_item_id: transitionWorkItem?.id ?? instance.work_item_id,
        });
        if (moveToVerify.blocked) {
          instance = moveToVerify.instance;
          transitionReason = 'stage_occupied';
          break;
        }
        instance = moveToVerify.instance;
        stageResult = await executeVerifyStage(project.id, instance.batch_id, instance);
        if (stageResult && stageResult.pause_at_stage) {
          instance = updateInstanceAndSync(instance.id, {
            paused_at_stage: stageResult.pause_at_stage,
            last_action_at: nowIso(),
          });
          transitionReason = stageResult.reason || transitionReason;
        }
      }
      break;
    }

    case LOOP_STATES.VERIFY: {
      const latestVerifyDecision = getLatestStageDecision(project.id, LOOP_STATES.VERIFY);
      const rerunApprovedVerify = ['gate_approved', 'retry_verify_requested'].includes(latestVerifyDecision?.action);
      stageResult = await executeVerifyStage(project.id, instance.batch_id, instance);
      if (stageResult && stageResult.pause_at_stage) {
        instance = updateInstanceAndSync(instance.id, {
          paused_at_stage: stageResult.pause_at_stage,
          last_action_at: nowIso(),
        });
        transitionReason = stageResult.reason || transitionReason;
        break;
      }

      const moveToLearn = tryMoveInstanceToStage(instance, LOOP_STATES.LEARN, {
        batch_id: instance.batch_id,
        work_item_id: instance.work_item_id,
      });
      instance = moveToLearn.instance;
      transitionReason = moveToLearn.blocked
        ? 'stage_occupied'
        : (rerunApprovedVerify ? 'verify_rerun_completed' : 'verified_batch');
      break;
    }

    case LOOP_STATES.LEARN: {
      stageResult = await executeLearnStage(project.id, instance.batch_id, instance);
      const cfg = project.config_json ? (() => { try { return JSON.parse(project.config_json); } catch { return {}; } })() : {};
      if (cfg && cfg.loop && cfg.loop.auto_continue === true) {
        const moveToSense = tryMoveInstanceToStage(instance, LOOP_STATES.SENSE, {
          batch_id: null,
          work_item_id: null,
          paused_at_stage: null,
        });
        instance = moveToSense.instance;
        if (moveToSense.blocked) {
          transitionReason = 'stage_occupied';
        }
      } else {
        terminateInstanceAndSync(instance.id);
        return {
          project_id: project.id,
          instance_id,
          previous_state: previousState,
          new_state: LOOP_STATES.IDLE,
          paused_at_stage: null,
          stage_result: stageResult,
          reason: 'learn_completed',
        };
      }
      break;
    }

    default:
      throw new Error(`Unsupported loop state: ${currentState}`);
  }

  instance = getInstanceOrThrow(instance_id);
  pausedAtStage = getPausedAtStage(instance);
  const newState = getCurrentLoopState(instance);
  transitionWorkItem = transitionWorkItem
    || tryGetSelectedWorkItem(instance, project.id)
    || tryGetLoopWorkItem(project.id, { allowedClaimedBy: instance.id });

  logger.info('Factory loop advanced', {
    project_id: project.id,
    instance_id: instance.id,
    previous_state: previousState,
    new_state: newState,
    paused_at_stage: pausedAtStage,
    reason: transitionReason,
  });

  logTransitionDecision({
    project,
    currentState: previousState,
    nextState: pausedAtStage ? LOOP_STATES.PAUSED : newState,
    pausedAtStage,
    reason: transitionReason,
    workItem: transitionWorkItem,
    batchId: getDecisionBatchId(project, transitionWorkItem, null, instance),
  });

  return {
    project_id: project.id,
    instance_id: instance.id,
    previous_state: previousState,
    new_state: newState,
    paused_at_stage: pausedAtStage,
    stage_result: stageResult,
    reason: transitionReason,
  };
}

async function advanceLoop(instance_id) {
  return runAdvanceLoop(instance_id);
}

async function advanceLoopForProject(project_id) {
  return runAdvanceLoop(getLoopInstanceForProjectOrThrow(project_id).id);
}

function advanceLoopAsync(instance_id, { autoAdvance = false } = {}) {
  const { project, instance } = getLoopContextOrThrow(instance_id);
  const currentState = getCurrentLoopState(instance);

  if (currentState === LOOP_STATES.IDLE) {
    throw new Error('Loop not started for this project');
  }

  if (getPausedAtStage(instance) && !isReadyForStage(getPausedAtStage(instance))) {
    throw new Error('Loop is paused — use approveGate to continue');
  }

  const activeJobId = activeLoopAdvanceJobs.get(instance.id);
  if (activeJobId) {
    const activeJob = loopAdvanceJobs.get(getLoopAdvanceJobKey(instance.id, activeJobId));
    if (activeJob?.status === 'running') {
      return snapshotLoopAdvanceJob(activeJob);
    }
    activeLoopAdvanceJobs.delete(instance.id);
  }

  const job = {
    project_id: project.id,
    instance_id: instance.id,
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

  loopAdvanceJobs.set(getLoopAdvanceJobKey(instance.id, job.job_id), job);
  activeLoopAdvanceJobs.set(instance.id, job.job_id);
  emitLoopAdvanceJobEvent(job);

  void runAdvanceLoop(instance.id)
    .then((result) => {
      job.status = 'completed';
      job.new_state = result.new_state ?? null;
      job.paused_at_stage = result.paused_at_stage ?? null;
      job.stage_result = result.stage_result ?? null;
      job.reason = result.reason ?? null;
      job.completed_at = nowIso();
      emitLoopAdvanceJobEvent(job);

      // Auto-advance: if the caller requested continuous driving AND the
      // instance is neither terminated (IDLE) nor paused at a gate, enqueue
      // the next advance. The 100ms delay prevents tight synchronous loops
      // on stages that complete instantly (SENSE, PRIORITIZE).
      if (autoAdvance && result.new_state !== LOOP_STATES.IDLE && !result.paused_at_stage) {
        setTimeout(() => {
          try {
            advanceLoopAsync(instance_id, { autoAdvance: true });
          } catch (err) {
            logger.debug('Auto-advance chain stopped', {
              instance_id,
              err: err.message,
            });
          }
        }, 100);
      }
    })
    .catch((error) => {
      job.status = 'failed';
      let latestState = null;
      let latestPaused = null;
      try {
        const latestInstance = getInstanceOrThrow(instance.id);
        latestState = getCurrentLoopState(latestInstance);
        latestPaused = getPausedAtStage(latestInstance);
        job.new_state = latestState;
        job.paused_at_stage = latestPaused;
      } catch {
        job.new_state = null;
        job.paused_at_stage = null;
      }
      job.completed_at = nowIso();
      job.error = error instanceof Error ? error.message : String(error);
      logger.warn('Factory loop async advance failed', {
        project_id: project.id,
        instance_id: instance.id,
        job_id: job.job_id,
        error: job.error,
      });
      emitLoopAdvanceJobEvent(job);

      // Auto-advance resilience: if the advance failed but the instance
      // is still active (not terminated, not paused at a gate), retry
      // after a cooldown. Transient failures (SSH timeout during remote
      // verify, temporary network blip) shouldn't kill the entire chain.
      // The 30s delay prevents tight retry loops on persistent failures.
      if (autoAdvance && latestState && latestState !== LOOP_STATES.IDLE && !latestPaused) {
        setTimeout(() => {
          try {
            advanceLoopAsync(instance_id, { autoAdvance: true });
          } catch (retryErr) {
            logger.debug('Auto-advance retry after failure also failed', {
              instance_id,
              err: retryErr.message,
            });
          }
        }, 30000);
      }
    })
    .finally(() => {
      if (activeLoopAdvanceJobs.get(instance.id) === job.job_id) {
        activeLoopAdvanceJobs.delete(instance.id);
      }
    });

  return snapshotLoopAdvanceJob(job);
}

function advanceLoopAsyncForProject(project_id) {
  return advanceLoopAsync(getLoopInstanceForProjectOrThrow(project_id).id);
}

function getLoopAdvanceJobStatus(instance_id, job_id) {
  if (!instance_id || !job_id) {
    return null;
  }

  return snapshotLoopAdvanceJob(loopAdvanceJobs.get(getLoopAdvanceJobKey(instance_id, job_id)));
}

function getLoopAdvanceJobStatusForProject(project_id, job_id) {
  if (!project_id || !job_id) {
    return null;
  }

  for (const job of loopAdvanceJobs.values()) {
    if (job.project_id === project_id && job.job_id === job_id) {
      return snapshotLoopAdvanceJob(job);
    }
  }
  return null;
}

function cancelLoopAdvanceJob(instance_id, reason = 'operator_cancelled') {
  // Operator recovery for stuck async advance jobs. The underlying promise
  // is left to complete on its own (we cannot reliably interrupt it from
  // outside), but the active-job mapping is cleared so subsequent advance
  // calls can start fresh, and the instance is parked at its current stage
  // so rejectGate/approveGate can drive it from here.
  const instance = getInstanceOrThrow(instance_id);
  const activeJobId = activeLoopAdvanceJobs.get(instance.id);
  if (!activeJobId) {
    return {
      instance_id: instance.id,
      cancelled: false,
      reason: 'no_active_job',
    };
  }

  const jobKey = getLoopAdvanceJobKey(instance.id, activeJobId);
  const job = loopAdvanceJobs.get(jobKey);
  if (job && job.status === 'running') {
    job.status = 'cancelled';
    job.completed_at = nowIso();
    job.error = `cancelled: ${reason}`;
    emitLoopAdvanceJobEvent(job);
  }
  activeLoopAdvanceJobs.delete(instance.id);

  const currentState = getCurrentLoopState(instance);
  const parkedStage = getPausedAtStage(instance) || currentState;
  const parkedInstance = updateInstanceAndSync(instance.id, {
    paused_at_stage: parkedStage,
    last_action_at: nowIso(),
  });

  logger.warn('Factory loop advance job cancelled', {
    project_id: parkedInstance.project_id,
    instance_id: instance.id,
    job_id: activeJobId,
    reason,
    parked_stage: parkedStage,
  });

  return {
    instance_id: instance.id,
    job_id: activeJobId,
    cancelled: true,
    reason,
    parked_stage: parkedStage,
  };
}

function cancelLoopAdvanceJobForProject(project_id, reason) {
  return cancelLoopAdvanceJob(getLoopInstanceForProjectOrThrow(project_id).id, reason);
}

function approveGate(instance_id, stage) {
  const { project } = getLoopContextOrThrow(instance_id);
  const instance = getInstanceOrThrow(instance_id);
  assertValidGateStage(stage);
  assertPausedAtStage(instance, stage);

  const updated = updateInstanceAndSync(instance.id, {
    paused_at_stage: null,
    last_action_at: nowIso(),
  });

  logger.info('Factory gate approved', {
    project_id: project.id,
    instance_id: updated.id,
    state: getCurrentLoopState(updated),
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
      instance_id: updated.id,
    },
    outcome: {
      from_state: LOOP_STATES.PAUSED,
      to_state: getCurrentLoopState(updated),
      approved_stage: stage,
      batch_id: updated.batch_id || null,
    },
    confidence: 1,
    batch_id: updated.batch_id || null,
  });

  return {
    project_id: project.id,
    instance_id: updated.id,
    state: getCurrentLoopState(updated),
    message: 'Gate approved, loop continuing',
  };
}

function approveGateForProject(project_id, stage) {
  return approveGate(getLoopInstanceForProjectOrThrow(project_id).id, stage);
}

function retryVerifyFromFailure(instance_id) {
  const { project } = getLoopContextOrThrow(instance_id);
  const instance = getInstanceOrThrow(instance_id);
  if (getPausedAtStage(instance) !== 'VERIFY_FAIL') {
    throw new Error('Loop is not paused at VERIFY_FAIL');
  }

  const updated = updateInstanceAndSync(instance.id, {
    paused_at_stage: null,
    last_action_at: nowIso(),
  });

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.VERIFY,
    actor: 'human',
    action: 'retry_verify_requested',
    reasoning: 'Operator triggered VERIFY retry from VERIFY_FAIL',
    outcome: {
      previous_paused_at_stage: 'VERIFY_FAIL',
      new_state: getCurrentLoopState(updated),
    },
    confidence: 1,
    batch_id: updated.batch_id || null,
  });

  logger.info('Factory VERIFY retry requested', {
    project_id: project.id,
    instance_id: updated.id,
    previous_paused_at_stage: 'VERIFY_FAIL',
    state: getCurrentLoopState(updated),
  });

  return {
    project_id: project.id,
    instance_id: updated.id,
    state: getCurrentLoopState(updated),
    message: 'VERIFY retry requested; advance the loop to re-run remote verify',
  };
}

function retryVerifyFromFailureForProject(project_id) {
  return retryVerifyFromFailure(getLoopInstanceForProjectOrThrow(project_id).id);
}

function rejectGate(instance_id, stage) {
  const { project } = getLoopContextOrThrow(instance_id);
  const instance = getInstanceOrThrow(instance_id);
  assertValidGateStage(stage);
  assertPausedAtStage(instance, stage);

  // Gate rejection is an operator action — abandon the worktree so the
  // branch name is free for future retries of the same work item.
  terminateInstanceAndSync(instance.id, { abandonWorktree: true });

  logger.info('Factory gate rejected', {
    project_id: project.id,
    instance_id: instance.id,
    rejected_stage: stage,
    state: LOOP_STATES.IDLE,
  });

  return {
    project_id: project.id,
    instance_id: instance.id,
    state: LOOP_STATES.IDLE,
    message: 'Gate rejected, loop stopped',
  };
}

function rejectGateForProject(project_id, stage) {
  return rejectGate(getLoopInstanceForProjectOrThrow(project_id).id, stage);
}

function getLoopState(instance_id) {
  const { project, instance } = getLoopContextOrThrow(instance_id);
  return summarizeInstanceState(project, instance);
}

function getLoopStateForProject(project_id) {
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

function getAwaitableLoopInstance(project_id) {
  const activeInstance = factoryLoopInstances.listInstances({ project_id, active_only: true })[0] || null;
  if (activeInstance) {
    return activeInstance;
  }

  const instances = factoryLoopInstances.listInstances({ project_id, active_only: false });
  return instances.length > 0 ? instances[instances.length - 1] : null;
}

function getLatestDecisionSummary(project_id) {
  const db = database.getDbInstance();
  if (!db || !project_id) {
    return null;
  }

  try {
    return db.prepare(`
      SELECT stage, action, created_at
      FROM factory_decisions
      WHERE project_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(project_id) || null;
  } catch (error) {
    logger.debug({ err: error.message, project_id }, 'Unable to inspect latest factory decision for awaitFactoryLoop');
    return null;
  }
}

function normalizeAwaitFactoryLoopTimeoutMinutes(timeout_minutes) {
  const numeric = timeout_minutes == null ? 60 : Number(timeout_minutes);
  if (Number.isFinite(numeric) && numeric > 0 && numeric < 1) {
    // The public MCP schema enforces a 1-minute minimum, but controller-level
    // tests and direct callers use sub-minute budgets for fast polling checks.
    return numeric;
  }
  return Math.min(Math.max(Number.isFinite(numeric) ? numeric : 60, 1), 240);
}

// Linear ordering of loop stages — used so await_factory_loop can resolve when
// an autonomous loop races past a target state. Without this, a caller asking
// target_states=['PRIORITIZE'] on an autonomous loop that transitions
// SENSE→PRIORITIZE→PLAN→EXECUTE in under the wake interval would miss the
// target window and hang until timeout.
const STAGE_ORDER_RANKS = Object.freeze({
  SENSE: 1,
  PRIORITIZE: 2,
  PLAN: 3,
  PLAN_REVIEW: 3.5,
  EXECUTE: 4,
  VERIFY: 5,
  LEARN: 6,
  IDLE: 7,
});

function hasReachedTargetState(instance, targetStates) {
  if (!Array.isArray(targetStates) || targetStates.length === 0) {
    return false;
  }
  // Exact match on loop_state — preserves existing semantics and handles
  // non-linear states like PAUSED directly.
  if (targetStates.includes(instance.loop_state)) {
    return true;
  }
  // Exact match on paused_at_stage — caller asked for PRIORITIZE and loop is
  // paused at PRIORITIZE.
  if (instance.paused_at_stage && targetStates.includes(instance.paused_at_stage)) {
    return true;
  }
  // Ordinal progression check — if the loop has advanced past ANY target state
  // in the linear SENSE→PRIORITIZE→...→IDLE ordering, consider it reached.
  const effectiveState = instance.paused_at_stage || instance.loop_state;
  const currentRank = STAGE_ORDER_RANKS[effectiveState];
  if (currentRank == null) {
    return false;
  }
  for (const target of targetStates) {
    const targetRank = STAGE_ORDER_RANKS[target];
    if (targetRank != null && currentRank >= targetRank) {
      return true;
    }
  }
  return false;
}

async function awaitFactoryLoop(project_id, {
  target_states = null,
  target_paused_stages = null,
  await_termination = true,
  timeout_minutes = 60,
  heartbeat_minutes = 5,
} = {}) {
  const timeoutMs = normalizeAwaitFactoryLoopTimeoutMinutes(timeout_minutes) * 60 * 1000;
  const rawHeartbeatMinutes = heartbeat_minutes == null ? 5 : Number(heartbeat_minutes);
  const heartbeatMinutes = Math.min(Math.max(Number.isFinite(rawHeartbeatMinutes) ? rawHeartbeatMinutes : 5, 0), 30);
  const heartbeatMs = heartbeatMinutes * 60 * 1000;
  const startedAt = Date.now();
  let lastHeartbeat = startedAt;

  while (true) {
    const instance = getAwaitableLoopInstance(project_id);
    if (!instance) {
      throw new Error('Loop not started for this project');
    }

    const now = Date.now();
    const elapsedMs = now - startedAt;

    if (instance.terminated_at) {
      return { status: 'terminated', instance, elapsed_ms: elapsedMs, timed_out: false };
    }

    if (hasReachedTargetState(instance, target_states)) {
      return { status: 'target_state_reached', instance, elapsed_ms: elapsedMs, timed_out: false };
    }

    if (Array.isArray(target_paused_stages) && target_paused_stages.includes(instance.paused_at_stage)) {
      return { status: 'target_paused_stage_reached', instance, elapsed_ms: elapsedMs, timed_out: false };
    }

    if (await_termination && instance.paused_at_stage) {
      return { status: 'paused', instance, elapsed_ms: elapsedMs, timed_out: false };
    }

    if (heartbeatMs > 0 && now - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = now;
      return {
        status: 'heartbeat',
        instance,
        latest_decision: getLatestDecisionSummary(project_id),
        elapsed_ms: elapsedMs,
        timed_out: false,
      };
    }

    if (elapsedMs >= timeoutMs) {
      return { status: 'timeout', instance, elapsed_ms: elapsedMs, timed_out: true };
    }

    // Wait for event-bus wakeup, heartbeat timer, or timeout — same pattern as handleAwaitTask.
    // Event-bus wakes instantly on state changes; timer serves as heartbeat/timeout fallback.
    await new Promise((resolve) => {
      let resolved = false;
      let listenerRef = null;

      const done = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (listenerRef) {
            eventBus.removeFactoryLoopListener(listenerRef);
            listenerRef = null;
          }
          resolve();
        }
      };

      // Compute timer delay: min of (heartbeat interval, remaining timeout, poll fallback)
      const remaining = timeoutMs - (Date.now() - startedAt);
      let timerDelay = Math.max(remaining, 0);
      if (heartbeatMs > 0) {
        const sinceLastHeartbeat = Date.now() - lastHeartbeat;
        const untilHeartbeat = Math.max(heartbeatMs - sinceLastHeartbeat, 0);
        timerDelay = Math.min(timerDelay, untilHeartbeat);
      }
      // Poll fallback — ensures we still re-check periodically even if an event
      // is missed (e.g. state changed by a code path that doesn't go through
      // updateInstanceAndSync).
      timerDelay = Math.min(timerDelay, POLL_MS);

      const timer = setTimeout(done, Math.max(timerDelay, 50));

      // Wake instantly on factory loop state changes for this project
      listenerRef = (payload) => {
        if (payload && payload.project_id === project_id) {
          done();
        }
      };
      eventBus.onFactoryLoopChanged(listenerRef);
    });
  }
}

async function awaitFactoryLoopForProject(project_id, options = {}) {
  const project = getProjectOrThrow(project_id);
  return awaitFactoryLoop(project.id, options);
}

// Resume auto-advance for active instances after server restart. Called once
// during startup. Scans for non-terminated instances whose project config
// has loop.auto_continue enabled and kicks off the auto-advance chain.
function resumeAutoAdvanceOnStartup() {
  let resumed = 0;
  try {
    const projects = factoryHealth.listProjects();
    for (const project of projects) {
      const cfg = project.config_json
        ? (() => { try { return JSON.parse(project.config_json); } catch { return {}; } })()
        : {};
      if (!cfg?.loop?.auto_continue) {
        continue;
      }
      const instances = factoryLoopInstances.listInstances({
        project_id: project.id,
        active_only: true,
      });
      for (const instance of instances) {
        if (instance.terminated_at) continue;
        const state = getCurrentLoopState(instance);
        const paused = getPausedAtStage(instance);
        if (state === LOOP_STATES.IDLE || paused) continue;
        try {
          advanceLoopAsync(instance.id, { autoAdvance: true });
          resumed += 1;
          logger.info('Resumed auto-advance after restart', {
            project_id: project.id,
            instance_id: instance.id,
            state,
          });
        } catch (err) {
          logger.warn('Failed to resume auto-advance after restart', {
            project_id: project.id,
            instance_id: instance.id,
            state,
            err: err.message,
          });
        }
      }
    }
  } catch (err) {
    logger.warn('resumeAutoAdvanceOnStartup scan failed', { err: err.message });
  }
  return resumed;
}

module.exports = {
  StageOccupiedError,
  startLoop,
  startLoopForProject,
  startLoopAutoAdvance,
  startLoopAutoAdvanceForProject,
  resumeAutoAdvanceOnStartup,
  advanceLoop,
  advanceLoopForProject,
  advanceLoopAsync,
  advanceLoopAsyncForProject,
  cancelLoopAdvanceJob,
  cancelLoopAdvanceJobForProject,
  approveGate,
  approveGateForProject,
  retryVerifyFromFailure,
  retryVerifyFromFailureForProject,
  rejectGate,
  rejectGateForProject,
  terminateInstanceAndSync,
  getLoopState,
  getLoopStateForProject,
  awaitFactoryLoop,
  awaitFactoryLoopForProject,
  getLoopAdvanceJobStatus,
  getLoopAdvanceJobStatusForProject,
  getActiveInstances,
  scheduleLoop,
  attachBatchId,
  attachBatchIdForProject,
  // Test hooks
  setWorktreeRunnerForTests,
  _internalForTests: {
    claimNextWorkItemForInstance,
    healAlreadyShippedWorkItem,
    awaitTaskToStructuredResult,
    terminateInstanceAndSync,
    injectFakeAdvanceJobForTests: (instance_id, job) => {
      const key = getLoopAdvanceJobKey(instance_id, job.job_id);
      loopAdvanceJobs.set(key, job);
      activeLoopAdvanceJobs.set(instance_id, job.job_id);
    },
    getActiveAdvanceJobIdForTests: (instance_id) => activeLoopAdvanceJobs.get(instance_id) || null,
    getAdvanceJobSnapshotForTests: (instance_id, job_id) => {
      return loopAdvanceJobs.get(getLoopAdvanceJobKey(instance_id, job_id)) || null;
    },
  },
};
