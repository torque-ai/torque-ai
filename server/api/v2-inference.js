'use strict';

/**
 * api/v2-inference.js — V2 provider inference execution engine.
 *
 * Extracted from api-server.core.js (Phase 4: Big File Decomposition).
 * Contains the sync/stream/async inference pipeline and all supporting helpers.
 */

const { randomUUID } = require('crypto');

// Dependencies injected via init()
let db, logger, getProviderAdapter;
let normalizeV2Transport, getV2ProviderTransport, getV2ProviderDefaultTimeoutMs;
let normalizeMessageContent, formatV2InferenceResult, normalizeV2InferenceStatus;
let normalizeV2ProviderUsage, normalizeV2AttemptMetadata, getV2RetryCount;
let getAttemptElapsedMs, getV2ProviderAdapterCapabilities;
let sendV2SseHeaders, sendV2SseEvent;
let getV2TaskStatusRow, recordV2TaskEvent;
let sendV2Success, sendV2Error;

function init(deps) {
  db = deps.db;
  logger = deps.logger;
  getProviderAdapter = deps.getProviderAdapter;
  normalizeV2Transport = deps.normalizeV2Transport;
  getV2ProviderTransport = deps.getV2ProviderTransport;
  getV2ProviderDefaultTimeoutMs = deps.getV2ProviderDefaultTimeoutMs;
  normalizeMessageContent = deps.normalizeMessageContent;
  formatV2InferenceResult = deps.formatV2InferenceResult;
  normalizeV2InferenceStatus = deps.normalizeV2InferenceStatus;
  normalizeV2ProviderUsage = deps.normalizeV2ProviderUsage;
  normalizeV2AttemptMetadata = deps.normalizeV2AttemptMetadata;
  getV2RetryCount = deps.getV2RetryCount;
  getAttemptElapsedMs = deps.getAttemptElapsedMs;
  getV2ProviderAdapterCapabilities = deps.getV2ProviderAdapterCapabilities;
  sendV2SseHeaders = deps.sendV2SseHeaders;
  sendV2SseEvent = deps.sendV2SseEvent;
  getV2TaskStatusRow = deps.getV2TaskStatusRow;
  recordV2TaskEvent = deps.recordV2TaskEvent;
  sendV2Success = deps.sendV2Success;
  sendV2Error = deps.sendV2Error;
}

function getV2AttemptProvider(providerId, transport) {
  if (providerId === 'claude-cli' && transport === 'api') {
    return 'anthropic';
  }
  return providerId;
}

function buildV2InferencePrompt(payload) {
  if (Object.prototype.hasOwnProperty.call(payload, 'prompt')) {
    return typeof payload.prompt === 'string' ? payload.prompt : '';
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const role = typeof message.role === 'string' ? message.role.trim() : '';
      const content = normalizeMessageContent(message.content);
      if (!role || !content) return null;
      return `${role}: ${content}`;
    })
    .filter(Boolean)
    .join('\n');
}

function buildV2InferencePayload({
  providerId,
  model,
  taskResult,
  status,
  taskId = null,
  routeReason = null,
  transport = null,
  attempts = [],
}) {
  const rawResult = taskResult ?? {};
  const providerOutput = rawResult.output ?? rawResult.result ?? rawResult.text ?? '';
  const usage = normalizeV2ProviderUsage(rawResult.usage);
  const normalizedAttempts = normalizeV2AttemptMetadata(attempts);
  const normalizedStatus = normalizeV2InferenceStatus(status || rawResult.status);

  return {
    task_id: taskId,
    status: normalizedStatus,
    provider: providerId,
    model: rawResult.model || model || null,
    result: formatV2InferenceResult(providerOutput),
    usage,
    raw: rawResult,
    transport,
    route_reason: routeReason,
    attempts: normalizedAttempts,
    retry_count: getV2RetryCount(normalizedAttempts),
  };
}

function buildV2AsyncTaskResponse({
  taskId,
  providerId,
  model,
  requestId,
  transport = null,
  routeReason = null,
  attempts = [],
}) {
  return {
    task_id: taskId,
    status: 'queued',
    provider: providerId,
    model: model || null,
    polling_url: `/api/v2/tasks/${taskId}`,
    result: {
      type: 'text',
      content: '',
      meta: {},
    },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      elapsed_ms: 0,
    },
    raw: {},
    transport,
    route_reason: routeReason,
    attempts: normalizeV2AttemptMetadata(attempts),
    retry_count: getV2RetryCount(attempts),
    request_id: requestId,
  };
}

