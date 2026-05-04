/**
 * Host Monitoring Module
 *
 * Extracted from task-manager.js — GPU/model activity monitoring,
 * host health checks, nvidia-smi probing, LAN discovery initialization.
 *
 * Uses init() dependency injection to receive db, dashboard, and callbacks.
 */

const http = require('http');
const https = require('https');
const { execFile, spawnSync } = require('child_process');
const logger = require('../logger').child({ component: 'host-monitoring' });
const serverConfig = require('../config');
const { TASK_TIMEOUTS } = require('../constants');
const { isHostOverloaded } = require('../utils/resource-gate');

// Injected dependencies
let db;
let dashboard;
let cleanupOrphanedHostTasksFn;
let queueLockHolderId;

/**
 * Initialize the module with required dependencies.
 * Must be called before startTimers() or any other function.
 */
function init(deps) {
  db = deps.db;
  dashboard = deps.dashboard;
  cleanupOrphanedHostTasksFn = deps.cleanupOrphanedHostTasks;
  queueLockHolderId = deps.queueLockHolderId;
  serverConfig.init({ db: deps.db });
}

// In-memory cache of host GPU/model activity from /api/ps + nvidia-smi
// Key: hostId, Value: { models: [...], polledAt: timestamp, gpuMetrics: {...} | null }
const hostActivityCache = new Map();

// nvidia-smi availability flag — set false on first failure, never retry
let nvidiaSmiAvailable = null; // null = not yet probed
let nvidiaSmiPath = null;

// Cached set of local IPv4 addresses for GPU probing (null = not yet built)
let cachedLocalIPs = null;

// Timer handles for cleanup
let healthCheckInterval;
let activityPollInterval;
let healthCheckStartupTimeout;

// Signal handler references for dedup (bug #4)
let sigTermHandler = null;
let sigIntHandler = null;
// Discovery signal handler references for dedup (RB-021)
let discoveryShutdownHandler = null;

const MONITORING_LOG_WINDOW_MS = 60 * 1000;
const monitoringFailureState = new Map();

/**
 * Normalize an unknown error object into a single string message.
 *
 * @param {*} error - Raw error value (can be Error, string, or any value).
 * @returns {string} Safe text to log or persist.
 */
function getErrorMessage(error) {
  if (!error) return 'Unknown error';
  return error.message || String(error);
}

/**
 * Log monitoring failures with throttle to avoid spamming logs.
 *
 * If repeated with the same key, only logs once per window and tracks suppression count.
 *
 * @param {'info'|'warn'|'error'|'debug'} level
 * @param {string} key - Failure grouping key
 * @param {string} message - Log message
 * @param {object} data - Additional log metadata
 */
function logThrottledMonitoringIssue(level, key, message, data = {}) {
  const now = Date.now();
  const existing = monitoringFailureState.get(key);
  if (!existing || now - existing.lastLoggedAt >= MONITORING_LOG_WINDOW_MS) {
    const suppressedCount = existing?.suppressedCount || 0;
    monitoringFailureState.set(key, { lastLoggedAt: now, suppressedCount: 0 });
    logger[level](
      suppressedCount > 0 ? `${message} (${suppressedCount} similar failures suppressed)` : message,
      data
    );
    return;
  }
  existing.suppressedCount += 1;
  monitoringFailureState.set(key, existing);
}

/**
 * Clear suppressed monitoring state for a key.
 *
 * @param {string} key
 */
function clearMonitoringIssue(key) {
  monitoringFailureState.delete(key);
}

/**
 * Check whether an error looks like a transient DB shutdown condition.
 *
 * @param {*} error
 * @returns {boolean} True when error matches known DB shutdown messages
 */
function isExpectedDbShutdownError(error) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('database connection is not open') ||
    message.includes('database is closed') ||
    message.includes('database has been closed') ||
    message.includes('cannot operate on a closed database');
}

/**
 * Periodically check health of all enabled Ollama hosts.
 * Auto-recovers downed hosts and refreshes model lists.
 */
