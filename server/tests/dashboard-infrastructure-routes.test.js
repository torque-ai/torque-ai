import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { EventEmitter } = require('node:events');
const realHttp = require('node:http');
const realHttps = require('node:https');

const ROUTE_MODULE = '../dashboard/routes/infrastructure';
const MODULE_PATHS = [
  ROUTE_MODULE,
  '../database',
  '../db/host-management',
  '../dashboard/utils',
  '../task-manager',
  '../discovery',
];

const originalHttpGet = realHttp.get;
const originalHttpsGet = realHttps.get;

var currentModules = {};
let state;
let handlers;

vi.mock('../database', () => currentModules.db);
vi.mock('../db/host-management', () => currentModules.hostManagement);
vi.mock('../dashboard/utils', () => currentModules.utils);
vi.mock('../task-manager', () => currentModules.taskManager);
vi.mock('../discovery', () => currentModules.discovery);
vi.mock('http', () => currentModules.http);
vi.mock('https', () => currentModules.https);

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

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
      // Ignore modules that have not been loaded yet.
    }
  }
}

function createState() {
  return {
    ollamaHosts: new Map(),
    peekHosts: new Map(),
    credentials: new Map(),
    hostSettings: new Map(),
    tasks: [],
    providers: new Map(),
    providerStats: new Map(),
    hostActivity: {},
  };
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

function findOllamaHostKey(idOrName) {
  if (state.ollamaHosts.has(idOrName)) return idOrName;
  for (const [key, host] of state.ollamaHosts.entries()) {
    if (host.name === idOrName) return key;
  }
  return null;
}

function findOllamaHostRecord(idOrName) {
  const key = findOllamaHostKey(idOrName);
  return key ? state.ollamaHosts.get(key) : null;
}

function getTaskTimestamp(task) {
  return task.completed_at || task.started_at || task.created_at || task.createdAt || null;
}

function matchesTaskFilters(task, filters = {}) {
  if (filters.status && task.status !== filters.status) return false;
  if (filters.provider && task.provider !== filters.provider) return false;

  const timestamp = getTaskTimestamp(task);
  if (filters.from_date || filters.to_date || filters.since) {
    if (!timestamp) return false;
  }

  if (filters.from_date) {
    const datePart = new Date(timestamp).toISOString().slice(0, 10);
    if (datePart < filters.from_date) return false;
  }

  if (filters.to_date) {
    const datePart = new Date(timestamp).toISOString().slice(0, 10);
    if (datePart >= filters.to_date) return false;
  }

  if (filters.since && new Date(timestamp) < new Date(filters.since)) {
    return false;
  }

  return true;
}

function seedOllamaHost(host) {
  const id = host.id || host.name;
  state.ollamaHosts.set(id, {
    id,
    name: host.name || id,
    url: host.url || `http://${id}:11434`,
    enabled: 1,
    running_tasks: 0,
    status: 'healthy',
    consecutive_failures: 0,
    memory_limit_mb: 0,
    ...clone(host),
  });
}

function seedPeekHost(host) {
  state.peekHosts.set(host.name, {
    name: host.name,
    url: host.url,
    ssh: null,
    enabled: 1,
    platform: null,
    is_default: 0,
    ...clone(host),
  });
}

function seedCredential(hostName, hostType, credential) {
  const bucket = ensureCredentialBucket(hostName, hostType);
  bucket.set(credential.credential_type, {
    host_name: hostName,
    host_type: hostType,
    credential_type: credential.credential_type,
    label: credential.label || null,
    value: Object.prototype.hasOwnProperty.call(credential, 'value')
      ? credential.value
      : { secret: `${hostType}-${credential.credential_type}` },
  });
}

function seedTask(task) {
  state.tasks.push(clone(task));
}

function seedProvider(provider) {
  state.providers.set(provider.provider, {
    enabled: true,
    ...clone(provider),
  });
}

function setProviderStats(providerId, days, stats) {
  state.providerStats.set(`${providerId}:${days}`, clone(stats));
}

function createTransportModule() {
  const queuedResponses = [];
  const calls = [];

  const get = vi.fn((url, options, callback) => {
    const spec = queuedResponses.length > 0 ? queuedResponses.shift() : {};
    if (spec.throwOnGet) throw spec.throwOnGet;

    const request = new EventEmitter();
    request.destroyedWith = null;
    request.destroy = vi.fn((error) => {
      request.destroyedWith = error || null;
    });

    const response = new EventEmitter();
    response.statusCode = spec.statusCode ?? 200;
    response.resume = vi.fn();

    calls.push({
      url,
      options,
      callback,
      request,
      response,
      spec,
    });

    process.nextTick(() => {
      if (!spec.error && !spec.timeout && typeof callback === 'function') {
        callback(response);
      }

      if (spec.timeout) {
        request.emit('timeout');
        return;
      }

      if (spec.error) {
        request.emit('error', spec.error instanceof Error ? spec.error : new Error(String(spec.error)));
        return;
      }

      if (spec.body !== undefined && spec.body !== null && spec.body !== '') {
        const payload = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
        response.emit('data', payload);
      }

      response.emit('end');
    });

    return request;
  });

  return {
    get,
    calls,
    queueResponse(spec) {
      queuedResponses.push(spec);
    },
  };
}

function createModules() {
  const db = {
    listOllamaHosts: vi.fn((filter = {}) => {
      const hosts = Array.from(state.ollamaHosts.values());
      return hosts
        .filter((host) => {
          if (filter.enabled === undefined) return true;
          return Boolean(host.enabled) === Boolean(filter.enabled);
        })
        .map(clone);
    }),
    getOllamaHost: vi.fn((hostId) => clone(findOllamaHostRecord(hostId))),
    updateOllamaHost: vi.fn((hostId, updates) => {
      const key = findOllamaHostKey(hostId);
      if (!key) return false;
      Object.assign(state.ollamaHosts.get(key), clone(updates));
      return true;
    }),
    recordHostHealthCheck: vi.fn((hostId, healthy, models) => {
      const host = findOllamaHostRecord(hostId);
      if (!host) return null;
      host.status = healthy ? 'healthy' : 'down';
      host.consecutive_failures = healthy ? 0 : (host.consecutive_failures || 0) + 1;
      host.models = models;
      return clone(host);
    }),
    getHostSettings: vi.fn((hostId) => clone(state.hostSettings.get(hostId) || {})),
    removeOllamaHost: vi.fn((hostId) => {
      const key = findOllamaHostKey(hostId);
      if (!key) return false;
      return state.ollamaHosts.delete(key);
    }),
    listPeekHosts: vi.fn(() => Array.from(state.peekHosts.values()).map(clone)),
    getPeekHost: vi.fn((hostName) => clone(state.peekHosts.get(hostName))),
    registerPeekHost: vi.fn((name, url, ssh, isDefault, platform) => {
      const existing = state.peekHosts.get(name);
      state.peekHosts.set(name, {
        name,
        url,
        ssh: ssh ?? null,
        enabled: existing ? existing.enabled : 1,
        platform: platform ?? null,
        is_default: isDefault ? 1 : 0,
      });
    }),
    unregisterPeekHost: vi.fn((hostName) => state.peekHosts.delete(hostName)),
    updatePeekHost: vi.fn((hostName, updates) => {
      const host = state.peekHosts.get(hostName);
      if (!host) return false;
      Object.assign(host, clone(updates));
      return true;
    }),
    listTasks: vi.fn((filters = {}) => {
      const tasks = state.tasks.filter((task) => matchesTaskFilters(task, filters));
      const limited = filters.limit ? tasks.slice(0, filters.limit) : tasks;
      return clone(limited);
    }),
    countTasks: vi.fn((filters = {}) => state.tasks.filter((task) => matchesTaskFilters(task, filters)).length),
    listProviders: vi.fn(() => Array.from(state.providers.values()).map(clone)),
    getProviderStats: vi.fn((providerId, days) => (
      clone(state.providerStats.get(`${providerId}:${days}`)) || { total: 0, completed: 0, failed: 0 }
    )),
    getProvider: vi.fn((providerId) => clone(state.providers.get(providerId))),
    updateProvider: vi.fn((providerId, updates) => {
      const provider = state.providers.get(providerId);
      if (!provider) return false;
      Object.assign(provider, clone(updates));
      return true;
    }),
  };

  const hostManagement = {
    listCredentials: vi.fn((hostName, hostType) => {
      const bucket = state.credentials.get(credentialKey(hostName, hostType));
      if (!bucket) return [];
      return Array.from(bucket.values()).map((credential) => ({
        host_name: credential.host_name,
        host_type: credential.host_type,
        credential_type: credential.credential_type,
        label: credential.label,
      }));
    }),
    getCredential: vi.fn((hostName, hostType, credType) => {
      const bucket = state.credentials.get(credentialKey(hostName, hostType));
      return bucket?.get(credType)?.value || null;
    }),
    saveCredential: vi.fn((hostName, hostType, credType, label, value) => {
      const bucket = ensureCredentialBucket(hostName, hostType);
      bucket.set(credType, {
        host_name: hostName,
        host_type: hostType,
        credential_type: credType,
        label: label || null,
        value: clone(value),
      });
    }),
    deleteCredential: vi.fn((hostName, hostType, credType) => {
      const bucket = state.credentials.get(credentialKey(hostName, hostType));
      if (!bucket) return false;
      return bucket.delete(credType);
    }),
    deleteAllHostCredentials: vi.fn((hostName, hostType) => state.credentials.delete(credentialKey(hostName, hostType))),
  };

  const sendJson = vi.fn((res, payload, statusCode = 200) => {
    res.statusCode = statusCode;
    res.headers = { 'Content-Type': 'application/json' };
    res.payload = clone(payload);
    res.body = JSON.stringify(payload);
    if (typeof res.writeHead === 'function') {
      res.writeHead(statusCode, res.headers);
    }
    if (typeof res.end === 'function') {
      res.end(res.body);
    }
    return payload;
  });

  const sendError = vi.fn((res, message, statusCode = 400) => sendJson(res, { error: message }, statusCode));

  const utils = {
    sendJson,
    sendError,
    parseBody: vi.fn(async (req) => clone(req.body || {})),
    safeDecodeParam: vi.fn((value, res) => {
      try {
        return decodeURIComponent(String(value ?? ''));
      } catch {
        sendError(res, 'Invalid identifier encoding', 400);
        return null;
      }
    }),
    formatUptime: vi.fn((seconds) => `${Math.round(seconds)}s`),
  };

  const taskManager = {
    probeLocalGpuMetrics: vi.fn(async () => undefined),
    probeRemoteGpuMetrics: vi.fn(async () => undefined),
    getHostActivity: vi.fn(() => clone(state.hostActivity)),
    isModelLoadedOnHost: vi.fn(() => false),
    getMcpInstanceId: vi.fn(() => 'mcp-instance-123456'),
  };

  const discovery = {
    scanNetworkForOllama: vi.fn(async () => ({ totalFound: 0, hosts: [] })),
  };

  const http = createTransportModule();
  const https = createTransportModule();

  return {
    db,
    hostManagement,
    utils,
    taskManager,
    discovery,
    http,
    https,
  };
}

function loadHandlers() {
  clearLoadedModules();
  installCjsModuleMock('../database', currentModules.db);
  installCjsModuleMock('../db/host-management', currentModules.hostManagement);
  installCjsModuleMock('../dashboard/utils', currentModules.utils);
  installCjsModuleMock('../task-manager', currentModules.taskManager);
  installCjsModuleMock('../discovery', currentModules.discovery);
  realHttp.get = currentModules.http.get;
  realHttps.get = currentModules.https.get;
  return require(ROUTE_MODULE);
}

function createReq(overrides = {}) {
  return {
    body: undefined,
    params: {},
    query: {},
    headers: {},
    ...overrides,
  };
}

function createRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    payload: null,
    writeHead: vi.fn((statusCode, headers) => {
      res.statusCode = statusCode;
      res.headers = headers;
    }),
    end: vi.fn((body) => {
      res.body = body;
      try {
        res.payload = typeof body === 'string' ? JSON.parse(body) : body;
      } catch {
        res.payload = body;
      }
    }),
  };
  return res;
}

