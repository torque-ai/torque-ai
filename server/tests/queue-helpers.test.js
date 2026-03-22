/**
 * Tests for queue processing helpers extracted from processQueueInternal and cancelTask.
 *
 * Tests: safeStartTask, categorizeQueuedTasks, triggerCancellationWebhook
 */

const _path = require('path');
const _os = require('os');
const _fs = require('fs');
const { randomUUID } = require('crypto');
const { setupE2eDb, teardownE2eDb } = require('./e2e-helpers');

let ctx;
let db;
let tm;

beforeAll(() => {
  ctx = setupE2eDb('queue-helpers');
  db = ctx.db;
  tm = ctx.tm;
});

afterAll(async () => {
  await teardownE2eDb(ctx);
});

// ── Helper ──────────────────────────────────────────────────────

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  db.createTask({
    id,
    task_description: overrides.description || 'Test task',
    working_directory: overrides.workingDirectory || ctx.testDir,
    provider: overrides.provider || 'codex',
    model: overrides.model || 'test-model',
    status: overrides.status || 'queued',
  });
  return db.getTask(id);
}

// ── categorizeQueuedTasks ─────────────────────────────────────

describe('categorizeQueuedTasks', () => {
  it('separates ollama, codex, and API tasks', () => {
    const tasks = [
      { provider: 'ollama', id: '1' },
      { provider: 'hashline-ollama', id: '2' },
      { provider: 'codex', id: '4' },
      { provider: 'claude-cli', id: '5' },
      { provider: 'anthropic', id: '6' },
      { provider: 'groq', id: '7' },
      { provider: 'hyperbolic', id: '8' },
      { provider: 'deepinfra', id: '9' },
      { provider: 'ollama-cloud', id: '10' },
      { provider: 'cerebras', id: '11' },
      { provider: 'google-ai', id: '12' },
      { provider: 'openrouter', id: '13' },
    ];

    const result = tm.categorizeQueuedTasks(tasks, true);

    expect(result.ollamaTasks).toHaveLength(3);
    expect(result.ollamaTasks.map(t => t.id)).toEqual(['1', '2', '3']);

    expect(result.codexTasks).toHaveLength(2);
    expect(result.codexTasks.map(t => t.id)).toEqual(['4', '5']);

    expect(result.apiTasks).toHaveLength(8);
    expect(result.apiTasks.map(t => t.id)).toEqual(['6', '7', '8', '9', '10', '11', '12', '13']);
  });

  it('excludes codex tasks when codex disabled', () => {
    const tasks = [
      { provider: 'codex', id: '1' },
      { provider: 'claude-cli', id: '2' },
      { provider: 'ollama', id: '3' },
    ];

    const result = tm.categorizeQueuedTasks(tasks, false);

    // codex excluded, claude-cli still included
    expect(result.codexTasks).toHaveLength(1);
    expect(result.codexTasks[0].id).toBe('2');
    expect(result.ollamaTasks).toHaveLength(1);
  });

  it('skips codex-pending tasks', () => {
    const tasks = [
      { provider: 'codex-pending', id: '1' },
      { provider: 'ollama', id: '2' },
    ];

    const result = tm.categorizeQueuedTasks(tasks, true);

    expect(result.ollamaTasks).toHaveLength(1);
    expect(result.codexTasks).toHaveLength(0);
    expect(result.apiTasks).toHaveLength(0);
  });

  it('surfaces unknown providers as invalid tasks', () => {
    const tasks = [
      { provider: 'unknown-provider', id: '1' },
    ];

    const result = tm.categorizeQueuedTasks(tasks, true);

    expect(result.ollamaTasks).toHaveLength(0);
    expect(result.invalidTasks).toHaveLength(1);
    expect(result.invalidTasks[0].id).toBe('1');
  });

  it('handles empty task list', () => {
    const result = tm.categorizeQueuedTasks([], true);

    expect(result.ollamaTasks).toHaveLength(0);
    expect(result.codexTasks).toHaveLength(0);
    expect(result.apiTasks).toHaveLength(0);
  });
});

// ── safeStartTask ────────────────────────────────────────────

describe('safeStartTask', () => {
  it('returns false when task does not exist', () => {
    const result = tm.safeStartTask('nonexistent-task-id', 'test');
    expect(result).toBe(false);
  });

  it('fails tasks with unknown providers instead of falling back', () => {
    const task = createTask({
      description: 'Task with invalid provider',
      workingDirectory: ctx.testDir,
      provider: 'missing-provider',
    });

    const result = tm.safeStartTask(task.id, 'test');
    const refreshed = db.getTask(task.id);

    expect(result).toBe(false);
    expect(refreshed.status).toBe('failed');
    expect(refreshed.error_output).toContain('Unknown provider: missing-provider');
  });

  it('returns false when task does not exist', () => {
    // safeStartTask returns false for a missing task
    const result = tm.safeStartTask('nonexistent-budget-task-id', 'test');
    expect(result).toBe(false);
  });
});

// ── triggerCancellationWebhook ───────────────────────────────

describe('triggerCancellationWebhook', () => {
  it('does not throw when task exists', () => {
    const task = createTask();

    // Should not throw even though no webhooks are configured
    expect(() => {
      tm.triggerCancellationWebhook(task.id, 'cancelled');
    }).not.toThrow();
  });

  it('does not throw when task does not exist', () => {
    // Should handle gracefully
    expect(() => {
      tm.triggerCancellationWebhook('nonexistent-id', 'timeout');
    }).not.toThrow();
  });

  it('accepts both cancelled and timeout events', () => {
    const task = createTask();

    expect(() => {
      tm.triggerCancellationWebhook(task.id, 'cancelled');
      tm.triggerCancellationWebhook(task.id, 'timeout');
    }).not.toThrow();
  });
});
