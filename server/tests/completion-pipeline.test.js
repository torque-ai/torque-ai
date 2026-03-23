'use strict';
/* global describe, it, expect, beforeEach, vi */

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

installMock('../logger', {
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
});

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
    db: createMockDb(overrides.db),
    parseTaskMetadata: vi.fn().mockReturnValue({}),
    handleWorkflowTermination: vi.fn(),
    handleProjectDependencyResolution: vi.fn(),
    handlePipelineStepCompletion: vi.fn(),
    runOutputSafeguards: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('completion-pipeline', () => {
  let mockDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFireHook.mockResolvedValue(undefined);
    mockTriggerWebhooks.mockResolvedValue(undefined);
    mockDeps = createMockDeps();
    init(mockDeps);
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
        model: 'qwen3-coder:30b',
        task_description: 'write a test',
        started_at: '2026-03-10T10:00:00Z',
        completed_at: '2026-03-10T10:00:30Z',
        exit_code: 0,
      };

      recordModelOutcome(task, true);

      expect(mockDeps.db.classifyTaskType).toHaveBeenCalledWith('write a test');
      expect(mockDeps.db.recordModelOutcome).toHaveBeenCalledWith(
        'qwen3-coder:30b',
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

    it('fires task_complete hook for completed status', () => {
      handlePostCompletion({
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

    it('fires task_fail hook for failed status', () => {
      handlePostCompletion({
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

    it('does not fire hook for non-terminal statuses', () => {
      handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'pending_provider_switch',
      });

      expect(mockFireHook).not.toHaveBeenCalled();
    });

    it('records provider usage with duration and success', () => {
      handlePostCompletion({
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

    it('records provider usage with quota error_type for pending_provider_switch', () => {
      handlePostCompletion({
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

    it('records provider usage with failure error_type for non-zero exit code', () => {
      handlePostCompletion({
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

    it('defaults provider to codex when task has no provider', () => {
      handlePostCompletion({
        taskId: 'task-100', code: 0, task: {},
        status: 'completed',
      });

      expect(mockDeps.db.recordProviderUsage).toHaveBeenCalledWith(
        'codex', 'task-100', expect.any(Object),
      );
    });

    it('triggers webhooks with updated task', () => {
      const updatedTask = { ...baseTask, status: 'completed' };
      mockDeps.db.getTask.mockReturnValue(updatedTask);

      handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockTriggerWebhooks).toHaveBeenCalledWith('completed', updatedTask);
    });

    it('calls handleWorkflowTermination when task has workflow_id', () => {
      mockDeps.db.getTask.mockReturnValue({ ...baseTask, workflow_id: 'wf-1', metadata: '{}' });

      handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockDeps.handleWorkflowTermination).toHaveBeenCalledWith('task-100');
    });

    it('does not call handleWorkflowTermination when task has no workflow_id', () => {
      mockDeps.db.getTask.mockReturnValue({ ...baseTask, metadata: '{}' });

      handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockDeps.handleWorkflowTermination).not.toHaveBeenCalled();
    });

    it('calls handleProjectDependencyResolution with taskId and status', () => {
      handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockDeps.handleProjectDependencyResolution).toHaveBeenCalledWith('task-100', 'completed');
    });

    it('calls handlePipelineStepCompletion for terminal statuses', () => {
      for (const status of ['completed', 'failed', 'cancelled']) {
        vi.clearAllMocks();
        mockDeps.db.getTask.mockReturnValue({ ...baseTask, metadata: '{}' });
        mockTriggerWebhooks.mockResolvedValue(undefined);
        mockDeps.runOutputSafeguards.mockResolvedValue(undefined);

        handlePostCompletion({
          taskId: 'task-100', code: status === 'completed' ? 0 : 1, task: baseTask,
          status,
        });

        expect(mockDeps.handlePipelineStepCompletion).toHaveBeenCalledWith('task-100', status);
      }
    });

    it('does not call handlePipelineStepCompletion for non-terminal statuses', () => {
      mockDeps.db.getTask.mockReturnValue({ ...baseTask, metadata: '{}' });

      handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'running',
      });

      expect(mockDeps.handlePipelineStepCompletion).not.toHaveBeenCalled();
    });

    it('calls runOutputSafeguards', () => {
      const updatedTask = { ...baseTask, status: 'completed' };
      mockDeps.db.getTask.mockReturnValue(updatedTask);

      handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockDeps.runOutputSafeguards).toHaveBeenCalledWith('task-100', 'completed', updatedTask);
    });

    it('calls dispatchTaskEvent', () => {
      const updatedTask = { ...baseTask, status: 'completed' };
      mockDeps.db.getTask.mockReturnValue(updatedTask);

      handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      expect(mockDispatchTaskEvent).toHaveBeenCalledWith('completed', updatedTask);
    });

    it('skips model outcome recording when already finalized by task-finalizer', () => {
      mockDeps.db.getTask.mockReturnValue({ ...baseTask, metadata: '{}' });
      mockDeps.parseTaskMetadata.mockReturnValue({
        finalization: { finalized_at: '2026-03-10T10:01:00Z' },
      });

      handlePostCompletion({
        taskId: 'task-100', code: 0, task: baseTask,
        status: 'completed',
      });

      // recordModelOutcome should NOT have been called (via db.recordModelOutcome)
      // but recordProviderHealth SHOULD still be called
      expect(mockDeps.db.recordModelOutcome).not.toHaveBeenCalled();
      expect(mockDeps.db.recordProviderOutcome).toHaveBeenCalled();
    });

    it('survives recordProviderUsage throwing', () => {
      mockDeps.db.recordProviderUsage.mockImplementation(() => { throw new Error('usage db error'); });

      expect(() => {
        handlePostCompletion({
          taskId: 'task-100', code: 0, task: baseTask,
          status: 'completed',
        });
      }).not.toThrow();
    });

    it('survives outcome recording throwing', () => {
      mockDeps.db.getTask.mockImplementation(() => { throw new Error('getTask error'); });

      expect(() => {
        handlePostCompletion({
          taskId: 'task-100', code: 0, task: baseTask,
          status: 'completed',
        });
      }).not.toThrow();
    });

    it('survives webhook/workflow section throwing', () => {
      // Make getTask succeed for outcome section but fail on second call
      let callCount = 0;
      mockDeps.db.getTask.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return { ...baseTask, metadata: '{}' };
        throw new Error('second getTask fails');
      });

      expect(() => {
        handlePostCompletion({
          taskId: 'task-100', code: 0, task: baseTask,
          status: 'completed',
        });
      }).not.toThrow();
    });

    it('uses proc output/errorOutput as fallback when ctx fields are absent', () => {
      handlePostCompletion({
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
  });
});
