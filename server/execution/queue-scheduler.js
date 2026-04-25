'use strict';

/**
 * Queue Scheduler Module
 *
 * Extracted from task-manager.js (Phase 10A) — smart queue processing with
 * host capacity awareness, VRAM-aware scheduling, provider categorization,
 * and P71/P77/P92 fallback logic.
 *
 * Uses init() dependency injection for database, task-manager internals.
 */

const logger = require('../logger').child({ component: 'queue-scheduler' });
const { getEffectiveGlobalMaxConcurrent: sharedGetEffective } = require('./effective-concurrency');
const { classifyTaskType } = require('../db/model-capabilities');
const providerRegistry = require('../providers/registry');
const serverConfig = require('../config');
const gpuMetrics = require('../scripts/gpu-metrics-server');
const { normalizeMetadata } = require('../utils/normalize-metadata');
const { DEFAULT_FALLBACK_MODEL } = require('../constants');
const { resolveOllamaModel } = require('../providers/ollama-shared');
const modelRoles = require('../db/model-roles');
const eventBus = require('../event-bus');
const { isRestartBarrierActive } = require('./restart-barrier');

// Dependency injection
let db = null;
let _attemptTaskStart = null;
let _safeStartTask = null;
let _safeConfigInt = null;
let _isLargeModelBlockedOnHost = null;
let _getProviderInstance = null;
let _getFreeQuotaTracker = null;
let _cleanupOrphanedRetryTimeouts = null;
let _notifyDashboard = null;
let _analyzeTaskForRouting = null;
let _debounceTimer = null;
let _stopped = false;
let _queueChangedListener = null;
let _lastQueueProcessAt = 0;
let _lastAutoScaleActivation = 0;

let lastBudgetResetCheck = 0;

// Cross-cycle TTL cache for provider limit lookups (db.getProvider is expensive per-cycle)
// Invalidated every 10s so config changes take effect promptly
let _providerLimitTTLCache = new Map();
let _providerLimitCacheTs = 0;
const PROVIDER_LIMIT_CACHE_TTL_MS = 10000;
const QUEUE_CHANGED_EVENT = 'torque:queue-changed';
const QUEUE_CHANGED_LISTENER_TAG = Symbol.for('torque.queueChangedListener');
const EXIT_CLEANUP_LISTENER_TAG = Symbol.for('torque.queueSchedulerExitCleanup');
const FREE_PROVIDERS = Object.freeze([
  'groq',
  'cerebras',
  'google-ai',
  'openrouter',
  'ollama-cloud',
]);

/**
 * ALL providers that cost $0 to use — cloud free tiers + local Ollama on LAN.
 * Use this when routing with a "prefer free" constraint.
 * FREE_PROVIDERS (above) is the cloud-API-only subset for overflow/retry logic.
 */
const COST_FREE_PROVIDERS = Object.freeze([
  ...FREE_PROVIDERS,
  'ollama',
]);
const FILE_LOCK_WAIT_METADATA_KEY = 'file_lock_wait';

function removeStaleQueueChangedListeners() {
  for (const listener of process.listeners(QUEUE_CHANGED_EVENT)) {
    if (listener && listener[QUEUE_CHANGED_LISTENER_TAG]) {
      process.removeListener(QUEUE_CHANGED_EVENT, listener);
    }
  }
}

function notifyDashboard(taskId, updates = {}) {
  if (!taskId || typeof _notifyDashboard !== 'function') return;
  try {
    _notifyDashboard(taskId, updates);
  } catch {
    // Dashboard refresh is best-effort for scheduler-side task rewrites.
  }
}

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 */
function init(deps) {
  if (deps.db) db = deps.db;
  if (deps.db) serverConfig.init({ db: deps.db });
  if (deps.attemptTaskStart) _attemptTaskStart = deps.attemptTaskStart;
  if (deps.safeStartTask) _safeStartTask = deps.safeStartTask;
  if (deps.safeConfigInt) _safeConfigInt = deps.safeConfigInt;
  if (deps.isLargeModelBlockedOnHost) _isLargeModelBlockedOnHost = deps.isLargeModelBlockedOnHost;
  if (deps.getProviderInstance) _getProviderInstance = deps.getProviderInstance;
  if (deps.getFreeQuotaTracker) _getFreeQuotaTracker = deps.getFreeQuotaTracker;
  if (deps.cleanupOrphanedRetryTimeouts) _cleanupOrphanedRetryTimeouts = deps.cleanupOrphanedRetryTimeouts;
  if (deps.analyzeTaskForRouting) _analyzeTaskForRouting = deps.analyzeTaskForRouting;
  _notifyDashboard = typeof deps.notifyDashboard === 'function' ? deps.notifyDashboard : null;

  _stopped = false;

  removeStaleQueueChangedListeners();

  // Remove previous listener if init() is called multiple times
  if (_queueChangedListener) {
    process.removeListener(QUEUE_CHANGED_EVENT, _queueChangedListener);
  }
  _lastQueueProcessAt = 0;
  _queueChangedListener = () => {
    if (_stopped) return;
    if (!_debounceTimer) {
      _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        if (!_stopped) processQueueInternal({ fromQueueChangedEvent: true });
      }, 15);
    }
  };
  _queueChangedListener[QUEUE_CHANGED_LISTENER_TAG] = true;
  process.on(QUEUE_CHANGED_EVENT, _queueChangedListener);
  ensureExitCleanup();
}

function normalizeTaskStartOutcome(result) {
  if (result && typeof result === 'object' && (
    Object.prototype.hasOwnProperty.call(result, 'started')
    || Object.prototype.hasOwnProperty.call(result, 'queued')
    || Object.prototype.hasOwnProperty.call(result, 'pendingAsync')
    || Object.prototype.hasOwnProperty.call(result, 'failed')
  )) {
    return {
      started: result.started === true,
      queued: result.queued === true,
      pendingAsync: result.pendingAsync === true,
      failed: result.failed === true,
      reason: result.reason,
      code: result.code,
      error: result.error,
    };
  }

  return {
    started: Boolean(result),
    queued: false,
    pendingAsync: false,
    failed: !result,
  };
}

