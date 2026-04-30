'use strict';

const logger = require('../logger').child({ component: 'provider-routing' });
const { safeJsonParse } = require('../utils/json');
const serverConfig = require('../config');
const providerRegistry = require('../providers/registry');
const {
  createSharedFactoryStore,
  deriveLearningScope,
  DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE,
} = require('./shared-factory-store');
const {
  computeSharedLearningPenalty,
  SHARED_LEARNING_MIN_CONFIDENCE,
  SHARED_LEARNING_MIN_SAMPLES,
  SHARED_LEARNING_MAX_PENALTY,
} = require('./provider-scoring');

// Extracted modules
const smartRouting = require('./smart-routing');
const ollamaHealth = require('./ollama-health');
const { buildPrometheusMetrics } = require('./provider-routing-metrics');

let templateStore = null;
try {
  templateStore = require('../routing/template-store');
} catch {
  templateStore = null;
}

let providerScoring = null;
function setProviderScoring(scoring) { providerScoring = scoring || null; }

let sharedFactoryStore = null;
let ownedSharedFactoryStore = null;
function setSharedFactoryStore(store) {
  sharedFactoryStore = store || null;
}

let circuitBreakerInstance = null;
function setCircuitBreaker(cb) { circuitBreakerInstance = cb || null; }

let db;
let getTaskFn;
let hostManagementFns;
let lastEffectiveMaxConcurrentWarningKey = null;
const getDatabaseConfig = (...args) => {
  if (typeof db?.getConfig === 'function') {
    return db.getConfig(...args);
  }
  return require('./config-core').getConfig(...args);
};

const DEFAULT_GLOBAL_MAX_CONCURRENT = 20;

// Shared dependency bundle passed to extracted modules
function _buildDeps() {
  return {
    getDatabaseConfig,
    getProvider,
    getTask: (id) => getTaskFn(id),
    setConfig,
    getDefaultProvider,
    getHostManagementFns: () => hostManagementFns,
    isOllamaHealthy: ollamaHealth.isOllamaHealthy,
    getFallbackChain: smartRouting.getProviderFallbackChain,
    getDb: () => db,
    getCircuitBreaker: () => circuitBreakerInstance,
    rankProviderCandidatesByScore: _rankProviderCandidatesByScore,
  };
}

function _initExtractedModules() {
  const deps = _buildDeps();
  smartRouting.init(deps);
  ollamaHealth.init(deps);
}

function setDb(dbInstance) {
  db = dbInstance;
  try {
    serverConfig.init({ db: dbInstance });
  } catch (_e) { /* config may not be initialized in isolated tests */ }
  // Cascade db to extracted modules
  providerHealthHistory.setDb(dbInstance);
  providerRoutingExtras.setDb(dbInstance);
  // Pass db to template store (table creation and seeding handled by schema-seeds.js)
  if (templateStore && typeof templateStore.setDb === 'function') {
    templateStore.setDb(dbInstance);
  }
  // Re-init extracted modules with updated db reference
  _initExtractedModules();
}
function setGetTask(fn) { getTaskFn = fn; _initExtractedModules(); }
function setHostManagement(fns) { hostManagementFns = fns; _initExtractedModules(); }

function _extractChainProvider(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  return entry.provider || null;
}

function _getProviderScoringService() {
  if (providerScoring && typeof providerScoring.getAllProviderScores === 'function') {
    return providerScoring;
  }

  try {
    // Lazy fallback covers legacy database bootstrap paths that do not use the
    // DI container but still initialize provider-routing-core directly.
    const scoring = require('./provider-scoring');
    if (db && typeof scoring.init === 'function') {
      scoring.init(db);
    }
    return scoring;
  } catch (_err) {
    return null;
  }
}

function _getTrustedProviderScoreMap() {
  const scoring = _getProviderScoringService();
  if (!scoring || typeof scoring.getAllProviderScores !== 'function') {
    return new Map();
  }

  try {
    if (db && typeof scoring.init === 'function') {
      scoring.init(db);
    }
    const rows = scoring.getAllProviderScores({ trustedOnly: true });
    if (!Array.isArray(rows) || rows.length === 0) {
      return new Map();
    }
    return new Map(
      rows
        .filter((row) => row && row.provider && Number(row.trusted) === 1)
        .map((row) => [row.provider, Number(row.composite_score) || 0]),
    );
  } catch (_err) {
    return new Map();
  }
}

function _getSharedFactoryStore() {
  if (sharedFactoryStore) return sharedFactoryStore;

  try {
    const { defaultContainer } = require('../container');
    if (
      defaultContainer
      && typeof defaultContainer.has === 'function'
      && typeof defaultContainer.get === 'function'
      && defaultContainer.has('sharedFactoryStore')
    ) {
      return defaultContainer.get('sharedFactoryStore');
    }
  } catch (_err) {
    // Container may be unavailable in isolated routing tests.
  }

  if (ownedSharedFactoryStore) return ownedSharedFactoryStore;

  const hasDataDir = typeof db?.getDataDir === 'function';
  let configuredPath = null;
  try {
    configuredPath = getDatabaseConfig('shared_factory_db_path');
  } catch (_err) {
    configuredPath = null;
  }
  if (!hasDataDir && !(typeof configuredPath === 'string' && configuredPath.trim())) {
    return null;
  }

  try {
    ownedSharedFactoryStore = createSharedFactoryStore({
      config: db,
      dataDir: hasDataDir ? db.getDataDir() : undefined,
    });
    return ownedSharedFactoryStore;
  } catch (_err) {
    return null;
  }
}

