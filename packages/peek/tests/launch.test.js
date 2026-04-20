import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createServer } = require('../src/server.js');

const openServers = new Set();
const tempDirs = new Set();

async function startServer(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peek-launch-'));
  tempDirs.add(tempDir);

  const instance = createServer({
    host: '127.0.0.1',
    port: 0,
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
  const headers = { ...(options.headers || {}) };

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
        method: options.method || 'POST',
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

describe('@torque-ai/peek launch capability', () => {
  it('POST /process delegates launch options to adapter.launchProcess', async () => {
    const calls = [];
    const adapter = {
      async launchProcess(payload) {
        calls.push(payload);
        return {
          pid: 321,
          command: payload.path,
          args: payload.args,
        };
      },
    };
    const { instance } = await startServer({ adapter });

    const res = await request(instance, '/process', {
      body: {
        action: 'launch',
        path: 'C:\\Apps\\Torque.exe',
        args: ['--dev'],
        wait_for_window: false,
        timeout: 12,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      pid: 321,
      command: 'C:\\Apps\\Torque.exe',
      args: ['--dev'],
    });
    expect(calls).toEqual([
      {
        action: 'launch',
        path: 'C:\\Apps\\Torque.exe',
        args: ['--dev'],
        wait_for_window: false,
        timeout: 12,
      },
    ]);
  });

  it('GET /projects delegates query options to adapter.discoverProjects and wraps arrays', async () => {
    const calls = [];
    const adapter = {
      async discoverProjects(payload) {
        calls.push(payload);
        return [
          { name: 'DeskApp', path: '/home/<user>/DeskApp', type: 'electron', executable: '/home/<user>/DeskApp/dist/DeskApp' },
          { name: 'Api', path: '/home/<user>/Api', type: 'dotnet' },
        ];
      },
    };
    const { instance } = await startServer({ adapter });

    const res = await request(instance, '/projects?root=%2Fworkspace&limit=10', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      projects: [
        { name: 'DeskApp', path: '/home/<user>/DeskApp', type: 'electron', executable: '/home/<user>/DeskApp/dist/DeskApp' },
        { name: 'Api', path: '/home/<user>/Api', type: 'dotnet' },
      ],
    });
    expect(calls).toEqual([{ root: '/workspace', limit: '10' }]);
  });

  it('POST /open-url validates and delegates to adapter.openUrl', async () => {
    const calls = [];
    const adapter = {
      async openUrl(payload) {
        calls.push(payload);
        return { url: payload.url, opened: true };
      },
    };
    const { instance } = await startServer({ adapter });

    const res = await request(instance, '/open-url', {
      body: { url: 'https://example.com/docs' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      url: 'https://example.com/docs',
      opened: true,
    });
    expect(calls).toEqual([{ url: 'https://example.com/docs' }]);
  });

  it('rejects invalid launch bodies before invoking the adapter', async () => {
    const calls = [];
    const adapter = {
      async launchProcess(payload) {
        calls.push(payload);
        return {};
      },
      async openUrl(payload) {
        calls.push(payload);
        return {};
      },
    };
    const { instance } = await startServer({ adapter });

    const badProcess = await request(instance, '/process', { body: ['not', 'an', 'object'] });
    const badUrl = await request(instance, '/open-url', { body: { url: 'file:///tmp/index.html' } });

    expect(badProcess.status).toBe(400);
    expect(badProcess.body).toMatchObject({
      success: false,
      error: 'Launch request body must be a JSON object',
    });
    expect(badUrl.status).toBe(400);
    expect(badUrl.body).toMatchObject({
      success: false,
      error: 'url must use http:// or https://',
    });
    expect(calls).toEqual([]);
  });

  it('keeps launch endpoints planned when the adapter does not implement them', async () => {
    const { instance } = await startServer({
      adapter: {
        async launchProcess() {
          return { pid: 123 };
        },
      },
    });

    const processRes = await request(instance, '/process', { body: { path: '/bin/app' } });
    const projectsRes = await request(instance, '/projects', { method: 'GET' });
    const openUrlRes = await request(instance, '/open-url', { body: { url: 'https://example.com' } });

    expect(processRes.status).toBe(200);
    expect(projectsRes.status).toBe(501);
    expect(openUrlRes.status).toBe(501);
  });
});
