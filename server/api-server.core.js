const http = require('http');
const { randomUUID } = require('crypto');
const tools = require('./tools');
const { handleToolCall, schemaMap } = tools;
const db = require('./database');
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
const v2GovernanceHandlers = require('./api/v2-governance-handlers');
const v2AnalyticsHandlers = require('./api/v2-analytics-handlers');
const v2InfrastructureHandlers = require('./api/v2-infrastructure-handlers');
const webhooks = require('./api/webhooks');
const { FACTORY_V2_ROUTES, PII_SCAN_ROUTE } = require('./api/routes/index');
const quotaLifecycleHandlers = require('./api/handlers/quota-and-lifecycle-handlers');
const {
  coerceRestPassthroughValue,
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
const { handleInboundWebhook, verifyWebhookSignature, substitutePayload } = webhooks;
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

function getRestToolNames() {
  const names = new Set(tools.routeMap.keys());
  if (typeof tools.getRuntimeRegisteredToolDefs === 'function') {
    for (const tool of tools.getRuntimeRegisteredToolDefs()) {
      if (tool && typeof tool.name === 'string') {
        names.add(tool.name);
      }
    }
  }
  return [...names].sort();
}

function hasRestTool(toolName) {
  return tools.routeMap.has(toolName)
    || (typeof tools.getRuntimeRegisteredToolDef === 'function' && Boolean(tools.getRuntimeRegisteredToolDef(toolName)));
}

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
  handleBootstrapWorkstation: require('./plugins/remote-agents/bootstrap').handleBootstrapWorkstation,
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

// Routes that skip plugin-contributed middleware (e.g. auth). Health probes,
// the version endpoint, and the OpenAPI spec must stay reachable without
// credentials so monitoring/tooling works before a client is authenticated.
// /api/shutdown is NOT on this list — it's rate-limited (5/window) but should
// require auth in enterprise mode so an unauthenticated caller can't DoS the
// server. Inbound webhooks (POST /api/webhooks/inbound/*) run their own HMAC
// auth flow before this pipeline gets a chance.
const PLUGIN_MIDDLEWARE_PUBLIC_ROUTES = new Set([
  '/healthz',
  '/readyz',
  '/livez',
  '/api/version',
  '/api/openapi.json',
]);

function isPluginMiddlewarePublicRoute(url) {
  if (PLUGIN_MIDDLEWARE_PUBLIC_ROUTES.has(url)) return true;
  // CORS preflights are handled earlier; this is a belt-and-suspenders guard
  // in case a new exempt pattern is added later.
  return false;
}

/**
 * Run the composed plugin middleware chain for a single request.
 *
 * Each middleware is the return value of `plugin.middleware()`. Today the
 * auth plugin returns `authMiddleware.authenticate(req) => identity | throw`.
 * The contract here intentionally accepts either:
 *   - a bare function   → called with (req), identity (if any) attached to req
 *   - an array of those → iterated in order
 *
 * On a thrown 401: respond 401 and signal the caller to stop. Any other
 * thrown error propagates to the top-level handleRequest try/catch.
 *
 * Returns true if the chain completed successfully (continue to route
 * dispatch), false if a response was already written and the caller should
 * stop.
 */
async function runPluginMiddleware(req, res, middlewares) {
  if (!middlewares || middlewares.length === 0) return true;

  const chain = [];
  for (const entry of middlewares) {
    if (Array.isArray(entry)) {
      for (const fn of entry) {
        if (typeof fn === 'function') chain.push(fn);
      }
    } else if (typeof entry === 'function') {
      chain.push(entry);
    }
  }
  if (chain.length === 0) return true;

  for (const mw of chain) {
    try {
      const result = mw(req);
      const identity = result && typeof result.then === 'function' ? await result : result;
      if (identity && typeof identity === 'object') {
        req.identity = identity;
      }
    } catch (err) {
      const status = err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      if (status === 401) {
        sendJson(res, {
          error: err.message || 'Unauthorized',
          code: (err && err.code) || 'unauthorized',
        }, 401, req);
        return false;
      }
      // Non-auth error — let the top-level handler log + 500.
      throw err;
    }
  }
  return true;
}

function createApiServer(deps = {}) {
  const serverDeps = {
    db: deps.db || db,
    taskManager: deps.taskManager,
    tools: deps.tools || tools,
    logger: deps.logger || logger,
  };

  // Plugin-contributed middleware (e.g. auth plugin's authenticate). Empty
  // in local mode — no plugin contributes middleware and the pipeline is a
  // no-op, preserving the zero-auth local default.
  const pluginMiddleware = Array.isArray(deps.pluginMiddleware) ? deps.pluginMiddleware : [];

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
    pluginMiddleware,
    requestHandler: (req, res) => handleRequest(req, res, {
      routes: routeTable,
      middlewareContext,
      pluginMiddleware,
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
    pluginMiddleware = [],
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

  // Plugin-contributed middleware (e.g. auth plugin's authenticate in
  // enterprise mode). Empty in local mode — see createApiServer. Health
  // probes / version / openapi bypass per PLUGIN_MIDDLEWARE_PUBLIC_ROUTES
  // above so monitoring + API discovery stay reachable pre-auth.
  if (pluginMiddleware.length > 0 && !isPluginMiddlewarePublicRoute(url)) {
    const cont = await runPluginMiddleware(req, res, pluginMiddleware);
    if (!cont) return;
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

      // Build args for MCP tool. Precedence (lowest → highest):
      //   1. route.defaultArgs — REST-level defaults so callers get sensible
      //      scoping without restating it on every request. These are the
      //      weakest source; any caller-provided value wins.
      //   2. route.mapBody   — JSON body
      //   3. route.mapQuery  — query-string params
      //   4. route.mapParams / path params — strongest, since they're in the URL
      let args = {};
      const toolSchema = schemaMap.get(route.tool);

      if (route.defaultArgs && typeof route.defaultArgs === 'object') {
        args = { ...route.defaultArgs };
      }

      if (route.mapBody) {
        const body = Object.prototype.hasOwnProperty.call(req, 'body')
          ? req.body
          : await parseBody(req);
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          args = { ...args, ...body };
        } else {
          args = body;
        }
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
    const toolNames = getRestToolNames();
    sendJson(res, { tools: toolNames, count: toolNames.length }, 200, req);
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
    if (toolName && /^[a-z_]+$/.test(toolName) && hasRestTool(toolName)) {
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
      pluginMiddleware: Array.isArray(options.pluginMiddleware) ? options.pluginMiddleware : [],
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
