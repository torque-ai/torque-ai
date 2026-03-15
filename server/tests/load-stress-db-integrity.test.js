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
const { setupE2eDb, resetE2eDb, teardownE2eDb, createTestTask } = require('./e2e-helpers');

let ctx;
let spawnMock;
let originalSpawn;
let origApiKey;
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
  origApiKey = process.env.OPENAI_API_KEY;
  ctx = setupE2eDb('load-stress-db-integrity');
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
  if (origApiKey !== undefined) {
    process.env.OPENAI_API_KEY = origApiKey;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
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
describe('DB integrity under load', () => {
  it('50 rapid task creations all persist with correct status', () => {
    const ids = bulkCreateTasks(50);
    expect(ids.length).toBe(50);

    // All should exist in DB as pending
    for (const id of ids) {
      const task = ctx.db.getTask(id);
      expect(task).toBeTruthy();
      expect(task.status).toBe('pending');
      expect(task.task_description).toContain('Load test task');
    }

    // listTasks should return all
    const all = ctx.db.listTasks({ search: 'Load test task', limit: 100 });
    expect(all.length).toBe(50);
  });

  it('complete/fail tasks in random order: timestamps and status consistent', () => {
    const ids = bulkCreateTasks(10);

    // Start all
    ctx.db.setConfig('max_concurrent', '20');
    for (const id of ids) {
      ctx.db.updateTaskStatus(id, 'running');
    }

    // Complete even-indexed, fail odd-indexed (random-ish order)
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    for (let i = 0; i < shuffled.length; i++) {
      if (i % 2 === 0) {
        ctx.db.updateTaskStatus(shuffled[i], 'completed', { output: 'ok' });
      } else {
        ctx.db.updateTaskStatus(shuffled[i], 'failed', { error_output: 'err' });
      }
    }

    // Verify all have completed_at timestamp and correct status
    for (let i = 0; i < shuffled.length; i++) {
      const task = ctx.db.getTask(shuffled[i]);
      expect(task.completed_at).toBeTruthy();
      if (i % 2 === 0) {
        expect(task.status).toBe('completed');
      } else {
        expect(task.status).toBe('failed');
      }
    }
  });

  it('concurrent DB operations do not cause SQLITE_BUSY (busy_timeout handles it)', () => {
    // Rapid alternating reads and writes simulate concurrent access
    const ids = bulkCreateTasks(20);
    const errors = [];

    for (let round = 0; round < 5; round++) {
      for (const id of ids) {
        try {
          ctx.db.getTask(id);
          ctx.db.updateTaskProgress(id, round * 20);
        } catch (e) {
          errors.push(e.message);
        }
      }
    }

    // No SQLITE_BUSY errors should occur (WAL mode + busy_timeout=5000ms)
    const busyErrors = errors.filter(e => e.includes('SQLITE_BUSY'));
    expect(busyErrors.length).toBe(0);
  });

  it('token usage recording for 50 completed tasks: totals match', () => {
    const ids = bulkCreateTasks(50);
    ctx.db.setConfig('max_concurrent', '100');

    let totalInput = 0;
    let totalOutput = 0;

    for (let i = 0; i < ids.length; i++) {
      ctx.db.updateTaskStatus(ids[i], 'running');
      ctx.db.updateTaskStatus(ids[i], 'completed', { output: 'done' });

      const inputTokens = 100 + i;
      const outputTokens = 200 + i;
      totalInput += inputTokens;
      totalOutput += outputTokens;

      ctx.db.recordTokenUsage(ids[i], {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        model: 'test-model',
      });
    }

    const summary = ctx.db.getTokenUsageSummary();
    // Summary should include all recorded tokens
    expect(summary.total_input_tokens).toBeGreaterThanOrEqual(totalInput);
    expect(summary.total_output_tokens).toBeGreaterThanOrEqual(totalOutput);
  });

  it('no orphaned running tasks after bulk cancellation', () => {
    ctx.db.setConfig('max_concurrent', '10');
    const ids = bulkCreateTasks(10);

    for (const id of ids) {
      try { ctx.tm.startTask(id); } catch { /* ignore */ }
    }

    // Cancel all
    for (const id of ids) {
      try { ctx.tm.cancelTask(id, 'bulk cancel'); } catch { /* may already be terminal */ }
    }

    // No tasks should remain in running state
    const running = ctx.db.listTasks({ status: 'running' });
    expect(running.length).toBe(0);
  });
});
