'use strict';

const { promisify } = require('util');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SUBJECT_MODULE = '../policy-engine/task-hooks';
const ENGINE_MODULE = '../policy-engine/engine';
const SHADOW_ENFORCER_MODULE = '../policy-engine/shadow-enforcer';
const LOGGER_MODULE = '../logger';
const GOVERNANCE_HOOKS_MODULE = '../governance/hooks';

const subjectPath = require.resolve(SUBJECT_MODULE);
const enginePath = require.resolve(ENGINE_MODULE);
const shadowEnforcerPath = require.resolve(SHADOW_ENFORCER_MODULE);
const loggerPath = require.resolve(LOGGER_MODULE);
const governanceHooksPath = require.resolve(GOVERNANCE_HOOKS_MODULE);
const childProcess = require('child_process');
const originalExecFile = childProcess.execFile;

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

function loadRealPolicyTaskHooks() {
  restoreModules();
  return require(SUBJECT_MODULE);
}

function createGovernanceLoggerMock() {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    child: vi.fn(() => child),
    __child: child,
  };
}

function createGovernanceRulesStore(rules) {
  return {
    getActiveRulesForStage: vi.fn((stage) => rules.filter((rule) => rule.stage === stage)),
    incrementViolation: vi.fn(),
  };
}

function makeGovernanceRule(overrides = {}) {
  return {
    id: 'governance-rule',
    name: 'Governance rule',
    description: 'Governance rule for test',
    stage: 'task_submit',
    mode: 'warn',
    enabled: 1,
    violation_count: 0,
    checker_id: 'checkRequireWorktree',
    config: null,
    ...overrides,
  };
}

function normalizeMockExecResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      stdout: value.stdout || '',
      stderr: value.stderr || '',
    };
  }

  return {
    stdout: value === undefined || value === null ? '' : String(value),
    stderr: '',
  };
}

function resolveMockGitResponse(responses, file, args) {
  if (file !== 'git') {
    throw new Error(`Unexpected command: ${file}`);
  }

  const key = Array.isArray(args) ? args.join(' ') : '';
  const response = Object.prototype.hasOwnProperty.call(responses, key)
    ? responses[key]
    : '';

  if (response instanceof Error) {
    throw response;
  }

  return normalizeMockExecResult(
    typeof response === 'function' ? response(file, args) : response,
  );
}

function loadGovernanceHooksWithMockGit(responses = {}) {
  const execFileSpy = vi.fn();
  const mockExecFile = vi.fn((file, args, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') return;

    try {
      const result = resolveMockGitResponse(responses, file, args);
      cb(null, result.stdout, result.stderr);
    } catch (error) {
      cb(error);
    }
  });

  mockExecFile[promisify.custom] = async (file, args, options = {}) => {
    execFileSpy(file, args, options);
    return resolveMockGitResponse(responses, file, args);
  };

  childProcess.execFile = mockExecFile;
  delete require.cache[governanceHooksPath];

  return {
    execFileSpy,
    createGovernanceHooks: require(GOVERNANCE_HOOKS_MODULE).createGovernanceHooks,
  };
}

function restoreGovernanceHooksModule() {
  childProcess.execFile = originalExecFile;
  delete require.cache[governanceHooksPath];
}

function countGitCalls(execFileSpy, expectedArgs) {
  return execFileSpy.mock.calls.filter(([file, args]) => (
    file === 'git'
    && Array.isArray(args)
    && args.length === expectedArgs.length
    && args.every((arg, index) => arg === expectedArgs[index])
  )).length;
}

