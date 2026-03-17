'use strict';

const http = require('node:http');
const https = require('node:https');
const model = require('../workstation/model');
const probeModule = require('../workstation/probe');

function buildFetchError(message) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
  };
}

function normalizeTrimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function ensureWorkstationName(value) {
  const name = normalizeTrimmed(value);
  if (!name) {
    return { error: buildFetchError('name is required and must be a non-empty string') };
  }

  return { value: name };
}

function ensureEnabledFilter(value) {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') {
    return { error: buildFetchError('enabled filter must be a boolean when provided') };
  }
  return { value };
}

function ensureStatusFilter(value) {
  if (value === undefined) return {};
  if (typeof value !== 'string') {
    return { error: buildFetchError('status filter must be a string when provided') };
  }

  const status = value.trim();
  if (!status) {
    return { error: buildFetchError('status filter must not be empty when provided') };
  }

  return { value: status };
}

function ensureCapabilityFilter(value) {
  if (value === undefined) return {};
  if (typeof value !== 'string') {
    return { error: buildFetchError('capability filter must be a string when provided') };
  }
  const capability = value.trim();
  if (!capability) {
    return { error: buildFetchError('capability filter must not be empty when provided') };
  }
  return { value: capability };
}

function resolveWorkstationByIdOrName(args = {}) {
  const id = normalizeTrimmed(args.id);
  if (id) {
    const workstation = model.getWorkstation(id);
    if (workstation) {
      return workstation;
    }
    return null;
  }

  const nameCheck = ensureWorkstationName(args.name);
  if (nameCheck.error) {
    return nameCheck.error;
  }

  return model.getWorkstationByName(nameCheck.value);
}

function parsePort(rawPort, defaultPort) {
  const candidate = Number(rawPort);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return defaultPort;
  }
  return Math.trunc(candidate);
}

function buildHostBase(workstation) {
  const host = normalizeTrimmed(workstation.host);
  if (!host) {
    return null;
  }

  if (/^https?:\/\//i.test(host)) {
    return host.replace(/\/+$/, '');
  }

  return `http://${host}`;
}

function workstationUrl(workstation, path, defaultPort) {
  const hostBase = buildHostBase(workstation);
  if (!hostBase) {
    throw new Error('workstation host is required');
  }

  const url = new URL(path.startsWith('/') ? path : `/${path}`, hostBase);
  const port = parsePort(workstation.agent_port, defaultPort);

  if (!url.port && port) {
    url.port = String(port);
  }

  return url.href;
}

function normalizeHealthResponse(payload) {
  let healthy = true;
  const models = [];

  if (payload && typeof payload === 'object') {
    if (Object.prototype.hasOwnProperty.call(payload, 'healthy')) {
      healthy = !!payload.healthy;
    } else if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
      healthy = normalizeTrimmed(payload.status).toLowerCase() === 'healthy' || normalizeTrimmed(payload.status).toLowerCase() === 'ok';
    } else if (Object.prototype.hasOwnProperty.call(payload, 'ok')) {
      healthy = !!payload.ok;
    } else if (Object.prototype.hasOwnProperty.call(payload, 'up')) {
      healthy = !!payload.up;
    } else {
      healthy = true;
    }

    if (Array.isArray(payload.models)) {
      models.push(...payload.models);
    }
  } else if (typeof payload === 'boolean') {
    healthy = payload;
  }

  return { healthy, models };
}

function listWorkstations(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return buildFetchError('listWorkstations expects an argument object');
  }

  const statusFilter = ensureStatusFilter(args.status);
  if (statusFilter.error) return statusFilter.error;

  const capabilityFilter = ensureCapabilityFilter(args.capability);
  if (capabilityFilter.error) return capabilityFilter.error;

  const enabledFilter = ensureEnabledFilter(args.enabled);
  if (enabledFilter.error) return enabledFilter.error;

  const filters = {};
  if (statusFilter.value !== undefined) filters.status = statusFilter.value;
  if (capabilityFilter.value !== undefined) filters.capability = capabilityFilter.value;
  if (enabledFilter.value !== undefined) filters.enabled = enabledFilter.value;

  const workstations = model.listWorkstations(filters);
  const count = workstations.length;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ workstations, count }, null, 2),
      },
    ],
  };
}

