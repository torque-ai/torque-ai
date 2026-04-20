'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('API key auto-generation', () => {
  const originalEnv = {
    TORQUE_DATA_DIR: process.env.TORQUE_DATA_DIR,
    TORQUE_TEST_SANDBOX: process.env.TORQUE_TEST_SANDBOX,
    TORQUE_TEST_SANDBOX_DIR: process.env.TORQUE_TEST_SANDBOX_DIR,
  };

  let db = null;
  let testDir = null;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-api-key-'));
    process.env.TORQUE_TEST_SANDBOX = '1';
    process.env.TORQUE_TEST_SANDBOX_DIR = testDir;
    process.env.TORQUE_DATA_DIR = testDir;

    freshRequire('../data-dir').setDataDir(null);
    db = freshRequire('../database');
    db.init();
  });

  afterEach(() => {
    try { if (db && db.close) db.close(); } catch { /* ignore cleanup errors */ }
    db = null;

    restoreEnv('TORQUE_DATA_DIR', originalEnv.TORQUE_DATA_DIR);
    restoreEnv('TORQUE_TEST_SANDBOX', originalEnv.TORQUE_TEST_SANDBOX);
    restoreEnv('TORQUE_TEST_SANDBOX_DIR', originalEnv.TORQUE_TEST_SANDBOX_DIR);

    try { require('../data-dir').setDataDir(null); } catch { /* ignore cleanup errors */ }
    delete require.cache[require.resolve('../database')];
    delete require.cache[require.resolve('../data-dir')];

    if (testDir) {
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      testDir = null;
    }
  });

  it('generates a key when none exists', () => {
    const key = db.getConfig('api_key');
    expect(key).toBeTruthy();
    expect(key.length).toBeGreaterThanOrEqual(32);
  });

  it('does not overwrite existing key on restart', () => {
    const key1 = db.getConfig('api_key');
    const configCore = require('../db/config-core');
    configCore.ensureApiKey();
    const key2 = db.getConfig('api_key');
    expect(key2).toBe(key1);
  });
});
