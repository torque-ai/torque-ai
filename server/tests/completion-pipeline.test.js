'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const childProcess = require('child_process');
const originalExecFile = childProcess.execFile;
const mockExecFile = vi.fn();

// --- CJS module mocking utility ---
function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports,
  };
}

// --- Install mocks before requiring the module under test ---
const mockFireHook = vi.fn().mockResolvedValue(undefined);
installMock('../hooks/post-tool-hooks', { fireHook: mockFireHook });

const mockTriggerWebhooks = vi.fn().mockResolvedValue(undefined);
installMock('../handlers/webhook-handlers', { triggerWebhooks: mockTriggerWebhooks });

const mockDispatchTaskEvent = vi.fn();
installMock('../hooks/event-dispatch', { dispatchTaskEvent: mockDispatchTaskEvent });

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
installMock('../logger', {
  child: () => mockLogger,
});

const mockGetDbInstance = vi.fn(() => null);
installMock('../database', { getDbInstance: mockGetDbInstance });

const mockResolveVersionedProject = vi.fn(() => null);
const mockInferIntentFromCommitMessage = vi.fn(() => 'internal');
installMock('../versioning/version-intent', {
  resolveVersionedProject: mockResolveVersionedProject,
  inferIntentFromCommitMessage: mockInferIntentFromCommitMessage,
});

const mockCreateReleaseManager = vi.fn(() => ({}));
installMock('../plugins/version-control/release-manager', {
  createReleaseManager: mockCreateReleaseManager,
});

const mockCreateChangelogGenerator = vi.fn(() => ({}));
installMock('../plugins/version-control/changelog-generator', {
  createChangelogGenerator: mockCreateChangelogGenerator,
});

const mockCutRelease = vi.fn();
const mockCreateAutoReleaseService = vi.fn(() => ({ cutRelease: mockCutRelease }));
installMock('../versioning/auto-release', {
  createAutoReleaseService: mockCreateAutoReleaseService,
});

const { TEST_MODELS } = require('./test-helpers');
const {
  init,
  fireTerminalTaskHook,
  recordModelOutcome,
  recordProviderHealth,
  handlePostCompletion,
} = require('../execution/completion-pipeline');

