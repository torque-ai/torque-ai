/**
 * Tests for dashboard route decomposition.
 *
 * Validates that the router dispatches correctly, that individual route
 * handlers produce the expected responses, and that the utils module
 * works as specified.
 */
const { EventEmitter } = require('events');

// ============================================
// Test helpers
// ============================================

function createMockRes() {
  let resolvePromise;
  const done = new Promise((resolve) => { resolvePromise = resolve; });
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    _corsOrigin: null,
    writeHead: vi.fn((status, headers) => {
      res.statusCode = status;
      res.headers = headers;
    }),
    end: vi.fn((body = '') => {
      res.body = body;
      resolvePromise();
    }),
  };
  return { res, done };
}

function createMockReq({ method = 'GET', url = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  req.connection = { remoteAddress };
  req.destroy = vi.fn();

  // Auto-emit body + end after next tick
  process.nextTick(() => {
    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', payload);
    }
    req.emit('end');
  });

  return req;
}

function parseJsonBody(raw) {
  return raw ? JSON.parse(raw) : null;
}

// ============================================
// Utils tests
// ============================================

describe('dashboard/utils', () => {
  const utils = require('../dashboard/utils');

  describe('parseQuery', () => {
    it('returns empty object for URL without query string', () => {
      expect(utils.parseQuery('/api/tasks')).toEqual({});
    });

    it('parses single parameter', () => {
      expect(utils.parseQuery('/api/tasks?status=running')).toEqual({ status: 'running' });
    });

    it('parses multiple parameters', () => {
      const result = utils.parseQuery('/api/tasks?status=running&limit=10&page=2');
      expect(result).toEqual({ status: 'running', limit: '10', page: '2' });
    });

    it('decodes URI-encoded values', () => {
      const result = utils.parseQuery('/api/test?name=hello%20world');
      expect(result).toEqual({ name: 'hello world' });
    });

    it('handles key without value', () => {
      const result = utils.parseQuery('/api/test?verbose');
      expect(result).toEqual({ verbose: '' });
    });

    it('skips malformed percent-encoded pairs', () => {
      const result = utils.parseQuery('/api/test?key=%ZZ');
      // Should not throw; key is skipped
      expect(result).toBeDefined();
    });
  });

  describe('parseBody', () => {
    it('parses JSON body', async () => {
      const req = createMockReq({ body: { hello: 'world' } });
      const result = await utils.parseBody(req);
      expect(result).toEqual({ hello: 'world' });
    });

    it('returns empty object for empty body', async () => {
      const req = createMockReq();
      const result = await utils.parseBody(req);
      expect(result).toEqual({});
    });

    it('rejects invalid JSON', async () => {
      const req = createMockReq({ body: 'not json{' });
      await expect(utils.parseBody(req)).rejects.toThrow('Invalid JSON body');
    });
  });

  describe('sendJson', () => {
    it('sends JSON with 200 status by default', () => {
      const { res } = createMockRes();
      utils.sendJson(res, { ok: true });
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'application/json',
      }));
      expect(parseJsonBody(res.end.mock.calls[0][0])).toEqual({ ok: true });
    });

    it('sends JSON with custom status', () => {
      const { res } = createMockRes();
      utils.sendJson(res, { error: 'not found' }, 404);
      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    it('includes CORS header when _corsOrigin is set', () => {
      const { res } = createMockRes();
      res._corsOrigin = 'http://localhost:3456';
      utils.sendJson(res, {});
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Access-Control-Allow-Origin': 'http://localhost:3456',
      }));
    });
  });

  describe('sendError', () => {
    it('sends error with default 400 status', () => {
      const { res } = createMockRes();
      utils.sendError(res, 'Bad request');
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(parseJsonBody(res.end.mock.calls[0][0])).toEqual({ error: 'Bad request' });
    });

    it('sends error with custom status', () => {
      const { res } = createMockRes();
      utils.sendError(res, 'Not found', 404);
      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });
  });

  describe('isLocalhostOrigin', () => {
    it('returns true for localhost origins', () => {
      expect(utils.isLocalhostOrigin('http://localhost:3456')).toBe(true);
      expect(utils.isLocalhostOrigin('http://127.0.0.1:3000')).toBe(true);
      expect(utils.isLocalhostOrigin('http://[::1]:5000')).toBe(true);
    });

    it('returns false for non-localhost origins', () => {
      expect(utils.isLocalhostOrigin('http://example.com')).toBe(false);
      expect(utils.isLocalhostOrigin(null)).toBe(false);
      expect(utils.isLocalhostOrigin(undefined)).toBe(false);
      expect(utils.isLocalhostOrigin('not a url')).toBe(false);
    });
  });

  describe('formatUptime', () => {
    it('formats minutes', () => {
      expect(utils.formatUptime(300)).toBe('5m');
    });

    it('formats hours and minutes', () => {
      expect(utils.formatUptime(3660)).toBe('1h 1m');
    });

    it('formats days, hours, minutes', () => {
      expect(utils.formatUptime(90060)).toBe('1d 1h 1m');
    });
  });

  describe('enrichTaskWithHostName', () => {
    it('returns task unchanged when no ollama_host_id', () => {
      const task = { id: 't1', status: 'completed' };
      const result = utils.enrichTaskWithHostName(task);
      expect(result).toEqual(task);
    });

    it('returns null/undefined unchanged', () => {
      expect(utils.enrichTaskWithHostName(null)).toBe(null);
    });
  });
});

