'use strict';

const http = require('node:http');
const https = require('node:https');
const logger = require('../../logger').child({ component: 'agent-client' });

const HEALTH_CACHE_TTL = 90000; // 90 seconds

function normalizeHealthPayload(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const normalized = { ...data };
  if (normalized.status === 'ok') {
    normalized.status = 'healthy';
  }
  if (normalized.running_tasks === undefined) {
    normalized.running_tasks = 0;
  }
  if (normalized.max_concurrent === undefined && Number.isFinite(normalized.capacity)) {
    normalized.max_concurrent = normalized.capacity;
  }
  return normalized;
}

class RemoteAgentClient {
  /**
   * @param {object} opts
   * @param {string} opts.host - Remote agent hostname or IP
   * @param {number} opts.port - Remote agent port
   * @param {string} opts.secret - Shared secret for X-Torque-Secret header
   * @param {number} [opts.healthCheckTimeout=5000] - Timeout for health checks in ms
   * @param {boolean} [opts.tls=false] - Whether to use HTTPS transport
   * @param {boolean} [opts.rejectUnauthorized=true] - Whether TLS certs must be be trusted
   */
  constructor({ host, port, secret, healthCheckTimeout = 5000, tls = false, rejectUnauthorized = true }) {
    this.host = host;
    this.port = port;
    this.secret = secret;
    this.healthCheckTimeout = healthCheckTimeout;
    this.tls = tls;
    this.rejectUnauthorized = rejectUnauthorized;
    if (tls && !rejectUnauthorized) {
      logger.warn(`[AgentClient] WARNING: TLS certificate verification is disabled for agent at ${host}:${port}. This connection is vulnerable to man-in-the-middle attacks.`);
    }
    this._cachedHealth = null;
    this._status = 'unknown';
    this._consecutiveFailures = 0;
    this._lastHealthError = null;
  }

  /**
   * Returns true if the agent is believed to be available based on cached health data.
   * Does NOT make a network request — uses cached health check result.
   */
  isAvailable() {
    if (!this._cachedHealth) return false;
    if (Date.now() - this._cachedHealth.timestamp > HEALTH_CACHE_TTL) return false;
    if (this._cachedHealth.status !== 'healthy') return false;
    if (this._cachedHealth.running_tasks >= this._cachedHealth.max_concurrent) return false;
    return true;
  }

  /**
   * Perform a health check against the remote agent.
   * Updates cached health data and status on success, clears cache on failure.
   * @returns {Promise<object|null>} Health data or null on failure
   */
  async checkHealth() {
    try {
      const res = await this._request('GET', '/health', null, this.healthCheckTimeout);
      if (res.status !== 200) {
        throw new Error(`Health check returned HTTP ${res.status}`);
      }
      const data = normalizeHealthPayload(JSON.parse(res.body));
      this._cachedHealth = { ...data, timestamp: Date.now() };
      this._status = 'healthy';
      this._consecutiveFailures = 0;
      this._lastHealthError = null;
      return data;
    } catch (error) {
      this._consecutiveFailures++;
      this._status = this._consecutiveFailures >= 3 ? 'down' : 'degraded';
      this._cachedHealth = null;
      this._lastHealthError = error;
      return null;
    }
  }

  /**
   * Sync a project on the remote agent (git clone/pull).
   * @param {string} project - Project name
   * @param {string} branch - Branch to sync
   * @param {string} [repoUrl] - Repository URL (for initial clone)
   * @returns {Promise<object>} Sync result from agent
   */
  async sync(project, branch, repoUrl) {
    const body = { project, branch };
    if (repoUrl) body.repo_url = repoUrl;
    const res = await this._request('POST', '/sync', body, 300000);
    if (res.status !== 200) throw new Error(`Sync failed (${res.status}): ${res.body}`);
    return JSON.parse(res.body);
  }

  /**
   * Execute a command on the remote agent with streaming NDJSON response.
   * @param {string} command - Command to run (e.g., 'npx')
   * @param {string[]} args - Command arguments
   * @param {object} [opts]
   * @param {string} [opts.cwd] - Working directory on remote
   * @param {object} [opts.env] - Environment variables
   * @param {number} [opts.timeout=120000] - Agent-side timeout in ms
   * @returns {Promise<{success: boolean, output: string, error: string, exitCode: number, durationMs: number}>}
   */
  async run(command, args, { cwd, env, timeout = 120000 } = {}) {
    const body = { command, args, cwd, env, timeout_ms: timeout };
    // Client-side timeout is slightly longer than agent timeout to avoid
    // cutting off before the agent has a chance to respond with exit info
    const clientTimeout = timeout + 5000;

    const res = await this._requestStreaming('POST', '/run', body, clientTimeout);

    return res;
  }

