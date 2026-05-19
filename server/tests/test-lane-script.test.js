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
  isFocusedVitestCoverageCommand,
  main,
  normalizeRootScopedRequirePaths,
  normalizeServerVitestCommand,
  parseArgs,
  prepareSelectedCommandDependencies,
  releaseLaneLock,
  resolveLaneConfig,
  unavailableLanePorts,
} = require('../../scripts/test-lane');

describe('test-lane script helpers', () => {
  test('maps local lanes to deterministic isolated ports and roots', () => {
    const config = resolveLaneConfig(2, { root: 'C:\\tmp\\torque-test-lanes', platform: 'win32', env: {} });

    expect(config.lane).toBe(2);
    expect(config.dashboardPort).toBe(3556);
    expect(config.apiPort).toBe(3557);
    expect(config.mcpPort).toBe(3558);
    expect(config.mcpGatewayPort).toBe(3559);
    expect(config.gpuMetricsPort).toBe(9494);
    expect(config.coordPort).toBe(9495);
    expect(config.dashboardDevPort).toBe(5273);
    expect(config.dataDir.replace(/\\/g, '/')).toContain('/lane-2/data');
    expect(config.mcpArtifactsDir.replace(/\\/g, '/')).toContain('/lane-2/artifacts/mcp');
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
    expect(env.TORQUE_MCP_GATEWAY_PORT).toBe('3659');
    expect(env.TORQUE_MCP_GATEWAY_URL).toBe('http://127.0.0.1:3659');
    expect(env.TORQUE_GPU_METRICS_PORT).toBe('9594');
    expect(env.TORQUE_COORD_HOST).toBe('127.0.0.1');
    expect(env.TORQUE_COORD_PORT).toBe('9595');
    expect(env.TORQUE_DASHBOARD_PROXY_TARGET).toBe('http://127.0.0.1:3656');
    expect(env.TORQUE_ARTIFACT_DIR).toBe(config.artifactsDir);
    expect(env.TORQUE_MCP_ARTIFACT_DIR).toBe(config.mcpArtifactsDir);
    expect(env.TORQUE_MCP_LAUNCH_REPORT).toBe(path.join(config.mcpArtifactsDir, 'launch-readiness.json'));
    expect(env.TORQUE_MCP_DUAL_AGENT_REPORT).toBe(path.join(config.mcpArtifactsDir, 'dual-agent-validation.json'));
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

  test('auto lane selection skips locks that are being written or cannot be reclaimed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-lane-auto-race-'));
    const laneOne = resolveLaneConfig(1, { root });
    const laneTwo = resolveLaneConfig(2, { root });
    fs.mkdirSync(laneOne.lockDir, { recursive: true });
    fs.writeFileSync(laneOne.lockPath, '{');
    fs.writeFileSync(laneTwo.lockPath, JSON.stringify({ lane: 2, pid: 999, command: 'stale' }));

    const { config, release } = acquireSelectedLaneLock('auto', {
      root,
      pid: 333,
      command: 'auto',
      isPidAlive: () => false,
      unlinkLock: (lockPath) => {
        if (lockPath === laneTwo.lockPath) {
          const err = new Error('file busy');
          err.code = 'EPERM';
          throw err;
        }
        fs.unlinkSync(lockPath);
      },
    });

    expect(config.lane).toBe(3);
    expect(release()).toBe(true);
  });

  test('reports unavailable lane ports by service label', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-lane-ports-'));
    const laneOne = resolveLaneConfig(1, { root });

    expect(unavailableLanePorts(laneOne, {
      isPortAvailable: (port) => port !== laneOne.apiPort && port !== laneOne.dashboardDevPort,
    })).toEqual([
      `api=${laneOne.apiPort}`,
      `vite=${laneOne.dashboardDevPort}`,
    ]);
  });

  test('auto lane selection skips lanes with occupied configured ports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-lane-auto-ports-'));
    const laneOne = resolveLaneConfig(1, { root });
    const checkedPorts = [];

    const { config, release } = acquireSelectedLaneLock('auto', {
      root,
      pid: 444,
      command: 'auto-ports',
      isPidAlive: () => false,
      isPortAvailable: (port) => {
        checkedPorts.push(port);
        return port !== laneOne.dashboardPort;
      },
    });

    expect(config.lane).toBe(2);
    expect(checkedPorts).toContain(laneOne.dashboardPort);
    expect(release()).toBe(true);
  });

  test('explicit lane selection does not probe port availability', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-lane-explicit-ports-'));

    const { config, release } = acquireSelectedLaneLock('1', {
      root,
      pid: 555,
      command: 'explicit',
      isPidAlive: () => false,
      isPortAvailable: () => {
        throw new Error('port probe should not run for explicit lanes');
      },
    });

    expect(config.lane).toBe(1);
    expect(release()).toBe(true);
  });

  test('prepares dependencies for the selected command cwd', () => {
    const selected = { cwd: 'C:\\repo\\torque-public\\.worktrees\\feat-x\\server', command: 'npm test' };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = { prepared: true, packages: [] };
    const prepareWorktreeVerifyDependencies = vi.fn(() => result);

    expect(prepareSelectedCommandDependencies(selected, {
      logger,
      prepareWorktreeVerifyDependencies,
    })).toBe(result);
    expect(prepareWorktreeVerifyDependencies).toHaveBeenCalledWith(selected.cwd, logger);
  });

  test('main prepares dependencies before acquiring a lane and running the command', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-lane-main-deps-'));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const prepareWorktreeVerifyDependencies = vi.fn(() => ({ prepared: false, reason: 'not_managed_worktree', packages: [] }));
    const runShellCommand = vi.fn(() => ({ status: 0 }));

    const status = main(['--lane', '1', '--root', root, '--command', 'node -e "process.exit(0)"'], {
      logger,
      prepareWorktreeVerifyDependencies,
      runShellCommand,
    });

    expect(status).toBe(0);
    expect(prepareWorktreeVerifyDependencies).toHaveBeenCalledTimes(1);
    expect(runShellCommand).toHaveBeenCalledWith(
      'node -e "process.exit(0)"',
      expect.objectContaining({
        env: expect.objectContaining({ TORQUE_TEST_LANE: '1' }),
      })
    );
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

  test('normalizes root-scoped server vitest commands into the server package', () => {
    const selected = normalizeServerVitestCommand(
      'npx vitest run server/tests/tool-mapping.test.js --coverage',
      { repoRoot: 'C:\\repo\\torque-public' }
    );

    expect(selected.cwd.replace(/\\/g, '/')).toBe('C:/repo/torque-public/server');
    expect(selected.command).toBe('npx vitest run tests/tool-mapping.test.js --coverage');
    expect(selected.focusedCoverage).toBe(true);
  });

  test('normalizes root-scoped node require probes in decoded lane commands', () => {
    const command = 'node -e "require(\'server/db/adversarial-reviews.js\')" && npx vitest run server/tests/retrospectives.test.js';
    const selected = normalizeServerVitestCommand(command, { repoRoot: 'C:\\repo\\torque-public' });

    expect(normalizeRootScopedRequirePaths(command)).toContain("require('./server/db/adversarial-reviews.js')");
    expect(selected.cwd.replace(/\\/g, '/')).toBe('C:/repo/torque-public');
    expect(selected.command).toContain("require('./server/db/adversarial-reviews.js')");
  });

  test('detects focused coverage commands without marking full-suite coverage', () => {
    expect(isFocusedVitestCoverageCommand('cd server && npx vitest run tests/tool-mapping.test.js --coverage')).toBe(true);
    expect(isFocusedVitestCoverageCommand('npx vitest run --coverage')).toBe(false);
  });

  test('vitest config relaxes global thresholds for focused lane coverage', () => {
    const configPath = path.resolve(__dirname, '..', 'vitest.config.js');
    const previous = process.env.TORQUE_FOCUSED_VITEST_COVERAGE;
    delete require.cache[configPath];
    process.env.TORQUE_FOCUSED_VITEST_COVERAGE = '1';
    try {
      const config = require(configPath);
      expect(config.test.coverage.thresholds).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.TORQUE_FOCUSED_VITEST_COVERAGE;
      else process.env.TORQUE_FOCUSED_VITEST_COVERAGE = previous;
      delete require.cache[configPath];
    }
  });
});
