'use strict';

const { RemoteAgentClient } = require('./agent-client');

/**
 * Registry for managing remote execution agents.
 * Persists agent configuration to SQLite and maintains in-memory client instances.
 * Runs periodic health checks to track agent availability.
 */
class RemoteAgentRegistry {
  /**
   * @param {object} db - better-sqlite3 database instance (must have .prepare())
   */
  constructor(db) {
    this.db = db;
    /** @type {Map<string, RemoteAgentClient>} */
    this.clients = new Map();
  }

  /**
   * Register (or update) a remote agent.
   * @param {object} opts
   * @param {string} opts.id - Unique agent identifier
   * @param {string} opts.name - Human-readable name
   * @param {string} opts.host - Hostname or IP
   * @param {number} [opts.port=3460] - Agent port
   * @param {string} opts.secret - Shared secret for authentication
   * @param {number} [opts.max_concurrent=3] - Max concurrent tasks on this agent
   * @param {boolean} [opts.tls=false] - Whether to use HTTPS transport
   * @param {boolean} [opts.rejectUnauthorized=true] - Whether TLS certs must be trusted
   * @returns {{ id: string, name: string, host: string, port: number }}
   */
  register({ id, name, host, port = 3460, secret, max_concurrent = 3, tls = false, rejectUnauthorized = true }) {
    this.db.prepare(`INSERT OR REPLACE INTO remote_agents
      (id, name, host, port, secret, max_concurrent, tls, rejectUnauthorized, status, consecutive_failures, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 0, datetime('now'))
    `).run(id, name, host, port, secret, max_concurrent, tls ? 1 : 0, rejectUnauthorized ? 1 : 0);

    const client = new RemoteAgentClient({
      host,
      port,
      secret,
      tls,
      rejectUnauthorized,
    });
    this.clients.set(id, client);
    return { id, name, host, port };
  }

  /**
   * Get a single agent record by ID.
   * @param {string} id
   * @returns {object|undefined}
   */
  get(id) {
    return this.db.prepare('SELECT * FROM remote_agents WHERE id = ?').get(id);
  }

  /**
   * Get all registered agents.
   * @returns {object[]}
   */
  getAll() {
    return this.db.prepare('SELECT * FROM remote_agents').all();
  }

  /**
   * Remove an agent by ID (deletes from DB and discards client).
   * @param {string} id
   */
  remove(id) {
    this.db.prepare('DELETE FROM remote_agents WHERE id = ?').run(id);
    this.clients.delete(id);
  }

  /**
   * Get (or lazily create) a RemoteAgentClient for the given agent ID.
   * Returns null if the agent doesn't exist or is disabled.
   * @param {string} id
   * @returns {RemoteAgentClient|null}
   */
  getClient(id) {
    if (!this.clients.has(id)) {
      const agent = this.get(id);
      if (!agent || !agent.enabled) return null;
      const client = new RemoteAgentClient({
        host: agent.host,
        port: agent.port,
        secret: agent.secret,
        tls: !!agent.tls,
        rejectUnauthorized: agent.rejectUnauthorized === undefined ? true : !!agent.rejectUnauthorized,
      });
      // Seed cached health from DB so isAvailable() works before first health check
      if (agent.status === 'healthy' && agent.last_healthy) {
        const lastCheck = new Date(agent.last_healthy).getTime();
        let metrics = {};
        try { metrics = agent.metrics ? JSON.parse(agent.metrics) : {}; } catch { /* ignore */ }
        client._cachedHealth = {
          status: 'healthy',
          timestamp: lastCheck,
          running_tasks: 0,
          max_concurrent: agent.max_concurrent || 3,
          system: metrics,
        };
        client._status = 'healthy';
      }
      this.clients.set(id, client);
    }
    return this.clients.get(id);
  }

  /**
   * Get all agents that are enabled, healthy, and have capacity.
   * @returns {object[]} Agent rows that are available for work
   */
  getAvailable() {
    const agents = this.db.prepare(
      "SELECT * FROM remote_agents WHERE enabled = 1 AND status = 'healthy'"
    ).all();
    return agents.filter(a => {
      const client = this.getClient(a.id);
      return client && client.isAvailable();
    });
  }

  /**
   * Run health checks against all enabled agents.
   * Updates DB status, consecutive_failures, last_health_check, last_healthy, and metrics.
   * @returns {Promise<Array<{ id: string, status: string, failures?: number }>>}
   */
  async runHealthChecks() {
    const agents = this.db.prepare('SELECT * FROM remote_agents WHERE enabled = 1').all();
    const results = [];

    for (const agent of agents) {
      const client = this.getClient(agent.id);
      if (!client) continue;

      const result = await client.checkHealth();
      const now = new Date().toISOString();

      if (result) {
        this.db.prepare(`UPDATE remote_agents SET
          status = 'healthy', consecutive_failures = 0,
          last_health_check = ?, last_healthy = ?, metrics = ?
          WHERE id = ?`
        ).run(now, now, JSON.stringify(result.system || {}), agent.id);
        results.push({ id: agent.id, status: 'healthy' });
      } else {
        const failures = (agent.consecutive_failures || 0) + 1;
        const status = failures >= 3 ? 'down' : 'degraded';
        this.db.prepare(`UPDATE remote_agents SET
          status = ?, consecutive_failures = ?, last_health_check = ?
          WHERE id = ?`
        ).run(status, failures, now, agent.id);
        results.push({ id: agent.id, status, failures });
      }
    }

    return results;
  }
}

module.exports = { RemoteAgentRegistry };
