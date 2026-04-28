'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

/**
 * P2 Task 5: Verify that completion-pipeline routes Codex failures through
 * recordFailureByCode and non-Codex failures through the legacy recordFailure.
 */

const { createCircuitBreaker } = require('../execution/circuit-breaker');

const SILENT = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

// --- CJS module mock helpers ---
function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}
// Install static mocks required by completion-pipeline before it loads.
// These must be installed before the first require of completion-pipeline.
installMock('../hooks/post-tool-hooks', { fireHook: vi.fn().mockResolvedValue(undefined) });
installMock('../handlers/webhook-handlers', { triggerWebhooks: vi.fn().mockResolvedValue(undefined) });
installMock('../hooks/event-dispatch', { dispatchTaskEvent: vi.fn() });
installMock('../logger', { child: () => SILENT });
installMock('../database', { getDbInstance: vi.fn(() => null) });
installMock('../versioning/version-intent', {
  resolveVersionedProject: vi.fn(() => null),
  inferIntentFromCommitMessage: vi.fn(() => 'internal'),
});
installMock('../plugins/version-control/release-manager', { createReleaseManager: vi.fn(() => ({})) });
installMock('../plugins/version-control/changelog-generator', { createChangelogGenerator: vi.fn(() => ({})) });
installMock('../versioning/auto-release', { createAutoReleaseService: vi.fn(() => ({ cutRelease: vi.fn() })) });
// container mock placeholder — overridden per test below
installMock('../container', { defaultContainer: { has: () => false, get: () => null } });

const { init, handlePostCompletion } = require('../execution/completion-pipeline');

// --- Minimal mock deps ---
function createMockDeps(overrides = {}) {
  return {
    rawDb: null,
    db: {
      classifyTaskType: vi.fn(() => 'code'),
      recordModelOutcome: vi.fn(),
      recordTaskOutcome: vi.fn(),
      detectTaskLanguage: vi.fn(() => 'javascript'),
      recordProviderOutcome: vi.fn(),
      recordProviderUsage: vi.fn(),
      getTask: vi.fn(() => null),
      ...((overrides.db) || {}),
    },
    parseTaskMetadata: vi.fn(() => ({})),
    handleWorkflowTermination: vi.fn(),
    handleProjectDependencyResolution: vi.fn(),
    handlePipelineStepCompletion: vi.fn(),
    runOutputSafeguards: vi.fn().mockResolvedValue(undefined),
    ...(overrides),
  };
}

const baseTask = {
  id: 'task-200',
  task_description: 'do work',
  started_at: '2026-04-26T10:00:00Z',
};

describe('completion-pipeline — Codex circuit-breaker auto-trip (P2 Task 5)', () => {
  let cb;

  beforeEach(() => {
    cb = createCircuitBreaker({ eventBus: { emit() {}, on() {} }, store: null });

    // Point container mock at our circuit-breaker instance.
    installMock('../container', {
      defaultContainer: {
        has: (name) => name === 'circuitBreaker',
        get: (name) => (name === 'circuitBreaker' ? cb : null),
      },
    });

    init(createMockDeps());
  });

  afterEach(() => {
    // Restore neutral container mock so other tests are unaffected.
    installMock('../container', { defaultContainer: { has: () => false, get: () => null } });
    vi.clearAllMocks();
  });

  it('Codex failure routes through recordFailureByCode, not recordFailure', async () => {
    const byCodeSpy = vi.spyOn(cb, 'recordFailureByCode');
    const legacySpy = vi.spyOn(cb, 'recordFailure');

    await handlePostCompletion({
      taskId: 'task-200',
      code: 1,
      task: { ...baseTask, provider: 'codex', exit_code: 1 },
      status: 'failed',
      errorOutput: 'Error: quota exceeded',
    });

    expect(byCodeSpy).toHaveBeenCalledOnce();
    expect(byCodeSpy).toHaveBeenCalledWith('codex', expect.objectContaining({ exitCode: 1 }));
    expect(legacySpy).not.toHaveBeenCalled();
  });

  it('codex-spark failure routes through recordFailureByCode, not recordFailure', async () => {
    const byCodeSpy = vi.spyOn(cb, 'recordFailureByCode');
    const legacySpy = vi.spyOn(cb, 'recordFailure');

    await handlePostCompletion({
      taskId: 'task-200',
      code: -101,
      task: { ...baseTask, provider: 'codex-spark', exit_code: -101 },
      status: 'failed',
      errorOutput: 'Quota sentinel',
    });

    expect(byCodeSpy).toHaveBeenCalledOnce();
    expect(byCodeSpy).toHaveBeenCalledWith('codex-spark', expect.objectContaining({ exitCode: -101 }));
    expect(legacySpy).not.toHaveBeenCalled();
  });

  it('non-Codex provider failure uses legacy recordFailure, not recordFailureByCode', async () => {
    const byCodeSpy = vi.spyOn(cb, 'recordFailureByCode');
    const legacySpy = vi.spyOn(cb, 'recordFailure');

    await handlePostCompletion({
      taskId: 'task-200',
      code: 1,
      task: { ...baseTask, provider: 'groq', exit_code: 1 },
      status: 'failed',
      errorOutput: '500 Internal Server Error',
    });

    expect(legacySpy).toHaveBeenCalledOnce();
    expect(legacySpy).toHaveBeenCalledWith('groq', '500 Internal Server Error');
    expect(byCodeSpy).not.toHaveBeenCalled();
  });

  it('Codex success calls recordSuccess, neither failure path', async () => {
    const successSpy = vi.spyOn(cb, 'recordSuccess');
    const byCodeSpy = vi.spyOn(cb, 'recordFailureByCode');
    const legacySpy = vi.spyOn(cb, 'recordFailure');

    await handlePostCompletion({
      taskId: 'task-200',
      code: 0,
      task: { ...baseTask, provider: 'codex', exit_code: 0 },
      status: 'completed',
      output: 'all done',
    });

    expect(successSpy).toHaveBeenCalledWith('codex');
    expect(byCodeSpy).not.toHaveBeenCalled();
    expect(legacySpy).not.toHaveBeenCalled();
  });

  it('Codex failure passes error_code field when present on task', async () => {
    const byCodeSpy = vi.spyOn(cb, 'recordFailureByCode');

    await handlePostCompletion({
      taskId: 'task-200',
      code: 1,
      task: { ...baseTask, provider: 'codex', exit_code: 1, error_code: 'quota_exceeded' },
      status: 'failed',
      errorOutput: '',
    });

    expect(byCodeSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      errorCode: 'quota_exceeded',
      exitCode: 1,
    }));
  });
});
