const { randomUUID } = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TEMPLATE_BUF = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer, db;

beforeAll(() => {
  templateBuffer = fs.readFileSync(TEMPLATE_BUF);
  db = require('../database');
  db.resetForTest(templateBuffer);
});

beforeEach(() => {
  db.resetForTest(templateBuffer);
});

afterAll(() => {
  try {
    db.close();
  } catch {}
});

function createWorkflow(overrides = {}) {
  return db.createWorkflow({
    id: overrides.id || randomUUID(),
    name: overrides.name || `workflow-${randomUUID()}`,
    working_directory: os.tmpdir(),
    status: overrides.status || 'pending',
    ...overrides,
  });
}

function addWorkflowTask(workflowId, overrides = {}) {
  return db.createTask({
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'workflow task',
    status: overrides.status || 'pending',
    working_directory: os.tmpdir(),
    provider: overrides.provider || 'codex',
    model: overrides.model || 'codex',
    workflow_id: workflowId,
    workflow_node_id: overrides.workflow_node_id || `node-${randomUUID()}`,
    ...overrides,
    workflow_id: workflowId,
  });
}

function updateWorkflowStatus(workflowId, status, fromStatus = 'pending', additionalUpdates = {}) {
  return db.transitionWorkflowStatus(workflowId, fromStatus, status, additionalUpdates);
}

function updateWorkflowTaskStatus(taskId, status, additionalFields = {}) {
  return db.updateTaskStatus(taskId, status, additionalFields);
}

function evaluateDependencies(taskId) {
  return db.areTaskDependenciesSatisfied(taskId);
}

function getBlockedTasks(workflowId = null) {
  return db.getBlockedTasks(workflowId);
}

