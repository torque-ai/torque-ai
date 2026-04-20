/**
 * V2 API Core Handlers
 *
 * Inference validation/normalization, task status/cancel/events handlers,
 * provider listing/capabilities/detail/models/health handlers,
 * and remote execution handlers.
 *
 * Extracted from api-server.core.js to reduce file size.
 */

const { randomUUID } = require('crypto');
const db = require('../database');
const { getTask, updateTaskStatus } = require('../db/task-core');
const { getDefaultProvider, getProvider, listProviders } = require('../db/provider-routing-core');
const { recordTaskEvent, getTaskEvents } = require('../db/webhooks-streaming');
const serverConfig = require('../config');
const logger = require('../logger').child({ component: 'api-server' });
const v2Inference = require('./v2-inference');

const {
  sendJson,
  parseBody,
} = require('./middleware');

const {
  normalizeV2Transport,
  getV2ProviderTransport,
  sendV2Success,
  sendV2Error,
  sendV2DiscoverySuccess,
  sendV2DiscoveryError,
  getV2ProviderDefaultTimeoutMs,
  getV2ProviderAdapterCapabilities,
  getV2ProviderDefaultProvider,
  buildV2ProviderDescriptor,
  buildV2ProviderCapabilities,
  decodeV2ProviderIdOrSendError,
  getV2ProviderModels,
  getV2ProviderHealthPayload,
} = require('./v2-discovery-helpers');

let _remoteAgentPluginHandlers = null;

function getRemoteAgentPluginHandlers() {
  if (_remoteAgentPluginHandlers) {
    return _remoteAgentPluginHandlers;
  }

  const { getInstalledRegistry } = require('../plugins/remote-agents');
  const agentRegistry = getInstalledRegistry();
  if (!agentRegistry) return null;

  const database = require('../database');
  const { createHandlers } = require('../plugins/remote-agents/handlers');
  _remoteAgentPluginHandlers = createHandlers({
    agentRegistry,
    db: database,
  });
  return _remoteAgentPluginHandlers;
}

// ---------------------------------------------------------------------------
// Inference helpers
// ---------------------------------------------------------------------------

function normalizeMessageContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content.trim();
  if (typeof content === 'number' || typeof content === 'boolean') return String(content).trim();
  return '';
}

function formatV2InferenceResult(result) {
  if (result === null || result === undefined) {
    return {
      type: 'text',
      content: '',
    };
  }

  if (typeof result === 'string') {
    return {
      type: 'text',
      content: result.trim(),
    };
  }

  if (typeof result !== 'object' || Array.isArray(result)) {
    return {
      type: 'text',
      content: String(result),
    };
  }

  if (result.type === 'text' && typeof result.content === 'string') {
    return {
      type: 'text',
      content: normalizeMessageContent(result.content),
    };
  }

  const content = normalizeMessageContent(
    result.content
    || result.text
    || result.output
    || result.result
    || result.message?.content
    || '',
  );

  return {
    type: result.type || 'text',
    content,
  };
}

function normalizeV2InferenceStatus(rawStatus) {
  if (!rawStatus || typeof rawStatus !== 'string') return 'unknown';

  const status = rawStatus.trim().toLowerCase();
  switch (status) {
    case 'completed':
    case 'success':
    case 'done':
    case 'finished':
      return 'completed';
    case 'failed':
    case 'error':
    case 'errored':
      return 'failed';
    case 'running':
    case 'processing':
    case 'in_progress':
      return 'running';
    case 'queued':
    case 'pending':
    case 'waiting':
      return 'queued';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return status;
  }
}

function normalizeV2ProviderUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') {
    return null;
  }

  const usage = {};
  const promptTokens = Number(rawUsage.prompt_tokens || rawUsage.input_tokens || 0);
  const completionTokens = Number(rawUsage.completion_tokens || rawUsage.output_tokens || 0);
  if (Number.isFinite(promptTokens) && promptTokens > 0) usage.prompt_tokens = promptTokens;
  if (Number.isFinite(completionTokens) && completionTokens > 0) usage.completion_tokens = completionTokens;
  if (usage.prompt_tokens || usage.completion_tokens) {
    usage.total_tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  }

  return Object.keys(usage).length > 0 ? usage : null;
}

