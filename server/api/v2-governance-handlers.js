'use strict';

/**
 * V2 Control-Plane Governance Handlers
 *
 * Structured JSON REST handlers for approvals, schedules, plan projects,
 * benchmarks/tuning, provider stats, and system status.
 * These return { data, meta } envelopes via v2-control-plane helpers.
 */
const logger = require('../logger').child({ component: 'v2-governance-handlers' });

const crypto = require('crypto');
const taskCore = require('../db/task-core');
const configCore = require('../db/config-core');
const fileTracking = require('../db/file/tracking');
const hostManagement = require('../db/host/management');
const projectConfigCore = require('../db/project-config-core');
const providerRoutingCore = require('../db/provider/routing-core');
const schedulingAutomation = require('../db/scheduling-automation');
const validationRules = require('../db/validation-rules');
const webhooksStreaming = require('../db/webhooks-streaming');
const { VALID_CONFIG_KEYS } = require('../db/config-keys');
const { getProviderHealthStatus } = require('../utils/provider-health-status');
const {
  DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
  DEFAULT_PROPOSAL_MIN_SCORE,
  normalizeStudyThresholdLevel,
  readStudyArtifacts,
} = require('../integrations/codebase-study-engine');
const { getStudyImpactSummary } = require('../db/study-telemetry');
const { isSensitiveKey, redactValue, redactConfigObject } = require('../utils/sensitive-keys');
const {
  sendSuccess,
  sendError,
  sendList,
  resolveRequestId,
} = require('./v2-control-plane');
const { parseBody, sendJson } = require('./middleware');
const {
  isCoreError,
  listPoliciesCore,
  getPolicyCore,
  setPolicyModeCore,
  evaluatePoliciesCore,
  listPolicyEvaluationsCore,
  getPolicyEvaluationCore,
  overridePolicyDecisionCore,
} = require('../handlers/policy-handlers');

let _taskManager = null;
let _db = null;
const VALID_ACTIONS = new Set(['pause', 'resume', 'retry']);
const STUDY_TOOL_NAME = 'run_codebase_study';
const SECURITY_WARNING_MESSAGE = 'TORQUE is running without authentication. Run configure to set an API key.';

function nextIsoDate(date) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().split('T')[0];
}

function init(depsOrTaskManager = {}) {
  const isDepsObject = depsOrTaskManager
    && typeof depsOrTaskManager === 'object'
    && !Array.isArray(depsOrTaskManager);

  if (isDepsObject) {
    if (depsOrTaskManager.taskManager) {
      _taskManager = depsOrTaskManager.taskManager;
    }
    if (depsOrTaskManager.db) {
      _db = depsOrTaskManager.db;
    }
    return module.exports;
  }

  if (depsOrTaskManager) {
    _taskManager = depsOrTaskManager;
  }
  return module.exports;
}

function getDbService() {
  if (_db) {
    return _db;
  }
  throw new Error('v2 governance handlers require init({ db }) before running schedules');
}

function parseBooleanValue(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  return null;
}

function normalizeEnabledBoolean(value) {
  if (value === undefined) {
    return { value: undefined };
  }
  if (typeof value === 'boolean') {
    return { value };
  }
  if (typeof value === 'number' && Number.isInteger(value) && (value === 0 || value === 1)) {
    return { value: value === 1 };
  }

  return { error: 'enabled must be a boolean' };
}

function normalizeOptionalPositiveInteger(value) {
  if (value === undefined) {
    return { value: undefined };
  }
  if (value === null || value === '') {
    return { value: null };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { error: 'must be a positive integer' };
  }

  return { value: parsed };
}

function normalizeOptionalNonNegativeInteger(value) {
  if (value === undefined) {
    return { value: undefined };
  }
  if (value === null || value === '') {
    return { value: null };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { error: 'must be a non-negative integer' };
  }

  return { value: parsed };
}

function isCodebaseStudySchedule(schedule) {
  return schedule?.task_config?.tool_name === STUDY_TOOL_NAME;
}

function readStudySnapshot(workingDirectory, options = {}) {
  if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
    return null;
  }

  try {
    const artifacts = readStudyArtifacts(workingDirectory, {
      includeState: true,
      includeDelta: options.includeDelta === true,
      includeEvaluation: options.includeEvaluation === true,
      includeBenchmark: options.includeBenchmark === true,
    });
    return artifacts;
  } catch (error) {
    logger.warn({ err: error.message, workingDirectory }, 'Failed to load study artifacts for schedule enrichment');
    return null;
  }
}

function enrichScheduleWithStudyState(schedule, options = {}) {
  if (!isCodebaseStudySchedule(schedule)) {
    return schedule;
  }

  const workingDirectory = schedule?.task_config?.tool_args?.working_directory
    || schedule?.task_config?.working_directory
    || null;
  const snapshot = readStudySnapshot(workingDirectory, options);
  const state = snapshot?.state;
  if (!state) {
    return schedule;
  }

  const studyDelta = options.includeDelta === true
    ? snapshot?.studyDelta || null
    : null;
  const studyEvaluation = options.includeEvaluation === true
    ? snapshot?.studyEvaluation || null
    : null;
  const studyBenchmark = options.includeBenchmark === true
    ? snapshot?.studyBenchmark || null
    : null;
  const studyImpact = getStudyImpactSummary({
    workingDirectory,
    sinceDays: 30,
  });

  return {
    ...schedule,
    delta_significance_level: state.delta_significance_level || 'none',
    delta_significance_score: state.delta_significance_score || 0,
    proposal_count: state.proposal_count || 0,
    submitted_proposal_count: state.submitted_proposal_count || 0,
    last_delta_updated_at: state.last_delta_updated_at || null,
    pending_count: state.file_counts?.pending ?? state.pending_files?.length ?? 0,
    module_entry_count: state.module_entry_count || 0,
    last_result: state.last_result || null,
    evaluation_score: state.evaluation_score || 0,
    evaluation_grade: state.evaluation_grade || null,
    evaluation_readiness: state.evaluation_readiness || null,
    evaluation_findings_count: state.evaluation_findings_count || 0,
    evaluation_generated_at: state.evaluation_generated_at || null,
    benchmark_score: state.benchmark_score || 0,
    benchmark_grade: state.benchmark_grade || null,
    benchmark_readiness: state.benchmark_readiness || null,
    benchmark_findings_count: state.benchmark_findings_count || 0,
    benchmark_case_count: state.benchmark_case_count || 0,
    benchmark_generated_at: state.benchmark_generated_at || null,
    study_status: {
      working_directory: workingDirectory,
      delta_significance_level: state.delta_significance_level || 'none',
      delta_significance_score: state.delta_significance_score || 0,
      proposal_count: state.proposal_count || 0,
      submitted_proposal_count: state.submitted_proposal_count || 0,
      last_delta_updated_at: state.last_delta_updated_at || null,
      pending_count: state.file_counts?.pending ?? state.pending_files?.length ?? 0,
      module_entry_count: state.module_entry_count || 0,
      last_result: state.last_result || null,
      evaluation_score: state.evaluation_score || 0,
      evaluation_grade: state.evaluation_grade || null,
      evaluation_readiness: state.evaluation_readiness || null,
      evaluation_findings_count: state.evaluation_findings_count || 0,
      evaluation_generated_at: state.evaluation_generated_at || null,
      benchmark_score: state.benchmark_score || 0,
      benchmark_grade: state.benchmark_grade || null,
      benchmark_readiness: state.benchmark_readiness || null,
      benchmark_findings_count: state.benchmark_findings_count || 0,
      benchmark_case_count: state.benchmark_case_count || 0,
      benchmark_generated_at: state.benchmark_generated_at || null,
      delta: studyDelta,
      evaluation: studyEvaluation,
      benchmark: studyBenchmark,
      impact: studyImpact,
    },
    study_delta: studyDelta,
    study_evaluation: studyEvaluation,
    study_benchmark: studyBenchmark,
    study_impact: studyImpact,
  };
}

