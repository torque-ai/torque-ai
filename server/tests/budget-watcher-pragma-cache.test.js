'use strict';
const Database = require('better-sqlite3');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE IF NOT EXISTS cost_budgets (' +
    '  id INTEGER PRIMARY KEY,' +
    '  provider TEXT,' +
    '  budget_usd REAL,' +
    '  threshold_pct REAL,' +
    '  notify_only INTEGER DEFAULT 0' +
    ')'
  );
  return db;
}

test('hasThresholdConfigColumn PRAGMA runs exactly once for 100 calls (cache hit)', () => {
  const db = makeDb();
  let pragmaCount = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql && sql.includes('PRAGMA table_info')) pragmaCount++;
    return origPrepare(sql);
  };
  const bw = require('../db/budget-watcher');
  for (let i = 0; i < 100; i++) bw.hasThresholdConfigColumn(db);
  expect(pragmaCount).toBe(1);
});

test('a fresh db instance gets its own cache entry (effectively clears on new db)', () => {
  const db1 = makeDb();
  const db2 = makeDb();
  const bw = require('../db/budget-watcher');
  bw.hasThresholdConfigColumn(db1); // populate cache for db1
  let pragmaCount = 0;
  const origPrepare = db2.prepare.bind(db2);
  db2.prepare = (sql) => {
    if (sql && sql.includes('PRAGMA table_info')) pragmaCount++;
    return origPrepare(sql);
  };
  bw.hasThresholdConfigColumn(db2); // should run PRAGMA once for db2
  expect(pragmaCount).toBe(1);
  // second call on db2 should be cached
  pragmaCount = 0;
  bw.hasThresholdConfigColumn(db2);
  expect(pragmaCount).toBe(0);
});
