'use strict';

const comparisonHandlerPath = require.resolve('../handlers/comparison-handler');

let currentDb = null;

vi.mock('../database', () => currentDb);

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

function loadHandlers() {
  currentDb = createDbMock();

  vi.resetModules();
  vi.doMock('../database', () => currentDb);
  installCjsModuleMock('../database', currentDb);
  delete require.cache[comparisonHandlerPath];

  return {
    handlers: require('../handlers/comparison-handler'),
    db: currentDb,
  };
}

function createTaskStore(db) {
  const tasks = new Map();

  db.createTask.mockImplementation((task) => {
    const stored = { ...task };
    tasks.set(task.id, stored);
    return stored;
  });

  return tasks;
}

function withImmediateCompletion(db, tasks, taskOverrides = {}) {
  db.getTask.mockImplementation((taskId) => {
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
  let db;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T00:00:00.000Z'));
    ({ handlers, db } = loadHandlers());
  });

  afterEach(() => {
    currentDb = null;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    delete require.cache[comparisonHandlerPath];
  });

  it('creates tasks for each provider', async () => {
    const tasks = createTaskStore(db);
    withImmediateCompletion(db, tasks);

    await handlers.handleCompareProviders({
      prompt: 'Compare this implementation',
      providers: ['codex', 'deepinfra', 'anthropic'],
      working_directory: process.cwd(),
    });

    expect(db.createTask).toHaveBeenCalledTimes(3);
    expect(db.createTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      status: 'queued',
      task_description: 'Compare this implementation',
      provider: 'codex',
      working_directory: process.cwd(),
      timeout_minutes: 5,
    }));
    expect(db.createTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'queued',
      task_description: 'Compare this implementation',
      provider: 'deepinfra',
      working_directory: process.cwd(),
      timeout_minutes: 5,
    }));
    expect(db.createTask).toHaveBeenNthCalledWith(3, expect.objectContaining({
      status: 'queued',
      task_description: 'Compare this implementation',
      provider: 'anthropic',
      working_directory: process.cwd(),
      timeout_minutes: 5,
    }));
  });

  it('collects results after completion', async () => {
    const tasks = createTaskStore(db);
    const pollCounts = new Map();
    const baseTime = Date.parse('2026-03-21T00:00:00.000Z');

    db.getTask.mockImplementation((taskId) => {
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
        output: `${task.provider} completed output`,
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

    await vi.advanceTimersByTimeAsync(2000);
    const result = await comparisonPromise;

    expect(result.results).toEqual([
      {
        provider: 'codex',
        output: 'codex completed output',
        durationMs: 5200,
        exitCode: 0,
        success: true,
      },
      {
        provider: 'claude-cli',
        output: 'claude-cli completed output',
        durationMs: 8100,
        exitCode: 0,
        success: true,
      },
    ]);
    expect(result.summary).toEqual(expect.objectContaining({
      fastestProvider: 'codex',
      mostOutputProvider: 'claude-cli',
      allSucceeded: true,
      allFailed: false,
      timedOut: false,
    }));
  });

  it('handles timeout', async () => {
    const tasks = createTaskStore(db);

    db.getTask.mockImplementation((taskId) => {
      const task = tasks.get(taskId);
      if (!task) {
        return null;
      }

      return {
        ...task,
        status: 'queued',
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
        exitCode: null,
        success: false,
      }),
    ]);
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
      '| Provider | Duration | Exit Code | Output Length | Status |\n'
      + '|----------|----------|-----------|---------------|--------|\n'
      + '| codex | 5.2s | 0 | 5 chars | Success |\n'
      + '| claude-cli | - | 1 | 3 chars | Failed |',
    );
  });

  it('summary identifies fastest provider', async () => {
    const tasks = createTaskStore(db);

    withImmediateCompletion(db, tasks, {
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
