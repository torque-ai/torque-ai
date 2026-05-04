'use strict';

const HANDLER_MODULE = '../api/v2-governance-handlers';
const CONTROL_PLANE_MODULE = '../api/v2-control-plane';
const MODULE_PATHS = [
  HANDLER_MODULE,
  CONTROL_PLANE_MODULE,
  '../api/middleware',
  '../database',
  '../db/config-core',
  '../db/file-tracking',
  '../db/host-management',
  '../db/provider/routing-core',
  '../db/task-core',
];

const mockDb = {
  getBenchmarkResults: vi.fn(),
  getBenchmarkStats: vi.fn(),
  applyBenchmarkResults: vi.fn(),
  listProjectTuning: vi.fn(),
  setProjectTuning: vi.fn(),
  deleteProjectTuning: vi.fn(),
  getProviderStats: vi.fn(),
  getProvider: vi.fn(),
  updateProvider: vi.fn(),
  listProviders: vi.fn(),
  countTasks: vi.fn(),
  getProviderDailyCounts: vi.fn(),
  getConfig: vi.fn(),
};

const mockParseBody = vi.fn();
const mockSendJson = vi.fn();
const mockMiddleware = {
  parseBody: mockParseBody,
  sendJson: mockSendJson,
};

const mockTaskManager = {
  getMcpInstanceId: vi.fn(),
};

const SECURITY_WARNING_MESSAGE = 'TORQUE is running without authentication. Run configure to set an API key.';

vi.mock('../database', () => mockDb);
vi.mock('../api/middleware', () => mockMiddleware);

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
  installCjsModuleMock('../db/config-core', mockDb);
  installCjsModuleMock('../db/file-tracking', mockDb);
  installCjsModuleMock('../db/host-management', mockDb);
  installCjsModuleMock('../db/provider/routing-core', mockDb);
  installCjsModuleMock('../db/task-core', mockDb);
  installCjsModuleMock('../api/middleware', mockMiddleware);
  require(CONTROL_PLANE_MODULE);
  return require(HANDLER_MODULE);
}

function initHandlersWithDeps(handlers, taskManager = null) {
  handlers.init?.({ db: mockDb, taskManager });
  if (taskManager) {
    handlers.init?.(taskManager);
  }
}

function createReq(overrides = {}) {
  return {
    params: {},
    query: {},
    headers: {},
    requestId: 'req-123',
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

function expectList(res, { requestId = 'req-123', items, total } = {}) {
  const data = expectSuccess(res, { status: 200, requestId });
  expect(data).toEqual({ items, total });
  return data;
}

function countKey(filters = {}) {
  return [
    filters.provider ?? '',
    filters.from_date ?? '',
    filters.to_date ?? '',
    filters.status ?? 'all',
  ].join('|');
}

function mockCountTasksWithMap(counts) {
  mockDb.countTasks.mockImplementation((filters = {}) => counts[countKey(filters)] ?? 0);
}

function mockSystemState({
  heapUsedMB,
  heapTotalMB,
  rssMB = 200,
  uptime = 123.4,
}) {
  vi.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: rssMB * 1024 * 1024,
    heapTotal: heapTotalMB * 1024 * 1024,
    heapUsed: heapUsedMB * 1024 * 1024,
    external: 0,
    arrayBuffers: 0,
  });
  vi.spyOn(process, 'uptime').mockReturnValue(uptime);
}

