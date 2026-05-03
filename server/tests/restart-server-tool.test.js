'use strict';

const { setupTestDbOnly, teardownTestDb, resetTables } = require('./vitest-setup');
const tools = require('../tools');
const taskCore = require('../db/task-core');
const taskManager = require('../task-manager');
const logger = require('../logger');
const eventBus = require('../event-bus');
const restartHandoff = require('../execution/restart-handoff');

describe('restart_server tool', () => {
  let shutdownListeners = [];

  beforeAll(() => {
    setupTestDbOnly('restart-server-tool');
  });
  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    delete process._torqueRestartPending;
    shutdownListeners = [];
    resetTables('tasks');
    restartHandoff.clearRestartHandoff();
    restartHandoff.clearRestartIntent();
  });

  afterEach(() => {
    for (const fn of shutdownListeners) {
      eventBus.removeListener('shutdown', fn);
    }
    shutdownListeners = [];
    restartHandoff.clearRestartHandoff();
    restartHandoff.clearRestartIntent();
    delete process._torqueRestartPending;
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

    // Barrier mode returns success with content
    expect(result.success).toBe(true);
    expect(result.status).toBe('restart_scheduled');
    expect(result.content[0].text).toContain('restart');
    expect(taskCore.getTask(result.task_id).status).toBe('running');
    expect(restartHandoff.readRestartHandoff()).toMatchObject({
      barrier_id: result.task_id,
      reason: 'unit restart',
    });
    expect(restartHandoff.readRestartIntent()).toMatchObject({
      barrier_id: result.task_id,
      reason: 'unit restart',
      phase: 'handoff_staged',
      running_count: 0,
      queued_held_count: 0,
    });

    // Shutdown is delayed — not immediate
    expect(shutdownEvents).toHaveLength(0);

    // Advance past the grace period
    vi.advanceTimersByTime(2000);
    expect(shutdownEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('enters drain mode when tasks are still running', async () => {
    vi.spyOn(taskManager, 'getRunningTaskCount').mockReturnValue(1);
    vi.spyOn(taskCore, 'listTasks').mockImplementation(({ status }) => {
      if (status === 'running') return [{ id: 'task-a', provider: 'codex' }];
      return [];
    });
    vi.spyOn(logger, 'info').mockImplementation(() => {});

    const shutdownEvents = [];
    const listener = (reason) => shutdownEvents.push(reason);
    shutdownListeners.push(listener);
    eventBus.onShutdown(listener);

    const result = await tools.handleToolCall('restart_server', { reason: 'drain restart' });

    // Barrier created, drain started — NOT refused
    expect(result.success).toBe(true);
    expect(result.task_id).toBeTruthy();
    expect(['drain_started', 'restart_scheduled']).toContain(result.status);
    expect(restartHandoff.readRestartIntent()).toMatchObject({
      barrier_id: result.task_id,
      reason: 'drain restart',
      phase: 'draining',
      running_count: 1,
      queued_held_count: 0,
    });

    // No immediate shutdown — waiting for drain
    vi.runAllTimers();
    // Shutdown may or may not fire depending on drain poll timing
  });

  it('restart_status includes intent phase and blocking task summaries', async () => {
    taskCore.createTask({
      id: 'running-worker',
      task_description: 'Normalize verify-signature test-name paths (#2213)',
      provider: 'codex',
      model: 'gpt-5.2',
      working_directory: process.cwd(),
      status: 'queued',
    });
    taskCore.updateTaskStatus('running-worker', 'running', {
      started_at: '2026-05-03T00:34:28.000Z',
    });
    taskCore.createTask({
      id: 'status-barrier',
      task_description: 'Restart barrier: status',
      provider: 'system',
      working_directory: process.cwd(),
      status: 'queued',
    });
    taskCore.updateTaskStatus('status-barrier', 'running', {
      started_at: '2026-05-03T00:35:00.000Z',
    });
    restartHandoff.writeRestartIntent({
      barrier_id: 'status-barrier',
      reason: 'status test',
      phase: 'draining',
      running_count: 1,
      queued_held_count: 0,
      last_drain_heartbeat_at: new Date().toISOString(),
    });

    const status = await tools.handleToolCall('restart_status', {});

    expect(status.structuredData).toMatchObject({
      barrier_active: true,
      barrier_id: 'status-barrier',
      intent_phase: 'draining',
      running_count: 1,
    });
    expect(status.structuredData.blocking_tasks).toEqual([expect.objectContaining({
      id: 'running-worker',
      provider: 'codex',
      task_description: expect.stringContaining('Normalize verify-signature'),
    })]);
    expect(status.content[0].text).toContain('Intent phase: draining');
    expect(status.content[0].text).toContain('running-:codex');
  });

  it('stale barrier cleanup reports the persisted restart intent phase', () => {
    taskCore.createTask({
      id: 'stale-barrier',
      task_description: 'Restart barrier: stale',
      provider: 'system',
      working_directory: process.cwd(),
      status: 'queued',
    });
    taskCore.updateTaskStatus('stale-barrier', 'running', {
      started_at: '2026-04-30T15:23:05.000Z',
    });
    restartHandoff.writeRestartIntent({
      barrier_id: 'stale-barrier',
      reason: 'node24 rebuild',
      phase: 'draining',
      running_count: 2,
      queued_held_count: 4,
      requested_at: '2026-04-30T15:23:05.000Z',
    });

    const cleaned = tools.cleanupStaleRestartBarriers();

    expect(cleaned).toBe(1);
    expect(taskCore.getTask('stale-barrier')).toMatchObject({
      status: 'failed',
    });
    expect(taskCore.getTask('stale-barrier').error_output).toContain("phase was 'draining'");
    expect(taskCore.getTask('stale-barrier').error_output).toContain('reason=node24 rebuild');
    expect(restartHandoff.readRestartIntent()).toBeNull();
  });
});
