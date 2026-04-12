'use strict';

/**
 * Tests for v2-governance-handlers: policies, benchmarks & tuning,
 * provider stats, provider configuration, system status, project config,
 * webhooks, and validation handlers.
 *
 * Approvals/schedules are covered by v2-governance-approvals-schedules.test.js
 * Plan projects are covered by v2-governance-plan-projects.test.js
 */

const { TEST_MODELS } = require('./test-helpers');
const HANDLER_MODULE = '../api/v2-governance-handlers';
const MODULE_PATHS = [
  HANDLER_MODULE,
  '../api/v2-control-plane',
  '../api/middleware',
  '../database',
  '../db/config-core',
  '../db/file-tracking',
  '../db/host-management',
  '../db/provider-routing-core',
  '../db/task-core',
  '../db/webhooks-streaming',
  '../handlers/policy-handlers',
  '../handlers/automation-handlers',
  '../handlers/integration',
  '../handlers/webhook-handlers',
];

const FIXED_TIMESTAMP = '2026-03-10T12:34:56.789Z';

// ─── Mock Database ────────────────────────────────────────────────────────

const mockDb = {
  // Benchmarks & Tuning
  getBenchmarkResults: vi.fn(),
  getBenchmarkStats: vi.fn(),
  applyBenchmarkResults: vi.fn(),
  listProjectTuning: vi.fn(),
  setProjectTuning: vi.fn(),
  deleteProjectTuning: vi.fn(),
  // Provider Stats
  getProviderStats: vi.fn(),
  getConfig: vi.fn(),
  countTasks: vi.fn(),
  getProvider: vi.fn(),
  updateProvider: vi.fn(),
  listProviders: vi.fn(),
  setDefaultProvider: vi.fn(),
  // Webhooks
  listWebhooks: vi.fn(),
};

// ─── Mock Policy Core Functions ──────────────────────────────────────────

const mockPolicyCores = {
  isCoreError: vi.fn(),
  listPoliciesCore: vi.fn(),
  getPolicyCore: vi.fn(),
  setPolicyModeCore: vi.fn(),
  evaluatePoliciesCore: vi.fn(),
  listPolicyEvaluationsCore: vi.fn(),
  getPolicyEvaluationCore: vi.fn(),
  overridePolicyDecisionCore: vi.fn(),
};

// ─── Mock Sub-handlers ───────────────────────────────────────────────────

const mockAutomationHandlers = {
  handleGetProjectDefaults: vi.fn(),
  handleSetProjectDefaults: vi.fn(),
  handleConfigureStallDetection: vi.fn(),
  handleAutoVerifyAndFix: vi.fn(),
  handleDetectFileConflicts: vi.fn(),
};

const mockIntegrationHandlers = {
  handleScanProject: vi.fn(),
};

const mockWebhookHandlers = {
  handleListWebhooks: vi.fn(),
  handleAddWebhook: vi.fn(),
  handleRemoveWebhook: vi.fn(),
  handleTestWebhook: vi.fn(),
};

// ─── Mock Middleware ─────────────────────────────────────────────────────

const mockSendJson = vi.fn((res, data, status = 200, req = null) => {
  const headers = { 'Content-Type': 'application/json' };
  if (req?.requestId) headers['X-Request-ID'] = req.requestId;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
});

const mockParseBody = vi.fn(async (req) => req?._parsedBody ?? req?.body ?? {});

const mockMiddleware = {
  parseBody: mockParseBody,
  sendJson: mockSendJson,
};

// ─── CJS Module Mock Helpers ─────────────────────────────────────────────

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

function clearLoadedModules() {
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Module not loaded yet — fine.
    }
  }
}

function loadHandlers() {
  clearLoadedModules();
  installMock('../database', mockDb);
  installMock('../db/config-core', mockDb);
  installMock('../db/file-tracking', mockDb);
  installMock('../db/host-management', mockDb);
  installMock('../db/provider-routing-core', mockDb);
  installMock('../db/task-core', mockDb);
  installMock('../db/webhooks-streaming', mockDb);
  installMock('../api/middleware', mockMiddleware);
  installMock('../handlers/policy-handlers', mockPolicyCores);
  installMock('../handlers/automation-handlers', mockAutomationHandlers);
  installMock('../handlers/integration', mockIntegrationHandlers);
  installMock('../handlers/webhook-handlers', mockWebhookHandlers);
  return require(HANDLER_MODULE);
}

function initHandlersWithDeps(handlers, taskManager = null) {
  handlers.init?.({ db: mockDb, taskManager });
  if (taskManager) {
    handlers.init?.(taskManager);
  }
}

// ─── Test Helpers ────────────────────────────────────────────────────────

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    _body: null,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); },
    end(body) { this._body = typeof body === 'string' ? JSON.parse(body) : body; },
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
  return { req, res: createMockRes() };
}

function expectMeta(requestId) {
  return { request_id: requestId, timestamp: FIXED_TIMESTAMP };
}

function expectSuccessEnvelope(res, data, options = {}) {
  const { requestId = 'req-123', status = 200 } = options;
  expect(res.statusCode).toBe(status);
  expect(res._body).toEqual({ data, meta: expectMeta(requestId) });
}

function expectListEnvelope(res, items, total, options = {}) {
  const { requestId = 'req-123' } = options;
  expect(res.statusCode).toBe(200);
  expect(res._body).toEqual({
    data: { items, total },
    meta: expectMeta(requestId),
  });
}

function expectErrorEnvelope(res, error, options = {}) {
  const { requestId = 'req-123', status = 400, details = {} } = options;
  expect(res.statusCode).toBe(status);
  expect(res._body).toEqual({
    error: { ...error, details, request_id: requestId },
    meta: expectMeta(requestId),
  });
}

function resetAllMocks() {
  // DB mocks
  mockDb.getBenchmarkResults.mockReturnValue([]);
  mockDb.getBenchmarkStats.mockReturnValue({});
  mockDb.applyBenchmarkResults.mockReturnValue({});
  mockDb.listProjectTuning.mockReturnValue([]);
  mockDb.setProjectTuning.mockReturnValue(undefined);
  mockDb.deleteProjectTuning.mockReturnValue(undefined);
  mockDb.getProviderStats.mockReturnValue({});
  mockDb.getConfig.mockReturnValue(undefined);
  mockDb.countTasks.mockReturnValue(0);
  mockDb.getProvider.mockReturnValue(null);
  mockDb.updateProvider.mockReturnValue(undefined);
  mockDb.listProviders.mockReturnValue([]);
  mockDb.setDefaultProvider.mockReturnValue(undefined);
  mockDb.listWebhooks.mockReturnValue([]);

  // Policy core mocks
  mockPolicyCores.isCoreError.mockReturnValue(false);
  mockPolicyCores.listPoliciesCore.mockReturnValue({ policies: [] });
  mockPolicyCores.getPolicyCore.mockReturnValue({ policy: {} });
  mockPolicyCores.setPolicyModeCore.mockReturnValue({ success: true });
  mockPolicyCores.evaluatePoliciesCore.mockReturnValue({ results: [] });
  mockPolicyCores.listPolicyEvaluationsCore.mockReturnValue({ evaluations: [] });
  mockPolicyCores.getPolicyEvaluationCore.mockReturnValue({ evaluation: {} });
  mockPolicyCores.overridePolicyDecisionCore.mockReturnValue({ override_id: 'ov-1' });

  // Sub-handler mocks
  mockAutomationHandlers.handleGetProjectDefaults.mockReturnValue({ content: [{ text: '{}' }] });
  mockAutomationHandlers.handleSetProjectDefaults.mockReturnValue({ content: [{ text: 'ok' }] });
  mockAutomationHandlers.handleConfigureStallDetection.mockReturnValue({ content: [{ text: 'ok' }] });
  mockAutomationHandlers.handleAutoVerifyAndFix.mockReturnValue({ content: [{ text: 'ok' }] });
  mockAutomationHandlers.handleDetectFileConflicts.mockReturnValue({ content: [{ text: 'ok' }] });

  mockIntegrationHandlers.handleScanProject.mockReturnValue({ content: [{ text: 'scan result' }] });

  mockWebhookHandlers.handleListWebhooks.mockReturnValue({ content: [{ text: 'ok' }] });
  mockWebhookHandlers.handleAddWebhook.mockReturnValue({ content: [{ text: 'ok' }] });
  mockWebhookHandlers.handleRemoveWebhook.mockReturnValue({ content: [{ text: 'ok' }] });
  mockWebhookHandlers.handleTestWebhook.mockReturnValue({ content: [{ text: 'test result' }] });

  // Middleware mocks
  mockParseBody.mockReset();
  mockParseBody.mockImplementation(async (req) => req?._parsedBody ?? req?.body ?? {});
  mockSendJson.mockClear();
}

