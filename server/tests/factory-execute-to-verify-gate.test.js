'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryGuardrails = require('../db/factory-guardrails');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const routingModule = require('../handlers/integration/routing');
const awaitModule = require('../handlers/workflow/await');
const taskCore = require('../db/task-core');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES, getNextState, getGatesForTrustLevel } = require('../factory/loop-states');

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

async function advanceToExecute(projectId) {
  loopController.startLoopForProject(projectId);

  const senseAdvance = await loopController.advanceLoopForProject(projectId);
  expect(senseAdvance.new_state).toBe(LOOP_STATES.PRIORITIZE);
  expect(senseAdvance.paused_at_stage).toBe(LOOP_STATES.PRIORITIZE);

  loopController.approveGateForProject(projectId, LOOP_STATES.PRIORITIZE);

  const prioritizeAdvance = await loopController.advanceLoopForProject(projectId);
  expect(prioritizeAdvance.new_state).toBe(LOOP_STATES.EXECUTE);
}

describe('factory EXECUTE -> VERIFY gate semantics', () => {
  let db;
  let originalGetDbInstance;
  let tempDir;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    loopController.setWorktreeRunnerForTests(null);
    factoryHealth.setDb(db);
    factoryGuardrails.setDb(db);
    factoryIntake.setDb(db);
    factoryLoopInstances.setDb(db);
    factoryDecisions.setDb(db);
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-execute-to-verify-'));
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
    factoryGuardrails.setDb(null);
    factoryLoopInstances.setDb(null);
    factoryDecisions.setDb(null);
    factoryHealth.setDb(null);
    factoryIntake.setDb(null);
    loopController.setWorktreeRunnerForTests(null);
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

  function registerPlanProject() {
    const projectDir = path.join(tempDir, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const planPath = path.join(tempDir, `plan-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
    // Plan body must satisfy the plan-quality-gate: each task body needs
    // >=100 chars of concrete instruction, a file path reference, an
    // acceptance criterion (expect/assert/etc.), and no vague verbs
    // ("update") without object detail. Same pattern as commit 670552f5
    // in factory-loop-controller.test.
    fs.writeFileSync(planPath, `# Simulated plan

**Tech Stack:** Node.js, vitest.

## Task 1: Simulated task

- [ ] **Step 1: Implement the helper in plan-executor.js**

    Edit server/factory/plan-executor.js to add a \`runSimulatedFactoryStep(input)\` helper that returns \`{ ok: true, payload: input }\`. The helper must be exported alongside the existing public helpers without disturbing call sites. Acceptance criterion: \`expect(runSimulatedFactoryStep('seed').ok).toBe(true)\` in a colocated unit test.

- [ ] **Step 2: Commit the helper change**

    Run \`git add server/factory/plan-executor.js && git commit -m "feat: simulated task"\` after the helper lands. Acceptance criterion: \`git log -1 --format=%s\` reports the conventional-commit subject and the working tree is clean.
`);

    const project = factoryHealth.registerProject({
      name: 'Execute Verify Gate Project',
      path: projectDir,
      trust_level: 'supervised',
    });

    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'plan_file',
      title: 'Execute Verify Gate Item',
      description: 'Exercise VERIFY entry gating.',
      requestor: 'test',
      origin: {
        plan_path: planPath,
      },
    });

    return { project, workItem };
  }

  it('keeps VERIFY in supervised gates while allowing EXECUTE to enter VERIFY immediately', () => {
    expect(getGatesForTrustLevel('supervised')).toContain(LOOP_STATES.VERIFY);
    expect(getNextState(LOOP_STATES.EXECUTE, 'supervised', null)).toBe(LOOP_STATES.VERIFY);
    expect(getNextState(LOOP_STATES.VERIFY, 'supervised', null)).toBe(LOOP_STATES.PAUSED);
    expect(getNextState(LOOP_STATES.VERIFY, 'supervised', 'approved')).toBe(LOOP_STATES.LEARN);
  });

  it('enters VERIFY after successful EXECUTE and pauses only when leaving VERIFY', async () => {
    const { project } = registerPlanProject();

    await advanceToExecute(project.id);

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(executeAdvance.paused_at_stage).toBeNull();
    expect(executeAdvance.stage_result).toMatchObject({
      passed: true,
      batch_id: expect.any(String),
    });
    expect(loopController.getLoopStateForProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.VERIFY,
      loop_paused_at_stage: null,
    });

    const verifyAdvance = await loopController.advanceLoopForProject(project.id);
    expect(verifyAdvance.new_state).toBe(LOOP_STATES.LEARN);
    expect(verifyAdvance.paused_at_stage).toBeNull();
    // e8b750bf ("keep verified shipping state coherent") added a guard that
    // short-circuits a second VERIFY advance for the same batch — once a
    // 'verified_batch' decision is recorded, the rerun returns
    // {status: 'skipped', reason: 'batch_already_verified', batch_id}
    // instead of re-running the guardrail tests. The first advance still
    // produced the {passed: true} result (asserted on executeAdvance above),
    // so this captures the new "don't redo verify" semantics.
    expect(verifyAdvance.stage_result).toMatchObject({
      status: 'skipped',
      reason: 'batch_already_verified',
      batch_id: expect.any(String),
    });
    expect(loopController.getLoopStateForProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.LEARN,
      loop_paused_at_stage: null,
    });

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((row) => row.action === 'entered_from_execute')).toMatchObject({
      stage: 'verify',
      outcome: expect.objectContaining({
        from_state: LOOP_STATES.EXECUTE,
        to_state: LOOP_STATES.VERIFY,
      }),
    });
    // Only one verified_batch decision now — the second advance's
    // batch_already_verified short-circuit doesn't add another.
    expect(decisions.filter((row) => row.action === 'verified_batch')).toHaveLength(1);
  });

  // Regression: before 8171e04d, any exception from executor.execute (submit
  // failure, await timeout, fs ENOENT, anything) propagated unwrapped up to
  // runAdvanceLoop's generic .catch, which logged a bland warning and
  // scheduled auto_advance to retry after 30s. The instance state never
  // updated, no decision log, and the same failure spun every 30s forever.
  // The try/catch now surfaces the error as an `execute_exception` decision
  // with the real error text and pauses the instance at EXECUTE.
  it('pauses EXECUTE and emits execute_exception when the plan executor throws', async () => {
    const { project, workItem } = registerPlanProject();

    const failureMessage = 'simulated provider outage during task submit';
    routingModule.handleSmartSubmitTask = vi.fn(async () => {
      throw new Error(failureMessage);
    });

    await advanceToExecute(project.id);

    const executeAdvance = await loopController.advanceLoopForProject(project.id);

    // The instance pauses AT EXECUTE — loop_state stays EXECUTE, but
    // paused_at_stage is set. What matters: the tick / auto_advance won't
    // re-enter EXECUTE while paused_at_stage is set, so the spin is broken.
    expect(executeAdvance.paused_at_stage).toBe(LOOP_STATES.EXECUTE);
    expect(executeAdvance.reason).toBe('execute_exception');
    expect(executeAdvance.stage_result).toMatchObject({
      status: 'paused',
      reason: 'execute_exception',
      error: expect.stringContaining(failureMessage),
    });

    const projectState = loopController.getLoopStateForProject(project.id);
    expect(projectState.loop_paused_at_stage).toBe(LOOP_STATES.EXECUTE);

    const decisions = listDecisionRows(db, project.id);
    const exceptionDecision = decisions.find((row) => row.action === 'execute_exception');
    expect(exceptionDecision).toBeTruthy();
    expect(exceptionDecision).toMatchObject({
      stage: 'execute',
      outcome: expect.objectContaining({
        error: expect.stringContaining(failureMessage),
        next_state: LOOP_STATES.PAUSED,
        paused_at_stage: LOOP_STATES.EXECUTE,
      }),
    });

    const updated = factoryIntake.getWorkItem(workItem.id);
    expect(updated.status).toBe('in_progress');
    expect(updated.reject_reason).toMatch(/^execute_exception: /);
  });

  it('resumes a paused VERIFY gate at VERIFY', () => {
    const { project } = registerPlanProject();

    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.PAUSED,
      loop_paused_at_stage: LOOP_STATES.VERIFY,
    });

    const approved = loopController.approveGateForProject(project.id, LOOP_STATES.VERIFY);

    expect(approved).toMatchObject({
      project_id: project.id,
      state: LOOP_STATES.VERIFY,
    });
    expect(loopController.getLoopStateForProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.VERIFY,
      loop_paused_at_stage: null,
    });

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((row) => row.action === 'gate_approved')).toMatchObject({
      stage: 'verify',
      outcome: expect.objectContaining({
        approved_stage: LOOP_STATES.VERIFY,
        to_state: LOOP_STATES.VERIFY,
      }),
    });
  });

  it('resumes a paused EXECUTE gate at EXECUTE', () => {
    const { project } = registerPlanProject();

    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.PAUSED,
      loop_paused_at_stage: LOOP_STATES.EXECUTE,
    });

    const approved = loopController.approveGateForProject(project.id, LOOP_STATES.EXECUTE);

    expect(approved).toMatchObject({
      project_id: project.id,
      state: LOOP_STATES.EXECUTE,
    });
    expect(loopController.getLoopStateForProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.EXECUTE,
      loop_paused_at_stage: null,
    });

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((row) => row.action === 'gate_approved')).toMatchObject({
      stage: 'execute',
      outcome: expect.objectContaining({
        approved_stage: LOOP_STATES.EXECUTE,
        to_state: LOOP_STATES.EXECUTE,
      }),
    });
  });
});
