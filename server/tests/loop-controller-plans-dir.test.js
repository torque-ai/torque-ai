'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../database');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const loopController = require('../factory/loop-controller');

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
      loop_state TEXT DEFAULT 'IDLE',
      loop_batch_id TEXT,
      loop_last_action_at TEXT,
      loop_paused_at_stage TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_fwi_project_status
      ON factory_work_items(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_fwi_status_priority
      ON factory_work_items(status, priority DESC);
    CREATE INDEX IF NOT EXISTS idx_fwi_source
      ON factory_work_items(source);
    CREATE INDEX IF NOT EXISTS idx_fwi_linked
      ON factory_work_items(linked_item_id);

    CREATE TABLE IF NOT EXISTS factory_plan_file_intake (
      plan_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, plan_path, content_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_factory_plan_file_project
      ON factory_plan_file_intake(project_id);
  `);
}

describe('loop-controller SENSE plans_dir intake', () => {
  let db;
  let plansDir;
  let originalGetDbInstance;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
    plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plans-'));
  });

  afterEach(() => {
    fs.rmSync(plansDir, { recursive: true, force: true });
    database.getDbInstance = originalGetDbInstance;
    db.close();
  });

  it('ingests plan files during the SENSE stage when project.config.plans_dir is set', () => {
    const planPath = path.join(plansDir, 'feature-a.md');
    fs.writeFileSync(planPath, [
      '# Feature A Implementation Plan',
      '',
      '**Goal:** Wire the SENSE stage to scan plans.',
      '',
      '## Task 1: add intake hook',
      '- [ ] write the failing test',
      '- [ ] make the hook pass',
    ].join('\n'));

    const project = factoryHealth.registerProject({
      name: 'PlansDir Loop Project',
      path: `/tmp/plans-dir-loop-${Date.now()}`,
      trust_level: 'dark',
      config: { plans_dir: plansDir },
    });

    loopController.startLoop(project.id);

    const row = db.prepare(`
      SELECT id, source, title, origin_json
      FROM factory_work_items
      WHERE project_id = ? AND source = 'plan_file'
    `).get(project.id);

    expect(row).toBeTruthy();
    expect(row.source).toBe('plan_file');
    expect(row.title).toBe('Feature A Implementation Plan');
    expect(JSON.parse(row.origin_json)).toMatchObject({
      plan_path: planPath,
      task_count: 1,
      step_count: 2,
    });
  });
});
