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
const factoryNotifications = require('./notifications');
const { createPlanFileIntake } = require('./plan-file-intake');
const { createPlanReviewer, selectReviewers } = require('./plan-reviewer');
const { createShippedDetector } = require('./shipped-detector');
const { createWorktreeRunner } = require('./worktree-runner');
const { createWorktreeManager } = require('../plugins/version-control/worktree-manager');
const eventBus = require('../event-bus');
const logger = require('../logger').child({ component: 'loop-controller' });

const PLAN_GENERATOR_PROVIDER = 'codex';
const PLAN_GENERATOR_LABEL = 'Codex';

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

// `pause_project` writes factory_projects.status='paused', but the legacy gate
// above only reads instance-level paused_at_stage. Without this second gate,
// an in-flight VERIFY retry or auto-advance chain keeps firing after the
// operator pauses the project (observed: bitsy work-item 471 submitted a
// verify-retry task 3m30s AFTER pause_project landed). Checking the project
// row flag makes pause actually bite across every entry and re-entry point.
function isProjectStatusPaused(project_id) {
  if (!project_id) return false;
  try {
    const project = factoryHealth.getProject(project_id);
    return project?.status === 'paused';
  } catch {
    return false;
  }
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
  if (project.status !== 'running') {
    factoryHealth.updateProject(project.id, { status: 'running' });
  }

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
    let worktreeRecord = (batch_id || instance?.batch_id)
      ? factoryWorktrees.getActiveWorktreeByBatch(batch_id || instance?.batch_id)
      : factoryWorktrees.getActiveWorktree(project_id);

    // If the DB thinks the worktree is active but the directory is gone
    // (restart janitor, manual rm, or corrupted state), abandon it and
    // fall through to the no-worktree recovery path below — otherwise
    // the merge call will crash and the loop will retry forever.
    if (worktreeRecord && worktreeRecord.worktreePath
        && !fs.existsSync(worktreeRecord.worktreePath)) {
      try {
        factoryWorktrees.markAbandoned(
          worktreeRecord.id,
          'worktreePath_missing_on_disk_at_learn',
        );
      } catch (_e) { void _e; }
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.LEARN,
        action: 'worktree_path_missing_abandoned',
        reasoning: 'Active factory worktree DB row points to a path that no longer exists on disk. Marking abandoned and falling through to no-worktree recovery.',
        outcome: {
          work_item_id: workItem.id,
          worktree_id: worktreeRecord.id,
          worktree_path: worktreeRecord.worktreePath,
          branch: worktreeRecord.branch,
        },
        confidence: 1,
        batch_id: shippingDecision.decision_batch_id || decisionBatchId,
      });
      worktreeRecord = null;
    }

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
        // Reject the work item instead of just skipping — otherwise
        // PRIORITIZE will re-select it on the next cycle and we spin
        // forever. This was the exact failure mode that kept work
        // item 115 in 'executing' state for 11+ hours on 2026-04-18
        // after its worktree directory was cleaned up by a restart
        // janitor.
        const rejectReason = priorWorktree
          ? `no_worktree_for_batch_prior_status=${priorWorktree.status}`
          : 'no_worktree_for_batch_after_execute';
        try {
          factoryIntake.updateWorkItem(workItem.id, {
            status: 'rejected',
            reject_reason: rejectReason,
          });
        } catch (_e) { void _e; }
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.LEARN,
          action: 'auto_rejected_no_worktree',
          reasoning: 'LEARN found no active worktree to merge and no prior merged worktree for this work item. Rejecting so PRIORITIZE does not re-select it.',
          inputs: {
            batch_id: batch_id || instance?.batch_id || null,
            resolution_source: resolutionSource,
            work_item_status: workItem.status,
          },
          outcome: {
            work_item_id: workItem.id,
            reason: rejectReason,
            prior_worktree_id: priorWorktree ? priorWorktree.id : null,
            prior_worktree_status: priorWorktree ? priorWorktree.status : null,
          },
          confidence: 1,
          batch_id: shippingDecision.decision_batch_id || decisionBatchId,
        });
        return {
          status: 'rejected',
          reason: rejectReason,
          work_item_id: workItem.id,
        };
      }
      // priorWorktree is merged → the code already landed in a prior
      // loop, this LEARN is just catching up the work item status.
    }

    if (worktreeRecord && worktreeRunner) {
      try {
        // Use the worktree's base_branch if stored on the factory_worktrees
        // row; otherwise re-detect from the repo (bitsy uses master, the
        // hardcoded 'main' default produces `git rev-list main..feat/...`
        // → unknown revision → worktree_merge_failed). detectDefaultBranch
        // consults origin/HEAD and falls back to whichever of master/main
        // actually exists locally.
        const { detectDefaultBranch } = require('./worktree-runner');
        const mergeTarget = worktreeRecord.base_branch
          || worktreeRecord.baseBranch
          || detectDefaultBranch(project.path)
          || 'main';
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
        // Empty-branch case: EXECUTE produced zero commits. Either the work
        // was already shipped in a prior session (→ mark shipped) or the
        // provider gave up (→ reject, not skip — skip causes PRIORITIZE to
        // re-select the same item and loop forever).
        const isEmptyBranch = /no commits ahead/i.test(err.message || '');
        if (isEmptyBranch) {
          const resolveEmptyBranch = () => {
            let detection = null;
            try {
              const planPath = workItem?.origin?.plan_path || null;
              const planContent = planPath && fs.existsSync(planPath)
                ? fs.readFileSync(planPath, 'utf8')
                : '';
              const { createShippedDetector } = require('./shipped-detector');
              const detector = createShippedDetector({ repoRoot: project.path });
              detection = detector.detectShipped({ content: planContent, title: workItem.title });
            } catch (detErr) {
              logger.debug('empty-branch shipped-detector error', { err: detErr.message });
            }

            const sharedOutcome = {
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              worktree_id: worktreeRecord.vcWorktreeId,
              factory_worktree_id: worktreeRecord.id,
              error: err.message,
              detection: detection ? {
                shipped: detection.shipped,
                confidence: detection.confidence,
                signals: detection.signals,
              } : null,
            };

            if (detection && detection.shipped) {
              factoryIntake.updateWorkItem(workItem.id, { status: 'shipped' });
              rememberSelectedWorkItem(
                instance.id,
                factoryIntake.getWorkItemForProject(project_id, workItem.id, { includeClosed: true })
              );
              factoryIntake.releaseClaimForInstance(instance.id);
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.LEARN,
                action: 'auto_shipped_empty_branch',
                reasoning: `Merge failed (no commits ahead) but shipped-detector found matching evidence on main (${detection.confidence} confidence). Marking shipped instead of leaving the loop stuck.`,
                inputs: {
                  batch_id: batch_id || null,
                  resolution_source: resolutionSource,
                },
                outcome: { ...sharedOutcome, work_item_id: workItem.id },
                confidence: 1,
                batch_id: shippingDecision.decision_batch_id || decisionBatchId,
              });
              return {
                status: 'passed',
                reason: 'auto_shipped_empty_branch',
                work_item_id: workItem.id,
              };
            }

            // No ship evidence → reject so PRIORITIZE doesn't re-select the
            // same item and loop forever. Operator can reopen if needed.
            factoryIntake.updateWorkItem(workItem.id, {
              status: 'rejected',
              reject_reason: 'empty_branch_after_execute',
            });
            factoryIntake.releaseClaimForInstance(instance.id);
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.LEARN,
              action: 'auto_rejected_empty_branch',
              reasoning: 'Merge failed (no commits ahead) and shipped-detector did not find matching evidence on main. Rejecting to prevent infinite re-entry.',
              inputs: {
                batch_id: batch_id || null,
                resolution_source: resolutionSource,
              },
              outcome: { ...sharedOutcome, work_item_id: workItem.id },
              confidence: 1,
              batch_id: shippingDecision.decision_batch_id || decisionBatchId,
            });
            return {
              status: 'rejected',
              reason: 'empty_branch_after_execute',
              work_item_id: workItem.id,
            };
          };

          try {
            return resolveEmptyBranch();
          } catch (resolveErr) {
            logger.warn('empty-branch resolution failed; falling back to skipped', {
              project_id,
              err: resolveErr.message,
            });
            // fall through to the original leave-open path below
          }
        }

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
            work_item_id: workItem.id,
            error: err.message,
          },
          confidence: 1,
          batch_id: shippingDecision.decision_batch_id || decisionBatchId,
        });

        // If the target repo is mid-merge / mid-rebase / mid-cherry-pick /
        // mid-revert, retrying every ~60s is pointless — `git commit` will
        // keep refusing until the operator resolves or aborts. Pause the
        // project so the operator gets a single clear signal instead of a
        // retry storm (observed against bitsy on 2026-04-20: 13 failed
        // merges in 75 minutes, all identical "uncommitted changes" errors).
        if (err && err.code === 'IN_PROGRESS_GIT_OPERATION') {
          try {
            factoryHealth.updateProject(project_id, { status: 'paused' });
          } catch (_pauseErr) {
            void _pauseErr;
          }
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.LEARN,
            action: 'merge_target_in_conflict_state',
            reasoning: `Merge target ${err.path || worktreeRecord.worktreePath} is mid-${err.op || 'merge'}; pausing project. `
              + `Operator must resolve the conflict or run \`git ${err.op || 'merge'} --abort\` before resuming.`,
            outcome: {
              work_item_id: workItem.id,
              branch: worktreeRecord.branch,
              op: err.op || null,
              path: err.path || null,
              next_state: LOOP_STATES.PAUSED,
              paused_at_stage: LOOP_STATES.LEARN,
            },
            confidence: 1,
            batch_id: shippingDecision.decision_batch_id || decisionBatchId,
          });
          return {
            status: 'paused',
            reason: 'merge_target_in_conflict_state',
            work_item_id: workItem.id,
            error: err.message,
            op: err.op || null,
          };
        }

        // Fix 2: if this is the second consecutive empty-branch merge failure
        // for the same work item, auto-quarantine it. Otherwise the LEARN
        // stage bounces straight back to SENSE which re-picks the same item
        // and EXECUTE produces another empty branch, looping forever.
        try {
          const priorDecisions = factoryDecisions.listDecisions(project_id, {
            stage: LOOP_STATES.LEARN,
            limit: 200,
          });
          if (shouldQuarantineForEmptyMerges({
            currentErrorMessage: err.message,
            priorDecisions,
            workItemId: workItem.id,
          })) {
            factoryIntake.updateWorkItem(workItem.id, {
              status: 'rejected',
              reject_reason: 'consecutive_empty_executions',
            });
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.LEARN,
              action: 'auto_quarantined_empty_merges',
              reasoning: `Work item ${workItem.id} produced empty branches across consecutive EXECUTE cycles; auto-rejecting so the loop can advance.`,
              outcome: {
                work_item_id: workItem.id,
                branch: worktreeRecord.branch,
              },
              confidence: 1,
              batch_id: shippingDecision.decision_batch_id || decisionBatchId,
            });
            return {
              status: 'skipped',
              reason: 'auto_quarantined_empty_merges',
              work_item_id: workItem.id,
              error: err.message,
            };
          }
        } catch (_quarantineErr) {
          void _quarantineErr;
        }

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

    const decision = logDecision({
      ...entry,
      stage: normalizedStage,
      actor,
    });
    try {
      recordVerifyFailAlertDecision({ ...entry, stage: normalizedStage });
    } catch (alertError) {
      logger.warn('Failed to update factory VERIFY_FAIL alert state', {
        err: alertError.message,
        project_id: entry?.project_id,
        stage: normalizedStage,
        action: entry?.action,
      });
    }
    return decision;
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

function getDecisionInstanceId(entry) {
  return entry?.outcome?.instance_id
    || entry?.inputs?.instance_id
    || entry?.instance_id
    || null;
}

function isNonVerifyFailTerminalDecision(action) {
  if (!action || action === 'auto_rejected_verify_fail') {
    return false;
  }
  return action === 'worktree_verify_passed'
    || action === 'verified_batch'
    || action === 'shipped_work_item'
    || action === 'cannot_generate_plan'
    || action === 'dep_resolver_cascade_exhausted'
    || action === 'dep_resolver_escalation_pause'
    || action === 'verify_reviewed_baseline_broken'
    || action === 'verify_reviewed_environment_failure'
    || action.startsWith('auto_rejected_')
    || action.startsWith('auto_quarantined_')
    || action.startsWith('auto_shipped_');
}

