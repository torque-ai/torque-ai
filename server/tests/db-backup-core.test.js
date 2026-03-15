'use strict';
/* global describe, it, expect, afterEach, vi */

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
    statSync: vi.fn(() => ({
      size: 123,
      mtime: new Date('2026-03-01T00:00:00.000Z'),
    })),
    readdirSync: vi.fn(() => []),
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
  };
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
    os,
    Database,
    runMigrations,
    applySchema,
    logger: loggerMock.exports,
    backupLogger: loggerMock.childLogger,
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
    expect(result.path).toBe(destPath);
    expect(result.size).toBe(buffer.length);
    expect(new Date(result.created_at).toISOString()).toBe(result.created_at);
  });

  it('does not recreate the destination directory when it already exists', () => {
    const { subject, fs } = loadSubject();
    const db = createDbHandle();

    subject.setDb(db);
    fs.existsSync.mockReturnValue(true);

    subject.backupDatabase(path.join('C:\\tmp', 'existing', 'backup.db'));

    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
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
    const { subject, fs, backupLogger } = loadSubject();
    const buffer = Buffer.from('scheduler-bytes');
    const db = createDbHandle({
      serialize: vi.fn(() => buffer),
    });
    const backupRoot = path.join('C:\\data-root');
    const backupDir = path.join(backupRoot, 'backups');
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
      'torque-2026-01-03.db',
      'torque-2026-01-02.db',
      'torque-2026-01-01.db',
    ]);

    subject.startBackupScheduler(500);
    intervalCallback();

    expect(fs.mkdirSync).toHaveBeenCalledWith(backupDir, { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/torque-.*\.db$/);
    expect(fs.writeFileSync.mock.calls[0][0].startsWith(backupDir)).toBe(true);
    expect(fs.writeFileSync.mock.calls[0][1]).toBe(buffer);
    expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(backupDir, 'torque-2026-01-01.db'));
    expect(backupLogger.info).toHaveBeenCalledWith(expect.stringContaining('Database backed up to'));
    expect(backupLogger.info).toHaveBeenCalledWith('[backup] Removed old backup: torque-2026-01-01.db');
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
    const db = createDbHandle();
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

    await expect(subject.restoreDatabase('C:\\backups\\restore.db', true))
      .rejects
      .toThrow('Database not initialized');
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

    const result = await subject.restoreDatabase(backupPath, true);

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

    await expect(subject.restoreDatabase('C:\\backups\\broken.db', true))
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

    await expect(subject.restoreDatabase('C:\\backups\\fk.db', true))
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

    await expect(subject.restoreDatabase('C:\\backups\\missing-tasks.db', true))
      .rejects
      .toThrow('Restored database is invalid — missing tasks table');

    expect(applySchema).not.toHaveBeenCalled();
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it('returns an empty list when the backup directory does not exist', () => {
    const { subject, fs, os } = loadSubject();
    const defaultDir = path.join('C:\\mock-home', '.torque', 'backups');

    delete process.env.TORQUE_DATA_DIR;
    fs.existsSync.mockReturnValue(false);

    expect(subject.listBackups()).toEqual([]);
    expect(os.homedir).toHaveBeenCalledOnce();
    expect(fs.existsSync).toHaveBeenCalledWith(defaultDir);
  });

  it('lists only database backups and sorts them newest-first', () => {
    const { subject, fs } = loadSubject();
    const backupDir = path.join('C:\\data', 'backups');
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
    const backupDir = path.join('C:\\data', 'backups');
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
    const backupDir = path.join('C:\\data', 'backups');
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
});
