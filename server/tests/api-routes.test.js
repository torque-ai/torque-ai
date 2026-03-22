'use strict';

const ROUTE_MODULE = '../api/routes';
const V2_DISPATCH_MODULE = '../api/v2-dispatch';

const MODULE_PATHS = [
  ROUTE_MODULE,
  V2_DISPATCH_MODULE,
  '../database',
  '../db/provider-routing-core',
  '../task-manager',
  '../api/v2-schemas',
  '../api/v2-middleware',
  '../api/openapi-generator',
  '../api/middleware',
  '../api/v2-inference',
  '../api/v2-task-handlers',
  '../api/v2-workflow-handlers',
  '../api/v2-governance-handlers',
  '../api/v2-analytics-handlers',
  '../api/v2-infrastructure-handlers',
];

const V2_TASK_HANDLER_NAMES = [
  'handleSubmitTask',
  'handleListTasks',
  'handleTaskDiff',
  'handleTaskLogs',
  'handleTaskProgress',
  'handleRetryTask',
  'handleReassignTaskProvider',
  'handleCommitTask',
  'handleGetTask',
  'handleCancelTask',
  'handleDeleteTask',
  'handleApproveSwitch',
  'handleRejectSwitch',
];

const V2_WORKFLOW_HANDLER_NAMES = [
  'handleCreateWorkflow',
  'handleListWorkflows',
  'handleGetWorkflow',
  'handleRunWorkflow',
  'handleCancelWorkflow',
  'handleAddWorkflowTask',
  'handleWorkflowHistory',
  'handleCreateFeatureWorkflow',
  'handlePauseWorkflow',
  'handleResumeWorkflow',
  'handleGetWorkflowTasks',
];

const V2_GOVERNANCE_HANDLER_NAMES = [
  'handleListApprovals',
  'handleApprovalDecision',
  'handleListSchedules',
  'handleCreateSchedule',
  'handleGetSchedule',
  'handleToggleSchedule',
  'handleDeleteSchedule',
  'handleListPolicies',
  'handleGetPolicy',
  'handleSetPolicyMode',
  'handleEvaluatePolicies',
  'handleListPolicyEvaluations',
  'handleGetPolicyEvaluation',
  'handleOverridePolicyDecision',
  'handlePeekAttestationExport',
  'handleListPlanProjects',
  'handleGetPlanProject',
  'handlePlanProjectAction',
  'handleDeletePlanProject',
  'handleImportPlan',
  'handleListBenchmarks',
  'handleApplyBenchmark',
  'handleListProjectTuning',
  'handleCreateProjectTuning',
  'handleDeleteProjectTuning',
  'handleListProviders',
  'handleProviderStats',
  'handleProviderToggle',
  'handleProviderTrends',
  'handleConfigureProvider',
  'handleSetDefaultProvider',
  'handleSystemStatus',
  'handleScanProject',
  'handleGetProjectDefaults',
  'handleSetProjectDefaults',
  'handleConfigureStallDetection',
  'handleListWebhooks',
  'handleAddWebhook',
  'handleRemoveWebhook',
  'handleTestWebhook',
  'handleAutoVerifyAndFix',
  'handleDetectFileConflicts',
];

const V2_ANALYTICS_HANDLER_NAMES = [
  'handleStatsOverview',
  'handleTimeSeries',
  'handleQualityStats',
  'handleStuckTasks',
  'handleModelStats',
  'handleFormatSuccess',
  'handleEventHistory',
  'handleWebhookStats',
  'handleNotificationStats',
  'handleThroughputMetrics',
  'handleBudgetSummary',
  'handleBudgetStatus',
  'handleSetBudget',
  'handleStrategicStatus',
  'handleRoutingDecisions',
  'handleProviderHealth',
  'handleFreeTierStatus',
  'handleFreeTierHistory',
  'handleFreeTierAutoScale',
  'handlePrometheusMetrics',
  'handleStrategicOperations',
];

const V2_INFRASTRUCTURE_HANDLER_NAMES = [
  'handleListWorkstations',
  'handleCreateWorkstation',
  'handleToggleWorkstation',
  'handleProbeWorkstation',
  'handleDeleteWorkstation',
  'handleListHosts',
  'handleGetHost',
  'handleToggleHost',
  'handleDeleteHost',
  'handleHostScan',
  'handleListPeekHosts',
  'handleCreatePeekHost',
  'handleDeletePeekHost',
  'handleTogglePeekHost',
  'handleListCredentials',
  'handleSaveCredential',
  'handleDeleteCredential',
  'handleListAgents',
  'handleCreateAgent',
  'handleGetAgent',
  'handleAgentHealth',
  'handleDeleteAgent',
  'handleAddHost',
  'handleRefreshModels',
  'handleHostActivity',
  'handleProviderPercentiles',
  'handleCoordinationDashboard',
];

const SPECIAL_HANDLER_NAMES = [
  'handleV2Inference',
  'handleV2ProviderInference',
  'handleV2TaskEvents',
  'handleV2ListProviders',
  'handleV2ProviderCapabilities',
  'handleV2ProviderModels',
  'handleV2ProviderHealth',
  'handleV2ProviderDetail',
  'handleV2RemoteRun',
  'handleV2RemoteTest',
  'handleGetFreeTierStatus',
  'handleGetFreeTierHistory',
  'handleGetFreeTierAutoScale',
  'handleShutdown',
];

let currentModules = {};

let routes;
let v2Dispatch;
let authSpy;
let handleToolCall;
let specialHandlers;

