'use strict';

const childProcess = require('child_process');

const { EventEmitter } = require('events');

const originalSpawnSync = childProcess.spawnSync;
const originalSpawn = childProcess.spawn;
const mockSpawnSync = vi.fn();
const mockSpawn = vi.fn();

/**
 * Create a mock child process that emits close with given stdout/stderr/code.
 */
function makeMockChild(code, stdout = '', stderr = '') {
  const child = new EventEmitter();
  const stdoutStream = new EventEmitter();
  const stderrStream = new EventEmitter();
  stdoutStream.setEncoding = vi.fn();
  stderrStream.setEncoding = vi.fn();
  child.stdout = stdoutStream;
  child.stderr = stderrStream;
  child.kill = vi.fn();
  // Emit data + close on next tick
  process.nextTick(() => {
    if (stdout) stdoutStream.emit('data', stdout);
    if (stderr) stderrStream.emit('data', stderr);
    child.emit('close', code);
  });
  return child;
}

function loadRoutingModule() {
  childProcess.spawnSync = mockSpawnSync;
  childProcess.spawn = mockSpawn;
  const modPath = require.resolve('../remote/remote-test-routing');
  delete require.cache[modPath];
  const mod = require('../remote/remote-test-routing');
  childProcess.spawnSync = originalSpawnSync;
  childProcess.spawn = originalSpawn;
  return mod;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeClient({
  available = true,
  runResult = {
    success: true,
    output: 'remote-ok',
    error: '',
    exitCode: 0,
    durationMs: 15,
  },
  syncError = null,
  runError = null,
  checkHealthImpl = null,
} = {}) {
  let state = available;
  const client = {
    isAvailable: vi.fn(() => state),
    checkHealth: vi.fn(async () => {
      if (checkHealthImpl) {
        await checkHealthImpl({
          getAvailable: () => state,
          setAvailable: (value) => { state = value; },
        });
      }
    }),
    sync: vi.fn(async () => {
      if (syncError) throw syncError;
    }),
    run: vi.fn(async () => {
      if (runError) throw runError;
      return runResult;
    }),
  };
  return client;
}

describe('remote-test-routing', () => {
  let createRemoteTestRouter;
  let filterSensitiveEnv;

  beforeEach(() => {
    mockSpawnSync.mockReset().mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
    });
    mockSpawn.mockReset();

    const routing = loadRoutingModule();
    createRemoteTestRouter = routing.createRemoteTestRouter;
    filterSensitiveEnv = routing.filterSensitiveEnv;
  });

  afterAll(() => {
    childProcess.spawnSync = originalSpawnSync;
  });

  describe('filterSensitiveEnv', () => {
    it('removes secret-like env vars and keeps safe entries', () => {
      const result = filterSensitiveEnv({
        API_KEY: 'hide',
        TORQUE_AGENT_SECRET_KEY: 'hide',
        DATABASE_URL: 'hide',
        NODE_ENV: 'test',
        SAFE_FLAG: '1',
      });

      expect(result).toEqual({
        NODE_ENV: 'test',
        SAFE_FLAG: '1',
      });
    });
  });

  describe('getRemoteConfig', () => {
    it('returns null when db is missing', () => {
      const router = createRemoteTestRouter({
        agentRegistry: null,
        db: null,
        logger: makeLogger(),
      });

      expect(router.getRemoteConfig('/repo')).toBeNull();
    });

    it('returns null when remote tests are not enabled', () => {
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue({
          prefer_remote_tests: false,
          remote_agent_id: 'agent-1',
          remote_project_path: '/remote/torque',
        }),
      };

      const router = createRemoteTestRouter({ agentRegistry: null, db, logger: makeLogger() });
      expect(router.getRemoteConfig('/repo')).toBeNull();
    });

    it('returns null when prefer_remote_tests is enabled but no remote agent id is set', () => {
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue({
          prefer_remote_tests: true,
          remote_agent_id: null,
          remote_project_path: '/remote/torque',
        }),
      };

      const router = createRemoteTestRouter({ agentRegistry: null, db, logger: makeLogger() });
      expect(router.getRemoteConfig('/repo')).toBeNull();
    });

    it('returns configured remote settings and falls back remotePath to cwd', () => {
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue({
          prefer_remote_tests: true,
          remote_agent_id: 'agent-2',
          remote_project_path: null,
        }),
      };

      const router = createRemoteTestRouter({ agentRegistry: null, db, logger: makeLogger() });
      expect(router.getRemoteConfig('/work/torque')).toEqual({
        agentId: 'agent-2',
        remotePath: '/work/torque',
      });
    });

    it('returns null when project config lookups throw', () => {
      const db = {
        getProjectFromPath: vi.fn(() => {
          throw new Error('db unavailable');
        }),
      };

      const router = createRemoteTestRouter({ agentRegistry: null, db, logger: makeLogger() });
      expect(router.getRemoteConfig('/repo')).toBeNull();
    });
  });

  describe('getCurrentBranch', () => {
    it('reads and trims branch from git output', () => {
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: 'feature/remote-tests\n',
        stderr: '',
      });

      const router = createRemoteTestRouter({
        agentRegistry: null,
        db: {},
        logger: makeLogger(),
      });

      expect(router.getCurrentBranch('/repo')).toBe('feature/remote-tests');
      expect(mockSpawnSync).toHaveBeenCalledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'], expect.objectContaining({
        cwd: '/repo',
        timeout: 5000,
      }));
    });

    it('falls back to main when git invocation throws', () => {
      mockSpawnSync.mockImplementationOnce(() => {
        throw new Error('git not found');
      });

      const router = createRemoteTestRouter({ agentRegistry: null, db: {}, logger: makeLogger() });
      expect(router.getCurrentBranch('/repo')).toBe('main');
    });

    it('falls back to main when git returns empty stdout', () => {
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: '',
        stderr: '',
      });

      const router = createRemoteTestRouter({ agentRegistry: null, db: {}, logger: makeLogger() });
      expect(router.getCurrentBranch('/repo')).toBe('main');
    });
  });

  describe('runRemoteOrLocal', () => {
    it('runs locally when no remote config is available', async () => {
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue(null),
      };
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: 'local-ok', stderr: '' });

      const router = createRemoteTestRouter({ agentRegistry: null, db, logger: makeLogger() });
      const result = await router.runRemoteOrLocal('npm', ['test'], '/repo');

      expect(result.remote).toBe(false);
      expect(result.success).toBe(true);
      expect(result.output).toBe('local-ok');
      expect(mockSpawnSync).toHaveBeenCalledWith('npm', ['test'], expect.objectContaining({
        cwd: '/repo',
        shell: true,
      }));
    });

    it('runs remotely when client is available and filters env before run', async () => {
      const client = makeClient();
      const agentRegistry = { getClient: vi.fn().mockReturnValue(client) };
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue({
          prefer_remote_tests: true,
          remote_agent_id: 'agent-1',
          remote_project_path: '/remote/torque/server',
        }),
      };
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: 'C:\\dev\\Torque\n',
        stderr: '',
      });

      const router = createRemoteTestRouter({ agentRegistry, db, logger: makeLogger() });
      const result = await router.runRemoteOrLocal('npx', ['vitest', 'run'], '/repo', {
        branch: 'dev',
        env: {
          API_KEY: 'hide',
          GH_TOKEN: 'hide',
          SAFE_VAR: 'keep',
        },
      });

      expect(result.remote).toBe(true);
      expect(client.sync).toHaveBeenCalledWith('Torque', 'dev');
      expect(client.run).toHaveBeenCalledWith('npx', ['vitest', 'run'], expect.objectContaining({
        cwd: '/remote/torque/server',
        env: { SAFE_VAR: 'keep' },
      }));
    });

    it('injects dotnet blame timeout for remote dotnet test runs', async () => {
      const client = makeClient();
      const agentRegistry = { getClient: vi.fn().mockReturnValue(client) };
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue({
          prefer_remote_tests: true,
          remote_agent_id: 'agent-1',
          remote_project_path: '/remote/torque',
        }),
      };
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: '/work/Torque\n',
        stderr: '',
      });

      const router = createRemoteTestRouter({ agentRegistry, db, logger: makeLogger() });
      await router.runRemoteOrLocal('dotnet', ['test', 'Torque.sln'], '/repo', { branch: 'main' });

      const args = client.run.mock.calls[0][1];
      expect(args).toContain('--blame-hang-timeout');
      expect(args).toContain('30s');
    });

    it('falls back to local command when remote run throws', async () => {
      const logger = makeLogger();
      const client = makeClient({ runError: new Error('remote execution failed') });
      const agentRegistry = { getClient: vi.fn().mockReturnValue(client) };
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue({
          prefer_remote_tests: true,
          remote_agent_id: 'agent-1',
          remote_project_path: '/remote/torque',
        }),
      };
      mockSpawnSync
        .mockReturnValueOnce({ status: 0, stdout: '/work/Torque\n', stderr: '' })
        .mockReturnValueOnce({ status: 0, stdout: 'local-fallback', stderr: '' });

      const router = createRemoteTestRouter({ agentRegistry, db, logger });
      const result = await router.runRemoteOrLocal('npm', ['run', 'verify'], '/repo', { branch: 'main' });

      expect(result.remote).toBe(false);
      expect(result.output).toBe('local-fallback');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('falling back to local'));
    });

    it('performs health check for stale clients and runs remotely if recovered', async () => {
      const client = makeClient({
        available: false,
        checkHealthImpl: async ({ setAvailable }) => setAvailable(true),
      });
      const agentRegistry = { getClient: vi.fn().mockReturnValue(client) };
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue({
          prefer_remote_tests: true,
          remote_agent_id: 'agent-1',
          remote_project_path: '/remote/torque',
        }),
      };
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '/work/Torque\n', stderr: '' });

      const router = createRemoteTestRouter({ agentRegistry, db, logger: makeLogger() });
      const result = await router.runRemoteOrLocal('npm', ['test'], '/repo', { branch: 'main' });

      expect(client.checkHealth).toHaveBeenCalledTimes(1);
      expect(client.run).toHaveBeenCalledTimes(1);
      expect(result.remote).toBe(true);
    });

    it('falls back to local when stale client remains unavailable after health check', async () => {
      const client = makeClient({
        available: false,
        checkHealthImpl: async () => {},
      });
      const agentRegistry = { getClient: vi.fn().mockReturnValue(client) };
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue({
          prefer_remote_tests: true,
          remote_agent_id: 'agent-1',
          remote_project_path: '/remote/torque',
        }),
      };
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: 'local-only', stderr: '' });

      const router = createRemoteTestRouter({ agentRegistry, db, logger: makeLogger() });
      const result = await router.runRemoteOrLocal('npm', ['test'], '/repo', { branch: 'main' });

      expect(client.checkHealth).toHaveBeenCalledTimes(1);
      expect(client.run).not.toHaveBeenCalled();
      expect(result.remote).toBe(false);
      expect(result.output).toBe('local-only');
    });

    it('uses remote path segment as sync project name when git toplevel is empty', async () => {
      const client = makeClient();
      const agentRegistry = { getClient: vi.fn().mockReturnValue(client) };
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue({
          prefer_remote_tests: true,
          remote_agent_id: 'agent-1',
          remote_project_path: '/opt/agents/torque-server',
        }),
      };
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: '',
        stderr: '',
      });

      const router = createRemoteTestRouter({ agentRegistry, db, logger: makeLogger() });
      await router.runRemoteOrLocal('npm', ['test'], '/repo', { branch: 'release' });

      expect(client.sync).toHaveBeenCalledWith('torque-server', 'release');
    });
  });

  describe('runVerifyCommand', () => {
    it('preserves quoted && sequences when running locally', async () => {
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue(null),
      };
      mockSpawn.mockReturnValueOnce(makeMockChild(0, 'a && b', ''));

      const router = createRemoteTestRouter({ agentRegistry: null, db, logger: makeLogger() });
      const command = 'node -e "process.stdout.write(\'a && b\')"';
      const result = await router.runVerifyCommand(command, '/repo');

      expect(result.success).toBe(true);
      expect(result.output).toBe('a && b');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(command, expect.objectContaining({
        cwd: '/repo',
        shell: true,
      }));
    });

    it('preserves quoted file paths with spaces when running locally', async () => {
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue(null),
      };
      mockSpawn.mockReturnValueOnce(makeMockChild(0, 'path-ok\n', ''));

      const router = createRemoteTestRouter({ agentRegistry: null, db, logger: makeLogger() });
      const command = 'node "C:\\\\Program Files\\\\Torque Tests\\\\verify script.js"';
      const result = await router.runVerifyCommand(command, '/repo');

      expect(result.success).toBe(true);
      expect(result.output).toBe('path-ok\n');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(command, expect.objectContaining({
        cwd: '/repo',
        shell: true,
      }));
    });

    it('runs multi-step commands with && through the shell as a single command', async () => {
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue(null),
      };
      mockSpawn.mockReturnValueOnce(makeMockChild(0, 'first\nsecond\n', ''));

      const router = createRemoteTestRouter({ agentRegistry: null, db, logger: makeLogger() });
      const command = 'npm test && npm run lint';
      const result = await router.runVerifyCommand(command, '/repo');

      expect(result.success).toBe(true);
      expect(result.output).toBe('first\nsecond\n');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(command, expect.objectContaining({
        cwd: '/repo',
        shell: true,
      }));
    });

    it('returns the shell failure result when a chained command fails', async () => {
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue(null),
      };
      mockSpawn.mockReturnValueOnce(makeMockChild(1, 'failed\n', 'boom\n'));

      const router = createRemoteTestRouter({ agentRegistry: null, db, logger: makeLogger() });
      const result = await router.runVerifyCommand('npm test && npm run lint', '/repo');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('failed\n');
      expect(result.error).toBe('boom\n');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('returns success for empty verify command strings', async () => {
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue(null),
      };
      const router = createRemoteTestRouter({ agentRegistry: null, db, logger: makeLogger() });

      const result = await router.runVerifyCommand('   ', '/repo');
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('passes multi-step verify commands to the remote executor unchanged', async () => {
      const client = makeClient();
      const agentRegistry = { getClient: vi.fn().mockReturnValue(client) };
      const db = {
        getProjectFromPath: vi.fn().mockReturnValue('torque'),
        getProjectConfig: vi.fn().mockReturnValue({
          prefer_remote_tests: true,
          remote_agent_id: 'agent-1',
          remote_project_path: '/remote/torque/server',
        }),
      };
      mockSpawnSync
        .mockReturnValueOnce({ status: 0, stdout: '/workspace/Torque\n', stderr: '' })
        .mockReturnValue({ status: 0, stdout: '/workspace/Torque\n', stderr: '' });

      const router = createRemoteTestRouter({ agentRegistry, db, logger: makeLogger() });
      const command = 'npm test && npm run lint';
      const result = await router.runVerifyCommand(command, '/repo', { branch: 'dev' });

      expect(result.success).toBe(true);
      expect(result.remote).toBe(true);
      expect(client.run).toHaveBeenCalledTimes(1);
      expect(client.run).toHaveBeenCalledWith(command, undefined, expect.objectContaining({
        cwd: '/remote/torque/server',
      }));
    });
  });
});
