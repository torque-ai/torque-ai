/**
 * Fallback & Retry Module
 *
 * Extracted from task-manager.js — provider fallback chains, stall recovery,
 * model escalation, and hashline format selection.
 *
 * Uses init() dependency injection to receive database, dashboard,
 * process control, and queue management references.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const logger = require('../logger').child({ component: 'fallback-retry' });
const { STALL_REQUEUE_DEBOUNCE_MS, DEFAULT_FALLBACK_MODEL } = require('../constants');
const { CLOUD_PROVIDERS, getProviderFallbackChain } = require('../db/provider-routing-core');
const serverConfig = require('../config');

const BASE_RETRY_DELAY_MS = 5000;   // 5 seconds for first retry
const MAX_RETRY_DELAY_MS = 120000;  // 2 minutes max

function getRetryDelayMs(task) {
  const rawAttempt = task && task.retry_count;
  const normalizedAttempt = Number.parseInt(rawAttempt, 10);
  const attempt = Number.isFinite(normalizedAttempt) && normalizedAttempt > 0 ? normalizedAttempt : 1;
  return Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS);
}


// Dependency injection
let db = null;
let dashboard = null;
let _processQueue = null;
let _cancelTask = null;
let _stopTaskForRestart = null;
let _stallRecoveryAttempts = null;
let _runningProcesses = null;
let _pendingProcessQueueTimer = null;
let _getFreeQuotaTracker = null;

function setFreeQuotaTracker(getter) {
  _getFreeQuotaTracker = getter;
}

function scheduleProcessQueue(task = null) {
  if (_pendingProcessQueueTimer) return;
  _pendingProcessQueueTimer = setTimeout(() => {
    _pendingProcessQueueTimer = null;
    if (_processQueue) _processQueue();
  }, getRetryDelayMs(task));
}

/**
 * Initialize the module with required dependencies.
 * @param {Object} deps
 * @param {Object} deps.db - Database instance (database.js)
 * @param {Object} deps.dashboard - Dashboard server for notifyTaskUpdated()
 * @param {Function} deps.processQueue - Queue processing function
 * @param {Function} deps.cancelTask - Task cancellation function
 * @param {Function} deps.stopTaskForRestart - Stop task without marking cancelled
 * @param {Map} deps.stallRecoveryAttempts - Map tracking stall recovery state
 * @param {Map} deps.runningProcesses - Map tracking running processes
 */