vi.mock('../database', () => currentModules.db);
vi.mock('../db/provider-routing-core', () => currentModules.db);
vi.mock('../task-manager', () => currentModules.taskManager);
vi.mock('../api/v2-schemas', () => currentModules.v2Schemas);
vi.mock('../api/v2-middleware', () => currentModules.v2Middleware);
vi.mock('../api/openapi-generator', () => currentModules.openapiGenerator);
vi.mock('../api/middleware', () => currentModules.middleware);
vi.mock('../api/v2-inference', () => currentModules.v2Inference);
vi.mock('../api/v2-task-handlers', () => currentModules.v2TaskHandlers);
vi.mock('../api/v2-workflow-handlers', () => currentModules.v2WorkflowHandlers);
vi.mock('../api/v2-governance-handlers', () => currentModules.v2GovernanceHandlers);
vi.mock('../api/v2-analytics-handlers', () => currentModules.v2AnalyticsHandlers);
vi.mock('../api/v2-infrastructure-handlers', () => currentModules.v2InfrastructureHandlers);

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearLoadedModules() {
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that have not been loaded yet.
    }
  }
}

function createMockReq({
  method = 'GET',
  url = '/',
  headers = {},
  body = undefined,
  requestId = 'req-dispatch',
} = {}) {
  return {
    method,
    url,
    headers: { ...headers },
    body,
    params: {},
    query: {},
    requestId,
    socket: { remoteAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
  };
}

function createMockRes() {
  const headers = {};

  return {
    statusCode: null,
    body: '',
    headers,
    headersSent: false,
    locals: {},
    setHeader: vi.fn((name, value) => {
      headers[name.toLowerCase()] = value;
    }),
    getHeader: vi.fn((name) => headers[name.toLowerCase()]),
    status: vi.fn(function status(code) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn(function json(payload) {
      headers['content-type'] = headers['content-type'] || 'application/json';
      this.body = JSON.stringify(payload);
      this.headersSent = true;
      return this;
    }),
    writeHead: vi.fn(function writeHead(statusCode, responseHeaders = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(responseHeaders)) {
        headers[name.toLowerCase()] = value;
      }
      this.headersSent = true;
    }),
    end: vi.fn(function end(payload = '') {
      this.body = typeof payload === 'string' ? payload : String(payload ?? '');
      this.headersSent = true;
    }),
  };
}

function createNext() {
  return vi.fn();
}

function parseJsonBody(res) {
  return res.body ? JSON.parse(res.body) : null;
}

function parseQuery(url) {
  const index = url.indexOf('?');
  if (index === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(index + 1)).entries());
}

function isV2Route(route) {
  if (typeof route.path === 'string') {
    return route.path.startsWith('/api/v2/');
  }

  return route.path.source.includes('\\/api\\/v2\\/');
}

function getV2CpRouteHandlerNames() {
  return [...new Set(
    routes
      .filter((route) => (
        typeof route.handlerName === 'string'
        && route.handlerName.startsWith('handleV2Cp')
      ))
      .map((route) => route.handlerName),
  )].sort();
}

function defaultSendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function createHandlerSpy(name) {
  return vi.fn(async (_req, res, context = {}, ...params) => {
    if (!res.headersSent) {
      defaultSendJson(res, {
        handler: name,
        params,
        request_id: context.requestId || null,
      }, 200);
    }
  });
}

function createHandlerModule(names) {
  const moduleExports = {
    init: vi.fn(),
  };

  for (const name of names) {
    moduleExports[name] = createHandlerSpy(name);
  }

  return moduleExports;
}

function createSpecialHandlers() {
  return SPECIAL_HANDLER_NAMES.reduce((acc, name) => {
    acc[name] = createHandlerSpy(name);
    return acc;
  }, {});
}

function createValidateRequestMiddleware(schema = {}) {
  const middleware = vi.fn(async (req, res, next) => {
    try {
      if (typeof schema.params === 'function') {
        const validation = await schema.params(req.params || {});
        if (!validation.valid) {
          currentModules.middleware.sendJson(res, {
            error: {
              code: 'validation_failed',
              errors: validation.errors,
            },
          }, 400, req);
          return;
        }
        req.params = validation.value;
      }

      if (schema.body?.validator) {
        const options = typeof schema.body.options === 'function'
          ? schema.body.options(req)
          : (schema.body.options || {});
        const validation = await schema.body.validator(req.body || {}, options);

        if (!validation.valid) {
          currentModules.middleware.sendJson(res, {
            error: {
              code: 'validation_failed',
              errors: validation.errors,
            },
          }, 400, req);
          return;
        }

        req.body = validation.value;
      }

      next();
    } catch (error) {
      next(error);
    }
  });

  middleware._schema = schema;
  return middleware;
}

