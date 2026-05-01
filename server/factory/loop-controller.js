'use strict';

const { randomUUID } = require('crypto');
const childProcess = require('child_process');
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
const { findHeavyLocalValidationCommand } = require('../utils/heavy-validation-guard');
const { logDecision } = require('./decision-log');
const factoryNotifications = require('./notifications');
const branchFreshness = require('./branch-freshness');
const { createPlanFileIntake } = require('./plan-file-intake');
const { createPlanReviewer, selectReviewers } = require('./plan-reviewer');
const { createShippedDetector } = require('./shipped-detector');
const { createWorktreeRunner, detectDefaultBranch } = require('./worktree-runner');
const { extractExplicitVerifyCommand, normalizeVerifyCommand } = require('./plan-parser');
const { buildProviderLaneTaskMetadata } = require('./provider-lane-policy');
const { createWorktreeManager } = require('../plugins/version-control/worktree-manager');
const eventBus = require('../event-bus');
const baselineRequeue = require('./baseline-requeue');
const logger = require('../logger').child({ component: 'loop-controller' });

const PLAN_GENERATOR_LABEL = 'auto-router';
const DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES = 30;

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

const CLOSED_WORK_ITEM_STATUSES = new Set(['completed', 'shipped', 'shipped_stale', 'rejected', 'unactionable']);

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

function refreshFactoryDbHandles() {
  let db = null;
  try {
    db = database.getDbInstance();
  } catch {
    return null;
  }

  if (!db || typeof db.prepare !== 'function') {
    return null;
  }

  for (const store of [factoryHealth, factoryIntake, factoryDecisions, factoryLoopInstances, factoryWorktrees]) {
    if (store && typeof store.setDb === 'function') {
      store.setDb(db);
    }
  }
  return db;
}

function ensureFactoryDbHandles() {
  // Best-effort refresh from the global database facade. Tests and some startup
  // recovery paths may inject DB handles directly into the factory stores while
  // database.js is temporarily unavailable; the store methods below still know
  // whether their own handle is usable and will throw if it is not.
  return refreshFactoryDbHandles();
}
const PENDING_APPROVAL_SUCCESS_TASK_STATUSES = new Set(['completed', 'shipped']);
const PENDING_APPROVAL_FAILURE_TASK_STATUSES = new Set(['failed', 'cancelled']);
const LIVE_WORKTREE_OWNER_STATUSES = new Set(['queued', 'running', 'pending', 'retry_scheduled']);
const REUSABLE_WORKTREE_OWNER_STATUSES = new Set(['completed']);
const EXECUTION_TERMINAL_DECISION_ACTIONS = Object.freeze([
  'completed_execution',
  'execution_failed',
  'started_execution',
]);
const EXECUTE_DEFERRED_STALE_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 2000;
const STARVATION_THRESHOLD = 3;

function parseFactoryTimestamp(value) {
  if (!value) return null;
  const raw = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsedMsSince(value) {
  const parsed = parseFactoryTimestamp(value);
  return parsed == null ? null : Date.now() - parsed;
}

/**
 * Read the project's effective provider intent from its lane policy.
 * Returns the lowercase expected_provider when present, or null when no
 * lane policy is set. Used by the architect prompt builder and timeout
 * resolver to short-circuit prompt complexity / wall-clock budget for
 * known-small local models like qwen3-coder:30b on the `ollama` lane.
 */
function getEffectiveProjectProvider(project) {
  try {
    const cfg = project?.config && typeof project.config === 'object'
      ? project.config
      : (project?.config_json ? JSON.parse(project.config_json) : {});
    const policy = cfg?.provider_lane_policy || cfg?.provider_lane;
    const expected = policy && typeof policy === 'object' ? policy.expected_provider : null;
    return typeof expected === 'string' && expected.trim() ? expected.trim().toLowerCase() : null;
  } catch (_err) {
    void _err;
    return null;
  }
}

function getProjectConfigForPlanGate(project) {
  if (project?.config && typeof project.config === 'object') {
    return project.config;
  }
  try {
    return project?.config_json ? JSON.parse(project.config_json) : {};
  } catch (_err) {
    void _err;
    return {};
  }
}

// Phase G: small local models (qwen3-coder:30b) consistently exceed the
// 30min default architect timeout on harder work items because the prompt
// is heavy (codegraph guidance + 5-signal specificity rules + scope files
// + project context). Cap their plan-generation budget so the auto-recovery
// loop kicks in faster — burning 30min on a stalled architect cycle is
// strictly worse than failing fast and letting the cap-based reject move
// the queue forward.
const OLLAMA_PLAN_GENERATION_TIMEOUT_MINUTES = 10;

function resolvePlanGenerationTimeoutMinutes(project) {
  let configured = null;
  try {
    const cfg = project?.config_json ? JSON.parse(project.config_json) : {};
    configured = cfg.plan_generation_timeout_minutes
      ?? cfg.factory_plan_generation_timeout_minutes
      ?? null;
  } catch (_cfgErr) {
    void _cfgErr;
  }
  const numeric = Number(configured);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.min(Math.max(Math.ceil(numeric), 1), 120);
  }
  // Provider-aware default: small local models get a tighter cap.
  if (getEffectiveProjectProvider(project) === 'ollama') {
    return OLLAMA_PLAN_GENERATION_TIMEOUT_MINUTES;
  }
  return DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES;
}

function getTaskAgeMs(task) {
  if (!task) return null;
  return elapsedMsSince(task.started_at || task.created_at || task.createdAt);
}

function getWorktreeDirtyStatus(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { dirty: false, checked: false, reason: 'missing' };
  }
  try {
    const output = childProcess.execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { dirty: String(output || '').trim().length > 0, checked: true };
  } catch (error) {
    return {
      dirty: false,
      checked: false,
      reason: error && error.message ? error.message : 'git_status_failed',
    };
  }
}

class StageOccupiedError extends Error {
  constructor(project_id, stage) {
    super(`Stage ${stage} is already occupied for project ${project_id}`);
    this.name = 'StageOccupiedError';
    this.code = 'FACTORY_STAGE_OCCUPIED';
    this.project_id = project_id;
    this.stage = stage;
  }
}

class ExecuteDeferredPausedError extends Error {
  constructor(deferral) {
    super('Project paused before next EXECUTE plan task submission');
    this.name = 'ExecuteDeferredPausedError';
    this.code = 'FACTORY_EXECUTE_DEFERRED_PAUSED';
    Object.assign(this, deferral || {});
  }
}

const selectedWorkItemIds = new Map();
const loopAdvanceJobs = new Map();
const activeLoopAdvanceJobs = new Map();

// Codex Fallback Phase 2 — instances flagged at PRIORITIZE for failover
// routing. When `decideCodexFallbackAction` returns 'proceed_with_fallback'
// (breaker tripped + project policy=auto), the instance id is added here.
// The EXECUTE submit path (Task 7 — chain walker in smart-routing) reads
// this set and applies the 'codex-down-failover' routing template to the
// task metadata so the failover provider chain is used instead of Codex.
//
// In-memory state (approach B) was chosen over a DB column (approach A)
// because:
//   1. The marker only needs to live for the gap between PRIORITIZE and
//      EXECUTE submission within a single process — no schema migration
//      cost, no cross-restart durability concern (a restart would re-run
//      `decideCodexFallbackAction` at the next PRIORITIZE tick anyway).
//   2. It mirrors the existing `selectedWorkItemIds` Map pattern (see
//      above), so the lifecycle hooks already cover instance teardown.
//   3. Setting per-task `_routing_template` (approach C) directly from
//      PRIORITIZE would require plumbing through the plan-executor's
//      `submit` callback at submission time anyway; the in-memory marker
//      keeps PRIORITIZE oblivious to submission internals.
const instancesPendingFallbackRouting = new Set();

function markInstanceFallbackRouting(instance_id) {
  if (!instance_id) return;
  instancesPendingFallbackRouting.add(instance_id);
}

function consumeInstanceFallbackRouting(instance_id) {
  if (!instance_id) return false;
  const had = instancesPendingFallbackRouting.has(instance_id);
  instancesPendingFallbackRouting.delete(instance_id);
  return had;
}

function isInstanceFallbackRoutingPending(instance_id) {
  if (!instance_id) return false;
  return instancesPendingFallbackRouting.has(instance_id);
}

function clearInstanceFallbackRouting(instance_id) {
  if (!instance_id) return;
  instancesPendingFallbackRouting.delete(instance_id);
}

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
  ensureFactoryDbHandles();
  const project = factoryHealth.getProject(project_id);
  if (!project) {
    throw new Error(`Project not found: ${project_id}`);
  }
  return project;
}

function getInstanceOrThrow(instance_id) {
  ensureFactoryDbHandles();
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
    refreshFactoryDbHandles();
    const project = factoryHealth.getProject(project_id);
    return project?.status === 'paused';
  } catch {
    return false;
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
  const db = database.getDbInstance();
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
  const db = database.getDbInstance();
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
    },
    outcome: {
      ...getWorkItemDecisionContext(workItem),
      instance_id: instance?.id || null,
      deferral_decision_id: deferral.id,
      batch_id: batchId,
      next_state: LOOP_STATES.EXECUTE,
    },
    confidence: 1,
    batch_id: batchId,
  });
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

function isTerminalVerifyOutcome(stageResult) {
  return stageResult
    && (stageResult.status === 'rejected'
      || stageResult.status === 'unactionable'
      || stageResult.status === 'shipped');
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

function getConsecutiveEmptyCycles(project_id, fallbackProject = null) {
  const source = fallbackProject && Object.prototype.hasOwnProperty.call(fallbackProject, 'consecutive_empty_cycles')
    ? fallbackProject
    : factoryHealth.getProject(project_id);
  const value = Number(source?.consecutive_empty_cycles);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function setConsecutiveEmptyCycles(project_id, value) {
  const normalized = Math.max(0, Math.floor(Number(value) || 0));
  try {
    factoryHealth.updateProject(project_id, { consecutive_empty_cycles: normalized });
  } catch (err) {
    if (!/no such column:\s*consecutive_empty_cycles/i.test(String(err?.message || ''))) {
      throw err;
    }
    logger.debug('consecutive_empty_cycles column missing; skipping starvation counter update', {
      project_id,
    });
  }
  return normalized;
}

function incrementConsecutiveEmptyCycles(project) {
  return setConsecutiveEmptyCycles(
    project.id,
    getConsecutiveEmptyCycles(project.id, project) + 1,
  );
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
  // Drop any pending Codex-down failover marker so a future instance with
  // the same id (extremely unlikely — uuids — but cheap to be defensive)
  // doesn't inherit a stale "use the failover chain" hint.
  clearInstanceFallbackRouting(instance_id);

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

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function getStoredPlanGeneratorProvider(workItem) {
  const direct = normalizeOptionalString(workItem?.origin?.plan_generator_provider);
  if (direct) {
    return direct;
  }
  const parsedOrigin = parseJsonObject(workItem?.origin_json);
  return normalizeOptionalString(parsedOrigin?.plan_generator_provider);
}

function getStoredPlanGenerationTaskId(workItem) {
  const direct = normalizeOptionalString(workItem?.origin?.plan_generation_task_id);
  if (direct) {
    return direct;
  }
  const parsedOrigin = parseJsonObject(workItem?.origin_json);
  return normalizeOptionalString(parsedOrigin?.plan_generation_task_id);
}

function clearPlanGenerationWaitFields(origin = {}) {
  const next = { ...(origin && typeof origin === 'object' ? origin : {}) };
  delete next.plan_generation_task_id;
  delete next.plan_generation_status;
  delete next.plan_generation_wait_reason;
  delete next.plan_generation_retry_after;
  delete next.plan_generation_retry_count;
  delete next.plan_generation_last_error;
  delete next.plan_generation_updated_at;
  return next;
}

function getTaskMetadataObject(task) {
  const raw = task?.metadata;
  if (!raw) {
    return {};
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }
  return parseJsonObject(raw) || {};
}

function getPlanGenerationFileLockWait(task, message = '') {
  const metadata = getTaskMetadataObject(task);
  const wait = metadata.file_lock_wait;
  if (wait && typeof wait === 'object' && !Array.isArray(wait)) {
    return { ...wait, reason: 'file_lock_wait' };
  }

  const text = [
    message,
    typeof task?.error_output === 'string' ? task.error_output : '',
  ].filter(Boolean).join('\n');
  if (/Requeued:\s*file\s+'[^']+'\s+is being edited by task\b/i.test(text)) {
    return { reason: 'file_lock_wait' };
  }
  return null;
}

function getPlanGenerationRunningWait(task, message = '') {
  if (!isPlanGenerationTaskPending(task)) {
    return null;
  }

  const text = [
    message,
    typeof task?.error_output === 'string' ? task.error_output : '',
  ].filter(Boolean).join('\n');

  if (!text || /task\s+timed\s+out|timed\s+out|timeout|status:\s*(?:running|queued|pending|waiting)\b/i.test(text)) {
    return { reason: 'task_still_running' };
  }
  return null;
}

function getPlanGenerationWait(task, message = '') {
  return getPlanGenerationFileLockWait(task, message)
    || getPlanGenerationRunningWait(task, message);
}

function isPlanGenerationTaskPending(task) {
  return ['pending', 'queued', 'running', 'waiting'].includes(
    String(task?.status || '').toLowerCase()
  );
}

function getPlanGenerationTask(taskCore, taskId) {
  if (!taskCore || typeof taskCore.getTask !== 'function' || !taskId) {
    return null;
  }
  try {
    return taskCore.getTask(taskId) || null;
  } catch (error) {
    logger.debug('Unable to load plan-generation task state', {
      task_id: taskId,
      err: error.message,
    });
    return null;
  }
}

function resolveTaskReplacementChain(taskCore, taskId) {
  let currentTaskId = normalizeOptionalString(taskId);
  let currentTask = getPlanGenerationTask(taskCore, currentTaskId);
  const seen = new Set();

  while (currentTaskId && currentTask && !seen.has(currentTaskId)) {
    seen.add(currentTaskId);
    const replacementId = normalizeOptionalString(getTaskMetadataObject(currentTask).resubmitted_as);
    if (!replacementId || replacementId === currentTaskId) {
      break;
    }
    const replacementTask = getPlanGenerationTask(taskCore, replacementId);
    if (!replacementTask) {
      break;
    }
    currentTaskId = replacementId;
    currentTask = replacementTask;
  }

  return {
    taskId: currentTaskId,
    task: currentTask,
    replaced: currentTaskId !== taskId,
  };
}

function persistPlanGenerationTaskReplacement(workItem, generationTaskId) {
  if (!workItem?.id || !generationTaskId) {
    return workItem;
  }
  const origin = getWorkItemOriginObject(workItem);
  if (origin.plan_generation_task_id === generationTaskId) {
    return workItem;
  }
  try {
    return factoryIntake.updateWorkItem(workItem.id, {
      origin_json: {
        ...origin,
        plan_generation_task_id: generationTaskId,
        plan_generation_updated_at: nowIso(),
      },
    });
  } catch (error) {
    logger.warn('EXECUTE stage: failed to persist plan-generation replacement task id', {
      work_item_id: workItem.id,
      generation_task_id: generationTaskId,
      err: error.message,
    });
    return workItem;
  }
}

function buildPlanGenerationDeferredResult({
  project,
  instance,
  targetItem,
  planPath,
  generationTaskId,
  generationTask,
  wait,
  reason,
}) {
  const status = generationTask?.status || 'queued';
  const waitReason = normalizeOptionalString(wait?.reason) || 'task_still_running';
  const isFileLockWait = waitReason === 'file_lock_wait';
  const retryAfter = normalizeOptionalString(wait?.retry_after);
  const deferredOrigin = {
    ...getWorkItemOriginObject(targetItem),
    plan_path: planPath,
    plan_generation_task_id: generationTaskId,
    plan_generation_status: status,
    plan_generation_wait_reason: waitReason,
    ...(retryAfter ? { plan_generation_retry_after: retryAfter } : {}),
    plan_generation_updated_at: nowIso(),
  };
  let updatedWorkItem = targetItem;
  try {
    updatedWorkItem = factoryIntake.updateWorkItem(targetItem.id, {
      origin_json: deferredOrigin,
      status: targetItem.status || 'planned',
    });
    rememberSelectedWorkItem(instance.id, updatedWorkItem);
  } catch (error) {
    logger.warn('EXECUTE stage: failed to persist deferred plan-generation state', {
      project_id: project.id,
      work_item_id: targetItem.id,
      generation_task_id: generationTaskId,
      err: error.message,
    });
  }

  logger.info(isFileLockWait
    ? 'EXECUTE stage: deferred plan generation for file-lock contention'
    : 'EXECUTE stage: deferred plan generation while task remains active', {
    project_id: project.id,
    work_item_id: targetItem.id,
    plan_path: planPath,
    generation_task_id: generationTaskId,
    reason: waitReason,
    task_status: status,
    retry_after: retryAfter || null,
  });
  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.EXECUTE,
    action: isFileLockWait ? 'plan_generation_deferred_file_lock' : 'plan_generation_deferred_running',
    reasoning: reason || (isFileLockWait
      ? 'plan generation task is waiting on file-lock contention'
      : 'plan generation task is still active'),
    inputs: {
      ...getWorkItemDecisionContext(targetItem),
    },
    outcome: {
      reason: waitReason,
      plan_path: planPath,
      generation_task_id: generationTaskId,
      task_status: status,
      retry_after: retryAfter || null,
      ...getWorkItemDecisionContext(targetItem),
    },
    confidence: 1,
    batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
  });

  return {
    reason: isFileLockWait
      ? 'plan generation deferred for file-lock contention'
      : 'plan generation deferred while task remains active',
    work_item: updatedWorkItem,
    stop_execution: true,
    next_state: LOOP_STATES.PAUSED,
    paused_at_stage: LOOP_STATES.EXECUTE,
    stage_result: {
      status: 'deferred',
      reason: waitReason,
      plan_path: planPath,
      generation_task_id: generationTaskId,
      task_status: status,
      retry_after: retryAfter || null,
    },
  };
}

const PLAN_GENERATION_UNUSABLE_OUTPUT_RETRIES = 1;

function getPlanGenerationRetryCount(workItem) {
  const origin = getWorkItemOriginObject(workItem);
  const count = Number(origin.plan_generation_retry_count || 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function buildPlanGenerationRetryResult({
  project,
  instance,
  targetItem,
  planPath,
  generationTaskId,
  error,
}) {
  const priorRetries = getPlanGenerationRetryCount(targetItem);
  const retryCount = priorRetries + 1;
  const retryAfter = new Date(Date.now() + 60 * 1000).toISOString();
  const origin = getWorkItemOriginObject(targetItem);
  const retryOrigin = {
    ...origin,
    plan_path: planPath,
    plan_generation_status: 'retry_scheduled',
    plan_generation_retry_count: retryCount,
    plan_generation_retry_after: retryAfter,
    plan_generation_last_error: String(error?.message || error || 'unusable plan-generation output').slice(0, 1000),
    plan_generation_updated_at: nowIso(),
  };
  delete retryOrigin.plan_generation_task_id;
  delete retryOrigin.plan_generation_wait_reason;

  let updatedWorkItem = targetItem;
  try {
    updatedWorkItem = factoryIntake.updateWorkItem(targetItem.id, {
      origin_json: retryOrigin,
      status: targetItem.status || 'planned',
    });
    rememberSelectedWorkItem(instance.id, updatedWorkItem);
  } catch (persistErr) {
    logger.warn('EXECUTE stage: failed to persist plan-generation retry state', {
      project_id: project.id,
      work_item_id: targetItem.id,
      generation_task_id: generationTaskId,
      err: persistErr.message,
    });
  }

  logger.warn('EXECUTE stage: retrying unusable plan-generation output', {
    project_id: project.id,
    work_item_id: targetItem.id,
    generation_task_id: generationTaskId,
    retry_count: retryCount,
    retry_after: retryAfter,
    error: String(error?.message || error || '').slice(0, 500),
  });
  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.EXECUTE,
    action: 'plan_generation_retry_unusable_output',
    reasoning: error?.message || 'plan-generation task completed without executable plan markdown',
    inputs: {
      ...getWorkItemDecisionContext(targetItem),
    },
    outcome: {
      reason: 'unusable_plan_generation_output',
      plan_path: planPath,
      generation_task_id: generationTaskId,
      retry_count: retryCount,
      retry_after: retryAfter,
      ...getWorkItemDecisionContext(targetItem),
    },
    confidence: 0.8,
    batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
  });

  return {
    reason: 'plan generation retry scheduled after unusable output',
    work_item: updatedWorkItem,
    stop_execution: true,
    next_state: LOOP_STATES.IDLE,
    stage_result: {
      status: 'retry_scheduled',
      reason: 'unusable_plan_generation_output',
      plan_path: planPath,
      generation_task_id: generationTaskId,
      retry_count: retryCount,
      retry_after: retryAfter,
    },
  };
}

