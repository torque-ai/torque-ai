'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsPromises = require('node:fs/promises');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

let db;
let handler;
let hostManagement;
let taskManager;
let templateBuffer;
let processQueueSpy;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
const tempDirs = [];

function ensureModelCapabilitiesColumns() {
  const rawDb = db.getDb ? db.getDb() : db.getDbInstance();
  const columns = new Set(
    rawDb.prepare("PRAGMA table_info('model_capabilities')").all().map((row) => row.name)
  );
  const additions = [
    ['can_create_files', 'INTEGER DEFAULT 1'],
    ['can_edit_safely', 'INTEGER DEFAULT 1'],
    ['max_safe_edit_lines', 'INTEGER DEFAULT 250'],
    ['is_agentic', 'INTEGER DEFAULT 0'],
  ];

  for (const [name, type] of additions) {
    if (!columns.has(name)) {
      rawDb.prepare(`ALTER TABLE model_capabilities ADD COLUMN ${name} ${type}`).run();
    }
  }
}

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
  ensureModelCapabilitiesColumns();

  seedModelCapabilities();
  seedProviders();
  seedHosts();

  processQueueSpy = vi.fn();
  taskManager.processQueue = processQueueSpy;

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
  const env = setupTestDbOnly('smart-routing-integration');
  db = env.db;
  hostManagement = require('../db/host-management');
  templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);

  taskManager = {
    processQueue: () => {},
    resolveFileReferences: () => ({ resolved: [], unresolved: [] }),
    extractJsFunctionBoundaries: () => [],
    PROVIDER_DEFAULT_TIMEOUTS: {
      codex: 60,
      'claude-cli': 45,
      hashline: 45,
      'ollama': 30,
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
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

beforeEach(() => {
  resetAndSeedDb();
});

describe('smart routing model scoring helpers', () => {
  it('prefers a testing-specialized model for testing tasks', () => {
    const ranked = hostManagement.selectBestModel('testing', 'typescript', 'normal', [
      'smart-testing-model',
      'smart-doc-model',
      'smart-code-model',
    ]);

    expect(ranked[0].model).toBe('smart-testing-model');
  });

  it('prefers a docs-specialized model for documentation tasks', () => {
    const ranked = hostManagement.selectBestModel('docs', 'typescript', 'normal', [
      'smart-testing-model',
      'smart-doc-model',
      'smart-code-model',
    ]);

    expect(ranked[0].model).toBe('smart-doc-model');
  });

  it('prefers a code-specialized model for code_gen tasks', () => {
    const ranked = hostManagement.selectBestModel('code_gen', 'typescript', 'normal', [
      'smart-testing-model',
      'smart-doc-model',
      'smart-code-model',
    ]);

    expect(ranked[0].model).toBe('smart-code-model');
  });
});

describe('classifyTaskType helper', () => {
  it('classifies testing task intent', () => {
    expect(hostManagement.classifyTaskType('Write unit tests for auth.js')).toBe('testing');
  });

  it('classifies refactoring intent', () => {
    expect(hostManagement.classifyTaskType('Refactor the database module')).toBe('refactoring');
  });

  it('classifies documentation intent', () => {
    expect(hostManagement.classifyTaskType('Update the README')).toBe('docs');
  });

  it('classifies code generation intent by default', () => {
    expect(hostManagement.classifyTaskType('Add a new API endpoint')).toBe('code_gen');
  });
});

describe('detectTaskLanguage helper', () => {
  it('detects typescript from file extension', () => {
    expect(hostManagement.detectTaskLanguage('Refactor handler', ['src/app.ts'])).toBe('typescript');
  });

  it('detects python from file extension', () => {
    expect(hostManagement.detectTaskLanguage('Refactor util', ['main.py'])).toBe('python');
  });

  it('detects javascript from description when files are empty', () => {
    expect(hostManagement.detectTaskLanguage('Fix the JavaScript bug', [])).toBe('javascript');
  });
});

function getTaskMetadata(task) {
  if (!task || task.metadata == null) return {};
  return typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
}

function createTempDir(prefix = 'torque-smart-routing-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTempFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function isWithinRoot(candidatePath, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidatePath));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function getOutOfRootReadTargets(readSpy, root) {
  return readSpy.mock.calls
    .map(([target]) => String(target))
    .filter(target => !isWithinRoot(target, root));
}

function expectInvalidParamOrNoOutOfRootRead(result, readSpy, workDir) {
  expect(getOutOfRootReadTargets(readSpy, workDir)).toEqual([]);
  if (result && result.isError) {
    expect(result.error_code).toBe('INVALID_PARAM');
    return;
  }
  expect(getSubmittedTask(result)).toBeTruthy();
}

function forceOllamaRouting() {
  vi.spyOn(require('../db/provider/routing-core'), 'analyzeTaskForRouting').mockReturnValue({
    provider: 'ollama',
    complexity: 'normal',
    reason: 'Forced Ollama routing for modification file-size tests',
    rule: null,
    fallbackApplied: false,
  });
}

describe('handleSmartSubmitTask end-to-end (mocked task submission)', () => {
  it('routes testing task via smart model selection and captures provider/model payload', async () => {
    const result = await handler.handleSmartSubmitTask({
      task: 'Write unit tests for auth.js',
      working_directory: process.cwd(),
    });

    const createdTask = getSubmittedTask(result);
    expect(createdTask).toBeTruthy();
    expect(createdTask.provider).toBe('codex');
    expect(createdTask.model).toBe('gpt-5.3-codex-spark');
  });

  it('routes documentation greenfield task to Codex (Ollama cannot create files)', async () => {
    const result = await handler.handleSmartSubmitTask({
      task: 'Update the README',
      working_directory: process.cwd(),
    });

    const createdTask = getSubmittedTask(result);
    expect(createdTask).toBeTruthy();
    expect(createdTask.provider).toBe('codex');
  });

  it('routes code_gen greenfield task to Codex (Ollama cannot create files)', async () => {
    const result = await handler.handleSmartSubmitTask({
      task: 'Add a new API endpoint',
      working_directory: process.cwd(),
    });

    const createdTask = getSubmittedTask(result);
    expect(createdTask).toBeTruthy();
    expect(createdTask.provider).toBe('codex');
  });

  it('adds needs_review metadata for complex smart-routed tasks only', async () => {
    vi.spyOn(require('../db/provider/routing-core'), 'analyzeTaskForRouting').mockReturnValue({
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
    expect(getTaskMetadata(complexTask)).toMatchObject({ smart_routing: true, needs_review: true, complexity: 'complex' });

    vi.spyOn(require('../db/provider/routing-core'), 'analyzeTaskForRouting').mockReturnValue({
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
    expect(getTaskMetadata(normalTask)).toMatchObject({ smart_routing: true, complexity: 'normal' });
    expect(getTaskMetadata(normalTask)).not.toHaveProperty('needs_review');
  });

  it('adds split_advisory metadata only for complex smart-routed tasks with 3+ files', async () => {
    vi.spyOn(require('../db/provider/routing-core'), 'analyzeTaskForRouting').mockReturnValue({
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
    expect(getTaskMetadata(advisoryTask)).toMatchObject({
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
    expect(getTaskMetadata(noAdvisoryTask)).toMatchObject({ smart_routing: true, complexity: 'complex' });
    expect(getTaskMetadata(noAdvisoryTask)).not.toHaveProperty('split_advisory');
  });

  it('returns actionable workflow subscription metadata when smart submit auto-decomposes', async () => {
    vi.spyOn(require('../db/provider/routing-core'), 'analyzeTaskForRouting').mockReturnValue({
      provider: 'ollama',
      complexity: 'complex',
      reason: 'Complex C# task',
      rule: null,
      fallbackApplied: false,
    });
    vi.spyOn(hostManagement, 'decomposeTask').mockReturnValue([
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

  it.each([
    ['relative traversal', () => '../../outside.js'],
    ['encoded traversal', () => '%2e%2e%2foutside.js'],
    ['Windows traversal', () => '..\\..\\outside.ts'],
    ['absolute outside path', ({ outsideTs }) => outsideTs],
  ])('does not read out-of-root files from %s in task descriptions', async (label, buildMention) => {
    const workDir = createTempDir();
    const outsideDir = createTempDir('torque-smart-routing-outside-');
    const outsideJs = writeTempFile(outsideDir, 'outside.js', 'module.exports = 1;\n');
    const outsideTs = writeTempFile(outsideDir, 'outside.ts', 'export const outside = true;\n');
    const mention = buildMention({ outsideJs, outsideTs });
    forceOllamaRouting();
    vi.spyOn(taskManager, 'resolveFileReferences').mockReturnValue({
      resolved: [{ requested: mention, actual: mention.endsWith('.js') ? outsideJs : outsideTs }],
      unresolved: [],
    });
    const readSpy = vi.spyOn(fsPromises, 'readFile');

    const result = await handler.handleSmartSubmitTask({
      task: `Fix the issue in ${mention} for ${label}`,
      working_directory: workDir,
      context_stuff: false,
      study_context: false,
    });

    expectInvalidParamOrNoOutOfRootRead(result, readSpy, workDir);
  });

  it('counts an in-root file referenced only from the task description', async () => {
    const workDir = createTempDir();
    const inRootFile = writeTempFile(
      workDir,
      path.join('src', 'safe.ts'),
      ['export function safe() {', '  return true;', '}', ''].join('\n')
    );
    forceOllamaRouting();
    vi.spyOn(taskManager, 'resolveFileReferences').mockReturnValue({
      resolved: [{ requested: 'src/safe.ts', actual: inRootFile }],
      unresolved: [],
    });
    const readSpy = vi.spyOn(fsPromises, 'readFile');

    const result = await handler.handleSmartSubmitTask({
      task: 'Fix the issue in src/safe.ts',
      working_directory: workDir,
      context_stuff: false,
      study_context: false,
    });

    expect(result.isError).not.toBe(true);
    expect(getOutOfRootReadTargets(readSpy, workDir)).toEqual([]);
    expect(readSpy.mock.calls.map(([target]) => path.resolve(String(target)))).toContain(path.resolve(inRootFile));
    const createdTask = getSubmittedTask(result);
    expect(createdTask).toBeTruthy();
    expect(createdTask.provider).toBe('ollama');
  });
});