// ============================================
// Router dispatch tests
// ============================================

describe('dashboard/router', () => {
  const { routes, dispatch } = require('../dashboard/router');

  it('has routes defined for all major API endpoints', () => {
    // Test that well-known URLs match at least one route
    const endpointExamples = [
      ['GET', '/api/tasks'],
      ['GET', '/api/providers'],
      ['GET', '/api/provider-quotas'],
      ['GET', '/api/provider-scores'],
      ['GET', '/api/stats/overview'],
      ['GET', '/api/hosts'],
      ['GET', '/api/workflows'],
      ['GET', '/api/budget/summary'],
      ['GET', '/api/system/status'],
      ['GET', '/api/instances'],
      ['GET', '/api/benchmarks'],
      ['GET', '/api/project-tuning'],
      ['GET', '/api/plan-projects'],
      ['GET', '/api/agents/agent-1'],
    ];
    for (const [method, url] of endpointExamples) {
      const match = routes.find(r => r.method === method && r.pattern.test(url));
      expect(match, `No route for ${method} ${url}`).toBeDefined();
    }
  });

  it('matches task diff route before generic task route', () => {
    // /api/tasks/:id/diff should match the diff handler, not the get-task handler
    const diffRoute = routes.find(r => r.pattern.test('/api/tasks/abc123/diff'));
    expect(diffRoute).toBeDefined();
    expect(diffRoute.handler.name).toBe('handleTaskDiff');
  });

  it('matches task logs route before generic task route', () => {
    const logsRoute = routes.find(r => r.pattern.test('/api/tasks/abc123/logs'));
    expect(logsRoute).toBeDefined();
    expect(logsRoute.handler.name).toBe('handleTaskLogs');
  });

  it('matches workflow sub-routes before generic workflow route', () => {
    const tasksRoute = routes.find(r =>
      r.method === 'GET' && r.pattern.test('/api/workflows/wf1/tasks')
    );
    expect(tasksRoute).toBeDefined();
    expect(tasksRoute.handler.name).toBe('handleGetWorkflowTasks');

    const historyRoute = routes.find(r =>
      r.method === 'GET' && r.pattern.test('/api/workflows/wf1/history')
    );
    expect(historyRoute).toBeDefined();
    expect(historyRoute.handler.name).toBe('handleGetWorkflowHistory');
  });

  it('matches plan-projects import before generic plan-project GET', () => {
    const importRoute = routes.find(r =>
      r.method === 'POST' && r.pattern.test('/api/plan-projects/import')
    );
    expect(importRoute).toBeDefined();
    expect(importRoute.handler.name).toBe('handleImportPlanApi');
  });

  it('matches hosts/activity before hosts/:id', () => {
    const activityRoute = routes.find(r =>
      r.method === 'GET' && r.pattern.test('/api/hosts/activity')
    );
    expect(activityRoute).toBeDefined();
    expect(activityRoute.handler.name).toBe('handleHostActivity');
  });

  it('matches agent health before generic agent get route', () => {
    const healthRoute = routes.find(r =>
      r.method === 'GET' && r.pattern.test('/api/agents/agent-1/health')
    );
    expect(healthRoute).toBeDefined();
    expect(healthRoute.handler.name).toBe('handleAgentHealth');

    const getRoute = routes.find(r =>
      r.method === 'GET' && r.pattern.test('/api/agents/agent-1')
    );
    expect(getRoute).toBeDefined();
    expect(getRoute.handler.name).toBe('handleGetAgent');
  });

  it('handles CORS preflight with OPTIONS', async () => {
    const req = createMockReq({
      method: 'OPTIONS',
      url: '/api/tasks',
      headers: { origin: 'http://localhost:3456' },
    });
    const { res, done } = createMockRes();
    const context = { broadcastTaskUpdate: vi.fn(), clients: new Set(), serverPort: 3456 };
    await dispatch(req, res, context);
    await done;
    expect(res.statusCode).toBe(204);
  });

  it('returns 404 for unknown routes', async () => {
    const req = createMockReq({ method: 'GET', url: '/api/nonexistent' });
    const { res, done } = createMockRes();
    const context = { broadcastTaskUpdate: vi.fn(), clients: new Set(), serverPort: 3456 };
    await dispatch(req, res, context);
    await done;
    expect(res.statusCode).toBe(404);
    expect(parseJsonBody(res.body)).toEqual({ error: 'Not found' });
  });

  it('sets CORS origin for localhost requests', async () => {
    const req = createMockReq({
      method: 'GET',
      url: '/api/nonexistent',
      headers: { origin: 'http://localhost:3456' },
    });
    const { res, done } = createMockRes();
    const context = { broadcastTaskUpdate: vi.fn(), clients: new Set(), serverPort: 3456 };
    await dispatch(req, res, context);
    await done;
    expect(res._corsOrigin).toBe('http://localhost:3456');
  });

  it('does not set CORS origin for non-localhost requests', async () => {
    const req = createMockReq({
      method: 'GET',
      url: '/api/nonexistent',
      headers: { origin: 'http://evil.com' },
    });
    const { res, done } = createMockRes();
    const context = { broadcastTaskUpdate: vi.fn(), clients: new Set(), serverPort: 3456 };
    await dispatch(req, res, context);
    await done;
    expect(res._corsOrigin).toBe(null);
  });
});

