/**
 * Regression tests for streaming + retry + queue wakeup fixes.
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { randomUUID } = require('crypto');
const { MAX_STREAMING_OUTPUT } = require('../constants');

let testDir;
let origDataDir;
let db;
let templateBuffer;
let executeHashline;
let executeOllama;
let executeApi;
let executeCli;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-p1-streaming-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);

  executeHashline = require('../providers/execute-hashline');
  executeOllama = require('../providers/execute-ollama');
  executeApi = require('../providers/execute-api');
  executeCli = require('../providers/execute-cli');
}

function teardown() {
  try { if (db) db.close(); } catch { /* ok */ }
  if (origDataDir !== undefined) process.env.TORQUE_DATA_DIR = origDataDir;
  else delete process.env.TORQUE_DATA_DIR;
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
}

function resetDb() {
  db.resetForTest(templateBuffer);
}

function makeHashlineDeps(overrides = {}) {
  return {
    db,
    dashboard: {
      broadcast: vi.fn(),
      broadcastTaskUpdate: vi.fn(),
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    },
    safeUpdateTaskStatus: vi.fn(),
    tryReserveHostSlotWithFallback: vi.fn(() => ({ success: true })),
    tryHashlineTieredFallback: vi.fn(),
    selectHashlineFormat: vi.fn(() => ({ format: 'hashline', reason: 'default' })),
    isHashlineCapableModel: vi.fn(() => true),
    isLargeModelBlockedOnHost: vi.fn(() => ({ blocked: false })),
    processQueue: vi.fn(),
    hashlineOllamaSystemPrompt: 'You are hashline.',
    hashlineLiteSystemPrompt: 'You are hashline-lite.',
    executeOllamaTask: vi.fn(),
    ...overrides,
  };
}

function makeOllamaDeps(overrides = {}) {
  return {
    db,
    dashboard: {
      broadcast: vi.fn(),
      broadcastTaskUpdate: vi.fn(),
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    },
    safeUpdateTaskStatus: (taskId, status, fields) => db.updateTaskStatus(taskId, status, fields),
    tryReserveHostSlotWithFallback: vi.fn(() => ({ success: true })),
    tryOllamaCloudFallback: vi.fn(() => false),
    isLargeModelBlockedOnHost: vi.fn(() => ({ blocked: false })),
    buildFileContext: vi.fn(() => ''),
    processQueue: vi.fn(),
    ...overrides,
  };
}

function makeApiDeps(overrides = {}) {
  return {
    db,
    dashboard: {
      broadcast: vi.fn(),
      broadcastTaskUpdate: vi.fn(),
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    },
    apiAbortControllers: overrides.apiAbortControllers || new Map(),
    processQueue: vi.fn(),
    ...overrides,
  };
}

function makeCliDeps(overrides = {}) {
  return {
    db,
    dashboard: {
      broadcast: vi.fn(),
      broadcastTaskUpdate: vi.fn(),
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    },
    runningProcesses: new Map(),
    safeUpdateTaskStatus: vi.fn(),
    tryReserveHostSlotWithFallback: vi.fn(() => ({ success: true })),
    markTaskCleanedUp: vi.fn(() => true),
    tryOllamaCloudFallback: vi.fn(() => false),
    tryLocalFirstFallback: vi.fn(() => false),
    attemptFuzzySearchRepair: vi.fn(() => ({ repaired: false })),
    tryHashlineTieredFallback: vi.fn(() => false),
    shellEscape: (s) => s,
    processQueue: vi.fn(),
    isLargeModelBlockedOnHost: vi.fn(() => ({ blocked: false })),
    helpers: {
      extractTargetFilesFromDescription: () => [],
      ensureTargetFilesExist: (wd, fps) => [...new Set(fps)].map((p) => path.resolve(wd, p)),
      detectTaskTypes: () => [],
      wrapWithInstructions: (desc) => desc,
      isLargeModelBlockedOnHost: vi.fn(() => ({ blocked: false })),
    },
    ...overrides,
  };
}

