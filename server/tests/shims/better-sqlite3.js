'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const originalEmitWarning = process.emitWarning;
process.emitWarning = function patchedEmitWarning(warning, type, ...rest) {
  const warningText = typeof warning === 'string'
    ? warning
    : (warning && warning.message) || '';
  const warningType = typeof warning === 'object' && warning && warning.name
    ? warning.name
    : type;
  if (warningType === 'ExperimentalWarning' && /SQLite is an experimental feature/i.test(warningText)) {
    return;
  }
  return originalEmitWarning.call(this, warning, type, ...rest);
};
const { DatabaseSync, backup } = require('node:sqlite');
process.emitWarning = originalEmitWarning;

const TMP_ROOT = path.join(os.tmpdir(), 'torque-better-sqlite3-shim');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function uniqueTempPath(ext = '.db') {
  ensureDir(TMP_ROOT);
  return path.join(
    TMP_ROOT,
    `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`
  );
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

function cleanupFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore cleanup failures for temp files
  }
}

function normalizeDatabaseSource(source) {
  if (Buffer.isBuffer(source)) {
    const tempPath = uniqueTempPath();
    fs.writeFileSync(tempPath, source);
    return {
      filename: tempPath,
      temporaryPath: tempPath,
    };
  }

  if (source == null) {
    return { filename: ':memory:' };
  }

  return { filename: source };
}

function normalizeBindValue(value) {
  if (value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeBindValue);
  }

  if (
    value
    && typeof value === 'object'
    && !Buffer.isBuffer(value)
    && !(value instanceof Date)
    && Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, normalizeBindValue(entryValue)])
    );
  }

  return value;
}

function wrapStatement(statement) {
  const wrapper = {
    all: (...args) => statement.all(...args.map(normalizeBindValue)),
    get: (...args) => statement.get(...args.map(normalizeBindValue)),
    run: (...args) => statement.run(...args.map(normalizeBindValue)),
    iterate: (...args) => statement.iterate(...args.map(normalizeBindValue)),
    columns: (...args) => statement.columns(...args),
    setAllowBareNamedParameters: (...args) => {
      statement.setAllowBareNamedParameters(...args);
      return wrapper;
    },
    setAllowUnknownNamedParameters: (...args) => {
      statement.setAllowUnknownNamedParameters(...args);
      return wrapper;
    },
    setReadBigInts: (...args) => {
      statement.setReadBigInts(...args);
      return wrapper;
    },
    setReturnArrays: (...args) => {
      statement.setReturnArrays(...args);
      return wrapper;
    },
  };
  return wrapper;
}

class BetterSqlite3Shim {
  constructor(source, options = {}) {
    const normalized = normalizeDatabaseSource(source);
    this.file = normalized.filename;
    this._temporaryPath = normalized.temporaryPath || null;
    this._transactionDepth = 0;
    this._db = new DatabaseSync(this.file, {
      open: options.open !== false,
      readOnly: !!options.readonly || !!options.readOnly,
    });
  }

  prepare(sql) {
    return wrapStatement(this._db.prepare(sql));
  }

  exec(sql) {
    return this._db.exec(sql);
  }

  pragma(statement) {
    return this._db.prepare(`PRAGMA ${statement}`).all();
  }

  transaction(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('Transaction expects a function');
    }

    const execute = (...args) => {
      const nested = this._transactionDepth > 0;
      const savepointName = nested ? `torque_tx_${this._transactionDepth}` : null;
      const beginSql = nested ? `SAVEPOINT ${savepointName}` : 'BEGIN';
      const commitSql = nested ? `RELEASE SAVEPOINT ${savepointName}` : 'COMMIT';
      const rollbackSql = nested ? `ROLLBACK TO SAVEPOINT ${savepointName}` : 'ROLLBACK';

      this.exec(beginSql);
      this._transactionDepth += 1;

      try {
        const result = fn(...args);
        this.exec(commitSql);
        return result;
      } catch (error) {
        try {
          this.exec(rollbackSql);
        } finally {
          if (nested) {
            try {
              this.exec(`RELEASE SAVEPOINT ${savepointName}`);
            } catch {
              // ignore cleanup failures after rollback
            }
          }
        }
        throw error;
      } finally {
        this._transactionDepth = Math.max(0, this._transactionDepth - 1);
      }
    };

    execute.deferred = execute;
    execute.immediate = execute;
    execute.exclusive = execute;
    return execute;
  }

  serialize() {
    const tempPath = uniqueTempPath();
    cleanupFile(tempPath);
    this.exec(`VACUUM main INTO '${escapeSqlString(tempPath)}'`);
    try {
      return fs.readFileSync(tempPath);
    } finally {
      cleanupFile(tempPath);
    }
  }

  async backup(destination) {
    await backup(this._db, destination);
    return destination;
  }

  function(name, options, fn) {
    if (typeof options === 'function') {
      this._db.function(name, options);
      return this;
    }
    this._db.function(name, options || {}, fn);
    return this;
  }

  aggregate(name, options) {
    this._db.aggregate(name, options);
    return this;
  }

  loadExtension(...args) {
    return this._db.loadExtension(...args);
  }

  enableLoadExtension(...args) {
    return this._db.enableLoadExtension(...args);
  }

  location(...args) {
    return this._db.location(...args);
  }

  close() {
    try {
      this._db.close();
    } finally {
      cleanupFile(this._temporaryPath);
      this._temporaryPath = null;
    }
  }
}

module.exports = BetterSqlite3Shim;
module.exports.default = BetterSqlite3Shim;
