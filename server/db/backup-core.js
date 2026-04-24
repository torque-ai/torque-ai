'use strict';

/**
 * Database backup/restore operations
 * Extracted from database.js (Phase 5.2 / D1.1)
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('../logger').child({ component: 'backup-core' });
const { getDataDir } = require('../data-dir');
const { runMigrations } = require('./migrations');

let _db = null;
let _backupTimer = null;
let _restoreInProgress = false;

// Injected dependencies from database.js
let _getConfig = null;
let _setConfig = null;
let _setConfigDefault = null;
let _safeAddColumn = null;
let _wireAllModules = null;
let _getDbPath = null;
let _getDataDir = null;
let _setDb = null;         // callback to update database.js's `db` reference
let _isDbClosed = null;

function setDb(dbInstance) {
  _db = dbInstance;
}

/**
 * Returns the current live database handle.
 * Throws a clear error if a restore is in progress (DB is closed mid-swap),
 * so callers get a meaningful message instead of a crash on a closed handle.
 */
function getDbInstance() {
  if (_restoreInProgress) {
    throw new Error('Database restore in progress, try again');
  }
  return _db;
}

/**
 * Wire dependencies that live in database.js.
 * Called once during init.
 */
function setInternals({ getConfig, setConfig, setConfigDefault, safeAddColumn, injectDbAll, wireAllModules, getDbPath, getDataDir, setDbRef, isDbClosed }) {
  _getConfig = getConfig;
  _setConfig = setConfig;
  _setConfigDefault = setConfigDefault;
  _safeAddColumn = safeAddColumn;
  _wireAllModules = wireAllModules || injectDbAll;
  _getDbPath = getDbPath;
  _getDataDir = getDataDir;
  _setDb = setDbRef;
  _isDbClosed = isDbClosed;
}

function writeBackupFileWithHash(backupPath, buffer) {
  fs.writeFileSync(backupPath, buffer);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  fs.writeFileSync(backupPath + '.sha256', hash, 'utf-8');
  return hash;
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function removeBackupTargets(backupPath) {
  for (const target of [backupPath, backupPath + '.sha256']) {
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch {
      // Best effort: VACUUM INTO will fail clearly if the target remains.
    }
  }
}

function hashFileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, 'r');

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest('hex');
}

function writeBackupHashFile(backupPath) {
  const hash = hashFileSync(backupPath);
  fs.writeFileSync(backupPath + '.sha256', hash, 'utf-8');
  return hash;
}

function writeDatabaseHandleBackupWithHash(dbHandle, backupPath) {
  if (!dbHandle) {
    throw new Error('Database not initialized');
  }

  if (typeof dbHandle.exec === 'function') {
    removeBackupTargets(backupPath);
    dbHandle.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
    writeBackupHashFile(backupPath);
    return fs.statSync(backupPath).size;
  }

  if (typeof dbHandle.serialize !== 'function') {
    throw new Error('Database handle does not support backup');
  }

  const buffer = dbHandle.serialize();
  writeBackupFileWithHash(backupPath, buffer);
  return buffer.length;
}

function writeLiveDatabaseBackupWithHash(backupPath) {
  return writeDatabaseHandleBackupWithHash(_db, backupPath);
}

function backupDatabase(destPath) {
  if (!_db) throw new Error('Database not initialized');

  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const size = writeLiveDatabaseBackupWithHash(destPath);
  return {
    path: destPath,
    size,
    created_at: new Date().toISOString(),
  };
}

