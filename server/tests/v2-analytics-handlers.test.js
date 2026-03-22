'use strict';

const HANDLER_MODULE = '../api/v2-analytics-handlers';
const CONTROL_PLANE_MODULE = '../api/v2-control-plane';
const MODULE_PATHS = [
  HANDLER_MODULE,
  CONTROL_PLANE_MODULE,
  '../api/middleware',
  '../database',
  '../hooks/event-dispatch',
  '../mcp-sse',
  '../handlers/orchestrator-handlers',
  '../config',
  '../tools',
];

const mockDb = {
  countTasks: vi.fn(),
  countTasksByStatus: vi.fn(),
  getOverallQualityStats: vi.fn(),
  getQualityStatsByProvider: vi.fn(),
  getValidationFailureRate: vi.fn(),
  listTasks: vi.fn(),
  getDbInstance: vi.fn(),
  getFormatSuccessRatesSummary: vi.fn(),
  getWebhookStats: vi.fn(),
  listWebhooks: vi.fn(),
  getCostSummary: vi.fn(),
  getCostByPeriod: vi.fn(),
  getBudgetStatus: vi.fn(),
  setBudget: vi.fn(),
  listProviders: vi.fn(),
  getProviderStats: vi.fn(),
  getProviderHealth: vi.fn(),
  isProviderHealthy: vi.fn(),
  getUsageHistory: vi.fn(),
  getRecentStrategicOperations: vi.fn(),
};

const mockParseBody = vi.fn();
const mockSendJson = vi.fn();
const mockMiddleware = {
  parseBody: mockParseBody,
  sendJson: mockSendJson,
};

const mockEventDispatch = {
  getTaskEvents: vi.fn(),
};

const mockMcpSse = {
  sessions: new Map(),
  getActiveSessionCount: vi.fn(),
  notificationMetrics: {},
};

const mockOrchestratorHandlers = {
  getStrategicStatus: vi.fn(),
};

const mockServerConfig = {
  isOptIn: vi.fn(),
  getInt: vi.fn(),
};

const mockTools = {
  callTool: vi.fn(),
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
      // Ignore unloaded modules.
    }
  }
}

function loadHandlers() {
  clearLoadedModules();
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../api/middleware', mockMiddleware);
  installCjsModuleMock('../hooks/event-dispatch', mockEventDispatch);
  installCjsModuleMock('../mcp-sse', mockMcpSse);
  installCjsModuleMock('../handlers/orchestrator-handlers', mockOrchestratorHandlers);
  installCjsModuleMock('../config', mockServerConfig);
  installCjsModuleMock('../tools', mockTools);
  require(CONTROL_PLANE_MODULE);
  return require(HANDLER_MODULE);
}

