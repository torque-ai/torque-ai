'use strict';

const Database = require('better-sqlite3');
const loopController = require('../factory/loop-controller');
const factoryDecisions = require('../db/factory/decisions');
const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const factoryLoopInstances = require('../db/factory/loop-instances');
const { LOOP_STATES } = require('../factory/loop-states');

function createFactoryTables(db) {
  db.exec(`
    CREATE TABLE factory_projects (
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
      consecutive_empty_cycles INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE factory_work_items (
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

    CREATE INDEX idx_fwi_project_status ON factory_work_items(project_id, status);
    CREATE INDEX idx_fwi_status_priority ON factory_work_items(status, priority DESC);

    CREATE TABLE factory_loop_instances (
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

    CREATE UNIQUE INDEX idx_factory_loop_instances_stage_occupancy
      ON factory_loop_instances(project_id, loop_state)
      WHERE terminated_at IS NULL AND loop_state NOT IN ('IDLE');

    CREATE TABLE factory_decisions (
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
  `);
}

describe('PRIORITIZE short-circuit on empty intake', () => {
  let db;

  beforeEach(() => {
    vi.restoreAllMocks();
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryDecisions.setDb(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryLoopInstances.setDb(db);
  });

  afterEach(() => {
    factoryDecisions.setDb(null);
    factoryHealth.setDb(null);
    factoryIntake.setDb(null);
    factoryLoopInstances.setDb(null);
    db.close();
  });

  it('does not enter PLAN when PRIORITIZE returns no work item', async () => {
    const project = factoryHealth.registerProject({
      name: 'empty-intake-project',
      path: process.cwd(),
      trust_level: 'dark',
    });
    factoryHealth.updateProject(project.id, { status: 'running' });
    const instance = factoryLoopInstances.createInstance({ project_id: project.id });
    const prioritizeInstance = factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.PRIORITIZE,
    });
    const planSpy = vi.spyOn(loopController._internalForTests, 'executePlanStage');

    const result = await loopController._internalForTests.handlePrioritizeTransition({
      project: factoryHealth.getProject(project.id),
      instance: prioritizeInstance,
      currentState: LOOP_STATES.PRIORITIZE,
    });

    expect(planSpy).not.toHaveBeenCalled();
    expect(result.transitionReason).toBe('no_open_work_item');
    expect(result.nextState).toBe(LOOP_STATES.IDLE);
    expect(factoryLoopInstances.getInstance(instance.id).loop_state).toBe(LOOP_STATES.IDLE);

    const decision = db.prepare(`
      SELECT action, outcome_json
      FROM factory_decisions
      WHERE action = 'short_circuit_to_idle'
    `).get();
    expect(decision).toBeTruthy();
    expect(JSON.parse(decision.outcome_json)).toMatchObject({
      reason: 'no_open_work_item',
      from_state: LOOP_STATES.PRIORITIZE,
      to_state: LOOP_STATES.IDLE,
      consecutive_empty_cycles: 1,
    });
  });

  it('enters STARVED after repeated empty PRIORITIZE cycles', async () => {
    const project = factoryHealth.registerProject({
      name: 'starved-intake-project',
      path: `${process.cwd()}\\starved`,
      trust_level: 'dark',
    });
    factoryHealth.updateProject(project.id, {
      status: 'running',
      consecutive_empty_cycles: 2,
    });
    const instance = factoryLoopInstances.createInstance({ project_id: project.id });
    const prioritizeInstance = factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.PRIORITIZE,
    });

    const result = await loopController._internalForTests.handlePrioritizeTransition({
      project: factoryHealth.getProject(project.id),
      instance: prioritizeInstance,
      currentState: LOOP_STATES.PRIORITIZE,
    });

    expect(result.transitionReason).toBe('no_open_work_item');
    expect(result.nextState).toBe(LOOP_STATES.STARVED);
    expect(factoryLoopInstances.getInstance(instance.id).loop_state).toBe(LOOP_STATES.STARVED);
    expect(factoryHealth.getProject(project.id).consecutive_empty_cycles).toBe(3);

    const decision = db.prepare(`
      SELECT action, outcome_json
      FROM factory_decisions
      WHERE action = 'entered_starved'
    `).get();
    expect(decision).toBeTruthy();
    expect(JSON.parse(decision.outcome_json)).toMatchObject({
      reason: 'no_open_work_item',
      from_state: LOOP_STATES.PRIORITIZE,
      to_state: LOOP_STATES.STARVED,
      consecutive_empty_cycles: 3,
      threshold: 3,
    });
  });

  it('waits for cooling needs_replan-only intake without counting it as empty', async () => {
    const project = factoryHealth.registerProject({
      name: 'cooling-needs-replan-project',
      path: `${process.cwd()}\\cooling-replan`,
      trust_level: 'dark',
    });
    factoryHealth.updateProject(project.id, {
      status: 'running',
      consecutive_empty_cycles: 2,
    });
    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'scout',
      title: 'Cooling needs replan item',
      description: 'This item is cooling down before another plan attempt.',
      priority: 80,
      status: 'needs_replan',
    });
    db.prepare('UPDATE factory_work_items SET updated_at = ? WHERE id = ?')
      .run('2026-05-20 17:53:13', workItem.id);
    const instance = factoryLoopInstances.createInstance({ project_id: project.id });
    const prioritizeInstance = factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.PRIORITIZE,
    });
    const planSpy = vi.spyOn(loopController._internalForTests, 'executePlanStage');
    const dateNowSpy = vi.spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-05-20T17:54:42.000Z'));

    try {
      const result = await loopController._internalForTests.handlePrioritizeTransition({
        project: factoryHealth.getProject(project.id),
        instance: prioritizeInstance,
        currentState: LOOP_STATES.PRIORITIZE,
      });

      expect(planSpy).not.toHaveBeenCalled();
      expect(result.transitionReason).toBe('needs_replan_cooling');
      expect(result.nextState).toBe(LOOP_STATES.IDLE);
      expect(result.stageResult).toMatchObject({
        status: 'needs_replan_cooling',
        cooling_count: 1,
        cooling_work_item_ids: [workItem.id],
      });
      expect(factoryLoopInstances.getInstance(instance.id).loop_state).toBe(LOOP_STATES.IDLE);
      expect(factoryHealth.getProject(project.id).consecutive_empty_cycles).toBe(0);
      expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
        status: 'needs_replan',
        claimed_by_instance_id: null,
      });

      const waitDecision = db.prepare(`
        SELECT action, outcome_json
        FROM factory_decisions
        WHERE action = 'needs_replan_cooldown_wait'
      `).get();
      expect(waitDecision).toBeTruthy();
      expect(JSON.parse(waitDecision.outcome_json)).toMatchObject({
        reason: 'needs_replan_cooling',
        from_state: LOOP_STATES.PRIORITIZE,
        to_state: LOOP_STATES.IDLE,
        cooling_count: 1,
        cooling_work_item_ids: [workItem.id],
      });
      expect(db.prepare(`
        SELECT action
        FROM factory_decisions
        WHERE action IN ('short_circuit_to_idle', 'entered_starved')
      `).all()).toEqual([]);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