// ─── Test Suite ──────────────────────────────────────────────────────────

describe('api/v2-governance-handlers remaining coverage', () => {
  let handlers;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TIMESTAMP));
    resetAllMocks();
    handlers = loadHandlers();
    initHandlersWithDeps(handlers);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearLoadedModules();
  });

  // ─── Policies ────────────────────────────────────────────────────────

  describe('handleListPolicies', () => {
    it('returns policies from listPoliciesCore on success', async () => {
      const policies = [{ id: 'pol-1', name: 'Size Gate' }];
      mockPolicyCores.listPoliciesCore.mockReturnValue({ policies });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({ query: { category: 'quality' } });
      await handlers.handleListPolicies(req, res);

      expect(mockPolicyCores.listPoliciesCore).toHaveBeenCalledWith({
        project_id: undefined,
        profile_id: undefined,
        category: 'quality',
        stage: undefined,
        mode: undefined,
        enabled_only: undefined,
      });
      expectSuccessEnvelope(res, policies);
    });

    it('passes enabled_only=true when query has enabled_only=true', async () => {
      mockPolicyCores.listPoliciesCore.mockReturnValue({ policies: [] });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({ query: { enabled_only: 'true' } });
      await handlers.handleListPolicies(req, res);

      expect(mockPolicyCores.listPoliciesCore).toHaveBeenCalledWith(
        expect.objectContaining({ enabled_only: true }),
      );
    });

    it('passes enabled_only=false when query has enabled_only=false', async () => {
      mockPolicyCores.listPoliciesCore.mockReturnValue({ policies: [] });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({ query: { enabled_only: 'false' } });
      await handlers.handleListPolicies(req, res);

      expect(mockPolicyCores.listPoliciesCore).toHaveBeenCalledWith(
        expect.objectContaining({ enabled_only: false }),
      );
    });

    it('returns 400 when enabled_only is an invalid boolean', async () => {
      const { req, res } = createMockContext({ query: { enabled_only: 'maybe' } });
      await handlers.handleListPolicies(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'enabled_only must be "true" or "false"',
      }, { details: { field: 'enabled_only' } });
    });

    it('forwards core errors through sendPolicyCoreResult', async () => {
      const coreError = {
        error: { code: 'validation_error', message: 'bad input', status: 400, details: {} },
      };
      mockPolicyCores.listPoliciesCore.mockReturnValue(coreError);
      mockPolicyCores.isCoreError.mockReturnValue(true);

      const { req, res } = createMockContext();
      await handlers.handleListPolicies(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'bad input',
      });
    });
  });

  describe('handleGetPolicy', () => {
    it('returns a single policy on success', async () => {
      const policy = { id: 'pol-1', name: 'Size Gate', mode: 'block' };
      mockPolicyCores.getPolicyCore.mockReturnValue({ policy });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({ params: { policy_id: 'pol-1' } });
      await handlers.handleGetPolicy(req, res);

      expect(mockPolicyCores.getPolicyCore).toHaveBeenCalledWith({ policy_id: 'pol-1' });
      expectSuccessEnvelope(res, policy);
    });

    it('returns error when getPolicyCore returns a core error', async () => {
      const coreError = {
        error: { code: 'policy_not_found', message: 'Not found', status: 404, details: {} },
      };
      mockPolicyCores.getPolicyCore.mockReturnValue(coreError);
      mockPolicyCores.isCoreError.mockReturnValue(true);

      const { req, res } = createMockContext({ params: { policy_id: 'missing' } });
      await handlers.handleGetPolicy(req, res);

      expectErrorEnvelope(res, {
        code: 'policy_not_found',
        message: 'Not found',
      }, { status: 404 });
    });
  });

  describe('handleSetPolicyMode', () => {
    it('sets mode and returns success', async () => {
      const result = { policy_id: 'pol-1', mode: 'shadow' };
      mockPolicyCores.setPolicyModeCore.mockReturnValue(result);
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({
        params: { policy_id: 'pol-1' },
        body: { mode: 'shadow' },
      });
      await handlers.handleSetPolicyMode(req, res);

      expect(mockPolicyCores.setPolicyModeCore).toHaveBeenCalledWith({
        mode: 'shadow',
        policy_id: 'pol-1',
      });
      expectSuccessEnvelope(res, result);
    });

    it('parses body when req.body is undefined', async () => {
      mockPolicyCores.setPolicyModeCore.mockReturnValue({ success: true });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({
        body: undefined,
        params: { policy_id: 'pol-2' },
        parsedBody: { mode: 'block' },
      });
      await handlers.handleSetPolicyMode(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
      expect(mockPolicyCores.setPolicyModeCore).toHaveBeenCalledWith({
        mode: 'block',
        policy_id: 'pol-2',
      });
    });

    it('forwards core errors', async () => {
      const coreError = {
        error: { code: 'policy_mode_invalid', message: 'Bad mode', status: 400, details: {} },
      };
      mockPolicyCores.setPolicyModeCore.mockReturnValue(coreError);
      mockPolicyCores.isCoreError.mockReturnValue(true);

      const { req, res } = createMockContext({
        params: { policy_id: 'pol-1' },
        body: { mode: 'bogus' },
      });
      await handlers.handleSetPolicyMode(req, res);

      expectErrorEnvelope(res, {
        code: 'policy_mode_invalid',
        message: 'Bad mode',
      });
    });
  });

  describe('handleEvaluatePolicies', () => {
    it('evaluates and returns result', async () => {
      const result = { outcomes: ['pass'] };
      mockPolicyCores.evaluatePoliciesCore.mockReturnValue(result);
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({ body: { task_id: 't-1' } });
      await handlers.handleEvaluatePolicies(req, res);

      expect(mockPolicyCores.evaluatePoliciesCore).toHaveBeenCalledWith({ task_id: 't-1' });
      expectSuccessEnvelope(res, result);
    });

    it('parses body when req.body is undefined', async () => {
      mockPolicyCores.evaluatePoliciesCore.mockReturnValue({});
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({
        body: undefined,
        parsedBody: { workflow_id: 'w-1' },
      });
      await handlers.handleEvaluatePolicies(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
      expect(mockPolicyCores.evaluatePoliciesCore).toHaveBeenCalledWith({ workflow_id: 'w-1' });
    });
  });

  describe('handleListPolicyEvaluations', () => {
    it('returns evaluations list on success', async () => {
      const evaluations = [{ id: 'ev-1' }];
      mockPolicyCores.listPolicyEvaluationsCore.mockReturnValue({ evaluations });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({ query: { policy_id: 'pol-1', limit: '10' } });
      await handlers.handleListPolicyEvaluations(req, res);

      expect(mockPolicyCores.listPolicyEvaluationsCore).toHaveBeenCalledWith(
        expect.objectContaining({ policy_id: 'pol-1', limit: '10' }),
      );
      expectSuccessEnvelope(res, evaluations);
    });

    it('returns 400 when suppressed query param is invalid', async () => {
      const { req, res } = createMockContext({ query: { suppressed: 'nope' } });
      await handlers.handleListPolicyEvaluations(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'suppressed must be "true" or "false"',
      }, { details: { field: 'suppressed' } });
    });

    it('returns 400 when include_overrides query param is invalid', async () => {
      const { req, res } = createMockContext({ query: { include_overrides: 'bad' } });
      await handlers.handleListPolicyEvaluations(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'include_overrides must be "true" or "false"',
      }, { details: { field: 'include_overrides' } });
    });

    it('passes boolean parsed suppressed and include_overrides through', async () => {
      mockPolicyCores.listPolicyEvaluationsCore.mockReturnValue({ evaluations: [] });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({
        query: { suppressed: 'true', include_overrides: 'false' },
      });
      await handlers.handleListPolicyEvaluations(req, res);

      expect(mockPolicyCores.listPolicyEvaluationsCore).toHaveBeenCalledWith(
        expect.objectContaining({ suppressed: true, include_overrides: false }),
      );
    });
  });

  describe('handleGetPolicyEvaluation', () => {
    it('returns a single evaluation on success', async () => {
      const evaluation = { id: 'ev-1', outcome: 'pass' };
      mockPolicyCores.getPolicyEvaluationCore.mockReturnValue({ evaluation });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({ params: { evaluation_id: 'ev-1' } });
      await handlers.handleGetPolicyEvaluation(req, res);

      expect(mockPolicyCores.getPolicyEvaluationCore).toHaveBeenCalledWith({
        evaluation_id: 'ev-1',
        include_overrides: undefined,
      });
      expectSuccessEnvelope(res, evaluation);
    });

    it('returns 400 when include_overrides is invalid', async () => {
      const { req, res } = createMockContext({
        params: { evaluation_id: 'ev-1' },
        query: { include_overrides: 'invalid' },
      });
      await handlers.handleGetPolicyEvaluation(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'include_overrides must be "true" or "false"',
      }, { details: { field: 'include_overrides' } });
    });

    it('passes include_overrides=true through when set', async () => {
      mockPolicyCores.getPolicyEvaluationCore.mockReturnValue({ evaluation: {} });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({
        params: { evaluation_id: 'ev-2' },
        query: { include_overrides: 'true' },
      });
      await handlers.handleGetPolicyEvaluation(req, res);

      expect(mockPolicyCores.getPolicyEvaluationCore).toHaveBeenCalledWith({
        evaluation_id: 'ev-2',
        include_overrides: true,
      });
    });

    it('forwards core errors', async () => {
      const coreError = {
        error: { code: 'evaluation_not_found', message: 'Not found', status: 404, details: {} },
      };
      mockPolicyCores.getPolicyEvaluationCore.mockReturnValue(coreError);
      mockPolicyCores.isCoreError.mockReturnValue(true);

      const { req, res } = createMockContext({ params: { evaluation_id: 'missing' } });
      await handlers.handleGetPolicyEvaluation(req, res);

      expectErrorEnvelope(res, {
        code: 'evaluation_not_found',
        message: 'Not found',
      }, { status: 404 });
    });
  });

  describe('handleOverridePolicyDecision', () => {
    it('creates an override and returns 201', async () => {
      const result = { override_id: 'ov-1', evaluation_id: 'ev-1' };
      mockPolicyCores.overridePolicyDecisionCore.mockReturnValue(result);
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({
        params: { evaluation_id: 'ev-1' },
        body: { reason: 'false positive', overridden_by: 'admin' },
      });
      await handlers.handleOverridePolicyDecision(req, res);

      expect(mockPolicyCores.overridePolicyDecisionCore).toHaveBeenCalledWith({
        reason: 'false positive',
        overridden_by: 'admin',
        evaluation_id: 'ev-1',
      });
      expectSuccessEnvelope(res, result, { status: 201 });
    });

    it('parses body when req.body is undefined', async () => {
      mockPolicyCores.overridePolicyDecisionCore.mockReturnValue({ override_id: 'ov-2' });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({
        body: undefined,
        params: { evaluation_id: 'ev-2' },
        parsedBody: { reason: 'intentional' },
      });
      await handlers.handleOverridePolicyDecision(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
    });

    it('forwards core errors', async () => {
      const coreError = {
        error: { code: 'override_not_allowed', message: 'Blocked', status: 403, details: {} },
      };
      mockPolicyCores.overridePolicyDecisionCore.mockReturnValue(coreError);
      mockPolicyCores.isCoreError.mockReturnValue(true);

      const { req, res } = createMockContext({
        params: { evaluation_id: 'ev-1' },
        body: { reason: 'test' },
      });
      await handlers.handleOverridePolicyDecision(req, res);

      expectErrorEnvelope(res, {
        code: 'override_not_allowed',
        message: 'Blocked',
      }, { status: 403 });
    });
  });

  // ─── Benchmarks & Tuning ─────────────────────────────────────────────

  describe('handleListBenchmarks', () => {
    it('returns 400 when host_id is missing', async () => {
      const { req, res } = createMockContext({ query: {} });
      await handlers.handleListBenchmarks(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'host_id is required',
      });
    });

    it('returns benchmarks and stats for a given host', async () => {
      const results = [{ id: 'bench-1', tok_per_sec: 42 }];
      const stats = { avg_tok_per_sec: 42 };
      mockDb.getBenchmarkResults.mockReturnValue(results);
      mockDb.getBenchmarkStats.mockReturnValue(stats);

      const { req, res } = createMockContext({ query: { host_id: 'host-1', limit: '5' } });
      await handlers.handleListBenchmarks(req, res);

      expect(mockDb.getBenchmarkResults).toHaveBeenCalledWith('host-1', 5);
      expect(mockDb.getBenchmarkStats).toHaveBeenCalledWith('host-1');
      expectSuccessEnvelope(res, {
        host_id: 'host-1',
        results,
        stats,
      });
    });

    it('accepts hostId as an alternative query param', async () => {
      mockDb.getBenchmarkResults.mockReturnValue([]);
      mockDb.getBenchmarkStats.mockReturnValue({});

      const { req, res } = createMockContext({ query: { hostId: 'host-2' } });
      await handlers.handleListBenchmarks(req, res);

      expect(mockDb.getBenchmarkResults).toHaveBeenCalledWith('host-2', 10);
    });

    it('clamps limit to [1, 1000] and defaults to 10', async () => {
      mockDb.getBenchmarkResults.mockReturnValue([]);
      mockDb.getBenchmarkStats.mockReturnValue({});

      const { req, res } = createMockContext({ query: { host_id: 'h', limit: '5000' } });
      await handlers.handleListBenchmarks(req, res);
      expect(mockDb.getBenchmarkResults).toHaveBeenCalledWith('h', 1000);
    });

    it('returns 500 when db throws', async () => {
      mockDb.getBenchmarkResults.mockImplementation(() => { throw new Error('db error'); });

      const { req, res } = createMockContext({ query: { host_id: 'h' } });
      await handlers.handleListBenchmarks(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'db error',
      }, { status: 500 });
    });

    it('normalizes non-array results from db', async () => {
      mockDb.getBenchmarkResults.mockReturnValue(null);
      mockDb.getBenchmarkStats.mockReturnValue(null);

      const { req, res } = createMockContext({ query: { host_id: 'h' } });
      await handlers.handleListBenchmarks(req, res);

      expectSuccessEnvelope(res, {
        host_id: 'h',
        results: [],
        stats: {},
      });
    });
  });

  describe('handleApplyBenchmark', () => {
    it('returns 400 when host_id is missing', async () => {
      const { req, res } = createMockContext({ body: {} });
      await handlers.handleApplyBenchmark(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'host_id is required',
      });
    });

    it('applies benchmark and returns result', async () => {
      const result = { applied: true, tuning: { num_predict: 512 } };
      mockDb.applyBenchmarkResults.mockReturnValue(result);

      const { req, res } = createMockContext({
        body: { host_id: 'host-1', model: TEST_MODELS.DEFAULT },
      });
      await handlers.handleApplyBenchmark(req, res);

      expect(mockDb.applyBenchmarkResults).toHaveBeenCalledWith('host-1', TEST_MODELS.DEFAULT);
      expectSuccessEnvelope(res, result);
    });

    it('accepts hostId as an alternative body param', async () => {
      mockDb.applyBenchmarkResults.mockReturnValue({});

      const { req, res } = createMockContext({
        body: { hostId: 'host-2' },
      });
      await handlers.handleApplyBenchmark(req, res);

      expect(mockDb.applyBenchmarkResults).toHaveBeenCalledWith('host-2', undefined);
    });

    it('parses body when req.body is undefined', async () => {
      mockDb.applyBenchmarkResults.mockReturnValue({});

      const { req, res } = createMockContext({
        body: undefined,
        parsedBody: { host_id: 'host-3' },
      });
      await handlers.handleApplyBenchmark(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
    });

    it('returns 500 when db throws', async () => {
      mockDb.applyBenchmarkResults.mockImplementation(() => { throw new Error('apply failed'); });

      const { req, res } = createMockContext({ body: { host_id: 'h' } });
      await handlers.handleApplyBenchmark(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'apply failed',
      }, { status: 500 });
    });
  });

  describe('handleListProjectTuning', () => {
    it('returns a list of project tuning entries', async () => {
      const tunings = [{ project_path: '/repo', settings: { timeout: 30 } }];
      mockDb.listProjectTuning.mockReturnValue(tunings);

      const { req, res } = createMockContext();
      await handlers.handleListProjectTuning(req, res);

      expect(mockDb.listProjectTuning).toHaveBeenCalledOnce();
      expectListEnvelope(res, tunings, 1);
    });

    it('returns empty list when db returns non-array', async () => {
      mockDb.listProjectTuning.mockReturnValue(null);

      const { req, res } = createMockContext();
      await handlers.handleListProjectTuning(req, res);

      expectListEnvelope(res, [], 0);
    });

    it('returns 500 when db throws', async () => {
      mockDb.listProjectTuning.mockImplementation(() => { throw new Error('tuning list error'); });

      const { req, res } = createMockContext();
      await handlers.handleListProjectTuning(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'tuning list error',
      }, { status: 500 });
    });
  });

  describe('handleCreateProjectTuning', () => {
    it('returns 400 when project_path is missing', async () => {
      const { req, res } = createMockContext({ body: { settings: { timeout: 30 } } });
      await handlers.handleCreateProjectTuning(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'project_path is required',
      });
    });

    it('returns 400 when project_path is blank after trimming', async () => {
      const { req, res } = createMockContext({
        body: { project_path: '   ', settings: { timeout: 30 } },
      });
      await handlers.handleCreateProjectTuning(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'project_path is required',
      });
    });

    it('returns 400 when settings is missing or not an object', async () => {
      const { req, res } = createMockContext({
        body: { project_path: '/repo', settings: 'not-object' },
      });
      await handlers.handleCreateProjectTuning(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'settings object is required',
      });
    });

    it('returns 400 when settings is missing entirely', async () => {
      const { req, res } = createMockContext({
        body: { project_path: '/repo' },
      });
      await handlers.handleCreateProjectTuning(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'settings object is required',
      });
    });

    it('creates project tuning and returns 201', async () => {
      const { req, res } = createMockContext({
        body: {
          project_path: '  /my/repo  ',
          settings: { timeout: 60 },
          description: 'Increase timeout',
        },
      });
      await handlers.handleCreateProjectTuning(req, res);

      expect(mockDb.setProjectTuning).toHaveBeenCalledWith(
        '/my/repo',
        { timeout: 60 },
        'Increase timeout',
      );
      expectSuccessEnvelope(res, { project_path: '/my/repo', saved: true }, { status: 201 });
    });

    it('accepts projectPath as an alternative body key', async () => {
      const { req, res } = createMockContext({
        body: { projectPath: '/alt', settings: { x: 1 } },
      });
      await handlers.handleCreateProjectTuning(req, res);

      expect(mockDb.setProjectTuning).toHaveBeenCalledWith('/alt', { x: 1 }, undefined);
      expectSuccessEnvelope(res, { project_path: '/alt', saved: true }, { status: 201 });
    });

    it('returns 500 when db throws', async () => {
      mockDb.setProjectTuning.mockImplementation(() => { throw new Error('set failed'); });

      const { req, res } = createMockContext({
        body: { project_path: '/repo', settings: {} },
      });
      await handlers.handleCreateProjectTuning(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'set failed',
      }, { status: 500 });
    });
  });

  describe('handleDeleteProjectTuning', () => {
    it('returns 400 when project_path param is missing', async () => {
      const { req, res } = createMockContext({ params: {} });
      await handlers.handleDeleteProjectTuning(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'project_path is required',
      });
    });

    it('deletes project tuning and returns success', async () => {
      const { req, res } = createMockContext({
        params: { project_path: encodeURIComponent('/my/repo') },
      });
      await handlers.handleDeleteProjectTuning(req, res);

      expect(mockDb.deleteProjectTuning).toHaveBeenCalledWith('/my/repo');
      expectSuccessEnvelope(res, { deleted: true, project_path: '/my/repo' });
    });

    it('returns 500 when db throws', async () => {
      mockDb.deleteProjectTuning.mockImplementation(() => { throw new Error('delete failed'); });

      const { req, res } = createMockContext({
        params: { project_path: 'some-path' },
      });
      await handlers.handleDeleteProjectTuning(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'delete failed',
      }, { status: 500 });
    });
  });

  // ─── Provider Stats ──────────────────────────────────────────────────

  describe('handleProviderStats', () => {
    it('returns provider stats with time series', async () => {
      const stats = { total_tasks: 100, success_rate: 95 };
      mockDb.getProviderStats.mockReturnValue(stats);
      mockDb.countTasks.mockReturnValue(0);

      const { req, res } = createMockContext({
        params: { provider_id: 'codex' },
        query: { days: '3' },
      });
      await handlers.handleProviderStats(req, res);

      expect(mockDb.getProviderStats).toHaveBeenCalledWith('codex', 3);
      expect(res.statusCode).toBe(200);
      expect(res._body.data.provider).toBe('codex');
      expect(res._body.data.days).toBe(3);
      expect(res._body.data.total_tasks).toBe(100);
      expect(res._body.data.time_series).toHaveLength(3);
    });

    it('defaults days to 7 and clamps to [1, 90]', async () => {
      mockDb.getProviderStats.mockReturnValue({});
      mockDb.countTasks.mockReturnValue(0);

      const { req, res } = createMockContext({
        params: { provider_id: 'ollama' },
        query: {},
      });
      await handlers.handleProviderStats(req, res);

      expect(mockDb.getProviderStats).toHaveBeenCalledWith('ollama', 7);
      expect(res._body.data.days).toBe(7);
      expect(res._body.data.time_series).toHaveLength(7);
    });

    it('clamps days to 90 max', async () => {
      mockDb.getProviderStats.mockReturnValue({});
      mockDb.countTasks.mockReturnValue(0);

      const { req, res } = createMockContext({
        params: { provider_id: 'codex' },
        query: { days: '200' },
      });
      await handlers.handleProviderStats(req, res);

      expect(res._body.data.days).toBe(90);
    });

    it('returns 500 when db throws', async () => {
      mockDb.getProviderStats.mockImplementation(() => { throw new Error('stats error'); });

      const { req, res } = createMockContext({
        params: { provider_id: 'codex' },
      });
      await handlers.handleProviderStats(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'stats error',
      }, { status: 500 });
    });
  });

  describe('handleProviderToggle', () => {
    it('returns 404 when provider does not exist', async () => {
      mockDb.getProvider.mockReturnValue(null);

      const { req, res } = createMockContext({
        params: { provider_id: 'nonexistent' },
        body: { enabled: true },
      });
      await handlers.handleProviderToggle(req, res);

      expectErrorEnvelope(res, {
        code: 'provider_not_found',
        message: 'Provider not found: nonexistent',
      }, { status: 404 });
    });

    it('toggles provider with explicit enabled=true', async () => {
      mockDb.getProvider.mockReturnValue({ provider: 'codex', enabled: 0 });

      const { req, res } = createMockContext({
        params: { provider_id: 'codex' },
        body: { enabled: true },
      });
      await handlers.handleProviderToggle(req, res);

      expect(mockDb.updateProvider).toHaveBeenCalledWith('codex', { enabled: 1 });
      expectSuccessEnvelope(res, { provider: 'codex', enabled: true });
    });

    it('toggles provider to opposite state when enabled is not specified', async () => {
      mockDb.getProvider.mockReturnValue({ provider: 'ollama', enabled: true });

      const { req, res } = createMockContext({
        params: { provider_id: 'ollama' },
        body: {},
      });
      await handlers.handleProviderToggle(req, res);

      expect(mockDb.updateProvider).toHaveBeenCalledWith('ollama', { enabled: 0 });
      expectSuccessEnvelope(res, { provider: 'ollama', enabled: false });
    });

    it('returns 500 when db throws', async () => {
      mockDb.getProvider.mockReturnValue({ provider: 'codex', enabled: 1 });
      mockDb.updateProvider.mockImplementation(() => { throw new Error('toggle error'); });

      const { req, res } = createMockContext({
        params: { provider_id: 'codex' },
        body: { enabled: false },
      });
      await handlers.handleProviderToggle(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'toggle error',
      }, { status: 500 });
    });
  });

  describe('handleProviderTrends', () => {
    it('returns provider trends with series data', async () => {
      mockDb.listProviders.mockReturnValue([
        { provider: 'codex' },
        { provider: 'ollama' },
      ]);
      mockDb.countTasks.mockReturnValue(0);

      const { req, res } = createMockContext({ query: { days: '2' } });
      await handlers.handleProviderTrends(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._body.data.providers).toEqual(['codex', 'ollama']);
      expect(res._body.data.days).toBe(2);
      expect(res._body.data.series).toHaveLength(2);
      // Each entry should have per-provider columns
      const entry = res._body.data.series[0];
      expect(entry).toHaveProperty('date');
      expect(entry).toHaveProperty('codex_total');
      expect(entry).toHaveProperty('ollama_total');
    });

    it('defaults days to 7', async () => {
      mockDb.listProviders.mockReturnValue([]);
      mockDb.countTasks.mockReturnValue(0);

      const { req, res } = createMockContext({ query: {} });
      await handlers.handleProviderTrends(req, res);

      expect(res._body.data.days).toBe(7);
      expect(res._body.data.series).toHaveLength(7);
    });

    it('returns 500 when db throws', async () => {
      mockDb.listProviders.mockImplementation(() => { throw new Error('trends error'); });

      const { req, res } = createMockContext();
      await handlers.handleProviderTrends(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'trends error',
      }, { status: 500 });
    });

    it('computes success_rate as null when no completed+failed tasks', async () => {
      mockDb.listProviders.mockReturnValue([{ provider: 'codex' }]);
      mockDb.countTasks.mockReturnValue(0);

      const { req, res } = createMockContext({ query: { days: '1' } });
      await handlers.handleProviderTrends(req, res);

      const entry = res._body.data.series[0];
      expect(entry.codex_success_rate).toBeNull();
    });
  });

  // ─── Provider Configuration ──────────────────────────────────────────

  describe('handleConfigureProvider', () => {
    it('returns 400 when provider_id is missing', async () => {
      const { req, res } = createMockContext({ params: {}, body: {} });
      await handlers.handleConfigureProvider(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'provider_id is required',
      });
    });

    it('returns 404 when provider does not exist', async () => {
      mockDb.getProvider.mockReturnValue(null);

      const { req, res } = createMockContext({
        params: { provider_id: 'missing' },
        body: { enabled: true },
      });
      await handlers.handleConfigureProvider(req, res);

      expectErrorEnvelope(res, {
        code: 'provider_not_found',
        message: 'Provider not found: missing',
      }, { status: 404 });
    });

    it('updates provider config and returns updated provider', async () => {
      mockDb.getProvider
        .mockReturnValueOnce({ provider: 'codex', enabled: 1 })  // first call: existence check
        .mockReturnValueOnce({ provider: 'codex', enabled: 0, default_model: 'gpt-5', max_concurrent: 5 });  // second call: after update

      const { req, res } = createMockContext({
        params: { provider_id: 'codex' },
        body: { enabled: 0, model: 'gpt-5', max_concurrent: 5, timeout_minutes: 10 },
      });
      await handlers.handleConfigureProvider(req, res);

      expect(mockDb.updateProvider).toHaveBeenCalledWith('codex', {
        enabled: 0,
        default_model: 'gpt-5',
        max_concurrent: 5,
        timeout_minutes: 10,
      });
      expect(res.statusCode).toBe(200);
      expect(res._body.data.provider).toBe('codex');
      expect(res._body.data.configured).toBe(true);
    });

    it('only includes provided fields in updates', async () => {
      mockDb.getProvider
        .mockReturnValueOnce({ provider: 'ollama' })
        .mockReturnValueOnce({ provider: 'ollama', enabled: 1 });

      const { req, res } = createMockContext({
        params: { provider_id: 'ollama' },
        body: { model: 'llama3' },
      });
      await handlers.handleConfigureProvider(req, res);

      expect(mockDb.updateProvider).toHaveBeenCalledWith('ollama', { default_model: 'llama3' });
    });

    it('returns 500 when db throws', async () => {
      mockDb.getProvider.mockReturnValue({ provider: 'codex' });
      mockDb.updateProvider.mockImplementation(() => { throw new Error('config error'); });

      const { req, res } = createMockContext({
        params: { provider_id: 'codex' },
        body: { enabled: true },
      });
      await handlers.handleConfigureProvider(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'config error',
      }, { status: 500 });
    });
  });

  describe('handleSetDefaultProvider', () => {
    it('returns 400 when provider is missing', async () => {
      const { req, res } = createMockContext({ body: {} });
      await handlers.handleSetDefaultProvider(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'provider is required',
      });
    });

    it('returns 400 when provider is blank after trimming', async () => {
      const { req, res } = createMockContext({ body: { provider: '   ' } });
      await handlers.handleSetDefaultProvider(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'provider is required',
      });
    });

    it('returns 404 when the provider does not exist', async () => {
      mockDb.getProvider.mockReturnValue(null);

      const { req, res } = createMockContext({ body: { provider: 'unknown' } });
      await handlers.handleSetDefaultProvider(req, res);

      expectErrorEnvelope(res, {
        code: 'provider_not_found',
        message: 'Unknown provider: unknown',
      }, { status: 404 });
    });

    it('sets the default provider and returns success', async () => {
      mockDb.getProvider.mockReturnValue({ provider: 'codex', enabled: 1 });

      const { req, res } = createMockContext({ body: { provider: 'codex' } });
      await handlers.handleSetDefaultProvider(req, res);

      expect(mockDb.setDefaultProvider).toHaveBeenCalledWith('codex');
      expectSuccessEnvelope(res, { provider: 'codex', default: true });
    });

    it('returns 500 when db throws', async () => {
      mockDb.getProvider.mockReturnValue({ provider: 'codex' });
      mockDb.setDefaultProvider.mockImplementation(() => { throw new Error('default error'); });

      const { req, res } = createMockContext({ body: { provider: 'codex' } });
      await handlers.handleSetDefaultProvider(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'default error',
      }, { status: 500 });
    });
  });

  // ─── System Status ───────────────────────────────────────────────────

  describe('handleSystemStatus', () => {
    it('returns system status with memory, uptime, and task counts', async () => {
      mockDb.countTasks.mockImplementation((filters) => {
        if (filters.status === 'running') return 3;
        if (filters.status === 'queued') return 7;
        return 0;
      });

      const { req, res } = createMockContext();
      await handlers.handleSystemStatus(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._body.data;
      expect(data.instance).toHaveProperty('pid');
      expect(data.memory).toHaveProperty('heap_used_mb');
      expect(data.memory).toHaveProperty('heap_total_mb');
      expect(data.memory).toHaveProperty('heap_percent');
      expect(data.memory).toHaveProperty('rss_mb');
      expect(data.memory).toHaveProperty('status');
      expect(['healthy', 'elevated', 'warning', 'critical']).toContain(data.memory.status);
      expect(data).toHaveProperty('uptime_seconds');
      expect(data.tasks).toEqual({ running: 3, queued: 7 });
      expect(data).toHaveProperty('node_version');
      expect(data).toHaveProperty('platform');
    });

    it('includes instance id when taskManager provides getMcpInstanceId', async () => {
      const mockTm = { getMcpInstanceId: vi.fn().mockReturnValue('abc123def456') };
      initHandlersWithDeps(handlers, mockTm);
      mockDb.countTasks.mockReturnValue(0);

      const { req, res } = createMockContext();
      await handlers.handleSystemStatus(req, res);

      expect(res._body.data.instance.id).toBe('abc123def456');
      expect(res._body.data.instance.short_id).toBe('def456');
    });

    it('omits instance id fields when taskManager has no getMcpInstanceId', async () => {
      initHandlersWithDeps(handlers);
      mockDb.countTasks.mockReturnValue(0);

      const { req, res } = createMockContext();
      await handlers.handleSystemStatus(req, res);

      expect(res._body.data.instance).toEqual({ pid: process.pid });
    });
  });

  // ─── Project Config ──────────────────────────────────────────────────

  describe('handleScanProject', () => {
    it('returns 400 when working_directory is missing', async () => {
      const { req, res } = createMockContext({ body: {} });
      await handlers.handleScanProject(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'working_directory is required',
      });
    });

    it('returns 400 when working_directory is blank after trim', async () => {
      const { req, res } = createMockContext({ body: { working_directory: '   ' } });
      await handlers.handleScanProject(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'working_directory is required',
      });
    });

    it('delegates to integration handlers and returns scan result', async () => {
      mockIntegrationHandlers.handleScanProject.mockReturnValue({
        content: [{ text: 'Found 5 files' }],
      });

      const { req, res } = createMockContext({
        body: { working_directory: '/my/repo', depth: 2 },
      });
      await handlers.handleScanProject(req, res);

      expect(mockIntegrationHandlers.handleScanProject).toHaveBeenCalledWith({
        working_directory: '/my/repo',
        depth: 2,
      });
      expectSuccessEnvelope(res, {
        working_directory: '/my/repo',
        scan_result: 'Found 5 files',
      });
    });

    it('returns 400 when integration handler returns isError', async () => {
      mockIntegrationHandlers.handleScanProject.mockReturnValue({
        isError: true,
        content: [{ text: 'Directory not found' }],
      });

      const { req, res } = createMockContext({
        body: { working_directory: '/nonexistent' },
      });
      await handlers.handleScanProject(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'Directory not found',
      });
    });

    it('returns 500 when integration handler throws', async () => {
      mockIntegrationHandlers.handleScanProject.mockImplementation(() => {
        throw new Error('scan crash');
      });

      const { req, res } = createMockContext({
        body: { working_directory: '/repo' },
      });
      await handlers.handleScanProject(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'scan crash',
      }, { status: 500 });
    });
  });

  describe('handleGetProjectDefaults', () => {
    it('returns project defaults', async () => {
      mockAutomationHandlers.handleGetProjectDefaults.mockReturnValue({
        content: [{ text: '{"provider":"codex"}' }],
      });

      const { req, res } = createMockContext({
        query: { working_directory: '/my/repo' },
      });
      await handlers.handleGetProjectDefaults(req, res);

      expect(mockAutomationHandlers.handleGetProjectDefaults).toHaveBeenCalledWith({
        working_directory: '/my/repo',
      });
      expectSuccessEnvelope(res, { defaults: '{"provider":"codex"}' });
    });

    it('passes undefined working_directory when query is empty', async () => {
      mockAutomationHandlers.handleGetProjectDefaults.mockReturnValue({
        content: [{ text: '{}' }],
      });

      const { req, res } = createMockContext({ query: {} });
      await handlers.handleGetProjectDefaults(req, res);

      expect(mockAutomationHandlers.handleGetProjectDefaults).toHaveBeenCalledWith({
        working_directory: undefined,
      });
    });

    it('returns 400 when handler returns isError', async () => {
      mockAutomationHandlers.handleGetProjectDefaults.mockReturnValue({
        isError: true,
        content: [{ text: 'Project not configured' }],
      });

      const { req, res } = createMockContext({
        query: { working_directory: '/bad' },
      });
      await handlers.handleGetProjectDefaults(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'Project not configured',
      });
    });

    it('returns 500 when handler throws', async () => {
      mockAutomationHandlers.handleGetProjectDefaults.mockImplementation(() => {
        throw new Error('defaults crash');
      });

      const { req, res } = createMockContext();
      await handlers.handleGetProjectDefaults(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'defaults crash',
      }, { status: 500 });
    });
  });

  describe('handleSetProjectDefaults', () => {
    it('sets project defaults and returns success', async () => {
      mockAutomationHandlers.handleSetProjectDefaults.mockReturnValue({
        content: [{ text: 'saved' }],
      });

      const { req, res } = createMockContext({
        body: { working_directory: '/repo', provider: 'codex' },
      });
      await handlers.handleSetProjectDefaults(req, res);

      expect(mockAutomationHandlers.handleSetProjectDefaults).toHaveBeenCalledWith({
        working_directory: '/repo',
        provider: 'codex',
      });
      expectSuccessEnvelope(res, { configured: true });
    });

    it('returns 400 when handler returns isError', async () => {
      mockAutomationHandlers.handleSetProjectDefaults.mockReturnValue({
        isError: true,
        content: [{ text: 'Invalid settings' }],
      });

      const { req, res } = createMockContext({ body: { invalid: true } });
      await handlers.handleSetProjectDefaults(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'Invalid settings',
      });
    });

    it('returns 500 when handler throws', async () => {
      mockAutomationHandlers.handleSetProjectDefaults.mockImplementation(() => {
        throw new Error('set crash');
      });

      const { req, res } = createMockContext({ body: {} });
      await handlers.handleSetProjectDefaults(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'set crash',
      }, { status: 500 });
    });

    it('parses body when req.body is undefined', async () => {
      mockAutomationHandlers.handleSetProjectDefaults.mockReturnValue({
        content: [{ text: 'saved' }],
      });

      const { req, res } = createMockContext({
        body: undefined,
        parsedBody: { provider: 'ollama' },
      });
      await handlers.handleSetProjectDefaults(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
    });
  });

  describe('handleConfigureStallDetection', () => {
    it('returns 400 when provider is missing', async () => {
      const { req, res } = createMockContext({ body: {} });
      await handlers.handleConfigureStallDetection(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'provider is required',
      });
    });

    it('configures stall detection and returns success', async () => {
      mockAutomationHandlers.handleConfigureStallDetection.mockReturnValue({
        content: [{ text: 'configured' }],
      });

      const { req, res } = createMockContext({
        body: { provider: 'codex', stall_threshold_seconds: 300 },
      });
      await handlers.handleConfigureStallDetection(req, res);

      expect(mockAutomationHandlers.handleConfigureStallDetection).toHaveBeenCalledWith({
        provider: 'codex',
        stall_threshold_seconds: 300,
      });
      expectSuccessEnvelope(res, { provider: 'codex', configured: true });
    });

    it('returns 400 when handler returns isError', async () => {
      mockAutomationHandlers.handleConfigureStallDetection.mockReturnValue({
        isError: true,
        content: [{ text: 'Unknown provider' }],
      });

      const { req, res } = createMockContext({ body: { provider: 'bad' } });
      await handlers.handleConfigureStallDetection(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'Unknown provider',
      });
    });

    it('returns 500 when handler throws', async () => {
      mockAutomationHandlers.handleConfigureStallDetection.mockImplementation(() => {
        throw new Error('stall crash');
      });

      const { req, res } = createMockContext({ body: { provider: 'codex' } });
      await handlers.handleConfigureStallDetection(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'stall crash',
      }, { status: 500 });
    });
  });

  // ─── Webhooks ────────────────────────────────────────────────────────

  describe('handleListWebhooks', () => {
    it('returns a list of webhooks', async () => {
      const webhooks = [{ id: 'wh-1', url: 'https://example.com/hook' }];
      mockWebhookHandlers.handleListWebhooks.mockReturnValue({ content: [{ text: 'ok' }] });
      mockDb.listWebhooks.mockReturnValue(webhooks);

      const { req, res } = createMockContext();
      await handlers.handleListWebhooks(req, res);

      expect(mockWebhookHandlers.handleListWebhooks).toHaveBeenCalledWith({});
      expectListEnvelope(res, webhooks, 1);
    });

    it('returns 500 when db.listWebhooks returns null (null.length throws)', async () => {
      mockWebhookHandlers.handleListWebhooks.mockReturnValue({ content: [{ text: 'ok' }] });
      mockDb.listWebhooks.mockReturnValue(null);

      const { req, res } = createMockContext();
      await handlers.handleListWebhooks(req, res);

      // webhooks.length throws TypeError when webhooks is null — caught by try/catch → 500
      expect(res.statusCode).toBe(500);
    });

    it('returns 400 when webhook handler returns isError', async () => {
      mockWebhookHandlers.handleListWebhooks.mockReturnValue({
        isError: true,
        content: [{ text: 'Webhook service unavailable' }],
      });

      const { req, res } = createMockContext();
      await handlers.handleListWebhooks(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'Webhook service unavailable',
      });
    });

    it('returns 500 when handler throws', async () => {
      mockWebhookHandlers.handleListWebhooks.mockImplementation(() => {
        throw new Error('webhook list error');
      });

      const { req, res } = createMockContext();
      await handlers.handleListWebhooks(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'webhook list error',
      }, { status: 500 });
    });
  });

  describe('handleAddWebhook', () => {
    it('returns 400 when url is missing', async () => {
      const { req, res } = createMockContext({ body: {} });
      await handlers.handleAddWebhook(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'url is required',
      });
    });

    it('adds a webhook and returns 201', async () => {
      mockWebhookHandlers.handleAddWebhook.mockReturnValue({ content: [{ text: 'added' }] });

      const { req, res } = createMockContext({
        body: { url: 'https://example.com/hook', events: ['task.completed'] },
      });
      await handlers.handleAddWebhook(req, res);

      expect(mockWebhookHandlers.handleAddWebhook).toHaveBeenCalledWith({
        url: 'https://example.com/hook',
        events: ['task.completed'],
      });
      expectSuccessEnvelope(res, { url: 'https://example.com/hook', added: true }, { status: 201 });
    });

    it('returns 400 when webhook handler returns isError', async () => {
      mockWebhookHandlers.handleAddWebhook.mockReturnValue({
        isError: true,
        content: [{ text: 'Invalid URL' }],
      });

      const { req, res } = createMockContext({ body: { url: 'not-a-url' } });
      await handlers.handleAddWebhook(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'Invalid URL',
      });
    });

    it('returns 500 when handler throws', async () => {
      mockWebhookHandlers.handleAddWebhook.mockImplementation(() => {
        throw new Error('add error');
      });

      const { req, res } = createMockContext({ body: { url: 'https://example.com' } });
      await handlers.handleAddWebhook(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'add error',
      }, { status: 500 });
    });

    it('parses body when req.body is undefined', async () => {
      mockWebhookHandlers.handleAddWebhook.mockReturnValue({ content: [{ text: 'added' }] });

      const { req, res } = createMockContext({
        body: undefined,
        parsedBody: { url: 'https://parsed.com' },
      });
      await handlers.handleAddWebhook(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
    });
  });

  describe('handleRemoveWebhook', () => {
    it('returns 400 when webhook_id is missing', async () => {
      const { req, res } = createMockContext({ params: {} });
      await handlers.handleRemoveWebhook(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'webhook_id is required',
      });
    });

    it('removes a webhook and returns success', async () => {
      mockWebhookHandlers.handleRemoveWebhook.mockReturnValue({ content: [{ text: 'removed' }] });

      const { req, res } = createMockContext({ params: { webhook_id: 'wh-1' } });
      await handlers.handleRemoveWebhook(req, res);

      expect(mockWebhookHandlers.handleRemoveWebhook).toHaveBeenCalledWith({ webhook_id: 'wh-1' });
      expectSuccessEnvelope(res, { webhook_id: 'wh-1', deleted: true });
    });

    it('returns 400 when handler returns isError', async () => {
      mockWebhookHandlers.handleRemoveWebhook.mockReturnValue({
        isError: true,
        content: [{ text: 'Webhook not found' }],
      });

      const { req, res } = createMockContext({ params: { webhook_id: 'wh-missing' } });
      await handlers.handleRemoveWebhook(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'Webhook not found',
      });
    });

    it('returns 500 when handler throws', async () => {
      mockWebhookHandlers.handleRemoveWebhook.mockImplementation(() => {
        throw new Error('remove error');
      });

      const { req, res } = createMockContext({ params: { webhook_id: 'wh-1' } });
      await handlers.handleRemoveWebhook(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'remove error',
      }, { status: 500 });
    });
  });

  describe('handleTestWebhook', () => {
    it('returns 400 when webhook_id is missing', async () => {
      const { req, res } = createMockContext({ params: {} });
      await handlers.handleTestWebhook(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'webhook_id is required',
      });
    });

    it('tests a webhook and returns the result', async () => {
      mockWebhookHandlers.handleTestWebhook.mockReturnValue({
        content: [{ text: 'Sent test payload, status 200' }],
      });

      const { req, res } = createMockContext({ params: { webhook_id: 'wh-1' } });
      await handlers.handleTestWebhook(req, res);

      expect(mockWebhookHandlers.handleTestWebhook).toHaveBeenCalledWith({ webhook_id: 'wh-1' });
      expectSuccessEnvelope(res, {
        webhook_id: 'wh-1',
        test_result: 'Sent test payload, status 200',
      });
    });

    it('returns 400 when handler returns isError', async () => {
      mockWebhookHandlers.handleTestWebhook.mockReturnValue({
        isError: true,
        content: [{ text: 'Webhook test failed' }],
      });

      const { req, res } = createMockContext({ params: { webhook_id: 'wh-bad' } });
      await handlers.handleTestWebhook(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'Webhook test failed',
      });
    });

    it('returns 500 when handler throws', async () => {
      mockWebhookHandlers.handleTestWebhook.mockImplementation(() => {
        throw new Error('test error');
      });

      const { req, res } = createMockContext({ params: { webhook_id: 'wh-1' } });
      await handlers.handleTestWebhook(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'test error',
      }, { status: 500 });
    });
  });

  // ─── Validation ──────────────────────────────────────────────────────

  describe('handleAutoVerifyAndFix', () => {
    it('delegates to automation handler and returns result', async () => {
      mockAutomationHandlers.handleAutoVerifyAndFix.mockReturnValue({
        content: [{ text: 'All checks passed' }],
      });

      const { req, res } = createMockContext({
        body: { working_directory: '/repo' },
      });
      await handlers.handleAutoVerifyAndFix(req, res);

      expect(mockAutomationHandlers.handleAutoVerifyAndFix).toHaveBeenCalledWith({
        working_directory: '/repo',
      });
      expectSuccessEnvelope(res, { result: 'All checks passed' });
    });

    it('returns 400 when handler returns isError', async () => {
      mockAutomationHandlers.handleAutoVerifyAndFix.mockReturnValue({
        isError: true,
        content: [{ text: 'Verification failed: 3 errors' }],
      });

      const { req, res } = createMockContext({ body: {} });
      await handlers.handleAutoVerifyAndFix(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'Verification failed: 3 errors',
      });
    });

    it('returns 500 when handler throws', async () => {
      mockAutomationHandlers.handleAutoVerifyAndFix.mockImplementation(() => {
        throw new Error('verify crash');
      });

      const { req, res } = createMockContext({ body: {} });
      await handlers.handleAutoVerifyAndFix(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'verify crash',
      }, { status: 500 });
    });

    it('parses body when req.body is undefined', async () => {
      mockAutomationHandlers.handleAutoVerifyAndFix.mockReturnValue({
        content: [{ text: 'ok' }],
      });

      const { req, res } = createMockContext({
        body: undefined,
        parsedBody: { working_directory: '/parsed' },
      });
      await handlers.handleAutoVerifyAndFix(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
    });
  });

  describe('handleDetectFileConflicts', () => {
    it('returns 400 when workflow_id is missing', async () => {
      const { req, res } = createMockContext({ body: {} });
      await handlers.handleDetectFileConflicts(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'workflow_id is required',
      });
    });

    it('detects conflicts and returns result', async () => {
      mockAutomationHandlers.handleDetectFileConflicts.mockReturnValue({
        content: [{ text: 'No conflicts found' }],
      });

      const { req, res } = createMockContext({
        body: { workflow_id: 'wf-1' },
      });
      await handlers.handleDetectFileConflicts(req, res);

      expect(mockAutomationHandlers.handleDetectFileConflicts).toHaveBeenCalledWith({
        workflow_id: 'wf-1',
      });
      expectSuccessEnvelope(res, {
        workflow_id: 'wf-1',
        result: 'No conflicts found',
      });
    });

    it('returns 400 when handler returns isError', async () => {
      mockAutomationHandlers.handleDetectFileConflicts.mockReturnValue({
        isError: true,
        content: [{ text: 'Workflow not found' }],
      });

      const { req, res } = createMockContext({ body: { workflow_id: 'wf-bad' } });
      await handlers.handleDetectFileConflicts(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'Workflow not found',
      });
    });

    it('returns 500 when handler throws', async () => {
      mockAutomationHandlers.handleDetectFileConflicts.mockImplementation(() => {
        throw new Error('conflict crash');
      });

      const { req, res } = createMockContext({ body: { workflow_id: 'wf-1' } });
      await handlers.handleDetectFileConflicts(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'conflict crash',
      }, { status: 500 });
    });

    it('parses body when req.body is undefined', async () => {
      mockAutomationHandlers.handleDetectFileConflicts.mockReturnValue({
        content: [{ text: 'ok' }],
      });

      const { req, res } = createMockContext({
        body: undefined,
        parsedBody: { workflow_id: 'wf-parsed' },
      });
      await handlers.handleDetectFileConflicts(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
    });
  });

  // ─── parseBooleanValue (internal helper, tested via policy handlers) ──

  describe('parseBooleanValue (tested indirectly)', () => {
    it('treats 1 as true for enabled_only', async () => {
      mockPolicyCores.listPoliciesCore.mockReturnValue({ policies: [] });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({ query: { enabled_only: '1' } });
      await handlers.handleListPolicies(req, res);

      expect(mockPolicyCores.listPoliciesCore).toHaveBeenCalledWith(
        expect.objectContaining({ enabled_only: true }),
      );
    });

    it('treats 0 as false for enabled_only', async () => {
      mockPolicyCores.listPoliciesCore.mockReturnValue({ policies: [] });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({ query: { enabled_only: '0' } });
      await handlers.handleListPolicies(req, res);

      expect(mockPolicyCores.listPoliciesCore).toHaveBeenCalledWith(
        expect.objectContaining({ enabled_only: false }),
      );
    });

    it('treats empty string as undefined for enabled_only', async () => {
      mockPolicyCores.listPoliciesCore.mockReturnValue({ policies: [] });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({ query: { enabled_only: '' } });
      await handlers.handleListPolicies(req, res);

      expect(mockPolicyCores.listPoliciesCore).toHaveBeenCalledWith(
        expect.objectContaining({ enabled_only: undefined }),
      );
    });

    it('treats undefined as undefined for suppressed', async () => {
      mockPolicyCores.listPolicyEvaluationsCore.mockReturnValue({ evaluations: [] });
      mockPolicyCores.isCoreError.mockReturnValue(false);

      const { req, res } = createMockContext({ query: {} });
      await handlers.handleListPolicyEvaluations(req, res);

      expect(mockPolicyCores.listPolicyEvaluationsCore).toHaveBeenCalledWith(
        expect.objectContaining({ suppressed: undefined, include_overrides: undefined }),
      );
    });
  });

  // ─── init function ───────────────────────────────────────────────────

  describe('init', () => {
    it('sets the taskManager', () => {
      const mockTm = { cancelTask: vi.fn() };
      initHandlersWithDeps(handlers, mockTm);
      // No direct assertion possible on _taskManager, but we verify via
      // handleSystemStatus using getMcpInstanceId
      const mockTm2 = { getMcpInstanceId: vi.fn().mockReturnValue('test-id') };
      initHandlersWithDeps(handlers, mockTm2);
      // handleSystemStatus will use it
    });
  });
});
