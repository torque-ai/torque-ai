const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir;
let origDataDir;
let db;
let taskManager;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-project-deps-${Date.now()}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);

  taskManager = require('../task-manager');
  taskManager.initSubModules();
  taskManager._testing.resetForTest();
}

function teardown() {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  if (testDir) {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  if (origDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = origDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  db.createTask({
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
    teardown();
  });

  beforeEach(() => {
    db.resetForTest(templateBuffer);
    taskManager._testing.resetForTest();
  });

  it('unblocks waiting dependents when a prerequisite completes', () => {
    const projectId = randomUUID();
    db.createPlanProject({ id: projectId, name: 'completion-unblocks', total_tasks: 2 });

    const rootTaskId = createTask({ status: 'running' });
    const dependentTaskId = createTask({ status: 'waiting' });

    db.addTaskToPlanProject(projectId, rootTaskId, 1, []);
    db.addTaskToPlanProject(projectId, dependentTaskId, 2, [rootTaskId]);

    db.updateTaskStatus(rootTaskId, 'completed', {
      exit_code: 0,
      output: 'done',
    });

    const project = db.getPlanProject(projectId);
    expect(db.getTask(dependentTaskId).status).toBe('queued');
    expect(project.completed_tasks).toBe(1);
    expect(project.status).toBe('active');
  });

  it('blocks all transitive dependents when a prerequisite fails', () => {
    const projectId = randomUUID();
    db.createPlanProject({ id: projectId, name: 'failure-blocks', total_tasks: 4 });

    const taskA = createTask({ status: 'running' });
    const taskB = createTask({ status: 'waiting' });
    const taskC = createTask({ status: 'queued' });
    const taskD = createTask({ status: 'running' });

    db.addTaskToPlanProject(projectId, taskA, 1, []);
    db.addTaskToPlanProject(projectId, taskB, 2, [taskA]);
    db.addTaskToPlanProject(projectId, taskC, 3, [taskB]);
    db.addTaskToPlanProject(projectId, taskD, 4, [taskA]);

    db.updateTaskStatus(taskA, 'failed', {
      exit_code: 1,
      error_output: 'boom',
    });

    const project = db.getPlanProject(projectId);
    expect(project.failed_tasks).toBe(1);
    expect(db.getTask(taskB).status).toBe('blocked');
    expect(db.getTask(taskC).status).toBe('blocked');
    expect(db.getTask(taskD).status).toBe('running');
  });

  it('marks a project completed when all project tasks are done', () => {
    const projectId = randomUUID();
    db.createPlanProject({ id: projectId, name: 'project-complete', total_tasks: 1 });

    const onlyTaskId = createTask({ status: 'running' });
    db.addTaskToPlanProject(projectId, onlyTaskId, 1, []);

    db.updateTaskStatus(onlyTaskId, 'completed', {
      exit_code: 0,
      output: 'done',
    });

    const project = db.getPlanProject(projectId);
    expect(project.status).toBe('completed');
    expect(project.completed_tasks).toBe(1);
    expect(project.completed_at).toBeTruthy();
  });

  it('marks a project failed when no tasks can proceed', () => {
    const projectId = randomUUID();
    db.createPlanProject({ id: projectId, name: 'project-failed', total_tasks: 2 });

    const failedTaskId = createTask({ status: 'running' });
    const blockedTaskId = createTask({ status: 'waiting' });

    db.addTaskToPlanProject(projectId, failedTaskId, 1, []);
    db.addTaskToPlanProject(projectId, blockedTaskId, 2, [failedTaskId]);

    db.updateTaskStatus(failedTaskId, 'failed', {
      exit_code: 2,
      error_output: 'failed',
    });

    const project = db.getPlanProject(projectId);
    expect(project.status).toBe('failed');
    expect(project.failed_tasks).toBe(1);
    expect(db.getTask(blockedTaskId).status).toBe('blocked');
  });
});
