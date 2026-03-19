'use strict';

/**
 * Host Benchmarking and Routing Cache Functions
 *
 * Extracted from host-management.js (benchmarking + model discovery helpers).
 */
const http = require('http');
const https = require('https');
const logger = require('../logger').child({ component: 'host-benchmarking' });
const { safeJsonParse } = require('../utils/json');

let db;

const MODEL_REFRESH_LOG_WINDOW_MS = 60 * 1000;
const modelRefreshFailureState = new Map();

function logThrottledModelRefreshFailure(key, message, data = {}) {
  const now = Date.now();
  const existing = modelRefreshFailureState.get(key);
  if (!existing || now - existing.lastLoggedAt >= MODEL_REFRESH_LOG_WINDOW_MS) {
    const suppressedCount = existing?.suppressedCount || 0;
    modelRefreshFailureState.set(key, { lastLoggedAt: now, suppressedCount: 0 });
    logger.warn(
      suppressedCount > 0 ? `${message} (${suppressedCount} similar failures suppressed)` : message,
      data
    );
    return;
  }
  existing.suppressedCount += 1;
  modelRefreshFailureState.set(key, existing);
}

function clearThrottledModelRefreshFailure(key) {
  modelRefreshFailureState.delete(key);
}

function setDb(instance) {
  db = instance;
}


function getOllamaHost(hostId) {
  const stmt = db.prepare('SELECT * FROM ollama_hosts WHERE id = ?');
  const host = stmt.get(hostId);
  if (host && host.models_cache) {
    try {
      host.models = JSON.parse(host.models_cache);
    } catch (_e) {
      void _e;
      host.models = [];
    }
  } else if (host) {
    host.models = [];
  }
  return host;
}

function listOllamaHosts(options = {}) {
  let query = 'SELECT * FROM ollama_hosts WHERE 1=1';
  const values = [];

  if (options.enabled !== undefined) {
    query += ' AND enabled = ?';
    values.push(options.enabled ? 1 : 0);
  }

  if (options.status) {
    query += ' AND status = ?';
    values.push(options.status);
  }

  query += ' ORDER BY running_tasks ASC, name ASC';

  const stmt = db.prepare(query);
  const hosts = stmt.all(...values);

  return hosts.map((host) => {
    if (host.models_cache) {
      try {
        host.models = JSON.parse(host.models_cache);
      } catch (_e) {
        void _e;
        host.models = [];
      }
    } else {
      host.models = [];
    }
    return host;
  });
}

