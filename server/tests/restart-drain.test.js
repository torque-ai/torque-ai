'use strict';

describe('restart_server drain mode', () => {
  let tools, taskCore, eventBus;

  beforeEach(() => {
    jest.resetModules();

    taskCore = { listTasks: jest.fn().mockReturnValue([]) };
    jest.doMock('../db/task-core', () => taskCore);

    jest.doMock('../task-manager', () => ({
      getRunningTaskCount: jest.fn().mockReturnValue(0),
    }));

    eventBus = { emitShutdown: jest.fn(), onShutdown: jest.fn(), removeListener: jest.fn() };
    jest.doMock('../event-bus', () => eventBus);

    tools = require('../tools');
  });

  it('accepts drain option and schedules restart when no tasks running', async () => {
    const result = await tools.handleToolCall('restart_server', { reason: 'cutover', drain: true });
    expect(result.success).toBe(true);
    expect(result.status).toBe('restart_scheduled');
  });

  it('starts drain when tasks are running and drain=true', async () => {
    taskCore.listTasks.mockReturnValue([{ id: 'task-1', status: 'running' }]);
    const taskManager = require('../task-manager');
    taskManager.getRunningTaskCount.mockReturnValue(1);

    const result = await tools.handleToolCall('restart_server', { reason: 'cutover', drain: true });
    expect(result.success).toBe(true);
    expect(result.status).toBe('drain_started');
    expect(result.running_tasks).toBe(1);
  });

  it('rejects restart without drain when tasks are running', async () => {
    taskCore.listTasks.mockReturnValue([{ id: 'task-1', status: 'running' }]);
    const taskManager = require('../task-manager');
    taskManager.getRunningTaskCount.mockReturnValue(1);

    const result = await tools.handleToolCall('restart_server', { reason: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('still running');
  });
});