// --- Helpers ---
function createMockDb(overrides = {}) {
  return {
    classifyTaskType: vi.fn().mockReturnValue('code'),
    recordModelOutcome: vi.fn(),
    recordTaskOutcome: vi.fn(),
    detectTaskLanguage: vi.fn().mockReturnValue('javascript'),
    recordProviderOutcome: vi.fn(),
    recordProviderUsage: vi.fn(),
    getTask: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function createMockDeps(overrides = {}) {
  return {
    rawDb: null,
    db: createMockDb(overrides.db),
    parseTaskMetadata: vi.fn().mockReturnValue({}),
    handleWorkflowTermination: vi.fn(),
    handleProjectDependencyResolution: vi.fn(),
    handlePipelineStepCompletion: vi.fn(),
    runOutputSafeguards: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const VERSIONED_PROJECT_PATH = 'C:/repos/versioned-project';

function mockAsyncGitOutput(stdout) {
  childProcess.execFile = mockExecFile;
  mockExecFile.mockImplementation((_command, _args, _options, callback) => {
    setImmediate(() => callback(null, stdout, ''));
    return { pid: 1234 };
  });
}

function mockAsyncGitFailure(error) {
  childProcess.execFile = mockExecFile;
  mockExecFile.mockImplementation((_command, _args, _options, callback) => {
    setImmediate(() => callback(error, '', 'fatal'));
    return { pid: 1234 };
  });
}

function createMockRawDb(options = {}) {
  const existingHashes = new Set(options.existingHashes || []);
  const statements = {
    lastCommit: {
      get: vi.fn().mockReturnValue(options.lastCommit || null),
    },
    existingCommit: {
      get: vi.fn((_repoPath, commitHash) => (
        existingHashes.has(commitHash) ? { id: `existing-${commitHash}` } : null
      )),
    },
    insertCommit: {
      run: vi.fn(),
    },
  };
  const transactionWrappers = [];
  const rawDb = {
    prepare: vi.fn((sql) => {
      if (sql.includes('ORDER BY created_at DESC LIMIT 1')) return statements.lastCommit;
      if (sql.includes('SELECT id FROM vc_commits')) return statements.existingCommit;
      if (sql.includes('INSERT INTO vc_commits')) return statements.insertCommit;
      return { get: vi.fn(), run: vi.fn(), all: vi.fn(() => []) };
    }),
    transaction: vi.fn((fn) => {
      const wrapper = vi.fn((records) => fn(records));
      transactionWrappers.push(wrapper);
      return wrapper;
    }),
  };

  return {
    ...rawDb,
    statements,
    transactionWrappers,
  };
}

describe('completion-pipeline', () => {
  let mockDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    childProcess.execFile = originalExecFile;
    mockExecFile.mockReset();
    mockGetDbInstance.mockReturnValue(null);
    mockResolveVersionedProject.mockReturnValue(null);
    mockInferIntentFromCommitMessage.mockReturnValue('internal');
    mockCreateAutoReleaseService.mockReturnValue({ cutRelease: mockCutRelease });
    mockFireHook.mockResolvedValue(undefined);
    mockTriggerWebhooks.mockResolvedValue(undefined);
    mockDeps = createMockDeps();
    init(mockDeps);
  });

  afterEach(() => {
    childProcess.execFile = originalExecFile;
  });

  // -------------------------------------------------------
  // init()
  // -------------------------------------------------------
  describe('init()', () => {
    it('merges new deps into existing deps', () => {
      const db1 = createMockDb();
      const db2 = createMockDb();
      const parse1 = vi.fn();
      const _parse2 = vi.fn();

      init({ db: db1, parseTaskMetadata: parse1 });
      init({ db: db2 });

      // After second init, db should be db2, but parseTaskMetadata should persist from first call
      // We verify by calling recordModelOutcome which uses deps.db
      const task = { provider: 'ollama', model: 'test', task_description: 'test' };
      recordModelOutcome(task, true);
      expect(db2.classifyTaskType).toHaveBeenCalled();
      expect(db1.classifyTaskType).not.toHaveBeenCalled();
    });

    it('accepts empty call without error', () => {
      expect(() => init()).not.toThrow();
      expect(() => init({})).not.toThrow();
    });
  });

  // -------------------------------------------------------
  // fireTerminalTaskHook()
  // -------------------------------------------------------
  describe('fireTerminalTaskHook()', () => {
    it('dispatches hook with event type and context', () => {
      const context = { taskId: 'task-1', exitCode: 0 };
      fireTerminalTaskHook('task_complete', context);

      expect(mockFireHook).toHaveBeenCalledWith('task_complete', context);
    });

    it('swallows synchronous errors from fireHook', () => {
      mockFireHook.mockImplementation(() => { throw new Error('sync boom'); });

      expect(() => {
        fireTerminalTaskHook('task_complete', { taskId: 'task-2' });
      }).not.toThrow();
    });

    it('swallows promise rejection from fireHook', async () => {
      const rejectedPromise = Promise.reject(new Error('async boom'));
      // Prevent unhandled rejection warning — the module attaches .catch internally
      rejectedPromise.catch(() => {});
      mockFireHook.mockReturnValue(rejectedPromise);

      expect(() => {
        fireTerminalTaskHook('task_fail', { taskId: 'task-3' });
      }).not.toThrow();

      // Allow microtask to settle
      await new Promise((r) => setTimeout(r, 10));
    });

    it('handles case where fireHook returns non-thenable', () => {
      mockFireHook.mockReturnValue(42);

      expect(() => {
        fireTerminalTaskHook('task_complete', { taskId: 'task-4' });
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------
  // recordModelOutcome()
  // -------------------------------------------------------
  describe('recordModelOutcome()', () => {
    it('records via db.recordModelOutcome when available', () => {
      const task = {
        provider: 'ollama',
        model: TEST_MODELS.DEFAULT,
        task_description: 'write a test',
        started_at: '2026-03-10T10:00:00Z',
        completed_at: '2026-03-10T10:00:30Z',
        exit_code: 0,
      };

      recordModelOutcome(task, true);

      expect(mockDeps.db.classifyTaskType).toHaveBeenCalledWith('write a test');
      expect(mockDeps.db.recordModelOutcome).toHaveBeenCalledWith(
        TEST_MODELS.DEFAULT,
        'code',
        true,
        expect.objectContaining({
          provider: 'ollama',
          duration: 30,
          exit_code: 0,
        }),
      );
    });

    it('uses provider as model name when model is not set', () => {
      const task = { provider: 'codex', task_description: 'do stuff' };

      recordModelOutcome(task, false);

      expect(mockDeps.db.recordModelOutcome).toHaveBeenCalledWith(
        'codex',
        'code',
        false,
        expect.objectContaining({ provider: 'codex' }),
      );
    });

    it('falls back to recordTaskOutcome when db.recordModelOutcome is unavailable', () => {
      const db = createMockDb();
      delete db.recordModelOutcome;
      init({ db });

      const task = {
        provider: 'ollama',
        model: 'test-model',
        task_description: 'fix bug',
        started_at: '2026-03-10T10:00:00Z',
        completed_at: '2026-03-10T10:00:15Z',
        files: JSON.stringify(['src/app.ts']),
      };

      recordModelOutcome(task, true);

      expect(db.detectTaskLanguage).toHaveBeenCalledWith('fix bug', ['src/app.ts']);
      expect(db.recordTaskOutcome).toHaveBeenCalledWith(
        'test-model', 'code', 'javascript', true, 15, null,
      );
    });

    it('falls back to recordTaskOutcome with array files field', () => {
      const db = createMockDb();
      delete db.recordModelOutcome;
      init({ db });

      const task = {
        provider: 'ollama',
        model: 'test-model',
        task_description: 'fix bug',
        files: ['src/app.ts', 'src/utils.ts'],
      };

      recordModelOutcome(task, false);

      expect(db.detectTaskLanguage).toHaveBeenCalledWith('fix bug', ['src/app.ts', 'src/utils.ts']);
    });

    it('skips when task is null', () => {
      recordModelOutcome(null, true);
      expect(mockDeps.db.classifyTaskType).not.toHaveBeenCalled();
    });

    it('skips when task has no provider', () => {
      recordModelOutcome({ task_description: 'test' }, true);
      expect(mockDeps.db.classifyTaskType).not.toHaveBeenCalled();
    });

    it('handles null duration when timestamps are missing', () => {
      const task = { provider: 'codex', model: 'gpt', task_description: 'test' };

      recordModelOutcome(task, true);

      expect(mockDeps.db.recordModelOutcome).toHaveBeenCalledWith(
        'gpt', 'code', true,
        expect.objectContaining({ duration: null }),
      );
    });

    it('swallows errors without throwing', () => {
      mockDeps.db.classifyTaskType.mockImplementation(() => { throw new Error('db error'); });

      expect(() => {
        recordModelOutcome({ provider: 'ollama', model: 'test', task_description: 'x' }, true);
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------
  // recordProviderHealth()
  // -------------------------------------------------------
  describe('recordProviderHealth()', () => {
    it('records via db.recordProviderOutcome', () => {
      const task = { provider: 'ollama' };

      recordProviderHealth(task, true);

      expect(mockDeps.db.recordProviderOutcome).toHaveBeenCalledWith('ollama', true);
    });

    it('records failure outcome', () => {
      const task = { provider: 'codex' };

      recordProviderHealth(task, false);

      expect(mockDeps.db.recordProviderOutcome).toHaveBeenCalledWith('codex', false);
    });

    it('skips when task is null', () => {
      recordProviderHealth(null, true);
      expect(mockDeps.db.recordProviderOutcome).not.toHaveBeenCalled();
    });

    it('skips when task has no provider', () => {
      recordProviderHealth({}, true);
      expect(mockDeps.db.recordProviderOutcome).not.toHaveBeenCalled();
    });

    it('swallows errors without throwing', () => {
      mockDeps.db.recordProviderOutcome.mockImplementation(() => { throw new Error('db down'); });

      expect(() => {
        recordProviderHealth({ provider: 'ollama' }, true);
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------
  // handlePostCompletion()
  // -------------------------------------------------------
  describe('handlePostCompletion()', () => {
    const baseTask = {
      id: 'task-100',
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
      task_description: 'implement feature',
      started_at: '2026-03-10T10:00:00Z',
    };

    beforeEach(() => {
      mockDeps.db.getTask.mockReturnValue({ ...baseTask, metadata: '{}' });
    });

    it('fires task_complete hook for completed status', async () => {
      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed', output: 'done',
      });

      expect(mockFireHook).toHaveBeenCalledWith('task_complete', expect.objectContaining({
        taskId: 'task-100',
        task_id: 'task-100',
        exitCode: 0,
        exit_code: 0,
        output: 'done',
        task: baseTask,
      }));
    });

    it('fires task_fail hook for failed status', async () => {
      await handlePostCompletion({
        taskId: 'task-100', code: 1, task: baseTask,
        status: 'failed', errorOutput: 'crash', output: 'partial',
      });

      expect(mockFireHook).toHaveBeenCalledWith('task_fail', expect.objectContaining({
        taskId: 'task-100',
        exitCode: 1,
        error: 'crash',
        error_output: 'crash',
        output: 'partial',
      }));
    });

    it('does not fire hook for non-terminal statuses', async () => {
      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'pending_provider_switch',
      });

      expect(mockFireHook).not.toHaveBeenCalled();
    });

    it('records provider usage with duration and success', async () => {
      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockDeps.db.recordProviderUsage).toHaveBeenCalledWith(
        'codex', 'task-100',
        expect.objectContaining({
          success: true,
          error_type: null,
        }),
      );
    });

    it('records provider usage with quota error_type for pending_provider_switch', async () => {
      await handlePostCompletion({
        taskId: 'task-100', code: 1, task: baseTask,
        status: 'pending_provider_switch',
      });

      expect(mockDeps.db.recordProviderUsage).toHaveBeenCalledWith(
        'codex', 'task-100',
        expect.objectContaining({
          success: false,
          error_type: 'quota',
        }),
      );
    });

    it('records provider usage with failure error_type for non-zero exit code', async () => {
      await handlePostCompletion({
        taskId: 'task-100', code: 1, task: baseTask,
        status: 'failed',
      });

      expect(mockDeps.db.recordProviderUsage).toHaveBeenCalledWith(
        'codex', 'task-100',
        expect.objectContaining({
          success: false,
          error_type: 'failure',
        }),
      );
    });

    it('defaults provider to codex when task has no provider', async () => {
      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: {},
        status: 'completed',
      });

      expect(mockDeps.db.recordProviderUsage).toHaveBeenCalledWith(
        'codex', 'task-100', expect.any(Object),
      );
    });

    it('triggers webhooks with updated task', async () => {
      const updatedTask = { ...baseTask, status: 'completed' };
      mockDeps.db.getTask.mockReturnValue(updatedTask);

      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockTriggerWebhooks).toHaveBeenCalledWith('completed', updatedTask);
    });

    it('calls handleWorkflowTermination when task has workflow_id', async () => {
      mockDeps.db.getTask.mockReturnValue({ ...baseTask, workflow_id: 'wf-1', metadata: '{}' });

      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockDeps.handleWorkflowTermination).toHaveBeenCalledWith('task-100');
    });

    it('does not call handleWorkflowTermination when task has no workflow_id', async () => {
      mockDeps.db.getTask.mockReturnValue({ ...baseTask, metadata: '{}' });

      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockDeps.handleWorkflowTermination).not.toHaveBeenCalled();
    });

    it('calls handleProjectDependencyResolution with taskId and status', async () => {
      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockDeps.handleProjectDependencyResolution).toHaveBeenCalledWith('task-100', 'completed');
    });

    it('calls handlePipelineStepCompletion for terminal statuses', async () => {
      for (const status of ['completed', 'failed', 'cancelled']) {
        vi.clearAllMocks();
        mockDeps.db.getTask.mockReturnValue({ ...baseTask, metadata: '{}' });
        mockTriggerWebhooks.mockResolvedValue(undefined);
        mockDeps.runOutputSafeguards.mockResolvedValue(undefined);

        await handlePostCompletion({
          taskId: 'task-100', code: status === 'completed' ? 0 : 1, task: baseTask,
          status,
        });

        expect(mockDeps.handlePipelineStepCompletion).toHaveBeenCalledWith('task-100', status);
      }
    });

    it('does not call handlePipelineStepCompletion for non-terminal statuses', async () => {
      mockDeps.db.getTask.mockReturnValue({ ...baseTask, metadata: '{}' });

      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'running',
      });

      expect(mockDeps.handlePipelineStepCompletion).not.toHaveBeenCalled();
    });

    it('calls runOutputSafeguards', async () => {
      const updatedTask = { ...baseTask, status: 'completed' };
      mockDeps.db.getTask.mockReturnValue(updatedTask);

      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockDeps.runOutputSafeguards).toHaveBeenCalledWith('task-100', 'completed', updatedTask);
    });

    it('calls dispatchTaskEvent', async () => {
      const updatedTask = { ...baseTask, status: 'completed' };
      mockDeps.db.getTask.mockReturnValue(updatedTask);

      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockDispatchTaskEvent).toHaveBeenCalledWith('completed', updatedTask);
    });

    it('skips model outcome recording when already finalized by task-finalizer', async () => {
      mockDeps.db.getTask.mockReturnValue({ ...baseTask, metadata: '{}' });
      mockDeps.parseTaskMetadata.mockReturnValue({
        finalization: { finalized_at: '2026-03-10T10:01:00Z' },
      });

      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      // recordModelOutcome should NOT have been called (via db.recordModelOutcome)
      // but recordProviderHealth SHOULD still be called
      expect(mockDeps.db.recordModelOutcome).not.toHaveBeenCalled();
      expect(mockDeps.db.recordProviderOutcome).toHaveBeenCalled();
    });

    it('survives recordProviderUsage throwing', async () => {
      mockDeps.db.recordProviderUsage.mockImplementation(() => { throw new Error('usage db error'); });

      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });
    });

    it('survives outcome recording throwing', async () => {
      mockDeps.db.getTask.mockImplementation(() => { throw new Error('getTask error'); });

      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });
    });

    it('survives webhook/workflow section throwing', async () => {
      // Make getTask succeed for outcome section but fail on second call
      let callCount = 0;
      mockDeps.db.getTask.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return { ...baseTask, metadata: '{}' };
        throw new Error('second getTask fails');
      });

      await handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });
    });

    it('uses proc output/errorOutput as fallback when ctx fields are absent', async () => {
      await handlePostCompletion({
        taskId: 'task-100', code: 1, task: baseTask,
        status: 'failed',
        proc: { output: 'proc-output', errorOutput: 'proc-error' },
      });

      expect(mockFireHook).toHaveBeenCalledWith('task_fail', expect.objectContaining({
        output: 'proc-output',
        error: 'proc-error',
        error_output: 'proc-error',
      }));
    });

    it('scans git once and persists direct commits in a transaction batch', async () => {
      const rawDb = createMockRawDb({
        lastCommit: { commit_hash: 'base123' },
      });
      init({ rawDb });
      mockResolveVersionedProject.mockReturnValue(VERSIONED_PROJECT_PATH);
      mockInferIntentFromCommitMessage.mockImplementation((message) => (
        message.startsWith('fix') ? 'fix' : 'feature'
      ));
      mockAsyncGitOutput(
        'abcdef1234567890|feat: add tracked commit\n1234567890abcdef|fix: preserve pipes | in subject\n',
      );

      await handlePostCompletion({
        taskId: 'task-100',
        code: 0,
        task: { ...baseTask, working_directory: 'C:/sandboxes/task-100' },
        status: 'completed',
      });

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['log', 'base123..HEAD', '--format=%H|%s', '--no-merges'],
        expect.objectContaining({
          cwd: VERSIONED_PROJECT_PATH,
          encoding: 'utf8',
          windowsHide: true,
        }),
        expect.any(Function),
      );
      expect(rawDb.transaction).toHaveBeenCalledTimes(1);
      expect(rawDb.transactionWrappers[0].mock.calls[0][0]).toHaveLength(2);
      expect(rawDb.statements.insertCommit.run).toHaveBeenCalledTimes(2);
      expect(rawDb.statements.insertCommit.run).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        VERSIONED_PROJECT_PATH,
        'main',
        'abcdef1',
        'feat: add tracked commit',
        'feat',
        null,
        'feature',
        expect.any(String),
      );
      expect(rawDb.statements.insertCommit.run).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        VERSIONED_PROJECT_PATH,
        'main',
        '1234567',
        'fix: preserve pipes | in subject',
        'fix',
        null,
        'fix',
        expect.any(String),
      );
    });

    it('does not persist commits when git output is empty', async () => {
      const rawDb = createMockRawDb();
      init({ rawDb });
      mockResolveVersionedProject.mockReturnValue(VERSIONED_PROJECT_PATH);
      mockAsyncGitOutput('\n');

      await handlePostCompletion({
        taskId: 'task-100',
        code: 0,
        task: { ...baseTask, working_directory: 'C:/sandboxes/task-100' },
        status: 'completed',
      });

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['log', '-20', '--format=%H|%s', '--no-merges'],
        expect.objectContaining({ cwd: VERSIONED_PROJECT_PATH }),
        expect.any(Function),
      );
      expect(rawDb.transaction).not.toHaveBeenCalled();
      expect(rawDb.statements.insertCommit.run).not.toHaveBeenCalled();
    });

    it('logs git scan failures without failing post-completion cleanup', async () => {
      const rawDb = createMockRawDb();
      init({ rawDb });
      mockResolveVersionedProject.mockReturnValue(VERSIONED_PROJECT_PATH);
      mockAsyncGitFailure(new Error('git exploded'));

      await expect(handlePostCompletion({
        taskId: 'task-100',
        code: 0,
        task: { ...baseTask, working_directory: 'C:/sandboxes/task-100' },
        status: 'completed',
      })).resolves.toBeUndefined();

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(rawDb.transaction).not.toHaveBeenCalled();
      expect(rawDb.statements.insertCommit.run).not.toHaveBeenCalled();
      expect(mockLogger.warn.mock.calls.some(([message]) => (
        String(message).includes('[Phase 9] Git commit scan failed')
        && String(message).includes('git exploded')
      ))).toBe(true);
    });
  });
});
