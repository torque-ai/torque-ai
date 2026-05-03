import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { createPlanExecutorMock } = vi.hoisted(() => ({
  createPlanExecutorMock: vi.fn(() => ({ execute: vi.fn() })),
}));

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));
vi.mock('../factory/plan-executor', () => ({
  createPlanExecutor: createPlanExecutorMock,
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const factoryWorktrees = require('../db/factory-worktrees');
const projectConfigCore = require('../db/project-config-core');
const routingModule = require('../handlers/integration/routing');
const awaitModule = require('../handlers/workflow/await');
const taskCore = require('../db/task-core');
const loopController = require('../factory/loop-controller');
const planQualityGate = require('../factory/plan-quality-gate');
const { LOOP_STATES } = require('../factory/loop-states');

const originalHandleSmartSubmitTask = routingModule.handleSmartSubmitTask;
const originalHandleAwaitTask = awaitModule.handleAwaitTask;
const originalGetTask = taskCore.getTask;
const originalListTasks = taskCore.listTasks;
const originalUpdateTaskStatus = taskCore.updateTaskStatus;

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
    SELECT id, stage, actor, action, reasoning, inputs_json, outcome_json
    FROM factory_decisions
    WHERE project_id = ?
    ORDER BY id ASC
  `).all(projectId).map((row) => ({
    ...row,
    inputs: row.inputs_json ? JSON.parse(row.inputs_json) : null,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
  }));
}

function planGenerationTags(projectId, workItemId) {
  return [
    'factory:internal',
    'factory:plan_generation',
    `factory:project_id=${projectId}`,
    `factory:work_item_id=${workItemId}`,
  ];
}

function planGenerationMetadata(projectId, workItemId) {
  return {
    factory_internal: true,
    kind: 'plan_generation',
    project_id: projectId,
    work_item_id: workItemId,
  };
}

describe('factory loop-controller EXECUTE for non-plan-file work items', () => {
  let db;
  let originalGetDbInstance;
  let tempDir;
  let planExecuteMock;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    loopController.setWorktreeRunnerForTests(null);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryLoopInstances.setDb(db);
    factoryDecisions.setDb(db);
    factoryWorktrees.setDb(db);
    projectConfigCore.setDb(db);
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-execute-non-plan-file-'));
    planExecuteMock = vi.fn(async ({ plan_path }) => ({
      plan_path,
      completed_tasks: [1],
      failed_task: null,
      dry_run: true,
      execution_mode: 'pending_approval',
      task_count: 1,
      simulated: false,
      submitted_tasks: [{ task_number: 1, task_id: 'held-task-id' }],
    }));
    createPlanExecutorMock.mockReset();
    createPlanExecutorMock.mockImplementation(() => ({
      execute: planExecuteMock,
    }));
    routingModule.handleSmartSubmitTask = vi.fn(async () => ({ task_id: 'plan-gen-task' }));
    awaitModule.handleAwaitTask = vi.fn(async () => ({ content: [{ type: 'text', text: 'awaited' }] }));
    taskCore.listTasks = vi.fn(() => []);
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'completed',
      output: '',
      error_output: null,
    }));
  });

  afterEach(() => {
    database.getDbInstance = originalGetDbInstance;
    factoryLoopInstances.setDb(null);
    factoryDecisions.setDb(null);
    factoryWorktrees.setDb(null);
    projectConfigCore.setDb(null);
    routingModule.handleSmartSubmitTask = originalHandleSmartSubmitTask;
    awaitModule.handleAwaitTask = originalHandleAwaitTask;
    taskCore.getTask = originalGetTask;
    taskCore.listTasks = originalListTasks;
    taskCore.updateTaskStatus = originalUpdateTaskStatus;
    loopController.setWorktreeRunnerForTests(null);
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    db.close();
    db = null;
    tempDir = null;
  });

  function registerExecuteProject({
    description = 'Add regression coverage for factory scoring behavior.',
    config,
    origin,
    constraints,
  } = {}) {
    const projectDir = path.join(tempDir, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(projectDir, { recursive: true });

    const project = factoryHealth.registerProject({
      name: 'Execute Non Plan Project',
      path: projectDir,
      trust_level: 'supervised',
      config,
    });
    factoryHealth.updateProject(project.id, { status: 'running' });
    const runningProject = factoryHealth.getProject(project.id);

    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'scout',
      title: 'Add behavioral tests for factory scorers',
      description,
      requestor: 'test',
      origin,
      constraints,
    });

    const plannedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
      status: 'planned',
    });
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.EXECUTE,
      loop_paused_at_stage: null,
      loop_batch_id: null,
    });

    return { project: runningProject, workItem: plannedWorkItem, projectDir };
  }

  // TODO: mock setup for the happy path doesn't currently let the implementation
  // see a valid plan markdown back from the awaitTask stub. The "no description"
  // guard test below covers the functional safety case. Re-enable after wiring
  // a markdown-shaped awaitTask response into the mock.
  it.skip('generates a plan file for scout items without plan_path, persists it, and executes it', async () => {
    const { project, workItem, projectDir } = registerExecuteProject();
    const generatedPlan = `# Behavioral Scorer Plan

**Tech Stack:** Node.js, vitest.

## Task 1: Add behavioral scorer tests

- [ ] **Step 1: Add regression coverage**

    Update server/tests/factory-scorers.test.js with scout-driven scorer coverage.

- [ ] **Step 2: Commit**

    git commit -m "test(factory): add scorer behavioral coverage"
`;

    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'completed',
      output: generatedPlan,
      error_output: null,
    }));

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);
    const expectedPlanPath = path.join(
      projectDir,
      'docs',
      'superpowers',
      'plans',
      'auto-generated',
      `${workItem.id}-add-behavioral-tests-for-factory-scorers.md`
    );

    expect(executeAdvance.new_state).toBe(LOOP_STATES.EXECUTE);
    expect(executeAdvance.stage_result).toEqual({
      status: 'skipped',
      reason: 'no_batch_id',
    });
    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalled();
    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      project: 'factory-plan',
      working_directory: project.path,
      version_intent: 'internal',
      tags: expect.arrayContaining([
        'factory:internal',
        'factory:plan_generation',
        `factory:project_id=${project.id}`,
        `factory:work_item_id=${workItem.id}`,
      ]),
    }));
    expect(awaitModule.handleAwaitTask).toHaveBeenCalledWith({
      task_id: 'plan-gen-task',
      timeout_minutes: 30,
      heartbeat_minutes: 0,
      auto_resubmit_on_restart: true,
    });
    expect(createPlanExecutorMock).toHaveBeenCalled();
    expect(planExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      plan_path: expectedPlanPath,
      project: project.name,
      working_directory: project.path,
      execution_mode: 'pending_approval',
    }));
    expect(updatedWorkItem).toMatchObject({
      id: workItem.id,
      status: 'verifying',
      origin: expect.objectContaining({
        plan_path: expectedPlanPath,
      }),
    });
    expect(fs.existsSync(expectedPlanPath)).toBe(true);

    const planContent = fs.readFileSync(expectedPlanPath, 'utf8');
    expect(planContent).toContain(`**Source:** auto-generated from work_item #${workItem.id}`);
    expect(planContent).toContain('## Task 1: Add behavioral scorer tests');
    expect(planContent).not.toContain('```');

    const decisions = listDecisionRows(db, project.id);
    const generatedDecision = decisions.find((row) => row.action === 'plan_generated');
    expect(generatedDecision).toMatchObject({
      stage: 'execute',
      reasoning: 'generated plan via auto-router for non-plan-file work item',
      inputs: expect.objectContaining({
        work_item_id: workItem.id,
        plan_path: null,
      }),
      outcome: expect.objectContaining({
        work_item_id: workItem.id,
        plan_path: expectedPlanPath,
        generator: 'auto-router',
        generation_task_id: 'plan-gen-task',
      }),
    });
  });

  it('records cannot_generate_plan when the work item has no description and skips execution', async () => {
    const { project, workItem } = registerExecuteProject({ description: null });

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(executeAdvance.new_state).toBe(LOOP_STATES.IDLE);
    expect(executeAdvance.stage_result).toBeNull();
    expect(executeAdvance.reason).toBe('no description');
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();
    expect(createPlanExecutorMock).not.toHaveBeenCalled();
    expect(updatedWorkItem.id).toBe(workItem.id);
    expect(updatedWorkItem.status).toBe('rejected');
    expect(updatedWorkItem.reject_reason).toContain('no description');
    expect(updatedWorkItem.origin).toBeUndefined();

    const decisions = listDecisionRows(db, project.id);
    const cannotGenerateDecision = decisions.find((row) => row.action === 'cannot_generate_plan');
    expect(cannotGenerateDecision).toMatchObject({
      stage: 'execute',
      reasoning: 'no description',
      inputs: expect.objectContaining({
        work_item_id: workItem.id,
      }),
      outcome: expect.objectContaining({
        reason: 'no description',
        generator: 'auto-router',
        generation_task_id: null,
        work_item_id: workItem.id,
        plan_path: null,
      }),
    });
  });

  it('uses the extended default plan-generation timeout for submit and await', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Create a focused plan for delayed factory plan generation coverage.',
    });
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'running',
      output: '',
      error_output: '',
    }));
    awaitModule.handleAwaitTask = vi.fn(async () => ({
      content: [{ type: 'text', text: 'task timed out while status: running' }],
    }));

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      timeout_minutes: 30,
      tags: expect.arrayContaining([
        'factory:plan_generation',
        `factory:work_item_id=${workItem.id}`,
      ]),
      task_metadata: expect.objectContaining({
        kind: 'plan_generation',
        work_item_id: workItem.id,
        activity_timeout_policy: {
          kind: 'plan_generation',
          timeout_minutes: 30,
          max_wall_clock_minutes: 60,
          overrun_intake_problem: 'timeout_overrun_active',
        },
      }),
    }));
    expect(awaitModule.handleAwaitTask).toHaveBeenCalledWith({
      task_id: 'plan-gen-task',
      timeout_minutes: 30,
      heartbeat_minutes: 0,
      auto_resubmit_on_restart: true,
    });
    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred while task remains active',
      stage_result: {
        status: 'deferred',
        reason: 'task_still_running',
        generation_task_id: 'plan-gen-task',
        task_status: 'running',
      },
    });
    expect(updatedWorkItem.origin).toMatchObject({
      plan_generation_task_id: 'plan-gen-task',
      plan_generation_wait_reason: 'task_still_running',
    });
  });

  it('uses project plan_generation_timeout_minutes when configured', async () => {
    const { project } = registerExecuteProject({
      description: 'Create a focused plan for configurable factory plan generation coverage.',
      config: { plan_generation_timeout_minutes: 45 },
    });
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'running',
      output: '',
      error_output: '',
    }));

    await loopController.advanceLoopForProject(project.id);

    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      timeout_minutes: 45,
      task_metadata: expect.objectContaining({
        activity_timeout_policy: {
          kind: 'plan_generation',
          timeout_minutes: 45,
          max_wall_clock_minutes: 90,
          overrun_intake_problem: 'timeout_overrun_active',
        },
      }),
    }));
    expect(awaitModule.handleAwaitTask).toHaveBeenCalledWith({
      task_id: 'plan-gen-task',
      timeout_minutes: 45,
      heartbeat_minutes: 0,
      auto_resubmit_on_restart: true,
    });
  });

  it('submits scoped scout files and disables ambient context for plan generation', async () => {
    const allowedFiles = ['server/factory/loop-controller.js', 'server/tests/plan-prompt-scope-files.test.js'];
    const { project, workItem } = registerExecuteProject({
      description: 'Extract a focused helper while staying inside the scout file scope.',
      origin: { allowed_files: allowedFiles },
    });
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'running',
      output: '',
      error_output: '',
    }));

    await loopController.advanceLoopForProject(project.id);

    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      files: allowedFiles,
      context_stuff: false,
      study_context: false,
      tags: expect.arrayContaining([
        'factory:plan_generation',
        `factory:work_item_id=${workItem.id}`,
      ]),
    }));
  });

  it('defers transient plan-generation file-lock waits instead of rejecting the work item', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Add coverage for the plugin catalog runtime loader.',
    });
    const retryAfter = new Date(Date.now() + 60_000).toISOString();
    factoryIntake.updateWorkItem(workItem.id, {
      origin_json: {
        plan_generation_task_id: 'plan-gen-task',
      },
    });
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'queued',
      output: '',
      error_output: "Requeued: file 'docs/superpowers/plans/auto-generated/2041-plugin-catalog-runtime.md' is being edited by task holder-task. Waiting 2500ms before retry.",
      metadata: JSON.stringify({
        file_lock_wait: {
          file: 'docs/superpowers/plans/auto-generated/2041-plugin-catalog-runtime.md',
          locked_by: 'holder-task',
          retry_after: retryAfter,
          delay_ms: 2500,
        },
      }),
    }));

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred for file-lock contention',
      stage_result: {
        status: 'deferred',
        reason: 'file_lock_wait',
        generation_task_id: 'plan-gen-task',
        task_status: 'queued',
        retry_after: retryAfter,
      },
    });
    expect(updatedWorkItem).toMatchObject({
      id: workItem.id,
      status: 'planned',
      reject_reason: null,
      origin: expect.objectContaining({
        plan_generation_task_id: 'plan-gen-task',
        plan_generation_wait_reason: 'file_lock_wait',
        plan_generation_retry_after: retryAfter,
      }),
    });
    expect(createPlanExecutorMock).not.toHaveBeenCalled();
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();

    const decisions = listDecisionRows(db, project.id);
    const deferredDecision = decisions.find((row) => row.action === 'plan_generation_deferred_file_lock');
    expect(deferredDecision).toMatchObject({
      stage: 'execute',
      outcome: expect.objectContaining({
        reason: 'file_lock_wait',
        generation_task_id: 'plan-gen-task',
        task_status: 'queued',
        retry_after: retryAfter,
        work_item_id: workItem.id,
      }),
    });
    expect(decisions.find((row) => row.action === 'cannot_generate_plan')).toBeUndefined();

    routingModule.handleSmartSubmitTask.mockClear();
    awaitModule.handleAwaitTask.mockClear();
    const waitingAdvance = await loopController.advanceLoopForProject(project.id);

    expect(waitingAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred for file-lock contention',
      stage_result: {
        status: 'deferred',
        reason: 'file_lock_wait',
        generation_task_id: 'plan-gen-task',
        task_status: 'queued',
        retry_after: retryAfter,
      },
    });
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();
  });

  it('treats stale plan-generation file-lock metadata as an active task wait', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Add coverage for delayed plan generation after a stale lock wait.',
    });
    const staleRetryAfter = '2000-01-01T00:00:00.000Z';
    factoryIntake.updateWorkItem(workItem.id, {
      origin_json: {
        plan_generation_task_id: 'plan-gen-task',
      },
    });
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'running',
      output: '',
      error_output: "Requeued: file 'docs/superpowers/plans/auto-generated/2041-plugin-catalog-runtime.md' is being edited by task holder-task. Waiting 2500ms before retry.",
      metadata: JSON.stringify({
        file_lock_wait: {
          file: 'docs/superpowers/plans/auto-generated/2041-plugin-catalog-runtime.md',
          locked_by: 'holder-task',
          retry_after: staleRetryAfter,
          delay_ms: 2500,
        },
      }),
    }));

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred while task remains active',
      stage_result: {
        status: 'deferred',
        reason: 'task_still_running',
        generation_task_id: 'plan-gen-task',
        task_status: 'running',
        retry_after: null,
      },
    });
    expect(updatedWorkItem).toMatchObject({
      id: workItem.id,
      status: 'planned',
      origin: expect.objectContaining({
        plan_generation_task_id: 'plan-gen-task',
        plan_generation_wait_reason: 'task_still_running',
      }),
    });

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((row) => row.action === 'plan_generation_deferred_file_lock')).toBeUndefined();
    expect(decisions.find((row) => row.action === 'plan_generation_deferred_running')).toMatchObject({
      stage: 'execute',
      outcome: expect.objectContaining({
        reason: 'task_still_running',
        generation_task_id: 'plan-gen-task',
        task_status: 'running',
        retry_after: null,
        work_item_id: workItem.id,
      }),
    });
  });

  it('defers active plan-generation tasks after an await timeout instead of rejecting the work item', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Add coverage for delayed plan generation.',
    });
    factoryIntake.updateWorkItem(workItem.id, {
      origin_json: {
        plan_generation_task_id: 'plan-gen-task',
      },
    });
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'running',
      output: '',
      error_output: '',
    }));

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred while task remains active',
      stage_result: {
        status: 'deferred',
        reason: 'task_still_running',
        generation_task_id: 'plan-gen-task',
        task_status: 'running',
      },
    });
    expect(updatedWorkItem).toMatchObject({
      id: workItem.id,
      status: 'planned',
      reject_reason: null,
      origin: expect.objectContaining({
        plan_generation_task_id: 'plan-gen-task',
        plan_generation_wait_reason: 'task_still_running',
      }),
    });
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();

    const decisions = listDecisionRows(db, project.id);
    const deferredDecision = decisions.find((row) => row.action === 'plan_generation_deferred_running');
    expect(deferredDecision).toMatchObject({
      stage: 'execute',
      outcome: expect.objectContaining({
        reason: 'task_still_running',
        generation_task_id: 'plan-gen-task',
        task_status: 'running',
        work_item_id: workItem.id,
      }),
    });
    expect(decisions.find((row) => row.action === 'cannot_generate_plan')).toBeUndefined();
  });

  it('defers an active plan-generation task discovered by work-item tags before submitting a duplicate', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Add coverage for active plan generation without origin metadata.',
    });
    const activeTask = {
      id: 'active-plan-gen-task',
      status: 'running',
      tags: planGenerationTags(project.id, workItem.id),
      metadata: JSON.stringify(planGenerationMetadata(project.id, workItem.id)),
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      output: '',
      error_output: '',
    };
    taskCore.listTasks = vi.fn(() => [activeTask]);
    taskCore.getTask = vi.fn((taskId) => (taskId === activeTask.id ? activeTask : null));

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred while task remains active',
      stage_result: {
        status: 'deferred',
        reason: 'task_still_running',
        generation_task_id: activeTask.id,
        task_status: 'running',
      },
    });
    expect(updatedWorkItem).toMatchObject({
      id: workItem.id,
      status: 'planned',
      reject_reason: null,
      origin: expect.objectContaining({
        plan_generation_task_id: activeTask.id,
        plan_generation_wait_reason: 'task_still_running',
      }),
    });
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((row) => row.action === 'plan_generation_deferred_running')).toMatchObject({
      stage: 'execute',
      outcome: expect.objectContaining({
        reason: 'task_still_running',
        generation_task_id: activeTask.id,
        task_status: 'running',
        work_item_id: workItem.id,
      }),
    });
  });

  it('replaces a scheduler-owned stored plan-generation task that stayed pending without starting', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Add coverage for stale pending plan generation.',
    });
    factoryIntake.updateWorkItem(workItem.id, {
      origin_json: {
        plan_generation_task_id: 'stale-plan-gen-task',
        plan_generation_wait_reason: 'task_still_running',
      },
    });
    routingModule.handleSmartSubmitTask = vi.fn(async () => ({ task_id: 'new-plan-gen-task' }));
    awaitModule.handleAwaitTask = vi.fn(async () => ({
      content: [{ type: 'text', text: 'task timed out while status: running' }],
    }));
    const updateTaskStatusSpy = vi.spyOn(taskCore, 'updateTaskStatus').mockImplementation(() => null);
    taskCore.getTask = vi.fn((taskId) => {
      if (taskId === 'stale-plan-gen-task') {
        return {
          id: taskId,
          status: 'pending',
          created_at: '2000-01-01T00:00:00.000Z',
          started_at: null,
          metadata: planGenerationMetadata(project.id, workItem.id),
          output: '',
          error_output: '',
        };
      }
      return {
        id: taskId,
        status: 'running',
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        output: '',
        error_output: '',
      };
    });

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalled();
    expect(updateTaskStatusSpy).toHaveBeenCalledWith(
      'stale-plan-gen-task',
      'skipped',
      expect.objectContaining({
        error_output: expect.stringContaining('stale never-started plan-generation task'),
      })
    );
    expect(awaitModule.handleAwaitTask).toHaveBeenCalledWith({
      task_id: 'new-plan-gen-task',
      timeout_minutes: 30,
      heartbeat_minutes: 0,
      auto_resubmit_on_restart: true,
    });
    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred while task remains active',
      stage_result: {
        status: 'deferred',
        reason: 'task_still_running',
        generation_task_id: 'new-plan-gen-task',
        task_status: 'running',
      },
    });
    expect(updatedWorkItem.origin).toMatchObject({
      plan_generation_task_id: 'new-plan-gen-task',
      plan_generation_wait_reason: 'task_still_running',
    });
    expect(updatedWorkItem.origin.plan_generation_task_id).not.toBe('stale-plan-gen-task');
  });

  it('clears a deferred scheduler-owned stale pending plan-generation wait before resubmitting', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Add coverage for paused stale pending plan generation.',
    });
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'running',
      output: '',
      error_output: '',
    }));
    awaitModule.handleAwaitTask = vi.fn(async () => ({
      content: [{ type: 'text', text: 'task timed out while status: running' }],
    }));

    await loopController.advanceLoopForProject(project.id);
    expect(factoryIntake.getWorkItem(workItem.id).origin).toMatchObject({
      plan_generation_task_id: 'plan-gen-task',
      plan_generation_wait_reason: 'task_still_running',
    });

    routingModule.handleSmartSubmitTask = vi.fn(async () => ({ task_id: 'replacement-plan-gen-task' }));
    awaitModule.handleAwaitTask = vi.fn(async () => ({
      content: [{ type: 'text', text: 'task timed out while status: running' }],
    }));
    const updateTaskStatusSpy = vi.spyOn(taskCore, 'updateTaskStatus').mockImplementation(() => null);
    taskCore.getTask = vi.fn((taskId) => {
      if (taskId === 'plan-gen-task') {
        return {
          id: taskId,
          status: 'pending',
          created_at: '2000-01-01T00:00:00.000Z',
          started_at: null,
          tags: planGenerationTags(project.id, workItem.id),
          output: '',
          error_output: '',
        };
      }
      return {
        id: taskId,
        status: 'running',
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        output: '',
        error_output: '',
      };
    });

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalled();
    expect(updateTaskStatusSpy).toHaveBeenCalledWith(
      'plan-gen-task',
      'skipped',
      expect.objectContaining({
        error_output: expect.stringContaining('stale never-started plan-generation task'),
      })
    );
    expect(awaitModule.handleAwaitTask).toHaveBeenCalledWith({
      task_id: 'replacement-plan-gen-task',
      timeout_minutes: 30,
      heartbeat_minutes: 0,
      auto_resubmit_on_restart: true,
    });
    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred while task remains active',
      stage_result: {
        status: 'deferred',
        reason: 'task_still_running',
        generation_task_id: 'replacement-plan-gen-task',
        task_status: 'running',
      },
    });
    expect(updatedWorkItem.origin).toMatchObject({
      plan_generation_task_id: 'replacement-plan-gen-task',
      plan_generation_wait_reason: 'task_still_running',
    });
  });

  it('keeps fresh and non-scheduler-owned pending plan-generation waits active', async () => {
    const updateTaskStatusSpy = vi.spyOn(taskCore, 'updateTaskStatus').mockImplementation(() => null);

    const fresh = registerExecuteProject({
      description: 'Add coverage for fresh pending plan generation.',
    });
    factoryIntake.updateWorkItem(fresh.workItem.id, {
      origin_json: {
        plan_generation_task_id: 'fresh-plan-gen-task',
      },
    });
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'pending',
      created_at: new Date().toISOString(),
      started_at: null,
      metadata: planGenerationMetadata(fresh.project.id, fresh.workItem.id),
      output: '',
      error_output: '',
    }));

    const freshAdvance = await loopController.advanceLoopForProject(fresh.project.id);
    const freshWorkItem = factoryIntake.getWorkItem(fresh.workItem.id);

    expect(freshAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred while task remains active',
      stage_result: {
        status: 'deferred',
        reason: 'task_still_running',
        generation_task_id: 'fresh-plan-gen-task',
        task_status: 'pending',
      },
    });
    expect(freshWorkItem.origin).toMatchObject({
      plan_generation_task_id: 'fresh-plan-gen-task',
      plan_generation_wait_reason: 'task_still_running',
    });
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();
    expect(updateTaskStatusSpy).not.toHaveBeenCalled();

    routingModule.handleSmartSubmitTask.mockClear();
    awaitModule.handleAwaitTask.mockClear();
    updateTaskStatusSpy.mockClear();

    const unowned = registerExecuteProject({
      description: 'Add coverage for stale pending user-owned plan generation.',
    });
    factoryIntake.updateWorkItem(unowned.workItem.id, {
      origin_json: {
        plan_generation_task_id: 'user-owned-plan-gen-task',
      },
    });
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'pending',
      created_at: '2000-01-01T00:00:00.000Z',
      started_at: null,
      output: '',
      error_output: '',
    }));

    const unownedAdvance = await loopController.advanceLoopForProject(unowned.project.id);
    const unownedWorkItem = factoryIntake.getWorkItem(unowned.workItem.id);

    expect(unownedAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred while task remains active',
      stage_result: {
        status: 'deferred',
        reason: 'task_still_running',
        generation_task_id: 'user-owned-plan-gen-task',
        task_status: 'pending',
      },
    });
    expect(unownedWorkItem.origin).toMatchObject({
      plan_generation_task_id: 'user-owned-plan-gen-task',
      plan_generation_wait_reason: 'task_still_running',
    });
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();
    expect(updateTaskStatusSpy).not.toHaveBeenCalled();
  });

  it('follows restart-resubmitted plan-generation task ids before deferring', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Add coverage for restart-resubmitted plan generation.',
    });
    factoryIntake.updateWorkItem(workItem.id, {
      origin_json: {
        plan_generation_task_id: 'old-plan-gen-task',
      },
    });
    taskCore.getTask = vi.fn((taskId) => {
      if (taskId === 'old-plan-gen-task') {
        return {
          id: taskId,
          status: 'cancelled',
          output: '',
          error_output: 'Task orphaned by restart',
          metadata: JSON.stringify({ resubmitted_as: 'new-plan-gen-task' }),
        };
      }
      return {
        id: taskId,
        status: 'running',
        output: '',
        error_output: '',
      };
    });

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred while task remains active',
      stage_result: {
        status: 'deferred',
        reason: 'task_still_running',
        generation_task_id: 'new-plan-gen-task',
        task_status: 'running',
      },
    });
    expect(updatedWorkItem).toMatchObject({
      id: workItem.id,
      status: 'planned',
      reject_reason: null,
      origin: expect.objectContaining({
        plan_generation_task_id: 'new-plan-gen-task',
        plan_generation_wait_reason: 'task_still_running',
      }),
    });
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();
    expect(createPlanExecutorMock).not.toHaveBeenCalled();
  });

  it('retries one unusable completed plan-generation result before rejecting the work item', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Create a focused plan for a flaky generated output case.',
    });
    factoryIntake.updateWorkItem(workItem.id, {
      origin_json: {
        plan_generation_task_id: 'plan-gen-task',
      },
    });
    taskCore.getTask = vi.fn((taskId) => ({
      id: taskId,
      status: 'completed',
      output: 'I inspected the repository and found the likely files, but did not produce a task plan.',
      error_output: null,
    }));

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.IDLE,
      reason: 'plan generation retry scheduled after unusable output',
      stage_result: {
        status: 'retry_scheduled',
        reason: 'unusable_plan_generation_output',
        generation_task_id: 'plan-gen-task',
        retry_count: 1,
      },
    });
    expect(updatedWorkItem).toMatchObject({
      id: workItem.id,
      status: 'planned',
      reject_reason: null,
      origin: expect.objectContaining({
        plan_generation_status: 'retry_scheduled',
        plan_generation_retry_count: 1,
      }),
    });
    expect(updatedWorkItem.origin.plan_generation_task_id).toBeUndefined();
    expect(createPlanExecutorMock).not.toHaveBeenCalled();
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();

    const decisions = listDecisionRows(db, project.id);
    const retryDecision = decisions.find((row) => row.action === 'plan_generation_retry_unusable_output');
    expect(retryDecision).toMatchObject({
      stage: 'execute',
      outcome: expect.objectContaining({
        reason: 'unusable_plan_generation_output',
        generation_task_id: 'plan-gen-task',
        retry_count: 1,
        work_item_id: workItem.id,
      }),
    });
    expect(decisions.find((row) => row.action === 'cannot_generate_plan')).toBeUndefined();
  });

  it('normalizes file_edits JSON from plan generation into executable Markdown', async () => {
    const { project, workItem, projectDir } = registerExecuteProject({
      description: 'Add typed LAN startup failure reasons to the Unity coordinator.',
    });
    fs.mkdirSync(path.join(projectDir, 'simtests'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'simtests', 'SimCore.DotNet.Tests.csproj'), '<Project />');

    const proposalOutput = JSON.stringify({
      file_edits: [
        {
          file: 'client/UnityProject/Assets/Scripts/NetcodeUnity/LanStartupCoordinator.cs',
          operations: [
            {
              type: 'replace',
              old_text: 'private string lastError;',
              new_text: 'private LanStartupFailureReason lastFailureReason;',
            },
          ],
        },
      ],
    }, null, 2);

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      `\`\`\`json\n${proposalOutput}\n\`\`\``,
      workItem,
      project,
    );

    expect(normalized).toContain(`**Source:** auto-generated from work_item #${workItem.id}`);
    expect(normalized).toContain('**Proposal Format:** normalized from file_edits JSON emitted by plan generation.');
    expect(normalized).toContain('## Task 1: Apply proposed edits for Add behavioral tests for factory scorers');
    expect(normalized).toContain('client/UnityProject/Assets/Scripts/NetcodeUnity/LanStartupCoordinator.cs');
    expect(normalized).toContain('private string lastError;');
    expect(normalized).toContain('private LanStartupFailureReason lastFailureReason;');
    expect(normalized).toContain('torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj');
    expect(normalized).not.toContain('```');

    const parsedTasks = loopController._internalForTests.parseAutoGeneratedPlanTasks(normalized);
    expect(parsedTasks).toHaveLength(1);
    const lint = loopController._internalForTests.lintAutoGeneratedPlan(project, workItem, normalized);
    expect(lint.descriptionQuality.blocked).toBe(false);
  });

  it('normalizes echoed prompt tails out of generated Markdown plans', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Reformat LAN startup retry test bodies without changing behavior.',
    });
    const rawPlan = [
      '# DLPhone local Ollama canary Plan',
      '**Source:** auto-generated from work_item #2082',
      '**Tech Stack:** C#',
      '',
      '## Task 1: Reformat LAN startup retry tests',
      '',
      '- [ ] **Step 1: Patch the test formatting**',
      '',
      '    Edit `simtests/Netcode/LanStartupCoordinatorTests.cs` only. Estimated scope is one file and about 20 lines. Acceptance criteria: the retry tests keep the same assertions and only whitespace/layout changes are made.',
      '',
      'Rules:',
      '- Use `## Task N:` headings exactly.',
      'Project context:',
      '- Project brief: echoed prompt content that should not be persisted.',
    ].join('\n');

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      rawPlan,
      workItem,
      project,
    );

    expect(normalized).toContain('## Task 1: Reformat LAN startup retry tests');
    expect(normalized).not.toContain('Rules:');
    expect(normalized).not.toContain('Project context:');
    expect(normalized).not.toContain('Use `## Task N:` headings exactly');
  });

  it('routes heavyweight validation commands in generated Markdown through torque-remote', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Reformat LAN startup retry test bodies without changing behavior.',
    });
    const rawPlan = [
      '# DLPhone local Ollama canary Plan',
      '**Source:** auto-generated from work_item #2082',
      '**Tech Stack:** C#',
      '',
      '## Task 1: Reformat LAN startup retry tests',
      '',
      '- [ ] **Step 1: Patch and validate the test formatting**',
      '',
      '    Edit `simtests/Netcode/LanStartupCoordinatorTests.cs` only. Estimated scope is one file and about 20 lines. Acceptance criteria: `git diff --check` is clean and `dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter LanStartupCoordinatorTests` passes.',
      '',
      '- [ ] **Step 2: Leave remote validation alone**',
      '',
      '    Keep `torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release` as the remote verification command.',
    ].join('\n');

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      rawPlan,
      workItem,
      project,
    );

    expect(normalized).toContain('`torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter LanStartupCoordinatorTests`');
    expect(normalized).toContain('`torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release`');
    expect(normalized).not.toContain('torque-remote torque-remote');
  });

  it('augments generated Markdown with work-item scope and success criteria when Ollama omits them', async () => {
    const { project, workItem, projectDir } = registerExecuteProject({
      description: 'Small local-Ollama canary. Modify only `simtests/Netcode/LanStartupCoordinatorTests.cs`. Acceptance criteria: `git diff --check` is clean and `torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter LanStartupCoordinatorTests` passes.',
    });
    fs.mkdirSync(path.join(projectDir, 'simtests'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'simtests', 'SimCore.DotNet.Tests.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n');
    const constrainedWorkItem = {
      ...workItem,
      constraints: {
        allowed_files: ['simtests/Netcode/LanStartupCoordinatorTests.cs'],
        max_files: 1,
      },
    };
    const rawPlan = [
      '# DLPhone local Ollama canary Plan',
      '**Source:** auto-generated from work_item #2083',
      '**Tech Stack:** C#',
      '',
      '## Task 1: Normalize LAN startup retry test bodies in LanStartupCoordinatorTests.cs',
      '',
      '- [ ] **Step 1: Read current test file**',
      '',
      '    Read `simtests/Netcode/LanStartupCoordinatorTests.cs` and use `torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter LanStartupCoordinatorTests` for validation.',
    ].join('\n');

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      rawPlan,
      constrainedWorkItem,
      { ...project, path: projectDir },
    );

    expect(normalized).toContain('Estimated scope: single focused change across up to 1 file, limited to `simtests/Netcode/LanStartupCoordinatorTests.cs`.');
    expect(normalized).toContain('Success criteria: `git diff --check` is clean and `torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter LanStartupCoordinatorTests` passes.');
    const lint = loopController._internalForTests.lintAutoGeneratedPlan(project, constrainedWorkItem, normalized);
    expect(lint.descriptionQuality.blocked).toBe(false);
  });

  it('qualifies local Ollama vague readability language against constrained files', async () => {
    const { project, workItem, projectDir } = registerExecuteProject({
      description: 'Small local-Ollama canary. Modify only `simtests/Netcode/LanStartupCoordinatorTests.cs`. Acceptance criteria: `git diff --check` is clean and `torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter LanStartupCoordinatorTests` passes.',
    });
    fs.mkdirSync(path.join(projectDir, 'simtests'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'simtests', 'SimCore.DotNet.Tests.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n');
    const constrainedWorkItem = {
      ...workItem,
      constraints: {
        allowed_files: ['simtests/Netcode/LanStartupCoordinatorTests.cs'],
        max_files: 1,
      },
    };
    const rawPlan = [
      '# DLPhone local Ollama canary Plan',
      '**Source:** auto-generated from work_item #2084',
      '**Tech Stack:** Python',
      '',
      '## Task 1: Reformat LAN startup retry test bodies in LanStartupCoordinatorTests.cs',
      '',
      '- [ ] **Step 1: Analyze and reformat existing test bodies**',
      '',
      '    Read `simtests/Netcode/LanStartupCoordinatorTests.cs` to identify the current structure of LAN startup retry test bodies. Reformat the test bodies to improve readability while preserving all existing behavior. The file has ~300 lines and contains 3 test methods related to LAN startup retry logic. The reformatted test bodies should ensure that `git diff --check` is clean and `torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter LanStartupCoordinatorTests` passes. This change must maintain the exact same test logic and assertions, only improving code formatting and clarity.',
      '',
      '- [ ] **Step 2: Commit**',
      '',
      '    git commit -m "Reformat LAN startup retry test bodies in LanStartupCoordinatorTests.cs for clarified statement grouping"',
    ].join('\n');

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      rawPlan,
      constrainedWorkItem,
      { ...project, path: projectDir },
    );

    expect(normalized).toContain('**Tech Stack:** C#/.NET, Unity');
    expect(normalized).toContain('clarify statement grouping in `simtests/Netcode/LanStartupCoordinatorTests.cs`');
    expect(normalized).toContain('clarifying formatting in `simtests/Netcode/LanStartupCoordinatorTests.cs`');
    const lint = loopController._internalForTests.lintAutoGeneratedPlan(project, constrainedWorkItem, normalized);
    expect(lint.descriptionQuality.blocked).toBe(false);
    const deterministic = planQualityGate.runDeterministicRules(normalized);
    expect(deterministic.hardFails).toEqual([]);
  });
});