function attemptTaskStart(taskId, label) {
  if (typeof _attemptTaskStart === 'function') {
    return normalizeTaskStartOutcome(_attemptTaskStart(taskId, label));
  }
  if (typeof _safeStartTask === 'function') {
    return normalizeTaskStartOutcome(_safeStartTask(taskId, label));
  }
  return { started: false, queued: false, pendingAsync: false, failed: true };
}

/**
 * Stop the queue scheduler — clears timers and removes event listener.
 * Safe to call multiple times.
 */
function stop() {
  _stopped = true;
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_queueChangedListener) {
    process.removeListener(QUEUE_CHANGED_EVENT, _queueChangedListener);
    _queueChangedListener = null;
  }
  _lastQueueProcessAt = 0;
}

// Safety net: remove listener on process exit to prevent leak during abnormal shutdown
let _exitCleanupRegistered = false;
function ensureExitCleanup() {
  if (_exitCleanupRegistered) return;
  for (const listener of process.listeners('exit')) {
    if (listener && listener[EXIT_CLEANUP_LISTENER_TAG]) {
      _exitCleanupRegistered = true;
      return;
    }
  }

  _exitCleanupRegistered = true;
  const listener = () => {
    if (_queueChangedListener) {
      process.removeListener(QUEUE_CHANGED_EVENT, _queueChangedListener);
      _queueChangedListener = null;
    }
  };
  listener[EXIT_CLEANUP_LISTENER_TAG] = true;
  process.once('exit', listener);
}

/**
 * Categorize queued tasks by provider type for processing.
 *
 * @param {object[]} queuedTasks - Array of queued task records
 * @param {boolean} codexEnabled - Whether codex execution is enabled
 * @returns {{ ollamaTasks: object[], codexTasks: object[], apiTasks: object[] }}
 */
function resolveEffectiveProvider(task) {
  if (typeof task?.provider === 'string' && task.provider.trim()) {
    return task.provider.trim().toLowerCase();
  }
  // Deferred assignment: read intended_provider from metadata
  try {
    const meta = normalizeMetadata(task?.metadata);
    if (meta?.intended_provider) {
      return meta.intended_provider.trim().toLowerCase();
    }
  } catch { /* invalid metadata */ }
  return '';
}

function hasProviderSelectionLock(metadata = {}) {
  return Boolean(
    metadata.user_provider_override
    || metadata.provider_selection_locked
    || metadata.agentic_handoff
    || metadata._routing_template
  );
}

function getFileLockWaitUntilMs(task) {
  const metadata = normalizeMetadata(task?.metadata);
  const wait = metadata[FILE_LOCK_WAIT_METADATA_KEY];
  if (!wait || typeof wait !== 'object' || Array.isArray(wait)) {
    return null;
  }

  const retryAfterMs = Date.parse(wait.retry_after);
  return Number.isFinite(retryAfterMs) ? retryAfterMs : null;
}

function shouldSkipTaskForFileLockWait(task, nowMs = Date.now()) {
  const retryAfterMs = getFileLockWaitUntilMs(task);
  return Number.isFinite(retryAfterMs) && retryAfterMs > nowMs;
}

function categorizeQueuedTasks(queuedTasks, codexEnabled) {
  const ollamaTasks = [];
  const codexTasks = [];
  const apiTasks = [];
  const invalidTasks = [];

  for (const task of queuedTasks) {
    let provider = resolveEffectiveProvider(task);
    if (provider === 'codex-pending') continue;

    // Late-bind routing: if task has no provider (e.g., requeued orphan,
    // retry with cleared provider), run smart routing to assign one.
    if (!provider && typeof _analyzeTaskForRouting === 'function') {
      try {
        const files = Array.isArray(task.files) ? task.files : [];
        const routeResult = _analyzeTaskForRouting(task.task_description || '', task.working_directory, files);
        if (routeResult && routeResult.provider) {
          provider = routeResult.provider;
          // Persist the assignment so the task carries its provider through execution
          db.updateTaskStatus(task.id, 'queued', { provider });
          logger.info(`[categorize] Late-bind routed task ${(task.id || '').slice(0,8)} to ${provider} (${routeResult.reason})`);
        }
      } catch (routeErr) {
        logger.info(`[categorize] Late-bind routing failed for ${(task.id || '').slice(0,8)}: ${routeErr.message}`);
      }
    }

    // Stamp effective provider on in-memory object for downstream processing
    task._effectiveProvider = provider;

    const category = providerRegistry.getCategory(provider);

    if (!category) {
      invalidTasks.push(task);
      continue;
    }

    if (category === 'codex') {
      if (provider === 'codex' && !codexEnabled) {
        // When codex is disabled, only keep explicit-intent tasks in queue.
        const meta = normalizeMetadata(task.metadata);
        const hasExplicitIntent = meta.user_provider_override || !!meta._routing_template;
        if (hasExplicitIntent) {
          codexTasks.push(task);
          logger.info(`[categorize] Explicit-intent codex task ${(task.id || '').slice(0,8)} kept in queue despite codex disabled`);
        }
      } else {
        codexTasks.push(task);
      }
    } else if (category === 'api') {
      apiTasks.push(task);
    } else {
      ollamaTasks.push(task);
    }
  }

  return { ollamaTasks, codexTasks, apiTasks, invalidTasks };
}

function failQueuedTask(task, message) {
  if (!task?.id || !db || typeof db.updateTaskStatus !== 'function') {
    return false;
  }

  try {
    db.updateTaskStatus(task.id, 'failed', { error_output: message });
    notifyDashboard(task.id, { status: 'failed', error_output: message });
    logger.warn(`[queue] Failed queued task ${task.id}: ${message}`);
    return true;
  } catch (err) {
    logger.warn(`[queue] Failed to mark queued task ${task?.id || 'unknown'} as failed: ${err.message}`);
    return false;
  }
}

function shouldSkipTaskForApproval(task) {
  if (!task) return false;

  // 'not_required' and 'approved' are both allowed to proceed; only 'pending'/'rejected' block
  if (task.approval_status && task.approval_status !== 'approved' && task.approval_status !== 'not_required') {
    return true;
  }

  if (!db || typeof db.checkApprovalRequired !== 'function' || !task.id) return false;

  try {
    const approvalStatus = db.checkApprovalRequired(task.id);
    if (approvalStatus && approvalStatus.required && approvalStatus.status !== 'approved') {
      if (approvalStatus.status === 'pending') {
        logger.info(`[queue] Task ${task.id} awaiting approval — skipping`);
      }
      return true;
    }
  } catch (_err) {
    void _err;
    // Non-fatal: if approval service fails, keep scheduler permissive to avoid hard deadlock
    return false;
  }

  return false;
}

