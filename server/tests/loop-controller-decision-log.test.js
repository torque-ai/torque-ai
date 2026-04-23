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
const factoryLoopInstances = require('../db/factory-loop-instances');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');
const { handleDecisionLog } = require('../handlers/factory-handlers');

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

function registerProjectWithWorkItem(trustLevel = 'guided') {
  const project = factoryHealth.registerProject({
    name: `Decision Log ${trustLevel}`,
    path: `/tmp/decision-log-${trustLevel}-${Date.now()}`,
    trust_level: trustLevel,
  });

  const workItem = factoryIntake.createWorkItem({
    project_id: project.id,
    source: 'manual',
    title: 'Wire loop decisions',
    description: 'Exercise the loop controller decision audit trail.',
    priority: 88,
    requestor: 'test',
  });

  return { project, workItem };
}

let db;
let originalGetDbInstance;

beforeEach(() => {
  db = new Database(':memory:');
  createFactoryTables(db);
  factoryArchitect.setDb(db);
  factoryHealth.setDb(db);
  factoryIntake.setDb(db);
  factoryLoopInstances.setDb(db);
  factoryDecisions.setDb(db);
  originalGetDbInstance = database.getDbInstance;
  database.getDbInstance = () => db;
});

afterEach(() => {
  database.getDbInstance = originalGetDbInstance;
  factoryArchitect.setDb(null);
  factoryHealth.setDb(null);
  factoryIntake.setDb(null);
  factoryLoopInstances.setDb(null);
  factoryDecisions.setDb(null);
  db.close();
  db = null;
});

describe('loop-controller decision logging', () => {
  it('skips decision logging when the database handle is unavailable', () => {
    database.getDbInstance = () => null;

    const result = loopController._internalForTests.safeLogDecision({
      project_id: 'missing-db-project',
      stage: LOOP_STATES.SENSE,
      action: 'scanned_plans',
    });

    expect(result).toBeNull();
    expect(listDecisionRows(db, 'missing-db-project')).toEqual([]);
  });

  it('logs SENSE -> PRIORITIZE -> PLAN decisions, gate approvals, and plan-generation rejection', async () => {
    const { project, workItem } = registerProjectWithWorkItem('guided');

    loopController.startLoopForProject(project.id);
    let decisions = listDecisionRows(db, project.id);
    expect(decisions).toHaveLength(2);
    expect(decisions.map((row) => row.action)).toEqual(['started_loop', 'scanned_plans']);
    expect(decisions[1]).toMatchObject({
      stage: 'sense',
      action: 'scanned_plans',
    });

    const senseAdvance = await loopController.advanceLoopForProject(project.id);
    expect(senseAdvance.new_state).toBe(LOOP_STATES.PRIORITIZE);
    decisions = listDecisionRows(db, project.id);
    expect(decisions).toHaveLength(3);
    expect(decisions.at(-1)).toMatchObject({
      stage: 'sense',
      action: 'advance_from_sense',
    });

    const prioritizeAdvance = await loopController.advanceLoopForProject(project.id);
    expect(prioritizeAdvance.new_state).toBe(LOOP_STATES.PLAN);
    expect(prioritizeAdvance.paused_at_stage).toBe(LOOP_STATES.PLAN);
    decisions = listDecisionRows(db, project.id);
    expect(decisions).toHaveLength(7);
    expect(decisions.at(-3)).toMatchObject({
      stage: 'prioritize',
      action: 'scored_work_item',
    });
    expect(decisions.at(-3).outcome).toMatchObject({
      work_item_id: workItem.id,
      old_priority: workItem.priority,
      new_priority: expect.any(Number),
      score_reason: expect.any(String),
    });
    expect(decisions.at(-4)).toMatchObject({
      stage: 'prioritize',
      action: 'selected_work_item',
    });
    expect(decisions.at(-4).outcome).toMatchObject({
      work_item_id: workItem.id,
      priority: workItem.priority,
      selection_status: 'selected',
    });
    expect(decisions.at(-2)).toMatchObject({
      stage: 'plan',
      action: 'generated_plan',
    });
    expect(decisions.at(-1)).toMatchObject({
      stage: 'plan',
      action: 'paused_at_gate',
    });

    const approved = loopController.approveGateForProject(project.id, LOOP_STATES.PLAN);
    expect(approved.state).toBe(LOOP_STATES.PLAN);
    decisions = listDecisionRows(db, project.id);
    expect(decisions).toHaveLength(8);
    expect(decisions.at(-1)).toMatchObject({
      stage: 'plan',
      actor: 'human',
      action: 'gate_approved',
    });
    expect(decisions.at(-1).outcome).toMatchObject({
      from_state: 'PAUSED',
      to_state: 'PLAN',
      approved_stage: 'PLAN',
    });

    const planAdvance = await loopController.advanceLoopForProject(project.id);
    expect(planAdvance.new_state).toBe(LOOP_STATES.IDLE);
    expect(planAdvance.reason).toBeTruthy();
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      id: workItem.id,
      status: 'rejected',
      reject_reason: expect.stringMatching(/^cannot_generate_plan: /),
    });
    decisions = listDecisionRows(db, project.id);
    // Non-plan-file EXECUTE attempts production plan generation. This minimal
    // fixture has no task pipeline, so the hardened path rejects the item
    // instead of looping forever.
    expect(decisions.length).toBeGreaterThanOrEqual(9);
    expect(decisions.find(d => d.stage === 'execute' && d.action === 'started_execution')).toBeUndefined();
    const rejected = decisions.find(d => d.stage === 'execute' && d.action === 'cannot_generate_plan');
    expect(rejected).toBeTruthy();
    expect(rejected.outcome).toMatchObject({
      work_item_id: workItem.id,
    });
    expect(rejected.outcome.reason).toBeTruthy();
  });

  it('refreshes the decision DB dependency when handleDecisionLog is called', async () => {
    const { project } = registerProjectWithWorkItem('guided');

    loopController.startLoopForProject(project.id);
    await loopController.advanceLoopForProject(project.id);

    factoryDecisions.setDb(null);

    const response = await handleDecisionLog({ project: project.id, limit: 20 });

    expect(response.structuredData).toMatchObject({
      decisions: expect.any(Array),
      stats: expect.objectContaining({
        total: 3,
      }),
    });
    expect(response.structuredData.decisions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'advance_from_sense',
        'scanned_plans',
        'started_loop',
      ])
    );
  });
});
