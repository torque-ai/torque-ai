'use strict';

const logger = require('../logger').child({ component: 'provider-routing' });
const { safeJsonParse } = require('../utils/json');

// Extracted modules
const smartRouting = require('./smart-routing');
const ollamaHealth = require('./ollama-health');

let templateStore = null;
try {
  templateStore = require('../routing/template-store');
} catch {
  templateStore = null;
}

let providerScoring = null;
function setProviderScoring(scoring) { providerScoring = scoring || null; }

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
  };
}

function _initExtractedModules() {
  const deps = _buildDeps();
  smartRouting.init(deps);
  ollamaHealth.init(deps);
}

function setDb(dbInstance) {
  db = dbInstance;
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

function _applyScoredFallbackChain(result, taskMetadata = {}) {
  if (!providerScoring || !result || !Array.isArray(result.chain) || result.chain.length <= 1) {
    return result;
  }
  if (taskMetadata?.user_provider_override) {
    return result;
  }

  try {
    const scores = providerScoring.getAllProviderScores({ trustedOnly: true });
    if (!Array.isArray(scores) || scores.length === 0) {
      return result;
    }

    const scoreMap = new Map(scores.map((s) => [s.provider, s.composite_score]));
    if (scoreMap.size <= 1) {
      return result;
    }

    const chain = [...result.chain];
    const recommended = chain[0];
    const recommendedProvider = _extractChainProvider(recommended);
    if (!recommendedProvider || !scoreMap.has(recommendedProvider)) {
      return result;
    }

    const recommendedScore = scoreMap.get(recommendedProvider) || 0;
    const fallbackCandidates = chain.slice(1);

    const hasBetterScoredFallback = fallbackCandidates.some((candidate) => {
      const candidateProvider = _extractChainProvider(candidate);
      const candidateScore = candidateProvider ? (scoreMap.get(candidateProvider) || 0) : 0;
      return candidateScore > recommendedScore;
    });
    if (!hasBetterScoredFallback) {
      return result;
    }

    fallbackCandidates.sort((a, b) => {
      const scoreA = _extractChainProvider(a) ? (scoreMap.get(_extractChainProvider(a)) || 0) : 0;
      const scoreB = _extractChainProvider(b) ? (scoreMap.get(_extractChainProvider(b)) || 0) : 0;
      return scoreB - scoreA;
    });

    const fallbackChain = [recommended, ...fallbackCandidates];
    if (!result.fallbackChain) {
      result.fallbackChain = fallbackChain;
    } else if (Array.isArray(result.fallbackChain) && result.fallbackChain.length > 0) {
      result.fallbackChain = [result.fallbackChain[0], ...fallbackCandidates];
    } else {
      result.fallbackChain = fallbackChain;
    }
    result.chain = fallbackChain;
    logger.debug(
      `[SmartRouting] Applied trusted provider score ordering to fallback chain for ${recommendedProvider}`
    );
  } catch (_e) {
    // Scoring is advisory; do not alter routing on failure.
  }

  return result;
}

const _smartRoutingAnalyzeTaskForRouting = smartRouting.analyzeTaskForRouting;
function analyzeTaskForRouting(taskDescription, workingDirectory, files = [], options = {}) {
  const result = _smartRoutingAnalyzeTaskForRouting(taskDescription, workingDirectory, files, options);
  return _applyScoredFallbackChain(result, options?.taskMetadata || {});
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
  const effectiveMaxConcurrent = autoComputeMaxConcurrent
    ? Math.max(configuredMaxConcurrent, providerLimitSum)
    : configuredMaxConcurrent;

  if (autoComputeMaxConcurrent && effectiveMaxConcurrent > configuredMaxConcurrent) {
    const warningKey = `${configuredMaxConcurrent}:${providerLimitSum}:${effectiveMaxConcurrent}`;
    if (warningKey !== lastEffectiveMaxConcurrentWarningKey) {
      const targetLogger = options.logger && typeof options.logger.warn === 'function'
        ? options.logger
        : logger;
      targetLogger.warn(
        `[Concurrency] Auto-computed max_concurrent=${effectiveMaxConcurrent} from enabled provider limits (configured=${configuredMaxConcurrent}, provider_sum=${providerLimitSum})`,
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
  const metrics = [];

  // Task counts by status
  const taskCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM tasks
    GROUP BY status
  `).all();

  for (const { status, count } of taskCounts) {
    metrics.push(`torque_tasks_total{status="${escapePrometheusLabel(status)}"} ${count}`);
  }

  // Active agents
  const agentCount = db.prepare(`
    SELECT COUNT(*) as count FROM agents WHERE status = 'online'
  `).get();
  metrics.push(`torque_active_agents ${agentCount.count}`);

  // Task duration histogram (approximate buckets)
  const durations = db.prepare(`
    SELECT
      CASE
        WHEN julianday(completed_at) - julianday(started_at) <= 1.0/24/60 THEN '60'
        WHEN julianday(completed_at) - julianday(started_at) <= 5.0/24/60 THEN '300'
        WHEN julianday(completed_at) - julianday(started_at) <= 30.0/24/60 THEN '1800'
        ELSE '3600'
      END as bucket,
      COUNT(*) as count
    FROM tasks
    WHERE completed_at IS NOT NULL AND started_at IS NOT NULL
    GROUP BY bucket
  `).all();

  for (const { bucket, count } of durations) {
    metrics.push(`torque_task_duration_seconds_bucket{le="${bucket}"} ${count}`);
  }

  // Workflow counts
  const workflowCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM workflows
    GROUP BY status
  `).all();

  for (const { status, count } of workflowCounts) {
    metrics.push(`torque_workflows_total{status="${escapePrometheusLabel(status)}"} ${count}`);
  }

  // Token usage
  const tokenUsage = db.prepare(`
    SELECT SUM(total_tokens) as total, SUM(estimated_cost_usd) as cost
    FROM token_usage
    WHERE recorded_at >= date('now', '-1 day')
  `).get();

  metrics.push(`torque_tokens_daily_total ${tokenUsage.total || 0}`);
  metrics.push(`torque_cost_daily_usd ${tokenUsage.cost || 0}`);

  // --- Extended metrics ---

  // Queue wait time histogram (time from created_at to started_at)
  const queueWaits = db.prepare(`
    SELECT
      CASE
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 10 THEN '10'
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 30 THEN '30'
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 60 THEN '60'
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 300 THEN '300'
        ELSE '600'
      END as bucket,
      COUNT(*) as count
    FROM tasks
    WHERE created_at IS NOT NULL AND started_at IS NOT NULL
    GROUP BY bucket
  `).all();
  for (const { bucket, count } of queueWaits) {
    metrics.push(`torque_queue_wait_seconds_bucket{le="${bucket}"} ${count}`);
  }

  // Tasks by provider
  const providerTasks = db.prepare(`
    SELECT provider, COUNT(*) as count
    FROM tasks
    WHERE provider IS NOT NULL
    GROUP BY provider
  `).all();
  for (const { provider, count } of providerTasks) {
    metrics.push(`torque_provider_tasks_total{provider="${escapePrometheusLabel(provider)}"} ${count}`);
  }

  // Average duration by provider
  const providerDurations = db.prepare(`
    SELECT provider,
      AVG((julianday(completed_at) - julianday(started_at)) * 86400) as avg_duration
    FROM tasks
    WHERE provider IS NOT NULL AND completed_at IS NOT NULL AND started_at IS NOT NULL
    GROUP BY provider
  `).all();
  for (const { provider, avg_duration } of providerDurations) {
    metrics.push(`torque_provider_duration_seconds{provider="${escapePrometheusLabel(provider)}"} ${(avg_duration || 0).toFixed(2)}`);
  }

  // Host slot usage
  try {
    const hostSlots = db.prepare(`
      SELECT name, running_tasks, max_concurrent
      FROM ollama_hosts
      WHERE enabled = 1
    `).all();
    for (const { name, running_tasks, max_concurrent } of hostSlots) {
      metrics.push(`torque_host_slots_used{host="${escapePrometheusLabel(name)}"} ${running_tasks || 0}`);
      metrics.push(`torque_host_slots_total{host="${escapePrometheusLabel(name)}"} ${max_concurrent || 1}`);
    }
  } catch { /* ollama_hosts table may not exist in test environments */ }

  // Stall count
  const stallCount = db.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE status = 'failed' AND exit_code = -2
  `).get();
  metrics.push(`torque_stall_total ${stallCount.count}`);

  // Retry count
  const retryCount = db.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE retry_count > 0
  `).get();
  metrics.push(`torque_retry_total ${retryCount.count}`);

  // Provider/transport usage telemetry
  try {
    const transportCallCounts = db.prepare(`
      SELECT
        provider,
        transport,
        CASE
          WHEN success = 1 THEN 'success'
          WHEN success = 0 THEN 'failure'
          ELSE 'unknown'
        END as outcome,
        COUNT(*) as count
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
      GROUP BY provider, transport, outcome
    `).all();

    for (const { provider, transport, outcome, count } of transportCallCounts) {
      metrics.push(`torque_provider_transport_calls_total{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}",outcome="${escapePrometheusLabel(outcome)}"} ${count}`);
    }

    const transportDuration = db.prepare(`
      SELECT
        provider,
        transport,
        SUM(elapsed_ms) as elapsed_sum_ms,
        AVG(elapsed_ms) as elapsed_avg_ms
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
        AND elapsed_ms IS NOT NULL
      GROUP BY provider, transport
    `).all();
    for (const {
      provider,
      transport,
      elapsed_sum_ms,
      elapsed_avg_ms,
    } of transportDuration) {
      const avgMs = Number(elapsed_avg_ms);
      metrics.push(`torque_provider_transport_elapsed_ms_sum{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}"} ${(elapsed_sum_ms || 0)}`);
      metrics.push(`torque_provider_transport_elapsed_ms_avg{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}"} ${Number.isFinite(avgMs) ? avgMs.toFixed(2) : 0}`);
    }

    const transportRetries = db.prepare(`
      SELECT
        provider,
        transport,
        SUM(retry_count) as retry_count_sum,
        AVG(retry_count) as retry_count_avg
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
        AND retry_count IS NOT NULL
      GROUP BY provider, transport
    `).all();
    for (const { provider, transport, retry_count_sum, retry_count_avg } of transportRetries) {
      const avgRetries = Number(retry_count_avg);
      metrics.push(`torque_provider_transport_retry_count_sum{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}"} ${retry_count_sum || 0}`);
      metrics.push(`torque_provider_transport_retry_count_avg{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}"} ${Number.isFinite(avgRetries) ? avgRetries.toFixed(2) : 0}`);
    }

    const failureReasons = db.prepare(`
      SELECT
        provider,
        transport,
        failure_reason,
        COUNT(*) as count
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
        AND failure_reason IS NOT NULL
        AND TRIM(failure_reason) != ''
      GROUP BY provider, transport, failure_reason
    `).all();
    for (const { provider, transport, failure_reason, count } of failureReasons) {
      metrics.push(`torque_provider_transport_failure_reason_total{provider="${escapePrometheusLabel(provider)}",transport="${escapePrometheusLabel(transport)}",failure_reason="${escapePrometheusLabel(failure_reason)}"} ${count}`);
    }
  } catch {
    metrics.push(`torque_provider_transport_metrics_unavailable 1`);
  }

  // Validation failures
  try {
    const validationFails = db.prepare(`
      SELECT COUNT(*) as count FROM task_validations WHERE passed = 0
    `).get();
    metrics.push(`torque_validation_failures_total ${validationFails.count}`);
  } catch {
    metrics.push(`torque_validation_failures_total 0`);
  }

  // Cost by provider
  try {
    const costByProvider = db.prepare(`
      SELECT provider, SUM(estimated_cost_usd) as cost
      FROM token_usage
      WHERE provider IS NOT NULL
      GROUP BY provider
    `).all();
    for (const { provider, cost } of costByProvider) {
      metrics.push(`torque_cost_by_provider{provider="${escapePrometheusLabel(provider)}"} ${(cost || 0).toFixed(6)}`);
    }
  } catch { /* token_usage may not have provider column */ }

  return metrics.join('\n');
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

  // Mark very old queued tasks as cancelled (likely abandoned)
  const staleQueued = db.prepare(`
    UPDATE tasks
    SET status = 'cancelled',
        completed_at = ?,
        error_output = COALESCE(error_output || char(10), '') || 'Task cancelled: queued too long (stale session cleanup)'
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

function isProviderHealthy(provider) {
  const entry = _getOrCreateHealth(provider);
  const total = entry.successes + entry.failures;
  if (total < 3) return true; // Not enough data
  return (entry.failures / total) < 0.30;
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

function resetProviderHealth() {
  _providerHealth.clear();
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

function createProviderRoutingCore({ db: dbInstance, taskCore, hostManagement } = {}) {
  if (dbInstance) setDb(dbInstance);
  if (taskCore) setGetTask(taskCore);
  if (hostManagement) setHostManagement(hostManagement);
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
  isProviderHealthy,
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
};
