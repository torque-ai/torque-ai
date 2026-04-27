'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startDaemon } = require('../coord/index');

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }).on('error', reject);
  });
}

describe('coord daemon integration', () => {
  let tmpDir, daemon;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-int-'));
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts and reports healthy', async () => {
    daemon = await startDaemon({
      port: 0,
      state_dir: path.join(tmpDir, 'state'),
      results_dir: path.join(tmpDir, 'results'),
    });
    const res = await get(daemon.port, '/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.protocol_version).toBe(1);
  });

  it('persists active locks to state_dir/active.json', async () => {
    daemon = await startDaemon({
      port: 0,
      state_dir: path.join(tmpDir, 'state'),
      results_dir: path.join(tmpDir, 'results'),
    });
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: daemon.port,
        path: '/acquire', method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(JSON.stringify({
        project: 'torque-public', sha: 'abc', suite: 'gate',
        holder: { host: 'h', pid: 1, user: 'u' },
      }));
    });
    await new Promise((r) => setTimeout(r, 50));
    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'active.json'), 'utf8'));
    expect(persisted.locks).toHaveLength(1);
  });

  it('on restart, reconciles stale active.json by clearing it', async () => {
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'state', 'active.json'), JSON.stringify({
      version: 1,
      locks: [{
        lock_id: 'old', project: 'p', sha: 'a', suite: 'gate',
        holder: { host: 'h', pid: 99, user: 'u' },
        created_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        output_buffer: '', crashed: false,
      }],
    }));

    daemon = await startDaemon({
      port: 0,
      state_dir: path.join(tmpDir, 'state'),
      results_dir: path.join(tmpDir, 'results'),
    });
    const res = await get(daemon.port, '/active');
    expect(res.body.active).toEqual([]);
  });
});
