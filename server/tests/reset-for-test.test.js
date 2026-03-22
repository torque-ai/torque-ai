/**
 * Tests for db.resetForTest(buffer) — the in-memory DB reset pattern.
 *
 * Verifies that resetForTest() produces a working DB from a serialized buffer,
 * sub-modules work after reset, it's idempotent, configCache is cleared,
 * and the old DB handle is closed.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

let db;
let hostManagement;
let workflowEngine;
let templateBuffer;

beforeAll(() => {
  // Initialize a real DB so we can serialize it
  const testDir = path.join(os.tmpdir(), `torque-reset-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  process.env.TORQUE_DATA_DIR = testDir;

  // Clear module cache for fresh init
  db = require('../database');
  db.init();
  hostManagement = require('../db/host-management');
  workflowEngine = require('../db/workflow-engine');

  // Remove seeded hosts
  try {
    const hosts = hostManagement.listOllamaHosts ? hostManagement.listOllamaHosts() : [];
    for (const host of hosts) {
      if (hostManagement.removeOllamaHost) hostManagement.removeOllamaHost(host.id);
    }
  } catch { /* ok */ }

  // Checkpoint WAL and switch to DELETE journal mode before serializing.
  // In-memory DBs created from WAL-mode buffers fail with SQLITE_CANTOPEN.
  const inst = db.getDbInstance();
  inst.pragma('wal_checkpoint(TRUNCATE)');
  inst.pragma('journal_mode = DELETE');

  // Serialize the clean template
  templateBuffer = inst.serialize();
});

afterAll(() => {
  try { db.close(); } catch { /* ok */ }
});

describe('db.resetForTest(buffer)', () => {
  it('should produce a working DB that can create and read tasks', () => {
    db.resetForTest(templateBuffer);

    // Should be able to create a task
    const taskId = 'reset-test-task-1';
    db.createTask({
      id: taskId,
      task_description: 'Test task after reset',
      working_directory: os.tmpdir(),
      provider: 'ollama',
      model: 'test:latest',
      status: 'pending',
      priority: 0,
      timeout_minutes: 5,
      auto_approve: false,
    });

    const task = db.getTask(taskId);
    expect(task).toBeTruthy();
    expect(task.id).toBe(taskId);
    expect(task.task_description).toBe('Test task after reset');
  });

  it('should give a clean DB — no tasks from previous reset', () => {
    // Previous test created a task. Reset should give a fresh DB.
    db.resetForTest(templateBuffer);

    const tasks = db.listTasks({ limit: 100 });
    expect(tasks).toHaveLength(0);
  });

  it('should work with sub-module functions (e.g., listOllamaHosts)', () => {
    db.resetForTest(templateBuffer);

    // Sub-module functions should work through the re-injected DB
    const hosts = hostManagement.listOllamaHosts();
    expect(Array.isArray(hosts)).toBe(true);
  });

  it('should work with config functions after reset', () => {
    db.resetForTest(templateBuffer);

    // setConfig + getConfig should work
    db.setConfig('test_key_reset', 'test_value_123');
    const val = db.getConfig('test_key_reset');
    expect(val).toBe('test_value_123');
  });

  it('should clear configCache on reset', () => {
    db.resetForTest(templateBuffer);

    // Set a config value (populates cache)
    db.setConfig('cached_key', 'original');
    expect(db.getConfig('cached_key')).toBe('original');

    // Reset again — cache should be cleared, and value gone
    db.resetForTest(templateBuffer);
    const val = db.getConfig('cached_key');
    expect(val).not.toBe('original');
  });

  it('should be idempotent — calling twice works correctly', () => {
    db.resetForTest(templateBuffer);
    db.resetForTest(templateBuffer);

    // Should still work after double reset
    db.createTask({
      id: 'idempotent-test',
      task_description: 'After double reset',
      working_directory: os.tmpdir(),
      provider: 'ollama',
      model: 'test:latest',
      status: 'pending',
      priority: 0,
      timeout_minutes: 5,
      auto_approve: false,
    });

    const task = db.getTask('idempotent-test');
    expect(task).toBeTruthy();
    expect(task.task_description).toBe('After double reset');
  });

  it('should close the old DB handle', () => {
    db.resetForTest(templateBuffer);
    const oldDb = db.getDbInstance();

    db.resetForTest(templateBuffer);

    // Old handle should be closed — trying to use it should throw
    expect(() => oldDb.prepare('SELECT 1')).toThrow();
  });

  it('should report dbClosed as false after reset', () => {
    db.resetForTest(templateBuffer);
    expect(db.isDbClosed()).toBe(false);
  });

  it('should work with workflow engine functions', () => {
    db.resetForTest(templateBuffer);

    // Workflow functions should work through the re-injected DB
    const workflows = workflowEngine.listWorkflows({ limit: 10 });
    expect(workflows).toBeTruthy();
  });
});

describe('task-manager _testing.resetForTest()', () => {
  it('should clear all internal Maps', () => {
    const tm = require('../task-manager');

    // Verify the function exists
    expect(typeof tm._testing.resetForTest).toBe('function');

    // Call it — should not throw
    tm._testing.resetForTest();

    // All maps should be empty after reset
    expect(tm._testing.runningProcesses.size).toBe(0);
    expect(tm._testing.apiAbortControllers.size).toBe(0);
    expect(tm._testing.pendingRetryTimeouts.size).toBe(0);
    expect(tm._testing.stallRecoveryAttempts.size).toBe(0);
    expect(tm._testing.taskCleanupGuard.size).toBe(0);
  });
});
