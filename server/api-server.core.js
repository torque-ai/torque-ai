/**
 * TORQUE REST API Server
 *
 * HTTP endpoints that map to MCP tools for external tool integration.
 * Runs alongside the MCP stdio server and dashboard.
 */

const http = require('http');
const { randomUUID } = require('crypto');
const tools = require('./tools');
const { handleToolCall } = tools;
const db = require('./database'); // Phase 3: migrate to container.js init(deps) pattern
const serverConfig = require('./config');
const { API_KEY_ENV_VARS } = serverConfig;
const logger = require('./logger').child({ component: 'api-server' });
const { PROVIDER_DEFAULT_TIMEOUTS, PROVIDER_DEFAULTS } = require('./constants');
const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('./core-tools');
const {
  getProviderAdapter,
  getProviderCapabilityMatrix,
} = require('./providers/adapter-registry');
const { parseModelSizeB } = require('./utils/model');
const { probeOllamaEndpoint } = require('./handlers/shared');
const remoteAgentHandlers = require('./handlers/remote-agent-handlers');
const middleware = require('./api/middleware');
const routes = require('./api/routes');
const { generateOpenApiSpec } = require('./api/openapi-generator');
const { createHealthRoutes } = require('./api/health');
const { createV2Router, V2_PROVIDER_ROUTE_HANDLER_NAMES } = require('./api/v2-router');
const { normalizeError } = require('./api/v2-middleware');
const v2Inference = require('./api/v2-inference');
const v2TaskHandlers = require('./api/v2-task-handlers');
const v2WorkflowHandlers = require('./api/v2-workflow-handlers');
const eventBus = require('./event-bus');
const v2GovernanceHandlers = require('./api/v2-governance-handlers');
const v2AnalyticsHandlers = require('./api/v2-analytics-handlers');
const v2InfrastructureHandlers = require('./api/v2-infrastructure-handlers');
const webhooks = require('./api/webhooks');

const {
  createRateLimiter,
  getRateLimit,
  checkRateLimit,
  startRateLimitCleanup,
  stopRateLimitCleanup,
  parseBody,
  sendJson,
  parseQuery,
  applyMiddleware,
  DEFAULT_RATE_WINDOW_MS,
  SECURITY_HEADERS,
} = middleware;
const { handleInboundWebhook, verifyWebhookSignature, substitutePayload, setFreeTierTrackerGetter: setWebhookFreeTierTrackerGetter } = webhooks;
const { handleHealthz, handleReadyz, handleLivez } = require('./api/health-probes');
const authMiddleware = require('./auth/middleware');

let apiServer = null;
let apiPort = 3457;


const V2_RATE_POLICIES = new Set(['enforced', 'disabled']);
const DEFAULT_V2_RATE_LIMIT = 120;
let v2RateLimiter = null;
let v2RateLimit = null;

function getV2RatePolicy() {
  try {
    const configuredPolicy = (serverConfig.get('v2_rate_policy', 'enforced')).toLowerCase().trim();
    return V2_RATE_POLICIES.has(configuredPolicy) ? configuredPolicy : 'enforced';
  } catch {
    return 'enforced';
  }
}

function getV2RateLimitConfig() {
  try {
    const configValue = serverConfig.getInt('v2_rate_limit', 0);
    if (configValue > 0) return configValue;
  } catch {
    // No-op
  }
  return DEFAULT_V2_RATE_LIMIT;
}

function getV2RateLimiter() {
  const limit = getV2RateLimitConfig();
  if (v2RateLimit === limit && v2RateLimiter) {
    return v2RateLimiter;
  }

  v2RateLimiter = createRateLimiter(limit, DEFAULT_RATE_WINDOW_MS);
  v2RateLimit = limit;
  return v2RateLimiter;
}

/**
 * Resolve a request ID from incoming headers or generate a new one.
 */
function resolveRequestId(req) {
  const headerValue = req.headers["x-request-id"];
  if (Array.isArray(headerValue)) {
    const first = headerValue.find(value => typeof value === "string" && value.trim());
    if (first) return first.trim();
  } else if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  return randomUUID();
}

// ============================================
// Request / Response helpers
// ============================================

// v2 Provider Discovery — consolidated in api/v2-provider-registry.js
const {
  DEFAULT_REQUEST_RATE_PER_MINUTE,
  PROVIDER_REGISTRY,
  PROVIDER_LOCAL_IDS,
  V2_TRANSPORTS,
} = require('./api/v2-provider-registry');

function normalizeV2Transport(rawTransport) {
  if (typeof rawTransport !== 'string') return null;
  const transport = rawTransport.trim().toLowerCase();
  return V2_TRANSPORTS.has(transport) ? transport : null;
}

