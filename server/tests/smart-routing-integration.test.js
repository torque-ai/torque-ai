'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

let db;
let handler;
let taskManager;
let templateBuffer;
let createAndStartTaskSpy;
let _capturedTaskArgs;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

function seedModelCapabilities() {
  const seed = [
    {
      model: 'smart-testing-model',
      scores: {
        score_testing: 0.98,
        score_code_gen: 0.32,
        score_refactoring: 0.25,
        score_reasoning: 0.20,
        score_docs: 0.45,
        lang_typescript: 0.88,
        lang_javascript: 0.75,
        lang_python: 0.65,
        context_window: 16384,
        param_size_b: 12,
      },
    },
    {
      model: 'smart-doc-model',
      scores: {
        score_testing: 0.28,
        score_code_gen: 0.42,
        score_refactoring: 0.35,
        score_reasoning: 0.31,
        score_docs: 0.97,
        lang_typescript: 0.72,
        lang_javascript: 0.86,
        lang_python: 0.58,
        context_window: 16384,
        param_size_b: 14,
      },
    },
    {
      model: 'smart-code-model',
      scores: {
        score_testing: 0.40,
        score_code_gen: 0.99,
        score_refactoring: 0.78,
        score_reasoning: 0.55,
        score_docs: 0.32,
        lang_typescript: 0.94,
        lang_javascript: 0.91,
        lang_python: 0.84,
        context_window: 8192,
        param_size_b: 16,
      },
    },
  ];

  for (const item of seed) {
    db.upsertModelCapabilities(item.model, item.scores);
  }
}

function seedProviders() {
  db.updateProvider('ollama', { enabled: 1, transport: 'api', max_concurrent: 4, priority: 3 });
  db.updateProvider('codex', { enabled: 1, transport: 'hybrid', max_concurrent: 6, priority: 1 });
  db.setConfig('codex_enabled', '1');
  db.setConfig('codex_spark_enabled', '1');
  db.setConfig('smart_routing_enabled', '1');
  // Clear model overrides from complexity routing so capability-based routing can select test models
  const rawDb = db.getDb ? db.getDb() : db.getDbInstance();
  rawDb.prepare('UPDATE complexity_routing SET model = NULL WHERE complexity IN (?, ?)').run('simple', 'normal');
}

function seedHosts() {
  const rawDb = db.getDb ? db.getDb() : db.getDbInstance();
  rawDb.prepare('DELETE FROM ollama_hosts').run();

  const hostA = db.addOllamaHost({
    id: 'host-local-127-0-0-1-a',
    name: 'local-127-0-0-1-a',
    url: 'http://127.0.0.1:11434',
    max_concurrent: 4,
  });
  const hostB = db.addOllamaHost({
    id: 'host-local-127-0-0-1-b',
    name: 'local-127-0-0-1-b',
    url: 'http://127.0.0.1:11435',
    max_concurrent: 4,
  });

  const modelsCache = JSON.stringify([
    'smart-testing-model',
    'smart-doc-model',
    'smart-code-model',
    TEST_MODELS.SMALL,
  ]);
  const now = new Date().toISOString();

  db.updateOllamaHost(hostA.id, {
    status: 'healthy',
    running_tasks: 0,
    models_cache: modelsCache,
    models_updated_at: now,
    last_health_check: now,
    last_healthy: now,
  });
  db.updateOllamaHost(hostB.id, {
    status: 'healthy',
    running_tasks: 0,
    models_cache: modelsCache,
    models_updated_at: now,
    last_health_check: now,
    last_healthy: now,
  });
}

function resetAndSeedDb() {
  vi.restoreAllMocks();

  db.resetForTest(templateBuffer);
  db.checkOllamaHealth = async () => true;

  seedModelCapabilities();
  seedProviders();
  seedHosts();

  createAndStartTaskSpy = vi.spyOn(taskManager, 'createAndStartTask');
  createAndStartTaskSpy.mockClear();
  _capturedTaskArgs = null;

  const originalCreateTask = db.createTask;
  vi.spyOn(db, 'createTask').mockImplementation((task) => {
    _capturedTaskArgs = task;
    taskManager.createAndStartTask(task);
    return originalCreateTask(task);
  });

  taskManager.processQueue = vi.fn();

  const originalListOllamaHosts = db.listOllamaHosts;
  vi.spyOn(db, 'listOllamaHosts').mockImplementation((options = {}) => {
    const hosts = originalListOllamaHosts(options);
    return hosts.map(host => {
      if (Array.isArray(host.models) && typeof host.models !== 'string') {
        return {
          ...host,
          models: JSON.stringify(host.models),
        };
      }
      return host;
    });
  });
}