async function runHostHealthChecks() {
  try {
    const hosts = db.listOllamaHosts({ enabled: true });
    if (!hosts || hosts.length === 0) return;

    for (const host of hosts) {
      try {
        const hostLogKey = `health-check:${host.id}`;
        const url = new URL('/api/tags', host.url);
        const client = url.protocol === 'https:' ? https : http;

        const result = await new Promise((resolve) => {
          const req = client.get(url.href, { timeout: TASK_TIMEOUTS.HEALTH_CHECK }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              if (res.statusCode === 200) {
                try {
                  const parsed = JSON.parse(data);
                  const models = (parsed.models || []).map(m => m.name || m.model).filter(Boolean);
                  resolve({ healthy: true, models });
                } catch (error) {
                  logThrottledMonitoringIssue(
                    'warn',
                    `${hostLogKey}:invalid-json`,
                    `[Health Check] Host ${host.name || host.url} returned invalid JSON from /api/tags`,
                    { hostId: host.id, hostUrl: host.url, error: getErrorMessage(error) }
                  );
                  resolve({ healthy: true, models: null });
                }
              } else {
                resolve({ healthy: false, models: null, failureReason: `HTTP ${res.statusCode}` });
              }
            });
          });
          req.on('error', (error) => resolve({ healthy: false, models: null, failureReason: getErrorMessage(error) }));
          req.on('timeout', () => { req.destroy(); resolve({ healthy: false, models: null, failureReason: 'timeout' }); });
        });

        // Auto-recover hosts that were down
        if (result.healthy && host.status === 'down') {
          try {
            db.recoverOllamaHost(host.id);
            logger.info(`[Health Check] Host ${host.name || host.url} auto-recovered`);
          } catch (e) {
            logger.info(`[Health Check] Recovery failed for ${host.name || host.url}: ${e.message}`);
          }
        }

        // Track previous status to detect down transitions
        const previousStatus = host.status;
        const activeTaskCount = getDeferredHealthFailureRunningTaskCount(host, result);
        if (activeTaskCount > 0) {
          logThrottledMonitoringIssue(
            'warn',
            `${hostLogKey}:busy-timeout`,
            `[Health Check] Host ${host.name || host.url} health probe timed out while task(s) are running; preserving host status`,
            { hostId: host.id, hostUrl: host.url, runningTasks: activeTaskCount }
          );
          continue;
        }

        db.recordHostHealthCheck(host.id, result.healthy, result.models);
        if (result.healthy) {
          clearMonitoringIssue(hostLogKey);
        }

        // Feed discovered models into registry for approval tracking
        if (result.healthy && result.models && result.models.length > 0) {
          try {
            const registry = require('../models/registry');
            const provider = 'ollama';
            const sync = registry.syncModelsFromHealthCheck(provider, host.id, result.models);
            if (sync.new.length > 0) {
              logger.info(`[Health Check] ${sync.new.length} new model(s) on ${host.name || host.url}: ${sync.new.map(m => m.model_name).join(', ')}`);
              // Post-discovery: apply heuristic capabilities + auto-assign roles for new models
              try {
                const { runPostDiscovery } = require('../discovery/discovery-engine');
                const rawDb = db.getDbInstance ? db.getDbInstance() : db;
                runPostDiscovery(rawDb, provider, sync);
              } catch (_postErr) { void _postErr; }
            }
          } catch (_err) { void _err; /* registry not available */ }
        }

        // Check if host just transitioned to down status (3 consecutive failures)
        if (!result.healthy) {
          const updatedHost = db.getOllamaHost(host.id);
          if (updatedHost && updatedHost.status === 'down' && previousStatus !== 'down') {
            // Host just went down - cleanup orphaned tasks
            if (cleanupOrphanedHostTasksFn) {
              cleanupOrphanedHostTasksFn(host.id, host.name || host.url);
            }
          }
        }
      } catch (error) {
        logThrottledMonitoringIssue(
          'warn',
          `health-check:${host.id}`,
          `[Health Check] Failed to check ${host.name || host.url}: ${getErrorMessage(error)}`,
          { hostId: host.id, hostUrl: host.url, error: getErrorMessage(error) }
        );
        db.recordHostHealthCheck(host.id, false);
      }
    }
  } catch (err) {
    logger.info(`[Health Check] Error: ${err.message}`);
  }
}

function getDeferredHealthFailureRunningTaskCount(host, result) {
  if (!host || !result || result.healthy || result.failureReason !== 'timeout') {
    return 0;
  }

  if (typeof db?.getRunningTasksForHost === 'function') {
    try {
      const runningTasks = db.getRunningTasksForHost(host.id);
      return Array.isArray(runningTasks) ? runningTasks.length : 0;
    } catch (_err) {
      void _err;
    }
  }

  return Number(host.running_tasks || 0);
}

