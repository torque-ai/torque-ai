'use strict';

const HANDLER_MODULE = '../api/v2-governance-handlers';
const HANDLER_MODULE_PATHS = [
  HANDLER_MODULE,
  '../api/middleware',
  '../api/v2-control-plane',
  '../database',
  '../db/config-core',
  '../db/file-tracking',
  '../db/host-management',
  '../db/project-config-core',
  '../db/provider-routing-core',
  '../db/scheduling-automation',
  '../db/task-core',
  '../db/validation-rules',
  '../db/webhooks-streaming',
  '../handlers/policy-handlers',
  '../tools',
];
const PROVIDER_CORE_MODULE_PATHS = [
  '../db/provider-routing-core',
  '../logger',
  '../db/smart-routing',
  '../db/ollama-health',
  '../routing/template-store',
  '../db/provider-routing-extras',
  '../db/provider-health-history',
];
const FIXED_TIMESTAMP = '2026-03-10T12:34:56.789Z';

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearLoadedModules(modulePaths) {
  for (const modulePath of modulePaths) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that were not loaded.
    }
  }
}

function cloneValue(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    _body: null,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
    },
    end(body) {
      this._body = typeof body === 'string' ? JSON.parse(body) : body;
    },
  };
}

function createMockContext(overrides = {}) {
  const { parsedBody, ...reqOverrides } = overrides;
  const req = {
    params: {},
    query: {},
    body: undefined,
    headers: {},
    requestId: 'req-123',
    ...reqOverrides,
  };

  if (parsedBody !== undefined) {
    req._parsedBody = parsedBody;
  }

  return {
    req,
    res: createMockRes(),
  };
}

function expectMeta(body, requestId = 'req-123') {
  expect(body.meta).toEqual({
    request_id: requestId,
    timestamp: FIXED_TIMESTAMP,
  });
}

function expectSuccessEnvelope(res, data, options = {}) {
  const {
    requestId = 'req-123',
    status = 200,
  } = options;

  expect(res.statusCode).toBe(status);
  expect(res._body.data).toEqual(data);
  expectMeta(res._body, requestId);
}

function expectErrorEnvelope(res, {
  code,
  message,
  status = 400,
  details = {},
  requestId = 'req-123',
}) {
  expect(res.statusCode).toBe(status);
  expect(res._body.error).toEqual({
    code,
    message,
    details,
    request_id: requestId,
  });
  expectMeta(res._body, requestId);
}

function createDefaultModules() {
  return {
    db: {
      listPlanProjects: vi.fn().mockReturnValue([]),
      getPlanProject: vi.fn().mockReturnValue(null),
      getPlanProjectTasks: vi.fn().mockReturnValue([]),
      listKnownProjects: vi.fn().mockReturnValue([]),
      deletePlanProject: vi.fn(),
      updateTaskStatus: vi.fn(),
      getConfig: vi.fn(() => null),
    },
    middleware: {
      parseBody: vi.fn(async (req) => req?._parsedBody ?? req?.body ?? {}),
      sendJson: vi.fn((res, data, status = 200, req = null) => {
        const headers = { 'Content-Type': 'application/json' };
        if (req?.requestId) {
          headers['X-Request-ID'] = req.requestId;
        }
        res.writeHead(status, headers);
        res.end(JSON.stringify(data));
      }),
    },
    policyHandlers: {
      isCoreError: vi.fn((result) => Boolean(result?.error?.code)),
      listPoliciesCore: vi.fn().mockReturnValue({ policies: [] }),
      getPolicyCore: vi.fn().mockReturnValue({ policy: null }),
      setPolicyModeCore: vi.fn().mockReturnValue({ success: true }),
      evaluatePoliciesCore: vi.fn().mockReturnValue({ results: [] }),
      listPolicyEvaluationsCore: vi.fn().mockReturnValue({ evaluations: [] }),
      getPolicyEvaluationCore: vi.fn().mockReturnValue({ evaluation: null }),
      overridePolicyDecisionCore: vi.fn().mockReturnValue({ override_id: 'override-1' }),
    },
    tools: {
      handleToolCall: vi.fn().mockResolvedValue({ success: true }),
    },
    taskManager: {
      cancelTask: vi.fn(),
    },
  };
}

