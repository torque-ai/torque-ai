/**
 * Additional coverage tests for providers/execute-ollama.js
 *
 * Covers three edge-case paths not exercised by execute-ollama.test.js:
 *   1. HTTPS enforcement — TORQUE_OLLAMA_REQUIRE_HTTPS=true blocks http:// non-localhost hosts
 *   2. Host-slot decrement on task failure — db.decrementHostTasks called when HTTP 500 occurs
 *   3. Context limit exceeded — prompt too large for ollama_max_ctx fails the task early
 *
 * Uses the same mock Ollama HTTP server and setupTestDb pattern as execute-ollama.test.js.
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

const hostManagement = require('../db/host-management');

let testDir;
let origDataDir;
let db;
let mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

// ── helpers ──────────────────────────────────────────────────────────

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
    isLargeModelBlockedOnHost: overrides.isLargeModelBlockedOnHost || vi.fn(() => ({ blocked: false })),
    buildFileContext: overrides.buildFileContext || vi.fn(() => ''),
    processQueue: overrides.processQueue || vi.fn(),
  };
}

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-exec-ollama-cov-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  mod = require('../providers/execute-ollama');
}

function teardown() {
  try { if (db) db.close(); } catch { /* ok */ }
  if (origDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = origDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
}

function addHost({
  id = randomUUID(),
  name = 'test-host',
  url = 'http://127.0.0.1:11434',
  model = 'codellama:latest',
} = {}) {
  hostManagement.addOllamaHost({ id, name, url, max_concurrent: 4, memory_limit_mb: 8192 });
  hostManagement.updateOllamaHost(id, {
    enabled: 1,
    status: 'healthy',
    running_tasks: 0,
    models_cache: JSON.stringify([{ name: model, size: 4 * 1024 * 1024 * 1024 }]),
  });
  return { id, url };
}

function clearHosts() {
  for (const host of hostManagement.listOllamaHosts()) {
    hostManagement.removeOllamaHost(host.id);
  }
}

// ── test suite ────────────────────────────────────────────────────────

