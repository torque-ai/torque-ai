/**
 * providers/execute-api.js — API provider execution (Anthropic, Groq, DeepInfra, Hyperbolic, etc.)
 * Extracted from providers/execution.js Phase decomposition
 *
 * Uses init() dependency injection for database, dashboard, and abort controllers.
 * Supports streaming for providers that implement submitStream() + supportsStreaming.
 */

'use strict';

const logger = require('../logger').child({ component: 'execute-api' });
const { redactSecrets } = require('../utils/sanitize');
const { stuffContext, CONTEXT_STUFFING_PROVIDERS } = require('../utils/context-stuffing');
const { installProxyAgent } = require('../utils/proxy-agent');
const providerRegistry = require('./registry');
const { FREE_PROVIDERS } = require('../execution/queue-scheduler');
const { safeJsonParse } = require('../utils/json');
const { buildResumeContext, prependResumeContextToPrompt } = require('../utils/resume-context');
const { applyStudyContextPrompt } = require('../integrations/codebase-study-engine');
const { isJsonModeRequested } = require('./shared');
const { createProviderActionStream } = require('../actions/provider-stream-hook');

// Phase 2: Proxy support for enterprise environments.
// When HTTPS_PROXY / HTTP_PROXY env vars are set, all cloud API fetch() calls
// route through the configured proxy. NO_PROXY exclusions are respected.
// When no proxy env vars are set, behavior is unchanged (direct connections).
installProxyAgent();

// Dependency injection
let db = null;
let dashboard = null;
let apiAbortControllers = null;
let processQueue = null;
let _getFreeQuotaTracker = null;
let _recordTaskStartedAuditEvent = null;
let _handleWorkflowTermination = null;
const FREE_PROVIDER_SET = new Set(FREE_PROVIDERS);
const OPENROUTER_PROVIDER_ROLES = ['default', 'fallback', 'balanced', 'fast', 'quality'];
const OPENROUTER_FALLBACK_SCORE_LIMIT = 8;

function dedupeValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (typeof value !== 'string') return false;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function parseProviderModelMetadata(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeSupportedParameters(value) {
  const metadata = parseProviderModelMetadata(value);
  const supportedParameters = Array.isArray(metadata?.supported_parameters)
    ? metadata.supported_parameters
    : (Array.isArray(metadata?.supportedParameters) ? metadata.supportedParameters : []);
  return supportedParameters
    .map((parameter) => {
      if (typeof parameter === 'string') return parameter.trim().toLowerCase();
      if (parameter && typeof parameter === 'object' && typeof parameter.name === 'string') return parameter.name.trim().toLowerCase();
      return '';
    })
    .filter(Boolean);
}

function modelSupportsOpenRouterResponseFormat(metadataJson) {
  const metadata = parseProviderModelMetadata(metadataJson);
  if (metadata.supports_response_format === true || metadata.supportsResponseFormat === true) return true;
  const supportedParameters = normalizeSupportedParameters(metadataJson);
  return supportedParameters.some((parameter) => {
    if (parameter === 'response_format') return true;
    if (parameter === 'json_schema') return true;
    if (parameter.includes('response_format')) return true;
    return false;
  });
}

function resolveOpenRouterFallbackRows(rows, options = {}) {
  const preferParser = options.preferParserModels === true;
  const scoredRows = (Array.isArray(rows) ? rows : [])
    .map((row, sortOrder) => {
      const model = typeof row?.model_name === 'string' ? row.model_name.trim() : '';
      if (!model) return null;
      const metadataJson = row?.metadata_json || row?.metadata;
      return {
        model,
        isFree: isFreeOpenRouterModelCandidate(model, metadataJson),
        supportsParser: modelSupportsOpenRouterResponseFormat(metadataJson),
        sortOrder,
      };
    })
    .filter(Boolean);

  if (scoredRows.length === 0) return [];

  const orderedRows = preferParser
    ? [...scoredRows].sort((a, b) => {
      if (a.supportsParser !== b.supportsParser) return b.supportsParser - a.supportsParser;
      return a.sortOrder - b.sortOrder;
    })
    : scoredRows;

  const freeRows = orderedRows.filter((row) => row.isFree);
  const fallbackRows = freeRows.length > 0 ? freeRows : orderedRows;
  if (!preferParser) return dedupeValues(fallbackRows.map((row) => row.model));

  const parserRows = fallbackRows.filter((row) => row.supportsParser);
  const nonParserRows = fallbackRows.filter((row) => !row.supportsParser);
  if (parserRows.length === 0) return dedupeValues(fallbackRows.map((row) => row.model));
  return dedupeValues([...parserRows, ...nonParserRows].map((row) => row.model));
}

function isStructuredOpenRouterRequest(metadata = {}) {
  const responseFormat = metadata.response_format ?? metadata.responseFormat;
  return isJsonModeRequested({ responseFormat });
}

function isFreeOpenRouterModelCandidate(modelName, metadataJson) {
  if (/:free$/i.test(modelName)) return true;
  const metadata = parseProviderModelMetadata(metadataJson);
  return metadata.free === true || metadata.free === 1 || metadata.free === '1';
}

function getTopScoredOpenRouterFallbackModels(options = {}) {
  if (!db || typeof db.prepare !== 'function') return [];
  const hasSqliteHandle = typeof db.exec === 'function';

  const limit = Math.max(1, Number.isFinite(Number(options.limit)) ? Number(options.limit) : OPENROUTER_FALLBACK_SCORE_LIMIT);
  try {
    const providerModelScores = require('../db/provider-model-scores');
    if (hasSqliteHandle && typeof providerModelScores.init === 'function') {
      try {
        providerModelScores.init(db);
      } catch {
        return [];
      }
    }

    const fetchTopModels = providerModelScores.getTopModelScores || providerModelScores.listModelScores;
    if (typeof fetchTopModels !== 'function') return [];

    const rows = fetchTopModels.call(providerModelScores, 'openrouter', {
      rateLimited: false,
      limit,
      minScore: options.minScore,
    }) || [];
    const fallbackCandidates = resolveOpenRouterFallbackRows(rows, {
      minScore: options.minScore,
      preferParserModels: isStructuredOpenRouterRequest(options.taskMetadata),
    });
    return fallbackCandidates.slice(0, limit);
  } catch (err) {
    logger.debug(`openrouter fallback score lookup failed: ${err.message}`);
    return [];
  }
}

function resolveOpenRouterRoleModels() {
  try {
    const modelRoles = require('../db/model-roles');
    const roleModels = OPENROUTER_PROVIDER_ROLES.map((role) => {
      try {
        return modelRoles.getModelForRole('openrouter', role);
      } catch {
        return null;
      }
    });
    return dedupeValues(roleModels);
  } catch {
    return [];
  }
}

function getRetryableStatus(error) {
  if (!error) return null;
  const rawStatus = error.status ?? error?.response?.status;
  const rawNumber = rawStatus != null ? Number(rawStatus) : null;
  if (rawNumber != null && !Number.isNaN(rawNumber)) return rawNumber;
  return error.status || error?.response?.status || error.code || error.errno || null;
}

function isRetryableProviderError(error) {
  const status = error?.status || error?.response?.status;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  // API providers throw plain Error with status embedded in message like "(429)"
  if (error?.message) {
    const match = error.message.match(/\((\d{3})\)/);
    if (match) return [429, 500, 502, 503, 504].includes(parseInt(match[1], 10));
  }
  // Timeout errors and network-layer failures are transient — should retry
  if (error?.name === 'AbortError') return false; // explicit cancellation, not retryable
  const msg = (error?.message || '').toLowerCase();
  if (/timeout|timed out|econnrefused|econnreset|network|failed to fetch/.test(msg)) return true;
  return false;
}

function getRetryAfterFromError(error) {
  if (!error) return null;
  const message = (error.message == null ? '' : String(error.message));

  function parseSeconds(value) {
    if (value == null) return null;
    const numeric = Number.parseInt(String(value).trim(), 10);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;

    const timestamp = Date.parse(String(value).trim());
    if (Number.isFinite(timestamp)) {
      const deltaSeconds = Math.ceil((timestamp - Date.now()) / 1000);
      return deltaSeconds > 0 ? deltaSeconds : 0;
    }

    return null;
  }

  function readHeader(headers, headerName) {
    if (!headers) return null;
    if (typeof headers.get === 'function') {
      return headers.get(headerName) || headers.get(headerName.toLowerCase());
    }
    const raw = headers[headerName] || headers[headerName.toLowerCase()];
    if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
    if (raw && typeof raw === 'object' && typeof raw[headerName] === 'string') return raw[headerName];
    const lower = String(headerName).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === lower) return value != null ? String(value) : null;
    }
    return null;
  }

  const candidatePairs = [
    () => parseSeconds((message.match(/retry_after_seconds=(\d+)/i) || [])[1]),
    () => parseSeconds((message.match(/retry[-_ ]after(?: seconds)?=([0-9]+(?:\.[0-9]+)?)/i) || [])[1]),
    () => parseSeconds(error.retry_after_seconds),
    () => parseSeconds(error.retry_after),
    () => parseSeconds(error.retryAfter),
    () => parseSeconds(readHeader(error.headers, 'Retry-After')),
    () => parseSeconds(readHeader(error.response?.headers, 'Retry-After')),
    () => parseSeconds(readHeader(error.response?.headers, 'retry-after')),
    () => parseSeconds(error.response?.retry_after_seconds),
    () => parseSeconds(error.response?.retryAfter),
    () => parseSeconds(error.response?.error?.retry_after_seconds),
    () => parseSeconds(error.response?.error?.retryAfter),
    () => {
      const responseBody = error.response?.data || error.response?.body || error.body || error.data || {};
      return parseSeconds(responseBody.retry_after_seconds || responseBody.retry_after || responseBody.retryAfter);
    },
  ];

  for (const next of candidatePairs) {
    const parsed = next();
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function submitWithRetry(task, provider, model, options, maxAttempts = 3) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await provider.submit(task.task_description, model, options);
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError' || error?.name === 'DOMException') {
        throw error;
      }
      if (attempt >= maxAttempts || !isRetryableProviderError(error)) {
        throw error;
      }
      // Use retry_after from 429 response if available, otherwise exponential backoff
      const retryAfter = getRetryAfterFromError(error);
      const retryDelayMs = retryAfter
        ? Math.min(retryAfter * 1000, 60000)
        : Math.min(75 * Math.pow(2, attempt - 1), 5000);
      logger.info(`API provider task ${task.id} retryable failure attempt ${attempt}, retrying in ${retryDelayMs}ms`, { provider: provider.name, status: getRetryableStatus(error), retryAfter });
      await delay(retryDelayMs);
    }
  }

  if (lastError) throw lastError;
  throw new Error('Provider submit failed without response');
}

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 * @param {Object} deps.db - Database module
 * @param {Object} deps.dashboard - Dashboard server for notifyTaskUpdated()
 * @param {Map} deps.apiAbortControllers - Map of taskId → AbortController
 * @param {Function} deps.processQueue - Queue drain function
 */