function getV2ProviderTransport(provider) {
  const explicit = normalizeV2Transport(provider?.transport);
  if (explicit) return explicit;
  if (provider?.provider === 'codex') return 'hybrid';
  if (provider?.provider === 'claude-cli') return 'cli';
  return 'api';
}

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
    models: ['llama-3.1-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  },
  'cerebras': {
    source: 'provider_api',
    models: ['llama3.1-8b', 'qwen-3-235b-a22b-instruct-2507', 'gpt-oss-120b', 'zai-glm-4.7'],
  },
  'ollama-cloud': {
    source: 'provider_api',
    models: [
      'qwen3-coder:480b', 'deepseek-v3.1:671b', 'deepseek-v3.2',
      'gpt-oss:120b', 'gpt-oss:20b', 'kimi-k2:1t', 'kimi-k2.5',
      'qwen3-coder-next', 'devstral-2:123b', 'mistral-large-3:675b',
    ],
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
    models: [
      'qwen/qwen3-coder:free', 'openai/gpt-oss-120b:free',
      'openai/gpt-oss-20b:free', 'qwen/qwen3-next-80b-a3b-instruct:free',
      'mistralai/mistral-small-3.1-24b-instruct:free', 'google/gemma-3-12b-it:free',
    ],
  },
  deepinfra: {
    source: 'provider_api',
    models: [
      'Qwen/Qwen2.5-72B-Instruct',
      'meta-llama/Llama-3.1-70B-Instruct',
      'meta-llama/Llama-3.1-405B-Instruct',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen2.5-Coder-32B-Instruct',
    ],
  },
  hyperbolic: {
    source: 'provider_api',
    models: [
      'Qwen/Qwen2.5-72B-Instruct',
      'meta-llama/Llama-3.1-70B-Instruct',
      'meta-llama/Llama-3.1-405B-Instruct',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen3-Coder-480B-A35B',
    ],
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

function sendV2Success(res, requestId, payload, status = 200, req = null) {
  sendJson(res, {
    ...payload,
    request_id: requestId,
  }, status, req);
}

function sendV2Error(res, requestId, code, message, status = 400, details = {}, req = null) {
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
    return Number(db.countTasks({ provider: providerId, status: 'queued' })) || 0;
  } catch {
    return 0;
  }
}

function getV2ProviderDefaultProvider() {
  try {
    return db.getDefaultProvider();
  } catch {
    return null;
  }
}

function getV2ProviderHealth(providerId) {
  try {
    return db.getProviderHealth(providerId);
  } catch {
    return { successes: 0, failures: 0, failureRate: 0 };
  }
}

function isV2ProviderHealthy(providerId) {
  try {
    return db.isProviderHealthy(providerId);
  } catch {
    return true;
  }
}

function getV2ProviderStatus(provider, providerId) {
  if (!provider || !provider.enabled) return 'disabled';

  const health = getV2ProviderHealth(providerId);
  const total = (health?.successes ?? 0) + (health?.failures ?? 0);

  if (total >= 3 && !isV2ProviderHealthy(providerId)) {
    return 'unavailable';
  }
  if (health && (health.failures || 0) > 0) {
    return 'degraded';
  }
  return 'healthy';
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
    if (model && typeof model === 'object' && typeof model.name === 'string') {
      const value = model.name.trim();
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

  const sizeBytes = Number(rawModel?.size);
  if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
    parameters.size_bytes = sizeBytes;
  }

  if (typeof rawModel?.details?.family === 'string' && rawModel.details.family.trim()) {
    parameters.family = rawModel.details.family.trim();
  }

  if (typeof rawModel?.details?.quantization_level === 'string' && rawModel.details.quantization_level.trim()) {
    parameters.quantization = rawModel.details.quantization_level.trim();
  }

  return parameters;
}

function buildV2ModelDescriptor(providerId, rawModel, source, refreshedAt) {
  const modelId = typeof rawModel === 'string'
    ? rawModel.trim()
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

function resolveV2OllamaHosts() {
  try {
    const configuredHosts = Array.isArray(db.listOllamaHosts?.({ enabled: true }))
      ? db.listOllamaHosts({ enabled: true })
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
  if (!hostId || typeof db.recordHostHealthCheck !== 'function') {
    return;
  }

  try {
    db.recordHostHealthCheck(hostId, healthy, models);
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
  const source = getV2ProviderModelSource(providerId);
  const modelDescriptors = mergeV2ModelDescriptors(
    getConfiguredProviderModels(providerId)
      .map((model) => buildV2ModelDescriptor(providerId, model, source, refreshedAt))
      .filter(Boolean),
  );

  return {
    models: modelDescriptors,
    source,
    refreshed_at: refreshedAt,
  };
}

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
      return db.getProviderStats ? db.getProviderStats(providerId, 30) : null;
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
      status = 'healthy';
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

function normalizeMessageContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content.trim();
  if (typeof content === 'number' || typeof content === 'boolean') return String(content).trim();
  return '';
}

function formatV2InferenceResult(result) {
  if (result === null || result === undefined) {
    return {
      type: 'text',
      content: '',
      meta: {},
    };
  }

  if (typeof result === 'string') {
    return {
      type: 'text',
      content: result,
      meta: {},
    };
  }

  if (typeof result === 'number' || typeof result === 'boolean') {
    return {
      type: 'text',
      content: String(result),
      meta: {},
    };
  }

  if (Array.isArray(result) || typeof result === 'object') {
    return {
      type: 'json',
      content: JSON.stringify(result),
      meta: {},
    };
  }

  return {
    type: 'text',
    content: String(result),
    meta: {},
  };
}

function normalizeV2InferenceStatus(rawStatus) {
  const status = (rawStatus || 'unknown').toLowerCase();
  if (status === 'queued' || status === 'running' || status === 'completed' || status === 'failed' || status === 'cancelled') {
    return status;
  }

  if (status === 'timeout' || status === 'error' || status === 'errored') {
    return 'failed';
  }

  if (status === 'success') {
    return 'completed';
  }

  return 'completed';
}

function normalizeV2ProviderUsage(rawUsage) {
  const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage : {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? usage.tokens ?? (inputTokens + outputTokens));
  const elapsedMs = Number(
    usage.elapsed_ms ?? usage.duration_ms ?? usage.duration ?? usage.time_ms ?? usage.time ?? 0,
  );

  return {
    input_tokens: Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens) && totalTokens >= 0 ? totalTokens : 0,
    elapsed_ms: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0,
  };
}

function getV2TaskRouteMetadata(task = {}) {
  const metadata = task.metadata || {};
  const normalizedAttempts = normalizeV2AttemptMetadata(metadata.attempts);
  return {
    transport: typeof metadata.transport === 'string' ? metadata.transport : null,
    route_reason: metadata.route_reason || null,
    attempts: normalizedAttempts,
    retry_count: getV2RetryCount(normalizedAttempts),
  };
}

function safeParseTaskStorageValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function buildV2TaskPayload(task, requestId, statusOverride = null) {
  const normalizedTask = task || {};
  const parsedOutput = safeParseTaskStorageValue(normalizedTask.output);
  const providerResult = (parsedOutput && typeof parsedOutput === 'object') ? parsedOutput : {};
  const normalizedStatus = normalizeV2InferenceStatus(
    statusOverride || normalizedTask.status || 'completed',
  );
  const providerOutput = providerResult.output ?? providerResult.result ?? providerResult.text ?? '';
  const usage = normalizeV2ProviderUsage(providerResult.usage || {});
  const routeMetadata = getV2TaskRouteMetadata(normalizedTask);

  return {
    task_id: normalizedTask.id || null,
    status: normalizedStatus,
    provider: normalizedTask.provider || null,
    model: normalizedTask.model || null,
    result: formatV2InferenceResult(providerOutput),
    usage,
    raw: providerResult,
    transport: routeMetadata.transport,
    route_reason: routeMetadata.route_reason,
    attempts: routeMetadata.attempts,
    retry_count: routeMetadata.retry_count,
    request_id: requestId,
  };
}

function sendV2SseHeaders(res, req = null) {
  const dashboardPort = serverConfig.getPort('dashboard') || 3456;
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': `http://127.0.0.1:${dashboardPort}`,
    'Access-Control-Allow-Headers': 'Content-Type, X-Torque-Key, X-Request-ID',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...SECURITY_HEADERS,
  };
  if (req?._rateLimit) {
    headers['X-RateLimit-Limit'] = String(req._rateLimit.limit);
    headers['X-RateLimit-Remaining'] = String(req._rateLimit.remaining);
    headers['X-RateLimit-Reset'] = String(req._rateLimit.reset);
  }
  res.writeHead(200, headers);
}

function sendV2SseEvent(res, eventName, eventData) {
  const payload = typeof eventData === 'string' ? eventData : JSON.stringify(eventData || {});
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${payload}\n\n`);
}

function resolveV2Task(taskId) {
  try {
    return db.getTask(taskId);
  } catch (err) {
    if (String(err.message || '').includes('Task not found')
      || String(err.message || '').includes('Ambiguous task ID')) {
      return null;
    }
    throw err;
  }
}

function getV2TaskStatusRow(taskId) {
  return resolveV2Task(taskId);
}

function recordV2TaskEvent(taskId, eventType, oldValue, newValue, eventData = {}) {
  try {
    db.recordTaskEvent(taskId, eventType, oldValue, newValue, eventData);
  } catch (_err) {
    void _err;
  }
}

function collectValidationError(errors, field, code, message) {
  errors.push({
    field,
    code,
    message,
  });
}

function getV2PromptMessages(payload) {
  const hasPrompt = Object.prototype.hasOwnProperty.call(payload, 'prompt');
  const hasMessages = Object.prototype.hasOwnProperty.call(payload, 'messages');
  return { hasPrompt, hasMessages, prompt: payload.prompt, messages: payload.messages };
}

function validateV2PromptMessages(payload, errors) {
  const { hasPrompt, hasMessages, prompt, messages } = getV2PromptMessages(payload);
  if (!hasPrompt && !hasMessages) {
    collectValidationError(errors, 'messages', 'missing', 'Either prompt or messages is required');
    return;
  }

  if (hasPrompt && hasMessages) {
    collectValidationError(errors, 'messages', 'ambiguous', 'Provide either prompt or messages, not both');
    return;
  }

  if (hasPrompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      collectValidationError(errors, 'prompt', 'type', '`prompt` must be a non-empty string');
    }
    return;
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    collectValidationError(errors, 'messages', 'type', '`messages` must be a non-empty array');
    return;
  }

  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== 'object') {
      collectValidationError(errors, `messages[${index}]`, 'type', 'Each message must be an object');
      continue;
    }
    const role = typeof message.role === 'string' ? message.role.trim() : '';
    const content = normalizeMessageContent(message.content);

    if (!role) {
      collectValidationError(errors, `messages[${index}].role`, 'type', 'Each message requires a non-empty role');
    }
    if (!content) {
      collectValidationError(errors, `messages[${index}].content`, 'type', 'Each message requires non-empty content');
    }
  }
}

function validateV2StringField(payload, field, errors, maxLength = 255) {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) {
    return;
  }

  if (typeof payload[field] !== 'string' || !payload[field].trim()) {
    collectValidationError(errors, field, 'type', `\`${field}\` must be a non-empty string`);
    return;
  }

  if (payload[field].length > maxLength) {
    collectValidationError(errors, field, 'length', `\`${field}\` must be no longer than ${maxLength} characters`);
  }
}

function validateV2BooleanField(payload, field, errors) {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) {
    return;
  }
  if (typeof payload[field] !== 'boolean') {
    collectValidationError(errors, field, 'type', `\`${field}\` must be a boolean`);
  }
}

function validateV2TimeoutMs(payload, errors) {
  if (!Object.prototype.hasOwnProperty.call(payload, 'timeout_ms')) {
    return;
  }

  const timeout = payload.timeout_ms;
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout)) {
    collectValidationError(errors, 'timeout_ms', 'type', '`timeout_ms` must be an integer');
    return;
  }
  if (timeout <= 0 || timeout > 1800000) {
    collectValidationError(errors, 'timeout_ms', 'range', '`timeout_ms` must be between 1 and 1800000');
  }
}

function getV2DefaultProviderForRequest(payload) {
  if (typeof payload.provider === 'string' && payload.provider.trim()) {
    return payload.provider.trim();
  }
  return getV2ProviderDefaultProvider();
}

function validateV2Transport(payload, errors) {
  if (!Object.prototype.hasOwnProperty.call(payload, 'transport')) {
    return;
  }

  const transport = normalizeV2Transport(payload.transport);
  if (!transport) {
    collectValidationError(errors, 'transport', 'value', '`transport` must be one of: api, cli, hybrid');
  }
}

function getAttemptElapsedMs(startAt, endAt) {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  const elapsed = end - start;
  return elapsed >= 0 ? elapsed : 0;
}

