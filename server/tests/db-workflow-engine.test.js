const { randomUUID } = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const workflowEngine = require('../db/workflow-engine');
const { createWorkflowState } = require('../workflow-state/workflow-state');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const taskCore = require('../db/task-core');
const { getVitestTemplateBufferPath } = require('./vitest-template-paths');

let db, templateBuffer;

beforeAll(() => {
  templateBuffer = fs.readFileSync(getVitestTemplateBufferPath());
  ({ db } = setupTestDbOnly('db-workflow-engine'));
});

beforeEach(() => {
  db.resetForTest(templateBuffer);
});

afterAll(() => {
  teardownTestDb();
});

function createWorkflow(overrides = {}) {
  return workflowEngine.createWorkflow({
    id: overrides.id || randomUUID(),
    name: overrides.name || `workflow-${randomUUID()}`,
    working_directory: os.tmpdir(),
    status: overrides.status || 'pending',
    ...overrides,
  });
}

function addWorkflowTask(workflowId, overrides = {}) {
  return taskCore.createTask({
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'workflow task',
    status: overrides.status || 'pending',
    working_directory: os.tmpdir(),
    provider: overrides.provider || 'codex',
    model: overrides.model || 'codex',
    workflow_node_id: overrides.workflow_node_id || `node-${randomUUID()}`,
    ...overrides,
    workflow_id: workflowId,
  });
}

function updateWorkflowStatus(workflowId, status, fromStatus = 'pending', additionalUpdates = {}) {
  return workflowEngine.transitionWorkflowStatus(workflowId, fromStatus, status, additionalUpdates);
}

function updateWorkflowTaskStatus(taskId, status, additionalFields = {}) {
  return taskCore.updateTaskStatus(taskId, status, additionalFields);
}

function evaluateDependencies(taskId) {
  return workflowEngine.areTaskDependenciesSatisfied(taskId);
}

