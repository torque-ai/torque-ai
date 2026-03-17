   // Workstation Adapters — backward-compatible wrappers for legacy host APIs

'use strict';

const { randomUUID } = require('crypto');
const model = require('./model');

function setDb(dbInstance) {
  model.setDb(dbInstance);
}

function parseUrl(rawUrl, fallbackPort) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('Invalid host URL: expected non-empty string');
  }

  const candidate = rawUrl.trim();
  let parsedUrl;

  try {
    parsedUrl = new URL(candidate);
  } catch (error) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
      throw new Error(`Invalid host URL: ${error.message}`);
    }

    try {
      parsedUrl = new URL(`http://${candidate}`);
    } catch (fallbackError) {
      throw new Error(`Invalid host URL: ${fallbackError.message}`);
    }
  }

  const host = parsedUrl.hostname;
  if (!host) {
    throw new Error('Invalid host URL: missing hostname');
  }

  const rawPort = parsedUrl.port ? Number(parsedUrl.port) : fallbackPort;
  const port = Number.isInteger(rawPort) ? rawPort : Number.NaN;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid host URL: port must be between 1 and 65535 (got ${parsedUrl.port || fallbackPort})`);
  }

  return { host, port, protocol: parsedUrl.protocol || 'http:' };
}

function parseJsonValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function parseModels(value) {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function normalizeNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildCapabilities(existingValue, extra) {
  const parsed = parseJsonValue(existingValue);
  const base = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : {};

  return JSON.stringify({
    ...(typeof base === 'object' && base !== null ? base : {}),
    ...extra,
  });
}

function mapOllamaHost(ws) {
  return {
    id: ws?.id,
    name: ws?.name,
    url: `http://${ws?.host}:${ws?.ollama_port || 11434}`,
    enabled: ws?.enabled,
    status: ws?.status,
    consecutive_failures: ws?.consecutive_failures,
    last_health_check: ws?.last_health_check,
    last_healthy: ws?.last_healthy,
    running_tasks: ws?.running_tasks,
    models_cache: ws?.models_cache,
    models_updated_at: ws?.models_updated_at,
    models: parseModels(ws?.models ?? ws?.models_cache),
    memory_limit_mb: ws?.memory_limit_mb,
    max_concurrent: ws?.max_concurrent,
    priority: ws?.priority,
    settings: ws?.settings,
    gpu_metrics_port: ws?.gpu_metrics_port,
    last_model_used: ws?.last_model_used,
    model_loaded_at: ws?.model_loaded_at,
    created_at: ws?.created_at,
  };
}

function listWorkstationsByCapability(capability, options = {}) {
  const filters = { capability };

  if (typeof options.enabled === 'boolean') {
    filters.enabled = options.enabled;
  }

  if (typeof options.status === 'string' && options.status.trim()) {
    filters.status = options.status.trim();
  }

  return model.listWorkstations(filters) || [];
}

function listOllamaHosts(options = {}) {
  return listWorkstationsByCapability('ollama', options).map(mapOllamaHost);
}

function resolvePeekHost(options = {}) {
  const workstations = listWorkstationsByCapability('ui_capture', { enabled: true });
  if (!Array.isArray(workstations) || workstations.length === 0) {
    return null;
  }

  if (typeof options?.name === 'string') {
    const preferredName = options.name.trim();
    if (preferredName) {
      const namedHost = workstations.find((ws) => ws?.name === preferredName);
      if (namedHost) {
        return namedHost;
      }
    }
  }

  const defaultHost = workstations.find((ws) => ws?.is_default);
  if (defaultHost) {
    return defaultHost;
  }

  const healthyHost = workstations.find((ws) => ws?.status === 'healthy');
  if (healthyHost) {
    return healthyHost;
  }

  return workstations[0] || null;
}

function getAvailableAgents() {
  return listWorkstationsByCapability('command_exec', { enabled: true })
    .filter((ws) => ws?.status !== 'down')
    .filter((ws) => {
      const runningTasks = normalizeNumber(ws?.running_tasks, 0);
      const maxConcurrent = normalizeNumber(ws?.max_concurrent, 0);
      if (maxConcurrent <= 0) {
        return true;
      }
      return runningTasks < maxConcurrent;
    });
}

function addOllamaHost(host) {
  if (!host || typeof host !== 'object') {
    throw new Error('Invalid host payload: expected object');
  }

  const parsed = parseUrl(host.url, 11434);
  const hostName = typeof host.name === 'string' ? host.name.trim() : '';
  if (!hostName) {
    throw new Error('Invalid host payload: name is required');
  }

  return model.createWorkstation({
    id: typeof host.id === 'string' && host.id.trim() ? host.id.trim() : undefined,
    name: hostName,
    host: parsed.host,
    ollama_port: parsed.port,
    agent_port: normalizeNumber(host.agent_port, 3460),
    platform: typeof host.platform === 'string' ? host.platform.trim() : null,
    arch: typeof host.arch === 'string' ? host.arch.trim() : null,
    tls_cert: typeof host.tls_cert === 'string' ? host.tls_cert.trim() : null,
    tls_fingerprint: typeof host.tls_fingerprint === 'string' ? host.tls_fingerprint.trim() : null,
    secret: (typeof host.secret === 'string' && host.secret.trim()) || randomUUID(),
    capabilities: buildCapabilities(host.capabilities, {
      ollama: { detected: true, port: parsed.port },
    }),
    memory_limit_mb: normalizeNumber(host.memory_limit_mb, 8192),
    models_cache: typeof host.models_cache === 'string'
      ? host.models_cache
      : Array.isArray(host.models)
        ? JSON.stringify(host.models)
        : null,
    models_updated_at: host.models_updated_at || null,
    settings: typeof host.settings === 'string'
      ? host.settings
      : host.settings
        ? JSON.stringify(host.settings)
        : null,
    max_concurrent: normalizeNumber(host.max_concurrent, 1),
    priority: normalizeNumber(host.priority, 10),
    status: typeof host.status === 'string' ? host.status.trim() : null,
    consecutive_failures: normalizeNumber(host.consecutive_failures, 0),
    last_health_check: host.last_health_check || null,
    last_healthy: host.last_healthy || null,
    enabled: normalizeBool(host.enabled, true) ? 1 : 0,
    is_default: normalizeBool(host.is_default, false) ? 1 : 0,
    // `created_at` and `updated_at` are set by the model insert defaults.
  });
}