function enrichSchedulesWithStudyState(items) {
  return items.map(enrichScheduleWithStudyState);
}

function parseTaskMetadata(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'object') {
    return value;
  }
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeApprovalRecord(record, source = 'approval-workflow') {
  if (!record || typeof record !== 'object') {
    return record;
  }

  const metadata = parseTaskMetadata(record.task_metadata);
  const studyProposal = metadata.study_proposal && typeof metadata.study_proposal === 'object'
    ? metadata.study_proposal
    : null;
  const studyTrace = studyProposal?.trace && typeof studyProposal.trace === 'object'
    ? studyProposal.trace
    : null;

  return {
    ...record,
    source,
    approval_type: studyProposal ? 'study_proposal' : 'task_execution',
    kind: studyProposal?.kind || null,
    description: studyProposal?.title || record.task_description || record.description || '-',
    rationale: studyProposal?.rationale || null,
    files: Array.isArray(studyProposal?.files) ? studyProposal.files : [],
    related_tests: Array.isArray(studyProposal?.related_tests) ? studyProposal.related_tests : [],
    validation_commands: Array.isArray(studyProposal?.validation_commands) ? studyProposal.validation_commands : [],
    affected_invariants: Array.isArray(studyProposal?.affected_invariants) ? studyProposal.affected_invariants : [],
    created_at: record.requested_at || record.created_at || null,
    rule: record.rule_name || record.rule || null,
    decision: record.status === 'approved' || record.status === 'rejected'
      ? record.status
      : record.decision || null,
    decided_at: record.approved_at || record.decided_at || record.updated_at || null,
    decided_by: record.approved_by || record.decided_by || null,
    study_proposal: studyProposal,
    study_trace: studyTrace,
  };
}

function normalizeApprovalRecords(items, source) {
  return (Array.isArray(items) ? items : []).map((item) => normalizeApprovalRecord(item, source));
}

function sendPolicyCoreResult(req, res, result, options = {}) {
  const requestId = resolveRequestId(req);

  if (isCoreError(result)) {
    return sendError(
      res,
      requestId,
      result.error.code,
      result.error.message,
      result.error.status || 400,
      result.error.details || {},
      req,
    );
  }

  const data = typeof options.selectData === 'function'
    ? options.selectData(result)
    : result;
  return sendSuccess(res, requestId, data, options.status || 200, req);
}

// ─── Approvals ──────────────────────────────────────────────────────────────

async function handleListApprovals(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const status = typeof query.status === 'string' ? query.status.trim().toLowerCase() : '';

  if (status === 'history' || status === 'all') {
    const history = schedulingAutomation.listApprovalHistory
      ? schedulingAutomation.listApprovalHistory({ limit })
      : (schedulingAutomation.getApprovalHistory ? schedulingAutomation.getApprovalHistory(limit) : []);
    const historyItems = normalizeApprovalRecords(history, 'approval-workflow');
    return sendList(res, requestId, historyItems, historyItems.length, req);
  }

  const pending = schedulingAutomation.listPendingApprovals ? schedulingAutomation.listPendingApprovals() : [];
  const items = normalizeApprovalRecords(pending, 'approval-workflow');
  if (query.include_history === 'true') {
    const history = schedulingAutomation.listApprovalHistory
      ? schedulingAutomation.listApprovalHistory({ limit })
      : (schedulingAutomation.getApprovalHistory ? schedulingAutomation.getApprovalHistory(limit) : []);
    return sendSuccess(res, requestId, {
      pending: items,
      history: normalizeApprovalRecords(history, 'approval-workflow'),
    }, 200, req);
  }

  sendList(res, requestId, items, items.length, req);
}

async function handleApprovalDecision(req, res) {
  const requestId = resolveRequestId(req);
  const approvalId = req.params?.approval_id;

  if (!approvalId) {
    return sendError(res, requestId, 'validation_error', 'approval_id is required', 400, undefined, req);
  }

  const body = req.body || await parseBody(req);
  const decision = (typeof body.decision === 'string' ? body.decision : '').trim().toLowerCase();

  if (!decision || !['approved', 'rejected'].includes(decision)) {
    return sendError(res, requestId, 'validation_error', 'decision must be "approved" or "rejected"', 400, undefined, req);
  }

  if (!validationRules.decideApproval && !schedulingAutomation.getApprovalRequestById) {
    return sendError(res, requestId, 'not_implemented', 'Approval system not available', 501, {}, req);
  }

  const decidedBy = String(body.decided_by || 'v2-api').slice(0, 100).replace(/[^a-zA-Z0-9_\-@. ]/g, '');

  let result = null;
  const workflowRequest = schedulingAutomation.getApprovalRequestById
    ? schedulingAutomation.getApprovalRequestById(approvalId)
    : null;
  const normalizedWorkflowRequest = workflowRequest
    ? normalizeApprovalRecord(workflowRequest, 'approval-workflow')
    : null;

  if (workflowRequest?.task_id) {
    result = decision === 'approved'
      ? schedulingAutomation.approveTask?.(workflowRequest.task_id, decidedBy, body.comment || null)
      : schedulingAutomation.rejectApproval?.(workflowRequest.task_id, decidedBy, body.comment || null);
  } else if (validationRules.decideApproval) {
    result = validationRules.decideApproval(approvalId, decision, decidedBy, body.comment || null);
  }

  if (!result) {
    return sendError(res, requestId, 'approval_not_found', `Approval not found: ${approvalId}`, 404, {}, req);
  }

  sendSuccess(res, requestId, {
    approval_id: approvalId,
    decision,
    decided_by: decidedBy,
    approval_type: normalizedWorkflowRequest?.approval_type || (workflowRequest?.task_id ? 'task_execution' : 'legacy'),
    task_id: workflowRequest?.task_id || null,
  }, 200, req);
}

// ─── Schedules ──────────────────────────────────────────────────────────────

async function handleListSchedules(req, res) {
  const requestId = resolveRequestId(req);
  const schedules = schedulingAutomation.listScheduledTasks ? schedulingAutomation.listScheduledTasks() : [];
  const items = Array.isArray(schedules) ? enrichSchedulesWithStudyState(schedules) : [];
  sendList(res, requestId, items, items.length, req);
}

