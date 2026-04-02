'use strict';

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
  getApprovalHistory: vi.fn(),
  decideApproval: vi.fn(),
  getScheduledTask: vi.fn(),
  listScheduledTasks: vi.fn(),
  createCronScheduledTask: vi.fn(),
  toggleScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
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
  mockDb.getApprovalHistory = vi.fn().mockReturnValue([]);
  mockDb.decideApproval = vi.fn().mockReturnValue(true);
  mockDb.getScheduledTask = vi.fn().mockReturnValue(null);
  mockDb.listScheduledTasks = vi.fn().mockReturnValue([]);
  mockDb.createCronScheduledTask = vi.fn().mockImplementation(({ name, cron_expression, task_config, timezone }) => ({
    id: 'schedule-1',
    name,
    cron_expression,
    task_description: task_config?.task,
    ...task_config,
    timezone,
  }));
  mockDb.toggleScheduledTask = vi.fn().mockImplementation((id, enabled) => ({
    id,
    enabled,
  }));
  mockDb.deleteScheduledTask = vi.fn().mockReturnValue(true);

  mockParseBody.mockReset();
  mockParseBody.mockImplementation(async (req) => req?._parsedBody ?? req?.body ?? {});
  mockSendJson.mockClear();
}

describe('api/v2-governance-handlers approvals and schedules', () => {
  let handlers;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TIMESTAMP));
    resetMockDefaults();
    handlers = loadHandlers();
    handlers.init(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearLoadedModules();
  });

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
      expectListEnvelope(res, items, 2);
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
      mockDb.getApprovalHistory.mockReturnValue(history);

      await handlers.handleListApprovals(req, res);

      expect(mockDb.getApprovalHistory).toHaveBeenCalledWith(10);
      expectSuccessEnvelope(res, {
        pending,
        history,
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
      mockDb.getApprovalHistory.mockReturnValue({ rows: [] });

      await handlers.handleListApprovals(req, res);

      expect(mockDb.getApprovalHistory).toHaveBeenCalledWith(200);
      expectSuccessEnvelope(res, {
        pending: [],
        history: [],
      });
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
      expect(mockDb.decideApproval).toHaveBeenCalledWith('approval-1', 'approved', 'v2-api');
      expectSuccessEnvelope(res, {
        approval_id: 'approval-1',
        decision: 'approved',
        decided_by: 'v2-api',
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

      expect(mockDb.decideApproval).toHaveBeenCalledWith('approval-2', 'rejected', 'reviewer-1');
      expectSuccessEnvelope(res, {
        approval_id: 'approval-2',
        decision: 'rejected',
        decided_by: 'reviewer-1',
      }, {
        requestId: 'approval-request',
      });
    });

    it('returns 501 when the approval system is unavailable', async () => {
      const { req, res } = createMockContext({
        params: { approval_id: 'approval-3' },
        body: { decision: 'approved' },
      });
      mockDb.decideApproval = undefined;

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

    it('returns 400 when task_description is missing', async () => {
      const { req, res } = createMockContext({
        body: {
          name: 'Every hour',
          cron_expression: '0 * * * *',
        },
      });

      await handlers.handleCreateSchedule(req, res);

      expectErrorEnvelope(res, {
        code: 'validation_error',
        message: 'task_description is required',
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
          provider: 'codex',
          model: 'gpt-5',
          working_directory: 'C:\\repo',
        },
        timezone: null,
      });
      expectSuccessEnvelope(res, schedule, { status: 201 });
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
          provider: null,
          model: null,
          working_directory: null,
        },
        timezone: null,
      });
      expectSuccessEnvelope(res, {
        id: 'schedule-1',
        name: 'Hourly',
        cron_expression: '0 * * * *',
        task_description: 'Check queue',
        task: 'Check queue',
        provider: null,
        model: null,
        working_directory: null,
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

      expect(mockDb.getScheduledTask).toHaveBeenCalledWith('42');
      expect(mockDb.listScheduledTasks).not.toHaveBeenCalled();
      expectSuccessEnvelope(res, schedule);
    });

    it('returns 404 when the schedule is not found', async () => {
      const { req, res } = createMockContext({
        params: { schedule_id: 'missing' },
      });

      await handlers.handleGetSchedule(req, res);

      expect(mockDb.getScheduledTask).toHaveBeenCalledWith('missing');
      expectErrorEnvelope(res, {
        code: 'schedule_not_found',
        message: 'Schedule not found: missing',
      }, {
        status: 404,
      });
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
