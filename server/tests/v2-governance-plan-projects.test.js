'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXED_ISO = '2026-03-10T12:34:56.789Z';
const TEMP_ROOT = path.join(__dirname, '.tmp-v2-governance-plan-projects');

const mockDb = {
  listPlanProjects: vi.fn(),
  getPlanProject: vi.fn(),
  getPlanProjectTasks: vi.fn(),
  deletePlanProject: vi.fn(),
};

const mockTaskCore = {
  updateTaskStatus: vi.fn(),
};

const mockTools = {
  handleToolCall: vi.fn(),
};

const mockSendJson = vi.fn();
const mockMiddleware = {
  parseBody: vi.fn(),
  sendJson: mockSendJson,
};

const mockTaskManager = {
  cancelTask: vi.fn(),
};

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModuleCache() {
  delete require.cache[require.resolve('../api/v2-governance-handlers')];
  delete require.cache[require.resolve('../api/v2-control-plane')];
  delete require.cache[require.resolve('../api/middleware')];
  delete require.cache[require.resolve('../db/task-core')];
  delete require.cache[require.resolve('../db/project-config-core')];
  delete require.cache[require.resolve('../tools')];
}

function loadHandlers() {
  clearModuleCache();
  installCjsModuleMock('../db/task-core', mockTaskCore);
  installCjsModuleMock('../db/project-config-core', mockDb);
  installCjsModuleMock('../tools', mockTools);
  installCjsModuleMock('../api/middleware', mockMiddleware);
  return require('../api/v2-governance-handlers');
}

function ensureMockFn(target, key) {
  if (!target[key] || typeof target[key].mockReturnValue !== 'function') {
    target[key] = vi.fn();
  }
  return target[key];
}

function resetMockDefaults() {
  ensureMockFn(mockDb, 'listPlanProjects').mockReturnValue([]);
  ensureMockFn(mockDb, 'getPlanProject').mockReturnValue(null);
  ensureMockFn(mockDb, 'getPlanProjectTasks').mockReturnValue([]);
  ensureMockFn(mockDb, 'deletePlanProject').mockReturnValue(undefined);
  ensureMockFn(mockTaskCore, 'updateTaskStatus').mockReturnValue(undefined);

  ensureMockFn(mockTools, 'handleToolCall').mockResolvedValue({ success: true });

  ensureMockFn(mockMiddleware, 'parseBody').mockResolvedValue({});
  mockSendJson.mockImplementation((res, data, status = 200, req = null) => {
    const headers = { 'Content-Type': 'application/json' };
    if (req?.requestId) headers['X-Request-ID'] = req.requestId;
    res.writeHead(status, headers);
    res.end(JSON.stringify(data));
  });

  ensureMockFn(mockTaskManager, 'cancelTask').mockReturnValue(undefined);
}

function createReq(overrides = {}) {
  return {
    params: {},
    query: {},
    requestId: 'req-123',
    headers: {},
    ...overrides,
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    _body: null,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); },
    end(body) { this._body = typeof body === 'string' ? JSON.parse(body) : body; },
  };
  return res;
}

function expectMeta(body, requestId = 'req-123') {
  expect(body.meta).toEqual({
    request_id: requestId,
    timestamp: FIXED_ISO,
  });
}

function expectErrorResponse(res, {
  status,
  code,
  message,
  requestId = 'req-123',
  details = {},
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

let handlers;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_ISO));
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  vi.spyOn(os, 'tmpdir').mockReturnValue(TEMP_ROOT);

  resetMockDefaults();
  handlers = loadHandlers();
  handlers.init(mockTaskManager);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  clearModuleCache();
});

