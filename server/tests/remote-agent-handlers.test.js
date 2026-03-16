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
  '../handlers/remote-agent-handlers',
  '../remote/remote-test-routing',
  '../database',
  '../logger',
  '../validation/post-task',
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

  installMock('../remote/remote-test-routing', {
    createRemoteTestRouter,
  });
  installMock('../database', database);
  installMock('../logger', loggerModule);
  installMock('../validation/post-task', {
    parseCommand,
  });

  const handlers = require('../handlers/remote-agent-handlers');
  handlers._getRegistry = vi.fn(() => registry);

  return {
    handlers,
    registry,
    router,
    runRemoteOrLocal: router.runRemoteOrLocal,
    runVerifyCommand: router.runVerifyCommand,
    createRemoteTestRouter,
    database,
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

      const result = handlers.registerRemoteAgent({
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

      handlers.registerRemoteAgent({
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

      const listResult = handlers.listRemoteAgents();
      const detailResult = handlers.getRemoteAgent({ agent_id: 'agent-1' });

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

      const result = handlers.deleteRemoteAgent({ agent_id: 'agent-1' });

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

      const result = await handlers.runAgentHealthCheck({ agent_id: 'agent-1' });

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

      const result = await handlers.runAgentHealthCheck({});

      expect(registry.runHealthChecks).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('agent-1: healthy');
      expect(getText(result)).toContain('agent-2: offline (3 failures)');
    });

    it('claims a task on a remote agent', async () => {
      const client = {
        claimTask: vi.fn().mockResolvedValue({ success: true }),
      };
      const registry = createMockRegistry([], { 'agent-1': client });
      const { handlers } = loadHandlers({ registry });

      const result = await handlers.claimTaskOnAgent({
        agent_id: 'agent-1',
        task_id: 'task-123',
        lease_seconds: 90,
      });

      expect(client.claimTask).toHaveBeenCalledWith('task-123', 90);
      expect(getText(result)).toContain('Claimed task task-123 on agent agent-1');
    });

    it('returns not found when claiming a task on a missing or disabled agent', async () => {
      const { handlers } = loadHandlers({ registry: createMockRegistry() });

      const result = await handlers.claimTaskOnAgent({
        agent_id: 'missing-agent',
        task_id: 'task-123',
      });

      expect(result.error_code).toBe('AGENT_NOT_FOUND');
      expect(getText(result)).toContain('Agent not found or disabled: missing-agent');
    });

    it('records a heartbeat with a default empty payload', async () => {
      const client = {
        recordHeartbeat: vi.fn().mockResolvedValue(undefined),
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

      const result = await handlers.recordAgentHeartbeat({ agent_id: 'agent-1' });

      expect(client.recordHeartbeat).toHaveBeenCalledWith({});
      expect(getText(result)).toContain('Recorded heartbeat for Build One');
    });

    it('returns an operation failure when heartbeat recording is unsupported', async () => {
      const registry = createMockRegistry([
        {
          id: 'agent-1',
          name: 'Build One',
          host: '10.0.0.10',
          port: 3460,
        },
      ], { 'agent-1': {} });
      const { handlers } = loadHandlers({ registry });

      const result = await handlers.recordAgentHeartbeat({ agent_id: 'agent-1' });

      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getText(result)).toContain('Agent client does not support heartbeat recording');
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

      const result = await handlers.handleRunRemoteCommand({
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

      const result = await handlers.handleRunRemoteCommand({
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

      const result = await handlers.handleRunRemoteCommand({
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

      const result = await handlers.handleRunRemoteCommand({
        command: 'npm test',
        working_directory: '/repo',
      });

      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getText(result)).toContain('Remote execution failed: stream timed out. Use local execution as fallback.');
    });
  });

  describe('verify command handlers', () => {
    it('loads verify_command from project config and returns a local fallback warning in core results', async () => {
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

      const result = await handlers.runTestsCore({
        working_directory: '/repo',
      });

      expect(database.getProjectFromPath).toHaveBeenCalledWith('/repo');
      expect(database.getProjectConfig).toHaveBeenCalledWith('torque-server');
      expect(createRemoteTestRouter).toHaveBeenCalledWith({
        agentRegistry: registry,
        db: database,
        logger: loggerInstance,
      });
      expect(runVerifyCommand).toHaveBeenCalledWith('npm test && npm run lint', '/repo');
      expect(result.project).toBe('torque-server');
      expect(result.verify_command).toBe('npm test && npm run lint');
      expect(result.warning).toBe('Remote agent unavailable or not configured; tests ran locally.');
    });

    it('returns INVALID_PARAM when no verify_command is configured', async () => {
      const { handlers, runVerifyCommand } = loadHandlers({
        projectConfig: {},
      });

      const result = await handlers.handleRunTests({
        working_directory: '/repo',
      });

      expect(result.error_code).toBe('INVALID_PARAM');
      expect(runVerifyCommand).not.toHaveBeenCalled();
      expect(getText(result)).toBe('Error: No verify_command configured. Set it with set_project_defaults.');
    });

    it('delegates verify_command execution to handleRunRemoteCommand', async () => {
      const { handlers } = loadHandlers({
        projectConfig: {
          verify_command: 'npm test && npm run lint',
        },
      });
      const delegated = {
        content: [{ type: 'text', text: '[remote: remote-gpu-host] Exit code: 0\n\nall green' }],
        remote: true,
      };
      const handleRunRemoteCommand = vi.spyOn(handlers, 'handleRunRemoteCommand').mockResolvedValue(delegated);

      const result = await handlers.handleRunTests({
        working_directory: '/repo',
      });

      expect(handleRunRemoteCommand).toHaveBeenCalledWith({
        command: 'npm test && npm run lint',
        working_directory: '/repo',
        timeout: 600000,
      });
      expect(result).toBe(delegated);
    });
  });
});