function normalizeV2AttemptMetadata(attempts) {
  return (Array.isArray(attempts) ? attempts : [])
    .map((attempt, index) => ({
      provider: attempt?.provider || null,
      transport: normalizeV2Transport(attempt?.transport) || null,
      reason: attempt?.reason || null,
      status: attempt?.status || 'not_attempted',
      error: attempt?.error || null,
      attempt_start_at: typeof attempt?.attempt_start_at === 'string' ? attempt.attempt_start_at : null,
      attempt_end_at: typeof attempt?.attempt_end_at === 'string' ? attempt.attempt_end_at : null,
      attempt_elapsed_ms:
        attempt?.attempt_elapsed_ms ?? getAttemptElapsedMs(attempt?.attempt_start_at, attempt?.attempt_end_at),
      failure_reason: attempt?.failure_reason || null,
      index,
    }))
    .filter((attempt) => attempt.provider && attempt.transport);
}

function getV2RetryCount(attempts) {
  const normalized = normalizeV2AttemptMetadata(attempts);
  return normalized.reduce((total, attempt) => {
    if (attempt.status === 'failed') {
      return total + 1;
    }
    return total;
  }, 0);
}

function validateV2InferencePayload(payload) {
  const errors = [];
  const normalizedPayload = payload || {};

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    collectValidationError(errors, 'body', 'type', 'Request body must be an object');
    return { valid: false, errors, payload: normalizedPayload };
  }

  validateV2PromptMessages(payload, errors);
  validateV2StringField(payload, 'provider', errors, 64);
  validateV2StringField(payload, 'model', errors, 255);
  validateV2BooleanField(payload, 'stream', errors);
  validateV2BooleanField(payload, 'async', errors);
  validateV2Transport(payload, errors);
  validateV2TimeoutMs(payload, errors);

  if (errors.length) {
    return {
      valid: false,
      errors,
      payload: normalizedPayload,
    };
  }

  const resolvedProvider = getV2DefaultProviderForRequest(payload);
  if (!resolvedProvider) {
    collectValidationError(errors, 'provider', 'missing', 'A provider is required or default provider must be configured');
    return { valid: false, errors, payload: normalizedPayload };
  }

  return {
    valid: true,
    errors,
    payload: normalizedPayload,
    provider: resolvedProvider,
    transport: normalizeV2Transport(payload.transport),
  };
}

// Initialize v2-inference module with shared dependencies
v2Inference.init({
  db,
  logger,
  getProviderAdapter,
  normalizeV2Transport,
  getV2ProviderTransport,
  getV2ProviderDefaultTimeoutMs,
  normalizeMessageContent,
  formatV2InferenceResult,
  normalizeV2InferenceStatus,
  normalizeV2ProviderUsage,
  normalizeV2AttemptMetadata,
  getV2RetryCount,
  getAttemptElapsedMs,
  getV2ProviderAdapterCapabilities,
  sendV2SseHeaders,
  sendV2SseEvent,
  getV2TaskStatusRow,
  recordV2TaskEvent,
  sendV2Success,
  sendV2Error,
});

const { executeV2ProviderInference } = v2Inference;

// Module-level taskManager reference for v2 inference cancel handler.
// Set by createApiServer() when a taskManager is provided.
let _v2TaskManager = null;

async function handleV2TaskStatus(_req, res, context = {}, taskId = null, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const resolvedTaskId = req?.params?.task_id || taskId;
  const taskRow = getV2TaskStatusRow(resolvedTaskId);

  if (!taskRow) {
    sendV2Error(
      res,
      requestId,
      'task_not_found',
      `Task not found: ${resolvedTaskId}`,
      404,
      {},
      req,
    );
    return;
  }

  sendV2Success(res, requestId, buildV2TaskPayload(taskRow, requestId), 200, req);
}

async function handleV2TaskCancel(_req, res, context = {}, taskId = null, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const resolvedTaskId = req?.params?.task_id || taskId;
  const taskRow = getV2TaskStatusRow(resolvedTaskId);

  if (!taskRow) {
    sendV2Error(
      res,
      requestId,
      'task_not_found',
      `Task not found: ${resolvedTaskId}`,
      404,
      {},
      req,
    );
    return;
  }

  if (taskRow.status === 'completed' || taskRow.status === 'failed' || taskRow.status === 'cancelled') {
    sendV2Error(
      res,
      requestId,
      'task_already_terminal',
      `Task is already in terminal state: ${taskRow.status}`,
      409,
      {
        task_id: taskRow.id,
        status: normalizeV2InferenceStatus(taskRow.status),
      },
      req,
    );
    return;
  }

  try {
    if (_v2TaskManager) {
      _v2TaskManager.cancelTask(taskRow.id, 'Task cancelled by request');
    } else {
      db.updateTaskStatus(taskRow.id, 'cancelled', {
        error_output: 'Task cancelled by request',
      });
    }
    recordV2TaskEvent(taskRow.id, 'status', taskRow.status, 'cancelled', {
      request_id: requestId,
    });
  } catch (err) {
    sendV2Error(
      res,
      requestId,
      'cancellation_failed',
      err.message || 'Failed to cancel task',
      500,
      {},
      req,
    );
    return;
  }

  const cancelledRow = getV2TaskStatusRow(resolvedTaskId);
  sendV2Success(
    res,
    requestId,
    {
      task_id: taskRow.id,
      status: normalizeV2InferenceStatus(cancelledRow?.status || 'cancelled'),
      provider: taskRow.provider,
      model: taskRow.model,
      cancelled: true,
    },
    200,
    req,
  );
}

async function handleV2TaskEvents(_req, res, context = {}, taskId = null, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const resolvedTaskId = req?.params?.task_id || taskId;
  const taskRow = getV2TaskStatusRow(resolvedTaskId);

  if (!taskRow) {
    sendV2Error(
      res,
      requestId,
      'task_not_found',
      `Task not found: ${resolvedTaskId}`,
      404,
      {},
      req,
    );
    return;
  }

  sendV2SseHeaders(res, req);

  try {
    const taskEvents = db.getTaskEvents(taskRow.id, { limit: 100 }) || [];
    const rows = Array.isArray(taskEvents) ? taskEvents : [];
    const latestTaskPayload = buildV2TaskPayload(taskRow, requestId);
    const terminalStates = new Set(['completed', 'failed', 'cancelled']);

    if (rows.length === 0) {
      sendV2SseEvent(res, 'status', {
        request_id: requestId,
        status: latestTaskPayload.status || 'queued',
      });
      return;
    }

    for (const eventRow of rows.slice().reverse()) {
      const eventData = safeParseTaskStorageValue(eventRow.event_data);
      const targetStatus = normalizeV2InferenceStatus(eventRow.new_value || eventRow.old_value || taskRow.status);

      if (terminalStates.has(targetStatus)) {
        if (targetStatus === 'completed') {
          sendV2SseEvent(res, 'completion', {
            request_id: requestId,
            status: targetStatus,
            result: latestTaskPayload.result,
            usage: latestTaskPayload.usage,
          });
        } else {
          sendV2SseEvent(res, 'error', {
            request_id: requestId,
            error: {
              code: 'provider_unavailable',
              message: eventData?.error || taskRow.error_output || 'Async inference failed',
              details: eventData || {},
            },
          });
        }
        break;
      }

      sendV2SseEvent(res, 'status', {
        request_id: requestId,
        status: targetStatus,
      });
    }
  } finally {
    res.end();
  }
}

async function handleV2Inference(_req, res, context = {}, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  try {
    const validatedPayload = req?.validated?.body;
    const payload = validatedPayload || await parseBody(_req);
    const validation = validatedPayload
      ? { valid: true, payload: validatedPayload, provider: validatedPayload.provider }
      : validateV2InferencePayload(payload);

    if (!validation.valid) {
      sendV2Error(
        res,
        requestId,
        'validation_error',
        'Request validation failed',
        400,
        { errors: validation.errors },
        req,
      );
      return;
    }

    const providerId = validation.provider;
    const provider = providerId ? db.getProvider?.(providerId) : null;
    if (!provider) {
      sendV2Error(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${providerId}`,
        404,
        { provider: providerId },
        req,
      );
      return;
    }

    await executeV2ProviderInference({
      requestId,
      payload: validation.payload,
      providerId,
      req,
      res,
    });
  } catch (err) {
    if (err?.message === 'Invalid JSON' || err?.message === 'Request body too large') {
      sendV2Error(
        res,
        requestId,
        'validation_error',
        err.message,
        400,
        { context: 'request_body' },
        req,
      );
      return;
    }
    sendV2Error(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_inference' },
      req,
    );
  }
}

async function handleV2ProviderInference(_req, res, context = {}, providerId, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const decodedProviderId = req?.params?.provider_id || decodeURIComponent(providerId || '');

  try {
    const validatedPayload = req?.validated?.body;
    const payload = validatedPayload || await parseBody(_req);
    const payloadForValidation = validatedPayload
      ? null
      : {
        ...payload,
        provider: payload?.provider || decodedProviderId,
      };
    const validation = validatedPayload
      ? {
        valid: true,
        payload: {
          ...validatedPayload,
          provider: decodedProviderId,
        },
      }
      : validateV2InferencePayload(payloadForValidation);
    if (!validation.valid) {
      sendV2Error(
        res,
        requestId,
        'validation_error',
        'Request validation failed',
        400,
        { errors: validation.errors },
        req,
      );
      return;
    }

    const provider = db.getProvider?.(decodedProviderId);
    if (!provider) {
      sendV2Error(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${decodedProviderId}`,
        404,
        { provider: decodedProviderId },
        req,
      );
      return;
    }

    await executeV2ProviderInference({
      requestId,
      payload: validation.payload,
      providerId: decodedProviderId,
      req,
      res,
    });
  } catch (err) {
    if (err?.message === 'Invalid JSON' || err?.message === 'Request body too large') {
      sendV2Error(
        res,
        requestId,
        'validation_error',
        err.message,
        400,
        { context: 'request_body' },
        req,
      );
      return;
    }
    sendV2Error(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_inference' },
      req,
    );
  }
}

