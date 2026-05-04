import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../task-manager', () => ({}));

const Database = require('better-sqlite3');
const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const factoryArchitect = require('../db/factory/architect');
const {
  runArchitectCycle,
  updateBacklogWorkItemStatuses,
} = require('../factory/architect-runner');

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

    CREATE TABLE IF NOT EXISTS factory_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      dimension TEXT NOT NULL,
      score REAL NOT NULL,
      details_json TEXT,
      scan_type TEXT NOT NULL DEFAULT 'incremental',
      batch_id TEXT,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS factory_architect_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      input_snapshot_json TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      backlog_json TEXT NOT NULL,
      flags_json TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      trigger TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

describe('factory architect skip closed items', () => {
  let db;
  let project;

  function createWorkItem(title, status = 'pending') {
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      title,
    });

    if (status !== 'pending') {
      factoryIntake.updateWorkItem(item.id, { status });
    }

    return factoryIntake.getWorkItem(item.id);
  }

  function seedHealthScore(dimension, score) {
    db.prepare(`
      INSERT INTO factory_health_snapshots (
        project_id,
        dimension,
        score,
        details_json,
        scan_type,
        batch_id,
        scanned_at
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(project.id, dimension, score, null, 'incremental', null);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryArchitect.setDb(db);
    project = factoryHealth.registerProject({
      name: 'Factory Architect Closed Status Test App',
      path: '/projects/factory-architect-closed-status-test-app',
      brief: 'Regression coverage for architect closed item handling',
    });
  });

  afterEach(() => {
    db.close();
  });

  test('updateBacklogWorkItemStatuses prioritizes only open items', () => {
    const intakeItem = createWorkItem('Open intake item', 'intake');
    const completedItem = createWorkItem('Completed item', 'completed');
    const shippedItem = createWorkItem('Shipped item', 'shipped');

    updateBacklogWorkItemStatuses([
      { work_item_id: intakeItem.id, title: intakeItem.title },
      { work_item_id: completedItem.id, title: completedItem.title },
      { work_item_id: shippedItem.id, title: shippedItem.title },
    ]);

    expect(factoryIntake.getWorkItem(intakeItem.id).status).toBe('prioritized');
    expect(factoryIntake.getWorkItem(completedItem.id).status).toBe('completed');
    expect(factoryIntake.getWorkItem(shippedItem.id).status).toBe('shipped');
  });

  test('runArchitectCycle excludes closed items from the architect intake snapshot', async () => {
    seedHealthScore('security', 12);

    const intakeItem = createWorkItem('Open intake item', 'intake');
    const completedItem = createWorkItem('Completed item', 'completed');
    const shippedItem = createWorkItem('Shipped item', 'shipped');

    const cycle = await runArchitectCycle(project.id, 'manual');

    expect(cycle.input_snapshot.intakeItems).toEqual([
      { id: intakeItem.id, title: intakeItem.title },
    ]);
    expect(cycle.backlog).toEqual([
      expect.objectContaining({ work_item_id: intakeItem.id, title: intakeItem.title }),
    ]);
    expect(factoryIntake.getWorkItem(intakeItem.id).status).toBe('prioritized');
    expect(factoryIntake.getWorkItem(completedItem.id).status).toBe('completed');
    expect(factoryIntake.getWorkItem(shippedItem.id).status).toBe('shipped');
  });
});
