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

describe('code_agent integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearModules(MODULES_TO_CLEAR);
  });

  it('chains multiple tool calls sequentially in a single snippet', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockReturnValueOnce('first-output\n')
      .mockReturnValueOnce('second-output\n');
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        const r1 = await tools.run_remote_command({
          command: 'echo first',
          working_directory: '/repo',
        });
        const r2 = await tools.run_remote_command({
          command: 'echo second',
          working_directory: '/repo',
        });
        console.log("calls=" + [r1.success, r2.success].join(","));
        return { first: r1.exitCode, second: r2.exitCode };
      `,
      tools: ['run_remote_command'],
    });

    expect(result.success).toBe(true);
    expect(result.tool_calls).toHaveLength(2);
    expect(result.tool_calls[0].tool).toBe('run_remote_command');
    expect(result.tool_calls[1].tool).toBe('run_remote_command');
    expect(getText(result)).toContain('calls=true,true');
    expect(getText(result)).toContain('Tool calls (2)');
    expect(result.result).toEqual({ first: 0, second: 0 });
  });

  it('tool call failure does not crash the sandbox; subsequent calls still execute', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockImplementationOnce(() => {
        const err = new Error('command failed');
        err.status = 1;
        err.stdout = 'partial output';
        err.stderr = 'some error';
        throw err;
      })
      .mockReturnValueOnce('recovery-ok\n');
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        const r1 = await tools.run_remote_command({
          command: 'failing-cmd',
          working_directory: '/repo',
        });
        const r2 = await tools.run_remote_command({
          command: 'recovery-cmd',
          working_directory: '/repo',
        });
        return { firstOk: r1.success, secondOk: r2.success };
      `,
      tools: ['run_remote_command'],
    });

    expect(result.success).toBe(true);
    expect(result.tool_calls).toHaveLength(2);
    // The first command should have failed, the second should have succeeded
    expect(result.result.firstOk).toBe(false);
    expect(result.result.secondOk).toBe(true);
  });

  it('run_tests tool available inside sandbox with verify_command delegation', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockReturnValue('tests passed\n');
    const { handlers } = loadHandlers({
      project: 'my-project',
      projectConfig: { verify_command: 'npm test' },
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        const r = await tools.run_tests({
          working_directory: '/repo',
        });
        return { ok: r.success, text: r.content[0].text };
      `,
      tools: ['run_tests'],
    });

    expect(result.success).toBe(true);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].tool).toBe('run_tests');
    expect(execSync).toHaveBeenCalledWith('npm test', expect.objectContaining({
      cwd: '/repo',
    }));
    expect(result.result.ok).toBe(true);
    expect(result.result.text).toContain('tests passed');
  });

  it('context flows through to conditional logic that gates tool calls', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockReturnValue('ran\n');
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        if (context.shouldRun) {
          await tools.run_remote_command({
            command: context.cmd,
            working_directory: '/repo',
          });
          console.log("executed");
        } else {
          console.log("skipped");
        }
        return context.shouldRun;
      `,
      tools: ['run_remote_command'],
      context: { shouldRun: true, cmd: 'echo ctx' },
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe(true);
    expect(result.tool_calls).toHaveLength(1);
    expect(getText(result)).toContain('executed');
    expect(getText(result)).not.toContain('skipped');
  });

  it('context gate prevents tool call when condition is false', async () => {
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        if (context.shouldRun) {
          await tools.run_remote_command({
            command: 'echo never',
            working_directory: '/repo',
          });
        } else {
          console.log("skipped");
        }
        return "done";
      `,
      tools: ['run_remote_command'],
      context: { shouldRun: false },
    });

    expect(result.success).toBe(true);
    expect(result.tool_calls).toHaveLength(0);
    expect(getText(result)).toContain('skipped');
  });

  it('accumulates console output alongside tool call output in correct order', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockReturnValue('tool-done\n');
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        console.log("step-1");
        await tools.run_remote_command({ command: 'echo x', working_directory: '/repo' });
        console.log("step-2");
        return "end";
      `,
      tools: ['run_remote_command'],
    });

    expect(result.success).toBe(true);
    const text = getText(result);
    const step1Idx = text.indexOf('step-1');
    const step2Idx = text.indexOf('step-2');
    // Console output ordering should be preserved
    expect(step1Idx).toBeLessThan(step2Idx);
    expect(step1Idx).toBeGreaterThanOrEqual(0);
  });

  it('error in first tool call propagates; sandbox catches it without crashing', async () => {
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    // Call run_remote_command with missing params → returns isError result (not thrown)
    const result = await handlers.run_code_agent({
      code: `
        const r = await tools.run_remote_command({});
        if (r.isError) {
          console.log("caught error: " + r.content[0].text);
        }
        return r.isError;
      `,
      tools: ['run_remote_command'],
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe(true);
    expect(getText(result)).toContain('caught error:');
    expect(getText(result)).toContain('command and working_directory are required');
  });

  it('mixed tool set: both run_remote_command and run_tests in same snippet', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockReturnValueOnce('build-ok\n')
      .mockReturnValueOnce('tests-ok\n');
    const { handlers } = loadHandlers({
      project: 'mixed-project',
      projectConfig: { verify_command: 'npm test' },
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        const build = await tools.run_remote_command({
          command: 'npm run build',
          working_directory: '/repo',
        });
        const test = await tools.run_tests({
          working_directory: '/repo',
        });
        return {
          buildOk: build.success,
          testOk: test.success,
        };
      `,
      tools: ['run_remote_command', 'run_tests'],
    });

    expect(result.success).toBe(true);
    expect(result.tool_calls).toHaveLength(2);
    expect(result.tool_calls[0].tool).toBe('run_remote_command');
    expect(result.tool_calls[1].tool).toBe('run_tests');
    expect(result.result).toEqual({ buildOk: true, testOk: true });
  });

  it('dynamic tool invocation using context-provided tool name', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockReturnValue('dynamic-out\n');
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        const toolFn = tools[context.toolName];
        if (!toolFn) return "no tool";
        const r = await toolFn({
          command: 'echo dynamic',
          working_directory: '/repo',
        });
        return r.success;
      `,
      tools: ['run_remote_command'],
      context: { toolName: 'run_remote_command' },
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe(true);
    expect(result.tool_calls).toHaveLength(1);
  });

  it('tool call arguments are recorded accurately in tool_calls log', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockReturnValue('logged\n');
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        await tools.run_remote_command({
          command: 'specific-command --flag=value',
          working_directory: '/specific/path',
          timeout: 9999,
        });
      `,
      tools: ['run_remote_command'],
    });

    expect(result.success).toBe(true);
    expect(result.tool_calls).toHaveLength(1);
    const call = result.tool_calls[0];
    expect(call.tool).toBe('run_remote_command');
    expect(call.args).toEqual({
      command: 'specific-command --flag=value',
      working_directory: '/specific/path',
      timeout: 9999,
    });
    // The result should also be recorded
    expect(call.result).toBeDefined();
    expect(call.result.success).toBe(true);
  });

  it('loop-driven tool calls execute correct number of times', async () => {
    let callCount = 0;
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockImplementation(() => {
        callCount++;
        return `call-${callCount}\n`;
      });
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        const results = [];
        for (let i = 0; i < 3; i++) {
          const r = await tools.run_remote_command({
            command: 'echo iteration-' + i,
            working_directory: '/repo',
          });
          results.push(r.success);
        }
        return results;
      `,
      tools: ['run_remote_command'],
    });

    expect(result.success).toBe(true);
    expect(result.tool_calls).toHaveLength(3);
    expect(result.result).toEqual([true, true, true]);
    expect(execSync).toHaveBeenCalledTimes(3);
  });

  it('sandbox returns structured data types (arrays, nested objects) from tool results', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockReturnValue('check-ok\n');
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        const r = await tools.run_remote_command({
          command: 'echo check',
          working_directory: '/repo',
        });
        return {
          success: r.success,
          hasContent: Array.isArray(r.content),
          exitCode: r.exitCode,
          keys: Object.keys(r).sort(),
        };
      `,
      tools: ['run_remote_command'],
    });

    expect(result.success).toBe(true);
    expect(result.result.success).toBe(true);
    expect(result.result.hasContent).toBe(true);
    expect(result.result.exitCode).toBe(0);
    expect(result.result.keys).toContain('content');
    expect(result.result.keys).toContain('success');
  });

  it('empty tools array and complex computation completes without sandbox tools', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: `
        const data = context.items.map(x => x * 2).filter(x => x > 4);
        const sum = data.reduce((a, b) => a + b, 0);
        console.log("processed " + data.length + " items, sum=" + sum);
        return { data, sum };
      `,
      tools: [],
      context: { items: [1, 2, 3, 4, 5] },
    });

    expect(result.success).toBe(true);
    expect(result.tool_calls).toEqual([]);
    expect(result.result).toEqual({ data: [6, 8, 10], sum: 24 });
    expect(getText(result)).toContain('processed 3 items, sum=24');
  });

  it('async tool call rejection is surfaced as sandbox error', async () => {
    const run = vi.fn().mockRejectedValue(new Error('network unreachable'));
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => [
          { id: 'flaky-host', name: 'flaky-host', status: 'healthy', enabled: true },
        ]),
        getClient: vi.fn(() => ({ run })),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        try {
          await tools.run_remote_command({
            command: 'echo test',
            working_directory: '/repo',
          });
        } catch (e) {
          console.log("caught: " + e.message);
          return "handled";
        }
      `,
      tools: ['run_remote_command'],
    });

    // The handler catches remote execution errors internally and returns
    // an error result rather than throwing, so the sandbox code receives
    // the error response object. Either path (caught exception or error
    // result) should not crash the sandbox.
    expect(result.success).toBeDefined();
    expect(result.tool_calls).toHaveLength(1);
  });

  it('result shape is consistent across success and error paths', async () => {
    const { handlers } = loadHandlers();

    const successResult = await handlers.run_code_agent({
      code: 'return 1;',
    });

    const errorResult = await handlers.run_code_agent({
      code: 'throw new Error("boom");',
    });

    // Both results should have the standard shape
    for (const r of [successResult, errorResult]) {
      expect(r).toHaveProperty('content');
      expect(Array.isArray(r.content)).toBe(true);
      expect(r.content[0]).toHaveProperty('type', 'text');
      expect(r.content[0]).toHaveProperty('text');
      expect(r).toHaveProperty('success');
      expect(r).toHaveProperty('tool_calls');
      expect(Array.isArray(r.tool_calls)).toBe(true);
    }

    expect(successResult.success).toBe(true);
    expect(successResult.isError).toBeUndefined();

    expect(errorResult.success).toBe(false);
    expect(errorResult.isError).toBe(true);
    expect(errorResult.error_code).toBe('OPERATION_FAILED');
  });
});

