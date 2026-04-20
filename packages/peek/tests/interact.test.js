import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createServer } = require('../src/server.js');

const ACTION_CASES = [
  { action: 'click', path: '/click', body: { x: 10, y: 20, button: 'right', double: true } },
  { action: 'drag', path: '/drag', body: { from_x: 1, from_y: 2, to_x: 30, to_y: 40 } },
  { action: 'type', path: '/type', body: { text: 'hello' } },
  { action: 'scroll', path: '/scroll', body: { x: 10, y: 20, delta: -120 } },
  { action: 'hotkey', path: '/hotkey', body: { keys: 'Ctrl+S' } },
  { action: 'focus', path: '/focus', body: { title: 'Editor' } },
  { action: 'resize', path: '/resize', body: { title: 'Editor', width: 800, height: 600 } },
  { action: 'move', path: '/move', body: { title: 'Editor', x: 100, y: 200 } },
  { action: 'maximize', path: '/maximize', body: { process: 'editor' } },
  { action: 'minimize', path: '/minimize', body: { process: 'editor' } },
  { action: 'clipboard', path: '/clipboard', body: { action: 'set', text: 'clipboard text' } },
];

const openServers = new Set();
const tempDirs = new Set();

async function startServer(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peek-interact-'));
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

function createAdapter(calls) {
  return ACTION_CASES.reduce((adapter, { action }) => {
    adapter[action] = async (payload) => {
      calls.push({ action, payload });
      return {
        adapter_value: `${action}-ok`,
      };
    };
    return adapter;
  }, {});
}

afterEach(async () => {
  await Promise.all([...openServers].map((instance) => closeServer(instance)));
  await Promise.all(
    [...tempDirs].map((tempDir) => fs.rm(tempDir, { recursive: true, force: true }))
  );
  openServers.clear();
  tempDirs.clear();
});

describe('@torque-ai/peek interaction capability', () => {
  it('POST interaction endpoints parse JSON bodies and delegate to matching adapter methods', async () => {
    const calls = [];
    const { instance } = await startServer({ adapter: createAdapter(calls) });

    for (const { action, path: endpointPath, body } of ACTION_CASES) {
      const res = await request(instance, endpointPath, { body });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        action,
        adapter_value: `${action}-ok`,
      });
    }

    expect(calls).toEqual(
      ACTION_CASES.map(({ action, body }) => ({
        action,
        payload: body,
      }))
    );
  });

  it('passes an empty object when an interaction endpoint receives no body', async () => {
    const calls = [];
    const adapter = {
      async focus(payload) {
        calls.push(payload);
        return { rect: null };
      },
    };
    const { instance } = await startServer({ adapter });

    const res = await request(instance, '/focus');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      action: 'focus',
      rect: null,
    });
    expect(calls).toEqual([{}]);
  });

  it('rejects non-object JSON bodies before invoking the adapter', async () => {
    const calls = [];
    const adapter = {
      async click(payload) {
        calls.push(payload);
        return {};
      },
    };
    const { instance } = await startServer({ adapter });

    const res = await request(instance, '/click', { body: ['not', 'an', 'object'] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: 'Interaction request body must be a JSON object',
    });
    expect(calls).toEqual([]);
  });

  it('keeps endpoints planned when the adapter does not implement the action method', async () => {
    const { instance } = await startServer({
      adapter: {
        async click() {
          return {};
        },
      },
    });

    const click = await request(instance, '/click', { body: { x: 1, y: 2 } });
    const drag = await request(instance, '/drag', {
      body: { from_x: 1, from_y: 2, to_x: 3, to_y: 4 },
    });

    expect(click.status).toBe(200);
    expect(click.body).toEqual({ success: true, action: 'click' });
    expect(drag.status).toBe(501);
    expect(drag.body).toEqual({
      success: false,
      error: 'Not implemented',
      phase: 'planned',
    });
  });
});
