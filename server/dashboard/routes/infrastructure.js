/**
 * Infrastructure route handlers — hosts, providers, agents, system.
 *
 * Merged from: hosts.js, providers.js, agents.js, system.js
 * All handlers follow the signature: (req, res, query, ...captures, context)
 */
const configCore = require('../../db/config-core');
const taskCore = require('../../db/task-core');
const coordination = require('../../db/coordination');
const fileTracking = require('../../db/file/tracking');
const hostManagement = require('../../db/host/management');
const providerRoutingCore = require('../../db/provider/routing-core');
const providerScoring = require('../../db/provider/scoring');
const { sendJson, sendError, parseBody, safeDecodeParam, formatUptime } = require('../utils');

const SECURITY_WARNING_MESSAGE = 'TORQUE is running without authentication. Run configure to set an API key.';

// ── Hosts ──────────────────────────────────────────────────────────────────────

// (from hosts.js) Valid credential types for host credential endpoints
const VALID_CREDENTIAL_TYPES = new Set(['ssh', 'http_auth', 'windows']);

// (from hosts.js) Determine whether a host name belongs to peek or ollama
function resolveHostType(hostName) {
  if (hostManagement.getPeekHost(hostName)) return 'peek';
  if (hostManagement.getOllamaHost(hostName)) return 'ollama';
  return null;
}

/**
 * GET /api/hosts - List all Ollama hosts
 */
function handleListHosts(req, res) {
  const hosts = hostManagement.listOllamaHosts();
  return sendJson(res, hosts);
}

const CREDENTIAL_DENYLIST_FIELDS = [
  'encrypted_value',
  'iv',
  'auth_tag',
  'value',
  'token',
  'password',
  'secret',
  'username',
  'user',
  'key_path',
  'private_key',
];

const CREDENTIAL_PUBLIC_FIELDS = [
  'host_name',
  'host_type',
  'credential_type',
  'label',
];

function redactCredential(credential) {
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    return credential;
  }

  const safe = {};
  for (const field of CREDENTIAL_PUBLIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(credential, field)) {
      safe[field] = credential[field];
    }
  }

  for (const field of CREDENTIAL_DENYLIST_FIELDS) {
    delete safe[field];
  }
  return safe;
}

/**
 * GET /api/peek-hosts - List all registered peek hosts with credential metadata
 */
function handleListPeekHosts(req, res) {
  const hosts = hostManagement.listPeekHosts().map((host) => ({
    ...host,
    credentials: (hostManagement.listCredentials(host.name, 'peek') || []).map(redactCredential),
  }));
  return sendJson(res, hosts);
}

/**
 * POST /api/peek-hosts - Register a new peek host
 */
async function handleCreatePeekHost(req, res) {
  const body = await parseBody(req);
  if (!body.name || !body.url) {
    return sendError(res, 'Peek host name and url are required', 400);
  }

  try {
    new URL(body.url);
  } catch {
    return sendError(res, 'Invalid peek host URL', 400);
  }

  hostManagement.registerPeekHost(body.name, body.url, body.ssh, Boolean(body.default), body.platform);
  return sendJson(res, hostManagement.getPeekHost(body.name), 201);
}

/**
 * PUT /api/peek-hosts/:name - Update an existing peek host
 */
async function handleUpdatePeekHost(req, res, query, hostName) {
  const existing = hostManagement.getPeekHost(hostName);
  if (!existing) return sendError(res, 'Peek host not found', 404);

  const body = await parseBody(req);
  const next = {
    name: existing.name,
    url: existing.url,
    ssh: existing.ssh,
    default: Boolean(existing.is_default),
    platform: existing.platform,
    ...body,
  };

  if (!next.name || !next.url) {
    return sendError(res, 'Peek host name and url are required', 400);
  }

  try {
    new URL(next.url);
  } catch {
    return sendError(res, 'Invalid peek host URL', 400);
  }

  if (next.name !== existing.name && hostManagement.getPeekHost(next.name)) {
    return sendError(res, 'Peek host already exists', 409);
  }

  hostManagement.registerPeekHost(next.name, next.url, next.ssh, Boolean(next.default), next.platform);

  if (next.name !== existing.name) {
    const credentials = hostManagement.listCredentials(existing.name, 'peek');
    for (const credential of credentials) {
      const value = hostManagement.getCredential(existing.name, 'peek', credential.credential_type);
      if (value) {
        hostManagement.saveCredential(
          next.name,
          'peek',
          credential.credential_type,
          credential.label,
          value
        );
      }
    }
    hostManagement.deleteAllHostCredentials(existing.name, 'peek');
    hostManagement.unregisterPeekHost(existing.name);
  }

  return sendJson(res, hostManagement.getPeekHost(next.name));
}

