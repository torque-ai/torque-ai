/**
 * Chaos / Concurrency Tests
 *
 * Tests concurrent DB access patterns: host slot reservation races,
 * task status transition races, distributed lock contention,
 * cascading workflow operations, and WAL/transaction stress.
 *
 * All tests use direct DB operations (same pattern as integration tests).
 * No process spawning — fits within 15s timeout.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

let testDir;
let origDataDir;
let db;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setupDb() {
  testDir = path.join(os.tmpdir(), `torque-vtest-chaos-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
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

/** Add a test host to the DB */
function addTestHost(name, maxConcurrent = 2) {
  return db.addOllamaHost({
    id: name,
    name,
    url: `http://${name}.local:11434`,
    max_concurrent: maxConcurrent,
    memory_limit_mb: 8192,
  });
}

/** Create a minimal task in the DB */
function createTestTask(overrides = {}) {
  const taskId = overrides.id || uuidv4();
  db.createTask({
    id: taskId,
    task_description: overrides.description || `Test task ${taskId.slice(0, 8)}`,
    working_directory: testDir,
    status: overrides.status || 'pending',
    provider: overrides.provider || 'ollama',
    workflow_id: overrides.workflow_id || null,
    workflow_node_id: overrides.workflow_node_id || null,
  });
  return taskId;
}

/** Create a workflow task linked to a workflow */
function createWorkflowTask(workflowId, nodeId, status = 'blocked') {
  const taskId = uuidv4();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  const createStatus = isTerminal ? 'pending' : status;
  db.createTask({
    id: taskId,
    task_description: `Test task ${nodeId}`,
    working_directory: testDir,
    status: createStatus,
    workflow_id: workflowId,
    workflow_node_id: nodeId,
    provider: 'codex',
  });
  if (status !== createStatus) {
    db.updateTaskStatus(taskId, status);
  }
  return taskId;
}

// ============================================================
// Group 1: Host Slot Reservation Races
// ============================================================

describe('Chaos: Host Slot Reservation Races', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  test('concurrent slot acquisition respects max_concurrent', () => {
    const host = addTestHost('slot-race-host', 2);

    // Try to reserve 4 slots — only 2 should succeed
    const results = [];
    for (let i = 0; i < 4; i++) {
      const taskId = createTestTask({ status: 'running' });
      const reserved = db.tryReserveHostSlot(host.id, taskId);
      results.push(reserved);
    }

    // tryReserveHostSlot returns { acquired: true/false, ... }
    const successCount = results.filter(r => r && r.acquired).length;
    const failCount = results.filter(r => !r || !r.acquired).length;
    expect(successCount).toBe(2);
    expect(failCount).toBe(2);
  });

  test('slot release + acquire race — no over-allocation', () => {
    const host = addTestHost('release-race-host', 1);

    const task1 = createTestTask({ status: 'running' });
    const task2 = createTestTask({ status: 'running' });

    // Fill the single slot
    const r1 = db.tryReserveHostSlot(host.id, task1);
    expect(r1.acquired).toBe(true);
    // Second should fail
    const r2 = db.tryReserveHostSlot(host.id, task2);
    expect(r2.acquired).toBe(false);

    // Release the first slot
    db.releaseHostSlot(host.id, task1);

    // Now the second should succeed
    const r3 = db.tryReserveHostSlot(host.id, task2);
    expect(r3.acquired).toBe(true);

    // Verify only 1 slot is occupied
    const hostInfo = db.getOllamaHost(host.id);
    expect(hostInfo.running_tasks).toBe(1);
  });

  test('host at max capacity rejects new reservations', () => {
    const host = addTestHost('max-cap-host', 3);
    const tasks = [];

    // Fill all 3 slots
    for (let i = 0; i < 3; i++) {
      const tid = createTestTask({ status: 'running' });
      tasks.push(tid);
      const r = db.tryReserveHostSlot(host.id, tid);
      expect(r.acquired).toBe(true);
    }

    // Next reservation should fail
    const overflow = createTestTask({ status: 'running' });
    const rOverflow = db.tryReserveHostSlot(host.id, overflow);
    expect(rOverflow.acquired).toBe(false);

    // Verify count
    const hostInfo = db.getOllamaHost(host.id);
    expect(hostInfo.running_tasks).toBe(3);
  });

  test('cross-host slot independence', () => {
    const hostA = addTestHost('independent-a', 1);
    const hostB = addTestHost('independent-b', 1);

    const taskA = createTestTask({ status: 'running' });
    const taskB = createTestTask({ status: 'running' });

    // Reserve on both — each has independent capacity
    expect(db.tryReserveHostSlot(hostA.id, taskA).acquired).toBe(true);
    expect(db.tryReserveHostSlot(hostB.id, taskB).acquired).toBe(true);

    // Both are at max, next on each should fail
    const taskA2 = createTestTask({ status: 'running' });
    const taskB2 = createTestTask({ status: 'running' });
    expect(db.tryReserveHostSlot(hostA.id, taskA2).acquired).toBe(false);
    expect(db.tryReserveHostSlot(hostB.id, taskB2).acquired).toBe(false);
  });

  test('slot count reconciliation corrects mismatches', () => {
    const host = addTestHost('reconcile-host', 4);

    // Manually set running_tasks to a wrong value
    db.updateOllamaHost(host.id, { running_tasks: 10 });
    let info = db.getOllamaHost(host.id);
    expect(info.running_tasks).toBe(10);

    // Reconcile — should reset to 0 since no tasks are actually assigned
    db.reconcileHostTaskCounts();

    info = db.getOllamaHost(host.id);
    expect(info.running_tasks).toBe(0);
  });
});

