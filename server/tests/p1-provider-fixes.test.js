vi.mock('../integrations/codebase-study-engine', () => ({
  applyStudyContextPrompt: (prompt) => prompt,
}));

const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const http = require('http');
const taskCore = require('../db/task-core');
const { setupTestDbOnly, teardownTestDb, rawDb: _rawDb } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

let testDir;
let db;
let ollamaMod;
let hostMgmt;
let mockOllamaA;
let mockOllamaB;
let mockUrlA;
let mockUrlB;

function makeDeps(overrides = {}) {
  return {
    db,
    dashboard: {
      broadcast: vi.fn(),
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    },
    safeUpdateTaskStatus: overrides.safeUpdateTaskStatus || vi.fn(),
    tryReserveHostSlotWithFallback: overrides.tryReserveHostSlotWithFallback || vi.fn(() => ({ success: true })),
    tryOllamaCloudFallback: overrides.tryOllamaCloudFallback || vi.fn(() => false),
    isHashlineCapableModel: overrides.isHashlineCapableModel || vi.fn(() => true),
    isLargeModelBlockedOnHost: overrides.isLargeModelBlockedOnHost || vi.fn(() => ({ blocked: false })),
    selectHashlineFormat: overrides.selectHashlineFormat || vi.fn(() => ({ format: 'hashline', reason: 'test' })),
    tryHashlineTieredFallback: overrides.tryHashlineTieredFallback || vi.fn(() => false),
    processQueue: overrides.processQueue || vi.fn(),
    hashlineOllamaSystemPrompt: overrides.hashlineOllamaSystemPrompt || 'You are a test hashline prompt.',
    hashlineLiteSystemPrompt: overrides.hashlineLiteSystemPrompt || 'You are a test hashline-lite prompt.',
    executeOllamaTask: overrides.executeOllamaTask || vi.fn(),
  };
}

function setup() {
  ({ db, testDir } = setupTestDbOnly('provider-fixes-'));
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  hostMgmt = require('../db/host-management');
  hostMgmt.setDb(db.getDb());
  ollamaMod = require('../providers/execute-ollama');
}

function teardown() {
  teardownTestDb();
}

function addHost({
  id = randomUUID(),
  name = 'test-host',
  url = 'http://127.0.0.1:11434',
  model = TEST_MODELS.SMALL
} = {}) {
  hostMgmt.addOllamaHost({ id, name, url, max_concurrent: 4, memory_limit_mb: 8192 });
  hostMgmt.updateOllamaHost(id, {
    enabled: 1,
    status: 'healthy',
    running_tasks: 0,
    models_cache: JSON.stringify([{ name: model, size: 4 * 1024 * 1024 * 1024 }]),
  });
  return { id, url };
}

function clearHosts() {
  for (const host of hostMgmt.listOllamaHosts()) {
    hostMgmt.removeOllamaHost(host.id);
  }
}

function captureHttpRequestWithSignal() {
  let capturedRequestOptions = null;
  const spy = vi.spyOn(http, 'request').mockImplementation((options, callback) => {
    capturedRequestOptions = options;
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.statusCode = 200;

    req.write = vi.fn();
    req.end = vi.fn(() => {
      if (callback) callback(res);
      process.nextTick(() => {
        res.emit('data', JSON.stringify({ response: 'ok', done: true }) + '\n');
        res.emit('end');
      });
    });
    req.destroy = vi.fn();

    return req;
  });
  return { spy, getRequestOptions: () => capturedRequestOptions };
}

describe('provider fixes', () => {
  beforeAll(async () => {
    setup();
    const { createMockOllama } = require('./mocks/ollama');
    mockOllamaA = createMockOllama();
    mockOllamaB = createMockOllama();
    const serverA = await mockOllamaA.start();
    const serverB = await mockOllamaB.start();
    mockUrlA = serverA.url;
    mockUrlB = serverB.url;
  });

  afterAll(async () => {
    if (mockOllamaA) await mockOllamaA.stop();
    if (mockOllamaB) await mockOllamaB.stop();
    teardown();
  });

  beforeEach(() => {
    globalThis.taskMetadataParsed = {};
    clearHosts();
    mockOllamaA.clearLog();
    mockOllamaB.clearLog();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses exact model matching for pre-routed ollama hosts (no prefix overmatch)', async () => {
    const wrongHost = addHost({
      id: randomUUID(),
      url: mockUrlA,
      name: 'wrong-ollama-host',
      model: 'llama3.2:3b',
    });
    addHost({
      id: randomUUID(),
      url: mockUrlB,
      name: 'correct-ollama-host',
      model: 'llama3:latest',
    });

    const safeUpdate = vi.fn();
    ollamaMod.init(makeDeps({ safeUpdateTaskStatus: safeUpdate }));

    const taskId = randomUUID();
    taskCore.createTask({
      id: taskId,
      task_description: 'Exact match test',
      status: 'running',
      provider: 'ollama',
      model: 'llama3:latest',
      working_directory: testDir,
    });

    await ollamaMod.executeOllamaTask({
      id: taskId,
      task_description: 'Exact match test',
      model: 'llama3:latest',
      working_directory: testDir,
      ollama_host_id: wrongHost.id,
    });

    expect(mockOllamaA.requestLog).toHaveLength(0);
    expect(mockOllamaB.requestLog.filter(r => r.url === '/api/generate').length).toBeGreaterThan(0);
    expect(safeUpdate).toHaveBeenCalledWith(taskId, 'completed', expect.anything());
  });

  it('forwards abort signal to Ollama request options', async () => {
    const taskId = randomUUID();
    const { spy: ollamaSpy, getRequestOptions: getOllamaOptions } = captureHttpRequestWithSignal();
    ollamaMod.init(makeDeps({ safeUpdateTaskStatus: vi.fn() }));

    const badHost = addHost({
      id: randomUUID(),
      url: 'http://localhost:11434',
      name: 'signal-host-ollama',
      model: 'codellama:latest',
    });

    taskCore.createTask({
      id: taskId,
      task_description: 'Signal forward test',
      status: 'running',
      provider: 'ollama',
      model: 'codellama:latest',
      working_directory: testDir,
    });

    await ollamaMod.executeOllamaTask({
      id: taskId,
      task_description: 'Signal forward test',
      model: 'codellama:latest',
      working_directory: testDir,
      ollama_host_id: badHost.id,
    });

    expect(ollamaSpy).toHaveBeenCalled();
    expect(getOllamaOptions().signal).toBeInstanceOf(AbortSignal);
    ollamaSpy.mockRestore();
  });
});