function resetMockDefaults() {
  mockDb.getBenchmarkResults.mockReset().mockReturnValue([]);
  mockDb.getBenchmarkStats.mockReset().mockReturnValue({});
  mockDb.applyBenchmarkResults.mockReset().mockReturnValue({ applied: true });
  mockDb.listProjectTuning.mockReset().mockReturnValue([]);
  mockDb.setProjectTuning.mockReset().mockReturnValue(undefined);
  mockDb.deleteProjectTuning.mockReset().mockReturnValue(undefined);
  mockDb.getProviderStats.mockReset().mockReturnValue({});
  mockDb.getProvider.mockReset().mockReturnValue({ enabled: 1 });
  mockDb.updateProvider.mockReset().mockReturnValue(undefined);
  mockDb.listProviders.mockReset().mockReturnValue([]);
  mockDb.countTasks.mockReset().mockReturnValue(0);
  mockDb.getProviderDailyCounts.mockReset().mockReturnValue([]);
  mockDb.getConfig.mockReset().mockReturnValue(undefined);

  mockParseBody.mockReset().mockResolvedValue({});
  mockSendJson.mockReset().mockImplementation((res, data, status = 200, req = null) => {
    const headers = { 'Content-Type': 'application/json' };
    if (req?.requestId) {
      headers['X-Request-ID'] = req.requestId;
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(data));
  });

  mockTaskManager.getMcpInstanceId.mockReset().mockReturnValue('mcp-instance-abcdef');
}

