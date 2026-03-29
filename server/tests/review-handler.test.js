'use strict';

// @vitest-environment node
const _sequential = true;

const reviewHandlerPath = require.resolve('../handlers/review-handler');
const containerPath = require.resolve('../container');

let currentModules = {};

const originalCacheEntries = new Map();

vi.mock('../container', () => currentModules.containerModule);
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
    taskCore: {
      getTask: vi.fn(),
      createTask: vi.fn((payload) => payload),
    },
    taskManager: {
      startTask: vi.fn(() => ({ queued: false })),
    },
    childProcessModule: {
      execFileSync: vi.fn(() => 'diff --git a/server/app.js b/server/app.js\n'),
    },
    cryptoModule: {
      randomUUID: vi.fn(() => 'review-task-123'),
    },
  };

  const modules = {
    ...defaults,
    ...overrides,
    taskCore: { ...defaults.taskCore, ...(overrides.taskCore || {}) },
    taskManager: { ...defaults.taskManager, ...(overrides.taskManager || {}) },
    childProcessModule: { ...defaults.childProcessModule, ...(overrides.childProcessModule || {}) },
    cryptoModule: { ...defaults.cryptoModule, ...(overrides.cryptoModule || {}) },
  };

  modules.containerModule = {
    defaultContainer: {
      get(name) {
        if (name === 'taskCore') {
          return modules.taskCore;
        }
        if (name === 'taskManager') {
          return modules.taskManager;
        }
        throw new Error(`Unexpected service lookup: ${name}`);
      },
    },
  };

  return modules;
}

function loadHandler(overrides = {}) {
  currentModules = createDefaultModules(overrides);

  vi.resetModules();
  vi.doMock('../container', () => currentModules.containerModule);
  vi.doMock('child_process', () => currentModules.childProcessModule);
  vi.doMock('crypto', () => currentModules.cryptoModule);

  installCjsModuleMock('../container', currentModules.containerModule);
  installCjsModuleMock('child_process', currentModules.childProcessModule);
  installCjsModuleMock('crypto', currentModules.cryptoModule);

  delete require.cache[reviewHandlerPath];
  delete require.cache[containerPath];

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
  delete require.cache[reviewHandlerPath];
  delete require.cache[containerPath];
});

describe('review-handler', () => {
  it('returns error for missing task', () => {
    const { handlers, mocks } = loadHandler({
      taskCore: {
        getTask: vi.fn(() => null),
      },
    });

    const result = handlers.handleReviewTaskOutput({ task_id: 'missing-task' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('TASK_NOT_FOUND');
    expect(result.content[0].text).toContain('Task not found: missing-task');
    expect(mocks.taskCore.createTask).not.toHaveBeenCalled();
    expect(mocks.taskManager.startTask).not.toHaveBeenCalled();
    expect(mocks.childProcessModule.execFileSync).not.toHaveBeenCalled();
  });

  it('returns error for non-completed task', () => {
    const { handlers, mocks } = loadHandler({
      taskCore: {
        getTask: vi.fn(() => ({
          id: 'source-task',
          status: 'running',
          working_directory: 'C:\\repo',
        })),
      },
    });

    const result = handlers.handleReviewTaskOutput({ task_id: 'source-task' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(result.content[0].text).toContain('Task must be completed to review');
    expect(mocks.taskCore.createTask).not.toHaveBeenCalled();
    expect(mocks.taskManager.startTask).not.toHaveBeenCalled();
    expect(mocks.childProcessModule.execFileSync).not.toHaveBeenCalled();
  });

  it('creates review task with structured prompt', () => {
    const diffOutput = 'diff --git a/server/task-manager.js b/server/task-manager.js\n+new guard\n';
    const { handlers, mocks } = loadHandler({
      taskCore: {
        getTask: vi.fn(() => ({
          id: 'source-task',
          status: 'completed',
          provider: 'ollama',
          task_description: 'Review the queue scheduler changes',
          working_directory: 'C:\\repo',
          git_before_sha: 'abc123',
        })),
      },
      childProcessModule: {
        execFileSync: vi.fn(() => diffOutput),
      },
    });

    const result = handlers.handleReviewTaskOutput({
      task_id: 'source-task',
      provider: 'deepinfra',
    });

    expect(mocks.childProcessModule.execFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', 'abc123'],
      {
        cwd: 'C:\\repo',
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );
    expect(mocks.taskCore.createTask).toHaveBeenCalledTimes(1);
    expect(mocks.taskManager.startTask).toHaveBeenCalledWith('review-task-123');

    const createdTask = mocks.taskCore.createTask.mock.calls[0][0];
    expect(createdTask.status).toBe('pending');
    expect(createdTask.provider).toBe('deepinfra');
    expect(createdTask.working_directory).toBe('C:\\repo');
    expect(createdTask.task_description).toContain('Review this code change for:');
    expect(createdTask.task_description).toContain('- Logic/correctness bugs');
    expect(createdTask.task_description).toContain('- Missing error handling');
    expect(createdTask.task_description).toContain('Task description: Review the queue scheduler changes');
    expect(createdTask.task_description).toContain(`Diff:\n${diffOutput}`);
    expect(createdTask.task_description).toContain('Respond with a JSON array of issues:');
    expect(createdTask.task_description).toContain('"category": "bug|security|performance|error_handling|test_coverage"');
    expect(createdTask.task_description).toContain('If no issues found, respond with an empty array [].');

    expect(JSON.parse(createdTask.metadata)).toEqual({
      review_task: true,
      review_of_task_id: 'source-task',
      source_task_provider: 'ollama',
      intended_provider: 'deepinfra',
      requested_provider: 'deepinfra',
      user_provider_override: true,
    });

    expect(result.review_task_id).toBe('review-task-123');
    expect(result.message).toBe('Review task submitted');
    expect(result.structuredData).toEqual({
      review_task_id: 'review-task-123',
      provider: 'deepinfra',
      message: 'Review task submitted',
    });
  });

  it('selects a different provider from the original when none is specified', () => {
    const { handlers, mocks } = loadHandler({
      taskCore: {
        getTask: vi.fn(() => ({
          id: 'source-task',
          status: 'completed',
          provider: 'codex',
          task_description: 'Review the routing changes',
          working_directory: 'C:\\repo',
        })),
      },
    });

    const result = handlers.handleReviewTaskOutput({ task_id: 'source-task' });

    expect(mocks.childProcessModule.execFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', 'HEAD~1'],
      {
        cwd: 'C:\\repo',
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );

    const createdTask = mocks.taskCore.createTask.mock.calls[0][0];
    expect(createdTask.provider).toBe('deepinfra');
    expect(JSON.parse(createdTask.metadata)).toEqual({
      review_task: true,
      review_of_task_id: 'source-task',
      source_task_provider: 'codex',
      intended_provider: 'deepinfra',
      requested_provider: null,
      user_provider_override: false,
    });
    expect(result.structuredData.provider).toBe('deepinfra');
  });
});
