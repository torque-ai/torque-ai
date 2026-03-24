'use strict';

const realErrorCodes = require('../handlers/error-codes');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

const mockConfigCore = {
  getConfig: vi.fn(),
  setConfig: vi.fn(),
};

const mockWatcher = {
  watchRepo: vi.fn(),
  stopWatch: vi.fn(),
  awaitRun: vi.fn(),
  getActiveWatches: vi.fn(),
};

const mockProviderInstance = {
  getRun: vi.fn(),
  listRuns: vi.fn(),
  getFailureLogs: vi.fn(),
};

const mockCredentialCrypto = {
  getOrCreateKey: vi.fn(),
  encrypt: vi.fn(),
};

const mockGitHubActionsProvider = vi.fn(function GitHubActionsProviderMock() {
  return mockProviderInstance;
});
const mockDiagnostics = {
  diagnoseFailures: vi.fn(),
};

function resetMocks() {
  mockCredentialCrypto.getOrCreateKey.mockReset();
  mockCredentialCrypto.encrypt.mockReset();

  for (const fn of Object.values(mockConfigCore)) {
    fn.mockReset();
  }

  for (const fn of Object.values(mockWatcher)) {
    fn.mockReset();
  }

  for (const fn of Object.values(mockProviderInstance)) {
    fn.mockReset();
  }

  mockGitHubActionsProvider.mockClear();
  mockDiagnostics.diagnoseFailures.mockReset();
  mockConfigCore.getConfig.mockReturnValue(null);
  mockCredentialCrypto.getOrCreateKey.mockReturnValue('mock-key');
  mockCredentialCrypto.encrypt.mockReturnValue({
    encrypted_value: 'aa',
    iv: 'bb',
    auth_tag: 'cc',
  });
}

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/ci-handlers')];
  installMock('../db/config-core', mockConfigCore);
  installMock('../ci/watcher', mockWatcher);
  installMock('../ci/github-actions', mockGitHubActionsProvider);
  installMock('../ci/diagnostics', mockDiagnostics);
  installMock('../utils/credential-crypto', mockCredentialCrypto);
  installMock('../handlers/error-codes', realErrorCodes);
  return require('../handlers/ci-handlers');
}

function getText(result) {
  return result.content[0].text;
}