/**
 * DELETE /api/peek-hosts/:name - Remove a peek host and its stored credentials
 */
function handleDeletePeekHost(req, res, query, hostName) {
  const removed = hostManagement.unregisterPeekHost(hostName);
  if (!removed) return sendError(res, 'Peek host not found', 404);

  hostManagement.deleteAllHostCredentials(hostName, 'peek');
  return sendJson(res, { removed: true, name: hostName });
}

/**
 * GET /api/hosts/:name/credentials - List host credential metadata
 */
function handleListCredentials(req, res, query, hostName) {
  const hostType = resolveHostType(hostName);
  if (!hostType) return sendError(res, 'Host not found', 404);

  return sendJson(res, (hostManagement.listCredentials(hostName, hostType) || []).map(redactCredential));
}

/**
 * PUT /api/hosts/:name/credentials/:type - Store an encrypted credential
 */
async function handleSaveCredential(req, res, query, hostName, credType) {
  const hostType = resolveHostType(hostName);
  if (!hostType) return sendError(res, 'Host not found', 404);
  if (!VALID_CREDENTIAL_TYPES.has(credType)) {
    return sendError(res, 'Unsupported credential type', 400);
  }

  const body = await parseBody(req);
  if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) {
    return sendError(res, 'Credential value object is required', 400);
  }

  hostManagement.saveCredential(hostName, hostType, credType, body.label, body.value);
  return sendJson(res, { saved: true });
}

/**
 * DELETE /api/hosts/:name/credentials/:type - Remove a stored credential
 */
function handleDeleteCredential(req, res, query, hostName, credType) {
  const hostType = resolveHostType(hostName);
  if (!hostType) return sendError(res, 'Host not found', 404);
  if (!VALID_CREDENTIAL_TYPES.has(credType)) {
    return sendError(res, 'Unsupported credential type', 400);
  }

  const removed = hostManagement.deleteCredential(hostName, hostType, credType);
  if (!removed) return sendError(res, 'Credential not found', 404);
  return sendJson(res, { removed: true, host: hostName, credential_type: credType });
}

/**
 * POST /api/hosts/:name/credentials/:type/test - Test a stored credential
 */
