'use strict';

/**
 * V2 Control-Plane Governance Handlers
 *
 * Structured JSON REST handlers for approvals, schedules, plan projects,
 * benchmarks/tuning, provider stats, and system status.
 * These return { data, meta } envelopes via v2-control-plane helpers.
 */

const crypto = require('crypto');
const db = require('../database');
const { VALID_CONFIG_KEYS } = require('../db/config-keys');
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
const VALID_ACTIONS = new Set(['pause', 'resume', 'retry']);

function init(taskManager) {
  _taskManager = taskManager;
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

  const pending = db.listPendingApprovals ? db.listPendingApprovals() : [];
  const items = Array.isArray(pending) ? pending : [];

  if (query.include_history === 'true') {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const history = db.getApprovalHistory ? db.getApprovalHistory(limit) : [];
    return sendSuccess(res, requestId, {
      pending: items,
      history: Array.isArray(history) ? history : [],
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

  if (!db.decideApproval) {
    return sendError(res, requestId, 'not_implemented', 'Approval system not available', 501, {}, req);
  }

  const decidedBy = String(body.decided_by || 'v2-api').slice(0, 100).replace(/[^a-zA-Z0-9_\-@. ]/g, '');

  const result = db.decideApproval(approvalId, decision, decidedBy);
  if (!result) {
    return sendError(res, requestId, 'approval_not_found', `Approval not found: ${approvalId}`, 404, {}, req);
  }

  sendSuccess(res, requestId, {
    approval_id: approvalId,
    decision,
    decided_by: decidedBy,
  }, 200, req);
}

// ─── Schedules ──────────────────────────────────────────────────────────────

async function handleListSchedules(req, res) {
  const requestId = resolveRequestId(req);
  const schedules = db.listScheduledTasks ? db.listScheduledTasks() : [];
  const items = Array.isArray(schedules) ? schedules : [];
  sendList(res, requestId, items, items.length, req);
}

async function handleCreateSchedule(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  const name = (body.name || '').trim();
  if (!name) {
    return sendError(res, requestId, 'validation_error', 'name is required', 400, undefined, req);
  }
  if (!body.cron_expression) {
    return sendError(res, requestId, 'validation_error', 'cron_expression is required', 400, undefined, req);
  }
  if (!body.task_description) {
    return sendError(res, requestId, 'validation_error', 'task_description is required', 400, undefined, req);
  }

  try {
    const schedule = db.createCronScheduledTask(
      name,
      body.cron_expression,
      body.task_description,
      {
        provider: body.provider || null,
        model: body.model || null,
        working_directory: body.working_directory || null,
      }
    );
    sendSuccess(res, requestId, schedule, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleGetSchedule(req, res) {
  const requestId = resolveRequestId(req);
  const scheduleId = req.params?.schedule_id;

  const schedule = db.getScheduledTask
    ? db.getScheduledTask(scheduleId)
    : (db.listScheduledTasks ? (db.listScheduledTasks() || []).find(s => String(s.id) === String(scheduleId)) : null);
  if (!schedule) {
    return sendError(res, requestId, 'schedule_not_found', `Schedule not found: ${scheduleId}`, 404, {}, req);
  }

  sendSuccess(res, requestId, schedule, 200, req);
}

async function handleToggleSchedule(req, res) {
  const requestId = resolveRequestId(req);
  const scheduleId = req.params?.schedule_id;
  const body = req.body || await parseBody(req);

  const enabled = body.enabled !== undefined ? body.enabled : true;

  try {
    const result = db.toggleScheduledTask(scheduleId, enabled);
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
    const result = db.deleteScheduledTask(scheduleId);
    if (!result) {
      return sendError(res, requestId, 'schedule_not_found', `Schedule not found: ${scheduleId}`, 404, {}, req);
    }
    sendSuccess(res, requestId, { deleted: true, schedule_id: scheduleId }, 200, req);
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
    const { exportAttestation } = require('../handlers/peek/compliance');
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
    const projects = db.listPlanProjects
      ? db.listPlanProjects({ status: query.status, limit })
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

  const project = db.getPlanProject ? db.getPlanProject(projectId) : null;
  if (!project) {
    return sendError(res, requestId, 'project_not_found', `Plan project not found: ${projectId}`, 404, {}, req);
  }

  const tasks = db.getPlanProjectTasks ? db.getPlanProjectTasks(projectId) : [];

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

  const project = db.getPlanProject ? db.getPlanProject(projectId) : null;
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

  const project = db.getPlanProject ? db.getPlanProject(projectId) : null;
  if (!project) {
    return sendError(res, requestId, 'project_not_found', `Plan project not found: ${projectId}`, 404, {}, req);
  }

  try {
    // Cancel running tasks
    if (_taskManager) {
      const tasks = db.getPlanProjectTasks ? db.getPlanProjectTasks(projectId) : [];
      for (const task of tasks) {
        if (['queued', 'running', 'waiting'].includes(task.status)) {
          try {
            _taskManager.cancelTask(task.task_id, 'Plan project deleted via v2 API');
          } catch {
            db.updateTaskStatus(task.task_id, 'cancelled', {
              error_output: 'Plan project deleted',
            });
          }
        }
      }
    }

    if (db.deletePlanProject) {
      db.deletePlanProject(projectId);
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
    fs.writeFileSync(tempFile, body.plan_content);

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
      try { fs.unlinkSync(tempFile); } catch { /* cleanup */ }
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
    const results = db.getBenchmarkResults ? db.getBenchmarkResults(hostId, limit) : [];
    const stats = db.getBenchmarkStats ? db.getBenchmarkStats(hostId) : {};

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
    const result = db.applyBenchmarkResults
      ? db.applyBenchmarkResults(hostId, body.model)
      : {};
    sendSuccess(res, requestId, result || {}, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleListProjectTuning(req, res) {
  const requestId = resolveRequestId(req);

  try {
    const tunings = db.listProjectTuning ? db.listProjectTuning() : [];
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
    db.setProjectTuning(projectPath, body.settings, body.description);
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
    db.deleteProjectTuning(decoded);
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

    const total = db.countTasks ? db.countTasks(baseFilters) : 0;
    const completed = db.countTasks ? db.countTasks({ ...baseFilters, status: 'completed' }) : 0;
    const failed = db.countTasks ? db.countTasks({ ...baseFilters, status: 'failed' }) : 0;

    series.push({ date: dateStr, total, completed, failed });
  }

  return series;
}

async function handleListProviders(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const providers = db.listProviders ? db.listProviders() : [];
    // Enrich each provider with aggregated stats
    const enriched = providers.map(p => {
      const rawStats = db.getProviderStats ? db.getProviderStats(p.provider) : [];
      const statsList = Array.isArray(rawStats) ? rawStats : [];
      // Aggregate per-task-type stats into totals
      const total_tasks = statsList.reduce((s, r) => s + (r.total_tasks || 0), 0);
      const completed_tasks = statsList.reduce((s, r) => s + (r.successful_tasks || 0), 0);
      const failed_tasks = statsList.reduce((s, r) => s + (r.failed_tasks || 0), 0);
      const durations = statsList.filter(r => r.avg_duration_seconds > 0);
      const avg_duration_seconds = durations.length > 0
        ? durations.reduce((s, r) => s + r.avg_duration_seconds, 0) / durations.length
        : null;
      const success_rate = total_tasks > 0 ? Math.round(completed_tasks / total_tasks * 100) : 0;
      const total_cost = statsList.reduce((s, r) => s + (r.total_cost || 0), 0);
      // API key status enrichment
      let api_key_status = 'not_set';
      let api_key_masked = null;
      try {
        const { getApiKeyStatus, decryptApiKey } = require('../handlers/provider-crud-handlers');
        const { redactValue } = require('../utils/sensitive-keys');
        const serverConfig = require('../config');

        api_key_status = typeof getApiKeyStatus === 'function' ? getApiKeyStatus(p.provider) : 'not_set';
        if (api_key_status === 'env') {
          const envKey = serverConfig.getApiKey(p.provider);
          if (envKey) api_key_masked = typeof redactValue === 'function' ? redactValue(envKey) : '••••••';
        } else if ((api_key_status === 'stored' || api_key_status === 'validating') && p.api_key_encrypted) {
          const decrypted = typeof decryptApiKey === 'function' ? decryptApiKey(p.api_key_encrypted) : null;
          if (decrypted) api_key_masked = typeof redactValue === 'function' ? redactValue(decrypted) : '••••••';
        }
      } catch { /* key enrichment is best-effort */ }

      return {
        ...p,
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
    const stats = db.getProviderStats ? db.getProviderStats(providerId, days) : {};
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

  const provider = db.getProvider ? db.getProvider(providerId) : null;
  if (!provider) {
    return sendError(res, requestId, 'provider_not_found', `Provider not found: ${providerId}`, 404, {}, req);
  }

  const enabled = body.enabled !== undefined
    ? Boolean(body.enabled)
    : !provider.enabled;

  try {
    db.updateProvider(providerId, { enabled: enabled ? 1 : 0 });
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
    const providers = db.listProviders ? db.listProviders() : [];
    const providerNames = providers.map(p => p.provider);

    const dates = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    const providerSeries = {};
    for (const p of providers) {
      providerSeries[p.provider] = getProviderTimeSeries(p.provider, days);
    }

    const series = dates.map((date, idx) => {
      const entry = { date };
      for (const p of providers) {
        const dayData = providerSeries[p.provider]?.[idx] || {};
        const total = (dayData.completed || 0) + (dayData.failed || 0);
        entry[`${p.provider}_total`] = dayData.total || 0;
        entry[`${p.provider}_completed`] = dayData.completed || 0;
        entry[`${p.provider}_failed`] = dayData.failed || 0;
        entry[`${p.provider}_success_rate`] = total > 0
          ? Math.round((dayData.completed || 0) / total * 100) : null;
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

  const runningTasks = db.countTasks ? db.countTasks({ status: 'running' }) : 0;
  const queuedTasks = db.countTasks ? db.countTasks({ status: 'queued' }) : 0;

  let instanceId = null;
  if (_taskManager && _taskManager.getMcpInstanceId) {
    instanceId = _taskManager.getMcpInstanceId();
  }

  // TDA-14: Surface resource gating state so callers see pressure and gating status
  let resourceGating = { enabled: false, pressure_level: 'unknown' };
  try {
    const gatingEnabled = db.getConfig ? db.getConfig('resource_gating_enabled') === '1' : false;
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
  } catch { /* ignore — best effort */ }

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

  if (!providerId) {
    return sendError(res, requestId, 'validation_error', 'provider_id is required', 400, {}, req);
  }

  const provider = db.getProvider(providerId);
  if (!provider) {
    return sendError(res, requestId, 'provider_not_found', `Provider not found: ${providerId}`, 404, {}, req);
  }

  try {
    const updates = {};
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.model) updates.default_model = body.model;
    if (body.max_concurrent !== undefined) updates.max_concurrent = body.max_concurrent;
    if (body.timeout_minutes !== undefined) updates.timeout_minutes = body.timeout_minutes;

    db.updateProvider(providerId, updates);
    const updated = db.getProvider(providerId);

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

  const providerConfig = db.getProvider(provider);
  if (!providerConfig) {
    return sendError(res, requestId, 'provider_not_found', `Unknown provider: ${provider}`, 404, {}, req);
  }

  try {
    db.setDefaultProvider(provider);
    sendSuccess(res, requestId, {
      provider,
      default: true,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Project Config ─────────────────────────────────────────────────────────

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
    const value = db.getConfig(key);
    // SECURITY: redact sensitive values in API response
    const safeValue = isSensitiveKey(key) ? redactValue(value) : value;
    return sendSuccess(res, requestId, { key, value: safeValue }, 200, req);
  }

  const config = db.getAllConfig ? db.getAllConfig() : {};
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
    db.setConfig(key, String(value));
    const current = db.getConfig(key);
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

    const webhooks = db.listWebhooks ? db.listWebhooks() : [];
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
    const result = automationHandlers.handleAutoVerifyAndFix(body);

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

module.exports = {
  init,
  // Approvals
  handleListApprovals,
  handleApprovalDecision,
  // Schedules
  handleListSchedules,
  handleCreateSchedule,
  handleGetSchedule,
  handleToggleSchedule,
  handleDeleteSchedule,
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
  handleScanProject,
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
