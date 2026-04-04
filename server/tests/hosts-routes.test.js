const fs = require('fs');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let db;
let hostCreds;
let emailPeek;
let hostsRoutes;
let dispatch;
let healthServer;
let healthUrl;
let hostCounter = 0;

function nextHostName(prefix) {
  hostCounter += 1;
  return `${prefix}-${hostCounter}`;
}

function createMockRes() {
  let resolvePromise;
  const done = new Promise((resolve) => {
    resolvePromise = resolve;
  });

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

function createMockReq({
  method = 'GET',
  url = '/',
  headers = {},
  body,
  remoteAddress = '127.0.0.1',
} = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  req.connection = { remoteAddress };
  req.destroy = vi.fn();

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

function createMockHealthCheckGet(statusCode = 200) {
  return vi.fn((url, options, onResponse) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    response.resume = vi.fn(() => {
      process.nextTick(() => response.emit('end'));
    });

    const request = new EventEmitter();
    request.destroy = vi.fn();

    process.nextTick(() => onResponse(response));
    return request;
  });
}

beforeAll(async () => {
  // On Windows, fs.fsyncSync on certain temp-dir paths fails with EPERM.
  // Mock it to a no-op since fsync is a durability hint used by getOrCreateKey().
  vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {});
  vi.spyOn(fs, 'closeSync').mockImplementation(() => {});

  const env = setupTestDbOnly('hosts-routes');
  db = env.db;
  hostCreds = require('../db/host-management');
  emailPeek = require('../db/email-peek');
  Object.assign(hostCreds, {
    registerPeekHost: emailPeek.registerPeekHost,
    unregisterPeekHost: emailPeek.unregisterPeekHost,
    listPeekHosts: emailPeek.listPeekHosts,
    getPeekHost: emailPeek.getPeekHost,
  });
  hostsRoutes = require('../dashboard/routes/infrastructure');
  ({ dispatch } = require('../dashboard/router'));

  healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => {
    healthServer.listen(0, '127.0.0.1', resolve);
  });

  const address = healthServer.address();
  healthUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  const conn = db.getDbInstance();
  for (const table of ['peek_hosts', 'host_credentials']) {
    try { conn.prepare(`DELETE FROM ${table}`).run(); } catch { /* ignore */ }
  }
});