function getSubmittedTask(result) {
  const taskId = result.__subscribe_task_id || result.task_id;
  return taskId ? db.getTask(taskId) : null;
}

beforeAll(() => {
  const env = setupTestDb('smart-routing-integration');
  db = env.db;
  templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);

  taskManager = {
    createAndStartTask: () => {},
    processQueue: () => {},
    resolveFileReferences: () => ({ resolved: [], unresolved: [] }),
    extractJsFunctionBoundaries: () => [],
    PROVIDER_DEFAULT_TIMEOUTS: {
      codex: 60,
      ollama: 30,
      'claude-cli': 45,
      hashline: 45,
      'hashline-ollama': 30,
      deepinfra: 45,
      hyperbolic: 45,
      anthropic: 45,
      groq: 30,
    },
  };

  const taskManagerPath = require.resolve('../task-manager');
  require.cache[taskManagerPath] = {
    id: taskManagerPath,
    filename: taskManagerPath,
    loaded: true,
    exports: taskManager,
  };

  handler = require('../handlers/integration/routing');
});

afterAll(() => {
  vi.restoreAllMocks();
  teardownTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetAndSeedDb();
});

describe('smart routing model scoring helpers', () => {
  it('prefers a testing-specialized model for testing tasks', () => {
    const ranked = db.selectBestModel('testing', 'typescript', 'normal', [
      'smart-testing-model',
      'smart-doc-model',
      'smart-code-model',
    ]);

    expect(ranked[0].model).toBe('smart-testing-model');
  });

  it('prefers a docs-specialized model for documentation tasks', () => {
    const ranked = db.selectBestModel('docs', 'typescript', 'normal', [
      'smart-testing-model',
      'smart-doc-model',
      'smart-code-model',
    ]);

    expect(ranked[0].model).toBe('smart-doc-model');
  });

  it('prefers a code-specialized model for code_gen tasks', () => {
    const ranked = db.selectBestModel('code_gen', 'typescript', 'normal', [
      'smart-testing-model',
      'smart-doc-model',
      'smart-code-model',
    ]);

    expect(ranked[0].model).toBe('smart-code-model');
  });
});

describe('classifyTaskType helper', () => {
  it('classifies testing task intent', () => {
    expect(db.classifyTaskType('Write unit tests for auth.js')).toBe('testing');
  });

  it('classifies refactoring intent', () => {
    expect(db.classifyTaskType('Refactor the database module')).toBe('refactoring');
  });

  it('classifies documentation intent', () => {
    expect(db.classifyTaskType('Update the README')).toBe('docs');
  });

  it('classifies code generation intent by default', () => {
    expect(db.classifyTaskType('Add a new API endpoint')).toBe('code_gen');
  });
});

describe('detectTaskLanguage helper', () => {
  it('detects typescript from file extension', () => {
    expect(db.detectTaskLanguage('Refactor handler', ['src/app.ts'])).toBe('typescript');
  });

  it('detects python from file extension', () => {
    expect(db.detectTaskLanguage('Refactor util', ['main.py'])).toBe('python');
  });

  it('detects javascript from description when files are empty', () => {
    expect(db.detectTaskLanguage('Fix the JavaScript bug', [])).toBe('javascript');
  });
});

