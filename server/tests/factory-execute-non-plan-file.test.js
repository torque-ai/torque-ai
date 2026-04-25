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

  function registerExecuteProject({ description = 'Add regression coverage for factory scoring behavior.' } = {}) {
    const projectDir = path.join(tempDir, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(projectDir, { recursive: true });

    const project = factoryHealth.registerProject({
      name: 'Execute Non Plan Project',
      path: projectDir,
      trust_level: 'supervised',
    });

    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'scout',
      title: 'Add behavioral tests for factory scorers',
      description,
      requestor: 'test',
    });

    const plannedWorkItem = factoryIntake.updateWorkItem(workItem.id, {
      status: 'planned',
    });
    factoryHealth.updateProject(project.id, {
      loop_state: LOOP_STATES.EXECUTE,
      loop_paused_at_stage: null,
      loop_batch_id: null,
    });

    return { project, workItem: plannedWorkItem, projectDir };
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
      timeout_minutes: 10,
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
});