function expectPolicyTaskHooksImport() {
  expect(loadRealPolicyTaskHooks()).toEqual(expect.objectContaining({
    evaluateTaskSubmissionPolicy: expect.any(Function),
    onTaskSubmit: expect.any(Function),
  }));
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

describe('policy-engine/task-hooks governance git probe caching', () => {
  const repoPath = 'C:\\repo\\torque';

  beforeEach(() => {
    restoreModules();
    restoreGovernanceHooksModule();
  });

  afterEach(() => {
    restoreGovernanceHooksModule();
    restoreModules();
    vi.clearAllMocks();
  });

  it('reuses the unpushed commit probe when both unpushed rules run', async () => {
    expectPolicyTaskHooksImport();

    const { createGovernanceHooks, execFileSpy } = loadGovernanceHooksWithMockGit({
      'log origin/main..HEAD --oneline': 'abc123 Commit awaiting push\n',
    });
    const governanceRules = createGovernanceRulesStore([
      makeGovernanceRule({
        id: 'require-push-before-remote',
        stage: 'task_pre_execute',
        checker_id: 'checkPushedBeforeRemote',
      }),
      makeGovernanceRule({
        id: 'push-before-subagent-tests',
        stage: 'task_pre_execute',
        checker_id: 'checkPushBeforeSubagentTests',
      }),
    ]);
    const hooks = createGovernanceHooks({
      governanceRules,
      logger: createGovernanceLoggerMock(),
    });

    const result = await hooks.evaluate('task_pre_execute', {
      id: 'task-unpushed-cache',
      task_description: 'Run vitest tests in a subagent',
      working_directory: repoPath,
      metadata: JSON.stringify({ remote_execution: true, subagent: true }),
    });

    expect(result.warned.map((entry) => entry.rule_id)).toEqual([
      'require-push-before-remote',
      'push-before-subagent-tests',
    ]);
    expect(countGitCalls(execFileSpy, ['log', 'origin/main..HEAD', '--oneline'])).toBe(1);
    expect(execFileSpy).toHaveBeenCalledWith('git', ['log', 'origin/main..HEAD', '--oneline'], {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
  });

  it('reuses the dirty diff stat probe across diff-dependent checks', async () => {
    expectPolicyTaskHooksImport();

    const { createGovernanceHooks, execFileSpy } = loadGovernanceHooksWithMockGit({
      'diff --stat HEAD': 'server/policy-engine/task-hooks.js | 8 +++++---\n',
    });
    const governanceRules = createGovernanceRulesStore([
      makeGovernanceRule({
        id: 'verify-diff-after-codex',
        stage: 'task_complete',
        checker_id: 'checkDiffAfterCodex',
      }),
      makeGovernanceRule({
        id: 'verify-diff-after-codex-shadow',
        stage: 'task_complete',
        checker_id: 'checkDiffAfterCodex',
        mode: 'shadow',
      }),
    ]);
    const hooks = createGovernanceHooks({
      governanceRules,
      logger: createGovernanceLoggerMock(),
    });

    const result = await hooks.evaluate('task_complete', {
      id: 'task-diff-cache',
      provider: 'codex',
      working_directory: repoPath,
      metadata: JSON.stringify({ intended_provider: 'codex' }),
    });

    expect(result.allPassed).toBe(true);
    expect(countGitCalls(execFileSpy, ['diff', '--stat', 'HEAD'])).toBe(1);
    expect(execFileSpy).toHaveBeenCalledWith('git', ['diff', '--stat', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
  });

  it('reuses branch and worktree probes across worktree checks', async () => {
    expectPolicyTaskHooksImport();

    const { createGovernanceHooks, execFileSpy } = loadGovernanceHooksWithMockGit({
      'branch --show-current': 'main\n',
      'worktree list --porcelain': [
        'worktree C:/repo/torque',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree C:/repo/torque/.worktrees/feat-factory-1',
        'HEAD def456',
        'branch refs/heads/feat/factory-1',
        '',
      ].join('\n'),
    });
    const governanceRules = createGovernanceRulesStore([
      makeGovernanceRule({
        id: 'require-worktree-for-features',
        checker_id: 'checkRequireWorktree',
      }),
      makeGovernanceRule({
        id: 'require-worktree-for-features-duplicate',
        checker_id: 'checkRequireWorktree',
        mode: 'shadow',
      }),
    ]);
    const hooks = createGovernanceHooks({
      governanceRules,
      logger: createGovernanceLoggerMock(),
    });

    const result = await hooks.evaluate('task_submit', {
      id: 'task-worktree-cache',
      task_description: 'Implement a feature',
      working_directory: repoPath,
    });

    expect(result.warned).toHaveLength(1);
    expect(result.shadowed).toHaveLength(1);
    expect(countGitCalls(execFileSpy, ['branch', '--show-current'])).toBe(1);
    expect(countGitCalls(execFileSpy, ['worktree', 'list', '--porcelain'])).toBe(1);
    expect(execFileSpy).toHaveBeenCalledWith('git', ['branch', '--show-current'], {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    expect(execFileSpy).toHaveBeenCalledWith('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
  });

  it('does not run git probes for disabled governance rules', async () => {
    expectPolicyTaskHooksImport();

    const { createGovernanceHooks, execFileSpy } = loadGovernanceHooksWithMockGit({
      'log origin/main..HEAD --oneline': 'abc123 Commit awaiting push\n',
      'diff --stat HEAD': 'server/policy-engine/task-hooks.js | 8 +++++---\n',
      'branch --show-current': 'main\n',
      'worktree list --porcelain': 'worktree C:/repo/torque\nworktree C:/repo/torque/.worktrees/feat\n',
    });
    const governanceRules = createGovernanceRulesStore([
      makeGovernanceRule({
        id: 'require-push-before-remote-disabled',
        stage: 'task_pre_execute',
        checker_id: 'checkPushedBeforeRemote',
        enabled: 0,
      }),
      makeGovernanceRule({
        id: 'push-before-subagent-tests-disabled',
        stage: 'task_pre_execute',
        checker_id: 'checkPushBeforeSubagentTests',
        enabled: 0,
      }),
      makeGovernanceRule({
        id: 'verify-diff-after-codex-disabled',
        stage: 'task_complete',
        checker_id: 'checkDiffAfterCodex',
        enabled: 0,
      }),
      makeGovernanceRule({
        id: 'require-worktree-for-features-disabled',
        checker_id: 'checkRequireWorktree',
        enabled: 0,
      }),
    ]);
    const hooks = createGovernanceHooks({
      governanceRules,
      logger: createGovernanceLoggerMock(),
    });
    const task = {
      id: 'task-disabled-git-rules',
      task_description: 'Run tests for a feature',
      provider: 'codex',
      working_directory: repoPath,
      metadata: JSON.stringify({
        intended_provider: 'codex',
        remote_execution: true,
        subagent: true,
      }),
    };

    await hooks.evaluate('task_pre_execute', task);
    await hooks.evaluate('task_complete', task);
    await hooks.evaluate('task_submit', task);

    expect(execFileSpy).not.toHaveBeenCalled();
  });
});
