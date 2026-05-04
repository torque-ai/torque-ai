/**
 * Unit tests for server/ci/watcher.js
 */

const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const {
  watchRepo,
  stopWatch,
  shutdownAll,
  getActiveWatches,
} = require('../ci/watcher');
const mcpSse = require('../mcp/sse');

describe('ci watcher', () => {
  let originalPushNotification;

  beforeEach(() => {
    setupTestDbOnly('ci-watcher');
    vi.useFakeTimers();
    originalPushNotification = mcpSse.pushNotification;
    mcpSse.pushNotification = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    shutdownAll();
    teardownTestDb();
    mcpSse.pushNotification = originalPushNotification;
  });

  it('watchRepo starts polling timer and detects new completed runs', async () => {
    const provider = {
      name: 'mock',
      listRuns: vi.fn().mockResolvedValue([
        {
          id: 'run-1',
          status: 'failure',
          conclusion: 'failure',
          branch: 'main',
          repository: 'org/repo',
          url: 'https://example/run-1',
          createdAt: '2026-03-01T00:00:01.000Z',
        },
      ]),
      getFailureLogs: vi.fn().mockResolvedValue('FAIL test > should fail'),
    };

    await watchRepo({
      repo: 'org/repo',
      provider,
      branch: 'main',
      pollIntervalMs: 1000,
    });

    expect(getActiveWatches()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);

    expect(provider.listRuns).toHaveBeenCalledTimes(1);
    expect(provider.listRuns).toHaveBeenCalledWith({ branch: 'main' });
    expect(provider.getFailureLogs).toHaveBeenCalledWith('run-1');

    expect(mcpSse.pushNotification).toHaveBeenCalledTimes(1);
    const payload = mcpSse.pushNotification.mock.calls[0][0];
    expect(payload.type).toBe('ci:run:failed');
    expect(payload.data.run_id).toBe('run-1');
  });

  it('watchRepo pushes MCP notification on failure detection', async () => {
    const provider = {
      name: 'mock',
      listRuns: vi.fn().mockResolvedValue([
        {
          id: 'run-2',
          status: 'failure',
          conclusion: 'failure',
          branch: 'main',
          repository: 'org/repo',
          url: 'https://example/run-2',
          createdAt: '2026-03-01T00:01:00.000Z',
        },
      ]),
      getFailureLogs: vi.fn().mockResolvedValue('FAIL tests > should fail'),
    };

    await watchRepo({ repo: 'org/repo', provider, branch: 'main', pollIntervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    const payload = mcpSse.pushNotification.mock.calls[0][0];
    expect(payload.type).toBe('ci:run:failed');
    expect(payload.data).toMatchObject({
      run_id: 'run-2',
      repo: 'org/repo',
      branch: 'main',
      commit_sha: null,
      conclusion: 'failure',
      category_counts: {
        test_logic: 1,
      },
      total_failures: 1,
      triage_summary: '1 failures: 1 logic',
      url: 'https://example/run-2',
    });
  });

  it('watchRepo is idempotent and updates interval for existing watch', async () => {
    const provider = {
      name: 'mock',
      listRuns: vi.fn().mockResolvedValue([]),
      getFailureLogs: vi.fn().mockResolvedValue(''),
    };

    await watchRepo({ repo: 'org/repo', provider, branch: 'main', pollIntervalMs: 500 });
    await watchRepo({ repo: 'org/repo', provider, branch: 'main', pollIntervalMs: 1200 });

    expect(getActiveWatches()).toHaveLength(1);

    provider.listRuns.mockClear();
    await vi.advanceTimersByTimeAsync(800);
    expect(provider.listRuns).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(provider.listRuns).toHaveBeenCalledTimes(1);
  });

  it('stopWatch clears timer and marks DB row inactive', async () => {
    const provider = {
      name: 'mock',
      listRuns: vi.fn().mockResolvedValue([]),
      getFailureLogs: vi.fn().mockResolvedValue(''),
    };

    await watchRepo({ repo: 'org/repo', provider, branch: 'main', pollIntervalMs: 250 });

    const before = rawDb().prepare('SELECT active FROM ci_watches WHERE repo = ? AND provider = ?').get('org/repo', 'mock');
    expect(before.active).toBe(1);

    await stopWatch({ repo: 'org/repo', provider });

    const after = rawDb().prepare('SELECT active FROM ci_watches WHERE repo = ? AND provider = ?').get('org/repo', 'mock');
    expect(after.active).toBe(0);
    expect(getActiveWatches()).toHaveLength(0);

    provider.listRuns.mockClear();
    await vi.advanceTimersByTimeAsync(500);
    expect(provider.listRuns).toHaveBeenCalledTimes(0);
  });

  it('enforces MAX_WATCHES and rejects the 11th concurrent watch', async () => {
    const providers = Array.from({ length: 10 }, () => ({
      name: 'mock',
      listRuns: vi.fn().mockResolvedValue([]),
      getFailureLogs: vi.fn().mockResolvedValue(''),
    }));

    const watchers = [];
    for (let i = 0; i < 10; i += 1) {
      watchers.push(watchRepo({
        repo: `org/repo-${i}`,
        provider: providers[i],
        branch: 'main',
        pollIntervalMs: 1000,
      }));
    }
    await Promise.all(watchers);

    const extraProvider = {
      name: 'mock',
      listRuns: vi.fn().mockResolvedValue([]),
      getFailureLogs: vi.fn().mockResolvedValue(''),
    };

    await expect(watchRepo({
      repo: 'org/repo-10',
      provider: extraProvider,
      branch: 'main',
      pollIntervalMs: 1000,
    })).rejects.toThrow('Maximum concurrent CI watches');
  });

  it('shutdownAll clears all active timers', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const providerOne = {
      name: 'mock-1',
      listRuns: vi.fn().mockResolvedValue([]),
      getFailureLogs: vi.fn().mockResolvedValue(''),
    };
    const providerTwo = {
      name: 'mock-2',
      listRuns: vi.fn().mockResolvedValue([]),
      getFailureLogs: vi.fn().mockResolvedValue(''),
    };

    await watchRepo({ repo: 'org/repo-1', provider: providerOne, branch: 'main', pollIntervalMs: 300 });
    await watchRepo({ repo: 'org/repo-2', provider: providerTwo, branch: 'main', pollIntervalMs: 300 });

    expect(getActiveWatches()).toHaveLength(2);
    shutdownAll();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(getActiveWatches()).toHaveLength(0);
  });

  it('filters runs with created_at greater than watch.last_checked_at', async () => {
    const db = rawDb();
    const provider = {
      name: 'mock',
      listRuns: vi.fn().mockResolvedValue([
        {
          id: 'run-old',
          status: 'failure',
          conclusion: 'failure',
          branch: 'main',
          repository: 'org/repo',
          url: 'https://example/run-old',
          created_at: '2026-03-01T00:00:00.000Z',
        },
        {
          id: 'run-new',
          status: 'failure',
          conclusion: 'failure',
          branch: 'main',
          repository: 'org/repo',
          url: 'https://example/run-new',
          created_at: '2026-03-01T00:30:00.000Z',
        },
      ]),
      getFailureLogs: vi.fn().mockResolvedValue('FAIL tests > should fail'),
    };

    await watchRepo({ repo: 'org/repo', provider, branch: 'main', pollIntervalMs: 500 });
    db.prepare(`
      UPDATE ci_watches
      SET last_checked_at = ?
      WHERE repo = ? AND provider = ?
    `).run('2026-03-01T00:15:00.000Z', 'org/repo', 'mock');

    await vi.advanceTimersByTimeAsync(500);

    expect(provider.listRuns).toHaveBeenCalledTimes(1);
    const calls = mcpSse.pushNotification.mock.calls.map((call) => call[0].data.run_id);
    expect(calls).toEqual(['run-new']);
  });

  it('caps notification triage_summary at 500 characters', async () => {
    const failureLines = Array.from({ length: 30 }, (_, index) => `FAIL file${index}.ts > test case ${index} failed due to unexpected token`);
    const provider = {
      name: 'mock',
      listRuns: vi.fn().mockResolvedValue([
        {
          id: 'run-long',
          status: 'failure',
          conclusion: 'failure',
          branch: 'main',
          repository: 'org/repo',
          url: 'https://example/run-long',
          createdAt: '2026-03-01T00:00:01.000Z',
        },
      ]),
      getFailureLogs: vi.fn().mockResolvedValue(failureLines.join('\n')),
    };

    await watchRepo({ repo: 'org/repo', provider, branch: 'main', pollIntervalMs: 500 });
    await vi.advanceTimersByTimeAsync(500);

    const payload = mcpSse.pushNotification.mock.calls[0][0];
    expect(payload.data.triage_summary.length).toBeLessThanOrEqual(500);
    expect(payload.data.triage_summary).toBe(payload.data.triage_summary.slice(0, 500));
  });
});