  /** @returns {'unknown'|'healthy'|'degraded'|'down'} */
  get status() { return this._status; }

  /** @returns {number} */
  get consecutiveFailures() { return this._consecutiveFailures; }

  /** @returns {Error|null} */
  get lastHealthError() { return this._lastHealthError; }

  /**
   * Internal: make an HTTP request and return the full response body as a string.
   * @param {string} method - HTTP method
   * @param {string} path - URL path
   * @param {object|null} body - JSON body (null for GET)
   * @param {number} timeout - Request timeout in ms
   * @returns {Promise<{status: number, body: string}>}
   * @private
   */
  _request(method, path, body, timeout) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;

      const opts = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'X-Torque-Secret': this.secret,
        },
      };

      if (payload) {
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const transport = this.tls ? https : http;
      if (this.tls && !this.rejectUnauthorized) {
        opts.rejectUnauthorized = false;
      }
      const req = transport.request(opts, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      });

      req.setTimeout(timeout, () => {
        req.destroy(new Error(`Request to ${path} timed out after ${timeout}ms`));
      });

      req.on('error', reject);

      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Internal: make an HTTP request that returns streaming NDJSON.
   * Parses lines incrementally, accumulating stdout/stderr and extracting exit info.
   * @param {string} method - HTTP method
   * @param {string} path - URL path
   * @param {object} body - JSON body
   * @param {number} timeout - Client-side timeout in ms
   * @returns {Promise<{success: boolean, output: string, error: string, exitCode: number, durationMs: number}>}
   * @private
   */
  _requestStreaming(method, path, body, timeout) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);

      const opts = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'X-Torque-Secret': this.secret,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const transport = this.tls ? https : http;
      if (this.tls && !this.rejectUnauthorized) {
        opts.rejectUnauthorized = false;
      }
      const req = transport.request(opts, (res) => {
        // Handle HTTP-level errors before parsing NDJSON
        if (res.statusCode === 503) {
          // Drain the response body before rejecting
          res.resume();
          res.on('end', () => reject(new Error('Agent at capacity')));
          return;
        }
        if (res.statusCode === 403) {
          res.resume();
          res.on('end', () => reject(new Error('Command not allowed')));
          return;
        }
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            reject(new Error(`Run failed (${res.statusCode}): ${Buffer.concat(chunks).toString('utf8')}`));
          });
          return;
        }

        // Parse streaming NDJSON response
        const stdoutLines = [];
        const stderrLines = [];
        let exitCode = -1;
        let durationMs = 0;
        let buffer = '';

        res.setEncoding('utf8');

        res.on('data', (chunk) => {
          buffer += chunk;
          // Process complete lines; keep partial line in buffer
          const lines = buffer.split('\n');
          buffer = lines.pop(); // last element is either '' or a partial line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.stream === 'stdout') {
                stdoutLines.push(parsed.data);
              } else if (parsed.stream === 'stderr') {
                stderrLines.push(parsed.data);
              } else if (parsed.exit_code !== undefined) {
                exitCode = parsed.exit_code;
                if (parsed.duration_ms !== undefined) {
                  durationMs = parsed.duration_ms;
                }
              }
            } catch {
              // Skip malformed NDJSON lines
            }
          }
        });

        res.on('end', () => {
          // Process any remaining buffered data
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim());
              if (parsed.stream === 'stdout') {
                stdoutLines.push(parsed.data);
              } else if (parsed.stream === 'stderr') {
                stderrLines.push(parsed.data);
              } else if (parsed.exit_code !== undefined) {
                exitCode = parsed.exit_code;
                if (parsed.duration_ms !== undefined) {
                  durationMs = parsed.duration_ms;
                }
              }
            } catch {
              // Skip malformed final line
            }
          }

          resolve({
            success: exitCode === 0,
            output: stdoutLines.join(''),
            error: stderrLines.join(''),
            exitCode,
            durationMs,
          });
        });

        res.on('error', reject);
      });

      req.setTimeout(timeout, () => {
        req.destroy(new Error(`Streaming request to ${path} timed out after ${timeout}ms`));
      });

      req.on('error', reject);

      req.write(payload);
      req.end();
    });
  }
}

module.exports = { RemoteAgentClient, HEALTH_CACHE_TTL };
