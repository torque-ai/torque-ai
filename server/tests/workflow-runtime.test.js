const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

let testDir;
let db;
let taskCore;
let configCore;
let workflowEngine;
let projectConfigCore;
let mod;

let startCalls;
let cancelCalls;
let queueCalls;
let dashboardCalls;

function setup() {
  ({ db, testDir } = setupTestDb('workflow-runtime'));

  taskCore = require('../db/task-core');
  configCore = require('../db/config-core');
  workflowEngine = require('../db/workflow-engine');
  projectConfigCore = require('../db/project-config-core');
  mod = require('../execution/workflow-runtime');
  initRuntime();
}

function initRuntime(overrides = {}) {
  startCalls = [];
  cancelCalls = [];
  queueCalls = [];
  dashboardCalls = [];

  mod.init({
    db,
    startTask: (taskId) => {
      startCalls.push(taskId);
      return { status: 'running' };
    },
    cancelTask: (taskId, reason) => {
      cancelCalls.push({ taskId, reason });
      return { status: 'cancelled' };
    },
    processQueue: () => {
      queueCalls.push(Date.now());
    },
    dashboard: {
      broadcast: () => {},
      notifyTaskUpdated: (taskId) => {
        dashboardCalls.push(taskId);
      },
    },
    ...overrides,
  });
}

function teardown() {
  teardownTestDb();
}

function makeWorkDir(prefix = 'wd') {
  const dir = path.join(testDir, `${prefix}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  const payload = {
    task_description: overrides.task_description || `Task ${id.slice(0, 8)}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'pending',
    provider: overrides.provider || 'codex',
    ...overrides,
    id,
  };
  taskCore.createTask(payload);
  return id;
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
  return createTask({
    workflow_id: workflowId,
    workflow_node_id: nodeId,
    status,
    ...overrides,
  });
}