/**
 * Probe Codex API to check if quota has recovered.
 * Called from health check timer. Only probes when:
 * 1. codex_exhausted flag is set
 * 2. Enough time has elapsed since last exhaustion (configurable interval)
 *
 * Attempts an authenticated API probe (OpenAI models endpoint) if OPENAI_API_KEY
 * is available; falls back to CLI version check otherwise.
 * Classifies probe outcomes: quota, auth, network, cli.
 */
async function probeCodexRecovery() {
  if (!serverConfig.isOptIn('codex_exhausted')) return;

  const intervalMinutes = serverConfig.getInt('codex_probe_interval_minutes', 15);
  const exhaustedAt = serverConfig.get('codex_exhausted_at');
  if (exhaustedAt) {
    const elapsedMs = Date.now() - new Date(exhaustedAt).getTime();
    if (elapsedMs < intervalMinutes * 60 * 1000) return; // Too soon
  }

  logger.info('[Codex Probe] Checking if Codex quota has recovered...');

  // Prefer authenticated API probe over CLI help check
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const https = require('https');
      const probeResult = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.openai.com',
          path: '/v1/models',
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          timeout: 10000
        }, (res) => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });

      if (probeResult.status === 200) {
        db.setCodexExhausted(false);
        logger.info('[Codex Probe] API responsive (HTTP 200) — clearing exhaustion flag');
        return;
      } else if (probeResult.status === 429) {
        db.setConfig('codex_exhausted_at', new Date().toISOString());
        logger.info('[Codex Probe] Quota still exhausted (HTTP 429) — will retry in ' + intervalMinutes + ' minutes');
        return;
      } else if (probeResult.status === 401 || probeResult.status === 403) {
        db.setConfig('codex_exhausted_at', new Date().toISOString());
        logger.info(`[Codex Probe] Auth failure (HTTP ${probeResult.status}) — check OPENAI_API_KEY`);
        return;
      }
      // Other status codes — fall through to CLI probe
      logger.info(`[Codex Probe] Unexpected API response (HTTP ${probeResult.status}) — falling back to CLI probe`);
    } catch (apiErr) {
      logger.info(`[Codex Probe] API probe failed (${apiErr.message}) — falling back to CLI probe`);
    }
  }

  // Fallback: CLI version check (verifies binary exists, not quota)
  try {
    const result = spawnSync('npx', ['codex', '--version'], {
      timeout: 10000,
      stdio: 'pipe',
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    if (result.status === 0) {
      db.setCodexExhausted(false);
      logger.info('[Codex Probe] Codex CLI responsive — clearing exhaustion flag');
    } else {
      const stderr = (result.stderr || '').toString();
      const isQuota = stderr.includes('rate_limit') || stderr.includes('quota') || stderr.includes('429');
      db.setConfig('codex_exhausted_at', new Date().toISOString());
      logger.info(`[Codex Probe] Codex still unavailable (${isQuota ? 'quota' : 'cli'}) — will retry in ${intervalMinutes} minutes`);
    }
  } catch (e) {
    db.setConfig('codex_exhausted_at', new Date().toISOString());
    logger.info(`[Codex Probe] Probe failed: ${e.message}`);
  }
}

// ============================================================
// GPU / Model Activity Monitoring
// ============================================================

/**
 * Normalize model name for comparison (strips :latest tag)
 * @param {string} name - Model name to normalize
 * @returns {string} Normalized model name
 */
function normalizeModelName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/:latest$/, '');
}

/**
 * Check if a model is currently loaded on a host (via cached /api/ps data)
 * @param {string} hostId - Host ID to check
 * @param {string} modelName - Model name to look for
 * @returns {boolean|null} true/false if data available, null if no data yet
 */
function isModelLoadedOnHost(hostId, modelName) {
  const activity = hostActivityCache.get(hostId);
  if (!activity || !activity.models) return null; // null = unknown (no data yet)
  // Guard against malformed Ollama /api/ps responses (bug #6)
  if (!Array.isArray(activity.models)) return false;
  const normalized = normalizeModelName(modelName);
  return activity.models.some(m =>
    m && (normalizeModelName(m.name) === normalized || normalizeModelName(m.model) === normalized)
  );
}

/**
 * Get all host activity data for the dashboard
 * @returns {Object} Map of hostId -> { loadedModels, totalVramUsed, gpuMetrics, polledAt }
 */