function createMockProviderRoutingCore(initialProvider = {}) {
  const state = {
    provider: {
      provider: 'codex',
      enabled: 1,
      priority: 10,
      transport: 'hybrid',
      max_concurrent: 3,
      default_model: null,
      timeout_minutes: null,
      quota_error_patterns: [],
      ...initialProvider,
    },
  };

  return {
    state,
    getProvider: vi.fn((providerId) => {
      if (providerId !== state.provider.provider) return null;
      return {
        ...cloneValue(state.provider),
        enabled: Boolean(state.provider.enabled),
      };
    }),
    updateProvider: vi.fn((providerId, updates) => {
      if (providerId !== state.provider.provider) return null;
      Object.assign(state.provider, updates);
      return {
        ...cloneValue(state.provider),
        enabled: Boolean(state.provider.enabled),
      };
    }),
  };
}

function loadHandlers(providerRoutingCore) {
  const currentModules = createDefaultModules();

  vi.resetModules();
  clearLoadedModules(HANDLER_MODULE_PATHS);

  installCjsModuleMock('../database', currentModules.db);
  installCjsModuleMock('../db/config-core', currentModules.db);
  installCjsModuleMock('../db/file-tracking', currentModules.db);
  installCjsModuleMock('../db/host-management', currentModules.db);
  installCjsModuleMock('../db/project-config-core', currentModules.db);
  installCjsModuleMock('../db/provider-routing-core', providerRoutingCore);
  installCjsModuleMock('../db/scheduling-automation', currentModules.db);
  installCjsModuleMock('../db/task-core', currentModules.db);
  installCjsModuleMock('../db/validation-rules', currentModules.db);
  installCjsModuleMock('../db/webhooks-streaming', currentModules.db);
  installCjsModuleMock('../api/middleware', currentModules.middleware);
  installCjsModuleMock('../handlers/policy-handlers', currentModules.policyHandlers);
  installCjsModuleMock('../tools', currentModules.tools);

  const handlers = require(HANDLER_MODULE);
  handlers.init(currentModules.taskManager);

  return {
    handlers,
    mocks: currentModules,
  };
}

function createProviderDbHarness(initialProvider = {}) {
  const state = {
    config: new Map([
      ['default_provider', 'codex'],
      ['ollama_fallback_provider', 'codex'],
      ['smart_routing_default_provider', 'ollama'],
      ['smart_routing_enabled', '1'],
    ]),
    providers: new Map([
      ['codex', {
        provider: 'codex',
        enabled: 1,
        priority: 10,
        transport: null,
        quota_error_patterns: '[]',
        max_concurrent: 3,
        default_model: null,
        timeout_minutes: null,
        ...initialProvider,
      }],
    ]),
  };

  const db = {
    prepare(sql) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      if (normalizedSql === 'SELECT value FROM config WHERE key = ?') {
        return {
          get(key) {
            return state.config.has(key) ? { value: state.config.get(key) } : undefined;
          },
        };
      }

      if (normalizedSql === 'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)') {
        return {
          run(key, value) {
            state.config.set(key, String(value));
            return { changes: 1 };
          },
        };
      }

      if (normalizedSql === 'SELECT * FROM provider_config WHERE provider = ?') {
        return {
          get(providerId) {
            return cloneValue(state.providers.get(providerId));
          },
        };
      }

      if (normalizedSql === 'SELECT * FROM provider_config ORDER BY priority ASC') {
        return {
          all() {
            return Array.from(state.providers.values())
              .sort((left, right) => (left.priority || 0) - (right.priority || 0))
              .map((provider) => cloneValue(provider));
          },
        };
      }

      if (normalizedSql.startsWith('UPDATE provider_config SET ') && normalizedSql.endsWith(' WHERE provider = ?')) {
        const setClause = normalizedSql.match(/^UPDATE provider_config SET (.+) WHERE provider = \?$/)[1];
        const columns = setClause.split(', ').map((part) => part.replace(' = ?', ''));
        return {
          run(...values) {
            const providerId = values[values.length - 1];
            const provider = state.providers.get(providerId);
            if (!provider) return { changes: 0 };
            columns.forEach((column, index) => {
              provider[column] = values[index];
            });
            return { changes: 1 };
          },
        };
      }

      throw new Error(`Unhandled SQL in provider DB harness: ${normalizedSql}`);
    },
    getConfig(key) {
      return state.config.get(key) || null;
    },
  };

  return { db, state };
}

