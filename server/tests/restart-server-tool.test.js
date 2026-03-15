const tools = require('../tools');
const db = require('../database');
const taskManager = require('../task-manager');
const logger = require('../logger');

describe('restart_server tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.removeAllListeners('torque:shutdown');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns a standard response and delays shutdown long enough for the caller to receive it', async () => {
    vi.spyOn(taskManager, 'getRunningTaskCount').mockReturnValue(0);
    vi.spyOn(db, 'listTasks').mockReturnValue([]);
    vi.spyOn(logger, 'info').mockImplementation(() => {});

    const shutdownEvents = [];
    process.on('torque:shutdown', (reason) => shutdownEvents.push(reason));

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
    vi.spyOn(db, 'listTasks').mockReturnValue([{ id: 'task-a' }, { id: 'task-b' }]);
    vi.spyOn(logger, 'info').mockImplementation(() => {});

    const shutdownEvents = [];
    process.on('torque:shutdown', (reason) => shutdownEvents.push(reason));

    const result = await tools.handleToolCall('restart_server', { reason: 'blocked restart' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot restart');
    expect(result.content[0].text).toContain('Cannot restart');
    expect(result.running_tasks).toBe(2);
    expect(result.local_running).toBe(1);
    expect(result.sibling_running).toBe(1);

    vi.runAllTimers();
    expect(shutdownEvents).toHaveLength(0);
  });
});
