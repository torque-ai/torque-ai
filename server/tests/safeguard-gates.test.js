import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createSafeguardGates, register } = require('../validation/safeguard-gates');
const { createContainer } = require('../container');

/**
 * safeguard-gates is the universal-DI pilot module (spec §3, Phase 2).
 * The new tests exercise the factory shape and the container registration.
 * The legacy shape (init + handleSafeguardChecks on the module) remains
 * tested via the bottom describe block while task-manager.js still uses it;
 * those tests delete when the legacy shape is removed.
 */

function makeDeps(overrides = {}) {
  return {
    db: {
      getProjectConfig: vi.fn(() => null),
      getProjectFromPath: vi.fn(() => 'test-project'),
    },
    dashboard: { notifyTaskUpdated: vi.fn() },
    getActualModifiedFiles: vi.fn(() => []),
    runLLMSafeguards: vi.fn(() => ({ passed: true })),
    scopedRollback: vi.fn(() => ({ reverted: [] })),
    safeUpdateTaskStatus: vi.fn(),
    taskCleanupGuard: new Map(),
    processQueue: vi.fn(),
    ...overrides,
  };
}

describe('safeguard-gates — factory shape (createSafeguardGates)', () => {
  let deps;
  let svc;

  beforeEach(() => {
    deps = makeDeps();
    svc = createSafeguardGates(deps);
  });

  it('skips when status is not completed', () => {
    const ctx = { taskId: 't1', status: 'failed', task: { provider: 'ollama' } };
    svc.handleSafeguardChecks(ctx);
    expect(deps.runLLMSafeguards).not.toHaveBeenCalled();
  });

  it('skips when task is null', () => {
    const ctx = { taskId: 't2', status: 'completed', task: null };
    svc.handleSafeguardChecks(ctx);
    expect(deps.runLLMSafeguards).not.toHaveBeenCalled();
  });

  it('skips when provider is codex', () => {
    const ctx = {
      taskId: 't3',
      status: 'completed',
      task: { provider: 'codex', working_directory: '/repo' },
      proc: { output: '' },
    };
    svc.handleSafeguardChecks(ctx);
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
    svc.handleSafeguardChecks(ctx);
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
    svc.handleSafeguardChecks(ctx);
    expect(ctx.status).toBe('completed');
    expect(ctx.earlyExit).toBeUndefined();
  });

  it('returns approved=true when no db is available', () => {
    const noDbSvc = createSafeguardGates({});
    const result = noDbSvc.handleSafeguardChecks({
      taskId: 't-nodb',
      status: 'completed',
      task: { provider: 'ollama' },
    });
    expect(result).toEqual({ approved: true, reason: 'No db available' });
  });

  it('triggers auto-retry on safeguard failure when retries remain', () => {
    deps.runLLMSafeguards.mockReturnValue({
      passed: false,
      issues: ['stub detected'],
      details: { placeholderArtifacts: { artifacts: [{ path: 'a.js' }] } },
    });
    deps.getActualModifiedFiles.mockReturnValue(['a.js']);
    const ctx = {
      taskId: 't-retry',
      status: 'completed',
      task: {
        provider: 'ollama',
        working_directory: '/repo',
        task_description: 'implement feature',
        retry_count: 0,
        max_retries: 3,
      },
      proc: { output: 'work' },
    };
    svc.handleSafeguardChecks(ctx);
    expect(ctx.earlyExit).toBe(true);
    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      't-retry',
      'queued',
      expect.objectContaining({ retry_count: 1 })
    );
    expect(deps.processQueue).toHaveBeenCalledTimes(1);
  });

  it('marks ctx.status = failed when retries are exhausted', () => {
    deps.runLLMSafeguards.mockReturnValue({
      passed: false,
      issues: ['truncation'],
    });
    const ctx = {
      taskId: 't-fail',
      status: 'completed',
      task: {
        provider: 'ollama',
        working_directory: '/repo',
        task_description: 'implement feature',
        retry_count: 3,
        max_retries: 3,
      },
      proc: { output: 'work' },
    };
    svc.handleSafeguardChecks(ctx);
    expect(ctx.status).toBe('failed');
    expect(ctx.errorOutput).toContain('LLM SAFEGUARD FAILED');
  });
});

describe('safeguard-gates — container registration', () => {
  it('registers safeguardGates with declared deps', () => {
    const container = createContainer();
    const deps = makeDeps();

    // Stand in container values for every declared dep
    for (const [k, v] of Object.entries(deps)) {
      container.registerValue(k, v);
    }

    register(container);
    container.boot();

    const svc = container.get('safeguardGates');
    expect(typeof svc.handleSafeguardChecks).toBe('function');
  });

  it('container.override replaces a dep at boot time', () => {
    const container = createContainer();
    const deps = makeDeps();

    for (const [k, v] of Object.entries(deps)) {
      container.registerValue(k, v);
    }

    // Override runLLMSafeguards before boot
    const customSafeguards = vi.fn(() => ({ passed: false, issues: ['custom'] }));
    container.override('runLLMSafeguards', customSafeguards);

    register(container);
    container.boot();

    const svc = container.get('safeguardGates');
    svc.handleSafeguardChecks({
      taskId: 't',
      status: 'completed',
      task: {
        provider: 'ollama',
        working_directory: '/repo',
        task_description: 'add x',
        retry_count: 0,
        max_retries: 0,
      },
      proc: { output: 'done' },
    });

    expect(customSafeguards).toHaveBeenCalled();
  });
});

describe('safeguard-gates — legacy init() shape (DEPRECATED, kept until task-manager.js migrates)', () => {
  // These tests preserve coverage on the old shape during the universal-DI
  // migration. They get deleted in the same commit that removes init() from
  // safeguard-gates.js (after task-manager.js is fully migrated).
  const safeguardGates = require('../validation/safeguard-gates');

  it('init + handleSafeguardChecks works as before', () => {
    const deps = makeDeps();
    safeguardGates.init(deps);
    const ctx = { taskId: 't1', status: 'failed', task: { provider: 'ollama' } };
    safeguardGates.handleSafeguardChecks(ctx);
    expect(deps.runLLMSafeguards).not.toHaveBeenCalled();
  });
});
