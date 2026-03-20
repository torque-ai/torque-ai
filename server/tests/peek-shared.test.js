'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { createConfigMock } = require('./test-helpers');

const mockDb = {
  getTask: vi.fn(),
  getWorkflow: vi.fn(),
  getArtifactConfig: vi.fn(),
  getPeekHost: vi.fn(),
  listPeekHosts: vi.fn(),
  getDefaultPeekHost: vi.fn(),
  getConfig: vi.fn().mockImplementation(createConfigMock()),
};

const mockHandlerShared = {
  ErrorCodes: {
    INVALID_PARAM: 'INVALID_PARAM',
    RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  },
  makeError: vi.fn((code, message) => ({ code, message })),
};

vi.mock('../database', () => mockDb);
vi.mock('../handlers/shared', () => mockHandlerShared);

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadPeekShared() {
  delete require.cache[require.resolve('../handlers/peek/shared')];
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../handlers/shared', mockHandlerShared);
  return require('../handlers/peek/shared');
}

function resetMockDefaults() {
  mockDb.getTask.mockReset().mockReturnValue(null);
  mockDb.getWorkflow.mockReset().mockReturnValue(null);
  mockDb.getArtifactConfig.mockReset().mockReturnValue(null);
  mockDb.getPeekHost.mockReset().mockReturnValue(null);
  mockDb.listPeekHosts.mockReset().mockReturnValue([]);
  mockDb.getDefaultPeekHost.mockReset().mockReturnValue(null);
  mockDb.getConfig.mockReset().mockImplementation(createConfigMock());
  mockHandlerShared.makeError.mockReset().mockImplementation((code, message) => ({ code, message }));
}

function createHttpGetMock(responses) {
  return (url, options, callback) => {
    const next = responses.shift() || {};
    const req = new EventEmitter();
    req.destroy = vi.fn();

    process.nextTick(() => {
      if (next.timeout) {
        req.emit('timeout');
        return;
      }

      if (next.error) {
        req.emit('error', new Error(next.error));
        return;
      }

      const res = new EventEmitter();
      res.statusCode = next.statusCode ?? 200;
      callback(res);

      if (next.body !== undefined) {
        const payload = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
        res.emit('data', Buffer.from(payload));
      }

      res.emit('end');
    });

    return req;
  };
}

function createHttpRequestMock(responses, bodies) {
  return (url, options, callback) => {
    const next = responses.shift() || {};
    const req = new EventEmitter();
    req.destroy = vi.fn();

    let body = '';
    req.write = vi.fn((chunk) => {
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    });
    req.end = vi.fn((chunk) => {
      if (chunk !== undefined) {
        req.write(chunk);
      }

      bodies.push({ url, options, body });

      process.nextTick(() => {
        if (next.timeout) {
          req.emit('timeout');
          return;
        }

        if (next.error) {
          req.emit('error', new Error(next.error));
          return;
        }

        const res = new EventEmitter();
        res.statusCode = next.statusCode ?? 200;
        callback(res);

        if (next.body !== undefined) {
          const payload = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
          res.emit('data', Buffer.from(payload));
        }

        res.emit('end');
      });
    });

    return req;
  };
}