function createModules() {
  specialHandlers = createSpecialHandlers();
  authSpy = vi.fn(() => true);
  handleToolCall = vi.fn(async () => ({
    isError: false,
    content: [{ type: 'text', text: 'ok' }],
  }));

  currentModules = {
    db: {
      getDefaultProvider: vi.fn(() => 'codex'),
    },
    taskManager: {},
    v2Schemas: {
      validateInferenceRequest: vi.fn(async (body) => ({
        valid: true,
        errors: [],
        value: body,
      })),
    },
    v2Middleware: {
      requestId: vi.fn((req, _res, next) => {
        req.requestId = req.requestId || 'req-from-middleware';
        next();
      }),
      validateRequest: vi.fn((schema = {}) => createValidateRequestMiddleware(schema)),
      normalizeError: vi.fn((error, req) => ({
        status: error.status || 500,
        body: {
          error: {
            code: 'normalized_error',
            message: error.message,
            request_id: req.requestId,
          },
        },
      })),
    },
    openapiGenerator: {
      generateOpenApiSpec: vi.fn(() => ({ openapi: '3.0.3', routes: 179 })),
    },
    middleware: {
      sendJson: vi.fn((res, data, status = 200) => {
        defaultSendJson(res, data, status);
      }),
    },
    v2Inference: createHandlerModule([
      'handleV2Inference',
      'handleV2ProviderInference',
      'handleV2TaskEvents',
      'handleV2ListProviders',
      'handleV2ProviderCapabilities',
      'handleV2ProviderModels',
      'handleV2ProviderHealth',
      'handleV2ProviderDetail',
      'handleV2RemoteRun',
      'handleV2RemoteTest',
    ]),
    v2TaskHandlers: createHandlerModule(V2_TASK_HANDLER_NAMES),
    v2WorkflowHandlers: createHandlerModule(V2_WORKFLOW_HANDLER_NAMES),
    v2GovernanceHandlers: createHandlerModule(V2_GOVERNANCE_HANDLER_NAMES),
    v2AnalyticsHandlers: createHandlerModule(V2_ANALYTICS_HANDLER_NAMES),
    v2InfrastructureHandlers: createHandlerModule(V2_INFRASTRUCTURE_HANDLER_NAMES),
  };

  specialHandlers.handleV2Inference = currentModules.v2Inference.handleV2Inference;
  specialHandlers.handleV2ProviderInference = currentModules.v2Inference.handleV2ProviderInference;
  specialHandlers.handleV2TaskEvents = currentModules.v2Inference.handleV2TaskEvents;
  specialHandlers.handleV2ListProviders = currentModules.v2Inference.handleV2ListProviders;
  specialHandlers.handleV2ProviderCapabilities = currentModules.v2Inference.handleV2ProviderCapabilities;
  specialHandlers.handleV2ProviderModels = currentModules.v2Inference.handleV2ProviderModels;
  specialHandlers.handleV2ProviderHealth = currentModules.v2Inference.handleV2ProviderHealth;
  specialHandlers.handleV2ProviderDetail = currentModules.v2Inference.handleV2ProviderDetail;
  specialHandlers.handleV2RemoteRun = currentModules.v2Inference.handleV2RemoteRun;
  specialHandlers.handleV2RemoteTest = currentModules.v2Inference.handleV2RemoteTest;
}

function installModuleMocks() {
  installCjsModuleMock('../database', currentModules.db);
  installCjsModuleMock('../db/provider-routing-core', currentModules.db);
  installCjsModuleMock('../task-manager', currentModules.taskManager);
  installCjsModuleMock('../api/v2-schemas', currentModules.v2Schemas);
  installCjsModuleMock('../api/v2-middleware', currentModules.v2Middleware);
  installCjsModuleMock('../api/openapi-generator', currentModules.openapiGenerator);
  installCjsModuleMock('../api/middleware', currentModules.middleware);
  installCjsModuleMock('../api/v2-inference', currentModules.v2Inference);
  installCjsModuleMock('../api/v2-task-handlers', currentModules.v2TaskHandlers);
  installCjsModuleMock('../api/v2-workflow-handlers', currentModules.v2WorkflowHandlers);
  installCjsModuleMock('../api/v2-governance-handlers', currentModules.v2GovernanceHandlers);
  installCjsModuleMock('../api/v2-analytics-handlers', currentModules.v2AnalyticsHandlers);
  installCjsModuleMock('../api/v2-infrastructure-handlers', currentModules.v2InfrastructureHandlers);
}

function loadModules() {
  routes = require(ROUTE_MODULE);
  v2Dispatch = require(V2_DISPATCH_MODULE);
}

function findRoute(predicate, label = 'route') {
  const route = routes.find(predicate);
  if (!route) {
    throw new Error(`Unable to find ${label}`);
  }
  return route;
}

function findStringRoute(method, path) {
  return findRoute(
    (route) => route.method === method && route.path === path,
    `${method} ${path}`,
  );
}

function findRegexRoute(method, source) {
  return findRoute(
    (route) => route.method === method
      && route.path instanceof RegExp
      && route.path.source === source,
    `${method} ${source}`,
  );
}

function findRouteByHandlerName(handlerName) {
  return findRoute(
    (route) => route.handlerName === handlerName,
    handlerName,
  );
}

function resolveHandler(route) {
  if (!route.handlerName) {
    return null;
  }

  return specialHandlers[route.handlerName] || v2Dispatch.V2_CP_HANDLER_LOOKUP[route.handlerName] || null;
}

