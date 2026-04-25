'use strict';

const STRICT_MODES = new Set(['block', 'enforce', 'fail', 'strict']);

function normalizeProviderName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function coerceBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readProjectConfig(projectOrConfig) {
  const source = parseJsonObject(projectOrConfig);
  if (source.config && typeof source.config === 'object' && !Array.isArray(source.config)) {
    return source.config;
  }
  if (source.config_json) {
    return parseJsonObject(source.config_json);
  }
  return source;
}

function normalizeProviderLanePolicy(value) {
  const policy = parseJsonObject(value);
  const expectedProvider = normalizeProviderName(policy.expected_provider || policy.expectedProvider);
  const allowedFallbackProviders = normalizeStringList(
    policy.allowed_fallback_providers || policy.allowedFallbackProviders
  ).map(normalizeProviderName).filter(Boolean);
  const allowedProviders = normalizeStringList(
    policy.allowed_providers || policy.allowedProviders
  ).map(normalizeProviderName).filter(Boolean);
  const enforcementMode = typeof policy.enforcement === 'string'
    ? policy.enforcement.trim().toLowerCase()
    : (typeof policy.mode === 'string' ? policy.mode.trim().toLowerCase() : '');
  const enforceHandoffs = coerceBoolean(
    policy.enforce_handoffs ?? policy.enforceHandoffs ?? policy.enforce ?? policy.block_handoffs,
    STRICT_MODES.has(enforcementMode)
  );

  if (!expectedProvider && allowedFallbackProviders.length === 0 && allowedProviders.length === 0) {
    return null;
  }

  return {
    expected_provider: expectedProvider || null,
    allowed_fallback_providers: allowedFallbackProviders,
    allowed_providers: allowedProviders,
    enforce_handoffs: Boolean(enforceHandoffs),
  };
}

function getProviderLanePolicyFromMetadata(metadata = {}) {
  return normalizeProviderLanePolicy(
    metadata.provider_lane_policy
      || metadata.provider_lane
      || metadata.policy?.provider_lane
      || metadata.policy?.provider_lane_policy
  );
}

function getProviderLanePolicyFromProject(projectOrConfig = {}) {
  const config = readProjectConfig(projectOrConfig);
  return normalizeProviderLanePolicy(
    config.provider_lane_policy
      || config.provider_lane
      || config.policy?.provider_lane
      || config.policy?.provider_lane_policy
  );
}

function buildProviderLaneTaskMetadata(projectOrConfig = {}) {
  const policy = getProviderLanePolicyFromProject(projectOrConfig);
  return policy ? { provider_lane_policy: policy } : {};
}

function isProviderAllowedByLanePolicy(policy, provider) {
  const normalizedProvider = normalizeProviderName(provider);
  if (!policy || !policy.enforce_handoffs || !normalizedProvider) {
    return true;
  }
  if (policy.expected_provider && normalizedProvider === policy.expected_provider) {
    return true;
  }
  if (policy.allowed_fallback_providers.includes(normalizedProvider)) {
    return true;
  }
  if (policy.allowed_providers.includes(normalizedProvider)) {
    return true;
  }
  return false;
}

function isProviderLaneHandoffAllowed(metadataOrPolicy, provider) {
  const policy = normalizeProviderLanePolicy(metadataOrPolicy)
    || getProviderLanePolicyFromMetadata(metadataOrPolicy);
  return isProviderAllowedByLanePolicy(policy, provider);
}

function providerLaneHandoffBlockReason(metadataOrPolicy, provider) {
  const policy = normalizeProviderLanePolicy(metadataOrPolicy)
    || getProviderLanePolicyFromMetadata(metadataOrPolicy);
  if (isProviderAllowedByLanePolicy(policy, provider)) return null;
  return `provider lane policy blocked handoff to ${normalizeProviderName(provider) || 'unknown'}`
    + `${policy?.expected_provider ? `; expected ${policy.expected_provider}` : ''}`;
}

module.exports = {
  buildProviderLaneTaskMetadata,
  getProviderLanePolicyFromMetadata,
  getProviderLanePolicyFromProject,
  isProviderAllowedByLanePolicy,
  isProviderLaneHandoffAllowed,
  normalizeProviderLanePolicy,
  providerLaneHandoffBlockReason,
};
