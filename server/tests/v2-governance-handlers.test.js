'use strict';

const HANDLER_MODULE = '../api/v2-governance-handlers';
const MODULE_PATHS = [
  HANDLER_MODULE,
  '../api/v2-control-plane',
  '../api/middleware',
  '../database',
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

const FIXED_TIMESTAMP = '2026-03-10T12:34:56.789Z';

let currentModules = {};

vi.mock('../database', () => currentModules.db);
vi.mock('../api/middleware', () => currentModules.middleware);
vi.mock('../handlers/policy-handlers', () => currentModules.policyHandlers);
vi.mock('../tools', () => currentModules.tools);

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
      // Ignore modules that were not loaded.
    }
  }
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

function loadHandlers() {
  currentModules = createDefaultModules();

  vi.resetModules();
  clearLoadedModules();

  installCjsModuleMock('../database', currentModules.db);
  installCjsModuleMock('../db/file-tracking', currentModules.db);
  installCjsModuleMock('../db/host-management', currentModules.db);
  installCjsModuleMock('../db/project-config-core', currentModules.db);
  installCjsModuleMock('../db/provider-routing-core', currentModules.db);
  installCjsModuleMock('../db/scheduling-automation', currentModules.db);
  installCjsModuleMock('../db/task-core', currentModules.db);
  installCjsModuleMock('../db/validation-rules', currentModules.db);
  installCjsModuleMock('../db/webhooks-streaming', currentModules.db);
  installCjsModuleMock('../api/middleware', currentModules.middleware);
  installCjsModuleMock('../handlers/policy-handlers', currentModules.policyHandlers);
  installCjsModuleMock('../tools', currentModules.tools);

  return {
    handlers: require(HANDLER_MODULE),
    mocks: currentModules,
  };
}