// ---------------------------------------------------------------------------
// Task helpers
// ---------------------------------------------------------------------------

function getV2TaskRouteMetadata(task = {}) {
  const metadata = {};
  if (task.provider) metadata.provider = task.provider;
  if (task.model) metadata.model = task.model;
  if (task.host_name) metadata.host = task.host_name;
  return metadata;
}

function safeParseTaskStorageValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return { raw: value };
    }
  }
  return { raw: value };
}

function buildV2TaskPayload(task, requestId, statusOverride = null) {
  const status = normalizeV2InferenceStatus(statusOverride || task.status);
  const result = formatV2InferenceResult(
    task.output || task.result || task.error_output,
  );
  const metadata = safeParseTaskStorageValue(task.metadata);
  const usage = normalizeV2ProviderUsage(metadata?.usage);
  const route = getV2TaskRouteMetadata(task);

  return {
    task_id: task.id,
    request_id: requestId,
    status,
    provider: route.provider || null,
    model: route.model || null,
    result: status === 'completed' ? result : null,
    error: status === 'failed' ? (task.error_output || null) : null,
    usage,
    created_at: task.created_at || null,
    updated_at: task.updated_at || null,
  };
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
};
const dashboardPort = serverConfig.getInt('dashboard_port', 3456);
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${dashboardPort}`,
  `http://localhost:${dashboardPort}`,
]);

function sendV2SseHeaders(res, req = null) {
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...SECURITY_HEADERS,
  };

  if (req) {
    const origin = req.headers?.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
  }

  res.writeHead(200, headers);
}