function getPlanGeneratorLabel(provider) {
  return normalizeOptionalString(provider) || PLAN_GENERATOR_LABEL;
}

function findExistingPlanTaskSubmission(taskCore, {
  projectName,
  workingDirectory,
  workItemId,
  planTaskNumber,
  batchId = null,
}) {
  if (!taskCore || typeof taskCore.listTasks !== 'function') {
    return null;
  }

  const normalizedWorkItemId = normalizeWorkItemId(workItemId);
  const normalizedPlanTaskNumber = Number.isInteger(Number(planTaskNumber))
    ? Number(planTaskNumber)
    : null;
  if (!normalizedWorkItemId || !normalizedPlanTaskNumber) {
    return null;
  }

  const workItemTag = `factory:work_item_id=${normalizedWorkItemId}`;
  const planTaskTag = `factory:plan_task_number=${normalizedPlanTaskNumber}`;
  const batchTag = normalizeOptionalString(batchId)
    ? `factory:batch_id=${batchId.trim()}`
    : null;

  let candidates = [];
  try {
    candidates = taskCore.listTasks({
      ...(projectName ? { project: projectName } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
      tag: workItemTag,
      statuses: ['pending', 'pending_approval', 'queued', 'running', 'completed'],
      orderBy: 'created_at',
      orderDir: 'desc',
      limit: 100,
      columns: ['id', 'status', 'tags', 'created_at'],
    });
  } catch (error) {
    logger.debug({
      err: error.message,
      work_item_id: normalizedWorkItemId,
      plan_task_number: normalizedPlanTaskNumber,
    }, 'Unable to query reusable plan task submissions');
    return null;
  }

  const matching = candidates.filter((candidate) => (
    Array.isArray(candidate?.tags)
    && candidate.tags.includes(workItemTag)
    && candidate.tags.includes(planTaskTag)
  ));
  if (matching.length === 0) {
    return null;
  }

  const prioritized = batchTag
    ? [
        ...matching.filter((candidate) => candidate.tags.includes(batchTag)),
        ...matching.filter((candidate) => !candidate.tags.includes(batchTag)),
      ]
    : matching;

  const active = prioritized.find((candidate) => (
    candidate.status === 'running'
    || candidate.status === 'queued'
    || candidate.status === 'pending'
    || candidate.status === 'pending_approval'
  ));
  if (active) {
    return { task_id: active.id, status: active.status };
  }

  const completed = prioritized.find((candidate) => candidate.status === 'completed');
  if (completed) {
    return { task_id: completed.id, status: completed.status };
  }

  return null;
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

function getLatestExecuteLiveOwnerWaitDecision(project_id, batchId = null) {
  const db = database.getDbInstance();
  if (!db || !project_id) {
    return null;
  }

  try {
    const params = [project_id];
    let batchClause = '';
    if (batchId) {
      batchClause = 'AND batch_id = ?';
      params.push(batchId);
    }
    const row = db.prepare(`
      SELECT id, stage, actor, action, reasoning, inputs_json, outcome_json, batch_id
      FROM factory_decisions
      WHERE project_id = ?
        AND stage = 'execute'
        AND action = 'worktree_reclaim_skipped_live_owner'
        ${batchClause}
      ORDER BY id DESC
      LIMIT 1
    `).get(...params);

    return hydrateDecisionRow(row);
  } catch (error) {
    logger.debug({ err: error.message, project_id, batch_id: batchId }, 'Unable to inspect execute live-owner wait decision');
    return null;
  }
}

function maybeClearCompletedExecuteOwnerWait(project, instance) {
  if (getPausedAtStage(instance) !== LOOP_STATES.EXECUTE) {
    return null;
  }

  const latestExecuteDecision = getLatestExecuteLiveOwnerWaitDecision(project.id, instance.batch_id || null);
  if (!latestExecuteDecision) {
    return null;
  }

  const owningTaskId = latestExecuteDecision?.outcome?.owning_task_id || null;
  if (!owningTaskId) {
    return null;
  }

  let owningTask = null;
  try {
    const taskCore = require('../db/task-core');
    owningTask = typeof taskCore.getTask === 'function' ? taskCore.getTask(owningTaskId) : null;
  } catch (error) {
    logger.debug({ err: error.message, task_id: owningTaskId }, 'Unable to inspect execute wait owner task');
  }

  const owningStatus = String(owningTask?.status || '').toLowerCase();
  if (owningTask && LIVE_WORKTREE_OWNER_STATUSES.has(owningStatus)) {
    return {
      waiting: true,
      owning_task_id: owningTaskId,
      owning_status: owningStatus,
    };
  }

  const updated = updateInstanceAndSync(instance.id, {
    paused_at_stage: null,
    last_action_at: nowIso(),
  });

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.EXECUTE,
    actor: 'executor',
    action: 'execute_wait_owner_completed',
    reasoning: 'Cleared EXECUTE wait because the previously live owning task is no longer active.',
    inputs: {
      instance_id: instance.id,
      previous_paused_at_stage: LOOP_STATES.EXECUTE,
      owning_task_id: owningTaskId,
    },
    outcome: {
      owning_task_id: owningTaskId,
      owning_status: owningStatus || null,
      new_state: getCurrentLoopState(updated),
    },
    confidence: 1,
    batch_id: updated.batch_id || null,
  });

  return {
    cleared: true,
    instance: updated,
    owning_task_id: owningTaskId,
    owning_status: owningStatus || null,
  };
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

        // If the target repo is operator-blocked, retrying every ~60s is
        // pointless and can re-enter the same verified work item into PLAN.
        // Pause the project so the operator gets a single clear signal instead
        // of a retry storm. Mid-merge/rebase was observed against bitsy on
        // 2026-04-20; dirty/untracked merge targets reproduced against DLPhone
        // on 2026-04-29 after a successful Ollama canary verify.
        if (isMergeTargetOperatorBlockedError(err)) {
          const isGitOperation = err.code === 'IN_PROGRESS_GIT_OPERATION';
          const reason = isGitOperation ? 'merge_target_in_conflict_state' : 'merge_target_dirty';
          const action = reason;
          const operatorPath = err.path || worktreeRecord.worktreePath;
          try {
            factoryHealth.updateProject(project_id, { status: 'paused' });
          } catch (_pauseErr) {
            void _pauseErr;
          }
          logger.warn('worktree merge blocked by target repo state; pausing project', {
            project_id,
            branch: worktreeRecord.branch,
            code: err.code,
            err: err.message,
          });
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.LEARN,
            action,
            reasoning: isGitOperation
              ? `Merge target ${operatorPath} is mid-${err.op || 'merge'}; pausing project. `
                + `Operator must resolve the conflict or run \`git ${err.op || 'merge'} --abort\` before resuming.`
              : `Merge target ${operatorPath} has uncommitted or untracked files; pausing project. `
                + 'Operator must inspect the target repo and decide whether to commit, remove, or ignore the files before resuming.',
            outcome: {
              work_item_id: workItem.id,
              branch: worktreeRecord.branch,
              op: err.op || null,
              path: operatorPath,
              error: err.message,
              files: Array.isArray(err.files) ? err.files : [],
              dirty_files: Array.isArray(err.dirty_files) ? err.dirty_files : [],
              untracked_files: Array.isArray(err.untracked_files) ? err.untracked_files : [],
              next_state: LOOP_STATES.PAUSED,
              paused_at_stage: LOOP_STATES.LEARN,
            },
            confidence: 1,
            batch_id: shippingDecision.decision_batch_id || decisionBatchId,
          });
          return {
            status: 'paused',
            reason,
            work_item_id: workItem.id,
            error: err.message,
            op: err.op || null,
            files: Array.isArray(err.files) ? err.files : [],
            dirty_files: Array.isArray(err.dirty_files) ? err.dirty_files : [],
            untracked_files: Array.isArray(err.untracked_files) ? err.untracked_files : [],
          };
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
    const decisionDb = typeof factoryDecisions.getDb === 'function'
      ? factoryDecisions.getDb()
      : database.getDbInstance();
    if (!decisionDb || typeof decisionDb.prepare !== 'function') {
      logger.debug('Skipping factory decision log because database is unavailable', {
        project_id: entry?.project_id,
        stage: normalizedStage,
        action: entry?.action,
      });
      return null;
    }
    factoryDecisions.setDb(decisionDb);

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
    || action === 'verify_reviewed_baseline_likely'
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
    if (!db || typeof db.prepare !== 'function') {
      logger.warn('SENSE: skipped plan-file intake because database is unavailable', {
        project_id,
        plans_dir: project.config.plans_dir,
      });
    } else {
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

function recoverStarvedInstanceForAdvance(project, instance) {
  const openWorkItems = countOpenWorkItems(project.id);
  if (openWorkItems <= 0) {
    return null;
  }

  clearSelectedWorkItem(instance.id);
  setConsecutiveEmptyCycles(project.id, 0);

  const pendingGateStage = getPendingGateStage(LOOP_STATES.SENSE, project.trust_level);
  const targetStage = LOOP_STATES.PRIORITIZE;
  const moved = tryMoveInstanceToStage(instance, targetStage, {
    paused_at_stage: pendingGateStage === targetStage ? targetStage : null,
    batch_id: null,
    work_item_id: null,
  });

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.SENSE,
    action: moved.blocked ? 'starved_recovery_blocked' : 'recovered_from_starved',
    reasoning: moved.blocked
      ? 'STARVED loop has replenished intake, but the next stage is occupied'
      : 'STARVED loop has replenished intake; advancing to PRIORITIZE without requiring reset',
    outcome: {
      reason: 'starved_intake_replenished',
      from_state: LOOP_STATES.STARVED,
      to_state: getCurrentLoopState(moved.instance),
      paused_at_stage: getPausedAtStage(moved.instance),
      open_work_items: openWorkItems,
      target_state: targetStage,
    },
    confidence: 1,
    batch_id: getDecisionBatchId(project, null, null, moved.instance),
  });

  return {
    instance: moved.instance,
    openWorkItems,
    blocked: moved.blocked,
  };
}

function summarizeStarvationRecovery(result) {
  if (!result) {
    return null;
  }

  return {
    recovered: !!result.recovered,
    reason: result.reason || null,
    forced: result.forced === true,
    trigger: result.trigger || null,
    scout_task_id: result.scout?.task_id || result.scout?.id || null,
    created_count: result.created_count ?? null,
    open_work_items: result.open_work_items ?? null,
  };
}

async function triggerImmediateStarvationRecovery(project, trigger) {
  if (!project || project.loop_state !== LOOP_STATES.STARVED) {
    return null;
  }

  try {
    const container = require('../container').defaultContainer;
    const starvationRecovery = container.get('starvationRecovery');
    if (!starvationRecovery || typeof starvationRecovery.maybeRecover !== 'function') {
      return null;
    }
    return await starvationRecovery.maybeRecover(project, {
      force: true,
      trigger,
    });
  } catch (err) {
    logger.warn('Immediate STARVED recovery failed', {
      project_id: project?.id,
      trigger,
      err: err.message,
    });
    return null;
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

function detectWorkItemShippedOnMain(project, workItem) {
  if (!project?.path || !workItem) {
    return null;
  }

  const planContent = workItem.origin?.plan_path && fs.existsSync(workItem.origin.plan_path)
    ? fs.readFileSync(workItem.origin.plan_path, 'utf8')
    : workItem.description || '';
  const detector = createShippedDetector({ repoRoot: project.path });
  return detector.detectShipped({ content: planContent, title: workItem.title });
}

function resolveVerifyEmptyBranch({
  project,
  project_id,
  instance,
  workItem,
  worktreeRecord,
  verifyResult,
  batch_id,
}) {
  const resolvedWorkItem = instance?.work_item_id
    ? factoryIntake.getWorkItem(instance.work_item_id)
    : (workItem || null);
  const detection = detectWorkItemShippedOnMain(project, resolvedWorkItem);
  const outputPreview = String(
    verifyResult?.stderr
    || verifyResult?.output
    || verifyResult?.stdout
    || ''
  ).slice(-1500);
  const sharedOutcome = {
    work_item_id: resolvedWorkItem?.id || null,
    branch: worktreeRecord.branch,
    worktree_path: worktreeRecord.worktreePath,
    output_preview: outputPreview,
    detection: detection ? {
      shipped: detection.shipped,
      confidence: detection.confidence,
      signals: detection.signals,
    } : null,
  };

  if (resolvedWorkItem && detection?.shipped && detection.confidence !== 'low') {
    factoryIntake.updateWorkItem(resolvedWorkItem.id, { status: 'shipped' });
    safeLogDecision({
      project_id,
      stage: LOOP_STATES.VERIFY,
      action: 'verify_empty_branch_auto_shipped',
      reasoning: `VERIFY found no commits ahead for ${worktreeRecord.branch}, and shipped-detector matched existing work on main (${detection.confidence} confidence). Marking shipped instead of pausing.`,
      outcome: sharedOutcome,
      confidence: 1,
      batch_id,
    });
    return {
      status: 'shipped',
      reason: 'auto_shipped_empty_branch_at_verify',
      branch: worktreeRecord.branch,
      worktree_path: worktreeRecord.worktreePath,
    };
  }

  if (resolvedWorkItem?.id) {
    factoryIntake.updateWorkItem(resolvedWorkItem.id, {
      status: 'rejected',
      reject_reason: 'empty_branch_after_execute',
    });
  }
  safeLogDecision({
    project_id,
    stage: LOOP_STATES.VERIFY,
    action: 'verify_empty_branch_auto_rejected',
    reasoning: `VERIFY found no commits ahead for ${worktreeRecord.branch}, and shipped-detector did not match existing work on main. Rejecting so the factory can advance instead of pausing.`,
    outcome: sharedOutcome,
    confidence: 1,
    batch_id,
  });
  return {
    status: 'rejected',
    reason: 'empty_branch_after_execute',
    branch: worktreeRecord.branch,
    worktree_path: worktreeRecord.worktreePath,
  };
}

function finalizeTerminalVerifyOutcome({ project, instance, previousState, stageResult }) {
  const lastActionAt = instance.last_action_at || nowIso();
  terminateInstanceAndSync(instance.id, { abandonWorktree: true });
  recordFactoryIdleIfExhausted(project.id, {
    last_action_at: lastActionAt,
    reason: stageResult.reason || 'verify_terminal',
  });
  const terminalAction = stageResult.status === 'shipped'
    ? 'verify_terminal_shipped_terminated'
    : 'verify_terminal_rejection_terminated';
  const terminalReasoning = stageResult.status === 'shipped'
    ? 'VERIFY auto-resolved the work item as shipped and no further stages should run for this instance.'
    : 'VERIFY reached a terminal outcome and no further stages should run for this instance.';
  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.VERIFY,
    actor: 'verifier',
    action: terminalAction,
    reasoning: terminalReasoning,
    outcome: {
      work_item_id: instance.work_item_id || null,
      instance_id: instance.id,
      status: stageResult.status || null,
      reason: stageResult.reason || null,
    },
    confidence: 1,
    batch_id: instance.batch_id,
  });
  return {
    project_id: project.id,
    instance_id: instance.id,
    previous_state: previousState,
    new_state: LOOP_STATES.IDLE,
    paused_at_stage: null,
    stage_result: stageResult,
    reason: stageResult.reason || 'verify_terminal',
  };
}

async function claimNextWorkItemForInstance(project_id, instance_id) {
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

  // Cluster B promotion: rank survivors by severity + score triggers.
  // Fall back to today's status-only order on any error — observability
  // must never block the loop.
  const project = factoryHealth.getProject(project_id);
  const projectScores = parseProjectScoresForPromotion(project);
  const promotionConfig = parsePromotionConfigForPromotion(project);
  let rankedCandidates = survivors;
  try {
    const { rankIntake } = require('./promotion-policy');
    rankedCandidates = rankIntake(survivors, { projectScores, promotionConfig });
    if (didPromoteScoutAhead(survivors, rankedCandidates)) {
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.PRIORITIZE,
        action: 'scout_promoted',
        reasoning: 'Scout finding promoted ahead of lower-severity / lower-score candidates.',
        outcome: {
          promoted_ids: rankedCandidates
            .filter((i) => i && i.source === 'scout')
            .slice(0, 3)
            .map((i) => i.id),
          project_scores: projectScores,
        },
        confidence: 1,
      });
    }
  } catch (err) {
    logger.warn('promotion_policy_failed', { err: err && err.message });
    rankedCandidates = survivors;
  }

  const orderedCandidates = [];
  for (const status of WORK_ITEM_STATUS_ORDER) {
    orderedCandidates.push(...rankedCandidates.filter((item) => item && item.status === status));
  }
  orderedCandidates.push(...rankedCandidates.filter((item) => !orderedCandidates.includes(item)));

  const maxRepicks = Math.max(1, (promotionConfig?.stale_max_repicks) || 3);
  const skipped = [];
  let staleProbeBudgetExhaustedLogged = false;
  const projectPath = project?.path || null;
  const { probeStaleness } = require('./stale-probe');

  for (const item of orderedCandidates) {
    if (!item) continue;
    if (item.claimed_by_instance_id === instance_id) {
      return { openItems: survivors, workItem: item };
    }
    if (item.claimed_by_instance_id) continue;

    // Stale probe — non-scout items Gate-1-out immediately in probeStaleness,
    // so it is safe to run for every candidate.
    let probe = { stale: false, reason: 'skipped' };
    if (skipped.length < maxRepicks) {
      try {
        probe = await probeStaleness(item, { projectPath, promotionConfig });
      } catch (err) {
        logger.warn('stale_probe_threw', { err: err && err.message, work_item_id: item.id });
        probe = { stale: false, reason: 'probe_errored' };
      }
    } else if (!staleProbeBudgetExhaustedLogged) {
      staleProbeBudgetExhaustedLogged = true;
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.PRIORITIZE,
        action: 'stale_probe_budget_exhausted',
        reasoning: 'Stale probe skip budget exhausted; claiming the next open item instead of reporting an empty intake queue.',
        outcome: {
          skipped,
          max_repicks: maxRepicks,
          fallback_work_item_id: item.id,
        },
        confidence: 1,
      });
    }

    if (probe.stale) {
      try {
        factoryIntake.updateWorkItem(item.id, { status: 'shipped_stale' });
      } catch (err) {
        logger.warn('stale_status_write_failed', { err: err && err.message, work_item_id: item.id });
      }
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.PRIORITIZE,
        action: 'skipped_stale_scout_item',
        reasoning: `Scout finding no longer reproduces: ${probe.reason}`,
        outcome: {
          work_item_id: item.id,
          stale_reason: probe.reason,
          commits_since_scan: probe.commits_since_scan,
          probe_ms: probe.probe_ms,
        },
        confidence: 1,
      });
      skipped.push(item.id);
      continue;
    }

    const claimed = factoryIntake.claimWorkItem(item.id, instance_id);
    if (claimed) {
      return { openItems: survivors, workItem: claimed };
    }
  }

  if (skipped.length >= maxRepicks) {
    safeLogDecision({
      project_id,
      stage: LOOP_STATES.PRIORITIZE,
      action: 'stale_probe_starvation',
      reasoning: `Top ${skipped.length} candidates all marked stale; PRIORITIZE advanced without a claim.`,
      outcome: { skipped },
      confidence: 1,
    });
  }

  return { openItems: survivors, workItem: null };
}

function parseProjectScoresForPromotion(project) {
  if (!project) return {};
  if (project.scores && typeof project.scores === 'object') return project.scores;
  if (typeof project.scores_json === 'string') {
    try { return JSON.parse(project.scores_json); } catch { return {}; }
  }
  return {};
}

function parsePromotionConfigForPromotion(project) {
  const raw = project?.config_json;
  if (!raw) return null;
  try {
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return cfg.scout_promotion || null;
  } catch (err) {
    logger.warn('promotion_config_parse_failed', { err: err && err.message });
    return null;
  }
}