async function handleTestCredential(req, res, query, hostName, credType) {
  const hostType = resolveHostType(hostName);
  if (!hostType) return sendError(res, 'Host not found', 404);
  if (!VALID_CREDENTIAL_TYPES.has(credType)) {
    return sendError(res, 'Unsupported credential type', 400);
  }

  const credential = hostManagement.getCredential(hostName, hostType, credType);
  if (!credential) return sendError(res, 'Credential not found', 404);

  if (hostType !== 'peek') {
    return sendJson(res, { test: 'not_implemented_for_type' });
  }

  const host = hostManagement.getPeekHost(hostName);
  const http = require('http');
  const https = require('https');
  const healthUrl = new URL('/health', host.url).href;
  const startedAt = Date.now();
  const parsedUrl = new URL(healthUrl);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  const result = await new Promise((resolve) => {
    const request = client.get(healthUrl, { timeout: 5000 }, (response) => {
      response.resume();
      response.on('end', () => {
        resolve({
          credential_type: credType,
          host_reachable: response.statusCode >= 200 && response.statusCode < 300,
          latency_ms: Date.now() - startedAt,
        });
      });
    });

    request.on('error', () => {
      resolve({
        credential_type: credType,
        host_reachable: false,
        latency_ms: null,
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({
        credential_type: credType,
        host_reachable: false,
        latency_ms: null,
      });
    });
  });

  return sendJson(res, result);
}

/**
 * POST /api/peek-hosts/:name/test - Test connection to a peek host (no credentials required)
 */
async function handleTestPeekHost(req, res, query, hostName) {
  const host = hostManagement.getPeekHost(hostName);
  if (!host) return sendError(res, 'Peek host not found', 404);

  const http = require('http');
  const https = require('https');
  const healthUrl = new URL('/health', host.url).href;
  const startedAt = Date.now();
  const parsedUrl = new URL(healthUrl);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  const result = await new Promise((resolve) => {
    const request = client.get(healthUrl, { timeout: 5000 }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        const reachable = response.statusCode >= 200 && response.statusCode < 300;
        let serverInfo = null;
        try { serverInfo = JSON.parse(data); } catch { /* ignore */ }
        resolve({
          reachable,
          latency_ms: Date.now() - startedAt,
          status_code: response.statusCode,
          server_version: serverInfo && serverInfo.version || null,
          hostname: serverInfo && serverInfo.hostname || null,
          platform: serverInfo && serverInfo.platform || null,
        });
      });
    });

    request.on('error', (err) => {
      resolve({
        reachable: false,
        latency_ms: null,
        error: err.message,
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({
        reachable: false,
        latency_ms: null,
        error: 'Connection timed out',
      });
    });
  });

  return sendJson(res, result);
}

/**
 * POST /api/peek-hosts/:name/toggle - Enable/disable a peek host for remote testing
 */
async function handlePeekHostToggle(req, res, query, hostName) {
  const host = hostManagement.getPeekHost(hostName);
  if (!host) return sendError(res, 'Peek host not found', 404);

  const body = await parseBody(req);
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : (host.enabled ? 0 : 1);
  hostManagement.updatePeekHost(hostName, { enabled });
  return sendJson(res, hostManagement.getPeekHost(hostName));
}

/**
 * GET /api/hosts/activity - GPU/model activity for all hosts
 */
async function handleHostActivity(req, res) {
  const taskManager = require('../../task-manager');

  // Probe GPU metrics on-demand (nvidia-smi for local hosts)
  const allHosts = hostManagement.listOllamaHosts({ enabled: true });
  try {
    const reachableHosts = (allHosts || []).filter(h => h.status !== 'down');
    if (reachableHosts.length > 0) {
      await taskManager.probeLocalGpuMetrics(reachableHosts);
      await taskManager.probeRemoteGpuMetrics(reachableHosts);
    }
  } catch { /* best-effort */ }

  const hostActivity = taskManager.getHostActivity();

  // Merge memory_limit_mb from host records so the dashboard can show VRAM bars for remote hosts
  for (const host of (allHosts || [])) {
    if (hostActivity[host.id]) {
      hostActivity[host.id].memoryLimitMb = host.memory_limit_mb || 0;
    }
  }

  // Narrow projection — we only need id, ollama_host_id, model to key the
  // GPU-status map. Skips the multi-MB error_output columns.
  const runningTasks = taskCore.listTasks({
    status: 'running',
    limit: 100,
    columns: taskCore.TASK_HOST_COLUMNS,
  });
  const taskList = runningTasks.tasks || runningTasks;
  const taskGpuStatus = {};
  for (const t of (Array.isArray(taskList) ? taskList : [])) {
    if (t.ollama_host_id) {
      taskGpuStatus[t.id] = taskManager.isModelLoadedOnHost(t.ollama_host_id, t.model);
    }
  }
  return sendJson(res, { hosts: hostActivity, taskGpuStatus });
}

/**
 * POST /api/hosts/scan - Network scan for Ollama hosts
 */
async function handleHostScan(req, res) {
  try {
    const discovery = require('../../discovery');
    const result = await discovery.scanNetworkForOllama({ autoAdd: true });
    // Map to shape the dashboard expects (hosts_found / found)
    return sendJson(res, { ...result, found: result.totalFound || 0 });
  } catch (err) {
    return sendError(res, err.message, 500);
  }
}

/**
 * POST /api/hosts/:id/toggle - Toggle host enabled/disabled
 * When disabling, resets status to 'unknown' to prevent stale 'healthy' badges.
 * When enabling, resets to 'unknown' and triggers an immediate health probe.
 */
async function handleHostToggle(req, res, query, hostId) {
  const body = await parseBody(req);
  const host = hostManagement.getOllamaHost(hostId);
  if (!host) return sendError(res, 'Host not found', 404);
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : (host.enabled ? 0 : 1);
  // Always reset to 'unknown' on toggle — prevents stale status in both directions.
  // When enabling: avoids showing stale 'down' or 'healthy'; probe below will set real status.
  // When disabling: avoids showing stale 'healthy' badge.
  const updates = { enabled, status: 'unknown', consecutive_failures: 0 };
  hostManagement.updateOllamaHost(hostId, updates);

  // When enabling, probe the host immediately so the dashboard shows real status
  if (enabled) {
    try {
      const http = require('http');
      const https = require('https');
      const url = new URL('/api/tags', host.url);
      const client = url.protocol === 'https:' ? https : http;
      const probeResult = await new Promise((resolve) => {
        const req = client.get(url.href, { timeout: 5000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(data);
                const models = (parsed.models || []).map(m => m.name || m.model).filter(Boolean);
                resolve({ healthy: true, models });
              } catch {
                resolve({ healthy: true, models: null });
              }
            } else {
              resolve({ healthy: false, models: null });
            }
          });
        });
        req.on('error', () => resolve({ healthy: false, models: null }));
        req.on('timeout', () => { req.destroy(); resolve({ healthy: false, models: null }); });
      });
      hostManagement.recordHostHealthCheck(hostId, probeResult.healthy, probeResult.models);
    } catch {
      // Probe failed — status stays 'unknown', periodic checks will pick it up
    }
  }

  // Re-fetch after update to return current state
  const updated = hostManagement.getOllamaHost(hostId);
  return sendJson(res, updated);
}