function sendV2SseEvent(res, eventName, eventData) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(eventData)}\n\n`);
}

// ---------------------------------------------------------------------------
// Task resolution helpers
// ---------------------------------------------------------------------------

function resolveV2Task(taskId) {
  try {
    const task = getTask(taskId);
    if (task) {
      return task;
    }
  } catch {
    // Fall through
  }
  return null;
}

function getV2TaskStatusRow(taskId) {
  return resolveV2Task(taskId);
}

function recordV2TaskEvent(taskId, eventType, oldValue, newValue, eventData = {}) {
  try {
    recordTaskEvent(taskId, eventType, oldValue, newValue, eventData);
  } catch {
    // Event recording should not fail the request path.
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function collectValidationError(errors, field, code, message) {
  errors.push({ field, code, message });
}

function getV2PromptMessages(payload) {
  return payload?.messages || payload?.prompt;
}

function validateV2PromptMessages(payload, errors) {
  const messages = getV2PromptMessages(payload);

  if (messages === undefined || messages === null) {
    collectValidationError(errors, 'messages', 'required', 'messages or prompt is required');
    return;
  }

  if (typeof messages === 'string') {
    if (!messages.trim()) {
      collectValidationError(errors, 'messages', 'empty', 'prompt must not be empty');
    }
    return;
  }

  if (!Array.isArray(messages)) {
    collectValidationError(errors, 'messages', 'type', 'messages must be an array of {role, content} objects');
    return;
  }

  if (messages.length === 0) {
    collectValidationError(errors, 'messages', 'empty', 'messages array must not be empty');
    return;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') {
      collectValidationError(errors, `messages[${i}]`, 'type', 'each message must be an object with role and content');
    }
  }
}

function validateV2StringField(payload, field, errors, maxLength = 255) {
  const value = payload?.[field];
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    collectValidationError(errors, field, 'type', `${field} must be a string`);
    return;
  }
  if (value.length > maxLength) {
    collectValidationError(errors, field, 'length', `${field} must be at most ${maxLength} characters`);
  }
}

function validateV2BooleanField(payload, field, errors) {
  const value = payload?.[field];
  if (value === undefined || value === null) return;
  if (typeof value !== 'boolean') {
    collectValidationError(errors, field, 'type', `${field} must be a boolean`);
  }
}

function validateV2TimeoutMs(payload, errors) {
  const value = payload?.timeout_ms;
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    collectValidationError(errors, 'timeout_ms', 'type', 'timeout_ms must be a number');
    return;
  }
  if (value < 0) {
    collectValidationError(errors, 'timeout_ms', 'range', 'timeout_ms must be non-negative');
  }
}

function getV2DefaultProviderForRequest(payload) {
  if (payload?.provider) return payload.provider;
  try {
    return getDefaultProvider();
  } catch {
    return null;
  }
}

function validateV2Transport(payload, errors) {
  const value = payload?.transport;
  if (value === undefined || value === null) return;
  const normalized = normalizeV2Transport(value);
  if (!normalized) {
    collectValidationError(errors, 'transport', 'invalid', `Invalid transport: ${value}`);
  }
}

// ---------------------------------------------------------------------------
// Attempt helpers
// ---------------------------------------------------------------------------

function getAttemptElapsedMs(startAt, endAt) {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  const elapsed = end - start;
  return elapsed >= 0 ? elapsed : 0;
}

function normalizeV2AttemptMetadata(attempts) {
  return (Array.isArray(attempts) ? attempts : [])
    .map((attempt, index) => ({
      attempt_number: index + 1,
      provider: attempt?.provider || null,
      model: attempt?.model || null,
      status: normalizeV2InferenceStatus(attempt?.status || 'unknown'),
      started_at: attempt?.started_at || null,
      ended_at: attempt?.ended_at || null,
      elapsed_ms: getAttemptElapsedMs(attempt?.started_at, attempt?.ended_at),
      error: attempt?.error || null,
    }));
}

function getV2RetryCount(attempts) {
  const normalized = normalizeV2AttemptMetadata(attempts);
  return Math.max(0, normalized.length - 1);
}

// ---------------------------------------------------------------------------
// Inference payload validation
// ---------------------------------------------------------------------------

function validateV2InferencePayload(payload) {
  const errors = [];
  const normalizedPayload = payload || {};

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    collectValidationError(errors, 'body', 'type', 'Request body must be an object');
    return { valid: false, errors, payload: normalizedPayload };
  }

  validateV2PromptMessages(payload, errors);
  validateV2StringField(payload, 'provider', errors, 64);
  validateV2StringField(payload, 'model', errors, 255);
  validateV2BooleanField(payload, 'stream', errors);
  validateV2BooleanField(payload, 'async', errors);
  validateV2Transport(payload, errors);
  validateV2TimeoutMs(payload, errors);

  if (errors.length) {
    return {
      valid: false,
      errors,
      payload: normalizedPayload,
    };
  }

  const resolvedProvider = getV2DefaultProviderForRequest(payload);
  if (!resolvedProvider) {
    collectValidationError(errors, 'provider', 'missing', 'A provider is required or default provider must be configured');
    return { valid: false, errors, payload: normalizedPayload };
  }

  return {
    valid: true,
    errors,
    payload: normalizedPayload,
    provider: resolvedProvider,
    transport: normalizeV2Transport(payload.transport),
  };
}

// ---------------------------------------------------------------------------
// v2-inference module initialization
// ---------------------------------------------------------------------------

v2Inference.init({
  db,
  logger,
  getProviderAdapter: require('../providers/adapter-registry').getProviderAdapter,
  normalizeV2Transport,
  getV2ProviderTransport,
  getV2ProviderDefaultTimeoutMs,
  normalizeMessageContent,
  formatV2InferenceResult,
  normalizeV2InferenceStatus,
  normalizeV2ProviderUsage,
  normalizeV2AttemptMetadata,
  getV2RetryCount,
  getAttemptElapsedMs,
  getV2ProviderAdapterCapabilities,
  sendV2SseHeaders,
  sendV2SseEvent,
  getV2TaskStatusRow,
  recordV2TaskEvent,
  sendV2Success,
  sendV2Error,
});

const { executeV2ProviderInference } = v2Inference;

// Module-level taskManager reference for v2 inference cancel handler.
// Set by initTaskManager() when a taskManager is provided.
let _v2TaskManager = null;

function initTaskManager(tm) {
  _v2TaskManager = tm;
}

// ---------------------------------------------------------------------------
// Task handlers
// ---------------------------------------------------------------------------

async function handleV2TaskStatus(_req, res, context = {}, taskId = null, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const resolvedTaskId = req?.params?.task_id || taskId;
  const taskRow = getV2TaskStatusRow(resolvedTaskId);

  if (!taskRow) {
    sendV2Error(
      res,
      requestId,
      'task_not_found',
      `Task not found: ${resolvedTaskId}`,
      404,
      {},
      req,
    );
    return;
  }

  sendV2Success(res, requestId, buildV2TaskPayload(taskRow, requestId), 200, req);
}

async function handleV2TaskCancel(_req, res, context = {}, taskId = null, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const resolvedTaskId = req?.params?.task_id || taskId;
  const taskRow = getV2TaskStatusRow(resolvedTaskId);

  if (!taskRow) {
    sendV2Error(
      res,
      requestId,
      'task_not_found',
      `Task not found: ${resolvedTaskId}`,
      404,
      {},
      req,
    );
    return;
  }

  if (taskRow.status === 'completed' || taskRow.status === 'failed' || taskRow.status === 'cancelled') {
    sendV2Error(
      res,
      requestId,
      'task_already_terminal',
      `Task is already in terminal state: ${taskRow.status}`,
      409,
      {
        task_id: taskRow.id,
        status: normalizeV2InferenceStatus(taskRow.status),
      },
      req,
    );
    return;
  }

  try {
    if (_v2TaskManager) {
      _v2TaskManager.cancelTask(taskRow.id, 'Task cancelled by request');
    } else {
      updateTaskStatus(taskRow.id, 'cancelled', {
        error_output: 'Task cancelled by request',
      });
    }
    recordV2TaskEvent(taskRow.id, 'status', taskRow.status, 'cancelled', {
      request_id: requestId,
    });
  } catch (err) {
    sendV2Error(
      res,
      requestId,
      'cancellation_failed',
      err.message || 'Failed to cancel task',
      500,
      {},
      req,
    );
    return;
  }

  const cancelledRow = getV2TaskStatusRow(resolvedTaskId);
  sendV2Success(
    res,
    requestId,
    {
      task_id: taskRow.id,
      status: normalizeV2InferenceStatus(cancelledRow?.status || 'cancelled'),
      provider: taskRow.provider,
      model: taskRow.model,
      cancelled: true,
    },
    200,
    req,
  );
}

async function handleV2TaskEvents(_req, res, context = {}, taskId = null, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const resolvedTaskId = req?.params?.task_id || taskId;
  const taskRow = getV2TaskStatusRow(resolvedTaskId);

  if (!taskRow) {
    sendV2Error(
      res,
      requestId,
      'task_not_found',
      `Task not found: ${resolvedTaskId}`,
      404,
      {},
      req,
    );
    return;
  }

  sendV2SseHeaders(res, req);

  try {
    const taskEvents = getTaskEvents(taskRow.id, { limit: 100 }) || [];
    const rows = Array.isArray(taskEvents) ? taskEvents : [];
    const latestTaskPayload = buildV2TaskPayload(taskRow, requestId);
    const terminalStates = new Set(['completed', 'failed', 'cancelled']);

    if (rows.length === 0) {
      sendV2SseEvent(res, 'status', {
        request_id: requestId,
        status: latestTaskPayload.status || 'queued',
      });
      return;
    }

    for (const eventRow of rows.slice().reverse()) {
      const eventData = safeParseTaskStorageValue(eventRow.event_data);
      const targetStatus = normalizeV2InferenceStatus(eventRow.new_value || eventRow.old_value || taskRow.status);

      if (terminalStates.has(targetStatus)) {
        if (targetStatus === 'completed') {
          sendV2SseEvent(res, 'completion', {
            request_id: requestId,
            status: targetStatus,
            result: latestTaskPayload.result,
            usage: latestTaskPayload.usage,
          });
        } else {
          sendV2SseEvent(res, 'error', {
            request_id: requestId,
            error: {
              code: 'provider_unavailable',
              message: eventData?.error || taskRow.error_output || 'Async inference failed',
              details: eventData || {},
            },
          });
        }
        break;
      }

      sendV2SseEvent(res, 'status', {
        request_id: requestId,
        status: targetStatus,
      });
    }
  } finally {
    res.end();
  }
}

async function handleTaskStream(_req, res, _context = {}, taskId = null, req = null) {
  const resolvedTaskId = req?.params?.task_id || taskId;
  const taskRow = getV2TaskStatusRow(resolvedTaskId);

  if (!taskRow) {
    sendJson(res, { error: 'Task not found' }, 404, req || _req);
    return;
  }

  if (!taskRow.provider) {
    sendJson(res, { error: 'Task has no assigned provider' }, 409, req || _req);
    return;
  }

  const { defaultContainer } = require('../container');
  const providerRegistry = defaultContainer?.get?.('providerRegistry') || require('../providers/registry');
  const provider = providerRegistry?.getProviderInstance?.(taskRow.provider);

  if (!provider) {
    sendJson(res, { error: `Provider unavailable: ${taskRow.provider}` }, 503, req || _req);
    return;
  }

  const { streamRun } = require('../streaming/stream-run');
  const { streamToSse } = require('../streaming/sse-adapter');
  const { buildToolSurface, createTaskCallProvider } = require('../streaming/task-stream');

  const abortController = new AbortController();
  const onClose = () => abortController.abort();

  req?.on?.('close', onClose);
  _req?.on?.('close', onClose);

  try {
    await streamToSse(
      streamRun({
        prompt: taskRow.task_description,
        tools: buildToolSurface(taskRow),
        callProvider: createTaskCallProvider(taskRow, provider, {
          signal: abortController.signal,
        }),
      }),
      res,
    );
  } finally {
    req?.off?.('close', onClose);
    _req?.off?.('close', onClose);
  }
}

// ---------------------------------------------------------------------------
// Inference handlers
// ---------------------------------------------------------------------------

async function handleV2Inference(_req, res, context = {}, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  try {
    const validatedPayload = req?.validated?.body;
    const payload = validatedPayload || await parseBody(_req);
    const validation = validatedPayload
      ? { valid: true, payload: validatedPayload, provider: validatedPayload.provider }
      : validateV2InferencePayload(payload);

    if (!validation.valid) {
      sendV2Error(
        res,
        requestId,
        'validation_error',
        'Request validation failed',
        400,
        { errors: validation.errors },
        req,
      );
      return;
    }

    const providerId = validation.provider;
    const provider = providerId ? getProvider?.(providerId) : null;
    if (!provider) {
      sendV2Error(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${providerId}`,
        404,
        { provider: providerId },
        req,
      );
      return;
    }

    await executeV2ProviderInference({
      requestId,
      payload: validation.payload,
      providerId,
      req,
      res,
    });
  } catch (err) {
    if (err?.message === 'Invalid JSON' || err?.message === 'Request body too large') {
      sendV2Error(
        res,
        requestId,
        'validation_error',
        err.message,
        400,
        { context: 'request_body' },
        req,
      );
      return;
    }
    sendV2Error(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_inference' },
      req,
    );
  }
}

