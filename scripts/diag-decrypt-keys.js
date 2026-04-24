#!/usr/bin/env node
'use strict';

// Read-only diagnostic: attempts to decrypt each provider's api_key_encrypted
// using the same crypto module TORQUE uses. Reports success/failure per provider
// without logging the plaintext.

const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.TORQUE_DATA_DIR = process.env.TORQUE_DATA_DIR || path.join(os.homedir(), '.torque');

const credentialCrypto = require(path.join(__dirname, '..', 'server', 'utils', 'credential-crypto'));
const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));

function test(dbPath, label) {
  if (!fs.existsSync(dbPath)) {
    console.log(`[${label}] skip — ${dbPath} missing`);
    return;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const rows = db.prepare(
    'SELECT provider, enabled, api_key_encrypted FROM provider_config WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != \'\''
  ).all();
  db.close();

  console.log(`\n[${label}] ${rows.length} providers with encrypted blobs:`);
  const key = credentialCrypto.getOrCreateKey();

  for (const row of rows) {
    const packed = row.api_key_encrypted;
    const parts = String(packed).split(':');
    const partInfo = `parts=${parts.length} lens=${parts.map(p => p.length).join('/')}`;

    if (parts.length !== 3) {
      console.log(`  ${row.provider.padEnd(16)} enabled=${row.enabled}  SHAPE-BAD  ${partInfo}`);
      continue;
    }

    try {
      const result = credentialCrypto.decrypt(parts[2], parts[0], parts[1], key);
      const plainLen = typeof result === 'string' ? result.length : JSON.stringify(result).length;
      console.log(`  ${row.provider.padEnd(16)} enabled=${row.enabled}  DECRYPT-OK plain_len=${plainLen}`);
    } catch (err) {
      console.log(`  ${row.provider.padEnd(16)} enabled=${row.enabled}  DECRYPT-FAIL ${err.code || err.message}  ${partInfo}`);
    }
  }
}

const HOME_DIR = path.join(os.homedir(), '.torque');
const LEGACY_DIR = path.join(__dirname, '..', 'server');

console.log(`[env] TORQUE_DATA_DIR=${process.env.TORQUE_DATA_DIR}`);
console.log(`[env] secret.key (active)  = ${fs.existsSync(path.join(HOME_DIR, 'secret.key')) ? 'present' : 'MISSING'}`);
console.log(`[env] secret.key (legacy)  = ${fs.existsSync(path.join(LEGACY_DIR, 'secret.key')) ? 'present' : 'MISSING'}`);

// Sanity: compare keys
try {
  const a = fs.readFileSync(path.join(HOME_DIR, 'secret.key'), 'utf8').trim();
  const b = fs.readFileSync(path.join(LEGACY_DIR, 'secret.key'), 'utf8').trim();
  console.log(`[env] secret.key match? ${a === b ? 'yes' : 'NO — different keys in ~/.torque vs server/'}`);
} catch (e) {
  console.log(`[env] secret.key compare error: ${e.message}`);
}

test(path.join(HOME_DIR, 'tasks.db'), 'active (~/.torque)');
test(path.join(LEGACY_DIR, 'tasks.db'), 'legacy (server/)');
