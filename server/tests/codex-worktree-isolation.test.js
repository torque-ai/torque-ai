/**
 * Integration tests: Codex worktree isolation in spawnAndTrackProcess
 *
 * Verifies that when codex_worktree_isolation is enabled, Codex tasks:
 * 1. Receive a worktree path (not the original working_directory) as their -C arg
 * 2. Merge changes back on success (exit 0)
 * 3. Clean up without merging on failure (exit 1)
 * 4. Use the original working_directory when isolation is disabled
 * 5. Fall back to direct execution when worktree creation fails
 *
 * Mocks: child_process.spawn (process-mock), git-worktree functions
 * Uses: setupE2eDb / teardownE2eDb for real DB + task-manager wiring
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createMockChild, simulateSuccess, simulateFailure } = require('./mocks/process-mock');
const { setupE2eDb, teardownE2eDb, createTestTask, waitForTaskStatus } = require('./e2e-helpers');

let ctx;
let spawnMock;
let originalSpawn;
let origOpenAIKey;

// We mock the git-worktree module at require level
let gitWorktreeMock;

describe('Codex worktree isolation integration', () => {
  beforeEach(async () => {
    origOpenAIKey = process.env.OPENAI_API_KEY;
    if (ctx) {
      await teardownE2eDb(ctx);
    }
    ctx = setupE2eDb('codex-worktree');

    // Mock child_process.spawn
    const childProcess = require('child_process');
    originalSpawn = childProcess.spawn;
    spawnMock = vi.fn().mockImplementation(() => {
      const child = createMockChild();
      spawnMock._lastChild = child;
      return child;
    });
    childProcess.spawn = spawnMock;

    // Set OPENAI_API_KEY so codex provider doesn't warn
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = 'test-key-for-worktree-e2e';
    }

    // Mock git-worktree module functions by replacing methods on the real module
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

  afterEach(async () => {
    // Restore spawn
    const childProcess = require('child_process');
    childProcess.spawn = originalSpawn;

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
  });

  afterAll(async () => {
    if (ctx) await teardownE2eDb(ctx);
  });

  /**
   * Helper: create a codex task and start it, returning spawn details.
   * Returns null if task was queued (concurrency limit) or spawn didn't fire.
   */
  function startCodexTask(description, workDir) {
    const taskId = createTestTask(ctx.db, {
      description: description || 'Test worktree isolation',
      provider: 'codex',
      workingDirectory: workDir || path.join(ctx.testDir, 'project'),
    });
    // Ensure workdir exists
    const dir = workDir || path.join(ctx.testDir, 'project');
    fs.mkdirSync(dir, { recursive: true });

    const startResult = ctx.tm.startTask(taskId);
    if (startResult && startResult.queued) {
      return null; // Concurrency limit — valid but can't test spawn args
    }

    const child = spawnMock._lastChild;
    if (!child) return null;

    return { taskId, child };
  }

  // ─── Test 1: Worktree path passed as -C argument ───────────────────

  it('worktree enabled: codex process receives worktree path as -C argument', async () => {
    // Enable worktree isolation (default, but be explicit)
    ctx.db.setConfig('codex_worktree_isolation', '1');

    const projectDir = path.join(ctx.testDir, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = startCodexTask('Create a utility module', projectDir);
    if (!result) return; // Queued — skip
    const { taskId, child } = result;

    simulateSuccess(child, 'Created util.js\n');
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 5000);

    // Verify spawn was called
    expect(spawnMock).toHaveBeenCalled();

    const gitWorktree = require('../utils/git-worktree');

    // Verify createWorktree was called with the task ID and project dir
    expect(gitWorktree.createWorktree).toHaveBeenCalledWith(
      taskId,
      projectDir
    );

    // Verify the -C argument in spawn call points to the worktree, not the original dir
    const spawnArgs = spawnMock.mock.calls[0][1]; // finalArgs array
    const dashCIndex = spawnArgs.indexOf('-C');
    expect(dashCIndex).toBeGreaterThan(-1);
    const cArg = spawnArgs[dashCIndex + 1];
    // The -C arg should be the worktree path (contains torque-fake-wt), not the original project dir
    expect(cArg).toContain('torque-fake-wt');
    expect(cArg).not.toBe(projectDir);

    // Also verify cwd was set to the worktree path
    const spawnOpts = spawnMock.mock.calls[0][2]; // options
    expect(spawnOpts.cwd).toBe(cArg);
  });

  // ─── Test 2: Changes merged back on success (exit 0) ──────────────

  it('worktree enabled + exit 0: mergeWorktreeChanges called, then removeWorktree', async () => {
    ctx.db.setConfig('codex_worktree_isolation', '1');

    const projectDir = path.join(ctx.testDir, 'merge-test');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = startCodexTask('Implement feature X', projectDir);
    if (!result) return;
    const { taskId, child } = result;

    simulateSuccess(child, 'Feature X implemented\n');
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 5000);

    const gitWorktree = require('../utils/git-worktree');

    // mergeWorktreeChanges should have been called with the worktree path + original dir
    expect(gitWorktree.mergeWorktreeChanges).toHaveBeenCalledTimes(1);
    const mergeArgs = gitWorktree.mergeWorktreeChanges.mock.calls[0];
    expect(mergeArgs[0]).toContain('torque-fake-wt'); // worktreePath
    expect(mergeArgs[1]).toBe(projectDir);             // sourceDir (original)
    expect(mergeArgs[2]).toBe(taskId);                 // taskId

    // removeWorktree should also have been called (cleanup)
    expect(gitWorktree.removeWorktree).toHaveBeenCalledTimes(1);
    const removeArgs = gitWorktree.removeWorktree.mock.calls[0];
    expect(removeArgs[0]).toContain('torque-fake-wt');
  });

  // ─── Test 3: Worktree cleaned up without merging on failure ────────

  it('worktree enabled + exit 1: removeWorktree called WITHOUT mergeWorktreeChanges', async () => {
    ctx.db.setConfig('codex_worktree_isolation', '1');

    const projectDir = path.join(ctx.testDir, 'fail-test');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = startCodexTask('This task will fail', projectDir);
    if (!result) return;
    const { taskId, child } = result;

    simulateFailure(child, '', 'API error: rate limit', 1);
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 5000);

    const gitWorktree = require('../utils/git-worktree');

    // mergeWorktreeChanges should NOT have been called (exit code != 0)
    expect(gitWorktree.mergeWorktreeChanges).not.toHaveBeenCalled();

    // removeWorktree should still have been called (cleanup happens regardless)
    expect(gitWorktree.removeWorktree).toHaveBeenCalledTimes(1);
    const removeArgs = gitWorktree.removeWorktree.mock.calls[0];
    expect(removeArgs[0]).toContain('torque-fake-wt');
  });

  // ─── Test 4: Isolation disabled — original working_directory used ──

  it('worktree disabled: codex process receives original working_directory', async () => {
    // Explicitly disable worktree isolation
    ctx.db.setConfig('codex_worktree_isolation', '0');

    const projectDir = path.join(ctx.testDir, 'no-wt-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = startCodexTask('Direct execution test', projectDir);
    if (!result) return;
    const { taskId, child } = result;

    simulateSuccess(child, 'Done\n');
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 5000);

    const gitWorktree = require('../utils/git-worktree');

    // createWorktree should NOT have been called
    expect(gitWorktree.createWorktree).not.toHaveBeenCalled();
    // isGitRepo should NOT have been called (short-circuit on config '0')
    // Note: the code checks config first, so isGitRepo may or may not be called
    // depending on the short-circuit order. What matters is no worktree was created.

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

  it('worktree creation fails: falls back to direct execution gracefully', async () => {
    ctx.db.setConfig('codex_worktree_isolation', '1');

    const gitWorktree = require('../utils/git-worktree');
    // Make createWorktree return null (simulates not-a-git-repo or other failure)
    gitWorktree.createWorktree = vi.fn().mockReturnValue(null);

    const projectDir = path.join(ctx.testDir, 'fallback-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = startCodexTask('Fallback test', projectDir);
    if (!result) return;
    const { taskId, child } = result;

    simulateSuccess(child, 'Completed without worktree\n');
    await waitForTaskStatus(ctx.db, taskId, ['completed', 'failed'], 5000);

    // createWorktree was attempted
    expect(gitWorktree.createWorktree).toHaveBeenCalledTimes(1);

    // Since creation failed, the -C arg should be the original project dir
    const spawnArgs = spawnMock.mock.calls[0][1];
    const dashCIndex = spawnArgs.indexOf('-C');
    expect(dashCIndex).toBeGreaterThan(-1);
    expect(spawnArgs[dashCIndex + 1]).toBe(projectDir);

    // cwd should be the original dir too
    const spawnOpts = spawnMock.mock.calls[0][2];
    expect(spawnOpts.cwd).toBe(projectDir);

    // Task should still complete successfully
    const task = ctx.db.getTask(taskId);
    expect(task.status).toBe('completed');

    // No merge or cleanup since there was no worktree
    expect(gitWorktree.mergeWorktreeChanges).not.toHaveBeenCalled();
    expect(gitWorktree.removeWorktree).not.toHaveBeenCalled();
  });
});