/**
 * GET /api/hosts/:id - Get single host with settings
 */
function handleGetHost(req, res, query, hostId) {
  const host = hostManagement.getOllamaHost(hostId);
  if (!host) return sendError(res, 'Host not found', 404);
  const settings = hostManagement.getHostSettings(hostId);
  return sendJson(res, { ...host, settings });
}

/**
 * PATCH /api/hosts/:id - Update host settings (e.g. default_model, name)
 */
async function handleUpdateHost(req, res, query, hostId) {
  const host = hostManagement.getOllamaHost(hostId);
  if (!host) return sendError(res, 'Host not found', 404);

  const body = await parseBody(req);
  const updates = {};
  if (body.default_model !== undefined) updates.default_model = body.default_model;
  if (body.name !== undefined) updates.name = body.name;

  if (Object.keys(updates).length === 0) {
    return sendError(res, 'No valid fields to update', 400);
  }

  hostManagement.updateOllamaHost(hostId, updates);
  const updated = hostManagement.getOllamaHost(hostId);
  return sendJson(res, { success: true, host: updated });
}

/**
 * DELETE /api/hosts/:id - Remove a host
 */
function handleDeleteHost(req, res, query, hostId) {
  const host = hostManagement.getOllamaHost(hostId);
  if (!host) return sendError(res, 'Host not found', 404);
  if (host.running_tasks > 0) {
    return sendError(res, 'Cannot remove host with running tasks', 400);
  }
  hostManagement.removeOllamaHost(hostId);
  return sendJson(res, { removed: true, id: hostId, name: host.name });
}

// ── Providers ──────────────────────────────────────────────────────────────────

/**
 * (from providers.js) Get time series data for a specific provider.
 * Uses efficient COUNT queries instead of fetching all records.
 */
function getProviderTimeSeries(providerId, days) {
  const series = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = nextDate.toISOString().split('T')[0];

    const baseFilters = {
      provider: providerId,
      from_date: dateStr,
      to_date: nextDateStr,
    };

    const total = taskCore.countTasks(baseFilters);
    const completed = taskCore.countTasks({ ...baseFilters, status: 'completed' });
    const failed = taskCore.countTasks({ ...baseFilters, status: 'failed' });

    series.push({
      date: dateStr,
      total,
      completed,
      failed,
    });
  }

  return series;
}

/**
 * GET /api/providers - List all providers with stats
 */
