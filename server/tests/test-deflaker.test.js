'use strict';

/**
 * Unit tests for the test-deflaker CRUD module and its integration with
 * auto-verify-retry's flaky-classification pipeline.
 *
 * Describe block 1: exercises createTestDeflaker directly against a real
 * better-sqlite3 instance (via setupTestDbOnly + rawDb).
 *
 * Describe block 2: exercises handleAutoVerifyRetry's deflaker integration
 * end-to-end, verifying that verify_signal_tag values reflect the flaky vs
 * genuine classification.
 */

const crypto = require('crypto');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const { createTestDeflaker } = require('../db/test-deflaker');

// ── auto-verify-retry integration helpers ──────────────────────────────────
// The auto-verify-retry module captures deps at require-time via logger and
// test-runner-registry.  We follow the same mock-injection pattern as the
// existing auto-verify-retry.test.js: install mocks into require.cache
// before loading the module, then wire the db via init().

const MODULE_PATH = '../validation/auto-verify-retry';
const MODULE_RESOLVED = require.resolve(MODULE_PATH);
const LOGGER_MODULE_RESOLVED = require.resolve('../logger');
const TEST_RUNNER_REGISTRY_RESOLVED = require.resolve('../test-runner-registry');
const HOST_MONITORING_RESOLVED = require.resolve('../utils/host-monitoring');
const contextEnrichment = require('../utils/context-enrichment');

const ORIGINAL_RANDOM_UUID = crypto.randomUUID;
const ORIGINAL_BUILD_PROMPT = contextEnrichment.buildErrorFeedbackPrompt;

let mockRunVerifyCommand;

function restorePatchedDeps() {
  crypto.randomUUID = ORIGINAL_RANDOM_UUID;
  contextEnrichment.buildErrorFeedbackPrompt = ORIGINAL_BUILD_PROMPT;
  delete require.cache[MODULE_RESOLVED];
  delete require.cache[LOGGER_MODULE_RESOLVED];
  delete require.cache[TEST_RUNNER_REGISTRY_RESOLVED];
  delete require.cache[HOST_MONITORING_RESOLVED];
}

function installMocks() {
  // Logger
  const mockLoggerChild = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };
  require.cache[LOGGER_MODULE_RESOLVED] = {
    id: LOGGER_MODULE_RESOLVED,
    filename: LOGGER_MODULE_RESOLVED,
    loaded: true,
    exports: { child: vi.fn(() => mockLoggerChild) },
  };

  // Test runner registry
  mockRunVerifyCommand = vi.fn();
  require.cache[TEST_RUNNER_REGISTRY_RESOLVED] = {
    id: TEST_RUNNER_REGISTRY_RESOLVED,
    filename: TEST_RUNNER_REGISTRY_RESOLVED,
    loaded: true,
    exports: {
      createTestRunnerRegistry: vi.fn(() => ({
        runVerifyCommand: mockRunVerifyCommand,
        runRemoteOrLocal: vi.fn(),
        register: vi.fn(),
        unregister: vi.fn(),
      })),
    },
  };

  // Host monitoring
  require.cache[HOST_MONITORING_RESOLVED] = {
    id: HOST_MONITORING_RESOLVED,
    filename: HOST_MONITORING_RESOLVED,
    loaded: true,
    exports: { hostActivityCache: new Map() },
  };

  // Context enrichment prompt builder
  contextEnrichment.buildErrorFeedbackPrompt = vi.fn(
    (desc, output, errors) => `${desc}\n\n[errors]\n${errors}`,
  );
  crypto.randomUUID = vi.fn(() => 'fix-task-uuid');
}

// ── Describe block 1: createTestDeflaker CRUD ──────────────────────────────

