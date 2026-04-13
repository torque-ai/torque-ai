import { describe, it, expect, beforeEach, vi } from 'vitest';

const { createWorktreeRunner, sanitizeSlug } = require('../factory/worktree-runner');

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
  it('produces a lower-case hyphenated slug', () => {
    expect(sanitizeSlug('Reduce tech debt -- 282 TODOs across codebase')).toBe('reduce-tech-debt-282-todos-across-codebase');
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
  it('passes when the verify runner returns exit 0', async () => {
    const runRemoteVerify = vi.fn(() => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    const runner = createWorktreeRunner({
      worktreeManager: makeWorktreeManagerMock(),
      runRemoteVerify,
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
    });
    const result = await runner.verify({
      worktreePath: 'C:/wt',
      branch: 'feat/y',
      verifyCommand: 'echo test',
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain('boom');
  });

  it('requires branch', async () => {
    const runner = createWorktreeRunner({
      worktreeManager: makeWorktreeManagerMock(),
      runRemoteVerify: vi.fn(),
    });
    await expect(runner.verify({ verifyCommand: 'x' })).rejects.toThrow(/branch/);
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
