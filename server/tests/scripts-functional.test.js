/**
 * Functional Tests: server/scripts/
 *
 * Tests exported functions from scripts that have testable module APIs.
 * Scripts that are one-time/legacy or require live infrastructure are excluded.
 */

'use strict';

const path = require('path');

// ────────────────────────────────────────────────────────────────
// gpu-metrics-server.js
// ────────────────────────────────────────────────────────────────
describe('gpu-metrics-server', () => {
  let gpuMetrics;

  beforeAll(() => {
    gpuMetrics = require('../scripts/gpu-metrics-server');
  });

  afterEach(() => {
    gpuMetrics.stop();
  });

  it('exports start and stop functions', () => {
    expect(typeof gpuMetrics.start).toBe('function');
    expect(typeof gpuMetrics.stop).toBe('function');
  });

  it('start returns an object with success and hasGpu', async () => {
    const result = await gpuMetrics.start({ port: 0 }); // port 0 = random available
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('hasGpu');
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.hasGpu).toBe('boolean');
  });

  it('stop is idempotent (safe to call multiple times)', () => {
    expect(() => gpuMetrics.stop()).not.toThrow();
    expect(() => gpuMetrics.stop()).not.toThrow();
  });
});


// ────────────────────────────────────────────────────────────────
// mcp-launch-readiness.js — normalizeReportPath
// ────────────────────────────────────────────────────────────────
describe('mcp-launch-readiness (normalizeReportPath)', () => {
  // Re-implement the logic for isolated testing since it's not exported
  const ROOT_DIR = path.resolve(__dirname, '..');

  function normalizeReportPath(rawPath) {
    if (!rawPath) return null;
    if (path.isAbsolute(rawPath)) return rawPath;
    const adjustedPath = rawPath.replace(/^\.?[\\/]*server[\\/]+/i, '');
    return path.resolve(ROOT_DIR, adjustedPath);
  }

  it('returns null for falsy input', () => {
    expect(normalizeReportPath(null)).toBeNull();
    expect(normalizeReportPath('')).toBeNull();
    expect(normalizeReportPath(undefined)).toBeNull();
  });

  it('returns absolute paths unchanged', () => {
    const absPath = process.platform === 'win32'
      ? 'C:\\Users\\test\\report.json'
      : '/home/<user>/report.json';
    expect(normalizeReportPath(absPath)).toBe(absPath);
  });

  it('strips leading server/ from relative paths', () => {
    const result = normalizeReportPath('server/report.json');
    expect(result).toBe(path.resolve(ROOT_DIR, 'report.json'));
  });

  it('resolves plain relative paths from ROOT_DIR', () => {
    const result = normalizeReportPath('docs/report.json');
    expect(result).toBe(path.resolve(ROOT_DIR, 'docs/report.json'));
  });
});