async function handleV2ProviderInference(_req, res, context = {}, providerId, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const decodedProviderId = req?.params?.provider_id || decodeURIComponent(providerId || '');

  try {
    const validatedPayload = req?.validated?.body;
    const payload = validatedPayload || await parseBody(_req);
    const payloadForValidation = validatedPayload
      ? null
      : {
        ...payload,
        provider: payload?.provider || decodedProviderId,
      };
    const validation = validatedPayload
      ? {
        valid: true,
        payload: {
          ...validatedPayload,
          provider: decodedProviderId,
        },
      }
      : validateV2InferencePayload(payloadForValidation);
    if (!validation.valid) {
      sendV2Error(
        res,
        requestId,
        'validation_error',
        'Request validation failed',
        400,
        { errors: validation.errors },
        req,
      );
      return;
    }

    const provider = getProvider?.(decodedProviderId);
    if (!provider) {
      sendV2Error(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${decodedProviderId}`,
        404,
        { provider: decodedProviderId },
        req,
      );
      return;
    }

    await executeV2ProviderInference({
      requestId,
      payload: validation.payload,
      providerId: decodedProviderId,
      req,
      res,
    });
  } catch (err) {
    if (err?.message === 'Invalid JSON' || err?.message === 'Request body too large') {
      sendV2Error(
        res,
        requestId,
        'validation_error',
        err.message,
        400,
        { context: 'request_body' },
        req,
      );
      return;
    }
    sendV2Error(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_inference' },
      req,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider discovery handlers
// ---------------------------------------------------------------------------

async function handleV2ProviderModels(_req, res, context = {}, providerId, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const decodedProviderId = req?.params?.provider_id || decodeV2ProviderIdOrSendError(
    providerId,
    requestId,
    res,
    req,
    'provider_models',
  );
  if (!decodedProviderId) {
    return;
  }

  try {
    const provider = getProvider?.(decodedProviderId);
    if (!provider) {
      sendV2DiscoveryError(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${decodedProviderId}`,
        404,
        { provider_id: decodedProviderId },
        req,
      );
      return;
    }

    const modelsDescriptor = await getV2ProviderModels(decodedProviderId);
    const responsePayload = {
      provider_id: decodedProviderId,
      models: modelsDescriptor.models,
      refreshed_at: modelsDescriptor.refreshed_at,
    };

    sendV2DiscoverySuccess(
      res,
      requestId,
      responsePayload,
      200,
      req,
      {
        provider_id: decodedProviderId,
        models: modelsDescriptor.models.map((model) => model.id),
        source: modelsDescriptor.source,
        freshness: modelsDescriptor.refreshed_at ? { checked_at: modelsDescriptor.refreshed_at } : null,
        model_count: modelsDescriptor.models.length,
      },
    );
  } catch (err) {
    sendV2DiscoveryError(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_models', provider_id: decodedProviderId },
      req,
    );
  }
}

