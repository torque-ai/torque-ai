'use strict';

function installMock(mod, val) {
  require.cache[require.resolve(mod)] = {
    id: require.resolve(mod),
    filename: require.resolve(mod),
    loaded: true,
    exports: val,
  };
}

function clearModule(mod) {
  try {
    delete require.cache[require.resolve(mod)];
  } catch {
    // Module was not loaded for this test.
  }
}

function clearModules(mods) {
  for (const mod of mods) {
    clearModule(mod);
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function getText(result) {
  return result && result.content && result.content[0]
    ? result.content[0].text || ''
    : '';
}

function createMockResponse() {
  const response = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead: vi.fn((statusCode, headers) => {
      response.statusCode = statusCode;
      response.headers = headers;
    }),
    end: vi.fn((body = '') => {
      response.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    }),
  };

  return response;
}

function parseJsonBody(response) {
  return response.body ? JSON.parse(response.body) : null;
}

function parseCommandString(commandString) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < commandString.length; i += 1) {
    const ch = commandString[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current) {
    tokens.push(current);
  }

  return {
    executable: tokens[0] || '',
    args: tokens.slice(1),
  };
}

function createMockRegistry(agents = [], clients = {}) {
  const store = new Map(agents.map(agent => [agent.id, { ...agent }]));

  return {
    register: vi.fn((agent) => {
      store.set(agent.id, {
        ...(store.get(agent.id) || {}),
        ...agent,
      });
      return { ...store.get(agent.id) };
    }),
    get: vi.fn((id) => {
      const agent = store.get(id);
      return agent ? { ...agent } : null;
    }),
    getAll: vi.fn(() => Array.from(store.values()).map(agent => ({ ...agent }))),
    remove: vi.fn((id) => store.delete(id)),
    getClient: vi.fn((id) => clients[id] || null),
    runHealthChecks: vi.fn().mockResolvedValue([]),
  };
}

const MODULES_TO_CLEAR = [
  '../handlers',
  '../remote-test-routing',
  '../../../db/project-config-core',
  '../../../logger',
  '../../../validation/post-task',
];

