'use strict';
/* global describe, it, expect, afterEach, vi */

const createStallDetectionHandler = require('../execution/stall-detection');

function createHarness(options = {}) {
  const config = {
    large_model_threshold_b: 30,
    max_large_models_per_host: 1,
    ...options.config,
  };
  const sizes = options.sizes || {};

  const deps = {
    db: {
      getRunningTasksForHost: options.dbError
        ? vi.fn(() => { throw options.dbError; })
        : vi.fn(() => (options.hostTasks || []).slice()),
    },
    safeConfigInt: vi.fn((key, defaultValue) => (
      Object.prototype.hasOwnProperty.call(config, key) ? config[key] : defaultValue
    )),
    parseModelSizeB: vi.fn((modelName) => (
      Object.prototype.hasOwnProperty.call(sizes, modelName) ? sizes[modelName] : 0
    )),
    logger: {
      debug: vi.fn(),
    },
    activityMonitoring: {
      checkFilesystemActivity: vi.fn(() => options.activityResult),
    },
    orphanCleanupModule: {
      checkStalledTasks: vi.fn(() => options.stalledResult),
    },
    fallbackRetryModule: {
      tryStallRecovery: vi.fn(() => options.recoveryResult),
    },
  };

  return {
    handler: createStallDetectionHandler(deps),
    deps,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('execution/stall-detection', () => {
  it('creates a handler with the expected helper methods', () => {
    const { handler } = createHarness();

    expect(handler).toEqual({
      isLargeModelBlockedOnHost: expect.any(Function),
      checkFilesystemActivity: expect.any(Function),
      checkStalledTasks: expect.any(Function),
      tryStallRecovery: expect.any(Function),
    });
  });

  it('returns not blocked for models below the large-model threshold', () => {
    const { handler, deps } = createHarness({
      sizes: {
        'qwen2.5-coder:14b': 14,
      },
      hostTasks: [
        { id: 'task-large', state: 'running', model: 'qwen2.5-coder:32b' },
      ],
    });

    expect(handler.isLargeModelBlockedOnHost('qwen2.5-coder:14b', 'host-small')).toEqual({ blocked: false });
    expect(deps.db.getRunningTasksForHost).not.toHaveBeenCalled();
    expect(deps.safeConfigInt).toHaveBeenNthCalledWith(1, 'large_model_threshold_b', 30, 1, 200);
    expect(deps.safeConfigInt).toHaveBeenNthCalledWith(2, 'max_large_models_per_host', 1, 1, 10);
  });

  it('blocks models at the threshold when the host already has the maximum large-model load', () => {
    const { handler, deps } = createHarness({
      sizes: {
        'qwen2.5-coder:30b': 30,
        'codellama:34b': 34,
        'qwen2.5-coder:7b': 7,
      },
      hostTasks: [
        { id: 'task-running-large', state: 'running', model: 'codellama:34b' },
        { id: 'task-running-small', state: 'running', model: 'qwen2.5-coder:7b' },
      ],
    });

    const result = handler.isLargeModelBlockedOnHost('qwen2.5-coder:30b', 'host-maxed');

    expect(deps.db.getRunningTasksForHost).toHaveBeenCalledWith('host-maxed');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('VRAM guard');
    expect(result.reason).toContain('qwen2.5-coder:30b (30B)');
    expect(result.reason).toContain('1 large model(s)');
    expect(result.reason).toContain('(>=30B)');
    expect(deps.parseModelSizeB).toHaveBeenCalledWith('qwen2.5-coder:30b');
    expect(deps.parseModelSizeB).toHaveBeenCalledWith('codellama:34b');
    expect(deps.parseModelSizeB).toHaveBeenCalledWith('qwen2.5-coder:7b');
  });

  it('allows a large model when the host is under the configured per-host limit', () => {
    const { handler, deps } = createHarness({
      config: {
        max_large_models_per_host: 2,
      },
      sizes: {
        'qwen2.5-coder:32b': 32,
        'codellama:34b': 34,
        'qwen2.5-coder:7b': 7,
      },
      hostTasks: [
        { id: 'task-running-large', state: 'running', model: 'codellama:34b' },
        { id: 'task-completed-small', state: 'completed', model: 'qwen2.5-coder:7b' },
      ],
    });

    expect(handler.isLargeModelBlockedOnHost('qwen2.5-coder:32b', 'host-room')).toEqual({ blocked: false });
    expect(deps.db.getRunningTasksForHost).toHaveBeenCalledWith('host-room');
  });

  it('treats host query failures as non-blocking and logs a debug message', () => {
    const { handler, deps } = createHarness({
      sizes: {
        'qwen2.5-coder:32b': 32,
      },
      dbError: new Error('database unavailable'),
    });

    expect(handler.isLargeModelBlockedOnHost('qwen2.5-coder:32b', 'host-error')).toEqual({ blocked: false });
    expect(deps.logger.debug).toHaveBeenCalledWith('isLargeModelBlockedOnHost: query failed: database unavailable');
  });

  it('delegates filesystem activity, stalled-task detection, and recovery helpers', () => {
    const activityResult = { isStalled: false, lastActivitySeconds: 45 };
    const stalledResult = [
      { taskId: 'task-running', state: 'running', lastActivitySeconds: 420 },
      { taskId: 'task-retrying', state: 'retrying', lastActivitySeconds: 15 },
    ];
    const recoveryResult = { recovered: true, newState: 'queued' };
    const { handler, deps } = createHarness({
      activityResult,
      stalledResult,
      recoveryResult,
    });

    expect(handler.checkFilesystemActivity('task-running', { watchGit: true })).toBe(activityResult);
    expect(handler.checkStalledTasks(true, 'running-or-retrying')).toBe(stalledResult);
    expect(handler.tryStallRecovery('task-running', stalledResult[0])).toBe(recoveryResult);

    expect(deps.activityMonitoring.checkFilesystemActivity).toHaveBeenCalledWith('task-running', { watchGit: true });
    expect(deps.orphanCleanupModule.checkStalledTasks).toHaveBeenCalledWith(true, 'running-or-retrying');
    expect(deps.fallbackRetryModule.tryStallRecovery).toHaveBeenCalledWith('task-running', stalledResult[0]);
  });
});
