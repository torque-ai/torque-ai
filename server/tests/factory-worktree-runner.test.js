import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { createWorktreeRunner, sanitizeSlug, resolveSystemShellCommand } = require('../factory/worktree-runner');

function makeWorktreeManagerMock({ listSeed = [] } = {}) {
  const worktrees = [...listSeed];
  return {
    createWorktree: vi.fn((repoPath, featureName, options = {}) => {
      const branch = `feat/${featureName}`;
      const record = {
        id: `id-${worktrees.length + 1}`,
        repo_path: repoPath,
        worktree_path: `${repoPath}/.worktrees/${branch}`,
        branch,
        feature_name: featureName,
        base_branch: options.baseBranch || 'main',
        status: 'active',
      };
      worktrees.push(record);
      return record;
    }),
    listWorktrees: vi.fn(() => [...worktrees]),
    mergeWorktree: vi.fn((id, options = {}) => ({
      merged: true,
      id,
      branch: worktrees.find((w) => w.id === id)?.branch || 'unknown',
      target_branch: options.targetBranch || 'main',
      strategy: options.strategy || 'merge',
      cleaned: options.deleteAfter !== false,
    })),
    cleanupWorktree: vi.fn((id) => ({ id, removed: true })),
  };
}

describe('sanitizeSlug', () => {
  it('produces a lower-case hyphenated slug (truncated at default maxLen=40)', () => {
    expect(sanitizeSlug('Reduce tech debt -- 282 TODOs across codebase')).toBe('reduce-tech-debt-282-todos-across-codeba');
  });

  it('falls back to "work-item" when title is empty', () => {
    expect(sanitizeSlug('')).toBe('work-item');
    expect(sanitizeSlug('   ')).toBe('work-item');
  });

  it('caps length at maxLen', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeSlug(long, 40).length).toBeLessThanOrEqual(40);
  });
});