async function handleV2ProviderModels(_req, res, context = {}, providerId, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const decodedProviderId = req?.params?.provider_id || decodeV2ProviderIdOrSendError(
    providerId,
    requestId,
    res,
    req,
    'provider_models',
  );
  if (!decodedProviderId) {
    return;
  }

  try {
    const provider = db.getProvider?.(decodedProviderId);
    if (!provider) {
      sendV2DiscoveryError(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${decodedProviderId}`,
        404,
        { provider_id: decodedProviderId },
        req,
      );
      return;
    }

    const modelsDescriptor = await getV2ProviderModels(decodedProviderId);
    const responsePayload = {
      provider_id: decodedProviderId,
      models: modelsDescriptor.models,
      refreshed_at: modelsDescriptor.refreshed_at,
    };

    sendV2DiscoverySuccess(
      res,
      requestId,
      responsePayload,
      200,
      req,
      {
        provider_id: decodedProviderId,
        models: modelsDescriptor.models.map((model) => model.id),
        source: modelsDescriptor.source,
        freshness: modelsDescriptor.refreshed_at ? { checked_at: modelsDescriptor.refreshed_at } : null,
        model_count: modelsDescriptor.models.length,
      },
    );
  } catch (err) {
    sendV2DiscoveryError(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_models', provider_id: decodedProviderId },
      req,
    );
  }
}

async function handleV2ProviderHealth(_req, res, context = {}, providerId, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const decodedProviderId = req?.params?.provider_id || decodeV2ProviderIdOrSendError(
    providerId,
    requestId,
    res,
    req,
    'provider_health',
  );
  if (!decodedProviderId) {
    return;
  }

  try {
    const provider = db.getProvider?.(decodedProviderId);
    if (!provider) {
      sendV2DiscoveryError(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${decodedProviderId}`,
        404,
        { provider_id: decodedProviderId },
        req,
      );
      return;
    }

    const healthPayload = await getV2ProviderHealthPayload(provider, decodedProviderId);
    const responsePayload = {
      provider_id: decodedProviderId,
      ...healthPayload,
    };

    sendV2DiscoverySuccess(
      res,
      requestId,
      responsePayload,
      200,
      req,
      responsePayload,
    );
  } catch (err) {
    sendV2DiscoveryError(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_health', provider_id: decodedProviderId },
      req,
    );
  }
}

async function handleV2ListProviders(_req, res, context = {}, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  try {
    const providers = Array.isArray(db.listProviders?.()) ? db.listProviders() : [];
    const defaultProviderId = getV2ProviderDefaultProvider();
    const descriptors = providers.map(provider => buildV2ProviderDescriptor(provider, defaultProviderId)).filter(Boolean);

    sendV2DiscoverySuccess(
      res,
      requestId,
      { providers: descriptors },
      200,
      req,
      { providers: descriptors },
    );
  } catch (err) {
    sendV2DiscoveryError(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_catalog' },
      req,
    );
  }
}

