'use strict';

const mockDb = {
  getCoordinationDashboard: vi.fn(),
  listAgents: vi.fn(),
  listRoutingRules: vi.fn(),
  listClaims: vi.fn(),
  listPendingApprovals: vi.fn(),
  getApprovalHistory: vi.fn(),
  decideApproval: vi.fn(),
  listScheduledTasks: vi.fn(),
  createCronScheduledTask: vi.fn(),
  toggleScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
  getBenchmarkResults: vi.fn(),
  getBenchmarkStats: vi.fn(),
  applyBenchmarkResults: vi.fn(),
  listProjectTuning: vi.fn(),
  setProjectTuning: vi.fn(),
  getProjectTuning: vi.fn(),
  deleteProjectTuning: vi.fn(),
  listPlanProjects: vi.fn(),
  getPlanProject: vi.fn(),
  getPlanProjectTasks: vi.fn(),
  deletePlanProject: vi.fn(),
  updateTaskStatus: vi.fn(),
};

const mockLogger = {
  debug: vi.fn(),
};

const mockUtils = {
  sendJson: vi.fn(),
  sendError: vi.fn(),
  parseBody: vi.fn(),
  safeDecodeParam: vi.fn(),
};

const mockTools = {
  handleToolCall: vi.fn(),
};

const mockTaskManager = {
  cancelTask: vi.fn(),
};

const mockFs = {
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
};

function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

installMock('../database', mockDb);
installMock('../logger', mockLogger);
installMock('../dashboard/utils', mockUtils);
installMock('../tools', mockTools);
installMock('../task-manager', mockTaskManager);
installMock('fs', mockFs);

const admin = require('../dashboard/routes/admin');