function recordVerifyFailAlertDecision(entry) {
  const action = typeof entry?.action === 'string' ? entry.action : '';
  if (!entry?.project_id || !action) {
    return;
  }

  if (action === 'auto_rejected_verify_fail') {
    factoryNotifications.recordVerifyFailTerminalResult({
      project_id: entry.project_id,
      terminal_result: 'VERIFY_FAIL',
      action,
      auto_rejected: true,
      work_item_id: entry?.outcome?.work_item_id ?? entry?.inputs?.work_item_id ?? null,
      batch_id: entry?.batch_id || null,
      instance_id: getDecisionInstanceId(entry),
      reason: action,
    });
    return;
  }

  if (isNonVerifyFailTerminalDecision(action)) {
    factoryNotifications.recordVerifyFailTerminalResult({
      project_id: entry.project_id,
      terminal_result: action,
      action,
      auto_rejected: false,
      work_item_id: entry?.outcome?.work_item_id ?? entry?.inputs?.work_item_id ?? null,
      batch_id: entry?.batch_id || null,
      instance_id: getDecisionInstanceId(entry),
      reason: action,
    });
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

function countOpenWorkItems(project_id) {
  try {
    return factoryIntake.listOpenWorkItems({ project_id, limit: 1000 }).length;
  } catch (error) {
    logger.debug({ err: error.message, project_id }, 'Unable to count open work items for idle alert');
    return 0;
  }
}

function countRunningLoopItems(project_id) {
  try {
    return getActiveInstances(project_id)
      .filter((activeInstance) => activeInstance && !activeInstance.terminated_at)
      .filter((activeInstance) => {
        try {
          return getCurrentLoopState(activeInstance) !== LOOP_STATES.IDLE;
        } catch {
          return true;
        }
      }).length;
  } catch (error) {
    logger.debug({ err: error.message, project_id }, 'Unable to count active loop items for idle alert');
    return 0;
  }
}

function recordFactoryIdleIfExhausted(project_id, { last_action_at, reason } = {}) {
  const pendingCount = countOpenWorkItems(project_id);
  const runningCount = countRunningLoopItems(project_id);
  const result = factoryNotifications.recordFactoryIdleState({
    project_id,
    pending_count: pendingCount,
    running_count: runningCount,
    has_pending_work: pendingCount > 0,
    has_running_item: runningCount > 0,
    last_action_at,
    reason,
  });

  if (result.alerted) {
    logger.warn('Factory idle alert emitted', {
      project_id,
      pending_count: pendingCount,
      running_count: runningCount,
      reason,
    });
  }

  return result;
}

function clearFactoryIdleForPendingWork(project_id, pending_count = 1) {
  factoryNotifications.recordFactoryIdleState({
    project_id,
    pending_count,
    running_count: countRunningLoopItems(project_id),
    has_pending_work: pending_count > 0,
    has_running_item: true,
  });
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
  clearFactoryIdleForPendingWork(project_id, openItems.length);

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

  // Stuck-executing auto-reject: if PRIORITIZE finds a work item already
  // in 'executing' status with updated_at older than 1 hour, a prior
  // cycle claimed it but never reached a terminal state (shipped,
  // rejected, failed). The LEARN reject-not-skip fix closes most of
  // these, but defense-in-depth: close items that slip through here
  // so PRIORITIZE doesn't re-pick the same wedged item every cycle.
  if (workItem.status === 'executing') {
    const STUCK_THRESHOLD_MS = 60 * 60 * 1000; // 1h
    const updatedAtMs = workItem.updated_at ? Date.parse(workItem.updated_at) : NaN;
    if (Number.isFinite(updatedAtMs) && (Date.now() - updatedAtMs) > STUCK_THRESHOLD_MS) {
      const stalledMinutes = Math.round((Date.now() - updatedAtMs) / 60000);
      try {
        factoryIntake.updateWorkItem(workItem.id, {
          status: 'rejected',
          reject_reason: `stuck_executing_over_1h_no_progress (${stalledMinutes}m since updated_at)`,
        });
      } catch (_e) { void _e; }
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.PRIORITIZE,
        action: 'auto_rejected_stuck_executing',
        reasoning: `Work item was in 'executing' status for ${stalledMinutes} minutes without reaching a terminal state. A prior cycle likely failed silently — rejecting so PRIORITIZE can pick real work.`,
        outcome: {
          work_item_id: workItem.id,
          stalled_minutes: stalledMinutes,
          prior_status: 'executing',
        },
        confidence: 1,
        batch_id: getDecisionBatchId(project, workItem, null, instance),
      });
      logger.warn('PRIORITIZE auto-rejected stuck-executing item', {
        project_id: project.id,
        work_item_id: workItem.id,
        title: workItem.title,
        stalled_minutes: stalledMinutes,
      });
      return executePrioritizeStage(project, instance);
    }
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

function buildAutoGeneratedPlanPrompt(project, workItem, priorFeedback = null) {
  const projectBrief = typeof project?.brief === 'string' && project.brief.trim()
    ? project.brief.trim()
    : 'No project brief provided.';
  const description = String(workItem?.description || '').trim();
  const techStack = inferAutoGeneratedPlanTechStack(project?.path);

  const prompt = [
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
    '- Use indented detail lines under steps. Do not use fenced code blocks.',
    '- Preserve the `**Source:** auto-generated from work_item #<id>` line.',
    '',
    'Every task body MUST include all five of these specificity signals,',
    'otherwise the plan-quality gate rejects it. Each signal is worth 20',
    'points; tasks need >= 80 points (4 of 5) to pass.',
    '1. Explicit file paths — cite the concrete files you will edit or',
    '   create, e.g. `bitsy/agent/session.py` or `tests/test_foo.py`.',
    '2. Estimated scope — mention how many files/lines/tests/functions',
    '   are in scope, e.g. "~3 files", "two tests", "single helper".',
    '3. Success criteria — say what "done" looks like with words like',
    '   "acceptance criteria", "must", "should pass", "ensures that".',
    '4. Validation steps — include the exact command that proves the',
    '   task is done, e.g. `pytest tests/test_foo.py`, `npx vitest run',
    '   path/to/spec.js`, `npx tsc --noEmit`, or `cargo test`.',
    '5. Concrete language — avoid bare verbs like "improve", "handle",',
    '   "update", "clean up", "as needed". If you use them, qualify',
    '   with a nearby file path, function name, or backtick identifier.',
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

  if (typeof priorFeedback === 'string' && priorFeedback.trim().length > 0) {
    return `${priorFeedback.trim()}\n\n---\n\n${prompt}`;
  }
  return prompt;
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
  const generatorProvider = workItem?.origin?.plan_generator_provider || PLAN_GENERATOR_PROVIDER;
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

const PLAN_DESCRIPTION_QUALITY_THRESHOLD = 80;
const PLAN_DESCRIPTION_QUALITY_SIGNALS = Object.freeze([
  'explicit_file_paths',
  'estimated_scope',
  'success_criteria',
  'validation_steps',
  'concrete_language',
]);
const PLAN_DESCRIPTION_FILE_PATH_RE = /(?:^|[\s`'"([])(?:[A-Za-z]:)?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+|(?:^|[\s`'"([])[A-Za-z0-9_.-]+\.(?:cjs|cs|css|go|html|java|js|json|jsx|md|mjs|ps1|py|rb|rs|sh|sql|ts|tsx|txt|xml|ya?ml)\b/gi;
const PLAN_DESCRIPTION_SCOPE_RE = /\b(?:(?:about|approximately|around|under|within|up to|~)\s*)?\d+\s*(?:files?|lines?|loc|modules?|tests?|cases?|functions?|helpers?|commands?|changes?)\b|\b(?:single|one|two|three|four|five|small|focused)\s+(?:file|module|test|case|function|helper|command|change)s?\b/i;
const PLAN_DESCRIPTION_SUCCESS_RE = /\b(?:acceptance criteria|success criteria|done when|passes when|expected result|verify that|ensure that|assert(?:s|ion)?|expect(?:s|ation)?|must|should produce|should return|should reject|should pass)\b/i;
const PLAN_DESCRIPTION_VALIDATION_RE = /\b(?:npx\s+vitest|vitest\s+run|npm\s+(?:run\s+)?(?:test|lint)|pnpm\s+(?:run\s+)?(?:test|lint)|yarn\s+(?:test|lint)|node\s+--test|node\s+[^.\n]*\.m?js|pytest|(?:python\s+)?-m\s+(?:pytest|unittest|mypy|ruff|black|isort|pylint|flake8|bandit|coverage)|pre-commit\s+run|ruff\s+(?:check|format)|mypy\s+[\w./:-]+|black\s+[\w./:-]+|flake8\s+[\w./:-]+|isort\s+[\w./:-]+|bandit\s+(?:-[rc]|[\w./:-]+)|pip-audit|safety\s+check|dotnet\s+test|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|tsc\s+--noEmit|make\s+(?:test|check|lint)|rg\s+["'`]?[\w./:-]+)/i;
const PLAN_DESCRIPTION_VAGUE_PHRASES = Object.freeze([
  { label: 'improve', re: /\bimprov(?:e|es|ed|ing)\b/gi },
  { label: 'handle', re: /\bhandl(?:e|es|ed|ing)\b/gi },
  { label: 'update', re: /\bupdat(?:e|es|ed|ing)\b/gi },
  { label: 'make better', re: /\bmake\s+(?:it\s+)?better\b/gi },
  { label: 'clean up', re: /\bclean\s+up\b/gi },
  { label: 'as needed', re: /\bas\s+needed\b/gi },
]);

function parseAutoGeneratedPlanTasks(planContent) {
  const content = typeof planContent === 'string' ? planContent : String(planContent || '');
  if (!content.trim()) {
    return [];
  }

  const headingRe = /^## Task\s+(\d+):\s*(.*)$/gm;
  const headings = Array.from(content.matchAll(headingRe)).map((match) => ({
    index: Number(match[1]),
    title: (match[2] || '').trim(),
    start: match.index,
    headerLength: match[0].length,
  }));

  return headings.map((heading, idx) => {
    const bodyStart = heading.start + heading.headerLength;
    const bodyEnd = idx + 1 < headings.length ? headings[idx + 1].start : content.length;
    return {
      index: heading.index,
      title: heading.title,
      body: content.slice(bodyStart, bodyEnd).trim(),
    };
  });
}

function extractPlanDescriptionFilePaths(text) {
  PLAN_DESCRIPTION_FILE_PATH_RE.lastIndex = 0;
  return [...new Set(
    [...String(text || '').matchAll(PLAN_DESCRIPTION_FILE_PATH_RE)]
      .map((match) => String(match[0] || '').replace(/^[\s`'"([]+/, '').trim())
      .filter(Boolean)
  )];
}

const PLAN_DESCRIPTION_DOC_EXT_RE = /\.(?:md|mdx|rst|txt|adoc|asciidoc)$/i;

function isDocOnlyTaskPaths(filePaths) {
  // Documentation-only tasks (README updates, plan-doc supersession, etc.)
  // naturally lack line counts and test-runner invocations, so they score
  // at most 60/100 on the generic gate even when well-specified. When every
  // extracted path is a documentation file, accept that shape and auto-
  // satisfy `estimated_scope` + `validation_steps`. The remaining three
  // signals (explicit paths, success criteria, concrete language) still
  // have to pass on their own, so vague "update docs" one-liners are still
  // rejected.
  if (!Array.isArray(filePaths) || filePaths.length === 0) return false;
  return filePaths.every((p) => PLAN_DESCRIPTION_DOC_EXT_RE.test(String(p || '')));
}

function hasObjectLevelDetail(text) {
  const value = String(text || '');
  return extractPlanDescriptionFilePaths(value).length > 0
    || /`[^`\n]+`/.test(value)
    || /\b(?:function|method|class|module|helper|endpoint|route|event|field|column|table|status|payload|schema|test)\s+[A-Za-z0-9_.#:/-]+\b/i.test(value)
    || /\b[A-Za-z_$][\w$]*\s*\([^)]*\)/.test(value);
}

function findUnqualifiedPlanDescriptionVaguePhrases(text) {
  const value = String(text || '');
  const hits = [];

  for (const phrase of PLAN_DESCRIPTION_VAGUE_PHRASES) {
    phrase.re.lastIndex = 0;
    for (const match of value.matchAll(phrase.re)) {
      const start = Math.max(0, match.index - 80);
      const end = Math.min(value.length, match.index + match[0].length + 120);
      const window = value.slice(start, end);
      if (!hasObjectLevelDetail(window)) {
        hits.push(phrase.label);
      }
    }
  }

  return [...new Set(hits)];
}

function scoreAutoGeneratedTaskDescription(task) {
  const text = `${task.title || ''}\n${task.body || ''}`.trim();
  const filePaths = extractPlanDescriptionFilePaths(text);
  const vaguePhrases = findUnqualifiedPlanDescriptionVaguePhrases(text);
  const isDocOnly = isDocOnlyTaskPaths(filePaths);
  const signals = {
    explicit_file_paths: filePaths.length > 0,
    estimated_scope: PLAN_DESCRIPTION_SCOPE_RE.test(text) || isDocOnly,
    success_criteria: PLAN_DESCRIPTION_SUCCESS_RE.test(text),
    validation_steps: PLAN_DESCRIPTION_VALIDATION_RE.test(text) || isDocOnly,
    concrete_language: vaguePhrases.length === 0,
  };
  const missingSignals = PLAN_DESCRIPTION_QUALITY_SIGNALS.filter((signal) => !signals[signal]);
  const score = PLAN_DESCRIPTION_QUALITY_SIGNALS.reduce(
    (total, signal) => total + (signals[signal] ? 20 : 0),
    0
  );
  const reasons = [];

  if (!signals.explicit_file_paths) {
    reasons.push('missing explicit file paths');
  }
  if (!signals.estimated_scope) {
    reasons.push('missing estimated scope or line/file count');
  }
  if (!signals.success_criteria) {
    reasons.push('missing clear success criteria');
  }
  if (!signals.validation_steps) {
    reasons.push('missing concrete validation command or step');
  }
  if (!signals.concrete_language) {
    reasons.push(`contains vague phrase(s) without object-level detail: ${vaguePhrases.join(', ')}`);
  }

  return {
    task_index: task.index,
    task_title: task.title || null,
    score,
    threshold: PLAN_DESCRIPTION_QUALITY_THRESHOLD,
    passed: score >= PLAN_DESCRIPTION_QUALITY_THRESHOLD,
    signals,
    missing_signals: missingSignals,
    reasons,
    vague_phrases: vaguePhrases,
    file_paths: filePaths,
  };
}

function scoreAutoGeneratedPlanDescriptions(planContent) {
  const tasks = parseAutoGeneratedPlanTasks(planContent);
  const taskScores = tasks.map(scoreAutoGeneratedTaskDescription);
  const failingTasks = taskScores.filter((taskScore) => !taskScore.passed);

  return {
    threshold: PLAN_DESCRIPTION_QUALITY_THRESHOLD,
    blocked: failingTasks.length > 0,
    tasks: taskScores,
    failures: failingTasks,
  };
}

function lintAutoGeneratedPlan(project, workItem, planContent) {
  const lintResult = architectRunner.lintPlanContent(planContent);
  const descriptionQuality = scoreAutoGeneratedPlanDescriptions(planContent);
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
      descriptionQuality,
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

  if (descriptionQuality.blocked) {
    logger.warn('PLAN lint rejected auto-generated plan for vague task descriptions', {
      project_id: project.id,
      work_item_id: workItem?.id ?? null,
      failing_task_count: descriptionQuality.failures.length,
      threshold: descriptionQuality.threshold,
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.PLAN,
      action: 'plan_description_quality_rejected',
      reasoning: `plan description quality rejected ${descriptionQuality.failures.length} task(s) below threshold ${descriptionQuality.threshold}`,
      inputs: {
        ...getWorkItemDecisionContext(workItem),
      },
      outcome: {
        threshold: descriptionQuality.threshold,
        failures: descriptionQuality.failures.map((failure) => ({
          task_index: failure.task_index,
          task_title: failure.task_title,
          score: failure.score,
          threshold: failure.threshold,
          missing_signals: failure.missing_signals,
          reasons: failure.reasons,
        })),
      },
      confidence: 1,
      batch_id: batchId,
    });
    return {
      blocked: true,
      lintResult,
      descriptionQuality,
    };
  }

  return {
    blocked: false,
    lintResult,
    descriptionQuality,
  };
}

function buildPlanDescriptionQualityRejectPayload(descriptionQuality) {
  const failingTasks = (descriptionQuality?.failures || []).map((failure) => ({
    task_index: failure.task_index,
    task_title: failure.task_title,
    score: failure.score,
    threshold: failure.threshold,
    missing_specificity_signals: failure.missing_signals,
    reasons: failure.reasons,
  }));
  const firstFailure = failingTasks[0] || {};

  return {
    code: 'plan_description_quality_below_threshold',
    failing_task_index: firstFailure.task_index ?? null,
    failing_task_title: firstFailure.task_title ?? null,
    score: firstFailure.score ?? null,
    threshold: descriptionQuality?.threshold ?? PLAN_DESCRIPTION_QUALITY_THRESHOLD,
    missing_specificity_signals: firstFailure.missing_specificity_signals || [],
    reasons: firstFailure.reasons || [],
    failing_tasks: failingTasks,
  };
}

function getWorkItemOriginObject(workItem) {
  if (workItem?.origin && typeof workItem.origin === 'object') {
    return { ...workItem.origin };
  }
  return { ...(parseJsonObject(workItem?.origin_json) || {}) };
}

const PLAN_QUALITY_REJECT_CAP = 5;

function returnAutoGeneratedPlanToPrioritizeForDescriptionQuality({
  project,
  instance = null,
  workItem,
  lint,
  planPath,
  generator = PLAN_GENERATOR_PROVIDER,
  generationTaskId = null,
}) {
  const rejectPayload = buildPlanDescriptionQualityRejectPayload(lint.descriptionQuality);
  const rejectReason = JSON.stringify(rejectPayload);
  const existingOrigin = getWorkItemOriginObject(workItem) || {};
  const priorCount = Number(existingOrigin.plan_description_quality_rejection_count || 0);
  const attemptCount = priorCount + 1;

  if (planPath && fs.existsSync(planPath)) {
    try {
      fs.unlinkSync(planPath);
    } catch (err) {
      logger.warn('PLAN lint could not remove rejected auto-generated plan file', {
        project_id: project.id,
        work_item_id: workItem?.id ?? null,
        plan_path: planPath,
        err: err.message,
      });
    }
  }

  // Retry cap: if the architect has produced vague plans for this item N
  // times in a row, further re-planning is unlikely to succeed without
  // context change. Auto-reject so PRIORITIZE doesn't re-select the same
  // item forever (Shape-3 spin seen on SpudgetBooks item 419, 46 cycles
  // in 18 minutes before detection). Filed as intake #516.
  if (attemptCount >= PLAN_QUALITY_REJECT_CAP) {
    const exhaustedOrigin = {
      ...existingOrigin,
      last_plan_description_quality_rejection: rejectPayload,
      plan_description_quality_rejection_count: attemptCount,
    };
    delete exhaustedOrigin.plan_path;

    const exhaustedReason = `plan_quality_exhausted_after_${attemptCount}_attempts`;
    const rejectedItem = factoryIntake.updateWorkItem(workItem.id, {
      status: 'rejected',
      reject_reason: exhaustedReason,
      origin_json: exhaustedOrigin,
    });

    if (instance?.id) {
      rememberSelectedWorkItem(instance.id, rejectedItem);
      factoryIntake.releaseClaimForInstance(instance.id);
    }

    logger.warn('PLAN: plan-quality retry cap reached — auto-rejecting work item', {
      project_id: project.id,
      work_item_id: workItem.id,
      attempt_count: attemptCount,
      cap: PLAN_QUALITY_REJECT_CAP,
    });

    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.PLAN,
      action: 'auto_rejected_plan_quality_exhausted',
      reasoning: `Plan-quality gate rejected ${attemptCount} architect-generated plans in a row for this work item. Auto-rejecting to prevent infinite re-plan loop (Shape-3 starvation pattern). Operator can reopen with a refined description if the item is still wanted.`,
      inputs: { ...getWorkItemDecisionContext(workItem) },
      outcome: {
        ...rejectPayload,
        work_item_id: rejectedItem.id,
        attempt_count: attemptCount,
        cap: PLAN_QUALITY_REJECT_CAP,
        next_state: LOOP_STATES.IDLE,
        plan_path: planPath || null,
        generator,
        generation_task_id: generationTaskId,
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, rejectedItem, null, instance),
    });

    return {
      reason: 'plan_quality_exhausted',
      work_item: rejectedItem,
      stop_execution: true,
      next_state: LOOP_STATES.IDLE,
      stage_result: {
        status: 'rejected',
        reason: 'plan_quality_exhausted',
        attempt_count: attemptCount,
        description_quality: rejectPayload,
        plan_path: planPath || null,
        generator,
        generation_task_id: generationTaskId,
      },
    };
  }

  const origin = {
    ...existingOrigin,
    last_plan_description_quality_rejection: rejectPayload,
    plan_description_quality_rejection_count: attemptCount,
  };
  delete origin.plan_path;

  const updatedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
    status: 'prioritized',
    reject_reason: rejectReason,
    origin_json: origin,
  });

  if (instance?.id) {
    rememberSelectedWorkItem(instance.id, updatedWorkItem);
  }

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.PLAN,
    action: 'plan_description_quality_returned_to_prioritize',
    reasoning: `Auto-generated plan task descriptions were below the deterministic specificity threshold; returning item to PRIORITIZE before EXECUTE (attempt ${attemptCount}/${PLAN_QUALITY_REJECT_CAP}).`,
    inputs: {
      ...getWorkItemDecisionContext(workItem),
    },
    outcome: {
      ...rejectPayload,
      work_item_id: updatedWorkItem.id,
      attempt_count: attemptCount,
      cap: PLAN_QUALITY_REJECT_CAP,
      next_state: LOOP_STATES.PRIORITIZE,
      plan_path: planPath || null,
      generator,
      generation_task_id: generationTaskId,
    },
    confidence: 1,
    batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
  });

  return {
    reason: 'plan description quality rejected execution',
    work_item: updatedWorkItem,
    stop_execution: true,
    next_state: LOOP_STATES.PRIORITIZE,
    stage_result: {
      status: 'returned_to_prioritize',
      reason: 'plan_description_quality_rejected',
      reject_reason: rejectReason,
      attempt_count: attemptCount,
      cap: PLAN_QUALITY_REJECT_CAP,
      description_quality: rejectPayload,
      plan_path: planPath || null,
      generator,
      generation_task_id: generationTaskId,
    },
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
    // Reject the item so the factory moves on instead of re-selecting it
    // forever. Mirrors the architect-failure reject path below.
    try {
      factoryIntake.updateWorkItem(targetItem.id, {
        status: 'rejected',
        reject_reason: 'cannot_generate_plan: no description',
      });
    } catch (_e) { void _e; }
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
        generator: PLAN_GENERATOR_PROVIDER,
        generation_task_id: null,
        ...getWorkItemDecisionContext(targetItem),
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, targetItem, null, instance),
    });
    return {
      reason: 'no description',
      work_item: targetItem,
      stop_execution: true,
      next_state: LOOP_STATES.IDLE,
    };
  }

  const planPath = buildAutoGeneratedPlanPath(project, targetItem);
  const nextOrigin = {
    ...(targetItem.origin && typeof targetItem.origin === 'object' ? targetItem.origin : {}),
    plan_path: planPath,
    plan_generator_provider: PLAN_GENERATOR_PROVIDER,
  };

  if (fs.existsSync(planPath)) {
    const updatedWorkItem = factoryIntake.updateWorkItem(targetItem.id, {
      origin_json: nextOrigin,
      status: 'executing',
    });
    rememberSelectedWorkItem(instance.id, updatedWorkItem);
    const existingPlanContent = fs.readFileSync(planPath, 'utf8');
    const trustLevel = project.trust_level || 'supervised';
    const lint = lintAutoGeneratedPlan(project, updatedWorkItem, existingPlanContent);
    const lintHasErrors = (lint.lintResult?.errors || []).length > 0;
    if (lintHasErrors && trustLevel !== 'autonomous' && trustLevel !== 'dark') {
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
    if (lint.descriptionQuality?.blocked) {
      return returnAutoGeneratedPlanToPrioritizeForDescriptionQuality({
        project,
        instance,
        workItem: updatedWorkItem,
        lint,
        planPath,
      });
    }
    if (lint.blocked && trustLevel !== 'autonomous' && trustLevel !== 'dark') {
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

  const { submitFactoryInternalTask } = require('./internal-task-submit');
  const { handleAwaitTask } = require('../handlers/workflow/await');
  const taskCore = require('../db/task-core');
  const prompt = buildAutoGeneratedPlanPrompt(project, targetItem);
  let generationTaskId = null;

  try {
    const { task_id } = await submitFactoryInternalTask({
      task: prompt,
      project: 'factory-architect',
      provider: PLAN_GENERATOR_PROVIDER,
      working_directory: project.path || process.cwd(),
      kind: 'plan_generation',
      project_id: project.id,
      work_item_id: targetItem.id,
      timeout_minutes: 10,
    });

    generationTaskId = task_id;
    if (!generationTaskId) {
      throw new Error('smart_submit_task did not return task_id');
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
    let normalizedPlanMarkdown = normalizeAutoGeneratedPlanMarkdown(rawPlanMarkdown, targetItem, project);
    if (!normalizedPlanMarkdown) {
      throw new Error('generated plan output did not contain any "## Task N:" sections');
    }

    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, normalizedPlanMarkdown);

    let updatedWorkItem = factoryIntake.updateWorkItem(targetItem.id, {
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
      reasoning: `generated plan via ${PLAN_GENERATOR_LABEL} for non-plan-file work item`,
      inputs: {
        ...getWorkItemDecisionContext(targetItem),
      },
      outcome: {
        work_item_id: updatedWorkItem.id,
        plan_path: planPath,
        generator: PLAN_GENERATOR_PROVIDER,
        generation_task_id: generationTaskId,
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
    });

    const trustLevel = project.trust_level || 'supervised';
    const lint = lintAutoGeneratedPlan(project, updatedWorkItem, normalizedPlanMarkdown);
    const lintHasErrors = (lint.lintResult?.errors || []).length > 0;
    if (lintHasErrors && trustLevel !== 'autonomous' && trustLevel !== 'dark') {
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
          generator: PLAN_GENERATOR_PROVIDER,
          generation_task_id: generationTaskId,
        },
      };
    }
    if (lint.descriptionQuality?.blocked) {
      return returnAutoGeneratedPlanToPrioritizeForDescriptionQuality({
        project,
        instance,
        workItem: updatedWorkItem,
        lint,
        planPath,
        generator: PLAN_GENERATOR_PROVIDER,
        generationTaskId,
      });
    }
    if (lint.blocked && trustLevel !== 'autonomous' && trustLevel !== 'dark') {
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
          generator: PLAN_GENERATOR_PROVIDER,
          generation_task_id: generationTaskId,
        },
      };
    }

    // --- Plan quality gate ------------------------------------------------
    // Read the ORIGINAL origin_json from targetItem (pre-nextOrigin overwrite)
    // so flags like skip_plan_quality_gate that aren't propagated into
    // nextOrigin still control gate behavior.
    const origin = (() => {
      try {
        const fromTarget = targetItem?.origin && typeof targetItem.origin === 'object'
          ? targetItem.origin
          : JSON.parse(targetItem?.origin_json || '{}');
        const fromUpdated = JSON.parse(updatedWorkItem.origin_json || '{}') || {};
        return { ...fromTarget, ...fromUpdated };
      } catch { return {}; }
    })();
    const planQualityGate = require('./plan-quality-gate');

    if (origin.skip_plan_quality_gate === true) {
      eventBus.emitFactoryPlanGateSkipped({
        project_id: project.id,
        work_item_id: updatedWorkItem.id,
        reason: 'metadata_override',
      });
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.PLAN,
        action: 'plan_quality_skipped_by_metadata',
        reasoning: 'Work item origin.skip_plan_quality_gate is true; bypassing the gate.',
        outcome: { work_item_id: updatedWorkItem.id },
        confidence: 1,
        batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
      });
    } else {
      let gateVerdict = null;
      try {
        gateVerdict = await planQualityGate.evaluatePlan({
          plan: normalizedPlanMarkdown,
          workItem: updatedWorkItem,
          project,
        });
      } catch (err) {
        logger.warn('plan-quality-gate evaluation failed; treating as pass (fail-open)', {
          project_id: project.id,
          work_item_id: updatedWorkItem.id,
          err: err.message,
        });
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.PLAN,
          action: 'plan_quality_gate_fail_open',
          reasoning: `Gate threw: ${err.message}`,
          outcome: { work_item_id: updatedWorkItem.id },
          confidence: 1,
          batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
        });
      }

      if (gateVerdict && gateVerdict.passed) {
        origin.plan_gen_attempts = (origin.plan_gen_attempts || 0) + 1;
        factoryIntake.updateWorkItem(updatedWorkItem.id, {
          origin_json: JSON.stringify(origin),
        });
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.PLAN,
          action: 'plan_quality_passed',
          reasoning: 'Plan quality gate accepted the generated plan.',
          outcome: {
            work_item_id: updatedWorkItem.id,
            attempts: origin.plan_gen_attempts,
            warnings: gateVerdict.warnings.length,
          },
          confidence: 1,
          batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
        });
      } else if (gateVerdict && !gateVerdict.passed) {
        const attemptsBefore = origin.plan_gen_attempts || 0;
        origin.plan_gen_attempts = attemptsBefore + 1;
        origin.last_gate_feedback = gateVerdict.feedbackPrompt;

        const humanTrust = trustLevel === 'supervised' || trustLevel === 'guided';
        if (humanTrust) {
          // Pause for operator review. Reuse the existing PAUSED_AT_PLAN_REVIEW surface.
          factoryIntake.updateWorkItem(updatedWorkItem.id, {
            origin_json: JSON.stringify(origin),
          });
          eventBus.emitFactoryPlanRejectedQuality({
            project_id: project.id,
            work_item_id: updatedWorkItem.id,
            rule_violations: gateVerdict.hardFails,
            attempt: origin.plan_gen_attempts,
          });
          safeLogDecision({
            project_id: project.id,
            stage: LOOP_STATES.PLAN,
            action: 'plan_quality_rejected_will_replan',
            reasoning: 'Plan quality gate rejected the plan; pausing for operator (supervised/guided trust).',
            outcome: { work_item_id: updatedWorkItem.id, hardFails: gateVerdict.hardFails.map(h => h.rule) },
            confidence: 1,
            batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
          });
          return {
            reason: 'plan quality gate rejected execution',
            work_item: factoryIntake.getWorkItem(updatedWorkItem.id) || updatedWorkItem,
            stop_execution: true,
            next_state: LOOP_STATES.PAUSED,
            paused_at_stage: LOOP_STATES.PLAN_REVIEW,
            stage_result: {
              status: 'paused',
              reason: 'plan_quality_rejected',
              gate_feedback: gateVerdict.feedbackPrompt,
              hardFails: gateVerdict.hardFails,
              warnings: gateVerdict.warnings,
              llmCritique: gateVerdict.llmCritique,
            },
          };
        }

        // autonomous / dark path
        if (attemptsBefore >= planQualityGate.MAX_REPLAN_ATTEMPTS) {
          // Final rejection: close the item, return to IDLE.
          factoryIntake.updateWorkItem(updatedWorkItem.id, {
            status: 'rejected',
            reject_reason: 'plan_quality_gate_rejected_after_2_attempts',
            origin_json: JSON.stringify(origin),
          });
          eventBus.emitFactoryPlanRejectedFinal({
            project_id: project.id,
            work_item_id: updatedWorkItem.id,
            rule_violations: gateVerdict.hardFails,
          });
          safeLogDecision({
            project_id: project.id,
            stage: LOOP_STATES.PLAN,
            action: 'plan_quality_rejected_final',
            reasoning: 'Plan quality gate rejected on both attempts; closing item.',
            outcome: { work_item_id: updatedWorkItem.id, hardFails: gateVerdict.hardFails.map(h => h.rule) },
            confidence: 1,
            batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
          });
          return {
            reason: 'plan quality gate rejected on final attempt',
            work_item: factoryIntake.getWorkItem(updatedWorkItem.id) || updatedWorkItem,
            stop_execution: true,
            next_state: LOOP_STATES.IDLE,
          };
        }

        // Re-plan attempt
        factoryIntake.updateWorkItem(updatedWorkItem.id, {
          origin_json: JSON.stringify(origin),
        });
        eventBus.emitFactoryPlanRejectedQuality({
          project_id: project.id,
          work_item_id: updatedWorkItem.id,
          rule_violations: gateVerdict.hardFails,
          attempt: origin.plan_gen_attempts,
        });
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.PLAN,
          action: 'plan_quality_rejected_will_replan',
          reasoning: 'Plan quality gate rejected the plan; re-invoking plan generation with feedback.',
          outcome: { work_item_id: updatedWorkItem.id, attempt: origin.plan_gen_attempts },
          confidence: 1,
          batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
        });

        // Re-invoke plan generation with prior feedback prepended.
        const rePrompt = buildAutoGeneratedPlanPrompt(project, updatedWorkItem, gateVerdict.feedbackPrompt);
        let reTaskId = null;
        try {
          const reSubmit = await submitFactoryInternalTask({
            task: rePrompt,
            working_directory: project.path || process.cwd(),
            kind: 'plan_generation',
            project_id: project.id,
            work_item_id: updatedWorkItem.id,
            timeout_minutes: 10,
          });
          reTaskId = reSubmit?.task_id || null;
        } catch (err) {
          logger.warn('plan-quality-gate re-plan submit failed', {
            project_id: project.id,
            work_item_id: updatedWorkItem.id,
            err: err.message,
          });
        }
        if (!reTaskId) {
          factoryIntake.updateWorkItem(updatedWorkItem.id, {
            status: 'rejected',
            reject_reason: 'replan_generation_failed',
          });
          return {
            reason: 're-plan submission failed',
            work_item: factoryIntake.getWorkItem(updatedWorkItem.id) || updatedWorkItem,
            stop_execution: true,
            next_state: LOOP_STATES.IDLE,
          };
        }

        let reTask = null;
        try {
          await handleAwaitTask({ task_id: reTaskId, timeout_minutes: 10, heartbeat_minutes: 0 });
          reTask = taskCore.getTask(reTaskId);
        } catch (err) {
          logger.warn('plan-quality-gate re-plan await failed', {
            project_id: project.id,
            work_item_id: updatedWorkItem.id,
            task_id: reTaskId,
            err: err.message,
          });
        }
        if (!reTask || reTask.status !== 'completed') {
          factoryIntake.updateWorkItem(updatedWorkItem.id, {
            status: 'rejected',
            reject_reason: 'replan_generation_failed',
          });
          return {
            reason: 're-plan task did not complete',
            work_item: factoryIntake.getWorkItem(updatedWorkItem.id) || updatedWorkItem,
            stop_execution: true,
            next_state: LOOP_STATES.IDLE,
          };
        }

        const rawRePlanMarkdown = extractTextContent(reTask.output) || '';
        const rePlanMarkdown = normalizeAutoGeneratedPlanMarkdown(rawRePlanMarkdown, updatedWorkItem, project)
          || String(rawRePlanMarkdown).trim();
        if (!rePlanMarkdown) {
          factoryIntake.updateWorkItem(updatedWorkItem.id, {
            status: 'rejected',
            reject_reason: 'replan_generation_failed',
          });
          return {
            reason: 're-plan produced empty output',
            work_item: factoryIntake.getWorkItem(updatedWorkItem.id) || updatedWorkItem,
            stop_execution: true,
            next_state: LOOP_STATES.IDLE,
          };
        }

        // Write to the same plan path.
        try {
          fs.writeFileSync(origin.plan_path || planPath, rePlanMarkdown, 'utf8');
        } catch (err) {
          logger.warn('plan-quality-gate re-plan writeFile failed', {
            project_id: project.id,
            work_item_id: updatedWorkItem.id,
            plan_path: origin.plan_path || planPath,
            err: err.message,
          });
        }

        // Re-run lint + gate on the second plan.
        const reLint = lintAutoGeneratedPlan(project, updatedWorkItem, rePlanMarkdown);
        if (reLint.descriptionQuality?.blocked) {
          return returnAutoGeneratedPlanToPrioritizeForDescriptionQuality({
            project,
            instance,
            workItem: updatedWorkItem,
            lint: reLint,
            planPath: origin.plan_path || planPath,
            generator: PLAN_GENERATOR_PROVIDER,
            generationTaskId: reTaskId,
          });
        }
        if (reLint.blocked && trustLevel !== 'autonomous' && trustLevel !== 'dark') {
          // Supervised/guided re-plan lint fail still follows the legacy lint path; omitted here.
          return {
            reason: 'plan lint rejected re-plan',
            work_item: updatedWorkItem,
            stop_execution: true,
            next_state: LOOP_STATES.PAUSED,
            paused_at_stage: LOOP_STATES.PLAN_REVIEW,
          };
        }

        let reGateVerdict = null;
        try {
          reGateVerdict = await planQualityGate.evaluatePlan({
            plan: rePlanMarkdown,
            workItem: updatedWorkItem,
            project,
          });
        } catch (err) {
          logger.warn('plan-quality-gate re-evaluation failed; fail-open', {
            project_id: project.id,
            work_item_id: updatedWorkItem.id,
            err: err.message,
          });
        }

        if (reGateVerdict && reGateVerdict.passed) {
          origin.plan_gen_attempts = (origin.plan_gen_attempts || 0) + 1;
          factoryIntake.updateWorkItem(updatedWorkItem.id, {
            origin_json: JSON.stringify(origin),
          });
          safeLogDecision({
            project_id: project.id,
            stage: LOOP_STATES.PLAN,
            action: 'plan_quality_passed',
            reasoning: 'Re-plan accepted by quality gate.',
            outcome: { work_item_id: updatedWorkItem.id, attempts: origin.plan_gen_attempts },
            confidence: 1,
            batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
          });
          // Fall through — EXECUTE proceeds with the re-planned plan.
          normalizedPlanMarkdown = rePlanMarkdown;
          updatedWorkItem = factoryIntake.getWorkItem(updatedWorkItem.id) || updatedWorkItem;
        } else {
          // Second attempt failed (including fail-open null): final rejection.
          const finalOrigin = {
            ...origin,
            plan_gen_attempts: (origin.plan_gen_attempts || 0) + 1,
            last_gate_feedback: reGateVerdict?.feedbackPrompt || origin.last_gate_feedback,
          };
          factoryIntake.updateWorkItem(updatedWorkItem.id, {
            status: 'rejected',
            reject_reason: 'plan_quality_gate_rejected_after_2_attempts',
            origin_json: JSON.stringify(finalOrigin),
          });
          eventBus.emitFactoryPlanRejectedFinal({
            project_id: project.id,
            work_item_id: updatedWorkItem.id,
            rule_violations: reGateVerdict?.hardFails || [],
          });
          safeLogDecision({
            project_id: project.id,
            stage: LOOP_STATES.PLAN,
            action: 'plan_quality_rejected_final',
            reasoning: 'Re-plan also rejected by gate; closing item.',
            outcome: { work_item_id: updatedWorkItem.id },
            confidence: 1,
            batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
          });
          return {
            reason: 'plan quality gate rejected on final attempt',
            work_item: factoryIntake.getWorkItem(updatedWorkItem.id) || updatedWorkItem,
            stop_execution: true,
            next_state: LOOP_STATES.IDLE,
          };
        }
      } else if (gateVerdict === null) {
        // Fail-open already handled above (gate threw); counter still ticks so attempts are visible.
        origin.plan_gen_attempts = (origin.plan_gen_attempts || 0) + 1;
        factoryIntake.updateWorkItem(updatedWorkItem.id, {
          origin_json: JSON.stringify(origin),
        });
      }
    }
    // ----------------------------------------------------------------------

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
            generator: PLAN_GENERATOR_PROVIDER,
            generation_task_id: generationTaskId,
          },
        };
      }
    }

    return {
      reason: `generated plan via ${PLAN_GENERATOR_LABEL}`,
      work_item: updatedWorkItem,
      stage_result: {
        plan_path: planPath,
        generator: PLAN_GENERATOR_PROVIDER,
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
        generator: PLAN_GENERATOR_PROVIDER,
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

  // Spin detector: if this batch has re-entered EXECUTE many times in a
  // short window without making forward progress, the loop is thrashing —
  // something is causing the stage to re-enter (stage-handler bug, stale
  // worktree state, provider stuck, etc.) without surfacing a terminal
  // result. Rather than burn CPU + decision-log volume indefinitely,
  // auto-reject the work item and terminate the instance. The operator
  // can reopen after investigation; the loop moves on to other work.
  //
  // Threshold: >=5 `starting` events for this batch within 5 minutes.
  // Tuned to avoid false positives on legitimately-long EXECUTE cycles
  // (one task per minute under load) while catching the 34-second spin
  // pattern seen on torque-public item 100 and bitsy item 479 today.
  try {
    const windowSince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const recentExecute = factoryDecisions.listDecisions(project.id, {
      stage: LOOP_STATES.EXECUTE.toLowerCase(),
      since: windowSince,
      limit: 200,
    });
    const startingEntries = recentExecute.filter((d) => (
      d.action === 'starting' && d.batch_id === executeLogBatchId
    ));
    const SPIN_THRESHOLD = 5;
    if (startingEntries.length >= SPIN_THRESHOLD) {
      factoryIntake.updateWorkItem(targetItem.id, {
        status: 'rejected',
        reject_reason: `execute_spin_loop_${startingEntries.length}_starts_in_5min`,
      });
      logger.warn('EXECUTE stage: spin-loop detected — auto-rejecting work item', {
        project_id: project.id,
        work_item_id: targetItem.id,
        batch_id: executeLogBatchId,
        starts_in_window: startingEntries.length,
        window_since: windowSince,
      });
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'auto_rejected_spin_loop',
        reasoning: `EXECUTE stage re-entered ${startingEntries.length} times in 5 minutes for the same batch without making forward progress. Auto-rejecting the work item to break the spin and let the loop move on. Operator can reopen after investigation.`,
        inputs: { ...getWorkItemDecisionContext(targetItem) },
        outcome: {
          starts_in_window: startingEntries.length,
          threshold: SPIN_THRESHOLD,
          window_since: windowSince,
          next_state: LOOP_STATES.IDLE,
        },
        confidence: 1,
        batch_id: executeLogBatchId,
      });
      return {
        next_state: LOOP_STATES.IDLE,
        stop_execution: true,
        reason: 'auto_rejected_spin_loop',
        stage_result: {
          status: 'rejected',
          reason: 'spin_loop',
          starts_in_window: startingEntries.length,
        },
        work_item: targetItem,
      };
    }
  } catch (spinErr) {
    // Detector failure must not block the stage — worst case we miss a
    // spin (which will eventually self-resolve or hit another guard).
    logger.debug('spin-detector check failed', {
      project_id: project.id,
      err: spinErr.message,
    });
  }

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
      // Pre-reclaim: sweep any stale factory_worktrees row for the target
      // branch BEFORE calling createForBatch. The previous ordering did the
      // reclaim AFTER create, which let the stale cleanup destroy the
      // just-created worktree whenever the stale vc row pointed at the same
      // branch/path (which it always does — path is deterministic from the
      // branch). Resolve the branch deterministically, clean the slot, then
      // create into a guaranteed-empty target.
      const { resolveBranchName } = require('./worktree-runner');
      const targetBranch = resolveBranchName({ workItem: targetItem });
      const stale = factoryWorktrees.getActiveWorktreeByBranch(targetBranch);
      if (stale) {
        logger.warn('factory worktree: pre-reclaiming stale active row before create', {
          project_id: project.id,
          work_item_id: targetItem.id,
          branch: targetBranch,
          stale_factory_worktree_id: stale.id,
          stale_batch_id: stale.batch_id,
          owning_task_id: stale.owningTaskId || null,
        });
        // If a live task owns the stale worktree, cancel it first and wait
        // briefly for the process to exit so file handles release. Without
        // this the subsequent `git worktree remove` / fs.rmSync hit
        // "Device or resource busy" on Windows and the reclaim produces
        // phantom state.
        if (stale.owningTaskId) {
          try {
            const taskCore = require('../db/task-core');
            const owning = taskCore.getTask(stale.owningTaskId);
            const liveStatuses = new Set(['queued', 'running', 'pending']);
            if (owning && liveStatuses.has(owning.status)) {
              logger.warn('factory worktree: cancelling owning task before reclaim', {
                factory_worktree_id: stale.id,
                owning_task_id: stale.owningTaskId,
                status: owning.status,
              });
              try {
                const taskManager = require('../task-manager');
                taskManager.cancelTask(
                  stale.owningTaskId,
                  'pre_reclaim_before_create',
                  { cancel_reason: 'worktree_reclaim' },
                );
              } catch (cancelErr) {
                logger.warn('factory worktree: cancel owning task threw', {
                  owning_task_id: stale.owningTaskId,
                  err: cancelErr && cancelErr.message,
                });
              }
              const deadline = Date.now() + 5000;
              while (Date.now() < deadline) {
                const latest = taskCore.getTask(stale.owningTaskId);
                if (!latest) break;
                if (['completed', 'failed', 'cancelled', 'skipped'].includes(latest.status)) {
                  break;
                }
                await new Promise((resolveWait) => setTimeout(resolveWait, 250));
              }
            }
          } catch (ownershipErr) {
            logger.warn('factory worktree: owning-task check failed; proceeding with reclaim', {
              stale_factory_worktree_id: stale.id,
              err: ownershipErr && ownershipErr.message,
            });
          }
        }
        factoryWorktrees.markAbandoned(stale.id, 'pre_reclaim_before_create');
        if (typeof worktreeRunner.abandon === 'function' && stale.vcWorktreeId) {
          // Let errors propagate — if cleanup fails (e.g. a process still
          // holds a file lock), the outer catch will pause EXECUTE with a
          // real diagnostic instead of silently proceeding into a broken
          // worktree state.
          await worktreeRunner.abandon({
            id: stale.vcWorktreeId,
            branch: stale.branch,
            reason: 'pre_reclaim_before_create',
          });
        }
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.EXECUTE,
          action: 'worktree_reclaimed',
          reasoning: 'Pre-reclaimed stale active factory_worktrees row before creating fresh worktree.',
          inputs: { ...getWorkItemDecisionContext(targetItem) },
          outcome: {
            stale_factory_worktree_id: stale.id,
            stale_batch_id: stale.batch_id,
            branch: targetBranch,
          },
          confidence: 1,
          batch_id: executeLogBatchId,
        });
      }

      try {
        createdWorktree = await worktreeRunner.createForBatch({
          project,
          workItem: targetItem,
          batchId: executeLogBatchId,
        });
      } catch (firstErr) {
        // Retry once after reconciling orphan worktrees if the error looks
        // like a stale-state collision. "already exists" is how git reports
        // both stale path entries and stale branch names. Reconciling the
        // project's .worktrees/ against the DB removes any dir whose DB row
        // is abandoned/shipped/merged (or missing for a factory-named dir),
        // then the retry proceeds on a clean slate. We only retry on the
        // already-exists signal — other failures (permissions, disk full)
        // should surface immediately.
        const errMsg = firstErr && typeof firstErr.message === 'string' ? firstErr.message : '';
        if (/already exists/i.test(errMsg)) {
          try {
            const database = require('../database');
            const db = database.getDbInstance();
            if (db && project.path) {
              const { reconcileProject: reconcileOrphanWorktrees } = require('./worktree-reconcile');
              const rec = reconcileOrphanWorktrees({
                db,
                project_id: project.id,
                project_path: project.path,
              });
              logger.warn('factory worktree: reconciled orphans before retry', {
                project_id: project.id,
                work_item_id: targetItem.id,
                cleaned: rec.cleaned.length,
                failed: rec.failed.length,
              });
            }
          } catch (reconcileErr) {
            logger.warn('factory worktree: reconcile-before-retry failed', {
              project_id: project.id,
              err: reconcileErr.message,
            });
          }
          createdWorktree = await worktreeRunner.createForBatch({
            project,
            workItem: targetItem,
            batchId: executeLogBatchId,
          });
        } else {
          throw firstErr;
        }
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
      // Record the task as the worktree's current owner so the pre-reclaim
      // flow can cancel it before trying to clean up the directory. Only
      // applies when a factory worktree is active (non-worktree executions
      // fall through without owner tracking).
      if (worktreeRecord && worktreeRecord.id) {
        try {
          factoryWorktrees.setOwningTask(worktreeRecord.id, result.task_id);
        } catch (ownErr) {
          logger.warn('factory worktree: setOwningTask failed', {
            factory_worktree_id: worktreeRecord.id,
            task_id: result.task_id,
            err: ownErr && ownErr.message,
          });
        }
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

  let result;
  try {
    result = await executor.execute({
      plan_path: planPathForExecutor,
      project: project.name,
      working_directory: executionWorkingDirectory,
      execution_mode: executeMode,
    });
  } catch (execErr) {
    // Silent-spin fix: before this catch, any exception from the plan
    // executor (submit failure, fs.readFileSync ENOENT on a missing
    // worktree-plan, await timeout, etc.) propagated unwrapped back to
    // runAdvanceLoop, which logged a generic warning and retried after
    // 30s without updating the instance state or emitting a decision.
    // The loop thrashed every 30s on the same failure forever (seen on
    // torque-public item 100 and bitsy item 479 today). Capture the
    // exception, surface it in the decision log, and pause the instance
    // so the operator can see what went wrong and the tick stops
    // re-driving the same dead end.
    factoryIntake.updateWorkItem(targetItem.id, {
      status: 'in_progress',
      reject_reason: `execute_exception: ${(execErr?.message || '').slice(0, 160)}`,
    });
    logger.error('EXECUTE stage: plan executor threw — pausing at EXECUTE', {
      project_id: project.id,
      work_item_id: targetItem.id,
      plan_path: planPathForExecutor,
      err: execErr?.message || String(execErr),
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'execute_exception',
      reasoning: `Plan executor threw: ${(execErr?.message || '').slice(0, 180)}. Pausing at EXECUTE — auto-advance would otherwise silently retry every 30s on the same failure.`,
      inputs: { ...getWorkItemDecisionContext(targetItem) },
      outcome: {
        error: (execErr?.message || String(execErr)).slice(0, 500),
        plan_path: planPathForExecutor,
        next_state: LOOP_STATES.PAUSED,
        paused_at_stage: LOOP_STATES.EXECUTE,
      },
      confidence: 1,
      batch_id: decisionBatchId,
    });
    return {
      next_state: LOOP_STATES.PAUSED,
      paused_at_stage: LOOP_STATES.EXECUTE,
      stop_execution: true,
      reason: 'execute_exception',
      stage_result: {
        status: 'paused',
        reason: 'execute_exception',
        error: (execErr?.message || String(execErr)).slice(0, 500),
      },
      work_item: targetItem,
    };
  }

  // Fix 1: if live execute returned zero completions AND zero failures,
  // pause at EXECUTE — VERIFY would false-pass on the empty branch and the
  // loop would otherwise cycle forever on the same work item.
  //
  // Auto-recovery: reason `plan_parsed_zero_tasks` is deterministic and
  // means the parser can't even see any tasks — retrying with the same
  // plan will always fail. Reject the item outright so the loop moves to
  // the next work item instead of requiring operator intervention. Other
  // reasons (e.g. `all_tasks_skipped_or_unprocessed`) may be transient
  // (flaky provider, task mid-flight) and still pause for review.
  if (result.no_tasks_executed) {
    const unrecoverable = result.no_tasks_reason === 'plan_parsed_zero_tasks';
    const updatedStatus = unrecoverable ? 'rejected' : 'in_progress';
    const rejectReason = unrecoverable
      ? 'plan_parsed_zero_tasks'
      : `execute_failed_no_tasks_${result.no_tasks_reason || 'unknown'}`;
    factoryIntake.updateWorkItem(targetItem.id, {
      status: updatedStatus,
      reject_reason: rejectReason,
    });
    const level = unrecoverable ? 'warn' : 'error';
    logger[level]('EXECUTE stage: live executor produced no completed and no failed tasks', {
      project_id: project.id,
      work_item_id: targetItem.id,
      reason: result.no_tasks_reason,
      parsed_task_count: result.parsed_task_count,
      plan_path: targetItem.origin.plan_path,
      resolution: unrecoverable ? 'auto_rejected' : 'paused_for_operator',
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: unrecoverable ? 'auto_rejected_unparseable_plan' : 'execution_failed_no_tasks',
      reasoning: unrecoverable
        ? `Plan at ${targetItem.origin.plan_path} parsed to zero tasks — rejecting work item to avoid infinite re-entry. Retrying would produce the same zero-task result on every tick.`
        : `Live plan executor produced no completed and no failed tasks (${result.no_tasks_reason}). Pausing at EXECUTE so the operator can investigate (likely a worktree-copy mismatch or mid-flight task state).`,
      inputs: {
        ...getWorkItemDecisionContext(targetItem),
      },
      outcome: {
        no_tasks_reason: result.no_tasks_reason,
        parsed_task_count: result.parsed_task_count,
        plan_path: targetItem.origin.plan_path,
        next_state: unrecoverable ? LOOP_STATES.IDLE : LOOP_STATES.PAUSED,
        paused_at_stage: unrecoverable ? null : LOOP_STATES.EXECUTE,
      },
      confidence: 1,
      batch_id: decisionBatchId,
    });
    if (unrecoverable) {
      // Terminate the instance so the tick picks the next work item from
      // SENSE on its next cycle.
      return {
        next_state: LOOP_STATES.IDLE,
        stop_execution: true,
        reason: 'auto_rejected_unparseable_plan',
        stage_result: {
          ...result,
          status: 'rejected',
        },
        work_item: targetItem,
      };
    }
    return {
      next_state: LOOP_STATES.PAUSED,
      paused_at_stage: LOOP_STATES.EXECUTE,
      stop_execution: true,
      reason: 'execute_failed_no_tasks',
      stage_result: {
        ...result,
        status: 'paused',
      },
      work_item: targetItem,
    };
  }

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
// Fix 4: separate budget for transient submission failures (no_task_id,
// submit_threw). These are not test failures — they're auto-router or
// provider hiccups that may recover on a subsequent attempt. Capped low
// so a persistent provider outage doesn't spin forever.
const MAX_SUBMISSION_FAILURES = 2;
const FATAL_SUBMISSION_REASONS = new Set(['cwd_missing']);

// Retry counter persistence: count tasks tagged factory:verify_retry=N that
// share this batch_id. executeVerifyStage uses this to seed its local
// retryAttempt so re-entries (stall recovery, VERIFY_FAIL resume, dispatcher
// dispatch) cannot reset the counter and cycle 1..3 again forever. Tags are
// already written on every verify-retry submission, so there's no new schema
// cost for this counter — the tasks table is the source of truth.
function countPriorVerifyRetryTasksForBatch(batch_id) {
  if (!batch_id) return 0;
  try {
    const taskCore = require('../db/task-core');
    const tasks = taskCore.listTasks({
      tags: [`factory:batch_id=${batch_id}`],
      limit: 200,
    });
    return tasks.filter((t) =>
      Array.isArray(t.tags)
      && t.tags.some((tag) => typeof tag === 'string' && tag.startsWith('factory:verify_retry=')),
    ).length;
  } catch {
    return 0;
  }
}

// Fix 2: detect the "no commits ahead of <base>" merge-time failure that
// signals an empty execution. Pure helpers are exported for testability.
function isEmptyBranchMergeError(message) {
  return typeof message === 'string' && /no commits ahead/i.test(message);
}

function countPriorEmptyMergeFailuresForWorkItem(decisions, workItemId) {
  if (!Array.isArray(decisions) || workItemId == null) return 0;
  return decisions.filter((d) => {
    if (!d || d.action !== 'worktree_merge_failed') return false;
    const outcome = d.outcome || {};
    if (outcome.work_item_id !== workItemId) return false;
    return isEmptyBranchMergeError(outcome.error || '');
  }).length;
}

function shouldQuarantineForEmptyMerges({ currentErrorMessage, priorDecisions, workItemId, threshold = 1 }) {
  if (!isEmptyBranchMergeError(currentErrorMessage)) return false;
  return countPriorEmptyMergeFailuresForWorkItem(priorDecisions, workItemId) >= threshold;
}

function stripAnsi(text) {
  return typeof text === 'string'
    ? text.replace(/\u001b\[[0-9;]*m/g, '')
    : '';
}

// The factory's verify-retry prompt feeds Codex the tail of the verify output
// so it can fix the failure. 4000 chars was too narrow for typical pip / dotnet /
// pytest failures: a full traceback + Python context easily evicts the actual
// error line off the top of the window, leaving the retry to guess blind.
// 16000 gives the root cause enough room alongside the traceback without
// blowing past reasonable prompt budgets.
const VERIFY_FIX_PROMPT_TAIL_BUDGET = 16000;

const VERIFY_FIX_PROMPT_PRIOR_BUDGET = 1800;

function renderFilesTouched(files, file_count) {
  const arr = Array.isArray(files) ? files : [];
  if (arr.length === 0) return 'none';
  const head = arr.slice(0, 5).join(', ');
  const extra = file_count > 5 ? ` (+${file_count - 5} more)` : '';
  return `${head}${extra}`;
}

function renderAttempt(a, labelNumber) {
  const verifyRetryIdx = labelNumber == null ? '' : ` (verify retry #${labelNumber})`;
  const kindLabel = a.kind === 'verify_retry' ? `verify_retry${verifyRetryIdx}` : 'execute';
  const head = `- Attempt ${a.attempt} (${kindLabel}): ${a.file_count} files touched`;
  const filesPart = a.file_count > 0 ? ` — ${renderFilesTouched(a.files_touched, a.file_count)}.` : '';
  const classified = a.file_count === 0 && a.zero_diff_reason
    ? ` — classified as \`${a.zero_diff_reason}\`.`
    : '.';
  const summary = String(a.stdout_tail || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const summaryLine = summary ? `\n  Codex summary: "${summary}"` : '';
  return `${head}${filesPart}${classified}${summaryLine}`;
}

function renderProgression(prevOutput, currOutput) {
  try {
    const { extractFailingTestNames } = require('./verify-signature');
    const prev = extractFailingTestNames(prevOutput);
    const curr = extractFailingTestNames(currOutput);
    if (prev.length === 0 && curr.length === 0) return null;

    const prevSet = new Set(prev);
    const currSet = new Set(curr);
    const newlyPassing = prev.filter((n) => !currSet.has(n));
    const newlyFailing = curr.filter((n) => !prevSet.has(n));

    const lines = ['Verify error progression:'];
    lines.push(`- Previous run failed with: ${prev.length} failure${prev.length === 1 ? '' : 's'}${prev.length ? ` ("${prev.slice(0, 3).join('", "')}"${prev.length > 3 ? ', …' : ''})` : ''}`);
    lines.push(`- This run is failing with: ${curr.length} failure${curr.length === 1 ? '' : 's'}${curr.length ? ` ("${curr.slice(0, 3).join('", "')}"${curr.length > 3 ? ', …' : ''})` : ''}`);
    let verdict;
    if (newlyPassing.length > 0 && newlyFailing.length === 0) {
      verdict = `  → Partial progress. ${newlyPassing.length} test${newlyPassing.length === 1 ? '' : 's'} now passing. Keep current approach.`;
    } else if (newlyFailing.length > 0 && newlyPassing.length === 0) {
      verdict = `  → New failures introduced. Consider reverting part of last attempt.`;
    } else if (newlyPassing.length === 0 && newlyFailing.length === 0 && prev.length > 0) {
      verdict = `  → Same failures. Previous approach did not move the needle; try a different angle.`;
    } else if (newlyPassing.length > 0 && newlyFailing.length > 0) {
      verdict = `  → Mixed: ${newlyPassing.length} newly passing, ${newlyFailing.length} newly failing.`;
    } else {
      verdict = `  → No comparable change.`;
    }
    lines.push(verdict);
    return lines.join('\n');
  } catch {
    return null;
  }
}

function buildPriorAttemptsBlock(priorAttempts, verifyOutputPrev, verifyOutput) {
  const attempts = Array.isArray(priorAttempts) ? [...priorAttempts] : [];
  if (attempts.length === 0) return null;

  attempts.sort((a, b) => a.attempt - b.attempt);

  let verifyRetryIdx = 0;
  const rendered = attempts.map((a) => {
    if (a.kind === 'verify_retry') {
      verifyRetryIdx += 1;
      return renderAttempt(a, verifyRetryIdx);
    }
    return renderAttempt(a, null);
  });

  let elidedCount = 0;
  let block = `Prior attempts on this work item:\n${rendered.join('\n')}`;
  while (block.length > VERIFY_FIX_PROMPT_PRIOR_BUDGET && rendered.length > 1) {
    rendered.shift();
    elidedCount += 1;
    block = `Prior attempts on this work item:\n(${elidedCount} earlier attempt${elidedCount === 1 ? '' : 's'} elided)\n${rendered.join('\n')}`;
  }

  const progression = renderProgression(verifyOutputPrev, verifyOutput);
  if (progression) block += `\n\n${progression}`;

  return block;
}

function isFactoryFeatureEnabled(project_id, flagKey) {
  try {
    const project = factoryHealth.getProject(project_id);
    const raw = project && (project.config_json || project.config);
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    return Boolean(cfg && cfg.feature_flags && cfg.feature_flags[flagKey]);
  } catch {
    return false;
  }
}

async function maybeShipNoop({ project_id, batch_id, work_item_id }) {
  const attemptHistory = require('../db/factory-attempt-history');
  const latest = attemptHistory.getLatestForBatch(batch_id);
  if (!latest) return { shipped_as_noop: false };

  const reason = latest.zero_diff_reason;
  const conf = latest.classifier_conf == null ? 0 : latest.classifier_conf;

  if (reason === 'already_in_place' && conf >= 0.8) {
    if (!isFactoryFeatureEnabled(project_id, 'auto_ship_noop_enabled')) {
      return { shipped_as_noop: false, reason: 'flag_off' };
    }
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.EXECUTE,
      action: 'shipped_as_noop',
      reasoning: 'Codex reported the change was already in place; skipping VERIFY per auto-route policy.',
      outcome: {
        work_item_id,
        classifier_source: latest.classifier_source,
        classifier_conf: conf,
        stdout_tail_preview: String(latest.stdout_tail || '').slice(0, 400),
      },
      confidence: 1,
    });
    return { shipped_as_noop: true };
  }

  if ((reason === 'blocked' || reason === 'precondition_missing') && conf >= 0.8) {
    if (!isFactoryFeatureEnabled(project_id, 'auto_ship_noop_enabled')) {
      return { shipped_as_noop: false, reason: 'flag_off' };
    }
    const paused_reason = reason === 'blocked' ? 'blocked_by_codex' : 'precondition_missing';
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.EXECUTE,
      action: 'paused_at_gate',
      reasoning: `Codex reported ${reason}; pausing EXECUTE gate for operator review.`,
      outcome: {
        work_item_id,
        paused_stage: 'EXECUTE',
        paused_reason,
        classifier_conf: conf,
        stdout_tail_preview: String(latest.stdout_tail || '').slice(0, 400),
      },
      confidence: 1,
    });
    return { shipped_as_noop: false, paused: true, paused_reason };
  }

  return { shipped_as_noop: false };
}

