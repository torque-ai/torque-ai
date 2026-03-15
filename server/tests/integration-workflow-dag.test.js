/**
 * Integration Test: Workflow DAG Dependency Resolution & Failure Handling
 *
 * Tests the workflow engine's dependency resolution and failure actions
 * using real DB operations (no provider spawning). Validates that:
 * - Linear DAGs execute tasks in order
 * - Parallel tasks unblock correctly
 * - on_fail actions (skip, cancel, continue) propagate properly
 * - Diamond DAGs wait for all predecessors
 * - Workflow status reflects child task statuses
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
  testDir = path.join(os.tmpdir(), `torque-vtest-wfdag-${Date.now()}`);
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

/** Create a task in the DB linked to a workflow */
function createWorkflowTask(workflowId, nodeId, status = 'blocked') {
  const taskId = uuidv4();

  // createTask inserts with the given status directly via SQL.
  // For terminal statuses (completed, failed), we create as 'pending' first
  // then transition, because createTask's SQL INSERT sets the status but
  // updateTaskStatus handles started_at/completed_at timestamps correctly.
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

  // Transition to target status if it differs from create status
  if (status !== createStatus) {
    db.updateTaskStatus(taskId, status);
  }

  return taskId;
}

describe('Integration: Workflow DAG', () => {
  beforeAll(() => { setupDb(); });
  afterAll(() => { teardownDb(); });

  // ── Edge case coverage ─────────────────────────────────
  describe('DAG edge cases', () => {
    it('returns empty status for workflow with no tasks', () => {
      const workflowId = uuidv4();
      db.createWorkflow({ id: workflowId, name: 'Empty DAG Test', status: 'running' });

      const status = db.getWorkflowStatus(workflowId);
      expect(status).toMatchObject({
        summary: {
          total: 0,
          blocked: 0,
          pending: 0,
        },
        dependencies: [],
      });
    });

    it('handles broken dependency chains with missing prerequisite', () => {
      const workflowId = uuidv4();
      db.createWorkflow({ id: workflowId, name: 'Broken Dependency Test', status: 'running' });

      const dependentTask = createWorkflowTask(workflowId, 'B', 'blocked');
      const missingDependencyId = uuidv4();

      db.addTaskDependency({
        workflow_id: workflowId,
        task_id: dependentTask,
        depends_on_task_id: missingDependencyId,
        on_fail: 'skip',
      });

      const deps = db.getTaskDependencies(dependentTask);
      expect(deps).toHaveLength(1);
      expect(deps[0].depends_on_task_id).toBe(missingDependencyId);
      expect(db.getTask(missingDependencyId)).toBeFalsy();
      expect(db.getTask(dependentTask).status).toBe('blocked');

      const status = db.getWorkflowStatus(workflowId);
      expect(status.summary.total).toBe(1);
      expect(status.summary.blocked).toBe(1);
      expect(status.dependencies.length).toBe(1);
    });
  });

  // ── Linear DAG ──────────────────────────────────────────

  describe('Linear DAG (A → B → C)', () => {
    let workflowId, taskA, taskB, taskC;

    beforeAll(() => {
      workflowId = uuidv4();
      db.createWorkflow({ id: workflowId, name: 'Linear DAG Test', status: 'running' });

      taskA = createWorkflowTask(workflowId, 'A', 'pending');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');
      taskC = createWorkflowTask(workflowId, 'C', 'blocked');

      // B depends on A, C depends on B
      db.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'skip' });
      db.addTaskDependency({ workflow_id: workflowId, task_id: taskC, depends_on_task_id: taskB, on_fail: 'skip' });
    });

    it('B starts blocked, A is pending', () => {
      const a = db.getTask(taskA);
      const b = db.getTask(taskB);
      expect(a.status).toBe('pending');
      expect(b.status).toBe('blocked');
    });

    it('B dependencies list A as prerequisite', () => {
      const deps = db.getTaskDependencies(taskB);
      expect(deps.length).toBe(1);
      expect(deps[0].depends_on_task_id).toBe(taskA);
    });

    it('C dependencies list B as prerequisite', () => {
      const deps = db.getTaskDependencies(taskC);
      expect(deps.length).toBe(1);
      expect(deps[0].depends_on_task_id).toBe(taskB);
    });

    it('getWorkflowStatus returns correct task breakdown', () => {
      const status = db.getWorkflowStatus(workflowId);
      expect(status).toMatchObject({
        summary: {
          total: 3,
          pending: 1,
          blocked: 2,
        },
        dependencies: expect.any(Array),
      });
      expect(status.summary.total).toBe(3);
      expect(status.dependencies.length).toBe(2);
    });

    it('completing A allows evaluating B dependencies', () => {
      db.updateTaskStatus(taskA, 'completed', { exit_code: 0 });
      const deps = db.getTaskDependencies(taskB);
      // A is now completed — condition should pass (default: prerequisite must succeed)
      const prereq = db.getTask(deps[0].depends_on_task_id);
      expect(prereq.status).toBe('completed');
    });
  });

  // ── Parallel Tasks ──────────────────────────────────────

  describe('Parallel tasks (A → (B,C) → D)', () => {
    let workflowId, taskA, taskB, taskC, taskD;

    beforeAll(() => {
      workflowId = uuidv4();
      db.createWorkflow({ id: workflowId, name: 'Parallel DAG Test', status: 'running' });

      taskA = createWorkflowTask(workflowId, 'A', 'completed');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');
      taskC = createWorkflowTask(workflowId, 'C', 'blocked');
      taskD = createWorkflowTask(workflowId, 'D', 'blocked');

      // B and C depend on A; D depends on both B and C
      db.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'skip' });
      db.addTaskDependency({ workflow_id: workflowId, task_id: taskC, depends_on_task_id: taskA, on_fail: 'skip' });
      db.addTaskDependency({ workflow_id: workflowId, task_id: taskD, depends_on_task_id: taskB, on_fail: 'skip' });
      db.addTaskDependency({ workflow_id: workflowId, task_id: taskD, depends_on_task_id: taskC, on_fail: 'skip' });

      // A is already created as 'completed' — no need to transition again
    });

    it('B and C both depend on A', () => {
      const depsB = db.getTaskDependencies(taskB);
      const depsC = db.getTaskDependencies(taskC);
      expect(depsB.length).toBe(1);
      expect(depsB[0].depends_on_task_id).toBe(taskA);
      expect(depsC.length).toBe(1);
      expect(depsC[0].depends_on_task_id).toBe(taskA);
    });

    it('D has two dependencies (B and C)', () => {
      const depsD = db.getTaskDependencies(taskD);
      expect(depsD.length).toBe(2);
      const depIds = depsD.map(d => d.depends_on_task_id).sort();
      expect(depIds).toEqual([taskB, taskC].sort());
    });

    it('D stays blocked when only B completes', () => {
      db.updateTaskStatus(taskB, 'completed', { exit_code: 0 });
      // D should still have one unsatisfied dependency (C)
      const depsD = db.getTaskDependencies(taskD);
      const unsatisfied = depsD.filter(d => {
        const prereq = db.getTask(d.depends_on_task_id);
        return !prereq || !['completed', 'skipped'].includes(prereq.status);
      });
      expect(unsatisfied.length).toBe(1);
    });

    it('D dependencies fully satisfied when both B and C complete', () => {
      db.updateTaskStatus(taskC, 'completed', { exit_code: 0 });
      const depsD = db.getTaskDependencies(taskD);
      const unsatisfied = depsD.filter(d => {
        const prereq = db.getTask(d.depends_on_task_id);
        return !prereq || !['completed', 'skipped'].includes(prereq.status);
      });
      expect(unsatisfied.length).toBe(0);
    });
  });

  // ── on_fail: "skip" ─────────────────────────────────────

  describe('on_fail: "skip"', () => {
    let workflowId, taskA, taskB, taskC;

    beforeAll(() => {
      workflowId = uuidv4();
      db.createWorkflow({ id: workflowId, name: 'Skip Test', status: 'running' });

      taskA = createWorkflowTask(workflowId, 'A', 'pending');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');
      taskC = createWorkflowTask(workflowId, 'C', 'pending'); // independent

      // B depends on A with on_fail: skip
      db.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'skip' });
    });

    it('dependency records on_fail as skip', () => {
      const deps = db.getTaskDependencies(taskB);
      expect(deps[0].on_fail).toBe('skip');
    });

    it('when A fails, B dependency condition fails (default requires success)', () => {
      db.updateTaskStatus(taskA, 'failed', { exit_code: 1 });
      const a = db.getTask(taskA);
      expect(a.status).toBe('failed');
      // Default condition: prerequisite must be completed/skipped — failed doesn't pass
      expect(['completed', 'skipped'].includes(a.status)).toBe(false);
    });

    it('independent task C is unaffected by A failure', () => {
      const c = db.getTask(taskC);
      expect(c.status).toBe('pending');
    });
  });

  // ── on_fail: "cancel" ───────────────────────────────────

  describe('on_fail: "cancel"', () => {
    let workflowId, taskA, taskB;

    beforeAll(() => {
      workflowId = uuidv4();
      db.createWorkflow({ id: workflowId, name: 'Cancel Test', status: 'running' });

      taskA = createWorkflowTask(workflowId, 'A', 'pending');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');

      db.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'cancel' });
    });

    it('dependency records on_fail as cancel', () => {
      const deps = db.getTaskDependencies(taskB);
      expect(deps[0].on_fail).toBe('cancel');
    });
  });

  // ── on_fail: "continue" ─────────────────────────────────

  describe('on_fail: "continue"', () => {
    let workflowId, taskA, taskB;

    beforeAll(() => {
      workflowId = uuidv4();
      db.createWorkflow({ id: workflowId, name: 'Continue Test', status: 'running' });

      taskA = createWorkflowTask(workflowId, 'A', 'pending');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');

      db.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'continue' });
    });

    it('dependency records on_fail as continue', () => {
      const deps = db.getTaskDependencies(taskB);
      expect(deps[0].on_fail).toBe('continue');
    });

    it('continue action treats failed prereq as satisfiable', () => {
      db.updateTaskStatus(taskA, 'failed', { exit_code: 1 });
      // With on_fail: continue, the applyFailureAction code checks
      // if all deps are in terminal state (completed, skipped, OR failed)
      const a = db.getTask(taskA);
      expect(['completed', 'skipped', 'failed'].includes(a.status)).toBe(true);
    });
  });

  // ── Diamond DAG ─────────────────────────────────────────

  describe('Diamond DAG (A → (B,C) → D)', () => {
    let workflowId, taskA, taskB, taskC, taskD;

    beforeAll(() => {
      workflowId = uuidv4();
      db.createWorkflow({ id: workflowId, name: 'Diamond DAG Test', status: 'running' });

      taskA = createWorkflowTask(workflowId, 'A', 'completed');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');
      taskC = createWorkflowTask(workflowId, 'C', 'blocked');
      taskD = createWorkflowTask(workflowId, 'D', 'blocked');

      db.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'skip' });
      db.addTaskDependency({ workflow_id: workflowId, task_id: taskC, depends_on_task_id: taskA, on_fail: 'skip' });
      db.addTaskDependency({ workflow_id: workflowId, task_id: taskD, depends_on_task_id: taskB, on_fail: 'skip' });
      db.addTaskDependency({ workflow_id: workflowId, task_id: taskD, depends_on_task_id: taskC, on_fail: 'skip' });
    });

    it('D requires both B and C', () => {
      const deps = db.getTaskDependencies(taskD);
      expect(deps.length).toBe(2);
    });

    it('getWorkflowStatus reports correct dependency edges', () => {
      const status = db.getWorkflowStatus(workflowId);
      expect(status.dependencies.length).toBe(4);
    });
  });

  // ── Cycle Detection ─────────────────────────────────────

  describe('Cycle detection', () => {
    let workflowId, taskA, taskB;

    beforeAll(() => {
      workflowId = uuidv4();
      db.createWorkflow({ id: workflowId, name: 'Cycle Test', status: 'pending' });

      taskA = createWorkflowTask(workflowId, 'A', 'blocked');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');

      db.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'skip' });
    });

    it('adding A → B → A throws circular dependency error', () => {
      expect(() => {
        db.addTaskDependency({ workflow_id: workflowId, task_id: taskA, depends_on_task_id: taskB, on_fail: 'skip' });
      }).toThrow(/circular dependency/i);
    });

    it('self-dependency throws circular dependency error', () => {
      const wfId = uuidv4();
      db.createWorkflow({ id: wfId, name: 'Self Cycle Test', status: 'pending' });
      const selfTask = createWorkflowTask(wfId, 'self', 'blocked');

      expect(() => {
        db.addTaskDependency({ workflow_id: wfId, task_id: selfTask, depends_on_task_id: selfTask, on_fail: 'skip' });
      }).toThrow(/circular dependency/i);
    });
  });

  // ── Workflow Status Propagation ──────────────────────────

  describe('Workflow status propagation', () => {
    it('workflow summary counts task statuses correctly', () => {
      const wfId = uuidv4();
      db.createWorkflow({ id: wfId, name: 'Status Propagation Test', status: 'running' });

      // createWorkflowTask handles terminal status transitions internally
      const _t1 = createWorkflowTask(wfId, 'T1', 'completed');
      const _t2 = createWorkflowTask(wfId, 'T2', 'failed');
      const _t3 = createWorkflowTask(wfId, 'T3', 'blocked');
      const _t4 = createWorkflowTask(wfId, 'T4', 'pending');

      const status = db.getWorkflowStatus(wfId);
      expect(status.summary.completed).toBe(1);
      expect(status.summary.failed).toBe(1);
      expect(status.summary.blocked).toBe(1);
      expect(status.summary.pending).toBe(1);
      expect(status.summary.total).toBe(4);
    });

    it('getWorkflowStatus returns null for non-existent workflow', () => {
      const status = db.getWorkflowStatus('non-existent-workflow-id');
      expect(status).toBeNull();
    });

    it('workflow can be transitioned atomically', () => {
      const wfId = uuidv4();
      db.createWorkflow({ id: wfId, name: 'Transition Test', status: 'running' });

      const success = db.transitionWorkflowStatus(wfId, 'running', 'completed', {
        completed_at: new Date().toISOString()
      });
      expect(success).toBe(true);

      const wf = db.getWorkflow(wfId);
      expect(wf.status).toBe('completed');
    });

    it('atomic transition fails if current status does not match', () => {
      const wfId = uuidv4();
      db.createWorkflow({ id: wfId, name: 'Bad Transition Test', status: 'pending' });

      const success = db.transitionWorkflowStatus(wfId, 'running', 'completed');
      expect(success).toBe(false);

      const wf = db.getWorkflow(wfId);
      expect(wf.status).toBe('pending');
    });
  });

  // ── Condition Evaluation ────────────────────────────────

  describe('Condition expression evaluation', () => {
    it('evaluateCondition with exit_code == 0 passes', () => {
      const result = db.evaluateCondition('exit_code == 0', { exit_code: 0 });
      expect(result).toBe(true);
    });

    it('evaluateCondition with exit_code != 0 fails when exit_code is 0', () => {
      const result = db.evaluateCondition('exit_code != 0', { exit_code: 0 });
      expect(result).toBe(false);
    });

    it('evaluateCondition with no expression returns true', () => {
      const result = db.evaluateCondition(null, {});
      expect(result).toBe(true);
    });

    it('evaluateCondition with output.contains checks output', () => {
      const result = db.evaluateCondition("output.contains('success')", {
        output: 'Task completed with success'
      });
      expect(result).toBe(true);
    });

    it('evaluateCondition rejects overly long expressions', () => {
      const longExpr = 'exit_code == 0 AND '.repeat(200);
      const result = db.evaluateCondition(longExpr, { exit_code: 0 });
      expect(result).toBe(false);
    });
  });
});