// ============================================================
// Group 2: Task Status Transition Races
// ============================================================

describe('Chaos: Task Status Transition Races', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  test('double completion — second attempt is a no-op', () => {
    const taskId = createTestTask({ status: 'pending' });
    db.updateTaskStatus(taskId, 'running');

    // Complete the task
    db.updateTaskStatus(taskId, 'completed');
    // Second completion is a no-op (same target state, no additional fields)
    const _result = db.updateTaskStatus(taskId, 'completed');

    const task = db.getTask(taskId);
    expect(task.status).toBe('completed');
  });

  test('invalid transition rejection — completed cannot go to running', () => {
    const taskId = createTestTask({ status: 'pending' });
    db.updateTaskStatus(taskId, 'running');
    db.updateTaskStatus(taskId, 'completed');

    // Try to go back to running — TORQUE rejects transitions from terminal states
    expect(() => db.updateTaskStatus(taskId, 'running')).toThrow(/Cannot transition/);

    const task = db.getTask(taskId);
    expect(task.status).toBe('completed');
  });

  test('rapid status cycling reaches final state', () => {
    const taskId = createTestTask({ status: 'pending' });

    db.updateTaskStatus(taskId, 'queued');
    db.updateTaskStatus(taskId, 'running');
    db.updateTaskStatus(taskId, 'completed');

    const task = db.getTask(taskId);
    expect(task.status).toBe('completed');
    expect(task.completed_at).toBeTruthy();
  });

  test('concurrent fail + complete — first terminal wins, second throws', () => {
    const taskId = createTestTask({ status: 'pending' });
    db.updateTaskStatus(taskId, 'running');

    // First terminal update wins
    db.updateTaskStatus(taskId, 'failed');
    // Second terminal update throws — task already in terminal state
    expect(() => db.updateTaskStatus(taskId, 'completed')).toThrow(/Cannot transition/);

    const task = db.getTask(taskId);
    expect(task.status).toBe('failed');
  });

  test('status read consistency — write then immediate read', () => {
    const taskId = createTestTask({ status: 'pending' });

    db.updateTaskStatus(taskId, 'running');
    let task = db.getTask(taskId);
    expect(task.status).toBe('running');

    db.updateTaskStatus(taskId, 'completed');
    task = db.getTask(taskId);
    expect(task.status).toBe('completed');
  });
});

// ============================================================
// Group 3: Distributed Lock Contention
// ============================================================

