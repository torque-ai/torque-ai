'use strict';

const path = require('path');
const { getGatesForTrustLevel } = require('./loop-states');

function parseBoolConfigValue(value, fallback = true) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return Boolean(fallback);
}

function isFactoryProjectWorkEnabled(configSource = null) {
  try {
    const source = configSource || require('../config');
    if (source && typeof source.getBool === 'function') {
      return source.getBool('factory_project_work_enabled', true) === true;
    }
    if (source && typeof source.getConfig === 'function') {
      const raw = source.getConfig('factory_project_work_enabled');
      return parseBoolConfigValue(raw, true);
    }
  } catch {
    // Fall through to fail-open default below.
  }
  return true;
}

function parseProjectConfig(project) {
  if (project && project.config && typeof project.config === 'object' && !Array.isArray(project.config)) {
    return project.config;
  }
  const configJson = typeof project === 'string'
    ? project
    : project?.config_json;
  if (!configJson) {
    return {};
  }
  try {
    return JSON.parse(configJson) || {};
  } catch {
    return {};
  }
}

function getTaskTags(task) {
  const rawTags = task?.tags;
  if (Array.isArray(rawTags)) {
    return rawTags.map((tag) => String(tag));
  }
  if (typeof rawTags !== 'string' || !rawTags.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawTags);
    if (Array.isArray(parsed)) {
      return parsed.map((tag) => String(tag));
    }
  } catch {
    // Fall through to legacy comma-separated tags.
  }
  return rawTags.split(',').map((tag) => tag.trim()).filter(Boolean);
}