function _getSharedProviderLearningPenalties(learningScope, options = {}) {
  const scopeKey = learningScope?.scope_key || learningScope?.scopeKey;
  if (!scopeKey) return new Map();

  const store = options.sharedFactoryStore || _getSharedFactoryStore();
  if (!store || typeof store.listLearnings !== 'function') return new Map();

  let rows = [];
  try {
    rows = store.listLearnings({
      signal_type: DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE,
      scope_key: scopeKey,
      minConfidence: SHARED_LEARNING_MIN_CONFIDENCE,
      now: options.now,
      limit: 100,
    });
  } catch (_err) {
    return new Map();
  }
  if (!Array.isArray(rows) || rows.length === 0) return new Map();

  const penalties = new Map();
  for (const row of rows) {
    if (!row || row.signal_type !== DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE) continue;
    if ((Number(row.sample_count) || 0) < SHARED_LEARNING_MIN_SAMPLES) continue;
    const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
    if (!provider) continue;

    const penalty = computeSharedLearningPenalty(row);
    if (penalty <= 0) continue;

    const current = penalties.get(provider) || {
      provider,
      penalty: 0,
      scope_key: scopeKey,
      learnings: [],
    };
    current.penalty = Math.min(SHARED_LEARNING_MAX_PENALTY, current.penalty + penalty);
    current.learnings.push(row);
    penalties.set(provider, current);
  }

  return penalties;
}

function _rankProviderCandidatesByScore(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return { candidates: Array.isArray(candidates) ? [...candidates] : [], applied: false };
  }
  const taskMetadata = options?.taskMetadata || {};
  if (taskMetadata.user_provider_override || taskMetadata._routing_template || options?.isUserOverride) {
    return { candidates: [...candidates], applied: false };
  }

  const extractProvider = typeof options.extractProvider === 'function'
    ? options.extractProvider
    : _extractChainProvider;
  const scoreMap = _getTrustedProviderScoreMap();
  if (scoreMap.size === 0) {
    return { candidates: [...candidates], applied: false };
  }
  const learningScope = options.learningScope || null;
  const learningPenalties = _getSharedProviderLearningPenalties(learningScope, options);

  const decorated = candidates.map((candidate, index) => {
    const provider = extractProvider(candidate);
    const hasTrustedScore = provider ? scoreMap.has(provider) : false;
    const baseScore = hasTrustedScore ? (scoreMap.get(provider) || 0) : 0;
    const learningPenalty = provider && learningPenalties.has(provider)
      ? learningPenalties.get(provider).penalty
      : 0;
    return {
      candidate,
      index,
      provider,
      hasTrustedScore,
      compositeScore: baseScore,
      learningPenalty,
      score: Math.max(0, baseScore - learningPenalty),
    };
  });

  if (!decorated.some((entry) => entry.hasTrustedScore)) {
    return { candidates: [...candidates], applied: false };
  }

  decorated.sort((a, b) => {
    if (a.hasTrustedScore !== b.hasTrustedScore) {
      return a.hasTrustedScore ? -1 : 1;
    }
    if (a.hasTrustedScore && b.hasTrustedScore && a.score !== b.score) {
      return b.score - a.score;
    }
    return a.index - b.index;
  });

  const selected = decorated[0];
  return {
    candidates: decorated.map((entry) => entry.candidate),
    applied: true,
    selectedProvider: selected.provider,
    selectedScore: selected.hasTrustedScore ? selected.compositeScore : null,
    selectedAdjustedScore: selected.hasTrustedScore ? selected.score : null,
    selectedLearningPenalty: selected.learningPenalty || 0,
    scoreMap,
    learningScope,
    learningPenalties,
    learningPenaltyApplied: decorated.some((entry) => entry.learningPenalty > 0),
  };
}

function _isProviderEnabled(providerName) {
  if (!providerName) return false;
  try {
    const provider = getProvider(providerName);
    return Boolean(provider && provider.enabled);
  } catch (_err) {
    return false;
  }
}

