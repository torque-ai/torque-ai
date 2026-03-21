'use strict';

const reviewHandlerPath = require.resolve('../handlers/review-handler');

let currentModules = {};

const originalCacheEntries = new Map();

vi.mock('../database', () => currentModules.db);
vi.mock('../task-manager', () => currentModules.taskManager);
vi.mock('child_process', () => currentModules.childProcessModule);
vi.mock('uuid', () => currentModules.uuidModule);

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
    uuidModule: {
      v4: vi.fn(() => 'review-task-123'),
    },
  };

  return {
    ...defaults,
    ...overrides,
    db: { ...defaults.db, ...(overrides.db || {}) },
    taskManager: { ...defaults.taskManager, ...(overrides.taskManager || {}) },
    childProcessModule: { ...defaults.childProcessModule, ...(overrides.childProcessModule || {}) },
    uuidModule: { ...defaults.uuidModule, ...(overrides.uuidModule || {}) },
  };
}

function loadHandler(overrides = {}) {
  currentModules = createDefaultModules(overrides);

  vi.resetModules();
  vi.doMock('../database', () => currentModules.db);
  vi.doMock('../task-manager', () => currentModules.taskManager);
  vi.doMock('child_process', () => currentModules.childProcessModule);
  vi.doMock('uuid', () => currentModules.uuidModule);

  installCjsModuleMock('../database', currentModules.db);
  installCjsModuleMock('../task-manager', currentModules.taskManager);
  installCjsModuleMock('child_process', currentModules.childProcessModule);
  installCjsModuleMock('uuid', currentModules.uuidModule);

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
    expect(mocks.db.createTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'review-task-123',
      status: 'pending',
      working_directory: 'C:\\repo',
      timeout_minutes: 30,
      auto_approve: false,
      priority: 0,
      provider: null,
    }));

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
    expect(mocks.taskManager.startTask).toHaveBeenCalledWith('review-task-123');
    expect(result).toEqual({
      review: 'review-task-123',
      issues_found: null,
      summary: 'Review task review-task-123 started for source task source-task.',
    });
  });
});
