'use strict';

const fs = require('fs');
const path = require('path');

const getTaskMock = vi.fn();
const submitFactoryInternalTaskMock = vi.fn();
const taskManagerMock = { startTask: vi.fn() };
const mockedModulePaths = [
  '../task-manager',
  '../db/task-core',
  '../factory/internal-task-submit',
];
const originalModules = new Map();

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  if (!originalModules.has(resolved)) {
    originalModules.set(resolved, require.cache[resolved] || null);
  }
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function restoreCjsModuleMocks() {
  for (const modulePath of mockedModulePaths) {
    const resolved = require.resolve(modulePath);
    const originalModule = originalModules.get(resolved);
    if (originalModule) {
      require.cache[resolved] = originalModule;
    } else {
      delete require.cache[resolved];
    }
  }
  originalModules.clear();
}

installCjsModuleMock('../task-manager', taskManagerMock);
installCjsModuleMock('../factory/internal-task-submit', {
  submitFactoryInternalTask: submitFactoryInternalTaskMock,
});

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const factoryArchitect = require('../db/factory-architect');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const { runArchitectCycle } = require('../factory/architect-runner');

let dbModule;
let dbHandle;
let testDir;

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
  `);
}

function resetFactoryTables(db) {
  for (const table of [
    'factory_architect_cycles',
    'factory_work_items',
    'factory_health_snapshots',
    'factory_projects',
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
}

function wireFactoryDbModules(db) {
  factoryArchitect.setDb(db);
  factoryHealth.setDb(db);
  factoryIntake.setDb(db);
}

function createProject(name = 'bitsy') {
  const projectPath = path.join(testDir, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(projectPath, { recursive: true });
  return factoryHealth.registerProject({
    name,
    path: projectPath,
    brief: `${name} architect promotion test project`,
    trust_level: 'supervised',
  });
}

function seedHealthScore(projectId, dimension = 'build_ci', score = 25) {
  dbHandle.prepare(`
    INSERT INTO factory_health_snapshots (
      project_id,
      dimension,
      score,
      details_json,
      scan_type,
      batch_id,
      scanned_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(projectId, dimension, score, null, 'incremental', null);
}

function setArchitectBacklog(backlog, reasoning = 'LLM architect reasoning') {
  submitFactoryInternalTaskMock.mockResolvedValue({ task_id: 'architect-task' });
  getTaskMock.mockReturnValue({
    id: 'architect-task',
    status: 'completed',
    output: JSON.stringify({ reasoning, backlog }),
  });
}

beforeAll(() => {
  ({ db: dbModule, testDir } = setupTestDbOnly('architect-to-intake'));
  dbHandle = dbModule.getDbInstance();
  ensureFactoryTables(dbHandle);
  wireFactoryDbModules(dbHandle);
});

