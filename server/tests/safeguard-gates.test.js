import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createSafeguardGates, handleSafeguardChecks, register } = require('../validation/safeguard-gates');
const validationRegister = require('../validation/register');
const { createContainer } = require('../container');

/**
 * safeguard-gates: container-resolved factory shape. Tests cover the
 * direct factory (createSafeguardGates) and the container registration.
 * The legacy init({...}) shape was removed once task-manager.js migrated
 * to defaultContainer.get('safeguardGates').
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
  // Post-DI-cleanup, safeguard-gates declares only [db, dashboard, taskManager];
  // utility deps resolve via require() inside the factory and taskManager-bound
  // methods bind from the registered taskManager handle. Override semantics
  // for the swapped-in utilities are exercised directly via createSafeguardGates
  // in the factory-shape describe block above.
  function makeContainerDeps(overrides = {}) {
    return {
      db: {
        getProjectConfig: vi.fn(() => null),
        getProjectFromPath: vi.fn(() => 'test-project'),
      },
      dashboard: { notifyTaskUpdated: vi.fn() },
      taskManager: {
        getActualModifiedFiles: vi.fn(() => []),
        safeUpdateTaskStatus: vi.fn(),
        processQueue: vi.fn(),
      },
      ...overrides,
    };
  }

  it('registers safeguardGates with declared deps', () => {
    const container = createContainer();
    const deps = makeContainerDeps();

    for (const [k, v] of Object.entries(deps)) {
      container.registerValue(k, v);
    }

    register(container);
    container.boot();

    const svc = container.get('safeguardGates');
    expect(typeof svc.handleSafeguardChecks).toBe('function');
  });

  it('validation register boots without optional sandboxManager', () => {
    const container = createContainer();
    const deps = makeContainerDeps({
      testRunnerRegistry: {
        runVerifyCommand: vi.fn(),
        runRemoteOrLocal: vi.fn(),
      },
    });

    for (const [k, v] of Object.entries(deps)) {
      container.registerValue(k, v);
    }

    validationRegister.register(container);
    expect(() => container.boot()).not.toThrow();
    expect(typeof container.get('autoVerifyRetry').handleAutoVerifyRetry).toBe('function');
  });

  it('legacy direct handler does not require a booted default container', () => {
    const result = handleSafeguardChecks({
      taskId: 'fallback-safeguard',
      status: 'completed',
      task: { provider: 'ollama', working_directory: '/repo' },
      proc: { output: 'done' },
    });

    expect(result).toEqual({ approved: true, reason: 'No db available' });
  });

  it('createSafeguardGates respects an explicit deps override', () => {
    // The override pathway is the explicit `deps` object passed to the
    // factory: utility-function overrides win over the require() fallbacks,
    // and method overrides win over the taskManager-bound methods.
    const customSafeguards = vi.fn(() => ({ passed: false, issues: ['custom'] }));
    const customGetModified = vi.fn(() => ['a.js']);
    const safeUpdate = vi.fn();
    const processQueue = vi.fn();
    const deps = {
      db: {
        getProjectConfig: vi.fn(() => null),
        getProjectFromPath: vi.fn(() => 'p'),
      },
      dashboard: { notifyTaskUpdated: vi.fn() },
      runLLMSafeguards: customSafeguards,
      getActualModifiedFiles: customGetModified,
      scopedRollback: vi.fn(() => ({ reverted: [] })),
      safeUpdateTaskStatus: safeUpdate,
      processQueue,
      taskCleanupGuard: new Map(),
    };

    const svc = createSafeguardGates(deps);
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
