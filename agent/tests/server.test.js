import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';

const TEST_PORT = 13460;
const TEST_SECRET = 'test-secret-for-tests';

let agentServer;

function request(path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path,
        method,
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = body;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const { createServer } = await import('../index.js');
  agentServer = createServer({
    port: TEST_PORT,
    host: '127.0.0.1',
    secret: TEST_SECRET,
    project_root: os.tmpdir(),
    allowed_commands: ['node', 'npm', 'npx'],
    max_concurrent: 3,
  });
  await new Promise((resolve) => {
    agentServer.server.on('listening', resolve);
  });
});

afterAll(async () => {
  if (agentServer) {
    await agentServer.close();
  }
});

describe('Agent HTTP Server', () => {
  it('GET /health returns 200 with healthy status and system metrics', async () => {
    const res = await request('/health', {
      headers: { 'x-torque-secret': TEST_SECRET },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.version).toBe('1.0.0');
    expect(typeof res.body.uptime_seconds).toBe('number');
    expect(res.body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(res.body.running_tasks).toBe(0);
    expect(res.body.max_concurrent).toBe(3);
    expect(res.body.system).toBeDefined();
    expect(typeof res.body.system.memory_total_mb).toBe('number');
    expect(typeof res.body.system.memory_available_mb).toBe('number');
    expect(typeof res.body.system.cpu_percent).toBe('number');
    expect(res.body.projects).toBeDefined();
    expect(typeof res.body.projects).toBe('object');
  });

  it('request without X-Torque-Secret header returns 401', async () => {
    const res = await request('/health');
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('request with wrong X-Torque-Secret returns 401', async () => {
    const res = await request('/health', {
      headers: { 'x-torque-secret': 'wrong-secret' },
    });
    expect(res.status).toBe(401);
  });

  it('unknown route returns 404', async () => {
    const res = await request('/nonexistent', {
      headers: { 'x-torque-secret': TEST_SECRET },
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('GET /projects returns 200 with projects object', async () => {
    const res = await request('/projects', {
      headers: { 'x-torque-secret': TEST_SECRET },
    });
    expect(res.status).toBe(200);
    expect(res.body.projects).toBeDefined();
    expect(typeof res.body.projects).toBe('object');
  });
});
