'use strict';
const Database = require('better-sqlite3');

function makeDb({ hasThresholdConfig = true } = {}) {
  const db = new Database(':memory:');
  const cols = [
    'id INTEGER PRIMARY KEY',
    'provider TEXT',
    'budget_usd REAL',
    'threshold_pct REAL',
    'notify_only INTEGER DEFAULT 0',
  ];
  if (hasThresholdConfig) {
    cols.push('threshold_config TEXT');
  }
  db.exec('CREATE TABLE IF NOT EXISTS cost_budgets (' + cols.join(', ') + ')');
  return db;
}

test('hasThresholdConfigColumn PRAGMA runs exactly once for 100 calls (cache hit, column present)', () => {
  // When the column IS present, result is true and we cache it — 100 calls → 1 PRAGMA
  const db = makeDb({ hasThresholdConfig: true });
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
  const db1 = makeDb({ hasThresholdConfig: true });
  const db2 = makeDb({ hasThresholdConfig: true });
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
  // second call on db2 should be cached (column present → true cached)
  pragmaCount = 0;
  bw.hasThresholdConfigColumn(db2);
  expect(pragmaCount).toBe(0);
});

test('false result is not cached — allows DDL to add the column and be detected', () => {
  // This is the key invariant: when column is absent, we don't cache false,
  // so a subsequent ALTER TABLE + re-check will succeed.
  const db = makeDb({ hasThresholdConfig: false });
  const bw = require('../db/budget-watcher');
  expect(bw.hasThresholdConfigColumn(db)).toBe(false); // column absent
  db.exec('ALTER TABLE cost_budgets ADD COLUMN threshold_config TEXT');
  expect(bw.hasThresholdConfigColumn(db)).toBe(true); // now detects column
  // Subsequent calls are cached
  let pragmaCount = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql && sql.includes('PRAGMA table_info')) pragmaCount++;
    return origPrepare(sql);
  };
  bw.hasThresholdConfigColumn(db);
  expect(pragmaCount).toBe(0); // true result is cached
});
