/**
 * Centralized data directory resolution for TORQUE.
 *
 * Every module that needs the data directory (database, logger, backups,
 * credential storage, snapshots) imports from here instead of resolving
 * independently.  This eliminates the historical fragmentation where each
 * module had its own fallback path.
 *
 * Resolution order:
 *   1. TORQUE_DATA_DIR environment variable (explicit override)
 *   2. ~/.torque  (user home, safe from Codex sandbox overwrites)
 *   3. Server directory (__dirname)  (legacy fallback)
 *   4. os.tmpdir()/torque  (last resort when home is read-only)
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME_DATA_DIR = path.join(os.homedir(), '.torque');
const LEGACY_DATA_DIR = path.join(__dirname);

function ensureWritableDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir() {
  const envDir = process.env.TORQUE_DATA_DIR;
  const candidates = [
    envDir,
    HOME_DATA_DIR,
    LEGACY_DATA_DIR,
    path.join(os.tmpdir(), 'torque'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (ensureWritableDir(dir)) {
      const source = dir === envDir ? 'TORQUE_DATA_DIR'
        : dir === HOME_DATA_DIR ? 'default (~/.torque)'
        : dir === LEGACY_DATA_DIR ? 'legacy (server dir)'
        : 'tmpdir fallback';
      console.log(`[data-dir] Resolved: ${dir} (via ${source})`);
      return dir;
    }
  }

  console.log(`[data-dir] WARNING: No writable candidate found, using HOME_DATA_DIR: ${HOME_DATA_DIR}`);
  return HOME_DATA_DIR;
}

let _dataDir = null;

/** @returns {string} Resolved data directory path */
function getDataDir() {
  if (!_dataDir) _dataDir = resolveDataDir();
  return _dataDir;
}

/** Override the data directory (for tests). */
function setDataDir(dir) {
  _dataDir = dir || null;
}

module.exports = { getDataDir, setDataDir, HOME_DATA_DIR, LEGACY_DATA_DIR, DEFAULT_DATA_DIR: HOME_DATA_DIR };
