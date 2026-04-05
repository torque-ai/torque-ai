'use strict';

const { setupTestDb, teardownTestDb, getText } = require('../../../tests/vitest-setup');
const { createHandlers } = require('../handlers');

let handlers;
let mockRegistry;

function registerRemoteAgent(args) {
  return handlers.register_remote_agent(args);
}

function listRemoteAgents() {
  return handlers.list_remote_agents();
}

function getRemoteAgent(args) {
  return handlers.get_remote_agent(args);
}

function deleteRemoteAgent(args) {
  return handlers.remove_remote_agent(args);
}

function runAgentHealthCheck(args) {
  return handlers.check_remote_agent_health(args);
}

function createMockRegistry(agents = []) {
  const agentMap = new Map(agents.map(agent => [agent.id, { ...agent }]));

  return {
    register: vi.fn(({ id, name, host, port, secret, max_concurrent, tls, rejectUnauthorized }) => {
      const record = { id, name, host, port, secret, max_concurrent, tls, rejectUnauthorized };
      agentMap.set(id, { ...agentMap.get(id), ...record });
      return record;
    }),
    get: vi.fn(id => {
      const agent = agentMap.get(id);
      return agent ? { ...agent } : null;
    }),
    getAll: vi.fn(() => Array.from(agentMap.values()).map(agent => ({ ...agent }))),
    remove: vi.fn(id => {
      const existed = agentMap.has(id);
      agentMap.delete(id);
      return existed;
    }),
    getClient: vi.fn(() => null),
    runHealthChecks: vi.fn(async () => []),
  };
}

function setRegistry(agents = []) {
  mockRegistry = createMockRegistry(agents);
  handlers = createHandlers({ agentRegistry: mockRegistry });
  return mockRegistry;
}

