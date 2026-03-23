'use strict';

const MODULE_PATHS = [
  '../dashboard/routes/analytics',
  '../database',
  '../db/task-core',
  '../db/cost-tracking',
  '../db/event-tracking',
  '../db/file-tracking',
  '../db/provider-routing-core',
  '../db/webhooks-streaming',
  '../db/workflow-engine',
  '../config',
  '../dashboard/utils',
  '../handlers/orchestrator-handlers',
  '../handlers/shared',
  '../hooks/event-dispatch',
  '../mcp-sse',
  '../execution/queue-scheduler',
];

const mockDb = {
  countTasks: vi.fn(),
  getProviderStats: vi.fn(),
  getOverallQualityStats: vi.fn(),
  getQualityStatsByProvider: vi.fn(),
  getValidationFailureRate: vi.fn(),
  listTasks: vi.fn(),
  getDbInstance: vi.fn(),
  getFormatSuccessRatesSummary: vi.fn(),
  getWebhookStats: vi.fn(),
  listWebhooks: vi.fn(),
  listProviders: vi.fn(),
  getProviderHealth: vi.fn(),
  isProviderHealthy: vi.fn(),
  getCostSummary: vi.fn(),
  getCostByPeriod: vi.fn(),
  getBudgetStatus: vi.fn(),
  setBudget: vi.fn(),
  getUsageHistory: vi.fn(),
  listWorkflows: vi.fn(),
  getWorkflowStatus: vi.fn(),
  getWorkflowCostSummary: vi.fn(),
  getWorkflowTasks: vi.fn(),
  getWorkflowHistory: vi.fn(),
};

const mockUtils = {
  sendJson: vi.fn(),
  sendError: vi.fn(),
  parseBody: vi.fn(),
  enrichTaskWithHostName: vi.fn(),
};

const mockConfig = {
  get: vi.fn(),
  getInt: vi.fn(),
};

const mockOrchestratorHandlers = {
  getStrategicStatus: vi.fn(),
};

const mockShared = {
  evaluateWorkflowVisibility: vi.fn(),
  getWorkflowTaskCounts: vi.fn(),
};

const mockEventDispatch = {
  getTaskEvents: vi.fn(),
};

const mockMcpSse = {
  sessions: new Map(),
  getActiveSessionCount: vi.fn(),
  notificationMetrics: {},
};

const mockQueueScheduler = {
  _getLastAutoScaleActivation: vi.fn(),
};

const mockTaskCore = {
  countTasks: mockDb.countTasks,
  listTasks: mockDb.listTasks,
};

const mockCostTracking = {
  getCostSummary: mockDb.getCostSummary,
  getCostByPeriod: mockDb.getCostByPeriod,
  getBudgetStatus: mockDb.getBudgetStatus,
  setBudget: mockDb.setBudget,
  getUsageHistory: mockDb.getUsageHistory,
  getWorkflowCostSummary: mockDb.getWorkflowCostSummary,
};

const mockEventTracking = {
  getFormatSuccessRatesSummary: mockDb.getFormatSuccessRatesSummary,
};

const mockFileTracking = {
  getProviderStats: mockDb.getProviderStats,
  getOverallQualityStats: mockDb.getOverallQualityStats,
  getQualityStatsByProvider: mockDb.getQualityStatsByProvider,
  getValidationFailureRate: mockDb.getValidationFailureRate,
};

const mockProviderRoutingCore = {
  listProviders: mockDb.listProviders,
  getProviderHealth: mockDb.getProviderHealth,
  isProviderHealthy: mockDb.isProviderHealthy,
};

const mockWebhooksStreaming = {
  getWebhookStats: mockDb.getWebhookStats,
  listWebhooks: mockDb.listWebhooks,
};

const mockWorkflowEngine = {
  listWorkflows: mockDb.listWorkflows,
  getWorkflowStatus: mockDb.getWorkflowStatus,
  getWorkflowTasks: mockDb.getWorkflowTasks,
  getWorkflowHistory: mockDb.getWorkflowHistory,
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

function clearLoadedModules() {
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that have not been loaded.
    }
  }
}

function loadAnalytics() {
  clearLoadedModules();
  installMock('../database', mockDb);
  installMock('../db/task-core', mockTaskCore);
  installMock('../db/cost-tracking', mockCostTracking);
  installMock('../db/event-tracking', mockEventTracking);
  installMock('../db/file-tracking', mockFileTracking);
  installMock('../db/provider-routing-core', mockProviderRoutingCore);
  installMock('../db/webhooks-streaming', mockWebhooksStreaming);
  installMock('../db/workflow-engine', mockWorkflowEngine);
  installMock('../config', mockConfig);
  installMock('../dashboard/utils', mockUtils);
  installMock('../handlers/orchestrator-handlers', mockOrchestratorHandlers);
  installMock('../handlers/shared', mockShared);
  installMock('../hooks/event-dispatch', mockEventDispatch);
  installMock('../mcp-sse', mockMcpSse);
  installMock('../execution/queue-scheduler', mockQueueScheduler);
  return require('../dashboard/routes/analytics');
}