function buildVerifyFixPrompt({
  planPath, planTitle, branch, verifyCommand, verifyOutput,
  priorAttempts, verifyOutputPrev,
}) {
  const tail = stripAnsi(String(verifyOutput || '')).slice(-VERIFY_FIX_PROMPT_TAIL_BUDGET);
  const priorBlock = buildPriorAttemptsBlock(priorAttempts, verifyOutputPrev, verifyOutput);
  const lines = [
    `Plan: ${planTitle || '(unknown)'}`,
    planPath ? `Plan path: ${planPath}` : null,
    `Factory branch: ${branch}`,
    `Verify command: ${verifyCommand}`,
    '',
    'The plan tasks for this batch were implemented, but the verify step failed. Read the error output below and make the minimum changes needed to turn the failures green. Common issues: a test that references a module the plan forgot to update, an alignment/invariant test that needs the new entry registered, a stale snapshot, a missing import, a type mismatch, or a lint rule violation.',
    '',
    priorBlock,
    priorBlock ? '' : null,
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
  ].filter((x) => x !== null && x !== undefined);
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

  // Fix 6: short-circuit when the worktree directory does not exist on disk.
  // Without this guard, smart_submit_task fails with INTERNAL_ERROR
  // ("working_directory does not exist") which the retry loop misclassifies
  // as a generic "no_task_id" failure. By detecting cwd_missing here we
  // surface a precise reason and avoid wasting a retry attempt against a
  // path that won't reappear by retrying.
  //
  // Dark-factory recovery: before giving up, attempt to recreate the
  // worktree from the existing branch (git objects still hold the commits
  // even when the worktree dir was deleted). If the branch also vanished,
  // the work is unrecoverable — auto-reject so the loop moves on instead
  // of pausing for operator intervention.
  if (worktreeRecord?.worktreePath && !fs.existsSync(worktreeRecord.worktreePath)) {
    const projectForRecovery = factoryHealth.getProject(project_id);
    const repoPath = projectForRecovery?.path;
    const branch = worktreeRecord.branch;
    const worktreePath = worktreeRecord.worktreePath;

    // Probe whether the branch still exists locally.
    let branchExists = false;
    let recoveredFromOrigin = false;
    if (repoPath && branch) {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('git', ['show-ref', '--verify', `refs/heads/${branch}`], {
          cwd: repoPath,
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5000,
        });
        branchExists = true;
      } catch (_probeErr) { void _probeErr; }
    }

    // Fallback: local branch gone, but origin may still have the commits
    // (e.g. verify pushed them and a later cleanup pass deleted the local
    // branch). Recreate the local branch from origin/<branch> before we
    // give up as "worktree_lost".
    if (!branchExists && repoPath && branch) {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('git', ['show-ref', '--verify', `refs/remotes/origin/${branch}`], {
          cwd: repoPath,
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5000,
        });
        execFileSync('git', ['branch', branch, `origin/${branch}`], {
          cwd: repoPath,
          stdio: 'ignore',
          windowsHide: true,
          timeout: 10000,
        });
        branchExists = true;
        recoveredFromOrigin = true;
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'verify_retry_branch_recreated_from_origin',
          reasoning: `Local branch ${branch} was missing but origin had it. Recreated local branch from origin/${branch} to preserve pushed work.`,
          outcome: { attempt, branch, worktree_path: worktreePath },
          confidence: 1,
          batch_id,
        });
      } catch (_probeErr) { void _probeErr; }
    }

    if (branchExists) {
      try {
        const { execFileSync } = require('child_process');
        const pathMod = require('path');
        fs.mkdirSync(pathMod.dirname(worktreePath), { recursive: true });
        // Prune first — a stale entry in .git/worktrees may still claim
        // ownership even though the directory is gone.
        try { execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, windowsHide: true, timeout: 10000 }); } catch (_e) { void _e; }
        // `worktree add <path> <branch>` (no -b) attaches an existing branch.
        execFileSync('git', ['worktree', 'add', worktreePath, branch], {
          cwd: repoPath,
          windowsHide: true,
          timeout: 30000,
        });
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'verify_retry_worktree_recovered',
          reasoning: `Worktree directory vanished mid-verify; recovered by re-attaching branch ${branch} at ${worktreePath}. Proceeding with retry.`,
          outcome: { attempt, branch, worktree_path: worktreePath },
          confidence: 1,
          batch_id,
        });
        // Fall through to the normal submission path — the worktree is live again.
      } catch (recoverErr) {
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'verify_retry_worktree_recovery_failed',
          reasoning: `Worktree recovery attempt failed: ${recoverErr.message}. Returning cwd_missing for operator triage.`,
          outcome: { attempt, branch, worktree_path: worktreePath, error: recoverErr.message },
          confidence: 1,
          batch_id,
        });
        return {
          submitted: false,
          reason: 'cwd_missing',
          error: `worktree directory missing and recovery failed: ${recoverErr.message}`,
        };
      }
    } else {
      // Branch also gone — the work is unrecoverable. Auto-reject so the
      // loop moves on instead of pausing for operator.
      try {
        factoryIntake.updateWorkItem(workItem.id, {
          status: 'rejected',
          reject_reason: 'worktree_and_branch_lost_during_verify',
        });
      } catch (rejectErr) {
        logger.warn('verify-recovery: updateWorkItem failed', {
          project_id, work_item_id: workItem?.id, err: rejectErr.message,
        });
      }
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.VERIFY,
        action: 'auto_rejected_worktree_lost',
        reasoning: `Both worktree directory and branch ${branch} vanished mid-verify. Work is unrecoverable — auto-rejecting item so loop advances.`,
        outcome: {
          attempt,
          branch,
          worktree_path: worktreePath,
          work_item_id: workItem?.id ?? null,
          next_state: LOOP_STATES.IDLE,
        },
        confidence: 1,
        batch_id,
      });
      return {
        submitted: false,
        reason: 'worktree_lost',
        error: `worktree directory and branch ${branch} both missing — auto-rejected`,
        auto_rejected: true,
      };
    }
  }

  const project = factoryHealth.getProject(project_id);
  const planPath = workItem?.origin?.plan_path || null;
  const planTitle = workItem?.title || workItem?.origin?.title || null;

  const attemptHistory = require('../db/factory-attempt-history');
  const workItemIdStr = String((workItem && workItem.id) || '');
  const priorAttempts = workItemIdStr
    ? attemptHistory.listByWorkItem(workItemIdStr, { limit: 3 }).reverse()
    : [];
  const latest = priorAttempts[priorAttempts.length - 1];
  const verifyOutputPrev = latest && latest.verify_output_tail ? latest.verify_output_tail : null;

  if (latest && latest.id) {
    try {
      attemptHistory.updateVerifyOutputTail(
        latest.id,
        stripAnsi(String(verifyOutput || '')).slice(-VERIFY_FIX_PROMPT_TAIL_BUDGET)
      );
    } catch (e) {
      logger.warn('attempt_history_verify_tail_update_failed', { err: e.message });
    }
  }

  const prompt = buildVerifyFixPrompt({
    planPath, planTitle,
    branch: worktreeRecord.branch,
    verifyCommand, verifyOutput,
    priorAttempts, verifyOutputPrev,
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
    reasoning: `Auto-retry #${attempt}: submitting a fix task via the auto-router with the verify error as context.`,
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
    // Priority: factory config_json -> project_defaults (set via
    // set_project_defaults) -> hardcoded vitest fallback. Factory config
    // expresses explicit loop intent; project_defaults is the general
    // per-project config; the hardcoded string is last resort for repos
    // that have neither configured.
    let verifyCommand = project && project.config && project.config.verify_command;
    if (!verifyCommand && project && project.name) {
      try {
        const projectConfigCore = require('../db/project-config-core');
        const defaults = projectConfigCore.getProjectConfig(project.name);
        if (defaults && defaults.verify_command) {
          verifyCommand = defaults.verify_command;
        }
      } catch (_pccErr) {
        void _pccErr;
      }
    }
    if (!verifyCommand) {
      verifyCommand = 'cd server && npx vitest run';
    }

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

    // Auto-retry: if verify fails, submit a fix task via the auto-router with
    // the error output as context, then re-run verify. Bounded at
    // MAX_AUTO_VERIFY_RETRIES. If still failing after that, auto-reject
    // the work item so the loop can advance to the next item.
    const verifyReview = require('./verify-review');
    let review = null;
    // Reset the cascade counter when EXECUTE transitions into VERIFY for a
    // fresh batch. Persisting the counter across stages lets consecutive
    // missing_dep cycles within ONE verify stage add up, without leaking
    // into the next batch.
    try {
      const freshProject = factoryHealth.getProject(project_id);
      const freshCfg = freshProject?.config_json ? JSON.parse(freshProject.config_json) : {};
      if (freshCfg.dep_resolve_cycle_count) {
        freshCfg.dep_resolve_cycle_count = 0;
        factoryHealth.updateProject(project_id, { config_json: JSON.stringify(freshCfg) });
      }
    } catch (_e) { void _e; }
    let res = null;
    // Seed the retry counter from prior verify-retry tasks for this batch.
    // Without this, any re-entry to executeVerifyStage (stall-recovery,
    // VERIFY_FAIL resume, dispatcher re-entry) resets retryAttempt to 0 and
    // the loop cycles retry=1..3 again instead of emitting
    // auto_rejected_verify_fail. The retry tags persisted on task rows are
    // the cross-call source of truth.
    let retryAttempt = countPriorVerifyRetryTasksForBatch(batch_id);
    let submissionFailures = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Project-row pause gate, re-checked on every iteration. An operator's
        // pause_project must interrupt an in-flight verify-retry loop — not
        // wait for the current retry to finish before the next iteration can
        // submit another Codex task.
        if (isProjectStatusPaused(project_id)) {
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'verify_aborted_project_paused',
            reasoning: 'Project was paused mid-verify; aborting retry loop instead of submitting another fix task.',
            outcome: { retry_attempts: retryAttempt },
            confidence: 1,
            batch_id,
          });
          return {
            status: 'paused',
            reason: 'project_paused_mid_verify',
            pause_at_stage: 'VERIFY',
            branch: worktreeRecord.branch,
            worktree_path: worktreeRecord.worktreePath,
            retry_attempts: retryAttempt,
          };
        }
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

        // Verify-review classifier: on the FIRST failure only, classify the
        // failure as task_caused, baseline_broken, environment_failure, or
        // ambiguous. Baseline_broken / environment_failure short-circuit the
        // retry loop — the item is rejected, the project is paused, and an
        // event is emitted. Task_caused / ambiguous / classifier-throw all
        // fall through to the existing retry path.
        if (retryAttempt === 0 && !review) {
          try {
            const wi = instance?.work_item_id
              ? factoryIntake.getWorkItem(instance.work_item_id)
              : null;
            review = await verifyReview.reviewVerifyFailure({
              verifyOutput: res,
              workingDirectory: project?.path || process.cwd(),
              worktreeBranch: worktreeRecord.branch,
              mergeBase: worktreeRecord.base_branch || 'main',
              workItem: wi,
              project: project || { id: project_id, path: null },
            });
          } catch (err) {
            logger.warn('verify-review classifier failed; falling through to existing retry path', {
              project_id, err: err.message,
            });
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_reviewer_fail_open',
              reasoning: `Classifier threw: ${err.message}. Retrying as before.`,
              outcome: { work_item_id: instance?.work_item_id || null },
              confidence: 1,
              batch_id,
            });
            review = null;
          }

          // missing_dep branch: submit a Codex resolver task, await, re-verify.
          // Cap cascade at 3 per batch. On resolver failure, escalate once; on
          // escalation pause, treat as baseline_broken and pause the project.
          if (review && review.classification === 'missing_dep') {
            const depResolver = require('./dep-resolver/index');
            const escalationHelper = require('./dep-resolver/escalation');
            const registry = require('./dep-resolver/registry');
            const adapter = registry.getAdapter(review.manager);
            if (!adapter) {
              // Manager disappeared between classify and resolve; fall through
              // as ambiguous so the normal retry path can try.
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'dep_resolver_no_adapter',
                reasoning: `Missing dep detected (manager=${review.manager}) but no adapter is registered; falling through to retry.`,
                outcome: { work_item_id: instance?.work_item_id || null, manager: review.manager },
                confidence: 1,
                batch_id,
              });
            } else {
            const gatedTrust = project.trust_level === 'supervised' || project.trust_level === 'guided';
            if (gatedTrust) {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'dep_resolver_pending_approval',
                reasoning: `Missing dep ${review.package_name} (${review.manager}) detected. Trust level ${project.trust_level} requires operator approval before installing.`,
                outcome: {
                  work_item_id: instance?.work_item_id || null,
                  manager: review.manager,
                  package: review.package_name,
                  proposed_action: 'dep_resolve',
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'paused',
                reason: 'dep_resolver_pending_approval',
                next_state: LOOP_STATES.PAUSED,
                paused_at_stage: LOOP_STATES.VERIFY,
              };
            }
              // Check cascade cap + kill switch.
              const currentProject = factoryHealth.getProject(project_id);
              const cfg = currentProject?.config_json ? JSON.parse(currentProject.config_json) : {};
              const enabled = cfg?.dep_resolver?.enabled !== false; // default on
              const cap = Number.isFinite(cfg?.dep_resolver?.cascade_cap) ? cfg.dep_resolver.cascade_cap : 3;
              const count = Number.isFinite(cfg?.dep_resolve_cycle_count) ? cfg.dep_resolve_cycle_count : 0;

              if (!enabled) {
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'dep_resolver_disabled',
                  reasoning: 'Missing dep detected but dep_resolver.enabled=false; falling through to existing retry.',
                  outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name },
                  confidence: 1,
                  batch_id,
                });
              } else if (count >= cap) {
                // Cascade exhausted — pause as baseline_broken.
                factoryIntake.updateWorkItem(instance.work_item_id, {
                  status: 'rejected',
                  reject_reason: `dep_cascade_exhausted: ${count} resolutions attempted, next missing dep is ${review.package_name}`,
                });
                cfg.baseline_broken_since = new Date().toISOString();
                cfg.baseline_broken_reason = 'dep_cascade_exhausted';
                cfg.baseline_broken_evidence = { last_package: review.package_name, cycle_count: count };
                cfg.baseline_broken_probe_attempts = 0;
                cfg.baseline_broken_tick_count = 0;
                factoryHealth.updateProject(project_id, { status: 'paused', config_json: JSON.stringify(cfg) });
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'dep_resolver_cascade_exhausted',
                  reasoning: `Reached ${count} dep resolutions this batch; pausing project.`,
                  outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, cycle_count: count },
                  confidence: 1,
                  batch_id,
                });
                return { status: 'rejected', reason: 'dep_cascade_exhausted' };
              } else {
                // Run the resolver.
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'dep_resolver_detected',
                  reasoning: `Missing dep detected: ${review.package_name} (manager=${review.manager})`,
                  outcome: { work_item_id: instance?.work_item_id || null, manager: review.manager, package: review.package_name, module: review.module_name },
                  confidence: 1,
                  batch_id,
                });

                let resolveResult = await depResolver.resolve({
                  classification: review,
                  project,
                  worktree: worktreeRecord,
                  workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                  instance,
                  adapter,
                  options: {},
                });

                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: resolveResult.outcome === 'resolved' ? 'dep_resolver_task_completed' : 'dep_resolver_validation_failed',
                  reasoning: `Resolver outcome: ${resolveResult.outcome} (${resolveResult.reason || 'ok'})`,
                  outcome: { work_item_id: instance?.work_item_id || null, ...resolveResult },
                  confidence: 1,
                  batch_id,
                });

                // On resolver failure, escalate once.
                if (resolveResult.outcome !== 'resolved') {
                  const escalationResult = await escalationHelper.escalate({
                    project,
                    workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                    originalError: review.error_output || '',
                    resolverError: resolveResult.resolverError || resolveResult.reason || '',
                    resolverPrompt: adapter.buildResolverPrompt({
                      package_name: review.package_name,
                      project,
                      worktree: worktreeRecord,
                      workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                      error_output: review.error_output || '',
                    }),
                    manifestExcerpt: '',
                  });
                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'dep_resolver_escalated',
                    reasoning: `Escalation verdict: ${escalationResult.action} (${escalationResult.reason})`,
                    outcome: { work_item_id: instance?.work_item_id || null, ...escalationResult },
                    confidence: 1,
                    batch_id,
                  });
                  if (escalationResult.action === 'retry') {
                    resolveResult = await depResolver.resolve({
                      classification: review,
                      project,
                      worktree: worktreeRecord,
                      workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                      instance,
                      adapter,
                      options: { revisedPrompt: escalationResult.revisedPrompt },
                    });
                    safeLogDecision({
                      project_id,
                      stage: LOOP_STATES.VERIFY,
                      action: 'dep_resolver_escalation_retry',
                      reasoning: `Retry resolver outcome: ${resolveResult.outcome} (${resolveResult.reason || 'ok'})`,
                      outcome: { work_item_id: instance?.work_item_id || null, ...resolveResult },
                      confidence: 1,
                      batch_id,
                    });
                  }
                  // If still not resolved (either escalation pause or retry failed), pause project.
                  if (resolveResult.outcome !== 'resolved') {
                    factoryIntake.updateWorkItem(instance.work_item_id, {
                      status: 'rejected',
                      reject_reason: `dep_resolver_unresolvable: ${escalationResult.reason || resolveResult.reason || 'unknown'}`,
                    });
                    cfg.baseline_broken_since = new Date().toISOString();
                    cfg.baseline_broken_reason = 'dep_resolver_unresolvable';
                    cfg.baseline_broken_evidence = { package: review.package_name, escalation_reason: escalationResult.reason, resolver_reason: resolveResult.reason };
                    cfg.baseline_broken_probe_attempts = 0;
                    cfg.baseline_broken_tick_count = 0;
                    factoryHealth.updateProject(project_id, { status: 'paused', config_json: JSON.stringify(cfg) });
                    safeLogDecision({
                      project_id,
                      stage: LOOP_STATES.VERIFY,
                      action: 'dep_resolver_escalation_pause',
                      reasoning: `Pausing project: ${escalationResult.reason || resolveResult.reason}`,
                      outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, escalation: escalationResult, resolver: resolveResult },
                      confidence: 1,
                      batch_id,
                    });
                    return { status: 'rejected', reason: 'dep_resolver_unresolvable' };
                  }
                }

                // Success path: bump counter, mark for re-verify. Continue
                // the outer verify while-loop.
                cfg.dep_resolve_cycle_count = count + 1;
                if (!Array.isArray(cfg.dep_resolve_history)) cfg.dep_resolve_history = [];
                cfg.dep_resolve_history.push({
                  ts: new Date().toISOString(),
                  batch_id,
                  package: review.package_name,
                  manager: review.manager,
                  outcome: 'resolved',
                  task_id: resolveResult.taskId || null,
                });
                // Cap history at 20 entries
                if (cfg.dep_resolve_history.length > 20) cfg.dep_resolve_history = cfg.dep_resolve_history.slice(-20);
                factoryHealth.updateProject(project_id, { config_json: JSON.stringify(cfg) });

                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'dep_resolver_reverify_passed',
                  reasoning: `Dep ${review.package_name} resolved; re-running verify (cycle ${count + 1}/${cap}).`,
                  outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, cycle_count: count + 1 },
                  confidence: 1,
                  batch_id,
                });

                // Clear `review` so the next loop iteration re-enters the
                // classifier on the fresh verify output.
                review = null;
                continue;
              }
            }
          }

          if (review && (review.classification === 'baseline_broken'
                         || review.classification === 'environment_failure')) {
            if (instance?.work_item_id) {
              try {
                factoryIntake.updateWorkItem(instance.work_item_id, {
                  status: 'rejected',
                  reject_reason: review.suggestedRejectReason,
                });
              } catch (_e) { void _e; }
            }

            try {
              const currentProject = factoryHealth.getProject(project_id);
              const cfg = currentProject?.config_json ? JSON.parse(currentProject.config_json) : {};
              cfg.baseline_broken_since = new Date().toISOString();
              cfg.baseline_broken_reason = review.suggestedRejectReason;
              cfg.baseline_broken_evidence = {
                failing_tests: review.failingTests,
                exit_code: res.exitCode,
                environment_signals: review.environmentSignals,
                llm_critique: review.llmCritique,
              };
              cfg.baseline_broken_probe_attempts = 0;
              cfg.baseline_broken_tick_count = 0;
              factoryHealth.updateProject(project_id, {
                status: 'paused',
                config_json: JSON.stringify(cfg),
              });
            } catch (_e) { void _e; }

            try {
              if (review.classification === 'baseline_broken') {
                eventBus.emitFactoryProjectBaselineBroken({
                  project_id,
                  reason: review.suggestedRejectReason,
                  failing_tests: review.failingTests,
                  evidence: { exit_code: res.exitCode, llm_critique: review.llmCritique },
                });
              } else {
                eventBus.emitFactoryProjectEnvironmentFailure({
                  project_id,
                  signals: review.environmentSignals,
                  exit_code: res.exitCode,
                });
              }
            } catch (_e) { void _e; }

            const action = review.classification === 'baseline_broken'
              ? 'verify_reviewed_baseline_broken'
              : 'verify_reviewed_environment_failure';
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action,
              reasoning: review.classification === 'baseline_broken'
                ? `Baseline broken — ${review.failingTests.length} failing test(s) unrelated to this diff. ${review.llmCritique || ''}`
                : `Environment failure — signals: ${review.environmentSignals.join(', ')}.`,
              outcome: {
                work_item_id: instance?.work_item_id || null,
                classification: review.classification,
                confidence: review.confidence,
                modifiedFiles: review.modifiedFiles,
                failingTests: review.failingTests,
                intersection: review.intersection,
                environmentSignals: review.environmentSignals,
                llmVerdict: review.llmVerdict,
              },
              confidence: 1,
              batch_id,
            });

            return { status: 'rejected', reason: review.classification };
          }

          const reviewedAction = review && review.classification === 'task_caused'
            ? 'verify_reviewed_task_caused'
            : 'verify_reviewed_ambiguous_retrying';
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: reviewedAction,
            reasoning: review
              ? `Classifier says ${review.classification} (confidence=${review.confidence}); existing retry path will fire.`
              : 'Classifier unavailable; retrying as before.',
            outcome: review ? {
              work_item_id: instance?.work_item_id || null,
              classification: review.classification,
              confidence: review.confidence,
              modifiedFiles: review.modifiedFiles,
              failingTests: review.failingTests,
              intersection: review.intersection,
            } : { work_item_id: instance?.work_item_id || null, classifier: 'unavailable' },
            confidence: 1,
            batch_id,
          });
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
            outcome: {
              work_item_id: instance?.work_item_id || null,
              instance_id: instance?.id || null,
              retry_attempts: retryAttempt,
            },
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

        // Fix 4: classify the retry result.
        // (a) submission did not happen — distinguish fatal vs transient.
        if (retryResult.submitted === false) {
          // Dark-factory recovery: submitVerifyFixTask already auto-rejected
          // the item (worktree + branch both lost). Advance the loop past
          // VERIFY so the factory picks the next item.
          if (retryResult.auto_rejected) {
            return {
              status: 'passed',
              reason: retryResult.reason || 'auto_rejected_during_verify',
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              retry_attempts: retryAttempt,
            };
          }
          if (FATAL_SUBMISSION_REASONS.has(retryResult.reason)) {
            // Fatal: cwd missing, etc. Pause immediately — retrying won't help.
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'worktree_verify_failed',
              reasoning: `Worktree verify FAILED: retry submission cannot proceed (${retryResult.reason}). Pausing at VERIFY_FAIL.`,
              outcome: {
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                duration_ms: res.durationMs,
                verify_command: verifyCommand,
                output_preview: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
                submission_reason: retryResult.reason,
              },
              confidence: 1,
              batch_id,
            });
            return {
              status: 'failed',
              reason: `verify_retry_${retryResult.reason}`,
              pause_at_stage: 'VERIFY_FAIL',
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              verify_output: String(res.output || '').slice(-1500),
              retry_attempts: retryAttempt,
            };
          }
          // Transient submission failure (no task_id, submit_threw, etc.).
          // Don't consume a retry attempt — the test never ran. Re-attempt
          // the submission, capped at MAX_SUBMISSION_FAILURES so a persistent
          // provider outage doesn't loop forever.
          submissionFailures += 1;
          retryAttempt -= 1;
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: 'verify_retry_submission_failed',
            reasoning: `Auto-retry submission failed (${retryResult.reason || 'unknown'}); not consuming a retry attempt (${submissionFailures}/${MAX_SUBMISSION_FAILURES}).`,
            outcome: {
              attempt: retryAttempt + 1,
              submission_failures: submissionFailures,
              max_submission_failures: MAX_SUBMISSION_FAILURES,
              reason: retryResult.reason || null,
              error: retryResult.error || null,
              branch: worktreeRecord.branch,
            },
            confidence: 1,
            batch_id,
          });
          if (submissionFailures >= MAX_SUBMISSION_FAILURES) {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'worktree_verify_failed',
              reasoning: `Worktree verify FAILED: ${submissionFailures} consecutive retry-submission errors; pausing at VERIFY_FAIL for operator triage.`,
              outcome: {
                branch: worktreeRecord.branch,
                worktree_path: worktreeRecord.worktreePath,
                duration_ms: res.durationMs,
                verify_command: verifyCommand,
                output_preview: String(res.output || '').slice(-1500),
                retry_attempts: retryAttempt,
                submission_failures: submissionFailures,
              },
              confidence: 1,
              batch_id,
            });
            return {
              status: 'failed',
              reason: 'worktree_verify_failed_submission_failures',
              pause_at_stage: 'VERIFY_FAIL',
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              verify_output: String(res.output || '').slice(-1500),
              retry_attempts: retryAttempt,
              submission_failures: submissionFailures,
            };
          }
          continue;
        }

        // (b) submission OK but task did not complete — preserve existing
        // pause behavior (provider crashed, await timed out, etc.).
        if (retryResult.awaitStatus !== 'completed') {
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
        // (c) submission OK + task completed — reset transient counter and re-verify.
        submissionFailures = 0;
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
  if (project.status !== 'running') {
    factoryHealth.updateProject(project.id, { status: 'running' });
  }

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

  if (isProjectStatusPaused(project.id)) {
    return {
      project_id: project.id,
      instance_id: instance.id,
      previous_state: previousState,
      new_state: currentState,
      paused_at_stage: pausedAtStage,
      stage_result: null,
      reason: 'project_paused',
    };
  }

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
      // Nothing to work on — terminate cleanly instead of spinning in place.
      // Without this, auto-advance retriggers EXECUTE every 100ms because
      // executePlanFileStage returns null with a null targetItem and
      // executeNextState defaults back to EXECUTE. The next tick will
      // re-enter SENSE and pick up new work if any exists.
      if (!targetItem) {
        const lastActionAt = instance.last_action_at || null;
        terminateInstanceAndSync(instance.id);
        recordFactoryIdleIfExhausted(project.id, {
          last_action_at: lastActionAt,
          reason: 'no_work_item_selected',
        });
        return {
          project_id: project.id,
          instance_id: instance.id,
          previous_state: previousState,
          new_state: LOOP_STATES.IDLE,
          paused_at_stage: null,
          stage_result: null,
          reason: 'no_work_item_selected',
        };
      }
      if (!targetItem.origin?.plan_path || !fs.existsSync(targetItem.origin.plan_path)) {
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
          // If the stage asked to go to IDLE (e.g. cannot_generate_plan
          // auto-rejected the item), terminate and exit instead of pausing.
          if (generated.next_state === LOOP_STATES.IDLE) {
            const lastActionAt = instance.last_action_at || null;
            terminateInstanceAndSync(instance.id);
            recordFactoryIdleIfExhausted(project.id, {
              last_action_at: lastActionAt,
              reason: generated.reason || 'stop_execution_idle',
            });
            return {
              project_id: project.id,
              instance_id: instance.id,
              previous_state: previousState,
              new_state: LOOP_STATES.IDLE,
              paused_at_stage: null,
              stage_result: generated.stage_result || null,
              reason: generated.reason || 'stop_execution_idle',
            };
          }
          if (generated.next_state === LOOP_STATES.PRIORITIZE) {
            const moveToPrioritize = tryMoveInstanceToStage(instance, LOOP_STATES.PRIORITIZE, {
              work_item_id: generated.work_item?.id ?? instance.work_item_id,
            });
            instance = moveToPrioritize.instance;
            if (moveToPrioritize.blocked) {
              transitionReason = 'stage_occupied';
            }
            break;
          }
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
        const lastActionAt = instance.last_action_at || null;
        terminateInstanceAndSync(instance.id);
        recordFactoryIdleIfExhausted(project.id, {
          last_action_at: lastActionAt,
          reason: transitionReason || 'execute_completed_idle',
        });
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

      // Defense-in-depth: any stage that asks to PAUSE must actually pause
      // the instance, even if the stage forgot to set stop_execution: true.
      // Without this, a bare `next_state: PAUSED` silently falls through
      // the default break, the instance stays in EXECUTE, and the next
      // tick re-runs the same failure (seen with execution_failed_no_tasks
      // at 14:21 today before the companion handler fix landed).
      if (executeNextState === LOOP_STATES.PAUSED) {
        instance = updateInstanceAndSync(instance.id, {
          paused_at_stage: executeStage?.paused_at_stage || LOOP_STATES.EXECUTE,
          last_action_at: nowIso(),
        });
        break;
      }

      if (executeNextState === LOOP_STATES.VERIFY) {
        const executeBatchId = executeStage?.work_item?.batch_id || instance.batch_id;
        const shipResult = await maybeShipNoop({
          project_id: project.id,
          batch_id: executeBatchId,
          work_item_id: instance && instance.work_item_id,
        });
        if (shipResult.shipped_as_noop) {
          if (instance.work_item_id) {
            const shippedWorkItem = factoryIntake.updateWorkItem(instance.work_item_id, { status: 'shipped' });
            rememberSelectedWorkItem(instance.id, shippedWorkItem);
            factoryIntake.releaseClaimForInstance(instance.id);
          }
          const moveToLearn = tryMoveInstanceToStage(instance, LOOP_STATES.LEARN, {
            batch_id: executeBatchId,
            work_item_id: transitionWorkItem?.id ?? instance.work_item_id,
          });
          instance = moveToLearn.instance;
          transitionReason = moveToLearn.blocked ? 'stage_occupied' : 'shipped_as_noop';
          break;
        }
        if (shipResult.paused) {
          instance = updateInstanceAndSync(instance.id, {
            paused_at_stage: LOOP_STATES.EXECUTE,
            last_action_at: nowIso(),
          });
          transitionReason = shipResult.paused_reason || 'paused_at_gate';
          break;
        }
        const moveToVerify = tryMoveInstanceToStage(instance, LOOP_STATES.VERIFY, {
          batch_id: executeBatchId,
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
        const lastActionAt = instance.last_action_at || null;
        terminateInstanceAndSync(instance.id);
        recordFactoryIdleIfExhausted(project.id, {
          last_action_at: lastActionAt,
          reason: 'learn_completed',
        });
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

  const transitionBatchId = getDecisionBatchId(project, transitionWorkItem, null, instance);
  if (pausedAtStage && newState === LOOP_STATES.EXECUTE && previousState !== LOOP_STATES.EXECUTE) {
    logTransitionDecision({
      project,
      currentState: previousState,
      nextState: LOOP_STATES.PAUSED,
      pausedAtStage,
      reason: transitionReason,
      workItem: transitionWorkItem,
      batchId: transitionBatchId,
    });
    logTransitionDecision({
      project,
      currentState: previousState,
      nextState: newState,
      pausedAtStage: null,
      reason: transitionReason,
      workItem: transitionWorkItem,
      batchId: transitionBatchId,
    });
  } else {
    logTransitionDecision({
      project,
      currentState: previousState,
      nextState: pausedAtStage ? LOOP_STATES.PAUSED : newState,
      pausedAtStage,
      reason: transitionReason,
      workItem: transitionWorkItem,
      batchId: transitionBatchId,
    });
  }

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
      // instance is neither terminated (IDLE) nor paused at a gate AND the
      // project row isn't paused, enqueue the next advance. The 100ms delay
      // prevents tight synchronous loops on stages that complete instantly
      // (SENSE, PRIORITIZE). The project-row check stops the chain the moment
      // pause_project lands, without waiting for the current stage to finish.
      if (
        autoAdvance
        && result.new_state !== LOOP_STATES.IDLE
        && !result.paused_at_stage
        && !isProjectStatusPaused(project.id)
      ) {
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
      // is still active (not terminated, not paused at a gate, and project
      // row isn't paused), retry after a cooldown. Transient failures (SSH
      // timeout during remote verify, temporary network blip) shouldn't kill
      // the entire chain. The 30s delay prevents tight retry loops on
      // persistent failures. The project-row pause check keeps this branch
      // from fighting an operator's pause_project call.
      if (
        autoAdvance
        && latestState
        && latestState !== LOOP_STATES.IDLE
        && !latestPaused
        && !isProjectStatusPaused(project.id)
      ) {
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

function completeVerifyRetry(instance_id, reasoning, invalidStateMessage, matcher) {
  const { project } = getLoopContextOrThrow(instance_id);
  const instance = getInstanceOrThrow(instance_id);
  if (!matcher(instance)) {
    throw new Error(invalidStateMessage);
  }

  const previousPausedAtStage = getPausedAtStage(instance) || null;
  const updated = updateInstanceAndSync(instance.id, {
    paused_at_stage: null,
    last_action_at: nowIso(),
  });

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.VERIFY,
    actor: 'human',
    action: 'retry_verify_requested',
    reasoning,
    outcome: {
      previous_paused_at_stage: previousPausedAtStage,
      new_state: getCurrentLoopState(updated),
    },
    confidence: 1,
    batch_id: updated.batch_id || null,
  });

  logger.info('Factory VERIFY retry requested', {
    project_id: project.id,
    instance_id: updated.id,
    previous_paused_at_stage: previousPausedAtStage,
    state: getCurrentLoopState(updated),
  });

  return {
    project_id: project.id,
    instance_id: updated.id,
    state: getCurrentLoopState(updated),
    message: 'VERIFY retry requested; advance the loop to re-run remote verify',
  };
}

function retryVerify(instance_id) {
  return completeVerifyRetry(
    instance_id,
    'Operator triggered VERIFY retry',
    'Loop is not in VERIFY or paused at VERIFY/VERIFY_FAIL',
    (instance) => {
      const pausedAtStage = getPausedAtStage(instance);
      if (pausedAtStage) {
        return pausedAtStage === 'VERIFY_FAIL' || pausedAtStage === 'VERIFY';
      }
      return getCurrentLoopState(instance) === LOOP_STATES.VERIFY;
    },
  );
}

function retryVerifyForProject(project_id) {
  return retryVerify(getLoopInstanceForProjectOrThrow(project_id).id);
}

function retryVerifyFromFailure(instance_id) {
  return completeVerifyRetry(
    instance_id,
    'Operator triggered VERIFY retry from VERIFY_FAIL',
    'Loop is not paused at VERIFY_FAIL',
    (instance) => getPausedAtStage(instance) === 'VERIFY_FAIL',
  );
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

/**
 * @deprecated Use startup-reconciler.reconcileFactoryProjectsOnStartup().
 */
function resumeAutoAdvanceOnStartup(options) {
  const { reconcileFactoryProjectsOnStartup } = require('./startup-reconciler');
  return reconcileFactoryProjectsOnStartup(options);
}

module.exports = {
  StageOccupiedError,
  startLoop,
  startLoopForProject,
  startLoopAutoAdvance,
  startLoopAutoAdvanceForProject,
  resumeAutoAdvanceOnStartup,
  executeNonPlanFileStage,
  executeVerifyStage,
  advanceLoop,
  advanceLoopForProject,
  advanceLoopAsync,
  advanceLoopAsyncForProject,
  runAdvanceLoop,
  cancelLoopAdvanceJob,
  cancelLoopAdvanceJobForProject,
  approveGate,
  approveGateForProject,
  retryVerify,
  retryVerifyForProject,
  retryVerifyFromFailure,
  retryVerifyFromFailureForProject,
  rejectGate,
  rejectGateForProject,
  terminateInstanceAndSync,
  syncLegacyProjectLoopState,
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
  buildAutoGeneratedPlanPrompt,
  buildVerifyFixPrompt,
  VERIFY_FIX_PROMPT_TAIL_BUDGET,
  isProjectStatusPaused,
  countPriorVerifyRetryTasksForBatch,
  // Pure helpers (Fix 2 — fallback quarantine if upstream's empty-branch
  // resolver in maybeShipWorkItemAfterLearn ever fails open).
  isEmptyBranchMergeError,
  countPriorEmptyMergeFailuresForWorkItem,
  shouldQuarantineForEmptyMerges,
  // Test hooks
  setWorktreeRunnerForTests,
  __testing__: {
    VERIFY_FIX_PROMPT_PRIOR_BUDGET,
    buildPriorAttemptsBlock,
    renderProgression,
    maybeShipNoop,
    isFactoryFeatureEnabled,
  },
  _internalForTests: {
    claimNextWorkItemForInstance,
    healAlreadyShippedWorkItem,
    recordFactoryIdleIfExhausted,
    clearFactoryIdleForPendingWork,
    awaitTaskToStructuredResult,
    lintAutoGeneratedPlan,
    parseAutoGeneratedPlanTasks,
    scoreAutoGeneratedPlanDescriptions,
    scoreAutoGeneratedTaskDescription,
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
