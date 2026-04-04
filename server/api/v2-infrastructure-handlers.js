'use strict';

/**
 * V2 Control-Plane Infrastructure Handlers
 *
 * Structured JSON REST handlers for hosts, peek hosts, credentials,
 * and remote agents.
 * These return { data, meta } envelopes via v2-control-plane helpers.
 */
const logger = require('../logger').child({ component: 'v2-infrastructure-handlers' });

const dbModule = require('../database');   // getDbInstance (raw SQL)
const emailPeek = require('../db/email-peek');
const hostManagement = require('../db/host-management');
const coordination = require('../db/coordination');
const taskCore = require('../db/task-core');
const {
  sendSuccess,
  sendError,
  sendList,
  resolveRequestId,
} = require('./v2-control-plane');
const { parseBody } = require('./middleware');

let _taskManager = null;

function init(taskManager) {
  _taskManager = taskManager;
}

const VALID_CREDENTIAL_TYPES = new Set(['ssh', 'http_auth', 'windows']);

function resolveHostType(hostName) {
  if (emailPeek.getPeekHost && emailPeek.getPeekHost(hostName)) return 'peek';
  if (hostManagement.getOllamaHost && hostManagement.getOllamaHost(hostName)) return 'ollama';
  return null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getProviderPercentiles(providerId, days) {
  const fromDate = new Date(Date.now() - days * 86400000).toISOString();
  const rawTasks = taskCore.listTasks ? taskCore.listTasks({ provider: providerId, from_date: fromDate, limit: 1000 }) : [];
  const taskList = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks || []);
  const durations = taskList
    .filter((task) => task?.completed_at && task?.started_at)
    .map((task) => (new Date(task.completed_at) - new Date(task.started_at)) / 1000)
    .filter((duration) => Number.isFinite(duration))
    .sort((left, right) => left - right);

  const percentileAt = (pct) => durations.length > 0
    ? durations[Math.min(durations.length - 1, Math.floor(durations.length * pct / 100))]
    : null;

  return durations.length > 0
    ? {
        p50: percentileAt(50),
        p75: percentileAt(75),
        p90: percentileAt(90),
        p95: percentileAt(95),
        p99: percentileAt(99),
        min: durations[0],
        max: durations[durations.length - 1],
        count: durations.length,
      }
    : {};
}

// ─── Workstations ───────────────────────────────────────────────────────────