function createMockRes() {
  return {
    statusCode: null,
    headers: null,
    payload: null,
    body: null,
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

function resetDbDefaults() {
  mockDb.getCoordinationDashboard.mockReset();
  mockDb.getCoordinationDashboard.mockReturnValue({});
  mockDb.listAgents.mockReset();
  mockDb.listAgents.mockReturnValue([]);
  mockDb.listRoutingRules.mockReset();
  mockDb.listRoutingRules.mockReturnValue([]);
  mockDb.listClaims.mockReset();
  mockDb.listClaims.mockReturnValue([]);
  mockDb.listPendingApprovals.mockReset();
  mockDb.listPendingApprovals.mockReturnValue([]);
  mockDb.getApprovalHistory.mockReset();
  mockDb.getApprovalHistory.mockReturnValue([]);
  mockDb.decideApproval.mockReset();
  mockDb.decideApproval.mockReturnValue({ id: 'approval-1' });
  mockDb.listScheduledTasks.mockReset();
  mockDb.listScheduledTasks.mockReturnValue([]);
  mockDb.createCronScheduledTask.mockReset();
  mockDb.createCronScheduledTask.mockReturnValue({ id: 'schedule-1' });
  mockDb.toggleScheduledTask.mockReset();
  mockDb.toggleScheduledTask.mockReturnValue({ id: 'schedule-1', enabled: true });
  mockDb.deleteScheduledTask.mockReset();
  mockDb.deleteScheduledTask.mockReturnValue(true);
  mockDb.getBenchmarkResults.mockReset();
  mockDb.getBenchmarkResults.mockReturnValue([]);
  mockDb.getBenchmarkStats.mockReset();
  mockDb.getBenchmarkStats.mockReturnValue({});
  mockDb.applyBenchmarkResults.mockReset();
  mockDb.applyBenchmarkResults.mockReturnValue({ ok: true });
  mockDb.listProjectTuning.mockReset();
  mockDb.listProjectTuning.mockReturnValue([]);
  mockDb.setProjectTuning.mockReset();
  mockDb.setProjectTuning.mockReturnValue(undefined);
  mockDb.getProjectTuning.mockReset();
  mockDb.getProjectTuning.mockReturnValue({ projectPath: '/tmp/project', settings: {} });
  mockDb.deleteProjectTuning.mockReset();
  mockDb.deleteProjectTuning.mockReturnValue(true);
  mockDb.listPlanProjects.mockReset();
  mockDb.listPlanProjects.mockReturnValue([]);
  mockDb.getPlanProject.mockReset();
  mockDb.getPlanProject.mockReturnValue({ id: 'project-1', total_tasks: 2, completed_tasks: 1 });
  mockDb.getPlanProjectTasks.mockReset();
  mockDb.getPlanProjectTasks.mockReturnValue([]);
  mockDb.deletePlanProject.mockReset();
  mockDb.deletePlanProject.mockReturnValue(true);
  mockDb.updateTaskStatus.mockReset();
  mockDb.updateTaskStatus.mockReturnValue(undefined);
}

function resetDependencyDefaults() {
  mockLogger.debug.mockReset();
  mockTools.handleToolCall.mockReset();
  mockTools.handleToolCall.mockResolvedValue({ ok: true });
  mockTaskManager.cancelTask.mockReset();
  mockTaskManager.cancelTask.mockReturnValue(undefined);
  mockFs.writeFileSync.mockReset();
  mockFs.writeFileSync.mockReturnValue(undefined);
  mockFs.unlinkSync.mockReset();
  mockFs.unlinkSync.mockReturnValue(undefined);
}

function resetUtilsDefaults() {
  mockUtils.sendJson.mockReset();
  mockUtils.sendJson.mockImplementation((res, payload, statusCode = 200) => {
    res.statusCode = statusCode;
    res.headers = { 'Content-Type': 'application/json' };
    res.payload = payload;
    res.body = JSON.stringify(payload);
    res.writeHead(statusCode, res.headers);
    res.end(res.body);
  });

  mockUtils.sendError.mockReset();
  mockUtils.sendError.mockImplementation((res, message, statusCode = 400) => {
    mockUtils.sendJson(res, { error: message }, statusCode);
  });

  mockUtils.parseBody.mockReset();
  mockUtils.parseBody.mockResolvedValue({});

  mockUtils.safeDecodeParam.mockReset();
  mockUtils.safeDecodeParam.mockImplementation((value, res) => {
    try {
      return decodeURIComponent(String(value));
    } catch {
      mockUtils.sendError(res, 'Invalid path parameter', 400);
      return null;
    }
  });
}

afterAll(() => {
  delete require.cache[require.resolve('fs')];
});

beforeEach(() => {
  vi.restoreAllMocks();
  resetDbDefaults();
  resetDependencyDefaults();
  resetUtilsDefaults();
});

describe('dashboard/routes/admin', () => {
  it('handles dashboard summary queries with explicit hours', () => {
    const res = createMockRes();
    mockDb.getCoordinationDashboard.mockReturnValue({ active_agents: 3 });

    admin.handleGetDashboard({}, res, { hours: '6' });

    expect(mockDb.getCoordinationDashboard).toHaveBeenCalledWith(6);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ active_agents: 3 });
  });

  it('lists agents', () => {
    const res = createMockRes();
    mockDb.listAgents.mockReturnValue([{ id: 'agent-1' }]);

    admin.handleListAgents({}, res);

    expect(mockDb.listAgents).toHaveBeenCalledOnce();
    expect(res.payload).toEqual({ agents: [{ id: 'agent-1' }] });
  });

  it('lists routing rules', () => {
    const res = createMockRes();
    mockDb.listRoutingRules.mockReturnValue([{ id: 'rule-1' }]);

    admin.handleListRoutingRules({}, res);

    expect(res.payload).toEqual({ rules: [{ id: 'rule-1' }] });
  });

  it('lists active claims only', () => {
    const res = createMockRes();
    mockDb.listClaims.mockReturnValue([{ id: 'claim-1' }]);

    admin.handleListClaims({}, res);

    expect(mockDb.listClaims).toHaveBeenCalledWith({ active_only: true });
    expect(res.payload).toEqual({ claims: [{ id: 'claim-1' }] });
  });

  it('lists pending approvals', () => {
    const res = createMockRes();
    mockDb.listPendingApprovals.mockReturnValue([{ id: 'approval-1' }]);

    admin.handleListPendingApprovals({}, res, {});

    expect(mockDb.listPendingApprovals).toHaveBeenCalledOnce();
    expect(res.payload).toEqual({ approvals: [{ id: 'approval-1' }] });
  });

  it('gets approval history with a default limit for invalid input', () => {
    const res = createMockRes();
    mockDb.getApprovalHistory.mockReturnValue([{ id: 'approval-9' }]);

    admin.handleGetApprovalHistory({}, res, { limit: 'oops' });

    expect(mockDb.getApprovalHistory).toHaveBeenCalledWith(50);
    expect(res.payload).toEqual({ history: [{ id: 'approval-9' }] });
  });

  it('approves an approval request', () => {
    const res = createMockRes();

    admin.handleApproveTask({}, res, {}, 'approval-1');

    expect(mockDb.decideApproval).toHaveBeenCalledWith('approval-1', 'approved', 'dashboard');
    expect(res.payload).toEqual({ status: 'approved', approval_id: 'approval-1' });
  });

  it('rejects an approval request', () => {
    const res = createMockRes();

    admin.handleRejectApproval({}, res, {}, 'approval-2');

    expect(mockDb.decideApproval).toHaveBeenCalledWith('approval-2', 'rejected', 'dashboard');
    expect(res.payload).toEqual({ status: 'rejected', approval_id: 'approval-2' });
  });

  it('lists schedules', () => {
    const res = createMockRes();
    mockDb.listScheduledTasks.mockReturnValue([{ id: 'schedule-1', enabled: true }]);

    admin.handleListSchedules({}, res);

    expect(mockDb.listScheduledTasks).toHaveBeenCalledOnce();
    expect(res.payload).toEqual({ schedules: [{ id: 'schedule-1', enabled: true }] });
  });

  it('creates schedules with optional settings normalized to null', async () => {
    const res = createMockRes();
    mockUtils.parseBody.mockResolvedValue({
      name: 'Nightly',
      cron_expression: '0 0 * * *',
      task_description: 'Run imports',
    });
    mockDb.createCronScheduledTask.mockReturnValue({ id: 'schedule-9' });

    await admin.handleCreateSchedule({}, res);

    expect(mockDb.createCronScheduledTask).toHaveBeenCalledWith(
      'Nightly',
      '0 0 * * *',
      'Run imports',
      {
        provider: null,
        model: null,
        working_directory: null,
      },
    );
    expect(res.statusCode).toBe(201);
    expect(res.payload).toEqual({ id: 'schedule-9' });
  });

  it('rejects schedule creation when required fields are missing', async () => {
    const res = createMockRes();
    mockUtils.parseBody.mockResolvedValue({ name: 'Only name' });

    await admin.handleCreateSchedule({}, res);

    expect(mockDb.createCronScheduledTask).not.toHaveBeenCalled();
    expect(mockUtils.sendError).toHaveBeenCalledWith(
      res,
      'name, cron_expression, and task_description are required',
      400,
    );
  });

  it('toggles schedules using explicit enabled values', async () => {
    const res = createMockRes();
    mockUtils.parseBody.mockResolvedValue({ enabled: false });
    mockDb.toggleScheduledTask.mockReturnValue({ id: 'schedule-7', enabled: false });

    await admin.handleToggleSchedule({}, res, {}, 'schedule-7');

    expect(mockDb.toggleScheduledTask).toHaveBeenCalledWith('schedule-7', false);
    expect(res.payload).toEqual({ id: 'schedule-7', enabled: false });
  });

  it('deletes schedules', () => {
    const res = createMockRes();

    admin.handleDeleteSchedule({}, res, {}, 'schedule-3');

    expect(mockDb.deleteScheduledTask).toHaveBeenCalledWith('schedule-3');
    expect(res.payload).toEqual({ deleted: true });
  });

  it('lists benchmarks and clamps invalid limits through parseLimit', () => {
    const res = createMockRes();
    mockDb.getBenchmarkResults.mockReturnValue([{ id: 'bench-1' }]);
    mockDb.getBenchmarkStats.mockReturnValue({ p95: 42 });

    admin.handleListBenchmarks({}, res, { hostId: 'host-1', limit: '5000' });

    expect(mockDb.getBenchmarkResults).toHaveBeenCalledWith('host-1', 1000);
    expect(mockDb.getBenchmarkStats).toHaveBeenCalledWith('host-1');
    expect(res.payload).toEqual({ results: [{ id: 'bench-1' }], stats: { p95: 42 } });
  });

  it('rejects benchmark listing when hostId is missing', () => {
    const res = createMockRes();

    admin.handleListBenchmarks({}, res, {});

    expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'hostId is required', 400);
    expect(mockDb.getBenchmarkResults).not.toHaveBeenCalled();
  });

  it('applies benchmark results', async () => {
    const res = createMockRes();
    mockUtils.parseBody.mockResolvedValue({ hostId: 'host-2', model: 'gpt-5' });
    mockDb.applyBenchmarkResults.mockReturnValue({ applied: true });

    await admin.handleApplyBenchmark({}, res);

    expect(mockDb.applyBenchmarkResults).toHaveBeenCalledWith('host-2', 'gpt-5');
    expect(res.payload).toEqual({ applied: true });
  });

  it('lists project tuning entries', () => {
    const res = createMockRes();
    mockDb.listProjectTuning.mockReturnValue([{ projectPath: '/repo', settings: { temperature: 0.1 } }]);

    admin.handleListProjectTuning({}, res);

    expect(res.payload).toEqual([{ projectPath: '/repo', settings: { temperature: 0.1 } }]);
  });

  it('creates a project tuning record', async () => {
    const res = createMockRes();
    mockUtils.parseBody.mockResolvedValue({
      projectPath: '/repo',
      settings: { temperature: 0.25 },
      description: 'Baseline',
    });

    await admin.handleCreateProjectTuning({}, res);

    expect(mockDb.setProjectTuning).toHaveBeenCalledWith('/repo', { temperature: 0.25 }, 'Baseline');
    expect(res.payload).toEqual({ success: true });
  });

  it('gets a decoded project tuning record', () => {
    const res = createMockRes();
    mockDb.getProjectTuning.mockReturnValue({ projectPath: '/tmp/proj one', settings: { top_p: 0.9 } });

    admin.handleGetProjectTuning({}, res, {}, '%2Ftmp%2Fproj%20one');

    expect(mockDb.getProjectTuning).toHaveBeenCalledWith('/tmp/proj one');
    expect(res.payload).toEqual({ projectPath: '/tmp/proj one', settings: { top_p: 0.9 } });
  });

  it('stops deleting project tuning when path decoding fails', () => {
    const res = createMockRes();
    mockUtils.safeDecodeParam.mockImplementation((value, response) => {
      mockUtils.sendError(response, 'bad encoding', 400);
      return null;
    });

    admin.handleDeleteProjectTuning({}, res, {}, '%bad');

    expect(mockDb.deleteProjectTuning).not.toHaveBeenCalled();
    expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'bad encoding', 400);
  });

  it('lists plan projects with computed progress values', () => {
    const res = createMockRes();
    mockDb.listPlanProjects.mockReturnValue([
      { id: 'project-1', total_tasks: 4, completed_tasks: 1 },
      { id: 'project-2', total_tasks: 0, completed_tasks: 0 },
    ]);

    admin.handleListPlanProjects({}, res, { status: 'active', limit: '5' });

    expect(mockDb.listPlanProjects).toHaveBeenCalledWith({ status: 'active', limit: 5 });
    expect(res.payload).toEqual({
      projects: [
        { id: 'project-1', total_tasks: 4, completed_tasks: 1, progress: 25 },
        { id: 'project-2', total_tasks: 0, completed_tasks: 0, progress: 0 },
      ],
    });
  });

  it('gets a plan project with progress and tasks', () => {
    const res = createMockRes();
    mockDb.getPlanProject.mockReturnValue({ id: 'project-3', total_tasks: 3, completed_tasks: 2 });
    mockDb.getPlanProjectTasks.mockReturnValue([{ task_id: 'task-1' }]);

    admin.handleGetPlanProject({}, res, {}, 'project-3');

    expect(mockDb.getPlanProject).toHaveBeenCalledWith('project-3');
    expect(mockDb.getPlanProjectTasks).toHaveBeenCalledWith('project-3');
    expect(res.payload).toEqual({
      id: 'project-3',
      total_tasks: 3,
      completed_tasks: 2,
      progress: 67,
      tasks: [{ task_id: 'task-1' }],
    });
  });

  it('imports a plan through the tools layer and cleans up the temp file', async () => {
    const res = createMockRes();
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    mockUtils.parseBody.mockResolvedValue({
      plan_content: '# Plan\n',
      project_name: 'alpha',
      dry_run: false,
      working_directory: 'C:\\repo',
    });
    mockTools.handleToolCall.mockResolvedValue({ ok: true, imported: 4 });

    await admin.handleImportPlanApi({}, res);

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(expect.stringMatching(/plan-1700000000000\.md$/), '# Plan\n');
    const tempFile = mockFs.writeFileSync.mock.calls[0][0];
    expect(mockTools.handleToolCall).toHaveBeenCalledWith('import_plan', {
      file_path: tempFile,
      project_name: 'alpha',
      dry_run: false,
      working_directory: 'C:\\repo',
    });
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(tempFile);
    expect(res.payload).toEqual({ ok: true, imported: 4 });
  });

  it.each([
    ['pause', 'pause_plan_project'],
    ['resume', 'resume_plan_project'],
    ['retry', 'retry_plan_project'],
  ])('runs the %s plan-project action', async (action, toolName) => {
    const res = createMockRes();
    mockTools.handleToolCall.mockResolvedValue({ action, ok: true });

    await admin.handlePlanProjectAction({}, res, {}, 'project-7', action);

    expect(mockDb.getPlanProject).toHaveBeenCalledWith('project-7');
    expect(mockTools.handleToolCall).toHaveBeenCalledWith(toolName, { project_id: 'project-7' });
    expect(res.payload).toEqual({ action, ok: true });
  });

  it('rejects unknown plan-project actions', async () => {
    const res = createMockRes();

    await admin.handlePlanProjectAction({}, res, {}, 'project-7', 'archive');

    expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Unknown action', 400);
    expect(mockTools.handleToolCall).not.toHaveBeenCalled();
  });

  it('deletes a plan project and falls back to updateTaskStatus when cancellation fails', () => {
    const res = createMockRes();
    mockDb.getPlanProjectTasks.mockReturnValue([
      { task_id: 'task-1', status: 'queued' },
      { task_id: 'task-2', status: 'running' },
      { task_id: 'task-3', status: 'waiting' },
      { task_id: 'task-4', status: 'completed' },
    ]);
    mockTaskManager.cancelTask.mockImplementation((taskId) => {
      if (taskId === 'task-2') {
        throw new Error('cancel failed');
      }
    });

    admin.handleDeletePlanProject({}, res, {}, 'project-9');

    expect(mockTaskManager.cancelTask).toHaveBeenCalledTimes(3);
    expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-2', 'cancelled', {
      error_output: 'Plan project deleted',
    });
    expect(mockDb.deletePlanProject).toHaveBeenCalledWith('project-9');
    expect(res.payload).toEqual({ success: true, message: 'Project deleted' });
  });
});
