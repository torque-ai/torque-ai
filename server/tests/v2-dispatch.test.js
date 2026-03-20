'use strict';

/**
 * Tests for server/api/v2-dispatch.js — the v2 route dispatch bridge
 * that enables dashboard convergence by dispatching v2 CP routes
 * from any HTTP server (dashboard or API).
 */

const { PassThrough } = require('stream');

// ─── Mock handler modules ───────────────────────────────────────────────────

const mockHandlers = {
  tasks: {
    handleSubmitTask: vi.fn(),
    handleListTasks: vi.fn(),
    handleTaskDiff: vi.fn(),
    handleTaskLogs: vi.fn(),
    handleTaskProgress: vi.fn(),
    handleRetryTask: vi.fn(),
    handleCommitTask: vi.fn(),
    init: vi.fn(),
  },
  workflows: {
    handleCreateWorkflow: vi.fn(),
    handleListWorkflows: vi.fn(),
    handleGetWorkflow: vi.fn(),
    handleRunWorkflow: vi.fn(),
    handleCancelWorkflow: vi.fn(),
    handleAddWorkflowTask: vi.fn(),
    handleWorkflowHistory: vi.fn(),
    handleCreateFeatureWorkflow: vi.fn(),
    init: vi.fn(),
  },
  governance: {
    handleListApprovals: vi.fn(),
    handleApprovalDecision: vi.fn(),
    handleListSchedules: vi.fn(),
    handleCreateSchedule: vi.fn(),
    handleGetSchedule: vi.fn(),
    handleToggleSchedule: vi.fn(),
    handleDeleteSchedule: vi.fn(),
    handleListPolicies: vi.fn(),
    handleGetPolicy: vi.fn(),
    handleSetPolicyMode: vi.fn(),
    handleEvaluatePolicies: vi.fn(),
    handleListPolicyEvaluations: vi.fn(),
    handleGetPolicyEvaluation: vi.fn(),
    handleOverridePolicyDecision: vi.fn(),
    handlePeekAttestationExport: vi.fn(),
    handleListPlanProjects: vi.fn(),
    handleGetPlanProject: vi.fn(),
    handlePlanProjectAction: vi.fn(),
    handleDeletePlanProject: vi.fn(),
    handleImportPlan: vi.fn(),
    handleListBenchmarks: vi.fn(),
    handleApplyBenchmark: vi.fn(),
    handleListProjectTuning: vi.fn(),
    handleCreateProjectTuning: vi.fn(),
    handleDeleteProjectTuning: vi.fn(),
    handleProviderStats: vi.fn(),
    handleProviderToggle: vi.fn(),
    handleProviderTrends: vi.fn(),
    handleSystemStatus: vi.fn(),
    init: vi.fn(),
  },
  analytics: {
    handleStatsOverview: vi.fn(),
    handleTimeSeries: vi.fn(),
    handleQualityStats: vi.fn(),
    handleStuckTasks: vi.fn(),
    handleModelStats: vi.fn(),
    handleFormatSuccess: vi.fn(),
    handleEventHistory: vi.fn(),
    handleWebhookStats: vi.fn(),
    handleNotificationStats: vi.fn(),
    handleThroughputMetrics: vi.fn(),
    handleBudgetSummary: vi.fn(),
    handleBudgetStatus: vi.fn(),
    handleSetBudget: vi.fn(),
    handleStrategicStatus: vi.fn(),
    handleRoutingDecisions: vi.fn(),
    handleProviderHealth: vi.fn(),
    init: vi.fn(),
  },
  infrastructure: {
    handleListWorkstations: vi.fn(),
    handleCreateWorkstation: vi.fn(),
    handleToggleWorkstation: vi.fn(),
    handleProbeWorkstation: vi.fn(),
    handleDeleteWorkstation: vi.fn(),
    handleListHosts: vi.fn(),
    handleGetHost: vi.fn(),
    handleToggleHost: vi.fn(),
    handleDeleteHost: vi.fn(),
    handleHostScan: vi.fn(),
    handleListPeekHosts: vi.fn(),
    handleCreatePeekHost: vi.fn(),
    handleDeletePeekHost: vi.fn(),
    handleTogglePeekHost: vi.fn(),
    handleListCredentials: vi.fn(),
    handleSaveCredential: vi.fn(),
    handleDeleteCredential: vi.fn(),
    handleListAgents: vi.fn(),
    handleCreateAgent: vi.fn(),
    handleGetAgent: vi.fn(),
    handleAgentHealth: vi.fn(),
    handleDeleteAgent: vi.fn(),
    init: vi.fn(),
  },
};