function getEffectiveGlobalMaxConcurrent(preRead = {}) {
  return sharedGetEffective({
    preRead,
    safeConfigInt: _safeConfigInt,
    serverConfig,
    db,
    logger,
  });
}

// NOTE: parsePositiveInt rejects 0 (returns fallback). For running-task counts
// where 0 is a valid, meaningful value, always pass 0 as the fallback so that
// a genuine 0 from the DB returns 0 rather than null (see usage at line ~377).
function parsePositiveInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createProviderRuntimeState(runningAll = []) {
  const observedRunningByProvider = new Map();
  const providerLimitCache = new Map();
  const providerRunningCache = new Map();
  const providerStartedCounts = new Map();

  for (const task of runningAll) {
    const provider = typeof task?.provider === 'string' ? task.provider.trim().toLowerCase() : '';
    if (!provider) continue;
    observedRunningByProvider.set(provider, (observedRunningByProvider.get(provider) || 0) + 1);
  }

  function getProviderLimit(provider, fallbackLimit = null) {
    const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    if (!normalizedProvider) return parsePositiveInt(fallbackLimit, null);
    // Per-cycle cache hit (fastest path)
    if (providerLimitCache.has(normalizedProvider)) {
      return providerLimitCache.get(normalizedProvider);
    }
    // Cross-cycle TTL cache: avoids db.getProvider on every scheduling cycle
    const now = Date.now();
    if (now - _providerLimitCacheTs > PROVIDER_LIMIT_CACHE_TTL_MS) {
      _providerLimitTTLCache = new Map();
      _providerLimitCacheTs = now;
    }
    if (_providerLimitTTLCache.has(normalizedProvider)) {
      const cached = _providerLimitTTLCache.get(normalizedProvider);
      providerLimitCache.set(normalizedProvider, cached);
      return cached;
    }

    const providerConfig = typeof db?.getProvider === 'function'
      ? db.getProvider(normalizedProvider)
      : null;
    // Issue #11 fix: max_concurrent=0 means "disabled" (reject all tasks), not unlimited.
    // parsePositiveInt rejects 0 and returns the fallback, which would make 0 act as unlimited.
    // Detect 0 explicitly before calling parsePositiveInt.
    const rawMaxConcurrent = providerConfig?.max_concurrent;
    if (Number.parseInt(rawMaxConcurrent, 10) === 0) {
      // 0 = provider disabled: cache and return 0 so getProviderCapacity sees limit=0 → unavailable
      providerLimitCache.set(normalizedProvider, 0);
      _providerLimitTTLCache.set(normalizedProvider, 0);
      return 0;
    }
    const providerLimit = parsePositiveInt(
      rawMaxConcurrent,
      parsePositiveInt(fallbackLimit, null),
    );
    providerLimitCache.set(normalizedProvider, providerLimit);
    _providerLimitTTLCache.set(normalizedProvider, providerLimit);
    return providerLimit;
  }

  function getProviderRunningCount(provider) {
    const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    if (!normalizedProvider) return 0;
    if (providerRunningCache.has(normalizedProvider)) {
      return providerRunningCache.get(normalizedProvider);
    }

    const runningCount = typeof db?.getRunningCountByProvider === 'function'
      ? parsePositiveInt(db.getRunningCountByProvider(normalizedProvider), 0)
      : (observedRunningByProvider.get(normalizedProvider) || 0);
    providerRunningCache.set(normalizedProvider, runningCount);
    return runningCount;
  }

  // Providers that share the same GPU — running count must be unified
  const _gpuSharingProviders = new Set(['ollama']);

  function getProviderCapacity(provider, fallbackLimit = null) {
    const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    const limit = getProviderLimit(normalizedProvider, fallbackLimit);
    const started = providerStartedCounts.get(normalizedProvider) || 0;

    // GPU-sharing providers: count running tasks across ALL providers that share the GPU
    let running;
    if (_gpuSharingProviders.has(normalizedProvider)) {
      running = 0;
      for (const gp of _gpuSharingProviders) {
        running += getProviderRunningCount(gp) + (providerStartedCounts.get(gp) || 0);
      }
    } else {
      running = getProviderRunningCount(normalizedProvider) + started;
    }

    // limit === 0 means "disabled" (issue #11) — never available
    // limit === null means "no limit configured" — always available
    // limit > 0 means "explicit cap" — available if running < limit
    const available = limit === 0 ? false : (!(Number.isFinite(limit) && limit > 0) || running < limit);
    return {
      limit,
      running,
      available,
    };
  }

  function recordStart(provider) {
    const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    if (!normalizedProvider) return;
    providerStartedCounts.set(normalizedProvider, (providerStartedCounts.get(normalizedProvider) || 0) + 1);
  }

  return {
    getProviderCapacity,
    recordStart,
  };
}

/**
 * Periodically check and reset expired budgets (at most once per minute).
 * Extracted from processQueueInternal for clarity.
 */
function checkBudgetReset() {
  const now = Date.now();
  if (now - lastBudgetResetCheck > 60000) {
    lastBudgetResetCheck = now;
    try { db.resetExpiredBudgets(); } catch (err) {
      logger.info(`[Scheduler] Budget reset check failed: ${err.message}`);
    }
  }
}

/**
 * Route queued Codex tasks to quota providers only after Codex capacity
 * has been confirmed full.
 *
 * @param {object[]} codexTasks - Mutable array of codex tasks; rerouted tasks are spliced out
 * @param {{ runningCodexCount?: number, maxCodexConcurrent?: number }} capacity
 * @returns {number} Count of rerouted tasks
 */
