const childProcess = require('child_process');

describe('adversarial-review-stage', () => {
  let createStage;
  let mockAdversarialReviews;
  let mockVerificationLedger;
  let mockFileRiskAdapter;
  let mockTaskCore;
  let mockTaskManager;
  let mockProjectConfig;

  beforeEach(() => {
    vi.restoreAllMocks();
    // eslint-disable-next-line torque/no-reset-modules-in-each -- requires module under test fresh each run
    vi.resetModules();

    vi.spyOn(childProcess, 'execFile').mockImplementation((_cmd, _args, _opts, cb) => {
      if (typeof _opts === 'function') { cb = _opts; _opts = {}; }
      cb(null, 'diff output', '');
    });

    mockAdversarialReviews = { insertReview: vi.fn() };
    mockVerificationLedger = { updateVerificationStatus: vi.fn() };
    mockFileRiskAdapter = { scoreAndPersist: vi.fn().mockReturnValue([]) };
    mockTaskCore = { createTask: vi.fn(), getTask: vi.fn(), updateTask: vi.fn() };
    mockTaskManager = { startTask: vi.fn().mockReturnValue({ started: true }) };
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
        workflow_id: null,
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
      verificationLedger: mockVerificationLedger,
      fileRiskAdapter: mockFileRiskAdapter,
      taskCore: mockTaskCore,
      taskManager: mockTaskManager,
      projectConfigCore: mockProjectConfig,
    });
  }

  it('spawns an async review task when adversarial_review is always', async () => {
    const stage = makeStage();
    await stage(makeCtx());

    expect(mockTaskCore.createTask).toHaveBeenCalledTimes(1);
    const taskArg = mockTaskCore.createTask.mock.calls[0][0];
    expect(taskArg.task_description).toContain('hostile code reviewer');
    expect(taskArg.task_description).toContain('Add login feature');

    const meta = JSON.parse(taskArg.metadata);
    expect(meta.adversarial_review_task).toBe(true);
    expect(meta.adversarial_review_of_task_id).toBe('task-1');
    expect(meta.intended_provider).not.toBe('codex');
  });

  it('skips when task status is not completed', async () => {
    const stage = makeStage();
    await stage(makeCtx({ status: 'failed' }));
    expect(mockTaskCore.createTask).not.toHaveBeenCalled();
  });

  it('skips when task is itself a review task', async () => {
    const stage = makeStage();
    const ctx = makeCtx({
      task: { ...makeCtx().task, metadata: JSON.stringify({ adversarial_review_task: true }) },
    });
    await stage(ctx);
    expect(mockTaskCore.createTask).not.toHaveBeenCalled();
  });

  it('skips when adversarial_review is off', async () => {
    mockProjectConfig.getProjectConfig.mockReturnValue({ adversarial_review: 'off' });
    const stage = makeStage();
    await stage(makeCtx());
    expect(mockTaskCore.createTask).not.toHaveBeenCalled();
  });

  it('skips when review_task is set', async () => {
    const stage = makeStage();
    const ctx = makeCtx({
      task: { ...makeCtx().task, metadata: JSON.stringify({ review_task: true }) },
    });
    await stage(ctx);
    expect(mockTaskCore.createTask).not.toHaveBeenCalled();
  });

  it('in auto mode, triggers only when high-risk files exist', async () => {
    mockProjectConfig.getProjectConfig.mockReturnValue({ adversarial_review: 'auto' });
    mockFileRiskAdapter.scoreAndPersist.mockReturnValue([
      { file_path: 'src/auth.js', risk_level: 'high', risk_reasons: ['auth_module'] },
    ]);

    const stage = makeStage();
    await stage(makeCtx());

    expect(mockTaskCore.createTask).toHaveBeenCalledTimes(1);
    const desc = mockTaskCore.createTask.mock.calls[0][0].task_description;
    expect(desc).toContain('auth_module');
  });

  it('in auto mode, skips when no high-risk files', async () => {
    mockProjectConfig.getProjectConfig.mockReturnValue({ adversarial_review: 'auto' });
    mockFileRiskAdapter.scoreAndPersist.mockReturnValue([
      { file_path: 'src/utils.js', risk_level: 'low', risk_reasons: [] },
    ]);

    const stage = makeStage();
    await stage(makeCtx());
    expect(mockTaskCore.createTask).not.toHaveBeenCalled();
  });

  it('selects a different provider from the original task', async () => {
    const stage = makeStage();
    await stage(makeCtx({ task: { ...makeCtx().task, provider: 'deepinfra' } }));

    const meta = JSON.parse(mockTaskCore.createTask.mock.calls[0][0].metadata);
    expect(meta.intended_provider).not.toBe('deepinfra');
  });

  it('never sets earlyExit in async mode', async () => {
    const stage = makeStage();
    const ctx = makeCtx();
    await stage(ctx);
    expect(ctx.earlyExit).toBe(false);
    expect(ctx.status).toBe('completed');
  });
});
