'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const TORQUE_REMOTE = path.resolve(__dirname, '..', '..', 'bin', 'torque-remote');

// On Windows, bare `bash` may resolve to WSL bash (C:\Windows\System32\bash.exe),
// which can't execute scripts at native Windows paths and exits 127. Pin to Git
// Bash when present. Mirrors the fix in coord-torque-remote-integration.test.js.
const GIT_BASH_PATH = path.join('C:', 'Program Files', 'Git', 'bin', 'bash.exe');
const BASH_EXECUTABLE = process.platform === 'win32' && fs.existsSync(GIT_BASH_PATH)
  ? GIT_BASH_PATH
  : 'bash';
const PROBE_SPAWN_TIMEOUT_MS = 15000;
const PROBE_TEST_TIMEOUT_MS = 30000;

function toBashPath(value) {
  return value.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
}

function isolatedCoordEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== 'PATH') env[key] = value;
  }
  delete env.TORQUE_COORD_REMOTE_HOST;
  delete env.TORQUE_COORD_REMOTE_USER;
  delete env.TORQUE_COORD_SSH_BIN;
  delete env.BASH_ENV;
  return { ...env, ...overrides };
}

// Tests probe a tiny shell helper we added: bin/torque-remote exposes
// `coord_select_routing_mode` via a `--__internal-print-routing-mode` flag
// (test-only) so we can assert the decision without running a full sync.
//
// TORQUE_COORD_PROBE_URL is set to redirect the curl health-check away from
// the real daemon port so tests stay hermetic even when the daemon is running.
function runRoutingProbe(env) {
  return spawnSync(BASH_EXECUTABLE, [TORQUE_REMOTE, '--__internal-print-routing-mode'], {
    encoding: 'utf8',
    env: isolatedCoordEnv({ ...env, PATH: env.PATH || process.env.PATH || '' }),
    timeout: PROBE_SPAWN_TIMEOUT_MS,
    windowsHide: true,
  });
}

function runAvailabilityProbe(env, options = {}) {
  return spawnSync(BASH_EXECUTABLE, [TORQUE_REMOTE, '--__internal-probe-remote-availability'], {
    encoding: 'utf8',
    env: isolatedCoordEnv({ ...env, PATH: env.PATH || process.env.PATH || '' }),
    cwd: options.cwd,
    timeout: PROBE_SPAWN_TIMEOUT_MS,
    windowsHide: true,
  });
}

