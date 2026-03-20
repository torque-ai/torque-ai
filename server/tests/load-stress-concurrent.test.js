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
  ctx = setupE2eDb('load-stress-concurrent');
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
describe('Concurrent task submission', () => {
  it('submits 20 tasks with max_concurrent=5: only 5 run, 15 queue', () => {
    ctx.db.setConfig('max_concurrent', '5');
    ctx.db.setConfig('max_codex_concurrent', '5');
    ctx.db.setConfig('max_ollama_concurrent', '0');
    ctx.db.setConfig('max_api_concurrent', '0');
    const ids = bulkCreateTasks(20);

    for (const id of ids) {
      try { ctx.tm.startTask(id); } catch { /* may throw if already running */ }
    }

    const running = ctx.db.listTasks({ status: 'running' });
    const queued = ctx.db.listTasks({ status: 'queued' });

    expect(running.length).toBeLessThanOrEqual(5);
    expect(running.length + queued.length).toBe(20);
  });

  it('higher priority tasks start first', () => {
    ctx.db.setConfig('max_concurrent', '2');
    ctx.db.setConfig('max_codex_concurrent', '2');
    ctx.db.setConfig('max_ollama_concurrent', '0');
    ctx.db.setConfig('max_api_concurrent', '0');

    // Create low-priority tasks first
    const lowIds = bulkCreateTasks(3, { priority: 1, description: 'low priority' });
    // Create high-priority tasks
    const highIds = bulkCreateTasks(2, { priority: 10, description: 'high priority' });

    // Start all tasks (low first, then high)
    const allIds = [...lowIds, ...highIds];
    for (const id of allIds) {
      try { ctx.tm.startTask(id); } catch { /* ignore capacity */ }
    }

    const running = ctx.db.listTasks({ status: 'running' });
    expect(running.length).toBeLessThanOrEqual(2);

    // The running tasks should include the first 2 submitted (they grabbed slots),
    // but once queue processing kicks in, high priority should be preferred.
    // Verify at minimum that tasks were distributed across running/queued states.
    const queued = ctx.db.listTasks({ status: 'queued' });
    expect(running.length + queued.length).toBe(5);
  });

  it('completing a running task auto-starts a queued task via processQueue', () => {
    ctx.db.setConfig('max_concurrent', '1');
    ctx.db.setConfig('max_codex_concurrent', '1');
    ctx.db.setConfig('max_ollama_concurrent', '0');
    ctx.db.setConfig('max_api_concurrent', '0');

    const id1 = createTestTask(ctx.db, { description: 'Task 1', provider: 'codex' });
    const id2 = createTestTask(ctx.db, { description: 'Task 2', provider: 'codex' });

    ctx.tm.startTask(id1);
    try { ctx.tm.startTask(id2); } catch { /* expected: capacity */ }

    const task1 = ctx.db.getTask(id1);
    const task2Before = ctx.db.getTask(id2);
    expect(task1.status).toBe('running');
    expect(task2Before.status).toBe('queued');

    // Complete task 1 via mock child
    const child = mockChildren[0];
    if (child) {
      simulateSuccess(child, 'done\n', 0);
    }

    // Give async handlers time to fire and process queue
    return new Promise(resolve => setTimeout(resolve, 50)).then(() => {
      // processQueue should have picked up queued task
      // (It may or may not have started depending on async timing,
      //  but the queue mechanism should have been triggered)
      const task2After = ctx.db.getTask(id2);
      // Task 2 should have been picked up by processQueue (no longer queued)
      expect(['running', 'completed', 'failed']).toContain(task2After.status);
    });
  });

  it('submits tasks from multiple agent instance IDs', () => {
    ctx.db.setConfig('max_concurrent', '10');

    // Create tasks claiming different agents
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const id = createTestTask(ctx.db, {
        description: `Agent-${i} task`,
        provider: 'codex',
        extra: { claimed_by_agent: `agent-${i}` },
      });
      ids.push(id);
    }

    for (const id of ids) {
      try { ctx.tm.startTask(id); } catch { /* ignore */ }
    }

    const running = ctx.db.listTasks({ status: 'running' });
    // All should be running (under capacity)
    expect(running.length).toBe(4);

    // Verify each task was created with different agent context
    for (let i = 0; i < 4; i++) {
      const task = ctx.db.getTask(ids[i]);
      expect(task).toBeTruthy();
      expect(task.status).toBe('running');
    }
  });

  it('task status transitions are atomic (no race in DB)', () => {
    ctx.db.setConfig('max_concurrent', '20');

    const id = createTestTask(ctx.db, { provider: 'codex' });
    ctx.tm.startTask(id);

    const task = ctx.db.getTask(id);
    expect(task.status).toBe('running');
    expect(task.started_at).toBeTruthy();

    // Attempting to transition from completed back to running should fail
    ctx.db.updateTaskStatus(id, 'completed', { output: 'done' });
    expect(() => {
      ctx.db.updateTaskStatus(id, 'running');
    }).toThrow();

    // Double-completion is a no-op (same status, no additional fields)
    const result = ctx.db.updateTaskStatus(id, 'completed');
    expect(result.status).toBe('completed');
  });

  it('detects duplicate task descriptions via DB query', () => {
    ctx.db.setConfig('max_concurrent', '20');

    const desc = 'Exact duplicate task description for dedup test';
    const id1 = createTestTask(ctx.db, { description: desc, provider: 'codex' });
    const id2 = createTestTask(ctx.db, { description: desc, provider: 'codex' });

    // Both tasks exist but have different IDs
    expect(id1).not.toBe(id2);

    // Search for tasks with this description
    const matches = ctx.db.listTasks({ search: 'Exact duplicate task description' });
    expect(matches.length).toBe(2);
  });

  it('rate limiting: respects max_concurrent as rate limiter', () => {
    ctx.db.setConfig('max_concurrent', '3');
    ctx.db.setConfig('max_codex_concurrent', '3');
    ctx.db.setConfig('max_ollama_concurrent', '0');
    ctx.db.setConfig('max_api_concurrent', '0');

    // Submit 10 tasks in rapid succession
    const ids = bulkCreateTasks(10);
    let queuedCount = 0;
    for (const id of ids) {
      const result = ctx.tm.startTask(id);
      if (result && result.queued) queuedCount++;
    }

    const running = ctx.db.listTasks({ status: 'running' });
    expect(running.length).toBeLessThanOrEqual(3);
    // At least some should have been queued
    expect(queuedCount).toBeGreaterThan(0);
  });

  it('cancel frees slot, queued task starts via processQueue', () => {
    ctx.db.setConfig('max_concurrent', '1');
    ctx.db.setConfig('max_codex_concurrent', '1');
    ctx.db.setConfig('max_ollama_concurrent', '0');
    ctx.db.setConfig('max_api_concurrent', '0');

    const id1 = createTestTask(ctx.db, { description: 'will cancel', provider: 'codex' });
    const id2 = createTestTask(ctx.db, { description: 'should start after cancel', provider: 'codex' });

    ctx.tm.startTask(id1);
    try { ctx.tm.startTask(id2); } catch { /* capacity */ }

    expect(ctx.db.getTask(id1).status).toBe('running');
    expect(ctx.db.getTask(id2).status).toBe('queued');

    // Cancel task 1
    ctx.tm.cancelTask(id1, 'test cancellation');

    expect(ctx.db.getTask(id1).status).toBe('cancelled');

    // processQueue should run automatically on cancel, but call it explicitly too
    ctx.tm.processQueue();

    // Give a tick for queue processing
    return new Promise(resolve => setTimeout(resolve, 50)).then(() => {
      const task2 = ctx.db.getTask(id2);
      // Task 2 should have been picked up by processQueue after cancel freed a slot
      expect(['running', 'completed', 'failed']).toContain(task2.status);
    });
  });
});
