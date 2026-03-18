import { describe, test, expect, beforeAll, afterAll } from 'vitest';

describe('event classification exports', () => {
  test('TERMINAL_EVENTS and NOTABLE_EVENTS are exported', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.TERMINAL_EVENTS).toBeDefined();
    expect(mod.NOTABLE_EVENTS).toBeDefined();
  });

  test('retry is classified as non-terminal (notable)', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.TERMINAL_EVENTS).not.toContain('retry');
    expect(mod.NOTABLE_EVENTS).toContain('retry');
  });

  test('TERMINAL_EVENTS contains completed, failed, cancelled, skipped', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.TERMINAL_EVENTS).toEqual(
      expect.arrayContaining(['completed', 'failed', 'cancelled', 'skipped'])
    );
  });

  test('NOTABLE_EVENTS contains started, stall_warning, retry, fallback', async () => {
    const mod = await import('../hooks/event-dispatch.js');
    expect(mod.NOTABLE_EVENTS).toEqual(
      expect.arrayContaining(['started', 'stall_warning', 'retry', 'fallback'])
    );
  });
});

// ──────────────────────────────────────────────────────────────
// task:started event — emitted when updateTaskStatus transitions to 'running'
// ──────────────────────────────────────────────────────────────

describe('task:started event', () => {
  const { setupTestDb, teardownTestDb } = require('./vitest-setup');
  const { randomUUID } = require('crypto');
  let db;

  beforeAll(() => {
    ({ db } = setupTestDb('event-dispatch-heartbeat-started'));
  });

  afterAll(() => {
    teardownTestDb();
  });

  test('task:started is emitted when task transitions to running', () => {
    const { taskEvents } = require('../hooks/event-dispatch');
    const handler = vi.fn();
    taskEvents.on('task:started', handler);

    // Create a task in queued state via createTask
    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'Test task for task:started event',
      status: 'queued',
      provider: 'ollama',
      model: 'test-model',
    });

    // Transition to running — this should emit task:started
    db.updateTaskStatus(taskId, 'running');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: taskId })
    );

    taskEvents.removeListener('task:started', handler);
  });
});
