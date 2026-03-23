/**
 * Database Provider Switch Tests
 *
 * Tests for model-clearing behavior during provider switches in updateTaskStatus().
 * When a task switches providers (e.g., codex → ollama), the stale model field
 * should be cleared to null unless the caller explicitly provides a new model.
 */

const { v4: uuidv4 } = require('uuid');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const taskCore = require('../db/task-core');

let db;

function setupDb() {
  ({ db } = setupTestDb('prov-switch'));
  return db;
}

function teardownDb() {
  teardownTestDb();
}

describe('Provider Switch — Model Clearing', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  it('clears model to null when provider changes and no new model is passed', () => {
    const taskId = uuidv4();
    taskCore.createTask({
      id: taskId,
      task_description: 'Test model clearing on provider switch',
      status: 'queued',
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
    });

    // Switch provider without specifying a new model
    taskCore.updateTaskStatus(taskId, 'running', { provider: 'ollama' });

    const task = taskCore.getTask(taskId);
    expect(task.provider).toBe('ollama');
    expect(task.model).toBeNull();
  });

  it('preserves new model when provider changes and a model IS provided', () => {
    const taskId = uuidv4();
    taskCore.createTask({
      id: taskId,
      task_description: 'Test model preservation on provider switch',
      status: 'queued',
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
    });

    taskCore.updateTaskStatus(taskId, 'running', {
      provider: 'ollama',
      model: 'qwen3-coder:30b',
    });

    const task = taskCore.getTask(taskId);
    expect(task.provider).toBe('ollama');
    expect(task.model).toBe('qwen3-coder:30b');
  });

  it('does not touch model when provider does not change', () => {
    const taskId = uuidv4();
    taskCore.createTask({
      id: taskId,
      task_description: 'Test model untouched when same provider',
      status: 'queued',
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
    });

    // Update status without changing provider
    taskCore.updateTaskStatus(taskId, 'running');

    const task = taskCore.getTask(taskId);
    expect(task.provider).toBe('codex');
    expect(task.model).toBe('gpt-5.3-codex-spark');
  });

  it('sets original_provider on first provider switch', () => {
    const taskId = uuidv4();
    taskCore.createTask({
      id: taskId,
      task_description: 'Test original_provider tracking',
      status: 'queued',
      provider: 'codex',
    });

    taskCore.updateTaskStatus(taskId, 'running', { provider: 'ollama' });

    const task = taskCore.getTask(taskId);
    expect(task.original_provider).toBe('codex');
    expect(task.provider).toBe('ollama');
  });

  it('appends to provider_switch_history in metadata', () => {
    const taskId = uuidv4();
    taskCore.createTask({
      id: taskId,
      task_description: 'Test switch history metadata',
      status: 'queued',
      provider: 'codex',
    });

    taskCore.updateTaskStatus(taskId, 'running', { provider: 'ollama' });

    const task = taskCore.getTask(taskId);
    const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
    expect(meta.provider_switch_history).toBeDefined();
    expect(Array.isArray(meta.provider_switch_history)).toBe(true);
    expect(meta.provider_switch_history.length).toBe(1);
    expect(meta.provider_switch_history[0].from).toBe('codex');
    expect(meta.provider_switch_history[0].to).toBe('ollama');
  });
});
