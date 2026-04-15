'use strict';

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function mockRes() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

describe('factory loop instance routes', () => {
  let mockHandlers;
  let mockSendSuccess;
  let mockSendError;
  let mockParseBody;
  let FACTORY_V2_ROUTES;

  beforeEach(() => {
    vi.resetModules();
    // Force factory-routes to reload so it picks up the fresh mock handlers.
    // vi.resetModules() clears vitest's registry but some require.cache entries
    // can survive; explicitly drop the routes module so the next require()
    // re-binds factoryHandlers to our mock.
    try { delete require.cache[require.resolve('../api/routes/factory-routes')]; } catch { /* not loaded yet */ }
    try { delete require.cache[require.resolve('../handlers/factory-handlers')]; } catch { /* not loaded yet */ }

    mockHandlers = {
      handleListFactoryLoopInstances: vi.fn(),
      handleStartFactoryLoopInstance: vi.fn(),
      handleFactoryLoopInstanceStatus: vi.fn(),
      handleAdvanceFactoryLoopInstanceAsync: vi.fn(),
      handleFactoryLoopInstanceJobStatus: vi.fn(),
      handleApproveFactoryGateInstance: vi.fn(),
      handleRejectFactoryGateInstance: vi.fn(),
      handleRetryFactoryVerifyInstance: vi.fn(),
    };
    mockSendSuccess = vi.fn();
    mockSendError = vi.fn();
    mockParseBody = vi.fn();

    installCjsModuleMock('../handlers/factory-handlers', mockHandlers);
    installCjsModuleMock('../api/v2-control-plane', {
      sendSuccess: mockSendSuccess,
      sendError: mockSendError,
    });
    installCjsModuleMock('../api/middleware', {
      parseBody: mockParseBody,
    });

    ({ FACTORY_V2_ROUTES } = require('../api/routes/factory-routes'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function findRoute(predicate, label) {
    const route = FACTORY_V2_ROUTES.find(predicate);
    expect(route).toBeDefined();
    expect(typeof route.handler).toBe('function');
    return route;
  }

  it('registers the per-instance routes with exact tool names and scoped regex paths', () => {
    const listRoute = findRoute((route) => route.tool === 'list_factory_loop_instances', 'list_factory_loop_instances');
    expect(listRoute).toMatchObject({
      method: 'GET',
      mapParams: ['project'],
      mapQuery: true,
      handlerName: 'handleListFactoryLoopInstances',
    });
    expect(listRoute.path.test('/api/v2/factory/projects/project-1/loops')).toBe(true);

    const startRoute = findRoute((route) => route.tool === 'start_factory_loop_instance', 'start_factory_loop_instance');
    expect(startRoute).toMatchObject({
      method: 'POST',
      mapParams: ['project'],
      handlerName: 'handleStartFactoryLoopInstance',
    });
    expect(startRoute.path.test('/api/v2/factory/projects/project-1/loops/start')).toBe(true);

    const statusRoute = findRoute((route) => route.tool === 'factory_loop_instance_status', 'factory_loop_instance_status');
    expect(statusRoute).toMatchObject({
      method: 'GET',
      mapParams: ['instance_id'],
      handlerName: 'handleFactoryLoopInstanceStatus',
    });
    expect(statusRoute.path.test(`/api/v2/factory/loops/${INSTANCE_ID}`)).toBe(true);
    expect(statusRoute.path.test(`/api/v2/factory/loops/${INSTANCE_ID}/advance`)).toBe(false);

    const advanceRoute = findRoute((route) => route.tool === 'advance_factory_loop_instance', 'advance_factory_loop_instance');
    expect(advanceRoute).toMatchObject({
      method: 'POST',
      mapParams: ['instance_id'],
      handlerName: 'handleAdvanceFactoryLoopInstanceAsync',
    });
    expect(advanceRoute.path.test(`/api/v2/factory/loops/${INSTANCE_ID}/advance`)).toBe(true);
    expect(advanceRoute.path.test(`/api/v2/factory/projects/project-1/loop/advance`)).toBe(false);

    const advanceJobRoute = findRoute((route) => route.handlerName === 'handleFactoryLoopInstanceJobStatus', 'handleFactoryLoopInstanceJobStatus');
    expect(advanceJobRoute).toMatchObject({
      method: 'GET',
      mapParams: ['instance_id', 'job_id'],
    });
    expect(advanceJobRoute.path.test(`/api/v2/factory/loops/${INSTANCE_ID}/advance/${JOB_ID}`)).toBe(true);

    const approveRoute = findRoute((route) => route.tool === 'approve_factory_gate_instance', 'approve_factory_gate_instance');
    expect(approveRoute).toMatchObject({
      method: 'POST',
      mapParams: ['instance_id'],
      mapBody: true,
      handlerName: 'handleApproveFactoryGateInstance',
    });

    const rejectRoute = findRoute((route) => route.tool === 'reject_factory_gate_instance', 'reject_factory_gate_instance');
    expect(rejectRoute).toMatchObject({
      method: 'POST',
      mapParams: ['instance_id'],
      mapBody: true,
      handlerName: 'handleRejectFactoryGateInstance',
    });

    const retryRoute = findRoute((route) => route.tool === 'retry_factory_verify_instance', 'retry_factory_verify_instance');
    expect(retryRoute).toMatchObject({
      method: 'POST',
      mapParams: ['instance_id'],
      handlerName: 'handleRetryFactoryVerifyInstance',
    });
  });

  it('does not let the instance advance path get shadowed by the project loop regexes', () => {
    const projectAdvanceRoute = FACTORY_V2_ROUTES.find((route) => route.handlerName === 'handleAdvanceFactoryLoopAsync');
    const instanceAdvanceRoute = FACTORY_V2_ROUTES.find((route) => route.handlerName === 'handleAdvanceFactoryLoopInstanceAsync');
    const listRoute = FACTORY_V2_ROUTES.find((route) => route.tool === 'list_factory_loop_instances');

    expect(projectAdvanceRoute.path.test(`/api/v2/factory/loops/${INSTANCE_ID}/advance`)).toBe(false);
    expect(listRoute.path.test(`/api/v2/factory/loops/${INSTANCE_ID}/advance`)).toBe(false);
    expect(instanceAdvanceRoute.path.test(`/api/v2/factory/loops/${INSTANCE_ID}/advance`)).toBe(true);
  });

  it.each([
    {
      label: 'list instances',
      routeSelector: (route) => route.tool === 'list_factory_loop_instances',
      handlerName: 'handleListFactoryLoopInstances',
      req: { params: { project: 'proj-1' }, query: { active_only: 'true' } },
      successResult: { structuredData: { project_id: 'proj-1', active_only: true, count: 1, instances: [{ id: INSTANCE_ID }] } },
      expectedArgs: { project: 'proj-1', active_only: true },
      expectedStatus: 200,
      expectedData: { project_id: 'proj-1', active_only: true, count: 1, instances: [{ id: INSTANCE_ID }] },
      notFoundResult: { status: 404, errorCode: 'RESOURCE_NOT_FOUND', errorMessage: 'Project not found: proj-404' },
      expectedNotFoundArgs: { project: 'proj-404', active_only: false },
      notFoundReq: { params: { project: 'proj-404' }, query: { active_only: 'false' } },
    },
    {
      label: 'start instance',
      routeSelector: (route) => route.tool === 'start_factory_loop_instance',
      handlerName: 'handleStartFactoryLoopInstance',
      req: { params: { project: 'proj-1' } },
      successResult: { structuredData: { id: INSTANCE_ID, project_id: 'proj-1', loop_state: 'SENSE' } },
      expectedArgs: { project: 'proj-1' },
      expectedStatus: 200,
      expectedData: { id: INSTANCE_ID, project_id: 'proj-1', loop_state: 'SENSE' },
      notFoundResult: { status: 404, errorCode: 'RESOURCE_NOT_FOUND', errorMessage: 'Project not found: proj-404' },
      expectedNotFoundArgs: { project: 'proj-404' },
      notFoundReq: { params: { project: 'proj-404' } },
    },
    {
      label: 'instance status',
      routeSelector: (route) => route.tool === 'factory_loop_instance_status',
      handlerName: 'handleFactoryLoopInstanceStatus',
      req: { params: { instance_id: INSTANCE_ID } },
      successResult: { structuredData: { id: INSTANCE_ID, loop_state: 'PLAN' } },
      expectedArgs: { instance: INSTANCE_ID },
      expectedStatus: 200,
      expectedData: { id: INSTANCE_ID, loop_state: 'PLAN' },
      notFoundResult: { status: 404, errorCode: 'RESOURCE_NOT_FOUND', errorMessage: `Factory loop instance not found: ${OTHER_INSTANCE_ID}` },
      expectedNotFoundArgs: { instance: OTHER_INSTANCE_ID },
      notFoundReq: { params: { instance_id: OTHER_INSTANCE_ID } },
    },
    {
      label: 'advance instance',
      routeSelector: (route) => route.tool === 'advance_factory_loop_instance',
      handlerName: 'handleAdvanceFactoryLoopInstanceAsync',
      req: { params: { instance_id: INSTANCE_ID } },
      successResult: {
        status: 202,
        headers: { Location: `/api/v2/factory/loops/${INSTANCE_ID}/advance/${JOB_ID}` },
        structuredData: { job_id: JOB_ID, status: 'running' },
      },
      expectedArgs: { instance: INSTANCE_ID },
      expectedStatus: 202,
      expectedData: { job_id: JOB_ID, status: 'running' },
      expectedHeaders: { Location: `/api/v2/factory/loops/${INSTANCE_ID}/advance/${JOB_ID}` },
      notFoundResult: { status: 404, errorCode: 'RESOURCE_NOT_FOUND', errorMessage: `Factory loop instance not found: ${OTHER_INSTANCE_ID}` },
      expectedNotFoundArgs: { instance: OTHER_INSTANCE_ID },
      notFoundReq: { params: { instance_id: OTHER_INSTANCE_ID } },
    },
    {
      label: 'advance job status',
      routeSelector: (route) => route.handlerName === 'handleFactoryLoopInstanceJobStatus',
      handlerName: 'handleFactoryLoopInstanceJobStatus',
      req: { params: { instance_id: INSTANCE_ID, job_id: JOB_ID } },
      successResult: { structuredData: { job_id: JOB_ID, status: 'completed', new_state: 'PRIORITIZE' } },
      expectedArgs: { instance: INSTANCE_ID, job_id: JOB_ID },
      expectedStatus: 200,
      expectedData: { job_id: JOB_ID, status: 'completed', new_state: 'PRIORITIZE' },
      notFoundResult: { status: 404, errorCode: 'RESOURCE_NOT_FOUND', errorMessage: `Loop advance job not found: ${JOB_ID}` },
      expectedNotFoundArgs: { instance: INSTANCE_ID, job_id: JOB_ID },
      notFoundReq: { params: { instance_id: INSTANCE_ID, job_id: JOB_ID } },
    },
    {
      label: 'approve gate',
      routeSelector: (route) => route.tool === 'approve_factory_gate_instance',
      handlerName: 'handleApproveFactoryGateInstance',
      req: { params: { instance_id: INSTANCE_ID }, body: { stage: 'PLAN' } },
      successResult: { structuredData: { instance_id: INSTANCE_ID, state: 'PLAN', message: 'Gate approved, loop continuing' } },
      expectedArgs: { instance: INSTANCE_ID, stage: 'PLAN' },
      expectedStatus: 200,
      expectedData: { instance_id: INSTANCE_ID, state: 'PLAN', message: 'Gate approved, loop continuing' },
      notFoundResult: { status: 404, errorCode: 'RESOURCE_NOT_FOUND', errorMessage: `Factory loop instance not found: ${OTHER_INSTANCE_ID}` },
      expectedNotFoundArgs: { instance: OTHER_INSTANCE_ID, stage: 'PLAN' },
      notFoundReq: { params: { instance_id: OTHER_INSTANCE_ID }, body: { stage: 'PLAN' } },
    },
    {
      label: 'reject gate',
      routeSelector: (route) => route.tool === 'reject_factory_gate_instance',
      handlerName: 'handleRejectFactoryGateInstance',
      req: { params: { instance_id: INSTANCE_ID }, body: { stage: 'VERIFY' } },
      successResult: { structuredData: { instance_id: INSTANCE_ID, state: 'IDLE', message: 'Gate rejected, loop stopped' } },
      expectedArgs: { instance: INSTANCE_ID, stage: 'VERIFY' },
      expectedStatus: 200,
      expectedData: { instance_id: INSTANCE_ID, state: 'IDLE', message: 'Gate rejected, loop stopped' },
      notFoundResult: { status: 404, errorCode: 'RESOURCE_NOT_FOUND', errorMessage: `Factory loop instance not found: ${OTHER_INSTANCE_ID}` },
      expectedNotFoundArgs: { instance: OTHER_INSTANCE_ID, stage: 'VERIFY' },
      notFoundReq: { params: { instance_id: OTHER_INSTANCE_ID }, body: { stage: 'VERIFY' } },
    },
    {
      label: 'retry verify',
      routeSelector: (route) => route.tool === 'retry_factory_verify_instance',
      handlerName: 'handleRetryFactoryVerifyInstance',
      req: { params: { instance_id: INSTANCE_ID } },
      successResult: { structuredData: { instance_id: INSTANCE_ID, state: 'VERIFY', message: 'VERIFY retry requested; advance the loop to re-run remote verify' } },
      expectedArgs: { instance: INSTANCE_ID },
      expectedStatus: 200,
      expectedData: { instance_id: INSTANCE_ID, state: 'VERIFY', message: 'VERIFY retry requested; advance the loop to re-run remote verify' },
      notFoundResult: { status: 404, errorCode: 'RESOURCE_NOT_FOUND', errorMessage: `Factory loop instance not found: ${OTHER_INSTANCE_ID}` },
      expectedNotFoundArgs: { instance: OTHER_INSTANCE_ID },
      notFoundReq: { params: { instance_id: OTHER_INSTANCE_ID } },
    },
  ])('maps args and preserves success/not-found statuses for $label', async ({
    routeSelector,
    handlerName,
    req,
    successResult,
    expectedArgs,
    expectedStatus,
    expectedData,
    expectedHeaders,
    notFoundReq,
    notFoundResult,
    expectedNotFoundArgs,
  }) => {
    const route = findRoute(routeSelector, handlerName);
    const requestId = `${handlerName}-req`;

    mockHandlers[handlerName].mockResolvedValueOnce(successResult);
    mockParseBody.mockResolvedValueOnce(req.body || {});

    const res = mockRes();
    await route.handler(
      { params: req.params || {}, query: req.query || {}, body: req.body },
      res,
      { requestId, params: req.params || {}, query: req.query || {} },
    );

    expect(mockHandlers[handlerName]).toHaveBeenCalledWith(expectedArgs);
    expect(mockSendSuccess).toHaveBeenLastCalledWith(
      res,
      requestId,
      expectedData,
      expectedStatus,
      expect.objectContaining({ params: req.params || {}, query: req.query || {} }),
    );
    if (expectedHeaders) {
      expect(res.headers).toEqual(expect.objectContaining(expectedHeaders));
    }

    mockHandlers[handlerName].mockResolvedValueOnce(notFoundResult);
    mockParseBody.mockResolvedValueOnce(notFoundReq.body || {});

    const notFoundRes = mockRes();
    await route.handler(
      { params: notFoundReq.params || {}, query: notFoundReq.query || {}, body: notFoundReq.body },
      notFoundRes,
      { requestId: `${requestId}-404`, params: notFoundReq.params || {}, query: notFoundReq.query || {} },
    );

    expect(mockHandlers[handlerName]).toHaveBeenLastCalledWith(expectedNotFoundArgs);
    expect(mockSendError).toHaveBeenLastCalledWith(
      notFoundRes,
      `${requestId}-404`,
      notFoundResult.errorCode,
      notFoundResult.errorMessage,
      404,
      {},
      expect.objectContaining({ params: notFoundReq.params || {}, query: notFoundReq.query || {} }),
    );
  });
});
