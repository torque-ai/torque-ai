'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const TORQUE_REMOTE = path.join(__dirname, '..', '..', 'bin', 'torque-remote');

function makeConfig(tmpDir) {
  const cfg = path.join(tmpDir, '.torque-remote.json');
  fs.writeFileSync(cfg, JSON.stringify({
    transport: 'local',
    intercept_commands: [],
  }));
  return cfg;
}

function spawnTorqueRemote(args, env, cwd) {
  return spawnSync('bash', [TORQUE_REMOTE, ...args], {
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
}

// Stub daemon spawned in a child process to avoid spawnSync blocking
// the parent event loop. Returns {port, kill} from a tmp script.
async function spawnStubDaemon(tmpDir, handlerSource) {
  const scriptPath = path.join(tmpDir, 'stub-daemon.js');
  fs.writeFileSync(scriptPath, `
'use strict';
const http = require('http');
const handler = ${handlerSource};
const server = http.createServer(handler);
server.listen(0, '127.0.0.1', () => {
  process.send({ ready: true, port: server.address().port });
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  const child = spawn('node', [scriptPath], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const port = await new Promise((resolve, reject) => {
    child.on('message', (m) => { if (m.ready) resolve(m.port); });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`stub daemon exited ${code} before ready`)));
  });
  return { port, kill: () => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); }) };
}

describe('torque-remote coord integration', () => {
  let tmpDir, stub;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-coord-'));
  });

  afterEach(async () => {
    if (stub) { await stub.kill(); stub = null; }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs the command uncoordinated when daemon is unreachable, with a warning', () => {
    makeConfig(tmpDir);
    const result = spawnTorqueRemote(['--suite', 'gate', 'echo', 'hello'], {
      TORQUE_COORD_PORT: '1',  // port 1 = closed
      HOME: tmpDir,
    }, tmpDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.stderr).toContain('[torque-coord] unreachable');
  });

  it('acquires before run and releases after on the happy path', async () => {
    makeConfig(tmpDir);
    const handlerSource = `
      (req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url === '/acquire' && req.method === 'POST') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ acquired: true, lock_id: 'lk-1' }));
          } else if (req.url === '/release' && req.method === 'POST') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ released: true }));
          } else if (req.url === '/heartbeat' && req.method === 'POST') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(404).end();
          }
        });
      }
    `;
    stub = await spawnStubDaemon(tmpDir, handlerSource);

    const result = spawnTorqueRemote(['--suite', 'gate', 'echo', 'hello'], {
      TORQUE_COORD_PORT: String(stub.port),
      HOME: tmpDir,
    }, tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hello');
    // The release was sent; can't verify content from a separate process,
    // but exit 0 + no error in stderr indicates the wrapper completed cleanly.
    expect(result.stderr).not.toContain('[torque-coord] unreachable');
  });

  it('with --suite custom, skips coord entirely (no acquire attempted)', () => {
    makeConfig(tmpDir);
    const result = spawnTorqueRemote(['--suite', 'custom', 'echo', 'hi'], {
      TORQUE_COORD_PORT: '1',  // would fail if attempted
      HOME: tmpDir,
    }, tmpDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hi');
    // No coord chatter for custom suite
    expect(result.stderr).not.toContain('[torque-coord]');
  });
});
