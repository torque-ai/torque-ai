#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const HOME = path.join(os.homedir(), '.torque');
const DB = path.join(HOME, 'tasks.db');
const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));
const db = new Database(DB, { readonly: true, fileMustExist: true });

console.log('=== retention-relevant config values ===');
const keys = [
  'cleanup_log_days',
  'auto_archive_days',
  'task_output_retention_days',
  'task_retention_count',
  'stale_running_minutes',
  'stale_queued_minutes',
];
for (const k of keys) {
  try {
    const row = db.prepare("SELECT value FROM config WHERE key = ?").get(k);
    console.log(`  ${k.padEnd(30)} ${row ? row.value : '(unset — uses default)'}`);
  } catch (e) {
    console.log(`  ${k.padEnd(30)} err=${e.message}`);
  }
}

// Look for maintenance-scheduler activity signals
console.log('\n=== maintenance scheduler table(s) ===');
const maintTables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%maintenance%'"
).all();
for (const { name } of maintTables) console.log(`  ${name}`);

// Any recent task_events that mention cleanup / purge / vacuum?
console.log('\n=== recent task_events mentioning cleanup/purge/vacuum ===');
try {
  const rows = db.prepare(`
    SELECT ts, event_type, task_id, SUBSTR(payload_json, 1, 120) AS payload_sample
    FROM task_events
    WHERE event_type LIKE '%cleanup%' OR event_type LIKE '%purge%'
       OR event_type LIKE '%vacuum%' OR event_type LIKE '%prune%'
       OR payload_json LIKE '%cleanupStreamData%' OR payload_json LIKE '%purgeOldTaskOutput%'
    ORDER BY ts DESC LIMIT 20
  `).all();
  if (!rows.length) console.log('  (none)');
  for (const r of rows) console.log(`  ${r.ts}  ${r.event_type}  ${r.payload_sample || ''}`);
} catch (e) {
  console.log(`  err=${e.message}`);
}

console.log('\n=== task_streams retention: age buckets ===');
try {
  for (const row of db.prepare(`
    SELECT
      CASE
        WHEN created_at < date('now', '-30 days') THEN 'age>30d'
        WHEN created_at < date('now', '-21 days') THEN 'age 21-30d'
        WHEN created_at < date('now', '-14 days') THEN 'age 14-21d'
        WHEN created_at < date('now',  '-7 days') THEN 'age 7-14d'
        ELSE 'age<7d'
      END AS bucket,
      COUNT(*) AS c
    FROM task_streams GROUP BY bucket ORDER BY bucket
  `).all()) {
    console.log(`  ${row.bucket.padEnd(14)} count=${row.c}`);
  }
} catch (e) { console.log(`  err=${e.message}`); }

console.log('\n=== tasks retention: age vs status ===');
try {
  for (const row of db.prepare(`
    SELECT
      CASE
        WHEN completed_at IS NULL THEN 'no_completed_at'
        WHEN completed_at < date('now', '-30 days') THEN 'age>30d'
        WHEN completed_at < date('now', '-14 days') THEN 'age 14-30d'
        WHEN completed_at < date('now',  '-7 days') THEN 'age 7-14d'
        ELSE 'age<7d'
      END AS bucket,
      status,
      COUNT(*) AS c,
      SUM(LENGTH(COALESCE(error_output,'')) + LENGTH(COALESCE(output,''))) AS out_bytes
    FROM tasks GROUP BY bucket, status ORDER BY bucket, status
  `).all()) {
    const mb = (row.out_bytes || 0) / 1024 / 1024;
    console.log(`  ${row.bucket.padEnd(15)} ${String(row.status).padEnd(12)} count=${String(row.c).padStart(5)}  out/err=${mb.toFixed(1)} MB`);
  }
} catch (e) { console.log(`  err=${e.message}`); }

db.close();
