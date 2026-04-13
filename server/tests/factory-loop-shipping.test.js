import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));

const Database = require('better-sqlite3');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryFeedback = require('../db/factory-feedback');
const guardrailDb = require('../db/factory-guardrails');
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

    CREATE INDEX IF NOT EXISTS idx_fd_project_time
      ON factory_decisions(project_id, created_at);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

function registerPausedVerifyProject({ workItemStatus, batchId }) {
  const project = factoryHealth.registerProject({
    name: `Factory Loop Shipping ${Date.now()}`,
    path: `/tmp/factory-loop-shipping-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    trust_level: 'supervised',
  });

  const workItem = factoryIntake.createWorkItem({
    project_id: project.id,
    source: 'manual',
    title: 'Add behavioral tests for factory scorers',
    description: 'Regression coverage for the scorer selection path.',
    requestor: 'test',
  });

  const updatedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
    status: workItemStatus,
    batch_id: batchId,
  });

  factoryHealth.updateProject(project.id, {
    loop_state: LOOP_STATES.PAUSED,
    loop_paused_at_stage: LOOP_STATES.VERIFY,
    loop_batch_id: batchId,
  });

  return { project, workItem: updatedWorkItem };
}

function recordExecutionDecision({
  projectId,
  batchId,
  workItemId,
  action,
  reasoning,
  outcome,
}) {
  return factoryDecisions.recordDecision({
    project_id: projectId,
    stage: 'execute',
    actor: 'executor',
    action,
    reasoning,
    inputs: {
      work_item_id: workItemId,
    },
    outcome: {
      work_item_id: workItemId,
      ...outcome,
    },
    confidence: 1,
    batch_id: batchId,
  });
}

function seedLearnDependencies(projectId, batchId) {
  factoryHealth.recordSnapshot({
    project_id: projectId,
    dimension: 'test_coverage',
    score: 62,
    batch_id: 'batch-before',
  });
  factoryHealth.recordSnapshot({
    project_id: projectId,
    dimension: 'test_coverage',
    score: 74,
    batch_id: batchId,
  });
  guardrailDb.recordEvent({
    project_id: projectId,
    category: 'quality',
    check_name: 'post_batch_checks',
    status: 'pass',
    batch_id: batchId,
    details: { passed: 1, failed: 0 },
  });
}

function insertBatchTask(db, { taskId, batchId, status }) {
  db.prepare(`
    INSERT INTO tasks (id, status, tags)
    VALUES (?, ?, ?)
  `).run(taskId, status, JSON.stringify([
    `factory:batch_id=${batchId}`,
    'factory:pending_approval',
  ]));
}

describe('factory loop work-item shipping', () => {
  let db;
  let originalGetDbInstance;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryDecisions.setDb(db);
    factoryFeedback.setDb(db);
    guardrailDb.setDb(db);
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
  });

  afterEach(() => {
    database.getDbInstance = originalGetDbInstance;
    factoryDecisions.setDb(null);
    factoryFeedback.setDb(null);
    guardrailDb.setDb(null);
    db.close();
    db = null;
  });

  it('marks the selected work item as shipped after LEARN completes with a successful EXECUTE result', async () => {
    const batchId = 'batch-ship-success';
    const { project, workItem } = registerPausedVerifyProject({
      workItemStatus: 'verifying',
      batchId,
    });
    seedLearnDependencies(project.id, batchId);

    recordExecutionDecision({
      projectId: project.id,
      batchId,
      workItemId: workItem.id,
      action: 'started_execution',
      reasoning: 'Loop advanced into EXECUTE.',
      outcome: {
        from_state: 'PLAN',
        to_state: 'EXECUTE',
      },
    });
    recordExecutionDecision({
      projectId: project.id,
      batchId,
      workItemId: workItem.id,
      action: 'completed_execution',
      reasoning: 'Plan execution completed successfully.',
      outcome: {
        completed_tasks: [1],
        dry_run: false,
        execution_mode: 'live',
        task_count: null,
        simulated: false,
        submitted_tasks: [],
        final_state: 'VERIFY',
      },
    });

    const approved = loopController.approveGate(project.id, LOOP_STATES.VERIFY);
    expect(approved.state).toBe(LOOP_STATES.LEARN);

    const result = await loopController.advanceLoop(project.id);

    expect(result.previous_state).toBe(LOOP_STATES.LEARN);
    expect(result.new_state).toBe(LOOP_STATES.IDLE);
    expect(result.stage_result).toEqual(
      expect.objectContaining({
        feedback_id: expect.any(Number),
        summary: expect.any(String),
      })
    );
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      id: workItem.id,
      status: 'shipped',
    });

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((row) => row.stage === 'learn' && row.action === 'learned')).toBeTruthy();
    expect(decisions.find((row) => row.stage === 'learn' && row.action === 'shipped_work_item')).toMatchObject({
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        new_status: 'shipped',
        reason: 'execute_completed_successfully',
      }),
    });
    expect(decisions.find((row) => row.stage === 'learn' && row.action === 'skipped_shipping')).toBeUndefined();
  });

  it('leaves the work item open and records skipped_shipping when EXECUTE previously failed', async () => {
    const batchId = 'batch-ship-failure';
    const { project, workItem } = registerPausedVerifyProject({
      workItemStatus: 'in_progress',
      batchId,
    });
    seedLearnDependencies(project.id, batchId);

    recordExecutionDecision({
      projectId: project.id,
      batchId,
      workItemId: workItem.id,
      action: 'started_execution',
      reasoning: 'Loop advanced into EXECUTE.',
      outcome: {
        from_state: 'PLAN',
        to_state: 'EXECUTE',
      },
    });
    recordExecutionDecision({
      projectId: project.id,
      batchId,
      workItemId: workItem.id,
      action: 'execution_failed',
      reasoning: 'Task 1 failed.',
      outcome: {
        failed_task: 1,
        final_state: 'IDLE',
      },
    });

    const approved = loopController.approveGate(project.id, LOOP_STATES.VERIFY);
    expect(approved.state).toBe(LOOP_STATES.LEARN);

    const result = await loopController.advanceLoop(project.id);

    expect(result.previous_state).toBe(LOOP_STATES.LEARN);
    expect(result.new_state).toBe(LOOP_STATES.IDLE);
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      id: workItem.id,
      status: 'in_progress',
    });

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((row) => row.stage === 'learn' && row.action === 'shipped_work_item')).toBeUndefined();
    expect(decisions.find((row) => row.stage === 'learn' && row.action === 'skipped_shipping')).toMatchObject({
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        reason: 'task_1_failed',
        execution_action: 'execution_failed',
      }),
    });
  });

  it('ships the selected work item after LEARN when all pending-approval batch tasks completed', async () => {
    const batchId = 'batch-pending-approval-complete';
    const { project, workItem } = registerPausedVerifyProject({
      workItemStatus: 'verifying',
      batchId,
    });
    seedLearnDependencies(project.id, batchId);

    recordExecutionDecision({
      projectId: project.id,
      batchId,
      workItemId: workItem.id,
      action: 'started_execution',
      reasoning: 'Loop advanced into EXECUTE.',
      outcome: {
        from_state: 'PLAN',
        to_state: 'EXECUTE',
        batch_id: batchId,
      },
    });
    recordExecutionDecision({
      projectId: project.id,
      batchId,
      workItemId: workItem.id,
      action: 'completed_execution',
      reasoning: 'Pending approval tasks were submitted successfully.',
      outcome: {
        completed_tasks: [1, 2],
        dry_run: true,
        execution_mode: 'pending_approval',
        task_count: 2,
        simulated: false,
        submitted_tasks: [
          { task_number: 1, task_id: 'approval-task-1' },
          { task_number: 2, task_id: 'approval-task-2' },
        ],
        final_state: 'VERIFY',
      },
    });
    insertBatchTask(db, { taskId: 'approval-task-1', batchId, status: 'completed' });
    insertBatchTask(db, { taskId: 'approval-task-2', batchId, status: 'completed' });

    const approved = loopController.approveGate(project.id, LOOP_STATES.VERIFY);
    expect(approved.state).toBe(LOOP_STATES.LEARN);

    const result = await loopController.advanceLoop(project.id);

    expect(result.previous_state).toBe(LOOP_STATES.LEARN);
    expect(result.new_state).toBe(LOOP_STATES.IDLE);
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      id: workItem.id,
      status: 'shipped',
    });

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((row) => row.stage === 'learn' && row.action === 'shipped_work_item')).toMatchObject({
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        new_status: 'shipped',
        reason: 'execute_completed_successfully',
      }),
    });
  });

  it('keeps the selected work item open when pending-approval batch tasks are still in progress', async () => {
    const batchId = 'batch-pending-approval-queued';
    const { project, workItem } = registerPausedVerifyProject({
      workItemStatus: 'verifying',
      batchId,
    });
    seedLearnDependencies(project.id, batchId);

    recordExecutionDecision({
      projectId: project.id,
      batchId,
      workItemId: workItem.id,
      action: 'started_execution',
      reasoning: 'Loop advanced into EXECUTE.',
      outcome: {
        from_state: 'PLAN',
        to_state: 'EXECUTE',
        batch_id: batchId,
      },
    });
    recordExecutionDecision({
      projectId: project.id,
      batchId,
      workItemId: workItem.id,
      action: 'completed_execution',
      reasoning: 'Pending approval tasks were submitted successfully.',
      outcome: {
        completed_tasks: [1, 2],
        dry_run: true,
        execution_mode: 'pending_approval',
        task_count: 2,
        simulated: false,
        submitted_tasks: [
          { task_number: 1, task_id: 'approval-task-3' },
          { task_number: 2, task_id: 'approval-task-4' },
        ],
        final_state: 'VERIFY',
      },
    });
    insertBatchTask(db, { taskId: 'approval-task-3', batchId, status: 'completed' });
    insertBatchTask(db, { taskId: 'approval-task-4', batchId, status: 'queued' });

    const approved = loopController.approveGate(project.id, LOOP_STATES.VERIFY);
    expect(approved.state).toBe(LOOP_STATES.LEARN);

    const result = await loopController.advanceLoop(project.id);

    expect(result.previous_state).toBe(LOOP_STATES.LEARN);
    expect(result.new_state).toBe(LOOP_STATES.IDLE);
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      id: workItem.id,
      status: 'verifying',
    });

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((row) => row.stage === 'learn' && row.action === 'shipped_work_item')).toBeUndefined();
    expect(decisions.find((row) => row.stage === 'learn' && row.action === 'skipped_shipping')).toMatchObject({
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        reason: 'pending_approval_in_progress',
        execution_action: 'completed_execution',
      }),
    });
  });
});
