import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import path from 'node:path';

const TEST_PORT = 13461;
const TEST_SECRET = 'test-secret-for-run-tests';
const PROJECT_ROOT = path.resolve(process.cwd()).replace(/\\/g, '/');

let agentInstance;

/**
 * POST JSON to the agent with auth header.
 * Returns { status, headers, lines } where lines is an array of parsed NDJSON objects.
 * For non-streaming responses, returns { status, headers, body } with parsed JSON body.
 */
function postJSON(urlPath, body, { port = TEST_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'x-torque-secret': TEST_SECRET,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const contentType = res.headers['content-type'] || '';

          if (contentType.includes('application/x-ndjson')) {
            // Parse NDJSON: split by newlines, filter empties, parse each
            const lines = raw
              .split('\n')
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line));
            resolve({ status: res.statusCode, headers: res.headers, lines });
          } else {
            // Regular JSON response (error responses)
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
            resolve({ status: res.statusCode, headers: res.headers, body: parsed });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Helper to GET /health to check running_tasks count.
 */
function getHealth(port = TEST_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        headers: { 'x-torque-secret': TEST_SECRET },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(JSON.parse(body)));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const { createServer } = await import('../index.js');
  agentInstance = createServer({
    port: TEST_PORT,
    host: '127.0.0.1',
    secret: TEST_SECRET,
    project_root: PROJECT_ROOT,
    allowed_commands: ['node', 'npm', 'npx'],
    max_concurrent: 3,
  });
  await new Promise((resolve) => {
    agentInstance.server.on('listening', resolve);
  });
});

afterAll(async () => {
  if (agentInstance) {
    await agentInstance.close();
  }
});

describe('POST /run endpoint', () => {
  it('runs a whitelisted command and streams NDJSON with stdout + exit_code 0', async () => {
    const res = await postJSON('/run', {
      command: 'node',
      args: ['-e', 'console.log("hello")'],
      cwd: PROJECT_ROOT,
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson');

    // Should have at least one stdout line and a final exit_code line
    expect(res.lines.length).toBeGreaterThanOrEqual(2);

    // Find stdout lines
    const stdoutLines = res.lines.filter((l) => l.stream === 'stdout');
    expect(stdoutLines.length).toBeGreaterThanOrEqual(1);
    const allStdout = stdoutLines.map((l) => l.data).join('');
    expect(allStdout).toContain('hello');

    // Last line should be the exit code
    const lastLine = res.lines[res.lines.length - 1];
    expect(lastLine.exit_code).toBe(0);
    expect(typeof lastLine.duration_ms).toBe('number');
    expect(lastLine.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('rejects non-whitelisted command with 403', async () => {
    const res = await postJSON('/run', {
      command: 'rm',
      args: ['-rf', '/'],
      cwd: PROJECT_ROOT,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Command not allowed: rm');
  });

  it('rejects path outside project root with 400', async () => {
    const res = await postJSON('/run', {
      command: 'node',
      args: ['-e', 'console.log("bad")'],
      cwd: 'C:/Windows/System32',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Path not allowed: C:/Windows/System32');
  });

  it('kills process on timeout and returns nonzero exit_code', async () => {
    const res = await postJSON('/run', {
      command: 'node',
      args: ['-e', 'setTimeout(()=>{},60000)'],
      cwd: PROJECT_ROOT,
      timeout_ms: 1000,
    });

    expect(res.status).toBe(200);

    // Last line should have exit_code
    const lastLine = res.lines[res.lines.length - 1];
    expect(lastLine.exit_code).toBeDefined();
    // On timeout kill, exit_code should be non-zero (null becomes 1, or signal-based)
    expect(lastLine.exit_code).not.toBe(0);
  }, 15000);

  it('returns 503 when at max concurrency', async () => {
    // Use a dedicated server on a different port with max_concurrent: 1
    const CONC_PORT = 13462;
    const { createServer } = await import('../index.js');
    const limitedServer = createServer({
      port: CONC_PORT,
      host: '127.0.0.1',
      secret: TEST_SECRET,
      project_root: PROJECT_ROOT,
      allowed_commands: ['node'],
      max_concurrent: 1,
    });
    await new Promise((resolve) => {
      limitedServer.server.on('listening', resolve);
    });

    try {
      // Start a slow task that holds the single slot for 3 seconds
      const slowPromise = postJSON('/run', {
        command: 'node',
        args: ['-e', 'process.stdout.write("started");setTimeout(()=>console.log("done"),3000)'],
        cwd: PROJECT_ROOT,
        timeout_ms: 10000,
      }, { port: CONC_PORT });

      // Poll /health until running_tasks === 1
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const health = await getHealth(CONC_PORT);
        if (health.running_tasks >= 1) break;
      }

      // Now try a second task -- should get 503
      const res = await postJSON('/run', {
        command: 'node',
        args: ['-e', 'console.log("second")'],
        cwd: PROJECT_ROOT,
      }, { port: CONC_PORT });

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('At capacity');
      expect(res.body.running).toBe(1);
      expect(res.body.max).toBe(1);

      // Wait for the slow task to finish
      await slowPromise;
    } finally {
      await limitedServer.close();
    }
  }, 20000);

  it('streams stderr output correctly', async () => {
    const res = await postJSON('/run', {
      command: 'node',
      args: ['-e', 'console.error("warning message")'],
      cwd: PROJECT_ROOT,
    });

    expect(res.status).toBe(200);

    const stderrLines = res.lines.filter((l) => l.stream === 'stderr');
    expect(stderrLines.length).toBeGreaterThanOrEqual(1);
    const allStderr = stderrLines.map((l) => l.data).join('');
    expect(allStderr).toContain('warning message');

    const lastLine = res.lines[res.lines.length - 1];
    expect(lastLine.exit_code).toBe(0);
  });

  it('passes TORQUE_-prefixed env variables to the child process and filters unknown vars', async () => {
    // TORQUE_-prefixed vars are in the allowlist and should pass through
    const res = await postJSON('/run', {
      command: 'node',
      args: ['-e', 'console.log(process.env.TORQUE_TEST_VAR + "|" + process.env.MY_TEST_VAR)'],
      cwd: PROJECT_ROOT,
      env: { TORQUE_TEST_VAR: 'custom_value_123', MY_TEST_VAR: 'should_be_filtered' },
    });

    expect(res.status).toBe(200);

    const stdoutLines = res.lines.filter((l) => l.stream === 'stdout');
    const allStdout = stdoutLines.map((l) => l.data).join('');
    // TORQUE_TEST_VAR passes through; MY_TEST_VAR is filtered out (printed as "undefined")
    expect(allStdout).toContain('custom_value_123');
    expect(allStdout).toContain('undefined');
  });
});