function handleListProviders(req, res, query) {
  const providers = providerRoutingCore.listProviders();

  // Add current stats to each provider
  const enriched = providers.map(p => ({
    ...p,
    stats: fileTracking.getProviderStats(p.provider, 7),
  }));

  sendJson(res, enriched);
}

/**
 * GET /api/provider-quotas - Current in-memory provider quota state
 */
function handleProviderQuotas(req, res) {
  try {
    const quotas = require('../../db/provider/quotas').getQuotaStore().getAllQuotas();
    sendJson(res, quotas);
  } catch (err) {
    sendError(res, err.message, 500);
  }
}

function normalizeBooleanQuery(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return false;

  const normalized = value.trim().toLowerCase();
  return normalized === '1'
    || normalized === 'true'
    || normalized === 'yes'
    || normalized === 'on';
}

function getProviderScoringMetadata() {
  return {
    weights: typeof providerScoring.getCompositeWeights === 'function'
      ? providerScoring.getCompositeWeights()
      : null,
    min_samples: Number.isFinite(providerScoring.MIN_SAMPLES)
      ? providerScoring.MIN_SAMPLES
      : 5,
  };
}

/**
 * GET /api/provider-scores - Multi-dimensional provider scores for dashboard cards.
 */
function handleProviderScores(_req, res, query = {}) {
  const provider = typeof query.provider === 'string' && query.provider.trim()
    ? query.provider.trim()
    : null;
  const trustedOnly = normalizeBooleanQuery(
    Object.prototype.hasOwnProperty.call(query, 'trusted_only')
      ? query.trusted_only
      : query.trustedOnly,
  );

  try {
    const metadata = getProviderScoringMetadata();

    if (provider) {
      const score = providerScoring.getProviderScore(provider);
      return sendJson(res, {
        ...metadata,
        provider,
        found: Boolean(score),
        score: score || null,
      });
    }

    const scores = providerScoring.getAllProviderScores({ trustedOnly });
    return sendJson(res, {
      ...metadata,
      trusted_only: trustedOnly,
      count: scores.length,
      providers: scores,
    });
  } catch (err) {
    const status = /not been initialized/i.test(err.message) ? 503 : 500;
    return sendError(res, `Provider scoring unavailable: ${err.message}`, status);
  }
}

/**
 * GET /api/providers/:id/stats - Provider statistics
 */
function handleProviderStats(req, res, query, providerId) {
  const days = parseInt(query.days, 10) || 7;
  const stats = fileTracking.getProviderStats(providerId, days);

  // Get time series data
  const timeSeries = getProviderTimeSeries(providerId, days);

  sendJson(res, {
    ...stats,
    timeSeries,
  });
}

/**
 * GET /api/providers/:id/percentiles - Duration percentiles for a provider
 */
function handleProviderPercentiles(req, res, query, providerId) {
  const days = parseInt(query.days, 10) || 7;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  try {
    // Percentiles only need id + timestamps; skip the heavy TEXT blobs.
    const tasks = taskCore.listTasks({
      provider: providerId,
      since,
      limit: 1000,
      columns: taskCore.TASK_TIMING_COLUMNS,
    });
    const taskList = Array.isArray(tasks) ? tasks : (tasks.tasks || []);
    const durations = taskList
      .filter(t => t.completed_at && t.started_at)
      .map(t => (new Date(t.completed_at) - new Date(t.started_at)) / 1000)
      .sort((a, b) => a - b);

    const p = (arr, pct) => arr.length > 0 ? arr[Math.floor(arr.length * pct / 100)] : null;

    sendJson(res, {
      provider: providerId,
      days,
      count: durations.length,
      p50: p(durations, 50),
      p75: p(durations, 75),
      p90: p(durations, 90),
      p95: p(durations, 95),
      p99: p(durations, 99),
      min: durations[0] || null,
      max: durations[durations.length - 1] || null,
    });
  } catch (err) {
    sendError(res, err.message, 500);
  }
}

/**
 * GET /api/providers/trends - All providers' time series in one call.
 * Returns per-provider daily success rate, throughput, and duration.
 */