describe('torque-remote coord routing decision', () => {
  let fakeHome;
  let fakeProjectRoot;
  let localServer;
  let fakeSshDir;
  let fakeSshArgvFile;

  beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-routing-home-'));
  }, PROBE_TEST_TIMEOUT_MS);

  afterEach(async () => {
    if (localServer) {
      await new Promise((r) => localServer.close(r));
      localServer = null;
    }
    if (fakeSshDir) {
      try { fs.rmSync(fakeSshDir, { recursive: true, force: true }); } catch { /* Windows file handles can linger briefly. */ }
      fakeSshDir = null;
    }
    if (fakeProjectRoot) {
      try { fs.rmSync(fakeProjectRoot, { recursive: true, force: true }); } catch { /* Windows file handles can linger briefly. */ }
      fakeProjectRoot = null;
    }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* Windows file handles can linger briefly. */ }
  }, PROBE_TEST_TIMEOUT_MS);

  function writeTransportConfig(transport) {
    fs.writeFileSync(path.join(fakeHome, '.torque-remote.json'), JSON.stringify({ transport }));
  }

  function writeRemoteConfig(host, user) {
    fs.writeFileSync(path.join(fakeHome, '.torque-remote.local.json'),
      JSON.stringify({ host, user, default_project_path: 'C:\\\\x' }));
  }

  function writeProjectWithInfrastructureRemoteConfig({ host, user }) {
    fakeProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-project-'));
    fs.mkdirSync(path.join(fakeProjectRoot, '.git'));
    fs.writeFileSync(path.join(fakeProjectRoot, '.torque-remote.json'), JSON.stringify({ transport: 'ssh' }));
    const hostsDir = path.join(fakeProjectRoot, 'infrastructure', 'hosts');
    fs.mkdirSync(hostsDir, { recursive: true });
    fs.writeFileSync(path.join(hostsDir, 'torque-remote.local.json'), JSON.stringify({
      host,
      user,
      remote_project_path: 'C:\\\\trt\\\\torque-public',
      remote_test_worktree_root: 'C:\\\\trt',
    }));
    return fakeProjectRoot;
  }

  function writeFakeSsh(exitCode = 0) {
    fakeSshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-fake-ssh-'));
    fakeSshArgvFile = path.join(fakeSshDir, 'argv.txt');
    const sshScriptPath = path.join(fakeSshDir, 'ssh');
    const argvFileForBash = toBashPath(fakeSshArgvFile);
    fs.writeFileSync(sshScriptPath, [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" > "${argvFileForBash}"`,
      `exit ${exitCode}`,
    ].join('\n'));
    fs.chmodSync(sshScriptPath, 0o755);
    return { PATH: `${toBashPath(fakeSshDir)}:${process.env.PATH || ''}` };
  }

  it('prints "local" when 127.0.0.1:9395 responds', async () => {
    // spawnSync blocks the Node event loop, so we cannot use a Node http.Server
    // as the probe target (the event loop is frozen while bash runs curl).
    // Instead we probe the real coord daemon at 9395, which is expected to be
    // running in the development environment. Skip if it is not reachable so
    // the test stays green in environments where the daemon is absent.
    const isUp = await new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:9395/health', (res) => {
        res.resume();
        resolve(true);
      });
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });

    if (!isUp) {
      // Daemon not running in this environment — skip.
      return;
    }

    const result = runRoutingProbe({
      HOME: fakeHome,
      TORQUE_COORD_PROBE_URL: 'http://127.0.0.1:9395/health',
    });
    expect(result.stdout.trim()).toBe('local');
    expect(result.status).toBe(0);
  });

  it('prints "ssh:user@host" when local 9395 is down AND remote config exists', () => {
    writeRemoteConfig('wkshost', 'wksuser');
    // Port 1 is reserved/unreachable — curl will fail immediately.
    const result = runRoutingProbe({
      HOME: fakeHome,
      TORQUE_COORD_PROBE_URL: 'http://127.0.0.1:1/health',
    });
    expect(result.stdout.trim()).toBe('ssh:wksuser@wkshost');
    expect(result.status).toBe(0);
  });

  it('prints "none" when local 9395 is down AND no remote config', () => {
    // Port 1 is reserved/unreachable — curl will fail immediately.
    const result = runRoutingProbe({
      HOME: fakeHome,
      TORQUE_COORD_PROBE_URL: 'http://127.0.0.1:1/health',
    });
    expect(result.stdout.trim()).toBe('none');
    expect(result.status).toBe(0);
  });

  it('env override TORQUE_COORD_REMOTE_HOST/USER beats the config file', () => {
    writeRemoteConfig('cfgwks', 'cfguser');
    // Env-override path skips the probe entirely, so TORQUE_COORD_PROBE_URL
    // is irrelevant here — but set it to avoid any accidental daemon hit.
    const result = runRoutingProbe({
      HOME: fakeHome,
      TORQUE_COORD_PROBE_URL: 'http://127.0.0.1:1/health',
      TORQUE_COORD_REMOTE_HOST: 'envwks',
      TORQUE_COORD_REMOTE_USER: 'envuser',
    });
    expect(result.stdout.trim()).toBe('ssh:envuser@envwks');
    expect(result.status).toBe(0);
  });

  it('prints available when the configured ssh remote responds', () => {
    writeTransportConfig('ssh');
    writeRemoteConfig('wkshost', 'wksuser');
    const result = runAvailabilityProbe({
      HOME: fakeHome,
      ...writeFakeSsh(0),
      TORQUE_REMOTE_AVAILABILITY_TIMEOUT_SECS: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('available:wksuser@wkshost');
    const argv = fs.readFileSync(fakeSshArgvFile, 'utf8');
    expect(argv).toContain('ConnectTimeout=1');
    expect(argv).toContain('BatchMode=yes');
    expect(argv).toContain('wksuser@wkshost');
    expect(argv).toContain('echo ok');
  });

  it('project infrastructure host credentials override stale global local credentials', () => {
    writeRemoteConfig('oldhost', 'olduser');
    const projectRoot = writeProjectWithInfrastructureRemoteConfig({
      host: 'newhost',
      user: 'newuser',
    });
    const result = runAvailabilityProbe({
      HOME: fakeHome,
      ...writeFakeSsh(0),
      TORQUE_REMOTE_AVAILABILITY_TIMEOUT_SECS: '1',
    }, { cwd: projectRoot });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('available:newuser@newhost');
    const argv = fs.readFileSync(fakeSshArgvFile, 'utf8');
    expect(argv).toContain('newuser@newhost');
    expect(argv).not.toContain('olduser@oldhost');
  });

  it('prints unavailable without falling back when ssh cannot connect', () => {
    writeTransportConfig('ssh');
    writeRemoteConfig('wkshost', 'wksuser');
    const result = runAvailabilityProbe({
      HOME: fakeHome,
      ...writeFakeSsh(255),
      TORQUE_REMOTE_AVAILABILITY_TIMEOUT_SECS: '1',
    });
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe('unavailable:ssh_unreachable:host=wkshost');
    const argv = fs.readFileSync(fakeSshArgvFile, 'utf8');
    expect(argv).toContain('wksuser@wkshost');
  });
});
