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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peek-compare-'));
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

function makeCompareOptions(images, calls = {}) {
  calls.decode = calls.decode || [];
  calls.pixelmatch = calls.pixelmatch || [];
  calls.encode = calls.encode || [];

  return {
    async decodeImage(image, name) {
      calls.decode.push({ image, name });
      const decoded = images[image];
      if (!decoded) throw new Error(`unexpected image ${name}`);
      return decoded;
    },
    pixelmatch(baseline, current, diff, width, height, options) {
      calls.pixelmatch.push({
        baseline: [...baseline],
        current: [...current],
        width,
        height,
        options,
      });
      diff.set([255, 0, 0, 255, 0, 0, 0, 255]);
      return 1;
    },
    async encodePng(raw, width, height) {
      calls.encode.push({ raw: [...raw], width, height });
      return Buffer.from('encoded-diff');
    },
  };
}

afterEach(async () => {
  await Promise.all([...openServers].map((instance) => closeServer(instance)));
  await Promise.all(
    [...tempDirs].map((tempDir) => fs.rm(tempDir, { recursive: true, force: true }))
  );
  openServers.clear();
  tempDirs.clear();
});

describe('@torque-ai/peek compare capability', () => {
  it('POST /compare diffs two base64 images and returns pixelmatch metadata with a PNG diff', async () => {
    const baseline = Buffer.from('baseline-image').toString('base64');
    const current = Buffer.from('current-image').toString('base64');
    const calls = {};
    const images = {
      [baseline]: {
        width: 2,
        height: 1,
        data: Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]),
      },
      [current]: {
        width: 2,
        height: 1,
        data: Buffer.from([99, 99, 99, 255, 40, 50, 60, 255]),
      },
    };
    const { instance } = await startServer({
      compareOptions: makeCompareOptions(images, calls),
    });

    const res = await request(instance, '/compare', {
      body: {
        baseline,
        current,
        threshold: 0.25,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      width: 2,
      height: 1,
      total_pixels: 2,
      changed_pixels: 1,
      diff_percent: 0.5,
      has_differences: true,
      match: false,
      passed: false,
      threshold: 0.25,
      max_diff_percent: 0.25,
      pixel_threshold: 0.25,
      ignored_regions: 0,
      diff_image: Buffer.from('encoded-diff').toString('base64'),
      diff_mime_type: 'image/png',
      summary: '1 of 2 pixels changed (50.00%)',
    });
    expect(calls.decode).toEqual([
      { image: baseline, name: 'baseline' },
      { image: current, name: 'current' },
    ]);
    expect(calls.pixelmatch[0]).toMatchObject({
      width: 2,
      height: 1,
      options: { threshold: 0.25 },
    });
    expect(calls.encode[0]).toMatchObject({ width: 2, height: 1 });
  });

  it('applies ignore_regions before invoking pixelmatch', async () => {
    const baseline = Buffer.from('baseline-ignore').toString('base64');
    const current = Buffer.from('current-ignore').toString('base64');
    const calls = {};
    const images = {
      [baseline]: {
        width: 2,
        height: 1,
        data: Buffer.from([1, 1, 1, 255, 9, 9, 9, 255]),
      },
      [current]: {
        width: 2,
        height: 1,
        data: Buffer.from([2, 2, 2, 255, 8, 8, 8, 255]),
      },
    };
    const { instance } = await startServer({
      compareOptions: makeCompareOptions(images, calls),
    });

    const res = await request(instance, '/compare', {
      body: {
        baseline,
        current,
        ignore_regions: [{ x: 0, y: 0, w: 1, h: 1 }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.ignored_regions).toBe(1);
    expect(calls.pixelmatch[0].current).toEqual([1, 1, 1, 255, 8, 8, 8, 255]);
  });

  it('returns 400 for missing image payloads before decoding', async () => {
    const calls = {};
    const { instance } = await startServer({
      compareOptions: makeCompareOptions({}, calls),
    });

    const res = await request(instance, '/compare', {
      body: { baseline: Buffer.from('only-one-image').toString('base64') },
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: 'current image must be a non-empty base64 string',
    });
    expect(calls.decode).toEqual([]);
  });

  it('returns 400 when image dimensions differ', async () => {
    const baseline = Buffer.from('baseline-size').toString('base64');
    const current = Buffer.from('current-size').toString('base64');
    const calls = {};
    const images = {
      [baseline]: {
        width: 2,
        height: 1,
        data: Buffer.from([1, 1, 1, 255, 2, 2, 2, 255]),
      },
      [current]: {
        width: 1,
        height: 1,
        data: Buffer.from([1, 1, 1, 255]),
      },
    };
    const { instance } = await startServer({
      compareOptions: makeCompareOptions(images, calls),
    });

    const res = await request(instance, '/compare', {
      body: { baseline, current },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Image dimensions must match');
    expect(calls.pixelmatch).toEqual([]);
  });
});
