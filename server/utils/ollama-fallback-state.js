'use strict';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function readConfigValue(config, key, fallback) {
  if (config && typeof config.get === 'function') {
    const value = config.get(key);
    return value === undefined || value === null || value === '' ? fallback : value;
  }
  return fallback;
}

function readConfigBool(config, key, fallback) {
  if (config && typeof config.getBool === 'function') {
    return Boolean(config.getBool(key, fallback));
  }
  return fallback;
}

function isRemoteUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return !LOCAL_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

function normalizeEnabled(value) {
  return value === true || value === 1 || value === '1';
}

function normalizeHost(host) {
  const models = Array.isArray(host?.models) ? host.models : [];
  return {
    id: host?.id || null,
    name: host?.name || host?.id || 'default',
    url: host?.url || '',
    status: host?.status || 'unknown',
    enabled: normalizeEnabled(host?.enabled),
    remote: isRemoteUrl(host?.url),
    running_tasks: Number(host?.running_tasks) || 0,
    models_count: models.length,
  };
}

function readHosts(hostManagement, explicitHosts) {
  if (Array.isArray(explicitHosts)) {
    return explicitHosts.map(normalizeHost);
  }

  if (hostManagement && typeof hostManagement.listOllamaHosts === 'function') {
    try {
      const hosts = hostManagement.listOllamaHosts();
      if (Array.isArray(hosts)) {
        return hosts.map(normalizeHost);
      }
    } catch {
      return [];
    }
  }

  return [];
}

function readCachedOllamaHealth(providerRoutingCore) {
  if (providerRoutingCore && typeof providerRoutingCore.isOllamaHealthy === 'function') {
    try {
      const healthy = providerRoutingCore.isOllamaHealthy();
      if (healthy === true || healthy === false) return healthy;
    } catch {
      return null;
    }
  }
  return null;
}

function fallbackSummary(state, healthyCount, totalCount, fallbackProvider) {
  if (state === 'fallback_active') {
    return `Ollama unavailable; routing is using ${fallbackProvider} fallback`;
  }
  if (state === 'partial_degradation') {
    return `${healthyCount}/${totalCount} Ollama hosts available; routing will avoid down hosts`;
  }
  if (state === 'preferred_available') {
    return `${healthyCount}/${totalCount} Ollama hosts available`;
  }
  if (state === 'unconfigured') {
    return 'No enabled Ollama hosts are configured';
  }
  return 'Ollama availability is not known yet';
}

function buildOllamaFallbackState({
  hostManagement = null,
  providerRoutingCore = null,
  serverConfig = null,
  hosts = null,
  singleHostHealthy = undefined,
} = {}) {
  const fallbackProvider = readConfigValue(serverConfig, 'ollama_fallback_provider', 'codex') || 'codex';
  const smartRoutingEnabled = readConfigBool(serverConfig, 'smart_routing_enabled', true);
  let normalizedHosts = readHosts(hostManagement, hosts);

  if (normalizedHosts.length === 0) {
    const ollamaHost = readConfigValue(serverConfig, 'ollama_host', 'http://localhost:11434') || 'http://localhost:11434';
    const cachedHealthy = singleHostHealthy === true || singleHostHealthy === false
      ? singleHostHealthy
      : readCachedOllamaHealth(providerRoutingCore);
    normalizedHosts = [normalizeHost({
      id: 'default',
      name: 'default',
      url: ollamaHost,
      enabled: true,
      status: cachedHealthy === true ? 'healthy' : cachedHealthy === false ? 'down' : 'unknown',
      running_tasks: 0,
      models: [],
    })];
  }

  const enabledHosts = normalizedHosts.filter((host) => host.enabled);
  const totalCount = enabledHosts.length;
  const healthyCount = enabledHosts.filter((host) => host.status === 'healthy').length;
  const knownDownCount = enabledHosts.filter((host) => ['down', 'degraded'].includes(host.status)).length;
  const unknownCount = enabledHosts.filter((host) => host.status === 'unknown').length;
  const remotePreferred = enabledHosts.some((host) => host.remote);

  let state = 'unknown';
  let healthStatus = 'unknown';

  if (totalCount === 0) {
    state = 'unconfigured';
    healthStatus = 'disabled';
  } else if (healthyCount === totalCount) {
    state = 'preferred_available';
    healthStatus = 'healthy';
  } else if (healthyCount > 0) {
    state = 'partial_degradation';
    healthStatus = 'warning';
  } else if (knownDownCount > 0 && unknownCount === 0) {
    state = 'fallback_active';
    healthStatus = 'degraded';
  }

  const fallbackActive = state === 'fallback_active';

  return {
    preferred_provider: 'ollama',
    fallback_provider: fallbackProvider,
    fallback_active: fallbackActive,
    preferred_available: healthyCount > 0,
    remote_preferred: remotePreferred,
    smart_routing_enabled: smartRoutingEnabled,
    state,
    health_status: healthStatus,
    healthy_count: healthyCount,
    total_count: totalCount,
    host_count: normalizedHosts.length,
    known_down_count: knownDownCount,
    unknown_count: unknownCount,
    summary: fallbackSummary(state, healthyCount, totalCount, fallbackProvider),
    hosts: normalizedHosts,
  };
}

function mergeProviderHealthStatus(baseStatus, fallbackState) {
  if (baseStatus === 'disabled' || baseStatus === 'unavailable') {
    return baseStatus;
  }
  if (!fallbackState) {
    return baseStatus;
  }
  if (fallbackState.health_status === 'degraded') {
    return 'degraded';
  }
  if (fallbackState.health_status === 'warning' && baseStatus === 'healthy') {
    return 'warning';
  }
  return baseStatus;
}

module.exports = {
  buildOllamaFallbackState,
  mergeProviderHealthStatus,
};