function createMockRes() {
  const res = {
    statusCode: null,
    headers: null,
    payload: null,
    body: null,
    writeHead: vi.fn((statusCode, headers) => {
      res.statusCode = statusCode;
      res.headers = headers;
    }),
    end: vi.fn((body) => {
      res.body = body;
    }),
  };
  return res;
}

function countKey(filters = {}) {
  return JSON.stringify({
    provider: filters.provider ?? null,
    from_date: filters.from_date ?? null,
    to_date: filters.to_date ?? null,
    completed_from: filters.completed_from ?? null,
    completed_to: filters.completed_to ?? null,
    status: filters.status ?? null,
    includeArchived: !!filters.includeArchived,
  });
}

function mockCountTasksWithMap(counts) {
  mockDb.countTasks.mockImplementation((filters = {}) => counts[countKey(filters)] ?? 0);
}

function minutesAgo(minutes) {
  return new Date(Date.now() - (minutes * 60 * 1000)).toISOString();
}

function withPatchedProperties(target, patch, callback) {
  const originals = {};
  for (const [key, value] of Object.entries(patch)) {
    originals[key] = target[key];
    target[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      target[key] = value;
    }
  }
}

function resetMockDefaults() {
  mockDb.countTasks.mockReset().mockReturnValue(0);
  mockDb.getProviderStats.mockReset().mockReturnValue({});
  mockDb.getOverallQualityStats.mockReset().mockReturnValue({});
  mockDb.getQualityStatsByProvider.mockReset().mockReturnValue([]);
  mockDb.getValidationFailureRate.mockReset().mockReturnValue({});
  mockDb.listTasks.mockReset().mockReturnValue([]);
  mockDb.getDbInstance.mockReset().mockReturnValue({
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
  });
  mockDb.getFormatSuccessRatesSummary.mockReset().mockReturnValue([]);
  mockDb.getWebhookStats.mockReset().mockReturnValue({
    webhooks: { total: 0, active: 0 },
    deliveries_24h: { total: 0, successful: 0, failed: 0 },
  });
  mockDb.listWebhooks.mockReset().mockReturnValue([]);
  mockDb.listProviders.mockReset().mockReturnValue([]);
  mockDb.getProviderHealth.mockReset().mockReturnValue({
    successes: 0,
    failures: 0,
    failureRate: 0,
  });
  mockDb.isProviderHealthy.mockReset().mockReturnValue(true);
  mockDb.getCostSummary.mockReset().mockReturnValue([]);
  mockDb.getCostByPeriod.mockReset().mockReturnValue([]);
  mockDb.getBudgetStatus.mockReset().mockReturnValue([]);
  mockDb.setBudget.mockReset().mockReturnValue({ id: 'budget-1' });
  mockDb.getUsageHistory.mockReset().mockReturnValue([]);
  mockDb.listWorkflows.mockReset().mockReturnValue([]);
  mockDb.getWorkflowStatus.mockReset().mockReturnValue(null);
  mockDb.getWorkflowCostSummary.mockReset().mockReturnValue({});
  mockDb.getWorkflowTasks.mockReset().mockReturnValue([]);
  mockDb.getWorkflowHistory.mockReset().mockReturnValue([]);

  mockUtils.sendJson.mockReset().mockImplementation((res, payload, statusCode = 200) => {
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

  mockUtils.sendError.mockReset().mockImplementation((res, message, statusCode = 400) => {
    mockUtils.sendJson(res, { error: message }, statusCode);
  });

  mockUtils.parseBody.mockReset().mockResolvedValue({});
  mockUtils.enrichTaskWithHostName.mockReset().mockImplementation((task) => ({
    ...task,
    enriched: true,
  }));

  mockConfig.get.mockReset().mockImplementation((key) => {
    if (key === 'free_tier_auto_scale_enabled') return 'false';
    return undefined;
  });
  mockConfig.getInt.mockReset().mockImplementation((_key, fallback) => fallback);

  mockOrchestratorHandlers.getStrategicStatus.mockReset().mockReturnValue({ mode: 'steady' });

  mockShared.evaluateWorkflowVisibility.mockReset().mockImplementation((workflow) => ({
    label: workflow.status === 'completed' ? 'QUIET' : 'ATTENTION',
  }));
  mockShared.getWorkflowTaskCounts.mockReset().mockImplementation((workflow) => (
    workflow.summary || { total: Object.keys(workflow.tasks || {}).length }
  ));

  mockEventDispatch.getTaskEvents.mockReset().mockReturnValue([]);

  mockMcpSse.sessions = new Map();
  mockMcpSse.getActiveSessionCount.mockReset().mockReturnValue(0);
  mockMcpSse.notificationMetrics = {};

  mockQueueScheduler._getLastAutoScaleActivation.mockReset().mockReturnValue(0);
}

describe('dashboard analytics route handlers', () => {
  let analytics;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    vi.restoreAllMocks();
    resetMockDefaults();
    analytics = loadAnalytics();
  });

  afterEach(() => {
    clearLoadedModules();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('stats handlers', () => {
    it('handleStatsOverview returns dashboard totals and SSE notification counts', () => {
      const counts = {
        [countKey({ completed_from: '2026-03-10', completed_to: '2026-03-11', status: 'completed' })]: 4,
        [countKey({ completed_from: '2026-03-10', completed_to: '2026-03-11', status: 'failed' })]: 1,
        [countKey({ from_date: '2026-03-10', to_date: '2026-03-11', status: 'running' })]: 2,
        [countKey({ completed_from: '2026-03-09', completed_to: '2026-03-10', status: 'completed' })]: 3,
        [countKey({ completed_from: '2026-03-09', completed_to: '2026-03-10', status: 'failed' })]: 1,
        [countKey({ status: 'running' })]: 7,
        [countKey({ status: 'queued' })]: 5,
        [countKey({ status: 'pending_provider_switch' })]: 2,
        [countKey({ status: 'completed' })]: 40,
        [countKey({ status: 'failed' })]: 6,
        [countKey({ status: 'cancelled' })]: 9,
      };
      mockCountTasksWithMap(counts);
      mockDb.getProviderStats
        .mockReturnValueOnce({ total_tasks: 10, success_rate: 90 })
        .mockReturnValueOnce({ total_tasks: 5, success_rate: 60 });
      mockMcpSse.getActiveSessionCount.mockReturnValue(2);
      mockMcpSse.sessions = new Map([
        ['session-12345678', { pendingEvents: [{}, {}] }],
        ['session-abcdef12', { pendingEvents: [{}] }],
      ]);

      const res = createMockRes();
      analytics.handleStatsOverview({}, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({
        today: {
          total: 7,
          completed: 4,
          failed: 1,
          successRate: 80,
        },
        yesterday: {
          total: 4,
        },
        active: {
          running: 7,
          queued: 5,
          pendingSwitch: 2,
        },
        totals: {
          running: 7,
          queued: 5,
          completed: 40,
          failed: 6,
          cancelled: 9,
          pending_provider_switch: 2,
        },
        notifications: {
          sseSubscribers: 2,
          pendingEvents: 3,
        },
        providers: {
          codex: { total_tasks: 10, success_rate: 90 },
          'claude-cli': { total_tasks: 5, success_rate: 60 },
        },
      });
    });

    it('handleTimeSeries applies provider filter and computes success rates', () => {
      const counts = {
        [countKey({ provider: 'codex', completed_from: '2026-03-08', completed_to: '2026-03-09', status: 'completed', includeArchived: true })]: 2,
        [countKey({ provider: 'codex', completed_from: '2026-03-08', completed_to: '2026-03-09', status: 'failed', includeArchived: true })]: 1,
        [countKey({ provider: 'codex', completed_from: '2026-03-09', completed_to: '2026-03-10', status: 'completed', includeArchived: true })]: 0,
        [countKey({ provider: 'codex', completed_from: '2026-03-09', completed_to: '2026-03-10', status: 'failed', includeArchived: true })]: 0,
        [countKey({ provider: 'codex', completed_from: '2026-03-10', completed_to: '2026-03-11', status: 'completed', includeArchived: true })]: 3,
        [countKey({ provider: 'codex', completed_from: '2026-03-10', completed_to: '2026-03-11', status: 'failed', includeArchived: true })]: 1,
      };
      mockCountTasksWithMap(counts);

      const res = createMockRes();
      analytics.handleTimeSeries({}, res, { days: '3', provider: 'codex' });

      expect(res.payload).toEqual([
        { date: '2026-03-08', total: 3, completed: 2, failed: 1, successRate: 67 },
        { date: '2026-03-09', total: 0, completed: 0, failed: 0, successRate: 0 },
        { date: '2026-03-10', total: 4, completed: 3, failed: 1, successRate: 75 },
      ]);
    });

    it('handleTimeSeries clamps invalid day values to the allowed range', () => {
      const res = createMockRes();
      analytics.handleTimeSeries({}, res, { days: '0' });
      expect(res.payload).toHaveLength(1);
    });

    it('handleQualityStats defaults hours to 24 and forwards the since timestamp to DB helpers', () => {
      mockDb.getOverallQualityStats.mockReturnValue({ average_score: 93 });
      mockDb.getQualityStatsByProvider.mockReturnValue([{ provider: 'codex', average_score: 95 }]);
      mockDb.getValidationFailureRate.mockReturnValue({ failures: 2, rate: 0.1 });

      const res = createMockRes();
      analytics.handleQualityStats({}, res, { hours: '0' });

      expect(mockDb.getOverallQualityStats).toHaveBeenCalledWith('2026-03-09T12:00:00.000Z');
      expect(mockDb.getQualityStatsByProvider).toHaveBeenCalledWith('2026-03-09T12:00:00.000Z');
      expect(mockDb.getValidationFailureRate).toHaveBeenCalledWith('2026-03-09T12:00:00.000Z');
      expect(res.payload).toEqual({
        period: { hours: 24, since: '2026-03-09T12:00:00.000Z' },
        overall: { average_score: 93 },
        byProvider: [{ provider: 'codex', average_score: 95 }],
        validation: { failures: 2, rate: 0.1 },
      });
    });

    it('handleStuckTasks filters stale tasks and caps each list at 10 items', () => {
      const waitingTasks = Array.from({ length: 12 }, (_unused, index) => ({
        id: `waiting-${index + 1}`,
        status: 'waiting',
        created_at: minutesAgo(2),
      }));
      mockDb.listTasks.mockImplementation(({ status }) => {
        if (status === 'pending_approval') {
          return [
            { id: 'approval-old', status, created_at: minutesAgo(20) },
            { id: 'approval-fresh', status, created_at: minutesAgo(5) },
          ];
        }
        if (status === 'pending_provider_switch') {
          return [
            { id: 'switch-old', status, created_at: minutesAgo(5), provider_switched_at: minutesAgo(16) },
            { id: 'switch-fresh', status, created_at: minutesAgo(2) },
          ];
        }
        if (status === 'running') {
          return [
            { id: 'running-old', status, started_at: minutesAgo(45), created_at: minutesAgo(45) },
            { id: 'running-fresh', status, started_at: minutesAgo(10), created_at: minutesAgo(10) },
          ];
        }
        if (status === 'waiting') return waitingTasks;
        return [];
      });

      const res = createMockRes();
      analytics.handleStuckTasks({}, res, {});

      expect(res.payload.pendingApproval.count).toBe(1);
      expect(res.payload.pendingApproval.tasks[0].id).toBe('approval-old');
      expect(res.payload.pendingSwitch.count).toBe(1);
      expect(res.payload.pendingSwitch.tasks[0].id).toBe('switch-old');
      expect(res.payload.longRunning.count).toBe(1);
      expect(res.payload.longRunning.tasks[0].id).toBe('running-old');
      expect(res.payload.waiting.count).toBe(12);
      expect(res.payload.waiting.tasks).toHaveLength(10);
      expect(res.payload.totalNeedsAttention).toBe(15);
    });

    it('handleModelStats aggregates provider rows by model and preserves the daily series', () => {
      const prepare = vi.fn();
      prepare
        .mockReturnValueOnce({
          all: vi.fn().mockReturnValue([
            {
              model: 'gpt-5',
              provider: 'codex',
              total: 3,
              completed: 2,
              failed: 1,
              avg_duration_seconds: 10,
              total_cost: 1.5,
              last_used: '2026-03-10T10:00:00.000Z',
            },
            {
              model: 'gpt-5',
              provider: 'groq',
              total: 1,
              completed: 1,
              failed: 0,
              avg_duration_seconds: 30,
              total_cost: 0.5,
              last_used: '2026-03-10T11:00:00.000Z',
            },
            {
              model: 'claude-4',
              provider: 'claude-cli',
              total: 2,
              completed: 1,
              failed: 1,
              avg_duration_seconds: null,
              total_cost: 0.2,
              last_used: '2026-03-09T09:00:00.000Z',
            },
          ]),
        })
        .mockReturnValueOnce({
          all: vi.fn().mockReturnValue([
            { model: 'gpt-5', date: '2026-03-09', total: 2, completed: 1, failed: 1 },
            { model: 'gpt-5', date: '2026-03-10', total: 2, completed: 2, failed: 0 },
          ]),
        });
      mockDb.getDbInstance.mockReturnValue({ prepare });

      const res = createMockRes();
      analytics.handleModelStats({}, res, { days: '3' });

      expect(res.payload.days).toBe(3);
      expect(res.payload.dailySeries).toEqual([
        { model: 'gpt-5', date: '2026-03-09', total: 2, completed: 1, failed: 1 },
        { model: 'gpt-5', date: '2026-03-10', total: 2, completed: 2, failed: 0 },
      ]);
      expect(res.payload.models).toEqual(expect.arrayContaining([
        {
          model: 'gpt-5',
          providers: ['codex', 'groq'],
          total: 4,
          completed: 3,
          failed: 1,
          avg_duration_seconds: 20,
          total_cost: 2,
          last_used: '2026-03-10T11:00:00.000Z',
          success_rate: 75,
        },
        {
          model: 'claude-4',
          providers: ['claude-cli'],
          total: 2,
          completed: 1,
          failed: 1,
          avg_duration_seconds: null,
          total_cost: 0.2,
          last_used: '2026-03-09T09:00:00.000Z',
          success_rate: 50,
        },
      ]));
    });

    it('handleModelStats returns an error payload when the DB query fails', () => {
      mockDb.getDbInstance.mockImplementation(() => {
        throw new Error('sql offline');
      });

      const res = createMockRes();
      analytics.handleModelStats({}, res, { days: 'n/a' });

      expect(res.payload).toEqual({
        models: [],
        dailySeries: [],
        days: 7,
        error: 'sql offline',
      });
    });

    it('handleFormatSuccess returns the DB summary', () => {
      mockDb.getFormatSuccessRatesSummary.mockReturnValue([{ format: 'markdown', success_rate: 0.98 }]);

      const res = createMockRes();
      analytics.handleFormatSuccess({}, res);

      expect(res.payload).toEqual([{ format: 'markdown', success_rate: 0.98 }]);
    });

    it('handleFormatSuccess falls back to an empty array on query failure', () => {
      mockDb.getFormatSuccessRatesSummary.mockImplementation(() => {
        throw new Error('summary unavailable');
      });

      const res = createMockRes();
      analytics.handleFormatSuccess({}, res);

      expect(res.payload).toEqual([]);
    });

    it('handleNotificationStats returns session details and metrics', () => {
      mockMcpSse.getActiveSessionCount.mockReturnValue(2);
      mockMcpSse.notificationMetrics = { sent: 9 };
      mockMcpSse.sessions = new Map([
        ['sess-1--12345678', {
          pendingEvents: [{}, {}, {}],
          eventFilter: new Set(['task.updated']),
          taskFilter: new Set(['task-1', 'task-2']),
          res: { writableEnded: false },
        }],
        ['sess-a--abcdef12', {
          pendingEvents: [],
          eventFilter: null,
          taskFilter: new Set(),
          res: { writableEnded: true },
        }],
      ]);

      const res = createMockRes();
      analytics.handleNotificationStats({}, res);

      expect(res.payload).toEqual({
        activeSessions: 2,
        totalPendingEvents: 3,
        sessions: [
          {
            id: 'sess-1--',
            pending: 3,
            eventFilter: ['task.updated'],
            taskFilter: 2,
            connected: true,
          },
          {
            id: 'sess-a--',
            pending: 0,
            eventFilter: [],
            taskFilter: 0,
            connected: false,
          },
        ],
        metrics: { sent: 9 },
      });
    });

    it('handleNotificationStats returns a safe fallback payload on error', () => {
      mockMcpSse.getActiveSessionCount.mockImplementation(() => {
        throw new Error('sse unavailable');
      });

      const res = createMockRes();
      analytics.handleNotificationStats({}, res);

      expect(res.payload).toEqual({
        activeSessions: 0,
        totalPendingEvents: 0,
        sessions: [],
        metrics: {},
        error: 'sse unavailable',
      });
    });

    it('handleEventHistory parses event_data and clamps the limit', () => {
      mockEventDispatch.getTaskEvents.mockReturnValue([
        { id: 'event-1', event_data: '{"kind":"ok"}' },
        { id: 'event-2', event_data: '{invalid' },
        { id: 'event-3', event_data: null },
      ]);

      const res = createMockRes();
      analytics.handleEventHistory({}, res, { task_id: 'task-1', event_type: 'updated', limit: '5000' });

      expect(mockEventDispatch.getTaskEvents).toHaveBeenCalledWith({
        task_id: 'task-1',
        event_type: 'updated',
        limit: 1000,
      });
      expect(res.payload).toEqual({
        events: [
          { id: 'event-1', event_data: { kind: 'ok' } },
          { id: 'event-2', event_data: null },
          { id: 'event-3', event_data: null },
        ],
        count: 3,
      });
    });

    it('handleEventHistory returns an empty payload on dispatch failure', () => {
      mockEventDispatch.getTaskEvents.mockImplementation(() => {
        throw new Error('event store offline');
      });

      const res = createMockRes();
      analytics.handleEventHistory({}, res, {});

      expect(res.payload).toEqual({
        events: [],
        count: 0,
        error: 'event store offline',
      });
    });

    it('handleWebhookStats returns stats and webhook definitions', () => {
      mockDb.getWebhookStats.mockReturnValue({
        webhooks: { total: 2, active: 1 },
        deliveries_24h: { total: 10, successful: 8, failed: 2 },
      });
      mockDb.listWebhooks.mockReturnValue([{ id: 'webhook-1' }]);

      const res = createMockRes();
      analytics.handleWebhookStats({}, res);

      expect(res.payload).toEqual({
        stats: {
          webhooks: { total: 2, active: 1 },
          deliveries_24h: { total: 10, successful: 8, failed: 2 },
        },
        webhooks: [{ id: 'webhook-1' }],
      });
    });

    it('handleWebhookStats falls back to zeroed stats when helpers are unavailable', () => {
      withPatchedProperties(mockDb, {
        getWebhookStats: undefined,
        listWebhooks: undefined,
      }, () => {
        const res = createMockRes();
        analytics.handleWebhookStats({}, res);

        expect(res.payload).toEqual({
          stats: {
            webhooks: { total: 0, active: 0 },
            deliveries_24h: { total: 0, successful: 0, failed: 0 },
          },
          webhooks: [],
        });
      });
    });

    it('getProviderTimeSeries returns archived per-day counts for a provider', () => {
      const counts = {
        [countKey({ provider: 'claude-cli', completed_from: '2026-03-09', completed_to: '2026-03-10', status: 'completed', includeArchived: true })]: 1,
        [countKey({ provider: 'claude-cli', completed_from: '2026-03-09', completed_to: '2026-03-10', status: 'failed', includeArchived: true })]: 2,
        [countKey({ provider: 'claude-cli', completed_from: '2026-03-10', completed_to: '2026-03-11', status: 'completed', includeArchived: true })]: 4,
        [countKey({ provider: 'claude-cli', completed_from: '2026-03-10', completed_to: '2026-03-11', status: 'failed', includeArchived: true })]: 0,
      };
      mockCountTasksWithMap(counts);

      expect(analytics.getProviderTimeSeries('claude-cli', 2)).toEqual([
        { date: '2026-03-09', total: 3, completed: 1, failed: 2 },
        { date: '2026-03-10', total: 4, completed: 4, failed: 0 },
      ]);
    });
  });

  describe('strategic handlers', () => {
    it('handleGetStrategicStatus proxies the orchestrator strategic status', () => {
      mockOrchestratorHandlers.getStrategicStatus.mockReturnValue({ mode: 'autonomous', ready: true });

      const res = createMockRes();
      analytics.handleGetStrategicStatus({}, res);

      expect(res.payload).toEqual({ mode: 'autonomous', ready: true });
    });

    it('handleGetRecentOperations filters recent strategic tasks and respects the limit', () => {
      mockDb.listTasks.mockReturnValue([
        { id: 'task-1', description: 'Strategic review for queue fairness' },
        { id: 'task-2', description: 'decompose the release workflow' },
        { id: 'task-3', description: 'plain task with no keywords' },
        { id: 'task-4', description: 'diagnose provider fallback' },
      ]);

      const res = createMockRes();
      analytics.handleGetRecentOperations({}, res, { limit: '2' });

      expect(mockDb.listTasks).toHaveBeenCalledWith({ limit: 2, order: 'desc' });
      expect(res.payload).toEqual({
        operations: [
          { id: 'task-1', description: 'Strategic review for queue fairness' },
          { id: 'task-2', description: 'decompose the release workflow' },
        ],
      });
    });

    it('handleGetRoutingDecisions extracts routed task metadata from listTasks results', () => {
      mockDb.listTasks.mockReturnValue({
        tasks: [
          {
            id: 'task-1',
            created_at: '2026-03-10T09:00:00.000Z',
            provider: 'codex',
            model: 'gpt-5',
            status: 'completed',
            description: 'A'.repeat(200),
            metadata: JSON.stringify({ smart_routing: true, needs_review: true }),
          },
          {
            id: 'task-2',
            created_at: '2026-03-10T08:00:00.000Z',
            provider: 'groq',
            model: null,
            status: 'failed',
            description: 'Fallback candidate',
            complexity: 'complex',
            metadata: { auto_routed: true, fallback_provider: 'codex', split_advisory: true },
          },
          {
            id: 'task-3',
            created_at: '2026-03-10T07:00:00.000Z',
            provider: 'ollama',
            model: 'qwen',
            status: 'completed',
            description: 'Invalid metadata',
            metadata: '{broken',
          },
        ],
      });

      const res = createMockRes();
      analytics.handleGetRoutingDecisions({}, res, { limit: '5' });

      expect(res.payload).toEqual({
        decisions: [
          {
            task_id: 'task-1',
            created_at: '2026-03-10T09:00:00.000Z',
            complexity: 'unknown',
            provider: 'codex',
            model: 'gpt-5',
            status: 'completed',
            fallback_used: false,
            needs_review: true,
            split_advisory: false,
            description: 'A'.repeat(120),
          },
          {
            task_id: 'task-2',
            created_at: '2026-03-10T08:00:00.000Z',
            complexity: 'complex',
            provider: 'groq',
            model: null,
            status: 'failed',
            fallback_used: true,
            needs_review: false,
            split_advisory: true,
            description: 'Fallback candidate',
          },
        ],
      });
    });

    it('handleGetProviderHealth derives health cards from provider stats and in-memory health', () => {
      mockDb.listProviders.mockReturnValue([
        { provider: 'codex', enabled: 1 },
        { provider: 'groq', enabled: 1 },
        { provider: 'ollama', enabled: 1 },
        { provider: 'deepinfra', enabled: 0 },
      ]);
      mockDb.getProviderStats.mockImplementation((provider) => ({
        codex: { total_tasks: 12, successful_tasks: 10, failed_tasks: 2, avg_duration_seconds: 11 },
        groq: { total_tasks: 8, successful_tasks: 6, failed_tasks: 2, avg_duration_seconds: 7 },
        ollama: { total_tasks: 4, successful_tasks: 1, failed_tasks: 3, avg_duration_seconds: 20 },
        deepinfra: { total_tasks: 0, successful_tasks: 0, failed_tasks: 0, avg_duration_seconds: 0 },
      }[provider]));
      mockDb.getProviderHealth.mockImplementation((provider) => ({
        codex: { successes: 9, failures: 0, failureRate: 0 },
        groq: { successes: 8, failures: 2, failureRate: 0.2 },
        ollama: { successes: 1, failures: 3, failureRate: 0.75 },
        deepinfra: { successes: 0, failures: 0, failureRate: 0 },
      }[provider]));
      mockDb.isProviderHealthy.mockImplementation((provider) => provider !== 'ollama');

      const res = createMockRes();
      analytics.handleGetProviderHealth({}, res);

      expect(res.payload).toEqual({
        providers: [
          {
            provider: 'codex',
            enabled: true,
            health_status: 'healthy',
            success_rate_1h: 100,
            successes_1h: 9,
            failures_1h: 0,
            tasks_today: 12,
            completed_today: 10,
            failed_today: 2,
            avg_duration_seconds: 11,
          },
          {
            provider: 'groq',
            enabled: true,
            health_status: 'warning',
            success_rate_1h: 80,
            successes_1h: 8,
            failures_1h: 2,
            tasks_today: 8,
            completed_today: 6,
            failed_today: 2,
            avg_duration_seconds: 7,
          },
          {
            provider: 'ollama',
            enabled: true,
            health_status: 'degraded',
            success_rate_1h: 25,
            successes_1h: 1,
            failures_1h: 3,
            tasks_today: 4,
            completed_today: 1,
            failed_today: 3,
            avg_duration_seconds: 20,
          },
          {
            provider: 'deepinfra',
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
  });

  describe('finance handlers', () => {
    it('handleBudgetSummary aggregates provider totals and reverses daily rows for chart output', () => {
      mockDb.getCostSummary.mockReturnValue([
        { provider: 'codex', task_count: 10, total_cost: 1.2 },
        { provider: 'claude-cli', task_count: 4, total_cost: 0.8 },
      ]);
      mockDb.getCostByPeriod.mockReturnValue([
        { period: '2026-03-08', cost: 0.25 },
        { period: '2026-03-09', cost: 0.5 },
      ]);

      const res = createMockRes();
      analytics.handleBudgetSummary({}, res, { days: '7' });

      expect(res.payload).toEqual({
        total_cost: 2,
        task_count: 14,
        by_provider: {
          codex: 1.2,
          'claude-cli': 0.8,
        },
        daily: [
          { date: '2026-03-09', cost: 0.5 },
          { date: '2026-03-08', cost: 0.25 },
        ],
      });
    });

    it('handleBudgetSummary falls back to SQL daily aggregation when period rows are unavailable', () => {
      mockDb.getCostSummary.mockReturnValue([{ provider: 'codex', task_count: 3, total_cost: 0.9 }]);
      mockDb.getCostByPeriod.mockReturnValue([]);
      mockDb.getDbInstance.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([
            { date: '2026-03-09', cost: 0.4 },
            { date: '2026-03-10', cost: 0.5 },
          ]),
        }),
      });

      const res = createMockRes();
      analytics.handleBudgetSummary({}, res, { days: '7' });

      expect(res.payload.daily).toEqual([
        { date: '2026-03-09', cost: 0.4 },
        { date: '2026-03-10', cost: 0.5 },
      ]);
    });

    it('handleBudgetStatus normalizes a single budget object into the expected payload', () => {
      mockDb.getBudgetStatus.mockReturnValue({
        id: 'budget-1',
        budget_usd: 50,
        current_spend: 12.5,
      });

      const res = createMockRes();
      analytics.handleBudgetStatus({}, res);

      expect(res.payload).toEqual({
        limit: 50,
        used: 12.5,
        budgets: [
          {
            id: 'budget-1',
            budget_usd: 50,
            current_spend: 12.5,
          },
        ],
      });
    });

    it('handleSetBudget rejects invalid budget_usd values', async () => {
      mockUtils.parseBody.mockResolvedValue({ budget_usd: '0' });

      const res = createMockRes();
      await analytics.handleSetBudget({}, res);

      expect(mockDb.setBudget).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ error: 'budget_usd must be a positive number' });
    });

    it('handleSetBudget creates a budget using defaults when optional fields are omitted', async () => {
      mockUtils.parseBody.mockResolvedValue({ budget_usd: '25.5' });
      mockDb.setBudget.mockReturnValue({ id: 'budget-42', created: true });

      const res = createMockRes();
      await analytics.handleSetBudget({}, res);

      expect(mockDb.setBudget).toHaveBeenCalledWith('Monthly Budget', 25.5, null, 'monthly', 80);
      expect(res.statusCode).toBe(201);
      expect(res.payload).toEqual({ id: 'budget-42', created: true });
    });

    it('handleFreeTierStatus returns a not-initialized response when no tracker getter is configured', () => {
      const res = createMockRes();
      analytics.handleFreeTierStatus({}, res);

      expect(res.payload).toEqual({
        status: 'ok',
        providers: {},
        message: 'FreeQuotaTracker not initialized',
      });
    });

    it('handleFreeTierStatus returns tracker state when a getter is configured', () => {
      analytics.setFreeTierTrackerGetter(() => ({
        getStatus: () => ({ codex: { remaining: 42 } }),
      }));

      const res = createMockRes();
      analytics.handleFreeTierStatus({}, res);

      expect(res.payload).toEqual({
        status: 'ok',
        providers: {
          codex: { remaining: 42 },
        },
      });
    });

    it('handleFreeTierHistory clamps the day range before loading history', () => {
      mockDb.getUsageHistory.mockReturnValue([{ day: '2026-03-10', tokens: 100 }]);

      const res = createMockRes();
      analytics.handleFreeTierHistory({}, res, { days: '999' });

      expect(mockDb.getUsageHistory).toHaveBeenCalledWith(90);
      expect(res.payload).toEqual({
        status: 'ok',
        history: [{ day: '2026-03-10', tokens: 100 }],
      });
    });

    it('handleFreeTierHistory returns a 500 payload on DB errors', () => {
      mockDb.getUsageHistory.mockImplementation(() => {
        throw new Error('usage history unavailable');
      });

      const res = createMockRes();
      analytics.handleFreeTierHistory({}, res, { days: '7' });

      expect(res.statusCode).toBe(500);
      expect(res.payload).toEqual({ error: 'usage history unavailable' });
    });

    it('handleFreeTierAutoScale returns queue depth, config values, and the last activation timestamp', () => {
      mockConfig.get.mockImplementation((key) => {
        if (key === 'free_tier_auto_scale_enabled') return 'true';
        return undefined;
      });
      mockConfig.getInt.mockImplementation((key) => ({
        free_tier_queue_depth_threshold: 5,
        free_tier_cooldown_seconds: 120,
      }[key]));
      mockDb.listTasks.mockReturnValue({
        tasks: [
          { id: 'task-1', provider: 'codex' },
          { id: 'task-2', provider: 'codex' },
          { id: 'task-3', provider: 'groq' },
        ],
      });
      mockQueueScheduler._getLastAutoScaleActivation.mockReturnValue(Date.parse('2026-03-10T11:00:00.000Z'));

      const res = createMockRes();
      analytics.handleFreeTierAutoScale({}, res);

      expect(res.payload).toEqual({
        status: 'ok',
        auto_scale: {
          enabled: true,
          queue_depth_threshold: 5,
          cooldown_seconds: 120,
          current_codex_queue_depth: 2,
          last_activation: '2026-03-10T11:00:00.000Z',
        },
      });
    });

    it('handleFreeTierAutoScale returns a 500 payload when config access fails', () => {
      mockConfig.get.mockImplementation(() => {
        throw new Error('config unavailable');
      });

      const res = createMockRes();
      analytics.handleFreeTierAutoScale({}, res);

      expect(res.statusCode).toBe(500);
      expect(res.payload).toEqual({ error: 'config unavailable' });
    });
  });

  describe('workflow handlers', () => {
    it('handleListWorkflows forwards filters and enriches each workflow with visibility data', () => {
      mockDb.listWorkflows.mockReturnValue([
        { id: 'wf-1', status: 'completed', summary: { total: 1, completed: 1 } },
        { id: 'wf-2', status: 'running', summary: { total: 2, running: 1 } },
      ]);
      mockDb.getWorkflowStatus
        .mockReturnValueOnce({
          id: 'wf-1',
          status: 'completed',
          summary: { total: 1, completed: 1 },
          tasks: { a: { id: 'a' } },
        })
        .mockReturnValueOnce(null);

      const res = createMockRes();
      analytics.handleListWorkflows({}, res, {
        status: 'completed',
        limit: '5',
        since: '2026-03-01T00:00:00.000Z',
      });

      expect(mockDb.listWorkflows).toHaveBeenCalledWith({
        status: 'completed',
        limit: 5,
        since: '2026-03-01T00:00:00.000Z',
      });
      expect(res.payload).toEqual([
        {
          id: 'wf-1',
          status: 'completed',
          summary: { total: 1, completed: 1 },
          tasks: { a: { id: 'a' } },
          task_counts: { total: 1, completed: 1 },
          visibility: { label: 'QUIET' },
        },
        {
          id: 'wf-2',
          status: 'running',
          summary: { total: 2, running: 1 },
          task_counts: { total: 2, running: 1 },
          visibility: { label: 'ATTENTION' },
        },
      ]);
    });

    it('handleGetWorkflow returns a 404 error when the workflow is missing', () => {
      mockDb.getWorkflowStatus.mockReturnValue(null);

      const res = createMockRes();
      analytics.handleGetWorkflow({}, res, {}, 'wf-missing');

      expect(mockUtils.sendError).toHaveBeenCalledWith(res, 'Workflow not found', 404);
      expect(res.statusCode).toBe(404);
      expect(res.payload).toEqual({ error: 'Workflow not found' });
    });

    it('handleGetWorkflow merges visibility and cost data for a found workflow', () => {
      mockDb.getWorkflowStatus.mockReturnValue({
        id: 'wf-9',
        status: 'completed',
        summary: { total: 2, completed: 2 },
        tasks: { a: { id: 'a' }, b: { id: 'b' } },
      });
      mockDb.getWorkflowCostSummary.mockReturnValue({ total_cost: 1.25 });

      const res = createMockRes();
      analytics.handleGetWorkflow({}, res, {}, 'wf-9');

      expect(res.payload).toEqual({
        id: 'wf-9',
        status: 'completed',
        summary: { total: 2, completed: 2 },
        tasks: { a: { id: 'a' }, b: { id: 'b' } },
        task_counts: { total: 2, completed: 2 },
        visibility: { label: 'QUIET' },
        cost: { total_cost: 1.25 },
      });
    });

    it('handleGetWorkflowTasks returns the workflow task list', () => {
      mockDb.getWorkflowTasks.mockReturnValue([{ id: 'task-1' }, { id: 'task-2' }]);

      const res = createMockRes();
      analytics.handleGetWorkflowTasks({}, res, {}, 'wf-1');

      expect(res.payload).toEqual([{ id: 'task-1' }, { id: 'task-2' }]);
    });

    it('handleGetWorkflowHistory returns the workflow history', () => {
      mockDb.getWorkflowHistory.mockReturnValue([{ at: '2026-03-10T10:00:00.000Z', status: 'completed' }]);

      const res = createMockRes();
      analytics.handleGetWorkflowHistory({}, res, {}, 'wf-1');

      expect(res.payload).toEqual([{ at: '2026-03-10T10:00:00.000Z', status: 'completed' }]);
    });
  });
});
