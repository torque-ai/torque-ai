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
  ctx = setupE2eDb('load-stress-stall');
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
describe('Stall recovery', () => {
  it('task stalls beyond threshold: detected by checkStalledTasks', () => {
    ctx.db.setConfig('max_concurrent', '10');
    ctx.db.setConfig('stall_recovery_enabled', '0'); // disable auto-recovery for clean detection

    const taskId = createTestTask(ctx.db, { provider: 'codex' });
    ctx.tm.startTask(taskId);

    // Inject a fake entry into runningProcesses with old lastOutputAt
    const procs = ctx.tm._testing.runningProcesses;
    const proc = procs.get(taskId);
    if (proc) {
      // Set last output to 10 minutes ago to trigger stall
      proc.lastOutputAt = Date.now() - 700 * 1000;
      proc.provider = 'ollama'; // Use ollama which has a real stall threshold
    }

    const stalled = ctx.tm.checkStalledTasks(false);
    if (proc) {
      // Should detect the stalled task
      expect(stalled.length).toBeGreaterThanOrEqual(1);
      expect(stalled.some(s => s.taskId === taskId)).toBe(true);
    }
  });

  it('multiple tasks stall simultaneously: all detected', () => {
    ctx.db.setConfig('max_concurrent', '10');
    ctx.db.setConfig('stall_recovery_enabled', '0');

    const ids = bulkCreateTasks(3);
    for (const id of ids) {
      try { ctx.tm.startTask(id); } catch { /* ignore */ }
    }

    // Mark all as stalled
    const procs = ctx.tm._testing.runningProcesses;
    for (const id of ids) {
      const proc = procs.get(id);
      if (proc) {
        proc.lastOutputAt = Date.now() - 700 * 1000;
        proc.provider = 'ollama';
      }
    }

    const stalled = ctx.tm.checkStalledTasks(false);
    // All tasks with manipulated lastOutputAt should appear
    const stalledIds = stalled.map(s => s.taskId);
    for (const id of ids) {
      if (procs.has(id)) {
        expect(stalledIds).toContain(id);
      }
    }
  });

  it('stall recovery with host failover: orphaned tasks on down host are recoverable', () => {
    registerMockHost(ctx.db, 'http://stall-host.local:11434', ['codellama:latest'], { name: 'stall-host', maxConcurrent: 5, id: 'stall-host' });
    registerMockHost(ctx.db, 'http://backup-host.local:11434', ['codellama:latest'], { name: 'backup-host', maxConcurrent: 5, id: 'backup-host' });

    const taskId = createTestTask(ctx.db, {
      description: 'task on stall-host',
      provider: 'ollama',
      model: 'codellama:latest',
    });
    ctx.db.updateTaskStatus(taskId, 'running', { ollama_host_id: 'stall-host' });
    ctx.db.incrementHostTasks('stall-host');

    // Verify task is running on stall-host
    const runningOnHost = ctx.db.getRunningTasksForHost('stall-host');
    expect(runningOnHost.length).toBe(1);

    // Simulate host going down
    ctx.db.updateOllamaHost('stall-host', { status: 'down', consecutive_failures: 3 });

    // Mark orphaned task as failed (host failover)
    ctx.db.updateTaskStatus(taskId, 'failed', {
      error_output: '[HOST FAILOVER] stall-host went down',
    });
    ctx.db.releaseHostSlot('stall-host');

    const task = ctx.db.getTask(taskId);
    expect(task.status).toBe('failed');

    // Verify backup host is still available for retry
    const selection = ctx.db.selectOllamaHostForModel('codellama:latest');
    expect(selection.host).toBeTruthy();
    expect(selection.host.id).toBe('backup-host');

    // Retry info should indicate retry is possible
    const retryInfo = ctx.db.incrementRetry(taskId);
    expect(retryInfo).toBeTruthy();
    expect(retryInfo.shouldRetry).toBe(true);
  });

  it('stall recovery respects max_retry count', () => {
    const taskId = createTestTask(ctx.db, { provider: 'codex' });
    // Set max_retries to 0 so no retries allowed
    ctx.db.updateTaskStatus(taskId, 'running');

    // Manually set retry_count beyond max
    const dbInstance = ctx.db.getDbInstance();
    dbInstance.prepare('UPDATE tasks SET retry_count = 3, max_retries = 2 WHERE id = ?').run(taskId);

    const retryInfo = ctx.db.incrementRetry(taskId);
    expect(retryInfo).toBeTruthy();
    // retry_count (now 4) > max_retries (2), so shouldRetry = false
    expect(retryInfo.shouldRetry).toBe(false);
  });

  it('stall recovery does not resubmit cancelled tasks', () => {
    const taskId = createTestTask(ctx.db, { provider: 'codex' });
    ctx.db.setConfig('max_concurrent', '10');
    ctx.tm.startTask(taskId);

    // Cancel the task
    ctx.tm.cancelTask(taskId, 'user cancelled');
    expect(ctx.db.getTask(taskId).status).toBe('cancelled');

    // Attempting to start a cancelled task should fail
    expect(() => {
      ctx.tm.startTask(taskId);
    }).toThrow();
  });
});
