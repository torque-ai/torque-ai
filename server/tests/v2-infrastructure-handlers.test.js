'use strict';

const { EventEmitter } = require('events');

const HANDLER_MODULE = '../api/v2-infrastructure-handlers';
const CONTROL_PLANE_MODULE = '../api/v2-control-plane';
const MODULE_PATHS = [
  HANDLER_MODULE,
  CONTROL_PLANE_MODULE,
  '../api/middleware',
  '../database',
  '../db/email-peek',
  '../db/task-core',
  '../db/host-management',
  '../db/coordination',
  '../workstation/model',
  '../handlers/workstation-handlers',
  '../discovery',
  '../utils/host-monitoring',
];

const state = {
  ollamaHosts: new Map(),
  hostSettings: new Map(),
  workstations: new Map(),
  peekHosts: new Map(),
  credentials: new Map(),
  agents: new Map(),
};

const mockDb = {
  listPeekHosts: vi.fn(),
  getPeekHost: vi.fn(),
  registerPeekHost: vi.fn(),
  unregisterPeekHost: vi.fn(),
  updatePeekHost: vi.fn(),
  getDbInstance: vi.fn(),
  getProviderPercentiles: vi.fn(),
  listTasks: vi.fn(),
};

const mockCoordination = {
  getCoordinationDashboard: vi.fn(),
};

const mockHostManagement = {
  listOllamaHosts: vi.fn(),
  getOllamaHost: vi.fn(),
  updateOllamaHost: vi.fn(),
  removeOllamaHost: vi.fn(),
  recordHostHealthCheck: vi.fn(),
  getHostSettings: vi.fn(),
  listCredentials: vi.fn(),
  saveCredential: vi.fn(),
  deleteCredential: vi.fn(),
  deleteAllHostCredentials: vi.fn(),
};

const mockWorkstationModel = {
  listWorkstations: vi.fn(),
  createWorkstation: vi.fn(),
  getWorkstationByName: vi.fn(),
  updateWorkstation: vi.fn(),
  removeWorkstation: vi.fn(),
};

const mockWorkstationHandlers = {
  handleProbeWorkstation: vi.fn(),
};

const mockRegistry = {
  getAll: vi.fn(),
  get: vi.fn(),
  register: vi.fn(),
  getClient: vi.fn(),
  runHealthChecks: vi.fn(),
  remove: vi.fn(),
};

const mockDiscovery = {
  scanNetworkForOllama: vi.fn(),
};

const mockHostMonitoring = {
  getHostActivity: vi.fn(),
};

const mockParseBody = vi.fn();
const mockSendJson = vi.fn();
const mockMiddleware = {
  parseBody: mockParseBody,
  sendJson: mockSendJson,
};

