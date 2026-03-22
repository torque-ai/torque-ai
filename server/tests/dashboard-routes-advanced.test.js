/**
 * Advanced dashboard route tests for missing coverage around validation and edge cases.
 */
const { EventEmitter } = require('events');

const taskCore = require('../db/task-core');
const hostManagement = require('../db/host-management');
const coordination = require('../db/coordination');
const taskManager = require('../task-manager');
const utils = require('../dashboard/utils');
const benchmarks = require('../dashboard/routes/admin');
const systemRoutes = require('../dashboard/routes/infrastructure');
const tuningRoutes = require('../dashboard/routes/admin');

function createMockReq({ body, chunks, throwError, headers = {} } = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.destroy = vi.fn();

  const payloadChunks = Array.isArray(chunks)
    ? chunks
    : body === undefined
      ? []
      : [typeof body === 'string' ? body : JSON.stringify(body)];

  process.nextTick(() => {
    if (throwError) {
      req.emit('error', throwError);
      return;
    }
    for (const chunk of payloadChunks) {
      req.emit('data', chunk);
    }
    req.emit('end');
  });

  return req;
}

function createMockRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    _corsOrigin: null,
  };
  res.writeHead = vi.fn((status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  });
  res.end = vi.fn((body = '') => {
    res.body = body;
  });
  return res;
}

function parseJson(bodyText) {
  if (!bodyText) return null;
  return JSON.parse(bodyText);
}

describe('dashboard/utils.parseQuery', () => {
  it('returns {} for URLs without a query string', () => {
    expect(utils.parseQuery('/api/tasks')).toEqual({});
  });

  it('parses query parameters into string values', () => {
    expect(utils.parseQuery('/api/tasks?status=running&limit=10')).toEqual({
      status: 'running',
      limit: '10',
    });
  });

  it('supports keys without values', () => {
    expect(utils.parseQuery('/api/test?verbose')).toEqual({ verbose: '' });
  });

  it('decodes percent-encoded keys and values', () => {
    expect(utils.parseQuery('/api/test?name=hello%20world')).toEqual({
      name: 'hello world',
    });
  });

  it('supports duplicate keys by last-value-wins semantics', () => {
    expect(utils.parseQuery('/api/test?x=1&x=2&x=3')).toEqual({ x: '3' });
  });

  it('skips malformed percent-encoded pairs', () => {
    expect(utils.parseQuery('/api/test?name=%E0%A4%A')).toEqual({});
  });
});

describe('dashboard/utils.parseBody', () => {
  it('parses valid JSON body', async () => {
    const req = createMockReq({ body: { hello: 'world', ok: true } });
    const body = await utils.parseBody(req);
    expect(body).toEqual({ hello: 'world', ok: true });
  });

  it('parses arrays', async () => {
    const req = createMockReq({ body: [1, 2, 3] });
    const body = await utils.parseBody(req);
    expect(body).toEqual([1, 2, 3]);
  });

  it('returns {} when no body is sent', async () => {
    const req = createMockReq();
    const body = await utils.parseBody(req);
    expect(body).toEqual({});
  });

  it('parses body sent as separate chunks', async () => {
    const req = createMockReq({ chunks: ['{"hello":', '"chunked"}'] });
    const body = await utils.parseBody(req);
    expect(body).toEqual({ hello: 'chunked' });
  });

  it('accepts Buffer chunks', async () => {
    const req = createMockReq({ chunks: [Buffer.from('{'), Buffer.from('"v":1}') ] });
    const body = await utils.parseBody(req);
    expect(body).toEqual({ v: 1 });
  });

  it('returns null for explicit JSON null', async () => {
    const req = createMockReq({ body: 'null' });
    const body = await utils.parseBody(req);
    expect(body).toBeNull();
  });

  it('rejects invalid JSON', async () => {
    const req = createMockReq({ body: 'not json{' });
    await expect(utils.parseBody(req)).rejects.toThrow('Invalid JSON body');
  });

  it('rejects malformed JSON with whitespace noise', async () => {
    const req = createMockReq({ body: '   { "a": 1, }' });
    await expect(utils.parseBody(req)).rejects.toThrow('Invalid JSON body');
  });

  it('rejects when request emits an error', async () => {
    const req = createMockReq({ throwError: new Error('socket broke') });
    await expect(utils.parseBody(req)).rejects.toThrow('socket broke');
  });

  it('rejects bodies larger than 10MB and destroys request', async () => {
    const payload = 'x'.repeat(10 * 1024 * 1024 + 1);
    const req = createMockReq({ body: payload });
    await expect(utils.parseBody(req)).rejects.toThrow('Request body too large');
    expect(req.destroy).toHaveBeenCalled();
  });
});