function getHostActivity() {
  const result = {};
  for (const [hostId, activity] of hostActivityCache) {
    result[hostId] = {
      loadedModels: (activity.models || []).map(m => ({
        name: m.name,
        sizeVram: m.size_vram,
        expiresAt: m.expires_at
      })),
      totalVramUsed: (activity.models || []).reduce((sum, m) => sum + (m.size_vram || 0), 0),
      gpuMetrics: activity.gpuMetrics || null,
      polledAt: activity.polledAt
    };
  }
  return result;
}

/**
 * Poll /api/ps on each enabled host to get loaded model info
 */
async function pollHostActivity() {
  const hosts = db.listOllamaHosts({ enabled: true });
  if (!hosts || hosts.length === 0) return;

  // Prune cache entries for hosts no longer in the pool
  const activeHostIds = new Set(hosts.map(h => h.id));
  for (const cachedId of hostActivityCache.keys()) {
    if (!activeHostIds.has(cachedId)) {
      hostActivityCache.delete(cachedId);
    }
  }

  for (const host of hosts) {
    // Only poll healthy hosts or hosts with unknown running task count
    if (host.status !== 'healthy') continue;

    try {
      const pollLogKey = `activity-poll:${host.id}`;
      const url = new URL('/api/ps', host.url);
      const client = url.protocol === 'https:' ? https : http;
      const pollResult = await new Promise((resolve) => {
        const req = client.get(url.href, { timeout: TASK_TIMEOUTS.HEALTH_CHECK }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                resolve({ psData: JSON.parse(data), failureReason: null });
              } catch (error) {
                resolve({ psData: null, failureReason: `invalid JSON: ${getErrorMessage(error)}` });
              }
            } else {
              resolve({ psData: null, failureReason: `HTTP ${res.statusCode}` });
            }
          });
        });
        req.on('error', (error) => resolve({ psData: null, failureReason: getErrorMessage(error) }));
        req.on('timeout', () => { req.destroy(); resolve({ psData: null, failureReason: 'timeout' }); });
      });

      if (pollResult.psData) {
        const existing = hostActivityCache.get(host.id) || {};
        hostActivityCache.set(host.id, {
          ...existing,
          models: pollResult.psData.models || [],
          polledAt: Date.now()
        });
        clearMonitoringIssue(pollLogKey);
      } else {
        logThrottledMonitoringIssue(
          'warn',
          pollLogKey,
          `[Host Activity] Failed to poll ${host.name || host.url}: ${pollResult.failureReason || 'unknown failure'}`,
          { hostId: host.id, hostUrl: host.url, error: pollResult.failureReason || 'unknown failure' }
        );
      }
    } catch (error) {
      logThrottledMonitoringIssue(
        'warn',
        `activity-poll:${host.id}`,
        `[Host Activity] Poll failed for ${host.name || host.url}: ${getErrorMessage(error)}`,
        { hostId: host.id, hostUrl: host.url, error: getErrorMessage(error) }
      );
    }
  }

  // Probe local GPU metrics (nvidia-smi) for localhost hosts
  await probeLocalGpuMetrics(hosts);

  // Probe remote GPU metrics (gpu-metrics-server companion script)
  await probeRemoteGpuMetrics(hosts);

  // Notify dashboard of updated activity
  try {
    if (dashboard && dashboard.notifyHostActivityUpdated) {
      dashboard.notifyHostActivityUpdated();
    }
  } catch (error) {
    logThrottledMonitoringIssue(
      'debug',
      'activity-dashboard-notify',
      `[Host Activity] Failed to notify dashboard listeners: ${getErrorMessage(error)}`,
      { error: getErrorMessage(error) }
    );
  }

  // Check for resource pressure and log overload events
  for (const [hostId, activity] of hostActivityCache) {
    if (activity.gpuMetrics && isHostOverloaded(activity.gpuMetrics)) {
      logger.info(`[Host Activity] Resource pressure on ${hostId}: CPU=${activity.gpuMetrics.cpuPercent}%, RAM=${activity.gpuMetrics.ramPercent}%`);
      if (dashboard && dashboard.broadcast) {
        try {
          dashboard.broadcast('hosts:resource-pressure', {
            hostId,
            cpuPercent: activity.gpuMetrics.cpuPercent,
            ramPercent: activity.gpuMetrics.ramPercent,
            timestamp: Date.now()
          });
        } catch { /* best-effort */ }
      }
    }
  }
}

/**
 * Probe nvidia-smi for local GPU metrics (optional, best-effort)
 * @param {Array} hosts - List of all enabled hosts
 */
