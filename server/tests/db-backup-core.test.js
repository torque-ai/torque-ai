'use strict';
/* global describe, it, expect, afterEach, vi */

const path = require('path');
const crypto = require('crypto');
const { installMock } = require('./cjs-mock');

const SUBJECT_MODULE = '../db/backup-core';
const SQLITE_MODULE = 'better-sqlite3';
const FS_MODULE = 'fs';
const OS_MODULE = 'os';
const LOGGER_MODULE = '../logger';
const MIGRATIONS_MODULE = '../db/migrations';
const SCHEMA_MODULE = '../db/schema';
const DATA_DIR_MODULE = '../data-dir';

const subjectPath = require.resolve(SUBJECT_MODULE);
const sqlitePath = require.resolve(SQLITE_MODULE);
const fsPath = require.resolve(FS_MODULE);
const osPath = require.resolve(OS_MODULE);
const loggerPath = require.resolve(LOGGER_MODULE);
const migrationsPath = require.resolve(MIGRATIONS_MODULE);
const schemaPath = require.resolve(SCHEMA_MODULE);
const dataDirPath = require.resolve(DATA_DIR_MODULE);

function clearModuleCaches() {
  delete require.cache[subjectPath];
  delete require.cache[sqlitePath];
  delete require.cache[fsPath];
  delete require.cache[osPath];
  delete require.cache[loggerPath];
  delete require.cache[migrationsPath];
  delete require.cache[schemaPath];
  delete require.cache[dataDirPath];
}

function createDataDirMock(dataDir = 'C:\\mock-home\\.torque') {
  return {
    getDataDir: vi.fn(() => dataDir),
    setDataDir: vi.fn(),
  };
}

function createFsMock(overrides = {}) {
  return {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    statSync: vi.fn(() => ({
      size: 123,
      mtime: new Date('2026-03-01T00:00:00.000Z'),
    })),
    readdirSync: vi.fn(() => []),
    realpathSync: vi.fn((fullPath) => fullPath),
    unlinkSync: vi.fn(),
    ...overrides,
  };
}

function createLoggerMock() {
  const childLogger = {
    info: vi.fn(),
    warn: vi.fn(),
  };

  return {
    exports: {
      child: vi.fn(() => childLogger),
    },
    childLogger,
  };
}

function createDbHandle(overrides = {}) {
  return {
    serialize: vi.fn(() => Buffer.from('serialized-db')),
    close: vi.fn(),
    pragma: vi.fn(() => []),
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ name: 'tasks' })) })),
    backup: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function createStreamingReadMock(buffer) {
  let offset = 0;

  return {
    openSync: vi.fn(() => 17),
    readSync: vi.fn((_fd, target, targetOffset, length) => {
      if (offset >= buffer.length) return 0;
      const end = Math.min(offset + length, buffer.length);
      const bytesRead = buffer.copy(target, targetOffset, offset, end);
      offset += bytesRead;
      return bytesRead;
    }),
    closeSync: vi.fn(),
  };
}

function mockBackupIntegrity(fs, backupPath, backupBuffer, expectedHash = sha256(backupBuffer)) {
  const hashPath = backupPath + '.sha256';
  fs.existsSync.mockImplementation((fullPath) => fullPath === backupPath || fullPath === hashPath);
  fs.readFileSync.mockImplementation((fullPath) => {
    if (fullPath === hashPath) return expectedHash;
    if (fullPath === backupPath) return backupBuffer;
    throw new Error(`Unexpected readFileSync path: ${fullPath}`);
  });
}

