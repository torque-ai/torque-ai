'use strict';

const Database = require('better-sqlite3');
const factoryHealth = require('../db/factory-health');

// Import the modules under test
const {
  LOOP_STATES,
  TRANSITIONS,
  APPROVAL_GATES,
  getNextState,
  isValidState,
  getGatesForTrustLevel,
} = require('../factory/loop-states');
const loopController = require('../factory/loop-controller');

// Create factory tables directly — in-memory test DB
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      dimension TEXT NOT NULL,
      score REAL NOT NULL,
      details_json TEXT,
      scan_type TEXT NOT NULL DEFAULT 'incremental',
      batch_id TEXT,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_fhs_project_dim ON factory_health_snapshots(project_id, dimension, scanned_at)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_health_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES factory_health_snapshots(id),
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      file_path TEXT,
      details_json TEXT
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

describe('loop-states', () => {
  it('exports all 8 states', () => {
    expect(LOOP_STATES).toEqual({
      SENSE: 'SENSE',
      PRIORITIZE: 'PRIORITIZE',
      PLAN: 'PLAN',
      EXECUTE: 'EXECUTE',
      VERIFY: 'VERIFY',
      LEARN: 'LEARN',
      IDLE: 'IDLE',
      PAUSED: 'PAUSED',
    });
    expect(Object.keys(LOOP_STATES)).toHaveLength(8);
  });

  it('TRANSITIONS maps full cycle', () => {
    expect(TRANSITIONS).toEqual({
      [LOOP_STATES.SENSE]: LOOP_STATES.PRIORITIZE,
      [LOOP_STATES.PRIORITIZE]: LOOP_STATES.PLAN,
      [LOOP_STATES.PLAN]: LOOP_STATES.EXECUTE,
      [LOOP_STATES.EXECUTE]: LOOP_STATES.VERIFY,
      [LOOP_STATES.VERIFY]: LOOP_STATES.LEARN,
      [LOOP_STATES.LEARN]: LOOP_STATES.SENSE,
    });
  });

  it('isValidState returns true for valid states', () => {
    for (const state of Object.values(LOOP_STATES)) {
      expect(isValidState(state)).toBe(true);
    }
  });

  it('isValidState returns false for invalid states', () => {
    expect(isValidState('INVALID')).toBe(false);
    expect(isValidState('')).toBe(false);
    expect(isValidState(null)).toBe(false);
  });

  it('getGatesForTrustLevel returns correct gates', () => {
    expect(APPROVAL_GATES.supervised).toEqual([
      LOOP_STATES.PRIORITIZE,
      LOOP_STATES.PLAN,
      LOOP_STATES.VERIFY,
      LOOP_STATES.LEARN,
    ]);
    expect(getGatesForTrustLevel('supervised')).toEqual([
      LOOP_STATES.PRIORITIZE,
      LOOP_STATES.PLAN,
      LOOP_STATES.VERIFY,
      LOOP_STATES.LEARN,
    ]);
    expect(getGatesForTrustLevel('guided')).toEqual([
      LOOP_STATES.PLAN,
      LOOP_STATES.LEARN,
    ]);
    expect(getGatesForTrustLevel('autonomous')).toEqual([
      LOOP_STATES.LEARN,
    ]);
    expect(getGatesForTrustLevel('dark')).toEqual([]);
  });

  it('getNextState returns PAUSED at gates for supervised', () => {
    expect(getNextState(LOOP_STATES.SENSE, 'supervised', null)).toBe(LOOP_STATES.PAUSED);
  });

  it('getNextState returns next state when approved', () => {
    expect(getNextState(LOOP_STATES.SENSE, 'supervised', 'approved')).toBe(LOOP_STATES.PRIORITIZE);
  });

  it('getNextState returns IDLE on rejection', () => {
    expect(getNextState(LOOP_STATES.SENSE, 'supervised', 'rejected')).toBe(LOOP_STATES.IDLE);
  });

  it('getNextState returns IDLE/PAUSED unchanged for terminal states', () => {
    expect(getNextState(LOOP_STATES.IDLE, 'dark', null)).toBe(LOOP_STATES.IDLE);
    expect(getNextState(LOOP_STATES.PAUSED, 'dark', null)).toBe(LOOP_STATES.PAUSED);
  });
});