describe('api/v2-governance-handlers.handleListPlanProjects', () => {
  it('returns a list envelope with progress percentages', async () => {
    mockDb.listPlanProjects.mockReturnValue([
      { id: 'plan-1', name: 'Alpha', total_tasks: 4, completed_tasks: 1, status: 'running' },
      { id: 'plan-2', name: 'Beta', total_tasks: 0, completed_tasks: 0, status: 'queued' },
    ]);

    const req = createReq({ query: { status: 'running', limit: '5' } });
    const res = createMockRes();

    await handlers.handleListPlanProjects(req, res);

    expect(mockDb.listPlanProjects).toHaveBeenCalledWith({ status: 'running', limit: 5 });
    expect(res.statusCode).toBe(200);
    expect(res._body.data).toEqual({
      items: [
        { id: 'plan-1', name: 'Alpha', total_tasks: 4, completed_tasks: 1, status: 'running', progress: 25 },
        { id: 'plan-2', name: 'Beta', total_tasks: 0, completed_tasks: 0, status: 'queued', progress: 0 },
      ],
      total: 2,
    });
    expectMeta(res._body);
  });

  it('uses the default limit of 20 when the query omits limit', async () => {
    const req = createReq({ query: { status: 'paused' } });
    const res = createMockRes();

    await handlers.handleListPlanProjects(req, res);

    expect(mockDb.listPlanProjects).toHaveBeenCalledWith({ status: 'paused', limit: 20 });
    expect(res._body.data).toEqual({ items: [], total: 0 });
  });

  it('falls back to the default limit when the query limit is not numeric', async () => {
    const req = createReq({ query: { limit: 'abc' } });
    const res = createMockRes();

    await handlers.handleListPlanProjects(req, res);

    expect(mockDb.listPlanProjects).toHaveBeenCalledWith({ status: undefined, limit: 20 });
  });

  it('clamps negative limits to 1', async () => {
    const req = createReq({ query: { limit: '-4' } });
    const res = createMockRes();

    await handlers.handleListPlanProjects(req, res);

    expect(mockDb.listPlanProjects).toHaveBeenCalledWith({ status: undefined, limit: 1 });
  });

  it('clamps large limits to 100', async () => {
    const req = createReq({ query: { limit: '500' } });
    const res = createMockRes();

    await handlers.handleListPlanProjects(req, res);

    expect(mockDb.listPlanProjects).toHaveBeenCalledWith({ status: undefined, limit: 100 });
  });

  it('returns an empty list when the database result is not an array', async () => {
    mockDb.listPlanProjects.mockReturnValue(null);
    const req = createReq();
    const res = createMockRes();

    await handlers.handleListPlanProjects(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._body.data).toEqual({ items: [], total: 0 });
    expectMeta(res._body);
  });

  it('returns an empty list when listPlanProjects is unavailable', async () => {
    mockDb.listPlanProjects = undefined;
    handlers = loadHandlers();
    handlers.init(mockTaskManager);

    const req = createReq();
    const res = createMockRes();

    await handlers.handleListPlanProjects(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._body.data).toEqual({ items: [], total: 0 });
    expectMeta(res._body);
  });

  it('returns a 500 error when listing projects fails', async () => {
    mockDb.listPlanProjects.mockImplementation(() => {
      throw new Error('list failed');
    });

    const req = createReq({ query: { status: 'running' } });
    const res = createMockRes();

    await handlers.handleListPlanProjects(req, res);

    expectErrorResponse(res, {
      status: 500,
      code: 'operation_failed',
      message: 'list failed',
    });
  });
});

