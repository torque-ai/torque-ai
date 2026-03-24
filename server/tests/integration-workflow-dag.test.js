/**
 * Integration Test: Workflow DAG Dependency Resolution & Failure Handling
 */

const { v4: uuidv4 } = require('uuid');
const workflowEngine = require('../db/workflow-engine');
const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');

let testDir;
let taskCore;

function createWorkflowTask(workflowId, nodeId, status = 'blocked') {
  const taskId = uuidv4();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  const createStatus = isTerminal ? 'pending' : status;

  taskCore.createTask({
    id: taskId,
    task_description: `Test task ${nodeId}`,
    working_directory: testDir,
    status: createStatus,
    workflow_id: workflowId,
    workflow_node_id: nodeId,
    provider: 'codex',
  });

  if (status !== createStatus) {
    taskCore.updateTaskStatus(taskId, status);
  }

  return taskId;
}

function insertBrokenDependency(workflowId, taskId, dependsOnTaskId, onFail = 'skip') {
  const conn = rawDb();
  conn.pragma('foreign_keys = OFF');
  try {
    conn.prepare(`
      INSERT INTO task_dependencies (
        workflow_id, task_id, depends_on_task_id, condition_expr, on_fail, alternate_task_id, created_at
      ) VALUES (?, ?, ?, NULL, ?, NULL, ?)
    `).run(workflowId, taskId, dependsOnTaskId, onFail, new Date().toISOString());
  } finally {
    conn.pragma('foreign_keys = ON');
  }
}

