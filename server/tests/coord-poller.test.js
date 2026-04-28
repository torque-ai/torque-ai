'use strict';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

// Test hostnames are intentionally dotless so they don't trigger the
// repo's PII guard's email-pattern matcher when the test source is read.
const HOST_FROM_CFG = 'cfgworkstation';
const USER_FROM_CFG = 'cfguser';
const HOST_FROM_ENV = 'envworkstation';
const USER_FROM_ENV = 'envuser';

describe('coord-poller', () => {
  let tmpHome;
  let originalSpawn;
  let spawnCalls;

  beforeEach(() => {
    delete require.cache[require.resolve('../coord/coord-poller')];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-poller-home-'));
    spawnCalls = [];
    originalSpawn = child_process.spawn;
    child_process.spawn = vi.fn((cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('{"active":[]}'));
        proc.emit('close', 0);
      });
      return proc;
    });
  });

  afterEach(() => {
    child_process.spawn = originalSpawn;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeConfig(host, user) {
    fs.writeFileSync(path.join(tmpHome, '.torque-remote.local.json'),
      JSON.stringify({ host, user, default_project_path: 'C:\\\\x' }));
  }

  it('returns {reachable:false, error:"no_workstation_configured"} when neither config nor env is set', async () => {
    const { getActiveLocks } = require('../coord/coord-poller');
    const result = await getActiveLocks({ home: tmpHome, env: {} });
    expect(result.reachable).toBe(false);
    expect(result.error).toBe('no_workstation_configured');
    expect(result.active).toEqual([]);
    expect(spawnCalls).toHaveLength(0);
  });

  it('reads host/user from ~/.torque-remote.local.json and ssh-curls /active', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    const { getActiveLocks } = require('../coord/coord-poller');
    const result = await getActiveLocks({ home: tmpHome, env: {} });
    expect(result.reachable).toBe(true);
    expect(result.active).toEqual([]);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe('ssh');
    const argsJoined = spawnCalls[0].args.join(' ');
    expect(argsJoined).toContain(USER_FROM_CFG);
    expect(argsJoined).toContain(HOST_FROM_CFG);
    expect(argsJoined).toContain('http://127.0.0.1:9395/active');
  });

  it('env vars override the config file', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    const env = { TORQUE_COORD_REMOTE_HOST: HOST_FROM_ENV, TORQUE_COORD_REMOTE_USER: USER_FROM_ENV };
    const { getActiveLocks } = require('../coord/coord-poller');
    await getActiveLocks({ home: tmpHome, env });
    const argsJoined = spawnCalls[0].args.join(' ');
    expect(argsJoined).toContain(USER_FROM_ENV);
    expect(argsJoined).toContain(HOST_FROM_ENV);
    expect(argsJoined).not.toContain(USER_FROM_CFG);
    expect(argsJoined).not.toContain(HOST_FROM_CFG);
  });

  it('caches the last successful response for 5 seconds', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    const { getActiveLocks } = require('../coord/coord-poller');
    await getActiveLocks({ home: tmpHome, env: {} });
    await getActiveLocks({ home: tmpHome, env: {} });
    await getActiveLocks({ home: tmpHome, env: {} });
    expect(spawnCalls).toHaveLength(1);
  });

  it('force:true bypasses the cache', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    const { getActiveLocks } = require('../coord/coord-poller');
    await getActiveLocks({ home: tmpHome, env: {} });
    await getActiveLocks({ home: tmpHome, env: {}, force: true });
    expect(spawnCalls).toHaveLength(2);
  });

  it('returns {reachable:false} when ssh exits non-zero', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    child_process.spawn = vi.fn(() => {
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => {
        proc.stderr.emit('data', Buffer.from('ssh: connect to host timed out'));
        proc.emit('close', 255);
      });
      return proc;
    });
    const { getActiveLocks } = require('../coord/coord-poller');
    const result = await getActiveLocks({ home: tmpHome, env: {} });
    expect(result.reachable).toBe(false);
    expect(result.error).toContain('ssh');
    expect(result.active).toEqual([]);
  });

  it('returns {reachable:false, error:"invalid_json"} when ssh-curl yields non-JSON', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    child_process.spawn = vi.fn(() => {
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('curl: (7) Failed to connect to 127.0.0.1 port 9395'));
        proc.emit('close', 0);
      });
      return proc;
    });
    const { getActiveLocks } = require('../coord/coord-poller');
    const result = await getActiveLocks({ home: tmpHome, env: {} });
    expect(result.reachable).toBe(false);
    expect(result.error).toBe('invalid_json');
  });

  it('honors a 5s ssh timeout (kills the spawn after that long)', async () => {
    writeConfig(HOST_FROM_CFG, USER_FROM_CFG);
    let killedProc = null;
    child_process.spawn = vi.fn(() => {
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn(() => { killedProc = proc; proc.emit('close', null); });
      return proc;
    });
    const { getActiveLocks } = require('../coord/coord-poller');
    const result = await getActiveLocks({ home: tmpHome, env: {}, timeout_ms: 50 });
    expect(killedProc).not.toBeNull();
    expect(result.reachable).toBe(false);
    expect(result.error).toBe('timeout');
  });
});
