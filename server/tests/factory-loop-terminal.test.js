'use strict';

const Database = require('better-sqlite3');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const { LOOP_STATES } = require('../factory/loop-states');
const loopController = require('../factory/loop-controller');

function createFactoryTables(db) {
  db.exec(`
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
      claimed_by_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_fwi_project_status ON factory_work_items(project_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_fwi_status_priority ON factory_work_items(status, priority DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_fwi_source ON factory_work_items(source)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_fwi_linked ON factory_work_items(linked_item_id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_loop_instances (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      work_item_id INTEGER REFERENCES factory_work_items(id),
      batch_id TEXT,
      loop_state TEXT NOT NULL DEFAULT 'IDLE',
      paused_at_stage TEXT,
      last_action_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      terminated_at TEXT
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_loop_instances_stage_occupancy
      ON factory_loop_instances(project_id, loop_state)
      WHERE terminated_at IS NULL AND loop_state NOT IN ('IDLE')
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_factory_loop_instances_project_active
      ON factory_loop_instances(project_id)
      WHERE terminated_at IS NULL
  `);
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
    )
  `);
}

let db;

beforeAll(() => {
  db = new Database(':memory:');
  createFactoryTables(db);
  factoryHealth.setDb(db);
  factoryIntake.setDb(db);
  factoryLoopInstances.setDb(db);
});

afterAll(() => {
  factoryIntake.setDb(null);
  factoryLoopInstances.setDb(null);
  db.close();
});

describe('factory loop LEARN terminal state', () => {
  beforeEach(() => {
    db.exec('DELETE FROM factory_loop_instances');
    db.exec('DELETE FROM factory_work_items');
    db.exec('DELETE FROM factory_projects');
  });

  it('LEARN advances to IDLE by default (no auto_continue)', async () => {
    const project = factoryHealth.registerProject({
      name: 'DefaultLearn',
      path: '/test/default-learn-' + Date.now(),
      trust_level: 'dark',
    });
    factoryHealth.updateProject(project.id, { loop_state: LOOP_STATES.LEARN });

    const result = await loopController.advanceLoopForProject(project.id);
    expect(result.new_state).toBe(LOOP_STATES.IDLE);
  });

  it('project with loop.auto_continue=true: LEARN advances to SENSE (legacy)', async () => {
    const project = factoryHealth.registerProject({
      name: 'AutoContinueLegacy',
      path: '/test/auto-continue-' + Date.now(),
      trust_level: 'dark',
      config: { loop: { auto_continue: true } },
    });
    factoryHealth.updateProject(project.id, { loop_state: LOOP_STATES.LEARN });

    const result = await loopController.advanceLoopForProject(project.id);
    expect(result.new_state).toBe(LOOP_STATES.SENSE);
  });
});
