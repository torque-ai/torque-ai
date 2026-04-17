'use strict';
const logger = require('../logger').child({ component: 'v2-router' });

const { randomUUID } = require('crypto');
const taskCore = require('../db/task-core');
const configCore = require('../db/config-core');
const providerRoutingCore = require('../db/provider-routing-core');
const { PROVIDER_DEFAULT_TIMEOUTS, PROVIDER_DEFAULTS } = require('../constants');
const adapterRegistry = require('../providers/adapter-registry');
const { buildV2Middleware, validateDecodedParamField } = require('./routes');
const { sendJson } = require('./middleware');

const V2_MOUNT_PATH = '/api/v2';
const V2_PROVIDER_ROUTE_HANDLER_NAMES = new Set([
  'handleV2ListProviders',
  'handleV2ProviderDetail',
  'handleV2ProviderCapabilities',
  'handleV2ProviderModels',
  'handleV2ProviderHealth',
]);
// Consolidated in api/v2-provider-registry.js (single source of truth)
const {
  DEFAULT_REQUEST_RATE_PER_MINUTE,
  PROVIDER_REGISTRY,
  PROVIDER_LOCAL_IDS,
  V2_TRANSPORTS,
} = require('./v2-provider-registry');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMountPath(mountPath) {
  if (typeof mountPath !== 'string' || !mountPath.trim()) {
    return V2_MOUNT_PATH;
  }

  const trimmed = mountPath.trim();
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

function resolveRouteRequestId(req) {
  const headerValue = req?.headers?.['x-request-id'];
  if (Array.isArray(headerValue)) {
    const first = headerValue.find((value) => typeof value === 'string' && value.trim());
    if (first) return first.trim();
  } else if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }

  return randomUUID();
}

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

