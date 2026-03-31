import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const taskEvents = new EventEmitter();
taskEvents.setMaxListeners(50);

const mockListTasks = vi.fn(() => []);
const mockEmitShutdown = vi.fn();

vi.mock('../db/task-core', () => ({
  listTasks: (...args) => mockListTasks(...args),
  getTask: vi.fn(),
}));

vi.mock('../hooks/event-dispatch', () => ({
  taskEvents,
  NOTABLE_EVENTS: ['started', 'stall_warning', 'retry', 'fallback'],
}));

vi.mock('../event-bus', () => ({
  emitShutdown: (...args) => mockEmitShutdown(...args),
}));

// Stub out modules that await.js imports but handleAwaitRestart doesn't use
vi.mock('../db/file-tracking', () => ({}));
vi.mock('../db/task-metadata', () => ({ listArtifacts: vi.fn(() => []) }));
vi.mock('../db/workflow-engine', () => ({ getWorkflow: vi.fn(), getWorkflowTasks: vi.fn(() => []) }));
vi.mock('../contracts/peek', () => ({
  buildPeekArtifactReferencesFromTaskArtifacts: vi.fn(() => []),
  formatPeekArtifactReferenceSection: vi.fn(() => ''),
}));
vi.mock('../utils/safe-exec', () => ({ safeExecChain: vi.fn() }));
vi.mock('../execution/command-policy', () => ({ executeValidatedCommandSync: vi.fn() }));
vi.mock('../utils/resource-gate', () => ({ checkResourceGate: vi.fn(() => ({ allowed: true })), isHostOverloaded: vi.fn(() => false) }));
vi.mock('../utils/commit-mutex', () => ({ mutex: { acquire: vi.fn(async () => () => {}) } }));
vi.mock('../utils/host-monitoring', () => ({ hostActivityCache: new Map() }));
vi.mock('../utils/activity-monitoring', () => ({}));
vi.mock('../plugins/snapscope/handlers/capture', () => ({ handlePeekUi: vi.fn() }));
vi.mock('../config', () => ({ getEpoch: vi.fn(() => 1), getInt: vi.fn(() => 60), get: vi.fn(() => null), init: vi.fn() }));
vi.mock('../database', () => ({}));
vi.mock('../logger', () => {
  const noop = () => {};
  const child = () => ({ info: noop, warn: noop, error: noop, debug: noop, child });
  return { info: noop, warn: noop, error: noop, debug: noop, child };
});

describe('await_restart', () => {
  let handleAwaitRestart;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockListTasks.mockReset().mockReturnValue([]);
    mockEmitShutdown.mockReset();
    taskEvents.removeAllListeners();
    const mod = await import('../handlers/workflow/await.js');
    handleAwaitRestart = mod.handleAwaitRestart;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restarts immediately when pipeline is empty', async () => {
    mockListTasks.mockReturnValue([]);

    const result = await handleAwaitRestart({ reason: 'test' });
    const text = result.content[0].text;

    expect(text).toContain('Restart Ready');
    expect(mockEmitShutdown).toHaveBeenCalledWith(expect.stringContaining('test'));
  });

  it('waits for running tasks then restarts', async () => {
    // First 4 calls (initial countPipeline): 1 running, 0 queued, 0 pending, 0 blocked
    mockListTasks
      .mockReturnValueOnce([{ id: 'r1', status: 'running' }]) // running
      .mockReturnValueOnce([])  // queued
      .mockReturnValueOnce([])  // pending
      .mockReturnValueOnce([])  // blocked
      // After event fires, recount — all empty
      .mockReturnValue([]);

    const promise = handleAwaitRestart({
      reason: 'code update',
      heartbeat_minutes: 0,
      timeout_minutes: 1,
    });

    // Let the handler enter its await
    await vi.advanceTimersByTimeAsync(100);

    // Simulate task completion
    taskEvents.emit('task:completed', { id: 'r1' });

    const result = await promise;
    const text = result.content[0].text;

    expect(text).toContain('Restart Ready');
    expect(mockEmitShutdown).toHaveBeenCalled();
  });

  it('times out when tasks never finish', async () => {
    mockListTasks.mockImplementation(({ status }) => {
      if (status === 'running') return [{ id: 'stuck', status: 'running' }];
      return [];
    });

    const promise = handleAwaitRestart({
      reason: 'test',
      heartbeat_minutes: 0,
      timeout_minutes: 0.02, // ~1.2 seconds
    });

    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    const text = result.content[0].text;

    expect(text).toContain('Drain Timed Out');
    expect(mockEmitShutdown).not.toHaveBeenCalled();
  });

  it('returns heartbeat with pipeline counts', async () => {
    mockListTasks.mockImplementation(({ status }) => {
      if (status === 'running') return [{ id: 'r1', status: 'running', provider: 'codex', task_description: 'build thing' }];
      if (status === 'queued') return [{ id: 'q1', status: 'queued' }];
      if (status === 'blocked') return [{ id: 'b1', status: 'blocked' }];
      return [];
    });

    const promise = handleAwaitRestart({
      reason: 'test',
      heartbeat_minutes: 0.01, // ~0.6 seconds
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