function loadRealProviderRoutingCore(initialProvider = {}) {
  const loggerChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const { db, state } = createProviderDbHarness(initialProvider);

  vi.resetModules();
  clearLoadedModules(PROVIDER_CORE_MODULE_PATHS);

  installCjsModuleMock('../logger', {
    child: vi.fn(() => loggerChild),
  });
  installCjsModuleMock('../db/smart-routing', {
    init: vi.fn(),
    analyzeTaskForRouting: vi.fn(() => ({ provider: 'codex', chain: ['codex'] })),
    getProviderFallbackChain: vi.fn(() => ['codex']),
  });
  installCjsModuleMock('../db/ollama-health', {
    init: vi.fn(),
    isOllamaHealthy: vi.fn(() => true),
    probeOllamaHealth: vi.fn(),
    refreshOllamaHealth: vi.fn(),
    setOllamaHealthy: vi.fn(),
  });
  installCjsModuleMock('../routing/template-store', {
    setDb: vi.fn(),
  });
  installCjsModuleMock('../db/provider-routing-extras', {
    setDb: vi.fn(),
    createWorkflowFork: vi.fn(),
    getWorkflowFork: vi.fn(),
    listWorkflowForks: vi.fn(),
    updateWorkflowForkStatus: vi.fn(),
  });
  installCjsModuleMock('../db/provider-health-history', {
    setDb: vi.fn(),
    persistHealthWindow: vi.fn(),
    getHealthHistory: vi.fn(() => []),
    getHealthTrend: vi.fn(() => null),
    pruneHealthHistory: vi.fn(),
  });

  const core = require('../db/provider-routing-core');
  core.setDb(db);
  core.setGetTask(() => null);
  core.setHostManagement(null);

  return { core, state };
}