function createReq(overrides = {}) {
  return {
    params: {},
    query: {},
    headers: {},
    requestId: 'req-123',
    body: undefined,
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

function expectMeta(meta, requestId = 'req-123') {
  expect(meta).toEqual({
    request_id: requestId,
    timestamp: '2026-03-10T12:00:00.000Z',
  });
}

function expectSuccess(res, { status = 200, requestId = 'req-123' } = {}) {
  expect(mockSendJson).toHaveBeenCalledOnce();
  expect(res.statusCode).toBe(status);
  expectMeta(res._body.meta, requestId);
  expect(res._body).toEqual(expect.objectContaining({
    data: expect.anything(),
  }));
  return res._body.data;
}

function expectError(res, {
  status = 400,
  requestId = 'req-123',
  code,
  message,
  details = {},
} = {}) {
  expect(mockSendJson).toHaveBeenCalledOnce();
  expect(res.statusCode).toBe(status);
  expectMeta(res._body.meta, requestId);
  expect(res._body.error).toEqual({
    code,
    message,
    details,
    request_id: requestId,
  });
}

function countKey(filters = {}) {
  return [
    filters.provider ?? '',
    filters.from_date ?? '',
    filters.to_date ?? '',
    filters.completed_from ?? '',
    filters.completed_to ?? '',
    filters.status ?? 'all',
    filters.includeArchived ? 'archived' : '',
  ].join('|');
}

function mockCountTasksWithMap(counts) {
  mockDb.countTasks.mockImplementation((filters = {}) => counts[countKey(filters)] ?? 0);
  mockDb.countTasksByStatus.mockImplementation(() => ({
    running: counts[countKey({ status: 'running' })] ?? 0,
    queued: counts[countKey({ status: 'queued' })] ?? 0,
    completed: counts[countKey({ status: 'completed' })] ?? 0,
    failed: counts[countKey({ status: 'failed' })] ?? 0,
    cancelled: counts[countKey({ status: 'cancelled' })] ?? 0,
  }));
}

function minutesAgo(minutes) {
  return new Date(Date.now() - (minutes * 60 * 1000)).toISOString();
}

async function withPatchedProperties(target, patch, callback) {
  const originals = {};
  for (const [key, value] of Object.entries(patch)) {
    originals[key] = target[key];
    target[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      target[key] = value;
    }
  }
}

function resetMockDefaults() {
  mockDb.countTasks.mockReset().mockReturnValue(0);
  mockDb.countTasksByStatus.mockReset().mockReturnValue({});
  mockDb.getOverallQualityStats.mockReset().mockReturnValue({});
  mockDb.getQualityStatsByProvider.mockReset().mockReturnValue([]);
  mockDb.getValidationFailureRate.mockReset().mockReturnValue({});
  mockDb.listTasks.mockReset().mockReturnValue([]);
  mockDb.getDbInstance.mockReset().mockReturnValue(null);
  mockDb.getFormatSuccessRatesSummary.mockReset().mockReturnValue([]);
  mockDb.getWebhookStats.mockReset().mockReturnValue({
    webhooks: { total: 0, active: 0 },
    deliveries_24h: { total: 0, successful: 0, failed: 0 },
  });
  mockDb.listWebhooks.mockReset().mockReturnValue([]);
  mockDb.getCostSummary.mockReset().mockReturnValue([]);
  mockDb.getCostByPeriod.mockReset().mockReturnValue([]);
  mockDb.getBudgetStatus.mockReset().mockReturnValue([]);
  mockDb.setBudget.mockReset().mockReturnValue({ created: true });
  mockDb.listProviders.mockReset().mockReturnValue([]);
  mockDb.getProviderStats.mockReset().mockReturnValue({});
  mockDb.getProviderHealth.mockReset().mockReturnValue({
    successes: 0,
    failures: 0,
    failureRate: 0,
  });
  mockDb.isProviderHealthy.mockReset().mockReturnValue(true);
  mockDb.getUsageHistory.mockReset().mockReturnValue([]);
  mockDb.getRecentStrategicOperations.mockReset().mockReturnValue([]);

  mockServerConfig.isOptIn.mockReset().mockReturnValue(false);
  mockServerConfig.getInt.mockReset().mockImplementation((key, fallback) => fallback);

  mockTools.callTool.mockReset().mockReturnValue({ content: [{ text: '' }] });

  mockParseBody.mockReset().mockResolvedValue({});
  mockSendJson.mockReset().mockImplementation((res, data, status = 200, req = null) => {
    const headers = { 'Content-Type': 'application/json' };
    if (req?.requestId) {
      headers['X-Request-ID'] = req.requestId;
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(data));
  });

  mockEventDispatch.getTaskEvents.mockReset().mockReturnValue([]);
  mockMcpSse.sessions = new Map();
  mockMcpSse.getActiveSessionCount.mockReset().mockReturnValue(0);
  mockMcpSse.notificationMetrics = {};
  mockOrchestratorHandlers.getStrategicStatus.mockReset().mockReturnValue({});
}

describe('api/v2-analytics-handlers', () => {
  let handlers;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    vi.restoreAllMocks();
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    clearLoadedModules();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('handleStatsOverview', () => {
    it('returns today stats, active counts, and totals', async () => {
      const req = createReq({
        requestId: undefined,
        headers: { 'x-request-id': 'req-from-header' },
      });
      const res = createMockRes();

      // Handler calls countTasks with calendar-day boundaries:
      // 1. todayCompleted: completed_from=today, completed_to=tomorrow, status=completed
      // 2. todayFailed: completed_from=today, completed_to=tomorrow, status=failed
      // 3. todayRunning: from_date=today, to_date=tomorrow, status=running
      // 4-8. totals by status
      mockCountTasksWithMap({
        [countKey({ completed_from: '2026-03-10', completed_to: '2026-03-11', status: 'completed' })]: 8,
        [countKey({ completed_from: '2026-03-10', completed_to: '2026-03-11', status: 'failed' })]: 2,
        [countKey({ from_date: '2026-03-10', to_date: '2026-03-11', status: 'running' })]: 1,
        [countKey({ status: 'running' })]: 3,
        [countKey({ status: 'queued' })]: 4,
        [countKey({ status: 'completed' })]: 30,
        [countKey({ status: 'failed' })]: 5,
        [countKey({ status: 'cancelled' })]: 1,
      });

      await handlers.handleStatsOverview(req, res);

      expect(mockDb.countTasks).toHaveBeenNthCalledWith(1, {
        completed_from: '2026-03-10',
        completed_to: '2026-03-11',
        status: 'completed',
      });
      expect(mockDb.countTasks).toHaveBeenNthCalledWith(2, {
        completed_from: '2026-03-10',
        completed_to: '2026-03-11',
        status: 'failed',
      });
      const todayTotal = 8 + 2 + 1; // completed + failed + running
      expect(expectSuccess(res, { requestId: 'req-from-header' })).toEqual({
        today: {
          total: todayTotal,
          completed: 8,
          failed: 2,
          success_rate: 80,
          successRate: 80,
        },
        active: { running: 3, queued: 4 },
        totals: {
          running: 3,
          queued: 4,
          completed: 30,
          failed: 5,
          cancelled: 1,
        },
      });
    });

    it('returns zeros when countTasks is unavailable', async () => {
      const res = createMockRes();

      await withPatchedProperties(mockDb, { countTasks: null }, async () => {
        await handlers.handleStatsOverview(createReq(), res);
      });

      expect(expectSuccess(res)).toEqual({
        today: {
          total: 0,
          completed: 0,
          failed: 0,
          success_rate: 0,
          successRate: 0,
        },
        active: { running: 0, queued: 0 },
        totals: {
          running: 0,
          queued: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        },
      });
    });
  });

  describe('handleTimeSeries', () => {
    it('returns a time series and filters by provider', async () => {
      const req = createReq({
        query: { days: '3', provider: 'codex' },
      });
      const res = createMockRes();

      // buildTimeSeries uses completed_from/completed_to with includeArchived
      mockCountTasksWithMap({
        [countKey({ provider: 'codex', completed_from: '2026-03-08', completed_to: '2026-03-09', status: 'completed', includeArchived: true })]: 4,
        [countKey({ provider: 'codex', completed_from: '2026-03-08', completed_to: '2026-03-09', status: 'failed', includeArchived: true })]: 1,
        [countKey({ provider: 'codex', completed_from: '2026-03-09', completed_to: '2026-03-10', status: 'completed', includeArchived: true })]: 2,
        [countKey({ provider: 'codex', completed_from: '2026-03-09', completed_to: '2026-03-10', status: 'failed', includeArchived: true })]: 0,
        [countKey({ provider: 'codex', completed_from: '2026-03-10', completed_to: '2026-03-11', status: 'completed', includeArchived: true })]: 0,
        [countKey({ provider: 'codex', completed_from: '2026-03-10', completed_to: '2026-03-11', status: 'failed', includeArchived: true })]: 0,
      });

      await handlers.handleTimeSeries(req, res);

      expect(mockDb.countTasks).toHaveBeenNthCalledWith(1, {
        completed_from: '2026-03-08',
        completed_to: '2026-03-09',
        includeArchived: true,
        provider: 'codex',
        status: 'completed',
      });
      expect(expectSuccess(res)).toEqual({
        days: 3,
        provider: 'codex',
        series: [
          { date: '2026-03-08', total: 5, completed: 4, failed: 1, success_rate: 80 },
          { date: '2026-03-09', total: 2, completed: 2, failed: 0, success_rate: 100 },
          { date: '2026-03-10', total: 0, completed: 0, failed: 0, success_rate: 0 },
        ],
      });
    });

    it('uses the default seven day window when days is invalid', async () => {
      const res = createMockRes();

      await handlers.handleTimeSeries(
        createReq({ query: { days: 'not-a-number' } }),
        res,
      );

      const data = expectSuccess(res);
      expect(data.days).toBe(7);
      expect(data.provider).toBeNull();
      expect(data.series).toHaveLength(7);
      // 7 days * 2 calls per day (completed + failed) = 14
      expect(mockDb.countTasks).toHaveBeenCalledTimes(14);
    });

    it('clamps negative days to one', async () => {
      const res = createMockRes();

      await handlers.handleTimeSeries(
        createReq({ query: { days: '-5' } }),
        res,
      );

      expect(expectSuccess(res).series).toEqual([
        { date: '2026-03-10', total: 0, completed: 0, failed: 0, success_rate: 0 },
      ]);
    });

    it('clamps days above the max to 365', async () => {
      const res = createMockRes();

      await handlers.handleTimeSeries(
        createReq({ query: { days: '5000' } }),
        res,
      );

      const data = expectSuccess(res);
      expect(data.days).toBe(365);
      expect(data.series).toHaveLength(365);
    });
  });

  describe('handleQualityStats', () => {
    it('returns quality stats for the requested period', async () => {
      const req = createReq({ query: { hours: '48' } });
      const res = createMockRes();

      mockDb.getOverallQualityStats.mockReturnValue({ average_score: 91 });
      mockDb.getQualityStatsByProvider.mockReturnValue([
        { provider: 'codex', average_score: 94 },
      ]);
      mockDb.getValidationFailureRate.mockReturnValue({ failure_rate: 0.08 });

      await handlers.handleQualityStats(req, res);

      expect(mockDb.getOverallQualityStats).toHaveBeenCalledWith('2026-03-08T12:00:00.000Z');
      expect(mockDb.getQualityStatsByProvider).toHaveBeenCalledWith('2026-03-08T12:00:00.000Z');
      expect(mockDb.getValidationFailureRate).toHaveBeenCalledWith('2026-03-08T12:00:00.000Z');
      expect(expectSuccess(res)).toEqual({
        period: { hours: 48, since: '2026-03-08T12:00:00.000Z' },
        overall: { average_score: 91 },
        by_provider: [{ provider: 'codex', average_score: 94 }],
        validation: { failure_rate: 0.08 },
      });
    });

    it('uses default values when quality db methods are missing', async () => {
      const res = createMockRes();

      await withPatchedProperties(mockDb, {
        getOverallQualityStats: null,
        getQualityStatsByProvider: null,
        getValidationFailureRate: null,
      }, async () => {
        await handlers.handleQualityStats(
          createReq({ query: { hours: 'bad' } }),
          res,
        );
      });

      expect(expectSuccess(res).period).toEqual({
        hours: 24,
        since: '2026-03-09T12:00:00.000Z',
      });
      expect(res._body.data.overall).toEqual({});
      expect(res._body.data.by_provider).toEqual([]);
      expect(res._body.data.validation).toEqual({});
    });

    it('returns 500 when a quality stats lookup throws', async () => {
      const res = createMockRes();

      mockDb.getOverallQualityStats.mockImplementation(() => {
        throw new Error('quality stats failed');
      });

      await handlers.handleQualityStats(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'quality stats failed',
      });
    });
  });

  describe('handleStuckTasks', () => {
    it('returns categorized stuck tasks and truncates task lists to ten items', async () => {
      const res = createMockRes();
      const pendingApproval = Array.from({ length: 12 }, (_, index) => ({
        id: `approval-${index}`,
        created_at: minutesAgo(20 + index),
      }));
      const pendingSwitch = [
        { id: 'switch-created', created_at: minutesAgo(20) },
        { id: 'switch-switched', created_at: minutesAgo(5), provider_switched_at: minutesAgo(25) },
      ];
      const longRunning = [
        { id: 'running-1', started_at: minutesAgo(45) },
        { id: 'running-2', started_at: minutesAgo(31) },
        { id: 'running-recent', started_at: minutesAgo(10) },
      ];
      const waiting = Array.from({ length: 11 }, (_, index) => ({
        id: `waiting-${index}`,
      }));

      mockDb.listTasks.mockImplementation((filters = {}) => {
        if (filters.status === 'pending_approval') {
          return [...pendingApproval, { id: 'approval-recent', created_at: minutesAgo(5) }];
        }
        if (filters.status === 'pending_provider_switch') return pendingSwitch;
        if (filters.status === 'running') return longRunning;
        if (filters.status === 'waiting') return waiting;
        return [];
      });

      await handlers.handleStuckTasks(createReq(), res);

      expect(mockDb.listTasks).toHaveBeenNthCalledWith(1, {
        status: 'pending_approval',
        limit: 50,
      });
      expect(expectSuccess(res)).toEqual({
        pending_approval: {
          count: 12,
          tasks: pendingApproval.slice(0, 10),
        },
        pending_switch: {
          count: 2,
          tasks: pendingSwitch,
        },
        long_running: {
          count: 2,
          tasks: longRunning.slice(0, 2),
        },
        waiting: {
          count: 11,
          tasks: waiting.slice(0, 10),
        },
        total_needs_attention: 27,
      });
    });

    it('returns empty buckets when listTasks is unavailable', async () => {
      const res = createMockRes();

      await withPatchedProperties(mockDb, { listTasks: null }, async () => {
        await handlers.handleStuckTasks(createReq(), res);
      });

      expect(expectSuccess(res)).toEqual({
        pending_approval: { count: 0, tasks: [] },
        pending_switch: { count: 0, tasks: [] },
        long_running: { count: 0, tasks: [] },
        waiting: { count: 0, tasks: [] },
        total_needs_attention: 0,
      });
    });
  });

  describe('handleModelStats', () => {
    it('returns an aggregated model breakdown', async () => {
      const req = createReq({ query: { days: '14' } });
      const res = createMockRes();
      const modelRows = [
        {
          model: 'gpt-5',
          provider: 'codex',
          total: 4,
          task_count: 4,
          completed: 3,
          failed: 1,
          avg_duration_seconds: 10,
          last_used: '2026-03-10T01:00:00.000Z',
        },
        {
          model: 'gpt-5',
          provider: 'openrouter',
          total: 2,
          task_count: 2,
          completed: 2,
          failed: 0,
          avg_duration_seconds: 20,
          last_used: '2026-03-10T03:00:00.000Z',
        },
        {
          model: 'claude-sonnet',
          provider: 'anthropic',
          total: 1,
          task_count: 1,
          completed: 0,
          failed: 1,
          avg_duration_seconds: null,
          last_used: '2026-03-09T08:00:00.000Z',
        },
      ];
      const dailyRows = [
        { model: 'gpt-5', date: '2026-03-10', total: 6, completed: 5, failed: 1 },
      ];
      const all = vi.fn()
        .mockReturnValueOnce(modelRows)
        .mockReturnValueOnce(dailyRows);
      const prepare = vi.fn().mockReturnValue({ all });

      mockDb.getDbInstance.mockReturnValue({ prepare });

      await handlers.handleModelStats(req, res);

      expect(prepare).toHaveBeenCalledWith(expect.stringContaining('GROUP BY model, provider'));
      expect(all).toHaveBeenCalledWith('2026-02-24T12:00:00.000Z');
      const result = expectSuccess(res);
      expect(result.days).toBe(14);
      expect(result.models).toEqual([
        {
          model: 'gpt-5',
          providers: ['codex', 'openrouter'],
          total: 6,
          completed: 5,
          failed: 1,
          avg_duration_seconds: 13.333333333333334,
          last_used: '2026-03-10T03:00:00.000Z',
          _totalDuration: 80,
          _totalCount: 6,
          success_rate: 83,
        },
        {
          model: 'claude-sonnet',
          providers: ['anthropic'],
          total: 1,
          completed: 0,
          failed: 1,
          avg_duration_seconds: null,
          last_used: '2026-03-09T08:00:00.000Z',
          _totalDuration: 0,
          _totalCount: 0,
          success_rate: 0,
        },
      ]);
      expect(result.dailySeries).toEqual(dailyRows);
    });

    it('returns an empty model list when the sql db instance is missing', async () => {
      const res = createMockRes();

      mockDb.getDbInstance.mockReturnValue(null);

      await handlers.handleModelStats(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        models: [],
        days: 7,
      });
    });

    it('returns an empty model list when the sql db has no prepare method', async () => {
      const res = createMockRes();

      mockDb.getDbInstance.mockReturnValue({});

      await handlers.handleModelStats(createReq({ query: { days: '2' } }), res);

      expect(expectSuccess(res)).toEqual({
        models: [],
        days: 2,
      });
    });

    it('returns 500 when the model query throws', async () => {
      const res = createMockRes();

      mockDb.getDbInstance.mockReturnValue({
        prepare() {
          throw new Error('model stats failed');
        },
      });

      await handlers.handleModelStats(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'model stats failed',
      });
    });
  });

  describe('handleFormatSuccess', () => {
    it('returns the format summary', async () => {
      const res = createMockRes();

      mockDb.getFormatSuccessRatesSummary.mockReturnValue([
        { format: 'json', success_rate: 98 },
      ]);

      await handlers.handleFormatSuccess(createReq(), res);

      expect(mockDb.getFormatSuccessRatesSummary).toHaveBeenCalledOnce();
      expect(expectSuccess(res)).toEqual({
        formats: [{ format: 'json', success_rate: 98 }],
      });
    });

    it('returns an empty array when the summary method is unavailable', async () => {
      const res = createMockRes();

      await withPatchedProperties(mockDb, {
        getFormatSuccessRatesSummary: null,
      }, async () => {
        await handlers.handleFormatSuccess(createReq(), res);
      });

      expect(expectSuccess(res)).toEqual({ formats: [] });
    });

    it('returns 500 when the format summary lookup throws', async () => {
      const res = createMockRes();

      mockDb.getFormatSuccessRatesSummary.mockImplementation(() => {
        throw new Error('format summary failed');
      });

      await handlers.handleFormatSuccess(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'format summary failed',
      });
    });
  });

  describe('handleEventHistory', () => {
    it('returns parsed events with the requested limit and filters', async () => {
      const req = createReq({
        query: {
          task_id: 'task-1',
          event_type: 'task.completed',
          limit: '2',
        },
      });
      const res = createMockRes();

      mockEventDispatch.getTaskEvents.mockReturnValue([
        { id: 'ev-1', event_data: '{"ok":true}' },
        { id: 'ev-2', event_data: null },
      ]);

      await handlers.handleEventHistory(req, res);

      expect(mockEventDispatch.getTaskEvents).toHaveBeenCalledWith({
        task_id: 'task-1',
        event_type: 'task.completed',
        limit: 2,
      });
      expect(expectSuccess(res)).toEqual({
        events: [
          { id: 'ev-1', event_data: { ok: true } },
          { id: 'ev-2', event_data: null },
        ],
        count: 2,
      });
    });

    it('maps malformed event_data to null', async () => {
      const res = createMockRes();

      mockEventDispatch.getTaskEvents.mockReturnValue([
        { id: 'ev-bad', event_data: '{not-json' },
      ]);

      await handlers.handleEventHistory(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        events: [{ id: 'ev-bad', event_data: null }],
        count: 1,
      });
    });

    it('clamps the limit to one when a negative value is provided', async () => {
      const res = createMockRes();

      await handlers.handleEventHistory(
        createReq({ query: { limit: '-10' } }),
        res,
      );

      expect(mockEventDispatch.getTaskEvents).toHaveBeenCalledWith({
        task_id: undefined,
        event_type: undefined,
        limit: 1,
      });
      expect(expectSuccess(res).count).toBe(0);
    });

    it('clamps the limit to 1000 when a larger value is provided', async () => {
      const res = createMockRes();

      await handlers.handleEventHistory(
        createReq({ query: { limit: '50000' } }),
        res,
      );

      expect(mockEventDispatch.getTaskEvents).toHaveBeenCalledWith({
        task_id: undefined,
        event_type: undefined,
        limit: 1000,
      });
    });

    it('returns 500 when fetching events throws', async () => {
      const res = createMockRes();

      mockEventDispatch.getTaskEvents.mockImplementation(() => {
        throw new Error('event history failed');
      });

      await handlers.handleEventHistory(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'event history failed',
      });
    });
  });

  describe('handleWebhookStats', () => {
    it('returns webhook stats and the webhook list', async () => {
      const res = createMockRes();

      mockDb.getWebhookStats.mockReturnValue({
        webhooks: { total: 3, active: 2 },
        deliveries_24h: { total: 15, successful: 13, failed: 2 },
      });
      mockDb.listWebhooks.mockReturnValue([
        { id: 'wh-1', enabled: true },
      ]);

      await handlers.handleWebhookStats(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        stats: {
          webhooks: { total: 3, active: 2 },
          deliveries_24h: { total: 15, successful: 13, failed: 2 },
        },
        webhooks: [{ id: 'wh-1', enabled: true }],
      });
    });

    it('uses fallback webhook values when db methods are missing', async () => {
      const res = createMockRes();

      await withPatchedProperties(mockDb, {
        getWebhookStats: null,
        listWebhooks: null,
      }, async () => {
        await handlers.handleWebhookStats(createReq(), res);
      });

      expect(expectSuccess(res)).toEqual({
        stats: {
          webhooks: { total: 0, active: 0 },
          deliveries_24h: { total: 0, successful: 0, failed: 0 },
        },
        webhooks: [],
      });
    });

    it('returns 500 when webhook stats lookup throws', async () => {
      const res = createMockRes();

      mockDb.getWebhookStats.mockImplementation(() => {
        throw new Error('webhook stats failed');
      });

      await handlers.handleWebhookStats(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'webhook stats failed',
      });
    });
  });

  describe('handleNotificationStats', () => {
    it('returns active session details and aggregated metrics', async () => {
      const res = createMockRes();

      mockMcpSse.sessions = new Map([
        ['1234567890abcdef', {
          pendingEvents: [{ id: 1 }, { id: 2 }],
          eventFilter: new Set(['task.updated']),
          taskFilter: new Set(['task-1', 'task-2']),
          res: { writableEnded: false },
        }],
        ['deadbeefcafefeed', {
          pendingEvents: [],
          eventFilter: null,
          taskFilter: null,
          res: { writableEnded: true },
        }],
      ]);
      mockMcpSse.getActiveSessionCount.mockReturnValue(2);
      mockMcpSse.notificationMetrics = { sent: 9, dropped: 1 };

      await handlers.handleNotificationStats(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        active_sessions: 2,
        total_pending_events: 2,
        sessions: [
          {
            id: '12345678',
            pending: 2,
            event_filter: ['task.updated'],
            task_filter_count: 2,
            connected: true,
          },
          {
            id: 'deadbeef',
            pending: 0,
            event_filter: [],
            task_filter_count: 0,
            connected: false,
          },
        ],
        metrics: { sent: 9, dropped: 1 },
      });
    });

    it('returns empty notification stats when the mcp-sse module is unavailable', async () => {
      const res = createMockRes();

      installCjsModuleMock('../mcp-sse', undefined);
      try {
        await handlers.handleNotificationStats(createReq(), res);
      } finally {
        installCjsModuleMock('../mcp-sse', mockMcpSse);
      }

      expect(expectSuccess(res)).toEqual({
        active_sessions: 0,
        total_pending_events: 0,
        sessions: [],
        metrics: {},
      });
    });

    it('returns empty notification stats when reading session data throws', async () => {
      const res = createMockRes();

      mockMcpSse.getActiveSessionCount.mockImplementation(() => {
        throw new Error('mcp unavailable');
      });

      await handlers.handleNotificationStats(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        active_sessions: 0,
        total_pending_events: 0,
        sessions: [],
        metrics: {},
      });
    });
  });

  describe('handleBudgetSummary', () => {
    it('returns cost totals by provider and daily breakdown', async () => {
      const res = createMockRes();

      mockDb.getCostSummary.mockReturnValue([
        { provider: 'codex', task_count: 10, total_cost: 1.25 },
        { provider: 'claude-cli', task_count: 5, total_cost: 0.75 },
      ]);
      mockDb.getCostByPeriod.mockReturnValue([
        { period: '2026-03-09', cost: 0.2 },
        { period: '2026-03-10', cost: 0.3 },
      ]);

      await handlers.handleBudgetSummary(
        createReq({ query: { days: '7' } }),
        res,
      );

      expect(mockDb.getCostSummary).toHaveBeenCalledWith(null, 7);
      expect(mockDb.getCostByPeriod).toHaveBeenCalledWith('day', 7);
      expect(expectSuccess(res)).toEqual({
        total_cost: 2,
        task_count: 15,
        by_provider: {
          codex: 1.25,
          'claude-cli': 0.75,
        },
        daily: [
          { date: '2026-03-10', cost: 0.3 },
          { date: '2026-03-09', cost: 0.2 },
        ],
        days: 7,
      });
    });

    it('uses a default thirty day window and fallback values when cost methods are missing', async () => {
      const res = createMockRes();

      await withPatchedProperties(mockDb, {
        getCostSummary: null,
        getCostByPeriod: null,
      }, async () => {
        await handlers.handleBudgetSummary(
          createReq({ query: { days: 'not-a-number' } }),
          res,
        );
      });

      expect(expectSuccess(res)).toEqual({
        total_cost: 0,
        task_count: 0,
        by_provider: {},
        daily: [],
        days: 30,
      });
    });

    it('clamps zero days to one', async () => {
      const res = createMockRes();

      await handlers.handleBudgetSummary(
        createReq({ query: { days: '0' } }),
        res,
      );

      expect(mockDb.getCostSummary).toHaveBeenCalledWith(null, 1);
      expect(expectSuccess(res).days).toBe(1);
    });

    it('returns 500 when budget summary lookup throws', async () => {
      const res = createMockRes();

      mockDb.getCostSummary.mockImplementation(() => {
        throw new Error('budget summary failed');
      });

      await handlers.handleBudgetSummary(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'budget summary failed',
      });
    });
  });

  describe('handleBudgetStatus', () => {
    it('returns limit, used, and budgets from an array response', async () => {
      const res = createMockRes();

      mockDb.getBudgetStatus.mockReturnValue([
        { id: 'budget-1', budget_usd: 50, current_spend: 12.5 },
        { id: 'budget-2', budget_usd: 10, current_spend: 2.5 },
      ]);

      await handlers.handleBudgetStatus(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        limit: 50,
        used: 12.5,
        budgets: [
          { id: 'budget-1', budget_usd: 50, current_spend: 12.5 },
          { id: 'budget-2', budget_usd: 10, current_spend: 2.5 },
        ],
      });
    });

    it('normalizes a single budget object into an array', async () => {
      const res = createMockRes();

      mockDb.getBudgetStatus.mockReturnValue({
        id: 'budget-1',
        budget_usd: 25,
        current_spend: 5,
      });

      await handlers.handleBudgetStatus(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        limit: 25,
        used: 5,
        budgets: [{
          id: 'budget-1',
          budget_usd: 25,
          current_spend: 5,
        }],
      });
    });

    it('returns zero defaults when the budget status method is missing', async () => {
      const res = createMockRes();

      await withPatchedProperties(mockDb, { getBudgetStatus: null }, async () => {
        await handlers.handleBudgetStatus(createReq(), res);
      });

      expect(expectSuccess(res)).toEqual({
        limit: 0,
        used: 0,
        budgets: [],
      });
    });

    it('returns 500 when loading budget status throws', async () => {
      const res = createMockRes();

      mockDb.getBudgetStatus.mockImplementation(() => {
        throw new Error('budget status failed');
      });

      await handlers.handleBudgetStatus(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'budget status failed',
      });
    });
  });

  describe('handleSetBudget', () => {
    it('returns 400 when budget_usd is missing', async () => {
      const res = createMockRes();

      await handlers.handleSetBudget(
        createReq({ body: {} }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'budget_usd must be a positive number',
      });
      expect(mockDb.setBudget).not.toHaveBeenCalled();
    });

    it('returns 400 when budget_usd is zero or negative', async () => {
      const res = createMockRes();

      await handlers.handleSetBudget(
        createReq({ body: { budget_usd: '-5' } }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'budget_usd must be a positive number',
      });
      expect(mockDb.setBudget).not.toHaveBeenCalled();
    });

    it('parses the body and creates a budget with defaults', async () => {
      const req = createReq({ body: undefined });
      const res = createMockRes();

      mockParseBody.mockResolvedValue({
        budget_usd: '25.5',
      });
      mockDb.setBudget.mockReturnValue({
        id: 'budget-1',
        budget_usd: 25.5,
      });

      await handlers.handleSetBudget(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
      expect(mockDb.setBudget).toHaveBeenCalledWith(
        'Monthly Budget',
        25.5,
        null,
        'monthly',
        80,
      );
      expect(expectSuccess(res, { status: 201 })).toEqual({
        id: 'budget-1',
        budget_usd: 25.5,
      });
    });

    it('uses the provided body and skips parseBody when req.body is present', async () => {
      const res = createMockRes();

      mockDb.setBudget.mockReturnValue({ created: true, id: 'budget-2' });

      await handlers.handleSetBudget(
        createReq({
          body: {
            name: 'Quarterly Budget',
            budget_usd: '100',
            provider: 'codex',
            period: 'quarterly',
            alert_threshold: '90',
          },
        }),
        res,
      );

      expect(mockParseBody).not.toHaveBeenCalled();
      expect(mockDb.setBudget).toHaveBeenCalledWith(
        'Quarterly Budget',
        100,
        'codex',
        'quarterly',
        90,
      );
      expect(expectSuccess(res, { status: 201 })).toEqual({
        created: true,
        id: 'budget-2',
      });
    });

    it('falls back to the default alert threshold when parsing fails', async () => {
      const res = createMockRes();

      await handlers.handleSetBudget(
        createReq({
          body: {
            budget_usd: '15',
            alert_threshold: 'not-a-number',
          },
        }),
        res,
      );

      expect(mockDb.setBudget).toHaveBeenCalledWith(
        'Monthly Budget',
        15,
        null,
        'monthly',
        80,
      );
      expect(expectSuccess(res, { status: 201 })).toEqual({ created: true });
    });

    it('returns 500 when creating a budget throws', async () => {
      const res = createMockRes();

      mockDb.setBudget.mockImplementation(() => {
        throw new Error('set budget failed');
      });

      await handlers.handleSetBudget(
        createReq({ body: { budget_usd: '20' } }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'set budget failed',
      });
    });
  });

  describe('handleStrategicStatus', () => {
    it('returns strategic brain status', async () => {
      const res = createMockRes();

      mockOrchestratorHandlers.getStrategicStatus.mockReturnValue({
        enabled: true,
        recommendations: 4,
      });

      await handlers.handleStrategicStatus(createReq(), res);

      expect(mockOrchestratorHandlers.getStrategicStatus).toHaveBeenCalledOnce();
      expect(expectSuccess(res)).toEqual({
        enabled: true,
        recommendations: 4,
      });
    });

    it('returns 500 when strategic status lookup throws', async () => {
      const res = createMockRes();

      mockOrchestratorHandlers.getStrategicStatus.mockImplementation(() => {
        throw new Error('strategic status failed');
      });

      await handlers.handleStrategicStatus(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'strategic status failed',
      });
    });
  });

  describe('handleRoutingDecisions', () => {
    it('filters tasks down to smart-routed decisions and trims descriptions', async () => {
      const res = createMockRes();
      const longDescription = 'x'.repeat(140);

      mockDb.listTasks.mockReturnValue([
        {
          id: 'task-1',
          created_at: '2026-03-10T01:00:00.000Z',
          provider: 'codex',
          model: 'gpt-5',
          status: 'completed',
          complexity: 'high',
          task_description: longDescription,
          metadata: JSON.stringify({
            smart_routing: true,
            needs_review: true,
            fallback_provider: 'ollama',
          }),
        },
        {
          id: 'task-2',
          created_at: '2026-03-10T02:00:00.000Z',
          provider: 'openrouter',
          model: null,
          status: 'failed',
          task_description: 'secondary',
          metadata: {
            auto_routed: true,
            complexity: 'medium',
            user_provider_override: true,
          },
        },
        {
          id: 'task-3',
          created_at: '2026-03-10T03:00:00.000Z',
          status: 'queued',
          task_description: 'manual route',
          metadata: '{"smart_routing":false}',
        },
        {
          id: 'task-4',
          created_at: '2026-03-10T04:00:00.000Z',
          status: 'queued',
          task_description: 'bad metadata',
          metadata: '{not-json',
        },
      ]);

      await handlers.handleRoutingDecisions(
        createReq({ query: { limit: '2' } }),
        res,
      );

      expect(mockDb.listTasks).toHaveBeenCalledWith({ limit: 6, order: 'desc' });
      expect(expectSuccess(res)).toEqual({
        decisions: [
          {
            task_id: 'task-1',
            created_at: '2026-03-10T01:00:00.000Z',
            complexity: 'high',
            provider: 'codex',
            model: 'gpt-5',
            status: 'completed',
            fallback_used: true,
            needs_review: true,
            description: longDescription.slice(0, 120),
          },
          {
            task_id: 'task-2',
            created_at: '2026-03-10T02:00:00.000Z',
            complexity: 'medium',
            provider: 'openrouter',
            model: null,
            status: 'failed',
            fallback_used: true,
            needs_review: false,
            description: 'secondary',
          },
        ],
      });
    });

    it('accepts the wrapped tasks shape and clamps limit to 200', async () => {
      const res = createMockRes();

      mockDb.listTasks.mockReturnValue({
        tasks: [{
          id: 'task-1',
          created_at: '2026-03-10T01:00:00.000Z',
          provider: 'codex',
          status: 'completed',
          description: 'wrapped',
          metadata: { smart_routing: true },
        }],
      });

      await handlers.handleRoutingDecisions(
        createReq({ query: { limit: '999' } }),
        res,
      );

      expect(mockDb.listTasks).toHaveBeenCalledWith({ limit: 600, order: 'desc' });
      expect(expectSuccess(res)).toEqual({
        decisions: [{
          task_id: 'task-1',
          created_at: '2026-03-10T01:00:00.000Z',
          complexity: 'unknown',
          provider: 'codex',
          model: null,
          status: 'completed',
          fallback_used: false,
          needs_review: false,
          description: 'wrapped',
        }],
      });
    });

    it('returns an empty list when listTasks is unavailable', async () => {
      const res = createMockRes();

      await withPatchedProperties(mockDb, { listTasks: null }, async () => {
        await handlers.handleRoutingDecisions(createReq(), res);
      });

      expect(expectSuccess(res)).toEqual({ decisions: [] });
    });
  });

  describe('handleProviderHealth', () => {
    it('returns health cards for each provider', async () => {
      const res = createMockRes();

      mockDb.listProviders.mockReturnValue([
        { provider: 'codex', enabled: 1 },
        { provider: 'openrouter', enabled: 1 },
        { provider: 'ollama', enabled: 1 },
        { provider: 'disabled-provider', enabled: 0 },
      ]);
      mockDb.getProviderStats.mockImplementation((provider) => {
        if (provider === 'codex') {
          return { total_tasks: 12, successful_tasks: 11, failed_tasks: 1, avg_duration_seconds: 14 };
        }
        if (provider === 'openrouter') {
          return { total_tasks: 8, successful_tasks: 6, failed_tasks: 2, avg_duration_seconds: 18 };
        }
        if (provider === 'ollama') {
          return { total_tasks: 5, successful_tasks: 1, failed_tasks: 4, avg_duration_seconds: 32 };
        }
        return {};
      });
      mockDb.getProviderHealth.mockImplementation((provider) => {
        if (provider === 'codex') {
          return { successes: 10, failures: 0, failureRate: 0 };
        }
        if (provider === 'openrouter') {
          return { successes: 2, failures: 1, failureRate: 1 / 3 };
        }
        if (provider === 'ollama') {
          return { successes: 1, failures: 4, failureRate: 0.8 };
        }
        return { successes: 0, failures: 0, failureRate: 0 };
      });
      mockDb.isProviderHealthy.mockImplementation((provider) => provider !== 'ollama');

      await handlers.handleProviderHealth(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        providers: [
          {
            provider: 'codex',
            enabled: true,
            health_status: 'healthy',
            success_rate_1h: 100,
            successes_1h: 10,
            failures_1h: 0,
            tasks_today: 12,
            completed_today: 11,
            failed_today: 1,
            avg_duration_seconds: 14,
          },
          {
            provider: 'openrouter',
            enabled: true,
            health_status: 'warning',
            success_rate_1h: 67,
            successes_1h: 2,
            failures_1h: 1,
            tasks_today: 8,
            completed_today: 6,
            failed_today: 2,
            avg_duration_seconds: 18,
          },
          {
            provider: 'ollama',
            enabled: true,
            health_status: 'degraded',
            success_rate_1h: 20,
            successes_1h: 1,
            failures_1h: 4,
            tasks_today: 5,
            completed_today: 1,
            failed_today: 4,
            avg_duration_seconds: 32,
          },
          {
            provider: 'disabled-provider',
            enabled: false,
            health_status: 'disabled',
            success_rate_1h: null,
            successes_1h: 0,
            failures_1h: 0,
            tasks_today: 0,
            completed_today: 0,
            failed_today: 0,
            avg_duration_seconds: 0,
          },
        ],
      });
    });

    it('returns an empty provider list when listProviders is unavailable', async () => {
      const res = createMockRes();

      await withPatchedProperties(mockDb, { listProviders: null }, async () => {
        await handlers.handleProviderHealth(createReq(), res);
      });

      expect(expectSuccess(res)).toEqual({ providers: [] });
    });

    it('uses safe defaults when provider health helpers are unavailable', async () => {
      const res = createMockRes();

      mockDb.listProviders.mockReturnValue([{ provider: 'codex', enabled: 1 }]);

      await withPatchedProperties(mockDb, {
        getProviderStats: null,
        getProviderHealth: null,
        isProviderHealthy: null,
      }, async () => {
        await handlers.handleProviderHealth(createReq(), res);
      });

      expect(expectSuccess(res)).toEqual({
        providers: [{
          provider: 'codex',
          enabled: true,
          health_status: 'healthy',
          success_rate_1h: null,
          successes_1h: 0,
          failures_1h: 0,
          tasks_today: 0,
          completed_today: 0,
          failed_today: 0,
          avg_duration_seconds: 0,
        }],
      });
    });
  });

  describe('handleFreeTierStatus', () => {
    it('returns empty providers and a status message', async () => {
      const res = createMockRes();

      await handlers.handleFreeTierStatus(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        providers: {},
        message: 'Free-tier status',
      });
    });

    it('returns 200 even when called with extra query params', async () => {
      const res = createMockRes();

      await handlers.handleFreeTierStatus(
        createReq({ query: { extra: 'ignored' } }),
        res,
      );

      expect(expectSuccess(res)).toEqual({
        providers: {},
        message: 'Free-tier status',
      });
    });
  });

  describe('handleFreeTierHistory', () => {
    it('returns usage history with default seven days', async () => {
      const res = createMockRes();

      mockDb.getUsageHistory.mockReturnValue([
        { date: '2026-03-09', requests: 10 },
        { date: '2026-03-10', requests: 15 },
      ]);

      await handlers.handleFreeTierHistory(createReq(), res);

      expect(mockDb.getUsageHistory).toHaveBeenCalledWith(7);
      expect(expectSuccess(res)).toEqual({
        history: [
          { date: '2026-03-09', requests: 10 },
          { date: '2026-03-10', requests: 15 },
        ],
        days: 7,
      });
    });

    it('respects the days query param and clamps to valid range', async () => {
      const res = createMockRes();

      await handlers.handleFreeTierHistory(
        createReq({ query: { days: '30' } }),
        res,
      );

      expect(mockDb.getUsageHistory).toHaveBeenCalledWith(30);
      expect(expectSuccess(res).days).toBe(30);
    });

    it('clamps days to a minimum of one', async () => {
      const res = createMockRes();

      await handlers.handleFreeTierHistory(
        createReq({ query: { days: '-5' } }),
        res,
      );

      expect(mockDb.getUsageHistory).toHaveBeenCalledWith(1);
      expect(expectSuccess(res).days).toBe(1);
    });

    it('clamps days to a maximum of ninety', async () => {
      const res = createMockRes();

      await handlers.handleFreeTierHistory(
        createReq({ query: { days: '500' } }),
        res,
      );

      expect(mockDb.getUsageHistory).toHaveBeenCalledWith(90);
      expect(expectSuccess(res).days).toBe(90);
    });

    it('returns an empty array when db.getUsageHistory is not a function', async () => {
      const res = createMockRes();

      await withPatchedProperties(mockDb, { getUsageHistory: null }, async () => {
        await handlers.handleFreeTierHistory(createReq(), res);
      });

      expect(expectSuccess(res)).toEqual({
        history: [],
        days: 7,
      });
    });

    it('returns 500 when getUsageHistory throws', async () => {
      const res = createMockRes();

      mockDb.getUsageHistory.mockImplementation(() => {
        throw new Error('history failed');
      });

      await handlers.handleFreeTierHistory(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'history failed',
      });
    });
  });

  describe('handleFreeTierAutoScale', () => {
    it('returns auto-scale config with defaults', async () => {
      const res = createMockRes();

      mockServerConfig.isOptIn.mockReturnValue(false);
      mockServerConfig.getInt.mockImplementation((key, fallback) => fallback);
      mockDb.listTasks.mockReturnValue([]);

      await handlers.handleFreeTierAutoScale(createReq(), res);

      expect(mockServerConfig.isOptIn).toHaveBeenCalledWith('free_tier_auto_scale_enabled');
      expect(mockServerConfig.getInt).toHaveBeenCalledWith('free_tier_queue_depth_threshold', 3);
      expect(mockServerConfig.getInt).toHaveBeenCalledWith('free_tier_cooldown_seconds', 60);
      expect(expectSuccess(res)).toEqual({
        enabled: false,
        queue_depth_threshold: 3,
        cooldown_seconds: 60,
        codex_queue_depth: 0,
      });
    });

    it('counts queued codex tasks correctly', async () => {
      const res = createMockRes();

      mockServerConfig.isOptIn.mockReturnValue(true);
      mockServerConfig.getInt.mockImplementation((key, fallback) => {
        if (key === 'free_tier_queue_depth_threshold') return 5;
        if (key === 'free_tier_cooldown_seconds') return 120;
        return fallback;
      });
      mockDb.listTasks.mockReturnValue([
        { id: 'task-1', provider: 'codex', status: 'queued' },
        { id: 'task-2', provider: 'ollama', status: 'queued' },
        { id: 'task-3', provider: 'codex', status: 'queued' },
      ]);

      await handlers.handleFreeTierAutoScale(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        enabled: true,
        queue_depth_threshold: 5,
        cooldown_seconds: 120,
        codex_queue_depth: 2,
      });
    });

    it('handles wrapped tasks shape from listTasks', async () => {
      const res = createMockRes();

      mockDb.listTasks.mockReturnValue({
        tasks: [
          { id: 'task-1', provider: 'codex', status: 'queued' },
        ],
      });

      await handlers.handleFreeTierAutoScale(createReq(), res);

      expect(expectSuccess(res).codex_queue_depth).toBe(1);
    });

    it('returns 500 when config access throws', async () => {
      const res = createMockRes();

      mockServerConfig.isOptIn.mockImplementation(() => {
        throw new Error('config failed');
      });

      await handlers.handleFreeTierAutoScale(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'config failed',
      });
    });
  });

  describe('handlePrometheusMetrics', () => {
    it('returns prometheus metrics text via tools module', async () => {
      const res = createMockRes();

      mockTools.callTool.mockReturnValue({
        content: [{ text: '# HELP torque_tasks_total\ntorque_tasks_total 42' }],
      });

      await handlers.handlePrometheusMetrics(createReq(), res);

      expect(mockTools.callTool).toHaveBeenCalledWith('export_metrics_prometheus', {});
      expect(expectSuccess(res)).toEqual({
        format: 'prometheus',
        metrics: '# HELP torque_tasks_total\ntorque_tasks_total 42',
      });
    });

    it('returns empty metrics when callTool returns null content', async () => {
      const res = createMockRes();

      mockTools.callTool.mockReturnValue(null);

      await handlers.handlePrometheusMetrics(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        format: 'prometheus',
        metrics: '',
      });
    });

    it('returns empty metrics when content array is empty', async () => {
      const res = createMockRes();

      mockTools.callTool.mockReturnValue({ content: [] });

      await handlers.handlePrometheusMetrics(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        format: 'prometheus',
        metrics: '',
      });
    });

    it('returns 500 when callTool throws', async () => {
      const res = createMockRes();

      mockTools.callTool.mockImplementation(() => {
        throw new Error('metrics export failed');
      });

      await handlers.handlePrometheusMetrics(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'metrics export failed',
      });
    });
  });

  describe('handleStrategicOperations', () => {
    it('returns recent strategic operations with default limit', async () => {
      const res = createMockRes();

      mockDb.getRecentStrategicOperations.mockReturnValue([
        { id: 'op-1', type: 'rebalance', created_at: '2026-03-10T11:00:00.000Z' },
        { id: 'op-2', type: 'scale_up', created_at: '2026-03-10T10:00:00.000Z' },
      ]);

      await handlers.handleStrategicOperations(createReq(), res);

      expect(mockDb.getRecentStrategicOperations).toHaveBeenCalledWith(20);
      const body = res._body;
      expect(body.data.items).toEqual([
        { id: 'op-1', type: 'rebalance', created_at: '2026-03-10T11:00:00.000Z' },
        { id: 'op-2', type: 'scale_up', created_at: '2026-03-10T10:00:00.000Z' },
      ]);
      expect(body.data.total).toBe(2);
    });

    it('respects the limit query param', async () => {
      const res = createMockRes();

      mockDb.getRecentStrategicOperations.mockReturnValue([]);

      await handlers.handleStrategicOperations(
        createReq({ query: { limit: '5' } }),
        res,
      );

      expect(mockDb.getRecentStrategicOperations).toHaveBeenCalledWith(5);
    });

    it('clamps the limit to a minimum of one', async () => {
      const res = createMockRes();

      await handlers.handleStrategicOperations(
        createReq({ query: { limit: '-3' } }),
        res,
      );

      expect(mockDb.getRecentStrategicOperations).toHaveBeenCalledWith(1);
    });

    it('clamps the limit to a maximum of one hundred', async () => {
      const res = createMockRes();

      await handlers.handleStrategicOperations(
        createReq({ query: { limit: '999' } }),
        res,
      );

      expect(mockDb.getRecentStrategicOperations).toHaveBeenCalledWith(100);
    });

    it('returns empty list when db method is not a function', async () => {
      const res = createMockRes();

      await withPatchedProperties(mockDb, { getRecentStrategicOperations: null }, async () => {
        await handlers.handleStrategicOperations(createReq(), res);
      });

      const body = res._body;
      expect(body.data.items).toEqual([]);
      expect(body.data.total).toBe(0);
    });

    it('returns 500 when getRecentStrategicOperations throws', async () => {
      const res = createMockRes();

      mockDb.getRecentStrategicOperations.mockImplementation(() => {
        throw new Error('operations failed');
      });

      await handlers.handleStrategicOperations(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'operations failed',
      });
    });
  });
});
