'use strict';

/**
 * V2 Control-Plane Infrastructure Handlers
 *
 * Structured JSON REST handlers for hosts, peek hosts, credentials,
 * and remote agents.
 * These return { data, meta } envelopes via v2-control-plane helpers.
 */

const db = require('../database');
const hostCredentials = require('../db/host-management');
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
  if (db.getPeekHost && db.getPeekHost(hostName)) return 'peek';
  if (db.getOllamaHost && db.getOllamaHost(hostName)) return 'ollama';
  return null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  const hosts = db.listOllamaHosts ? db.listOllamaHosts() : [];
  sendList(res, requestId, hosts, hosts.length, req);
}

async function handleGetHost(req, res) {
  const requestId = resolveRequestId(req);
  const hostId = req.params?.host_id;

  const host = db.getOllamaHost ? db.getOllamaHost(hostId) : null;
  if (!host) {
    return sendError(res, requestId, 'host_not_found', `Host not found: ${hostId}`, 404, {}, req);
  }

  const settings = db.getHostSettings ? db.getHostSettings(hostId) : {};
  sendSuccess(res, requestId, { ...host, settings }, 200, req);
}

async function handleToggleHost(req, res) {
  const requestId = resolveRequestId(req);
  const hostId = req.params?.host_id;
  const body = req.body || await parseBody(req);

  const host = db.getOllamaHost ? db.getOllamaHost(hostId) : null;
  if (!host) {
    return sendError(res, requestId, 'host_not_found', `Host not found: ${hostId}`, 404, {}, req);
  }

  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : (host.enabled ? 0 : 1);
  const updates = { enabled, status: 'unknown', consecutive_failures: 0 };

  try {
    db.updateOllamaHost(hostId, updates);

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
                } catch { resolve({ healthy: true, models: null }); }
              } else { resolve({ healthy: false, models: null }); }
            });
          });
          request.on('error', () => resolve({ healthy: false, models: null }));
          request.on('timeout', () => { request.destroy(); resolve({ healthy: false, models: null }); });
        });
        if (db.recordHostHealthCheck) {
          db.recordHostHealthCheck(hostId, probeResult.healthy, probeResult.models);
        }
      } catch { /* probe failed — status stays unknown */ }
    }

    const updated = db.getOllamaHost(hostId);
    sendSuccess(res, requestId, updated, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDeleteHost(req, res) {
  const requestId = resolveRequestId(req);
  const hostId = req.params?.host_id;

  const host = db.getOllamaHost ? db.getOllamaHost(hostId) : null;
  if (!host) {
    return sendError(res, requestId, 'host_not_found', `Host not found: ${hostId}`, 404, {}, req);
  }

  if (host.running_tasks > 0) {
    return sendError(res, requestId, 'host_busy', 'Cannot remove host with running tasks', 400, {}, req);
  }

  try {
    db.removeOllamaHost(hostId);
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
  const hosts = (db.listPeekHosts ? db.listPeekHosts() : []).map(host => ({
    ...host,
    credentials: hostCredentials.listCredentials ? hostCredentials.listCredentials(host.name, 'peek') : [],
  }));
  sendList(res, requestId, hosts, hosts.length, req);
}

async function handleCreatePeekHost(req, res) {
  const requestId = resolveRequestId(req);
  const body = req.body || await parseBody(req);

  if (!body.name || !body.url) {
    return sendError(res, requestId, 'validation_error', 'name and url are required', 400);
  }

  try { new URL(body.url); } catch {
    return sendError(res, requestId, 'validation_error', 'Invalid peek host URL', 400);
  }

  try {
    db.registerPeekHost(body.name, body.url, body.ssh, Boolean(body.default), body.platform);
    const created = db.getPeekHost(body.name);
    sendSuccess(res, requestId, created, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDeletePeekHost(req, res) {
  const requestId = resolveRequestId(req);
  const hostName = req.params?.host_name;

  const removed = db.unregisterPeekHost ? db.unregisterPeekHost(hostName) : false;
  if (!removed) {
    return sendError(res, requestId, 'host_not_found', `Peek host not found: ${hostName}`, 404, {}, req);
  }

  if (hostCredentials.deleteAllHostCredentials) {
    hostCredentials.deleteAllHostCredentials(hostName, 'peek');
  }

  sendSuccess(res, requestId, { removed: true, name: hostName }, 200, req);
}

async function handleTogglePeekHost(req, res) {
  const requestId = resolveRequestId(req);
  const hostName = req.params?.host_name;
  const body = req.body || await parseBody(req);

  const host = db.getPeekHost ? db.getPeekHost(hostName) : null;
  if (!host) {
    return sendError(res, requestId, 'host_not_found', `Peek host not found: ${hostName}`, 404, {}, req);
  }

  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : (host.enabled ? 0 : 1);
  if (db.updatePeekHost) db.updatePeekHost(hostName, { enabled });

  const updated = db.getPeekHost(hostName);
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

  const creds = hostCredentials.listCredentials ? hostCredentials.listCredentials(hostName, hostType) : [];
  sendList(res, requestId, creds, creds.length, req);
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
    return sendError(res, requestId, 'validation_error', 'Unsupported credential type', 400);
  }

  if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) {
    return sendError(res, requestId, 'validation_error', 'Credential value object is required', 400);
  }

  try {
    hostCredentials.saveCredential(hostName, hostType, credType, body.label, body.value);
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
    return sendError(res, requestId, 'validation_error', 'Unsupported credential type', 400);
  }

  const removed = hostCredentials.deleteCredential
    ? hostCredentials.deleteCredential(hostName, hostType, credType) : false;
  if (!removed) {
    return sendError(res, requestId, 'credential_not_found', 'Credential not found', 404, {}, req);
  }

  sendSuccess(res, requestId, { removed: true, host: hostName, credential_type: credType }, 200, req);
}

// ─── Remote Agents ──────────────────────────────────────────────────────────

function _getRegistry() {
  try {
    const { getAgentRegistry } = require('../index');
    return getAgentRegistry ? getAgentRegistry() : null;
  } catch { return null; }
}

function _getAgentDb() {
  if (!db || typeof db.getDbInstance !== 'function') return null;
  const inst = db.getDbInstance();
  return inst && inst.prepare ? inst : null;
}

function _sanitizeAgent(agent) {
  if (!agent) return null;
  const { secret: _secret, ...safe } = agent;
  return safe;
}

function _getAllAgents() {
  const inst = _getAgentDb();
  if (!inst) return [];
  return inst.prepare('SELECT * FROM remote_agents ORDER BY created_at DESC').all().map(_sanitizeAgent);
}

function _getAgentById(agentId) {
  const inst = _getAgentDb();
  if (!inst) return null;
  return _sanitizeAgent(inst.prepare('SELECT * FROM remote_agents WHERE id = ?').get(agentId));
}

async function handleListAgents(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const agents = _getAllAgents();
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
    return sendError(res, requestId, 'validation_error', 'id, name, host, and secret are required', 400);
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

    const created = _getAgentById(id);
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

  const agent = _getAgentById(agentId);
  if (!agent) {
    return sendError(res, requestId, 'agent_not_found', `Agent not found: ${agentId}`, 404, {}, req);
  }
  sendSuccess(res, requestId, agent, 200, req);
}

async function handleAgentHealth(req, res) {
  const requestId = resolveRequestId(req);
  const agentId = req.params?.agent_id;

  const existing = _getAgentById(agentId);
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

    let result = null;
    try { result = await client.checkHealth(); } catch { result = null; }

    const now = new Date().toISOString();
    const status = result ? 'healthy' : 'down';
    const failures = result ? 0 : ((existing.consecutive_failures || 0) + 1);
    const metrics = result && result.system ? JSON.stringify(result.system) : existing.metrics || null;

    const inst = _getAgentDb();
    if (inst) {
      if (result) {
        inst.prepare('UPDATE remote_agents SET status = ?, consecutive_failures = ?, last_health_check = ?, last_healthy = ?, metrics = ? WHERE id = ?')
          .run(status, failures, now, now, metrics, agentId);
      } else {
        inst.prepare('UPDATE remote_agents SET status = ?, consecutive_failures = ?, last_health_check = ?, metrics = ? WHERE id = ?')
          .run(status, failures, now, metrics, agentId);
      }
    }

    const refreshed = _getAgentById(agentId);
    sendSuccess(res, requestId, refreshed || existing, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleDeleteAgent(req, res) {
  const requestId = resolveRequestId(req);
  const agentId = req.params?.agent_id;

  const existing = _getAgentById(agentId);
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
    const percentiles = typeof db.getProviderPercentiles === 'function'
      ? db.getProviderPercentiles(providerId, days) : {};
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
    const coordination = typeof db.getCoordinationDashboard === 'function'
      ? db.getCoordinationDashboard(hours) : { agents: [], rules: [], claims: [] };
    sendSuccess(res, requestId, coordination, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

module.exports = {
  init,
  // Workstations
  handleListWorkstations,
  handleCreateWorkstation,
  handleProbeWorkstation,
  handleDeleteWorkstation,
  // Ollama Hosts
  handleListHosts,
  handleGetHost,
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
};
