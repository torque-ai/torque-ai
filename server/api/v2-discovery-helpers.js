/**
 * V2 API Discovery Helpers
 *
 * Provider descriptor building, model resolution, health payloads,
 * and response envelope helpers for the V2 REST API.
 *
 * Extracted from api-server.core.js to reduce file size.
 */

const serverConfig = require('../config');
const { API_KEY_ENV_VARS } = serverConfig;
const { countTasks } = require('../db/task-core');
const { getDefaultProvider, getProviderHealth, isProviderHealthy } = require('../db/provider-routing-core');
const { listOllamaHosts, recordHostHealthCheck } = require('../db/host-management');
const { getProviderStats } = require('../db/file-tracking');
const { getApprovedModels } = require('../models/registry');
const { PROVIDER_DEFAULT_TIMEOUTS, PROVIDER_DEFAULTS } = require('../constants');
const { getProviderHealthStatus } = require('../utils/provider-health-status');
const {
  getProviderCapabilityMatrix,
  getProviderAdapter,
} = require('../providers/adapter-registry');
const { parseModelSizeB } = require('../utils/model');
const { probeOllamaEndpoint } = require('../handlers/shared');

const {
  DEFAULT_REQUEST_RATE_PER_MINUTE,
  PROVIDER_REGISTRY,
  PROVIDER_LOCAL_IDS,
  V2_TRANSPORTS,
} = require('./v2-provider-registry');

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

function normalizeV2Transport(rawTransport) {
  if (typeof rawTransport !== 'string') return null;
  const transport = rawTransport.trim().toLowerCase();
  return V2_TRANSPORTS.has(transport) ? transport : null;
}

function getV2ProviderTransport(provider) {
  const explicit = normalizeV2Transport(provider?.transport);
  if (explicit) return explicit;
  if (provider?.provider === 'codex') return 'hybrid';
  if (provider?.provider === 'claude-cli' || provider?.provider === 'claude-code-sdk') return 'cli';
  return 'api';
}

// ---------------------------------------------------------------------------
// Static provider model catalogs
// ---------------------------------------------------------------------------

const PROVIDER_MODELS = {
  codex: {
    source: 'static',
    models: ['gpt-5.3-codex-spark'],
  },
  'claude-cli': {
    source: 'static',
    models: [
      'claude-sonnet-4-20250514',
      'claude-haiku-4-20250514',
      'claude-opus-4-20250514',
    ],
  },
  'claude-code-sdk': {
    source: 'static',
    models: [
      'claude-sonnet-4-20250514',
      'claude-haiku-4-20250514',
      'claude-opus-4-20250514',
    ],
  },
  anthropic: {
    source: 'provider_api',
    models: [
      'claude-sonnet-4-20250514',
      'claude-haiku-4-20250514',
      'claude-opus-4-20250514',
    ],
  },
  groq: {
    source: 'provider_api',
    models: [], // Models discovered dynamically via provider API
  },
  'cerebras': {
    source: 'provider_api',
    models: [], // Models discovered dynamically via provider API
  },
  'ollama-cloud': {
    source: 'provider_api',
    models: [], // Models discovered dynamically via provider API
  },
  'google-ai': {
    source: 'provider_api',
    models: [
      'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash',
      'gemini-2.0-flash-lite', 'gemini-3-flash-preview', 'gemini-3-pro-preview',
    ],
  },
  openrouter: {
    source: 'provider_api',
    models: [], // Models discovered dynamically via provider API
  },
  deepinfra: {
    source: 'provider_api',
    models: [], // Models discovered dynamically via provider API
  },
  hyperbolic: {
    source: 'provider_api',
    models: [], // Models discovered dynamically via provider API
  },
};

const PROVIDER_MODEL_CONFIG_KEYS = Object.freeze({
  codex: ['codex_api_model', 'codex_model'],
});

const PROVIDER_API_KEY_CONFIG_KEYS = Object.freeze({
  anthropic: ['anthropic_api_key'],
  groq: ['groq_api_key'],
  cerebras: ['cerebras_api_key'],
  'google-ai': ['google_ai_api_key'],
  'ollama-cloud': ['ollama_cloud_api_key'],
  openrouter: ['openrouter_api_key'],
  deepinfra: ['deepinfra_api_key'],
  hyperbolic: ['hyperbolic_api_key'],
});

