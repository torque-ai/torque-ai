const http = require('http');
const { randomUUID } = require('crypto');
const tools = require('./tools');
const { handleToolCall, schemaMap } = tools;
const db = require('./database');
const taskCore = require('./db/task-core');
const costTracking = require('./db/cost-tracking');
const serverConfig = require('./config');
const logger = require('./logger').child({ component: 'api-server' });
const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('./core-tools');
const middleware = require('./api/middleware');
const routes = require('./api/routes');
const { generateOpenApiSpec } = require('./api/openapi-generator');
const { createHealthRoutes } = require('./api/health');
const { createV2Router, V2_PROVIDER_ROUTE_HANDLER_NAMES } = require('./api/v2-router');
const { normalizeError } = require('./api/v2-middleware');
const v2TaskHandlers = require('./api/v2-task-handlers');
const v2WorkflowHandlers = require('./api/v2-workflow-handlers');
const eventBus = require('./event-bus');
const v2GovernanceHandlers = require('./api/v2-governance-handlers');
const v2AnalyticsHandlers = require('./api/v2-analytics-handlers');
const v2InfrastructureHandlers = require('./api/v2-infrastructure-handlers');
const webhooks = require('./api/webhooks');
const { FACTORY_V2_ROUTES, PII_SCAN_ROUTE } = require('./api/routes/index');
const quotaLifecycleHandlers = require('./api/handlers/quota-and-lifecycle-handlers');
const {
  coerceRestPassthroughValue,
  executeRouteMiddleware,
  runRouteMiddleware,
  isExcludedRoute,
} = require('./api/dispatcher-helpers');

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
} = middleware;
const { handleInboundWebhook, verifyWebhookSignature, substitutePayload, setQuotaTrackerGetter: setWebhookQuotaTrackerGetter } = webhooks;
const { handleHealthz, handleReadyz, handleLivez } = require('./api/health-probes');
const {
  setQuotaTrackerGetter,
  handleGetQuotaHistory,
  handleGetQuotaAutoScale,
  handleClaudeEvent,
  handleClaudeFiles,
  handlePiiScan,
  _claudeEventLog,
} = quotaLifecycleHandlers;

let apiServer = null;
let apiPort = 3457;


const V2_RATE_POLICIES = new Set(['enforced', 'disabled']);
const DEFAULT_V2_RATE_LIMIT = 120;
let v2RateLimiter = null;
let v2RateLimit = null;

function getV2RatePolicy() {
  try {
    // Local single-user mode defaults to disabled — the dashboard polls hard
    // (5s loop status, 2s job polling, 30s layout banner, multi-fan-out on
    // first load) and one user trips the 120/min default in seconds. Enterprise
    // / multi-tenant deployments still default to enforced.
    const authMode = (process.env.TORQUE_AUTH_MODE || serverConfig.get('auth_mode', 'local')).toLowerCase().trim();
    const isLocalMode = authMode === 'local';
    const defaultPolicy = isLocalMode ? 'disabled' : 'enforced';
    const configuredPolicy = (serverConfig.get('v2_rate_policy', defaultPolicy)).toLowerCase().trim();
    return V2_RATE_POLICIES.has(configuredPolicy) ? configuredPolicy : defaultPolicy;
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

const v2DiscoveryHelpers = require('./api/v2-discovery-helpers');
const {
  sendV2Success,
  sendV2Error,
  getV2ProviderDefaultTimeoutMs,
  getV2ProviderQueueDepth,
  getV2ProviderDefaultProvider,
} = v2DiscoveryHelpers;

const v2CoreHandlers = require('./api/v2-core-handlers');
const {
  handleV2TaskCancel,
  handleV2ProviderModels,
  handleV2ProviderHealth,
  initTaskManager: _initV2TaskManager,
} = v2CoreHandlers;

const { createRouteHandlerLookup } = require('./api/route-handler-lookup');

const ROUTE_HANDLER_LOOKUP = createRouteHandlerLookup({
  v2CoreHandlers,
  v2TaskHandlers,
  v2WorkflowHandlers,
  v2GovernanceHandlers,
  v2AnalyticsHandlers,
  v2InfrastructureHandlers,
  quotaLifecycleHandlers,
});

const hasPiiScanRoute = routes.some((route) => route.method === PII_SCAN_ROUTE.method && route.path === PII_SCAN_ROUTE.path);
if (!hasPiiScanRoute) {
  const shutdownRouteIndex = routes.findIndex((route) => route.method === 'POST' && route.path === '/api/shutdown');
  if (shutdownRouteIndex >= 0) {
    routes.splice(shutdownRouteIndex, 0, PII_SCAN_ROUTE);
  } else {
    routes.push(PII_SCAN_ROUTE);
  }
}

function resolveApiRoutes(deps = {}) {
  const baseRoutes = routes.filter((route) => !V2_PROVIDER_ROUTE_HANDLER_NAMES.has(route.handlerName))
    .filter((route) => !isExcludedRoute(route));
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
  return v2Routes.concat(FACTORY_V2_ROUTES, resolvedRoutes, createHealthRoutes(deps));
}

function createApiServer(deps = {}) {
  const serverDeps = {
    db: deps.db || db,
    taskManager: deps.taskManager,
    tools: deps.tools || tools,
    logger: deps.logger || logger,
  };

  // Initialize v2 control-plane handlers with task manager
  if (serverDeps.taskManager) {
    _initV2TaskManager(serverDeps.taskManager);
    v2TaskHandlers.init(serverDeps.taskManager);
    v2WorkflowHandlers.init(serverDeps.taskManager);
    v2GovernanceHandlers.init({ taskManager: serverDeps.taskManager, db: serverDeps.db });
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
    }).catch((err) => {
      logger.error('Unhandled error in request handler', { error: err.message, stack: err.stack, url: req.url });
      if (!res.headersSent) {
        sendJson(res, { error: 'Internal server error' }, 500, req);
      }
    }),
  };
}

