'use strict';
/**
 * RemoteAgentRegistry Tests
 *
 * Uses vitest-setup.js helpers for DB setup with the full TORQUE schema.
 * Replaces real RemoteAgentClient instances in the registry's client Map
 * with lightweight mock objects to avoid network calls.
 */

const { setupTestDbModule, teardownTestDb, rawDb, resetTables } = require('../vitest-setup');
const { RemoteAgentRegistry } = require('../../remote/agent-registry');

let registry;

/**
 * Create a mock client object compatible with RemoteAgentClient's interface.
 */
function createMockClient({ host = '0.0.0.0', port = 3460, secret = 'mock', isAvailable = false, healthResult = null } = {}) {
  return {
    host,
    port,
    secret,
    _isAvailable: isAvailable,
    _healthResult: healthResult,
    isAvailable() { return this._isAvailable; },
    async checkHealth() { return this._healthResult; },
  };
}

describe('RemoteAgentRegistry', () => {
  beforeAll(() => {
    setupTestDbModule('../remote/agent-registry', 'agent-registry');
  });
  afterAll(() => teardownTestDb());

  beforeEach(() => {
    resetTables(['remote_agents']);
    registry = new RemoteAgentRegistry(rawDb());
  });

  // ── register + get ────────────────────────────────────────
  describe('register() and get()', () => {
    it('should register an agent and retrieve it by ID', () => {
      const result = registry.register({
        id: 'agent-1',
        name: 'Test Agent',
        host: '192.168.1.100',
        port: 3460,
        secret: 'test-secret',
        max_concurrent: 5,
      });

      expect(result).toEqual({
        id: 'agent-1',
        name: 'Test Agent',
        host: '192.168.1.100',
        port: 3460,
      });

      const agent = registry.get('agent-1');
      expect(agent).toBeDefined();
      expect(agent.id).toBe('agent-1');
      expect(agent.name).toBe('Test Agent');
      expect(agent.host).toBe('192.168.1.100');
      expect(agent.port).toBe(3460);
      // Secrets are stored hashed (scrypt:salt:hash) in the DB; verify it is
      // not stored as plaintext and matches the scrypt format.
      expect(agent.secret).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
      expect(agent.max_concurrent).toBe(5);
      expect(agent.status).toBe('unknown');
      expect(agent.consecutive_failures).toBe(0);
      expect(agent.enabled).toBe(1);
    });

    it('should use default port and max_concurrent', () => {
      registry.register({
        id: 'agent-2',
        name: 'Default Agent',
        host: '10.0.0.1',
        secret: 'secret-2',
      });

      const agent = registry.get('agent-2');
      expect(agent.port).toBe(3460);
      expect(agent.max_concurrent).toBe(3);
    });

    it('should replace an existing agent on re-register', () => {
      registry.register({
        id: 'agent-1',
        name: 'Original',
        host: '10.0.0.1',
        secret: 's1',
      });

      registry.register({
        id: 'agent-1',
        name: 'Updated',
        host: '10.0.0.2',
        secret: 's2',
      });

      const agent = registry.get('agent-1');
      expect(agent.name).toBe('Updated');
      expect(agent.host).toBe('10.0.0.2');
    });

    it('should persist tls settings through re-register and hydrate clients with the latest values', () => {
      registry.register({
        id: 'secure-agent',
        name: 'Secure Agent',
        host: 'secure.example.test',
        port: 443,
        secret: 'tls-secret',
        max_concurrent: 6,
        tls: true,
        rejectUnauthorized: false,
      });

      let agent = registry.get('secure-agent');
      expect(agent).toMatchObject({
        id: 'secure-agent',
        name: 'Secure Agent',
        host: 'secure.example.test',
        port: 443,
        max_concurrent: 6,
        tls: 1,
        rejectUnauthorized: 0,
      });
      // Secret is stored hashed — verify format only
      expect(agent.secret).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
      expect(registry.getAll()).toContainEqual(expect.objectContaining({
        id: 'secure-agent',
        tls: 1,
        rejectUnauthorized: 0,
      }));

      let client = registry.getClient('secure-agent');
      expect(client).not.toBeNull();
      expect(client.host).toBe('secure.example.test');
      expect(client.port).toBe(443);
      expect(client.secret).toBe('tls-secret');
      expect(client.tls).toBe(true);
      expect(client.rejectUnauthorized).toBe(false);

      registry.register({
        id: 'secure-agent',
        name: 'Secure Agent',
        host: 'worker.example.test',
        port: 8080,
        secret: 'updated-secret',
        max_concurrent: 2,
        tls: false,
        rejectUnauthorized: true,
      });

      agent = registry.get('secure-agent');
      expect(agent).toMatchObject({
        id: 'secure-agent',
        name: 'Secure Agent',
        host: 'worker.example.test',
        port: 8080,
        max_concurrent: 2,
        tls: 0,
        rejectUnauthorized: 1,
      });
      // Secret is stored hashed after re-register
      expect(agent.secret).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
      expect(registry.getAll()).toContainEqual(expect.objectContaining({
        id: 'secure-agent',
        tls: 0,
        rejectUnauthorized: 1,
      }));

      client = registry.getClient('secure-agent');
      expect(client).not.toBeNull();
      expect(client.host).toBe('worker.example.test');
      expect(client.port).toBe(8080);
      expect(client.secret).toBe('updated-secret');
      expect(client.tls).toBe(false);
      expect(client.rejectUnauthorized).toBe(true);
    });

    it('should return undefined for a non-existent ID', () => {
      const agent = registry.get('no-such-agent');
      expect(agent).toBeUndefined();
    });
  });

  // ── getAll ────────────────────────────────────────────────
  describe('getAll()', () => {
    it('should return all registered agents', () => {
      registry.register({ id: 'a1', name: 'A1', host: '1.1.1.1', secret: 's1' });
      registry.register({ id: 'a2', name: 'A2', host: '2.2.2.2', secret: 's2' });
      registry.register({ id: 'a3', name: 'A3', host: '3.3.3.3', secret: 's3' });

      const all = registry.getAll();
      expect(all).toHaveLength(3);
      const ids = all.map(a => a.id).sort();
      expect(ids).toEqual(['a1', 'a2', 'a3']);
    });

    it('should return empty array when no agents registered', () => {
      expect(registry.getAll()).toEqual([]);
    });
  });

  // ── remove ────────────────────────────────────────────────
  describe('remove()', () => {
    it('should delete an agent from the DB and client map', () => {
      registry.register({ id: 'rm-1', name: 'ToRemove', host: '5.5.5.5', secret: 's' });
      expect(registry.get('rm-1')).toBeDefined();

      registry.remove('rm-1');

      expect(registry.get('rm-1')).toBeUndefined();
      expect(registry.getAll()).toHaveLength(0);
      // Client should also be cleared
      expect(registry.clients.has('rm-1')).toBe(false);
    });

    it('should not throw when removing a non-existent agent', () => {
      expect(() => registry.remove('nope')).not.toThrow();
    });
  });

  // ── getClient ─────────────────────────────────────────────
  describe('getClient()', () => {
    it('should return a client for a registered agent', () => {
      registry.register({ id: 'c1', name: 'C1', host: '1.2.3.4', secret: 'abc' });
      const client = registry.getClient('c1');
      expect(client).not.toBeNull();
      expect(client.host).toBe('1.2.3.4');
    });

    it('should return null for a non-existent agent', () => {
      expect(registry.getClient('missing')).toBeNull();
    });

    it('should return null for a disabled agent', () => {
      registry.register({ id: 'd1', name: 'D1', host: '1.1.1.1', secret: 's' });
      // Disable the agent directly in DB
      rawDb().prepare('UPDATE remote_agents SET enabled = 0 WHERE id = ?').run('d1');
      // Clear cached client so getClient re-checks DB
      registry.clients.delete('d1');

      expect(registry.getClient('d1')).toBeNull();
    });

    it('should lazily create a client if not cached', () => {
      registry.register({ id: 'lazy-1', name: 'Lazy', host: '9.9.9.9', secret: 'xyz' });
      // Clear the client that register() created
      registry.clients.delete('lazy-1');

      const client = registry.getClient('lazy-1');
      expect(client).not.toBeNull();
      expect(client.host).toBe('9.9.9.9');
    });
  });

  // ── getAvailable ──────────────────────────────────────────
  describe('getAvailable()', () => {
    it('should return healthy agents where client.isAvailable() is true', () => {
      registry.register({ id: 'av-1', name: 'Avail', host: '1.1.1.1', secret: 's1' });
      registry.register({ id: 'av-2', name: 'Also Avail', host: '2.2.2.2', secret: 's2' });

      // Mark both as healthy in DB
      rawDb().prepare("UPDATE remote_agents SET status = 'healthy' WHERE id IN ('av-1', 'av-2')").run();

      // Replace real clients with mocks that report available
      registry.clients.set('av-1', createMockClient({ host: '1.1.1.1', isAvailable: true }));
      registry.clients.set('av-2', createMockClient({ host: '2.2.2.2', isAvailable: true }));

      const available = registry.getAvailable();
      expect(available).toHaveLength(2);
    });

    it('should exclude agents that are not healthy in the DB', () => {
      registry.register({ id: 'nh-1', name: 'NotHealthy', host: '3.3.3.3', secret: 's' });
      // Status is 'unknown' by default, not 'healthy'

      registry.clients.set('nh-1', createMockClient({ isAvailable: true }));

      const available = registry.getAvailable();
      expect(available).toHaveLength(0);
    });

    it('should exclude agents where client.isAvailable() returns false', () => {
      registry.register({ id: 'na-1', name: 'NotAvail', host: '4.4.4.4', secret: 's' });
      rawDb().prepare("UPDATE remote_agents SET status = 'healthy' WHERE id = 'na-1'").run();

      registry.clients.set('na-1', createMockClient({ isAvailable: false }));

      const available = registry.getAvailable();
      expect(available).toHaveLength(0);
    });

    it('should exclude disabled agents', () => {
      registry.register({ id: 'dis-1', name: 'Disabled', host: '5.5.5.5', secret: 's' });
      rawDb().prepare("UPDATE remote_agents SET status = 'healthy', enabled = 0 WHERE id = 'dis-1'").run();

      const available = registry.getAvailable();
      expect(available).toHaveLength(0);
    });
  });

  // ── runHealthChecks ───────────────────────────────────────
  describe('runHealthChecks()', () => {
    it('should mark agent as healthy when checkHealth succeeds', async () => {
      registry.register({ id: 'hc-1', name: 'HC1', host: '1.1.1.1', secret: 's' });

      // Replace client with mock that returns healthy
      registry.clients.set('hc-1', createMockClient({
        healthResult: {
          status: 'healthy',
          running_tasks: 0,
          max_concurrent: 3,
          system: { cpu: 0.5, memory: 0.6 },
        },
      }));

      const results = await registry.runHealthChecks();

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ id: 'hc-1', status: 'healthy' });

      // Verify DB was updated
      const agent = registry.get('hc-1');
      expect(agent.status).toBe('healthy');
      expect(agent.consecutive_failures).toBe(0);
      expect(agent.last_health_check).toBeTruthy();
      expect(agent.last_healthy).toBeTruthy();
      expect(agent.metrics).toBeTruthy();
      const metrics = JSON.parse(agent.metrics);
      expect(metrics.cpu).toBe(0.5);
    });

    it('should mark agent as degraded on first failure', async () => {
      registry.register({ id: 'hc-2', name: 'HC2', host: '2.2.2.2', secret: 's' });

      // Replace client with mock that returns null (failure)
      registry.clients.set('hc-2', createMockClient({ healthResult: null }));

      const results = await registry.runHealthChecks();

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('degraded');
      expect(results[0].failures).toBe(1);

      const agent = registry.get('hc-2');
      expect(agent.status).toBe('degraded');
      expect(agent.consecutive_failures).toBe(1);
    });

    it('should mark agent as down after 3 consecutive failures', async () => {
      registry.register({ id: 'hc-3', name: 'HC3', host: '3.3.3.3', secret: 's' });
      // Pre-set 2 failures in DB
      rawDb().prepare('UPDATE remote_agents SET consecutive_failures = 2 WHERE id = ?').run('hc-3');

      registry.clients.set('hc-3', createMockClient({ healthResult: null }));

      const results = await registry.runHealthChecks();

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('down');
      expect(results[0].failures).toBe(3);

      const agent = registry.get('hc-3');
      expect(agent.status).toBe('down');
      expect(agent.consecutive_failures).toBe(3);
    });

    it('should reset failures when agent recovers', async () => {
      registry.register({ id: 'hc-4', name: 'HC4', host: '4.4.4.4', secret: 's' });
      rawDb().prepare("UPDATE remote_agents SET consecutive_failures = 2, status = 'degraded' WHERE id = ?").run('hc-4');

      registry.clients.set('hc-4', createMockClient({
        healthResult: {
          status: 'healthy',
          running_tasks: 1,
          max_concurrent: 3,
          system: {},
        },
      }));

      const results = await registry.runHealthChecks();

      expect(results[0].status).toBe('healthy');
      const agent = registry.get('hc-4');
      expect(agent.consecutive_failures).toBe(0);
      expect(agent.status).toBe('healthy');
    });

    it('should skip disabled agents', async () => {
      registry.register({ id: 'hc-5', name: 'HC5', host: '5.5.5.5', secret: 's' });
      rawDb().prepare('UPDATE remote_agents SET enabled = 0 WHERE id = ?').run('hc-5');

      const results = await registry.runHealthChecks();
      expect(results).toHaveLength(0);
    });

    it('should handle multiple agents in one pass', async () => {
      registry.register({ id: 'multi-1', name: 'M1', host: '1.1.1.1', secret: 's1' });
      registry.register({ id: 'multi-2', name: 'M2', host: '2.2.2.2', secret: 's2' });

      registry.clients.set('multi-1', createMockClient({
        healthResult: { status: 'healthy', running_tasks: 0, max_concurrent: 3, system: {} },
      }));
      registry.clients.set('multi-2', createMockClient({ healthResult: null }));

      const results = await registry.runHealthChecks();

      expect(results).toHaveLength(2);
      const r1 = results.find(r => r.id === 'multi-1');
      const r2 = results.find(r => r.id === 'multi-2');
      expect(r1.status).toBe('healthy');
      expect(r2.status).toBe('degraded');
    });
  });
});
