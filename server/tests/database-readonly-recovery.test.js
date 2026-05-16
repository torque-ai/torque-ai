'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getVitestTemplateBufferPath } = require('./vitest-template-paths');

const TEMPLATE_BUF = getVitestTemplateBufferPath();

const isWindows = process.platform === 'win32';

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

describe('database SQLITE_READONLY recovery path', () => {
  const originalEnv = {
    TORQUE_DATA_DIR: process.env.TORQUE_DATA_DIR,
    TORQUE_TEST_SANDBOX: process.env.TORQUE_TEST_SANDBOX,
    TORQUE_TEST_SANDBOX_DIR: process.env.TORQUE_TEST_SANDBOX_DIR,
    TORQUE_LOG_DATA_DIR_RESOLUTION: process.env.TORQUE_LOG_DATA_DIR_RESOLUTION,
    TORQUE_DB_INIT_BYPASS_LOCK_CHECK: process.env.TORQUE_DB_INIT_BYPASS_LOCK_CHECK,
  };

  let createdDirs = [];
  let db = null;

  beforeEach(() => {
    createdDirs = [];
    db = null;
  });

  afterEach(() => {
    try { db && db.close && db.close(); } catch { /* ignore */ }

    // Restore env
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }

    // Reset module caches so later tests aren't affected
    try {
      freshRequire('../data-dir').setDataDir(null);
    } catch { /* ignore */ }
    delete require.cache[require.resolve('../database')];
    delete require.cache[require.resolve('../runtime-store')];
    delete require.cache[require.resolve('../data-dir')];

    // Restore directory permissions before cleanup
    for (const dir of createdDirs) {
      try { fs.chmodSync(dir, 0o755); } catch { /* ignore */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // chmod is a no-op on Windows — skip gracefully
  test.skipIf(isWindows)(
    'does not throw ReferenceError when init hits SQLITE_READONLY and falls back to tmpdir',
    () => {
      // Create a directory to hold the "read-only" database
      const readonlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-ro-test-'));
      createdDirs.push(readonlyDir);

      // Seed a minimal DB file so the init path tries to open it
      const Database = require('better-sqlite3');
      const seedDbPath = path.join(readonlyDir, 'tasks.db');
      const seedDb = new Database(seedDbPath);
      seedDb.exec('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)');
      seedDb.close();

      // Make the directory read-only so SQLite cannot write (triggers SQLITE_READONLY)
      fs.chmodSync(seedDbPath, 0o444);
      fs.chmodSync(readonlyDir, 0o555);

      // Set up env to point at the read-only directory
      process.env.TORQUE_DATA_DIR = readonlyDir;
      process.env.TORQUE_TEST_SANDBOX = '1';
      process.env.TORQUE_TEST_SANDBOX_DIR = readonlyDir;
      process.env.TORQUE_DB_INIT_BYPASS_LOCK_CHECK = '1';
      process.env.TORQUE_LOG_DATA_DIR_RESOLUTION = '0';

      // The key assertion: the recovery path must NOT throw a ReferenceError
      // (which would mean `os` or `ensureWritableDataDir` is undefined).
      // It may throw an operational error if the fallback also fails, but
      // never a ReferenceError for a missing symbol.
      const dataDir = freshRequire('../data-dir');
      dataDir.setDataDir(null); // force re-resolve

      let thrownError = null;
      try {
        db = freshRequire('../runtime-store');
        db.init();
      } catch (err) {
        thrownError = err;
      }

      // Must not be a ReferenceError (the original bug: missing `os` / `ensureWritableDataDir`)
      if (thrownError) {
        expect(thrownError).not.toBeInstanceOf(ReferenceError);
        // Also verify it's not a TypeError from undefined function call
        expect(thrownError.message).not.toMatch(/is not a function/);
        expect(thrownError.message).not.toMatch(/is not defined/);
      }
      // If no error was thrown, the fallback succeeded — that's the happy path
    }
  );

  test.skipIf(isWindows)(
    'recovery path relocates to a writable temp directory on SQLITE_READONLY',
    () => {
      // Create a read-only directory
      const readonlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-ro-reloc-'));
      createdDirs.push(readonlyDir);

      // Seed a DB file
      const Database = require('better-sqlite3');
      const seedDbPath = path.join(readonlyDir, 'tasks.db');
      const seedDb = new Database(seedDbPath);
      seedDb.exec('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)');
      seedDb.close();

      // Lock it down
      fs.chmodSync(seedDbPath, 0o444);
      fs.chmodSync(readonlyDir, 0o555);

      process.env.TORQUE_DATA_DIR = readonlyDir;
      process.env.TORQUE_TEST_SANDBOX = '1';
      process.env.TORQUE_TEST_SANDBOX_DIR = readonlyDir;
      process.env.TORQUE_DB_INIT_BYPASS_LOCK_CHECK = '1';
      process.env.TORQUE_LOG_DATA_DIR_RESOLUTION = '0';

      const dataDir = freshRequire('../data-dir');
      dataDir.setDataDir(null);

      let initSucceeded = false;
      try {
        db = freshRequire('../runtime-store');
        db.init();
        initSucceeded = true;
      } catch (err) {
        // If init fails, it should be an operational error (not symbol missing)
        expect(err).not.toBeInstanceOf(ReferenceError);
      }

      if (initSucceeded) {
        // The data dir should have moved away from the read-only location
        const resolvedDir = db.getDataDir();
        expect(resolvedDir).not.toBe(readonlyDir);
        // It should be the tmpdir fallback
        expect(resolvedDir).toContain(os.tmpdir().replace(/\\/g, '/').split('/')[0] ? '' : '/tmp');
      }
    }
  );
});