async function handleListWorkstations(req, res) {
  const requestId = resolveRequestId(req);

  try {
    const workstationModel = require('../workstation/model');
    const query = req.query || {};
    const filters = {};

    if (query.enabled === 'true') filters.enabled = true;
    if (query.enabled === 'false') filters.enabled = false;
    if (typeof query.status === 'string' && query.status.trim()) filters.status = query.status.trim();
    if (typeof query.capability === 'string' && query.capability.trim()) {
      filters.capability = query.capability.trim();
    }

    const workstations = workstationModel.listWorkstations(filters);
    sendList(res, requestId, workstations, workstations.length, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleCreateWorkstation(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);
  const workstationModel = require('../workstation/model');

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const host = typeof body.host === 'string' ? body.host.trim() : '';
  const secret = typeof body.secret === 'string' ? body.secret.trim() : '';

  if (!name || !host || !secret) {
    return sendError(res, requestId, 'validation_error', 'name, host, and secret are required', 400, {}, req);
  }

  if (workstationModel.getWorkstationByName(name)) {
    return sendError(res, requestId, 'workstation_exists', `Workstation already exists: ${name}`, 409, {}, req);
  }

  try {
    const created = workstationModel.createWorkstation({
      name,
      host,
      agent_port: parsePositiveInt(body.agent_port, 3460),
      secret,
      max_concurrent: parsePositiveInt(body.max_concurrent, 3),
      priority: parsePositiveInt(body.priority, 10),
      is_default: Boolean(body.is_default),
    });

    sendSuccess(res, requestId, created, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleToggleWorkstation(req, res) {
  const requestId = resolveRequestId(req);
  const workstationName = req.params?.workstation_name;
  const body = req.body || await parseBody(req);

  if (!workstationName) {
    return sendError(res, requestId, 'validation_error', 'workstation name is required', 400, {}, req);
  }

  try {
    const workstationModel = require('../workstation/model');
    const workstation = workstationModel.getWorkstationByName(workstationName);

    if (!workstation) {
      return sendError(res, requestId, 'workstation_not_found', `Workstation not found: ${workstationName}`, 404, {}, req);
    }

    const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : (workstation.enabled ? 0 : 1);
    const updated = workstationModel.updateWorkstation(workstation.id, { enabled });
    sendSuccess(res, requestId, updated, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleProbeWorkstation(req, res) {
  const requestId = resolveRequestId(req);
  const workstationName = req.params?.workstation_name;

  if (!workstationName) {
    return sendError(res, requestId, 'validation_error', 'workstation name is required', 400, {}, req);
  }

  try {
    const workstationModel = require('../workstation/model');
    const workstationHandlers = require('../handlers/workstation-handlers');

    if (!workstationModel.getWorkstationByName(workstationName)) {
      return sendError(res, requestId, 'workstation_not_found', `Workstation not found: ${workstationName}`, 404, {}, req);
    }

    const result = await workstationHandlers.handleProbeWorkstation({ name: workstationName });
    if (result?.isError) {
      const message = result.content?.[0]?.text || `Probe failed for workstation: ${workstationName}`;
      return sendError(res, requestId, 'probe_failed', message, 502, {}, req);
    }

    const refreshed = workstationModel.getWorkstationByName(workstationName);
    sendSuccess(res, requestId, refreshed, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDeleteWorkstation(req, res) {
  const requestId = resolveRequestId(req);
  const workstationName = req.params?.workstation_name;

  if (!workstationName) {
    return sendError(res, requestId, 'validation_error', 'workstation name is required', 400, {}, req);
  }

  try {
    const workstationModel = require('../workstation/model');
    const workstation = workstationModel.getWorkstationByName(workstationName);

    if (!workstation) {
      return sendError(res, requestId, 'workstation_not_found', `Workstation not found: ${workstationName}`, 404, {}, req);
    }

    workstationModel.removeWorkstation(workstation.id);
    sendSuccess(res, requestId, { removed: true, id: workstation.id, name: workstation.name }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Ollama Hosts ───────────────────────────────────────────────────────────

async function handleListHosts(req, res) {
  const requestId = resolveRequestId(req);
  const hosts = hostManagement.listOllamaHosts ? hostManagement.listOllamaHosts() : [];
  sendList(res, requestId, hosts, hosts.length, req);
}

async function handleGetHost(req, res) {
  const requestId = resolveRequestId(req);
  const hostId = req.params?.host_id;

  const host = hostManagement.getOllamaHost ? hostManagement.getOllamaHost(hostId) : null;
  if (!host) {
    return sendError(res, requestId, 'host_not_found', `Host not found: ${hostId}`, 404, {}, req);
  }

  const settings = hostManagement.getHostSettings ? hostManagement.getHostSettings(hostId) : {};
  sendSuccess(res, requestId, { ...host, settings }, 200, req);
}

async function handleUpdateHost(req, res) {
  const requestId = resolveRequestId(req);
  const hostId = req.params?.host_id;
  const body = req.body || await parseBody(req);

  const host = hostManagement.getOllamaHost ? hostManagement.getOllamaHost(hostId) : null;
  if (!host) {
    return sendError(res, requestId, 'host_not_found', `Host not found: ${hostId}`, 404, {}, req);
  }

  const updates = {};
  if (body.default_model !== undefined) updates.default_model = body.default_model;
  if (body.name !== undefined) updates.name = body.name;

  if (Object.keys(updates).length === 0) {
    return sendError(res, requestId, 'validation_error', 'No valid fields to update', 400, {}, req);
  }

  try {
    hostManagement.updateOllamaHost(hostId, updates);
    const updated = hostManagement.getOllamaHost(hostId);
    sendSuccess(res, requestId, { success: true, host: updated }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleToggleHost(req, res) {
  const requestId = resolveRequestId(req);
  const hostId = req.params?.host_id;
  const body = req.body || await parseBody(req);

  const host = hostManagement.getOllamaHost ? hostManagement.getOllamaHost(hostId) : null;
  if (!host) {
    return sendError(res, requestId, 'host_not_found', `Host not found: ${hostId}`, 404, {}, req);
  }

  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : (host.enabled ? 0 : 1);
  const updates = { enabled, status: 'unknown', consecutive_failures: 0 };

  try {
    hostManagement.updateOllamaHost(hostId, updates);

    // When enabling, probe immediately
    if (enabled) {
      try {
        const http = require('http');
        const https = require('https');
        const url = new URL('/api/tags', host.url);
        const client = url.protocol === 'https:' ? https : http;
        const probeResult = await new Promise((resolve) => {
          const request = client.get(url.href, { timeout: 5000 }, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
              if (response.statusCode === 200) {
                try {
                  const parsed = JSON.parse(data);
                  const models = (parsed.models || []).map(m => m.name || m.model).filter(Boolean);
                  resolve({ healthy: true, models });
                } catch (err) { logger.debug("task handler error", { err: err.message }); resolve({ healthy: true, models: null }); }
              } else { resolve({ healthy: false, models: null }); }
            });
          });
          request.on('error', () => resolve({ healthy: false, models: null }));
          request.on('timeout', () => { request.destroy(); resolve({ healthy: false, models: null }); });
        });
        if (hostManagement.recordHostHealthCheck) {
          hostManagement.recordHostHealthCheck(hostId, probeResult.healthy, probeResult.models);
        }
      } catch (err) { logger.debug("task handler error", { err: err.message }); /* probe failed — status stays unknown */ }
    }

    const updated = hostManagement.getOllamaHost(hostId);
    sendSuccess(res, requestId, updated, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDeleteHost(req, res) {
  const requestId = resolveRequestId(req);
  const hostId = req.params?.host_id;

  const host = hostManagement.getOllamaHost ? hostManagement.getOllamaHost(hostId) : null;
  if (!host) {
    return sendError(res, requestId, 'host_not_found', `Host not found: ${hostId}`, 404, {}, req);
  }

  if (host.running_tasks > 0) {
    return sendError(res, requestId, 'host_busy', 'Cannot remove host with running tasks', 400, {}, req);
  }

  try {
    hostManagement.removeOllamaHost(hostId);
    sendSuccess(res, requestId, { removed: true, id: hostId, name: host.name }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleHostScan(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const discovery = require('../discovery');
    const result = await discovery.scanNetworkForOllama({ autoAdd: true });
    sendSuccess(res, requestId, { ...result, found: result.totalFound || 0 }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Peek Hosts ─────────────────────────────────────────────────────────────

async function handleListPeekHosts(req, res) {
  const requestId = resolveRequestId(req);
  const hosts = (emailPeek.listPeekHosts ? emailPeek.listPeekHosts() : []).map(host => ({
    ...host,
    credentials: (hostManagement.listCredentials ? hostManagement.listCredentials(host.name, 'peek') : []).map(({ encrypted_value, iv, auth_tag, ...safe }) => safe),
  }));
  sendList(res, requestId, hosts, hosts.length, req);
}

async function handleCreatePeekHost(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  if (!body.name || !body.url) {
    return sendError(res, requestId, 'validation_error', 'name and url are required', 400, {}, req);
  }

  try { new URL(body.url); } catch (err) {
    logger.debug("task handler error", { err: err.message });
    return sendError(res, requestId, 'validation_error', 'Invalid peek host URL', 400, {}, req);
  }

  try {
    emailPeek.registerPeekHost(body.name, body.url, body.ssh, Boolean(body.default), body.platform);
    const created = emailPeek.getPeekHost(body.name);
    sendSuccess(res, requestId, created, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDeletePeekHost(req, res) {
  const requestId = resolveRequestId(req);
  const hostName = req.params?.host_name;

  const removed = emailPeek.unregisterPeekHost ? emailPeek.unregisterPeekHost(hostName) : false;
  if (!removed) {
    return sendError(res, requestId, 'host_not_found', `Peek host not found: ${hostName}`, 404, {}, req);
  }

  if (hostManagement.deleteAllHostCredentials) {
    hostManagement.deleteAllHostCredentials(hostName, 'peek');
  }

  sendSuccess(res, requestId, { removed: true, name: hostName }, 200, req);
}

async function handleTogglePeekHost(req, res) {
  const requestId = resolveRequestId(req);
  const hostName = req.params?.host_name;
  const body = req.body || await parseBody(req);

  const host = emailPeek.getPeekHost ? emailPeek.getPeekHost(hostName) : null;
  if (!host) {
    return sendError(res, requestId, 'host_not_found', `Peek host not found: ${hostName}`, 404, {}, req);
  }

  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : (host.enabled ? 0 : 1);
  if (emailPeek.updatePeekHost) emailPeek.updatePeekHost(hostName, { enabled });

  const updated = emailPeek.getPeekHost(hostName);
  sendSuccess(res, requestId, updated, 200, req);
}

// ─── Host Credentials ───────────────────────────────────────────────────────

async function handleListCredentials(req, res) {
  const requestId = resolveRequestId(req);
  const hostName = req.params?.host_name;

  const hostType = resolveHostType(hostName);
  if (!hostType) {
    return sendError(res, requestId, 'host_not_found', `Host not found: ${hostName}`, 404, {}, req);
  }

  const creds = hostManagement.listCredentials ? hostManagement.listCredentials(hostName, hostType) : [];
  const redacted = creds.map(({ encrypted_value, iv, auth_tag, ...safe }) => safe);
  sendList(res, requestId, redacted, redacted.length, req);
}

async function handleSaveCredential(req, res) {
  const requestId = resolveRequestId(req);
  const hostName = req.params?.host_name;
  const credType = req.params?.credential_type;
  const body = req.body || await parseBody(req);

  const hostType = resolveHostType(hostName);
  if (!hostType) {
    return sendError(res, requestId, 'host_not_found', `Host not found: ${hostName}`, 404, {}, req);
  }

  if (!VALID_CREDENTIAL_TYPES.has(credType)) {
    return sendError(res, requestId, 'validation_error', 'Unsupported credential type', 400, {}, req);
  }

  if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) {
    return sendError(res, requestId, 'validation_error', 'Credential value object is required', 400, {}, req);
  }

  try {
    hostManagement.saveCredential(hostName, hostType, credType, body.label, body.value);
    sendSuccess(res, requestId, { saved: true }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDeleteCredential(req, res) {
  const requestId = resolveRequestId(req);
  const hostName = req.params?.host_name;
  const credType = req.params?.credential_type;

  const hostType = resolveHostType(hostName);
  if (!hostType) {
    return sendError(res, requestId, 'host_not_found', `Host not found: ${hostName}`, 404, {}, req);
  }

  if (!VALID_CREDENTIAL_TYPES.has(credType)) {
    return sendError(res, requestId, 'validation_error', 'Unsupported credential type', 400, {}, req);
  }

  const removed = hostManagement.deleteCredential
    ? hostManagement.deleteCredential(hostName, hostType, credType) : false;
  if (!removed) {
    return sendError(res, requestId, 'credential_not_found', 'Credential not found', 404, {}, req);
  }

  sendSuccess(res, requestId, { removed: true, host: hostName, credential_type: credType }, 200, req);
}

// ─── Remote Agents ──────────────────────────────────────────────────────────

let _cachedRegistry = null;
function _resetRegistryCache() { _cachedRegistry = null; }
function _getRegistry() {
  if (_cachedRegistry) return _cachedRegistry;
  if (!dbModule || typeof dbModule.getDbInstance !== 'function') return null;
  const rawDb = dbModule.getDbInstance();
  if (!rawDb || typeof rawDb.prepare !== 'function') return null;

  const { RemoteAgentRegistry } = require('../plugins/remote-agents/agent-registry');
  _cachedRegistry = new RemoteAgentRegistry(rawDb);
  return _cachedRegistry;
}

function _sanitizeAgent(agent) {
  if (!agent) return null;
  const { secret: _secret, ...safe } = agent;
  return {
    ...safe,
    tls: Boolean(agent.tls),
    rejectUnauthorized: agent.rejectUnauthorized === undefined ? true : Boolean(agent.rejectUnauthorized),
  };
}

function _listAgents() {
  const registry = _getRegistry();
  if (!registry) return [];
  return registry.getAll().map(_sanitizeAgent);
}

function _getAgent(agentId) {
  const registry = _getRegistry();
  if (!registry) return null;
  return _sanitizeAgent(registry.get(agentId));
}

async function _healthCheckAgent(agentId) {
  const registry = _getRegistry();
  if (!registry) return null;

  await registry.runHealthChecks();
  return _sanitizeAgent(registry.get(agentId));
}

async function handleListAgents(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const agents = _listAgents();
    sendList(res, requestId, agents, agents.length, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleCreateAgent(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  const id = (body.id || '').trim();
  const name = (body.name || '').trim();
  const host = (body.host || '').trim();
  const secret = (body.secret || '').trim();

  if (!id || !name || !host || !secret) {
    return sendError(res, requestId, 'validation_error', 'id, name, host, and secret are required', 400, {}, req);
  }

  const registry = _getRegistry();
  if (!registry) {
    return sendError(res, requestId, 'not_initialized', 'Agent registry not initialized', 500, {}, req);
  }

  try {
    const port = parseInt(body.port, 10) || 3460;
    registry.register({
      id, name, host, port, secret,
      max_concurrent: parseInt(body.max_concurrent, 10) || 3,
      tls: Boolean(body.tls),
      rejectUnauthorized: body.rejectUnauthorized !== false,
    });

    const created = _getAgent(id);
    if (!created) {
      return sendError(res, requestId, 'operation_failed', 'Registered but failed to read result', 500, {}, req);
    }
    sendSuccess(res, requestId, created, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleGetAgent(req, res) {
  const requestId = resolveRequestId(req);
  const agentId = req.params?.agent_id;

  const agent = _getAgent(agentId);
  if (!agent) {
    return sendError(res, requestId, 'agent_not_found', `Agent not found: ${agentId}`, 404, {}, req);
  }
  sendSuccess(res, requestId, agent, 200, req);
}

async function handleAgentHealth(req, res) {
  const requestId = resolveRequestId(req);
  const agentId = req.params?.agent_id;

  const existing = _getAgent(agentId);
  if (!existing) {
    return sendError(res, requestId, 'agent_not_found', `Agent not found: ${agentId}`, 404, {}, req);
  }

  const registry = _getRegistry();
  if (!registry) {
    return sendError(res, requestId, 'not_initialized', 'Agent registry not initialized', 500, {}, req);
  }

  try {
    const client = registry.getClient(agentId);
    if (!client) {
      return sendSuccess(res, requestId, { ...existing, status: 'disabled' }, 200, req);
    }

    const refreshed = await _healthCheckAgent(agentId);
    sendSuccess(res, requestId, refreshed || existing, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDeleteAgent(req, res) {
  const requestId = resolveRequestId(req);
  const agentId = req.params?.agent_id;

  const existing = _getAgent(agentId);
  if (!existing) {
    return sendError(res, requestId, 'agent_not_found', `Agent not found: ${agentId}`, 404, {}, req);
  }

  const registry = _getRegistry();
  if (!registry) {
    return sendError(res, requestId, 'not_initialized', 'Agent registry not initialized', 500, {}, req);
  }

  try {
    registry.remove(agentId);
    sendSuccess(res, requestId, { removed: true, id: existing.id, name: existing.name }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Host Management (new v2 routes) ────────────────────────────────────────

async function handleAddHost(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  if (!body.name || !body.url) {
    return sendError(res, requestId, 'validation_error', 'name and url are required', 400, {}, req);
  }

  try {
    const hostHandlers = require('../handlers/provider-ollama-hosts');
    const result = hostHandlers.handleAddOllamaHost(body);

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Failed to add host';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    sendSuccess(res, requestId, { name: body.name, url: body.url, added: true }, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleRefreshModels(req, res) {
  const requestId = resolveRequestId(req);
  const hostId = req.params?.host_id;

  if (!hostId) {
    return sendError(res, requestId, 'validation_error', 'host_id is required', 400, {}, req);
  }

  try {
    const hostHandlers = require('../handlers/provider-ollama-hosts');
    const result = hostHandlers.handleRefreshHostModels({ host_id: hostId });

    if (result?.isError) {
      const msg = result.content?.[0]?.text || 'Failed to refresh models';
      return sendError(res, requestId, 'operation_failed', msg, 400, {}, req);
    }

    const text = result?.content?.[0]?.text || '';
    sendSuccess(res, requestId, { host_id: hostId, refreshed: true, result: text }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Host Activity ───────────────────────────────────────────────────────

async function handleHostActivity(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const hostMonitoring = require('../utils/host-monitoring');
    const activity = typeof hostMonitoring.getHostActivity === 'function'
      ? hostMonitoring.getHostActivity() : {};
    sendSuccess(res, requestId, activity, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Provider Percentiles ────────────────────────────────────────────────

async function handleProviderPercentiles(req, res) {
  const requestId = resolveRequestId(req);
  const providerId = req.params?.provider_id;
  const query = req.query || {};
  const days = Math.max(1, Math.min(90, parseInt(query.days, 10) || 7));

  if (!providerId) {
    return sendError(res, requestId, 'validation_error', 'provider_id is required', 400, {}, req);
  }

  try {
    const percentiles = getProviderPercentiles(providerId, days);
    sendSuccess(res, requestId, { provider: providerId, days, percentiles }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Coordination Dashboard ──────────────────────────────────────────────

async function handleCoordinationDashboard(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const hours = Math.max(1, Math.min(168, parseInt(query.hours, 10) || 24));

  try {
    const coordData = typeof coordination.getCoordinationDashboard === 'function'
      ? coordination.getCoordinationDashboard(hours) : { agents: [], rules: [], claims: [] };
    sendSuccess(res, requestId, coordData, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

function createV2InfrastructureHandlers(_deps) {
  return {
    init,
    handleListWorkstations,
    handleCreateWorkstation,
    handleToggleWorkstation,
    handleProbeWorkstation,
    handleDeleteWorkstation,
    handleListHosts,
    handleGetHost,
    handleUpdateHost,
    handleToggleHost,
    handleDeleteHost,
    handleHostScan,
    handleListPeekHosts,
    handleCreatePeekHost,
    handleDeletePeekHost,
    handleTogglePeekHost,
    handleListCredentials,
    handleSaveCredential,
    handleDeleteCredential,
    handleListAgents,
    handleCreateAgent,
    handleGetAgent,
    handleAgentHealth,
    handleDeleteAgent,
    handleAddHost,
    handleRefreshModels,
    handleHostActivity,
    handleProviderPercentiles,
    handleCoordinationDashboard,
  };
}

module.exports = {
  init,
  _resetRegistryCache,
  // Workstations
  handleListWorkstations,
  handleCreateWorkstation,
  handleToggleWorkstation,
  handleProbeWorkstation,
  handleDeleteWorkstation,
  // Ollama Hosts
  handleListHosts,
  handleGetHost,
  handleUpdateHost,
  handleToggleHost,
  handleDeleteHost,
  handleHostScan,
  // Peek Hosts
  handleListPeekHosts,
  handleCreatePeekHost,
  handleDeletePeekHost,
  handleTogglePeekHost,
  // Credentials
  handleListCredentials,
  handleSaveCredential,
  handleDeleteCredential,
  // Remote Agents
  handleListAgents,
  handleCreateAgent,
  handleGetAgent,
  handleAgentHealth,
  handleDeleteAgent,
  // Host Management (new)
  handleAddHost,
  handleRefreshModels,
  // Host Activity & Coordination
  handleHostActivity,
  handleProviderPercentiles,
  handleCoordinationDashboard,
  createV2InfrastructureHandlers,
};