function didPromoteScoutAhead(originalSurvivors, ranked) {
  const origFirst = originalSurvivors[0];
  const rankedFirst = ranked[0];
  if (!origFirst || !rankedFirst) return false;
  return origFirst.source !== 'scout' && rankedFirst.source === 'scout';
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

async function executePrioritizeStage(project, instance, selectedWorkItem = null) {
  const claimResult = selectedWorkItem
    ? { openItems: factoryIntake.listOpenWorkItems({ project_id: project.id, limit: 100 }), workItem: selectedWorkItem }
    : await claimNextWorkItemForInstance(project.id, instance.id);
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

  try {
    const entries = fs.readdirSync(root);
    if (entries.some((entry) => entry.endsWith('.csproj') || entry.endsWith('.sln'))
      || fs.existsSync(path.join(root, 'simtests', 'SimCore.DotNet.Tests.csproj'))
      || fs.existsSync(path.join(root, 'server', 'DeadlockRelay'))
      || fs.existsSync(path.join(root, 'client', 'UnityProject'))) {
      return 'C#/.NET, Unity';
    }
  } catch {
    // Continue with marker-based inference below.
  }

  if (fs.existsSync(path.join(root, 'package.json'))) {
    return 'Node.js';
  }
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) {
    return 'Python';
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    return 'Rust';
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

// Codegraph integration block. Emitted only when explicitly enabled via
// TORQUE_CODEGRAPH_ENABLED=1 — otherwise the
// planner would be told about tools that don't exist and fail when
// calling them. The block teaches the
// planner Codex to use the cg_* MCP tools as a research step before
// committing to a plan, rather than trying to ship the work blind.
//
// Why advertise tools rather than pre-compute context (Option A):
//   The planner knows what symbols are mentioned in its own work item far
//   better than a heuristic regex. Letting it ask shrinks both the prompt
//   and the noise floor — it queries only the names it actually plans to
//   touch, and follows up with deeper queries when the first answer
//   surprises it. Trade-off: 1-3 extra MCP round-trips per plan-gen,
//   typically <1s each given the codegraph queries are SQLite-local.
const CODEGRAPH_PLANNER_PROMPT_SECTION = [
  'Code-graph research:',
  'A code-graph index of this repo is available via these MCP tools.',
  'Use them BEFORE finalizing any task that changes existing code:',
  '- `cg_index_status({repo_path})` — confirm the index is fresh; if stale,',
  '  call `cg_reindex({repo_path})` first.',
  '- `cg_class_hierarchy({repo_path, symbol, direction})` — before',
  '  refactoring a base class or interface, list its descendants. Pass',
  '  direction="descendants" to find subclasses; "ancestors" to walk up.',
  '- `cg_impact_set({repo_path, symbol, depth, scope})` — before changing',
  '  a function/method, list the symbols + files affected. Default depth',
  '  is 3 (local refactor scope). Use scope="strict" to filter same-name',
  '  collisions when import resolution applies.',
  '- `cg_find_references({repo_path, symbol, scope, container})` — list',
  '  call sites for a symbol. Pass container="ClassName" with scope=strict',
  '  to disambiguate methods that share a bare name across classes.',
  '- `cg_call_graph({repo_path, symbol, direction, depth})` — walk callers',
  '  or callees, bounded by depth (max 8) and 100 nodes.',
  '- `cg_resolve_tool({repo_path, tool_name})` — for an MCP tool name in',
  '  this repo, find the handler symbol via dispatch-edge index.',
  '- `cg_dead_symbols({repo_path})` — find unused symbols when planning',
  '  cleanup work.',
  'Quote concrete numbers from these queries in your task bodies — for',
  'example, "13 subclasses extend BaseProvider, all in server/providers/"',
  'or "47 callers across 22 files (impact_set depth=2)". The plan-quality',
  'gate counts these as the "Estimated scope" specificity signal.',
  '',
].join('\n');

const PLAN_GENERATION_REPOSITORY_BOUNDARY_SECTION = [
  'Repository boundary (CRITICAL):',
  '- Inspect and cite only files under the project path listed below.',
  '- Do not read, search, summarize, or rely on Codex memories, user-home paths, `.codex/`, `.torque/`, or any path outside the project tree.',
  '- If previous-attempt feedback mentions files outside the project path, ignore those paths unless they also exist under the current project tree.',
  '- Base the plan on the work item, project files, and in-repository docs only.',
  '',
].join('\n');

/**
 * Collect concrete file paths the architect should consider when planning
 * the work item. Pulls from three sources:
 *   - workItem.origin.exemplar_files — set by scout-output-intake from
 *     scout __PATTERNS_READY__ signals. Phase B's existence guard already
 *     verified these paths exist on disk.
 *   - workItem.origin.shared_dependencies — scout-flagged supporting
 *     files (test projects, shared headers, etc.).
 *   - workItem.origin.allowed_files / workItem.constraints.allowed_files —
 *     hard scope bounds set by operator-seeded items.
 *
 * Without these in the architect prompt, scout-source items stay
 * topic-level and consistently fail the deterministic plan-quality
 * gate's "explicit file paths" signal. DLPhone #2098 (2026-04-30)
 * demonstrated this: scout produced a real domain pattern citing
 * `docs/planning/BackendMultiplayerPlan.md`, but the architect never
 * saw that path so its tasks named no concrete files and the plan was
 * rejected on every retry.
 */
function collectArchitectScopeFiles(workItem) {
  const out = new Set();
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) {
      out.add(value.trim());
    }
  };
  const pushAll = (arr) => {
    if (Array.isArray(arr)) arr.forEach(push);
  };

  const origin = workItem?.origin || {};
  pushAll(origin.exemplar_files);
  pushAll(origin.allowed_files);
  if (Array.isArray(origin.shared_dependencies)) {
    for (const dep of origin.shared_dependencies) {
      if (typeof dep === 'string') {
        push(dep);
      } else if (dep && typeof dep === 'object') {
        push(dep.file);
      }
    }
  }

  // constraints can be a JSON string (DB column) or already-parsed object.
  let constraints = workItem?.constraints || null;
  if (!constraints && workItem?.constraints_json) {
    try {
      constraints = JSON.parse(workItem.constraints_json);
    } catch {
      constraints = null;
    }
  }
  if (constraints && typeof constraints === 'object') {
    pushAll(constraints.allowed_files);
  }

  return Array.from(out);
}

function buildAutoGeneratedPlanPrompt(project, workItem, priorFeedback = null) {
  const projectBrief = typeof project?.brief === 'string' && project.brief.trim()
    ? project.brief.trim()
    : 'No project brief provided.';
  const description = String(workItem?.description || '').trim();
  const techStack = inferAutoGeneratedPlanTechStack(project?.path);
  const scopeFiles = collectArchitectScopeFiles(workItem);
  const effectiveProvider = getEffectiveProjectProvider(project);
  // Phase G: small local models (qwen3-coder:30b on the ollama lane)
  // can't drive the cg_* MCP tools effectively and timeout trying. Skip
  // the codegraph research section for ollama-pinned projects so the
  // prompt stays under ~2K chars and the architect has a real shot at
  // completing within the (also tightened) plan-generation timeout.
  const useOllamaShortPrompt = effectiveProvider === 'ollama';
  // Opt-in only. Live plan-generation tasks run through provider CLIs that
  // may not receive TORQUE's cg_* MCP tools even when the server plugin is
  // installed. Advertising unavailable tools caused Codex plan retries to
  // spend minutes on unsupported calls and then fail the plan-quality gate.
  // Operators can still enable this deliberately for environments where
  // those tools are mounted into the worker process.
  const codegraphEnabled = process.env.TORQUE_CODEGRAPH_ENABLED === '1' && !useOllamaShortPrompt;

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
    '- Do not tell the worker to create, switch to, or work inside another git worktree; factory execution already runs inside the isolated worktree for this batch.',
    '- The orchestrator runs the project verify command after task completion. Do not tell the worker to run the full build/test suite in task bodies.',
    '- Treat `.NET build/test` commands and repo build-wrapper scripts as heavyweight. If one of those commands must appear in a task body, prefix it with `torque-remote`.',
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
    '   path/to/spec.js`, `torque-remote dotnet test tests/MyApp.Tests/MyApp.Tests.csproj`,',
    '   `npx tsc --noEmit`, or `cargo test`.',
    '5. Concrete language — avoid bare verbs like "improve", "handle",',
    '   "update", "clean up", "as needed". If you use them, qualify',
    '   with a nearby file path, function name, or backtick identifier.',
    '',
    PLAN_GENERATION_REPOSITORY_BOUNDARY_SECTION,
    ...(codegraphEnabled ? [CODEGRAPH_PLANNER_PROMPT_SECTION] : []),
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
    ...(scopeFiles.length > 0 ? [
      '',
      'Files in scope (cite these in task bodies — they satisfy the "explicit file paths" signal):',
      ...scopeFiles.map((f) => `- \`${f}\``),
      'These paths come from the scout pattern (`exemplar_files`, `shared_dependencies`) or the work-item constraints. They are verified to exist in the project tree. Plan tasks that edit, test, or extend these files; do NOT invent unrelated paths.',
    ] : []),
    '',
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

function isPromptEchoTail(lines, index) {
  const tail = lines.slice(index, Math.min(lines.length, index + 30)).join('\n');
  return /Use `## Task N:` headings exactly|Every task body MUST include all five|Project context:|Work item context:|Code-graph research:|Quality Rules/i.test(tail);
}

function trimPromptEchoTail(value) {
  const lines = String(value || '').split(/\r?\n/);
  const cutoff = lines.findIndex((line, index) => {
    if (index === 0) return false;
    const trimmed = line.trim();
    if (/^(Project context:|Work item context:|Code-graph research:)$/i.test(trimmed)) {
      return true;
    }
    if (/^#{1,3}\s+Quality Rules\b/i.test(trimmed)) {
      return true;
    }
    if (/^Every task body MUST include all five/i.test(trimmed)) {
      return true;
    }
    return trimmed === 'Rules:' && isPromptEchoTail(lines, index);
  });

  if (cutoff === -1) return value;
  return lines.slice(0, cutoff).join('\n').trimEnd();
}

function isAlreadyRemoteRouted(fullLine, commandIndex) {
  const prefix = fullLine.slice(0, commandIndex).toLowerCase();
  const remoteIndex = prefix.lastIndexOf('torque-remote');
  if (remoteIndex === -1) return false;
  const separatorIndex = Math.max(
    prefix.lastIndexOf(';'),
    prefix.lastIndexOf('&&'),
    prefix.lastIndexOf('|'),
    prefix.lastIndexOf('\n'),
  );
  return remoteIndex > separatorIndex;
}

function prefixUnroutedHeavyCommand(line, pattern) {
  return String(line || '').replace(pattern, (match, leading, command, offset, fullLine) => {
    const commandIndex = offset + leading.length;
    if (isAlreadyRemoteRouted(fullLine, commandIndex)) {
      return match;
    }
    return `${leading}torque-remote ${command}`;
  });
}

function routeHeavyValidationCommands(value) {
  const lines = String(value || '').split(/\r?\n/);
  let changed = false;
  const routed = lines.map((line) => {
    if (!findHeavyLocalValidationCommand(line)) {
      return line;
    }

    let next = prefixUnroutedHeavyCommand(line, /(^|[^\w-])(dotnet\s+(?:build|test)\b)/gi);
    next = prefixUnroutedHeavyCommand(next, /(^|[^\w-])((?:pwsh|powershell(?:\.exe)?)(?:\s+-file)?\s+(?:\.?[\\/])?scripts[\\/](?:build|test)\.ps1\b)/gi);
    next = prefixUnroutedHeavyCommand(next, /(^|[^\w-])((?:bash|sh)\s+(?:\.?[\\/])?scripts[\\/](?:build|test)\.sh\b)/gi);
    if (next !== line) {
      changed = true;
    }
    return next;
  });

  return changed ? routed.join('\n') : value;
}

function getWorkItemConstraintsObject(workItem) {
  if (workItem?.constraints && typeof workItem.constraints === 'object') {
    return workItem.constraints;
  }
  return parseJsonObject(workItem?.constraints_json) || {};
}

function extractWorkItemAcceptanceCriteria(workItem) {
  const description = String(workItem?.description || '');
  const match = description.match(/\bAcceptance criteria:\s*([\s\S]+)$/i);
  if (!match) return null;
  const firstBlock = String(match[1] || '').split(/\r?\n\s*\r?\n/)[0].trim();
  if (!firstBlock) return null;
  return firstBlock.replace(/\s+/g, ' ').slice(0, 800);
}

function buildWorkItemScopeDetail(workItem) {
  const constraints = getWorkItemConstraintsObject(workItem);
  const allowedFiles = Array.isArray(constraints.allowed_files)
    ? constraints.allowed_files.map((file) => String(file || '').trim()).filter(Boolean)
    : [];
  const maxFiles = Number(constraints.max_files);

  if (allowedFiles.length > 0) {
    const fileList = allowedFiles.map((file) => `\`${file}\``).join(', ');
    const fileCount = Number.isFinite(maxFiles) && maxFiles > 0
      ? `up to ${maxFiles} file${maxFiles === 1 ? '' : 's'}`
      : `${allowedFiles.length} file${allowedFiles.length === 1 ? '' : 's'}`;
    return `${fileCount}, limited to ${fileList}`;
  }

  if (Number.isFinite(maxFiles) && maxFiles > 0) {
    return `up to ${maxFiles} file${maxFiles === 1 ? '' : 's'}`;
  }

  return null;
}

function buildTaskSpecificityAdditions(task, workItem) {
  const score = scoreAutoGeneratedTaskDescription(task);
  if (score.passed) return [];

  const missing = new Set(score.missing_signals || []);
  const additions = [];
  const scopeDetail = buildWorkItemScopeDetail(workItem);
  const acceptance = extractWorkItemAcceptanceCriteria(workItem);

  if ((missing.has('explicit_file_paths') || missing.has('estimated_scope')) && scopeDetail) {
    additions.push(`Estimated scope: single focused change across ${scopeDetail}.`);
  }
  if ((missing.has('success_criteria') || missing.has('validation_steps')) && acceptance) {
    additions.push(`Success criteria: ${acceptance}`);
  }

  return additions;
}

function augmentAutoGeneratedTaskSpecificity(taskSection, workItem) {
  const parts = String(taskSection || '').split(/(^## Task\s+\d+:\s*.*$)/m);
  if (parts.length < 3) return taskSection;

  let augmented = false;
  const out = [];

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i > 0 && /^## Task\s+\d+:/.test(parts[i - 1] || '')) {
      const heading = parts[i - 1] || '';
      const match = heading.match(/^## Task\s+(\d+):\s*(.*)$/);
      const task = {
        index: Number(match?.[1] || 0),
        title: (match?.[2] || '').trim(),
        body: String(part || '').trim(),
      };
      const additions = buildTaskSpecificityAdditions(task, workItem);
      if (additions.length > 0) {
        const body = String(part || '').trimEnd();
        out.push(`${body}\n\n    ${additions.join(' ')}\n`);
        augmented = true;
        continue;
      }
    }
    out.push(part);
  }

  return augmented ? out.join('') : taskSection;
}

function getPrimaryAllowedFile(workItem) {
  const constraints = getWorkItemConstraintsObject(workItem);
  const allowedFiles = Array.isArray(constraints.allowed_files)
    ? constraints.allowed_files.map((file) => String(file || '').trim()).filter(Boolean)
    : [];
  return allowedFiles[0] || null;
}

function replaceUnqualifiedPlanPhrase(text, pattern, replacement) {
  return String(text || '').replace(pattern, replacement);
}

function qualifyAutoGeneratedVaguePlanLanguage(value, workItem) {
  const primaryFile = getPrimaryAllowedFile(workItem);
  if (!primaryFile) return value;

  const fileRef = `\`${primaryFile}\``;
  let text = String(value || '');
  text = replaceUnqualifiedPlanPhrase(
    text,
    /\bmodif(?:y|ies|ied|ying)\s+the\s+test\s+bodies\s+to\s+improv(?:e|es|ed|ing)\s+readability\b/gi,
    `Edit ${fileRef} test bodies to clarify statement grouping`
  );
  text = replaceUnqualifiedPlanPhrase(
    text,
    /\bimprov(?:e|es|ed|ing)\s+code\s+formatting\s+and\s+clarity\b/gi,
    `clarifying formatting in ${fileRef}`
  );
  text = replaceUnqualifiedPlanPhrase(
    text,
    /\bimprov(?:e|es|ed|ing)\s+readability\b/gi,
    `clarify statement grouping in ${fileRef}`
  );
  text = replaceUnqualifiedPlanPhrase(text, /\bimprov(?:e|es|ed|ing)\b/gi, `clarify ${fileRef}`);
  text = replaceUnqualifiedPlanPhrase(text, /\bupdat(?:e|es|ed|ing)\b/gi, `edit ${fileRef}`);
  text = replaceUnqualifiedPlanPhrase(text, /\bmodif(?:y|ies|ied|ying)\b/gi, `edit ${fileRef}`);
  text = replaceUnqualifiedPlanPhrase(text, /\bhandl(?:e|es|ed|ing)\b/gi, `cover ${fileRef}`);
  text = replaceUnqualifiedPlanPhrase(text, /\bclean\s+up\b/gi, `simplify ${fileRef}`);
  text = replaceUnqualifiedPlanPhrase(text, /\bas\s+needed\b/gi, `within ${fileRef}`);
  return text;
}

function inferAutoGeneratedPlanValidationCommand(projectPath) {
  const root = path.resolve(projectPath || process.cwd());
  const simCoreTests = path.join(root, 'simtests', 'SimCore.DotNet.Tests.csproj');
  if (fs.existsSync(simCoreTests)) {
    return 'torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj';
  }
  if (fs.existsSync(path.join(root, 'package.json'))) {
    return 'npm test';
  }
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'pytest.ini'))) {
    return 'pytest';
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    return 'cargo test';
  }

  try {
    const entries = fs.readdirSync(root);
    if (entries.some((entry) => entry.endsWith('.csproj') || entry.endsWith('.sln'))) {
      return 'torque-remote dotnet test';
    }
  } catch {
    // Fall through to the generic check below.
  }

  return 'git diff --check';
}

function indentForPlan(value, spaces = 8) {
  const prefix = ' '.repeat(spaces);
  const text = String(value ?? '');
  if (!text) return `${prefix}<empty>`;
  return text.split(/\r?\n/).map((line) => `${prefix}${line}`).join('\n');
}

function normalizeProposalOperationType(operation) {
  const raw = typeof operation?.type === 'string' ? operation.type.trim().toLowerCase() : '';
  if (raw === 'create') return 'create';
  if (raw === 'delete') return 'delete';
  return 'replace';
}

function buildPlanFromFileEditsProposal(rawOutput, workItem, project) {
  let parsed;
  let validation;
  try {
    const computeParser = require('../diffusion/compute-output-parser');
    parsed = computeParser.parseComputeOutput(rawOutput);
    validation = computeParser.validateComputeSchema(parsed);
  } catch (_err) {
    return null;
  }

  if (!parsed || !validation?.valid) {
    return null;
  }

  const edits = parsed.file_edits
    .map((edit) => ({
      file: String(edit.file || '').trim(),
      operations: Array.isArray(edit.operations) ? edit.operations : [],
    }))
    .filter((edit) => edit.file && edit.operations.length > 0);
  if (edits.length === 0) {
    return null;
  }

  const operationCount = edits.reduce((sum, edit) => sum + edit.operations.length, 0);
  const validationCommand = inferAutoGeneratedPlanValidationCommand(project?.path);
  const title = `${workItem?.title || `Work Item ${workItem?.id}`} Plan`;
  const lines = [
    `# ${title}`,
    '',
    `**Source:** auto-generated from work_item #${workItem?.id}`,
    '**Proposal Format:** normalized from file_edits JSON emitted by plan generation.',
    `**Tech Stack:** ${inferAutoGeneratedPlanTechStack(project?.path)}`,
    '',
    `## Task 1: Apply proposed edits for ${workItem?.title || `work item ${workItem?.id}`}`,
    '',
    '- [ ] **Step 1: Apply proposed repository edits**',
    '',
    `    Edit ${edits.length} file(s) with ${operationCount} exact operation(s). Scope is limited to ${edits.map((edit) => `\`${edit.file}\``).join(', ')}. Acceptance criteria: apply only the listed create/replace/delete operations, preserve unrelated code, and ensure the requested work item behavior is represented in the touched files.`,
    '',
  ];

  for (const edit of edits) {
    lines.push(`    File: \`${edit.file}\``);
    edit.operations.forEach((operation, index) => {
      const type = normalizeProposalOperationType(operation);
      lines.push(`    Operation ${index + 1}: ${type}`);
      if (type !== 'create') {
        lines.push('    Old text:');
        lines.push(indentForPlan(operation.old_text, 8));
      }
      if (type !== 'delete') {
        lines.push('    New text:');
        lines.push(indentForPlan(operation.new_text, 8));
      }
      lines.push('');
    });
  }

  lines.push(
    '- [ ] **Step 2: Validate changed area**',
    '',
    `    Run \`${validationCommand}\` from the repository root. The command should pass, or the worker must report a concrete pre-existing environment blocker tied to the touched files.`,
    '',
    '- [ ] **Step 3: Commit**',
    '',
    `    git commit -m "fix(${slugifyAutoGeneratedPlanSegment(project?.name || 'factory')}): ${slugifyAutoGeneratedPlanSegment(workItem?.title || 'apply proposal')}"`,
    '',
  );

  const plan = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return plan.length <= 100000 ? `${plan}\n` : null;
}