const INBOUND_WEBHOOK_PREFIX = '/api/webhooks/inbound/';

// ============================================
// Request handler
// ============================================

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
  // This is NOT in the routes array — it's a special handler with its own HMAC verification.
  if (req.method === 'POST' && url.startsWith(INBOUND_WEBHOOK_PREFIX)) {
    try {
      const webhookName = decodeURIComponent(url.slice(INBOUND_WEBHOOK_PREFIX.length));
      if (webhookName) {
        return await handleInboundWebhook(req, res, webhookName, { requestId });
      } else {
        sendJson(res, { error: 'Webhook name is required' }, 400, req);
        return;
      }
    } catch (err) {
      if (err instanceof URIError) {
        sendJson(res, { error: 'Invalid webhook name encoding' }, 400, req);
        return;
      }
      logger.error('Webhook handler error', { error: err.message, stack: err.stack, url: req.url });
      sendJson(res, { error: 'Internal webhook error' }, 500, req);
      return;
    }
  }

  if (req.method === 'GET' && url === '/api/openapi.json') {
    const spec = generateOpenApiSpec(routeTable);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(spec, null, 2));
    return;
  }

  // Version endpoint — always accessible.
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
      const toolSchema = schemaMap.get(route.tool);

      if (route.mapBody) {
        args = Object.prototype.hasOwnProperty.call(req, 'body')
          ? req.body
          : await parseBody(req);
      }

      if (route.mapQuery) {
        for (const [key, value] of Object.entries(req.query)) {
          if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
            const coerced = coerceRestPassthroughValue(toolSchema, key, value, 'query param');
            if (!coerced.ok) {
              sendJson(res, { error: coerced.error }, 400, req);
              return;
            }
            args[key] = coerced.value;
          }
        }
      }

      for (const [key, value] of Object.entries(req.params)) {
        const coerced = coerceRestPassthroughValue(toolSchema, key, value, 'path param');
        if (!coerced.ok) {
          sendJson(res, { error: coerced.error }, 400, req);
          return;
        }
        args[key] = coerced.value;
      }

      // Call MCP tool
      const result = await handleToolCall(route.tool, args);

      // Convert MCP result to REST response
      if (result.isError) {
        sendJson(res, { error: result.content?.[0]?.text || 'Unknown error' }, 400, req);
      } else {
        const textResult = result.content?.[0]?.text || '';
        if (route.v2StructuredResponse === true && result.structuredData && typeof result.structuredData === 'object') {
          sendJson(res, {
            data: result.structuredData,
            meta: {
              request_id: req.requestId || null,
              tool: route.tool,
              result: textResult,
            },
          }, 200, req);
        } else {
          // Try to parse text result as JSON and wrap in v2 envelope for dashboard compatibility
          let parsed = null;
          try { parsed = JSON.parse(textResult); } catch { /* not JSON */ }
          if (parsed && typeof parsed === 'object') {
            sendJson(res, {
              data: parsed,
              meta: { request_id: req.requestId || null, tool: route.tool },
            }, 200, req);
          } else {
            sendJson(res, {
              tool: route.tool,
              result: textResult,
            }, 200, req);
          }
        }
      }
    } catch (err) {
      const isV2Route = typeof route.path === 'string' ? route.path.startsWith('/api/v2/') : false;
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
  // SECURITY: Enforced by external middleware/gateway (if configured) and tool-tier config.
  const TOOL_PREFIX = '/api/tools/';
  // Tools that must not be callable via the generic REST passthrough
  const BLOCKED_REST_TOOLS = new Set(['restart_server', 'shutdown', 'database_backup', 'database_restore']);
  if (req.method === 'POST' && url.startsWith(TOOL_PREFIX)) {
    const toolName = url.slice(TOOL_PREFIX.length);
    if (toolName && /^[a-z_]+$/.test(toolName) && tools.routeMap.has(toolName)) {
      if (BLOCKED_REST_TOOLS.has(toolName)) {
        sendJson(res, { error: `Tool '${toolName}' is not available via the REST API` }, 403, req);
        return;
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

    const apiHost = process.env.TORQUE_API_HOST || '127.0.0.1';
    apiServer.listen(apiPort, apiHost, () => {
      process.stderr.write(`TORQUE API server listening on http://${apiHost}:${apiPort}\n`);
      resolve({ success: true, port: apiPort, host: apiHost });
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
  setQuotaTrackerGetter,
  handleGetQuotaHistory,
  handleGetQuotaAutoScale,
  _testing: {
    handleV2TaskCancel,
    handlePiiScan,
    setV2TaskManager: (tm) => { _initV2TaskManager(tm); },
    handleClaudeEvent,
    handleClaudeFiles,
    _claudeEventLog,
  },
};