function buildV2MetaEnvelope(requestId) {
  return {
    request_id: requestId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Send a v2 success response.
 *
 * The response includes both the v2 envelope (`data` + `meta`) AND a legacy
 * top-level spread of `legacyPayload`. The spread is intentional for backward
 * compatibility: older dashboard and CLI consumers read top-level fields such
 * as `providers` or `provider_id` directly. New consumers should read from
 * `data`. Do NOT remove the spread until all consumers have migrated.
 */
function sendV2DiscoverySuccess(res, requestId, data, status = 200, req = null, legacyPayload = {}) {
  sendJson(
    res,
    {
      data,
      meta: buildV2MetaEnvelope(requestId),
      request_id: requestId,
      ...legacyPayload, // backward compat: keep top-level fields for legacy consumers
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

function resolveHandlerRequest(req, rawReq, context = {}, resolveRequestId = resolveRouteRequestId) {
  const request = rawReq && typeof rawReq === 'object' ? rawReq : req;
  const requestId = context.requestId || resolveRequestId(request);
  if (request && !request.requestId) {
    request.requestId = requestId;
  }
  return { request, requestId };
}

function createNotImplementedHandler(operationName, resolveRequestId) {
  return function handleNotImplemented(req, res, context = {}, providerIdOrReq, rawReq = null) {
    const providerId = typeof providerIdOrReq === 'string' ? providerIdOrReq : null;
    const request = rawReq || (providerIdOrReq && typeof providerIdOrReq === 'object' ? providerIdOrReq : req);
    const requestId = context.requestId || resolveRequestId(request);
    if (request && !request.requestId) {
      request.requestId = requestId;
    }

    sendJson(
      res,
      {
        error: {
          code: 'not_implemented',
          message: `${operationName} is not implemented`,
          details: providerId ? { provider_id: providerId } : {},
          request_id: requestId,
        },
      },
      501,
      request,
    );
  };
}

function parseConfiguredPositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return null;
}

function getV2ProviderDefaultTimeoutMs(providerId) {
  const timeoutSeconds = PROVIDER_DEFAULT_TIMEOUTS[providerId];
  const safeSeconds = Number(timeoutSeconds);
  if (Number.isFinite(safeSeconds) && safeSeconds > 0) {
    return safeSeconds * 1000;
  }
  return 30000;
}

function getV2ProviderQueueDepth(providerId) {
  try {
    return Number(taskCore.countTasks?.({ provider: providerId, status: 'queued' })) || 0;
  } catch (err) {
    logger.debug("health metric error", { err: err.message });
    return 0;
  }
}

function getV2ProviderDefaultProvider() {
  try {
    return providerRoutingCore.getDefaultProvider?.() || null;
  } catch (err) {
    logger.debug("health metric error", { err: err.message });
    return null;
  }
}

function getV2ProviderHealth(providerId) {
  try {
    return providerRoutingCore.getProviderHealth?.(providerId) || {};
  } catch (err) {
    logger.debug("health metric error", { err: err.message });
    return {};
  }
}

function isV2ProviderHealthy(providerId) {
  try {
    return providerRoutingCore.isProviderHealthy?.(providerId);
  } catch (err) {
    logger.debug("health metric error", { err: err.message });
    return true;
  }
}

function getV2ProviderStatus(provider, providerId) {
  if (!provider || !provider.enabled) return 'disabled';

  const health = getV2ProviderHealth(providerId);
  const successes = Number(health?.successes ?? health?.successful_tasks) || 0;
  const failures = Number(health?.failures ?? health?.failed_tasks) || 0;
  const total = successes + failures;

  if (total >= 3 && !isV2ProviderHealthy(providerId)) {
    return 'unavailable';
  }
  if (failures > 0) {
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

function normalizeProviderFeatureList(features) {
  return Object.entries(features || {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([feature]) => feature)
    .sort();
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
      parseConfiguredPositiveInt(configCore.getConfig?.('ollama_max_ctx'))
      || parseConfiguredPositiveInt(configCore.getConfig?.('ollama_num_ctx'))
      || PROVIDER_DEFAULTS.OLLAMA_MAX_CONTEXT
    );
  } catch (err) {
    logger.debug("health metric error", { err: err.message });
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
  let capabilityMatrix = {};
  try {
    capabilityMatrix = adapterRegistry.getProviderCapabilityMatrix?.() || {};
  } catch (err) {
    logger.debug("health metric error", { err: err.message });
    capabilityMatrix = {};
  }
  const registryMeta = PROVIDER_REGISTRY[providerId] || {};
  const adapterCapabilities = capabilityMatrix[providerId] || {
    supportsStream: false,
    supportsAsync: false,
    supportsCancellation: false,
  };

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

  const descriptor = {
    id: providerId,
    name: registryMeta.name,
    transport: getV2ProviderTransport(provider),
    local: Boolean(registryMeta.local),
    enabled: Boolean(provider.enabled),
    default: providerId === defaultProviderId,
    features: normalizeProviderFeatureList(registryMeta.features || {}),
    limits: buildV2ProviderLimits(provider, providerId),
    status: getV2ProviderStatus(provider, providerId),
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

function createListProvidersHandler(resolveRequestId) {
  return async function handleListProviders(req, res, context = {}, rawReq = null) {
    const { request, requestId } = resolveHandlerRequest(req, rawReq, context, resolveRequestId);

    try {
      const providers = Array.isArray(providerRoutingCore.listProviders?.()) ? providerRoutingCore.listProviders() : [];
      const defaultProviderId = getV2ProviderDefaultProvider();
      const descriptors = providers
        .map((provider) => buildV2ProviderDescriptor(provider, defaultProviderId))
        .filter(Boolean);

      sendV2DiscoverySuccess(
        res,
        requestId,
        { providers: descriptors },
        200,
        request,
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
        request,
      );
    }
  };
}

function createProviderDetailHandler(resolveRequestId) {
  return function handleProviderDetail(req, res, context = {}, providerId, rawReq = null) {
    const { request, requestId } = resolveHandlerRequest(req, rawReq, context, resolveRequestId);
    const decodedProviderId = decodeV2ProviderIdOrSendError(
      providerId,
      requestId,
      res,
      request,
      'provider_detail',
    );
    if (!decodedProviderId) {
      return;
    }

    try {
      const provider = providerRoutingCore.getProvider?.(decodedProviderId);
      if (!provider) {
        sendV2DiscoveryError(
          res,
          requestId,
          'provider_not_found',
          `Provider not found: ${decodedProviderId}`,
          404,
          { provider_id: decodedProviderId },
          request,
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
        request,
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
        request,
      );
    }
  };
}

function createProviderCapabilitiesHandler(resolveRequestId) {
  return function handleProviderCapabilities(req, res, context = {}, providerId, rawReq = null) {
    const { request, requestId } = resolveHandlerRequest(req, rawReq, context, resolveRequestId);
    const decodedProviderId = decodeV2ProviderIdOrSendError(
      providerId,
      requestId,
      res,
      request,
      'provider_capabilities',
    );
    if (!decodedProviderId) {
      return;
    }

    try {
      const provider = providerRoutingCore.getProvider?.(decodedProviderId);
      if (!provider) {
        sendV2DiscoveryError(
          res,
          requestId,
          'provider_not_found',
          `Provider not found: ${decodedProviderId}`,
          404,
          { provider_id: decodedProviderId },
          request,
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
        request,
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
        request,
      );
    }
  };
}

function getRouteHandler(handlers, key, operationName, resolveRequestId, fallbackHandler = null) {
  if (handlers && typeof handlers[key] === 'function') {
    return handlers[key];
  }

  if (typeof fallbackHandler === 'function') {
    return fallbackHandler;
  }

  return createNotImplementedHandler(operationName, resolveRequestId);
}

function createV2Router(options = {}) {
  const mountPath = normalizeMountPath(options.mountPath);
  const handlers = options.handlers || {};
  const resolveRequestId = typeof options.resolveRequestId === 'function'
    ? options.resolveRequestId
    : resolveRouteRequestId;
  const mountPattern = escapeRegExp(mountPath);

  return [
    {
      method: 'GET',
      path: `${mountPath}/providers`,
      middleware: buildV2Middleware(),
      handler: getRouteHandler(
        handlers,
        'listProviders',
        'GET /providers',
        resolveRequestId,
        createListProvidersHandler(resolveRequestId),
      ),
      handlerName: 'handleV2ListProviders',
    },
    {
      method: 'GET',
      path: new RegExp(`^${mountPattern}/providers/([^/]+)$`),
      middleware: buildV2Middleware({
        params: validateDecodedParamField('provider_id', 'provider id'),
      }),
      handler: getRouteHandler(
        handlers,
        'getProvider',
        'GET /providers/:id',
        resolveRequestId,
        createProviderDetailHandler(resolveRequestId),
      ),
      handlerName: 'handleV2ProviderDetail',
      mapParams: ['provider_id'],
    },
    {
      method: 'GET',
      path: new RegExp(`^${mountPattern}/providers/([^/]+)/capabilities$`),
      middleware: buildV2Middleware({
        params: validateDecodedParamField('provider_id', 'provider id'),
      }),
      handler: getRouteHandler(
        handlers,
        'getProviderCapabilities',
        'GET /providers/:id/capabilities',
        resolveRequestId,
        createProviderCapabilitiesHandler(resolveRequestId),
      ),
      handlerName: 'handleV2ProviderCapabilities',
      mapParams: ['provider_id'],
    },
    {
      method: 'GET',
      path: new RegExp(`^${mountPattern}/providers/([^/]+)/models$`),
      middleware: buildV2Middleware({
        params: validateDecodedParamField('provider_id', 'provider id'),
      }),
      handler: getRouteHandler(handlers, 'listProviderModels', 'GET /providers/:id/models', resolveRequestId),
      handlerName: 'handleV2ProviderModels',
      mapParams: ['provider_id'],
    },
    {
      method: 'GET',
      path: new RegExp(`^${mountPattern}/providers/([^/]+)/health$`),
      middleware: buildV2Middleware({
        params: validateDecodedParamField('provider_id', 'provider id'),
      }),
      handler: getRouteHandler(handlers, 'getProviderHealth', 'GET /providers/:id/health', resolveRequestId),
      handlerName: 'handleV2ProviderHealth',
      mapParams: ['provider_id'],
    },
  ];
}

function createV2RouterModule(_deps) {
  return {
    V2_MOUNT_PATH,
    V2_PROVIDER_ROUTE_HANDLER_NAMES,
    buildV2Middleware,
    validateDecodedParamField,
    escapeRegExp,
    normalizeMountPath,
    resolveRouteRequestId,
    createNotImplementedHandler,
    getRouteHandler,
    createV2Router,
  };
}

module.exports = {
  V2_MOUNT_PATH,
  V2_PROVIDER_ROUTE_HANDLER_NAMES,
  buildV2Middleware,
  validateDecodedParamField,
  escapeRegExp,
  normalizeMountPath,
  resolveRouteRequestId,
  createNotImplementedHandler,
  getRouteHandler,
  createV2Router,
  createV2RouterModule,
};