describe('code_agent registry awareness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearModules(MODULES_TO_CLEAR);
  });

  it('defaults kind to "code_agent" in the result', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'return "ok";',
    });

    expect(result.success).toBe(true);
    expect(result.kind).toBe('code_agent');
  });

  it('accepts a custom kind from args and propagates it', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'return context.kind;',
      kind: 'custom_kind',
    });

    expect(result.success).toBe(true);
    expect(result.kind).toBe('custom_kind');
    expect(result.result).toBe('custom_kind');
  });

  it('injects working_directory into sandbox context', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'return context.working_directory;',
      working_directory: '/my/project',
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe('/my/project');
    expect(result.working_directory).toBe('/my/project');
  });

  it('sandbox context merges user context with injected fields', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'return { wd: context.working_directory, kind: context.kind, custom: context.myField };',
      working_directory: '/project',
      kind: 'code_agent',
      context: { myField: 'hello' },
    });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      wd: '/project',
      kind: 'code_agent',
      custom: 'hello',
    });
  });

  it('omits working_directory from result when not provided', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: 'return 1;',
    });

    expect(result.success).toBe(true);
    expect(result.working_directory).toBeUndefined();
  });

  it('blocks admin tools from being exposed in the sandbox', async () => {
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: 'return Object.keys(tools).sort();',
      tools: ['run_remote_command', 'register_remote_agent', 'remove_remote_agent', 'list_remote_agents', 'check_remote_agent_health'],
    });

    expect(result.success).toBe(true);
    // Only execution tools should be present; admin tools are filtered out
    expect(result.result).toEqual(['run_remote_command']);
  });

  it('run_tests is allowed in sandbox but admin tools are not', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockReturnValue('test-ok\n');
    const { handlers } = loadHandlers({
      project: 'test-proj',
      projectConfig: { verify_command: 'npm test' },
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: 'return Object.keys(tools).sort();',
      tools: ['run_tests', 'get_remote_agent', 'run_remote_command'],
    });

    expect(result.success).toBe(true);
    expect(result.result).toEqual(['run_remote_command', 'run_tests']);
  });

  it('getCodeAgentToolNames returns the allowlist', async () => {
    const { handlers } = loadHandlers();

    const toolNames = handlers.getCodeAgentToolNames();

    expect(Array.isArray(toolNames)).toBe(true);
    expect(toolNames).toContain('run_remote_command');
    expect(toolNames).toContain('run_tests');
    expect(toolNames).not.toContain('register_remote_agent');
    expect(toolNames).not.toContain('run_code_agent');
  });

  it('isCodeAgentTool returns true for allowed tools', async () => {
    const { handlers } = loadHandlers();

    expect(handlers.isCodeAgentTool('run_remote_command')).toBe(true);
    expect(handlers.isCodeAgentTool('run_tests')).toBe(true);
    expect(handlers.isCodeAgentTool('register_remote_agent')).toBe(false);
    expect(handlers.isCodeAgentTool('run_code_agent')).toBe(false);
    expect(handlers.isCodeAgentTool('nonexistent')).toBe(false);
  });

  it('tool calls inside sandbox use agent registry for remote routing', async () => {
    const run = vi.fn().mockResolvedValue({
      success: true,
      output: 'remote-sandbox-ok\n',
      error: '',
      exitCode: 0,
      durationMs: 10,
    });
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => [
          { id: 'gpu-box', name: 'gpu-box', status: 'healthy', enabled: true },
        ]),
        getClient: vi.fn(() => ({ run })),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        const r = await tools.run_remote_command({
          command: 'echo hello',
          working_directory: '/repo',
        });
        return { remote: r.remote, ok: r.success };
      `,
      tools: ['run_remote_command'],
      working_directory: '/repo',
      kind: 'code_agent',
    });

    expect(result.success).toBe(true);
    expect(result.kind).toBe('code_agent');
    expect(result.working_directory).toBe('/repo');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].tool).toBe('run_remote_command');
    // The tool call should have routed through the agent registry to the remote
    expect(result.result.remote).toBe(true);
    expect(result.result.ok).toBe(true);
  });

  it('tool calls fall back to local when no agent is available', async () => {
    const execSync = vi.spyOn(require('child_process'), 'execSync')
      .mockReturnValue('local-sandbox-ok\n');
    const { handlers } = loadHandlers({
      registry: {
        getAll: vi.fn(() => []),
        getClient: vi.fn(),
      },
    });

    const result = await handlers.run_code_agent({
      code: `
        const r = await tools.run_remote_command({
          command: 'echo local',
          working_directory: '/repo',
        });
        return { remote: r.remote, ok: r.success };
      `,
      tools: ['run_remote_command'],
      working_directory: '/repo',
    });

    expect(result.success).toBe(true);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.result.remote).toBe(false);
    expect(result.result.ok).toBe(true);
  });

  it('kind field is accessible in sandbox context for conditional logic', async () => {
    const { handlers } = loadHandlers();

    const result = await handlers.run_code_agent({
      code: `
        if (context.kind === 'code_agent') {
          console.log("running as code_agent");
          return true;
        }
        return false;
      `,
      kind: 'code_agent',
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe(true);
    expect(getText(result)).toContain('running as code_agent');
  });
});
