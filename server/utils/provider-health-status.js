'use strict';

const providerRoutingCore = require('../db/provider-routing-core');

function normalizeRuntimeHealth(runtimeHealth) {
  const successes = Number(runtimeHealth?.successes ?? runtimeHealth?.successful_tasks) || 0;
  const failures = Number(runtimeHealth?.failures ?? runtimeHealth?.failed_tasks) || 0;
  const total = successes + failures;
  const failureRate = Number.isFinite(Number(runtimeHealth?.failureRate))
    ? Number(runtimeHealth.failureRate)
    : (total > 0 ? failures / total : 0);

  return {
    successes,
    failures,
    failureRate,
    total,
  };
}

function getProviderHealthStatus(provider, runtimeHealth = null) {
  const providerId = typeof provider === 'string'
    ? provider.trim()
    : (provider?.provider || provider?.id || '').trim();

  const enabled = typeof provider === 'object'
    ? Boolean(provider.enabled)
    : true;

  if (!providerId) {
    return {
      provider: '',
      status: enabled ? 'healthy' : 'disabled',
      health: normalizeRuntimeHealth(runtimeHealth),
      isHealthy: true,
      isConfigured: true,
    };
  }

  const health = normalizeRuntimeHealth(runtimeHealth || providerRoutingCore.getProviderHealth?.(providerId));
  const isConfigured = typeof providerRoutingCore.isProviderConfiguredForRouting === 'function'
    ? providerRoutingCore.isProviderConfiguredForRouting(providerId)
    : true;
  const isHealthy = typeof providerRoutingCore.isProviderHealthy === 'function'
    ? providerRoutingCore.isProviderHealthy(providerId)
    : true;

  let status = 'healthy';
  if (!enabled) {
    status = 'disabled';
  } else if (!isConfigured) {
    status = 'unavailable';
  } else if (!isHealthy) {
    status = 'degraded';
  } else if (health.failures > 0) {
    status = 'warning';
  }

  return {
    provider: providerId,
    status,
    health,
    isHealthy,
    isConfigured,
  };
}

module.exports = {
  getProviderHealthStatus,
};
