'use strict';

const crypto = require('crypto');
const { RemoteAgentClient } = require('./agent-client');
const logger = require('../logger').child({ component: 'agent-registry' });

/**
 * Hash a secret using scrypt with a random salt.
 * Returns a string in the format: `scrypt:<hex-salt>:<hex-hash>`
 * @param {string} secret
 * @returns {string}
 */
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(secret, salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

/**
 * Verify a provided secret against a stored value.
 * Supports both hashed (scrypt:…) and legacy plaintext stored values.
 * Uses timing-safe comparison to prevent timing attacks.
 * @param {string} stored - Value from database (may be hashed or plaintext)
 * @param {string} provided - Secret to verify
 * @returns {boolean}
 */
function verifySecret(stored, provided) {
  if (!stored || !stored.startsWith('scrypt:')) {
    // Legacy plaintext comparison — use timing-safe equality to prevent timing attacks
    const a = Buffer.from(stored || '', 'utf-8');
    const b = Buffer.from(provided || '', 'utf-8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  const [, salt, expectedHash] = stored.split(':');
  const actualHash = crypto.scryptSync(provided, salt, 32).toString('hex');
  const a = Buffer.from(expectedHash, 'hex');
  const b = Buffer.from(actualHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

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
   * The provided secret is hashed before being stored in the database.
   * The in-memory RemoteAgentClient retains the plaintext secret for wire auth.
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
    `).run(id, name, host, port, hashSecret(secret), max_concurrent, tls ? 1 : 0, rejectUnauthorized ? 1 : 0);

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
   * Returns null if the agent doesn't exist, is disabled, or cannot be
   * reconstructed from DB state.
   *
   * **Limitation:** After a server restart, the in-memory client is lost.
   * The DB stores the secret as a scrypt hash (for verification), which
   * cannot be used as a wire credential for outbound auth. In this case
   * the method logs a warning and returns null — the agent must be
   * re-registered (via `register()`) to restore outbound connectivity.
   *
   * @param {string} id
   * @returns {RemoteAgentClient|null}
   */
  getClient(id) {
    if (!this.clients.has(id)) {
      const agent = this.get(id);
      if (!agent || !agent.enabled) return null;

      // The DB secret column stores a scrypt hash (scrypt:<salt>:<hash>).
      // Hashed secrets cannot be reversed for outbound wire auth — the agent
      // must be re-registered to provide the plaintext secret again.
      if (agent.secret && agent.secret.startsWith('scrypt:')) {
        logger.warn(
          `Agent "${id}" secret is hashed — cannot reconstruct wire credential. ` +
          'Re-register the agent to restore outbound connectivity.'
        );
        return null;
      }

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

module.exports = { RemoteAgentRegistry, hashSecret, verifySecret };