function executeMiddleware(middlewareFn, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;

    function next(error) {
      if (settled) {
        return;
      }

      settled = true;

      if (error) {
        reject(error);
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
        .catch((error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
    } catch (error) {
      reject(error);
    }
  });
}

async function runMiddlewares(middlewares, req, res) {
  for (const middlewareFn of middlewares || []) {
    const shouldContinue = await executeMiddleware(middlewareFn, req, res);
    if (!shouldContinue) {
      return false;
    }
  }

  return true;
}

async function dispatchRequest({
  method = 'GET',
  url = '/',
  headers = {},
  body = undefined,
} = {}) {
  const req = createMockReq({ method, url, headers, body });
  const res = createMockRes();
  const pathname = url.split('?')[0];

  for (const route of routes) {
    if (route.method !== method) continue;

    let match = null;

    if (typeof route.path === 'string') {
      if (route.path !== pathname) continue;
      match = [];
    } else {
      match = pathname.match(route.path);
      if (!match) continue;
    }

    const shouldSkipAuth = route.skipAuth === true
      || (Array.isArray(route.skipAuth) && route.skipAuth.includes(pathname));

    if (!shouldSkipAuth && !authSpy(req, route)) {
      currentModules.middleware.sendJson(res, { error: 'Unauthorized' }, 401, req);
      return { req, res, route };
    }

    const routeParams = [];
    const mappedParams = {};

    if (route.mapParams && match) {
      route.mapParams.forEach((param, index) => {
        const value = match[index + 1];
        if (param) {
          mappedParams[param] = value;
          routeParams.push(value);
        }
      });
    }

    req.params = mappedParams;
    req.query = parseQuery(url);

    try {
      if (route.middleware?.length) {
        const shouldContinue = await runMiddlewares(route.middleware, req, res);
        if (!shouldContinue || res.headersSent) {
          return { req, res, route };
        }
      }

      const context = {
        requestId: req.requestId,
        params: req.params,
        query: req.query,
      };

      if (route.handler) {
        await route.handler(req, res, context, ...routeParams, req);
        return { req, res, route };
      }

      const resolvedHandler = resolveHandler(route);
      if (resolvedHandler) {
        await resolvedHandler(req, res, context, ...routeParams, req);
        return { req, res, route };
      }

      let args = {};

      if (route.mapBody) {
        args = req.body || {};
      }

      if (route.mapQuery) {
        Object.assign(args, req.query);
      }

      Object.assign(args, req.params);

      const result = await handleToolCall(route.tool, args);

      if (result.isError) {
        currentModules.middleware.sendJson(res, {
          error: result.content?.[0]?.text || 'Unknown error',
        }, 400, req);
      } else {
        currentModules.middleware.sendJson(res, {
          tool: route.tool,
          result: result.content?.[0]?.text || '',
        }, 200, req);
      }
    } catch (error) {
      if (isV2Route(route)) {
        const normalized = currentModules.v2Middleware.normalizeError(error, req);
        currentModules.middleware.sendJson(res, normalized.body, normalized.status, req);
      } else {
        currentModules.middleware.sendJson(res, { error: error.message }, 500, req);
      }
    }

    return { req, res, route };
  }

  currentModules.middleware.sendJson(res, { error: 'Not found' }, 404, req);
  return { req, res, route: null };
}

beforeEach(() => {
  vi.resetModules();
  clearLoadedModules();
  createModules();
  installModuleMocks();
  loadModules();
});

describe('api/routes route table', () => {
  it('exports a large flat route table', () => {
    expect(Array.isArray(routes)).toBe(true);
    expect(routes.length).toBeGreaterThan(170);
  });

  it('only marks openapi and shutdown routes as skipAuth', () => {
    const skipAuthPaths = routes
      .filter((route) => route.skipAuth === true)
      .map((route) => route.path);

    expect(skipAuthPaths).toEqual([
      '/api/openapi.json',
      '/api/bootstrap/workstation',
      '/api/auth/login',
      '/api/auth/setup',
      '/api/auth/status',
      '/api/shutdown',
    ]);
  });

  it('includes both discovery and control-plane GET /api/v2/providers routes', () => {
    const matches = routes.filter((route) => (
      route.method === 'GET'
      && route.path === '/api/v2/providers'
    ));

    expect(matches).toHaveLength(2);
    expect(matches.map((route) => route.handlerName)).toEqual([
      'handleV2ListProviders',
      'handleV2CpListProviders',
    ]);
  });

  it('keeps host activity before host detail to avoid regex shadowing', () => {
    const activityIndex = routes.findIndex((route) => (
      route.method === 'GET'
      && route.path === '/api/v2/hosts/activity'
    ));
    const detailIndex = routes.findIndex((route) => (
      route.method === 'GET'
      && route.path instanceof RegExp
      && route.path.source === '^\\/api\\/v2\\/hosts\\/([^/]+)$'
    ));

    expect(activityIndex).toBeGreaterThanOrEqual(0);
    expect(detailIndex).toBeGreaterThan(activityIndex);
  });

  it('registers the legacy task CRUD routes', () => {
    expect(findStringRoute('POST', '/api/tasks').tool).toBe('smart_submit_task');
    expect(findStringRoute('POST', '/api/tasks/submit').tool).toBe('submit_task');
    expect(findStringRoute('GET', '/api/tasks').tool).toBe('list_tasks');
    expect(findRegexRoute('GET', '^\\/api\\/tasks\\/([^/]+)$').mapParams).toEqual(['task_id']);
    expect(findRegexRoute('DELETE', '^\\/api\\/tasks\\/([^/]+)$').tool).toBe('cancel_task');
    expect(findStringRoute('DELETE', '/api/tasks').tool).toBe('delete_task');
  });

  it('registers the legacy workflow routes', () => {
    expect(findStringRoute('POST', '/api/workflows').tool).toBe('create_workflow');
    expect(findRegexRoute('POST', '^\\/api\\/workflows\\/([^/]+)\\/run$').tool).toBe('run_workflow');
    expect(findStringRoute('GET', '/api/workflows').tool).toBe('list_workflows');
    expect(findStringRoute('POST', '/api/workflows/await').tool).toBe('await_workflow');
    expect(findStringRoute('POST', '/api/workflows/feature').tool).toBe('create_feature_workflow');
  });

  it('registers provider and ollama host routes', () => {
    expect(findStringRoute('GET', '/api/providers').tool).toBe('list_providers');
    expect(findStringRoute('GET', '/api/provider-quotas').handlerName).toBe('handleGetProviderQuotas');
    expect(findStringRoute('POST', '/api/providers/configure').tool).toBe('configure_provider');
    expect(findStringRoute('POST', '/api/providers/default').tool).toBe('set_default_provider');
    expect(findStringRoute('GET', '/api/ollama/hosts').tool).toBe('list_ollama_hosts');
    expect(findRegexRoute('POST', '^\\/api\\/ollama\\/hosts\\/([^/]+)\\/refresh-models$').tool).toBe('refresh_host_models');
  });

  it('registers webhook, validation, and metrics control-plane routes', () => {
    expect(findStringRoute('GET', '/api/v2/webhooks').handlerName).toBe('handleV2CpListWebhooks');
    expect(findStringRoute('POST', '/api/v2/webhooks').handlerName).toBe('handleV2CpAddWebhook');
    expect(findRegexRoute('POST', '^\\/api\\/v2\\/webhooks\\/([^/]+)\\/test$').handlerName).toBe('handleV2CpTestWebhook');
    expect(findStringRoute('POST', '/api/v2/validation/verify-and-fix').handlerName).toBe('handleV2CpAutoVerifyAndFix');
    expect(findStringRoute('GET', '/api/v2/metrics/prometheus').handlerName).toBe('handleV2CpPrometheusMetrics');
  });

  it('registers administrative free-tier and shutdown routes', () => {
    expect(findStringRoute('GET', '/api/free-tier/status').handlerName).toBe('handleGetFreeTierStatus');
    expect(findStringRoute('GET', '/api/free-tier/history').handlerName).toBe('handleGetFreeTierHistory');
    expect(findStringRoute('GET', '/api/free-tier/auto-scale').handlerName).toBe('handleGetFreeTierAutoScale');
    expect(findStringRoute('POST', '/api/shutdown').handlerName).toBe('handleShutdown');
  });

  it('registers the SSE ticket exchange route', () => {
    expect(findStringRoute('POST', '/api/auth/sse-ticket').handlerName).toBe('handleCreateSseTicket');
  });

  it('has more than one hundred v2 control-plane routes', () => {
    const v2CpRoutes = routes.filter((route) => (
      typeof route.handlerName === 'string'
      && route.handlerName.startsWith('handleV2Cp')
    ));

    expect(v2CpRoutes.length).toBeGreaterThan(100);
  });

  it('maps every handleV2Cp route handler into the v2 dispatch lookup', () => {
    const routeHandlerNames = getV2CpRouteHandlerNames();
    const lookupHandlerNames = new Set(Object.keys(v2Dispatch.V2_CP_HANDLER_LOOKUP || {}));
    const missingHandlers = routeHandlerNames.filter((handlerName) => !lookupHandlerNames.has(handlerName));

    expect(
      missingHandlers,
      missingHandlers.length === 0
        ? undefined
        : `Missing V2 control-plane lookup handlers: ${missingHandlers.join(', ')}`,
    ).toEqual([]);
  });

  it('covers workflow control-plane routes broadly', () => {
    const workflowRoutes = routes.filter((route) => (
      typeof route.handlerName === 'string'
      && /Workflow|FeatureWorkflow/.test(route.handlerName)
    ));

    expect(workflowRoutes.length).toBeGreaterThanOrEqual(11);
  });

  it('covers governance control-plane routes broadly', () => {
    const governanceRoutes = routes.filter((route) => (
      typeof route.handlerName === 'string'
      && /Approval|Schedule|Policy|PlanProject|ImportPlan|Benchmark|Tuning|Webhook|Verify|Conflict|Attestation/.test(route.handlerName)
    ));

    expect(governanceRoutes.length).toBeGreaterThanOrEqual(30);
  });

  it('covers analytics control-plane routes broadly', () => {
    const analyticsRoutes = routes.filter((route) => (
      typeof route.handlerName === 'string'
      && /Stats|TimeSeries|Quality|Budget|Strategic|FreeTier|Prometheus|Routing|Notification/.test(route.handlerName)
    ));

    expect(analyticsRoutes.length).toBeGreaterThanOrEqual(20);
  });

  it('covers infrastructure control-plane routes broadly', () => {
    const infrastructureRoutes = routes.filter((route) => (
      typeof route.handlerName === 'string'
      && /Host|PeekHost|Credential|Agent|Coordination|Percentiles/.test(route.handlerName)
    ));

    expect(infrastructureRoutes.length).toBeGreaterThanOrEqual(20);
  });

  it('maps host credential routes with constrained credential types', () => {
    const route = findRegexRoute(
      'PUT',
      '^\\/api\\/v2\\/hosts\\/([^/]+)\\/credentials\\/(ssh|http_auth|windows)$',
    );

    expect(route.handlerName).toBe('handleV2CpSaveCredential');
    expect(route.mapParams).toEqual(['host_name', 'credential_type']);
  });

  it('maps plan project actions with both project id and action params', () => {
    const route = findRegexRoute(
      'POST',
      '^\\/api\\/v2\\/plan-projects\\/([^/]+)\\/(pause|resume|retry)$',
    );

    expect(route.handlerName).toBe('handleV2CpPlanProjectAction');
    expect(route.mapParams).toEqual(['project_id', 'action']);
  });
});

describe('openapi route', () => {
  it('serves the generated spec through sendJson', async () => {
    const route = findStringRoute('GET', '/api/openapi.json');
    const req = createMockReq({ method: 'GET', url: '/api/openapi.json' });
    const res = createMockRes();

    await route.handler(req, res, { requestId: req.requestId, params: {}, query: {} });

    expect(currentModules.openapiGenerator.generateOpenApiSpec).toHaveBeenCalledTimes(1);
    expect(currentModules.middleware.sendJson).toHaveBeenCalledWith(
      res,
      { openapi: '3.0.3', routes: 179 },
      200,
      req,
    );
    expect(parseJsonBody(res)).toEqual({ openapi: '3.0.3', routes: 179 });
  });

  it('passes the live route table into generateOpenApiSpec', async () => {
    const route = findStringRoute('GET', '/api/openapi.json');
    const req = createMockReq({ method: 'GET', url: '/api/openapi.json' });
    const res = createMockRes();

    currentModules.openapiGenerator.generateOpenApiSpec.mockImplementationOnce((passedRoutes) => {
      expect(passedRoutes).toBe(routes);
      return { ok: true };
    });

    await route.handler(req, res, { requestId: req.requestId, params: {}, query: {} });

    expect(parseJsonBody(res)).toEqual({ ok: true });
  });

  it('registers the openapi endpoint as a concrete handler route', () => {
    const route = findStringRoute('GET', '/api/openapi.json');

    expect(route.handlerName).toBe('handleOpenApiSpec');
    expect(typeof route.handler).toBe('function');
    expect(route.skipAuth).toBe(true);
  });
});

describe('v2 middleware wiring', () => {
  it('builds the v2 inference route with request id and request validation middleware', () => {
    const route = findRouteByHandlerName('handleV2Inference');

    expect(route.middleware).toHaveLength(2);
    expect(route.middleware[0]).toBe(currentModules.v2Middleware.requestId);
    expect(route.middleware[1]._schema).toEqual(expect.objectContaining({
      body: expect.objectContaining({
        validator: currentModules.v2Schemas.validateInferenceRequest,
        options: expect.any(Function),
      }),
    }));
  });

  it('passes the database default provider into inference body validation', async () => {
    const route = findRouteByHandlerName('handleV2Inference');
    const req = createMockReq({
      method: 'POST',
      url: '/api/v2/inference',
      body: { prompt: 'ship it' },
    });
    const res = createMockRes();
    const next = createNext();

    currentModules.db.getDefaultProvider.mockReturnValueOnce('groq');

    await route.middleware[1](req, res, next);

    expect(currentModules.v2Schemas.validateInferenceRequest).toHaveBeenCalledWith(
      { prompt: 'ship it' },
      { defaultProvider: 'groq' },
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('decodes provider ids before provider inference validation runs', async () => {
    const result = await dispatchRequest({
      method: 'POST',
      url: '/api/v2/providers/codex%2Fedge/inference',
      body: { prompt: 'hello' },
    });

    expect(currentModules.v2Schemas.validateInferenceRequest).toHaveBeenCalledWith(
      { prompt: 'hello' },
      { defaultProvider: 'codex/edge' },
    );
    expect(result.req.params.provider_id).toBe('codex/edge');
    expect(currentModules.v2Inference.handleV2ProviderInference).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid provider id encodings before hitting the handler', async () => {
    const result = await dispatchRequest({
      method: 'POST',
      url: '/api/v2/providers/%E0%A4%A/inference',
      body: { prompt: 'hello' },
    });

    expect(result.res.statusCode).toBe(400);
    expect(parseJsonBody(result.res)).toEqual(expect.objectContaining({
      error: expect.objectContaining({
        code: 'validation_failed',
      }),
    }));
    expect(currentModules.v2Inference.handleV2ProviderInference).not.toHaveBeenCalled();
  });

  it('decodes provider ids for discovery model routes', async () => {
    const result = await dispatchRequest({
      method: 'GET',
      url: '/api/v2/providers/openrouter%2Ffree/models',
    });

    expect(currentModules.v2Inference.handleV2ProviderModels).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        params: { provider_id: 'openrouter/free' },
      }),
      'openrouter%2Ffree',
      expect.any(Object),
    );
    expect(result.req.params.provider_id).toBe('openrouter/free');
  });

  it('decodes task ids for v2 task event routes', async () => {
    const result = await dispatchRequest({
      method: 'GET',
      url: '/api/v2/tasks/task%2F42/events',
    });

    expect(currentModules.v2Inference.handleV2TaskEvents).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        params: { task_id: 'task/42' },
      }),
      'task%2F42',
      expect.any(Object),
    );
    expect(result.req.params.task_id).toBe('task/42');
  });

  it('decodes project paths for project tuning deletion routes', async () => {
    const result = await dispatchRequest({
      method: 'DELETE',
      url: '/api/v2/tuning/C%3A%2FWork%20Tree',
    });

    expect(currentModules.v2GovernanceHandlers.handleDeleteProjectTuning).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        params: { project_path: 'C:/Work Tree' },
      }),
      'C%3A%2FWork%20Tree',
      expect.any(Object),
    );
    expect(result.req.params.project_path).toBe('C:/Work Tree');
  });

  it('extracts project_id and action for plan project action routes', async () => {
    const result = await dispatchRequest({
      method: 'POST',
      url: '/api/v2/plan-projects/proj-7/retry',
    });

    expect(currentModules.v2GovernanceHandlers.handlePlanProjectAction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        params: { project_id: 'proj-7', action: 'retry' },
      }),
      'proj-7',
      'retry',
      expect.any(Object),
    );
    expect(result.req.params).toEqual({
      project_id: 'proj-7',
      action: 'retry',
    });
  });

  it('puts requestId and validation middleware on every v2 route', () => {
    const v2Routes = routes.filter((route) => route.middleware?.length);

    expect(v2Routes.length).toBeGreaterThan(100);

    for (const route of v2Routes) {
      expect(route.middleware).toHaveLength(2);
      expect(route.middleware[0]).toBe(currentModules.v2Middleware.requestId);
      expect(typeof route.middleware[1]).toBe('function');
    }
  });
});

