'use strict';

/**
 * V2 Control-Plane Response Helpers
 *
 * Shared response builders for structured JSON control-plane routes.
 * All v2 control-plane handlers use these to ensure consistent response shapes.
 */

const { randomUUID } = require('crypto');
const db = require('../database');
const { sendJson } = require('./middleware');

// ─── Response Envelope ────────────────────────────────────────────────────

function buildMeta(requestId) {
  return {
    request_id: requestId,
    timestamp: new Date().toISOString(),
  };
}

function sendSuccess(res, requestId, data, status = 200, req = null) {
  sendJson(res, { data, meta: buildMeta(requestId) }, status, req);
}

function sendError(res, requestId, code, message, status = 400, details = {}, req = null) {
  sendJson(res, {
    error: { code, message, details, request_id: requestId },
    meta: buildMeta(requestId),
  }, status, req);
}

function sendList(res, requestId, items, total, req = null) {
  sendJson(res, {
    data: { items, total },
    meta: buildMeta(requestId),
  }, 200, req);
}

// ─── Request Helpers ──────────────────────────────────────────────────────

function resolveRequestId(req) {
  return req?.requestId || req?.headers?.['x-request-id'] || randomUUID();
}

// ─── Task Response Builder ────────────────────────────────────────────────

function buildTaskResponse(task) {
  if (!task) return null;

  let metadata = {};
  try {
    metadata = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
  } catch { /* non-critical */ }

  let filesModified = [];
  try {
    filesModified = typeof task.files_modified === 'string'
      ? JSON.parse(task.files_modified)
      : (task.files_modified || []);
  } catch { /* non-critical */ }

  return {
    id: task.id,
    status: task.status,
    description: task.task_description || task.description || null,
    provider: task.provider || null,
    model: task.model || null,
    working_directory: task.working_directory || null,
    exit_code: task.exit_code ?? null,
    priority: task.priority || 0,
    auto_approve: Boolean(task.auto_approve),
    timeout_minutes: task.timeout_minutes ?? null,
    progress_percent: task.progress_percent || 0,
    ollama_host_id: task.ollama_host_id || null,
    files_modified: filesModified,
    created_at: task.created_at || null,
    started_at: task.started_at || null,
    completed_at: task.completed_at || null,
    // TDA-08: Expose placement truth fields so views can show real provider identity
    original_provider: metadata.original_provider || task.original_provider || null,
    provider_switch_target: metadata.provider_switch_target || metadata.target_provider || null,
    user_provider_override: Boolean(metadata.user_provider_override),
    provider_switch_reason: metadata._provider_switch_reason || null,
    metadata,
  };
}

function buildTaskDetailResponse(task) {
  const base = buildTaskResponse(task);
  if (!base) return null;

  return {
    ...base,
    output: task.output || null,
    error_output: task.error_output || null,
  };
}

// ─── Workflow Response Builder ────────────────────────────────────────────

function buildWorkflowResponse(workflow) {
  if (!workflow) return null;

  return {
    id: workflow.id,
    name: workflow.name || null,
    status: workflow.status,
    priority: workflow.priority ?? 0,
    description: workflow.description || null,
    working_directory: workflow.working_directory || null,
    created_at: workflow.created_at || null,
    started_at: workflow.started_at || null,
    completed_at: workflow.completed_at || null,
  };
}

function buildWorkflowDetailResponse(workflow, tasks) {
  const base = buildWorkflowResponse(workflow);
  if (!base) return null;

  const taskList = Array.isArray(tasks) ? tasks : Object.values(tasks || {});
  const cost = typeof db.getWorkflowCostSummary === 'function'
    ? (db.getWorkflowCostSummary(base.id) || {
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      by_model: [],
    })
    : {
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      by_model: [],
    };
  const counts = { total: 0, completed: 0, running: 0, pending: 0, queued: 0, failed: 0, cancelled: 0, blocked: 0, skipped: 0 };
  for (const t of taskList) {
    counts.total++;
    if (counts[t.status] !== undefined) counts[t.status]++;
  }

  return {
    ...base,
    cost,
    task_counts: counts,
    tasks: taskList.map(t => {
      const description = t.task_description || t.description || null;
      return {
        id: t.id,
        node_id: t.node_id || null,
        status: t.status,
        description,
        task_description: description,
        provider: t.provider || null,
        model: t.model || null,
        progress: t.progress || t.progress_percent || 0,
        depends_on: t.depends_on || null,
        started_at: t.started_at || null,
        completed_at: t.completed_at || null,
      };
    }),
  };
}

module.exports = {
  buildMeta,
  sendSuccess,
  sendError,
  sendList,
  resolveRequestId,
  buildTaskResponse,
  buildTaskDetailResponse,
  buildWorkflowResponse,
  buildWorkflowDetailResponse,
};