function expectSuccess(res, payload, statusCode = 200) {
  expect(res.statusCode).toBe(statusCode);
  expect(res.payload).toEqual(payload);
}

function expectFailure(res, message, statusCode = 400) {
  expect(res.statusCode).toBe(statusCode);
  expect(res.payload).toEqual({ error: message });
}

describe('dashboard/routes/infrastructure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:00:00.000Z'));
    state = createState();
    currentModules = createModules();
    handlers = loadHandlers();
  });

  afterEach(() => {
    clearLoadedModules();
    currentModules = {};
    state = null;
    realHttp.get = originalHttpGet;
    realHttps.get = originalHttpsGet;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('handleListHosts', () => {
    it('returns all ollama hosts when multiple hosts exist', () => {
      seedOllamaHost({ id: 'host-a', name: 'Alpha', url: 'http://alpha:11434', models: ['llama3'] });
      seedOllamaHost({ id: 'host-b', name: 'Beta', url: 'http://beta:11434', enabled: 0 });
      const res = createRes();

      handlers.handleListHosts(createReq(), res);

      expect(currentModules.db.listOllamaHosts).toHaveBeenCalledWith();
      expectSuccess(res, [
        expect.objectContaining({ id: 'host-a', name: 'Alpha', url: 'http://alpha:11434', models: ['llama3'] }),
        expect.objectContaining({ id: 'host-b', name: 'Beta', url: 'http://beta:11434', enabled: 0 }),
      ]);
    });

    it('returns an empty array when no ollama hosts are registered', () => {
      const res = createRes();

      handlers.handleListHosts(createReq(), res);

      expectSuccess(res, []);
    });
  });

  describe('handleListPeekHosts', () => {
    it('returns peek hosts enriched with stored credential metadata', () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876', platform: 'linux' });
      seedPeekHost({ name: 'peek-b', url: 'https://peek-b:9876', is_default: 1 });
      seedCredential('peek-a', 'peek', { credential_type: 'ssh', label: 'Primary SSH' });
      seedCredential('peek-a', 'peek', { credential_type: 'windows', label: 'Windows admin' });
      const res = createRes();

      handlers.handleListPeekHosts(createReq(), res);

      expect(currentModules.hostManagement.listCredentials).toHaveBeenCalledWith('peek-a', 'peek');
      expect(currentModules.hostManagement.listCredentials).toHaveBeenCalledWith('peek-b', 'peek');
      expectSuccess(res, [
        {
          name: 'peek-a',
          url: 'http://peek-a:9876',
          ssh: null,
          enabled: 1,
          platform: 'linux',
          is_default: 0,
          credentials: [
            { host_name: 'peek-a', host_type: 'peek', credential_type: 'ssh', label: 'Primary SSH' },
            { host_name: 'peek-a', host_type: 'peek', credential_type: 'windows', label: 'Windows admin' },
          ],
        },
        {
          name: 'peek-b',
          url: 'https://peek-b:9876',
          ssh: null,
          enabled: 1,
          platform: null,
          is_default: 1,
          credentials: [],
        },
      ]);
    });

    it('returns an empty array when no peek hosts are registered', () => {
      const res = createRes();

      handlers.handleListPeekHosts(createReq(), res);

      expectSuccess(res, []);
    });
  });

  describe('handleCreatePeekHost', () => {
    it('creates a peek host and returns the stored record with 201', async () => {
      const res = createRes();

      await handlers.handleCreatePeekHost(
        createReq({
          body: {
            name: 'peek-a',
            url: 'http://peek-a:9876',
            ssh: 'admin@peek-a',
            default: true,
            platform: 'linux',
          },
        }),
        res,
      );

      expect(currentModules.utils.parseBody).toHaveBeenCalledOnce();
      expect(currentModules.db.registerPeekHost).toHaveBeenCalledWith(
        'peek-a',
        'http://peek-a:9876',
        'admin@peek-a',
        true,
        'linux',
      );
      expectSuccess(res, {
        name: 'peek-a',
        url: 'http://peek-a:9876',
        ssh: 'admin@peek-a',
        enabled: 1,
        platform: 'linux',
        is_default: 1,
      }, 201);
    });

    it('returns 400 when the name or url is missing', async () => {
      const res = createRes();

      await handlers.handleCreatePeekHost(
        createReq({ body: { name: 'peek-a' } }),
        res,
      );

      expectFailure(res, 'Peek host name and url are required', 400);
      expect(currentModules.db.registerPeekHost).not.toHaveBeenCalled();
    });

    it('returns 400 when the supplied URL is invalid', async () => {
      const res = createRes();

      await handlers.handleCreatePeekHost(
        createReq({ body: { name: 'peek-a', url: 'not-a-url' } }),
        res,
      );

      expectFailure(res, 'Invalid peek host URL', 400);
      expect(currentModules.db.registerPeekHost).not.toHaveBeenCalled();
    });
  });

  describe('handleUpdatePeekHost', () => {
    it('returns 404 when the target peek host does not exist', async () => {
      const res = createRes();

      await handlers.handleUpdatePeekHost(
        createReq({ body: { url: 'http://peek-a:9876' } }),
        res,
        {},
        'missing-peek',
      );

      expectFailure(res, 'Peek host not found', 404);
    });

    it('returns 400 when the updated record is missing a name or url', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createRes();

      await handlers.handleUpdatePeekHost(
        createReq({ body: { url: '' } }),
        res,
        {},
        'peek-a',
      );

      expectFailure(res, 'Peek host name and url are required', 400);
      expect(currentModules.db.registerPeekHost).not.toHaveBeenCalled();
    });

    it('returns 400 when the updated peek URL is invalid', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createRes();

      await handlers.handleUpdatePeekHost(
        createReq({ body: { url: 'bad-url' } }),
        res,
        {},
        'peek-a',
      );

      expectFailure(res, 'Invalid peek host URL', 400);
      expect(currentModules.db.registerPeekHost).not.toHaveBeenCalled();
    });

    it('returns 409 when renaming to an existing peek host name', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      seedPeekHost({ name: 'peek-b', url: 'http://peek-b:9876' });
      const res = createRes();

      await handlers.handleUpdatePeekHost(
        createReq({ body: { name: 'peek-b', url: 'http://peek-b:9876' } }),
        res,
        {},
        'peek-a',
      );

      expectFailure(res, 'Peek host already exists', 409);
      expect(currentModules.db.registerPeekHost).not.toHaveBeenCalled();
    });

    it('updates a peek host in place and preserves existing default and ssh values when omitted', async () => {
      seedPeekHost({
        name: 'peek-a',
        url: 'http://peek-a:9876',
        ssh: 'admin@peek-a',
        platform: 'windows',
        is_default: 1,
        enabled: 0,
      });
      const res = createRes();

      await handlers.handleUpdatePeekHost(
        createReq({
          body: {
            url: 'https://peek-a:443',
            platform: 'linux',
          },
        }),
        res,
        {},
        'peek-a',
      );

      expect(currentModules.db.registerPeekHost).toHaveBeenCalledWith(
        'peek-a',
        'https://peek-a:443',
        'admin@peek-a',
        true,
        'linux',
      );
      expect(currentModules.hostManagement.deleteAllHostCredentials).not.toHaveBeenCalled();
      expect(currentModules.db.unregisterPeekHost).not.toHaveBeenCalled();
      expectSuccess(res, {
        name: 'peek-a',
        url: 'https://peek-a:443',
        ssh: 'admin@peek-a',
        enabled: 0,
        platform: 'linux',
        is_default: 1,
      });
    });

    it('renames a peek host, migrates stored credentials, and removes the old host', async () => {
      seedPeekHost({
        name: 'peek-a',
        url: 'http://peek-a:9876',
        ssh: 'admin@peek-a',
        platform: 'linux',
        is_default: 0,
      });
      seedCredential('peek-a', 'peek', {
        credential_type: 'ssh',
        label: 'Primary SSH',
        value: { user: 'root', key_path: '/id_ed25519' },
      });
      seedCredential('peek-a', 'peek', {
        credential_type: 'windows',
        label: 'Windows auth',
        value: null,
      });
      const res = createRes();

      await handlers.handleUpdatePeekHost(
        createReq({
          body: {
            name: 'peek-renamed',
            url: 'https://peek-renamed:9876',
          },
        }),
        res,
        {},
        'peek-a',
      );

      expect(currentModules.db.registerPeekHost).toHaveBeenCalledWith(
        'peek-renamed',
        'https://peek-renamed:9876',
        'admin@peek-a',
        false,
        'linux',
      );
      expect(currentModules.hostManagement.saveCredential).toHaveBeenCalledWith(
        'peek-renamed',
        'peek',
        'ssh',
        'Primary SSH',
        { user: 'root', key_path: '/id_ed25519' },
      );
      expect(currentModules.hostManagement.saveCredential).toHaveBeenCalledTimes(1);
      expect(currentModules.hostManagement.deleteAllHostCredentials).toHaveBeenCalledWith('peek-a', 'peek');
      expect(currentModules.db.unregisterPeekHost).toHaveBeenCalledWith('peek-a');
      expectSuccess(res, {
        name: 'peek-renamed',
        url: 'https://peek-renamed:9876',
        ssh: 'admin@peek-a',
        enabled: 1,
        platform: 'linux',
        is_default: 0,
      });
      expect(state.peekHosts.has('peek-a')).toBe(false);
    });
  });

  describe('handleDeletePeekHost', () => {
    it('deletes a peek host and removes all of its credentials', () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      seedCredential('peek-a', 'peek', { credential_type: 'ssh', label: 'SSH' });
      const res = createRes();

      handlers.handleDeletePeekHost(createReq(), res, {}, 'peek-a');

      expect(currentModules.db.unregisterPeekHost).toHaveBeenCalledWith('peek-a');
      expect(currentModules.hostManagement.deleteAllHostCredentials).toHaveBeenCalledWith('peek-a', 'peek');
      expectSuccess(res, { removed: true, name: 'peek-a' });
    });

    it('returns 404 when deleting an unknown peek host', () => {
      const res = createRes();

      handlers.handleDeletePeekHost(createReq(), res, {}, 'missing-peek');

      expectFailure(res, 'Peek host not found', 404);
      expect(currentModules.hostManagement.deleteAllHostCredentials).not.toHaveBeenCalled();
    });
  });

  describe('handleListCredentials', () => {
    it('returns credentials for a peek host', () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      seedCredential('peek-a', 'peek', { credential_type: 'ssh', label: 'Peek SSH' });
      const res = createRes();

      handlers.handleListCredentials(createReq(), res, {}, 'peek-a');

      expect(currentModules.hostManagement.listCredentials).toHaveBeenCalledWith('peek-a', 'peek');
      expectSuccess(res, [
        { host_name: 'peek-a', host_type: 'peek', credential_type: 'ssh', label: 'Peek SSH' },
      ]);
    });

    it('returns credentials for an ollama host', () => {
      seedOllamaHost({ id: 'host-a', name: 'host-a', url: 'http://host-a:11434' });
      seedCredential('host-a', 'ollama', { credential_type: 'http_auth', label: 'API auth' });
      const res = createRes();

      handlers.handleListCredentials(createReq(), res, {}, 'host-a');

      expect(currentModules.hostManagement.listCredentials).toHaveBeenCalledWith('host-a', 'ollama');
      expectSuccess(res, [
        { host_name: 'host-a', host_type: 'ollama', credential_type: 'http_auth', label: 'API auth' },
      ]);
    });

    it('prefers the peek host type when a name exists in both host stores', () => {
      seedPeekHost({ name: 'shared-host', url: 'http://peek-shared:9876' });
      seedOllamaHost({ id: 'shared-host', name: 'shared-host', url: 'http://ollama-shared:11434' });
      seedCredential('shared-host', 'peek', { credential_type: 'ssh', label: 'Peek SSH' });
      seedCredential('shared-host', 'ollama', { credential_type: 'http_auth', label: 'Ollama auth' });
      const res = createRes();

      handlers.handleListCredentials(createReq(), res, {}, 'shared-host');

      expect(currentModules.hostManagement.listCredentials).toHaveBeenCalledWith('shared-host', 'peek');
      expect(currentModules.hostManagement.listCredentials).not.toHaveBeenCalledWith('shared-host', 'ollama');
      expectSuccess(res, [
        { host_name: 'shared-host', host_type: 'peek', credential_type: 'ssh', label: 'Peek SSH' },
      ]);
    });

    it('returns 404 when the host cannot be resolved', () => {
      const res = createRes();

      handlers.handleListCredentials(createReq(), res, {}, 'missing-host');

      expectFailure(res, 'Host not found', 404);
    });
  });

  describe('handleSaveCredential', () => {
    it('saves a supported credential for a peek host', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createRes();

      await handlers.handleSaveCredential(
        createReq({
          body: {
            label: 'Primary SSH',
            value: { user: 'root', key_path: '/id_ed25519' },
          },
        }),
        res,
        {},
        'peek-a',
        'ssh',
      );

      expect(currentModules.hostManagement.saveCredential).toHaveBeenCalledWith(
        'peek-a',
        'peek',
        'ssh',
        'Primary SSH',
        { user: 'root', key_path: '/id_ed25519' },
      );
      expectSuccess(res, { saved: true });
    });

    it('saves a supported credential for an ollama host', async () => {
      seedOllamaHost({ id: 'host-a', name: 'host-a', url: 'http://host-a:11434' });
      const res = createRes();

      await handlers.handleSaveCredential(
        createReq({
          body: {
            label: 'HTTP auth',
            value: { username: 'api', password: 'secret' },
          },
        }),
        res,
        {},
        'host-a',
        'http_auth',
      );

      expect(currentModules.hostManagement.saveCredential).toHaveBeenCalledWith(
        'host-a',
        'ollama',
        'http_auth',
        'HTTP auth',
        { username: 'api', password: 'secret' },
      );
      expectSuccess(res, { saved: true });
    });

    it('returns 404 when the host is unknown', async () => {
      const res = createRes();

      await handlers.handleSaveCredential(
        createReq({ body: { value: { user: 'root' } } }),
        res,
        {},
        'missing-host',
        'ssh',
      );

      expectFailure(res, 'Host not found', 404);
    });

    it('returns 400 for unsupported credential types', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createRes();

      await handlers.handleSaveCredential(
        createReq({ body: { value: { token: 'abc' } } }),
        res,
        {},
        'peek-a',
        'token',
      );

      expectFailure(res, 'Unsupported credential type', 400);
      expect(currentModules.hostManagement.saveCredential).not.toHaveBeenCalled();
    });

    it('returns 400 when the credential value object is missing', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createRes();

      await handlers.handleSaveCredential(
        createReq({ body: {} }),
        res,
        {},
        'peek-a',
        'ssh',
      );

      expectFailure(res, 'Credential value object is required', 400);
    });

    it('returns 400 when the credential value is an array', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createRes();

      await handlers.handleSaveCredential(
        createReq({ body: { value: ['bad'] } }),
        res,
        {},
        'peek-a',
        'ssh',
      );

      expectFailure(res, 'Credential value object is required', 400);
    });
  });

  describe('handleDeleteCredential', () => {
    it('deletes an existing stored credential', () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      seedCredential('peek-a', 'peek', { credential_type: 'windows', label: 'Windows login' });
      const res = createRes();

      handlers.handleDeleteCredential(createReq(), res, {}, 'peek-a', 'windows');

      expect(currentModules.hostManagement.deleteCredential).toHaveBeenCalledWith('peek-a', 'peek', 'windows');
      expectSuccess(res, { removed: true, host: 'peek-a', credential_type: 'windows' });
    });

    it('returns 400 for unsupported credential types', () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createRes();

      handlers.handleDeleteCredential(createReq(), res, {}, 'peek-a', 'oauth');

      expectFailure(res, 'Unsupported credential type', 400);
    });

    it('returns 404 when the host is unknown', () => {
      const res = createRes();

      handlers.handleDeleteCredential(createReq(), res, {}, 'missing-host', 'ssh');

      expectFailure(res, 'Host not found', 404);
    });

    it('returns 404 when the credential does not exist', () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createRes();

      handlers.handleDeleteCredential(createReq(), res, {}, 'peek-a', 'ssh');

      expectFailure(res, 'Credential not found', 404);
    });
  });

  describe('handleTestCredential', () => {
    it('returns 404 when the host cannot be resolved', async () => {
      const res = createRes();

      await handlers.handleTestCredential(createReq(), res, {}, 'missing-host', 'ssh');

      expectFailure(res, 'Host not found', 404);
    });

    it('returns 400 for unsupported credential types', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createRes();

      await handlers.handleTestCredential(createReq(), res, {}, 'peek-a', 'token');

      expectFailure(res, 'Unsupported credential type', 400);
    });

    it('returns 404 when the credential is not stored', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      const res = createRes();

      await handlers.handleTestCredential(createReq(), res, {}, 'peek-a', 'ssh');

      expectFailure(res, 'Credential not found', 404);
    });

    it('returns a not-implemented marker for non-peek hosts', async () => {
      seedOllamaHost({ id: 'host-a', name: 'host-a', url: 'http://host-a:11434' });
      seedCredential('host-a', 'ollama', {
        credential_type: 'http_auth',
        label: 'API auth',
        value: { username: 'api', password: 'secret' },
      });
      const res = createRes();

      await handlers.handleTestCredential(createReq(), res, {}, 'host-a', 'http_auth');

      expectSuccess(res, { test: 'not_implemented_for_type' });
      expect(currentModules.http.get).not.toHaveBeenCalled();
      expect(currentModules.https.get).not.toHaveBeenCalled();
    });

    it('uses the http transport for http peek URLs and marks 2xx responses as reachable', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      seedCredential('peek-a', 'peek', { credential_type: 'ssh', label: 'SSH' });
      currentModules.http.queueResponse({ statusCode: 204 });
      const res = createRes();

      await handlers.handleTestCredential(createReq(), res, {}, 'peek-a', 'ssh');

      expect(currentModules.http.get).toHaveBeenCalledWith(
        'http://peek-a:9876/health',
        { timeout: 5000 },
        expect.any(Function),
      );
      expect(currentModules.https.get).not.toHaveBeenCalled();
      expectSuccess(res, {
        credential_type: 'ssh',
        host_reachable: true,
        latency_ms: 0,
      });
    });

    it('uses the https transport for https peek URLs', async () => {
      seedPeekHost({ name: 'peek-a', url: 'https://peek-a:9443' });
      seedCredential('peek-a', 'peek', { credential_type: 'windows', label: 'Windows auth' });
      currentModules.https.queueResponse({ statusCode: 200 });
      const res = createRes();

      await handlers.handleTestCredential(createReq(), res, {}, 'peek-a', 'windows');

      expect(currentModules.http.get).not.toHaveBeenCalled();
      expect(currentModules.https.get).toHaveBeenCalledWith(
        'https://peek-a:9443/health',
        { timeout: 5000 },
        expect.any(Function),
      );
      expectSuccess(res, {
        credential_type: 'windows',
        host_reachable: true,
        latency_ms: 0,
      });
    });

    it('marks non-2xx responses as unreachable while preserving latency', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      seedCredential('peek-a', 'peek', { credential_type: 'ssh', label: 'SSH' });
      currentModules.http.queueResponse({ statusCode: 503 });
      const res = createRes();

      await handlers.handleTestCredential(createReq(), res, {}, 'peek-a', 'ssh');

      expectSuccess(res, {
        credential_type: 'ssh',
        host_reachable: false,
        latency_ms: 0,
      });
    });

    it('returns an unreachable result when the request emits an error', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      seedCredential('peek-a', 'peek', { credential_type: 'ssh', label: 'SSH' });
      currentModules.http.queueResponse({ error: new Error('connect ECONNREFUSED') });
      const res = createRes();

      await handlers.handleTestCredential(createReq(), res, {}, 'peek-a', 'ssh');

      expectSuccess(res, {
        credential_type: 'ssh',
        host_reachable: false,
        latency_ms: null,
      });
    });

    it('returns an unreachable result on timeout and destroys the request', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      seedCredential('peek-a', 'peek', { credential_type: 'ssh', label: 'SSH' });
      currentModules.http.queueResponse({ timeout: true });
      const res = createRes();

      await handlers.handleTestCredential(createReq(), res, {}, 'peek-a', 'ssh');

      expect(currentModules.http.calls[0].request.destroy).toHaveBeenCalledOnce();
      expectSuccess(res, {
        credential_type: 'ssh',
        host_reachable: false,
        latency_ms: null,
      });
    });
  });

  describe('handleTestPeekHost', () => {
    it('returns 404 when the peek host does not exist', async () => {
      const res = createRes();

      await handlers.handleTestPeekHost(createReq(), res, {}, 'missing-peek');

      expectFailure(res, 'Peek host not found', 404);
    });

    it('uses http for http peek URLs and parses health metadata', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      currentModules.http.queueResponse({
        statusCode: 200,
        body: { version: '1.2.3', hostname: 'peek-a', platform: 'linux' },
      });
      const res = createRes();

      await handlers.handleTestPeekHost(createReq(), res, {}, 'peek-a');

      expect(currentModules.http.get).toHaveBeenCalledWith(
        'http://peek-a:9876/health',
        { timeout: 5000 },
        expect.any(Function),
      );
      expect(currentModules.https.get).not.toHaveBeenCalled();
      expectSuccess(res, {
        reachable: true,
        latency_ms: 0,
        status_code: 200,
        server_version: '1.2.3',
        hostname: 'peek-a',
        platform: 'linux',
      });
    });

    it('uses https for https peek URLs', async () => {
      seedPeekHost({ name: 'peek-a', url: 'https://peek-a:9443' });
      currentModules.https.queueResponse({
        statusCode: 200,
        body: { version: '2.0.0', hostname: 'secure-peek', platform: 'windows' },
      });
      const res = createRes();

      await handlers.handleTestPeekHost(createReq(), res, {}, 'peek-a');

      expect(currentModules.http.get).not.toHaveBeenCalled();
      expect(currentModules.https.get).toHaveBeenCalledWith(
        'https://peek-a:9443/health',
        { timeout: 5000 },
        expect.any(Function),
      );
      expectSuccess(res, {
        reachable: true,
        latency_ms: 0,
        status_code: 200,
        server_version: '2.0.0',
        hostname: 'secure-peek',
        platform: 'windows',
      });
    });

    it('sets metadata fields to null when the response body is not valid JSON', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      currentModules.http.queueResponse({
        statusCode: 200,
        body: '{not-json',
      });
      const res = createRes();

      await handlers.handleTestPeekHost(createReq(), res, {}, 'peek-a');

      expectSuccess(res, {
        reachable: true,
        latency_ms: 0,
        status_code: 200,
        server_version: null,
        hostname: null,
        platform: null,
      });
    });

    it('marks non-2xx responses as unreachable and still reports parsed metadata', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      currentModules.http.queueResponse({
        statusCode: 503,
        body: { version: '1.9.0', hostname: 'peek-a', platform: 'linux' },
      });
      const res = createRes();

      await handlers.handleTestPeekHost(createReq(), res, {}, 'peek-a');

      expectSuccess(res, {
        reachable: false,
        latency_ms: 0,
        status_code: 503,
        server_version: '1.9.0',
        hostname: 'peek-a',
        platform: 'linux',
      });
    });

    it('returns an error payload when the request emits an error', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      currentModules.http.queueResponse({ error: new Error('connect ECONNREFUSED') });
      const res = createRes();

      await handlers.handleTestPeekHost(createReq(), res, {}, 'peek-a');

      expectSuccess(res, {
        reachable: false,
        latency_ms: null,
        error: 'connect ECONNREFUSED',
      });
    });

    it('returns a timeout payload and destroys the request on timeout', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876' });
      currentModules.http.queueResponse({ timeout: true });
      const res = createRes();

      await handlers.handleTestPeekHost(createReq(), res, {}, 'peek-a');

      expect(currentModules.http.calls[0].request.destroy).toHaveBeenCalledOnce();
      expectSuccess(res, {
        reachable: false,
        latency_ms: null,
        error: 'Connection timed out',
      });
    });
  });

  describe('handlePeekHostToggle', () => {
    it('returns 404 when the peek host does not exist', async () => {
      const res = createRes();

      await handlers.handlePeekHostToggle(createReq({ body: { enabled: true } }), res, {}, 'missing-peek');

      expectFailure(res, 'Peek host not found', 404);
    });

    it('enables a peek host when enabled=true is supplied', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876', enabled: 0 });
      const res = createRes();

      await handlers.handlePeekHostToggle(createReq({ body: { enabled: true } }), res, {}, 'peek-a');

      expect(currentModules.db.updatePeekHost).toHaveBeenCalledWith('peek-a', { enabled: 1 });
      expectSuccess(res, {
        name: 'peek-a',
        url: 'http://peek-a:9876',
        ssh: null,
        enabled: 1,
        platform: null,
        is_default: 0,
      });
    });

    it('disables a peek host when enabled=false is supplied', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876', enabled: 1 });
      const res = createRes();

      await handlers.handlePeekHostToggle(createReq({ body: { enabled: false } }), res, {}, 'peek-a');

      expect(currentModules.db.updatePeekHost).toHaveBeenCalledWith('peek-a', { enabled: 0 });
      expectSuccess(res, {
        name: 'peek-a',
        url: 'http://peek-a:9876',
        ssh: null,
        enabled: 0,
        platform: null,
        is_default: 0,
      });
    });

    it('toggles the enabled state when no explicit enabled flag is supplied', async () => {
      seedPeekHost({ name: 'peek-a', url: 'http://peek-a:9876', enabled: 1 });
      const res = createRes();

      await handlers.handlePeekHostToggle(createReq({ body: {} }), res, {}, 'peek-a');

      expect(currentModules.db.updatePeekHost).toHaveBeenCalledWith('peek-a', { enabled: 0 });
      expectSuccess(res, {
        name: 'peek-a',
        url: 'http://peek-a:9876',
        ssh: null,
        enabled: 0,
        platform: null,
        is_default: 0,
      });
    });
  });

  describe('handleHostActivity', () => {
    it('probes reachable hosts, merges memory limits, and annotates running task GPU state', async () => {
      seedOllamaHost({ id: 'host-a', name: 'Alpha', status: 'healthy', enabled: 1, memory_limit_mb: 16384 });
      seedOllamaHost({ id: 'host-b', name: 'Beta', status: 'down', enabled: 1, memory_limit_mb: 8192 });
      state.hostActivity = {
        'host-a': { gpuUtilization: 52 },
        'host-b': { gpuUtilization: 0 },
      };
      state.tasks = [
        { id: 'task-1', status: 'running', ollama_host_id: 'host-a', model: 'llama3' },
        { id: 'task-2', status: 'running', model: 'mistral' },
      ];
      currentModules.taskManager.isModelLoadedOnHost.mockImplementation((hostId, model) => (
        hostId === 'host-a' && model === 'llama3'
      ));
      const res = createRes();

      await handlers.handleHostActivity(createReq(), res);

      expect(currentModules.db.listOllamaHosts).toHaveBeenCalledWith({ enabled: true });
      expect(currentModules.taskManager.probeLocalGpuMetrics).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'host-a' }),
      ]);
      expect(currentModules.taskManager.probeRemoteGpuMetrics).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'host-a' }),
      ]);
      expect(currentModules.taskManager.isModelLoadedOnHost).toHaveBeenCalledWith('host-a', 'llama3');
      expectSuccess(res, {
        hosts: {
          'host-a': { gpuUtilization: 52, memoryLimitMb: 16384 },
          'host-b': { gpuUtilization: 0, memoryLimitMb: 8192 },
        },
        taskGpuStatus: {
          'task-1': true,
        },
      });
    });

    it('supports listTasks returning an object with a tasks array', async () => {
      seedOllamaHost({ id: 'host-a', status: 'healthy', enabled: 1, memory_limit_mb: 4096 });
      state.hostActivity = { 'host-a': { modelsLoaded: 2 } };
      currentModules.db.listTasks.mockReturnValue({
        tasks: [
          { id: 'task-1', status: 'running', ollama_host_id: 'host-a', model: 'qwen2.5' },
        ],
      });
      currentModules.taskManager.isModelLoadedOnHost.mockReturnValueOnce(false);
      const res = createRes();

      await handlers.handleHostActivity(createReq(), res);

      expectSuccess(res, {
        hosts: {
          'host-a': { modelsLoaded: 2, memoryLimitMb: 4096 },
        },
        taskGpuStatus: {
          'task-1': false,
        },
      });
    });

    it('swallows probe failures and still returns the current activity snapshot', async () => {
      seedOllamaHost({ id: 'host-a', status: 'healthy', enabled: 1 });
      state.hostActivity = { 'host-a': { gpuUtilization: 12 } };
      currentModules.taskManager.probeLocalGpuMetrics.mockRejectedValue(new Error('nvidia-smi failed'));
      const res = createRes();

      await handlers.handleHostActivity(createReq(), res);

      expect(currentModules.taskManager.probeRemoteGpuMetrics).not.toHaveBeenCalled();
      expectSuccess(res, {
        hosts: {
          'host-a': { gpuUtilization: 12, memoryLimitMb: 0 },
        },
        taskGpuStatus: {},
      });
    });

    it('skips probing when there are no reachable enabled hosts', async () => {
      seedOllamaHost({ id: 'host-a', status: 'down', enabled: 1 });
      const res = createRes();

      await handlers.handleHostActivity(createReq(), res);

      expect(currentModules.taskManager.probeLocalGpuMetrics).not.toHaveBeenCalled();
      expect(currentModules.taskManager.probeRemoteGpuMetrics).not.toHaveBeenCalled();
      expectSuccess(res, {
        hosts: {},
        taskGpuStatus: {},
      });
    });
  });

  describe('handleHostScan', () => {
    it('returns discovery results and maps totalFound to found', async () => {
      currentModules.discovery.scanNetworkForOllama.mockResolvedValue({
        totalFound: 3,
        hosts: [{ id: 'host-a' }, { id: 'host-b' }, { id: 'host-c' }],
      });
      const res = createRes();

      await handlers.handleHostScan(createReq(), res);

      expect(currentModules.discovery.scanNetworkForOllama).toHaveBeenCalledWith({ autoAdd: true });
      expectSuccess(res, {
        totalFound: 3,
        hosts: [{ id: 'host-a' }, { id: 'host-b' }, { id: 'host-c' }],
        found: 3,
      });
    });

    it('defaults found to 0 when totalFound is absent', async () => {
      currentModules.discovery.scanNetworkForOllama.mockResolvedValue({ hosts: [] });
      const res = createRes();

      await handlers.handleHostScan(createReq(), res);

      expectSuccess(res, {
        hosts: [],
        found: 0,
      });
    });

    it('returns 500 when discovery throws', async () => {
      currentModules.discovery.scanNetworkForOllama.mockRejectedValue(new Error('scan failed'));
      const res = createRes();

      await handlers.handleHostScan(createReq(), res);

      expectFailure(res, 'scan failed', 500);
    });
  });

  describe('handleHostToggle', () => {
    it('returns 404 when the host does not exist', async () => {
      const res = createRes();

      await handlers.handleHostToggle(createReq({ body: { enabled: true } }), res, {}, 'missing-host');

      expectFailure(res, 'Host not found', 404);
    });

    it('disables a host when enabled=false is supplied and skips probing', async () => {
      seedOllamaHost({ id: 'host-a', name: 'Alpha', url: 'http://alpha:11434', enabled: 1, status: 'healthy' });
      const res = createRes();

      await handlers.handleHostToggle(createReq({ body: { enabled: false } }), res, {}, 'host-a');

      expect(currentModules.db.updateOllamaHost).toHaveBeenCalledWith('host-a', {
        enabled: 0,
        status: 'unknown',
        consecutive_failures: 0,
      });
      expect(currentModules.http.get).not.toHaveBeenCalled();
      expect(currentModules.https.get).not.toHaveBeenCalled();
      expect(currentModules.db.recordHostHealthCheck).not.toHaveBeenCalled();
      expectSuccess(res, expect.objectContaining({
        id: 'host-a',
        enabled: 0,
        status: 'unknown',
        consecutive_failures: 0,
      }));
    });

    it('toggles an enabled host off when no enabled flag is supplied', async () => {
      seedOllamaHost({ id: 'host-a', url: 'http://alpha:11434', enabled: 1 });
      const res = createRes();

      await handlers.handleHostToggle(createReq({ body: {} }), res, {}, 'host-a');

      expect(currentModules.db.updateOllamaHost).toHaveBeenCalledWith('host-a', {
        enabled: 0,
        status: 'unknown',
        consecutive_failures: 0,
      });
      expect(currentModules.db.recordHostHealthCheck).not.toHaveBeenCalled();
      expectSuccess(res, expect.objectContaining({ id: 'host-a', enabled: 0 }));
    });

    it('enables an http host, probes /api/tags, and records the discovered models', async () => {
      seedOllamaHost({ id: 'host-a', url: 'http://alpha:11434', enabled: 0 });
      currentModules.http.queueResponse({
        statusCode: 200,
        body: {
          models: [{ name: 'llama3' }, { model: 'qwen2.5' }, { name: '' }],
        },
      });
      const res = createRes();

      await handlers.handleHostToggle(createReq({ body: { enabled: true } }), res, {}, 'host-a');

      expect(currentModules.http.get).toHaveBeenCalledWith(
        'http://alpha:11434/api/tags',
        { timeout: 5000 },
        expect.any(Function),
      );
      expect(currentModules.https.get).not.toHaveBeenCalled();
      expect(currentModules.db.recordHostHealthCheck).toHaveBeenCalledWith('host-a', true, ['llama3', 'qwen2.5']);
      expectSuccess(res, expect.objectContaining({
        id: 'host-a',
        enabled: 1,
      }));
    });

    it('uses the https transport for https ollama hosts', async () => {
      seedOllamaHost({ id: 'host-a', url: 'https://alpha:11434', enabled: 0 });
      currentModules.https.queueResponse({
        statusCode: 200,
        body: {
          models: [{ name: 'mistral' }],
        },
      });
      const res = createRes();

      await handlers.handleHostToggle(createReq({ body: { enabled: true } }), res, {}, 'host-a');

      expect(currentModules.http.get).not.toHaveBeenCalled();
      expect(currentModules.https.get).toHaveBeenCalledWith(
        'https://alpha:11434/api/tags',
        { timeout: 5000 },
        expect.any(Function),
      );
      expect(currentModules.db.recordHostHealthCheck).toHaveBeenCalledWith('host-a', true, ['mistral']);
    });

    it('records healthy=true with null models when /api/tags returns invalid JSON', async () => {
      seedOllamaHost({ id: 'host-a', url: 'http://alpha:11434', enabled: 0 });
      currentModules.http.queueResponse({
        statusCode: 200,
        body: '{bad-json',
      });
      const res = createRes();

      await handlers.handleHostToggle(createReq({ body: { enabled: true } }), res, {}, 'host-a');

      expect(currentModules.db.recordHostHealthCheck).toHaveBeenCalledWith('host-a', true, null);
      expectSuccess(res, expect.objectContaining({ id: 'host-a', enabled: 1 }));
    });

    it('records an unhealthy result when /api/tags returns a non-200 status', async () => {
      seedOllamaHost({ id: 'host-a', url: 'http://alpha:11434', enabled: 0 });
      currentModules.http.queueResponse({
        statusCode: 503,
        body: 'unavailable',
      });
      const res = createRes();

      await handlers.handleHostToggle(createReq({ body: { enabled: true } }), res, {}, 'host-a');

      expect(currentModules.db.recordHostHealthCheck).toHaveBeenCalledWith('host-a', false, null);
      expectSuccess(res, expect.objectContaining({ id: 'host-a', enabled: 1 }));
    });

    it('records an unhealthy result when the probe emits an error', async () => {
      seedOllamaHost({ id: 'host-a', url: 'http://alpha:11434', enabled: 0 });
      currentModules.http.queueResponse({ error: new Error('connect ECONNREFUSED') });
      const res = createRes();

      await handlers.handleHostToggle(createReq({ body: { enabled: true } }), res, {}, 'host-a');

      expect(currentModules.db.recordHostHealthCheck).toHaveBeenCalledWith('host-a', false, null);
      expectSuccess(res, expect.objectContaining({ id: 'host-a', enabled: 1 }));
    });

    it('records an unhealthy result on timeout and destroys the request', async () => {
      seedOllamaHost({ id: 'host-a', url: 'http://alpha:11434', enabled: 0 });
      currentModules.http.queueResponse({ timeout: true });
      const res = createRes();

      await handlers.handleHostToggle(createReq({ body: { enabled: true } }), res, {}, 'host-a');

      expect(currentModules.http.calls[0].request.destroy).toHaveBeenCalledOnce();
      expect(currentModules.db.recordHostHealthCheck).toHaveBeenCalledWith('host-a', false, null);
      expectSuccess(res, expect.objectContaining({ id: 'host-a', enabled: 1 }));
    });

    it('swallows probe setup failures and still returns the updated host', async () => {
      seedOllamaHost({ id: 'host-a', url: 'not-a-valid-url', enabled: 0 });
      const res = createRes();

      await handlers.handleHostToggle(createReq({ body: { enabled: true } }), res, {}, 'host-a');

      expect(currentModules.db.recordHostHealthCheck).not.toHaveBeenCalled();
      expectSuccess(res, expect.objectContaining({ id: 'host-a', enabled: 1 }));
    });
  });

  describe('handleGetHost', () => {
    it('returns a single host merged with its settings', () => {
      seedOllamaHost({ id: 'host-a', name: 'Alpha', url: 'http://alpha:11434' });
      state.hostSettings.set('host-a', { schedule: 'nightly', tags: ['gpu'] });
      const res = createRes();

      handlers.handleGetHost(createReq(), res, {}, 'host-a');

      expect(currentModules.db.getHostSettings).toHaveBeenCalledWith('host-a');
      expectSuccess(res, {
        id: 'host-a',
        name: 'Alpha',
        url: 'http://alpha:11434',
        enabled: 1,
        running_tasks: 0,
        status: 'healthy',
        consecutive_failures: 0,
        memory_limit_mb: 0,
        settings: { schedule: 'nightly', tags: ['gpu'] },
      });
    });

    it('defaults settings to an empty object when no host settings are stored', () => {
      seedOllamaHost({ id: 'host-a', url: 'http://alpha:11434' });
      const res = createRes();

      handlers.handleGetHost(createReq(), res, {}, 'host-a');

      expectSuccess(res, expect.objectContaining({
        id: 'host-a',
        settings: {},
      }));
    });

    it('returns 404 when the host does not exist', () => {
      const res = createRes();

      handlers.handleGetHost(createReq(), res, {}, 'missing-host');

      expectFailure(res, 'Host not found', 404);
    });
  });

  describe('handleDeleteHost', () => {
    it('removes an ollama host that has no running tasks', () => {
      seedOllamaHost({ id: 'host-a', name: 'Alpha', running_tasks: 0 });
      const res = createRes();

      handlers.handleDeleteHost(createReq(), res, {}, 'host-a');

      expect(currentModules.db.removeOllamaHost).toHaveBeenCalledWith('host-a');
      expectSuccess(res, {
        removed: true,
        id: 'host-a',
        name: 'Alpha',
      });
    });

    it('returns 404 when deleting an unknown host', () => {
      const res = createRes();

      handlers.handleDeleteHost(createReq(), res, {}, 'missing-host');

      expectFailure(res, 'Host not found', 404);
    });

    it('returns 400 when the host still has running tasks', () => {
      seedOllamaHost({ id: 'host-a', running_tasks: 2 });
      const res = createRes();

      handlers.handleDeleteHost(createReq(), res, {}, 'host-a');

      expect(currentModules.db.removeOllamaHost).not.toHaveBeenCalled();
      expectFailure(res, 'Cannot remove host with running tasks', 400);
    });
  });

  describe('getProviderTimeSeries', () => {
    it('builds a per-day total/completed/failed series using countTasks', () => {
      seedTask({
        id: 'task-1',
        provider: 'openai',
        status: 'completed',
        completed_at: '2026-03-11T10:00:00.000Z',
      });
      seedTask({
        id: 'task-2',
        provider: 'openai',
        status: 'failed',
        completed_at: '2026-03-11T11:00:00.000Z',
      });
      seedTask({
        id: 'task-3',
        provider: 'openai',
        status: 'completed',
        completed_at: '2026-03-12T09:00:00.000Z',
      });

      const series = handlers.getProviderTimeSeries('openai', 2);

      expect(series).toEqual([
        { date: '2026-03-11', total: 2, completed: 1, failed: 1 },
        { date: '2026-03-12', total: 1, completed: 1, failed: 0 },
      ]);
      expect(currentModules.db.countTasks).toHaveBeenCalledTimes(6);
    });
  });

  describe('handleListProviders', () => {
    it('returns providers enriched with their 7-day stats', () => {
      seedProvider({ provider: 'openai', enabled: 1 });
      seedProvider({ provider: 'anthropic', enabled: 0 });
      setProviderStats('openai', 7, { total: 10, completed: 9, failed: 1 });
      setProviderStats('anthropic', 7, { total: 4, completed: 3, failed: 1 });
      const res = createRes();

      handlers.handleListProviders(createReq(), res, {});

      expect(currentModules.db.getProviderStats).toHaveBeenCalledWith('openai', 7);
      expect(currentModules.db.getProviderStats).toHaveBeenCalledWith('anthropic', 7);
      expectSuccess(res, [
        {
          provider: 'openai',
          enabled: 1,
          stats: { total: 10, completed: 9, failed: 1 },
        },
        {
          provider: 'anthropic',
          enabled: 0,
          stats: { total: 4, completed: 3, failed: 1 },
        },
      ]);
    });
  });

  describe('handleProviderStats', () => {
    it('returns provider stats with an explicit time-series window', () => {
      seedTask({
        id: 'task-1',
        provider: 'openai',
        status: 'completed',
        completed_at: '2026-03-11T10:00:00.000Z',
      });
      seedTask({
        id: 'task-2',
        provider: 'openai',
        status: 'failed',
        completed_at: '2026-03-12T11:00:00.000Z',
      });
      setProviderStats('openai', 2, { total: 2, completed: 1, failed: 1 });
      const res = createRes();

      handlers.handleProviderStats(createReq(), res, { days: '2' }, 'openai');

      expect(currentModules.db.getProviderStats).toHaveBeenCalledWith('openai', 2);
      expectSuccess(res, {
        total: 2,
        completed: 1,
        failed: 1,
        timeSeries: [
          { date: '2026-03-11', total: 1, completed: 1, failed: 0 },
          { date: '2026-03-12', total: 1, completed: 0, failed: 1 },
        ],
      });
    });

    it('defaults the stats window to 7 days when query.days is invalid', () => {
      setProviderStats('openai', 7, { total: 0, completed: 0, failed: 0 });
      const res = createRes();

      handlers.handleProviderStats(createReq(), res, { days: 'oops' }, 'openai');

      expect(currentModules.db.getProviderStats).toHaveBeenCalledWith('openai', 7);
      expect(res.payload.timeSeries).toHaveLength(7);
    });
  });

  describe('handleProviderPercentiles', () => {
    it('computes duration percentiles from a task array response', () => {
      currentModules.db.listTasks.mockReturnValue([
        {
          id: 'task-1',
          provider: 'openai',
          started_at: '2026-03-11T10:00:00.000Z',
          completed_at: '2026-03-11T10:00:10.000Z',
        },
        {
          id: 'task-2',
          provider: 'openai',
          started_at: '2026-03-11T10:01:00.000Z',
          completed_at: '2026-03-11T10:01:20.000Z',
        },
        {
          id: 'task-3',
          provider: 'openai',
          started_at: '2026-03-11T10:02:00.000Z',
          completed_at: '2026-03-11T10:02:30.000Z',
        },
        {
          id: 'task-4',
          provider: 'openai',
          started_at: '2026-03-11T10:03:00.000Z',
          completed_at: '2026-03-11T10:03:40.000Z',
        },
        {
          id: 'task-5',
          provider: 'openai',
          started_at: '2026-03-11T10:04:00.000Z',
          completed_at: '2026-03-11T10:04:50.000Z',
        },
      ]);
      const res = createRes();

      handlers.handleProviderPercentiles(createReq(), res, { days: '7' }, 'openai');

      expect(currentModules.db.listTasks).toHaveBeenCalledWith({
        provider: 'openai',
        since: '2026-03-05T12:00:00.000Z',
        limit: 1000,
      });
      expectSuccess(res, {
        provider: 'openai',
        days: 7,
        count: 5,
        p50: 30,
        p75: 40,
        p90: 50,
        p95: 50,
        p99: 50,
        min: 10,
        max: 50,
      });
    });

    it('supports listTasks returning an object with a tasks array', () => {
      currentModules.db.listTasks.mockReturnValue({
        tasks: [
          {
            id: 'task-1',
            provider: 'openai',
            started_at: '2026-03-12T10:00:00.000Z',
            completed_at: '2026-03-12T10:00:15.000Z',
          },
        ],
      });
      const res = createRes();

      handlers.handleProviderPercentiles(createReq(), res, { days: '2' }, 'openai');

      expectSuccess(res, {
        provider: 'openai',
        days: 2,
        count: 1,
        p50: 15,
        p75: 15,
        p90: 15,
        p95: 15,
        p99: 15,
        min: 15,
        max: 15,
      });
    });

    it('returns null percentiles when no tasks include durations', () => {
      currentModules.db.listTasks.mockReturnValue([
        { id: 'task-1', provider: 'openai', started_at: null, completed_at: null },
      ]);
      const res = createRes();

      handlers.handleProviderPercentiles(createReq(), res, { days: '1' }, 'openai');

      expectSuccess(res, {
        provider: 'openai',
        days: 1,
        count: 0,
        p50: null,
        p75: null,
        p90: null,
        p95: null,
        p99: null,
        min: null,
        max: null,
      });
    });

    it('returns 500 when task lookup throws', () => {
      currentModules.db.listTasks.mockImplementation(() => {
        throw new Error('provider stats unavailable');
      });
      const res = createRes();

      handlers.handleProviderPercentiles(createReq(), res, { days: '7' }, 'openai');

      expectFailure(res, 'provider stats unavailable', 500);
    });
  });

  describe('handleProviderTrends', () => {
    it('returns a unified multi-provider trend series with per-provider success rates', () => {
      seedProvider({ provider: 'openai', enabled: 1 });
      seedProvider({ provider: 'anthropic', enabled: 1 });
      seedTask({
        id: 'task-1',
        provider: 'openai',
        status: 'completed',
        completed_at: '2026-03-11T09:00:00.000Z',
      });
      seedTask({
        id: 'task-2',
        provider: 'openai',
        status: 'failed',
        completed_at: '2026-03-12T09:00:00.000Z',
      });
      seedTask({
        id: 'task-3',
        provider: 'anthropic',
        status: 'completed',
        completed_at: '2026-03-12T10:00:00.000Z',
      });
      const res = createRes();

      handlers.handleProviderTrends(createReq(), res, { days: '2' });

      expectSuccess(res, {
        providers: ['openai', 'anthropic'],
        series: [
          {
            date: '2026-03-11',
            openai_total: 1,
            openai_completed: 1,
            openai_failed: 0,
            openai_successRate: 100,
            anthropic_total: 0,
            anthropic_completed: 0,
            anthropic_failed: 0,
            anthropic_successRate: null,
          },
          {
            date: '2026-03-12',
            openai_total: 1,
            openai_completed: 0,
            openai_failed: 1,
            openai_successRate: 0,
            anthropic_total: 1,
            anthropic_completed: 1,
            anthropic_failed: 0,
            anthropic_successRate: 100,
          },
        ],
      });
    });
  });

  describe('handleProviderToggle', () => {
    it('updates the provider enabled flag when enabled=false is supplied', async () => {
      seedProvider({ provider: 'openai', enabled: 1 });
      const res = createRes();

      await handlers.handleProviderToggle(
        createReq({ body: { enabled: false } }),
        res,
        {},
        'openai',
      );

      expect(currentModules.utils.safeDecodeParam).toHaveBeenCalledWith('openai', res);
      expect(currentModules.db.updateProvider).toHaveBeenCalledWith('openai', { enabled: 0 });
      expectSuccess(res, {
        provider: 'openai',
        enabled: false,
      });
    });

    it('toggles the provider when enabled is omitted', async () => {
      seedProvider({ provider: 'anthropic', enabled: 0 });
      const res = createRes();

      await handlers.handleProviderToggle(
        createReq({ body: {} }),
        res,
        {},
        'anthropic',
      );

      expect(currentModules.db.updateProvider).toHaveBeenCalledWith('anthropic', { enabled: 1 });
      expectSuccess(res, {
        provider: 'anthropic',
        enabled: true,
      });
    });

    it('returns 404 when the provider does not exist', async () => {
      const res = createRes();

      await handlers.handleProviderToggle(
        createReq({ body: { enabled: true } }),
        res,
        {},
        'missing-provider',
      );

      expectFailure(res, 'Provider not found', 404);
    });

    it('returns early when safeDecodeParam rejects the provider identifier', async () => {
      const res = createRes();

      await handlers.handleProviderToggle(
        createReq({ body: { enabled: true } }),
        res,
        {},
        '%E0%A4%A',
      );

      expectFailure(res, 'Invalid identifier encoding', 400);
      expect(currentModules.db.getProvider).not.toHaveBeenCalled();
      expect(currentModules.db.updateProvider).not.toHaveBeenCalled();
    });
  });
});
