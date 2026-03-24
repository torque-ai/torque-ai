const CIProvider = require('../ci/provider');
const GitHubActionsProvider = require('../ci/github-actions');
const childProcess = require('child_process');
const crypto = require('crypto');

const MAX_FAILURE_LOG_BYTES = 2 * 1024 * 1024;

describe('ci/provider base class', () => {
  it('throws from unimplemented methods getRun, getFailureLogs, and listRuns', async () => {
    const provider = new CIProvider({ name: 'mock-ci', repo: 'org/repo' });

    await expect(provider.getRun('run-123')).rejects.toThrow('mock-ci: getRun() not implemented');
    await expect(provider.getFailureLogs('run-123')).rejects.toThrow('mock-ci: getFailureLogs() not implemented');
    await expect(provider.listRuns()).rejects.toThrow('mock-ci: listRuns() not implemented');
  });

  it('stores constructor args in name and repo', () => {
    const provider = new CIProvider({ name: 'github-actions', repo: 'org/torque' });

    expect(provider.name).toBe('github-actions');
    expect(provider.repo).toBe('org/torque');
  });

  it('returns not implemented prerequisites by default', async () => {
    const provider = new CIProvider({ name: 'mock-ci', repo: 'org/repo' });
    const result = await provider.checkPrerequisites();

    expect(result.ready).toBe(false);
    expect(result.error).toBe('not implemented');
  });

  it('supports method overrides in subclasses', async () => {
    class MockCIProvider extends CIProvider {
      async getRun(runId) {
        return { id: runId, status: 'success', repository: 'org/repo' };
      }
    }

    const provider = new MockCIProvider({ name: 'mock-ci', repo: 'org/repo' });
    await expect(provider.getRun('run-123')).resolves.toEqual({
      id: 'run-123',
      status: 'success',
      repository: 'org/repo',
    });
    await expect(provider.watchRun('run-123')).resolves.toEqual({
      id: 'run-123',
      status: 'success',
      repository: 'org/repo',
    });
  });

  describe('watchRun', () => {
    it('polls getRun until status is terminal and returns the run', async () => {
      vi.useFakeTimers();
      const provider = new CIProvider({ name: 'test', repo: 'org/repo' });
      let callCount = 0;
      provider.getRun = vi.fn(async () => {
        callCount++;
        if (callCount < 3) return { id: 'run-1', status: 'running', conclusion: null };
        return { id: 'run-1', status: 'success', conclusion: 'success' };
      });

      const promise = provider.watchRun('run-1', { pollIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.status).toBe('success');
      expect(provider.getRun).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it('returns immediately when run is already completed', async () => {
      const provider = new CIProvider({ name: 'test', repo: 'org/repo' });
      provider.getRun = vi.fn(async () => ({ id: 'run-1', status: 'failure', conclusion: 'failure' }));

      const result = await provider.watchRun('run-1');
      expect(result.status).toBe('failure');
      expect(provider.getRun).toHaveBeenCalledTimes(1);
    });

    it('rejects after timeout', async () => {
      vi.useFakeTimers();
      const provider = new CIProvider({ name: 'test', repo: 'org/repo' });
      provider.getRun = vi.fn(async () => ({ id: 'run-1', status: 'running', conclusion: null }));

      const promise = provider.watchRun('run-1', { pollIntervalMs: 1000, timeoutMs: 2500 });
      const assertion = expect(promise).rejects.toThrow(/timed out/i);

      await vi.advanceTimersByTimeAsync(3000);

      await assertion;
      vi.useRealTimers();
    });
  });
});

describe('GitHubActionsProvider', () => {
  let execFileSpy;

  beforeEach(() => {
    execFileSpy = vi.spyOn(childProcess, 'execFile').mockImplementation((...args) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        callback(null, '', '');
      }
      return undefined;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checkPrerequisites returns error when gh not found', async () => {
    const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/torque' });
    const missingGhError = new Error('not found');
    missingGhError.code = 'ENOENT';
    execFileSpy.mockImplementationOnce((...args) => {
      const callback = args[args.length - 1];
      callback(missingGhError);
      return undefined;
    });

    const result = await provider.checkPrerequisites();

    expect(result).toEqual({
      ready: false,
      error: 'gh not found',
    });
    expect(execFileSpy).toHaveBeenCalledWith(
      'gh',
      ['auth', 'status', '--hostname', 'github.com'],
      { timeout: 30000, windowsHide: true },
      expect.any(Function),
    );
  });

  it('checkPrerequisites caches result after first call', async () => {
    const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/torque' });
    const first = await provider.checkPrerequisites();
    const second = await provider.checkPrerequisites();

    expect(first).toEqual({ ready: true });
    expect(second).toEqual({ ready: true });
    expect(first).toBe(second);
    expect(execFileSpy).toHaveBeenCalledTimes(1);
  });

  it('getRun parses gh JSON output into normalized CIEvent', async () => {
    const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/torque' });
    execFileSpy.mockImplementationOnce((...args) => {
      const callback = args[args.length - 1];
      callback(null, JSON.stringify({
        status: 'completed',
        conclusion: 'failure',
        headSha: 'abc123',
        headBranch: 'main',
        url: 'https://github.com/org/torque/actions/runs/456',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:10Z',
        databaseId: 456,
      }), '');
      return undefined;
    });

    await expect(provider.getRun('456')).resolves.toEqual({
      id: '456',
      status: 'failure',
      conclusion: 'failure',
      repository: 'org/torque',
      branch: 'main',
      sha: 'abc123',
      url: 'https://github.com/org/torque/actions/runs/456',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:10Z',
      raw: JSON.stringify({
        status: 'completed',
        conclusion: 'failure',
        headSha: 'abc123',
        headBranch: 'main',
        url: 'https://github.com/org/torque/actions/runs/456',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:10Z',
        databaseId: 456,
      }),
    });
    expect(execFileSpy).toHaveBeenCalledWith(
      'gh',
      [
        'run',
        'view',
        '456',
        '--repo', 'org/torque',
        '--json',
        'status,conclusion,headSha,headBranch,url,createdAt,updatedAt,jobs,databaseId',
      ],
      { timeout: 30000, windowsHide: true },
      expect.any(Function),
    );
  });

  it('getFailureLogs returns raw text capped at 2MB', async () => {
    const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/torque' });
    const oversizedText = 'A'.repeat(MAX_FAILURE_LOG_BYTES + 2048);
    execFileSpy.mockImplementationOnce((...args) => {
      const callback = args[args.length - 1];
      callback(null, oversizedText, '');
      return undefined;
    });

    const logs = await provider.getFailureLogs('456');

    expect(logs).toHaveLength(MAX_FAILURE_LOG_BYTES);
    expect(logs).toBe('A'.repeat(MAX_FAILURE_LOG_BYTES));
    expect(execFileSpy).toHaveBeenCalledWith(
      'gh',
      ['run', 'view', '456', '--repo', 'org/torque', '--log-failed'],
      { timeout: 30000, windowsHide: true },
      expect.any(Function),
    );
  });

  it('listRuns returns filtered array of run objects', async () => {
    const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/torque' });
    execFileSpy.mockImplementationOnce((...args) => {
      const callback = args[args.length - 1];
      callback(null, JSON.stringify([
        {
          databaseId: 1,
          status: 'completed',
          conclusion: 'failure',
          headSha: 'aaa',
          headBranch: 'main',
          url: 'https://github.com/org/torque/actions/runs/1',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          databaseId: 2,
          status: 'completed',
          conclusion: 'success',
          headSha: 'bbb',
          headBranch: 'feature',
          url: 'https://github.com/org/torque/actions/runs/2',
          createdAt: '2026-01-01T00:01:00Z',
        },
      ]), '');
      return undefined;
    });

    const runs = await provider.listRuns({ branch: 'feature', status: 'success', limit: 3 });

    expect(runs).toEqual([
      {
        id: '2',
        status: 'success',
        conclusion: 'success',
        repository: 'org/torque',
        branch: 'feature',
        sha: 'bbb',
        url: 'https://github.com/org/torque/actions/runs/2',
        createdAt: '2026-01-01T00:01:00Z',
        updatedAt: undefined,
        raw: JSON.stringify({
          databaseId: 2,
          status: 'completed',
          conclusion: 'success',
          headSha: 'bbb',
          headBranch: 'feature',
          url: 'https://github.com/org/torque/actions/runs/2',
          createdAt: '2026-01-01T00:01:00Z',
        }),
      },
    ]);
    expect(execFileSpy).toHaveBeenCalledWith(
      'gh',
      [
        'run',
        'list',
        '--repo', 'org/torque',
        '--json',
        'databaseId,status,conclusion,headSha,headBranch,url,createdAt',
        '--limit',
        '3',
      ],
      { timeout: 30000, windowsHide: true },
      expect.any(Function),
    );
  });

  it('parseWebhookPayload normalizes GitHub workflow_run event', () => {
    const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/torque' });
    const payload = {
      repository: { full_name: 'octo/repo' },
      workflow_run: {
        id: 987,
        status: 'in_progress',
        conclusion: null,
        head_sha: 'def456',
        head_branch: 'feature/ci',
        html_url: 'https://github.com/octo/repo/actions/runs/987',
        created_at: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:01:00Z',
      },
    };

    const event = provider.parseWebhookPayload({}, payload);

    expect(event).toEqual({
      id: '987',
      status: 'running',
      conclusion: null,
      repository: 'octo/repo',
      branch: 'feature/ci',
      sha: 'def456',
      url: 'https://github.com/octo/repo/actions/runs/987',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:01:00Z',
      raw: JSON.stringify(payload),
    });
  });

  it('verifyWebhookSignature returns true for valid HMAC-SHA256', async () => {
    const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/torque' });
    const body = '{"hello":"world"}';
    const secret = 'super-secret';
    const expectedSignature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

    await expect(
      provider.verifyWebhookSignature(
        { 'x-hub-signature-256': expectedSignature },
        body,
        secret,
      ),
    ).resolves.toBe(true);
  });

  it('verifyWebhookSignature returns false for invalid signature', async () => {
    const provider = new GitHubActionsProvider({ name: 'github-actions', repo: 'org/torque' });
    const body = '{"hello":"world"}';
    const secret = 'super-secret';
    const expectedSignature = `sha256=${crypto.createHmac('sha256', 'wrong-secret').update(body).digest('hex')}`;

    await expect(
      provider.verifyWebhookSignature(
        { 'x-hub-signature-256': expectedSignature },
        body,
        secret,
      ),
    ).resolves.toBe(false);
  });
});
