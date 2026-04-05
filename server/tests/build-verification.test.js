import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  existsSyncMock,
  readdirSyncMock,
  spawnSyncMock,
  loggerChildMock,
  loggerModuleMock,
  createTestRunnerRegistryMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  loggerChildMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  loggerModuleMock: {
    child: vi.fn(),
  },
  createTestRunnerRegistryMock: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readdirSync: readdirSyncMock,
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock('../logger', () => ({
  child: loggerModuleMock.child,
}));

vi.mock('../test-runner-registry', () => ({
  createTestRunnerRegistry: createTestRunnerRegistryMock,
}));

const WORKING_DIR = 'C:/repo/app';

function createDb(getProjectConfig, getProjectFromPath = () => 'demo-project') {
  return {
    getProjectFromPath: vi.fn(getProjectFromPath),
    getProjectConfig: vi.fn(() => getProjectConfig()),
    saveBuildResult: vi.fn(),
  };
}

function defaultParseCommand(command) {
  const [executable, ...args] = command.split(' ');
  return { executable, args };
}

async function loadBuildVerification(deps) {
  vi.resetModules();
  const mod = await import('../validation/build-verification.js');
  const buildVerification = mod.default ?? mod;
  buildVerification.init(deps);
  return buildVerification;
}

describe('build-verification', () => {
  let buildVerification;
  let projectConfig;
  let dbMock;
  let parseCommandMock;
  let extractBuildErrorFilesMock;
  let injectedRegistry;

  beforeEach(async () => {
    vi.clearAllMocks();

    loggerModuleMock.child.mockReturnValue(loggerChildMock);
    existsSyncMock.mockReturnValue(false);
    readdirSyncMock.mockReturnValue([]);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: 'build ok',
      stderr: '',
    });
    createTestRunnerRegistryMock.mockReturnValue({
      runVerifyCommand: vi.fn(),
    });

    projectConfig = {
      build_verification_enabled: true,
      build_command: 'npm run build',
      build_timeout: 30,
    };
    dbMock = createDb(() => projectConfig);
    parseCommandMock = vi.fn(defaultParseCommand);
    extractBuildErrorFilesMock = vi.fn(() => []);
    injectedRegistry = {
      runVerifyCommand: vi.fn().mockResolvedValue({
        success: true,
        output: 'remote ok',
        error: '',
        exitCode: 0,
        remote: true,
      }),
    };

    buildVerification = await loadBuildVerification({
      db: dbMock,
      parseCommand: parseCommandMock,
      extractBuildErrorFiles: extractBuildErrorFilesMock,
      testRunnerRegistry: injectedRegistry,
    });
  });

  it('init stores db, parseCommand, extractBuildErrorFiles, and testRunnerRegistry dependencies', async () => {
    const firstConfig = {
      build_verification_enabled: true,
      build_command: 'npm run build',
      build_timeout: 15,
    };
    const secondConfig = {
      build_verification_enabled: true,
      build_command: 'npm run build',
      build_timeout: 42,
    };
    const firstDb = createDb(() => firstConfig, () => 'first-project');
    const secondDb = createDb(() => secondConfig, () => 'second-project');
    const firstParseCommand = vi.fn(defaultParseCommand);
    const secondParseCommand = vi.fn(defaultParseCommand);
    const firstExtractBuildErrorFiles = vi.fn(() => []);
    const secondExtractBuildErrorFiles = vi.fn(() => ['C:/repo/src/legacy.ts']);
    const firstRegistry = {
      runVerifyCommand: vi.fn().mockResolvedValue({
        success: true,
        output: 'first remote ok',
        error: '',
        exitCode: 0,
        remote: true,
      }),
    };
    const secondRegistry = {
      runVerifyCommand: vi.fn().mockResolvedValue({
        success: false,
        output: 'remote output',
        error: 'src/legacy.ts: compile error',
        exitCode: 2,
        remote: true,
      }),
    };

    const mod = await loadBuildVerification({
      db: firstDb,
      parseCommand: firstParseCommand,
      extractBuildErrorFiles: firstExtractBuildErrorFiles,
      testRunnerRegistry: firstRegistry,
    });

    mod.init({
      db: secondDb,
      parseCommand: secondParseCommand,
      extractBuildErrorFiles: secondExtractBuildErrorFiles,
      testRunnerRegistry: secondRegistry,
    });

    const remoteResult = await mod.runBuildVerification(
      'task-remote',
      { provider: 'codex' },
      WORKING_DIR,
      ['src/current.ts'],
    );

    expect(remoteResult.success).toBe(true);
    expect(secondDb.getProjectFromPath).toHaveBeenCalledWith(WORKING_DIR);
    expect(secondRegistry.runVerifyCommand).toHaveBeenCalledWith(
      'npm run build',
      WORKING_DIR,
      expect.objectContaining({ timeout: 42000, provider: 'codex' }),
    );
    expect(secondExtractBuildErrorFiles).toHaveBeenCalledWith(
      expect.stringContaining('src/legacy.ts: compile error'),
      WORKING_DIR,
    );
    expect(secondDb.saveBuildResult).toHaveBeenCalledWith(
      'task-remote',
      expect.objectContaining({
        command: 'npm run build',
        status: 'passed_scoped',
      }),
    );
    expect(firstDb.getProjectFromPath).not.toHaveBeenCalled();
    expect(firstRegistry.runVerifyCommand).not.toHaveBeenCalled();

    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: 'local ok',
      stderr: '',
    });

    const localResult = await mod.runBuildVerification(
      'task-local',
      { project: 'second-project', provider: 'ollama' },
      WORKING_DIR,
    );

    expect(localResult.success).toBe(true);
    expect(secondParseCommand).toHaveBeenCalledWith('npm run build');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'npm',
      ['run', 'build'],
      expect.objectContaining({
        cwd: WORKING_DIR,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      }),
    );
    expect(firstParseCommand).not.toHaveBeenCalled();
  });

  it("runBuildVerification detects 'npm run build' when package.json exists", async () => {
    projectConfig = {
      build_verification_enabled: true,
      build_timeout: 45,
    };
    existsSyncMock.mockImplementation((filePath) => String(filePath).endsWith('package.json'));

    await buildVerification.runBuildVerification('task-npm', { provider: 'codex' }, WORKING_DIR);

    expect(injectedRegistry.runVerifyCommand).toHaveBeenCalledWith(
      'npm run build',
      WORKING_DIR,
      expect.objectContaining({ timeout: 45000, provider: 'codex' }),
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("runBuildVerification detects 'cargo build' when Cargo.toml exists", async () => {
    projectConfig = {
      build_verification_enabled: true,
      build_timeout: 45,
    };
    existsSyncMock.mockImplementation((filePath) => String(filePath).endsWith('Cargo.toml'));

    await buildVerification.runBuildVerification('task-cargo', { provider: 'codex' }, WORKING_DIR);

    expect(injectedRegistry.runVerifyCommand).toHaveBeenCalledWith(
      'cargo build',
      WORKING_DIR,
      expect.objectContaining({ timeout: 45000, provider: 'codex' }),
    );
  });

  it("runBuildVerification detects 'go build ./...' when go.mod exists", async () => {
    projectConfig = {
      build_verification_enabled: true,
      build_timeout: 45,
    };
    existsSyncMock.mockImplementation((filePath) => String(filePath).endsWith('go.mod'));

    await buildVerification.runBuildVerification('task-go', { provider: 'codex' }, WORKING_DIR);

    expect(injectedRegistry.runVerifyCommand).toHaveBeenCalledWith(
      'go build ./...',
      WORKING_DIR,
      expect.objectContaining({ timeout: 45000, provider: 'codex' }),
    );
  });

  it('runBuildVerification returns { success: true } when the local build passes', async () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: 'compiled successfully',
      stderr: '',
    });

    const result = await buildVerification.runBuildVerification(
      'task-success',
      { provider: 'ollama' },
      WORKING_DIR,
    );

    expect(result).toEqual({
      success: true,
      output: 'compiled successfully',
      error: '',
    });
    expect(parseCommandMock).toHaveBeenCalledWith('npm run build');
    expect(dbMock.saveBuildResult).toHaveBeenCalledWith(
      'task-success',
      expect.objectContaining({
        command: 'npm run build',
        exitCode: 0,
        status: 'passed',
      }),
    );
  });

  it('runBuildVerification returns { success: false, error } when the local build fails', async () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 2,
      stdout: 'partial build output',
      stderr: 'compile error',
    });

    const result = await buildVerification.runBuildVerification(
      'task-failure',
      { provider: 'ollama' },
      WORKING_DIR,
    );

    expect(result.success).toBe(false);
    expect(result.output).toBe('partial build output');
    expect(result.error).toBe('compile error');
    expect(parseCommandMock).toHaveBeenCalledWith('npm run build');
    expect(dbMock.saveBuildResult).toHaveBeenCalledWith(
      'task-failure',
      expect.objectContaining({
        command: 'npm run build',
        status: 'failed',
        errorOutput: 'compile error',
      }),
    );
  });

  it('runBuildVerification skips when no project is found', async () => {
    dbMock.getProjectFromPath.mockReturnValueOnce(null);

    const result = await buildVerification.runBuildVerification(
      'task-no-project',
      { provider: 'ollama' },
      WORKING_DIR,
    );

    expect(result).toEqual({
      success: true,
      output: '',
      error: '',
      skipped: true,
      reason: 'no_project',
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(injectedRegistry.runVerifyCommand).not.toHaveBeenCalled();
    expect(dbMock.saveBuildResult).not.toHaveBeenCalled();
  });

  it('runBuildVerification skips when build_verification_enabled is false', async () => {
    projectConfig = {
      build_verification_enabled: false,
    };

    const result = await buildVerification.runBuildVerification(
      'task-disabled',
      { provider: 'ollama' },
      WORKING_DIR,
    );

    expect(result).toEqual({
      success: true,
      output: '',
      error: '',
      skipped: true,
      reason: 'disabled',
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(injectedRegistry.runVerifyCommand).not.toHaveBeenCalled();
    expect(dbMock.saveBuildResult).not.toHaveBeenCalled();
  });

  it('runBuildVerification saves build results to db on both success and failure', async () => {
    projectConfig = {
      build_verification_enabled: true,
      build_command: 'go build ./...',
      build_timeout: 10,
    };
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: 'build passed',
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: 'build failed output',
        stderr: 'build failed error',
      });

    const successResult = await buildVerification.runBuildVerification(
      'task-db-success',
      { provider: 'ollama' },
      WORKING_DIR,
    );
    const failureResult = await buildVerification.runBuildVerification(
      'task-db-failure',
      { provider: 'ollama' },
      WORKING_DIR,
    );

    expect(successResult.success).toBe(true);
    expect(failureResult.success).toBe(false);
    expect(dbMock.saveBuildResult).toHaveBeenNthCalledWith(
      1,
      'task-db-success',
      expect.objectContaining({
        command: 'go build ./...',
        exitCode: 0,
        status: 'passed',
      }),
    );
    expect(dbMock.saveBuildResult).toHaveBeenNthCalledWith(
      2,
      'task-db-failure',
      expect.objectContaining({
        command: 'go build ./...',
        status: 'failed',
        errorOutput: 'build failed error',
      }),
    );
  });
});
