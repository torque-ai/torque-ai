'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  acquireSelectedLaneLock,
  acquireLaneLock,
  buildLaneEnv,
  getPresetCommand,
  isAutoLane,
  parseArgs,
  releaseLaneLock,
  resolveLaneConfig,
} = require('../../scripts/test-lane');

describe('test-lane script helpers', () => {
  test('maps local lanes to deterministic isolated ports and roots', () => {
    const config = resolveLaneConfig(2, { root: 'C:\\tmp\\torque-test-lanes', platform: 'win32', env: {} });

    expect(config.lane).toBe(2);
    expect(config.dashboardPort).toBe(3556);
    expect(config.apiPort).toBe(3557);
    expect(config.mcpPort).toBe(3558);
    expect(config.gpuMetricsPort).toBe(9494);
    expect(config.dashboardDevPort).toBe(5273);
    expect(config.dataDir.replace(/\\/g, '/')).toContain('/lane-2/data');
  });

  test('rejects invalid lane identifiers', () => {
    expect(() => resolveLaneConfig(0)).toThrow(/Lane must be an integer/);
    expect(() => resolveLaneConfig(5)).toThrow(/Lane must be an integer/);
    expect(() => resolveLaneConfig('abc')).toThrow(/Lane must be an integer/);
    expect(isAutoLane('auto')).toBe(true);
    expect(isAutoLane(null)).toBe(true);
  });

  test('builds the environment contract for lane-aware tests', () => {
    const config = resolveLaneConfig(3, { root: path.join(os.tmpdir(), 'lane-env-test') });
    const env = buildLaneEnv(config, { PATH: 'keep-me' });

    expect(env.PATH).toBe('keep-me');
    expect(env.TORQUE_TEST_LANE).toBe('3');
    expect(env.TORQUE_DATA_DIR).toBe(config.dataDir);
    expect(env.TORQUE_DASHBOARD_PORT).toBe('3656');
    expect(env.TORQUE_API_PORT).toBe('3657');
    expect(env.TORQUE_MCP_SSE_PORT).toBe('3658');
    expect(env.TORQUE_DASHBOARD_PROXY_TARGET).toBe('http://127.0.0.1:3656');
    expect(env.TORQUE_VITEST_TEMPLATE_DIR).toBe(config.vitestTemplateDir);
    expect(env.TMP).toBe(config.tempDir);
  });

  test('lane locks block live owners and release only their own pid', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-lane-lock-'));
    const config = resolveLaneConfig(1, { root });
    const release = acquireLaneLock(config, {
      pid: 123,
      command: 'first',
      isPidAlive: (pid) => Number(pid) === 123,
      now: () => new Date('2026-05-06T00:00:00.000Z'),
    });

    expect(() => acquireLaneLock(config, {
      pid: 456,
      command: 'second',
      isPidAlive: (pid) => Number(pid) === 123,
    })).toThrow(/already locked by PID 123/);

    expect(releaseLaneLock(config.lockPath, 456)).toBe(false);
    expect(release()).toBe(true);
    expect(fs.existsSync(config.lockPath)).toBe(false);
  });

  test('lane locks reclaim stale pid files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-lane-stale-'));
    const config = resolveLaneConfig(4, { root });
    fs.mkdirSync(config.lockDir, { recursive: true });
    fs.writeFileSync(config.lockPath, JSON.stringify({ lane: 4, pid: 999, command: 'stale' }));

    const release = acquireLaneLock(config, {
      pid: 1000,
      command: 'fresh',
      isPidAlive: () => false,
    });
    const lock = JSON.parse(fs.readFileSync(config.lockPath, 'utf8'));

    expect(lock.pid).toBe(1000);
    expect(lock.command).toBe('fresh');
    expect(release()).toBe(true);
  });

  test('auto lane selection skips live locked lanes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-lane-auto-'));
    const laneOne = resolveLaneConfig(1, { root });
    fs.mkdirSync(laneOne.lockDir, { recursive: true });
    fs.writeFileSync(laneOne.lockPath, JSON.stringify({ lane: 1, pid: 111, command: 'busy' }));

    const { config, release } = acquireSelectedLaneLock('auto', {
      root,
      pid: 222,
      command: 'auto',
      isPidAlive: (pid) => Number(pid) === 111,
    });

    expect(config.lane).toBe(2);
    expect(release()).toBe(true);
  });

  test('parses launcher arguments and resolves presets', () => {
    expect(parseArgs(['--lane', '2', '--preset', 'server-file', '--file', 'server/tests/foo.test.js'])).toMatchObject({
      lane: '2',
      preset: 'server-file',
      file: 'server/tests/foo.test.js',
    });
    expect(parseArgs(['--command-base64', 'Y2Qgc2VydmVy'])).toMatchObject({
      lane: 'auto',
      commandBase64: 'Y2Qgc2VydmVy',
    });

    const preset = getPresetCommand('server-file', {
      repoRoot: 'C:\\repo\\torque-public',
      file: 'server/tests/foo.test.js',
      platform: 'win32',
    });
    expect(preset.cwd.replace(/\\/g, '/')).toBe('C:/repo/torque-public/server');
    expect(preset.command).toContain('tests/foo.test.js');
  });
});
