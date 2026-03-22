'use strict';

/**
 * Database backup/restore operations
 * Extracted from database.js (Phase 5.2 / D1.1)
 */
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('../logger').child({ component: 'backup-core' });
const { runMigrations } = require('./migrations');

let _db = null;
let _backupTimer = null;
let _restoreInProgress = false;

// Injected dependencies from database.js
let _getConfig = null;
let _setConfig = null;
let _setConfigDefault = null;
let _safeAddColumn = null;
let _injectDbAll = null;
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
function setInternals({ getConfig, setConfig, setConfigDefault, safeAddColumn, injectDbAll, getDbPath, getDataDir, setDbRef, isDbClosed }) {
  _getConfig = getConfig;
  _setConfig = setConfig;
  _setConfigDefault = setConfigDefault;
  _safeAddColumn = safeAddColumn;
  _injectDbAll = injectDbAll;
  _getDbPath = getDbPath;
  _getDataDir = getDataDir;
  _setDb = setDbRef;
  _isDbClosed = isDbClosed;
}

function backupDatabase(destPath) {
  if (!_db) throw new Error('Database not initialized');

  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const buffer = _db.serialize();
  fs.writeFileSync(destPath, buffer);

  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  fs.writeFileSync(destPath + '.sha256', hash, 'utf-8');

  const stats = fs.statSync(destPath);
  return {
    path: destPath,
    size: stats.size,
    created_at: new Date().toISOString(),
  };
}

function startBackupScheduler(intervalMs = 3600000) {
  stopBackupScheduler();

  const maxBackups = parseInt((_getConfig && _getConfig('backup_max_count')) || '24', 10);
  const backupDir = path.join(process.env.TORQUE_DATA_DIR || '.', 'backups');

  _backupTimer = setInterval(() => {
    try {
      if (!_db || (_isDbClosed && _isDbClosed())) return;

      fs.mkdirSync(backupDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `torque-${timestamp}.db`);

      const buffer = _db.serialize();
      fs.writeFileSync(backupPath, buffer);

      logger.info(`[backup] Database backed up to ${backupPath} (${buffer.length} bytes)`);

      const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('torque-') && f.endsWith('.db'))
        .sort()
        .reverse();

      for (let i = maxBackups; i < files.length; i++) {
        fs.unlinkSync(path.join(backupDir, files[i]));
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
    const crypto = require('crypto');
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
    _injectDbAll();

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

function listBackups(dir) {
  if (!dir) {
    dir = path.join(process.env.TORQUE_DATA_DIR || path.join(os.homedir(), '.torque'), 'backups');
  }
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
  const dir = options.dir || path.join(process.env.TORQUE_DATA_DIR || path.join(os.homedir(), '.torque'), 'backups');
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
function createBackupCore({ db: dbInstance, internals }) {
  setDb(dbInstance);
  if (internals) {
    setInternals(internals);
  }
  return {
    getDbInstance,
    backupDatabase,
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
  startBackupScheduler,
  stopBackupScheduler,
  restoreDatabase,
  listBackups,
  cleanupOldBackups,
};
