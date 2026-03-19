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

function getRetryableStatus(error) {
  if (!error) return null;
  return error.status || error?.response?.status || error.code || error.errno;
}

function isRetryableProviderError(error) {
  const status = error?.status || error?.response?.status;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  // API providers throw plain Error with status embedded in message like "(429)"
  if (error?.message) {
    const match = error.message.match(/\((\d{3})\)/);
    if (match) return [429, 500, 502, 503, 504].includes(parseInt(match[1], 10));
  }
  return false;
}

function getRetryAfterFromError(error) {
  if (!error?.message) return null;
  const match = error.message.match(/retry_after_seconds=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
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

function getFreeTierFallback(task) {
  const metadata = parseTaskMetadata(task);
  if (!metadata.free_tier_overflow || metadata.free_tier_fallback_attempted) {
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
    free_tier_fallback_attempted: true,
  };
  delete nextMetadata.free_tier_overflow;
  delete nextMetadata.free_tier_auto_scale;
  delete nextMetadata.original_provider;
  delete nextMetadata.overflow;

  return {
    originalProvider,
    metadata: nextMetadata,
  };
}

function getFreeProviderRetryFallback(task) {
  const metadata = parseTaskMetadata(task);
  if (metadata.free_tier_overflow || metadata.free_provider_retry) {
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
    return task.task_description;
  }

  if (meta.context_stuff === false) return task.task_description;

  const contextFiles = meta.context_files;
  if (!contextFiles || contextFiles.length === 0) return task.task_description;
  if (!CONTEXT_STUFFING_PROVIDERS.has(task.provider)) return task.task_description;

  const result = await stuffContext({
    contextFiles,
    workingDirectory: task.working_directory || process.cwd(),
    taskDescription: task.task_description,
    provider: task.provider,
    model: task.model || undefined,
    contextBudget: meta.context_budget || undefined,
  });

  return result.enrichedDescription;
}

/**
 * Execute a task using an API-based provider (Anthropic, Groq, DeepInfra, Hyperbolic, etc.)
 * Uses streaming when the provider supports it, falling back to non-streaming submit().
 * @param {Object} task - The task record
 * @param {import('./providers/base')} provider - Provider instance
 */
async function executeApiProvider(task, provider) {
  const taskId = task.id;
  const model = task.model || null;
  const controller = new AbortController();
  // Hoisted so the catch block can reference it even if an error occurs before
  // the clone is created (e.g., during context stuffing or status updates).
  let taskClone = null;

  try {
    // Register abort controller BEFORE setting status to 'running' so cancelTask()
    // can always find it (prevents TOCTOU race if cancel arrives mid-setup)
    apiAbortControllers.set(taskId, controller);

    db.updateTaskStatus(taskId, 'running', { started_at: new Date().toISOString() });
    if (_recordTaskStartedAuditEvent) {
      _recordTaskStartedAuditEvent(task, taskId, provider.name);
    }
    dashboard.notifyTaskUpdated(taskId);

    logger.info(`Starting API provider task`, { taskId, provider: provider.name, model });

    // Context-stuff: prepend file contents for free API providers
    let effectiveDescription = task.task_description;
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

    const startTimeMs = Date.now();
    let result;

    if (provider.supportsStreaming) {
      // Use streaming path — pipe tokens to stream chunks + dashboard
      // Retry on 429/5xx (errors thrown before streaming begins are safe to retry)
      const streamId = db.getOrCreateTaskStream(taskId, 'output');
      const maxStreamAttempts = 3;
      let streamAttempt = 0;

      while (true) {
        streamAttempt += 1;
        try {
          result = await provider.submitStream(effectiveDescription, model, {
            timeout: task.timeout_minutes || 30,
            maxTokens: 4096,
            signal: controller.signal,
            onChunk: (token) => {
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
        }
      }
    } else {
      // Non-streaming fallback
      result = await submitWithRetry(taskClone, provider, model, {
        timeout: task.timeout_minutes || 30,
        maxTokens: 4096,
        signal: controller.signal,
      });
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

    db.updateTaskStatus(taskId, 'completed', {
      output: result.output,
      completed_at: new Date().toISOString(),
    });

    // Trigger workflow dependency resolution + audit aggregation
    if (typeof _handleWorkflowTermination === 'function') {
      try {
        _handleWorkflowTermination(taskId);
      } catch (wtErr) {
        logger.info(`handleWorkflowTermination error for completed API task ${taskId}: ${wtErr.message}`);
      }
    }

    // Record usage
    if (result.usage) {
      try {
        db.recordUsage(taskId, provider.name, model, result.usage);
      } catch { /* ignore */ }
    }

    // Record usage to free-tier quota tracker
    if (result.usage && typeof _getFreeQuotaTracker === 'function') {
      try {
        const tracker = _getFreeQuotaTracker();
        tracker.recordUsage(provider.name, result.usage.tokens || 0);
        tracker.recordLatency(provider.name, Date.now() - startTimeMs);
      } catch { /* non-fatal */ }
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

    // Record rate limit to free-tier quota tracker for cooldown
    const is429 = err.message && (err.message.includes('(429)') || err.message.includes('rate_limit'));
    if (is429 && typeof _getFreeQuotaTracker === 'function') {
      try {
        const tracker = _getFreeQuotaTracker();
        const retryMatch = err.message.match(/retry_after_seconds=(\d+)/);
        const retryAfter = retryMatch ? parseInt(retryMatch[1], 10) : null;
        tracker.recordRateLimit(provider.name, retryAfter);
      } catch { /* non-fatal */ }
    }

    const freeTierFallback = getFreeTierFallback(currentTask || taskClone);
    if (freeTierFallback) {
      requeueTaskAfterAttemptedStart(taskId, {
        provider: freeTierFallback.originalProvider,
        model: null,
        metadata: freeTierFallback.metadata,
        output: null,
        error_output: null,
      });
      logger.info(`API provider task ${taskId} free-tier overflow failed, requeued to original provider ${freeTierFallback.originalProvider}`, {
        taskId,
        failedProvider: provider.name,
        fallbackProvider: freeTierFallback.originalProvider,
      });
      dashboard.notifyTaskUpdated(taskId);
      try { if (processQueue) processQueue(); } catch { /* ignore */ }
      return;
    }

    const freeProviderRetryFallback = getFreeProviderRetryFallback(currentTask || taskClone);
    if (freeProviderRetryFallback) {
      requeueTaskAfterAttemptedStart(taskId, {
        provider: freeProviderRetryFallback.targetProvider,
        model: null,
        metadata: freeProviderRetryFallback.metadata,
        output: null,
        error_output: null,
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
  getFreeTierFallback,
  getFreeProviderRetryFallback,
  enrichTaskDescription,
  executeApiProvider,
};
