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

/**
 * Phase H: parse the optional `by_kind` map. Maps factory-internal task
 * kinds (architect_cycle, plan_generation, verify_review, etc.) to a
 * provider that should run them, OVERRIDING the project's
 * expected_provider for those kinds. Used for the "Codex as manager,
 * ollama as worker" pattern where local ollama drives EXECUTE but
 * vague-input architect / plan-quality / reviewer tasks need a stronger
 * model. Keys must be strings, values must be normalizable provider
 * names; entries with empty values are dropped.
 */
function normalizeByKindMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawKind, rawProvider] of Object.entries(value)) {
    const kind = typeof rawKind === 'string' ? rawKind.trim().toLowerCase() : '';
    const provider = normalizeProviderName(rawProvider);
    if (kind && provider) {
      out[kind] = provider;
    }
  }
  return out;
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
  const byKind = normalizeByKindMap(policy.by_kind || policy.byKind || policy.kindOverrides);
  const enforcementMode = typeof policy.enforcement === 'string'
    ? policy.enforcement.trim().toLowerCase()
    : (typeof policy.mode === 'string' ? policy.mode.trim().toLowerCase() : '');
  const enforceHandoffs = coerceBoolean(
    policy.enforce_handoffs ?? policy.enforceHandoffs ?? policy.enforce ?? policy.block_handoffs,
    STRICT_MODES.has(enforcementMode)
  );

  if (!expectedProvider
    && allowedFallbackProviders.length === 0
    && allowedProviders.length === 0
    && Object.keys(byKind).length === 0) {
    return null;
  }

  return {
    expected_provider: expectedProvider || null,
    allowed_fallback_providers: allowedFallbackProviders,
    allowed_providers: allowedProviders,
    by_kind: byKind,
    enforce_handoffs: Boolean(enforceHandoffs),
  };
}

/**
 * Phase S: kind-family fallback. When `by_kind` lacks an entry for the
 * exact kind, we look up the kind's family. This lets operators declare
 * `architect_cycle: codex` once and have it cover all architect-related
 * kinds (architect_json, replan_rewrite, replan_decompose) without
 * having to enumerate every kind that didn't exist when they wrote
 * their config.
 *
 * Live evidence (DLPhone 2026-05-01 13:03 UTC): operator's by_kind had
 * architect_cycle/plan_generation/verify_review → codex, but Phase P's
 * new replan_rewrite/replan_decompose kinds had no entry, so they fell
 * through to the project default (ollama) and qwen3-coder:30b returned
 * "0 tool calls, 0 files changed" on a structured-JSON architect prompt.
 */
const KIND_FAMILY = Object.freeze({
  architect_json: 'architect_cycle',
  architect_cycle: 'architect_cycle',
  replan_rewrite: 'architect_cycle',
  replan_decompose: 'architect_cycle',
  plan_generation: 'plan_generation',
  plan_quality_review: 'plan_generation',
  verify_review: 'verify_review',
  scout: 'scout',
});

/**
 * Phase H: return a kind-specialized view of the policy. When the kind
 * has a `by_kind` entry, that provider becomes the effective
 * `expected_provider` AND is added to `allowed_providers` so the lane
 * filter accepts it. Original allowed_providers / allowed_fallback_providers
 * are preserved so the worker lane is still legal for non-overridden
 * kinds. Returns the original policy unchanged when kind is missing or
 * has no by_kind entry — including no family-level entry (Phase S).
 */
function specializePolicyForKind(policy, kind) {
  if (!policy || typeof policy !== 'object') return policy;
  const normalizedKind = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
  if (!normalizedKind) return policy;
  const byKind = policy.by_kind || {};
  // Exact-kind override wins (operator was explicit).
  // Family fallback covers new kinds that share an architect/plan/verify
  // role with one the operator already mapped.
  let overrideProvider = byKind[normalizedKind];
  if (!overrideProvider) {
    const family = KIND_FAMILY[normalizedKind];
    if (family && family !== normalizedKind) {
      overrideProvider = byKind[family];
    }
  }
  if (!overrideProvider) return policy;

  const allowedProviders = Array.isArray(policy.allowed_providers) ? policy.allowed_providers : [];
  const merged = allowedProviders.includes(overrideProvider)
    ? allowedProviders
    : [...allowedProviders, overrideProvider];

  return {
    ...policy,
    expected_provider: overrideProvider,
    allowed_providers: merged,
  };
}

function getProviderLanePolicyFromMetadata(metadata = {}) {
  const policy = normalizeProviderLanePolicy(
    metadata.provider_lane_policy
      || metadata.provider_lane
      || metadata.policy?.provider_lane
      || metadata.policy?.provider_lane_policy
  );
  // Phase H: when the metadata also carries a `kind` (factory-internal
  // task), specialize the policy so the kind's by_kind override (if any)
  // becomes the effective expected_provider for routing/handoff checks.
  // This is what lets routing.js's chain filter admit codex for a
  // plan_generation task on an otherwise ollama-pinned project.
  const kind = typeof metadata.kind === 'string' ? metadata.kind : null;
  return kind ? specializePolicyForKind(policy, kind) : policy;
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

function buildProviderLaneTaskMetadata(projectOrConfig = {}, kind = null) {
  // Phase T (2026-05-01): when the caller knows the kind, stamp the
  // kind-specialized policy onto the task's metadata. Otherwise any
  // downstream consumer that re-resolves provider from
  // metadata.provider_lane_policy.expected_provider would see the
  // unspecialized worker-lane provider (e.g. ollama on DLPhone) and
  // override the codex routing that Phase H/S already chose at
  // submission time. The metadata previously diverged from the actual
  // routing decision; this keeps them aligned.
  const rawPolicy = getProviderLanePolicyFromProject(projectOrConfig);
  if (!rawPolicy) return {};
  const policy = kind ? specializePolicyForKind(rawPolicy, kind) : rawPolicy;
  return { provider_lane_policy: policy };
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
  specializePolicyForKind,
  normalizeByKindMap,
};
