import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const routingModule = require('../handlers/integration/routing');
const awaitModule = require('../handlers/workflow/await');
const taskCore = require('../db/task-core');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');

const originalHandleSmartSubmitTask = routingModule.handleSmartSubmitTask;
const originalHandleAwaitTask = awaitModule.handleAwaitTask;
const originalGetTask = taskCore.getTask;

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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fwi_project_status
      ON factory_work_items(project_id, status);

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

    CREATE INDEX IF NOT EXISTS idx_fd_project_time
      ON factory_decisions(project_id, created_at);
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

async function advanceSupervisedPlanProject(projectId) {
  loopController.startLoop(projectId);

  const senseAdvance = await loopController.advanceLoop(projectId);
  expect(senseAdvance.new_state).toBe(LOOP_STATES.PAUSED);
  expect(senseAdvance.paused_at_stage).toBe(LOOP_STATES.PRIORITIZE);

  loopController.approveGate(projectId, LOOP_STATES.PRIORITIZE);

  const prioritizeAdvance = await loopController.advanceLoop(projectId);
  expect(prioritizeAdvance.new_state).toBe(LOOP_STATES.EXECUTE);
}

describe('factory loop-controller EXECUTE modes', () => {
  let db;
  let originalGetDbInstance;
  let tempDir;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryDecisions.setDb(db);
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-loop-controller-'));
    routingModule.handleSmartSubmitTask = vi.fn(async () => ({ task_id: 'live-task-id' }));
    awaitModule.handleAwaitTask = vi.fn(async () => ({ content: [{ text: 'awaited' }] }));
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'completed',
      error_output: null,
    }));
  });

  afterEach(() => {
    database.getDbInstance = originalGetDbInstance;
    factoryDecisions.setDb(null);
    routingModule.handleSmartSubmitTask = originalHandleSmartSubmitTask;
    awaitModule.handleAwaitTask = originalHandleAwaitTask;
    taskCore.getTask = originalGetTask;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    db.close();
    db = null;
    tempDir = null;
  });

  function registerPlanProject({ config } = {}) {
    const projectDir = path.join(tempDir, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const planPath = path.join(tempDir, `plan-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
    fs.writeFileSync(planPath, `# Simulated plan

**Tech Stack:** Node.js, vitest.

## Task 1: Simulated task

- [ ] **Step 1: Update files**

    Edit server/factory/plan-executor.js.

- [ ] **Step 2: Commit**

    git commit -m "feat: simulated task"
`);

    const project = factoryHealth.registerProject({
      name: 'Loop Controller Dry Run Project',
      path: projectDir,
      trust_level: 'supervised',
      config,
    });

    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'plan_file',
      title: 'Dry-run plan item',
      description: 'Exercise EXECUTE safely.',
      requestor: 'test',
      origin: {
        plan_path: planPath,
      },
    });

    return { project, workItem, planPath };
  }

  it('defaults supervised EXECUTE to pending approval and records held task submissions', async () => {
    const { project, workItem, planPath } = registerPlanProject();
    const before = fs.readFileSync(planPath, 'utf8');

    await advanceSupervisedPlanProject(project.id);
    const executeAdvance = await loopController.advanceLoop(project.id);

    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(executeAdvance.paused_at_stage).toBeNull();
    expect(executeAdvance.stage_result).toEqual({
      status: 'skipped',
      reason: 'no_batch_id',
    });
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      id: workItem.id,
      status: 'verifying',
    });
    expect(fs.readFileSync(planPath, 'utf8')).toBe(before);
    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalledTimes(1);
    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      initial_status: 'pending_approval',
      tags: expect.arrayContaining([
        `factory:batch_id=factory-${project.id}-${workItem.id}`,
        `factory:work_item_id=${workItem.id}`,
        'factory:plan_task_number=1',
        'factory:pending_approval',
      ]),
    }));
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();

    const decisions = listDecisionRows(db, project.id);
    const dryRunDecision = decisions.find((row) => row.action === 'dry_run_task');
    const completedDecision = decisions.find((row) => row.action === 'completed_execution');
    const enteredVerifyDecision = decisions.find((row) => row.action === 'entered_from_execute');

    expect(dryRunDecision).toMatchObject({
      stage: 'execute',
    });
    expect(dryRunDecision.inputs).toMatchObject({
      work_item_id: workItem.id,
      dry_run: true,
      simulated: false,
      execution_mode: 'pending_approval',
      task_number: 1,
      task_title: 'Simulated task',
    });
    expect(dryRunDecision.outcome).toMatchObject({
      plan_path: planPath,
      dry_run: true,
      simulated: false,
      execution_mode: 'pending_approval',
      initial_status: 'pending_approval',
      held_for_approval: true,
      task_id: 'live-task-id',
      task_number: 1,
      task_title: 'Simulated task',
      file_paths: ['server/factory/plan-executor.js'],
    });
    expect(dryRunDecision.outcome.planned_task_description).toContain('Task 1: Simulated task');
    expect(completedDecision.outcome).toMatchObject({
      dry_run: true,
      execution_mode: 'pending_approval',
      task_count: 1,
      simulated: false,
      submitted_tasks: [{ task_number: 1, task_id: 'live-task-id' }],
      plan_path: planPath,
    });
    expect(enteredVerifyDecision).toMatchObject({
      stage: 'verify',
      outcome: expect.objectContaining({
        from_state: LOOP_STATES.EXECUTE,
        to_state: LOOP_STATES.VERIFY,
      }),
    });
  });

  it('keeps pure suppression available when config.execute_mode is suppress', async () => {
    const { project, workItem, planPath } = registerPlanProject({
      config: { execute_mode: 'suppress' },
    });
    const before = fs.readFileSync(planPath, 'utf8');

    await advanceSupervisedPlanProject(project.id);
    const executeAdvance = await loopController.advanceLoop(project.id);

    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(fs.readFileSync(planPath, 'utf8')).toBe(before);
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();

    const decisions = listDecisionRows(db, project.id);
    const dryRunDecision = decisions.find((row) => row.action === 'dry_run_task');
    const completedDecision = decisions.find((row) => row.action === 'completed_execution');

    expect(dryRunDecision.inputs).toMatchObject({
      work_item_id: workItem.id,
      dry_run: true,
      simulated: true,
      execution_mode: 'suppress',
      task_number: 1,
    });
    expect(dryRunDecision.outcome).toMatchObject({
      plan_path: planPath,
      dry_run: true,
      simulated: true,
      execution_mode: 'suppress',
      held_for_approval: false,
      initial_status: null,
      task_id: null,
    });
    expect(completedDecision.outcome).toMatchObject({
      dry_run: true,
      execution_mode: 'suppress',
      task_count: 1,
      simulated: true,
      submitted_tasks: [],
      plan_path: planPath,
    });
  });

  it('allows supervised live EXECUTE only when config.execute_live is true', async () => {
    const { project, planPath } = registerPlanProject({
      config: { execute_live: true },
    });

    await advanceSupervisedPlanProject(project.id);
    const executeAdvance = await loopController.advanceLoop(project.id);

    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(executeAdvance.paused_at_stage).toBeNull();
    expect(executeAdvance.stage_result).toEqual({
      status: 'skipped',
      reason: 'no_batch_id',
    });
    const updatedPlan = fs.readFileSync(planPath, 'utf8');
    expect(updatedPlan).toContain('- [x] **Step 1: Update files**');
    expect(updatedPlan).toContain('- [x] **Step 2: Commit**');

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((row) => row.action === 'dry_run_task')).toBeUndefined();
    const completedDecision = decisions.find((row) => row.action === 'completed_execution');
    const enteredVerifyDecision = decisions.find((row) => row.action === 'entered_from_execute');
    expect(completedDecision.outcome).toMatchObject({
      dry_run: false,
      execution_mode: 'live',
      task_count: null,
      simulated: false,
      plan_path: planPath,
    });
    expect(enteredVerifyDecision).toMatchObject({
      stage: 'verify',
      outcome: expect.objectContaining({
        from_state: LOOP_STATES.EXECUTE,
        to_state: LOOP_STATES.VERIFY,
      }),
    });
  });
});
