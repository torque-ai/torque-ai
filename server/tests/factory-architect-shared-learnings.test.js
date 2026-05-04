'use strict';
/* global describe, it, expect, beforeEach, afterEach */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const finalizer = require('../execution/task-finalizer');
const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const factoryArchitect = require('../db/factory/architect');
const { buildArchitectPrompt } = require('../factory/architect-prompt');
const {
  createSharedFactoryStore,
  deriveVerifyFailurePattern,
  DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
} = require('../db/shared-factory-store');

const TASK_MANAGER_PATH = require.resolve('../task-manager');
const ARCHITECT_RUNNER_PATH = require.resolve('../factory/architect-runner');

function createFinalizerTaskDb(task) {
  const current = { ...task };
  return {
    getTask: vi.fn((id) => (id === current.id ? { ...current } : null)),
    updateTaskStatus: vi.fn((id, status, fields = {}) => {
      if (id !== current.id) return null;
      Object.assign(current, fields, { status, completed_at: new Date().toISOString() });
      return { ...current };
    }),
  };
}

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

function installTaskManagerMock() {
  const originals = new Map();
  for (const modulePath of [TASK_MANAGER_PATH, ARCHITECT_RUNNER_PATH]) {
    originals.set(modulePath, require.cache[modulePath] || null);
  }
  require.cache[TASK_MANAGER_PATH] = {
    id: TASK_MANAGER_PATH,
    filename: TASK_MANAGER_PATH,
    loaded: true,
    exports: {},
  };
  delete require.cache[ARCHITECT_RUNNER_PATH];
  return () => {
    for (const [modulePath, original] of originals.entries()) {
      if (original) {
        require.cache[modulePath] = original;
      } else {
        delete require.cache[modulePath];
      }
    }
  };
}

function seedVerifyFailureLearning(store, overrides = {}) {
  const pattern = deriveVerifyFailurePattern({
    description: 'Refactor EF Core repository and DbContext models',
    errorOutput: '[auto-verify] dotnet test failed during EF Core refactor',
    files: ['src/Data/AppDbContext.cs', 'src/Data/App.csproj'],
  });
  return store.upsertLearning({
    signal_type: DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
    scope_key: pattern.scope_key,
    tech_stack: pattern.tech_stack,
    provider: 'codex',
    failure_pattern: pattern.pattern_hash,
    confidence: 0.9,
    sample_count: 3,
    project_source: 'SpudgetBooks',
    expires_at: '2099-01-01T00:00:00.000Z',
    payload: {
      signal_type: DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
      scope_key: pattern.scope_key,
      tech_stack: pattern.tech_stack,
      provider: 'codex',
      pattern_hash: pattern.pattern_hash,
      normalized_pattern: pattern.normalized_pattern,
      failure_categories: pattern.categories,
      failure_category: pattern.failure_category,
    },
    ...overrides,
  });
}