function startBackupScheduler(intervalMs = 3600000) {
  stopBackupScheduler();

  // Default max backups lowered from 24 → 6. On a mature install the DB can be
  // multi-GB; 24 × 3.7 GB observed 2026-04-24 = 89 GB of just periodic
  // backups on disk. Six hourly snapshots still gives ~6 hours of rollback
  // window while keeping disk footprint bounded. Override via
  // `backup_max_count` config.
  const maxBackups = parseInt((_getConfig && _getConfig('backup_max_count')) || '6', 10);
  const backupDir = path.join(getDataDir(), 'backups');

  _backupTimer = setInterval(() => {
    try {
      if (!_db || (_isDbClosed && _isDbClosed())) return;

      fs.mkdirSync(backupDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `torque-${timestamp}.db`);

      const size = writeLiveDatabaseBackupWithHash(backupPath);

      // Skip tiny backups — if the DB has less than 100KB of data, don't overwrite
      // good backups with empty ones (protects against backup-during-corruption)
      if (size < 100000) {
        try { fs.unlinkSync(backupPath); } catch {}
        try { fs.unlinkSync(backupPath + '.sha256'); } catch {}
        logger.info(`[backup] Skipping periodic backup — DB too small (${size} bytes)`);
        return;
      }

      logger.info(`[backup] Database backed up to ${backupPath} (${size} bytes)`);

      // Only prune periodic backups, NOT pre-shutdown/pre-startup/pre-provider
      // (each has its own retention path). Match both legacy `torque-backup-*`
      // and current `torque-YYYY-*` naming — an earlier pattern left behind
      // 23 unprunable `torque-backup-*` files when the naming changed.
      const PERIODIC_BACKUP_PATTERN = /^torque-(backup-)?\d{4}-\d{2}-\d{2}T/;
      const files = fs.readdirSync(backupDir)
        .filter(f => PERIODIC_BACKUP_PATTERN.test(f) && f.endsWith('.db')
          && !f.includes('pre-shutdown') && !f.includes('pre-startup')
          && !f.includes('pre-provider'))
        .sort()
        .reverse();

      for (let i = maxBackups; i < files.length; i++) {
        fs.unlinkSync(path.join(backupDir, files[i]));
        try { fs.unlinkSync(path.join(backupDir, files[i] + '.sha256')); } catch {}
        logger.info(`[backup] Removed old backup: ${files[i]}`);
      }
    } catch (err) {
      logger.warn(`[backup] Backup failed: ${err.message}`);
    }
  }, intervalMs);
}

function stopBackupScheduler() {
  if (_backupTimer) {
    clearInterval(_backupTimer);
    _backupTimer = null;
  }
}

async function restoreDatabase(srcPath, confirm, { force = false } = {}) {
  if (!confirm) throw new Error('Restore requires confirm: true flag to prevent accidental data loss');
  if (!fs.existsSync(srcPath)) throw new Error(`Backup file not found: ${srcPath}`);

  if (!force) {
    const hashPath = srcPath + '.sha256';
    if (!fs.existsSync(hashPath)) {
      throw new Error('Backup integrity file (.sha256) missing. Use force option to restore without verification.');
    }
    const expectedHash = fs.readFileSync(hashPath, 'utf-8').trim();
    const backupBuffer = fs.readFileSync(srcPath);
    const actualHash = crypto.createHash('sha256').update(backupBuffer).digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error('Backup integrity check failed — file may be corrupted or tampered.');
    }
  }
  if (!_db) throw new Error('Database not initialized');

  const livePath = _getDbPath();
  const backupDb = new Database(srcPath, { readonly: true });

  // Block any concurrent DB access from the moment the live DB is closed
  // until the new handle is fully open and wired. getDbInstance() checks this
  // flag and throws a clear error rather than returning a closed handle.
  _restoreInProgress = true;
  try {
    _db.close();
    await backupDb.backup(livePath);
    backupDb.close();

    // Reopen the live database with restored content
    const newDb = new Database(livePath);
    newDb.pragma('journal_mode = WAL');
    newDb.pragma('busy_timeout = 5000');
    newDb.pragma('foreign_keys = ON');

    // RB-155: Run integrity and foreign key checks
    const integrityResult = newDb.pragma('integrity_check');
    const integrityOk = integrityResult.length === 1 && integrityResult[0].integrity_check === 'ok';
    if (!integrityOk) {
      const details = integrityResult.map(r => r.integrity_check).join('; ');
      throw new Error(`Restored database failed integrity check: ${details}`);
    }

    const fkResult = newDb.pragma('foreign_key_check');
    if (fkResult.length > 0) {
      const violations = fkResult.slice(0, 5).map(r => `table=${r.table}, rowid=${r.rowid}, parent=${r.parent}`).join('; ');
      throw new Error(`Restored database has ${fkResult.length} foreign key violation(s): ${violations}`);
    }

    const tables = newDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (!tables) {
      throw new Error('Restored database is invalid — missing tasks table');
    }

    // Update the live db reference BEFORE schema reconciliation so getConfig/setConfig work
    _db = newDb;
    _setDb(newDb);
    _wireAllModules();

    // Reconcile schema: backup may be from older version
    const { applySchema } = require('./schema');
    applySchema(newDb, {
      safeAddColumn: _safeAddColumn,
      getConfig: _getConfig,
      setConfig: _setConfig,
      setConfigDefault: _setConfigDefault,
      DATA_DIR: _getDataDir(),
    });
    runMigrations(newDb);
  } finally {
    // Always clear the flag so the server is not permanently locked out
    // even if an integrity check or schema step throws.
    _restoreInProgress = false;
  }

  return {
    restored_from: srcPath,
    restored_at: new Date().toISOString(),
    integrity_check: 'ok',
    foreign_key_check: 'ok',
  };
}

