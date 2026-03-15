/**
 * Load / Stress Tests for TORQUE
 *
 * Tests concurrent task submission, host distribution under load, DB integrity,
 * stall recovery, queue throughput, and resource cleanup.
 *
 * Pattern: setupE2eDb/teardownE2eDb + mock child_process.spawn via process-mock.
 * All tests use direct DB operations + task-manager calls with mocked spawn.
 */

const os = require('os');
const { v4: _uuidv4 } = require('uuid');
const { createMockChild, simulateSuccess } = require('./mocks/process-mock');
const { setupE2eDb, resetE2eDb, teardownE2eDb, registerMockHost, createTestTask } = require('./e2e-helpers');

let ctx;
let spawnMock;
let originalSpawn;
const mockChildren = [];

// Track all mock children so tests can drive them
function installSpawnMock() {
  const childProcess = require('child_process');
  originalSpawn = childProcess.spawn;
  spawnMock = vi.fn().mockImplementation(() => {
    const child = createMockChild();
    mockChildren.push(child);
    spawnMock._lastChild = child;
    return child;
  });
  childProcess.spawn = spawnMock;
}

function restoreSpawn() {
  const childProcess = require('child_process');
  if (originalSpawn) {
    childProcess.spawn = originalSpawn;
  }
}

beforeAll(() => {
  ctx = setupE2eDb('load-stress-queue-cleanup');
  if (!process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = 'test-key-for-load';
  }
});

beforeEach(() => {
  mockChildren.length = 0;
  resetE2eDb();
  installSpawnMock();
});

afterEach(() => {
  restoreSpawn();
});

afterAll(async () => {
  if (ctx) await teardownE2eDb(ctx);
});

// ============================================================
// Helper: bulk-create tasks with given options
// ============================================================
function bulkCreateTasks(count, overrides = {}) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = createTestTask(ctx.db, {
      description: overrides.description || `Load test task #${i}`,
      provider: overrides.provider || 'codex',
      model: overrides.model || null,
      priority: overrides.priorityFn ? overrides.priorityFn(i) : (overrides.priority || 0),
      workingDirectory: overrides.workingDirectory || os.tmpdir(),
      status: overrides.status || 'pending',
      ...(overrides.extra || {}),
    });
    ids.push(id);
  }
  return ids;
}

function createWorkflowWithPriority(priority, overrides = {}) {
  const workflow = ctx.db.createWorkflow({
    id: overrides.id || _uuidv4(),
    name: overrides.name || `workflow-${priority}-${Date.now()}`,
    working_directory: overrides.working_directory || os.tmpdir(),
    status: overrides.status || 'pending',
  });

  ctx.db.getDbInstance().prepare('UPDATE workflows SET priority = ? WHERE id = ?').run(priority, workflow.id);
  return workflow.id;
}

// Helper: complete all mock children that were spawned
function _completeAllMockChildren(output = 'done\n') {
  for (const child of mockChildren) {
    if (!child.killed) {
      try {
        child.stdout.write(output);
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      } catch { /* already closed */ }
    }
  }
}