describe('createTestDeflaker CRUD', () => {
  let handle; // raw better-sqlite3 instance

  beforeAll(() => {
    setupTestDbOnly('test-deflaker-crud');
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    handle = rawDb();
    // Clear test_outcomes between tests for isolation
    handle.prepare('DELETE FROM test_outcomes').run();
  });

  it('recordOutcomes inserts rows for passed and failed tests', () => {
    const deflaker = createTestDeflaker({ db: handle });
    deflaker.recordOutcomes({
      projectPath: '/test',
      commitHash: 'abc',
      passed: ['test-a'],
      failed: ['test-b'],
    });

    const rows = handle.prepare(
      'SELECT * FROM test_outcomes WHERE project_path = ? ORDER BY test_name',
    ).all('/test');

    expect(rows).toHaveLength(2);
    expect(rows[0].test_name).toBe('test-a');
    expect(rows[0].result).toBe('pass');
    expect(rows[0].commit_hash).toBe('abc');
    expect(rows[1].test_name).toBe('test-b');
    expect(rows[1].result).toBe('fail');
    expect(rows[1].commit_hash).toBe('abc');
  });

  it('classifyFailures identifies flaky tests', () => {
    const deflaker = createTestDeflaker({ db: handle });

    // Insert 5 alternating outcomes: pass, fail, pass, fail, pass
    for (let i = 0; i < 5; i++) {
      handle.prepare(
        'INSERT INTO test_outcomes (project_path, test_name, result, commit_hash, recorded_at) VALUES (?, ?, ?, ?, ?)',
      ).run('/test', 'test-x', i % 2 === 0 ? 'pass' : 'fail', null, new Date(Date.now() + i * 1000).toISOString());
    }

    const classified = deflaker.classifyFailures({
      projectPath: '/test',
      testNames: ['test-x'],
    });

    expect(classified.flaky).toContain('test-x');
    expect(classified.genuine).not.toContain('test-x');
  });

  it('classifyFailures identifies genuine failures', () => {
    const deflaker = createTestDeflaker({ db: handle });

    // Insert 5 all-fail outcomes
    for (let i = 0; i < 5; i++) {
      handle.prepare(
        'INSERT INTO test_outcomes (project_path, test_name, result, commit_hash, recorded_at) VALUES (?, ?, ?, ?, ?)',
      ).run('/test', 'test-y', 'fail', null, new Date(Date.now() + i * 1000).toISOString());
    }

    const classified = deflaker.classifyFailures({
      projectPath: '/test',
      testNames: ['test-y'],
    });

    expect(classified.genuine).toContain('test-y');
    expect(classified.flaky).not.toContain('test-y');
  });

  it('getOutcomeHistory returns ordered results', () => {
    const deflaker = createTestDeflaker({ db: handle });

    // Insert 3 outcomes with different timestamps
    const timestamps = [
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    ];
    for (const ts of timestamps) {
      handle.prepare(
        'INSERT INTO test_outcomes (project_path, test_name, result, commit_hash, recorded_at) VALUES (?, ?, ?, ?, ?)',
      ).run('/test', 'test-z', 'pass', null, ts);
    }

    const history = deflaker.getOutcomeHistory({
      projectPath: '/test',
      testName: 'test-z',
      limit: 2,
    });

    expect(history).toHaveLength(2);
    // Newest first (DESC order)
    expect(history[0].recorded_at).toBe('2026-01-03T00:00:00.000Z');
    expect(history[1].recorded_at).toBe('2026-01-02T00:00:00.000Z');
  });
});

// ── Describe block 2: auto-verify-retry flaky integration ──────────────────