function initHandlersWithDeps(handlers, db, taskManager = null) {
  handlers.init?.({ db, taskManager });
  if (taskManager) {
    handlers.init?.(taskManager);
  }
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

function expectListEnvelope(res, items, total, requestId = 'req-123') {
  expect(res.statusCode).toBe(200);
  expect(res._body.data).toEqual({ items, total });
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

function createCoreError({
  code = 'validation_error',
  message = 'Invalid input',
  status = 400,
  details = {},
} = {}) {
  return {
    error: {
      code,
      message,
      status,
      details,
    },
  };
}

describe('api/v2-governance-handlers', () => {
  let handlers;
  let mocks;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TIMESTAMP));

    const loaded = loadHandlers();
    handlers = loaded.handlers;
    mocks = loaded.mocks;
    initHandlersWithDeps(handlers, mocks.db);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    currentModules = {};
    clearLoadedModules();
    vi.resetModules();
  });

  describe('policy handlers', () => {
    describe('handleListPolicies', () => {
      it('returns policies and forwards parsed filters', async () => {
        const policies = [{ id: 'policy-1', mode: 'warn' }];
        mocks.policyHandlers.listPoliciesCore.mockReturnValue({ policies });
        const { req, res } = createMockContext({
          query: {
            project_id: 'project-1',
            profile_id: 'profile-1',
            category: 'quality',
            stage: 'task_submit',
            mode: 'warn',
            enabled_only: '0',
          },
        });

        await handlers.handleListPolicies(req, res);

        expect(mocks.policyHandlers.listPoliciesCore).toHaveBeenCalledWith({
          project_id: 'project-1',
          profile_id: 'profile-1',
          category: 'quality',
          stage: 'task_submit',
          mode: 'warn',
          enabled_only: false,
        });
        expectSuccessEnvelope(res, policies);
      });

      it('returns 400 when enabled_only is invalid', async () => {
        const { req, res } = createMockContext({
          query: { enabled_only: 'sometimes' },
        });

        await handlers.handleListPolicies(req, res);

        expect(mocks.policyHandlers.listPoliciesCore).not.toHaveBeenCalled();
        expectErrorEnvelope(res, {
          code: 'validation_error',
          message: 'enabled_only must be "true" or "false"',
          details: { field: 'enabled_only' },
        });
      });

      it('forwards core errors from listPoliciesCore', async () => {
        mocks.policyHandlers.listPoliciesCore.mockReturnValue(createCoreError({
          code: 'validation_error',
          message: 'profile_id must be a string',
          details: { field: 'profile_id' },
        }));

        const { req, res } = createMockContext();
        await handlers.handleListPolicies(req, res);

        expectErrorEnvelope(res, {
          code: 'validation_error',
          message: 'profile_id must be a string',
          details: { field: 'profile_id' },
        });
      });
    });

    describe('handleGetPolicy', () => {
      it('returns a single policy', async () => {
        const policy = { id: 'policy-1', name: 'Size Gate', mode: 'block' };
        mocks.policyHandlers.getPolicyCore.mockReturnValue({ policy });
        const { req, res } = createMockContext({
          params: { policy_id: 'policy-1' },
        });

        await handlers.handleGetPolicy(req, res);

        expect(mocks.policyHandlers.getPolicyCore).toHaveBeenCalledWith({
          policy_id: 'policy-1',
        });
        expectSuccessEnvelope(res, policy);
      });

      it('returns 404 when the policy is not found', async () => {
        mocks.policyHandlers.getPolicyCore.mockReturnValue(createCoreError({
          code: 'policy_not_found',
          message: 'Policy not found: missing-policy',
          status: 404,
        }));

        const { req, res } = createMockContext({
          params: { policy_id: 'missing-policy' },
        });

        await handlers.handleGetPolicy(req, res);

        expectErrorEnvelope(res, {
          code: 'policy_not_found',
          message: 'Policy not found: missing-policy',
          status: 404,
        });
      });
    });

    describe('handleSetPolicyMode', () => {
      it('sets the policy mode from req.body', async () => {
        const result = { policy_id: 'policy-1', mode: 'shadow' };
        mocks.policyHandlers.setPolicyModeCore.mockReturnValue(result);
        const { req, res } = createMockContext({
          params: { policy_id: 'policy-1' },
          body: { mode: 'shadow' },
        });

        await handlers.handleSetPolicyMode(req, res);

        expect(mocks.policyHandlers.setPolicyModeCore).toHaveBeenCalledWith({
          mode: 'shadow',
          policy_id: 'policy-1',
        });
        expectSuccessEnvelope(res, result);
      });

      it('parses the request body when req.body is missing', async () => {
        const result = { policy_id: 'policy-2', mode: 'advisory' };
        mocks.policyHandlers.setPolicyModeCore.mockReturnValue(result);
        const { req, res } = createMockContext({
          params: { policy_id: 'policy-2' },
          parsedBody: { mode: 'advisory' },
        });

        await handlers.handleSetPolicyMode(req, res);

        expect(mocks.middleware.parseBody).toHaveBeenCalledWith(req);
        expect(mocks.policyHandlers.setPolicyModeCore).toHaveBeenCalledWith({
          mode: 'advisory',
          policy_id: 'policy-2',
        });
        expectSuccessEnvelope(res, result);
      });

      it('forwards validation errors from setPolicyModeCore', async () => {
        mocks.policyHandlers.setPolicyModeCore.mockReturnValue(createCoreError({
          code: 'policy_mode_invalid',
          message: 'mode must be one of: off, shadow, advisory, warn, block',
          details: { field: 'mode' },
        }));

        const { req, res } = createMockContext({
          params: { policy_id: 'policy-1' },
          body: {},
        });

        await handlers.handleSetPolicyMode(req, res);

        expectErrorEnvelope(res, {
          code: 'policy_mode_invalid',
          message: 'mode must be one of: off, shadow, advisory, warn, block',
          details: { field: 'mode' },
        });
      });
    });

    describe('handleEvaluatePolicies', () => {
      it('evaluates policies from req.body', async () => {
        const result = {
          policy_id: 'policy-1',
          target_id: 'task-1',
          evaluations: [{ outcome: 'pass' }],
        };
        mocks.policyHandlers.evaluatePoliciesCore.mockReturnValue(result);
        const { req, res } = createMockContext({
          body: { target_type: 'task', target_id: 'task-1' },
        });

        await handlers.handleEvaluatePolicies(req, res);

        expect(mocks.policyHandlers.evaluatePoliciesCore).toHaveBeenCalledWith({
          target_type: 'task',
          target_id: 'task-1',
        });
        expectSuccessEnvelope(res, result);
      });

      it('passes an empty object when parseBody returns nothing', async () => {
        mocks.middleware.parseBody.mockResolvedValue(undefined);
        mocks.policyHandlers.evaluatePoliciesCore.mockReturnValue({ evaluations: [] });
        const { req, res } = createMockContext();

        await handlers.handleEvaluatePolicies(req, res);

        expect(mocks.middleware.parseBody).toHaveBeenCalledWith(req);
        expect(mocks.policyHandlers.evaluatePoliciesCore).toHaveBeenCalledWith({});
        expectSuccessEnvelope(res, { evaluations: [] });
      });

      it('forwards validation errors from evaluatePoliciesCore', async () => {
        mocks.policyHandlers.evaluatePoliciesCore.mockReturnValue(createCoreError({
          code: 'validation_error',
          message: 'target_type is required and must be a non-empty string',
          details: { field: 'target_type' },
        }));

        const { req, res } = createMockContext({
          body: {},
        });

        await handlers.handleEvaluatePolicies(req, res);

        expectErrorEnvelope(res, {
          code: 'validation_error',
          message: 'target_type is required and must be a non-empty string',
          details: { field: 'target_type' },
        });
      });
    });

    describe('handleListPolicyEvaluations', () => {
      it('returns evaluations and forwards boolean query filters', async () => {
        const evaluations = [{ id: 'eval-1', outcome: 'fail' }];
        mocks.policyHandlers.listPolicyEvaluationsCore.mockReturnValue({ evaluations });
        const { req, res } = createMockContext({
          query: {
            project_id: 'project-1',
            policy_id: 'policy-1',
            profile_id: 'profile-1',
            stage: 'task_submit',
            outcome: 'fail',
            suppressed: '1',
            include_overrides: 'false',
            target_type: 'task',
            target_id: 'task-1',
            scope_fingerprint: 'scope-1',
            limit: '25',
            offset: '5',
          },
        });

        await handlers.handleListPolicyEvaluations(req, res);

        expect(mocks.policyHandlers.listPolicyEvaluationsCore).toHaveBeenCalledWith({
          project_id: 'project-1',
          policy_id: 'policy-1',
          profile_id: 'profile-1',
          stage: 'task_submit',
          outcome: 'fail',
          suppressed: true,
          target_type: 'task',
          target_id: 'task-1',
          scope_fingerprint: 'scope-1',
          include_overrides: false,
          limit: '25',
          offset: '5',
        });
        expectSuccessEnvelope(res, evaluations);
      });

      it('returns 400 when suppressed is invalid', async () => {
        const { req, res } = createMockContext({
          query: { suppressed: 'maybe' },
        });

        await handlers.handleListPolicyEvaluations(req, res);

        expect(mocks.policyHandlers.listPolicyEvaluationsCore).not.toHaveBeenCalled();
        expectErrorEnvelope(res, {
          code: 'validation_error',
          message: 'suppressed must be "true" or "false"',
          details: { field: 'suppressed' },
        });
      });

      it('returns 400 when include_overrides is invalid', async () => {
        const { req, res } = createMockContext({
          query: { include_overrides: 'later' },
        });

        await handlers.handleListPolicyEvaluations(req, res);

        expect(mocks.policyHandlers.listPolicyEvaluationsCore).not.toHaveBeenCalled();
        expectErrorEnvelope(res, {
          code: 'validation_error',
          message: 'include_overrides must be "true" or "false"',
          details: { field: 'include_overrides' },
        });
      });
    });

    describe('handleGetPolicyEvaluation', () => {
      it('returns a single policy evaluation', async () => {
        const evaluation = { id: 'eval-1', outcome: 'pass', overrides: [] };
        mocks.policyHandlers.getPolicyEvaluationCore.mockReturnValue({ evaluation });
        const { req, res } = createMockContext({
          params: { evaluation_id: 'eval-1' },
          query: { include_overrides: 'true' },
        });

        await handlers.handleGetPolicyEvaluation(req, res);

        expect(mocks.policyHandlers.getPolicyEvaluationCore).toHaveBeenCalledWith({
          evaluation_id: 'eval-1',
          include_overrides: true,
        });
        expectSuccessEnvelope(res, evaluation);
      });

      it('returns 400 when include_overrides is invalid', async () => {
        const { req, res } = createMockContext({
          params: { evaluation_id: 'eval-1' },
          query: { include_overrides: 'nah' },
        });

        await handlers.handleGetPolicyEvaluation(req, res);

        expect(mocks.policyHandlers.getPolicyEvaluationCore).not.toHaveBeenCalled();
        expectErrorEnvelope(res, {
          code: 'validation_error',
          message: 'include_overrides must be "true" or "false"',
          details: { field: 'include_overrides' },
        });
      });

      it('returns 404 when the evaluation is not found', async () => {
        mocks.policyHandlers.getPolicyEvaluationCore.mockReturnValue(createCoreError({
          code: 'evaluation_not_found',
          message: 'Policy evaluation not found: missing-eval',
          status: 404,
        }));

        const { req, res } = createMockContext({
          params: { evaluation_id: 'missing-eval' },
        });

        await handlers.handleGetPolicyEvaluation(req, res);

        expectErrorEnvelope(res, {
          code: 'evaluation_not_found',
          message: 'Policy evaluation not found: missing-eval',
          status: 404,
        });
      });
    });

    describe('handleOverridePolicyDecision', () => {
      it('creates an override and returns 201', async () => {
        const result = { override_id: 'override-1', evaluation_id: 'eval-1' };
        mocks.policyHandlers.overridePolicyDecisionCore.mockReturnValue(result);
        const { req, res } = createMockContext({
          params: { evaluation_id: 'eval-1' },
          body: { reason_code: 'false_positive', overridden_by: 'admin' },
        });

        await handlers.handleOverridePolicyDecision(req, res);

        expect(mocks.policyHandlers.overridePolicyDecisionCore).toHaveBeenCalledWith({
          reason_code: 'false_positive',
          overridden_by: 'admin',
          evaluation_id: 'eval-1',
        });
        expectSuccessEnvelope(res, result, { status: 201 });
      });

      it('parses the body when req.body is missing', async () => {
        const result = { override_id: 'override-2' };
        mocks.policyHandlers.overridePolicyDecisionCore.mockReturnValue(result);
        const { req, res } = createMockContext({
          params: { evaluation_id: 'eval-2' },
          parsedBody: { reason_code: 'accepted_risk' },
        });

        await handlers.handleOverridePolicyDecision(req, res);

        expect(mocks.middleware.parseBody).toHaveBeenCalledWith(req);
        expect(mocks.policyHandlers.overridePolicyDecisionCore).toHaveBeenCalledWith({
          reason_code: 'accepted_risk',
          evaluation_id: 'eval-2',
        });
        expectSuccessEnvelope(res, result, { status: 201 });
      });

      it('forwards override policy errors', async () => {
        mocks.policyHandlers.overridePolicyDecisionCore.mockReturnValue(createCoreError({
          code: 'override_not_allowed',
          message: 'Policy mode block does not allow overrides',
          status: 403,
        }));

        const { req, res } = createMockContext({
          params: { evaluation_id: 'eval-1' },
          body: { reason_code: 'accepted_risk' },
        });

        await handlers.handleOverridePolicyDecision(req, res);

        expectErrorEnvelope(res, {
          code: 'override_not_allowed',
          message: 'Policy mode block does not allow overrides',
          status: 403,
        });
      });
    });
  });

  describe('project registry handlers', () => {
    it('handleListProjects returns the known project registry as a structured list', async () => {
      const projects = [
        { name: 'alpha', task_count: 2, last_active: '2026-03-02T11:00:00.000Z', has_config: true },
        { name: 'beta', task_count: 0, last_active: null, has_config: true },
      ];
      mocks.db.listKnownProjects.mockReturnValue(projects);

      const { req, res } = createMockContext();
      await handlers.handleListProjects(req, res);

      expect(mocks.db.listKnownProjects).toHaveBeenCalledTimes(1);
      expectListEnvelope(res, projects, projects.length);
    });

    it('handleListProjects returns an empty list when the registry is unavailable', async () => {
      const saved = mocks.db.listKnownProjects;
      mocks.db.listKnownProjects = null;

      try {
        const { req, res } = createMockContext();
        await handlers.handleListProjects(req, res);
        expectListEnvelope(res, [], 0);
      } finally {
        mocks.db.listKnownProjects = saved;
      }
    });
  });

  describe('plan project handlers', () => {
    describe('handleListPlanProjects', () => {
      it('returns projects with computed progress and a clamped limit', async () => {
        mocks.db.listPlanProjects.mockReturnValue([
          { id: 'plan-1', total_tasks: 3, completed_tasks: 1, status: 'running' },
          { id: 'plan-2', total_tasks: 0, completed_tasks: 0, status: 'queued' },
        ]);
        const { req, res } = createMockContext({
          query: { status: 'running', limit: '500' },
        });

        await handlers.handleListPlanProjects(req, res);

        expect(mocks.db.listPlanProjects).toHaveBeenCalledWith({
          status: 'running',
          limit: 100,
        });
        expectListEnvelope(res, [
          { id: 'plan-1', total_tasks: 3, completed_tasks: 1, status: 'running', progress: 33 },
          { id: 'plan-2', total_tasks: 0, completed_tasks: 0, status: 'queued', progress: 0 },
        ], 2);
      });

      it('normalizes non-array database results to an empty list', async () => {
        mocks.db.listPlanProjects.mockReturnValue(null);
        const { req, res } = createMockContext({
          query: { limit: '5' },
        });

        await handlers.handleListPlanProjects(req, res);

        expectListEnvelope(res, [], 0);
      });

      it('returns 500 when listing plan projects fails', async () => {
        mocks.db.listPlanProjects.mockImplementation(() => {
          throw new Error('list failed');
        });
        const { req, res } = createMockContext();

        await handlers.handleListPlanProjects(req, res);

        expectErrorEnvelope(res, {
          code: 'operation_failed',
          message: 'list failed',
          status: 500,
        });
      });
    });

    describe('handleGetPlanProject', () => {
      it('returns a plan project with tasks and computed progress', async () => {
        mocks.db.getPlanProject.mockReturnValue({
          id: 'plan-1',
          name: 'Alpha',
          total_tasks: 8,
          completed_tasks: 3,
          status: 'running',
        });
        mocks.db.getPlanProjectTasks.mockReturnValue([
          { task_id: 'task-1', status: 'completed' },
          { task_id: 'task-2', status: 'running' },
        ]);
        const { req, res } = createMockContext({
          params: { project_id: 'plan-1' },
        });

        await handlers.handleGetPlanProject(req, res);

        expect(mocks.db.getPlanProject).toHaveBeenCalledWith('plan-1');
        expect(mocks.db.getPlanProjectTasks).toHaveBeenCalledWith('plan-1');
        expectSuccessEnvelope(res, {
          id: 'plan-1',
          name: 'Alpha',
          total_tasks: 8,
          completed_tasks: 3,
          status: 'running',
          progress: 38,
          tasks: [
            { task_id: 'task-1', status: 'completed' },
            { task_id: 'task-2', status: 'running' },
          ],
        });
      });

      it('returns 404 when the plan project is not found', async () => {
        const { req, res } = createMockContext({
          params: { project_id: 'missing-plan' },
        });

        await handlers.handleGetPlanProject(req, res);

        expectErrorEnvelope(res, {
          code: 'project_not_found',
          message: 'Plan project not found: missing-plan',
          status: 404,
        });
      });

      it('resolves the request id from the header when requestId is missing', async () => {
        mocks.db.getPlanProject.mockReturnValue({
          id: 'plan-2',
          total_tasks: 1,
          completed_tasks: 1,
          status: 'completed',
        });
        const { req, res } = createMockContext({
          requestId: undefined,
          headers: { 'x-request-id': 'req-from-header' },
          params: { project_id: 'plan-2' },
        });

        await handlers.handleGetPlanProject(req, res);

        expectSuccessEnvelope(res, {
          id: 'plan-2',
          total_tasks: 1,
          completed_tasks: 1,
          status: 'completed',
          progress: 100,
          tasks: [],
        }, { requestId: 'req-from-header' });
      });
    });

    describe('handlePlanProjectAction', () => {
      it('returns 400 when the action is missing', async () => {
        const { req, res } = createMockContext({
          params: { project_id: 'plan-1' },
        });

        await handlers.handlePlanProjectAction(req, res);

        expectErrorEnvelope(res, {
          code: 'validation_error',
          message: 'Invalid action: undefined. Must be one of: pause, resume, retry',
        });
      });

      it('returns 404 when the project is not found', async () => {
        const { req, res } = createMockContext({
          params: { project_id: 'missing-plan', action: 'pause' },
        });

        await handlers.handlePlanProjectAction(req, res);

        expect(mocks.tools.handleToolCall).not.toHaveBeenCalled();
        expectErrorEnvelope(res, {
          code: 'project_not_found',
          message: 'Plan project not found: missing-plan',
          status: 404,
        });
      });

      it('delegates valid actions to the tools layer', async () => {
        mocks.db.getPlanProject.mockReturnValue({ id: 'plan-1' });
        mocks.tools.handleToolCall.mockResolvedValue({ paused: true });
        const { req, res } = createMockContext({
          params: { project_id: 'plan-1', action: 'pause' },
        });

        await handlers.handlePlanProjectAction(req, res);

        expect(mocks.tools.handleToolCall).toHaveBeenCalledWith('pause_plan_project', {
          project_id: 'plan-1',
        });
        expectSuccessEnvelope(res, {
          project_id: 'plan-1',
          action: 'pause',
          result: { paused: true },
        });
      });

      it('uses a default success payload when the tool returns nothing', async () => {
        mocks.db.getPlanProject.mockReturnValue({ id: 'plan-2' });
        mocks.tools.handleToolCall.mockResolvedValue(null);
        const { req, res } = createMockContext({
          params: { project_id: 'plan-2', action: 'resume' },
        });

        await handlers.handlePlanProjectAction(req, res);

        expectSuccessEnvelope(res, {
          project_id: 'plan-2',
          action: 'resume',
          result: { success: true },
        });
      });

      it('returns 500 when the action tool throws', async () => {
        mocks.db.getPlanProject.mockReturnValue({ id: 'plan-3' });
        mocks.tools.handleToolCall.mockRejectedValue(new Error('tool exploded'));
        const { req, res } = createMockContext({
          params: { project_id: 'plan-3', action: 'retry' },
        });

        await handlers.handlePlanProjectAction(req, res);

        expectErrorEnvelope(res, {
          code: 'operation_failed',
          message: 'tool exploded',
          status: 500,
        });
      });
    });

    describe('handleDeletePlanProject', () => {
      it('returns 404 when the plan project does not exist', async () => {
        const { req, res } = createMockContext({
          params: { project_id: 'missing-plan' },
        });

        await handlers.handleDeletePlanProject(req, res);

        expect(mocks.taskManager.cancelTask).not.toHaveBeenCalled();
        expectErrorEnvelope(res, {
          code: 'project_not_found',
          message: 'Plan project not found: missing-plan',
          status: 404,
        });
      });

      it('cancels active tasks, deletes the project, and returns success', async () => {
        initHandlersWithDeps(handlers, mocks.db, mocks.taskManager);
        mocks.db.getPlanProject.mockReturnValue({ id: 'plan-1' });
        mocks.db.getPlanProjectTasks.mockReturnValue([
          { task_id: 'task-queued', status: 'queued' },
          { task_id: 'task-running', status: 'running' },
          { task_id: 'task-waiting', status: 'waiting' },
          { task_id: 'task-completed', status: 'completed' },
        ]);
        const { req, res } = createMockContext({
          params: { project_id: 'plan-1' },
        });

        await handlers.handleDeletePlanProject(req, res);

        expect(mocks.taskManager.cancelTask).toHaveBeenCalledTimes(3);
        expect(mocks.taskManager.cancelTask).toHaveBeenCalledWith(
          'task-queued',
          'Plan project deleted via v2 API',
        );
        expect(mocks.taskManager.cancelTask).toHaveBeenCalledWith(
          'task-running',
          'Plan project deleted via v2 API',
        );
        expect(mocks.taskManager.cancelTask).toHaveBeenCalledWith(
          'task-waiting',
          'Plan project deleted via v2 API',
        );
        expect(mocks.db.deletePlanProject).toHaveBeenCalledWith('plan-1');
        expectSuccessEnvelope(res, {
          deleted: true,
          project_id: 'plan-1',
        });
      });

      it('falls back to updateTaskStatus when cancellation throws', async () => {
        initHandlersWithDeps(handlers, mocks.db, mocks.taskManager);
        mocks.db.getPlanProject.mockReturnValue({ id: 'plan-2' });
        mocks.db.getPlanProjectTasks.mockReturnValue([
          { task_id: 'task-1', status: 'running' },
        ]);
        mocks.taskManager.cancelTask.mockImplementation(() => {
          throw new Error('cancel failed');
        });
        const { req, res } = createMockContext({
          params: { project_id: 'plan-2' },
        });

        await handlers.handleDeletePlanProject(req, res);

        expect(mocks.db.updateTaskStatus).toHaveBeenCalledWith('task-1', 'cancelled', {
          error_output: 'Plan project deleted',
        });
        expect(mocks.db.deletePlanProject).toHaveBeenCalledWith('plan-2');
        expectSuccessEnvelope(res, {
          deleted: true,
          project_id: 'plan-2',
        });
      });

      it('skips cancellation when no task manager has been initialized', async () => {
        initHandlersWithDeps(handlers, mocks.db);
        mocks.db.getPlanProject.mockReturnValue({ id: 'plan-3' });
        const { req, res } = createMockContext({
          params: { project_id: 'plan-3' },
        });

        await handlers.handleDeletePlanProject(req, res);

        expect(mocks.db.getPlanProjectTasks).not.toHaveBeenCalled();
        expect(mocks.taskManager.cancelTask).not.toHaveBeenCalled();
        expect(mocks.db.deletePlanProject).toHaveBeenCalledWith('plan-3');
        expectSuccessEnvelope(res, {
          deleted: true,
          project_id: 'plan-3',
        });
      });

      it('returns 500 when deleting the plan project fails', async () => {
        mocks.db.getPlanProject.mockReturnValue({ id: 'plan-4' });
        mocks.db.deletePlanProject.mockImplementation(() => {
          throw new Error('delete failed');
        });
        const { req, res } = createMockContext({
          params: { project_id: 'plan-4' },
        });

        await handlers.handleDeletePlanProject(req, res);

        expectErrorEnvelope(res, {
          code: 'operation_failed',
          message: 'delete failed',
          status: 500,
        });
      });
    });
  });
});
