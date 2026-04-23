import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createServer, validateRepoCloneUrl } = require('../agent-server');

const TEST_SECRET = 'remote-agent-server-test-secret';

let server;
let port;
let projectsDir;

function request({ method = 'GET', pathname = '/', headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody ?? (body === undefined ? null : JSON.stringify(body));
    const requestHeaders = { ...headers };

    if (payload != null) {
      if (!requestHeaders['Content-Type']) {
        requestHeaders['Content-Type'] = 'application/json';
      }
      requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: requestHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);

    if (payload != null) {
      req.write(payload);
    }

    req.end();
  });
}

function authHeaders(extra = {}) {
  return {
    'X-Torque-Secret': TEST_SECRET,
    ...extra,
  };
}

function parseJson(text) {
  return JSON.parse(text);
}

function parseNdjson(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeAll(async () => {
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-remote-agent-server-'));
  server = createServer({
    secret: TEST_SECRET,
    projectsDir,
    config: {
      allowed_repo_hosts: ['github.com'],
    },
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (projectsDir && fs.existsSync(projectsDir)) {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

describe('remote/agent-server', () => {
  it('GET /health returns correct shape', async () => {
    const response = await request({
      pathname: '/health',
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);

    const body = parseJson(response.body);
    expect(body).toMatchObject({
      status: 'ok',
      capacity: expect.any(Number),
      load: 0,
      uptime: expect.any(Number),
      system: {
        platform: expect.any(String),
        memory_available_mb: expect.any(Number),
        memory_total_mb: expect.any(Number),
      },
    });
  });

  it('GET /health without auth returns 401 when secret is configured', async () => {
    const response = await request({ pathname: '/health' });

    expect(response.statusCode).toBe(401);
    expect(parseJson(response.body)).toEqual({ error: 'Unauthorized' });
  });

  it('POST /run with echo command returns NDJSON with stdout and exit_code 0', async () => {
    const response = await request({
      method: 'POST',
      pathname: '/run',
      headers: authHeaders(),
      body: {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("hello from remote agent\\n")'],
        cwd: projectsDir,
        timeout: 5000,
      },
    });

    expect(response.statusCode).toBe(200);

    const lines = parseNdjson(response.body);
    expect(lines.some((line) => line.stream === 'stdout' && line.data.includes('hello from remote agent'))).toBe(true);

    const finalLine = lines.at(-1);
    expect(finalLine.exit_code).toBe(0);
    expect(finalLine.duration_ms).toEqual(expect.any(Number));
  });

  it('POST /run with failing command returns non-zero exit_code', async () => {
    const response = await request({
      method: 'POST',
      pathname: '/run',
      headers: authHeaders(),
      body: {
        command: process.execPath,
        args: ['-e', 'process.exit(7)'],
        cwd: projectsDir,
        timeout: 5000,
      },
    });

    expect(response.statusCode).toBe(200);

    const lines = parseNdjson(response.body);
    const finalLine = lines.at(-1);
    expect(finalLine.exit_code).not.toBe(0);
  });

  it('POST /run NDJSON lines parse as valid JSON', async () => {
    const response = await request({
      method: 'POST',
      pathname: '/run',
      headers: authHeaders(),
      body: {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("ndjson validation\\n")'],
        cwd: projectsDir,
        timeout: 5000,
      },
    });

    expect(response.statusCode).toBe(200);

    const rawLines = response.body.trim().split(/\r?\n/).filter(Boolean);
    expect(rawLines.length).toBeGreaterThan(0);
    for (const line of rawLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('POST /sync creates project directory', async () => {
    const project = `project-${Date.now()}`;
    const expectedPath = path.join(projectsDir, project);

    const response = await request({
      method: 'POST',
      pathname: '/sync',
      headers: authHeaders(),
      body: {
        project,
        branch: 'main',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(parseJson(response.body)).toEqual({
      success: true,
      path: expectedPath,
      branch: 'main',
    });
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.statSync(expectedPath).isDirectory()).toBe(true);
  });

  it.each([
    ['git protocol localhost', 'git://127.0.0.1/repo.git'],
    ['metadata service over http', 'http://169.254.169.254/repo.git'],
    ['local file URL', 'file:///etc/passwd'],
    ['ssh URL', 'ssh://user@example.com/org/repo.git'],
    ['credential-bearing URL', 'https://github.com@127.0.0.1/repo.git'],
    ['suffix host bypass', 'https://github.com.evil.test/org/repo.git'],
  ])('POST /sync rejects unsafe repoUrl: %s', async (_label, repoUrl) => {
    const project = `unsafe-sync-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const expectedPath = path.join(projectsDir, project);

    const response = await request({
      method: 'POST',
      pathname: '/sync',
      headers: authHeaders(),
      body: {
        project,
        branch: 'main',
        repoUrl,
      },
    });

    expect([400, 403]).toContain(response.statusCode);
    expect(parseJson(response.body).error).toEqual(expect.any(String));
    expect(fs.existsSync(expectedPath)).toBe(false);
  });

  it('validateRepoCloneUrl allows only exact configured HTTPS hosts', () => {
    const state = { config: { allowed_repo_hosts: ['github.com'] } };

    expect(validateRepoCloneUrl('https://github.com/org/repo.git', state))
      .toBe('https://github.com/org/repo.git');
    expect(() => validateRepoCloneUrl('https://github.com.evil.test/org/repo.git', state))
      .toThrow(/Repository host is not allowed: github\.com\.evil\.test/);
  });

  it('invalid JSON body returns 400', async () => {
    const response = await request({
      method: 'POST',
      pathname: '/run',
      headers: authHeaders({
        'Content-Type': 'application/json',
      }),
      rawBody: '{"command":',
    });

    expect(response.statusCode).toBe(400);
    expect(parseJson(response.body).error).toMatch(/^Invalid JSON:/);
  });
});
