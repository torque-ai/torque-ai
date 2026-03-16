/**
 * Unit Tests: host-monitoring.js — probeCodexRecovery()
 *
 * Tests the Codex recovery probe that checks if Codex quota has recovered.
 * RB-033 changed the probe to prefer an authenticated OpenAI API check
 * (if OPENAI_API_KEY is set), falling back to CLI `codex --version`.
 *
 * host-monitoring.js destructures { spawnSync } from child_process at load time,
 * so we patch cp's exports before requiring the module (same pattern as close-phases).
 */

const cp = require('child_process');

// Save originals for child_process (destructured at load time)
const _origSpawnSync = cp.spawnSync;

// Persistent mock for spawnSync
const mockSpawnSync = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });

function loadHostMonitoringWithMocks() {
  // Patch child_process exports BEFORE require so destructuring captures our mock
  cp.spawnSync = mockSpawnSync;

  const _modPath = require.resolve('../utils/host-monitoring');
  const mod = require('../utils/host-monitoring');

  // Restore originals so other modules aren't affected
  cp.spawnSync = _origSpawnSync;

  return mod;
}

describe('probeCodexRecovery', () => {
  let hostMonitoring;
  let mockDb;
  const savedApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    // Clear OPENAI_API_KEY so CLI fallback path runs (not API probe)
    delete process.env.OPENAI_API_KEY;

    // Reset spawnSync mock
    mockSpawnSync.mockReset().mockReturnValue({ status: 0, stdout: '', stderr: '' });

    // Load module with patched child_process
    hostMonitoring = loadHostMonitoringWithMocks();

    // Create mock db with all methods probeCodexRecovery needs
    mockDb = {
      getConfig: vi.fn().mockReturnValue(null),
      setConfig: vi.fn(),
      setCodexExhausted: vi.fn(),
      // init() also needs these for module setup (other functions may reference them)
      listOllamaHosts: vi.fn().mockReturnValue([]),
      recordHostHealthCheck: vi.fn(),
      getOllamaHost: vi.fn(),
      recoverOllamaHost: vi.fn(),
      acquireLock: vi.fn().mockReturnValue({ acquired: false }),
      ensureModelsLoaded: vi.fn(),
    };

    // Inject dependencies via init()
    hostMonitoring.init({
      db: mockDb,
      dashboard: null,
      cleanupOrphanedHostTasks: vi.fn(),
      queueLockHolderId: 'test-holder',
    });
  });

  afterEach(() => {
    // Restore OPENAI_API_KEY
    if (savedApiKey !== undefined) {
      process.env.OPENAI_API_KEY = savedApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('does nothing when codex_exhausted is not set', async () => {
    mockDb.getConfig.mockReturnValue(null);

    await hostMonitoring.probeCodexRecovery();

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockDb.setCodexExhausted).not.toHaveBeenCalled();
  });

  it('does nothing when codex_exhausted is "0"', async () => {
    mockDb.getConfig.mockImplementation((key) => {
      if (key === 'codex_exhausted') return '0';
      return null;
    });

    await hostMonitoring.probeCodexRecovery();

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockDb.setCodexExhausted).not.toHaveBeenCalled();
  });

  it('does nothing when interval has not elapsed', async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    mockDb.getConfig.mockImplementation((key) => {
      if (key === 'codex_exhausted') return '1';
      if (key === 'codex_probe_interval_minutes') return '15';
      if (key === 'codex_exhausted_at') return fiveMinutesAgo;
      return null;
    });

    await hostMonitoring.probeCodexRecovery();

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockDb.setCodexExhausted).not.toHaveBeenCalled();
  });

  it('clears exhaustion flag when CLI probe succeeds (status 0)', async () => {
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    mockDb.getConfig.mockImplementation((key) => {
      if (key === 'codex_exhausted') return '1';
      if (key === 'codex_probe_interval_minutes') return '15';
      if (key === 'codex_exhausted_at') return twentyMinutesAgo;
      return null;
    });

    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'codex v1.0.0', stderr: '' });

    await hostMonitoring.probeCodexRecovery();

    // RB-033: CLI fallback uses --version (not --help) and shell only on Windows
    expect(mockSpawnSync).toHaveBeenCalledWith('npx', ['codex', '--version'], {
      timeout: 10000,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    expect(mockDb.setCodexExhausted).toHaveBeenCalledWith(false);
    // Should NOT update the timestamp since we cleared the flag
    expect(mockDb.setConfig).not.toHaveBeenCalledWith('codex_exhausted_at', expect.any(String));
  });

  it('updates timestamp when CLI probe fails (non-zero exit)', async () => {
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    mockDb.getConfig.mockImplementation((key) => {
      if (key === 'codex_exhausted') return '1';
      if (key === 'codex_probe_interval_minutes') return '15';
      if (key === 'codex_exhausted_at') return twentyMinutesAgo;
      return null;
    });

    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'quota exceeded' });

    await hostMonitoring.probeCodexRecovery();

    expect(mockSpawnSync).toHaveBeenCalled();
    expect(mockDb.setCodexExhausted).not.toHaveBeenCalled();
    expect(mockDb.setConfig).toHaveBeenCalledWith('codex_exhausted_at', expect.any(String));
  });

  it('handles spawnSync throwing without crashing', async () => {
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    mockDb.getConfig.mockImplementation((key) => {
      if (key === 'codex_exhausted') return '1';
      if (key === 'codex_probe_interval_minutes') return '15';
      if (key === 'codex_exhausted_at') return twentyMinutesAgo;
      return null;
    });

    mockSpawnSync.mockImplementation(() => {
      throw new Error('ENOENT: npx not found');
    });

    // Should not throw
    await hostMonitoring.probeCodexRecovery();

    expect(mockDb.setCodexExhausted).not.toHaveBeenCalled();
    expect(mockDb.setConfig).toHaveBeenCalledWith('codex_exhausted_at', expect.any(String));
  });

  it('probes when codex_exhausted_at is not set (first probe)', async () => {
    mockDb.getConfig.mockImplementation((key) => {
      if (key === 'codex_exhausted') return '1';
      if (key === 'codex_probe_interval_minutes') return '15';
      if (key === 'codex_exhausted_at') return null; // No timestamp yet
      return null;
    });

    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });

    await hostMonitoring.probeCodexRecovery();

    // Should probe immediately when no exhausted_at timestamp exists
    expect(mockSpawnSync).toHaveBeenCalled();
    expect(mockDb.setCodexExhausted).toHaveBeenCalledWith(false);
  });

  // ── API probe path tests (when OPENAI_API_KEY is set) ──────

  describe('API probe path', () => {
    let mockHttps;

    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'sk-test-key';

      // Mock https module used by probeCodexRecovery
      mockHttps = {
        request: vi.fn(),
      };

      // We need to mock require('https') — intercept via module cache
      const httpsPath = require.resolve('https');
      require.cache[httpsPath] = {
        id: httpsPath,
        filename: httpsPath,
        loaded: true,
        exports: mockHttps,
      };

      // Re-load host-monitoring to pick up the mock
      hostMonitoring = loadHostMonitoringWithMocks();
      hostMonitoring.init({
        db: mockDb,
        dashboard: null,
        cleanupOrphanedHostTasks: vi.fn(),
        queueLockHolderId: 'test-holder',
      });
    });

    afterEach(() => {
      const _httpsPath = require.resolve('https');
    });

    function setupExhaustedConfig() {
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'codex_exhausted') return '1';
        if (key === 'codex_probe_interval_minutes') return '15';
        if (key === 'codex_exhausted_at') return twentyMinutesAgo;
        return null;
      });
    }

    function mockApiResponse(statusCode) {
      mockHttps.request.mockImplementation((_opts, callback) => {
        const res = {
          statusCode,
          on: vi.fn((event, handler) => {
            if (event === 'data') handler('{}');
            if (event === 'end') handler();
          }),
        };
        // Call the callback on next tick to simulate async
        process.nextTick(() => callback(res));
        return {
          on: vi.fn(),
          end: vi.fn(),
          destroy: vi.fn(),
        };
      });
    }

    it('clears exhaustion when API returns 200', async () => {
      setupExhaustedConfig();
      mockApiResponse(200);

      await hostMonitoring.probeCodexRecovery();

      expect(mockHttps.request).toHaveBeenCalled();
      expect(mockDb.setCodexExhausted).toHaveBeenCalledWith(false);
      // CLI should NOT be called when API succeeds
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it('updates timestamp when API returns 429 (quota)', async () => {
      setupExhaustedConfig();
      mockApiResponse(429);

      await hostMonitoring.probeCodexRecovery();

      expect(mockDb.setCodexExhausted).not.toHaveBeenCalled();
      expect(mockDb.setConfig).toHaveBeenCalledWith('codex_exhausted_at', expect.any(String));
      // CLI should NOT be called when API gives definitive response
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it('updates timestamp when API returns 401 (auth failure)', async () => {
      setupExhaustedConfig();
      mockApiResponse(401);

      await hostMonitoring.probeCodexRecovery();

      expect(mockDb.setCodexExhausted).not.toHaveBeenCalled();
      expect(mockDb.setConfig).toHaveBeenCalledWith('codex_exhausted_at', expect.any(String));
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it('falls back to CLI when API returns unexpected status', async () => {
      setupExhaustedConfig();
      mockApiResponse(500);

      mockSpawnSync.mockReturnValue({ status: 0, stdout: 'codex v1.0.0', stderr: '' });

      await hostMonitoring.probeCodexRecovery();

      // API returned 500, so CLI fallback should run
      expect(mockSpawnSync).toHaveBeenCalled();
      expect(mockDb.setCodexExhausted).toHaveBeenCalledWith(false);
    });

    it('falls back to CLI when API request errors', async () => {
      setupExhaustedConfig();
      mockHttps.request.mockImplementation((_opts, _callback) => {
        const req = {
          on: vi.fn((event, handler) => {
            if (event === 'error') {
              process.nextTick(() => handler(new Error('ENOTFOUND')));
            }
          }),
          end: vi.fn(),
          destroy: vi.fn(),
        };
        return req;
      });

      mockSpawnSync.mockReturnValue({ status: 0, stdout: 'codex v1.0.0', stderr: '' });

      await hostMonitoring.probeCodexRecovery();

      // API errored, so CLI fallback should run
      expect(mockSpawnSync).toHaveBeenCalled();
      expect(mockDb.setCodexExhausted).toHaveBeenCalledWith(false);
    });
  });
});