describe('dashboard/utils.response helpers', () => {
  it('sendJson includes security headers and default 200', () => {
    const res = createMockRes();
    utils.sendJson(res, { ok: true });
    expect(res.writeHead).toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'application/json',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'X-XSS-Protection': '1; mode=block',
    }));
  });

  it('sendJson sets CORS header when res._corsOrigin exists', () => {
    const res = createMockRes();
    res._corsOrigin = 'http://localhost:4000';
    utils.sendJson(res, { status: 'ok' });
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Access-Control-Allow-Origin': 'http://localhost:4000',
    }));
  });

  it('sendError wraps payload as {error:...} with default 400', () => {
    const res = createMockRes();
    utils.sendError(res, 'Bad request');
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(parseJson(res.body)).toEqual({ error: 'Bad request' });
  });
});

describe('dashboard/routes/benchmarks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('handleListBenchmarks requires hostId', () => {
    const res = createMockRes();
    benchmarks.handleListBenchmarks(null, res, {});
    expect(res.statusCode).toBe(400);
    expect(parseJson(res.body)).toEqual({ error: 'hostId is required' });
  });

  it('handleListBenchmarks trims query limit values above upper bound', () => {
    vi.spyOn(hostManagement, 'getBenchmarkResults').mockReturnValue([]);
    vi.spyOn(hostManagement, 'getBenchmarkStats').mockReturnValue({});
    const res = createMockRes();
    benchmarks.handleListBenchmarks(null, res, { hostId: 'h1', limit: '50000' });
    expect(hostManagement.getBenchmarkResults).toHaveBeenCalledWith('h1', 1000);
  });

  it('handleListBenchmarks clamps query limit below one to one', () => {
    vi.spyOn(hostManagement, 'getBenchmarkResults').mockReturnValue([]);
    vi.spyOn(hostManagement, 'getBenchmarkStats').mockReturnValue({});
    const res = createMockRes();
    benchmarks.handleListBenchmarks(null, res, { hostId: 'h1', limit: '0' });
    expect(hostManagement.getBenchmarkResults).toHaveBeenCalledWith('h1', 1);
  });

  it('handleListBenchmarks defaults non-numeric limit to 10', () => {
    vi.spyOn(hostManagement, 'getBenchmarkResults').mockReturnValue([]);
    vi.spyOn(hostManagement, 'getBenchmarkStats').mockReturnValue({});
    const res = createMockRes();
    benchmarks.handleListBenchmarks(null, res, { hostId: 'h1', limit: 'abc' });
    expect(hostManagement.getBenchmarkResults).toHaveBeenCalledWith('h1', 10);
  });

  it('handleListBenchmarks accepts integer-like and rounded float query values', () => {
    vi.spyOn(hostManagement, 'getBenchmarkResults').mockReturnValue([]);
    vi.spyOn(hostManagement, 'getBenchmarkStats').mockReturnValue({});
    const res = createMockRes();
    benchmarks.handleListBenchmarks(null, res, { hostId: 'h1', limit: '10.9' });
    expect(hostManagement.getBenchmarkResults).toHaveBeenCalledWith('h1', 10);
  });

  it('handleListBenchmarks responds with results and stats objects', () => {
    vi.spyOn(hostManagement, 'getBenchmarkResults').mockReturnValue([{ id: 'b1' }]);
    vi.spyOn(hostManagement, 'getBenchmarkStats').mockReturnValue({ total: 1 });
    const res = createMockRes();
    benchmarks.handleListBenchmarks(null, res, { hostId: 'h1', limit: '1' });
    const body = parseJson(res.body);
    expect(body).toEqual({ results: [{ id: 'b1' }], stats: { total: 1 } });
    expect(res.statusCode).toBe(200);
  });

  it('handleApplyBenchmark requires hostId', async () => {
    const req = createMockReq({ body: { model: 'phi' } });
    const res = createMockRes();
    await benchmarks.handleApplyBenchmark(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseJson(res.body)).toEqual({ error: 'hostId is required' });
  });

  it('handleApplyBenchmark forwards hostId and model to db', async () => {
    vi.spyOn(hostManagement, 'applyBenchmarkResults').mockReturnValue({ ok: true });
    const req = createMockReq({ body: { hostId: 'h1', model: 'llama' } });
    const res = createMockRes();
    await benchmarks.handleApplyBenchmark(req, res);
    expect(hostManagement.applyBenchmarkResults).toHaveBeenCalledWith('h1', 'llama');
    expect(parseJson(res.body)).toEqual({ ok: true });
  });

  it('handleApplyBenchmark accepts optional model field as undefined', async () => {
    vi.spyOn(hostManagement, 'applyBenchmarkResults').mockReturnValue({ applied: true });
    const req = createMockReq({ body: { hostId: 'h1' } });
    const res = createMockRes();
    await benchmarks.handleApplyBenchmark(req, res);
    expect(hostManagement.applyBenchmarkResults).toHaveBeenCalledWith('h1', undefined);
    expect(parseJson(res.body)).toEqual({ applied: true });
  });

  it('handleApplyBenchmark rejects malformed request body JSON', async () => {
    const req = createMockReq({ body: 'invalid-json' });
    const res = createMockRes();
    await expect(benchmarks.handleApplyBenchmark(req, res)).rejects.toThrow('Invalid JSON body');
  });
});