describe('peek shared utilities', () => {
  let peekShared;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetMockDefaults();
    peekShared = loadPeekShared();
  });

  it('formats byte counts across byte, KB, and MB ranges', () => {
    expect(peekShared.formatBytes(999)).toBe('999 B');
    expect(peekShared.formatBytes(1536)).toBe('1.5 KB');
    expect(peekShared.formatBytes(peekShared.LARGE_ARTIFACT_THRESHOLD)).toBe('1.0 MB');
  });

  it('resolves task context from task metadata and task_id aliases', () => {
    const task = {
      id: 'task-1',
      workflow_id: 'wf-1',
      workflow_node_id: 'diagnose-ui',
    };
    mockDb.getTask.mockReturnValue(task);

    const result = peekShared.resolvePeekTaskContext({ task_id: '  task-1  ' });

    expect(mockDb.getTask).toHaveBeenCalledWith('task-1');
    expect(result).toEqual({
      task,
      taskId: 'task-1',
      workflowId: 'wf-1',
      taskLabel: 'diagnose-ui',
    });
  });

  it('validates explicit task and workflow ids when resolving task context', () => {
    expect(() => peekShared.resolvePeekTaskContext({ __taskId: 'missing-task' }))
      .toThrow('Task not found: missing-task');

    mockDb.getTask.mockReturnValue({
      id: 'task-2',
      workflow_id: 'wf-from-task',
      workflow_node_id: 'capture',
    });

    expect(() => peekShared.resolvePeekTaskContext({
      __taskId: 'task-2',
      __workflowId: 'wf-missing',
    })).toThrow('Workflow not found: wf-missing');
  });

  it('prefers configured artifact storage roots and falls back to the user home directory', () => {
    mockDb.getArtifactConfig.mockReturnValue({ storage_path: 'C:\\artifacts' });
    expect(peekShared.getTorqueArtifactStorageRoot()).toBe('C:\\artifacts');

    mockDb.getArtifactConfig.mockReturnValue(null);
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\tester');

    expect(peekShared.getTorqueArtifactStorageRoot())
      .toBe(path.join('C:\\Users\\tester', '.local', 'share', 'torque', 'artifacts'));
  });

  it('builds persisted output directories using task scope and sanitized targets', () => {
    mockDb.getArtifactConfig.mockReturnValue({ storage_path: 'C:\\artifacts' });
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('4fzzzx99');
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

    const outputDir = peekShared.buildPeekPersistOutputDir(
      { taskId: 'task-9', workflowId: 'wf-9', taskLabel: 'Diagnose UI' },
      { title: 'Main Window' },
    );

    const runId = `1700000000000-${'4fzzzx99'.slice(0, 8)}`;
    const expected = path.join('C:\\artifacts', 'task-9', 'peek-diagnose', runId, 'main-window');

    expect(outputDir).toBe(expected);
    expect(mkdirSpy).toHaveBeenCalledWith(expected, { recursive: true });
  });

  it('normalizes MIME types and target keys for persisted artifacts', () => {
    expect(peekShared.inferPeekArtifactMimeType('report.json')).toBe('application/json');
    expect(peekShared.inferPeekArtifactMimeType('capture.jpeg')).toBe('image/jpeg');
    expect(peekShared.inferPeekArtifactMimeType('capture.bin')).toBe('application/octet-stream');

    expect(peekShared.sanitizePeekTargetKey('  Main / Window ## ', 'fallback')).toBe('main-window');
    expect(peekShared.getPeekTargetKey(
      { process: 'Taskmgr' },
      { process: 'My App' },
    )).toBe('process-my-app');
    expect(peekShared.getPeekTargetKey(
      { title: 'Editor' },
      { title: 'Primary Panel' },
    )).toBe('title-primary-panel');
    expect(peekShared.getPeekTargetKey({}, {})).toBe('screen');
  });

  it('normalizes explicitly requested hosts and updates the host cache', () => {
    mockDb.getPeekHost.mockReturnValue({
      name: 'omen',
      url: 'http://omen:9876///',
      enabled: 1,
      ssh: 'user@omen',
      platform: 'windows',
    });

    const result = peekShared.resolvePeekHost({ host: 'omen' });

    expect(result).toEqual({
      hostName: 'omen',
      hostUrl: 'http://omen:9876',
      ssh: 'user@omen',
      platform: 'windows',
    });
    expect(peekShared.PEEK_HOSTS.get('omen')).toEqual(expect.objectContaining({ name: 'omen' }));
  });

  it('prefers enabled localhost hosts for local targets before falling back to defaults', () => {
    mockDb.listPeekHosts.mockReturnValue([
      { name: 'lab', url: 'http://lab:9876', enabled: 1, ssh: null, platform: 'linux' },
      { name: 'local', url: 'http://127.0.0.1:9876/', enabled: 1, ssh: null, platform: 'windows' },
    ]);

    const result = peekShared.resolvePeekHost({ url: 'http://localhost:3000/dashboard' });

    expect(result).toEqual({
      hostName: 'local',
      hostUrl: 'http://127.0.0.1:9876',
      ssh: null,
      platform: 'windows',
    });
    expect(mockDb.getDefaultPeekHost).not.toHaveBeenCalled();
  });

  it('formats explicit-host and unconfigured-host errors through makeError', () => {
    expect(peekShared.resolvePeekHost({ host: 'missing-host' })).toEqual({
      error: {
        code: 'INVALID_PARAM',
        message: 'Peek host not found: missing-host',
      },
    });

    mockDb.getPeekHost.mockReturnValue({
      name: 'disabled-host',
      url: 'http://disabled:9876',
      enabled: 0,
    });

    expect(peekShared.resolvePeekHost({ host: 'disabled-host' })).toEqual({
      error: {
        code: 'INVALID_PARAM',
        message: 'Peek host "disabled-host" is disabled. Enable it via the dashboard.',
      },
    });

    mockDb.getPeekHost.mockReturnValue(null);
    mockDb.listPeekHosts.mockReturnValue([]);
    mockDb.getDefaultPeekHost.mockReturnValue(null);

    expect(peekShared.resolvePeekHost({})).toEqual({
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'No peek host configured. Connect Peek from a workstation card in the dashboard or use the register_peek_host tool.',
      },
    });
    expect(mockHandlerShared.makeError).toHaveBeenCalledTimes(3);
  });

  it('detects local targets, selects the matching HTTP module, and escapes XML', () => {
    expect(peekShared.isLocalTarget({ url: 'http://localhost:3000/app' })).toBe(true);
    expect(peekShared.isLocalTarget({ url: 'https://127.0.0.1/view' })).toBe(true);
    expect(peekShared.isLocalTarget({ url: 'https://example.com/app' })).toBe(false);

    expect(peekShared.getHttpModule('http://example.com')).toBe(http);
    expect(peekShared.getHttpModule('https://example.com')).toBe(https);
    expect(peekShared.escapeXml('<node attr="1">&value</node>'))
      .toBe('&lt;node attr=&quot;1&quot;&gt;&amp;value&lt;/node&gt;');
  });

  it('parses successful GET responses as JSON', async () => {
    const getSpy = vi.spyOn(http, 'get').mockImplementation(createHttpGetMock([
      { statusCode: 200, body: { status: 'healthy', version: 1 } },
    ]));

    const result = await peekShared.peekHttpGetUrl('http://omen:9876/health', 3210);

    expect(getSpy).toHaveBeenCalledWith(
      'http://omen:9876/health',
      { timeout: 3210 },
      expect.any(Function),
    );
    expect(result).toEqual({
      data: { status: 'healthy', version: 1 },
      status: 200,
    });
  });

  it('formats GET invalid-json and transport errors without throwing', async () => {
    vi.spyOn(http, 'get').mockImplementation(createHttpGetMock([
      { statusCode: 502, body: '{invalid-json' },
    ]));

    await expect(peekShared.peekHttpGetUrl('http://omen:9876/health')).resolves.toEqual({
      error: expect.stringContaining('Invalid JSON:'),
      status: 502,
    });

    vi.restoreAllMocks();
    vi.spyOn(http, 'get').mockImplementation(createHttpGetMock([
      { error: 'connect ECONNREFUSED 127.0.0.1:9876' },
    ]));

    await expect(peekShared.peekHttpGetUrl('http://omen:9876/health')).resolves.toEqual({
      error: 'connect ECONNREFUSED 127.0.0.1:9876',
    });
  });

  it('posts JSON payloads and truncates invalid JSON previews', async () => {
    const requestBodies = [];
    const invalidPayload = 'x'.repeat(800);
    const requestSpy = vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      { statusCode: 500, body: invalidPayload },
    ], requestBodies));

    const result = await peekShared.peekHttpPost(
      'http://omen:9876/elements',
      { mode: 'window', title: 'Dashboard' },
      4100,
    );

    expect(requestSpy).toHaveBeenCalledWith(
      new URL('http://omen:9876/elements'),
      expect.objectContaining({
        method: 'POST',
        timeout: 4100,
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Content-Length': expect.any(Number),
        }),
      }),
      expect.any(Function),
    );
    expect(requestBodies).toHaveLength(1);
    expect(JSON.parse(requestBodies[0].body)).toEqual({ mode: 'window', title: 'Dashboard' });
    expect(result).toEqual({
      error: expect.stringContaining('Invalid JSON:'),
      raw: invalidPayload.slice(0, 500),
      status: 500,
    });
  });

  it('posts compare payloads to the normalized compare endpoint with ignore regions', async () => {
    const requestBodies = [];
    const requestSpy = vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      {
        statusCode: 200,
        body: {
          passed: true,
          changed_pixels: 0,
        },
      },
    ], requestBodies));

    const ignoreRegions = [{ x: 1, y: 2, width: 3, height: 4 }];
    const result = await peekShared.postCompare(
      'http://omen:9876/',
      'baseline-b64',
      'current-b64',
      0.02,
      5000,
      ignoreRegions,
    );

    const compareUrl = String(requestBodies[0].url.href || requestBodies[0].url);
    expect(compareUrl).toBe('http://omen:9876/compare');
    expect(JSON.parse(requestBodies[0].body)).toEqual({
      baseline: 'baseline-b64',
      current: 'current-b64',
      threshold: 0.02,
      ignore_regions: ignoreRegions,
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      data: {
        passed: true,
        changed_pixels: 0,
      },
      status: 200,
    });
  });

  it('retries retryable GET, POST, and compare requests until a later attempt succeeds', async () => {
    expect(peekShared.isRetryableError({ error: 'connect ECONNREFUSED host' })).toBe(true);
    expect(peekShared.isRetryableError({ error: 'Validation failed' })).toBe(false);

    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      fn();
      return 0;
    });

    const getSpy = vi.spyOn(http, 'get').mockImplementation(createHttpGetMock([
      { error: 'connect ECONNREFUSED host' },
      { statusCode: 200, body: { ok: true } },
    ]));

    await expect(peekShared.peekHttpGetWithRetry('http://omen:9876/list', 1000, 2)).resolves.toEqual({
      data: { ok: true },
      status: 200,
    });
    expect(getSpy).toHaveBeenCalledTimes(2);

    const postBodies = [];
    const requestSpy = vi.spyOn(http, 'request');
    requestSpy.mockImplementation(createHttpRequestMock([
      { error: 'Request timed out' },
      { statusCode: 200, body: { ok: true } },
    ], postBodies));

    await expect(peekShared.peekHttpPostWithRetry(
      'http://omen:9876/elements',
      { action: 'inspect' },
      1000,
      2,
    )).resolves.toEqual({
      data: { ok: true },
      status: 200,
    });
    expect(requestSpy).toHaveBeenCalledTimes(2);

    requestSpy.mockReset();
    requestSpy.mockImplementation(createHttpRequestMock([
      { error: 'ETIMEDOUT while comparing' },
      { statusCode: 200, body: { passed: true } },
    ], []));

    await expect(peekShared.postCompareWithRetry(
      'http://omen:9876',
      'old-b64',
      'new-b64',
      0.01,
      1000,
      2,
      [{ x: 10, y: 20, width: 30, height: 40 }],
    )).resolves.toEqual({
      data: { passed: true },
      status: 200,
    });
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledTimes(3);
  });
});
