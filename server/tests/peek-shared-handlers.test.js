'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { createConfigMock } = require('./test-helpers');

const { installMock } = require('./cjs-mock');

const MODULE_PATH = require.resolve('../handlers/peek/shared');

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

function loadPeekShared() {
  delete require.cache[MODULE_PATH];
  installMock('../database', mockDb);
  installMock('../handlers/shared', mockHandlerShared);
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

function createHttpGetMock(responses, requests = []) {
  return (url, options, callback) => {
    const next = responses.shift() || {};
    const req = new EventEmitter();
    req.destroy = vi.fn();
    requests.push({ url, options, req });

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

function createHttpRequestMock(responses, requests = []) {
  return (url, options, callback) => {
    const next = responses.shift() || {};
    const req = new EventEmitter();
    req.destroy = vi.fn();

    const requestRecord = { url, options, body: '', req };
    requests.push(requestRecord);

    req.write = vi.fn((chunk) => {
      requestRecord.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    });
    req.end = vi.fn((chunk) => {
      if (chunk !== undefined) {
        req.write(chunk);
      }

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

describe('peek/shared exported helpers', () => {
  let peekShared;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetMockDefaults();
    peekShared = loadPeekShared();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('formats byte counts across bytes, KB, and MB thresholds', () => {
    expect(peekShared.formatBytes(0)).toBe('0 B');
    expect(peekShared.formatBytes(1023)).toBe('1023 B');
    expect(peekShared.formatBytes(1024)).toBe('1.0 KB');
    expect(peekShared.formatBytes(peekShared.LARGE_ARTIFACT_THRESHOLD)).toBe('1.0 MB');
  });

  it('returns an empty task context when no task or workflow ids are supplied', () => {
    expect(peekShared.resolvePeekTaskContext({})).toEqual({
      task: null,
      taskId: null,
      workflowId: null,
      taskLabel: null,
    });
    expect(mockDb.getTask).not.toHaveBeenCalled();
    expect(mockDb.getWorkflow).not.toHaveBeenCalled();
  });

  it('resolves task context from aliases and prefers explicit workflow ids', () => {
    const task = {
      id: 'task-7',
      workflow_id: 'wf-from-task',
      workflow_node_id: 'peek-window',
    };
    mockDb.getTask.mockReturnValue(task);
    mockDb.getWorkflow.mockReturnValue({ id: 'wf-explicit' });

    const result = peekShared.resolvePeekTaskContext({
      task_id: '  task-7  ',
      __workflowId: ' wf-explicit ',
    });

    expect(mockDb.getTask).toHaveBeenCalledWith('task-7');
    expect(mockDb.getWorkflow).toHaveBeenCalledWith('wf-explicit');
    expect(result).toEqual({
      task,
      taskId: 'task-7',
      workflowId: 'wf-explicit',
      taskLabel: 'peek-window',
    });
  });

  it('throws when a referenced task or explicit workflow cannot be found', () => {
    expect(() => peekShared.resolvePeekTaskContext({ __taskId: 'missing-task' }))
      .toThrow('Task not found: missing-task');

    mockDb.getTask.mockReturnValue({
      id: 'task-8',
      workflow_id: 'wf-8',
      workflow_node_id: 'capture',
    });

    expect(() => peekShared.resolvePeekTaskContext({
      __taskId: 'task-8',
      __workflowId: 'missing-workflow',
    })).toThrow('Workflow not found: missing-workflow');
  });

  it('uses the configured artifact storage path and falls back to the home directory', () => {
    mockDb.getArtifactConfig.mockReturnValue({ storage_path: 'C:\\artifacts' });
    expect(peekShared.getTorqueArtifactStorageRoot()).toBe('C:\\artifacts');

    mockDb.getArtifactConfig.mockReturnValue(null);
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\tester');

    expect(peekShared.getTorqueArtifactStorageRoot()).toBe(
      path.join('C:\\Users\\tester', '.local', 'share', 'torque', 'artifacts'),
    );
  });

  it('returns null from buildPeekPersistOutputDir when no task or workflow context exists', () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

    const result = peekShared.buildPeekPersistOutputDir(
      { taskId: null, workflowId: null, taskLabel: null },
      { process: 'Taskmgr' },
    );

    expect(result).toBeNull();
    expect(mkdirSpy).not.toHaveBeenCalled();
  });

  it('builds task-scoped persisted output directories using sanitized titles', () => {
    mockDb.getArtifactConfig.mockReturnValue({ storage_path: 'C:\\artifacts' });
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('4fzzzx99');
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

    const outputDir = peekShared.buildPeekPersistOutputDir(
      { taskId: 'task-9', workflowId: 'wf-9', taskLabel: 'Peek Window' },
      { title: 'Main Window ##' },
    );

    const runId = `1700000000000-${'4fzzzx99'.slice(0, 8)}`;
    const expected = path.join('C:\\artifacts', 'task-9', 'peek-diagnose', runId, 'main-window');

    expect(outputDir).toBe(expected);
    expect(mkdirSpy).toHaveBeenCalledWith(expected, { recursive: true });
  });

  it('builds workflow-scoped persisted output directories using the task label fallback', () => {
    mockDb.getArtifactConfig.mockReturnValue({ storage_path: 'C:\\artifacts' });
    vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('zk000012');
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

    const outputDir = peekShared.buildPeekPersistOutputDir(
      { taskId: null, workflowId: 'wf-12', taskLabel: 'Diagnose UI' },
      {},
    );

    const runId = `1700000000001-${'zk000012'.slice(0, 8)}`;
    const expected = path.join(
      'C:\\artifacts',
      '_workflows',
      'wf-12',
      'peek-diagnose',
      runId,
      'diagnose-ui',
    );

    expect(outputDir).toBe(expected);
    expect(mkdirSpy).toHaveBeenCalledWith(expected, { recursive: true });
  });

  it('infers MIME types for supported image and json extensions', () => {
    expect(peekShared.inferPeekArtifactMimeType('capture.json')).toBe('application/json');
    expect(peekShared.inferPeekArtifactMimeType('image.PNG')).toBe('image/png');
    expect(peekShared.inferPeekArtifactMimeType('photo.jpg')).toBe('image/jpeg');
    expect(peekShared.inferPeekArtifactMimeType('archive.bin')).toBe('application/octet-stream');
  });

  it('sanitizes target keys and falls back when the value is empty', () => {
    expect(peekShared.sanitizePeekTargetKey('  Main / Window ##  ', 'fallback')).toBe('main-window');
    expect(peekShared.sanitizePeekTargetKey('***', 'fallback')).toBe('fallback');
  });

  it('returns invalid-param errors for missing or disabled explicit peek hosts', () => {
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
  });

  it('resolves explicit hosts, trims trailing slashes, and updates the host cache', () => {
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

  it('prefers enabled localhost hosts for local targets and clears stale host cache entries', () => {
    peekShared.PEEK_HOSTS.set('stale', { name: 'stale' });
    mockDb.listPeekHosts.mockReturnValue([
      { name: 'lab', url: 'http://lab:9876', enabled: 1, ssh: null, platform: 'linux' },
      { name: 'local', url: 'http://127.0.0.1:9876/', enabled: 1, ssh: null, platform: 'windows' },
    ]);

    const result = peekShared.resolvePeekHost({ url: 'http://localhost:3000/app' });

    expect(result).toEqual({
      hostName: 'local',
      hostUrl: 'http://127.0.0.1:9876',
      ssh: null,
      platform: 'windows',
    });
    expect(peekShared.PEEK_HOSTS.has('stale')).toBe(false);
    expect(peekShared.PEEK_HOSTS.get('lab')).toEqual(expect.objectContaining({ name: 'lab' }));
  });

  it('falls back to the default host when listing hosts fails or no local host matches', () => {
    mockDb.listPeekHosts.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    mockDb.getDefaultPeekHost.mockReturnValue({
      name: 'fallback',
      url: 'https://fallback:9876/',
      enabled: 1,
      ssh: null,
      platform: 'linux',
    });

    const result = peekShared.resolvePeekHost({ _prefer_local: true });

    expect(result).toEqual({
      hostName: 'fallback',
      hostUrl: 'https://fallback:9876',
      ssh: null,
      platform: 'linux',
    });
    expect(peekShared.PEEK_HOSTS.get('fallback')).toEqual(expect.objectContaining({ name: 'fallback' }));
  });

  it('returns resource-not-found when no enabled host can be resolved', () => {
    mockDb.listPeekHosts.mockReturnValue([]);
    mockDb.getDefaultPeekHost.mockReturnValue({
      name: 'disabled-default',
      url: 'http://disabled:9876',
      enabled: 0,
    });

    expect(peekShared.resolvePeekHost({})).toEqual({
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'No peek host configured. Connect Peek from a workstation card in the dashboard or use the register_peek_host tool.',
      },
    });
  });

  it('detects local targets only for localhost and loopback URLs', () => {
    expect(peekShared.isLocalTarget({ url: 'http://localhost:3000/app' })).toBe(true);
    expect(peekShared.isLocalTarget({ url: 'https://127.0.0.1/view' })).toBe(true);
    expect(peekShared.isLocalTarget({ url: 'https://example.com/view' })).toBe(false);
    expect(peekShared.isLocalTarget({})).toBe(false);
  });

  it('builds target keys for process, title, and screen fallbacks', () => {
    expect(peekShared.getPeekTargetKey(
      { process: 'Taskmgr' },
      { process: 'Taskmgr.exe' },
    )).toBe('process-taskmgr-exe');
    expect(peekShared.getPeekTargetKey(
      { title: 'Editor' },
      {},
    )).toBe('title-editor');
    expect(peekShared.getPeekTargetKey({}, {})).toBe('screen');
  });

  it('escapes XML special characters', () => {
    expect(peekShared.escapeXml('<node attr="1">&value</node>'))
      .toBe('&lt;node attr=&quot;1&quot;&gt;&amp;value&lt;/node&gt;');
  });

  it('returns the correct transport module for http and https URLs', () => {
    expect(peekShared.getHttpModule('http://example.com')).toBe(http);
    expect(peekShared.getHttpModule('https://example.com')).toBe(https);
  });

  it('parses successful GET responses as JSON and uses the https transport when needed', async () => {
    const requests = [];
    const getSpy = vi.spyOn(https, 'get').mockImplementation(createHttpGetMock([
      { statusCode: 200, body: { ok: true, version: 2 } },
    ], requests));

    const result = await peekShared.peekHttpGetUrl('https://omen:9876/health', 3210);

    expect(getSpy).toHaveBeenCalledWith(
      'https://omen:9876/health',
      { timeout: 3210 },
      expect.any(Function),
    );
    expect(requests[0].url).toBe('https://omen:9876/health');
    expect(result).toEqual({
      data: { ok: true, version: 2 },
      status: 200,
    });
  });

  it('returns invalid-json responses for peekHttpGetUrl without throwing', async () => {
    vi.spyOn(http, 'get').mockImplementation(createHttpGetMock([
      { statusCode: 502, body: '{invalid-json' },
    ]));

    await expect(peekShared.peekHttpGetUrl('http://omen:9876/health')).resolves.toEqual({
      error: expect.stringContaining('Invalid JSON:'),
      status: 502,
    });
  });

  it('returns transport errors for peekHttpGetUrl', async () => {
    vi.spyOn(http, 'get').mockImplementation(createHttpGetMock([
      { error: 'connect ECONNREFUSED 127.0.0.1:9876' },
    ]));

    await expect(peekShared.peekHttpGetUrl('http://omen:9876/health')).resolves.toEqual({
      error: 'connect ECONNREFUSED 127.0.0.1:9876',
    });
  });

  it('destroys timed-out GET requests and returns a timeout error', async () => {
    const requests = [];
    vi.spyOn(http, 'get').mockImplementation(createHttpGetMock([
      { timeout: true },
    ], requests));

    await expect(peekShared.peekHttpGetUrl('http://omen:9876/health')).resolves.toEqual({
      error: 'Request timed out',
    });
    expect(requests[0].req.destroy).toHaveBeenCalledTimes(1);
  });

  it('posts JSON payloads and parses successful responses for peekHttpPost', async () => {
    const requests = [];
    const requestSpy = vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      { statusCode: 201, body: { success: true, count: 2 } },
    ], requests));

    const result = await peekShared.peekHttpPost(
      'http://omen:9876/elements',
      { action: 'inspect', depth: 2 },
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
    expect(JSON.parse(requests[0].body)).toEqual({ action: 'inspect', depth: 2 });
    expect(result).toEqual({
      data: { success: true, count: 2 },
      status: 201,
    });
  });

  it('truncates invalid-json previews for peekHttpPost responses', async () => {
    const invalidPayload = 'x'.repeat(800);
    vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      { statusCode: 500, body: invalidPayload },
    ]));

    await expect(peekShared.peekHttpPost(
      'http://omen:9876/elements',
      { action: 'inspect' },
      1000,
    )).resolves.toEqual({
      error: expect.stringContaining('Invalid JSON:'),
      raw: invalidPayload.slice(0, 500),
      status: 500,
    });
  });

  it('returns transport errors for peekHttpPost', async () => {
    vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      { error: 'socket hang up' },
    ]));

    await expect(peekShared.peekHttpPost(
      'http://omen:9876/elements',
      { action: 'inspect' },
      1000,
    )).resolves.toEqual({
      error: 'socket hang up',
    });
  });

  it('destroys timed-out POST requests and returns a timeout error', async () => {
    const requests = [];
    vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      { timeout: true },
    ], requests));

    await expect(peekShared.peekHttpPost(
      'http://omen:9876/elements',
      { action: 'inspect' },
      1000,
    )).resolves.toEqual({
      error: 'Request timed out',
    });
    expect(requests[0].req.destroy).toHaveBeenCalledTimes(1);
  });

  it('posts compare payloads to the normalized compare endpoint and includes ignore regions', async () => {
    const requests = [];
    vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      { statusCode: 200, body: { passed: true, changed_pixels: 0 } },
    ], requests));

    const ignoreRegions = [{ x: 1, y: 2, width: 3, height: 4 }];
    const result = await peekShared.postCompare(
      'http://omen:9876/',
      'baseline-b64',
      'current-b64',
      0.02,
      5000,
      ignoreRegions,
    );

    const compareUrl = String(requests[0].url.href || requests[0].url);
    expect(compareUrl).toBe('http://omen:9876/compare');
    expect(JSON.parse(requests[0].body)).toEqual({
      baseline: 'baseline-b64',
      current: 'current-b64',
      threshold: 0.02,
      ignore_regions: ignoreRegions,
    });
    expect(result).toEqual({
      data: { passed: true, changed_pixels: 0 },
      status: 200,
    });
  });

  it('omits ignore regions when none are provided to postCompare', async () => {
    const requests = [];
    vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      { statusCode: 200, body: { passed: false } },
    ], requests));

    await peekShared.postCompare(
      'http://omen:9876',
      'baseline-b64',
      'current-b64',
      0.05,
      5000,
      [],
    );

    expect(JSON.parse(requests[0].body)).toEqual({
      baseline: 'baseline-b64',
      current: 'current-b64',
      threshold: 0.05,
    });
  });

  it('returns invalid-json previews for postCompare responses', async () => {
    const invalidPayload = 'y'.repeat(750);
    vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      { statusCode: 500, body: invalidPayload },
    ]));

    await expect(peekShared.postCompare(
      'http://omen:9876',
      'baseline-b64',
      'current-b64',
      0.01,
      1000,
    )).resolves.toEqual({
      error: expect.stringContaining('Invalid JSON:'),
      raw: invalidPayload.slice(0, 500),
      status: 500,
    });
  });

  it('destroys timed-out compare requests and returns a timeout error', async () => {
    const requests = [];
    vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      { timeout: true },
    ], requests));

    await expect(peekShared.postCompare(
      'http://omen:9876',
      'baseline-b64',
      'current-b64',
      0.01,
      1000,
    )).resolves.toEqual({
      error: 'Request timed out',
    });
    expect(requests[0].req.destroy).toHaveBeenCalledTimes(1);
  });

  it('recognizes only configured retryable error signatures', () => {
    expect(peekShared.isRetryableError({ error: 'connect ECONNREFUSED host' })).toBe(true);
    expect(peekShared.isRetryableError({ error: 'socket ECONNRESET during call' })).toBe(true);
    expect(peekShared.isRetryableError({ error: 'Validation failed' })).toBe(false);
    expect(peekShared.isRetryableError(null)).toBe(false);
  });

  it('retries peekHttpGetWithRetry until a later attempt succeeds', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      fn();
      return 0;
    });
    const getSpy = vi.spyOn(http, 'get').mockImplementation(createHttpGetMock([
      { error: 'connect ECONNREFUSED host' },
      { statusCode: 200, body: { ok: true } },
    ]));

    await expect(peekShared.peekHttpGetWithRetry(
      'http://omen:9876/list',
      1000,
      2,
    )).resolves.toEqual({
      data: { ok: true },
      status: 200,
    });
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry peekHttpPostWithRetry after a non-retryable error', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      fn();
      return 0;
    });
    const requestSpy = vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      { error: 'Validation failed' },
    ]));

    await expect(peekShared.peekHttpPostWithRetry(
      'http://omen:9876/elements',
      { action: 'inspect' },
      1000,
      3,
    )).resolves.toEqual({
      error: 'Validation failed',
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it('returns the final retryable error when postCompareWithRetry exhausts attempts', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      fn();
      return 0;
    });
    const requestSpy = vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock([
      { error: 'ETIMEDOUT while comparing' },
      { error: 'ETIMEDOUT while comparing' },
    ]));

    await expect(peekShared.postCompareWithRetry(
      'http://omen:9876',
      'old-b64',
      'new-b64',
      0.01,
      1000,
      2,
      [{ x: 10, y: 20, width: 30, height: 40 }],
    )).resolves.toEqual({
      error: 'ETIMEDOUT while comparing',
    });
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
  });
});
