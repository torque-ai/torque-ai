'use strict';
/* eslint-disable torque/no-sync-fs-on-hot-paths -- factory-handlers sync calls are in plan/scout file reading at MCP tool invocation time; Phase 2 async conversion tracked separately. */

const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
// Lazy-resolve the database via the DI container at call time. database.js
// registers the facade as 'db' on defaultContainer during init() and
// resetForTest(), so this is the single source of truth in normal runtime.
// Some test contexts construct handlers before container.boot() runs; in
// that case fall back to the direct database module facade so handlers
// don't crash with "Container: get('db') called before boot()". The
// fallback is necessary even though it re-introduces a database.js
// require — the alternative is breaking ~4 plan-file MCP-tool tests that
// exercise factory-handlers without booting the full container.
function getDatabase() {
  try {
    const { defaultContainer } = require('../container');
    return defaultContainer.get('db');
  } catch {
    // Container not booted (some tests construct handlers before
    // container.boot() runs). Fall back to the direct facade.
    return require('../database');
  }
}
// The shared TestRunnerRegistry is the only one the remote-agents plugin
// registers overrides on. A fresh instance created here would silently
// bypass remote routing (its _overrides is null) and run verify_command
// locally — spawning the full dotnet/vitest/etc. test chain on the dev box.
// Always prefer the container singleton; fall back to a fresh instance only
// in pre-boot test contexts.
function getTestRunnerRegistry() {
  try {
    const { defaultContainer } = require('../container');
    const registry = defaultContainer.get('testRunnerRegistry');
    if (registry) return registry;
  } catch { /* fall through to pre-boot fallback */ }
  return require('../test-runner-registry').createTestRunnerRegistry();
}
const factoryDecisions = require('../db/factory-decisions');
const factoryAudit = require('../db/factory-audit');
const factoryArchitect = require('../db/factory-architect');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const { runArchitectCycle } = require('../factory/architect-runner');
const { scoreAll, resolveHealthScanSourceDirs } = require('../factory/scorer-registry');
const { runPreBatchChecks, runPostBatchChecks, runPreShipChecks, getGuardrailSummary } = require('../factory/guardrail-runner');
const guardrailDb = require('../db/factory-guardrails');
const loopController = require('../factory/loop-controller');
const baselineRequeue = require('../factory/baseline-requeue');
const { pollGitHubIssues } = require('../factory/github-intake');
const { createPlanFileIntake } = require('../factory/plan-file-intake');
const { validatePlansDir } = require('../factory/plans-dir-validator');
const { guardIntakeItem } = require('../factory/meta-intake-guard');
const { createShippedDetector } = require('../factory/shipped-detector');
const { analyzeBatch, detectDrift, recordHumanCorrection } = require('../factory/feedback');
const { buildProjectCostSummary, getCostPerCycle, getCostPerHealthPoint, getProviderEfficiency } = require('../factory/cost-metrics');
const { getAuditTrail, getDecisionContext, getDecisionStats } = require('../factory/decision-log');
const { buildProviderLaneAudit } = require('../factory/provider-lane-audit');
const { LOOP_STATES } = require('../factory/loop-states');
const notifications = require('../factory/notifications');
const { ErrorCodes, makeError } = require('./error-codes');
const logger = require('../logger').child({ component: 'factory-handlers' });

const STALL_THRESHOLD_MS = 30 * 60 * 1000;
const COMMITS_TODAY_CACHE_TTL_MS = 60 * 1000;
const COMMITS_TODAY_TIMEOUT_MS = 5 * 1000;
const TERMINAL_FACTORY_BATCH_TASK_STATUSES = new Set(['completed', 'shipped', 'cancelled', 'failed', 'skipped']);
const TERMINAL_FACTORY_INTERNAL_TASK_STATUSES = TERMINAL_FACTORY_BATCH_TASK_STATUSES;
const ACTIVE_FACTORY_BATCH_TASK_STATUS_RANK = new Map([
  ['running', 0],
  ['pending_provider_switch', 1],
  ['retry_scheduled', 2],
  ['queued', 3],
  ['pending', 4],
  ['waiting', 5],
  ['blocked', 6],
]);
const BASELINE_RESUME_JOBS_TO_KEEP_PER_PROJECT = 25;
const commitsTodayCache = new Map();
const baselineResumeJobs = new Map();

function getCachedCommitsToday(projectPath, nowMs = Date.now()) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return null;
  }
  const cached = commitsTodayCache.get(projectPath);
  if (!cached) {
    return null;
  }
  if ((nowMs - cached.cachedAtMs) >= COMMITS_TODAY_CACHE_TTL_MS) {
    commitsTodayCache.delete(projectPath);
    return null;
  }
  return cached.commitsToday;
}

function isExplicitFalse(value) {
  if (value === false || value === 0) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  return ['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
}

function isBasicProjectListRequest(args = {}) {
  const summary = typeof args.summary === 'string' ? args.summary.trim().toLowerCase() : '';
  const detail = typeof args.detail === 'string' ? args.detail.trim().toLowerCase() : '';
  const fields = typeof args.fields === 'string' ? args.fields.trim().toLowerCase() : '';

  return summary === 'basic'
    || detail === 'basic'
    || fields === 'basic'
    || args.basic === true
    || args.basic === 'true';
}

function summarizeBasicFactoryProject(project) {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    trust_level: project.trust_level,
    status: project.status,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function parseProjectConfig(projectConfigJson) {
  try {
    return projectConfigJson ? JSON.parse(projectConfigJson) : {};
  } catch (_e) {
    void _e;
    return {};
  }
}

function getBaselineResumeJobsByProject(projectId) {
  let jobs = baselineResumeJobs.get(projectId);
  if (!jobs) {
    jobs = new Map();
    baselineResumeJobs.set(projectId, jobs);
  }
  return jobs;
}

function getBaselineResumeJob(projectId, jobId) {
  return getBaselineResumeJobsByProject(projectId).get(jobId) || null;
}

function hasRunningBaselineResumeJob(projectId) {
  const jobs = baselineResumeJobs.get(projectId);
  if (!jobs) {
    return false;
  }
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      return true;
    }
  }
  return false;
}

function normalizeBaselineResumeJob(job) {
  if (!job) {
    return null;
  }
  return {
    job_id: job.job_id,
    project_id: job.project_id,
    project_name: job.project_name || null,
    status: job.status,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at || null,
    duration_ms: job.duration_ms || null,
    probe_timeout_ms: job.probe_timeout_ms,
    probe_exit_code: job.probe_exit_code ?? null,
    probe_timed_out: job.probe_timed_out || false,
    project_resumed: job.project_resumed || false,
    message: job.message || null,
    error: job.error || null,
    preview_output: job.preview_output || null,
    starvation_recovery: job.starvation_recovery || null,
    requeued_work_item: job.requeued_work_item || null,
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

async function triggerBaselineStarvationRecovery(project) {
  if (!project || project.loop_state !== LOOP_STATES.STARVED) {
    return null;
  }

  try {
    const { defaultContainer } = require('../container');
    const starvationRecovery = defaultContainer.get('starvationRecovery');
    if (!starvationRecovery || typeof starvationRecovery.maybeRecover !== 'function') {
      return null;
    }
    return await starvationRecovery.maybeRecover(project, {
      force: true,
      trigger: 'baseline_resume',
    });
  } catch (err) {
    logger.warn('Baseline resume STARVED recovery failed', {
      project_id: project?.id,
      err: err.message,
    });
    return null;
  }
}

function logBaselineRequeueDecision({ project, result, trigger }) {
  if (!project?.id || !result?.requeued) {
    return;
  }
  try {
    factoryDecisions.setDb(getDatabase());
    factoryDecisions.recordDecision({
      project_id: project.id,
      stage: LOOP_STATES.VERIFY.toLowerCase(),
      actor: 'auto-recovery',
      action: 'baseline_blocked_work_item_requeued',
      reasoning: 'Baseline probe passed; requeued the work item that had been blocked by unrelated baseline failure.',
      outcome: {
        trigger,
        work_item_id: result.work_item_id,
        previous_status: result.previous_status,
        previous_reject_reason: result.previous_reject_reason,
        status: result.status,
      },
      confidence: 1,
      batch_id: null,
    });
  } catch (err) {
    logger.debug('Failed to log baseline work item requeue decision', {
      project_id: project.id,
      err: err.message,
    });
  }
}

function trimBaselineResumeJobs(projectId) {
  const jobs = baselineResumeJobs.get(projectId);
  if (!jobs || jobs.size <= BASELINE_RESUME_JOBS_TO_KEEP_PER_PROJECT) {
    return;
  }
  const entries = [...jobs.values()].sort((a, b) => {
    if (a.created_at < b.created_at) return -1;
    if (a.created_at > b.created_at) return 1;
    return 0;
  });
  while (jobs.size > BASELINE_RESUME_JOBS_TO_KEEP_PER_PROJECT) {
    const oldest = entries.shift();
    if (!oldest) {
      return;
    }
    jobs.delete(oldest.job_id);
  }
}

function clearCommitsTodayCache() {
  commitsTodayCache.clear();
}

async function countCommitsToday(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return 0;
  }

  const cached = getCachedCommitsToday(projectPath);
  if (cached !== null) {
    return cached;
  }

  const commitsToday = await new Promise((resolve) => {
    let child;
    try {
      child = childProcess.spawn('git', ['log', '--since=midnight', '--oneline'], {
        cwd: projectPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(0);
      return;
    }

    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };
    const timeoutId = setTimeout(() => {
      try {
        child.kill();
      } catch (_e) {
        // Best effort only — the helper still resolves to 0 on timeout.
        void _e;
      }
      finish(0);
    }, COMMITS_TODAY_TIMEOUT_MS);

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }

    child.on('error', () => finish(0));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(0);
        return;
      }
      const count = stdout
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0)
        .length;
      finish(count);
    });
  });

  commitsTodayCache.set(projectPath, {
    commitsToday,
    cachedAtMs: Date.now(),
  });
  return commitsToday;
}

