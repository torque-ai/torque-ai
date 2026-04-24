#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const HOME = path.join(os.homedir(), '.torque');
const DB = path.join(HOME, 'tasks.db');
const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));
const db = new Database(DB, { readonly: true, fileMustExist: true });

console.log('=== maintenance_schedule contents ===');
try {
  for (const row of db.prepare('SELECT * FROM maintenance_schedule').all()) {
    console.log(`  ${row.task_type.padEnd(25)} last_run=${row.last_run_at || 'never'}  next_run=${row.next_run_at || 'n/a'}`);
  }
} catch (e) { console.log(`  err=${e.message}`); }

console.log('\n=== oldest rows still present ===');
for (const [table, col] of [
  ['tasks', 'created_at'],
  ['stream_chunks', 'timestamp'],
  ['task_streams', 'created_at'],
  ['task_events', 'created_at'],
  ['analytics', 'timestamp'],
  ['factory_decisions', 'created_at'],
  ['coordination_events', 'created_at'],
]) {
  try {
    const row = db.prepare(`SELECT MIN("${col}") AS oldest FROM "${table}"`).get();
    console.log(`  ${table.padEnd(22)}.${col.padEnd(12)} oldest = ${row.oldest}`);
  } catch (e) { console.log(`  ${table}: ${e.message}`); }
}

console.log('\n=== tasks with error_output — oldest & newest by status ===');
for (const row of db.prepare(`
  SELECT status, COUNT(*) AS c, MIN(created_at) AS oldest, MAX(created_at) AS newest
  FROM tasks WHERE error_output IS NOT NULL GROUP BY status
`).all()) {
  console.log(`  ${String(row.status).padEnd(12)} count=${row.c}  oldest=${row.oldest}  newest=${row.newest}`);
}

console.log('\n=== factory_decisions age vs row count ===');
try {
  for (const row of db.prepare(`
    SELECT
      CASE
        WHEN created_at < datetime('now', '-21 days') THEN 'age>21d'
        WHEN created_at < datetime('now', '-14 days') THEN 'age 14-21d'
        WHEN created_at < datetime('now',  '-7 days') THEN 'age 7-14d'
        ELSE 'age<7d'
      END AS bucket,
      COUNT(*) AS c
    FROM factory_decisions GROUP BY bucket ORDER BY bucket
  `).all()) {
    console.log(`  ${row.bucket.padEnd(14)} count=${row.c}`);
  }
} catch (e) { console.log(`  err=${e.message}`); }

// Estimate how much space we'd reclaim with aggressive settings
console.log('\n=== projected reclamation under tighter retention ===');
for (const days of [3, 7, 14]) {
  const result = db.prepare(`
    SELECT SUM(LENGTH(error_output) + LENGTH(COALESCE(output,''))) AS bytes
    FROM tasks
    WHERE created_at < datetime('now', ?)
      AND status IN ('completed','failed','cancelled')
      AND (error_output IS NOT NULL OR output IS NOT NULL)
  `).get(`-${days} days`);
  const mb = (result.bytes || 0) / 1024 / 1024;
  console.log(`  purgeOldTaskOutput @ retention=${days}d would clear ${mb.toFixed(0)} MB`);
}
for (const days of [3, 7, 14]) {
  const result = db.prepare(`
    SELECT SUM(LENGTH(chunk_data)) AS bytes
    FROM stream_chunks
    WHERE stream_id IN (SELECT id FROM task_streams WHERE created_at < datetime('now', ?))
  `).get(`-${days} days`);
  const mb = (result.bytes || 0) / 1024 / 1024;
  console.log(`  cleanupStreamData @ retention=${days}d would clear ${mb.toFixed(0)} MB of chunks`);
}

db.close();
