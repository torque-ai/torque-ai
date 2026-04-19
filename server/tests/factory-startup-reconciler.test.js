import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../database');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const factoryWorktrees = require('../db/factory-worktrees');
const taskCore = require('../db/task-core');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');
const worktreeReconcile = require('../factory/worktree-reconcile');

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

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function flushImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadFreshReconciler() {
  const modulePath = require.resolve('../factory/startup-reconciler');
  delete require.cache[modulePath];
  return require('../factory/startup-reconciler');
}

describe('factory startup reconciler', () => {
  let db;
  let tempDir;
  let originalGetDbInstance;
  let calls;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-startup-reconciler-'));
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;

    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryLoopInstances.setDb(db);
    factoryWorktrees.setDb(db);
    taskCore.setDb(db);

    calls = [];
    vi.spyOn(loopController, 'startLoopAutoAdvance').mockImplementation((projectId) => {
      calls.push({ type: 'start', projectId });
    });
    vi.spyOn(loopController, 'advanceLoopAsync').mockImplementation((instanceId, options) => {
      calls.push({ type: 'advance', instanceId, options });
    });
    vi.spyOn(worktreeReconcile, 'reconcileProject').mockImplementation((args) => {
      calls.push({ type: 'reconcile', projectId: args.project_id });
      return { root: args.project_path, scanned: 0, cleaned: [], skipped: [], failed: [] };
    });
  });

  afterEach(() => {
    database.getDbInstance = originalGetDbInstance;
    factoryHealth.setDb(null);
    factoryIntake.setDb(null);
    factoryLoopInstances.setDb(null);
    factoryWorktrees.setDb(null);
    taskCore.setDb(null);
    delete require.cache[require.resolve('../factory/startup-reconciler')];
    vi.restoreAllMocks();

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    db.close();
    db = null;
    tempDir = null;
    calls = null;
  });

  function registerRunningProject({ config, loopState = LOOP_STATES.IDLE, batchId = null, pausedAtStage = null } = {}) {
    const projectDir = path.join(tempDir, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(projectDir, { recursive: true });
    const project = factoryHealth.registerProject({
      name: 'Startup Reconciler Project',
      path: projectDir,
      trust_level: 'supervised',
      config,
    });
    return factoryHealth.updateProject(project.id, {
      status: 'running',
      loop_state: loopState,
      loop_batch_id: batchId,
      loop_paused_at_stage: pausedAtStage,
    });
  }

  function createInstance(project, { state = LOOP_STATES.SENSE, pausedAtStage = null, batchId = null } = {}) {
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      batch_id: batchId,
    });
    return factoryLoopInstances.updateInstance(instance.id, {
      loop_state: state,
      paused_at_stage: pausedAtStage,
      batch_id: batchId,
    });
  }

  function insertBatchTask({ taskId, batchId, status }) {
    db.prepare(`
      INSERT INTO tasks (id, status, tags)
      VALUES (?, ?, ?)
    `).run(taskId, status, JSON.stringify([`factory:batch_id=${batchId}`]));
  }

  it('advances a coherent running project once without starting a new loop', async () => {
    const project = registerRunningProject();
    const instance = createInstance(project, { state: LOOP_STATES.SENSE });
    const { reconcileFactoryProjectsOnStartup } = loadFreshReconciler();

    const result = reconcileFactoryProjectsOnStartup();
    await flushImmediate();

    expect(result).toMatchObject({
      reconciled: true,
      actions: { projects_scanned: 1, advanced: 1, restarted: 0 },
    });
    expect(calls.filter((call) => call.type === 'advance')).toEqual([
      { type: 'advance', instanceId: instance.id, options: { autoAdvance: true } },
    ]);
    expect(calls.some((call) => call.type === 'start')).toBe(false);
  });

  it('syncs stranded auto_advance projects to IDLE and starts a fresh loop', async () => {
    const project = registerRunningProject({
      config: { loop: { auto_advance: true } },
      loopState: LOOP_STATES.EXECUTE,
      batchId: 'factory-batch-1',
    });
    const { reconcileFactoryProjectsOnStartup } = loadFreshReconciler();

    const result = reconcileFactoryProjectsOnStartup();
    await flushImmediate();

    expect(result.actions).toMatchObject({ restarted: 1, skipped: 0 });
    expect(factoryHealth.getProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.IDLE,
      loop_batch_id: null,
      loop_paused_at_stage: null,
    });
    expect(calls.filter((call) => call.type === 'start')).toEqual([
      { type: 'start', projectId: project.id },
    ]);
    expect(calls.some((call) => call.type === 'advance')).toBe(false);
  });

  it('syncs stranded operator-managed projects to IDLE without starting', async () => {
    const project = registerRunningProject({ loopState: LOOP_STATES.IDLE });
    const { reconcileFactoryProjectsOnStartup } = loadFreshReconciler();

    const result = reconcileFactoryProjectsOnStartup();
    await flushImmediate();

    expect(result.actions).toMatchObject({ restarted: 0, skipped: 1 });
    expect(factoryHealth.getProject(project.id)).toMatchObject({
      loop_state: LOOP_STATES.IDLE,
      loop_batch_id: null,
      loop_paused_at_stage: null,
    });
    expect(calls.some((call) => call.type === 'start')).toBe(false);
    expect(calls.some((call) => call.type === 'advance')).toBe(false);
  });

  it('terminates paused-at-EXECUTE instances with empty batches and starts fresh', async () => {
    const project = registerRunningProject();
    const instance = createInstance(project, {
      state: LOOP_STATES.EXECUTE,
      pausedAtStage: LOOP_STATES.EXECUTE,
      batchId: 'factory-empty-batch',
    });
    const terminateSpy = vi.spyOn(loopController, 'terminateInstanceAndSync');
    const { reconcileFactoryProjectsOnStartup } = loadFreshReconciler();

    const result = reconcileFactoryProjectsOnStartup();
    await flushImmediate();

    expect(result.actions).toMatchObject({ restarted: 1, advanced: 0 });
    expect(terminateSpy).toHaveBeenCalledWith(instance.id, { abandonWorktree: true });
    expect(factoryLoopInstances.getInstance(instance.id).terminated_at).toBeTruthy();
    expect(calls.filter((call) => call.type === 'start')).toEqual([
      { type: 'start', projectId: project.id },
    ]);
  });

  it('leaves paused-at-EXECUTE instances alone when their batch still has live tasks', async () => {
    const batchId = 'factory-live-batch';
    const project = registerRunningProject();
    const instance = createInstance(project, {
      state: LOOP_STATES.EXECUTE,
      pausedAtStage: LOOP_STATES.EXECUTE,
      batchId,
    });
    insertBatchTask({ taskId: 'live-task', batchId, status: 'queued' });
    const { reconcileFactoryProjectsOnStartup } = loadFreshReconciler();

    const result = reconcileFactoryProjectsOnStartup();
    await flushImmediate();

    expect(result.actions).toMatchObject({ restarted: 0, skipped: 1, advanced: 0 });
    expect(factoryLoopInstances.getInstance(instance.id).terminated_at).toBeNull();
    expect(calls.some((call) => call.type === 'start')).toBe(false);
    expect(calls.some((call) => call.type === 'advance')).toBe(false);
  });

  it('defers VERIFY-state instances without advancing them', async () => {
    const project = registerRunningProject();
    createInstance(project, { state: LOOP_STATES.VERIFY });
    const { reconcileFactoryProjectsOnStartup } = loadFreshReconciler();

    const result = reconcileFactoryProjectsOnStartup();
    await flushImmediate();

    expect(result.actions).toMatchObject({ deferred_verify: 1, advanced: 0, restarted: 0 });
    expect(calls.some((call) => call.type === 'advance')).toBe(false);
    expect(calls.some((call) => call.type === 'start')).toBe(false);
  });

  it('skips ready-for-gate paused instances', async () => {
    const project = registerRunningProject();
    createInstance(project, {
      state: LOOP_STATES.PLAN,
      pausedAtStage: 'READY_FOR_PLAN',
    });
    const { reconcileFactoryProjectsOnStartup } = loadFreshReconciler();

    const result = reconcileFactoryProjectsOnStartup();
    await flushImmediate();

    expect(result.actions).toMatchObject({ skipped: 1, advanced: 0, restarted: 0 });
    expect(calls.some((call) => call.type === 'advance')).toBe(false);
    expect(calls.some((call) => call.type === 'start')).toBe(false);
  });

  it('reconciles factory worktrees before advancing an active instance', async () => {
    const project = registerRunningProject();
    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'plan_file',
      title: 'Reconcile orphan worktree',
    });
    factoryWorktrees.recordWorktree({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: 'factory-orphan-batch',
      vc_worktree_id: 'vc-orphan',
      branch: 'feat/factory-orphan',
      worktree_path: path.join(project.path, '.worktrees', 'feat-factory-orphan'),
    });
    const instance = createInstance(project, { state: LOOP_STATES.SENSE });
    const { reconcileFactoryProjectsOnStartup } = loadFreshReconciler();

    const result = reconcileFactoryProjectsOnStartup();
    await flushImmediate();

    expect(result.actions).toMatchObject({ advanced: 1 });
    expect(worktreeReconcile.reconcileProject).toHaveBeenCalledWith({
      db,
      project_id: project.id,
      project_path: project.path,
    });
    const projectCalls = calls.filter((call) => call.projectId === project.id || call.instanceId === instance.id);
    expect(projectCalls.map((call) => call.type)).toEqual(['reconcile', 'advance']);
  });

  it('is idempotent after the first startup reconciliation', async () => {
    const project = registerRunningProject();
    createInstance(project, { state: LOOP_STATES.SENSE });
    const { reconcileFactoryProjectsOnStartup } = loadFreshReconciler();

    const first = reconcileFactoryProjectsOnStartup();
    await flushImmediate();
    const second = reconcileFactoryProjectsOnStartup();
    await flushImmediate();

    expect(first.actions).toMatchObject({ advanced: 1 });
    expect(second).toMatchObject({
      reconciled: false,
      reason: 'already_reconciled',
    });
    expect(calls.filter((call) => call.type === 'advance')).toHaveLength(1);
    expect(calls.filter((call) => call.type === 'start')).toHaveLength(0);
    expect(worktreeReconcile.reconcileProject).toHaveBeenCalledTimes(1);
  });
});