describe('task routes', () => {
  it('dispatches POST /api/tasks to smart_submit_task with the request body', async () => {
    const result = await dispatchRequest({
      method: 'POST',
      url: '/api/tasks',
      body: { task: 'build it', provider: 'codex' },
    });

    expect(result.route.tool).toBe('smart_submit_task');
    expect(handleToolCall).toHaveBeenCalledWith('smart_submit_task', {
      task: 'build it',
      provider: 'codex',
    });
    expect(result.res.statusCode).toBe(200);
  });

  it('dispatches GET /api/tasks with query parameters', async () => {
    await dispatchRequest({
      method: 'GET',
      url: '/api/tasks?status=queued&limit=5',
    });

    expect(handleToolCall).toHaveBeenCalledWith('list_tasks', {
      status: 'queued',
      limit: '5',
    });
  });

  it('dispatches GET /api/tasks/:task_id with extracted params', async () => {
    await dispatchRequest({
      method: 'GET',
      url: '/api/tasks/task-42',
    });

    expect(handleToolCall).toHaveBeenCalledWith('get_result', {
      task_id: 'task-42',
    });
  });

  it('dispatches DELETE /api/tasks/:task_id with params overriding the query string', async () => {
    await dispatchRequest({
      method: 'DELETE',
      url: '/api/tasks/task-42?task_id=wrong&force=true',
    });

    expect(handleToolCall).toHaveBeenCalledWith('cancel_task', {
      task_id: 'task-42',
      force: 'true',
    });
  });

  it('dispatches POST /api/tasks/:task_id/commit with params and body', async () => {
    await dispatchRequest({
      method: 'POST',
      url: '/api/tasks/task-88/commit',
      body: { message: 'ship it' },
    });

    expect(handleToolCall).toHaveBeenCalledWith('commit_task', {
      message: 'ship it',
      task_id: 'task-88',
    });
  });

  it('translates tool errors into 400 JSON responses', async () => {
    handleToolCall.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'bad task payload' }],
    });

    const result = await dispatchRequest({
      method: 'POST',
      url: '/api/tasks',
      body: { task: '' },
    });

    expect(result.res.statusCode).toBe(400);
    expect(parseJsonBody(result.res)).toEqual({
      error: 'bad task payload',
    });
  });
});

