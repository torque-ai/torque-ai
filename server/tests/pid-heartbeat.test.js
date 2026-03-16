'use strict';

/**
 * Tests for JSON PID heartbeat and stale instance detection (RB-050).
 *
 * index.js writes a JSON record {pid, startedAt, heartbeatAt} instead of
 * a raw PID number. killStaleInstance() checks heartbeat freshness before
 * deciding whether to kill — a recent heartbeat (<30s) means the process
 * is actively running, so it skips the kill.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

let testDataDir = null;
let execFileSyncSpy;
let _execSyncSpy;

const mockDb = {
  getDataDir: vi.fn(() => testDataDir),
  init: vi.fn(),
  close: vi.fn(),
  getDbInstance: vi.fn(() => ({})),
  listTasks: vi.fn(() => []),
  updateTaskStatus: vi.fn(),
  decrementHostTasks: vi.fn(),
  getConfig: vi.fn(() => null),
};

const mockTaskManager = {
  getRunningTaskCount: vi.fn(() => 0),
  shutdown: vi.fn(),
  unregisterInstance: vi.fn(),
  registerInstance: vi.fn(),
  startInstanceHeartbeat: vi.fn(),
  processQueue: vi.fn(),
  updateInstanceInfo: vi.fn(),
  getMcpInstanceId: vi.fn(() => 'test-instance'),
  hasRunningProcess: vi.fn(() => false),
  isInstanceAlive: vi.fn(() => false),
};

const mockWorkflowRuntime = {
  handleWorkflowTermination: vi.fn(),
};

const mockLoggerChild = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockLogger = {
  child: vi.fn(() => mockLoggerChild),
};

const mockDashboardServer = {
  start: vi.fn(async () => ({ success: false })),
  stop: vi.fn(),
};

const mockApiServer = {
  start: vi.fn(async () => ({ success: false })),
  stop: vi.fn(),
};

const mockDiscovery = {
  initDiscovery: vi.fn(),
  initAutoScanFromConfig: vi.fn(),
  stopAutoScan: vi.fn(),
  shutdownDiscovery: vi.fn(),
};

const mockGpuMetricsServer = {
  start: vi.fn(async () => ({ success: false })),
  stop: vi.fn(),
};

const mockMcpSse = {
  start: vi.fn(async () => ({ success: false })),
  stop: vi.fn(),
};

const mockMcp = {
  start: vi.fn(async () => ({ success: false })),
  stop: vi.fn(),
};

const mockAutoVerifyRetry = {
  init: vi.fn(),
};

const mockRemoteAgentRegistryInstance = {
  runHealthChecks: vi.fn(async () => []),
};

const mockRemoteAgentRegistry = {
  RemoteAgentRegistry: vi.fn(() => mockRemoteAgentRegistryInstance),
};

function registerStartupDependencyMocks() {
  vi.doMock('../logger', () => mockLogger);
  vi.doMock('../database', () => mockDb);
  vi.doMock('../task-manager', () => mockTaskManager);
  vi.doMock('../dashboard-server', () => mockDashboardServer);
  vi.doMock('../api-server', () => mockApiServer);
  vi.doMock('../discovery', () => mockDiscovery);
  vi.doMock('../scripts/gpu-metrics-server', () => mockGpuMetricsServer);
  vi.doMock('../mcp-sse', () => mockMcpSse);
  vi.doMock('../mcp', () => mockMcp);
  vi.doMock('../validation/auto-verify-retry', () => mockAutoVerifyRetry);
  vi.doMock('../execution/workflow-runtime', () => mockWorkflowRuntime);
  vi.doMock('../remote/agent-registry', () => mockRemoteAgentRegistry);
}

vi.mock('../logger', () => mockLogger);
vi.mock('../database', () => mockDb);
vi.mock('../task-manager', () => mockTaskManager);
vi.mock('../dashboard-server', () => mockDashboardServer);
vi.mock('../api-server', () => mockApiServer);
vi.mock('../discovery', () => mockDiscovery);
vi.mock('../scripts/gpu-metrics-server', () => mockGpuMetricsServer);
vi.mock('../mcp-sse', () => mockMcpSse);
vi.mock('../mcp', () => mockMcp);
vi.mock('../validation/auto-verify-retry', () => mockAutoVerifyRetry);
vi.mock('../execution/workflow-runtime', () => mockWorkflowRuntime);
vi.mock('../remote/agent-registry', () => mockRemoteAgentRegistry);

function loadIndex(tempDir) {
  testDataDir = tempDir;
  // Reset the module graph so PID_FILE picks up the per-test temp dir, then
  // re-register startup mocks so the fresh CommonJS index require resolves
  // against the mocked startup dependency graph during orphan cleanup.
  vi.resetModules();
  registerStartupDependencyMocks();
  return require('../index');
}

describe('PID heartbeat stale detection (RB-050)', () => {
  let tempDir;
  let index;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-pid-heartbeat-'));
    mockDb.listTasks.mockReturnValue([]);
    mockTaskManager.getRunningTaskCount.mockReturnValue(0);
    mockTaskManager.getMcpInstanceId.mockReturnValue('test-instance');
    mockTaskManager.hasRunningProcess.mockReturnValue(false);
    mockTaskManager.isInstanceAlive.mockReturnValue(false);
    execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => '');
    _execSyncSpy = vi.spyOn(childProcess, 'execSync').mockImplementation(() => 'node torque/server/index.js');
    index = loadIndex(tempDir);
  });

  afterEach(() => {
    try { index?._testing?.resetForTest(); } catch { /* ignore */ }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes PID JSON and updates heartbeat every 10 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T00:00:00.000Z'));

    const startedAt = '2026-03-02T23:59:55.000Z';
    index._testing.startPidHeartbeat(startedAt);

    const pidPath = index._testing.PID_FILE;
    const first = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    expect(first.pid).toBe(process.pid);
    expect(first.startedAt).toBe(startedAt);
    expect(first.heartbeatAt).toBe('2026-03-03T00:00:00.000Z');

    vi.advanceTimersByTime(index._testing.PID_HEARTBEAT_INTERVAL_MS);

    const second = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    expect(second.startedAt).toBe(startedAt);
    expect(Date.parse(second.heartbeatAt)).toBe(Date.parse('2026-03-03T00:00:10.000Z'));
  });

  it('skips kill when heartbeat is recent (<30s)', () => {
    const oldPid = 45678;
    const nowIso = new Date().toISOString();
    const pidPath = index._testing.PID_FILE;
    fs.writeFileSync(pidPath, JSON.stringify({
      pid: oldPid,
      startedAt: nowIso,
      heartbeatAt: nowIso,
    }), 'utf8');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    index.killStaleInstance();

    expect(killSpy).toHaveBeenCalledWith(oldPid, 0);
    expect(fs.existsSync(pidPath)).toBe(true);
    expect(stderrSpy).toHaveBeenCalled();
    expect(String(stderrSpy.mock.calls[0][0])).toContain('heartbeat is recent');
    expect(execFileSyncSpy).not.toHaveBeenCalled();
  });

  it('kills stale JSON PID records when heartbeat is old or missing', () => {
    const oldPid = 56789;
    const staleIso = new Date(Date.now() - 31000).toISOString();
    const pidPath = index._testing.PID_FILE;
    fs.writeFileSync(pidPath, JSON.stringify({
      pid: oldPid,
      startedAt: new Date(Date.now() - 60000).toISOString(),
      heartbeatAt: staleIso,
    }), 'utf8');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    index.killStaleInstance();

    expect(killSpy).toHaveBeenCalledWith(oldPid, 0);
    if (process.platform === 'win32') {
      expect(execFileSyncSpy).toHaveBeenCalled();
    } else {
      expect(killSpy).toHaveBeenCalledWith(oldPid, 'SIGTERM');
    }
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('falls back to legacy raw PID format and treats it as stale', () => {
    const oldPid = 67890;
    const pidPath = index._testing.PID_FILE;
    fs.writeFileSync(pidPath, String(oldPid), 'utf8');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    index.killStaleInstance();

    expect(killSpy).toHaveBeenCalledWith(oldPid, 0);
    if (process.platform === 'win32') {
      expect(execFileSyncSpy).toHaveBeenCalled();
    } else {
      expect(killSpy).toHaveBeenCalledWith(oldPid, 'SIGTERM');
    }
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('clears PID heartbeat interval during graceful shutdown', async () => {
    vi.useFakeTimers();
    index._testing.startPidHeartbeat(new Date().toISOString());
    expect(index._testing.getPidHeartbeatInterval()).not.toBeNull();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);

    // gracefulShutdown defers performShutdown behind a 5s drain timeout
    const shutdownPromise = index.gracefulShutdown('SIGTERM');
    vi.advanceTimersByTime(6000);
    await shutdownPromise;

    expect(index._testing.getPidHeartbeatInterval()).toBeNull();
    expect(exitSpy).toHaveBeenCalled();
  });

});