function attemptFreeProviderOverflow(codexTasks, capacity = {}) {
  if (codexTasks.length === 0 || typeof _getFreeQuotaTracker !== 'function') return 0;

  const autoScaleEnabled = serverConfig.isOptIn('quota_auto_scale_enabled');
  if (!autoScaleEnabled) return 0;

  const runningCodexCount = Number(capacity.runningCodexCount) || 0;
  const maxCodexConcurrent = Number(capacity.maxCodexConcurrent) || 0;
  if (maxCodexConcurrent <= 0 || runningCodexCount < maxCodexConcurrent) return 0;

  const cooldownSec = serverConfig.getInt('quota_cooldown_seconds', 60);
  const codexQueueDepth = codexTasks.length;

  const nowMs = Date.now();
  if ((nowMs - _lastAutoScaleActivation) < cooldownSec * 1000) return 0;

  const tracker = _getFreeQuotaTracker();
  if (typeof tracker.getAvailableProvidersSmart !== 'function' && typeof tracker.getAvailableProviders !== 'function') return 0;

  let autoScaleCount = 0;

  for (let i = codexTasks.length - 1; i >= 0; i--) {
    const task = codexTasks[i];
    try {
      const metadata = normalizeMetadata(task.metadata);

      if (task?.user_provider_override || hasProviderSelectionLock(metadata)) continue;
      if (!metadata.smart_routing && !metadata.auto_routed) continue;

      const taskComplexity = metadata.complexity || 'normal';
      if (taskComplexity === 'complex') continue;

      const taskType = classifyTaskType(task.task_description);
      const freeProviders = typeof tracker.getAvailableProvidersSmart === 'function'
        ? tracker.getAvailableProvidersSmart({ complexity: 'normal', taskType })
        : tracker.getAvailableProviders();

      if (freeProviders.length === 0) continue;
      const target = freeProviders[0];
      const statusUpdates = {
        provider: target.provider,
        model: null,
        metadata: JSON.stringify({
          ...metadata,
          overflow: true,
          original_provider: 'codex',
          quota_overflow: true,
          quota_auto_scale: true,
        }),
        // TDA-02: narrate auto-scale movement
        _provider_switch_reason: `codex -> ${target.provider} (quota auto-scale, taskType=${taskType})`,
      };
      db.updateTaskStatus(task.id, 'queued', statusUpdates);
      notifyDashboard(task.id, { status: 'queued', ...statusUpdates });
      codexTasks.splice(i, 1);
      autoScaleCount++;
      logger.info(`processQueue: quota auto-scale → ${target.provider} for ${task.id.slice(0,8)} (slots=${runningCodexCount}/${maxCodexConcurrent}, queue_depth=${codexQueueDepth}, taskType=${taskType})`);
    } catch (e) {
      logger.debug(`processQueue: auto-scale metadata parse error for ${task.id.slice(0,8)}: ${e.message}`);
    }
  }

  if (autoScaleCount > 0) {
    _lastAutoScaleActivation = nowMs;
    logger.info(`processQueue: quota auto-scale activated — rerouted ${autoScaleCount} task(s), slots=${runningCodexCount}/${maxCodexConcurrent}, queue_depth=${codexQueueDepth}`);
  }
  return autoScaleCount;
}

/**
 * When Codex slots are full, attempt to overflow a single task to local Ollama
 * or quota API providers. Only reroutes tasks that weren't user-specified.
 *
 * @param {object} codexTask - The codex task to try overflowing
 * @returns {boolean} True if task was rerouted (caller should `continue`)
 */
function attemptCodexOverflow(codexTask) {
  const overflowEnabled = serverConfig.getBool('codex_overflow_to_local');
  if (!overflowEnabled) return false;

  try {
    const metadata = normalizeMetadata(codexTask.metadata);

    if (hasProviderSelectionLock(metadata)) {
      logger.info(`processQueue: skipping overflow for provider-locked Codex task ${codexTask.id.slice(0,8)}`);
      return false;
    }

    const taskComplexity = metadata.complexity || 'normal';
    const maxOverflowComplexity = serverConfig.get('overflow_max_complexity') || 'normal';
    const overflowEligible = (taskComplexity === 'simple') ||
      (taskComplexity === 'normal' && maxOverflowComplexity !== 'simple');

    if (!overflowEligible) return false;

    // Try local Ollama hosts first
    const localHosts = db.listOllamaHosts({ enabled: true })
      .filter(h => h.status === 'healthy' && (h.running_tasks || 0) < (h.max_concurrent || 1));

    if (localHosts.length > 0) {
      const tierName = taskComplexity === 'simple' ? 'fast' : 'balanced';
      let localModel = serverConfig.get(`ollama_${tierName}_model`);
      if (!localModel) {
        try { localModel = modelRoles.getModelForRole('ollama', tierName) || modelRoles.getModelForRole('ollama', 'default'); } catch (_e) { void _e; }
      }
      if (!localModel) localModel = resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL;
      const statusUpdates = {
        provider: 'ollama',
        model: localModel,
        metadata: JSON.stringify({ ...metadata, overflow: true, original_provider: 'codex' }),
        // TDA-02: narrate the movement with a specific reason
        _provider_switch_reason: `codex -> ollama (codex overflow to local LLM, complexity=${taskComplexity})`,
      };
      db.updateTaskStatus(codexTask.id, 'queued', statusUpdates);
      notifyDashboard(codexTask.id, { status: 'queued', ...statusUpdates });
      logger.info(`processQueue: Codex overflow → local LLM for ${codexTask.id.slice(0,8)} (${taskComplexity})`);
      return true;
    }

    // Free-tier API overflow: try free providers if local LLM unavailable
    if (typeof _getFreeQuotaTracker === 'function') {
      const tracker = _getFreeQuotaTracker();
      const taskType = classifyTaskType(codexTask.task_description);
      const freeProviders = typeof tracker.getAvailableProvidersSmart === 'function'
        ? tracker.getAvailableProvidersSmart({ complexity: taskComplexity, taskType })
        : tracker.getAvailableProviders();
      if (freeProviders.length > 0) {
        const target = freeProviders[0];
        const statusUpdates = {
          provider: target.provider,
          model: null,
          metadata: JSON.stringify({ ...metadata, overflow: true, original_provider: 'codex', quota_overflow: true }),
          // TDA-02: narrate the movement with a specific reason
          _provider_switch_reason: `codex -> ${target.provider} (codex overflow to quota, complexity=${taskComplexity}, taskType=${taskType})`,
        };
        db.updateTaskStatus(codexTask.id, 'queued', statusUpdates);
        notifyDashboard(codexTask.id, { status: 'queued', ...statusUpdates });
        logger.info(`processQueue: Codex overflow -> quota ${target.provider} for ${codexTask.id.slice(0,8)} (${taskComplexity}, taskType=${taskType})`);
        return true;
      }
    }
  } catch (e) {
    logger.debug(`processQueue: overflow metadata parse error: ${e.message}`);
  }
  return false;
}

