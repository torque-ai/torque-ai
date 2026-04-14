'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));
vi.mock('../factory/architect-runner', () => ({
  runArchitectCycle: vi.fn(async (projectId) => ({
    id: `cycle-${projectId}`,
    project_id: projectId,
    source: 'loop_plan',
  })),
}));

const Database = require('better-sqlite3');
const database = require('../database');
const factoryArchitect = require('../db/factory-architect');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
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

    CREATE TABLE IF NOT EXISTS factory_health_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES factory_health_snapshots(id),
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      file_path TEXT,
      details_json TEXT
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

    CREATE INDEX IF NOT EXISTS idx_fwi_project_status
      ON factory_work_items(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_fwi_status_priority
      ON factory_work_items(status, priority DESC);

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

    CREATE TABLE IF NOT EXISTS factory_plan_file_intake (
      plan_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, plan_path, content_hash)
    );

    CREATE TABLE IF NOT EXISTS factory_architect_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      input_snapshot_json TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      backlog_json TEXT NOT NULL,
      flags_json TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      trigger TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_fd_project_time ON factory_decisions(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_fd_stage ON factory_decisions(project_id, stage);
  `);
}

function listDecisionRows(db, projectId) {
  return db.prepare(`
    SELECT id, stage, actor, action, inputs_json, outcome_json
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
  factoryArchitect.setDb(db);
  factoryHealth.setDb(db);
  factoryIntake.setDb(db);
  factoryDecisions.setDb(db);
  originalGetDbInstance = database.getDbInstance;
  database.getDbInstance = () => db;
});

afterEach(() => {
  database.getDbInstance = originalGetDbInstance;
  factoryDecisions.setDb(null);
  db.close();
  db = null;
});

describe('factory prioritize scoring', () => {
  it('updates the selected work item priority before the PLAN gate is approved', async () => {
    const project = factoryHealth.registerProject({
      name: 'Prioritize Score Project',
      path: `/tmp/prioritize-score-${Date.now()}`,
      trust_level: 'supervised',
    });

    const selectedItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'Selected for prioritize scoring',
      description: 'Should be rescored before the PLAN gate.',
      priority: 40,
      requestor: 'test',
    });

    factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'conversation',
      title: 'Lower-ranked queue item',
      description: 'Remains open while the selected item advances.',
      priority: 20,
      requestor: 'test',
    });

    loopController.startLoopForProject(project.id);

    const senseAdvance = await loopController.advanceLoopForProject(project.id);
    expect(senseAdvance.new_state).toBe(LOOP_STATES.PAUSED);
    expect(senseAdvance.paused_at_stage).toBe(LOOP_STATES.PRIORITIZE);

    const approved = loopController.approveGateForProject(project.id, LOOP_STATES.PRIORITIZE);
    expect(approved.state).toBe(LOOP_STATES.PRIORITIZE);

    const prioritizeAdvance = await loopController.advanceLoopForProject(project.id);
    expect(prioritizeAdvance.new_state).toBe(LOOP_STATES.PAUSED);
    expect(prioritizeAdvance.paused_at_stage).toBe(LOOP_STATES.PLAN);

    const updated = factoryIntake.getWorkItem(selectedItem.id);
    expect(updated.priority).not.toBe(selectedItem.priority);
    expect(updated.priority).toBeGreaterThan(selectedItem.priority);
    expect(updated.status).toBe('planned');

    const decisions = listDecisionRows(db, project.id);
    const scoredDecision = decisions.find((row) => row.action === 'scored_work_item');

    expect(scoredDecision).toMatchObject({
      stage: 'prioritize',
      actor: 'architect',
      action: 'scored_work_item',
    });
    expect(scoredDecision.outcome).toMatchObject({
      work_item_id: selectedItem.id,
      old_priority: selectedItem.priority,
      new_priority: updated.priority,
      score_reason: expect.any(String),
    });

    const scoredIndex = decisions.findIndex((row) => row.action === 'scored_work_item');
    const gateApprovedIndex = decisions.findIndex((row) => row.action === 'gate_approved' && row.stage === 'plan');
    expect(scoredIndex).toBeGreaterThan(-1);
    expect(gateApprovedIndex).toBe(-1);
  });
});
