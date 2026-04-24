#!/usr/bin/env node
'use strict';

// Read-only API key backup: dumps provider_config rows (including encrypted key blobs)
// from both active and legacy TORQUE databases and copies secret.key files.
// Uses the same better-sqlite3 lib TORQUE uses, read-only mode — no write risk.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR = path.join(os.homedir(), '.torque');
const LEGACY_DIR = path.join(__dirname, '..', 'server');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(HOME_DIR, 'backups', `api-keys-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

let Database;
try {
  Database = require(path.join(LEGACY_DIR, 'node_modules', 'better-sqlite3'));
} catch {
  Database = require('better-sqlite3');
}

function dumpProviderConfig(dbPath, label) {
  if (!fs.existsSync(dbPath)) {
    console.log(`[${label}] skip — ${dbPath} does not exist`);
    return null;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const hasTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_config'"
    ).get();
    if (!hasTable) {
      console.log(`[${label}] no provider_config table in ${dbPath}`);
      return null;
    }
    const rows = db.prepare('SELECT * FROM provider_config').all();
    return rows;
  } finally {
    db.close();
  }
}

function copyIfExists(src, destName) {
  if (!fs.existsSync(src)) {
    console.log(`[secret] skip — ${src} does not exist`);
    return false;
  }
  fs.copyFileSync(src, path.join(backupDir, destName));
  return true;
}

// Active DB (~/.torque/tasks.db)
const activeRows = dumpProviderConfig(path.join(HOME_DIR, 'tasks.db'), 'active');
if (activeRows) {
  fs.writeFileSync(
    path.join(backupDir, 'active-provider-config.json'),
    JSON.stringify(activeRows, null, 2)
  );
  console.log(`[active] dumped ${activeRows.length} rows → active-provider-config.json`);
}

// Legacy DB (server/tasks.db)
const legacyRows = dumpProviderConfig(path.join(LEGACY_DIR, 'tasks.db'), 'legacy');
if (legacyRows) {
  fs.writeFileSync(
    path.join(backupDir, 'legacy-provider-config.json'),
    JSON.stringify(legacyRows, null, 2)
  );
  console.log(`[legacy] dumped ${legacyRows.length} rows → legacy-provider-config.json`);
}

// secret.key files (needed to decrypt the blobs later)
copyIfExists(path.join(HOME_DIR, 'secret.key'), 'active-secret.key');
copyIfExists(path.join(LEGACY_DIR, 'secret.key'), 'legacy-secret.key');

console.log(`\nBackup dir: ${backupDir}`);

// Summary so we can confirm non-empty encrypted blobs are present
function summarize(rows, label) {
  if (!rows) return;
  console.log(`\n[${label}] provider_config summary:`);
  for (const r of rows) {
    const hasKey = !!(r.api_key_encrypted && String(r.api_key_encrypted).length > 0);
    const keyLen = hasKey ? String(r.api_key_encrypted).length : 0;
    console.log(`  - ${r.provider.padEnd(18)} enabled=${r.enabled} key=${hasKey ? 'YES' : 'NO '} (len=${keyLen}) model=${r.default_model || '-'}`);
  }
}
summarize(activeRows, 'active');
summarize(legacyRows, 'legacy');