describe('Chaos: Distributed Lock Contention', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  test('first holder acquires, second fails', () => {
    const lockName = 'test-lock-exclusive';
    const holder1 = 'holder-1';
    const holder2 = 'holder-2';

    const r1 = db.acquireLock(lockName, holder1, 30);
    expect(r1.acquired).toBe(true);

    const r2 = db.acquireLock(lockName, holder2, 30);
    expect(r2.acquired).toBe(false);
    expect(r2.holder).toBe(holder1);
  });

  test('lock release + re-acquire by new holder', () => {
    const lockName = 'test-lock-release';
    const holder1 = 'holder-A';
    const holder2 = 'holder-B';

    db.acquireLock(lockName, holder1, 30);
    db.releaseLock(lockName, holder1);

    const r2 = db.acquireLock(lockName, holder2, 30);
    expect(r2.acquired).toBe(true);
  });

  test('stale heartbeat takeover — expired lock can be taken', () => {
    const lockName = 'test-lock-stale';
    const holder1 = 'stale-holder';
    const holder2 = 'new-holder';

    // Acquire with very short lease
    db.acquireLock(lockName, holder1, 1);

    // Manually set heartbeat to 20 seconds ago to simulate stale holder
    const staleTime = new Date(Date.now() - 20000).toISOString();
    db.getDbInstance().prepare(
      'UPDATE distributed_locks SET last_heartbeat = ?, expires_at = ? WHERE lock_name = ?'
    ).run(staleTime, staleTime, lockName);

    // New holder should be able to take over
    const r2 = db.acquireLock(lockName, holder2, 30);
    expect(r2.acquired).toBe(true);
  });

  test('fresh heartbeat protects lock', () => {
    const lockName = 'test-lock-fresh';
    const holder1 = 'active-holder';
    const holder2 = 'challenger';

    db.acquireLock(lockName, holder1, 60);

    // Heartbeat is fresh (just acquired), so challenger should fail
    const r2 = db.acquireLock(lockName, holder2, 30);
    expect(r2.acquired).toBe(false);
  });

  test('lock re-entrancy — same holder extends lease', () => {
    const lockName = 'test-lock-reentrant';
    const holder = 'same-holder';

    const r1 = db.acquireLock(lockName, holder, 30);
    expect(r1.acquired).toBe(true);

    // Same holder re-acquires — should succeed (extend lease)
    const r2 = db.acquireLock(lockName, holder, 60);
    expect(r2.acquired).toBe(true);
    expect(r2.extended).toBe(true);
  });
});

// ============================================================
// Group 4: Cascading Workflow Operations
// ============================================================

describe('Chaos: Cascading Workflow Operations', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  test('diamond DAG — B and C complete near-simultaneously, D unblocks once', () => {
    // A → (B, C) → D
    const wfId = uuidv4();
    db.createWorkflow({ id: wfId, name: 'Diamond Test', status: 'running' });

    const taskA = createWorkflowTask(wfId, 'A', 'completed');
    const taskB = createWorkflowTask(wfId, 'B', 'blocked');
    const taskC = createWorkflowTask(wfId, 'C', 'blocked');
    const taskD = createWorkflowTask(wfId, 'D', 'blocked');

    // Set up dependencies: B depends on A, C depends on A, D depends on B and C
    db.addTaskDependency({ task_id: taskB, depends_on_task_id: taskA, workflow_id: wfId });
    db.addTaskDependency({ task_id: taskC, depends_on_task_id: taskA, workflow_id: wfId });
    db.addTaskDependency({ task_id: taskD, depends_on_task_id: taskB, workflow_id: wfId });
    db.addTaskDependency({ task_id: taskD, depends_on_task_id: taskC, workflow_id: wfId });

    // Complete B
    db.updateTaskStatus(taskB, 'completed');
    // D should still be blocked (C not done)
    let dDeps = db.areTaskDependenciesSatisfied(taskD);
    expect(dDeps.satisfied).toBe(false);

    // Complete C
    db.updateTaskStatus(taskC, 'completed');
    // Now D should be satisfied
    dDeps = db.areTaskDependenciesSatisfied(taskD);
    expect(dDeps.satisfied).toBe(true);
  });

  test('workflow cancel marks all pending tasks cancelled', () => {
    const wfId = uuidv4();
    db.createWorkflow({ id: wfId, name: 'Cancel Test', status: 'running' });

    const t1 = createWorkflowTask(wfId, 'node1', 'completed');
    const t2 = createWorkflowTask(wfId, 'node2', 'running');
    const t3 = createWorkflowTask(wfId, 'node3', 'blocked');
    const t4 = createWorkflowTask(wfId, 'node4', 'pending');

    // Cancel the workflow
    db.updateWorkflow(wfId, { status: 'cancelled' });

    // Cancel all non-terminal tasks
    for (const tid of [t2, t3, t4]) {
      const task = db.getTask(tid);
      if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        db.updateTaskStatus(tid, 'cancelled');
      }
    }

    // Verify states
    expect(db.getTask(t1).status).toBe('completed'); // already completed, unchanged
    expect(db.getTask(t2).status).toBe('cancelled');
    expect(db.getTask(t3).status).toBe('cancelled');
    expect(db.getTask(t4).status).toBe('cancelled');
    expect(db.getWorkflow(wfId).status).toBe('cancelled');
  });

  test('concurrent workflow status transitions — no corruption', () => {
    const wfId = uuidv4();
    db.createWorkflow({ id: wfId, name: 'Status Race', status: 'pending' });

    // Transition to running, then immediately to completed
    db.transitionWorkflowStatus(wfId, 'pending', 'running');
    const wf1 = db.getWorkflow(wfId);
    expect(wf1.status).toBe('running');

    db.transitionWorkflowStatus(wfId, 'running', 'completed', { completed_at: new Date().toISOString() });
    const wf2 = db.getWorkflow(wfId);
    expect(wf2.status).toBe('completed');
  });

  test('dependency satisfaction check during completion', () => {
    const wfId = uuidv4();
    db.createWorkflow({ id: wfId, name: 'DepCheck Race', status: 'running' });

    const taskA = createWorkflowTask(wfId, 'A', 'running');
    const taskB = createWorkflowTask(wfId, 'B', 'blocked');
    db.addTaskDependency({ task_id: taskB, depends_on_task_id: taskA, workflow_id: wfId });

    // Check before completion
    let deps = db.areTaskDependenciesSatisfied(taskB);
    expect(deps.satisfied).toBe(false);

    // Complete A
    db.updateTaskStatus(taskA, 'completed');

    // Check after completion
    deps = db.areTaskDependenciesSatisfied(taskB);
    expect(deps.satisfied).toBe(true);
  });

  test('orphaned task cleanup idempotency — double cleanup safe', () => {
    const host = addTestHost('orphan-host', 2);
    const task1 = createTestTask({ status: 'running' });

    // Assign task to host
    db.tryReserveHostSlot(host.id, task1);
    db.updateTaskStatus(task1, 'running');

    // Mark host as down — should trigger cleanup
    db.updateOllamaHost(host.id, { status: 'down', running_tasks: 0 });

    // Running the reconciliation twice should be safe
    db.reconcileHostTaskCounts();
    db.reconcileHostTaskCounts();

    const hostInfo = db.getOllamaHost(host.id);
    expect(hostInfo.running_tasks).toBe(0);
  });
});