describe('mcp-launch-readiness (guardPorts)', () => {
  const originalFetch = global.fetch;

  function netstatOutput(entries) {
    return entries
      .map(({ port, pid = 19860 }) => `  TCP    127.0.0.1:${port}         0.0.0.0:0              LISTENING       ${pid}`)
      .join('\n');
  }

  function managedWmic() {
    return {
      status: 0,
      stdout: 'CommandLine=node server/index.js\r\n',
    };
  }

  afterEach(() => {
    if (originalFetch === undefined) {
      delete global.fetch;
    } else {
      global.fetch = originalFetch;
    }
    const scriptPath = path.join(__dirname, '..', 'scripts', 'mcp-launch-readiness.js');
    if (require.cache[require.resolve(scriptPath)]) {
      require(scriptPath).__testables.resetRuntimeOverrides();
    }
  });

  it('reuses only a healthy managed gateway listener on the gateway port', async () => {
    const spawnSyncMock = vi.fn((command) => {
      if (command === 'netstat') {
        return { status: 0, stdout: netstatOutput([{ port: 3456 }, { port: 3457 }, { port: 3458 }, { port: 3459 }]) };
      }
      if (command === 'wmic') {
        return managedWmic();
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    global.fetch = vi.fn().mockResolvedValue({ status: 200 });

    const { __testables } = require('../scripts/mcp-launch-readiness');
    __testables.setRuntimeOverrides({
      spawn: vi.fn(),
      spawnSync: spawnSyncMock,
      fetch: global.fetch,
    });
    const result = await __testables.guardPorts();

    expect(result.reused_existing).toBe(true);
    expect(result.reused_port).toBe(3459);
    expect(result.reused_endpoint).toBe('/health');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe('http://127.0.0.1:3459/health');
    expect(spawnSyncMock.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(0);
    __testables.resetRuntimeOverrides();
  });

  it('auto-cleans managed non-gateway conflicts so launch can restart TORQUE with the gateway enabled', async () => {
    let netstatCalls = 0;
    const spawnSyncMock = vi.fn((command) => {
      if (command === 'netstat') {
        netstatCalls += 1;
        return {
          status: 0,
          stdout: netstatCalls === 1 ? netstatOutput([{ port: 3456 }, { port: 3457 }, { port: 3458 }]) : '',
        };
      }
      if (command === 'wmic') {
        return managedWmic();
      }
      if (command === 'taskkill') {
        return { status: 0 };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    global.fetch = vi.fn();

    const { __testables } = require('../scripts/mcp-launch-readiness');
    __testables.setRuntimeOverrides({
      spawn: vi.fn(),
      spawnSync: spawnSyncMock,
      fetch: global.fetch,
    });
    const result = await __testables.guardPorts();

    expect(result.reused_existing).toBe(false);
    expect(result.cleanup.attempted).toBe(true);
    expect(result.cleanup.killed).toEqual([19860]);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(spawnSyncMock.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(1);
    __testables.resetRuntimeOverrides();
  });

  it('still requires explicit cleanup when unmanaged listeners occupy target ports', async () => {
    const spawnSyncMock = vi.fn((command) => {
      if (command === 'netstat') {
        return { status: 0, stdout: netstatOutput([{ port: 3456, pid: 42424 }]) };
      }
      if (command === 'wmic') {
        return { status: 1, stdout: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    global.fetch = vi.fn();

    const { __testables } = require('../scripts/mcp-launch-readiness');
    __testables.setRuntimeOverrides({
      spawn: vi.fn(),
      spawnSync: spawnSyncMock,
      fetch: global.fetch,
    });

    await expect(__testables.guardPorts()).rejects.toThrow(
      'Port conflict requires cleanup. Set TORQUE_CLEAN_MCP_PORTS=1 to clean managed Torque listeners, or TORQUE_CLEAN_MCP_FORCE=1 to include unmanaged listeners.',
    );
    expect(spawnSyncMock.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(0);
    __testables.resetRuntimeOverrides();
  });
});


// ────────────────────────────────────────────────────────────────
// All active scripts — comprehensive import tests
// ────────────────────────────────────────────────────────────────
describe('scripts module exports', () => {
  const SCRIPTS_WITH_EXPORTS = [
    { name: 'gpu-metrics-server.js', exports: ['start', 'stop'] },
    { name: 'mcp-launch-readiness.js', exports: ['main'] },
    { name: 'mcp-readiness-pack.js', exports: ['main'] },
    { name: 'mcp-dual-agent-smoke.js', exports: ['main'] },
    { name: 'check-live-rest-readiness.js', exports: ['main'] },
    { name: 'run-live-rest-local.js', exports: ['main'] },
    { name: 'smoke-dashboard-mutations.js', exports: ['main'] },
  ];

  for (const { name, exports: expectedExports } of SCRIPTS_WITH_EXPORTS) {
    it(`${name} exports: ${expectedExports.join(', ')}`, () => {
      const scriptPath = path.join(__dirname, '..', 'scripts', name);
      delete require.cache[require.resolve(scriptPath)];
      const mod = require(scriptPath);
      for (const exp of expectedExports) {
        expect(typeof mod[exp]).toBe('function');
      }
    });
  }
});