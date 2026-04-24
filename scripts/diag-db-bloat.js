#!/usr/bin/env node
'use strict';

// Read-only DB size/bloat profiler.
// Reports:
//   1. Per-table row counts + total payload (via LENGTH() sum per column for top tables)
//   2. Top columns by total byte weight
//   3. Oldest row in the biggest tables (to find stale retention candidates)

const path = require('path');
const os = require('os');

const HOME = path.join(os.homedir(), '.torque');
const DB = path.join(HOME, 'tasks.db');

const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));
const db = new Database(DB, { readonly: true, fileMustExist: true });

function bytes(n) {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

// Page-level stats (does NOT need dbstat — freelist count is from the header)
const pageSize = db.pragma('page_size', { simple: true });
const pageCount = db.pragma('page_count', { simple: true });
const freelist = db.pragma('freelist_count', { simple: true });

console.log(`DB file:  ${DB}`);
console.log(`Pages:    ${pageCount} × ${pageSize}B = ${bytes(pageCount * pageSize)}`);
console.log(`Freelist: ${freelist} pages (${bytes(freelist * pageSize)} reclaimable via VACUUM)`);
console.log();

// Row counts per table
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);

console.log(`${tables.length} tables. Row counts:`);
const rowCounts = [];
for (const t of tables) {
  try {
    const c = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
    rowCounts.push({ table: t, rows: c });
  } catch (e) {
    rowCounts.push({ table: t, rows: -1, error: e.message });
  }
}
rowCounts.sort((a, b) => b.rows - a.rows);
for (const { table, rows, error } of rowCounts.slice(0, 25)) {
  console.log(`  ${String(rows).padStart(10)}  ${table}${error ? `  (err: ${error})` : ''}`);
}

// Byte weight per (table, column) — for top 10 tables by row count
const hotTables = rowCounts.filter(r => r.rows > 100).slice(0, 10);

console.log(`\nTop columns by total byte weight (top-10 tables, > 100 rows):`);
const colWeights = [];
for (const { table } of hotTables) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
  for (const c of cols) {
    if (!['TEXT', 'BLOB'].includes(String(c.type).toUpperCase().split('(')[0])) continue;
    try {
      const totalLen = db.prepare(`SELECT COALESCE(SUM(LENGTH("${c.name}")), 0) AS tot FROM "${table}"`).get().tot;
      if (totalLen > 1024 * 1024) { // only report >1 MB
        colWeights.push({ table, column: c.name, total: totalLen });
      }
    } catch { /* skip */ }
  }
}
colWeights.sort((a, b) => b.total - a.total);
for (const { table, column, total } of colWeights.slice(0, 30)) {
  console.log(`  ${bytes(total).padStart(10)}  ${table}.${column}`);
}

// For tables with a created_at / updated_at, show oldest and newest
console.log(`\nAge window for hot tables:`);
for (const { table, rows } of hotTables) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
  const tsCol = ['created_at', 'created', 'timestamp', 'inserted_at', 'started_at'].find(c => cols.includes(c));
  if (!tsCol) continue;
  try {
    const { oldest, newest } = db.prepare(
      `SELECT MIN("${tsCol}") AS oldest, MAX("${tsCol}") AS newest FROM "${table}"`
    ).get();
    console.log(`  ${table.padEnd(30)} rows=${String(rows).padStart(8)}  ${tsCol}: ${oldest} → ${newest}`);
  } catch { /* skip */ }
}

db.close();
