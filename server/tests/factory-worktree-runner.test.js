import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { EventEmitter } = require('events');
const {
  createWorktreeRunner,
  sanitizeSlug,
  resolveSystemShellCommand,
  _internalForTests,
} = require('../factory/worktree-runner');

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

describe('async child process settlement', () => {
  function createFakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after exit even when close never arrives', async () => {
    const child = createFakeChild();
    const promise = _internalForTests.spawnTrackedProcessAsync(
      'fake-cmd',
      ['arg'],
      {},
      () => child,
    );

    child.stdout.emit('data', Buffer.from('verify ok'));
    child.emit('exit', 0, null);

    await vi.advanceTimersByTimeAsync(_internalForTests.CHILD_CLOSE_GRACE_MS);
    const result = await promise;

    expect(result).toMatchObject({
      status: 0,
      stdout: 'verify ok',
      stderr: '',
      error: null,
      signal: null,
    });
  });

  it('times out even when neither exit nor close fires', async () => {
    const child = createFakeChild();
    const promise = _internalForTests.spawnTrackedProcessAsync(
      'fake-cmd',
      ['arg'],
      { timeout: 1000 },
      () => child,
    );

    child.stderr.emit('data', Buffer.from('still waiting'));
    await vi.advanceTimersByTimeAsync(1000 + _internalForTests.CHILD_CLOSE_GRACE_MS);
    const result = await promise;

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(result).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'still waiting',
      error: { message: 'timeout after 1000ms' },
    });
  });

  it('caps stdout/stderr at MAX_CHILD_BUFFER_BYTES with a truncation notice', async () => {
    const child = createFakeChild();
    const promise = _internalForTests.spawnTrackedProcessAsync(
      'fake-cmd',
      ['arg'],
      {},
      () => child,
    );

    const cap = _internalForTests.MAX_CHILD_BUFFER_BYTES;
    expect(typeof cap).toBe('number');
    expect(cap).toBeGreaterThan(0);

    const chunkSize = 1024 * 1024;
    const chunk = Buffer.alloc(chunkSize, 0x61); // 'a'
    // Push enough data to exceed cap by ~5x.
    const totalChunks = Math.ceil((cap / chunkSize) * 5);
    for (let i = 0; i < totalChunks; i += 1) {
      child.stdout.emit('data', chunk);
      child.stderr.emit('data', chunk);
    }

    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(_internalForTests.CHILD_CLOSE_GRACE_MS);
    const result = await promise;

    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(cap + 200);
    expect(result.stderr.length).toBeLessThanOrEqual(cap + 200);
    expect(result.stdout).toContain('[truncated: stdout exceeded');
    expect(result.stderr).toContain('[truncated: stderr exceeded');
  });
});

describe('remote verify invocation builder', () => {
  it('wraps verify commands through bash -lc so shell operators survive torque-remote', () => {
    const invocation = _internalForTests.buildRemoteVerifyInvocation(
      'dotnet test tests/One.csproj --nologo && dotnet test tests/Two.csproj --nologo',
    );

    expect(invocation).toMatch(/^torque-remote bash -lc /);
    expect(invocation).toContain('dotnet test tests/One.csproj --nologo && dotnet test tests/Two.csproj --nologo');
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
    expect(result.baseBranch).toBe('main');
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
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('boom');
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

  it('falls back to local verify when the remote Python launcher lacks the requested runtime', async () => {
    const runRemoteVerify = vi.fn(() => ({
      exitCode: 103,
      stdout: '[torque-remote] Running on worker: py -3.12 -m pytest tests/ -q',
      stderr: [
        'No suitable Python runtime found',
        'Pass --list (-0) to see all detected environments on your machine',
        'or set environment variable PYLAUNCHER_ALLOW_INSTALL to use winget',
        'or open the Microsoft Store to the requested version.',
      ].join('\n'),
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
      branch: 'feat/python-fallback',
      verifyCommand: 'py -3.12 -m pytest tests/ -q',
    });

    expect(result.passed).toBe(true);
    expect(runRemoteVerify).toHaveBeenCalledTimes(1);
    expect(runLocalVerify).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'feat/python-fallback',
      command: 'py -3.12 -m pytest tests/ -q',
      cwd: 'C:/wt',
      fallbackReason: 'No suitable Python runtime found',
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
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/empty-branch/);
    expect(runRemoteVerify).not.toHaveBeenCalled();
    expect(runLocalVerify).not.toHaveBeenCalled();
    expect(countCommitsAhead).toHaveBeenCalledWith({
      cwd: 'C:/wt',
      baseBranch: 'main',
      branch: 'feat/empty',
    });
  });

  it('skips verify when branch diff only contains non-code files', async () => {
    const runRemoteVerify = vi.fn();
    const runLocalVerify = vi.fn();
    const countCommitsAhead = vi.fn(() => 2);
    const listChangedFiles = vi.fn(() => [
      'docs/superpowers/plans/auto-generated/754-add-typed-lanstartupcoordinator-failure-reasons.md',
      'docs/superpowers/plans/auto-generated/755-emit-typed-lan-startup-failures-in-automation-results.md',
      'docs/superpowers/plans/auto-generated/759-emit-typed-lan-startup-failures-in-automation-results.md',
    ]);
    const runner = createWorktreeRunner({
      worktreeManager: makeWorktreeManagerMock(),
      runRemoteVerify,
      runLocalVerify,
      countCommitsAhead,
      listChangedFiles,
    });

    const result = await runner.verify({
      worktreePath: 'C:/wt',
      branch: 'feat/docs-only',
      verifyCommand: 'dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter LanStartupCoordinator',
      baseBranch: 'main',
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBe('non_code_only');
    expect(result.output).toMatch(/skipping verify command/i);
    expect(runRemoteVerify).not.toHaveBeenCalled();
    expect(runLocalVerify).not.toHaveBeenCalled();
    expect(listChangedFiles).toHaveBeenCalledWith({
      cwd: 'C:/wt',
      baseBranch: 'main',
      branch: 'feat/docs-only',
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