function handleProviderTrends(req, res, query) {
  const days = parseInt(query.days, 10) || 7;
  const providers = providerRoutingCore.listProviders();

  // Build a date range
  const dates = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  // Collect per-provider time series
  const providerSeries = {};
  for (const p of providers) {
    providerSeries[p.provider] = getProviderTimeSeries(p.provider, days);
  }

  // Merge into unified series: one entry per date, with per-provider metrics
  const series = dates.map((date, idx) => {
    const entry = { date };
    for (const p of providers) {
      const dayData = providerSeries[p.provider]?.[idx] || {};
      const total = (dayData.completed || 0) + (dayData.failed || 0);
      entry[`${p.provider}_total`] = dayData.total || 0;
      entry[`${p.provider}_completed`] = dayData.completed || 0;
      entry[`${p.provider}_failed`] = dayData.failed || 0;
      entry[`${p.provider}_successRate`] = total > 0
        ? Math.round((dayData.completed || 0) / total * 100) : null;
    }
    return entry;
  });

  sendJson(res, {
    providers: providers.map(p => p.provider),
    series,
  });
}

/**
 * POST /api/providers/:id/toggle - Toggle provider enabled/disabled
 */
async function handleProviderToggle(req, res, query, providerId) {
  const body = await parseBody(req);
  const decodedId = safeDecodeParam(providerId, res);
  if (decodedId === null) return;
  const provider = providerRoutingCore.getProvider(decodedId);
  if (!provider) return sendError(res, 'Provider not found', 404);
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : (provider.enabled ? 0 : 1);
  providerRoutingCore.updateProvider(decodedId, { enabled });
  return sendJson(res, { ...provider, enabled: Boolean(enabled) });
}

// ── Agents ─────────────────────────────────────────────────────────────────────

// Get the shared agent registry from the remote-agents plugin singleton
function _getRegistry() {
  const { getInstalledRegistry } = require('../../plugins/remote-agents');
  return getInstalledRegistry();
}

// (from agents.js) Strip secret from agent record and normalize booleans
function _sanitizeAgent(agent) {
  if (!agent) return null;
  const { secret, ...safeAgent } = agent;
  return {
    ...safeAgent,
    tls: _parseBoolean(agent.tls, true),
    rejectUnauthorized: _parseBoolean(agent.rejectUnauthorized, true),
  };
}

// (from agents.js) Fetch all agents from DB
function _getAllAgents() {
  const registry = _getRegistry();
  if (!registry) return [];
  return registry.getAll().map(_sanitizeAgent);
}

// (from agents.js) Fetch single agent by ID
function _getAgentById(agentId) {
  const registry = _getRegistry();
  if (!registry) return null;
  return _sanitizeAgent(registry.get(agentId));
}

// (from agents.js) Parse port with fallback to 3460
function _parsePort(value) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3460;
}

// (from agents.js) Parse boolean from various input types
function _parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }

  return Boolean(value);
}

// (from agents.js) Format timestamp to ISO string with validation
function _formatAgentTimestamp(value) {
  if (!value) return null;
  const ts = new Date(value);
  if (Number.isNaN(ts.getTime())) return null;
  return ts.toISOString();
}

/**
 * GET /api/agents
 */
function handleListAgents(req, res) {
  try {
    const agents = _getAllAgents();
    const normalized = agents.map(agent => ({
      ...agent,
      last_health_check: _formatAgentTimestamp(agent && agent.last_health_check),
      last_healthy: _formatAgentTimestamp(agent && agent.last_healthy),
    }));
    sendJson(res, normalized);
  } catch (err) {
    sendError(res, err.message, 500);
  }
}

/**
 * POST /api/agents
 * Body: { id, name, host, port, secret }
 */
