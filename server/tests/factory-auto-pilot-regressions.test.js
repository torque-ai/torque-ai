'use strict';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('fs');
const path = require('path');

const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const autoVerifyRetry = require('../validation/auto-verify-retry');
const architectRunner = require('../factory/architect-runner');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');
const factoryArchitect = require('../db/factory-architect');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');
const factoryWorktrees = require('../db/factory-worktrees');
const routingModule = require('../handlers/integration/routing');
const taskCore = require('../db/task-core');

const TASK_MANAGER_RESOLVED = require.resolve('../task-manager');

let dbModule;
let dbHandle;
let testDir;
let originalTaskManagerCache = null;

function ensureFactoryTables(db) {
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

    CREATE TABLE IF NOT EXISTS factory_architect_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      input_snapshot_json TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      backlog_json TEXT NOT NULL,
      flags_json TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      trigger TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
  `);
}

function resetFactoryTables(db) {
  for (const table of [
    'factory_worktrees',
    'factory_architect_cycles',
    'factory_decisions',
    'factory_loop_instances',
    'factory_work_items',
    'factory_health_snapshots',
    'factory_projects',
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
}

function wireFactoryDbModules(db) {
  factoryArchitect.setDb(db);
  factoryDecisions.setDb(db);
  factoryHealth.setDb(db);
  factoryIntake.setDb(db);
  factoryLoopInstances.setDb(db);
  factoryWorktrees.setDb(db);
}

function restoreTaskManagerCache() {
  if (originalTaskManagerCache) {
    require.cache[TASK_MANAGER_RESOLVED] = originalTaskManagerCache;
  } else {
    delete require.cache[TASK_MANAGER_RESOLVED];
  }
  originalTaskManagerCache = null;
}

function installTaskManagerCache(exports) {
  originalTaskManagerCache = require.cache[TASK_MANAGER_RESOLVED] || null;
  require.cache[TASK_MANAGER_RESOLVED] = {
    id: TASK_MANAGER_RESOLVED,
    filename: TASK_MANAGER_RESOLVED,
    loaded: true,
    exports,
  };
}

function createProject(name) {
  const projectPath = path.join(testDir, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(projectPath, { recursive: true });
  return factoryHealth.registerProject({
    name,
    path: projectPath,
    trust_level: 'supervised',
  });
}

beforeAll(() => {
  ({ db: dbModule, testDir } = setupTestDb('factory-auto-pilot-regressions'));
  dbHandle = dbModule.getDbInstance();
  ensureFactoryTables(dbHandle);
  wireFactoryDbModules(dbHandle);
});

beforeEach(() => {
  dbHandle = dbModule.getDbInstance();
  ensureFactoryTables(dbHandle);
  resetFactoryTables(dbHandle);
  wireFactoryDbModules(dbHandle);
  loopController.setWorktreeRunnerForTests(null);
});

afterEach(() => {
  restoreTaskManagerCache();
  vi.restoreAllMocks();
});

afterAll(() => {
  restoreTaskManagerCache();
  factoryArchitect.setDb(null);
  factoryDecisions.setDb(null);
  factoryHealth.setDb(null);
  factoryIntake.setDb(null);
  factoryLoopInstances.setDb(null);
  factoryWorktrees.setDb(null);
  loopController.setWorktreeRunnerForTests(null);
  teardownTestDb();
});

describe('handleAutoVerifyRetry', () => {
  it('skips tasks tagged factory:internal', async () => {
    const runVerifyCommand = vi.fn();

    autoVerifyRetry.init({
      db: {
        getProjectFromPath: vi.fn(),
        getProjectConfig: vi.fn(),
        getTask: vi.fn(),
        updateTask: vi.fn(),
      },
      startTask: vi.fn(),
      processQueue: vi.fn(),
      testRunnerRegistry: {
        runVerifyCommand,
      },
    });

    await autoVerifyRetry.handleAutoVerifyRetry({
      taskId: 't1',
      status: 'completed',
      task: {
        tags: ['factory:internal'],
        working_directory: '/tmp',
      },
    });

    expect(runVerifyCommand).not.toHaveBeenCalled();
  });
});

describe('runArchitectLLM', () => {
  it('passes target project working_directory to the submitter', async () => {
    installTaskManagerCache({ startTask: vi.fn() });

    const submitSpy = vi.spyOn(routingModule, 'handleSmartSubmitTask').mockResolvedValue({
      task_id: 'architect-task-1',
    });
    vi.spyOn(taskCore, 'getTask').mockReturnValue({
      id: 'architect-task-1',
      status: 'completed',
      output: JSON.stringify({
        reasoning: 'LLM reasoning',
        backlog: [
          {
            work_item_id: 'arch-1',
            title: 'LLM backlog item',
          },
        ],
      }),
    });
    vi.spyOn(factoryHealth, 'getProject').mockReturnValue({
      id: 'pid',
      name: 'Architect Target',
      path: '/target/path',
      trust_level: 'supervised',
    });
    vi.spyOn(factoryHealth, 'getLatestScores').mockReturnValue({ build_ci: 12 });
    vi.spyOn(factoryIntake, 'listOpenWorkItems').mockReturnValue([]);
    vi.spyOn(factoryArchitect, 'getLatestCycle').mockReturnValue(null);
    vi.spyOn(factoryArchitect, 'createCycle').mockImplementation((payload) => ({
      id: 1,
      ...payload,
    }));
    vi.spyOn(factoryIntake, 'getWorkItem').mockReturnValue(null);
    vi.spyOn(factoryIntake, 'updateWorkItem').mockReturnValue(null);

    await architectRunner.runArchitectCycle('pid', 'manual');

    expect(submitSpy).toHaveBeenCalledWith(expect.objectContaining({
      working_directory: '/target/path',
    }));
  });
});

describe('runAdvanceLoop EXECUTE', () => {
  it('terminates when no targetItem selected', async () => {
    const project = createProject('execute-no-target-item');
    const instance = factoryLoopInstances.createInstance({ project_id: project.id });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
      work_item_id: null,
      batch_id: null,
    });

    const result = await loopController.runAdvanceLoop(instance.id);

    expect(result.new_state).toBe(LOOP_STATES.IDLE);
    expect(result.reason).toBe('no_work_item_selected');
  });
});

describe('executeNonPlanFileStage', () => {
  it('rejects work items with empty description', async () => {
    const project = createProject('execute-empty-description');
    const instance = factoryLoopInstances.createInstance({ project_id: project.id });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.EXECUTE,
      paused_at_stage: null,
    });
    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'scout',
      title: 'Empty description regression',
      description: 'placeholder',
      requestor: 'test',
    });
    const updateSpy = vi.spyOn(factoryIntake, 'updateWorkItem');

    const result = await loopController.executeNonPlanFileStage(project, instance, {
      id: workItem.id,
      description: '',
    });

    expect(updateSpy).toHaveBeenCalledWith(workItem.id, expect.objectContaining({
      status: 'rejected',
      reject_reason: expect.stringContaining('no description'),
    }));
    expect(result).toEqual(expect.objectContaining({
      stop_execution: true,
      next_state: LOOP_STATES.IDLE,
    }));
  });
});