describe('db/workflow-engine module', () => {
  it('creates and reads workflow rows', () => {
    const workflow = createWorkflow({
      name: 'workflow-create-read',
      description: 'workflow creation smoke test',
      context: { source: 'db-workflow-engine test' },
      template_id: `template-${randomUUID()}`,
    });

    const loaded = getWorkflow(workflow.id);
    expect(loaded).toMatchObject({
      id: workflow.id,
      name: 'workflow-create-read',
      status: 'pending',
      template_id: workflow.template_id,
    });
    expect(loaded.context).toEqual({ source: 'db-workflow-engine test' });
  });

  it('returns undefined for missing workflows', () => {
    expect(db.getWorkflow('missing-workflow-id')).toBeUndefined();
  });

  it('counts workflow tasks and only treats zero-task rows as empty placeholders', () => {
    const emptyWorkflow = createWorkflow({ name: 'workflow-empty-placeholder' });
    const seededWorkflow = createWorkflow({ name: 'workflow-seeded' });
    addWorkflowTask(seededWorkflow.id, { workflow_node_id: 'seed-node' });

    expect(db.getWorkflowTaskCount(emptyWorkflow.id)).toBe(0);
    expect(db.getWorkflowTaskCount(seededWorkflow.id)).toBe(1);
    expect(db.findEmptyWorkflowPlaceholder('workflow-empty-placeholder', 'pending')?.id).toBe(emptyWorkflow.id);
    expect(db.findEmptyWorkflowPlaceholder('workflow-seeded', 'pending')).toBeUndefined();
  });

  it('updates workflow status atomically', () => {
    const workflow = createWorkflow({ name: 'workflow-status-transition' });

    const started = updateWorkflowStatus(workflow.id, 'running', 'pending', {
      started_at: new Date().toISOString(),
    });
    expect(started).toBe(true);
    expect(db.getWorkflow(workflow.id).status).toBe('running');

    const invalid = updateWorkflowStatus(workflow.id, 'completed', 'pending');
    expect(invalid).toBe(false);
    expect(db.getWorkflow(workflow.id).status).toBe('running');

    const completed = updateWorkflowStatus(workflow.id, 'completed', ['running', 'paused'], {
      completed_at: new Date().toISOString(),
    });
    expect(completed).toBe(true);
    expect(db.getWorkflow(workflow.id).status).toBe('completed');
  });

  it('adds tasks to workflows and reads them in deterministic order', () => {
    const workflow = createWorkflow({ name: 'workflow-tasks-crud' });
    const buildTask = addWorkflowTask(workflow.id, {
      workflow_node_id: 'build',
      context: { stage: 'build' },
      tags: ['build'],
    });
    const testTask = addWorkflowTask(workflow.id, {
      workflow_node_id: 'test',
      status: 'queued',
      tags: ['test', 'ci'],
      context: { stage: 'test' },
    });

    const tasks = db.getWorkflowTasks(workflow.id);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe(buildTask.id);
    expect(tasks[1].id).toBe(testTask.id);
    expect(tasks.every((task) => task.workflow_id === workflow.id)).toBe(true);
    expect(tasks.map((task) => task.tags)).toEqual(expect.arrayContaining([['build'], ['test', 'ci']]));
    expect(tasks.find((task) => task.workflow_node_id === 'build').context).toEqual({ stage: 'build' });
  });

  it('updates workflow task status with task-level helper', () => {
    const workflow = createWorkflow({ name: 'workflow-task-status' });
    const task = addWorkflowTask(workflow.id, {
      workflow_node_id: 'unit',
      context: { kind: 'status' },
    });

    const running = updateWorkflowTaskStatus(task.id, 'running');
    expect(running.status).toBe('running');
    expect(running.started_at).toBeTruthy();

    const completed = updateWorkflowTaskStatus(task.id, 'completed', {
      exit_code: 0,
      output: 'step complete',
    });
    expect(completed.status).toBe('completed');
    expect(completed.exit_code).toBe(0);
    expect(completed.output).toBe('step complete');

    const taskRows = db.getWorkflowTasks(workflow.id);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].status).toBe('completed');
  });

  it('evaluates dependency satisfaction against task status', () => {
    const workflow = createWorkflow({ name: 'workflow-dependency-eval' });
    const upstream = addWorkflowTask(workflow.id, { workflow_node_id: 'upstream' });
    const middle = addWorkflowTask(workflow.id, { workflow_node_id: 'middle' });
    const downstream = addWorkflowTask(workflow.id, { workflow_node_id: 'downstream' });

    db.addTaskDependency({
      workflow_id: workflow.id,
      task_id: middle.id,
      depends_on_task_id: upstream.id,
      on_fail: 'skip',
    });
    db.addTaskDependency({
      workflow_id: workflow.id,
      task_id: downstream.id,
      depends_on_task_id: middle.id,
      on_fail: 'skip',
    });

    let middleStatus = evaluateDependencies(middle.id);
    expect(middleStatus).toMatchObject({ satisfied: false, waiting_on: upstream.id });

    updateWorkflowTaskStatus(upstream.id, 'running');
    middleStatus = evaluateDependencies(middle.id);
    expect(middleStatus.satisfied).toBe(false);
    expect(middleStatus.waiting_on).toBe(upstream.id);

    updateWorkflowTaskStatus(upstream.id, 'completed', { exit_code: 0 });
    middleStatus = evaluateDependencies(middle.id);
    expect(middleStatus.satisfied).toBe(true);

    const downstreamStatus = evaluateDependencies(downstream.id);
    expect(downstreamStatus.satisfied).toBe(false);
    expect(downstreamStatus.waiting_on).toBe(middle.id);

    updateWorkflowTaskStatus(middle.id, 'failed', { exit_code: 1 });
    const downstreamAfterFailure = evaluateDependencies(downstream.id);
    expect(downstreamAfterFailure.satisfied).toBe(true);
    expect(downstreamAfterFailure.deps.every((dep) => dep.depends_on_status)).toBe(true);
  });

  it('returns blocked tasks globally and by workflow', () => {
    const workflowA = createWorkflow({ name: 'blocked-workflow-A' });
    const workflowB = createWorkflow({ name: 'blocked-workflow-B' });

    const blockedA = addWorkflowTask(workflowA.id, {
      workflow_node_id: 'blocked-a',
      status: 'blocked',
      context: { reason: 'resource' },
    });
    addWorkflowTask(workflowA.id, { workflow_node_id: 'ready-a', status: 'pending' });
    addWorkflowTask(workflowB.id, { workflow_node_id: 'blocked-b', status: 'blocked' });

    const blockedAll = getBlockedTasks();
    expect(blockedAll.map((task) => task.id)).toEqual(expect.arrayContaining([blockedA.id]));
    expect(blockedAll.every((task) => task.status === 'blocked')).toBe(true);

    const blockedForA = getBlockedTasks(workflowA.id);
    expect(blockedForA).toHaveLength(1);
    expect(blockedForA[0].id).toBe(blockedA.id);
    expect(blockedForA[0].context).toEqual({ reason: 'resource' });
  });

  it('detects DAG cycles and stores dependency edges', () => {
    const workflow = createWorkflow({ name: 'workflow-dag-cycle' });
    const taskA = addWorkflowTask(workflow.id, { workflow_node_id: 'A' });
    const taskB = addWorkflowTask(workflow.id, { workflow_node_id: 'B' });
    const taskC = addWorkflowTask(workflow.id, { workflow_node_id: 'C' });

    db.addTaskDependency({
      workflow_id: workflow.id,
      task_id: taskB.id,
      depends_on_task_id: taskA.id,
      on_fail: 'skip',
    });
    db.addTaskDependency({
      workflow_id: workflow.id,
      task_id: taskC.id,
      depends_on_task_id: taskB.id,
      on_fail: 'skip',
    });

    expect(db.wouldCreateCycle(taskA.id, taskC.id, workflow.id)).toBe(true);
    expect(db.wouldCreateCycle(taskA.id, taskA.id, workflow.id)).toBe(true);
    expect(db.wouldCreateCycle(taskA.id, 'missing-task', workflow.id)).toBe(false);

    expect(() => {
      db.addTaskDependency({
        workflow_id: workflow.id,
        task_id: taskA.id,
        depends_on_task_id: taskC.id,
        on_fail: 'skip',
      });
    }).toThrow(/circular/i);

    const workflowDeps = db.getWorkflowDependencies(workflow.id);
    expect(workflowDeps).toHaveLength(2);
    expect(workflowDeps.every((dep) => dep.workflow_id === workflow.id)).toBe(true);

    const middleDependencies = db.getTaskDependencies(taskB.id);
    expect(middleDependencies).toHaveLength(1);
    expect(middleDependencies[0].depends_on_task_id).toBe(taskA.id);

    const dependentsOfA = db.getTaskDependents(taskA.id);
    expect(dependentsOfA).toHaveLength(1);
    expect(dependentsOfA[0].task_id).toBe(taskB.id);
  });
});

function getWorkflow(id) {
  return db.getWorkflow(id);
}
