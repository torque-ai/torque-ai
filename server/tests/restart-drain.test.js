'use strict';

// Use vi.mock at top-level (hoisted) to intercept task-startup before any module loads it
vi.mock('../execution/task-startup', () => {
  const mockFns = {
    getRunningTaskCount: vi.fn(() => 0),
    getTaskProgress: vi.fn(() => null),
    hasRunningProcess: vi.fn(() => false),
    startTask: vi.fn(),
    cancelTask: vi.fn(),
    getActualModifiedFiles: vi.fn(() => []),
    isLargeModelBlockedOnHost: vi.fn(() => false),
  };
  return mockFns;
});

vi.mock('../event-bus', () => ({
  emitShutdown: vi.fn(),
  onShutdown: vi.fn(),
  removeListener: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  emit: vi.fn(),
}));

describe('restart_server drain mode', () => {
  let tools, taskStartup;

  beforeEach(() => {
    vi.useFakeTimers();
    // Get the mocked module
    taskStartup = require('../execution/task-startup');
    tools = require('../tools');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('accepts drain option and schedules restart when no tasks running', async () => {
    taskStartup.getRunningTaskCount.mockReturnValue(0);
    const result = await tools.handleToolCall('restart_server', { reason: 'cutover', drain: true });
    expect(result.success).toBe(true);
    expect(result.status).toBe('restart_scheduled');
  });

  it('starts drain when tasks are running and drain=true', async () => {
    taskStartup.getRunningTaskCount.mockReturnValue(1);
    const result = await tools.handleToolCall('restart_server', { reason: 'cutover', drain: true });
    expect(result.success).toBe(true);
    expect(result.status).toBe('drain_started');
    expect(result.running_tasks).toBe(1);
  });

  it('rejects restart without drain when tasks are running', async () => {
    taskStartup.getRunningTaskCount.mockReturnValue(1);
    const result = await tools.handleToolCall('restart_server', { reason: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('still running');
  });
});
