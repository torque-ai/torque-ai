'use strict';
/* global describe, it, expect, afterEach, vi */

/**
 * Tests that getDbInstance() throws a clear error while restoreDatabase() is
 * in progress (i.e. between _db.close() and the new handle being assigned),
 * and that the DB is accessible again once restore completes.
 */

const path = require('path');
const { installMock } = require('./cjs-mock');

const SUBJECT_MODULE = '../db/backup-core';
const SQLITE_MODULE = 'better-sqlite3';
const FS_MODULE = 'fs';
const OS_MODULE = 'os';
const LOGGER_MODULE = '../logger';
const MIGRATIONS_MODULE = '../db/migrations';
const SCHEMA_MODULE = '../db/schema';

const subjectPath = require.resolve(SUBJECT_MODULE);
const sqlitePath = require.resolve(SQLITE_MODULE);
const fsPath = require.resolve(FS_MODULE);
const osPath = require.resolve(OS_MODULE);
const loggerPath = require.resolve(LOGGER_MODULE);
const migrationsPath = require.resolve(MIGRATIONS_MODULE);
const schemaPath = require.resolve(SCHEMA_MODULE);

function clearModuleCaches() {
  delete require.cache[subjectPath];
  delete require.cache[sqlitePath];
  delete require.cache[fsPath];
  delete require.cache[osPath];
  delete require.cache[loggerPath];
  delete require.cache[migrationsPath];
  delete require.cache[schemaPath];
}

function createFsMock(overrides = {}) {
  return {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 123, mtime: new Date('2026-03-01T00:00:00.000Z') })),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
    ...overrides,
  };
}

function createLoggerMock() {
  const childLogger = { info: vi.fn(), warn: vi.fn() };
  return { exports: { child: vi.fn(() => childLogger) }, childLogger };
}

function createDbHandle(overrides = {}) {
  return {
    serialize: vi.fn(() => Buffer.from('db-bytes')),
    close: vi.fn(),
    pragma: vi.fn(() => [{ integrity_check: 'ok' }]),
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ name: 'tasks' })) })),
    backup: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

/**
 * Build a db handle that behaves correctly for the restored DB:
 * - 'integrity_check' → [{ integrity_check: 'ok' }]
 * - 'foreign_key_check' → []
 * - everything else → []
 */
function createRestoredDbHandle(overrides = {}) {
  return createDbHandle({
    pragma: vi.fn((stmt) => {
      if (stmt === 'integrity_check') return [{ integrity_check: 'ok' }];
      if (stmt === 'foreign_key_check') return [];
      return [];
    }),
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ name: 'tasks' })) })),
    ...overrides,
  });
}

/**
 * Returns a Database constructor mock that hands out instances in order.
 */
function createDatabaseMock(instances = []) {
  return vi.fn(function MockDatabase(filePath, options) {
    if (instances.length === 0) {
      throw new Error(`Unexpected Database constructor call for ${filePath}`);
    }
    const instance = instances.shift();
    instance.__filePath = filePath;
    instance.__options = options;
    return instance;
  });
}

function loadSubject(options = {}) {
  const fs = options.fs || createFsMock();
  const os = options.os || { homedir: vi.fn(() => 'C:\\mock-home') };
  const loggerMock = createLoggerMock();
  const runMigrations = options.runMigrations || vi.fn();
  const applySchema = options.applySchema || vi.fn();
  const Database = options.Database || createDatabaseMock(options.databaseInstances || []);

  clearModuleCaches();
  installMock(SQLITE_MODULE, Database);
  installMock(FS_MODULE, fs);
  installMock(OS_MODULE, os);
  installMock(LOGGER_MODULE, loggerMock.exports);
  installMock(MIGRATIONS_MODULE, { runMigrations });
  installMock(SCHEMA_MODULE, { applySchema });

  return {
    subject: require(SUBJECT_MODULE),
    fs,
    Database,
    runMigrations,
    applySchema,
  };
}

