'use strict';

const childProcess = require('child_process');
const GitHubActionsProvider = require('../ci/github-actions');

const TEST_REPO = 'myorg/myrepo';

describe('GitHubActionsProvider — --repo flag on all gh commands', () => {
  let execFileSpy;

  beforeEach(() => {
    execFileSpy = vi.spyOn(childProcess, 'execFile').mockImplementation((...args) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        callback(null, '[]', '');
      }
      return undefined;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getRun passes --repo <repo> to gh run view', async () => {
    const provider = new GitHubActionsProvider({ repo: TEST_REPO });
    execFileSpy.mockImplementationOnce((...args) => {
      const callback = args[args.length - 1];
      callback(null, JSON.stringify({
        status: 'completed',
        conclusion: 'success',
        headSha: 'abc',
        headBranch: 'main',
        url: 'https://github.com/myorg/myrepo/actions/runs/1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:01Z',
        databaseId: 1,
      }), '');
      return undefined;
    });

    await provider.getRun('1');

    const [, ghArgs] = execFileSpy.mock.calls[0];
    expect(ghArgs).toContain('--repo');
    expect(ghArgs[ghArgs.indexOf('--repo') + 1]).toBe(TEST_REPO);
  });

  it('getRun places --repo before --json in the argument list', async () => {
    const provider = new GitHubActionsProvider({ repo: TEST_REPO });
    execFileSpy.mockImplementationOnce((...args) => {
      const callback = args[args.length - 1];
      callback(null, JSON.stringify({
        status: 'completed',
        conclusion: 'success',
        headSha: 'abc',
        headBranch: 'main',
        url: 'https://github.com/myorg/myrepo/actions/runs/2',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:01Z',
        databaseId: 2,
      }), '');
      return undefined;
    });

    await provider.getRun('2');

    const [, ghArgs] = execFileSpy.mock.calls[0];
    const repoIdx = ghArgs.indexOf('--repo');
    const jsonIdx = ghArgs.indexOf('--json');
    expect(repoIdx).toBeGreaterThan(-1);
    expect(jsonIdx).toBeGreaterThan(-1);
    expect(repoIdx).toBeLessThan(jsonIdx);
  });

  it('getFailureLogs passes --repo <repo> to gh run view --log-failed', async () => {
    const provider = new GitHubActionsProvider({ repo: TEST_REPO });
    execFileSpy.mockImplementationOnce((...args) => {
      const callback = args[args.length - 1];
      callback(null, 'some log output', '');
      return undefined;
    });

    await provider.getFailureLogs('42');

    const [, ghArgs] = execFileSpy.mock.calls[0];
    expect(ghArgs).toContain('--repo');
    expect(ghArgs[ghArgs.indexOf('--repo') + 1]).toBe(TEST_REPO);
    expect(ghArgs).toContain('--log-failed');
  });

  it('listRuns passes --repo <repo> to gh run list', async () => {
    const provider = new GitHubActionsProvider({ repo: TEST_REPO });

    await provider.listRuns({ limit: 5 });

    const [, ghArgs] = execFileSpy.mock.calls[0];
    expect(ghArgs).toContain('--repo');
    expect(ghArgs[ghArgs.indexOf('--repo') + 1]).toBe(TEST_REPO);
    expect(ghArgs).toContain('list');
  });

  it('listRuns uses the configured repo, not a hardcoded value', async () => {
    const otherRepo = 'another-org/another-repo';
    const provider = new GitHubActionsProvider({ repo: otherRepo });

    await provider.listRuns();

    const [, ghArgs] = execFileSpy.mock.calls[0];
    const repoIdx = ghArgs.indexOf('--repo');
    expect(repoIdx).toBeGreaterThan(-1);
    expect(ghArgs[repoIdx + 1]).toBe(otherRepo);
  });

  it('getRun uses the configured repo, not a hardcoded value', async () => {
    const otherRepo = 'another-org/another-repo';
    const provider = new GitHubActionsProvider({ repo: otherRepo });
    execFileSpy.mockImplementationOnce((...args) => {
      const callback = args[args.length - 1];
      callback(null, JSON.stringify({
        status: 'completed',
        conclusion: 'success',
        headSha: 'xyz',
        headBranch: 'main',
        url: 'https://github.com/another-org/another-repo/actions/runs/9',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:01Z',
        databaseId: 9,
      }), '');
      return undefined;
    });

    await provider.getRun('9');

    const [, ghArgs] = execFileSpy.mock.calls[0];
    expect(ghArgs[ghArgs.indexOf('--repo') + 1]).toBe(otherRepo);
  });

  it('getFailureLogs uses the configured repo, not a hardcoded value', async () => {
    const otherRepo = 'another-org/another-repo';
    const provider = new GitHubActionsProvider({ repo: otherRepo });
    execFileSpy.mockImplementationOnce((...args) => {
      const callback = args[args.length - 1];
      callback(null, 'log data', '');
      return undefined;
    });

    await provider.getFailureLogs('7');

    const [, ghArgs] = execFileSpy.mock.calls[0];
    expect(ghArgs[ghArgs.indexOf('--repo') + 1]).toBe(otherRepo);
  });

  it('_normalizeRun preserves conclusion alongside normalized status', () => {
    const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/repo' });
    const raw = {
      databaseId: '123',
      status: 'completed',
      conclusion: 'timed_out',
      headBranch: 'main',
      headSha: 'abc',
      url: 'https://github.com',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    const normalized = provider._normalizeRun(raw);
    expect(normalized.status).toBe('failure');
    expect(normalized.conclusion).toBe('timed_out');
  });

  it('_normalizeRun sets conclusion to success for successful runs', () => {
    const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/repo' });
    const raw = {
      databaseId: '456',
      status: 'completed',
      conclusion: 'success',
      headBranch: 'main',
      headSha: 'def',
      url: 'https://github.com',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    const normalized = provider._normalizeRun(raw);
    expect(normalized.status).toBe('success');
    expect(normalized.conclusion).toBe('success');
  });
});