describe('resolveSystemShellCommand', () => {
  const originalComSpec = process.env.ComSpec;
  afterEach(() => {
    if (originalComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComSpec;
  });

  it('uses process.env.ComSpec on win32 when set', () => {
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    const resolved = resolveSystemShellCommand('win32', 'echo hello');
    expect(resolved.cmd).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(resolved.args).toEqual(['/d', '/s', '/c', 'echo hello']);
  });

  it('falls back to cmd.exe on win32 when ComSpec is unset', () => {
    delete process.env.ComSpec;
    const resolved = resolveSystemShellCommand('win32', 'echo hello');
    expect(resolved.cmd).toBe('cmd.exe');
    expect(resolved.args).toEqual(['/d', '/s', '/c', 'echo hello']);
  });

  it('uses sh on non-windows platforms', () => {
    const resolved = resolveSystemShellCommand('linux', 'echo hello');
    expect(resolved.cmd).toBe('sh');
    expect(resolved.args).toEqual(['-lc', 'echo hello']);
  });
});

describe('createWorktreeRunner.createForBatch', () => {
  let worktreeManager;
  let runner;

  beforeEach(() => {
    worktreeManager = makeWorktreeManagerMock();
    runner = createWorktreeRunner({ worktreeManager, runRemoteVerify: vi.fn() });
  });

  it('creates a worktree with factory-<id>-<slug> feature name', async () => {
    const result = await runner.createForBatch({
      project: { id: 'proj-1', path: 'C:/repo' },
      workItem: { id: 42, title: 'Cover scan-report fallback branches' },
      batchId: 'batch-xyz',
    });
    expect(worktreeManager.createWorktree).toHaveBeenCalledWith(
      'C:/repo',
      'factory-42-cover-scan-report-fallback-branches',
      expect.objectContaining({ baseBranch: 'main' }),
    );
    expect(result.branch).toMatch(/^feat\/factory-42-cover-scan-report-fallback-branches$/);
    expect(result.worktreePath).toContain('.worktrees');
  });

  it('throws without project.path or workItem.id', async () => {
    await expect(runner.createForBatch({ project: {}, workItem: { id: 1 } })).rejects.toThrow(/project.path/);
    await expect(runner.createForBatch({ project: { path: '/x' }, workItem: {} })).rejects.toThrow(/workItem.id/);
  });
});

describe('createWorktreeRunner.verify', () => {
  // Default countCommitsAhead used in tests below — assume the branch has commits.
  // Tests that need to exercise the empty-branch path inject 0 explicitly.
  const nonEmptyCountCommitsAhead = () => 5;

  it('passes when the verify runner returns exit 0', async () => {
    const runRemoteVerify = vi.fn(() => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    const runner = createWorktreeRunner({
      worktreeManager: makeWorktreeManagerMock(),
      runRemoteVerify,
      countCommitsAhead: nonEmptyCountCommitsAhead,
    });
    const result = await runner.verify({
      worktreePath: 'C:/repo/.worktrees/feat/x',
      branch: 'feat/x',
      verifyCommand: 'cd server && npx vitest run',
    });
    expect(result.passed).toBe(true);
    expect(runRemoteVerify).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'feat/x',
      command: 'cd server && npx vitest run',
    }));
  });

  it('fails when runner returns non-zero exit', async () => {
    const runner = createWorktreeRunner({
      worktreeManager: makeWorktreeManagerMock(),
      runRemoteVerify: vi.fn(() => ({ exitCode: 1, stdout: '', stderr: 'boom' })),
      countCommitsAhead: nonEmptyCountCommitsAhead,
    });
    const result = await runner.verify({
      worktreePath: 'C:/wt',
      branch: 'feat/y',
      verifyCommand: 'echo test',
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain('boom');
  });

  it('falls back to local verify when remote sync is unavailable', async () => {
    const runRemoteVerify = vi.fn(() => ({
      exitCode: 1,
      stdout: '',
      stderr: '[push-worktree-branch] fatal: unable to access https://github.com/org/repo.git: Could not resolve host: github.com',
    }));
    const runLocalVerify = vi.fn(() => ({
      exitCode: 0,
      stdout: 'local ok',
      stderr: '',
    }));
    const runner = createWorktreeRunner({
      worktreeManager: makeWorktreeManagerMock(),
      runRemoteVerify,
      runLocalVerify,
      countCommitsAhead: nonEmptyCountCommitsAhead,
    });

    const result = await runner.verify({
      worktreePath: 'C:/wt',
      branch: 'feat/fallback',
      verifyCommand: 'npx vitest run server/tests/factory-worktree-runner.test.js',
    });

    expect(result.passed).toBe(true);
    expect(runRemoteVerify).toHaveBeenCalledTimes(1);
    expect(runLocalVerify).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'feat/fallback',
      command: 'npx vitest run server/tests/factory-worktree-runner.test.js',
      cwd: 'C:/wt',
      fallbackReason: expect.stringContaining('[push-worktree-branch]'),
    }));
    expect(result.output).toContain('local ok');
    expect(result.output).toContain('[fallback-local-verify]');
  });

  it('does not fall back for ordinary verify failures', async () => {
    const runRemoteVerify = vi.fn(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'tests failed',
    }));
    const runLocalVerify = vi.fn();
    const runner = createWorktreeRunner({
      worktreeManager: makeWorktreeManagerMock(),
      runRemoteVerify,
      runLocalVerify,
      countCommitsAhead: nonEmptyCountCommitsAhead,
    });

    const result = await runner.verify({
      worktreePath: 'C:/wt',
      branch: 'feat/fail',
      verifyCommand: 'echo test',
    });

    expect(result.passed).toBe(false);
    expect(runLocalVerify).not.toHaveBeenCalled();
  });

  it('requires branch', async () => {
    const runner = createWorktreeRunner({
      worktreeManager: makeWorktreeManagerMock(),
      runRemoteVerify: vi.fn(),
      countCommitsAhead: nonEmptyCountCommitsAhead,
    });
    await expect(runner.verify({ verifyCommand: 'x' })).rejects.toThrow(/branch/);
  });

  it('skips remote verify and returns empty_branch when branch has zero commits ahead of base', async () => {
    const runRemoteVerify = vi.fn();
    const runLocalVerify = vi.fn();
    const countCommitsAhead = vi.fn(() => 0);
    const runner = createWorktreeRunner({
      worktreeManager: makeWorktreeManagerMock(),
      runRemoteVerify,
      runLocalVerify,
      countCommitsAhead,
    });
    const result = await runner.verify({
      worktreePath: 'C:/wt',
      branch: 'feat/empty',
      verifyCommand: 'echo test',
      baseBranch: 'main',
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('empty_branch');
    expect(result.output).toMatch(/no commits ahead of main/);
    expect(runRemoteVerify).not.toHaveBeenCalled();
    expect(runLocalVerify).not.toHaveBeenCalled();
    expect(countCommitsAhead).toHaveBeenCalledWith({
      cwd: 'C:/wt',
      baseBranch: 'main',
      branch: 'feat/empty',
    });
  });

  it('runs remote verify normally when branch has commits ahead of base', async () => {
    const runRemoteVerify = vi.fn(() => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    const countCommitsAhead = vi.fn(() => 3);
    const runner = createWorktreeRunner({
      worktreeManager: makeWorktreeManagerMock(),
      runRemoteVerify,
      countCommitsAhead,
    });
    const result = await runner.verify({
      worktreePath: 'C:/wt',
      branch: 'feat/has-commits',
      verifyCommand: 'echo test',
    });
    expect(result.passed).toBe(true);
    expect(runRemoteVerify).toHaveBeenCalledTimes(1);
  });
});

describe('createWorktreeRunner.mergeToMain', () => {
  it('merges by id', async () => {
    const worktreeManager = makeWorktreeManagerMock();
    const runner = createWorktreeRunner({ worktreeManager, runRemoteVerify: vi.fn() });
    const res = await runner.mergeToMain({ id: 'id-123', branch: 'feat/x' });
    expect(worktreeManager.mergeWorktree).toHaveBeenCalledWith('id-123', expect.objectContaining({
      strategy: 'merge',
      targetBranch: 'main',
      deleteAfter: true,
    }));
    expect(res.merged).toBe(true);
  });

  it('resolves id from branch when only branch is given', async () => {
    const worktreeManager = makeWorktreeManagerMock({
      listSeed: [{ id: 'id-99', branch: 'feat/factory-7-foo', worktree_path: '/x' }],
    });
    const runner = createWorktreeRunner({ worktreeManager, runRemoteVerify: vi.fn() });
    const res = await runner.mergeToMain({ branch: 'feat/factory-7-foo' });
    expect(worktreeManager.mergeWorktree).toHaveBeenCalledWith('id-99', expect.anything());
    expect(res.branch).toBe('feat/factory-7-foo');
  });
});

describe('createWorktreeRunner.abandon', () => {
  it('calls cleanupWorktree with deleteBranch true', async () => {
    const worktreeManager = makeWorktreeManagerMock({
      listSeed: [{ id: 'id-5', branch: 'feat/factory-5-x', worktree_path: '/y' }],
    });
    const runner = createWorktreeRunner({ worktreeManager, runRemoteVerify: vi.fn() });
    await runner.abandon({ branch: 'feat/factory-5-x', reason: 'verify_failed' });
    expect(worktreeManager.cleanupWorktree).toHaveBeenCalledWith('id-5', expect.objectContaining({
      deleteBranch: true,
      force: true,
    }));
  });

  it('returns null silently when branch not found', async () => {
    const worktreeManager = makeWorktreeManagerMock();
    const runner = createWorktreeRunner({ worktreeManager, runRemoteVerify: vi.fn() });
    const res = await runner.abandon({ branch: 'feat/missing' });
    expect(res).toBeNull();
    expect(worktreeManager.cleanupWorktree).not.toHaveBeenCalled();
  });
});
