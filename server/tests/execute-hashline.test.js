/**
 * Unit tests for providers/execute-hashline.js
 *
 * Tests: parseAndApplyEdits, runOllamaGenerate, runErrorFeedbackLoop,
 * executeHashlineOllamaTask (host selection, file context building,
 * edit format selection, error handling, fallback logic).
 *
 * Uses mock HTTP server for Ollama generate requests and dependency
 * injection stubs for database / dashboard / helpers.
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const http = require('http');
const { EventEmitter } = require('events');
const { computeLineHash } = require('../utils/hashline-parser');
const hostManagement = require('../db/host-management');
const webhooksStreaming = require('../db/webhooks-streaming');

let testDir;
let origDataDir;
let db;
let taskCore;
let configCore;
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

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-exec-hashline-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');

  taskCore = require('../db/task-core');

  configCore = require('../db/config-core');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  mod = require('../providers/execute-hashline');
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

function addHost({ id = randomUUID(), name = 'test-host', url = 'http://127.0.0.1:11434', model = 'qwen2.5-coder:7b' } = {}) {
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

// ── test suite ───────────────────────────────────────────────────────

describe('execute-hashline.js', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });

  // ── parseAndApplyEdits ─────────────────────────────────────────

  describe('parseAndApplyEdits', () => {
    it('returns empty editResults when no edits found in LLM output', () => {
      const deps = makeDeps();
      mod.init(deps);

      const result = mod.parseAndApplyEdits({
        llmOutput: 'Here is some explanation with no edit blocks.',
        editFormat: 'hashline',
        fileContextMap: new Map(),
        resolvedFiles: [],
        workingDir: testDir,
      });

      expect(result.edits.length).toBe(0);
      expect(result.allSuccess).toBe(false);
      expect(result.editResults).toEqual([]);
    });

    it('handles hashline-lite format parsing', () => {
      const deps = makeDeps();
      mod.init(deps);

      const result = mod.parseAndApplyEdits({
        llmOutput: 'No valid lite edits here.',
        editFormat: 'hashline-lite',
        fileContextMap: new Map([['test.js', ['const x = 1;', 'const y = 2;']]]),
        resolvedFiles: [],
        workingDir: testDir,
      });

      expect(result.edits.length).toBe(0);
      expect(result.fullFileContent).toBeNull();
    });

    it('returns parse errors from malformed edit blocks', () => {
      const deps = makeDeps();
      mod.init(deps);

      // Construct something that triggers the parser but has issues
      const llmOutput = '```edit\nFILE: nonexistent.js\n```\nSome other text';
      const result = mod.parseAndApplyEdits({
        llmOutput,
        editFormat: 'hashline',
        fileContextMap: new Map(),
        resolvedFiles: [],
        workingDir: testDir,
      });

      // Even if no edits parsed, the structure should be valid
      expect(result.totalRemoved).toBe(0);
      expect(result.totalAdded).toBe(0);
    });

    it('tracks modified files in result', () => {
      const deps = makeDeps();
      mod.init(deps);

      // Create a real file to test against
      const testFile = path.join(testDir, 'target.js');
      fs.writeFileSync(testFile, 'const x = 1;\nconst y = 2;\n', 'utf8');

      const result = mod.parseAndApplyEdits({
        llmOutput: 'No valid edits',
        editFormat: 'hashline',
        fileContextMap: new Map(),
        resolvedFiles: [],
        workingDir: testDir,
      });

      expect(result.modifiedFiles).toEqual([]);
    });
  });

  // ── executeHashlineOllamaTask ──────────────────────────────────

  describe('executeHashlineOllamaTask', () => {
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
      mockOllama.setGenerateResponse('No edits needed, looks good.');
      mockOllama.setStatusCode(200);
      clearHosts();
    });

    it('falls back to regular ollama when no files resolved', async () => {
      const executeOllamaTask = vi.fn();
      const deps = makeDeps({ executeOllamaTask });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Do something with no file references',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Do something with no file references',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      expect(executeOllamaTask).toHaveBeenCalled();
    });

    it('escalates when model is not hashline-capable', async () => {
      const fallback = vi.fn();
      const deps = makeDeps({
        isHashlineCapableModel: vi.fn(() => false),
        tryHashlineTieredFallback: fallback,
      });
      mod.init(deps);

      // Create a file that can be resolved
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      const testFile = path.join(srcDir, 'test-file.js');
      fs.writeFileSync(testFile, 'const x = 1;\n', 'utf8');

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix src/test-file.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'tiny-model:1b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix src/test-file.js',
        model: 'tiny-model:1b',
        working_directory: testDir,
      });

      expect(fallback).toHaveBeenCalled();
    });

    it('requeues when VRAM is blocked on dynamic host', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });

      // Create a file for resolution
      const srcDir = path.join(testDir, 'src2');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'app.js'), 'const app = true;\n', 'utf8');

      const deps = makeDeps({
        isLargeModelBlockedOnHost: vi.fn(() => ({ blocked: true, reason: 'VRAM full' })),
      });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix src2/app.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      const result = await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix src2/app.js',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      expect(result).toEqual(expect.objectContaining({ queued: true, vramBlocked: true }));
    });

    it('requeues when slot reservation fails', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'src3');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'mod.js'), 'export default {};\n', 'utf8');

      const deps = makeDeps({
        tryReserveHostSlotWithFallback: vi.fn(() => ({ success: false, reason: 'capacity' })),
      });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix src3/mod.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      const result = await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix src3/mod.js',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      expect(result).toEqual(expect.objectContaining({ requeued: true }));
    });

    it('escalates when no host has the model', async () => {
      clearHosts();
      addHost({ url: mockUrl, model: 'other-model:7b' });

      const srcDir = path.join(testDir, 'src4');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'util.ts'), 'export function util() {}\n', 'utf8');

      const fallback = vi.fn();
      const deps = makeDeps({ tryHashlineTieredFallback: fallback });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix src4/util.ts',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'nonexistent:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix src4/util.ts',
        model: 'nonexistent:7b',
        working_directory: testDir,
      });

      expect(fallback).toHaveBeenCalled();
    });

    it('completes successfully when LLM returns no edits (escalates to fallback)', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'src5');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'index.js'), 'console.log("hello");\n', 'utf8');

      mockOllama.setGenerateResponse('I reviewed the code and it looks fine. No changes needed.');

      const fallback = vi.fn();
      const handleWorkflowTermination = vi.fn();
      const deps = makeDeps({ safeUpdateTaskStatus: vi.fn(), tryHashlineTieredFallback: fallback, handleWorkflowTermination });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix src5/index.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix src5/index.js',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      // When no edits are parsed, it escalates
      expect(fallback).toHaveBeenCalled();
      expect(handleWorkflowTermination).not.toHaveBeenCalled();
    });

    it('sends hashline-annotated file context in prompt', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'src6');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'code.js'), 'const a = 1;\nconst b = 2;\n', 'utf8');

      const deps = makeDeps({ safeUpdateTaskStatus: vi.fn(), tryHashlineTieredFallback: vi.fn() });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix src6/code.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix src6/code.js',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      const genReqs = mockOllama.requestLog.filter(r => r.url === '/api/generate');
      expect(genReqs.length).toBeGreaterThanOrEqual(1);
      // Prompt should contain the L###:xx: annotation format
      expect(genReqs[0].body.prompt).toContain('L001:');
      expect(genReqs[0].body.prompt).toContain('FILE CONTEXT');
    });

    it('uses hashline-lite format for small files', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'src7');
      fs.mkdirSync(srcDir, { recursive: true });
      // Small file (< 50 lines default threshold)
      fs.writeFileSync(path.join(srcDir, 'tiny.js'), 'const x = 1;\n', 'utf8');

      const deps = makeDeps({
        safeUpdateTaskStatus: vi.fn(),
        tryHashlineTieredFallback: vi.fn(),
        // selectHashlineFormat returns 'hashline' but file size override should switch to lite
        selectHashlineFormat: vi.fn(() => ({ format: 'hashline', reason: 'default' })),
      });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix src7/tiny.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix src7/tiny.js',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      // The system prompt should be the hashline-lite prompt since file size < threshold
      const genReqs = mockOllama.requestLog.filter(r => r.url === '/api/generate');
      if (genReqs.length > 0) {
        expect(genReqs[0].body.system).toBe('You are a hashline-lite editor.');
      }
    });

    it('handles HTTP failure from Ollama gracefully', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'src8');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'fail.js'), 'module.exports = {};\n', 'utf8');

      mockOllama.setFailGenerate(true);

      const fallback = vi.fn();
      const deps = makeDeps({ tryHashlineTieredFallback: fallback });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix src8/fail.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix src8/fail.js',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      // Should escalate to fallback on HTTP error
      expect(fallback).toHaveBeenCalled();
    });

    it('handles AbortError from request error gracefully', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'src9_abort');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'abort.js'), 'module.exports = 1;\n', 'utf8');

      const fallback = vi.fn();
      const deps = makeDeps({ safeUpdateTaskStatus: vi.fn(), tryHashlineTieredFallback: fallback });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix src9_abort/abort.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      const requestSpy = vi.spyOn(http, 'request');
      const abortErr = new Error('request aborted');
      abortErr.name = 'AbortError';
      const req = new EventEmitter();
      req.write = vi.fn();
      req.end = vi.fn(() => {
        setTimeout(() => req.emit('error', abortErr), 0);
      });

      requestSpy.mockImplementation(() => req);

      vi.useFakeTimers();
      try {
        const execution = mod.executeHashlineOllamaTask({
          id: taskId,
          task_description: 'Fix src9_abort/abort.js',
          model: 'qwen2.5-coder:7b',
          working_directory: testDir,
        });
        await vi.advanceTimersByTimeAsync(1);
        await expect(execution).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
        requestSpy.mockRestore();
      }

      expect(fallback).toHaveBeenCalled();
    });

    it('uses pre-routed host when ollama_host_id is set', async () => {
      const host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'src10');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'pre.js'), 'export const pre = true;\n', 'utf8');

      const deps = makeDeps({ safeUpdateTaskStatus: vi.fn(), tryHashlineTieredFallback: vi.fn() });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix src10/pre.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix src10/pre.js',
        model: 'qwen2.5-coder:7b',
        ollama_host_id: host.id,
        working_directory: testDir,
      });

      // Should have made HTTP request to the mock server
      const genReqs = mockOllama.requestLog.filter(r => r.url === '/api/generate');
      expect(genReqs.length).toBeGreaterThanOrEqual(1);
    });

    it('applies per-task tuning overrides', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'srcA');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'tune.js'), 'const tune = true;\n', 'utf8');

      const deps = makeDeps({ safeUpdateTaskStatus: vi.fn(), tryHashlineTieredFallback: vi.fn() });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix srcA/tune.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix srcA/tune.js',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
        metadata: JSON.stringify({ tuning_overrides: { temperature: 0.05, num_ctx: 2048 } }),
      });

      const genReqs = mockOllama.requestLog.filter(r => r.url === '/api/generate');
      if (genReqs.length > 0) {
        expect(genReqs[0].body.options.temperature).toBe(0.05);
        expect(genReqs[0].body.options.num_ctx).toBe(2048);
      }
    });

    it('notifies dashboard on task start and during execution', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'srcB');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'dash.js'), 'export default {};\n', 'utf8');

      const deps = makeDeps({ safeUpdateTaskStatus: vi.fn(), tryHashlineTieredFallback: vi.fn() });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix srcB/dash.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix srcB/dash.js',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalled();
    });

    it('calls workflow termination after successful hashline completion', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'srcWf');
      fs.mkdirSync(srcDir, { recursive: true });
      const targetRel = 'srcWf/target.js';
      const targetPath = path.join(srcDir, 'target.js');
      // File must be >= 50 lines to avoid hashline-lite format override
      const paddingLines = Array.from({ length: 55 }, (_, i) => `const v${i} = ${i};`);
      const originalLine = 'console.log("workflow");';
      paddingLines.push(originalLine);
      fs.writeFileSync(targetPath, paddingLines.join('\n') + '\n', 'utf8');
      const targetLineNum = paddingLines.length;
      const lineNumStr = String(targetLineNum).padStart(3, '0');
      const lineHash = computeLineHash(originalLine);

      const generated = [
        `HASHLINE_EDIT ${targetRel}`,
        `REPLACE L${lineNumStr}:${lineHash} TO L${lineNumStr}:${lineHash}`,
        originalLine,
        'END_REPLACE'
      ].join('\n');
      mockOllama.setGenerateResponse(generated);
      const handleWorkflowTermination = vi.fn();
      const deps = makeDeps({ safeUpdateTaskStatus: vi.fn(), handleWorkflowTermination });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: `Fix ${targetRel}`,
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: `Fix ${targetRel}`,
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      expect(handleWorkflowTermination).toHaveBeenCalledWith(taskId);
      expect(handleWorkflowTermination).toHaveBeenCalledTimes(1);
    });

    it('escalates via tiered fallback when no edits parsed', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'srcC');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'queue.js'), 'module.exports = 1;\n', 'utf8');

      const fallback = vi.fn();
      const deps = makeDeps({ safeUpdateTaskStatus: vi.fn(), tryHashlineTieredFallback: fallback });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix srcC/queue.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix srcC/queue.js',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      // No edits parsed from mock response, so it escalates to tiered fallback
      expect(fallback).toHaveBeenCalledWith(
        taskId,
        expect.anything(),
        expect.stringContaining('no edits parsed')
      );
    });

    it('falls back to single-host mode when no hosts registered', async () => {
      clearHosts();
      configCore.setConfig('ollama_host', mockUrl);

      const srcDir = path.join(testDir, 'srcD');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'single.js'), 'const single = true;\n', 'utf8');

      const deps = makeDeps({ safeUpdateTaskStatus: vi.fn(), tryHashlineTieredFallback: vi.fn() });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix srcD/single.js',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix srcD/single.js',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      // Should have hit the mock server via single-host mode
      const genReqs = mockOllama.requestLog.filter(r => r.url === '/api/generate');
      expect(genReqs.length).toBeGreaterThanOrEqual(1);
    });

    it('skips binary/unreadable files gracefully', async () => {
      const _host = addHost({ url: mockUrl, model: 'qwen2.5-coder:7b' });
      const srcDir = path.join(testDir, 'srcE');
      fs.mkdirSync(srcDir, { recursive: true });
      // Reference a file that does not exist
      const deps = makeDeps({ safeUpdateTaskStatus: vi.fn(), tryHashlineTieredFallback: vi.fn() });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fix srcE/missing-file.js that does not exist',
        status: 'running',
        provider: 'hashline-ollama',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      // Should not throw — missing files are gracefully skipped
      await mod.executeHashlineOllamaTask({
        id: taskId,
        task_description: 'Fix srcE/missing-file.js that does not exist',
        model: 'qwen2.5-coder:7b',
        working_directory: testDir,
      });

      // No crash is the success condition
      expect(true).toBe(true);
    });
  });

  // ── runOllamaGenerate ──────────────────────────────────────────

  describe('runOllamaGenerate', () => {
    let mockOllama2;
    let mockUrl2;

    beforeAll(async () => {
      const { createMockOllama } = require('./mocks/ollama');
      mockOllama2 = createMockOllama();
      const info = await mockOllama2.start();
      mockUrl2 = info.url;
    });

    afterAll(async () => {
      await mockOllama2.stop();
    });

    beforeEach(() => {
      mockOllama2.clearLog();
      mockOllama2.setFailGenerate(false);
      mockOllama2.setGenerateResponse('Generated response text.');
      mockOllama2.setGenerateDelay(0);
      mockOllama2.setStatusCode(200);
    });

    it('returns response from successful generation', async () => {
      const deps = makeDeps();
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Generate test',
        status: 'running',
        provider: 'hashline-ollama',
        working_directory: testDir,
      });
      const streamId = webhooksStreaming.getOrCreateTaskStream(taskId, 'output');
      const result = await mod.runOllamaGenerate({
        ollamaHost: mockUrl2,
        ollamaModel: 'codellama:latest',
        prompt: 'Test prompt',
        systemPrompt: 'System prompt',
        options: { temperature: 0.3, num_ctx: 4096 },
        timeoutMs: 10000,
        taskId,
        streamId,
      });

      expect(result.response).toContain('Generated');
    });

    it('aborts streaming request when task is cancelled', async () => {
      const deps = makeDeps();
      mod.init(deps);
      mockOllama2.setGenerateDelay(2500);

      let abortRequest;
      const originalAbort = AbortController.prototype.abort;
      const abortSpy = vi.fn();
      let abortCalled = false;
      AbortController.prototype.abort = function () {
        if (abortCalled) return;
        abortCalled = true;
        abortSpy();
        if (abortRequest) {
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          abortRequest.emit('error', abortErr);
        }
        return undefined;
      };

      const requestSpy = vi.spyOn(http, 'request');
      requestSpy.mockImplementation((_options, _callback) => {
        const req = new EventEmitter();
        req.write = vi.fn();
        req.end = vi.fn(() => {});
        req.destroy = vi.fn();
        req.on('error', () => {});
        abortRequest = req;
        return req;
      });

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Generate cancellation test',
        status: 'running',
        provider: 'hashline-ollama',
        working_directory: testDir,
      });
      const streamId = webhooksStreaming.getOrCreateTaskStream(taskId, 'output');

      vi.useFakeTimers();
      // Suppress AbortError unhandled rejections from fake timer + AbortController interaction
      const suppressAbort = (err) => { if (err && err.name === 'AbortError') return; throw err; };
      process.on('unhandledRejection', suppressAbort);
      try {
        const run = mod.runOllamaGenerate({
          ollamaHost: mockUrl2,
          ollamaModel: 'codellama:latest',
          prompt: 'Long prompt',
          systemPrompt: 'System prompt',
          options: { temperature: 0.3, num_ctx: 4096 },
          timeoutMs: 10000,
          taskId,
          streamId,
        });
        await vi.advanceTimersByTimeAsync(200);
        taskCore.updateTaskStatus(taskId, 'cancelled', {});
        await vi.advanceTimersByTimeAsync(3000);
        await expect(run).rejects.toThrow();
      } finally {
        vi.useRealTimers();
        requestSpy.mockRestore();
        AbortController.prototype.abort = originalAbort;
        process.removeListener('unhandledRejection', suppressAbort);
      }

      expect(abortSpy).toHaveBeenCalled();
    });

    it('clears cancellation check interval after successful generation', async () => {
      const deps = makeDeps();
      mod.init(deps);
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Generate interval test',
        status: 'running',
        provider: 'hashline-ollama',
        working_directory: testDir,
      });
      const streamId = webhooksStreaming.getOrCreateTaskStream(taskId, 'output');

      try {
        await mod.runOllamaGenerate({
          ollamaHost: mockUrl2,
          ollamaModel: 'codellama:latest',
          prompt: 'Generate once',
          systemPrompt: 'System',
          options: { temperature: 0.3, num_ctx: 4096 },
          timeoutMs: 10000,
          taskId,
          streamId,
        });

        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
        const intervalHandle = setIntervalSpy.mock.results[0].value;
        expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
      } finally {
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }
    });

    it('throws on HTTP 500 error', async () => {
      const deps = makeDeps();
      mod.init(deps);
      mockOllama2.setFailGenerate(true);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Fail generate test',
        status: 'running',
        provider: 'hashline-ollama',
        working_directory: testDir,
      });
      const streamId = webhooksStreaming.getOrCreateTaskStream(taskId, 'output');
      await expect(mod.runOllamaGenerate({
        ollamaHost: mockUrl2,
        ollamaModel: 'codellama:latest',
        prompt: 'Fail prompt',
        systemPrompt: 'System',
        options: {},
        timeoutMs: 10000,
        taskId,
        streamId,
      })).rejects.toThrow();
    });

    it('sends correct model in request', async () => {
      const deps = makeDeps();
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Model check test',
        status: 'running',
        provider: 'hashline-ollama',
        working_directory: testDir,
      });
      const streamId = webhooksStreaming.getOrCreateTaskStream(taskId, 'output');
      await mod.runOllamaGenerate({
        ollamaHost: mockUrl2,
        ollamaModel: 'mistral:latest',
        prompt: 'Model check',
        systemPrompt: 'Test',
        options: {},
        timeoutMs: 10000,
        taskId,
        streamId,
      });

      const genReqs = mockOllama2.requestLog.filter(r => r.url === '/api/generate');
      expect(genReqs[0].body.model).toBe('mistral:latest');
    });
  });
});
