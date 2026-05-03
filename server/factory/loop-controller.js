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
const { createTransitionHelpers } = require('./transitions');
const { createSenseStage } = require('./stages/sense');
const { createPrioritizeStage } = require('./stages/prioritize');
const { createPlanStage } = require('./stages/plan');
const { createExecuteStage } = require('./stages/execute');
const { createVerifyStage } = require('./stages/verify');
const { createLearnStage } = require('./stages/learn');
const { createStageSharedContext } = require('./stages/shared');
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
const { extractExplicitVerifyCommand, normalizeVerifyCommand, parsePlanFile } = require('./plan-parser');
const {
  buildProviderLaneTaskMetadata,
  getProviderLanePolicyFromProject,
  specializePolicyForKind,
} = require('./provider-lane-policy');
const { createWorktreeManager } = require('../plugins/version-control/worktree-manager');
const eventBus = require('../event-bus');
const baselineRequeue = require('./baseline-requeue');
const logger = require('../logger').child({ component: 'loop-controller' });

const PLAN_GENERATOR_LABEL = 'auto-router';
const DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES = 30;
const DEFAULT_STALE_PENDING_PLAN_GENERATION_MS = DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES * 60 * 1000;
const AUTO_ADVANCE_DEFAULT_DELAY_MS = 100;
const AUTO_ADVANCE_DEFERRED_MIN_DELAY_MS = 2500;
const AUTO_ADVANCE_DEFERRED_FALLBACK_DELAY_MS = 30 * 1000;
const AUTO_ADVANCE_DEFERRED_MAX_DELAY_MS = 60 * 1000;

const WORK_ITEM_STATUS_ORDER = Object.freeze([
  'executing',
  'verifying',
  'planned',
  'prioritized',
  'in_progress',
  'pending',
  'triaged',
  'intake',
  // Phase X1 (2026-05-01): items whose current plan failed quality/parse/
  // timeout/empty-diff checks. Placed last so fresh `pending` items get
  // first dibs; needs_replan items only get picked when no fresh work exists.
  // PRIORITIZE's cooldown filter further prevents immediate re-loop after a
  // rejection.
  'needs_replan',
]);

const SELECTED_WORK_ITEM_DECISION_ACTIONS = Object.freeze([
  'starting',
  'skipped_for_plan_file',
  'selected_work_item',
  'scored_work_item',
  'generated_plan',
]);

const CLOSED_WORK_ITEM_STATUSES = factoryIntake.CLOSED_STATUSES || new Set([
  'completed',
  'shipped',
  'shipped_stale',
  'rejected',
  'unactionable',
  'needs_review',
  'superseded',
  'escalation_exhausted',
]);

const stageSharedContext = createStageSharedContext();
const {
  getDecisionActor,
  getDecisionBatchId,
  getFactorySubmissionBatchId,
  getWorkItemDecisionContext,
  normalizeDecisionStage,
} = stageSharedContext;

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

function parseProjectConfigObject(project) {
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

function hasOperatorPauseIntent(project) {
  const cfg = parseProjectConfigObject(project);
  return cfg?.loop?.operator_paused === true;
}

function isProjectPauseActive(project, { includeStatus = true } = {}) {
  if (!includeStatus) {
    return hasOperatorPauseIntent(project);
  }
  return project?.status === 'paused' || hasOperatorPauseIntent(project);
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
    const cfg = parseProjectConfigObject(project);
    const policy = cfg?.provider_lane_policy || cfg?.provider_lane;
    const expected = policy && typeof policy === 'object' ? policy.expected_provider : null;
    return typeof expected === 'string' && expected.trim() ? expected.trim().toLowerCase() : null;
  } catch (_err) {
    void _err;
    return null;
  }
}

function getProjectConfigForPlanGate(project) {
  return parseProjectConfigObject(project);
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

function buildPlanGenerationActivityTimeoutPolicy(timeoutMinutes) {
  const numeric = Number(timeoutMinutes);
  const boundedTimeoutMinutes = Number.isFinite(numeric) && numeric > 0
    ? Math.min(Math.max(Math.ceil(numeric), 1), 120)
    : DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES;
  return {
    kind: 'plan_generation',
    timeout_minutes: boundedTimeoutMinutes,
    max_wall_clock_minutes: Math.min(
      Math.max(boundedTimeoutMinutes * 2, boundedTimeoutMinutes + 15),
      120
    ),
    overrun_intake_problem: 'timeout_overrun_active',
  };
}

function getTaskAgeMs(task) {
  if (!task) return null;
  // provider_switched_at takes precedence so failover-requeued tasks reset the
  // grace clock. Without this, the worktree pre-reclaim sweep cancels a
  // freshly-requeued task because its row's started_at/created_at still
  // reflect the original (now-failed) provider's run window. Live evidence:
  // torque-public batch_id=...-2211 ran codex 977s, hit quota, failover
  // re-queued the task on ollama; the next factory tick treated it as a
  // 25-min-old "stale" owner and cancelled it with pre_reclaim_before_create
  // before ollama could pick it up.
  return elapsedMsSince(
    task.provider_switched_at
      || task.providerSwitchedAt
      || task.started_at
      || task.created_at
      || task.createdAt,
  );
}

function normalizeTaskTags(task) {
  const rawTags = task?.tags;
  const tags = Array.isArray(rawTags)
    ? rawTags
    : (typeof rawTags === 'string' ? parseJsonObject(rawTags) : []);
  return Array.isArray(tags)
    ? tags.filter((tag) => typeof tag === 'string')
    : [];
}

function hasPlanGenerationFileLockWaitEvidence(task) {
  const wait = getTaskMetadataObject(task).file_lock_wait;
  if (wait && typeof wait === 'object' && !Array.isArray(wait)) {
    return true;
  }

  return /Requeued:\s*file\s+'[^']+'\s+is being edited by task\b/i.test(
    typeof task?.error_output === 'string' ? task.error_output : ''
  );
}

function isSchedulerOwnedPlanGenerationTask(task, { projectId = null, workItemId = null } = {}) {
  const metadata = getTaskMetadataObject(task);
  if (metadata.kind === 'plan_generation' && metadata.factory_internal === true) {
    return true;
  }

  const normalizedProjectId = projectId == null ? null : String(projectId).trim();
  const normalizedWorkItemId = workItemId == null ? null : String(workItemId).trim();
  if (!normalizedProjectId || !normalizedWorkItemId) {
    return false;
  }

  const tags = new Set(normalizeTaskTags(task));
  return tags.has('factory:internal')
    && tags.has('factory:plan_generation')
    && tags.has(`factory:project_id=${normalizedProjectId}`)
    && tags.has(`factory:work_item_id=${normalizedWorkItemId}`);
}

function isStaleNeverStartedPendingPlanGenerationTask(
  task,
  staleAfterMs = DEFAULT_STALE_PENDING_PLAN_GENERATION_MS,
  {
    projectId = null,
    workItemId = null,
    requireSchedulerOwned = false,
  } = {}
) {
  if (!task) return false;
  if (String(task.status || '').toLowerCase() !== 'pending') return false;
  if (task.started_at || task.startedAt) return false;
  if (hasPlanGenerationFileLockWaitEvidence(task)) return false;

  const createdAgeMs = elapsedMsSince(task.created_at || task.createdAt);
  const thresholdMs = Number(staleAfterMs);
  const isStale = createdAgeMs != null
    && Number.isFinite(thresholdMs)
    && thresholdMs >= 0
    && createdAgeMs >= thresholdMs;
  if (!isStale) return false;
  if (!requireSchedulerOwned) return true;

  return isSchedulerOwnedPlanGenerationTask(task, { projectId, workItemId });
}