describe('workflow routes', () => {
  it('dispatches POST /api/workflows to create_workflow', async () => {
    await dispatchRequest({
      method: 'POST',
      url: '/api/workflows',
      body: { name: 'release train' },
    });

    expect(handleToolCall).toHaveBeenCalledWith('create_workflow', {
      name: 'release train',
    });
  });

  it('dispatches POST /api/workflows/:workflow_id/tasks with params merged into the body', async () => {
    await dispatchRequest({
      method: 'POST',
      url: '/api/workflows/wf-12/tasks',
      body: { workflow_id: 'wrong', task_description: 'verify' },
    });

    expect(handleToolCall).toHaveBeenCalledWith('add_workflow_task', {
      workflow_id: 'wf-12',
      task_description: 'verify',
    });
  });

  it('dispatches POST /api/workflows/:workflow_id/cancel', async () => {
    await dispatchRequest({
      method: 'POST',
      url: '/api/workflows/wf-15/cancel',
      body: { reason: 'stop' },
    });

    expect(handleToolCall).toHaveBeenCalledWith('cancel_workflow', {
      workflow_id: 'wf-15',
      reason: 'stop',
    });
  });

  it('dispatches POST /api/workflows/await', async () => {
    await dispatchRequest({
      method: 'POST',
      url: '/api/workflows/await',
      body: { workflow_id: 'wf-16' },
    });

    expect(handleToolCall).toHaveBeenCalledWith('await_workflow', {
      workflow_id: 'wf-16',
    });
  });

  it('dispatches POST /api/workflows/feature', async () => {
    await dispatchRequest({
      method: 'POST',
      url: '/api/workflows/feature',
      body: { title: 'new feature' },
    });

    expect(handleToolCall).toHaveBeenCalledWith('create_feature_workflow', {
      title: 'new feature',
    });
  });
});