describe('remote agent handlers', () => {
  beforeAll(() => {
    setupTestDb('remote-agent-handlers');
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    setRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    handlers = undefined;
    mockRegistry = undefined;
  });

  describe('register_remote_agent', () => {
    it('registers an agent with explicit host, port, and max_concurrent', () => {
      const result = registerRemoteAgent({
        name: 'BuildServer-01',
        host: '192.0.2.50',
        port: 3461,
        secret: 'test-secret',
        max_concurrent: 8,
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Registered agent "BuildServer-01"');
      expect(getText(result)).toContain('http://192.0.2.50:3461');
      expect(mockRegistry.register).toHaveBeenCalledWith({
        id: 'buildserver-01',
        name: 'BuildServer-01',
        host: '192.0.2.50',
        port: 3461,
        secret: 'test-secret',
        max_concurrent: 8,
        tls: false,
        rejectUnauthorized: true,
      });
    });

    it('passes explicit tls settings through to the registry', () => {
      const result = registerRemoteAgent({
        name: 'Secure Agent',
        host: 'secure.example.test',
        port: 443,
        secret: 'tls-secret',
        tls: true,
        rejectUnauthorized: false,
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('https://secure.example.test:443');
      expect(getText(result)).toContain('tls: enabled');
      expect(getText(result)).toContain('rejectUnauthorized: false');
      expect(mockRegistry.register).toHaveBeenCalledWith({
        id: 'secure-agent',
        name: 'Secure Agent',
        host: 'secure.example.test',
        port: 443,
        secret: 'tls-secret',
        max_concurrent: 3,
        tls: true,
        rejectUnauthorized: false,
      });
    });

    it('uses default port and max_concurrent when omitted', () => {
      const result = registerRemoteAgent({
        name: 'Agent03',
        host: '10.0.0.6',
        secret: 'secret',
      });

      expect(result.isError).toBeFalsy();
      expect(mockRegistry.register).toHaveBeenCalledWith({
        id: 'agent03',
        name: 'Agent03',
        host: '10.0.0.6',
        port: 3460,
        secret: 'secret',
        max_concurrent: 3,
        tls: false,
        rejectUnauthorized: true,
      });
    });

    it('preserves existing tls settings when re-registering without explicit tls args', () => {
      setRegistry([
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

      registerRemoteAgent({
        name: 'Secure Agent',
        host: 'new.example.test',
        port: 8443,
        secret: 'new-secret',
      });

      expect(mockRegistry.register).toHaveBeenCalledWith({
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

    it('normalizes names into deterministic ids', () => {
      const result = registerRemoteAgent({
        name: 'My New Agent 01 !!!',
        host: '10.0.0.7',
        secret: 'secret',
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('id: my-new-agent-01');
    });

    it('requires name, host, and secret', () => {
      const missingName = registerRemoteAgent({ host: '192.0.2.50', secret: 'test-secret' });
      const missingHost = registerRemoteAgent({ name: 'Agent', secret: 'test-secret' });
      const missingSecret = registerRemoteAgent({ name: 'Agent', host: '192.0.2.50' });

      expect(missingName.isError).toBe(true);
      expect(getText(missingName)).toContain('Required: name, host, secret');
      expect(missingHost.isError).toBe(true);
      expect(getText(missingHost)).toContain('Required: name, host, secret');
      expect(missingSecret.isError).toBe(true);
      expect(getText(missingSecret)).toContain('Required: name, host, secret');
    });

    it('uses the injected registry implementation', () => {
      const registryRef = {
        get: vi.fn(() => null),
        register: vi.fn().mockReturnValue({}),
      };
      const localHandlers = createHandlers({ agentRegistry: registryRef });
      const result = localHandlers.register_remote_agent({
        name: 'Agent',
        host: '10.0.0.1',
        secret: 'secret',
      });

      expect(result.isError).toBeFalsy();
      expect(registryRef.get).toHaveBeenCalledWith('agent');
      expect(registryRef.register).toHaveBeenCalledTimes(1);
    });

    it('propagates registration errors from the registry', () => {
      mockRegistry.register = vi.fn(() => {
        const err = new Error('UNIQUE constraint failed: remote_agents.id');
        err.code = 'SQLITE_CONSTRAINT';
        throw err;
      });

      expect(() => registerRemoteAgent({
        name: 'Agent',
        host: '10.0.0.1',
        secret: 'secret',
      })).toThrow('UNIQUE constraint');
    });

    it('errors when registry is unavailable', () => {
      const localHandlers = createHandlers();
      const result = localHandlers.register_remote_agent({
        name: 'Agent',
        host: '10.0.0.1',
        secret: 'secret',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent registry not initialized');
    });
  });

  describe('list_remote_agents', () => {
    it('returns a helpful message when no agents are registered', () => {
      const result = listRemoteAgents();

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No remote agents registered');
    });

    it('formats a healthy enabled agent without exposing the secret', () => {
      setRegistry([
        {
          id: 'agent-01',
          name: 'Build One',
          host: '192.0.2.10',
          port: 3460,
          secret: 'do-not-show',
          tls: 1,
          rejectUnauthorized: 0,
          status: 'healthy',
          enabled: 1,
          os_platform: 'linux',
          last_health_check: '2026-03-01T00:00:00.000Z',
        },
      ]);

      const result = listRemoteAgents();
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Build One');
      expect(text).toContain('agent-01');
      expect(text).toContain('https://192.0.2.10:3460');
      expect(text).toContain('tls: enabled');
      expect(text).toContain('rejectUnauthorized: false');
      expect(text).toContain('healthy');
      expect(text).toContain('enabled');
      expect(text).toContain('os: linux');
      expect(text).toContain('last check: 2026-03-01T00:00:00.000Z');
      expect(text).not.toContain('do-not-show');
    });

    it('formats agents without status as unknown and missing checks as never', () => {
      setRegistry([
        {
          id: 'agent-unknown',
          name: 'NoStatus',
          host: '10.0.0.9',
          port: 3499,
          tls: 0,
          status: null,
          enabled: 1,
          last_health_check: null,
        },
      ]);

      const result = listRemoteAgents();

      expect(getText(result)).toContain('NoStatus');
      expect(getText(result)).toContain('unknown');
      expect(getText(result)).toContain('never');
      expect(getText(result)).toContain('enabled');
      expect(getText(result)).toContain('tls: disabled');
    });

    it('joins multiple agents with newline separators', () => {
      setRegistry([
        {
          id: 'a1',
          name: 'Agent One',
          host: '10.0.0.1',
          port: 3460,
          tls: 0,
          status: 'healthy',
          enabled: 1,
          last_health_check: '2026-03-01T00:00:00Z',
        },
        {
          id: 'a2',
          name: 'Agent Two',
          host: '10.0.0.2',
          port: 3461,
          tls: 1,
          rejectUnauthorized: 0,
          status: 'down',
          enabled: 0,
          last_health_check: '2026-03-01T01:00:00Z',
        },
      ]);

      const text = getText(listRemoteAgents());
      const lines = text.split('\n');

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('Agent One');
      expect(lines[1]).toContain('Agent Two');
      expect(text).toContain('disabled');
      expect(text).toContain('down');
      expect(text).toContain('http://10.0.0.1:3460');
      expect(text).toContain('https://10.0.0.2:3461');
    });

    it('uses the injected registry implementation', () => {
      const registryRef = {
        getAll: vi.fn(() => []),
      };
      const localHandlers = createHandlers({ agentRegistry: registryRef });

      localHandlers.list_remote_agents();

      expect(registryRef.getAll).toHaveBeenCalledTimes(1);
    });

    it('returns an error when registry is unavailable', () => {
      const localHandlers = createHandlers();
      const result = localHandlers.list_remote_agents();

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('propagates getAll failures from the registry', () => {
      mockRegistry.getAll = vi.fn(() => {
        throw new Error('database unavailable');
      });

      expect(() => listRemoteAgents()).toThrow('database unavailable');
    });
  });

  describe('remove_remote_agent', () => {
    it('removes an existing agent successfully', () => {
      setRegistry([
        { id: 'agent-01', name: 'Build One', host: '10.0.0.1', port: 3460 },
      ]);

      const result = deleteRemoteAgent({ agent_id: 'agent-01' });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Removed agent agent-01');
      expect(mockRegistry.get).toHaveBeenCalledWith('agent-01');
      expect(mockRegistry.remove).toHaveBeenCalledWith('agent-01');
      expect(mockRegistry.getAll()).toEqual([]);
    });

    it('returns not found for a missing agent', () => {
      const result = deleteRemoteAgent({ agent_id: 'missing-agent' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent not found: missing-agent');
      expect(mockRegistry.remove).not.toHaveBeenCalled();
    });

    it('requires agent_id', () => {
      const result = deleteRemoteAgent({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Required: agent_id');
      expect(mockRegistry.remove).not.toHaveBeenCalled();
      expect(mockRegistry.get).not.toHaveBeenCalled();
    });

    it('uses the injected registry implementation', () => {
      const registryRef = {
        get: vi.fn(() => ({ id: 'agent-01', name: 'Build One' })),
        remove: vi.fn(),
      };
      const localHandlers = createHandlers({ agentRegistry: registryRef });

      localHandlers.remove_remote_agent({ agent_id: 'agent-01' });

      expect(registryRef.get).toHaveBeenCalledWith('agent-01');
      expect(registryRef.remove).toHaveBeenCalledWith('agent-01');
    });

    it('returns error when registry is unavailable', () => {
      const localHandlers = createHandlers();
      const result = localHandlers.remove_remote_agent({ agent_id: 'agent-01' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('propagates get() failures from the registry', () => {
      mockRegistry.get = vi.fn(() => {
        throw new Error('lookup unavailable');
      });

      expect(() => deleteRemoteAgent({ agent_id: 'agent-01' })).toThrow('lookup unavailable');
    });
  });

  describe('get_remote_agent', () => {
    it('gets a single agent by id without exposing the secret', () => {
      setRegistry([
        {
          id: 'agent-01',
          name: 'Build One',
          host: '10.0.0.1',
          port: 3460,
          secret: 'do-not-show',
          tls: 1,
          rejectUnauthorized: 1,
          status: 'healthy',
          enabled: 1,
          last_health_check: '2026-03-01T00:00:00.000Z',
        },
      ]);

      const result = getRemoteAgent({ agent_id: 'agent-01' });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Build One');
      expect(text).toContain('agent-01');
      expect(text).toContain('https://10.0.0.1:3460');
      expect(text).toContain('tls: enabled');
      expect(text).toContain('rejectUnauthorized: true');
      expect(text).toContain('last check: 2026-03-01T00:00:00.000Z');
      expect(text).not.toContain('do-not-show');
    });

    it('requires agent_id', () => {
      const result = getRemoteAgent({});

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Required: agent_id');
      expect(mockRegistry.get).not.toHaveBeenCalled();
    });

    it('returns not found when the agent does not exist', () => {
      const result = getRemoteAgent({ agent_id: 'missing-agent' });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Agent not found: missing-agent');
      expect(mockRegistry.get).toHaveBeenCalledWith('missing-agent');
    });

    it('uses the injected registry implementation', () => {
      const registryRef = {
        get: vi.fn(() => ({ id: 'agent-01', name: 'Build One', host: '10.0.0.1', port: 3460 })),
      };
      const localHandlers = createHandlers({ agentRegistry: registryRef });

      localHandlers.get_remote_agent({ agent_id: 'agent-01' });

      expect(registryRef.get).toHaveBeenCalledWith('agent-01');
    });

    it('returns an error when registry is unavailable', () => {
      const localHandlers = createHandlers();
      const result = localHandlers.get_remote_agent({ agent_id: 'agent-01' });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('propagates get failures from the registry', () => {
      mockRegistry.get = vi.fn(() => {
        throw new Error('lookup unavailable');
      });

      expect(() => getRemoteAgent({ agent_id: 'agent-01' })).toThrow('lookup unavailable');
    });
  });

  describe('check_remote_agent_health', () => {
    it('checks all agents and returns no-agents message when none are active', async () => {
      const result = await runAgentHealthCheck({});

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No agents to check');
    });

    it('checks all agents and formats healthy status lines', async () => {
      mockRegistry.runHealthChecks.mockResolvedValue([
        { id: 'agent-1', status: 'healthy' },
        { id: 'agent-2', status: 'degraded', failures: 2 },
      ]);

      const result = await runAgentHealthCheck({});

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('agent-1: healthy');
      expect(getText(result)).toContain('agent-2: degraded (2 failures)');
      expect(mockRegistry.runHealthChecks).toHaveBeenCalledTimes(1);
    });

    it('uses the injected registry implementation for bulk checks', async () => {
      const registryRef = {
        runHealthChecks: vi.fn().mockResolvedValue([]),
      };
      const localHandlers = createHandlers({ agentRegistry: registryRef });

      await localHandlers.check_remote_agent_health({});

      expect(registryRef.runHealthChecks).toHaveBeenCalledTimes(1);
    });

    it('returns error when registry is unavailable for bulk checks', async () => {
      const localHandlers = createHandlers();
      const result = await localHandlers.check_remote_agent_health({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('propagates runHealthChecks failures', async () => {
      mockRegistry.runHealthChecks.mockRejectedValue(new Error('health scheduler crashed'));

      const result = await runAgentHealthCheck({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('health scheduler crashed');
    });

    it('checks a specific healthy agent and includes memory when available', async () => {
      const mockClient = {
        checkHealth: vi.fn().mockResolvedValue({
          running_tasks: 1,
          max_concurrent: 3,
          system: { memory_available_mb: 4096, platform: 'linux' },
        }),
      };
      setRegistry([
        {
          id: 'agent-1',
          name: 'Build One',
          host: '10.0.0.1',
          port: 3460,
          status: 'unknown',
          consecutive_failures: 0,
        },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await runAgentHealthCheck({ agent_id: 'agent-1' });

      expect(result.isError).toBeFalsy();
      expect(mockRegistry.getClient).toHaveBeenCalledWith('agent-1');
      expect(mockClient.checkHealth).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('Build One');
      expect(getText(result)).toContain('healthy');
      expect(getText(result)).toContain('1/3');
      expect(getText(result)).toContain('os: linux');
      expect(getText(result)).toContain('4096MB free');
    });

    it('checks a specific healthy agent when memory info is missing', async () => {
      const mockClient = {
        checkHealth: vi.fn().mockResolvedValue({
          running_tasks: 0,
          max_concurrent: 2,
          system: {},
        }),
      };
      setRegistry([
        {
          id: 'agent-1',
          name: 'Build Two',
          host: '10.0.0.2',
          port: 3461,
          status: 'healthy',
          consecutive_failures: 0,
        },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await runAgentHealthCheck({ agent_id: 'agent-1' });

      expect(result.isError).toBeFalsy();
      expect(mockClient.checkHealth).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('Build Two');
      expect(getText(result)).toContain('healthy');
      expect(getText(result)).toContain('0/2');
      expect(getText(result)).toContain('N/A');
    });

    it('checks a specific unhealthy agent when checkHealth returns null', async () => {
      const mockClient = {
        checkHealth: vi.fn().mockResolvedValue(null),
      };
      setRegistry([
        {
          id: 'agent-1',
          name: 'Build One',
          host: '10.0.0.1',
          port: 3460,
          status: 'degraded',
          consecutive_failures: 2,
        },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await runAgentHealthCheck({ agent_id: 'agent-1' });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Build One');
      expect(getText(result)).toContain('degraded');
      expect(getText(result)).toContain('2 consecutive failures');
    });

    it('returns not found for unknown agent_id', async () => {
      const result = await runAgentHealthCheck({ agent_id: 'missing-agent' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent not found or disabled: missing-agent');
    });

    it('passes through health-check failures from getClient()', async () => {
      const mockClient = {
        checkHealth: vi.fn().mockRejectedValue(new Error('network down')),
      };
      setRegistry([{ id: 'agent-1', name: 'BadOne', host: '10.0.0.1', port: 3460 }]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await runAgentHealthCheck({ agent_id: 'agent-1' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('network down');
    });

    it('returns error when registry is unavailable for a specific check', async () => {
      const localHandlers = createHandlers();
      const result = await localHandlers.check_remote_agent_health({ agent_id: 'agent-1' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('uses the injected registry implementation for specific health checks', async () => {
      const mockClient = {
        checkHealth: vi.fn().mockResolvedValue({
          running_tasks: 0,
          max_concurrent: 1,
          system: { memory_available_mb: 1024 },
        }),
      };
      const registryRef = createMockRegistry([
        {
          id: 'agent-1',
          name: 'Build One',
          host: '10.0.0.1',
          port: 3460,
          status: 'healthy',
          consecutive_failures: 0,
        },
      ]);
      registryRef.getClient.mockReturnValue(mockClient);
      const localHandlers = createHandlers({ agentRegistry: registryRef });

      const result = await localHandlers.check_remote_agent_health({ agent_id: 'agent-1' });

      expect(registryRef.getClient).toHaveBeenCalledWith('agent-1');
      expect(result.isError).toBeFalsy();
      expect(result).toHaveProperty('content');
    });
  });
});