function buildLearningPenaltySummary(learningPenalties) {
  if (!(learningPenalties instanceof Map) || learningPenalties.size === 0) return undefined;
  const summary = {};
  for (const [provider, entry] of learningPenalties.entries()) {
    if (!entry || entry.penalty <= 0) continue;
    summary[provider] = {
      penalty: entry.penalty,
      scope_key: entry.scope_key,
      sample_count: entry.learnings.reduce((total, row) => total + (Number(row.sample_count) || 0), 0),
      confidence: entry.learnings.reduce((max, row) => Math.max(max, Number(row.confidence) || 0), 0),
    };
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function _applyScoredEligibleProviders(result, taskMetadata = {}, learningScope = null) {
  if (!result || !Array.isArray(result.eligible_providers) || result.eligible_providers.length <= 1) {
    return result;
  }

  const availableProviders = result.eligible_providers.filter((providerName) => _isProviderEnabled(providerName));
  if (availableProviders.length <= 1) {
    return result;
  }

  const ranked = _rankProviderCandidatesByScore(availableProviders, {
    taskMetadata,
    learningScope,
    extractProvider: (providerName) => providerName,
  });
  if (!ranked.applied || ranked.candidates.length === 0) {
    return result;
  }

  const selectedProvider = ranked.candidates[0];
  result.eligible_providers = ranked.candidates;
  result.provider = selectedProvider;
  result.routing_score_applied = true;
  result.routing_score = {
    provider: selectedProvider,
    composite_score: ranked.selectedScore,
    adjusted_score: ranked.selectedAdjustedScore,
    learning_penalty: ranked.selectedLearningPenalty,
    learning_penalties: buildLearningPenaltySummary(ranked.learningPenalties),
    scope_key: ranked.learningScope?.scope_key || ranked.learningScope?.scopeKey || undefined,
    source: ranked.learningPenaltyApplied ? 'provider_scores+shared_learnings' : 'provider_scores',
  };
  const learningSuffix = ranked.learningPenaltyApplied ? ` adjusted=${Number(ranked.selectedAdjustedScore || 0).toFixed(3)} shared-learning=applied` : '';
  result.reason = `${result.reason} [score-ranked: ${selectedProvider} composite=${Number(ranked.selectedScore || 0).toFixed(3)}${learningSuffix}]`;
  return result;
}

function _applyScoredFallbackChain(result, taskMetadata = {}, learningScope = null) {
  if (!result || !Array.isArray(result.chain) || result.chain.length <= 1) {
    return result;
  }
  if (taskMetadata?.user_provider_override || taskMetadata?._routing_template) {
    return result;
  }

  try {
    const chain = [...result.chain];
    const selectedProvider = result.provider || _extractChainProvider(chain[0]);
    const selectedIndex = chain.findIndex((candidate) => _extractChainProvider(candidate) === selectedProvider);
    if (selectedIndex <= -1) {
      return result;
    }

    const selected = chain[selectedIndex];
    const fallbackCandidates = chain.filter((_, index) => index !== selectedIndex);
    const rankedFallbacks = _rankProviderCandidatesByScore(fallbackCandidates, { taskMetadata, learningScope });
    if (!rankedFallbacks.applied) return result;

    const fallbackChain = [selected, ...rankedFallbacks.candidates];
    if (!result.fallbackChain) {
      result.fallbackChain = fallbackChain;
    } else if (Array.isArray(result.fallbackChain) && result.fallbackChain.length > 0) {
      result.fallbackChain = [result.fallbackChain[0], ...rankedFallbacks.candidates];
    } else {
      result.fallbackChain = fallbackChain;
    }
    result.chain = fallbackChain;
    logger.debug(
      `[SmartRouting] Applied trusted provider score ordering to fallback chain for ${selectedProvider}`
    );
  } catch (_e) {
    // Scoring is advisory; do not alter routing on failure.
  }

  return result;
}

const _smartRoutingAnalyzeTaskForRouting = smartRouting.analyzeTaskForRouting;
function analyzeTaskForRouting(taskDescription, workingDirectory, files = [], options = {}) {
  const taskMetadata = options?.taskMetadata || {};
  const learningScope = options?.learningScope || deriveLearningScope({
    metadata: taskMetadata,
    files,
    workingDirectory,
    description: taskDescription,
  });
  const result = _smartRoutingAnalyzeTaskForRouting(
    taskDescription,
    workingDirectory,
    files,
    learningScope ? { ...options, learningScope } : options,
  );
  _applyScoredEligibleProviders(result, taskMetadata, learningScope);
  return _applyScoredFallbackChain(result, taskMetadata, learningScope);
}

// Escape a string for use as a Prometheus label value (inside double quotes)
function escapePrometheusLabel(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
}

function setConfig(key, value) {
  if (!db || (db.open === false)) return;
  const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  stmt.run(key, String(value));
}

function getTask(id) {
  return getTaskFn(id);
}

const VALID_PROVIDER_TRANSPORTS = new Set(['api', 'cli', 'hybrid']);

function normalizeProviderTransport(rawTransport, providerId) {
  if (typeof rawTransport === 'string') {
    const normalizedTransport = rawTransport.trim().toLowerCase();
    if (VALID_PROVIDER_TRANSPORTS.has(normalizedTransport)) {
      return normalizedTransport;
    }
  }

  if (providerId === 'codex') return 'hybrid';
  if (providerId === 'claude-cli') return 'cli';
  if (providerId === 'claude-code-sdk') return 'cli';
  return 'api';
}

function enrichProviderRow(provider) {
  if (!provider) return null;
  provider.quota_error_patterns = safeJsonParse(provider.quota_error_patterns, []);
  provider.enabled = Boolean(provider.enabled);
  provider.transport = normalizeProviderTransport(provider.transport, provider.provider);
  return provider;
}

/**
 * Get provider configuration
 * @param {any} providerId
 * @returns {any}
 */
function getProvider(providerId) {
  if (!db || (db.open === false)) return null;
  const stmt = db.prepare('SELECT * FROM provider_config WHERE provider = ?');
  return enrichProviderRow(stmt.get(providerId));
}

/**
 * List all configured providers
 * @returns {any}
 */
function listProviders() {
  if (!db || (db.open === false)) return [];
  const stmt = db.prepare('SELECT * FROM provider_config ORDER BY priority ASC');
  return stmt.all().map((p) => enrichProviderRow(p));
}

function parsePositiveInt(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptOutBool(value, fallback = true) {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '0' || normalized === 'false') return false;
  if (normalized === '1' || normalized === 'true') return true;
  return fallback;
}

function getEnabledProviderMaxConcurrentSum() {
  return listProviders().reduce((sum, provider) => {
    if (!provider || !provider.enabled) return sum;
    return sum + parsePositiveInt(provider.max_concurrent, 0);
  }, 0);
}

function getEffectiveMaxConcurrent(options = {}) {
  const configuredMaxConcurrent = parsePositiveInt(
    options.configuredMaxConcurrent ?? getDatabaseConfig('max_concurrent'),
    DEFAULT_GLOBAL_MAX_CONCURRENT,
  );
  const autoComputeMaxConcurrent = options.autoComputeMaxConcurrent !== undefined
    ? Boolean(options.autoComputeMaxConcurrent)
    : parseOptOutBool(getDatabaseConfig('auto_compute_max_concurrent'), true);
  const providerLimitSum = options.providerLimitSum !== undefined
    ? parsePositiveInt(options.providerLimitSum, 0)
    : getEnabledProviderMaxConcurrentSum();
  const effectiveMaxConcurrent = configuredMaxConcurrent;

  if (autoComputeMaxConcurrent && providerLimitSum > configuredMaxConcurrent) {
    const warningKey = `${configuredMaxConcurrent}:${providerLimitSum}`;
    if (warningKey !== lastEffectiveMaxConcurrentWarningKey) {
      const targetLogger = options.logger && typeof options.logger.warn === 'function'
        ? options.logger
        : logger;
      targetLogger.warn(
        `[Concurrency] Enabled provider limits sum to ${providerLimitSum}, but configured max_concurrent=${configuredMaxConcurrent} is enforced as the global cap.`,
      );
      lastEffectiveMaxConcurrentWarningKey = warningKey;
    }
  }

  return {
    configuredMaxConcurrent,
    autoComputeMaxConcurrent,
    providerLimitSum,
    effectiveMaxConcurrent,
  };
}

/**
 * Update provider configuration
 * @param {any} providerId
 * @param {any} config
 * @returns {any}
 */
function updateProvider(providerId, config) {
  const allowed = ['enabled', 'priority', 'cli_path', 'cli_args', 'quota_error_patterns', 'max_concurrent', 'timeout_minutes', 'default_model', 'transport'];
  const updates = [];
  const values = [];

  for (const key of allowed) {
    if (config[key] !== undefined) {
      if (key === 'transport') {
        const normalizedTransport = normalizeProviderTransport(config[key], providerId);
        if (!VALID_PROVIDER_TRANSPORTS.has(String(config[key]).trim().toLowerCase())) {
          throw new Error(`Invalid transport: ${config[key]}`);
        }
        updates.push(`${key} = ?`);
        values.push(normalizedTransport);
        continue;
      }
      updates.push(`${key} = ?`);
      if (key === 'quota_error_patterns' && Array.isArray(config[key])) {
        values.push(JSON.stringify(config[key]));
      } else {
        values.push(config[key]);
      }
    }
  }

  if (updates.length === 0) return getProvider(providerId);

  updates.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(providerId);

  const stmt = db.prepare(`UPDATE provider_config SET ${updates.join(', ')} WHERE provider = ?`);
  stmt.run(...values);

  return getProvider(providerId);
}

/**
 * Get the default provider
 * @returns {any}
 */
function getDefaultProvider() {
  return getDatabaseConfig('default_provider') || 'codex';
}

/**
 * Set the default provider
 * @param {any} providerId
 * @returns {any}
 */
function setDefaultProvider(providerId) {
  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  if (!provider.enabled) {
    throw new Error(`Provider ${providerId} is disabled`);
  }
  setConfig('default_provider', providerId);
  return providerId;
}

// Smart Routing and Ollama Health are now in separate modules.
// Re-exported below via smartRouting and ollamaHealth.


// ============================================================
// Provider Stats (merged from provider-routing-stats.js)
// ============================================================

function getPrometheusMetrics() {
  return buildPrometheusMetrics({ db, escapePrometheusLabel });
}

// ============================================================
// Stale Task Cleanup
// ============================================================

/**
 * Clean up stale tasks - tasks stuck in 'running' or 'queued' state too long
 * This handles orphaned tasks from server restarts or process crashes
 * @param {number} runningMinutes - Mark running tasks as failed after this many minutes (default: 60)
 * @param {number} queuedMinutes - Mark queued tasks as cancelled after this many minutes (default: 1440 = 24h)
 * @returns {object} - Count of cleaned up tasks
 */
function cleanupStaleTasks(runningMinutes = 60, queuedMinutes = 1440) {
  const now = new Date().toISOString();

  // Calculate cutoff times
  const runningCutoff = new Date(Date.now() - runningMinutes * 60 * 1000).toISOString();
  const queuedCutoff = new Date(Date.now() - queuedMinutes * 60 * 1000).toISOString();

  // Mark stale running tasks as failed
  const staleRunning = db.prepare(`
    UPDATE tasks
    SET status = 'failed',
        completed_at = ?,
        error_output = COALESCE(error_output || char(10), '') || 'Task marked as failed: no heartbeat (stale session cleanup)'
    WHERE status = 'running'
      AND (started_at < ? OR (started_at IS NULL AND created_at < ?))
  `).run(now, runningCutoff, runningCutoff);

  // Mark very old queued tasks as failed (likely abandoned)
  const staleQueued = db.prepare(`
    UPDATE tasks
    SET status = 'failed',
        completed_at = ?,
        error_output = COALESCE(error_output || char(10), '') || 'Task marked as failed: queued too long (stale session cleanup)'
    WHERE status = 'queued'
      AND created_at < ?
  `).run(now, queuedCutoff);

  return {
    running_cleaned: staleRunning.changes,
    queued_cleaned: staleQueued.changes,
    total: staleRunning.changes + staleQueued.changes
  };
}

/**
 * Prune completed/failed/cancelled tasks beyond a retention count.
 * Keeps the most recent N tasks of each terminal status.
 * @param {number} maxRetained - Maximum completed tasks to keep (default: 5000)
 * @returns {{ pruned: number, task_ids: string[] }} Count of pruned tasks
 */
function pruneOldTasks(maxRetained = 5000) {
  const rows = db.prepare(`
    SELECT id
    FROM tasks
    WHERE status IN ('completed', 'failed', 'cancelled')
    ORDER BY created_at DESC
    LIMIT -1 OFFSET ?
  `).all(maxRetained);
  const taskIds = rows.map((row) => row.id).filter(Boolean);
  if (taskIds.length === 0) {
    return { pruned: 0, task_ids: [] };
  }
  const result = db.prepare(`
    DELETE FROM tasks WHERE id IN (
      SELECT id FROM tasks
      WHERE status IN ('completed', 'failed', 'cancelled')
      ORDER BY created_at DESC
      LIMIT -1 OFFSET ?
    )
  `).run(maxRetained);
  return { pruned: result.changes, task_ids: taskIds };
}

/**
 * Record provider usage for a task
 * @param {any} provider
 * @param {any} taskId
 * @param {any} options
 * @returns {any}
 */
function normalizeProviderUsageParams(
  provider,
  taskId,
  optionsOrTokensUsed,
  costEstimate,
  durationSeconds,
  success,
  errorType,
) {
  if (optionsOrTokensUsed === undefined || optionsOrTokensUsed === null) {
    return {
      provider,
      taskId,
      tokens_used: null,
      cost_estimate: null,
      duration_seconds: null,
      elapsed_ms: null,
      transport: null,
      retry_count: null,
      failure_reason: null,
      success: undefined,
      error_type: null,
    };
  }

  if (typeof optionsOrTokensUsed === 'object' && !Array.isArray(optionsOrTokensUsed)) {
    const options = optionsOrTokensUsed;
    return {
      provider,
      taskId,
      tokens_used: options.tokens_used,
      cost_estimate: options.cost_estimate,
      duration_seconds: options.duration_seconds,
      elapsed_ms: options.elapsed_ms,
      transport: options.transport,
      retry_count: options.retry_count,
      failure_reason: options.failure_reason,
      success: options.success,
      error_type: options.error_type,
    };
  }

  return {
    provider,
    taskId,
    tokens_used: optionsOrTokensUsed,
    cost_estimate: costEstimate,
    duration_seconds: durationSeconds,
    elapsed_ms: null,
    transport: null,
    retry_count: null,
    failure_reason: null,
    success,
    error_type: errorType,
  };
}

function recordProviderUsage(
  provider,
  taskId,
  optionsOrTokensUsed,
  costEstimate,
  durationSeconds,
  success,
  errorType,
) {
  const normalized = normalizeProviderUsageParams(
    provider,
    taskId,
    optionsOrTokensUsed,
    costEstimate,
    durationSeconds,
    success,
    errorType,
  );
  const elapsedMs = normalized.elapsed_ms;
  const retryCount = normalized.retry_count;
  const hasValue = (value) => value !== undefined && value !== null;

  const stmt = db.prepare(`
    INSERT INTO provider_usage (provider, task_id, tokens_used, cost_estimate, duration_seconds, elapsed_ms, transport, retry_count, failure_reason, success, error_type, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    normalized.provider,
    normalized.taskId,
    hasValue(normalized.tokens_used) ? normalized.tokens_used : null,
    hasValue(normalized.cost_estimate) ? normalized.cost_estimate : null,
    hasValue(normalized.duration_seconds) ? normalized.duration_seconds : null,
    Number.isFinite(Number(elapsedMs)) ? elapsedMs : null,
    normalized.transport || null,
    Number.isFinite(Number(retryCount)) ? retryCount : null,
    normalized.failure_reason || null,
    normalized.success !== undefined ? (normalized.success ? 1 : 0) : null,
    normalized.error_type || null,
    new Date().toISOString()
  );
}

/**
 * Get provider usage statistics
 * @param {any} providerId
 * @param {any} days
 * @returns {any}
 */
function getProviderStats(providerId, days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const stats = db.prepare(`
    SELECT
      provider,
      COUNT(*) as total_tasks,
      COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successful_tasks,
      COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) as failed_tasks,
      COALESCE(SUM(tokens_used), 0) as total_tokens,
      COALESCE(SUM(cost_estimate), 0) as total_cost,
      COALESCE(AVG(duration_seconds), 0) as avg_duration_seconds
    FROM provider_usage
    WHERE provider = ? AND recorded_at >= ?
    GROUP BY provider
  `).get(providerId, cutoff);

  if (!stats) {
    return {
      provider: providerId,
      total_tasks: 0,
      successful_tasks: 0,
      failed_tasks: 0,
      success_rate: 0,
      total_tokens: 0,
      total_cost: 0,
      avg_duration_seconds: 0
    };
  }

  stats.success_rate = stats.total_tasks > 0
    ? Math.round((stats.successful_tasks / stats.total_tasks) * 100)
    : 0;

  return stats;
}

// ============================================================
// Provider Health Scoring
// ============================================================
// In-memory sliding window for provider success/failure tracking.
// Resets every hour automatically.

const _providerHealth = new Map();
const HEALTH_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_PROVIDER_HEALTH_THRESHOLDS = Object.freeze({
  minSamples: 3,
  minFailures: 1,
  maxFailureRate: 0.30,
});
const PROVIDER_HEALTH_THRESHOLD_OVERRIDES = Object.freeze({
  codex: Object.freeze({
    minFailures: 5,
  }),
});

function getProviderHealthThresholds(provider) {
  const providerName = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  return {
    ...DEFAULT_PROVIDER_HEALTH_THRESHOLDS,
    ...(PROVIDER_HEALTH_THRESHOLD_OVERRIDES[providerName] || {}),
  };
}

function _getOrCreateHealth(provider) {
  if (!_providerHealth.has(provider)) {
    _providerHealth.set(provider, { successes: 0, failures: 0, lastReset: Date.now() });
  }
  const entry = _providerHealth.get(provider);
  // Auto-reset if window expired — persist the expiring window before clearing
  if (Date.now() - entry.lastReset > HEALTH_WINDOW_MS) {
    const total = entry.successes + entry.failures;
    if (total > 0) {
      try {
        persistHealthWindow(provider, {
          window_start: new Date(entry.lastReset).toISOString(),
          window_end: new Date().toISOString(),
          successes: entry.successes,
          failures: entry.failures,
        });
      } catch (_e) { /* DB not initialized yet — skip persistence */ }
    }
    entry.successes = 0;
    entry.failures = 0;
    entry.lastReset = Date.now();
  }
  return entry;
}

function recordProviderOutcome(provider, success) {
  const entry = _getOrCreateHealth(provider);
  if (success) entry.successes++;
  else entry.failures++;
}

function getProviderHealth(provider) {
  const entry = _getOrCreateHealth(provider);
  const total = entry.successes + entry.failures;
  return {
    successes: entry.successes,
    failures: entry.failures,
    failureRate: total > 0 ? entry.failures / total : 0
  };
}

function providerRequiresApiKey(provider) {
  if (typeof provider !== 'string' || !provider.trim()) return false;
  return providerRegistry.isApiProvider(provider.trim());
}

function isProviderConfiguredForRouting(provider) {
  const providerName = typeof provider === 'string' ? provider.trim() : '';
  if (!providerName || !providerRequiresApiKey(providerName)) return true;
  try {
    return Boolean(serverConfig.getApiKey(providerName));
  } catch (_e) {
    return false;
  }
}

function isProviderAvailableForRouting(provider) {
  const providerName = typeof provider === 'string' ? provider.trim() : '';
  if (!providerName) return false;
  const providerConfig = getProvider(providerName);
  return Boolean(
    providerConfig
    && providerConfig.enabled
    && isProviderConfiguredForRouting(providerName)
    && isProviderHealthy(providerName)
  );
}

function isProviderHealthy(provider) {
  const entry = _getOrCreateHealth(provider);
  const total = entry.successes + entry.failures;
  const thresholds = getProviderHealthThresholds(provider);
  if (total < thresholds.minSamples) return true;
  if (entry.failures < thresholds.minFailures) return true;
  return (entry.failures / total) < thresholds.maxFailureRate;
}

/**
 * Get a normalized health score (0-1) for a provider.
 * 1.0 = perfectly healthy, 0.0 = all failures.
 * Returns 0.5 (neutral) when insufficient data (< 3 samples).
 * @param {string} provider - Provider name
 * @returns {number} Score in [0, 1]
 */
function getProviderHealthScore(provider) {
  const entry = _getOrCreateHealth(provider);
  const total = entry.successes + entry.failures;
  if (total < 3) return 0.5;
  return Math.max(0, Math.min(1, 1 - (entry.failures / total)));
}

function resetProviderHealth(provider) {
  const providerName = typeof provider === 'string' ? provider.trim() : '';
  if (providerName) {
    const existed = _providerHealth.delete(providerName);
    return {
      scope: 'provider',
      provider: providerName,
      reset_count: existed ? 1 : 0,
    };
  }

  const resetCount = _providerHealth.size;
  _providerHealth.clear();
  return {
    scope: 'all',
    reset_count: resetCount,
  };
}


// ============================================================
// Provider Routing Config (merged from provider-routing-config.js)
// ============================================================

function createTemplateCondition(condition) {
  const stmt = db.prepare(`
    INSERT INTO template_conditions (
      id, template_id, condition_type, condition_expr, then_block, else_block, order_index, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    condition.id,
    condition.template_id,
    condition.condition_type,
    condition.condition_expr,
    condition.then_block || null,
    condition.else_block || null,
    condition.order_index || 0,
    new Date().toISOString()
  );

  return getTemplateCondition(condition.id);
}

/**
 * Get a template condition by ID
 * @param {any} id
 * @returns {any}
 */
function getTemplateCondition(id) {
  const stmt = db.prepare('SELECT * FROM template_conditions WHERE id = ?');
  return stmt.get(id);
}

/**
 * List conditions for a template
 * @param {any} templateId
 * @returns {any}
 */
function listTemplateConditions(templateId) {
  const stmt = db.prepare('SELECT * FROM template_conditions WHERE template_id = ? ORDER BY order_index ASC');
  return stmt.all(templateId);
}

/**
 * Delete a template condition
 */
function deleteTemplateCondition(id) {
  const stmt = db.prepare('DELETE FROM template_conditions WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================================
// Task Replay + Workflow Forks (extracted to provider-routing-extras.js)
// ============================================================
const providerRoutingExtras = require('./provider-routing-extras');

const { createTaskReplay, getTaskReplay, listTaskReplays,
  createWorkflowFork, getWorkflowFork, listWorkflowForks, updateWorkflowForkStatus } = providerRoutingExtras;

// ============================================================
// Rate Limits
// ============================================================

/**
 * Create or update a rate limit
 * @param {any} rateLimit
 * @returns {any}
 */
function setRateLimit(rateLimit) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO rate_limits (id, project_id, limit_type, max_value, window_seconds, current_value, window_start, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      max_value = excluded.max_value,
      window_seconds = excluded.window_seconds
  `);

  stmt.run(
    rateLimit.id,
    rateLimit.project_id || null,
    rateLimit.limit_type,
    rateLimit.max_value,
    rateLimit.window_seconds,
    0,
    now,
    now
  );

  return getRateLimit(rateLimit.id);
}

/**
 * Get a rate limit by ID
 * @param {any} id
 * @returns {any}
 */
function getRateLimit(id) {
  const stmt = db.prepare('SELECT * FROM rate_limits WHERE id = ?');
  return stmt.get(id);
}

/**
 * Get rate limits for a project
 * @param {any} projectId
 * @returns {any}
 */
function getProjectRateLimits(projectId) {
  const stmt = db.prepare('SELECT * FROM rate_limits WHERE project_id = ? OR project_id IS NULL');
  return stmt.all(projectId);
}

/**
 * Check and increment rate limit
 */
function checkRateLimit(projectId, limitType) {
  const now = new Date();
  const nowStr = now.toISOString();

  const txn = db.transaction(() => {
    // Get applicable rate limit
    const limit = db.prepare(`
      SELECT * FROM rate_limits
      WHERE (project_id = ? OR project_id IS NULL) AND limit_type = ?
      ORDER BY project_id DESC NULLS LAST
      LIMIT 1
    `).get(projectId, limitType);

    if (!limit) {
      return { allowed: true, reason: 'no_limit_configured' };
    }

    // Check if window has expired
    const windowStart = new Date(limit.window_start);
    const windowEnd = new Date(windowStart.getTime() + limit.window_seconds * 1000);

    if (now > windowEnd) {
      // Reset window
      db.prepare(`
        UPDATE rate_limits SET current_value = 1, window_start = ?
        WHERE id = ?
      `).run(nowStr, limit.id);
      return { allowed: true, remaining: limit.max_value - 1 };
    }

    // Check if within limit
    if (limit.current_value >= limit.max_value) {
      return {
        allowed: false,
        reason: 'rate_limit_exceeded',
        limit: limit.max_value,
        reset_at: windowEnd.toISOString()
      };
    }

    // Increment counter
    db.prepare(`
      UPDATE rate_limits SET current_value = current_value + 1
      WHERE id = ?
    `).run(limit.id);

    return { allowed: true, remaining: limit.max_value - limit.current_value - 1 };
  });

  return txn();
}

/**
 * Delete a rate limit
 */
function deleteRateLimit(id) {
  const stmt = db.prepare('DELETE FROM rate_limits WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================================
// Task Quotas
// ============================================================

/**
 * Create or update a task quota
 * @param {any} quota
 * @returns {any}
 */
function setTaskQuota(quota) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO task_quotas (id, project_id, quota_type, max_value, current_value, reset_period, last_reset, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      max_value = excluded.max_value,
      reset_period = excluded.reset_period
  `);

  stmt.run(
    quota.id,
    quota.project_id || null,
    quota.quota_type,
    quota.max_value,
    0,
    quota.reset_period || null,
    now,
    now
  );

  return getTaskQuota(quota.id);
}

/**
 * Get a task quota by ID
 * @param {any} id
 * @returns {any}
 */
function getTaskQuota(id) {
  const stmt = db.prepare('SELECT * FROM task_quotas WHERE id = ?');
  return stmt.get(id);
}

/**
 * Check and increment task quota
 */
function checkTaskQuota(projectId, quotaType, createTaskFn) {
  const now = new Date();
  const nowStr = now.toISOString();
  const shouldCreateTask = typeof createTaskFn === 'function';

  const txn = db.transaction((createTask) => {
    // Get applicable quota
    const quota = db.prepare(`
      SELECT * FROM task_quotas
      WHERE (project_id = ? OR project_id IS NULL) AND quota_type = ?
      ORDER BY project_id DESC NULLS LAST
      LIMIT 1
    `).get(projectId, quotaType);

    if (!quota) {
      const result = { allowed: true, reason: 'no_quota_configured' };
      if (shouldCreateTask) {
        result.task = createTask();
      }
      return result;
    }

    // Check if quota needs reset (based on reset_period)
    if (quota.reset_period) {
      const lastReset = new Date(quota.last_reset);
      let shouldReset = false;

      switch (quota.reset_period) {
        case 'daily':
          shouldReset = now.toDateString() !== lastReset.toDateString();
          break;
        case 'weekly': {
          const weekMs = 7 * 24 * 60 * 60 * 1000;
          shouldReset = now.getTime() - lastReset.getTime() >= weekMs;
          break;
        }
        case 'monthly':
          shouldReset = now.getMonth() !== lastReset.getMonth() ||
            now.getFullYear() !== lastReset.getFullYear();
          break;
      }

      if (shouldReset) {
        db.prepare(`
          UPDATE task_quotas SET current_value = 1, last_reset = ?
          WHERE id = ?
        `).run(nowStr, quota.id);
        const result = { allowed: true, remaining: quota.max_value - 1 };
        if (shouldCreateTask) {
          result.task = createTask();
        }
        return result;
      }
    }

    // Check if within quota
    if (quota.current_value >= quota.max_value) {
      return {
        allowed: false,
        reason: 'quota_exceeded',
        quota: quota.max_value,
        reset_period: quota.reset_period
      };
    }

    // Increment counter
    db.prepare(`
      UPDATE task_quotas SET current_value = current_value + 1
      WHERE id = ?
    `).run(quota.id);

    const remaining = quota.max_value - quota.current_value - 1;
    if (shouldCreateTask) {
      return { allowed: true, remaining, task: createTask() };
    }

    return { allowed: true, remaining };
  });

  return txn(createTaskFn);
}

/**
 * Get all task quotas for a project
 * @param {any} projectId
 * @returns {any}
 */
function getProjectQuotas(projectId) {
  const stmt = db.prepare('SELECT * FROM task_quotas WHERE project_id = ? OR project_id IS NULL');
  return stmt.all(projectId);
}

/**
 * Delete a task quota
 */
function deleteTaskQuota(id) {
  const stmt = db.prepare('DELETE FROM task_quotas WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================================
// Integration Config
// ============================================================

/**
 * Save integration configuration
 * @param {any} integration
 * @returns {any}
 */
function saveIntegrationConfig(integration) {
  const stmt = db.prepare(`
    INSERT INTO integration_config (id, integration_type, config, enabled, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      config = excluded.config,
      enabled = excluded.enabled
  `);

  stmt.run(
    integration.id,
    integration.integration_type,
    JSON.stringify(integration.config),
    integration.enabled !== false ? 1 : 0,
    new Date().toISOString()
  );

  return getIntegrationConfig(integration.id);
}

/**
 * Get integration configuration by ID
 * @param {any} id
 * @returns {any}
 */
function getIntegrationConfig(id) {
  const stmt = db.prepare('SELECT * FROM integration_config WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.config = safeJsonParse(row.config, {});
    row.enabled = Boolean(row.enabled);
  }
  return row;
}

/**
 * List all integration configurations
 * @param {any} type
 * @returns {any}
 */
function listIntegrationConfigs(type = null) {
  let stmt;
  if (type) {
    stmt = db.prepare('SELECT * FROM integration_config WHERE integration_type = ?');
    return stmt.all(type).map(row => {
      row.config = safeJsonParse(row.config, {});
      row.enabled = Boolean(row.enabled);
      return row;
    });
  }
  stmt = db.prepare('SELECT * FROM integration_config');
  return stmt.all().map(row => {
    row.config = safeJsonParse(row.config, {});
    row.enabled = Boolean(row.enabled);
    return row;
  });
}

/**
 * Get enabled integration by type
 * @param {any} integrationType
 * @returns {any}
 */
function getEnabledIntegration(integrationType) {
  const stmt = db.prepare('SELECT * FROM integration_config WHERE integration_type = ? AND enabled = 1 LIMIT 1');
  const row = stmt.get(integrationType);
  if (row) {
    row.config = safeJsonParse(row.config, {});
    row.enabled = Boolean(row.enabled);
  }
  return row;
}

/**
 * Delete integration configuration
 */
function deleteIntegrationConfig(id) {
  const stmt = db.prepare('DELETE FROM integration_config WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================================
// Smart Routing Rules
// ============================================================

/**
 * Get all routing rules
 * @param {any} options
 * @returns {any}
 */
function getRoutingRules(options = {}) {
  let sql = 'SELECT * FROM routing_rules WHERE 1=1';
  const params = [];

  if (options.enabled !== undefined) {
    sql += ' AND enabled = ?';
    params.push(options.enabled ? 1 : 0);
  }
  if (options.rule_type) {
    sql += ' AND rule_type = ?';
    params.push(options.rule_type);
  }

  sql += ' ORDER BY priority ASC';

  const stmt = db.prepare(sql);
  return stmt.all(...params).map(r => ({
    ...r,
    enabled: Boolean(r.enabled)
  }));
}

/**
 * Get a specific routing rule by ID or name
 * @param {any} idOrName
 * @returns {any}
 */
function getRoutingRule(idOrName) {
  const stmt = db.prepare('SELECT * FROM routing_rules WHERE id = ? OR name = ?');
  const rule = stmt.get(idOrName, idOrName);
  if (rule) {
    rule.enabled = Boolean(rule.enabled);
  }
  return rule;
}

/**
 * Create a new routing rule
 */
function createRoutingRule({ name, description, rule_type, pattern, target_provider, priority, enabled }) {
  const stmt = db.prepare(`
    INSERT INTO routing_rules (name, description, rule_type, pattern, target_provider, priority, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    name,
    description || null,
    rule_type || 'keyword',
    pattern,
    target_provider,
    priority !== undefined ? priority : 50,
    enabled !== undefined ? (enabled ? 1 : 0) : 1,
    new Date().toISOString()
  );

  return getRoutingRule(result.lastInsertRowid);
}

/**
 * Update a routing rule
 * @param {any} idOrName
 * @param {any} updates
 * @returns {any}
 */
function updateRoutingRule(idOrName, updates) {
  const rule = getRoutingRule(idOrName);
  if (!rule) {
    throw new Error(`Routing rule not found: ${idOrName}`);
  }

  const allowed = ['name', 'description', 'rule_type', 'pattern', 'target_provider', 'priority', 'enabled'];
  const setClause = [];
  const values = [];

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      setClause.push(`${key} = ?`);
      if (key === 'enabled') {
        values.push(updates[key] ? 1 : 0);
      } else {
        values.push(updates[key]);
      }
    }
  }

  if (setClause.length === 0) return rule;

  setClause.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(rule.id);

  const stmt = db.prepare(`UPDATE routing_rules SET ${setClause.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getRoutingRule(rule.id);
}

/**
 * Delete a routing rule
 */
function deleteRoutingRule(idOrName) {
  const rule = getRoutingRule(idOrName);
  if (!rule) {
    throw new Error(`Routing rule not found: ${idOrName}`);
  }

  const stmt = db.prepare('DELETE FROM routing_rules WHERE id = ?');
  stmt.run(rule.id);

  return { deleted: true, rule };
}


// ============================================================
// Provider Health History (extracted to provider-health-history.js)
// ============================================================
const providerHealthHistory = require('./provider-health-history');

const { persistHealthWindow, getHealthHistory, getHealthTrend, pruneHealthHistory } = providerHealthHistory;

// ============================================================
// Factory function (dependency injection without singletons)
// ============================================================

function createProviderRoutingCore({ db: dbInstance, taskCore, hostManagement, sharedFactoryStore: sharedStore } = {}) {
  if (dbInstance) setDb(dbInstance);
  if (taskCore) setGetTask(taskCore);
  if (hostManagement) setHostManagement(hostManagement);
  if (sharedStore !== undefined) setSharedFactoryStore(sharedStore);
  return module.exports;
}


module.exports = {
  // Re-export from extracted modules (smart-routing.js and ollama-health.js)
  ...smartRouting,
  ...ollamaHealth,
  analyzeTaskForRouting,

  // Dependency injection
  setDb,
  setGetTask,
  setHostManagement,
  setProviderScoring,
  setSharedFactoryStore,
  setCircuitBreaker,

  // Provider Core
  getTask,
  getProvider,
  listProviders,
  getEnabledProviderMaxConcurrentSum,
  getEffectiveMaxConcurrent,
  updateProvider,
  // Provider Defaults
  getDefaultProvider,
  setDefaultProvider,
  normalizeProviderTransport,
  enrichProviderRow,

  // Provider Stats (from provider-routing-stats.js)
  // Prometheus
  getPrometheusMetrics,
  // Stale Task Cleanup
  cleanupStaleTasks,
  pruneOldTasks,
  // Provider Management
  recordProviderUsage,
  getProviderStats,
  // Provider Health Scoring
  recordProviderOutcome,
  getProviderHealth,
  getProviderHealthScore,
  getProviderHealthThresholds,
  isProviderHealthy,
  providerRequiresApiKey,
  isProviderConfiguredForRouting,
  isProviderAvailableForRouting,
  resetProviderHealth,

  // Provider Routing Config (from provider-routing-config.js)
  // Template Conditions
  createTemplateCondition,
  getTemplateCondition,
  listTemplateConditions,
  deleteTemplateCondition,
  // Task Replay
  createTaskReplay,
  getTaskReplay,
  listTaskReplays,
  // Rate Limits
  setRateLimit,
  getRateLimit,
  getProjectRateLimits,
  checkRateLimit,
  deleteRateLimit,
  // Task Quotas
  setTaskQuota,
  getTaskQuota,
  checkTaskQuota,
  getProjectQuotas,
  deleteTaskQuota,
  // Integration Config
  saveIntegrationConfig,
  getIntegrationConfig,
  listIntegrationConfigs,
  getEnabledIntegration,
  deleteIntegrationConfig,
  // Workflow Forks
  createWorkflowFork,
  getWorkflowFork,
  listWorkflowForks,
  updateWorkflowForkStatus,
  // Smart Routing Rules
  getRoutingRules,
  getRoutingRule,
  createRoutingRule,
  updateRoutingRule,
  deleteRoutingRule,

  // Provider Health History (from provider-health-history.js)
  persistHealthWindow,
  getHealthHistory,
  getHealthTrend,
  pruneHealthHistory,

  // Factory function (dependency injection without singletons)
  createProviderRoutingCore,

  // Testable scoring helpers
  _getSharedProviderLearningPenalties,
};
