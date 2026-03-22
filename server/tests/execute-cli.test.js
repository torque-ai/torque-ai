/**
 * Unit tests for providers/execute-cli.js
 *
 * Tests: buildClaudeCliCommand, buildCodexCommand,
 * spawnAndTrackProcess lifecycle (stdout/stderr/close/error handlers).
 *
 * NOTE: The builder tests overlap with execution-builders.test.js, which
 * tests via the old providers/execution.js module. These tests exercise the
 * extracted execute-cli.js module directly and add spawnAndTrackProcess coverage.
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir;
let origDataDir;
let db;
let mod;
let spawnMock;
let originalSpawn;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

// ── helpers ──────────────────────────────────────────────────────────

function defaultHelpers(overrides = {}) {
  return {
    wrapWithInstructions: (desc, provider, model, ctx) => {
      const mp = model ? `:${model}` : '';
      const fc = ctx?.fileContext ? `\n${ctx.fileContext}` : '';
      return `[${provider}${mp}] ${desc}${fc}`;
    },
    shellEscape: (s) => s,
    getProjectDefaults: () => ({}),
    buildFileContextString: (fc) => fc || '',
    getEffectiveModel: (task) => task.model || 'qwen3:8b',
    startTask: vi.fn(),
    classifyError: () => ({ retryable: false, reason: 'unknown' }),
    detectTaskTypes: () => [],
    extractTargetFilesFromDescription: () => [],
    ensureTargetFilesExist: (wd, fps) => [...new Set(fps)].map((p) => path.resolve(wd, p)),
    isLargeModelBlockedOnHost: () => ({ blocked: false }),
    resolveWindowsCmdToNode: () => null,
    cancelTask: vi.fn(),
    estimateProgress: () => 50,
    detectOutputCompletion: () => false,
    checkBreakpoints: () => null,
    pauseTaskForDebug: vi.fn(),
    pauseTask: vi.fn(),
    getActualModifiedFiles: () => [],
    runLLMSafeguards: () => ({ passed: true, issues: [] }),
    rollbackTaskChanges: () => true,
    checkFileQuality: () => ({ issues: [] }),
    runBuildVerification: () => ({ skipped: true }),
    runTestVerification: () => ({ skipped: true }),
    runStyleCheck: () => ({ skipped: true }),
    tryCreateAutoPR: vi.fn(),
    evaluateWorkflowDependencies: vi.fn(),
    handlePlanProjectTaskCompletion: vi.fn(),
    handlePlanProjectTaskFailure: vi.fn(),
    handlePipelineStepCompletion: vi.fn(),
    handleWorkflowTermination: vi.fn(),
    runOutputSafeguards: vi.fn(async () => {}),
    isValidFilePath: () => true,
    isShellSafe: () => true,
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  return {
    db,
    dashboard: {
      broadcast: vi.fn(),
      broadcastTaskUpdate: vi.fn(),
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    },
    runningProcesses: overrides.runningProcesses || new Map(),
    safeUpdateTaskStatus: overrides.safeUpdateTaskStatus || vi.fn(),
    finalizeTask: overrides.finalizeTask || vi.fn(async () => ({ finalized: true, queueManaged: false })),
    tryReserveHostSlotWithFallback: overrides.tryReserveHostSlotWithFallback || vi.fn(() => ({ success: true })),
    markTaskCleanedUp: overrides.markTaskCleanedUp || vi.fn(() => true),
    tryOllamaCloudFallback: overrides.tryOllamaCloudFallback || vi.fn(() => false),
    tryLocalFirstFallback: overrides.tryLocalFirstFallback || vi.fn(() => false),
    attemptFuzzySearchRepair: overrides.attemptFuzzySearchRepair || vi.fn(() => ({ repaired: false })),
    tryHashlineTieredFallback: overrides.tryHashlineTieredFallback || vi.fn(() => false),
    shellEscape: (s) => s,
    processQueue: overrides.processQueue || vi.fn(),
    isLargeModelBlockedOnHost: overrides.isLargeModelBlockedOnHost || vi.fn(() => ({ blocked: false })),
    helpers: defaultHelpers(overrides.helpers || {}),
    NVM_NODE_PATH: overrides.NVM_NODE_PATH !== undefined ? overrides.NVM_NODE_PATH : null,
    QUEUE_LOCK_HOLDER_ID: 'test-lock',
    MAX_OUTPUT_BUFFER: 10 * 1024 * 1024,
    pendingRetryTimeouts: new Map(),
    taskCleanupGuard: new Map(),
  };
}

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-exec-cli-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  // Patch child_process.spawn BEFORE loading execute-cli.js
  // so the destructured `spawn` variable inside the module captures our mock
  const cp = require('child_process');
  originalSpawn = cp.spawn;
  spawnMock = vi.fn();
  cp.spawn = spawnMock;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  mod = require('../providers/execute-cli');
}

function teardown() {
  // Restore original spawn
  if (originalSpawn) {
    const cp = require('child_process');
    cp.spawn = originalSpawn;
  }
  try { if (db) db.close(); } catch { /* ok */ }
  if (origDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = origDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
}