function normalizeAutoGeneratedPlanMarkdown(markdown, workItem, project) {
  const raw = convertFencedBlocksToIndented(unwrapWholeMarkdownFence(markdown));
  // Accept common variations: "## Task 1:", "## Task 1.", "## Task 1 -",
  // "### Task 1:", "## Step 1:", "## 1.", "## 1:"
  const taskMatch = raw.match(/^#{2,3}\s+(?:Task|Step)?\s*\d+\s*[:.—-]\s*.+$/m)
    || raw.match(/^#{2,3}\s+\d+[.:]\s*.+$/m);
  if (!taskMatch || typeof taskMatch.index !== 'number') {
    return buildPlanFromFileEditsProposal(markdown, workItem, project);
  }

  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const goalMatch = raw.match(/\*\*Goal:\*\*\s*([^\n]+)/i);
  const techStackMatch = raw.match(/\*\*Tech Stack:\*\*\s*([^\n]+)/i);
  let taskSection = qualifyAutoGeneratedVaguePlanLanguage(trimPromptEchoTail(raw.slice(taskMatch.index).trim()), workItem);
  taskSection = routeHeavyValidationCommands(taskSection);
  taskSection = routeHeavyValidationCommands(augmentAutoGeneratedTaskSpecificity(taskSection, workItem));
  const lines = [
    `# ${(titleMatch?.[1] || `${workItem?.title || `Work Item ${workItem?.id}`} Plan`).trim()}`,
    '',
    `**Source:** auto-generated from work_item #${workItem?.id}`,
  ];

  if (goalMatch?.[1]?.trim()) {
    lines.push(`**Goal:** ${goalMatch[1].trim()}`);
  }

  const inferredTechStack = inferAutoGeneratedPlanTechStack(project?.path);
  const modelTechStack = techStackMatch?.[1]?.trim();
  const normalizedTechStack = inferredTechStack && inferredTechStack !== 'application code'
    ? inferredTechStack
    : (modelTechStack || inferredTechStack || 'application code');
  lines.push(`**Tech Stack:** ${normalizedTechStack.trim()}`);
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
  const generatorProvider = getStoredPlanGeneratorProvider(workItem);
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
        task_metadata: {
          // Inject the project's provider_lane_policy so the smart-routing
          // chain filter (handlers/integration/routing.js) keeps the
          // reviewer task on the project's allowed providers. Without this,
          // a project pinned to ollama (e.g. DLPhone) silently leaked
          // reviewer work to whatever the routing template's default chain
          // picked — observed 2026-04-29 with Codex running DLPhone-tagged
          // reviewer tasks despite enforce_handoffs:true.
          ...buildProviderLaneTaskMetadata(project || {}),
          ...(args.task_metadata || {}),
        },
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

// Bookkeeping/tracking tasks (evidence capture, work-item wiring, handoff
// notes, etc.) naturally lack line counts and test-runner invocations, so they
// score at most 60/100 on the generic gate even when well-specified. When a
// tracking phrase is present and no code-change vocabulary appears, accept that
// shape and auto-satisfy `estimated_scope` + `validation_steps`. The remaining
// three signals (explicit paths, success criteria, concrete language) still
// have to pass on their own, so vague "wire tracking" one-liners are still
// rejected.
const PLAN_DESCRIPTION_TRACKING_POSITIVE_RES = Object.freeze([
  /\brecord\s+evidence\b/i,
  /\bwire\b.{0,40}?\binto\b.{0,40}?\btracking\b/i,
  /\bupdate\s+(?:the\s+)?work\s+item\b/i,
  /\bclose\s+out\b/i,
  /\bcapture\b.{0,40}?\bin\s+(?:tracking|notes|log)\b/i,
  /\bdocument\s+the\s+(?:finding|decision|outcome|handoff)\b/i,
]);

const PLAN_DESCRIPTION_TRACKING_NEGATIVE_RES = Object.freeze([
  /\bimplement\b/i,
  /\brefactor\b/i,
  /\badd\s+function\b/i,
  /\badd\s+method\b/i,
  /\badd\s+class\b/i,
  /\bmodify\b/i,
  /\brewrite\b/i,
  /\bfix\s+bug\b/i,
  /\bpatch\b/i,
]);

function isTrackingSupportTask(task) {
  const text = `${task?.title || ''}\n${task?.body || ''}`.trim();
  if (!text) return false;
  if (PLAN_DESCRIPTION_TRACKING_NEGATIVE_RES.some((re) => re.test(text))) return false;
  return PLAN_DESCRIPTION_TRACKING_POSITIVE_RES.some((re) => re.test(text));
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
  const isTrackingSupport = isTrackingSupportTask(task);
  const signals = {
    explicit_file_paths: filePaths.length > 0,
    estimated_scope: PLAN_DESCRIPTION_SCOPE_RE.test(text) || isDocOnly || isTrackingSupport,
    success_criteria: PLAN_DESCRIPTION_SUCCESS_RE.test(text),
    validation_steps: PLAN_DESCRIPTION_VALIDATION_RE.test(text) || isDocOnly || isTrackingSupport,
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

function readWorkItemPlanText(workItem) {
  const origin = getWorkItemOriginObject(workItem);
  const planPath = origin?.plan_path;
  if (!planPath || !fs.existsSync(planPath)) {
    return null;
  }
  try {
    return fs.readFileSync(planPath, 'utf8');
  } catch (_err) {
    return null;
  }
}

function resolveProjectVerifyCommand(project) {
  const fromFactoryConfig = normalizeVerifyCommand(project?.config?.verify_command);
  if (fromFactoryConfig) return { command: fromFactoryConfig, source: 'factory_project_config' };

  if (project && project.name) {
    try {
      const projectConfigCore = require('../db/project-config-core');
      const defaults = projectConfigCore.getProjectConfig(project.name);
      const fromDefaults = normalizeVerifyCommand(defaults?.verify_command);
      if (fromDefaults) return { command: fromDefaults, source: 'project_defaults' };
    } catch (_pccErr) {
      void _pccErr;
    }
  }

  return { command: 'cd server && npx vitest run', source: 'fallback_default' };
}

function resolveWorkItemVerifyCommand(workItem) {
  const origin = getWorkItemOriginObject(workItem);
  for (const key of ['verify_command', 'verification', 'validation_command', 'validation']) {
    const command = normalizeVerifyCommand(origin?.[key]);
    if (command) return { command, source: `work_item_origin.${key}` };
  }

  const descriptionCommand = extractExplicitVerifyCommand(workItem?.description || '');
  if (descriptionCommand) return { command: descriptionCommand, source: 'work_item_description' };

  const planText = readWorkItemPlanText(workItem);
  const planCommand = extractExplicitVerifyCommand(planText || '');
  if (planCommand) return { command: planCommand, source: 'plan_file' };

  return null;
}

function resolveFactoryVerifyCommand({ project, workItem } = {}) {
  const workItemCommand = resolveWorkItemVerifyCommand(workItem);
  if (workItemCommand) return workItemCommand;
  return resolveProjectVerifyCommand(project);
}

function maybeClearDeferredPlanGenerationWait(project, instance) {
  const workItem = tryGetSelectedWorkItem(instance, project.id, {
    fallbackToLoopSelection: true,
  });
  const generationTaskId = getStoredPlanGenerationTaskId(workItem);
  const origin = getWorkItemOriginObject(workItem);
  if (!workItem || !generationTaskId) {
    return null;
  }

  if (origin.plan_path && fs.existsSync(origin.plan_path)) {
    const updated = updateInstanceAndSync(instance.id, {
      paused_at_stage: null,
      last_action_at: nowIso(),
    });
    return {
      cleared: true,
      instance: updated,
      task_id: generationTaskId,
      task_status: null,
    };
  }

  const taskCore = require('../db/task-core');
  const generationTask = getPlanGenerationTask(taskCore, generationTaskId);
  if (isPlanGenerationTaskPending(generationTask)) {
    const wait = getPlanGenerationWait(generationTask);
    return {
      waiting: true,
      task_id: generationTaskId,
      task_status: generationTask?.status || 'queued',
      wait_reason: normalizeOptionalString(wait?.reason) || 'task_still_running',
      retry_after: normalizeOptionalString(wait?.retry_after),
    };
  }

  const updated = updateInstanceAndSync(instance.id, {
    paused_at_stage: null,
    last_action_at: nowIso(),
  });
  return {
    cleared: true,
    instance: updated,
    task_id: generationTaskId,
    task_status: generationTask?.status || null,
  };
}

const PLAN_QUALITY_REJECT_CAP = 5;

function returnAutoGeneratedPlanToPrioritizeForDescriptionQuality({
  project,
  instance = null,
  workItem,
  lint,
  planPath,
  generator = PLAN_GENERATOR_LABEL,
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
  // item forever (Shape-3 spin seen on example-project item 419, 46 cycles
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
    // Bug D fix: pre-written plans previously bypassed plan-quality-gate
    // entirely, so plans containing bare `dotnet test` (and other heavy local
    // validation that governance rejects at execution time) reached EXECUTE
    // and the resulting tasks failed in 1s on the heavy-validation guard,
    // thrashing the worktree-reclaim loop. Run the gate against the
    // pre-written plan so it has the same quality bar as architect-generated.
    const planQualityGate = require('./plan-quality-gate');
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
      try {
        factoryIntake.rejectWorkItemUnactionable(
          workItem.id,
          'pre_written_plan_rejected_by_quality_gate',
        );
      } catch (rejectErr) {
        // Don't swallow silently — if rejection fails (DB lock, REJECT_REASONS
        // gap, etc.) the work item stays prioritized and PRIORITIZE will pick
        // it again next tick. Logging makes the regression detectable.
        logger.warn('pre-written plan rejection failed; loop may re-pick item', {
          project_id: project.id,
          work_item_id: workItem.id,
          err: rejectErr.message,
        });
      }
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.PLAN,
        action: 'pre_written_plan_quality_rejected',
        reasoning: `Pre-written plan failed quality gate: ${failedRules.join(', ')}.`,
        inputs: {
          ...getWorkItemDecisionContext(workItem),
          plan_path: workItem.origin.plan_path,
        },
        outcome: {
          // architect_skipped is false here — neither architect nor the
          // executor ran; the gate caught the plan early and we're bailing.
          gate_only_evaluated: true,
          rule_violations: preWrittenGateVerdict.hardFails,
          plan_path: workItem.origin.plan_path,
          ...getWorkItemDecisionContext(workItem),
        },
        confidence: 1,
        batch_id: getDecisionBatchId(project, workItem, null, instance),
      });
      return {
        reason: 'pre-written plan rejected by quality gate',
        work_item: factoryIntake.getWorkItem(workItem.id) || workItem,
        stop_execution: true,
        // Match the convention at line 4039 (architect-side rejection):
        // PRIORITIZE picks the next work item next tick rather than re-running
        // SENSE's full plan-file scan.
        next_state: LOOP_STATES.PRIORITIZE,
        stage_result: {
          status: 'rejected',
          reason: 'pre_written_plan_rejected_by_quality_gate',
          work_item_id: workItem.id,
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
        generator: PLAN_GENERATOR_LABEL,
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
  };

  if (fs.existsSync(planPath)) {
    const updatedWorkItem = factoryIntake.updateWorkItem(targetItem.id, {
      origin_json: clearPlanGenerationWaitFields(nextOrigin),
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
  let generationTaskId = getStoredPlanGenerationTaskId(targetItem);
  const planGenerationTimeoutMinutes = resolvePlanGenerationTimeoutMinutes(project);

  try {
    if (!generationTaskId) {
      const { task_id } = await submitFactoryInternalTask({
        task: prompt,
        project: 'factory-architect',
        working_directory: project.path || process.cwd(),
        kind: 'plan_generation',
        project_id: project.id,
        work_item_id: targetItem.id,
        timeout_minutes: planGenerationTimeoutMinutes,
      });

      generationTaskId = task_id;
      if (!generationTaskId) {
        throw new Error('smart_submit_task did not return task_id');
      }

      try {
        const pendingWorkItem = factoryIntake.updateWorkItem(targetItem.id, {
          origin_json: {
            ...nextOrigin,
            plan_generation_task_id: generationTaskId,
            plan_generation_status: 'submitted',
            plan_generation_updated_at: nowIso(),
          },
          status: targetItem.status || 'planned',
        });
        rememberSelectedWorkItem(instance.id, pendingWorkItem);
      } catch (persistErr) {
        logger.warn('EXECUTE stage: failed to persist pending plan-generation task id', {
          project_id: project.id,
          work_item_id: targetItem.id,
          generation_task_id: generationTaskId,
          err: persistErr.message,
        });
      }
    } else {
      const resolved = resolveTaskReplacementChain(taskCore, generationTaskId);
      if (resolved.replaced) {
        generationTaskId = resolved.taskId;
        persistPlanGenerationTaskReplacement(targetItem, generationTaskId);
      }
      const existingGenerationTask = resolved.task;
      const existingWait = getPlanGenerationWait(existingGenerationTask);
      if (isPlanGenerationTaskPending(existingGenerationTask) && existingWait) {
        return buildPlanGenerationDeferredResult({
          project,
          instance,
          targetItem,
          planPath,
          generationTaskId,
          generationTask: existingGenerationTask,
          wait: existingWait,
          reason: existingGenerationTask?.error_output || 'plan generation task is waiting on file-lock contention',
        });
      }
    }

    // heartbeat_minutes: 0 disables periodic heartbeat returns — we want
    // handleAwaitTask to block until the task is truly terminal, not yield
    // at 5 minutes for a status snapshot we'd misinterpret as failure.
    const awaitResult = await handleAwaitTask({
      task_id: generationTaskId,
      timeout_minutes: planGenerationTimeoutMinutes,
      heartbeat_minutes: 0,
      auto_resubmit_on_restart: true,
    });
    const resolvedGeneration = resolveTaskReplacementChain(taskCore, generationTaskId);
    if (resolvedGeneration.replaced) {
      generationTaskId = resolvedGeneration.taskId;
      persistPlanGenerationTaskReplacement(targetItem, generationTaskId);
    }
    const generationTask = resolvedGeneration.task;
    if (!generationTask || generationTask.status !== 'completed') {
      const wait = getPlanGenerationWait(generationTask, extractTextContent(awaitResult));
      if (isPlanGenerationTaskPending(generationTask) && wait) {
        return buildPlanGenerationDeferredResult({
          project,
          instance,
          targetItem,
          planPath,
          generationTaskId,
          generationTask,
          wait,
          reason: generationTask?.error_output || extractTextContent(awaitResult),
        });
      }
      throw new Error(
        generationTask?.error_output
        || extractTextContent(awaitResult)
        || `plan generation task ${generationTaskId} did not complete successfully`
      );
    }
    const generationProvider = normalizeOptionalString(generationTask.provider)
      || getStoredPlanGeneratorProvider(targetItem);
    const generationLabel = getPlanGeneratorLabel(generationProvider);

    const rawPlanMarkdown = extractTextContent(generationTask.output) || extractTextContent(awaitResult);
    let normalizedPlanMarkdown = normalizeAutoGeneratedPlanMarkdown(rawPlanMarkdown, targetItem, project);
    if (!normalizedPlanMarkdown) {
      throw new Error('generated plan output did not contain any "## Task N:" sections');
    }

    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, normalizedPlanMarkdown);

    let updatedWorkItem = factoryIntake.updateWorkItem(targetItem.id, {
      origin_json: clearPlanGenerationWaitFields(nextOrigin),
      status: 'executing',
    });
    if (generationProvider) {
      updatedWorkItem = factoryIntake.updateWorkItem(updatedWorkItem.id, {
        origin_json: {
          ...getWorkItemOriginObject(updatedWorkItem),
          plan_generator_provider: generationProvider,
        },
      });
    }
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
      reasoning: `generated plan via ${generationLabel} for non-plan-file work item`,
      inputs: {
        ...getWorkItemDecisionContext(targetItem),
      },
      outcome: {
        work_item_id: updatedWorkItem.id,
        plan_path: planPath,
        generator: generationLabel,
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
          generator: generationLabel,
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
        generator: generationLabel,
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
          generator: generationLabel,
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
          projectConfig: getProjectConfigForPlanGate(project),
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
            timeout_minutes: planGenerationTimeoutMinutes,
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
          await handleAwaitTask({
            task_id: reTaskId,
            timeout_minutes: planGenerationTimeoutMinutes,
            heartbeat_minutes: 0,
          });
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
            generator: getPlanGeneratorLabel(getStoredPlanGeneratorProvider(updatedWorkItem)),
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
            projectConfig: getProjectConfigForPlanGate(project),
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
            generator: generationLabel,
            generation_task_id: generationTaskId,
          },
        };
      }
    }

    return {
      reason: `generated plan via ${generationLabel}`,
      work_item: updatedWorkItem,
      stage_result: {
        plan_path: planPath,
        generator: generationLabel,
        generation_task_id: generationTaskId,
      },
    };
  } catch (error) {
    const generationTask = getPlanGenerationTask(taskCore, generationTaskId);
    const wait = getPlanGenerationWait(generationTask, error.message);
    if (generationTaskId && isPlanGenerationTaskPending(generationTask) && wait) {
      return buildPlanGenerationDeferredResult({
        project,
        instance,
        targetItem,
        planPath,
        generationTaskId,
        generationTask,
        wait,
        reason: error.message,
      });
    }
    if (
      generationTaskId
      && generationTask?.status === 'completed'
      && /generated plan output did not contain any "## Task N:" sections/i.test(error.message || '')
      && getPlanGenerationRetryCount(targetItem) < PLAN_GENERATION_UNUSABLE_OUTPUT_RETRIES
    ) {
      return buildPlanGenerationRetryResult({
        project,
        instance,
        targetItem,
        planPath,
        generationTaskId,
        error,
      });
    }

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
        generator: PLAN_GENERATOR_LABEL,
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

function getExecutePlanStageForTransition() {
  return module.exports?._internalForTests?.executePlanStage || executePlanStage;
}

async function handlePrioritizeTransition({ project, instance, currentState }) {
  let stageResult = null;
  let transitionReason = null;
  let transitionWorkItem = tryGetSelectedWorkItem(instance, project.id) || null;

  const prioritizeStage = await executePrioritizeStage(project, instance, transitionWorkItem);
  transitionWorkItem = prioritizeStage?.work_item || transitionWorkItem;
  stageResult = prioritizeStage?.stage_result || null;
  transitionReason = prioritizeStage?.reason || null;

  if (!prioritizeStage?.work_item) {
    const consecutiveEmptyCycles = incrementConsecutiveEmptyCycles(project);
    const nextState = consecutiveEmptyCycles >= STARVATION_THRESHOLD
      ? LOOP_STATES.STARVED
      : LOOP_STATES.IDLE;
    const updatedInstance = nextState === LOOP_STATES.IDLE
      ? terminateInstanceAndSync(instance.id)
      : updateInstanceAndSync(instance.id, {
          loop_state: nextState,
          paused_at_stage: null,
          last_action_at: nowIso(),
        });
    if (nextState === LOOP_STATES.IDLE) {
      recordFactoryIdleIfExhausted(project.id, {
        last_action_at: updatedInstance.last_action_at || null,
        reason: 'no_open_work_item',
      });
    }
    const action = nextState === LOOP_STATES.STARVED
      ? 'entered_starved'
      : 'short_circuit_to_idle';
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.PRIORITIZE,
      action,
      reasoning: nextState === LOOP_STATES.STARVED
        ? 'PRIORITIZE repeatedly returned no work item; entering STARVED until recovery scouts replenish intake'
        : 'PRIORITIZE returned no work item; skipping PLAN and architect cycle',
      outcome: {
        reason: 'no_open_work_item',
        from_state: currentState,
        to_state: nextState,
        consecutive_empty_cycles: consecutiveEmptyCycles,
        threshold: STARVATION_THRESHOLD,
        suggested_actions: nextState === LOOP_STATES.STARVED
          ? ['run_starvation_recovery_scout', 'inspect_plans_dir', 'add_factory_work_item']
          : [],
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, null, null, updatedInstance),
    });
    return {
      instance: updatedInstance,
      transitionWorkItem: null,
      stageResult,
      transitionReason: 'no_open_work_item',
      nextState,
    };
  }

  setConsecutiveEmptyCycles(project.id, 0);
  instance = getInstanceOrThrow(instance.id);

  // Codex Fallback Phase 1 — consult the breaker + project policy before
  // we advance to PLAN. If the breaker is open and the project policy is
  // `wait_for_codex`, park the work item and skip the PLAN advance for
  // this cycle. The park-resume handler (event-bus listener for
  // `circuit:recovered`) will flip parked items back to `pending` once
  // Codex recovers; the next PRIORITIZE tick will re-pick the work.
  // 'auto' / 'manual' policies fall through to the existing PLAN path
  // (Phase 2 will wire actual provider rerouting for 'auto').
  if (transitionWorkItem) {
    let breaker = null;
    try {
      const container = require('../container').defaultContainer;
      if (container && typeof container.has === 'function' && container.has('circuitBreaker')) {
        breaker = container.get('circuitBreaker');
      }
    } catch (_e) { void _e; /* container unavailable — treat as breaker-closed */ }

    const codexDecision = decideCodexFallbackAction({
      db: database.getDbInstance(),
      projectId: project.id,
      workItemId: transitionWorkItem.id,
      breaker,
    });

    if (codexDecision.action === 'park') {
      // Codex Fallback Phase 3 — before parking, probe whether decomposition
      // could yield free-eligible sub-items. Log the finding so operators can
      // see "this item WOULD have decomposed into N free sub-tasks" without
      // actually materialising sub-item rows (deferred to Phase 4).
      try {
        let parkProjectConfig = {};
        try { parkProjectConfig = project?.config_json ? JSON.parse(project.config_json) : {}; } catch (_e) { void _e; }
        const decomposeResult = decomposeBeforePark({
          db: database.getDbInstance(),
          projectId: project.id,
          workItem: transitionWorkItem,
          projectConfig: parkProjectConfig,
        });
        if (decomposeResult.decomposed && decomposeResult.eligibleCount > 0) {
          safeLogDecision({
            project_id: project.id,
            stage: LOOP_STATES.PRIORITIZE,
            actor: 'codex_fallback',
            action: 'decompose_would_yield_eligible',
            reasoning: `Item ${transitionWorkItem.id} could decompose into ${decomposeResult.eligibleCount}/${decomposeResult.subtaskCount} free-eligible sub-items; parking original (sub-item creation deferred).`,
            outcome: { work_item_id: transitionWorkItem.id, ...decomposeResult },
            confidence: 0.9,
            batch_id: getDecisionBatchId(project, transitionWorkItem, null, instance),
          });
        }
      } catch (_decompErr) { void _decompErr; }

      try {
        const { parkWorkItemForCodex } = require('../db/factory-intake');
        parkWorkItemForCodex({
          db: database.getDbInstance(),
          workItemId: transitionWorkItem.id,
          reason: codexDecision.reason,
        });
      } catch (parkError) {
        logger.warn('Failed to park work item for codex fallback', {
          err: parkError.message,
          project_id: project.id,
          work_item_id: transitionWorkItem.id,
        });
      }
      // Drop the loop's hold on the now-parked item so a future tick
      // picks fresh work without reusing the parked id.
      try {
        clearSelectedWorkItem(instance.id);
        instance = updateInstanceAndSync(instance.id, {
          work_item_id: null,
          last_action_at: nowIso(),
        });
      } catch (_e) { void _e; }
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.PRIORITIZE,
        actor: 'codex_fallback',
        action: 'parked_codex_unavailable',
        reasoning: `Codex unavailable and project policy=wait_for_codex; parking item ${transitionWorkItem.id}`,
        outcome: {
          work_item_id: transitionWorkItem.id,
          reason: codexDecision.reason,
        },
        confidence: 1,
        batch_id: getDecisionBatchId(project, transitionWorkItem, null, instance),
      });
      return {
        instance,
        transitionWorkItem: null,
        stageResult,
        transitionReason: 'parked_codex_unavailable',
        nextState: getCurrentLoopState(instance),
      };
    }
    if (codexDecision.action === 'proceed_with_fallback') {
      // Codex Fallback Phase 2 — Codex is unavailable but project policy
      // is 'auto'. Mark the loop instance so the EXECUTE submit path
      // (Task 7) routes the next task through the 'codex-down-failover'
      // routing template instead of the system default. The marker lives
      // in module-memory (`instancesPendingFallbackRouting`); see the
      // declaration block for the rationale on choosing in-memory over
      // a DB column or per-task arg propagation. We still fall through
      // to the existing PLAN advance — only the routing changes.
      markInstanceFallbackRouting(instance.id);
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.PRIORITIZE,
        actor: 'codex_fallback',
        action: 'marked_for_failover_routing',
        reasoning:
          `Codex breaker open and project policy=auto; marking instance ${instance.id} so EXECUTE uses codex-down-failover chain for work item ${transitionWorkItem.id}`,
        outcome: {
          work_item_id: transitionWorkItem.id,
          instance_id: instance.id,
          fallback_template: 'codex-down-failover',
        },
        confidence: 1,
        batch_id: getDecisionBatchId(project, transitionWorkItem, null, instance),
      });
    }
    // 'proceed' falls through to PLAN with normal routing.
  }

  const enterPlan = tryMoveInstanceToStage(instance, LOOP_STATES.PLAN, {
    work_item_id: transitionWorkItem?.id ?? instance.work_item_id,
  });
  if (enterPlan.blocked) {
    instance = enterPlan.instance;
    return {
      instance,
      transitionWorkItem,
      stageResult,
      transitionReason: 'stage_occupied',
      nextState: getCurrentLoopState(instance),
    };
  }

  instance = enterPlan.instance;
  const planStage = await getExecutePlanStageForTransition()(project, instance, transitionWorkItem);
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

  return {
    instance,
    transitionWorkItem,
    stageResult,
    transitionReason,
    nextState: getCurrentLoopState(instance),
  };
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
  // EXECUTE can be entered directly after restart, deferred approval, or
  // recovery. Re-run the pre-written plan gate here before any worktree is
  // created so legacy/resumed plan files cannot start tasks and only then be
  // rejected by PLAN on a later loop.
  try {
    const planQualityGate = require('./plan-quality-gate');
    const planText = fs.readFileSync(targetItem.origin.plan_path, 'utf8');
    const gateVerdict = await planQualityGate.evaluatePlan({
      plan: planText,
      workItem: targetItem,
      project,
      projectConfig: getProjectConfigForPlanGate(project),
    });
    if (gateVerdict && !gateVerdict.passed) {
      const failedRules = gateVerdict.hardFails.map((h) => h.rule);
      try {
        factoryIntake.rejectWorkItemUnactionable(
          targetItem.id,
          'pre_written_plan_rejected_by_quality_gate',
        );
      } catch (rejectErr) {
        logger.warn('execute pre-written plan rejection failed; loop may re-enter', {
          project_id: project.id,
          work_item_id: targetItem.id,
          err: rejectErr.message,
        });
      }
      logger.warn('EXECUTE stage: pre-written plan rejected by quality gate before worktree creation', {
        project_id: project.id,
        work_item_id: targetItem.id,
        plan_path: targetItem.origin.plan_path,
        rules: failedRules,
      });
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'pre_written_plan_quality_rejected_before_execute',
        reasoning: `Pre-written plan failed quality gate before EXECUTE worktree creation: ${failedRules.join(', ')}.`,
        inputs: {
          ...getWorkItemDecisionContext(targetItem),
          plan_path: targetItem.origin.plan_path,
        },
        outcome: {
          gate_only_evaluated: true,
          rule_violations: gateVerdict.hardFails,
          plan_path: targetItem.origin.plan_path,
          ...getWorkItemDecisionContext(targetItem),
        },
        confidence: 1,
        batch_id: executeLogBatchId,
      });
      return {
        next_state: LOOP_STATES.IDLE,
        stop_execution: true,
        reason: 'pre-written plan rejected by quality gate',
        work_item: factoryIntake.getWorkItem(targetItem.id) || targetItem,
        stage_result: {
          status: 'rejected',
          reason: 'pre_written_plan_rejected_by_quality_gate',
          work_item_id: targetItem.id,
          plan_path: targetItem.origin.plan_path,
          rule_violations: failedRules,
        },
      };
    }
  } catch (err) {
    logger.warn('execute pre-written plan-quality-gate evaluation failed; proceeding (fail-open)', {
      project_id: project.id,
      work_item_id: targetItem.id,
      plan_path: targetItem.origin.plan_path,
      err: err.message,
    });
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'plan_quality_gate_fail_open',
      reasoning: `Execute pre-written plan gate threw: ${err.message}`,
      outcome: {
        work_item_id: targetItem.id,
        plan_path: targetItem.origin.plan_path,
      },
      confidence: 1,
      batch_id: executeLogBatchId,
    });
  }
  const resumedDeferredExecute = project.status !== 'paused'
    ? getLatestExecutePausedDeferral({
      project_id: project.id,
      batch_id: executeLogBatchId,
      work_item_id: targetItem.id,
    })
    : null;
  if (resumedDeferredExecute) {
    logExecuteDeferredResume({
      project,
      instance,
      workItem: targetItem,
      batchId: executeLogBatchId,
      deferral: resumedDeferredExecute,
    });
    maybeWarnStaleExecuteDeferral({
      project,
      instance,
      workItem: targetItem,
      batchId: executeLogBatchId,
      deferral: resumedDeferredExecute,
    });

    // Bug D-extension: when resuming a deferred EXECUTE batch (e.g. after
    // a project pause/restart) the loop bypasses PLAN entirely, so the
    // plan-quality-gate that the executePlanStage Bug D fix runs is never
    // exercised on these items. Items that were approved under the older
    // gate rule-set (or by an architect prior to the gate existing) get
    // stuck looping EXECUTE → governance-reject → reclaim → EXECUTE
    // (observed live this session on SpudgetBooks items 455, 458, 711, 764).
    // Re-evaluate the persisted plan file here so legacy items get the same
    // quality bar as freshly-planned ones, and bail out of EXECUTE if it
    // would now be rejected.
    const planQualityGateResume = require('./plan-quality-gate');
    let resumeGateVerdict = null;
    try {
      const planText = fs.readFileSync(targetItem.origin.plan_path, 'utf8');
      resumeGateVerdict = await planQualityGateResume.evaluatePlan({
        plan: planText,
        workItem: targetItem,
        project,
        projectConfig: getProjectConfigForPlanGate(project),
      });
    } catch (err) {
      logger.warn('resume-deferred plan-quality-gate evaluation failed; proceeding (fail-open)', {
        project_id: project.id,
        work_item_id: targetItem.id,
        plan_path: targetItem.origin.plan_path,
        err: err.message,
      });
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'plan_quality_gate_fail_open',
        reasoning: `Resume-deferred plan gate threw: ${err.message}`,
        outcome: {
          work_item_id: targetItem.id,
          plan_path: targetItem.origin.plan_path,
        },
        confidence: 1,
        batch_id: executeLogBatchId,
      });
    }
    if (resumeGateVerdict && !resumeGateVerdict.passed) {
      const failedRules = resumeGateVerdict.hardFails.map((h) => h.rule);
      try {
        factoryIntake.rejectWorkItemUnactionable(
          targetItem.id,
          'pre_written_plan_rejected_by_quality_gate',
        );
      } catch (rejectErr) {
        // Don't swallow silently — if rejection fails (DB lock, REJECT_REASONS
        // gap, etc.) the work item stays in_progress and we'd loop again.
        logger.warn('resume-deferred work-item rejection failed; loop may re-enter', {
          project_id: project.id,
          work_item_id: targetItem.id,
          err: rejectErr.message,
        });
      }
      logger.warn('EXECUTE stage: resumed deferred plan rejected by quality gate', {
        project_id: project.id,
        work_item_id: targetItem.id,
        plan_path: targetItem.origin.plan_path,
        rules: failedRules,
      });
      safeLogDecision({
        project_id: project.id,
        stage: LOOP_STATES.EXECUTE,
        action: 'resumed_plan_quality_rejected',
        reasoning: `Resumed deferred plan failed quality gate on re-evaluation: ${failedRules.join(', ')}.`,
        inputs: {
          ...getWorkItemDecisionContext(targetItem),
          plan_path: targetItem.origin.plan_path,
        },
        outcome: {
          rule_violations: resumeGateVerdict.hardFails,
          plan_path: targetItem.origin.plan_path,
          ...getWorkItemDecisionContext(targetItem),
        },
        confidence: 1,
        batch_id: executeLogBatchId,
      });
      return {
        next_state: LOOP_STATES.IDLE,
        stop_execution: true,
        stage_result: {
          status: 'rejected',
          reason: 'pre_written_plan_rejected_by_quality_gate',
          work_item_id: targetItem.id,
          plan_path: targetItem.origin.plan_path,
          rule_violations: failedRules,
        },
      };
    }
  }

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
  if (worktreeRunner && resumedDeferredExecute) {
    try {
      const activeWorktree = factoryWorktrees.getActiveWorktreeByBatch(executeLogBatchId);
      if (activeWorktree?.worktreePath && fs.existsSync(activeWorktree.worktreePath)) {
        worktreeRecord = activeWorktree;
        executionWorkingDirectory = activeWorktree.worktreePath;
        safeLogDecision({
          project_id: project.id,
          stage: LOOP_STATES.EXECUTE,
          action: 'execute_deferred_worktree_reused',
          reasoning: 'Reusing the active batch worktree for a resumed deferred EXECUTE batch.',
          inputs: {
            ...getWorkItemDecisionContext(targetItem),
            deferral_decision_id: resumedDeferredExecute.id,
          },
          outcome: {
            factory_worktree_id: activeWorktree.id,
            worktree_id: activeWorktree.vcWorktreeId,
            worktree_path: activeWorktree.worktreePath,
            branch: activeWorktree.branch,
            batch_id: executeLogBatchId,
          },
          confidence: 1,
          batch_id: executeLogBatchId,
        });
      } else if (activeWorktree) {
        logger.warn('EXECUTE stage: deferred batch worktree missing on disk; creating a fresh worktree', {
          project_id: project.id,
          work_item_id: targetItem.id,
          batch_id: executeLogBatchId,
          factory_worktree_id: activeWorktree.id,
          worktree_path: activeWorktree.worktreePath || null,
        });
      }
    } catch (error) {
      logger.debug('EXECUTE stage: deferred worktree lookup failed', {
        project_id: project.id,
        work_item_id: targetItem.id,
        batch_id: executeLogBatchId,
        err: error.message,
      });
    }
  }
  if (worktreeRunner && !worktreeRecord) {
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
        let owning = null;
        let owningStatus = null;
        try {
          if (stale.owningTaskId) {
            const taskCore = require('../db/task-core');
            owning = taskCore.getTask(stale.owningTaskId);
            owningStatus = owning?.status || null;
          }
        } catch (ownershipErr) {
          logger.warn('factory worktree: owning-task lookup failed before reclaim guard', {
            stale_factory_worktree_id: stale.id,
            owning_task_id: stale.owningTaskId || null,
            err: ownershipErr && ownershipErr.message,
          });
        }
        let reclaimGraceMs = 10 * 60 * 1000;
        try {
          const cfg = project?.config_json ? JSON.parse(project.config_json) : {};
          const configuredMs = Number(cfg.worktree_reclaim_grace_ms);
          const configuredMinutes = Number(cfg.worktree_reclaim_grace_minutes);
          if (Number.isFinite(configuredMs) && configuredMs > 0) {
            reclaimGraceMs = configuredMs;
          } else if (Number.isFinite(configuredMinutes) && configuredMinutes > 0) {
            reclaimGraceMs = configuredMinutes * 60 * 1000;
          }
        } catch (_cfgErr) {
          void _cfgErr;
        }
        const staleAgeMs = elapsedMsSince(stale.created_at || stale.createdAt);
        const ownerAgeMs = getTaskAgeMs(owning);
        const staleWorktreePath = stale.worktreePath || stale.worktree_path || null;
        const dirtyStatus = getWorktreeDirtyStatus(staleWorktreePath);
        const withinReclaimGrace = staleAgeMs === null || staleAgeMs < reclaimGraceMs;
        const ownerWithinReclaimGrace = ownerAgeMs === null || ownerAgeMs < reclaimGraceMs;
        if (
          owning
          && LIVE_WORKTREE_OWNER_STATUSES.has(owningStatus)
          && (withinReclaimGrace || ownerWithinReclaimGrace || dirtyStatus.dirty)
        ) {
          logger.info('factory worktree: skipping pre-reclaim for fresh live owner', {
            project_id: project.id,
            work_item_id: targetItem.id,
            branch: targetBranch,
            stale_factory_worktree_id: stale.id,
            stale_batch_id: stale.batch_id,
            owning_task_id: stale.owningTaskId,
            owning_status: owningStatus,
            stale_age_ms: staleAgeMs,
            owner_age_ms: ownerAgeMs,
            reclaim_grace_ms: reclaimGraceMs,
            worktree_dirty: dirtyStatus.dirty,
            worktree_dirty_checked: dirtyStatus.checked,
          });
          safeLogDecision({
            project_id: project.id,
            stage: LOOP_STATES.EXECUTE,
            action: 'worktree_reclaim_skipped_live_owner',
            reasoning: dirtyStatus.dirty
              ? 'Skipped pre-reclaim because the branch is still owned by a live task with dirty worktree changes.'
              : 'Skipped pre-reclaim because the branch is still owned by a recent live task.',
            inputs: { ...getWorkItemDecisionContext(targetItem) },
            outcome: {
              stale_factory_worktree_id: stale.id,
              stale_batch_id: stale.batch_id,
              branch: targetBranch,
              owning_task_id: stale.owningTaskId,
              owning_status: owningStatus,
              stale_age_ms: staleAgeMs,
              owner_age_ms: ownerAgeMs,
              reclaim_grace_ms: reclaimGraceMs,
              worktree_dirty: dirtyStatus.dirty,
              worktree_dirty_checked: dirtyStatus.checked,
              worktree_dirty_check_reason: dirtyStatus.reason || null,
            },
            confidence: 1,
            batch_id: executeLogBatchId,
          });
          return {
            reason: 'active worktree owner still running',
            work_item: targetItem,
            stop_execution: true,
            next_state: LOOP_STATES.EXECUTE,
            stage_result: {
              status: 'waiting',
              reason: 'active_worktree_owner_running',
              factory_worktree_id: stale.id,
              owning_task_id: stale.owningTaskId,
              owning_status: owningStatus,
              stale_age_ms: staleAgeMs,
              owner_age_ms: ownerAgeMs,
              worktree_dirty: dirtyStatus.dirty,
            },
          };
        }
        if (owning && REUSABLE_WORKTREE_OWNER_STATUSES.has(owningStatus) && staleWorktreePath && fs.existsSync(staleWorktreePath)) {
          worktreeRecord = stale;
          executionWorkingDirectory = staleWorktreePath;
          logger.info('factory worktree: reusing active worktree with completed owner before create', {
            project_id: project.id,
            work_item_id: targetItem.id,
            branch: targetBranch,
            factory_worktree_id: stale.id,
            owning_task_id: stale.owningTaskId,
            owning_status: owningStatus,
            worktree_path: staleWorktreePath,
          });
          safeLogDecision({
            project_id: project.id,
            stage: LOOP_STATES.EXECUTE,
            action: 'worktree_reused_completed_owner',
            reasoning: 'Reused the active factory worktree because its owning task completed; reclaiming here would discard completed task output.',
            inputs: { ...getWorkItemDecisionContext(targetItem) },
            outcome: {
              factory_worktree_id: stale.id,
              stale_batch_id: stale.batch_id,
              branch: targetBranch,
              owning_task_id: stale.owningTaskId,
              owning_status: owningStatus,
              worktree_path: staleWorktreePath,
            },
            confidence: 1,
            batch_id: executeLogBatchId,
          });
        }
        if (!worktreeRecord) logger.warn('factory worktree: pre-reclaiming stale active row before create', {
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
        if (!worktreeRecord && stale.owningTaskId) {
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
              const latestOwner = taskCore.getTask(stale.owningTaskId);
              if (latestOwner && !['completed', 'failed', 'cancelled', 'skipped'].includes(latestOwner.status)) {
                const retryCount = Number(latestOwner.retry_count || 0);
                const maxRetries = Number(
                  latestOwner.max_retries != null ? latestOwner.max_retries : 2,
                );
                if (retryCount < maxRetries) {
                  taskCore.updateTaskStatus(stale.owningTaskId, 'queued', {
                    error_output: `Task requeued for reclaim cleanup retry (attempt ${retryCount + 1}/${maxRetries})`,
                    retry_count: retryCount + 1,
                    mcp_instance_id: null,
                    provider: null,
                    ollama_host_id: null,
                  });
                } else {
                  taskCore.updateTaskStatus(stale.owningTaskId, 'failed', {
                    error_output: `Task could not be reclaimed for worktree ownership cleanup (attempt ${retryCount}/${maxRetries})`,
                    completed_at: new Date().toISOString(),
                  });
                }
              }
            }
          } catch (ownershipErr) {
            logger.warn('factory worktree: owning-task check failed; proceeding with reclaim', {
              stale_factory_worktree_id: stale.id,
              err: ownershipErr && ownershipErr.message,
            });
          }
        }
        if (!worktreeRecord) factoryWorktrees.markAbandoned(stale.id, 'pre_reclaim_before_create');
        if (!worktreeRecord && typeof worktreeRunner.abandon === 'function' && stale.vcWorktreeId) {
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
        if (!worktreeRecord) safeLogDecision({
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

      if (!worktreeRecord) {
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
          base_branch: createdWorktree.baseBranch || createdWorktree.base_branch || null,
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
      }
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

      const pausedDeferral = deferExecutePlanTaskIfProjectPaused({
        project_id: project.id,
        batch_id: executeDecisionBatchId,
        workItem: targetItem,
        planPath: args.plan_path,
        planTaskNumber: args.plan_task_number,
        planTaskTitle: args.plan_task_title,
      });
      if (pausedDeferral) {
        throw new ExecuteDeferredPausedError(pausedDeferral);
      }

      const result = await handleSmartSubmitTask({
        ...args,
        tags: [...new Set(tags)],
        task_metadata: {
          ...buildProviderLaneTaskMetadata(project || {}),
          ...(args.task_metadata || {}),
        },
      });
      // smart_submit_task may auto-decompose a complex task into a sequenced
      // workflow when the target file is large enough (see routing.js
      // GUIDED_FILE_THRESHOLD path). In that case the result has no top-level
      // task_id but does have workflow_id + task_ids — the subtasks form a
      // dependency chain (each depends on the previous), so awaiting the
      // terminal subtask awaits the whole chain. Without this branch the
      // executor previously threw the success-payload markdown as an
      // execute_exception and the factory paused at EXECUTE.
      let trackedTaskId = result?.task_id || null;
      if (!trackedTaskId && result?.workflow_id && Array.isArray(result.task_ids) && result.task_ids.length > 0) {
        trackedTaskId = result.task_ids[result.task_ids.length - 1];
        logger.info('factory submit: smart_submit_task auto-decomposed into workflow', {
          workflow_id: result.workflow_id,
          subtask_count: result.task_ids.length,
          terminal_task_id: trackedTaskId,
        });
      }
      if (!trackedTaskId) {
        throw new Error(result?.content?.[0]?.text || 'smart_submit_task did not return task_id');
      }
      // Record the task as the worktree's current owner so the pre-reclaim
      // flow can cancel it before trying to clean up the directory. Only
      // applies when a factory worktree is active (non-worktree executions
      // fall through without owner tracking).
      if (worktreeRecord && worktreeRecord.id) {
        try {
          factoryWorktrees.setOwningTask(worktreeRecord.id, trackedTaskId);
        } catch (ownErr) {
          logger.warn('factory worktree: setOwningTask failed', {
            factory_worktree_id: worktreeRecord.id,
            task_id: trackedTaskId,
            err: ownErr && ownErr.message,
          });
        }
      }
      return { task_id: trackedTaskId };
    },
    awaitTask: (args) => awaitTaskToStructuredResult(handleAwaitTask, taskCore, args),
    findReusableTask: async (args) => findExistingPlanTaskSubmission(taskCore, {
      projectName: project.name,
      workingDirectory: executionWorkingDirectory || project.path || process.cwd(),
      workItemId: targetItem.id,
      planTaskNumber: args.task?.task_number ?? args.plan_task_number,
      batchId: submissionBatchId,
    }),
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
    if (execErr?.code === 'FACTORY_EXECUTE_DEFERRED_PAUSED') {
      logger.info('EXECUTE stage: project paused before next plan task submission', {
        project_id: project.id,
        work_item_id: targetItem.id,
        batch_id: execErr.batch_id || executeDecisionBatchId,
        remaining_plan_task_number: execErr.remaining_plan_task_number ?? null,
      });
      return {
        next_state: LOOP_STATES.EXECUTE,
        paused_at_stage: null,
        reason: 'execute_deferred_paused',
        stage_result: {
          status: 'deferred',
          reason: 'project_paused',
          work_item_id: execErr.work_item_id ?? targetItem.id,
          plan_path: execErr.plan_path || planPathForExecutor,
          plan_task_number: execErr.plan_task_number ?? null,
          remaining_plan_task_number: execErr.remaining_plan_task_number ?? null,
          batch_id: execErr.batch_id || executeDecisionBatchId,
        },
        work_item: targetItem,
      };
    }

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
    // Phase P (2026-04-30): when the executor surfaces a violation
    // (Phase N's task_targets_missing_files, the heavy-validation guard,
    // future violations), use the violation rule as the reject_reason so
    // replan-recovery can route to a failure-mode-specific strategy
    // instead of falling through to the generic task_N_failed bucket
    // (which routes to rejected-recovery and just retries the same plan).
    const violationRule = result.violation && typeof result.violation.rule === 'string'
      ? result.violation.rule.trim()
      : null;
    const rejectReason = violationRule
      ? `${violationRule}: task_${result.failed_task}`
      : `task_${result.failed_task}_failed`;
    factoryIntake.updateWorkItem(targetItem.id, {
      status: 'in_progress',
      reject_reason: rejectReason,
    });
    logger.warn('EXECUTE stage: plan executor stopped on failed task', {
      project_id: project.id,
      work_item_id: targetItem.id,
      failed_task: result.failed_task,
      violation_rule: violationRule,
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

function isMergeTargetOperatorBlockedError(err) {
  return Boolean(err && (
    err.code === 'IN_PROGRESS_GIT_OPERATION'
    || err.code === 'MAIN_REPO_SEMANTIC_DRIFT'
  ));
}

function stripAnsi(text) {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return typeof text === 'string'
    ? text.replace(ansiPattern, '')
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

const VERIFY_RETRY_SCOPE_PATH_RE = /[A-Za-z0-9_./\\-]+\.(?:csproj|fsproj|vbproj|targets|props|tsx|jsx|cjs|mjs|yaml|yml|json|sql|xaml|axaml|xml|resx|psm1|ps1|sln|js|ts|py|cs|sh|md)/g;

function normalizeScopeEnvelopePath(filePath) {
  return String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
}

function extractScopeEnvelopeFiles(text) {
  const files = new Set();
  for (const match of String(text || '').matchAll(VERIFY_RETRY_SCOPE_PATH_RE)) {
    const normalized = normalizeScopeEnvelopePath(match[0]);
    if (normalized) {
      files.add(normalized);
    }
  }
  return Array.from(files);
}

function computeScopeEnvelope(planText, verifyOutput) {
  return new Set([
    ...extractScopeEnvelopeFiles(planText),
    ...extractScopeEnvelopeFiles(verifyOutput),
  ]);
}

function getScopeEnvelopeBasenames(scopeEnvelope) {
  const suffixes = new Set();
  for (const file of scopeEnvelope || []) {
    const normalized = normalizeScopeEnvelopePath(file);
    if (!normalized) continue;
    suffixes.add(normalized);

    const withoutRoot = normalized
      .replace(/^[A-Za-z]:\//, '')
      .replace(/^\/+/, '');
    if (withoutRoot) {
      suffixes.add(withoutRoot);
    }

    const basename = withoutRoot.split('/').filter(Boolean).pop();
    if (basename) {
      suffixes.add(basename);
    }
  }
  return Array.from(suffixes);
}

function isOutOfScope(diffFiles, scopeEnvelope) {
  const scopeEnvelopeBasenames = getScopeEnvelopeBasenames(scopeEnvelope);
  return (Array.isArray(diffFiles) ? diffFiles : []).filter((file) => {
    const normalized = normalizeScopeEnvelopePath(file);
    return normalized && !scopeEnvelopeBasenames.some((sb) => normalized.endsWith(sb));
  });
}

async function getVerifyRetryDiffFiles(workingDirectory) {
  if (!workingDirectory) return [];
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      resolve(files);
    };

    let child;
    try {
      child = childProcess.spawn('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
        cwd: workingDirectory,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (_e) {
      finish([]);
      return;
    }

    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.on('error', () => finish([]));
    child.on('close', (code) => {
      if (code !== 0) return finish([]);
      finish(stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0));
    });
  });
}

function readPlanTextForScopeEnvelope(planPath, scopedLogger = logger) {
  if (!planPath) {
    scopedLogger?.debug?.({ plan_path: null }, 'verify retry scope envelope: no plan path; plan envelope empty');
    return '';
  }

  try {
    return fs.readFileSync(planPath, 'utf8');
  } catch (err) {
    scopedLogger?.debug?.(
      { err: err && err.message, plan_path: planPath },
      'verify retry scope envelope: unable to read plan file; plan envelope empty'
    );
    return '';
  }
}

async function enforceVerifyRetryScopeEnvelope({
  project_id,
  batch_id,
  workItemId,
  planPath,
  verifyOutput,
  worktreePath,
  attempt,
  branch,
  getDiffFiles = getVerifyRetryDiffFiles,
  logDecisionFn = safeLogDecision,
  rejectWorkItemUnactionableFn = factoryIntake.rejectWorkItemUnactionable,
  scopedLogger = logger,
}) {
  const planText = readPlanTextForScopeEnvelope(planPath, scopedLogger);
  const scopeEnvelope = computeScopeEnvelope(planText, verifyOutput);
  let diffFiles = [];

  try {
    diffFiles = await getDiffFiles(worktreePath);
  } catch (err) {
    scopedLogger?.debug?.(
      { err: err && err.message, worktree_path: worktreePath },
      'verify retry scope envelope: unable to inspect retry diff; treating as empty diff'
    );
    diffFiles = [];
  }

  const offScopeFiles = isOutOfScope(diffFiles, scopeEnvelope);
  if (offScopeFiles.length === 0) {
    return { ok: true, diffFiles, scopeEnvelope };
  }

  logDecisionFn({
    project_id,
    batch_id,
    stage: LOOP_STATES.VERIFY,
    action: 'retry_off_scope',
    reasoning: 'Verify retry modified files outside the plan and verify stack-trace scope envelope.',
    inputs: { attempt, branch },
    outcome: {
      off_scope_files: offScopeFiles,
      envelope: Array.from(scopeEnvelope),
    },
    confidence: 1,
  });

  if (workItemId !== null && workItemId !== undefined && typeof rejectWorkItemUnactionableFn === 'function') {
    try {
      rejectWorkItemUnactionableFn(workItemId, 'retry_off_scope');
    } catch (err) {
      scopedLogger?.warn?.(
        { err: err && err.message, work_item_id: workItemId },
        'verify retry scope envelope: failed to mark work item unactionable'
      );
    }
  }

  return {
    ok: false,
    reason: 'retry_off_scope',
    diffFiles,
    offScopeFiles,
    scopeEnvelope,
  };
}

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
  // Observability-only path: never let an error here propagate into the
  // EXECUTE -> VERIFY transition. If attempt-history is unreachable
  // (missing schema, closed db, etc.) treat it as "no prior row" and
  // fall through to today's behavior.
  const attemptHistory = require('../db/factory-attempt-history');
  let latest;
  try {
    latest = attemptHistory.getLatestForBatch(batch_id);
  } catch (err) {
    logger.debug('maybeShipNoop: getLatestForBatch threw; treating as no prior row', {
      err: err && err.message, batch_id,
    });
    return { shipped_as_noop: false };
  }
  if (!latest) return { shipped_as_noop: false };

  const reason = latest.zero_diff_reason;
  const conf = latest.classifier_conf == null ? 0 : latest.classifier_conf;

  if (reason === 'already_in_place' && conf >= 0.8) {
    if (!isFactoryFeatureEnabled(project_id, 'auto_ship_noop_enabled')) {
      return { shipped_as_noop: false, reason: 'flag_off' };
    }
    const paused_reason = 'already_in_place_review_required';
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.EXECUTE,
      action: 'paused_at_gate',
      reasoning: 'Codex reported the change was already in place; pausing EXECUTE for operator review instead of skipping VERIFY.',
      outcome: {
        work_item_id,
        paused_stage: 'EXECUTE',
        paused_reason,
        classifier_source: latest.classifier_source,
        classifier_conf: conf,
        stdout_tail_preview: String(latest.stdout_tail || '').slice(0, 400),
      },
      confidence: 1,
    });
    return { shipped_as_noop: false, paused: true, paused_reason };
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

  if (!reason || reason === 'unknown' || conf < 0.8) {
    if (!isFactoryFeatureEnabled(project_id, 'auto_ship_noop_enabled')) {
      return { shipped_as_noop: false, reason: 'flag_off' };
    }
    const paused_reason = conf < 0.8
      ? 'low_confidence_zero_diff_review_required'
      : 'unknown_zero_diff_review_required';
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.EXECUTE,
      action: 'paused_at_gate',
      reasoning: 'Factory could not classify a zero-diff EXECUTE result confidently; pausing for operator review instead of treating the clean branch as progress.',
      outcome: {
        work_item_id,
        paused_stage: 'EXECUTE',
        paused_reason,
        zero_diff_reason: reason || null,
        classifier_source: latest.classifier_source,
        classifier_conf: conf,
        stdout_tail_preview: String(latest.stdout_tail || '').slice(0, 400),
      },
      confidence: 1,
    });
    return { shipped_as_noop: false, paused: true, paused_reason };
  }

  return { shipped_as_noop: false };
}

const ZERO_DIFF_SHORT_CIRCUIT_THRESHOLD = 2;

function countConsecutiveAutoCommitSkippedClean(project_id, batch_id, { limit = 20 } = {}) {
  if (!project_id || !batch_id) return 0;
  const recent = factoryDecisions.listDecisions(project_id, {
    stage: LOOP_STATES.EXECUTE.toLowerCase(),
    limit,
  }) || [];
  let consecutiveClean = 0;
  for (const decision of recent.filter((d) => d.batch_id === batch_id)) {
    if (decision.action !== 'auto_commit_skipped_clean') {
      break;
    }
    consecutiveClean += 1;
  }
  return consecutiveClean;
}

/**
 * Check whether this batch has already produced at least one real commit
 * (auto_committed_task decision). Used by the zero-diff short-circuit to
 * distinguish "work item is unactionable" (no diff was ever produced) from
 * "work item already shipped its diff and subsequent retries are no-ops"
 * (multi-task plan where the first task covered the goal, or a verify-
 * retry that found nothing more to fix).
 *
 * Live evidence 2026-04-29: DLPhone work item #2097's first EXECUTE
 * attempt landed commit 507350f at 22:47:48 (qwen3-coder:30b wrote a
 * real C# test). Two follow-up retries at 22:51:36 and 22:51:47 no-opped
 * because the work was already done, then the zero-diff short-circuit
 * rejected the work item — even though the code had landed cleanly. The
 * factory's bookkeeping treated "retries had no diff" as failure when
 * the truth was "first attempt succeeded so well there was nothing left
 * for retries to do."
 */
function batchHasAutoCommittedTask(project_id, batch_id, { limit = 50 } = {}) {
  if (!project_id || !batch_id) return false;
  const recent = factoryDecisions.listDecisions(project_id, {
    stage: LOOP_STATES.EXECUTE.toLowerCase(),
    limit,
  }) || [];
  return recent.some((d) => d.batch_id === batch_id && d.action === 'auto_committed_task');
}

function maybeShortCircuitZeroDiffExecute({ project, instance, workItem, batchId }) {
  if (!project?.id || !workItem?.id || !batchId) return null;
  const zeroDiffAttempts = countConsecutiveAutoCommitSkippedClean(project.id, batchId);
  if (zeroDiffAttempts < ZERO_DIFF_SHORT_CIRCUIT_THRESHOLD) return null;

  // Phase E (2026-04-29 DLPhone #2097 fix): if the batch already produced a
  // real commit earlier, the no-op retries are benign — the work landed on
  // an earlier attempt and subsequent plan tasks or verify-retries had
  // nothing more to do. Don't reject; signal "EXECUTE done, advance to
  // VERIFY" so the test that was just written gets validated.
  if (batchHasAutoCommittedTask(project.id, batchId)) {
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.EXECUTE,
      action: 'execute_completed_after_no_op_retries',
      reasoning: `Batch produced a real commit earlier (auto_committed_task); ${zeroDiffAttempts} subsequent no-op retries are benign. Advancing to VERIFY instead of rejecting the work item.`,
      inputs: {
        ...getWorkItemDecisionContext(workItem),
        zero_diff_attempts: zeroDiffAttempts,
      },
      outcome: {
        work_item_id: workItem.id,
        instance_id: instance?.id || null,
        zero_diff_attempts: zeroDiffAttempts,
        next_state: LOOP_STATES.VERIFY,
      },
      confidence: 1,
      batch_id: batchId,
    });
    return {
      reason: 'execute_completed_after_no_op_retries',
      work_item: workItem,
      advance_to_verify: true,
      stage_result: {
        status: 'completed',
        reason: 'execute_completed_after_no_op_retries',
        zero_diff_attempts: zeroDiffAttempts,
      },
    };
  }

  let updatedWorkItem = workItem;
  try {
    updatedWorkItem = factoryIntake.rejectWorkItemUnactionable(workItem.id, 'zero_diff_across_retries');
  } catch (err) {
    logger.warn('EXECUTE zero-diff short-circuit: failed to mark work item unactionable', {
      project_id: project.id,
      work_item_id: workItem.id,
      error: err.message,
    });
  }

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.EXECUTE,
    action: 'execute_zero_diff_short_circuit',
    reasoning: `Work item produced ${zeroDiffAttempts} consecutive zero-diff executes; skipping VERIFY and marking it unactionable.`,
    inputs: {
      ...getWorkItemDecisionContext(workItem),
      zero_diff_attempts: zeroDiffAttempts,
    },
    outcome: {
      work_item_id: workItem.id,
      instance_id: instance?.id || null,
      reject_reason: 'zero_diff_across_retries',
      zero_diff_attempts: zeroDiffAttempts,
      next_state: LOOP_STATES.IDLE,
    },
    confidence: 1,
    batch_id: batchId,
  });

  return {
    reason: 'zero_diff_across_retries',
    work_item: updatedWorkItem,
    stage_result: {
      status: 'unactionable',
      reason: 'zero_diff_across_retries',
      zero_diff_attempts: zeroDiffAttempts,
    },
  };
}

