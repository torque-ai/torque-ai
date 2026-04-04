import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => {
  const { EventEmitter } = require('events');
  return {
    mocks: {
      taskEvents: new EventEmitter(),
      emitShutdown: vi.fn(),
    },
  };
});

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const taskCore = require('../db/task-core');
const hostMonitoring = require('../utils/host-monitoring');

let handlers;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

function createTask(overrides = {}) {
  const { randomUUID } = require('crypto');
  const id = overrides.id || randomUUID();
  taskCore.createTask({
    id,
    task_description: overrides.task_description || 'test task',
    provider: overrides.provider || 'codex',
    working_directory: overrides.working_directory || process.cwd(),
  });
  if (overrides.status && overrides.status !== 'pending') {
    if (['running', 'completed', 'failed'].includes(overrides.status)) {
      taskCore.updateTaskStatus(id, 'queued', {});
      taskCore.updateTaskStatus(id, 'running', { started_at: new Date().toISOString() });
    }
    if (['completed', 'failed'].includes(overrides.status)) {
      taskCore.updateTaskStatus(id, overrides.status, {
        output: overrides.output || '',
        exit_code: overrides.status === 'completed' ? 0 : 1,
        completed_at: new Date().toISOString(),
      });
    }
  }
  return id;
}

describe('await_restart', () => {
  beforeEach(() => {
    setupTestDbOnly(`await-restart-${Date.now()}`);
    installCjsModuleMock('../hooks/event-dispatch', {
      taskEvents: mocks.taskEvents,
      NOTABLE_EVENTS: ['started', 'stall_warning', 'retry', 'fallback'],
    });
    installCjsModuleMock('../event-bus', {
      emitShutdown: mocks.emitShutdown,
    });
    installCjsModuleMock('../execution/command-policy', {
      executeValidatedCommandSync: vi.fn(() => ''),
    });
    installCjsModuleMock('../utils/safe-exec', {
      safeExecChain: vi.fn(),
    });
    installCjsModuleMock('../plugins/snapscope/handlers/capture', {
      handlePeekUi: vi.fn(),
    });
    mocks.emitShutdown.mockReset();
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    handlers = loadFresh('../handlers/workflow/await');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.emitShutdown.mockReset();
    mocks.taskEvents.removeAllListeners();
    hostMonitoring.hostActivityCache.clear();
    vi.useRealTimers();
    teardownTestDb();
  });

  it('restarts immediately when pipeline is empty', async () => {
    const result = await handlers.handleAwaitRestart({ reason: 'test' });
    const text = textOf(result);

    expect(text).toContain('Restart Ready');
    expect(text).toContain('Pipeline was already empty');
    expect(mocks.emitShutdown).toHaveBeenCalledWith(expect.stringContaining('test'));
  });

  it('waits for running tasks then restarts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const taskId = createTask({ status: 'running', task_description: 'building feature' });

    const promise = handlers.handleAwaitRestart({
      reason: 'code update',
      heartbeat_minutes: 0,
      timeout_minutes: 1,
    });

    await vi.advanceTimersByTimeAsync(100);

    // Complete the task in the DB and emit the event
    taskCore.updateTaskStatus(taskId, 'completed', {
      output: 'done',
      exit_code: 0,
      completed_at: new Date().toISOString(),
    });
    mocks.taskEvents.emit('task:completed', { id: taskId });

    const result = await promise;
    const text = textOf(result);

    expect(text).toContain('Restart Ready');
    expect(text).toContain('Pipeline drained');
    expect(mocks.emitShutdown).toHaveBeenCalled();
  });

  it('times out when tasks never finish', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    createTask({ status: 'running', task_description: 'stuck task' });

    const promise = handlers.handleAwaitRestart({
      reason: 'test',
      heartbeat_minutes: 0,
      timeout_minutes: 0.02, // ~1.2 seconds
    });

    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    const text = textOf(result);

    expect(text).toContain('Drain Timed Out');
    expect(text).toContain('1 tasks still in pipeline');
    expect(mocks.emitShutdown).not.toHaveBeenCalled();
  });

  it('returns heartbeat with pipeline counts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    createTask({ status: 'running', task_description: 'build thing', provider: 'codex' });

    const promise = handlers.handleAwaitRestart({
      reason: 'test',
      heartbeat_minutes: 0.01, // ~0.6 seconds
      timeout_minutes: 1,
    });

    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    const text = textOf(result);

    expect(text).toContain('Restart Drain');
    expect(text).toContain('Heartbeat');
    expect(text).toContain('Running');
    expect(text).toContain('1');
  });
});