describe('execute-ollama.js — coverage edge cases', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });

  // ── shared mock Ollama server ─────────────────────────────────────

  let mockOllama;
  let mockUrl;

  beforeAll(async () => {
    const { createMockOllama } = require('./mocks/ollama');
    mockOllama = createMockOllama();
    const info = await mockOllama.start();
    mockUrl = info.url;
  });

  afterAll(async () => {
    await mockOllama.stop();
  });

  beforeEach(() => {
    mockOllama.clearLog();
    mockOllama.setFailGenerate(false);
    mockOllama.setGenerateDelay(0);
    mockOllama.setGenerateResponse('Mock response output.');
    mockOllama.setStatusCode(200);
    clearHosts();
    // Reset config values that individual tests may mutate
    db.setConfig('adaptive_context_enabled', '0');
    db.setConfig('ollama_auto_tuning_enabled', '0');
  });

  // ── 1. HTTPS enforcement ────────────────────────────────────────

  describe('HTTPS enforcement', () => {
    it('rejects non-HTTPS host when TORQUE_OLLAMA_REQUIRE_HTTPS is set', async () => {
      // Register a non-localhost http:// host. The mock server is on 127.0.0.1
      // (which counts as localhost), so we use a fake external IP that will
      // never actually be contacted — the HTTPS check fires before any HTTP
      // request is made.
      const origVal = process.env.TORQUE_OLLAMA_REQUIRE_HTTPS;
      process.env.TORQUE_OLLAMA_REQUIRE_HTTPS = 'true';

      try {
        const fakeExternalUrl = 'http://192.0.2.200:11434';
        addHost({ url: fakeExternalUrl, model: 'codellama:latest' });

        const safeUpdate = vi.fn();
        const deps = makeDeps({ safeUpdateTaskStatus: safeUpdate });
        mod.init(deps);

        const taskId = randomUUID();
        db.createTask({
          id: taskId,
          task_description: 'HTTPS enforcement test',
          status: 'running',
          provider: 'ollama',
          model: 'codellama:latest',
          working_directory: testDir,
        });

        const result = await mod.executeOllamaTask({
          id: taskId,
          task_description: 'HTTPS enforcement test',
          model: 'codellama:latest',
          working_directory: testDir,
        });

        // The function returns early with a structured error object —
        // it does NOT call safeUpdateTaskStatus in this path.
        expect(result).toBeDefined();
        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(result.output).toMatch(/BLOCKED/);
        expect(result.output).toMatch(/HTTP/i);

        // No generate request should have reached the mock server
        const genReqs = mockOllama.requestLog.filter(r => r.url === '/api/generate');
        expect(genReqs).toHaveLength(0);
      } finally {
        if (origVal !== undefined) {
          process.env.TORQUE_OLLAMA_REQUIRE_HTTPS = origVal;
        } else {
          delete process.env.TORQUE_OLLAMA_REQUIRE_HTTPS;
        }
      }
    });

    it('allows http:// when TORQUE_OLLAMA_REQUIRE_HTTPS is not set', async () => {
      // Ensure the env var is absent so http:// localhost is permitted
      const origVal = process.env.TORQUE_OLLAMA_REQUIRE_HTTPS;
      delete process.env.TORQUE_OLLAMA_REQUIRE_HTTPS;

      try {
        addHost({ url: mockUrl, model: 'codellama:latest' });

        const safeUpdate = vi.fn();
        const deps = makeDeps({ safeUpdateTaskStatus: safeUpdate });
        mod.init(deps);

        const taskId = randomUUID();
        db.createTask({
          id: taskId,
          task_description: 'HTTPS not required test',
          status: 'running',
          provider: 'ollama',
          model: 'codellama:latest',
          working_directory: testDir,
        });

        await mod.executeOllamaTask({
          id: taskId,
          task_description: 'HTTPS not required test',
          model: 'codellama:latest',
          working_directory: testDir,
        });

        expect(safeUpdate).toHaveBeenCalledWith(taskId, 'completed', expect.anything());
      } finally {
        if (origVal !== undefined) {
          process.env.TORQUE_OLLAMA_REQUIRE_HTTPS = origVal;
        } else {
          delete process.env.TORQUE_OLLAMA_REQUIRE_HTTPS;
        }
      }
    });
  });

  // ── 2. Host-slot decrement on task failure ─────────────────────

  describe('host-slot decrement on failure', () => {
    it('calls decrementHostTasks when HTTP 500 causes task failure', async () => {
      addHost({ url: mockUrl, model: 'codellama:latest' });
      mockOllama.setFailGenerate(true);

      const safeUpdate = vi.fn();
      const deps = makeDeps({ safeUpdateTaskStatus: safeUpdate });
      mod.init(deps);

      // Spy on db.decrementHostTasks to confirm it is called
      const decrementSpy = vi.spyOn(hostManagement, 'decrementHostTasks');

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Slot decrement failure test',
        status: 'running',
        provider: 'ollama',
        model: 'codellama:latest',
        working_directory: testDir,
      });

      await mod.executeOllamaTask({
        id: taskId,
        task_description: 'Slot decrement failure test',
        model: 'codellama:latest',
        working_directory: testDir,
      });

      // Task should be marked as failed
      expect(safeUpdate).toHaveBeenCalledWith(
        taskId,
        'failed',
        expect.objectContaining({ exit_code: 1 })
      );

      // Host slot must be released on failure
      expect(decrementSpy).toHaveBeenCalled();

      decrementSpy.mockRestore();
    });

    it('calls decrementHostTasks when HTTP 500 occurs with pre-routed host', async () => {
      const host = addHost({ url: mockUrl, model: 'codellama:latest' });
      mockOllama.setFailGenerate(true);

      const safeUpdate = vi.fn();
      const deps = makeDeps({ safeUpdateTaskStatus: safeUpdate });
      mod.init(deps);

      const decrementSpy = vi.spyOn(hostManagement, 'decrementHostTasks');

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Pre-routed slot decrement test',
        status: 'running',
        provider: 'ollama',
        model: 'codellama:latest',
        working_directory: testDir,
      });

      await mod.executeOllamaTask({
        id: taskId,
        task_description: 'Pre-routed slot decrement test',
        model: 'codellama:latest',
        ollama_host_id: host.id,
        working_directory: testDir,
      });

      expect(safeUpdate).toHaveBeenCalledWith(
        taskId,
        'failed',
        expect.objectContaining({ exit_code: 1 })
      );
      expect(decrementSpy).toHaveBeenCalled();

      decrementSpy.mockRestore();
    });
  });

  // ── 3. Context limit exceeded ──────────────────────────────────

  describe('context limit exceeded', () => {
    it('fails task early when prompt exceeds ollama_max_ctx', async () => {
      addHost({ url: mockUrl, model: 'codellama:latest' });

      // Set an extremely small max context so even a modest prompt overflows.
      // The check in execute-ollama.js is:
      //   requiredCtx = ceil(estimatedPromptTokens * 1.3)
      //   if requiredCtx > numCtx AND requiredCtx > maxCtxForModel → fail
      // Set both numCtx and max_ctx very low (32 tokens ≈ ~128 chars).
      db.setConfig('ollama_num_ctx', '32');
      db.setConfig('ollama_max_ctx', '32');
      db.setConfig('adaptive_context_enabled', '0');
      db.setConfig('ollama_model_settings', '');
      db.setConfig('ollama_auto_tuning_enabled', '0');

      const safeUpdate = vi.fn();
      const deps = makeDeps({ safeUpdateTaskStatus: safeUpdate });
      mod.init(deps);

      // A description long enough to require more than 32 tokens (≈128 chars input).
      // With 30% headroom: requiredCtx = ceil(len/4 * 1.3). We need that > 32.
      // len/4 * 1.3 > 32 → len > 98.5 → use 200+ chars to be safe.
      const longDescription = 'A'.repeat(500);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: longDescription,
        status: 'running',
        provider: 'ollama',
        model: 'codellama:latest',
        working_directory: testDir,
      });

      await mod.executeOllamaTask({
        id: taskId,
        task_description: longDescription,
        model: 'codellama:latest',
        working_directory: testDir,
      });

      // Task must be failed with a context-limit message
      expect(safeUpdate).toHaveBeenCalledWith(
        taskId,
        'failed',
        expect.objectContaining({
          exit_code: 1,
          error_output: expect.stringMatching(/Context limit exceeded/i),
        })
      );

      // No generate request should have reached the mock server
      const genReqs = mockOllama.requestLog.filter(r => r.url === '/api/generate');
      expect(genReqs).toHaveLength(0);

      // Restore config
      db.setConfig('ollama_num_ctx', '8192');
      db.setConfig('ollama_max_ctx', '32768');
    });

    it('calls decrementHostTasks when context limit causes early failure', async () => {
      addHost({ url: mockUrl, model: 'codellama:latest' });

      db.setConfig('ollama_num_ctx', '32');
      db.setConfig('ollama_max_ctx', '32');
      db.setConfig('adaptive_context_enabled', '0');
      db.setConfig('ollama_model_settings', '');
      db.setConfig('ollama_auto_tuning_enabled', '0');

      const safeUpdate = vi.fn();
      const deps = makeDeps({ safeUpdateTaskStatus: safeUpdate });
      mod.init(deps);

      const decrementSpy = vi.spyOn(hostManagement, 'decrementHostTasks');

      const longDescription = 'B'.repeat(500);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: longDescription,
        status: 'running',
        provider: 'ollama',
        model: 'codellama:latest',
        working_directory: testDir,
      });

      await mod.executeOllamaTask({
        id: taskId,
        task_description: longDescription,
        model: 'codellama:latest',
        working_directory: testDir,
      });

      // The context-limit path explicitly calls db.decrementHostTasks(selectedHostId)
      expect(decrementSpy).toHaveBeenCalled();

      decrementSpy.mockRestore();

      // Restore config
      db.setConfig('ollama_num_ctx', '8192');
      db.setConfig('ollama_max_ctx', '32768');
    });
  });
});
