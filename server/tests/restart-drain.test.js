'use strict';

describe('restart_server drain mode', () => {
  let tools;
  let originalGetRunningTaskCount;
  let taskCore;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();

    // Monkey-patch task-startup before tools.js loads
    const taskStartup = require('../execution/task-startup');
    originalGetRunningTaskCount = taskStartup.getRunningTaskCount;
    taskStartup.getRunningTaskCount = vi.fn(() => 0);

    // Monkey-patch task-core listTasks
    taskCore = require('../db/task-core');
    taskCore._originalListTasks = taskCore.listTasks;
    taskCore.listTasks = vi.fn(() => []);

    // Mock event-bus to prevent real shutdown behavior
    vi.doMock('../event-bus', () => ({
      emitShutdown: vi.fn(),
      onShutdown: vi.fn(),
      removeListener: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      emit: vi.fn(),
    }));

    tools = require('../tools');
  });

  afterEach(() => {
    const taskStartup = require('../execution/task-startup');
    taskStartup.getRunningTaskCount = originalGetRunningTaskCount;
    if (taskCore._originalListTasks) {
      taskCore.listTasks = taskCore._originalListTasks;
      delete taskCore._originalListTasks;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('accepts drain option and schedules restart when no tasks running', async () => {
    const taskStartup = require('../execution/task-startup');
    taskStartup.getRunningTaskCount.mockReturnValue(0);
    taskCore.listTasks.mockReturnValue([]);
    const result = await tools.handleToolCall('restart_server', { reason: 'cutover', drain: true });
    expect(result.success).toBe(true);
    expect(result.status).toBe('restart_scheduled');
  });

  it('starts drain when tasks are running and drain=true', async () => {
    const taskStartup = require('../execution/task-startup');
    taskStartup.getRunningTaskCount.mockReturnValue(1);
    taskCore.listTasks.mockReturnValue([{ id: 'task-1', status: 'running' }]);
    const result = await tools.handleToolCall('restart_server', { reason: 'cutover', drain: true });
    expect(result.success).toBe(true);
    expect(result.status).toBe('drain_started');
    expect(result.running_tasks).toBe(1);
  });

  it('rejects restart without drain when tasks are running', async () => {
    const taskStartup = require('../execution/task-startup');
    taskStartup.getRunningTaskCount.mockReturnValue(1);
    taskCore.listTasks.mockReturnValue([{ id: 'task-1', status: 'running' }]);
    const result = await tools.handleToolCall('restart_server', { reason: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('still running');
  });
});
