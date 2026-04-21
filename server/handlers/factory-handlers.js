'use strict';

const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const database = require('../database');
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
const { pollGitHubIssues } = require('../factory/github-intake');
const { createPlanFileIntake } = require('../factory/plan-file-intake');
const { createShippedDetector } = require('../factory/shipped-detector');
const { analyzeBatch, detectDrift, recordHumanCorrection } = require('../factory/feedback');
const { buildProjectCostSummary, getCostPerCycle, getCostPerHealthPoint, getProviderEfficiency } = require('../factory/cost-metrics');
const { logDecision, getAuditTrail, getDecisionContext, getDecisionStats } = require('../factory/decision-log');
const notifications = require('../factory/notifications');
const { ErrorCodes, makeError } = require('./error-codes');
const logger = require('../logger').child({ component: 'factory-handlers' });

const STALL_THRESHOLD_MS = 30 * 60 * 1000;
const COMMITS_TODAY_CACHE_TTL_MS = 60 * 1000;
const COMMITS_TODAY_TIMEOUT_MS = 5 * 1000;
const commitsTodayCache = new Map();

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

function getFactoryStatusAlertBadge(projectId, { openWorkItemCount, loopState } = {}) {
  const hasPendingWork = openWorkItemCount > 0;
  const hasRunningLoop = normalizeProjectLoopState(loopState) !== 'IDLE';
  if (hasPendingWork || hasRunningLoop) {
    notifications.recordFactoryIdleState({
      project_id: projectId,
      pending_count: openWorkItemCount,
      running_count: hasRunningLoop ? 1 : 0,
      has_pending_work: hasPendingWork,
      has_running_item: hasRunningLoop,
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
  const db = database.getDbInstance();
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
  const project = factoryHealth.registerProject({
    name: args.name,
    path: args.path,
    brief: args.brief,
    trust_level: args.trust_level,
  });
  logger.info(`Registered factory project: ${project.name} (${project.id})`);
  return jsonResponse({
    message: `Project "${project.name}" registered with trust level: ${project.trust_level}`,
    project,
  });
}

async function handleListFactoryProjects(args) {
  const projects = factoryHealth.listProjects(args.status ? { status: args.status } : undefined);
  const summaries = projects.map(p => {
    const scores = factoryHealth.getLatestScores(p.id);
    const balance = factoryHealth.getBalanceScore(p.id, scores);
    return { ...p, scores, balance };
  });
  return jsonResponse({ projects: summaries });
}

async function handleProjectHealth(args) {
  const project = resolveProject(args.project);
  const scores = factoryHealth.getLatestScores(project.id);
  const balance = factoryHealth.getBalanceScore(project.id, scores);
  const dimensions = Object.keys(scores);
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];

  const result = {
    project: { id: project.id, name: project.name, path: project.path, trust_level: project.trust_level, status: project.status },
    scores,
    balance,
    weakest_dimension: weakest ? { dimension: weakest[0], score: weakest[1] } : null,
  };

  if (args.include_trends) {
    result.trends = {};
    for (const dim of dimensions) {
      result.trends[dim] = factoryHealth.getScoreHistory(project.id, dim, 20);
    }
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
    updates.config_json = JSON.stringify({ ...existing, ...args.config });
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
  // Start factory tick timer when project resumes
  try {
    const { startTick } = require('../factory/factory-tick');
    startTick(updated);
  } catch (_e) { void _e; /* factory-tick not loaded */ }
  logger.info(`Factory project resumed: ${updated.name}`);
  return jsonResponse({
    message: `Project "${updated.name}" running`,
    project: updated,
  });
}

async function handlePauseAllProjects(args = {}) {
  const projects = factoryHealth.listProjects();
  let paused = 0;
  for (const p of projects) {
    if (p.status !== 'paused') {
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
      paused++;
    }
  }
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
  const summaries = await Promise.all(projects.map(async (p) => {
    const scores = factoryHealth.getLatestScores(p.id);
    const balance = factoryHealth.getBalanceScore(p.id, scores);
    const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];

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
    const openWorkItemCount = countOpenFactoryWorkItems(p.id);
    const alertBadge = getFactoryStatusAlertBadge(p.id, {
      openWorkItemCount,
      loopState,
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
      loop_paused_at_stage: pausedAtStage,
      loop_last_action_at: lastActionAt,
      consecutive_empty_cycles: Number.isFinite(p.consecutive_empty_cycles) ? p.consecutive_empty_cycles : 0,
      alert_badge: alertBadge,
      balance,
      weakest_dimension: weakest ? weakest[0] : null,
      dimension_count: Object.keys(scores).length,
    };
  }));

  const running = summaries.filter(p => p.status === 'running').length;
  const paused = summaries.filter(p => p.status === 'paused').length;
  const productionToday = summaries.reduce((sum, project) => sum + project.commits_today, 0);
  const zeroCommitProjects = summaries.filter(project => project.status === 'running' && project.commits_today === 0).length;
  // Stall calculation uses the instance-derived state too, so a dead
  // instance can't look "running but stalled" forever — with no active
  // instance, loop_state is IDLE and the project is excluded from stalled.
  const stalled = summaries.filter((summary) => {
    if (summary.loop_state === 'IDLE' || !summary.loop_last_action_at) {
      return false;
    }
    const lastActionMs = Date.parse(summary.loop_last_action_at);
    return Number.isFinite(lastActionMs) && (nowMs - lastActionMs) >= STALL_THRESHOLD_MS;
  }).length;

  logger.debug('Loaded factory_status productivity snapshot', {
    'x-cache-hit-count': cacheHitCount,
    project_count: summaries.length,
    production_today: productionToday,
    zero_commit_projects: zeroCommitProjects,
  });

  return jsonResponse({
    projects: summaries,
    summary: {
      total: projects.length,
      running,
      paused,
      stalled,
      production_today: productionToday,
      zero_commit_projects: zeroCommitProjects,
    },
  });
}

async function handleCreateWorkItem(args) {
  const project = resolveProject(args.project);
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

  const created = factoryIntake.createFromFindings(project.id, findings, args.source);
  // createFromFindings returns an array with a non-enumerable `.skipped` side-channel.
  const skipped = Array.isArray(created.skipped) ? created.skipped : [];
  return jsonResponse({
    message: `Imported ${created.length} items, ${skipped.length} skipped`,
    created,
    skipped,
    source_file: sourceFile || null,
  });
}

async function handleScanPlansDirectory(args) {
  const project = resolveProject(args.project_id);
  const db = database.getDbInstance();
  const repoRoot = resolvePlansRepoRoot(project.path, args.plans_dir);
  const shippedDetector = createShippedDetector({ repoRoot });
  const planIntake = createPlanFileIntake({ db, factoryIntake, shippedDetector });
  const scanArgs = {
    project_id: project.id,
    plans_dir: args.plans_dir,
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
  return jsonResponse(result);
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

    const cfg = projectRow.config_json
      ? (() => { try { return JSON.parse(projectRow.config_json); } catch { return {}; } })()
      : {};
    if (!cfg.baseline_broken_since) {
      return makeError(
        ErrorCodes.CONFLICT,
        `Project "${projectRow.name}" is not flagged baseline_broken; nothing to resume.`,
      );
    }

    let verifyCommand = cfg.verify_command || null;
    if (!verifyCommand) {
      try {
        const projectConfigCore = require('../db/project-config-core');
        const defaults = projectConfigCore.getProjectDefaults(projectRow.path || projectRow.id);
        if (defaults && defaults.verify_command) {
          verifyCommand = defaults.verify_command;
        }
      } catch (_e) { void _e; }
    }
    if (!verifyCommand) {
      return makeError(
        ErrorCodes.INVALID_PARAM,
        `Project "${projectRow.name}" has no verify_command configured; cannot probe. Set one via set_project_defaults and try again.`,
      );
    }

    const baselineProbe = require('../factory/baseline-probe');
    const runnerRegistry = require('../test-runner-registry').createTestRunnerRegistry();
    const runner = async ({ command, cwd, timeoutMs }) => {
      const r = await runnerRegistry.runVerifyCommand(command, cwd, { timeout: timeoutMs });
      return {
        exitCode: r.exitCode,
        stdout: r.output || '',
        stderr: r.error || '',
        durationMs: r.durationMs,
        timedOut: !!r.timedOut,
      };
    };

    const probe = await baselineProbe.probeProjectBaseline({
      project: projectRow,
      verifyCommand,
      runner,
      timeoutMs: 5 * 60 * 1000,
    });

    if (!probe.passed) {
      const preview = String(probe.output || '').slice(-1500);
      return makeError(
        ErrorCodes.CONFLICT,
        `Baseline still failing (exit ${probe.exitCode}). Fix the failing tests, then try again.\n\nProbe output (last 1500 chars):\n${preview}`,
      );
    }

    const pausedSince = Date.parse(cfg.baseline_broken_since) || Date.now();
    cfg.baseline_broken_since = null;
    cfg.baseline_broken_reason = null;
    cfg.baseline_broken_evidence = null;
    cfg.baseline_broken_probe_attempts = 0;
    cfg.baseline_broken_tick_count = 0;
    factoryHealth.updateProject(projectRow.id, {
      status: 'running',
      config_json: JSON.stringify(cfg),
    });
    // Re-start factory tick timer on resume. The pause path stops the tick
    // for trust_level != autonomous/dark or non-auto_continue projects, so
    // without startTick here the project would sit in status='running' with
    // no active tick, and nothing would advance. Mirror handleResumeProject.
    try {
      const updated = factoryHealth.getProject(projectRow.id);
      const factoryTick = require('../factory/factory-tick');
      factoryTick.startTick(updated);
    } catch (_e) { void _e; /* factory-tick not loaded */ }
    try {
      const eventBus = require('../event-bus');
      eventBus.emitFactoryProjectBaselineCleared({
        project_id: projectRow.id,
        cleared_after_ms: Date.now() - pausedSince,
      });
    } catch (_e) { void _e; }

    return jsonResponse({
      status: 'resumed',
      message: `Project "${projectRow.name}" resumed — baseline probe passed in ${probe.durationMs}ms.`,
      project_id: projectRow.id,
      probe_duration_ms: probe.durationMs,
    });
  } catch (err) {
    logger.warn('handleResumeProjectBaselineFixed failed', { err: err.message });
    return makeError(ErrorCodes.INTERNAL_ERROR, `Failed to resume project baseline: ${err.message}`);
  }
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