function registerPeekHost(host) {
  if (!host || typeof host !== 'object') {
    throw new Error('Invalid host payload: expected object');
  }

  const hostName = typeof host.name === 'string' ? host.name.trim() : '';
  if (!hostName) {
    throw new Error('Invalid host payload: name is required');
  }
  const parsed = parseUrl(host.url || host.endpoint || `127.0.0.1:9876`, 9876);

  return model.createWorkstation({
    id: typeof host.id === 'string' && host.id.trim() ? host.id.trim() : undefined,
    name: hostName,
    host: parsed.host,
    agent_port: normalizeNumber(host.agent_port, parsed.port),
    platform: typeof host.platform === 'string' ? host.platform.trim() : null,
    secret: (typeof host.secret === 'string' && host.secret.trim()) || randomUUID(),
    capabilities: buildCapabilities(host.capabilities, {
      ui_capture: {
        detected: true,
        has_display: host.has_display !== false,
        peek_server: 'running',
      },
    }),
    is_default: normalizeBool(host.is_default, false) ? 1 : 0,
    enabled: normalizeBool(host.enabled, true) ? 1 : 0,
    status: typeof host.status === 'string' ? host.status.trim() : null,
    max_concurrent: normalizeNumber(host.max_concurrent, 1),
    models_cache: typeof host.models_cache === 'string' ? host.models_cache : null,
    settings: typeof host.settings === 'string'
      ? host.settings
      : host.settings
        ? JSON.stringify(host.settings)
        : null,
    tls_cert: typeof host.tls_cert === 'string' ? host.tls_cert.trim() : null,
    tls_fingerprint: typeof host.tls_fingerprint === 'string'
      ? host.tls_fingerprint.trim()
      : null,
    memory_limit_mb: normalizeNumber(host.memory_limit_mb, null),
    priority: normalizeNumber(host.priority, 10),
    consecutive_failures: normalizeNumber(host.consecutive_failures, 0),
    last_health_check: host.last_health_check || null,
    last_healthy: host.last_healthy || null,
  });
}

function registerRemoteAgent(agent) {
  if (!agent || typeof agent !== 'object') {
    throw new Error('Invalid agent payload: expected object');
  }

  const agentName = typeof agent.name === 'string' ? agent.name.trim() : '';
  if (!agentName) {
    throw new Error('Invalid agent payload: name is required');
  }
  const parsed = parseUrl(agent.url || agent.endpoint || `127.0.0.1:3460`, 3460);
  const remotePort = normalizeNumber(agent.port, parsed.port);

  return model.createWorkstation({
    id: typeof agent.id === 'string' && agent.id.trim() ? agent.id.trim() : undefined,
    name: agentName,
    host: parsed.host,
    agent_port: remotePort,
    platform: typeof agent.platform === 'string' ? agent.platform.trim() : null,
    secret: (typeof agent.secret === 'string' && agent.secret.trim()) || randomUUID(),
    capabilities: buildCapabilities(agent.capabilities, {
      command_exec: true,
      git_sync: true,
    }),
    max_concurrent: normalizeNumber(agent.max_concurrent, 3),
    is_default: normalizeBool(agent.is_default, false) ? 1 : 0,
    enabled: normalizeBool(agent.enabled, true) ? 1 : 0,
    status: typeof agent.status === 'string' ? agent.status.trim() : null,
    settings: typeof agent.settings === 'string'
      ? agent.settings
      : agent.settings
        ? JSON.stringify(agent.settings)
        : null,
    tls_cert: typeof agent.tls_cert === 'string' ? agent.tls_cert.trim() : null,
    tls_fingerprint: typeof agent.tls_fingerprint === 'string'
      ? agent.tls_fingerprint.trim()
      : null,
    memory_limit_mb: normalizeNumber(agent.memory_limit_mb, null),
    priority: normalizeNumber(agent.priority, 10),
    consecutive_failures: normalizeNumber(agent.consecutive_failures, 0),
    last_health_check: agent.last_health_check || null,
    last_healthy: agent.last_healthy || null,
  });
}

module.exports = {
  setDb,
  listOllamaHosts,
  resolvePeekHost,
  getAvailableAgents,
  addOllamaHost,
  registerPeekHost,
  registerRemoteAgent,
};
