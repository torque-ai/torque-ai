'use strict';
const Database = require('better-sqlite3');

// Minimal tasks schema with all columns that listTasks queries by default.
// 'archived' is required because the default filter includes 'archived = 0'.
const CREATE_TABLE_SQL = 'CREATE TABLE tasks (' +
  'id TEXT PRIMARY KEY,' +
  'project TEXT,' +
  'task_description TEXT,' +
  'status TEXT DEFAULT (\'queued\'),' +
  'provider TEXT,' +
  'tags TEXT DEFAULT (\'[]\'),' +
  'files_modified TEXT DEFAULT (\'[]\'),' +
  'context TEXT DEFAULT (\'null\'),' +
  'auto_approve INTEGER DEFAULT 0,' +
  'archived INTEGER DEFAULT 0,' +
  'created_at TEXT DEFAULT (datetime(\'now\')),' +
  'updated_at TEXT DEFAULT (datetime(\'now\'))' +
  ')';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(CREATE_TABLE_SQL);
  for (let i = 0; i < 10; i++) {
    db.prepare(
      'INSERT INTO tasks (id, project, task_description, tags, files_modified, context)' +
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
  const tasks = taskCore.listTasks({ project: 'proj', limit: 10, columns: ['id', 'tags', 'auto_approve'] });
  expect(Array.isArray(tasks[0].tags)).toBe(true);
  expect(tasks[0].tags).toEqual(['tagA', 'tagB']);
});

test('listTasks({raw:true}) returns tags as raw JSON string', () => {
  const taskCore = require('../db/task-core');
  taskCore.setDb(makeDb());
  const tasks = taskCore.listTasks({ project: 'proj', limit: 10, raw: true, columns: ['id', 'tags', 'auto_approve'] });
  expect(typeof tasks[0].tags).toBe('string');
  expect(tasks[0].tags).toBe('["tagA","tagB"]');
});

test('listTasks({raw:true}) still casts auto_approve to boolean', () => {
  const taskCore = require('../db/task-core');
  taskCore.setDb(makeDb());
  const tasks = taskCore.listTasks({ project: 'proj', limit: 10, raw: true, columns: ['id', 'tags', 'auto_approve'] });
  expect(typeof tasks[0].auto_approve).toBe('boolean');
});

test('listTasks({raw:true}) skips JSON parsing for raw JSON columns', () => {
  const db = new Database(':memory:');
  db.exec(CREATE_TABLE_SQL);
  const ins = db.prepare(
    'INSERT INTO tasks (id, project, task_description, tags, files_modified, context)' +
    ' VALUES (?, \'p\', \'d\', ?, ?, ?)'
  );
  for (let i = 0; i < 3; i++) {
    ins.run('t' + i, JSON.stringify(['a', 'b', 'c']), JSON.stringify(['x.js', 'y.js']), JSON.stringify({ k: 'v' }));
  }
  const taskCore = require('../db/task-core');
  taskCore.setDb(db);
  const cols = ['id', 'tags', 'files_modified', 'context', 'auto_approve'];

  const originalParse = JSON.parse;
  let parseCount = 0;
  JSON.parse = function countingParse() {
    parseCount += 1;
    return originalParse.apply(this, arguments);
  };

  try {
    taskCore.listTasks({ project: 'p', limit: 3, columns: cols });
    expect(parseCount).toBe(9);

    parseCount = 0;
    const rawTasks = taskCore.listTasks({ project: 'p', limit: 3, raw: true, columns: cols });
    expect(parseCount).toBe(0);
    expect(rawTasks[0].tags).toBe('["a","b","c"]');
    expect(rawTasks[0].files_modified).toBe('["x.js","y.js"]');
    expect(rawTasks[0].context).toBe('{"k":"v"}');
  } finally {
    JSON.parse = originalParse;
  }
});