describe('dashboard/routes/system', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockSystemMemoryAndCounts({ heapUsed = 128, heapTotal = 512, uptimeSeconds = 3661, running = 2, queued = 1 }) {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      heapUsed: heapUsed * 1024 * 1024,
      heapTotal: heapTotal * 1024 * 1024,
      rss: heapUsed * 1024 * 1024,
      external: 0,
    });
    vi.spyOn(process, 'uptime').mockReturnValue(uptimeSeconds);
    vi.spyOn(process, 'version', 'get').mockReturnValue('v99.0');
    vi.spyOn(taskCore, 'countTasks').mockImplementation(({ status }) => {
      if (status === 'running') return running;
      if (status === 'queued') return queued;
      return 0;
    });
  }

  it('handleSystemStatus returns healthy status for safe heap usage', () => {
    mockSystemMemoryAndCounts({ heapUsed: 500, heapTotal: 1000 });
    vi.spyOn(taskManager, 'getMcpInstanceId').mockReturnValue('instance-abc123456789');
    const res = createMockRes();
    systemRoutes.handleSystemStatus(null, res, {}, { clients: new Set([1, 2]), serverPort: 3001 });
    const body = parseJson(res.body);
    expect(body.memory.status).toBe('healthy');
    expect(body.memory.heapPercent).toBe(50);
    expect(body.memory.heapUsedMB).toBe(500);
    expect(body.uptime.formatted).toBe('1h 1m');
    expect(body.connections.websocket).toBe(2);
    expect(body.instance.shortId).toBe('456789');
    expect(body.version).toBeTruthy();
    expect(body.nodeVersion).toBe('v99.0');
  });

  it('handleSystemStatus reports warning at 80% heap usage', () => {
    mockSystemMemoryAndCounts({ heapUsed: 80, heapTotal: 100 });
    vi.spyOn(taskManager, 'getMcpInstanceId').mockReturnValue('instance-a1');
    const res = createMockRes();
    systemRoutes.handleSystemStatus(null, res, {}, { clients: new Set(), serverPort: 3000 });
    const body = parseJson(res.body);
    expect(body.memory.status).toBe('warning');
    expect(body.tasks.running).toBe(2);
    expect(body.tasks.queued).toBe(1);
  });

  it('handleSystemStatus reports elevated at 70% heap usage', () => {
    mockSystemMemoryAndCounts({ heapUsed: 70, heapTotal: 100 });
    vi.spyOn(taskManager, 'getMcpInstanceId').mockReturnValue('instance-a2');
    const res = createMockRes();
    systemRoutes.handleSystemStatus(null, res, {}, { clients: new Set([1]), serverPort: 3000 });
    const body = parseJson(res.body);
    expect(body.memory.status).toBe('elevated');
    expect(body.connections.websocket).toBe(1);
  });

  it('handleSystemStatus reports critical at 95% heap usage', () => {
    mockSystemMemoryAndCounts({ heapUsed: 95, heapTotal: 100 });
    vi.spyOn(taskManager, 'getMcpInstanceId').mockReturnValue('instance-a3');
    const res = createMockRes();
    systemRoutes.handleSystemStatus(null, res, {}, { clients: new Set(), serverPort: 3000 });
    const body = parseJson(res.body);
    expect(body.memory.status).toBe('critical');
  });

  it('handleSystemStatus includes current instance fields', () => {
    mockSystemMemoryAndCounts({});
    vi.spyOn(taskManager, 'getMcpInstanceId').mockReturnValue('instance-abcdeffedcba');
    const res = createMockRes();
    systemRoutes.handleSystemStatus(null, res, {}, { clients: new Set([1]), serverPort: 5000 });
    const body = parseJson(res.body);
    expect(body.instance.id).toBe('instance-abcdeffedcba');
    expect(body.instance.shortId).toBe('fedcba');
    expect(body.instance.pid).toBe(process.pid);
    expect(body.instance.port).toBe(5000);
  });

  it('handleSystemStatus propagates db errors as thrown', () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      heapUsed: 100 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      rss: 100 * 1024 * 1024,
      external: 0,
    });
    vi.spyOn(process, 'uptime').mockReturnValue(100);
    vi.spyOn(process, 'version', 'get').mockReturnValue('v99.0');
    vi.spyOn(taskManager, 'getMcpInstanceId').mockReturnValue('instance-err');
    vi.spyOn(taskCore, 'countTasks').mockImplementation(() => {
      throw new Error('count failed');
    });
    const res = createMockRes();
    expect(() => systemRoutes.handleSystemStatus(null, res, {}, { clients: new Set(), serverPort: 3000 }))
      .toThrow('count failed');
  });

  it('handleInstances marks current instance in list and enriches shortId', () => {
    const now = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(taskManager, 'getMcpInstanceId').mockReturnValue('instance-current-abcdef');
    vi.spyOn(coordination, 'getActiveInstances').mockReturnValue([
      { instanceId: 'instance-current-abcdef', pid: 12, port: 1111, startedAt: new Date(now - 90 * 1000).toISOString() },
      { instanceId: 'instance-other', pid: 22, port: 2222, startedAt: new Date(now - 120 * 1000).toISOString() },
    ]);

    const res = createMockRes();
    systemRoutes.handleInstances(null, res, {}, { serverPort: 7000 });
    const body = parseJson(res.body);

    expect(body.current.instanceId).toBe('instance-current-abcdef');
    expect(body.current.uptime).toBe('1m');
    expect(body.instances[0].isCurrent).toBe(true);
    expect(body.instances[0].shortId).toBe('instance-current-abcdef'.slice(-6));
    expect(body.instances[1].isCurrent).toBe(false);
    expect(body.instances[1].shortId).toBe('instance-other'.slice(-6));
  });

  it('handleInstances returns null uptime when current instance not in active list', () => {
    vi.spyOn(taskManager, 'getMcpInstanceId').mockReturnValue('instance-missing');
    vi.spyOn(coordination, 'getActiveInstances').mockReturnValue([
      { instanceId: 'instance-other', pid: 22, port: 2222, startedAt: new Date(Date.now()).toISOString() },
    ]);
    const res = createMockRes();
    systemRoutes.handleInstances(null, res, {}, { serverPort: 4000 });
    const body = parseJson(res.body);
    expect(body.current.instanceId).toBe('instance-missing');
    expect(body.current.uptime).toBeUndefined();
    expect(body.current.port).toBe(4000);
    expect(body.instances[0].isCurrent).toBe(false);
  });
});