function getBlockedTasks(workflowId = null) {
  return workflowEngine.getBlockedTasks(workflowId);
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
    expect(workflowEngine.getWorkflow('missing-workflow-id')).toBeUndefined();
  });

  it('counts workflow tasks and only treats zero-task rows as empty placeholders', () => {
    const emptyWorkflow = createWorkflow({ name: 'workflow-empty-placeholder' });
    const seededWorkflow = createWorkflow({ name: 'workflow-seeded' });
    addWorkflowTask(seededWorkflow.id, { workflow_node_id: 'seed-node' });

    expect(workflowEngine.getWorkflowTaskCount(emptyWorkflow.id)).toBe(0);
    expect(workflowEngine.getWorkflowTaskCount(seededWorkflow.id)).toBe(1);
    expect(workflowEngine.findEmptyWorkflowPlaceholder('workflow-empty-placeholder', 'pending')?.id).toBe(emptyWorkflow.id);
    expect(workflowEngine.findEmptyWorkflowPlaceholder('workflow-seeded', 'pending')).toBeUndefined();
  });

  it('updates workflow status atomically', () => {
    const workflow = createWorkflow({ name: 'workflow-status-transition' });

    const started = updateWorkflowStatus(workflow.id, 'running', 'pending', {
      started_at: new Date().toISOString(),
    });
    expect(started).toBe(true);
    expect(workflowEngine.getWorkflow(workflow.id).status).toBe('running');

    const invalid = updateWorkflowStatus(workflow.id, 'completed', 'pending');
    expect(invalid).toBe(false);
    expect(workflowEngine.getWorkflow(workflow.id).status).toBe('running');

    const completed = updateWorkflowStatus(workflow.id, 'completed', ['running', 'paused'], {
      completed_at: new Date().toISOString(),
    });
    expect(completed).toBe(true);
    expect(workflowEngine.getWorkflow(workflow.id).status).toBe('completed');
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

    const tasks = workflowEngine.getWorkflowTasks(workflow.id);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe(buildTask.id);
    expect(tasks[1].id).toBe(testTask.id);
    expect(tasks.every((task) => task.workflow_id === workflow.id)).toBe(true);
    expect(tasks.map((task) => task.tags)).toEqual(expect.arrayContaining([
      buildTask.tags,
      testTask.tags,
    ]));
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

    const taskRows = workflowEngine.getWorkflowTasks(workflow.id);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].status).toBe('completed');
  });

  it('evaluates dependency satisfaction against task status', () => {
    const workflow = createWorkflow({ name: 'workflow-dependency-eval' });
    const upstream = addWorkflowTask(workflow.id, { workflow_node_id: 'upstream' });
    const middle = addWorkflowTask(workflow.id, { workflow_node_id: 'middle' });
    const downstream = addWorkflowTask(workflow.id, { workflow_node_id: 'downstream' });

    workflowEngine.addTaskDependency({
      workflow_id: workflow.id,
      task_id: middle.id,
      depends_on_task_id: upstream.id,
      on_fail: 'skip',
    });
    workflowEngine.addTaskDependency({
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

    workflowEngine.addTaskDependency({
      workflow_id: workflow.id,
      task_id: taskB.id,
      depends_on_task_id: taskA.id,
      on_fail: 'skip',
    });
    workflowEngine.addTaskDependency({
      workflow_id: workflow.id,
      task_id: taskC.id,
      depends_on_task_id: taskB.id,
      on_fail: 'skip',
    });

    expect(workflowEngine.wouldCreateCycle(taskA.id, taskC.id, workflow.id)).toBe(true);
    expect(workflowEngine.wouldCreateCycle(taskA.id, taskA.id, workflow.id)).toBe(true);
    expect(workflowEngine.wouldCreateCycle(taskA.id, 'missing-task', workflow.id)).toBe(false);

    expect(() => {
      workflowEngine.addTaskDependency({
        workflow_id: workflow.id,
        task_id: taskA.id,
        depends_on_task_id: taskC.id,
        on_fail: 'skip',
      });
    }).toThrow(/circular/i);

    const workflowDeps = workflowEngine.getWorkflowDependencies(workflow.id);
    expect(workflowDeps).toHaveLength(2);
    expect(workflowDeps.every((dep) => dep.workflow_id === workflow.id)).toBe(true);

    const middleDependencies = workflowEngine.getTaskDependencies(taskB.id);
    expect(middleDependencies).toHaveLength(1);
    expect(middleDependencies[0].depends_on_task_id).toBe(taskA.id);

    const dependentsOfA = workflowEngine.getTaskDependents(taskA.id);
    expect(dependentsOfA).toHaveLength(1);
    expect(dependentsOfA[0].task_id).toBe(taskB.id);
  });

  it('merge_object reducer persists merged keys through full DB round-trip', () => {
    const workflow = createWorkflow({ name: 'workflow-merge-reducer' });
    const wsDb = db.getDbInstance();
    const ws = createWorkflowState({ db: wsDb });

    ws.setStateSchema(workflow.id, null, { config: 'merge_object' });

    const r1 = ws.applyPatch(workflow.id, { config: { host: 'localhost', port: 3000 } });
    expect(r1.ok).toBe(true);
    expect(r1.state.config).toEqual({ host: 'localhost', port: 3000 });

    const r2 = ws.applyPatch(workflow.id, { config: { port: 4000, debug: true } });
    expect(r2.ok).toBe(true);
    expect(r2.state.config).toEqual({ host: 'localhost', port: 4000, debug: true });

    const persisted = ws.getState(workflow.id);
    expect(persisted.config).toEqual({ host: 'localhost', port: 4000, debug: true });
  });

  it('append reducer deduplicates nothing but accumulates items through DB round-trip', () => {
    const workflow = createWorkflow({ name: 'workflow-append-reducer' });
    const wsDb = db.getDbInstance();
    const ws = createWorkflowState({ db: wsDb });

    ws.setStateSchema(workflow.id, null, { log: 'append' });

    const r1 = ws.applyPatch(workflow.id, { log: ['event-a', 'event-b'] });
    expect(r1.ok).toBe(true);
    expect(r1.state.log).toEqual(['event-a', 'event-b']);

    const r2 = ws.applyPatch(workflow.id, { log: ['event-b', 'event-c'] });
    expect(r2.ok).toBe(true);
    expect(r2.state.log).toEqual(['event-a', 'event-b', 'event-b', 'event-c']);

    const persisted = ws.getState(workflow.id);
    expect(persisted.log).toEqual(['event-a', 'event-b', 'event-b', 'event-c']);
  });

  it('schema validation rejects patches that produce invalid state', () => {
    const workflow = createWorkflow({ name: 'workflow-schema-reject' });
    const wsDb = db.getDbInstance();
    const ws = createWorkflowState({ db: wsDb });

    const schema = {
      type: 'object',
      properties: {
        counter: { type: 'number' },
      },
      additionalProperties: false,
    };
    ws.setStateSchema(workflow.id, schema, { counter: 'numeric_sum' });

    const good = ws.applyPatch(workflow.id, { counter: 5 });
    expect(good.ok).toBe(true);
    expect(good.state.counter).toBe(5);

    const bad = ws.applyPatch(workflow.id, { extra_field: 'not allowed' });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toBeDefined();
    expect(bad.errors.length).toBeGreaterThan(0);

    const unchanged = ws.getState(workflow.id);
    expect(unchanged.counter).toBe(5);
    expect(unchanged.extra_field).toBeUndefined();
  });

  it('multi-channel atomic update applies all reducers in a single applyPatch call', () => {
    const workflow = createWorkflow({ name: 'workflow-multi-channel' });
    const wsDb = db.getDbInstance();
    const ws = createWorkflowState({ db: wsDb });

    ws.setStateSchema(workflow.id, null, {
      log: 'append',
      count: 'numeric_sum',
      meta: 'merge_object',
    });

    ws.applyPatch(workflow.id, {
      log: ['init'],
      count: 1,
      meta: { author: 'test' },
    });

    const result = ws.applyPatch(workflow.id, {
      log: ['step-2'],
      count: 3,
      meta: { version: 2 },
    });

    expect(result.ok).toBe(true);
    expect(result.state.log).toEqual(['init', 'step-2']);
    expect(result.state.count).toBe(4);
    expect(result.state.meta).toEqual({ author: 'test', version: 2 });

    const persisted = ws.getState(workflow.id);
    expect(persisted.log).toEqual(['init', 'step-2']);
    expect(persisted.count).toBe(4);
    expect(persisted.meta).toEqual({ author: 'test', version: 2 });

    const versionInfo = ws.getMeta(workflow.id);
    expect(versionInfo.version).toBe(3);
  });
});

function getWorkflow(id) {
  return workflowEngine.getWorkflow(id);
}