function createRestoredDbHandle(options = {}) {
  const integrityResult = Object.prototype.hasOwnProperty.call(options, 'integrityResult')
    ? options.integrityResult
    : [{ integrity_check: 'ok' }];
  const foreignKeyResult = Object.prototype.hasOwnProperty.call(options, 'foreignKeyResult')
    ? options.foreignKeyResult
    : [];
  const tableRow = Object.prototype.hasOwnProperty.call(options, 'tableRow')
    ? options.tableRow
    : { name: 'tasks' };
  const tasksStatement = {
    get: vi.fn(() => tableRow),
  };

  const db = createDbHandle({
    pragma: vi.fn((statement) => {
      if (statement === 'integrity_check') {
        return integrityResult;
      }
      if (statement === 'foreign_key_check') {
        return foreignKeyResult;
      }
      return [];
    }),
    prepare: vi.fn(() => tasksStatement),
    ...options.overrides,
  });

  db.__tasksStatement = tasksStatement;
  return db;
}

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
  const os = options.os || {
    homedir: vi.fn(() => 'C:\\mock-home'),
    tmpdir: vi.fn(() => 'C:\\mock-tmp'),
  };
  const loggerMock = createLoggerMock();
  const runMigrations = options.runMigrations || vi.fn();
  const applySchema = options.applySchema || vi.fn();
  const Database = options.Database || createDatabaseMock(options.databaseInstances || []);
  const dataDirMock = options.dataDirMock || createDataDirMock();

  clearModuleCaches();
  installMock(SQLITE_MODULE, Database);
  installMock(FS_MODULE, fs);
  installMock(OS_MODULE, os);
  installMock(LOGGER_MODULE, loggerMock.exports);
  installMock(MIGRATIONS_MODULE, { runMigrations });
  installMock(SCHEMA_MODULE, { applySchema });
  installMock(DATA_DIR_MODULE, dataDirMock);

  return {
    subject: require(SUBJECT_MODULE),
    fs,
    os,
    Database,
    runMigrations,
    applySchema,
    logger: loggerMock.exports,
    backupLogger: loggerMock.childLogger,
    dataDirMock,
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

describe('db/backup-core', () => {
  it('throws when backing up before the database is initialized', () => {
    const { subject } = loadSubject();

    expect(() => subject.backupDatabase(path.join('C:\\tmp', 'backup.db'))).toThrow('Database not initialized');
  });

  it('creates a backup file and parent directory when needed', () => {
    const { subject, fs } = loadSubject();
    const buffer = Buffer.from('backup-bytes');
    const db = createDbHandle({
      serialize: vi.fn(() => buffer),
    });
    const destPath = path.join('C:\\tmp', 'nested', 'torque.db');

    subject.setDb(db);
    fs.existsSync.mockReturnValue(false);
    fs.statSync.mockReturnValue({
      size: buffer.length,
      mtime: new Date('2026-03-02T00:00:00.000Z'),
    });

    const result = subject.backupDatabase(destPath);

    expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(destPath), { recursive: true });
    expect(db.serialize).toHaveBeenCalledOnce();
    expect(fs.writeFileSync).toHaveBeenCalledWith(destPath, buffer);
    expect(fs.writeFileSync).toHaveBeenCalledWith(destPath + '.sha256', sha256(buffer), 'utf-8');
    expect(result.path).toBe(destPath);
    expect(result.size).toBe(buffer.length);
    expect(new Date(result.created_at).toISOString()).toBe(result.created_at);
  });

  it('backs up live sqlite handles with VACUUM INTO instead of serializing into memory', () => {
    const backupPath = path.join('C:\\tmp', 'owner\'s-live-backup.db');
    const backupBytes = Buffer.from('vacuum-backup-bytes');
    const fs = createFsMock({
      existsSync: vi.fn(() => false),
      statSync: vi.fn(() => ({
        size: 100001,
        mtime: new Date('2026-03-02T00:00:00.000Z'),
      })),
      ...createStreamingReadMock(backupBytes),
    });
    const { subject } = loadSubject({ fs });
    const db = createDbHandle({
      exec: vi.fn(),
      serialize: vi.fn(() => {
        throw new Error('serialize should not run for live sqlite backup');
      }),
    });

    subject.setDb(db);

    const result = subject.backupDatabase(backupPath);

    expect(db.exec).toHaveBeenCalledWith("VACUUM INTO 'C:\\tmp\\owner''s-live-backup.db'");
    expect(db.serialize).not.toHaveBeenCalled();
    expect(fs.openSync).toHaveBeenCalledWith(backupPath, 'r');
    expect(fs.writeFileSync).toHaveBeenCalledWith(backupPath + '.sha256', sha256(backupBytes), 'utf-8');
    expect(result).toMatchObject({
      path: backupPath,
      size: 100001,
    });
  });

  it('backs up explicit sqlite handles with VACUUM INTO instead of serializing into memory', () => {
    const backupPath = path.join('C:\\tmp', 'pre-startup.db');
    const backupBytes = Buffer.from('pre-startup-vacuum-backup');
    const fs = createFsMock({
      statSync: vi.fn(() => ({ size: backupBytes.length })),
      ...createStreamingReadMock(backupBytes),
    });
    const { subject } = loadSubject({ fs });
    const db = createDbHandle({
      exec: vi.fn(),
      serialize: vi.fn(() => {
        throw new Error('serialize should not run for explicit sqlite backup');
      }),
    });

    const size = subject.writeDatabaseHandleBackupWithHash(db, backupPath);

    expect(db.exec).toHaveBeenCalledWith("VACUUM INTO 'C:\\tmp\\pre-startup.db'");
    expect(db.serialize).not.toHaveBeenCalled();
    expect(fs.openSync).toHaveBeenCalledWith(backupPath, 'r');
    expect(fs.writeFileSync).toHaveBeenCalledWith(backupPath + '.sha256', sha256(backupBytes), 'utf-8');
    expect(size).toBe(backupBytes.length);
  });

  it('does not recreate the destination directory when it already exists', () => {
    const { subject, fs } = loadSubject();
    const db = createDbHandle();

    subject.setDb(db);
    fs.existsSync.mockReturnValue(true);

    subject.backupDatabase(path.join('C:\\tmp', 'existing', 'backup.db'));

    expect(fs.mkdirSync).not.toHaveBeenCalled();
    // Two writes: the .db file and the .sha256 integrity file
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('replaces an existing backup scheduler timer and clears it on stop', () => {
    const { subject } = loadSubject();
    const timerA = { id: 'timer-a' };
    const timerB = { id: 'timer-b' };
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      .mockImplementationOnce(() => timerA)
      .mockImplementationOnce(() => timerB);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    setCommonInternals(subject);

    subject.startBackupScheduler(1000);
    subject.startBackupScheduler(2000);
    subject.stopBackupScheduler();

    expect(setIntervalSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 1000);
    expect(setIntervalSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 2000);
    expect(clearIntervalSpy).toHaveBeenNthCalledWith(1, timerA);
    expect(clearIntervalSpy).toHaveBeenNthCalledWith(2, timerB);
  });

  it('creates scheduled backups and removes files beyond the retention limit', () => {
    const backupRoot = path.join('C:\\data-root');
    const backupDir = path.join(backupRoot, 'backups');
    const { subject, fs, backupLogger } = loadSubject({
      dataDirMock: createDataDirMock(backupRoot),
    });
    const buffer = Buffer.alloc(100001, 'x');
    const db = createDbHandle({
      serialize: vi.fn(() => buffer),
    });
    let intervalCallback;

    process.env.TORQUE_DATA_DIR = backupRoot;
    subject.setDb(db);
    setCommonInternals(subject, {
      getConfig: vi.fn((key) => (key === 'backup_max_count' ? '2' : null)),
    });

    vi.spyOn(globalThis, 'setInterval').mockImplementation((fn) => {
      intervalCallback = fn;
      return { id: 'timer' };
    });
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    fs.readdirSync.mockReturnValue([
      'torque-2026-01-03T12-00-00-000Z.db',
      'torque-2026-01-02T12-00-00-000Z.db',
      'torque-2026-01-01T12-00-00-000Z.db',
    ]);

    subject.startBackupScheduler(500);
    intervalCallback();

    expect(fs.mkdirSync).toHaveBeenCalledWith(backupDir, { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/torque-.*\.db$/);
    expect(fs.writeFileSync.mock.calls[0][0].startsWith(backupDir)).toBe(true);
    expect(fs.writeFileSync.mock.calls[0][1]).toBe(buffer);
    expect(fs.writeFileSync.mock.calls[1]).toEqual([
      fs.writeFileSync.mock.calls[0][0] + '.sha256',
      sha256(buffer),
      'utf-8',
    ]);
    expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(backupDir, 'torque-2026-01-01T12-00-00-000Z.db'));
    expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(backupDir, 'torque-2026-01-01T12-00-00-000Z.db.sha256'));
    expect(backupLogger.info).toHaveBeenCalledWith(expect.stringContaining('Database backed up to'));
    expect(backupLogger.info).toHaveBeenCalledWith('[backup] Removed old backup: torque-2026-01-01T12-00-00-000Z.db');
  });

  it('skips scheduled backups when the database is closed', () => {
    const { subject, fs } = loadSubject();
    const db = createDbHandle();
    let intervalCallback;

    subject.setDb(db);
    setCommonInternals(subject, {
      isDbClosed: vi.fn(() => true),
    });

    vi.spyOn(globalThis, 'setInterval').mockImplementation((fn) => {
      intervalCallback = fn;
      return { id: 'timer' };
    });
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    subject.startBackupScheduler(750);
    intervalCallback();

    expect(db.serialize).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('logs scheduler failures instead of throwing', () => {
    const { subject, fs, backupLogger } = loadSubject();
    const largeBuffer = Buffer.alloc(100001, 'x');
    const db = createDbHandle({
      serialize: vi.fn(() => largeBuffer),
    });
    let intervalCallback;

    subject.setDb(db);
    setCommonInternals(subject);
    fs.writeFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });

    vi.spyOn(globalThis, 'setInterval').mockImplementation((fn) => {
      intervalCallback = fn;
      return { id: 'timer' };
    });
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    subject.startBackupScheduler(250);
    expect(() => intervalCallback()).not.toThrow();
    expect(backupLogger.warn).toHaveBeenCalledWith('[backup] Backup failed: disk full');
  });

  it('uses VACUUM INTO for pre-shutdown backups without serializing the database', () => {
    const backupRoot = path.join('C:\\data-root');
    const backupDir = path.join(backupRoot, 'backups');
    const backupBytes = Buffer.from('pre-shutdown-vacuum-backup');
    const fs = createFsMock({
      statSync: vi.fn(() => ({
        size: 100001,
        mtime: new Date('2026-03-02T00:00:00.000Z'),
      })),
      ...createStreamingReadMock(backupBytes),
    });
    const { subject, backupLogger } = loadSubject({
      fs,
      dataDirMock: createDataDirMock(backupRoot),
    });
    const db = createDbHandle({
      exec: vi.fn(),
      serialize: vi.fn(() => {
        throw new Error('serialize should not run for pre-shutdown backup');
      }),
    });

    subject.setDb(db);
    setCommonInternals(subject);

    const result = subject.takePreShutdownBackup();
    const backupPath = db.exec.mock.calls[0][0].match(/VACUUM INTO '(.+)'/)[1];

    expect(backupPath.startsWith(backupDir.replace(/'/g, "''"))).toBe(true);
    expect(db.serialize).not.toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringMatching(/torque-pre-shutdown-.*\.db\.sha256$/), sha256(backupBytes), 'utf-8');
    expect(backupLogger.info).toHaveBeenCalledWith(expect.stringContaining('Pre-shutdown backup saved'));
    expect(result.size).toBe(100001);
  });

  it('rejects restore requests without explicit confirmation', async () => {
    const { subject } = loadSubject();

    await expect(subject.restoreDatabase('C:\\backups\\restore.db', false))
      .rejects
      .toThrow('Restore requires confirm: true flag to prevent accidental data loss');
  });

  it('rejects restore requests for missing backup files', async () => {
    const { subject, fs } = loadSubject();

    fs.existsSync.mockReturnValue(false);

    await expect(subject.restoreDatabase('C:\\backups\\missing.db', true))
      .rejects
      .toThrow('Backup file not found: C:\\backups\\missing.db');
  });

  it('rejects restore requests when the live database is not initialized', async () => {
    const { subject, fs } = loadSubject();

    fs.existsSync.mockReturnValue(true);

    await expect(subject.restoreDatabase('C:\\backups\\restore.db', true, { force: true }))
      .rejects
      .toThrow('Database not initialized');
  });

  describe('backup integrity', () => {
    it('creates SHA-256 hash file alongside backup', () => {
      const { subject, fs } = loadSubject();
      const backupBuffer = Buffer.from('integrity-backup-bytes');
      const backupPath = path.join('C:\\tmp', 'integrity.db');
      const db = createDbHandle({
        serialize: vi.fn(() => backupBuffer),
      });

      subject.setDb(db);
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({
        size: backupBuffer.length,
        mtime: new Date('2026-03-02T00:00:00.000Z'),
      });

      subject.backupDatabase(backupPath);

      expect(fs.writeFileSync).toHaveBeenCalledWith(backupPath, backupBuffer);
      expect(fs.writeFileSync).toHaveBeenCalledWith(backupPath + '.sha256', sha256(backupBuffer), 'utf-8');
    });

    it('rejects restore of tampered backup', async () => {
      const backupPath = 'C:\\backups\\tampered.db';
      const originalBuffer = Buffer.from('original-backup');
      const tamperedBuffer = Buffer.from('tampered-backup');
      const { subject, fs, Database } = loadSubject();

      subject.setDb(createDbHandle());
      setCommonInternals(subject);
      mockBackupIntegrity(fs, backupPath, tamperedBuffer, sha256(originalBuffer));

      await expect(subject.restoreDatabase(backupPath, true))
        .rejects
        .toThrow('Backup integrity check failed');

      expect(Database).not.toHaveBeenCalled();
    });

    it('allows restore with valid hash', async () => {
      const backupPath = 'C:\\backups\\valid-hash.db';
      const livePath = 'C:\\data\\torque.db';
      const backupBuffer = Buffer.from('valid-backup');
      const liveDb = createDbHandle();
      const backupDb = createDbHandle({
        backup: vi.fn(() => Promise.resolve()),
      });
      const restoredDb = createRestoredDbHandle();
      const Database = createDatabaseMock([backupDb, restoredDb]);
      const { subject, fs } = loadSubject({ Database });
      const internals = setCommonInternals(subject, {
        getDbPath: vi.fn(() => livePath),
      });

      subject.setDb(liveDb);
      mockBackupIntegrity(fs, backupPath, backupBuffer);

      const result = await subject.restoreDatabase(backupPath, true);

      expect(fs.readFileSync).toHaveBeenCalledWith(backupPath + '.sha256', 'utf-8');
      expect(fs.readFileSync).toHaveBeenCalledWith(backupPath);
      expect(backupDb.backup).toHaveBeenCalledWith(livePath);
      expect(internals.setDbRef).toHaveBeenCalledWith(restoredDb);
      expect(result.restored_from).toBe(backupPath);
      expect(result.integrity_check).toBe('ok');
    });

    it('allows force restore without hash', async () => {
      const backupPath = 'C:\\backups\\missing-hash.db';
      const livePath = 'C:\\data\\torque.db';
      const liveDb = createDbHandle();
      const backupDb = createDbHandle({
        backup: vi.fn(() => Promise.resolve()),
      });
      const restoredDb = createRestoredDbHandle();
      const Database = createDatabaseMock([backupDb, restoredDb]);
      const { subject, fs } = loadSubject({ Database });

      subject.setDb(liveDb);
      setCommonInternals(subject, {
        getDbPath: vi.fn(() => livePath),
      });
      fs.existsSync.mockImplementation((fullPath) => fullPath === backupPath);

      const result = await subject.restoreDatabase(backupPath, true, { force: true });

      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(backupDb.backup).toHaveBeenCalledWith(livePath);
      expect(result.restored_from).toBe(backupPath);
    });
  });

  it('restores a backup, reopens the live database, and reapplies schema setup', async () => {
    const backupPath = 'C:\\backups\\restore.db';
    const livePath = 'C:\\data\\torque.db';
    const liveDb = createDbHandle();
    const backupDb = createDbHandle({
      backup: vi.fn(() => Promise.resolve()),
    });
    const restoredDb = createRestoredDbHandle();
    const Database = createDatabaseMock([backupDb, restoredDb]);
    const { subject, fs, applySchema, runMigrations } = loadSubject({ Database });
    const internals = setCommonInternals(subject, {
      getDbPath: vi.fn(() => livePath),
      getDataDir: vi.fn(() => 'C:\\data'),
    });

    subject.setDb(liveDb);
    fs.existsSync.mockReturnValue(true);

    const result = await subject.restoreDatabase(backupPath, true, { force: true });

    expect(Database).toHaveBeenNthCalledWith(1, backupPath, { readonly: true });
    expect(Database).toHaveBeenNthCalledWith(2, livePath);
    expect(liveDb.close).toHaveBeenCalledOnce();
    expect(backupDb.backup).toHaveBeenCalledWith(livePath);
    expect(backupDb.close).toHaveBeenCalledOnce();
    expect(restoredDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
    expect(restoredDb.pragma).toHaveBeenCalledWith('busy_timeout = 5000');
    expect(restoredDb.pragma).toHaveBeenCalledWith('foreign_keys = ON');
    expect(restoredDb.prepare).toHaveBeenCalledWith("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'");
    expect(internals.setDbRef).toHaveBeenCalledWith(restoredDb);
    expect(internals.injectDbAll).toHaveBeenCalledOnce();
    expect(applySchema).toHaveBeenCalledWith(restoredDb, {
      safeAddColumn: internals.safeAddColumn,
      getConfig: internals.getConfig,
      setConfig: internals.setConfig,
      setConfigDefault: internals.setConfigDefault,
      DATA_DIR: 'C:\\data',
    });
    expect(runMigrations).toHaveBeenCalledWith(restoredDb);
    expect(result.restored_from).toBe(backupPath);
    expect(result.integrity_check).toBe('ok');
    expect(result.foreign_key_check).toBe('ok');
    expect(new Date(result.restored_at).toISOString()).toBe(result.restored_at);
  });

  it('fails restore when the restored database does not pass integrity_check', async () => {
    const backupDb = createDbHandle({
      backup: vi.fn(() => Promise.resolve()),
    });
    const restoredDb = createRestoredDbHandle({
      integrityResult: [
        { integrity_check: 'row 7 missing from index foo' },
        { integrity_check: 'malformed page 3' },
      ],
    });
    const Database = createDatabaseMock([backupDb, restoredDb]);
    const { subject, fs, applySchema, runMigrations } = loadSubject({ Database });
    const liveDb = createDbHandle();
    const internals = setCommonInternals(subject);

    subject.setDb(liveDb);
    fs.existsSync.mockReturnValue(true);

    await expect(subject.restoreDatabase('C:\\backups\\broken.db', true, { force: true }))
      .rejects
      .toThrow('Restored database failed integrity check: row 7 missing from index foo; malformed page 3');

    expect(internals.setDbRef).not.toHaveBeenCalled();
    expect(applySchema).not.toHaveBeenCalled();
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it('fails restore when the restored database has foreign key violations', async () => {
    const backupDb = createDbHandle({
      backup: vi.fn(() => Promise.resolve()),
    });
    const restoredDb = createRestoredDbHandle({
      foreignKeyResult: [
        { table: 'projects', rowid: 9, parent: 'users' },
        { table: 'tasks', rowid: 10, parent: 'projects' },
      ],
    });
    const Database = createDatabaseMock([backupDb, restoredDb]);
    const { subject, fs, applySchema } = loadSubject({ Database });

    subject.setDb(createDbHandle());
    setCommonInternals(subject);
    fs.existsSync.mockReturnValue(true);

    await expect(subject.restoreDatabase('C:\\backups\\fk.db', true, { force: true }))
      .rejects
      .toThrow('Restored database has 2 foreign key violation(s): table=projects, rowid=9, parent=users; table=tasks, rowid=10, parent=projects');

    expect(applySchema).not.toHaveBeenCalled();
  });

  it('fails restore when the tasks table is missing after reopening the database', async () => {
    const backupDb = createDbHandle({
      backup: vi.fn(() => Promise.resolve()),
    });
    const restoredDb = createRestoredDbHandle({
      tableRow: undefined,
    });
    const Database = createDatabaseMock([backupDb, restoredDb]);
    const { subject, fs, applySchema, runMigrations } = loadSubject({ Database });

    subject.setDb(createDbHandle());
    setCommonInternals(subject);
    fs.existsSync.mockReturnValue(true);

    await expect(subject.restoreDatabase('C:\\backups\\missing-tasks.db', true, { force: true }))
      .rejects
      .toThrow('Restored database is invalid — missing tasks table');

    expect(applySchema).not.toHaveBeenCalled();
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it('returns an empty list when the backup directory does not exist', () => {
    const { subject, fs, dataDirMock } = loadSubject();
    const defaultDir = path.join('C:\\mock-home', '.torque', 'backups');

    delete process.env.TORQUE_DATA_DIR;
    fs.existsSync.mockReturnValue(false);

    expect(subject.listBackups()).toEqual([]);
    expect(dataDirMock.getDataDir).toHaveBeenCalled();
    expect(fs.existsSync).toHaveBeenCalledWith(defaultDir);
  });

  it('lists only database backups and sorts them newest-first', () => {
    const { subject, fs } = loadSubject();
    const backupDir = path.join('C:\\mock-home', '.torque', 'backups');
    const statsByPath = new Map([
      [path.join(backupDir, 'old.db'), { size: 10, mtime: new Date('2026-01-01T00:00:00.000Z') }],
      [path.join(backupDir, 'mid.sqlite'), { size: 20, mtime: new Date('2026-02-01T00:00:00.000Z') }],
      [path.join(backupDir, 'new.db'), { size: 30, mtime: new Date('2026-03-01T00:00:00.000Z') }],
    ]);

    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['old.db', 'ignore.txt', 'mid.sqlite', 'new.db']);
    fs.statSync.mockImplementation((fullPath) => statsByPath.get(fullPath));

    const backups = subject.listBackups(backupDir);

    expect(backups).toEqual([
      {
        name: 'new.db',
        path: path.join(backupDir, 'new.db'),
        size: 30,
        created_at: '2026-03-01T00:00:00.000Z',
      },
      {
        name: 'mid.sqlite',
        path: path.join(backupDir, 'mid.sqlite'),
        size: 20,
        created_at: '2026-02-01T00:00:00.000Z',
      },
      {
        name: 'old.db',
        path: path.join(backupDir, 'old.db'),
        size: 10,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('does not delete anything during cleanup when the keep count already covers all backups', () => {
    const { subject, fs } = loadSubject();
    const backupDir = path.join('C:\\mock-home', '.torque', 'backups');
    const statsByPath = new Map([
      [path.join(backupDir, 'one.db'), { size: 1, mtime: new Date('2025-01-01T00:00:00.000Z') }],
      [path.join(backupDir, 'two.db'), { size: 2, mtime: new Date('2025-01-02T00:00:00.000Z') }],
    ]);

    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['one.db', 'two.db']);
    fs.statSync.mockImplementation((fullPath) => statsByPath.get(fullPath));

    const deleted = subject.cleanupOldBackups({ dir: backupDir, keepCount: 2, maxAgeDays: 1 });

    expect(deleted).toEqual([]);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('cleans up only old backups beyond the retention count and ignores unlink failures', () => {
    const { subject, fs } = loadSubject();
    const backupDir = path.join('C:\\mock-home', '.torque', 'backups');
    const oldOne = path.join(backupDir, 'old-1.db');
    const oldTwo = path.join(backupDir, 'old-2.db');
    const statsByPath = new Map([
      [path.join(backupDir, 'new-1.db'), { size: 1, mtime: new Date('2026-03-10T00:00:00.000Z') }],
      [path.join(backupDir, 'new-2.db'), { size: 2, mtime: new Date('2026-03-09T00:00:00.000Z') }],
      [oldOne, { size: 3, mtime: new Date('2025-12-15T00:00:00.000Z') }],
      [oldTwo, { size: 4, mtime: new Date('2025-11-01T00:00:00.000Z') }],
    ]);

    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-11T00:00:00.000Z'));
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['new-1.db', 'new-2.db', 'old-1.db', 'old-2.db']);
    fs.statSync.mockImplementation((fullPath) => statsByPath.get(fullPath));
    fs.unlinkSync.mockImplementation((fullPath) => {
      if (fullPath === oldTwo) {
        throw new Error('file locked');
      }
    });

    const deleted = subject.cleanupOldBackups({ dir: backupDir, keepCount: 2, maxAgeDays: 30 });

    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
    expect(fs.unlinkSync).toHaveBeenNthCalledWith(1, oldOne);
    expect(fs.unlinkSync).toHaveBeenNthCalledWith(2, oldTwo);
    expect(deleted).toEqual([oldOne]);
  });

  it('prunes generated backups by category and removes sidecars', () => {
    const { subject, fs } = loadSubject();
    const backupDir = path.join('C:\\mock-home', '.torque', 'backups');
    const oldShutdown = path.join(backupDir, 'torque-pre-shutdown-2026-01-01T00-00-00-000Z.db');
    const midShutdown = path.join(backupDir, 'torque-pre-shutdown-2026-01-02T00-00-00-000Z.db');
    const keepShutdown = path.join(backupDir, 'torque-pre-shutdown-2026-01-03T00-00-00-000Z.db');
    const statsByPath = new Map([
      [oldShutdown, { size: 10, mtime: new Date('2026-01-01T00:00:00.000Z') }],
      [midShutdown, { size: 10, mtime: new Date('2026-01-02T00:00:00.000Z') }],
      [keepShutdown, { size: 10, mtime: new Date('2026-01-03T00:00:00.000Z') }],
    ]);

    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue([
      path.basename(oldShutdown),
      path.basename(midShutdown),
      path.basename(keepShutdown),
    ]);
    fs.statSync.mockImplementation((fullPath) => statsByPath.get(fullPath));

    const deleted = subject.pruneManagedBackups({
      dir: backupDir,
      preShutdownKeep: 1,
      preStartupKeep: 5,
      periodicKeep: 5,
      totalMaxBytes: 1024 * 1024,
    });

    expect(deleted).toEqual([oldShutdown, midShutdown]);
    expect(fs.unlinkSync).toHaveBeenCalledWith(oldShutdown);
    expect(fs.unlinkSync).toHaveBeenCalledWith(oldShutdown + '.sha256');
    expect(fs.unlinkSync).toHaveBeenCalledWith(oldShutdown + '-journal');
    expect(fs.unlinkSync).toHaveBeenCalledWith(midShutdown);
    expect(fs.unlinkSync).toHaveBeenCalledWith(midShutdown + '.sha256');
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(keepShutdown);
  });

  it('reserves space for the next backup before enforcing the total cap', () => {
    const { subject, fs } = loadSubject();
    const backupDir = path.join('C:\\mock-home', '.torque', 'backups');
    const periodic = path.join(backupDir, 'torque-2026-01-01T00-00-00-000Z.db');
    const shutdown = path.join(backupDir, 'torque-pre-shutdown-2026-01-02T00-00-00-000Z.db');
    const startup = path.join(backupDir, 'torque-pre-startup-2026-01-03T00-00-00-000Z.db');
    const protectedProvider = path.join(backupDir, 'torque-pre-provider-removal-2026-01-01T00-00-00-000Z.db');
    const manual = path.join(backupDir, 'manual.db');
    const statsByPath = new Map([
      [periodic, { size: 45, mtime: new Date('2026-01-01T00:00:00.000Z') }],
      [shutdown, { size: 45, mtime: new Date('2026-01-02T00:00:00.000Z') }],
      [startup, { size: 45, mtime: new Date('2026-01-03T00:00:00.000Z') }],
      [protectedProvider, { size: 500, mtime: new Date('2026-01-01T00:00:00.000Z') }],
      [manual, { size: 500, mtime: new Date('2026-01-01T00:00:00.000Z') }],
    ]);

    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue([
      path.basename(periodic),
      path.basename(shutdown),
      path.basename(startup),
      path.basename(protectedProvider),
      path.basename(manual),
    ]);
    fs.statSync.mockImplementation((fullPath) => statsByPath.get(fullPath));

    const deleted = subject.pruneManagedBackups({
      dir: backupDir,
      reserveBytes: 45,
      totalMaxBytes: 135,
      preShutdownKeep: 5,
      preStartupKeep: 5,
      periodicKeep: 5,
    });

    expect(deleted).toEqual([periodic]);
    expect(fs.unlinkSync).toHaveBeenCalledWith(periodic);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(shutdown);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(startup);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(protectedProvider);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(manual);
  });

  it('leaves protected and manual backups alone even when the cap is low', () => {
    const { subject, fs } = loadSubject();
    const backupDir = path.join('C:\\mock-home', '.torque', 'backups');
    const protectedProvider = path.join(backupDir, 'torque-pre-provider-removal-2026-01-01T00-00-00-000Z.db');
    const manual = path.join(backupDir, 'manual.db');
    const statsByPath = new Map([
      [protectedProvider, { size: 500, mtime: new Date('2026-01-01T00:00:00.000Z') }],
      [manual, { size: 500, mtime: new Date('2026-01-01T00:00:00.000Z') }],
    ]);

    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue([path.basename(protectedProvider), path.basename(manual)]);
    fs.statSync.mockImplementation((fullPath) => statsByPath.get(fullPath));

    const deleted = subject.pruneManagedBackups({
      dir: backupDir,
      reserveBytes: 100,
      totalMaxBytes: 1,
    });

    expect(deleted).toEqual([]);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});
