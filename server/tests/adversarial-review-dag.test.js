const childProcess = require('child_process');

describe('adversarial-review-dag-injection', () => {
  let createStage;
  let mockAdversarialReviews;
  let mockFileRiskAdapter;
  let mockTaskCore;
  let mockTaskManager;
  let mockProjectConfig;
  let mockWorkflowEngine;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();

    vi.spyOn(childProcess, 'execFileSync').mockReturnValue(Buffer.from('diff output'));

    mockAdversarialReviews = { insertReview: vi.fn() };
    mockFileRiskAdapter = { scoreAndPersist: vi.fn().mockReturnValue([]) };
    mockTaskCore = { createTask: vi.fn(), getTask: vi.fn(), updateTask: vi.fn() };
    mockTaskManager = { startTask: vi.fn().mockReturnValue({ started: true }) };
    mockWorkflowEngine = {
      getWorkflowTasks: vi.fn(),
      getTaskDependents: vi.fn(),
      addTaskDependency: vi.fn(),
      updateWorkflowCounts: vi.fn(),
    };
    mockProjectConfig = { getProjectConfig: vi.fn().mockReturnValue({ adversarial_review: 'always' }) };

    const mod = require('../execution/adversarial-review-stage');
    createStage = mod.createAdversarialReviewStage;
  });

  function makeCtx(overrides = {}) {
    return {
      taskId: 'task-1',
      task: {
        working_directory: '/project',
        provider: 'codex',
        task_description: 'Add login feature',
        metadata: '{}',
        workflow_id: 'wf-1',
        workflow_node_id: 'node-1',
      },
      status: 'completed',
      code: 0,
      filesModified: ['src/auth.js'],
      earlyExit: false,
      validationStages: {},
      proc: { baselineCommit: null },
      ...overrides,
    };
  }

  function makeStage() {
    return createStage({
      adversarialReviews: mockAdversarialReviews,
      fileRiskAdapter: mockFileRiskAdapter,
      taskCore: mockTaskCore,
      taskManager: mockTaskManager,
      projectConfigCore: mockProjectConfig,
      workflowEngine: mockWorkflowEngine,
    });
  }

  it('registers review task as workflow node when task is in a workflow', async () => {
    mockWorkflowEngine.getWorkflowTasks.mockReturnValue([
      { id: 'task-1', workflow_id: 'wf-1', workflow_node_id: 'node-1' },
      { id: 'downstream-1', workflow_node_id: 'node-2' },
      { id: 'downstream-2', workflow_node_id: 'node-3' },
    ]);
    mockWorkflowEngine.getTaskDependents.mockReturnValue([
      { task_id: 'downstream-1' },
      { task_id: 'downstream-2' },
    ]);

    const stage = makeStage();
    await stage(makeCtx());

    const reviewTask = mockTaskCore.createTask.mock.calls[0][0];

    expect(mockTaskCore.updateTask).toHaveBeenCalledWith(reviewTask.id, {
      workflow_id: 'wf-1',
      workflow_node_id: 'review-node-1',
    });
    expect(mockWorkflowEngine.getWorkflowTasks).toHaveBeenCalledWith('wf-1');
    expect(mockWorkflowEngine.getTaskDependents).toHaveBeenCalledWith('task-1');
    expect(mockWorkflowEngine.addTaskDependency).toHaveBeenCalledTimes(2);
    expect(mockWorkflowEngine.addTaskDependency).toHaveBeenNthCalledWith(1, {
      workflow_id: 'wf-1',
      task_id: 'downstream-1',
      depends_on_task_id: reviewTask.id,
      on_fail: 'continue',
    });
    expect(mockWorkflowEngine.addTaskDependency).toHaveBeenNthCalledWith(2, {
      workflow_id: 'wf-1',
      task_id: 'downstream-2',
      depends_on_task_id: reviewTask.id,
      on_fail: 'continue',
    });
    expect(mockWorkflowEngine.updateWorkflowCounts).toHaveBeenCalledWith('wf-1');
  });

  it('skips DAG injection when task is not in a workflow', async () => {
    const stage = makeStage();
    await stage(makeCtx({ task: { ...makeCtx().task, workflow_id: null, workflow_node_id: null } }));

    expect(mockWorkflowEngine.getWorkflowTasks).not.toHaveBeenCalled();
    expect(mockWorkflowEngine.getTaskDependents).not.toHaveBeenCalled();
    expect(mockWorkflowEngine.addTaskDependency).not.toHaveBeenCalled();
    expect(mockWorkflowEngine.updateWorkflowCounts).not.toHaveBeenCalled();
  });

  it('does not fail if DAG injection throws', async () => {
    mockWorkflowEngine.getWorkflowTasks.mockReturnValue([{ id: 'task-1', workflow_id: 'wf-1' }]);
    mockWorkflowEngine.getTaskDependents.mockImplementation(() => {
      throw new Error('dependency graph write failed');
    });

    const stage = makeStage();
    await stage(makeCtx());

    const reviewTask = mockTaskCore.createTask.mock.calls[0][0];
    expect(mockTaskCore.createTask).toHaveBeenCalledTimes(1);
    expect(mockTaskCore.updateTask).toHaveBeenCalledWith(reviewTask.id, {
      workflow_id: 'wf-1',
      workflow_node_id: 'review-node-1',
    });
    expect(mockTaskManager.startTask).toHaveBeenCalledWith(reviewTask.id);
  });
});
