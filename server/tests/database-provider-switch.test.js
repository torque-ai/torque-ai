/**
 * Database Provider Switch Tests
 *
 * Tests for model-clearing behavior during provider switches in updateTaskStatus().
 * When a task switches providers (e.g., codex → ollama), the stale model field
 * should be cleared to null unless the caller explicitly provides a new model.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

let testDir;
let origDataDir;
let db;
let taskCore;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setupDb() {
  testDir = path.join(os.tmpdir(), `torque-vtest-prov-switch-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');

  taskCore = require('../db/task-core');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  return db;
}

function teardownDb() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (origDataDir !== undefined) {
      process.env.TORQUE_DATA_DIR = origDataDir;
    } else {
      delete process.env.TORQUE_DATA_DIR;
    }
  }
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
      model: 'qwen2.5-coder:32b',
    });

    const task = taskCore.getTask(taskId);
    expect(task.provider).toBe('ollama');
    expect(task.model).toBe('qwen2.5-coder:32b');
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
