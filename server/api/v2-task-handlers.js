'use strict';

/**
 * V2 Control-Plane Task Handlers
 *
 * Structured JSON REST handlers for the task lifecycle.
 * These return { data, meta } envelopes — not MCP text blobs.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const taskCore = require('../db/task-core');
const providerRoutingCore = require('../db/provider-routing-core');
const fileTracking = require('../db/file-tracking');
const webhooksStreaming = require('../db/webhooks-streaming');
const serverConfig = require('../config');
const logger = require('../logger').child({ component: 'v2-task-handlers' });
const { PROVIDER_DEFAULT_TIMEOUTS } = require('../constants');
const { CONTEXT_STUFFING_PROVIDERS } = require('../utils/context-stuffing');
const { prependResumeContextToPrompt } = require('../utils/resume-context');
const { resolveContextFiles } = require('../utils/smart-scan');
const { buildTaskStudyContextEnvelope } = require('../integrations/codebase-study-engine');
const { recordStudyTaskSubmitted } = require('../db/study-telemetry');
const {
  sendSuccess,
  sendError,
  sendList,
  resolveRequestId,
  buildTaskResponse,
  buildTaskDetailResponse,
} = require('./v2-control-plane');
const { parseBody } = require('./middleware');
const eventBus = require('../event-bus');

let _taskManager = null;
const ALLOWED_ORDER_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'started_at',
  'completed_at',
  'priority',
  'status',
  'provider',
]);
const ALLOWED_ORDER_DIRECTIONS = new Set(['asc', 'desc']);

function init(taskManager) {
  _taskManager = taskManager;
}

function getBlockedPolicyMessage(policyResult) {
  return policyResult?.reason || policyResult?.error || 'Task blocked by policy';
}

function parseTaskMetadata(task) {
  if (!task || task.metadata == null) return {};
  if (typeof task.metadata === 'object' && !Array.isArray(task.metadata)) {
    return { ...task.metadata };
  }
  if (typeof task.metadata !== 'string') return {};

  try {
    const parsed = JSON.parse(task.metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (err) {
    logger.debug("task handler error", { err: err.message });
    return {};
  }
}

function getRunDirManager() {
  try {
    const { defaultContainer } = require('../container');
    if (defaultContainer && typeof defaultContainer.has === 'function' && defaultContainer.has('runDirManager')) {
      return defaultContainer.get('runDirManager');
    }
  } catch {
    // Best-effort lookup; handlers return a 503 if the manager is unavailable.
  }
  return null;
}

function isTextArtifactMimeType(mimeType) {
  if (typeof mimeType !== 'string' || !mimeType.trim()) {
    return false;
  }
  return mimeType.startsWith('text/')
    || mimeType === 'application/json'
    || mimeType === 'application/xml'
    || mimeType === 'application/javascript'
    || mimeType.endsWith('+json')
    || mimeType.endsWith('+xml');
}

function isImageArtifactMimeType(mimeType) {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
}

function normalizeRunArtifactRecord(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return null;
  }

  const relativePath = typeof artifact.relative_path === 'string' ? artifact.relative_path : '';
  const mimeType = typeof artifact.mime_type === 'string' && artifact.mime_type.trim()
    ? artifact.mime_type
    : 'application/octet-stream';

  return {
    artifact_id: artifact.artifact_id,
    task_id: artifact.task_id,
    workflow_id: artifact.workflow_id || null,
    name: relativePath ? path.basename(relativePath) : artifact.artifact_id,
    relative_path: relativePath,
    absolute_path: artifact.absolute_path || null,
    size_bytes: Number(artifact.size_bytes) || 0,
    mime_type: mimeType,
    promoted: Boolean(artifact.promoted),
    is_text: isTextArtifactMimeType(mimeType),
    is_image: isImageArtifactMimeType(mimeType),
  };
}

async function buildRunArtifactPreview(artifact) {
  if (!artifact?.is_text || typeof artifact.absolute_path !== 'string' || !artifact.absolute_path.trim()) {
    return { preview_text: null, preview_truncated: false, preview_error: null };
  }

  try {
    const content = await fs.promises.readFile(artifact.absolute_path, 'utf8');
    const maxChars = 64000;
    return {
      preview_text: content.slice(0, maxChars),
      preview_truncated: content.length > maxChars,
      preview_error: null,
    };
  } catch (err) {
    return {
      preview_text: null,
      preview_truncated: false,
      preview_error: err.message,
    };
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function uniqueTaskIds(taskIds) {
  if (!Array.isArray(taskIds)) {
    return [];
  }

  return [...new Set(
    taskIds
      .map((taskId) => (typeof taskId === 'string' ? taskId.trim() : ''))
      .filter(Boolean)
  )];
}

function getPendingApprovalTasksForBatch(batchId) {
  const normalizedBatchId = typeof batchId === 'string' ? batchId.trim() : '';
  if (!normalizedBatchId) {
    return [];
  }

  return taskCore.listTasks({
    status: 'pending_approval',
    tags: [`factory:batch_id=${normalizedBatchId}`],
    limit: 10000,
  });
}

// getPendingSwitchTargetProvider and getPendingSwitchOriginalProvider removed —
// they were defined but never referenced. Restore from git history if needed.

const RETRY_METADATA_PRESERVE_KEYS = Object.freeze([
  '_routing_chain',
  '_routing_template',
  'agentic_allowed_tools',
  'agentic_tool_allowlist',
  'allowed_tools',
  'cloud_repo_write_mode',
  'context_files',
  'context_scan_reasons',
  'factory_internal',
  'inherited_provider',
  'inherited_provider_from_project',
  'inherited_routing_template',
  'inherited_routing_template_from_project',
  'kind',
  'needs_review',
  'ollama_cloud_repo_write_mode',
  'project_id',
  'proposal_apply_model',
  'proposal_apply_provider',
  'provider_lane_policy',
  'required_modified_paths',
  'target_project',
  'target_project_path',
  'work_item_id',
]);

function buildRetryMetadata(task, retryOfTaskId) {
  const taskMetadata = parseTaskMetadata(task);
  const retryMetadata = {};
  for (const key of RETRY_METADATA_PRESERVE_KEYS) {
    if (taskMetadata[key] !== undefined) {
      retryMetadata[key] = taskMetadata[key];
    }
  }
  if (typeof retryMetadata._routing_template === 'string') {
    retryMetadata._routing_template = retryMetadata._routing_template.trim();
    if (!retryMetadata._routing_template) {
      delete retryMetadata._routing_template;
    }
  }
  retryMetadata.retry_of = retryOfTaskId;
  // Preserve user_provider_override only when the original task was explicitly
  // user-routed. Smart-routed tasks that ended up on a non-default provider
  // should NOT lock to that provider on retry.
  if (taskMetadata.user_provider_override === true ||
      (typeof taskMetadata.original_provider === 'string' && taskMetadata.original_provider.trim())) {
    retryMetadata.user_provider_override = true;
  }
  return retryMetadata;
}

function emitTaskUpdated(taskId, status) {
  if (!taskId) return;
  eventBus.emitTaskUpdated({ taskId, status });
}

function maybeAttachStudyContextMetadata(metadata, body, description) {
  if (body?.study_context === false) {
    metadata.study_context = null;
    metadata.study_context_prompt = null;
    metadata.study_context_summary = null;
    return metadata;
  }

  const workingDirectory = typeof body?.working_directory === 'string' ? body.working_directory.trim() : '';
  if (!workingDirectory) {
    return metadata;
  }

  try {
    const envelope = buildTaskStudyContextEnvelope({
      workingDirectory,
      taskDescription: description,
      files: Array.isArray(body?.files) ? body.files.filter((file) => typeof file === 'string') : [],
    });
    if (envelope) {
      metadata.study_context = envelope.study_context;
      metadata.study_context_prompt = envelope.study_context_prompt;
      metadata.study_context_summary = envelope.study_context_summary;
    }
  } catch (err) {
    logger.debug(`[v2] Study context build failed: ${err.message}`);
  }

  return metadata;
}

function getProviderValidation(provider) {
  if (typeof provider !== 'string' || !provider.trim()) {
    return { valid: false, code: 'validation_error', message: 'provider is required', status: 400 };
  }

  const providerId = provider.trim();
  const providerConfig = providerRoutingCore.getProvider(providerId);
  if (!providerConfig) {
    return { valid: false, code: 'provider_not_found', message: `Unknown provider: ${providerId}`, status: 400 };
  }
  if (!providerConfig.enabled) {
    return { valid: false, code: 'provider_unavailable', message: `Provider is currently disabled: ${providerId}`, status: 400 };
  }

  return { valid: true, provider: providerId, config: providerConfig };
}

async function handlePreviewTaskStudyContext(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);
  const workingDirectory = typeof body?.working_directory === 'string' ? body.working_directory.trim() : '';
  const description = (body?.task || body?.description || '').trim();
  const files = Array.isArray(body?.files)
    ? body.files.filter((value) => typeof value === 'string' && value.trim())
    : [];

  if (!workingDirectory) {
    return sendError(res, requestId, 'validation_error', 'working_directory is required', 400, {}, req);
  }

  try {
    const envelope = buildTaskStudyContextEnvelope({
      workingDirectory,
      taskDescription: description,
      files,
    });

    return sendSuccess(res, requestId, {
      available: Boolean(envelope),
      working_directory: workingDirectory,
      description: description || null,
      files,
      study_context: envelope?.study_context || null,
      study_context_summary: envelope?.study_context_summary || null,
      study_context_prompt: envelope?.study_context_prompt || null,
      reason: envelope
        ? null
        : 'No study context is available for this repository yet. Run or bootstrap the codebase study first.',
    }, 200, req);
  } catch (err) {
    return sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/tasks — Submit a task ───────────────────────────────────

async function handleSubmitTask(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  const description = (body.task || body.description || '').trim();
  if (!description) {
    return sendError(res, requestId, 'validation_error', 'task or description is required', 400);
  }
  if (description.length > 50000) {
    return sendError(res, requestId, 'validation_error', 'Task description exceeds maximum length', 400);
  }

  const provider = body.provider || providerRoutingCore.getDefaultProvider();
  if (body.provider) {
    const providerConfig = providerRoutingCore.getProvider(body.provider);
    if (!providerConfig) {
      return sendError(res, requestId, 'provider_not_found', `Unknown provider: ${body.provider}`, 404);
    }
    if (!providerConfig.enabled) {
      return sendError(res, requestId, 'provider_unavailable', `Provider ${body.provider} is disabled`, 400);
    }
  }

  const taskId = uuidv4();
  const defaultTimeout = serverConfig.getInt('default_timeout', 30);
  const providerTimeout = PROVIDER_DEFAULT_TIMEOUTS[provider] || defaultTimeout;
  const timeout = body.timeout_minutes ?? providerTimeout;
  const metadata = body.provider
    ? { user_provider_override: true, requested_provider: body.provider, intended_provider: provider }
    : { intended_provider: provider };
  if (body.context_stuff !== undefined) metadata.context_stuff = body.context_stuff;
  if (body.study_context !== undefined) metadata.study_context_enabled = body.study_context !== false;
  maybeAttachStudyContextMetadata(metadata, body, description);
  const policyResult = typeof _taskManager?.evaluateTaskSubmissionPolicy === 'function'
    ? _taskManager.evaluateTaskSubmissionPolicy({
        id: taskId,
        task_description: description,
        working_directory: body.working_directory || null,
        timeout_minutes: timeout,
        auto_approve: Boolean(body.auto_approve),
        priority: body.priority || 0,
        provider,
        model: body.model || null,
        metadata,
      })
    : null;
  if (policyResult?.blocked === true) {
    return sendError(res, requestId, 'task_blocked', getBlockedPolicyMessage(policyResult), 403, {}, req);
  }

  try {
    taskCore.createTask({
      id: taskId,
      status: 'pending',
      task_description: description,
      working_directory: body.working_directory || null,
      timeout_minutes: timeout,
      auto_approve: Boolean(body.auto_approve),
      priority: body.priority || 0,
      provider: null,  // deferred assignment — set by tryClaimTaskSlot when slot is available
      model: body.model || null,
      metadata: JSON.stringify(metadata),
    });
    try {
      recordStudyTaskSubmitted({
        id: taskId,
        status: 'pending',
        working_directory: body.working_directory || null,
        model: body.model || null,
        metadata,
      });
    } catch (_studyTelemetryErr) {
      // Non-blocking telemetry.
    }

    // Context-stuff: resolve files for eligible providers before starting
    const workingDirectory = body.working_directory;
    // Don't fall back to process.cwd() — require explicit working directory for context stuffing
    if (CONTEXT_STUFFING_PROVIDERS.has(provider) && body.context_stuff !== false && workingDirectory) {
      try {
        const depth = body.context_depth || 1;
        const scanResult = resolveContextFiles({
          taskDescription: description,
          workingDirectory,
          files: Array.isArray(body.files) ? body.files.filter(f => typeof f === 'string') : [],
          contextDepth: depth,
        });
        if (scanResult.contextFiles.length > 0) {
          metadata.context_files = scanResult.contextFiles;
          metadata.context_scan_reasons = Object.fromEntries(scanResult.reasons);
          taskCore.patchTaskMetadata(taskId, metadata);
          logger.info(`[v2] Context-stuffed ${scanResult.contextFiles.length} files for task ${taskId}`);
        }
      } catch (e) {
        logger.debug(`[v2] Context scan failed for task ${taskId}: ${e.message}`);
      }
    }

    if (!_taskManager) {
      return sendError(res, requestId, 'operation_failed', 'Task manager not initialized', 503, {}, req);
    }
    const result = _taskManager.startTask(taskId);
    if (result?.blocked) {
      // Clean up the task record that was created before the block was detected
      try { taskCore.deleteTask(taskId); } catch (err) { logger.debug("task handler error", { err: err.message }); }
      return sendError(res, requestId, 'task_blocked', result.reason || 'Task blocked by policy', 403, {}, req);
    }
    const task = taskCore.getTask(taskId);
    const status = task?.status || (result.queued ? 'queued' : 'running');
    emitTaskUpdated(taskId, status);

    sendSuccess(res, requestId, {
      task_id: taskId,
      status,
      provider,
      model: body.model || null,
      ...buildTaskResponse(task),
    }, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── GET /api/v2/tasks — List tasks ──────────────────────────────────────

async function handleListTasks(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const offset = query.page !== undefined
    ? (page - 1) * limit
    : Math.max(parseInt(query.offset, 10) || 0, 0);

  const filters = {};
  if (query.status === 'archived') {
    filters.archivedOnly = true;
  } else if (query.status) {
    filters.status = query.status;
  }
  if (query.provider) filters.provider = query.provider;
  if (query.search) filters.search = query.search;
  if (query.from) filters.from_date = query.from;
  if (query.to) filters.to_date = query.to;
  if (query.orderBy && !ALLOWED_ORDER_COLUMNS.has(query.orderBy)) {
    return sendError(res, requestId, 'validation_error', 'Invalid orderBy column', 400, undefined, req);
  }
  if (query.orderDir && !ALLOWED_ORDER_DIRECTIONS.has(query.orderDir)) {
    return sendError(res, requestId, 'validation_error', 'Invalid orderDir', 400, undefined, req);
  }
  if (query.orderBy) filters.orderBy = query.orderBy;
  if (query.orderDir) filters.orderDir = query.orderDir;
  if (query.tags) {
    const tags = String(query.tags)
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
    if (tags.length > 0) filters.tags = tags;
  }

  const tasks = taskCore.listTasks({
    ...filters,
    limit,
    offset,
    // Opt-in column projection — v2 list responses are built by buildTaskResponse,
    // which only reads these summary fields. Pulling `SELECT *` on a multi-GB
    // tasks.db drags multi-MB error_output/output/context blobs across every row
    // just to drop them during serialization — that's the dominant source of
    // Kanban fan-out latency.
    columns: [
      'id', 'status', 'task_description', 'provider', 'model',
      'working_directory', 'exit_code', 'priority', 'auto_approve',
      'timeout_minutes', 'progress_percent', 'ollama_host_id',
      'files_modified', 'created_at', 'started_at', 'completed_at',
      'original_provider', 'project', 'tags', 'metadata',
    ],
  });
  const items = tasks.map(buildTaskResponse).filter(Boolean);
  const total = typeof taskCore.countTasks === 'function' ? taskCore.countTasks(filters) : items.length;

  sendList(res, requestId, items, total, req);
}

// ─── GET /api/v2/tasks/kanban-summary — Batched Kanban board data ───────
//
// Replaces Kanban's 7-parallel-listTasks fan-out with one round-trip. Each
// bucket gets the same shape as /api/v2/tasks: buildTaskResponse() items +
// total (from countTasks). Only task buckets — stats/providers stay separate
// because they're cacheable on different intervals. On the 3.7 GB live DB,
// the 7-way fan-out was the dominant dashboard-load cost even after the
// SELECT * → column-projection fix; a single round-trip drops HTTP +
// middleware + serialize/deserialize overhead that was the remaining floor.

const KANBAN_BUCKETS = Object.freeze([
  { key: 'pending_approval',        status: 'pending_approval',        limit: 50, orderDir: 'asc'  },
  { key: 'queued',                  status: 'queued',                  limit: 50, orderDir: 'asc'  },
  { key: 'running',                 status: 'running',                 limit: 50, orderDir: 'asc'  },
  { key: 'pending_provider_switch', status: 'pending_provider_switch', limit: 20, orderDir: 'asc'  },
  { key: 'completed',               status: 'completed',               limit: 30, orderBy: 'completed_at', orderDir: 'desc' },
  { key: 'failed',                  status: 'failed',                  limit: 30, orderBy: 'completed_at', orderDir: 'desc' },
  { key: 'cancelled',               status: 'cancelled',               limit: 30, orderBy: 'completed_at', orderDir: 'desc' },
]);

async function handleKanbanSummary(req, res) {
  const requestId = resolveRequestId(req);
  const buckets = {};
  const columns = Array.isArray(taskCore.TASK_LIST_COLUMNS) && taskCore.TASK_LIST_COLUMNS.length > 0
    ? taskCore.TASK_LIST_COLUMNS
    : undefined;

  for (const cfg of KANBAN_BUCKETS) {
    let items = [];
    let total = 0;
    try {
      const rows = taskCore.listTasks({
        status: cfg.status,
        limit: cfg.limit,
        orderBy: cfg.orderBy,
        orderDir: cfg.orderDir,
        columns,
      });
      items = rows.map(buildTaskResponse).filter(Boolean);
      total = typeof taskCore.countTasks === 'function'
        ? taskCore.countTasks({ status: cfg.status })
        : items.length;
    } catch (err) {
      // One failing bucket shouldn't break the whole board. Return an empty
      // bucket + error marker; the dashboard can still render other columns.
      logger.warn('kanban-summary bucket failed', { bucket: cfg.key, err: err && err.message });
      items = [];
      total = 0;
    }
    buckets[cfg.key] = { items, total };
  }

  sendSuccess(res, requestId, { buckets }, 200, req);
}

// ─── GET /api/v2/tasks/:task_id — Get task detail ────────────────────────

async function handleGetTask(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    if (String(err.message).includes('Ambiguous')) {
      return sendError(res, requestId, 'validation_error', err.message, 400, {}, req);
    }
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  sendSuccess(res, requestId, buildTaskDetailResponse(task), 200, req);
}

async function handleTaskArtifacts(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    if (String(err.message).includes('Ambiguous')) {
      return sendError(res, requestId, 'validation_error', err.message, 400, {}, req);
    }
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  const manager = getRunDirManager();
  if (!manager) {
    return sendError(res, requestId, 'operation_failed', 'Run artifact manager is not available', 503, {}, req);
  }

  try {
    const taskMetadata = parseTaskMetadata(task);
    const items = manager.listArtifacts(taskId).map((artifact) => {
      const normalized = normalizeRunArtifactRecord(artifact);
      return {
        ...normalized,
        raw_url: `/api/v2/tasks/artifacts/${encodeURIComponent(normalized.artifact_id)}/content`,
      };
    });

    return sendSuccess(res, requestId, {
      task_id: taskId,
      run_dir: taskMetadata.run_dir || manager.runDirFor(taskId),
      items,
      total: items.length,
    }, 200, req);
  } catch (err) {
    return sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleGetTaskArtifact(req, res) {
  const requestId = resolveRequestId(req);
  const artifactId = req.params?.artifact_id;
  const manager = getRunDirManager();
  if (!manager) {
    return sendError(res, requestId, 'operation_failed', 'Run artifact manager is not available', 503, {}, req);
  }

  try {
    const artifact = normalizeRunArtifactRecord(manager.getArtifact(artifactId));
    if (!artifact) {
      return sendError(res, requestId, 'artifact_not_found', `Artifact not found: ${artifactId}`, 404, {}, req);
    }

    const preview = await buildRunArtifactPreview(artifact);
    return sendSuccess(res, requestId, {
      ...artifact,
      ...preview,
      raw_url: `/api/v2/tasks/artifacts/${encodeURIComponent(artifact.artifact_id)}/content`,
    }, 200, req);
  } catch (err) {
    return sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleTaskArtifactContent(req, res) {
  const requestId = resolveRequestId(req);
  const artifactId = req.params?.artifact_id;
  const manager = getRunDirManager();
  if (!manager) {
    return sendError(res, requestId, 'operation_failed', 'Run artifact manager is not available', 503, {}, req);
  }

  try {
    const artifact = normalizeRunArtifactRecord(manager.getArtifact(artifactId));
    if (!artifact) {
      return sendError(res, requestId, 'artifact_not_found', `Artifact not found: ${artifactId}`, 404, {}, req);
    }
    let buffer;
    try {
      buffer = await fs.promises.readFile(artifact.absolute_path);
    } catch {
      return sendError(res, requestId, 'artifact_missing', `Artifact file is missing for ${artifactId}`, 404, {}, req);
    }
    const fileName = (artifact.name || artifact.artifact_id).replace(/"/g, '');
    res.statusCode = 200;
    res.setHeader('Content-Type', artifact.mime_type);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.end(buffer);
  } catch (err) {
    return sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handlePromoteTaskArtifact(req, res) {
  const requestId = resolveRequestId(req);
  const artifactId = req.params?.artifact_id;
  const manager = getRunDirManager();
  if (!manager) {
    return sendError(res, requestId, 'operation_failed', 'Run artifact manager is not available', 503, {}, req);
  }

  const body = req.body || await parseBody(req);
  const destPath = typeof body?.dest_path === 'string' ? body.dest_path.trim() : '';
  if (!destPath) {
    return sendError(res, requestId, 'validation_error', 'dest_path is required', 400, {}, req);
  }

  try {
    const destinationPath = manager.promoteArtifact(artifactId, { destPath });
    const artifact = normalizeRunArtifactRecord(manager.getArtifact(artifactId));
    if (!artifact) {
      return sendError(res, requestId, 'artifact_not_found', `Artifact not found: ${artifactId}`, 404, {}, req);
    }

    return sendSuccess(res, requestId, {
      ...artifact,
      destination_path: destinationPath,
      raw_url: `/api/v2/tasks/artifacts/${encodeURIComponent(artifact.artifact_id)}/content`,
    }, 200, req);
  } catch (err) {
    return sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/tasks/:task_id/cancel — Cancel task ────────────────────

async function handleCancelTask(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    logger.debug("task handler error", { err: err.message });
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'skipped']);
  if (terminalStatuses.has(task.status)) {
    return sendSuccess(res, requestId, {
      task_id: task.id,
      cancelled: false,
      status: task.status,
      reason: 'Task already in terminal state',
    }, 200, req);
  }

  try {
    const body = req.body || {};
    const cancelReason = body.reason || 'Cancelled via REST API';
    let cancelled = false;
    if (_taskManager) {
      cancelled = _taskManager.cancelTask(task.id, cancelReason);
    } else {
      const updatedTask = taskCore.updateTaskStatus(task.id, 'cancelled', {
        error_output: cancelReason,
        cancel_reason: 'user',
      });
      cancelled = Boolean(updatedTask ? updatedTask.status === 'cancelled' : true);
    }
    const updated = taskCore.getTask(task.id);
    if (!cancelled || !updated || updated.status !== 'cancelled') {
      return sendError(
        res,
        requestId,
        'invalid_status',
        'Task status changed before cancellation could be applied',
        409,
        { task_id: task.id, status: updated?.status || task.status },
        req,
      );
    }
    emitTaskUpdated(task.id, updated.status);

    sendSuccess(res, requestId, {
      task_id: task.id,
      cancelled: true,
      status: updated.status,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/tasks/:task_id/retry — Retry a failed task ─────────────

async function handleRetryTask(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    logger.debug("task handler error", { err: err.message });
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  const retryableStatuses = new Set(['failed', 'cancelled']);
  if (!retryableStatuses.has(task.status)) {
    return sendError(res, requestId, 'invalid_status', `Cannot retry task with status: ${task.status}`, 400, {}, req);
  }

  try {
    const newTaskId = uuidv4();
    const taskMetadata = parseTaskMetadata(task);
    // If original task was smart-routed (no user override), clear provider so smart routing re-evaluates
    const wasSmartRouted = !taskMetadata?.original_provider && !taskMetadata?.user_provider_override && !taskMetadata?._routing_template;
    const retryProvider = wasSmartRouted ? null : (
      typeof taskMetadata.original_provider === 'string' && taskMetadata.original_provider.trim()
        ? taskMetadata.original_provider.trim()
        : task.provider
    );
    const providerValidation = retryProvider ? getProviderValidation(retryProvider) : { valid: true };
    if (!providerValidation.valid) {
      return sendError(res, requestId, providerValidation.code, providerValidation.message, providerValidation.status, {}, req);
    }
    const retryMetadata = buildRetryMetadata(task, taskId);
    retryMetadata.intended_provider = retryProvider;
    const retryDescription = prependResumeContextToPrompt(
      task.task_description || task.description,
      task.resume_context,
    );
    const retryPolicyResult = typeof _taskManager?.evaluateTaskSubmissionPolicy === 'function'
      ? _taskManager.evaluateTaskSubmissionPolicy({
          id: newTaskId,
          task_description: retryDescription,
          working_directory: task.working_directory,
          timeout_minutes: task.timeout_minutes,
          auto_approve: task.auto_approve,
          priority: task.priority || 0,
          provider: retryProvider,
          model: task.model,
          metadata: retryMetadata,
        })
      : null;
    if (retryPolicyResult?.blocked === true) {
      return sendError(res, requestId, 'task_blocked', getBlockedPolicyMessage(retryPolicyResult), 403, {}, req);
    }

    const hasTemplateRetryIntent = !!retryMetadata._routing_template;
    taskCore.createTask({
      id: newTaskId,
      status: 'pending',
      task_description: retryDescription,
      working_directory: task.working_directory,
      timeout_minutes: task.timeout_minutes,
      auto_approve: task.auto_approve,
      priority: task.priority || 0,
      project: task.project || null,
      tags: Array.isArray(task.tags) ? task.tags : [],
      provider: hasTemplateRetryIntent ? retryProvider : null,
      model: task.model,
      metadata: JSON.stringify(retryMetadata),
      resume_context: task.resume_context || null,
    });
    try {
      recordStudyTaskSubmitted({
        id: newTaskId,
        status: 'pending',
        working_directory: task.working_directory,
        model: task.model,
        metadata: retryMetadata,
      });
    } catch (_studyTelemetryErr) {
      // Non-blocking telemetry.
    }

    if (!_taskManager) {
      return sendError(res, requestId, 'operation_failed', 'Task manager not initialized', 503, {}, req);
    }
    const result = _taskManager.startTask(newTaskId);
    if (result?.blocked) {
      // Clean up the task record that was created before the block was detected
      try { taskCore.deleteTask(newTaskId); } catch (err) { logger.debug("task handler error", { err: err.message }); }
      return sendError(res, requestId, 'task_blocked', result.reason || 'Task blocked by policy', 403, {}, req);
    }
    const newTask = taskCore.getTask(newTaskId);
    const status = newTask?.status || (result.queued ? 'queued' : 'running');
    emitTaskUpdated(newTaskId, status);

    sendSuccess(res, requestId, {
      task_id: newTaskId,
      original_task_id: taskId,
      status,
      ...buildTaskResponse(newTask),
    }, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── PATCH /api/v2/tasks/:task_id/provider — Reassign queued task provider ─

async function handleReassignTaskProvider(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;
  const body = req.body || await parseBody(req);
  const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';

  if (!provider) {
    return sendError(res, requestId, 'validation_error', 'provider is required', 400, {}, req);
  }

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    logger.debug("task handler error", { err: err.message });
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (task.status !== 'queued') {
    return sendError(res, requestId, 'invalid_status', `Cannot reassign provider for task with status: ${task.status}`, 409, {}, req);
  }

  const providerConfig = providerRoutingCore.getProvider(provider);
  if (!providerConfig) {
    return sendError(res, requestId, 'provider_not_found', `Unknown provider: ${provider}`, 400, {}, req);
  }
  if (!providerConfig.enabled) {
    return sendError(res, requestId, 'provider_unavailable', 'Provider is currently disabled', 400, {}, req);
  }

  try {
    // Items 12+13: Clear stale model/ollama_host_id when changing provider family
    const providerRegistry = require('../providers/registry');
    const oldCategory = providerRegistry.getCategory(task.provider);
    const newCategory = providerRegistry.getCategory(provider);
    const familyChanged = oldCategory !== newCategory;

    const metadata = {
      ...parseTaskMetadata(task),
      user_provider_override: true,
    };
    // Item 14: Clear stale overflow metadata since operator reassigned explicitly
    delete metadata.quota_overflow;
    delete metadata.original_provider;
    // Populate a routing chain so chain-failover has somewhere to go when the
    // chosen provider's primary model fails. Without this, the chain on a
    // PATCH-reassigned task is empty: the executor has no fallback when the
    // chosen provider/model fails (1d686cbb 2026-04-26 — google-ai returned
    // HTTP 500 INTERNAL for an unreachable model, no chain to fall back to,
    // task died). The user's "I picked this provider" intent is preserved by
    // making it FIRST in the chain; subsequent entries are sibling enabled
    // providers in the same category (api → api, ollama → ollama, etc.) so
    // a 5xx or model-not-found falls over to a healthy peer instead of the
    // task dying.
    try {
      const chain = [{ provider, model: null }];
      const category = providerRegistry.getCategory(provider);
      if (category && providerRegistry.getProvidersInCategory) {
        const siblings = providerRegistry.getProvidersInCategory(category)
          .filter((p) => p !== provider);
        for (const sib of siblings) {
          // Only add enabled providers — querying the live config keeps the
          // chain honest about what can actually run.
          try {
            const provCfg = providerRoutingCore.getProvider?.(sib);
            if (provCfg && provCfg.enabled) {
              chain.push({ provider: sib, model: null });
            }
          } catch { /* skip on lookup error */ }
        }
      }
      metadata._routing_chain = chain;
    } catch (_e) {
      // Fall back to single-entry chain if registry probing fails — better
      // than the previous behavior of leaving _routing_chain undefined.
      metadata._routing_chain = [{ provider, model: null }];
    }

    const updateFields = { provider, metadata };
    if (familyChanged) {
      updateFields.model = null;
    }
    if (familyChanged || !providerRegistry.isOllamaProvider(provider)) {
      updateFields.ollama_host_id = null;
    }

    const updatedTask = taskCore.updateTask(taskId, updateFields);
    eventBus.emitQueueChanged();
    emitTaskUpdated(taskId, updatedTask?.status || task.status);

    logger.info(
      `Reassigned queued task ${taskId} provider from ${task.provider || 'unknown'} to ${updatedTask?.provider || provider}`,
    );

    sendSuccess(res, requestId, buildTaskDetailResponse(updatedTask), 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/tasks/:task_id/commit — Commit task changes ────────────

async function handleCommitTask(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    logger.debug("task handler error", { err: err.message });
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (task.status !== 'completed') {
    return sendError(res, requestId, 'invalid_status', `Cannot commit task with status: ${task.status}`, 400, {}, req);
  }

  try {
    // Delegate to the MCP handler which does the heavy lifting
    const { handleCommitTask: mpcCommit } = require('../handlers/task/pipeline');
    const body = req.body || {};
    const result = mpcCommit({
      task_id: taskId,
      message: body.message,
      auto_push: body.auto_push,
    });

    // Parse MCP response to extract commit info
    const text = result?.content?.[0]?.text || '';
    const shaMatch = text.match(/\b([a-f0-9]{7,40})\b/);

    sendSuccess(res, requestId, {
      task_id: taskId,
      committed: !result?.isError,
      sha: shaMatch ? shaMatch[1] : null,
      message: text,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── GET /api/v2/tasks/:task_id/diff — Task file diff ────────────────────

async function handleTaskDiff(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    logger.debug("task handler error", { err: err.message });
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  try {
    const changes = fileTracking.getTaskFileChanges ? fileTracking.getTaskFileChanges(taskId) : [];
    const filesChanged = Array.isArray(changes) ? changes : [];

    sendSuccess(res, requestId, {
      task_id: taskId,
      files_changed: filesChanged.length,
      changes: filesChanged.map(c => ({
        file: c.file_path || c.file,
        action: c.change_type || c.action || 'modified',
        lines_added: c.lines_added || 0,
        lines_removed: c.lines_removed || 0,
      })),
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── GET /api/v2/tasks/:task_id/logs — Task output/error logs ────────────

async function handleTaskLogs(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    logger.debug("task handler error", { err: err.message });
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  let streamChunks = [];
  try {
    streamChunks = webhooksStreaming.getStreamChunks(taskId, { limit: 1000 });
  } catch (err) {
    logger.debug("task log stream chunk lookup failed", { taskId, err: err.message });
  }

  sendSuccess(res, requestId, {
    task_id: taskId,
    status: task.status,
    output: task.output || null,
    error_output: task.error_output || null,
    stream_chunks: streamChunks,
  }, 200, req);
}

// ─── GET /api/v2/tasks/:task_id/progress — Task progress ─────────────────

async function handleTaskProgress(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  if (!_taskManager) {
    return sendError(res, requestId, 'not_initialized', 'Task manager not initialized', 500, {}, req);
  }

  const progress = _taskManager.getTaskProgress(taskId);
  if (!progress) {
    return sendError(res, requestId, 'task_not_found', `Task not found or not running: ${taskId}`, 404, {}, req);
  }

  sendSuccess(res, requestId, {
    task_id: taskId,
    status: progress.status || 'running',
    progress_percent: progress.progress || 0,
    phase: progress.phase || null,
    elapsed_seconds: progress.elapsed_seconds || 0,
    output_bytes: progress.output_length || 0,
    last_output_at: progress.last_output_at || null,
  }, 200, req);
}

// ─── DELETE /api/v2/tasks/:task_id — Delete a completed/failed task ────────

async function handleDeleteTask(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    logger.debug("task handler error", { err: err.message });
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  const activeStatuses = new Set(['running', 'queued', 'pending', 'pending_approval']);
  if (activeStatuses.has(task.status)) {
    return sendError(res, requestId, 'invalid_status', `Cannot delete task with status: ${task.status}. Cancel it first.`, 400, {}, req);
  }

  try {
    taskCore.deleteTask(taskId);
    sendSuccess(res, requestId, { task_id: taskId, deleted: true }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/tasks/:task_id/approve — Approve held task ────────────────

async function handleApproveTask(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    logger.debug('task handler error', { err: err.message });
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (task.status !== 'pending_approval') {
    return sendError(res, requestId, 'invalid_status', `Cannot approve task with status: ${task.status}`, 409, {}, req);
  }

  try {
    const updatedTask = taskCore.updateTaskStatus(task.id, 'queued');
    if (!updatedTask || updatedTask.status !== 'queued') {
      return sendError(res, requestId, 'invalid_status', `Task status changed before approval could be applied`, 409, {}, req);
    }

    emitTaskUpdated(task.id, updatedTask.status);
    sendSuccess(res, requestId, {
      approved: true,
      task_id: task.id,
      ...buildTaskDetailResponse(updatedTask),
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/tasks/:task_id/reject — Reject held task ─────────────────

async function handleRejectTask(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    logger.debug('task handler error', { err: err.message });
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (task.status !== 'pending_approval') {
    return sendError(res, requestId, 'invalid_status', `Cannot reject task with status: ${task.status}`, 409, {}, req);
  }

  try {
    const updatedTask = taskCore.updateTaskStatus(task.id, 'cancelled', {
      cancel_reason: 'human_rejected',
    });
    if (!updatedTask || updatedTask.status !== 'cancelled') {
      return sendError(res, requestId, 'invalid_status', `Task status changed before rejection could be applied`, 409, {}, req);
    }

    emitTaskUpdated(task.id, updatedTask.status);
    sendSuccess(res, requestId, {
      rejected: true,
      task_id: task.id,
      ...buildTaskDetailResponse(updatedTask),
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/tasks/approve-batch — Bulk-approve held tasks ───────────

async function handleApproveTaskBatch(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);
  const batchId = typeof body?.batch_id === 'string' ? body.batch_id.trim() : '';
  const requestedTaskIds = uniqueTaskIds(body?.task_ids);

  if (!batchId && requestedTaskIds.length === 0) {
    return sendError(res, requestId, 'validation_error', 'batch_id or task_ids is required', 400, {}, req);
  }

  const candidates = [];
  const seen = new Set();
  const skipped = [];

  if (batchId) {
    for (const task of getPendingApprovalTasksForBatch(batchId)) {
      if (task?.id && !seen.has(task.id)) {
        seen.add(task.id);
        candidates.push(task);
      }
    }
  }

  for (const taskId of requestedTaskIds) {
    if (seen.has(taskId)) {
      continue;
    }
    try {
      const task = taskCore.getTask(taskId);
      if (!task) {
        skipped.push({ task_id: taskId, reason: 'not_found', status: null });
        continue;
      }
      seen.add(task.id);
      candidates.push(task);
    } catch (err) {
      logger.debug('task handler error', { err: err.message });
      skipped.push({ task_id: taskId, reason: 'not_found', status: null });
    }
  }

  const approvedTasks = [];
  for (const task of candidates) {
    if (task.status !== 'pending_approval') {
      skipped.push({ task_id: task.id, reason: 'not_pending_approval', status: task.status });
      continue;
    }

    try {
      const updatedTask = taskCore.updateTaskStatus(task.id, 'queued');
      if (!updatedTask || updatedTask.status !== 'queued') {
        skipped.push({ task_id: task.id, reason: 'status_changed', status: updatedTask?.status || null });
        continue;
      }

      emitTaskUpdated(task.id, updatedTask.status);
      approvedTasks.push(updatedTask);
    } catch (err) {
      skipped.push({ task_id: task.id, reason: 'operation_failed', status: task.status });
      logger.debug('task handler error', { err: err.message });
    }
  }

  sendSuccess(res, requestId, {
    batch_id: batchId || null,
    requested_task_ids: requestedTaskIds,
    approved_count: approvedTasks.length,
    approved_task_ids: approvedTasks.map((task) => task.id),
    skipped,
    tasks: approvedTasks.map((task) => buildTaskResponse(task)),
  }, 200, req);
}

// ─── POST /api/v2/tasks/:task_id/approve-switch — Approve provider switch ──

async function handleApproveSwitch(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    logger.debug("task handler error", { err: err.message });
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (task.status !== 'pending_provider_switch') {
    return sendError(res, requestId, 'invalid_status', `Cannot approve provider switch for task with status: ${task.status}`, 409, {}, req);
  }

  const metadata = parseTaskMetadata(task);
  const targetProvider = firstNonEmptyString(
    metadata.provider_switch_target,
    metadata.target_provider,
    metadata.fallback_provider,
  );
  if (!targetProvider) {
    return sendError(res, requestId, 'validation_error', 'Pending provider switch is missing a target provider', 400, {}, req);
  }

  // Item 17: Validate target provider exists and is enabled (parity with reassignment)
  const providerConfig = providerRoutingCore.getProvider(targetProvider);
  if (!providerConfig) {
    return sendError(res, requestId, 'provider_not_found', `Unknown provider: ${targetProvider}`, 400, {}, req);
  }
  if (!providerConfig.enabled) {
    return sendError(res, requestId, 'provider_unavailable', `Provider is currently disabled: ${targetProvider}`, 400, {}, req);
  }

  try {
    // Item 16: Stamp user_provider_override so budget/overflow can't undo manual approval
    // Items 12+13: Clear stale model/ollama_host_id when changing provider family
    const providerRegistry = require('../providers/registry');
    const oldCategory = providerRegistry.getCategory(task.provider);
    const newCategory = providerRegistry.getCategory(targetProvider);
    const familyChanged = oldCategory !== newCategory;

    const updatedMetadata = {
      ...metadata,
      user_provider_override: true,
    };
    // Item 14: Clear stale overflow metadata since operator approved explicitly
    delete updatedMetadata.quota_overflow;
    delete updatedMetadata.original_provider;

    // Item 19: Clear stale runtime/failure state when re-queueing
    const requeueFields = {
      provider: targetProvider,
      metadata: updatedMetadata,
      started_at: null,
      completed_at: null,
      exit_code: null,
      pid: null,
      progress_percent: 0,
    };
    if (familyChanged) {
      requeueFields.model = null;
    }
    if (familyChanged || !providerRegistry.isOllamaProvider(targetProvider)) {
      requeueFields.ollama_host_id = null;
    }
    if (task.resume_context) {
      requeueFields.resume_context = task.resume_context;
      requeueFields.task_description = prependResumeContextToPrompt(task.task_description, task.resume_context);
    }

    let updatedTask;
    try {
      updatedTask = taskCore.updateTask(taskId, { status: 'queued', ...requeueFields });
    } catch (err) {
      if (!/Use updateTaskStatus\(\) to modify task status/.test(err?.message || '') || typeof taskCore.updateTaskStatus !== 'function') {
        throw err;
      }
      updatedTask = taskCore.updateTaskStatus(taskId, 'queued', requeueFields);
    }

    const responseTask = {
      ...task,
      ...(updatedTask && typeof updatedTask === 'object' ? updatedTask : {}),
      status: 'queued',
      provider: targetProvider,
    };

    eventBus.emitQueueChanged();
    emitTaskUpdated(taskId, responseTask.status);

    logger.info(`Approved provider switch for task ${taskId} from ${task.provider || 'unknown'} to ${targetProvider}`);

    sendSuccess(res, requestId, buildTaskDetailResponse(responseTask), 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── POST /api/v2/tasks/:task_id/reject-switch — Reject provider switch ────

async function handleRejectSwitch(req, res) {
  const requestId = resolveRequestId(req);
  const taskId = req.params?.task_id;

  let task;
  try {
    task = taskCore.getTask(taskId);
  } catch (err) {
    logger.debug("task handler error", { err: err.message });
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (!task) {
    return sendError(res, requestId, 'task_not_found', `Task not found: ${taskId}`, 404, {}, req);
  }

  if (task.status !== 'pending_provider_switch') {
    return sendError(res, requestId, 'invalid_status', `Cannot reject provider switch for task with status: ${task.status}`, 409, {}, req);
  }

  const metadata = parseTaskMetadata(task);
  const restoreProvider = firstNonEmptyString(
    task.provider,
    metadata.original_provider,
  );
  if (!restoreProvider) {
    return sendError(res, requestId, 'validation_error', 'Pending provider switch is missing an original provider', 400, {}, req);
  }
  const providerValidation = getProviderValidation(restoreProvider);
  if (!providerValidation.valid) {
    return sendError(res, requestId, providerValidation.code, providerValidation.message, providerValidation.status, {}, req);
  }

  try {
    // Items 12+13: Clear stale model/ollama_host_id when restoring to a different family
    const providerRegistry = require('../providers/registry');
    const oldCategory = providerRegistry.getCategory(task.provider);
    const newCategory = providerRegistry.getCategory(restoreProvider);
    const familyChanged = oldCategory !== newCategory;
    const updatedMetadata = {
      ...metadata,
    };
    // Items 20+21: Clear stale overflow/original-provider metadata after rejection
    delete updatedMetadata.quota_overflow;
    delete updatedMetadata.original_provider;

    // Item 19: Clear stale runtime/failure state when re-queueing
    const requeueFields = {
      provider: restoreProvider,
      metadata: updatedMetadata,
      started_at: null,
      completed_at: null,
      exit_code: null,
      pid: null,
      progress_percent: 0,
    };
    if (familyChanged) {
      requeueFields.model = null;
    }
    if (familyChanged || !providerRegistry.isOllamaProvider(restoreProvider)) {
      requeueFields.ollama_host_id = null;
    }
    if (task.resume_context) {
      requeueFields.resume_context = task.resume_context;
      requeueFields.task_description = prependResumeContextToPrompt(task.task_description, task.resume_context);
    }

    let updatedTask;
    try {
      updatedTask = taskCore.updateTask(taskId, { status: 'queued', ...requeueFields });
    } catch (err) {
      if (!/Use updateTaskStatus\(\) to modify task status/.test(err?.message || '') || typeof taskCore.updateTaskStatus !== 'function') {
        throw err;
      }
      updatedTask = taskCore.updateTaskStatus(taskId, 'queued', requeueFields);
    }

    const responseTask = {
      ...task,
      ...(updatedTask && typeof updatedTask === 'object' ? updatedTask : {}),
      status: 'queued',
      provider: restoreProvider,
      metadata: updatedMetadata,
    };

    eventBus.emitQueueChanged();
    emitTaskUpdated(taskId, responseTask.status);

    logger.info(`Rejected provider switch for task ${taskId}; restored provider ${restoreProvider}`);

    sendSuccess(res, requestId, buildTaskDetailResponse(responseTask), 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

function createV2TaskHandlers(_deps) {
  return {
    init,
    handlePreviewTaskStudyContext,
    handleSubmitTask,
    handleListTasks,
    handleKanbanSummary,
    handleGetTask,
    handleTaskArtifacts,
    handleGetTaskArtifact,
    handleTaskArtifactContent,
    handlePromoteTaskArtifact,
    handleCancelTask,
    handleRetryTask,
    handleReassignTaskProvider,
    handleCommitTask,
    handleTaskDiff,
    handleTaskLogs,
    handleTaskProgress,
    handleDeleteTask,
    handleApproveTask,
    handleRejectTask,
    handleApproveTaskBatch,
    handleApproveSwitch,
    handleRejectSwitch,
  };
}

module.exports = {
  init,
  handlePreviewTaskStudyContext,
  handleSubmitTask,
  handleListTasks,
  handleKanbanSummary,
  handleGetTask,
  handleTaskArtifacts,
  handleGetTaskArtifact,
  handleTaskArtifactContent,
  handlePromoteTaskArtifact,
  handleCancelTask,
  handleRetryTask,
  handleReassignTaskProvider,
  handleCommitTask,
  handleTaskDiff,
  handleTaskLogs,
  handleTaskProgress,
  handleDeleteTask,
  handleApproveTask,
  handleRejectTask,
  handleApproveTaskBatch,
  handleApproveSwitch,
  handleRejectSwitch,
  createV2TaskHandlers,
};
