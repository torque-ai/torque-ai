import { describe, it, expect, vi, beforeEach } from 'vitest';

const safeguardGates = require('../validation/safeguard-gates');

describe('safeguard-gates', () => {
  let deps;

  beforeEach(() => {
    deps = {
      db: {
        getProjectConfig: vi.fn(() => null),
        getProjectFromPath: vi.fn(() => 'test-project'),
      },
      getActualModifiedFiles: vi.fn(() => []),
      runLLMSafeguards: vi.fn(() => ({ passed: true })),
      scopedRollback: vi.fn(() => ({ reverted: [] })),
      safeUpdateTaskStatus: vi.fn(),
      taskCleanupGuard: new Map(),
      dashboard: { notifyTaskUpdated: vi.fn() },
      processQueue: vi.fn(),
    };
    safeguardGates.init(deps);
  });

  it('skips when status is not completed', () => {
    const ctx = { taskId: 't1', status: 'failed', task: { provider: 'ollama' } };
    safeguardGates.handleSafeguardChecks(ctx);
    expect(deps.runLLMSafeguards).not.toHaveBeenCalled();
  });

  it('skips when task is null', () => {
    const ctx = { taskId: 't2', status: 'completed', task: null };
    safeguardGates.handleSafeguardChecks(ctx);
    expect(deps.runLLMSafeguards).not.toHaveBeenCalled();
  });

  it('skips when provider is codex', () => {
    const ctx = {
      taskId: 't3',
      status: 'completed',
      task: { provider: 'codex', working_directory: '/repo' },
      proc: { output: '' },
    };
    safeguardGates.handleSafeguardChecks(ctx);
    expect(deps.runLLMSafeguards).not.toHaveBeenCalled();
  });

  it('skips when safeguards are disabled in project config', () => {
    deps.db.getProjectConfig.mockReturnValue({ llm_safeguards_enabled: false });
    const ctx = {
      taskId: 't4',
      status: 'completed',
      task: { provider: 'ollama', working_directory: '/repo', task_description: 'add feature' },
      proc: { output: 'done' },
    };
    safeguardGates.handleSafeguardChecks(ctx);
    expect(deps.runLLMSafeguards).not.toHaveBeenCalled();
  });

  it('passes through when safeguards pass', () => {
    deps.runLLMSafeguards.mockReturnValue({ passed: true });
    const ctx = {
      taskId: 't5',
      status: 'completed',
      task: { provider: 'ollama', working_directory: '/repo', task_description: 'implement feature' },
      proc: { output: 'done' },
    };
    safeguardGates.handleSafeguardChecks(ctx);
    expect(ctx.status).toBe('completed');
    expect(ctx.earlyExit).toBeUndefined();
  });

  it('uses process cwd and existing error output when working_directory is missing', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/fallback-repo');
    deps.getActualModifiedFiles.mockReturnValue(undefined);

    const ctx = {
      taskId: 't5b',
      status: 'completed',
      task: { provider: 'ollama', task_description: 'investigate logs' },
      errorOutput: 'captured stderr',
    };

    safeguardGates.handleSafeguardChecks(ctx);

    expect(deps.db.getProjectFromPath).toHaveBeenCalledWith('/fallback-repo');
    expect(deps.db.getProjectConfig).toHaveBeenCalledWith('test-project');
    expect(deps.runLLMSafeguards).toHaveBeenCalledWith('t5b', '/fallback-repo', [], {
      outputText: 'captured stderr',
      checkOutputMarkers: false,
    });

    cwdSpy.mockRestore();
  });

  it('uses the task project directly without path lookup when present', () => {
    const ctx = {
      taskId: 't5c',
      status: 'completed',
      task: {
        provider: 'ollama',
        project: 'named-project',
        working_directory: '/repo',
        task_description: 'review completed changes',
      },
      proc: { output: 'done' },
    };

    safeguardGates.handleSafeguardChecks(ctx);

    expect(deps.db.getProjectConfig).toHaveBeenCalledWith('named-project');
    expect(deps.db.getProjectFromPath).not.toHaveBeenCalled();
    expect(deps.runLLMSafeguards).toHaveBeenCalledWith('t5c', '/repo', [], {
      outputText: 'done',
      checkOutputMarkers: false,
    });
  });

  it('falls back to empty task description and empty output text', () => {
    const ctx = {
      taskId: 't5d',
      status: 'completed',
      task: {
        provider: 'ollama',
        working_directory: '/repo',
      },
    };

    safeguardGates.handleSafeguardChecks(ctx);

    expect(deps.runLLMSafeguards).toHaveBeenCalledWith('t5d', '/repo', [], {
      outputText: '',
      checkOutputMarkers: false,
    });
  });

  it('marks failed when safeguards fail and no retries remain', () => {
    deps.runLLMSafeguards.mockReturnValue({
      passed: false,
      issues: ['Empty file detected'],
      details: {},
    });
    const ctx = {
      taskId: 't6',
      status: 'completed',
      task: { provider: 'ollama', working_directory: '/repo', task_description: 'create module', retry_count: 0, max_retries: 0 },
      proc: { output: 'done' },
    };
    safeguardGates.handleSafeguardChecks(ctx);
    expect(ctx.status).toBe('failed');
    expect(ctx.errorOutput).toContain('LLM SAFEGUARD FAILED');
    expect(ctx.errorOutput).toContain('Empty file detected');
  });

  it('uses rollback_on_build_failure as the safeguard rollback fallback', () => {
    deps.db.getProjectConfig.mockReturnValue({ rollback_on_build_failure: true });
    deps.getActualModifiedFiles.mockReturnValue(['shrunk.js']);
    deps.runLLMSafeguards.mockReturnValue({
      passed: false,
      issues: ['File size decreased by 78%'],
      details: {},
    });

    const ctx = {
      taskId: 't6b',
      status: 'completed',
      task: {
        provider: 'ollama',
        working_directory: '/repo',
        task_description: 'review output',
        retry_count: 0,
        max_retries: 0,
      },
      proc: { output: 'done' },
    };

    safeguardGates.handleSafeguardChecks(ctx);

    expect(deps.scopedRollback).toHaveBeenCalledWith('t6b', '/repo', 'SafeguardRollback');
    expect(ctx.status).toBe('failed');
    expect(ctx.errorOutput).toContain('File size decreased by 78%');
  });

  it('triggers auto-retry when safeguards fail and retries remain', () => {
    deps.runLLMSafeguards.mockReturnValue({
      passed: false,
      issues: ['Stub implementation'],
      details: {},
    });
    deps.getActualModifiedFiles.mockReturnValue(['file.js']);
    const ctx = {
      taskId: 't7',
      status: 'completed',
      task: { provider: 'ollama', working_directory: '/repo', task_description: 'implement handler', retry_count: 0, max_retries: 2 },
      proc: { output: 'done' },
    };
    safeguardGates.handleSafeguardChecks(ctx);
    expect(ctx.earlyExit).toBe(true);
    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith('t7', 'queued', expect.objectContaining({
      retry_count: 1,
    }));
    expect(deps.scopedRollback).toHaveBeenCalled();
    expect(deps.processQueue).toHaveBeenCalled();
  });

  it('requeues zero-byte and stub failures without rollback when no safeguard files are known', () => {
    deps.runLLMSafeguards.mockReturnValue({
      passed: false,
      issues: [
        'Zero-byte file detected',
        'File contains placeholder/stub content',
      ],
      details: { placeholderArtifacts: { artifacts: [] } },
    });
    deps.getActualModifiedFiles.mockReturnValue([]);

    const ctx = {
      taskId: 't7b',
      status: 'completed',
      task: {
        provider: 'ollama',
        working_directory: '/repo',
        task_description: 'audit results',
        retry_count: 0,
        max_retries: 1,
      },
      errorOutput: 'existing failure',
    };

    safeguardGates.handleSafeguardChecks(ctx);

    expect(deps.scopedRollback).not.toHaveBeenCalled();
    expect(ctx.earlyExit).toBe(true);
    expect(ctx.errorOutput).toContain('existing failure');
    expect(ctx.errorOutput).toContain('Zero-byte file detected');
    expect(ctx.errorOutput).toContain('placeholder/stub');
    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith('t7b', 'queued', expect.objectContaining({
      retry_count: 1,
      error_output: expect.stringContaining('[LLM SAFEGUARD FAILED - AUTO-RETRY]'),
    }));
  });

  it('performs scoped rollback when configured', () => {
    deps.db.getProjectConfig.mockReturnValue({ rollback_on_safeguard_failure: true });
    deps.runLLMSafeguards.mockReturnValue({
      passed: false,
      issues: ['Size regression'],
      details: { placeholderArtifacts: { artifacts: [{ path: 'extra.js' }] } },
    });
    deps.getActualModifiedFiles.mockReturnValue(['main.js']);
    const ctx = {
      taskId: 't8',
      status: 'completed',
      task: { provider: 'ollama', working_directory: '/repo', task_description: 'fix bug', retry_count: 0, max_retries: 0 },
      proc: { output: 'done' },
    };
    safeguardGates.handleSafeguardChecks(ctx);
    expect(deps.scopedRollback).toHaveBeenCalledWith('t8', '/repo', 'SafeguardRollback');
  });

  it('clears taskCleanupGuard on auto-retry', () => {
    deps.runLLMSafeguards.mockReturnValue({
      passed: false,
      issues: ['Stub'],
      details: {},
    });
    deps.taskCleanupGuard.set('t9', Date.now());
    const ctx = {
      taskId: 't9',
      status: 'completed',
      task: { provider: 'ollama', working_directory: '/repo', task_description: 'add method', retry_count: 0, max_retries: 1 },
      proc: { output: 'done' },
    };
    safeguardGates.handleSafeguardChecks(ctx);
    expect(deps.taskCleanupGuard.has('t9')).toBe(false);
  });
});
