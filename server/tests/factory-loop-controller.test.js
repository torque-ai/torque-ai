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
const factoryWorktrees = require('../db/factory-worktrees');
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
    CREATE TABLE IF NOT EXISTS vc_worktrees (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      feature_name TEXT,
      base_branch TEXT DEFAULT 'main',
      status TEXT DEFAULT 'active',
      commit_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity_at TEXT
    );

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

    CREATE TABLE IF NOT EXISTS factory_worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id),
      batch_id TEXT NOT NULL,
      vc_worktree_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      merged_at TEXT,
      abandoned_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_factory_worktrees_project_active
      ON factory_worktrees(project_id, status);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_worktrees_branch
      ON factory_worktrees(branch);

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
  loopController.startLoopForProject(projectId);

  const senseAdvance = await loopController.advanceLoopForProject(projectId);
  expect(senseAdvance.new_state).toBe(LOOP_STATES.PRIORITIZE);
  expect(senseAdvance.paused_at_stage).toBe(LOOP_STATES.PRIORITIZE);

  loopController.approveGateForProject(projectId, LOOP_STATES.PRIORITIZE);

  const prioritizeAdvance = await loopController.advanceLoopForProject(projectId);
  expect(prioritizeAdvance.new_state).toBe(LOOP_STATES.EXECUTE);
}

