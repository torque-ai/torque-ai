import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let db;
let testDir;
let taskCore;
let workflowEngine;
let workflowRuntime;

function setup() {
  ({ db, testDir } = setupTestDbOnly('startup-workflow-reconciler'));

  taskCore = require('../db/task-core');
  workflowEngine = require('../db/workflow-engine');
  workflowRuntime = require('../execution/workflow-runtime');

  workflowRuntime.init({
    db,
    startTask: vi.fn(),
    cancelTask: vi.fn(),
    processQueue: vi.fn(),
    dashboard: {
      broadcast: vi.fn(),
      notifyTaskUpdated: vi.fn(),
      notifyWorkflowUpdated: vi.fn(),
      notifyStatsUpdated: vi.fn(),
    },
  });
}

function createWorkflow(overrides = {}) {
  const id = overrides.id || randomUUID();
  workflowEngine.createWorkflow({
    id,
    name: overrides.name || `wf-${id.slice(0, 8)}`,
    status: overrides.status || 'running',
    description: overrides.description || null,
  });
  return id;
}

function createWorkflowTask(workflowId, nodeId, status = 'blocked', overrides = {}) {
  const id = overrides.id || randomUUID();
  taskCore.createTask({
    task_description: `Task ${nodeId}`,
    working_directory: testDir,
    provider: 'codex',
    metadata: {},
    workflow_id: workflowId,
    workflow_node_id: nodeId,
    status,
    ...overrides,
    id,
  });
  return id;
}

function addDependency(workflowId, taskId, dependsOnTaskId, overrides = {}) {
  return workflowEngine.addTaskDependency({
    workflow_id: workflowId,
    task_id: taskId,
    depends_on_task_id: dependsOnTaskId,
    on_fail: 'skip',
    ...overrides,
  });
}

function dependencyIds(taskId) {
  return workflowEngine.getTaskDependencies(taskId)
    .map(dep => dep.depends_on_task_id)
    .sort();
}

function taskStatus(taskId) {
  return taskCore.getTask(taskId).status;
}

beforeEach(() => {
  setup();
});

afterEach(() => {
  teardownTestDb();
  vi.restoreAllMocks();
});

describe('startup workflow reconciler', () => {
  test('all-complete idempotent transitions workflow to completed', () => {
    const workflowId = createWorkflow({ name: 'all-complete' });
    createWorkflowTask(workflowId, 'A', 'completed');
    createWorkflowTask(workflowId, 'B', 'skipped');

    workflowRuntime.reconcileWorkflowsOnStartup();
    const first = workflowEngine.getWorkflow(workflowId);

    expect(first.status).toBe('completed');
    expect(first.completed_at).toBeTruthy();

    workflowRuntime.reconcileWorkflowsOnStartup();
    const second = workflowEngine.getWorkflow(workflowId);

    expect(second.status).toBe('completed');
    expect(second.completed_at).toBe(first.completed_at);
  });

  test('linear A to B to C with B orphaned and cloned rewires C to the clone', () => {
    const workflowId = createWorkflow({ name: 'linear-restart-clone' });
    const taskA = createWorkflowTask(workflowId, 'A', 'completed');
    const taskB = createWorkflowTask(workflowId, 'B', 'cancelled', {
      metadata: { resubmitted_as: null },
    });
    const taskBPrime = createWorkflowTask(workflowId, 'B', 'queued', {
      metadata: { resubmitted_from: taskB },
    });
    taskCore.patchTaskMetadata(taskB, { resubmitted_as: taskBPrime });
    const taskC = createWorkflowTask(workflowId, 'C', 'blocked');

    addDependency(workflowId, taskB, taskA);
    addDependency(workflowId, taskC, taskB);

    const result = workflowRuntime.reconcileWorkflowsOnStartup();

    expect(result.actions.dependencies_rewired).toBe(2);
    expect(dependencyIds(taskBPrime)).toEqual([taskA]);
    expect(dependencyIds(taskC)).toEqual([taskBPrime]);
    expect(dependencyIds(taskB)).toEqual([]);
    expect(taskStatus(taskBPrime)).toBe('queued');
    expect(taskStatus(taskC)).toBe('blocked');
    expect(workflowEngine.getWorkflow(workflowId).status).toBe('running');
  });

  test('diamond with one orphaned branch keeps join blocked on the clone', () => {
    const workflowId = createWorkflow({ name: 'diamond-restart-clone' });
    const taskA = createWorkflowTask(workflowId, 'A', 'completed');
    const taskB = createWorkflowTask(workflowId, 'B', 'completed');
    const taskC = createWorkflowTask(workflowId, 'C', 'cancelled', {
      metadata: { resubmitted_as: null },
    });
    const taskCPrime = createWorkflowTask(workflowId, 'C', 'queued', {
      metadata: { resubmitted_from: taskC },
    });
    taskCore.patchTaskMetadata(taskC, { resubmitted_as: taskCPrime });
    const taskD = createWorkflowTask(workflowId, 'D', 'blocked');

    addDependency(workflowId, taskB, taskA);
    addDependency(workflowId, taskC, taskA);
    addDependency(workflowId, taskD, taskB);
    addDependency(workflowId, taskD, taskC);

    workflowRuntime.reconcileWorkflowsOnStartup();

    expect(dependencyIds(taskCPrime)).toEqual([taskA]);
    expect(dependencyIds(taskD)).toEqual([taskB, taskCPrime].sort());
    expect(dependencyIds(taskC)).toEqual([]);
    expect(taskStatus(taskCPrime)).toBe('queued');
    expect(taskStatus(taskD)).toBe('blocked');
    expect(workflowEngine.getWorkflow(workflowId).status).toBe('running');
  });

  test('all-failed path marks workflow failed', () => {
    const workflowId = createWorkflow({ name: 'all-failed' });
    createWorkflowTask(workflowId, 'A', 'failed');
    createWorkflowTask(workflowId, 'B', 'failed');

    workflowRuntime.reconcileWorkflowsOnStartup();

    const workflow = workflowEngine.getWorkflow(workflowId);
    expect(workflow.status).toBe('failed');
    expect(workflow.completed_at).toBeTruthy();
  });

  test('fresh workflow with first node orphaned and cloned leaves downstream pending on unsatisfied deps', () => {
    const workflowId = createWorkflow({ name: 'fresh-first-node-restart' });
    const taskA = createWorkflowTask(workflowId, 'A', 'cancelled', {
      metadata: { resubmitted_as: null },
    });
    const taskAPrime = createWorkflowTask(workflowId, 'A', 'queued', {
      metadata: { resubmitted_from: taskA },
    });
    taskCore.patchTaskMetadata(taskA, { resubmitted_as: taskAPrime });
    const taskB = createWorkflowTask(workflowId, 'B', 'pending');
    const taskC = createWorkflowTask(workflowId, 'C', 'pending');

    addDependency(workflowId, taskB, taskA);
    addDependency(workflowId, taskC, taskB);

    workflowRuntime.reconcileWorkflowsOnStartup();

    expect(dependencyIds(taskB)).toEqual([taskAPrime]);
    expect(dependencyIds(taskC)).toEqual([taskB]);
    expect(taskStatus(taskAPrime)).toBe('queued');
    expect(taskStatus(taskB)).toBe('pending');
    expect(taskStatus(taskC)).toBe('pending');
    expect(workflowEngine.areTaskDependenciesSatisfied(taskB).satisfied).toBe(false);
    expect(workflowEngine.areTaskDependenciesSatisfied(taskC).satisfied).toBe(false);
    expect(workflowEngine.getWorkflow(workflowId).status).toBe('running');
  });
});