async function handleV2ProviderHealth(_req, res, context = {}, providerId, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const decodedProviderId = req?.params?.provider_id || decodeV2ProviderIdOrSendError(
    providerId,
    requestId,
    res,
    req,
    'provider_health',
  );
  if (!decodedProviderId) {
    return;
  }

  try {
    const provider = getProvider?.(decodedProviderId);
    if (!provider) {
      sendV2DiscoveryError(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${decodedProviderId}`,
        404,
        { provider_id: decodedProviderId },
        req,
      );
      return;
    }

    const healthPayload = await getV2ProviderHealthPayload(provider, decodedProviderId);
    const responsePayload = {
      provider_id: decodedProviderId,
      ...healthPayload,
    };

    sendV2DiscoverySuccess(
      res,
      requestId,
      responsePayload,
      200,
      req,
      responsePayload,
    );
  } catch (err) {
    sendV2DiscoveryError(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_health', provider_id: decodedProviderId },
      req,
    );
  }
}

async function handleV2ListProviders(_req, res, context = {}, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  try {
    const providers = Array.isArray(listProviders?.()) ? listProviders() : [];
    const defaultProviderId = getV2ProviderDefaultProvider();
    const descriptors = providers.map(provider => buildV2ProviderDescriptor(provider, defaultProviderId)).filter(Boolean);

    sendV2DiscoverySuccess(
      res,
      requestId,
      { providers: descriptors },
      200,
      req,
      { providers: descriptors },
    );
  } catch (err) {
    sendV2DiscoveryError(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_catalog' },
      req,
    );
  }
}

function handleV2ProviderCapabilities(_req, res, context = {}, providerId, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const decodedProviderId = req?.params?.provider_id || decodeV2ProviderIdOrSendError(
    providerId,
    requestId,
    res,
    req,
    'provider_capabilities',
  );
  if (!decodedProviderId) {
    return;
  }

  try {
    const provider = getProvider?.(decodedProviderId);
    if (!provider) {
      sendV2DiscoveryError(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${decodedProviderId}`,
        404,
        { provider_id: decodedProviderId },
        req,
      );
      return;
    }

    const capabilities = buildV2ProviderCapabilities(decodedProviderId);
    sendV2DiscoverySuccess(
      res,
      requestId,
      {
        provider_id: decodedProviderId,
        capabilities,
      },
      200,
      req,
      {
        provider_id: decodedProviderId,
        capabilities,
      },
    );
  } catch (err) {
    sendV2DiscoveryError(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_capabilities' },
      req,
    );
  }
}