beforeEach(() => {
  dbHandle = dbModule.getDbInstance();
  ensureFactoryTables(dbHandle);
  resetFactoryTables(dbHandle);
  wireFactoryDbModules(dbHandle);
  installCjsModuleMock('../db/task-core', { getTask: getTaskMock });
  vi.clearAllMocks();
  vi.spyOn(factoryIntake, 'listOpenWorkItems').mockReturnValue([{
    id: 10001,
    title: 'Existing intake context',
    description: 'Keeps architect promotion tests on the LLM path.',
    status: 'pending',
    created_at: '2026-04-20T00:00:00.000Z',
  }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  factoryArchitect.setDb(null);
  factoryHealth.setDb(null);
  factoryIntake.setDb(null);
  restoreCjsModuleMocks();
  teardownTestDb();
});

describe('architect backlog promotion to intake', () => {
  it('promotes backlog entries with null work_item_id into pending architect intake items', async () => {
    const project = createProject();
    seedHealthScore(project.id);
    setArchitectBacklog([
      {
        work_item_id: null,
        title: 'Create first-run smoke coverage',
        why: 'Protect the empty-intake onboarding path.',
        scope_budget: 3,
        priority_rank: 1,
      },
      {
        work_item_id: null,
        title: 'Stabilize packaging entrypoints',
        why: 'Prevent broken imports on first install.',
        scope_budget: 5,
        priority_rank: 2,
      },
    ]);

    const cycle = await runArchitectCycle(project.id, 'manual');
    const items = factoryIntake.listWorkItems({ project_id: project.id });

    expect(items).toHaveLength(2);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Create first-run smoke coverage',
        status: 'pending',
        source: 'architect',
      }),
      expect.objectContaining({
        title: 'Stabilize packaging entrypoints',
        status: 'pending',
        source: 'architect',
      }),
    ]));
    expect(cycle.backlog).toEqual([
      expect.objectContaining({ work_item_id: expect.any(Number) }),
      expect.objectContaining({ work_item_id: expect.any(Number) }),
    ]);
  });

  it('leaves backlog entries with an existing work_item_id alone', async () => {
    const project = createProject();
    seedHealthScore(project.id);
    const existing = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'conversation',
      title: 'Existing tracked item',
      description: 'Already in intake.',
    });
    const createSpy = vi.spyOn(factoryIntake, 'createWorkItem');

    setArchitectBacklog([
      {
        work_item_id: existing.id,
        title: existing.title,
        why: 'Already tracked in intake.',
        scope_budget: 2,
        priority_rank: 1,
      },
      {
        work_item_id: null,
        title: 'New architect-generated item',
        why: 'Needs intake creation.',
        scope_budget: 4,
        priority_rank: 2,
      },
    ]);

    await runArchitectCycle(project.id, 'manual');

    const items = factoryIntake.listWorkItems({ project_id: project.id });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(2);
    expect(items.filter((item) => item.title === existing.title)).toHaveLength(1);
  });

  it('assigns higher intake priority to better architect ranks', async () => {
    const project = createProject();
    seedHealthScore(project.id);
    setArchitectBacklog([
      {
        work_item_id: null,
        title: 'Top ranked backlog item',
        why: 'Highest priority work.',
        scope_budget: 3,
        priority_rank: 1,
      },
      {
        work_item_id: null,
        title: 'Lower ranked backlog item',
        why: 'Follow-up work.',
        scope_budget: 3,
        priority_rank: 9,
      },
    ]);

    await runArchitectCycle(project.id, 'manual');

    const items = factoryIntake.listWorkItems({ project_id: project.id });
    const highest = items.find((item) => item.title === 'Top ranked backlog item');
    const lower = items.find((item) => item.title === 'Lower ranked backlog item');

    expect(highest.priority).toBeGreaterThan(lower.priority);
  });

  it('updates the stored cycle backlog_json with newly assigned work_item_ids', async () => {
    const project = createProject();
    seedHealthScore(project.id);
    const updateCycleSpy = vi.spyOn(factoryArchitect, 'updateCycle');

    setArchitectBacklog([
      {
        work_item_id: null,
        title: 'Persist intake mapping back into architect cycle',
        why: 'The cycle should point to the created intake item.',
        scope_budget: 3,
        priority_rank: 1,
      },
    ]);

    const cycle = await runArchitectCycle(project.id, 'manual');

    expect(updateCycleSpy).toHaveBeenCalledTimes(1);
    expect(updateCycleSpy).toHaveBeenCalledWith(
      cycle.id,
      expect.objectContaining({
        backlog_json: expect.any(String),
      }),
    );

    const updatedBacklog = JSON.parse(updateCycleSpy.mock.calls[0][1].backlog_json);
    expect(updatedBacklog).toEqual([
      expect.objectContaining({ work_item_id: expect.any(Number) }),
    ]);

    const storedCycle = factoryArchitect.getCycle(cycle.id);
    expect(storedCycle.backlog).toEqual([
      expect.objectContaining({ work_item_id: expect.any(Number) }),
    ]);
  });

  it('continues promoting later entries when one createWorkItem call fails', async () => {
    const project = createProject();
    seedHealthScore(project.id);
    const originalCreateWorkItem = factoryIntake.createWorkItem;

    vi.spyOn(factoryIntake, 'createWorkItem').mockImplementation((args) => {
      if (args.title === 'Duplicate title failure') {
        throw new Error('duplicate title in intake');
      }
      return originalCreateWorkItem(args);
    });

    setArchitectBacklog([
      {
        work_item_id: null,
        title: 'First promoted item',
        why: 'Should still be created.',
        scope_budget: 3,
        priority_rank: 1,
      },
      {
        work_item_id: null,
        title: 'Duplicate title failure',
        why: 'Simulate create failure without aborting the loop.',
        scope_budget: 3,
        priority_rank: 2,
      },
      {
        work_item_id: null,
        title: 'Third promoted item',
        why: 'Should still be created after a failure.',
        scope_budget: 3,
        priority_rank: 3,
      },
    ]);

    const cycle = await runArchitectCycle(project.id, 'manual');
    const items = factoryIntake.listWorkItems({ project_id: project.id });
    const failedEntry = cycle.backlog.find((entry) => entry.title === 'Duplicate title failure');

    expect(items.map((item) => item.title)).toEqual(expect.arrayContaining([
      'First promoted item',
      'Third promoted item',
    ]));
    expect(items).toHaveLength(2);
    expect(failedEntry.work_item_id).toBeNull();
  });
});
