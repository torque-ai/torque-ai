'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMPLATE_BUF = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

describe('test sandbox data dir guardrails', () => {
  const originalEnv = {
    TORQUE_DATA_DIR: process.env.TORQUE_DATA_DIR,
    TORQUE_TEST_SANDBOX: process.env.TORQUE_TEST_SANDBOX,
    TORQUE_TEST_SANDBOX_DIR: process.env.TORQUE_TEST_SANDBOX_DIR,
  };

  let createdDirs = [];
  let db = null;

  beforeEach(() => {
    createdDirs = [];
    db = null;
  });

  afterEach(() => {
    try { db && db.close && db.close(); } catch { /* ignore */ }
    process.env.TORQUE_DATA_DIR = originalEnv.TORQUE_DATA_DIR;
    process.env.TORQUE_TEST_SANDBOX = originalEnv.TORQUE_TEST_SANDBOX;
    process.env.TORQUE_TEST_SANDBOX_DIR = originalEnv.TORQUE_TEST_SANDBOX_DIR;

    try {
      freshRequire('../data-dir').setDataDir(null);
    } catch { /* ignore */ }

    delete require.cache[require.resolve('../database')];
    delete require.cache[require.resolve('../data-dir')];

    for (const dir of createdDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('uses the test sandbox instead of ~/.torque when TORQUE_DATA_DIR is unset', () => {
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-sandbox-'));
    createdDirs.push(sandboxDir);

    delete process.env.TORQUE_DATA_DIR;
    process.env.TORQUE_TEST_SANDBOX = '1';
    process.env.TORQUE_TEST_SANDBOX_DIR = sandboxDir;

    const dataDir = freshRequire('../data-dir');
    expect(dataDir.getDataDir()).toBe(sandboxDir);
  });

  it('refreshes database data-dir state after TORQUE_DATA_DIR changes', () => {
    const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-db-sandbox-a-'));
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-db-sandbox-b-'));
    createdDirs.push(firstDir, secondDir);

    process.env.TORQUE_TEST_SANDBOX = '1';
    process.env.TORQUE_TEST_SANDBOX_DIR = firstDir;
    process.env.TORQUE_DATA_DIR = firstDir;

    const dataDir = freshRequire('../data-dir');
    db = freshRequire('../database');
    db.resetForTest(fs.readFileSync(TEMPLATE_BUF));
    expect(db.getDataDir()).toBe(firstDir);

    process.env.TORQUE_TEST_SANDBOX_DIR = secondDir;
    process.env.TORQUE_DATA_DIR = secondDir;
    dataDir.setDataDir(null);

    db.resetForTest(fs.readFileSync(TEMPLATE_BUF));
    expect(db.getDataDir()).toBe(secondDir);
  });
});
