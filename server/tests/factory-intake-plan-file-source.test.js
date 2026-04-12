'use strict';

const Database = require('better-sqlite3');
const factoryIntake = require('../db/factory-intake');

function createFactoryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      source TEXT NOT NULL,
      origin_json TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      requestor TEXT,
      constraints_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      linked_item_id INTEGER,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_plan_file_intake (
      plan_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, plan_path, content_hash)
    );
  `);
}

describe('factory intake plan_file source', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryIntake.setDb(db);
    db.prepare(`
      INSERT INTO factory_projects (id, name, path, brief, trust_level, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      'proj_plan_file_source',
      'Plan File Source Test Project',
      '/projects/plan-file-source-test',
      'Test project for plan_file source intake',
      'supervised',
      'paused',
    );
  });

  afterEach(() => {
    db.close();
  });

  test('createWorkItem accepts the plan_file source', () => {
    let item;
    expect(() => {
      item = factoryIntake.createWorkItem({
        project_id: 'proj_plan_file_source',
        source: 'plan_file',
        title: 'x',
      });
    }).not.toThrow();

    expect(item.source).toBe('plan_file');
  });
});