describe('provider and infrastructure routes', () => {
  it('dispatches POST /api/providers/configure', async () => {
    await dispatchRequest({
      method: 'POST',
      url: '/api/providers/configure',
      body: { provider: 'groq', enabled: true },
    });

    expect(handleToolCall).toHaveBeenCalledWith('configure_provider', {
      provider: 'groq',
      enabled: true,
    });
  });

  it('dispatches DELETE /api/ollama/hosts/:host_id', async () => {
    await dispatchRequest({
      method: 'DELETE',
      url: '/api/ollama/hosts/host-9',
    });

    expect(handleToolCall).toHaveBeenCalledWith('remove_ollama_host', {
      host_id: 'host-9',
    });
  });

  it('dispatches the v2 provider capability route to the discovery handler', async () => {
    const result = await dispatchRequest({
      method: 'GET',
      url: '/api/v2/providers/codex%2Fedge/capabilities',
    });

    expect(currentModules.v2Inference.handleV2ProviderCapabilities).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        params: { provider_id: 'codex/edge' },
      }),
      'codex%2Fedge',
      expect.any(Object),
    );
    expect(result.res.statusCode).toBe(200);
  });

  it('dispatches the v2 get task route to the control-plane task handler', async () => {
    await dispatchRequest({
      method: 'GET',
      url: '/api/v2/tasks/task-17',
    });

    expect(currentModules.v2TaskHandlers.handleGetTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        params: { task_id: 'task-17' },
      }),
      'task-17',
      expect.any(Object),
    );
  });

  it('dispatches the v2 add workflow task route to the workflow handler', async () => {
    await dispatchRequest({
      method: 'POST',
      url: '/api/v2/workflows/wf-3/tasks',
      body: { task_description: 'lint' },
    });

    expect(currentModules.v2WorkflowHandlers.handleAddWorkflowTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        params: { workflow_id: 'wf-3' },
      }),
      'wf-3',
      expect.any(Object),
    );
  });

  it('dispatches the v2 approval decision route to the governance handler', async () => {
    await dispatchRequest({
      method: 'POST',
      url: '/api/v2/approvals/appr-4/decide',
      body: { decision: 'approve' },
    });

    expect(currentModules.v2GovernanceHandlers.handleApprovalDecision).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        params: { approval_id: 'appr-4' },
      }),
      'appr-4',
      expect.any(Object),
    );
  });

  it('dispatches the v2 stats overview route to the analytics handler', async () => {
    await dispatchRequest({
      method: 'GET',
      url: '/api/v2/stats/overview',
    });

    expect(currentModules.v2AnalyticsHandlers.handleStatsOverview).toHaveBeenCalledTimes(1);
  });

  it('dispatches the v2 save credential route with both mapped params', async () => {
    await dispatchRequest({
      method: 'PUT',
      url: '/api/v2/hosts/build-box/credentials/ssh',
      body: { secret: 'abc' },
    });

    expect(currentModules.v2InfrastructureHandlers.handleSaveCredential).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        params: {
          host_name: 'build-box',
          credential_type: 'ssh',
        },
      }),
      'build-box',
      'ssh',
      expect.any(Object),
    );
  });

  it('dispatches the v2 agent health route', async () => {
    await dispatchRequest({
      method: 'GET',
      url: '/api/v2/agents/agent-3/health',
    });

    expect(currentModules.v2InfrastructureHandlers.handleAgentHealth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        params: { agent_id: 'agent-3' },
      }),
      'agent-3',
      expect.any(Object),
    );
  });
});