describe('api/v2-governance-handlers.handleGetPlanProject', () => {
  it('returns a project with tasks and computed progress', async () => {
    mockDb.getPlanProject.mockReturnValue({
      id: 'plan-1',
      name: 'Alpha',
      total_tasks: 8,
      completed_tasks: 3,
      status: 'running',
    });
    mockDb.getPlanProjectTasks.mockReturnValue([
      { task_id: 'task-1', status: 'completed' },
      { task_id: 'task-2', status: 'running' },
    ]);

    const req = createReq({ params: { project_id: 'plan-1' } });
    const res = createMockRes();

    await handlers.handleGetPlanProject(req, res);

    expect(mockDb.getPlanProject).toHaveBeenCalledWith('plan-1');
    expect(mockDb.getPlanProjectTasks).toHaveBeenCalledWith('plan-1');
    expect(res.statusCode).toBe(200);
    expect(res._body.data).toEqual({
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
    expectMeta(res._body);
  });

  it('reports zero progress when total_tasks is zero', async () => {
    mockDb.getPlanProject.mockReturnValue({
      id: 'plan-2',
      total_tasks: 0,
      completed_tasks: 7,
      status: 'queued',
    });

    const req = createReq({ params: { project_id: 'plan-2' } });
    const res = createMockRes();

    await handlers.handleGetPlanProject(req, res);

    expect(res._body.data.progress).toBe(0);
    expect(res._body.data.tasks).toEqual([]);
  });

  it('returns an empty task list when the project task lookup is not an array', async () => {
    mockDb.getPlanProject.mockReturnValue({
      id: 'plan-3',
      total_tasks: 1,
      completed_tasks: 1,
      status: 'completed',
    });
    mockDb.getPlanProjectTasks.mockReturnValue('not-an-array');

    const req = createReq({ params: { project_id: 'plan-3' } });
    const res = createMockRes();

    await handlers.handleGetPlanProject(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._body.data.tasks).toEqual([]);
  });

  it('returns 404 when the project does not exist', async () => {
    const req = createReq({ params: { project_id: 'missing-plan' } });
    const res = createMockRes();

    await handlers.handleGetPlanProject(req, res);

    expectErrorResponse(res, {
      status: 404,
      code: 'project_not_found',
      message: 'Plan project not found: missing-plan',
    });
  });

  it('resolves the request id from the x-request-id header when req.requestId is absent', async () => {
    mockDb.getPlanProject.mockReturnValue({
      id: 'plan-4',
      total_tasks: 2,
      completed_tasks: 1,
      status: 'running',
    });

    const req = createReq({
      requestId: undefined,
      headers: { 'x-request-id': 'req-from-header' },
      params: { project_id: 'plan-4' },
    });
    const res = createMockRes();

    await handlers.handleGetPlanProject(req, res);

    expectMeta(res._body, 'req-from-header');
  });
});

describe('api/v2-governance-handlers.handlePlanProjectAction', () => {
  it('returns 400 when the action is missing', async () => {
    const req = createReq({ params: { project_id: 'plan-1' } });
    const res = createMockRes();

    await handlers.handlePlanProjectAction(req, res);

    expectErrorResponse(res, {
      status: 400,
      code: 'validation_error',
      message: 'Invalid action: undefined. Must be one of: pause, resume, retry',
    });
  });

  it('returns 400 when the action is invalid', async () => {
    const req = createReq({ params: { project_id: 'plan-1', action: 'stop' } });
    const res = createMockRes();

    await handlers.handlePlanProjectAction(req, res);

    expectErrorResponse(res, {
      status: 400,
      code: 'validation_error',
      message: 'Invalid action: stop. Must be one of: pause, resume, retry',
    });
  });

  it('returns 404 when the target plan project does not exist', async () => {
    const req = createReq({ params: { project_id: 'missing-plan', action: 'pause' } });
    const res = createMockRes();

    await handlers.handlePlanProjectAction(req, res);

    expectErrorResponse(res, {
      status: 404,
      code: 'project_not_found',
      message: 'Plan project not found: missing-plan',
    });
    expect(mockTools.handleToolCall).not.toHaveBeenCalled();
  });

  it('delegates pause actions to handleToolCall', async () => {
    mockDb.getPlanProject.mockReturnValue({ id: 'plan-1' });
    mockTools.handleToolCall.mockResolvedValue({ paused: true });

    const req = createReq({ params: { project_id: 'plan-1', action: 'pause' } });
    const res = createMockRes();

    await handlers.handlePlanProjectAction(req, res);

    expect(mockTools.handleToolCall).toHaveBeenCalledWith('pause_plan_project', { project_id: 'plan-1' });
    expect(res._body.data).toEqual({
      project_id: 'plan-1',
      action: 'pause',
      result: { paused: true },
    });
    expectMeta(res._body);
  });

  it('delegates resume actions to handleToolCall', async () => {
    mockDb.getPlanProject.mockReturnValue({ id: 'plan-2' });
    mockTools.handleToolCall.mockResolvedValue({ resumed: true });

    const req = createReq({ params: { project_id: 'plan-2', action: 'resume' } });
    const res = createMockRes();

    await handlers.handlePlanProjectAction(req, res);

    expect(mockTools.handleToolCall).toHaveBeenCalledWith('resume_plan_project', { project_id: 'plan-2' });
    expect(res._body.data.result).toEqual({ resumed: true });
  });

  it('delegates retry actions to handleToolCall', async () => {
    mockDb.getPlanProject.mockReturnValue({ id: 'plan-3' });
    mockTools.handleToolCall.mockResolvedValue({ retried: 4 });

    const req = createReq({ params: { project_id: 'plan-3', action: 'retry' } });
    const res = createMockRes();

    await handlers.handlePlanProjectAction(req, res);

    expect(mockTools.handleToolCall).toHaveBeenCalledWith('retry_plan_project', { project_id: 'plan-3' });
    expect(res._body.data.result).toEqual({ retried: 4 });
  });

  it('uses a default success payload when the tool returns a falsy result', async () => {
    mockDb.getPlanProject.mockReturnValue({ id: 'plan-4' });
    mockTools.handleToolCall.mockResolvedValue(null);

    const req = createReq({ params: { project_id: 'plan-4', action: 'pause' } });
    const res = createMockRes();

    await handlers.handlePlanProjectAction(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._body.data.result).toEqual({ success: true });
  });

  it('returns 500 when the action tool throws', async () => {
    mockDb.getPlanProject.mockReturnValue({ id: 'plan-5' });
    mockTools.handleToolCall.mockRejectedValue(new Error('tool exploded'));

    const req = createReq({ params: { project_id: 'plan-5', action: 'resume' } });
    const res = createMockRes();

    await handlers.handlePlanProjectAction(req, res);

    expectErrorResponse(res, {
      status: 500,
      code: 'operation_failed',
      message: 'tool exploded',
    });
  });
});

describe('api/v2-governance-handlers.handleDeletePlanProject', () => {
  it('returns 404 when the plan project does not exist', async () => {
    const req = createReq({ params: { project_id: 'missing-plan' } });
    const res = createMockRes();

    await handlers.handleDeletePlanProject(req, res);

    expectErrorResponse(res, {
      status: 404,
      code: 'project_not_found',
      message: 'Plan project not found: missing-plan',
    });
    expect(mockTaskManager.cancelTask).not.toHaveBeenCalled();
  });

  it('cancels active tasks, deletes the project, and returns success', async () => {
    mockDb.getPlanProject.mockReturnValue({ id: 'plan-1' });
    mockDb.getPlanProjectTasks.mockReturnValue([
      { task_id: 'task-queued', status: 'queued' },
      { task_id: 'task-running', status: 'running' },
      { task_id: 'task-waiting', status: 'waiting' },
      { task_id: 'task-completed', status: 'completed' },
    ]);

    const req = createReq({ params: { project_id: 'plan-1' } });
    const res = createMockRes();

    await handlers.handleDeletePlanProject(req, res);

    expect(mockDb.getPlanProjectTasks).toHaveBeenCalledWith('plan-1');
    expect(mockTaskManager.cancelTask).toHaveBeenCalledTimes(3);
    expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('task-queued', 'Plan project deleted via v2 API');
    expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('task-running', 'Plan project deleted via v2 API');
    expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('task-waiting', 'Plan project deleted via v2 API');
    expect(mockDb.deletePlanProject).toHaveBeenCalledWith('plan-1');
    expect(res._body.data).toEqual({ deleted: true, project_id: 'plan-1' });
    expectMeta(res._body);
  });

  it('ignores tasks that are not queued, running, or waiting', async () => {
    mockDb.getPlanProject.mockReturnValue({ id: 'plan-2' });
    mockDb.getPlanProjectTasks.mockReturnValue([
      { task_id: 'task-completed', status: 'completed' },
      { task_id: 'task-cancelled', status: 'cancelled' },
      { task_id: 'task-failed', status: 'failed' },
    ]);

    const req = createReq({ params: { project_id: 'plan-2' } });
    const res = createMockRes();

    await handlers.handleDeletePlanProject(req, res);

    expect(mockTaskManager.cancelTask).not.toHaveBeenCalled();
    expect(mockDb.deletePlanProject).toHaveBeenCalledWith('plan-2');
    expect(res.statusCode).toBe(200);
  });

  it('falls back to updateTaskStatus when task cancellation throws', async () => {
    mockDb.getPlanProject.mockReturnValue({ id: 'plan-3' });
    mockDb.getPlanProjectTasks.mockReturnValue([
      { task_id: 'task-1', status: 'running' },
    ]);
    mockTaskManager.cancelTask.mockImplementation(() => {
      throw new Error('cancel failed');
    });

    const req = createReq({ params: { project_id: 'plan-3' } });
    const res = createMockRes();

    await handlers.handleDeletePlanProject(req, res);

    expect(mockTaskCore.updateTaskStatus).toHaveBeenCalledWith('task-1', 'cancelled', {
      error_output: 'Plan project deleted',
    });
    expect(mockDb.deletePlanProject).toHaveBeenCalledWith('plan-3');
    expect(res.statusCode).toBe(200);
  });

  it('skips cancellation work when no task manager has been initialized', async () => {
    handlers.init(null);
    mockDb.getPlanProject.mockReturnValue({ id: 'plan-4' });

    const req = createReq({ params: { project_id: 'plan-4' } });
    const res = createMockRes();

    await handlers.handleDeletePlanProject(req, res);

    expect(mockDb.getPlanProjectTasks).not.toHaveBeenCalled();
    expect(mockTaskManager.cancelTask).not.toHaveBeenCalled();
    expect(mockDb.deletePlanProject).toHaveBeenCalledWith('plan-4');
    expect(res.statusCode).toBe(200);
  });

  it('returns 500 when project deletion fails', async () => {
    mockDb.getPlanProject.mockReturnValue({ id: 'plan-5' });
    mockDb.getPlanProjectTasks.mockReturnValue([]);
    mockDb.deletePlanProject.mockImplementation(() => {
      throw new Error('delete failed');
    });

    const req = createReq({ params: { project_id: 'plan-5' } });
    const res = createMockRes();

    await handlers.handleDeletePlanProject(req, res);

    expectErrorResponse(res, {
      status: 500,
      code: 'operation_failed',
      message: 'delete failed',
    });
  });
});

describe('api/v2-governance-handlers.handleImportPlan', () => {
  it('returns 400 when plan_content is missing from req.body', async () => {
    const req = createReq({ body: { project_name: 'Alpha' } });
    const res = createMockRes();

    await handlers.handleImportPlan(req, res);

    expectErrorResponse(res, {
      status: 400,
      code: 'validation_error',
      message: 'plan_content is required',
    });
    expect(mockMiddleware.parseBody).not.toHaveBeenCalled();
  });

  it('parses the request body when req.body is missing and validates plan_content', async () => {
    mockMiddleware.parseBody.mockResolvedValue({ project_name: 'Alpha' });

    const req = createReq();
    const res = createMockRes();

    await handlers.handleImportPlan(req, res);

    expect(mockMiddleware.parseBody).toHaveBeenCalledWith(req);
    expectErrorResponse(res, {
      status: 400,
      code: 'validation_error',
      message: 'plan_content is required',
    });
  });

  it('writes a temp file, calls import_plan, defaults dry_run to true, and cleans up the file', async () => {
    const req = createReq({
      body: {
        plan_content: '# Imported Plan\n- task one',
        project_name: 'Alpha',
        working_directory: '/repo',
      },
    });
    const res = createMockRes();
    let observedFilePath = null;

    mockTools.handleToolCall.mockImplementation(async (toolName, payload) => {
      observedFilePath = payload.file_path;
      expect(toolName).toBe('import_plan');
      expect(payload).toEqual({
        file_path: observedFilePath,
        project_name: 'Alpha',
        dry_run: true,
        working_directory: '/repo',
      });
      expect(fs.existsSync(observedFilePath)).toBe(true);
      expect(fs.readFileSync(observedFilePath, 'utf8')).toBe('# Imported Plan\n- task one');
      return { imported: 2, project_id: 'plan-1' };
    });

    await handlers.handleImportPlan(req, res);

    expect(mockTools.handleToolCall).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(res._body.data).toEqual({ imported: 2, project_id: 'plan-1' });
    expectMeta(res._body);
    expect(path.dirname(observedFilePath)).toBe(TEMP_ROOT);
    expect(path.basename(observedFilePath)).toMatch(/^plan-[0-9a-f-]+\.md$/);
    expect(fs.existsSync(observedFilePath)).toBe(false);
  });

  it('passes dry_run false through to the import tool', async () => {
    const req = createReq({
      body: {
        plan_content: '# Plan',
        dry_run: false,
      },
    });
    const res = createMockRes();

    await handlers.handleImportPlan(req, res);

    const [toolName, payload] = mockTools.handleToolCall.mock.calls.at(-1);
    expect(toolName).toBe('import_plan');
    expect(payload).toEqual({
      file_path: expect.any(String),
      project_name: undefined,
      dry_run: false,
      working_directory: undefined,
    });
    expect(path.dirname(payload.file_path)).toBe(TEMP_ROOT);
    expect(path.basename(payload.file_path)).toMatch(/^plan-[0-9a-f-]+\.md$/);
  });

  it('returns 400 when the import tool reports an error and still cleans up the temp file', async () => {
    const req = createReq({
      body: {
        plan_content: '# Plan',
        project_name: 'Alpha',
      },
    });
    const res = createMockRes();
    let observedFilePath = null;

    mockTools.handleToolCall.mockImplementation(async (_toolName, payload) => {
      observedFilePath = payload.file_path;
      expect(fs.existsSync(observedFilePath)).toBe(true);
      return { error: 'invalid markdown structure' };
    });

    await handlers.handleImportPlan(req, res);

    expectErrorResponse(res, {
      status: 400,
      code: 'operation_failed',
      message: 'invalid markdown structure',
    });
    expect(fs.existsSync(observedFilePath)).toBe(false);
  });

  it('returns 500 when the import tool response is not an object', async () => {
    const req = createReq({
      body: {
        plan_content: '# Plan',
      },
    });
    const res = createMockRes();

    mockTools.handleToolCall.mockResolvedValue('bad-response');

    await handlers.handleImportPlan(req, res);

    expectErrorResponse(res, {
      status: 500,
      code: 'operation_failed',
      message: 'Invalid import tool response',
    });
    expect(fs.existsSync(path.join(TEMP_ROOT, 'plan-1773146096789.md'))).toBe(false);
  });

  it('returns 500 and cleans up the temp file when the import tool throws', async () => {
    const req = createReq({
      body: {
        plan_content: '# Plan',
      },
    });
    const res = createMockRes();

    mockTools.handleToolCall.mockImplementation(async (_toolName, payload) => {
      expect(fs.existsSync(payload.file_path)).toBe(true);
      throw new Error('tool crash');
    });

    await handlers.handleImportPlan(req, res);

    expectErrorResponse(res, {
      status: 500,
      code: 'operation_failed',
      message: 'tool crash',
    });
    expect(fs.existsSync(path.join(TEMP_ROOT, 'plan-1773146096789.md'))).toBe(false);
  });

  it('returns 500 when writing the temp file fails', async () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    const req = createReq({
      body: {
        plan_content: '# Plan',
      },
    });
    const res = createMockRes();

    await handlers.handleImportPlan(req, res);

    expectErrorResponse(res, {
      status: 500,
      code: 'operation_failed',
      message: 'disk full',
    });
    expect(mockTools.handleToolCall).not.toHaveBeenCalled();
  });
});