describe('loop-controller', () => {
  let testProject;

  beforeEach(() => {
    // Clean up previous projects
    db.exec("DELETE FROM factory_projects");
    testProject = factoryHealth.registerProject({
      name: 'TestProject',
      path: '/test/project-' + Date.now(),
      trust_level: 'dark',
    });
  });

  it('startLoop sets state to SENSE', () => {
    loopController.startLoop(testProject.id);

    expect(loopController.getLoopState(testProject.id).loop_state).toBe(LOOP_STATES.SENSE);
  });

  it('getLoopState returns IDLE for new project', () => {
    expect(loopController.getLoopState(testProject.id).loop_state).toBe(LOOP_STATES.IDLE);
  });

  it('advanceLoop moves to next state', () => {
    loopController.startLoop(testProject.id);
    loopController.advanceLoop(testProject.id);

    expect(loopController.getLoopState(testProject.id).loop_state).toBe(LOOP_STATES.PRIORITIZE);
  });

  it('advanceLoop throws for IDLE project', async () => {
    await expect(loopController.advanceLoop(testProject.id)).rejects.toThrow('Loop not started for this project');
  });

  it('startLoop with supervised trust pauses at first gate', () => {
    const supervisedProject = factoryHealth.registerProject({
      name: 'SupervisedProject',
      path: '/test/supervised-' + Date.now(),
      trust_level: 'supervised',
    });

    loopController.startLoop(supervisedProject.id);
    loopController.advanceLoop(supervisedProject.id);

    expect(loopController.getLoopState(supervisedProject.id)).toMatchObject({
      loop_state: LOOP_STATES.PAUSED,
      loop_paused_at_stage: LOOP_STATES.PRIORITIZE,
      trust_level: 'supervised',
    });
  });

  it('approveGate unpauses the loop', () => {
    const supervisedProject = factoryHealth.registerProject({
      name: 'SupervisedProject',
      path: '/test/supervised-' + Date.now(),
      trust_level: 'supervised',
    });

    loopController.startLoop(supervisedProject.id);
    loopController.advanceLoop(supervisedProject.id);
    loopController.approveGate(supervisedProject.id, LOOP_STATES.PRIORITIZE);

    expect(loopController.getLoopState(supervisedProject.id)).toMatchObject({
      loop_state: LOOP_STATES.PRIORITIZE,
      loop_paused_at_stage: null,
    });
  });

  it('approveGate throws for wrong stage', () => {
    const supervisedProject = factoryHealth.registerProject({
      name: 'SupervisedProject',
      path: '/test/supervised-' + Date.now(),
      trust_level: 'supervised',
    });

    loopController.startLoop(supervisedProject.id);
    loopController.advanceLoop(supervisedProject.id);

    expect(() => loopController.approveGate(supervisedProject.id, LOOP_STATES.LEARN))
      .toThrow(`Loop is paused at ${LOOP_STATES.PRIORITIZE}, not ${LOOP_STATES.LEARN}`);
  });

  it('rejectGate stops the loop', () => {
    const supervisedProject = factoryHealth.registerProject({
      name: 'SupervisedProject',
      path: '/test/supervised-' + Date.now(),
      trust_level: 'supervised',
    });

    loopController.startLoop(supervisedProject.id);
    loopController.advanceLoop(supervisedProject.id);
    loopController.rejectGate(supervisedProject.id, LOOP_STATES.PRIORITIZE);

    expect(loopController.getLoopState(supervisedProject.id)).toMatchObject({
      loop_state: LOOP_STATES.IDLE,
      loop_paused_at_stage: null,
    });
  });
});