function parseTaskMetadata(task) {
  const raw = task?.metadata;
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getFactoryTagValue(tags, prefix) {
  const tag = tags.find((item) => typeof item === 'string' && item.startsWith(prefix));
  return tag ? tag.slice(prefix.length).trim() : null;
}

function getFactoryProjectSignal(task) {
  const tags = getTaskTags(task);
  const direct = getFactoryTagValue(tags, 'factory:project_id=');
  if (direct) return { project_id: direct, matched_by: 'factory_project_tag' };

  const batchId = getFactoryTagValue(tags, 'factory:batch_id=');
  if (batchId) {
    const match = batchId.match(/^factory-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i);
    return {
      project_id: match ? match[1] : null,
      matched_by: 'factory_batch_tag',
    };
  }

  const metadata = parseTaskMetadata(task);
  const factoryProjectId = typeof metadata.factory_project_id === 'string'
    ? metadata.factory_project_id.trim()
    : '';
  if (factoryProjectId) {
    return { project_id: factoryProjectId, matched_by: 'factory_project_metadata' };
  }

  const hasFactorySignal = tags.some((tag) => typeof tag === 'string' && tag.startsWith('factory:'))
    || metadata.factory_internal === true;
  const metadataProjectId = typeof metadata.project_id === 'string'
    ? metadata.project_id.trim()
    : '';
  if (hasFactorySignal) {
    return {
      project_id: metadataProjectId || null,
      matched_by: 'factory_task_signal',
    };
  }

  return null;
}

function getRawDbHandle(dbHandle) {
  if (!dbHandle) return null;
  if (typeof dbHandle.getDbInstance === 'function') {
    try {
      return dbHandle.getDbInstance();
    } catch {
      return null;
    }
  }
  return typeof dbHandle.prepare === 'function' ? dbHandle : null;
}

function listRegisteredFactoryProjects(dbHandle) {
  const rawDb = getRawDbHandle(dbHandle);
  if (!rawDb || typeof rawDb.prepare !== 'function') return [];
  try {
    const rows = rawDb.prepare(`
      SELECT id, name, path
      FROM factory_projects
      WHERE id IS NOT NULL OR name IS NOT NULL OR path IS NOT NULL
    `).all();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function normalizePathKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let normalized;
  try {
    normalized = path.normalize(value.trim());
  } catch {
    return null;
  }
  normalized = normalized.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathMatchesRegisteredProject(workingDirectory, projectPath) {
  const wdKey = normalizePathKey(workingDirectory);
  const projectKey = normalizePathKey(projectPath);
  if (!wdKey || !projectKey) return false;
  if (wdKey === projectKey) return true;
  const separator = projectKey.includes('\\') ? '\\' : path.sep;
  return wdKey.startsWith(projectKey + separator);
}

function findRegisteredProjectBySignal(projects, signal) {
  if (!signal?.project_id) return null;
  const signalKey = String(signal.project_id).trim();
  if (!signalKey) return null;
  const foldedSignal = signalKey.toLowerCase();
  return projects.find((project) => (
    String(project?.id || '').trim().toLowerCase() === foldedSignal
    || String(project?.name || '').trim().toLowerCase() === foldedSignal
  )) || null;
}

function resolveRegisteredFactoryProjectTask(task, dbHandle = null) {
  const signal = getFactoryProjectSignal(task);
  const projects = listRegisteredFactoryProjects(dbHandle);
  if (signal) {
    const registered = findRegisteredProjectBySignal(projects, signal);
    return registered
      ? { ...registered, matched_by: signal.matched_by }
      : { id: signal.project_id || null, matched_by: signal.matched_by };
  }

  const workingDirectory = task?.working_directory;
  if (!workingDirectory || projects.length === 0) {
    return null;
  }

  let bestMatch = null;
  let bestMatchLen = -1;
  for (const project of projects) {
    if (!project?.path || !pathMatchesRegisteredProject(workingDirectory, project.path)) {
      continue;
    }
    const projectPathKey = normalizePathKey(project.path) || '';
    if (projectPathKey.length > bestMatchLen) {
      bestMatch = { ...project, matched_by: 'registered_project_path' };
      bestMatchLen = projectPathKey.length;
    }
  }
  return bestMatch;
}

function isRegisteredFactoryProjectTask(task, dbHandle = null) {
  return Boolean(resolveRegisteredFactoryProjectTask(task, dbHandle));
}

function getApprovalGatesForTrustLevel(trustLevel) {
  const normalizedTrustLevel = String(trustLevel || 'supervised').trim().toLowerCase() || 'supervised';
  try {
    return getGatesForTrustLevel(normalizedTrustLevel);
  } catch {
    return null;
  }
}

function makeAutomationBlocker(code, message) {
  return { code, message };
}

function makeAutomationControlPlaneStep(action, tool, args, description) {
  return {
    action,
    tool,
    args,
    description,
    effect_scope: 'control_plane',
    mutates_control_plane: true,
    processes_project_work: false,
    enables_future_processing: true,
  };
}

function getAutomationControlPlanePlan(project, blockerCodes, trustLevel) {
  const projectRef = project?.id || project?.path || project?.name || null;
  const steps = [];
  const needsDarkTrust = blockerCodes.includes('approval_gates_enabled')
    || blockerCodes.includes('invalid_trust_level');
  const needsAutoContinue = blockerCodes.includes('auto_continue_disabled');

  if (needsAutoContinue && needsDarkTrust) {
    steps.push(makeAutomationControlPlaneStep(
      'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
      'set_factory_trust_level',
      {
        project: projectRef,
        trust_level: 'dark',
        config: { loop: { auto_continue: true } },
      },
      'Enable dark trust and continuous cycling.'
    ));
  } else if (needsAutoContinue) {
    steps.push(makeAutomationControlPlaneStep(
      `set_factory_trust_level trust_level=${trustLevel} config.loop.auto_continue=true`,
      'set_factory_trust_level',
      {
        project: projectRef,
        trust_level: trustLevel,
        config: { loop: { auto_continue: true } },
      },
      'Enable continuous cycling while preserving the current trust level.'
    ));
  } else if (needsDarkTrust) {
    steps.push(makeAutomationControlPlaneStep(
      'set_factory_trust_level trust_level=dark',
      'set_factory_trust_level',
      {
        project: projectRef,
        trust_level: 'dark',
      },
      'Remove approval gates by switching to dark trust.'
    ));
  }

  if (blockerCodes.includes('operator_paused')) {
    steps.push(makeAutomationControlPlaneStep(
      'resume_project with clear_operator_pause=true immediate_tick=false',
      'resume_project',
      {
        project: projectRef,
        clear_operator_pause: true,
        immediate_tick: false,
      },
      'Clear the operator pause marker and resume the project.'
    ));
  } else if (blockerCodes.includes('project_not_running')) {
    steps.push(makeAutomationControlPlaneStep(
      'resume_project immediate_tick=false',
      'resume_project',
      {
        project: projectRef,
        immediate_tick: false,
      },
      'Resume the project.'
    ));
  }

  return steps;
}

function summarizeProjectAutomationReadiness(project) {
  const cfg = parseProjectConfig(project);
  const loop = cfg.loop && typeof cfg.loop === 'object' && !Array.isArray(cfg.loop)
    ? cfg.loop
    : {};
  const status = String(project?.status || 'unknown').trim().toLowerCase() || 'unknown';
  const trustLevel = String(project?.trust_level || 'supervised').trim().toLowerCase() || 'supervised';
  const approvalGates = getApprovalGatesForTrustLevel(trustLevel);
  const autoContinue = loop.auto_continue === true;
  const autoAdvance = loop.auto_advance === true;
  const operatorPaused = loop.operator_paused === true;
  const blockers = [];

  if (operatorPaused) {
    blockers.push(makeAutomationBlocker(
      'operator_paused',
      'Project has an explicit operator pause marker.'
    ));
  }
  if (status !== 'running') {
    blockers.push(makeAutomationBlocker(
      'project_not_running',
      `Project status is ${status}; factory tick only advances running projects.`
    ));
  }
  if (!autoContinue) {
    blockers.push(makeAutomationBlocker(
      'auto_continue_disabled',
      'loop.auto_continue is not enabled, so the factory will not keep cycling after LEARN.'
    ));
  }
  if (approvalGates === null) {
    blockers.push(makeAutomationBlocker(
      'invalid_trust_level',
      `Trust level ${trustLevel} is not a valid factory trust level.`
    ));
  } else if (approvalGates.length > 0) {
    blockers.push(makeAutomationBlocker(
      'approval_gates_enabled',
      `Trust level ${trustLevel} still requires approval gates: ${approvalGates.join(', ')}.`
    ));
  }

  const blockerCodes = blockers.map((blocker) => blocker.code);
  const controlPlanePlan = getAutomationControlPlanePlan(project, blockerCodes, trustLevel);
  const controlPlaneActions = controlPlanePlan.map((step) => step.action);
  return {
    ready: blockers.length === 0,
    status,
    trust_level: trustLevel,
    auto_continue: autoContinue,
    auto_advance: autoAdvance,
    operator_paused: operatorPaused,
    approval_gates: approvalGates || [],
    blocker_codes: blockerCodes,
    blockers,
    next_control_plane_action: controlPlaneActions[0] || null,
    control_plane_actions: controlPlaneActions,
    control_plane_plan: controlPlanePlan,
  };
}

function getCount(counts, key) {
  const value = Number(counts?.[key]);
  return Number.isFinite(value) ? value : 0;
}

const MAX_REJECT_REASON_COUNTS_PER_BLOCKER = 5;

function normalizeNullableTimestamp(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRejectReasonCounts(project, status) {
  const byStatus = project?._work_item_blocker_reason_counts
    || project?.work_item_blocker_reason_counts
    || {};
  const rows = Array.isArray(byStatus?.[status]) ? byStatus[status] : [];
  return rows
    .map((row) => ({
      reject_reason: typeof row?.reject_reason === 'string' && row.reject_reason.trim()
        ? row.reject_reason
        : null,
      count: getCount(row, 'count'),
    }))
    .filter((row) => row.count > 0)
    .slice(0, MAX_REJECT_REASON_COUNTS_PER_BLOCKER);
}

function normalizeWorkItemBlockerQueueStats(project, status) {
  const byStatus = project?._work_item_blocker_queue_stats
    || project?.work_item_blocker_queue_stats
    || {};
  const row = byStatus?.[status];
  if (!row || typeof row !== 'object') return null;

  const stats = {
    oldest_created_at: normalizeNullableTimestamp(row.oldest_created_at),
    oldest_updated_at: normalizeNullableTimestamp(row.oldest_updated_at),
    newest_updated_at: normalizeNullableTimestamp(row.newest_updated_at),
  };
  return Object.values(stats).some(Boolean) ? stats : null;
}

function makeWorkItemBlockerEntry(project, status, count) {
  const entry = {
    project_id: project?.id || null,
    project_name: project?.name || null,
    status,
    count,
  };
  const queueStats = normalizeWorkItemBlockerQueueStats(project, status);
  if (queueStats) {
    Object.assign(entry, queueStats);
  }
  const rejectReasonCounts = normalizeRejectReasonCounts(project, status);
  if (rejectReasonCounts.length > 0) {
    entry.reject_reason_counts = rejectReasonCounts;
  }
  return entry;
}

function normalizeIdSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
}

function buildManualInterventionSummary(projects, readiness, taskQueue = null, scheduler = null) {
  const projectList = Array.isArray(projects) ? projects : [];
  const projectWorkEnabled = isFactoryProjectWorkEnabled();
  const hasSchedulerInfo = scheduler && Array.isArray(scheduler.active_project_ids);
  const activeTickProjectIds = normalizeIdSet(scheduler?.active_project_ids);
  let needsReviewWorkItems = 0;
  let escalationExhaustedWorkItems = 0;
  const schedulerUnarmedProjectIds = [];
  const workItemBlockers = {
    needs_review: [],
    escalation_exhausted: [],
  };
  for (const project of projectList) {
    const counts = project?.work_item_status_counts || {};
    const projectNeedsReview = getCount(counts, 'needs_review');
    const projectEscalationExhausted = getCount(counts, 'escalation_exhausted');
    needsReviewWorkItems += projectNeedsReview;
    escalationExhaustedWorkItems += projectEscalationExhausted;
    if (projectNeedsReview > 0) {
      workItemBlockers.needs_review.push(makeWorkItemBlockerEntry(project, 'needs_review', projectNeedsReview));
    }
    if (projectEscalationExhausted > 0) {
      workItemBlockers.escalation_exhausted.push(makeWorkItemBlockerEntry(project, 'escalation_exhausted', projectEscalationExhausted));
    }
    const projectReadiness = project?.automation_readiness || summarizeProjectAutomationReadiness(project);
    if (hasSchedulerInfo && projectReadiness.ready && project?.id && !activeTickProjectIds.has(String(project.id))) {
      schedulerUnarmedProjectIds.push(project.id);
    }
  }

  const pendingApprovalTasks = getCount(taskQueue, 'manual_gate_pending')
    || getCount(taskQueue?.by_status, 'pending_approval');
  const operatorPausedProjects = getCount(readiness, 'operator_paused_projects');
  const approvalGatedProjects = getCount(readiness, 'approval_gated_projects');
  const blockedProjects = getCount(readiness, 'blocked_projects');
  const reasonCodes = [];

  if (!projectWorkEnabled) reasonCodes.push('factory_project_work_disabled');
  if (blockedProjects > 0) reasonCodes.push('control_plane_blocked');
  if (operatorPausedProjects > 0) reasonCodes.push('operator_paused_projects');
  if (approvalGatedProjects > 0) reasonCodes.push('approval_gates_enabled');
  if (pendingApprovalTasks > 0) reasonCodes.push('task_approval_pending');
  if (needsReviewWorkItems > 0) reasonCodes.push('work_items_need_review');
  if (escalationExhaustedWorkItems > 0) reasonCodes.push('work_items_escalation_exhausted');
  if (schedulerUnarmedProjectIds.length > 0) reasonCodes.push('factory_tick_unarmed');

  return {
    required: reasonCodes.length > 0,
    reason_codes: reasonCodes,
    counts: {
      blocked_projects: blockedProjects,
      operator_paused_projects: operatorPausedProjects,
      approval_gated_projects: approvalGatedProjects,
      pending_approval_tasks: pendingApprovalTasks,
      needs_review_work_items: needsReviewWorkItems,
      escalation_exhausted_work_items: escalationExhaustedWorkItems,
      scheduler_unarmed_projects: schedulerUnarmedProjectIds.length,
      factory_project_work_enabled: projectWorkEnabled ? 1 : 0,
    },
    project_ids: {
      scheduler_unarmed: schedulerUnarmedProjectIds.slice(0, 20),
    },
    work_item_blockers: {
      needs_review: workItemBlockers.needs_review.slice(0, 20),
      escalation_exhausted: workItemBlockers.escalation_exhausted.slice(0, 20),
    },
  };
}

function getSchedulerControlPlanePlan(projects, scheduler = null) {
  const projectList = Array.isArray(projects) ? projects : [];
  const hasSchedulerInfo = scheduler && Array.isArray(scheduler.active_project_ids);
  if (!hasSchedulerInfo) {
    return [];
  }
  const activeTickProjectIds = normalizeIdSet(scheduler.active_project_ids);
  return projectList
    .filter((project) => {
      const projectReadiness = project?.automation_readiness || summarizeProjectAutomationReadiness(project);
      return projectReadiness.ready
        && project?.id
        && !activeTickProjectIds.has(String(project.id));
    })
    .map(makeArmFactoryTickStep);
}

const CONFIG_ONLY_AUTOMATION_BLOCKERS = new Set([
  'auto_continue_disabled',
  'approval_gates_enabled',
  'invalid_trust_level',
]);

function hasActiveSchedulerTick(scheduler, projectId) {
  if (!scheduler || !Array.isArray(scheduler.active_project_ids) || !projectId) {
    return false;
  }
  return normalizeIdSet(scheduler.active_project_ids).has(String(projectId));
}

function shouldArmTickAfterControlPlaneSetup(project, readiness, scheduler) {
  if (!project?.id || !scheduler || !Array.isArray(scheduler.active_project_ids)) {
    return false;
  }
  if (readiness?.ready || readiness?.status !== 'running') {
    return false;
  }
  if (hasActiveSchedulerTick(scheduler, project.id)) {
    return false;
  }
  const blockerCodes = Array.isArray(readiness?.blocker_codes) ? readiness.blocker_codes : [];
  return blockerCodes.length > 0
    && blockerCodes.every((code) => CONFIG_ONLY_AUTOMATION_BLOCKERS.has(code));
}

function makeArmFactoryTickStep(project) {
  return makeAutomationControlPlaneStep(
    'arm_factory_tick immediate=false',
    'arm_factory_tick',
    {
      project: project.id,
      immediate: false,
    },
    'Arm the factory tick scheduler without running an immediate tick.'
  );
}

function buildFactoryAutomationReadiness(projects, options = {}) {
  const projectList = Array.isArray(projects) ? projects : [];
  const blockerCounts = {};
  const readyProjectIds = [];
  const blockedProjectIds = [];
  let autoContinueEnabledProjects = 0;
  let darkTrustProjects = 0;
  let operatorPausedProjects = 0;
  let approvalGatedProjects = 0;
  const controlPlanePlan = [];

  for (const project of projectList) {
    const readiness = project?.automation_readiness || summarizeProjectAutomationReadiness(project);
    if (readiness.ready) {
      readyProjectIds.push(project.id);
    } else {
      blockedProjectIds.push(project.id);
    }
    if (readiness.auto_continue) autoContinueEnabledProjects += 1;
    if (readiness.trust_level === 'dark') darkTrustProjects += 1;
    if (readiness.operator_paused) operatorPausedProjects += 1;
    if (readiness.approval_gates.length > 0) approvalGatedProjects += 1;
    for (const code of readiness.blocker_codes || []) {
      blockerCounts[code] = (blockerCounts[code] || 0) + 1;
    }
    if (!readiness.ready && Array.isArray(readiness.control_plane_plan)) {
      controlPlanePlan.push(...readiness.control_plane_plan);
      if (shouldArmTickAfterControlPlaneSetup(project, readiness, options.scheduler || null)) {
        controlPlanePlan.push(makeArmFactoryTickStep(project));
      }
    }
  }

  const readiness = {
    ready: projectList.length > 0 && blockedProjectIds.length === 0,
    total_projects: projectList.length,
    ready_projects: readyProjectIds.length,
    blocked_projects: blockedProjectIds.length,
    auto_continue_enabled_projects: autoContinueEnabledProjects,
    dark_trust_projects: darkTrustProjects,
    operator_paused_projects: operatorPausedProjects,
    approval_gated_projects: approvalGatedProjects,
    blockers: blockerCounts,
    project_work_enabled: isFactoryProjectWorkEnabled(),
    project_ids: {
      ready: readyProjectIds.slice(0, 20),
      blocked: blockedProjectIds.slice(0, 20),
    },
    control_plane_plan: controlPlanePlan,
  };
  const manualIntervention = buildManualInterventionSummary(
    projectList,
    readiness,
    options.taskQueue || null,
    options.scheduler || null
  );
  const schedulerControlPlanePlan = getSchedulerControlPlanePlan(projectList, options.scheduler || null);
  return {
    ...readiness,
    control_plane_plan: [
      ...readiness.control_plane_plan,
      ...schedulerControlPlanePlan,
    ],
    hands_off_ready: readiness.ready && !manualIntervention.required,
    manual_intervention: manualIntervention,
  };
}

function shouldUseConfigDrivenAutoAdvance(project) {
  return summarizeProjectAutomationReadiness(project).ready === true;
}

function shouldAutoStartContinuousLoop(project) {
  return summarizeProjectAutomationReadiness(project).ready === true;
}

function shouldRunUnattendedFactoryWork(project) {
  return isFactoryProjectWorkEnabled() && summarizeProjectAutomationReadiness(project).ready === true;
}

module.exports = {
  buildFactoryAutomationReadiness,
  isFactoryProjectWorkEnabled,
  isRegisteredFactoryProjectTask,
  resolveRegisteredFactoryProjectTask,
  shouldAutoStartContinuousLoop,
  shouldRunUnattendedFactoryWork,
  shouldUseConfigDrivenAutoAdvance,
  summarizeProjectAutomationReadiness,
};