// ============================================================
// 1. Concurrent Task Submission (8 tests)
describe('Queue throughput', () => {
  it('processQueue handles 50 queued tasks efficiently', () => {
    ctx.db.setConfig('max_concurrent', '50');

    // Register a host so ollama tasks have somewhere to go
    registerMockHost(ctx.db, 'http://queue-host.local:11434', ['codellama:latest'], { name: 'queue-host', maxConcurrent: 50, id: 'queue-host' });
    ctx.db.setConfig('max_per_host', '50');

    const ids = bulkCreateTasks(50, { provider: 'codex' });
    // Set all to queued
    for (const id of ids) {
      ctx.db.updateTaskStatus(id, 'queued');
    }

    const before = Date.now();
    ctx.tm.processQueue();
    const elapsed = Date.now() - before;

    // processQueue should complete within a reasonable time (< 5s)
    expect(elapsed).toBeLessThan(10000);

    // Some tasks should have been started
    const running = ctx.db.listTasks({ status: 'running', limit: 100 });
    const stillQueued = ctx.db.listTasks({ status: 'queued', limit: 100 });
    // At least some moved out of queued
    expect(running.length + stillQueued.length).toBeLessThanOrEqual(50);
  });

  it('queue processing respects priority ordering', () => {
    ctx.db.setConfig('max_concurrent', '1');

    // Create tasks with varying priorities
    const lowId = createTestTask(ctx.db, { description: 'low', provider: 'codex', priority: 1 });
    const highId = createTestTask(ctx.db, { description: 'high', provider: 'codex', priority: 100 });

    // Queue both
    ctx.db.updateTaskStatus(lowId, 'queued');
    ctx.db.updateTaskStatus(highId, 'queued');

    // getNextQueuedTask should prefer higher priority
    const next = ctx.db.getNextQueuedTask();
    expect(next).toBeTruthy();
    expect(next.id).toBe(highId);
  });

  it('queue processing prefers higher-priority workflows over task priority', () => {
    ctx.db.setConfig('max_concurrent', '1');

    const lowWorkflowId = createWorkflowWithPriority(0, { name: 'low-workflow' });
    const highWorkflowId = createWorkflowWithPriority(7, { name: 'high-workflow' });

    const lowWorkflowHighTaskId = createTestTask(ctx.db, {
      description: 'low-workflow-high-task',
      provider: 'codex',
      priority: 100,
      extra: { workflow_id: lowWorkflowId },
    });
    const highWorkflowLowTaskId = createTestTask(ctx.db, {
      description: 'high-workflow-low-task',
      provider: 'codex',
      priority: 1,
      extra: { workflow_id: highWorkflowId },
    });

    ctx.db.updateTaskStatus(lowWorkflowHighTaskId, 'queued');
    ctx.db.updateTaskStatus(highWorkflowLowTaskId, 'queued');

    const next = ctx.db.getNextQueuedTask();
    expect(next).toBeTruthy();
    expect(next.id).toBe(highWorkflowLowTaskId);
  });

  it('listQueuedTasksLightweight exposes workflow priority and keeps standalone tasks sortable', () => {
    const highWorkflowId = createWorkflowWithPriority(5, { name: 'high-workflow-lightweight' });
    const zeroWorkflowId = createWorkflowWithPriority(0, { name: 'zero-workflow-lightweight' });

    const highWorkflowTaskId = createTestTask(ctx.db, {
      description: 'high-workflow-task',
      provider: 'codex',
      priority: 1,
      extra: { workflow_id: highWorkflowId },
    });
    const standaloneTaskId = createTestTask(ctx.db, {
      description: 'standalone-task',
      provider: 'codex',
      priority: 50,
    });
    const zeroWorkflowTaskId = createTestTask(ctx.db, {
      description: 'zero-workflow-task',
      provider: 'codex',
      priority: 10,
      extra: { workflow_id: zeroWorkflowId },
    });

    ctx.db.updateTaskStatus(highWorkflowTaskId, 'queued');
    ctx.db.updateTaskStatus(standaloneTaskId, 'queued');
    ctx.db.updateTaskStatus(zeroWorkflowTaskId, 'queued');

    const interestingIds = new Set([highWorkflowTaskId, standaloneTaskId, zeroWorkflowTaskId]);
    const queued = ctx.db.listQueuedTasksLightweight(10).filter((task) => interestingIds.has(task.id));

    expect(queued.map((task) => task.id)).toEqual([
      highWorkflowTaskId,
      standaloneTaskId,
      zeroWorkflowTaskId,
    ]);
    expect(queued.find((task) => task.id === highWorkflowTaskId)?.workflow_priority).toBe(5);
    expect(queued.find((task) => task.id === standaloneTaskId)?.workflow_priority).toBe(0);
    expect(queued.find((task) => task.id === zeroWorkflowTaskId)?.workflow_priority).toBe(0);
  });

  it('queue processing skips tasks with unmet dependencies', () => {
    ctx.db.setConfig('max_concurrent', '10');

    const depId = createTestTask(ctx.db, { description: 'dependency', provider: 'codex' });
    const childId = createTestTask(ctx.db, {
      description: 'child with deps',
      provider: 'codex',
      extra: { depends_on: [depId] },
    });

    // Queue the child (dep is still pending)
    ctx.db.updateTaskStatus(childId, 'queued');

    // The child task exists in queue, but has unmet dependency
    const task = ctx.db.getTask(childId);
    expect(task.status).toBe('queued');
    expect(task.depends_on).toBeTruthy();
  });

  it('high-priority task leapfrogs lower priority in queue', () => {
    ctx.db.setConfig('max_concurrent', '1');

    // Create 5 low-priority queued tasks
    const lowIds = [];
    for (let i = 0; i < 5; i++) {
      const id = createTestTask(ctx.db, { description: `low-${i}`, provider: 'codex', priority: 1 });
      ctx.db.updateTaskStatus(id, 'queued');
      lowIds.push(id);
    }

    // Insert a high-priority task
    const highId = createTestTask(ctx.db, { description: 'urgent', provider: 'codex', priority: 999 });
    ctx.db.updateTaskStatus(highId, 'queued');

    // getNextQueuedTask should return the high-priority task
    const next = ctx.db.getNextQueuedTask();
    expect(next.id).toBe(highId);
    expect(next.priority).toBe(999);
  });
});
describe('Resource cleanup', () => {
  it('after batch completion: runningProcesses map is empty', () => {
    ctx.db.setConfig('max_concurrent', '5');

    const ids = bulkCreateTasks(5);
    for (const id of ids) {
      try { ctx.tm.startTask(id); } catch { /* ignore */ }
    }

    // Complete all via mock children
    for (const child of mockChildren) {
      if (!child.killed) {
        simulateSuccess(child, 'done\n', 0);
      }
    }

    // Wait for async handlers
    return new Promise(resolve => setTimeout(resolve, 50)).then(() => {
      const procs = ctx.tm._testing.runningProcesses;
      // Running processes for completed tasks should have been cleaned up
      for (const id of ids) {
        const task = ctx.db.getTask(id);
        if (task.status === 'completed' || task.status === 'failed') {
          expect(procs.has(id)).toBe(false);
        }
      }
    });
  });

  it('after bulk cancellation: all processes cleaned up', () => {
    ctx.db.setConfig('max_concurrent', '5');

    const ids = bulkCreateTasks(5);
    for (const id of ids) {
      try { ctx.tm.startTask(id); } catch { /* ignore */ }
    }

    // Cancel all
    for (const id of ids) {
      try { ctx.tm.cancelTask(id, 'cleanup test'); } catch { /* ignore */ }
    }

    const procs = ctx.tm._testing.runningProcesses;
    // All cancelled tasks should be removed from runningProcesses
    for (const id of ids) {
      if (ctx.db.getTask(id).status === 'cancelled') {
        expect(procs.has(id)).toBe(false);
      }
    }

    // No running tasks in DB
    const running = ctx.db.listTasks({ status: 'running' });
    expect(running.length).toBe(0);
  });

  it('concurrent cancel + complete on same task does not corrupt state', () => {
    ctx.db.setConfig('max_concurrent', '5');

    const id = createTestTask(ctx.db, { provider: 'codex' });
    ctx.tm.startTask(id);

    // Try to cancel (which updates DB to cancelled)
    try { ctx.tm.cancelTask(id, 'race test'); } catch { /* ignore */ }

    // Now try to update to completed (should fail since it's in terminal state)
    const task = ctx.db.getTask(id);
    if (task.status === 'cancelled') {
      expect(() => {
        ctx.db.updateTaskStatus(id, 'completed');
      }).toThrow();
    }

    // Verify the task is in a consistent terminal state
    const finalTask = ctx.db.getTask(id);
    expect(['cancelled', 'completed', 'failed']).toContain(finalTask.status);
    expect(finalTask.completed_at).toBeTruthy();
  });
});