function addHost({ id = randomUUID(), name = 'test-host', url = 'http://127.0.0.1:11434', model = 'qwen2.5-coder:7b' } = {}) {
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

function resetConfigs() {
  db.setConfig('proactive_format_selection_enabled', '0');
  db.setConfig('ollama_model_settings', '');
  db.setConfig('ollama_host', 'http://localhost:11434');
}

// ── test suite ───────────────────────────────────────────────────────

describe('execute-cli.js', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });

  // ── buildCodexCommand ──────────────────────────────────────────

  describe('buildCodexCommand', () => {
    beforeEach(() => {
      resetConfigs();
      clearHosts();
      mod.init(makeDeps());
    });

    it('builds codex command with model and full-auto flags', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Implement tests',
        model: 'gpt-5-codex',
        auto_approve: 0,
        working_directory: testDir,
      };
      const result = mod.buildCodexCommand(task, 'CTX', null);

      expect(result.finalArgs).toContain('exec');
      expect(result.finalArgs).toContain('--skip-git-repo-check');
      expect(result.finalArgs).toContain('--full-auto');
      expect(result.finalArgs).toContain('-m');
      expect(result.finalArgs).toContain('gpt-5-codex');
    });

    it('uses bypass approvals flag when auto_approve is set', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Test',
        auto_approve: 1,
      };
      const result = mod.buildCodexCommand(task, '', null);
      expect(result.finalArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(result.finalArgs).not.toContain('--full-auto');
    });

    it('includes working directory with -C flag', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Test',
        working_directory: '/tmp/work',
      };
      const result = mod.buildCodexCommand(task, '', null);
      expect(result.finalArgs).toContain('-C');
      expect(result.finalArgs).toContain('/tmp/work');
    });

    it('ends args with stdin dash', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Test',
      };
      const result = mod.buildCodexCommand(task, '', null);
      expect(result.finalArgs[result.finalArgs.length - 1]).toBe('-');
    });

    it('sets stdinPrompt with wrapped description', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Build feature',
      };
      const result = mod.buildCodexCommand(task, 'FILE_CONTEXT', null);
      expect(result.stdinPrompt).toContain('[codex]');
      expect(result.stdinPrompt).toContain('Build feature');
      expect(result.stdinPrompt).toContain('FILE_CONTEXT');
    });

    it('uses custom cli_path from provider config', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Test',
      };
      const basePath = path.join(testDir, 'custom-codex');
      const result = mod.buildCodexCommand(task, '', { cli_path: basePath });

      if (process.platform === 'win32') {
        expect(result.cliPath).toBe(`${basePath}.cmd`);
      } else {
        expect(result.cliPath).toBe(basePath);
      }
    });

    it('returns empty envExtras and null selectedOllamaHostId', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Test',
      };
      const result = mod.buildCodexCommand(task, '', null);
      expect(result.envExtras).toEqual({});
      expect(result.selectedOllamaHostId).toBeNull();
      expect(result.usedEditFormat).toBeNull();
    });
  });

  // ── buildClaudeCliCommand ──────────────────────────────────────

  describe('buildClaudeCliCommand', () => {
    beforeEach(() => {
      resetConfigs();
      clearHosts();
      mod.init(makeDeps());
    });

    it('builds claude-cli command with permission skip flags', () => {
      const task = {
        id: randomUUID(),
        provider: 'claude-cli',
        task_description: 'Review code',
        working_directory: testDir,
      };
      const result = mod.buildClaudeCliCommand(task, '', null);

      expect(result.finalArgs).toContain('--dangerously-skip-permissions');
      expect(result.finalArgs).toContain('--disable-slash-commands');
      expect(result.finalArgs).toContain('--strict-mcp-config');
      expect(result.finalArgs).toContain('-p');
    });

    it('uses stdin prompt with wrapped description', () => {
      const task = {
        id: randomUUID(),
        provider: 'claude-cli',
        task_description: 'Analyze architecture',
      };
      const result = mod.buildClaudeCliCommand(task, 'FILECTX', null);
      expect(result.stdinPrompt).toContain('[claude-cli]');
      expect(result.stdinPrompt).toContain('Analyze architecture');
    });

    it('uses default claude path without provider config', () => {
      const task = {
        id: randomUUID(),
        provider: 'claude-cli',
        task_description: 'Test',
      };
      const result = mod.buildClaudeCliCommand(task, '', null);
      if (process.platform === 'win32') {
        expect(result.cliPath).toBe('claude.cmd');
      } else {
        expect(result.cliPath).toBe('claude');
      }
    });

    it('uses custom cli_path from provider config', () => {
      const task = {
        id: randomUUID(),
        provider: 'claude-cli',
        task_description: 'Test',
      };
      const basePath = path.join(testDir, 'custom-claude');
      const result = mod.buildClaudeCliCommand(task, '', { cli_path: basePath });
      if (process.platform === 'win32') {
        expect(result.cliPath).toBe(`${basePath}.cmd`);
      } else {
        expect(result.cliPath).toBe(basePath);
      }
    });

    it('returns empty envExtras', () => {
      const task = {
        id: randomUUID(),
        provider: 'claude-cli',
        task_description: 'Test',
      };
      const result = mod.buildClaudeCliCommand(task, '', null);
      expect(result.envExtras).toEqual({});
    });
  });

  // ── spawnAndTrackProcess ───────────────────────────────────────

  describe('spawnAndTrackProcess', () => {
    const { createMockChild, simulateSuccess } = require('./mocks/process-mock');

    beforeEach(() => {
      resetConfigs();
      clearHosts();
      spawnMock.mockReset();
    });

    it('spawns process and tracks it in runningProcesses', () => {
      const mockChild = createMockChild();
      spawnMock.mockReturnValue(mockChild);

      const runningProcesses = new Map();
      const deps = makeDeps({ runningProcesses });
      mod.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Spawn test',
        status: 'running',
        provider: 'codex',
        working_directory: testDir,
      });

      const cmdSpec = {
        cliPath: 'node',
        finalArgs: ['-e', 'console.log("ok")'],
        stdinPrompt: null,
        envExtras: {},
        selectedOllamaHostId: null,
        usedEditFormat: null,
      };

      mod.spawnAndTrackProcess(taskId, { id: taskId, working_directory: testDir }, cmdSpec, 'codex');

      expect(spawnMock).toHaveBeenCalled();
      expect(runningProcesses.has(taskId)).toBe(true);

      // Clean up
      simulateSuccess(mockChild, 'Done');
    });

    it('writes stdinPrompt to child stdin when provided', () => {
      const mockChild = createMockChild();
      const writeSpy = vi.spyOn(mockChild.stdin, 'write');
      spawnMock.mockReturnValue(mockChild);

      const deps = makeDeps({ runningProcesses: new Map() });
      mod.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Stdin test',
        status: 'running',
        provider: 'codex',
        working_directory: testDir,
      });

      const cmdSpec = {
        cliPath: 'node',
        finalArgs: [],
        stdinPrompt: 'Hello world prompt',
        envExtras: {},
        selectedOllamaHostId: null,
        usedEditFormat: null,
      };

      mod.spawnAndTrackProcess(taskId, { id: taskId, working_directory: testDir }, cmdSpec, 'codex');

      expect(writeSpy).toHaveBeenCalledWith('Hello world prompt');

      simulateSuccess(mockChild, 'Done');
    });

    it('sets working directory in spawn options', () => {
      const mockChild = createMockChild();
      spawnMock.mockReturnValue(mockChild);

      const deps = makeDeps({ runningProcesses: new Map() });
      mod.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'CWD test',
        status: 'running',
        provider: 'codex',
        working_directory: testDir,
      });

      const cmdSpec = {
        cliPath: 'node',
        finalArgs: [],
        stdinPrompt: null,
        envExtras: {},
        selectedOllamaHostId: null,
        usedEditFormat: null,
      };

      mod.spawnAndTrackProcess(taskId, { id: taskId, working_directory: testDir }, cmdSpec, 'codex');

      const spawnOpts = spawnMock.mock.calls[0][2];
      expect(spawnOpts.cwd).toBe(testDir);

      simulateSuccess(mockChild, 'Done');
    });

    it('includes envExtras in spawn environment', () => {
      const mockChild = createMockChild();
      spawnMock.mockReturnValue(mockChild);

      const deps = makeDeps({ runningProcesses: new Map() });
      mod.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Env test',
        status: 'running',
        provider: 'codex',
        working_directory: testDir,
      });

      const cmdSpec = {
        cliPath: 'node',
        finalArgs: [],
        stdinPrompt: null,
        envExtras: { OLLAMA_API_BASE: 'http://10.0.0.1:11434', CUSTOM_VAR: 'test' },
        selectedOllamaHostId: null,
        usedEditFormat: null,
      };

      mod.spawnAndTrackProcess(taskId, { id: taskId, working_directory: testDir }, cmdSpec, 'codex');

      const spawnOpts = spawnMock.mock.calls[0][2];
      expect(spawnOpts.env.OLLAMA_API_BASE).toBe('http://10.0.0.1:11434');
      expect(spawnOpts.env.CUSTOM_VAR).toBe('test');
      expect(spawnOpts.env.FORCE_COLOR).toBe('0');
      expect(spawnOpts.env.NO_COLOR).toBe('1');

      simulateSuccess(mockChild, 'Done');
    });

    it('captures stdout in the running process entry', async () => {
      const mockChild = createMockChild();
      spawnMock.mockReturnValue(mockChild);

      const runningProcesses = new Map();
      const deps = makeDeps({ runningProcesses });
      mod.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Stdout capture test',
        status: 'running',
        provider: 'codex',
        working_directory: testDir,
      });

      const cmdSpec = {
        cliPath: 'node',
        finalArgs: [],
        stdinPrompt: null,
        envExtras: {},
        selectedOllamaHostId: null,
        usedEditFormat: null,
      };

      vi.useFakeTimers();
      mod.spawnAndTrackProcess(taskId, { id: taskId, working_directory: testDir }, cmdSpec, 'codex');

      try {
        // Write stdout data
        mockChild.stdout.write('Hello from stdout');

        // Give event loop a tick to process
        await vi.advanceTimersByTimeAsync(50);

        const proc = runningProcesses.get(taskId);
        expect(proc).toBeDefined();
        expect(proc.output).toContain('Hello from stdout');
      } finally {
        vi.useRealTimers();
      }

      simulateSuccess(mockChild, '');
    });

    it('captures stderr in the running process entry', async () => {
      const mockChild = createMockChild();
      spawnMock.mockReturnValue(mockChild);

      const runningProcesses = new Map();
      const deps = makeDeps({ runningProcesses });
      mod.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Stderr capture test',
        status: 'running',
        provider: 'codex',
        working_directory: testDir,
      });

      const cmdSpec = {
        cliPath: 'node',
        finalArgs: [],
        stdinPrompt: null,
        envExtras: {},
        selectedOllamaHostId: null,
        usedEditFormat: null,
      };

      vi.useFakeTimers();
      mod.spawnAndTrackProcess(taskId, { id: taskId, working_directory: testDir }, cmdSpec, 'codex');

      try {
        mockChild.stderr.write('Warning: something');

        await vi.advanceTimersByTimeAsync(50);

        const proc = runningProcesses.get(taskId);
        expect(proc).toBeDefined();
        expect(proc.errorOutput).toContain('Warning: something');
      } finally {
        vi.useRealTimers();
      }

      simulateSuccess(mockChild, '');
    });

    it('notifies dashboard on task start', () => {
      const mockChild = createMockChild();
      spawnMock.mockReturnValue(mockChild);

      const deps = makeDeps({ runningProcesses: new Map() });
      mod.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Dashboard notify test',
        status: 'running',
        provider: 'codex',
        working_directory: testDir,
      });

      const cmdSpec = {
        cliPath: 'node',
        finalArgs: [],
        stdinPrompt: null,
        envExtras: {},
        selectedOllamaHostId: null,
        usedEditFormat: null,
      };

      mod.spawnAndTrackProcess(taskId, { id: taskId, working_directory: testDir }, cmdSpec, 'codex');

      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledWith(taskId);

      simulateSuccess(mockChild, '');
    });

    it('returns task object from spawn result', () => {
      const mockChild = createMockChild();
      spawnMock.mockReturnValue(mockChild);

      const deps = makeDeps({ runningProcesses: new Map() });
      mod.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Result test',
        status: 'running',
        provider: 'codex',
        working_directory: testDir,
      });

      const cmdSpec = {
        cliPath: 'node',
        finalArgs: [],
        stdinPrompt: null,
        envExtras: {},
        selectedOllamaHostId: null,
        usedEditFormat: null,
      };

      const result = mod.spawnAndTrackProcess(taskId, { id: taskId, working_directory: testDir }, cmdSpec, 'codex');

      expect(result.queued).toBe(false);
      expect(result.task).toBeDefined();

      simulateSuccess(mockChild, '');
    });

    it('handles process error event', async () => {
      const mockChild = createMockChild();
      spawnMock.mockReturnValue(mockChild);

      const finalizeTaskSpy = vi.fn(async () => ({ finalized: true, queueManaged: false }));
      const deps = makeDeps({ runningProcesses: new Map(), finalizeTask: finalizeTaskSpy });
      mod.init(deps);

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Error event test',
        status: 'running',
        provider: 'codex',
        working_directory: testDir,
      });

      const cmdSpec = {
        cliPath: 'node',
        finalArgs: [],
        stdinPrompt: null,
        envExtras: {},
        selectedOllamaHostId: null,
        usedEditFormat: null,
      };

      vi.useFakeTimers();
      mod.spawnAndTrackProcess(taskId, { id: taskId, working_directory: testDir }, cmdSpec, 'codex');

      try {
        // Emit error event
        mockChild.emit('error', new Error('ENOENT: command not found'));

        await vi.advanceTimersByTimeAsync(50);

        expect(finalizeTaskSpy).toHaveBeenCalledWith(
          taskId,
          expect.objectContaining({
            exitCode: -1,
            errorOutput: expect.stringContaining('ENOENT: command not found'),
          })
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