describe('api/v2-governance-handlers infrastructure routes', () => {
  let handlers;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    vi.restoreAllMocks();
    resetMockDefaults();
    handlers = loadHandlers();
    initHandlersWithDeps(handlers);
  });

  afterEach(() => {
    clearLoadedModules();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('handleListBenchmarks', () => {
    it('returns 400 when host_id is missing', async () => {
      const res = createMockRes();

      await handlers.handleListBenchmarks(createReq(), res);

      expectError(res, {
        code: 'validation_error',
        message: 'host_id is required',
      });
      expect(mockDb.getBenchmarkResults).not.toHaveBeenCalled();
      expect(mockDb.getBenchmarkStats).not.toHaveBeenCalled();
    });

    it('accepts the hostId alias and returns results with stats', async () => {
      const req = createReq({ query: { hostId: 'host-a' } });
      const res = createMockRes();

      mockDb.getBenchmarkResults.mockReturnValue([
        { benchmark_id: 'bm-1', median_ms: 42 },
      ]);
      mockDb.getBenchmarkStats.mockReturnValue({ p50_ms: 42, p95_ms: 77 });

      await handlers.handleListBenchmarks(req, res);

      expect(mockDb.getBenchmarkResults).toHaveBeenCalledWith('host-a', 10);
      expect(mockDb.getBenchmarkStats).toHaveBeenCalledWith('host-a');
      expect(expectSuccess(res)).toEqual({
        host_id: 'host-a',
        results: [{ benchmark_id: 'bm-1', median_ms: 42 }],
        stats: { p50_ms: 42, p95_ms: 77 },
      });
    });

    it('uses the provided limit and clamps it at 1000', async () => {
      const req = createReq({
        query: { host_id: 'host-b', limit: '5000' },
      });
      const res = createMockRes();

      await handlers.handleListBenchmarks(req, res);

      expect(mockDb.getBenchmarkResults).toHaveBeenCalledWith('host-b', 1000);
      expect(expectSuccess(res).host_id).toBe('host-b');
    });

    it('normalizes non-array results and null stats to empty structures', async () => {
      const res = createMockRes();

      mockDb.getBenchmarkResults.mockReturnValue('not-an-array');
      mockDb.getBenchmarkStats.mockReturnValue(null);

      await handlers.handleListBenchmarks(
        createReq({ query: { host_id: 'host-c' } }),
        res,
      );

      expect(expectSuccess(res)).toEqual({
        host_id: 'host-c',
        results: [],
        stats: {},
      });
    });

    it('returns 500 when benchmark lookup throws', async () => {
      const res = createMockRes();

      mockDb.getBenchmarkResults.mockImplementation(() => {
        throw new Error('benchmark lookup failed');
      });

      await handlers.handleListBenchmarks(
        createReq({ query: { host_id: 'host-d' } }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'benchmark lookup failed',
      });
    });
  });

  describe('handleApplyBenchmark', () => {
    it('returns 400 when host_id is missing', async () => {
      const res = createMockRes();

      await handlers.handleApplyBenchmark(
        createReq({ body: { model: 'gpt-5' } }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'host_id is required',
      });
      expect(mockDb.applyBenchmarkResults).not.toHaveBeenCalled();
    });

    it('parses the body when req.body is missing and applies results', async () => {
      const req = createReq();
      const res = createMockRes();

      mockParseBody.mockResolvedValue({
        host_id: 'host-a',
        model: 'claude-sonnet',
      });
      mockDb.applyBenchmarkResults.mockReturnValue({ applied: true, changes: 3 });

      await handlers.handleApplyBenchmark(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
      expect(mockDb.applyBenchmarkResults).toHaveBeenCalledWith('host-a', 'claude-sonnet');
      expect(expectSuccess(res)).toEqual({ applied: true, changes: 3 });
    });

    it('accepts the hostId alias and does not parse when body is already present', async () => {
      const res = createMockRes();

      mockDb.applyBenchmarkResults.mockReturnValue(null);

      await handlers.handleApplyBenchmark(
        createReq({ body: { hostId: 'host-b', model: 'gpt-5.3' } }),
        res,
      );

      expect(mockParseBody).not.toHaveBeenCalled();
      expect(mockDb.applyBenchmarkResults).toHaveBeenCalledWith('host-b', 'gpt-5.3');
      expect(expectSuccess(res)).toEqual({});
    });

    it('returns 500 when applying benchmark results throws', async () => {
      const res = createMockRes();

      mockDb.applyBenchmarkResults.mockImplementation(() => {
        throw new Error('apply failed');
      });

      await handlers.handleApplyBenchmark(
        createReq({ body: { host_id: 'host-c' } }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'apply failed',
      });
    });
  });

  describe('handleListProjectTuning', () => {
    it('returns the tuning list in a list envelope', async () => {
      const res = createMockRes();
      const items = [
        { project_path: 'C:/repo-a', settings: { provider: 'codex' } },
        { project_path: 'C:/repo-b', settings: { provider: 'ollama' } },
      ];

      mockDb.listProjectTuning.mockReturnValue(items);

      await handlers.handleListProjectTuning(createReq(), res);

      expect(mockDb.listProjectTuning).toHaveBeenCalledOnce();
      expectList(res, { items, total: 2 });
    });

    it('normalizes non-array tuning results to an empty list', async () => {
      const res = createMockRes();

      mockDb.listProjectTuning.mockReturnValue(null);

      await handlers.handleListProjectTuning(createReq(), res);

      expectList(res, { items: [], total: 0 });
    });

    it('returns 500 when listing project tuning throws', async () => {
      const res = createMockRes();

      mockDb.listProjectTuning.mockImplementation(() => {
        throw new Error('list tuning failed');
      });

      await handlers.handleListProjectTuning(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'list tuning failed',
      });
    });
  });

  describe('handleCreateProjectTuning', () => {
    it('returns 400 when project_path is missing', async () => {
      const res = createMockRes();

      await handlers.handleCreateProjectTuning(
        createReq({ body: { settings: { provider: 'codex' } } }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'project_path is required',
      });
      expect(mockDb.setProjectTuning).not.toHaveBeenCalled();
    });

    it('returns 400 when settings is missing', async () => {
      const res = createMockRes();

      await handlers.handleCreateProjectTuning(
        createReq({ body: { project_path: 'C:/repo' } }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'settings object is required',
      });
      expect(mockDb.setProjectTuning).not.toHaveBeenCalled();
    });

    it('returns 400 when settings is not an object', async () => {
      const res = createMockRes();

      await handlers.handleCreateProjectTuning(
        createReq({ body: { project_path: 'C:/repo', settings: 'bad' } }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'settings object is required',
      });
    });

    it('parses the body, trims project_path, and returns 201', async () => {
      const req = createReq();
      const res = createMockRes();

      mockParseBody.mockResolvedValue({
        project_path: '  C:/repo-a  ',
        settings: { model: 'gpt-5.3' },
        description: 'Preferred for release work',
      });

      await handlers.handleCreateProjectTuning(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
      expect(mockDb.setProjectTuning).toHaveBeenCalledWith(
        'C:/repo-a',
        { model: 'gpt-5.3' },
        'Preferred for release work',
      );
      expect(expectSuccess(res, { status: 201 })).toEqual({
        project_path: 'C:/repo-a',
        saved: true,
      });
    });

    it('accepts the projectPath alias without parsing when body is present', async () => {
      const res = createMockRes();

      await handlers.handleCreateProjectTuning(
        createReq({
          body: {
            projectPath: 'C:/repo-b',
            settings: { provider: 'ollama' },
          },
        }),
        res,
      );

      expect(mockParseBody).not.toHaveBeenCalled();
      expect(mockDb.setProjectTuning).toHaveBeenCalledWith(
        'C:/repo-b',
        { provider: 'ollama' },
        undefined,
      );
      expect(expectSuccess(res, { status: 201 })).toEqual({
        project_path: 'C:/repo-b',
        saved: true,
      });
    });

    it('returns 500 when saving tuning throws', async () => {
      const res = createMockRes();

      mockDb.setProjectTuning.mockImplementation(() => {
        throw new Error('save tuning failed');
      });

      await handlers.handleCreateProjectTuning(
        createReq({
          body: {
            project_path: 'C:/repo-c',
            settings: { provider: 'codex' },
          },
        }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'save tuning failed',
      });
    });
  });

  describe('handleDeleteProjectTuning', () => {
    it('returns 400 when project_path is missing', async () => {
      const res = createMockRes();

      await handlers.handleDeleteProjectTuning(createReq(), res);

      expectError(res, {
        code: 'validation_error',
        message: 'project_path is required',
      });
      expect(mockDb.deleteProjectTuning).not.toHaveBeenCalled();
    });

    it('decodes the route param before deleting project tuning', async () => {
      const res = createMockRes();
      const encoded = encodeURIComponent('C:/workspaces/repo name');

      await handlers.handleDeleteProjectTuning(
        createReq({ params: { project_path: encoded } }),
        res,
      );

      expect(mockDb.deleteProjectTuning).toHaveBeenCalledWith('C:/workspaces/repo name');
      expect(expectSuccess(res)).toEqual({
        deleted: true,
        project_path: 'C:/workspaces/repo name',
      });
    });

    it('returns 500 when deleting tuning throws', async () => {
      const res = createMockRes();

      mockDb.deleteProjectTuning.mockImplementation(() => {
        throw new Error('delete tuning failed');
      });

      await handlers.handleDeleteProjectTuning(
        createReq({ params: { project_path: encodeURIComponent('C:/repo') } }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'delete tuning failed',
      });
    });
  });

  describe('handleProviderStats', () => {
    it('returns provider stats with a per-day time series', async () => {
      const req = createReq({
        params: { provider_id: 'codex' },
        query: { days: '3' },
      });
      const res = createMockRes();

      mockDb.getProviderStats.mockReturnValue({
        total_tasks: 8,
        success_rate: 75,
      });
      mockCountTasksWithMap({
        [countKey({ provider: 'codex', from_date: '2026-03-08', to_date: '2026-03-09' })]: 5,
        [countKey({ provider: 'codex', from_date: '2026-03-08', to_date: '2026-03-09', status: 'completed' })]: 4,
        [countKey({ provider: 'codex', from_date: '2026-03-08', to_date: '2026-03-09', status: 'failed' })]: 1,
        [countKey({ provider: 'codex', from_date: '2026-03-09', to_date: '2026-03-10' })]: 2,
        [countKey({ provider: 'codex', from_date: '2026-03-09', to_date: '2026-03-10', status: 'completed' })]: 2,
        [countKey({ provider: 'codex', from_date: '2026-03-09', to_date: '2026-03-10', status: 'failed' })]: 0,
        [countKey({ provider: 'codex', from_date: '2026-03-10', to_date: '2026-03-11' })]: 1,
        [countKey({ provider: 'codex', from_date: '2026-03-10', to_date: '2026-03-11', status: 'completed' })]: 0,
        [countKey({ provider: 'codex', from_date: '2026-03-10', to_date: '2026-03-11', status: 'failed' })]: 1,
      });

      await handlers.handleProviderStats(req, res);

      expect(mockDb.getProviderStats).toHaveBeenCalledWith('codex', 3);
      expect(mockDb.countTasks).toHaveBeenNthCalledWith(1, {
        provider: 'codex',
        from_date: '2026-03-08',
        to_date: '2026-03-09',
      });
      expect(mockDb.countTasks).toHaveBeenNthCalledWith(2, {
        provider: 'codex',
        from_date: '2026-03-08',
        to_date: '2026-03-09',
        status: 'completed',
      });
      expect(mockDb.countTasks).toHaveBeenNthCalledWith(3, {
        provider: 'codex',
        from_date: '2026-03-08',
        to_date: '2026-03-09',
        status: 'failed',
      });

      expect(expectSuccess(res)).toEqual({
        provider: 'codex',
        days: 3,
        total_tasks: 8,
        success_rate: 75,
        time_series: [
          { date: '2026-03-08', total: 5, completed: 4, failed: 1 },
          { date: '2026-03-09', total: 2, completed: 2, failed: 0 },
          { date: '2026-03-10', total: 1, completed: 0, failed: 1 },
        ],
      });
    });

    it('uses a default 7 day window when days is omitted', async () => {
      const res = createMockRes();

      await handlers.handleProviderStats(
        createReq({ params: { provider_id: 'ollama' } }),
        res,
      );

      const data = expectSuccess(res);
      expect(mockDb.getProviderStats).toHaveBeenCalledWith('ollama', 7);
      expect(data.days).toBe(7);
      expect(data.time_series).toHaveLength(7);
      expect(mockDb.countTasks).toHaveBeenCalledTimes(21);
    });

    it('clamps days to 90 when a larger value is requested', async () => {
      const res = createMockRes();

      await handlers.handleProviderStats(
        createReq({
          params: { provider_id: 'codex' },
          query: { days: '200' },
        }),
        res,
      );

      const data = expectSuccess(res);
      expect(mockDb.getProviderStats).toHaveBeenCalledWith('codex', 90);
      expect(data.days).toBe(90);
      expect(data.time_series).toHaveLength(90);
    });

    it('clamps negative days to 1', async () => {
      const res = createMockRes();

      await handlers.handleProviderStats(
        createReq({
          params: { provider_id: 'codex' },
          query: { days: '-5' },
        }),
        res,
      );

      const data = expectSuccess(res);
      expect(mockDb.getProviderStats).toHaveBeenCalledWith('codex', 1);
      expect(data.days).toBe(1);
      expect(data.time_series).toEqual([
        { date: '2026-03-10', total: 0, completed: 0, failed: 0 },
      ]);
    });

    it('treats days=0 as the default 7 day window', async () => {
      const res = createMockRes();

      await handlers.handleProviderStats(
        createReq({
          params: { provider_id: 'codex' },
          query: { days: '0' },
        }),
        res,
      );

      expect(expectSuccess(res).days).toBe(7);
      expect(mockDb.getProviderStats).toHaveBeenCalledWith('codex', 7);
    });

    it('returns 500 when provider stats lookup throws', async () => {
      const res = createMockRes();

      mockDb.getProviderStats.mockImplementation(() => {
        throw new Error('provider stats failed');
      });

      await handlers.handleProviderStats(
        createReq({ params: { provider_id: 'codex' } }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'provider stats failed',
      });
    });
  });

  describe('handleProviderToggle', () => {
    it('returns 404 when the provider does not exist', async () => {
      const res = createMockRes();

      mockDb.getProvider.mockReturnValue(null);

      await handlers.handleProviderToggle(
        createReq({
          params: { provider_id: 'missing' },
          body: {},
        }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'provider_not_found',
        message: 'Provider not found: missing',
      });
      expect(mockDb.updateProvider).not.toHaveBeenCalled();
    });

    it('parses the body and toggles an enabled provider off by default', async () => {
      const req = createReq({ params: { provider_id: 'codex' } });
      const res = createMockRes();

      mockDb.getProvider.mockReturnValue({ enabled: 1 });
      mockParseBody.mockResolvedValue({});

      await handlers.handleProviderToggle(req, res);

      expect(mockParseBody).toHaveBeenCalledWith(req);
      expect(mockDb.updateProvider).toHaveBeenCalledWith('codex', { enabled: 0 });
      expect(expectSuccess(res)).toEqual({
        provider: 'codex',
        enabled: false,
      });
    });

    it('toggles a disabled provider on when no explicit enabled value is sent', async () => {
      const res = createMockRes();

      mockDb.getProvider.mockReturnValue({ enabled: 0 });

      await handlers.handleProviderToggle(
        createReq({
          params: { provider_id: 'ollama' },
          body: {},
        }),
        res,
      );

      expect(mockParseBody).not.toHaveBeenCalled();
      expect(mockDb.updateProvider).toHaveBeenCalledWith('ollama', { enabled: 1 });
      expect(expectSuccess(res)).toEqual({
        provider: 'ollama',
        enabled: true,
      });
    });

    it('respects an explicit enabled=false value', async () => {
      const res = createMockRes();

      mockDb.getProvider.mockReturnValue({ enabled: 1 });

      await handlers.handleProviderToggle(
        createReq({
          params: { provider_id: 'codex' },
          body: { enabled: false },
        }),
        res,
      );

      expect(mockDb.updateProvider).toHaveBeenCalledWith('codex', { enabled: 0 });
      expect(expectSuccess(res).enabled).toBe(false);
    });

    it('respects an explicit enabled=0 value', async () => {
      const res = createMockRes();

      await handlers.handleProviderToggle(
        createReq({
          params: { provider_id: 'codex' },
          body: { enabled: 0 },
        }),
        res,
      );

      expect(mockDb.updateProvider).toHaveBeenCalledWith('codex', { enabled: 0 });
      expect(expectSuccess(res).enabled).toBe(false);
    });

    it('respects an explicit enabled=true value', async () => {
      const res = createMockRes();

      mockDb.getProvider.mockReturnValue({ enabled: 0 });

      await handlers.handleProviderToggle(
        createReq({
          params: { provider_id: 'codex' },
          body: { enabled: true },
        }),
        res,
      );

      expect(mockDb.updateProvider).toHaveBeenCalledWith('codex', { enabled: 1 });
      expect(expectSuccess(res).enabled).toBe(true);
    });

    it('returns 500 when updating the provider fails', async () => {
      const res = createMockRes();

      mockDb.updateProvider.mockImplementation(() => {
        throw new Error('toggle failed');
      });

      await handlers.handleProviderToggle(
        createReq({
          params: { provider_id: 'codex' },
          body: { enabled: true },
        }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'toggle failed',
      });
    });
  });

  describe('handleProviderTrends', () => {
    it('returns multi-provider trend series with success rates', async () => {
      const req = createReq({ query: { days: '2' } });
      const res = createMockRes();

      mockDb.listProviders.mockReturnValue([
        { provider: 'codex' },
        { provider: 'ollama' },
      ]);
      mockDb.getProviderDailyCounts.mockReturnValue([
        { provider: 'codex', date: '2026-03-09', status: 'completed', count: 4 },
        { provider: 'codex', date: '2026-03-09', status: 'failed', count: 1 },
        { provider: 'ollama', date: '2026-03-09', status: 'completed', count: 2 },
        { provider: 'ollama', date: '2026-03-09', status: 'failed', count: 1 },
        { provider: 'ollama', date: '2026-03-10', status: 'completed', count: 2 },
      ]);

      await handlers.handleProviderTrends(req, res);

      expect(mockDb.getProviderDailyCounts).toHaveBeenCalledWith('2026-03-09', '2026-03-11');
      expect(expectSuccess(res)).toEqual({
        providers: ['codex', 'ollama'],
        days: 2,
        series: [
          {
            date: '2026-03-09',
            codex_total: 5,
            codex_completed: 4,
            codex_failed: 1,
            codex_success_rate: 80,
            ollama_total: 3,
            ollama_completed: 2,
            ollama_failed: 1,
            ollama_success_rate: 67,
          },
          {
            date: '2026-03-10',
            codex_total: 0,
            codex_completed: 0,
            codex_failed: 0,
            codex_success_rate: null,
            ollama_total: 2,
            ollama_completed: 2,
            ollama_failed: 0,
            ollama_success_rate: 100,
          },
        ],
      });
    });

    it('falls back to point counts when bulk provider counts are unavailable', async () => {
      const req = createReq({ query: { days: '1' } });
      const res = createMockRes();
      const getProviderDailyCounts = mockDb.getProviderDailyCounts;

      mockDb.listProviders.mockReturnValue([{ provider: 'codex' }]);
      mockCountTasksWithMap({
        [countKey({ provider: 'codex', from_date: '2026-03-10', to_date: '2026-03-11' })]: 4,
        [countKey({ provider: 'codex', from_date: '2026-03-10', to_date: '2026-03-11', status: 'completed' })]: 3,
        [countKey({ provider: 'codex', from_date: '2026-03-10', to_date: '2026-03-11', status: 'failed' })]: 1,
      });

      mockDb.getProviderDailyCounts = undefined;
      try {
        await handlers.handleProviderTrends(req, res);
      } finally {
        mockDb.getProviderDailyCounts = getProviderDailyCounts;
      }

      expect(mockDb.countTasks).toHaveBeenCalledWith({
        provider: 'codex',
        from_date: '2026-03-10',
        to_date: '2026-03-11',
      });
      expect(expectSuccess(res)).toEqual({
        providers: ['codex'],
        days: 1,
        series: [{
          date: '2026-03-10',
          codex_total: 4,
          codex_completed: 3,
          codex_failed: 1,
          codex_success_rate: 75,
        }],
      });
    });

    it('uses a default 7 day window when days is omitted', async () => {
      const res = createMockRes();

      mockDb.listProviders.mockReturnValue([{ provider: 'codex' }]);

      await handlers.handleProviderTrends(createReq(), res);

      const data = expectSuccess(res);
      expect(data.days).toBe(7);
      expect(data.providers).toEqual(['codex']);
      expect(data.series).toHaveLength(7);
    });

    it('clamps days to 90 when a larger value is requested', async () => {
      const res = createMockRes();

      mockDb.listProviders.mockReturnValue([{ provider: 'codex' }]);

      await handlers.handleProviderTrends(
        createReq({ query: { days: '500' } }),
        res,
      );

      const data = expectSuccess(res);
      expect(data.days).toBe(90);
      expect(data.series).toHaveLength(90);
    });

    it('handles an empty provider list', async () => {
      const res = createMockRes();

      mockDb.listProviders.mockReturnValue([]);

      await handlers.handleProviderTrends(
        createReq({ query: { days: '3' } }),
        res,
      );

      expect(expectSuccess(res)).toEqual({
        providers: [],
        days: 3,
        series: [
          { date: '2026-03-08' },
          { date: '2026-03-09' },
          { date: '2026-03-10' },
        ],
      });
      expect(mockDb.countTasks).not.toHaveBeenCalled();
    });

    it('returns 500 when listing providers throws', async () => {
      const res = createMockRes();

      mockDb.listProviders.mockImplementation(() => {
        throw new Error('provider list failed');
      });

      await handlers.handleProviderTrends(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'provider list failed',
      });
    });
  });

  describe('handleSystemStatus', () => {
    it('returns memory, uptime, and task counts without a task manager instance', async () => {
      const res = createMockRes();

      mockSystemState({
        heapUsedMB: 60,
        heapTotalMB: 100,
        rssMB: 180,
        uptime: 123.4,
      });
      mockDb.countTasks.mockImplementation(({ status }) => (
        status === 'running' ? 3 : (status === 'queued' ? 7 : 0)
      ));

      await handlers.handleSystemStatus(createReq(), res);

      expect(mockDb.countTasks).toHaveBeenNthCalledWith(1, { status: 'running' });
      expect(mockDb.countTasks).toHaveBeenNthCalledWith(2, { status: 'queued' });
      const result = expectSuccess(res);
      expect(result).toEqual({
        instance: { pid: process.pid },
        memory: {
          heap_used_mb: 60,
          heap_total_mb: 100,
          heap_percent: 60,
          rss_mb: 180,
          status: 'healthy',
        },
        resource_gating: expect.objectContaining({ enabled: expect.any(Boolean) }),
        security: {
          auth_configured: false,
          warning: SECURITY_WARNING_MESSAGE,
        },
        security_warning: SECURITY_WARNING_MESSAGE,
        uptime_seconds: 123,
        tasks: { running: 3, queued: 7 },
        node_version: process.version,
        platform: process.platform,
      });
    });

    it('includes instance id and short_id when initialized with a task manager', async () => {
      const res = createMockRes();

      initHandlersWithDeps(handlers, mockTaskManager);
      mockTaskManager.getMcpInstanceId.mockReturnValue('mcp-instance-abcdef');
      mockSystemState({
        heapUsedMB: 50,
        heapTotalMB: 100,
        rssMB: 160,
        uptime: 45.2,
      });

      await handlers.handleSystemStatus(createReq(), res);

      expect(mockTaskManager.getMcpInstanceId).toHaveBeenCalledOnce();
      expect(expectSuccess(res)).toEqual({
        instance: {
          id: 'mcp-instance-abcdef',
          short_id: 'abcdef',
          pid: process.pid,
        },
        memory: {
          heap_used_mb: 50,
          heap_total_mb: 100,
          heap_percent: 50,
          rss_mb: 160,
          status: 'healthy',
        },
        resource_gating: expect.objectContaining({ enabled: expect.any(Boolean) }),
        security: {
          auth_configured: false,
          warning: SECURITY_WARNING_MESSAGE,
        },
        security_warning: SECURITY_WARNING_MESSAGE,
        uptime_seconds: 45,
        tasks: { running: 0, queued: 0 },
        node_version: process.version,
        platform: process.platform,
      });
    });

    it('marks memory as elevated at 70 percent', async () => {
      const res = createMockRes();

      mockSystemState({ heapUsedMB: 70, heapTotalMB: 100 });

      await handlers.handleSystemStatus(createReq(), res);

      expect(expectSuccess(res).memory.status).toBe('elevated');
    });

    it('marks memory as warning at 80 percent', async () => {
      const res = createMockRes();

      mockSystemState({ heapUsedMB: 80, heapTotalMB: 100 });

      await handlers.handleSystemStatus(createReq(), res);

      expect(expectSuccess(res).memory.status).toBe('warning');
    });

    it('marks memory as critical at 90 percent', async () => {
      const res = createMockRes();

      mockSystemState({ heapUsedMB: 90, heapTotalMB: 100 });

      await handlers.handleSystemStatus(createReq(), res);

      expect(expectSuccess(res).memory.status).toBe('critical');
    });
  });
});