function resolveProject(projectRef) {
  let project = factoryHealth.getProject(projectRef);
  if (!project) {
    project = factoryHealth.getProjectByPath(projectRef);
  }
  if (!project && typeof projectRef === 'string' && projectRef.trim()) {
    const needle = projectRef.trim().toLowerCase();
    const matches = factoryHealth.listProjects()
      .filter((candidate) => String(candidate.name || '').trim().toLowerCase() === needle);
    if (matches.length === 1) {
      project = matches[0];
    } else if (matches.length > 1) {
      throw new Error(`Project name is ambiguous: ${projectRef}`);
    }
  }
  if (!project) {
    throw new Error(`Project not found: ${projectRef}`);
  }
  return project;
}

function jsonResponse(data, options = {}) {
  const response = {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredData: data,
  };
  if (Number.isInteger(options.status)) {
    response.status = options.status;
  }
  if (options.headers && typeof options.headers === 'object') {
    response.headers = options.headers;
  }
  if (options.errorCode) {
    response.errorCode = options.errorCode;
  }
  if (options.errorMessage) {
    response.errorMessage = options.errorMessage;
  }
  return response;
}

function factoryHandlerError(errorCode, message, status, details = null) {
  const result = makeError(errorCode, message, details);
  return {
    ...result,
    status,
    errorCode: result.error_code || errorCode?.code || 'INTERNAL_ERROR',
    errorMessage: message,
  };
}

function normalizeProjectLoopState(loopState) {
  if (typeof loopState !== 'string') {
    return 'IDLE';
  }
  const normalized = loopState.trim().toUpperCase();
  return normalized || 'IDLE';
}