async function probeLocalGpuMetrics(hosts) {
  if (nvidiaSmiAvailable === false) return;

  // Build local IP set on first call using OS network interfaces
  if (cachedLocalIPs === null) {
    const os = require('os');
    cachedLocalIPs = new Set(['localhost', '127.0.0.1']);
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4') cachedLocalIPs.add(addr.address);
      }
    }
  }

  // Probe hosts on the same physical machine (any local network interface)
  const localHosts = hosts.filter(h => {
    if (!h.url) return false;
    try {
      const hostname = new URL(h.url).hostname;
      return cachedLocalIPs.has(hostname);
    } catch { return false; }
  });
  if (localHosts.length === 0) return;

  // Discover nvidia-smi path on first call
  if (nvidiaSmiAvailable === null) {
    nvidiaSmiPath = await findNvidiaSmi();
    nvidiaSmiAvailable = !!nvidiaSmiPath;
    if (!nvidiaSmiAvailable) return;
  }

  try {
    const output = await new Promise((resolve, reject) => {
      execFile(nvidiaSmiPath, [
        '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
        '--format=csv,noheader,nounits'
      ], { timeout: TASK_TIMEOUTS.PROCESS_QUERY, windowsHide: true }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout.trim());
      });
    });

    const parts = output.split(',').map(s => s.trim());
    if (parts.length >= 5) {
      const gpuMetrics = {
        gpuUtilizationPercent: parseInt(parts[0], 10) || 0,
        vramUsedMb: parseInt(parts[1], 10) || 0,
        vramTotalMb: parseInt(parts[2], 10) || 0,
        temperatureC: parseInt(parts[3], 10) || 0,
        powerDrawW: parseFloat(parts[4]) || 0
      };
      let getCpuPercent, getRamPercent;
      try {
        ({ getCpuPercent, getRamPercent } = require('../scripts/gpu-metrics-server'));
      } catch (err) {
        logger.warn(`gpu-metrics-server not available: ${err.message}`);
        getCpuPercent = () => 0;
        getRamPercent = () => 0;
      }

      for (const host of localHosts) {
        const existing = hostActivityCache.get(host.id) || {};
        hostActivityCache.set(host.id, {
          ...existing,
          gpuMetrics: {
            ...gpuMetrics,
            cpuPercent: getCpuPercent(),
            ramPercent: getRamPercent()
          }
        });
      }
    }
  } catch (error) {
    logThrottledMonitoringIssue(
      'debug',
      'local-gpu-probe',
      `[Host Activity] nvidia-smi probe failed: ${getErrorMessage(error)}`,
      { error: getErrorMessage(error) }
    );
  }
}

/**
 * Probe remote GPU metrics from hosts running gpu-metrics-server.js
 * @param {Array} hosts - List of all enabled hosts
 */
