'use strict';

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearCjsModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module was not loaded in this test.
  }
}

function clearModules(modulePaths) {
  for (const modulePath of modulePaths) {
    clearCjsModule(modulePath);
  }
}

const MODULES_TO_CLEAR = [
  '../handlers',
  '../../../db/project-config-core',
  '../../../logger',
];

function getText(result) {
  return result && result.content && result.content[0]
    ? result.content[0].text || ''
    : '';
}

function loadHandlers({
  registry = null,
  project = 'torque',
  projectConfig = {
    verify_command: 'npm test && npm run lint',
  },
} = {}) {
  const getProjectFromPath = vi.fn().mockReturnValue(project);
  const getProjectConfig = vi.fn().mockReturnValue(projectConfig);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const child = vi.fn(() => logger);

  clearModules(MODULES_TO_CLEAR);
  installCjsModuleMock('../../../db/project-config-core', {
    getProjectFromPath,
    getProjectConfig,
  });
  installCjsModuleMock('../../../logger', {
    child,
  });

  const { createHandlers } = require('../handlers');
  const handlers = createHandlers({
    agentRegistry: registry,
    db: {
      getProjectFromPath,
      getProjectConfig,
    },
  });

  return {
    handlers,
    getProjectFromPath,
    getProjectConfig,
    logger,
    child,
  };
}

describe('remote command MCP tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearModules(MODULES_TO_CLEAR);
  });

  it('handleRunRemoteCommand with no agents falls back to local exec', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync').mockReturnValue('local-ok\n');
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_remote_command({
      command: 'npm test',
      working_directory: '/repo',
    });

    expect(execSync).toHaveBeenCalledWith('npm test', expect.objectContaining({
      cwd: '/repo',
      timeout: 300000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }));
    expect(result.remote).toBe(false);
    expect(getText(result)).toContain('[local fallback] Exit code: 0');
    expect(getText(result)).toContain('local-ok');
  });

  it('handleRunRemoteCommand missing command returns error', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_remote_command({
      working_directory: '/repo',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    expect(getText(result)).toBe('Error: command and working_directory are required');
  });

  it('handleRunTests with no verify_command returns error', async () => {
    const { handlers, getProjectFromPath, getProjectConfig } = loadHandlers({
      project: 'torque-server',
      projectConfig: {},
    });

    const result = await handlers.run_tests({
      working_directory: '/repo',
    });

    expect(getProjectFromPath).toHaveBeenCalledWith('/repo');
    expect(getProjectConfig).toHaveBeenCalledWith('torque-server');
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(getText(result)).toBe('Error: No verify_command configured. Set it with set_project_defaults.');
  });

  it('handleRunTests delegates to handleRunRemoteCommand with verify_command', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync').mockReturnValue('ok\n');
    const { handlers } = loadHandlers({
      project: 'torque-server',
      projectConfig: {
        verify_command: 'npm test && npm run lint',
      },
    });

    const result = await handlers.run_tests({
      working_directory: '/repo',
    });

    expect(execSync).toHaveBeenCalledWith('npm test && npm run lint', expect.objectContaining({
      cwd: '/repo',
      timeout: 600000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }));
    expect(result.remote).toBe(false);
    expect(getText(result)).toContain('[local fallback] Exit code: 0');
    expect(getText(result)).toContain('ok');
  });

  it('result text includes a [remote:] prefix for healthy agent execution', async () => {
    const run = vi.fn().mockResolvedValue({
      success: true,
      output: 'remote-ok\n',
      error: '',
      exitCode: 0,
      durationMs: 15,
    });
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => [
          { id: 'remote-gpu-host', name: 'remote-gpu-host', status: 'healthy', enabled: true },
        ]),
        getClient: vi.fn(() => ({ run })),
      },
    });

    const result = await handlers.run_remote_command({
      command: 'npm test',
      working_directory: '/repo',
      timeout: 4321,
    });

    const expectedCommand = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const expectedArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm test']
      : ['-lc', 'npm test'];

    expect(run).toHaveBeenCalledWith(expectedCommand, expectedArgs, {
      cwd: '/repo',
      timeout: 4321,
    });
    expect(result.remote).toBe(true);
    expect(getText(result)).toContain('[remote: remote-gpu-host] Exit code: 0');
    expect(getText(result)).toContain('remote-ok');
  });
});