async function startStreamServer(handlers = { responsePayloads: ['{}'] }) {
  const { statusCode = 200, responsePayloads = ['{}'], responseHeaders = { 'Content-Type': 'application/json' } } = handlers;
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url !== '/api/generate' || req.method !== 'POST') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }

      res.writeHead(statusCode, responseHeaders);
      const payloads = Array.isArray(responsePayloads) ? responsePayloads : [responsePayloads];
      for (const payload of payloads) {
        res.write(payload);
      }
      res.end();
    });
  });

  const url = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });

  return {
    server,
    url,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function addHost({ url, model = 'codellama:latest', maxConcurrent = 4, runningTasks = 0 }) {
  const hostId = randomUUID();
  db.addOllamaHost({
    id: hostId,
    name: `host-${hostId}`,
    url,
    max_concurrent: maxConcurrent,
    memory_limit_mb: 8192,
  });
  db.updateOllamaHost(hostId, {
    enabled: 1,
    status: 'healthy',
    running_tasks: runningTasks,
    models_cache: JSON.stringify([{ name: model, size: 4 * 1024 * 1024 * 1024 }]),
  });
  return hostId;
}

describe('P1 streaming fixes', () => {
  beforeAll(() => {
    setup();
  });
  afterAll(() => {
    teardown();
  });
  beforeEach(() => {
    resetDb();
  });

  describe('Issue 1: trailing NDJSON line is flushed', () => {
    it('accepts a final no-newline NDJSON line in runOllamaGenerate', async () => {
      const payload = '{"response":"Hello from LLM","done":true}';
      const streamServer = await startStreamServer({
        statusCode: 200,
        responsePayloads: [payload],
      });
      executeHashline.init(makeHashlineDeps());

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Trailing line test',
        status: 'running',
        provider: 'hashline-ollama',
        working_directory: testDir,
      });

      const streamId = db.getOrCreateTaskStream(taskId, 'output');
      const result = await executeHashline.runOllamaGenerate({
        ollamaHost: streamServer.url,
        ollamaModel: 'codellama:latest',
        prompt: 'Test',
        systemPrompt: 'Test',
        options: {},
        timeoutMs: 10000,
        taskId,
        streamId,
      });

      expect(result.response).toBe('Hello from LLM');
      await streamServer.close();
    });

    it('accepts a final no-newline NDJSON line from execute-ollama task stream', async () => {
      const payload = '{"response":"Hello from Ollama","done":true}';
      const streamServer = await startStreamServer({
        statusCode: 200,
        responsePayloads: [payload],
      });

      const hostUrl = streamServer.url;
      addHost({ url: hostUrl, model: 'codellama:latest' });
      const deps = makeOllamaDeps();
      executeOllama.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Trailing line test for execute-ollama',
        status: 'running',
        provider: 'ollama',
        model: 'codellama:latest',
        working_directory: testDir,
      });

      await executeOllama.executeOllamaTask({
        id: taskId,
        task_description: 'Trailing line test for execute-ollama',
        model: 'codellama:latest',
        working_directory: testDir,
      });

      const task = db.getTask(taskId);
      expect(task.output).toContain('Hello from Ollama');
      await streamServer.close();
    });
  });

  describe('Issue 2: streaming output caps', () => {
    it('truncates hashline streaming output at MAX_STREAMING_OUTPUT', async () => {
      const huge = 'A'.repeat(MAX_STREAMING_OUTPUT + 2048);
      const payload = `{"response":"${huge}","done":true}`;
      const streamServer = await startStreamServer({
        responsePayloads: [payload],
      });
      executeHashline.init(makeHashlineDeps());

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Output cap test',
        status: 'running',
        provider: 'hashline-ollama',
        working_directory: testDir,
      });

      const streamId = db.getOrCreateTaskStream(taskId, 'output');
      const result = await executeHashline.runOllamaGenerate({
        ollamaHost: streamServer.url,
        ollamaModel: 'codellama:latest',
        prompt: 'Generate huge',
        systemPrompt: 'Test',
        options: {},
        timeoutMs: 10000,
        taskId,
        streamId,
      });

      expect(result.response).toContain('\n[output truncated at 10MB]');
      expect(result.response.length).toBeLessThanOrEqual(
        MAX_STREAMING_OUTPUT + '\n[output truncated at 10MB]'.length
      );
      await streamServer.close();
    });

    it('truncates execute-ollama output at MAX_STREAMING_OUTPUT', async () => {
      const huge = 'A'.repeat(MAX_STREAMING_OUTPUT + 2048);
      const payload = `{"response":"${huge}","done":true}`;
      const streamServer = await startStreamServer({
        responsePayloads: [payload],
      });

      const hostUrl = streamServer.url;
      addHost({ url: hostUrl, model: 'codellama:latest' });
      const deps = makeOllamaDeps();
      executeOllama.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Ollama cap test',
        status: 'running',
        provider: 'ollama',
        model: 'codellama:latest',
        working_directory: testDir,
      });

      await executeOllama.executeOllamaTask({
        id: taskId,
        task_description: 'Ollama cap test',
        model: 'codellama:latest',
        working_directory: testDir,
      });

      const task = db.getTask(taskId);
      expect(task.output).toContain('\n[output truncated at 10MB]');
      expect(task.output.length).toBeLessThanOrEqual(
        MAX_STREAMING_OUTPUT + '\n[output truncated at 10MB]'.length
      );
      await streamServer.close();
    });
  });

  describe('Issue 3: API provider retry for transient HTTP statuses', () => {
    it.each([429, 500])('retries and succeeds after retryable %i response', async (statusCode) => {
      const processQueue = vi.fn();
      executeApi.init(makeApiDeps({ processQueue }));

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Retry test',
        status: 'pending',
        provider: 'test-provider',
        working_directory: testDir,
      });

      const call = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error(`error status ${statusCode}`), { status: statusCode }))
        .mockRejectedValueOnce(Object.assign(new Error(`error status ${statusCode}`), { status: statusCode }))
        .mockResolvedValue({ output: 'retry success', usage: null });

      const provider = {
        name: 'test-provider',
        submit: call,
      };

      await executeApi.executeApiProvider({
        id: taskId,
        task_description: 'Retry test',
        model: 'qwen2.5-coder:7b',
        timeout_minutes: 5,
      }, provider);

      expect(call).toHaveBeenCalledTimes(3);
      const task = db.getTask(taskId);
      expect(task.status).toBe('completed');
      expect(task.output).toBe('retry success');
      expect(processQueue).toHaveBeenCalled();
    });
  });

  describe('Issue 4: Requeue wakes queue and notifies dashboard', () => {
    it('notifies dashboard and wakes queue when requeued for slot reservation failure', async () => {
      const processQueue = vi.fn();
      const dashboard = { broadcast: vi.fn(), broadcastTaskUpdate: vi.fn(), notifyTaskUpdated: vi.fn(), notifyTaskOutput: vi.fn() };
      const hostUrl = 'http://127.0.0.1:11434';
      addHost({ url: hostUrl, model: 'qwen2.5-coder:7b' });

      const deps = makeCliDeps({
        dashboard,
        processQueue,
        tryReserveHostSlotWithFallback: vi.fn(() => ({ success: false, reason: 'all workers busy' })),
      });
      executeCli.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Queue wakeup test',
        status: 'running',
        provider: 'aider-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      const result = executeCli.buildAiderOllamaCommand(
        {
          id: taskId,
          provider: 'aider-ollama',
          task_description: 'Queue wakeup test',
          model: 'qwen2.5-coder:7b',
          retry_count: 0,
          working_directory: testDir,
        },
        '',
        []
      );

      expect(result).toEqual(expect.objectContaining({ requeued: true }));
      expect(dashboard.broadcastTaskUpdate).toHaveBeenCalledWith(taskId);
      expect(dashboard.notifyTaskUpdated).toHaveBeenCalledWith(taskId);
      expect(processQueue).toHaveBeenCalled();
    });

    it('notifies dashboard and wakes queue when requeued due host capacity', async () => {
      const processQueue = vi.fn();
      const dashboard = { broadcast: vi.fn(), broadcastTaskUpdate: vi.fn(), notifyTaskUpdated: vi.fn(), notifyTaskOutput: vi.fn() };
      const atCapacityHost = addHost({ url: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b', maxConcurrent: 1, runningTasks: 1 });
      db.updateOllamaHost(atCapacityHost, {
        enabled: 1,
        status: 'healthy',
        running_tasks: 1,
      });

      const deps = makeCliDeps({ dashboard, processQueue });
      executeCli.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Queue wakeup capacity test',
        status: 'running',
        provider: 'aider-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      const result = executeCli.buildAiderOllamaCommand(
        {
          id: taskId,
          provider: 'aider-ollama',
          task_description: 'Queue wakeup capacity test',
          model: 'qwen2.5-coder:7b',
          retry_count: 0,
          working_directory: testDir,
        },
        '',
        []
      );

      expect(result).toEqual(expect.objectContaining({ requeued: true }));
      expect(dashboard.broadcastTaskUpdate).toHaveBeenCalledWith(taskId);
      expect(dashboard.notifyTaskUpdated).toHaveBeenCalledWith(taskId);
      expect(processQueue).toHaveBeenCalled();
    });
  });
});
