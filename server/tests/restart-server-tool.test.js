const tools = require('../tools');
const taskCore = require('../db/task-core');
const taskManager = require('../task-manager');
const logger = require('../logger');
const eventBus = require('../event-bus');

describe('restart_server tool', () => {
  let shutdownListeners = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    shutdownListeners = [];
  });

  afterEach(() => {
    for (const fn of shutdownListeners) {
      eventBus.removeListener('shutdown', fn);
    }
    shutdownListeners = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns a standard response and delays shutdown long enough for the caller to receive it', async () => {
    vi.spyOn(taskManager, 'getRunningTaskCount').mockReturnValue(0);
    vi.spyOn(taskCore, 'listTasks').mockReturnValue([]);
    vi.spyOn(logger, 'info').mockImplementation(() => {});

    const shutdownEvents = [];
    const listener = (reason) => shutdownEvents.push(reason);
    shutdownListeners.push(listener);
    eventBus.onShutdown(listener);

    const result = await tools.handleToolCall('restart_server', { reason: 'unit restart' });

    expect(result.success).toBe(true);
    expect(result.status).toBe('restart_scheduled');
    expect(result.reason).toBe('unit restart');
    expect(result.content[0].text).toContain('Server restart scheduled');
    expect(shutdownEvents).toHaveLength(0);

    vi.advanceTimersByTime(1499);
    expect(shutdownEvents).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(shutdownEvents).toEqual(['restart: unit restart']);
  });

  it('refuses restart while tasks are still running', async () => {
    vi.spyOn(taskManager, 'getRunningTaskCount').mockReturnValue(1);
    vi.spyOn(taskCore, 'listTasks').mockReturnValue([{ id: 'task-a' }, { id: 'task-b' }]);
    vi.spyOn(logger, 'info').mockImplementation(() => {});

    const shutdownEvents = [];
    const listener = (reason) => shutdownEvents.push(reason);
    shutdownListeners.push(listener);
    eventBus.onShutdown(listener);

    const result = await tools.handleToolCall('restart_server', { reason: 'blocked restart' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot restart');
    expect(result.content[0].text).toContain('Cannot restart');
    expect(result.running_tasks).toBe(2);
    expect(result.local_running).toBe(1);
    expect(result.error).toContain('1 from other sessions');

    vi.runAllTimers();
    expect(shutdownEvents).toHaveLength(0);
  });
});