const PROVIDER_MODEL_NAME_OVERRIDES = Object.freeze({
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-4o-mini': 'GPT-4o Mini',
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
  'claude-haiku-4-20250514': 'Claude Haiku 4',
  'claude-opus-4-20250514': 'Claude Opus 4',
});

// ---------------------------------------------------------------------------
// V2 response envelope helpers
// ---------------------------------------------------------------------------

function sendV2Success(res, requestId, payload, status = 200, req = null) {
  const { sendJson } = require('./middleware');
  sendJson(res, {
    ...payload,
    request_id: requestId,
  }, status, req);
}

function sendV2Error(res, requestId, code, message, status = 400, details = {}, req = null) {
  const { sendJson } = require('./middleware');
  sendJson(res, {
    error: {
      code,
      message,
      request_id: requestId,
      details,
    },
  }, status, req);
}

function buildV2MetaEnvelope(requestId) {
  return {
    request_id: requestId,
    timestamp: new Date().toISOString(),
  };
}

function sendV2DiscoverySuccess(res, requestId, data, status = 200, req = null, legacyPayload = {}) {
  const { sendJson } = require('./middleware');
  sendJson(
    res,
    {
      data,
      meta: buildV2MetaEnvelope(requestId),
      request_id: requestId,
      ...legacyPayload,
    },
    status,
    req,
  );
}

function sendV2DiscoveryError(res, requestId, code, message, status = 400, details = {}, req = null) {
  const { sendJson } = require('./middleware');
  sendJson(
    res,
    {
      error: {
        code,
        message,
        request_id: requestId,
        details,
      },
      meta: buildV2MetaEnvelope(requestId),
    },
    status,
    req,
  );
}

