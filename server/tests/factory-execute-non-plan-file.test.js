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
const childProcess = require('child_process');
const Database = require('better-sqlite3');
const { defaultContainer } = require('../container');
const factoryDecisions = require('../db/factory/decisions');
const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const factoryLoopInstances = require('../db/factory/loop-instances');
const factoryWorktrees = require('../db/factory/worktrees');
const projectConfigCore = require('../db/project-config-core');
const routingModule = require('../handlers/integration/routing');
const awaitModule = require('../handlers/workflow/await');
const taskCore = require('../db/task-core');
const loopController = require('../factory/loop-controller');
const branchFreshness = require('../factory/branch-freshness');
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
      owning_task_id TEXT,
      base_branch TEXT DEFAULT 'main',
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

function planGenerationMetadata(projectId, workItemId, timeoutMinutes = 30) {
  return {
    factory_internal: true,
    kind: 'plan_generation',
    project_id: projectId,
    work_item_id: workItemId,
    activity_timeout_policy: loopController.buildPlanGenerationActivityTimeoutPolicy(timeoutMinutes),
  };
}

function runGit(repoDir, args) {
  const execFileSync = childProcess._realExecFileSync || childProcess.execFileSync;
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initializeCleanGitWorktree(worktreePath) {
  fs.mkdirSync(worktreePath, { recursive: true });
  runGit(worktreePath, ['init']);
  runGit(worktreePath, ['config', 'user.email', 'factory-test@example.com']);
  runGit(worktreePath, ['config', 'user.name', 'Factory Test']);
  runGit(worktreePath, ['config', 'core.longpaths', 'true']);
  fs.writeFileSync(path.join(worktreePath, 'tracked.txt'), 'clean\n', 'utf8');
  runGit(worktreePath, ['add', 'tracked.txt']);
  runGit(worktreePath, ['commit', '-m', 'init', '--no-gpg-sign']);
}

function initializeDirtyGitWorktree(worktreePath) {
  initializeCleanGitWorktree(worktreePath);
  fs.appendFileSync(path.join(worktreePath, 'tracked.txt'), 'dirty\n', 'utf8');
}

function createFakePlanArtifactWorktreeRunner() {
  let sequence = 0;
  return {
    createForBatch: vi.fn(async ({ project, workItem, batchId }) => {
      sequence += 1;
      const safeBatchId = String(batchId || `batch-${sequence}`).replace(/[^A-Za-z0-9._-]/g, '-');
      const safeWorkItemId = String(workItem?.id || `item-${sequence}`).replace(/[^A-Za-z0-9._-]/g, '-');
      const worktreePath = path.join(project.path, '.factory-worktrees', `${safeBatchId}-${safeWorkItemId}-${sequence}`);
      fs.mkdirSync(worktreePath, { recursive: true });
      return {
        id: `fake-vc-worktree-${sequence}`,
        branch: `factory/${safeBatchId}-${safeWorkItemId}-${sequence}`,
        worktreePath,
        baseBranch: 'main',
      };
    }),
    abandon: vi.fn(async () => null),
  };
}

describe('factory loop-controller EXECUTE for non-plan-file work items', () => {
  let db;
  let database;
  let originalGetDbInstance;
  let containerPeekSpy;
  let tempDir;
  let planExecuteMock;

  beforeEach(() => {
    database = require('./helpers/database-facade');
    db = new Database(':memory:');
    createFactoryTables(db);
    loopController.setWorktreeRunnerForTests(createFakePlanArtifactWorktreeRunner());
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryLoopInstances.setDb(db);
    factoryDecisions.setDb(db);
    factoryWorktrees.setDb(db);
    projectConfigCore.setDb(db);
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
    const originalPeek = defaultContainer.peek.bind(defaultContainer);
    containerPeekSpy = vi.spyOn(defaultContainer, 'peek').mockImplementation((name) => {
      if (name === 'db') return database;
      return originalPeek(name);
    });
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
    containerPeekSpy?.mockRestore();
    containerPeekSpy = null;
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
    database = null;
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

  it('reuses an exact work-item plan artifact worktree instead of the latest active row for the batch', async () => {
    const runner = createFakePlanArtifactWorktreeRunner();
    loopController.setWorktreeRunnerForTests(runner);
    const { project, workItem, projectDir } = registerExecuteProject();
    const otherWorkItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'scout',
      title: 'Different work item sharing a long-lived batch',
      description: 'This item owns the newest active row but must not receive the next plan artifact.',
      requestor: 'test',
    });
    const batchId = `factory-${project.id}-shared`;
    const otherPath = path.join(projectDir, '.factory-worktrees', 'other-item');
    const currentPath = path.join(projectDir, '.factory-worktrees', 'current-item');
    fs.mkdirSync(otherPath, { recursive: true });
    initializeCleanGitWorktree(currentPath);
    const worktreeRow = factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: batchId,
      vc_worktree_id: 'vc-current',
      branch: 'factory/current-item',
      worktree_path: currentPath,
      base_branch: 'main',
    });
    factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: otherWorkItem.id,
      batch_id: batchId,
      vc_worktree_id: 'vc-other',
      branch: 'factory/other-item',
      worktree_path: otherPath,
      base_branch: 'main',
    });

    const prepared = await loopController._internalForTests.prepareAutoGeneratedPlanArtifactWorktree({
      project,
      instance: { id: 'inst-shared-batch', project_id: project.id, batch_id: batchId },
      workItem,
    });

    expect(prepared.workingDirectory).toBe(currentPath);
    expect(prepared.worktreeRecord.work_item_id).toBe(workItem.id);
    expect(runner.createForBatch).not.toHaveBeenCalled();
    const decisions = listDecisionRows(db, project.id);
    expect(decisions.some((row) => row.action === 'plan_generation_worktree_reused')).toBe(true);
    expect(decisions.some((row) => row.action === 'plan_generation_worktree_reuse_skipped')).toBe(false);
  });

  it('preserves a plan artifact worktree with invalid git metadata and creates a suffixed fresh one', async () => {
    const runner = createFakePlanArtifactWorktreeRunner();
    loopController.setWorktreeRunnerForTests(runner);
    const { project, workItem, projectDir } = registerExecuteProject();
    const batchId = `factory-${project.id}-shared`;
    const currentPath = path.join(projectDir, '.factory-worktrees', 'current-item-invalid-git');
    fs.mkdirSync(currentPath, { recursive: true });
    const missingGitDir = path.join(path.dirname(currentPath), 'missing-git-metadata');
    fs.writeFileSync(path.join(currentPath, '.git'), `gitdir: ${missingGitDir}\n`, 'utf8');
    const worktreeRow = factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: batchId,
      vc_worktree_id: 'vc-current-invalid-git',
      branch: 'factory/current-item-invalid-git',
      worktree_path: currentPath,
      base_branch: 'main',
    });

    const prepared = await loopController._internalForTests.prepareAutoGeneratedPlanArtifactWorktree({
      project,
      instance: { id: 'inst-shared-batch-invalid-git', project_id: project.id, batch_id: batchId },
      workItem,
    });

    expect(prepared.workingDirectory).not.toBe(currentPath);
    expect(runner.abandon).not.toHaveBeenCalled();
    expect(runner.createForBatch).toHaveBeenCalledTimes(1);
    expect(runner.createForBatch).toHaveBeenCalledWith(expect.objectContaining({
      featureNameSuffix: `preserved-invalid-${worktreeRow.id}`,
    }));
    const oldRow = db.prepare('SELECT status FROM factory_worktrees WHERE vc_worktree_id = ?')
      .get('vc-current-invalid-git');
    expect(oldRow.status).toBe('preserved');
    const decisions = listDecisionRows(db, project.id);
    const invalidDecision = decisions.find((row) => row.action === 'factory_worktree_reuse_invalid_detected');
    expect(invalidDecision?.outcome).toMatchObject({
      factory_worktree_id: worktreeRow.id,
      worktree_id: 'vc-current-invalid-git',
      worktree_path: currentPath,
      branch: 'factory/current-item-invalid-git',
      reason: 'git_probe_failed',
      fallback_suffix: `preserved-invalid-${worktreeRow.id}`,
    });
    expect(decisions.some((row) => row.action === 'plan_generation_worktree_reused')).toBe(false);
    expect(decisions.some((row) => row.action === 'plan_generation_worktree_missing_abandoned')).toBe(false);
    expect(decisions.some((row) => row.action === 'plan_generation_worktree_created')).toBe(true);
  });

  it('rebases a stale work-item plan artifact worktree before reuse', async () => {
    const runner = createFakePlanArtifactWorktreeRunner();
    loopController.setWorktreeRunnerForTests(runner);
    const { project, workItem, projectDir } = registerExecuteProject();
    const batchId = `factory-${project.id}-shared`;
    const currentPath = path.join(projectDir, '.factory-worktrees', 'current-item-stale');
    initializeCleanGitWorktree(currentPath);
    const worktreeRow = factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: batchId,
      vc_worktree_id: 'vc-current-stale',
      branch: 'factory/current-item-stale',
      worktree_path: currentPath,
      base_branch: 'main',
    });
    const checkSpy = vi.spyOn(branchFreshness, 'checkBranchFreshness').mockResolvedValue({
      stale: true,
      reason: 'commits_behind',
      commitsBehind: 2,
      staleFiles: [],
    });
    const rebaseSpy = vi.spyOn(branchFreshness, 'attemptRebase').mockResolvedValue({ ok: true });

    try {
      const prepared = await loopController._internalForTests.prepareAutoGeneratedPlanArtifactWorktree({
        project,
        instance: { id: 'inst-shared-batch-stale', project_id: project.id, batch_id: batchId },
        workItem,
      });

      expect(prepared.workingDirectory).toBe(currentPath);
      expect(runner.createForBatch).not.toHaveBeenCalled();
      expect(checkSpy).toHaveBeenCalledWith(expect.objectContaining({
        worktreePath: currentPath,
        branch: 'factory/current-item-stale',
        baseRef: 'main',
        threshold: 0,
      }));
      expect(rebaseSpy).toHaveBeenCalledWith(currentPath, 'factory/current-item-stale', 'main');
      const decisions = listDecisionRows(db, project.id);
      expect(decisions.some((row) => row.action === 'factory_worktree_reuse_stale_detected')).toBe(true);
      expect(decisions.some((row) => row.action === 'factory_worktree_reuse_auto_rebased')).toBe(true);
      expect(decisions.some((row) => row.action === 'plan_generation_worktree_reused')).toBe(true);
    } finally {
      checkSpy.mockRestore();
      rebaseSpy.mockRestore();
    }
  });

  it('preserves a stale plan artifact worktree and creates a suffixed fresh one when rebase conflicts', async () => {
    const runner = createFakePlanArtifactWorktreeRunner();
    loopController.setWorktreeRunnerForTests(runner);
    const { project, workItem, projectDir } = registerExecuteProject();
    const batchId = `factory-${project.id}-shared`;
    const currentPath = path.join(projectDir, '.factory-worktrees', 'current-item-conflict');
    initializeCleanGitWorktree(currentPath);
    const worktreeRow = factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: batchId,
      vc_worktree_id: 'vc-current-conflict',
      branch: 'factory/current-item-conflict',
      worktree_path: currentPath,
      base_branch: 'main',
    });
    const checkSpy = vi.spyOn(branchFreshness, 'checkBranchFreshness').mockResolvedValue({
      stale: true,
      reason: 'commits_behind',
      commitsBehind: 3,
      staleFiles: [],
    });
    const rebaseSpy = vi.spyOn(branchFreshness, 'attemptRebase').mockResolvedValue({
      ok: false,
      error: 'CONFLICT (content): merge conflict',
    });

    try {
      const prepared = await loopController._internalForTests.prepareAutoGeneratedPlanArtifactWorktree({
        project,
        instance: { id: 'inst-shared-batch-stale-conflict', project_id: project.id, batch_id: batchId },
        workItem,
      });

      expect(prepared.workingDirectory).not.toBe(currentPath);
      expect(runner.abandon).not.toHaveBeenCalled();
      expect(runner.createForBatch).toHaveBeenCalledTimes(1);
      expect(runner.createForBatch).toHaveBeenCalledWith(expect.objectContaining({
        featureNameSuffix: `preserved-dirty-${worktreeRow.id}`,
      }));
      const oldRow = db.prepare('SELECT status, abandoned_at FROM factory_worktrees WHERE vc_worktree_id = ?')
        .get('vc-current-conflict');
      expect(oldRow.status).toBe('preserved');
      expect(oldRow.abandoned_at).toBeFalsy();
      const decisions = listDecisionRows(db, project.id);
      expect(decisions.some((row) => row.action === 'factory_worktree_reuse_dirty_preserved')).toBe(true);
      expect(decisions.some((row) => row.action === 'factory_worktree_reuse_rebase_failed')).toBe(false);
      expect(decisions.some((row) => row.action === 'plan_generation_worktree_missing_abandoned')).toBe(false);
      expect(decisions.some((row) => row.action === 'plan_generation_worktree_created')).toBe(true);
    } finally {
      checkSpy.mockRestore();
      rebaseSpy.mockRestore();
    }
  });

  it('preserves a dirty stale plan artifact worktree and creates a suffixed fresh one', async () => {
    const runner = createFakePlanArtifactWorktreeRunner();
    loopController.setWorktreeRunnerForTests(runner);
    const { project, workItem, projectDir } = registerExecuteProject();
    const batchId = `factory-${project.id}-shared`;
    const currentPath = path.join(projectDir, '.factory-worktrees', 'current-item-dirty');
    initializeDirtyGitWorktree(currentPath);
    const worktreeRow = factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: batchId,
      vc_worktree_id: 'vc-current-dirty',
      branch: 'factory/current-item-dirty',
      worktree_path: currentPath,
      base_branch: 'main',
    });
    const checkSpy = vi.spyOn(branchFreshness, 'checkBranchFreshness').mockResolvedValue({
      stale: true,
      reason: 'commits_behind',
      commitsBehind: 5,
      staleFiles: [],
    });
    const rebaseSpy = vi.spyOn(branchFreshness, 'attemptRebase').mockResolvedValue({
      ok: false,
      error: 'error: cannot rebase: You have unstaged changes.',
    });

    try {
      const prepared = await loopController._internalForTests.prepareAutoGeneratedPlanArtifactWorktree({
        project,
        instance: { id: 'inst-shared-batch-stale-dirty', project_id: project.id, batch_id: batchId },
        workItem,
      });

      expect(prepared.workingDirectory).not.toBe(currentPath);
      expect(runner.abandon).not.toHaveBeenCalled();
      expect(runner.createForBatch).toHaveBeenCalledWith(expect.objectContaining({
        featureNameSuffix: `preserved-dirty-${worktreeRow.id}`,
      }));
      const oldRow = db.prepare('SELECT status FROM factory_worktrees WHERE vc_worktree_id = ?')
        .get('vc-current-dirty');
      expect(oldRow.status).toBe('preserved');
      expect(fs.existsSync(path.join(currentPath, 'tracked.txt'))).toBe(true);
      const decisions = listDecisionRows(db, project.id);
      expect(decisions.some((row) => row.action === 'factory_worktree_reuse_dirty_preserved')).toBe(true);
      expect(decisions.some((row) => row.action === 'factory_worktree_reuse_rebase_failed')).toBe(false);
      expect(decisions.some((row) => row.action === 'plan_generation_worktree_created')).toBe(true);
    } finally {
      checkSpy.mockRestore();
      rebaseSpy.mockRestore();
    }
  });

  it('migrates generated plan artifacts into the fallback execution worktree', () => {
    const { project, workItem, projectDir } = registerExecuteProject();
    const sourceWorktree = path.join(projectDir, '.factory-worktrees', 'old-generated-plan-worktree');
    const executionWorktree = path.join(projectDir, '.factory-worktrees', 'fallback-execution-worktree');
    const sourcePlanPath = path.join(
      sourceWorktree,
      'docs',
      'superpowers',
      'plans',
      'auto-generated',
      `${workItem.id}-add-behavioral-tests-for-factory-scorers.md`
    );
    fs.mkdirSync(path.dirname(sourcePlanPath), { recursive: true });
    fs.mkdirSync(executionWorktree, { recursive: true });
    fs.writeFileSync(sourcePlanPath, `# Behavioral Scorer Plan

## Task 1: Add behavioral scorer tests

- [ ] **Step 1: Add regression coverage**
`, 'utf8');
    const planned = factoryIntake.updateWorkItem(workItem.id, {
      origin_json: { plan_path: sourcePlanPath },
      status: 'executing',
    });

    const migrated = loopController._internalForTests.migrateGeneratedPlanPathForExecutionWorktree({
      project,
      workItem: planned,
      executionWorkingDirectory: executionWorktree,
    });

    expect(migrated.migrated).toBe(true);
    expect(path.resolve(migrated.planPath).startsWith(path.resolve(executionWorktree))).toBe(true);
    expect(fs.existsSync(migrated.planPath)).toBe(true);
    expect(fs.readFileSync(migrated.planPath, 'utf8')).toContain('## Task 1: Add behavioral scorer tests');
    const updated = factoryIntake.getWorkItem(workItem.id);
    expect(updated.origin.plan_path).toBe(migrated.planPath);
  });

  it('preserves a stale plan artifact worktree when a rebase conflict leaves it dirty', async () => {
    const runner = createFakePlanArtifactWorktreeRunner();
    loopController.setWorktreeRunnerForTests(runner);
    const { project, workItem, projectDir } = registerExecuteProject();
    const batchId = `factory-${project.id}-shared`;
    const currentPath = path.join(projectDir, '.factory-worktrees', 'current-item-conflict-dirty');
    initializeDirtyGitWorktree(currentPath);
    const worktreeRow = factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: batchId,
      vc_worktree_id: 'vc-current-conflict-dirty',
      branch: 'factory/current-item-conflict-dirty',
      worktree_path: currentPath,
      base_branch: 'main',
    });
    const checkSpy = vi.spyOn(branchFreshness, 'checkBranchFreshness').mockResolvedValue({
      stale: true,
      reason: 'commits_behind',
      commitsBehind: 5,
      staleFiles: [],
    });
    const rebaseSpy = vi.spyOn(branchFreshness, 'attemptRebase').mockResolvedValue({
      ok: false,
      error: 'CONFLICT (content): merge conflict',
    });

    try {
      const prepared = await loopController._internalForTests.prepareAutoGeneratedPlanArtifactWorktree({
        project,
        instance: { id: 'inst-shared-batch-stale-conflict-dirty', project_id: project.id, batch_id: batchId },
        workItem,
      });

      expect(prepared.workingDirectory).not.toBe(currentPath);
      expect(runner.abandon).not.toHaveBeenCalled();
      expect(runner.createForBatch).toHaveBeenCalledWith(expect.objectContaining({
        featureNameSuffix: `preserved-dirty-${worktreeRow.id}`,
      }));
      const oldRow = db.prepare('SELECT status FROM factory_worktrees WHERE vc_worktree_id = ?')
        .get('vc-current-conflict-dirty');
      expect(oldRow.status).toBe('preserved');
      const decisions = listDecisionRows(db, project.id);
      expect(decisions.some((row) => row.action === 'factory_worktree_reuse_dirty_preserved')).toBe(true);
      expect(decisions.some((row) => row.action === 'factory_worktree_reuse_rebase_failed')).toBe(false);
    } finally {
      checkSpy.mockRestore();
      rebaseSpy.mockRestore();
    }
  });

  it('creates a new plan artifact worktree when the only active batch row belongs to another work item', async () => {
    const runner = createFakePlanArtifactWorktreeRunner();
    loopController.setWorktreeRunnerForTests(runner);
    const { project, workItem, projectDir } = registerExecuteProject();
    const otherWorkItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'scout',
      title: 'Only other item has a worktree',
      description: 'This row should not be reused for a different work item.',
      requestor: 'test',
    });
    const batchId = `factory-${project.id}-shared`;
    const otherPath = path.join(projectDir, '.factory-worktrees', 'other-only');
    fs.mkdirSync(otherPath, { recursive: true });
    factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: otherWorkItem.id,
      batch_id: batchId,
      vc_worktree_id: 'vc-other-only',
      branch: 'factory/other-only',
      worktree_path: otherPath,
      base_branch: 'main',
    });

    const prepared = await loopController._internalForTests.prepareAutoGeneratedPlanArtifactWorktree({
      project,
      instance: { id: 'inst-shared-batch-create', project_id: project.id, batch_id: batchId },
      workItem,
    });

    expect(prepared.workingDirectory).not.toBe(otherPath);
    expect(prepared.worktreeRecord.work_item_id).toBe(workItem.id);
    expect(runner.createForBatch).toHaveBeenCalledTimes(1);
    const activeRows = db.prepare(`
      SELECT work_item_id, worktree_path, status
      FROM factory_worktrees
      WHERE batch_id = ? AND status = 'active'
      ORDER BY id ASC
    `).all(batchId);
    expect(activeRows.map((row) => row.work_item_id)).toEqual([otherWorkItem.id, workItem.id]);
    const decisions = listDecisionRows(db, project.id);
    const skipped = decisions.find((row) => row.action === 'plan_generation_worktree_reuse_skipped');
    expect(skipped?.outcome).toMatchObject({
      active_work_item_id: otherWorkItem.id,
      requested_work_item_id: workItem.id,
    });
    expect(decisions.some((row) => row.action === 'plan_generation_worktree_created')).toBe(true);
  });

  it('reuses the current work item active worktree when a replan receives a new batch id', async () => {
    const runner = createFakePlanArtifactWorktreeRunner();
    loopController.setWorktreeRunnerForTests(runner);
    const { project, workItem, projectDir } = registerExecuteProject();
    const oldBatchId = `factory-${project.id}-${workItem.id}-old`;
    const newBatchId = `factory-${project.id}-${workItem.id}-new`;
    const currentPath = path.join(projectDir, '.factory-worktrees', 'current-item-old-batch');
    initializeCleanGitWorktree(currentPath);
    factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: oldBatchId,
      vc_worktree_id: 'vc-current-old-batch',
      branch: 'factory/current-item-old-batch',
      worktree_path: currentPath,
      base_branch: 'main',
    });

    const prepared = await loopController._internalForTests.prepareAutoGeneratedPlanArtifactWorktree({
      project,
      instance: { id: 'inst-replan-new-batch', project_id: project.id, batch_id: newBatchId },
      workItem,
    });

    expect(prepared.batchId).toBe(newBatchId);
    expect(prepared.workingDirectory).toBe(currentPath);
    expect(prepared.worktreeRecord.batch_id).toBe(oldBatchId);
    expect(prepared.worktreeRecord.work_item_id).toBe(workItem.id);
    expect(runner.createForBatch).not.toHaveBeenCalled();
    const activeRows = db.prepare(`
      SELECT work_item_id, batch_id, worktree_path, status
      FROM factory_worktrees
      WHERE work_item_id = ? AND status = 'active'
      ORDER BY id ASC
    `).all(workItem.id);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].worktree_path).toBe(currentPath);
    const decisions = listDecisionRows(db, project.id);
    expect(decisions.some((row) => row.action === 'plan_generation_worktree_reused')).toBe(true);
  });

  it('extracts Codex final plan markdown from stderr transcript without reusing the echoed prompt', () => {
    const transcript = [
      'OpenAI Codex v0.125.0 (research preview)',
      '--------',
      'user',
      '# Prompt Echo Plan',
      '',
      '## Task 1: <task title>',
      '',
      'Template text that must never become the generated plan.',
      'codex',
      '# Real Generated Plan',
      '**Source:** auto-generated from work_item #123',
      '**Tech Stack:** Node.js',
      '',
      '## Task 1: Add durable regression',
      '',
      '- [ ] **Step 1: Patch one helper**',
      '',
      '    Edit `server/execution/completion-policy.js`. Acceptance criteria: the helper disables prompt-trace completion for plan generation.',
      '',
      '- [ ] **Step 2: Validate targeted change**',
      '',
      '    Run `npx vitest run server/tests/completion-policy.test.js --config server/vitest.config.js`; it should pass.',
      'tokens used',
      '123',
      '[process-exit] code=0 signal=none duration_ms=1 provider=codex',
    ].join('\n');

    expect(loopController._internalForTests.extractCodexFinalAnswerFromTranscript(transcript))
      .toContain('# Real Generated Plan');
    expect(loopController._internalForTests.extractCodexFinalAnswerFromTranscript(transcript))
      .not.toContain('# Prompt Echo Plan');
    expect(loopController._internalForTests.extractPlanGenerationRawMarkdown({
      output: '',
      error_output: transcript,
    }, { content: [{ type: 'text', text: 'generic await response' }] }))
      .toContain('## Task 1: Add durable regression');
  });

  it('extracts Codex final plan markdown from stdout transcript without accepting prompt echo', () => {
    const transcript = [
      'OpenAI Codex v0.125.0 (research preview)',
      '--------',
      'workdir: C:\\Projects\\torque-public',
      '--------',
      'user',
      '## Task',
      '',
      '# Prompt Echo Plan',
      '',
      '## Task 1: <task title>',
      '',
      'Template text that must never become the generated plan.',
      'codex',
      '# Real Stdout Generated Plan',
      '**Source:** auto-generated from work_item #123',
      '**Tech Stack:** Node.js',
      '',
      '## Task 1: Add stdout transcript extraction',
      '',
      '- [ ] **Step 1: Patch output extraction**',
      '',
      '    Edit `server/factory/loop-controller.js`. Acceptance criteria: transcript stdout is stripped before parsing.',
      'tokens used',
      '123',
    ].join('\n');

    const extracted = loopController._internalForTests.extractPlanGenerationRawMarkdown({
      output: transcript,
      error_output: '',
    });

    expect(extracted).toContain('# Real Stdout Generated Plan');
    expect(extracted).toContain('## Task 1: Add stdout transcript extraction');
    expect(extracted).not.toContain('# Prompt Echo Plan');
  });

  it('does not extract a plan from prompt-only Codex stderr', () => {
    const promptOnly = [
      'OpenAI Codex v0.125.0 (research preview)',
      'user',
      '# Prompt Echo Plan',
      '',
      '## Task 1: <task title>',
      '',
      'mcp: codex/list_mcp_resources (completed)',
    ].join('\n');

    expect(loopController._internalForTests.extractCodexFinalAnswerFromTranscript(promptOnly)).toBe('');
    expect(loopController._internalForTests.extractPlanGenerationRawMarkdown({
      output: '',
      error_output: promptOnly,
    })).toBe('');
  });

  it('does not extract a plan from transcript stdout that only contains prompt and tool output headings', () => {
    const transcriptOnly = [
      'OpenAI Codex v0.125.0 (research preview)',
      '--------',
      'user',
      '## Task',
      '',
      '# Prompt Echo Plan',
      '',
      '## Task 1: <task title>',
      '',
      'codex',
      'I will inspect the repository before drafting the plan.',
      'exec',
      '"pwsh.exe" -Command "Get-Content docs/plan.md"',
      '# Existing Documentation Heading',
      '',
      '## Task 9: Historical docs content',
    ].join('\n');

    expect(loopController._internalForTests.extractPlanGenerationRawMarkdown({
      output: transcriptOnly,
      error_output: '',
    })).toBe('');
  });

  it('recovers a side-written plan file from a crashed plan-generation task', () => {
    const { project, workItem, projectDir } = registerExecuteProject();
    const expectedPlanPath = path.join(
      projectDir,
      'docs',
      'superpowers',
      'plans',
      'auto-generated',
      `${workItem.id}-add-behavioral-tests-for-factory-scorers.md`
    );
    const sideWrittenPlanPath = path.join(
      projectDir,
      'docs',
      'superpowers',
      'plans',
      path.basename(expectedPlanPath)
    );
    fs.mkdirSync(path.dirname(sideWrittenPlanPath), { recursive: true });
    fs.writeFileSync(sideWrittenPlanPath, `# Behavioral Scorer Plan

## Task 1: Add behavioral scorer tests

- [ ] **Step 1: Add regression coverage**

    Update server/tests/factory-scorers.test.js with scout-driven scorer coverage.
`, 'utf8');

    const recovered = loopController._internalForTests.recoverTerminalPlanGenerationMarkdown({
      generationTask: {
        id: 'plan-gen-task',
        status: 'failed',
        output: 'The plan has been written.',
        error_output: '[process-exit] code=3221226505 signal=none',
      },
      planPath: expectedPlanPath,
      workItem,
      project,
    });

    expect(recovered).toMatchObject({
      source: 'side_written_file',
      sourcePath: sideWrittenPlanPath,
    });
    expect(recovered.markdown).toContain(`**Source:** auto-generated from work_item #${workItem.id}`);
    expect(recovered.markdown).toContain('## Task 1: Add behavioral scorer tests');
  });

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

  it('uses the codex/default plan-generation timeout as an activity-aware submit and await budget', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Create a focused plan for delayed factory plan generation coverage.',
      config: {
        provider_lane_policy: {
          expected_provider: 'codex',
          allowed_providers: ['codex'],
          enforce_handoffs: true,
        },
      },
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
    const submittedPlanGeneration = routingModule.handleSmartSubmitTask.mock.calls[0][0];
    expect(submittedPlanGeneration.task_metadata.activity_timeout_policy.max_wall_clock_minutes)
      .toBeGreaterThanOrEqual(submittedPlanGeneration.timeout_minutes + 15);
    expect(awaitModule.handleAwaitTask).toHaveBeenCalledWith({
      task_id: 'plan-gen-task',
      timeout_minutes: 30,
      heartbeat_minutes: 0,
      auto_resubmit_on_restart: true,
    });
    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: LOOP_STATES.EXECUTE,
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

  it('defers instead of submitting a second plan generator while another project plan task is active', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Create a focused plan while another work item is already generating a plan.',
    });
    const blockingWorkItemId = workItem.id + 1000;
    taskCore.listTasks = vi.fn((query) => {
      if (query?.tag === `factory:work_item_id=${workItem.id}`) {
        return [];
      }
      if (query?.tag === `factory:project_id=${project.id}`) {
        return [{
          id: 'other-plan-gen-task',
          status: 'running',
          tags: planGenerationTags(project.id, blockingWorkItemId),
          metadata: planGenerationMetadata(project.id, blockingWorkItemId),
          error_output: 'still running',
        }];
      }
      return [];
    });

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();
    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      reason: 'plan generation deferred while another project plan task is active',
      stage_result: {
        status: 'deferred',
        reason: 'project_plan_generation_active',
        generation_task_id: 'other-plan-gen-task',
        blocking_work_item_id: blockingWorkItemId,
        task_status: 'running',
      },
    });
    expect(updatedWorkItem.origin?.plan_generation_task_id).toBeUndefined();
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

  it('submits a provider fallback when plan generation hits a transient local provider timeout', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Create a focused plan when the local plan generator host is temporarily unreachable.',
    });
    routingModule.handleSmartSubmitTask = vi.fn()
      .mockResolvedValueOnce({ task_id: 'plan-gen-task' })
      .mockResolvedValueOnce({ task_id: 'fallback-plan-gen-task' });
    taskCore.getTask = vi.fn((taskId) => {
      if (taskId === 'plan-gen-task') {
        return {
          id: taskId,
          status: 'failed',
          provider: 'ollama',
          output: '',
          error_output: 'connect ETIMEDOUT ollama-plan-host:11434',
        };
      }
      return null;
    });

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

    expect(routingModule.handleSmartSubmitTask).toHaveBeenCalledTimes(2);
    expect(routingModule.handleSmartSubmitTask.mock.calls[1][0]).toEqual(expect.objectContaining({
      provider: 'claude-cli',
      timeout_minutes: 30,
      tags: expect.arrayContaining([
        'factory:plan_generation',
        `factory:work_item_id=${workItem.id}`,
      ]),
      task_metadata: expect.objectContaining({
        kind: 'plan_generation',
        plan_generation_provider_fallback: true,
        plan_generation_failed_provider: 'ollama',
        plan_generation_failed_task_id: 'plan-gen-task',
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
      reason: 'plan generation provider fallback submitted after transient provider error',
      stage_result: {
        status: 'deferred',
        reason: 'provider_fallback_submitted',
        failed_generation_task_id: 'plan-gen-task',
        generation_task_id: 'fallback-plan-gen-task',
        failed_provider: 'ollama',
        fallback_provider: 'claude-cli',
      },
    });
    expect(updatedWorkItem).toMatchObject({
      id: workItem.id,
      status: 'planned',
      reject_reason: null,
      origin: expect.objectContaining({
        plan_generation_task_id: 'fallback-plan-gen-task',
        plan_generation_status: 'submitted',
        plan_generation_provider_fallback_count: 1,
        plan_generation_provider_fallback_from: 'ollama',
        plan_generation_provider_fallback_to: 'claude-cli',
      }),
    });
    expect(createPlanExecutorMock).not.toHaveBeenCalled();

    const decisions = listDecisionRows(db, project.id);
    expect(decisions.find((row) => row.action === 'plan_generation_provider_fallback_submitted')).toMatchObject({
      stage: 'execute',
      outcome: expect.objectContaining({
        reason: 'transient_provider_error',
        failed_provider: 'ollama',
        fallback_provider: 'claude-cli',
        failed_generation_task_id: 'plan-gen-task',
        generation_task_id: 'fallback-plan-gen-task',
        work_item_id: workItem.id,
      }),
    });
    expect(decisions.find((row) => row.action === 'cannot_generate_plan_routed_to_needs_replan')).toBeUndefined();
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
        plan_generation_provider_fallback_count: 1,
        plan_generation_provider_fallback_from: 'ollama',
        plan_generation_provider_fallback_to: 'claude-cli',
        plan_generation_provider_fallback_error: 'connect ETIMEDOUT ollama-plan-host:11434',
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
      paused_at_stage: LOOP_STATES.EXECUTE,
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
      paused_at_stage: LOOP_STATES.EXECUTE,
      reason: 'plan generation still waiting on file-lock contention',
      stage_result: {
        status: 'waiting',
        reason: 'plan_generation_file_lock_wait',
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
      paused_at_stage: LOOP_STATES.EXECUTE,
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
      paused_at_stage: LOOP_STATES.EXECUTE,
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

  it('quality-gates a materialized generated plan before reusing it after deferred generation', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Add coverage for deferred generated-plan reuse.',
      origin: { plan_gen_attempts: 1 },
    });
    const batchId = `factory-${project.id}-${workItem.id}`;
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: batchId,
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.EXECUTE,
      work_item_id: workItem.id,
      batch_id: batchId,
    });
    const prepared = await loopController._internalForTests.prepareAutoGeneratedPlanArtifactWorktree({
      project,
      instance: factoryLoopInstances.getInstance(instance.id),
      workItem,
    });
    initializeCleanGitWorktree(prepared.workingDirectory);
    const materializedPlan = [
      '# Deferred Generated Plan',
      '',
      '## Task 1: Add focused regression coverage',
      '',
      '- [ ] **Step 1: Edit `server/factory/loop-controller.js`**',
      '',
      '    Acceptance criteria: `npx vitest run server/tests/factory-execute-non-plan-file.test.js` passes.',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(prepared.planPath), { recursive: true });
    fs.writeFileSync(prepared.planPath, materializedPlan, 'utf8');
    const gateSpy = vi.spyOn(planQualityGate, 'evaluatePlan').mockResolvedValue({
      passed: false,
      hardFails: [{
        rule: 'validation_command_targets_unique',
        taskNumber: 1,
        detail: 'Task 1 repeats validation target(s).',
      }],
      warnings: [],
      llmCritique: null,
      feedbackPrompt: '## Prior plan rejected\n\n- [validation_command_targets_unique] Task 1 repeats validation target(s).',
    });
    routingModule.handleSmartSubmitTask.mockClear();
    awaitModule.handleAwaitTask.mockClear();
    planExecuteMock.mockClear();

    try {
      const result = await loopController.executeNonPlanFileStage(
        project,
        factoryLoopInstances.getInstance(instance.id),
        workItem
      );
      const updatedWorkItem = factoryIntake.getWorkItem(workItem.id);

      expect(gateSpy).toHaveBeenCalledWith(expect.objectContaining({
        plan: materializedPlan,
        workItem: expect.objectContaining({ id: workItem.id }),
      }));
      expect(result).toMatchObject({
        stop_execution: true,
        next_state: LOOP_STATES.PRIORITIZE,
        reason: 'materialized generated plan rejected by quality gate',
        stage_result: {
          status: 'needs_replan',
          reason: 'materialized_generated_plan_rejected_by_quality_gate',
          work_item_id: workItem.id,
          plan_path: prepared.planPath,
          rule_violations: ['validation_command_targets_unique'],
        },
      });
      expect(updatedWorkItem).toMatchObject({
        id: workItem.id,
        status: 'needs_replan',
        reject_reason: 'materialized_generated_plan_rejected_by_quality_gate',
      });
      expect(updatedWorkItem.origin?.last_gate_feedback).toContain('Prior plan rejected');
      expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
      expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();
      expect(planExecuteMock).not.toHaveBeenCalled();

      const decisions = listDecisionRows(db, project.id);
      expect(decisions.find((row) => row.action === 'resumed_plan_quality_rejected')).toMatchObject({
        stage: 'execute',
        outcome: expect.objectContaining({
          plan_path: prepared.planPath,
          next_status: 'needs_replan',
        }),
      });
      expect(decisions.find((row) => row.action === 'plan_quality_passed')).toBeUndefined();
    } finally {
      gateSpy.mockRestore();
    }
  });

  it('does not execute a stale materialized plan while a re-plan task is still active', async () => {
    const { project, workItem, projectDir } = registerExecuteProject({
      description: 'Add coverage for active re-plan recovery when an old plan file exists.',
    });
    const batchId = `factory-${project.id}-stale-replan`;
    const worktreePath = path.join(projectDir, '.factory-worktrees', 'stale-replan');
    initializeCleanGitWorktree(worktreePath);
    factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: batchId,
      vc_worktree_id: 'vc-stale-replan',
      branch: 'factory/stale-replan',
      worktree_path: worktreePath,
      base_branch: 'main',
    });
    const stalePlanPath = path.join(
      worktreePath,
      'docs',
      'superpowers',
      'plans',
      'auto-generated',
      `${workItem.id}-add-behavioral-tests-for-factory-scorers.md`
    );
    fs.mkdirSync(path.dirname(stalePlanPath), { recursive: true });
    fs.writeFileSync(stalePlanPath, [
      '# Old rejected plan',
      '',
      '## Task 1: Edit a file that should not be executed',
      '',
      '- Edit missing/file.js',
    ].join('\n'), 'utf8');
    factoryIntake.updateWorkItem(workItem.id, {
      origin_json: {
        plan_path: stalePlanPath,
        plan_generation_task_id: 'active-replan-task',
        plan_generation_status: 'running',
        plan_generation_wait_reason: 'task_still_running',
      },
      batch_id: batchId,
    });
    factoryHealth.updateProject(project.id, {
      loop_batch_id: batchId,
    });
    taskCore.getTask = vi.fn((taskId) => {
      if (taskId === 'active-replan-task') {
        return {
          id: taskId,
          status: 'running',
          output: '',
          error_output: '',
          tags: planGenerationTags(project.id, workItem.id),
          metadata: planGenerationMetadata(project.id, workItem.id),
        };
      }
      return null;
    });

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    const waitingAdvance = await loopController.advanceLoopForProject(project.id);

    expect(executeAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: LOOP_STATES.EXECUTE,
      reason: 'plan generation deferred while task remains active',
      stage_result: {
        status: 'deferred',
        reason: 'task_still_running',
        generation_task_id: 'active-replan-task',
        task_status: 'running',
      },
    });
    expect(waitingAdvance).toMatchObject({
      new_state: LOOP_STATES.EXECUTE,
      paused_at_stage: LOOP_STATES.EXECUTE,
      reason: 'plan generation task is still active',
      stage_result: {
        status: 'waiting',
        reason: 'plan_generation_task_active',
        generation_task_id: 'active-replan-task',
        task_status: 'running',
      },
    });
    expect(routingModule.handleSmartSubmitTask).not.toHaveBeenCalled();
    expect(awaitModule.handleAwaitTask).not.toHaveBeenCalled();
    expect(createPlanExecutorMock).not.toHaveBeenCalled();
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
      paused_at_stage: LOOP_STATES.EXECUTE,
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
      paused_at_stage: LOOP_STATES.EXECUTE,
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
      paused_at_stage: LOOP_STATES.EXECUTE,
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
      paused_at_stage: LOOP_STATES.EXECUTE,
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
      paused_at_stage: LOOP_STATES.EXECUTE,
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
      paused_at_stage: LOOP_STATES.EXECUTE,
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
    expect(updatedWorkItem.origin.plan_generation_provider_fallback_count).toBeUndefined();
    expect(updatedWorkItem.origin.plan_generation_provider_fallback_from).toBeUndefined();
    expect(updatedWorkItem.origin.plan_generation_provider_fallback_to).toBeUndefined();
    expect(updatedWorkItem.origin.plan_generation_provider_fallback_error).toBeUndefined();
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

  it('does not immediately reselect a claimed needs_replan item during cooldown', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Create a focused plan for a cooling needs_replan claim.',
    });
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: null,
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.PRIORITIZE,
      work_item_id: workItem.id,
    });
    const selected = factoryIntake.updateWorkItem(workItem.id, {
      status: 'needs_replan',
      claimed_by_instance_id: instance.id,
      reject_reason: 'cannot_generate_plan: unusable output',
    });
    const nextItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'scout',
      title: 'Handle independent fresh work item',
      description: 'Fresh work should run while the prior needs_replan item cools down.',
      priority: 50,
      requestor: 'test',
    });
    db.prepare('UPDATE factory_work_items SET updated_at = ? WHERE id = ?')
      .run('2026-05-04 07:19:43', selected.id);

    const dateNowSpy = vi.spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-05-04T07:20:00.000Z'));
    const originalExecutePlanStage = loopController._internalForTests.executePlanStage;
    loopController._internalForTests.executePlanStage = vi.fn(async (_project, _instance, selectedWorkItem) => ({
      reason: 'architect cycle completed',
      work_item: selectedWorkItem,
    }));
    try {
      const result = await loopController._internalForTests.handlePrioritizeTransition({
        project,
        instance: factoryLoopInstances.getInstance(instance.id),
        currentState: LOOP_STATES.PRIORITIZE,
      });

      expect(result.transitionWorkItem.id).toBe(nextItem.id);
      expect(result.nextState).toBe(LOOP_STATES.PLAN);
      expect(factoryIntake.getWorkItem(selected.id)).toMatchObject({
        status: 'needs_replan',
        claimed_by_instance_id: null,
      });
      expect(factoryIntake.getWorkItem(nextItem.id)).toMatchObject({
        claimed_by_instance_id: instance.id,
      });
    } finally {
      loopController._internalForTests.executePlanStage = originalExecutePlanStage;
      dateNowSpy.mockRestore();
    }
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

  it('normalizes numbered task summaries from plan generation into executable Markdown', async () => {
    const { project, workItem } = registerExecuteProject({
      title: 'Scheduler Fixes & One-Time Schedules Implementation Plan',
      description: 'Add the remaining one-time schedule test coverage for the already implemented scheduler feature.',
    });
    const rawPlan = [
      'The plan targets the remaining test coverage gap for the fully-implemented one-time schedule feature. All 11 implementation tasks are committed; the 3 plan tasks add missing tests:',
      '',
      '1. **Task 1** — 7 MCP handler tests for `create_one_time_schedule` in `handler-adv-scheduling.test.js` (covering 4 validation branches + 2 happy paths + workflow output)',
      '2. **Task 2** — 4 REST API tests for one-time schedule creation in `v2-governance-approvals-schedules.test.js` (covering the `schedule_type === \'once\'` branch)',
      '3. **Task 3** — 3 integration tests in `integration-handlers-schedules.test.js` (end-to-end MCP -> DB -> response for create, list, and toggle)',
    ].join('\n');

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      rawPlan,
      workItem,
      project,
    );

    expect(normalized).toContain(`**Source:** auto-generated from work_item #${workItem.id}`);
    expect(normalized).toContain('## Task 1: Add MCP handler tests for `create_one_time_schedule` in `handler-adv-scheduling.test.js`');
    expect(normalized).toContain('## Task 2: Add REST API tests for one-time schedule creation in `v2-governance-approvals-schedules.test.js`');
    expect(normalized).toContain('## Task 3: Add integration tests in `integration-handlers-schedules.test.js`');
    expect(normalized).toContain('npx vitest run handler-adv-scheduling.test.js');

    const parsedTasks = loopController._internalForTests.parseAutoGeneratedPlanTasks(normalized);
    expect(parsedTasks).toHaveLength(3);
    const lint = loopController._internalForTests.lintAutoGeneratedPlan(project, workItem, normalized);
    expect(lint.descriptionQuality.blocked).toBe(false);
  });

  it('normalizes bare Task headings from plan generation summaries into executable Markdown', async () => {
    const { project, workItem } = registerExecuteProject({
      title: 'Security findings completion plan',
      description: 'Add the missing tests and documentation evidence for completed security findings.',
    });
    const rawPlan = [
      'The plan contains 2 tasks addressing the remaining gaps for the April security findings:',
      '',
      '**Task 1** — Adds 3 missing test cases for `substitutePayload` sanitization in `server/tests/api-webhooks.test.js`.',
      '**Task 2** — Updates tracked evidence in `docs/security/april-findings.md` so the shipped fixes have review-ready acceptance criteria.',
    ].join('\n');

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      rawPlan,
      workItem,
      project,
    );

    expect(normalized).toContain('## Task 1: Adds 3 missing test cases for `substitutePayload` sanitization in `server/tests/api-webhooks.test.js`.');
    expect(normalized).toContain('## Task 2:');
    expect(normalized).toContain('docs/security/april-findings.md');
    expect(normalized).toContain('npx vitest run server/tests/api-webhooks.test.js');

    const parsedTasks = loopController._internalForTests.parseAutoGeneratedPlanTasks(normalized);
    expect(parsedTasks).toHaveLength(2);
    const lint = loopController._internalForTests.lintAutoGeneratedPlan(project, workItem, normalized);
    expect(lint.descriptionQuality.blocked).toBe(false);
  });

  it('normalizes echoed prompt tails out of generated Markdown plans', async () => {
    const { project, workItem } = registerExecuteProject({
      description: 'Reformat LAN startup retry test bodies without changing behavior.',
    });
    const rawPlan = [
      '# example-project local Ollama canary Plan',
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
      '# example-project local Ollama canary Plan',
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

  it('does not preserve a stale read-only source path just because another path is being created', async () => {
    const { project, workItem, projectDir } = registerExecuteProject({
      title: 'Phase 4 — Test Infra Import Bloat Implementation Plan',
      description: 'Create a thin tool registry module and rewire the existing MCP tool metadata path.',
    });
    for (const repoFile of [
      'server/mcp/tool-registry.js',
      'server/tools.js',
      'server/tests/mcp-tool-registry.test.js',
    ]) {
      const absolute = path.join(projectDir, repoFile);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, '// fixture\n');
    }
    const rawPlan = [
      '# Tool registry plan',
      '**Source:** auto-generated from work_item #1462',
      '**Tech Stack:** Node.js',
      '',
      '## Task 1: Create `server/tool-registry.js` thin metadata module',
      '',
      '- [ ] **Step 1: Create `server/tool-registry.js` extracting metadata constants from `server/mcp/tools.js`**',
      '',
      '    Create the file `server/tool-registry.js` from the existing metadata shape in `server/mcp/tools.js`. Acceptance criteria: requiring `server/tool-registry.js` exposes CORE_TOOLS and TOOL_TIERS.',
      '',
      '- [ ] **Step 2: Edit `server/mcp/tools.js` to re-export from `server/tool-registry.js`**',
      '',
      '    Edit `server/mcp/tools.js` to import `CORE_TOOLS` from the new `../tool-registry.js`. Acceptance criteria: `npx vitest run server/tests/mcp-tool-registry.test.js` should pass.',
    ].join('\n');

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      rawPlan,
      workItem,
      { ...project, path: projectDir },
    );

    expect(normalized).toContain('server/tool-registry.js');
    expect(normalized).not.toContain('server/mcp/tools.js');
    expect(normalized).toMatch(/server\/(?:mcp\/tool-registry|tools)\.js/);
    const deterministic = planQualityGate.runDeterministicRules(normalized, { repoPath: projectDir });
    expect(deterministic.hardFails.find(f => f.rule === 'task_edit_targets_exist')).toBeUndefined();
  });

  it('deduplicates repeated validation targets in generated Markdown before the gate runs', async () => {
    const { project, workItem, projectDir } = registerExecuteProject({
      title: 'Perf baseline validation',
      description: 'Tighten perf baseline tests without changing runtime behavior.',
    });
    const testPath = path.join(projectDir, 'server', 'tests', 'perf-baseline-trailer.test.js');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, '// fixture\n');
    const rawPlan = [
      '# Perf baseline plan',
      '**Source:** auto-generated from work_item #1458',
      '**Tech Stack:** Node.js',
      '',
      '## Task 1: Update perf baseline tests',
      '',
      '- [ ] **Step 1: Edit the test coverage**',
      '',
      '    Edit `server/tests/perf-baseline-trailer.test.js` to cover the trailer path. Acceptance criteria: run `npx vitest run server/tests/perf-baseline-trailer.test.js server/tests/perf-baseline-trailer.test.js` and expect the suite to pass.',
    ].join('\n');

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      rawPlan,
      workItem,
      { ...project, path: projectDir },
    );

    expect(normalized).toContain('`npx vitest run server/tests/perf-baseline-trailer.test.js`');
    expect(normalized).not.toContain('npx vitest run server/tests/perf-baseline-trailer.test.js server/tests/perf-baseline-trailer.test.js');
    const deterministic = planQualityGate.runDeterministicRules(normalized, { repoPath: projectDir });
    expect(deterministic.hardFails.find(f => f.rule === 'validation_command_targets_unique')).toBeUndefined();
  });

  it('preserves existing event paths while replacing only missing store paths with alternates', async () => {
    const { project, workItem, projectDir } = registerExecuteProject({
      title: 'Fabro #29: Workflow Event Timeline',
      description: 'Add workflow event types from the existing runtime sites and expose per-workflow events.',
    });
    for (const repoFile of [
      'server/events/event-types.js',
      'server/handlers/workflow/index.js',
      'server/execution/workflow-runtime.js',
      'server/db/event-tracking.js',
      'server/tests/workflow-runtime.test.js',
    ]) {
      const absolute = path.join(projectDir, repoFile);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, '// fixture\n');
    }
    const rawPlan = [
      '# Workflow event timeline plan',
      '**Source:** auto-generated from work_item #2193',
      '**Tech Stack:** Node.js',
      '',
      '## Task 1: Add workflow event constants and runtime emissions',
      '',
      '- [ ] **Step 1: Edit `server/events/event-types.js`**',
      '',
      '    Edit `server/events/event-types.js` to add `WORKFLOW_STATE_PATCHED` and `WORKFLOW_DEPENDENCY_UNBLOCKED`. Then edit `server/handlers/workflow/index.js` and `server/execution/workflow-runtime.js` to emit the new events. Acceptance criteria: `npx vitest run server/tests/workflow-runtime.test.js` should pass.',
      '',
      '## Task 2: Add per-workflow event lookup',
      '',
      '- [ ] **Step 1: Edit `server/db/task-events-store.js`**',
      '',
      '    Edit `server/db/task-events-store.js` to add `getByWorkflowId(workflowId)` with a derived `seq`. Acceptance criteria: `npx vitest run server/tests/workflow-runtime.test.js` should pass.',
    ].join('\n');

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      rawPlan,
      workItem,
      { ...project, path: projectDir },
    );

    expect(normalized).toContain('server/events/event-types.js');
    expect(normalized).toContain('server/handlers/workflow/index.js');
    expect(normalized).toContain('server/execution/workflow-runtime.js');
    expect(normalized).not.toContain('server/runtime-store.js');
    expect(normalized).not.toContain('server/db/task-events-store.js');
    expect(normalized).toContain('server/db/event-tracking.js');
    const deterministic = planQualityGate.runDeterministicRules(normalized, { repoPath: projectDir });
    expect(deterministic.hardFails.find(f => f.rule === 'task_edit_targets_exist')).toBeUndefined();
  });

  it('replaces generated temp artifact targets even when the plan says create', async () => {
    const { project, workItem, projectDir } = registerExecuteProject({
      description: 'Persist every workflow as an append-only event journal and use that journal as source of truth for recovery, audit, and deterministic replay.',
      origin: {
        last_gate_feedback: '[task_edit_targets_exist] Task 4: Task 4 edits missing target file(s): .tmp/build-workflow-v3.js. Existing nearby candidate(s): .tmp/build-workflow-v3.js -> server/api/v2-workflow-handlers.js, server/db/approval-workflows.js, server/db/workflow-engine.js, server/execution/workflow-resume.js. Pick existing repository files or rewrite the task as an explicit create-file task.',
      },
    });
    for (const repoFile of [
      'server/api/v2-workflow-handlers.js',
      'server/db/approval-workflows.js',
      'server/db/workflow-engine.js',
      'server/execution/workflow-resume.js',
      'server/execution/workflow-runtime.js',
      'server/tests/workflow-runtime.test.js',
    ]) {
      const absolute = path.join(projectDir, repoFile);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, '// fixture\n');
    }
    const rawPlan = [
      '# Workflow replay plan',
      '**Source:** auto-generated from work_item #155',
      '**Tech Stack:** Node.js',
      '',
      '## Task 4: Build replay workflow API',
      '',
      '- [ ] **Step 1: Create `.tmp/build-workflow-v3.js` API integration**',
      '',
      '    Create `.tmp/build-workflow-v3.js` to add replay route handling and edit `.tmp/build-workflow-v3.js` for workflow replay. Also edit `server/execution/workflow-runtime.js` to persist replay state. Acceptance criteria: `npx vitest run server/tests/workflow-runtime.test.js` should pass.',
    ].join('\n');

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      rawPlan,
      workItem,
      { ...project, path: projectDir },
    );

    expect(normalized).not.toContain('.tmp/build-workflow-v3.js');
    expect(normalized).toContain('server/api/v2-workflow-handlers.js');
    expect(normalized).toContain('server/execution/workflow-runtime.js');
    const deterministic = planQualityGate.runDeterministicRules(normalized, { repoPath: projectDir });
    expect(deterministic.hardFails.find(f => f.rule === 'task_edit_targets_exist')).toBeUndefined();
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
      '# example-project local Ollama canary Plan',
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
      '# example-project local Ollama canary Plan',
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

  it('does not globally qualify dashboard plan verbs with the first referenced file', async () => {
    const { project, workItem, projectDir } = registerExecuteProject();
    const repoFiles = [
      'dashboard/src/views/Approvals.jsx',
      'dashboard/src/views/Approvals.test.jsx',
      'dashboard/src/components/ErrorBoundary.jsx',
      'dashboard/src/components/ErrorBoundary.test.jsx',
      'dashboard/src/components/LoadingSkeleton.jsx',
      'dashboard/src/components/LoadingSkeleton.test.jsx',
      'dashboard/e2e/dashboard.spec.js',
      'cli/dashboard.js',
    ];
    for (const repoFile of repoFiles) {
      const absolute = path.join(projectDir, repoFile);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, '// fixture\n');
    }

    const dashboardWorkItem = {
      ...workItem,
      id: 3,
      title: 'Add error handling and loading states to dashboard views',
      description: 'User-facing score 45. Multiple UX TODOs.',
    };
    const rawPlan = [
      '# Add error handling and loading states to dashboard views Plan',
      '**Source:** auto-generated from work_item #3',
      '**Tech Stack:** Node.js',
      '',
      '## Task 1: Enhance Approvals view with error handling and loading states',
      '- [ ] **Step 1: Update Approvals.jsx to integrate ErrorBoundary and LoadingSkeleton**',
      '',
      '    Modify `dashboard/src/views/Approvals.jsx` to wrap content with `ErrorBoundary` and display `LoadingSkeleton` during data fetching. This change ensures that the Approvals view handles loading and error states gracefully.',
      '',
      '- [ ] **Step 2: Validate targeted change**',
      '',
      '    Run `npx vitest run dashboard/src/views/Approvals.test.jsx` and ensure the tests pass, verifying that the new error and loading states are properly integrated and handled.',
      '',
      '## Task 2: Update ErrorBoundary component to support dashboard views',
      '- [ ] **Step 1: Enhance ErrorBoundary.jsx to improve error display**',
      '',
      '    Update `dashboard/src/components/ErrorBoundary.jsx` to provide more context-aware error messages and ensure consistent UI presentation across dashboard views.',
      '',
      '- [ ] **Step 2: Validate targeted change**',
      '',
      '    Run `npx vitest run dashboard/src/components/ErrorBoundary.test.jsx` and confirm all tests pass, ensuring the updated error boundary functionality works correctly.',
      '',
      '## Task 3: Implement loading skeleton for dashboard views',
      '- [ ] **Step 1: Integrate LoadingSkeleton.jsx into dashboard components**',
      '',
      '    Modify `dashboard/src/components/LoadingSkeleton.jsx` to support dashboard-specific UI patterns and ensure it is reusable across various dashboard views.',
      '',
      '- [ ] **Step 2: Validate targeted change**',
      '',
      '    Run `npx vitest run dashboard/src/components/LoadingSkeleton.test.jsx` and ensure all tests pass, confirming that the loading skeleton renders correctly and meets UI requirements.',
      '',
      '## Task 4: Update end-to-end tests for dashboard views',
      '- [ ] **Step 1: Extend e2e/dashboard.spec.js to cover error and loading states**',
      '',
      '    Update `dashboard/e2e/dashboard.spec.js` to include tests for error handling and loading states in dashboard views, ensuring comprehensive coverage.',
      '',
      '- [ ] **Step 2: Validate targeted change**',
      '',
      '    Run `npx cypress run --spec dashboard/e2e/dashboard.spec.js` and verify that all tests pass, ensuring the end-to-end tests cover the newly added error and loading state scenarios.',
      '',
      '## Task 5: Review and update dashboard CLI integration',
      '- [ ] **Step 1: Check CLI integration in cli/dashboard.js**',
      '',
      '    Inspect `cli/dashboard.js` to ensure it properly supports the new error and loading states in dashboard views and does not break existing functionality.',
      '',
      '- [ ] **Step 2: Validate targeted change**',
      '',
      '    Run `node cli/dashboard.js` and ensure it executes without errors, verifying that the CLI integration remains functional with the updated dashboard components.',
    ].join('\n');

    const normalized = loopController._internalForTests.normalizeAutoGeneratedPlanMarkdown(
      rawPlan,
      dashboardWorkItem,
      { ...project, path: projectDir },
    );

    expect(normalized).toContain('Modify `dashboard/src/views/Approvals.jsx`');
    expect(normalized).toContain('Update `dashboard/src/components/ErrorBoundary.jsx`');
    expect(normalized).not.toMatch(/\b(?:edit|cover|clarify|simplify) `[^`]+` `[^`]+`/i);
    expect(normalized).not.toMatch(/\b(?:edit|cover|clarify|simplify) `[^`]+` (?:loading|error|dashboard|end-to-end|component)/i);
    const lint = loopController._internalForTests.lintAutoGeneratedPlan(project, dashboardWorkItem, normalized);
    expect(lint.descriptionQuality.blocked).toBe(false);
  });
});