function handleV2ProviderDetail(_req, res, context = {}, providerId, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const decodedProviderId = req?.params?.provider_id || decodeV2ProviderIdOrSendError(
    providerId,
    requestId,
    res,
    req,
    'provider_detail',
  );
  if (!decodedProviderId) {
    return;
  }

  try {
    const provider = getProvider?.(decodedProviderId);
    if (!provider) {
      sendV2DiscoveryError(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${decodedProviderId}`,
        404,
        { provider_id: decodedProviderId },
        req,
      );
      return;
    }

    const defaultProviderId = getV2ProviderDefaultProvider();
    const descriptor = buildV2ProviderDescriptor(provider, defaultProviderId, {
      includeCapabilities: true,
    });
    sendV2DiscoverySuccess(
      res,
      requestId,
      { provider: descriptor || {} },
      200,
      req,
      descriptor || {},
    );
  } catch (err) {
    sendV2DiscoveryError(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_detail' },
      req,
    );
  }
}

// ---------------------------------------------------------------------------
// Remote execution handlers
// ---------------------------------------------------------------------------

async function handleV2RemoteRun(req, res, _context = {}) {
  return getRemoteAgentPluginHandlers().run_remote_command(req, res);
}

async function handleV2RemoteTest(req, res, _context = {}) {
  return getRemoteAgentPluginHandlers().run_tests(req, res);
}

module.exports = {
  // Inference helpers (needed by v2-inference init and other consumers)
  normalizeMessageContent,
  formatV2InferenceResult,
  normalizeV2InferenceStatus,
  normalizeV2ProviderUsage,
  getV2TaskRouteMetadata,
  safeParseTaskStorageValue,
  buildV2TaskPayload,
  sendV2SseHeaders,
  sendV2SseEvent,
  resolveV2Task,
  getV2TaskStatusRow,
  recordV2TaskEvent,
  collectValidationError,
  getV2PromptMessages,
  validateV2PromptMessages,
  validateV2StringField,
  validateV2BooleanField,
  validateV2TimeoutMs,
  getV2DefaultProviderForRequest,
  validateV2Transport,
  getAttemptElapsedMs,
  normalizeV2AttemptMetadata,
  getV2RetryCount,
  validateV2InferencePayload,
  // Task manager
  initTaskManager,
  // Handlers
  handleV2TaskStatus,
  handleV2TaskCancel,
  handleV2TaskEvents,
  handleTaskStream,
  handleV2Inference,
  handleV2ProviderInference,
  handleV2ProviderModels,
  handleV2ProviderHealth,
  handleV2ListProviders,
  handleV2ProviderCapabilities,
  handleV2ProviderDetail,
  handleV2RemoteRun,
  handleV2RemoteTest,
};