async function probeRemoteGpuMetrics(hosts) {
  // Build local IP set if needed (reuse from probeLocalGpuMetrics)
  if (cachedLocalIPs === null) {
    const os = require('os');
    cachedLocalIPs = new Set(['localhost', '127.0.0.1']);
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4') cachedLocalIPs.add(addr.address);
      }
    }
  }

  // Identify all remote hosts
  const allRemoteHosts = hosts.filter(h => {
    if (!h.url) return false;
    try {
      const hostname = new URL(h.url).hostname;
      return !cachedLocalIPs.has(hostname);
    } catch { return false; }
  });

  // Probe gpu-metrics-server for hosts that have it configured
  const metricsHosts = allRemoteHosts.filter(h => h.gpu_metrics_port);
  if (metricsHosts.length > 0) {
    await Promise.all(metricsHosts.map(host => {
      return new Promise(resolve => {
        try {
          const hostIp = new URL(host.url).hostname;
          const metricsUrl = `http://${hostIp}:${host.gpu_metrics_port}/metrics`;
          const url = new URL(metricsUrl);
          const client = url.protocol === 'https:' ? https : http;

          const req = client.get(url.href, { timeout: TASK_TIMEOUTS.HEALTH_CHECK }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              if (res.statusCode === 200) {
                try {
                  const metrics = JSON.parse(data);
                  // Validate expected shape
                  if (metrics.gpuUtilizationPercent !== undefined && metrics.vramTotalMb !== undefined) {
                    // Flatten CPU/RAM percentages for dashboard consumption
                    if (metrics.cpu?.usage_percent != null) metrics.cpuPercent = metrics.cpu.usage_percent;
                    if (metrics.memory?.usage_percent != null) metrics.ramPercent = metrics.memory.usage_percent;
                    const existing = hostActivityCache.get(host.id) || {};
                    hostActivityCache.set(host.id, { ...existing, gpuMetrics: metrics });
                    clearMonitoringIssue(`remote-gpu-metrics:${host.id}`);
                  }
                } catch (error) {
                  logThrottledMonitoringIssue(
                    'debug',
                    `remote-gpu-metrics:${host.id}`,
                    `[Host Activity] Invalid GPU metrics JSON from ${host.name || host.url}`,
                    { hostId: host.id, hostUrl: host.url, error: getErrorMessage(error) }
                  );
                }
              }
              resolve();
            });
          });
          req.on('error', () => {
            // Clear stale gpuMetrics when endpoint is unreachable
            const existing = hostActivityCache.get(host.id);
            if (existing && existing.gpuMetrics) {
              hostActivityCache.set(host.id, { ...existing, gpuMetrics: null });
            }
            resolve();
          });
          req.on('timeout', () => {
            req.destroy();
            const existing = hostActivityCache.get(host.id);
            if (existing && existing.gpuMetrics) {
              hostActivityCache.set(host.id, { ...existing, gpuMetrics: null });
            }
            resolve();
          });
        } catch (error) {
          logThrottledMonitoringIssue(
            'debug',
            `remote-gpu-metrics:${host.id}`,
            `[Host Activity] Failed to query GPU metrics for ${host.name || host.url}: ${getErrorMessage(error)}`,
            { hostId: host.id, hostUrl: host.url, error: getErrorMessage(error) }
          );
          resolve();
        }
      });
    }));
  }

  // Fallback: for remote hosts without gpu-metrics-server data, synthesize
  // VRAM metrics from Ollama /api/ps data (already cached) + memory_limit_mb.
  // This gives the dashboard VRAM bars without needing a companion service.
  for (const host of allRemoteHosts) {
    const existing = hostActivityCache.get(host.id);
    // Skip hosts that already have real gpu-metrics-server data
    if (existing?.gpuMetrics) continue;
    // Need memory_limit_mb to know total VRAM
    if (!host.memory_limit_mb) continue;

    const models = existing?.models || [];
    const vramUsedBytes = models.reduce((sum, m) => sum + (m.size_vram || 0), 0);
    const vramUsedMb = Math.round(vramUsedBytes / (1024 * 1024));

    const syntheticMetrics = {
      vramUsedMb,
      vramTotalMb: host.memory_limit_mb,
      // These fields are unavailable without nvidia-smi — mark as null so the
      // dashboard can distinguish synthetic from real metrics
      gpuUtilizationPercent: null,
      temperatureC: null,
      powerDrawW: null,
      synthetic: true, // flag for dashboard to render appropriately
    };

    hostActivityCache.set(host.id, { ...existing, gpuMetrics: syntheticMetrics });
  }
}

/**
 * Find nvidia-smi executable path
 * @returns {Promise<string|null>} Path to nvidia-smi or null if not found
 */
