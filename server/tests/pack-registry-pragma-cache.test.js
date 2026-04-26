'use strict';
const Database = require('better-sqlite3');

function makeDb() {
  const db = new Database(':memory:');
  const sql = 'CREATE TABLE IF NOT EXISTS pack_registry (' +
    '  id INTEGER PRIMARY KEY,' +
    '  name TEXT,' +
    '  version TEXT' +
    ')';
  db.exec(sql);
  return db;
}

test('getPackRegistryColumnInfo PRAGMA runs exactly once for 100 calls (cache hit)', () => {
  const db = makeDb();
  let pragmaCount = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql && sql.includes('PRAGMA table_info')) pragmaCount++;
    return origPrepare(sql);
  };
  const pr = require('../db/pack-registry');
  pr.setDb(db);
  for (let i = 0; i < 100; i++) pr.getPackRegistryColumnInfo();
  expect(pragmaCount).toBe(1);
});

test('setDb clears the PRAGMA cache', () => {
  const db1 = makeDb();
  const db2 = makeDb();
  const pr = require('../db/pack-registry');
  pr.setDb(db1);
  pr.getPackRegistryColumnInfo(); // populate
  pr.setDb(db2); // should clear
  let pragmaCount = 0;
  const origPrepare = db2.prepare.bind(db2);
  db2.prepare = (sql) => {
    if (sql && sql.includes('PRAGMA table_info')) pragmaCount++;
    return origPrepare(sql);
  };
  pr.getPackRegistryColumnInfo();
  expect(pragmaCount).toBe(1);
});
