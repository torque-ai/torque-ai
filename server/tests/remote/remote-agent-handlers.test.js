'use strict';

/**
 * Tests for server/handlers/remote-agent-handlers.js
 *
 * The handler module exports PascalCase handler names; these local aliases
 * are used to align tests with the requested API intent.
 */

const { setupTestDb, teardownTestDb, getText } = require('../vitest-setup');
const handlers = require('../../handlers/remote-agent-handlers');

// API aliases requested by the task
const registerRemoteAgent = handlers.registerRemoteAgent;
const listRemoteAgents = handlers.listRemoteAgents;
const getRemoteAgent = handlers.getRemoteAgent;
const deleteRemoteAgent = handlers.deleteRemoteAgent;
const claimTaskOnAgent = handlers.claimTaskOnAgent;
const recordAgentHeartbeat = handlers.recordAgentHeartbeat;
const runAgentHealthCheck = handlers.runAgentHealthCheck;

// ── Helpers ──────────────────────────────────────────────────

let mockRegistry;
let originalGetRegistry;
let getRegistrySpy;

function createMockRegistry(agents = []) {
  const agentMap = new Map(agents.map(agent => [agent.id, { ...agent }]));

  return {
    register: vi.fn(({ id, name, host, port, secret, max_concurrent, tls, rejectUnauthorized }) => {
      const record = { id, name, host, port, secret, max_concurrent, tls, rejectUnauthorized };
      agentMap.set(id, { ...agentMap.get(id), ...record });
      return record;
    }),
    get: vi.fn(id => agentMap.get(id)),
    getAll: vi.fn(() => Array.from(agentMap.values()).map(agent => ({ ...agent }))),
    remove: vi.fn(id => {
      const existed = agentMap.has(id);
      agentMap.delete(id);
      return existed;
    }),
    getClient: vi.fn(),
    runHealthChecks: vi.fn(async () => []),
  };
}

function setRegistry(agents = []) {
  mockRegistry = createMockRegistry(agents);
  getRegistrySpy = vi.fn(() => mockRegistry);
  handlers._getRegistry = getRegistrySpy;
  return mockRegistry;
}

// ── Tests ────────────────────────────────────────────────────

