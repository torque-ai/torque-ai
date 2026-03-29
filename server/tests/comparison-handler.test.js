'use strict';

const comparisonHandlerPath = require.resolve('../handlers/comparison-handler');
const containerPath = require.resolve('../container');

let currentTaskCore = null;
let currentTaskManager = null;

vi.mock('../container', () => ({
  defaultContainer: {
    get(name) {
      if (name === 'taskCore') {
        return currentTaskCore;
      }
      if (name === 'taskManager') {
        return currentTaskManager;
      }
      throw new Error(`Unexpected service lookup: ${name}`);
    },
  },
}));

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function createDbMock() {
  return {
    createTask: vi.fn(),
    getTask: vi.fn(),
  };
}

function createTaskManagerMock() {
  return {
    startTask: vi.fn(),
  };
}

function loadHandlers() {
  currentTaskCore = createDbMock();
  currentTaskManager = createTaskManagerMock();
  const containerModule = {
    defaultContainer: {
      get(name) {
        if (name === 'taskCore') {
          return currentTaskCore;
        }
        if (name === 'taskManager') {
          return currentTaskManager;
        }
        throw new Error(`Unexpected service lookup: ${name}`);
      },
    },
  };

  vi.resetModules();
  vi.doMock('../container', () => containerModule);
  installCjsModuleMock('../container', containerModule);
  delete require.cache[comparisonHandlerPath];
  delete require.cache[containerPath];

  return {
    handlers: require('../handlers/comparison-handler'),
    taskCore: currentTaskCore,
    taskManager: currentTaskManager,
  };
}

function createTaskStore(taskCore) {
  const tasks = new Map();

  taskCore.createTask.mockImplementation((task) => {
    const stored = { ...task };
    tasks.set(task.id, stored);
    return stored;
  });

  return tasks;
}

function withImmediateCompletion(taskCore, tasks, taskOverrides = {}) {
  taskCore.getTask.mockImplementation((taskId) => {
    const task = tasks.get(taskId);
    if (!task) {
      return null;
    }

    const perProvider = taskOverrides[task.provider] || {};
    return {
      ...task,
      status: 'completed',
      output: `${task.provider} output`,
      exit_code: 0,
      started_at: '2026-03-21T00:00:00.000Z',
      completed_at: '2026-03-21T00:00:01.000Z',
      ...perProvider,
    };
  });
}

