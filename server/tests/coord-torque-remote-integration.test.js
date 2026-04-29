'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const TORQUE_REMOTE = path.join(__dirname, '..', '..', 'bin', 'torque-remote');

// On Windows, bare `bash` may resolve to WSL bash (C:\Windows\System32\bash.exe),
// which can't execute scripts at native Windows paths and exits 127. Pin to Git
// Bash when present. Mirrors server/tests/cutover-barrier-integration.test.js.
const GIT_BASH_PATH = path.join('C:', 'Program Files', 'Git', 'bin', 'bash.exe');
const BASH_EXECUTABLE = process.platform === 'win32' && fs.existsSync(GIT_BASH_PATH)
  ? GIT_BASH_PATH
  : 'bash';

function makeConfig(tmpDir) {
  const cfg = path.join(tmpDir, '.torque-remote.json');
  fs.writeFileSync(cfg, JSON.stringify({
    transport: 'local',
    intercept_commands: [],
  }));
  return cfg;
}

function spawnTorqueRemote(args, env, cwd) {
  // 90s timeout (was 10s). After the begin-collapse refactor, torque-remote
  // shells out to two Node processes per invocation (begin + release). On
  // the Windows test remote, `node` cold-start under Defender real-time
  // scan is highly variable: measured 2026-04-27 across 5 sequential noop
  // runs, 8839/8864/8879/11794/11813ms, and `coord-client begin` against
  // an unreachable port across 5 runs: 18331/19662/22208/19587/19596ms.
  // Each begin = startup (~9-12s) + computeLockHashes (~3s for require +
  // walk) + immediate ECONNREFUSED. Worst-case wall under variance:
  // begin (~22s) + release (~12s) = ~34s, plus echo command + bash
  // overhead. 90s leaves clean margin for a slow node spawn while still
  // bounding pathological hangs.
  //
  // The proper system-level fix is to add `node.exe` to Defender's
  // process-exclusion list on the test runner, which would bring node
  // startup back down to ~200-500ms. Until that lands, the 2-spawn
  // protocol (collapsed from 3+ in this branch) is the application-side
  // floor.
  //
  // BASH_EXECUTABLE pins to Git Bash on Windows so we don't accidentally
  // resolve to WSL bash (mirrors d25abbda).
  return spawnSync(BASH_EXECUTABLE, [TORQUE_REMOTE, ...args], {
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf8',
    timeout: 90000,
  });
}

