'use strict';

const childProcess = require('child_process');

const MODULE_PATH = require.resolve('../policy-engine');
const originalExecFileSync = childProcess.execFileSync;

function loadPolicyEngine(configResolver) {
  delete require.cache[MODULE_PATH];
  return require('../policy-engine').createPolicyEngine({ configResolver });
}

describe('version-control policy engine', () => {
  let configResolver;
  let execFileSyncMock;
  let engine;

  beforeEach(() => {
    vi.restoreAllMocks();
    configResolver = {
      getEffectiveConfig: vi.fn(),
    };
    execFileSyncMock = vi.fn();
    childProcess.execFileSync = execFileSyncMock;
    engine = loadPolicyEngine(configResolver);
  });

  afterEach(() => {
    delete require.cache[MODULE_PATH];
  });

  afterAll(() => {
    childProcess.execFileSync = originalExecFileSync;
    delete require.cache[MODULE_PATH];
  });

  it('blocks commits to protected branches in block mode', () => {
    configResolver.getEffectiveConfig.mockReturnValue({
      branch_policy: {
        protected_branches: ['main'],
        policy_modes: {
          protected_branches: 'block',
        },
      },
    });

    const result = engine.validateBeforeCommit({
      repoPath: 'C:\\repo',
      branch: 'main',
    });

    expect(configResolver.getEffectiveConfig).toHaveBeenCalledWith('C:\\repo');
    expect(result).toEqual({
      allowed: false,
      violations: [{
        type: 'protected_branch',
        branch: 'main',
        message: 'Branch "main" is protected and cannot be committed to directly.',
      }],
    });
  });

  it('allows commits on non-protected feature branches', () => {
    configResolver.getEffectiveConfig.mockReturnValue({
      branch_policy: {
        protected_branches: ['main', 'master'],
        policy_modes: {
          protected_branches: 'block',
        },
      },
    });

    const result = engine.validateBeforeCommit({
      repoPath: 'C:\\repo',
      branch: 'feat/new-login-flow',
    });

    expect(result).toEqual({
      allowed: true,
      violations: [],
    });
  });

  it('reports protected branch violations without blocking in warn mode', () => {
    configResolver.getEffectiveConfig.mockReturnValue({
      branch_policy: {
        protected_branches: ['main'],
        policy_modes: {
          protected_branches: 'warn',
        },
      },
    });

    const result = engine.validateBeforeCommit({
      repoPath: 'C:\\repo',
      branch: 'refs/heads/main',
    });

    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].type).toBe('protected_branch');
  });

  it('validates branch names against the configured regex and returns a suggestion', () => {
    configResolver.getEffectiveConfig.mockReturnValue({
      branch_policy: {
        branch_name_pattern: '^feat\\/[a-z0-9-]+$',
        branch_prefix: ['feat/'],
      },
    });

    const invalid = engine.validateBranchName({
      repoPath: 'C:\\repo',
      branchName: 'bad branch name',
    });
    const valid = engine.validateBranchName({
      repoPath: 'C:\\repo',
      branchName: 'feat/new-login-flow',
    });

    expect(invalid).toEqual({
      valid: false,
      suggestion: 'feat/bad-branch-name',
    });
    expect(valid).toEqual({
      valid: true,
      suggestion: null,
    });
  });

  it('runs merge checks and blocks merges when a required check fails in block mode', () => {
    const checkError = new Error('Command failed: npm test');
    checkError.stdout = 'failing stdout';
    checkError.stderr = 'failing stderr';

    configResolver.getEffectiveConfig.mockReturnValue({
      merge: {
        require_before_merge: ['npm test', 'npm run lint'],
        policy_modes: {
          required_checks: 'block',
        },
      },
    });
    execFileSyncMock
      .mockReturnValueOnce('all tests passed\n')
      .mockImplementationOnce(() => {
        throw checkError;
      });

    const result = engine.validateBeforeMerge({
      repoPath: 'C:\\repo',
      branch: 'feat/new-login-flow',
      targetBranch: 'main',
    });

    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      type: 'required_check_failed',
      check: 'npm run lint',
      branch: 'feat/new-login-flow',
      targetBranch: 'main',
    });
    expect(result.checkResults).toEqual([
      {
        check: 'npm test',
        passed: true,
        output: 'all tests passed',
      },
      {
        check: 'npm run lint',
        passed: false,
        output: 'failing stdout\nfailing stderr\nCommand failed: npm test',
      },
    ]);
  });

  it('allows merges in warn mode while still returning violations for failed checks', () => {
    const checkError = new Error('Command failed: npm verify');
    checkError.stderr = 'verify failed';

    configResolver.getEffectiveConfig.mockReturnValue({
      merge: {
        require_before_merge: ['npm verify'],
        policy_modes: {
          required_checks: 'warn',
        },
      },
    });
    execFileSyncMock.mockImplementationOnce(() => {
      throw checkError;
    });

    const result = engine.validateBeforeMerge({
      repoPath: 'C:\\repo',
      branch: 'feat/warn-mode',
      targetBranch: 'main',
    });

    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.checkResults[0]).toEqual({
      check: 'npm verify',
      passed: false,
      output: 'verify failed\nCommand failed: npm verify',
    });
  });

  it('executes required checks with a 60 second timeout and returns pass fail results', () => {
    const checkError = new Error('Command failed: npm run lint');
    checkError.stderr = 'lint failed';

    execFileSyncMock
      .mockReturnValueOnce('tests ok\n')
      .mockImplementationOnce(() => {
        throw checkError;
      });

    const results = engine.runRequiredChecks({
      repoPath: 'C:\\repo',
      checks: ['npm test', 'npm run lint'],
    });

    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'npm test', {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      shell: true,
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'npm run lint', {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      shell: true,
    });
    expect(results).toEqual([
      {
        check: 'npm test',
        passed: true,
        output: 'tests ok',
      },
      {
        check: 'npm run lint',
        passed: false,
        output: 'lint failed\nCommand failed: npm run lint',
      },
    ]);
  });
});