function normalizeV2RouteAttempts(attempts) {
  return (Array.isArray(attempts) ? attempts : [])
    .map((attempt, index) => ({
      provider: attempt?.provider || null,
      transport: normalizeV2Transport(attempt?.transport) || null,
      reason: attempt?.reason || null,
      status: attempt?.status || 'not_attempted',
      index,
    }))
    .filter((attempt) => attempt.provider && attempt.transport);
}

function buildV2ExecutionPlan({
  providerId,
  requestedTransport,
  providerConfig,
}) {
  const transport = normalizeV2Transport(requestedTransport) || getV2ProviderTransport(providerConfig);

  if (providerId === 'claude-cli') {
    return [{
      provider: getV2AttemptProvider(providerId, transport),
      transport,
      reason: requestedTransport ? `request_transport_${transport}` : `provider_transport_${transport}`,
      status: 'pending',
    }];
  }

  const providerFamily = providerId === 'codex' ? 'codex' : providerId;

  if (providerFamily !== 'codex') {
    return [{
      provider: providerId,
      transport,
      reason: providerId === 'claude-cli' ? 'provider_requested' : 'provider_route',
      status: 'pending',
    }];
  }

  const useClaudePrimary = providerId === 'claude-cli';
  const primaryProvider = useClaudePrimary ? 'claude-cli' : 'codex';

  if (transport === 'cli') {
    return [
      {
        provider: getV2AttemptProvider(primaryProvider, 'cli'),
        transport: 'cli',
        reason: requestedTransport ? 'request_transport_cli' : 'provider_transport_cli',
        status: 'pending',
      },
      {
        provider: 'codex',
        transport: 'api',
        reason: 'fallback_cli_to_api',
        status: 'pending',
      },
    ];
  }

  return [
    {
      provider: 'codex',
      transport: 'api',
      reason: requestedTransport ? 'request_transport_api' : 'provider_transport_api',
      status: 'pending',
    },
    {
      provider: getV2AttemptProvider(primaryProvider, 'cli'),
      transport: 'cli',
      reason: 'fallback_api_to_cli',
      status: 'pending',
    },
  ];
}

function recordV2AttemptUsage({
  taskId = null,
  attempt,
  attemptIndex = 0,
  taskResult,
}) {
  const normalizedAttempt = normalizeV2AttemptMetadata([attempt])[0];
  if (!normalizedAttempt || !normalizedAttempt.provider) {
    return;
  }

  const usage = normalizeV2ProviderUsage(taskResult?.usage || {});
  const usageHasPayload = taskResult && taskResult.usage && typeof taskResult.usage === 'object';
  const elapsedMs = Number.isFinite(Number(normalizedAttempt.attempt_elapsed_ms))
    ? Number(normalizedAttempt.attempt_elapsed_ms)
    : null;
  const retryCount = Number.isFinite(Number(attemptIndex)) ? Number(attemptIndex) : null;
  const success = normalizedAttempt.status === 'succeeded';
  const reason = success ? null : normalizedAttempt.failure_reason || null;
  const estimatedCost = taskResult?.usage
    ? Number(
      taskResult.usage.estimated_cost_usd ??
      taskResult.usage.cost ??
      taskResult.usage.cost_usd ??
      taskResult.usage.costEstimate ??
      null
    )
    : null;
  const costEstimate = Number.isFinite(estimatedCost) ? estimatedCost : null;

  try {
    db.recordProviderUsage(normalizedAttempt.provider, taskId, {
      tokens_used: usageHasPayload ? usage.total_tokens : null,
      cost_estimate: costEstimate,
      duration_seconds: elapsedMs !== null ? elapsedMs / 1000 : null,
      elapsed_ms: elapsedMs,
      transport: normalizedAttempt.transport,
      retry_count: retryCount,
      failure_reason: reason,
      success,
      error_type: reason,
    });
  } catch (_err) {
    logger.warn(`Failed to record v2 provider usage telemetry: ${_err.message || _err}`);
  }
}

