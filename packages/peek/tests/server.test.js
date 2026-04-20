import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createServer } = require('../src/server.js');

const TEST_TOKEN = 'peek-test-token';

const openServers = new Set();
const tempDirs = new Set();

async function startServer(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peek-server-'));
  tempDirs.add(tempDir);

  const instance = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    pidFile: path.join(tempDir, 'peek.pid'),
    installSignalHandlers: false,
    ...options,
  });

  openServers.add(instance);
  await once(instance.server, 'listening');
  return { instance, tempDir };
}

async function closeServer(instance) {
  if (!instance) return;
  openServers.delete(instance);
  await instance.close();
}

function request(instance, requestPath, options = {}) {
  const address = instance.server.address();
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = {
    ...(options.token === false ? {} : { 'X-Peek-Token': options.token || TEST_TOKEN }),
    ...(options.headers || {}),
  };

  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: requestPath,
        method: options.method || 'GET',
        headers,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed = raw;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            // Leave non-JSON responses as raw text for failure diagnostics.
          }

          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
          });
        });
      }
    );

    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all([...openServers].map((instance) => closeServer(instance)));
  await Promise.all(
    [...tempDirs].map((tempDir) => fs.rm(tempDir, { recursive: true, force: true }))
  );
  openServers.clear();
  tempDirs.clear();
});

describe('@torque-ai/peek HTTP server', () => {
  it('GET /health returns cached platform, dependency, capability, and version data', async () => {
    let dependencyChecks = 0;
    const { instance } = await startServer({
      checkDependencies: () => {
        dependencyChecks += 1;
        return {
          platform: 'test-os',
          supported: true,
          adapter: 'test-adapter',
          ok: true,
          available: ['capture-tool'],
          missing: [],
          checks: [{ name: 'capture-tool', available: true }],
          capabilities: ['capture', 'compare'],
        };
      },
    });

    const first = await request(instance, '/health');
    const second = await request(instance, '/health');

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      status: 'healthy',
      platform: 'test-os',
      adapter: 'test-adapter',
      version: '1.0.0',
      capabilities: ['capture', 'compare'],
      dependencies: {
        ok: true,
        available: ['capture-tool'],
        missing: [],
      },
    });
    expect(typeof first.body.uptime_seconds).toBe('number');
    expect(second.status).toBe(200);
    expect(dependencyChecks).toBe(1);
  });

  it('rejects requests when a configured X-Peek-Token is missing or wrong', async () => {
    const { instance } = await startServer();

    const missing = await request(instance, '/health', { token: false });
    const wrong = await request(instance, '/health', { token: 'wrong-token' });

    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ success: false, error: 'Unauthorized' });
    expect(wrong.status).toBe(401);
  });

  it('dispatches parsed query strings and JSON request bodies to registered route handlers', async () => {
    const { instance } = await startServer({
      handlers: {
        peek: (ctx) => ctx.json(200, { success: true, query: ctx.query }),
        click: (ctx) => ctx.json(200, { success: true, body: ctx.body }),
      },
    });

    const capture = await request(instance, '/peek?mode=window&name=Calculator&tag=a&tag=b');
    const click = await request(instance, '/click', {
      method: 'POST',
      body: { x: 10, y: 20, button: 'left' },
    });

    expect(capture.status).toBe(200);
    expect(capture.body).toEqual({
      success: true,
      query: {
        mode: 'window',
        name: 'Calculator',
        tag: ['a', 'b'],
      },
    });
    expect(click.status).toBe(200);
    expect(click.body).toEqual({
      success: true,
      body: { x: 10, y: 20, button: 'left' },
    });
  });

  it('returns structured 501 responses for planned endpoints without handlers', async () => {
    const { instance } = await startServer();

    const phaseOne = await request(instance, '/peek?mode=screen');
    const phaseTwo = await request(instance, '/ocr', {
      method: 'POST',
      body: { image: 'base64' },
    });
    const phaseThree = await request(instance, '/recovery/status');

    expect(phaseOne.status).toBe(501);
    expect(phaseOne.body).toEqual({
      success: false,
      error: 'Not implemented',
      phase: 'planned',
    });
    expect(phaseTwo.status).toBe(501);
    expect(phaseTwo.body).toEqual({
      success: false,
      error: 'Not implemented',
      phase: 'planned',
    });
    expect(phaseThree.status).toBe(501);
  });

  it('returns the planned accessibility API response for POST /snapshot', async () => {
    const { instance } = await startServer();

    const res = await request(instance, '/snapshot', {
      method: 'POST',
      body: { action: 'list' },
    });

    expect(res.status).toBe(501);
    expect(res.body).toEqual({
      success: false,
      error: 'Snapshot requires platform accessibility API — coming in a future release',
      phase: 'planned',
    });
  });

  it('returns 404 for unknown routes', async () => {
    const { instance } = await startServer();

    const res = await request(instance, '/missing');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/No route/);
  });

  it('writes the PID file on start and removes it on close', async () => {
    const { instance } = await startServer();

    await expect(fs.readFile(instance.pidFile, 'utf8')).resolves.toBe(`${process.pid}\n`);
    await closeServer(instance);

    await expect(fs.access(instance.pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows localhost POST /shutdown and then closes the server', async () => {
    const { instance } = await startServer();
    const closed = once(instance.server, 'close');

    const res = await request(instance, '/shutdown', { method: 'POST', body: { reason: 'test' } });
    await closed;
    openServers.delete(instance);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, shutting_down: true });
  });
});
