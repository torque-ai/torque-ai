'use strict';

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SUBJECT_MODULE = '../policy-engine/task-hooks';
const ENGINE_MODULE = '../policy-engine/engine';
const SHADOW_ENFORCER_MODULE = '../policy-engine/shadow-enforcer';
const LOGGER_MODULE = '../logger';

const subjectPath = require.resolve(SUBJECT_MODULE);
const enginePath = require.resolve(ENGINE_MODULE);
const shadowEnforcerPath = require.resolve(SHADOW_ENFORCER_MODULE);
const loggerPath = require.resolve(LOGGER_MODULE);

const originalCacheEntries = new Map([
  [subjectPath, require.cache[subjectPath]],
  [enginePath, require.cache[enginePath]],
  [shadowEnforcerPath, require.cache[shadowEnforcerPath]],
  [loggerPath, require.cache[loggerPath]],
]);

const mockEngine = {
  evaluatePolicies: vi.fn(),
};

const mockShadowEnforcer = {
  isEngineEnabled: vi.fn(),
  isShadowOnly: vi.fn(),
};

const mockChildLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

const mockLogger = {
  child: vi.fn(() => mockChildLogger),
};

function restoreModules() {
  for (const [resolved, entry] of originalCacheEntries.entries()) {
    if (entry) {
      require.cache[resolved] = entry;
    } else {
      delete require.cache[resolved];
    }
  }
}

function resetAllMocks() {
  mockEngine.evaluatePolicies.mockReset();
  mockShadowEnforcer.isEngineEnabled.mockReset();
  mockShadowEnforcer.isShadowOnly.mockReset();
  mockChildLogger.info.mockReset();
  mockChildLogger.warn.mockReset();
  mockLogger.child.mockReset();

  mockLogger.child.mockReturnValue(mockChildLogger);
  mockShadowEnforcer.isEngineEnabled.mockReturnValue(true);
  mockShadowEnforcer.isShadowOnly.mockReturnValue(false);
}

function loadSubject() {
  delete require.cache[subjectPath];
  installMock(ENGINE_MODULE, mockEngine);
  installMock(SHADOW_ENFORCER_MODULE, mockShadowEnforcer);
  installMock(LOGGER_MODULE, mockLogger);
  return require(SUBJECT_MODULE);
}

