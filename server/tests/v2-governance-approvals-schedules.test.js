'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HANDLER_MODULE = '../api/v2-governance-handlers';
const MODULE_PATHS = [
  HANDLER_MODULE,
  '../api/v2-control-plane',
  '../api/middleware',
  '../database',
  '../db/scheduling-automation',
  '../db/validation-rules',
];

const FIXED_TIMESTAMP = '2026-03-10T12:34:56.789Z';

const mockDb = {
  listPendingApprovals: vi.fn(),
  listApprovalHistory: vi.fn(),
  getApprovalHistory: vi.fn(),
  getApprovalRequestById: vi.fn(),
  approveTask: vi.fn(),
  rejectApproval: vi.fn(),
  decideApproval: vi.fn(),
  getScheduledTask: vi.fn(),
  getScheduledTaskRun: vi.fn(),
  listScheduledTasks: vi.fn(),
  createCronScheduledTask: vi.fn(),
  runScheduledTaskNow: vi.fn(),
  toggleScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
};

const mockSendJson = vi.fn((res, data, status = 200, req = null) => {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (req?.requestId) {
    headers['X-Request-ID'] = req.requestId;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
});

const mockParseBody = vi.fn(async (req) => req?._parsedBody ?? req?.body ?? {});

const mockMiddleware = {
  parseBody: mockParseBody,
  sendJson: mockSendJson,
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

function clearLoadedModules() {
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that were not loaded.
    }
  }
}

function loadHandlers() {
  clearLoadedModules();
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../db/scheduling-automation', mockDb);
  installCjsModuleMock('../db/validation-rules', mockDb);
  installCjsModuleMock('../api/middleware', mockMiddleware);
  return require(HANDLER_MODULE);
}

