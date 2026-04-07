const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

let db;
let testDir;
let templateBuffer;
let taskCore;
let workflowEngine;
let workflowRuntime;
let projectConfigCore;
let featureWorkflow;

beforeAll(() => {
  templateBuffer = fs.readFileSync(path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf'));
  ({ db, testDir } = setupTestDbOnly('adversarial-review-workflow'));
  taskCore = require('../db/task-core');
  workflowEngine = require('../db/workflow-engine');
  workflowRuntime = require('../execution/workflow-runtime');
  projectConfigCore = require('../db/project-config-core');
  featureWorkflow = require('../handlers/workflow/feature-workflow');
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  db.resetForTest(templateBuffer);
  workflowRuntime.init({
    db,
    startTask: () => ({ status: 'running' }),
    cancelTask: () => ({ status: 'cancelled' }),
    processQueue: () => {},
    dashboard: {
      broadcast: () => {},
      notifyTaskUpdated: () => {},
      notifyWorkflowUpdated: () => {},
    },
  });
});

function createWorkflow(overrides = {}) {
  const id = overrides.id || randomUUID();
  workflowEngine.createWorkflow({
    id,
    name: overrides.name || `wf-${id.slice(0, 8)}`,
    status: overrides.status || 'running',
    working_directory: overrides.working_directory || testDir,
    ...overrides,
  });
  return workflowEngine.getWorkflow(id);
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  return taskCore.createTask({
    id,
    task_description: overrides.task_description || `Task ${id.slice(0, 8)}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'pending',
    provider: overrides.provider || 'codex',
    model: overrides.model || 'codex',
    ...overrides,
  });
}

function createWorkflowTask(workflowId, nodeId, status = 'blocked', overrides = {}) {
  return createTask({
    workflow_id: workflowId,
    workflow_node_id: nodeId,
    status,
    ...overrides,
  });
}

function getDependencyNodeIds(taskId) {
  return workflowEngine.getTaskDependencies(taskId).map((dep) => {
    const parentTask = taskCore.getTask(dep.depends_on_task_id);
    return parentTask?.workflow_node_id || dep.depends_on_task_id;
  });
}

function seedReviewWorkflow(options = {}) {
  const workflow = createWorkflow({ name: options.name || 'review-workflow' });
  const reviewTaskId = options.reviewTaskId || randomUUID();
  const codeTaskMetadata = options.codeTaskMetadata === undefined
    ? {
        adversarial_review_pending: true,
        adversarial_review_task_id: reviewTaskId,
      }
    : options.codeTaskMetadata;

  const codeTask = createWorkflowTask(workflow.id, 'code-task', 'completed', {
    metadata: codeTaskMetadata,
    output: options.codeOutput || 'implemented feature',
    exit_code: 0,
  });
  const commitTask = createWorkflowTask(workflow.id, 'commit-task', 'blocked', {
    task_description: options.commitDescription || 'prepare commit message',
    metadata: options.commitMetadata,
  });

  workflowEngine.addTaskDependency({
    workflow_id: workflow.id,
    task_id: commitTask.id,
    depends_on_task_id: codeTask.id,
    on_fail: 'skip',
  });

  const reviewTask = options.createReviewTask === false
    ? null
    : createTask({
        id: reviewTaskId,
        status: options.reviewStatus || 'pending',
        task_description: options.reviewDescription || 'review generated diff',
        metadata: options.reviewMetadata === undefined
          ? {
              adversarial_review_task: true,
              adversarial_review_of_task_id: codeTask.id,
            }
          : options.reviewMetadata,
      });

  return { workflow, codeTask, commitTask, reviewTaskId, reviewTask };
}

function extractWorkflowId(result) {
  const text = result?.content?.[0]?.text || '';
  const match = text.match(/\*\*ID:\*\*\s*([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

function createFeatureWorkflow(overrides = {}) {
  featureWorkflow.init({
    startWorkflowExecution: () => ({
      started: 0,
      queued: 0,
      blockedCount: 0,
      failedStarts: [],
    }),
    buildEmptyWorkflowCreationError: vi.fn(),
  });

  return featureWorkflow.handleCreateFeatureWorkflow({
    feature_name: 'PlayerStats',
    project: 'test-project',
    working_directory: testDir,
    types_task: 'Define types',
    data_task: 'Create data layer',
    events_task: 'Add events',
    system_task: 'Build system',
    tests_task: 'Write tests',
    wire_task: 'Wire dependencies',
    ...overrides,
  });
}

describe('adversarial review workflow injection', () => {
  it('injects review node into workflow DAG when review is spawned', () => {
    const { workflow, codeTask, commitTask, reviewTaskId } = seedReviewWorkflow({
      name: 'inject-review-node',
    });

    workflowRuntime.handleWorkflowTermination(codeTask.id);

    const reviewTask = taskCore.getTask(reviewTaskId);
    expect(reviewTask.workflow_id).toBe(workflow.id);
    expect(reviewTask.workflow_node_id).toBe('review-code-task');
    expect(taskCore.getTask(commitTask.id).status).toBe('blocked');
    expect(getDependencyNodeIds(commitTask.id)).toEqual(
      expect.arrayContaining(['code-task', 'review-code-task'])
    );
  });

  it('skips injection when no adversarial review was spawned', () => {
    const workflow = createWorkflow({ name: 'skip-review-node' });
    const codeTask = createWorkflowTask(workflow.id, 'code-task', 'completed', {
      output: 'implemented feature',
      exit_code: 0,
    });
    const commitTask = createWorkflowTask(workflow.id, 'commit-task', 'blocked', {
      task_description: 'prepare commit message',
    });

    workflowEngine.addTaskDependency({
      workflow_id: workflow.id,
      task_id: commitTask.id,
      depends_on_task_id: codeTask.id,
      on_fail: 'skip',
    });

    workflowRuntime.handleWorkflowTermination(codeTask.id);

    expect(taskCore.getTask(commitTask.id).status).toBe('queued');
    const workflowTasks = workflowEngine.getWorkflowTasks(workflow.id);
    expect(workflowTasks.find((task) => task.workflow_node_id === 'review-code-task')).toBeUndefined();
  });

  it('passes review verdict to downstream nodes via context_from', () => {
    const { codeTask, commitTask, reviewTaskId } = seedReviewWorkflow({
      name: 'review-context-flow',
    });

    workflowRuntime.handleWorkflowTermination(codeTask.id);

    const reviewTask = taskCore.getTask(reviewTaskId);
    expect(reviewTask.metadata.context_from).toEqual(expect.arrayContaining(['code-task']));

    const updatedCommitTask = taskCore.getTask(commitTask.id);
    expect(updatedCommitTask.metadata.context_from).toEqual(expect.arrayContaining(['review-code-task']));
  });

  it('downstream nodes unblock after review completes', () => {
    const { codeTask, commitTask, reviewTaskId } = seedReviewWorkflow({
      name: 'review-completion-unblocks',
    });

    workflowRuntime.handleWorkflowTermination(codeTask.id);
    taskCore.updateTaskStatus(reviewTaskId, 'completed', {
      output: '{"verdict":"concerns","issues":[{"file":"src/app.js","line":12}]}',
      exit_code: 0,
    });

    workflowRuntime.handleWorkflowTermination(reviewTaskId);

    const updatedCommitTask = taskCore.getTask(commitTask.id);
    expect(updatedCommitTask.status).toBe('queued');
    expect(updatedCommitTask.task_description).toContain('Prior step results:');
    expect(updatedCommitTask.task_description).toContain('### review-code-task');
    expect(updatedCommitTask.task_description).toContain('verdict');
  });
});

describe('feature workflow review checkpoints', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('feature workflow includes review nodes when adversarial_review is always', () => {
    vi.spyOn(projectConfigCore, 'getProjectConfig').mockReturnValue({ adversarial_review: 'always' });

    const result = createFeatureWorkflow();
    const workflowId = extractWorkflowId(result);
    const workflowTasks = workflowEngine.getWorkflowTasks(workflowId);
    const tasksByNode = Object.fromEntries(
      workflowTasks.map((task) => [task.workflow_node_id, task])
    );

    expect(workflowTasks.map((task) => task.workflow_node_id)).toEqual(expect.arrayContaining([
      'player-stats-types',
      'review-player-stats-types',
      'player-stats-data',
      'review-player-stats-data',
      'player-stats-events',
      'review-player-stats-events',
      'player-stats-system',
      'review-player-stats-system',
      'player-stats-tests',
      'player-stats-wire',
      'review-player-stats-wire',
    ]));
    expect(workflowTasks).toHaveLength(11);

    const reviewTypesTask = taskCore.getTask(tasksByNode['review-player-stats-types'].id);
    expect(reviewTypesTask.tags).toEqual(['review-checkpoint']);
    expect(reviewTypesTask.provider).toBeNull();
    expect(reviewTypesTask.metadata.context_from).toEqual(['player-stats-types']);

    expect(getDependencyNodeIds(tasksByNode['review-player-stats-types'].id)).toEqual(['player-stats-types']);
    expect(getDependencyNodeIds(tasksByNode['player-stats-data'].id)).toEqual(['review-player-stats-types']);
    expect(getDependencyNodeIds(tasksByNode['review-player-stats-data'].id)).toEqual(['player-stats-data']);
    expect(getDependencyNodeIds(tasksByNode['player-stats-events'].id)).toEqual(['review-player-stats-data']);
    expect(getDependencyNodeIds(tasksByNode['review-player-stats-events'].id)).toEqual(['player-stats-events']);
    expect(getDependencyNodeIds(tasksByNode['player-stats-system'].id)).toEqual(['review-player-stats-events']);
    expect(getDependencyNodeIds(tasksByNode['review-player-stats-system'].id)).toEqual(['player-stats-system']);
    expect(getDependencyNodeIds(tasksByNode['player-stats-tests'].id)).toEqual(['review-player-stats-system']);
    expect(getDependencyNodeIds(tasksByNode['player-stats-wire'].id)).toEqual(['player-stats-tests']);
    expect(getDependencyNodeIds(tasksByNode['review-player-stats-wire'].id)).toEqual(['player-stats-wire']);
  });

  it('feature workflow skips review nodes when adversarial_review is off', () => {
    vi.spyOn(projectConfigCore, 'getProjectConfig').mockReturnValue({ adversarial_review: 'off' });

    const result = createFeatureWorkflow();
    const workflowId = extractWorkflowId(result);
    const workflowTasks = workflowEngine.getWorkflowTasks(workflowId);

    expect(workflowTasks.map((task) => task.workflow_node_id)).toEqual(expect.arrayContaining([
      'player-stats-types',
      'player-stats-data',
      'player-stats-events',
      'player-stats-system',
      'player-stats-tests',
      'player-stats-wire',
    ]));
    expect(workflowTasks.map((task) => task.workflow_node_id).filter((nodeId) => nodeId.startsWith('review-'))).toEqual([]);
  });
});