describe('dashboard/routes/project-tuning', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('handleListProjectTuning returns whatever db provides', () => {
    vi.spyOn(hostManagement, 'listProjectTuning').mockReturnValue([{ projectPath: '/a', settings: {} }]);
    const res = createMockRes();
    tuningRoutes.handleListProjectTuning(null, res);
    expect(parseJson(res.body)).toEqual([{ projectPath: '/a', settings: {} }]);
  });

  it('handleGetProjectTuning returns decoded path match and 404 when missing', () => {
    vi.spyOn(hostManagement, 'getProjectTuning').mockReturnValue(null);
    const res = createMockRes();
    tuningRoutes.handleGetProjectTuning(null, res, {}, '%2Ftmp%2Fproj%20one');
    expect(hostManagement.getProjectTuning).toHaveBeenCalledWith('/tmp/proj one');
    expect(res.statusCode).toBe(404);
    expect(parseJson(res.body)).toEqual({ error: 'Project tuning not found' });
  });

  it('handleGetProjectTuning returns tuning payload when found', () => {
    vi.spyOn(hostManagement, 'getProjectTuning').mockReturnValue({ projectPath: '/tmp/proj', settings: { a: 1 } });
    const res = createMockRes();
    tuningRoutes.handleGetProjectTuning(null, res, {}, '/tmp%2Fproj');
    expect(hostManagement.getProjectTuning).toHaveBeenCalledWith('/tmp/proj');
    expect(parseJson(res.body)).toEqual({ projectPath: '/tmp/proj', settings: { a: 1 } });
  });

  it('handleCreateProjectTuning requires projectPath', async () => {
    const req = createMockReq({ body: { settings: {} } });
    const res = createMockRes();
    await tuningRoutes.handleCreateProjectTuning(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseJson(res.body)).toEqual({ error: 'projectPath is required' });
  });

  it('handleCreateProjectTuning treats empty string projectPath as missing', async () => {
    const req = createMockReq({ body: { projectPath: '', settings: {} } });
    const res = createMockRes();
    await tuningRoutes.handleCreateProjectTuning(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseJson(res.body)).toEqual({ error: 'projectPath is required' });
  });

  it('handleCreateProjectTuning requires settings', async () => {
    const req = createMockReq({ body: { projectPath: '/tmp/proj' } });
    const res = createMockRes();
    await tuningRoutes.handleCreateProjectTuning(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseJson(res.body)).toEqual({ error: 'settings is required' });
  });

  it('handleCreateProjectTuning accepts non-object settings for now (validation gap guard)', async () => {
    vi.spyOn(hostManagement, 'setProjectTuning').mockReturnValue(true);
    const req = createMockReq({ body: { projectPath: '/tmp/proj', settings: 'not-an-object' } });
    const res = createMockRes();
    await tuningRoutes.handleCreateProjectTuning(req, res);
    expect(hostManagement.setProjectTuning).toHaveBeenCalledWith('/tmp/proj', 'not-an-object', undefined);
    expect(parseJson(res.body)).toEqual({ success: true });
  });

  it('handleCreateProjectTuning supports optional description field', async () => {
    vi.spyOn(hostManagement, 'setProjectTuning').mockReturnValue(true);
    const req = createMockReq({ body: { projectPath: '/tmp/proj', settings: { a: 1 }, description: 'baseline' } });
    const res = createMockRes();
    await tuningRoutes.handleCreateProjectTuning(req, res);
    expect(hostManagement.setProjectTuning).toHaveBeenCalledWith('/tmp/proj', { a: 1 }, 'baseline');
    expect(parseJson(res.body)).toEqual({ success: true });
  });

  it('handleCreateProjectTuning rejects null body payload with type error', async () => {
    const req = createMockReq({ body: 'null' });
    const res = createMockRes();
    await expect(tuningRoutes.handleCreateProjectTuning(req, res)).rejects.toThrow();
  });

  it('handleDeleteProjectTuning decodes path and returns success', () => {
    vi.spyOn(hostManagement, 'deleteProjectTuning').mockReturnValue(true);
    const res = createMockRes();
    tuningRoutes.handleDeleteProjectTuning(null, res, {}, '%2Ftmp%2Fproj%20one');
    expect(hostManagement.deleteProjectTuning).toHaveBeenCalledWith('/tmp/proj one');
    expect(parseJson(res.body)).toEqual({ success: true });
  });
});