const mockTaskManager = {
  init: vi.fn(),
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

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function credentialKey(hostName, hostType) {
  return `${hostType}:${hostName}`;
}

function ensureCredentialBucket(hostName, hostType) {
  const key = credentialKey(hostName, hostType);
  if (!state.credentials.has(key)) {
    state.credentials.set(key, new Map());
  }
  return state.credentials.get(key);
}

function seedOllamaHost(host) {
  const id = host.id || host.name;
  state.ollamaHosts.set(id, {
    id,
    name: id,
    enabled: 1,
    running_tasks: 0,
    status: 'healthy',
    consecutive_failures: 0,
    ...clone(host),
  });
}

function seedPeekHost(host) {
  state.peekHosts.set(host.name, {
    name: host.name,
    url: host.url,
    enabled: 1,
    platform: null,
    ssh: null,
    is_default: 0,
    ...clone(host),
  });
}

function seedWorkstation(workstation) {
  const name = workstation.name;
  state.workstations.set(name, {
    id: workstation.id || `ws-${state.workstations.size + 1}`,
    name,
    host: workstation.host || '10.0.0.12',
    agent_port: workstation.agent_port || 3460,
    enabled: 1,
    status: 'healthy',
    running_tasks: 0,
    max_concurrent: 3,
    ...clone(workstation),
  });
}

function seedCredential(hostName, hostType, credential) {
  const bucket = ensureCredentialBucket(hostName, hostType);
  bucket.set(credential.credential_type, {
    host_name: hostName,
    host_type: hostType,
    label: null,
    ...clone(credential),
  });
}

function seedAgent(agent) {
  state.agents.set(agent.id, {
    enabled: 1,
    status: 'unknown',
    consecutive_failures: 0,
    created_at: '2026-03-01T00:00:00.000Z',
    ...clone(agent),
  });
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
  const res = { statusCode: 200, headers: {}, _body: null,
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

function createNoopRequest() {
  return {
    on() { return this; },
    destroy: vi.fn(),
  };
}

function mockProbe(moduleName, {
  statusCode = 200,
  body = '{}',
  mode = 'response',
} = {}) {
  return vi.spyOn(require(moduleName), 'get').mockImplementation((href, options, callback) => {
    const handlers = {};
    const request = {
      on(event, handler) {
        handlers[event] = handler;
        return this;
      },
      destroy: vi.fn(),
    };

    if (mode === 'response') {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      callback(response);
      process.nextTick(() => {
        if (body !== undefined) response.emit('data', body);
        response.emit('end');
      });
    } else if (mode === 'error') {
      process.nextTick(() => {
        if (handlers.error) handlers.error(new Error('probe failed'));
      });
    } else if (mode === 'timeout') {
      process.nextTick(() => {
        if (handlers.timeout) handlers.timeout();
      });
    }

    expect(options).toEqual({ timeout: 5000 });
    expect(href).toMatch(/\/api\/tags$/);
    return request;
  });
}

function resetState() {
  state.ollamaHosts.clear();
  state.hostSettings.clear();
  state.workstations.clear();
  state.peekHosts.clear();
  state.credentials.clear();
  state.agents.clear();
}

function resetMockDefaults() {
  resetState();

  mockHostManagement.listOllamaHosts.mockReset().mockImplementation(() => Array.from(state.ollamaHosts.values()).map(clone));
  mockHostManagement.getOllamaHost.mockReset().mockImplementation((hostId) => clone(state.ollamaHosts.get(hostId)) || null);
  mockHostManagement.updateOllamaHost.mockReset().mockImplementation((hostId, updates) => {
    const existing = state.ollamaHosts.get(hostId);
    if (!existing) return { changes: 0 };
    state.ollamaHosts.set(hostId, { ...existing, ...clone(updates) });
    return { changes: 1 };
  });
  mockHostManagement.removeOllamaHost.mockReset().mockImplementation((hostId) => state.ollamaHosts.delete(hostId));
  mockHostManagement.recordHostHealthCheck.mockReset().mockImplementation(() => undefined);
  mockHostManagement.getHostSettings.mockReset().mockImplementation((hostId) => clone(state.hostSettings.get(hostId)) || {});

  mockWorkstationModel.listWorkstations.mockReset().mockImplementation((filters = {}) => Array.from(state.workstations.values())
    .filter((workstation) => {
      if (filters.enabled !== undefined) {
        return Boolean(workstation.enabled) === Boolean(filters.enabled);
      }
      return true;
    })
    .map(clone));
  mockWorkstationModel.createWorkstation.mockReset().mockImplementation((data) => {
    const created = {
      id: data.id || `ws-${state.workstations.size + 1}`,
      status: 'unknown',
      enabled: data.enabled !== undefined ? data.enabled : 1,
      running_tasks: 0,
      ...clone(data),
    };
    state.workstations.set(created.name, created);
    return clone(created);
  });
  mockWorkstationModel.getWorkstationByName.mockReset().mockImplementation((name) => clone(state.workstations.get(name)) || null);
  mockWorkstationModel.updateWorkstation.mockReset().mockImplementation((id, updates) => {
    const entry = Array.from(state.workstations.values()).find((workstation) => workstation.id === id);
    if (!entry) return null;
    const next = { ...entry, ...clone(updates) };
    state.workstations.set(next.name, next);
    return clone(next);
  });
  mockWorkstationModel.removeWorkstation.mockReset().mockImplementation((id) => {
    const entry = Array.from(state.workstations.values()).find((workstation) => workstation.id === id);
    if (!entry) return null;
    state.workstations.delete(entry.name);
    return clone(entry);
  });
  mockWorkstationHandlers.handleProbeWorkstation.mockReset().mockResolvedValue({ isError: false });

  mockDb.listPeekHosts.mockReset().mockImplementation(() => Array.from(state.peekHosts.values()).map(clone));
  mockDb.getPeekHost.mockReset().mockImplementation((hostName) => clone(state.peekHosts.get(hostName)) || null);
  mockDb.registerPeekHost.mockReset().mockImplementation((name, url, ssh, isDefault, platform) => {
    state.peekHosts.set(name, {
      name,
      url,
      ssh: ssh || null,
      is_default: isDefault ? 1 : 0,
      platform: platform || null,
      enabled: 1,
    });
    return true;
  });
  mockDb.unregisterPeekHost.mockReset().mockImplementation((hostName) => state.peekHosts.delete(hostName));
  mockDb.updatePeekHost.mockReset().mockImplementation((hostName, updates) => {
    const existing = state.peekHosts.get(hostName);
    if (!existing) return { changes: 0 };
    state.peekHosts.set(hostName, { ...existing, ...clone(updates) });
    return { changes: 1 };
  });
  mockDb.getDbInstance.mockReset();

  mockHostManagement.listCredentials.mockReset().mockImplementation((hostName, hostType) => {
    const bucket = state.credentials.get(credentialKey(hostName, hostType));
    if (!bucket) return [];
    return Array.from(bucket.values()).map((entry) => {
      const { value: _value, ...safe } = entry;
      return clone(safe);
    });
  });
  mockHostManagement.saveCredential.mockReset().mockImplementation((hostName, hostType, credType, label, value) => {
    const bucket = ensureCredentialBucket(hostName, hostType);
    bucket.set(credType, {
      host_name: hostName,
      host_type: hostType,
      credential_type: credType,
      label: label || null,
      value: clone(value),
    });
    return true;
  });
  mockHostManagement.deleteCredential.mockReset().mockImplementation((hostName, hostType, credType) => {
    const bucket = state.credentials.get(credentialKey(hostName, hostType));
    return bucket ? bucket.delete(credType) : false;
  });
  mockHostManagement.deleteAllHostCredentials.mockReset().mockImplementation((hostName, hostType) => {
    state.credentials.delete(credentialKey(hostName, hostType));
    return true;
  });

  mockRegistry.getAll.mockReset().mockImplementation(() => Array.from(state.agents.values()).map(clone));
  mockRegistry.get.mockReset().mockImplementation((agentId) => clone(state.agents.get(agentId)));
  mockRegistry.register.mockReset().mockImplementation((agent) => {
    const existing = state.agents.get(agent.id) || {};
    state.agents.set(agent.id, {
      ...existing,
      id: agent.id,
      name: agent.name,
      host: agent.host,
      port: agent.port,
      secret: agent.secret,
      max_concurrent: agent.max_concurrent,
      tls: agent.tls ? 1 : 0,
      rejectUnauthorized: agent.rejectUnauthorized ? 1 : 0,
      created_at: existing.created_at || '2026-03-01T00:00:00.000Z',
      status: existing.status || 'unknown',
      consecutive_failures: existing.consecutive_failures || 0,
    });
  });
  mockRegistry.getClient.mockReset().mockReturnValue(null);
  mockRegistry.runHealthChecks.mockReset().mockImplementation(async () => {
    const now = new Date(Date.now()).toISOString();
    const results = [];

    for (const agent of Array.from(state.agents.values())) {
      if (!agent.enabled) continue;

      const client = mockRegistry.getClient(agent.id);
      if (!client) continue;

      const result = await client.checkHealth();
      const current = state.agents.get(agent.id);
      if (!current) continue;

      if (result) {
        state.agents.set(agent.id, {
          ...current,
          status: 'healthy',
          consecutive_failures: 0,
          last_health_check: now,
          last_healthy: now,
          metrics: JSON.stringify(result.system || {}),
        });
        results.push({ id: agent.id, status: 'healthy' });
        continue;
      }

      const failures = (current.consecutive_failures || 0) + 1;
      const status = failures >= 3 ? 'down' : 'degraded';
      state.agents.set(agent.id, {
        ...current,
        status,
        consecutive_failures: failures,
        last_health_check: now,
      });
      results.push({ id: agent.id, status, failures });
    }

    return results;
  });
  mockRegistry.remove.mockReset().mockImplementation((agentId) => state.agents.delete(agentId));

  mockDiscovery.scanNetworkForOllama.mockReset().mockResolvedValue({ totalFound: 0, hosts: [] });

  mockHostMonitoring.getHostActivity.mockReset().mockReturnValue({});
  mockDb.listTasks.mockReset().mockReturnValue([]);
  mockDb.getProviderPercentiles.mockReset().mockReturnValue({});
  mockCoordination.getCoordinationDashboard.mockReset().mockReturnValue({ agents: [], rules: [], claims: [] });

  mockParseBody.mockReset().mockResolvedValue({});
  mockSendJson.mockReset().mockImplementation((res, data, status = 200, req = null) => {
    const headers = { 'Content-Type': 'application/json' };
    if (req?.requestId) {
      headers['X-Request-ID'] = req.requestId;
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(data));
  });

  mockTaskManager.init.mockReset();
}

function loadHandlers() {
  clearLoadedModules();
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../db/email-peek', mockDb);
  installCjsModuleMock('../db/task-core', mockDb);
  installCjsModuleMock('../db/host-management', mockHostManagement);
  installCjsModuleMock('../db/coordination', mockCoordination);
  installCjsModuleMock('../workstation/model', mockWorkstationModel);
  installCjsModuleMock('../handlers/workstation-handlers', mockWorkstationHandlers);
  installCjsModuleMock('../api/middleware', mockMiddleware);
  installCjsModuleMock('../discovery', mockDiscovery);
  installCjsModuleMock('../utils/host-monitoring', mockHostMonitoring);
  require(CONTROL_PLANE_MODULE);
  return require(HANDLER_MODULE);
}

describe('api/v2-infrastructure-handlers', () => {
  let handlers;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    vi.restoreAllMocks();
    resetMockDefaults();
    handlers = loadHandlers();
    handlers.init({ taskManager: mockTaskManager, remoteAgentRegistry: mockRegistry });
  });

  afterEach(() => {
    clearLoadedModules();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('handleToggleWorkstation', () => {
    it('returns 404 when the workstation does not exist', async () => {
      const res = createMockRes();

      await handlers.handleToggleWorkstation(
        createReq({ params: { workstation_name: 'missing-workstation' }, body: {} }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'workstation_not_found',
        message: 'Workstation not found: missing-workstation',
      });
    });

    it('toggles an enabled workstation off by default', async () => {
      seedWorkstation({ id: 'ws-a', name: 'builder-01', enabled: 1, status: 'healthy' });
      const res = createMockRes();

      await handlers.handleToggleWorkstation(
        createReq({ params: { workstation_name: 'builder-01' }, body: {} }),
        res,
      );

      expect(mockWorkstationModel.updateWorkstation).toHaveBeenCalledWith('ws-a', { enabled: 0 });
      expect(expectSuccess(res)).toEqual(expect.objectContaining({
        id: 'ws-a',
        name: 'builder-01',
        enabled: 0,
      }));
    });

    it('parses the body and respects explicit enabled=true', async () => {
      seedWorkstation({ id: 'ws-b', name: 'builder-02', enabled: 0, status: 'down' });
      mockParseBody.mockResolvedValue({ enabled: true });
      const res = createMockRes();

      await handlers.handleToggleWorkstation(
        createReq({ params: { workstation_name: 'builder-02' } }),
        res,
      );

      expect(mockParseBody).toHaveBeenCalledOnce();
      expect(mockWorkstationModel.updateWorkstation).toHaveBeenCalledWith('ws-b', { enabled: 1 });
      expect(expectSuccess(res)).toEqual(expect.objectContaining({
        id: 'ws-b',
        name: 'builder-02',
        enabled: 1,
      }));
    });
  });

  describe('handleListHosts', () => {
    it('returns the ollama host list in a list envelope', async () => {
      seedOllamaHost({ id: 'host-a', url: 'http://host-a:11434' });
      seedOllamaHost({ id: 'host-b', url: 'http://host-b:11434', enabled: 0 });
      const res = createMockRes();

      await handlers.handleListHosts(createReq(), res);

      expectList(res, {
        items: [
          expect.objectContaining({ id: 'host-a', url: 'http://host-a:11434' }),
          expect.objectContaining({ id: 'host-b', url: 'http://host-b:11434', enabled: 0 }),
        ],
        total: 2,
      });
    });

    it('returns an empty list when no hosts exist', async () => {
      const res = createMockRes();

      await handlers.handleListHosts(createReq(), res);

      expectList(res, { items: [], total: 0 });
    });
  });

  describe('handleGetHost', () => {
    it('returns a host with its settings', async () => {
      seedOllamaHost({ id: 'host-a', name: 'Alpha', url: 'http://alpha:11434' });
      state.hostSettings.set('host-a', { schedule: 'nightly', tags: ['gpu'] });
      const res = createMockRes();

      await handlers.handleGetHost(createReq({ params: { host_id: 'host-a' } }), res);

      expect(expectSuccess(res)).toEqual({
        id: 'host-a',
        name: 'Alpha',
        url: 'http://alpha:11434',
        enabled: 1,
        running_tasks: 0,
        status: 'healthy',
        consecutive_failures: 0,
        settings: { schedule: 'nightly', tags: ['gpu'] },
      });
    });

    it('defaults settings to an empty object when none are stored', async () => {
      seedOllamaHost({ id: 'host-b', url: 'http://beta:11434' });
      const res = createMockRes();

      await handlers.handleGetHost(createReq({ params: { host_id: 'host-b' } }), res);

      expect(expectSuccess(res).settings).toEqual({});
    });

    it('returns 404 when the host does not exist', async () => {
      const res = createMockRes();

      await handlers.handleGetHost(createReq({ params: { host_id: 'missing-host' } }), res);

      expectError(res, {
        status: 404,
        code: 'host_not_found',
        message: 'Host not found: missing-host',
      });
    });
  });

  describe('handleToggleHost', () => {
    it('returns 404 when the host does not exist', async () => {
      const res = createMockRes();

      await handlers.handleToggleHost(
        createReq({ params: { host_id: 'missing-host' }, body: {} }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'host_not_found',
        message: 'Host not found: missing-host',
      });
    });

    it('toggles an enabled host off by default and does not probe', async () => {
      seedOllamaHost({ id: 'host-a', url: 'http://alpha:11434', enabled: 1, status: 'healthy' });
      const httpGet = vi.spyOn(require('http'), 'get').mockImplementation(() => createNoopRequest());
      const httpsGet = vi.spyOn(require('https'), 'get').mockImplementation(() => createNoopRequest());
      const res = createMockRes();

      await handlers.handleToggleHost(
        createReq({ params: { host_id: 'host-a' }, body: {} }),
        res,
      );

      expect(mockHostManagement.updateOllamaHost).toHaveBeenCalledWith('host-a', {
        enabled: 0,
        status: 'unknown',
        consecutive_failures: 0,
      });
      expect(mockHostManagement.recordHostHealthCheck).not.toHaveBeenCalled();
      expect(httpGet).not.toHaveBeenCalled();
      expect(httpsGet).not.toHaveBeenCalled();
      expect(expectSuccess(res)).toEqual(expect.objectContaining({
        id: 'host-a',
        enabled: 0,
        status: 'unknown',
        consecutive_failures: 0,
      }));
    });

    it('parses the body, enables a host, and records a healthy http probe result', async () => {
      seedOllamaHost({ id: 'host-b', url: 'http://beta:11434', enabled: 0 });
      mockParseBody.mockResolvedValue({ enabled: true });
      const httpGet = mockProbe('http', {
        statusCode: 200,
        body: JSON.stringify({ models: [{ name: 'llama3' }, { model: 'mistral' }] }),
      });
      const res = createMockRes();

      await handlers.handleToggleHost(createReq({ params: { host_id: 'host-b' } }), res);

      expect(mockParseBody).toHaveBeenCalled();
      expect(httpGet).toHaveBeenCalledOnce();
      expect(mockHostManagement.recordHostHealthCheck).toHaveBeenCalledWith('host-b', true, ['llama3', 'mistral']);
      expect(expectSuccess(res)).toEqual(expect.objectContaining({
        id: 'host-b',
        enabled: 1,
        status: 'unknown',
      }));
    });

    it('uses the https client and records healthy status with null models on invalid JSON', async () => {
      seedOllamaHost({ id: 'host-c', url: 'https://gamma:11434', enabled: 0 });
      const httpGet = vi.spyOn(require('http'), 'get').mockImplementation(() => createNoopRequest());
      const httpsGet = mockProbe('https', {
        statusCode: 200,
        body: '{invalid-json',
      });
      const res = createMockRes();

      await handlers.handleToggleHost(
        createReq({ params: { host_id: 'host-c' }, body: { enabled: true } }),
        res,
      );

      expect(httpGet).not.toHaveBeenCalled();
      expect(httpsGet).toHaveBeenCalledOnce();
      expect(mockHostManagement.recordHostHealthCheck).toHaveBeenCalledWith('host-c', true, null);
      expect(expectSuccess(res).enabled).toBe(1);
    });

    it('records an unhealthy probe when the response is not 200', async () => {
      seedOllamaHost({ id: 'host-d', url: 'http://delta:11434', enabled: 0 });
      mockProbe('http', { statusCode: 503, body: 'unavailable' });
      const res = createMockRes();

      await handlers.handleToggleHost(
        createReq({ params: { host_id: 'host-d' }, body: { enabled: true } }),
        res,
      );

      expect(mockHostManagement.recordHostHealthCheck).toHaveBeenCalledWith('host-d', false, null);
      expect(expectSuccess(res).enabled).toBe(1);
    });

    it('swallows probe setup failures and still returns the updated host', async () => {
      seedOllamaHost({ id: 'host-e', url: 'not-a-valid-url', enabled: 0 });
      const res = createMockRes();

      await handlers.handleToggleHost(
        createReq({ params: { host_id: 'host-e' }, body: { enabled: true } }),
        res,
      );

      expect(mockHostManagement.recordHostHealthCheck).not.toHaveBeenCalled();
      expect(expectSuccess(res)).toEqual(expect.objectContaining({
        id: 'host-e',
        enabled: 1,
      }));
    });

    it('returns 500 when the update fails', async () => {
      seedOllamaHost({ id: 'host-f', url: 'http://foxtrot:11434' });
      mockHostManagement.updateOllamaHost.mockImplementation(() => {
        throw new Error('toggle failed');
      });
      const res = createMockRes();

      await handlers.handleToggleHost(
        createReq({ params: { host_id: 'host-f' }, body: { enabled: false } }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'toggle failed',
      });
    });
  });

  describe('handleDeleteHost', () => {
    it('deletes a host when it has no running tasks', async () => {
      seedOllamaHost({ id: 'host-a', name: 'Alpha', running_tasks: 0 });
      const res = createMockRes();

      await handlers.handleDeleteHost(createReq({ params: { host_id: 'host-a' } }), res);

      expect(mockHostManagement.removeOllamaHost).toHaveBeenCalledWith('host-a');
      expect(expectSuccess(res)).toEqual({
        removed: true,
        id: 'host-a',
        name: 'Alpha',
      });
    });

    it('returns 404 when deleting an unknown host', async () => {
      const res = createMockRes();

      await handlers.handleDeleteHost(createReq({ params: { host_id: 'missing-host' } }), res);

      expectError(res, {
        status: 404,
        code: 'host_not_found',
        message: 'Host not found: missing-host',
      });
    });

    it('returns 400 when the host still has running tasks', async () => {
      seedOllamaHost({ id: 'host-b', running_tasks: 2 });
      const res = createMockRes();

      await handlers.handleDeleteHost(createReq({ params: { host_id: 'host-b' } }), res);

      expect(mockHostManagement.removeOllamaHost).not.toHaveBeenCalled();
      expectError(res, {
        status: 400,
        code: 'host_busy',
        message: 'Cannot remove host with running tasks',
      });
    });

    it('returns 500 when host deletion throws', async () => {
      seedOllamaHost({ id: 'host-c', running_tasks: 0 });
      mockHostManagement.removeOllamaHost.mockImplementation(() => {
        throw new Error('delete failed');
      });
      const res = createMockRes();

      await handlers.handleDeleteHost(createReq({ params: { host_id: 'host-c' } }), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'delete failed',
      });
    });
  });

  describe('handleHostScan', () => {
    it('calls discovery.scanNetworkForOllama and returns found from totalFound', async () => {
      mockDiscovery.scanNetworkForOllama.mockResolvedValue({
        totalFound: 3,
        hosts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      });
      const res = createMockRes();

      await handlers.handleHostScan(createReq(), res);

      expect(mockDiscovery.scanNetworkForOllama).toHaveBeenCalledWith({ autoAdd: true });
      expect(expectSuccess(res)).toEqual({
        totalFound: 3,
        hosts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        found: 3,
      });
    });

    it('defaults found to zero when totalFound is absent', async () => {
      mockDiscovery.scanNetworkForOllama.mockResolvedValue({ hosts: [] });
      const res = createMockRes();

      await handlers.handleHostScan(createReq(), res);

      expect(expectSuccess(res)).toEqual({
        hosts: [],
        found: 0,
      });
    });

    it('returns 500 when discovery fails', async () => {
      mockDiscovery.scanNetworkForOllama.mockRejectedValue(new Error('scan failed'));
      const res = createMockRes();

      await handlers.handleHostScan(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'scan failed',
      });
    });
  });

  describe('handleListPeekHosts', () => {
    it('returns peek hosts enriched with credentials', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:8080' });
      seedPeekHost({ name: 'peek-b', url: 'http://peek-b:8080' });
      seedCredential('peek-a', 'peek', { credential_type: 'ssh', label: 'Primary SSH' });
      const res = createMockRes();

      await handlers.handleListPeekHosts(createReq(), res);

      expect(mockHostManagement.listCredentials).toHaveBeenCalledWith('peek-a', 'peek');
      expect(mockHostManagement.listCredentials).toHaveBeenCalledWith('peek-b', 'peek');
      expectList(res, {
        items: [
          {
            name: 'peek-a',
            url: 'http://peek-a:8080',
            enabled: 1,
            platform: null,
            ssh: null,
            is_default: 0,
            credentials: [{ host_name: 'peek-a', host_type: 'peek', credential_type: 'ssh', label: 'Primary SSH' }],
          },
          {
            name: 'peek-b',
            url: 'http://peek-b:8080',
            enabled: 1,
            platform: null,
            ssh: null,
            is_default: 0,
            credentials: [],
          },
        ],
        total: 2,
      });
    });

    it('returns an empty list when there are no peek hosts', async () => {
      const res = createMockRes();

      await handlers.handleListPeekHosts(createReq(), res);

      expectList(res, { items: [], total: 0 });
    });
  });

  describe('handleCreatePeekHost', () => {
    it('parses the body, creates the host, and returns 201', async () => {
      mockParseBody.mockResolvedValue({
        name: 'peek-a',
        url: 'http://peek-a:9876',
        ssh: 'admin@peek-a',
        default: true,
        platform: 'linux',
      });
      const res = createMockRes();

      await handlers.handleCreatePeekHost(createReq(), res);

      expect(mockParseBody).toHaveBeenCalledOnce();
      expect(mockDb.registerPeekHost).toHaveBeenCalledWith(
        'peek-a',
        'http://peek-a:9876',
        'admin@peek-a',
        true,
        'linux',
      );
      expect(expectSuccess(res, { status: 201 })).toEqual({
        name: 'peek-a',
        url: 'http://peek-a:9876',
        ssh: 'admin@peek-a',
        is_default: 1,
        platform: 'linux',
        enabled: 1,
      });
    });

    it('returns 400 when name is missing', async () => {
      const res = createMockRes();

      await handlers.handleCreatePeekHost(
        createReq({ body: { url: 'http://peek-a:9876' } }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'name and url are required',
      });
    });

    it('returns 400 when the url is invalid', async () => {
      const res = createMockRes();

      await handlers.handleCreatePeekHost(
        createReq({ body: { name: 'peek-a', url: 'not-a-url' } }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'Invalid peek host URL',
      });
    });

    it('uses req.body when present and coerces default with Boolean()', async () => {
      const res = createMockRes();

      await handlers.handleCreatePeekHost(
        createReq({
          body: {
            name: 'peek-b',
            url: 'http://peek-b:9876',
            default: 'false',
          },
        }),
        res,
      );

      expect(mockParseBody).not.toHaveBeenCalled();
      expect(mockDb.registerPeekHost).toHaveBeenCalledWith(
        'peek-b',
        'http://peek-b:9876',
        undefined,
        true,
        undefined,
      );
      expect(expectSuccess(res, { status: 201 })).toEqual(expect.objectContaining({
        name: 'peek-b',
        is_default: 1,
      }));
    });

    it('returns 500 when registration throws', async () => {
      mockDb.registerPeekHost.mockImplementation(() => {
        throw new Error('peek create failed');
      });
      const res = createMockRes();

      await handlers.handleCreatePeekHost(
        createReq({ body: { name: 'peek-c', url: 'http://peek-c:9876' } }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'peek create failed',
      });
    });
  });

  describe('handleDeletePeekHost', () => {
    it('deletes a peek host and removes all stored credentials', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      seedCredential('peek-a', 'peek', { credential_type: 'ssh', label: 'SSH' });
      const res = createMockRes();

      await handlers.handleDeletePeekHost(
        createReq({ params: { host_name: 'peek-a' } }),
        res,
      );

      expect(mockDb.unregisterPeekHost).toHaveBeenCalledWith('peek-a');
      expect(mockHostManagement.deleteAllHostCredentials).toHaveBeenCalledWith('peek-a', 'peek');
      expect(expectSuccess(res)).toEqual({
        removed: true,
        name: 'peek-a',
      });
    });

    it('returns 404 when the peek host does not exist', async () => {
      const res = createMockRes();

      await handlers.handleDeletePeekHost(
        createReq({ params: { host_name: 'missing-peek' } }),
        res,
      );

      expect(mockHostManagement.deleteAllHostCredentials).not.toHaveBeenCalled();
      expectError(res, {
        status: 404,
        code: 'host_not_found',
        message: 'Peek host not found: missing-peek',
      });
    });

    it('still succeeds when there are no credentials to remove', async () => {
      seedPeekHost({ name: 'peek-b', url: 'http://peek-b:9876' });
      const res = createMockRes();

      await handlers.handleDeletePeekHost(
        createReq({ params: { host_name: 'peek-b' } }),
        res,
      );

      expect(expectSuccess(res)).toEqual({
        removed: true,
        name: 'peek-b',
      });
    });
  });

  describe('handleTogglePeekHost', () => {
    it('returns 404 when the peek host does not exist', async () => {
      const res = createMockRes();

      await handlers.handleTogglePeekHost(
        createReq({ params: { host_name: 'missing-peek' }, body: {} }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'host_not_found',
        message: 'Peek host not found: missing-peek',
      });
    });

    it('toggles enabled off by default when no explicit value is provided', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876', enabled: 1 });
      const res = createMockRes();

      await handlers.handleTogglePeekHost(
        createReq({ params: { host_name: 'peek-a' }, body: {} }),
        res,
      );

      expect(mockDb.updatePeekHost).toHaveBeenCalledWith('peek-a', { enabled: 0 });
      expect(expectSuccess(res)).toEqual(expect.objectContaining({
        name: 'peek-a',
        enabled: 0,
      }));
    });

    it('parses the body and respects explicit enabled=true', async () => {
      seedPeekHost({ name: 'peek-b', url: 'http://peek-b:9876', enabled: 0 });
      mockParseBody.mockResolvedValue({ enabled: true });
      const res = createMockRes();

      await handlers.handleTogglePeekHost(
        createReq({ params: { host_name: 'peek-b' } }),
        res,
      );

      expect(mockParseBody).toHaveBeenCalledOnce();
      expect(mockDb.updatePeekHost).toHaveBeenCalledWith('peek-b', { enabled: 1 });
      expect(expectSuccess(res)).toEqual(expect.objectContaining({
        name: 'peek-b',
        enabled: 1,
      }));
    });

    it('respects explicit enabled=false', async () => {
      seedPeekHost({ name: 'peek-c', url: 'http://peek-c:9876', enabled: 1 });
      const res = createMockRes();

      await handlers.handleTogglePeekHost(
        createReq({ params: { host_name: 'peek-c' }, body: { enabled: false } }),
        res,
      );

      expect(mockDb.updatePeekHost).toHaveBeenCalledWith('peek-c', { enabled: 0 });
      expect(expectSuccess(res).enabled).toBe(0);
    });
  });

  describe('handleListCredentials', () => {
    it('returns credentials for a peek host', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      seedCredential('peek-a', 'peek', { credential_type: 'ssh', label: 'Peek SSH' });
      const res = createMockRes();

      await handlers.handleListCredentials(
        createReq({ params: { host_name: 'peek-a' } }),
        res,
      );

      expect(mockHostManagement.listCredentials).toHaveBeenCalledWith('peek-a', 'peek');
      expectList(res, {
        items: [{ host_name: 'peek-a', host_type: 'peek', credential_type: 'ssh', label: 'Peek SSH' }],
        total: 1,
      });
    });

    it('returns credentials for an ollama host', async () => {
      seedOllamaHost({ id: 'ollama-a', url: 'http://ollama-a:11434' });
      seedCredential('ollama-a', 'ollama', { credential_type: 'http_auth', label: 'API token' });
      const res = createMockRes();

      await handlers.handleListCredentials(
        createReq({ params: { host_name: 'ollama-a' } }),
        res,
      );

      expect(mockHostManagement.listCredentials).toHaveBeenCalledWith('ollama-a', 'ollama');
      expectList(res, {
        items: [{ host_name: 'ollama-a', host_type: 'ollama', credential_type: 'http_auth', label: 'API token' }],
        total: 1,
      });
    });

    it('prefers the peek host type when a name exists in both stores', async () => {
      seedPeekHost({ name: 'shared-host', url: 'http://peek-shared:9876' });
      seedOllamaHost({ id: 'shared-host', url: 'http://ollama-shared:11434' });
      seedCredential('shared-host', 'peek', { credential_type: 'ssh', label: 'Peek SSH' });
      seedCredential('shared-host', 'ollama', { credential_type: 'http_auth', label: 'Ollama auth' });
      const res = createMockRes();

      await handlers.handleListCredentials(
        createReq({ params: { host_name: 'shared-host' } }),
        res,
      );

      expect(mockHostManagement.listCredentials).toHaveBeenCalledWith('shared-host', 'peek');
      expect(mockHostManagement.listCredentials).not.toHaveBeenCalledWith('shared-host', 'ollama');
      expectList(res, {
        items: [{ host_name: 'shared-host', host_type: 'peek', credential_type: 'ssh', label: 'Peek SSH' }],
        total: 1,
      });
    });

    it('returns 404 when the host does not exist', async () => {
      const res = createMockRes();

      await handlers.handleListCredentials(
        createReq({ params: { host_name: 'missing-host' } }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'host_not_found',
        message: 'Host not found: missing-host',
      });
    });
  });

  describe('handleSaveCredential', () => {
    it('parses the body and saves a supported credential for a known host', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      mockParseBody.mockResolvedValue({
        label: 'SSH access',
        value: {
          user: 'root',
          key_path: '/secure/id_ed25519',
          port: 2200,
        },
      });
      const res = createMockRes();

      await handlers.handleSaveCredential(
        createReq({ params: { host_name: 'peek-a', credential_type: 'ssh' } }),
        res,
      );

      expect(mockHostManagement.saveCredential).toHaveBeenCalledWith(
        'peek-a',
        'peek',
        'ssh',
        'SSH access',
        {
          user: 'root',
          key_path: '/secure/id_ed25519',
          port: 2200,
        },
      );
      expect(expectSuccess(res)).toEqual({ saved: true });
    });

    it('returns 400 for an unsupported credential type', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createMockRes();

      await handlers.handleSaveCredential(
        createReq({
          params: { host_name: 'peek-a', credential_type: 'token' },
          body: { value: { token: 'abc' } },
        }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'Unsupported credential type',
      });
    });

    it('returns 400 when the credential value object is missing', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createMockRes();

      await handlers.handleSaveCredential(
        createReq({ params: { host_name: 'peek-a', credential_type: 'ssh' }, body: {} }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'Credential value object is required',
      });
    });

    it('returns 400 when the credential value is an array', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createMockRes();

      await handlers.handleSaveCredential(
        createReq({
          params: { host_name: 'peek-a', credential_type: 'ssh' },
          body: { value: ['bad'] },
        }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'Credential value object is required',
      });
    });

    it('returns 404 for an unknown host', async () => {
      const res = createMockRes();

      await handlers.handleSaveCredential(
        createReq({
          params: { host_name: 'missing-host', credential_type: 'ssh' },
          body: { value: { user: 'root' } },
        }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'host_not_found',
        message: 'Host not found: missing-host',
      });
    });

    it('returns 500 when credential persistence throws', async () => {
      seedOllamaHost({ id: 'ollama-a', url: 'http://ollama-a:11434' });
      mockHostManagement.saveCredential.mockImplementation(() => {
        throw new Error('save failed');
      });
      const res = createMockRes();

      await handlers.handleSaveCredential(
        createReq({
          params: { host_name: 'ollama-a', credential_type: 'http_auth' },
          body: { label: 'HTTP auth', value: { username: 'a', password: 'b' } },
        }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'save failed',
      });
    });
  });

  describe('handleDeleteCredential', () => {
    it('deletes a saved credential', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      seedCredential('peek-a', 'peek', { credential_type: 'windows', label: 'Win login' });
      const res = createMockRes();

      await handlers.handleDeleteCredential(
        createReq({ params: { host_name: 'peek-a', credential_type: 'windows' } }),
        res,
      );

      expect(mockHostManagement.deleteCredential).toHaveBeenCalledWith('peek-a', 'peek', 'windows');
      expect(expectSuccess(res)).toEqual({
        removed: true,
        host: 'peek-a',
        credential_type: 'windows',
      });
    });

    it('returns 400 for an unsupported credential type', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createMockRes();

      await handlers.handleDeleteCredential(
        createReq({ params: { host_name: 'peek-a', credential_type: 'oauth' } }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'Unsupported credential type',
      });
    });

    it('returns 404 for an unknown host', async () => {
      const res = createMockRes();

      await handlers.handleDeleteCredential(
        createReq({ params: { host_name: 'missing-host', credential_type: 'ssh' } }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'host_not_found',
        message: 'Host not found: missing-host',
      });
    });

    it('returns 404 when the credential does not exist', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createMockRes();

      await handlers.handleDeleteCredential(
        createReq({ params: { host_name: 'peek-a', credential_type: 'ssh' } }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'credential_not_found',
        message: 'Credential not found',
      });
    });
  });

  describe('handleListAgents', () => {
    it('returns a sanitized agent list without secrets', async () => {
      seedAgent({
        id: 'agent-a',
        name: 'Agent A',
        host: 'agent-a.internal',
        port: 3460,
        secret: 'top-secret',
        tls: 1,
        rejectUnauthorized: 0,
        created_at: '2026-03-05T00:00:00.000Z',
      });
      seedAgent({
        id: 'agent-b',
        name: 'Agent B',
        host: 'agent-b.internal',
        port: 3461,
        secret: 'other-secret',
        created_at: '2026-03-06T00:00:00.000Z',
      });
      const res = createMockRes();

      await handlers.handleListAgents(createReq(), res);

      const data = expectList(res, {
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'agent-a', name: 'Agent A', tls: true, rejectUnauthorized: false }),
          expect.objectContaining({ id: 'agent-b', name: 'Agent B', tls: true, rejectUnauthorized: true }),
        ]),
        total: 2,
      });
      expect(data.items[0]).not.toHaveProperty('secret');
      expect(data.items[1]).not.toHaveProperty('secret');
    });

    it('uses the injected registry without touching the db singleton', async () => {
      mockDb.getDbInstance.mockImplementation(() => {
        throw new Error('db singleton should not be used');
      });
      seedAgent({
        id: 'agent-a',
        name: 'Agent A',
        host: 'agent-a.internal',
        port: 3460,
        secret: 'top-secret',
      });
      const res = createMockRes();

      await handlers.handleListAgents(createReq(), res);

      expectList(res, {
        items: [
          expect.objectContaining({ id: 'agent-a', name: 'Agent A' }),
        ],
        total: 1,
      });
      expect(mockRegistry.getAll).toHaveBeenCalledOnce();
      expect(mockDb.getDbInstance).not.toHaveBeenCalled();
    });
  });

  describe('handleCreateAgent', () => {
    it('returns 400 when required fields are blank after trimming', async () => {
      const res = createMockRes();

      await handlers.handleCreateAgent(
        createReq({
          body: {
            id: '  ',
            name: '  ',
            host: '  ',
            secret: '  ',
          },
        }),
        res,
      );

      expectError(res, {
        code: 'validation_error',
        message: 'id, name, host, and secret are required',
      });
    });

    it('returns 500 when the agent registry is not initialized', async () => {
      handlers.init({ taskManager: mockTaskManager, remoteAgentRegistry: null });
      const res = createMockRes();

      await handlers.handleCreateAgent(
        createReq({
          body: {
            id: 'agent-a',
            name: 'Agent A',
            host: 'agent-a.internal',
            secret: 'secret',
          },
        }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'not_initialized',
        message: 'Agent registry not initialized',
      });
    });

    it('parses the body, applies defaults, and returns 201', async () => {
      mockParseBody.mockResolvedValue({
        id: 'agent-a',
        name: 'Agent A',
        host: 'agent-a.internal',
        secret: 'secret-a',
      });
      const res = createMockRes();

      await handlers.handleCreateAgent(createReq(), res);

      expect(mockParseBody).toHaveBeenCalledOnce();
      expect(mockRegistry.register).toHaveBeenCalledWith({
        id: 'agent-a',
        name: 'Agent A',
        host: 'agent-a.internal',
        port: 3460,
        secret: 'secret-a',
        max_concurrent: 3,
        tls: true,
        rejectUnauthorized: true,
      });
      expect(expectSuccess(res, { status: 201 })).toEqual({
        id: 'agent-a',
        name: 'Agent A',
        host: 'agent-a.internal',
        port: 3460,
        max_concurrent: 3,
        tls: true,
        rejectUnauthorized: true,
        created_at: '2026-03-01T00:00:00.000Z',
        status: 'unknown',
        consecutive_failures: 0,
      });
    });

    it('trims string fields and respects explicit tls settings', async () => {
      const res = createMockRes();

      await handlers.handleCreateAgent(
        createReq({
          body: {
            id: '  agent-b  ',
            name: '  Agent B  ',
            host: '  secure.internal  ',
            port: '4443',
            secret: '  secret-b  ',
            max_concurrent: '8',
            tls: true,
            rejectUnauthorized: false,
          },
        }),
        res,
      );

      expect(mockRegistry.register).toHaveBeenCalledWith({
        id: 'agent-b',
        name: 'Agent B',
        host: 'secure.internal',
        port: 4443,
        secret: 'secret-b',
        max_concurrent: 8,
        tls: true,
        rejectUnauthorized: false,
      });
      expect(expectSuccess(res, { status: 201 })).toEqual(expect.objectContaining({
        id: 'agent-b',
        port: 4443,
        max_concurrent: 8,
        tls: true,
        rejectUnauthorized: false,
      }));
    });

    it('returns 500 when registration succeeds but the reread is missing', async () => {
      mockRegistry.register.mockImplementation(() => undefined);
      const res = createMockRes();

      await handlers.handleCreateAgent(
        createReq({
          body: {
            id: 'agent-c',
            name: 'Agent C',
            host: 'agent-c.internal',
            secret: 'secret-c',
          },
        }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'Registered but failed to read result',
      });
    });
  });

  describe('handleGetAgent', () => {
    it('returns a single sanitized agent', async () => {
      seedAgent({
        id: 'agent-a',
        name: 'Agent A',
        host: 'agent-a.internal',
        port: 3460,
        secret: 'top-secret',
      });
      const res = createMockRes();

      await handlers.handleGetAgent(
        createReq({ params: { agent_id: 'agent-a' } }),
        res,
      );

      const data = expectSuccess(res);
      expect(data).toEqual(expect.objectContaining({
        id: 'agent-a',
        name: 'Agent A',
        host: 'agent-a.internal',
      }));
      expect(data).not.toHaveProperty('secret');
    });

    it('returns 404 when the agent is missing', async () => {
      const res = createMockRes();

      await handlers.handleGetAgent(
        createReq({ params: { agent_id: 'missing-agent' } }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'agent_not_found',
        message: 'Agent not found: missing-agent',
      });
    });
  });

  describe('handleAgentHealth', () => {
    it('returns 404 when the agent is missing', async () => {
      const res = createMockRes();

      await handlers.handleAgentHealth(
        createReq({ params: { agent_id: 'missing-agent' } }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'agent_not_found',
        message: 'Agent not found: missing-agent',
      });
    });

    it('returns disabled when the registry has no client for the agent', async () => {
      seedAgent({
        id: 'agent-a',
        name: 'Agent A',
        host: 'agent-a.internal',
        secret: 'secret-a',
        status: 'healthy',
      });
      mockRegistry.getClient.mockReturnValue(null);
      const res = createMockRes();

      await handlers.handleAgentHealth(
        createReq({ params: { agent_id: 'agent-a' } }),
        res,
      );

      expect(mockRegistry.getClient).toHaveBeenCalledWith('agent-a');
      expect(expectSuccess(res)).toEqual(expect.objectContaining({
        id: 'agent-a',
        status: 'disabled',
      }));
      expect(state.agents.get('agent-a').status).toBe('healthy');
    });

    it('updates health, resets failures, and stores metrics on success', async () => {
      seedAgent({
        id: 'agent-b',
        name: 'Agent B',
        host: 'agent-b.internal',
        secret: 'secret-b',
        consecutive_failures: 2,
        metrics: '{"stale":true}',
      });
      mockRegistry.getClient.mockReturnValue({
        checkHealth: vi.fn().mockResolvedValue({
          system: { load_avg: 0.5, platform: 'linux' },
        }),
      });
      const res = createMockRes();

      await handlers.handleAgentHealth(
        createReq({ params: { agent_id: 'agent-b' } }),
        res,
      );

      expect(expectSuccess(res)).toEqual(expect.objectContaining({
        id: 'agent-b',
        status: 'healthy',
        consecutive_failures: 0,
        last_health_check: '2026-03-10T12:00:00.000Z',
        last_healthy: '2026-03-10T12:00:00.000Z',
        metrics: JSON.stringify({ load_avg: 0.5, platform: 'linux' }),
      }));
    });

    it('marks the agent down and increments failures when health check throws', async () => {
      seedAgent({
        id: 'agent-c',
        name: 'Agent C',
        host: 'agent-c.internal',
        secret: 'secret-c',
        consecutive_failures: 3,
        last_healthy: '2026-03-09T10:00:00.000Z',
        metrics: '{"cached":true}',
      });
      mockRegistry.getClient.mockReturnValue({
        checkHealth: vi.fn().mockResolvedValue(null),
      });
      const res = createMockRes();

      await handlers.handleAgentHealth(
        createReq({ params: { agent_id: 'agent-c' } }),
        res,
      );

      expect(expectSuccess(res)).toEqual(expect.objectContaining({
        id: 'agent-c',
        status: 'down',
        consecutive_failures: 4,
        last_health_check: '2026-03-10T12:00:00.000Z',
        last_healthy: '2026-03-09T10:00:00.000Z',
        metrics: '{"cached":true}',
      }));
    });

    it('returns 404 when registry is null (agent lookup fails first)', async () => {
      handlers.init({ taskManager: mockTaskManager, remoteAgentRegistry: null });
      const res = createMockRes();

      await handlers.handleAgentHealth(
        createReq({ params: { agent_id: 'agent-d' } }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'agent_not_found',
        message: 'Agent not found: agent-d',
      });
    });
  });

  describe('handleDeleteAgent', () => {
    it('removes an agent through the registry', async () => {
      seedAgent({
        id: 'agent-a',
        name: 'Agent A',
        host: 'agent-a.internal',
        secret: 'secret-a',
      });
      const res = createMockRes();

      await handlers.handleDeleteAgent(
        createReq({ params: { agent_id: 'agent-a' } }),
        res,
      );

      expect(mockRegistry.remove).toHaveBeenCalledWith('agent-a');
      expect(expectSuccess(res)).toEqual({
        removed: true,
        id: 'agent-a',
        name: 'Agent A',
      });
    });

    it('returns 404 when the agent does not exist', async () => {
      const res = createMockRes();

      await handlers.handleDeleteAgent(
        createReq({ params: { agent_id: 'missing-agent' } }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'agent_not_found',
        message: 'Agent not found: missing-agent',
      });
    });

    it('returns 404 when registry is null (agent lookup fails first)', async () => {
      handlers.init({ taskManager: mockTaskManager, remoteAgentRegistry: null });
      const res = createMockRes();

      await handlers.handleDeleteAgent(
        createReq({ params: { agent_id: 'agent-b' } }),
        res,
      );

      expectError(res, {
        status: 404,
        code: 'agent_not_found',
        message: 'Agent not found: agent-b',
      });
    });

    it('returns 500 when the registry remove call throws', async () => {
      seedAgent({
        id: 'agent-c',
        name: 'Agent C',
        host: 'agent-c.internal',
        secret: 'secret-c',
      });
      mockRegistry.remove.mockImplementation(() => {
        throw new Error('remove failed');
      });
      const res = createMockRes();

      await handlers.handleDeleteAgent(
        createReq({ params: { agent_id: 'agent-c' } }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'remove failed',
      });
    });
  });

  describe('handleHostActivity', () => {
    it('returns host activity data from the monitoring module', async () => {
      const res = createMockRes();

      mockHostMonitoring.getHostActivity.mockReturnValue({
        hosts: [
          { name: 'host-a', running: 2, queued: 1 },
          { name: 'host-b', running: 0, queued: 0 },
        ],
        total_running: 2,
      });

      await handlers.handleHostActivity(createReq(), res);

      expect(mockHostMonitoring.getHostActivity).toHaveBeenCalledOnce();
      expect(expectSuccess(res)).toEqual({
        hosts: [
          { name: 'host-a', running: 2, queued: 1 },
          { name: 'host-b', running: 0, queued: 0 },
        ],
        total_running: 2,
      });
    });

    it('returns empty object when getHostActivity is not a function', async () => {
      const res = createMockRes();

      installCjsModuleMock('../utils/host-monitoring', { getHostActivity: undefined });
      try {
        handlers = loadHandlers();
        handlers.init({ taskManager: mockTaskManager, remoteAgentRegistry: mockRegistry });
        await handlers.handleHostActivity(createReq(), res);
      } finally {
        installCjsModuleMock('../utils/host-monitoring', mockHostMonitoring);
      }

      expect(expectSuccess(res)).toEqual({});
    });

    it('returns 500 when host monitoring module throws', async () => {
      const res = createMockRes();

      // Mock at the absolute resolved path the handler uses (require from server/api/)
      const hmPath = require.resolve('../utils/host-monitoring');
      const savedHm = require.cache[hmPath];
      require.cache[hmPath] = {
        id: hmPath, filename: hmPath, loaded: true,
        exports: { getHostActivity: () => { throw new Error('monitoring failed'); } },
      };

      await handlers.handleHostActivity(createReq(), res);

      // Restore
      if (savedHm) require.cache[hmPath] = savedHm;
      else delete require.cache[hmPath];

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'monitoring failed',
      });
    });
  });

  describe('handleProviderPercentiles', () => {
    it('returns percentile stats for a provider with default days', async () => {
      const res = createMockRes();

      mockDb.listTasks.mockReturnValue([
        {
          id: 'task-1',
          started_at: '2026-03-10T12:00:00.000Z',
          completed_at: '2026-03-10T12:00:10.000Z',
        },
        {
          id: 'task-2',
          started_at: '2026-03-10T12:00:00.000Z',
          completed_at: '2026-03-10T12:00:20.000Z',
        },
        {
          id: 'task-3',
          started_at: '2026-03-10T12:00:00.000Z',
          completed_at: '2026-03-10T12:00:40.000Z',
        },
      ]);

      await handlers.handleProviderPercentiles(
        createReq({ params: { provider_id: 'codex' } }),
        res,
      );

      expect(mockDb.listTasks).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'codex',
        limit: 1000,
      }));
      expect(expectSuccess(res)).toEqual({
        provider: 'codex',
        days: 7,
        percentiles: {
          p50: 20,
          p75: 40,
          p90: 40,
          p95: 40,
          p99: 40,
          min: 10,
          max: 40,
          count: 3,
        },
      });
    });

    it('respects the days query param', async () => {
      const res = createMockRes();

      mockDb.listTasks.mockReturnValue([]);

      await handlers.handleProviderPercentiles(
        createReq({ params: { provider_id: 'ollama' }, query: { days: '30' } }),
        res,
      );

      expect(mockDb.listTasks).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'ollama',
        limit: 1000,
      }));
      expect(expectSuccess(res)).toEqual({
        provider: 'ollama',
        days: 30,
        percentiles: {},
      });
    });

    it('clamps days to a minimum of one', async () => {
      const res = createMockRes();

      await handlers.handleProviderPercentiles(
        createReq({ params: { provider_id: 'codex' }, query: { days: '-5' } }),
        res,
      );

      expect(mockDb.listTasks).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'codex',
        limit: 1000,
      }));
      expect(expectSuccess(res).days).toBe(1);
    });

    it('clamps days to a maximum of ninety', async () => {
      const res = createMockRes();

      await handlers.handleProviderPercentiles(
        createReq({ params: { provider_id: 'codex' }, query: { days: '500' } }),
        res,
      );

      expect(mockDb.listTasks).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'codex',
        limit: 1000,
      }));
      expect(expectSuccess(res).days).toBe(90);
    });

    it('returns 400 when provider_id is missing', async () => {
      const res = createMockRes();

      await handlers.handleProviderPercentiles(
        createReq({ params: {} }),
        res,
      );

      expectError(res, {
        status: 400,
        code: 'validation_error',
        message: 'provider_id is required',
      });
    });

    it('returns empty object when listTasks is not a function', async () => {
      const res = createMockRes();
      const saved = mockDb.listTasks;
      mockDb.listTasks = null;
      try {
        await handlers.handleProviderPercentiles(
          createReq({ params: { provider_id: 'codex' } }),
          res,
        );
      } finally {
        mockDb.listTasks = saved;
      }

      expect(expectSuccess(res)).toEqual({
        provider: 'codex',
        days: 7,
        percentiles: {},
      });
    });

    it('returns 500 when listTasks throws', async () => {
      const res = createMockRes();

      mockDb.listTasks.mockImplementation(() => {
        throw new Error('percentiles failed');
      });

      await handlers.handleProviderPercentiles(
        createReq({ params: { provider_id: 'codex' } }),
        res,
      );

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'percentiles failed',
      });
    });
  });

  describe('handleCoordinationDashboard', () => {
    it('returns coordination data with default hours', async () => {
      const res = createMockRes();

      mockCoordination.getCoordinationDashboard.mockReturnValue({
        agents: [{ id: 'agent-a', status: 'active' }],
        rules: [{ id: 'rule-1', type: 'priority' }],
        claims: [],
      });

      await handlers.handleCoordinationDashboard(createReq(), res);

      expect(mockCoordination.getCoordinationDashboard).toHaveBeenCalledWith(24);
      expect(expectSuccess(res)).toEqual({
        agents: [{ id: 'agent-a', status: 'active' }],
        rules: [{ id: 'rule-1', type: 'priority' }],
        claims: [],
      });
    });

    it('respects the hours query param', async () => {
      const res = createMockRes();

      mockCoordination.getCoordinationDashboard.mockReturnValue({
        agents: [],
        rules: [],
        claims: [],
      });

      await handlers.handleCoordinationDashboard(
        createReq({ query: { hours: '48' } }),
        res,
      );

      expect(mockCoordination.getCoordinationDashboard).toHaveBeenCalledWith(48);
    });

    it('clamps hours to a minimum of one', async () => {
      const res = createMockRes();

      await handlers.handleCoordinationDashboard(
        createReq({ query: { hours: '-3' } }),
        res,
      );

      expect(mockCoordination.getCoordinationDashboard).toHaveBeenCalledWith(1);
    });

    it('clamps hours to a maximum of one hundred sixty-eight', async () => {
      const res = createMockRes();

      await handlers.handleCoordinationDashboard(
        createReq({ query: { hours: '999' } }),
        res,
      );

      expect(mockCoordination.getCoordinationDashboard).toHaveBeenCalledWith(168);
    });

    it('returns default structure when db method is not a function', async () => {
      const res = createMockRes();
      const saved = mockCoordination.getCoordinationDashboard;
      mockCoordination.getCoordinationDashboard = null;
      try {
        await handlers.handleCoordinationDashboard(createReq(), res);
      } finally {
        mockCoordination.getCoordinationDashboard = saved;
      }

      expect(expectSuccess(res)).toEqual({
        agents: [],
        rules: [],
        claims: [],
      });
    });

    it('returns 500 when getCoordinationDashboard throws', async () => {
      const res = createMockRes();

      mockCoordination.getCoordinationDashboard.mockImplementation(() => {
        throw new Error('coordination failed');
      });

      await handlers.handleCoordinationDashboard(createReq(), res);

      expectError(res, {
        status: 500,
        code: 'operation_failed',
        message: 'coordination failed',
      });
    });
  });
});
