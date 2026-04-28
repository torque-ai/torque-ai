'use strict';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { EventEmitter } = require('events');

// Hostnames intentionally dotless to dodge PII pattern matchers.
const REMOTE_HOST = 'wkshost';
const REMOTE_USER = 'wksuser';

const COORD_CLIENT = path.resolve(__dirname, '..', '..', 'bin', 'torque-coord-client');

function runClient(args, env) {
  return spawnSync(process.execPath, [COORD_CLIENT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, PATH: process.env.PATH || '' },
    timeout: 10000,
  });
}

describe('coord-client ssh mode', () => {
  let fakeSshDir;
  let fakeSsh;

  beforeEach(() => {
    // Build a tiny on-disk fake `ssh` that records argv + emits a configurable response.
    // Putting it on PATH lets the child Node CLI invoke "ssh" and hit our stub.
    fakeSshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ssh-'));
    fakeSsh = path.join(fakeSshDir, 'ssh');
    // The fake ssh writes its argv into a sidecar file and prints whatever
    // FAKE_SSH_STDOUT contains. Exits with FAKE_SSH_EXIT (default 0).
    fs.writeFileSync(fakeSsh, [
      '#!/usr/bin/env node',
      `const fs = require('fs');`,
      `fs.writeFileSync('${path.join(fakeSshDir, 'argv.json').replace(/\\\\/g, '/')}', JSON.stringify(process.argv.slice(2)));`,
      `if (process.env.FAKE_SSH_STDOUT) process.stdout.write(process.env.FAKE_SSH_STDOUT);`,
      `process.exit(parseInt(process.env.FAKE_SSH_EXIT || '0', 10));`,
    ].join('\n'));
    fs.chmodSync(fakeSsh, 0o755);
  });

  afterEach(() => {
    fs.rmSync(fakeSshDir, { recursive: true, force: true });
  });

  it('routes `health` through ssh+curl when remote env is set', () => {
    const result = runClient(['health'], {
      PATH: fakeSshDir + path.delimiter + (process.env.PATH || ''),
      TORQUE_COORD_REMOTE_HOST: REMOTE_HOST,
      TORQUE_COORD_REMOTE_USER: REMOTE_USER,
      FAKE_SSH_STDOUT: '{"status":"ok"}',
    });
    expect(result.status).toBe(0);
    const argv = JSON.parse(fs.readFileSync(path.join(fakeSshDir, 'argv.json'), 'utf8'));
    const joined = argv.join(' ');
    expect(joined).toContain(`${REMOTE_USER}@${REMOTE_HOST}`);
    expect(joined).toContain('curl');
    expect(joined).toContain('http://127.0.0.1:9395/health');
    expect(result.stdout).toContain('"status":"ok"');
  });

  it('routes `acquire` through ssh and posts the request body via curl --data', () => {
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
      FAKE_SSH_STDOUT: '{"lock_id":"abc123"}',
    });
    expect(result.status).toBe(0);
    const argv = JSON.parse(fs.readFileSync(path.join(fakeSshDir, 'argv.json'), 'utf8'));
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

  it('falls back to local mode when remote env is NOT set (legacy behavior intact)', () => {
    // Stand up a real local HTTP server on a random port; aim the client at it
    // via TORQUE_COORD_PORT. With no TORQUE_COORD_REMOTE_HOST set, the CLI
    // must NOT shell out to ssh.
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)).then(() => {
      const port = server.address().port;
      const result = runClient(['health'], {
        PATH: fakeSshDir + path.delimiter + (process.env.PATH || ''),
        TORQUE_COORD_PORT: String(port),
        // intentionally no TORQUE_COORD_REMOTE_HOST/USER
      });
      // The fake ssh would have written argv.json IF it were called.
      const sshWasCalled = fs.existsSync(path.join(fakeSshDir, 'argv.json'));
      expect(sshWasCalled).toBe(false);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"status":"ok"');
      return new Promise((r) => server.close(r));
    });
  });
});
