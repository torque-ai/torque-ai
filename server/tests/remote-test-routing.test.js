import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const childProcess = require('child_process');

const { mockSpawnSync, mockSpawn } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: mockSpawnSync,
  spawn: mockSpawn,
}));

async function loadRemoteTestRouting(options = {}) {
  vi.resetModules();
  childProcess.spawnSync = mockSpawnSync;
  childProcess.spawn = mockSpawn;
  vi.doUnmock('../workstation/model');

  if (options.workstationMissing) {
    vi.doMock('../workstation/model', () => {
      throw new Error('module not found');
    });
  } else if (options.workstationModule) {
    vi.doMock('../workstation/model', () => options.workstationModule);
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