function loadFreshFactoryWorktrees() {
  const modulePath = require.resolve('../db/factory-worktrees');
  delete require.cache[modulePath];
  return require('../db/factory-worktrees');
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

describe('factory loop-controller EXECUTE modes', () => {
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
    factoryWorktrees.setDb(db);
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
    factoryHealth.setDb(null);
    factoryGuardrails.setDb(null);
    factoryIntake.setDb(null);
    factoryLoopInstances.setDb(null);
    factoryDecisions.setDb(null);
    factoryWorktrees.setDb(null);
    routingModule.handleSmartSubmitTask = originalHandleSmartSubmitTask;
    awaitModule.handleAwaitTask = originalHandleAwaitTask;
    taskCore.getTask = originalGetTask;
    loopController.setWorktreeRunnerForTests(null);
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
    const executeAdvance = await loopController.advanceLoopForProject(project.id);

    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(executeAdvance.paused_at_stage).toBeNull();
    expect(executeAdvance.stage_result).toMatchObject({
      passed: true,
      batch_id: expect.any(String),
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
    const executeAdvance = await loopController.advanceLoopForProject(project.id);

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
    const executeAdvance = await loopController.advanceLoopForProject(project.id);

    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(executeAdvance.paused_at_stage).toBeNull();
    expect(executeAdvance.stage_result).toMatchObject({
      passed: true,
      batch_id: expect.any(String),
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

  it('reruns VERIFY after approveGate when pending-approval batch tasks become terminal', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-verify-pass',
        branch: 'feat/factory-verify-pass',
        worktreePath: path.join(project.path, '.worktrees', 'feat-factory-verify-pass'),
      })),
      verify: vi.fn(async () => ({
        passed: true,
        output: 'ok',
        durationMs: 18,
      })),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedTaskCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async (args) => {
      submittedTaskCount += 1;
      const taskId = `approval-task-${submittedTaskCount}`;
      insertBatchTask(db, {
        taskId,
        batchId,
        status: args.initial_status || 'pending_approval',
      });
      return { task_id: taskId };
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    const executeAdvance = await loopController.advanceLoopForProject(project.id);

    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(executeAdvance.paused_at_stage).toBe(LOOP_STATES.VERIFY);
    expect(executeAdvance.reason).toBe('batch_tasks_not_terminal');
    expect(worktreeRunner.verify).not.toHaveBeenCalled();

    db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run('approval-task-1');

    const approved = loopController.approveGateForProject(project.id, LOOP_STATES.VERIFY);
    expect(approved.state).toBe(LOOP_STATES.VERIFY);
    expect(loopController.getLoopStateForProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.VERIFY,
      loop_paused_at_stage: null,
    });

    const verifyAdvance = await loopController.advanceLoopForProject(project.id);

    expect(worktreeRunner.verify).toHaveBeenCalledTimes(1);
    expect(worktreeRunner.verify).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'feat/factory-verify-pass',
      worktreePath: path.join(project.path, '.worktrees', 'feat-factory-verify-pass'),
    }));
    expect(verifyAdvance.previous_state).toBe(LOOP_STATES.VERIFY);
    expect(verifyAdvance.new_state).toBe(LOOP_STATES.LEARN);
    expect(verifyAdvance.paused_at_stage).toBeNull();

    const decisions = listDecisionRows(db, project.id);
    const verifyApproved = decisions.filter((row) => row.action === 'gate_approved').pop();
    expect(verifyApproved).toMatchObject({
      stage: 'verify',
      outcome: expect.objectContaining({
        approved_stage: LOOP_STATES.VERIFY,
        to_state: LOOP_STATES.VERIFY,
      }),
    });
    expect(decisions.find((row) => row.action === 'worktree_verify_passed')).toMatchObject({
      stage: 'verify',
      outcome: expect.objectContaining({
        branch: 'feat/factory-verify-pass',
      }),
    });
  });

  it('pauses at VERIFY_FAIL when rerun VERIFY fails after gate approval', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-verify-fail',
        branch: 'feat/factory-verify-fail',
        worktreePath: path.join(project.path, '.worktrees', 'feat-factory-verify-fail'),
      })),
      verify: vi.fn(async () => ({
        passed: false,
        output: 'tests failed',
        durationMs: 22,
      })),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedTaskCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async (args) => {
      submittedTaskCount += 1;
      const taskId = `approval-task-fail-${submittedTaskCount}`;
      insertBatchTask(db, {
        taskId,
        batchId,
        status: args.initial_status || 'pending_approval',
      });
      return { task_id: taskId };
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    const executeAdvance = await loopController.advanceLoopForProject(project.id);

    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(executeAdvance.paused_at_stage).toBe(LOOP_STATES.VERIFY);
    expect(worktreeRunner.verify).not.toHaveBeenCalled();

    db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run('approval-task-fail-1');

    const approved = loopController.approveGateForProject(project.id, LOOP_STATES.VERIFY);
    expect(approved.state).toBe(LOOP_STATES.VERIFY);

    const verifyAdvance = await loopController.advanceLoopForProject(project.id);

    expect(worktreeRunner.verify).toHaveBeenCalledTimes(1);
    expect(verifyAdvance.previous_state).toBe(LOOP_STATES.VERIFY);
    expect(verifyAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(verifyAdvance.paused_at_stage).toBe('VERIFY_FAIL');
    expect(verifyAdvance.reason).toBe('worktree_verify_failed');
    expect(loopController.getLoopStateForProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.PAUSED,
      loop_paused_at_stage: 'VERIFY_FAIL',
    });
  });

  it('throws when retryVerifyFromFailure is called outside VERIFY_FAIL', () => {
    const { project } = registerPlanProject();
    loopController.startLoopForProject(project.id);

    expect(() => loopController.retryVerifyFromFailureForProject(project.id)).toThrow('Loop is not paused at VERIFY_FAIL');
  });

  it('retryVerifyFromFailure resets loop state to VERIFY and clears the paused stage', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-verify-retry-reset',
        branch: 'feat/factory-verify-retry-reset',
        worktreePath: path.join(project.path, '.worktrees', 'feat-factory-verify-retry-reset'),
      })),
      verify: vi.fn(async () => ({
        passed: false,
        output: 'tests failed',
        durationMs: 20,
      })),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedTaskCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async (args) => {
      submittedTaskCount += 1;
      const taskId = `approval-task-retry-reset-${submittedTaskCount}`;
      insertBatchTask(db, {
        taskId,
        batchId,
        status: args.initial_status || 'pending_approval',
      });
      return { task_id: taskId };
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    await loopController.advanceLoopForProject(project.id);
    db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run('approval-task-retry-reset-1');
    loopController.approveGateForProject(project.id, LOOP_STATES.VERIFY);

    const failedVerify = await loopController.advanceLoopForProject(project.id);
    expect(failedVerify.paused_at_stage).toBe('VERIFY_FAIL');
    expect(loopController.getLoopStateForProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.PAUSED,
      loop_paused_at_stage: 'VERIFY_FAIL',
    });

    const retried = loopController.retryVerifyFromFailureForProject(project.id);

    expect(retried).toMatchObject({
      project_id: project.id,
      state: LOOP_STATES.VERIFY,
      message: 'VERIFY retry requested; advance the loop to re-run remote verify',
    });
    expect(loopController.getLoopStateForProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.VERIFY,
      loop_paused_at_stage: null,
    });

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.filter((row) => row.action === 'retry_verify_requested')).toEqual([
      expect.objectContaining({
        stage: 'verify',
        outcome: expect.objectContaining({
          previous_paused_at_stage: 'VERIFY_FAIL',
          new_state: LOOP_STATES.VERIFY,
        }),
      }),
    ]);
  });

  it('reruns VERIFY after retryVerifyFromFailure from VERIFY_FAIL', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-verify-retry',
        branch: 'feat/factory-verify-retry',
        worktreePath: path.join(project.path, '.worktrees', 'feat-factory-verify-retry'),
      })),
      verify: vi.fn()
        .mockResolvedValueOnce({
          passed: false,
          output: 'tests failed',
          durationMs: 19,
        })
        .mockResolvedValueOnce({
          passed: true,
          output: 'tests passed',
          durationMs: 17,
        }),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedTaskCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async (args) => {
      submittedTaskCount += 1;
      const taskId = `approval-task-retry-${submittedTaskCount}`;
      insertBatchTask(db, {
        taskId,
        batchId,
        status: args.initial_status || 'pending_approval',
      });
      return { task_id: taskId };
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    await loopController.advanceLoopForProject(project.id);
    db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run('approval-task-retry-1');
    loopController.approveGateForProject(project.id, LOOP_STATES.VERIFY);

    const failedVerify = await loopController.advanceLoopForProject(project.id);
    expect(failedVerify.paused_at_stage).toBe('VERIFY_FAIL');
    expect(worktreeRunner.verify).toHaveBeenCalledTimes(1);

    loopController.retryVerifyFromFailureForProject(project.id);
    const retriedVerify = await loopController.advanceLoopForProject(project.id);

    expect(worktreeRunner.verify).toHaveBeenCalledTimes(2);
    expect(retriedVerify.previous_state).toBe(LOOP_STATES.VERIFY);
    expect(retriedVerify.new_state).toBe(LOOP_STATES.LEARN);
    expect(retriedVerify.paused_at_stage).toBeNull();
  });

  it('persists the factory worktree record so a fresh module instance can resolve it after EXECUTE', async () => {
    const { project, workItem } = registerPlanProject();
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-1',
        branch: 'feat/factory-1-persisted-worktree',
        worktreePath: path.join(project.path, '.worktrees', 'feat-factory-1-persisted-worktree'),
      })),
      verify: vi.fn(async () => ({
        passed: true,
        output: 'ok',
        durationMs: 12,
      })),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    const executeAdvance = await loopController.advanceLoopForProject(project.id);

    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(worktreeRunner.createForBatch).toHaveBeenCalledTimes(1);
    expect(worktreeRunner.verify).toHaveBeenCalledTimes(1);

    const freshFactoryWorktrees = loadFreshFactoryWorktrees();
    freshFactoryWorktrees.setDb(db);
    expect(freshFactoryWorktrees.getActiveWorktree(project.id)).toMatchObject({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: `factory-${project.id}-${workItem.id}`,
      vc_worktree_id: 'vc-worktree-1',
      branch: 'feat/factory-1-persisted-worktree',
      worktree_path: path.join(project.path, '.worktrees', 'feat-factory-1-persisted-worktree'),
      status: 'active',
    });
  });
});
