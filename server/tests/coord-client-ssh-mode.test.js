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
  // On Windows, process.env may expose PATH as 'Path' (mixed case) while the
  // env we pass has 'PATH' (uppercase). Having both in the env block causes
  // the child to inherit the ORIGINAL Path value (ignoring our override) when
  // Windows searches for executables. Fix: strip any existing PATH-like key
  // from the base env before applying our override so only one copy exists.
  const baseEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() !== 'PATH') baseEnv[k] = v;
  }
  const childPath = env.PATH || process.env.PATH || '';
  return spawnSync(process.execPath, [COORD_CLIENT, ...args], {
    encoding: 'utf8',
    env: { ...baseEnv, ...env, PATH: childPath },
    timeout: 10000,
  });
}

// On Windows, spawn('ssh') uses CreateProcess which requires a .exe or
// PATHEXT-listed extension. We create a .cmd wrapper alongside the shebang
// script so the fake ssh is found on both Unix and Windows.
//
// The coord-client accepts TORQUE_COORD_SSH_BIN to override the ssh binary
// path, allowing tests to inject the .cmd wrapper directly (bypassing the
// PATHEXT lookup that bare spawn('ssh') can't do on Windows).
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
  // Used via TORQUE_COORD_SSH_BIN so CreateProcess can execute it with shell:true.
  const cmdPath = path.join(dir, 'ssh.cmd');
  // %* forwards all arguments; NODE_PATH variable points node to our script.
  fs.writeFileSync(cmdPath, `@"${process.execPath}" "${scriptPath}" %*\r\n`);

  // Return the best binary path for the current platform:
  //   - Windows: the .cmd path (used with shell:true via TORQUE_COORD_SSH_BIN)
  //   - Unix: the shebang script (used with shell:false)
  return process.platform === 'win32' ? cmdPath : scriptPath;
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
  let sshBin;

  beforeEach(() => {
    // Build a tiny on-disk fake `ssh` that records argv + emits a configurable response.
    // sshBin is the platform-appropriate path passed via TORQUE_COORD_SSH_BIN so the
    // coord-client uses it directly instead of searching PATH (avoids PATHEXT issues on Win).
    fakeSshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ssh-'));
    argvFile = path.join(fakeSshDir, 'argv.json');
    sshBin = writeFakeSsh(fakeSshDir, argvFile);
  });

  afterEach(() => {
    fs.rmSync(fakeSshDir, { recursive: true, force: true });
  });

  it('routes `health` through ssh+curl when remote env is set', () => {
    // FAKE_SSH_STDOUT simulates curl output with the HTTPSTATUS: sentinel appended by -w.
    const result = runClient(['health'], {
      TORQUE_COORD_SSH_BIN: sshBin,
      TORQUE_COORD_REMOTE_HOST: REMOTE_HOST,
      TORQUE_COORD_REMOTE_USER: REMOTE_USER,
      FAKE_SSH_STDOUT: '{"status":"ok"}HTTPSTATUS:200',
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
    // FAKE_SSH_STDOUT simulates curl output with HTTPSTATUS: sentinel appended by -w.
    const result = runClient([
      'acquire',
      '--project', 'torque-public',
      '--sha', 'deadbeef',
      '--suite', 'gate',
      '--host', 'devbox',
      '--pid', '4242',
      '--user', 'tester',
    ], {
      TORQUE_COORD_SSH_BIN: sshBin,
      TORQUE_COORD_REMOTE_HOST: REMOTE_HOST,
      TORQUE_COORD_REMOTE_USER: REMOTE_USER,
      FAKE_SSH_STDOUT: '{"lock_id":"abc123"}HTTPSTATUS:200',
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
      TORQUE_COORD_SSH_BIN: sshBin,
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