function deriveV2AttemptFailureReason(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (!message) {
    return 'provider_unavailable';
  }

  if (message.includes('stream') && message.includes('supported')) {
    return 'stream_unsupported';
  }
  if (message.includes('timeout')) {
    return 'timeout';
  }
  if (message.includes('auth') || message.includes('token') || message.includes('credential')) {
    return 'auth_required';
  }
  if (message.includes('model') && message.includes('not found')) {
    return 'model_not_found';
  }
  if (message.includes('rate limit') || message.includes('rate_limit')) {
    return 'provider_unavailable';
  }
  return 'provider_unavailable';
}

function buildV2FailurePayload({
  requestId,
  transport,
  routeReason,
  attempts,
}) {
  const normalizedAttempts = normalizeV2AttemptMetadata(attempts);
  return {
    transport: transport || null,
    route_reason: routeReason || null,
    attempts: normalizedAttempts,
    retry_count: getV2RetryCount(normalizedAttempts),
    request_id: requestId,
  };
}

function buildV2InferenceTaskOptions(payload, providerId) {
  const timeoutMinutes = Object.prototype.hasOwnProperty.call(payload, 'timeout_ms')
    ? Number(payload.timeout_ms) / 60000
    : getV2ProviderDefaultTimeoutMs(providerId) / 60000;

  const options = {
    timeout: Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes : 5,
    maxTokens: Object.prototype.hasOwnProperty.call(payload, 'max_tokens')
      ? Number(payload.max_tokens)
      : undefined,
    tuning: {},
  };

  if (Object.prototype.hasOwnProperty.call(payload, 'temperature')) {
    options.tuning.temperature = payload.temperature;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'top_p')) {
    options.tuning.top_p = payload.top_p;
  }

  return options;
}