function setCommonInternals(subject, overrides = {}) {
  const internals = {
    getConfig: vi.fn(() => '24'),
    setConfig: vi.fn(),
    setConfigDefault: vi.fn(),
    safeAddColumn: vi.fn(),
    injectDbAll: vi.fn(),
    getDbPath: vi.fn(() => path.join('C:\\data', 'torque.db')),
    getDataDir: vi.fn(() => 'C:\\data'),
    setDbRef: vi.fn(),
    isDbClosed: vi.fn(() => false),
    ...overrides,
  };
  subject.setInternals(internals);
  return internals;
}

afterEach(() => {
  clearModuleCaches();
  delete process.env.TORQUE_DATA_DIR;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('backup-restore-safety', () => {
  describe('getDbInstance() — restore guard', () => {
    it('returns null when no DB has been set', () => {
      const { subject } = loadSubject();
      expect(subject.getDbInstance()).toBeNull();
    });

    it('returns the live DB handle under normal conditions', () => {
      const { subject } = loadSubject();
      const db = createDbHandle();
      subject.setDb(db);
      expect(subject.getDbInstance()).toBe(db);
    });

    it('throws "Database restore in progress, try again" while restore is running', async () => {
      // We need a backup.backup() that pauses so we can call getDbInstance()
      // while the restore is in its critical section.
      let resolveBackup;
      const backupPromise = new Promise((resolve) => { resolveBackup = resolve; });

      const liveDb = createDbHandle();
      const backupDb = createDbHandle({
        backup: vi.fn(() => backupPromise),
      });
      const restoredDb = createRestoredDbHandle();
      const Database = createDatabaseMock([backupDb, restoredDb]);
      const { subject, fs } = loadSubject({ Database });

      setCommonInternals(subject);
      subject.setDb(liveDb);
      fs.existsSync.mockReturnValue(true);

      // Start restore but do not await — it will pause at backupDb.backup()
      const restorePromise = subject.restoreDatabase('C:\\backups\\snap.db', true, { force: true });

      // At this point the live DB has been closed and the flag is set.
      // getDbInstance() must throw rather than returning the closed handle.
      await expect(Promise.resolve().then(() => subject.getDbInstance()))
        .rejects
        .toThrow('Database restore in progress, try again');

      // Let the backup finish so the restore can complete cleanly.
      resolveBackup();
      await restorePromise;
    });

    it('does not throw after a successful restore completes', async () => {
      const liveDb = createDbHandle();
      const backupDb = createDbHandle({ backup: vi.fn(() => Promise.resolve()) });
      const restoredDb = createRestoredDbHandle();
      const Database = createDatabaseMock([backupDb, restoredDb]);
      const { subject, fs } = loadSubject({ Database });

      setCommonInternals(subject);
      subject.setDb(liveDb);
      fs.existsSync.mockReturnValue(true);

      await subject.restoreDatabase('C:\\backups\\snap.db', true, { force: true });

      // Flag must be cleared; getDbInstance() must return the new DB handle.
      const instance = subject.getDbInstance();
      expect(instance).toBe(restoredDb);
    });

    it('clears the restore flag even when an integrity check error is thrown mid-restore', async () => {
      const liveDb = createDbHandle();
      const backupDb = createDbHandle({ backup: vi.fn(() => Promise.resolve()) });
      const brokenDb = createRestoredDbHandle({
        pragma: vi.fn((stmt) => {
          if (stmt === 'integrity_check') {
            return [{ integrity_check: 'malformed page 1' }];
          }
          return [];
        }),
      });
      const Database = createDatabaseMock([backupDb, brokenDb]);
      const { subject, fs } = loadSubject({ Database });

      setCommonInternals(subject);
      subject.setDb(liveDb);
      fs.existsSync.mockReturnValue(true);

      await expect(subject.restoreDatabase('C:\\backups\\bad.db', true, { force: true }))
        .rejects
        .toThrow('Restored database failed integrity check');

      // Flag must be cleared after the failure so the server is not permanently
      // locked out. getDbInstance() should not throw now.
      expect(() => subject.getDbInstance()).not.toThrow();
    });
  });
});
