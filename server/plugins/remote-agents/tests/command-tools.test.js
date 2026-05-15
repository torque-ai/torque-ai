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
  '../sandbox',
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

describe('run_code_agent MCP tool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearModules(MODULES_TO_CLEAR);
  });

  it('executes a simple code snippet and captures console output', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'console.log("hello from sandbox");',
    });

    expect(result.success).toBe(true);
    expect(getText(result)).toContain('hello from sandbox');
    expect(result.tool_calls).toEqual([]);
  });

  it('returns a value from the code snippet', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'return 42;',
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe(42);
    expect(getText(result)).toContain('Return value: 42');
  });

  it('provides context object to the sandbox', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'console.log("project=" + context.projectName);',
      context: { projectName: 'torque' },
    });

    expect(result.success).toBe(true);
    expect(getText(result)).toContain('project=torque');
  });

  it('returns error when code is missing', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({});

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    expect(getText(result)).toBe('Error: code is required');
  });

  it('returns error when code is empty string', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({ code: '   ' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    expect(getText(result)).toBe('Error: code is required');
  });

  it('captures runtime errors from the code snippet', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'throw new Error("something broke");',
    });

    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('OPERATION_FAILED');
    expect(getText(result)).toContain('Error: something broke');
  });

  it('prevents access to require and process', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'const fs = require("fs");',
    });

    expect(result.success).toBe(false);
    expect(getText(result)).toContain('Error:');
    // require is not defined in the sandbox
    expect(getText(result)).toMatch(/require is not defined|require is not a function/);
  });

  it('prevents access to process global', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'console.log(process.env.HOME);',
    });

    expect(result.success).toBe(false);
    expect(getText(result)).toMatch(/process is not defined|Cannot read propert/);
  });

  it('allows calling tools listed in the tools array', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync').mockReturnValue('test-output\n');
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        const res = await tools.run_remote_command({
          command: 'echo hello',
          working_directory: '/repo',
        });
        console.log("tool returned");
        return res.success;
      `,
      tools: ['run_remote_command'],
    });

    expect(result.success).toBe(true);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].tool).toBe('run_remote_command');
    expect(getText(result)).toContain('tool returned');
  });

  it('ignores tool names that are not in the handler map', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'return Object.keys(tools);',
      tools: ['run_remote_command', 'nonexistent_tool'],
    });

    expect(result.success).toBe(true);
    // Only run_remote_command should be in the tools object
    expect(result.result).toContain('run_remote_command');
    expect(result.result).not.toContain('nonexistent_tool');
  });

  it('works with no tools specified', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'return Object.keys(tools).length;',
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe(0);
  });

  it('supports top-level await in code snippets', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: `
        const value = await Promise.resolve(99);
        return value;
      `,
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe(99);
  });

  it('handles multiple console.log calls', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: `
        console.log("line 1");
        console.log("line 2");
        console.warn("a warning");
      `,
    });

    expect(result.success).toBe(true);
    expect(getText(result)).toContain('line 1');
    expect(getText(result)).toContain('line 2');
    expect(getText(result)).toContain('[warn] a warning');
  });

  it('uses loops and conditionals inside the sandbox', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: `
        let sum = 0;
        for (let i = 1; i <= 10; i++) {
          sum += i;
        }
        if (sum === 55) {
          console.log("correct");
        }
        return sum;
      `,
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe(55);
    expect(getText(result)).toContain('correct');
  });

  it('reports tool call details in the output text', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync').mockReturnValue('ok\n');
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        await tools.run_remote_command({ command: 'echo hi', working_directory: '/tmp' });
      `,
      tools: ['run_remote_command'],
    });

    expect(getText(result)).toContain('Tool calls (1)');
    expect(getText(result)).toContain('run_remote_command');
  });

  it('handles tool call errors gracefully', async () => {
    const { handlers } = loadHandlers();

    // run_remote_command without required params should return a tool error,
    // which the sandbox code receives as a result (not a thrown exception)
    const result = await handlers.run_code_agent({
      code: `
        const res = await tools.run_remote_command({});
        return res.isError;
      `,
      tools: ['run_remote_command'],
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe(true);
    expect(result.tool_calls).toHaveLength(1);
  });

  it('respects the custom timeout parameter', async () => {
    const { handlers } = loadHandlers();

    // A tight timeout should cause the snippet to fail if it tries to run too long
    const result = await handlers.run_code_agent({
      code: 'while(true) {}',
      timeout: 50,
    });

    expect(result.success).toBe(false);
    expect(getText(result)).toMatch(/Error:.*timed out|Error:.*timeout/i);
  });
});