describe('factory architect shared verify-failure learnings', () => {
  let tempDir;
  let store;
  let restoreTaskManager;
  let db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-architect-learnings-'));
    store = createSharedFactoryStore({ dbPath: path.join(tempDir, 'shared.db') });
  });

  afterEach(() => {
    finalizer._testing.resetForTest();
    if (restoreTaskManager) {
      restoreTaskManager();
      restoreTaskManager = null;
    }
    if (db) {
      factoryArchitect.setDb(null);
      factoryHealth.setDb(null);
      factoryIntake.setDb(null);
      try { db.close(); } catch {}
      db = null;
    }
    try { store.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    vi.restoreAllMocks();
  });

  it('records failed EF Core auto-verify outcomes as stable verify-failure learnings', async () => {
    const task = {
      id: 'ef-core-verify-failure',
      status: 'running',
      provider: 'codex',
      task_description: 'Refactor EF Core repository layer and run dotnet test',
      working_directory: path.join(tempDir, 'SpudgetBooks'),
      metadata: JSON.stringify({
        project_id: 'SpudgetBooks',
        target_files: ['src/Data/AppDbContext.cs', 'src/Data/App.csproj'],
      }),
      output: '',
      error_output: '',
      started_at: new Date(Date.now() - 1000).toISOString(),
    };

    finalizer.init({
      db: createFinalizerTaskDb(task),
      sharedFactoryStore: store,
      sanitizeTaskOutput: (value) => value || '',
      extractModifiedFiles: () => ['src/Data/UserRepository.cs'],
      handleRetryLogic: vi.fn(),
      handleSafeguardChecks: vi.fn(),
      handleFuzzyRepair: vi.fn(),
      handleNoFileChangeDetection: vi.fn(),
      handleAutoValidation: vi.fn(),
      handleBuildTestStyleCommit: vi.fn(),
      handleAutoVerifyRetry: vi.fn(),
      handleProviderFailover: vi.fn(),
      handlePostCompletion: vi.fn(),
    });

    const result = await finalizer.finalizeTask(task.id, {
      exitCode: 1,
      output: '',
      errorOutput: '[auto-verify] dotnet test failed during EF Core refactor',
      filesModified: ['src/Data/UserRepository.cs'],
    });

    expect(result.finalized).toBe(true);
    const rows = store.listLearnings({
      signal_type: DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
      scope_key: 'tech_stack:dotnet',
      provider: 'codex',
      includeExpired: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].failure_pattern).toMatch(/^[a-f0-9]{16}$/);
    expect(rows[0]).toMatchObject({
      signal_type: DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
      tech_stack: 'dotnet',
      provider: 'codex',
      project_source: 'SpudgetBooks',
    });

    const payload = JSON.parse(rows[0].payload_json);
    expect(payload.failure_categories).toEqual(expect.arrayContaining([
      'ef_core_refactor_verify_failure',
    ]));
    expect(payload.pattern_hash).toBe(rows[0].failure_pattern);
  });

  it('lowers similar EF Core backlog rank while preserving unrelated item order and prompt context', () => {
    seedVerifyFailureLearning(store);
    restoreTaskManager = installTaskManagerMock();
    const runner = require('../factory/architect-runner');
    const sharedLearnings = runner._internalForTests.loadActiveVerifyFailureLearnings({
      sharedFactoryStore: store,
      now: '2026-04-29T12:00:00.000Z',
    });

    const intakeItems = [
      {
        id: 'ef-core',
        title: 'Refactor EF Core repository layer',
        description: 'Update DbContext and entity relationship models.',
        created_at: '2026-04-29T10:00:00.000Z',
      },
      {
        id: 'docs',
        title: 'Refresh onboarding docs',
        description: 'Update setup instructions.',
        created_at: '2026-04-29T10:01:00.000Z',
      },
      {
        id: 'auth',
        title: 'Harden login flow',
        description: 'Review authentication handling.',
        created_at: '2026-04-29T10:02:00.000Z',
      },
    ];

    const baseline = runner.prioritizeByHealth(intakeItems, []);
    const penalized = runner.prioritizeByHealth(intakeItems, [], {
      project: { name: 'torque-public', path: path.join(tempDir, 'torque-public') },
      sharedLearnings,
    });

    expect(baseline.map((entry) => entry.title)).toEqual([
      'Refactor EF Core repository layer',
      'Refresh onboarding docs',
      'Harden login flow',
    ]);
    expect(penalized.map((entry) => entry.title)).toEqual([
      'Refresh onboarding docs',
      'Harden login flow',
      'Refactor EF Core repository layer',
    ]);
    expect(penalized[0].learning_penalty).toBe(0);
    expect(penalized[1].learning_penalty).toBe(0);
    expect(penalized[2].learning_penalty).toBeGreaterThan(0);
    expect(penalized[2].why).toContain('Shared verify-failure learning penalty');
    expect(penalized[2].learning_categories).toEqual(expect.arrayContaining([
      'ef_core_refactor_verify_failure',
    ]));

    const prompt = buildArchitectPrompt({
      project: {
        id: 'torque-public',
        name: 'torque-public',
        brief: 'Factory coordination project.',
      },
      healthScores: [],
      intakeItems,
      sharedLearnings,
      previousBacklog: [],
      previousReasoning: '',
    });

    expect(prompt).toContain('## Shared verify-failure learnings');
    expect(prompt).toContain('ef_core_refactor_verify_failure');
    expect(prompt).toContain('learning_penalty');
  });

  it('stores cycle reasoning and backlog entries that explain shared learning penalties', async () => {
    seedVerifyFailureLearning(store);
    restoreTaskManager = installTaskManagerMock();
    const runner = require('../factory/architect-runner');
    runner._internalForTests.setSharedFactoryStore(store);

    db = new Database(':memory:');
    createFactoryTables(db);
    factoryArchitect.setDb(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);

    const projectPath = path.join(tempDir, 'torque-public');
    fs.mkdirSync(projectPath, { recursive: true });
    const project = factoryHealth.registerProject({
      name: 'torque-public',
      path: projectPath,
      brief: 'Factory project with shared backlog coordination.',
      trust_level: 'supervised',
    });

    const efItem = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Refactor EF Core repository layer',
      description: 'Update DbContext and entity relationship models.',
    });
    const docsItem = factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Refresh onboarding docs',
      description: 'Update setup instructions.',
    });
    db.prepare('UPDATE factory_work_items SET created_at = ? WHERE id = ?')
      .run('2026-04-29T10:00:00.000Z', efItem.id);
    db.prepare('UPDATE factory_work_items SET created_at = ? WHERE id = ?')
      .run('2026-04-29T10:01:00.000Z', docsItem.id);

    const cycle = await runner.runArchitectCycle(project.id, 'manual');
    const efBacklogEntry = cycle.backlog.find((entry) => entry.title === 'Refactor EF Core repository layer');

    expect(cycle.backlog.map((entry) => entry.title)).toEqual([
      'Refresh onboarding docs',
      'Refactor EF Core repository layer',
    ]);
    expect(cycle.reasoning).toContain('Applied shared verify-failure learning penalties');
    expect(efBacklogEntry.learning_penalty).toBeGreaterThan(0);
    expect(efBacklogEntry.why).toContain('Shared verify-failure learning penalty');
    expect(factoryArchitect.getLatestCycle(project.id).backlog).toEqual(cycle.backlog);
  });
});