describe('workflow-runtime', () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    teardown();
  });

  beforeEach(() => {
    initRuntime();
    configCore.setConfig('max_concurrent', '1000');
  });

  describe('handlePlanProjectTaskCompletion', () => {
    it('increments completed count and queues waiting dependents when dependencies are satisfied', () => {
      const projectId = randomUUID();
      projectConfigCore.createPlanProject({ id: projectId, name: 'plan-completion-queue', total_tasks: 2 });

      const rootTaskId = createTask({ status: 'completed' });
      const depTaskId = createTask({ status: 'waiting' });
      projectConfigCore.addTaskToPlanProject(projectId, rootTaskId, 1, []);
      projectConfigCore.addTaskToPlanProject(projectId, depTaskId, 2, [rootTaskId]);

      mod.handlePlanProjectTaskCompletion(rootTaskId);

      const updatedProject = projectConfigCore.getPlanProject(projectId);
      const depTask = taskCore.getTask(depTaskId);
      expect(updatedProject.completed_tasks).toBe(1);
      expect(updatedProject.status).toBe('active');
      expect(depTask.status).toBe('queued');
      expect(dashboardCalls).toContain(depTaskId);
    });

    it('marks plan project as completed when all tasks are done', () => {
      const projectId = randomUUID();
      projectConfigCore.createPlanProject({ id: projectId, name: 'plan-completion-final', total_tasks: 1 });

      const onlyTaskId = createTask({ status: 'completed' });
      projectConfigCore.addTaskToPlanProject(projectId, onlyTaskId, 1, []);

      mod.handlePlanProjectTaskCompletion(onlyTaskId);

      const updatedProject = projectConfigCore.getPlanProject(projectId);
      expect(updatedProject.status).toBe('completed');
      expect(updatedProject.completed_tasks).toBe(1);
      expect(updatedProject.completed_at).toBeTruthy();
    });
  });

  describe('handlePlanProjectTaskFailure', () => {
    it('increments failed count and blocks transitive waiting/queued dependents', () => {
      const projectId = randomUUID();
      projectConfigCore.createPlanProject({ id: projectId, name: 'plan-failure-transitive', total_tasks: 4 });

      const taskA = createTask({ status: 'failed' });
      const taskB = createTask({ status: 'waiting' });
      const taskC = createTask({ status: 'queued' });
      const taskD = createTask({ status: 'running' });

      projectConfigCore.addTaskToPlanProject(projectId, taskA, 1, []);
      projectConfigCore.addTaskToPlanProject(projectId, taskB, 2, [taskA]);
      projectConfigCore.addTaskToPlanProject(projectId, taskC, 3, [taskB]);
      projectConfigCore.addTaskToPlanProject(projectId, taskD, 4, [taskA]);

      mod.handlePlanProjectTaskFailure(taskA);

      const project = projectConfigCore.getPlanProject(projectId);
      expect(project.failed_tasks).toBe(1);
      expect(taskCore.getTask(taskB).status).toBe('blocked');
      expect(taskCore.getTask(taskC).status).toBe('blocked');
      expect(taskCore.getTask(taskD).status).toBe('running');
      expect(dashboardCalls).toContain(taskB);
      expect(dashboardCalls).toContain(taskC);
    });

    it('marks plan project failed when no tasks can proceed', () => {
      const projectId = randomUUID();
      projectConfigCore.createPlanProject({ id: projectId, name: 'plan-failure-final', total_tasks: 2 });

      const taskA = createTask({ status: 'failed' });
      const taskB = createTask({ status: 'waiting' });
      projectConfigCore.addTaskToPlanProject(projectId, taskA, 1, []);
      projectConfigCore.addTaskToPlanProject(projectId, taskB, 2, [taskA]);

      mod.handlePlanProjectTaskFailure(taskA);

      const project = projectConfigCore.getPlanProject(projectId);
      expect(project.status).toBe('failed');
      expect(taskCore.getTask(taskB).status).toBe('blocked');
    });
  });

  describe('generatePipelineDocumentation', () => {
    it('writes a markdown report with step details and output snippets', () => {
      const pipelineId = randomUUID();
      const workingDir = makeWorkDir('pipeline-doc');
      projectConfigCore.createPipeline({
        id: pipelineId,
        name: 'Doc Pipeline',
        description: 'Pipeline doc generation test',
        working_directory: workingDir,
      });
      projectConfigCore.updatePipelineStatus(pipelineId, 'running', {
        started_at: new Date(Date.now() - 6000).toISOString(),
      });

      projectConfigCore.addPipelineStep({
        pipeline_id: pipelineId,
        name: 'build',
        task_template: 'run build',
      });
      const [step] = projectConfigCore.getPipelineSteps(pipelineId);

      const taskId = createTask({
        status: 'pending',
        working_directory: workingDir,
      });
      taskCore.updateTaskStatus(taskId, 'running', {
        started_at: new Date(Date.now() - 5000).toISOString(),
      });
      taskCore.updateTaskStatus(taskId, 'completed', {
        output: 'build succeeded',
        error_output: '',
        files_modified: ['src/app.js', 'README.md'],
        exit_code: 0,
        completed_at: new Date().toISOString(),
      });
      projectConfigCore.updatePipelineStep(step.id, { status: 'completed', task_id: taskId });

      mod.generatePipelineDocumentation(pipelineId, 'completed');

      const reportDir = path.join(workingDir, '.torque', 'pipeline-reports');
      const files = fs.readdirSync(reportDir).filter(f => f.endsWith('.md'));
      expect(files.length).toBe(1);

      const report = fs.readFileSync(path.join(reportDir, files[0]), 'utf8');
      expect(report).toContain('# Pipeline Report: Doc Pipeline');
      expect(report).toContain('## Steps');
      expect(report).toContain('build succeeded');
      expect(report).toContain('`src/app.js`');
    });

    it('writes a markdown report when files_modified JSON is malformed', () => {
      const pipelineId = randomUUID();
      const workingDir = makeWorkDir('pipeline-doc-malformed');
      projectConfigCore.createPipeline({
        id: pipelineId,
        name: 'Doc Pipeline Malformed Files',
        description: 'Pipeline doc generation malformed files test',
        working_directory: workingDir,
      });
      projectConfigCore.updatePipelineStatus(pipelineId, 'running', {
        started_at: new Date(Date.now() - 6000).toISOString(),
      });

      projectConfigCore.addPipelineStep({
        pipeline_id: pipelineId,
        name: 'build',
        task_template: 'run build',
      });
      const [step] = projectConfigCore.getPipelineSteps(pipelineId);

      const taskId = createTask({
        status: 'pending',
        working_directory: workingDir,
      });
      taskCore.updateTaskStatus(taskId, 'running', {
        started_at: new Date(Date.now() - 5000).toISOString(),
      });
      taskCore.updateTaskStatus(taskId, 'completed', {
        output: 'build succeeded',
        error_output: '',
        files_modified: '["src/app.js", "README.md"',
        exit_code: 0,
        completed_at: new Date().toISOString(),
      });
      projectConfigCore.updatePipelineStep(step.id, { status: 'completed', task_id: taskId });

      expect(() => {
        mod.generatePipelineDocumentation(pipelineId, 'completed');
      }).not.toThrow();

      const reportDir = path.join(workingDir, '.torque', 'pipeline-reports');
      const files = fs.readdirSync(reportDir).filter(f => f.endsWith('.md'));
      expect(files.length).toBe(1);

      const report = fs.readFileSync(path.join(reportDir, files[0]), 'utf8');
      expect(report).toContain('# Pipeline Report: Doc Pipeline Malformed Files');
      expect(report).toContain('## Steps');
      expect(report).toContain('build succeeded');
      expect(report).not.toContain('`src/app.js`');
    });

    it('returns without writing docs for unknown pipeline ids', () => {
      const workingDir = makeWorkDir('pipeline-doc-missing');
      const beforeEntries = fs.readdirSync(workingDir);

      mod.generatePipelineDocumentation(randomUUID(), 'failed');

      const afterEntries = fs.readdirSync(workingDir);
      expect(afterEntries).toEqual(beforeEntries);
      expect(fs.existsSync(path.join(workingDir, '.torque', 'pipeline-reports'))).toBe(false);
    });
  });

  describe('handlePipelineStepCompletion', () => {
    it('advances to the next step, creating and starting the next task', () => {
      const pipelineId = randomUUID();
      const workingDir = makeWorkDir('pipeline-next');
      projectConfigCore.createPipeline({
        id: pipelineId,
        name: 'Pipeline Advance',
        working_directory: workingDir,
      });
      projectConfigCore.addPipelineStep({ pipeline_id: pipelineId, name: 'step-1', task_template: 'run first' });
      projectConfigCore.addPipelineStep({ pipeline_id: pipelineId, name: 'step-2', task_template: 'second uses ${prev_output}' });

      const [step1, step2] = projectConfigCore.getPipelineSteps(pipelineId);
      projectConfigCore.updatePipelineStatus(pipelineId, 'running', { current_step: step1.step_order });

      const firstTaskId = createTask({
        status: 'pending',
        working_directory: workingDir,
        context: { pipeline_id: pipelineId, step_id: step1.id },
      });
      taskCore.updateTaskStatus(firstTaskId, 'completed', { output: 'first-step-output' });
      projectConfigCore.updatePipelineStep(step1.id, { status: 'running', task_id: firstTaskId });

      mod.handlePipelineStepCompletion(firstTaskId, 'completed');

      const refreshedSteps = projectConfigCore.getPipelineSteps(pipelineId);
      const refreshedStep1 = refreshedSteps.find(s => s.id === step1.id);
      const refreshedStep2 = refreshedSteps.find(s => s.id === step2.id);
      const nextTask = taskCore.getTask(refreshedStep2.task_id);
      const pipeline = projectConfigCore.getPipeline(pipelineId);

      expect(refreshedStep1.status).toBe('completed');
      expect(refreshedStep2.status).toBe('running');
      expect(nextTask).toBeTruthy();
      expect(nextTask.task_description).toContain('first-step-output');
      expect(pipeline.current_step).toBe(step2.step_order);
      expect(startCalls).toContain(refreshedStep2.task_id);
    });

    it('marks the next step queued when startTask defers execution', () => {
      mod.init({
        db,
        startTask: (taskId) => {
          startCalls.push(taskId);
          return { queued: true };
        },
        cancelTask: (taskId, reason) => {
          cancelCalls.push({ taskId, reason });
          return { status: 'cancelled' };
        },
        processQueue: () => {
          queueCalls.push(Date.now());
        },
        dashboard: {
          broadcast: () => {},
          notifyTaskUpdated: (taskId) => {
            dashboardCalls.push(taskId);
          },
        },
      });

      const pipelineId = randomUUID();
      const workingDir = makeWorkDir('pipeline-next-queued');
      projectConfigCore.createPipeline({
        id: pipelineId,
        name: 'Pipeline Advance Queued',
        working_directory: workingDir,
      });
      projectConfigCore.addPipelineStep({ pipeline_id: pipelineId, name: 'step-1', task_template: 'run first' });
      projectConfigCore.addPipelineStep({ pipeline_id: pipelineId, name: 'step-2', task_template: 'run second' });

      const [step1, step2] = projectConfigCore.getPipelineSteps(pipelineId);
      projectConfigCore.updatePipelineStatus(pipelineId, 'running', { current_step: step1.step_order });

      const firstTaskId = createTask({
        status: 'pending',
        working_directory: workingDir,
        context: { pipeline_id: pipelineId, step_id: step1.id },
      });
      taskCore.updateTaskStatus(firstTaskId, 'completed', { output: 'first-step-output' });
      projectConfigCore.updatePipelineStep(step1.id, { status: 'running', task_id: firstTaskId });

      mod.handlePipelineStepCompletion(firstTaskId, 'completed');

      const refreshedStep2 = projectConfigCore.getPipelineSteps(pipelineId).find(s => s.id === step2.id);

      expect(refreshedStep2.status).toBe('queued');
      expect(startCalls).toContain(refreshedStep2.task_id);
    });

    it('marks pipeline completed when there is no next step', () => {
      const pipelineId = randomUUID();
      const workingDir = makeWorkDir('pipeline-final');
      projectConfigCore.createPipeline({
        id: pipelineId,
        name: 'Pipeline Final',
        working_directory: workingDir,
      });
      projectConfigCore.addPipelineStep({ pipeline_id: pipelineId, name: 'only-step', task_template: 'single' });
      const [step] = projectConfigCore.getPipelineSteps(pipelineId);
      projectConfigCore.updatePipelineStatus(pipelineId, 'running', { current_step: 1 });

      const taskId = createTask({
        status: 'completed',
        working_directory: workingDir,
        context: { pipeline_id: pipelineId, step_id: step.id },
      });
      projectConfigCore.updatePipelineStep(step.id, { status: 'running', task_id: taskId });

      mod.handlePipelineStepCompletion(taskId, 'completed');

      const pipeline = projectConfigCore.getPipeline(pipelineId);
      expect(pipeline.status).toBe('completed');
      expect(pipeline.completed_at).toBeTruthy();
      expect(startCalls.length).toBe(0);

      const reportDir = path.join(workingDir, '.torque', 'pipeline-reports');
      expect(fs.existsSync(reportDir)).toBe(true);
    });

    it('marks pipeline failed when a step fails', () => {
      const pipelineId = randomUUID();
      const workingDir = makeWorkDir('pipeline-fail');
      projectConfigCore.createPipeline({
        id: pipelineId,
        name: 'Pipeline Failure',
        working_directory: workingDir,
      });
      projectConfigCore.addPipelineStep({ pipeline_id: pipelineId, name: 'failing-step', task_template: 'explode' });
      const [step] = projectConfigCore.getPipelineSteps(pipelineId);
      projectConfigCore.updatePipelineStatus(pipelineId, 'running', { current_step: 1 });

      const taskId = createTask({
        status: 'failed',
        working_directory: workingDir,
        error_output: 'boom',
        context: { pipeline_id: pipelineId, step_id: step.id },
      });
      projectConfigCore.updatePipelineStep(step.id, { status: 'running', task_id: taskId });

      mod.handlePipelineStepCompletion(taskId, 'failed');

      const pipeline = projectConfigCore.getPipeline(pipelineId);
      const refreshedStep = projectConfigCore.getPipelineSteps(pipelineId)[0];
      expect(refreshedStep.status).toBe('failed');
      expect(pipeline.status).toBe('failed');
      expect(pipeline.error).toContain(`Step ${step.id} failed`);
    });
  });

  describe('handleWorkflowTermination', () => {
    it('evaluates workflow dependencies for tasks tied to a workflow', () => {
      const workflowId = createWorkflow({ name: 'wf-termination' });
      const taskA = createWorkflowTask(workflowId, 'A', 'completed');
      const taskB = createWorkflowTask(workflowId, 'B', 'blocked');

      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: taskB,
        depends_on_task_id: taskA,
        on_fail: 'skip',
      });

      mod.handleWorkflowTermination(taskA);

      const updatedTaskB = taskCore.getTask(taskB);
      // unblockTask now queues instead of starting directly — scheduler enforces per-provider limits
      expect(['pending', 'queued']).toContain(updatedTaskB.status);
    });

    it('defaults blocked dependents to skipped and finalizes the workflow failed after a prerequisite fails', () => {
      const workflowId = createWorkflow({ name: 'wf-termination-default-skip' });
      const failedTask = createWorkflowTask(workflowId, 'failed-root', 'failed', {
        exit_code: 1,
        error_output: 'startup orphan cleanup',
      });
      const blockedTask = createWorkflowTask(workflowId, 'blocked-child', 'blocked');

      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: blockedTask,
        depends_on_task_id: failedTask,
      });

      mod.handleWorkflowTermination(failedTask);

      const updatedWorkflow = workflowEngine.getWorkflow(workflowId);
      const workflowTaskStatuses = workflowEngine.getWorkflowTasks(workflowId).map(task => task.status).sort();

      expect(taskCore.getTask(blockedTask).status).toBe('skipped');
      expect(taskCore.getTask(blockedTask).error_output).toContain('Skipped due to dependency condition not met');
      expect(workflowTaskStatuses).toEqual(['failed', 'skipped']);
      expect(updatedWorkflow.status).toBe('failed');
      expect(updatedWorkflow.completed_at).toBeTruthy();
      expect(updatedWorkflow.failed_tasks).toBe(1);
      expect(updatedWorkflow.skipped_tasks).toBe(1);
    });
  });

  describe('evaluateWorkflowDependencies', () => {
    it('keeps task blocked until all dependencies are terminal and successful', () => {
      const workflowId = createWorkflow({ name: 'wf-eval-all-deps' });
      const taskA = createWorkflowTask(workflowId, 'A', 'completed');
      const taskC = createWorkflowTask(workflowId, 'C', 'pending');
      const taskD = createWorkflowTask(workflowId, 'D', 'blocked');

      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: taskD,
        depends_on_task_id: taskA,
        on_fail: 'skip',
      });
      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: taskD,
        depends_on_task_id: taskC,
        on_fail: 'skip',
      });

      mod.evaluateWorkflowDependencies(taskA, workflowId);
      expect(taskCore.getTask(taskD).status).toBe('blocked');

      taskCore.updateTaskStatus(taskC, 'completed');
      mod.evaluateWorkflowDependencies(taskC, workflowId);
      // unblockTask now queues instead of starting directly
      expect(['pending', 'queued']).toContain(taskCore.getTask(taskD).status);
    });

    it('applies on_fail policy when condition fails', () => {
      const workflowId = createWorkflow({ name: 'wf-eval-on-fail' });
      const taskA = createWorkflowTask(workflowId, 'A', 'failed');
      const taskB = createWorkflowTask(workflowId, 'B', 'blocked');

      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: taskB,
        depends_on_task_id: taskA,
        on_fail: 'skip',
      });

      mod.evaluateWorkflowDependencies(taskA, workflowId);

      const task = taskCore.getTask(taskB);
      const workflow = workflowEngine.getWorkflow(workflowId);
      expect(task.status).toBe('skipped');
      expect(task.error_output).toContain('Skipped due to dependency condition not met');
      expect(workflow.status).toBe('failed');
    });
  });

  describe('unblockTask', () => {
    it('unblocks blocked tasks to queued status', () => {
      const taskId = createTask({ status: 'blocked' });

      const result = mod.unblockTask(taskId);

      expect(result).toBe(true);
      // unblockTask always queues — scheduler enforces per-provider concurrency limits
      expect(taskCore.getTask(taskId).status).toBe('queued');
    });

    it('unblocks waiting tasks to queued status', () => {
      const taskId = createTask({ status: 'waiting' });

      const result = mod.unblockTask(taskId);

      expect(result).toBe(true);
      expect(taskCore.getTask(taskId).status).toBe('queued');
    });
  });

  describe('applyFailureAction', () => {
    it('cancel action cancels task and dependent tasks', () => {
      const workflowId = createWorkflow({ name: 'wf-cancel-action' });
      const taskA = createWorkflowTask(workflowId, 'A', 'blocked');
      const taskB = createWorkflowTask(workflowId, 'B', 'pending', { depends_on: [taskA] });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: taskB, depends_on_task_id: taskA });

      mod.applyFailureAction(taskA, 'cancel', null, workflowId);

      expect(taskCore.getTask(taskA).status).toBe('cancelled');
      expect(taskCore.getTask(taskB).status).toBe('cancelled');
      expect(taskCore.getTask(taskA).error_output).toContain('Cancelled due to dependency failure');
    });

    it('continue action unblocks task when all dependencies are terminal', () => {
      const workflowId = createWorkflow({ name: 'wf-continue-action' });
      const dep1 = createWorkflowTask(workflowId, 'dep-1', 'failed');
      const dep2 = createWorkflowTask(workflowId, 'dep-2', 'completed');
      const target = createWorkflowTask(workflowId, 'target', 'blocked');

      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: target,
        depends_on_task_id: dep1,
        on_fail: 'continue',
      });
      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: target,
        depends_on_task_id: dep2,
        on_fail: 'continue',
      });

      mod.applyFailureAction(target, 'continue', null, workflowId);

      // unblockTask now queues instead of starting directly
      expect(['pending', 'queued']).toContain(taskCore.getTask(target).status);
    });

    it('run_alternate action skips original and unblocks alternate task', () => {
      const workflowId = createWorkflow({ name: 'wf-run-alt-action' });
      const original = createWorkflowTask(workflowId, 'original', 'blocked');
      const alternate = createWorkflowTask(workflowId, 'alternate', 'blocked');
      const downstream = createWorkflowTask(workflowId, 'downstream', 'blocked');

      workflowEngine.addTaskDependency({
        workflow_id: workflowId,
        task_id: downstream,
        depends_on_task_id: original,
        on_fail: 'skip',
      });

      mod.applyFailureAction(original, 'run_alternate', alternate, workflowId);

      expect(taskCore.getTask(original).status).toBe('skipped');
      // unblockTask now queues instead of starting directly
      expect(['pending', 'queued']).toContain(taskCore.getTask(alternate).status);
      expect(['pending', 'queued']).toContain(taskCore.getTask(downstream).status);
    });
  });

  describe('cancelDependentTasks', () => {
    it('recursively cancels pending/blocked/queued dependent tasks', () => {
      const workflowId = createWorkflow({ name: 'wf-cancel-dependents' });
      const root = createWorkflowTask(workflowId, 'root', 'failed');
      const d1 = createWorkflowTask(workflowId, 'd1', 'pending', { depends_on: [root] });
      const d2 = createWorkflowTask(workflowId, 'd2', 'blocked', { depends_on: [d1] });
      const d3 = createWorkflowTask(workflowId, 'd3', 'queued', { depends_on: [d2] });
      const done = createWorkflowTask(workflowId, 'done', 'completed', { depends_on: [root] });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: d1, depends_on_task_id: root });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: d2, depends_on_task_id: d1 });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: d3, depends_on_task_id: d2 });
      workflowEngine.addTaskDependency({ workflow_id: workflowId, task_id: done, depends_on_task_id: root });

      mod.cancelDependentTasks(root, workflowId, 'cascade cancel');

      expect(taskCore.getTask(d1).status).toBe('cancelled');
      expect(taskCore.getTask(d2).status).toBe('cancelled');
      expect(taskCore.getTask(d3).status).toBe('cancelled');
      expect(taskCore.getTask(done).status).toBe('completed');
      expect(cancelCalls.length).toBe(0);
    });
  });

  describe('checkWorkflowCompletion', () => {
    it('marks workflow completed when all tasks are completed/skipped', () => {
      const workflowId = createWorkflow({ name: 'wf-complete-check' });
      createWorkflowTask(workflowId, 'A', 'completed');
      createWorkflowTask(workflowId, 'B', 'skipped');

      mod.checkWorkflowCompletion(workflowId);

      const workflow = workflowEngine.getWorkflow(workflowId);
      expect(workflow.status).toBe('completed');
      expect(workflow.completed_at).toBeTruthy();
      expect(workflow.total_tasks).toBe(2);
      expect(workflow.completed_tasks).toBe(1);
      expect(workflow.skipped_tasks).toBe(1);
      expect(workflow.failed_tasks).toBe(0);
    });

    it('marks workflow failed when deadlocked with only blocked tasks remaining', () => {
      const workflowId = createWorkflow({ name: 'wf-deadlock-check' });
      createWorkflowTask(workflowId, 'A', 'completed');
      createWorkflowTask(workflowId, 'B', 'blocked');

      mod.checkWorkflowCompletion(workflowId);

      const workflow = workflowEngine.getWorkflow(workflowId);
      expect(workflow.status).toBe('failed');
      expect(workflow.completed_at).toBeTruthy();
    });

  });

  describe('injectDependencyOutputs', () => {
    it('replaces {{node.output}} with dependency output', () => {
      const result = mod.injectDependencyOutputs(
        'result: {{build.output}}',
        {
          build: { output: 'build-log', error_output: 'err', exit_code: 0 },
        }
      );

      expect(result).toContain('result: build-log');
    });

    it('replaces {{node.error_output}} with dependency error output', () => {
      const result = mod.injectDependencyOutputs(
        'error: {{validate.error_output}}',
        {
          validate: { output: 'ok', error_output: 'bad things', exit_code: 1 },
        }
      );

      expect(result).toContain('error: bad things');
    });

    it('replaces {{node.exit_code}} with dependency exit_code', () => {
      const result = mod.injectDependencyOutputs(
        'code {{package.exit_code}}',
        {
          package: { output: 'done', error_output: '', exit_code: 42 },
        }
      );

      expect(result).toContain('code 42');
    });

    it('falls back to 0 for missing exit_code', () => {
      const result = mod.injectDependencyOutputs(
        'code {{task.exit_code}}',
        {
          task: { output: '', error_output: '' },
        }
      );

      expect(result).toContain('code 0');
    });

    it('replaces multiple placeholders across nodes and fields', () => {
      const result = mod.injectDependencyOutputs(
        '{{compile.output}}|{{compile.exit_code}}|{{test.error_output}}',
        {
          compile: { output: 'compiled', error_output: '', exit_code: 0 },
          test: { output: '', error_output: 'failing-test', exit_code: 1 },
        }
      );

      expect(result).toContain('compiled|0|failing-test');
    });

    it('leaves unsupported placeholders untouched', () => {
      const result = mod.injectDependencyOutputs(
        '{{task.output}} and {{task.missing}}',
        {
          task: { output: 'ok', error_output: 'err', exit_code: 0 },
        }
      );

      expect(result).toContain('ok and {{task.missing}}');
    });

    it('caps output injection payloads at OUTPUT_CAP_BYTES', () => {
      const big = 'x'.repeat(mod.OUTPUT_CAP_BYTES + 200);
      const result = mod.injectDependencyOutputs(
        '{{step.output}}',
        {
          step: { output: big, error_output: '', exit_code: 0 },
        }
      );

      expect(result.length).toBe(mod.OUTPUT_CAP_BYTES);
    });

    it('caps error_output injection payloads at OUTPUT_CAP_BYTES', () => {
      const big = 'e'.repeat(mod.OUTPUT_CAP_BYTES + 200);
      const result = mod.injectDependencyOutputs(
        '{{step.error_output}}',
        {
          step: { output: '', error_output: big, exit_code: 0 },
        }
      );

      expect(result.length).toBe(mod.OUTPUT_CAP_BYTES);
    });

    it('returns original description when no dependency map exists', () => {
      const input = 'echo unchanged';
      expect(mod.injectDependencyOutputs(input, null)).toBe(input);
    });

    it('returns original when no placeholders exist', () => {
      const input = 'plain text';
      const result = mod.injectDependencyOutputs(input, {
        step: { output: 'x', error_output: 'y', exit_code: 0 },
      });
      expect(result).toBe(input);
    });

    it('returns empty string for non-string descriptions', () => {
      expect(mod.injectDependencyOutputs(null, {})).toBe('');
      expect(mod.injectDependencyOutputs(undefined, {})).toBe('');
      // Source returns `description || ''` for non-strings; 42 is truthy so returns 42
      expect(mod.injectDependencyOutputs(42, {})).toBe(42);
    });
  });

  describe('applyContextFrom', () => {
    it('prepends outputs from one context node', () => {
      const result = mod.applyContextFrom(
        'Next task',
        ['build'],
        { build: { output: 'build artifacts', error_output: '', exit_code: 0 } }
      );

      expect(result).toContain('Prior step results:');
      expect(result).toContain('### build');
      expect(result).toContain('build artifacts');
      expect(result).toContain('Next task');
      expect(result.indexOf('Prior step results:')).toBeLessThan(result.indexOf('Next task'));
    });

    it('preserves context order', () => {
      const result = mod.applyContextFrom(
        'Finalize',
        ['first', 'second'],
        {
          first: { output: 'alpha', error_output: '', exit_code: 0 },
          second: { output: 'omega', error_output: '', exit_code: 0 },
        }
      );

      expect(result.indexOf('### first')).toBeLessThan(result.indexOf('### second'));
    });

    it('skips context nodes with no output', () => {
      const result = mod.applyContextFrom(
        'Run',
        ['empty', 'full'],
        {
          empty: { output: '', error_output: '', exit_code: 0 },
          full: { output: 'content', error_output: '', exit_code: 0 },
        }
      );

      expect(result).not.toContain('### empty');
      expect(result).toContain('### full');
      expect(result).toContain('content');
    });

    it('returns original when all context outputs are empty', () => {
      const result = mod.applyContextFrom(
        'Run',
        ['empty'],
        {
          empty: { output: '', error_output: '', exit_code: 0 },
        }
      );

      expect(result).toContain('Run');
    });

    it('ignores unknown context nodes', () => {
      const result = mod.applyContextFrom(
        'Run',
        ['missing'],
        {
          present: { output: 'present', error_output: '', exit_code: 0 },
        }
      );

      expect(result).toContain('Run');
    });

    it('caps long context outputs to OUTPUT_CAP_BYTES', () => {
      const big = 'z'.repeat(mod.OUTPUT_CAP_BYTES + 10);
      const result = mod.applyContextFrom(
        'Run',
        ['big'],
        {
          big: { output: big, error_output: '', exit_code: 0 },
        }
      );

      // The context section includes header "### big\n" + capped output.
      // Verify the injected output portion is capped (not the full big string).
      expect(result).toContain('### big');
      // The output within the section should be at most OUTPUT_CAP_BYTES
      const contextSection = result.split('---\n\n')[0];
      const outputPortion = contextSection.replace(/Prior step results:\n\n### big\n/, '').trim();
      expect(outputPortion.length).toBeLessThanOrEqual(mod.OUTPUT_CAP_BYTES);
      expect(outputPortion.length).toBeLessThan(big.length);
    });
  });

  describe('buildDepTasksMap', () => {
    it('builds map for dependency outputs from prior task', () => {
      const wfId = createWorkflow({ name: 'runtime-build-dep-map' });
      const src = createWorkflowTask(wfId, 'src', 'pending');
      const dst = createWorkflowTask(wfId, 'dst', 'blocked');
      taskCore.updateTaskStatus(src, 'completed', {
        output: 'src-output',
        error_output: 'src-error',
        exit_code: 0,
      });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: dst, depends_on_task_id: src, on_fail: 'skip' });

      const map = mod.buildDepTasksMap(wfId, dst);
      expect(map.src).toEqual({
        output: 'src-output',
        error_output: 'src-error',
        exit_code: 0,
        status: 'completed',
      });
    });

    it('merges multiple dependency outputs', () => {
      const wfId = createWorkflow({ name: 'runtime-build-multi-dep' });
      const a = createWorkflowTask(wfId, 'a', 'pending');
      const b = createWorkflowTask(wfId, 'b', 'pending');
      const c = createWorkflowTask(wfId, 'c', 'blocked');

      taskCore.updateTaskStatus(a, 'completed', { output: 'out-a', exit_code: 0, error_output: '' });
      taskCore.updateTaskStatus(b, 'completed', { output: 'out-b', exit_code: 0, error_output: '' });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: c, depends_on_task_id: a, on_fail: 'skip' });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: c, depends_on_task_id: b, on_fail: 'skip' });

      const map = mod.buildDepTasksMap(wfId, c);
      expect(Object.keys(map).sort()).toEqual(['a', 'b']);
      expect(map.a.output).toBe('out-a');
      expect(map.b.output).toBe('out-b');
    });

    it('ignores predecessors without workflow node ids', () => {
      const wfId = createWorkflow({ name: 'runtime-build-ignore-unnamed-node' });
      const src = createTask({ workflow_id: wfId, status: 'pending', task_description: 'standalone' });
      const named = createWorkflowTask(wfId, 'named', 'pending');
      const dst = createWorkflowTask(wfId, 'dst', 'blocked');

      taskCore.updateTaskStatus(src, 'completed', { output: 'standalone-output', exit_code: 0, error_output: '' });
      taskCore.updateTaskStatus(named, 'completed', { output: 'named-output', exit_code: 0, error_output: '' });

      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: dst, depends_on_task_id: src, on_fail: 'skip' });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: dst, depends_on_task_id: named, on_fail: 'skip' });

      const map = mod.buildDepTasksMap(wfId, dst);
      expect(map).toHaveProperty('named');
      expect(map.named.output).toBe('named-output');
      expect(map.src).toBeUndefined();
    });

    it('returns empty map for non-workflow tasks', () => {
      const wfId = createWorkflow({ name: 'runtime-build-empty' });
      const dst = createWorkflowTask(wfId, 'dst', 'blocked');
      const map = mod.buildDepTasksMap(wfId, dst);
      expect(Object.keys(map)).toHaveLength(0);
    });

    it('returns empty object when dependency task has no dependencies', () => {
      const wfId = createWorkflow({ name: 'runtime-build-nil' });
      const dst = createWorkflowTask(wfId, 'dst', 'pending');
      const map = mod.buildDepTasksMap(wfId, dst);
      expect(map).toEqual({});
    });
  });

  describe('applyOutputInjection', () => {
    it('injects templates from dependency snapshots', () => {
      const wfId = createWorkflow({ name: 'runtime-apply-output' });
      const producer = createWorkflowTask(wfId, 'producer', 'pending');
      const consumer = createWorkflowTask(wfId, 'consumer', 'blocked', {
        task_description: 'consume {{producer.output}} and {{producer.exit_code}} err {{producer.error_output}}',
      });

      taskCore.updateTaskStatus(producer, 'completed', {
        output: 'compiled output',
        error_output: 'minor warning',
        exit_code: 7,
      });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: consumer,
        depends_on_task_id: producer,
        on_fail: 'skip',
      });

      mod.applyOutputInjection(consumer, wfId);

      const updated = taskCore.getTask(consumer);
      expect(updated.task_description).toContain('consume compiled output and 7 err minor warning');
    });

    it('injects context_from metadata as a prior context section', () => {
      const wfId = createWorkflow({ name: 'runtime-apply-context' });
      const producer = createWorkflowTask(wfId, 'producer', 'pending');
      const consumer = createWorkflowTask(wfId, 'consumer', 'blocked', {
        task_description: 'run validate',
        metadata: JSON.stringify({ context_from: ['producer'] }),
      });

      taskCore.updateTaskStatus(producer, 'completed', { output: 'build ok', exit_code: 0 });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: consumer,
        depends_on_task_id: producer,
        on_fail: 'skip',
      });

      mod.applyOutputInjection(consumer, wfId);
      const updated = taskCore.getTask(consumer);

      expect(updated.task_description).toContain('Prior step results:');
      expect(updated.task_description).toContain('### producer');
      expect(updated.task_description).toContain('build ok');
      expect(updated.task_description).toContain('run validate');
    });

    it('combines template replacement with context_from', () => {
      const wfId = createWorkflow({ name: 'runtime-apply-both' });
      const producer = createWorkflowTask(wfId, 'producer', 'pending');
      const validator = createWorkflowTask(wfId, 'validator', 'blocked', {
        task_description: 'check {{producer.output}}',
        metadata: JSON.stringify({ context_from: ['producer'] }),
      });

      taskCore.updateTaskStatus(producer, 'completed', { output: 'payload', exit_code: 0 });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: validator,
        depends_on_task_id: producer,
        on_fail: 'skip',
      });

      mod.applyOutputInjection(validator, wfId);
      const updated = taskCore.getTask(validator);

      expect(updated.task_description).toContain('check payload');
      expect(updated.task_description).toContain('Prior step results:');
      expect(updated.task_description).toContain('### producer');
      expect(updated.task_description).toContain('payload');
    });

    it('does nothing when task has no workflow dependency map', () => {
      const wfId = createWorkflow({ name: 'runtime-apply-no-deps' });
      const lone = createWorkflowTask(wfId, 'lone', 'blocked', {
        task_description: 'static',
      });
      mod.applyOutputInjection(lone, wfId);
      expect(taskCore.getTask(lone).task_description).toContain('static');
    });

    it('handles malformed metadata JSON safely', () => {
      const wfId = createWorkflow({ name: 'runtime-apply-bad-metadata' });
      const producer = createWorkflowTask(wfId, 'producer', 'pending');
      const consumer = createWorkflowTask(wfId, 'consumer', 'blocked', {
        task_description: 'consume {{producer.output}}',
        metadata: '{bad',
      });

      taskCore.updateTaskStatus(producer, 'completed', { output: 'payload', exit_code: 0 });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: consumer,
        depends_on_task_id: producer,
        on_fail: 'skip',
      });

      expect(() => mod.applyOutputInjection(consumer, wfId)).not.toThrow();
      expect(taskCore.getTask(consumer).task_description).toContain('consume payload');
    });

    it('does not update a task description if nothing changed', () => {
      const wfId = createWorkflow({ name: 'runtime-apply-unchanged' });
      const producer = createWorkflowTask(wfId, 'producer', 'pending');
      const consumer = createWorkflowTask(wfId, 'consumer', 'blocked', {
        task_description: 'no placeholders',
      });

      taskCore.updateTaskStatus(producer, 'completed', { output: 'payload', exit_code: 0 });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: consumer,
        depends_on_task_id: producer,
        on_fail: 'skip',
      });

      const before = taskCore.getTask(consumer);
      mod.applyOutputInjection(consumer, wfId);
      const after = taskCore.getTask(consumer);

      expect(after.task_description).toBe(before.task_description);
    });

    it('no-op when dep task map is empty', () => {
      const wfId = createWorkflow({ name: 'runtime-apply-empty-map' });
      const task = createWorkflowTask(wfId, 'target', 'blocked', {
        task_description: 'no deps',
      });

      mod.applyOutputInjection(task, wfId);
      expect(taskCore.getTask(task).task_description).toBe('no deps');
    });
  });

  describe('evaluateWorkflowDependencies', () => {
    it('unblocks dependent tasks when all dependencies are satisfied', () => {
      const wfId = createWorkflow({ name: 'runtime-eval-unblock' });
      const a = createWorkflowTask(wfId, 'A', 'completed');
      const b = createWorkflowTask(wfId, 'B', 'blocked');

      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: b,
        depends_on_task_id: a,
        on_fail: 'skip',
      });

      mod.evaluateWorkflowDependencies(a, wfId);

      expect(['pending', 'queued']).toContain(taskCore.getTask(b).status);
    });

    it('waits when a task has multiple unresolved dependencies', () => {
      const wfId = createWorkflow({ name: 'runtime-eval-wait' });
      const a = createWorkflowTask(wfId, 'A', 'completed');
      const b = createWorkflowTask(wfId, 'B', 'pending');
      const c = createWorkflowTask(wfId, 'C', 'blocked');

      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: c, depends_on_task_id: a, on_fail: 'skip' });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: c, depends_on_task_id: b, on_fail: 'skip' });

      mod.evaluateWorkflowDependencies(a, wfId);
      expect(taskCore.getTask(c).status).toBe('blocked');

      taskCore.updateTaskStatus(b, 'completed', { output: 'done', exit_code: 0 });
      mod.evaluateWorkflowDependencies(b, wfId);
      expect(['pending', 'queued']).toContain(taskCore.getTask(c).status);
    });

    it('uses condition_expr for dependency gating', () => {
      const wfId = createWorkflow({ name: 'runtime-eval-condition' });
      const producer = createWorkflowTask(wfId, 'producer', 'pending');
      const consumer = createWorkflowTask(wfId, 'consumer', 'blocked', {
        task_description: 'uses {{producer.output}}',
      });

      taskCore.updateTaskStatus(producer, 'completed', { output: 'all good', exit_code: 0 });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: consumer,
        depends_on_task_id: producer,
        on_fail: 'skip',
        condition_expr: "output.contains('good')",
      });

      mod.evaluateWorkflowDependencies(producer, wfId);

      expect(['pending', 'queued']).toContain(taskCore.getTask(consumer).status);
      expect(taskCore.getTask(consumer).task_description).toContain('all good');
    });

    it('skips dependent task when condition_expr fails', () => {
      const wfId = createWorkflow({ name: 'runtime-eval-cond-fail' });
      const producer = createWorkflowTask(wfId, 'producer', 'pending');
      const consumer = createWorkflowTask(wfId, 'consumer', 'blocked', {
        task_description: 'uses {{producer.output}}',
      });
      const downstream = createWorkflowTask(wfId, 'downstream', 'blocked');

      taskCore.updateTaskStatus(producer, 'completed', { output: 'all bad', exit_code: 5 });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: consumer,
        depends_on_task_id: producer,
        on_fail: 'skip',
        condition_expr: "output.contains('good')",
      });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: downstream,
        depends_on_task_id: consumer,
        on_fail: 'skip',
      });

      mod.evaluateWorkflowDependencies(producer, wfId);

      expect(taskCore.getTask(consumer).status).toBe('skipped');
      expect(['pending', 'queued']).toContain(taskCore.getTask(downstream).status);
      expect(taskCore.getTask(consumer).error_output).toContain('dependency condition not met');
    });

    it('injects exit_code and error_output through template variables in context propagation', () => {
      const wfId = createWorkflow({ name: 'runtime-eval-propagation' });
      const build = createWorkflowTask(wfId, 'build', 'pending');
      const test = createWorkflowTask(wfId, 'test', 'blocked', {
        task_description: 'build rc={{build.exit_code}} err={{build.error_output}} out={{build.output}}',
      });

      taskCore.updateTaskStatus(build, 'completed', {
        output: 'build-log-line',
        error_output: 'warn',
        exit_code: 13,
      });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: test,
        depends_on_task_id: build,
        on_fail: 'skip',
      });

      mod.evaluateWorkflowDependencies(build, wfId);
      const updated = taskCore.getTask(test);

      expect(updated.task_description).toContain('build rc=13 err=warn out=build-log-line');
      expect(['pending', 'queued']).toContain(updated.status);
    });

    it('calls workflow completion when dependent task terminal state changes', () => {
      const wfId = createWorkflow({ name: 'runtime-eval-terminal', status: 'running' });
      const a = createWorkflowTask(wfId, 'A', 'completed');
      const b = createWorkflowTask(wfId, 'B', 'blocked');

      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: b, depends_on_task_id: a, on_fail: 'skip' });

      mod.evaluateWorkflowDependencies(a, wfId);
      taskCore.updateTaskStatus(b, 'completed', { output: 'final', exit_code: 0 });
      mod.handleWorkflowTermination(b);

      const updated = workflowEngine.getWorkflow(wfId);
      expect(updated.total_tasks).toBe(2);
      expect(updated.status).toBe('completed');
      // checkWorkflowCompletion counts ALL completed tasks — both A and B are completed
      expect(updated.completed_tasks).toBe(2);
    });
  });

  describe('on_fail conditional actions', () => {
    it('skip action marks task skipped and allows downstream tasks to proceed', () => {
      const wfId = createWorkflow({ name: 'runtime-onfail-skip' });
      const a = createWorkflowTask(wfId, 'A', 'pending');
      const b = createWorkflowTask(wfId, 'B', 'blocked');
      const c = createWorkflowTask(wfId, 'C', 'blocked');

      taskCore.updateTaskStatus(a, 'failed', { exit_code: 1, error_output: 'bad', output: 'bad' });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: b,
        depends_on_task_id: a,
        on_fail: 'skip',
        condition_expr: 'exit_code == 0',
      });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: c,
        depends_on_task_id: b,
        on_fail: 'skip',
      });

      mod.evaluateWorkflowDependencies(a, wfId);

      expect(taskCore.getTask(b).status).toBe('skipped');
      expect(['pending', 'queued']).toContain(taskCore.getTask(c).status);
    });

    it('cancel action marks dependent and descendants as cancelled', () => {
      const wfId = createWorkflow({ name: 'runtime-onfail-cancel' });
      const a = createWorkflowTask(wfId, 'A', 'pending');
      const b = createWorkflowTask(wfId, 'B', 'blocked');
      const c = createWorkflowTask(wfId, 'C', 'pending');

      taskCore.updateTaskStatus(a, 'failed', { exit_code: 1, error_output: 'err' });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: b, depends_on_task_id: a, on_fail: 'cancel' });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: c, depends_on_task_id: b, on_fail: 'skip' });

      mod.evaluateWorkflowDependencies(a, wfId);

      expect(taskCore.getTask(b).status).toBe('cancelled');
      // cancelDependentTasks now uses getTaskDependents (task_dependencies table)
      // so C is correctly found as a descendant of B and cancelled recursively.
      expect(taskCore.getTask(c).status).toBe('cancelled');
    });

    it('continue action unblocks only when all dependencies are terminal', () => {
      const wfId = createWorkflow({ name: 'runtime-onfail-continue-open' });
      const a = createWorkflowTask(wfId, 'A', 'pending');
      const b = createWorkflowTask(wfId, 'B', 'pending');
      const c = createWorkflowTask(wfId, 'C', 'blocked', {
        task_description: 'depends {{A.output}} {{B.output}}',
      });

      taskCore.updateTaskStatus(a, 'failed', { output: 'a-failed', exit_code: 3 });
      taskCore.updateTaskStatus(b, 'completed', { output: 'b-ok', exit_code: 0 });

      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: c,
        depends_on_task_id: a,
        on_fail: 'continue',
      });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: c,
        depends_on_task_id: b,
        on_fail: 'continue',
      });

      mod.evaluateWorkflowDependencies(a, wfId);

      expect(['pending', 'queued']).toContain(taskCore.getTask(c).status);

    });

    it('continue action keeps task blocked when prerequisites are unresolved', () => {
      const wfId = createWorkflow({ name: 'runtime-onfail-continue-blocked' });
      const a = createWorkflowTask(wfId, 'A', 'failed');
      const b = createWorkflowTask(wfId, 'B', 'pending');
      const c = createWorkflowTask(wfId, 'C', 'blocked');

      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: c, depends_on_task_id: a, on_fail: 'continue' });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: c, depends_on_task_id: b, on_fail: 'continue' });

      mod.evaluateWorkflowDependencies(a, wfId);

      expect(taskCore.getTask(c).status).toBe('blocked');
    });

    it('continue: conditionPassed path respects on_fail continue for failed other deps', () => {
      // Bug scenario: C depends on A (on_fail: continue) and B (on_fail: skip).
      // A already failed, B just completed. evaluateWorkflowDependencies(B)
      // enters conditionPassed=true and must recognize A's 'failed' status
      // as satisfied because C→A has on_fail: 'continue'.
      const wfId = createWorkflow({ name: 'runtime-continue-other-dep' });
      const a = createWorkflowTask(wfId, 'A', 'pending');
      const b = createWorkflowTask(wfId, 'B', 'pending');
      const c = createWorkflowTask(wfId, 'C', 'blocked');

      // Both are already terminal before we evaluate
      taskCore.updateTaskStatus(a, 'failed', { output: 'a-failed', exit_code: 1 });
      taskCore.updateTaskStatus(b, 'completed', { output: 'b-ok', exit_code: 0 });

      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: c, depends_on_task_id: a, on_fail: 'continue' });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: c, depends_on_task_id: b, on_fail: 'skip' });

      // Evaluate from B's completion — this enters conditionPassed=true path
      // and must check A (failed) with on_fail: continue → satisfied
      mod.evaluateWorkflowDependencies(b, wfId);

      expect(['pending', 'queued']).toContain(taskCore.getTask(c).status);
    });

    it('run_alternate action skips original task and unblocks alternate', () => {
      const wfId = createWorkflow({ name: 'runtime-onfail-alt' });
      const a = createWorkflowTask(wfId, 'A', 'failed');
      const b = createWorkflowTask(wfId, 'B', 'blocked');
      const alt = createWorkflowTask(wfId, 'ALT', 'blocked');

      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: b,
        depends_on_task_id: a,
        on_fail: 'run_alternate',
        alternate_task_id: alt,
      });

      mod.evaluateWorkflowDependencies(a, wfId);

      expect(taskCore.getTask(b).status).toBe('skipped');
      expect(['pending', 'queued']).toContain(taskCore.getTask(alt).status);
    });

    it('defaults unknown on_fail actions to skip behavior', () => {
      const wfId = createWorkflow({ name: 'runtime-onfail-default' });
      const a = createWorkflowTask(wfId, 'A', 'pending');
      const b = createWorkflowTask(wfId, 'B', 'blocked');

      // A must have non-zero exit_code so condition_expr 'exit_code == 0' fails
      taskCore.updateTaskStatus(a, 'failed', { exit_code: 1, error_output: 'err' });
      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: b,
        depends_on_task_id: a,
        on_fail: 'unknown_mode',
        condition_expr: 'exit_code == 0',
      });

      mod.evaluateWorkflowDependencies(a, wfId);

      expect(taskCore.getTask(b).status).toBe('skipped');
      expect(taskCore.getTask(b).error_output).toContain('dependency condition not met');
    });

    it('propagates skipped state through additional downstream dependencies', () => {
      const wfId = createWorkflow({ name: 'runtime-onfail-skip-chain' });
      const a = createWorkflowTask(wfId, 'A', 'pending');
      const b = createWorkflowTask(wfId, 'B', 'blocked');
      const c = createWorkflowTask(wfId, 'C', 'blocked');
      const d = createWorkflowTask(wfId, 'D', 'blocked');

      taskCore.updateTaskStatus(a, 'failed', { output: 'a-failed', exit_code: 2 });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: b, depends_on_task_id: a, on_fail: 'skip', condition_expr: 'exit_code == 0' });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: c, depends_on_task_id: b, on_fail: 'continue' });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: d, depends_on_task_id: b, on_fail: 'skip' });

      mod.evaluateWorkflowDependencies(a, wfId);

      expect(taskCore.getTask(b).status).toBe('skipped');
      expect(['pending', 'queued']).toContain(taskCore.getTask(c).status);
      expect(['pending', 'queued']).toContain(taskCore.getTask(d).status);
    });

    it('does not unblock dependents when workflow is paused', () => {
      const wfId = createWorkflow({ name: 'runtime-eval-paused', status: 'running' });
      const a = createWorkflowTask(wfId, 'A', 'completed');
      const b = createWorkflowTask(wfId, 'B', 'blocked');

      workflowEngine.addTaskDependency({
        workflow_id: wfId,
        task_id: b,
        depends_on_task_id: a,
        on_fail: 'skip',
      });

      // Pause the workflow before evaluating dependencies
      workflowEngine.updateWorkflow(wfId, { status: 'paused' });

      mod.evaluateWorkflowDependencies(a, wfId);

      // Task B should remain blocked — pause prevents cascading
      expect(taskCore.getTask(b).status).toBe('blocked');
    });
  });

  describe('circular dependency detection', () => {
    it('rejects self-dependency records', () => {
      const wfId = createWorkflow({ name: 'runtime-cycle-self' });
      const selfTask = createWorkflowTask(wfId, 'self', 'blocked');

      expect(() => {
        workflowEngine.addTaskDependency({
          workflow_id: wfId,
          task_id: selfTask,
          depends_on_task_id: selfTask,
          on_fail: 'skip',
        });
      }).toThrow(/circular/i);
    });

    it('rejects indirect workflow cycles', () => {
      const wfId = createWorkflow({ name: 'runtime-cycle-indirect' });
      const a = createWorkflowTask(wfId, 'A', 'blocked');
      const b = createWorkflowTask(wfId, 'B', 'blocked');
      const c = createWorkflowTask(wfId, 'C', 'blocked');

      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: b, depends_on_task_id: a, on_fail: 'skip' });
      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: c, depends_on_task_id: b, on_fail: 'skip' });

      expect(() => {
        workflowEngine.addTaskDependency({
          workflow_id: wfId,
          task_id: a,
          depends_on_task_id: c,
          on_fail: 'skip',
        });
      }).toThrow(/circular/i);
    });
  });

  describe('task unblocking and workflow progression', () => {
    it('handleWorkflowTermination triggers unblocking by calling dependency evaluation', () => {
      const wfId = createWorkflow({ name: 'runtime-handle-term-unblock' });
      const root = createWorkflowTask(wfId, 'root', 'completed');
      const child = createWorkflowTask(wfId, 'child', 'blocked');

      workflowEngine.addTaskDependency({ workflow_id: wfId, task_id: child, depends_on_task_id: root, on_fail: 'skip' });
      mod.handleWorkflowTermination(root);

      expect(['pending', 'queued']).toContain(taskCore.getTask(child).status);
    });

    it('does not unblock tasks for non-workflow tasks in handleWorkflowTermination', () => {
      const nonWorkflow = createTask({ status: 'completed' });
      mod.handleWorkflowTermination(nonWorkflow);
      expect(dashboardCalls).toEqual([]);
    });

    it('unblockTask is idempotent for completed tasks and returns false', () => {
      const task = createTask({ status: 'completed' });
      expect(mod.unblockTask(task)).toBe(false);
      expect(taskCore.getTask(task).status).toBe('completed');
    });

    it('unblockTask returns false for pending tasks', () => {
      const task = createTask({ status: 'pending' });
      expect(mod.unblockTask(task)).toBe(false);
      expect(taskCore.getTask(task).status).toBe('pending');
    });
  });
});
