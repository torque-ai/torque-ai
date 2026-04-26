'use strict';

const Database = require('better-sqlite3');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');

const EXPECTED_REJECT_REASONS = [
  'meta_task_no_code_output',
  'zero_diff_across_retries',
  'retry_off_scope',
  'branch_stale_vs_master',
  'branch_stale_vs_base',
  // Added by Bug D fix (executePlanStage runs the plan-quality-gate on
  // pre-written plans and rejects them with this reason when the plan
  // would fail the same rules an architect-emitted plan must clear).
  'pre_written_plan_rejected_by_quality_gate',
];

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

    CREATE INDEX IF NOT EXISTS idx_fhs_project_dim
      ON factory_health_snapshots(project_id, dimension, scanned_at);
    CREATE INDEX IF NOT EXISTS idx_fhs_project_time
      ON factory_health_snapshots(project_id, scanned_at);

    CREATE TABLE IF NOT EXISTS factory_health_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES factory_health_snapshots(id),
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      file_path TEXT,
      details_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_fhf_snapshot
      ON factory_health_findings(snapshot_id);

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

describe('factory intake unactionable status', () => {
  let db;
  let project;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    project = factoryHealth.registerProject({
      name: 'Factory Unactionable Test App',
      path: '/projects/factory-unactionable-test-app',
      brief: 'Test project for unactionable intake flows',
    });
  });

  afterEach(() => {
    factoryHealth.setDb(null);
    factoryIntake.setDb(null);
    db.close();
  });

  test('REJECT_REASONS contains the unactionable reason constants', () => {
    expect(factoryIntake.REJECT_REASONS.size).toBe(EXPECTED_REJECT_REASONS.length);
    for (const reason of EXPECTED_REJECT_REASONS) {
      expect(factoryIntake.REJECT_REASONS.has(reason)).toBe(true);
    }
  });

  test('createWorkItem accepts unactionable status', () => {
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Already exhausted by retries',
      status: 'unactionable',
    });

    expect(item.status).toBe('unactionable');
  });

  test('rejectWorkItemUnactionable stores status and reason on the row', () => {
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Zero diff after retry',
    });

    const rejected = factoryIntake.rejectWorkItemUnactionable(item.id, 'zero_diff_across_retries');
    const row = db.prepare('SELECT status, reject_reason FROM factory_work_items WHERE id = ?').get(item.id);

    expect(rejected.status).toBe('unactionable');
    expect(rejected.reject_reason).toBe('zero_diff_across_retries');
    expect(row).toEqual({
      status: 'unactionable',
      reject_reason: 'zero_diff_across_retries',
    });
  });

  test('rejectWorkItemUnactionable rejects reasons outside REJECT_REASONS', () => {
    const item = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Invalid reject reason',
    });

    expect(() => {
      factoryIntake.rejectWorkItemUnactionable(item.id, 'not-in-set');
    }).toThrow('Invalid reject reason: not-in-set');
  });

  test('listOpenWorkItems excludes unactionable items', () => {
    const openItem = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Still actionable',
    });
    const unactionableItem = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'No code output',
    });

    factoryIntake.rejectWorkItemUnactionable(unactionableItem.id, 'meta_task_no_code_output');

    const itemIds = factoryIntake.listOpenWorkItems({ project_id: project.id }).map((item) => item.id);

    expect(itemIds).toContain(openItem.id);
    expect(itemIds).not.toContain(unactionableItem.id);
  });
});
