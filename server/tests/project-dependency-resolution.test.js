const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

let testDir;
let db;
let taskCore;
let projectConfigCore;
let taskManager;

function setup() {
  ({ db, testDir } = setupTestDb('project-deps'));
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);

  taskCore = require('../db/task-core');
  projectConfigCore = require('../db/project-config-core');

  taskManager = require('../task-manager');
  taskManager.initSubModules();
  taskManager._testing.resetForTest();
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  taskCore.createTask({
    id,
    task_description: overrides.task_description || `Task ${id.slice(0, 8)}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'pending',
    provider: overrides.provider || 'codex',
    ...overrides,
  });
  return id;
}

describe('project dependency resolution', () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    db.resetForTest(templateBuffer);
    taskManager._testing.resetForTest();
  });

  it('unblocks waiting dependents when a prerequisite completes', () => {
    const projectId = randomUUID();
    projectConfigCore.createPlanProject({ id: projectId, name: 'completion-unblocks', total_tasks: 2 });

    const rootTaskId = createTask({ status: 'running' });
    const dependentTaskId = createTask({ status: 'waiting' });

    projectConfigCore.addTaskToPlanProject(projectId, rootTaskId, 1, []);
    projectConfigCore.addTaskToPlanProject(projectId, dependentTaskId, 2, [rootTaskId]);

    taskCore.updateTaskStatus(rootTaskId, 'completed', {
      exit_code: 0,
      output: 'done',
    });

    const project = projectConfigCore.getPlanProject(projectId);
    expect(taskCore.getTask(dependentTaskId).status).toBe('queued');
    expect(project.completed_tasks).toBe(1);
    expect(project.status).toBe('active');
  });

  it('blocks all transitive dependents when a prerequisite fails', () => {
    const projectId = randomUUID();
    projectConfigCore.createPlanProject({ id: projectId, name: 'failure-blocks', total_tasks: 4 });

    const taskA = createTask({ status: 'running' });
    const taskB = createTask({ status: 'waiting' });
    const taskC = createTask({ status: 'queued' });
    const taskD = createTask({ status: 'running' });

    projectConfigCore.addTaskToPlanProject(projectId, taskA, 1, []);
    projectConfigCore.addTaskToPlanProject(projectId, taskB, 2, [taskA]);
    projectConfigCore.addTaskToPlanProject(projectId, taskC, 3, [taskB]);
    projectConfigCore.addTaskToPlanProject(projectId, taskD, 4, [taskA]);

    taskCore.updateTaskStatus(taskA, 'failed', {
      exit_code: 1,
      error_output: 'boom',
    });

    const project = projectConfigCore.getPlanProject(projectId);
    expect(project.failed_tasks).toBe(1);
    expect(taskCore.getTask(taskB).status).toBe('blocked');
    expect(taskCore.getTask(taskC).status).toBe('blocked');
    expect(taskCore.getTask(taskD).status).toBe('running');
  });

  it('marks a project completed when all project tasks are done', () => {
    const projectId = randomUUID();
    projectConfigCore.createPlanProject({ id: projectId, name: 'project-complete', total_tasks: 1 });

    const onlyTaskId = createTask({ status: 'running' });
    projectConfigCore.addTaskToPlanProject(projectId, onlyTaskId, 1, []);

    taskCore.updateTaskStatus(onlyTaskId, 'completed', {
      exit_code: 0,
      output: 'done',
    });

    const project = projectConfigCore.getPlanProject(projectId);
    expect(project.status).toBe('completed');
    expect(project.completed_tasks).toBe(1);
    expect(project.completed_at).toBeTruthy();
  });

  it('marks a project failed when no tasks can proceed', () => {
    const projectId = randomUUID();
    projectConfigCore.createPlanProject({ id: projectId, name: 'project-failed', total_tasks: 2 });

    const failedTaskId = createTask({ status: 'running' });
    const blockedTaskId = createTask({ status: 'waiting' });

    projectConfigCore.addTaskToPlanProject(projectId, failedTaskId, 1, []);
    projectConfigCore.addTaskToPlanProject(projectId, blockedTaskId, 2, [failedTaskId]);

    taskCore.updateTaskStatus(failedTaskId, 'failed', {
      exit_code: 2,
      error_output: 'failed',
    });

    const project = projectConfigCore.getPlanProject(projectId);
    expect(project.status).toBe('failed');
    expect(project.failed_tasks).toBe(1);
    expect(taskCore.getTask(blockedTaskId).status).toBe('blocked');
  });
});
