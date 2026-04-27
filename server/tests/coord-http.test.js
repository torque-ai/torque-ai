'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const http = require('http');
const { createStateStore } = require('../coord/state');
const { createResultStore } = require('../coord/result-store');
const { createServer } = require('../coord/http');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: { 'content-type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_e) { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('coord http server', () => {
  let server, port, state, results;

  beforeEach(async () => {
    state = createStateStore({ max_concurrent_runs: 2 });
    results = createResultStore({ results_dir: require('os').tmpdir(), result_ttl_seconds: 3600 });
    server = createServer({ state, results, config: { protocol_version: 1 } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it('GET /health returns ok with protocol_version', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, protocol_version: 1, active_count: 0 });
  });

  it('POST /acquire returns 200 with lock_id when project free', async () => {
    const res = await request(port, 'POST', '/acquire', {
      project: 'torque-public', sha: 'abc', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    expect(res.status).toBe(200);
    expect(res.body.acquired).toBe(true);
    expect(res.body.lock_id).toBeDefined();
  });

  it('POST /acquire returns 202 with wait_for when project held', async () => {
    const a = await request(port, 'POST', '/acquire', {
      project: 'torque-public', sha: 'abc', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    const b = await request(port, 'POST', '/acquire', {
      project: 'torque-public', sha: 'def', suite: 'gate',
      holder: { host: 'h', pid: 2, user: 'u' },
    });
    expect(b.status).toBe(202);
    expect(b.body.acquired).toBe(false);
    expect(b.body.reason).toBe('project_held');
    expect(b.body.wait_for).toBe(a.body.lock_id);
  });

  it('POST /heartbeat updates the lock and returns ok', async () => {
    const a = await request(port, 'POST', '/acquire', {
      project: 'p', sha: 'a', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    const hb = await request(port, 'POST', '/heartbeat', {
      lock_id: a.body.lock_id, log_chunk: 'progress\n',
    });
    expect(hb.status).toBe(200);
    expect(hb.body.ok).toBe(true);
  });

  it('POST /release frees the lock and a follow-up acquire succeeds', async () => {
    const a = await request(port, 'POST', '/acquire', {
      project: 'p', sha: 'a', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    const rel = await request(port, 'POST', '/release', {
      lock_id: a.body.lock_id, exit_code: 0, suite_status: 'pass', output_tail: 'ok',
    });
    expect(rel.status).toBe(200);
    expect(rel.body.released).toBe(true);
    const b = await request(port, 'POST', '/acquire', {
      project: 'p', sha: 'b', suite: 'gate',
      holder: { host: 'h', pid: 2, user: 'u' },
    });
    expect(b.body.acquired).toBe(true);
  });

  it('GET /results/:project/:sha/:suite returns 404 in Phase 1 (stub)', async () => {
    const res = await request(port, 'GET', '/results/torque-public/abc/gate');
    expect(res.status).toBe(404);
  });

  it('GET /active lists current holders', async () => {
    await request(port, 'POST', '/acquire', {
      project: 'p1', sha: 'a', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    await request(port, 'POST', '/acquire', {
      project: 'p2', sha: 'b', suite: 'server',
      holder: { host: 'h', pid: 2, user: 'u' },
    });
    const res = await request(port, 'GET', '/active');
    expect(res.status).toBe(200);
    expect(res.body.active).toHaveLength(2);
    expect(res.body.active.map((l) => l.project).sort()).toEqual(['p1', 'p2']);
  });

  it('GET /wait/:lock_id streams progress events and a terminal released event', async () => {
    const a = await request(port, 'POST', '/acquire', {
      project: 'p', sha: 'a', suite: 'gate',
      holder: { host: 'h', pid: 1, user: 'u' },
    });
    const events = [];
    const wait = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port,
        path: `/wait/${a.body.lock_id}`, method: 'GET',
        headers: { accept: 'text/event-stream' },
      }, (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (dataLine) {
              const parsed = JSON.parse(dataLine.slice(6));
              events.push(parsed);
              if (parsed.type === 'released') {
                res.destroy();
                resolve();
              }
            }
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    await new Promise((r) => setTimeout(r, 50));
    await request(port, 'POST', '/release', {
      lock_id: a.body.lock_id, exit_code: 0, suite_status: 'pass', output_tail: 'done',
    });
    await wait;
    expect(events.find((e) => e.type === 'released')).toMatchObject({
      type: 'released', exit_code: 0, suite_status: 'pass',
    });
  });
});