async function handleCreateSchedule(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  const name = (body.name || '').trim();
  if (!name) {
    return sendError(res, requestId, 'validation_error', 'name is required', 400, undefined, req);
  }
  const workflowId = body.workflow_id || null;
  const workflowSourceId = body.workflow_source_id || null;
  const taskLabel = body.task_description || (workflowId || workflowSourceId ? name : null);
  if (workflowId && workflowSourceId) {
    return sendError(res, requestId, 'validation_error', 'workflow_id and workflow_source_id are mutually exclusive', 400, undefined, req);
  }

  const scheduleType = body.schedule_type || 'cron';

  try {
    let schedule;

    if (scheduleType === 'once') {
      if (!body.run_at && !body.delay) {
        return sendError(res, requestId, 'validation_error', 'run_at or delay is required for one-time schedules', 400, undefined, req);
      }
      if (!body.task_description && !workflowId && !workflowSourceId) {
        return sendError(res, requestId, 'validation_error', 'task_description, workflow_id, or workflow_source_id is required', 400, undefined, req);
      }

      schedule = schedulingAutomation.createOneTimeSchedule({
        name,
        run_at: body.run_at || undefined,
        delay: body.delay || undefined,
        task_config: {
          task: taskLabel,
          workflow_id: workflowId,
          workflow_source_id: workflowSourceId,
          provider: body.provider || null,
          model: body.model || null,
          working_directory: body.working_directory || null,
          project: body.project || null,
        },
        timezone: body.timezone || null,
      });
    } else {
      if (!body.cron_expression) {
        return sendError(res, requestId, 'validation_error', 'cron_expression is required', 400, undefined, req);
      }
      if (!body.task_description && !workflowId && !workflowSourceId) {
        return sendError(res, requestId, 'validation_error', 'task_description, workflow_id, or workflow_source_id is required', 400, undefined, req);
      }

      schedule = schedulingAutomation.createCronScheduledTask({
        name,
        cron_expression: body.cron_expression,
        task_config: {
          task: taskLabel,
          workflow_id: workflowId,
          workflow_source_id: workflowSourceId,
          provider: body.provider || null,
          model: body.model || null,
          working_directory: body.working_directory || null,
          project: body.project || null,
        },
        timezone: body.timezone || null,
      });
    }

    sendSuccess(res, requestId, schedule, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleGetSchedule(req, res) {
  const requestId = resolveRequestId(req);
  const scheduleId = req.params?.schedule_id;

  const schedule = schedulingAutomation.getScheduledTask
    ? schedulingAutomation.getScheduledTask(scheduleId, { include_runs: true, run_limit: 15 })
    : (schedulingAutomation.listScheduledTasks ? (schedulingAutomation.listScheduledTasks() || []).find(s => String(s.id) === String(scheduleId)) : null);
  if (!schedule) {
    return sendError(res, requestId, 'schedule_not_found', `Schedule not found: ${scheduleId}`, 404, {}, req);
  }

  sendSuccess(res, requestId, enrichScheduleWithStudyState(schedule, { includeDelta: true, includeEvaluation: true, includeBenchmark: true }), 200, req);
}

async function handleGetScheduleRun(req, res) {
  const requestId = resolveRequestId(req);
  const scheduleId = req.params?.schedule_id;
  const runId = req.params?.run_id;

  if (!scheduleId || !runId) {
    return sendError(res, requestId, 'validation_error', 'schedule_id and run_id are required', 400, {}, req);
  }

  const schedule = schedulingAutomation.getScheduledTask
    ? schedulingAutomation.getScheduledTask(scheduleId, { include_runs: false, hydrateRuns: false })
    : null;
  if (!schedule) {
    return sendError(res, requestId, 'schedule_not_found', `Schedule not found: ${scheduleId}`, 404, {}, req);
  }

  const run = schedulingAutomation.getScheduledTaskRun
    ? schedulingAutomation.getScheduledTaskRun(runId)
    : null;
  if (!run || String(run.schedule_id) !== String(scheduleId)) {
    return sendError(res, requestId, 'schedule_run_not_found', `Schedule run not found: ${runId}`, 404, {}, req);
  }

  sendSuccess(res, requestId, run, 200, req);
}

async function handleRunSchedule(req, res) {
  const requestId = resolveRequestId(req);
  const scheduleId = req.params?.schedule_id;

  try {
    const result = schedulingAutomation.runScheduledTaskNow
      ? schedulingAutomation.runScheduledTaskNow(scheduleId, { db: getDbService() })
      : null;
    if (!result) {
      return sendError(res, requestId, 'schedule_not_found', `Schedule not found: ${scheduleId}`, 404, {}, req);
    }
    sendSuccess(res, requestId, result, 202, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleToggleSchedule(req, res) {
  const requestId = resolveRequestId(req);
  const scheduleId = req.params?.schedule_id;
  const body = req.body || await parseBody(req);

  const enabled = body.enabled !== undefined ? body.enabled : true;

  try {
    const result = schedulingAutomation.toggleScheduledTask(scheduleId, enabled);
    if (!result) {
      return sendError(res, requestId, 'schedule_not_found', `Schedule not found: ${scheduleId}`, 404, {}, req);
    }
    sendSuccess(res, requestId, result, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDeleteSchedule(req, res) {
  const requestId = resolveRequestId(req);
  const scheduleId = req.params?.schedule_id;

  try {
    const result = schedulingAutomation.deleteScheduledTask(scheduleId);
    if (!result) {
      return sendError(res, requestId, 'schedule_not_found', `Schedule not found: ${scheduleId}`, 404, {}, req);
    }
    sendSuccess(res, requestId, { deleted: true, schedule_id: scheduleId }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleUpdateSchedule(req, res) {
  const requestId = resolveRequestId(req);
  const scheduleId = req.params?.schedule_id;
  const body = req.body || await parseBody(req);

  try {
    const existing = schedulingAutomation.getScheduledTask(scheduleId);
    if (!existing) {
      return sendError(res, requestId, 'schedule_not_found', `Schedule not found: ${scheduleId}`, 404, {}, req);
    }

    const updates = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.timezone !== undefined) updates.timezone = body.timezone;
    if (body.task_description !== undefined) updates.task_description = body.task_description;

    // Cron-specific
    if (body.cron_expression !== undefined) updates.cron_expression = body.cron_expression;

    // One-time-specific
    if (body.run_at !== undefined) updates.run_at = body.run_at;

    // Partial task_config merge for provider/model/working_directory
    const configUpdates = {};
    if (body.provider !== undefined) configUpdates.provider = body.provider || null;
    if (body.model !== undefined) configUpdates.model = body.model || null;
    if (body.working_directory !== undefined) configUpdates.working_directory = body.working_directory || null;
    if (body.project !== undefined) configUpdates.project = body.project || null;
    if (body.task !== undefined) configUpdates.task = body.task;
    if (body.workflow_id !== undefined) configUpdates.workflow_id = body.workflow_id || null;
    if (body.workflow_source_id !== undefined) configUpdates.workflow_source_id = body.workflow_source_id || null;
    if (body.workflow_id !== undefined && body.workflow_source_id !== undefined && body.workflow_id && body.workflow_source_id) {
      return sendError(res, requestId, 'validation_error', 'workflow_id and workflow_source_id are mutually exclusive', 400, undefined, req);
    }
    const toolArgsUpdates = {};
    if (body.submit_proposals !== undefined) {
      const parsed = parseBooleanValue(body.submit_proposals);
      if (parsed === null) {
        return sendError(res, requestId, 'validation_error', 'submit_proposals must be "true" or "false"', 400, {
          field: 'submit_proposals',
        }, req);
      }
      toolArgsUpdates.submit_proposals = parsed === undefined ? false : parsed;
    }
    if (body.proposal_limit !== undefined) {
      const normalized = normalizeOptionalPositiveInteger(body.proposal_limit);
      if (normalized.error) {
        return sendError(res, requestId, 'validation_error', `proposal_limit ${normalized.error}`, 400, {
          field: 'proposal_limit',
        }, req);
      }
      toolArgsUpdates.proposal_limit = normalized.value;
    }
    if (body.proposal_significance_level !== undefined) {
      if (body.proposal_significance_level === null || body.proposal_significance_level === '') {
        toolArgsUpdates.proposal_significance_level = DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL;
      } else {
        const normalized = normalizeStudyThresholdLevel(body.proposal_significance_level, null);
        if (!normalized) {
          return sendError(res, requestId, 'validation_error', 'proposal_significance_level must be one of: none, baseline, low, moderate, high, critical', 400, {
            field: 'proposal_significance_level',
          }, req);
        }
        toolArgsUpdates.proposal_significance_level = normalized;
      }
    }
    if (body.proposal_min_score !== undefined) {
      const normalized = normalizeOptionalNonNegativeInteger(body.proposal_min_score);
      if (normalized.error) {
        return sendError(res, requestId, 'validation_error', `proposal_min_score ${normalized.error}`, 400, {
          field: 'proposal_min_score',
        }, req);
      }
      toolArgsUpdates.proposal_min_score = normalized.value === null
        ? DEFAULT_PROPOSAL_MIN_SCORE
        : normalized.value;
    }
    if (Object.keys(toolArgsUpdates).length > 0) {
      configUpdates.tool_args = {
        ...(existing?.task_config?.tool_args || {}),
        ...toolArgsUpdates,
      };
    }
    if (Object.keys(configUpdates).length > 0) {
      updates.task_config = configUpdates;
    }

    if (body.enabled !== undefined) updates.enabled = body.enabled;

    const result = schedulingAutomation.updateScheduledTask(scheduleId, updates);
    if (!result) {
      return sendError(res, requestId, 'operation_failed', 'No fields to update', 400, {}, req);
    }

    sendSuccess(res, requestId, enrichScheduleWithStudyState(result, { includeDelta: true, includeEvaluation: true }), 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Policies ───────────────────────────────────────────────────────────────

async function handleListPolicies(req, res) {
  const query = req.query || {};
  const enabledOnly = parseBooleanValue(query.enabled_only);
  if (enabledOnly === null) {
    const requestId = resolveRequestId(req);
    return sendError(res, requestId, 'validation_error', 'enabled_only must be "true" or "false"', 400, {
      field: 'enabled_only',
    }, req);
  }

  const result = listPoliciesCore({
    project_id: query.project_id,
    profile_id: query.profile_id,
    category: query.category,
    stage: query.stage,
    mode: query.mode,
    enabled_only: enabledOnly,
  });

  return sendPolicyCoreResult(req, res, result, {
    selectData: (value) => value.policies,
  });
}

async function handleGetPolicy(req, res) {
  const result = getPolicyCore({
    policy_id: req.params?.policy_id,
  });

  return sendPolicyCoreResult(req, res, result, {
    selectData: (value) => value.policy,
  });
}

async function handleSetPolicyMode(req, res) {
  const body = req.body || await parseBody(req);
  const result = setPolicyModeCore({
    ...body,
    policy_id: req.params?.policy_id,
  });

  return sendPolicyCoreResult(req, res, result);
}

async function handleEvaluatePolicies(req, res) {
  const body = req.body || await parseBody(req);
  const result = evaluatePoliciesCore(body || {});
  return sendPolicyCoreResult(req, res, result);
}

async function handleListPolicyEvaluations(req, res) {
  const query = req.query || {};
  const suppressed = parseBooleanValue(query.suppressed);
  if (suppressed === null) {
    const requestId = resolveRequestId(req);
    return sendError(res, requestId, 'validation_error', 'suppressed must be "true" or "false"', 400, {
      field: 'suppressed',
    }, req);
  }

  const includeOverrides = parseBooleanValue(query.include_overrides);
  if (includeOverrides === null) {
    const requestId = resolveRequestId(req);
    return sendError(res, requestId, 'validation_error', 'include_overrides must be "true" or "false"', 400, {
      field: 'include_overrides',
    }, req);
  }

  const result = listPolicyEvaluationsCore({
    project_id: query.project_id,
    policy_id: query.policy_id,
    profile_id: query.profile_id,
    stage: query.stage,
    outcome: query.outcome,
    suppressed,
    target_type: query.target_type,
    target_id: query.target_id,
    scope_fingerprint: query.scope_fingerprint,
    include_overrides: includeOverrides,
    limit: query.limit,
    offset: query.offset,
  });

  return sendPolicyCoreResult(req, res, result, {
    selectData: (value) => value.evaluations,
  });
}

async function handleGetPolicyEvaluation(req, res) {
  const includeOverrides = parseBooleanValue(req.query?.include_overrides);
  if (includeOverrides === null) {
    const requestId = resolveRequestId(req);
    return sendError(res, requestId, 'validation_error', 'include_overrides must be "true" or "false"', 400, {
      field: 'include_overrides',
    }, req);
  }

  const result = getPolicyEvaluationCore({
    evaluation_id: req.params?.evaluation_id,
    include_overrides: includeOverrides,
  });

  return sendPolicyCoreResult(req, res, result, {
    selectData: (value) => value.evaluation,
  });
}

async function handleOverridePolicyDecision(req, res) {
  const body = req.body || await parseBody(req);
  const result = overridePolicyDecisionCore({
    ...body,
    evaluation_id: req.params?.evaluation_id,
  });

  return sendPolicyCoreResult(req, res, result, {
    status: 201,
  });
}

async function handlePeekAttestationExport(req, res) {
  const requestId = resolveRequestId(req);
  const reportId = req.params?.id;

  if (!reportId) {
    return sendError(res, requestId, 'validation_error', 'id is required', 400, {}, req);
  }

  try {
    const { exportAttestation } = require('../plugins/snapscope/handlers/compliance');
    const attestation = exportAttestation(reportId, req.query || {});
    sendJson(res, attestation, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Plan Projects ──────────────────────────────────────────────────────────

async function handleListPlanProjects(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);

  try {
    const projects = projectConfigCore.listPlanProjects
      ? projectConfigCore.listPlanProjects({ status: query.status, limit })
      : [];

    const items = (Array.isArray(projects) ? projects : []).map(p => ({
      ...p,
      progress: p.total_tasks > 0
        ? Math.round((p.completed_tasks / p.total_tasks) * 100)
        : 0,
    }));

    sendList(res, requestId, items, items.length, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleGetPlanProject(req, res) {
  const requestId = resolveRequestId(req);
  const projectId = req.params?.project_id;

  const project = projectConfigCore.getPlanProject ? projectConfigCore.getPlanProject(projectId) : null;
  if (!project) {
    return sendError(res, requestId, 'project_not_found', `Plan project not found: ${projectId}`, 404, {}, req);
  }

  const tasks = projectConfigCore.getPlanProjectTasks ? projectConfigCore.getPlanProjectTasks(projectId) : [];

  sendSuccess(res, requestId, {
    ...project,
    progress: project.total_tasks > 0
      ? Math.round((project.completed_tasks / project.total_tasks) * 100)
      : 0,
    tasks: Array.isArray(tasks) ? tasks : [],
  }, 200, req);
}

async function handlePlanProjectAction(req, res) {
  const requestId = resolveRequestId(req);
  const projectId = req.params?.project_id;
  const action = req.params?.action;

  if (!action || !VALID_ACTIONS.has(action)) {
    return sendError(res, requestId, 'validation_error', `Invalid action: ${action}. Must be one of: pause, resume, retry`, 400, undefined, req);
  }

  const project = projectConfigCore.getPlanProject ? projectConfigCore.getPlanProject(projectId) : null;
  if (!project) {
    return sendError(res, requestId, 'project_not_found', `Plan project not found: ${projectId}`, 404, {}, req);
  }

  try {
    const { handleToolCall } = require('../tools');
    const toolName = `${action}_plan_project`;
    const result = await handleToolCall(toolName, { project_id: projectId });

    sendSuccess(res, requestId, {
      project_id: projectId,
      action,
      result: result || { success: true },
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDeletePlanProject(req, res) {
  const requestId = resolveRequestId(req);
  const projectId = req.params?.project_id;

  const project = projectConfigCore.getPlanProject ? projectConfigCore.getPlanProject(projectId) : null;
  if (!project) {
    return sendError(res, requestId, 'project_not_found', `Plan project not found: ${projectId}`, 404, {}, req);
  }

  try {
    // Cancel running tasks
    if (_taskManager) {
      const tasks = projectConfigCore.getPlanProjectTasks ? projectConfigCore.getPlanProjectTasks(projectId) : [];
      for (const task of tasks) {
        if (['queued', 'running', 'waiting'].includes(task.status)) {
          try {
            _taskManager.cancelTask(task.task_id, 'Plan project deleted via v2 API');
          } catch (err) {
            logger.debug("task handler error", { err: err.message });
            taskCore.updateTaskStatus(task.task_id, 'cancelled', {
              error_output: 'Plan project deleted',
              cancel_reason: 'user',
            });
          }
        }
      }
    }

    if (projectConfigCore.deletePlanProject) {
      projectConfigCore.deletePlanProject(projectId);
    }

    sendSuccess(res, requestId, {
      deleted: true,
      project_id: projectId,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleImportPlan(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  if (!body.plan_content) {
    return sendError(res, requestId, 'validation_error', 'plan_content is required', 400, undefined, req);
  }

  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const tempFile = path.join(os.tmpdir(), `plan-${crypto.randomUUID()}.md`);
    await fs.promises.writeFile(tempFile, body.plan_content);

    try {
      const { handleToolCall } = require('../tools');
      const result = await handleToolCall('import_plan', {
        file_path: tempFile,
        project_name: body.project_name,
        dry_run: body.dry_run !== false,
        working_directory: body.working_directory,
      });

      if (!result || typeof result !== 'object') {
        return sendError(res, requestId, 'operation_failed', 'Invalid import tool response', 500, {}, req);
      }
      if (result.error) {
        return sendError(res, requestId, 'operation_failed', result.error, 400, {}, req);
      }

      sendSuccess(res, requestId, result, 200, req);
    } finally {
      try { await fs.promises.unlink(tempFile); } catch (err) { logger.debug("task handler error", { err: err.message }); /* cleanup */ }
    }
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Benchmarks & Tuning ────────────────────────────────────────────────────

async function handleListBenchmarks(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const hostId = query.host_id || query.hostId;

  if (!hostId) {
    return sendError(res, requestId, 'validation_error', 'host_id is required', 400, undefined, req);
  }

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 1000);

  try {
    const results = hostManagement.getBenchmarkResults ? hostManagement.getBenchmarkResults(hostId, limit) : [];
    const stats = hostManagement.getBenchmarkStats ? hostManagement.getBenchmarkStats(hostId) : {};

    sendSuccess(res, requestId, {
      host_id: hostId,
      results: Array.isArray(results) ? results : [],
      stats: stats || {},
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleApplyBenchmark(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  const hostId = body.host_id || body.hostId;
  if (!hostId) {
    return sendError(res, requestId, 'validation_error', 'host_id is required', 400, undefined, req);
  }

  try {
    const result = hostManagement.applyBenchmarkResults
      ? hostManagement.applyBenchmarkResults(hostId, body.model)
      : {};
    sendSuccess(res, requestId, result || {}, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleListProjectTuning(req, res) {
  const requestId = resolveRequestId(req);

  try {
    const tunings = hostManagement.listProjectTuning ? hostManagement.listProjectTuning() : [];
    const items = Array.isArray(tunings) ? tunings : [];
    sendList(res, requestId, items, items.length, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleCreateProjectTuning(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  const projectPath = (body.project_path || body.projectPath || '').trim();
  if (!projectPath) {
    return sendError(res, requestId, 'validation_error', 'project_path is required', 400, undefined, req);
  }
  if (!body.settings || typeof body.settings !== 'object') {
    return sendError(res, requestId, 'validation_error', 'settings object is required', 400, undefined, req);
  }

  try {
    hostManagement.setProjectTuning(projectPath, body.settings, body.description);
    sendSuccess(res, requestId, {
      project_path: projectPath,
      saved: true,
    }, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDeleteProjectTuning(req, res) {
  const requestId = resolveRequestId(req);
  const projectPath = req.params?.project_path;

  if (!projectPath) {
    return sendError(res, requestId, 'validation_error', 'project_path is required', 400, undefined, req);
  }

  try {
    const decoded = decodeURIComponent(projectPath);
    hostManagement.deleteProjectTuning(decoded);
    sendSuccess(res, requestId, { deleted: true, project_path: decoded }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Provider Stats ─────────────────────────────────────────────────────────

function getProviderTimeSeries(providerId, days) {
  const series = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = nextDate.toISOString().split('T')[0];

    const baseFilters = {
      provider: providerId,
      from_date: dateStr,
      to_date: nextDateStr,
    };

    const total = taskCore.countTasks ? taskCore.countTasks(baseFilters) : 0;
    const completed = taskCore.countTasks ? taskCore.countTasks({ ...baseFilters, status: 'completed' }) : 0;
    const failed = taskCore.countTasks ? taskCore.countTasks({ ...baseFilters, status: 'failed' }) : 0;

    series.push({ date: dateStr, total, completed, failed });
  }

  return series;
}

async function handleListProviders(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const providers = providerRoutingCore.listProviders ? providerRoutingCore.listProviders() : [];
    // Enrich each provider with aggregated stats
    const enriched = providers.map(p => {
      const rawStats = fileTracking.getProviderStats ? fileTracking.getProviderStats(p.provider) : [];
      const statsList = Array.isArray(rawStats) ? rawStats : [];
      // Aggregate per-task-type stats into totals
      const total_tasks = statsList.reduce((s, r) => s + (r.total_tasks ?? 0), 0);
      const completed_tasks = statsList.reduce((s, r) => s + (r.successful_tasks || 0), 0);
      const failed_tasks = statsList.reduce((s, r) => s + (r.failed_tasks || 0), 0);
      const durations = statsList.filter(r => r.avg_duration_seconds > 0);
      const avg_duration_seconds = durations.length > 0
        ? durations.reduce((s, r) => s + r.avg_duration_seconds, 0) / durations.length
        : null;
      const success_rate = total_tasks > 0 ? Math.round(completed_tasks / total_tasks * 100) : 0;
      const total_cost = statsList.reduce((s, r) => s + (r.total_cost ?? 0), 0);
      // API key status enrichment
      let api_key_status = 'not_set';
      let api_key_masked = null;
      try {
        const { getApiKeyStatus, decryptApiKey } = require('../handlers/provider-crud-handlers');
        const { redactValue } = require('../utils/sensitive-keys');
        const serverConfig = require('../config');

        api_key_status = getApiKeyStatus(p.provider);
        if (api_key_status === 'env') {
          const envKey = serverConfig.getApiKey(p.provider);
          if (envKey) api_key_masked = redactValue(envKey);
        } else if (api_key_status === 'stored' || api_key_status === 'validating') {
          if (p.api_key_encrypted) {
            const decrypted = decryptApiKey(p.api_key_encrypted);
            if (decrypted) api_key_masked = redactValue(decrypted);
          }
        }
      } catch { /* key enrichment is best-effort */ }

      const runtimeHealth = providerRoutingCore.getProviderHealth
        ? providerRoutingCore.getProviderHealth(p.provider)
        : { successes: 0, failures: 0, failureRate: 0 };
      const { status } = getProviderHealthStatus(p, runtimeHealth);

      return {
        ...p,
        status,
        stats: { total_tasks, completed_tasks, failed_tasks, success_rate, avg_duration_seconds, total_cost },
        api_key_status,
        api_key_masked,
      };
    });
    sendSuccess(res, requestId, { items: enriched, total: enriched.length }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleProviderStats(req, res) {
  const requestId = resolveRequestId(req);
  const providerId = req.params?.provider_id;
  const query = req.query || {};
  const days = Math.min(Math.max(parseInt(query.days, 10) || 7, 1), 90);

  try {
    const stats = fileTracking.getProviderStats ? fileTracking.getProviderStats(providerId, days) : {};
    const timeSeries = getProviderTimeSeries(providerId, days);

    sendSuccess(res, requestId, {
      provider: providerId,
      days,
      ...stats,
      time_series: timeSeries,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleProviderToggle(req, res) {
  const requestId = resolveRequestId(req);
  const providerId = req.params?.provider_id;
  const body = req.body || await parseBody(req);
  const normalizedEnabled = normalizeEnabledBoolean(body.enabled);

  const provider = providerRoutingCore.getProvider ? providerRoutingCore.getProvider(providerId) : null;
  if (!provider) {
    return sendError(res, requestId, 'provider_not_found', `Provider not found: ${providerId}`, 404, {}, req);
  }

  if (normalizedEnabled.error) {
    return sendError(res, requestId, 'validation_error', normalizedEnabled.error, 400, {
      field: 'enabled',
    }, req);
  }

  const enabled = normalizedEnabled.value !== undefined
    ? normalizedEnabled.value
    : !provider.enabled;

  try {
    providerRoutingCore.updateProvider(providerId, { enabled: enabled ? 1 : 0 });
    sendSuccess(res, requestId, {
      provider: providerId,
      enabled,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleProviderTrends(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const days = Math.min(Math.max(parseInt(query.days, 10) || 7, 1), 90);

  try {
    const providers = providerRoutingCore.listProviders ? providerRoutingCore.listProviders() : [];
    const providerNames = providers.map(p => p.provider);

    const dates = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    // One bulk GROUP BY instead of providers × days × 3 separate countTasks
    // queries (was 273+ point lookups per request). Date range mirrors the
    // window built above; upper bound is exclusive so today's tasks count.
    const fromDate = dates[0];
    const toDateObj = new Date(now);
    toDateObj.setDate(toDateObj.getDate() + 1);
    const toDate = toDateObj.toISOString().split('T')[0];

    const counts = (taskCore.getProviderDailyCounts
      ? taskCore.getProviderDailyCounts(fromDate, toDate)
      : providerNames.flatMap(provider => dates.map((date) => {
        const nextDate = nextIsoDate(date);
        const countFilters = { provider, from_date: date, to_date: nextDate };
        return {
          provider,
          date,
          total: taskCore.countTasks ? taskCore.countTasks(countFilters) : 0,
          completed: taskCore.countTasks ? taskCore.countTasks({ ...countFilters, status: 'completed' }) : 0,
          failed: taskCore.countTasks ? taskCore.countTasks({ ...countFilters, status: 'failed' }) : 0,
        };
      }))) || [];

    // Index rows by provider→date for O(1) lookup while building the series.
    const byProviderDate = new Map();
    for (const row of counts) {
      if (!row || !row.provider || !row.date) continue;
      let providerMap = byProviderDate.get(row.provider);
      if (!providerMap) {
        providerMap = new Map();
        byProviderDate.set(row.provider, providerMap);
      }
      let dayBucket = providerMap.get(row.date);
      if (!dayBucket) {
        dayBucket = { total: 0, completed: 0, failed: 0 };
        providerMap.set(row.date, dayBucket);
      }
      if (Number.isFinite(Number(row.total))) {
        dayBucket.total += Number(row.total) || 0;
        dayBucket.completed += Number(row.completed) || 0;
        dayBucket.failed += Number(row.failed) || 0;
        continue;
      }

      const n = Number(row.count) || 0;
      dayBucket.total += n;
      if (row.status === 'completed') dayBucket.completed += n;
      else if (row.status === 'failed') dayBucket.failed += n;
    }

    const series = dates.map((date) => {
      const entry = { date };
      for (const p of providers) {
        const dayData = byProviderDate.get(p.provider)?.get(date) || { total: 0, completed: 0, failed: 0 };
        const totalCompletedFailed = dayData.completed + dayData.failed;
        entry[`${p.provider}_total`] = dayData.total;
        entry[`${p.provider}_completed`] = dayData.completed;
        entry[`${p.provider}_failed`] = dayData.failed;
        entry[`${p.provider}_success_rate`] = totalCompletedFailed > 0
          ? Math.round((dayData.completed / totalCompletedFailed) * 100)
          : null;
      }
      return entry;
    });

    sendSuccess(res, requestId, { providers: providerNames, days, series }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── System Status ──────────────────────────────────────────────────────────

async function handleSystemStatus(req, res) {
  const requestId = resolveRequestId(req);

  const memUsage = process.memoryUsage();
  const uptime = process.uptime();

  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
  const heapPercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);
  const memoryStatus = heapPercent >= 90 ? 'critical' :
                       heapPercent >= 80 ? 'warning' :
                       heapPercent >= 70 ? 'elevated' : 'healthy';

  const runningTasks = taskCore.countTasks ? taskCore.countTasks({ status: 'running' }) : 0;
  const queuedTasks = taskCore.countTasks ? taskCore.countTasks({ status: 'queued' }) : 0;

  let instanceId = null;
  if (_taskManager && _taskManager.getMcpInstanceId) {
    instanceId = _taskManager.getMcpInstanceId();
  }
  let authConfigured = false;
  try {
    authConfigured = Boolean(configCore.getConfig('api_key'));
  } catch (err) { logger.debug("task handler error", { err: err.message }); /* ignore — best effort */ }

  // TDA-14: Surface resource gating state so callers see pressure and gating status
  let resourceGating = { enabled: false, pressure_level: 'unknown' };
  try {
    const gatingEnabled = configCore.getConfig ? configCore.getConfig('resource_gating_enabled') === '1' : false;
    let pressureLevel = 'unknown';
    if (_taskManager && typeof _taskManager.getResourcePressureInfo === 'function') {
      const info = _taskManager.getResourcePressureInfo();
      if (info && typeof info.level === 'string') pressureLevel = info.level;
    }
    resourceGating = {
      enabled: gatingEnabled,
      pressure_level: pressureLevel,
      tasks_deferred: gatingEnabled && (pressureLevel === 'high' || pressureLevel === 'critical'),
    };
  } catch (err) { logger.debug("task handler error", { err: err.message }); /* ignore — best effort */ }

  sendSuccess(res, requestId, {
    instance: instanceId ? {
      id: instanceId,
      short_id: instanceId.slice(-6),
      pid: process.pid,
    } : { pid: process.pid },
    memory: {
      heap_used_mb: heapUsedMB,
      heap_total_mb: heapTotalMB,
      heap_percent: heapPercent,
      rss_mb: Math.round(memUsage.rss / 1024 / 1024),
      status: memoryStatus,
    },
    security: {
      auth_configured: authConfigured,
      warning: authConfigured ? null : SECURITY_WARNING_MESSAGE,
    },
    security_warning: authConfigured ? null : SECURITY_WARNING_MESSAGE,
    resource_gating: resourceGating,
    uptime_seconds: Math.round(uptime),
    tasks: { running: runningTasks, queued: queuedTasks },
    node_version: process.version,
    platform: process.platform,
  }, 200, req);
}

// ─── Provider Configuration ──────────────────────────────────────────────────

async function handleConfigureProvider(req, res) {
  const requestId = resolveRequestId(req);
  const providerId = req.params?.provider_id;
  const body = req.body || await parseBody(req);
  const normalizedEnabled = normalizeEnabledBoolean(body.enabled);

  if (!providerId) {
    return sendError(res, requestId, 'validation_error', 'provider_id is required', 400, {}, req);
  }

  const provider = providerRoutingCore.getProvider(providerId);
  if (!provider) {
    return sendError(res, requestId, 'provider_not_found', `Provider not found: ${providerId}`, 404, {}, req);
  }

  if (normalizedEnabled.error) {
    return sendError(res, requestId, 'validation_error', normalizedEnabled.error, 400, {
      field: 'enabled',
    }, req);
  }

  try {
    const updates = {};
    if (normalizedEnabled.value !== undefined) updates.enabled = normalizedEnabled.value ? 1 : 0;
    if (body.model) updates.default_model = body.model;
    if (body.max_concurrent !== undefined) updates.max_concurrent = body.max_concurrent;
    if (body.timeout_minutes !== undefined) updates.timeout_minutes = body.timeout_minutes;

    providerRoutingCore.updateProvider(providerId, updates);
    const updated = providerRoutingCore.getProvider(providerId);

    sendSuccess(res, requestId, {
      provider: providerId,
      configured: true,
      ...updated,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleSetDefaultProvider(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  const provider = (body.provider || '').trim();
  if (!provider) {
    return sendError(res, requestId, 'validation_error', 'provider is required', 400, {}, req);
  }

  const providerConfig = providerRoutingCore.getProvider(provider);
  if (!providerConfig) {
    return sendError(res, requestId, 'provider_not_found', `Unknown provider: ${provider}`, 404, {}, req);
  }

  try {
    providerRoutingCore.setDefaultProvider(provider);
    sendSuccess(res, requestId, {
      provider,
      default: true,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Project Config ─────────────────────────────────────────────────────────

async function handleListProjects(req, res) {
  const requestId = resolveRequestId(req);

  try {
    const projects = typeof taskCore.listKnownProjects === 'function'
      ? taskCore.listKnownProjects()
      : [];
    const items = Array.isArray(projects) ? projects : [];
    sendList(res, requestId, items, items.length, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleScanProject(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  const workingDirectory = (body.working_directory || '').trim();
  if (!workingDirectory) {
    return sendError(res, requestId, 'validation_error', 'working_directory is required', 400, {}, req);
  }

  try {
    const integrationHandlers = require('../handlers/integration');
    const result = integrationHandlers.handleScanProject({ working_directory: workingDirectory, depth: body.depth });

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Scan failed';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    const text = result?.content?.[0]?.text || '';
    sendSuccess(res, requestId, { working_directory: workingDirectory, scan_result: text }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

function resolveProjectIdentifier(payload = {}) {
  const explicitProject = String(payload.project || '').trim();
  if (explicitProject) {
    return explicitProject;
  }

  const workingDirectory = String(payload.working_directory || '').trim();
  if (!workingDirectory) {
    return '';
  }

  if (typeof projectConfigCore.getProjectFromPath !== 'function') {
    return '';
  }

  return projectConfigCore.getProjectFromPath(workingDirectory) || '';
}

async function handleGetProjectConfig(req, res) {
  const requestId = resolveRequestId(req);
  const project = resolveProjectIdentifier(req.query || {});

  if (!project) {
    return sendError(res, requestId, 'validation_error', 'project or working_directory is required', 400, {}, req);
  }

  try {
    const config = projectConfigCore.getProjectConfig(project);
    sendSuccess(res, requestId, {
      project,
      configured: Boolean(config),
      ...(config || {}),
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleSetProjectConfig(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);
  const project = resolveProjectIdentifier(body || {});

  if (!project) {
    return sendError(res, requestId, 'validation_error', 'project or working_directory is required', 400, {}, req);
  }

  try {
    const updated = projectConfigCore.setProjectConfig(project, {
      ...body,
      routing_template_id: body?.routing_template_id === '' ? null : body?.routing_template_id,
    });
    sendSuccess(res, requestId, {
      project,
      configured: true,
      ...updated,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleGetProjectDefaults(req, res) {
  const requestId = resolveRequestId(req);
  const workingDirectory = (req.query?.working_directory || '').trim();

  try {
    const automationHandlers = require('../handlers/automation-handlers');
    const result = automationHandlers.handleGetProjectDefaults({ working_directory: workingDirectory || undefined });

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Failed to get defaults';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    const text = result?.content?.[0]?.text || '';
    sendSuccess(res, requestId, { defaults: text }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleSetProjectDefaults(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  try {
    const automationHandlers = require('../handlers/automation-handlers');
    const result = automationHandlers.handleSetProjectDefaults(body);

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Failed to set defaults';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    sendSuccess(res, requestId, { configured: true }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Generic Config ─────────────────────────────────────────────────────────

async function handleGetConfig(req, res) {
  const requestId = resolveRequestId(req);
  const key = req.params?.key;

  if (key) {
    if (!VALID_CONFIG_KEYS.has(key)) {
      return sendError(res, requestId, 'validation_error', `Unknown config key: ${key}`, 400, {}, req);
    }
    const value = configCore.getConfig(key);
    // SECURITY: redact sensitive values in API response
    const safeValue = isSensitiveKey(key) ? redactValue(value) : value;
    return sendSuccess(res, requestId, { key, value: safeValue }, 200, req);
  }

  const config = configCore.getAllConfig ? configCore.getAllConfig() : {};
  // SECURITY: redact all sensitive keys in full config response
  sendSuccess(res, requestId, redactConfigObject(config), 200, req);
}

async function handleSetConfig(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);
  const key = (body.key || req.params?.key || '').trim();
  const value = body.value;

  if (!key) {
    return sendError(res, requestId, 'validation_error', 'key is required', 400, {}, req);
  }
  if (!VALID_CONFIG_KEYS.has(key)) {
    return sendError(res, requestId, 'validation_error', `Unknown config key: ${key}. Use GET /api/v2/config for valid keys.`, 400, {}, req);
  }
  if (value === undefined || value === null) {
    return sendError(res, requestId, 'validation_error', 'value is required', 400, {}, req);
  }
  if (typeof value === 'string' && value.length > 65536) {
    return sendError(res, requestId, 'validation_error', 'Config value exceeds maximum length (64KB)', 400, {}, req);
  }

  try {
    configCore.setConfig(key, String(value));
    const current = configCore.getConfig(key);
    sendSuccess(res, requestId, { key, value: current }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleConfigureStallDetection(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  if (!body.provider) {
    return sendError(res, requestId, 'validation_error', 'provider is required', 400, {}, req);
  }

  try {
    const automationHandlers = require('../handlers/automation-handlers');
    const result = automationHandlers.handleConfigureStallDetection(body);

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Failed to configure stall detection';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    sendSuccess(res, requestId, { provider: body.provider, configured: true }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

async function handleListWebhooks(req, res) {
  const requestId = resolveRequestId(req);

  try {
    const webhookHandlers = require('../handlers/webhook-handlers');
    const result = webhookHandlers.handleListWebhooks({});

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Failed to list webhooks';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    const webhooks = webhooksStreaming.listWebhooks ? webhooksStreaming.listWebhooks() : [];
    sendList(res, requestId, webhooks, webhooks.length, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleAddWebhook(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  if (!body.url) {
    return sendError(res, requestId, 'validation_error', 'url is required', 400, {}, req);
  }

  try {
    const webhookHandlers = require('../handlers/webhook-handlers');
    const result = webhookHandlers.handleAddWebhook(body);

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Failed to add webhook';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    sendSuccess(res, requestId, { url: body.url, added: true }, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleRemoveWebhook(req, res) {
  const requestId = resolveRequestId(req);
  const webhookId = req.params?.webhook_id;

  if (!webhookId) {
    return sendError(res, requestId, 'validation_error', 'webhook_id is required', 400, {}, req);
  }

  try {
    const webhookHandlers = require('../handlers/webhook-handlers');
    const result = webhookHandlers.handleRemoveWebhook({ webhook_id: webhookId });

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Failed to remove webhook';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    sendSuccess(res, requestId, { webhook_id: webhookId, deleted: true }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleTestWebhook(req, res) {
  const requestId = resolveRequestId(req);
  const webhookId = req.params?.webhook_id;

  if (!webhookId) {
    return sendError(res, requestId, 'validation_error', 'webhook_id is required', 400, {}, req);
  }

  try {
    const webhookHandlers = require('../handlers/webhook-handlers');
    const result = webhookHandlers.handleTestWebhook({ webhook_id: webhookId });

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Webhook test failed';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    const text = result?.content?.[0]?.text || '';
    sendSuccess(res, requestId, { webhook_id: webhookId, test_result: text }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

async function handleAutoVerifyAndFix(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  try {
    const automationHandlers = require('../handlers/automation-handlers');
    const result = await automationHandlers.handleAutoVerifyAndFix(body);

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Verification failed';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    const text = result?.content?.[0]?.text || '';
    sendSuccess(res, requestId, { result: text }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDetectFileConflicts(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  if (!body.workflow_id) {
    return sendError(res, requestId, 'validation_error', 'workflow_id is required', 400, {}, req);
  }

  try {
    const automationHandlers = require('../handlers/automation-handlers');
    const result = automationHandlers.handleDetectFileConflicts(body);

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Conflict detection failed';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    const text = result?.content?.[0]?.text || '';
    sendSuccess(res, requestId, { workflow_id: body.workflow_id, result: text }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

function createV2GovernanceHandlers(_deps) {
  init(_deps);
  return {
    init,
    handleListApprovals,
    handleApprovalDecision,
    handleListSchedules,
    handleCreateSchedule,
    handleGetSchedule,
    handleGetScheduleRun,
    handleRunSchedule,
    handleToggleSchedule,
    handleDeleteSchedule,
    handleUpdateSchedule,
    handleListPolicies,
    handleGetPolicy,
    handleSetPolicyMode,
    handleEvaluatePolicies,
    handleListPolicyEvaluations,
    handleGetPolicyEvaluation,
    handleOverridePolicyDecision,
    handlePeekAttestationExport,
    handleListPlanProjects,
    handleGetPlanProject,
    handlePlanProjectAction,
    handleDeletePlanProject,
    handleImportPlan,
    handleListBenchmarks,
    handleApplyBenchmark,
    handleListProjectTuning,
    handleCreateProjectTuning,
    handleDeleteProjectTuning,
    handleListProviders,
    handleProviderStats,
    handleProviderToggle,
    handleProviderTrends,
    handleConfigureProvider,
    handleSetDefaultProvider,
    handleSystemStatus,
    handleListProjects,
    handleScanProject,
    handleGetProjectConfig,
    handleSetProjectConfig,
    handleGetProjectDefaults,
    handleSetProjectDefaults,
    handleGetConfig,
    handleSetConfig,
    handleConfigureStallDetection,
    handleListWebhooks,
    handleAddWebhook,
    handleRemoveWebhook,
    handleTestWebhook,
    handleAutoVerifyAndFix,
    handleDetectFileConflicts,
  };
}

function handleGetPerfCounters(req, res) {
  const perfCounters = require('../operations-perf-counters');
  const reset = req.query && req.query.reset === 'true';
  res.json({ ok: true, counters: perfCounters.getSnapshot(reset) });
}

module.exports = {
  init,
  createV2GovernanceHandlers,
  // Perf
  handleGetPerfCounters,
  // Approvals
  handleListApprovals,
  handleApprovalDecision,
  // Schedules
  handleListSchedules,
  handleCreateSchedule,
  handleGetSchedule,
  handleGetScheduleRun,
  handleRunSchedule,
  handleToggleSchedule,
  handleDeleteSchedule,
  handleUpdateSchedule,
  // Policies
  handleListPolicies,
  handleGetPolicy,
  handleSetPolicyMode,
  handleEvaluatePolicies,
  handleListPolicyEvaluations,
  handleGetPolicyEvaluation,
  handleOverridePolicyDecision,
  handlePeekAttestationExport,
  // Plan Projects
  handleListPlanProjects,
  handleGetPlanProject,
  handlePlanProjectAction,
  handleDeletePlanProject,
  handleImportPlan,
  // Benchmarks & Tuning
  handleListBenchmarks,
  handleApplyBenchmark,
  handleListProjectTuning,
  handleCreateProjectTuning,
  handleDeleteProjectTuning,
  // Provider Stats
  handleListProviders,
  handleProviderStats,
  handleProviderToggle,
  handleProviderTrends,
  // Provider Configuration
  handleConfigureProvider,
  handleSetDefaultProvider,
  // System
  handleSystemStatus,
  // Project Config
  handleListProjects,
  handleScanProject,
  handleGetProjectConfig,
  handleSetProjectConfig,
  handleGetProjectDefaults,
  handleSetProjectDefaults,
  handleGetConfig,
  handleSetConfig,
  handleConfigureStallDetection,
  // Webhooks
  handleListWebhooks,
  handleAddWebhook,
  handleRemoveWebhook,
  handleTestWebhook,
  // Validation
  handleAutoVerifyAndFix,
  handleDetectFileConflicts,
};
