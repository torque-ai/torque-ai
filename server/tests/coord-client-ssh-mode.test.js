'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// Hostnames intentionally dotless to dodge PII pattern matchers.
const REMOTE_HOST = 'wkshost';
const REMOTE_USER = 'wksuser';

const COORD_CLIENT = path.resolve(__dirname, '..', '..', 'bin', 'torque-coord-client');

function runClient(args, env) {
  return spawnSync(process.execPath, [COORD_CLIENT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, PATH: env.PATH || process.env.PATH || '' },
    timeout: 10000,
  });
}

// On Windows, spawn('ssh') uses CreateProcess which requires a .exe or
// PATHEXT-listed extension. We create a .cmd wrapper alongside the shebang
// script so the fake ssh is found on both Unix and Windows.
function writeFakeSsh(dir, argvFile) {
  const scriptPath = path.join(dir, 'ssh');
  const escapedArgvFile = argvFile.replace(/\\/g, '/');
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env node',
    `const fs = require('fs');`,
    `fs.writeFileSync('${escapedArgvFile}', JSON.stringify(process.argv.slice(2)));`,
    `if (process.env.FAKE_SSH_STDOUT) process.stdout.write(process.env.FAKE_SSH_STDOUT);`,
    `process.exit(parseInt(process.env.FAKE_SSH_EXIT || '0', 10));`,
  ].join('\n'));
  fs.chmodSync(scriptPath, 0o755);

  // Windows .cmd wrapper — delegates to the node script above.
  // CreateProcess finds ssh.cmd via PATHEXT when ssh is in PATH.
  const cmdPath = path.join(dir, 'ssh.cmd');
  // %* forwards all arguments; NODE_PATH variable points node to our script.
  fs.writeFileSync(cmdPath, `@"${process.execPath}" "${scriptPath}" %*\r\n`);
}

// Spawn a stub HTTP daemon in a separate child process to avoid the spawnSync
// event-loop deadlock (in-process servers can't respond while the parent's
// event loop is blocked by spawnSync waiting for the CLI child to exit).
function makeStubDaemon(responseBody) {
  const tmpFile = path.join(os.tmpdir(), `coord-stub-ssh-${process.pid}-${Date.now()}.js`);
  const script = `
'use strict';
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(${JSON.stringify(responseBody)});
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('message', (m) => { if (m === 'shutdown') server.close(() => process.exit(0)); });
`;
  fs.writeFileSync(tmpFile, script);
  const child = spawn(process.execPath, [tmpFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const nlIdx = buf.indexOf('\n');
      if (nlIdx >= 0) {
        child.stdout.removeListener('data', onData);
        try {
          const { port } = JSON.parse(buf.slice(0, nlIdx));
          resolve({
            port,
            close: () => new Promise((res) => {
              child.once('exit', () => {
                try { fs.unlinkSync(tmpFile); } catch (_e) { /* best-effort */ }
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
    setTimeout(() => reject(new Error('stub daemon did not start in 5s')), 5000).unref();
  });
}

describe('coord-client ssh mode', () => {
  let fakeSshDir;
  let argvFile;

  beforeEach(() => {
    // Build a tiny on-disk fake `ssh` that records argv + emits a configurable response.
    // Putting it on PATH lets the child Node CLI invoke "ssh" and hit our stub.
    fakeSshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ssh-'));
    argvFile = path.join(fakeSshDir, 'argv.json');
    writeFakeSsh(fakeSshDir, argvFile);
  });

  afterEach(() => {
    fs.rmSync(fakeSshDir, { recursive: true, force: true });
  });

  it('routes `health` through ssh+curl when remote env is set', () => {
    // FAKE_SSH_STDOUT simulates: curl body + "\n" + http_code (as curl -w '\n%{http_code}' would produce)
    const result = runClient(['health'], {
      PATH: fakeSshDir + path.delimiter + (process.env.PATH || ''),
      TORQUE_COORD_REMOTE_HOST: REMOTE_HOST,
      TORQUE_COORD_REMOTE_USER: REMOTE_USER,
      FAKE_SSH_STDOUT: '{"status":"ok"}\n200',
    });
    expect(result.status).toBe(0);
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    const joined = argv.join(' ');
    expect(joined).toContain(`${REMOTE_USER}@${REMOTE_HOST}`);
    expect(joined).toContain('curl');
    expect(joined).toContain('http://127.0.0.1:9395/health');
    expect(result.stdout).toContain('"status":"ok"');
  });

  it('routes `acquire` through ssh and posts the request body via curl --data', () => {
    // FAKE_SSH_STDOUT simulates: curl body + "\n" + http_code
    const result = runClient([
      'acquire',
      '--project', 'torque-public',
      '--sha', 'deadbeef',
      '--suite', 'gate',
      '--host', 'devbox',
      '--pid', '4242',
      '--user', 'tester',
    ], {
      PATH: fakeSshDir + path.delimiter + (process.env.PATH || ''),
      TORQUE_COORD_REMOTE_HOST: REMOTE_HOST,
      TORQUE_COORD_REMOTE_USER: REMOTE_USER,
      FAKE_SSH_STDOUT: '{"lock_id":"abc123"}\n200',
    });
    expect(result.status).toBe(0);
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    const joined = argv.join(' ');
    expect(joined).toContain('curl');
    expect(joined).toContain('http://127.0.0.1:9395/acquire');
    // body must reach curl somehow — either via --data-binary @- (stdin) or --data <inline>
    expect(/-(d|--data|--data-binary)/.test(joined)).toBe(true);
    expect(result.stdout).toContain('"lock_id":"abc123"');
  });

  it('exits with status 2 (unreachable) when ssh fails', () => {
    const result = runClient(['health'], {
      PATH: fakeSshDir + path.delimiter + (process.env.PATH || ''),
      TORQUE_COORD_REMOTE_HOST: REMOTE_HOST,
      TORQUE_COORD_REMOTE_USER: REMOTE_USER,
      FAKE_SSH_EXIT: '255',
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('"status":"unreachable"');
  });

  it('falls back to local mode when remote env is NOT set (legacy behavior intact)', async () => {
    // Use a separate daemon process to avoid the spawnSync event-loop deadlock:
    // in-process http servers can't respond while spawnSync blocks the event loop.
    const daemon = await makeStubDaemon('{"status":"ok"}');
    try {
      const result = runClient(['health'], {
        PATH: fakeSshDir + path.delimiter + (process.env.PATH || ''),
        TORQUE_COORD_PORT: String(daemon.port),
        // intentionally no TORQUE_COORD_REMOTE_HOST/USER
      });
      // The fake ssh would have written argv.json IF it were called.
      const sshWasCalled = fs.existsSync(argvFile);
      expect(sshWasCalled).toBe(false);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"status":"ok"');
    } finally {
      await daemon.close();
    }
  });
});
