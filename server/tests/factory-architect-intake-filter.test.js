'use strict';

const Database = require('better-sqlite3');
const factoryHealth = require('../db/factory-health');
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

    CREATE INDEX IF NOT EXISTS idx_fwi_project_status
      ON factory_work_items(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_fwi_status_priority
      ON factory_work_items(status, priority DESC);
    CREATE INDEX IF NOT EXISTS idx_fwi_source
      ON factory_work_items(source);
    CREATE INDEX IF NOT EXISTS idx_fwi_linked
      ON factory_work_items(linked_item_id);
  `);
}

describe('factory architect intake filtering', () => {
  let db;
  let project;

  function insertWorkItem(title, status) {
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      title,
    });

    if (status && status !== 'pending') {
      factoryIntake.updateWorkItem(item.id, { status });
    }

    return factoryIntake.getWorkItem(item.id);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    project = factoryHealth.registerProject({
      name: 'Factory Architect Intake Filter Test App',
      path: '/projects/factory-architect-intake-filter-test-app',
      brief: 'Test project for architect intake filtering',
    });
  });

  afterEach(() => {
    db.close();
  });

  test('listOpenWorkItems excludes a completed work item', () => {
    insertWorkItem('Completed item', 'completed');
    insertWorkItem('Pending item', 'pending');

    const items = factoryIntake.listOpenWorkItems({ project_id: project.id });

    expect(items.map((item) => item.title)).toEqual(['Pending item']);
  });

  test('listOpenWorkItems excludes a rejected work item', () => {
    insertWorkItem('Rejected item', 'rejected');
    insertWorkItem('Pending item', 'pending');

    const items = factoryIntake.listOpenWorkItems({ project_id: project.id });

    expect(items.map((item) => item.title)).toEqual(['Pending item']);
  });

  test('listOpenWorkItems excludes a shipped work item', () => {
    insertWorkItem('Shipped item', 'shipped');
    insertWorkItem('Pending item', 'pending');

    const items = factoryIntake.listOpenWorkItems({ project_id: project.id });

    expect(items.map((item) => item.title)).toEqual(['Pending item']);
  });

  test('listOpenWorkItems follows the shared closed status set', () => {
    insertWorkItem('Needs review item', 'needs_review');
    insertWorkItem('Superseded item', 'superseded');
    insertWorkItem('Pending item', 'pending');

    const items = factoryIntake.listOpenWorkItems({ project_id: project.id });

    expect(items.map((item) => item.title)).toEqual(['Pending item']);
  });

  test('listOpenWorkItems excludes stale needs_replan items with terminal escalation evidence', () => {
    factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Resurrected exhausted item',
      source: 'scout',
      status: 'needs_replan',
      origin: {
        last_escalation: {
          kind: 'chain_exhausted',
          reason_shape: 'empty_branch_after_execute',
        },
      },
    });
    insertWorkItem('Pending item', 'pending');

    const items = factoryIntake.listOpenWorkItems({ project_id: project.id });

    expect(items.map((item) => item.title)).toEqual(['Pending item']);
  });

  test('listOpenWorkItems includes valid non-resolved statuses', () => {
    // These requested statuses are all currently accepted by VALID_STATUSES.
    const openStatuses = ['pending', 'prioritized', 'planned', 'executing', 'intake']
      .filter((status) => factoryIntake.VALID_STATUSES.has(status));

    for (const status of openStatuses) {
      insertWorkItem(`Item ${status}`, status);
    }

    const items = factoryIntake.listOpenWorkItems({ project_id: project.id });

    expect(items.map((item) => item.status).sort()).toEqual([...openStatuses].sort());
  });
});