const toolResultText = (text = '') => ({ content: [{ text }] });
const toolResultJson = (value) => ({ content: [{ text: JSON.stringify(value) }] });

// Install CJS module mocks before requiring v2-dispatch
function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

// Mock dependencies of routes.js (required by v2-dispatch.js → routes.js)
installCjsModuleMock('../database', {
  getDefaultProvider: () => null,
  onClose: () => {},
});
installCjsModuleMock('../api/v2-schemas', {
  validateInferenceRequest: vi.fn(() => ({ valid: true, errors: [], value: {} })),
});

// Mock v2-middleware normalizeError
installCjsModuleMock('../api/v2-middleware', {
  normalizeError: (err) => ({
    status: err.status || 500,
    body: { error: { code: err.code || 'internal', message: err.message } },
  }),
  requestId: vi.fn((_req, _res, next) => next()),
  validateRequest: () => vi.fn((_req, _res, next) => next()),
});

// Mock middleware (required by routes.js → middleware)
installCjsModuleMock('../api/middleware', {
  parseBody: vi.fn(async () => ({})),
  sendJson: vi.fn(),
});

// Mock handler modules
installCjsModuleMock('../api/v2-task-handlers', mockHandlers.tasks);
installCjsModuleMock('../api/v2-workflow-handlers', mockHandlers.workflows);
installCjsModuleMock('../api/v2-governance-handlers', mockHandlers.governance);
installCjsModuleMock('../api/v2-analytics-handlers', mockHandlers.analytics);
installCjsModuleMock('../api/v2-infrastructure-handlers', mockHandlers.infrastructure);
installCjsModuleMock('../handlers/remote-agent-handlers', {
  handleRunRemoteCommand: vi.fn(),
  handleRunTests: vi.fn(),
});
installCjsModuleMock('../handlers/concurrency-handlers', {
  handleGetConcurrencyLimits: vi.fn(() => toolResultJson({ limits: [] })),
  handleSetConcurrencyLimit: vi.fn(() => toolResultText('ok')),
});
installCjsModuleMock('../handlers/routing-template-handlers', {
  handleListRoutingTemplates: vi.fn(() => toolResultJson([])),
  handleGetRoutingTemplate: vi.fn(() => toolResultJson({ id: 'tpl-1', name: 'Template' })),
  handleSetRoutingTemplate: vi.fn(() => toolResultJson({ id: 'tpl-1' })),
  handleDeleteRoutingTemplate: vi.fn(() => toolResultText('deleted')),
  handleGetActiveRouting: vi.fn(() => toolResultJson({ id: 'tpl-1' })),
  handleActivateRoutingTemplate: vi.fn(() => toolResultText('activated')),
  handleListRoutingCategories: vi.fn(() => toolResultJson([])),
});
installCjsModuleMock('../handlers/strategic-config-handlers', {
  handleConfigGet: vi.fn(() => toolResultJson({})),
  handleConfigSet: vi.fn(() => ({})),
  handleConfigReset: vi.fn(() => ({})),
  handleConfigTemplates: vi.fn(() => toolResultJson([])),
});
installCjsModuleMock('../handlers/provider-crud-handlers', {
  handleAddProvider: vi.fn(async () => ({})),
  handleRemoveProvider: vi.fn(async () => ({})),
  handleSetApiKey: vi.fn(() => ({})),
  handleClearApiKey: vi.fn(() => ({})),
});
installCjsModuleMock('../handlers/economy-handlers', {
  handleGetEconomyStatus: vi.fn(() => toolResultJson({ mode: 'normal' })),
  handleSetEconomyMode: vi.fn(() => toolResultText('ok')),
});
installCjsModuleMock('../handlers/model-handlers', {
  handleListModels: vi.fn(() => toolResultJson({ data: [] })),
  handleListPendingModels: vi.fn(() => toolResultJson({ data: [] })),
  handleApproveModel: vi.fn(() => toolResultText('approved')),
  handleDenyModel: vi.fn(() => toolResultText('denied')),
  handleBulkApproveModels: vi.fn(() => toolResultText('approved')),
});