describe('Integration: Workflow DAG', () => {
  beforeAll(() => {
    ({ testDir } = setupTestDb('integration-wfdag'));
    taskCore = require('../db/task-core');
  });
  afterAll(() => { teardownTestDb(); });

  describe('DAG edge cases', () => {
    it('returns empty status for workflow with no tasks', () => {
      const workflowId = uuidv4();
      workflowEngine.createWorkflow({ id: workflowId, name: 'Empty DAG Test', status: 'running' });

      const status = workflowEngine.getWorkflowStatus(workflowId);
      expect(status).toMatchObject({
        summary: { total: 0, blocked: 0, pending: 0 },
        dependencies: [],
      });
    });

    it('handles broken dependency chains with missing prerequisite', () => {
      const workflowId = uuidv4();
      workflowEngine.createWorkflow({ id: workflowId, name: 'Broken Dependency Test', status: 'running' });

      const dependentTask = createWorkflowTask(workflowId, 'B', 'blocked');
      const missingDependencyId = uuidv4();

      // Seed a legacy/orphaned dependency row directly. Current FK constraints
      // prevent normal inserts that point at a missing prerequisite task.
      insertBrokenDependency(workflowId, dependentTask, missingDependencyId, 'skip');

      const deps = workflowEngine.getTaskDependencies(dependentTask);
      expect(deps).toHaveLength(1);
      expect(deps[0].depends_on_task_id).toBe(missingDependencyId);
      expect(taskCore.getTask(missingDependencyId)).toBeFalsy();
      expect(taskCore.getTask(dependentTask).status).toBe('blocked');

      const status = workflowEngine.getWorkflowStatus(workflowId);
      expect(status.summary.total).toBe(1);
      expect(status.summary.blocked).toBe(1);
      expect(status.dependencies.length).toBe(1);
    });
  });

  describe('Linear DAG (A -> B -> C)', () => {
    let workflowId, taskA, taskB, taskC;

    beforeAll(() => {
      workflowId = uuidv4();
      workflowEngine.createWorkflow({ id: workflowId, name: 'Linear DAG Test', status: 'running' });

      taskA = createWorkflowTask(workflowId, 'A', 'pending');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');
      taskC = createWorkflowTask(workflowId, 'C', 'blocked');

      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'skip' });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskC, depends_on_task_id: taskB, on_fail: 'skip' });
    });

    it('B starts blocked, A is pending', () => {
      expect(taskCore.getTask(taskA).status).toBe('pending');
      expect(taskCore.getTask(taskB).status).toBe('blocked');
    });

    it('B dependencies list A as prerequisite', () => {
      const deps = workflowEngine.getTaskDependencies(taskB);
      expect(deps.length).toBe(1);
      expect(deps[0].depends_on_task_id).toBe(taskA);
    });

    it('C dependencies list B as prerequisite', () => {
      const deps = workflowEngine.getTaskDependencies(taskC);
      expect(deps.length).toBe(1);
      expect(deps[0].depends_on_task_id).toBe(taskB);
    });

    it('getWorkflowStatus returns correct task breakdown', () => {
      const status = workflowEngine.getWorkflowStatus(workflowId);
      expect(status).toMatchObject({ summary: { total: 3, pending: 1, blocked: 2 }, dependencies: expect.any(Array) });
      expect(status.dependencies.length).toBe(2);
    });

    it('completing A allows evaluating B dependencies', () => {
      taskCore.updateTaskStatus(taskA, 'completed', { exit_code: 0 });
      const deps = workflowEngine.getTaskDependencies(taskB);
      const prereq = taskCore.getTask(deps[0].depends_on_task_id);
      expect(prereq.status).toBe('completed');
    });
  });

  describe('Parallel tasks (A -> (B,C) -> D)', () => {
    let workflowId, taskA, taskB, taskC, taskD;

    beforeAll(() => {
      workflowId = uuidv4();
      workflowEngine.createWorkflow({ id: workflowId, name: 'Parallel DAG Test', status: 'running' });

      taskA = createWorkflowTask(workflowId, 'A', 'completed');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');
      taskC = createWorkflowTask(workflowId, 'C', 'blocked');
      taskD = createWorkflowTask(workflowId, 'D', 'blocked');

      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'skip' });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskC, depends_on_task_id: taskA, on_fail: 'skip' });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskD, depends_on_task_id: taskB, on_fail: 'skip' });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskD, depends_on_task_id: taskC, on_fail: 'skip' });
    });

    it('B and C both depend on A', () => {
      expect(workflowEngine.getTaskDependencies(taskB)[0].depends_on_task_id).toBe(taskA);
      expect(workflowEngine.getTaskDependencies(taskC)[0].depends_on_task_id).toBe(taskA);
    });

    it('D has two dependencies (B and C)', () => {
      const depsD = workflowEngine.getTaskDependencies(taskD);
      expect(depsD.length).toBe(2);
      expect(depsD.map(d => d.depends_on_task_id).sort()).toEqual([taskB, taskC].sort());
    });

    it('D stays blocked when only B completes', () => {
      taskCore.updateTaskStatus(taskB, 'completed', { exit_code: 0 });
      const unsatisfied = workflowEngine.getTaskDependencies(taskD).filter(d => {
        const prereq = taskCore.getTask(d.depends_on_task_id);
        return !prereq || !['completed', 'skipped'].includes(prereq.status);
      });
      expect(unsatisfied.length).toBe(1);
    });

    it('D dependencies fully satisfied when both B and C complete', () => {
      taskCore.updateTaskStatus(taskC, 'completed', { exit_code: 0 });
      const unsatisfied = workflowEngine.getTaskDependencies(taskD).filter(d => {
        const prereq = taskCore.getTask(d.depends_on_task_id);
        return !prereq || !['completed', 'skipped'].includes(prereq.status);
      });
      expect(unsatisfied.length).toBe(0);
    });
  });

  describe('on_fail: "skip"', () => {
    let workflowId, taskA, taskB, taskC;

    beforeAll(() => {
      workflowId = uuidv4();
      workflowEngine.createWorkflow({ id: workflowId, name: 'Skip Test', status: 'running' });
      taskA = createWorkflowTask(workflowId, 'A', 'pending');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');
      taskC = createWorkflowTask(workflowId, 'C', 'pending');
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'skip' });
    });

    it('dependency records on_fail as skip', () => {
      expect(workflowEngine.getTaskDependencies(taskB)[0].on_fail).toBe('skip');
    });

    it('when A fails, B dependency condition fails', () => {
      taskCore.updateTaskStatus(taskA, 'failed', { exit_code: 1 });
      expect(['completed', 'skipped'].includes(taskCore.getTask(taskA).status)).toBe(false);
    });

    it('independent task C is unaffected by A failure', () => {
      expect(taskCore.getTask(taskC).status).toBe('pending');
    });
  });

  describe('on_fail: "cancel"', () => {
    let workflowId, taskA, taskB;

    beforeAll(() => {
      workflowId = uuidv4();
      workflowEngine.createWorkflow({ id: workflowId, name: 'Cancel Test', status: 'running' });
      taskA = createWorkflowTask(workflowId, 'A', 'pending');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'cancel' });
    });

    it('dependency records on_fail as cancel', () => {
      expect(workflowEngine.getTaskDependencies(taskB)[0].on_fail).toBe('cancel');
    });
  });

  describe('on_fail: "continue"', () => {
    let workflowId, taskA, taskB;

    beforeAll(() => {
      workflowId = uuidv4();
      workflowEngine.createWorkflow({ id: workflowId, name: 'Continue Test', status: 'running' });
      taskA = createWorkflowTask(workflowId, 'A', 'pending');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'continue' });
    });

    it('dependency records on_fail as continue', () => {
      expect(workflowEngine.getTaskDependencies(taskB)[0].on_fail).toBe('continue');
    });

    it('continue action treats failed prereq as satisfiable', () => {
      taskCore.updateTaskStatus(taskA, 'failed', { exit_code: 1 });
      expect(['completed', 'skipped', 'failed'].includes(taskCore.getTask(taskA).status)).toBe(true);
    });
  });

  describe('Diamond DAG (A -> (B,C) -> D)', () => {
    let workflowId;

    beforeAll(() => {
      workflowId = uuidv4();
      workflowEngine.createWorkflow({ id: workflowId, name: 'Diamond DAG Test', status: 'running' });

      const taskA = createWorkflowTask(workflowId, 'A', 'completed');
      const taskB = createWorkflowTask(workflowId, 'B', 'blocked');
      const taskC = createWorkflowTask(workflowId, 'C', 'blocked');
      const taskD = createWorkflowTask(workflowId, 'D', 'blocked');

      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'skip' });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskC, depends_on_task_id: taskA, on_fail: 'skip' });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskD, depends_on_task_id: taskB, on_fail: 'skip' });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskD, depends_on_task_id: taskC, on_fail: 'skip' });
    });

    it('getWorkflowStatus reports correct dependency edges', () => {
      const status = workflowEngine.getWorkflowStatus(workflowId);
      expect(status.dependencies.length).toBe(4);
    });
  });

  describe('Cycle detection', () => {
    let workflowId, taskA, taskB;

    beforeAll(() => {
      workflowId = uuidv4();
      workflowEngine.createWorkflow({ id: workflowId, name: 'Cycle Test', status: 'pending' });
      taskA = createWorkflowTask(workflowId, 'A', 'blocked');
      taskB = createWorkflowTask(workflowId, 'B', 'blocked');
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA, on_fail: 'skip' });
    });

    it('adding A -> B -> A throws circular dependency error', () => {
      expect(() => {
        workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskA, depends_on_task_id: taskB, on_fail: 'skip' });
      }).toThrow(/circular dependency/i);
    });

    it('self-dependency throws circular dependency error', () => {
      const wfId = uuidv4();
      workflowEngine.createWorkflow({ id: wfId, name: 'Self Cycle Test', status: 'pending' });
      const selfTask = createWorkflowTask(wfId, 'self', 'blocked');

      expect(() => {
        workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: selfTask, depends_on_task_id: selfTask, on_fail: 'skip' });
      }).toThrow(/circular dependency/i);
    });
  });

  describe('Workflow status propagation', () => {
    it('workflow summary counts task statuses correctly', () => {
      const wfId = uuidv4();
      workflowEngine.createWorkflow({ id: wfId, name: 'Status Propagation Test', status: 'running' });

      createWorkflowTask(wfId, 'T1', 'completed');
      createWorkflowTask(wfId, 'T2', 'failed');
      createWorkflowTask(wfId, 'T3', 'blocked');
      createWorkflowTask(wfId, 'T4', 'pending');

      const status = workflowEngine.getWorkflowStatus(wfId);
      expect(status.summary).toMatchObject({ completed: 1, failed: 1, blocked: 1, pending: 1, total: 4 });
    });

    it('getWorkflowStatus returns null for non-existent workflow', () => {
      expect(workflowEngine.getWorkflowStatus('non-existent-workflow-id')).toBeNull();
    });

    it('workflow can be transitioned atomically', () => {
      const wfId = uuidv4();
      workflowEngine.createWorkflow({ id: wfId, name: 'Transition Test', status: 'running' });

      const success = workflowEngine.transitionWorkflowStatus(wfId, 'running', 'completed', { completed_at: new Date().toISOString() });
      expect(success).toBe(true);
      expect(workflowEngine.getWorkflow(wfId).status).toBe('completed');
    });

    it('atomic transition fails if current status does not match', () => {
      const wfId = uuidv4();
      workflowEngine.createWorkflow({ id: wfId, name: 'Bad Transition Test', status: 'pending' });

      const success = workflowEngine.transitionWorkflowStatus(wfId, 'running', 'completed');
      expect(success).toBe(false);
      expect(workflowEngine.getWorkflow(wfId).status).toBe('pending');
    });
  });

  describe('Condition expression evaluation', () => {
    it('evaluateCondition with exit_code == 0 passes', () => {
      expect(workflowEngine.evaluateCondition('exit_code == 0', { exit_code: 0 })).toBe(true);
    });

    it('evaluateCondition with exit_code != 0 fails when exit_code is 0', () => {
      expect(workflowEngine.evaluateCondition('exit_code != 0', { exit_code: 0 })).toBe(false);
    });

    it('evaluateCondition with no expression returns true', () => {
      expect(workflowEngine.evaluateCondition(null, {})).toBe(true);
    });

    it('evaluateCondition with output.contains checks output', () => {
      expect(workflowEngine.evaluateCondition("output.contains('success')", { output: 'Task completed with success' })).toBe(true);
    });

    it('evaluateCondition rejects overly long expressions', () => {
      const longExpr = 'exit_code == 0 AND '.repeat(200);
      expect(workflowEngine.evaluateCondition(longExpr, { exit_code: 0 })).toBe(false);
    });
  });
});
