'use strict';

const Database = require('better-sqlite3');
const factoryHealth = require('../db/factory-health');
const { LOOP_STATES } = require('../factory/loop-states');
const loopController = require('../factory/loop-controller');
// vitest globals (describe/it/beforeEach/afterEach/expect) are injected by the test runner.

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

function insertProject({ id, loop_state, loop_batch_id = null }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO factory_projects (
      id, name, path, brief, trust_level, status, config_json,
      loop_state, loop_batch_id, loop_last_action_at, loop_paused_at_stage,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `Project ${id}`,
    `/test/${id}`,
    null,
    'dark',
    'paused',
    null,
    loop_state,
    loop_batch_id,
    null,
    null,
    now,
    now
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  createFactoryTables(db);
  factoryHealth.setDb(db);
});

afterEach(() => {
  db.close();
  db = null;
});

describe('loopController.attachBatchId', () => {
  it('attaches a batch_id when loop is in PLAN', () => {
    const projectId = 'project-plan';
    insertProject({ id: projectId, loop_state: LOOP_STATES.PLAN });

    const result = loopController.attachBatchId(projectId, 'wf-123');

    expect(result).toMatchObject({
      project_id: projectId,
      loop_batch_id: 'wf-123',
      state: LOOP_STATES.PLAN,
    });

    const project = factoryHealth.getProject(projectId);
    expect(project.loop_batch_id).toBe('wf-123');
  });

  it('attaches a batch_id when loop is in EXECUTE', () => {
    const projectId = 'project-execute';
    insertProject({ id: projectId, loop_state: LOOP_STATES.EXECUTE });

    const result = loopController.attachBatchId(projectId, 'wf-123');

    expect(result).toMatchObject({
      project_id: projectId,
      loop_batch_id: 'wf-123',
      state: LOOP_STATES.EXECUTE,
    });

    const project = factoryHealth.getProject(projectId);
    expect(project.loop_batch_id).toBe('wf-123');
  });

  it('rejects when loop is in SENSE', () => {
    const projectId = 'project-sense';
    insertProject({ id: projectId, loop_state: LOOP_STATES.SENSE });

    const call = () => loopController.attachBatchId(projectId, 'wf-xyz');

    expect(call).toThrow(/SENSE/);
    expect(call).toThrow(/PLAN or EXECUTE/);
  });

  it('rejects unknown project', () => {
    expect(() => loopController.attachBatchId('does-not-exist', 'wf-1'))
      .toThrow(/Project not found/);
  });

  it('overwrites a previous batch_id', () => {
    const projectId = 'project-overwrite';
    insertProject({ id: projectId, loop_state: LOOP_STATES.PLAN });

    loopController.attachBatchId(projectId, 'wf-1');
    loopController.attachBatchId(projectId, 'wf-2');

    const project = factoryHealth.getProject(projectId);
    expect(project.loop_batch_id).toBe('wf-2');
  });
});