async function findNvidiaSmi() {
  const candidates = process.platform === 'win32'
    ? ['nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe']
    : ['nvidia-smi', '/usr/bin/nvidia-smi'];

  for (const candidate of candidates) {
    try {
      await new Promise((resolve, reject) => {
        execFile(candidate, ['--version'], { timeout: TASK_TIMEOUTS.HEALTH_CHECK, windowsHide: true }, (err) => {
          if (err) reject(err); else resolve();
        });
      });
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}

// ============================================================
// LAN Discovery Initialization
// ============================================================

/**
 * Initialize LAN discovery for Ollama hosts
 * Runs automatically when module is loaded
 */
function initializeDiscovery() {
  // Delay initialization to ensure database is ready.
  // Stored at module level so stopTimers() can cancel it if shutdown fires
  // before the 1-second delay elapses (prevents orphaned interval at exit).
  discoveryInitTimeout = setTimeout(() => {
    discoveryInitTimeout = null;
    try {
      if (!serverConfig.getBool('discovery_enabled')) {
        logger.info('[Discovery] Disabled by configuration');
        return;
      }

      const discovery = require('../providers/ollama-mdns-discovery');
      discovery.initDiscovery();

      // Initialize auto-scan if enabled in config
      discovery.initAutoScanFromConfig();

      // Set up graceful shutdown handlers (dedup: remove old before adding new)
      if (discoveryShutdownHandler) {
        process.removeListener('SIGTERM', discoveryShutdownHandler);
        process.removeListener('SIGINT', discoveryShutdownHandler);
      }
      discoveryShutdownHandler = () => {
        logger.info('[Discovery] Shutting down...');
        discovery.stopAutoScan();
        discovery.shutdownDiscovery();
      };

      process.on('SIGTERM', discoveryShutdownHandler);
      process.on('SIGINT', discoveryShutdownHandler);

    } catch (err) {
      logger.info(`[Discovery] Failed to initialize: ${err.message}`);
    }
  }, 1000);
  // unref so test workers can exit; server stays alive via HTTP listeners
  discoveryInitTimeout.unref();
}

/**
 * Start periodic health checks, activity polling, and discovery.
 * Call after init() to ensure dependencies are injected.
 */
// Bootstrap timeouts that must be cancellable on shutdown
let healthCheckBootstrapTimeout = null;
let activityPollBootstrapTimeout = null;
let timersStarted = false;
// Discovery init timeout — tracked at module level so stopTimers() can cancel it
// if shutdown fires before the 1-second delay elapses
let discoveryInitTimeout = null;

/**
 * Start and cache periodic monitoring timers exactly once.
 *
 * @returns {void}
 */
function startTimers() {
  if (timersStarted) return;
  timersStarted = true;

  // Run health checks periodically (defer config read until first tick to avoid pre-init db access)
  // Wrapped with distributed lock so only one MCP instance runs health checks per cycle
  healthCheckBootstrapTimeout = setTimeout(() => {
    healthCheckBootstrapTimeout = null;
    if (db.isReady && !db.isReady()) return; // DB not initialized yet — skip bootstrap
    try {
      const healthCheckIntervalSeconds = serverConfig.getInt('health_check_interval_seconds', 60);
      healthCheckInterval = setInterval(() => {
        if (db.isReady && !db.isReady()) return; // DB not initialized yet — skip cycle
        try {
          const lockResult = db.acquireLock('health_check_runner', queueLockHolderId, healthCheckIntervalSeconds, null);
        if (lockResult.acquired) {
          runHostHealthChecks();
          probeCodexRecovery().catch(e => logger.debug(`Codex probe error: ${e.message}`));
          try {
            const wsModel = require('../workstation/model');
            const { checkWorkstation } = require('../workstation/health-check');
            const wsList = wsModel.listWorkstations({ enabled: true });
            for (const ws of wsList) {
              checkWorkstation(ws).then(result => {
                wsModel.recordHealthCheck(ws.id, result.healthy, result.models, result.system);
              }).catch(() => {
                wsModel.recordHealthCheck(ws.id, false);
              });
            }
          } catch { /* workstation health deferred */ }
          }
          // If lock held by sibling, skip this cycle
        } catch (error) {
          logThrottledMonitoringIssue(
            'warn',
            'health-check-scheduler',
            `[Health Check] Scheduled cycle failed: ${getErrorMessage(error)}`,
            { error: getErrorMessage(error) }
          );
        }
      }, healthCheckIntervalSeconds * 1000);
      healthCheckInterval.unref();
    } catch (error) {
      if (!isExpectedDbShutdownError(error)) {
        logThrottledMonitoringIssue(
          'warn',
          'health-check-startup',
          `[Health Check] Failed to start scheduler: ${getErrorMessage(error)}`,
          { error: getErrorMessage(error) }
        );
      }
    }
  }, 0);
  healthCheckBootstrapTimeout.unref();

  // Run once on startup (delayed 15s) and warm model cache
  healthCheckStartupTimeout = setTimeout(() => {
    try {
      runHostHealthChecks();
      db.ensureModelsLoaded();
    } catch (error) {
      if (!isExpectedDbShutdownError(error)) {
        logThrottledMonitoringIssue(
          'warn',
          'health-check-bootstrap',
          `[Health Check] Startup warm check failed: ${getErrorMessage(error)}`,
          { error: getErrorMessage(error) }
        );
      }
    }
  }, 15000);
  healthCheckStartupTimeout.unref();

  // Activity polling (GPU/model status) — faster than health checks, lightweight
  // Wrapped with distributed lock so only one MCP instance runs polling per cycle
  activityPollBootstrapTimeout = setTimeout(() => {
    activityPollBootstrapTimeout = null;
    if (db.isReady && !db.isReady()) return; // DB not initialized yet — skip bootstrap
    try {
      const intervalSec = serverConfig.getInt('activity_poll_interval_seconds', 10);
      activityPollInterval = setInterval(() => {
        if (db.isReady && !db.isReady()) return; // DB not initialized yet — skip cycle
        try {
          const lockResult = db.acquireLock('activity_poll_runner', queueLockHolderId, intervalSec, null);
          if (lockResult.acquired) {
            pollHostActivity().catch((error) => {
              logThrottledMonitoringIssue(
                'warn',
                'activity-poll-runner',
                `[Host Activity] Poll cycle failed: ${getErrorMessage(error)}`,
                { error: getErrorMessage(error) }
              );
            });
          }
        } catch (error) {
          logThrottledMonitoringIssue(
            'warn',
            'activity-poll-scheduler',
            `[Host Activity] Scheduled poll failed: ${getErrorMessage(error)}`,
            { error: getErrorMessage(error) }
          );
        }
      }, intervalSec * 1000);
      activityPollInterval.unref();
      // Initial poll after 5 seconds
      const initialPollTimer = setTimeout(() => {
        pollHostActivity().catch((error) => {
          logThrottledMonitoringIssue(
            'warn',
            'activity-poll-bootstrap',
            `[Host Activity] Initial poll failed: ${getErrorMessage(error)}`,
            { error: getErrorMessage(error) }
          );
        });
      }, 5000);
      initialPollTimer.unref();
    } catch (error) {
      if (!isExpectedDbShutdownError(error)) {
        logThrottledMonitoringIssue(
          'warn',
          'activity-poll-config',
          `[Host Activity] Failed to start polling: ${getErrorMessage(error)}`,
          { error: getErrorMessage(error) }
        );
      }
    }
  }, 2000);
  activityPollBootstrapTimeout.unref();

  // Register signal handlers for graceful shutdown (dedup: remove old before adding new)
  if (sigTermHandler) process.removeListener('SIGTERM', sigTermHandler);
  if (sigIntHandler) process.removeListener('SIGINT', sigIntHandler);
  sigTermHandler = () => { stopTimers(); };
  sigIntHandler = () => { stopTimers(); };
  process.on('SIGTERM', sigTermHandler);
  process.on('SIGINT', sigIntHandler);

  // Initialize discovery on module load
  initializeDiscovery();
}

/**
 * Stop all periodic timers started by startTimers().
 * Called during graceful shutdown.
 */
function stopTimers() {
  if (healthCheckInterval) { clearInterval(healthCheckInterval); healthCheckInterval = null; }
  if (activityPollInterval) { clearInterval(activityPollInterval); activityPollInterval = null; }
  if (healthCheckStartupTimeout) { clearTimeout(healthCheckStartupTimeout); healthCheckStartupTimeout = null; }
  // Cancel bootstrap timeouts that haven't fired yet — prevents orphan intervals after shutdown
  if (healthCheckBootstrapTimeout) { clearTimeout(healthCheckBootstrapTimeout); healthCheckBootstrapTimeout = null; }
  if (activityPollBootstrapTimeout) { clearTimeout(activityPollBootstrapTimeout); activityPollBootstrapTimeout = null; }
  // Cancel discovery init timeout if shutdown fires before the 1-second delay elapses
  if (discoveryInitTimeout) { clearTimeout(discoveryInitTimeout); discoveryInitTimeout = null; }
  // Remove signal handlers to prevent duplicates on re-start (bug #4)
  if (sigTermHandler) { process.removeListener('SIGTERM', sigTermHandler); sigTermHandler = null; }
  if (sigIntHandler) { process.removeListener('SIGINT', sigIntHandler); sigIntHandler = null; }
  // Remove discovery signal handlers (RB-021)
  if (discoveryShutdownHandler) {
    process.removeListener('SIGTERM', discoveryShutdownHandler);
    process.removeListener('SIGINT', discoveryShutdownHandler);
    discoveryShutdownHandler = null;
  }
  timersStarted = false;
}

module.exports = {
  init,
  startTimers,
  stopTimers,
  hostActivityCache,
  // Health checks
  runHostHealthChecks,
  probeCodexRecovery,
  // GPU / Model Activity
  normalizeModelName,
  isModelLoadedOnHost,
  getHostActivity,
  pollHostActivity,
  probeLocalGpuMetrics,
  probeRemoteGpuMetrics,
  findNvidiaSmi,
  // Discovery
  initializeDiscovery,
};
