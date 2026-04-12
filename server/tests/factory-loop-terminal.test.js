'use strict';

const Database = require('better-sqlite3');
const factoryHealth = require('../db/factory-health');
const { LOOP_STATES } = require('../factory/loop-states');
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
    )
  `);
}

let db;

beforeAll(() => {
  db = new Database(':memory:');
  createFactoryTables(db);
  factoryHealth.setDb(db);
});

afterAll(() => {
  db.close();
});

describe('factory loop LEARN terminal state', () => {
  beforeEach(() => {
    db.exec('DELETE FROM factory_projects');
  });

  it('LEARN advances to IDLE by default (no auto_continue)', async () => {
    const project = factoryHealth.registerProject({
      name: 'DefaultLearn',
      path: '/test/default-learn-' + Date.now(),
      trust_level: 'dark',
    });
    factoryHealth.updateProject(project.id, { loop_state: LOOP_STATES.LEARN });

    const result = await loopController.advanceLoop(project.id);
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

    const result = await loopController.advanceLoop(project.id);
    expect(result.new_state).toBe(LOOP_STATES.SENSE);
  });
});
