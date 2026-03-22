const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const http = require('http');

let testDir;
let origDataDir;
let db;
let ollamaMod;
let hashlineMod;
let templateBuffer;
let hostMgmt;
let webhooksStreaming;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
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
  testDir = path.join(os.tmpdir(), `torque-vtest-provider-fixes-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) {
    templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  }
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  hostMgmt = require('../db/host-management');
  hostMgmt.setDb(db.getDb());
  webhooksStreaming = require('../db/webhooks-streaming');
  webhooksStreaming.setDb(db.getDb());
  ollamaMod = require('../providers/execute-ollama');
  hashlineMod = require('../providers/execute-hashline');
}

function teardown() {
  try {
    if (db) db.close();
  } catch {
    // ignore
  }
  if (origDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = origDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function addHost({
  id = randomUUID(),
  name = 'test-host',
  url = 'http://127.0.0.1:11434',
  model = 'qwen2.5-coder:7b'
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
    db.createTask({
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

  it('validates pre-routed hashline host has requested model before execution', async () => {
    const wrongHost = addHost({
      id: randomUUID(),
      url: mockUrlA,
      name: 'wrong-hashline-host',
      model: 'llama3.2:3b',
    });
    addHost({
      id: randomUUID(),
      url: mockUrlB,
      name: 'correct-hashline-host',
      model: 'qwen2.5-coder:7b',
    });

    const srcDir = path.join(testDir, 'hashline-pre-routed');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'fix.js'), 'export const value = 1;\\n', 'utf8');

    const fallback = vi.fn();
    hashlineMod.init(makeDeps({ safeUpdateTaskStatus: vi.fn(), tryHashlineTieredFallback: fallback }));

    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'Fix hashline-pre-routed/fix.js',
      status: 'running',
      provider: 'hashline-ollama',
      model: 'qwen2.5-coder:7b',
      working_directory: testDir,
    });

    await hashlineMod.executeHashlineOllamaTask({
      id: taskId,
      task_description: 'Fix hashline-pre-routed/fix.js',
      model: 'qwen2.5-coder:7b',
      ollama_host_id: wrongHost.id,
      working_directory: testDir,
    });

    expect(mockOllamaA.requestLog).toHaveLength(0);
    expect(mockOllamaB.requestLog.filter(r => r.url === '/api/generate').length).toBeGreaterThan(0);
    expect(fallback).not.toHaveBeenCalledWith(taskId, expect.anything(), expect.stringContaining('not hashline-capable'));
  });

  it('forwards abort signal to Ollama request options in both providers', async () => {
    const taskId = randomUUID();
    const { spy: ollamaSpy, getRequestOptions: getOllamaOptions } = captureHttpRequestWithSignal();
    ollamaMod.init(makeDeps({ safeUpdateTaskStatus: vi.fn() }));

    const badHost = addHost({
      id: randomUUID(),
      url: 'http://localhost:11434',
      name: 'signal-host-ollama',
      model: 'codellama:latest',
    });

    db.createTask({
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
    vi.restoreAllMocks();

    const hashlineTaskId = randomUUID();
    const { spy: hashSpy, getRequestOptions: getHashlineOptions } = captureHttpRequestWithSignal();
    hashlineMod.init(makeDeps());
    db.createTask({
      id: hashlineTaskId,
      task_description: 'Hashline signal test',
      status: 'running',
      provider: 'hashline-ollama',
      model: 'codellama:latest',
      working_directory: testDir,
    });
    const streamId = webhooksStreaming.getOrCreateTaskStream(hashlineTaskId, 'output');

    await hashlineMod.runOllamaGenerate({
      ollamaHost: 'http://localhost:11434',
      ollamaModel: 'codellama:latest',
      prompt: 'Hello',
      systemPrompt: 'System',
      options: { temperature: 0.3 },
      timeoutMs: 10000,
      taskId: hashlineTaskId,
      streamId,
    });

    expect(hashSpy).toHaveBeenCalled();
    expect(getHashlineOptions().signal).toBeInstanceOf(AbortSignal);
  });
});