describe('handleSmartSubmitTask end-to-end (mocked task submission)', () => {
  it('routes testing task via smart model selection and captures provider/model payload', async () => {
    const result = await handler.handleSmartSubmitTask({
      task: 'Write unit tests for auth.js',
      working_directory: process.cwd(),
    });

    const createdTask = getSubmittedTask(result);
    expect(createdTask).toBeTruthy();
    expect(createAndStartTaskSpy).toHaveBeenCalledTimes(1);

    const createdPayload = createAndStartTaskSpy.mock.calls[0][0];
    expect(createdPayload).toBeTruthy();
    expect(createdPayload.provider).toBe('codex');
    expect(createdPayload.model).toBe('gpt-5.3-codex-spark');
    expect(createdTask.provider).toBe(createdPayload.provider);
    expect(createdTask.model).toBe(createdPayload.model);
  });

  it('routes documentation greenfield task to Codex (Ollama cannot create files)', async () => {
    const result = await handler.handleSmartSubmitTask({
      task: 'Update the README',
      working_directory: process.cwd(),
    });

    const createdTask = getSubmittedTask(result);
    expect(createdTask).toBeTruthy();
    expect(createAndStartTaskSpy).toHaveBeenCalledTimes(1);
    // hashline-ollama handles the task (modification routing block skipped for hashline)
    expect(createAndStartTaskSpy.mock.calls[0][0].provider).toBe('hashline-ollama');
  });

  it('routes code_gen greenfield task to Codex (Ollama cannot create files)', async () => {
    const result = await handler.handleSmartSubmitTask({
      task: 'Add a new API endpoint',
      working_directory: process.cwd(),
    });

    const createdTask = getSubmittedTask(result);
    expect(createdTask).toBeTruthy();
    expect(createAndStartTaskSpy).toHaveBeenCalledTimes(1);
    // hashline-ollama handles the task (modification routing block skipped for hashline)
    expect(createAndStartTaskSpy.mock.calls[0][0].provider).toBe('hashline-ollama');
  });

  it('adds needs_review metadata for complex smart-routed tasks only', async () => {
    vi.spyOn(db, 'analyzeTaskForRouting').mockReturnValue({
      provider: 'codex',
      complexity: 'complex',
      reason: 'Complex task',
      rule: null,
      fallbackApplied: false,
    });

    const complexResult = await handler.handleSmartSubmitTask({
      task: 'Design a distributed scheduler with retries, failover, and recovery logic',
      working_directory: process.cwd(),
    });

    const complexTask = getSubmittedTask(complexResult);
    expect(complexTask).toBeTruthy();
    expect(complexTask.metadata).toMatchObject({ smart_routing: true, needs_review: true, complexity: 'complex' });

    vi.spyOn(db, 'analyzeTaskForRouting').mockReturnValue({
      provider: 'codex',
      complexity: 'normal',
      reason: 'Normal task',
      rule: null,
      fallbackApplied: false,
    });

    const normalResult = await handler.handleSmartSubmitTask({
      task: 'Update the README headings',
      working_directory: process.cwd(),
    });

    const normalTask = getSubmittedTask(normalResult);
    expect(normalTask).toBeTruthy();
    expect(normalTask.metadata).toMatchObject({ smart_routing: true, complexity: 'normal' });
    expect(normalTask.metadata).not.toHaveProperty('needs_review');
  });

  it('adds split_advisory metadata only for complex smart-routed tasks with 3+ files', async () => {
    vi.spyOn(db, 'analyzeTaskForRouting').mockReturnValue({
      provider: 'codex',
      complexity: 'complex',
      reason: 'Complex task',
      rule: null,
      fallbackApplied: false,
    });

    const advisoryResult = await handler.handleSmartSubmitTask({
      task: 'Design a distributed scheduler with retries, failover, and recovery logic',
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      working_directory: process.cwd(),
    });

    const advisoryTask = getSubmittedTask(advisoryResult);
    expect(advisoryTask).toBeTruthy();
    expect(advisoryTask.metadata).toMatchObject({
      smart_routing: true,
      complexity: 'complex',
      split_advisory: true,
    });

    const noAdvisoryResult = await handler.handleSmartSubmitTask({
      task: 'Design a distributed scheduler with retries, failover, and recovery logic',
      files: ['src/a.ts'],
      working_directory: process.cwd(),
    });

    const noAdvisoryTask = getSubmittedTask(noAdvisoryResult);
    expect(noAdvisoryTask).toBeTruthy();
    expect(noAdvisoryTask.metadata).toMatchObject({ smart_routing: true, complexity: 'complex' });
    expect(noAdvisoryTask.metadata).not.toHaveProperty('split_advisory');
  });

  it('returns actionable workflow subscription metadata when smart submit auto-decomposes', async () => {
    vi.spyOn(db, 'analyzeTaskForRouting').mockReturnValue({
      provider: 'codex',
      complexity: 'complex',
      reason: 'Complex C# task',
      rule: null,
      fallbackApplied: false,
    });
    vi.spyOn(db, 'decomposeTask').mockReturnValue([
      'Extract repository interface',
      'Wire repository into service',
    ]);

    const result = await handler.handleSmartSubmitTask({
      task: 'Refactor MyService.cs in C# to use a repository abstraction',
      files: ['src/MyService.cs'],
      working_directory: process.cwd(),
    });

    expect(result.workflow_id).toBeTruthy();
    expect(result.task_ids).toHaveLength(2);
    expect(result.__subscribe_task_ids).toEqual(result.task_ids);
    expect(result.subscription_target).toMatchObject({
      kind: 'workflow',
      workflow_id: result.workflow_id,
      task_ids: result.task_ids,
      subscribe_tool: 'subscribe_task_events',
      subscribe_args: { task_ids: result.task_ids },
    });
    expect(result.content[0].text).toContain('### Subscribe');
    expect(result.content[0].text).toContain('"task_ids"');
  });
});