function handleV2ProviderCapabilities(_req, res, context = {}, providerId, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const decodedProviderId = req?.params?.provider_id || decodeV2ProviderIdOrSendError(
    providerId,
    requestId,
    res,
    req,
    'provider_capabilities',
  );
  if (!decodedProviderId) {
    return;
  }

  try {
    const provider = db.getProvider?.(decodedProviderId);
    if (!provider) {
      sendV2DiscoveryError(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${decodedProviderId}`,
        404,
        { provider_id: decodedProviderId },
        req,
      );
      return;
    }

    const capabilities = buildV2ProviderCapabilities(decodedProviderId);
    sendV2DiscoverySuccess(
      res,
      requestId,
      {
        provider_id: decodedProviderId,
        capabilities,
      },
      200,
      req,
      {
        provider_id: decodedProviderId,
        capabilities,
      },
    );
  } catch (err) {
    sendV2DiscoveryError(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_capabilities' },
      req,
    );
  }
}

function handleV2ProviderDetail(_req, res, context = {}, providerId, req = null) {
  const requestId = context.requestId || req?.requestId || randomUUID();
  const decodedProviderId = req?.params?.provider_id || decodeV2ProviderIdOrSendError(
    providerId,
    requestId,
    res,
    req,
    'provider_detail',
  );
  if (!decodedProviderId) {
    return;
  }

  try {
    const provider = db.getProvider?.(decodedProviderId);
    if (!provider) {
      sendV2DiscoveryError(
        res,
        requestId,
        'provider_not_found',
        `Provider not found: ${decodedProviderId}`,
        404,
        { provider_id: decodedProviderId },
        req,
      );
      return;
    }

    const defaultProviderId = getV2ProviderDefaultProvider();
    const descriptor = buildV2ProviderDescriptor(provider, defaultProviderId, {
      includeCapabilities: true,
    });
    sendV2DiscoverySuccess(
      res,
      requestId,
      { provider: descriptor || {} },
      200,
      req,
      descriptor || {},
    );
  } catch (err) {
    sendV2DiscoveryError(
      res,
      requestId,
      'provider_unavailable',
      err.message,
      500,
      { context: 'provider_detail' },
      req,
    );
  }
}

function isRemoteExecutionCoreError(result) {
  return Boolean(result && typeof result.error_code === 'string');
}

function getRemoteExecutionErrorStatus(result) {
  switch (result?.error_code) {
    case 'MISSING_REQUIRED_PARAM':
    case 'INVALID_PARAM':
      return 400;
    default:
      return 500;
  }
}

function serializeRemoteExecutionResult(result) {
  return {
    success: Boolean(result?.success),
    output: typeof result?.output === 'string' ? result.output : '',
    exitCode: Number.isFinite(result?.exitCode) ? result.exitCode : 0,
    durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : 0,
    remote: Boolean(result?.remote),
    warning: typeof result?.warning === 'string' && result.warning.trim()
      ? result.warning
      : null,
  };
}

async function handleV2RemoteRun(req, res, _context = {}) {
  const body = Object.prototype.hasOwnProperty.call(req, 'body')
    ? req.body
    : await parseBody(req);
  const result = await remoteAgentHandlers.runRemoteCommandCore(body || {});

  if (isRemoteExecutionCoreError(result)) {
    sendJson(res, {
      error: result.error,
      errorCode: result.error_code,
    }, getRemoteExecutionErrorStatus(result), req);
    return;
  }

  sendJson(res, serializeRemoteExecutionResult(result), 200, req);
}

async function handleV2RemoteTest(req, res, _context = {}) {
  const body = Object.prototype.hasOwnProperty.call(req, 'body')
    ? req.body
    : await parseBody(req);
  const result = await remoteAgentHandlers.runTestsCore(body || {});

  if (isRemoteExecutionCoreError(result)) {
    sendJson(res, {
      error: result.error,
      errorCode: result.error_code,
    }, getRemoteExecutionErrorStatus(result), req);
    return;
  }

  sendJson(res, serializeRemoteExecutionResult(result), 200, req);
}

// ============================================
// Auth: ticket exchange
// ============================================

async function handleCreateTicket(req, res, _context = {}) {
  const keyManager = require('./auth/key-manager');
  const ticketManager = require('./auth/ticket-manager');

  // Extract Bearer token from Authorization header
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const apiKey = bearerMatch ? bearerMatch[1] : null;

  if (!apiKey) {
    sendJson(res, { error: 'Authorization header with Bearer token required' }, 401, req);
    return;
  }

  const identity = keyManager.validateKey(apiKey);
  if (!identity) {
    sendJson(res, { error: 'Invalid API key' }, 401, req);
    return;
  }

  try {
    const ticket = ticketManager.createTicket(identity);
    sendJson(res, { ticket }, 200, req);
  } catch (err) {
    // Ticket cap reached
    sendJson(res, { error: err.message }, 503, req);
  }
}

// ============================================
// Auth: key management REST handlers
// ============================================

async function handleCreateApiKey(req, res, _context = {}) {
  const keyManager = require('./auth/key-manager');
  const authMiddleware = require('./auth/middleware');

  // Only admin may create keys
  const identity = authMiddleware.authenticate(req);
  if (!identity || identity.role !== 'admin') {
    sendJson(res, { error: 'Forbidden — admin role required' }, 403, req);
    return;
  }

  try {
    const body = Object.prototype.hasOwnProperty.call(req, 'body')
      ? req.body
      : await parseBody(req);
    const { name, role } = body || {};
    if (!name) {
      sendJson(res, { error: '`name` is required' }, 400, req);
      return;
    }
    const result = keyManager.createKey({ name, role });
    sendJson(res, { id: result.id, key: result.key, name: result.name, role: result.role }, 201, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 400, req);
  }
}

async function handleListApiKeys(req, res, _context = {}) {
  const keyManager = require('./auth/key-manager');
  const authMiddleware = require('./auth/middleware');

  // Only admin may list keys
  const identity = authMiddleware.authenticate(req);
  if (!identity || identity.role !== 'admin') {
    sendJson(res, { error: 'Forbidden — admin role required' }, 403, req);
    return;
  }

  try {
    const keys = keyManager.listKeys();
    sendJson(res, { keys }, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, req);
  }
}

async function handleRevokeApiKey(req, res, _context = {}) {
  const keyManager = require('./auth/key-manager');
  const authMiddleware = require('./auth/middleware');

  // Only admin may revoke keys
  const identity = authMiddleware.authenticate(req);
  if (!identity || identity.role !== 'admin') {
    sendJson(res, { error: 'Forbidden — admin role required' }, 403, req);
    return;
  }

  const key_id = req.params?.key_id;
  if (!key_id) {
    sendJson(res, { error: '`key_id` is required' }, 400, req);
    return;
  }

  try {
    keyManager.revokeKey(key_id);
    sendJson(res, { success: true }, 200, req);
  } catch (err) {
    const status = err.message === 'Key not found' ? 404 : 400;
    sendJson(res, { error: err.message }, status, req);
  }
}

async function handleDashboardLogin(req, res, _context = {}) {
  const keyManager = require('./auth/key-manager');
  const sessionManager = require('./auth/session-manager');
  const { loginLimiter } = require('./auth/rate-limiter');

  const ip = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';

  // Rate limit check
  if (loginLimiter.isLimited(ip)) {
    sendJson(res, { error: 'Too many login attempts. Please try again later.' }, 429, req);
    return;
  }

  try {
    const body = Object.prototype.hasOwnProperty.call(req, 'body')
      ? req.body
      : await parseBody(req);
    const { key } = body || {};

    // Open mode: no keys configured — auto-login as admin
    if (!keyManager.hasAnyKeys()) {
      const identity = { id: 'open-mode', name: 'Open Mode', role: 'admin' };
      const { sessionId, csrfToken } = sessionManager.createSession(identity);
      res.setHeader('Set-Cookie', [
        `torque_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
        `torque_csrf=${csrfToken}; SameSite=Strict; Path=/`,
      ]);
      sendJson(res, { success: true, role: identity.role, csrfToken }, 200, req);
      return;
    }

    if (!key) {
      loginLimiter.recordFailure(ip);
      sendJson(res, { error: 'API key is required' }, 401, req);
      return;
    }

    const identity = keyManager.validateKey(key);
    if (!identity) {
      loginLimiter.recordFailure(ip);
      sendJson(res, { error: 'Invalid API key' }, 401, req);
      return;
    }

    const { sessionId, csrfToken } = sessionManager.createSession(identity);
    res.setHeader('Set-Cookie', [
      `torque_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
      `torque_csrf=${csrfToken}; SameSite=Strict; Path=/`,
    ]);
    sendJson(res, { success: true, role: identity.role, csrfToken }, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, req);
  }
}

async function handleDashboardLogout(req, res, _context = {}) {
  const sessionManager = require('./auth/session-manager');
  const { parseCookie } = require('./auth/middleware');

  const sessionId = parseCookie(req.headers?.cookie, 'torque_session');
  if (sessionId) {
    sessionManager.destroySession(sessionId);
  }

  // Clear cookies
  res.setHeader('Set-Cookie', [
    'torque_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    'torque_csrf=; SameSite=Strict; Path=/; Max-Age=0',
  ]);
  sendJson(res, { success: true }, 200, req);
}

// ============================================
// Route definitions
// ============================================

const ROUTE_HANDLER_LOOKUP = {
  handleV2Inference,
  handleV2ProviderInference,
  handleV2TaskStatus,
  handleV2TaskCancel,
  handleV2TaskEvents,
  handleV2ListProviders,
  handleV2ProviderCapabilities,
  handleV2ProviderModels,
  handleV2ProviderHealth,
  handleV2ProviderDetail,
  handleV2RemoteRun,
  handleV2RemoteTest,
  handleV2CpRunRemoteCommand: remoteAgentHandlers.handleRunRemoteCommand,
  handleV2CpRunTests: remoteAgentHandlers.handleRunTests,
  handleShutdown,
  handleCreateTicket,
  handleCreateApiKey,
  handleListApiKeys,
  handleRevokeApiKey,
  handleDashboardLogin,
  handleDashboardLogout,
  handleClaudeEvent,
  handleClaudeFiles,
  handleGetFreeTierStatus,
  handleGetFreeTierHistory,
  handleGetFreeTierAutoScale,
  handleGetProviderQuotas,
  handleBootstrapWorkstation: require('./api/bootstrap').handleBootstrapWorkstation,
  // V2 Control-Plane: Tasks
  handleV2CpSubmitTask: v2TaskHandlers.handleSubmitTask,
  handleV2CpListTasks: v2TaskHandlers.handleListTasks,
  handleV2CpTaskDiff: v2TaskHandlers.handleTaskDiff,
  handleV2CpTaskLogs: v2TaskHandlers.handleTaskLogs,
  handleV2CpTaskProgress: v2TaskHandlers.handleTaskProgress,
  handleV2CpRetryTask: v2TaskHandlers.handleRetryTask,
  handleV2CpReassignTaskProvider: v2TaskHandlers.handleReassignTaskProvider,
  handleV2CpCommitTask: v2TaskHandlers.handleCommitTask,
  handleV2CpGetTask: v2TaskHandlers.handleGetTask,
  handleV2CpCancelTask: v2TaskHandlers.handleCancelTask,
  handleV2CpDeleteTask: v2TaskHandlers.handleDeleteTask,
  handleV2CpApproveSwitch: v2TaskHandlers.handleApproveSwitch,
  handleV2CpRejectSwitch: v2TaskHandlers.handleRejectSwitch,
  // V2 Control-Plane: Workflows
  handleV2CpCreateWorkflow: v2WorkflowHandlers.handleCreateWorkflow,
  handleV2CpListWorkflows: v2WorkflowHandlers.handleListWorkflows,
  handleV2CpGetWorkflow: v2WorkflowHandlers.handleGetWorkflow,
  handleV2CpRunWorkflow: v2WorkflowHandlers.handleRunWorkflow,
  handleV2CpCancelWorkflow: v2WorkflowHandlers.handleCancelWorkflow,
  handleV2CpAddWorkflowTask: v2WorkflowHandlers.handleAddWorkflowTask,
  handleV2CpWorkflowHistory: v2WorkflowHandlers.handleWorkflowHistory,
  handleV2CpCreateFeatureWorkflow: v2WorkflowHandlers.handleCreateFeatureWorkflow,
  // V2 Control-Plane: Governance
  handleV2CpListApprovals: v2GovernanceHandlers.handleListApprovals,
  handleV2CpApprovalDecision: v2GovernanceHandlers.handleApprovalDecision,
  handleV2CpListSchedules: v2GovernanceHandlers.handleListSchedules,
  handleV2CpCreateSchedule: v2GovernanceHandlers.handleCreateSchedule,
  handleV2CpGetSchedule: v2GovernanceHandlers.handleGetSchedule,
  handleV2CpToggleSchedule: v2GovernanceHandlers.handleToggleSchedule,
  handleV2CpDeleteSchedule: v2GovernanceHandlers.handleDeleteSchedule,
  handleV2CpListPolicies: v2GovernanceHandlers.handleListPolicies,
  handleV2CpGetPolicy: v2GovernanceHandlers.handleGetPolicy,
  handleV2CpSetPolicyMode: v2GovernanceHandlers.handleSetPolicyMode,
  handleV2CpEvaluatePolicies: v2GovernanceHandlers.handleEvaluatePolicies,
  handleV2CpListPolicyEvaluations: v2GovernanceHandlers.handleListPolicyEvaluations,
  handleV2CpGetPolicyEvaluation: v2GovernanceHandlers.handleGetPolicyEvaluation,
  handleV2CpOverridePolicyDecision: v2GovernanceHandlers.handleOverridePolicyDecision,
  handleV2CpPeekAttestationExport: v2GovernanceHandlers.handlePeekAttestationExport,
  handleV2CpListPlanProjects: v2GovernanceHandlers.handleListPlanProjects,
  handleV2CpGetPlanProject: v2GovernanceHandlers.handleGetPlanProject,
  handleV2CpPlanProjectAction: v2GovernanceHandlers.handlePlanProjectAction,
  handleV2CpDeletePlanProject: v2GovernanceHandlers.handleDeletePlanProject,
  handleV2CpImportPlan: v2GovernanceHandlers.handleImportPlan,
  handleV2CpListBenchmarks: v2GovernanceHandlers.handleListBenchmarks,
  handleV2CpApplyBenchmark: v2GovernanceHandlers.handleApplyBenchmark,
  handleV2CpListProjectTuning: v2GovernanceHandlers.handleListProjectTuning,
  handleV2CpCreateProjectTuning: v2GovernanceHandlers.handleCreateProjectTuning,
  handleV2CpDeleteProjectTuning: v2GovernanceHandlers.handleDeleteProjectTuning,
  handleV2CpProviderStats: v2GovernanceHandlers.handleProviderStats,
  handleV2CpProviderToggle: v2GovernanceHandlers.handleProviderToggle,
  handleV2CpProviderTrends: v2GovernanceHandlers.handleProviderTrends,
  handleV2CpSystemStatus: v2GovernanceHandlers.handleSystemStatus,
  // V2 Control-Plane: Config
  handleV2CpConfigureProvider: v2GovernanceHandlers.handleConfigureProvider,
  handleV2CpSetDefaultProvider: v2GovernanceHandlers.handleSetDefaultProvider,
  // V2 Control-Plane: Config
  handleV2CpGetConfig: v2GovernanceHandlers.handleGetConfig,
  handleV2CpSetConfig: v2GovernanceHandlers.handleSetConfig,
  handleV2CpConfigureStallDetection: v2GovernanceHandlers.handleConfigureStallDetection,
  // V2 Control-Plane: Project Config
  handleV2CpScanProject: v2GovernanceHandlers.handleScanProject,
  handleV2CpGetProjectDefaults: v2GovernanceHandlers.handleGetProjectDefaults,
  handleV2CpSetProjectDefaults: v2GovernanceHandlers.handleSetProjectDefaults,
  // V2 Control-Plane: Webhooks
  handleV2CpListWebhooks: v2GovernanceHandlers.handleListWebhooks,
  handleV2CpAddWebhook: v2GovernanceHandlers.handleAddWebhook,
  handleV2CpRemoveWebhook: v2GovernanceHandlers.handleRemoveWebhook,
  handleV2CpTestWebhook: v2GovernanceHandlers.handleTestWebhook,
  // V2 Control-Plane: Validation
  handleV2CpAutoVerifyAndFix: v2GovernanceHandlers.handleAutoVerifyAndFix,
  handleV2CpDetectFileConflicts: v2GovernanceHandlers.handleDetectFileConflicts,
  // V2 Control-Plane: Analytics & Budget
  handleV2CpStatsOverview: v2AnalyticsHandlers.handleStatsOverview,
  handleV2CpTimeSeries: v2AnalyticsHandlers.handleTimeSeries,
  handleV2CpQualityStats: v2AnalyticsHandlers.handleQualityStats,
  handleV2CpStuckTasks: v2AnalyticsHandlers.handleStuckTasks,
  handleV2CpModelStats: v2AnalyticsHandlers.handleModelStats,
  handleV2CpFormatSuccess: v2AnalyticsHandlers.handleFormatSuccess,
  handleV2CpEventHistory: v2AnalyticsHandlers.handleEventHistory,
  handleV2CpWebhookStats: v2AnalyticsHandlers.handleWebhookStats,
  handleV2CpNotificationStats: v2AnalyticsHandlers.handleNotificationStats,
  handleV2CpThroughputMetrics: v2AnalyticsHandlers.handleThroughputMetrics,
  handleV2CpBudgetSummary: v2AnalyticsHandlers.handleBudgetSummary,
  handleV2CpBudgetStatus: v2AnalyticsHandlers.handleBudgetStatus,
  handleV2CpSetBudget: v2AnalyticsHandlers.handleSetBudget,
  handleV2CpStrategicStatus: v2AnalyticsHandlers.handleStrategicStatus,
  handleV2CpRoutingDecisions: v2AnalyticsHandlers.handleRoutingDecisions,
  handleV2CpProviderHealthCards: v2AnalyticsHandlers.handleProviderHealth,
  // V2 Control-Plane: Infrastructure
  handleV2CpListHosts: v2InfrastructureHandlers.handleListHosts,
  handleV2CpGetHost: v2InfrastructureHandlers.handleGetHost,
  handleV2CpToggleHost: v2InfrastructureHandlers.handleToggleHost,
  handleV2CpDeleteHost: v2InfrastructureHandlers.handleDeleteHost,
  handleV2CpHostScan: v2InfrastructureHandlers.handleHostScan,
  handleV2CpListPeekHosts: v2InfrastructureHandlers.handleListPeekHosts,
  handleV2CpCreatePeekHost: v2InfrastructureHandlers.handleCreatePeekHost,
  handleV2CpDeletePeekHost: v2InfrastructureHandlers.handleDeletePeekHost,
  handleV2CpTogglePeekHost: v2InfrastructureHandlers.handleTogglePeekHost,
  handleV2CpListCredentials: v2InfrastructureHandlers.handleListCredentials,
  handleV2CpSaveCredential: v2InfrastructureHandlers.handleSaveCredential,
  handleV2CpDeleteCredential: v2InfrastructureHandlers.handleDeleteCredential,
  handleV2CpListAgents: v2InfrastructureHandlers.handleListAgents,
  handleV2CpCreateAgent: v2InfrastructureHandlers.handleCreateAgent,
  handleV2CpGetAgent: v2InfrastructureHandlers.handleGetAgent,
  handleV2CpAgentHealth: v2InfrastructureHandlers.handleAgentHealth,
  handleV2CpDeleteAgent: v2InfrastructureHandlers.handleDeleteAgent,
};

function resolveApiRoutes(deps = {}) {
  const baseRoutes = routes.filter((route) => !V2_PROVIDER_ROUTE_HANDLER_NAMES.has(route.handlerName));
  const resolvedRoutes = baseRoutes.map((route) => {
    if (!route.handler && route.handlerName) {
      return {
        ...route,
        handler: ROUTE_HANDLER_LOOKUP[route.handlerName],
      };
    }
    return route;
  });

  const v2Routes = createV2Router({
    mountPath: '/api/v2',
    resolveRequestId,
    handlers: {
      listProviderModels: handleV2ProviderModels,
      getProviderHealth: handleV2ProviderHealth,
    },
  });

  // v2 discovery routes (from v2-router) must precede CP routes to avoid shadowing
  // e.g. GET /api/v2/providers has both a discovery handler and a CP handler
  return v2Routes.concat(resolvedRoutes, createHealthRoutes(deps));
}

function createApiServer(deps = {}) {
  const serverDeps = {
    db: deps.db || db,
    taskManager: deps.taskManager,
    tools: deps.tools || tools,
    agentRegistry: deps.agentRegistry,
    logger: deps.logger || logger,
  };

  // Initialize v2 control-plane handlers with task manager
  if (serverDeps.taskManager) {
    _v2TaskManager = serverDeps.taskManager;
    v2TaskHandlers.init(serverDeps.taskManager);
    v2WorkflowHandlers.init(serverDeps.taskManager);
    v2GovernanceHandlers.init(serverDeps.taskManager);
    v2InfrastructureHandlers.init(serverDeps.taskManager);
  }

  const routeTable = resolveApiRoutes(serverDeps);
  const middlewareContext = applyMiddleware(null, {
    getV2RatePolicy,
    getV2RateLimiter,
    getRateLimit: () => getRateLimit(serverDeps.db || db),
  });

  return {
    routes: routeTable,
    middlewareContext,
    requestHandler: (req, res) => handleRequest(req, res, {
      routes: routeTable,
      middlewareContext,
      deps: serverDeps,
    }),
  };
}

/** Localhost IP addresses that are always allowed to call /api/shutdown */
const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * GET /api/free-tier/status — return free-tier provider quota status.
 */
let _freeTierTrackerGetter = null;
function setFreeTierTrackerGetter(getter) {
  _freeTierTrackerGetter = getter;
  // Forward to webhook module so free_tier_task triggers can use it
  if (typeof setWebhookFreeTierTrackerGetter === 'function') {
    setWebhookFreeTierTrackerGetter(getter);
  }
}

async function handleGetFreeTierStatus(_req, res, _context = {}) {
  try {
    const tracker = typeof _freeTierTrackerGetter === 'function' ? _freeTierTrackerGetter() : null;
    if (!tracker) {
      sendJson(res, { status: 'ok', providers: {}, message: 'FreeQuotaTracker not initialized' }, 200, _req);
      return;
    }
    sendJson(res, { status: 'ok', providers: tracker.getStatus() }, 200, _req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, _req);
  }
}

async function handleGetProviderQuotas(req, res, _context = {}) {
  try {
    const quotas = require('./db/provider-quotas').getQuotaStore().getAllQuotas();
    sendJson(res, quotas, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, req);
  }
}

/**
 * GET /api/free-tier/history?days=7 — return free-tier daily usage history.
 */
async function handleGetFreeTierHistory(req, res, _context = {}) {
  try {
    const query = parseQuery(req.url);
    const days = Math.max(1, Math.min(90, parseInt(query.days, 10) || 7));
    const history = db.getUsageHistory(days);
    sendJson(res, { status: 'ok', history }, 200, req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, req);
  }
}

/**
 * GET /api/free-tier/auto-scale — return free-tier auto-scale config + current status.
 */
async function handleGetFreeTierAutoScale(_req, res, _context = {}) {
  try {
    const enabled = serverConfig.isOptIn('free_tier_auto_scale_enabled');
    const queueDepthThreshold = serverConfig.getInt('free_tier_queue_depth_threshold', 3);
    const cooldownSeconds = serverConfig.getInt('free_tier_cooldown_seconds', 60);

    // Count currently queued codex tasks
    let codexQueueDepth = 0;
    try {
      const queued = db.listTasks({ status: 'queued', limit: 1000 });
      const queuedArr = Array.isArray(queued) ? queued : (queued.tasks || []);
      codexQueueDepth = queuedArr.filter(t => {
        if (t.provider === 'codex') return true;
        if (!t.provider) {
          try { const m = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : t.metadata; return m?.intended_provider === 'codex'; } catch { return false; }
        }
        return false;
      }).length;
    } catch (_e) { void _e; }

    // Get last activation time from queue-scheduler
    let lastActivation = null;
    try {
      const scheduler = require('./execution/queue-scheduler');
      const ts = scheduler._getLastAutoScaleActivation();
      if (ts > 0) lastActivation = new Date(ts).toISOString();
    } catch (_e) { void _e; }

    sendJson(res, {
      status: 'ok',
      auto_scale: {
        enabled,
        queue_depth_threshold: queueDepthThreshold,
        cooldown_seconds: cooldownSeconds,
        current_codex_queue_depth: codexQueueDepth,
        last_activation: lastActivation,
      },
    }, 200, _req);
  } catch (err) {
    sendJson(res, { error: err.message }, 500, _req);
  }
}

/**
 * POST /api/hooks/claude-event — receive Claude Code hook events.
 * Called by PostToolUse (notify-file-write), audit hooks, and any HTTP-type hooks.
 * Tracks file modifications by session for conflict detection with Codex sandboxes.
 */
const _claudeEventLog = new Map(); // sessionId -> { files: Set, events: [] }

async function handleClaudeEvent(req, res, _context = {}) {
  const requestId = _context.requestId || randomUUID();
  let body = {};
  try { body = await parseBody(req); } catch { /* ignore */ }

  const eventType = body.event_type || 'unknown';
  const sessionId = body.session_id || 'anonymous';
  const payload = body.payload || {};

  // Track file modifications per session
  if (eventType === 'file_write' && payload.file_path) {
    if (!_claudeEventLog.has(sessionId)) {
      _claudeEventLog.set(sessionId, { files: new Set(), events: [] });
      // Evict oldest entries if map grows beyond 1000 sessions
      if (_claudeEventLog.size > 1000) {
        const firstKey = _claudeEventLog.keys().next().value;
        _claudeEventLog.delete(firstKey);
      }
    }
    const session = _claudeEventLog.get(sessionId);
    session.files.add(payload.file_path);
    session.events.push({
      type: eventType,
      file: payload.file_path,
      tool: payload.tool_name || null,
      timestamp: payload.timestamp || new Date().toISOString(),
    });

    // Cap per-session event history at 500
    if (session.events.length > 500) {
      session.events = session.events.slice(-250);
    }
  }

  logger.debug('Claude event received', { eventType, sessionId, payload: JSON.stringify(payload).slice(0, 200) });

  sendJson(res, {
    status: 'ok',
    event_id: requestId,
    event_type: eventType,
    tracked_files: _claudeEventLog.get(sessionId)?.files.size || 0,
  }, 200, req);
}

/**
 * GET /api/hooks/claude-files — list files modified by Claude sessions.
 * Used by conflict detection to compare against Codex sandbox state.
 */
async function handleClaudeFiles(_req, res, _context = {}) {
  const query = parseQuery(_req.url);
  const sessionId = query.session_id;

  if (sessionId) {
    const session = _claudeEventLog.get(sessionId);
    sendJson(res, {
      session_id: sessionId,
      files: session ? [...session.files] : [],
      event_count: session ? session.events.length : 0,
    }, 200, _req);
  } else {
    // All sessions summary
    const sessions = {};
    for (const [sid, data] of _claudeEventLog.entries()) {
      sessions[sid] = { file_count: data.files.size, event_count: data.events.length };
    }
    sendJson(res, { sessions }, 200, _req);
  }
}

/**
 * POST /api/shutdown — trigger graceful shutdown from external callers.
 * Responds with 200 before initiating shutdown so the caller gets confirmation.
 * Requires either a localhost source IP or a valid API key.
 */
async function handleShutdown(req, res, _context = {}) {
  void _context;
  const remoteIp = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const isLocalhost = LOCALHOST_IPS.has(remoteIp);

  if (!isLocalhost && !authMiddleware.authenticate(req)) {
    sendJson(res, { error: 'Forbidden' }, 403, req);
    return;
  }

  // Defense-in-depth: require X-Requested-With to prevent CSRF from browser contexts
  if (!req.headers['x-requested-with']) {
    sendJson(res, { error: 'X-Requested-With header required' }, 403, req);
    return;
  }

  let body = {};
  try { body = await parseBody(req); } catch { /* ignore */ }
  const reason = body.reason || 'HTTP /api/shutdown';

  sendJson(res, { status: 'shutting_down', reason }, 200, req);

  // Give the response time to flush, then trigger graceful shutdown
  setTimeout(() => {
    eventBus.emitShutdown(reason);
  }, 200);
}

const INBOUND_WEBHOOK_PREFIX = '/api/webhooks/inbound/';

// ============================================
// Request handler
// ============================================

function executeRouteMiddleware(middlewareFn, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;

    function next(err) {
      if (settled) {
        return;
      }

      settled = true;
      if (err) {
        reject(err);
        return;
      }

      resolve(true);
    }

    try {
      Promise.resolve(middlewareFn(req, res, next))
        .then(() => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
    } catch (err) {
      reject(err);
    }
  });
}

async function runRouteMiddleware(middlewares, req, res) {
  for (const middlewareFn of middlewares || []) {
    const shouldContinue = await executeRouteMiddleware(middlewareFn, req, res);
    if (!shouldContinue) {
      return false;
    }
  }

  return true;
}

/**
 * Handle incoming HTTP request
 */
async function handleRequest(req, res, context = {}) {
  const activeContext = context && context.routes && context.middlewareContext
    ? context
    : createApiServer();
  const {
    routes: routeTable,
    middlewareContext,
  } = activeContext;

  const requestId = resolveRequestId(req);
  const requestStart = Date.now();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  logger.info(`Incoming request ${req.method} ${req.url}`, {
    requestId,
    method: req.method,
    path: req.url,
  });

  res.on('finish', () => {
    logger.info(`Completed request ${req.method} ${req.url}`, {
      requestId,
      method: req.method,
      path: req.url,
      statusCode: res.statusCode,
      durationMs: Date.now() - requestStart,
    });
  });

  // CORS preflight
  if (middlewareContext.handleCorsPreflight(req, res)) {
    return;
  }

  const url = req.url.split('?')[0];
  const endpointRateLimiter = middlewareContext.getEndpointRateLimiter(url);

  // Endpoint-specific limiter first, then fallback to global limiter.
  const rateLimiter = endpointRateLimiter || checkRateLimit;
  if (!rateLimiter(req, res)) {
    return;
  }

  const query = parseQuery(req.url);

  // Inbound webhook route — POST /api/webhooks/inbound/:name
  // This is NOT in the routes array — it's a special handler with its own auth (HMAC, not API key)
  if (req.method === 'POST' && url.startsWith(INBOUND_WEBHOOK_PREFIX)) {
    try {
      const webhookName = decodeURIComponent(url.slice(INBOUND_WEBHOOK_PREFIX.length));
      if (webhookName) {
        return await handleInboundWebhook(req, res, webhookName, { requestId });
      }
    } catch (err) {
      if (err instanceof URIError) {
        sendJson(res, { error: 'Invalid webhook name encoding' }, 400, req);
        return;
      }
      throw err;
    }
  }

  if (req.method === 'GET' && url === '/api/openapi.json') {
    const spec = generateOpenApiSpec(routes);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(spec, null, 2));
    return;
  }

  // Version endpoint — always accessible (no auth required)
  if (req.method === 'GET' && url === '/api/version') {
    const pkg = require('./package.json');
    sendJson(res, { version: pkg.version, name: pkg.name || 'torque' }, 200, req);
    return;
  }

  // Find matching route
  for (const route of routeTable) {
    if (route.method !== req.method) continue;

    let match = null;
    if (typeof route.path === 'string') {
      if (url !== route.path) continue;
      match = [];
    } else {
      match = url.match(route.path);
      if (!match) continue;
    }

    // TDA-09/TDA-10: Emit deprecation headers for legacy routes
    if (route.deprecated) {
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', '2026-09-01');
      res.setHeader('Link', `<${route.deprecated}>; rel="successor-version"`);
    }

    // Auth check — skip for routes that handle auth themselves (e.g. skipAuth: true)
    // or explicit allow-listed unauthenticated health routes.
    const shouldSkipAuth = route.skipAuth === true
      || (Array.isArray(route.skipAuth) && route.skipAuth.includes(url));
    if (!shouldSkipAuth) {
      const identity = authMiddleware.authenticate(req);
      if (!identity) {
        sendAuthError(res, requestId, req);
        return;
      }
      req._identity = identity;
    }

    const routeParams = [];
    const mappedParams = {};
    if (route.mapParams && match) {
      route.mapParams.forEach((param, i) => {
        if (param) {
          const value = match[i + 1];
          routeParams.push(value);
          mappedParams[param] = value;
        }
      });
    }

    req.params = mappedParams;
    req.query = query;

    try {
      if (route.middleware?.length) {
        const shouldContinue = await runRouteMiddleware(route.middleware, req, res);
        if (!shouldContinue) {
          return;
        }
      }

      // Custom handler
      if (route.handler) {
        return await route.handler(req, res, { requestId, params: req.params, query: req.query }, ...routeParams, req);
      }

      // Build args for MCP tool
      let args = {};

      if (route.mapBody) {
        args = Object.prototype.hasOwnProperty.call(req, 'body')
          ? req.body
          : await parseBody(req);
      }

      if (route.mapQuery) {
        for (const [key, value] of Object.entries(req.query)) {
          if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
            args[key] = value;
          }
        }
      }

      Object.assign(args, req.params);

      // Call MCP tool
      const result = await handleToolCall(route.tool, args);

      // Convert MCP result to REST response
      if (result.isError) {
        sendJson(res, { error: result.content?.[0]?.text || 'Unknown error' }, 400, req);
      } else {
        sendJson(res, {
          tool: route.tool,
          result: result.content?.[0]?.text || '',
        }, 200, req);
      }
    } catch (err) {
      if (isV2Route) {
        const normalized = normalizeError(err, req);
        sendJson(res, normalized.body, normalized.status, req);
      } else {
        const status = err.message?.includes('Invalid JSON') || err.message?.includes('too large') ? 400 : 500;
        sendJson(res, { error: err.message }, status, req);
      }
    }
    return;
  }

  // Tool discovery — GET /api/tools lists all available MCP tools
  if (req.method === 'GET' && url === '/api/tools') {
    sendJson(res, { tools: [...tools.routeMap.keys()].sort(), count: tools.routeMap.size }, 200, req);
    return;
  }

  // Generic tool passthrough — POST /api/tools/:tool_name
  // Exposes MCP tools via REST API without per-tool route definitions.
  // SECURITY: Requires API key + tier enforcement (rest_api_tool_mode config).
  const TOOL_PREFIX = '/api/tools/';
  // Tools that must not be callable via the generic REST passthrough regardless of auth/tier
  const BLOCKED_REST_TOOLS = new Set(['restart_server', 'shutdown', 'database_backup', 'database_restore']);
  if (req.method === 'POST' && url.startsWith(TOOL_PREFIX)) {
    const toolName = url.slice(TOOL_PREFIX.length);
    if (toolName && /^[a-z_]+$/.test(toolName) && tools.routeMap.has(toolName)) {
      if (BLOCKED_REST_TOOLS.has(toolName)) {
        sendJson(res, { error: `Tool '${toolName}' is not available via the REST API` }, 403, req);
        return;
      }
      {
        const identity = authMiddleware.authenticate(req);
        if (!identity || identity.id === 'open-mode') {
          sendAuthError(res, requestId, req);
          return;
        }
      }

      // F3: Enforce tool tier on REST passthrough (mirrors MCP stdio/SSE tier enforcement)
      const restToolMode = serverConfig.get('rest_api_tool_mode', 'core');
      if (restToolMode !== 'full') {
        const allowedNames = restToolMode === 'extended' ? EXTENDED_TOOL_NAMES : CORE_TOOL_NAMES;
        if (!allowedNames.includes(toolName)) {
          sendJson(res, {
            error: `Tool '${toolName}' is not available in '${restToolMode}' mode. ` +
              `Set rest_api_tool_mode to 'extended' or 'full' to access this tool.`,
          }, 403, req);
          return;
        }
      }

      try {
        const body = await parseBody(req);
        const result = await handleToolCall(toolName, body || {});
        if (result.isError) {
          sendJson(res, { error: result.content?.[0]?.text || 'Unknown error' }, 400, req);
        } else {
          sendJson(res, {
            tool: toolName,
            result: result.content?.[0]?.text || '',
          }, 200, req);
        }
      } catch (err) {
        const status = err.message?.includes('Invalid JSON') || err.message?.includes('too large') ? 400 : 500;
        sendJson(res, { error: err.message }, status, req);
      }
      return;
    }
  }

  sendJson(res, { error: 'Not found' }, 404, req);
}

// ============================================
// Server lifecycle
// ============================================

/**
 * Start the API server
 */
function start(options = {}) {
  return new Promise((resolve) => {
    if (apiServer) {
      resolve({ success: true, port: apiPort, message: 'Already running' });
      return;
    }

    const apiContext = createApiServer({
      db,
      taskManager: options.taskManager || null,
      tools,
      agentRegistry: options.agentRegistry || null,
      logger,
    });

    apiPort = options.port || serverConfig.getPort('api');

    apiServer = http.createServer(apiContext.requestHandler);
    startRateLimitCleanup();

    apiServer.on('error', (err) => {
      // Reset server reference so start() can be retried
      try { apiServer.close(); } catch { /* ignore */ }
      apiServer = null;
      stopRateLimitCleanup();
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(
          `\nPort ${apiPort} is already in use.\n\n` +
          `Options:\n` +
          `  1. Stop existing TORQUE: bash stop-torque.sh\n` +
          `  2. Use different port: TORQUE_API_PORT=${apiPort + 2} torque start\n` +
          `  3. Find what's using it: lsof -i :${apiPort} (Linux/Mac) or netstat -ano | findstr :${apiPort} (Windows)\n\n`
        );
        resolve({ success: false, error: 'Port in use' });
      } else {
        process.stderr.write(`API server error: ${err.message}\n`);
        resolve({ success: false, error: err.message });
      }
    });

    apiServer.listen(apiPort, '127.0.0.1', () => {
      process.stderr.write(`TORQUE API server listening on http://127.0.0.1:${apiPort}\n`);
      resolve({ success: true, port: apiPort });
    });
  });
}

/**
 * Stop the API server
 */
function stop() {
  stopRateLimitCleanup();
  if (apiServer) {
    apiServer.close();
    apiServer = null;
  }
}

module.exports = {
  start,
  stop,
  createRateLimiter,
  getRateLimit,
  startRateLimitCleanup,
  stopRateLimitCleanup,
  checkRateLimit,
  resolveRequestId,
  parseBody,
  sendJson,
  parseQuery,
  sendV2Success,
  sendV2Error,
  getV2ProviderDefaultTimeoutMs,
  getV2ProviderQueueDepth,
  getV2ProviderDefaultProvider,
  handleInboundWebhook,
  handleHealthz,
  handleReadyz,
  handleLivez,
  verifyWebhookSignature,
  substitutePayload,
  setFreeTierTrackerGetter,
  handleGetFreeTierHistory,
  handleGetFreeTierAutoScale,
  _testing: {
    handleV2TaskCancel,
    setV2TaskManager: (tm) => { _v2TaskManager = tm; },
    handleClaudeEvent,
    handleClaudeFiles,
    _claudeEventLog,
  },
};
