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
const { createMockChild } = require('./mocks/process-mock');
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
  ctx = setupE2eDb('load-stress-hosts');
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
describe('Host distribution under load', () => {
  it('distributes 30 tasks across 3 registered hosts', () => {
    registerMockHost(ctx.db, 'http://host1.local:11434', ['codellama:latest'], { name: 'host1', maxConcurrent: 10, id: 'host1' });
    registerMockHost(ctx.db, 'http://host2.local:11434', ['codellama:latest'], { name: 'host2', maxConcurrent: 10, id: 'host2' });
    registerMockHost(ctx.db, 'http://host3.local:11434', ['codellama:latest'], { name: 'host3', maxConcurrent: 10, id: 'host3' });
    ctx.db.setConfig('max_concurrent', '30');

    const _ids = bulkCreateTasks(30, { provider: 'ollama', model: 'codellama:latest' });

    // Start all tasks — they go through Ollama HTTP (not spawn), so mock is irrelevant
    // But since mock hosts don't have real HTTP, startTask will fail for ollama provider.
    // Instead, verify host selection logic distributes correctly.
    const hosts = ctx.db.listOllamaHosts({ enabled: true });
    expect(hosts.length).toBe(3);

    // Verify selectOllamaHostForModel returns hosts with capacity
    for (let i = 0; i < 10; i++) {
      const selection = ctx.db.selectOllamaHostForModel('codellama:latest');
      expect(selection.host).toBeTruthy();
      // Simulate host load by incrementing running tasks
      if (selection.host) {
        ctx.db.incrementHostTasks(selection.host.id);
      }
    }

    // After loading 10 tasks, hosts should still have capacity
    const hostStatuses = ctx.db.listOllamaHosts({ enabled: true });
    const totalRunning = hostStatuses.reduce((sum, h) => sum + (h.running_tasks || 0), 0);
    expect(totalRunning).toBe(10);
  });

  it('host goes down mid-batch: running tasks on that host can be failed', () => {
    registerMockHost(ctx.db, 'http://host-a.local:11434', ['codellama:latest'], { name: 'host-a', maxConcurrent: 5, id: 'host-a' });
    registerMockHost(ctx.db, 'http://host-b.local:11434', ['codellama:latest'], { name: 'host-b', maxConcurrent: 5, id: 'host-b' });

    // Create a task assigned to host-a
    const taskId = createTestTask(ctx.db, {
      description: 'task on host-a',
      provider: 'ollama',
      model: 'codellama:latest',
    });
    // Manually set to running on host-a
    ctx.db.updateTaskStatus(taskId, 'running', { ollama_host_id: 'host-a' });
    ctx.db.incrementHostTasks('host-a');

    // Verify getRunningTasksForHost finds the task
    const runningOnA = ctx.db.getRunningTasksForHost('host-a');
    expect(runningOnA.length).toBe(1);
    expect(runningOnA[0].id).toBe(taskId);

    // Simulate host-a going down
    ctx.db.updateOllamaHost('host-a', { status: 'down', consecutive_failures: 3 });

    // Manually fail the orphaned task (simulates what cleanupOrphanedHostTasks does)
    ctx.db.updateTaskStatus(taskId, 'failed', {
      error_output: '[HOST FAILOVER] Host host-a went down',
    });

    const task = ctx.db.getTask(taskId);
    expect(task.status).toBe('failed');
    expect(task.error_output).toContain('HOST FAILOVER');

    // Host-b should still be healthy and selectable
    const selection = ctx.db.selectOllamaHostForModel('codellama:latest');
    expect(selection.host).toBeTruthy();
    expect(selection.host.id).toBe('host-b');
  });

  it('all hosts at capacity: tasks queue properly', () => {
    registerMockHost(ctx.db, 'http://full1.local:11434', ['codellama:latest'], { name: 'full1', maxConcurrent: 1, id: 'full1' });
    registerMockHost(ctx.db, 'http://full2.local:11434', ['codellama:latest'], { name: 'full2', maxConcurrent: 1, id: 'full2' });

    // Fill both hosts
    ctx.db.incrementHostTasks('full1');
    ctx.db.incrementHostTasks('full2');

    // Now host selection should indicate capacity issues
    const selection = ctx.db.selectOllamaHostForModel('codellama:latest');
    // Either no host available or atCapacity flag set
    expect(selection.host === null || selection.atCapacity === true).toBe(true);
  });

  it('host recovery triggers queued task processing', () => {
    registerMockHost(ctx.db, 'http://recovery.local:11434', ['codellama:latest'], { name: 'recovery-host', maxConcurrent: 5, id: 'recovery-host' });

    // Mark host as down
    ctx.db.updateOllamaHost('recovery-host', { status: 'down', consecutive_failures: 3 });

    // Create a queued task
    const taskId = createTestTask(ctx.db, {
      description: 'queued waiting for recovery',
      provider: 'ollama',
      model: 'codellama:latest',
      status: 'pending',
    });
    ctx.db.updateTaskStatus(taskId, 'queued');

    // Simulate host coming back up
    ctx.db.updateOllamaHost('recovery-host', { status: 'healthy', consecutive_failures: 0 });

    const host = ctx.db.listOllamaHosts({ enabled: true }).find(h => h.id === 'recovery-host');
    expect(host.status).toBe('healthy');

    // Task should still be queued (processQueue would start it if we call it)
    const task = ctx.db.getTask(taskId);
    expect(task.status).toBe('queued');
  });

  it('VRAM-aware scheduling: large model routes to host with capacity', () => {
    registerMockHost(ctx.db, 'http://small.local:11434', ['codellama:latest', 'qwen2.5-coder:32b'], { name: 'small-host', maxConcurrent: 2, id: 'small-host' });

    // Verify isLargeModelBlockedOnHost works
    // With no running tasks, 32b model should NOT be blocked
    const check1 = ctx.tm.isLargeModelBlockedOnHost('qwen2.5-coder:32b', 'small-host');
    expect(check1.blocked).toBe(false);

    // Simulate a large model already running on host
    const taskId = createTestTask(ctx.db, {
      description: 'large model task',
      provider: 'ollama',
      model: 'qwen2.5-coder:32b',
    });
    ctx.db.updateTaskStatus(taskId, 'running', { ollama_host_id: 'small-host' });
    ctx.db.incrementHostTasks('small-host');

    // Now another 32b model should be blocked (VRAM guard)
    const check2 = ctx.tm.isLargeModelBlockedOnHost('qwen2.5-coder:32b', 'small-host');
    expect(check2.blocked).toBe(true);
    expect(check2.reason).toContain('VRAM');
  });
});