async function executeV2ProviderInference({ requestId, payload, providerId, req, res }) {
  const prompt = buildV2InferencePrompt(payload);
  const taskModel = payload.model;
  const providerConfig = db.getProvider?.(providerId);
  const requestedTransport = normalizeV2Transport(payload?.transport);
  const executionPlan = normalizeV2RouteAttempts(buildV2ExecutionPlan({
    providerId,
    requestedTransport,
    providerConfig,
  }));
  const taskOptions = buildV2InferenceTaskOptions(payload, executionPlan[0]?.provider || providerId);
  const streamMode = payload.stream === true;
  const asyncMode = payload.async === true;

  const getAttempt = (index) => executionPlan[index] || {};
  const updateAttempt = (index, patch = {}) => {
    executionPlan[index] = {
      ...(executionPlan[index] || {}),
      ...patch,
    };
  };
  const markAttemptAttempting = (index) => {
    const attemptStart = new Date().toISOString();
    updateAttempt(index, {
      status: 'attempting',
      attempt_start_at: attemptStart,
      attempt_end_at: null,
      attempt_elapsed_ms: null,
      failure_reason: null,
    });
  };
  const markAttemptFinished = (index, patch = {}) => {
    const attempt = getAttempt(index);
    const attemptEnd = new Date().toISOString();
    const attemptElapsedMs = getAttemptElapsedMs(attempt.attempt_start_at, attemptEnd);
    updateAttempt(index, {
      attempt_end_at: attemptEnd,
      attempt_elapsed_ms: attemptElapsedMs,
      ...patch,
    });
  };

  for (let attemptIndex = 0; attemptIndex < executionPlan.length; attemptIndex += 1) {
    const currentAttempt = executionPlan[attemptIndex];
    if (!currentAttempt) {
      continue;
    }

    const isLastAttempt = attemptIndex === executionPlan.length - 1;
    markAttemptAttempting(attemptIndex);
    const candidateProvider = db.getProvider?.(currentAttempt.provider);
    const candidateAdapter = currentAttempt.provider ? getProviderAdapter(currentAttempt.provider) : null;
    const candidateCapabilities = getV2ProviderAdapterCapabilities(currentAttempt.provider);
    const candidateEnabled = Boolean(candidateProvider?.enabled);

    if (!candidateProvider) {
      markAttemptFinished(attemptIndex, {
        status: 'failed',
        error: 'provider_not_found',
        failure_reason: 'provider_not_found',
      });
      recordV2AttemptUsage({
        attempt: getAttempt(attemptIndex),
        attemptIndex,
      });
      if (isLastAttempt) {
        sendV2Error(
          res,
          requestId,
          'provider_unavailable',
          `Provider not found: ${currentAttempt.provider}`,
          503,
          buildV2FailurePayload({
            requestId,
            transport: currentAttempt.transport,
            routeReason: currentAttempt.reason,
            attempts: executionPlan,
          }),
          req,
        );
        return;
      }
      continue;
    }

    if (!candidateEnabled) {
      markAttemptFinished(attemptIndex, {
        status: 'failed',
        error: 'provider_disabled',
        failure_reason: 'provider_disabled',
      });
      recordV2AttemptUsage({
        attempt: getAttempt(attemptIndex),
        attemptIndex,
      });
      if (isLastAttempt) {
        sendV2Error(
          res,
          requestId,
          'provider_unavailable',
          `Provider is disabled: ${currentAttempt.provider}`,
          503,
          buildV2FailurePayload({
            requestId,
            transport: currentAttempt.transport,
            routeReason: currentAttempt.reason,
            attempts: executionPlan,
          }),
          req,
        );
        return;
      }
      continue;
    }

    if (!candidateAdapter) {
      markAttemptFinished(attemptIndex, {
        status: 'failed',
        error: 'adapter_missing',
        failure_reason: 'adapter_missing',
      });
      recordV2AttemptUsage({
        attempt: getAttempt(attemptIndex),
        attemptIndex,
      });
      if (isLastAttempt) {
        sendV2Error(
          res,
          requestId,
          'provider_unavailable',
          `Provider adapter not available: ${currentAttempt.provider}`,
          503,
          buildV2FailurePayload({
            requestId,
            transport: currentAttempt.transport,
            routeReason: currentAttempt.reason,
            attempts: executionPlan,
          }),
          req,
        );
        return;
      }
      continue;
    }

    if (streamMode && !candidateCapabilities.supportsStream) {
      markAttemptFinished(attemptIndex, {
        status: 'failed',
        error: 'stream_unsupported',
        failure_reason: 'stream_unsupported',
      });
      recordV2AttemptUsage({
        attempt: getAttempt(attemptIndex),
        attemptIndex,
      });
      if (isLastAttempt) {
        const failureDetails = {
          ...buildV2FailurePayload({
            requestId,
            transport: currentAttempt.transport,
            routeReason: currentAttempt.reason,
            attempts: executionPlan,
          }),
          provider: currentAttempt.provider,
        };
        sendV2Error(
          res,
          requestId,
          'stream_not_supported',
          `Streaming is not supported for provider: ${currentAttempt.provider}`,
          400,
          failureDetails,
          req,
        );
        return;
      }
      continue;
    }

    if (asyncMode && !candidateCapabilities.supportsAsync) {
      markAttemptFinished(attemptIndex, {
        status: 'failed',
        error: 'async_unsupported',
        failure_reason: 'async_unsupported',
      });
      recordV2AttemptUsage({
        attempt: getAttempt(attemptIndex),
        attemptIndex,
      });
      if (isLastAttempt) {
        const failureDetails = {
          ...buildV2FailurePayload({
            requestId,
            transport: currentAttempt.transport,
            routeReason: currentAttempt.reason,
            attempts: executionPlan,
          }),
          provider: currentAttempt.provider,
          supports_async: false,
        };
        sendV2Error(
          res,
          requestId,
          'async_not_supported',
          `Async inference is not supported for provider: ${currentAttempt.provider}`,
          400,
          failureDetails,
          req,
        );
        return;
      }
      continue;
    }

      if (streamMode) {
        try {
          const streamSequence = { next: 0 };
        sendV2SseHeaders(res, req);

        sendV2SseEvent(res, 'status', {
          request_id: requestId,
          status: 'running',
          provider: currentAttempt.provider,
          transport: currentAttempt.transport,
          route_reason: currentAttempt.reason,
        });

        const taskResult = await candidateAdapter.stream(prompt, taskModel, {
          ...taskOptions,
          transport: currentAttempt.transport,
          attemptReason: currentAttempt.reason,
          onChunk: (chunk) => {
            const sequence = ++streamSequence.next;
            sendV2SseEvent(res, 'chunk', {
              request_id: requestId,
              chunk: chunk || '',
              sequence,
              provider: currentAttempt.provider,
              transport: currentAttempt.transport,
            });
          },
        });

        markAttemptFinished(attemptIndex, {
          status: 'succeeded',
          error: null,
          failure_reason: null,
        });
        recordV2AttemptUsage({
          attempt: getAttempt(attemptIndex),
          attemptIndex,
          taskResult,
        });
        const responsePayload = buildV2InferencePayload({
          providerId: currentAttempt.provider,
          model: taskModel,
          taskResult,
          status: taskResult.status || 'completed',
          routeReason: currentAttempt.reason,
          transport: currentAttempt.transport,
          attempts: executionPlan,
        });
        sendV2SseEvent(res, 'completion', {
          request_id: requestId,
          status: responsePayload.status,
          result: responsePayload.result,
          usage: responsePayload.usage,
        });
        res.end();
        return;
      } catch (streamErr) {
        markAttemptFinished(attemptIndex, {
          status: 'failed',
          error: streamErr?.message || String(streamErr || ''),
          failure_reason: deriveV2AttemptFailureReason(streamErr),
        });
        recordV2AttemptUsage({
          attempt: getAttempt(attemptIndex),
          attemptIndex,
          taskResult: null,
        });

        if (isLastAttempt) {
          sendV2SseEvent(res, 'error', {
            request_id: requestId,
            error: {
              code: 'provider_unavailable',
              message: streamErr.message || 'Stream failed',
              details: {
                provider: currentAttempt.provider,
                transport: currentAttempt.transport,
                route_reason: currentAttempt.reason,
                attempts: executionPlan,
              },
            },
          });
          res.end();
          return;
        }
      }
      continue;
    }

    if (asyncMode) {
      const taskId = randomUUID();
      const attemptStart = new Date().toISOString();
      const initialAttemptMetadata = normalizeV2RouteAttempts(executionPlan).map((attempt, idx) => {
        const isActiveAttempt = idx === attemptIndex;
        return {
          ...attempt,
          status: isActiveAttempt ? 'attempting' : attempt.status || 'not_attempted',
          attempt_start_at: isActiveAttempt ? attemptStart : attempt.attempt_start_at || null,
          attempt_end_at: null,
          attempt_elapsed_ms: null,
          failure_reason: isActiveAttempt ? null : attempt.failure_reason || null,
        };
      });

      try {
        db.createTask({
          id: taskId,
          status: 'queued',
          task_description: prompt.slice(0, 2048),
          provider: currentAttempt.provider,
          model: taskModel || null,
          metadata: {
            request_id: requestId,
            route: 'v2-inference',
            async: true,
            transport: currentAttempt.transport || null,
            route_reason: currentAttempt.reason || null,
            attempts: initialAttemptMetadata,
          },
        });
      } catch (err) {
        markAttemptFinished(attemptIndex, {
          status: 'failed',
          error: `Failed to create async task: ${err.message}`,
          failure_reason: 'task_creation_failed',
        });
        recordV2AttemptUsage({
          attempt: getAttempt(attemptIndex),
          attemptIndex,
          taskResult: null,
        });
        sendV2Error(
          res,
          requestId,
          'provider_unavailable',
          `Failed to create async inference task: ${err.message}`,
          500,
          {
            provider: currentAttempt.provider,
            transport: currentAttempt.transport,
            route_reason: currentAttempt.reason,
            attempts: executionPlan,
          },
          req,
        );
        return;
      }

      recordV2TaskEvent(taskId, 'status', null, 'queued', {
        request_id: requestId,
        provider: currentAttempt.provider,
        model: taskModel || null,
        transport: currentAttempt.transport,
        route_reason: currentAttempt.reason,
      });

      setImmediate(() => {
        runV2AsyncTask({
          taskId,
          requestId,
          providerId: currentAttempt.provider,
          prompt,
          model: taskModel,
          taskOptions,
          executionPlan: initialAttemptMetadata,
          requestedTransport: requestedTransport || null,
        }).catch((asyncErr) => {
          logger.error(`Async v2 inference task ${taskId} failed: ${asyncErr.message}`);
        });
      });

      sendV2Success(
        res,
        requestId,
        buildV2AsyncTaskResponse({
          taskId,
          providerId: currentAttempt.provider,
          model: taskModel,
          requestId,
          transport: currentAttempt.transport,
          routeReason: currentAttempt.reason,
          attempts: initialAttemptMetadata,
        }),
        202,
        req,
      );
      return;
    }

    try {
      const taskResult = await candidateAdapter.submit(prompt, taskModel, {
        ...taskOptions,
        transport: currentAttempt.transport,
        attemptReason: currentAttempt.reason,
      });
      if (normalizeV2InferenceStatus(taskResult?.status || 'completed') === 'completed') {
        markAttemptFinished(attemptIndex, {
          status: 'succeeded',
          error: null,
          failure_reason: null,
        });
        recordV2AttemptUsage({
          attempt: getAttempt(attemptIndex),
          attemptIndex,
          taskResult,
        });
        const responsePayload = buildV2InferencePayload({
          providerId: currentAttempt.provider,
          model: taskModel,
          taskResult,
          status: taskResult.status || 'completed',
          routeReason: currentAttempt.reason,
          transport: currentAttempt.transport,
          attempts: executionPlan,
        });
        sendV2Success(res, requestId, responsePayload, 200, req);
        return;
      }

      markAttemptFinished(attemptIndex, {
        status: 'failed',
        error: taskResult?.error || 'Inference failed',
        failure_reason: 'provider_result_error',
      });
      recordV2AttemptUsage({
        attempt: getAttempt(attemptIndex),
        attemptIndex,
        taskResult,
      });
      if (!isLastAttempt) {
        continue;
      }

      sendV2Error(
        res,
        requestId,
        'provider_unavailable',
        `Inference failed for provider: ${currentAttempt.provider}`,
        500,
        {
          provider: currentAttempt.provider,
          transport: currentAttempt.transport,
          route_reason: currentAttempt.reason,
          attempts: executionPlan,
        },
        req,
      );
      return;
    } catch (err) {
      const reason = deriveV2AttemptFailureReason(err);
      markAttemptFinished(attemptIndex, {
        status: 'failed',
        error: err?.message || String(err || ''),
        failure_reason: reason,
      });
      recordV2AttemptUsage({
        attempt: getAttempt(attemptIndex),
        attemptIndex,
        taskResult: null,
      });
      if (!isLastAttempt) {
        continue;
      }

      const statusCode = reason === 'stream_unsupported' ? 400 : 500;
      sendV2Error(
        res,
        requestId,
        'provider_unavailable',
        err.message,
        statusCode,
        {
          provider: currentAttempt.provider,
          transport: currentAttempt.transport,
          route_reason: currentAttempt.reason || reason,
          attempts: executionPlan,
          reason,
        },
        req,
      );
      return;
    }
  }

  sendV2Error(
    res,
    requestId,
    'provider_unavailable',
    'No provider transport succeeded',
    503,
    buildV2FailurePayload({
      requestId,
      attempts: executionPlan,
    }),
    req,
  );
}

