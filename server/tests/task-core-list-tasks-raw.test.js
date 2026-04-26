'use strict';
const Database = require('better-sqlite3');

const CREATE_TABLE_SQL = 'CREATE TABLE tasks (' +
  'id TEXT PRIMARY KEY,' +
  'project TEXT,' +
  'description TEXT,' +
  'status TEXT DEFAULT (\'queued\'),' +
  'provider TEXT,' +
  'tags TEXT DEFAULT (\'[]\'),' +
  'files_modified TEXT DEFAULT (\'[]\'),' +
  'context TEXT DEFAULT (\'null\'),' +
  'auto_approve INTEGER DEFAULT 0,' +
  'created_at TEXT DEFAULT (datetime(\'now\')),' +
  'updated_at TEXT DEFAULT (datetime(\'now\'))' +
  ')';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(CREATE_TABLE_SQL);
  for (let i = 0; i < 10; i++) {
    db.prepare(
      'INSERT INTO tasks (id, project, description, tags, files_modified, context)' +
      ' VALUES (?, \'proj\', \'task\', ?, ?, ?)'
    ).run(
      'task-' + i,
      JSON.stringify(['tagA', 'tagB']),
      JSON.stringify(['file1.js']),
      JSON.stringify({ key: 'val' })
    );
  }
  return db;
}

test('listTasks default (parsed) returns parsed tags array', () => {
  const taskCore = require('../db/task-core');
  taskCore.setDb(makeDb());
  const tasks = taskCore.listTasks({ project: 'proj', limit: 10 });
  expect(Array.isArray(tasks[0].tags)).toBe(true);
  expect(tasks[0].tags).toEqual(['tagA', 'tagB']);
});

test('listTasks({raw:true}) returns tags as raw JSON string', () => {
  const taskCore = require('../db/task-core');
  taskCore.setDb(makeDb());
  const tasks = taskCore.listTasks({ project: 'proj', limit: 10, raw: true });
  expect(typeof tasks[0].tags).toBe('string');
  expect(tasks[0].tags).toBe('["tagA","tagB"]');
});

test('listTasks({raw:true}) still casts auto_approve to boolean', () => {
  const taskCore = require('../db/task-core');
  taskCore.setDb(makeDb());
  const tasks = taskCore.listTasks({ project: 'proj', limit: 10, raw: true });
  expect(typeof tasks[0].auto_approve).toBe('boolean');
});

test('listTasks({raw:true}) is measurably faster than parsed for 1000 rows', () => {
  const db = new Database(':memory:');
  db.exec(CREATE_TABLE_SQL);
  const ins = db.prepare(
    'INSERT INTO tasks (id, project, description, tags, files_modified, context)' +
    ' VALUES (?, \'p\', \'d\', ?, ?, ?)'
  );
  for (let i = 0; i < 1000; i++) {
    ins.run('t' + i, JSON.stringify(['a', 'b', 'c']), JSON.stringify(['x.js', 'y.js']), JSON.stringify({ k: 'v' }));
  }
  const taskCore = require('../db/task-core');
  taskCore.setDb(db);
  // Warm up
  for (let w = 0; w < 5; w++) {
    taskCore.listTasks({ project: 'p', limit: 1000 });
    taskCore.listTasks({ project: 'p', limit: 1000, raw: true });
  }
  const N = 20;
  const { performance } = require('perf_hooks');
  let parsedTotal = 0, rawTotal = 0;
  for (let i = 0; i < N; i++) {
    let t = performance.now();
    taskCore.listTasks({ project: 'p', limit: 1000 });
    parsedTotal += performance.now() - t;
    t = performance.now();
    taskCore.listTasks({ project: 'p', limit: 1000, raw: true });
    rawTotal += performance.now() - t;
  }
  const parsedMean = parsedTotal / N;
  const rawMean = rawTotal / N;
  // raw must be at least 10% faster than parsed (skipping 3000 JSON.parse calls per batch)
  expect(rawMean).toBeLessThan(parsedMean * 0.90);
}, 30000);
