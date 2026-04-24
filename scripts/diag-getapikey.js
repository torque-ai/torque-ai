#!/usr/bin/env node
'use strict';

// Reproduce handleListProviders' API-key check path offline.
// This DOES NOT touch the running server; it opens a separate better-sqlite3
// handle against the active DB, wires config.js with the database facade,
// and calls getApiKey for each cloud provider.

const path = require('path');
const os = require('os');
process.env.TORQUE_DATA_DIR = process.env.TORQUE_DATA_DIR || path.join(os.homedir(), '.torque');

const SERVER = path.join(__dirname, '..', 'server');
const db = require(path.join(SERVER, 'database'));
const serverConfig = require(path.join(SERVER, 'config'));

console.log(`[probe] db.getProvider is ${typeof db.getProvider}`);
console.log(`[probe] db.prepare     is ${typeof db.prepare}`);
console.log(`[probe] db.init        is ${typeof db.init}`);

// The live server calls db.init() which cascades setDb() to all sub-modules
// (including provider-routing-core). Without this, db.getProvider() returns null.
db.init();
serverConfig.init({ db });

const providers = ['groq', 'cerebras', 'google-ai', 'ollama-cloud', 'openrouter', 'anthropic', 'deepinfra', 'hyperbolic'];
for (const p of providers) {
  const k = serverConfig.getApiKey(p);
  console.log(`  getApiKey(${p.padEnd(13)}) = ${k ? `len=${k.length}` : 'null'}`);
}

// Bonus: also call db.getProvider directly to confirm the row round-trip
console.log('\n[probe] db.getProvider() direct calls:');
for (const p of providers) {
  try {
    const row = db.getProvider(p);
    const hasKey = !!(row && row.api_key_encrypted);
    console.log(`  ${p.padEnd(13)} row=${row ? 'yes' : 'no '} encrypted=${hasKey ? `len=${String(row.api_key_encrypted).length}` : 'no'}`);
  } catch (e) {
    console.log(`  ${p.padEnd(13)} THREW ${e.message}`);
  }
}
