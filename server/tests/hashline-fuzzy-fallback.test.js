'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

const { createMockOllama } = require('./mocks/ollama');
const { applyHashlineEdits, computeLineHash } = require('../utils/hashline-parser');
const executeHashline = require('../providers/execute-hashline');

const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

let parserDir;
let dbDir;
let origDataDir;
let db;
let templateBuffer;
let mockOllama;
let mockUrl;

function loadParserHarness() {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  childLogger.child = vi.fn(() => childLogger);

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => childLogger),
    Logger: class MockLogger {},
  };

  const loggerPath = require.resolve('../logger');
  const parserPath = require.resolve('../utils/hashline-parser');
  const loggerModule = require.cache[loggerPath];
  const originalLogger = loggerModule.exports;

  loggerModule.exports = logger;
  delete require.cache[parserPath];
  const parser = require('../utils/hashline-parser');
  loggerModule.exports = originalLogger;

  return { ...parser, childLogger };
}

function writeParserFile(name, lines) {
  const filePath = path.join(parserDir, name);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

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
    tryHashlineTieredFallback: overrides.tryHashlineTieredFallback || vi.fn(() => false),
    selectHashlineFormat: overrides.selectHashlineFormat || vi.fn(() => ({ format: 'hashline', reason: 'test' })),
    isHashlineCapableModel: overrides.isHashlineCapableModel || vi.fn(() => true),
    isLargeModelBlockedOnHost: overrides.isLargeModelBlockedOnHost || vi.fn(() => ({ blocked: false })),
    processQueue: overrides.processQueue || vi.fn(),
    hashlineOllamaSystemPrompt: overrides.hashlineOllamaSystemPrompt || 'You are a hashline editor.',
    hashlineLiteSystemPrompt: overrides.hashlineLiteSystemPrompt || 'You are a hashline-lite editor.',
    executeOllamaTask: overrides.executeOllamaTask || vi.fn(),
    handleWorkflowTermination: overrides.handleWorkflowTermination || vi.fn(),
  };
}

function addHost({ id = randomUUID(), name = 'test-host', url = mockUrl, model = 'qwen2.5-coder:7b' } = {}) {
  db.addOllamaHost({ id, name, url, max_concurrent: 4, memory_limit_mb: 8192 });
  db.updateOllamaHost(id, {
    enabled: 1,
    status: 'healthy',
    running_tasks: 0,
    models_cache: JSON.stringify([{ name: model, size: 4 * 1024 * 1024 * 1024 }]),
  });
  return { id, url };
}

function clearHosts() {
  for (const host of db.listOllamaHosts()) {
    db.removeOllamaHost(host.id);
  }
}

async function runHashlineTask(taskOverrides = {}) {
  clearHosts();
  addHost();

  const relPath = taskOverrides.relPath || 'src/hashline-defaults.js';
  const fullPath = path.join(dbDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, 'const value = 1;\n', 'utf8');

  const deps = makeDeps({
    safeUpdateTaskStatus: vi.fn(),
    tryHashlineTieredFallback: vi.fn(() => false),
  });
  executeHashline.init(deps);

  const taskId = randomUUID();
  const task = {
    id: taskId,
    task_description: `Fix ${relPath}`,
    status: 'running',
    provider: 'hashline-ollama',
    model: 'qwen2.5-coder:7b',
    working_directory: dbDir,
    ...taskOverrides,
  };

  db.createTask(task);
  await executeHashline.executeHashlineOllamaTask(task);

  const request = mockOllama.requestLog.find(entry => entry.url === '/api/generate');
  expect(request).toBeDefined();
  return { request, deps };
}

describe('hashline fuzzy fallback', () => {
  beforeAll(async () => {
    parserDir = path.join(os.tmpdir(), `torque-hashline-fuzzy-parser-${Date.now()}`);
    fs.mkdirSync(parserDir, { recursive: true });

    dbDir = path.join(os.tmpdir(), `torque-hashline-fuzzy-db-${Date.now()}`);
    fs.mkdirSync(dbDir, { recursive: true });
    origDataDir = process.env.TORQUE_DATA_DIR;
    process.env.TORQUE_DATA_DIR = dbDir;

    db = require('../database');
    if (!templateBuffer) {
      templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
    }
    db.resetForTest(templateBuffer);

    mockOllama = createMockOllama();
    const info = await mockOllama.start();
    mockUrl = info.url;
  });

  afterAll(async () => {
    if (mockOllama) {
      await mockOllama.stop();
    }
    try { if (db) db.close(); } catch { /* ignore */ }
    if (origDataDir === undefined) {
      delete process.env.TORQUE_DATA_DIR;
    } else {
      process.env.TORQUE_DATA_DIR = origDataDir;
    }
    fs.rmSync(parserDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockOllama.clearLog();
    mockOllama.setFailGenerate(false);
    mockOllama.setGenerateDelay(0);
    mockOllama.setStatusCode(200);
    mockOllama.setGenerateResponse('No edits needed.');
    clearHosts();
  });

  it('exact hash match works as before', () => {
    const filePath = writeParserFile('exact.txt', ['alpha', 'beta', 'gamma']);
    const betaHash = computeLineHash('beta');

    const result = applyHashlineEdits(filePath, [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: betaHash,
      endLine: 2,
      endHash: betaHash,
      newContent: 'BETA',
    }]);

    expect(result.success).toBe(true);
    expect(result.fuzzyFixups).toBe(0);
    expect(readFile(filePath)).toBe('alpha\nBETA\ngamma');
  });

  it('uses fuzzy fallback when hash mismatches but the line number is valid', () => {
    const filePath = writeParserFile('line-number-fallback.txt', ['alpha', 'beta', 'gamma']);
    const betaHash = computeLineHash('beta');

    const result = applyHashlineEdits(filePath, [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: 'zz',
      endLine: 2,
      endHash: betaHash,
      newContent: 'BETA',
    }]);

    expect(result.success).toBe(true);
    expect(result.fuzzyFixups).toBe(1);
    expect(readFile(filePath)).toBe('alpha\nBETA\ngamma');
  });

  it('skips fuzzy fallback when the cited line number is out of bounds', () => {
    const filePath = writeParserFile('out-of-bounds.txt', ['alpha', 'beta', 'gamma']);

    const result = applyHashlineEdits(filePath, [{
      type: 'replace',
      filePath,
      startLine: 99,
      startHash: 'zz',
      endLine: 99,
      endHash: 'zz',
      newContent: 'BETA',
    }]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Line 99 out of range');
    expect(readFile(filePath)).toBe('alpha\nbeta\ngamma');
  });

  it('includes num_predict in Ollama options', async () => {
    const { request } = await runHashlineTask();
    expect(request.body.options.num_predict).toBe(4096);
  });

  it('defaults hashline temperature to 0.15', async () => {
    const { request } = await runHashlineTask();
    expect(request.body.options.temperature).toBe(0.15);
  });

  it('logs a warning when line-number fallback is used', () => {
    const { applyHashlineEdits: mockedApplyHashlineEdits, computeLineHash: mockedComputeLineHash, childLogger } = loadParserHarness();
    const filePath = writeParserFile('warn.txt', ['alpha', 'beta', 'gamma']);
    const betaHash = mockedComputeLineHash('beta');

    const result = mockedApplyHashlineEdits(filePath, [{
      type: 'replace',
      filePath,
      startLine: 2,
      startHash: 'zz',
      endLine: 2,
      endHash: betaHash,
      newContent: 'BETA',
    }]);

    expect(result.success).toBe(true);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Fuzzy line-number fallback'));
  });
});
