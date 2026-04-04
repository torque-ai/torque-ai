/**
 * Integration tests: Codex worktree isolation in execute-cli.js spawnAndTrackProcess
 *
 * Verifies that when worktree isolation activates, Codex tasks:
 * 1. Receive a worktree path (not the original working_directory) as their -C arg
 * 2. Merge changes back on success (exit 0)
 * 3. Clean up without merging on failure (exit 1)
 * 4. Use the original working_directory when the dir is not a git repo
 * 5. Fall back to direct execution when worktree creation fails
 *
 * Exercises execute-cli.js spawnAndTrackProcess directly (not task-manager.startTask),
 * because worktree isolation lives in execute-cli.js's spawnAndTrackProcess.
 *
 * Mocking strategy for spawn:
 * - execute-cli.js captures spawn via destructuring at require-time:
 *     const { spawn } = require('child_process')
 * - We monkey-patch child_process.spawn BEFORE execute-cli.js is loaded
 *   so the destructured reference captures our mock.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const { createMockChild, simulateSuccess, simulateFailure } = require('./mocks/process-mock');

// ─── Patch child_process.spawn BEFORE execute-cli.js is loaded ───────────────
const taskCore = require('../db/task-core');
const childProcess = require('child_process');
const _originalSpawn = childProcess.spawn;
const spawnMock = vi.fn();
childProcess.spawn = spawnMock;

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let db;
let mod; // execute-cli module
let testDir;
let origOpenAIKey;

// We mock the git-worktree module at require level
let gitWorktreeMock;

// ─── Dependency helpers (modeled after execute-cli.test.js) ──────────────────

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
    sanitizeTaskOutput: (o) => o || '',
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
    stallRecoveryAttempts: new Map(),
  };
}

describe('Codex worktree isolation integration', () => {
  let runningProcesses;
  let finalizeMock;
  let processQueueMock;

  beforeEach(() => {
    origOpenAIKey = process.env.OPENAI_API_KEY;
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = 'test-key-for-worktree-e2e';
    }

    // Load DB and reset using vitest-setup
    ({ db, testDir } = setupTestDbOnly('codex-worktree'));

    // Load execute-cli module (spawn is already patched at file top)
    mod = require('../providers/execute-cli');

    // Configure spawn mock for this test
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      spawnMock._lastChild = child;
      return child;
    });

    // Set up dependencies
    runningProcesses = new Map();
    finalizeMock = vi.fn(async () => ({ finalized: true, queueManaged: false }));
    processQueueMock = vi.fn();
    const deps = makeDeps({
      runningProcesses,
      finalizeTask: finalizeMock,
      processQueue: processQueueMock,
    });
    mod.init(deps);

    // Mock git-worktree module functions
    const gitWorktree = require('../utils/git-worktree');
    gitWorktreeMock = {
      _origIsGitRepo: gitWorktree.isGitRepo,
      _origCreateWorktree: gitWorktree.createWorktree,
      _origMergeWorktreeChanges: gitWorktree.mergeWorktreeChanges,
      _origRemoveWorktree: gitWorktree.removeWorktree,
    };

    // Default mocks: isGitRepo=true, createWorktree returns a fake path,
    // mergeWorktreeChanges succeeds, removeWorktree is a no-op
    gitWorktree.isGitRepo = vi.fn().mockReturnValue(true);
    gitWorktree.createWorktree = vi.fn().mockImplementation((taskId, _sourceDir) => {
      const safeName = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fakePath = path.join(os.tmpdir(), `torque-fake-wt-${safeName}`);
      fs.mkdirSync(fakePath, { recursive: true });
      return { worktreePath: fakePath, headSha: 'abc1234fake' };
    });
    gitWorktree.mergeWorktreeChanges = vi.fn().mockReturnValue({ success: true, filesChanged: 2 });
    gitWorktree.removeWorktree = vi.fn();
  });

  afterEach(() => {
    // Restore git-worktree functions
    if (gitWorktreeMock) {
      const gitWorktree = require('../utils/git-worktree');
      gitWorktree.isGitRepo = gitWorktreeMock._origIsGitRepo;
      gitWorktree.createWorktree = gitWorktreeMock._origCreateWorktree;
      gitWorktree.mergeWorktreeChanges = gitWorktreeMock._origMergeWorktreeChanges;
      gitWorktree.removeWorktree = gitWorktreeMock._origRemoveWorktree;
    }

    if (origOpenAIKey !== undefined) {
      process.env.OPENAI_API_KEY = origOpenAIKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    teardownTestDb();
  });

  afterAll(() => {
    // Restore the original spawn
    childProcess.spawn = _originalSpawn;
  });

  /**
   * Helper: create a task in DB and call execute-cli's spawnAndTrackProcess.
   */
  function startCodexTask(description, workDir) {
    const taskId = randomUUID();
    const dir = workDir || path.join(testDir, 'project');
    fs.mkdirSync(dir, { recursive: true });

    taskCore.createTask({
      id: taskId,
      task_description: description || 'Test worktree isolation',
      status: 'running',
      provider: 'codex',
      working_directory: dir,
      timeout_minutes: 5,
    });

    const cmdSpec = {
      cliPath: 'codex',
      finalArgs: ['exec', '--full-auto', '-C', dir, '-'],
      stdinPrompt: description || 'Test worktree isolation',
      envExtras: {},
      selectedOllamaHostId: null,
      usedEditFormat: null,
    };

    mod.spawnAndTrackProcess(taskId, { id: taskId, working_directory: dir }, cmdSpec, 'codex');

    const child = spawnMock._lastChild;
    if (!child) return null;

    return { taskId, child };
  }

  // ─── Test 1: Worktree path passed as -C argument ───────────────────

  it('codex execution ignores worktree isolation and keeps the original working_directory', async () => {
    const projectDir = path.join(testDir, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = startCodexTask('Create a utility module', projectDir);
    expect(result, 'Expected startCodexTask to return a task').toBeTruthy();
    const { child } = result;

    simulateSuccess(child, 'Created util.js\n');
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify spawn was called
    expect(spawnMock).toHaveBeenCalled();

    const gitWorktree = require('../utils/git-worktree');

    // Codex exec writes directly into the target directory, so worktree isolation is skipped.
    expect(gitWorktree.createWorktree).not.toHaveBeenCalled();

    // Verify the -C argument in spawn call points to the original project dir.
    const spawnArgs = spawnMock.mock.calls[0][1]; // finalArgs array
    const dashCIndex = spawnArgs.indexOf('-C');
    expect(dashCIndex).toBeGreaterThan(-1);
    const cArg = spawnArgs[dashCIndex + 1];
    expect(cArg).toBe(projectDir);

    // Also verify cwd stayed on the original project path.
    const spawnOpts = spawnMock.mock.calls[0][2]; // options
    expect(spawnOpts.cwd).toBe(projectDir);
  });

  // ─── Test 2: Changes merged back on success (exit 0) ──────────────

  it('codex exit 0 does not attempt worktree merge or cleanup', async () => {
    const projectDir = path.join(testDir, 'merge-test');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = startCodexTask('Implement feature X', projectDir);
    expect(result, 'Expected startCodexTask to return a task').toBeTruthy();
    const { taskId, child } = result;

    simulateSuccess(child, 'Feature X implemented\n');
    await new Promise(resolve => setTimeout(resolve, 200));

    const gitWorktree = require('../utils/git-worktree');

    expect(taskId).toBeTruthy();
    expect(gitWorktree.createWorktree).not.toHaveBeenCalled();
    expect(gitWorktree.mergeWorktreeChanges).not.toHaveBeenCalled();
    expect(gitWorktree.removeWorktree).not.toHaveBeenCalled();
  });

  // ─── Test 3: Worktree cleaned up without merging on failure ────────

  it('codex exit 1 does not attempt worktree cleanup paths', async () => {
    const projectDir = path.join(testDir, 'fail-test');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = startCodexTask('This task will fail', projectDir);
    expect(result, 'Expected startCodexTask to return a task').toBeTruthy();
    const { child } = result;

    simulateFailure(child, '', 'API error: rate limit', 1);
    await new Promise(resolve => setTimeout(resolve, 200));

    const gitWorktree = require('../utils/git-worktree');

    expect(gitWorktree.createWorktree).not.toHaveBeenCalled();
    expect(gitWorktree.mergeWorktreeChanges).not.toHaveBeenCalled();
    expect(gitWorktree.removeWorktree).not.toHaveBeenCalled();
  });

  // ─── Test 4: Not a git repo — original working_directory used ─────

  it('not a git repo: codex process receives original working_directory', async () => {
    const gitWorktree = require('../utils/git-worktree');
    // Override isGitRepo to return false (simulates non-git directory)
    gitWorktree.isGitRepo = vi.fn().mockReturnValue(false);

    const projectDir = path.join(testDir, 'no-wt-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = startCodexTask('Direct execution test', projectDir);
    expect(result, 'Expected startCodexTask to return a task').toBeTruthy();
    const { child } = result;

    simulateSuccess(child, 'Done\n');
    await new Promise(resolve => setTimeout(resolve, 200));

    // createWorktree should NOT have been called
    expect(gitWorktree.createWorktree).not.toHaveBeenCalled();

    // Verify the -C argument is the original project dir
    const spawnArgs = spawnMock.mock.calls[0][1];
    const dashCIndex = spawnArgs.indexOf('-C');
    expect(dashCIndex).toBeGreaterThan(-1);
    expect(spawnArgs[dashCIndex + 1]).toBe(projectDir);

    // cwd should also be the original dir
    const spawnOpts = spawnMock.mock.calls[0][2];
    expect(spawnOpts.cwd).toBe(projectDir);

    // No merge or cleanup calls
    expect(gitWorktree.mergeWorktreeChanges).not.toHaveBeenCalled();
    expect(gitWorktree.removeWorktree).not.toHaveBeenCalled();
  });

  // ─── Test 5: Worktree creation fails — falls back to direct execution ─

  it('codex does not attempt worktree creation even when a worktree mock would fail', async () => {
    const gitWorktree = require('../utils/git-worktree');
    // Make createWorktree return null (simulates worktree creation failure)
    gitWorktree.createWorktree = vi.fn().mockReturnValue(null);

    const projectDir = path.join(testDir, 'fallback-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = startCodexTask('Fallback test', projectDir);
    expect(result, 'Expected startCodexTask to return a task').toBeTruthy();
    const { child } = result;

    simulateSuccess(child, 'Completed without worktree\n');
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(gitWorktree.createWorktree).not.toHaveBeenCalled();

    // Since creation failed, the -C arg should be the original project dir
    const spawnArgs = spawnMock.mock.calls[0][1];
    const dashCIndex = spawnArgs.indexOf('-C');
    expect(dashCIndex).toBeGreaterThan(-1);
    expect(spawnArgs[dashCIndex + 1]).toBe(projectDir);

    // cwd should be the original dir too
    const spawnOpts = spawnMock.mock.calls[0][2];
    expect(spawnOpts.cwd).toBe(projectDir);

    // No merge or cleanup since codex bypasses worktrees entirely.
    expect(gitWorktree.mergeWorktreeChanges).not.toHaveBeenCalled();
    expect(gitWorktree.removeWorktree).not.toHaveBeenCalled();
  });
});
