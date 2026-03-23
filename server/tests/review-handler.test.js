'use strict';

// This test uses deep CJS module cache manipulation that is incompatible
// with vitest parallel forks. Mark as sequential to prevent mock bleed.
// @vitest-environment node
const _sequential = true; // vitest pool-forks uses fileParallelism; this file needs isolation

const reviewHandlerPath = require.resolve('../handlers/review-handler');

let currentModules = {};

const originalCacheEntries = new Map();

vi.mock('../db/task-core', () => currentModules.db);
vi.mock('../task-manager', () => currentModules.taskManager);
vi.mock('child_process', () => currentModules.childProcessModule);
vi.mock('crypto', () => currentModules.cryptoModule);

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  if (!originalCacheEntries.has(resolved)) {
    originalCacheEntries.set(resolved, require.cache[resolved]);
  }
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function restoreMockedModules() {
  for (const [resolved, originalEntry] of originalCacheEntries.entries()) {
    if (originalEntry) {
      require.cache[resolved] = originalEntry;
    } else {
      delete require.cache[resolved];
    }
  }
  originalCacheEntries.clear();
}

function createDefaultModules(overrides = {}) {
  const defaults = {
    db: {
      getTask: vi.fn(),
      createTask: vi.fn((payload) => payload),
    },
    taskManager: {
      startTask: vi.fn(() => ({ queued: false })),
    },
    childProcessModule: {
      execFileSync: vi.fn(() => Buffer.from(' server/app.js | 4 ++--\n')),
    },
    cryptoModule: {
      randomUUID: vi.fn(() => 'review-task-123'),
    },
  };

  return {
    ...defaults,
    ...overrides,
    db: { ...defaults.db, ...(overrides.db || {}) },
    taskManager: { ...defaults.taskManager, ...(overrides.taskManager || {}) },
    childProcessModule: { ...defaults.childProcessModule, ...(overrides.childProcessModule || {}) },
    cryptoModule: { ...defaults.cryptoModule, ...(overrides.cryptoModule || {}) },
  };
}

function loadHandler(overrides = {}) {
  currentModules = createDefaultModules(overrides);

  vi.resetModules();
  vi.doMock('../db/task-core', () => currentModules.db);
  vi.doMock('../task-manager', () => currentModules.taskManager);
  vi.doMock('child_process', () => currentModules.childProcessModule);
  vi.doMock('crypto', () => currentModules.cryptoModule);

  installCjsModuleMock('../db/task-core', currentModules.db);
  installCjsModuleMock('../task-manager', currentModules.taskManager);
  installCjsModuleMock('child_process', currentModules.childProcessModule);
  installCjsModuleMock('crypto', currentModules.cryptoModule);

  delete require.cache[reviewHandlerPath];

  return {
    handlers: require('../handlers/review-handler'),
    mocks: currentModules,
  };
}

afterEach(() => {
  currentModules = {};
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
  restoreMockedModules();
});

describe('review-handler', () => {
  it('builds review prompt with diff and description', () => {
    const { handlers } = loadHandler();

    const prompt = handlers.formatReviewPrompt(
      'Implement structured review submission',
      ' server/handlers/review-handler.js | 24 ++++++++++++++++++++++++',
    );

    expect(prompt).toContain('Review the following code changes for:');
    expect(prompt).toContain('1. Logic/correctness errors');
    expect(prompt).toContain('Task description: Implement structured review submission');
    expect(prompt).toContain('Changes:\n server/handlers/review-handler.js | 24 ++++++++++++++++++++++++');
    expect(prompt).toContain('Output a markdown table with columns: File, Line, Issue, Severity (critical/warning/info), Suggestion');
  });

  it('truncates large diffs to 5000 chars', () => {
    const { handlers } = loadHandler();
    const largeDiff = 'x'.repeat(6000);

    const prompt = handlers.formatReviewPrompt('Large diff review', largeDiff);

    expect(prompt).toContain('x'.repeat(5000));
    expect(prompt).not.toContain('x'.repeat(5001));
    expect(prompt).toContain('[diff truncated to 5000 chars]');
  });

  it('handles missing task gracefully', () => {
    const { handlers, mocks } = loadHandler({
      db: {
        getTask: vi.fn(() => null),
      },
    });

    const result = handlers.handleReviewTaskOutput({
      task_id: 'missing-task',
      working_directory: 'C:\\repo',
    });

    expect(result).toEqual({
      review: null,
      issues_found: null,
      summary: 'Task not found: missing-task',
    });
    expect(mocks.db.createTask).not.toHaveBeenCalled();
    expect(mocks.taskManager.startTask).not.toHaveBeenCalled();
    expect(mocks.childProcessModule.execFileSync).not.toHaveBeenCalled();
  });

  it('submits review as a new task', () => {
    const { handlers, mocks } = loadHandler({
      db: {
        getTask: vi.fn(() => ({
          id: 'source-task',
          task_description: 'Review the queue scheduler changes',
        })),
      },
      childProcessModule: {
        execFileSync: vi.fn(() => Buffer.from(' server/task-manager.js | 6 ++++--\n')),
      },
    });

    const result = handlers.handleReviewTaskOutput({
      task_id: 'source-task',
      provider: 'deepinfra',
      working_directory: 'C:\\repo',
    });

    expect(mocks.childProcessModule.execFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', 'HEAD~1'],
      { cwd: 'C:\\repo' },
    );
    expect(mocks.db.createTask).toHaveBeenCalledTimes(1);
    const createdPayload = mocks.db.createTask.mock.calls[0][0];
    expect(createdPayload.status).toBe('pending');
    expect(createdPayload.working_directory).toBe('C:\\repo');

    const createdTask = mocks.db.createTask.mock.calls[0][0];
    const metadata = JSON.parse(createdTask.metadata);
    expect(createdTask.task_description).toContain('Task description: Review the queue scheduler changes');
    expect(createdTask.task_description).toContain('server/task-manager.js | 6 ++++--');
    expect(metadata).toEqual({
      intended_provider: 'deepinfra',
      user_provider_override: true,
      requested_provider: 'deepinfra',
      review_task: true,
      review_of_task_id: 'source-task',
    });
    // startTask called with the generated UUID
    expect(mocks.taskManager.startTask).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      review: expect.any(String),
      issues_found: null,
      summary: expect.stringContaining('started for source task source-task'),
    });
  });
});