describe('policy-engine/task-hooks', () => {
  let taskHooks;

  beforeEach(() => {
    restoreModules();
    resetAllMocks();
    taskHooks = loadSubject();
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreModules();
  });

  afterAll(() => {
    restoreModules();
  });

  it('evaluateAtStage skips evaluation when the policy engine is disabled', () => {
    mockShadowEnforcer.isEngineEnabled.mockReturnValue(false);

    const result = taskHooks.evaluateAtStage('task_submit', { id: 'task-disabled' });

    expect(result).toEqual({
      skipped: true,
      reason: 'policy_engine_disabled',
    });
    expect(mockEngine.evaluatePolicies).not.toHaveBeenCalled();
  });

  it('evaluateAtStage builds the engine context from task data and options overrides', () => {
    mockEngine.evaluatePolicies.mockReturnValue({
      summary: {
        failed: 0,
        warned: 0,
        blocked: 0,
      },
      results: [{ policy_id: 'policy-pass' }],
    });

    const taskData = {
      id: 'task-fallback',
      taskId: 'task-ignored-by-options',
      targetType: 'task-run',
      targetId: 'target-from-task',
      project_id: 'Torque',
      workingDirectory: 'C:\\work\\Torque',
      provider: 'codex',
      changedFiles: ['server/policy-engine/task-hooks.js'],
      command: 'npm test',
      releaseId: 'release-42',
      evidence: { verify_command_passed: true },
    };

    const result = taskHooks.evaluateAtStage('task_pre_execute', taskData, {
      target_type: 'workflow',
      target_id: 'workflow-9',
    });

    expect(mockEngine.evaluatePolicies).toHaveBeenCalledWith({
      stage: 'task_pre_execute',
      target_type: 'workflow',
      target_id: 'workflow-9',
      project_id: 'Torque',
      project_path: 'C:\\work\\Torque',
      provider: 'codex',
      changed_files: ['server/policy-engine/task-hooks.js'],
      command: 'npm test',
      release_id: 'release-42',
      evidence: { verify_command_passed: true },
      persist: true,
    });
    expect(result).toEqual({
      summary: {
        failed: 0,
        warned: 0,
        blocked: 0,
      },
      results: [{ policy_id: 'policy-pass' }],
      shadow: false,
      blocked: false,
    });
    expect(mockLogger.child).toHaveBeenCalledWith({ component: 'policy-task-hooks' });
  });

  it('evaluateAtStage returns a non-blocking shadow result and logs shadow failures', () => {
    mockShadowEnforcer.isShadowOnly.mockReturnValue(true);
    mockEngine.evaluatePolicies.mockReturnValue({
      summary: {
        failed: 1,
        warned: 2,
        blocked: 3,
      },
      results: [{ policy_id: 'policy-shadow', outcome: 'fail' }],
    });

    const result = taskHooks.evaluateAtStage('task_complete', { id: 'task-shadow' });

    expect(result).toEqual({
      summary: {
        failed: 1,
        warned: 2,
        blocked: 3,
      },
      results: [{ policy_id: 'policy-shadow', outcome: 'fail' }],
      shadow: true,
      blocked: false,
    });
    expect(mockChildLogger.info).toHaveBeenCalledWith(
      '[Shadow] task_complete: 1 fail, 2 warn (non-blocking)',
    );
  });

  it('evaluateAtStage returns blocked=true in live mode when blocking results are present', () => {
    mockEngine.evaluatePolicies.mockReturnValue({
      summary: {
        failed: 1,
        warned: 0,
        blocked: 2,
      },
      results: [{ policy_id: 'policy-block', outcome: 'fail' }],
    });

    const result = taskHooks.evaluateAtStage('task_submit', { id: 'task-blocked' });

    expect(result).toEqual({
      summary: {
        failed: 1,
        warned: 0,
        blocked: 2,
      },
      results: [{ policy_id: 'policy-block', outcome: 'fail' }],
      shadow: false,
      blocked: true,
    });
    expect(mockChildLogger.info).not.toHaveBeenCalled();
  });

  it('evaluateAtStage returns a skipped evaluation_error result when policy evaluation throws', () => {
    mockEngine.evaluatePolicies.mockImplementation(() => {
      throw new Error('evaluation exploded');
    });

    const result = taskHooks.evaluateAtStage('manual_review', { id: 'task-error' });

    expect(result).toEqual({
      skipped: true,
      reason: 'evaluation_error',
      error: 'evaluation exploded',
    });
    expect(mockChildLogger.warn).toHaveBeenCalledWith(
      'Policy evaluation error at manual_review: evaluation exploded',
    );
  });

  it.each([
    ['onTaskSubmit', 'task_submit'],
    ['onTaskPreExecute', 'task_pre_execute'],
    ['onTaskComplete', 'task_complete'],
  ])('%s evaluates the %s stage using the default task target', (hookName, stage) => {
    mockEngine.evaluatePolicies.mockReturnValue({
      summary: {
        failed: 0,
        warned: 0,
        blocked: 0,
      },
      results: [],
    });

    const result = taskHooks[hookName]({
      id: 'task-123',
      project: 'Torque',
      working_directory: 'C:\\repo\\Torque',
    });

    expect(mockEngine.evaluatePolicies).toHaveBeenCalledWith({
      stage,
      target_type: 'task',
      target_id: 'task-123',
      project_id: 'Torque',
      project_path: 'C:\\repo\\Torque',
      provider: null,
      changed_files: null,
      command: null,
      release_id: null,
      evidence: {},
      persist: true,
    });
    expect(result.blocked).toBe(false);
    expect(result.shadow).toBe(false);
  });

  it('onManualReview evaluates the manual_review stage with release defaults', () => {
    mockEngine.evaluatePolicies.mockReturnValue({
      summary: {
        failed: 0,
        warned: 0,
        blocked: 0,
      },
      results: [],
    });

    const result = taskHooks.onManualReview({
      id: 'task-456',
      releaseId: 'release-7',
      project: 'Torque',
      targetType: 'release_candidate',
    });

    expect(mockEngine.evaluatePolicies).toHaveBeenCalledWith({
      stage: 'manual_review',
      target_type: 'release_candidate',
      target_id: 'release-7',
      project_id: 'Torque',
      project_path: null,
      provider: null,
      changed_files: null,
      command: null,
      release_id: 'release-7',
      evidence: {},
      persist: true,
    });
    expect(result).toMatchObject({
      shadow: false,
      blocked: false,
    });
  });
});