describe('ci-handlers.js', () => {
  let handlers;

  beforeEach(() => {
    resetMocks();
    handlers = loadHandlers();
  });

  describe('handleAwaitCiRun', () => {
    it('returns completed run details when the run finishes successfully', async () => {
      mockConfigCore.getConfig.mockReturnValue('acme/website');
      mockWatcher.awaitRun.mockResolvedValue({
        id: 'run-123',
        status: 'success',
        conclusion: 'success',
        repository: 'acme/website',
        branch: 'main',
        sha: 'abc123',
        url: 'https://example/run-123',
      });

      const result = await handlers.handleAwaitCiRun({
        run_id: 'run-123',
      });

      expect(mockWatcher.awaitRun).toHaveBeenCalledWith({
        repo: 'acme/website',
        provider: 'github-actions',
        runId: 'run-123',
        pollIntervalMs: undefined,
        timeoutMs: 30 * 60 * 1000,
      });
      expect(mockProviderInstance.getFailureLogs).not.toHaveBeenCalled();
      expect(getText(result)).toContain('## CI Run Completed');
      expect(getText(result)).toContain('| Run ID | run-123 |');
      expect(getText(result)).toContain('| Status | success |');
      expect(getText(result)).toContain('| Conclusion | success |');
      expect(mockGitHubActionsProvider).toHaveBeenCalledWith({ name: 'github-actions', repo: 'acme/website' });
      expect(result.isError).toBeUndefined();
    });

    it('returns TIMEOUT on a timeout while awaiting a CI run', async () => {
      mockConfigCore.getConfig.mockReturnValue('acme/website');
      mockWatcher.awaitRun.mockRejectedValue(new Error('timed out waiting for run completion'));

      const result = await handlers.handleAwaitCiRun({ run_id: 'run-123' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TIMEOUT');
      expect(getText(result)).toContain('timed out waiting for run completion');
      expect(mockProviderInstance.getFailureLogs).not.toHaveBeenCalled();
    });
  });

  describe('watch/stop handlers', () => {
    it('starts watch_ci_repo and confirms the watch', async () => {
      mockConfigCore.getConfig.mockReturnValue('acme/website');
      mockWatcher.watchRepo.mockResolvedValue({
        id: 'watch-123',
        repo: 'acme/website',
        provider: 'github-actions',
        branch: null,
        poll_interval_ms: 30000,
      });

      const result = await handlers.handleWatchCiRepo({ repo: 'acme/website', poll_interval_ms: 30000 });

      expect(mockWatcher.watchRepo).toHaveBeenCalledWith({
        repo: 'acme/website',
        provider: 'github-actions',
        branch: null,
        pollIntervalMs: 30000,
      });
      expect(getText(result)).toContain('## CI Watch Started');
      expect(getText(result)).toContain('watch-123');
      expect(getText(result)).toContain('acme/website');
    });

    it('stops an active watch by repo and provider', () => {
      mockWatcher.stopWatch.mockReturnValue(true);

      const result = handlers.handleStopCiWatch({ repo: 'acme/website', provider: 'github-actions' });

      expect(mockWatcher.stopWatch).toHaveBeenCalledWith({ repo: 'acme/website', provider: 'github-actions' });
      expect(getText(result)).toContain('## CI Watch Stopped');
      expect(getText(result)).toContain('acme/website');
    });
  });

  describe('handleDiagnoseCiFailure', () => {
    it('returns diagnosis triage text from provider logs', async () => {
      mockConfigCore.getConfig.mockReturnValue('acme/website');
      mockProviderInstance.getFailureLogs.mockResolvedValue('FAIL tests > should do something\\n  expected 1 to be 2');
      mockDiagnostics.diagnoseFailures.mockReturnValue({
        triage: '## CI Failure Triage\\n1. Example suggestion',
        failures: [],
      });

      const result = await handlers.handleDiagnoseCiFailure({ run_id: 'run-404' });

      expect(mockProviderInstance.getFailureLogs).toHaveBeenCalledWith('run-404');
      expect(mockDiagnostics.diagnoseFailures).toHaveBeenCalledWith('FAIL tests > should do something\\n  expected 1 to be 2', {
        runId: 'run-404',
      });
      expect(getText(result)).toContain('## CI Failure Triage');
      expect(getText(result)).toContain('Example suggestion');
    });
  });

  describe('handleListCiRuns', () => {
    it('formats CI runs as a markdown table', async () => {
      mockConfigCore.getConfig.mockReturnValue('acme/website');
      mockProviderInstance.listRuns.mockResolvedValue([
        {
          id: 'run-a',
          status: 'success',
          conclusion: 'success',
          branch: 'main',
          sha: 'abc123',
          url: 'https://example/run-a',
        },
        {
          id: 'run-b',
          status: 'failure',
          conclusion: 'failure',
          branch: 'main',
          sha: 'def456',
          url: 'https://example/run-b',
        },
      ]);

      const result = await handlers.handleListCiRuns({ repo: 'acme/website' });

      expect(mockProviderInstance.listRuns).toHaveBeenCalledWith({ branch: undefined, status: undefined, limit: undefined });
      expect(getText(result)).toContain('| Run ID | Status | Conclusion | Branch | SHA | URL |');
      expect(getText(result)).toContain('| run-a | success | success | main | abc123 | https://example/run-a |');
      expect(getText(result)).toContain('| run-b | failure | failure | main | def456 | https://example/run-b |');
    });
  });

  describe('handleCiRunStatus', () => {
    it('returns formatted run status markdown', async () => {
      mockConfigCore.getConfig.mockReturnValue('acme/website');
      mockProviderInstance.getRun.mockResolvedValue({
        id: 'run-777',
        status: 'success',
        conclusion: 'success',
        repository: 'acme/website',
        branch: 'main',
        sha: 'abc123',
        url: 'https://example/run-777',
      });

      const result = await handlers.handleCiRunStatus({ run_id: 'run-777' });

      expect(mockProviderInstance.getRun).toHaveBeenCalledWith('run-777');
      expect(getText(result)).toContain('## CI Run Status');
      expect(getText(result)).toContain('| Run ID | run-777 |');
      expect(getText(result)).toContain('| Conclusion | success |');
      expect(getText(result)).toContain('https://example/run-777');
    });
  });

  describe('handleConfigureCiProvider', () => {
    it('persists default repo, webhook secret, and poll interval while redacting secret in response', () => {
      const result = handlers.handleConfigureCiProvider({
        default_repo: 'acme/website',
        webhook_secret: 'super-secret-value',
        poll_interval_ms: 15000,
      });

      expect(mockConfigCore.setConfig).toHaveBeenCalledWith('default_ci_repo', 'acme/website');
      expect(mockConfigCore.setConfig).toHaveBeenCalledWith('webhook_secret', 'ENC:aa:bb:cc');
      expect(mockConfigCore.setConfig).toHaveBeenCalledWith('poll_interval_ms', '15000');
      expect(mockCredentialCrypto.getOrCreateKey).toHaveBeenCalledTimes(1);
      expect(mockCredentialCrypto.encrypt).toHaveBeenCalledWith('super-secret-value', 'mock-key');
      expect(getText(result)).not.toContain('super-secret-value');
      expect(getText(result)).toContain('**default_repo:** acme/website');
      expect(getText(result)).toContain('**webhook_secret:**');
      expect(getText(result)).toContain('**poll_interval_ms:** 15000');
    });
  });

  describe('resolveRepo', () => {
    it('falls back from args.repo to db config and finally `gh repo view`', async () => {
      const spy = vi.spyOn(require('child_process'), 'execFileSync').mockImplementation(() => 'cli/fallback\n');

      mockConfigCore.getConfig.mockReturnValueOnce(null);
      const result = handlers.resolveRepo({
        working_directory: 'C:/tmp/repo',
      });

      expect(spy).toHaveBeenCalledWith(
        'gh',
        ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
        {
          timeout: 10000,
          encoding: 'utf8',
          cwd: 'C:/tmp/repo',
          windowsHide: true,
        },
      );
      expect(result).toBe('cli/fallback');
      spy.mockRestore();

      mockConfigCore.getConfig.mockReturnValue('db/repo');
      expect(handlers.resolveRepo({})).toBe('db/repo');
      expect(handlers.resolveRepo({ repo: 'arg/repo' })).toBe('arg/repo');
    });
  });
});
