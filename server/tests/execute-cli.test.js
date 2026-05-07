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
const fs = require('fs');
const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const hostManagement = require('../db/host/management');
const { TEST_MODELS } = require('./test-helpers');

let testDir;
let db;
let taskCore;
let configCore;
let mod;
let spawnMock;
let originalSpawn;

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
    getEffectiveModel: (task) => task.model || TEST_MODELS.SMALL,
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
    finalizingTasks: overrides.finalizingTasks || new Map(),
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
  // Patch child_process.spawn BEFORE loading execute-cli.js
  // so the destructured `spawn` variable inside the module captures our mock
  const cp = require('child_process');
  originalSpawn = cp.spawn;
  spawnMock = vi.fn();
  cp.spawn = spawnMock;

  ({ db, testDir } = setupTestDbOnly('exec-cli'));
  taskCore = require('../db/task-core');
  configCore = require('../db/config-core');
  mod = require('../providers/execute-cli');
}

function teardown() {
  // Restore original spawn
  if (originalSpawn) {
    const cp = require('child_process');
    cp.spawn = originalSpawn;
  }
  teardownTestDb();
}

function clearHosts() {
  for (const host of hostManagement.listOllamaHosts()) {
    hostManagement.removeOllamaHost(host.id);
  }
}

function resetConfigs() {
  configCore.setConfig('proactive_format_selection_enabled', '0');
  configCore.setConfig('ollama_model_settings', '');
  configCore.setConfig('ollama_host', 'http://localhost:11434');
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

    it('disables Codex Windows sandbox feature flags on Windows', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Test',
        auto_approve: 0,
      };
      const result = mod.buildCodexCommand(task, '', null);

      if (process.platform === 'win32') {
        expect(result.finalArgs).toContain('experimental_windows_sandbox');
        expect(result.finalArgs).toContain('elevated_windows_sandbox');
      } else {
        expect(result.finalArgs).not.toContain('experimental_windows_sandbox');
        expect(result.finalArgs).not.toContain('elevated_windows_sandbox');
      }
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

      expect(result.cliPath).toBe(basePath);
    });

    it('returns envExtras and null selectedOllamaHostId', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Test',
      };
      const result = mod.buildCodexCommand(task, '', null);
      // On Windows, buildCodexCommand may populate envExtras with native-codex
      // launch metadata (CODEX_MANAGED_BY_NPM, __TORQUE_CODEX_VENDOR_PATH) when
      // it resolves the bundled codex.exe. On non-Windows or when the resolver
      // fails, envExtras is {}.
      expect(result.envExtras).toBeTypeOf('object');
      expect(result.envExtras).not.toBeNull();
      expect(result.selectedOllamaHostId).toBeNull();
      expect(result.usedEditFormat).toBeNull();
    });

    it('forces reasoning_effort=high for factory-internal tasks', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'You are the Architect...',
        metadata: { factory_internal: true, kind: 'architect_cycle' },
      };
      const result = mod.buildCodexCommand(task, '', null);
      const idx = result.finalArgs.indexOf('-c');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(result.finalArgs[idx + 1]).toBe('model_reasoning_effort=high');
    });

    it('uses low reasoning_effort for short structured factory repair tasks', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Rewrite rejected work item as JSON',
        metadata: { factory_internal: true, kind: 'replan_rewrite' },
      };
      const result = mod.buildCodexCommand(task, '', null);
      const idx = result.finalArgs.indexOf('-c');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(result.finalArgs[idx + 1]).toBe('model_reasoning_effort=low');
      expect(result.finalArgs).not.toContain('model_reasoning_effort=high');
    });

    it('parses metadata when stored as JSON string', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'You are a codebase analyst...',
        metadata: JSON.stringify({ factory_internal: true, kind: 'scout' }),
      };
      const result = mod.buildCodexCommand(task, '', null);
      expect(result.finalArgs).toContain('model_reasoning_effort=high');
    });

    it('forces reasoning_effort=high for generic scout tasks (mode=scout)', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'You are a codebase analyst...',
        metadata: { mode: 'scout', diffusion: true, reason: 'manual_diffusion' },
      };
      const result = mod.buildCodexCommand(task, '', null);
      const idx = result.finalArgs.findIndex(a => a === 'model_reasoning_effort=high');
      expect(idx).toBeGreaterThanOrEqual(0);
    });

    it('uses low reasoning_effort for bounded starvation recovery scouts', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'You are a bounded work-item scout...',
        metadata: { mode: 'scout', diffusion: true, reason: 'factory_starvation_recovery' },
      };
      const result = mod.buildCodexCommand(task, '', null);
      expect(result.finalArgs).toContain('model_reasoning_effort=low');
      expect(result.finalArgs).not.toContain('model_reasoning_effort=high');
    });

    it('does NOT override reasoning_effort for non-factory tasks', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Plan: implement feature X',
        metadata: { kind: 'work_item_execute' },
      };
      const result = mod.buildCodexCommand(task, '', null);
      expect(result.finalArgs.some(a => typeof a === 'string' && a.startsWith('model_reasoning_effort='))).toBe(false);
    });

    it('does NOT override reasoning_effort when metadata is null/missing', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Test',
      };
      const result = mod.buildCodexCommand(task, '', null);
      expect(result.finalArgs.some(a => typeof a === 'string' && a.startsWith('model_reasoning_effort='))).toBe(false);
    });

    it('does NOT override when metadata JSON is malformed', () => {
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Test',
        metadata: '{not valid json',
      };
      const result = mod.buildCodexCommand(task, '', null);
      expect(result.finalArgs.some(a => typeof a === 'string' && a.startsWith('model_reasoning_effort='))).toBe(false);
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
    const { createMockChild, simulateSuccess, simulateFailure } = require('./mocks/process-mock');
    // These tests drive execute-cli.spawnAndTrackProcess's legacy pipe-path
    // body (the inline branch that the dispatch helper short-circuits past
    // when the detachment flag is on). Phase G's default-on flip routes
    // codex / codex-spark / claude-cli through the wrapper-spawn path
    // instead, which doesn't use the mocked child_process.spawn the same
    // way these tests assume. Pin the flag off so the suite keeps testing
    // the legacy pipe path that's still in execute-cli.js. When Phase H
    // proper deletes the legacy pipe-path body, this describe block can
    // either be deleted or migrated to test the detached path.
    const ORIG_DETACH_FLAG = process.env.TORQUE_DETACHED_SUBPROCESSES;
    beforeAll(() => { process.env.TORQUE_DETACHED_SUBPROCESSES = '0'; });
    afterAll(() => {
      if (ORIG_DETACH_FLAG === undefined) delete process.env.TORQUE_DETACHED_SUBPROCESSES;
      else process.env.TORQUE_DETACHED_SUBPROCESSES = ORIG_DETACH_FLAG;
    });

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
      taskCore.createTask({
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
      taskCore.createTask({
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
      taskCore.createTask({
        id: taskId,
        task_description: 'CWD test',
        status: 'running',
        provider: 'claude-cli',
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

      mod.spawnAndTrackProcess(taskId, { id: taskId, working_directory: testDir }, cmdSpec, 'claude-cli');

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
      taskCore.createTask({
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
      taskCore.createTask({
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
      taskCore.createTask({
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
        expect(deps.dashboard.notifyTaskOutput).toHaveBeenCalledWith(taskId, expect.objectContaining({
          content: 'Warning: something',
          type: 'stderr',
          chunk_type: 'stderr',
          isStderr: true,
        }));
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
      taskCore.createTask({
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
      taskCore.createTask({
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
      taskCore.createTask({
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

        // EXIT_SPAWN_ERROR (-103) is the dedicated sentinel for child 'error'
        // events (ENOENT / EACCES / etc.), distinct from the generic -1.
        expect(finalizeTaskSpy).toHaveBeenCalledWith(
          taskId,
          expect.objectContaining({
            exitCode: -103,
            errorOutput: expect.stringContaining('ENOENT: command not found'),
          })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('annotates errorOutput with structured [process-exit] line on non-zero exit', async () => {
      // Regression for task 65072ba9-6b7b-4886-937b-d6fb665db468 (2026-05-03):
      // codex CLI exited 1 after 135s but error_output stored only the
      // prompt-echo + a few exec lines, with no record of when or why it
      // ended. Ensure the close handler always tags failed tasks with a
      // structured exit summary (code/signal/duration/provider) so future
      // diagnostics don't have to reconstruct timing from the factory log.
      const mockChild = createMockChild();
      spawnMock.mockReturnValue(mockChild);

      const finalizeTaskSpy = vi.fn(async () => ({ finalized: true, queueManaged: false }));
      const deps = makeDeps({ runningProcesses: new Map(), finalizeTask: finalizeTaskSpy });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Process exit annotation test',
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
      simulateFailure(mockChild, '', 'codex CLI banner only', 1, 5);
      await new Promise((r) => setTimeout(r, 50));

      expect(finalizeTaskSpy).toHaveBeenCalled();
      const finalizeArgs = finalizeTaskSpy.mock.calls[0][1];
      expect(finalizeArgs.exitCode).toBe(1);
      expect(finalizeArgs.errorOutput).toMatch(/\[process-exit\] /);
      expect(finalizeArgs.errorOutput).toMatch(/code=1\b/);
      expect(finalizeArgs.errorOutput).toMatch(/signal=none\b/);
      expect(finalizeArgs.errorOutput).toMatch(/duration_ms=\d+/);
      expect(finalizeArgs.errorOutput).toMatch(/provider=codex\b/);
      // Original captured stderr should still be present before the suffix
      expect(finalizeArgs.errorOutput).toContain('codex CLI banner only');
    });

    it('does NOT add the [process-exit] line on a clean exit (code 0)', async () => {
      const mockChild = createMockChild();
      spawnMock.mockReturnValue(mockChild);

      const finalizeTaskSpy = vi.fn(async () => ({ finalized: true, queueManaged: false }));
      const deps = makeDeps({ runningProcesses: new Map(), finalizeTask: finalizeTaskSpy });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Clean exit no annotation',
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
      simulateSuccess(mockChild, 'all good', 5);
      await new Promise((r) => setTimeout(r, 50));

      expect(finalizeTaskSpy).toHaveBeenCalled();
      const finalizeArgs = finalizeTaskSpy.mock.calls[0][1];
      expect(finalizeArgs.exitCode).toBe(0);
      expect(finalizeArgs.errorOutput || '').not.toMatch(/\[process-exit\]/);
    });

    it('flushes detached log bytes before finalizing the task output', async () => {
      const logDir = path.join(testDir, 'detached-flush');
      fs.mkdirSync(logDir, { recursive: true });
      const stdoutPath = path.join(logDir, 'stdout.log');
      const stderrPath = path.join(logDir, 'stderr.log');
      fs.writeFileSync(stdoutPath, '# Captured Plan\n**Source:** auto-generated from work_item #999\n\n## Task 1: Do the focused work\n', 'utf8');
      fs.writeFileSync(stderrPath, '[process-exit] code=0 signal=none duration_ms=25 provider=codex\n', 'utf8');

      const runningProcesses = new Map();
      const finalizeTaskSpy = vi.fn(async () => ({ finalized: true, queueManaged: false }));
      const deps = makeDeps({ runningProcesses, finalizeTask: finalizeTaskSpy });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Detached flush test',
        status: 'running',
        provider: 'codex',
        working_directory: testDir,
      });
      runningProcesses.set(taskId, {
        output: '',
        errorOutput: '',
        outputLogPath: stdoutPath,
        errorLogPath: stderrPath,
        outputLogOffset: 0,
        errorLogOffset: 0,
        outputTail: { stop: vi.fn() },
        errorTail: { stop: vi.fn() },
        provider: 'codex',
        model: 'gpt-5.5',
        startTime: Date.now(),
        completionDetected: false,
      });

      await mod.finalizeDetachedTask({
        taskId,
        task: { id: taskId, task_description: 'Detached flush test' },
        provider: 'codex',
        isCodexProvider: false,
      });

      expect(finalizeTaskSpy).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          exitCode: 0,
          output: expect.stringContaining('# Captured Plan'),
          errorOutput: expect.stringContaining('[process-exit] code=0'),
        })
      );
      expect(runningProcesses.has(taskId)).toBe(false);
    });

    it('marks detached tasks as finalizing while process tracking is removed', async () => {
      const logDir = path.join(testDir, 'detached-finalizing-marker');
      fs.mkdirSync(logDir, { recursive: true });
      const stdoutPath = path.join(logDir, 'stdout.log');
      const stderrPath = path.join(logDir, 'stderr.log');
      fs.writeFileSync(stdoutPath, 'done\n', 'utf8');
      fs.writeFileSync(stderrPath, '[process-exit] code=0 signal=none duration_ms=25 provider=codex\n', 'utf8');

      const runningProcesses = new Map();
      const finalizingTasks = new Map();
      let resolveFinalize;
      const finalizeTaskSpy = vi.fn(() => new Promise((resolve) => {
        resolveFinalize = () => resolve({ finalized: true, queueManaged: false });
      }));
      const deps = makeDeps({ runningProcesses, finalizingTasks, finalizeTask: finalizeTaskSpy });
      mod.init(deps);

      const taskId = randomUUID();
      taskCore.createTask({
        id: taskId,
        task_description: 'Detached finalizing marker test',
        status: 'running',
        provider: 'codex',
        working_directory: testDir,
      });
      runningProcesses.set(taskId, {
        output: '',
        errorOutput: '',
        outputLogPath: stdoutPath,
        errorLogPath: stderrPath,
        outputLogOffset: 0,
        errorLogOffset: 0,
        outputTail: { stop: vi.fn() },
        errorTail: { stop: vi.fn() },
        provider: 'codex',
        model: 'gpt-5.5',
        startTime: Date.now(),
        completionDetected: false,
      });

      const finalizing = mod.finalizeDetachedTask({
        taskId,
        task: { id: taskId, task_description: 'Detached finalizing marker test' },
        provider: 'codex',
        isCodexProvider: false,
      });
      await vi.waitFor(() => expect(finalizeTaskSpy).toHaveBeenCalled());

      expect(runningProcesses.has(taskId)).toBe(false);
      expect(finalizingTasks.get(taskId)).toEqual(expect.objectContaining({
        stage: 'detached_finalize:finalize_task',
        provider: 'codex',
      }));
      const finalizeOptions = finalizeTaskSpy.mock.calls[0][1];
      expect(finalizeOptions.finalizationHeartbeat).toEqual(expect.any(Function));

      finalizeOptions.finalizationHeartbeat('test:heartbeat');
      expect(finalizingTasks.get(taskId)).toEqual(expect.objectContaining({
        stage: 'test:heartbeat',
      }));

      resolveFinalize();
      await finalizing;

      expect(finalizingTasks.has(taskId)).toBe(false);
    });
  });

  // ── processStderrChunk: codex banner classification ─────────────
  // Regression for the bug where a `/m` regex with `\s*$` matched any
  // chunk containing a blank line as banner-only, which froze
  // proc.lastOutputAt at spawn time for every codex task on the
  // detached spawn path. The dashboard's last_output_at then never
  // advanced even while codex wrote tens of KB of tool traces.
  describe('processStderrChunk codex banner classification', () => {
    function setupProc({ provider = 'codex', initialLastOutputAt = 1000 } = {}) {
      const runningProcesses = new Map();
      const deps = makeDeps({ runningProcesses });
      mod.init(deps);
      const taskId = 'banner-test';
      runningProcesses.set(taskId, {
        process: null,
        output: '',
        errorOutput: '',
        startTime: Date.now() - 10_000,
        lastOutputAt: initialLastOutputAt,
        provider,
        model: 'codex',
        startupTimeoutHandle: null,
        completionDetected: false,
        completionGraceHandle: null,
        lastProgress: 0,
        streamErrorCount: 0,
        streamErrorWarned: false,
      });
      return { runningProcesses, taskId };
    }

    it('does NOT advance lastOutputAt for pure banner chunks', () => {
      const { runningProcesses, taskId } = setupProc({ initialLastOutputAt: 1000 });
      const before = runningProcesses.get(taskId).lastOutputAt;
      const bannerChunk = [
        'OpenAI Codex',
        '----',
        'workdir: /repo',
        'model: gpt-5-codex',
        'provider: codex',
        '',
      ].join('\n');
      mod.processStderrChunk(taskId, bannerChunk, 'stream-1');
      expect(runningProcesses.get(taskId).lastOutputAt).toBe(before);
    });

    it('DOES advance lastOutputAt for mixed banner + real-content chunks', () => {
      const { runningProcesses, taskId } = setupProc({ initialLastOutputAt: 1000 });
      const before = runningProcesses.get(taskId).lastOutputAt;
      // The bug: this chunk contains a banner-pattern line ("model: ...") AND
      // a real-content line ("exec rg ..."). The buggy /m regex matched the
      // banner line and froze lastOutputAt. The fixed `every()` logic sees
      // the non-matching exec line and correctly classifies the chunk as
      // active output.
      const mixedChunk = [
        'model: gpt-5-codex',
        'exec rg --files docs',
        '',
      ].join('\n');
      mod.processStderrChunk(taskId, mixedChunk, 'stream-1');
      expect(runningProcesses.get(taskId).lastOutputAt).toBeGreaterThan(before);
    });

    it('DOES advance lastOutputAt for pure non-banner chunks', () => {
      const { runningProcesses, taskId } = setupProc({ initialLastOutputAt: 1000 });
      const before = runningProcesses.get(taskId).lastOutputAt;
      mod.processStderrChunk(taskId, 'exec rg --files docs\n', 'stream-1');
      expect(runningProcesses.get(taskId).lastOutputAt).toBeGreaterThan(before);
    });

    it('always advances lastOutputAt for non-codex providers', () => {
      const { runningProcesses, taskId } = setupProc({ provider: 'claude-cli', initialLastOutputAt: 1000 });
      const before = runningProcesses.get(taskId).lastOutputAt;
      mod.processStderrChunk(taskId, 'OpenAI Codex\nworkdir: /repo\n', 'stream-1');
      expect(runningProcesses.get(taskId).lastOutputAt).toBeGreaterThan(before);
    });

    it('ignores tail chunks after detached tracker processing is stopped', () => {
      const { runningProcesses, taskId } = setupProc({ initialLastOutputAt: 1000 });
      const proc = runningProcesses.get(taskId);
      proc.stopTailProcessing = true;

      mod.processStdoutChunk(taskId, 'stdout after cancellation\n', 'stream-1');
      mod.processStderrChunk(taskId, 'stderr after cancellation\n', 'stream-1');

      expect(proc.output).toBe('');
      expect(proc.errorOutput).toBe('');
      expect(proc.lastOutputAt).toBe(1000);
    });
  });

  // ── resolveReAdoptLastOutputAt: stall-clock preservation ────────
  // Regression for the bug where reAdoptDetachedSubprocess set
  // proc.lastOutputAt = Date.now() unconditionally, resetting the stall
  // clock on every server restart. With multiple restarts in a day this
  // effectively defeated stall recovery for long-running codex tasks —
  // a task could go 12+ hours of cycle between server restarts and never
  // be flagged stalled.
  describe('resolveReAdoptLastOutputAt', () => {
    it('returns persisted last_activity_at as ms epoch when valid', () => {
      const persistedIso = '2026-05-06T07:30:00.000Z';
      const result = mod.resolveReAdoptLastOutputAt({ last_activity_at: persistedIso });
      expect(result).toBe(new Date(persistedIso).getTime());
    });

    it('falls back to Date.now() when last_activity_at is missing', () => {
      const before = Date.now();
      const result = mod.resolveReAdoptLastOutputAt({ /* no last_activity_at */ });
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });

    it('falls back to Date.now() when last_activity_at is unparseable', () => {
      const before = Date.now();
      const result = mod.resolveReAdoptLastOutputAt({ last_activity_at: 'not-a-timestamp' });
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });

    it('falls back to Date.now() when persistedTask is null', () => {
      const before = Date.now();
      const result = mod.resolveReAdoptLastOutputAt(null);
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });

    it('preserves a 30-minute-old timestamp (proves stall clock is NOT reset)', () => {
      // The genuine bug scenario: task was last active 30 min ago,
      // server restarted, re-adoption fires. With the bug, lastOutputAt
      // would jump to Date.now(); the fix preserves the 30-min-old time
      // so the activity-monitoring stall threshold trips immediately.
      const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
      const result = mod.resolveReAdoptLastOutputAt({
        last_activity_at: new Date(thirtyMinutesAgo).toISOString(),
      });
      const ageMs = Date.now() - result;
      expect(ageMs).toBeGreaterThanOrEqual(29 * 60 * 1000);
      expect(ageMs).toBeLessThanOrEqual(31 * 60 * 1000);
    });
  });

  // ── resolveReAdoptCompletionDetectedAt: completion-flag persistence ──
  // Closes subprocess-detachment.md open question #6. After
  // process-streams.js arms the completion grace window for a task, it
  // persists the moment to tasks.completion_detected_at. On restart,
  // re-adoption restores both the boolean flag (presence implies true)
  // and the timestamp so the grace-window math is computed against the
  // original detection moment rather than the re-adoption moment.
  describe('resolveReAdoptCompletionDetectedAt', () => {
    it('returns ms-epoch number when completion_detected_at is a valid ISO timestamp', () => {
      const persistedIso = '2026-05-07T10:15:00.000Z';
      const result = mod.resolveReAdoptCompletionDetectedAt({ completion_detected_at: persistedIso });
      expect(result).toBe(Date.parse(persistedIso));
    });

    it('returns null when completion_detected_at is missing (start cold)', () => {
      expect(mod.resolveReAdoptCompletionDetectedAt({ /* unset */ })).toBeNull();
    });

    it('returns null when persistedTask is null', () => {
      expect(mod.resolveReAdoptCompletionDetectedAt(null)).toBeNull();
    });

    it('returns null when completion_detected_at is empty string', () => {
      expect(mod.resolveReAdoptCompletionDetectedAt({ completion_detected_at: '' })).toBeNull();
    });

    it('returns null when completion_detected_at is unparseable', () => {
      expect(mod.resolveReAdoptCompletionDetectedAt({ completion_detected_at: 'garbage' })).toBeNull();
    });

    it('preserves a 5-minute-old detection timestamp across restart', () => {
      // The genuine scenario: task detected completion 5 min ago, grace
      // window is 30s/60s, server restarted. With the persistence:
      // re-adoption gets the 5-min-old timestamp → grace window has
      // long since elapsed, so the next completion check force-stops
      // immediately rather than re-arming a fresh 30s window.
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      const result = mod.resolveReAdoptCompletionDetectedAt({
        completion_detected_at: new Date(fiveMinAgo).toISOString(),
      });
      expect(result).toBeCloseTo(fiveMinAgo, -2); // within 100ms
    });
  });
});