afterAll(async () => {
  if (healthServer) {
    await new Promise((resolve, reject) => {
      healthServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
  vi.restoreAllMocks();
  teardownTestDb();
});

describe('peek host and credential db helpers', () => {
  it('lists peek hosts', () => {
    const hosts = db.listPeekHosts();
    expect(Array.isArray(hosts)).toBe(true);
  });

  it('registers a new peek host', () => {
    const hostName = nextHostName('db-station');
    db.registerPeekHost(hostName, 'http://10.0.0.5:9876', 'user@10.0.0.5', false, 'linux');

    const host = db.getPeekHost(hostName);
    expect(host).not.toBeNull();
    expect(host.url).toBe('http://10.0.0.5:9876');
  });

  it('updates default host', () => {
    const hostName = nextHostName('db-default');
    db.registerPeekHost(hostName, 'http://10.0.0.15:9876', null, true, 'linux');

    const defaultHost = db.getDefaultPeekHost();
    expect(defaultHost.name).toBe(hostName);
  });

  it('removes a peek host and cascades credentials', () => {
    const hostName = nextHostName('db-temp');
    db.registerPeekHost(hostName, 'http://10.0.0.99:9876', null, false, 'windows');
    hostCreds.saveCredential(hostName, 'peek', 'ssh', 'temp ssh', {
      user: 'a',
      key_path: '/b',
      port: 22,
    });

    expect(hostCreds.listCredentials(hostName, 'peek').length).toBe(1);
    db.unregisterPeekHost(hostName);
    hostCreds.deleteAllHostCredentials(hostName, 'peek');
    expect(hostCreds.listCredentials(hostName, 'peek').length).toBe(0);
  });

  it('credential list returns metadata only', () => {
    const hostName = nextHostName('db-cred');
    db.registerPeekHost(hostName, 'http://10.0.0.50:9876', null, false, 'windows');
    hostCreds.saveCredential(hostName, 'peek', 'ssh', 'My SSH', {
      user: 'root',
      key_path: '/key',
      port: 22,
    });

    const list = hostCreds.listCredentials(hostName, 'peek');
    expect(list[0]).not.toHaveProperty('encrypted_value');
    expect(list[0]).toHaveProperty('credential_type', 'ssh');
    expect(list[0]).toHaveProperty('label', 'My SSH');
  });
});

describe('peek host and credential routes', () => {
  it('lists peek hosts with attached credential metadata', () => {
    const hostName = nextHostName('route-list');
    db.registerPeekHost(hostName, 'http://10.0.0.51:9876', null, false, 'windows');
    hostCreds.saveCredential(hostName, 'peek', 'ssh', 'SSH', {
      user: 'root',
      key_path: '/key',
      port: 22,
    });

    const { res } = createMockRes();
    hostsRoutes.handleListPeekHosts(null, res);

    const body = parseJsonBody(res.body);
    const host = body.find((entry) => entry.name === hostName);
    expect(host).toBeDefined();
    expect(host.credentials).toHaveLength(1);
    expect(host.credentials[0]).toMatchObject({
      credential_type: 'ssh',
      label: 'SSH',
    });
    expect(host.credentials[0]).not.toHaveProperty('encrypted_value');
  });

  it('creates a new peek host through the route handler', async () => {
    const hostName = nextHostName('route-create');
    const req = createMockReq({
      method: 'POST',
      body: {
        name: hostName,
        url: 'http://10.0.0.60:9876',
        ssh: 'ops@10.0.0.60',
        default: false,
        platform: 'linux',
      },
    });
    const { res, done } = createMockRes();
    await hostsRoutes.handleCreatePeekHost(req, res);
    await done;

    expect(res.statusCode).toBe(201);
    expect(parseJsonBody(res.body)).toMatchObject({
      name: hostName,
      url: 'http://10.0.0.60:9876',
      ssh: 'ops@10.0.0.60',
      platform: 'linux',
    });
    expect(db.getPeekHost(hostName)).not.toBeNull();
  });

  it('updates a peek host and migrates credentials on rename', async () => {
    const oldName = nextHostName('route-old');
    const newName = nextHostName('route-new');
    db.registerPeekHost(oldName, 'http://10.0.0.61:9876', null, false, 'windows');
    hostCreds.saveCredential(oldName, 'peek', 'ssh', 'SSH key', {
      user: 'admin',
      key_path: '/keys/id_ed25519',
      port: 22,
    });

    const req = createMockReq({
      method: 'PUT',
      body: {
        name: newName,
        url: 'http://10.0.0.62:9876',
        default: true,
        platform: 'linux',
      },
    });
    const { res, done } = createMockRes();
    await hostsRoutes.handleUpdatePeekHost(req, res, {}, oldName);
    await done;

    expect(parseJsonBody(res.body)).toMatchObject({
      name: newName,
      url: 'http://10.0.0.62:9876',
      platform: 'linux',
      is_default: 1,
    });
    expect(db.getPeekHost(oldName)).toBeNull();
    expect(db.getPeekHost(newName)).not.toBeNull();
    expect(hostCreds.getCredential(oldName, 'peek', 'ssh')).toBeNull();
    expect(hostCreds.getCredential(newName, 'peek', 'ssh')).toMatchObject({
      user: 'admin',
      key_path: '/keys/id_ed25519',
      port: 22,
    });
  });

  it('deletes a peek host and cascades credentials through the route handler', () => {
    const hostName = nextHostName('route-delete');
    db.registerPeekHost(hostName, 'http://10.0.0.63:9876', null, false, 'windows');
    hostCreds.saveCredential(hostName, 'peek', 'windows', 'Windows login', {
      username: 'tester',
      password: 'secret',
      domain: '',
    });

    const { res } = createMockRes();
    hostsRoutes.handleDeletePeekHost(null, res, {}, hostName);

    expect(parseJsonBody(res.body)).toEqual({ removed: true, name: hostName });
    expect(db.getPeekHost(hostName)).toBeNull();
    expect(hostCreds.listCredentials(hostName, 'peek')).toHaveLength(0);
  });

  it('saves and lists credential metadata through route handlers', async () => {
    const hostName = nextHostName('route-creds');
    db.registerPeekHost(hostName, 'http://10.0.0.64:9876', null, false, 'windows');

    const saveReq = createMockReq({
      method: 'PUT',
      body: {
        label: 'SSH access',
        value: {
          user: 'root',
          key_path: '/secure/key',
          port: 2200,
        },
      },
    });
    const saveRes = createMockRes();
    await hostsRoutes.handleSaveCredential(saveReq, saveRes.res, {}, hostName, 'ssh');
    await saveRes.done;

    expect(parseJsonBody(saveRes.res.body)).toEqual({ saved: true });

    const listRes = createMockRes();
    hostsRoutes.handleListCredentials(null, listRes.res, {}, hostName);
    const listBody = parseJsonBody(listRes.res.body);

    expect(listBody).toHaveLength(1);
    expect(listBody[0]).toMatchObject({
      credential_type: 'ssh',
      label: 'SSH access',
    });
    expect(listBody[0]).not.toHaveProperty('encrypted_value');
  });

  it('deletes a credential through the route handler', () => {
    const hostName = nextHostName('route-remove-cred');
    db.registerPeekHost(hostName, 'http://10.0.0.65:9876', null, false, 'windows');
    hostCreds.saveCredential(hostName, 'peek', 'http_auth', 'API token', {
      scheme: 'bearer',
      token: 'abc123',
    });

    const { res } = createMockRes();
    hostsRoutes.handleDeleteCredential(null, res, {}, hostName, 'http_auth');

    expect(parseJsonBody(res.body)).toEqual({
      removed: true,
      host: hostName,
      credential_type: 'http_auth',
    });
    expect(hostCreds.getCredential(hostName, 'peek', 'http_auth')).toBeNull();
  });

  it('tests a saved credential against the peek host health endpoint', async () => {
    const hostName = nextHostName('route-health');
    db.registerPeekHost(hostName, healthUrl, null, false, 'windows');
    hostCreds.saveCredential(hostName, 'peek', 'ssh', 'SSH', {
      user: 'health',
      key_path: '/keys/health',
      port: 22,
    });

    const { res, done } = createMockRes();
    await hostsRoutes.handleTestCredential(null, res, {}, hostName, 'ssh');
    await done;

    const body = parseJsonBody(res.body);
    expect(body.credential_type).toBe('ssh');
    expect(body.host_reachable).toBe(true);
    expect(typeof body.latency_ms).toBe('number');
  });

  it('tests a saved credential against an https peek host with the https client', async () => {
    const hostName = nextHostName('route-health-https');
    db.registerPeekHost(hostName, 'https://peek.example.test:9443/base', null, false, 'linux');
    hostCreds.saveCredential(hostName, 'peek', 'ssh', 'SSH', {
      user: 'health',
      key_path: '/keys/health',
      port: 22,
    });

    const httpsGetSpy = vi.spyOn(https, 'get').mockImplementation(createMockHealthCheckGet(200));
    const httpGetSpy = vi.spyOn(http, 'get').mockImplementation(createMockHealthCheckGet(200));

    try {
      const { res, done } = createMockRes();
      await hostsRoutes.handleTestCredential(null, res, {}, hostName, 'ssh');
      await done;

      const body = parseJsonBody(res.body);
      expect(httpsGetSpy).toHaveBeenCalledTimes(1);
      expect(httpsGetSpy).toHaveBeenCalledWith(
        'https://peek.example.test:9443/health',
        { timeout: 5000 },
        expect.any(Function)
      );
      expect(httpGetSpy).not.toHaveBeenCalled();
      expect(body.credential_type).toBe('ssh');
      expect(body.host_reachable).toBe(true);
      expect(typeof body.latency_ms).toBe('number');
    } finally {
      httpsGetSpy.mockRestore();
      httpGetSpy.mockRestore();
    }
  });

  it('dispatches the new peek host and credential routes', async () => {
    const hostName = nextHostName('route-dispatch');
    db.registerPeekHost(hostName, 'http://10.0.0.66:9876', null, false, 'windows');

    const listReq = createMockReq({
      method: 'GET',
      url: '/api/peek-hosts',
    });
    const listRes = createMockRes();
    await dispatch(listReq, listRes.res, {});
    await listRes.done;
    expect(parseJsonBody(listRes.res.body).some((host) => host.name === hostName)).toBe(true);

    const saveReq = createMockReq({
      method: 'PUT',
      url: `/api/hosts/${hostName}/credentials/ssh`,
      headers: {
        'x-requested-with': 'XMLHttpRequest',
      },
      body: {
        label: 'Dispatch SSH',
        value: {
          user: 'dispatch',
          key_path: '/dispatch/key',
          port: 22,
        },
      },
    });
    const saveRes = createMockRes();
    await dispatch(saveReq, saveRes.res, {});
    await saveRes.done;
    expect(parseJsonBody(saveRes.res.body)).toEqual({ saved: true });
    expect(hostCreds.getCredential(hostName, 'peek', 'ssh')).toMatchObject({
      user: 'dispatch',
      key_path: '/dispatch/key',
      port: 22,
    });
  });
});