import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));

const Database = require('better-sqlite3');
const { defaultContainer } = require('../container');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryFeedback = require('../db/factory-feedback');
const factoryHealth = require('../db/factory-health');
const guardrailDb = require('../db/factory-guardrails');
const factoryIntake = require('../db/factory-intake');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');

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
      claimed_by_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_loop_instances_stage_occupancy
      ON factory_loop_instances(project_id, loop_state)
      WHERE terminated_at IS NULL AND loop_state NOT IN ('IDLE');

    CREATE INDEX IF NOT EXISTS idx_factory_loop_instances_project_active
      ON factory_loop_instances(project_id)
      WHERE terminated_at IS NULL;

    CREATE TABLE IF NOT EXISTS factory_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      batch_id TEXT,
      health_delta_json TEXT,
      execution_metrics_json TEXT,
      guardrail_activity_json TEXT,
      human_corrections_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_guardrail_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      category TEXT NOT NULL,
      check_name TEXT NOT NULL,
      status TEXT NOT NULL,
      details_json TEXT,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      stage TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      reasoning TEXT,
      inputs_json TEXT,
      outcome_json TEXT,
      confidence REAL,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS model_family_templates (
      family TEXT PRIMARY KEY,
      system_prompt TEXT NOT NULL,
      tuning_json TEXT NOT NULL,
      size_overrides TEXT
    );
  `);
}

function listDecisionRows(db, projectId) {
  return db.prepare(`
    SELECT id, stage, actor, action, reasoning, inputs_json, outcome_json, batch_id
    FROM factory_decisions
    WHERE project_id = ?
    ORDER BY id ASC
  `).all(projectId).map((row) => ({
    ...row,
    inputs: row.inputs_json ? JSON.parse(row.inputs_json) : null,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
  }));
}

let db;
let originalGetDbInstance;

beforeEach(() => {
  db = new Database(':memory:');
  createFactoryTables(db);
  originalGetDbInstance = database.getDbInstance;
  database.getDbInstance = () => db;

  defaultContainer.resetForTest && defaultContainer.resetForTest();
  defaultContainer.registerValue('db', db);
  defaultContainer.registerValue('eventBus', { emit: () => {}, on: () => {}, off: () => {} });
  defaultContainer.registerValue('logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  defaultContainer.boot();

  factoryHealth.setDb(db);
  factoryFeedback.setDb(db);
  factoryIntake.setDb(db);
  factoryDecisions.setDb(null);
  guardrailDb.setDb(null);
});

afterEach(() => {
  database.getDbInstance = originalGetDbInstance;
  defaultContainer.resetForTest && defaultContainer.resetForTest();
  factoryDecisions.setDb(null);
  factoryFeedback.setDb(null);
  factoryHealth.setDb(null);
  factoryIntake.setDb(null);
  guardrailDb.setDb(null);
  db.close();
  db = null;
});

describe('loopController.advanceLoop LEARN stage lazy DB wiring', () => {
  it('records learned instead of learn_failed when guardrail DB is only available via lazy lookup', async () => {
    const batchId = 'batch-learn-regression';
    const project = factoryHealth.registerProject({
      name: 'LEARN null-db regression',
      path: '/tmp/factory-learn-null-db-regression',
      trust_level: 'supervised',
    });

    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'Regression batch',
      description: 'Exercise LEARN after VERIFY approval.',
      requestor: 'test',
    });

    factoryIntake.updateWorkItem(workItem.id, {
      status: 'verifying',
      batch_id: batchId,
    });

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
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id,
      'test_coverage',
      68,
      JSON.stringify({ source: 'baseline' }),
      'incremental',
      'batch-before',
      '2026-04-13T17:59:00.000Z'
    );
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
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id,
      'test_coverage',
      74,
      JSON.stringify({ source: 'verify' }),
      'incremental',
      batchId,
      '2026-04-13T18:03:00.000Z'
    );

    db.prepare(`
      INSERT INTO factory_guardrail_events (
        project_id,
        category,
        check_name,
        status,
        details_json,
        batch_id,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id,
      'quality',
      'checkTestRegression',
      'pass',
      JSON.stringify({ passed: 12, failed: 0, skipped: 0 }),
      batchId,
      '2026-04-13T18:04:00.000Z'
    );

    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.PAUSED,
      loop_batch_id: batchId,
      loop_paused_at_stage: LOOP_STATES.VERIFY,
      loop_last_action_at: '2026-04-13T18:04:30.000Z',
    });

    const approved = loopController.approveGateForProject(project.id, LOOP_STATES.VERIFY);
    expect(approved.state).toBe(LOOP_STATES.VERIFY);

    const verifyAdvance = await loopController.advanceLoopForProject(project.id);
    expect(verifyAdvance.previous_state).toBe(LOOP_STATES.VERIFY);
    expect(verifyAdvance.new_state).toBe(LOOP_STATES.LEARN);

    const result = await loopController.advanceLoopForProject(project.id);

    expect(result.previous_state).toBe(LOOP_STATES.LEARN);
    expect(result.new_state).toBe(LOOP_STATES.IDLE);
    expect(result.stage_result).toEqual(
      expect.objectContaining({
        feedback_id: expect.any(Number),
        summary: expect.any(String),
      })
    );

    const decisions = listDecisionRows(db, project.id);
    expect(
      decisions.find(
        (row) => row.action === 'learn_failed' && /prepare/i.test(row.reasoning || '')
      )
    ).toBeUndefined();

    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'learn',
          action: 'learned',
          batch_id: batchId,
          outcome: expect.objectContaining({
            summary: expect.any(String),
          }),
        }),
      ])
    );
  });
});