async function attemptSilentRerun({
  project_id, batch_id, instance_id,
  priorVerifyOutput, runVerify,
}) {
  const { verifySignature } = require('./verify-signature');
  const instances = require('../db/factory-loop-instances');

  if (!isFactoryFeatureEnabled(project_id, 'verify_silent_rerun_enabled')) {
    return { kind: 'flag_off' };
  }
  // Same defensive posture as maybeShipNoop: never let observability
  // infrastructure errors (closed db, missing column) stop the loop.
  // Any read failure is treated as "budget exhausted" so we fall
  // through to the existing fix-task retry path.
  try {
    if (instances.getVerifySilentReruns(instance_id) > 0) {
      return { kind: 'budget_exhausted' };
    }
  } catch (err) {
    logger.debug('attemptSilentRerun: getVerifySilentReruns threw; skipping silent rerun', {
      err: err && err.message, instance_id,
    });
    return { kind: 'flag_off' };
  }

  instances.bumpVerifySilentReruns(instance_id);

  safeLogDecision({
    project_id, batch_id, stage: LOOP_STATES.VERIFY,
    action: 'verify_silent_rerun_started',
    reasoning: 'Classifier was ambiguous; rerunning verify silently before spending a Codex retry slot.',
    outcome: { instance_id },
    confidence: 1,
  });

  let verifyResult;
  try {
    verifyResult = await runVerify();
  } catch (err) {
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.VERIFY,
      action: 'verify_silent_rerun_failed',
      reasoning: `Silent rerun error: ${err.message}`,
      outcome: { instance_id, error: err.message },
      confidence: 1,
    });
    return { kind: 'rerun_failed', error: err.message };
  }

  if (verifyResult.exitCode === 0) {
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.VERIFY,
      action: 'verify_passed_on_silent_rerun',
      reasoning: 'Silent rerun passed; advancing without spending a Codex retry.',
      outcome: { instance_id },
      confidence: 1,
    });
    return { kind: 'passed', output: verifyResult.output };
  }

  const prevSig = verifySignature(priorVerifyOutput);
  const currSig = verifySignature(verifyResult.output);

  if (prevSig && currSig && prevSig === currSig) {
    safeLogDecision({
      project_id, batch_id, stage: LOOP_STATES.VERIFY,
      action: 'verify_rerun_same_failure',
      reasoning: 'Silent rerun produced the same failure signature; falling through to fix-task retry.',
      outcome: { instance_id, signature: currSig },
      confidence: 1,
    });
    return { kind: 'same_failure', output: verifyResult.output };
  }

  safeLogDecision({
    project_id, batch_id, stage: LOOP_STATES.VERIFY,
    action: 'verify_rerun_different_failure',
    reasoning: 'Silent rerun produced a different failure signature; passing both to the fix task.',
    outcome: { instance_id, prev_sig: prevSig, curr_sig: currSig },
    confidence: 1,
  });
  return {
    kind: 'different_failure',
    output: verifyResult.output,
    combinedOutput: `${priorVerifyOutput}\n---\n${verifyResult.output}`,
  };
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
    'SCOPE ENVELOPE — you MUST obey these file rules:',
    '- Modify ONLY files that appear in either:',
    '    (a) the plan\'s task list (the \'plan file\' block above), OR',
    '    (b) filenames that appear in the verify error stack trace (the \'verify output tail\' above).',
    '- Do NOT create new files unless a new file is explicitly named in the plan.',
    '- If you believe no code fix is warranted (the failing test is broken, the baseline is wrong, or the diff is unrelated), exit with no changes. Do NOT add unrelated refactors, cleanup, or new features.',
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
  // Defensive read — if attempt-history is unreachable, the retry
  // prompt just falls back to today's shape (no prior-attempts block).
  let priorAttempts = [];
  if (workItemIdStr) {
    try {
      priorAttempts = attemptHistory.listByWorkItem(workItemIdStr, { limit: 3 }).reverse();
    } catch (err) {
      logger.debug('submitVerifyFixTask: attempt-history read threw; omitting prior-attempts block', {
        err: err && err.message, work_item_id: workItemIdStr,
      });
    }
  }
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
        // Inject the project's provider_lane_policy so verify auto-retries
        // stay on the project's allowed providers. Without this spread,
        // the smart-routing chain filter has nothing to enforce against
        // and leaks retries to whatever the routing-template default
        // picks. Live evidence 2026-04-29: DLPhone work item #2097's two
        // verify-retry attempts at 22:51:28 and 22:51:41 spawned codex.exe
        // (gpt-5.5) into the project worktree fea-c4b2f75d, even though
        // the original EXECUTE attempt at 22:46:25 ran on ollama per the
        // lane policy. The first retry happened ~3.5 min after the real
        // commit landed, so by the time codex was running, the diff was
        // already done — both retries no-opped (auto_commit_skipped_clean)
        // and tripped the zero_diff short-circuit.
        ...buildProviderLaneTaskMetadata(project || {}),
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
      // Match TERMINAL_TASK_STATUSES from db/task-core.js:
      // completed, failed, cancelled, skipped. Without `skipped` here a
      // workflow whose dependency chain short-circuits (every subtask marked
      // `skipped`) loops forever between paused_at_gate and auto-recovery's
      // retry — seen on DLPhone item #708 where 16 auto-decomposed subtasks
      // all ended in `skipped` and the gate never auto-cleared. `shipped` is
      // a work-item status (CLOSED_WORK_ITEM_STATUSES), not a task status —
      // kept in the list defensively in case a future code path reuses it.
      const nonTerminal = batchTasks.filter(
        (t) => !['completed', 'shipped', 'cancelled', 'failed', 'skipped'].includes(t.status),
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
    // Pull the associated work item so the retry prompt can reference the
    // plan and so VERIFY can honor work-item-specific scoped validation.
    // Best-effort: if we can't resolve it, the retry still runs with less
    // context and falls back to the project verify command.
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
    const resolvedVerify = resolveFactoryVerifyCommand({
      project,
      workItem: workItemForRetry,
    });
    const verifyCommand = resolvedVerify.command;

    let projectConfig = {};
    try {
      projectConfig = project?.config_json ? JSON.parse(project.config_json) : {};
    } catch (_err) {
      projectConfig = {};
    }
    const thresholdValue = Number(projectConfig.stale_branch_commit_threshold);
    const staleBranchCommitThreshold = Number.isFinite(thresholdValue) ? thresholdValue : 0;
    const baseRef = worktreeRecord.base_branch
      || worktreeRecord.baseBranch
      || detectDefaultBranch(worktreeRecord.worktreePath || project?.path || process.cwd())
      || 'main';
    const branchStaleRejectReason = 'branch_stale_vs_base';
    const freshness = await branchFreshness.checkBranchFreshness({
      worktreePath: worktreeRecord.worktreePath,
      branch: worktreeRecord.branch,
      baseRef,
      threshold: staleBranchCommitThreshold,
    });

    if (freshness.stale) {
      safeLogDecision({
        project_id,
        stage: LOOP_STATES.VERIFY,
        action: 'branch_stale_detected',
        reasoning: `Branch ${worktreeRecord.branch} is stale versus ${baseRef}; attempting automatic rebase before VERIFY.`,
        outcome: {
          commits_behind: freshness.commitsBehind,
          stale_files: freshness.staleFiles,
          threshold: staleBranchCommitThreshold,
        },
        confidence: 1,
        batch_id,
      });

      const rebaseResult = await branchFreshness.attemptRebase(
        worktreeRecord.worktreePath,
        worktreeRecord.branch,
        baseRef,
      );
      if (rebaseResult.ok) {
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'branch_auto_rebased',
          reasoning: `Automatically rebased ${worktreeRecord.branch} onto ${baseRef}; proceeding to VERIFY.`,
          outcome: {
            branch: worktreeRecord.branch,
            baseRef,
          },
          confidence: 1,
          batch_id,
        });
      } else {
        if (workItemForRetry && workItemForRetry.id) {
          factoryIntake.rejectWorkItemUnactionable(workItemForRetry.id, branchStaleRejectReason);
        }
        safeLogDecision({
          project_id,
          stage: LOOP_STATES.VERIFY,
          action: 'branch_stale_rebase_conflict',
          reasoning: `Automatic rebase of ${worktreeRecord.branch} onto ${baseRef} failed; marking the work item unactionable so the factory can advance.`,
          outcome: {
            commits_behind: freshness.commitsBehind,
            stale_files: freshness.staleFiles,
            error: rebaseResult.error,
            work_item_id: workItemForRetry?.id || instance?.work_item_id || null,
          },
          confidence: 1,
          batch_id,
        });
        return {
          status: 'unactionable',
          reason: branchStaleRejectReason,
          branch: worktreeRecord.branch,
          worktree_path: worktreeRecord.worktreePath,
        };
      }
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
    let postFailureFreshnessChecked = false;
    // Seed the retry counter from prior verify-retry tasks for this batch.
    // Without this, any re-entry to executeVerifyStage (stall-recovery,
    // VERIFY_FAIL resume, dispatcher re-entry) resets retryAttempt to 0 and
    // the loop cycles retry=1..3 again instead of emitting
    // auto_rejected_verify_fail. The retry tags persisted on task rows are
    // the cross-call source of truth.
    let retryAttempt = countPriorVerifyRetryTasksForBatch(batch_id);
    let submissionFailures = 0;
    try {
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
          baseBranch: baseRef,
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
              verify_command_source: resolvedVerify.source,
              retry_attempt: retryAttempt,
            },
            confidence: 1,
            batch_id,
          });
          break;
        }

        if (!postFailureFreshnessChecked) {
          postFailureFreshnessChecked = true;
          const postFailureFreshness = await branchFreshness.checkBranchFreshness({
            worktreePath: worktreeRecord.worktreePath,
            branch: worktreeRecord.branch,
            baseRef,
            threshold: staleBranchCommitThreshold,
          });

          if (postFailureFreshness.stale) {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'branch_stale_detected_post_verify',
              reasoning: `Branch ${worktreeRecord.branch} became stale versus ${baseRef} during VERIFY; attempting automatic rebase before classifying the failure.`,
              outcome: {
                commits_behind: postFailureFreshness.commitsBehind,
                stale_files: postFailureFreshness.staleFiles,
                threshold: staleBranchCommitThreshold,
              },
              confidence: 1,
              batch_id,
            });

            const postFailureRebase = await branchFreshness.attemptRebase(
              worktreeRecord.worktreePath,
              worktreeRecord.branch,
              baseRef,
            );
            if (postFailureRebase.ok) {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'branch_auto_rebased_post_verify',
                reasoning: `Automatically rebased ${worktreeRecord.branch} onto ${baseRef} after VERIFY drift; re-running verify before classifier triage.`,
                outcome: {
                  branch: worktreeRecord.branch,
                  baseRef,
                },
                confidence: 1,
                batch_id,
              });
              review = null;
              continue;
            }

            if (workItemForRetry && workItemForRetry.id) {
              factoryIntake.rejectWorkItemUnactionable(workItemForRetry.id, branchStaleRejectReason);
            }
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'branch_stale_rebase_conflict_post_verify',
              reasoning: `Automatic rebase of ${worktreeRecord.branch} onto ${baseRef} failed after VERIFY drift; marking the work item unactionable so the factory can advance.`,
              outcome: {
                commits_behind: postFailureFreshness.commitsBehind,
                stale_files: postFailureFreshness.staleFiles,
                error: postFailureRebase.error,
                work_item_id: workItemForRetry?.id || instance?.work_item_id || null,
              },
              confidence: 1,
              batch_id,
            });
            return {
              status: 'unactionable',
              reason: branchStaleRejectReason,
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
            };
          }
        }

        // Verify-review classifier: on the FIRST failure only, classify the
        // failure as task_caused, baseline_broken, environment_failure, or
        // ambiguous. Baseline_broken / environment_failure short-circuit the
        // retry loop. Task_caused enters the repair path. Ambiguous failures
        // get one silent rerun, then pause for operator triage instead of
        // letting a retry task repair unrelated full-suite failures.
        if (res?.reason === 'empty_branch') {
          return resolveVerifyEmptyBranch({
            project,
            project_id,
            instance,
            workItem: workItemForRetry,
            worktreeRecord,
            verifyResult: res,
            batch_id,
          });
        }

        if (retryAttempt === 0 && !review) {
          try {
            const wi = instance?.work_item_id
              ? factoryIntake.getWorkItem(instance.work_item_id)
              : null;
            review = await verifyReview.reviewVerifyFailure({
              verifyOutput: res,
              workingDirectory: worktreeRecord.worktreePath || project?.path || process.cwd(),
              worktreeBranch: worktreeRecord.branch,
              mergeBase: baseRef,
              workItem: wi,
              project: project || { id: project_id, path: null },
              batch_id,
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

          if (review?.classification === 'zero_diff_cascade') {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_retry_suppressed_zero_diff',
              reasoning: 'Verify-retry suppressed: modifiedFiles empty AND prior auto_commit_skipped_clean in batch.',
              outcome: {
                reject_reason: 'zero_diff_across_retries',
                work_item_id: instance?.work_item_id,
              },
              confidence: 1,
              batch_id,
            });
            if (instance?.work_item_id) {
              try {
                factoryIntake.rejectWorkItemUnactionable(instance.work_item_id, 'zero_diff_across_retries');
              } catch (err) {
                logger.warn('verify zero-diff cascade: failed to mark work item unactionable', {
                  project_id,
                  work_item_id: instance.work_item_id,
                  err: err.message,
                });
              }
            }
            return {
              status: 'unactionable',
              reason: 'zero_diff_across_retries',
              pause_at_stage: null,
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
            };
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
                         || review.classification === 'baseline_likely'
                         || review.classification === 'environment_failure')) {
            let blockedWorkItem = null;
            if (instance?.work_item_id) {
              try {
                blockedWorkItem = factoryIntake.getWorkItem(instance.work_item_id);
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
                ...baselineRequeue.captureBlockedWorkItemEvidence(blockedWorkItem),
                failing_tests: review.failingTests,
                exit_code: res.exitCode,
                environment_signals: review.environmentSignals,
                llm_critique: review.llmCritique,
                // baseline_likely was reached without an LLM verdict —
                // record the deterministic shape that justified it so the
                // baseline-probe phase has the same evidence the operator
                // would have used.
                classification: review.classification,
                shared_infra_touched: review.sharedInfraTouched || false,
              };
              cfg.baseline_broken_probe_attempts = 0;
              cfg.baseline_broken_tick_count = 0;
              factoryHealth.updateProject(project_id, {
                status: 'paused',
                config_json: JSON.stringify(cfg),
              });
            } catch (_e) { void _e; }

            try {
              if (review.classification === 'baseline_broken'
                  || review.classification === 'baseline_likely') {
                eventBus.emitFactoryProjectBaselineBroken({
                  project_id,
                  reason: review.suggestedRejectReason,
                  failing_tests: review.failingTests,
                  evidence: {
                    exit_code: res.exitCode,
                    llm_critique: review.llmCritique,
                    classification: review.classification,
                  },
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
              : review.classification === 'baseline_likely'
                ? 'verify_reviewed_baseline_likely'
                : 'verify_reviewed_environment_failure';
            const reasoning = review.classification === 'baseline_broken'
              ? `Baseline broken — ${review.failingTests.length} failing test(s) unrelated to this diff. ${review.llmCritique || ''}`
              : review.classification === 'baseline_likely'
                ? `Baseline likely broken — LLM verdict unavailable (${review.llmStatus || 'null'}); ${review.failingTests.length} failing test(s) do not touch any modified file and no shared infrastructure was modified. Pausing for baseline-probe to confirm against main.`
                : `Environment failure — signals: ${review.environmentSignals.join(', ')}.`;
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action,
              reasoning,
              outcome: {
                work_item_id: instance?.work_item_id || null,
                classification: review.classification,
                confidence: review.confidence,
                modifiedFiles: review.modifiedFiles,
                failingTests: review.failingTests,
                intersection: review.intersection,
                environmentSignals: review.environmentSignals,
                llmVerdict: review.llmVerdict,
                llmCritique: review.llmCritique || null,
                llmStatus: review.llmStatus || null,
                llmTaskId: review.llmTaskId || null,
                sharedInfraTouched: review.sharedInfraTouched || false,
                sharedInfraFiles: review.sharedInfraFiles || [],
              },
              confidence: 1,
              batch_id,
            });

            return { status: 'rejected', reason: review.classification };
          }

          if (review && review.classification === 'reviewer_timeout') {
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_reviewer_timeout_paused',
              reasoning: `Verify reviewer timed out (task=${review.llmTaskId || 'unknown'}); pausing for controlled recovery instead of reusing the generic ambiguous retry loop.`,
              outcome: {
                work_item_id: instance?.work_item_id || null,
                classification: review.classification,
                confidence: review.confidence,
                modifiedFiles: review.modifiedFiles,
                failingTests: review.failingTests,
                intersection: review.intersection,
                llmStatus: review.llmStatus || null,
                task_id: review.llmTaskId || null,
              },
              confidence: 1,
              batch_id,
            });
            return {
              status: 'failed',
              reason: 'verify_reviewer_timeout_requires_recovery',
              pause_at_stage: 'VERIFY_FAIL',
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              verify_output: String(res.output || '').slice(-1500),
              retry_attempts: retryAttempt,
            };
          }

          if (review && review.classification === 'ambiguous') {
            let verifyOutput = res.output;
            const silentResult = await attemptSilentRerun({
              project_id,
              batch_id,
              instance_id: instance && instance.id,
              priorVerifyOutput: verifyOutput,
              runVerify: async () => {
                const execResult = await worktreeRunner.verify({
                  worktreePath: worktreeRecord.worktreePath,
                  branch: worktreeRecord.branch,
                  verifyCommand,
                  baseBranch: baseRef,
                });
                return {
                  exitCode: typeof execResult.exitCode === 'number' ? execResult.exitCode : (execResult.passed ? 0 : 1),
                  output: execResult.output,
                };
              },
            });

            if (silentResult.kind === 'passed') {
              return { status: 'passed' };
            }
            if (silentResult.kind === 'different_failure') {
              verifyOutput = silentResult.combinedOutput;
              res.output = verifyOutput;
            }
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'verify_reviewed_ambiguous_paused',
              reasoning: review.sharedInfraTouched
                ? `Classifier says ambiguous (confidence=${review.confidence}); shared infrastructure was touched (${(review.sharedInfraFiles || []).join(', ')}) so deterministic baseline upgrade is suppressed; pausing for engine strategy escalation.`
                : `Classifier says ambiguous (confidence=${review.confidence}); pausing instead of auto-retrying an unscoped failure.`,
              outcome: {
                work_item_id: instance?.work_item_id || null,
                classification: review.classification,
                confidence: review.confidence,
                modifiedFiles: review.modifiedFiles,
                failingTests: review.failingTests,
                intersection: review.intersection,
                silent_rerun: silentResult.kind,
                llmVerdict: review.llmVerdict || null,
                llmCritique: review.llmCritique || null,
                llmStatus: review.llmStatus || null,
                llmTaskId: review.llmTaskId || null,
                sharedInfraTouched: review.sharedInfraTouched || false,
                sharedInfraFiles: review.sharedInfraFiles || [],
              },
              confidence: 1,
              batch_id,
            });
            return {
              status: 'failed',
              reason: 'verify_ambiguous_requires_operator',
              pause_at_stage: 'VERIFY_FAIL',
              branch: worktreeRecord.branch,
              worktree_path: worktreeRecord.worktreePath,
              verify_output: String(res.output || '').slice(-1500),
              retry_attempts: retryAttempt,
            };
          }

          // build_failure is treated like task_caused: route to the auto-retry
          // path so MAX_AUTO_VERIFY_RETRIES bounds it. After retries exhaust,
          // the work item gets auto-rejected as unactionable rather than
          // sitting in human-pause limbo (the f9cf2275 failure mode).
          const reviewedAction = review && review.classification === 'task_caused'
            ? 'verify_reviewed_task_caused'
            : review && review.classification === 'build_failure'
              ? 'verify_reviewed_build_failure'
              : 'verify_reviewed_retrying';
          safeLogDecision({
            project_id,
            stage: LOOP_STATES.VERIFY,
            action: reviewedAction,
            reasoning: review
              ? `Classifier says ${review.classification} (confidence=${review.confidence}); retry path will fire.`
              : 'Classifier unavailable; retrying as before.',
            outcome: review ? {
              work_item_id: instance?.work_item_id || null,
              classification: review.classification,
              confidence: review.confidence,
              modifiedFiles: review.modifiedFiles,
              failingTests: review.failingTests,
              intersection: review.intersection,
              // Surface build_failure detector signals (e.g.
              // ['csharp_compile_error', 'dotnet_error_count_8']) when present
              // so triage can identify the language/tool that emitted them.
              buildSignals: review.buildSignals || null,
              llmVerdict: review.llmVerdict || null,
              llmCritique: review.llmCritique || null,
              llmStatus: review.llmStatus || null,
              llmTaskId: review.llmTaskId || null,
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
        const scopeEnvelopeResult = await enforceVerifyRetryScopeEnvelope({
          project_id,
          batch_id,
          workItemId: instance?.work_item_id || workItemForRetry?.id || worktreeRecord.workItemId || null,
          planPath: workItemForRetry?.origin?.plan_path || null,
          verifyOutput: res.output,
          worktreePath: worktreeRecord.worktreePath,
          attempt: retryAttempt,
          branch: worktreeRecord.branch,
        });
        if (!scopeEnvelopeResult.ok) {
          return {
            status: 'failed',
            reason: 'retry_off_scope',
            pause_at_stage: 'VERIFY_FAIL',
            branch: worktreeRecord.branch,
            worktree_path: worktreeRecord.worktreePath,
            off_scope_files: scopeEnvelopeResult.offScopeFiles,
            scope_envelope: Array.from(scopeEnvelopeResult.scopeEnvelope || []),
          };
        }
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

let executeVerifyStageForTests = null;

function setExecuteVerifyStageForTests(fn) {
  executeVerifyStageForTests = typeof fn === 'function' ? fn : null;
}

async function runExecuteVerifyStage(project_id, batch_id, instance = null) {
  if (executeVerifyStageForTests) {
    return executeVerifyStageForTests(project_id, batch_id, instance);
  }
  return executeVerifyStage(project_id, batch_id, instance);
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
  const currentState = previousState;
  let pausedAtStage = getPausedAtStage(instance);

  const projectPaused = isProjectStatusPaused(project.id);
  const pausedExecuteTarget = projectPaused && currentState === LOOP_STATES.EXECUTE
    ? tryGetSelectedWorkItem(instance, project.id, { fallbackToLoopSelection: true })
    : null;
  const canDeferPausedExecutePlanTask = Boolean(
    pausedExecuteTarget?.origin?.plan_path
    && fs.existsSync(pausedExecuteTarget.origin.plan_path)
  );

  // A paused EXECUTE plan batch still needs to observe the next incomplete
  // task so it can log execute_deferred_paused at the submission boundary.
  if (projectPaused && !canDeferPausedExecutePlanTask) {
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

  if (currentState === LOOP_STATES.STARVED) {
    const recovered = recoverStarvedInstanceForAdvance(project, instance);
    if (recovered) {
      instance = recovered.instance;
      return {
        project_id: project.id,
        instance_id: instance.id,
        previous_state: previousState,
        new_state: getCurrentLoopState(instance),
        paused_at_stage: getPausedAtStage(instance),
        stage_result: {
          recovered_from_state: LOOP_STATES.STARVED,
          open_work_items: recovered.openWorkItems,
          target_state: LOOP_STATES.PRIORITIZE,
        },
        reason: recovered.blocked ? 'stage_occupied' : 'starved_intake_replenished',
      };
    }

    const recovery = await triggerImmediateStarvationRecovery({
      ...project,
      loop_state: LOOP_STATES.STARVED,
      loop_last_action_at: instance.last_action_at || project.loop_last_action_at,
    }, 'manual_advance');
    if (recovery?.recovered) {
      const latestInstance = getInstanceOrThrow(instance.id);
      return {
        project_id: project.id,
        instance_id: latestInstance.id,
        previous_state: previousState,
        new_state: getCurrentLoopState(latestInstance),
        paused_at_stage: getPausedAtStage(latestInstance),
        stage_result: {
          recovered_from_state: LOOP_STATES.STARVED,
          starvation_recovery: summarizeStarvationRecovery(recovery),
        },
        reason: recovery.reason || 'starvation_recovered',
      };
    }
    if (recovery?.reason === 'scout_submitted_waiting_for_intake') {
      return {
        project_id: project.id,
        instance_id: instance.id,
        previous_state: previousState,
        new_state: LOOP_STATES.STARVED,
        paused_at_stage: null,
        stage_result: {
          starvation_recovery: summarizeStarvationRecovery(recovery),
        },
        reason: 'starvation_recovery_scout_submitted',
      };
    }

    return {
      project_id: project.id,
      instance_id: instance.id,
      previous_state: previousState,
      new_state: LOOP_STATES.STARVED,
      paused_at_stage: null,
      stage_result: null,
      reason: 'loop_starved',
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

  if (pausedAtStage === LOOP_STATES.EXECUTE) {
    const deferredPlanGeneration = maybeClearDeferredPlanGenerationWait(project, instance);
    if (deferredPlanGeneration?.waiting) {
      const waitReason = deferredPlanGeneration.wait_reason || 'task_still_running';
      const isFileLockWait = waitReason === 'file_lock_wait';
      return {
        project_id: project.id,
        instance_id: instance.id,
        previous_state: previousState,
        new_state: currentState,
        paused_at_stage: pausedAtStage,
        stage_result: {
          status: 'waiting',
          reason: isFileLockWait ? 'plan_generation_file_lock_wait' : 'plan_generation_task_active',
          generation_task_id: deferredPlanGeneration.task_id,
          task_status: deferredPlanGeneration.task_status,
          retry_after: deferredPlanGeneration.retry_after || null,
        },
        reason: isFileLockWait
          ? 'plan generation still waiting on file-lock contention'
          : 'plan generation task is still active',
      };
    }
    if (deferredPlanGeneration?.cleared) {
      instance = deferredPlanGeneration.instance;
      pausedAtStage = null;
    }

    const executeWait = maybeClearCompletedExecuteOwnerWait(project, instance);
    if (executeWait?.waiting) {
      return {
        project_id: project.id,
        instance_id: instance.id,
        previous_state: previousState,
        new_state: currentState,
        paused_at_stage: pausedAtStage,
        stage_result: {
          status: 'waiting',
          reason: 'active_worktree_owner_running',
          owning_task_id: executeWait.owning_task_id,
          owning_status: executeWait.owning_status,
        },
        reason: 'active worktree owner still running',
      };
    }
    if (executeWait?.cleared) {
      instance = executeWait.instance;
      pausedAtStage = null;
    }
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
      const prioritizeTransition = await handlePrioritizeTransition({
        project,
        instance,
        currentState,
      });
      instance = prioritizeTransition.instance || instance;
      transitionWorkItem = prioritizeTransition.transitionWorkItem;
      stageResult = prioritizeTransition.stageResult;
      transitionReason = prioritizeTransition.transitionReason;
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

      const preExecuteZeroDiff = maybeShortCircuitZeroDiffExecute({
        project,
        instance,
        workItem: targetItem,
        batchId: instance.batch_id || targetItem.batch_id || getFactorySubmissionBatchId(project, targetItem, instance),
      });
      if (preExecuteZeroDiff) {
        // Phase E: when the batch already produced a real commit, the
        // short-circuit signals "advance to VERIFY" instead of rejecting.
        // The work item stays alive; verify runs on the existing diff.
        if (preExecuteZeroDiff.advance_to_verify) {
          return {
            project_id: project.id,
            instance_id,
            previous_state: previousState,
            new_state: LOOP_STATES.VERIFY,
            paused_at_stage: null,
            stage_result: preExecuteZeroDiff.stage_result,
            reason: preExecuteZeroDiff.reason,
          };
        }
        const lastActionAt = instance.last_action_at || null;
        terminateInstanceAndSync(instance.id);
        recordFactoryIdleIfExhausted(project.id, {
          last_action_at: lastActionAt,
          reason: 'execute_zero_diff_short_circuit',
        });
        return {
          project_id: project.id,
          instance_id,
          previous_state: previousState,
          new_state: LOOP_STATES.IDLE,
          paused_at_stage: null,
          stage_result: preExecuteZeroDiff.stage_result,
          reason: preExecuteZeroDiff.reason,
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
        if (executeStage.next_state === LOOP_STATES.IDLE) {
          const lastActionAt = instance.last_action_at || null;
          terminateInstanceAndSync(instance.id);
          recordFactoryIdleIfExhausted(project.id, {
            last_action_at: lastActionAt,
            reason: transitionReason || executeStage.reason || 'execute_stop_idle',
          });
          return {
            project_id: project.id,
            instance_id: instance.id,
            previous_state: previousState,
            new_state: LOOP_STATES.IDLE,
            paused_at_stage: null,
            stage_result: executeStage.stage_result || null,
            reason: transitionReason || executeStage.reason || 'execute_stop_idle',
          };
        }
        if (executeStage.next_state === LOOP_STATES.PRIORITIZE) {
          const moveToPrioritize = tryMoveInstanceToStage(instance, LOOP_STATES.PRIORITIZE, {
            work_item_id: executeStage.work_item?.id ?? instance.work_item_id,
          });
          instance = moveToPrioritize.instance;
          if (moveToPrioritize.blocked) {
            transitionReason = 'stage_occupied';
          }
          break;
        }
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

      // Zero-diff short-circuit: if the last two+ executes for this batch
      // ended with auto_commit_skipped_clean, the work item is not producing
      // a diff and Codex is spinning. Reject it as unactionable so the loop
      // can move on instead of burning more retries.
      try {
        const zdBatchId = executeStage?.work_item?.batch_id || instance.batch_id;
        const workItemForZd = executeStage?.work_item || transitionWorkItem || targetItem || null;
        const zeroDiff = maybeShortCircuitZeroDiffExecute({
          project,
          instance,
          workItem: workItemForZd,
          batchId: zdBatchId,
        });
        if (zeroDiff) {
          // Phase E: prior auto_committed_task means the diff already
          // landed; advance to VERIFY to validate the existing commit
          // instead of treating no-op retries as failure.
          if (zeroDiff.advance_to_verify) {
            return {
              project_id: project.id,
              instance_id,
              previous_state: previousState,
              new_state: LOOP_STATES.VERIFY,
              paused_at_stage: null,
              stage_result: zeroDiff.stage_result,
              reason: zeroDiff.reason,
            };
          }
          const lastActionAtZd = instance.last_action_at || null;
          terminateInstanceAndSync(instance.id);
          recordFactoryIdleIfExhausted(project.id, {
            last_action_at: lastActionAtZd,
            reason: 'execute_zero_diff_short_circuit',
          });
          return {
            project_id: project.id,
            instance_id,
            previous_state: previousState,
            new_state: LOOP_STATES.IDLE,
            paused_at_stage: null,
            stage_result: zeroDiff.stage_result,
            reason: zeroDiff.reason,
          };
        }
      } catch (err) {
        logger.warn('EXECUTE zero-diff short-circuit: detection failed', {
          project_id: project.id,
          error: err.message,
        });
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
        stageResult = await runExecuteVerifyStage(project.id, instance.batch_id, instance);
        if (stageResult && stageResult.pause_at_stage) {
          instance = updateInstanceAndSync(instance.id, {
            paused_at_stage: stageResult.pause_at_stage,
            last_action_at: nowIso(),
          });
          transitionReason = stageResult.reason || transitionReason;
        } else if (isTerminalVerifyOutcome(stageResult)) {
          return finalizeTerminalVerifyOutcome({
            project,
            instance,
            previousState,
            stageResult,
          });
        }
      }
      break;
    }

    case LOOP_STATES.VERIFY: {
      const latestVerifyDecision = getLatestStageDecision(project.id, LOOP_STATES.VERIFY);
      const rerunApprovedVerify = ['gate_approved', 'retry_verify_requested'].includes(latestVerifyDecision?.action);
      stageResult = await runExecuteVerifyStage(project.id, instance.batch_id, instance);
      if (stageResult && stageResult.pause_at_stage) {
        instance = updateInstanceAndSync(instance.id, {
          paused_at_stage: stageResult.pause_at_stage,
          last_action_at: nowIso(),
        });
        transitionReason = stageResult.reason || transitionReason;
        break;
      }

      if (isTerminalVerifyOutcome(stageResult)) {
        return finalizeTerminalVerifyOutcome({
          project,
          instance,
          previousState,
          stageResult,
        });
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
        && result.new_state !== LOOP_STATES.STARVED
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
        && latestState !== LOOP_STATES.STARVED
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
  STARVED: 2.5,
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

    if (instance.terminated_at || instance.loop_state === LOOP_STATES.IDLE) {
      return { status: 'terminated', instance, elapsed_ms: elapsedMs, timed_out: false };
    }

    if (hasReachedTargetState(instance, target_states)) {
      return { status: 'target_state_reached', instance, elapsed_ms: elapsedMs, timed_out: false };
    }

    if (Array.isArray(target_paused_stages) && target_paused_stages.includes(instance.paused_at_stage)) {
      return { status: 'target_paused_stage_reached', instance, elapsed_ms: elapsedMs, timed_out: false };
    }

    if (instance.loop_state === LOOP_STATES.STARVED) {
      return { status: 'starved', instance, elapsed_ms: elapsedMs, timed_out: false };
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

/**
 * Decide what to do at PRIORITIZE when Codex may be unavailable.
 *
 * Pure decision function — reads the breaker and the project's
 * codex_fallback_policy and returns one of:
 *   - { action: 'proceed' }                                  Codex is available, or the policy
 *                                                            opts the project out of fallback.
 *   - { action: 'park', reason: 'wait_for_codex_policy' }    Park the work item until
 *                                                            Codex recovers (Phase 1 only path
 *                                                            that changes runtime behavior).
 *   - { action: 'proceed_with_fallback' }                    Phase 2 will reroute EXECUTE;
 *                                                            for now we proceed and let the
 *                                                            existing chain take over.
 *
 * The breaker is taken as a dependency so the function is unit-testable
 * without the DI container. Real callers pass
 * `defaultContainer.get('circuitBreaker')`.
 */
function decideCodexFallbackAction({ db, projectId, workItemId, breaker }) {
  void workItemId; // reserved for future per-item policy decisions
  // Determine if Codex is currently unavailable.
  let codexOpen = false;
  if (breaker) {
    if (typeof breaker.isOpen === 'function') {
      try { codexOpen = breaker.isOpen('codex'); } catch (_e) { void _e; codexOpen = false; }
    } else if (typeof breaker.allowRequest === 'function') {
      try { codexOpen = !breaker.allowRequest('codex'); } catch (_e) { void _e; codexOpen = false; }
    }
  }
  if (!codexOpen) return { action: 'proceed' };

  const { getCodexFallbackPolicy } = require('../db/factory-intake');
  let policy;
  try {
    policy = getCodexFallbackPolicy({ db, projectId });
  } catch (_e) {
    void _e;
    // Defensive: if policy lookup fails (missing project, malformed
    // config_json), default to 'auto' so we never accidentally park.
    policy = 'auto';
  }

  if (policy === 'wait_for_codex') {
    return { action: 'park', reason: 'wait_for_codex_policy' };
  }
  if (policy === 'manual') {
    return { action: 'proceed' };
  }
  // 'auto' policy — Phase 1 has no failover routing yet.
  // Phase 2 will reroute EXECUTE; for now we proceed and let it fail.
  return { action: 'proceed_with_fallback' };
}

/**
 * decomposeBeforePark — Codex Fallback Phase 3 helper.
 *
 * Before parking a `codex_only` work item, attempt to decompose it into
 * smaller sub-tasks and classify each sub-task's free eligibility.  This
 * function is READ-ONLY — it never writes to the database.  The return value
 * tells the caller whether decomposition would yield any free-eligible
 * sub-items; actual sub-item creation is deferred to a future phase.
 *
 * @param {{ db, projectId, workItem, projectConfig }} opts
 * @returns {{ decomposed: boolean, eligibleCount: number, subtaskCount?: number,
 *             eligibleSubitems?: string[], error?: string }}
 */
function decomposeBeforePark({ db, projectId, workItem, projectConfig }) {
  void db; void projectId; // read-only — no DB writes needed
  try {
    const { decomposeTask } = require('../db/host-complexity');
    const { classify } = require('../routing/eligibility-classifier');

    const description = workItem?.title || workItem?.description || '';
    const workingDirectory = workItem?.working_directory || '';

    const subtasks = decomposeTask(description, workingDirectory);
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      return { decomposed: false, eligibleCount: 0 };
    }

    // Each element from decomposeTask is a plain string (task description).
    // Build a minimal work-item + plan shape for the classifier:
    // - category: inherit from the parent item, falling back to 'simple_generation'
    //   (decomposed sub-tasks tend to be targeted file edits).
    // - plan: single task touching 1 file inferred from the sub-task string.
    const parentCategory = workItem?.category || 'simple_generation';
    let eligibleCount = 0;
    const eligibleSubitems = [];

    for (const sub of subtasks) {
      const subText = typeof sub === 'string' ? sub : String(sub);

      // Extract a file path from the description when present (e.g. "Create file /tmp/Foo.cs …").
      const filePattern = /\bfile\s+(\S+\.\w+)/i;
      const fileHit = filePattern.test(subText) ? filePattern.exec(subText) : null;
      const inferredFile = fileHit ? fileHit[1] : null;

      const subItem = { category: parentCategory };
      const subPlan = {
        tasks: [{
          files_touched: inferredFile ? [inferredFile] : [],
          estimated_lines: 50, // conservative single-file estimate
        }],
      };

      const result = classify(subItem, subPlan, projectConfig || {});
      if (result.eligibility === 'free') {
        eligibleCount += 1;
        eligibleSubitems.push(subText);
      }
    }

    return {
      decomposed: true,
      subtaskCount: subtasks.length,
      eligibleCount,
      eligibleSubitems,
    };
  } catch (err) {
    return { decomposed: false, eligibleCount: 0, error: err.message };
  }
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
  listTasksForFactoryBatch,
  getLatestStageDecision,
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
  recordFactoryIdleIfExhausted,
  buildAutoGeneratedPlanPrompt,
  resolvePlanGenerationTimeoutMinutes,
  getEffectiveProjectProvider,
  OLLAMA_PLAN_GENERATION_TIMEOUT_MINUTES,
  DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES,
  buildVerifyFixPrompt,
  VERIFY_FIX_PROMPT_TAIL_BUDGET,
  isProjectStatusPaused,
  countPriorVerifyRetryTasksForBatch,
  // Pure helpers (Fix 2 — fallback quarantine if upstream's empty-branch
  // resolver in maybeShipWorkItemAfterLearn ever fails open).
  isEmptyBranchMergeError,
  countPriorEmptyMergeFailuresForWorkItem,
  shouldQuarantineForEmptyMerges,
  isMergeTargetOperatorBlockedError,
  // Codex fallback (Phase 1) — pure decision helper consulted at PRIORITIZE
  // before we advance to PLAN. Exported for unit tests + future Phase 2 callers.
  decideCodexFallbackAction,
  // Codex fallback (Phase 3) — read-only decomposition probe called before
  // parking a work item. Returns whether the item could be split into
  // free-eligible sub-tasks. Sub-item creation is deferred to Phase 4.
  decomposeBeforePark,
  // Codex fallback (Phase 2) — in-memory marker that PRIORITIZE sets when
  // `decideCodexFallbackAction` returns 'proceed_with_fallback'. The
  // EXECUTE submit path (smart-routing chain walker — Task 7) consumes
  // the marker to apply the 'codex-down-failover' routing template.
  markInstanceFallbackRouting,
  consumeInstanceFallbackRouting,
  isInstanceFallbackRoutingPending,
  clearInstanceFallbackRouting,
  // Test hooks
  setWorktreeRunnerForTests,
  __testing__: {
    VERIFY_FIX_PROMPT_PRIOR_BUDGET,
    buildPriorAttemptsBlock,
    renderProgression,
    maybeShipNoop,
    countConsecutiveAutoCommitSkippedClean,
    maybeShortCircuitZeroDiffExecute,
    attemptSilentRerun,
    isFactoryFeatureEnabled,
    setExecuteVerifyStageForTests,
    extractScopeEnvelopeFiles,
    computeScopeEnvelope,
    isOutOfScope,
    getVerifyRetryDiffFiles,
    enforceVerifyRetryScopeEnvelope,
    resolveFactoryVerifyCommand,
  },
  _internalForTests: {
    claimNextWorkItemForInstance,
    handlePrioritizeTransition,
    executeSenseStage,
    executePlanStage,
    healAlreadyShippedWorkItem,
    recordFactoryIdleIfExhausted,
    clearFactoryIdleForPendingWork,
    awaitTaskToStructuredResult,
    findExistingPlanTaskSubmission,
    lintAutoGeneratedPlan,
    parseAutoGeneratedPlanTasks,
    normalizeAutoGeneratedPlanMarkdown,
    buildPlanFromFileEditsProposal,
    scoreAutoGeneratedPlanDescriptions,
    scoreAutoGeneratedTaskDescription,
    isTrackingSupportTask,
    terminateInstanceAndSync,
    safeLogDecision,
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