function sendAuthError(res, requestId, req) {
  const { sendJson } = require('./middleware');
  req._authChallenge = 'Bearer realm="Torque API", error="invalid_token"';
  sendJson(
    res,
    {
      error: {
        code: 'unauthorized',
        message: 'Invalid or missing API key',
        request_id: requestId,
        details: {
          auth: 'x-torque-key',
          code: 'invalid_api_key',
        },
      },
    },
    401,
    req,
  );
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

function getV2ProviderDefaultTimeoutMs(providerId) {
  const timeoutSeconds = PROVIDER_DEFAULT_TIMEOUTS[providerId];
  const safeSeconds = Number(timeoutSeconds);
  if (Number.isFinite(safeSeconds) && safeSeconds > 0) {
    return safeSeconds * 60 * 1000;
  }
  return 30 * 60 * 1000;
}

function getV2ProviderQueueDepth(providerId) {
  try {
    return Number(countTasks({ provider: providerId, status: 'queued' })) || 0;
  } catch {
    return 0;
  }
}

function getV2ProviderDefaultProvider() {
  try {
    return getDefaultProvider();
  } catch {
    return null;
  }
}

function getV2ProviderHealth(providerId) {
  try {
    return getProviderHealth(providerId);
  } catch {
    return { successes: 0, failures: 0, failureRate: 0 };
  }
}

function isV2ProviderHealthy(providerId) {
  try {
    return isProviderHealthy(providerId);
  } catch {
    return true;
  }
}

function getV2ProviderStatus(provider, providerId) {
  return getProviderHealthStatus(
    providerId ? { ...provider, provider: providerId } : provider,
    getV2ProviderHealth(providerId),
  ).status;
}

function buildV2ProviderLimits(provider, providerId) {
  const registryMeta = PROVIDER_REGISTRY[providerId] || {};
  const queueDepth = getV2ProviderQueueDepth(providerId);
  const maxConcurrent = Number(provider?.max_concurrent) || 0;
  const defaultTimeoutMs = getV2ProviderDefaultTimeoutMs(providerId);

  return {
    max_concurrent: maxConcurrent,
    timeout_ms_default: registryMeta.timeout_ms_default || defaultTimeoutMs,
    timeout_ms_max: registryMeta.timeout_ms_max || Math.max(defaultTimeoutMs, 60000),
    request_rate_per_minute: Number(registryMeta.request_rate_per_minute || DEFAULT_REQUEST_RATE_PER_MINUTE),
    queue_depth: queueDepth,
  };
}

function getV2ProviderAdapterCapabilities(providerId) {
  const capabilityMatrix = getProviderCapabilityMatrix();
  return (
    capabilityMatrix[providerId] || {
      supportsStream: false,
      supportsAsync: false,
      supportsCancellation: false,
    }
  );
}

function normalizeProviderFeatureList(features) {
  return Object.entries(features || {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([feature]) => feature)
    .sort();
}

function parseConfiguredPositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return null;
}

function getV2ProviderMaxContext(providerId) {
  const registryMeta = PROVIDER_REGISTRY[providerId] || {};
  if (parseConfiguredPositiveInt(registryMeta.max_context)) {
    return parseConfiguredPositiveInt(registryMeta.max_context);
  }

  if (!PROVIDER_LOCAL_IDS.has(providerId)) {
    return 0;
  }

  try {
    return (
      parseConfiguredPositiveInt(serverConfig.get('ollama_max_ctx'))
      || parseConfiguredPositiveInt(serverConfig.get('ollama_num_ctx'))
      || PROVIDER_DEFAULTS.OLLAMA_MAX_CONTEXT
    );
  } catch {
    return PROVIDER_DEFAULTS.OLLAMA_MAX_CONTEXT;
  }
}

function buildV2ProviderSupportedFormats(features) {
  const formats = new Set();
  if (
    features?.chat
    || features?.stream
    || features?.file_edit
    || features?.reasoning
    || features?.code_interpretation
  ) {
    formats.add('text');
  }
  if (features?.image_input || features?.vision) {
    formats.add('image');
  }
  if (features?.embeddings) {
    formats.add('embeddings');
  }
  return Array.from(formats).sort();
}

function buildV2ProviderCapabilities(providerId) {
  const registryMeta = PROVIDER_REGISTRY[providerId] || {};
  const adapterCapabilities = getV2ProviderAdapterCapabilities(providerId);
  return {
    streaming: Boolean(adapterCapabilities.supportsStream),
    async: Boolean(adapterCapabilities.supportsAsync),
    max_context: getV2ProviderMaxContext(providerId),
    supported_formats: buildV2ProviderSupportedFormats(registryMeta.features || {}),
  };
}

function buildV2ProviderDescriptor(provider, defaultProviderId, options = {}) {
  const { includeCapabilities = false } = options;
  const providerId = provider?.provider || provider?.id;
  if (!providerId) {
    return null;
  }
  const registryMeta = PROVIDER_REGISTRY[providerId] || {
    name: providerId,
    transport: 'api',
    local: false,
    features: {},
  };
  const status = getV2ProviderStatus(provider, providerId);

  const descriptor = {
    id: providerId,
    name: registryMeta.name,
    transport: getV2ProviderTransport(provider),
    local: Boolean(registryMeta.local),
    enabled: provider?.enabled ?? false,
    default: providerId === defaultProviderId,
    features: normalizeProviderFeatureList(registryMeta.features || {}),
    limits: buildV2ProviderLimits(provider, providerId),
    status,
  };

  if (includeCapabilities) {
    descriptor.capabilities = buildV2ProviderCapabilities(providerId);
  }

  return descriptor;
}

function decodeV2ProviderIdOrSendError(providerId, requestId, res, req, context = 'provider_id') {
  try {
    const decodedProviderId = decodeURIComponent(providerId || '').trim();
    if (decodedProviderId) {
      return decodedProviderId;
    }

    sendV2DiscoveryError(
      res,
      requestId,
      'validation_error',
      'Provider id is required',
      400,
      { context, field: 'provider_id' },
      req,
    );
    return null;
  } catch (err) {
    if (err instanceof URIError) {
      sendV2DiscoveryError(
        res,
        requestId,
        'validation_error',
        'Invalid provider id encoding',
        400,
        { context, field: 'provider_id' },
        req,
      );
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

function normalizeProviderModels(models) {
  if (!Array.isArray(models)) {
    return [];
  }

  const uniqueModels = new Set();
  for (const model of models) {
    if (typeof model === 'string') {
      const value = model.trim();
      if (value) uniqueModels.add(value);
      continue;
    }
    if (model && typeof model === 'object') {
      const candidate = model.model_name || model.id || model.name || model.model;
      const value = typeof candidate === 'string' ? candidate.trim() : '';
      if (value) uniqueModels.add(value);
    }
  }

  return Array.from(uniqueModels).sort();
}

function getV2ProviderModelSource(providerId) {
  if (PROVIDER_LOCAL_IDS.has(providerId)) return 'runtime';
  return PROVIDER_MODELS[providerId]?.source || 'static';
}

function getConfiguredProviderModels(providerId) {
  const configuredModels = [];
  const configKeys = PROVIDER_MODEL_CONFIG_KEYS[providerId] || [];

  for (const key of configKeys) {
    try {
      const value = serverConfig.get(key);
      if (typeof value === 'string' && value.trim()) {
        configuredModels.push(value.trim());
      }
    } catch {
      // Ignore config lookup failures in discovery helpers.
    }
  }

  const fallback = PROVIDER_MODELS[providerId];
  return normalizeProviderModels([
    ...configuredModels,
    ...(Array.isArray(fallback?.models) ? fallback.models : []),
  ]);
}

function getV2ApprovedProviderModels(providerId) {
  if (providerId !== 'openrouter') {
    return [];
  }

  try {
    const approvedModels = getApprovedModels(providerId, undefined);
    return Array.isArray(approvedModels)
      ? approvedModels.filter((model) => typeof model?.model_name === 'string' && model.model_name.trim())
      : [];
  } catch {
    return [];
  }
}

function getV2ModelDisplayName(modelId) {
  return PROVIDER_MODEL_NAME_OVERRIDES[modelId] || modelId;
}

function getV2ModelParameters(modelId, rawModel = null) {
  const parameters = {};
  const normalizedId = typeof modelId === 'string' ? modelId.trim() : '';
  const parsedParameterCount = parseModelSizeB(normalizedId);
  if (parsedParameterCount > 0) {
    parameters.parameter_count_b = parsedParameterCount;
  }

  const detailParameterSize = rawModel?.details?.parameter_size;
  if (typeof detailParameterSize === 'string') {
    const match = detailParameterSize.match(/(\d+(?:\.\d+)?)\s*b/i);
    if (match) {
      parameters.parameter_count_b = Number.parseFloat(match[1]);
    }
  }

  const registryParameterSize = Number(rawModel?.parameter_size_b);
  if (Number.isFinite(registryParameterSize) && registryParameterSize > 0) {
    parameters.parameter_count_b = registryParameterSize;
  }

  const sizeBytes = Number(rawModel?.size ?? rawModel?.size_bytes);
  if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
    parameters.size_bytes = sizeBytes;
  }

  const family = typeof rawModel?.details?.family === 'string'
    ? rawModel.details.family
    : rawModel?.family;
  if (typeof family === 'string' && family.trim()) {
    parameters.family = family.trim();
  }

  if (typeof rawModel?.details?.quantization_level === 'string' && rawModel.details.quantization_level.trim()) {
    parameters.quantization = rawModel.details.quantization_level.trim();
  }

  return parameters;
}

function buildV2ModelDescriptor(providerId, rawModel, source, refreshedAt) {
  const modelId = typeof rawModel === 'string'
    ? rawModel.trim()
    : typeof rawModel?.model_name === 'string'
      ? rawModel.model_name.trim()
      : typeof rawModel?.id === 'string'
        ? rawModel.id.trim()
        : typeof rawModel?.name === 'string'
          ? rawModel.name.trim()
          : typeof rawModel?.model === 'string'
            ? rawModel.model.trim()
            : '';

  if (!modelId) {
    return null;
  }

  return {
    id: modelId,
    name: getV2ModelDisplayName(modelId),
    provider_id: providerId,
    parameters: getV2ModelParameters(modelId, rawModel),
    source,
    refreshed_at: refreshedAt,
  };
}

function mergeV2ModelDescriptors(descriptors) {
  const merged = new Map();

  for (const descriptor of descriptors) {
    if (!descriptor?.id) continue;

    const existing = merged.get(descriptor.id);
    if (!existing) {
      merged.set(descriptor.id, descriptor);
      continue;
    }

    const existingRefreshedAt = existing.refreshed_at;
    const candidateRefreshedAt = descriptor.refreshed_at;
    const preferredRefreshedAt = (
      candidateRefreshedAt
      && (!existingRefreshedAt || candidateRefreshedAt > existingRefreshedAt)
    )
      ? candidateRefreshedAt
      : existingRefreshedAt;

    merged.set(descriptor.id, {
      ...existing,
      parameters: {
        ...existing.parameters,
        ...descriptor.parameters,
      },
      refreshed_at: preferredRefreshedAt,
    });
  }

  return Array.from(merged.values()).sort((left, right) => left.id.localeCompare(right.id));
}

// ---------------------------------------------------------------------------
// Ollama host probing
// ---------------------------------------------------------------------------

function resolveV2OllamaHosts() {
  try {
    const configuredHosts = Array.isArray(listOllamaHosts?.({ enabled: true }))
      ? listOllamaHosts({ enabled: true })
      : [];

    if (configuredHosts.length > 0) {
      return configuredHosts
        .filter((host) => typeof host?.url === 'string' && host.url.trim())
        .map((host) => ({
          id: host.id,
          name: host.name || host.id || host.url,
          url: host.url.trim(),
        }));
    }
  } catch {
    // Fall through to the single-host configuration path.
  }

  let fallbackUrl = 'http://localhost:11434';
  try {
    const configuredUrl = serverConfig.get('ollama_host');
    if (typeof configuredUrl === 'string' && configuredUrl.trim()) {
      fallbackUrl = configuredUrl.trim();
    }
  } catch {
    // Keep default fallback URL.
  }

  return [{
    id: null,
    name: 'default',
    url: fallbackUrl,
  }];
}

function recordV2OllamaProbeResult(hostId, healthy, models = null) {
  if (!hostId || typeof recordHostHealthCheck !== 'function') {
    return;
  }

  try {
    recordHostHealthCheck(hostId, healthy, models);
  } catch {
    // Health snapshots should not fail the request path.
  }
}

function summarizeV2OllamaProbeFailures(results) {
  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) {
    return null;
  }

  const firstFailure = failures[0];
  const prefix = firstFailure.host?.name || firstFailure.host?.url || 'ollama';
  if (failures.length === 1) {
    return `${prefix}: ${firstFailure.error}`;
  }
  return `${failures.length}/${results.length} Ollama hosts failed; first error from ${prefix}: ${firstFailure.error}`;
}

async function probeV2OllamaHost(host) {
  const result = await probeOllamaEndpoint(host.url);
  recordV2OllamaProbeResult(host.id, result.ok, result.ok ? result.models : null);
  return {
    ...result,
    host,
    checkedAt: new Date().toISOString(),
  };
}

async function getV2ProviderModels(providerId) {
  if (PROVIDER_LOCAL_IDS.has(providerId)) {
    const results = await Promise.all(resolveV2OllamaHosts().map((host) => probeV2OllamaHost(host)));
    const healthyResults = results.filter((result) => result.ok);
    if (healthyResults.length === 0) {
      throw new Error(summarizeV2OllamaProbeFailures(results) || 'No healthy Ollama hosts available');
    }

    const refreshedAt = healthyResults.reduce((latest, result) => {
      if (result.checkedAt && (!latest || result.checkedAt > latest)) {
        return result.checkedAt;
      }
      return latest;
    }, null) || new Date().toISOString();

    const modelDescriptors = mergeV2ModelDescriptors(
      healthyResults.flatMap((result) => result.models)
        .map((model) => buildV2ModelDescriptor(providerId, model, 'runtime', refreshedAt))
        .filter(Boolean),
    );

    return {
      models: modelDescriptors,
      source: 'runtime',
      refreshed_at: refreshedAt,
    };
  }

  const refreshedAt = new Date().toISOString();
  const configuredModels = getConfiguredProviderModels(providerId);

  if (providerId === 'openrouter' && configuredModels.length === 0) {
    const approvedModels = getV2ApprovedProviderModels(providerId);
    if (approvedModels.length > 0) {
      return {
        models: mergeV2ModelDescriptors(
          approvedModels
            .map((model) => buildV2ModelDescriptor(providerId, model, 'registry', refreshedAt))
            .filter(Boolean),
        ),
        source: 'registry',
        refreshed_at: refreshedAt,
      };
    }

    try {
      const adapter = getProviderAdapter(providerId);
      const liveModels = adapter && typeof adapter.listModels === 'function'
        ? await adapter.listModels({ freeOnly: true, toolsOnly: false })
        : [];

      return {
        models: mergeV2ModelDescriptors(
          (Array.isArray(liveModels) ? liveModels : [])
            .map((model) => buildV2ModelDescriptor(providerId, model, 'provider_api_live', refreshedAt))
            .filter(Boolean),
        ),
        source: 'provider_api_live',
        refreshed_at: refreshedAt,
      };
    } catch {
      // Fall through to the static/provider catalog below if live metadata fails.
    }
  }

  const source = getV2ProviderModelSource(providerId);
  const modelDescriptors = mergeV2ModelDescriptors(
    configuredModels
      .map((model) => buildV2ModelDescriptor(providerId, model, source, refreshedAt))
      .filter(Boolean),
  );

  return {
    models: modelDescriptors,
    source,
    refreshed_at: refreshedAt,
  };
}

// ---------------------------------------------------------------------------
// Provider health payload
// ---------------------------------------------------------------------------

function getV2ProviderSuccessRatio(providerStats, runtimeHealth) {
  const totalTasks = Number(providerStats?.total_tasks);
  const successfulTasks = Number(providerStats?.successful_tasks);
  if (Number.isFinite(totalTasks) && totalTasks > 0 && Number.isFinite(successfulTasks)) {
    return Math.max(0, Math.min(1, Number((successfulTasks / totalTasks).toFixed(4))));
  }

  const successes = Number(runtimeHealth?.successes);
  const failures = Number(runtimeHealth?.failures);
  const total = successes + failures;
  if (Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(1, Number((successes / total).toFixed(4))));
  }

  const failureRate = Number(runtimeHealth?.failureRate);
  if (Number.isFinite(failureRate) && failureRate >= 0 && failureRate <= 1) {
    return Math.max(0, Math.min(1, Number((1 - failureRate).toFixed(4))));
  }

  const successRate = Number(providerStats?.success_rate);
  if (Number.isFinite(successRate) && successRate >= 0) {
    const normalized = successRate > 1 ? successRate / 100 : successRate;
    return Math.max(0, Math.min(1, Number(normalized.toFixed(4))));
  }

  return 0;
}

function isV2ProviderApiKeyConfigured(providerId) {
  try {
    const apiKey = typeof serverConfig.getApiKey === 'function'
      ? serverConfig.getApiKey(providerId)
      : null;
    if (typeof apiKey === 'string' && apiKey.trim()) {
      return true;
    }
  } catch {
    // Ignore config lookup failures in discovery helpers.
  }

  const configKeys = PROVIDER_API_KEY_CONFIG_KEYS[providerId] || [];
  for (const key of configKeys) {
    try {
      const value = serverConfig.get(key);
      if (typeof value === 'string' && value.trim()) {
        return true;
      }
    } catch {
      // Ignore config lookup failures in discovery helpers.
    }
  }

  const envKey = API_KEY_ENV_VARS[providerId];
  if (typeof envKey === 'string' && typeof process.env[envKey] === 'string' && process.env[envKey].trim()) {
    return true;
  }

  return false;
}

async function getV2ProviderHealthPayload(provider, providerId) {
  const providerStats = (() => {
    try {
      return getProviderStats ? getProviderStats(providerId, 30) : null;
    } catch {
      return null;
    }
  })();
  const runtimeHealth = getV2ProviderHealth(providerId);
  const avgDurationMs = Number(providerStats?.avg_duration_seconds) > 0
    ? Math.round(Number(providerStats.avg_duration_seconds) * 1000)
    : 0;
  const successRatio = getV2ProviderSuccessRatio(providerStats, runtimeHealth);

  const hasFailures =
    (Number(runtimeHealth?.failures) || 0) > 0 ||
    (Number(providerStats?.failed_tasks) || 0) > 0;

  if (!provider || !provider.enabled) {
    return {
      status: 'disabled',
      latency_ms: avgDurationMs,
      success_ratio: successRatio,
      last_error: null,
      checked_at: new Date().toISOString(),
    };
  }

  if (PROVIDER_LOCAL_IDS.has(providerId)) {
    const results = await Promise.all(resolveV2OllamaHosts().map((host) => probeV2OllamaHost(host)));
    const healthyResults = results.filter((result) => result.ok);
    const checkedAt = results.reduce((latest, result) => {
      if (result.checkedAt && (!latest || result.checkedAt > latest)) {
        return result.checkedAt;
      }
      return latest;
    }, null) || new Date().toISOString();
    const averageLatencyMs = healthyResults.length > 0
      ? Math.round(healthyResults.reduce((sum, result) => sum + result.latencyMs, 0) / healthyResults.length)
      : 0;
    const liveFailure = summarizeV2OllamaProbeFailures(results);

    let status = getV2ProviderStatus(provider, providerId);
    if (healthyResults.length === 0) {
      status = 'unavailable';
    } else if (healthyResults.length !== results.length || status === 'degraded') {
      status = 'degraded';
    } else if (status !== 'unavailable') {
      status = status === 'warning' ? 'warning' : 'healthy';
    }

    return {
      status,
      latency_ms: averageLatencyMs,
      success_ratio: successRatio,
      last_error: liveFailure || (hasFailures ? 'provider has recent failures' : null),
      checked_at: checkedAt,
    };
  }

  const apiKeyConfigured = isV2ProviderApiKeyConfigured(providerId);
  const status = !apiKeyConfigured && PROVIDER_API_KEY_CONFIG_KEYS[providerId]
    ? 'unavailable'
    : getV2ProviderStatus(provider, providerId);

  return {
    status,
    latency_ms: avgDurationMs,
    success_ratio: successRatio,
    last_error: !apiKeyConfigured && PROVIDER_API_KEY_CONFIG_KEYS[providerId]
      ? 'No API key configured'
      : hasFailures
        ? 'provider has recent failures'
        : null,
    checked_at: new Date().toISOString(),
  };
}

module.exports = {
  // Transport
  normalizeV2Transport,
  getV2ProviderTransport,
  // Response envelopes
  sendV2Success,
  sendV2Error,
  buildV2MetaEnvelope,
  sendV2DiscoverySuccess,
  sendV2DiscoveryError,
  sendAuthError,
  // Provider helpers
  getV2ProviderDefaultTimeoutMs,
  getV2ProviderQueueDepth,
  getV2ProviderDefaultProvider,
  getV2ProviderHealth,
  isV2ProviderHealthy,
  getV2ProviderStatus,
  buildV2ProviderLimits,
  getV2ProviderAdapterCapabilities,
  normalizeProviderFeatureList,
  parseConfiguredPositiveInt,
  getV2ProviderMaxContext,
  buildV2ProviderSupportedFormats,
  buildV2ProviderCapabilities,
  buildV2ProviderDescriptor,
  decodeV2ProviderIdOrSendError,
  // Model helpers
  normalizeProviderModels,
  getV2ProviderModelSource,
  getConfiguredProviderModels,
  getV2ApprovedProviderModels,
  getV2ModelDisplayName,
  getV2ModelParameters,
  buildV2ModelDescriptor,
  mergeV2ModelDescriptors,
  // Ollama probing
  resolveV2OllamaHosts,
  recordV2OllamaProbeResult,
  summarizeV2OllamaProbeFailures,
  probeV2OllamaHost,
  getV2ProviderModels,
  // Health
  getV2ProviderSuccessRatio,
  isV2ProviderApiKeyConfigured,
  getV2ProviderHealthPayload,
  // Constants (for external consumers)
  PROVIDER_MODELS,
  PROVIDER_MODEL_CONFIG_KEYS,
  PROVIDER_API_KEY_CONFIG_KEYS,
  PROVIDER_MODEL_NAME_OVERRIDES,
};