async function handleCreateAgent(req, res) {
  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    return sendError(res, err.message, 400);
  }

  const id = String(payload?.id || '').trim();
  const name = String(payload?.name || '').trim();
  const host = String(payload?.host || '').trim();
  const port = _parsePort(payload?.port);
  const secret = String(payload?.secret || '').trim();
  const hasTls = Object.prototype.hasOwnProperty.call(payload || {}, 'tls');
  const hasRejectUnauthorized = Object.prototype.hasOwnProperty.call(payload || {}, 'rejectUnauthorized');

  if (!id || !name || !host || !secret) {
    return sendError(res, 'Missing required fields: id, name, host, secret', 400);
  }

  const registry = _getRegistry();
  if (!registry) {
    return sendError(res, 'Agent registry not initialized', 500);
  }

  try {
    const existing = (!hasTls || !hasRejectUnauthorized) ? _getAgentById(id) : null;
    registry.register({
      id,
      name,
      host,
      port,
      secret,
      max_concurrent: _parsePort(payload?.max_concurrent || 3),
      tls: hasTls ? _parseBoolean(payload?.tls, true) : _parseBoolean(existing && existing.tls, true),
      rejectUnauthorized: hasRejectUnauthorized
        ? _parseBoolean(payload?.rejectUnauthorized, true)
        : _parseBoolean(existing && existing.rejectUnauthorized, true),
    });
    const created = _getAgentById(id);
    if (!created) return sendError(res, 'Registered agent but failed to read result', 500);
    sendJson(res, created, 201);
  } catch (err) {
    sendError(res, err.message || 'Failed to register agent', 500);
  }
}

/**
 * GET /api/agents/{id}
 */
function handleGetAgent(req, res, query, agentId) {
  const decodedId = safeDecodeParam(agentId, res);
  if (decodedId === null) return;
  if (!decodedId) {
    return sendError(res, 'Agent id is required', 400);
  }

  const agent = _getAgentById(decodedId);
  if (!agent) {
    return sendError(res, `Agent not found: ${decodedId}`, 404);
  }

  sendJson(res, agent);
}

/**
 * GET /api/agents/{id}/health
 */
async function handleAgentHealth(req, res, query, agentId) {
  const decodedId = safeDecodeParam(agentId, res);
  if (decodedId === null) return;
  if (!decodedId) {
    return sendError(res, 'Agent id is required', 400);
  }

  const existing = _getAgentById(decodedId);
  if (!existing) return sendError(res, `Agent not found: ${decodedId}`, 404);

  const registry = _getRegistry();
  if (!registry) {
    return sendError(res, 'Agent registry not initialized', 500);
  }

  try {
    const client = registry.getClient(decodedId);
    if (!client) {
      const disabled = _sanitizeAgent({ ...existing, status: 'disabled' });
      return sendJson(res, disabled);
    }

    await registry.runHealthChecks();
    const refreshed = _getAgentById(decodedId);
    sendJson(res, refreshed || existing);
  } catch (err) {
    sendError(res, err.message || 'Health check failed', 500);
  }
}

/**
 * DELETE /api/agents/{id}
 */
function handleDeleteAgent(req, res, query, agentId) {
  const decodedId = safeDecodeParam(agentId, res);
  if (decodedId === null) return;
  if (!decodedId) {
    return sendError(res, 'Agent id is required', 400);
  }

  const existing = _getAgentById(decodedId);
  if (!existing) {
    return sendError(res, `Agent not found: ${decodedId}`, 404);
  }

  const registry = _getRegistry();
  if (!registry) {
    return sendError(res, 'Agent registry not initialized', 500);
  }

  try {
    registry.remove(decodedId);
    sendJson(res, { removed: true, id: existing.id, name: existing.name });
  } catch (err) {
    sendError(res, err.message || 'Failed to remove agent', 500);
  }
}

// ── System ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/system/status - Server memory and system status.
 * Returns memory usage, uptime, and health indicators.
 */
