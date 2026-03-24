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
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
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

// Cache-inject mocks before requiring the module under test
function installMock(modPath, mockObj) {
  const resolved = require.resolve(modPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: mockObj,
  };
}

installMock('../database', mockDb);
installMock('../db/coordination', mockDb);
installMock('../db/scheduling-automation', mockDb);
installMock('../db/validation-rules', mockDb);
installMock('../db/host-management', mockDb);
installMock('../db/project-config-core', mockDb);
installMock('../db/task-core', mockDb);
installMock('../dashboard/utils', mockUtils);
installMock('../tools', mockTools);
installMock('fs', mockFs);
installMock('../logger', mockLogger);
installMock('../task-manager', mockTaskManager);

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

function resetDbMocks() {
  mockDb.getCoordinationDashboard.mockReturnValue({});
  mockDb.listAgents.mockReturnValue([]);
  mockDb.listRoutingRules.mockReturnValue([]);
  mockDb.listClaims.mockReturnValue([]);
  mockDb.listPendingApprovals.mockReturnValue([]);
  mockDb.getApprovalHistory.mockReturnValue([]);
  mockDb.decideApproval.mockReturnValue(null);
  mockDb.listScheduledTasks.mockReturnValue([]);
  mockDb.createCronScheduledTask.mockReturnValue({ id: 'schedule-1' });
  mockDb.toggleScheduledTask.mockReturnValue({ id: 'schedule-1', enabled: true });
  mockDb.deleteScheduledTask.mockReturnValue(true);
  mockDb.getBenchmarkResults.mockReturnValue([]);
  mockDb.getBenchmarkStats.mockReturnValue({});
  mockDb.applyBenchmarkResults.mockReturnValue({ ok: true });
  mockDb.listProjectTuning.mockReturnValue([]);
  mockDb.setProjectTuning.mockReturnValue(true);
  mockDb.getProjectTuning.mockReturnValue({ projectPath: '/tmp/project', settings: {} });
  mockDb.deleteProjectTuning.mockReturnValue(true);
  mockDb.listPlanProjects.mockReturnValue([]);
  mockDb.getPlanProject.mockReturnValue({ id: 'p1', total_tasks: 1, completed_tasks: 0 });
  mockDb.getPlanProjectTasks.mockReturnValue([]);
  mockDb.deletePlanProject.mockReturnValue(true);
  mockDb.updateTaskStatus.mockReturnValue(undefined);
}

function resetUtilsDefaults() {
  mockUtils.sendJson.mockImplementation((res, payload, statusCode = 200) => {
    res.statusCode = statusCode;
    res.payload = payload;
    res.body = JSON.stringify(payload);
    res.headers = { 'Content-Type': 'application/json' };
    if (typeof res.writeHead === 'function') {
      res.writeHead(statusCode, res.headers);
    }
    if (typeof res.end === 'function') {
      res.end(res.body);
    }
  });

  mockUtils.sendError.mockImplementation((res, message, statusCode = 400) => {
    mockUtils.sendJson(res, { error: message }, statusCode);
  });

  mockUtils.parseBody.mockResolvedValue({});

  mockUtils.safeDecodeParam.mockImplementation((value, res) => {
    try {
      return decodeURIComponent(String(value));
    } catch {
      mockUtils.sendError(res, 'Invalid path parameter', 400);
      return null;
    }
  });
}

function resetToolMocks() {
  mockTools.handleToolCall.mockResolvedValue({ ok: true });
}

function resetTaskManagerMocks() {
  mockTaskManager.cancelTask.mockReturnValue(undefined);
}

function resetFsMocks() {
  mockFs.writeFileSync.mockReset();
  mockFs.unlinkSync.mockReset();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMocks();
  resetUtilsDefaults();
  resetToolMocks();
  resetTaskManagerMocks();
  resetFsMocks();
});