const NON_STALLABLE_FACTORY_LOOP_STATES = new Set([
  LOOP_STATES.IDLE,
  LOOP_STATES.PAUSED,
  LOOP_STATES.STARVED,
]);

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeOptionalText(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function summarizeActiveTask(task, kind) {
  if (!task) {
    return null;
  }
  return {
    id: task.id,
    kind,
    status: task.status || null,
    provider: task.provider || null,
    model: task.model || null,
    created_at: task.created_at || null,
    started_at: task.started_at || null,
    completed_at: task.completed_at || null,
  };
}

function getActivePlanGenerationTask(activeInstance) {
  const workItemId = activeInstance?.work_item_id || activeInstance?.workItemId || null;
  if (!workItemId) {
    return null;
  }

  let workItem;
  try {
    workItem = factoryIntake.getWorkItem(workItemId);
  } catch (error) {
    logger.debug('Failed to inspect active factory work item for status', {
      err: error.message,
      work_item_id: workItemId,
    });
    return null;
  }

  const origin = workItem?.origin && typeof workItem.origin === 'object'
    ? workItem.origin
    : parseJsonObject(workItem?.origin_json);
  const taskId = normalizeOptionalText(origin?.plan_generation_task_id);
  if (!taskId) {
    return getActivePlanGenerationTaskByTags(activeInstance, workItemId);
  }

  let task;
  try {
    const taskCore = require('../db/task-core');
    task = taskCore.getTask(taskId);
  } catch (error) {
    logger.debug('Failed to inspect active plan-generation task for status', {
      err: error.message,
      task_id: taskId,
      work_item_id: workItemId,
    });
    return getActivePlanGenerationTaskByTags(activeInstance, workItemId);
  }

  if (!task || TERMINAL_FACTORY_INTERNAL_TASK_STATUSES.has(String(task.status || '').toLowerCase())) {
    return getActivePlanGenerationTaskByTags(activeInstance, workItemId);
  }

  return summarizeActiveTask(task, 'plan_generation');
}

function getTaskTags(task) {
  if (Array.isArray(task?.tags)) {
    return task.tags;
  }
  if (typeof task?.tags !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(task.tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rankActiveFactoryTask(task) {
  return ACTIVE_FACTORY_BATCH_TASK_STATUS_RANK.get(String(task?.status || '').toLowerCase()) ?? 99;
}

function sortActiveFactoryTasksByNewest(left, right) {
  const leftRank = rankActiveFactoryTask(left);
  const rightRank = rankActiveFactoryTask(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return String(right?.created_at || '').localeCompare(String(left?.created_at || ''));
}

function sortActiveFactoryTasksByOldest(left, right) {
  const leftRank = rankActiveFactoryTask(left);
  const rightRank = rankActiveFactoryTask(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return String(left?.created_at || '').localeCompare(String(right?.created_at || ''));
}

function getActivePlanGenerationTaskByTags(activeInstance, workItemId) {
  const projectId = normalizeOptionalText(activeInstance?.project_id || activeInstance?.projectId);
  const normalizedWorkItemId = workItemId == null ? null : String(workItemId);
  if (!projectId || !normalizedWorkItemId) {
    return null;
  }

  const projectTag = `factory:project_id=${projectId}`;
  const workItemTag = `factory:work_item_id=${normalizedWorkItemId}`;
  let tasks;
  try {
    const taskCore = require('../db/task-core');
    tasks = taskCore.listTasks({
      tags: [projectTag, workItemTag, 'factory:plan_generation'],
      columns: ['id', 'status', 'provider', 'model', 'created_at', 'started_at', 'completed_at', 'tags'],
      orderBy: 'created_at',
      orderDir: 'desc',
      limit: 50,
    });
  } catch (error) {
    logger.debug('Failed to infer active plan-generation task for status', {
      err: error.message,
      project_id: projectId,
      work_item_id: normalizedWorkItemId,
    });
    return null;
  }

  const activeTasks = Array.isArray(tasks)
    ? tasks.filter((task) => {
      if (TERMINAL_FACTORY_INTERNAL_TASK_STATUSES.has(String(task?.status || '').toLowerCase())) {
        return false;
      }
      const tags = getTaskTags(task);
      return tags.includes(projectTag)
        && tags.includes(workItemTag)
        && tags.includes('factory:plan_generation');
    })
    : [];
  if (activeTasks.length === 0) {
    return null;
  }

  const [task] = activeTasks.sort(sortActiveFactoryTasksByNewest);
  return summarizeActiveTask(task, 'plan_generation');
}

function getActiveArchitectTask(activeInstance) {
  const projectId = normalizeOptionalText(activeInstance?.project_id || activeInstance?.projectId);
  if (!projectId) {
    return null;
  }

  let tasks;
  try {
    const taskCore = require('../db/task-core');
    tasks = taskCore.listTasks({
      tags: [`factory:project_id=${projectId}`, 'factory:architect_cycle'],
      columns: ['id', 'status', 'provider', 'model', 'created_at', 'started_at', 'completed_at', 'tags'],
      orderBy: 'created_at',
      orderDir: 'desc',
      limit: 50,
    });
  } catch (error) {
    logger.debug('Failed to inspect active architect task for status', {
      err: error.message,
      project_id: projectId,
    });
    return null;
  }

  const projectTag = `factory:project_id=${projectId}`;
  const activeTasks = Array.isArray(tasks)
    ? tasks.filter((task) => {
      if (TERMINAL_FACTORY_INTERNAL_TASK_STATUSES.has(String(task?.status || '').toLowerCase())) {
        return false;
      }
      const tags = getTaskTags(task);
      return tags.includes(projectTag) && tags.includes('factory:architect_cycle');
    })
    : [];
  if (activeTasks.length === 0) {
    return null;
  }

  const [task] = activeTasks.sort(sortActiveFactoryTasksByNewest);
  return summarizeActiveTask(task, 'architect_cycle');
}

function getActiveFactoryBatchTask(activeInstance) {
  const batchId = activeInstance?.batch_id || activeInstance?.batchId || null;
  if (!batchId) {
    return null;
  }

  let tasks;
  try {
    tasks = loopController.listTasksForFactoryBatch(batchId);
  } catch (error) {
    logger.debug('Failed to inspect active factory batch task for status', {
      err: error.message,
      batch_id: batchId,
    });
    return null;
  }

  const activeTasks = Array.isArray(tasks)
    ? tasks.filter((task) => !TERMINAL_FACTORY_BATCH_TASK_STATUSES.has(
      String(task?.status || '').toLowerCase()
    ))
    : [];
  if (activeTasks.length === 0) {
    return null;
  }

  const [task] = activeTasks.sort(sortActiveFactoryTasksByOldest);
  return summarizeActiveTask(task, 'execution');
}

function summarizeFactoryStateConsistency({ project, loopState, activeStage, activeTask }) {
  const rawProjectLoopState = normalizeProjectLoopState(project?.loop_state);
  const projectPausedAtStage = normalizeProjectLoopState(project?.loop_paused_at_stage);
  const projectLoopState = rawProjectLoopState === LOOP_STATES.PAUSED && projectPausedAtStage
    ? projectPausedAtStage
    : rawProjectLoopState;
  const instanceLoopState = normalizeProjectLoopState(loopState);
  const effectiveActiveStage = normalizeProjectLoopState(activeStage || instanceLoopState);
  const mismatches = [];

  if (projectLoopState !== instanceLoopState) {
    mismatches.push('project_row_loop_state_drift');
  }
  const expectedPlanGenerationDuringExecute = activeTask?.kind === 'plan_generation'
    && instanceLoopState === LOOP_STATES.EXECUTE
    && effectiveActiveStage === LOOP_STATES.PLAN;
  if (effectiveActiveStage !== instanceLoopState && !expectedPlanGenerationDuringExecute) {
    const activeReason = activeTask?.kind
      ? `${activeTask.kind}_active_under_${instanceLoopState.toLowerCase()}`
      : `${effectiveActiveStage.toLowerCase()}_active_under_${instanceLoopState.toLowerCase()}`;
    mismatches.push(activeReason);
  }

  return {
    ok: mismatches.length === 0,
    project_loop_state: projectLoopState,
    instance_loop_state: instanceLoopState,
    active_stage: effectiveActiveStage,
    mismatches,
  };
}

function countOpenFactoryWorkItems(projectId) {
  try {
    const stats = factoryIntake.getIntakeStats(projectId);
    return Object.entries(stats).reduce((sum, [status, count]) => {
      if (factoryIntake.CLOSED_STATUSES.has(status)) {
        return sum;
      }
      const numeric = Number(count);
      return sum + (Number.isFinite(numeric) ? numeric : 0);
    }, 0);
  } catch (error) {
    logger.debug('Failed to count open factory work items', {
      err: error.message,
      project_id: projectId,
    });
    return 0;
  }
}

function hasNonTerminalFactoryBatchTasks(batchId) {
  if (!batchId) {
    return false;
  }

  try {
    return loopController
      .listTasksForFactoryBatch(batchId)
      .some((task) => !TERMINAL_FACTORY_BATCH_TASK_STATUSES.has(task.status));
  } catch (error) {
    logger.debug('Failed to inspect factory batch tasks for status', {
      err: error.message,
      batch_id: batchId,
    });
    return false;
  }
}

function getFactoryStatusAlertBadge(projectId, {
  openWorkItemCount,
  loopState,
  projectStatus,
  hasNonTerminalBatchTasks = false,
} = {}) {
  const hasPendingWork = openWorkItemCount > 0;
  const normalizedLoopState = normalizeProjectLoopState(loopState);
  const hasRunningLoop = normalizedLoopState !== LOOP_STATES.IDLE;
  if (hasPendingWork || hasRunningLoop) {
    notifications.recordFactoryIdleState({
      project_id: projectId,
      pending_count: openWorkItemCount,
      running_count: hasRunningLoop ? 1 : 0,
      has_pending_work: hasPendingWork,
      has_running_item: hasRunningLoop,
    });
  }
  const projectIsRunning = String(projectStatus || '').trim().toLowerCase() === 'running';
  if (
    hasNonTerminalBatchTasks
    || !projectIsRunning
    || NON_STALLABLE_FACTORY_LOOP_STATES.has(normalizedLoopState)
  ) {
    notifications.clearFactoryAlertBadge({
      project_id: projectId,
      alert_type: notifications.ALERT_TYPES.FACTORY_STALLED,
    });
  }

  return notifications.getFactoryAlertBadge({ project_id: projectId });
}

function normalizeFactoryLoopInstance(instance) {
  if (!instance) {
    return null;
  }

  return {
    id: instance.id,
    project_id: instance.project_id,
    work_item_id: instance.work_item_id || null,
    batch_id: instance.batch_id || null,
    loop_state: instance.loop_state,
    paused_at_stage: instance.paused_at_stage || null,
    last_action_at: instance.last_action_at || null,
    created_at: instance.created_at || null,
    terminated_at: instance.terminated_at || null,
  };
}

function classifyFactoryLoopError(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof loopController.StageOccupiedError || error?.code === 'FACTORY_STAGE_OCCUPIED') {
    return {
      errorCode: ErrorCodes.CONFLICT,
      status: 409,
      message,
    };
  }

  if (message.startsWith('Project not found:') || message.startsWith('Factory loop instance not found:')) {
    return {
      errorCode: ErrorCodes.RESOURCE_NOT_FOUND,
      status: 404,
      message,
    };
  }

  if (message.startsWith('Project name is ambiguous:')) {
    return {
      errorCode: ErrorCodes.CONFLICT,
      status: 409,
      message,
    };
  }

  if (
    message === 'Loop not started for this project'
    || message.startsWith('Loop is paused')
    || message.startsWith('Loop is not paused')
    || message.startsWith('Loop is paused at ')
    || message.startsWith('Loop is not paused at ')
    || message.startsWith('Invalid gate stage:')
  ) {
    return {
      errorCode: ErrorCodes.INVALID_STATUS_TRANSITION,
      status: 409,
      message,
    };
  }

  return {
    errorCode: ErrorCodes.INTERNAL_ERROR,
    status: 500,
    message,
  };
}

function buildFactoryLoopErrorResponse(error) {
  const classified = classifyFactoryLoopError(error);
  return factoryHandlerError(classified.errorCode, classified.message, classified.status);
}

function ensureFactoryDecisionDb() {
  const db = getDatabase().getDbInstance();
  if (db) {
    factoryDecisions.setDb(db);
  }
  return db;
}

const MAX_FACTORY_CYCLE_HISTORY = 20;
const FACTORY_CYCLE_FAILURE_ACTIONS = new Set([
  'cannot_generate_plan',
  'execution_failed',
  'learn_failed',
  'plan_lint_rejected',
  'skipped_shipping',
  'verify_failed',
  'verify_retry_task_failed',
  'worktree_creation_failed',
  'worktree_merge_failed',
  'worktree_verify_errored',
  'worktree_verify_failed',
]);

function normalizeFactoryCycleStage(stage) {
  const normalized = typeof stage === 'string' ? stage.trim().toLowerCase() : '';
  if (!normalized) {
    return null;
  }
  return normalized === 'ship' ? 'learn' : normalized;
}

function calculateFactoryCycleDurationMs(instance, nowMs = Date.now()) {
  const startedAtMs = Date.parse(instance?.created_at || '');
  if (!Number.isFinite(startedAtMs)) {
    return null;
  }

  const endedAtMs = instance?.terminated_at
    ? Date.parse(instance.terminated_at)
    : instance?.last_action_at
      ? Math.max(Date.parse(instance.last_action_at), nowMs)
      : nowMs;

  if (!Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
    return null;
  }

  return endedAtMs - startedAtMs;
}

function selectFactoryCycleInstanceByTimestamp(instances, timestampMs) {
  if (!Array.isArray(instances) || instances.length === 0 || !Number.isFinite(timestampMs)) {
    return null;
  }

  const activeCandidates = [];
  const historicalCandidates = [];

  for (const instance of instances) {
    const startedAtMs = Date.parse(instance?.created_at || '');
    if (!Number.isFinite(startedAtMs) || startedAtMs > timestampMs) {
      continue;
    }

    historicalCandidates.push(instance);

    const terminatedAtMs = Date.parse(instance?.terminated_at || '');
    if (!Number.isFinite(terminatedAtMs) || terminatedAtMs >= timestampMs) {
      activeCandidates.push(instance);
    }
  }

  if (activeCandidates.length > 0) {
    return activeCandidates[activeCandidates.length - 1];
  }

  return historicalCandidates.length > 0
    ? historicalCandidates[historicalCandidates.length - 1]
    : null;
}

function resolveFactoryCycleDecisionInstance(decision, instances, instanceById, instancesByBatch) {
  if (!decision) {
    return null;
  }

  const timestampMs = Date.parse(decision.created_at || '');

  if (decision.batch_id) {
    const batchMatches = instancesByBatch.get(decision.batch_id) || [];
    if (batchMatches.length === 1) {
      return batchMatches[0];
    }
    if (batchMatches.length > 1) {
      return selectFactoryCycleInstanceByTimestamp(batchMatches, timestampMs) || batchMatches[batchMatches.length - 1];
    }
  }

  const decisionInstanceId = decision?.inputs?.instance_id || decision?.outcome?.instance_id || null;
  if (typeof decisionInstanceId === 'string' && instanceById.has(decisionInstanceId)) {
    return instanceById.get(decisionInstanceId);
  }

  return selectFactoryCycleInstanceByTimestamp(instances, timestampMs);
}

function summarizeFactoryCycleInstance(instance, decisions, workItemTitle) {
  const stageProgression = [];
  const seenStages = new Set();

  for (const decision of decisions) {
    const normalizedStage = normalizeFactoryCycleStage(decision?.stage);
    if (!normalizedStage || seenStages.has(normalizedStage)) {
      continue;
    }
    seenStages.add(normalizedStage);
    stageProgression.push(normalizedStage);
  }

  if (stageProgression.length === 0 && !instance?.terminated_at) {
    const fallbackStage = normalizeFactoryCycleStage(instance?.paused_at_stage || instance?.loop_state);
    if (fallbackStage) {
      stageProgression.push(fallbackStage);
    }
  }

  return {
    instance_id: instance.id,
    work_item_id: instance.work_item_id || null,
    work_item_title: workItemTitle || null,
    batch_id: instance.batch_id || null,
    loop_state: instance.loop_state || null,
    paused_at_stage: instance.paused_at_stage || null,
    started_at: instance.created_at || null,
    last_action_at: instance.last_action_at || null,
    terminated_at: instance.terminated_at || null,
    duration_ms: calculateFactoryCycleDurationMs(instance),
    decision_count: decisions.length,
    stage_progression: stageProgression,
    status: instance.terminated_at
      ? (decisions.some((decision) => FACTORY_CYCLE_FAILURE_ACTIONS.has(decision?.action)) ? 'failed' : 'completed')
      : 'active',
  };
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

async function handleRegisterFactoryProject(args) {
  if (args.config?.plans_dir) {
    validatePlansDir({ projectPath: args.path, plansDir: args.config.plans_dir });
  }
  const project = factoryHealth.registerProject({
    name: args.name,
    path: args.path,
    brief: args.brief,
    trust_level: args.trust_level,
    config: args.config,
  });
  logger.info(`Registered factory project: ${project.name} (${project.id})`);
  return jsonResponse({
    message: `Project "${project.name}" registered with trust level: ${project.trust_level}`,
    project,
  });
}

async function handleListFactoryProjects(args = {}) {
  const projects = factoryHealth.listProjects(args.status ? { status: args.status } : undefined);
  if (isBasicProjectListRequest(args)) {
    return jsonResponse({ projects: projects.map(summarizeBasicFactoryProject) });
  }

  // Include commits_today by default so existing REST consumers see the
  // same shape as the factory_status MCP tool. Lightweight pollers can
  // pass include_commits=false or summary=basic to avoid git work.
  const includeCommits = !isExplicitFalse(args.include_commits);
  const projectIds = projects.map((p) => p.id);
  const scoresMap = factoryHealth.getLatestScoresBatch(projectIds);
  const summaries = await Promise.all(projects.map(async (p) => {
    const scores = scoresMap.get(p.id) ?? {};
    const balance = factoryHealth.getBalanceScore(p.id, scores);
    const summary = { ...p, scores, balance };
    if (includeCommits) {
      summary.commits_today = await countCommitsToday(p.path);
    }
    return summary;
  }));
  return jsonResponse({ projects: summaries });
}

function summarizeHealthModel(scores) {
  const present = Object.keys(scores || {});
  const missing = [...factoryHealth.VALID_DIMENSIONS].filter((dimension) => !present.includes(dimension));
  return {
    dimension_count: present.length,
    missing_dimensions: missing,
    status: present.length === 0
      ? 'missing'
      : (missing.length > 0 ? 'partial' : 'complete'),
  };
}

async function handleProjectHealth(args) {
  const project = resolveProject(args.project);
  const scores = factoryHealth.getLatestScores(project.id);
  const balance = factoryHealth.getBalanceScore(project.id, scores);
  const dimensions = Object.keys(scores);
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];
  const healthModel = summarizeHealthModel(scores);

  const result = {
    project: { id: project.id, name: project.name, path: project.path, trust_level: project.trust_level, status: project.status },
    scores,
    balance,
    weakest_dimension: weakest ? { dimension: weakest[0], score: weakest[1] } : null,
    dimension_count: healthModel.dimension_count,
    health_model_status: healthModel.status,
    health_missing_dimensions: healthModel.missing_dimensions,
  };

  if (args.include_trends) {
    result.trends = factoryHealth.getScoreHistoryBatch(project.id, dimensions, 20);
  }

  if (args.include_findings) {
    const latestSnapshotIds = factoryHealth.getLatestSnapshotIds(project.id);
    const findingsBySnapshot = factoryHealth.getFindingsForSnapshots(Object.values(latestSnapshotIds));
    result.findings = {};
    for (const dim of dimensions) {
      const snapshotId = latestSnapshotIds[dim];
      if (snapshotId) {
        result.findings[dim] = findingsBySnapshot[snapshotId] || [];
      }
    }
  }

  return jsonResponse(result);
}

async function handleScanProjectHealth(args) {
  const project = resolveProject(args.project);
  const dimensions = args.dimensions || [...factoryHealth.VALID_DIMENSIONS];
  const scanType = args.scan_type || 'incremental';

  // Run scan_project to get filesystem data
  // scan_project returns { content: [{text: markdown}], scanResult: {structured data} }
  // We need the scanResult object, not the markdown text
  let scanReport = {};
  try {
    const { handleScanProject } = require('../handlers/integration/infra');
    const scanArgs = { path: project.path };
    const sourceDirs = resolveHealthScanSourceDirs(project.path);
    if (Array.isArray(sourceDirs) && sourceDirs.length > 0) {
      scanArgs.source_dirs = sourceDirs;
    }
    const result = handleScanProject(scanArgs);
    // Use the structured scanResult, not the markdown text
    if (result?.scanResult && typeof result.scanResult === 'object') {
      scanReport = result.scanResult;
    }
  } catch (err) {
    logger.warn(`scan_project failed for ${project.path}: ${err.message}`);
  }

  // Resolve findings directory
  let findingsDir = null;
  const candidates = [
    path.join(project.path, 'docs', 'findings'),
    path.join(project.path, '..', 'docs', 'findings'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) { findingsDir = dir; break; }
  }

  // Score all requested dimensions
  const scored = scoreAll(project.path, scanReport, findingsDir, dimensions);

  // Record snapshots and findings
  const results = {};
  for (const [dim, result] of Object.entries(scored)) {
    const snap = factoryHealth.recordSnapshot({
      project_id: project.id,
      dimension: dim,
      score: result.score,
      scan_type: scanType,
      batch_id: args.batch_id,
      details: result.details,
    });

    if (result.findings && result.findings.length > 0) {
      factoryHealth.recordFindings(snap.id, result.findings);
    }

    results[dim] = { snapshot_id: snap.id, score: result.score, details: result.details };
  }

  return jsonResponse({
    message: `Scanned ${dimensions.length} dimensions for "${project.name}" (${scanType})`,
    project_id: project.id,
    results,
  });
}

async function handleSetFactoryTrustLevel(args) {
  const project = resolveProject(args.project);
  const updates = { trust_level: args.trust_level };
  // Allow setting project config alongside trust level. Merges into
  // existing config_json so callers can set individual keys like
  // { loop: { auto_continue: true } } without overwriting everything.
  if (args.config && typeof args.config === 'object') {
    const existing = project.config_json ? (() => { try { return JSON.parse(project.config_json); } catch (_e) { void _e; return {}; } })() : {};
    const merged = { ...existing, ...args.config };
    if (merged.plans_dir) {
      validatePlansDir({ projectPath: project.path, plansDir: merged.plans_dir });
    }
    updates.config_json = JSON.stringify(merged);
  }
  const updated = factoryHealth.updateProject(project.id, updates);
  logger.info(`Trust level for "${updated.name}" changed to ${args.trust_level}`);
  return jsonResponse({
    message: `Trust level for "${updated.name}" set to: ${updated.trust_level}`,
    project: updated,
  });
}

async function handlePauseProject(args) {
  const project = resolveProject(args.project);
  const previous_status = project.status;
  const updated = factoryHealth.updateProject(project.id, { status: 'paused' });
  try {
    factoryAudit.recordAuditEvent({
      project_id: updated.id,
      event_type: 'pause',
      previous_status,
      reason: args.reason || null,
      actor: args.__user || (args.actor || 'unknown'),
      source: args.source || 'mcp',
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to record pause audit event');
  }
  // Stop factory tick timer when project is paused
  try {
    const { stopTick } = require('../factory/factory-tick');
    stopTick(updated.id);
  } catch (_e) { void _e; /* factory-tick not loaded */ }
  logger.info(`Factory project paused: ${updated.name}`);
  return jsonResponse({
    message: `Project "${updated.name}" paused`,
    project: updated,
  });
}

async function handleResumeProject(args) {
  const project = resolveProject(args.project);
  const previous_status = project.status;
  const updated = factoryHealth.updateProject(project.id, { status: 'running' });
  try {
    factoryAudit.recordAuditEvent({
      project_id: updated.id,
      event_type: 'resume',
      previous_status,
      reason: args.reason || null,
      actor: args.__user || (args.actor || 'unknown'),
      source: args.source || 'mcp',
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to record resume audit event');
  }
  // Start factory tick timer when project resumes.
  // Phase L (2026-04-30): honor cfg.loop.tick_interval_ms so an operator can
  // pause + resume to apply a new tick interval without restarting TORQUE.
  // Previously startTick(updated) used the default 5min regardless of config,
  // so the only way to change the interval was a full server restart.
  try {
    const { startTick } = require('../factory/factory-tick');
    let intervalMs;
    if (updated.config_json) {
      try {
        const cfg = JSON.parse(updated.config_json);
        const cfgInterval = cfg?.loop?.tick_interval_ms;
        if (Number.isFinite(cfgInterval) && cfgInterval > 0) {
          intervalMs = cfgInterval;
        }
      } catch (_e) { void _e; /* invalid config_json — fall back to default */ }
    }
    startTick(updated, intervalMs);
  } catch (_e) { void _e; /* factory-tick not loaded */ }
  logger.info(`Factory project resumed: ${updated.name}`);
  return jsonResponse({
    message: `Project "${updated.name}" running`,
    project: updated,
  });
}

function getConfiguredFactoryTickInterval(project) {
  if (!project?.config_json) {
    return undefined;
  }
  try {
    const cfg = JSON.parse(project.config_json);
    const cfgInterval = cfg?.loop?.tick_interval_ms;
    if (Number.isFinite(cfgInterval) && cfgInterval > 0) {
      return cfgInterval;
    }
  } catch (_e) {
    void _e;
  }
  return undefined;
}

function startFactoryTickForProject(project) {
  try {
    const { startTick } = require('../factory/factory-tick');
    startTick(project, getConfiguredFactoryTickInterval(project));
  } catch (_e) {
    void _e;
  }
}

function resumeProjectRowForFactoryAction(project, args = {}, reason = 'factory_action') {
  if (!project || project.status !== 'paused') {
    return { resumed: false, project };
  }

  const previous_status = project.status;
  const updated = factoryHealth.updateProject(project.id, { status: 'running' });
  try {
    factoryAudit.recordAuditEvent({
      project_id: updated.id,
      event_type: 'resume',
      previous_status,
      reason,
      actor: args.__user || (args.actor || 'unknown'),
      source: args.source || 'mcp',
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to record action-triggered resume audit event');
  }
  startFactoryTickForProject(updated);
  logger.info('Factory project resumed for factory action', {
    project_id: updated.id,
    project_name: updated.name,
    reason,
  });
  return { resumed: true, project: updated };
}

async function handlePauseAllProjects(args = {}) {
  const projects = factoryHealth.listProjects();
  const results = await Promise.all(projects.map(async (p) => {
    if (p.status === 'paused') return false;
    const previous_status = p.status;
    const updated = factoryHealth.updateProject(p.id, { status: 'paused' });
    try {
      factoryAudit.recordAuditEvent({
        project_id: updated.id,
        event_type: 'pause',
        previous_status,
        reason: args.reason || null,
        actor: args.__user || args.actor || 'unknown',
        source: args.source || 'mcp',
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to record pause audit event');
    }
    return true;
  }));
  const paused = results.filter(Boolean).length;
  logger.info(`Emergency pause: ${paused} projects paused`);
  return jsonResponse({
    message: `${paused} project(s) paused`,
    total: projects.length,
    paused,
  });
}

async function handleFactoryStatus() {
  const projects = factoryHealth.listProjects();
  const nowMs = Date.now();
  let cacheHitCount = 0;
  const projectIds = projects.map((p) => p.id);
  const scoresMap = factoryHealth.getLatestScoresBatch(projectIds);
  const summaries = await Promise.all(projects.map(async (p) => {
    const scores = scoresMap.get(p.id) ?? {};
    const balance = factoryHealth.getBalanceScore(p.id, scores);
    const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];
    const healthModel = summarizeHealthModel(scores);

    // Derive loop_state from the active instance, not the project row.
    // The project row is a write-through cache that can go stale when
    // instances are terminated (e.g. restart barrier) without a matching
    // syncLegacyProjectLoopState call. Reading from the instance makes
    // factory_status truthful even when drift exists; the periodic
    // reconciler in factory-tick closes the gap in the legacy row.
    const activeInstances = factoryLoopInstances.listInstances({
      project_id: p.id,
      active_only: true,
    });
    const activeInstance = Array.isArray(activeInstances) ? activeInstances[0] : null;
    const loopState = activeInstance
      ? normalizeProjectLoopState(activeInstance.loop_state)
      : 'IDLE';
    const pausedAtStage = activeInstance ? (activeInstance.paused_at_stage || null) : null;
    const lastActionAt = activeInstance
      ? (activeInstance.last_action_at || null)
      : (p.loop_last_action_at || null);
    const hasNonTerminalBatchTasks = activeInstance
      ? hasNonTerminalFactoryBatchTasks(activeInstance.batch_id)
      : false;
    const activeTask = getActivePlanGenerationTask(activeInstance)
      || getActiveArchitectTask(activeInstance)
      || getActiveFactoryBatchTask(activeInstance);
    const activeStage = ['architect_cycle', 'plan_generation'].includes(activeTask?.kind)
      ? LOOP_STATES.PLAN
      : loopState;
    const stateConsistency = summarizeFactoryStateConsistency({
      project: p,
      loopState,
      activeStage,
      activeTask,
    });
    const openWorkItemCount = countOpenFactoryWorkItems(p.id);
    const alertBadge = getFactoryStatusAlertBadge(p.id, {
      openWorkItemCount,
      loopState,
      projectStatus: p.status,
      hasNonTerminalBatchTasks,
    });

    if (getCachedCommitsToday(p.path, nowMs) !== null) {
      cacheHitCount += 1;
    }
    const commitsToday = await countCommitsToday(p.path);
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      trust_level: p.trust_level,
      status: p.status,
      commits_today: commitsToday,
      loop_state: loopState,
      active_stage: activeStage,
      active_task: activeTask,
      state_consistency: stateConsistency,
      loop_paused_at_stage: pausedAtStage,
      loop_last_action_at: lastActionAt,
      consecutive_empty_cycles: Number(p.consecutive_empty_cycles) || 0,
      alert_badge: alertBadge,
      balance,
      weakest_dimension: weakest ? weakest[0] : null,
      dimension_count: healthModel.dimension_count,
      health_model_status: healthModel.status,
      health_missing_dimensions: healthModel.missing_dimensions,
      _has_non_terminal_batch_tasks: hasNonTerminalBatchTasks,
    };
  }));

  const running = summaries.filter(p => p.status === 'running').length;
  const paused = summaries.filter(p => p.status === 'paused').length;
  const productionToday = summaries.reduce((sum, project) => sum + project.commits_today, 0);
  const zeroCommitProjects = summaries.filter(project => project.status === 'running' && project.commits_today === 0).length;
  const activeInternalTasks = summaries.filter(project => (
    project.active_task && project.active_task.kind !== 'execution'
  )).length;
  const activeProjectTasks = summaries.filter(project => project.active_task?.kind === 'execution').length;
  const stateMismatchProjects = summaries.filter(project => !project.state_consistency?.ok).length;
  // Stall calculation uses the instance-derived state too, so a dead
  // instance can't look "running but stalled" forever — with no active
  // instance, loop_state is IDLE and the project is excluded from stalled.
  const stalled = summaries.filter((summary) => {
    if (summary.status !== 'running' || summary._has_non_terminal_batch_tasks) {
      return false;
    }
    if (NON_STALLABLE_FACTORY_LOOP_STATES.has(summary.loop_state) || !summary.loop_last_action_at) {
      return false;
    }
    const lastActionMs = Date.parse(summary.loop_last_action_at);
    return Number.isFinite(lastActionMs) && (nowMs - lastActionMs) >= STALL_THRESHOLD_MS;
  }).length;
  const publicSummaries = summaries.map(({ _has_non_terminal_batch_tasks, ...summary }) => summary);

  logger.debug('Loaded factory_status productivity snapshot', {
    'x-cache-hit-count': cacheHitCount,
    project_count: summaries.length,
    production_today: productionToday,
    zero_commit_projects: zeroCommitProjects,
  });

  return jsonResponse({
    projects: publicSummaries,
    summary: {
      total: projects.length,
      running,
      paused,
      stalled,
      production_today: productionToday,
      zero_commit_projects: zeroCommitProjects,
      active_internal_tasks: activeInternalTasks,
      active_project_tasks: activeProjectTasks,
      state_mismatch_projects: stateMismatchProjects,
    },
  });
}

async function handleCreateWorkItem(args) {
  const project = resolveProject(args.project);
  const guard = await guardIntakeItem({ title: args.title });
  if (!guard.ok) {
    return jsonResponse({
      message: `Work item rejected: ${guard.reason}`,
      rejected: true,
      reason: guard.reason,
      title: args.title,
    });
  }

  const item = factoryIntake.createWorkItem({
    project_id: project.id,
    source: args.source,
    title: args.title,
    description: args.description,
    priority: args.priority,
    requestor: args.requestor,
    origin: args.origin,
    constraints: args.constraints,
  });
  return jsonResponse({ message: `Work item #${item.id} created`, item });
}

async function handleListWorkItems(args) {
  const project = resolveProject(args.project);
  const items = factoryIntake.listWorkItems({
    project_id: project.id,
    status: args.status,
    limit: args.limit || 50,
    offset: args.offset,
  });
  const stats = factoryIntake.getIntakeStats(project.id);
  return jsonResponse({ items, stats });
}

async function handleUpdateWorkItem(args) {
  const updates = {};
  if (args.title !== undefined) updates.title = args.title;
  if (args.description !== undefined) updates.description = args.description;
  if (args.priority !== undefined) updates.priority = args.priority;
  if (args.status !== undefined) updates.status = args.status;
  if (args.reject_reason !== undefined) updates.reject_reason = args.reject_reason;
  if (args.batch_id !== undefined) updates.batch_id = args.batch_id;
  if (args.linked_item_id !== undefined) updates.linked_item_id = args.linked_item_id;
  if (args.constraints !== undefined) updates.constraints_json = args.constraints;
  const item = factoryIntake.updateWorkItem(args.id, updates);
  if (!item) throw new Error(`Work item not found: ${args.id}`);
  return jsonResponse({ message: `Work item #${args.id} updated`, item });
}

async function handleRejectWorkItem(args) {
  const item = factoryIntake.rejectWorkItem(args.id, args.reason);
  if (!item) throw new Error(`Work item not found: ${args.id}`);
  return jsonResponse({ message: `Work item #${args.id} rejected`, item });
}

async function handleIntakeFromFindings(args) {
  const project = resolveProject(args.project);

  // Collect findings from the explicit array and/or the markdown-file source.
  const findings = [];
  if (Array.isArray(args.findings)) {
    findings.push(...args.findings);
  }

  let sourceFile = null;
  if (args.findings_file) {
    sourceFile = resolveFindingsFile(args.findings_file);
  } else if (args.dimension) {
    sourceFile = resolveLatestFindingsByDimension(args.dimension);
    if (!sourceFile) {
      throw new Error(`No findings file found for dimension "${args.dimension}" under docs/findings/`);
    }
  }

  if (sourceFile) {
    const parsed = parseFindingsMarkdown(sourceFile);
    findings.push(...parsed);
  }

  if (findings.length === 0) {
    throw new Error('intake_from_findings requires at least one of: findings (array), findings_file (path), or dimension (name)');
  }

  const preGuardCount = findings.length;
  const droppedMeta = [];
  const guardedFindings = [];
  for (const f of findings) {
    const g = await guardIntakeItem({ title: f && f.title });
    if (g.ok) {
      guardedFindings.push(f);
    } else {
      droppedMeta.push({ title: (f && f.title) || null, reason: g.reason });
    }
  }
  findings.length = 0;
  findings.push(...guardedFindings);
  if (droppedMeta.length > 0) {
    logger.info('intake_from_findings_meta_rejected', {
      project_id: project.id,
      dropped: droppedMeta.length,
      retained: findings.length,
      total: preGuardCount,
    });
  }

  const created = factoryIntake.createFromFindings(project.id, findings, args.source);
  // createFromFindings returns an array with a non-enumerable `.skipped` side-channel.
  const skipped = Array.isArray(created.skipped) ? created.skipped : [];
  return jsonResponse({
    message: `Imported ${created.length} items, ${skipped.length} skipped`,
    created,
    skipped,
    source_file: sourceFile || null,
    dropped_meta: droppedMeta,
  });
}

async function handleScanPlansDirectory(args) {
  const project = resolveProject(args.project_id);
  const plansDir = validatePlansDir({ projectPath: project.path, plansDir: args.plans_dir });
  const db = getDatabase().getDbInstance();
  const repoRoot = resolvePlansRepoRoot(project.path, plansDir);
  const shippedDetector = createShippedDetector({ repoRoot });
  const planIntake = createPlanFileIntake({ db, factoryIntake, shippedDetector });
  const scanArgs = {
    project_id: project.id,
    plans_dir: plansDir,
  };

  if (args.filter_regex) {
    scanArgs.filter = new RegExp(args.filter_regex);
  }

  const result = planIntake.scan(scanArgs);

  return jsonResponse({
    project_id: project.id,
    scanned: result.scanned,
    created_count: result.created.length,
    shipped_count: result.shipped_count,
    skipped_count: result.skipped.length,
    created: result.created.map((item) => {
      const summary = { id: item.id, title: item.title };
      if (item.shipped) {
        summary.shipped = true;
        summary.confidence = item.confidence;
      }
      return summary;
    }),
    skipped: result.skipped,
  });
}

async function handleExecutePlanFile(args) {
  const { createPlanExecutor } = require('../factory/plan-executor');
  const { handleSmartSubmitTask } = require('./integration/routing');
  const { handleAwaitTask } = require('./workflow/await');
  const taskCore = require('../db/task-core');

  const executor = createPlanExecutor({
    submit: async (taskArgs) => {
      const result = await handleSmartSubmitTask(taskArgs);
      if (!result?.task_id) {
        throw new Error(result?.content?.[0]?.text || 'smart_submit_task did not return task_id');
      }
      return { task_id: result.task_id };
    },
    awaitTask: async (taskArgs) => {
      const awaitResult = await handleAwaitTask(taskArgs);
      const task = taskCore.getTask(taskArgs.task_id);

      if (!task) {
        return {
          status: 'failed',
          verify_status: 'failed',
          error: awaitResult?.content?.[0]?.text || `Task not found after await: ${taskArgs.task_id}`,
          task_id: taskArgs.task_id,
        };
      }

      return {
        status: task.status,
        verify_status: task.status === 'completed' ? 'passed' : 'failed',
        error: task.error_output || null,
        task_id: task.id,
      };
    },
  });

  const result = await executor.execute({
    plan_path: args.plan_path,
    project: args.project,
    working_directory: args.working_directory,
    version_intent: args.version_intent || 'feature',
  });

  return jsonResponse(result);
}

async function handleGetPlanExecutionStatus(args) {
  const { parsePlanFile } = require('../factory/plan-parser');

  const content = fs.readFileSync(args.plan_path, 'utf8');
  const parsed = parsePlanFile(content);
  const totalTasks = parsed.tasks.length;
  const completedTasks = parsed.tasks.filter((task) => task.completed).length;
  const totalSteps = parsed.tasks.reduce((sum, task) => sum + task.steps.length, 0);
  const completedSteps = parsed.tasks.reduce((sum, task) => (
    sum + task.steps.filter((step) => step.done).length
  ), 0);
  const nextPending = parsed.tasks.find((task) => !task.completed) || null;

  return jsonResponse({
    plan_path: args.plan_path,
    title: parsed.title,
    total_tasks: totalTasks,
    completed_tasks: completedTasks,
    total_steps: totalSteps,
    completed_steps: completedSteps,
    next_pending_task: nextPending
      ? {
        task_number: nextPending.task_number,
        task_title: nextPending.task_title,
      }
      : null,
  });
}

async function handleListPlanIntakeItems(args) {
  const project = resolveProject(args.project_id);
  const items = factoryIntake.listWorkItems({
    project_id: project.id,
    source: 'plan_file',
    status: args.status,
  });

  return jsonResponse({
    project_id: project.id,
    count: items.length,
    items,
  });
}

// --- findings-file helpers ---

function resolveFindingsFile(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Findings file not found: ${filePath}`);
  }
  return abs;
}

function resolveLatestFindingsByDimension(dimension) {
  const dir = path.resolve(process.cwd(), 'docs', 'findings');
  if (!fs.existsSync(dir)) return null;
  const normalized = String(dimension).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const entries = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name.toLowerCase().includes(normalized))
    .sort(); // ISO date prefix sorts chronologically
  if (entries.length === 0) return null;
  return path.join(dir, entries[entries.length - 1]);
}

// Parse a findings markdown file into { title, severity, description, file } objects.
// Conventions (match the docs/findings/ format produced by scouts):
//   - Severity buckets are H2 sections: `## HIGH`, `## CRITICAL`, `## LOW`, etc.
//   - Individual findings are H3 headers: `### TITLE-01: description`
//   - Optional `**Files:** a.js, b.js` lines are captured into the `file` field.
function parseFindingsMarkdown(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const SEVERITY_TOKENS = new Set(['critical', 'high', 'medium', 'low', 'info']);
  const findings = [];
  let currentSeverity = 'medium';
  let current = null;
  const flush = () => {
    if (!current) return;
    const description = current.body.join('\n').trim();
    findings.push({
      title: current.title,
      severity: current.severity,
      description: description || undefined,
      file: current.file || undefined,
    });
    current = null;
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      const token = h2[1].trim().toLowerCase();
      if (SEVERITY_TOKENS.has(token)) {
        currentSeverity = token;
      }
      continue;
    }
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      flush();
      current = { title: h3[1].trim(), severity: currentSeverity, body: [], file: null };
      continue;
    }
    if (!current) continue;
    const fileMatch = line.trim().match(/^\*\*Files?:\*\*\s*(.+)$/i);
    if (fileMatch) {
      const first = fileMatch[1].split(',')[0].trim().replace(/[`]/g, '').split(/\s/)[0];
      if (first) current.file = first;
      continue;
    }
    current.body.push(line);
  }
  flush();
  return findings;
}

async function handlePollGitHubIssues(args) {
  const project = resolveProject(args.project);
  const effectiveConfig = {
    ...(project.config || {}),
  };

  if (args.labels !== undefined) {
    effectiveConfig.github_labels = args.labels;
  }

  const result = await pollGitHubIssues(project.id, effectiveConfig);
  return jsonResponse({
    project: project.name,
    ...result,
  });
}

async function handleTriggerArchitect(args) {
  const project = resolveProject(args.project);
  const cycle = await runArchitectCycle(project.id, 'manual');
  return jsonResponse({
    message: `Architect cycle completed for "${project.name}"`,
    reasoning: cycle.reasoning,
    backlog: cycle.backlog,
    flags: cycle.flags,
    cycle_id: cycle.id,
  });
}

async function handleArchitectBacklog(args) {
  const project = resolveProject(args.project);
  const backlog = factoryArchitect.getBacklog(project.id);
  const latest = factoryArchitect.getLatestCycle(project.id);
  return jsonResponse({
    project: project.name,
    backlog,
    reasoning_summary: latest ? latest.reasoning.slice(0, 500) : null,
    cycle_id: latest ? latest.id : null,
  });
}

async function handleArchitectLog(args) {
  const project = resolveProject(args.project);
  const log = factoryArchitect.getReasoningLog(project.id, args.limit || 10);
  return jsonResponse({ project: project.name, entries: log });
}

async function handleGetProjectPolicy(args) {
  const project = resolveProject(args.project);
  const policy = factoryHealth.getProjectPolicy(project.id);
  return jsonResponse({ project: project.name, policy });
}

async function handleSetProjectPolicy(args) {
  const project = resolveProject(args.project);
  const policy = factoryHealth.setProjectPolicy(project.id, args.policy);
  logger.info(`Policy updated for "${project.name}"`);
  return jsonResponse({ message: `Policy updated for "${project.name}"`, policy });
}

async function handleGuardrailStatus(args) {
  const project = resolveProject(args.project);
  const summary = getGuardrailSummary(project.id);
  return jsonResponse({ project: project.name, ...summary });
}

async function handleRunGuardrailCheck(args) {
  const project = resolveProject(args.project);
  let result;
  switch (args.phase) {
    case 'pre_batch':
      result = runPreBatchChecks(project.id, args.batch_plan || { tasks: [], scope_budget: 5 }, {
        recent_batches: [],
        write_sets: [],
      });
      break;
    case 'post_batch':
      result = runPostBatchChecks(project.id, args.batch_id || 'manual', args.files_changed || []);
      break;
    case 'pre_ship':
      result = runPreShipChecks(project.id, args.batch_id || 'manual', {
        test_results: args.test_results || { passed: 0, failed: 0, skipped: 0 },
      });
      break;
    default:
      throw new Error(`Invalid phase: ${args.phase}`);
  }
  logger.info(`Guardrail ${args.phase} check for "${project.name}": ${result.passed ? 'PASSED' : 'BLOCKED'}`);
  return jsonResponse({ project: project.name, phase: args.phase, ...result });
}

async function handleGuardrailEvents(args) {
  const project = resolveProject(args.project);
  const events = guardrailDb.getEvents(project.id, {
    category: args.category,
    status: args.status,
    limit: args.limit,
  });
  return jsonResponse({ project: project.name, events });
}

async function handleResetFactoryLoop(args) {
  const project = resolveProject(args.project);
  const updated = factoryHealth.updateProject(project.id, {
    loop_state: 'IDLE',
    loop_batch_id: null,
    loop_last_action_at: null,
    loop_paused_at_stage: null,
  });
  // Terminate any lingering active instances so stage occupancy is freed
  const instances = factoryLoopInstances.listInstances({
    project_id: project.id,
    active_only: true,
  });
  let terminated = 0;
  for (const inst of instances) {
    if (!inst.terminated_at) {
      try {
        loopController.terminateInstanceAndSync(inst.id, { abandonWorktree: true });
        terminated++;
      } catch (_e) { void _e; /* best effort */ }
    }
  }
  logger.info('Factory loop reset', {
    project_id: project.id,
    terminated_instances: terminated,
  });
  return jsonResponse({
    message: `Factory loop reset for "${updated.name}". ${terminated} instance(s) terminated.`,
    project_id: project.id,
    loop_state: 'IDLE',
    terminated_instances: terminated,
  });
}

async function handleStartFactoryLoop(args) {
  const project = resolveProject(args.project);
  if (args.auto_advance === true) {
    const result = loopController.startLoopAutoAdvanceForProject(project.id);
    return jsonResponse(result);
  }
  const result = await loopController.startLoopForProject(project.id);
  return jsonResponse(result);
}

async function handleAwaitFactoryLoop(args) {
  try {
    const project = resolveProject(args.project);
    const result = await loopController.awaitFactoryLoopForProject(project.id, {
      target_states: args.target_states,
      target_paused_stages: args.target_paused_stages,
      await_termination: args.await_termination,
      timeout_minutes: args.timeout_minutes,
      heartbeat_minutes: args.heartbeat_minutes,
    });
    return jsonResponse(result);
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

async function handleAdvanceFactoryLoop(args) {
  const project = resolveProject(args.project);
  const result = await loopController.advanceLoopForProject(project.id);
  return jsonResponse(result);
}

async function handleAdvanceFactoryLoopAsync(args) {
  const project = resolveProject(args.project);
  const result = loopController.advanceLoopAsyncForProject(project.id);
  return jsonResponse(result, {
    status: 202,
    headers: {
      Location: `/api/v2/factory/projects/${project.id}/loop/advance/${result.job_id}`,
    },
  });
}

async function handleApproveFactoryGate(args) {
  const project = resolveProject(args.project);
  const result = await loopController.approveGateForProject(project.id, args.stage);
  return jsonResponse(result);
}

async function handleRetryFactoryVerify(args) {
  const project = resolveProject(args.project || args.project_id);
  const result = loopController.retryVerifyForProject(project.id);
  const resumeResult = resumeProjectRowForFactoryAction(project, args, 'retry_factory_verify');
  if (resumeResult.resumed) {
    result.project_resumed = true;
    result.project_status = resumeResult.project.status;
  }
  return jsonResponse(result);
}

function createBaselineResumeJob(projectId, projectName, timeoutMs) {
  return {
    job_id: randomUUID(),
    project_id: projectId,
    project_name: projectName,
    status: 'running',
    created_at: nowIso(),
    started_at: nowIso(),
    completed_at: null,
    duration_ms: null,
    probe_timeout_ms: timeoutMs,
    probe_exit_code: null,
    probe_timed_out: false,
    probe_duration_ms: null,
    preview_output: null,
    project_resumed: false,
    message: 'Baseline resume in progress.',
    error: null,
  };
}

async function executeBaselineResumeProbe({
  projectRow,
  job,
  verifyCommand,
  timeoutMs,
}) {
  const start = Date.now();

  try {
    const baselineProbe = require('../factory/baseline-probe');
    const runnerRegistry = getTestRunnerRegistry();
    const runner = async ({ command, cwd, timeoutMs: runnerTimeoutMs }) => {
      const runnerResult = await runnerRegistry.runVerifyCommand(command, cwd, { timeout: runnerTimeoutMs });
      return {
        exitCode: runnerResult.exitCode,
        stdout: runnerResult.output || '',
        stderr: runnerResult.error || '',
        durationMs: runnerResult.durationMs,
        timedOut: !!runnerResult.timedOut,
      };
    };

    const probe = await baselineProbe.probeProjectBaseline({
      project: projectRow,
      verifyCommand,
      runner,
      timeoutMs,
    });

    job.probe_exit_code = probe.exitCode;
    job.probe_timed_out = !!probe.timedOut;
    job.probe_duration_ms = probe.durationMs;
    job.preview_output = String(probe.output || '').slice(-1500);

    if (!probe.passed) {
      job.status = 'failed';
      job.message = `Baseline still failing (exit ${probe.exitCode}). Fix the failing tests, then try again.`;
      return;
    }

    const project = factoryHealth.getProject(projectRow.id);
    const cfg = parseProjectConfig(project?.config_json);
    const pausedSince = Date.parse(cfg.baseline_broken_since) || Date.now();
    const requeueResult = baselineRequeue.maybeRequeueBaselineBlockedWorkItem({
      project_id: projectRow.id,
      config: cfg,
      probeVerifyCommand: verifyCommand,
    });
    if (requeueResult.requeued) {
      job.requeued_work_item = {
        work_item_id: requeueResult.work_item_id,
        previous_status: requeueResult.previous_status,
        previous_reject_reason: requeueResult.previous_reject_reason,
        status: requeueResult.status,
      };
    }
    logBaselineRequeueDecision({
      project: projectRow,
      result: requeueResult,
      trigger: 'manual_baseline_resume',
    });
    if (requeueResult.reason === 'baseline_probe_command_mismatch') {
      job.status = 'failed';
      job.message = 'Baseline probe passed, but it did not run the verify command that blocked the work item. Run the recorded failing command or clear the baseline manually after proving it.';
      job.error = 'baseline_probe_command_mismatch';
      job.baseline_probe_command_mismatch = {
        blocked_verify_command: requeueResult.blocked_verify_command,
        probe_verify_command: requeueResult.probe_verify_command,
      };
      return;
    }
    cfg.baseline_broken_since = null;
    cfg.baseline_broken_reason = null;
    cfg.baseline_broken_evidence = null;
    cfg.baseline_broken_probe_attempts = 0;
    cfg.baseline_broken_tick_count = 0;
    factoryHealth.updateProject(projectRow.id, {
      status: 'running',
      config_json: JSON.stringify(cfg),
    });

    try {
      const updated = factoryHealth.getProject(projectRow.id);
      const factoryTick = require('../factory/factory-tick');
      factoryTick.startTick(updated);
      const recovery = await triggerBaselineStarvationRecovery(updated);
      job.starvation_recovery = summarizeStarvationRecovery(recovery);
    } catch (_e) {
      void _e; /* factory-tick not loaded */
    }
    try {
      const eventBus = require('../event-bus');
      eventBus.emitFactoryProjectBaselineCleared({
        project_id: projectRow.id,
        cleared_after_ms: Date.now() - pausedSince,
      });
    } catch (_e) {
      void _e;
    }

    job.status = 'completed';
    job.project_resumed = true;
    job.message = `Project "${projectRow.name}" resumed — baseline probe passed in ${probe.durationMs}ms.`;
  } catch (err) {
    job.status = 'failed';
    job.error = err.message || String(err);
    job.message = `Baseline resume failed: ${job.error}`;
    logger.warn('handleResumeProjectBaselineFixed worker failed', { err: job.error, project_id: projectRow.id });
  } finally {
    job.completed_at = nowIso();
    job.duration_ms = Date.now() - start;
  }
}

async function handleResumeProjectBaselineFixed(args) {
  try {
    const projectRef = args?.project;
    if (!projectRef) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'project is required');
    }

    let projectRow;
    try {
      projectRow = resolveProject(projectRef);
    } catch (_e) {
      void _e;
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Project not found: ${projectRef}`);
    }

    const cfg = parseProjectConfig(projectRow.config_json);
    if (!cfg.baseline_broken_since) {
      return makeError(
        ErrorCodes.CONFLICT,
        `Project "${projectRow.name}" is not flagged baseline_broken; nothing to resume.`,
      );
    }

    const baselineProbe = require('../factory/baseline-probe');
    let defaults = null;
    try {
      const projectConfigCore = require('../db/project-config-core');
      defaults = projectConfigCore.getProjectDefaults(projectRow.path || projectRow.id);
    } catch (_e) { void _e; }
    const verifyCommand = baselineProbe.resolveBaselineVerifyCommand({ cfg, defaults });
    if (!verifyCommand) {
      return makeError(
        ErrorCodes.INVALID_PARAM,
        `Project "${projectRow.name}" has no verify_command configured; cannot probe. Set one via set_project_defaults (verify_command or baseline_verify_command) and try again.`,
      );
    }


    const timeoutMs = baselineProbe.resolveBaselineProbeTimeoutMs({
      timeout_minutes: args.timeout_minutes,
      config: cfg,
    });
    if (hasRunningBaselineResumeJob(projectRow.id)) {
      return makeError(
        ErrorCodes.CONFLICT,
        `A baseline resume operation is already running for project "${projectRow.name}".`,
      );
    }

    const job = createBaselineResumeJob(projectRow.id, projectRow.name, timeoutMs);
    const jobs = getBaselineResumeJobsByProject(projectRow.id);
    jobs.set(job.job_id, job);
    trimBaselineResumeJobs(projectRow.id);
    void executeBaselineResumeProbe({
      projectRow,
      job,
      verifyCommand,
      timeoutMs,
    });

    return jsonResponse(normalizeBaselineResumeJob(job), {
      status: 202,
      headers: {
        Location: `/api/v2/factory/projects/${projectRow.id}/baseline-resume/${job.job_id}`,
      },
    });
  } catch (err) {
    logger.warn('handleResumeProjectBaselineFixed failed', { err: err.message });
    return makeError(ErrorCodes.INTERNAL_ERROR, `Failed to resume project baseline: ${err.message}`);
  }
}

async function handleBaselineResumeJobStatus(args) {
  const project = resolveProject(args.project);
  const job = getBaselineResumeJob(project.id, args.job_id);
  if (!job) {
    return jsonResponse(null, {
      status: 404,
      errorCode: 'baseline_resume_job_not_found',
      errorMessage: `Baseline resume job not found: ${args.job_id}`,
    });
  }
  return jsonResponse(normalizeBaselineResumeJob(job));
}

async function handleFactoryLoopStatus(args) {
  const project = resolveProject(args.project);
  const result = loopController.getLoopStateForProject(project.id);
  return jsonResponse(result);
}

async function handleListFactoryLoopInstances(args) {
  try {
    const project = resolveProject(args.project);
    const activeOnly = args.active_only === true || args.active_only === 'true';
    const instances = (activeOnly
      ? loopController.getActiveInstances(project.id)
      : factoryLoopInstances.listInstances({ project_id: project.id, active_only: false }))
      .map(normalizeFactoryLoopInstance);

    return jsonResponse({
      project_id: project.id,
      active_only: activeOnly,
      count: instances.length,
      instances,
    });
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

async function handleFactoryCycleHistory(args) {
  try {
    const project = resolveProject(args.project);
    const db = ensureFactoryDecisionDb();
    const instances = factoryLoopInstances.listInstances({
      project_id: project.id,
      active_only: false,
    });
    const recentInstances = instances.slice(-MAX_FACTORY_CYCLE_HISTORY);

    if (!db || recentInstances.length === 0) {
      return jsonResponse({
        project_id: project.id,
        count: 0,
        cycles: [],
      });
    }

    const oldestStartedAt = recentInstances[0]?.created_at || null;
    const decisionParams = [project.id];
    const decisionWhere = ['project_id = ?'];

    if (oldestStartedAt) {
      decisionWhere.push('created_at >= ?');
      decisionParams.push(oldestStartedAt);
    }

    const decisionRows = db.prepare(`
      SELECT id, stage, action, batch_id, inputs_json, outcome_json, created_at
      FROM factory_decisions
      WHERE ${decisionWhere.join(' AND ')}
      ORDER BY created_at ASC, id ASC
    `).all(...decisionParams)
      .map((row) => factoryDecisions.parseDecisionRow({ ...row }));

    const workItemTitleStatement = db.prepare(`
      SELECT title
      FROM factory_work_items
      WHERE project_id = ?
        AND id = ?
      LIMIT 1
    `);

    const instanceById = new Map();
    const instancesByBatch = new Map();
    const decisionsByInstanceId = new Map();

    for (const instance of recentInstances) {
      instanceById.set(instance.id, instance);
      decisionsByInstanceId.set(instance.id, []);

      if (instance.batch_id) {
        const batchInstances = instancesByBatch.get(instance.batch_id) || [];
        batchInstances.push(instance);
        instancesByBatch.set(instance.batch_id, batchInstances);
      }
    }

    for (const decision of decisionRows) {
      const matchedInstance = resolveFactoryCycleDecisionInstance(
        decision,
        recentInstances,
        instanceById,
        instancesByBatch,
      );

      if (!matchedInstance) {
        continue;
      }

      decisionsByInstanceId.get(matchedInstance.id)?.push(decision);
    }

    const cycles = recentInstances
      .slice()
      .reverse()
      .map((instance) => {
        const workItemRow = instance.work_item_id
          ? workItemTitleStatement.get(project.id, instance.work_item_id)
          : null;

        return summarizeFactoryCycleInstance(
          instance,
          decisionsByInstanceId.get(instance.id) || [],
          workItemRow?.title || null,
        );
      });

    return jsonResponse({
      project_id: project.id,
      count: cycles.length,
      cycles,
    });
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

async function handleFactoryLoopInstanceStatus(args) {
  try {
    loopController.getLoopState(args.instance);
    return jsonResponse(normalizeFactoryLoopInstance(factoryLoopInstances.getInstance(args.instance)));
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

async function handleStartFactoryLoopInstance(args) {
  try {
    const project = resolveProject(args.project);
    const started = await loopController.startLoop(project.id);
    const instance = factoryLoopInstances.getInstance(started.instance_id);
    return jsonResponse(normalizeFactoryLoopInstance(instance));
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

async function handleAdvanceFactoryLoopInstance(args) {
  try {
    const result = await loopController.advanceLoop(args.instance);
    return jsonResponse(result);
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

async function handleAdvanceFactoryLoopInstanceAsync(args) {
  try {
    loopController.getLoopState(args.instance);
    const result = loopController.advanceLoopAsync(args.instance);
    return jsonResponse(result, {
      status: 202,
      headers: {
        Location: `/api/v2/factory/loops/${args.instance}/advance/${result.job_id}`,
      },
    });
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

async function handleApproveFactoryGateInstance(args) {
  try {
    const result = await loopController.approveGate(args.instance, args.stage);
    return jsonResponse(result);
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

async function handleRejectFactoryGateInstance(args) {
  try {
    const result = await loopController.rejectGate(args.instance, args.stage);
    return jsonResponse(result);
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

async function handleRetryFactoryVerifyInstance(args) {
  try {
    const result = loopController.retryVerifyFromFailure(args.instance);
    const project = factoryHealth.getProject(result.project_id);
    const resumeResult = resumeProjectRowForFactoryAction(project, args, 'retry_factory_verify_instance');
    if (resumeResult.resumed) {
      result.project_resumed = true;
      result.project_status = resumeResult.project.status;
    }
    return jsonResponse(result);
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

// Operator-level terminate — unlike rejectGate (which only works at valid gate
// stages), this forcibly terminates any instance regardless of state. Intended
// for recovering from stuck paused_at_stage states (e.g. EXECUTE failures that
// leave the stage claim held). terminateInstanceAndSync() handles worktree
// row cleanup so the branch name is immediately available for retries.
async function handleTerminateFactoryLoopInstance(args) {
  try {
    const instance = factoryLoopInstances.getInstance(args.instance);
    if (!instance) {
      return factoryHandlerError(
        ErrorCodes.RESOURCE_NOT_FOUND,
        `Factory loop instance not found: ${args.instance}`,
        404,
      );
    }
    if (instance.terminated_at) {
      return jsonResponse({
        instance_id: instance.id,
        project_id: instance.project_id,
        already_terminated: true,
        terminated_at: instance.terminated_at,
      });
    }
    const before = {
      loop_state: instance.loop_state,
      paused_at_stage: instance.paused_at_stage || null,
      batch_id: instance.batch_id || null,
    };
    // Operator force-terminate always abandons the worktree — the operator
    // is explicitly killing this instance and wants the stage claim freed.
    const terminated = loopController.terminateInstanceAndSync(instance.id, { abandonWorktree: true });
    return jsonResponse({
      instance_id: terminated.id,
      project_id: terminated.project_id,
      terminated_at: terminated.terminated_at,
      previous_state: before,
      message: 'Factory loop instance terminated',
    });
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

async function handleFactoryLoopJobStatus(args) {
  const project = resolveProject(args.project);
  const result = loopController.getLoopAdvanceJobStatusForProject(project.id, args.job_id);

  if (!result) {
    return jsonResponse(null, {
      status: 404,
      errorCode: 'loop_job_not_found',
      errorMessage: `Loop advance job not found: ${args.job_id}`,
    });
  }

  return jsonResponse(result);
}

async function handleFactoryLoopInstanceJobStatus(args) {
  try {
    loopController.getLoopState(args.instance);
    const result = loopController.getLoopAdvanceJobStatus(args.instance, args.job_id);

    if (!result) {
      return factoryHandlerError(
        ErrorCodes.RESOURCE_NOT_FOUND,
        `Loop advance job not found: ${args.job_id}`,
        404,
      );
    }

    return jsonResponse(result);
  } catch (error) {
    return buildFactoryLoopErrorResponse(error);
  }
}

async function handleAttachFactoryBatch(args) {
  const project = resolveProject(args.project);
  const result = loopController.attachBatchIdForProject(project.id, args.batch_id);
  return jsonResponse(result);
}

async function handleAnalyzeBatch(args) {
  const project = resolveProject(args.project);
  const result = await analyzeBatch(project.id, args.batch_id, {
    task_count: args.task_count,
    retry_count: args.retry_count,
    duration_seconds: args.duration_seconds,
    estimated_cost: args.estimated_cost,
    human_corrections: args.human_corrections,
  });
  logger.info(`Batch analysis complete for "${project.name}" batch ${args.batch_id}`);
  return jsonResponse(result);
}

async function handleFactoryDriftStatus(args) {
  const project = resolveProject(args.project);
  const result = detectDrift(project.id, { window: args.window });
  return jsonResponse({ project: project.name, ...result });
}

async function handleRecordCorrection(args) {
  const project = resolveProject(args.project);
  const result = recordHumanCorrection(project.id, {
    type: args.type,
    description: args.description,
  });
  logger.info(`Correction recorded for "${project.name}": ${args.type}`);
  return jsonResponse(result);
}

async function handleFactoryCostMetrics(args) {
  const project = resolveProject(args.project);
  const summary = buildProjectCostSummary(project.id);

  return jsonResponse({
    project: { id: project.id, name: project.name, path: project.path },
    cost_per_cycle: getCostPerCycle(project.id, summary),
    cost_per_health_point: getCostPerHealthPoint(project.id, summary),
    provider_efficiency: getProviderEfficiency(project.id, summary),
  });
}

async function handleDecisionLog(args) {
  const project = resolveProject(args.project);
  ensureFactoryDecisionDb();
  if (args.batch_id) {
    const decisions = getDecisionContext(project.id, args.batch_id);
    return jsonResponse({ decisions, batch_id: args.batch_id });
  }
  const decisions = getAuditTrail(project.id, {
    stage: args.stage,
    actor: args.actor,
    since: args.since,
    limit: args.limit,
  });
  const stats = getDecisionStats(project.id);
  return jsonResponse({ decisions, stats });
}

async function handleFactoryProviderLaneAudit(args) {
  const project = resolveProject(args.project);
  const audit = buildProviderLaneAudit({
    project,
    db: getDatabase().getDbInstance(),
    limit: args.limit,
    expected_provider: args.expected_provider,
    allowed_fallback_providers: args.allowed_fallback_providers,
    require_classified_fallback: args.require_classified_fallback,
    effective_since: args.effective_since,
    since: args.since,
  });
  return jsonResponse(audit);
}

async function handleFactoryNotifications(args) {
  const project = resolveProject(args.project);
  if (args.action === 'test') {
    notifications.notify({
      project_id: project.id,
      event_type: 'test',
      data: { message: 'Test notification from factory', project_name: project.name },
    });
    return jsonResponse({ message: 'Test notification sent', channels: notifications.listChannels() });
  }
  return jsonResponse({ channels: notifications.listChannels() });
}

async function handleFactoryDigest(args) {
  const project = resolveProject(args.project);
  const digest = notifications.getDigest(project.id);
  return jsonResponse(digest);
}

module.exports = {
  handleRegisterFactoryProject,
  handleListFactoryProjects,
  handleProjectHealth,
  handleScanProjectHealth,
  handleSetFactoryTrustLevel,
  handleGetProjectPolicy,
  handleSetProjectPolicy,
  handleGuardrailStatus,
  handleRunGuardrailCheck,
  handleGuardrailEvents,
  handlePauseProject,
  handleResumeProject,
  handlePauseAllProjects,
  handleFactoryStatus,
  handleCreateWorkItem,
  handleListWorkItems,
  handleUpdateWorkItem,
  handleRejectWorkItem,
  handleIntakeFromFindings,
  handleScanPlansDirectory,
  handleExecutePlanFile,
  handleGetPlanExecutionStatus,
  handleListPlanIntakeItems,
  handlePollGitHubIssues,
  handleTriggerArchitect,
  handleArchitectBacklog,
  handleArchitectLog,
  handleResetFactoryLoop,
  handleStartFactoryLoop,
  handleAwaitFactoryLoop,
  handleAdvanceFactoryLoop,
  handleAdvanceFactoryLoopAsync,
  handleApproveFactoryGate,
  handleRetryFactoryVerify,
  handleBaselineResumeJobStatus,
  handleResumeProjectBaselineFixed,
  handleFactoryLoopStatus,
  handleListFactoryLoopInstances,
  handleFactoryCycleHistory,
  handleFactoryLoopInstanceStatus,
  handleStartFactoryLoopInstance,
  handleAdvanceFactoryLoopInstance,
  handleAdvanceFactoryLoopInstanceAsync,
  handleApproveFactoryGateInstance,
  handleRejectFactoryGateInstance,
  handleRetryFactoryVerifyInstance,
  handleTerminateFactoryLoopInstance,
  handleFactoryLoopJobStatus,
  handleFactoryLoopInstanceJobStatus,
  handleAttachFactoryBatch,
  handleAnalyzeBatch,
  handleFactoryDriftStatus,
  handleRecordCorrection,
  handleFactoryCostMetrics,
  handleDecisionLog,
  handleFactoryProviderLaneAudit,
  handleFactoryNotifications,
  handleFactoryDigest,
};

Object.defineProperty(module.exports, '__test', {
  value: {
    countCommitsToday,
    clearCommitsTodayCache,
    getCachedCommitsToday,
  },
  enumerable: false,
});