describe('auth, error, and not-found integration', () => {
  it('calls the auth gate for protected routes', async () => {
    await dispatchRequest({
      method: 'GET',
      url: '/api/tasks',
    });

    expect(authSpy).toHaveBeenCalledTimes(1);
    expect(authSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/api/tasks' }),
      expect.objectContaining({ tool: 'list_tasks' }),
    );
  });

  it('bypasses auth for skipAuth routes', async () => {
    await dispatchRequest({
      method: 'GET',
      url: '/api/openapi.json',
    });

    expect(authSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when auth fails on a protected route', async () => {
    authSpy.mockReturnValueOnce(false);

    const result = await dispatchRequest({
      method: 'GET',
      url: '/api/providers',
    });

    expect(result.res.statusCode).toBe(401);
    expect(parseJsonBody(result.res)).toEqual({ error: 'Unauthorized' });
    expect(handleToolCall).not.toHaveBeenCalled();
  });

  it('dispatches /api/shutdown without auth because the route is marked skipAuth', async () => {
    authSpy.mockReturnValue(false);

    const result = await dispatchRequest({
      method: 'POST',
      url: '/api/shutdown',
      body: { reason: 'tests' },
    });

    expect(authSpy).not.toHaveBeenCalled();
    expect(specialHandlers.handleShutdown).toHaveBeenCalledTimes(1);
    expect(result.route.handlerName).toBe('handleShutdown');
  });

  it('normalizes thrown v2 handler errors', async () => {
    currentModules.v2TaskHandlers.handleGetTask.mockImplementationOnce(() => {
      const error = new Error('task exploded');
      error.status = 409;
      throw error;
    });

    const result = await dispatchRequest({
      method: 'GET',
      url: '/api/v2/tasks/task-99',
    });

    expect(currentModules.v2Middleware.normalizeError).toHaveBeenCalledTimes(1);
    expect(result.res.statusCode).toBe(409);
    expect(parseJsonBody(result.res)).toEqual({
      error: {
        code: 'normalized_error',
        message: 'task exploded',
        request_id: 'req-dispatch',
      },
    });
  });

  it('returns a 500 payload for thrown legacy handler errors', async () => {
    specialHandlers.handleGetFreeTierStatus.mockImplementationOnce(() => {
      throw new Error('free tier failure');
    });

    const result = await dispatchRequest({
      method: 'GET',
      url: '/api/free-tier/status',
    });

    expect(result.res.statusCode).toBe(500);
    expect(parseJsonBody(result.res)).toEqual({
      error: 'free tier failure',
    });
  });

  it('short-circuits before the handler when middleware validation fails', async () => {
    const result = await dispatchRequest({
      method: 'GET',
      url: '/api/v2/providers/%E0%A4%A/health',
    });

    expect(result.res.statusCode).toBe(400);
    expect(parseJsonBody(result.res)).toEqual(expect.objectContaining({
      error: expect.objectContaining({
        code: 'validation_failed',
      }),
    }));
    expect(currentModules.v2Inference.handleV2ProviderHealth).not.toHaveBeenCalled();
  });

  it('returns a 404 for unknown routes', async () => {
    const result = await dispatchRequest({
      method: 'PATCH',
      url: '/api/does-not-exist',
    });

    expect(result.route).toBeNull();
    expect(result.res.statusCode).toBe(404);
    expect(parseJsonBody(result.res)).toEqual({
      error: 'Not found',
    });
  });
});