// Stub daemon spawned in a child process to avoid spawnSync blocking
// the parent event loop. Returns {port, kill} from a tmp script.
async function spawnStubDaemon(tmpDir, handlerSource) {
  const scriptPath = path.join(tmpDir, 'stub-daemon.js');
  // handlerSource may be a bare expression (existing tests) or a block of
  // statements ending in an expression (new warm-hit tests with helper
  // requires at the top). Detect the trailing expression by finding the
  // last semicolon at top-level; everything after it becomes the return
  // value of an IIFE. For bare-expression sources, no semicolons appear at
  // top level so the whole source is the return value.
  const trimmedSource = handlerSource.trim().replace(/;\s*$/, '');
  // Find the boundary: last top-level `;` outside braces/parens.
  let depth = 0;
  let lastSemi = -1;
  for (let i = 0; i < trimmedSource.length; i++) {
    const c = trimmedSource[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ';' && depth === 0) lastSemi = i;
  }
  let body;
  if (lastSemi >= 0) {
    const head = trimmedSource.slice(0, lastSemi + 1);
    const tail = trimmedSource.slice(lastSemi + 1).trim();
    body = `${head}\nreturn (${tail});`;
  } else {
    body = `return (${trimmedSource});`;
  }
  fs.writeFileSync(scriptPath, `
'use strict';
const http = require('http');
const handler = (function() { ${body} })();
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

// Per-test timeout 120s — each test's spawnSync waits up to 90s for
// torque-remote (which itself shells out to two Node processes that
// cold-start in 9-22s each on this Defender-scanned Windows runner).
// 120s = 90s spawn + 30s stub-daemon setup/teardown headroom. Pair with
// vitest.config.js testTimeout=15000 default — that's too tight for
// integration tests that boot real subprocesses.
//
// Retry disabled for this file because (a) tests are deterministic shell-
// integration tests not subject to the file-load-flake retry rationale and
// (b) under Defender variance, a retry can add another 100s of node-spawn
// cost without changing the outcome.
vi.setConfig({ testTimeout: 120000, retry: 0 });

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

  it('on 202 wait_for, follows wait stream and re-acquires after release', async () => {
    makeConfig(tmpDir);
    const handlerSource = `
      (() => {
        let acquireAttempts = 0;
        return (req, res) => {
        if (req.url === '/acquire' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => {
            acquireAttempts++;
            if (acquireAttempts === 1) {
              res.writeHead(202, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                acquired: false, reason: 'project_held',
                wait_for: 'holder-lock', lock_id: null,
              }));
            } else {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ acquired: true, lock_id: 'mine-2' }));
            }
          });
        } else if (req.url === '/wait/holder-lock' && req.method === 'GET') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          });
          res.write('event: progress\\ndata: {"type":"progress","elapsed_ms":1000}\\n\\n');
          setTimeout(() => {
            res.write('event: released\\ndata: {"type":"released","exit_code":0}\\n\\n');
            res.end();
          }, 50);
        } else if (req.url === '/release' || req.url === '/heartbeat') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ released: true, ok: true }));
        } else {
          res.writeHead(404).end();
        }
        };
      })()
    `;
    stub = await spawnStubDaemon(tmpDir, handlerSource);

    const result = spawnTorqueRemote(['--suite', 'gate', 'echo', 'after-wait'], {
      TORQUE_COORD_PORT: String(stub.port),
      HOME: tmpDir,
    }, tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('after-wait');
    expect(result.stderr).toContain('[torque-coord] waiting for in-flight run (holder-lock');
  });

  it('replays cached result on warm hit, skipping acquire and command execution', async () => {
    makeConfig(tmpDir);
    const fs = require('fs');
    const path = require('path');
    const resultsDir = path.join(tmpDir, '.torque-coord', 'results');
    const projectRoot = path.join(tmpDir, 'tr-coord');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(projectRoot, '.torque-remote.json'), JSON.stringify({
      transport: 'local', intercept_commands: [],
    }));
    const projectHashes = require('../coord/lock-hashes').computeLockHashes(projectRoot);

    const shaDir = path.join(resultsDir, 'tr-coord', 'HEAD');
    fs.mkdirSync(shaDir, { recursive: true });
    fs.writeFileSync(path.join(shaDir, 'gate.json'), JSON.stringify({
      project: 'tr-coord', sha: 'HEAD', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'CACHED RESULT REPLAY\n',
      package_lock_hashes: projectHashes,
      completed_at: new Date().toISOString(),
    }));

    const handlerSource = `
      const fs = require('fs');
      const path = require('path');
      const RESULTS_DIR = ${JSON.stringify(resultsDir)};
      (req, res) => {
        if (req.url.startsWith('/results/')) {
          const parts = req.url.split('/');
          const file = path.join(RESULTS_DIR, parts[2], parts[3], parts[4] + '.json');
          if (fs.existsSync(file)) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(fs.readFileSync(file, 'utf8'));
          } else {
            res.writeHead(404).end();
          }
          return;
        }
        if (req.url === '/acquire') {
          res.writeHead(500).end();
          return;
        }
        res.writeHead(404).end();
      }
    `;
    stub = await spawnStubDaemon(tmpDir, handlerSource);

    const result = spawnTorqueRemote(['--suite', 'gate', '--branch', 'HEAD', 'echo', 'should-not-run'], {
      TORQUE_COORD_PORT: String(stub.port),
      TORQUE_REMOTE_COORD_SHA: 'HEAD',
      HOME: tmpDir,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CACHED RESULT REPLAY');
    expect(result.stdout).not.toContain('should-not-run');
    expect(result.stderr).toContain('[torque-coord] cache hit');
  });

  it('skips warm hit when stored hashes do not match local hashes', async () => {
    makeConfig(tmpDir);
    const fs = require('fs');
    const path = require('path');
    const resultsDir = path.join(tmpDir, '.torque-coord', 'results');
    const projectRoot = path.join(tmpDir, 'tr-coord');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), 'local content');
    fs.writeFileSync(path.join(projectRoot, '.torque-remote.json'), JSON.stringify({
      transport: 'local', intercept_commands: [],
    }));

    const shaDir = path.join(resultsDir, 'tr-coord', 'HEAD');
    fs.mkdirSync(shaDir, { recursive: true });
    fs.writeFileSync(path.join(shaDir, 'gate.json'), JSON.stringify({
      project: 'tr-coord', sha: 'HEAD', suite: 'gate',
      exit_code: 0, suite_status: 'pass', output_tail: 'STALE\n',
      package_lock_hashes: { 'package-lock.json': 'deadbeef-mismatch' },
      completed_at: new Date().toISOString(),
    }));

    const handlerSource = `
      const fs = require('fs');
      const path = require('path');
      const RESULTS_DIR = ${JSON.stringify(resultsDir)};
      (req, res) => {
        if (req.url.startsWith('/results/')) {
          const parts = req.url.split('/');
          const file = path.join(RESULTS_DIR, parts[2], parts[3], parts[4] + '.json');
          if (fs.existsSync(file)) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(fs.readFileSync(file, 'utf8'));
          } else {
            res.writeHead(404).end();
          }
          return;
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url === '/acquire') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ acquired: true, lock_id: 'fresh' }));
          } else if (req.url === '/release' || req.url === '/heartbeat') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ released: true, ok: true }));
          } else {
            res.writeHead(404).end();
          }
        });
      }
    `;
    stub = await spawnStubDaemon(tmpDir, handlerSource);

    const result = spawnTorqueRemote(['--suite', 'gate', '--branch', 'HEAD', 'echo', 'fresh-run'], {
      TORQUE_COORD_PORT: String(stub.port),
      TORQUE_REMOTE_COORD_SHA: 'HEAD',
      HOME: tmpDir,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('fresh-run');
    expect(result.stdout).not.toContain('STALE');
    expect(result.stderr).toContain('[torque-coord] hash mismatch');
  });
});