describe('api/v2-governance boolean validation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TIMESTAMP));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    clearLoadedModules(HANDLER_MODULE_PATHS);
    clearLoadedModules(PROVIDER_CORE_MODULE_PATHS);
    vi.resetModules();
  });

  it('rejects string enabled values for provider toggles', async () => {
    const providerRoutingCore = createMockProviderRoutingCore();
    const { handlers } = loadHandlers(providerRoutingCore);
    const { req, res } = createMockContext({
      params: { provider_id: 'codex' },
      body: { enabled: 'false' },
    });

    await handlers.handleProviderToggle(req, res);

    expect(providerRoutingCore.updateProvider).not.toHaveBeenCalled();
    expectErrorEnvelope(res, {
      code: 'validation_error',
      message: 'enabled must be a boolean',
      details: { field: 'enabled' },
    });
  });

  it('accepts boolean false for provider toggles', async () => {
    const providerRoutingCore = createMockProviderRoutingCore();
    const { handlers } = loadHandlers(providerRoutingCore);
    const { req, res } = createMockContext({
      params: { provider_id: 'codex' },
      body: { enabled: false },
    });

    await handlers.handleProviderToggle(req, res);

    expect(providerRoutingCore.updateProvider).toHaveBeenCalledWith('codex', { enabled: 0 });
    expectSuccessEnvelope(res, {
      provider: 'codex',
      enabled: false,
    });
  });

  it('accepts numeric enabled values for provider toggles and coerces them', async () => {
    const providerRoutingCore = createMockProviderRoutingCore({ enabled: 0 });
    const { handlers } = loadHandlers(providerRoutingCore);

    const disabledContext = createMockContext({
      params: { provider_id: 'codex' },
      body: { enabled: 0 },
    });
    await handlers.handleProviderToggle(disabledContext.req, disabledContext.res);

    expect(providerRoutingCore.updateProvider).toHaveBeenNthCalledWith(1, 'codex', { enabled: 0 });
    expectSuccessEnvelope(disabledContext.res, {
      provider: 'codex',
      enabled: false,
    });

    const enabledContext = createMockContext({
      params: { provider_id: 'codex' },
      body: { enabled: 1 },
    });
    await handlers.handleProviderToggle(enabledContext.req, enabledContext.res);

    expect(providerRoutingCore.updateProvider).toHaveBeenNthCalledWith(2, 'codex', { enabled: 1 });
    expectSuccessEnvelope(enabledContext.res, {
      provider: 'codex',
      enabled: true,
    });
  });

  it('rejects string enabled values for provider configuration', async () => {
    const providerRoutingCore = createMockProviderRoutingCore();
    const { handlers } = loadHandlers(providerRoutingCore);
    const { req, res } = createMockContext({
      params: { provider_id: 'codex' },
      body: { enabled: 'false' },
    });

    await handlers.handleConfigureProvider(req, res);

    expect(providerRoutingCore.updateProvider).not.toHaveBeenCalled();
    expectErrorEnvelope(res, {
      code: 'validation_error',
      message: 'enabled must be a boolean',
      details: { field: 'enabled' },
    });
  });

  it('accepts boolean false for provider configuration', async () => {
    const providerRoutingCore = createMockProviderRoutingCore();
    const { handlers } = loadHandlers(providerRoutingCore);
    const { req, res } = createMockContext({
      params: { provider_id: 'codex' },
      body: { enabled: false },
    });

    await handlers.handleConfigureProvider(req, res);

    expect(providerRoutingCore.updateProvider).toHaveBeenCalledWith('codex', { enabled: 0 });
    expect(res.statusCode).toBe(200);
    expect(res._body.data.provider).toBe('codex');
    expect(res._body.data.configured).toBe(true);
    expect(res._body.data.enabled).toBe(false);
    expectMeta(res._body);
  });

  it('accepts numeric enabled values for provider configuration and coerces them', async () => {
    const providerRoutingCore = createMockProviderRoutingCore({ enabled: 0 });
    const { handlers } = loadHandlers(providerRoutingCore);

    const disabledContext = createMockContext({
      params: { provider_id: 'codex' },
      body: { enabled: 0 },
    });
    await handlers.handleConfigureProvider(disabledContext.req, disabledContext.res);

    expect(providerRoutingCore.updateProvider).toHaveBeenNthCalledWith(1, 'codex', { enabled: 0 });
    expect(disabledContext.res.statusCode).toBe(200);
    expect(disabledContext.res._body.data.enabled).toBe(false);
    expectMeta(disabledContext.res._body);

    const enabledContext = createMockContext({
      params: { provider_id: 'codex' },
      body: { enabled: 1 },
    });
    await handlers.handleConfigureProvider(enabledContext.req, enabledContext.res);

    expect(providerRoutingCore.updateProvider).toHaveBeenNthCalledWith(2, 'codex', { enabled: 1 });
    expect(enabledContext.res.statusCode).toBe(200);
    expect(enabledContext.res._body.data.enabled).toBe(true);
    expectMeta(enabledContext.res._body);
  });

  it('persists timeout_minutes and default_model through the REST configure path', async () => {
    const { core } = loadRealProviderRoutingCore();
    const { handlers } = loadHandlers(core);
    const { req, res } = createMockContext({
      params: { provider_id: 'codex' },
      body: {
        model: 'gpt-5.4-mini',
        timeout_minutes: 45,
      },
    });

    await handlers.handleConfigureProvider(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._body.data.provider).toBe('codex');
    expect(res._body.data.configured).toBe(true);
    expect(res._body.data.default_model).toBe('gpt-5.4-mini');
    expect(res._body.data.timeout_minutes).toBe(45);
    expectMeta(res._body);

    const updated = core.getProvider('codex');
    expect(updated.default_model).toBe('gpt-5.4-mini');
    expect(updated.timeout_minutes).toBe(45);
  });
});