function loadHandlers(options = {}) {
  clearModules(MODULES_TO_CLEAR);

  const registry = hasOwn(options, 'registry')
    ? options.registry
    : createMockRegistry();

  const runRemoteOrLocal = hasOwn(options, 'runRemoteOrLocal')
    ? options.runRemoteOrLocal
    : vi.fn().mockResolvedValue(hasOwn(options, 'runRemoteOrLocalResult')
      ? options.runRemoteOrLocalResult
      : {
          success: true,
          output: 'remote-ok',
          error: '',
          exitCode: 0,
          durationMs: 25,
          remote: true,
        });

  const runVerifyCommand = hasOwn(options, 'runVerifyCommand')
    ? options.runVerifyCommand
    : vi.fn().mockResolvedValue(hasOwn(options, 'runVerifyCommandResult')
      ? options.runVerifyCommandResult
      : {
          success: true,
          output: 'verify-ok',
          error: '',
          exitCode: 0,
          durationMs: 40,
          remote: true,
        });

  const router = hasOwn(options, 'router')
    ? options.router
    : { runRemoteOrLocal, runVerifyCommand };

  if (!hasOwn(router, 'runRemoteOrLocal')) {
    router.runRemoteOrLocal = runRemoteOrLocal;
  }
  if (!hasOwn(router, 'runVerifyCommand')) {
    router.runVerifyCommand = runVerifyCommand;
  }

  const createRemoteTestRouter = vi.fn(() => router);

  const database = hasOwn(options, 'database')
    ? options.database
    : {
        getProjectFromPath: vi.fn().mockReturnValue(
          hasOwn(options, 'project') ? options.project : 'torque-project'
        ),
        getProjectConfig: vi.fn().mockReturnValue(
          hasOwn(options, 'projectConfig')
            ? options.projectConfig
            : { verify_command: 'npm test && npm run lint' }
        ),
      };

  const loggerInstance = hasOwn(options, 'logger')
    ? options.logger
    : {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

  const loggerModule = {
    child: vi.fn(() => loggerInstance),
  };

  const parseCommand = hasOwn(options, 'parseCommand')
    ? options.parseCommand
    : vi.fn(options.parseCommandImpl || parseCommandString);

  installMock('../remote-test-routing', {
    createRemoteTestRouter,
  });
  installMock('../../../db/project-config-core', database);
  installMock('../../../logger', loggerModule);
  installMock('../../../validation/post-task', {
    parseCommand,
  });

  const { createHandlers } = require('../handlers');
  const handlers = createHandlers({
    agentRegistry: registry,
    db: database,
  });

  return {
    handlers,
    registry,
    router,
    runRemoteOrLocal: router.runRemoteOrLocal,
    runVerifyCommand: router.runVerifyCommand,
    createRemoteTestRouter,
    database,
    getProjectFromPath: database.getProjectFromPath,
    getProjectConfig: database.getProjectConfig,
    loggerInstance,
    loggerModule,
    parseCommand,
  };
}

describe('remote-agent-handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearModules(MODULES_TO_CLEAR);
  });

  describe('registry handlers', () => {
    it('registers an agent with normalized id and explicit tls settings', () => {
      const { handlers, registry } = loadHandlers();

      const result = handlers.register_remote_agent({
        name: 'Secure Agent',
        host: 'secure.example.test',
        port: 443,
        secret: 'top-secret',
        max_concurrent: 7,
        tls: 'yes',
        rejectUnauthorized: '0',
      });

      expect(registry.register).toHaveBeenCalledWith({
        id: 'secure-agent',
        name: 'Secure Agent',
        host: 'secure.example.test',
        port: 443,
        secret: 'top-secret',
        max_concurrent: 7,
        tls: true,
        rejectUnauthorized: false,
      });
      expect(getText(result)).toContain('Registered agent "Secure Agent"');
      expect(getText(result)).toContain('https://secure.example.test:443');
      expect(getText(result)).toContain('tls: enabled');
      expect(getText(result)).toContain('rejectUnauthorized: false');
    });

    it('preserves existing tls settings when re-registering without explicit tls args', () => {
      const registry = createMockRegistry([
        {
          id: 'secure-agent',
          name: 'Secure Agent',
          host: 'old.example.test',
          port: 9443,
          secret: 'old-secret',
          max_concurrent: 2,
          tls: 1,
          rejectUnauthorized: 0,
        },
      ]);
      const { handlers } = loadHandlers({ registry });

      handlers.register_remote_agent({
        name: 'Secure Agent',
        host: 'new.example.test',
        port: 8443,
        secret: 'new-secret',
      });

      expect(registry.register).toHaveBeenCalledWith({
        id: 'secure-agent',
        name: 'Secure Agent',
        host: 'new.example.test',
        port: 8443,
        secret: 'new-secret',
        max_concurrent: 3,
        tls: true,
        rejectUnauthorized: false,
      });
    });

    it('lists and gets an agent without exposing its secret', () => {
      const registry = createMockRegistry([
        {
          id: 'agent-1',
          name: 'Build One',
          host: '10.0.0.10',
          port: 3460,
          secret: 'do-not-show',
          tls: 1,
          rejectUnauthorized: 1,
          status: 'healthy',
          enabled: 1,
          last_health_check: '2026-03-10T12:00:00.000Z',
        },
      ]);
      const { handlers } = loadHandlers({ registry });

      const listResult = handlers.list_remote_agents();
      const detailResult = handlers.get_remote_agent({ agent_id: 'agent-1' });

      expect(getText(listResult)).toContain('Build One');
      expect(getText(listResult)).toContain('https://10.0.0.10:3460');
      expect(getText(listResult)).toContain('healthy');
      expect(getText(listResult)).toContain('enabled');
      expect(getText(listResult)).not.toContain('do-not-show');
      expect(getText(detailResult)).toContain('Build One');
      expect(getText(detailResult)).toContain('last check: 2026-03-10T12:00:00.000Z');
      expect(getText(detailResult)).not.toContain('do-not-show');
    });

    it('removes an existing agent', () => {
      const registry = createMockRegistry([
        {
          id: 'agent-1',
          name: 'Build One',
          host: '10.0.0.10',
          port: 3460,
          secret: 'secret',
        },
      ]);
      const { handlers } = loadHandlers({ registry });

      const result = handlers.remove_remote_agent({ agent_id: 'agent-1' });

      expect(registry.remove).toHaveBeenCalledWith('agent-1');
      expect(getText(result)).toContain('Removed agent agent-1');
      expect(registry.getAll()).toEqual([]);
    });

    it('returns a healthy agent status with memory details', async () => {
      const client = {
        checkHealth: vi.fn().mockResolvedValue({
          running_tasks: 2,
          max_concurrent: 5,
          system: { memory_available_mb: 2048 },
        }),
      };
      const registry = createMockRegistry([
        {
          id: 'agent-1',
          name: 'Build One',
          host: '10.0.0.10',
          port: 3460,
        },
      ], { 'agent-1': client });
      const { handlers } = loadHandlers({ registry });

      const result = await handlers.check_remote_agent_health({ agent_id: 'agent-1' });

      expect(client.checkHealth).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('Build One: healthy');
      expect(getText(result)).toContain('running: 2/5');
      expect(getText(result)).toContain('2048MB free');
    });

    it('returns bulk health summaries for all agents', async () => {
      const registry = createMockRegistry();
      registry.runHealthChecks.mockResolvedValue([
        { id: 'agent-1', status: 'healthy', failures: 0 },
        { id: 'agent-2', status: 'offline', failures: 3 },
      ]);
      const { handlers } = loadHandlers({ registry });

      const result = await handlers.check_remote_agent_health({});

      expect(registry.runHealthChecks).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('agent-1: healthy');
      expect(getText(result)).toContain('agent-2: offline (3 failures)');
    });
  });

  describe('remote command handlers', () => {
    it('uses a healthy agent client and formats a remote prefix', async () => {
      const run = vi.fn().mockResolvedValue({
        success: true,
        output: 'remote-ok',
        error: '',
        exitCode: 0,
        durationMs: 22,
      });
      const registry = createMockRegistry([
        { id: 'remote-gpu-host', name: 'remote-gpu-host', status: 'healthy', enabled: true },
      ], {
        'remote-gpu-host': { run },
      });
      const { handlers } = loadHandlers({ registry });

      const result = await handlers.run_remote_command({
        command: 'npm run verify -- --watch=false',
        working_directory: '/repo',
        timeout: '4500',
      });

      const expectedCommand = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const expectedArgs = process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npm run verify -- --watch=false']
        : ['-lc', 'npm run verify -- --watch=false'];

      expect(run).toHaveBeenCalledWith(
        expectedCommand,
        expectedArgs,
        {
          cwd: '/repo',
          timeout: 4500,
        }
      );
      expect(getText(result)).toContain('[remote: remote-gpu-host] Exit code: 0');
      expect(getText(result)).toContain('remote-ok');
    });

    it('falls back to local execution when no healthy agent is available', async () => {
      const execSync = vi.spyOn(require('child_process'), 'execSync').mockReturnValue('local-ok');
      const registry = createMockRegistry([]);
      const { handlers } = loadHandlers({ registry });

      const result = await handlers.run_remote_command({
        command: 'npm test',
        working_directory: '/repo',
      });

      expect(execSync).toHaveBeenCalledWith('npm test', expect.objectContaining({
        cwd: '/repo',
      }));
      expect(result.remote).toBe(false);
      expect(getText(result)).toContain('[local fallback] Exit code: 0');
      expect(getText(result)).toContain('local-ok');
    });

    it('returns a missing parameter error when command is absent', async () => {
      const { handlers } = loadHandlers();

      const result = await handlers.run_remote_command({
        working_directory: '/repo',
      });

      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toBe('Error: command and working_directory are required');
    });

    it('surfaces remote execution failures without local fallback text', async () => {
      const run = vi.fn().mockRejectedValue(new Error('stream timed out'));
      const registry = createMockRegistry([
        { id: 'remote-gpu-host', name: 'remote-gpu-host', status: 'healthy', enabled: true },
      ], {
        'remote-gpu-host': { run },
      });
      const { handlers } = loadHandlers({ registry });

      const result = await handlers.run_remote_command({
        command: 'npm test',
        working_directory: '/repo',
      });

      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getText(result)).toContain('Remote execution failed: stream timed out. Use local execution as fallback.');
    });
  });

  describe('verify command handlers', () => {
    it('loads verify_command from project config and returns a local fallback warning in HTTP results', async () => {
      const { handlers, registry, createRemoteTestRouter, database, loggerInstance, runVerifyCommand } = loadHandlers({
        project: 'torque-server',
        projectConfig: {
          verify_command: 'npm test && npm run lint',
        },
        runVerifyCommandResult: {
          success: true,
          output: 'verify-local',
          error: '',
          exitCode: 0,
          durationMs: 61,
          remote: false,
        },
      });
      const response = createMockResponse();

      await handlers.run_tests({
        method: 'POST',
        body: {
          working_directory: '/repo',
        },
      }, response);

      expect(database.getProjectFromPath).toHaveBeenCalledWith('/repo');
      expect(database.getProjectConfig).toHaveBeenCalledWith('torque-server');
      expect(createRemoteTestRouter).toHaveBeenCalledWith({
        agentRegistry: registry,
        db: database,
        logger: loggerInstance,
      });
      expect(runVerifyCommand).toHaveBeenCalledWith('npm test && npm run lint', '/repo');
      expect(response.statusCode).toBe(200);
      expect(parseJsonBody(response)).toEqual({
        success: true,
        output: 'verify-local',
        exitCode: 0,
        durationMs: 61,
        remote: false,
        warning: 'Remote agent unavailable or not configured; tests ran locally.',
      });
    });

    it('returns INVALID_PARAM when no verify_command is configured', async () => {
      const { handlers, runVerifyCommand } = loadHandlers({
        projectConfig: {},
      });

      const result = await handlers.run_tests({
        working_directory: '/repo',
      });

      expect(result.error_code).toBe('INVALID_PARAM');
      expect(runVerifyCommand).not.toHaveBeenCalled();
      expect(getText(result)).toBe('Error: No verify_command configured. Set it with set_project_defaults.');
    });

    it('delegates verify_command execution to handleRunRemoteCommand', async () => {
      const execSync = vi.spyOn(require('child_process'), 'execSync').mockReturnValue('all green\n');
      const { handlers, getProjectFromPath, getProjectConfig } = loadHandlers({
        projectConfig: {
          verify_command: 'npm test && npm run lint',
        },
      });

      const result = await handlers.run_tests({
        working_directory: '/repo',
      });

      expect(getProjectFromPath).toHaveBeenCalledWith('/repo');
      expect(getProjectConfig).toHaveBeenCalledWith('torque-project');
      expect(execSync).toHaveBeenCalledWith('npm test && npm run lint', expect.objectContaining({
        cwd: '/repo',
        timeout: 600000,
      }));
      expect(result.remote).toBe(false);
      expect(getText(result)).toContain('[local fallback] Exit code: 0');
      expect(getText(result)).toContain('all green');
    });
  });
});