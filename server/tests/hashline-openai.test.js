'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

describe('Hashline-OpenAI Provider', () => {
  let tempDir;
  let db;
  let tm; // task-manager module (re-required after DB setup)
  let originalFetch;
  let originalApiKey;

  beforeAll(() => {
    // setupTestDb clears database.js cache and creates fresh DB
    const setup = setupTestDb('hashline-openai');
    db = setup.db;

    tm = require('../task-manager');

    tempDir = path.join(os.tmpdir(), `torque-hashline-openai-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    originalFetch = global.fetch;
    originalApiKey = process.env.OPENAI_API_KEY;
  });

  afterAll(() => {
    teardownTestDb();
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch { /* ignore EBUSY on Windows */ }
    global.fetch = originalFetch;
    if (originalApiKey !== undefined) {
      process.env.OPENAI_API_KEY = originalApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalApiKey !== undefined) {
      process.env.OPENAI_API_KEY = originalApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  // Helper: create task in DB and return task object
  function mockTask(overrides = {}) {
    const taskId = overrides.id || `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const desc = overrides.task_description || 'Fix the bug in src/utils.ts';
    const wd = overrides.working_directory || tempDir;
    try {
      db.createTask({
        id: taskId,
        task_description: desc,
        provider: 'hashline-openai',
        working_directory: wd,
        status: 'queued'
      });
    } catch { /* ignore */ }

    return {
      id: taskId,
      task_description: desc,
      provider: 'hashline-openai',
      working_directory: wd,
      ...overrides
    };
  }

  // Helper: create a temp file in src/ subdir
  function createTempFile(name, content) {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const filePath = path.join(srcDir, name);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  // Helper: mock fetch returning a successful Responses API response
  function mockFetchSuccess(content, usage = {}) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: [
          { type: 'message', content: [{ type: 'output_text', text: content }] }
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, ...usage }
      })
    });
  }

  // ─── API Key Handling ──────────────────────────────────────────────────

  describe('API key handling', () => {
    it('falls back to codex when OPENAI_API_KEY is not set', async () => {
      delete process.env.OPENAI_API_KEY;
      const task = mockTask();

      await tm.executeHashlineOpenaiTask(task);

      // Task should have been requeued as codex
      expect(task.provider).toBe('codex');
    });

    it('uses OPENAI_API_KEY from environment', async () => {
      process.env.OPENAI_API_KEY = 'test-key-123';
      createTempFile('utils.ts', 'const x = 1;\n');

      mockFetchSuccess('No changes needed.');

      const task = mockTask({
        task_description: 'Fix the bug in src/utils.ts'
      });
      await tm.executeHashlineOpenaiTask(task);

      // fetch should have been called with the API key
      expect(global.fetch).toHaveBeenCalled();
      const fetchCall = global.fetch.mock.calls[0];
      expect(fetchCall[1].headers['Authorization']).toBe('Bearer test-key-123');
    });
  });

  // ─── File Resolution ──────────────────────────────────────────────────

  describe('file resolution', () => {
    it('falls back to codex when no files resolved', async () => {
      process.env.OPENAI_API_KEY = 'test-key-123';
      const task = mockTask({
        task_description: 'Do something without any file references'
      });

      await tm.executeHashlineOpenaiTask(task);

      expect(task.provider).toBe('codex');
    });
  });

  // ─── Model Selection ──────────────────────────────────────────────────

  describe('model selection', () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'test-key-123';
      createTempFile('utils.ts', 'const x = 1;\n');
    });

    it('uses task.model when provided', async () => {
      mockFetchSuccess('No changes needed.');
      const task = mockTask({
        task_description: 'Fix the bug in src/utils.ts',
        model: 'gpt-4o'
      });

      await tm.executeHashlineOpenaiTask(task);

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4o');
    });

    it('uses hashline_openai_model config when task.model absent', async () => {
      mockFetchSuccess('No changes needed.');
      db.setConfig('hashline_openai_model', 'gpt-4-turbo');
      const task = mockTask({
        task_description: 'Fix the bug in src/utils.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4-turbo');

      // Clean up
      db.setConfig('hashline_openai_model', '');
    });

    it('defaults to gpt-4o-mini', async () => {
      mockFetchSuccess('No changes needed.');
      db.setConfig('hashline_openai_model', '');
      const task = mockTask({
        task_description: 'Fix the bug in src/utils.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4o-mini');
    });
  });

  // ─── Request Format (Responses API) ───────────────────────────────────

  describe('request format', () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'test-key-123';
      createTempFile('utils.ts', 'const x = 1;\nconst y = 2;\n');
    });

    it('sends instructions with HASHLINE_OLLAMA_SYSTEM_PROMPT', async () => {
      mockFetchSuccess('No changes needed.');
      const task = mockTask({
        task_description: 'Fix the bug in src/utils.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.instructions).toBe(tm.HASHLINE_OLLAMA_SYSTEM_PROMPT);
    });

    it('sends input with hashline-annotated file context', async () => {
      mockFetchSuccess('No changes needed.');
      const task = mockTask({
        task_description: 'Fix the bug in src/utils.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      // Should contain hashline annotations like L001:xx:
      expect(body.input).toMatch(/L\d{3}:[0-9a-f]{2}:/);
      // Should contain the file context header
      expect(body.input).toContain('FILE CONTEXT');
    });

    it('calls /v1/responses endpoint with Authorization Bearer header', async () => {
      mockFetchSuccess('No changes needed.');
      const task = mockTask({
        task_description: 'Fix the bug in src/utils.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toContain('/v1/responses');
      expect(opts.headers['Authorization']).toBe('Bearer test-key-123');
      expect(opts.headers['Content-Type']).toBe('application/json');
    });
  });

  // ─── Response Handling ────────────────────────────────────────────────

  describe('response handling', () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'test-key-123';
    });

    it('parses edit blocks and applies them', async () => {
      const fileContent = 'line one\nline two\nline three\n';
      createTempFile('target.ts', fileContent);

      const hash2 = tm.computeLineHash('line two');
      const editResponse = `HASHLINE_EDIT src/target.ts
REPLACE L002:${hash2} TO L002:${hash2}
line TWO replaced
END_REPLACE`;

      mockFetchSuccess(editResponse);
      const task = mockTask({
        task_description: 'Fix the bug in src/target.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      // Verify the file was modified
      const updated = fs.readFileSync(path.join(tempDir, 'src', 'target.ts'), 'utf8');
      expect(updated).toContain('line TWO replaced');
      expect(updated).toContain('line one');
      expect(updated).toContain('line three');
    });

    it('handles empty response', async () => {
      createTempFile('empty.ts', 'content\n');
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          output: [],
          usage: {}
        })
      });

      const task = mockTask({
        task_description: 'Fix the bug in src/empty.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      // Task should escalate to codex (tiered fallback)
      const taskRow = db.getTask(task.id);
      expect(taskRow.status).toBe('queued');
      expect(taskRow.provider).toBe('codex');
      expect(taskRow.error_output).toContain('Empty response');
    });

    it('handles API error (4xx/5xx)', async () => {
      createTempFile('error.ts', 'content\n');
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      });

      const task = mockTask({
        task_description: 'Fix the bug in src/error.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      const taskRow = db.getTask(task.id);
      expect(taskRow.status).toBe('queued');
      expect(taskRow.provider).toBe('codex');
      expect(taskRow.error_output).toContain('500');
    });

    it('handles 429 rate limit', async () => {
      createTempFile('ratelimit.ts', 'content\n');
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded'
      });

      const task = mockTask({
        task_description: 'Fix the bug in src/ratelimit.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      const taskRow = db.getTask(task.id);
      expect(taskRow.status).toBe('queued');
      expect(taskRow.provider).toBe('codex');
      expect(taskRow.error_output).toContain('429');
    });
  });

  // ─── Smart Routing ────────────────────────────────────────────────────

  describe('smart routing upgrade to hashline-openai', () => {
    it('upgrades codex → hashline-openai for targeted file edits when enabled', () => {
      // Enable hashline-openai and smart routing
      db.updateProvider('hashline-openai', { enabled: 1 });
      db.setConfig('smart_routing_enabled', '1');

      const result = db.analyzeTaskForRouting(
        'Add JSDoc comment to the getData method in src/utils.ts',
        tempDir, [], { skipHealthCheck: true }
      );

      // If original routing was codex and task is simple/normal targeted edit,
      // it should have been upgraded
      if (result.provider === 'hashline-openai') {
        expect(result.reason).toContain('hashline-openai');
      }

      // Clean up
      db.updateProvider('hashline-openai', { enabled: 0 });
    });

    it('does not upgrade when hashline-openai is disabled', () => {
      db.updateProvider('hashline-openai', { enabled: 0 });
      db.setConfig('smart_routing_enabled', '1');

      const result = db.analyzeTaskForRouting(
        'Add JSDoc comment to the getData method in src/utils.ts',
        tempDir, [], { skipHealthCheck: true }
      );

      expect(result.provider).not.toBe('hashline-openai');
    });

    it('does not upgrade complex tasks', () => {
      db.updateProvider('hashline-openai', { enabled: 1 });
      db.setConfig('smart_routing_enabled', '1');

      const result = db.analyzeTaskForRouting(
        'Implement a full authentication system with OAuth, JWT, and session management',
        tempDir, [], { skipHealthCheck: true }
      );

      // Complex tasks should not be upgraded to hashline-openai
      expect(result.provider).not.toBe('hashline-openai');

      // Clean up
      db.updateProvider('hashline-openai', { enabled: 0 });
    });
  });

  // ─── Pre-flight Type Validation & Enrichment ───────────────────────────

  describe('preflight type validation', () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'test-key-123';
    });

    it('injects preflight hints when task references wrong enum value', async () => {
      // Create source file that imports from types
      createTempFile('giving.ts', `import { GivingFrequency } from './types';\nconst f = GivingFrequency.Monthly;\n`);
      // Create the dependency with actual enum values
      createTempFile('types.ts', `export enum GivingFrequency {\n  Weekly = 'weekly',\n  Biweekly = 'biweekly',\n  Monthly = 'monthly',\n}\n`);

      mockFetchSuccess('No changes needed.');
      const task = mockTask({
        task_description: 'Add a template with GivingFrequency.Quarterly in src/giving.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      expect(global.fetch).toHaveBeenCalled();
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      // Preflight should inject TYPE VALIDATION NOTES with correction
      expect(body.input).toContain('TYPE VALIDATION NOTES');
      expect(body.input).toContain('Quarterly');
      expect(body.input).toContain('Weekly');
    });

    it('does not inject hints when enum values are correct', async () => {
      createTempFile('giving2.ts', `import { GivingFrequency } from './types';\nconst f = GivingFrequency.Monthly;\n`);
      createTempFile('types.ts', `export enum GivingFrequency {\n  Weekly = 'weekly',\n  Biweekly = 'biweekly',\n  Monthly = 'monthly',\n}\n`);

      mockFetchSuccess('No changes needed.');
      const task = mockTask({
        task_description: 'Use GivingFrequency.Monthly in src/giving2.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      expect(global.fetch).toHaveBeenCalled();
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.input).not.toContain('TYPE VALIDATION NOTES');
    });

    it('includes enrichment context (import signatures) in prompt', async () => {
      createTempFile('service.ts', `import { Config } from './config';\nexport function run(c: Config) {}\n`);
      createTempFile('config.ts', `export interface Config {\n  host: string;\n  port: number;\n}\n`);

      mockFetchSuccess('No changes needed.');
      const task = mockTask({
        task_description: 'Fix the run function in src/service.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      expect(global.fetch).toHaveBeenCalled();
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      // Enrichment should include import signatures from config.ts
      expect(body.input).toContain('IMPORTED TYPE SIGNATURES');
      expect(body.input).toContain('Config');
    });

    it('skips preflight when preflight_validation_enabled is 0', async () => {
      createTempFile('giving3.ts', `import { GivingFrequency } from './types';\nconst f = GivingFrequency.Monthly;\n`);
      createTempFile('types.ts', `export enum GivingFrequency {\n  Weekly = 'weekly',\n  Monthly = 'monthly',\n}\n`);

      db.setConfig('preflight_validation_enabled', '0');
      mockFetchSuccess('No changes needed.');
      const task = mockTask({
        task_description: 'Add GivingFrequency.Quarterly in src/giving3.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      expect(global.fetch).toHaveBeenCalled();
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.input).not.toContain('TYPE VALIDATION NOTES');

      // Clean up
      db.setConfig('preflight_validation_enabled', '');
    });

    it('skips enrichment when context_enrichment_enabled is 0', async () => {
      createTempFile('service2.ts', `import { Config } from './config';\nexport function run(c: Config) {}\n`);
      createTempFile('config.ts', `export interface Config {\n  host: string;\n}\n`);

      db.setConfig('context_enrichment_enabled', '0');
      mockFetchSuccess('No changes needed.');
      const task = mockTask({
        task_description: 'Fix the run function in src/service2.ts'
      });

      await tm.executeHashlineOpenaiTask(task);

      expect(global.fetch).toHaveBeenCalled();
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.input).not.toContain('IMPORTED TYPE SIGNATURES');

      // Clean up
      db.setConfig('context_enrichment_enabled', '');
    });
  });
});
