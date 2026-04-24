#!/usr/bin/env node
'use strict';

// Drill into the two top offenders: stream_chunks.chunk_data and tasks.error_output.
const path = require('path');
const os = require('os');
const HOME = path.join(os.homedir(), '.torque');
const DB = path.join(HOME, 'tasks.db');
const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));
const db = new Database(DB, { readonly: true, fileMustExist: true });

function bytes(n) {
  if (!n) return '0B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)}${u[i]}`;
}

console.log('=== tasks.error_output — top 20 bloated tasks ===');
const t1 = db.prepare(`
  SELECT id, status, provider, LENGTH(error_output) AS elen,
         LENGTH(output) AS olen, created_at, completed_at
  FROM tasks
  WHERE error_output IS NOT NULL
  ORDER BY LENGTH(error_output) DESC
  LIMIT 20
`).all();
for (const r of t1) {
  console.log(`  ${r.id}  err=${bytes(r.elen).padStart(8)} out=${bytes(r.olen || 0).padStart(8)}  status=${r.status}  provider=${r.provider}  ${r.created_at}`);
}

console.log('\n=== tasks.error_output — size distribution ===');
const dist = db.prepare(`
  SELECT
    SUM(CASE WHEN LENGTH(error_output) <       1024 THEN 1 ELSE 0 END) AS "<1KB",
    SUM(CASE WHEN LENGTH(error_output) BETWEEN 1024 AND   10239 THEN 1 ELSE 0 END) AS "1-10KB",
    SUM(CASE WHEN LENGTH(error_output) BETWEEN 10240 AND  102399 THEN 1 ELSE 0 END) AS "10-100KB",
    SUM(CASE WHEN LENGTH(error_output) BETWEEN 102400 AND 1048575 THEN 1 ELSE 0 END) AS "100KB-1MB",
    SUM(CASE WHEN LENGTH(error_output) >= 1048576 THEN 1 ELSE 0 END) AS ">=1MB",
    COUNT(*) AS total, SUM(LENGTH(error_output)) AS total_bytes
  FROM tasks WHERE error_output IS NOT NULL
`).get();
console.log(`  total rows with error_output: ${dist.total}, total bytes: ${bytes(dist.total_bytes)}`);
console.log(`  <1KB=${dist['<1KB']}  1-10KB=${dist['1-10KB']}  10-100KB=${dist['10-100KB']}  100KB-1MB=${dist['100KB-1MB']}  >=1MB=${dist['>=1MB']}`);

console.log('\n=== tasks.error_output by status ===');
for (const row of db.prepare(`
  SELECT status, COUNT(*) AS c, SUM(LENGTH(error_output)) AS b, MAX(LENGTH(error_output)) AS mx
  FROM tasks WHERE error_output IS NOT NULL GROUP BY status ORDER BY b DESC
`).all()) {
  console.log(`  ${String(row.status).padEnd(16)} count=${String(row.c).padStart(6)}  total=${bytes(row.b).padStart(8)}  max_row=${bytes(row.mx)}`);
}

console.log('\n=== stream_chunks — per-stream_id totals, top 20 ===');
const s1 = db.prepare(`
  SELECT stream_id, COUNT(*) AS chunks, SUM(LENGTH(chunk_data)) AS bytes,
         MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
  FROM stream_chunks
  GROUP BY stream_id
  ORDER BY bytes DESC
  LIMIT 20
`).all();
for (const r of s1) {
  console.log(`  ${r.stream_id}  chunks=${String(r.chunks).padStart(7)}  ${bytes(r.bytes).padStart(8)}  ${r.first_ts} → ${r.last_ts}`);
}

console.log('\n=== stream_chunks — age buckets ===');
for (const row of db.prepare(`
  SELECT
    CASE
      WHEN timestamp < date('now', '-21 days') THEN 'age>21d'
      WHEN timestamp < date('now', '-14 days') THEN 'age 14-21d'
      WHEN timestamp < date('now',  '-7 days') THEN 'age 7-14d'
      WHEN timestamp < date('now',  '-1 days') THEN 'age 1-7d'
      ELSE 'age<1d'
    END AS bucket,
    COUNT(*) AS c, SUM(LENGTH(chunk_data)) AS b
  FROM stream_chunks GROUP BY bucket ORDER BY bucket
`).all()) {
  console.log(`  ${row.bucket.padEnd(14)} chunks=${String(row.c).padStart(7)}  bytes=${bytes(row.b)}`);
}

// Orphan detection: streams whose task is gone
console.log('\n=== stream_chunks orphans (stream_id not in task_streams or tasks) ===');
try {
  const orphans = db.prepare(`
    SELECT COUNT(*) AS c, SUM(LENGTH(sc.chunk_data)) AS b
    FROM stream_chunks sc
    LEFT JOIN task_streams ts ON ts.id = sc.stream_id OR ts.stream_id = sc.stream_id
    WHERE ts.rowid IS NULL
  `).get();
  console.log(`  orphan chunks: ${orphans.c}  bytes: ${bytes(orphans.b || 0)}`);
} catch (e) {
  console.log(`  orphan check skipped: ${e.message}`);
}

// Check task_streams schema briefly
console.log('\n=== task_streams schema ===');
for (const c of db.prepare(`PRAGMA table_info(task_streams)`).all()) {
  console.log(`  ${c.name}: ${c.type}`);
}

// Check stream_chunks schema
console.log('\n=== stream_chunks schema ===');
for (const c of db.prepare(`PRAGMA table_info(stream_chunks)`).all()) {
  console.log(`  ${c.name}: ${c.type}`);
}

db.close();