describe('dashboard/admin handlers', () => {
  describe('handleGetDashboard', () => {
    it('returns coordination dashboard payload for valid hours', () => {
      const res = createMockRes();
      mockDb.getCoordinationDashboard.mockReturnValue({ ok: true, tasks: 2 });

      admin.handleGetDashboard({}, res, { hours: '6' });

      expect(mockDb.getCoordinationDashboard).toHaveBeenCalledWith(6);
      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({ ok: true, tasks: 2 });
    });

    it('defaults to 24 hours for invalid input', () => {
      const res = createMockRes();
      admin.handleGetDashboard({}, res, { hours: 'not-a-number' });

      expect(mockDb.getCoordinationDashboard).toHaveBeenCalledWith(24);
      expect(res.payload).toEqual({});
    });
  });

  describe('handleListAgents', () => {
    it('returns agent list', () => {
      const res = createMockRes();
      mockDb.listAgents.mockReturnValue([{ id: 'agent-1' }]);

      admin.handleListAgents({}, res);

      expect(mockDb.listAgents).toHaveBeenCalledTimes(1);
      expect(res.payload).toEqual({ agents: [{ id: 'agent-1' }] });
    });

    it('propagates DB errors', () => {
      const res = createMockRes();
      mockDb.listAgents.mockImplementation(() => {
        throw new Error('agent query failed');
      });

      expect(() => admin.handleListAgents({}, res)).toThrow('agent query failed');
    });
  });

  describe('handleListRoutingRules', () => {
    it('returns routing rules', () => {
      const res = createMockRes();
      mockDb.listRoutingRules.mockReturnValue([{ id: 'rule-1' }]);

      admin.handleListRoutingRules({}, res);

      expect(res.payload).toEqual({ rules: [{ id: 'rule-1' }] });
    });

    it('propagates DB errors', () => {
      const res = createMockRes();
      mockDb.listRoutingRules.mockImplementation(() => {
        throw new Error('routing store offline');
      });

      expect(() => admin.handleListRoutingRules({}, res)).toThrow('routing store offline');
    });
  });

  describe('handleListClaims', () => {
    it('returns active claims', () => {
      const res = createMockRes();
      mockDb.listClaims.mockReturnValue([{ id: 'claim-1' }]);

      admin.handleListClaims({}, res);

      expect(res.payload).toEqual({ claims: [{ id: 'claim-1' }] });
    });

    it('propagates DB errors', () => {
      const res = createMockRes();
      mockDb.listClaims.mockImplementation(() => {
        throw new Error('claim query failed');
      });

      expect(() => admin.handleListClaims({}, res)).toThrow('claim query failed');
    });
  });

  describe('handleListPendingApprovals', () => {
    it('returns pending approvals', () => {
      const res = createMockRes();
      mockDb.listPendingApprovals.mockReturnValue([{ id: 'approval-1', status: 'pending' }]);

      admin.handleListPendingApprovals({}, res, {});

      expect(mockDb.listPendingApprovals).toHaveBeenCalledTimes(1);
      expect(res.payload).toEqual({ approvals: [{ id: 'approval-1', status: 'pending' }] });
    });

    it('propagates DB errors', () => {
      const res = createMockRes();
      mockDb.listPendingApprovals.mockImplementation(() => {
        throw new Error('approval query failed');
      });

      expect(() => admin.handleListPendingApprovals({}, res, {})).toThrow('approval query failed');
    });
  });

  describe('handleGetApprovalHistory', () => {
    it('returns approval history with explicit numeric limit', () => {
      const res = createMockRes();
      mockDb.getApprovalHistory.mockReturnValue([{ id: 'a-1' }, { id: 'a-2' }]);

      admin.handleGetApprovalHistory({}, res, { limit: '5' });

      expect(mockDb.getApprovalHistory).toHaveBeenCalledWith(5);
      expect(res.payload).toEqual({ history: [{ id: 'a-1' }, { id: 'a-2' }] });
    });

    it('defaults limit when not provided or invalid', () => {
      const res = createMockRes();
      admin.handleGetApprovalHistory({}, res, { limit: 'bad' });

      expect(mockDb.getApprovalHistory).toHaveBeenCalledWith(50);
      expect(res.payload).toEqual({ history: [] });
    });

    it('propagates DB errors', () => {
      const res = createMockRes();
      mockDb.getApprovalHistory.mockImplementation(() => {
        throw new Error('history query failed');
      });

      expect(() => admin.handleGetApprovalHistory({}, res, { limit: '10' })).toThrow('history query failed');
    });
  });

  describe('handleApproveTask', () => {
    it('approves and returns approval payload', () => {
      const res = createMockRes();
      mockDb.decideApproval.mockReturnValue({ id: 'approval-1' });

      admin.handleApproveTask({}, res, {}, 'approval-1');

      expect(mockDb.decideApproval).toHaveBeenCalledWith('approval-1', 'approved', 'dashboard');
      expect(res.payload).toEqual({ status: 'approved', approval_id: 'approval-1' });
      expect(res.statusCode).toBe(200);
    });

    it('returns 400 when approval id is missing', () => {
      const res = createMockRes();

      admin.handleApproveTask({}, res, {});

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'approval_id required', 400);
      expect(mockDb.decideApproval).not.toHaveBeenCalled();
    });

    it('returns 404 when approval is not found', () => {
      const res = createMockRes();
      mockDb.decideApproval.mockReturnValue(null);

      admin.handleApproveTask({}, res, {}, 'approval-2');

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Approval not found', 404);
      expect(mockDb.decideApproval).toHaveBeenCalledWith('approval-2', 'approved', 'dashboard');
    });
  });

  describe('handleRejectApproval', () => {
    it('rejects and returns approval payload', () => {
      const res = createMockRes();
      mockDb.decideApproval.mockReturnValue({ id: 'approval-1' });

      admin.handleRejectApproval({}, res, {}, 'approval-1');

      expect(mockDb.decideApproval).toHaveBeenCalledWith('approval-1', 'rejected', 'dashboard');
      expect(res.payload).toEqual({ status: 'rejected', approval_id: 'approval-1' });
    });

    it('returns 400 when approval id is missing', () => {
      const res = createMockRes();

      admin.handleRejectApproval({}, res, {});

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'approval_id required', 400);
      expect(mockDb.decideApproval).not.toHaveBeenCalled();
    });

    it('returns 404 when approval is not found', () => {
      const res = createMockRes();
      mockDb.decideApproval.mockReturnValue(null);

      admin.handleRejectApproval({}, res, {}, 'approval-2');

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Approval not found', 404);
      expect(mockDb.decideApproval).toHaveBeenCalledWith('approval-2', 'rejected', 'dashboard');
    });
  });

  describe('handleListSchedules', () => {
    it('returns scheduled tasks', () => {
      const res = createMockRes();
      mockDb.listScheduledTasks.mockReturnValue([{ id: 's-1', enabled: true }]);

      admin.handleListSchedules({}, res);

      expect(res.payload).toEqual({ schedules: [{ id: 's-1', enabled: true }] });
    });

    it('propagates DB errors', () => {
      const res = createMockRes();
      mockDb.listScheduledTasks.mockImplementation(() => {
        throw new Error('schedule list failed');
      });

      expect(() => admin.handleListSchedules({}, res)).toThrow('schedule list failed');
    });
  });

  describe('handleCreateSchedule', () => {
    it('creates a schedule with full body', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({
        name: 'nightly-sync',
        cron_expression: '0 0 * * *',
        task_description: 'Run sync',
        provider: 'ollama',
        model: 'llama',
        working_directory: '/tmp',
      });
      mockDb.createCronScheduledTask.mockReturnValue({ id: 'schedule-1' });

      await admin.handleCreateSchedule({}, res);

      expect(mockDb.createCronScheduledTask).toHaveBeenCalledWith(
        'nightly-sync',
        '0 0 * * *',
        'Run sync',
        {
          provider: 'ollama',
          model: 'llama',
          working_directory: '/tmp',
        },
      );
      expect(res.statusCode).toBe(201);
      expect(res.payload).toEqual({ id: 'schedule-1' });
    });

    it('defaults optional schedule fields to null', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({
        name: 'nightly-sync',
        cron_expression: '0 0 * * *',
        task_description: 'Run sync',
      });
      mockDb.createCronScheduledTask.mockReturnValue({ id: 'schedule-2' });

      await admin.handleCreateSchedule({}, res);

      expect(mockDb.createCronScheduledTask).toHaveBeenCalledWith('nightly-sync', '0 0 * * *', 'Run sync', {
        provider: null,
        model: null,
        working_directory: null,
      });
      expect(res.statusCode).toBe(201);
    });

    it('returns validation error for missing required fields', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({ name: 'bad' });

      await admin.handleCreateSchedule({}, res);

      expect(mockUtils.sendError).toHaveBeenCalledWith(
        res,
        'name, cron_expression, and task_description are required',
        400,
      );
      expect(mockDb.createCronScheduledTask).not.toHaveBeenCalled();
    });

    it('propagates parseBody errors', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockRejectedValue(new Error('bad body'));

      await expect(admin.handleCreateSchedule({}, res)).rejects.toThrow('bad body');
      expect(mockDb.createCronScheduledTask).not.toHaveBeenCalled();
    });
  });

  describe('handleToggleSchedule', () => {
    it('defaults enabled to true when body omits it', async () => {
      const res = createMockRes();
      mockDb.toggleScheduledTask.mockReturnValue({ id: 'schedule-1', enabled: true });
      mockUtils.parseBody.mockResolvedValue({});

      await admin.handleToggleSchedule({}, res, {}, 'schedule-1');

      expect(mockDb.toggleScheduledTask).toHaveBeenCalledWith('schedule-1', true);
      expect(res.payload).toEqual({ id: 'schedule-1', enabled: true });
    });

    it('uses explicit enabled value when provided', async () => {
      const res = createMockRes();
      mockDb.toggleScheduledTask.mockReturnValue({ id: 'schedule-1', enabled: false });
      mockUtils.parseBody.mockResolvedValue({ enabled: false });

      await admin.handleToggleSchedule({}, res, {}, 'schedule-1');

      expect(mockDb.toggleScheduledTask).toHaveBeenCalledWith('schedule-1', false);
      expect(res.payload).toEqual({ id: 'schedule-1', enabled: false });
    });

    it('returns 404 when schedule is missing', async () => {
      const res = createMockRes();
      mockDb.toggleScheduledTask.mockReturnValue(null);

      await admin.handleToggleSchedule({}, res, {}, 'missing');

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Schedule not found', 404);
      expect(res.payload).toEqual({ error: 'Schedule not found' });
    });

    it('propagates parseBody errors', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockRejectedValue(new Error('body parse failed'));

      await expect(admin.handleToggleSchedule({}, res, {}, 'schedule-1')).rejects.toThrow('body parse failed');
    });
  });

  describe('handleDeleteSchedule', () => {
    it('deletes and returns confirmation', () => {
      const res = createMockRes();
      mockDb.deleteScheduledTask.mockReturnValue({ id: 'schedule-1' });

      admin.handleDeleteSchedule({}, res, {}, 'schedule-1');

      expect(mockDb.deleteScheduledTask).toHaveBeenCalledWith('schedule-1');
      expect(res.payload).toEqual({ deleted: true });
      expect(res.statusCode).toBe(200);
    });

    it('returns 404 when schedule is missing', () => {
      const res = createMockRes();
      mockDb.deleteScheduledTask.mockReturnValue(null);

      admin.handleDeleteSchedule({}, res, {}, 'missing');

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Schedule not found', 404);
    });
  });

  describe('handleListBenchmarks', () => {
    it('requires hostId', () => {
      const res = createMockRes();

      admin.handleListBenchmarks({}, res, {});

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'hostId is required', 400);
      expect(mockDb.getBenchmarkResults).not.toHaveBeenCalled();
    });

    it('defaults limit to 10 for non-numeric input', () => {
      const res = createMockRes();
      mockDb.getBenchmarkResults.mockReturnValue(['r1']);

      admin.handleListBenchmarks({}, res, { hostId: 'host-1', limit: 'abc' });

      expect(mockDb.getBenchmarkResults).toHaveBeenCalledWith('host-1', 10);
      expect(mockDb.getBenchmarkStats).toHaveBeenCalledWith('host-1');
      expect(res.payload).toEqual({ results: ['r1'], stats: {} });
    });

    it('clamps low limits to one and high limits to one thousand', () => {
      const res = createMockRes();
      admin.handleListBenchmarks({}, res, { hostId: 'host-1', limit: '-9' });
      expect(mockDb.getBenchmarkResults).toHaveBeenCalledWith('host-1', 1);

      const res2 = createMockRes();
      admin.handleListBenchmarks({}, res2, { hostId: 'host-1', limit: '5000' });
      expect(mockDb.getBenchmarkResults).toHaveBeenCalledWith('host-1', 1000);
    });

    it('uses integer truncation for decimals', () => {
      const res = createMockRes();
      admin.handleListBenchmarks({}, res, { hostId: 'host-1', limit: '14.9' });
      expect(mockDb.getBenchmarkResults).toHaveBeenCalledWith('host-1', 14);
    });
  });

  describe('handleApplyBenchmark', () => {
    it('applies benchmark results with required hostId', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({ hostId: 'host-1', model: 'gpt-4' });

      await admin.handleApplyBenchmark({}, res);

      expect(mockDb.applyBenchmarkResults).toHaveBeenCalledWith('host-1', 'gpt-4');
      expect(res.payload).toEqual({ ok: true });
    });

    it('requires hostId', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({ model: 'gpt-4' });

      await admin.handleApplyBenchmark({}, res);

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'hostId is required', 400);
      expect(mockDb.applyBenchmarkResults).not.toHaveBeenCalled();
    });

    it('propagates parseBody errors', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockRejectedValue(new Error('invalid json'));

      await expect(admin.handleApplyBenchmark({}, res)).rejects.toThrow('invalid json');
    });
  });
  describe('handleListProjectTuning', () => {
    it('returns list of tuning profiles', () => {
      const res = createMockRes();
      mockDb.listProjectTuning.mockReturnValue([{ projectPath: '/tmp', settings: { max_tokens: 128 } }]);

      admin.handleListProjectTuning({}, res);

      expect(res.payload).toEqual([{ projectPath: '/tmp', settings: { max_tokens: 128 } }]);
    });

    it('propagates DB errors', () => {
      const res = createMockRes();
      mockDb.listProjectTuning.mockImplementation(() => {
        throw new Error('tuning list failed');
      });

      expect(() => admin.handleListProjectTuning({}, res)).toThrow('tuning list failed');
    });
  });

  describe('handleCreateProjectTuning', () => {
    it('creates tuning profile with optional description', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({
        projectPath: '/tmp/project',
        settings: { max_tokens: 64 },
        description: 'initial',
      });

      await admin.handleCreateProjectTuning({}, res);

      expect(mockDb.setProjectTuning).toHaveBeenCalledWith('/tmp/project', { max_tokens: 64 }, 'initial');
      expect(res.payload).toEqual({ success: true });
    });

    it('requires projectPath', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({ settings: {} });

      await admin.handleCreateProjectTuning({}, res);

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'projectPath is required', 400);
      expect(mockDb.setProjectTuning).not.toHaveBeenCalled();
    });

    it('requires settings', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({ projectPath: '/tmp/project' });

      await admin.handleCreateProjectTuning({}, res);

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'settings is required', 400);
      expect(mockDb.setProjectTuning).not.toHaveBeenCalled();
    });

    it('propagates parseBody errors', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockRejectedValue(new Error('invalid body'));

      await expect(admin.handleCreateProjectTuning({}, res)).rejects.toThrow('invalid body');
    });
  });

  describe('handleGetProjectTuning', () => {
    it('returns decoded tuning entry', () => {
      const res = createMockRes();
      mockDb.getProjectTuning.mockReturnValue({ projectPath: '/tmp/proj', settings: { temperature: 0.2 } });

      admin.handleGetProjectTuning({}, res, {}, '/tmp%2Fproj');

      expect(mockDb.getProjectTuning).toHaveBeenCalledWith('/tmp/proj');
      expect(res.payload).toEqual({ projectPath: '/tmp/proj', settings: { temperature: 0.2 } });
    });

    it('returns not found for missing tuning', () => {
      const res = createMockRes();
      mockDb.getProjectTuning.mockReturnValue(null);

      admin.handleGetProjectTuning({}, res, {}, '/tmp%2Fmissing');

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Project tuning not found', 404);
      expect(res.payload).toEqual({ error: 'Project tuning not found' });
    });

    it('does not continue when safe decode fails', () => {
      const res = createMockRes();
      mockUtils.safeDecodeParam.mockImplementation((path, response) => {
        mockUtils.sendError(response, 'bad encoding', 400);
        return null;
      });

      admin.handleGetProjectTuning({}, res, {}, '%');

      expect(mockDb.getProjectTuning).not.toHaveBeenCalled();
      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'bad encoding', 400);
    });
  });

  describe('handleDeleteProjectTuning', () => {
    it('deletes existing tuning entry', () => {
      const res = createMockRes();

      admin.handleDeleteProjectTuning({}, res, {}, '/tmp%2Fproj');

      expect(mockDb.deleteProjectTuning).toHaveBeenCalledWith('/tmp/proj');
      expect(res.payload).toEqual({ success: true });
    });

    it('does not call db when path decode fails', () => {
      const res = createMockRes();
      mockUtils.safeDecodeParam.mockReturnValue(null);

      admin.handleDeleteProjectTuning({}, res, {}, '%');

      expect(mockDb.deleteProjectTuning).not.toHaveBeenCalled();
    });
  });

  describe('handleListPlanProjects', () => {
    it('returns projects with computed progress', () => {
      const res = createMockRes();
      mockDb.listPlanProjects.mockReturnValue([
        { id: 'p1', total_tasks: 10, completed_tasks: 3 },
        { id: 'p2', total_tasks: 0, completed_tasks: 0 },
      ]);

      admin.handleListPlanProjects({}, res, { status: 'active', limit: '5' });

      expect(mockDb.listPlanProjects).toHaveBeenCalledWith({ status: 'active', limit: 5 });
      expect(res.payload).toEqual({
        projects: [
          { id: 'p1', total_tasks: 10, completed_tasks: 3, progress: 30 },
          { id: 'p2', total_tasks: 0, completed_tasks: 0, progress: 0 },
        ],
      });
    });

    it('defaults invalid limit to 20', () => {
      const res = createMockRes();
      admin.handleListPlanProjects({}, res, { status: 'active', limit: 'nonsense' });

      expect(mockDb.listPlanProjects).toHaveBeenCalledWith({ status: 'active', limit: 20 });
      expect(res.payload.projects).toEqual([]);
    });

    it('propagates DB errors', () => {
      const res = createMockRes();
      mockDb.listPlanProjects.mockImplementation(() => {
        throw new Error('plan list failed');
      });

      expect(() => admin.handleListPlanProjects({}, res, { status: 'active', limit: '10' })).toThrow(
        'plan list failed',
      );
    });
  });

  describe('handleGetPlanProject', () => {
    it('returns project with tasks and computed progress', () => {
      const res = createMockRes();
      mockDb.getPlanProject.mockReturnValue({ id: 'p1', total_tasks: 4, completed_tasks: 1 });
      mockDb.getPlanProjectTasks.mockReturnValue([{ id: 't1' }, { id: 't2' }]);

      admin.handleGetPlanProject({}, res, {}, 'p1');

      expect(mockDb.getPlanProject).toHaveBeenCalledWith('p1');
      expect(mockDb.getPlanProjectTasks).toHaveBeenCalledWith('p1');
      expect(res.payload).toEqual({
        id: 'p1',
        total_tasks: 4,
        completed_tasks: 1,
        progress: 25,
        tasks: [{ id: 't1' }, { id: 't2' }],
      });
    });

    it('returns 404 when project does not exist', () => {
      const res = createMockRes();
      mockDb.getPlanProject.mockReturnValue(null);

      admin.handleGetPlanProject({}, res, {}, 'missing');

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Project not found', 404);
      expect(mockDb.getPlanProjectTasks).not.toHaveBeenCalled();
    });

    it('propagates DB errors', () => {
      const res = createMockRes();
      mockDb.getPlanProject.mockImplementation(() => {
        throw new Error('plan fetch failed');
      });

      expect(() => admin.handleGetPlanProject({}, res, {}, 'p1')).toThrow('plan fetch failed');
    });
  });

  describe('handleImportPlanApi', () => {
    it('returns validation error without plan_content', async () => {
      const res = createMockRes();

      await admin.handleImportPlanApi({}, res);

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'plan_content is required');
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('imports plan and cleans up temp file on success', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({
        plan_content: '# example plan\n',
        project_name: 'project-alpha',
        dry_run: false,
        working_directory: '/tmp',
      });
      mockTools.handleToolCall.mockResolvedValue({ ok: true, project_id: 'p1' });

      await admin.handleImportPlanApi({}, res);

      const [tempPath, fileContent] = mockFs.writeFileSync.mock.calls[0];
      expect(tempPath).toMatch(/plan-\d+\.md$/);
      expect(fileContent).toBe('# example plan\n');
      expect(mockTools.handleToolCall).toHaveBeenCalledWith('import_plan', {
        file_path: tempPath,
        project_name: 'project-alpha',
        dry_run: false,
        working_directory: '/tmp',
      });
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(tempPath);
      expect(res.payload).toEqual({ ok: true, project_id: 'p1' });
    });

    it('logs cleanup failure and still succeeds when unlink fails', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({ plan_content: '# plan' });
      mockTools.handleToolCall.mockResolvedValue({ ok: true });
      mockFs.unlinkSync.mockImplementation(() => {
        throw new Error('delete blocked');
      });

      await admin.handleImportPlanApi({}, res);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Failed to delete temp plan import file'));
      expect(res.payload).toEqual({ ok: true });
    });

    it('returns tool error response as 400', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({ plan_content: '# plan' });
      mockTools.handleToolCall.mockResolvedValue({ error: 'invalid plan syntax' });

      await admin.handleImportPlanApi({}, res);

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'invalid plan syntax', 400);
    });

    it('returns invalid tool payload as 500', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({ plan_content: '# plan' });
      mockTools.handleToolCall.mockResolvedValue('bad-response');

      await admin.handleImportPlanApi({}, res);

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Invalid import tool response', 500);
    });

    it('returns 500 when tool call throws and logs debug', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockResolvedValue({ plan_content: '# plan' });
      mockTools.handleToolCall.mockRejectedValue(new Error('tool crashed'));

      await admin.handleImportPlanApi({}, res);

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'tool crashed', 500);
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('import_plan tool call failed'));
    });

    it('returns 500 for body parse failures', async () => {
      const res = createMockRes();
      mockUtils.parseBody.mockRejectedValue(new Error('bad body'));

      await admin.handleImportPlanApi({}, res);

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'bad body', 500);
    });
  });

  describe('handlePlanProjectAction', () => {
    it.each([
      ['pause', 'pause_plan_project'],
      ['resume', 'resume_plan_project'],
      ['retry', 'retry_plan_project'],
    ])('performs %s action', async (action, tool) => {
      const res = createMockRes();
      mockDb.getPlanProject.mockReturnValue({ id: 'p1', total_tasks: 1, completed_tasks: 1 });
      mockTools.handleToolCall.mockResolvedValue({ ok: true, action });

      await admin.handlePlanProjectAction({}, res, {}, 'p1', action);

      expect(mockDb.getPlanProject).toHaveBeenCalledWith('p1');
      expect(mockTools.handleToolCall).toHaveBeenCalledWith(tool, { project_id: 'p1' });
      expect(res.payload).toEqual({ ok: true, action });
    });

    it('returns 404 when project does not exist', async () => {
      const res = createMockRes();
      mockDb.getPlanProject.mockReturnValue(null);

      await admin.handlePlanProjectAction({}, res, {}, 'missing', 'pause');

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Project not found', 404);
      expect(mockTools.handleToolCall).not.toHaveBeenCalled();
    });

    it('returns 400 for unknown action', async () => {
      const res = createMockRes();
      mockDb.getPlanProject.mockReturnValue({ id: 'p1', total_tasks: 1, completed_tasks: 1 });

      await admin.handlePlanProjectAction({}, res, {}, 'p1', 'archive');

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Unknown action', 400);
      expect(mockTools.handleToolCall).not.toHaveBeenCalled();
    });
  });

  describe('handleDeletePlanProject', () => {
    it('cancels cancellable tasks before deleting project', () => {
      const res = createMockRes();
      mockDb.getPlanProject.mockReturnValue({ id: 'p1', total_tasks: 2, completed_tasks: 1 });
      mockDb.getPlanProjectTasks.mockReturnValue([
        { task_id: 'task-queued', status: 'queued' },
        { task_id: 'task-running', status: 'running' },
        { task_id: 'task-waiting', status: 'waiting' },
        { task_id: 'task-done', status: 'completed' },
      ]);

      admin.handleDeletePlanProject({}, res, {}, 'p1');

      expect(mockTaskManager.cancelTask).toHaveBeenCalledTimes(3);
      expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('task-queued', 'Plan project deleted');
      expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('task-running', 'Plan project deleted');
      expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('task-waiting', 'Plan project deleted');
      expect(mockDb.deletePlanProject).toHaveBeenCalledWith('p1');
      expect(res.payload).toEqual({ success: true, message: 'Project deleted' });
    });

    it('falls back to task status update when cancelTask fails', () => {
      const res = createMockRes();
      mockDb.getPlanProject.mockReturnValue({ id: 'p1', total_tasks: 1, completed_tasks: 0 });
      mockDb.getPlanProjectTasks.mockReturnValue([
        { task_id: 'task-1', status: 'queued' },
        { task_id: 'task-2', status: 'running' },
      ]);
      mockTaskManager.cancelTask.mockImplementation((taskId) => {
        if (taskId === 'task-2') {
          throw new Error('cancel failed');
        }
      });

      admin.handleDeletePlanProject({}, res, {}, 'p1');

      expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('task-1', 'Plan project deleted');
      expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('task-2', 'Plan project deleted');
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-2', 'cancelled', {
        error_output: 'Plan project deleted',
      });
      expect(mockDb.deletePlanProject).toHaveBeenCalledWith('p1');
      expect(res.payload).toEqual({ success: true, message: 'Project deleted' });
    });

    it('returns 404 when project not found', () => {
      const res = createMockRes();
      mockDb.getPlanProject.mockReturnValue(null);

      admin.handleDeletePlanProject({}, res, {}, 'missing');

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Project not found', 404);
      expect(mockDb.deletePlanProject).not.toHaveBeenCalled();
    });
  });
});