function addWorkstation(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return buildFetchError('addWorkstation expects an argument object');
  }

  const name = normalizeTrimmed(args.name);
  const host = normalizeTrimmed(args.host);
  const secret = normalizeTrimmed(args.secret);

  if (!name) return buildFetchError('name is required');
  if (!host) return buildFetchError('host is required');
  if (!secret) return buildFetchError('secret is required');

  const existing = model.getWorkstationByName(name);
  if (existing) {
    return buildFetchError(`workstation with name "${name}" already exists`);
  }

  const workstation = model.createWorkstation({
    name,
    host,
    agent_port: parsePort(args.agent_port, 3460),
    secret,
    max_concurrent: parsePort(args.max_concurrent, 3),
    priority: parsePort(args.priority, 10),
    is_default: !!args.is_default,
  });

  return {
    content: [
      {
        type: 'text',
        text: `Created workstation "${workstation.name}" with id ${workstation.id}.`,
      },
    ],
  };
}

function removeWorkstation(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return buildFetchError('removeWorkstation expects an argument object');
  }

  const workstation = resolveWorkstationByIdOrName(args);
  if (!workstation) {
    return {
      content: [{ type: 'text', text: 'not found' }],
    };
  }

  if (workstation.isError) {
    return workstation;
  }

  const removed = model.removeWorkstation(workstation.id);
  if (!removed) {
    return {
      content: [{ type: 'text', text: 'not found' }],
    };
  }

  return {
    content: [{ type: 'text', text: 'removed' }],
  };
}

async function probeWorkstation(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return buildFetchError('probeWorkstation expects an argument object');
  }

  const nameValidation = ensureWorkstationName(args.name);
  if (nameValidation.error) {
    return nameValidation.error;
  }

  const workstation = model.getWorkstationByName(nameValidation.value);
  if (!workstation) {
    return {
      content: [{ type: 'text', text: `workstation "${nameValidation.value}" not found` }],
    };
  }

  try {
      const probeUrl = workstationUrl(workstation, '/probe', 3460);
    const probeResponse = await fetchJson(probeUrl, 10000);
    const parsed = probeModule.parseProbeResponse(probeResponse);
    const updates = probeModule.probeToWorkstationUpdates(parsed);
    model.updateWorkstation(workstation.id, updates);
    const refreshed = model.recordHealthCheck(workstation.id, true, parsed.models || []);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            name: refreshed.name,
            host: refreshed.host,
            status: refreshed.status || 'unknown',
            capabilities: refreshed._capabilities || {},
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    model.recordHealthCheck(workstation.id, false);
    return buildFetchError(`probe failed for "${nameValidation.value}": ${error.message}`);
  }
}

async function checkWorkstationHealth(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return buildFetchError('checkWorkstationHealth expects an argument object');
  }

  const targetName = normalizeTrimmed(args.name);
  const targets = [];
  const outcomes = [];

  if (targetName) {
    const workstation = model.getWorkstationByName(targetName);
    if (!workstation) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ checked: 0, workstations: [] }, null, 2) }],
      };
    }
    targets.push(workstation);
  } else {
    const enabled = model.listWorkstations({ enabled: true });
    for (const item of enabled) {
      targets.push(item);
    }
  }

  for (const workstation of targets) {
    try {
      const healthUrl = workstationUrl(workstation, '/health', 3460);
      const healthResponse = await fetchJson(healthUrl, 5000);
      const parsed = normalizeHealthResponse(healthResponse);
      const updated = model.recordHealthCheck(workstation.id, parsed.healthy, parsed.models);
      outcomes.push({
        name: workstation.name,
        id: workstation.id,
        status: updated.status,
        healthy: parsed.healthy,
      });
    } catch (error) {
      model.recordHealthCheck(workstation.id, false);
      outcomes.push({
        name: workstation.name,
        id: workstation.id,
        status: 'down',
        healthy: false,
        error: error.message,
      });
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          checked: outcomes.length,
          workstations: outcomes,
        }, null, 2),
      },
    ],
  };
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

module.exports = {
  handleListWorkstations: listWorkstations,
  handleAddWorkstation: addWorkstation,
  handleRemoveWorkstation: removeWorkstation,
  handleProbeWorkstation: probeWorkstation,
  handleCheckWorkstationHealth: checkWorkstationHealth,
};