// ============================================
// Route handler tests with mock db
// ============================================

describe('route handlers with mock db', () => {
  const db = require('../database');
  const taskCore = require('../db/task-core');
  const webhooksStreaming = require('../db/webhooks-streaming');
  const fileTracking = require('../db/file/tracking');
  const providerRoutingCore = require('../db/provider/routing-core');
  const eventTracking = require('../db/event-tracking');
  const costTracking = require('../db/cost-tracking');
  const workflowEngine = require('../db/workflow-engine');
  const hostManagement = require('../db/host/management');
  const projectConfigCore = require('../db/project-config-core');

  // Mock db methods used by route handlers
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('tasks routes', () => {
    const tasks = require('../dashboard/routes/tasks');

    it('handleListTasks returns paginated tasks', () => {
      vi.spyOn(taskCore, 'listTasks').mockReturnValue([
        { id: 't1', description: 'test', status: 'completed' },
      ]);
      vi.spyOn(taskCore, 'countTasks').mockReturnValue(1);

      const { res } = createMockRes();
      tasks.handleListTasks(null, res, { page: '1', limit: '25' });

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body.tasks).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
      expect(body.pagination.page).toBe(1);
    });

    it('handleGetTask returns 404 for missing task', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);

      const { res } = createMockRes();
      tasks.handleGetTask(null, res, {}, 'nonexistent');

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    it('handleGetTask returns task with output chunks', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({
        id: 't1', description: 'test', status: 'completed',
      });
      vi.spyOn(webhooksStreaming, 'getStreamChunks').mockReturnValue([{ chunk: 'hello' }]);

      const { res } = createMockRes();
      tasks.handleGetTask(null, res, {}, 't1');

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body.id).toBe('t1');
      expect(body.output_chunks).toHaveLength(1);
    });

    it('handleTaskDiff returns diff or null fallback', () => {
      vi.spyOn(fileTracking, 'getDiffPreview').mockReturnValue(null);

      const { res } = createMockRes();
      tasks.handleTaskDiff(null, res, {}, 't1');

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body.diff_content).toBe(null);
      expect(body.files_changed).toBe(0);
    });

    it('handleTaskLogs returns logs array', () => {
      vi.spyOn(webhooksStreaming, 'getTaskLogs').mockReturnValue([{ level: 'info', message: 'ok' }]);

      const { res } = createMockRes();
      tasks.handleTaskLogs(null, res, {}, 't1');

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body).toHaveLength(1);
    });
  });

  describe('providers routes', () => {
    const providers = require('../dashboard/routes/infrastructure');

    it('handleListProviders returns providers with stats', () => {
      vi.spyOn(providerRoutingCore, 'listProviders').mockReturnValue([
        { provider: 'codex', enabled: 1 },
      ]);
      vi.spyOn(fileTracking, 'getProviderStats').mockReturnValue({ total: 10, completed: 8 });

      const { res } = createMockRes();
      providers.handleListProviders(null, res, {});

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body).toHaveLength(1);
      expect(body[0].stats.total).toBe(10);
    });

    it('handleProviderTrends returns series with provider keys', () => {
      vi.spyOn(providerRoutingCore, 'listProviders').mockReturnValue([
        { provider: 'codex' },
      ]);
      vi.spyOn(taskCore, 'countTasks').mockReturnValue(0);

      const { res } = createMockRes();
      providers.handleProviderTrends(null, res, { days: '2' });

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body.providers).toEqual(['codex']);
      expect(body.series.length).toBe(2);
    });
  });

  describe('stats routes', () => {
    const stats = require('../dashboard/routes/analytics');
    const eventDispatch = require('../hooks/event-dispatch');

    it('handleStatsOverview returns today/yesterday/active/providers', () => {
      vi.spyOn(taskCore, 'countTasks').mockReturnValue(5);
      vi.spyOn(fileTracking, 'getProviderStats').mockReturnValue({});

      const { res } = createMockRes();
      stats.handleStatsOverview(null, res);

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body).toHaveProperty('today');
      expect(body).toHaveProperty('yesterday');
      expect(body).toHaveProperty('active');
      expect(body).toHaveProperty('providers');
    });

    it('handleTimeSeries clamps days to safe range', () => {
      vi.spyOn(taskCore, 'countTasks').mockReturnValue(0);

      const bad = createMockRes();
      stats.handleTimeSeries(null, bad.res, { days: 'not-a-number' });
      expect(parseJsonBody(bad.res.end.mock.calls[0][0])).toHaveLength(7);

      const low = createMockRes();
      stats.handleTimeSeries(null, low.res, { days: '-20' });
      expect(parseJsonBody(low.res.end.mock.calls[0][0])).toHaveLength(1);

      const high = createMockRes();
      stats.handleTimeSeries(null, high.res, { days: '9999' });
      expect(parseJsonBody(high.res.end.mock.calls[0][0])).toHaveLength(365);
    });

    it('handleModelStats clamps days to safe range and returns requested period', () => {
      vi.spyOn(taskCore, 'getModelUsageStats').mockReturnValue([]);
      vi.spyOn(taskCore, 'getModelDailyUsageSeries').mockReturnValue([]);

      const invalid = createMockRes();
      stats.handleModelStats(null, invalid.res, { days: 'n/a' });
      expect(parseJsonBody(invalid.res.end.mock.calls[0][0]).days).toBe(7);

      const zero = createMockRes();
      stats.handleModelStats(null, zero.res, { days: '0' });
      expect(parseJsonBody(zero.res.end.mock.calls[0][0]).days).toBe(1);

      const extreme = createMockRes();
      stats.handleModelStats(null, extreme.res, { days: '5000' });
      expect(parseJsonBody(extreme.res.end.mock.calls[0][0]).days).toBe(365);
    });

    it('handleEventHistory clamps limit to safe range', () => {
      vi.spyOn(eventDispatch, 'getTaskEvents').mockReturnValue([]);

      const bad = createMockRes();
      stats.handleEventHistory(null, bad.res, { limit: 'nonsense' });
      expect(eventDispatch.getTaskEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));

      const zero = createMockRes();
      stats.handleEventHistory(null, zero.res, { limit: '-100' });
      expect(eventDispatch.getTaskEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));

      const huge = createMockRes();
      stats.handleEventHistory(null, huge.res, { limit: '50000' });
      expect(eventDispatch.getTaskEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }));
    });

    it('handleFormatSuccess returns array even on error', () => {
      vi.spyOn(eventTracking, 'getFormatSuccessRatesSummary').mockImplementation(() => {
        throw new Error('no such table');
      });

      const { res } = createMockRes();
      stats.handleFormatSuccess(null, res);

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe('budget routes', () => {
    const budget = require('../dashboard/routes/analytics');

    it('handleBudgetSummary returns aggregated cost summary', () => {
      vi.spyOn(costTracking, 'getCostSummary').mockReturnValue([
        { provider: 'codex', task_count: 10, total_cost: 1.00 },
        { provider: 'claude-cli', task_count: 5, total_cost: 0.50 },
      ]);
      vi.spyOn(costTracking, 'getCostByPeriod').mockReturnValue([
        { period: '2026-03-01', cost: 0.25 },
      ]);

      const { res } = createMockRes();
      budget.handleBudgetSummary(null, res, { days: '7' });

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body.total_cost).toBe(1.50);
      expect(body.task_count).toBe(15);
      expect(body.by_provider).toEqual({ codex: 1.00, 'claude-cli': 0.50 });
      expect(body.daily).toEqual([{ date: '2026-03-01', cost: 0.25 }]);
    });

    it('handleBudgetSummary returns empty daily rows when period costs are unavailable', () => {
      vi.spyOn(costTracking, 'getCostSummary').mockReturnValue([
        { provider: 'codex', task_count: 3, total_cost: 0.75 },
      ]);
      vi.spyOn(costTracking, 'getCostByPeriod').mockReturnValue([]);

      const { res } = createMockRes();
      budget.handleBudgetSummary(null, res, { days: '7' });

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body.total_cost).toBe(0.75);
      expect(body.task_count).toBe(3);
      expect(body.daily).toEqual([]);
    });

    it('handleBudgetStatus returns limit and used', () => {
      vi.spyOn(costTracking, 'getBudgetStatus').mockReturnValue([
        { id: 'b1', budget_usd: 50, current_spend: 12.50 },
      ]);

      const { res } = createMockRes();
      budget.handleBudgetStatus(null, res);

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body.limit).toBe(50);
      expect(body.used).toBe(12.50);
      expect(body.budgets).toHaveLength(1);
    });
  });

  describe('workflows routes', () => {
    const workflows = require('../dashboard/routes/analytics');

    it('handleListWorkflows returns list with filtering', () => {
      vi.spyOn(workflowEngine, 'listWorkflows').mockReturnValue([
        { id: 'wf1', name: 'test', status: 'completed' },
      ]);
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf1',
        name: 'test',
        status: 'completed',
        summary: {
          total: 1,
          completed: 1,
          failed: 0,
          running: 0,
          blocked: 0,
          pending: 0,
          skipped: 0
        },
        tasks: {
          a: { id: 'a', status: 'completed' }
        }
      });

      const { res } = createMockRes();
      workflows.handleListWorkflows(null, res, { status: 'completed' });

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body).toHaveLength(1);
      expect(body[0].visibility.label).toBe('QUIET');
      expect(body[0].task_counts.total).toBe(1);
    });

    it('handleGetWorkflow returns 404 for missing workflow', () => {
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue(null);

      const { res } = createMockRes();
      workflows.handleGetWorkflow(null, res, {}, 'nonexistent');

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    it('handleGetWorkflow merges cost summary', () => {
      vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue({
        id: 'wf1',
        name: 'test',
        status: 'pending',
        summary: {
          total: 0,
          completed: 0,
          failed: 0,
          running: 0,
          blocked: 0,
          pending: 0,
          skipped: 0
        },
        tasks: {}
      });
      vi.spyOn(costTracking, 'getWorkflowCostSummary').mockReturnValue({ total: 0.25 });

      const { res } = createMockRes();
      workflows.handleGetWorkflow(null, res, {}, 'wf1');

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body.cost.total).toBe(0.25);
      expect(body.visibility.code).toBe('empty-workflow');
      expect(body.visibility.actionable).toBe(false);
    });
  });

  describe('hosts routes', () => {
    const hosts = require('../dashboard/routes/infrastructure');

    it('handleListHosts returns host list', () => {
      vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([
        { id: 'h1', name: 'test-host' },
      ]);

      const { res } = createMockRes();
      hosts.handleListHosts(null, res);

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('test-host');
    });

    it('handleGetHost returns 404 for missing host', () => {
      vi.spyOn(hostManagement, 'getOllamaHost').mockReturnValue(null);

      const { res } = createMockRes();
      hosts.handleGetHost(null, res, {}, 'nonexistent');

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });
  });

  describe('agents routes', () => {
    const agents = require('../dashboard/routes/infrastructure');
    const remoteAgentsPlugin = require('../plugins/remote-agents');
    const { RemoteAgentRegistry } = require('../plugins/remote-agents/agent-registry');

    function setupAgentDb(initialRows = []) {
      const rowsById = new Map(initialRows.map(row => [row.id, { ...row }]));
      const prepare = vi.fn((sql) => {
        if (sql.includes('SELECT * FROM remote_agents') && !sql.includes('WHERE')) {
          return { all: () => Array.from(rowsById.values()).map(r => ({ ...r })) };
        }
        if (sql.includes('WHERE id = ?')) {
          return { get: (id) => { const r = rowsById.get(id); return r ? { ...r } : undefined; } };
        }
        if (sql.includes('INSERT OR REPLACE')) {
          return {
            run: (...args) => {
              const [id, name, host, port, , max_concurrent, tls, rejectUnauthorized] = args;
              rowsById.set(id, { id, name, host, port, secret: 'hashed', max_concurrent, tls, rejectUnauthorized, status: 'unknown' });
            },
          };
        }
        if (sql.includes('enabled')) {
          return { all: () => [] };
        }
        return { all: () => [], get: () => undefined, run: () => {} };
      });
      const mockDbHandle = { prepare };
      vi.spyOn(db, 'getDbInstance').mockReturnValue(mockDbHandle);
      vi.spyOn(remoteAgentsPlugin, 'getInstalledRegistry').mockReturnValue(
        new RemoteAgentRegistry(mockDbHandle),
      );
      return rowsById;
    }

    it('handleListAgents normalizes tls fields and omits secrets', () => {
      setupAgentDb([
        {
          id: 'agent-1',
          name: 'TLS Agent',
          host: 'secure.example.test',
          port: 443,
          secret: 'super-secret',
          tls: 1,
          rejectUnauthorized: 0,
          last_health_check: '2026-03-01T00:00:00.000Z',
        },
      ]);

      const { res } = createMockRes();
      agents.handleListAgents(null, res);

      const body = parseJsonBody(res.body);
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: 'agent-1',
        tls: true,
        rejectUnauthorized: false,
        last_health_check: '2026-03-01T00:00:00.000Z',
      });
      expect(body[0]).not.toHaveProperty('secret');
    });

    it('handleCreateAgent forwards explicit tls settings', async () => {
      const rowsById = setupAgentDb([]);

      const req = createMockReq({
        method: 'POST',
        body: {
          id: 'agent-1',
          name: 'TLS Agent',
          host: 'secure.example.test',
          port: 443,
          secret: 'super-secret',
          tls: true,
          rejectUnauthorized: false,
        },
      });
      const { res, done } = createMockRes();
      await agents.handleCreateAgent(req, res);
      await done;

      const stored = rowsById.get('agent-1');
      expect(stored).toBeDefined();
      expect(stored.tls).toBe(1);
      expect(stored.rejectUnauthorized).toBe(0);
      expect(parseJsonBody(res.body)).toMatchObject({
        id: 'agent-1',
        tls: true,
        rejectUnauthorized: false,
      });
    });

    it('handleCreateAgent preserves existing tls settings when omitted on update', async () => {
      const rowsById = setupAgentDb([
        {
          id: 'agent-1',
          name: 'TLS Agent',
          host: 'old.example.test',
          port: 443,
          secret: 'old-secret',
          tls: 1,
          rejectUnauthorized: 0,
        },
      ]);

      const req = createMockReq({
        method: 'POST',
        body: {
          id: 'agent-1',
          name: 'TLS Agent',
          host: 'new.example.test',
          port: 443,
          secret: 'new-secret',
        },
      });
      const { res, done } = createMockRes();
      await agents.handleCreateAgent(req, res);
      await done;

      const stored = rowsById.get('agent-1');
      expect(stored).toBeDefined();
      expect(parseJsonBody(res.body)).toMatchObject({
        id: 'agent-1',
        host: 'new.example.test',
        tls: true,
        rejectUnauthorized: false,
      });
    });

    it('handleGetAgent returns a normalized single agent payload', () => {
      setupAgentDb([
        {
          id: 'agent-1',
          name: 'TLS Agent',
          host: 'secure.example.test',
          port: 443,
          secret: 'super-secret',
          tls: 1,
          rejectUnauthorized: 0,
        },
      ]);

      const { res } = createMockRes();
      agents.handleGetAgent(null, res, {}, 'agent-1');

      expect(parseJsonBody(res.body)).toMatchObject({
        id: 'agent-1',
        tls: true,
        rejectUnauthorized: false,
      });
    });
  });

  describe('benchmarks routes', () => {
    const benchmarks = require('../dashboard/routes/admin');

    it('handleListBenchmarks requires hostId', () => {
      const { res } = createMockRes();
      benchmarks.handleListBenchmarks(null, res, {});

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body.error).toContain('hostId');
    });

    it('handleListBenchmarks clamps limit query values to safe range', () => {
      vi.spyOn(hostManagement, 'getBenchmarkResults').mockReturnValue([]);
      vi.spyOn(hostManagement, 'getBenchmarkStats').mockReturnValue({});

      const bad = createMockRes();
      benchmarks.handleListBenchmarks(null, bad.res, { hostId: 'host-1', limit: 'not-a-number' });
      expect(hostManagement.getBenchmarkResults).toHaveBeenCalledWith('host-1', 10);

      const low = createMockRes();
      benchmarks.handleListBenchmarks(null, low.res, { hostId: 'host-1', limit: '-5' });
      expect(hostManagement.getBenchmarkResults).toHaveBeenCalledWith('host-1', 1);

      const high = createMockRes();
      benchmarks.handleListBenchmarks(null, high.res, { hostId: 'host-1', limit: '5000' });
      expect(hostManagement.getBenchmarkResults).toHaveBeenCalledWith('host-1', 1000);
    });
  });

  describe('project-tuning routes', () => {
    const tuning = require('../dashboard/routes/admin');

    it('handleListProjectTuning returns tuning list', () => {
      vi.spyOn(hostManagement, 'listProjectTuning').mockReturnValue([
        { project_path: '/foo', settings: '{}' },
      ]);

      const { res } = createMockRes();
      tuning.handleListProjectTuning(null, res);

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body).toHaveLength(1);
    });

    it('handleGetProjectTuning returns 404 for missing', () => {
      vi.spyOn(hostManagement, 'getProjectTuning').mockReturnValue(null);

      const { res } = createMockRes();
      tuning.handleGetProjectTuning(null, res, {}, 'nonexistent');

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });
  });

  describe('plan-projects routes', () => {
    const plans = require('../dashboard/routes/admin');
    const fs = require('fs');
    const tools = require('../tools');
    const logger = require('../logger');

    it('handleListPlanProjects returns projects with progress', () => {
      vi.spyOn(projectConfigCore, 'listPlanProjects').mockReturnValue([
        { id: 'p1', total_tasks: 10, completed_tasks: 5 },
      ]);

      const { res } = createMockRes();
      plans.handleListPlanProjects(null, res, {});

      const body = parseJsonBody(res.end.mock.calls[0][0]);
      expect(body.projects[0].progress).toBe(50);
    });

    it('handleGetPlanProject returns 404 for missing', () => {
      vi.spyOn(projectConfigCore, 'getPlanProject').mockReturnValue(null);

      const { res } = createMockRes();
      plans.handleGetPlanProject(null, res, {}, 'nonexistent');

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    it('handleImportPlanApi returns error when plan_content is missing', async () => {
      const { res } = createMockRes();
      const req = createMockReq({ method: 'POST', body: {} });
      await plans.handleImportPlanApi(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(parseJsonBody(res.body).error).toBe('plan_content is required');
    });

    it('handleImportPlanApi returns error when tool returns error result', async () => {
      vi.spyOn(tools, 'handleToolCall').mockResolvedValue({ error: 'Invalid import plan format' });

      const { res } = createMockRes();
      const req = createMockReq({
        method: 'POST',
        body: { plan_content: '# Example plan' },
      });
      await plans.handleImportPlanApi(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(parseJsonBody(res.body).error).toBe('Invalid import plan format');
    });

    it('handleImportPlanApi returns error when tool throws', async () => {
      vi.spyOn(tools, 'handleToolCall').mockRejectedValue(new Error('tool failed'));

      const { res } = createMockRes();
      const req = createMockReq({
        method: 'POST',
        body: { plan_content: '# Example plan' },
      });
      await plans.handleImportPlanApi(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
      expect(parseJsonBody(res.body).error).toBe('tool failed');
    });

    it('handleImportPlanApi returns error when tool returns invalid response', async () => {
      vi.spyOn(tools, 'handleToolCall').mockResolvedValue(null);

      const { res } = createMockRes();
      const req = createMockReq({
        method: 'POST',
        body: { plan_content: '# Example plan' },
      });
      await plans.handleImportPlanApi(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
      expect(parseJsonBody(res.body).error).toBe('Invalid import tool response');
    });

    it('handleImportPlanApi logs tool call and cleanup errors at debug level', async () => {
      vi.spyOn(tools, 'handleToolCall').mockResolvedValue({ success: true });
      vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
        throw new Error('unlink blocked');
      });
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      const { res } = createMockRes();
      const req = createMockReq({
        method: 'POST',
        body: { plan_content: '# Example plan' },
      });
      await plans.handleImportPlanApi(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(debugSpy).toHaveBeenCalled();

      const message = debugSpy.mock.calls.map(([message]) => message).join(' ');
      expect(message).toContain('Failed to delete temp plan import file');
    });

    it('handleImportPlanApi logs tool call errors at debug level', async () => {
      vi.spyOn(tools, 'handleToolCall').mockRejectedValue(new Error('tool failed'));
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      const { res } = createMockRes();
      const req = createMockReq({
        method: 'POST',
        body: { plan_content: '# Example plan' },
      });
      await plans.handleImportPlanApi(req, res);

      expect(debugSpy).toHaveBeenCalled();
      const message = debugSpy.mock.calls.map(([message]) => message).join(' ');
      expect(message).toContain('import_plan tool call failed');
    });
  });
});
