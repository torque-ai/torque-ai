'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const TORQUE_REMOTE = path.resolve(__dirname, '..', '..', 'bin', 'torque-remote');

// Tests probe a tiny shell helper we added: bin/torque-remote exposes
// `coord_select_routing_mode` via a `--__internal-print-routing-mode` flag
// (test-only) so we can assert the decision without running a full sync.
//
// TORQUE_COORD_PROBE_URL is set to redirect the curl health-check away from
// the real daemon port so tests stay hermetic even when the daemon is running.
function runRoutingProbe(env) {
  return spawnSync('bash', [TORQUE_REMOTE, '--__internal-print-routing-mode'], {
    encoding: 'utf8',
    env: { ...process.env, ...env, PATH: process.env.PATH || '' },
    timeout: 5000,
  });
}

describe('torque-remote coord routing decision', () => {
  let fakeHome;
  let localServer;
  let localPort;

  beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-routing-home-'));
  });

  afterEach(async () => {
    if (localServer) {
      await new Promise((r) => localServer.close(r));
      localServer = null;
      localPort = undefined;
    }
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  function writeRemoteConfig(host, user) {
    fs.writeFileSync(path.join(fakeHome, '.torque-remote.local.json'),
      JSON.stringify({ host, user, default_project_path: 'C:\\\\x' }));
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
});
