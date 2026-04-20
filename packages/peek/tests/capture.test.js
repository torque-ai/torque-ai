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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peek-capture-'));
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

describe('@torque-ai/peek capture capability', () => {
  it('GET /peek parses query params and delegates to adapter.capture', async () => {
    const calls = [];
    const image = Buffer.from('fake-jpeg').toString('base64');
    const adapter = {
      async capture(options) {
        calls.push(options);
        return {
          image,
          mode: 'window',
          title: 'Calculator',
          process: 'CalculatorApp',
          width: 640,
          height: 480,
          size_bytes: Buffer.from(image, 'base64').length,
          format: options.format,
          mime_type: 'image/jpeg',
        };
      },
    };
    const { instance } = await startServer({ adapter });

    const res = await request(
      instance,
      '/peek?mode=process&name=Calculator&format=jpg&quality=72&max_width=800&crop=1,2,30,40&annotate=true'
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        mode: 'process',
        name: 'Calculator',
        format: 'jpeg',
        quality: 72,
        max_width: 800,
        crop: { x: 1, y: 2, w: 30, h: 40 },
        annotate: true,
      },
    ]);
    expect(res.body).toEqual({
      image,
      mode: 'window',
      title: 'Calculator',
      process: 'CalculatorApp',
      width: 640,
      height: 480,
      size_bytes: Buffer.from(image, 'base64').length,
      format: 'jpeg',
      mime_type: 'image/jpeg',
    });
  });

  it('returns 400 for invalid capture query params before invoking the adapter', async () => {
    const calls = [];
    const adapter = {
      async capture(options) {
        calls.push(options);
        return { image: Buffer.from('unused').toString('base64') };
      },
    };
    const { instance } = await startServer({ adapter });

    const res = await request(instance, '/peek?quality=101');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/quality/);
    expect(calls).toEqual([]);
  });
});