function getBackupsDir() {
  return path.resolve(path.join(getDataDir(), 'backups'));
}

function isPathInsideDirectory(baseDir, targetDir) {
  const rel = path.relative(baseDir, targetDir);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function resolveManagedBackupsDir(dir) {
  const backupsDir = path.resolve(getBackupsDir());
  const resolved = path.resolve(dir || backupsDir);

  if (!isPathInsideDirectory(backupsDir, resolved)) {
    throw new Error(`Backup directory must resolve to a path inside the managed backups directory: ${backupsDir}`);
  }

  if (fs.existsSync(resolved)) {
    const realBackupsDir = fs.existsSync(backupsDir) ? fs.realpathSync(backupsDir) : backupsDir;
    const realResolved = fs.realpathSync(resolved);
    if (!isPathInsideDirectory(realBackupsDir, realResolved)) {
      throw new Error(`Backup directory must resolve to a path inside the managed backups directory: ${backupsDir}`);
    }
  }

  return resolved;
}

function listBackups(dir) {
  dir = resolveManagedBackupsDir(dir);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.db') || f.endsWith('.sqlite'))
    .map(f => {
      const fullPath = path.join(dir, f);
      const stats = fs.statSync(fullPath);
      return {
        name: f,
        path: fullPath,
        size: stats.size,
        created_at: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * RB-057: Remove old backups beyond retention limit.
 */
function cleanupOldBackups(options = {}) {
  const dir = options.dir || path.join(getDataDir(), 'backups');
  const keepCount = options.keepCount || 10;
  const maxAgeDays = options.maxAgeDays || 30;

  const backups = listBackups(dir);
  if (backups.length <= keepCount) return [];

  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const deleted = [];

  for (let i = keepCount; i < backups.length; i++) {
    const b = backups[i];
    if (new Date(b.created_at).getTime() < cutoff) {
      try {
        fs.unlinkSync(b.path);
        deleted.push(b.path);
      } catch { /* ignore cleanup errors */ }
    }
  }
  return deleted;
}

/**
 * Factory function for DI container.
 * @param {{ db: object, internals?: object }} deps
 */
/**
 * Take a pre-shutdown safety backup. Called during graceful shutdown
 * BEFORE the database is closed. Uses a dedicated prefix so these
 * are never pruned by the regular cleanup cycle.
 *
 * @returns {{ path: string, size: number } | null}
 */
function takePreShutdownBackup() {
  if (!_db || (_isDbClosed && _isDbClosed())) return null;

  try {
    const backupDir = path.join(getDataDir(), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `torque-pre-shutdown-${timestamp}.db`);

    const size = writeLiveDatabaseBackupWithHash(backupPath);

    // Only save if the DB has meaningful content (>100KB suggests real data)
    if (size < 100000) {
      try { fs.unlinkSync(backupPath); } catch {}
      try { fs.unlinkSync(backupPath + '.sha256'); } catch {}
      logger.info(`[backup] Skipping pre-shutdown backup — DB too small (${size} bytes), likely empty`);
      return null;
    }

    logger.info(`[backup] Pre-shutdown backup saved: ${backupPath} (${size} bytes)`);

    // Keep only the last 5 pre-shutdown backups
    const preShutdownFiles = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('torque-pre-shutdown-') && f.endsWith('.db'))
      .sort()
      .reverse();

    for (let i = 5; i < preShutdownFiles.length; i++) {
      try {
        fs.unlinkSync(path.join(backupDir, preShutdownFiles[i]));
        // Also remove the sha256 file
        try { fs.unlinkSync(path.join(backupDir, preShutdownFiles[i] + '.sha256')); } catch {}
      } catch {}
    }

    return { path: backupPath, size };
  } catch (err) {
    logger.warn(`[backup] Pre-shutdown backup failed: ${err.message}`);
    return null;
  }
}

function createBackupCore({ db: dbInstance, internals }) {
  setDb(dbInstance);
  if (internals) {
    setInternals(internals);
  }
  return {
    getDbInstance,
    backupDatabase,
    takePreShutdownBackup,
    startBackupScheduler,
    stopBackupScheduler,
    restoreDatabase,
    listBackups,
    cleanupOldBackups,
  };
}

module.exports = {
  setDb,
  getDbInstance,
  setInternals,
  createBackupCore,
  backupDatabase,
  takePreShutdownBackup,
  startBackupScheduler,
  stopBackupScheduler,
  restoreDatabase,
  listBackups,
  cleanupOldBackups,
  getBackupsDir,
  writeDatabaseHandleBackupWithHash,
};