function init(deps) {
  db = deps.db;
  if (deps.db) serverConfig.init({ db: deps.db });
  if (deps.dashboard) dashboard = deps.dashboard;
  if (deps.processQueue) _processQueue = deps.processQueue;
  if (deps.cancelTask) _cancelTask = deps.cancelTask;
  if (deps.stopTaskForRestart) _stopTaskForRestart = deps.stopTaskForRestart;
  if (deps.stallRecoveryAttempts) _stallRecoveryAttempts = deps.stallRecoveryAttempts;
  if (deps.runningProcesses) _runningProcesses = deps.runningProcesses;
  // Clear any pending debounce timer from previous init (prevents stale timer leaks in tests)
  if (_pendingProcessQueueTimer) {
    clearTimeout(_pendingProcessQueueTimer);
    _pendingProcessQueueTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Helper: attempt cloud fallback when Ollama can't run a task
// ---------------------------------------------------------------------------

/**
 * Attempt cloud fallback when Ollama can't run a task (model not found, OOM, etc.).
 * Returns true if task was requeued to a cloud provider, false if no fallback available.
 * @param {string} taskId - Task ID
 * @param {Object} task - Task object from database
 * @param {string} errorMsg - Error message describing the failure
 * @returns {boolean} True if task was requeued to a cloud provider
 */
function tryOllamaCloudFallback(taskId, task, errorMsg) {
  // Use canonical fallback chain from provider-routing-core (respects user-configured chains).
  // Append remaining CLOUD_PROVIDERS not in chain as safety net — this function's intent is
  // "try ANY available cloud provider", broader than normal fallback.
  const sourceProvider = task.provider || 'ollama';
  const chain = getProviderFallbackChain(sourceProvider, { cloudOnly: true });
  const chainSet = new Set(chain);
  const tail = CLOUD_PROVIDERS.filter(p => !chainSet.has(p));

  // If user configured a specific fallback provider, move it to the head of the chain
  const configuredFallback = serverConfig.get('ollama_fallback_provider');
  let fullChain;
  if (configuredFallback && configuredFallback !== sourceProvider) {
    const rest = [...chain, ...tail].filter(p => p !== configuredFallback);
    fullChain = [configuredFallback, ...rest];
  } else {
    fullChain = [...chain, ...tail];
  }

  // Filter chain to available providers (enabled + not quota-exhausted).
  // codex/claude-cli are gated solely by their dedicated config flags — they don't
  // require a provider_config entry (the old code also skipped getProvider for them).
  const candidates = fullChain.filter(p => {
    try {
      if (p === 'codex') return serverConfig.isOptIn('codex_enabled');
      if (p === 'claude-cli') return serverConfig.getBool('claude_cli_enabled');
      const pConfig = db.getProvider(p);
      if (!pConfig || !pConfig.enabled) return false;
      // Skip free-tier providers in cooldown or quota-exhausted
      if (typeof _getFreeQuotaTracker === 'function') {
        const tracker = _getFreeQuotaTracker();
        const status = tracker.getStatus();
        if (status[p] && !tracker.canSubmit(p)) return false;
      }
      return true;
    } catch { return false; }
  });

  if (candidates.length === 0) return false;

  // Pick the first healthy candidate; fall back to first enabled if all unhealthy
  let fallbackProvider = candidates[0];
  if (typeof db.isProviderHealthy === 'function') {
    const healthy = candidates.find(p => db.isProviderHealthy(p));
    if (healthy) {
      fallbackProvider = healthy;
    } else {
      logger.warn(`[Ollama→Cloud] All ${candidates.length} cloud providers unhealthy, using ${fallbackProvider} anyway`);
    }
  }

  logger.info(`[Ollama→Cloud] Falling back to ${fallbackProvider} for task ${taskId}`);
  db.recordFailoverEvent({ task_id: taskId, from_provider: task.provider, to_provider: fallbackProvider, reason: errorMsg, failover_type: 'provider' });
  db.updateTaskStatus(taskId, 'queued', {
    provider: fallbackProvider,
    model: null,
    started_at: null,
    pid: null,
    progress_percent: 0,
    ollama_host_id: null,
    retry_count: (task.retry_count || 0) + 1,
    error_output: `[Ollama→Cloud] ${errorMsg}\nFalling back to ${fallbackProvider}`
  });
  dashboard.notifyTaskUpdated(taskId);
  _processQueue();
  return true;
}

// ---------------------------------------------------------------------------
// Helper: attempt local-first fallback before escalating to cloud
// ---------------------------------------------------------------------------

/**
 * Detect whether a task description implies creating a new file (greenfield).
 * Raw ollama cannot create new files — it produces instructions instead of code.
 * @param {string} desc - Task description
 * @returns {boolean}
 */
function _isGreenfieldTask(desc) {
  if (!desc) return false;
  return /\b(create|write|generate|scaffold|build)\s+(a\s+)?(new\s+)?(file|test|module|class|component|spec)\b/i.test(desc) ||
    /\bnew\s+(file|test|module|class|component|spec)\b/i.test(desc);
}

/**
 * Attempt local-first fallback before escalating to cloud.
 * Tries: (1) same model on different host, (2) different coder model,
 * (3) different local provider, (4) cloud.
 * Returns true if task was requeued, false if no fallback available.
 * @param {string} taskId - Task ID
 * @param {Object} task - Task object from database
 * @param {string} errorMsg - Error message describing the failure
 * @param {Object} [options={}] - Options
 * @param {boolean} [options.skipSameModel] - Skip step 1 (e.g., stall recovery already tried larger model)
 * @returns {boolean} True if task was requeued
 */
function tryLocalFirstFallback(taskId, task, errorMsg, options = {}) {
  const maxLocalRetries = serverConfig.getInt('max_local_retries', 3);

  // Parse prior local-first attempts from error_output markers
  // Cap input to last 50KB to avoid regex on unbounded strings
  const rawErrors = (task.error_output || '') + (errorMsg || '');
  const priorErrors = rawErrors.length > 50000 ? rawErrors.slice(-50000) : rawErrors;
  const localAttempts = (priorErrors.match(/\[Local-First\]/g) || []).length;

  if (localAttempts >= maxLocalRetries) {
    logger.info(`[Local-First] Task ${taskId}: exhausted ${maxLocalRetries} local retries, escalating to cloud`);
    return tryOllamaCloudFallback(taskId, task, `${errorMsg}\n[Local-First] Exhausted ${maxLocalRetries} local retries`);
  }

  // Preserve original_provider on first fallback
  let metadata = {};
  try { metadata = typeof task.metadata === 'object' && task.metadata !== null ? task.metadata : task.metadata ? JSON.parse(task.metadata) : {}; } catch { /* corrupt metadata */ }
  if (!metadata.original_provider) {
    metadata.original_provider = task.provider;
  }

  const currentHost = task.ollama_host_id;
  const currentModel = task.model;
  const currentProvider = task.provider;

  // Step 1: Same model, different host (exclude current host from selection)
  if (!options.skipSameModel && currentModel && currentHost) {
    try {
      const selection = db.selectOllamaHostForModel(currentModel, { excludeHostIds: [currentHost] });
      const otherHost = selection?.host;
      if (otherHost) {
        logger.info(`[Local-First] Task ${taskId}: trying same model ${currentModel} on different host ${otherHost.name || otherHost.id}`);
        db.recordFailoverEvent({ task_id: taskId, from_host: currentHost, to_host: otherHost.name || otherHost.id, from_model: currentModel, to_model: currentModel, reason: errorMsg, failover_type: 'host', attempt_num: localAttempts + 1 });
        db.updateTaskStatus(taskId, 'queued', {
          provider: currentProvider,
          model: currentModel,
          ollama_host_id: otherHost.id,
          started_at: null,
          pid: null,
          progress_percent: 0,
          metadata: JSON.stringify(metadata),
          error_output: priorErrors + `\n[Local-First] Trying ${currentModel} on host ${otherHost.name || otherHost.id}\n`
        });
        dashboard.notifyTaskUpdated(taskId);
        _processQueue();
        return true;
      }
    } catch (e) {
      logger.info(`[Local-First] Task ${taskId}: host selection failed: ${e.message}`);
    }
  }

  // Step 2: Different coder model on any host (sorted by size, prefer smallest-larger)
  if (typeof db.getAggregatedModels === 'function') {
    try {
      const allModels = db.getAggregatedModels();
      const currentSizeMatch = (currentModel || '').toLowerCase().match(/(\d+)b/);
      const currentSize = currentSizeMatch ? parseInt(currentSizeMatch[1], 10) : 0;

      const coderModels = allModels.filter(m =>
        m.name !== currentModel &&
        /coder|code|deepseek|qwen/i.test(m.name) &&
        !priorErrors.includes(`model ${m.name}`)
      ).map(m => {
        const sizeMatch = (m.name || '').toLowerCase().match(/(\d+)b/);
        const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
        const selection = db.selectOllamaHostForModel(m.name);
        const hostId = selection?.host?.id || m.hosts?.[0]?.id || null;
        return { ...m, size, hostId };
      });

      // Prefer smallest model larger than current; fall back to largest available
      const larger = coderModels.filter(m => m.size > currentSize).sort((a, b) => a.size - b.size);
      const sorted = larger.length > 0 ? larger : coderModels.sort((a, b) => b.size - a.size);

      if (sorted.length > 0) {
        const nextModel = sorted[0];
        const hostId = nextModel.hostId;
        logger.info(`[Local-First] Task ${taskId}: trying different model ${nextModel.name} on host ${nextModel.hosts[0]?.name || 'any'}`);
        db.recordFailoverEvent({ task_id: taskId, from_model: currentModel, to_model: nextModel.name, reason: errorMsg, failover_type: 'model', attempt_num: localAttempts + 1 });
        db.updateTaskStatus(taskId, 'queued', {
          provider: currentProvider,
          model: nextModel.name,
          ollama_host_id: hostId,
          started_at: null,
          pid: null,
          progress_percent: 0,
          metadata: JSON.stringify(metadata),
          error_output: priorErrors + `\n[Local-First] Trying model ${nextModel.name}\n`
        });
        dashboard.notifyTaskUpdated(taskId);
        _processQueue();
        return true;
      }
    } catch (e) {
      logger.info(`[Local-First] Task ${taskId}: model enumeration failed: ${e.message}`);
    }
  }

  // Step 3: Different local provider
  // EXP7: Raw ollama cannot create new files — it produces instructions instead of code.
  // Skip 'ollama' as a fallback candidate when the task is greenfield.
  const isGreenfield = _isGreenfieldTask(task.task_description);
  const localProviders = ['aider-ollama', 'ollama', 'hashline-ollama'];
  const untriedProviders = localProviders.filter(p => {
    if (p === currentProvider) return false;
    if (priorErrors.includes(`provider ${p}`)) return false;
    if (p === 'ollama' && isGreenfield) {
      logger.info(`[Local-First] Task ${taskId}: skipping raw ollama — greenfield tasks need structured edit providers`);
      return false;
    }
    return true;
  });
  if (untriedProviders.length > 0) {
    const nextProvider = untriedProviders[0];
    logger.info(`[Local-First] Task ${taskId}: trying different local provider ${nextProvider}`);
    db.recordFailoverEvent({ task_id: taskId, from_provider: currentProvider, to_provider: nextProvider, reason: errorMsg, failover_type: 'provider', attempt_num: localAttempts + 1 });
    db.updateTaskStatus(taskId, 'queued', {
      provider: nextProvider,
      model: currentModel,
      ollama_host_id: null,
      started_at: null,
      pid: null,
      progress_percent: 0,
      metadata: JSON.stringify(metadata),
      error_output: priorErrors + `\n[Local-First] Trying provider ${nextProvider}\n`
    });
    dashboard.notifyTaskUpdated(taskId);
    _processQueue();
    return true;
  }

  // Step 4: All local options exhausted, fall back to cloud
  logger.info(`[Local-First] Task ${taskId}: all local options exhausted, escalating to cloud`);
  return tryOllamaCloudFallback(taskId, task, `${errorMsg}\n[Local-First] All local options exhausted`);
}

// ---------------------------------------------------------------------------
// Stall recovery
// ---------------------------------------------------------------------------

/**
 * Attempt to recover a stalled task using escalating strategies:
 * 1. Switch edit format (diff -> whole)
 * 2. Switch to larger model (if available)
 * 3. Fallback to cloud provider
 * @param {string} taskId - Task ID
 * @param {Object} activity - Activity info from getTaskActivity
 * @returns {boolean} True if recovery was attempted
 */
function tryStallRecovery(taskId, activity) {
  const maxAttempts = serverConfig.getInt('stall_recovery_max_attempts', 3);
  const recovery = _stallRecoveryAttempts.get(taskId) || { attempts: 0, lastStrategy: null };

  if (recovery.attempts >= maxAttempts) {
    logger.info(`[StallRecovery] Task ${taskId} exceeded max recovery attempts (${maxAttempts}) - stall recovery exhausted`);
    _stallRecoveryAttempts.delete(taskId);
    _cancelTask(taskId, `Stall recovery exhausted after ${recovery.attempts} attempts - no output for ${activity.lastActivitySeconds}s`);
    return false;
  }

  const task = db.getTask(taskId);
  if (!task) {
    logger.info(`[StallRecovery] Task ${taskId} not found in database - cancelling`);
    _cancelTask(taskId, 'Task not found');
    return false;
  }

  const proc = _runningProcesses.get(taskId);
  const currentEditFormat = proc?.editFormat || serverConfig.get('aider_edit_format') || 'diff';
  const currentModel = task.model || 'qwen2.5-coder:14b';
  const currentProvider = task.provider || 'aider-ollama';

  // Determine recovery strategy based on attempt number
  let strategy = null;
  let newSettings = {};

  if (recovery.attempts === 0 && currentEditFormat === 'diff') {
    // Attempt 1: Switch to 'whole' edit format
    strategy = 'switch_edit_format';
    newSettings = { editFormat: 'whole' };
    logger.info(`[StallRecovery] Task ${taskId}: Attempt ${recovery.attempts + 1} - switching edit format diff → whole`);
  } else if (recovery.attempts <= 1 && currentProvider === 'aider-ollama') {
    // Attempt 2: Try larger model if available
    const largerModel = findLargerAvailableModel(currentModel);
    if (largerModel && largerModel !== currentModel) {
      strategy = 'switch_model';
      newSettings = { model: largerModel, editFormat: 'whole' };
      logger.info(`[StallRecovery] Task ${taskId}: Attempt ${recovery.attempts + 1} - switching to larger model ${currentModel} → ${largerModel}`);
    } else {
      // No larger model available, try local-first fallback (skip same model — already tried)
      strategy = 'local_first_fallback';
      logger.info(`[StallRecovery] Task ${taskId}: Attempt ${recovery.attempts + 1} - no larger model, trying local-first fallback`);
      recovery.attempts++;
      recovery.lastStrategy = strategy;
      _stallRecoveryAttempts.set(taskId, recovery);
      _stopTaskForRestart(taskId, `Stall recovery - ${strategy}`);
      tryLocalFirstFallback(taskId, task, `Stall recovery: no larger model available after ${activity.lastActivitySeconds}s stall`, { skipSameModel: true });
      return true;
    }
  } else {
    // Attempt 3+: try local-first fallback before cloud
    strategy = 'local_first_fallback';
    logger.info(`[StallRecovery] Task ${taskId}: Attempt ${recovery.attempts + 1} - trying local-first fallback`);
    recovery.attempts++;
    recovery.lastStrategy = strategy;
    _stallRecoveryAttempts.set(taskId, recovery);
    _stopTaskForRestart(taskId, `Stall recovery - ${strategy}`);
    tryLocalFirstFallback(taskId, task, `Stall recovery: attempt ${recovery.attempts} after ${activity.lastActivitySeconds}s stall`);
    return true;
  }

  // Update recovery tracking
  recovery.attempts++;
  recovery.lastStrategy = strategy;
  _stallRecoveryAttempts.set(taskId, recovery);

  // Stop the current process without marking as cancelled
  _stopTaskForRestart(taskId, `Stall recovery - ${strategy}`);

  // Record structured failover event (RB-029)
  db.recordFailoverEvent({ task_id: taskId, from_provider: task.provider, to_provider: newSettings.provider || task.provider, from_model: task.model, to_model: newSettings.model || task.model, reason: `Stall: ${activity.lastActivitySeconds}s idle, strategy: ${strategy}`, failover_type: 'stall', attempt_num: recovery.attempts });

  // Update task and re-queue with new settings
  const updateFields = {
    status: 'queued',
    started_at: null,
    pid: null,
    progress_percent: 0,
    error_output: (task.error_output || '') + `\n[STALL RECOVERY] Attempt ${recovery.attempts}: ${strategy} after ${activity.lastActivitySeconds}s stall\n`
  };

  if (newSettings.provider) {
    updateFields.provider = newSettings.provider;
  }
  if (newSettings.model !== undefined) {
    updateFields.model = newSettings.model;
  }

  // Store edit format override in task metadata for next run
  if (newSettings.editFormat) {
    let metadata = {};
    try { metadata = typeof task.metadata === 'object' && task.metadata !== null ? task.metadata : task.metadata ? JSON.parse(task.metadata) : {}; } catch { /* corrupt metadata */ }
    metadata.stallRecoveryEditFormat = newSettings.editFormat;
    updateFields.metadata = JSON.stringify(metadata);
  }

  try {
    db.updateTaskStatus(taskId, 'queued', updateFields);
    dashboard.notifyTaskUpdated(taskId);
  } catch (err) {
    // If re-queue fails, mark as failed to prevent zombie 'running' state
    logger.info(`[StallRecovery] Task ${taskId}: failed to re-queue, marking failed: ${err.message}`);
    try { db.updateTaskStatus(taskId, 'failed', { error_output: `Stall recovery re-queue failed: ${err.message}` }); } catch { /* last resort */ }
    return true;
  }

  // Re-queue the task
  setTimeout(() => _processQueue(), STALL_REQUEUE_DEBOUNCE_MS);

  return true;
}

// ---------------------------------------------------------------------------
// Model escalation
// ---------------------------------------------------------------------------

/**
 * Find a larger available model than the current one.
 * Searches through the model size hierarchy (7b -> 8b -> 14b -> 22b -> 32b -> 70b)
 * and returns the first available coder model that is larger.
 * @param {string} currentModel - Current model name (e.g., 'qwen2.5-coder:14b')
 * @returns {string|null} Larger model name or null if none available
 */
function findLargerAvailableModel(currentModel) {
  // Model size hierarchy for common models
  const sizeOrder = ['7b', '8b', '14b', '22b', '32b', '70b'];
  const currentSizeMatch = currentModel.toLowerCase().match(/:?(\d+)b/);
  if (!currentSizeMatch) return null;

  const currentSize = parseInt(currentSizeMatch[1], 10);
  const currentSizeIndex = sizeOrder.findIndex(s => parseInt(s, 10) === currentSize);
  if (currentSizeIndex < 0 || currentSizeIndex >= sizeOrder.length - 1) return null;

  // Check what models are available
  try {
    const availableModels = db.getAggregatedModels ? db.getAggregatedModels() : [];
    for (let i = currentSizeIndex + 1; i < sizeOrder.length; i++) {
      const targetSize = sizeOrder[i];
      // Find a model with the target size
      const match = availableModels.find(m => {
        const name = m.name.toLowerCase();
        const hosts = Array.isArray(m.hosts) ? m.hosts : [];
        const hasHealthyHost = hosts.length === 0 || hosts.some(h => {
          const status = (h.status || 'healthy').toLowerCase();
          const enabled = h.enabled;
          const hostEnabled = enabled === undefined || enabled === null || enabled === 1 || enabled === true;
          return status === 'healthy' && hostEnabled;
        });

        return hasHealthyHost && name.includes(targetSize) && name.includes('coder');
      });
      if (match) return match.name;
    }
  } catch (e) {
    logger.info(`[StallRecovery] Error finding larger model: ${e.message}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Hashline model capability and format selection
// ---------------------------------------------------------------------------

/**
 * Check if a model is on the hashline-capable allowlist.
 * Models not on the list hallucinate hashes and should not be used for hashline editing.
 * @param {string} model - Model name to check (e.g., 'qwen2.5-coder:7b')
 * @returns {boolean} True if the model is hashline-capable
 */
function isHashlineCapableModel(model) {
  const capableStr = serverConfig.get('hashline_capable_models') || '';
  if (!capableStr) return true; // No allowlist configured = allow all
  const capableModels = capableStr.split(',').map(m => m.trim().toLowerCase()).filter(Boolean);
  const modelLower = (model || '').toLowerCase();
  const baseModel = modelLower.split(':')[0];
  return capableModels.some(capable => {
    return modelLower === capable || modelLower.startsWith(capable + ':') || baseModel === capable;
  });
}

/**
 * Find the next larger hashline-capable model available on any healthy host.
 * Prefers the smallest model larger than the current one.
 * Falls back to any untried hashline-capable model if no larger one exists.
 * @param {string} currentModel - Current model name (e.g., 'qwen2.5-coder:7b')
 * @param {string} priorErrors - Accumulated error_output to check for already-tried models
 * @returns {{ name: string, hostId: string|null } | null}
 */
function findNextHashlineModel(currentModel, priorErrors) {
  if (typeof db.getAggregatedModels !== 'function') return null;

  try {
    const allModels = db.getAggregatedModels();

    // Parse current model size
    const currentSizeMatch = (currentModel || '').toLowerCase().match(/(\d+)b/);
    const currentSize = currentSizeMatch ? parseInt(currentSizeMatch[1], 10) : 0;

    // Filter to hashline-capable, untried models
    const candidates = allModels
      .filter(m => {
        if (m.name === currentModel) return false;
        if (!isHashlineCapableModel(m.name)) return false;
        if (priorErrors.includes(`model ${m.name}`)) return false;
        return true;
      })
      .map(m => {
        const sizeMatch = (m.name || '').toLowerCase().match(/(\d+)b/);
        const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
        // Use optimal host selection instead of arbitrary first host
        const selection = db.selectOllamaHostForModel(m.name);
        const hostId = selection?.host?.id || m.hosts?.[0]?.id || null;
        return { name: m.name, hostId, size };
      });

    // Prefer larger models, sorted smallest-larger-first
    const larger = candidates.filter(m => m.size > currentSize).sort((a, b) => a.size - b.size);
    if (larger.length > 0) return { name: larger[0].name, hostId: larger[0].hostId };

    // No larger model — try any untried capable model (largest first)
    const any = candidates.sort((a, b) => b.size - a.size);
    if (any.length > 0) return { name: any[0].name, hostId: any[0].hostId };
  } catch (e) {
    logger.info(`[Hashline-Local] Error finding next model: ${e.message}`);
  }

  return null;
}

/**
 * Tiered fallback for hashline tasks.
 * Tries local model escalation before leaving the machine:
 *   1. Same model on different host (for host-related failures)
 *   2. Larger hashline-capable local model
 *   3. hashline-openai (if auth available)
 *   4. codex (always available)
 *
 * Tracks attempts via [Hashline-Local] markers in error_output.
 * Configurable max retries via max_hashline_local_retries (default: 2).
 * @param {string} taskId - Task ID
 * @param {Object} task - Task object from database
 * @param {string} reason - Reason for fallback
 * @returns {boolean} True if task was requeued
 */
function tryHashlineTieredFallback(taskId, task, reason) {
  // Guard: don't requeue tasks that are already in a terminal state
  try {
    const freshTask = db.getTask(taskId);
    if (freshTask && (freshTask.status === 'cancelled' || freshTask.status === 'completed')) {
      logger.info(`[HashlineFallback] Skipping fallback for task ${taskId.slice(0,8)}: already ${freshTask.status}`);
      return false;
    }
  } catch { /* proceed with stale data if getTask fails */ }

  const currentProvider = task.provider || 'hashline-ollama';

  // ── Local model escalation (hashline-ollama only) ──
  if (currentProvider === 'hashline-ollama') {
    const rawErrors = (task.error_output || '') + `\n${reason}`;
    const priorErrors = rawErrors.length > 50000 ? rawErrors.slice(-50000) : rawErrors;
    const localAttempts = (priorErrors.match(/\[Hashline-Local\]/g) || []).length;
    const maxRetries = serverConfig.getInt('max_hashline_local_retries', 2);

    if (localAttempts < maxRetries) {
      const currentModel = task.model || serverConfig.get('ollama_model') || DEFAULT_FALLBACK_MODEL;
      const currentHost = task.ollama_host_id;

      // Step 1: Same model, different host (skip for model-capability issues, exclude current host)
      if (!reason.includes('not hashline-capable') && currentHost) {
        try {
          const selection = db.selectOllamaHostForModel(currentModel, { excludeHostIds: [currentHost] });
          const otherHost = selection?.host;
          if (otherHost) {
            logger.info(`[Hashline-Local] Task ${taskId.slice(0,8)}: trying ${currentModel} on different host ${otherHost.name || otherHost.id}`);
            db.recordFailoverEvent({ task_id: taskId, from_host: currentHost, to_host: otherHost.name || otherHost.id, from_model: currentModel, to_model: currentModel, reason, failover_type: 'host', attempt_num: localAttempts + 1 });
            db.updateTaskStatus(taskId, 'queued', {
              provider: 'hashline-ollama',
              model: currentModel,
              ollama_host_id: otherHost.id,
              pid: null, started_at: null,
              error_output: priorErrors + `\n[Hashline-Local] Trying ${currentModel} on host ${otherHost.name || otherHost.id}`
            });
            dashboard.notifyTaskUpdated(taskId);
            scheduleProcessQueue(task);
            return true;
          }
        } catch (e) {
          logger.info(`[Hashline-Local] Host selection failed for task ${taskId.slice(0,8)}: ${e.message}`);
        }
      }

      // Step 2: Larger/different hashline-capable model
      const nextModel = findNextHashlineModel(currentModel, priorErrors);
      if (nextModel) {
        logger.info(`[Hashline-Local] Task ${taskId.slice(0,8)}: upgrading from ${currentModel} to ${nextModel.name}`);
        db.recordFailoverEvent({ task_id: taskId, from_model: currentModel, to_model: nextModel.name, reason, failover_type: 'model', attempt_num: localAttempts + 1 });
        db.updateTaskStatus(taskId, 'queued', {
          provider: 'hashline-ollama',
          model: nextModel.name,
          ollama_host_id: nextModel.hostId,
          pid: null, started_at: null,
          error_output: priorErrors + `\n[Hashline-Local] Trying model ${nextModel.name}`
        });
        dashboard.notifyTaskUpdated(taskId);
        scheduleProcessQueue(task);
        return true;
      }
    }

    // Step 3: hashline-openai (existing cloud escalation)
    const hashlineOpenai = db.getProvider('hashline-openai');
    let hasOpenaiAuth = !!process.env.OPENAI_API_KEY;
    if (!hasOpenaiAuth) {
      try {
        const homedir = require('os').homedir();
        const apiAuthPath = path.join(homedir, '.codex', 'api.auth.json');
        const authPath = path.join(homedir, '.codex', 'auth.json');
        hasOpenaiAuth = fs.existsSync(apiAuthPath) || fs.existsSync(authPath);
      } catch { /* ignore */ }
    }
    if (hashlineOpenai && hashlineOpenai.enabled && hasOpenaiAuth) {
    logger.info(`[HashlineFallback] Escalating task ${taskId.slice(0,8)} to hashline-openai: ${reason}`);
    db.recordFailoverEvent({ task_id: taskId, from_provider: 'hashline-ollama', to_provider: 'hashline-openai', reason, failover_type: 'provider', attempt_num: localAttempts + 1 });
    db.updateTaskStatus(taskId, 'queued', {
      provider: 'hashline-openai',
      _provider_switch_reason: reason,
      pid: null, started_at: null, ollama_host_id: null, model: null,
      error_output: (task.error_output || '') + `\nEscalated from hashline-ollama: ${reason}`
    });
      dashboard.notifyTaskUpdated(taskId);
      scheduleProcessQueue(task);
      return true;
    }
  }

  // Step 4: codex (final fallback, always available)
  logger.info(`[HashlineFallback] Escalating task ${taskId.slice(0,8)} to codex: ${reason}`);
  db.recordFailoverEvent({ task_id: taskId, from_provider: currentProvider, to_provider: 'codex', reason, failover_type: 'provider' });
  db.updateTaskStatus(taskId, 'queued', {
    provider: 'codex',
    _provider_switch_reason: reason,
    pid: null, started_at: null, ollama_host_id: null, model: null,
    error_output: (task.error_output || '') + `\nEscalated from ${currentProvider}: ${reason}`
  });
  dashboard.notifyTaskUpdated(taskId);
  scheduleProcessQueue(task);
  return true;
}

/**
 * Select the best hashline edit format for a model.
 * Priority: explicit config override > metadata override > success rate auto-routing > default
 * @param {string} model - Model name
 * @param {Object} [task] - Task object (for metadata overrides)
 * @returns {{ format: string, reason: string }} Selected format and reason
 */
function selectHashlineFormat(model, task) {
  // 1. Check metadata override (set by fallback chain)
  if (task && task.metadata) {
    try {
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
      if (meta.hashline_format_override) {
        return { format: meta.hashline_format_override, reason: 'fallback_override' };
      }
    } catch { /* ignore */ }
  }

  // 2. Check explicit per-model config
  try {
    const modelFormats = serverConfig.getJson('hashline_model_formats', {});
    // Check exact model match first, then base model
    if (modelFormats[model]) {
      return { format: modelFormats[model], reason: 'config_override' };
    }
    const baseModel = model.split(':')[0];
    if (modelFormats[baseModel]) {
      return { format: modelFormats[baseModel], reason: 'config_override_base' };
    }
  } catch { /* ignore */ }

  // 3. Auto-learning: if model has 3+ parse/format failures, force standard hashline
  try {
    if (typeof db.getModelFormatFailures === 'function') {
      const formatFailures = db.getModelFormatFailures(3);
      const modelFailures = formatFailures.filter(f =>
        f.model_name === model || model.startsWith(f.model_name.split(':')[0])
      );
      if (modelFailures.length > 0) {
        const totalFailures = modelFailures.reduce((sum, f) => sum + f.failure_count, 0);
        logger.info(`[selectHashlineFormat] Auto-learned: ${model} has ${totalFailures} format failures, forcing hashline`);
        return { format: 'hashline', reason: `auto_learned (${totalFailures} format failures)` };
      }
    }
  } catch (e) {
    logger.info(`[selectHashlineFormat] Format auto-learn check failed: ${e.message}`);
  }

  // 4. Auto-routing based on success rates
  const autoSelect = serverConfig.isOptIn('hashline_format_auto_select');
  if (autoSelect) {
    const best = db.getBestFormatForModel(model);
    if (best.format) {
      return { format: best.format, reason: `auto_${best.reason}` };
    }
  }

  // 5. Default to standard hashline
  return { format: 'hashline', reason: 'default' };
}

// ---------------------------------------------------------------------------
// Error classification for retry logic
// ---------------------------------------------------------------------------

/**
 * Classify an error as retryable (transient) or non-retryable (permanent).
 * Used by the close handler to decide whether to retry a failed task.
 * @param {string} errorOutput - stderr/error output from the process
 * @param {number} exitCode - Process exit code
 * @returns {{ retryable: boolean, reason: string, retryAfterSeconds?: number }}
 */
function classifyError(errorOutput, exitCode) {
  const errorText = errorOutput || '';
  const errorLower = errorText.toLowerCase();
  const truncated = errorText.slice(0, 1200);
  const retryAfterMatch = errorLower.match(/retry_after_seconds=(\d+)/);
  const retryAfterSeconds = retryAfterMatch ? Number.parseInt(retryAfterMatch[1], 10) : null;

  const makeResult = (retryable, reason) => {
    if (retryAfterSeconds === null) return { retryable, reason };
    return { retryable, reason, retryAfterSeconds };
  };

  // === NON-RETRYABLE ERRORS (permanent failures) ===
  const matchesPattern = (text, pattern) => {
    if (pattern instanceof RegExp) return pattern.test(text);
    return text.includes(pattern);
  };

  const NON_RETRYABLE_PATTERNS = [
    // Git/repo issues that won't resolve on retry
    { pattern: 'not inside a trusted directory', reason: 'Not a trusted git directory' },
    { pattern: 'not a git repository', reason: 'Not a git repository' },
    { pattern: 'permission denied', reason: 'Permission denied' },
    { pattern: 'access denied', reason: 'Access denied' },
    // Syntax/logic errors in the task itself
    { pattern: 'syntax error', reason: 'Syntax error in task' },
    { pattern: 'command not found', reason: 'Command not found' },
    { pattern: 'no such file or directory', reason: 'File or directory not found' },
    // Authentication issues that need user intervention
    { pattern: 'authentication failed', reason: 'Authentication failed' },
    { pattern: 'invalid credentials', reason: 'Invalid credentials' },
    { pattern: 'unauthorized', reason: 'Unauthorized' },
    // API key issues
    { pattern: 'invalid api key', reason: 'Invalid API key' },
    { pattern: 'api key not found', reason: 'API key not found' },
    { pattern: 'openai_api_key', reason: 'OpenAI API key issue' },
    // Disk/filesystem failures (permanent without intervention)
    { pattern: /disk full|no space left on device/i, reason: 'Disk full' },
    { pattern: /read-only file system/i, reason: 'Read-only filesystem' },
    // Module/dependency resolution (code issue, not transient)
    { pattern: /cannot find module|module not found/i, reason: 'Module not found' },
    { pattern: /cannot resolve|resolution failed/i, reason: 'Dependency resolution failed' },
    // Type/compile errors (code issue)
    { pattern: /type error|typeerror/i, reason: 'Type error' },
    { pattern: /reference error|referenceerror/i, reason: 'Reference error' },
    // Configuration errors
    { pattern: /invalid configuration|config.*invalid/i, reason: 'Invalid configuration' },
    { pattern: /missing required.*config/i, reason: 'Missing configuration' },
  ];

  for (const { pattern, reason } of NON_RETRYABLE_PATTERNS) {
    if (matchesPattern(errorLower, pattern)) {
      return makeResult(false, reason);
    }
  }

  // === RETRYABLE ERRORS (transient failures) ===
  const RETRYABLE_PATTERNS = [
    // Network/connectivity issues
    { pattern: 'econnreset', reason: 'Connection reset' },
    { pattern: 'econnrefused', reason: 'Connection refused' },
    { pattern: 'etimedout', reason: 'Connection timed out' },
    { pattern: 'enetunreach', reason: 'Network unreachable' },
    { pattern: 'socket hang up', reason: 'Socket hang up' },
    { pattern: 'network error', reason: 'Network error' },
    // Rate limiting
    { pattern: 'rate limit', reason: 'Rate limited' },
    { pattern: '429', reason: 'Too many requests' },
    { pattern: 'too many requests', reason: 'Rate limited' },
    // Temporary server issues
    { pattern: '500', reason: 'Server error' },
    { pattern: '502', reason: 'Bad gateway' },
    { pattern: '503', reason: 'Service unavailable' },
    { pattern: '504', reason: 'Gateway timeout' },
    { pattern: 'internal server error', reason: 'Server error' },
    { pattern: 'service unavailable', reason: 'Service unavailable' },
    // Resource contention
    { pattern: 'resource busy', reason: 'Resource busy' },
    { pattern: 'try again', reason: 'Temporary failure' },
    { pattern: 'temporarily unavailable', reason: 'Temporarily unavailable' },
  ];

  for (const { pattern, reason } of RETRYABLE_PATTERNS) {
    if (matchesPattern(errorLower, pattern)) {
      return makeResult(true, reason);
    }
  }

  // Heuristic: errors containing stack traces are likely code bugs (non-retryable)
  if (/at \w+\s+\(/.test(truncated) || /TypeError:|ReferenceError:|RangeError:/.test(truncated)) {
    return makeResult(false, 'Code error detected in output - not retryable');
  }

  // Heuristic: errors mentioning file paths are likely permanent
  if (/ENOENT|no such file|file not found/i.test(truncated)) {
    return makeResult(false, 'File not found - not retryable');
  }

  // Heuristic: disk space errors
  if (/ENOSPC|no space left|disk full/i.test(truncated)) {
    return makeResult(false, 'Disk space exhausted - not retryable');
  }

  // Heuristic: out of memory
  if (/ENOMEM|out of memory|heap out of memory|JavaScript heap/i.test(truncated)) {
    return makeResult(true, 'Out of memory - may recover with smaller input');
  }

  // Exit code 1 without clear error pattern might be transient
  if (exitCode === 1 && errorText.length < 100) {
    return makeResult(true, 'Unknown short error - may be transient');
  }

  let retryUnknown = false;
  try { retryUnknown = serverConfig.isOptIn('unknown_error_retryable'); } catch { /* config not initialized */ }
  if (errorText.length > 500 && !retryUnknown) {
    return makeResult(false, 'Long unknown error treated as non-retryable');
  }

  // For longer errors without known patterns, be conservative
  return makeResult(true, 'Unknown error - attempting retry');
}

module.exports = {
  init,
  setFreeQuotaTracker,
  tryOllamaCloudFallback,
  tryLocalFirstFallback,
  tryStallRecovery,
  findLargerAvailableModel,
  isHashlineCapableModel,
  findNextHashlineModel,
  tryHashlineTieredFallback,
  selectHashlineFormat,
  classifyError,
  BASE_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  getRetryDelayMs,
};