function handleSystemStatus(req, res, query, context) {
  const { clients, serverPort } = context;
  const memUsage = process.memoryUsage();
  const uptime = process.uptime();

  // Calculate heap usage percentage
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
  const heapPercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);

  // Memory pressure thresholds
  const memoryStatus = heapPercent >= 90 ? 'critical' :
                       heapPercent >= 80 ? 'warning' :
                       heapPercent >= 70 ? 'elevated' : 'healthy';

  // Get active connection count
  const activeConnections = clients.size;

  // Get running task count
  const runningTasks = taskCore.countTasks({ status: 'running' });
  const queuedTasks = taskCore.countTasks({ status: 'queued' });

  // Instance identity
  const taskManager = require('../../task-manager');
  const instanceId = taskManager.getMcpInstanceId();
  let authConfigured = false;
  try {
    authConfigured = Boolean(configCore.getConfig('api_key'));
  } catch {
    authConfigured = false;
  }

  sendJson(res, {
    instance: {
      id: instanceId,
      shortId: instanceId.slice(-6),
      pid: process.pid,
      port: serverPort,
    },
    memory: {
      heapUsedMB,
      heapTotalMB,
      heapPercent,
      rssMB: Math.round(memUsage.rss / 1024 / 1024),
      externalMB: Math.round(memUsage.external / 1024 / 1024),
      status: memoryStatus,
    },
    uptime: {
      seconds: Math.round(uptime),
      formatted: formatUptime(uptime),
    },
    connections: {
      websocket: activeConnections,
    },
    tasks: {
      running: runningTasks,
      queued: queuedTasks,
    },
    security: {
      auth_configured: authConfigured,
      warning: authConfigured ? null : SECURITY_WARNING_MESSAGE,
    },
    security_warning: authConfigured ? null : SECURITY_WARNING_MESSAGE,
    version: require('../../package.json').version || 'unknown',
    nodeVersion: process.version,
    platform: process.platform,
  });
}

/**
 * GET /api/instances - List all active MCP instances for session switching.
 * Returns current instance info and all sibling instances with fresh heartbeats.
 */
function handleInstances(req, res, query, context) {
  const { serverPort } = context;
  const taskManager = require('../../task-manager');
  const currentId = taskManager.getMcpInstanceId();
  const shortId = currentId.slice(-6);
  const instances = coordination.getActiveInstances(30000);

  const enriched = instances.map(inst => ({
    ...inst,
    shortId: inst.instanceId.slice(-6),
    isCurrent: inst.instanceId === currentId,
    uptime: inst.startedAt ? formatUptime((Date.now() - new Date(inst.startedAt).getTime()) / 1000) : null
  }));

  const currentInst = enriched.find(i => i.isCurrent) || {
    instanceId: currentId,
    shortId,
    pid: process.pid,
    port: serverPort,
    startedAt: null,
    isCurrent: true
  };

  sendJson(res, {
    current: {
      instanceId: currentId,
      shortId,
      pid: process.pid,
      port: serverPort,
      startedAt: currentInst.startedAt,
      uptime: currentInst.uptime
    },
    instances: enriched
  });
}

function createDashboardInfraRoutes() {
  return {
    handleListHosts,
    handleListPeekHosts,
    handleCreatePeekHost,
    handleUpdatePeekHost,
    handleDeletePeekHost,
    handleTestPeekHost,
    handlePeekHostToggle,
    handleListCredentials,
    handleSaveCredential,
    handleDeleteCredential,
    handleTestCredential,
    handleHostActivity,
    handleHostScan,
    handleHostToggle,
    handleGetHost,
    handleUpdateHost,
    handleDeleteHost,
    handleListProviders,
    handleProviderQuotas,
    handleProviderScores,
    handleProviderStats,
    handleProviderPercentiles,
    handleProviderTrends,
    handleProviderToggle,
    getProviderTimeSeries,
    handleListAgents,
    handleCreateAgent,
    handleGetAgent,
    handleAgentHealth,
    handleDeleteAgent,
    handleSystemStatus,
    handleInstances,
  };
}

module.exports = {
  // Hosts
  handleListHosts,
  handleListPeekHosts,
  handleCreatePeekHost,
  handleUpdatePeekHost,
  handleDeletePeekHost,
  handleTestPeekHost,
  handlePeekHostToggle,
  handleListCredentials,
  handleSaveCredential,
  handleDeleteCredential,
  handleTestCredential,
  handleHostActivity,
  handleHostScan,
  handleHostToggle,
  handleGetHost,
  handleUpdateHost,
  handleDeleteHost,
  // Providers
  handleListProviders,
  handleProviderQuotas,
  handleProviderScores,
  handleProviderStats,
  handleProviderPercentiles,
  handleProviderTrends,
  handleProviderToggle,
  getProviderTimeSeries,
  // Agents
  handleListAgents,
  handleCreateAgent,
  handleGetAgent,
  handleAgentHealth,
  handleDeleteAgent,
  // System
  handleSystemStatus,
  handleInstances,
  createDashboardInfraRoutes,
};
