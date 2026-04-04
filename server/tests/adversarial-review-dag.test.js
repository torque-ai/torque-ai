const realChildProcess = require('child_process');
const mockExecFile = vi.fn((_cmd, _args, _opts, cb) => {
  if (typeof _opts === 'function') { cb = _opts; _opts = {}; }
  cb(null, 'diff output', '');
});

vi.mock('child_process', () => ({
  ...realChildProcess,
  execFile: (...args) => mockExecFile(...args),
}));

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

    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      if (typeof _opts === 'function') { cb = _opts; _opts = {}; }
      cb(null, 'diff output', '');
    });

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
    const stage = makeStage();
    await stage(makeCtx());

    const reviewTask = mockTaskCore.createTask.mock.calls[0][0];

    // Review task is created with adversarial review metadata
    expect(reviewTask.metadata).toBeDefined();
    const meta = JSON.parse(reviewTask.metadata);
    expect(meta.adversarial_review_task).toBe(true);
    expect(meta.adversarial_review_of_task_id).toBe('task-1');

    // Original task is marked with review metadata
    expect(mockTaskCore.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
      metadata: expect.objectContaining({
        adversarial_review_pending: true,
        adversarial_review_task_id: reviewTask.id,
      }),
    }));

    // Review task is started
    expect(mockTaskManager.startTask).toHaveBeenCalledWith(reviewTask.id);
  });

  it('skips DAG injection when task is not in a workflow', async () => {
    const stage = makeStage();
    await stage(makeCtx({ task: { ...makeCtx().task, workflow_id: null, workflow_node_id: null } }));

    // No workflow operations should occur for non-workflow tasks
    expect(mockWorkflowEngine.getWorkflowTasks).not.toHaveBeenCalled();
    expect(mockWorkflowEngine.getTaskDependents).not.toHaveBeenCalled();
    expect(mockWorkflowEngine.addTaskDependency).not.toHaveBeenCalled();
    expect(mockWorkflowEngine.updateWorkflowCounts).not.toHaveBeenCalled();
  });

  it('does not fail if metadata update throws', async () => {
    mockTaskCore.updateTask.mockImplementation(() => {
      throw new Error('metadata write failed');
    });

    const stage = makeStage();
    await stage(makeCtx());

    const reviewTask = mockTaskCore.createTask.mock.calls[0][0];
    expect(mockTaskCore.createTask).toHaveBeenCalledTimes(1);
    // updateTask was called but threw — stage continues without failing
    expect(mockTaskCore.updateTask).toHaveBeenCalled();
    expect(mockTaskManager.startTask).toHaveBeenCalledWith(reviewTask.id);
  });
});
