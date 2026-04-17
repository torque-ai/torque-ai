import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

vi.mock('../event-bus', async () => {
  const actual = await vi.importActual('../event-bus');
  return {
    ...actual,
    emitTaskEvent: vi.fn(),
  };
});

const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryFeedback = require('../db/factory-feedback');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const architectRunner = require('../factory/architect-runner');
const eventBus = require('../event-bus');
const factoryTick = require('../factory/factory-tick');
const guardrailRunner = require('../factory/guardrail-runner');
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
      claimed_by_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fwi_project_status
      ON factory_work_items(project_id, status);

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

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function registerPrioritizeProject(trust_level = 'autonomous') {
  const project = factoryHealth.registerProject({
    name: `Loop Async ${Math.random().toString(16).slice(2)}`,
    path: path.join(os.tmpdir(), `factory-loop-async-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    trust_level,
  });

  factoryIntake.createWorkItem({
    project_id: project.id,
    source: 'manual',
    title: 'Async loop work item',
    description: 'Exercise PRIORITIZE -> PLAN background execution.',
    requestor: 'test',
  });

  factoryHealth.updateProject(project.id, {
    loop_state: LOOP_STATES.PRIORITIZE,
    loop_last_action_at: new Date().toISOString(),
    loop_paused_at_stage: null,
  });

  return factoryHealth.getProject(project.id);
}

async function waitForJobStatus(projectId, jobId, expectedStatus) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = loopController.getLoopAdvanceJobStatusForProject(projectId, jobId);
    if (status?.status === expectedStatus) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for loop job ${jobId} to reach ${expectedStatus}`);
}

async function waitForProjectTermination(projectId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = loopController.getLoopStateForProject(projectId);
    const instances = factoryLoopInstances.listInstances({
      project_id: projectId,
      active_only: false,
    });
    if (state.loop_state === LOOP_STATES.IDLE && loopController.getActiveInstances(projectId).length === 0) {
      return { state, instances };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for project ${projectId} to terminate`);
}

async function waitForProjectPause(projectId, pausedAtStage) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = loopController.getLoopStateForProject(projectId);
    if (state.loop_state === LOOP_STATES.PAUSED && state.loop_paused_at_stage === pausedAtStage) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for project ${projectId} to pause at ${pausedAtStage}`);
}

function insertBatchTask(db, { taskId, batchId, status }) {
  db.prepare(`
    INSERT INTO tasks (id, status, tags)
    VALUES (?, ?, ?)
  `).run(taskId, status, JSON.stringify([`factory:batch_id=${batchId}`]));
}

function registerWaitingVerifyProject(trust_level = 'dark') {
  const project = factoryHealth.registerProject({
    name: `Loop Verify Wait ${Math.random().toString(16).slice(2)}`,
    path: path.join(os.tmpdir(), `factory-loop-verify-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    trust_level,
  });
  factoryHealth.updateProject(project.id, { status: 'running' });

  const batchId = `factory-${project.id}-verify-wait`;
  const instance = factoryLoopInstances.createInstance({
    project_id: project.id,
    batch_id: batchId,
  });
  factoryLoopInstances.updateInstance(instance.id, {
    loop_state: LOOP_STATES.VERIFY,
    paused_at_stage: LOOP_STATES.VERIFY,
    batch_id: batchId,
    last_action_at: new Date().toISOString(),
  });
  factoryHealth.updateProject(project.id, {
    status: 'running',
    loop_state: LOOP_STATES.PAUSED,
    loop_batch_id: batchId,
    loop_paused_at_stage: LOOP_STATES.VERIFY,
  });
  factoryDecisions.recordDecision({
    project_id: project.id,
    stage: 'verify',
    actor: 'verifier',
    action: 'waiting_for_batch_tasks',
    reasoning: 'VERIFY is waiting for non-terminal batch tasks to finish.',
    outcome: {
      batch_id: batchId,
      pending_count: 1,
    },
    confidence: 1,
    batch_id: batchId,
  });

  return {
    project: factoryHealth.getProject(project.id),
    batchId,
  };
}

describe('factory loop async jobs', () => {
  let db;
  let originalGetDbInstance;
  let runArchitectCycleSpy;
  let runPostBatchChecksSpy;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryLoopInstances.setDb(db);
    factoryDecisions.setDb(db);
    factoryFeedback.setDb(db);
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
    runArchitectCycleSpy = vi.spyOn(architectRunner, 'runArchitectCycle');
    runPostBatchChecksSpy = vi.spyOn(guardrailRunner, 'runPostBatchChecks').mockReturnValue({
      passed: true,
      status: 'passed',
    });
  });

  afterEach(() => {
    runArchitectCycleSpy.mockRestore();
    runPostBatchChecksSpy.mockRestore();
    database.getDbInstance = originalGetDbInstance;
    factoryTick.stopAll('test_cleanup');
    factoryFeedback.setDb(null);
    factoryLoopInstances.setDb(null);
    factoryDecisions.setDb(null);
    factoryHealth.setDb(null);
    factoryIntake.setDb(null);
    db.close();
    db = null;
  });

  it('returns a job descriptor immediately and reports running then completed status', async () => {
    let resolveCycle;
    runArchitectCycleSpy.mockImplementation(() => new Promise((resolve) => {
      resolveCycle = resolve;
    }));
    const project = registerPrioritizeProject('autonomous');

    const descriptor = loopController.advanceLoopAsyncForProject(project.id);

    expect(descriptor).toMatchObject({
      job_id: expect.any(String),
      current_state: LOOP_STATES.PRIORITIZE,
      status: 'running',
      completed_at: null,
    });

    const running = loopController.getLoopAdvanceJobStatusForProject(project.id, descriptor.job_id);
    expect(running).toMatchObject({
      job_id: descriptor.job_id,
      status: 'running',
      current_state: LOOP_STATES.PRIORITIZE,
      completed_at: null,
      error: null,
    });

    resolveCycle({ id: 'cycle-async-1', summary: 'architect complete' });

    const completed = await waitForJobStatus(project.id, descriptor.job_id, 'completed');
    expect(completed).toMatchObject({
      job_id: descriptor.job_id,
      status: 'completed',
      new_state: LOOP_STATES.PLAN,
      paused_at_stage: null,
      reason: 'architect cycle completed',
      error: null,
    });
    expect(completed.stage_result).toMatchObject({
      id: 'cycle-async-1',
      summary: 'architect complete',
    });
  });

  it('records failed status and error details when the stage throws', async () => {
    runArchitectCycleSpy.mockRejectedValue(new Error('architect unavailable'));
    const project = registerPrioritizeProject('autonomous');

    const descriptor = loopController.advanceLoopAsyncForProject(project.id);
    const failed = await waitForJobStatus(project.id, descriptor.job_id, 'failed');

    expect(failed).toMatchObject({
      job_id: descriptor.job_id,
      status: 'failed',
      new_state: LOOP_STATES.PLAN,
      paused_at_stage: null,
      error: 'architect unavailable',
    });
  });

  it('re-drives waiting VERIFY from terminal task events and finishes the autonomous loop', async () => {
    const { project, batchId } = registerWaitingVerifyProject('dark');
    const taskId = 'verify-batch-task-1';
    insertBatchTask(db, {
      taskId,
      batchId,
      status: 'queued',
    });

    factoryTick.tickProject(project.id);

    await waitForProjectPause(project.id, LOOP_STATES.VERIFY);
    expect(loopController.getLoopStateForProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.PAUSED,
      loop_paused_at_stage: LOOP_STATES.VERIFY,
    });

    db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(taskId);
    eventBus.emitTaskUpdated({
      taskId,
      status: 'completed',
      updated_task: {
        id: taskId,
        status: 'completed',
        tags: JSON.stringify([`factory:batch_id=${batchId}`]),
      },
    });

    const { state, instances } = await waitForProjectTermination(project.id);

    expect(state).toMatchObject({
      loop_state: LOOP_STATES.IDLE,
      loop_paused_at_stage: null,
    });
    expect(instances).toEqual(expect.arrayContaining([
      expect.objectContaining({
        project_id: project.id,
        loop_state: LOOP_STATES.LEARN,
        terminated_at: expect.any(String),
      }),
    ]));

    const decisionActions = db.prepare(`
      SELECT action
      FROM factory_decisions
      WHERE project_id = ?
      ORDER BY id ASC
    `).all(project.id).map((row) => row.action);
    expect(decisionActions).toEqual(expect.arrayContaining([
      'waiting_for_batch_tasks',
      'verified_batch',
      'learned',
    ]));
  });
});
