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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peek-windows-'));
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

function request(instance, requestPath) {
  const address = instance.server.address();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: requestPath,
        method: 'GET',
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

describe('@torque-ai/peek windows capability', () => {
  it('GET /list delegates to adapter.listWindows and wraps the result as windows', async () => {
    const calls = [];
    const adapter = {
      async listWindows(query) {
        calls.push(query);
        return [
          {
            title: 'Calculator',
            process: 'CalculatorApp',
            pid: 123,
            hwnd: '0xABC',
            geometry: { x: 10, y: 20, width: 300, height: 400 },
          },
          {
            title: 'Editor',
            process: 'Code',
            pid: 456,
            hwnd: '0xDEF',
            geometry: { x: 50, y: 60, width: 900, height: 700 },
          },
        ];
      },
    };
    const { instance } = await startServer({ adapter });

    const res = await request(instance, '/list?process=calc');

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ process: 'calc' }]);
    expect(res.body).toEqual({
      windows: [
        {
          title: 'Calculator',
          process: 'CalculatorApp',
          pid: 123,
          hwnd: '0xABC',
          geometry: { x: 10, y: 20, width: 300, height: 400 },
        },
      ],
    });
  });

  it('GET /windows uses the same listWindows adapter and preserves adapter metadata', async () => {
    const calls = [];
    const adapter = {
      async listWindows(query) {
        calls.push(query);
        return {
          platform: 'win32',
          windows: [
            {
              title: 'Calculator',
              process: 'CalculatorApp',
              pid: 123,
              hwnd: '0xABC',
            },
            {
              title: 'Editor',
              process: 'Code',
              pid: 456,
              hwnd: '0xDEF',
            },
          ],
        };
      },
    };
    const { instance } = await startServer({ adapter });

    const res = await request(instance, '/windows?title=editor');

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ title: 'editor' }]);
    expect(res.body).toEqual({
      platform: 'win32',
      windows: [
        {
          title: 'Editor',
          process: 'Code',
          pid: 456,
          hwnd: '0xDEF',
        },
      ],
    });
  });

  it('keeps /list planned when the adapter does not implement listWindows', async () => {
    const { instance } = await startServer({
      adapter: {
        async capture() {
          return {};
        },
      },
    });

    const res = await request(instance, '/list');

    expect(res.status).toBe(501);
    expect(res.body).toEqual({
      success: false,
      error: 'Not implemented',
      phase: 'planned',
    });
  });
});
