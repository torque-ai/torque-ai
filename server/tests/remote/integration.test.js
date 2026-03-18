'use strict';

/**
 * End-to-end integration tests for the remote agent stack.
 *
 * Starts a REAL torque-agent HTTP server (ESM, dynamic import),
 * connects a RemoteAgentClient to it, and validates the full flow:
 *   agent <-> client <-> registry
 *
 * Uses a temp directory as project_root and random port to avoid conflicts.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { RemoteAgentClient } = require('../../remote/agent-client');
const { RemoteAgentRegistry } = require('../../remote/agent-registry');

// ── Shared state ─────────────────────────────────────────────

let agentInstance;   // { server, close(), config, runningTasks }
let client;          // RemoteAgentClient
let testPort;
let tmpDir;
const TEST_SECRET = 'integration-test-secret-' + Date.now();

// ── Setup / Teardown ─────────────────────────────────────────

beforeAll(async () => {
  // Create a temp directory as the agent's project_root
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-agent-integ-'));

  // Dynamic import of the ESM agent module
  const agentModule = await import('../../../agent/index.js');

  // Use port 0 so the OS assigns a free ephemeral port (no collision risk)
  agentInstance = agentModule.createServer({
    port: 0,
    host: '127.0.0.1',
    secret: TEST_SECRET,
    project_root: tmpDir,
    allowed_commands: ['node'],
    max_concurrent: 1,
  });

  // Wait for the server to be listening before running tests
  await new Promise((resolve, reject) => {
    if (agentInstance.server.listening) {
      resolve();
    } else {
      agentInstance.server.on('listening', resolve);
      agentInstance.server.on('error', reject);
    }
  });

  // Read the actual assigned port
  testPort = agentInstance.server.address().port;

  // Create the real client
  client = new RemoteAgentClient({
    host: '127.0.0.1',
    port: testPort,
    secret: TEST_SECRET,
    healthCheckTimeout: 5000,
  });
});

afterAll(async () => {
  if (agentInstance) {
    await agentInstance.close();
  }
  // Clean up temp directory
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Helper: create in-memory DB with remote_agents table ──────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 3460,
      secret TEXT NOT NULL,
      status TEXT DEFAULT 'unknown',
      consecutive_failures INTEGER DEFAULT 0,
      max_concurrent INTEGER DEFAULT 3,
      last_health_check TEXT,
      last_healthy TEXT,
      metrics TEXT,
      tls INTEGER DEFAULT 0,
      rejectUnauthorized INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      enabled INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_remote_agents_status ON remote_agents(status);
    CREATE INDEX IF NOT EXISTS idx_remote_agents_enabled ON remote_agents(enabled);
  `);
  return db;
}

function requestAgent({ method = 'GET', pathname = '/', headers = {}, body = null, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: testPort,
      path: pathname,
      method,
      headers: {
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });

    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Request to ${pathname} timed out after ${timeout}ms`));
    });

    req.on('error', reject);

    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForRunningTasks(minRunningTasks, { timeoutMs = 1000, intervalMs = 50 } = {}) {
  const start = Date.now();
  let lastRunningTasks = 0;

  while (Date.now() - start < timeoutMs) {
    const response = await requestAgent({
      pathname: '/health',
      headers: { 'X-Torque-Secret': TEST_SECRET },
      timeout: timeoutMs,
    });
    const health = JSON.parse(response.body);
    lastRunningTasks = health.running_tasks || 0;
    if (lastRunningTasks >= minRunningTasks) return health;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Agent never reached ${minRunningTasks} running task(s); last observed ${lastRunningTasks}`);
}

// ── Tests ─────────────────────────────────────────────────────

describe('Remote Agent Integration', { timeout: 30000 }, () => {

  // ── 1. Health check through full stack ──────────────────────

  describe('health check through full stack', () => {
    it('should return healthy status with version, uptime, and system metrics', async () => {
      const health = await client.checkHealth();

      expect(health).not.toBeNull();
      expect(health.status).toBe('healthy');
      expect(health.version).toBe('1.0.0');
      expect(typeof health.uptime_seconds).toBe('number');
      expect(health.uptime_seconds).toBeGreaterThanOrEqual(0);
      expect(health.running_tasks).toBe(0);
      expect(health.max_concurrent).toBe(1);

      // System metrics
      expect(health.system).toBeDefined();
      expect(typeof health.system.memory_total_mb).toBe('number');
      expect(typeof health.system.memory_available_mb).toBe('number');
      expect(typeof health.system.cpu_percent).toBe('number');
    });

    it('should update client status to healthy after successful health check', async () => {
      await client.checkHealth();

      expect(client.status).toBe('healthy');
      expect(client.consecutiveFailures).toBe(0);
      expect(client.isAvailable()).toBe(true);
    });
  });

  describe('probe authentication', () => {
    it('should reject unauthenticated probe requests', async () => {
      const response = await requestAgent({ pathname: '/probe' });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toMatchObject({
        error: 'Unauthorized: missing or invalid X-Torque-Secret header',
      });
    });

    it('should return capabilities for authenticated probe requests', async () => {
      const response = await requestAgent({
        pathname: '/probe',
        headers: { 'X-Torque-Secret': TEST_SECRET },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        platform: expect.any(String),
        arch: expect.any(String),
        capabilities: expect.any(Object),
      });
    });
  });

  // ── 2. Run a whitelisted command ────────────────────────────

  describe('run a whitelisted command', () => {
    it('should run node -e and return stdout', async () => {
      // Use single quotes inside the eval string — Windows cmd.exe strips double quotes
      const result = await client.run('node', ['-e', "console.log('hello')"], {
        cwd: tmpDir,
        timeout: 10000,
      });

      expect(result.success).toBe(true);
      // Use .trim() instead of exact "hello\n" match for cross-platform
      // compatibility (Windows emits \r\n, Unix emits \n)
      expect(result.output.trim()).toBe('hello');
      expect(result.exitCode).toBe(0);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThan(0);
    });
  });

  describe('environment filtering', () => {
    it('should only forward allowlisted request env vars to child processes', async () => {
      const env = {
        SECRET_TOKEN: 'blocked',
        TORQUE_ALLOWED: 'allowed',
        OLLAMA_HOST: 'http://127.0.0.1:11434',
      };
      const readEnvVar = async (name) => client.run(
        'node',
        ['-e', `console.log(process.env.${name})`],
        { cwd: tmpDir, env, timeout: 10000 }
      );

      const secretResult = await readEnvVar('SECRET_TOKEN');
      const torqueResult = await readEnvVar('TORQUE_ALLOWED');
      const ollamaResult = await readEnvVar('OLLAMA_HOST');

      expect(secretResult.success).toBe(true);
      expect(secretResult.output.trim()).toBe('undefined');
      expect(torqueResult.success).toBe(true);
      expect(torqueResult.output.trim()).toBe('allowed');
      expect(ollamaResult.success).toBe(true);
      expect(ollamaResult.output.trim()).toBe('http://127.0.0.1:11434');
    });
  });

  // ── 3. Reject a non-whitelisted command ─────────────────────

  describe('reject a non-whitelisted command', () => {
    it('should reject curl with Command not allowed', async () => {
      await expect(
        client.run('curl', ['http://example.com'], { cwd: tmpDir, timeout: 5000 })
      ).rejects.toThrow('Command not allowed');
    });
  });

  // ── 4. Reject path outside project_root ─────────────────────

  describe('reject path outside project_root', () => {
    it('should reject cwd outside project_root', async () => {
      // The agent returns 400 for invalid paths; the client treats non-200
      // (other than 503/403) as a generic error via "Run failed (400)"
      await expect(
        client.run('node', ['-e', 'console.log(1)'], { cwd: '/tmp/not-allowed', timeout: 5000 })
      ).rejects.toThrow(/Run failed \(400\)|Path not allowed/);
    });

    it('should reject sync requests outside project_root', async () => {
      const response = await requestAgent({
        method: 'POST',
        pathname: '/sync',
        headers: { 'X-Torque-Secret': TEST_SECRET },
        body: {
          project: '../outside-root',
          branch: 'main',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        error: 'Path outside project root',
      });
    });
  });

  // ── 5. Stderr streaming ─────────────────────────────────────

  describe('stderr streaming', () => {
    it('should capture stderr output', async () => {
      // Use single quotes inside the eval string — Windows cmd.exe strips double quotes
      const result = await client.run('node', ['-e', "console.error('warning')"], {
        cwd: tmpDir,
        timeout: 10000,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.error.trim()).toBe('warning');
    });
  });

  // ── 6. Concurrency limit ────────────────────────────────────

  describe('concurrency limit', () => {
    it('should reject with 503 when max_concurrent is exceeded', async () => {
      // max_concurrent is 1. Launch a long-running task to fill the slot,
      // then immediately try a second one which should be rejected.
      // Use process.stdin.resume() — keeps node alive without any shell metacharacters
      // that Windows cmd.exe might misinterpret (e.g. < > () are problematic).
      const slowTask = client.run('node', ['-e', 'process.stdin.resume()'], {
        cwd: tmpDir,
        timeout: 10000,
      });

      // Wait for the first request to be picked up by the agent
      await waitForRunningTasks(1);

      // Second concurrent request should be rejected at capacity
      await expect(
        client.run('node', ['-e', 'process.exit(0)'], { cwd: tmpDir, timeout: 5000 })
      ).rejects.toThrow('Agent at capacity');

      // Clean up: wait for the slow task to be killed by its own timeout
      try { await slowTask; } catch { /* expected — killed by timeout */ }
    });
  });

  // ── 7. Timeout kill ─────────────────────────────────────────

  // Note: This test depends on test 6's slow task having completed and freed
  // the concurrency slot (max_concurrent: 1). Vitest runs it() blocks
  // sequentially within a describe, and test 6 awaits the slow task cleanup,
  // so the slot is always freed before this test runs.
  describe('timeout kill', () => {
    it('should kill the process and return non-zero exit code after timeout', async () => {
      const result = await client.run(
        'node',
        ['-e', 'process.stdin.resume()'],
        { cwd: tmpDir, timeout: 500 }
      );

      // The process should have been killed by the agent's timeout mechanism
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });
  });

  // ── 8. Registry + health check integration ──────────────────

  describe('registry + health check integration', () => {
    let testDb;

    afterEach(() => {
      if (testDb) {
        try { testDb.close(); } catch { /* ignore */ }
      }
    });

    it('should register agent, run health checks, and update DB to healthy', async () => {
      testDb = createTestDb();
      const registry = new RemoteAgentRegistry(testDb);

      // Register the real running agent
      registry.register({
        id: 'integ-agent-1',
        name: 'Integration Test Agent',
        host: '127.0.0.1',
        port: testPort,
        secret: TEST_SECRET,
        max_concurrent: 1,
      });

      // Before health check: status should be 'unknown'
      let agentRow = registry.get('integ-agent-1');
      expect(agentRow.status).toBe('unknown');

      // Run health checks against the real running agent
      const results = await registry.runHealthChecks();

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('integ-agent-1');
      expect(results[0].status).toBe('healthy');

      // Verify DB was updated
      agentRow = registry.get('integ-agent-1');
      expect(agentRow.status).toBe('healthy');
      expect(agentRow.consecutive_failures).toBe(0);
      expect(agentRow.last_health_check).toBeTruthy();
      expect(agentRow.last_healthy).toBeTruthy();
      expect(agentRow.metrics).toBeTruthy();

      // Metrics should contain system info from the real agent
      const metrics = JSON.parse(agentRow.metrics);
      expect(typeof metrics.memory_total_mb).toBe('number');
      expect(typeof metrics.cpu_percent).toBe('number');
    });

    it('should mark agent as available via getAvailable() after health check', async () => {
      testDb = createTestDb();
      const registry = new RemoteAgentRegistry(testDb);

      registry.register({
        id: 'integ-agent-2',
        name: 'Avail Test Agent',
        host: '127.0.0.1',
        port: testPort,
        secret: TEST_SECRET,
        max_concurrent: 1,
      });

      // Before health check: getAvailable should return empty
      expect(registry.getAvailable()).toHaveLength(0);

      // Run health checks
      await registry.runHealthChecks();

      // Now the agent should be available
      const available = registry.getAvailable();
      expect(available).toHaveLength(1);
      expect(available[0].id).toBe('integ-agent-2');
    });

    it('should use getClient() to return a functional client', async () => {
      testDb = createTestDb();
      const registry = new RemoteAgentRegistry(testDb);

      registry.register({
        id: 'integ-agent-3',
        name: 'Client Test Agent',
        host: '127.0.0.1',
        port: testPort,
        secret: TEST_SECRET,
      });

      // getClient returns a real RemoteAgentClient
      const registryClient = registry.getClient('integ-agent-3');
      expect(registryClient).not.toBeNull();
      expect(registryClient.host).toBe('127.0.0.1');
      expect(registryClient.port).toBe(testPort);

      // The client can actually health-check the real agent
      const health = await registryClient.checkHealth();
      expect(health).not.toBeNull();
      expect(health.status).toBe('healthy');
    });
  });

  // ── 9. Authentication rejection ─────────────────────────────

  describe('authentication rejection', () => {
    it('should reject requests with wrong secret', async () => {
      const badClient = new RemoteAgentClient({
        host: '127.0.0.1',
        port: testPort,
        secret: 'wrong-secret',
        healthCheckTimeout: 3000,
      });

      // The agent returns 401; the client's checkHealth() checks HTTP status
      // and treats non-200 as failure, returning null.
      const health = await badClient.checkHealth();

      expect(health).toBeNull();
      expect(badClient.status).not.toBe('healthy');
      expect(badClient.isAvailable()).toBe(false);
    });

    it('should not mark bad-auth agent as available in registry', async () => {
      const testDb = createTestDb();
      const registry = new RemoteAgentRegistry(testDb);

      // Register with the wrong secret
      registry.register({
        id: 'bad-auth-agent',
        name: 'Bad Auth Agent',
        host: '127.0.0.1',
        port: testPort,
        secret: 'wrong-secret',
        max_concurrent: 1,
      });

      // Health check runs against real agent with wrong secret.
      // The 401 response is treated as a failure, so the agent is marked
      // degraded/down and never appears in getAvailable().
      await registry.runHealthChecks();

      const available = registry.getAvailable();
      expect(available).toHaveLength(0);

      // Verify the agent was marked as degraded (not healthy)
      const agentRow = registry.get('bad-auth-agent');
      expect(agentRow.status).not.toBe('healthy');

      testDb.close();
    });
  });
});
