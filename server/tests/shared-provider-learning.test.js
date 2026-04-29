'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const finalizer = require('../execution/task-finalizer');
const providerScoring = require('../db/provider-scoring');
const providerRoutingCore = require('../db/provider-routing-core');
const {
  createSharedFactoryStore,
  deriveLearningScope,
} = require('../db/shared-factory-store');

const DEFAULT_WEIGHTS = {
  cost: 0.15,
  speed: 0.25,
  reliability: 0.35,
  quality: 0.25,
};

function createFinalizerTaskDb(task) {
  const current = { ...task };
  return {
    getTask: vi.fn((id) => (id === current.id ? { ...current } : null)),
    updateTaskStatus: vi.fn((id, status, fields = {}) => {
      if (id !== current.id) return null;
      Object.assign(current, fields, { status, completed_at: new Date().toISOString() });
      return { ...current };
    }),
    getStoredTask: () => ({ ...current }),
  };
}

function initRoutingDb(sharedFactoryStore) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_config (
      provider TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 50,
      transport TEXT,
      quota_error_patterns TEXT DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      description TEXT,
      rule_type TEXT,
      pattern TEXT,
      target_provider TEXT,
      priority INTEGER DEFAULT 50,
      enabled INTEGER DEFAULT 1,
      complexity TEXT
    );
    CREATE TABLE IF NOT EXISTS routing_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      rules_json TEXT NOT NULL,
      complexity_overrides_json TEXT,
      preset INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
    INSERT OR REPLACE INTO config (key, value) VALUES
      ('smart_routing_enabled', '1'),
      ('smart_routing_default_provider', 'ollama'),
      ('default_provider', 'ollama'),
      ('ollama_fallback_provider', 'codex');
  `);
  db.getConfig = (key) => {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : null;
  };
  db.getProvider = (provider) => db.prepare('SELECT * FROM provider_config WHERE provider = ?').get(provider) || null;

  const insertProvider = db.prepare(`
    INSERT OR REPLACE INTO provider_config (provider, enabled, priority, transport, quota_error_patterns)
    VALUES (?, 1, ?, ?, '[]')
  `);
  insertProvider.run('ollama', 10, 'api');
  insertProvider.run('codex', 20, 'hybrid');
  insertProvider.run('claude-cli', 30, 'cli');

  providerScoring.init(db);
  providerScoring.setCompositeWeights(DEFAULT_WEIGHTS);
  providerRoutingCore.createProviderRoutingCore({
    db,
    taskCore: () => null,
    hostManagement: {
      determineTaskComplexity: () => 'normal',
      routeTask: () => null,
    },
    sharedFactoryStore,
  });
  providerRoutingCore.setOllamaHealthy(true);
  providerRoutingCore.setProviderScoring(providerScoring);

  return db;
}

function recordProviderSamples() {
  for (let index = 0; index < 5; index += 1) {
    providerScoring.recordTaskCompletion({
      provider: 'codex',
      success: true,
      durationMs: 100,
      costUsd: 0,
      qualityScore: 0.8,
    });
    providerScoring.recordTaskCompletion({
      provider: 'claude-cli',
      success: true,
      durationMs: 110,
      costUsd: 0,
      qualityScore: 0.8,
    });
  }
}

describe('shared provider learning', () => {
  let tempDir;
  let store;
  let routingDb;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-shared-provider-learning-'));
    store = createSharedFactoryStore({ dbPath: path.join(tempDir, 'shared.db') });
  });

  afterEach(() => {
    finalizer._testing.resetForTest();
    providerRoutingCore.setProviderScoring(null);
    providerRoutingCore.setSharedFactoryStore(null);
    if (routingDb) {
      try { routingDb.close(); } catch {}
      routingDb = null;
    }
    try { store.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    vi.restoreAllMocks();
  });

  it('derives .NET learning scope from files, metadata, working directory, and description', () => {
    const scope = deriveLearningScope({
      metadata: {
        target_files: ['src/Billing/Billing.csproj'],
      },
      files: ['src/Billing/Migrations/AddInvoice.cs'],
      workingDirectory: path.join(tempDir, 'dotnet-service'),
      description: 'Fix EF Core EntityFramework migration with dotnet test',
    });

    expect(scope).toMatchObject({
      signal_type: 'provider_failure_rate',
      scope_key: 'tech_stack:dotnet',
      tech_stack: 'dotnet',
    });
    expect(scope.signals).toEqual(expect.arrayContaining([
      'file_ext:.cs',
      'file_ext:.csproj',
      'keyword:EntityFramework',
      'keyword:EF Core',
      'keyword:dotnet',
    ]));
  });

  it('records failed .NET task outcomes as provider failure-rate learnings', async () => {
    const task = {
      id: 'dotnet-failure-1',
      status: 'running',
      provider: 'codex',
      task_description: 'Fix EF Core migration and run dotnet test',
      working_directory: path.join(tempDir, 'ProjectA'),
      metadata: JSON.stringify({
        project_id: 'ProjectA',
        target_files: ['src/App/App.csproj'],
      }),
      output: '',
      error_output: '',
      started_at: new Date(Date.now() - 1000).toISOString(),
    };
    const db = createFinalizerTaskDb(task);

    finalizer.init({
      db,
      sharedFactoryStore: store,
      providerScoring: { recordTaskCompletion: vi.fn() },
      sanitizeTaskOutput: (value) => value || '',
      extractModifiedFiles: () => ['src/App/Program.cs'],
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
      errorOutput: '[auto-verify] dotnet test failed',
      filesModified: ['src/App/Program.cs'],
    });

    expect(result.finalized).toBe(true);
    const rows = store.listLearnings({
      signal_type: 'provider_failure_rate',
      scope_key: 'tech_stack:dotnet',
      provider: 'codex',
      includeExpired: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      signal_type: 'provider_failure_rate',
      scope_key: 'tech_stack:dotnet',
      tech_stack: 'dotnet',
      provider: 'codex',
      failure_pattern: 'test_failure',
      sample_count: 1,
      project_source: 'ProjectA',
    });
    expect(rows[0].confidence).toBeGreaterThan(0);
  });

  it('applies active .NET provider failure learning without affecting JavaScript routing', () => {
    routingDb = initRoutingDb(store);
    recordProviderSamples();
    store.upsertLearning({
      signal_type: 'provider_failure_rate',
      scope_key: 'tech_stack:dotnet',
      provider: 'codex',
      failure_pattern: 'test_failure',
      confidence: 0.9,
      sample_count: 5,
      project_source: 'ProjectA',
      expires_at: '2099-01-01T00:00:00.000Z',
    });

    const dotnet = providerRoutingCore.analyzeTaskForRouting(
      'Update EF Core repository and run dotnet test',
      path.join(tempDir, 'ProjectB'),
      ['src/App/App.csproj', 'src/App/Repository.cs'],
      { tierList: true },
    );
    const javascript = providerRoutingCore.analyzeTaskForRouting(
      'Update Express route and run npm test',
      path.join(tempDir, 'ProjectB'),
      ['src/app.js'],
      { tierList: true },
    );
    const override = providerRoutingCore.analyzeTaskForRouting(
      'Update EF Core repository and run dotnet test',
      path.join(tempDir, 'ProjectB'),
      ['src/App/App.csproj', 'src/App/Repository.cs'],
      {
        tierList: true,
        isUserOverride: true,
        overrideProvider: 'codex',
        taskMetadata: { user_provider_override: true },
      },
    );

    expect(dotnet.provider).toBe('claude-cli');
    expect(dotnet.eligible_providers[0]).toBe('claude-cli');
    expect(dotnet.routing_score.source).toBe('provider_scores+shared_learnings');
    expect(dotnet.routing_score.learning_penalties.codex.penalty).toBeGreaterThan(0);
    expect(javascript.provider).toBe('codex');
    expect(javascript.eligible_providers[0]).toBe('codex');
    expect(javascript.routing_score.source).toBe('provider_scores');
    expect(override.provider).toBe('codex');
    expect(override.eligible_providers).toEqual(['codex']);
    expect(override.routing_score).toBeUndefined();
  });

  it('ignores expired provider failure learning rows during routing', () => {
    routingDb = initRoutingDb(store);
    recordProviderSamples();
    store.upsertLearning({
      signal_type: 'provider_failure_rate',
      scope_key: 'tech_stack:dotnet',
      provider: 'codex',
      failure_pattern: 'test_failure',
      confidence: 0.95,
      sample_count: 10,
      project_source: 'ProjectA',
      expires_at: '2000-01-01T00:00:00.000Z',
    });

    const result = providerRoutingCore.analyzeTaskForRouting(
      'Update EF Core repository and run dotnet test',
      path.join(tempDir, 'ProjectB'),
      ['src/App/App.csproj', 'src/App/Repository.cs'],
      { tierList: true },
    );

    expect(result.provider).toBe('codex');
    expect(result.eligible_providers[0]).toBe('codex');
    expect(result.routing_score.source).toBe('provider_scores');
  });
});