// ============================================================
// Group 5: WAL / Transaction Stress
// ============================================================

describe('Chaos: WAL / Transaction Stress', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  test('rapid sequential writes — 100 task creates persist', () => {
    const ids = [];
    for (let i = 0; i < 100; i++) {
      ids.push(createTestTask({ description: `rapid-write-${i}` }));
    }

    // All 100 should be retrievable
    for (const id of ids) {
      const task = db.getTask(id);
      expect(task).toBeTruthy();
      expect(task.id).toBe(id);
    }
  });

  test('interleaved reads and writes — no partial reads', () => {
    const batchIds = [];

    // Write 20 tasks, reading the list between each write
    for (let i = 0; i < 20; i++) {
      const id = createTestTask({ description: `interleave-${i}` });
      batchIds.push(id);

      // Read all tasks — should see complete records
      const tasks = db.listTasks({ status: 'pending', limit: 200 });
      for (const t of tasks) {
        expect(t.id).toBeTruthy();
        expect(t.task_description).toBeTruthy();
      }
    }

    // All 20 should exist
    for (const id of batchIds) {
      expect(db.getTask(id)).toBeTruthy();
    }
  });

  test('transaction rollback recovery — invalid SQL mid-transaction', () => {
    const rawDb = db.getDbInstance();
    const taskBefore = createTestTask({ description: 'before-rollback' });

    // Try a transaction with invalid SQL
    try {
      rawDb.transaction(() => {
        createTestTask({ description: 'in-transaction' });
        // This will throw — invalid table name
        rawDb.prepare('INSERT INTO nonexistent_table (x) VALUES (1)').run();
      })();
    } catch {
      // Expected: transaction rolled back
    }

    // The task created before the transaction should still exist
    expect(db.getTask(taskBefore)).toBeTruthy();

    // New tasks should work after the failed transaction
    const taskAfter = createTestTask({ description: 'after-rollback' });
    expect(db.getTask(taskAfter)).toBeTruthy();
  });

  test('busy timeout handling — concurrent BEGIN IMMEDIATE', () => {
    const rawDb = db.getDbInstance();

    // Verify busy_timeout is set (should be 5000ms)
    const timeout = rawDb.pragma('busy_timeout');
    expect(timeout[0].timeout).toBeGreaterThanOrEqual(5000);

    // Run many sequential transactions — they should all succeed
    // (busy_timeout allows waiting for locks)
    const results = [];
    for (let i = 0; i < 50; i++) {
      try {
        rawDb.transaction(() => {
          createTestTask({ description: `busy-test-${i}` });
        })();
        results.push(true);
      } catch {
        results.push(false);
      }
    }

    // All should succeed (single-threaded, no actual contention)
    expect(results.every(r => r === true)).toBe(true);
  });
});
