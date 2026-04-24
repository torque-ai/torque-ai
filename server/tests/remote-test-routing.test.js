import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const childProcess = require('child_process');
const workstationModelPath = require.resolve('../workstation/model');

const { mockSpawnSync, mockSpawn } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: mockSpawnSync,
  spawn: mockSpawn,
}));

let originalWorkstationModelCache;
let workstationModelMockInstalled = false;

function restoreWorkstationModelMock() {
  if (!workstationModelMockInstalled) return;

  if (originalWorkstationModelCache) {
    require.cache[workstationModelPath] = originalWorkstationModelCache;
  } else {
    delete require.cache[workstationModelPath];
  }

  originalWorkstationModelCache = undefined;
  workstationModelMockInstalled = false;
}

function installWorkstationModelMock(exportsValue) {
  if (!workstationModelMockInstalled) {
    originalWorkstationModelCache = require.cache[workstationModelPath];
  }

  require.cache[workstationModelPath] = {
    id: workstationModelPath,
    filename: workstationModelPath,
    loaded: true,
    exports: exportsValue,
  };

  workstationModelMockInstalled = true;
}

async function loadRemoteTestRouting(options = {}) {
  restoreWorkstationModelMock();
  vi.resetModules();
  childProcess.spawnSync = mockSpawnSync;
  childProcess.spawn = mockSpawn;

  if (options.workstationMissing) {
    installWorkstationModelMock({
      listWorkstations: vi.fn(() => {
        throw new Error('module not found');
      }),
      hasCapability: vi.fn(),
    });
  } else if (options.workstationModule) {
    installWorkstationModelMock(options.workstationModule);
  }

  return import('../plugins/remote-agents/remote-test-routing.js');
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createDb(overrides = {}) {
  return {
    getProjectFromPath: vi.fn().mockReturnValue(null),
    getProjectConfig: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function createAgentRegistry(overrides = {}) {
  return {
    getClient: vi.fn(),
    ...overrides,
  };
}

function createRemoteDb(configOverrides = {}, project = 'torque-public') {
  return createDb({
    getProjectFromPath: vi.fn().mockReturnValue(project),
    getProjectConfig: vi.fn().mockReturnValue({
      prefer_remote_tests: true,
      remote_agent_id: 'agent-1',
      remote_project_path: '/remote/torque-public',
      ...configOverrides,
    }),
  });
}

function createRemoteClient(options = {}) {
  let available = options.available ?? true;
  const client = {
    lastHealthError: options.lastHealthError,
    isAvailable: vi.fn(() => available),
    checkHealth: vi.fn(async () => {
      if (options.checkHealthError) throw options.checkHealthError;
      if (Object.prototype.hasOwnProperty.call(options, 'availableAfterHealth')) {
        available = options.availableAfterHealth;
      }
      if (Object.prototype.hasOwnProperty.call(options, 'lastHealthErrorAfterHealth')) {
        client.lastHealthError = options.lastHealthErrorAfterHealth;
      }
    }),
    sync: vi.fn(async () => {
      if (options.syncError) throw options.syncError;
      return options.syncResult || {};
    }),
    run: vi.fn(async () => {
      if (options.runError) throw options.runError;
      return options.runResult || {
        success: true,
        output: 'remote verify ok',
        error: '',
        exitCode: 0,
        durationMs: 25,
      };
    }),
  };
  return client;
}

function createMockChildProcess({
  code = 0,
  stdout = '',
  stderr = '',
  autoClose = true,
  closeOnKill = false,
} = {}) {
  const child = new EventEmitter();
  const stdoutStream = new EventEmitter();
  const stderrStream = new EventEmitter();

  stdoutStream.setEncoding = vi.fn();
  stderrStream.setEncoding = vi.fn();
  child.stdout = stdoutStream;
  child.stderr = stderrStream;
  child.kill = vi.fn((signal) => {
    if (closeOnKill && signal === 'SIGTERM') {
      child.emit('close', null);
    }
  });

  if (autoClose) {
    process.nextTick(() => {
      if (stdout) stdoutStream.emit('data', stdout);
      if (stderr) stderrStream.emit('data', stderr);
      child.emit('close', code);
    });
  }

  return child;
}

describe('remote-test-routing', () => {
  let remoteTestRouting;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSpawnSync.mockReset();
    mockSpawn.mockReset();

    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
    });

    mockSpawn.mockImplementation(() => ({
      stdout: {
        setEncoding: vi.fn(),
        on: vi.fn(),
      },
      stderr: {
        setEncoding: vi.fn(),
        on: vi.fn(),
      },
      on: vi.fn(),
      kill: vi.fn(),
    }));

    remoteTestRouting = await loadRemoteTestRouting();
  });

  afterEach(() => {
    restoreWorkstationModelMock();
  });

  it('filterSensitiveEnv removes API keys, tokens, and passwords from env objects', () => {
    const env = {
      API_KEY: 'raw-key',
      GITHUB_TOKEN: 'gh-token',
      DB_PASSWORD: 'db-pass',
      AWS_ACCESS_KEY_ID: 'aws-key',
      PATH: '/usr/bin',
      NODE_ENV: 'test',
    };

    expect(remoteTestRouting.filterSensitiveEnv(env)).toEqual({
      PATH: '/usr/bin',
      NODE_ENV: 'test',
    });
  });

  it('filterSensitiveEnv passes through non-sensitive env vars', () => {
    const env = {
      NODE_ENV: 'test',
      CI: 'true',
      FORCE_COLOR: '1',
    };

    expect(remoteTestRouting.filterSensitiveEnv(env)).toEqual(env);
  });

  it('isRemoteAuthError returns true for 401, 403, and unauthorized errors', () => {
    const messages = [
      'remote health check failed with 401',
      '403 forbidden from workstation',
      'unauthorized command not allowed by remote agent',
    ];

    for (const message of messages) {
      expect(remoteTestRouting.isRemoteAuthError(new Error(message))).toBe(true);
    }
  });

  it('isRemoteAuthError returns false for non-auth failures', () => {
    const messages = [
      'stream closed unexpectedly',
      '500 internal server error',
      'connection reset by peer',
    ];

    for (const message of messages) {
      expect(remoteTestRouting.isRemoteAuthError(new Error(message))).toBe(false);
    }
  });

  it('isRemoteExecutionTimeout returns true for timeout error messages', () => {
    expect(
      remoteTestRouting.isRemoteExecutionTimeout(
        new Error('streaming request to /run timed out after 120s')
      )
    ).toBe(true);
  });

  it("CODEX_PROVIDERS contains 'codex' and 'codex-spark'", () => {
    expect(remoteTestRouting.CODEX_PROVIDERS).toBeInstanceOf(Set);
    expect(remoteTestRouting.CODEX_PROVIDERS.has('codex')).toBe(true);
    expect(remoteTestRouting.CODEX_PROVIDERS.has('codex-spark')).toBe(true);
  });

  it('createRemoteTestRouter returns the expected public API', () => {
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry(),
      db: createDb(),
      logger: createLogger(),
    });

    expect(router).toEqual({
      runRemoteOrLocal: expect.any(Function),
      runVerifyCommand: expect.any(Function),
      getRemoteConfig: expect.any(Function),
      getCurrentBranch: expect.any(Function),
    });
  });

  it('findTestRunnerWorkstation returns the first healthy workstation with test_runners', async () => {
    const workstationModule = {
      listWorkstations: vi.fn().mockReturnValue([
        { name: 'busy', status: 'degraded', _capabilities: { test_runners: true } },
        { name: 'builder', status: 'healthy', _capabilities: { build_tools: true } },
        { name: 'runner', status: 'healthy', _capabilities: { test_runners: true } },
      ]),
      hasCapability: vi.fn((ws, capability) => ws._capabilities?.[capability] === true),
    };
    remoteTestRouting = await loadRemoteTestRouting({ workstationModule });

    expect(remoteTestRouting.findTestRunnerWorkstation()).toEqual({
      name: 'runner',
      status: 'healthy',
      _capabilities: { test_runners: true },
    });
    expect(workstationModule.listWorkstations).toHaveBeenCalledWith({ enabled: true });
    expect(workstationModule.hasCapability).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'runner' }),
      'test_runners'
    );
  });

  it('getRemoteConfig returns configured agent data and falls back remotePath to cwd', () => {
    const db = createRemoteDb({ remote_project_path: null });
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry(),
      db,
      logger: createLogger(),
    });

    expect(router.getRemoteConfig('/repo/torque-public')).toEqual({
      agentId: 'agent-1',
      remotePath: '/repo/torque-public',
    });
    expect(db.getProjectFromPath).toHaveBeenCalledWith('/repo/torque-public');
    expect(db.getProjectConfig).toHaveBeenCalledWith('torque-public');
  });

  it('getRemoteConfig auto-discovers a codex test runner when config is missing', async () => {
    const workstationModule = {
      listWorkstations: vi.fn().mockReturnValue([
        { id: 'ws-1', name: 'runner-ws', status: 'healthy', _capabilities: { test_runners: true } },
      ]),
      hasCapability: vi.fn((ws, capability) => ws._capabilities?.[capability] === true),
    };
    remoteTestRouting = await loadRemoteTestRouting({ workstationModule });
    const logger = createLogger();
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry(),
      db: createDb({
        getProjectFromPath: vi.fn().mockReturnValue('torque-public'),
        getProjectConfig: vi.fn().mockReturnValue(null),
      }),
      logger,
    });

    expect(router.getRemoteConfig('/repo/torque-public', { provider: 'codex' })).toEqual({
      agentId: 'runner-ws',
      remotePath: '/repo/torque-public',
    });
    expect(logger.info).toHaveBeenCalledWith(
      '[remote-routing] Codex auto-discover: routing verification to workstation "runner-ws"'
    );
  });

  it('getCurrentBranch trims git output and falls back to main for empty output', () => {
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry(),
      db: createDb(),
      logger: createLogger(),
    });

    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'feature/remote-tests\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

    expect(router.getCurrentBranch('/repo')).toBe('feature/remote-tests');
    expect(router.getCurrentBranch('/repo')).toBe('main');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      expect.objectContaining({ cwd: '/repo', timeout: 5000, windowsHide: true })
    );
  });

  it('createRemoteTestRouter falls back to local execution when no remote agent is configured', async () => {
    const db = createDb({
      getProjectFromPath: vi.fn().mockReturnValue('torque-public'),
      getProjectConfig: vi.fn().mockReturnValue({
        prefer_remote_tests: false,
        remote_agent_id: null,
      }),
    });
    const agentRegistry = createAgentRegistry();
    const logger = createLogger();
    const router = remoteTestRouting.createRemoteTestRouter({ agentRegistry, db, logger });

    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: 'local verify ok',
      stderr: '',
    });

    const result = await router.runRemoteOrLocal(
      'npx',
      ['vitest', 'run'],
      'C:\\repo\\torque-public',
      { timeout: 45000 }
    );

    expect(agentRegistry.getClient).not.toHaveBeenCalled();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'npx',
      ['vitest', 'run'],
      expect.objectContaining({
        cwd: 'C:\\repo\\torque-public',
        timeout: 45000,
        shell: true,
        windowsHide: true,
      })
    );
    expect(result).toMatchObject({
      success: true,
      output: 'local verify ok',
      error: '',
      exitCode: 0,
      remote: false,
    });
    expect(logger.info).toHaveBeenCalledWith('[remote-routing] Running locally: npx vitest run');
  });

  it('runRemoteOrLocal syncs, runs remotely, and sends only sanitized env', async () => {
    const client = createRemoteClient();
    const agentRegistry = createAgentRegistry({
      getClient: vi.fn().mockReturnValue(client),
    });
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry,
      db: createRemoteDb({ remote_project_path: '/remote/torque-public/server' }),
      logger: createLogger(),
    });
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: 'C:\\dev\\torque-public\n',
      stderr: '',
    });

    const result = await router.runRemoteOrLocal(
      'npx',
      ['vitest', 'run'],
      'C:\\repo\\torque-public',
      {
        branch: 'feature/tests',
        timeout: 75000,
        env: {
          OPENAI_API_KEY: 'remove',
          GH_TOKEN: 'remove',
          NODE_ENV: 'test',
          SAFE_FLAG: '1',
        },
      }
    );

    expect(result).toMatchObject({ success: true, remote: true, output: 'remote verify ok' });
    expect(agentRegistry.getClient).toHaveBeenCalledWith('agent-1');
    expect(client.sync).toHaveBeenCalledWith('torque-public', 'feature/tests');
    expect(client.run).toHaveBeenCalledWith(
      'npx',
      ['vitest', 'run'],
      expect.objectContaining({
        cwd: '/remote/torque-public/server',
        env: { NODE_ENV: 'test', SAFE_FLAG: '1' },
        timeout: 75000,
      })
    );
    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      'npx',
      expect.any(Array),
      expect.any(Object)
    );
  });

  it('runRemoteOrLocal refreshes stale health and uses the recovered remote client', async () => {
    const client = createRemoteClient({
      available: false,
      availableAfterHealth: true,
    });
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry({ getClient: vi.fn().mockReturnValue(client) }),
      db: createRemoteDb(),
      logger: createLogger(),
    });
    mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '/work/torque-public\n', stderr: '' });

    const result = await router.runRemoteOrLocal('npm', ['test'], '/repo', { branch: 'main' });

    expect(client.checkHealth).toHaveBeenCalledTimes(1);
    expect(client.sync).toHaveBeenCalledWith('torque-public', 'main');
    expect(client.run).toHaveBeenCalledTimes(1);
    expect(result.remote).toBe(true);
  });

  it('runRemoteOrLocal does not fall back locally for remote auth failures', async () => {
    const authError = new Error('remote health check failed with 401 unauthorized');
    const client = createRemoteClient({
      available: false,
      lastHealthError: authError,
    });
    const logger = createLogger();
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry({ getClient: vi.fn().mockReturnValue(client) }),
      db: createRemoteDb(),
      logger,
    });

    const result = await router.runRemoteOrLocal('npm', ['test'], '/repo', { branch: 'main' });

    expect(result).toMatchObject({
      success: false,
      remote: true,
      error: 'remote health check failed with 401 unauthorized',
      exitCode: 1,
    });
    expect(client.checkHealth).toHaveBeenCalledTimes(1);
    expect(client.run).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[remote-routing] Remote auth failed, not falling back: remote health check failed with 401 unauthorized'
    );
  });

  it('runRemoteOrLocal does not fall back locally for remote /run streaming timeouts', async () => {
    const runError = new Error('streaming request to /run timed out after 120s');
    const client = createRemoteClient({ runError });
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry({ getClient: vi.fn().mockReturnValue(client) }),
      db: createRemoteDb(),
      logger: createLogger(),
    });
    mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '/work/torque-public\n', stderr: '' });

    const result = await router.runRemoteOrLocal('npm', ['test'], '/repo', { branch: 'main' });

    expect(result).toMatchObject({
      success: false,
      remote: true,
      error: 'streaming request to /run timed out after 120s',
      exitCode: 1,
    });
    expect(client.run).toHaveBeenCalledTimes(1);
    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      'npm',
      expect.any(Array),
      expect.any(Object)
    );
  });

  it('runRemoteOrLocal injects dotnet test --blame-hang-timeout 30s for remote runs', async () => {
    const client = createRemoteClient();
    const originalArgs = ['test', 'Torque.sln'];
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry({ getClient: vi.fn().mockReturnValue(client) }),
      db: createRemoteDb(),
      logger: createLogger(),
    });
    mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '/work/torque-public\n', stderr: '' });

    await router.runRemoteOrLocal('dotnet', originalArgs, '/repo', { branch: 'main' });

    expect(client.run).toHaveBeenCalledWith(
      'dotnet',
      ['test', 'Torque.sln', '--blame-hang-timeout', '30s'],
      expect.any(Object)
    );
    expect(originalArgs).toEqual(['test', 'Torque.sln']);
  });

  it('runRemoteOrLocal falls back to main branch and remotePath project name', async () => {
    const client = createRemoteClient();
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry({ getClient: vi.fn().mockReturnValue(client) }),
      db: createRemoteDb({ remote_project_path: '/opt/agents/torque-server' }),
      logger: createLogger(),
    });
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

    await router.runRemoteOrLocal('npm', ['test'], '/repo/torque-public');

    expect(client.sync).toHaveBeenCalledWith('torque-server', 'main');
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      1,
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      expect.objectContaining({ cwd: '/repo/torque-public' })
    );
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['rev-parse', '--show-toplevel'],
      expect.objectContaining({ cwd: '/repo/torque-public' })
    );
  });

  it('runVerifyCommand treats empty commands as immediate local success', async () => {
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry(),
      db: createDb(),
      logger: createLogger(),
    });

    await expect(router.runVerifyCommand('   ', '/repo')).resolves.toEqual({
      success: true,
      output: '',
      error: '',
      exitCode: 0,
      durationMs: 0,
      remote: false,
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('runVerifyCommand resolves async local success output', async () => {
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry(),
      db: createDb(),
      logger: createLogger(),
    });
    mockSpawn.mockReturnValueOnce(createMockChildProcess({
      code: 0,
      stdout: 'verify ok\n',
    }));

    const result = await router.runVerifyCommand('npm test && npm run lint', '/repo', {
      timeout: 9000,
    });

    expect(result).toMatchObject({
      success: true,
      output: 'verify ok\n',
      error: '',
      exitCode: 0,
      remote: false,
      timedOut: false,
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      'npm test && npm run lint',
      expect.objectContaining({
        cwd: '/repo',
        windowsHide: true,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
  });

  it('runVerifyCommand isolates pytest temp roots for local Windows verifies', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry(),
      db: createDb(),
      logger: createLogger(),
    });
    mockSpawn.mockReturnValueOnce(createMockChildProcess({
      code: 0,
      stdout: 'pytest ok\n',
    }));

    await router.runVerifyCommand('py -3.12 -m pytest tests/ -q', '/repo');

    expect(mockSpawn).toHaveBeenCalledWith(
      'py -3.12 -m pytest tests/ -q',
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({
          TEMP: expect.stringContaining('torque-verify-runtime'),
          TMP: expect.stringContaining('torque-verify-runtime'),
          TMPDIR: expect.stringContaining('torque-verify-runtime'),
        }),
      }),
    );
    const spawnEnv = mockSpawn.mock.calls.at(-1)?.[1]?.env || {};
    expect(spawnEnv.PYTEST_DEBUG_TEMPROOT).toBeUndefined();
  });

  it('runVerifyCommand resolves async local failure output', async () => {
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry(),
      db: createDb(),
      logger: createLogger(),
    });
    mockSpawn.mockReturnValueOnce(createMockChildProcess({
      code: 2,
      stdout: 'partial\n',
      stderr: 'verify failed\n',
    }));

    const result = await router.runVerifyCommand('npm test', '/repo');

    expect(result).toMatchObject({
      success: false,
      output: 'partial\n',
      error: 'verify failed\n',
      exitCode: 2,
      remote: false,
      timedOut: false,
    });
  });

  it('runVerifyCommand times out async local verifies and terminates the child', async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChildProcess({ autoClose: false, closeOnKill: true });
      const router = remoteTestRouting.createRemoteTestRouter({
        agentRegistry: createAgentRegistry(),
        db: createDb(),
        logger: createLogger(),
      });
      mockSpawn.mockReturnValueOnce(child);

      const promise = router.runVerifyCommand('npm test', '/repo', { timeout: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      await vi.advanceTimersByTimeAsync(5000);

      expect(result).toMatchObject({
        success: false,
        output: '',
        error: 'Verify command timed out after 1s',
        exitCode: 124,
        remote: false,
        timedOut: true,
      });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('runVerifyCommand sends remote shell command unchanged with sanitized env', async () => {
    const client = createRemoteClient();
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry({ getClient: vi.fn().mockReturnValue(client) }),
      db: createRemoteDb({ remote_project_path: '/remote/torque-public/server' }),
      logger: createLogger(),
    });
    mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '/work/torque-public\n', stderr: '' });

    const result = await router.runVerifyCommand(
      'npx vitest run && npm run lint',
      '/repo',
      {
        branch: 'dev',
        timeout: 123000,
        env: {
          NPM_TOKEN: 'remove',
          CUSTOM_FLAG: 'keep',
        },
      }
    );

    expect(result.remote).toBe(true);
    expect(client.sync).toHaveBeenCalledWith('torque-public', 'dev');
    expect(client.run).toHaveBeenCalledWith(
      'npx vitest run && npm run lint',
      undefined,
      expect.objectContaining({
        cwd: '/remote/torque-public/server',
        env: { CUSTOM_FLAG: 'keep' },
        timeout: 123000,
      })
    );
  });

  it('runVerifyCommand does not fall back locally for remote /run streaming timeouts', async () => {
    const client = createRemoteClient({
      runError: new Error('streaming request to /run timed out while waiting for output'),
    });
    const router = remoteTestRouting.createRemoteTestRouter({
      agentRegistry: createAgentRegistry({ getClient: vi.fn().mockReturnValue(client) }),
      db: createRemoteDb(),
      logger: createLogger(),
    });
    mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '/work/torque-public\n', stderr: '' });

    const result = await router.runVerifyCommand('npm test', '/repo', { branch: 'main' });

    expect(result).toMatchObject({
      success: false,
      remote: true,
      error: 'streaming request to /run timed out while waiting for output',
      exitCode: 1,
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('SENSITIVE_ENV_PATTERNS matches expected secret key families', () => {
    const matchesAny = (key) =>
      remoteTestRouting.SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key));

    expect(matchesAny('AWS_ACCESS_KEY_ID')).toBe(true);
    expect(matchesAny('AZURE_CLIENT_SECRET')).toBe(true);
    expect(matchesAny('API_KEY')).toBe(true);
    expect(matchesAny('OPENAI_API_KEY')).toBe(true);
    expect(matchesAny('GITHUB_TOKEN')).toBe(true);
    expect(matchesAny('DATABASE_URL')).toBe(true);
    expect(matchesAny('NODE_ENV')).toBe(false);
  });

  it('findTestRunnerWorkstation returns null when no workstation module is available', async () => {
    remoteTestRouting = await loadRemoteTestRouting({ workstationMissing: true });

    expect(remoteTestRouting.findTestRunnerWorkstation()).toBeNull();
  });
});
