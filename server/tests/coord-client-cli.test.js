'use strict';
import { describe, it, expect, afterEach } from 'vitest';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const CLIENT = path.join(__dirname, '..', '..', 'bin', 'torque-coord-client');

// We can't run an in-process http stub here because the test harness uses
// spawnSync to invoke the CLI, which blocks the parent event loop and
// therefore deadlocks any in-process HTTP server (the child connects, but
// the parent never accepts/responds until spawnSync returns — which only
// happens once the child exits, which only happens once it gets a response).
// Run the stub in a separate child process instead.
function makeStubDaemon(handlerSource) {
  const tmpFile = path.join(os.tmpdir(), `coord-stub-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  const script = `
'use strict';
const http = require('http');
const handler = ${handlerSource};
const server = http.createServer(handler);
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('message', (m) => { if (m === 'shutdown') server.close(() => process.exit(0)); });
`;
  fs.writeFileSync(tmpFile, script);
  const child = spawn('node', [tmpFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdoutBuf = '';
    const onData = (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const nlIdx = stdoutBuf.indexOf('\n');
      if (nlIdx >= 0) {
        const line = stdoutBuf.slice(0, nlIdx);
        child.stdout.removeListener('data', onData);
        try {
          const { port } = JSON.parse(line);
          resolve({
            port,
            close: () => new Promise((res) => {
              child.once('exit', () => {
                try { fs.unlinkSync(tmpFile); } catch (_e) { /* best effort */ }
                res();
              });
              child.kill('SIGTERM');
              setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000).unref();
            }),
          });
        } catch (e) {
          reject(e);
        }
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('stub daemon did not start within 5s')), 5000).unref();
  });
}

function runClient(args, port = 9395) {
  return spawnSync('node', [CLIENT, ...args], {
    env: { ...process.env, TORQUE_COORD_PORT: String(port), TORQUE_COORD_HOST: '127.0.0.1' },
    encoding: 'utf8',
  });
}

describe('torque-coord-client CLI', () => {
  let stub;

  afterEach(async () => {
    if (stub) {
      await stub.close();
      stub = null;
    }
  });

  it('health subcommand prints JSON from /health and exits 0', async () => {
    stub = await makeStubDaemon(`(req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, protocol_version: 1 }));
        return;
      }
      res.writeHead(404).end();
    }`);
    const result = runClient(['health'], stub.port);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.ok).toBe(true);
  });

  it('acquire subcommand POSTs and prints response on 200', async () => {
    stub = await makeStubDaemon(`(req, res) => {
      if (req.url === '/acquire' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ acquired: true, lock_id: 'xyz' }));
        return;
      }
      res.writeHead(404).end();
    }`);
    const result = runClient([
      'acquire',
      '--project', 'torque-public', '--sha', 'abc',
      '--suite', 'gate',
    ], stub.port);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ acquired: true, lock_id: 'xyz' });
  });

  it('exits with code 2 and prints status:"unreachable" when daemon is down', () => {
    const result = runClient(['health'], 1);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'unreachable' });
  });

  it('rejects bare flag with usage_error and exit 64', () => {
    const result = runClient(['acquire', '--project', '--sha', 'abc', '--suite', 'gate'], 9395);
    expect(result.status).toBe(64);
    const body = JSON.parse(result.stdout);
    expect(body.status).toBe('usage_error');
    expect(body.detail).toContain('--project');
  });

  it('rejects unexpected positional with usage_error and exit 64', () => {
    const result = runClient(['acquire', 'positional', '--sha', 'abc'], 9395);
    expect(result.status).toBe(64);
    expect(JSON.parse(result.stdout).status).toBe('usage_error');
  });

  it('lock-hashes subcommand prints the {relative_path: sha256} map for a project root', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-cli-locks-'));
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'server', 'package-lock.json'), '{}');
    try {
      const result = runClient(['lock-hashes', '--root', tmpDir], 9395);
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(Object.keys(body).sort()).toEqual([
        'package-lock.json',
        'server/package-lock.json',
      ]);
      for (const v of Object.values(body)) {
        expect(v).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('lock-hashes defaults --root to process.cwd() when omitted', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-cli-locks-cwd-'));
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}');
    try {
      const result = require('child_process').spawnSync('node', [CLIENT, 'lock-hashes'], {
        cwd: tmpDir,
        env: { ...process.env, TORQUE_COORD_PORT: '9395' },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(Object.keys(body)).toEqual(['package-lock.json']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('release --tail-from-file reads the file content into output_tail (last 16KB if larger)', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-cli-tail-'));
    const tailFile = path.join(tmpDir, 'output.log');
    fs.writeFileSync(tailFile, 'session A done\nexit 0\n');

    // Stub the daemon in a child process; the child writes the bodies it
    // received to a side-channel file we read after each runClient call.
    const dropPath = path.join(tmpDir, 'captured.json');
    const handlerSource = `(() => {
      const fs = require('fs');
      const DROP = ${JSON.stringify(dropPath)};
      return (req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url === '/release' && req.method === 'POST') {
            try { fs.appendFileSync(DROP, body + '\\n'); } catch (_e) {}
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ released: true }));
          } else {
            res.writeHead(404).end();
          }
        });
      };
    })()`;
    const stubLocal = await makeStubDaemon(handlerSource);
    try {
      const result = runClient([
        'release', '--lock-id', 'lk1', '--exit', '0',
        '--status', 'pass', '--tail-from-file', tailFile,
      ], stubLocal.port);
      expect(result.status).toBe(0);
      const captured1 = JSON.parse(fs.readFileSync(dropPath, 'utf8').trim().split('\n').pop());
      expect(captured1.output_tail).toBe('session A done\nexit 0\n');

      // Now a >16KB payload — only the last 16KB should land.
      const large = 'X'.repeat(20000) + 'TAIL_MARKER';
      fs.writeFileSync(tailFile, large);
      const result2 = runClient([
        'release', '--lock-id', 'lk2', '--exit', '0',
        '--status', 'pass', '--tail-from-file', tailFile,
      ], stubLocal.port);
      expect(result2.status).toBe(0);
      const captured2 = JSON.parse(fs.readFileSync(dropPath, 'utf8').trim().split('\n').pop());
      expect(captured2.output_tail.length).toBe(16384);
      expect(captured2.output_tail.endsWith('TAIL_MARKER')).toBe(true);
    } finally {
      await stubLocal.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('release --tail-from-file falls back to empty when file is missing', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-cli-tail-missing-'));
    const dropPath = path.join(tmpDir, 'captured.json');
    const handlerSource = `(() => {
      const fs = require('fs');
      const DROP = ${JSON.stringify(dropPath)};
      return (req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try { fs.appendFileSync(DROP, body + '\\n'); } catch (_e) {}
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ released: true }));
        });
      };
    })()`;
    const stubLocal = await makeStubDaemon(handlerSource);
    try {
      const result = runClient([
        'release', '--lock-id', 'lk-missing', '--exit', '0',
        '--status', 'pass', '--tail-from-file', '/nonexistent/path/output.log',
      ], stubLocal.port);
      expect(result.status).toBe(0);
      const captured = JSON.parse(fs.readFileSync(dropPath, 'utf8').trim().split('\n').pop());
      expect(captured.output_tail).toBe('');
    } finally {
      await stubLocal.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