describe('remote agent handlers', () => {
  beforeAll(() => {
    setupTestDb('remote-agent-handlers');
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    originalGetRegistry = handlers._getRegistry;
    setRegistry();
  });

  afterEach(() => {
    if (getRegistrySpy) {
      expect(getRegistrySpy).toBeDefined();
      getRegistrySpy.mockRestore && getRegistrySpy.mockRestore();
    }
    handlers._getRegistry = originalGetRegistry;
    vi.restoreAllMocks();
    mockRegistry = undefined;
    getRegistrySpy = undefined;
    originalGetRegistry = undefined;
  });

  describe('registerRemoteAgent', () => {
    it('registers an agent with explicit host, port, and max_concurrent', () => {
      const result = registerRemoteAgent({
        name: 'BuildServer-01',
        host: '192.0.2.50',
        port: 3461,
        secret: 'test-secret',
        max_concurrent: 8,
      });

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Registered agent "BuildServer-01"');
      expect(text).toContain('192.0.2.50:3461');
      expect(mockRegistry.register).toHaveBeenCalledTimes(1);
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
      expect(mockRegistry.getAll).not.toHaveBeenCalled();
      expect(mockRegistry.remove).not.toHaveBeenCalled();
      expect(mockRegistry.runHealthChecks).not.toHaveBeenCalled();
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

    it('uses default port when omitted', () => {
      const result = registerRemoteAgent({
        name: 'Agent-02',
        host: '10.0.0.5',
        secret: 'secret2',
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('10.0.0.5:3460');
      expect(mockRegistry.register).toHaveBeenCalledWith({
        id: 'agent-02',
        name: 'Agent-02',
        host: '10.0.0.5',
        port: 3460,
        secret: 'secret2',
        max_concurrent: 3,
        tls: false,
        rejectUnauthorized: true,
      });
    });

    it('uses default max_concurrent when omitted', () => {
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

    it('normalizes names into deterministic IDs', () => {
      const result = registerRemoteAgent({
        name: 'My New Agent 01 !!!',
        host: '10.0.0.7',
        secret: 'secret',
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('id: my-new-agent-01');
    });

    it('is case-normalized in generated IDs', () => {
      const first = registerRemoteAgent({
        name: 'UPPERCASE_NAME',
        host: '10.1.1.1',
        secret: 's1',
      });
      const second = registerRemoteAgent({
        name: 'uppercase-name',
        host: '10.1.1.2',
        secret: 's2',
      });

      expect(first.isError).toBeFalsy();
      expect(second.isError).toBeFalsy();
      expect(mockRegistry.register).toHaveBeenCalledTimes(2);
      expect(mockRegistry.getAll()).toEqual([
        {
          id: 'uppercase-name',
          name: 'uppercase-name',
          host: '10.1.1.2',
          port: 3460,
          secret: 's2',
          max_concurrent: 3,
          tls: false,
          rejectUnauthorized: true,
        },
      ]);
      expect(getText(second)).toContain('id: uppercase-name');
    });

    it('returns an error when name is missing', () => {
      const result = registerRemoteAgent({
        host: '192.0.2.50',
        secret: 'test-secret',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Required: name, host, secret');
      expect(mockRegistry.register).not.toHaveBeenCalled();
    });

    it('returns an error when host is missing', () => {
      const result = registerRemoteAgent({
        name: 'Agent',
        secret: 'test-secret',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Required: name, host, secret');
      expect(mockRegistry.register).not.toHaveBeenCalled();
    });

    it('returns an error when secret is missing', () => {
      const result = registerRemoteAgent({
        name: 'Agent',
        host: '192.0.2.50',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Required: name, host, secret');
      expect(mockRegistry.register).not.toHaveBeenCalled();
    });

    it('returns an error when all required fields are missing', () => {
      const result = registerRemoteAgent({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Required: name, host, secret');
      expect(mockRegistry.register).not.toHaveBeenCalled();
    });

    it('supports replacement of an existing normalized id (duplicate names)', () => {
      registerRemoteAgent({
        name: 'agent-one',
        host: '10.0.0.1',
        secret: 'first',
        max_concurrent: 2,
      });
      registerRemoteAgent({
        name: 'agent one',
        host: '10.0.0.2',
        secret: 'second',
        max_concurrent: 4,
      });

      expect(mockRegistry.getAll()).toEqual([
        {
          id: 'agent-one',
          name: 'agent one',
          host: '10.0.0.2',
          port: 3460,
          secret: 'second',
          max_concurrent: 4,
          tls: false,
          rejectUnauthorized: true,
        },
      ]);
      expect(mockRegistry.register).toHaveBeenCalledTimes(2);
    });

    it('preserves existing tls settings when re-registering without explicit tls args', () => {
      setRegistry([
        {
          id: 'buildserver-01',
          name: 'BuildServer-01',
          host: '192.0.2.50',
          port: 3461,
          secret: 'old-secret',
          max_concurrent: 4,
          tls: 1,
          rejectUnauthorized: 0,
        },
      ]);

      const result = registerRemoteAgent({
        name: 'BuildServer-01',
        host: '192.0.2.51',
        port: 3462,
        secret: 'new-secret',
      });

      expect(result.isError).toBeFalsy();
      expect(mockRegistry.register).toHaveBeenCalledWith({
        id: 'buildserver-01',
        name: 'BuildServer-01',
        host: '192.0.2.51',
        port: 3462,
        secret: 'new-secret',
        max_concurrent: 3,
        tls: true,
        rejectUnauthorized: false,
      });
      expect(mockRegistry.getAll()).toStrictEqual([
        {
          id: 'buildserver-01',
          name: 'BuildServer-01',
          host: '192.0.2.51',
          port: 3462,
          secret: 'new-secret',
          max_concurrent: 3,
          tls: true,
          rejectUnauthorized: false,
        },
      ]);
      expect(getText(result)).toContain('https://192.0.2.51:3462');
      expect(getText(result)).toContain('rejectUnauthorized: false');

      const listText = getText(listRemoteAgents());
      expect(listText).toContain('https://192.0.2.51:3462');
      expect(listText).toContain('tls: enabled');
      expect(listText).toContain('rejectUnauthorized: false');
      expect(listText).not.toContain('new-secret');

      const detailText = getText(getRemoteAgent({ agent_id: 'buildserver-01' }));
      expect(detailText).toContain('https://192.0.2.51:3462');
      expect(detailText).toContain('tls: enabled');
      expect(detailText).toContain('rejectUnauthorized: false');
      expect(detailText).not.toContain('new-secret');
    });

    it('round-trips explicit tls settings through register, update, list, and get', () => {
      const initialResult = registerRemoteAgent({
        name: 'TLS Roundtrip Agent',
        host: 'secure.example.test',
        port: 443,
        secret: 'initial-secret',
        max_concurrent: 6,
        tls: true,
        rejectUnauthorized: false,
      });

      expect(initialResult.isError).toBeFalsy();
      expect(mockRegistry.register).toHaveBeenNthCalledWith(1, {
        id: 'tls-roundtrip-agent',
        name: 'TLS Roundtrip Agent',
        host: 'secure.example.test',
        port: 443,
        secret: 'initial-secret',
        max_concurrent: 6,
        tls: true,
        rejectUnauthorized: false,
      });
      expect(mockRegistry.getAll()).toStrictEqual([
        {
          id: 'tls-roundtrip-agent',
          name: 'TLS Roundtrip Agent',
          host: 'secure.example.test',
          port: 443,
          secret: 'initial-secret',
          max_concurrent: 6,
          tls: true,
          rejectUnauthorized: false,
        },
      ]);

      let listText = getText(listRemoteAgents());
      expect(listText).toContain('https://secure.example.test:443');
      expect(listText).toContain('tls: enabled');
      expect(listText).toContain('rejectUnauthorized: false');
      expect(listText).not.toContain('initial-secret');

      let detailText = getText(getRemoteAgent({ agent_id: 'tls-roundtrip-agent' }));
      expect(detailText).toContain('https://secure.example.test:443');
      expect(detailText).toContain('tls: enabled');
      expect(detailText).toContain('rejectUnauthorized: false');
      expect(detailText).not.toContain('initial-secret');

      const updatedResult = registerRemoteAgent({
        name: 'TLS Roundtrip Agent',
        host: 'worker.example.test',
        port: 8080,
        secret: 'updated-secret',
        max_concurrent: 2,
        tls: false,
        rejectUnauthorized: true,
      });

      expect(updatedResult.isError).toBeFalsy();
      expect(mockRegistry.register).toHaveBeenNthCalledWith(2, {
        id: 'tls-roundtrip-agent',
        name: 'TLS Roundtrip Agent',
        host: 'worker.example.test',
        port: 8080,
        secret: 'updated-secret',
        max_concurrent: 2,
        tls: false,
        rejectUnauthorized: true,
      });
      expect(mockRegistry.getAll()).toStrictEqual([
        {
          id: 'tls-roundtrip-agent',
          name: 'TLS Roundtrip Agent',
          host: 'worker.example.test',
          port: 8080,
          secret: 'updated-secret',
          max_concurrent: 2,
          tls: false,
          rejectUnauthorized: true,
        },
      ]);

      listText = getText(listRemoteAgents());
      expect(listText).toContain('http://worker.example.test:8080');
      expect(listText).toContain('tls: disabled');
      expect(listText).toContain('rejectUnauthorized: true');
      expect(listText).not.toContain('updated-secret');

      detailText = getText(getRemoteAgent({ agent_id: 'tls-roundtrip-agent' }));
      expect(detailText).toContain('http://worker.example.test:8080');
      expect(detailText).toContain('tls: disabled');
      expect(detailText).toContain('rejectUnauthorized: true');
      expect(detailText).not.toContain('updated-secret');
    });

    it('propagates registration errors from the registry', () => {
      mockRegistry.register = vi.fn(() => {
        const err = new Error('UNIQUE constraint failed: remote_agents.id');
        err.code = 'SQLITE_CONSTRAINT';
        throw err;
      });
      handlers._getRegistry = () => mockRegistry;

      expect(() => registerRemoteAgent({
        name: 'Agent',
        host: '10.0.0.1',
        secret: 'secret',
      })).toThrow('UNIQUE constraint');
    });

    it('calls the injected _getRegistry implementation', () => {
      const registryRef = { register: vi.fn().mockReturnValue({}) };
      handlers._getRegistry = vi.fn(() => registryRef);
      const result = registerRemoteAgent({
        name: 'Agent',
        host: '10.0.0.1',
        secret: 'secret',
      });

      expect(result.isError).toBeFalsy();
      expect(handlers._getRegistry).toHaveBeenCalledTimes(1);
      expect(registryRef.register).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('Registered agent "Agent"');
    });

    it('errors when registry is unavailable', () => {
      handlers._getRegistry = () => null;

      const result = registerRemoteAgent({
        name: 'Agent',
        host: '10.0.0.1',
        secret: 'secret',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent registry not initialized');
    });
  });

  describe('listRemoteAgents', () => {
    it('returns a helpful message when no agents are registered', () => {
      const result = listRemoteAgents();

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No remote agents registered');
    });

    it('formats a healthy enabled agent with host and status', () => {
      setRegistry([
        {
          id: 'agent-01',
          name: 'Build One',
          host: '192.0.2.10',
          port: 3460,
          tls: 1,
          rejectUnauthorized: 0,
          status: 'healthy',
          enabled: 1,
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
      expect(text).toContain('last check: 2026-03-01T00:00:00.000Z');
      expect(text).not.toContain('unknown');
    });

    it('formats an agent without status as unknown', () => {
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

    it('formats a disabled agent correctly', () => {
      setRegistry([
        {
          id: 'agent-down',
          name: 'Disabled',
          host: '10.0.0.10',
          port: 3470,
          tls: 1,
          rejectUnauthorized: 1,
          status: 'degraded',
          enabled: 0,
          last_health_check: 'never',
        },
      ]);
      const result = listRemoteAgents();

      expect(getText(result)).toContain('Disabled');
      expect(getText(result)).toContain('disabled');
      expect(getText(result)).toContain('degraded');
      expect(getText(result)).toContain('https://10.0.0.10:3470');
      expect(getText(result)).toContain('rejectUnauthorized: true');
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

    it('invokes the injected _getRegistry getter', () => {
      const localGetter = vi.fn(() => mockRegistry);
      handlers._getRegistry = localGetter;

      listRemoteAgents();

      expect(localGetter).toHaveBeenCalledTimes(1);
      expect(localGetter).toHaveBeenCalledWith();
    });

    it('returns an error when registry is unavailable', () => {
      handlers._getRegistry = () => null;

      const result = listRemoteAgents();

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('propagates getAll failures from the registry', () => {
      mockRegistry.getAll = vi.fn(() => {
        throw new Error('database unavailable');
      });
      handlers._getRegistry = () => mockRegistry;

      expect(() => listRemoteAgents()).toThrow('database unavailable');
    });
  });

  describe('deleteRemoteAgent', () => {
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

    it('returns missing required parameter when no agent_id is supplied', () => {
      const result = deleteRemoteAgent({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Required: agent_id');
      expect(mockRegistry.remove).not.toHaveBeenCalled();
      expect(mockRegistry.get).not.toHaveBeenCalled();
    });

    it('returns error when agent_id is empty string', () => {
      const result = deleteRemoteAgent({ agent_id: '' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Required: agent_id');
      expect(mockRegistry.get).not.toHaveBeenCalled();
    });

    it('invokes _getRegistry during deletion', () => {
      setRegistry([
        { id: 'agent-01', name: 'Build One', host: '10.0.0.1', port: 3460 },
      ]);
      const localGetter = vi.fn(() => mockRegistry);
      handlers._getRegistry = localGetter;

      deleteRemoteAgent({ agent_id: 'agent-01' });

      expect(localGetter).toHaveBeenCalledTimes(1);
    });

    it('returns error when registry is unavailable', () => {
      handlers._getRegistry = () => null;

      const result = deleteRemoteAgent({ agent_id: 'agent-01' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('propagates get() failures from the registry', () => {
      mockRegistry.get = vi.fn(() => {
        throw new Error('lookup unavailable');
      });
      handlers._getRegistry = () => mockRegistry;

      expect(() => deleteRemoteAgent({ agent_id: 'agent-01' })).toThrow('lookup unavailable');
    });
  });

  describe('getRemoteAgent', () => {
    it('gets a single agent by id', () => {
      setRegistry([
        {
          id: 'agent-01',
          name: 'Build One',
          host: '10.0.0.1',
          port: 3460,
          tls: 1,
          rejectUnauthorized: 0,
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
      expect(text).toContain('rejectUnauthorized: false');
      expect(text).toContain('healthy');
      expect(text).toContain('enabled');
      expect(text).toContain('2026-03-01T00:00:00.000Z');
      expect(mockRegistry.get).toHaveBeenCalledWith('agent-01');
    });

    it('requires agent_id', () => {
      const result = getRemoteAgent({});

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Required: agent_id');
      expect(mockRegistry.get).not.toHaveBeenCalled();
    });

    it('returns error for missing agent', () => {
      const result = getRemoteAgent({ agent_id: 'missing-agent' });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Agent not found: missing-agent');
      expect(mockRegistry.get).toHaveBeenCalledWith('missing-agent');
    });

    it('returns an error when registry is unavailable', () => {
      handlers._getRegistry = () => null;

      const result = getRemoteAgent({ agent_id: 'agent-01' });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('invokes the injected _getRegistry implementation', () => {
      const localGetter = vi.fn(() => mockRegistry);
      handlers._getRegistry = localGetter;

      getRemoteAgent({ agent_id: 'agent-01' });

      expect(localGetter).toHaveBeenCalledTimes(1);
      expect(localGetter).toHaveBeenCalledWith();
    });

    it('propagates get failures from the registry', () => {
      mockRegistry.get = vi.fn(() => {
        throw new Error('lookup unavailable');
      });
      handlers._getRegistry = () => mockRegistry;

      expect(() => getRemoteAgent({ agent_id: 'agent-01' })).toThrow('lookup unavailable');
    });
  });

  describe('claimTaskOnAgent', () => {
    it('claims a task on a remote agent', async () => {
      const mockClient = {
        claimTask: vi.fn().mockResolvedValue({ success: true, lease_id: 'lease-1' }),
      };
      setRegistry([
        { id: 'agent-01', name: 'Worker', host: '10.0.0.1', port: 3460 },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await claimTaskOnAgent({
        agent_id: 'agent-01',
        task_id: 'task-01',
        lease_seconds: 120,
      });

      expect(result.isError).toBeFalsy();
      expect(mockRegistry.getClient).toHaveBeenCalledWith('agent-01');
      expect(mockClient.claimTask).toHaveBeenCalledWith('task-01', 120);
      expect(getText(result)).toContain('Claimed task task-01 on agent agent-01');
    });

    it('requires both agent_id and task_id', async () => {
      const missingAgentId = await claimTaskOnAgent({ task_id: 'task-01' });
      const missingTaskId = await claimTaskOnAgent({ agent_id: 'agent-01' });

      expect(missingAgentId.isError).toBeTruthy();
      expect(getText(missingAgentId)).toContain('Required: agent_id, task_id');
      expect(missingTaskId.isError).toBeTruthy();
      expect(getText(missingTaskId)).toContain('Required: agent_id, task_id');
      expect(mockRegistry.getClient).not.toHaveBeenCalled();
      expect(mockRegistry.get).not.toHaveBeenCalled();
    });

    it('returns not found for disabled or missing client', async () => {
      const result = await claimTaskOnAgent({
        agent_id: 'missing-agent',
        task_id: 'task-01',
      });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Agent not found or disabled: missing-agent');
    });

    it('returns error when client cannot claim tasks', async () => {
      const mockClient = { };
      setRegistry([
        { id: 'agent-01', name: 'Worker', host: '10.0.0.1', port: 3460 },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await claimTaskOnAgent({ agent_id: 'agent-01', task_id: 'task-01' });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Agent client does not support task claiming');
    });

    it('returns an error when claim is rejected', async () => {
      const mockClient = { claimTask: vi.fn().mockRejectedValue(new Error('declined')) };
      setRegistry([
        { id: 'agent-01', name: 'Worker', host: '10.0.0.1', port: 3460 },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await claimTaskOnAgent({ agent_id: 'agent-01', task_id: 'task-01' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('declined');
    });

    it('returns an error when claim endpoint reports failure', async () => {
      const mockClient = { claimTask: vi.fn().mockResolvedValue({ success: false }) };
      setRegistry([
        { id: 'agent-01', name: 'Worker', host: '10.0.0.1', port: 3460 },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await claimTaskOnAgent({ agent_id: 'agent-01', task_id: 'task-01' });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Failed to claim task task-01 on agent agent-01');
    });

    it('returns error when registry is unavailable for claims', async () => {
      handlers._getRegistry = () => null;
      const result = await claimTaskOnAgent({ agent_id: 'agent-01', task_id: 'task-01' });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('invokes the injected _getRegistry implementation for claims', async () => {
      const localGetter = vi.fn(() => mockRegistry);
      handlers._getRegistry = localGetter;

      await claimTaskOnAgent({ agent_id: 'agent-01', task_id: 'task-01' });

      expect(localGetter).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordAgentHeartbeat', () => {
    it('records heartbeat for a known agent', async () => {
      const mockClient = { recordHeartbeat: vi.fn().mockResolvedValue({ ok: true }) };
      setRegistry([
        { id: 'agent-01', name: 'Worker', host: '10.0.0.1', port: 3460 },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await recordAgentHeartbeat({
        agent_id: 'agent-01',
        heartbeat: { healthy: true, running_tasks: 2 },
      });

      expect(result.isError).toBeFalsy();
      expect(mockClient.recordHeartbeat).toHaveBeenCalledWith({ healthy: true, running_tasks: 2 });
      expect(mockRegistry.get).toHaveBeenCalledWith('agent-01');
      expect(mockRegistry.getClient).toHaveBeenCalledWith('agent-01');
      expect(getText(result)).toContain('Recorded heartbeat for Worker');
    });

    it('requires agent_id', async () => {
      const result = await recordAgentHeartbeat({});

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Required: agent_id');
      expect(mockRegistry.getClient).not.toHaveBeenCalled();
    });

    it('returns not found for missing or disabled agents', async () => {
      const result = await recordAgentHeartbeat({ agent_id: 'missing-agent' });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Agent not found: missing-agent');
      expect(mockRegistry.getClient).not.toHaveBeenCalled();
    });

    it('uses a default empty heartbeat payload', async () => {
      const mockClient = { recordHeartbeat: vi.fn().mockResolvedValue({ ok: true }) };
      setRegistry([
        { id: 'agent-01', name: 'Worker', host: '10.0.0.1', port: 3460 },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await recordAgentHeartbeat({ agent_id: 'agent-01' });

      expect(result.isError).toBeFalsy();
      expect(mockClient.recordHeartbeat).toHaveBeenCalledWith({});
      expect(getText(result)).toContain('Recorded heartbeat for Worker');
    });

    it('returns error when registry is unavailable for heartbeat', async () => {
      handlers._getRegistry = () => null;
      const result = await recordAgentHeartbeat({ agent_id: 'agent-01' });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('returns error when client does not support heartbeat', async () => {
      const mockClient = { };
      setRegistry([
        { id: 'agent-01', name: 'Worker', host: '10.0.0.1', port: 3460 },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await recordAgentHeartbeat({ agent_id: 'agent-01' });

      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Agent client does not support heartbeat recording');
    });

    it('propagates heartbeat failures', async () => {
      const mockClient = { recordHeartbeat: vi.fn().mockRejectedValue(new Error('downstream')) };
      setRegistry([
        { id: 'agent-01', name: 'Worker', host: '10.0.0.1', port: 3460 },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);

      const result = await recordAgentHeartbeat({ agent_id: 'agent-01' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('downstream');
    });

    it('invokes the injected _getRegistry implementation for heartbeats', async () => {
      const mockClient = { recordHeartbeat: vi.fn().mockResolvedValue({ ok: true }) };
      setRegistry([
        { id: 'agent-01', name: 'Worker', host: '10.0.0.1', port: 3460 },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);
      const localGetter = vi.fn(() => mockRegistry);
      handlers._getRegistry = localGetter;

      await recordAgentHeartbeat({ agent_id: 'agent-01' });

      expect(localGetter).toHaveBeenCalledTimes(1);
      expect(localGetter).toHaveBeenCalledWith();
    });
  });

  describe('runAgentHealthCheck', () => {
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
      handlers._getRegistry = () => mockRegistry;

      const result = await runAgentHealthCheck({});

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('agent-1: healthy');
      expect(text).toContain('agent-2: degraded (2 failures)');
      expect(mockRegistry.runHealthChecks).toHaveBeenCalledTimes(1);
    });

    it('checks all agents and omits failures when none are present', async () => {
      mockRegistry.runHealthChecks.mockResolvedValue([
        { id: 'agent-1', status: 'healthy' },
      ]);

      const result = await runAgentHealthCheck({});

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('agent-1: healthy');
      expect(getText(result)).not.toContain('failures');
    });

    it('invokes the injected _getRegistry getter for bulk checks', async () => {
      const localGetter = vi.fn(() => mockRegistry);
      handlers._getRegistry = localGetter;

      await runAgentHealthCheck({});

      expect(localGetter).toHaveBeenCalledTimes(1);
      expect(localGetter).toHaveBeenCalledWith();
    });

    it('returns error when registry is unavailable for bulk checks', async () => {
      handlers._getRegistry = () => null;

      const result = await runAgentHealthCheck({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('propagates runHealthChecks failures', async () => {
      mockRegistry.runHealthChecks.mockRejectedValue(new Error('health scheduler crashed'));
      handlers._getRegistry = () => mockRegistry;

      const result = await runAgentHealthCheck({});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('health scheduler crashed');
    });

    it('checks a specific healthy agent and includes memory when available', async () => {
      const mockClient = {
        checkHealth: vi.fn().mockResolvedValue({
          running_tasks: 1,
          max_concurrent: 3,
          system: { memory_available_mb: 4096 },
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
      handlers._getRegistry = () => mockRegistry;

      const result = await runAgentHealthCheck({ agent_id: 'agent-1' });

      expect(result.isError).toBeFalsy();
      expect(mockRegistry.getClient).toHaveBeenCalledWith('agent-1');
      expect(mockClient.checkHealth).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('Build One');
      expect(getText(result)).toContain('healthy');
      expect(getText(result)).toContain('1/3');
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
      handlers._getRegistry = () => null;

      const result = await runAgentHealthCheck({ agent_id: 'agent-1' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Agent registry not initialized');
    });

    it('invokes _getRegistry for specific health checks', async () => {
      const mockClient = {
        checkHealth: vi.fn().mockResolvedValue({
          running_tasks: 0,
          max_concurrent: 1,
          system: { memory_available_mb: 1024 },
        }),
      };
      setRegistry([
        {
          id: 'agent-1',
          name: 'Build One',
          host: '10.0.0.1',
          port: 3460,
          status: 'healthy',
          consecutive_failures: 0,
        },
      ]);
      mockRegistry.getClient.mockReturnValue(mockClient);
      const localGetter = vi.fn(() => mockRegistry);
      handlers._getRegistry = localGetter;

      const result = await runAgentHealthCheck({ agent_id: 'agent-1' });

      expect(localGetter).toHaveBeenCalledTimes(1);
      expect(result.isError).toBeFalsy();
      expect(result).toHaveProperty('content');
    });
  });
});