function init(deps) {
  if (deps.db) db = deps.db;
  if (deps.dashboard) dashboard = deps.dashboard;
  if (deps.apiAbortControllers) apiAbortControllers = deps.apiAbortControllers;
  if (deps.processQueue) processQueue = deps.processQueue;
  if (deps.recordTaskStartedAuditEvent) _recordTaskStartedAuditEvent = deps.recordTaskStartedAuditEvent;
  if (deps.handleWorkflowTermination) _handleWorkflowTermination = deps.handleWorkflowTermination;
}

function setFreeQuotaTracker(getter) {
  _getFreeQuotaTracker = getter;
}

function normalizeProviderName(provider) {
  return typeof provider === 'string' ? provider.trim().toLowerCase() : '';
}

function getExecutionDescription(task) {
  return typeof task?.execution_description === 'string' && task.execution_description.trim()
    ? task.execution_description
    : task.task_description;
}

function isProviderEnabledAndHealthy(provider) {
  const normalizedProvider = normalizeProviderName(provider);
  if (!normalizedProvider) {
    return false;
  }

  try {
    const providerConfig = typeof db?.getProvider === 'function'
      ? db.getProvider(normalizedProvider)
      : null;
    if (!providerConfig || !providerConfig.enabled) {
      return false;
    }
  } catch {
    return false;
  }

  if (typeof db?.isProviderHealthy === 'function') {
    try {
      if (!db.isProviderHealthy(normalizedProvider)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
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
  } catch {
    return {};
  }
}

function buildProviderExecutionOptions(task, controller, extra = {}) {
  const metadata = parseTaskMetadata(task);
  // `??` preserves timeout_minutes === 0 ("no timeout" opt-in). Each cloud
  // provider adapter still has its own `options.timeout || N` coercion at
  // the moment (anthropic/cerebras/deepinfra/google-ai/groq/hyperbolic/
  // openrouter/ollama-cloud) — those individual sites are an open follow-up,
  // but at least the top-level value no longer gets clobbered here.
  const options = {
    timeout: task.timeout_minutes ?? 30,
    maxTokens: 4096,
    signal: controller.signal,
    working_directory: task.working_directory || process.cwd(),
    ...extra,
  };

  if (task?.provider === 'claude-code-sdk') {
    if (task.__transcript) {
      options.transcript = task.__transcript;
    }

    if (metadata.transcript_seed_from_task_id) {
      options.seed_messages = task.__transcript && typeof task.__transcript.read === 'function'
        ? task.__transcript.read()
        : [];
      options.force_fresh_session = true;
    }
  }

  // Forward structured-output and prompting hints from task metadata to
  // the provider adapter. Today only the cerebras adapter consumes these
  // (JSON mode, system prompt, top_p), but the passthrough is generic
  // so other API adapters can opt in without re-plumbing.
  if (task?.provider === 'openrouter') {
    const roleModels = resolveOpenRouterRoleModels();
    const scoredFallbackModels = getTopScoredOpenRouterFallbackModels({
      limit: OPENROUTER_FALLBACK_SCORE_LIMIT,
      minScore: 0,
      taskMetadata: metadata,
    });
    const candidateFallbackModels = [
      ...Array.isArray(options.fallbackModels) ? options.fallbackModels : [],
      ...(metadata.fallbackModels || []).filter((item) => typeof item === 'string'),
      ...roleModels,
      ...scoredFallbackModels,
    ];
    if (candidateFallbackModels.length > 0) {
      options.fallbackModels = dedupeValues(candidateFallbackModels);
    }
  }

  if (metadata.response_format !== undefined) {
    options.responseFormat = metadata.response_format;
  }
  if (typeof metadata.system_prompt === 'string' && metadata.system_prompt.trim() !== '') {
    options.systemPrompt = metadata.system_prompt;
  }
  if (metadata.max_tokens !== undefined && Number.isFinite(Number(metadata.max_tokens))) {
    options.maxTokens = Number(metadata.max_tokens);
  }
  if (metadata.tuning && typeof metadata.tuning === 'object') {
    options.tuning = { ...(options.tuning || {}), ...metadata.tuning };
  }

  return options;
}

function requeueTaskAfterAttemptedStart(taskId, patch = {}) {
  if (typeof db?.requeueTaskAfterAttemptedStart === 'function') {
    return db.requeueTaskAfterAttemptedStart(taskId, patch);
  }
  return db.updateTaskStatus(taskId, 'queued', {
    started_at: null,
    completed_at: null,
    pid: null,
    progress_percent: null,
    exit_code: null,
    mcp_instance_id: null,
    ollama_host_id: null,
    ...patch,
  });
}

function buildApiRetryResumeFields(task, providerName, error) {
  const taskDescription = task?.task_description || '';
  const errorOutput = `Provider ${providerName} error: ${redactSecrets(error?.message || error || '')}`;
  const resumeContext = task?.resume_context || buildResumeContext(
    task?.output || '',
    errorOutput,
    {
      task_description: taskDescription,
      provider: providerName,
      started_at: task?.started_at,
      completed_at: new Date().toISOString(),
    },
  );
  const retryDescription = prependResumeContextToPrompt(taskDescription, resumeContext);
  return {
    resume_context: resumeContext,
    ...(retryDescription && retryDescription !== taskDescription ? { task_description: retryDescription } : {}),
  };
}

function getQuotaFallback(task) {
  const metadata = parseTaskMetadata(task);
  if (!metadata.quota_overflow || metadata.quota_fallback_attempted) {
    return null;
  }

  const originalProvider = normalizeProviderName(metadata.original_provider);
  const currentProvider = normalizeProviderName(task?.provider);
  if (!originalProvider || originalProvider === currentProvider) {
    return null;
  }

  if (!isProviderEnabledAndHealthy(originalProvider)) {
    return null;
  }

  const nextMetadata = {
    ...metadata,
    quota_fallback_attempted: true,
  };
  delete nextMetadata.quota_overflow;
  delete nextMetadata.quota_auto_scale;
  delete nextMetadata.original_provider;
  delete nextMetadata.overflow;

  return {
    originalProvider,
    metadata: nextMetadata,
  };
}

function getFreeProviderRetryFallback(task) {
  const metadata = parseTaskMetadata(task);
  if (metadata.quota_overflow || metadata.free_provider_retry) {
    return null;
  }

  const currentProvider = normalizeProviderName(task?.provider);
  if (providerRegistry.getCategory(currentProvider) !== 'api') {
    return null;
  }
  if (!FREE_PROVIDER_SET.has(currentProvider)) {
    return null;
  }

  const targetProvider = 'codex';
  if (!isProviderEnabledAndHealthy(targetProvider)) {
    return null;
  }

  return {
    targetProvider,
    metadata: {
      ...metadata,
      free_provider_retry: true,
    },
  };
}

/**
 * Enrich a task description with context-stuffed file contents when the provider
 * supports it and context_files are present in the task metadata.
 *
 * @param {Object} task - Task record with metadata, provider, task_description, working_directory
 * @returns {Promise<string>} Enriched (or original) task description
 */
async function enrichTaskDescription(task) {
  let meta;
  try {
    meta = typeof task.metadata === 'string' ? safeJsonParse(task.metadata, {}) : (task.metadata || {});
  } catch {
    return getExecutionDescription(task);
  }

  const promptDescription = getExecutionDescription(task);
  let effectiveDescription = promptDescription;
  const contextFiles = meta.context_files;
  const canStuffContext = meta.context_stuff !== false
    && Array.isArray(contextFiles)
    && contextFiles.length > 0
    && CONTEXT_STUFFING_PROVIDERS.has(task.provider);

  if (canStuffContext) {
    const result = await stuffContext({
      contextFiles,
      workingDirectory: task.working_directory || process.cwd(),
      taskDescription: promptDescription,
      provider: task.provider,
      model: task.model || undefined,
      contextBudget: meta.context_budget || undefined,
    });
    effectiveDescription = result.enrichedDescription;
  }

  return applyStudyContextPrompt(effectiveDescription, meta);
}

/**
 * Execute a task using an API-based provider (Anthropic, Groq, DeepInfra, Hyperbolic, etc.)
 * Uses streaming when the provider supports it, falling back to non-streaming submit().
 * @param {Object} task - The task record
 * @param {import('./providers/base')} provider - Provider instance
 */
async function executeApiProvider(task, provider) {
  const taskId = task.id;
  let model = task.model || null;
  const controller = new AbortController();
  // Hoisted so the catch block can reference it even if an error occurs before
  // the clone is created (e.g., during context stuffing or status updates).
  let taskClone = null;
  // Issue #9: hoisted so the finally block can record usage on both success and failure paths.
  let startTimeMs = 0;
  let result = null;

  try {
    // Register abort controller BEFORE setting status to 'running' so cancelTask()
    // can always find it (prevents TOCTOU race if cancel arrives mid-setup)
    apiAbortControllers.set(taskId, controller);

    // Persist resolved model so performance tracking works (model may be null on the task
    // if smart routing didn't set it — the provider resolves a default internally)
    const resolvedModelFromProvider = provider.defaultModel ? provider.defaultModel : null;
    // Skip blocklisted models — fall through to provider's default. The blocklist
    // is populated by the close-handler when a model returns model-not-found /
    // persistent 5xx, so we don't keep retrying a known-bad combo.
    const modelBlocklist = require('./model-blocklist');
    if (model && modelBlocklist.isBlocked(provider.name, model)) {
      logger.warn(`[execute-api] Task ${taskId}: ${provider.name}/${model} is on the model blocklist — falling back to provider default ${resolvedModelFromProvider || '(none)'}`);
      model = null;
    }
    let resolvedModel = model || resolvedModelFromProvider;
    db.updateTaskStatus(taskId, 'running', {
      started_at: new Date().toISOString(),
      ...(resolvedModel ? { model: resolvedModel } : {}),
    });
    if (_recordTaskStartedAuditEvent) {
      _recordTaskStartedAuditEvent(task, taskId, provider.name);
    }
    dashboard.notifyTaskUpdated(taskId);

    logger.info(`Starting API provider task`, { taskId, provider: provider.name, model });

    // Context-stuff: prepend file contents for free API providers
    let effectiveDescription = getExecutionDescription(task);
    try {
      effectiveDescription = await enrichTaskDescription(task);
    } catch (ctxErr) {
      if (ctxErr.message && /context too large/i.test(ctxErr.message)) {
        // Over-budget: fail the task immediately with actionable error
        // Guard against race: don't overwrite terminal status (e.g., cancelled)
        const currentTask = db.getTask(taskId);
        if (currentTask && currentTask.status !== 'running') {
          logger.info(`API provider task ${taskId} status changed to '${currentTask.status}' during context stuffing, skipping failure update`);
          apiAbortControllers.delete(taskId);
          // Task is no longer running — free the slot for the next queued task
          try { if (processQueue) processQueue(); } catch { /* ignore */ }
          return;
        }
        db.updateTaskStatus(taskId, 'failed', {
          error_output: ctxErr.message,
          completed_at: new Date().toISOString(),
        });
        // Trigger workflow dependency resolution so dependent tasks are unblocked
        if (typeof _handleWorkflowTermination === 'function') {
          try {
            _handleWorkflowTermination(taskId);
          } catch (wtErr) {
            logger.info(`handleWorkflowTermination error for context-size-failed API task ${taskId}: ${wtErr.message}`);
          }
        }
        apiAbortControllers.delete(taskId);
        dashboard.notifyTaskUpdated(taskId);
        return;
      }
      // Other errors (filesystem, etc.): fall back to original description
      logger.debug(`Context stuffing failed for task ${taskId}, using original description: ${ctxErr.message}`);
    }

    taskClone = { ...task };
    taskClone.task_description = effectiveDescription;

    // Issue #9: startTimeMs is hoisted so the finally block can record usage on
    // both success and failure paths.
    startTimeMs = Date.now();
    const providerOptions = buildProviderExecutionOptions(taskClone, controller);
    if (provider.name === 'openrouter' && !resolvedModel && Array.isArray(providerOptions.fallbackModels) && providerOptions.fallbackModels.length > 0) {
      resolvedModel = providerOptions.fallbackModels[0];
      model = resolvedModel;
      db.updateTaskStatus(taskId, 'running', { model: resolvedModel });
    }

    if (provider.supportsStreaming) {
      // Use streaming path — pipe tokens to stream chunks + dashboard
      // Retry on 429/5xx (errors thrown before streaming begins are safe to retry)
      const streamId = db.getOrCreateTaskStream(taskId, 'output');
      const maxStreamAttempts = 3;
      let streamAttempt = 0;

      while (true) {
        streamAttempt += 1;
        let actionStream = null;
        try {
          actionStream = createProviderActionStream({
            task,
            taskId,
            workflowId: task.workflow_id || null,
            logger,
          });
          result = await provider.submitStream(effectiveDescription, model, {
            ...providerOptions,
            onChunk: (token) => {
              actionStream?.feed(token);
              try {
                db.addStreamChunk(streamId, token, 'stdout');
                dashboard.notifyTaskOutput(taskId, token);
              } catch { /* don't fail task for stream storage errors */ }
            },
          });
          break; // success
        } catch (streamErr) {
          if (streamErr?.name === 'AbortError' || streamErr?.name === 'DOMException') throw streamErr;
          if (streamAttempt >= maxStreamAttempts || !isRetryableProviderError(streamErr)) throw streamErr;
          const retryAfter = getRetryAfterFromError(streamErr);
          const retryMs = retryAfter
            ? Math.min(retryAfter * 1000, 60000)
            : Math.min(1000 * Math.pow(2, streamAttempt - 1), 10000);
          logger.info(`API streaming task ${taskId} attempt ${streamAttempt} got retryable error, retrying in ${retryMs}ms`, {
            provider: provider.name,
            retryAfter,
          });
          await delay(retryMs);
        } finally {
          actionStream?.end();
        }
      }
    } else {
      // Non-streaming fallback
      result = await submitWithRetry(taskClone, provider, model, providerOptions);
    }

    if (controller.signal.aborted) {
      logger.info(`API provider task ${taskId} was aborted, skipping completion update`);
      return;
    }

    // Guard against race: if task was cancelled while provider.submit() was in flight, don't overwrite
    const currentTask = db.getTask(taskId);
    if (currentTask && currentTask.status !== 'running') {
      logger.info(`API provider task ${taskId} status changed to '${currentTask.status}' during execution, skipping completion`);
      return;
    }

    // Provider-level timeout: result resolved but indicates timeout — treat as failure
    if (result && result.status === 'timeout') {
      logger.info(`API provider task ${taskId} returned provider-level timeout`, { provider: provider.name });
      db.updateTaskStatus(taskId, 'failed', {
        output: result.output || `Provider ${provider.name} timed out`,
        completed_at: new Date().toISOString(),
      });
      if (typeof _handleWorkflowTermination === 'function') {
        try {
          _handleWorkflowTermination(taskId);
        } catch (wtErr) {
          logger.info(`handleWorkflowTermination error for timed-out API task ${taskId}: ${wtErr.message}`);
        }
      }
      dashboard.notifyTaskUpdated(taskId);
      try { if (processQueue) processQueue(); } catch { /* ignore */ }
      return;
    }

    if (result?.session_id || result?.claude_session_id) {
      try {
        const currentMetadata = parseTaskMetadata(taskClone || task);
        db.patchTaskMetadata(taskId, {
          ...currentMetadata,
          ...(result.session_id ? { claude_local_session_id: result.session_id } : {}),
          ...(result.claude_session_id ? { claude_session_id: result.claude_session_id } : {}),
        });
      } catch (metadataError) {
        logger.debug(`Failed to persist provider session metadata for task ${taskId}: ${metadataError.message}`);
      }
    }

    db.updateTaskStatus(taskId, 'completed', {
      output: result.output || '',
      completed_at: new Date().toISOString(),
    });

    // Diffusion compute→apply: if this is a compute task, create the apply task dynamically
    try {
      const task = db.getTask(taskId);
      const meta = task?.metadata ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata) : {};
      if (meta.diffusion_role === 'compute') {
        const { parseComputeOutput, validateComputeSchema } = require('../diffusion/compute-output-parser');
        const { expandApplyTaskDescription } = require('../diffusion/planner');
        const computeRawOutput = result.output || '';
        logger.info(`[Diffusion] Compute task ${taskId} output: ${computeRawOutput.length} chars, first 200: ${computeRawOutput.substring(0, 200)}`);
        const parsed = parseComputeOutput(computeRawOutput);
        logger.info(`[Diffusion] Compute parse result: ${parsed ? 'valid JSON' : 'null (parse failed)'}`);
        if (parsed) {
          const validation = validateComputeSchema(parsed);
          if (validation.valid) {
            const applyId = require('uuid').v4();
            const applyProviderList = Array.isArray(meta.apply_providers) && meta.apply_providers.length > 0
              ? meta.apply_providers
              : [meta.apply_provider || 'ollama'];
            const applyIndex = parseInt(taskId.replace(/[^0-9a-f]/g, '').slice(-4), 16) % applyProviderList.length;
            const applyProvider = applyProviderList[applyIndex];
            const applyDesc = expandApplyTaskDescription(parsed, task.working_directory);
            db.createTask({
              id: applyId,
              status: 'queued',
              task_description: applyDesc,
              working_directory: task.working_directory,
              workflow_id: task.workflow_id,
              provider: applyProvider,
              metadata: JSON.stringify({
                diffusion: true,
                diffusion_role: 'apply',
                compute_task_id: taskId,
                compute_output: parsed,
                // auto_verify_on_completion: false — verify runs at workflow level, not per-task
                verify_command: meta.verify_command || null,
                user_provider_override: true,
                requested_provider: applyProvider,
              }),
            });
            logger.info(`[Diffusion] Created apply task ${applyId} from API compute ${taskId} (${parsed.file_edits.length} file edits)`);
            if (task.workflow_id) {
              try {
                const workflowEngine = require('../db/workflow-engine');
                workflowEngine.updateWorkflowCounts(task.workflow_id);
                const wf = workflowEngine.getWorkflow(task.workflow_id);
                if (wf && wf.status === 'completed') {
                  workflowEngine.updateWorkflow(task.workflow_id, { status: 'running' });
                  logger.info(`[Diffusion] Reopened workflow ${task.workflow_id} — apply tasks still pending`);
                }
              } catch (wfErr) {
                logger.info(`[Diffusion] Workflow count update error: ${wfErr.message}`);
              }
            }
            try {
              const taskManager = require('../task-manager');
              const startPromise = taskManager.startTask(applyId);
              if (startPromise && typeof startPromise.catch === 'function') {
                startPromise.catch(err => logger.info(`[Diffusion] Async failure starting apply task ${applyId}: ${err.message}`));
              }
            } catch (startErr) {
              logger.info(`[Diffusion] Failed to auto-start apply task ${applyId}: ${startErr.message}`);
            }
          } else {
            logger.info(`[Diffusion] API compute task ${taskId} schema invalid: ${validation.errors.join('; ')}`);
          }
        } else {
          logger.info(`[Diffusion] API compute task ${taskId} produced unparseable output`);
        }
      }
    } catch (diffusionErr) {
      logger.debug(`[Diffusion] API compute→apply hook error: ${diffusionErr.message}`);
    }

    // Trigger workflow dependency resolution + audit aggregation
    if (typeof _handleWorkflowTermination === 'function') {
      try {
        _handleWorkflowTermination(taskId);
      } catch (wtErr) {
        logger.info(`handleWorkflowTermination error for completed API task ${taskId}: ${wtErr.message}`);
      }
    }

    dashboard.notifyTaskUpdated(taskId);
    logger.info(`API provider task completed`, { taskId, provider: provider.name, streaming: !!provider.supportsStreaming });
    try { if (processQueue) processQueue(); } catch { /* ignore */ }
  } catch (err) {
    if (controller.signal.aborted) {
      logger.info(`API provider task ${taskId} was aborted, skipping failure update`);
      return;
    }

    // Guard against race: don't overwrite cancelled status
    const currentTask = db.getTask(taskId);
    if (currentTask && currentTask.status !== 'running') {
      logger.info(`API provider task ${taskId} status changed to '${currentTask.status}' during execution, skipping failure update`);
      return;
    }

    logger.info(`API provider task failed`, { taskId, provider: provider.name, error: redactSecrets(err.message) });

    // Record rate limit to quota tracker for cooldown
    const retryStatus = getRetryableStatus(err);
    const is429 = retryStatus === 429;
    if (is429 && typeof _getFreeQuotaTracker === 'function') {
      try {
        const tracker = _getFreeQuotaTracker();
        const retryAfter = getRetryAfterFromError(err);
        tracker.recordRateLimit(provider.name, retryAfter);
      } catch { /* non-fatal */ }
    }

    const quotaFallback = getQuotaFallback(currentTask || taskClone);
    if (quotaFallback) {
      const resumeFields = buildApiRetryResumeFields(currentTask || taskClone, provider.name, err);
      requeueTaskAfterAttemptedStart(taskId, {
        provider: quotaFallback.originalProvider,
        model: null,
        metadata: quotaFallback.metadata,
        output: null,
        error_output: null,
        ...resumeFields,
      });
      logger.info(`API provider task ${taskId} quota overflow failed, requeued to original provider ${quotaFallback.originalProvider}`, {
        taskId,
        failedProvider: provider.name,
        fallbackProvider: quotaFallback.originalProvider,
      });
      dashboard.notifyTaskUpdated(taskId);
      try { if (processQueue) processQueue(); } catch { /* ignore */ }
      return;
    }

    const freeProviderRetryFallback = getFreeProviderRetryFallback(currentTask || taskClone);
    if (freeProviderRetryFallback) {
      const resumeFields = buildApiRetryResumeFields(currentTask || taskClone, provider.name, err);
      requeueTaskAfterAttemptedStart(taskId, {
        provider: freeProviderRetryFallback.targetProvider,
        model: null,
        metadata: freeProviderRetryFallback.metadata,
        output: null,
        error_output: null,
        ...resumeFields,
      });
      logger.info(`API provider task ${taskId} free-provider failure requeued to ${freeProviderRetryFallback.targetProvider}`, {
        taskId,
        failedProvider: provider.name,
        fallbackProvider: freeProviderRetryFallback.targetProvider,
      });
      dashboard.notifyTaskUpdated(taskId);
      try { if (processQueue) processQueue(); } catch { /* ignore */ }
      return;
    }

    db.updateTaskStatus(taskId, 'failed', {
      output: `Provider ${provider.name} error: ${redactSecrets(err.message)}`,
      completed_at: new Date().toISOString(),
    });

    // Trigger workflow dependency resolution + audit aggregation for failed tasks
    if (typeof _handleWorkflowTermination === 'function') {
      try {
        _handleWorkflowTermination(taskId);
      } catch (wtErr) {
        logger.info(`handleWorkflowTermination error for failed API task ${taskId}: ${wtErr.message}`);
      }
    }

    dashboard.notifyTaskUpdated(taskId);
    try { if (processQueue) processQueue(); } catch { /* ignore */ }
  } finally {
    // Issue #9 fix: record usage in finally so it runs on both success and failure.
    // result is hoisted above the try block; it may be undefined if error occurred before submit.
    if (result && result.usage) {
      try {
        db.recordUsage(taskId, provider.name, model, result.usage);
      } catch { /* ignore */ }
      if (typeof _getFreeQuotaTracker === 'function') {
        try {
          const tracker = _getFreeQuotaTracker();
          tracker.recordUsage(provider.name, result.usage.tokens || 0);
          tracker.recordLatency(provider.name, startTimeMs > 0 ? Date.now() - startTimeMs : 0);
        } catch { /* non-fatal */ }
      }
    }
    apiAbortControllers.delete(taskId);
  }
}

module.exports = {
  getRetryableStatus,
  isRetryableProviderError,
  getRetryAfterFromError,
  delay,
  submitWithRetry,
  init,
  setFreeQuotaTracker,
  parseTaskMetadata,
  getQuotaFallback,
  getFreeProviderRetryFallback,
  enrichTaskDescription,
  executeApiProvider,
};