function retireStalePendingPlanGenerationTask(taskCore, task, {
  projectId = null,
  workItemId = null,
  staleAfterMs = DEFAULT_STALE_PENDING_PLAN_GENERATION_MS,
  reason = 'stale_pending_plan_generation',
  requireSchedulerOwned = false,
} = {}) {
  if (!isStaleNeverStartedPendingPlanGenerationTask(task, staleAfterMs, {
    projectId,
    workItemId,
    requireSchedulerOwned,
  })) {
    return false;
  }
  if (!taskCore || typeof taskCore.updateTaskStatus !== 'function' || !task?.id) {
    return false;
  }

  try {
    taskCore.updateTaskStatus(task.id, 'skipped', {
      output: 'Superseded stale never-started plan-generation task.',
      error_output: `Skipped stale never-started plan-generation task: ${reason}`,
    });
    logger.warn('Retired stale pending plan-generation task', {
      project_id: projectId,
      work_item_id: workItemId,
      task_id: task.id,
      status: task.status,
      created_at: task.created_at || task.createdAt || null,
      reason,
    });
    return true;
  } catch (error) {
    logger.warn('Failed to retire stale pending plan-generation task', {
      project_id: projectId,
      work_item_id: workItemId,
      task_id: task.id,
      err: error.message,
      reason,
    });
    return false;
  }
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

function normalizeWorktreePathForCompare(worktreePath) {
  if (typeof worktreePath !== 'string' || worktreePath.trim() === '') {
    return null;
  }
  try {
    return path.resolve(worktreePath).replace(/\\/g, '/').toLowerCase();
  } catch (_err) {
    return String(worktreePath).trim().replace(/\\/g, '/').toLowerCase();
  }
}

function taskHasFactoryTag(task, tag) {
  return normalizeTaskTags(task).includes(tag);
}

function findLiveReplacementWorktreeOwner({
  projectId,
  workItemId,
  batchId,
  worktreePath,
  excludeTaskId = null,
}) {
  const normalizedPath = normalizeWorktreePathForCompare(worktreePath);
  if (!normalizedPath || !workItemId) {
    return null;
  }

  try {
    const taskCore = require('../db/task-core');
    if (!taskCore || typeof taskCore.listTasks !== 'function') {
      return null;
    }

    const lookupTags = [`factory:work_item_id=${workItemId}`];
    if (batchId) lookupTags.push(`factory:batch_id=${batchId}`);

    const candidates = taskCore.listTasks({
      statuses: Array.from(LIVE_WORKTREE_OWNER_STATUSES),
      tags: lookupTags,
      columns: ['id', 'status', 'working_directory', 'tags', 'created_at', 'started_at'],
      limit: 1000,
      includeArchived: true,
    });

    for (const candidate of candidates) {
      if (!candidate || candidate.id === excludeTaskId) continue;
      if (!taskHasFactoryTag(candidate, `factory:work_item_id=${workItemId}`)) continue;
      if (batchId && !taskHasFactoryTag(candidate, `factory:batch_id=${batchId}`)) continue;
      if (normalizeWorktreePathForCompare(candidate.working_directory) !== normalizedPath) continue;
      return candidate;
    }
  } catch (error) {
    logger.warn('factory worktree: replacement owner lookup failed before reclaim guard', {
      project_id: projectId,
      work_item_id: workItemId,
      batch_id: batchId || null,
      worktree_path: worktreePath,
      err: error && error.message,
    });
  }

  return null;
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
const scheduledAutoAdvanceTimers = new Map();

// Tracks the last-emitted timestamp for the in-flight-same-wi pre-reclaim
// skip log, keyed by `${instanceId}:${owningTaskId}`. The factory loop
// re-enters EXECUTE every ~30s while a task is in flight; without
// throttling we'd emit 36+ identical decisions per task — see the
// 2026-05-03 wi=2215 case. Only the FIRST skip per (instance,owner) and
// then once every IN_FLIGHT_SKIP_LOG_INTERVAL_MS is logged. The map is
// bounded and entries fall out via the lifecycle hooks that finalize an
// instance (see clearInstanceTracking).
const inFlightSameWiSkipEmitTimestamps = new Map();
const IN_FLIGHT_SAME_WI_SKIP_LOG_INTERVAL_MS = 5 * 60 * 1000;
const IN_FLIGHT_SAME_WI_SKIP_TRACKING_MAX_ENTRIES = 200;

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
    auto_advance_delay_ms: job.auto_advance_delay_ms ?? null,
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
    auto_advance_delay_ms: job.auto_advance_delay_ms ?? null,
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
    if (hasOperatorPauseIntent(project) && project?.status !== 'paused') {
      try {
        factoryHealth.updateProject(project.id, { status: 'paused' });
      } catch (_err) {
        void _err;
      }
    }
    return isProjectPauseActive(project);
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

function isTerminalVerifyOutcome(stageResult) {
  return stageResult
    && (stageResult.status === 'rejected'
      || stageResult.status === 'unactionable'
      || stageResult.status === 'shipped'
      // Phase X4 (2026-05-01): needs_replan is "terminal for THIS verify
      // attempt" — the loop should exit VERIFY (not loop in it) and go
      // back through SENSE → PRIORITIZE on the next tick, where the
      // needs_replan item gets re-picked after the X1 cooldown.
      || stageResult.status === 'needs_replan');
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
  if (hasOperatorPauseIntent(project)) {
    if (project.status !== 'paused') {
      try {
        factoryHealth.updateProject(project.id, { status: 'paused' });
      } catch (_err) {
        void _err;
      }
    }
    logger.info('Backfill skipped for paused factory project', {
      project_id: project.id,
      status: project.status || null,
      operator_paused: true,
      loop_state: project.loop_state || LOOP_STATES.IDLE,
    });
    return null;
  }
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

function clampAutoAdvanceDelayMs(value, {
  min = AUTO_ADVANCE_DEFAULT_DELAY_MS,
  max = AUTO_ADVANCE_DEFERRED_MAX_DELAY_MS,
} = {}) {
  const delay = Number(value);
  if (!Number.isFinite(delay)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.ceil(delay)));
}

function parseRetryAfterDelayMs(retryAfter, nowMs = Date.now()) {
  const normalized = normalizeOptionalString(retryAfter);
  if (!normalized) {
    return null;
  }

  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    if (numeric > 1e12) {
      return numeric - nowMs;
    }
    if (numeric > 1e9) {
      return (numeric * 1000) - nowMs;
    }
    return numeric * 1000;
  }

  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed - nowMs;
}

function getAutoAdvanceDelayMs(result, nowMs = Date.now()) {
  const stageResult = result?.stage_result || {};
  const status = normalizeOptionalString(stageResult.status);
  const retryAfter = normalizeOptionalString(stageResult.retry_after);
  const isDeferred = status === 'deferred' || Boolean(retryAfter);

  if (!isDeferred) {
    return AUTO_ADVANCE_DEFAULT_DELAY_MS;
  }

  const parsedDelay = parseRetryAfterDelayMs(retryAfter, nowMs);
  if (parsedDelay !== null) {
    if (parsedDelay <= 0) {
      return AUTO_ADVANCE_DEFERRED_FALLBACK_DELAY_MS;
    }
    return clampAutoAdvanceDelayMs(parsedDelay, {
      min: AUTO_ADVANCE_DEFERRED_MIN_DELAY_MS,
      max: AUTO_ADVANCE_DEFERRED_MAX_DELAY_MS,
    });
  }

  return AUTO_ADVANCE_DEFERRED_FALLBACK_DELAY_MS;
}

function clearScheduledAutoAdvance(instance_id) {
  if (!instance_id) {
    return false;
  }
  const scheduled = scheduledAutoAdvanceTimers.get(instance_id);
  if (!scheduled) {
    return false;
  }
  clearTimeout(scheduled.timer);
  scheduledAutoAdvanceTimers.delete(instance_id);
  return true;
}

function scheduleAutoAdvance(instance_id, delayMs, {
  onAdvance = null,
  debugMessage = 'Auto-advance chain stopped',
} = {}) {
  const delay = clampAutoAdvanceDelayMs(delayMs, {
    min: 0,
    max: 2 ** 31 - 1,
  });
  clearScheduledAutoAdvance(instance_id);
  const timer = setTimeout(() => {
    const scheduled = scheduledAutoAdvanceTimers.get(instance_id);
    if (scheduled?.timer === timer) {
      scheduledAutoAdvanceTimers.delete(instance_id);
    }
    try {
      if (typeof onAdvance === 'function') {
        onAdvance();
      } else {
        advanceLoopAsync(instance_id, { autoAdvance: true });
      }
    } catch (err) {
      logger.debug(debugMessage, {
        instance_id,
        err: err.message,
      });
    }
  }, delay);
  scheduledAutoAdvanceTimers.set(instance_id, {
    timer,
    delay_ms: delay,
    scheduled_at: nowIso(),
  });
  return delay;
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

function isStalePlanGenerationFileLockWait(task, nowMs = Date.now()) {
  const metadata = getTaskMetadataObject(task);
  const wait = metadata.file_lock_wait;
  if (!wait || typeof wait !== 'object' || Array.isArray(wait)) {
    return false;
  }

  const status = String(task?.status || '').toLowerCase();
  if (status === 'running') {
    return true;
  }

  const retryAfter = normalizeOptionalString(wait.retry_after);
  if (!retryAfter) {
    return false;
  }

  const retryAfterMs = Date.parse(retryAfter);
  return Number.isFinite(retryAfterMs) && retryAfterMs <= nowMs;
}

function getPlanGenerationFileLockWait(task, message = '') {
  if (isStalePlanGenerationFileLockWait(task)) {
    return null;
  }

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
  if (isPlanGenerationTaskPending(task) && isStalePlanGenerationFileLockWait(task)) {
    return { reason: 'task_still_running' };
  }

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
    next_state: LOOP_STATES.EXECUTE,
    paused_at_stage: null,
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
  stalePendingMs = DEFAULT_STALE_PENDING_PLAN_GENERATION_MS,
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
    const queryCandidates = (options = {}) => taskCore.listTasks({
      ...options,
      tag: workItemTag,
      statuses: ['pending', 'pending_approval', 'queued', 'running', 'completed'],
      orderBy: 'created_at',
      orderDir: 'desc',
      limit: 100,
      columns: ['id', 'status', 'tags', 'created_at', 'started_at'],
    });

    candidates = queryCandidates({
      ...(projectName ? { project: projectName } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
    });

    if (candidates.length === 0 && (projectName || workingDirectory)) {
      candidates = queryCandidates();
    }
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

  const active = prioritized.find((candidate) => {
    if (isStaleNeverStartedPendingPlanGenerationTask(candidate, stalePendingMs)) {
      logger.warn('Ignoring stale pending reusable plan task submission', {
        task_id: candidate.id,
        work_item_id: normalizedWorkItemId,
        plan_task_number: normalizedPlanTaskNumber,
        status: candidate.status,
        created_at: candidate.created_at || candidate.createdAt || null,
      });
      return false;
    }
    return candidate.status === 'running'
      || candidate.status === 'queued'
      || candidate.status === 'pending'
      || candidate.status === 'pending_approval';
  });
  if (active) {
    return { task_id: active.id, status: active.status };
  }

  const completed = prioritized.find((candidate) => candidate.status === 'completed');
  if (completed) {
    return { task_id: completed.id, status: completed.status };
  }

  return null;
}

const ACTIVE_PLAN_GENERATION_TASK_STATUSES = Object.freeze([
  'pending',
  'pending_approval',
  'pending_provider_switch',
  'queued',
  'retry_scheduled',
  'running',
  'waiting',
  'blocked',
]);

function findActivePlanGenerationTask(taskCore, {
  projectId,
  workingDirectory,
  workItemId,
  stalePendingMs = DEFAULT_STALE_PENDING_PLAN_GENERATION_MS,
}) {
  if (!taskCore || typeof taskCore.listTasks !== 'function') {
    return null;
  }

  const normalizedWorkItemId = normalizeWorkItemId(workItemId);
  const normalizedProjectId = projectId == null ? null : String(projectId).trim();
  if (!normalizedProjectId || !normalizedWorkItemId) {
    return null;
  }

  const workItemTag = `factory:work_item_id=${normalizedWorkItemId}`;
  const baseQuery = {
    tag: workItemTag,
    statuses: ACTIVE_PLAN_GENERATION_TASK_STATUSES,
    orderBy: 'created_at',
    orderDir: 'desc',
    limit: 50,
    columns: ['id', 'status', 'tags', 'metadata', 'created_at', 'started_at', 'error_output'],
  };
  const candidateQueries = [
    ...(workingDirectory ? [{ ...baseQuery, workingDirectory }] : []),
    baseQuery,
  ];

  const seen = new Set();
  for (const query of candidateQueries) {
    let candidates = [];
    try {
      candidates = taskCore.listTasks(query);
    } catch (error) {
      logger.debug('Unable to query active plan-generation tasks', {
        err: error.message,
        project_id: normalizedProjectId,
        work_item_id: normalizedWorkItemId,
      });
      continue;
    }

    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!candidate?.id || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      if (!isSchedulerOwnedPlanGenerationTask(candidate, {
        projectId: normalizedProjectId,
        workItemId: normalizedWorkItemId,
      })) {
        continue;
      }
      if (retireStalePendingPlanGenerationTask(taskCore, candidate, {
        projectId: normalizedProjectId,
        workItemId: normalizedWorkItemId,
        staleAfterMs: stalePendingMs,
        reason: 'duplicate_plan_generation_scan',
        requireSchedulerOwned: true,
      })) {
        continue;
      }

      const status = String(candidate.status || '').toLowerCase();
      if (ACTIVE_PLAN_GENERATION_TASK_STATUSES.includes(status)) {
        return candidate;
      }
    }
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

function hasVerifiedBatchDecision(project_id, batch_id) {
  if (!project_id || !batch_id) return false;
  try {
    const decisions = factoryDecisions.listDecisions(project_id, {
      stage: normalizeDecisionStage(LOOP_STATES.VERIFY),
      limit: 50,
    });
    return decisions.some((decision) => (
      decision?.action === 'verified_batch'
      && (decision.batch_id === batch_id || decision.outcome?.batch_id === batch_id)
    ));
  } catch (error) {
    logger.debug({ err: error.message, project_id, batch_id }, 'Unable to inspect verified batch decisions');
    return false;
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
      SELECT id, status, provider, model, created_at, started_at, completed_at
      FROM tasks
      WHERE tags LIKE ? ESCAPE '\\'
    `).all(`%"${escapeSqlLikeValue(batchTag)}"%`);
  } catch (error) {
    logger.debug({ err: error.message, batch_id: batchId }, 'Unable to inspect factory batch tasks');
    return [];
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

const { tryMoveInstanceToStage, logTransitionDecision } = createTransitionHelpers({
  StageOccupiedError,
  getDecisionBatchId,
  getWorkItemDecisionContext,
  loopStates: LOOP_STATES,
  moveInstanceToStage,
  parkInstanceForStage,
  safeLogDecision,
});

const { executeSenseStage } = createSenseStage({
  ...stageSharedContext,
  LOOP_STATES,
  createPlanFileIntake,
  createShippedDetector,
  database,
  factoryHealth,
  factoryIntake,
  getProjectOrThrow,
  logger,
  resolvePlansRepoRoot,
  safeLogDecision,
});

const { executePlanStage } = createPlanStage({
  ...stageSharedContext,
  LOOP_STATES,
  architectRunner,
  factoryIntake,
  fs,
  getProjectConfigForPlanGate,
  getSelectedWorkItem,
  logger,
  rememberSelectedWorkItem,
  routePlanQualityGateFailureToNeedsReplan,
  safeLogDecision,
  updateInstanceAndSync,
});

const {
  claimNextWorkItemForInstance,
  handlePrioritizeTransition,
  healAlreadyShippedWorkItem,
} = createPrioritizeStage({
  ...stageSharedContext,
  LOOP_STATES,
  clearFactoryIdleForPendingWork,
  clearSelectedWorkItem,
  database,
  decideCodexFallbackAction,
  decomposeBeforePark,
  factoryHealth,
  factoryIntake,
  factoryWorktrees,
  fs,
  getCurrentLoopState,
  getInstanceOrThrow,
  getPendingGateStage,
  getExecutePlanStage: getExecutePlanStageForTransition,
  incrementConsecutiveEmptyCycles,
  logger,
  markInstanceFallbackRouting,
  nowIso,
  recordFactoryIdleIfExhausted,
  rememberSelectedWorkItem,
  safeLogDecision,
  setConsecutiveEmptyCycles,
  terminateInstanceAndSync,
  tryGetSelectedWorkItem,
  tryMoveInstanceToStage,
  updateInstanceAndSync,
  workItemStatusOrder: WORK_ITEM_STATUS_ORDER,
});

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
 * gate's "explicit file paths" signal. example-project #2098 (2026-04-30)
 * demonstrated this: scout produced a real domain pattern citing
 * `docs/planning/BackendMultiplayerPlan.md`, but the architect never
 * saw that path so its tasks named no concrete files and the plan was
 * rejected on every retry.
 */
function collectArchitectHardScopeFiles(workItem) {
  const out = new Set();
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) {
      out.add(value.trim());
    }
  };
  const pushAll = (arr) => {
    if (Array.isArray(arr)) arr.forEach(push);
  };

  const origin = getWorkItemOriginObject(workItem);
  pushAll(origin.allowed_files);
  pushAll(getWorkItemConstraintsObject(workItem).allowed_files);

  return Array.from(out);
}

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

  const origin = getWorkItemOriginObject(workItem);
  pushAll(origin.exemplar_files);
  pushAll(collectArchitectHardScopeFiles(workItem));
  if (Array.isArray(origin.shared_dependencies)) {
    for (const dep of origin.shared_dependencies) {
      if (typeof dep === 'string') {
        push(dep);
      } else if (dep && typeof dep === 'object') {
        push(dep.file);
      }
    }
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
  const hardScopeFiles = collectArchitectHardScopeFiles(workItem);
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
  const codegraphEnabled = process.env.TORQUE_CODEGRAPH_ENABLED === '1'
    && !useOllamaShortPrompt
    && hardScopeFiles.length === 0;

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
    ...(hardScopeFiles.length > 0 ? [
      '',
      'Hard file boundary:',
      '- This work item declares explicit `allowed_files`; treat that list as the maximum read/write scope for plan generation.',
      '- Do not read, search, summarize, or rely on files outside `allowed_files` while generating this plan.',
      '- If shell search is needed, pass only the allowed file paths as operands; do not run repo-wide `rg`, `git grep`, `find`, or directory scans.',
      '- Emit the smallest viable plan, preferably one implementation task plus commit, that stays within `allowed_files`.',
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

function normalizeWorkItemDetail(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    return parts.length > 0 ? parts.join('; ') : null;
  }
  return null;
}

function getWorkItemDetail(workItem, keys) {
  const origin = getWorkItemOriginObject(workItem);
  const constraints = getWorkItemConstraintsObject(workItem);
  for (const source of [constraints, origin]) {
    for (const key of keys) {
      const detail = normalizeWorkItemDetail(source?.[key]);
      if (detail) return detail;
    }
  }
  return null;
}

function buildWorkItemValidationDetail(workItem) {
  return getWorkItemDetail(workItem, [
    'validation',
    'verification',
    'validation_command',
    'verify_command',
    'validation_steps',
    'test_command',
  ]);
}

function buildWorkItemSuccessDetail(workItem) {
  return extractWorkItemAcceptanceCriteria(workItem)
    || getWorkItemDetail(workItem, [
      'acceptance_criteria',
      'success_criteria',
      'done_when',
      'expected_result',
    ])
    || `work item #${workItem?.id || 'current'} is satisfied using the scoped files and unrelated files are left unchanged`;
}

function buildWorkItemScopeDetail(workItem) {
  const constraints = getWorkItemConstraintsObject(workItem);
  const origin = getWorkItemOriginObject(workItem);
  const hardScopeFiles = collectArchitectHardScopeFiles(workItem);
  const scopeFiles = collectArchitectScopeFiles(workItem);
  const allowedFiles = hardScopeFiles.length > 0 ? hardScopeFiles : scopeFiles;
  const maxFiles = Number(constraints.max_files || origin.max_files);

  if (allowedFiles.length > 0) {
    const fileList = allowedFiles.map((file) => `\`${file}\``).join(', ');
    const fileCount = Number.isFinite(maxFiles) && maxFiles > 0
      ? `up to ${maxFiles} file${maxFiles === 1 ? '' : 's'}`
      : `${allowedFiles.length} file${allowedFiles.length === 1 ? '' : 's'}`;
    const qualifier = hardScopeFiles.length > 0 ? 'limited to' : 'centered on';
    return `${fileCount}, ${qualifier} ${fileList}`;
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
  const successDetail = buildWorkItemSuccessDetail(workItem);
  const validationDetail = buildWorkItemValidationDetail(workItem);

  if ((missing.has('explicit_file_paths') || missing.has('estimated_scope')) && scopeDetail) {
    additions.push(`Estimated scope: single focused change across ${scopeDetail}.`);
  }
  if (missing.has('success_criteria') && successDetail) {
    additions.push(`Success criteria: ${successDetail}`);
  }
  if (missing.has('validation_steps') && validationDetail) {
    additions.push(`Validation: Run \`${validationDetail}\` and record the result.`);
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
const PLAN_DESCRIPTION_VALIDATION_RE = /\b(?:npx\s+vitest|vitest\s+run|npm\s+(?:run\s+)?(?:test|lint)|pnpm\s+(?:run\s+)?(?:test|lint)|yarn\s+(?:test|lint)|node\s+--test|node\s+[^.\n]*\.m?js|pytest|(?:python\s+)?-m\s+(?:pytest|unittest|mypy|ruff|black|isort|pylint|flake8|bandit|coverage)|python\s+(?!-m\b)[\w./\\:-]+\.py(?:\s+[\w./\\:-]+)*|pre-commit\s+run|ruff\s+(?:check|format)|mypy\s+[\w./:-]+|black\s+[\w./:-]+|flake8\s+[\w./:-]+|isort\s+[\w./:-]+|bandit\s+(?:-[rc]|[\w./:-]+)|pip-audit|safety\s+check|dotnet\s+test|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|tsc\s+--noEmit|make\s+(?:test|check|lint)|rg\s+["'`]?[\w./:-]+)/i;
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

// Phase X2 (2026-05-01): convert a previously-persisted plan-quality rejection
// payload (from origin.last_plan_description_quality_rejection) into a
// markdown feedback block to prepend to the next architect prompt. Mirrors
// the shape buildFeedbackPrompt produces in plan-quality-gate.js for
// intra-batch retries, so the architect sees the SAME structured feedback
// whether the rejection happened in the current batch or a prior one.
//
// Without this, a work item that came back to PRIORITIZE via needs_replan
// (Phase X1) would get a fresh plan attempt with NO knowledge that the prior
// attempt failed for missing scope/validation/etc — guaranteeing the same
// failure shape. This is the "evolve the plan, don't reject and forget"
// principle made concrete.
function buildPriorRejectionFeedbackPrompt(rejection) {
  if (!rejection || typeof rejection !== 'object') return null;
  const failingTasks = Array.isArray(rejection.failing_tasks) ? rejection.failing_tasks : [];
  const missingSignals = Array.isArray(rejection.missing_specificity_signals)
    ? rejection.missing_specificity_signals
    : [];
  const reasons = Array.isArray(rejection.reasons) ? rejection.reasons : [];
  // If we have nothing useful to feed back, signal "no feedback" rather than
  // an empty header that wastes prompt budget.
  if (failingTasks.length === 0 && missingSignals.length === 0 && reasons.length === 0) {
    return null;
  }

  const lines = [
    '## PRIOR PLAN REJECTED — your last attempt at this work item failed the quality gate.',
    '',
    'You MUST address the issues below in this new plan. Producing a plan',
    'with the same shape as before will be rejected again.',
    '',
  ];

  if (typeof rejection.score === 'number' && typeof rejection.threshold === 'number') {
    lines.push(`### Prior score: ${rejection.score} / threshold ${rejection.threshold}`);
    lines.push('');
  }

  if (failingTasks.length > 0) {
    lines.push('### Failing tasks from prior attempt:');
    for (const ft of failingTasks) {
      const num = typeof ft.task_index === 'number' ? `Task ${ft.task_index + 1}` : 'Task';
      const title = ft.task_title ? `: ${ft.task_title}` : '';
      lines.push(`- **${num}${title}** (score ${ft.score ?? '?'} / ${ft.threshold ?? '?'})`);
      const ftMissing = Array.isArray(ft.missing_specificity_signals) ? ft.missing_specificity_signals : [];
      if (ftMissing.length > 0) {
        lines.push(`  - Missing signals: ${ftMissing.join(', ')}`);
      }
      const ftReasons = Array.isArray(ft.reasons) ? ft.reasons : [];
      for (const r of ftReasons) lines.push(`  - ${r}`);
    }
    lines.push('');
  } else if (missingSignals.length > 0 || reasons.length > 0) {
    // Fallback: top-level signals when failing_tasks wasn't captured.
    if (missingSignals.length > 0) {
      lines.push(`### Missing signals: ${missingSignals.join(', ')}`);
    }
    if (reasons.length > 0) {
      lines.push('### Reasons:');
      for (const r of reasons) lines.push(`- ${r}`);
    }
    lines.push('');
  }

  lines.push('### Required for this attempt:');
  lines.push('- Cite **explicit file paths** in every task body (`bitsy/agent/session.py`, etc.)');
  lines.push('- State **estimated scope** ("~3 files", "two tests", "single helper")');
  lines.push('- Include **validation steps** (the exact command that proves the task is done)');
  lines.push('- Use **success criteria** language ("must", "should pass", "ensures that")');
  lines.push('- Avoid bare verbs like "improve", "handle", "as needed" without a backtick identifier nearby');
  lines.push('');

  return lines.join('\n');
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

function buildPlanQualityGateRejectPayload(gateVerdict) {
  const hardFails = Array.isArray(gateVerdict?.hardFails) ? gateVerdict.hardFails : [];
  const rules = [...new Set(hardFails.map((failure) => failure.rule).filter(Boolean))];
  const reasons = hardFails
    .map((failure) => failure.detail || failure.rule)
    .filter(Boolean);
  const failingTasks = hardFails.map((failure) => ({
    task_index: typeof failure.taskNumber === 'number' ? failure.taskNumber - 1 : null,
    task_title: null,
    score: null,
    threshold: null,
    missing_specificity_signals: failure.rule ? [failure.rule] : [],
    reasons: [failure.detail || failure.rule].filter(Boolean),
    rule: failure.rule || null,
    task_number: typeof failure.taskNumber === 'number' ? failure.taskNumber : null,
  }));
  const firstFailure = failingTasks[0] || {};

  return {
    code: 'plan_quality_gate_failed',
    failing_task_index: firstFailure.task_index ?? null,
    failing_task_title: null,
    score: null,
    threshold: null,
    missing_specificity_signals: rules,
    reasons,
    failing_tasks: failingTasks,
    feedback_prompt: gateVerdict?.feedbackPrompt || null,
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
  if (retireStalePendingPlanGenerationTask(taskCore, generationTask, {
    projectId: project.id,
    workItemId: workItem.id,
    reason: 'deferred_wait_recovery',
    requireSchedulerOwned: true,
  })) {
    let updatedWorkItem = workItem;
    try {
      updatedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
        origin_json: clearPlanGenerationWaitFields(origin),
        status: workItem.status || 'planned',
      });
      rememberSelectedWorkItem(instance.id, updatedWorkItem);
    } catch (error) {
      logger.warn('EXECUTE stage: failed to clear stale pending plan-generation wait fields', {
        project_id: project.id,
        work_item_id: workItem.id,
        generation_task_id: generationTaskId,
        err: error.message,
      });
    }

    logger.warn('EXECUTE stage: clearing stale pending plan-generation wait', {
      project_id: project.id,
      work_item_id: updatedWorkItem?.id || workItem.id,
      generation_task_id: generationTaskId,
      task_status: generationTask?.status || null,
      created_at: generationTask?.created_at || generationTask?.createdAt || null,
    });
    const updated = updateInstanceAndSync(instance.id, {
      paused_at_stage: null,
      last_action_at: nowIso(),
    });
    return {
      cleared: true,
      instance: updated,
      task_id: generationTaskId,
      task_status: generationTask?.status || null,
      wait_reason: 'stale_pending_plan_generation',
    };
  }

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

function getDeferredPlanGenerationWaitState(project, instance) {
  const workItem = tryGetSelectedWorkItem(instance, project.id, {
    fallbackToLoopSelection: true,
  });
  const generationTaskId = getStoredPlanGenerationTaskId(workItem);
  const origin = getWorkItemOriginObject(workItem);
  if (!workItem || !generationTaskId) {
    return null;
  }

  if (origin.plan_path && fs.existsSync(origin.plan_path)) {
    return {
      waiting: false,
      ready_to_advance: true,
      plan_materialized: true,
      work_item_id: workItem.id,
      task_id: generationTaskId,
      task_status: null,
    };
  }

  const taskCore = require('../db/task-core');
  const generationTask = getPlanGenerationTask(taskCore, generationTaskId);
  const wait = getPlanGenerationWait(generationTask);
  const taskStatus = generationTask?.status || null;
  return {
    waiting: isPlanGenerationTaskPending(generationTask),
    ready_to_advance: !isPlanGenerationTaskPending(generationTask),
    plan_materialized: false,
    work_item_id: workItem.id,
    task_id: generationTaskId,
    task_status: taskStatus,
    wait_reason: normalizeOptionalString(wait?.reason) || null,
    retry_after: normalizeOptionalString(wait?.retry_after),
  };
}

// Phase X5 (2026-05-01): when same-shape failures repeat, escalate.
// "Same shape" = the normalized rejection reason matches the prior N
// rejections AND any structured signals (missing_specificity_signals)
// also match. After SAME_SHAPE_THRESHOLD repeats, the system bumps to
// the next architect provider in the project's provider_chain. After
// the chain is exhausted (no more providers to try), the work item
// transitions to terminal 'escalation_exhausted' — distinct from
// 'rejected' so the dashboard shows "system tried everything" vs
// "system gave up after N retries."
const SAME_SHAPE_THRESHOLD = 3;
const ESCALATION_HISTORY_MAX = 20;

// Strip variable parts (UUIDs, error messages) so two rejections from
// the same root cause normalize to the same key.
function normalizeRejectionReasonForShape(reason) {
  if (!reason || typeof reason !== 'string') return 'unknown';
  // Drop everything after the first colon (": ${err.message}", task IDs, etc.)
  const head = reason.split(':')[0].trim();
  return head.toLowerCase();
}

function readProjectProviderChain(projectId) {
  try {
    const project = factoryHealth.getProject(projectId);
    if (!project) return [];

    if (project.provider_chain_json) {
      const parsed = JSON.parse(project.provider_chain_json);
      if (Array.isArray(parsed)) {
        return parsed.filter((p) => typeof p === 'string' && p);
      }
    }

    const policy = specializePolicyForKind(
      getProviderLanePolicyFromProject(project),
      'architect_cycle'
    );
    if (!policy) return [];

    const chain = [
      policy.expected_provider,
      ...(Array.isArray(policy.allowed_fallback_providers) ? policy.allowed_fallback_providers : []),
      ...(Array.isArray(policy.allowed_providers) ? policy.allowed_providers : []),
    ]
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim().toLowerCase());
    return [...new Set(chain)];
  } catch (_e) {
    return [];
  }
}

function detectSameShapeEscalation(escalationHistory, currentEntry) {
  if (!Array.isArray(escalationHistory) || escalationHistory.length < SAME_SHAPE_THRESHOLD - 1) {
    return false;
  }
  const recent = escalationHistory.slice(-(SAME_SHAPE_THRESHOLD - 1));
  const currentShape = normalizeRejectionReasonForShape(currentEntry.reason);
  const currentSignals = (currentEntry.missing_signals || []).slice().sort().join(',');
  for (const entry of recent) {
    if (normalizeRejectionReasonForShape(entry.reason) !== currentShape) return false;
    const sig = (entry.missing_signals || []).slice().sort().join(',');
    if (sig !== currentSignals) return false;
  }
  return true;
}

function buildTerminalEscalationRejectReason(workItem, evidence) {
  const existing = String(workItem?.reject_reason || '').trim();
  if (/^escalation_exhausted\b/i.test(existing)) {
    return existing;
  }
  const kind = evidence?.kind || 'terminal_escalation';
  const shape = evidence?.reason_shape ? ` (${evidence.reason_shape})` : '';
  return `escalation_exhausted: ${kind}${shape}`;
}

function restoreTerminalEscalationWorkItem(workItem, evidence = null) {
  if (!workItem?.id) return workItem;
  const terminalEvidence = evidence
    || factoryIntake.getTerminalEscalationEvidence?.(workItem)
    || null;
  if (!terminalEvidence) return workItem;

  return factoryIntake.updateWorkItem(workItem.id, {
    status: 'escalation_exhausted',
    reject_reason: buildTerminalEscalationRejectReason(workItem, terminalEvidence),
  }) || workItem;
}

// Phase X4 (2026-05-01): generic helper for routing a work item to
// needs_replan. Used by the LLM-semantic gate, parse-error, timeout,
// empty-branch, and replan-generation-failed paths — every reject reason
// EXCEPT operator-rejected and "no description" (which has no replan
// possible).
//
// Phase X5 (2026-05-01): same-shape escalation. When the prior N
// rejections all normalize to the same shape (same reason category +
// same missing-signals set), bump architect_provider_override in
// constraints_json to the next provider in the project's chain. When
// the chain is exhausted, transition to terminal 'escalation_exhausted'
// (distinct from 'rejected' so operators see "system tried everything").
function routeWorkItemToNeedsReplan(workItem, { reason, attempt = null, details = null } = {}) {
  if (!workItem || !workItem.id) return workItem;
  const existingOrigin = getWorkItemOriginObject(workItem) || {};
  const detailObject = details && typeof details === 'object' ? details : null;
  const detailPlanQualityRejection = detailObject?.last_plan_description_quality_rejection || null;
  const terminalEscalation = factoryIntake.getTerminalEscalationEvidence?.({
    ...workItem,
    origin: existingOrigin,
  });
  if (terminalEscalation) {
    return restoreTerminalEscalationWorkItem(workItem, terminalEscalation);
  }

  // Phase X5: never overwrite a terminal status. Once an item reaches
  // escalation_exhausted, rejected, completed, etc., subsequent routing
  // calls (defensive caller behavior) must not resurrect it. The
  // operator owns terminal items.
  const TERMINAL_BAILOUT = new Set(['rejected', 'shipped', 'shipped_stale', 'completed', 'unactionable', 'needs_review', 'superseded', 'escalation_exhausted']);
  if (TERMINAL_BAILOUT.has(workItem.status)) {
    return workItem;
  }
  const reasonStr = String(reason || 'unknown');
  const missingSignals = detailPlanQualityRejection?.missing_specificity_signals
    || existingOrigin?.last_plan_description_quality_rejection?.missing_specificity_signals
    || [];

  // Build escalation history first so same-shape detection has data.
  const priorHistory = Array.isArray(existingOrigin.escalation_history)
    ? existingOrigin.escalation_history.slice(-ESCALATION_HISTORY_MAX + 1)
    : [];
  const currentEntry = {
    reason: reasonStr,
    attempt,
    missing_signals: missingSignals,
    ts: new Date().toISOString(),
  };
  const escalationHistory = [...priorHistory, currentEntry];

  // Read constraints to know which provider is currently in play.
  let constraints = {};
  try {
    constraints = workItem.constraints_json
      ? (typeof workItem.constraints_json === 'string'
        ? JSON.parse(workItem.constraints_json)
        : workItem.constraints_json) || {}
      : {};
  } catch (_e) { constraints = {}; }
  const currentProvider = constraints.architect_provider_override || null;

  // Same-shape escalation check.
  let escalation = null;
  if (detectSameShapeEscalation(priorHistory, currentEntry)) {
    const chain = readProjectProviderChain(workItem.project_id);
    if (chain.length > 0) {
      // When no override is set, the project defaults to chain[0] — so
      // the first escalation must move PAST chain[0] to chain[1]. Mirrors
      // recovery-strategies/escalate-architect.js logic.
      let currentIdx = currentProvider ? chain.indexOf(currentProvider) : 0;
      if (currentIdx < 0) currentIdx = 0;
      const nextIdx = currentIdx + 1;
      if (nextIdx < chain.length) {
        const nextProvider = chain[nextIdx];
        constraints = { ...constraints, architect_provider_override: nextProvider };
        escalation = {
          kind: 'provider_switch',
          from: currentProvider,
          to: nextProvider,
          reason_shape: normalizeRejectionReasonForShape(reasonStr),
          consecutive_same_shape: SAME_SHAPE_THRESHOLD,
        };
      } else {
        escalation = {
          kind: 'chain_exhausted',
          from: currentProvider,
          chain,
          reason_shape: normalizeRejectionReasonForShape(reasonStr),
        };
      }
    } else {
      escalation = {
        kind: 'no_provider_chain',
        reason_shape: normalizeRejectionReasonForShape(reasonStr),
      };
    }
  }

  // When an escalation fires, reset escalation_history so the new
  // provider gets a fresh window of SAME_SHAPE_THRESHOLD attempts before
  // the next escalation kicks in. Without this reset, the moment we
  // escalate to provider B, the previous SAME_SHAPE_THRESHOLD-1 entries
  // in history still match — so the very next rejection would re-trigger
  // escalation and burn through the chain in a single tick.
  const persistedHistory = escalation ? [currentEntry] : escalationHistory;

  // Clear plan-generation wait fields so the next pickup creates a FRESH
  // task instead of re-awaiting the cached failure. Without this, a work
  // item that lands in needs_replan with a stale plan_generation_task_id
  // gets stuck in an infinite loop: PRIORITIZE → PLAN → re-await stale
  // task → cached failure → routeWorkItemToNeedsReplan → PRIORITIZE...
  // Live evidence (example-project work item #2078, 2026-05-02): task f387eef6
  // failed on 2026-04-29 02:49 UTC, then the loop replayed its cached
  // "Aborted at iteration 2" error every ~1-10 minutes for THREE DAYS.
  const baseOrigin = clearPlanGenerationWaitFields(existingOrigin);

  // Also delete the stale plan file from disk so the next pickup forces a
  // fresh architect plan generation. Without this, plan_path is cleared
  // from origin but the file persists with all-[x] markers from the prior
  // attempt — and on the next pickup, EXECUTE re-discovers the file (if
  // the architect happens to write to the same path) and Phase U trusts
  // the stale [x] markers, producing empty branches indefinitely.
  // Live evidence (example-project item #2048, 2026-05-02): plan file with both
  // tasks marked [x] persisted across cycles. Each pickup completed
  // EXECUTE in 3s with no diff, routed back via empty_branch_after_execute,
  // hit Phase X5 same-shape escalation in 3 cycles, terminally exhausted.
  const stalePlanPath = existingOrigin?.plan_path;
  if (stalePlanPath && typeof stalePlanPath === 'string') {
    try {
      if (fs.existsSync(stalePlanPath)) {
        fs.unlinkSync(stalePlanPath);
      }
    } catch (err) {
      logger.warn('routeWorkItemToNeedsReplan: could not delete stale plan file', {
        work_item_id: workItem.id,
        plan_path: stalePlanPath,
        err: err.message,
      });
    }
  }

  const origin = {
    ...baseOrigin,
    ...(detailPlanQualityRejection ? { last_plan_description_quality_rejection: detailPlanQualityRejection } : {}),
    ...(detailObject?.last_gate_feedback ? { last_gate_feedback: detailObject.last_gate_feedback } : {}),
    last_rejection_reason: reasonStr,
    ...(attempt !== null ? { last_rejection_attempt: attempt } : {}),
    ...(details ? { last_rejection_details: details } : {}),
    last_rejected_at: new Date().toISOString(),
    escalation_history: persistedHistory,
    ...(escalation ? { last_escalation: escalation } : {}),
  };
  delete origin.plan_path;

  // Decide terminal vs needs_replan:
  //   provider_switch → needs_replan with new architect override
  //   chain_exhausted / no_provider_chain → terminal escalation_exhausted
  //   no escalation triggered → needs_replan as usual
  const escalationTerminal = escalation
    && (escalation.kind === 'chain_exhausted' || escalation.kind === 'no_provider_chain');
  const newStatus = escalationTerminal ? 'escalation_exhausted' : 'needs_replan';
  const newRejectReason = escalationTerminal
    ? `escalation_exhausted: ${escalation.kind} after ${SAME_SHAPE_THRESHOLD}× same-shape (${normalizeRejectionReasonForShape(reasonStr)})`
    : reasonStr;

  return factoryIntake.updateWorkItem(workItem.id, {
    status: newStatus,
    reject_reason: newRejectReason,
    origin_json: origin,
    ...(escalation && escalation.kind === 'provider_switch'
      ? { constraints_json: JSON.stringify(constraints) }
      : {}),
  });
}

function routePlanQualityGateFailureToNeedsReplan(workItem, gateVerdict, {
  reason = 'pre_written_plan_rejected_by_quality_gate',
  attempt = null,
} = {}) {
  const hardFails = Array.isArray(gateVerdict?.hardFails) ? gateVerdict.hardFails : [];
  const rejectPayload = buildPlanQualityGateRejectPayload(gateVerdict);
  return routeWorkItemToNeedsReplan(workItem, {
    reason,
    attempt,
    details: {
      hardFails: hardFails.map((failure) => failure.rule).filter(Boolean),
      rule_violations: hardFails,
      last_plan_description_quality_rejection: rejectPayload,
      ...(gateVerdict?.feedbackPrompt ? { last_gate_feedback: gateVerdict.feedbackPrompt } : {}),
    },
  });
}

// Phase X3 (2026-05-01): plan-quality is no longer a terminal failure.
// Previously, after PLAN_QUALITY_REJECT_CAP (5) attempts the work item
// moved to status 'rejected' and was forgotten. The user's directive:
// "plans should be rejected, then get reworked until they can be approved
// vs reject and forget." All plan-quality failures now route to
// 'needs_replan' (Phase X1 status) so PRIORITIZE re-picks them with
// the X2 prior-rejection feedback injected into the next architect prompt.
//
// The cap stays only as an OBSERVABILITY signal: when an item's attempt
// count crosses the (now-soft) threshold, we log a decision so operators
// can see "this item has tried 5+ times" — but we never abandon it.
// Phase X5 will add strategy escalation (different provider, decompose,
// operator notification) when same-shape failures persist.
const PLAN_QUALITY_SOFT_THRESHOLD = 5;

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

  // Phase X3: log the soft-threshold crossing for observability, but DO NOT
  // reject. The work item stays alive, gets routed to needs_replan with
  // updated rejection feedback, and PRIORITIZE will re-pick it (after the
  // Phase X1 cooldown) so the architect can try again — this time with the
  // Phase X2 PRIOR PLAN REJECTED block prepended to its prompt.
  if (attemptCount >= PLAN_QUALITY_SOFT_THRESHOLD) {
    logger.warn('PLAN: plan-quality soft threshold crossed — continuing via needs_replan', {
      project_id: project.id,
      work_item_id: workItem.id,
      attempt_count: attemptCount,
      soft_threshold: PLAN_QUALITY_SOFT_THRESHOLD,
    });

    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.PLAN,
      action: 'plan_quality_soft_threshold_crossed',
      reasoning: `Plan-quality gate has rejected ${attemptCount} architect-generated plans for this work item — past the soft threshold of ${PLAN_QUALITY_SOFT_THRESHOLD}. Per the plan-evolution model, the work item is NOT being rejected; it stays in needs_replan with feedback for the next architect attempt. A future strategy-escalation phase (Phase X5) will switch architect provider or decompose when same-shape failures persist.`,
      inputs: { ...getWorkItemDecisionContext(workItem) },
      outcome: {
        ...rejectPayload,
        work_item_id: workItem.id,
        attempt_count: attemptCount,
        soft_threshold: PLAN_QUALITY_SOFT_THRESHOLD,
        plan_path: planPath || null,
        generator,
        generation_task_id: generationTaskId,
      },
      confidence: 1,
      batch_id: getDecisionBatchId(project, workItem, null, instance),
    });
    // Fall through to the standard needs_replan path below — same code,
    // same persistence, just with the soft-threshold note logged above.
  }

  const origin = {
    ...existingOrigin,
    last_plan_description_quality_rejection: rejectPayload,
    plan_description_quality_rejection_count: attemptCount,
  };
  delete origin.plan_path;

  // Phase X3: needs_replan instead of prioritized. PRIORITIZE picks both
  // up (X1's WORK_ITEM_STATUS_ORDER), but needs_replan also triggers the
  // 5-min cooldown so the item doesn't immediately re-loop, AND signals
  // operator-visibly that this item has been through a rejection cycle
  // (vs a fresh prioritized item).
  const updatedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
    status: 'needs_replan',
    reject_reason: rejectReason,
    origin_json: origin,
  });

  if (instance?.id) {
    rememberSelectedWorkItem(instance.id, updatedWorkItem);
  }

  safeLogDecision({
    project_id: project.id,
    stage: LOOP_STATES.PLAN,
    action: 'plan_description_quality_routed_to_needs_replan',
    reasoning: `Auto-generated plan task descriptions were below the deterministic specificity threshold; routing item to needs_replan with prior-rejection feedback (attempt ${attemptCount}, soft threshold ${PLAN_QUALITY_SOFT_THRESHOLD}). PRIORITIZE will re-pick after the Phase X1 cooldown and the architect will see the Phase X2 PRIOR PLAN REJECTED block.`,
    inputs: {
      ...getWorkItemDecisionContext(workItem),
    },
    outcome: {
      ...rejectPayload,
      work_item_id: updatedWorkItem.id,
      attempt_count: attemptCount,
      soft_threshold: PLAN_QUALITY_SOFT_THRESHOLD,
      next_state: LOOP_STATES.PRIORITIZE,
      next_status: 'needs_replan',
      plan_path: planPath || null,
      generator,
      generation_task_id: generationTaskId,
    },
    confidence: 1,
    batch_id: getDecisionBatchId(project, updatedWorkItem, null, instance),
  });

  return {
    reason: 'plan description quality rejected — routed to needs_replan',
    work_item: updatedWorkItem,
    stop_execution: true,
    next_state: LOOP_STATES.PRIORITIZE,
    stage_result: {
      status: 'needs_replan',
      reason: 'plan_description_quality_rejected',
      reject_reason: rejectReason,
      attempt_count: attemptCount,
      soft_threshold: PLAN_QUALITY_SOFT_THRESHOLD,
      description_quality: rejectPayload,
      plan_path: planPath || null,
      generator,
      generation_task_id: generationTaskId,
    },
  };
}

const {
  executeNonPlanFileStage,
  executePlanFileStage,
} = createExecuteStage({
  ...stageSharedContext,
  AUTO_ADVANCE_DEFERRED_FALLBACK_DELAY_MS,
  EXECUTE_DEFERRED_STALE_MS,
  ExecuteDeferredPausedError,
  IN_FLIGHT_SAME_WI_SKIP_LOG_INTERVAL_MS,
  IN_FLIGHT_SAME_WI_SKIP_TRACKING_MAX_ENTRIES,
  LIVE_WORKTREE_OWNER_STATUSES,
  LOOP_STATES,
  PLAN_GENERATION_UNUSABLE_OUTPUT_RETRIES,
  PLAN_GENERATOR_LABEL,
  REUSABLE_WORKTREE_OWNER_STATUSES,
  awaitTaskToStructuredResult,
  buildAutoGeneratedPlanPath,
  buildAutoGeneratedPlanPrompt,
  buildPlanFromFileEditsProposal,
  buildPlanGenerationActivityTimeoutPolicy,
  buildPlanGenerationDeferredResult,
  buildPlanGenerationRetryResult,
  buildProviderLaneTaskMetadata,
  clearPlanGenerationWaitFields,
  collectArchitectScopeFiles,
  createPlanReviewer,
  database,
  elapsedMsSince,
  eventBus,
  factoryDecisions,
  factoryIntake,
  factoryNotifications,
  factoryWorktrees,
  findActivePlanGenerationTask,
  findExistingPlanTaskSubmission,
  findLiveReplacementWorktreeOwner,
  fs,
  getDecisionBatchId,
  getDecisionRowWorkItemId,
  getFactorySubmissionBatchId,
  getPlanGenerationRetryCount,
  getPlanGenerationTask,
  getPlanGenerationWait,
  getPlanGeneratorLabel,
  getPostStageTransition,
  getProjectConfigForPlanGate,
  getProjectOrThrow,
  getSelectedWorkItem,
  getStoredPlanGenerationTaskId,
  getStoredPlanGeneratorProvider,
  getTaskAgeMs,
  getWorkItemDecisionContext,
  getWorkItemOriginObject,
  getWorktreeDirtyStatus,
  getWorktreeRunner,
  hydrateDecisionRow,
  inFlightSameWiSkipEmitTimestamps,
  isPlanGenerationTaskPending,
  lintAutoGeneratedPlan,
  logger,
  normalizeAutoGeneratedPlanMarkdown,
  normalizeOptionalString,
  normalizeWorkItemId,
  nowIso,
  parseJsonObject,
  parsePlanFile,
  path,
  persistPlanGenerationTaskReplacement,
  rememberSelectedWorkItem,
  resolveExecuteMode,
  resolvePlanGenerationTimeoutMinutes,
  resolveTaskReplacementChain,
  retireStalePendingPlanGenerationTask,
  returnAutoGeneratedPlanToPrioritizeForDescriptionQuality,
  routeHeavyValidationCommands,
  routePlanQualityGateFailureToNeedsReplan,
  routeWorkItemToNeedsReplan,
  safeLogDecision,
  selectReviewers,
  trimPromptEchoTail,
  unwrapWholeMarkdownFence,
  updateInstanceAndSync,
  extractTextContent,
});

function getExecutePlanStageForTransition() {
  return module.exports?._internalForTests?.executePlanStage || executePlanStage;
}

const {
  VERIFY_FIX_PROMPT_PRIOR_BUDGET,
  VERIFY_FIX_PROMPT_TAIL_BUDGET,
  attemptSilentRerun,
  batchBranchHasCommitsAhead,
  batchHasAutoCommittedTask,
  buildPriorAttemptsBlock,
  buildVerifyFixPrompt,
  computeScopeEnvelope,
  countConsecutiveAutoCommitSkippedClean,
  countPriorVerifyRetryTasksForBatch,
  detectVerifyStack,
  enforceVerifyRetryScopeEnvelope,
  executeVerifyStage,
  extractScopeEnvelopeFiles,
  getVerifyRetryDiffFiles,
  getVerifyStackGuidance,
  isFactoryFeatureEnabled,
  isOutOfScope,
  maybeShipNoop,
  maybeShortCircuitZeroDiffExecute,
  renderProgression,
  resolveFactoryVerifyCommand: resolveFactoryVerifyCommandForTests,
  runExecuteVerifyStage,
  setExecuteVerifyStageForTests,
} = createVerifyStage({
  ...stageSharedContext,
  LOOP_STATES,
  awaitTaskToStructuredResult,
  baselineRequeue,
  branchFreshness,
  buildProviderLaneTaskMetadata,
  childProcess,
  createShippedDetector,
  detectDefaultBranch,
  eventBus,
  factoryDecisions,
  factoryHealth,
  factoryIntake,
  factoryWorktrees,
  fs,
  getEffectiveProjectProvider,
  getProjectOrThrow,
  getWorkItemDecisionContext,
  getWorktreeRunner,
  guardrailRunner,
  isProjectStatusPaused,
  listTasksForFactoryBatch,
  logger,
  resolveFactoryVerifyCommand,
  routeWorkItemToNeedsReplan,
  safeLogDecision,
});


const {
  countPriorEmptyMergeFailuresForWorkItem,
  isEmptyBranchMergeError,
  isMergeTargetOperatorBlockedError,
  runExecuteLearnStage,
  setExecuteLearnStageForTests,
  shouldQuarantineForEmptyMerges,
} = createLearnStage({
  ...stageSharedContext,
  CLOSED_WORK_ITEM_STATUSES,
  LOOP_STATES,
  PENDING_APPROVAL_FAILURE_TASK_STATUSES,
  PENDING_APPROVAL_SUCCESS_TASK_STATUSES,
  createShippedDetector,
  detectDefaultBranch,
  factoryDecisions,
  factoryHealth,
  factoryIntake,
  factoryWorktrees,
  fs,
  getDecisionRowWorkItemId,
  getLatestExecutionDecisionForWorkItem,
  getLatestStartedExecutionDecision,
  getProjectOrThrow,
  getRememberedSelectedWorkItemId: (instance_id) => normalizeWorkItemId(selectedWorkItemIds.get(instance_id)),
  getWorktreeRunner,
  listTasksForFactoryBatch,
  logger,
  normalizeWorkItemId,
  rememberSelectedWorkItem,
  routeWorkItemToNeedsReplan,
  safeLogDecision,
});

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
  if (isProjectPauseActive(project, { includeStatus: false })) {
    if (project.status !== 'paused') {
      try {
        factoryHealth.updateProject(project.id, { status: 'paused' });
      } catch (_err) {
        void _err;
      }
    }
    safeLogDecision({
      project_id: project.id,
      stage: LOOP_STATES.SENSE,
      action: 'start_loop_blocked_project_paused',
      reasoning: 'Factory loop start was refused because the project has an operator pause marker. Resume the project before starting the loop.',
      inputs: {
        current_status: project.status,
        operator_paused: true,
        previous_state: getCurrentLoopState(project),
      },
      outcome: {
        started: false,
        status: 'paused',
      },
      confidence: 1,
      batch_id: null,
    });
    throw new Error('Cannot start factory loop for paused project; resume_project first');
  }
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

function getClosedWorkItemLoopStopReason(workItem) {
  if (!workItem) return null;
  if (factoryIntake.CLOSED_STATUSES?.has(workItem.status)) {
    return `work_item_closed_${workItem.status}`;
  }
  const terminalEscalation = factoryIntake.getTerminalEscalationEvidence?.(workItem);
  if (terminalEscalation?.source === 'reject_reason') {
    return 'work_item_closed_escalation_exhausted_reject_reason';
  }
  if (terminalEscalation) {
    return 'work_item_closed_escalation_exhausted_origin';
  }
  return null;
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
      const retryAfter = new Date(Date.now() + AUTO_ADVANCE_DEFERRED_FALLBACK_DELAY_MS).toISOString();
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
          retry_after: retryAfter,
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

      const closedWorkItemReason = getClosedWorkItemLoopStopReason(targetItem);
      if (closedWorkItemReason) {
        let finalWorkItem = targetItem;
        if (
          closedWorkItemReason === 'work_item_closed_escalation_exhausted_reject_reason'
          || closedWorkItemReason === 'work_item_closed_escalation_exhausted_origin'
        ) {
          try {
            finalWorkItem = restoreTerminalEscalationWorkItem(targetItem) || targetItem;
          } catch (err) {
            logger.warn('Factory loop: failed to restore terminal escalation_exhausted work item status', {
              project_id: project.id,
              work_item_id: targetItem.id,
              status: targetItem.status,
              err: err.message,
            });
          }
        }
        const lastActionAt = instance.last_action_at || null;
        terminateInstanceAndSync(instance.id);
        recordFactoryIdleIfExhausted(project.id, {
          last_action_at: lastActionAt,
          reason: closedWorkItemReason,
        });
        try {
          safeLogDecision({
            project_id: project.id,
            stage: String(currentState || '').toLowerCase(),
            actor: 'loop-controller',
            action: 'closed_work_item_loop_stopped',
            reasoning: `Loop instance stopped because work item ${targetItem.id} is closed (${finalWorkItem.status || targetItem.status}).`,
            outcome: {
              work_item_id: targetItem.id,
              work_item_status: finalWorkItem.status || targetItem.status,
              reject_reason: finalWorkItem.reject_reason || targetItem.reject_reason || null,
            },
            batch_id: instance.batch_id || getDecisionBatchId(project, finalWorkItem),
          });
        } catch (_err) { void _err; }
        return {
          project_id: project.id,
          instance_id: instance.id,
          previous_state: previousState,
          new_state: LOOP_STATES.IDLE,
          paused_at_stage: null,
          stage_result: {
            status: 'stopped',
            reason: closedWorkItemReason,
            work_item_id: targetItem.id,
            work_item_status: finalWorkItem.status || targetItem.status,
          },
          reason: closedWorkItemReason,
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
          if (generated.next_state === LOOP_STATES.EXECUTE && !generated.paused_at_stage) {
            instance = updateInstanceAndSync(instance.id, {
              paused_at_stage: null,
              last_action_at: nowIso(),
            });
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
        if (executeStage.next_state === LOOP_STATES.EXECUTE && !executeStage.paused_at_stage) {
          instance = updateInstanceAndSync(instance.id, {
            paused_at_stage: null,
            last_action_at: nowIso(),
          });
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
      const currentBatchAlreadyVerified = Boolean(
        instance.batch_id
        && !rerunApprovedVerify
        && hasVerifiedBatchDecision(project.id, instance.batch_id)
      );
      if (currentBatchAlreadyVerified) {
        stageResult = {
          status: 'skipped',
          reason: 'batch_already_verified',
          batch_id: instance.batch_id,
        };
      } else {
        stageResult = await runExecuteVerifyStage(project.id, instance.batch_id, instance);
      }
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
      stageResult = await runExecuteLearnStage(project.id, instance.batch_id, instance);
      if (stageResult?.shipping_result?.status === 'paused') {
        instance = updateInstanceAndSync(instance.id, {
          paused_at_stage: stageResult.shipping_result.pause_at_stage || LOOP_STATES.LEARN,
          last_action_at: nowIso(),
        });
        transitionReason = stageResult.shipping_result.reason || 'shipping_paused';
        break;
      }
      const latestProject = getProjectOrThrow(project.id);
      if (isProjectPauseActive(latestProject)) {
        const lastActionAt = instance.last_action_at || null;
        terminateInstanceAndSync(instance.id);
        recordFactoryIdleIfExhausted(project.id, {
          last_action_at: lastActionAt,
          reason: 'project_paused_after_learn',
        });
        return {
          project_id: project.id,
          instance_id,
          previous_state: previousState,
          new_state: LOOP_STATES.IDLE,
          paused_at_stage: null,
          stage_result: stageResult,
          reason: 'project_paused_after_learn',
        };
      }
      const cfg = parseProjectConfigObject(latestProject);
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
    auto_advance_delay_ms: null,
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
      const shouldAutoAdvance = autoAdvance
        && result.new_state !== LOOP_STATES.IDLE
        && result.new_state !== LOOP_STATES.STARVED
        && !result.paused_at_stage
        && !isProjectStatusPaused(project.id);
      job.auto_advance_delay_ms = shouldAutoAdvance ? getAutoAdvanceDelayMs(result) : null;
      job.completed_at = nowIso();
      emitLoopAdvanceJobEvent(job);

      // Auto-advance: if the caller requested continuous driving AND the
      // instance is neither terminated (IDLE) nor paused at a gate AND the
      // project row isn't paused, enqueue the next advance. Fast stages keep
      // the short delay, while deferred stages honor their retry window.
      // The project-row check stops the chain the moment pause_project lands,
      // without waiting for the current stage to finish.
      if (shouldAutoAdvance) {
        scheduleAutoAdvance(instance_id, job.auto_advance_delay_ms);
      } else {
        clearScheduledAutoAdvance(instance.id);
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
        scheduleAutoAdvance(instance_id, 30000, {
          debugMessage: 'Auto-advance retry after failure also failed',
        });
      } else {
        clearScheduledAutoAdvance(instance.id);
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
  clearScheduledAutoAdvance(instance.id);
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
  getDeferredPlanGenerationWaitState,
  buildAutoGeneratedPlanPrompt,
  buildPriorRejectionFeedbackPrompt,
  routeWorkItemToNeedsReplan,
  detectSameShapeEscalation,
  normalizeRejectionReasonForShape,
  SAME_SHAPE_THRESHOLD,
  resolvePlanGenerationTimeoutMinutes,
  buildPlanGenerationActivityTimeoutPolicy,
  getEffectiveProjectProvider,
  OLLAMA_PLAN_GENERATION_TIMEOUT_MINUTES,
  DEFAULT_PLAN_GENERATION_TIMEOUT_MINUTES,
  DEFAULT_STALE_PENDING_PLAN_GENERATION_MS,
  buildVerifyFixPrompt,
  detectVerifyStack,
  getVerifyStackGuidance,
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
    batchHasAutoCommittedTask,
    batchBranchHasCommitsAhead,
    maybeShortCircuitZeroDiffExecute,
    attemptSilentRerun,
    isFactoryFeatureEnabled,
    setExecuteVerifyStageForTests,
    setExecuteLearnStageForTests,
    extractScopeEnvelopeFiles,
    computeScopeEnvelope,
    isOutOfScope,
    getVerifyRetryDiffFiles,
    enforceVerifyRetryScopeEnvelope,
    resolveFactoryVerifyCommand: resolveFactoryVerifyCommandForTests,
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
    isStaleNeverStartedPendingPlanGenerationTask,
    getAutoAdvanceDelayMs,
    getTaskAgeMs,
    scheduleAutoAdvanceForTests: (instance_id, delay_ms, onAdvance) => scheduleAutoAdvance(instance_id, delay_ms, { onAdvance }),
    clearScheduledAutoAdvanceForTests: clearScheduledAutoAdvance,
    getScheduledAutoAdvanceForTests: (instance_id) => {
      const scheduled = scheduledAutoAdvanceTimers.get(instance_id);
      if (!scheduled) {
        return null;
      }
      return {
        delay_ms: scheduled.delay_ms,
        scheduled_at: scheduled.scheduled_at,
      };
    },
    lintAutoGeneratedPlan,
    parseAutoGeneratedPlanTasks,
    normalizeAutoGeneratedPlanMarkdown,
    buildPlanFromFileEditsProposal,
    augmentAutoGeneratedTaskSpecificity,
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