async function runV2AsyncTask({
  taskId,
  requestId,
  providerId,
  prompt,
  model,
  taskOptions = {},
  requestedTransport = null,
  executionPlan = [],
}) {
  if (!taskId) return;

  const currentTask = getV2TaskStatusRow(taskId);
  if (!currentTask || currentTask.status !== 'queued') {
    return;
  }

  const providerConfig = db.getProvider?.(providerId);
  const sourcePlan = normalizeV2RouteAttempts(
    executionPlan.length
      ? executionPlan
      : buildV2ExecutionPlan({
        providerId,
        requestedTransport,
        providerConfig,
      }),
  );
  const plan = (sourcePlan || []).map((attempt, index) => ({
    ...attempt,
    status: attempt.status || 'not_attempted',
    attempt_start_at: typeof (executionPlan[index] || {}).attempt_start_at === 'string'
      ? executionPlan[index].attempt_start_at
      : attempt.attempt_start_at,
    attempt_end_at: typeof (executionPlan[index] || {}).attempt_end_at === 'string'
      ? executionPlan[index].attempt_end_at
      : attempt.attempt_end_at,
    attempt_elapsed_ms: executionPlan[index]?.attempt_elapsed_ms
      ?? attempt.attempt_elapsed_ms,
    failure_reason: executionPlan[index]?.failure_reason || attempt.failure_reason || null,
    error: attempt.error || executionPlan[index]?.error || null,
  }));
  const requestIdFromTask = requestId || currentTask?.metadata?.request_id || randomUUID();

  const normalizePlanOutput = () => normalizeV2AttemptMetadata(plan);
  const markAttemptAttempting = (index) => {
    const attemptStart = new Date().toISOString();
    plan[index] = {
      ...(plan[index] || {}),
      status: 'attempting',
      error: null,
      attempt_start_at: attemptStart,
      attempt_end_at: null,
      attempt_elapsed_ms: null,
      failure_reason: null,
    };
  };
  const markAttemptFinished = (index, patch = {}) => {
    const attempt = plan[index] || {};
    const attemptEnd = new Date().toISOString();
    plan[index] = {
      ...(attempt || {}),
      status: attempt.status || 'failed',
      attempt_end_at: attemptEnd,
      attempt_elapsed_ms: getAttemptElapsedMs(attempt.attempt_start_at, attemptEnd),
      ...patch,
    };
  };

  const writeTaskState = async ({
    status,
    providerOverride = null,
    output = undefined,
    errorOutput = undefined,
    attempt = null,
  }) => {
    const activeTransport = attempt?.transport || null;
    const activeReason = attempt?.reason || null;
    const overrides = {
      route: 'v2-inference',
      async: true,
      request_id: requestIdFromTask,
      transport: activeTransport,
      route_reason: activeReason,
      attempts: normalizePlanOutput(),
    };

    const updates = {
      metadata: overrides,
    };
    if (providerOverride) updates.provider = providerOverride;
    if (output !== undefined) updates.output = output;
    if (errorOutput !== undefined) updates.error_output = errorOutput;

    await db.updateTaskStatus(taskId, status, updates);
  };

  try {
    await writeTaskState({
      status: 'running',
      providerOverride: providerId,
      attempt: plan[0],
    });
    recordV2TaskEvent(taskId, 'status', 'queued', 'running', {
      request_id: requestIdFromTask,
      provider: providerId,
      model: model || null,
      transport: plan[0]?.transport || null,
      route_reason: plan[0]?.reason || null,
    });

    for (let attemptIndex = 0; attemptIndex < plan.length; attemptIndex += 1) {
      const attempt = plan[attemptIndex];
      const isLastAttempt = attemptIndex === plan.length - 1;
      if (!attempt || !attempt.provider) {
        continue;
      }

      const currentStatus = getV2TaskStatusRow(taskId);
      if (!currentStatus || currentStatus.status === 'cancelled') {
        return;
      }

      const candidateProvider = db.getProvider?.(attempt.provider);
      const candidateAdapter = getProviderAdapter(attempt.provider);
      const candidateCapabilities = getV2ProviderAdapterCapabilities(attempt.provider);
      const candidateEnabled = Boolean(candidateProvider?.enabled);

      markAttemptAttempting(attemptIndex);
      await writeTaskState({
        status: 'running',
        providerOverride: attempt.provider,
        attempt: plan[attemptIndex],
      });

      if (!candidateProvider || !candidateEnabled || !candidateAdapter || !candidateCapabilities.supportsAsync) {
        const reason = !candidateProvider
          ? 'provider_not_found'
          : !candidateEnabled
            ? 'provider_disabled'
            : !candidateAdapter
              ? 'adapter_missing'
              : 'async_unsupported';

        markAttemptFinished(attemptIndex, {
          status: 'failed',
          error: reason,
          failure_reason: reason,
        });
        recordV2AttemptUsage({
          taskId,
          attempt,
          attemptIndex,
        });
        await writeTaskState({
          status: 'running',
          providerOverride: attempt.provider,
          attempt: plan[attemptIndex],
        });

        if (!isLastAttempt) {
          continue;
        }

        await writeTaskState({
          status: 'failed',
          providerOverride: attempt.provider,
          attempt: plan[attemptIndex],
          output: { status: 'failed', error: 'Async provider unavailable' },
          errorOutput: 'Async provider unavailable',
        });
        recordV2TaskEvent(taskId, 'error', 'running', 'failed', {
          request_id: requestIdFromTask,
          provider: attempt.provider,
          transport: attempt.transport,
          route_reason: attempt.reason,
          error: reason,
        });
        return;
      }

      try {
        const result = await candidateAdapter.submit(prompt, model, {
          ...taskOptions,
          transport: attempt.transport,
          attemptReason: attempt.reason,
        });
        if (getV2TaskStatusRow(taskId)?.status === 'cancelled') {
          return;
        }

        const normalizedResult = buildV2InferencePayload({
          providerId: attempt.provider,
          model,
          taskResult: result,
          status: result.status || 'completed',
          taskId,
          routeReason: attempt.reason,
          transport: attempt.transport,
          attempts: normalizePlanOutput(),
        });
        const outputStatus = normalizeV2InferenceStatus(result.status || 'completed');

        if (outputStatus === 'completed') {
          markAttemptFinished(attemptIndex, {
            status: 'succeeded',
            error: null,
            failure_reason: null,
          });
          recordV2AttemptUsage({
            taskId,
            attempt: plan[attemptIndex],
            attemptIndex,
            taskResult: result,
          });
          await writeTaskState({
            status: 'completed',
            providerOverride: attempt.provider,
            attempt: plan[attemptIndex],
            output: normalizedResult.raw,
            errorOutput: null,
          });
          recordV2TaskEvent(taskId, 'completion', 'running', 'completed', {
            request_id: requestIdFromTask,
            provider: attempt.provider,
            transport: attempt.transport,
            route_reason: attempt.reason,
          });
          return;
        }

        markAttemptFinished(attemptIndex, {
          status: 'failed',
          error: result?.error || 'Inference failed',
          failure_reason: 'provider_result_error',
        });
        recordV2AttemptUsage({
          taskId,
          attempt: plan[attemptIndex],
          attemptIndex,
          taskResult: result,
        });
        await writeTaskState({
          status: 'running',
          providerOverride: attempt.provider,
          attempt: plan[attemptIndex],
        });

        if (!isLastAttempt) {
          continue;
        }

        await writeTaskState({
          status: 'failed',
          providerOverride: attempt.provider,
          attempt: plan[attemptIndex],
          output: normalizedResult.raw,
          errorOutput: result?.error || 'Inference failed',
        });
        recordV2TaskEvent(taskId, 'error', 'running', 'failed', {
          request_id: requestIdFromTask,
          provider: attempt.provider,
          transport: attempt.transport,
          route_reason: attempt.reason,
          error: result?.error || 'Inference failed',
        });
        return;
      } catch (err) {
        const errorMessage = err?.message || 'Async inference failed';
        if (getV2TaskStatusRow(taskId)?.status === 'cancelled') {
          return;
        }
        const reason = deriveV2AttemptFailureReason(err);

        markAttemptFinished(attemptIndex, {
          status: 'failed',
          error: errorMessage,
          failure_reason: reason,
        });
        recordV2AttemptUsage({
          taskId,
          attempt: plan[attemptIndex],
          attemptIndex,
          taskResult: null,
        });
        await writeTaskState({
          status: 'running',
          providerOverride: attempt.provider,
          attempt: plan[attemptIndex],
          output: { status: 'failed', error: errorMessage },
          errorOutput: errorMessage,
        });

        if (!isLastAttempt) {
          continue;
        }

        await writeTaskState({
          status: 'failed',
          providerOverride: attempt.provider,
          attempt: plan[attemptIndex],
          output: { status: 'failed', error: errorMessage },
          errorOutput: errorMessage,
        });
        recordV2TaskEvent(taskId, 'error', 'running', 'failed', {
          request_id: requestIdFromTask,
          provider: attempt.provider,
          transport: attempt.transport,
          route_reason: attempt.reason,
          error: errorMessage,
        });
        return;
      }
    }

    await writeTaskState({
      status: 'failed',
      providerOverride: providerId,
      attempt: plan[0],
      output: { status: 'failed', error: 'No provider transport succeeded' },
      errorOutput: 'No provider transport succeeded',
    });
    recordV2TaskEvent(taskId, 'error', 'running', 'failed', {
      request_id: requestIdFromTask,
      provider: providerId,
      route_reason: plan[0]?.reason || null,
      error: 'No provider transport succeeded',
    });
  } catch (err) {
    const current = getV2TaskStatusRow(taskId);
    if (current?.status === 'cancelled') {
      return;
    }
    const errorMessage = err?.message || 'Async inference failed';
    try {
      await db.updateTaskStatus(taskId, 'failed', {
        output: { status: 'failed', error: errorMessage },
        error_output: errorMessage,
      });
    } catch (_err) {
      void _err;
    }
    recordV2TaskEvent(taskId, 'error', (current?.status || 'running'), 'failed', {
      request_id: requestIdFromTask,
      provider: providerId,
      error: errorMessage,
    });
  }
}

module.exports = {
  init,
  getV2AttemptProvider,
  buildV2InferencePrompt,
  buildV2InferencePayload,
  buildV2AsyncTaskResponse,
  normalizeV2RouteAttempts,
  buildV2ExecutionPlan,
  recordV2AttemptUsage,
  deriveV2AttemptFailureReason,
  buildV2FailurePayload,
  buildV2InferenceTaskOptions,
  executeV2ProviderInference,
  runV2AsyncTask,
};