/**
 * P71/P92/P77 queue-time fallback: when primary host is at capacity,
 * try a fallback model on an idle host.
 * - P92: Skip if user explicitly specified a model
 * - P77: Skip for async-heavy tasks (qwen3:8b async keyword bug)
 * @param {object} task - Task record from DB
 * @param {string} model - Current model name
 * @param {object} selection - Host selection result with atCapacity flag
 * @returns {{ started: boolean, count: number }}
 */
function tryOllamaQueueFallback(task, model, selection) {
  if (!selection || !selection.atCapacity) {
    return { started: false, count: 0 };
  }

  try {
    const metadata = normalizeMetadata(task.metadata);
    const isUserSpecifiedModel = !metadata.smart_routing && task.model;
    if (isUserSpecifiedModel) {
      logger.info(`processQueue: P92 skipping P71 fallback for user-specified model '${model}' on task ${task.id.slice(0,8)} — host at capacity, task stays queued`);
      return { started: false, count: 0 };
    }

    const complexity = metadata.complexity || 'normal';
    const tierName = complexity === 'simple' ? 'fast' : complexity === 'normal' ? 'balanced' : 'quality';
    const fallbackModel = serverConfig.get(`ollama_${tierName}_model_fallback`);
    if (fallbackModel && fallbackModel !== model) {
      const asyncPattern = /\b(async|await|Promise\b|\.then\(|\.catch\()\b/i;
      if (asyncPattern.test(task.task_description || '')) {
        logger.info(`processQueue: P77 skip fallback for async task ${task.id.slice(0,8)}`);
        return { started: false, count: 0 };
      }

      const fallbackSel = db.selectOllamaHostForModel(fallbackModel);
      if (fallbackSel.host) {
        db.updateTaskStatus(task.id, 'queued', { model: fallbackModel });
        notifyDashboard(task.id, { status: 'queued', model: fallbackModel });
        const startOutcome = attemptTaskStart(task.id, 'P71-fallback');
        if (startOutcome.started) {
          logger.info(`processQueue: P71 fallback ${task.id.slice(0,8)}: ${model}→${fallbackModel} on ${fallbackSel.host.name}`);
          return { started: true, count: 1 };
        }

        db.updateTaskStatus(task.id, 'queued', { model: model });
        notifyDashboard(task.id, { status: 'queued', model });
      }
    }
  } catch (e) {
    logger.debug(`processQueue: P71 fallback metadata parse error for ${task.id.slice(0,8)}: ${e.message}`);
  }

  return { started: false, count: 0 };
}

/**
 * Internal queue processing logic - called only when lock is held.
 */
function processQueueInternal(options = {}) {
  // Restart barrier — must be checked BEFORE the slot-pull delegation so both
  // scheduling modes honor it. Slot-pull also re-checks inside runSlotPullPass()
  // because its heartbeat bypasses this function entirely.
  const barrier = isRestartBarrierActive(db);
  if (barrier) {
    logger.info(`[Scheduler] Restart barrier active (task ${(barrier.id || '').slice(0, 8)}), skipping queue processing`);
    return;
  }

  const schedulingMode = db.getConfig ? (db.getConfig('scheduling_mode') || 'legacy') : 'legacy';
  if (schedulingMode === 'slot-pull') {
    const slotPull = require('./slot-pull-scheduler');
    slotPull.onSlotFreed();
    return;
  }

  const {
    skipRecentProcessGuard = false,
    fromQueueChangedEvent = false,
  } = options;
  if (!skipRecentProcessGuard && !fromQueueChangedEvent) {
    const now = Date.now();
    if (now - _lastQueueProcessAt < 100) {
      return;
    }
    _lastQueueProcessAt = now;
  }

  // Guard against calls after DB has been closed (e.g., event-driven timer in tests)
  if (_stopped || !db || typeof db.getRunningCount !== 'function') return;

  // Expire stale queued tasks
  const queueTtlMinutes = _safeConfigInt ? _safeConfigInt('queue_task_ttl_minutes', 0) : 0;
  if (queueTtlMinutes > 0 && db && typeof db.getExpiredQueuedTasks === 'function') {
    let expired = [];
    try {
      const cutoff = new Date(Date.now() - queueTtlMinutes * 60000).toISOString();
      expired = db.getExpiredQueuedTasks(cutoff);
    } catch (ttlErr) {
      logger.warn(`[queue] TTL expiry query failed: ${ttlErr.message}`);
    }

    for (const task of expired) {
      try {
        db.updateTaskStatus(task.id, 'failed', {
          error_output: 'Expired: exceeded queue TTL',
        });
        notifyDashboard(task.id, { status: 'failed', error_output: 'Expired: exceeded queue TTL' });
        logger.info(`[queue] Task ${task.id} expired after ${queueTtlMinutes} minutes in queue`);
        eventBus.emitTaskEvent({ taskId: task.id, type: 'failed', reason: 'queue_ttl_expired' });
      } catch (err) {
        logger.warn(`[queue] Failed to expire task ${task.id}: ${err.message}`);
      }
    }
  }

  checkBudgetReset();

  // Periodically clean up orphaned retry timeouts to prevent memory leaks
  if (_cleanupOrphanedRetryTimeouts) _cleanupOrphanedRetryTimeouts();

  const maxOllamaConcurrent = _safeConfigInt('max_ollama_concurrent', 8);
  const maxCodexConcurrent = _safeConfigInt('max_codex_concurrent', 6);
  const maxApiConcurrent = _safeConfigInt('max_api_concurrent', 4);
  const maxConcurrent = getEffectiveGlobalMaxConcurrent({ maxOllamaConcurrent, maxCodexConcurrent, maxApiConcurrent });
  const maxPerHost = _safeConfigInt('max_per_host', 4);

  // Global capacity guard — skip DB lookup if system is at full capacity
  const running = db.getRunningCount ? db.getRunningCount() : 0;
  if (running >= maxConcurrent) return;

  // Resource pressure gating - defer task starts when system is overloaded
  const resourceGatingEnabled = db.getConfig ? db.getConfig('resource_gating_enabled') : null;
  if (resourceGatingEnabled === '1' && gpuMetrics.isUnderPressure()) {
    const level = gpuMetrics.getPressureLevel();
    logger.warn(`[Scheduler] Deferring queued task starts due to ${level} resource pressure`);
    return;
  }

  // Get multiple queued tasks to find one that can run on an available host
  const queuedTasks = db.listQueuedTasksLightweight
    ? db.listQueuedTasksLightweight(1000)
    : db.listTasks({ status: 'queued', limit: 1000 });
  if (queuedTasks.length === 0) return;

  // Queue-age telemetry: compute max and average queue wait times
  const now = Date.now();
  const runnableQueuedTasks = queuedTasks.filter(task => !shouldSkipTaskForFileLockWait(task, now));
  if (runnableQueuedTasks.length === 0) return;

  const queueAges = runnableQueuedTasks
    .filter(t => t.created_at)
    .map(t => (now - new Date(t.created_at).getTime()) / 1000);
  if (queueAges.length > 0) {
    const maxAge = Math.max(...queueAges);
    const avgAge = queueAges.reduce((a, b) => a + b, 0) / queueAges.length;
    if (maxAge > 60) {
      logger.info(`[Scheduler] Queue telemetry: ${queueAges.length} queued, max_age=${Math.round(maxAge)}s, avg_age=${Math.round(avgAge)}s`);
    }
  }

  // Get current host capacity
  // Check if codex execution is enabled (config: codex_enabled = '1')
  const codexEnabled = serverConfig.isOptIn('codex_enabled');

  // Separate tasks by provider type
  const { ollamaTasks, codexTasks, apiTasks, invalidTasks } = categorizeQueuedTasks(runnableQueuedTasks, codexEnabled);

  for (const task of invalidTasks) {
    const providerLabel = typeof task?.provider === 'string' && task.provider.trim()
      ? task.provider.trim()
      : '(missing)';
    failQueuedTask(task, `Unknown provider: ${providerLabel}`);
  }

  // Independent concurrency limits per provider type
  const runningTasks = db.listTasks({ status: 'running', limit: 200 });
  const runningAll = Array.isArray(runningTasks) ? runningTasks : (runningTasks.tasks || []);
  // Single-pass provider counts (RB-096) — uses registry for category lookup
  const providerCounts = { ollama: 0, codex: 0, api: 0 };
  for (const t of runningAll) {
    const category = providerRegistry.getCategory(t.provider || '');
    if (category) providerCounts[category]++;
  }
  const providerRuntimeState = createProviderRuntimeState(runningAll);

  let ollamaStarted = 0;
  let codexStarted = 0;
  let apiStarted = 0;

  // Try to start Ollama tasks — limited only by per-host capacity (independent of Codex/API)
  // Issue #10 fix: all Ollama tasks share the same GPU.
  // providerCounts.ollama aggregates both via providerRegistry.getCategory(), making
  // runningOllama a unified GPU total. The explicit set below documents the provider
  // that shares the GPU constraint and guards against future category mapping changes.
  const _ollamaGpuProviders = new Set(['ollama']);
  // Unified GPU oversubscription check: count all running tasks across GPU-sharing providers
  const totalOllamaRunning = runningAll.filter(t => _ollamaGpuProviders.has(t.provider)).length;
  const runningOllama = totalOllamaRunning; // alias — providerCounts.ollama equals this
  logger.debug(`processQueue: ollamaTasks=${ollamaTasks.length} codexTasks=${codexTasks.length} apiTasks=${apiTasks.length} codexEnabled=${codexEnabled} runningOllama=${runningOllama}`);
  for (const task of ollamaTasks) {
    if (shouldSkipTaskForApproval(task)) {
      continue;
    }

    if (runningOllama + ollamaStarted >= maxOllamaConcurrent) break;
    const effectiveOllamaProvider = task._effectiveProvider || task.provider;
    const providerCapacity = providerRuntimeState.getProviderCapacity(effectiveOllamaProvider, maxOllamaConcurrent);
    if (!providerCapacity.available) {
      logger.debug(`processQueue: skipping ollama provider=${effectiveOllamaProvider} task ${task.id.slice(0,8)} provider slots full (${providerCapacity.running}/${providerCapacity.limit})`);
      continue;
    }

    let model = task.model;
    if (!model) {
      try {
        const registry = require('../models/registry');
        const best = registry.selectBestApprovedModel(task._effectiveProvider || task.provider);
        if (best) model = best.model_name;
      } catch (_e) { void _e; /* registry not available */ }
    }
    if (!model) {
      try { model = modelRoles.getModelForRole(task._effectiveProvider || task.provider || 'ollama', 'default'); } catch (_e) { void _e; }
    }
    if (!model) model = resolveOllamaModel(task, null) || DEFAULT_FALLBACK_MODEL;
    let selection = db.selectOllamaHostForModel(model);

    // If default model isn't available, try any host with any model
    if (!selection.host && !task.model) {
      selection = db.selectOllamaHostForModel(null);
      if (selection.host) {
        logger.info(`[Scheduler] Default model '${model}' unavailable, using host '${selection.host.name}' with available models`);
      }
    }

    let started = false;

    if (selection.host) {
      const hostRunning = selection.host.running_tasks || 0;
      logger.debug(`processQueue: Ollama task ${task.id.slice(0,8)} model=${model} host=${selection.host.name} hostRunning=${hostRunning} maxPerHost=${maxPerHost}`);

      // VRAM-aware scheduling: prevent co-scheduling multiple large models on same host.
      const vramCheck = hostRunning > 0 ? _isLargeModelBlockedOnHost(model, selection.host.id) : { blocked: false };
      if (vramCheck.blocked) {
        logger.info(`processQueue: ${vramCheck.reason} on ${selection.host.name}`);
      }

      if (hostRunning < maxPerHost && !vramCheck.blocked) {
        const startOutcome = attemptTaskStart(task.id, 'ollama');
        if (startOutcome.started) {
          ollamaStarted++;
          providerRuntimeState.recordStart(effectiveOllamaProvider);
          started = true;
          logger.debug(`processQueue: started ollama task ${task.id.slice(0,8)}, ollamaStarted=${ollamaStarted}`);
        } else if (startOutcome.failed && startOutcome.reason === 'preflight_failed') {
          logger.warn(`processQueue: ollama task ${task.id.slice(0,8)} marked failed by preflight (${startOutcome.code || 'PREFLIGHT_FAILED'}) — not retrying`);
          started = true; // Treat as "handled" so P71/P92 fallback doesn't also fire on it
        }
      }
    } else {
      logger.debug(`processQueue: no host for model=${model}: ${selection.reason}`);
    }

    // P71/P92/P77 queue-time fallback
    if (!started && selection.atCapacity) {
      const fallbackResult = tryOllamaQueueFallback(task, model, selection);
      if (fallbackResult.started) {
        ollamaStarted += fallbackResult.count;
      }
    }
  }

  // Try to start Codex/Claude-CLI tasks — independent of Ollama/API
  if (codexEnabled && codexTasks.length > 0) {
    const runningCodex = providerCounts.codex;
    const pendingFreeProviderOverflow = [];

    for (const codexTask of codexTasks) {
      if (shouldSkipTaskForApproval(codexTask)) {
        continue;
      }

      if (runningCodex + codexStarted >= maxCodexConcurrent) {
        // Codex slots full — try overflow to local LLM or quota
        if (attemptCodexOverflow(codexTask)) continue;
        pendingFreeProviderOverflow.push(codexTask);
        continue; // Ineligible for overflow — skip, check remaining tasks
      }
      const effectiveCodexProvider = codexTask._effectiveProvider || codexTask.provider;
      const providerCapacity = providerRuntimeState.getProviderCapacity(effectiveCodexProvider, maxCodexConcurrent);
      if (!providerCapacity.available) {
        logger.debug(`processQueue: skipping codex provider=${effectiveCodexProvider} task ${codexTask.id.slice(0,8)} provider slots full (${providerCapacity.running}/${providerCapacity.limit})`);
        continue;
      }
      const startOutcome = attemptTaskStart(codexTask.id, 'codex');
      if (startOutcome.started) {
        codexStarted++;
        providerRuntimeState.recordStart(effectiveCodexProvider);
        logger.info(`processQueue: starting codex task ${codexTask.id.slice(0,8)}: ${(codexTask.task_description || '').slice(0,50)}...`);
        continue;
      }
      if (startOutcome.pendingAsync) {
        continue;
      }
      if (startOutcome.failed && startOutcome.reason === 'preflight_failed') {
        logger.warn(`processQueue: codex task ${codexTask.id.slice(0,8)} marked failed by preflight (${startOutcome.code || 'PREFLIGHT_FAILED'}) — not retrying`);
        continue;
      }

      if (startOutcome.reason === 'capacity' || startOutcome.reason === 'no_slot') {
        pendingFreeProviderOverflow.push(codexTask);
      }
    }

    const runningOrStartedCodex = runningCodex + codexStarted;
    if (pendingFreeProviderOverflow.length > 0 && runningOrStartedCodex >= maxCodexConcurrent) {
      attemptFreeProviderOverflow(pendingFreeProviderOverflow, {
        runningCodexCount: runningOrStartedCodex,
        maxCodexConcurrent,
      });
    }
  }

  // Try to start API provider tasks (anthropic, groq, hyperbolic, deepinfra) — independent of Ollama/Codex
  const runningApi = providerCounts.api;
  for (const task of apiTasks) {
    if (shouldSkipTaskForApproval(task)) {
      continue;
    }

    if (runningApi + apiStarted >= maxApiConcurrent) break;
    const effectiveApiProvider = task._effectiveProvider || task.provider;
    const providerCapacity = providerRuntimeState.getProviderCapacity(effectiveApiProvider, maxApiConcurrent);
    if (!providerCapacity.available) {
      logger.debug(`processQueue: skipping api provider=${effectiveApiProvider} task ${task.id.slice(0,8)} provider slots full (${providerCapacity.running}/${providerCapacity.limit})`);
      continue;
    }
    const getPI = _getProviderInstance || providerRegistry.getProviderInstance;
    const providerInstance = getPI(effectiveApiProvider);
    if (!providerInstance) {
      logger.debug(`processQueue: skipping api provider=${effectiveApiProvider} task ${task.id.slice(0,8)} provider instance unavailable`);
      continue;
    }
    const startOutcome = attemptTaskStart(task.id, 'API');
    if (startOutcome.started) {
      apiStarted++;
      providerRuntimeState.recordStart(effectiveApiProvider);
      continue;
    }
    if (startOutcome.pendingAsync) {
      continue;
    }
    if (startOutcome.failed && startOutcome.reason === 'preflight_failed') {
      logger.warn(`processQueue: api task ${task.id.slice(0,8)} marked failed by preflight (${startOutcome.code || 'PREFLIGHT_FAILED'}) — not retrying`);
      continue;
    }
  }

  // Fallback: if nothing started and there are tasks, scan the queued list in
  // order. If the head task re-queues synchronously, keep moving so it does not
  // starve later runnable work in the same pass.
  const totalStarted = ollamaStarted + codexStarted + apiStarted;
  if (totalStarted === 0) {
    const queueHead = db.getNextQueuedTask();
    if (!queueHead) {
      return;
    }

    const queueHeadIndex = runnableQueuedTasks.findIndex((task) => task.id === queueHead.id);
    const fallbackTasks = queueHeadIndex >= 0
      ? runnableQueuedTasks.slice(queueHeadIndex)
      : runnableQueuedTasks;

    for (const nextTask of fallbackTasks) {
      // Check provider-specific limits before blindly starting
      const effectiveProvider = nextTask.provider || nextTask._effectiveProvider;
      if (!effectiveProvider) continue;
      const provider = effectiveProvider;
      const category = providerRegistry.getCategory(provider);

      let canStart = true;
      if (!category) {
        canStart = false;
      } else if (category === 'codex') {
        if (!codexEnabled) {
          canStart = false;
        } else {
          const runCodex = providerCounts.codex || 0;
          if (runCodex >= maxCodexConcurrent) canStart = false;
        }
      } else if (category === 'ollama') {
        const runOllama = providerCounts.ollama;
        if (runOllama >= maxOllamaConcurrent) canStart = false;
        const providerCapacity = providerRuntimeState.getProviderCapacity(provider, maxOllamaConcurrent);
        if (!providerCapacity.available) canStart = false;
      } else if (category === 'api') {
        if (runningApi + apiStarted >= maxApiConcurrent) canStart = false;
        const providerCapacity = providerRuntimeState.getProviderCapacity(provider, maxApiConcurrent);
        if (!providerCapacity.available) canStart = false;
        const getPI = _getProviderInstance || providerRegistry.getProviderInstance;
        if (!getPI(provider)) canStart = false;
      }

      if (shouldSkipTaskForApproval(nextTask)) {
        canStart = false;
      }

      if (canStart) {
        const startOutcome = attemptTaskStart(nextTask.id, 'fallback');
        if (startOutcome.started || startOutcome.pendingAsync) {
          break;
        }
        if (startOutcome.failed && startOutcome.reason === 'preflight_failed') {
          logger.warn(`processQueue: fallback task ${nextTask.id.slice(0,8)} marked failed by preflight (${startOutcome.code || 'PREFLIGHT_FAILED'}) — not retrying`);
          continue;
        }
      }
    }
  }
}

/**
 * Resolve tasks stuck in 'codex-pending' provider state.
 * These tasks are excluded from queue processing and have no producer path,
 * so they can be stuck indefinitely. On startup, re-route them to a viable
 * cloud provider or fail them if none is available.
 *
 * Respects user_provider_override: if a task was explicitly submitted with a
 * provider (e.g., codex via a workflow node), re-route to the intended_provider
 * from metadata instead of blindly assigning ollama-cloud.
 */
function resolveCodexPendingTasks() {
  if (!db || (typeof db.isReady === 'function' && !db.isReady())) return;
  try {
    const stuck = db.listTasks({ status: 'queued', limit: 100 })
      .filter(t => t.provider === 'codex-pending');

    if (stuck.length === 0) return;

    logger.info(`[Scheduler] Found ${stuck.length} task(s) stuck in codex-pending state`);

    const codexEnabled = serverConfig.isOptIn('codex_enabled');

    for (const task of stuck) {
      try {
        // Check metadata for explicit intent — respect the original route.
        const meta = normalizeMetadata(task.metadata);
        const intendedProvider = meta.intended_provider || null;
        const isTemplateIntent = !!meta._routing_template;
        const hasExplicitIntent = !!meta.user_provider_override || isTemplateIntent;

        let targetProvider;
        if (hasExplicitIntent && intendedProvider) {
          targetProvider = intendedProvider;
        } else if (codexEnabled) {
          targetProvider = 'codex';
        } else {
          // No explicit intent and codex is disabled — fail rather than
          // silently re-routing to an unrelated provider category
          const statusUpdates = {
            error_output: '[codex-pending] Codex is disabled and no intended_provider was set. Task was stuck in codex-pending state with no producer path.',
            completed_at: new Date().toISOString()
          };
          db.updateTaskStatus(task.id, 'failed', statusUpdates);
          notifyDashboard(task.id, { status: 'failed', ...statusUpdates });
          logger.info(`[Scheduler] Failed codex-pending task ${task.id} — codex disabled, no intended_provider`);
          continue;
        }

        const targetConfig = db.getProvider ? db.getProvider(targetProvider) : null;
        if (targetConfig && targetConfig.enabled) {
          db.updateTaskStatus(task.id, 'queued', { provider: targetProvider });
          notifyDashboard(task.id, { status: 'queued', provider: targetProvider });
          logger.info(`[Scheduler] Re-routed codex-pending task ${task.id} to ${targetProvider}${hasExplicitIntent ? ' (explicit intent)' : ''}`);
        } else {
          const statusUpdates = {
            error_output: `[codex-pending] Target provider '${targetProvider}' is not available. Task was stuck in codex-pending state with no producer path.`,
            completed_at: new Date().toISOString()
          };
          db.updateTaskStatus(task.id, 'failed', statusUpdates);
          notifyDashboard(task.id, { status: 'failed', ...statusUpdates });
          logger.info(`[Scheduler] Failed codex-pending task ${task.id} — target provider '${targetProvider}' unavailable`);
        }
      } catch (e) {
        logger.info(`[Scheduler] Failed to re-route task ${task.id}: ${e.message}`);
      }
    }
  } catch (e) {
    logger.info(`[Scheduler] Error resolving codex-pending tasks: ${e.message}`);
  }
}

// ── Factory (DI Phase 3) ─────────────────────────────────────────────────

function createQueueScheduler(_deps) {
  // _deps reserved for dependency-boundary follow-up
  return {
    FREE_PROVIDERS,
    COST_FREE_PROVIDERS,
    init,
    normalizeTaskStartOutcome,
    attemptTaskStart,
    stop,
    resolveEffectiveProvider,
    categorizeQueuedTasks,
    shouldSkipTaskForApproval,
    shouldSkipTaskForFileLockWait,
    processQueueInternal,
    resolveCodexPendingTasks,
    _getLastAutoScaleActivation: () => _lastAutoScaleActivation,
    _resetAutoScaleCooldown: () => { _lastAutoScaleActivation = 0; },
  };
}

module.exports = {
  FREE_PROVIDERS,
  COST_FREE_PROVIDERS,
  init,
  normalizeTaskStartOutcome,
  attemptTaskStart,
  stop,
  resolveEffectiveProvider,
  categorizeQueuedTasks,
  shouldSkipTaskForApproval,
  shouldSkipTaskForFileLockWait,
  processQueueInternal,
  resolveCodexPendingTasks,
  // Exposed for testing auto-scale cooldown
  _getLastAutoScaleActivation: () => _lastAutoScaleActivation,
  _resetAutoScaleCooldown: () => { _lastAutoScaleActivation = 0; },
  createQueueScheduler,
};