function updateOllamaHost(hostId, updates) {
  const allowedFields = ['name', 'url', 'enabled', 'status', 'consecutive_failures',
    'last_health_check', 'last_healthy', 'running_tasks', 'models_cache', 'models_updated_at',
    'memory_limit_mb', 'max_concurrent', 'priority', 'settings', 'gpu_metrics_port'];
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getOllamaHost(hostId);

  values.push(hostId);
  const stmt = db.prepare(`UPDATE ollama_hosts SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);
  return getOllamaHost(hostId);
}

function setHostSettings(hostId, settings) {
  const host = getOllamaHost(hostId);
  if (!host) return null;

  let existingSettings = {};
  if (host.settings) {
    try {
      existingSettings = JSON.parse(host.settings);
    } catch (_e) {
      void _e;
    }
  }

  const mergedSettings = { ...existingSettings, ...settings };

  for (const key of Object.keys(mergedSettings)) {
    if (mergedSettings[key] === null || mergedSettings[key] === undefined) {
      delete mergedSettings[key];
    }
  }

  return updateOllamaHost(hostId, { settings: JSON.stringify(mergedSettings) });
}

// ============================================================
// Benchmark Results Functions
// ============================================================

/**
 * Record a benchmark result
 * @param {object} result - Benchmark result data
 * @returns {any}
 */
function recordBenchmarkResult(result) {
  const stmt = db.prepare(`
    INSERT INTO benchmark_results (
      host_id, model, test_type, prompt_type, tokens_per_second,
      prompt_tokens, output_tokens, eval_duration_seconds,
      num_gpu, num_ctx, temperature, success, error_message, raw_result, benchmarked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    result.hostId,
    result.model,
    result.testType || 'basic',
    result.promptType,
    result.tokensPerSecond,
    result.promptTokens,
    result.outputTokens,
    result.evalDurationSeconds,
    result.numGpu,
    result.numCtx,
    result.temperature,
    result.success ? 1 : 0,
    result.errorMessage,
    result.rawResult ? JSON.stringify(result.rawResult) : null,
    new Date().toISOString()
  );
}

/**
 * Get latest benchmark results for a host
 * @param {string} hostId - Host ID
 * @param {number} [limit=10] - Max results to return
 * @returns {Array} Benchmark results
 */
function getBenchmarkResults(hostId, limit = 10) {
  const stmt = db.prepare(`
    SELECT * FROM benchmark_results
    WHERE host_id = ?
    ORDER BY benchmarked_at DESC
    LIMIT ?
  `);
  return stmt.all(hostId, limit).map(row => ({
    ...row,
    success: row.success === 1,
    rawResult: safeJsonParse(row.raw_result, null),
  }));
}

/**
 * Get optimal settings based on benchmark results for a host
 * Analyzes benchmark data to find the best configuration
 * @param {string} hostId - Host ID
 * @param {string} [model] - Specific model to optimize for
 * @returns {{ numGpu: number, numCtx: number, tokensPerSecond: number } | null}
 */
function getOptimalSettingsFromBenchmarks(hostId, model = null) {
  let stmt;
  let params;

  if (model) {
    stmt = db.prepare(`
      SELECT num_gpu, num_ctx, tokens_per_second, model
      FROM benchmark_results
      WHERE host_id = ? AND model = ? AND success = 1 AND tokens_per_second IS NOT NULL
      ORDER BY tokens_per_second DESC
      LIMIT 1
    `);
    params = [hostId, model];
  } else {
    stmt = db.prepare(`
      SELECT num_gpu, num_ctx, AVG(tokens_per_second) as tokens_per_second
      FROM benchmark_results
      WHERE host_id = ? AND success = 1 AND tokens_per_second IS NOT NULL
      GROUP BY num_gpu, num_ctx
      ORDER BY tokens_per_second DESC
      LIMIT 1
    `);
    params = [hostId];
  }

  const result = stmt.get(...params);
  if (!result) return null;

  return {
    numGpu: result.num_gpu,
    numCtx: result.num_ctx,
    tokensPerSecond: Math.round(result.tokens_per_second * 100) / 100,
    model: result.model,
  };
}

/**
 * Apply optimal benchmark settings to a host
 * @param {string} hostId - Host ID
 * @param {string} [model] - Specific model to optimize for
 * @returns {{ applied: boolean, settings: object, reason: string }}
 */
function applyBenchmarkResults(hostId, model = null) {
  const optimal = getOptimalSettingsFromBenchmarks(hostId, model);
  if (!optimal) {
    return { applied: false, settings: null, reason: 'No benchmark results found' };
  }

  const settings = {};
  if (optimal.numGpu != null) settings.num_gpu = optimal.numGpu;
  if (optimal.numCtx != null) settings.num_ctx = optimal.numCtx;

  if (Object.keys(settings).length === 0) {
    return { applied: false, settings: null, reason: 'No optimizable settings found' };
  }

  setHostSettings(hostId, settings);
  return {
    applied: true,
    settings,
    tokensPerSecond: optimal.tokensPerSecond,
    reason: `Applied optimal settings: ${JSON.stringify(settings)}`,
  };
}

/**
 * Get benchmark statistics summary for a host
 * @param {string} hostId - Host ID
 * @returns {{ totalRuns: number, avgTps: number, bestModel: string, lastRun: string }}
 */
function getBenchmarkStats(hostId) {
  const statsStmt = db.prepare(`
    SELECT
      COUNT(*) as total_runs,
      AVG(tokens_per_second) as avg_tps,
      MAX(tokens_per_second) as max_tps,
      MIN(benchmarked_at) as first_run,
      MAX(benchmarked_at) as last_run
    FROM benchmark_results
    WHERE host_id = ? AND success = 1
  `);
  const stats = statsStmt.get(hostId);

  const bestModelStmt = db.prepare(`
    SELECT model, AVG(tokens_per_second) as avg_tps
    FROM benchmark_results
    WHERE host_id = ? AND success = 1
    GROUP BY model
    ORDER BY avg_tps DESC
    LIMIT 1
  `);
  const bestModel = bestModelStmt.get(hostId);

  return {
    totalRuns: stats.total_runs || 0,
    avgTps: stats.avg_tps ? Math.round(stats.avg_tps * 100) / 100 : null,
    maxTps: stats.max_tps ? Math.round(stats.max_tps * 100) / 100 : null,
    bestModel: bestModel?.model || null,
    bestModelTps: bestModel?.avg_tps ? Math.round(bestModel.avg_tps * 100) / 100 : null,
    firstRun: stats.first_run,
    lastRun: stats.last_run,
  };
}

// ============================================
// Host discovery helpers
// ============================================

function fetchModelsFromHost(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from host`));
        return;
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON from host'));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.on('error', reject);
  });
}

/**
 * Fetch models from an Ollama host.
 * Returns array of model objects or null on error.
 */
async function fetchHostModelsSync(hostUrl, timeoutMs = 5000) {
  const logKey = `host-model-fetch:${hostUrl}`;
  try {
    // SECURITY: Validate URL is well-formed before using
    let parsedUrl;
    try {
      parsedUrl = new URL(hostUrl);
    } catch (error) {
      logThrottledModelRefreshFailure(
        logKey,
        `[Host Benchmarking] Skipping model refresh for invalid host URL: ${hostUrl}`,
        { hostUrl, error: error?.message || String(error) }
      );
      return null;
    }

    // SECURITY: Block public IPs — Ollama hosts must be on private/local networks
    const hostname = parsedUrl.hostname.toLowerCase();
    const isPrivateIP = (ip) => /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|fd|fc)/i.test(ip);
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (ipv4Match) {
        if (!isPrivateIP(hostname)) {
          logThrottledModelRefreshFailure(
            logKey,
            `[Host Benchmarking] Blocked model refresh for public IP: ${hostname}`,
            { hostUrl, hostname }
          );
          return null;
        }
      }
    }

    const tagsUrl = `${hostUrl}/api/tags`;
    const response = await fetchModelsFromHost(tagsUrl, timeoutMs);

    if (!response || !response.models) {
      logThrottledModelRefreshFailure(
        logKey,
        `[Host Benchmarking] Host ${hostUrl} returned no models during refresh`,
        { hostUrl }
      );
      return null;
    }

    clearThrottledModelRefreshFailure(logKey);
    return response.models || [];
  } catch (error) {
    logThrottledModelRefreshFailure(
      logKey,
      `[Host Benchmarking] Failed to refresh models from ${hostUrl}: ${error?.message || String(error)}`,
      { hostUrl, error: error?.message || String(error) }
    );
    return null;
  }
}

/**
 * Ensure all enabled hosts have models_cache populated
 * Called before model selection to prevent "no model available" errors due to empty cache
 */
let _lastEnsureModelsLoadedAt = 0;
const ENSURE_MODELS_TTL_MS = 30000; // Only re-probe hosts every 30 seconds

function ensureModelsLoaded() {
  // TTL guard: don't probe hosts more than once per 30 seconds
  // The periodic health check (every 60s) already refreshes models;
  // this is only a safety net for hosts with empty caches.
  const now = Date.now();
  if (now - _lastEnsureModelsLoadedAt < ENSURE_MODELS_TTL_MS) {
    return 0;
  }
  _lastEnsureModelsLoadedAt = now;

  const hosts = listOllamaHosts({ enabled: true });
  let refreshedCount = 0;

  for (const host of hosts) {
    if (host.models_cache && host.models && host.models.length > 0) {
      continue;
    }

    if (host.status === 'down') {
      continue;
    }

    const modelsPromise = fetchHostModelsSync(host.url);
    if (modelsPromise) {
      refreshedCount += 1;
      const cacheLogKey = `host-model-cache:${host.id}`;
      void modelsPromise.then((models) => {
        if (models === null) return;
        updateOllamaHost(host.id, {
          models_cache: JSON.stringify(models),
          models_updated_at: new Date().toISOString(),
          status: 'healthy',
          consecutive_failures: 0
        });
        clearThrottledModelRefreshFailure(cacheLogKey);
      }).catch((error) => {
        logThrottledModelRefreshFailure(
          cacheLogKey,
          `[Host Benchmarking] Failed to cache refreshed models for ${host.name || host.id}: ${error?.message || String(error)}`,
          { hostId: host.id, hostUrl: host.url, error: error?.message || String(error) }
        );
      });
    }
  }

  return refreshedCount;
}

module.exports = {
  setDb,
  setHostSettings,
  recordBenchmarkResult,
  getBenchmarkResults,
  getOptimalSettingsFromBenchmarks,
  applyBenchmarkResults,
  getBenchmarkStats,
  ensureModelsLoaded,
  // Shared host-probing utilities (canonical home — used by host-management.js)
  fetchModelsFromHost,
  fetchHostModelsSync,
  logThrottledModelRefreshFailure,
  clearThrottledModelRefreshFailure,
};