describe('comparison-handler', () => {
  let handlers;
  let taskCore;
  let taskManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T00:00:00.000Z'));
    ({ handlers, taskCore, taskManager } = loadHandlers());
  });

  afterEach(() => {
    currentTaskCore = null;
    currentTaskManager = null;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    delete require.cache[comparisonHandlerPath];
    delete require.cache[containerPath];
  });

  it('creates tasks for each provider', async () => {
    const tasks = createTaskStore(taskCore);
    withImmediateCompletion(taskCore, tasks);

    await handlers.handleCompareProviders({
      prompt: 'Compare this implementation',
      providers: ['codex', 'deepinfra', 'anthropic'],
      working_directory: process.cwd(),
    });

    expect(taskCore.createTask).toHaveBeenCalledTimes(3);
    expect(taskManager.startTask).toHaveBeenCalledTimes(3);
    expect(taskCore.createTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      status: 'queued',
      task_description: 'Compare this implementation',
      provider: 'codex',
      working_directory: process.cwd(),
      timeout_minutes: 5,
    }));
    expect(taskCore.createTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'queued',
      task_description: 'Compare this implementation',
      provider: 'deepinfra',
      working_directory: process.cwd(),
      timeout_minutes: 5,
    }));
    expect(taskCore.createTask).toHaveBeenNthCalledWith(3, expect.objectContaining({
      status: 'queued',
      task_description: 'Compare this implementation',
      provider: 'anthropic',
      working_directory: process.cwd(),
      timeout_minutes: 5,
    }));

    const createdTaskIds = taskCore.createTask.mock.calls.map(([task]) => task.id);
    expect(taskManager.startTask.mock.calls.map(([taskId]) => taskId)).toEqual(createdTaskIds);
  });

  it('returns comparison results with correct structure', async () => {
    const tasks = createTaskStore(taskCore);
    const pollCounts = new Map();
    const baseTime = Date.parse('2026-03-21T00:00:00.000Z');
    const longOutput = 'A'.repeat(600);

    taskCore.getTask.mockImplementation((taskId) => {
      const task = tasks.get(taskId);
      if (!task) {
        return null;
      }

      const count = (pollCounts.get(taskId) || 0) + 1;
      pollCounts.set(taskId, count);

      if (count === 1) {
        return {
          ...task,
          status: 'queued',
        };
      }

      const completedAt = task.provider === 'codex'
        ? new Date(baseTime + 5200).toISOString()
        : new Date(baseTime + 8100).toISOString();

      return {
        ...task,
        status: 'completed',
        output: task.provider === 'codex' ? longOutput : `${task.provider} completed output`,
        exit_code: 0,
        started_at: '2026-03-21T00:00:00.000Z',
        completed_at: completedAt,
      };
    });

    const comparisonPromise = handlers.handleCompareProviders({
      prompt: 'Compare providers',
      providers: ['codex', 'claude-cli'],
      working_directory: process.cwd(),
    });

    await vi.advanceTimersByTimeAsync(5000);
    const result = await comparisonPromise;

    expect(result.results).toEqual([
      expect.objectContaining({
        provider: 'codex',
        output: longOutput.slice(0, 500),
        durationMs: 5200,
        exitCode: 0,
        success: true,
      }),
      expect.objectContaining({
        provider: 'claude-cli',
        output: 'claude-cli completed output',
        durationMs: 8100,
        exitCode: 0,
        success: true,
      }),
    ]);
    expect(result.summary).toEqual(expect.objectContaining({
      fastestProvider: 'codex',
      mostOutputProvider: 'codex',
      allSucceeded: true,
      allFailed: false,
      timedOut: false,
    }));
    expect(result.structuredData).toEqual({
      results: result.results,
      summary: result.summary,
    });
    expect(result.content[0].text).toContain('| Provider | Duration | Exit Code | Success | Output |');
    expect(result.content[0].text).toContain('| codex | 5.2s | 0 | Yes |');
  });

  it('handles provider that times out', async () => {
    const tasks = createTaskStore(taskCore);

    taskCore.getTask.mockImplementation((taskId) => {
      const task = tasks.get(taskId);
      if (!task) {
        return null;
      }

      return {
        ...task,
        status: 'running',
        partial_output: `${task.provider} still running`,
      };
    });

    const comparisonPromise = handlers.handleCompareProviders({
      prompt: 'Compare providers',
      providers: ['codex'],
      working_directory: process.cwd(),
      timeout_minutes: 0.001,
    });

    await vi.advanceTimersByTimeAsync(100);
    const result = await comparisonPromise;

    expect(result.summary.timedOut).toBe(true);
    expect(result.summary.allSucceeded).toBe(false);
    expect(result.summary.allFailed).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({
        provider: 'codex',
        output: 'codex still running',
        exitCode: null,
        success: false,
      }),
    ]);
    expect(result.content[0].text).toContain('Timed out: Yes');
  });

  it('formatComparisonTable produces valid markdown', () => {
    const table = handlers.formatComparisonTable([
      {
        provider: 'codex',
        durationMs: 5200,
        exitCode: 0,
        output: 'hello',
        success: true,
      },
      {
        provider: 'claude-cli',
        durationMs: null,
        exitCode: 1,
        output: 'abc',
        success: false,
      },
    ]);

    expect(table).toBe(
      '| Provider | Duration | Exit Code | Success | Output |\n'
      + '|----------|----------|-----------|---------|--------|\n'
      + '| codex | 5.2s | 0 | Yes | hello |\n'
      + '| claude-cli | - | 1 | No | abc |',
    );
  });

  it('summary identifies fastest provider', async () => {
    const tasks = createTaskStore(taskCore);

    withImmediateCompletion(taskCore, tasks, {
      codex: {
        output: 'short',
        completed_at: '2026-03-21T00:00:01.500Z',
      },
      deepinfra: {
        output: 'a much longer output payload',
        completed_at: '2026-03-21T00:00:03.000Z',
      },
    });

    const result = await handlers.handleCompareProviders({
      prompt: 'Compare speed',
      providers: ['codex', 'deepinfra'],
      working_directory: process.cwd(),
    });

    expect(result.summary).toEqual(expect.objectContaining({
      fastestProvider: 'codex',
      fastestDurationMs: 1500,
      mostOutputProvider: 'deepinfra',
      allSucceeded: true,
    }));
  });
});
