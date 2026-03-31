import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/task-core', () => ({
  listTasks: vi.fn(() => []),
}));

vi.mock('../hooks/event-dispatch', () => {
  const { EventEmitter } = require('events');
  const taskEvents = new EventEmitter();
  taskEvents.setMaxListeners(50);
  return {
    taskEvents,
    NOTABLE_EVENTS: ['started', 'stall_warning', 'retry', 'fallback'],
  };
});

vi.mock('../event-bus', () => ({
  emitShutdown: vi.fn(),
}));

vi.mock('../config', () => ({
  getEpoch: vi.fn(() => 1),
}));

describe('await_restart', () => {
  let handleAwaitRestart;
  let taskCore;
  let eventBus;
  let taskEvents;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    taskCore = (await import('../db/task-core')).default || await import('../db/task-core');
    eventBus = (await import('../event-bus')).default || await import('../event-bus');
    const dispatch = await import('../hooks/event-dispatch');
    taskEvents = dispatch.taskEvents;
    const awaitModule = await import('../handlers/workflow/await.js');
    handleAwaitRestart = awaitModule.handleAwaitRestart;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    taskEvents.removeAllListeners();
  });

  it('restarts immediately when pipeline is empty', async () => {
    taskCore.listTasks.mockReturnValue([]);
    const result = await handleAwaitRestart({ reason: 'test' });
    const text = result.content[0].text;
    expect(text).toContain('Restart Ready');
    expect(eventBus.emitShutdown).toHaveBeenCalledWith(expect.stringContaining('test'));
  });

  it('waits for running tasks then restarts', async () => {
    taskCore.listTasks
      .mockReturnValueOnce([{ id: 'r1', status: 'running' }])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValue([]);
    const promise = handleAwaitRestart({
      reason: 'code update',
      heartbeat_minutes: 0,
      timeout_minutes: 1,
    });
    await vi.advanceTimersByTimeAsync(100);
    taskEvents.emit('task:completed', { id: 'r1' });
    const result = await promise;
    const text = result.content[0].text;
    expect(text).toContain('Restart Ready');
    expect(eventBus.emitShutdown).toHaveBeenCalled();
  });

  it('times out when tasks never finish', async () => {
    taskCore.listTasks.mockImplementation(({ status }) => {
      if (status === 'running') return [{ id: 'stuck', status: 'running' }];
      return [];
    });
    const promise = handleAwaitRestart({
      reason: 'test',
      heartbeat_minutes: 0,
      timeout_minutes: 0.02,
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    const text = result.content[0].text;
    expect(text).toContain('Drain Timed Out');
    expect(eventBus.emitShutdown).not.toHaveBeenCalled();
  });

  it('returns heartbeat with pipeline counts', async () => {
    taskCore.listTasks.mockImplementation(({ status }) => {
      if (status === 'running') return [{ id: 'r1', status: 'running', provider: 'codex', task_description: 'build thing' }];
      if (status === 'queued') return [{ id: 'q1', status: 'queued' }];
      if (status === 'blocked') return [{ id: 'b1', status: 'blocked' }];
      return [];
    });
    const promise = handleAwaitRestart({
      reason: 'test',
      heartbeat_minutes: 0.01,
      timeout_minutes: 1,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    const text = result.content[0].text;
    expect(text).toContain('Restart Drain');
    expect(text).toContain('Heartbeat');
    expect(text).toContain('Running');
  });
});