describe('auto-verify-retry flaky integration', () => {
  let handle;  // raw better-sqlite3 instance

  beforeAll(() => {
    setupTestDbOnly('test-deflaker-integration');
  });

  afterAll(() => {
    restorePatchedDeps();
    teardownTestDb();
  });

  beforeEach(() => {
    handle = rawDb();
    handle.prepare('DELETE FROM test_outcomes').run();
    require('./helpers/database-facade');
  });

  afterEach(() => {
    restorePatchedDeps();
    vi.clearAllMocks();
  });

  /**
   * Build a combined db object that:
   * - delegates prepare/transaction to the raw better-sqlite3 handle (for deflaker)
   * - provides the facade methods that handleAutoVerifyRetry expects
   */
  function buildIntegrationDb(overrides = {}) {
    const project = overrides.project || 'test-project';
    const config = overrides.config || { verify_command: 'npx vitest run' };
    const tasks = new Map();
    const createdTasks = [];

    return {
      // Raw SQLite methods for createTestDeflaker
      prepare: handle.prepare.bind(handle),
      transaction: handle.transaction.bind(handle),

      // Facade methods for handleAutoVerifyRetry
      getProjectFromPath: vi.fn(() => project),
      getProjectConfig: vi.fn(() => config),
      getTask: vi.fn((id) => tasks.get(id) || { id, tags: [], output: '' }),
      updateTask: vi.fn((id, updates) => {
        const existing = tasks.get(id) || { id, tags: [], output: '' };
        tasks.set(id, { ...existing, ...updates });
      }),
      updateTaskStatus: vi.fn(),
      createTask: vi.fn((task) => { createdTasks.push(task); }),
      getConfig: vi.fn(() => null),
      _setTask: (id, data) => tasks.set(id, data),
      _getCreatedTasks: () => createdTasks.slice(),
    };
  }

  function loadWithIntegrationDb(integrationDb) {
    installMocks();
    delete require.cache[MODULE_RESOLVED];
    const mod = require(MODULE_PATH);
    mod.init({
      db: integrationDb,
      startTask: vi.fn(),
      processQueue: vi.fn(),
    });
    return mod;
  }

  function makeTask(overrides = {}) {
    return {
      id: 'task-1',
      task_description: 'Fix compile errors',
      working_directory: 'C:/repo/project',
      provider: 'codex',
      model: 'gpt-5-codex',
      retry_count: 0,
      max_retries: 1,
      priority: 4,
      timeout_minutes: 30,
      ...overrides,
    };
  }

  function makeCtx(overrides = {}) {
    return {
      taskId: overrides.taskId || 'task-1',
      status: 'completed',
      task: overrides.task || makeTask(),
      output: 'Prior output',
      errorOutput: '',
      earlyExit: false,
      filesModified: ['src/foo.ts'],
      ...overrides,
    };
  }

  /**
   * Seed alternating pass/fail outcomes (flaky pattern) for a test name.
   */
  function seedFlakyHistory(testName, count = 5, projectPath = '/test') {
    for (let i = 0; i < count; i++) {
      handle.prepare(
        'INSERT INTO test_outcomes (project_path, test_name, result, commit_hash, recorded_at) VALUES (?, ?, ?, ?, ?)',
      ).run(projectPath, testName, i % 2 === 0 ? 'pass' : 'fail', null, new Date(Date.now() - (count - i) * 1000).toISOString());
    }
  }

  /**
   * Seed all-fail outcomes (genuine failure pattern) for a test name.
   */
  function seedGenuineHistory(testName, count = 5, projectPath = '/test') {
    for (let i = 0; i < count; i++) {
      handle.prepare(
        'INSERT INTO test_outcomes (project_path, test_name, result, commit_hash, recorded_at) VALUES (?, ?, ?, ?, ?)',
      ).run(projectPath, testName, 'fail', null, new Date(Date.now() - (count - i) * 1000).toISOString());
    }
  }

  it('verify_signal_tag is tests:flaky:N when all failures are known flaky', async () => {
    const projectPath = 'C:/repo/project';
    seedFlakyHistory('test-a', 5, projectPath);

    const integrationDb = buildIntegrationDb({
      config: { verify_command: 'npx vitest run', project_path: projectPath },
    });
    // Pre-populate the task so getTask returns it with tags
    integrationDb._setTask('task-1', { id: 'task-1', tags: [], output: '' });

    const mod = loadWithIntegrationDb(integrationDb);

    // Simulate verify failure with vitest-style output showing test-a failed
    mockRunVerifyCommand.mockResolvedValue({
      success: false,
      output: '  \u00d7 test-a 12ms\n',
      error: 'src/foo.ts(10,5): error TS2339: Property does not exist',
      exitCode: 1,
      durationMs: 200,
      remote: false,
    });

    const ctx = makeCtx();
    await mod.handleAutoVerifyRetry(ctx);

    // The updateTask call that sets the verify tag
    const tagCalls = integrationDb.updateTask.mock.calls;
    const tagUpdate = tagCalls.find(
      (call) => call[1] && call[1].tags && call[1].tags.some((t) => t.startsWith('tests:')),
    );
    expect(tagUpdate).toBeDefined();
    const appliedTag = tagUpdate[1].tags.find((t) => t.startsWith('tests:'));
    expect(appliedTag).toMatch(/^tests:flaky:\d+$/);
  });

  it('verify_signal_tag is tests:fail:N when failures are genuine', async () => {
    const projectPath = 'C:/repo/project';
    seedGenuineHistory('test-b', 5, projectPath);

    const integrationDb = buildIntegrationDb({
      config: { verify_command: 'npx vitest run', project_path: projectPath },
    });
    integrationDb._setTask('task-1', { id: 'task-1', tags: [], output: '' });

    const mod = loadWithIntegrationDb(integrationDb);

    mockRunVerifyCommand.mockResolvedValue({
      success: false,
      output: '  \u00d7 test-b 15ms\n',
      error: 'src/foo.ts(10,5): error TS2339: Property does not exist',
      exitCode: 1,
      durationMs: 200,
      remote: false,
    });

    const ctx = makeCtx();
    await mod.handleAutoVerifyRetry(ctx);

    const tagCalls = integrationDb.updateTask.mock.calls;
    const tagUpdate = tagCalls.find(
      (call) => call[1] && call[1].tags && call[1].tags.some((t) => t.startsWith('tests:')),
    );
    expect(tagUpdate).toBeDefined();
    const appliedTag = tagUpdate[1].tags.find((t) => t.startsWith('tests:'));
    expect(appliedTag).toMatch(/^tests:fail:\d+$/);
    // Must NOT be flaky
    expect(appliedTag).not.toMatch(/^tests:flaky:/);
  });

  it('verify_signal_tag is tests:fail:M when mix of flaky and genuine', async () => {
    const projectPath = 'C:/repo/project';
    // test-c is flaky, test-d is genuine
    seedFlakyHistory('test-c', 5, projectPath);
    seedGenuineHistory('test-d', 5, projectPath);

    const integrationDb = buildIntegrationDb({
      config: { verify_command: 'npx vitest run', project_path: projectPath },
    });
    integrationDb._setTask('task-1', { id: 'task-1', tags: [], output: '' });

    const mod = loadWithIntegrationDb(integrationDb);

    // Both test-c and test-d fail in this verify run
    mockRunVerifyCommand.mockResolvedValue({
      success: false,
      output: '  \u00d7 test-c 10ms\n  \u00d7 test-d 11ms\n',
      error: 'src/foo.ts(10,5): error TS2339: Property does not exist',
      exitCode: 1,
      durationMs: 200,
      remote: false,
    });

    const ctx = makeCtx();
    await mod.handleAutoVerifyRetry(ctx);

    const tagCalls = integrationDb.updateTask.mock.calls;
    const tagUpdate = tagCalls.find(
      (call) => call[1] && call[1].tags && call[1].tags.some((t) => t.startsWith('tests:')),
    );
    expect(tagUpdate).toBeDefined();
    const appliedTag = tagUpdate[1].tags.find((t) => t.startsWith('tests:'));
    // Only test-d is genuine, so tests:fail:1
    expect(appliedTag).toBe('tests:fail:1');
  });

  it('recording failure does not break pipeline on DB error', async () => {
    // Use a mock db that throws on prepare() calls to simulate DB errors
    // for the deflaker, while keeping facade methods functional.
    const project = 'test-project';
    const brokenDb = {
      prepare: vi.fn(() => { throw new Error('DB closed'); }),
      transaction: vi.fn(() => { throw new Error('DB closed'); }),
      getProjectFromPath: vi.fn(() => project),
      getProjectConfig: vi.fn(() => ({ verify_command: 'npx vitest run' })),
      getTask: vi.fn((id) => ({ id, tags: [], output: '' })),
      updateTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      createTask: vi.fn(),
      getConfig: vi.fn(() => null),
    };

    installMocks();
    delete require.cache[MODULE_RESOLVED];
    const mod = require(MODULE_PATH);
    mod.init({
      db: brokenDb,
      startTask: vi.fn(),
      processQueue: vi.fn(),
    });

    // Verify fails with test failures — deflaker will try to record & classify
    mockRunVerifyCommand.mockResolvedValue({
      success: false,
      output: '  \u00d7 test-e 10ms\n',
      error: 'src/foo.ts(10,5): error TS2339: Property does not exist',
      exitCode: 1,
      durationMs: 200,
      remote: false,
    });

    const ctx = makeCtx();
    // Must not throw — the try/catch in auto-verify-retry handles it
    await expect(mod.handleAutoVerifyRetry(ctx)).resolves.not.toThrow();

    // The verify_signal_tag should still be set (fallback tests:fail:N from
    // error-line counting since classification failed).
    const tagCalls = brokenDb.updateTask.mock.calls;
    const tagUpdate = tagCalls.find(
      (call) => call[1] && call[1].tags && call[1].tags.some((t) => t.startsWith('tests:')),
    );
    expect(tagUpdate).toBeDefined();
    const appliedTag = tagUpdate[1].tags.find((t) => t.startsWith('tests:'));
    expect(appliedTag).toMatch(/^tests:fail:\d+$/);
  });
});