function initHandlersWithDeps(handlers, taskManager = null) {
  handlers.init?.({ db: mockDb, taskManager });
  if (taskManager) {
    handlers.init?.(taskManager);
  }
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

function expectMeta(requestId) {
  return {
    request_id: requestId,
    timestamp: FIXED_TIMESTAMP,
  };
}

function expectSuccessEnvelope(res, data, options = {}) {
  const { requestId = 'req-123', status = 200 } = options;
  expect(res.statusCode).toBe(status);
  expect(res._body).toEqual({
    data,
    meta: expectMeta(requestId),
  });
}

function expectListEnvelope(res, items, total, options = {}) {
  const { requestId = 'req-123' } = options;
  expect(res.statusCode).toBe(200);
  expect(res._body).toEqual({
    data: {
      items,
      total,
    },
    meta: expectMeta(requestId),
  });
}

function expectErrorEnvelope(res, error, options = {}) {
  const {
    requestId = 'req-123',
    status = 400,
    details = {},
  } = options;
  expect(res.statusCode).toBe(status);
  expect(res._body).toEqual({
    error: {
      ...error,
      details,
      request_id: requestId,
    },
    meta: expectMeta(requestId),
  });
}

function resetMockDefaults() {
  mockDb.listPendingApprovals = vi.fn().mockReturnValue([]);
  mockDb.listApprovalHistory = vi.fn().mockReturnValue([]);
  mockDb.getApprovalHistory = vi.fn().mockReturnValue([]);
  mockDb.getApprovalRequestById = vi.fn().mockReturnValue(null);
  mockDb.approveTask = vi.fn().mockReturnValue(true);
  mockDb.rejectApproval = vi.fn().mockReturnValue(true);
  mockDb.decideApproval = vi.fn().mockReturnValue(true);
  mockDb.getScheduledTask = vi.fn().mockReturnValue(null);
  mockDb.getScheduledTaskRun = vi.fn().mockReturnValue(null);
  mockDb.listScheduledTasks = vi.fn().mockReturnValue([]);
  mockDb.createCronScheduledTask = vi.fn().mockImplementation(({ name, cron_expression, task_config, timezone }) => ({
    id: 'schedule-1',
    name,
    cron_expression,
    task_description: task_config?.task,
    ...task_config,
    timezone,
  }));
  mockDb.runScheduledTaskNow = vi.fn().mockImplementation((scheduleId) => ({
    started: true,
    execution_type: 'task',
    task_id: 'task-1',
    schedule_id: scheduleId,
    schedule_name: 'Nightly',
    schedule_consumed: false,
  }));
  mockDb.toggleScheduledTask = vi.fn().mockImplementation((id, enabled) => ({
    id,
    enabled,
  }));
  mockDb.deleteScheduledTask = vi.fn().mockReturnValue(true);
  mockDb.updateScheduledTask = vi.fn().mockImplementation((id, updates) => ({
    id,
    ...updates,
  }));

  mockParseBody.mockReset();
  mockParseBody.mockImplementation(async (req) => req?._parsedBody ?? req?.body ?? {});
  mockSendJson.mockClear();
}

describe('api/v2-governance-handlers approvals and schedules', () => {
  let handlers;
  let tempDirs = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TIMESTAMP));
    resetMockDefaults();
    handlers = loadHandlers();
    initHandlersWithDeps(handlers);
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
    vi.useRealTimers();
    clearLoadedModules();
  });

  function createStudyWorkingDirectory(state = {}, artifacts = {}) {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-study-schedule-'));
    tempDirs.push(workingDirectory);
    const architectureDir = path.join(workingDirectory, 'docs', 'architecture');
    fs.mkdirSync(architectureDir, { recursive: true });
    fs.writeFileSync(path.join(architectureDir, 'study-state.json'), JSON.stringify(state, null, 2));
    if (artifacts.delta) {
      fs.writeFileSync(path.join(architectureDir, 'study-delta.json'), JSON.stringify(artifacts.delta, null, 2));
    }
    if (artifacts.evaluation) {
      fs.writeFileSync(path.join(architectureDir, 'study-evaluation.json'), JSON.stringify(artifacts.evaluation, null, 2));
    }
    if (artifacts.benchmark) {
      fs.writeFileSync(path.join(architectureDir, 'study-benchmark.json'), JSON.stringify(artifacts.benchmark, null, 2));
    }
    return workingDirectory;
  }

  describe('handleListApprovals', () => {
    it('returns a pending approvals list envelope', async () => {
      const items = [
        { id: 'approval-1', reason: 'deploy' },
        { id: 'approval-2', reason: 'rollback' },
      ];
      const { req, res } = createMockContext();
      mockDb.listPendingApprovals.mockReturnValue(items);

      await handlers.handleListApprovals(req, res);

      expect(mockDb.listPendingApprovals).toHaveBeenCalledOnce();
      expect(mockDb.getApprovalHistory).not.toHaveBeenCalled();
      expectListEnvelope(res, [
        expect.objectContaining({ id: 'approval-1', reason: 'deploy', approval_type: 'task_execution' }),
        expect.objectContaining({ id: 'approval-2', reason: 'rollback', approval_type: 'task_execution' }),
      ], 2);
      expect(mockSendJson).toHaveBeenCalledWith(res, res._body, 200, req);
    });

    it('returns an empty list when pending approvals is not an array', async () => {
      const { req, res } = createMockContext();
      mockDb.listPendingApprovals.mockReturnValue('not-an-array');

      await handlers.handleListApprovals(req, res);

      expectListEnvelope(res, [], 0);
    });

    it('returns pending approvals and history when include_history is true', async () => {
      const pending = [{ id: 'approval-1' }];
      const history = [{ id: 'approval-9', decision: 'approved' }];
      const { req, res } = createMockContext({
        query: {
          include_history: 'true',
          limit: '10',
        },
      });
      mockDb.listPendingApprovals.mockReturnValue(pending);
      mockDb.listApprovalHistory.mockReturnValue(history);

      await handlers.handleListApprovals(req, res);

      expect(mockDb.listApprovalHistory).toHaveBeenCalledWith({ limit: 10 });
      expectSuccessEnvelope(res, {
        pending: [expect.objectContaining({ id: 'approval-1', approval_type: 'task_execution' })],
        history: [expect.objectContaining({ id: 'approval-9', decision: 'approved', approval_type: 'task_execution' })],
      });
    });

    it('clamps history limit and normalizes non-array history values', async () => {
      const { req, res } = createMockContext({
        query: {
          include_history: 'true',
          limit: '999',
        },
      });
      mockDb.listPendingApprovals.mockReturnValue(null);
      mockDb.listApprovalHistory.mockReturnValue({ rows: [] });

      await handlers.handleListApprovals(req, res);

      expect(mockDb.listApprovalHistory).toHaveBeenCalledWith({ limit: 200 });
      expectSuccessEnvelope(res, {
        pending: [],
        history: [],
      });
    });

    it('returns normalized study proposal history when status=history', async () => {
      const { req, res } = createMockContext({
        query: {
          status: 'history',
          limit: '5',
        },
      });
      mockDb.listApprovalHistory.mockReturnValue([
        {
          id: 'approval-10',
          task_id: 'task-10',
          status: 'approved',
          approved_by: 'reviewer-1',
          approved_at: '2026-04-08T18:00:00.000Z',
          task_description: '[Study Proposal] Review task lifecycle drift',
          rule_name: 'Study proposal review',
          task_metadata: JSON.stringify({
            study_proposal: {
              title: 'Review task lifecycle drift',
              rationale: 'Changed files intersect a critical invariant.',
              kind: 'invariant-review',
              files: ['server/task-manager.js'],
              related_tests: ['server/tests/task-core-handlers.test.js'],
              validation_commands: ['npx vitest run server/tests/task-core-handlers.test.js'],
              trace: {
                schedule_id: 'study-2',
                schedule_run_id: 'run-42',
                delta_significance_level: 'high',
                delta_significance_score: 84,
                significance_reasons: ['2 critical invariants were touched.'],
              },
            },
          }),
        },
      ]);

      await handlers.handleListApprovals(req, res);

      expectListEnvelope(res, [
        expect.objectContaining({
          id: 'approval-10',
          approval_type: 'study_proposal',
          description: 'Review task lifecycle drift',
          rationale: 'Changed files intersect a critical invariant.',
          kind: 'invariant-review',
          files: ['server/task-manager.js'],
          study_trace: expect.objectContaining({
            schedule_id: 'study-2',
            schedule_run_id: 'run-42',
            delta_significance_level: 'high',
          }),
        }),
      ], 1);
    });

    it('resolves the request id from the header when requestId is absent', async () => {
      const { req, res } = createMockContext({
        requestId: undefined,
        headers: { 'x-request-id': 'req-from-header' },
      });

      await handlers.handleListApprovals(req, res);

      expectListEnvelope(res, [], 0, { requestId: 'req-from-header' });
    });
  });

  describe('handleApprovalDecision', () => {
    it('returns 400 when approval_id is missing', async () => {
      const { req, res } = createMockContext({
        params: {},
        body: { decision: 'approved' },
      });

      await handlers.handleApprovalDecision(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'approval_id is required',
      });
      expect(mockDb.decideApproval).not.toHaveBeenCalled();
    });

    it('returns 400 when decision is missing', async () => {
      const { req, res } = createMockContext({
        params: { approval_id: 'approval-1' },
        body: {},
      });

      await handlers.handleApprovalDecision(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'decision must be "approved" or "rejected"',
      });
    });

    it('returns 400 when decision is invalid', async () => {
      const { req, res } = createMockContext({
        params: { approval_id: 'approval-1' },
        body: { decision: 'hold' },
      });

      await handlers.handleApprovalDecision(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'decision must be "approved" or "rejected"',
      });
    });

    it('parses the body when req.body is missing and normalizes the decision', async () => {
      const { req, res } = createMockContext({
        body: undefined,
        params: { approval_id: 'approval-1' },
        parsedBody: { decision: '  Approved  ' },
      });

      await handlers.handleApprovalDecision(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
      expect(mockDb.decideApproval).toHaveBeenCalledWith('approval-1', 'approved', 'v2-api', null);
      expectSuccessEnvelope(res, {
        approval_id: 'approval-1',
        decision: 'approved',
        decided_by: 'v2-api',
        approval_type: 'legacy',
        task_id: null,
      });
    });

    it('passes decided_by through to the database and response payload', async () => {
      const { req, res } = createMockContext({
        requestId: undefined,
        headers: { 'x-request-id': 'approval-request' },
        params: { approval_id: 'approval-2' },
        body: {
          decision: 'rejected',
          decided_by: 'reviewer-1',
        },
      });

      await handlers.handleApprovalDecision(req, res);

      expect(mockDb.decideApproval).toHaveBeenCalledWith('approval-2', 'rejected', 'reviewer-1', null);
      expectSuccessEnvelope(res, {
        approval_id: 'approval-2',
        decision: 'rejected',
        decided_by: 'reviewer-1',
        approval_type: 'legacy',
        task_id: null,
      }, {
        requestId: 'approval-request',
      });
    });

    it('routes workflow approvals through scheduling automation requests', async () => {
      const { req, res } = createMockContext({
        params: { approval_id: 'approval-study-1' },
        body: {
          decision: 'approved',
          decided_by: 'reviewer-2',
          comment: 'Looks good',
        },
      });
      mockDb.getApprovalRequestById.mockReturnValue({
        id: 'approval-study-1',
        task_id: 'task-study-1',
        task_metadata: JSON.stringify({
          study_proposal: {
            title: 'Review task lifecycle drift',
          },
        }),
      });

      await handlers.handleApprovalDecision(req, res);

      expect(mockDb.approveTask).toHaveBeenCalledWith('task-study-1', 'reviewer-2', 'Looks good');
      expect(mockDb.decideApproval).not.toHaveBeenCalled();
      expectSuccessEnvelope(res, {
        approval_id: 'approval-study-1',
        decision: 'approved',
        decided_by: 'reviewer-2',
        approval_type: 'study_proposal',
        task_id: 'task-study-1',
      });
    });

    it('returns 501 when the approval system is unavailable', async () => {
      const { req, res } = createMockContext({
        params: { approval_id: 'approval-3' },
        body: { decision: 'approved' },
      });
      mockDb.decideApproval = undefined;
      mockDb.getApprovalRequestById = undefined;

      handlers = loadHandlers();

      await handlers.handleApprovalDecision(req, res);

      expectErrorEnvelope(res, {
        code: 'not_implemented',
        message: 'Approval system not available',
      }, {
        status: 501,
      });
    });

    it('returns 404 when the approval is not found', async () => {
      const { req, res } = createMockContext({
        params: { approval_id: 'approval-missing' },
        body: { decision: 'approved' },
      });
      mockDb.decideApproval.mockReturnValue(false);

      await handlers.handleApprovalDecision(req, res);

      expectErrorEnvelope(res, {
        code: 'approval_not_found',
        message: 'Approval not found: approval-missing',
      }, {
        status: 404,
      });
    });
  });

  describe('handleListSchedules', () => {
    it('returns a schedule list envelope', async () => {
      const items = [
        { id: 'schedule-1', name: 'Daily' },
        { id: 'schedule-2', name: 'Weekly' },
      ];
      const { req, res } = createMockContext();
      mockDb.listScheduledTasks.mockReturnValue(items);

      await handlers.handleListSchedules(req, res);

      expect(mockDb.listScheduledTasks).toHaveBeenCalledOnce();
      expectListEnvelope(res, items, 2);
    });

    it('returns an empty list when schedules is not an array', async () => {
      const { req, res } = createMockContext();
      mockDb.listScheduledTasks.mockReturnValue(null);

      await handlers.handleListSchedules(req, res);

      expectListEnvelope(res, [], 0);
    });

    it('enriches codebase study schedules with the latest study state', async () => {
      const workingDirectory = createStudyWorkingDirectory({
        delta_significance_level: 'moderate',
        delta_significance_score: 37,
        proposal_count: 3,
        submitted_proposal_count: 1,
        last_delta_updated_at: '2026-04-08T18:00:00.000Z',
        module_entry_count: 1450,
        last_result: 'partial_local',
        file_counts: { pending: 42 },
      });
      const items = [
        {
          id: 'study-1',
          name: 'Study TORQUE',
          task_config: {
            tool_name: 'run_codebase_study',
            tool_args: { working_directory: workingDirectory },
          },
        },
      ];
      const { req, res } = createMockContext();
      mockDb.listScheduledTasks.mockReturnValue(items);

      await handlers.handleListSchedules(req, res);

      expectListEnvelope(res, [
        expect.objectContaining({
          id: 'study-1',
          delta_significance_level: 'moderate',
          delta_significance_score: 37,
          proposal_count: 3,
          submitted_proposal_count: 1,
          last_delta_updated_at: '2026-04-08T18:00:00.000Z',
          pending_count: 42,
          module_entry_count: 1450,
          last_result: 'partial_local',
          study_status: expect.objectContaining({
            working_directory: workingDirectory,
            delta_significance_level: 'moderate',
          }),
        }),
      ], 1);
    });
  });

  describe('handleCreateSchedule', () => {
    it('returns 400 when name is missing', async () => {
      const { req, res } = createMockContext({
        body: {
          name: '   ',
          cron_expression: '0 * * * *',
          task_description: 'Run queue',
        },
      });

      await handlers.handleCreateSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'name is required',
      });
      expect(mockDb.createCronScheduledTask).not.toHaveBeenCalled();
    });

    it('returns 400 when cron_expression is missing', async () => {
      const { req, res } = createMockContext({
        body: {
          name: 'Every hour',
          task_description: 'Run queue',
        },
      });

      await handlers.handleCreateSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'cron_expression is required',
      });
    });

    it('returns 400 when no task target is provided', async () => {
      const { req, res } = createMockContext({
        body: {
          name: 'Every hour',
          cron_expression: '0 * * * *',
        },
      });

      await handlers.handleCreateSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'task_description, workflow_id, or workflow_source_id is required',
      });
    });

    it('parses the body when req.body is missing', async () => {
      const schedule = {
        id: 'schedule-parsed',
        name: 'Parsed',
        cron_expression: '0 0 * * *',
        task_description: 'Parsed task',
      };
      const { req, res } = createMockContext({
        body: undefined,
        parsedBody: {
          name: 'Parsed',
          cron_expression: '0 0 * * *',
          task_description: 'Parsed task',
        },
      });
      mockDb.createCronScheduledTask.mockReturnValue(schedule);

      await handlers.handleCreateSchedule(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
      expectSuccessEnvelope(res, schedule, { status: 201 });
    });

    it('creates a schedule with trimmed name and optional settings', async () => {
      const schedule = {
        id: 'schedule-99',
        name: 'Nightly sync',
        cron_expression: '0 2 * * *',
        task_description: 'Sync plans',
        provider: 'codex',
        model: 'gpt-5',
        working_directory: 'C:\\repo',
      };
      const { req, res } = createMockContext({
        body: {
          name: '  Nightly sync  ',
          cron_expression: '0 2 * * *',
          task_description: 'Sync plans',
          provider: 'codex',
          model: 'gpt-5',
          working_directory: 'C:\\repo',
        },
      });
      mockDb.createCronScheduledTask.mockReturnValue(schedule);

      await handlers.handleCreateSchedule(req, res);

      expect(mockDb.createCronScheduledTask).toHaveBeenCalledWith({
        name: 'Nightly sync',
        cron_expression: '0 2 * * *',
        task_config: {
          task: 'Sync plans',
          workflow_id: null,
          workflow_source_id: null,
          provider: 'codex',
          model: 'gpt-5',
          working_directory: 'C:\\repo',
          project: null,
        },
        timezone: null,
      });
      expectSuccessEnvelope(res, schedule, { status: 201 });
    });

    it('creates a workflow-source schedule with project metadata', async () => {
      const schedule = {
        id: 'schedule-autodev',
        name: 'example-project autodev',
        cron_expression: '*/10 * * * *',
        task_description: 'example-project autodev',
        working_directory: 'C:\\Users\\<os-user>\\Projects\\example-project-autodev',
        task_config: {
          task: 'example-project autodev',
          workflow_id: null,
          workflow_source_id: 'wf-source-1',
          provider: null,
          model: null,
          working_directory: 'C:\\Users\\<os-user>\\Projects\\example-project-autodev',
          project: 'example-project-autodev',
        },
      };
      const { req, res } = createMockContext({
        body: {
          name: 'example-project autodev',
          cron_expression: '*/10 * * * *',
          workflow_source_id: 'wf-source-1',
          working_directory: 'C:\\Users\\<os-user>\\Projects\\example-project-autodev',
          project: 'example-project-autodev',
        },
      });
      mockDb.createCronScheduledTask.mockReturnValue(schedule);

      await handlers.handleCreateSchedule(req, res);

      expect(mockDb.createCronScheduledTask).toHaveBeenCalledWith({
        name: 'example-project autodev',
        cron_expression: '*/10 * * * *',
        task_config: {
          task: 'example-project autodev',
          workflow_id: null,
          workflow_source_id: 'wf-source-1',
          provider: null,
          model: null,
          working_directory: 'C:\\Users\\<os-user>\\Projects\\example-project-autodev',
          project: 'example-project-autodev',
        },
        timezone: null,
      });
      expectSuccessEnvelope(res, schedule, { status: 201 });
    });

    it('rejects create requests that specify both workflow_id and workflow_source_id', async () => {
      const { req, res } = createMockContext({
        body: {
          name: 'Invalid workflow schedule',
          cron_expression: '*/10 * * * *',
          workflow_id: 'wf-1',
          workflow_source_id: 'wf-source-1',
        },
      });

      await handlers.handleCreateSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'workflow_id and workflow_source_id are mutually exclusive',
      });
      expect(mockDb.createCronScheduledTask).not.toHaveBeenCalled();
    });

    it('passes nulls for omitted optional schedule settings', async () => {
      const { req, res } = createMockContext({
        body: {
          name: 'Hourly',
          cron_expression: '0 * * * *',
          task_description: 'Check queue',
        },
      });

      await handlers.handleCreateSchedule(req, res);

      expect(mockDb.createCronScheduledTask).toHaveBeenCalledWith({
        name: 'Hourly',
        cron_expression: '0 * * * *',
        task_config: {
          task: 'Check queue',
          workflow_id: null,
          workflow_source_id: null,
          provider: null,
          model: null,
          working_directory: null,
          project: null,
        },
        timezone: null,
      });
      expectSuccessEnvelope(res, {
        id: 'schedule-1',
        name: 'Hourly',
        cron_expression: '0 * * * *',
        task_description: 'Check queue',
        task: 'Check queue',
        workflow_id: null,
        workflow_source_id: null,
        provider: null,
        model: null,
        working_directory: null,
        project: null,
        timezone: null,
      }, { status: 201 });
    });

    it('returns 500 when schedule creation throws', async () => {
      const { req, res } = createMockContext({
        body: {
          name: 'Broken',
          cron_expression: '* * * * *',
          task_description: 'Fail',
        },
      });
      mockDb.createCronScheduledTask.mockImplementation(() => {
        throw new Error('insert failed');
      });

      await handlers.handleCreateSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'insert failed',
      }, {
        status: 500,
      });
    });
  });

  describe('handleGetSchedule', () => {
    it('returns a schedule by id using direct lookup', async () => {
      const schedule = {
        id: 42,
        name: 'Numeric schedule',
        cron_expression: '0 * * * *',
      };
      const { req, res } = createMockContext({
        params: { schedule_id: '42' },
      });
      mockDb.getScheduledTask.mockReturnValue(schedule);

      await handlers.handleGetSchedule(req, res);

      expect(mockDb.getScheduledTask).toHaveBeenCalledWith('42', { include_runs: true, run_limit: 15 });
      expect(mockDb.listScheduledTasks).not.toHaveBeenCalled();
      expectSuccessEnvelope(res, schedule);
    });

    it('returns 404 when the schedule is not found', async () => {
      const { req, res } = createMockContext({
        params: { schedule_id: 'missing' },
      });

      await handlers.handleGetSchedule(req, res);

      expect(mockDb.getScheduledTask).toHaveBeenCalledWith('missing', { include_runs: true, run_limit: 15 });
      expectErrorEnvelope(res, {
        code: 'schedule_not_found',
        message: 'Schedule not found: missing',
      }, {
        status: 404,
      });
    });

    it('enriches a study schedule detail response with study state', async () => {
      const workingDirectory = createStudyWorkingDirectory({
        delta_significance_level: 'high',
        delta_significance_score: 84,
        proposal_count: 2,
        submitted_proposal_count: 0,
        last_delta_updated_at: '2026-04-08T20:15:00.000Z',
        module_entry_count: 1501,
        last_result: 'up_to_date',
        file_counts: { pending: 0 },
        evaluation_score: 91,
        evaluation_grade: 'A',
        evaluation_readiness: 'expert_ready',
        evaluation_findings_count: 1,
        evaluation_generated_at: '2026-04-08T20:16:00.000Z',
        benchmark_score: 88,
        benchmark_grade: 'B',
        benchmark_readiness: 'operator_ready',
        benchmark_findings_count: 1,
        benchmark_case_count: 8,
        benchmark_generated_at: '2026-04-08T20:17:00.000Z',
      }, {
        delta: {
          significance: {
            level: 'high',
            score: 84,
            reasons: ['Control-plane and scheduling files changed together.'],
          },
          changed_subsystems: [{ id: 'control-plane-api', label: 'Control-plane API' }],
          affected_flows: [{ id: 'scheduled-automation', label: 'Scheduled automation' }],
          invariant_hits: [{ id: 'scheduled-automation:5', statement: 'Schedules should create tracked task or tool executions.' }],
          failure_mode_hits: [{ id: 'schedule-run-divergence', label: 'Run Now path divergence' }],
          proposals: { suggested: [{ key: 'study:delta:1', title: 'Review scheduling drift' }] },
        },
        evaluation: {
          summary: {
            score: 91,
            grade: 'A',
            readiness: 'expert_ready',
            findings_count: 1,
          },
          strengths: ['Coverage is effectively complete.'],
          findings: [{ code: 'thin_traces', message: 'Only a few traces are present.' }],
        },
        benchmark: {
          summary: {
            score: 88,
            grade: 'B',
            readiness: 'operator_ready',
            total_cases: 8,
          },
          findings: [{ probe_id: 'task-lifecycle', message: 'Pack coverage hit 2/3 expected evidence files.' }],
          cases: [{ id: 'task-lifecycle', score: 88, verdict: 'pass' }],
        },
      });
      const schedule = {
        id: 'study-2',
        name: 'Study detail',
        task_config: {
          tool_name: 'run_codebase_study',
          tool_args: { working_directory: workingDirectory },
        },
      };
      const { req, res } = createMockContext({
        params: { schedule_id: 'study-2' },
      });
      mockDb.getScheduledTask.mockReturnValue(schedule);

      await handlers.handleGetSchedule(req, res);

      expectSuccessEnvelope(res, expect.objectContaining({
        id: 'study-2',
        delta_significance_level: 'high',
        delta_significance_score: 84,
        proposal_count: 2,
        module_entry_count: 1501,
        last_result: 'up_to_date',
        evaluation_score: 91,
        evaluation_grade: 'A',
        evaluation_readiness: 'expert_ready',
        benchmark_score: 88,
        benchmark_grade: 'B',
        benchmark_readiness: 'operator_ready',
        study_delta: expect.objectContaining({
          changed_subsystems: [expect.objectContaining({ label: 'Control-plane API' })],
        }),
        study_evaluation: expect.objectContaining({
          summary: expect.objectContaining({ score: 91 }),
        }),
        study_benchmark: expect.objectContaining({
          summary: expect.objectContaining({ score: 88 }),
        }),
      }));
    });
  });

  describe('handleGetScheduleRun', () => {
    it('returns a schedule run by id when it belongs to the schedule', async () => {
      const { req, res } = createMockContext({
        params: { schedule_id: 'study-2', run_id: 'run-42' },
      });
      mockDb.getScheduledTask.mockReturnValue({ id: 'study-2', name: 'Study detail' });
      mockDb.getScheduledTaskRun.mockReturnValue({
        id: 'run-42',
        schedule_id: 'study-2',
        status: 'completed',
      });

      await handlers.handleGetScheduleRun(req, res);

      expect(mockDb.getScheduledTask).toHaveBeenCalledWith('study-2', { include_runs: false, hydrateRuns: false });
      expect(mockDb.getScheduledTaskRun).toHaveBeenCalledWith('run-42');
      expectSuccessEnvelope(res, {
        id: 'run-42',
        schedule_id: 'study-2',
        status: 'completed',
      });
    });

    it('returns 404 when the run does not belong to the schedule', async () => {
      const { req, res } = createMockContext({
        params: { schedule_id: 'study-2', run_id: 'run-42' },
      });
      mockDb.getScheduledTask.mockReturnValue({ id: 'study-2', name: 'Study detail' });
      mockDb.getScheduledTaskRun.mockReturnValue({
        id: 'run-42',
        schedule_id: 'other-schedule',
      });

      await handlers.handleGetScheduleRun(req, res);

      expectErrorEnvelope(res, {
        code: 'schedule_run_not_found',
        message: 'Schedule run not found: run-42',
      }, {
        status: 404,
      });
    });
  });

  describe('handleUpdateSchedule', () => {
    it('merges study tool args when proposal controls are updated', async () => {
      const existing = {
        id: 'study-3',
        task_config: {
          tool_name: 'run_codebase_study',
          tool_args: {
            working_directory: 'C:\\repo',
            submit_proposals: false,
            proposal_limit: 2,
            proposal_significance_level: 'moderate',
            proposal_min_score: 0,
            untouched: 'keep-me',
          },
        },
      };
      const updated = {
        id: 'study-3',
        task_config: {
          tool_name: 'run_codebase_study',
          tool_args: {
            working_directory: 'C:\\repo',
            submit_proposals: true,
            proposal_limit: 5,
            proposal_significance_level: 'high',
            proposal_min_score: 40,
            untouched: 'keep-me',
          },
        },
      };
      const { req, res } = createMockContext({
        params: { schedule_id: 'study-3' },
        body: {
          submit_proposals: true,
          proposal_limit: 5,
          proposal_significance_level: 'high',
          proposal_min_score: 40,
        },
      });
      mockDb.getScheduledTask.mockReturnValue(existing);
      mockDb.updateScheduledTask.mockReturnValue(updated);

      await handlers.handleUpdateSchedule(req, res);

      expect(mockDb.updateScheduledTask).toHaveBeenCalledWith('study-3', {
        task_config: {
          tool_args: {
            working_directory: 'C:\\repo',
            submit_proposals: true,
            proposal_limit: 5,
            proposal_significance_level: 'high',
            proposal_min_score: 40,
            untouched: 'keep-me',
          },
        },
      });
      expectSuccessEnvelope(res, updated);
    });

    it('rejects invalid proposal_significance_level values', async () => {
      const existing = {
        id: 'study-4b',
        task_config: {
          tool_name: 'run_codebase_study',
          tool_args: {
            working_directory: 'C:\\repo',
          },
        },
      };
      const { req, res } = createMockContext({
        params: { schedule_id: 'study-4b' },
        body: {
          proposal_significance_level: 'urgent',
        },
      });
      mockDb.getScheduledTask.mockReturnValue(existing);

      await handlers.handleUpdateSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'proposal_significance_level must be one of: none, baseline, low, moderate, high, critical',
      }, {
        status: 400,
        details: { field: 'proposal_significance_level' },
      });
    });

    it('rejects invalid proposal_limit values', async () => {
      const existing = {
        id: 'study-4',
        task_config: {
          tool_name: 'run_codebase_study',
          tool_args: {
            working_directory: 'C:\\repo',
          },
        },
      };
      const { req, res } = createMockContext({
        params: { schedule_id: 'study-4' },
        body: {
          proposal_limit: 0,
        },
      });
      mockDb.getScheduledTask.mockReturnValue(existing);

      await handlers.handleUpdateSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'proposal_limit must be a positive integer',
      }, {
        status: 400,
        details: { field: 'proposal_limit' },
      });
      expect(mockDb.updateScheduledTask).not.toHaveBeenCalled();
    });

    it('updates workflow-source schedule metadata and project tags', async () => {
      const existing = {
        id: 'sched-autodev',
        task_config: {
          workflow_source_id: 'wf-source-1',
          workflow_id: null,
          project: null,
        },
      };
      const updated = {
        id: 'sched-autodev',
        task_config: {
          workflow_source_id: 'wf-source-2',
          workflow_id: null,
          project: 'example-project-autodev',
        },
      };
      const { req, res } = createMockContext({
        params: { schedule_id: 'sched-autodev' },
        body: {
          workflow_source_id: 'wf-source-2',
          workflow_id: null,
          project: 'example-project-autodev',
        },
      });
      mockDb.getScheduledTask.mockReturnValue(existing);
      mockDb.updateScheduledTask.mockReturnValue(updated);

      await handlers.handleUpdateSchedule(req, res);

      expect(mockDb.updateScheduledTask).toHaveBeenCalledWith('sched-autodev', {
        task_config: {
          project: 'example-project-autodev',
          workflow_id: null,
          workflow_source_id: 'wf-source-2',
        },
      });
      expectSuccessEnvelope(res, updated);
    });

    it('rejects updates that specify both workflow_id and workflow_source_id', async () => {
      const existing = {
        id: 'sched-invalid',
        task_config: {},
      };
      const { req, res } = createMockContext({
        params: { schedule_id: 'sched-invalid' },
        body: {
          workflow_id: 'wf-1',
          workflow_source_id: 'wf-source-1',
        },
      });
      mockDb.getScheduledTask.mockReturnValue(existing);

      await handlers.handleUpdateSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'workflow_id and workflow_source_id are mutually exclusive',
      });
      expect(mockDb.updateScheduledTask).not.toHaveBeenCalled();
    });
  });

  describe('handleToggleSchedule', () => {
    it('toggles a schedule with explicit enabled=false', async () => {
      const toggled = {
        id: 'schedule-1',
        enabled: false,
        name: 'Nightly',
      };
      const { req, res } = createMockContext({
        params: { schedule_id: 'schedule-1' },
        body: { enabled: false },
      });
      mockDb.toggleScheduledTask.mockReturnValue(toggled);

      await handlers.handleToggleSchedule(req, res);

      expect(mockDb.toggleScheduledTask).toHaveBeenCalledWith('schedule-1', false);
      expectSuccessEnvelope(res, toggled);
    });

    it('defaults enabled to true when omitted and parses the body when needed', async () => {
      const toggled = {
        id: 'schedule-2',
        enabled: true,
      };
      const { req, res } = createMockContext({
        body: undefined,
        params: { schedule_id: 'schedule-2' },
        parsedBody: {},
      });
      mockDb.toggleScheduledTask.mockReturnValue(toggled);

      await handlers.handleToggleSchedule(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
      expect(mockDb.toggleScheduledTask).toHaveBeenCalledWith('schedule-2', true);
      expectSuccessEnvelope(res, toggled);
    });

    it('returns 404 when the schedule is not found', async () => {
      const { req, res } = createMockContext({
        params: { schedule_id: 'missing' },
        body: { enabled: true },
      });
      mockDb.toggleScheduledTask.mockReturnValue(null);

      await handlers.handleToggleSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'schedule_not_found',
        message: 'Schedule not found: missing',
      }, {
        status: 404,
      });
    });

    it('returns 500 when toggling throws', async () => {
      const { req, res } = createMockContext({
        params: { schedule_id: 'broken' },
        body: { enabled: true },
      });
      mockDb.toggleScheduledTask.mockImplementation(() => {
        throw new Error('toggle failed');
      });

      await handlers.handleToggleSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'toggle failed',
      }, {
        status: 500,
      });
    });
  });

  describe('handleRunSchedule', () => {
    it('starts a schedule immediately and returns accepted', async () => {
      const result = {
        started: true,
        execution_type: 'task',
        task_id: 'task-77',
        schedule_id: 'schedule-run',
        schedule_name: 'Nightly',
        schedule_consumed: false,
      };
      const { req, res } = createMockContext({
        params: { schedule_id: 'schedule-run' },
      });
      mockDb.runScheduledTaskNow.mockReturnValue(result);

      await handlers.handleRunSchedule(req, res);

      expect(mockDb.runScheduledTaskNow).toHaveBeenCalledWith('schedule-run', { db: mockDb });
      expectSuccessEnvelope(res, result, { status: 202 });
    });

    it('returns 404 when the schedule to run is missing', async () => {
      const { req, res } = createMockContext({
        params: { schedule_id: 'missing-run' },
      });
      mockDb.runScheduledTaskNow.mockReturnValue(null);

      await handlers.handleRunSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'schedule_not_found',
        message: 'Schedule not found: missing-run',
      }, {
        status: 404,
      });
    });

    it('returns 500 when manual run throws', async () => {
      const { req, res } = createMockContext({
        params: { schedule_id: 'broken-run' },
      });
      mockDb.runScheduledTaskNow.mockImplementation(() => {
        throw new Error('run failed');
      });

      await handlers.handleRunSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'run failed',
      }, {
        status: 500,
      });
    });
  });

  describe('handleDeleteSchedule', () => {
    it('deletes a schedule and returns a success envelope', async () => {
      const { req, res } = createMockContext({
        params: { schedule_id: 'schedule-delete' },
      });

      await handlers.handleDeleteSchedule(req, res);

      expect(mockDb.deleteScheduledTask).toHaveBeenCalledWith('schedule-delete');
      expectSuccessEnvelope(res, {
        deleted: true,
        schedule_id: 'schedule-delete',
      });
    });

    it('returns 404 when the schedule to delete is not found', async () => {
      const { req, res } = createMockContext({
        params: { schedule_id: 'missing-delete' },
      });
      mockDb.deleteScheduledTask.mockReturnValue(false);

      await handlers.handleDeleteSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'schedule_not_found',
        message: 'Schedule not found: missing-delete',
      }, {
        status: 404,
      });
    });

    it('returns 500 when delete throws', async () => {
      const { req, res } = createMockContext({
        params: { schedule_id: 'schedule-error' },
      });
      mockDb.deleteScheduledTask.mockImplementation(() => {
        throw new Error('delete failed');
      });

      await handlers.handleDeleteSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'operation_failed',
        message: 'delete failed',
      }, {
        status: 500,
      });
    });
  });
});