// Load v2-dispatch (must happen after mocks are installed)
let v2Dispatch;

function loadDispatch() {
  delete require.cache[require.resolve('../api/v2-dispatch')];
  v2Dispatch = require('../api/v2-dispatch');
}

// ─── Helper to create mock req/res ──────────────────────────────────────────

function mockReq(method, url, headers = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

function mockRes() {
  const res = {
    headersSent: false,
    statusCode: 200,
    _headers: {},
    _body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this._headers, headers);
    },
    setHeader(name, value) {
      this._headers[name] = value;
    },
    end(body) {
      this._body = body || '';
      this.headersSent = true;
    },
  };
  return res;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeAll(() => {
  loadDispatch();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('v2-dispatch module', () => {
  describe('exports', () => {
    it('exports dispatchV2 function', () => {
      expect(typeof v2Dispatch.dispatchV2).toBe('function');
    });

    it('exports init function', () => {
      expect(typeof v2Dispatch.init).toBe('function');
    });

    it('exports v2CpRoutes array', () => {
      expect(Array.isArray(v2Dispatch.v2CpRoutes)).toBe(true);
      expect(v2Dispatch.v2CpRoutes.length).toBeGreaterThan(0);
    });

    it('exports V2_CP_HANDLER_LOOKUP object', () => {
      expect(typeof v2Dispatch.V2_CP_HANDLER_LOOKUP).toBe('object');
    });
  });

  describe('request body parsing', () => {
    it('preserves multi-byte UTF-8 characters when a request body arrives in tiny chunks', async () => {
      const req = mockReq('POST', '/api/v2/cp/strategic/test/compare');
      const res = mockRes();
      const body = { text: 'snowman ☃ and emoji 😀' };
      const payload = Buffer.from(JSON.stringify(body), 'utf8');

      const handlerPromise = v2Dispatch.V2_CP_HANDLER_LOOKUP.handleV2CpStrategicTest(req, res, {
        params: { capability: 'compare' },
        requestId: 'req-utf8',
      });

      for (const byte of payload) {
        req.write(Buffer.from([byte]));
      }
      req.end();

      await handlerPromise;

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res._body)).toEqual({
        data: {
          capability: 'compare',
          status: 'dry_run_not_yet_implemented',
          input: body,
        },
        meta: { request_id: 'req-utf8' },
      });
    });
  });

  describe('route coverage', () => {
    it('includes task routes', () => {
      const taskRoutes = v2Dispatch.v2CpRoutes.filter(r =>
        r.handlerName.startsWith('handleV2CpSubmit') ||
        r.handlerName.startsWith('handleV2CpList') && r.handlerName.includes('Task') ||
        r.handlerName.startsWith('handleV2CpTask') ||
        r.handlerName.startsWith('handleV2CpRetry') ||
        r.handlerName.startsWith('handleV2CpCommit')
      );
      expect(taskRoutes.length).toBeGreaterThanOrEqual(7);
    });

    it('includes workflow routes', () => {
      const wfRoutes = v2Dispatch.v2CpRoutes.filter(r =>
        r.handlerName.includes('Workflow') || r.handlerName.includes('FeatureWorkflow')
      );
      expect(wfRoutes.length).toBeGreaterThanOrEqual(8);
    });

    it('includes governance routes', () => {
      const govRoutes = v2Dispatch.v2CpRoutes.filter(r =>
        r.handlerName.includes('Approval') || r.handlerName.includes('Schedule') ||
        r.handlerName.includes('PlanProject') || r.handlerName.includes('Benchmark') ||
        r.handlerName.includes('Tuning') || r.handlerName.includes('SystemStatus') ||
        r.handlerName.includes('ImportPlan') || r.handlerName.includes('ProviderStats') ||
        r.handlerName.includes('ProviderToggle') || r.handlerName.includes('ProviderTrends')
      );
      expect(govRoutes.length).toBeGreaterThanOrEqual(15);
    });

    it('includes analytics routes', () => {
      const analRoutes = v2Dispatch.v2CpRoutes.filter(r =>
        r.handlerName.includes('Stats') || r.handlerName.includes('Budget') ||
        r.handlerName.includes('Strategic') || r.handlerName.includes('TimeSeries') ||
        r.handlerName.includes('Format') || r.handlerName.includes('Event') ||
        r.handlerName.includes('Webhook') || r.handlerName.includes('Notification') ||
        r.handlerName.includes('RoutingDecisions') || r.handlerName.includes('HealthCards')
      );
      expect(analRoutes.length).toBeGreaterThanOrEqual(15);
    });

    it('includes infrastructure routes', () => {
      const infraRoutes = v2Dispatch.v2CpRoutes.filter(r =>
        r.handlerName.includes('Host') || r.handlerName.includes('PeekHost') ||
        r.handlerName.includes('Agent') || r.handlerName.includes('Credential')
      );
      expect(infraRoutes.length).toBeGreaterThanOrEqual(15);
    });

    it('all routes have resolved handler functions', () => {
      for (const route of v2Dispatch.v2CpRoutes) {
        expect(typeof route.handler).toBe('function');
      }
    });
  });

  describe('dispatchV2 — non-v2 requests', () => {
    it('returns false for non-v2 paths', async () => {
      const req = mockReq('GET', '/api/tasks');
      const res = mockRes();
      const handled = await v2Dispatch.dispatchV2(req, res);
      expect(handled).toBe(false);
    });

    it('returns false for root path', async () => {
      const req = mockReq('GET', '/');
      const res = mockRes();
      const handled = await v2Dispatch.dispatchV2(req, res);
      expect(handled).toBe(false);
    });

    it('returns false for unmatched v2 path', async () => {
      const req = mockReq('GET', '/api/v2/nonexistent');
      const res = mockRes();
      const handled = await v2Dispatch.dispatchV2(req, res);
      expect(handled).toBe(false);
    });
  });

  describe('dispatchV2 — route matching', () => {
    it('dispatches GET /api/v2/tasks to handleListTasks', async () => {
      const req = mockReq('GET', '/api/v2/tasks');
      const res = mockRes();

      const handled = await v2Dispatch.dispatchV2(req, res);

      expect(handled).toBe(true);
      expect(mockHandlers.tasks.handleListTasks).toHaveBeenCalledOnce();
    });

    it('dispatches POST /api/v2/tasks to handleSubmitTask', async () => {
      const req = mockReq('POST', '/api/v2/tasks');
      const res = mockRes();

      const handled = await v2Dispatch.dispatchV2(req, res);

      expect(handled).toBe(true);
      expect(mockHandlers.tasks.handleSubmitTask).toHaveBeenCalledOnce();
    });

    it('dispatches GET /api/v2/stats/overview to handleStatsOverview', async () => {
      const req = mockReq('GET', '/api/v2/stats/overview');
      const res = mockRes();

      const handled = await v2Dispatch.dispatchV2(req, res);

      expect(handled).toBe(true);
      expect(mockHandlers.analytics.handleStatsOverview).toHaveBeenCalledOnce();
    });

    it('dispatches GET /api/v2/approvals to handleListApprovals', async () => {
      const req = mockReq('GET', '/api/v2/approvals');
      const res = mockRes();

      const handled = await v2Dispatch.dispatchV2(req, res);

      expect(handled).toBe(true);
      expect(mockHandlers.governance.handleListApprovals).toHaveBeenCalledOnce();
    });

    it('dispatches GET /api/v2/peek/attestations/:id to handlePeekAttestationExport', async () => {
      const req = mockReq('GET', '/api/v2/peek/attestations/report-42');
      const res = mockRes();

      const handled = await v2Dispatch.dispatchV2(req, res);

      expect(handled).toBe(true);
      expect(mockHandlers.governance.handlePeekAttestationExport).toHaveBeenCalledOnce();
      expect(req.params).toEqual({ id: 'report-42' });
    });

    it('dispatches GET /api/v2/hosts to handleListHosts', async () => {
      const req = mockReq('GET', '/api/v2/hosts');
      const res = mockRes();

      const handled = await v2Dispatch.dispatchV2(req, res);

      expect(handled).toBe(true);
      expect(mockHandlers.infrastructure.handleListHosts).toHaveBeenCalledOnce();
    });

    it('dispatches GET /api/v2/workflows to handleListWorkflows', async () => {
      const req = mockReq('GET', '/api/v2/workflows');
      const res = mockRes();

      const handled = await v2Dispatch.dispatchV2(req, res);

      expect(handled).toBe(true);
      expect(mockHandlers.workflows.handleListWorkflows).toHaveBeenCalledOnce();
    });
  });

  describe('dispatchV2 — parameterized routes', () => {
    it('extracts task_id from path', async () => {
      const req = mockReq('GET', '/api/v2/tasks/abc-123/diff');
      const res = mockRes();

      await v2Dispatch.dispatchV2(req, res);

      expect(mockHandlers.tasks.handleTaskDiff).toHaveBeenCalledOnce();
      expect(req.params).toEqual({ task_id: 'abc-123' });
    });

    it('extracts schedule_id from path', async () => {
      const req = mockReq('GET', '/api/v2/schedules/sched-1');
      const res = mockRes();

      await v2Dispatch.dispatchV2(req, res);

      expect(mockHandlers.governance.handleGetSchedule).toHaveBeenCalledOnce();
      expect(req.params).toEqual({ schedule_id: 'sched-1' });
    });

    it('extracts host_id from path', async () => {
      const req = mockReq('GET', '/api/v2/hosts/host-42');
      const res = mockRes();

      await v2Dispatch.dispatchV2(req, res);

      expect(mockHandlers.infrastructure.handleGetHost).toHaveBeenCalledOnce();
      expect(req.params).toEqual({ host_id: 'host-42' });
    });

    it('extracts multiple params (host_name + credential_type)', async () => {
      const req = mockReq('PUT', '/api/v2/hosts/myhost/credentials/ssh');
      const res = mockRes();

      await v2Dispatch.dispatchV2(req, res);

      expect(mockHandlers.infrastructure.handleSaveCredential).toHaveBeenCalledOnce();
      expect(req.params).toEqual({ host_name: 'myhost', credential_type: 'ssh' });
    });

    it('extracts agent_id from path', async () => {
      const req = mockReq('GET', '/api/v2/agents/agent-7/health');
      const res = mockRes();

      await v2Dispatch.dispatchV2(req, res);

      expect(mockHandlers.infrastructure.handleAgentHealth).toHaveBeenCalledOnce();
      expect(req.params).toEqual({ agent_id: 'agent-7' });
    });
  });

  describe('dispatchV2 — query parsing', () => {
    it('parses query parameters', async () => {
      const req = mockReq('GET', '/api/v2/tasks?status=running&limit=10');
      const res = mockRes();

      await v2Dispatch.dispatchV2(req, res);

      expect(req.query).toEqual({ status: 'running', limit: '10' });
    });

    it('handles URL without query string', async () => {
      const req = mockReq('GET', '/api/v2/stats/overview');
      const res = mockRes();

      await v2Dispatch.dispatchV2(req, res);

      expect(req.query).toEqual({});
    });
  });

  describe('dispatchV2 — method matching', () => {
    it('does not match wrong HTTP method', async () => {
      // GET /api/v2/tasks is valid, but DELETE /api/v2/tasks is not
      const req = mockReq('PATCH', '/api/v2/tasks');
      const res = mockRes();

      const handled = await v2Dispatch.dispatchV2(req, res);

      expect(handled).toBe(false);
    });
  });

  describe('dispatchV2 — error handling', () => {
    it('catches handler errors and returns v2 error envelope', async () => {
      mockHandlers.analytics.handleStatsOverview.mockImplementationOnce(() => {
        throw new Error('Database offline');
      });

      const req = mockReq('GET', '/api/v2/stats/overview');
      const res = mockRes();

      const handled = await v2Dispatch.dispatchV2(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res._body);
      expect(body.error.message).toBe('Database offline');
    });

    it('does not write response if headers already sent', async () => {
      mockHandlers.analytics.handleBudgetStatus.mockImplementationOnce((_req, res) => {
        res.headersSent = true;
        throw new Error('Partial write');
      });

      const req = mockReq('GET', '/api/v2/budget/status');
      const res = mockRes();

      const handled = await v2Dispatch.dispatchV2(req, res);

      expect(handled).toBe(true);
      // No additional writeHead call since headersSent was true
      expect(res._body).toBe('');
    });
  });

  describe('init', () => {
    it('calls init on all handler modules that require it', () => {
      const tm = { submit: vi.fn() };
      v2Dispatch.init(tm);

      expect(mockHandlers.tasks.init).toHaveBeenCalledWith(tm);
      expect(mockHandlers.workflows.init).toHaveBeenCalledWith(tm);
      expect(mockHandlers.governance.init).toHaveBeenCalledWith(tm);
      expect(mockHandlers.infrastructure.init).toHaveBeenCalledWith(tm);
    });

    it('does nothing with null taskManager', () => {
      mockHandlers.tasks.init.mockClear();
      v2Dispatch.init(null);

      expect(mockHandlers.tasks.init).not.toHaveBeenCalled();
    });
  });

  describe('handler lookup completeness', () => {
    it('has entries for all 5 handler domains', () => {
      const lookup = v2Dispatch.V2_CP_HANDLER_LOOKUP;
      const keys = Object.keys(lookup);

      // Tasks: Submit, List, Diff, Logs, Progress, Retry, Commit = 7
      const taskKeys = keys.filter(k =>
        k.startsWith('handleV2CpSubmitTask') || k.startsWith('handleV2CpListTask') ||
        k.startsWith('handleV2CpTask') || k.startsWith('handleV2CpRetry') ||
        k.startsWith('handleV2CpCommit')
      );
      expect(taskKeys.length).toBe(7);

      // Workflows: 11 (8 original + PauseWorkflow, ResumeWorkflow, GetWorkflowTasks)
      const wfKeys = keys.filter(k =>
        k.includes('Workflow') || k.includes('FeatureWorkflow')
      );
      expect(wfKeys.length).toBe(11);

      // Infrastructure: hosts + peek + cred + agents = 17
      const infraKeys = keys.filter(k =>
        k.startsWith('handleV2CpList') && (k.includes('Host') || k.includes('PeekHost') || k.includes('Credential') || k.includes('Agent')) ||
        k.startsWith('handleV2CpGet') && (k.includes('Host') || k.includes('Agent')) ||
        k.startsWith('handleV2CpCreate') && (k.includes('PeekHost') || k.includes('Agent')) ||
        k.startsWith('handleV2CpDelete') && (k.includes('Host') || k.includes('PeekHost') || k.includes('Credential') || k.includes('Agent')) ||
        k.startsWith('handleV2CpToggle') && (k.includes('Host') || k.includes('PeekHost')) ||
        k.startsWith('handleV2CpHostScan') || k.startsWith('handleV2CpSaveCredential') ||
        k.startsWith('handleV2CpAgentHealth')
      );
      expect(infraKeys.length).toBe(17);
    });

    it('total handler count is at least 60', () => {
      expect(Object.keys(v2Dispatch.V2_CP_HANDLER_LOOKUP).length).toBeGreaterThanOrEqual(60);
    });
  });
});
