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
const branchFreshness = require('../factory/branch-freshness');
const loopController = require('../factory/loop-controller');
const verifyReview = require('../factory/verify-review');
const { LOOP_STATES } = require('../factory/loop-states');
const { defaultContainer } = require('../container');

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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_worktrees_branch_active
      ON factory_worktrees(branch)
      WHERE status = 'active';

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

    const projectRow = factoryHealth.registerProject({
      name: 'Loop Controller Dry Run Project',
      path: projectDir,
      trust_level: 'supervised',
      config,
    });
    // registerProject defaults status='paused'. Production flips this via
    // resume_project before the loop can advance; the factory's verify retry
    // loop now (correctly) aborts mid-iteration if the project is paused, so
    // test harness projects must mirror the resume flow or the retry tests
    // see zero verify calls.
    factoryHealth.updateProject(projectRow.id, { status: 'running' });
    const project = factoryHealth.getProject(projectRow.id);

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

  function parkProjectAtVerifyFail(projectId) {
    const instance = factoryLoopInstances.listInstances({
      project_id: projectId,
      active_only: true,
    })[0];
    expect(instance).toBeTruthy();

    const lastActionAt = new Date().toISOString();
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.VERIFY,
      paused_at_stage: 'VERIFY_FAIL',
      last_action_at: lastActionAt,
    });
    factoryHealth.updateProject(projectId, {
      loop_state: LOOP_STATES.PAUSED,
      loop_last_action_at: lastActionAt,
      loop_paused_at_stage: 'VERIFY_FAIL',
    });
  }

  it('refreshes factory store DB handles before loop operations', () => {
    const { project } = registerPlanProject();
    factoryHealth.setDb(null);
    factoryIntake.setDb(null);
    factoryLoopInstances.setDb(null);
    factoryDecisions.setDb(null);
    factoryWorktrees.setDb(null);

    const result = loopController.startLoop(project.id);

    expect(result).toMatchObject({
      project_id: project.id,
      state: LOOP_STATES.SENSE,
    });
    expect(factoryLoopInstances.listInstances({ project_id: project.id, active_only: true })).toHaveLength(1);
  });

  it('does not restore an unactionable item from the decision log on a fresh loop', async () => {
    const { project, workItem, planPath } = registerPlanProject();
    factoryIntake.updateWorkItem(workItem.id, {
      status: 'unactionable',
      reject_reason: 'branch_stale_vs_base',
    });
    const fallback = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'Fallback open item',
      description: 'Open work should be selected instead of the closed decision-log item.',
      priority: 45,
      requestor: 'test',
      origin: { plan_path: planPath },
    });
    factoryDecisions.recordDecision({
      project_id: project.id,
      stage: 'prioritize',
      actor: 'architect',
      action: 'selected_work_item',
      reasoning: 'Historical selection that is now terminal.',
      outcome: { work_item_id: workItem.id },
      confidence: 1,
    });

    loopController.startLoopForProject(project.id);
    const senseAdvance = await loopController.advanceLoopForProject(project.id);

    expect(senseAdvance.new_state).toBe(LOOP_STATES.PRIORITIZE);
    loopController.approveGateForProject(project.id, LOOP_STATES.PRIORITIZE);
    await loopController.advanceLoopForProject(project.id);
    const instance = loopController.getActiveInstances(project.id)[0];
    expect(instance.work_item_id).toBe(fallback.id);
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      status: 'unactionable',
      reject_reason: 'branch_stale_vs_base',
    });
  });

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

  it('tags live-mode plan-task submissions with factory:batch_id + work_item_id + plan_task_number', async () => {
    // Pre-fix: these tags were only attached when initial_status was
    // 'pending_approval'. In live mode the submissions had no factory
    // provenance, so the factory-worktree-auto-commit listener (which
    // keys off factory:batch_id / factory:plan_task_number) couldn't
    // correlate the completed <git-user> task back to its worktree and never
    // committed. Observed live on 2026-04-15 when fabro-97 finished 3
    // <git-user> tasks cleanly but the worktree merge failed with
    // 'uncommitted changes' because nothing had been committed.
    const { project, workItem } = registerPlanProject({
      config: { execute_live: true },
    });

    await advanceSupervisedPlanProject(project.id);
    await loopController.advanceLoopForProject(project.id);

    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalled();
    const firstCall = routingModule.handleSmartSubmitTask.mock.calls[0][0];
    expect(firstCall.tags).toEqual(expect.arrayContaining([
      expect.stringMatching(/^factory:batch_id=factory-/),
      `factory:work_item_id=${workItem.id}`,
      'factory:plan_task_number=1',
    ]));
    // Live mode must NOT tag as pending_approval.
    expect(firstCall.tags).not.toContain('factory:pending_approval');
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

  it('marks stale-branch verify conflicts unactionable and advances instead of looping at VERIFY', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const wtPath = path.join(project.path, '.worktrees', 'feat-factory-branch-stale');
    fs.mkdirSync(wtPath, { recursive: true });
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-branch-stale',
        branch: 'feat/factory-branch-stale',
        worktreePath: wtPath,
      })),
      verify: vi.fn(async () => ({ passed: true, output: 'ok', durationMs: 18 })),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedTaskCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async (args) => {
      submittedTaskCount += 1;
      const taskId = `approval-task-branch-stale-${submittedTaskCount}`;
      insertBatchTask(db, {
        taskId,
        batchId,
        status: args.initial_status || 'pending_approval',
      });
      return { task_id: taskId };
    });
    const checkBranchFreshnessSpy = vi.spyOn(branchFreshness, 'checkBranchFreshness').mockResolvedValue({
      stale: true,
      commitsBehind: 12,
      staleFiles: ['README.md'],
    });
    const attemptRebaseSpy = vi.spyOn(branchFreshness, 'attemptRebase').mockResolvedValue({
      ok: false,
      error: 'rebase conflict',
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);
    try {
      await advanceSupervisedPlanProject(project.id);
      const executeAdvance = await loopController.advanceLoopForProject(project.id);

      expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
      expect(executeAdvance.paused_at_stage).toBe(LOOP_STATES.VERIFY);
      expect(executeAdvance.reason).toBe('batch_tasks_not_terminal');

      db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run('approval-task-branch-stale-1');
      loopController.approveGateForProject(project.id, LOOP_STATES.VERIFY);

      const verifyAdvance = await loopController.advanceLoopForProject(project.id);

      expect(worktreeRunner.verify).not.toHaveBeenCalled();
      expect(verifyAdvance.previous_state).toBe(LOOP_STATES.VERIFY);
      expect(verifyAdvance.new_state).toBe(LOOP_STATES.IDLE);
      expect(verifyAdvance.paused_at_stage).toBeNull();
      expect(verifyAdvance.reason).toBe('branch_stale_vs_base');
      expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
        status: 'unactionable',
        reject_reason: 'branch_stale_vs_base',
      });
      expect(loopController.getActiveInstances(project.id)).toHaveLength(0);

      const decisions = listDecisionRows(db, project.id);
      expect(decisions.find((d) => d.action === 'branch_stale_rebase_conflict')).toMatchObject({
        stage: 'verify',
        outcome: expect.objectContaining({
          work_item_id: workItem.id,
        }),
      });
      expect(decisions.find((d) => d.action === 'verify_terminal_rejection_terminated')).toMatchObject({
        stage: 'verify',
        outcome: expect.objectContaining({
          work_item_id: workItem.id,
          status: 'unactionable',
          reason: 'branch_stale_vs_base',
        }),
      });
    } finally {
      checkBranchFreshnessSpy.mockRestore();
      attemptRebaseSpy.mockRestore();
    }
  });

  it('auto-rejects work item after MAX_AUTO_VERIFY_RETRIES and advances past VERIFY_FAIL', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const wtPath1 = path.join(project.path, '.worktrees', 'feat-factory-verify-fail');
    fs.mkdirSync(wtPath1, { recursive: true });
    vi.spyOn(verifyReview, 'reviewVerifyFailure').mockResolvedValue({
      classification: 'task_caused',
      confidence: 'high',
      modifiedFiles: ['tests/factory-work.test.js'],
      failingTests: ['tests/factory-work.test.js'],
      intersection: ['tests/factory-work.test.js'],
      environmentSignals: [],
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: null,
    });
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-verify-fail',
        branch: 'feat/factory-verify-fail',
        worktreePath: wtPath1,
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
    routingModule.handleSmartSubmitTask = vi.fn(async (_args) => {
      submittedTaskCount += 1;
      const taskId = `approval-task-fail-${submittedTaskCount}`;
      insertBatchTask(db, {
        taskId,
        batchId,
        status: 'completed',
      });
      return { task_id: taskId };
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    const verifyAdvance = await loopController.advanceLoopForProject(project.id);

    // Auto-retry kicks in: initial verify + 3 retries = 4 calls total
    // before the factory gives up and auto-rejects the item. Because the
    // completed batch task lets EXECUTE enter VERIFY inline, the advance
    // remains at VERIFY rather than pausing the loop.
    expect(worktreeRunner.verify).toHaveBeenCalledTimes(4);
    expect(verifyAdvance.previous_state).toBe(LOOP_STATES.EXECUTE);
    expect(verifyAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(verifyAdvance.paused_at_stage).toBeNull();
    expect(verifyAdvance.stage_result).toMatchObject({
      status: 'passed',
      reason: 'auto_rejected_after_max_retries',
    });
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      id: workItem.id,
      status: 'rejected',
      reject_reason: 'verify_failed_after_3_retries',
    });
    expect(loopController.getLoopStateForProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.VERIFY,
      loop_paused_at_stage: null,
    });
    const retryDecisions = listDecisionRows(db, project.id).filter(
      (d) => d.action === 'verify_retry_submitted' || d.action === 'verify_retry_task_completed',
    );
    expect(retryDecisions.length).toBe(6);
    expect(listDecisionRows(db, project.id).find((d) => d.action === 'auto_rejected_verify_fail')).toMatchObject({
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        retry_attempts: 3,
      }),
    });
  });

  it('pauses VERIFY instead of auto-retrying ambiguous low-confidence failures', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const wtPathAmbiguous = path.join(project.path, '.worktrees', 'feat-factory-ambiguous-verify');
    fs.mkdirSync(wtPathAmbiguous, { recursive: true });
    const reviewSpy = vi.spyOn(verifyReview, 'reviewVerifyFailure').mockResolvedValue({
      classification: 'ambiguous',
      confidence: 'low',
      modifiedFiles: ['server/tests/metrics.test.js'],
      failingTests: [],
      intersection: [],
      environmentSignals: [],
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: null,
    });
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-ambiguous',
        branch: 'feat/factory-ambiguous-verify',
        worktreePath: wtPathAmbiguous,
      })),
      verify: vi.fn(async () => ({
        passed: false,
        output: 'runner output without a parseable failing test list',
        durationMs: 22,
      })),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedTaskCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async (_args) => {
      submittedTaskCount += 1;
      const taskId = `ambiguous-task-${submittedTaskCount}`;
      insertBatchTask(db, {
        taskId,
        batchId,
        status: 'completed',
      });
      return { task_id: taskId };
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    const verifyAdvance = await loopController.advanceLoopForProject(project.id);

    expect(reviewSpy).toHaveBeenCalled();
    expect(worktreeRunner.verify).toHaveBeenCalledTimes(1);
    expect(submittedTaskCount).toBe(1);
    expect(verifyAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(verifyAdvance.paused_at_stage ?? verifyAdvance.stage_result?.pause_at_stage).toBe('VERIFY_FAIL');
    expect(verifyAdvance.stage_result).toMatchObject({
      status: 'failed',
      reason: 'verify_ambiguous_requires_operator',
    });
    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((d) => d.action === 'verify_retry_submitted')).toBeUndefined();
    expect(decisions.find((d) => d.action === 'verify_reviewed_ambiguous_paused')).toMatchObject({
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        classification: 'ambiguous',
        silent_rerun: 'flag_off',
      }),
    });
  });

  it('auto-rejects empty-branch verify failures instead of pausing ambiguous', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const wtPathEmptyBranch = path.join(project.path, '.worktrees', 'feat-factory-empty-branch-rejected');
    fs.mkdirSync(wtPathEmptyBranch, { recursive: true });
    const reviewSpy = vi.spyOn(verifyReview, 'reviewVerifyFailure');
    reviewSpy.mockClear();
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-empty-branch-rejected',
        branch: 'feat/factory-empty-branch-rejected',
        worktreePath: wtPathEmptyBranch,
      })),
      verify: vi.fn(async () => ({
        passed: false,
        output: '[empty-branch] Branch feat/factory-empty-branch-rejected has no commits ahead of main; nothing to verify.',
        stderr: '[empty-branch] Branch feat/factory-empty-branch-rejected has no commits ahead of main; nothing to verify.',
        durationMs: 12,
        reason: 'empty_branch',
      })),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedTaskCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async () => {
      submittedTaskCount += 1;
      const taskId = `empty-branch-rejected-task-${submittedTaskCount}`;
      insertBatchTask(db, {
        taskId,
        batchId,
        status: 'completed',
      });
      return { task_id: taskId };
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    const verifyAdvance = await loopController.advanceLoopForProject(project.id);

    expect(reviewSpy).not.toHaveBeenCalled();
    expect(worktreeRunner.verify).toHaveBeenCalledTimes(1);
    expect(verifyAdvance).toMatchObject({
      previous_state: LOOP_STATES.EXECUTE,
      new_state: LOOP_STATES.IDLE,
      stage_result: expect.objectContaining({
        status: 'rejected',
        reason: 'empty_branch_after_execute',
      }),
    });
    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      id: workItem.id,
      status: 'rejected',
      reject_reason: 'empty_branch_after_execute',
    });
    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((d) => d.action === 'verify_empty_branch_auto_rejected')).toMatchObject({
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        branch: 'feat/factory-empty-branch-rejected',
      }),
    });
    expect(decisions.find((d) => d.action === 'verify_terminal_rejection_terminated')).toMatchObject({
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        status: 'rejected',
        reason: 'empty_branch_after_execute',
      }),
    });
    expect(decisions.find((d) => d.action === 'verify_reviewed_ambiguous_paused')).toBeUndefined();
  });

  it('pauses VERIFY_FAIL for controlled recovery when the verify reviewer times out', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const wtPathTimeout = path.join(project.path, '.worktrees', 'feat-factory-reviewer-timeout');
    fs.mkdirSync(wtPathTimeout, { recursive: true });
    const reviewSpy = vi.spyOn(verifyReview, 'reviewVerifyFailure').mockResolvedValue({
      classification: 'reviewer_timeout',
      confidence: 'high',
      modifiedFiles: ['server/tests/metrics.test.js'],
      failingTests: ['server/tests/metrics.test.js'],
      intersection: [],
      environmentSignals: [],
      llmVerdict: null,
      llmCritique: null,
      llmStatus: 'timeout',
      llmTaskId: 'review-llm-timeout-1',
      suggestedRejectReason: null,
    });
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-review-timeout',
        branch: 'feat-factory-reviewer-timeout',
        worktreePath: wtPathTimeout,
      })),
      verify: vi.fn(async () => ({
        passed: false,
        output: 'runner output with parsed failures but slow reviewer',
        durationMs: 22,
      })),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedTaskCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async (_args) => {
      submittedTaskCount += 1;
      const taskId = `reviewer-timeout-task-${submittedTaskCount}`;
      insertBatchTask(db, {
        taskId,
        batchId,
        status: 'completed',
      });
      return { task_id: taskId };
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    const verifyAdvance = await loopController.advanceLoopForProject(project.id);

    expect(reviewSpy).toHaveBeenCalled();
    expect(worktreeRunner.verify).toHaveBeenCalledTimes(1);
    expect(submittedTaskCount).toBe(1);
    expect(verifyAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(verifyAdvance.paused_at_stage ?? verifyAdvance.stage_result?.pause_at_stage).toBe('VERIFY_FAIL');
    expect(verifyAdvance.stage_result).toMatchObject({
      status: 'failed',
      reason: 'verify_reviewer_timeout_requires_recovery',
    });
    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((d) => d.action === 'verify_retry_submitted')).toBeUndefined();
    expect(decisions.find((d) => d.action === 'verify_reviewer_timeout_paused')).toMatchObject({
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        classification: 'reviewer_timeout',
        llmStatus: 'timeout',
        task_id: 'review-llm-timeout-1',
      }),
    });
  });

  it('auto-retries a failing VERIFY and ships when the second attempt passes', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const wtPath2 = path.join(project.path, '.worktrees', 'feat-factory-verify-retry');
    fs.mkdirSync(wtPath2, { recursive: true });
    vi.spyOn(verifyReview, 'reviewVerifyFailure').mockResolvedValue({
      classification: 'task_caused',
      confidence: 'high',
      modifiedFiles: ['tests/factory-work.test.js'],
      failingTests: ['tests/factory-work.test.js'],
      intersection: ['tests/factory-work.test.js'],
      environmentSignals: [],
      llmVerdict: null,
      llmCritique: null,
      suggestedRejectReason: null,
    });
    let verifyCall = 0;
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-retry',
        branch: 'feat/factory-verify-retry',
        worktreePath: wtPath2,
      })),
      verify: vi.fn(async () => {
        verifyCall += 1;
        // First attempt fails, second attempt (after the retry fix task)
        // passes — simulates <git-user> successfully healing the verify.
        return verifyCall === 1
          ? { passed: false, output: 'alignment drift detected', durationMs: 22 }
          : { passed: true, output: 'ok', durationMs: 22 };
      }),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedTaskCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async (args) => {
      submittedTaskCount += 1;
      const taskId = `approval-or-retry-task-${submittedTaskCount}`;
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
    // Complete pending-approval task so VERIFY can enter.
    db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run('approval-or-retry-task-1');
    loopController.approveGateForProject(project.id, LOOP_STATES.VERIFY);

    const verifyAdvance = await loopController.advanceLoopForProject(project.id);

    // Verify was called twice: first failed, then auto-retry task ran,
    // then verify called again and passed.
    expect(worktreeRunner.verify).toHaveBeenCalledTimes(2);
    expect(verifyAdvance.new_state).toBe(LOOP_STATES.LEARN);
    expect(verifyAdvance.paused_at_stage).toBeNull();

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((d) => d.action === 'verify_retry_submitted')).toMatchObject({
      outcome: expect.objectContaining({ attempt: 1, max_retries: 3 }),
    });
    expect(decisions.find((d) => d.action === 'verify_retry_task_completed')).toMatchObject({
      outcome: expect.objectContaining({ attempt: 1 }),
    });
    const passed = decisions.filter((d) => d.action === 'worktree_verify_passed').pop();
    expect(passed).toMatchObject({
      outcome: expect.objectContaining({ retry_attempt: 1 }),
    });
    // No pause at VERIFY_FAIL.
    expect(decisions.find((d) => d.action === 'worktree_verify_failed')).toBeUndefined();
  });

  it('retries a transient submission failure (no task_id) without consuming a verify attempt', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const wtPathTransient = path.join(project.path, '.worktrees', 'feat-factory-transient-submit');
    fs.mkdirSync(wtPathTransient, { recursive: true });
    let verifyCall = 0;
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-transient',
        branch: 'feat/factory-transient-submit',
        worktreePath: wtPathTransient,
      })),
      verify: vi.fn(async () => {
        verifyCall += 1;
        return verifyCall === 1
          ? { passed: false, output: 'first verify failed', durationMs: 19 }
          : { passed: true, output: 'ok', durationMs: 19 };
      }),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async (args) => {
      submittedCount += 1;
      // 1st: pending-approval plan task. 2nd: transient retry failure.
      // 3rd+: retry submission succeeds.
      if (submittedCount === 1) {
        const taskId = `approval-task-transient-1`;
        insertBatchTask(db, { taskId, batchId, status: args.initial_status || 'pending_approval' });
        return { task_id: taskId };
      }
      if (submittedCount === 2) {
        return {};
      }
      const taskId = `retry-task-transient-${submittedCount}`;
      insertBatchTask(db, { taskId, batchId, status: 'completed' });
      return { task_id: taskId };
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    await loopController.advanceLoopForProject(project.id);
    db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run('approval-task-transient-1');
    loopController.approveGateForProject(project.id, LOOP_STATES.VERIFY);

    const verifyAdvance = await loopController.advanceLoopForProject(project.id);

    expect(worktreeRunner.verify).toHaveBeenCalledTimes(2);
    expect(verifyAdvance.new_state).toBe(LOOP_STATES.LEARN);
    expect(verifyAdvance.paused_at_stage).toBeNull();
    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((d) => d.action === 'verify_retry_submission_failed')).toMatchObject({
      stage: 'verify',
      outcome: expect.objectContaining({
        reason: 'no_task_id',
      }),
    });
    expect(decisions.find((d) => d.action === 'worktree_verify_failed')).toBeUndefined();
  });

  it('pauses at VERIFY_FAIL after MAX_SUBMISSION_FAILURES consecutive transient submission errors', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const wtPathExhaust = path.join(project.path, '.worktrees', 'feat-factory-submit-exhaust');
    fs.mkdirSync(wtPathExhaust, { recursive: true });
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-exhaust',
        branch: 'feat/factory-submit-exhaust',
        worktreePath: wtPathExhaust,
      })),
      verify: vi.fn(async () => ({ passed: false, output: 'verify red', durationMs: 19 })),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async (args) => {
      submittedCount += 1;
      if (submittedCount === 1) {
        const taskId = `approval-task-exhaust-1`;
        insertBatchTask(db, { taskId, batchId, status: args.initial_status || 'pending_approval' });
        return { task_id: taskId };
      }
      return {};
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    await loopController.advanceLoopForProject(project.id);
    db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run('approval-task-exhaust-1');
    loopController.approveGateForProject(project.id, LOOP_STATES.VERIFY);

    const verifyAdvance = await loopController.advanceLoopForProject(project.id);

    expect(verifyAdvance.stage_result).toMatchObject({
      status: 'failed',
      pause_at_stage: 'VERIFY_FAIL',
      reason: expect.stringMatching(/submission_failures/),
    });
    const decisions = listDecisionRows(db, project.id);
    const submissionFailDecisions = decisions.filter((d) => d.action === 'verify_retry_submission_failed');
    expect(submissionFailDecisions.length).toBeGreaterThanOrEqual(2);
  });

  // Rewritten 2026-04-19 against the contract introduced in commit 4b6dc8e5
  // ("fix(factory): self-recover worktree cwd_missing instead of pausing").
  // When a verify retry detects a missing worktree directory, the factory
  // probes whether the branch still exists and — if so — calls
  // `git worktree add <path> <branch>` to re-attach the branch at the
  // expected path instead of pausing at VERIFY_FAIL. Verify retry then
  // proceeds down the normal path.
  //
  // Under the test harness's stubbed git (server/tests/worker-setup.js
  // stubs all git commands to succeed), both the branch probe AND the
  // worktree-add succeed, so this test exercises the recovery-success path.
  // Asserting `verify_retry_worktree_recovered` proves the new code path
  // fires when cwd is missing. The previous assertion (one-call pause at
  // VERIFY_FAIL) described the pre-4b6dc8e5 behavior and no longer holds.
  it('verify retry self-recovers the worktree when the directory is missing but the branch still exists', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const wtPathMissing = path.join(project.path, '.worktrees', 'feat-factory-cwd-missing');
    expect(fs.existsSync(wtPathMissing)).toBe(false);
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-cwd-missing',
        branch: 'feat/factory-cwd-missing',
        worktreePath: wtPathMissing,
      })),
      verify: vi.fn(async () => ({
        passed: false,
        output: 'tests failed',
        durationMs: 22,
      })),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    let submittedCount = 0;
    routingModule.handleSmartSubmitTask = vi.fn(async (args) => {
      submittedCount += 1;
      const taskId = `approval-task-cwd-missing-${submittedCount}`;
      insertBatchTask(db, { taskId, batchId, status: args.initial_status || 'pending_approval' });
      return { task_id: taskId };
    });
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    await loopController.advanceLoopForProject(project.id);
    db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run('approval-task-cwd-missing-1');
    loopController.approveGateForProject(project.id, LOOP_STATES.VERIFY);

    const verifyAdvance = await loopController.advanceLoopForProject(project.id);

    // Recovery decision fires at least once, with the branch + worktree path
    // captured in the outcome. This is the load-bearing assertion — it proves
    // the new cwd_missing recovery code path ran.
    const decisions = listDecisionRows(db, project.id);
    const recoveredDecisions = decisions.filter((d) => d.action === 'verify_retry_worktree_recovered');
    expect(recoveredDecisions.length).toBeGreaterThanOrEqual(1);
    expect(recoveredDecisions[0]).toMatchObject({
      stage: 'verify',
      outcome: expect.objectContaining({
        worktree_path: wtPathMissing,
        branch: 'feat/factory-cwd-missing',
      }),
    });
    // The loop did NOT pause at VERIFY_FAIL (which is what the pre-4b6dc8e5
    // behavior would have done) — after retries exhaust, it advances via
    // auto_rejected_verify_fail instead.
    expect(verifyAdvance.stage_result?.pause_at_stage).not.toBe('VERIFY_FAIL');
  });

  it('throws when retryVerifyFromFailure is called outside VERIFY_FAIL', () => {
    const { project } = registerPlanProject();
    loopController.startLoopForProject(project.id);

    expect(() => loopController.retryVerifyFromFailureForProject(project.id)).toThrow('Loop is not paused at VERIFY_FAIL');
  });

  it('retryVerifyFromFailure resets loop state to VERIFY and clears the paused stage', async () => {
    const { project, workItem } = registerPlanProject();
    const batchId = `factory-${project.id}-${workItem.id}`;
    const wtPath3 = path.join(project.path, '.worktrees', 'feat-factory-verify-retry-reset');
    fs.mkdirSync(wtPath3, { recursive: true });
    const worktreeRunner = {
      createForBatch: vi.fn(async () => ({
        id: 'vc-worktree-verify-retry-reset',
        branch: 'feat/factory-verify-retry-reset',
        worktreePath: wtPath3,
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
    parkProjectAtVerifyFail(project.id);

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
      verify: vi.fn(async () => ({ passed: true, output: 'tests passed', durationMs: 17 })),
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
    parkProjectAtVerifyFail(project.id);

    loopController.retryVerifyFromFailureForProject(project.id);
    const retriedVerify = await loopController.advanceLoopForProject(project.id);

    expect(worktreeRunner.verify).toHaveBeenCalledTimes(1);
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

  it('does not pre-reclaim a fresh active worktree owned by a live task', async () => {
    const { project, workItem } = registerPlanProject();
    db.prepare('ALTER TABLE factory_worktrees ADD COLUMN owning_task_id TEXT').run();
    const targetBranch = `feat/factory-${workItem.id}-dry-run-plan-item`;
    const worktreePath = path.join(project.path, '.worktrees', 'feat-live-owner');
    fs.mkdirSync(worktreePath, { recursive: true });
    const existing = factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: `factory-${project.id}-${workItem.id}`,
      vc_worktree_id: 'vc-live-owner',
      branch: targetBranch,
      worktree_path: worktreePath,
    });
    factoryWorktrees.setOwningTask(existing.id, 'task-live-owner');
    let ownerStatus = 'running';
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: taskId === 'task-live-owner' ? ownerStatus : 'completed',
      error_output: null,
    }));

    const worktreeRunner = {
      createForBatch: vi.fn(),
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

    expect(worktreeRunner.createForBatch).not.toHaveBeenCalled();
    expect(worktreeRunner.abandon).not.toHaveBeenCalled();
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(executeAdvance.new_state).toBe(LOOP_STATES.EXECUTE);
    expect(executeAdvance.stage_result).toMatchObject({
      status: 'waiting',
      reason: 'active_worktree_owner_running',
      factory_worktree_id: existing.id,
      owning_task_id: 'task-live-owner',
    });
    expect(executeAdvance.paused_at_stage).toBe(LOOP_STATES.EXECUTE);
    expect(db.prepare('SELECT status FROM factory_worktrees WHERE id = ?').get(existing.id).status).toBe('active');

    ownerStatus = 'completed';
    const resumedAdvance = await loopController.advanceLoopForProject(project.id);

    expect(worktreeRunner.createForBatch).not.toHaveBeenCalled();
    expect(worktreeRunner.abandon).not.toHaveBeenCalled();
    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      working_directory: worktreePath,
    }));
    expect(resumedAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(resumedAdvance.paused_at_stage).toBeNull();

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((d) => d.action === 'worktree_reclaim_skipped_live_owner')).toBeTruthy();
    expect(decisions.find((d) => d.action === 'execute_wait_owner_completed')).toBeTruthy();
  });

  it('reuses an active worktree owned by a completed task instead of reclaiming it', async () => {
    const { project, workItem } = registerPlanProject();
    db.prepare('ALTER TABLE factory_worktrees ADD COLUMN owning_task_id TEXT').run();
    const targetBranch = `feat/factory-${workItem.id}-dry-run-plan-item`;
    const worktreePath = path.join(project.path, '.worktrees', 'feat-completed-owner');
    fs.mkdirSync(worktreePath, { recursive: true });
    const existing = factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: `factory-${project.id}-${workItem.id}`,
      vc_worktree_id: 'vc-completed-owner',
      branch: targetBranch,
      worktree_path: worktreePath,
    });
    factoryWorktrees.setOwningTask(existing.id, 'task-completed-owner');
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'completed',
      error_output: null,
    }));

    const worktreeRunner = {
      createForBatch: vi.fn(),
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

    expect(worktreeRunner.createForBatch).not.toHaveBeenCalled();
    expect(worktreeRunner.abandon).not.toHaveBeenCalled();
    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      working_directory: worktreePath,
    }));
    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);
    expect(db.prepare('SELECT status FROM factory_worktrees WHERE id = ?').get(existing.id).status).toBe('active');

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((d) => d.action === 'worktree_reused_completed_owner')).toBeTruthy();
    expect(decisions.find((d) => d.action === 'worktree_reclaimed')).toBeFalsy();
  });

  it('pauses EXECUTE at a fail-loud state when worktree creation throws (no fallback to main)', async () => {
    const { project, workItem, planPath } = registerPlanProject();
    const planBefore = fs.readFileSync(planPath, 'utf8');
    const uniqueErrorMsg = 'UNIQUE constraint failed: factory_worktrees.branch';
    const worktreeRunner = {
      createForBatch: vi.fn(async () => {
        throw new Error(uniqueErrorMsg);
      }),
      verify: vi.fn(),
      mergeToMain: vi.fn(),
      abandon: vi.fn(),
    };
    loopController.setWorktreeRunnerForTests(worktreeRunner);

    await advanceSupervisedPlanProject(project.id);
    const executeAdvance = await loopController.advanceLoopForProject(project.id);

    expect(worktreeRunner.createForBatch).toHaveBeenCalledTimes(1);
    expect(executeAdvance.new_state).toBe(LOOP_STATES.EXECUTE);
    expect(executeAdvance.paused_at_stage).toBe(LOOP_STATES.EXECUTE);
    expect(executeAdvance.stage_result).toMatchObject({
      status: 'paused',
      reason: 'worktree_creation_failed',
      error: uniqueErrorMsg,
    });

    // No plan tasks should have been submitted — the plan-executor must never run
    // against project.path when worktree creation fails.
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    // And the plan file itself must remain untouched.
    expect(fs.readFileSync(planPath, 'utf8')).toBe(planBefore);

    const workItemAfter = factoryIntake.getWorkItem(workItem.id);
    expect(workItemAfter).toMatchObject({
      id: workItem.id,
      status: 'in_progress',
    });
    expect(String(workItemAfter.reject_reason || '')).toContain('worktree_creation_failed');

    const decisions = listDecisionRows(db, project.id);
    const failureEntry = decisions.find((d) => d.action === 'worktree_creation_failed');
    expect(failureEntry).toBeTruthy();
    expect(failureEntry.outcome).toMatchObject({
      error: uniqueErrorMsg,
      next_state: LOOP_STATES.PAUSED,
      paused_at_stage: LOOP_STATES.EXECUTE,
    });
    expect(failureEntry.outcome).not.toHaveProperty('fallback');
  });

  it('cancels a stuck async advance job and parks the instance so rejectGate can recover it', async () => {
    const { project } = registerPlanProject();
    loopController.startLoopForProject(project.id);

    const instanceId = loopController.getActiveInstances(project.id)[0].id;

    // Simulate a runAdvanceLoop promise that never resolved — the job sits
    // in the active map and blocks future advances.
    const stuckJobId = 'stuck-job-001';
    loopController._internalForTests.injectFakeAdvanceJobForTests(instanceId, {
      project_id: project.id,
      instance_id: instanceId,
      job_id: stuckJobId,
      started_at: new Date().toISOString(),
      current_state: LOOP_STATES.EXECUTE,
      status: 'running',
      new_state: null,
      paused_at_stage: null,
      stage_result: null,
      reason: null,
      completed_at: null,
      error: null,
    });

    expect(loopController._internalForTests.getActiveAdvanceJobIdForTests(instanceId)).toBe(stuckJobId);

    const result = loopController.cancelLoopAdvanceJob(instanceId, 'test_stuck_recovery');

    expect(result).toMatchObject({
      instance_id: instanceId,
      job_id: stuckJobId,
      cancelled: true,
      reason: 'test_stuck_recovery',
    });
    expect(result.parked_stage).toBeTruthy();

    // Active map is cleared.
    expect(loopController._internalForTests.getActiveAdvanceJobIdForTests(instanceId)).toBeNull();
    // Job snapshot retains its terminal state for audit.
    const finalJob = loopController._internalForTests.getAdvanceJobSnapshotForTests(instanceId, stuckJobId);
    expect(finalJob).toMatchObject({
      status: 'cancelled',
      error: 'cancelled: test_stuck_recovery',
    });
    expect(finalJob.completed_at).toBeTruthy();

    // Instance is parked at its current stage so rejectGate can now drive it.
    const state = loopController.getLoopState(instanceId);
    expect(state.loop_paused_at_stage).toBeTruthy();
  });

  it('returns a no_active_job result when there is nothing to cancel', () => {
    const { project } = registerPlanProject();
    loopController.startLoopForProject(project.id);
    const instanceId = loopController.getActiveInstances(project.id)[0].id;

    const result = loopController.cancelLoopAdvanceJob(instanceId, 'nothing_to_cancel');
    expect(result).toMatchObject({
      instance_id: instanceId,
      cancelled: false,
      reason: 'no_active_job',
    });
  });

  it('terminates the loop instance if SENSE throws, so subsequent startLoop calls are not blocked', async () => {
    // Register a project whose configured plans_dir points to a file, not a
    // directory — plan-file-intake will throw 'plans_dir not found' on the
    // first scan. Before the fix, that left an orphan instance at SENSE,
    // blocking future startLoop calls with 'Stage SENSE is already occupied'.
    const project = factoryHealth.registerProject({
      name: `Factory SENSE Zombie ${Date.now()}`,
      path: path.join(tempDir, `project-zombie-${Date.now()}-${Math.random().toString(16).slice(2)}`),
      trust_level: 'supervised',
      config: {
        plans_dir: path.join(tempDir, 'nonexistent-plans-dir'),
      },
    });

    expect(() => loopController.startLoopForProject(project.id)).toThrow(/plans_dir/);

    // The instance created in startLoop must have been terminated.
    expect(loopController.getActiveInstances(project.id)).toHaveLength(0);

    // With the lock released, we can recover by removing the bad config
    // and starting again (here, point plans_dir at a valid empty dir).
    const goodPlansDir = path.join(tempDir, `good-plans-${Date.now()}`);
    fs.mkdirSync(goodPlansDir, { recursive: true });
    factoryHealth.updateProject(project.id, {
      config_json: { plans_dir: goodPlansDir },
    });

    expect(() => loopController.startLoopForProject(project.id)).not.toThrow();
    expect(loopController.getActiveInstances(project.id)).toHaveLength(1);
  });

  it('awaitTaskToStructuredResult loops past heartbeat responses until the task is terminal', async () => {
    // Pre-fix: the first heartbeat return ended the await, the task was
    // still 'running', verify_status was 'failed', and plan-executor
    // killed a perfectly good <git-user> batch mid-flight. Observed live on
    // 2026-04-15 when <git-user> task 3 for fabro-97 took 14 min; plan-executor
    // declared it failed after 5 min even though the task later completed.
    const taskId = 'task-heartbeat-then-complete';
    let taskStatus = 'running';
    const fakeTaskCore = {
      getTask: (id) => (id === taskId ? { id, status: taskStatus, error_output: null } : null),
    };
    const handleAwaitTask = vi.fn(async () => ({ content: [{ text: 'heartbeat' }] }));
    // First two calls: task stays 'running' (two heartbeats).
    // Third call: flip status to 'completed' before returning — the loop
    // should see the terminal state on this pass and exit.
    handleAwaitTask
      .mockResolvedValueOnce({ content: [{ text: 'heartbeat 1' }] })
      .mockResolvedValueOnce({ content: [{ text: 'heartbeat 2' }] })
      .mockImplementationOnce(async () => { taskStatus = 'completed'; return { content: [{ text: 'final' }] }; });

    const result = await loopController._internalForTests.awaitTaskToStructuredResult(
      handleAwaitTask,
      fakeTaskCore,
      { task_id: taskId, verify_command: 'npx vitest run', commit_message: 'test', working_directory: '/tmp' },
    );

    expect(handleAwaitTask).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      status: 'completed',
      verify_status: 'passed',
      task_id: taskId,
    });
  });

  it('awaitTaskToStructuredResult reports failure when the task ends in a non-completed terminal state', async () => {
    const taskId = 'task-that-fails';
    let taskStatus = 'running';
    const fakeTaskCore = {
      getTask: (id) => (id === taskId ? { id, status: taskStatus, error_output: 'boom' } : null),
    };
    const handleAwaitTask = vi.fn();
    handleAwaitTask
      .mockResolvedValueOnce({ content: [{ text: 'heartbeat' }] })
      .mockImplementationOnce(async () => { taskStatus = 'failed'; return { content: [{ text: 'final' }] }; });

    const result = await loopController._internalForTests.awaitTaskToStructuredResult(
      handleAwaitTask,
      fakeTaskCore,
      { task_id: taskId },
    );

    expect(result).toMatchObject({
      status: 'failed',
      verify_status: 'failed',
      error: 'boom',
      task_id: taskId,
    });
  });

  it('awaitFactoryLoop resolves immediately when the instance is already at the target state', async () => {
    const { project } = registerPlanProject();

    const started = loopController.startLoopForProject(project.id);
    const advanced = await loopController.advanceLoopForProject(project.id);

    expect(advanced.new_state).toBe(LOOP_STATES.PRIORITIZE);

    const result = await loopController.awaitFactoryLoop(project.id, {
      target_states: [LOOP_STATES.PRIORITIZE],
      heartbeat_minutes: 0,
      timeout_minutes: 1,
    });

    expect(result).toMatchObject({
      status: 'target_state_reached',
      timed_out: false,
      instance: {
        id: started.instance_id,
        project_id: project.id,
        loop_state: LOOP_STATES.PRIORITIZE,
      },
    });
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('awaitFactoryLoop resolves when the instance terminates', async () => {
    const { project } = registerPlanProject();
    const started = loopController.startLoopForProject(project.id);

    const timer = setTimeout(() => {
      loopController.terminateInstanceAndSync(started.instance_id);
    }, 25);

    try {
      const result = await loopController.awaitFactoryLoop(project.id, {
        heartbeat_minutes: 0,
        timeout_minutes: 1,
      });

      expect(result).toMatchObject({
        status: 'terminated',
        timed_out: false,
        instance: {
          id: started.instance_id,
          project_id: project.id,
        },
      });
      expect(result.instance.terminated_at).toBeTruthy();
    } finally {
      clearTimeout(timer);
    }
  });

  it('terminates no-open-work loops so idle instances are not active heartbeats', async () => {
    const { project, workItem } = registerPlanProject();
    factoryIntake.updateWorkItem(workItem.id, { status: 'completed' });
    const started = loopController.startLoopForProject(project.id);

    const senseAdvance = await loopController.advanceLoopForProject(project.id);
    expect(senseAdvance).toMatchObject({
      new_state: LOOP_STATES.PRIORITIZE,
      paused_at_stage: LOOP_STATES.PRIORITIZE,
    });

    loopController.approveGateForProject(project.id, LOOP_STATES.PRIORITIZE);
    const prioritizeAdvance = await loopController.advanceLoopForProject(project.id);

    expect(prioritizeAdvance).toMatchObject({
      new_state: LOOP_STATES.IDLE,
      paused_at_stage: null,
      reason: 'no_open_work_item',
    });
    expect(factoryLoopInstances.getInstance(started.instance_id)).toMatchObject({
      loop_state: LOOP_STATES.IDLE,
      terminated_at: expect.any(String),
    });
    expect(loopController.getActiveInstances(project.id)).toEqual([]);

    const result = await loopController.awaitFactoryLoop(project.id, {
      heartbeat_minutes: 0,
      timeout_minutes: 1,
    });

    expect(result).toMatchObject({
      status: 'terminated',
      timed_out: false,
      instance: {
        id: started.instance_id,
        project_id: project.id,
      },
    });
  });

  it('awaitFactoryLoop treats legacy nonterminated IDLE instances as terminal', async () => {
    const { project } = registerPlanProject();
    const started = loopController.startLoopForProject(project.id);
    factoryLoopInstances.updateInstance(started.instance_id, {
      loop_state: LOOP_STATES.IDLE,
      paused_at_stage: null,
      last_action_at: new Date().toISOString(),
    });

    expect(loopController.getActiveInstances(project.id)).toEqual([]);

    const result = await loopController.awaitFactoryLoop(project.id, {
      heartbeat_minutes: 0,
      timeout_minutes: 1,
    });

    expect(result).toMatchObject({
      status: 'terminated',
      timed_out: false,
      instance: {
        id: started.instance_id,
        project_id: project.id,
        loop_state: LOOP_STATES.IDLE,
        terminated_at: null,
      },
    });
  });

  it('treats STARVED as terminal when no intake is available', async () => {
    const { project, workItem } = registerPlanProject();
    factoryIntake.updateWorkItem(workItem.id, { status: 'completed' });
    const started = loopController.startLoopForProject(project.id);
    factoryLoopInstances.updateInstance(started.instance_id, {
      loop_state: LOOP_STATES.STARVED,
      paused_at_stage: null,
      last_action_at: new Date().toISOString(),
    });

    const advanceResult = await loopController.advanceLoop(started.instance_id);
    expect(advanceResult).toMatchObject({
      new_state: LOOP_STATES.STARVED,
      reason: 'loop_starved',
    });
    const descriptor = loopController.advanceLoopAsync(started.instance_id, { autoAdvance: true });
    expect(descriptor).toMatchObject({
      current_state: LOOP_STATES.STARVED,
      status: 'running',
      error: null,
    });
    await vi.waitFor(() => {
      const completed = loopController.getLoopAdvanceJobStatusForProject(project.id, descriptor.job_id);
      expect(completed).toMatchObject({
        status: 'completed',
        new_state: LOOP_STATES.STARVED,
        reason: 'loop_starved',
        error: null,
      });
    });

    const result = await loopController.awaitFactoryLoop(project.id, {
      heartbeat_minutes: 0.02,
      timeout_minutes: 1,
    });

    expect(result).toMatchObject({
      status: 'starved',
      timed_out: false,
      instance: {
        id: started.instance_id,
        project_id: project.id,
        loop_state: LOOP_STATES.STARVED,
      },
    });
  });

  it('submits an immediate recovery scout when STARVED advance has no intake', async () => {
    const { project, workItem } = registerPlanProject();
    factoryIntake.updateWorkItem(workItem.id, { status: 'completed' });
    const started = loopController.startLoopForProject(project.id);
    factoryLoopInstances.updateInstance(started.instance_id, {
      loop_state: LOOP_STATES.STARVED,
      paused_at_stage: null,
      last_action_at: new Date().toISOString(),
    });

    const maybeRecover = vi.fn().mockResolvedValue({
      recovered: false,
      reason: 'scout_submitted_waiting_for_intake',
      scout: { task_id: 'scout-1' },
      forced: true,
      trigger: 'manual_advance',
    });
    const getSpy = vi.spyOn(defaultContainer, 'get').mockImplementation((name) => {
      if (name === 'starvationRecovery') {
        return { maybeRecover };
      }
      throw new Error(`unexpected container service: ${name}`);
    });

    try {
      const advanceResult = await loopController.advanceLoop(started.instance_id);

      expect(maybeRecover).toHaveBeenCalledWith(expect.objectContaining({
        id: project.id,
        loop_state: LOOP_STATES.STARVED,
      }), {
        force: true,
        trigger: 'manual_advance',
      });
      expect(advanceResult).toMatchObject({
        previous_state: LOOP_STATES.STARVED,
        new_state: LOOP_STATES.STARVED,
        reason: 'starvation_recovery_scout_submitted',
        stage_result: {
          starvation_recovery: {
            recovered: false,
            reason: 'scout_submitted_waiting_for_intake',
            forced: true,
            trigger: 'manual_advance',
            scout_task_id: 'scout-1',
          },
        },
      });
    } finally {
      getSpy.mockRestore();
    }
  });

  it('recovers STARVED loop advance when intake has been replenished', async () => {
    const { project } = registerPlanProject();
    const started = loopController.startLoopForProject(project.id);
    factoryLoopInstances.updateInstance(started.instance_id, {
      loop_state: LOOP_STATES.STARVED,
      paused_at_stage: null,
      last_action_at: new Date().toISOString(),
    });

    const advanceResult = await loopController.advanceLoop(started.instance_id);

    expect(advanceResult).toMatchObject({
      previous_state: LOOP_STATES.STARVED,
      new_state: LOOP_STATES.PRIORITIZE,
      paused_at_stage: LOOP_STATES.PRIORITIZE,
      reason: 'starved_intake_replenished',
      stage_result: {
        recovered_from_state: LOOP_STATES.STARVED,
        open_work_items: 1,
        target_state: LOOP_STATES.PRIORITIZE,
      },
    });

    expect(factoryLoopInstances.getInstance(started.instance_id)).toMatchObject({
      loop_state: LOOP_STATES.PRIORITIZE,
      paused_at_stage: LOOP_STATES.PRIORITIZE,
      batch_id: null,
      work_item_id: null,
    });
  });

  it('allows async STARVED advance when intake has been replenished', async () => {
    const { project } = registerPlanProject();
    factoryHealth.updateProject(project.id, { trust_level: 'autonomous' });
    const started = loopController.startLoopForProject(project.id);
    factoryLoopInstances.updateInstance(started.instance_id, {
      loop_state: LOOP_STATES.STARVED,
      paused_at_stage: null,
      last_action_at: new Date().toISOString(),
    });

    const descriptor = loopController.advanceLoopAsync(started.instance_id);

    expect(descriptor).toMatchObject({
      current_state: LOOP_STATES.STARVED,
      status: 'running',
      error: null,
    });

    await vi.waitFor(() => {
      const completed = loopController.getLoopAdvanceJobStatusForProject(project.id, descriptor.job_id);
      expect(completed).toMatchObject({
        status: 'completed',
        new_state: LOOP_STATES.PRIORITIZE,
        paused_at_stage: null,
        reason: 'starved_intake_replenished',
        error: null,
      });
    });
  });

  it('awaitFactoryLoop returns timeout when nothing changes', async () => {
    const { project } = registerPlanProject();
    const started = loopController.startLoopForProject(project.id);

    const result = await loopController.awaitFactoryLoop(project.id, {
      target_states: [LOOP_STATES.LEARN],
      timeout_minutes: 0.05,
      heartbeat_minutes: 0,
    });

    expect(result).toMatchObject({
      status: 'timeout',
      timed_out: true,
      instance: {
        id: started.instance_id,
        project_id: project.id,
        loop_state: LOOP_STATES.SENSE,
      },
    });
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(2500);
  });

  it('awaitFactoryLoop returns heartbeat snapshots when configured and nothing else matches', async () => {
    const { project } = registerPlanProject();
    const started = loopController.startLoopForProject(project.id);

    const result = await loopController.awaitFactoryLoop(project.id, {
      target_states: [LOOP_STATES.LEARN],
      heartbeat_minutes: 0.02,
      timeout_minutes: 1,
    });

    expect(result).toMatchObject({
      status: 'heartbeat',
      timed_out: false,
      instance: {
        id: started.instance_id,
        project_id: project.id,
        loop_state: LOOP_STATES.SENSE,
      },
      latest_decision: {
        stage: 'sense',
        // SENSE logs 'started_loop' then 'scanned_plans'; either is a
        // valid "latest" depending on heartbeat timing.
        action: expect.stringMatching(/^started_loop$|^scanned_plans$/),
        created_at: expect.any(String),
      },
    });
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(1000);
  });
});
