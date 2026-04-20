/**
 * Unit Tests: validation/close-phases.js
 *
 * Tests the three close-handler phases: auto-validation, build/test/style/commit,
 * and provider failover. All dependencies are mocked via init().
 *
 * close-phases.js destructures { execFileSync, spawnSync } from child_process
 * at load time, so we patch cp's exports before requiring the module.
 * fs is used via dot notation (fs.existsSync), so vi.spyOn works fine.
 */

const cp = require('child_process');
const fs = require('fs');
const providerPerformance = require('../db/provider-performance');

// Save originals for child_process (destructured at load time)
const _origExecFileSync = cp.execFileSync;
const _origSpawnSync = cp.spawnSync;

// Persistent mocks for child_process
const mockExecFileSync = vi.fn().mockReturnValue('');
const mockSpawnSync = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });

function loadClosePhasesWithMocks() {
  // Patch child_process exports BEFORE require so destructuring captures our mocks
  cp.execFileSync = mockExecFileSync;
  cp.spawnSync = mockSpawnSync;

  const _modPath = require.resolve('../validation/close-phases');
  const mod = require('../validation/close-phases');

  // Restore originals so other modules aren't affected
  cp.execFileSync = _origExecFileSync;
  cp.spawnSync = _origSpawnSync;

  return mod;
}

describe('Close Phases', () => {
  let closePhases;
  let mockDb;
  let mockDashboard;
  let mocks;

  beforeEach(() => {
    // Reset child_process mocks
    mockExecFileSync.mockReset().mockReturnValue('');
    mockSpawnSync.mockReset().mockReturnValue({ stdout: '', stderr: '', status: 0 });

    // Load module with patched child_process
    closePhases = loadClosePhasesWithMocks();

    // Spy on fs methods (used via dot notation, not destructured)
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('');

    mockDb = {
      getProjectConfig: vi.fn().mockReturnValue(null),
      getProjectFromPath: vi.fn().mockReturnValue('test-project'),
      getConfig: vi.fn().mockReturnValue('1'),
      updateTaskStatus: vi.fn(),
      isProviderQuotaError: vi.fn().mockReturnValue(false),
      getNextFallbackProvider: vi.fn().mockReturnValue(null),
      recordProviderUsage: vi.fn(),
      approveProviderSwitch: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      setCodexExhausted: vi.fn(),
      getTaskFileChanges: vi.fn().mockReturnValue([{ file_path: 'src/changed.js' }]),
      recordFailoverEvent: vi.fn(),
    };

    mockDashboard = {
      notifyTaskUpdated: vi.fn(),
    };

    mocks = {
      checkFileQuality: vi.fn().mockReturnValue({ issues: [] }),
      scopedRollback: vi.fn().mockReturnValue({ reverted: ['src/changed.js'], skipped: [] }),
      runBuildVerification: vi.fn().mockReturnValue({ skipped: true }),
      rollbackTaskChanges: vi.fn().mockReturnValue(true),
      runTestVerification: vi.fn().mockReturnValue({ skipped: true }),
      runStyleCheck: vi.fn().mockReturnValue({ skipped: true }),
      tryCreateAutoPR: vi.fn(),
      extractModifiedFiles: vi.fn().mockReturnValue([]),
      isValidFilePath: vi.fn().mockReturnValue(true),
      isShellSafe: vi.fn().mockReturnValue(true),
      sanitizeTaskOutput: vi.fn((s) => s || ''),
      safeUpdateTaskStatus: vi.fn(),
      tryLocalFirstFallback: vi.fn().mockReturnValue(false),
      tryHashlineTieredFallback: vi.fn().mockReturnValue(false),
      processQueue: vi.fn(),
    };

    closePhases.init({
      db: mockDb,
      dashboard: mockDashboard,
      ...mocks,
    });

    const serverConfig = require('../config');
    vi.spyOn(serverConfig, 'get').mockImplementation((key) => mockDb.getConfig(key));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Helper factories ──────────────────────────────────────

  function makeTask(overrides = {}) {
    return {
      id: 'task-001',
      provider: 'ollama',
      model: 'codellama:latest',
      working_directory: '/tmp/test-project',
      task_description: 'Test task for close phases',
      project: 'test-project',
      retry_count: 0,
      started_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeProc(overrides = {}) {
    return {
      output: overrides.output || 'task output',
      errorOutput: overrides.errorOutput || '',
      baselineCommit: overrides.baselineCommit || null,
      ...overrides,
    };
  }

  function makeCtx(overrides = {}) {
    const task = overrides.task || makeTask();
    const proc = overrides.proc || makeProc();
    return {
      taskId: task.id,
      code: overrides.code !== undefined ? overrides.code : 0,
      proc,
      task,
      filesModified: overrides.filesModified || [],
      status: overrides.status || 'completed',
      output: proc.output,
      errorOutput: proc.errorOutput,
      earlyExit: false,
      ...overrides,
    };
  }

  // ── handleAutoValidation ──────────────────────────────────

  describe('handleAutoValidation', () => {
    it('skips if status !== completed', () => {
      const ctx = makeCtx({ status: 'failed' });
      closePhases.handleAutoValidation(ctx);
      expect(mocks.checkFileQuality).not.toHaveBeenCalled();
      expect(ctx.status).toBe('failed');
    });

    it('is a no-op after aider removal (all providers skip)', () => {
      const ctx = makeCtx({ task: makeTask({ provider: 'codex' }) });
      closePhases.handleAutoValidation(ctx);
      expect(mocks.checkFileQuality).not.toHaveBeenCalled();
      expect(ctx.status).toBe('completed');
    });

    // SKIP REASON: Auto-validation quality failure path was disabled when aider
    // provider was removed. handleAutoValidation currently always passes. Re-enable
    // when quality gate enforcement is re-implemented for other providers.
    it.skip('detects quality issues and reverts files, sets status=failed', () => {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (args[0] === 'diff' && args[1] === '--name-only') return 'src/foo.js\n';
        if (args[0] === 'show') return 'line1\nline2\nline3\n';
        return '';
      });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('line1\nline2\nline3\n');

      mocks.checkFileQuality.mockReturnValue({
        issues: ['Empty function body detected'],
      });

      const ctx = makeCtx();
      closePhases.handleAutoValidation(ctx);

      expect(ctx.status).toBe('failed');
      expect(ctx.errorOutput).toContain('[AUTO-VALIDATION FAILED]');
      expect(ctx.errorOutput).toContain('Empty function body detected');
      expect(mocks.scopedRollback).toHaveBeenCalledWith('task-001', '/tmp/test-project', 'Auto-Validation');
    });

    it('leaves line-count regression checks disabled after aider removal', () => {
      const currentContent = Array(10).fill('line').join('\n');
      const previousContent = Array(100).fill('line').join('\n');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (args[0] === 'diff' && args[1] === '--name-only') return 'src/large.js\n';
        if (args[0] === 'show') return previousContent;
        return '';
      });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(currentContent);

      mocks.checkFileQuality.mockReturnValue({ issues: [] });

      const ctx = makeCtx();
      closePhases.handleAutoValidation(ctx);

      expect(ctx.status).toBe('completed');
      expect(ctx.errorOutput).toBe('');
      expect(mocks.scopedRollback).not.toHaveBeenCalled();
    });

    it('passes when no quality issues found', () => {
      const content = Array(50).fill('line').join('\n');

      mockExecFileSync.mockImplementation((cmd, args) => {
        if (args[0] === 'diff' && args[1] === '--name-only') return 'src/ok.js\n';
        if (args[0] === 'show') return content;
        return '';
      });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(content);

      mocks.checkFileQuality.mockReturnValue({ issues: [] });

      const ctx = makeCtx();
      closePhases.handleAutoValidation(ctx);

      expect(ctx.status).toBe('completed');
      expect(mocks.scopedRollback).not.toHaveBeenCalled();
    });
  });

  // ── handleBuildTestStyleCommit ────────────────────────────

  describe('handleBuildTestStyleCommit', () => {
    it('skips if status !== completed', async () => {
      const ctx = makeCtx({ status: 'failed' });
      await closePhases.handleBuildTestStyleCommit(ctx);
      expect(mocks.runBuildVerification).not.toHaveBeenCalled();
    });

    it('marks failed on build failure', async () => {
      mocks.runBuildVerification.mockReturnValue({
        skipped: false,
        success: false,
        error: 'TSC error: cannot find module xyz'.repeat(10),
      });
      mockDb.getProjectConfig.mockReturnValue(null);

      const ctx = makeCtx();
      await closePhases.handleBuildTestStyleCommit(ctx);

      expect(ctx.status).toBe('failed');
      expect(ctx.errorOutput).toContain('[BUILD VERIFICATION FAILED]');
    });

    it('rolls back on build failure when configured', async () => {
      mocks.runBuildVerification.mockReturnValue({
        skipped: false,
        success: false,
        error: 'Build error details',
      });
      mockDb.getProjectConfig.mockReturnValue({
        rollback_on_build_failure: true,
      });

      const ctx = makeCtx();
      await closePhases.handleBuildTestStyleCommit(ctx);

      expect(ctx.status).toBe('failed');
      expect(mocks.scopedRollback).toHaveBeenCalledWith('task-001', '/tmp/test-project', 'BuildFailure');
      expect(ctx.errorOutput).toContain('[ROLLBACK] Reverted');
    });

    it('commits changes when build passes and auto_commits disabled', async () => {
      mocks.runBuildVerification.mockReturnValue({ skipped: false, success: true });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'auto_commits_disabled') return '1';
        return '1';
      });

      mockSpawnSync.mockImplementation((cmd, args) => {
        if (args[0] === 'status') return { stdout: 'M src/foo.js\n', stderr: '' };
        if (args[0] === 'diff') return { stdout: 'src/foo.js\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      mocks.extractModifiedFiles.mockReturnValue(['src/foo.js']);
      mocks.runTestVerification.mockReturnValue({ skipped: true });
      mocks.runStyleCheck.mockReturnValue({ skipped: true });

      const ctx = makeCtx();
      await closePhases.handleBuildTestStyleCommit(ctx);

      expect(ctx.status).toBe('completed');
      const commitCall = mockSpawnSync.mock.calls.find(
        (c) => c[0] === 'git' && c[1][0] === 'commit'
      );
      expect(commitCall).toBeDefined();
    });

    it('recovers modified files from stderr-only codex transcripts before staging', async () => {
      mocks.runBuildVerification.mockReturnValue({ skipped: false, success: true });
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'auto_commits_disabled') return '1';
        return '1';
      });

      mockSpawnSync.mockImplementation((cmd, args) => {
        if (args[0] === 'status') return { stdout: 'M src/from-stderr.js\n', stderr: '' };
        if (args[0] === 'diff') return { stdout: 'src/from-stderr.js\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      mocks.extractModifiedFiles.mockReturnValue(['src/from-stderr.js']);
      mocks.runTestVerification.mockReturnValue({ skipped: true });
      mocks.runStyleCheck.mockReturnValue({ skipped: true });

      const ctx = makeCtx({
        task: makeTask({ provider: 'codex' }),
        proc: makeProc({
          output: '',
          errorOutput: 'Success. Updated the following files:\nM src/from-stderr.js'
        }),
        filesModified: []
      });

      await closePhases.handleBuildTestStyleCommit(ctx);

      expect(ctx.filesModified).toEqual(['src/from-stderr.js']);
      expect(mocks.extractModifiedFiles).toHaveBeenCalledWith(expect.stringContaining('Success. Updated the following files:'));
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'src/from-stderr.js'],
        expect.objectContaining({ cwd: '/tmp/test-project' })
      );
    });

    it('marks failed on test failure with rollback', async () => {
      mocks.runBuildVerification.mockReturnValue({ skipped: false, success: true });
      mockDb.getConfig.mockReturnValue('1');
      mocks.runTestVerification.mockReturnValue({
        skipped: false,
        success: false,
        error: 'Test suite failed: 3 failures',
      });
      mockDb.getProjectConfig.mockReturnValue({
        rollback_on_test_failure: true,
      });

      const ctx = makeCtx();
      await closePhases.handleBuildTestStyleCommit(ctx);

      expect(ctx.status).toBe('failed');
      expect(ctx.errorOutput).toContain('[TEST VERIFICATION FAILED]');
      expect(mocks.scopedRollback).toHaveBeenCalledWith('task-001', '/tmp/test-project', 'TestFailure');
      expect(ctx.errorOutput).toContain('[ROLLBACK] Reverted');
    });

    it('adds style check warning', async () => {
      mocks.runBuildVerification.mockReturnValue({ skipped: false, success: true });
      mockDb.getConfig.mockReturnValue('1');
      mocks.runTestVerification.mockReturnValue({ skipped: true });
      mocks.runStyleCheck.mockReturnValue({
        skipped: false,
        success: false,
        error: 'Linting: 5 warnings',
      });
      mockDb.getProjectConfig.mockReturnValue(null);

      const ctx = makeCtx();
      await closePhases.handleBuildTestStyleCommit(ctx);

      expect(ctx.status).toBe('completed');
      expect(ctx.output).toContain('[STYLE CHECK WARNING]');
      expect(ctx.output).toContain('Linting: 5 warnings');
    });

    it('triggers auto-PR when configured', async () => {
      mocks.runBuildVerification.mockReturnValue({ skipped: false, success: true });
      mockDb.getConfig.mockReturnValue('1');
      mocks.runTestVerification.mockReturnValue({ skipped: true });
      mocks.runStyleCheck.mockReturnValue({ skipped: true });
      mockDb.getProjectConfig.mockReturnValue({
        auto_pr_enabled: true,
      });

      const ctx = makeCtx();
      await closePhases.handleBuildTestStyleCommit(ctx);

      expect(ctx.status).toBe('completed');
      expect(mocks.tryCreateAutoPR).toHaveBeenCalledWith(
        'task-001',
        expect.any(Object),
        '/tmp/test-project',
        expect.objectContaining({ auto_pr_enabled: true })
      );
    });
  });

  // ── handleProviderFailover ────────────────────────────────

  describe('handleProviderFailover', () => {
    it('uses slot-pull requeue logic instead of legacy fallback chains', () => {
      const slotPullPath = require.resolve('../execution/slot-pull-scheduler');
      const originalSlotPullModule = require.cache[slotPullPath];
      const requeueAfterFailure = vi.fn(() => ({ requeued: true, exhausted: false }));
      const recordTaskOutcomeSpy = vi.spyOn(providerPerformance, 'recordTaskOutcome').mockImplementation(() => {});
      const setDbSpy = vi.spyOn(providerPerformance, 'setDb').mockImplementation(() => {});

      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'scheduling_mode') return 'slot-pull';
        return '1';
      });
      mockDb.getTask.mockReturnValue({
        ...makeTask({ provider: 'codex', retry_count: 0 }),
        status: 'queued',
        provider: null,
        metadata: { eligible_providers: ['anthropic'], _failed_providers: ['codex'] },
      });

      try {
        require.cache[slotPullPath] = {
          id: slotPullPath,
          filename: slotPullPath,
          loaded: true,
          exports: { requeueAfterFailure },
        };

        const task = makeTask({ provider: 'codex', retry_count: 0 });
        const proc = makeProc({ errorOutput: 'Rate limit exceeded' });
        const ctx = makeCtx({ status: 'failed', task, proc, code: 1 });

        closePhases.handleProviderFailover(ctx);

        expect(requeueAfterFailure).toHaveBeenCalledWith('task-001', 'codex', expect.objectContaining({
          deferTerminalWrite: true,
          errorOutput: 'Rate limit exceeded',
        }));
        expect(mockDb.isProviderQuotaError).not.toHaveBeenCalled();
        expect(mocks.tryLocalFirstFallback).not.toHaveBeenCalled();
        expect(mocks.tryHashlineTieredFallback).not.toHaveBeenCalled();
        expect(setDbSpy).toHaveBeenCalledWith(mockDb);
        expect(recordTaskOutcomeSpy).toHaveBeenCalledWith(expect.objectContaining({
          provider: 'codex',
          success: false,
          resubmitted: true,
          autoCheckPassed: false,
        }));
        expect(ctx.status).toBe('queued');
        expect(ctx.earlyExit).toBe(true);
        expect(mocks.processQueue).toHaveBeenCalled();
      } finally {
        if (originalSlotPullModule) {
          require.cache[slotPullPath] = originalSlotPullModule;
        } else {
          delete require.cache[slotPullPath];
        }
        recordTaskOutcomeSpy.mockRestore();
        setDbSpy.mockRestore();
      }
    });

    it('triggers quota failover when quota error detected', () => {
      vi.useFakeTimers();

      mockDb.isProviderQuotaError.mockReturnValue(true);
      mockDb.getNextFallbackProvider.mockReturnValue('anthropic');

      const task = makeTask({ provider: 'codex', retry_count: 0 });
      const proc = makeProc({ errorOutput: 'Rate limit exceeded' });
      const ctx = makeCtx({ status: 'failed', task, proc, code: 1 });

      closePhases.handleProviderFailover(ctx);

      expect(ctx.earlyExit).toBe(true);
      expect(ctx.status).toBe('queued');
      expect(mockDb.approveProviderSwitch).toHaveBeenCalledWith('task-001', 'anthropic');
      expect(mockDb.recordProviderUsage).toHaveBeenCalledWith(
        'codex',
        'task-001',
        expect.objectContaining({ success: false, error_type: 'quota' })
      );
      expect(mockDashboard.notifyTaskUpdated).toHaveBeenCalledWith('task-001');

      vi.useRealTimers();
    });

    it('falls back locally for ollama failures', () => {
      const task = makeTask({ provider: 'ollama', retry_count: 0 });
      const proc = makeProc({ errorOutput: 'connection refused' });
      const ctx = makeCtx({ status: 'failed', task, proc, code: 1 });

      mockDb.getTask.mockReturnValue(task);
      mocks.tryLocalFirstFallback.mockReturnValue(true);

      closePhases.handleProviderFailover(ctx);

      expect(mocks.tryLocalFirstFallback).toHaveBeenCalledWith(
        'task-001',
        expect.objectContaining({
          provider: 'ollama',
          error_output: 'connection refused',
        }),
        'connection refused'
      );
      expect(mocks.processQueue).toHaveBeenCalled();
    });

    it('uses local-first fallback for ollama failures even on model errors', () => {
      const task = makeTask({ provider: 'ollama', retry_count: 0 });
      const proc = makeProc({ errorOutput: 'model not found' });
      const ctx = makeCtx({ status: 'failed', task, proc, code: 1 });

      mockDb.getTask.mockReturnValue(task);
      mocks.tryLocalFirstFallback.mockReturnValue(true);

      closePhases.handleProviderFailover(ctx);

      expect(mocks.tryLocalFirstFallback).toHaveBeenCalledWith(
        'task-001',
        expect.objectContaining({
          provider: 'ollama',
          error_output: 'model not found',
        }),
        'model not found'
      );
      expect(mocks.tryHashlineTieredFallback).not.toHaveBeenCalled();
      expect(mocks.processQueue).toHaveBeenCalled();
    });

    it('leaves terminal write to the finalizer when no failover is needed', () => {
      const task = makeTask({ provider: 'codex', retry_count: 0 });
      const proc = makeProc({ output: 'done successfully' });
      const ctx = makeCtx({ status: 'completed', task, proc, code: 0 });

      closePhases.handleProviderFailover(ctx);

      expect(mocks.safeUpdateTaskStatus).not.toHaveBeenCalled();
      expect(ctx.earlyExit).toBe(false);
      expect(ctx.status).toBe('completed');
    });

    it('recovers stderr-only modified files without terminalizing directly', () => {
      const task = makeTask({ provider: 'codex', retry_count: 0 });
      const proc = makeProc({
        output: '',
        errorOutput: 'Success. Updated the following files:\nM src/worked.js'
      });
      const ctx = makeCtx({ status: 'completed', task, proc, code: 0, filesModified: [] });
      mocks.extractModifiedFiles.mockReturnValue(['src/worked.js']);

      closePhases.handleProviderFailover(ctx);

      expect(ctx.filesModified).toEqual(['src/worked.js']);
      expect(mocks.safeUpdateTaskStatus).not.toHaveBeenCalled();
    });

    it('exhausts fallback chain gracefully', () => {
      mockDb.isProviderQuotaError.mockReturnValue(true);
      mockDb.getNextFallbackProvider.mockReturnValue(null);

      const task = makeTask({ provider: 'codex', retry_count: 0 });
      const proc = makeProc({ errorOutput: 'Rate limit exceeded' });
      const ctx = makeCtx({ status: 'failed', task, proc, code: 1 });

      closePhases.handleProviderFailover(ctx);

      expect(mocks.safeUpdateTaskStatus).not.toHaveBeenCalled();
      expect(ctx.status).toBe('failed');
      expect(ctx.errorOutput).toContain('no fallback provider available');
      expect(ctx.earlyExit).toBe(false);
    });

    it('sets codex_exhausted flag when quota error and fallback chain exhausted for codex provider', () => {
      mockDb.isProviderQuotaError.mockReturnValue(true);
      mockDb.getNextFallbackProvider.mockReturnValue(null);

      const task = makeTask({ provider: 'codex', retry_count: 0 });
      const proc = makeProc({ errorOutput: 'Rate limit exceeded' });
      const ctx = makeCtx({ status: 'failed', task, proc, code: 1 });

      closePhases.handleProviderFailover(ctx);

      expect(mockDb.setCodexExhausted).toHaveBeenCalledWith(true);
    });

    it('does NOT set codex_exhausted flag when fallback provider is available', () => {
      vi.useFakeTimers();

      mockDb.isProviderQuotaError.mockReturnValue(true);
      mockDb.getNextFallbackProvider.mockReturnValue('claude-cli');

      const task = makeTask({ provider: 'codex', retry_count: 0 });
      const proc = makeProc({ errorOutput: 'Rate limit exceeded' });
      const ctx = makeCtx({ status: 'failed', task, proc, code: 1 });

      closePhases.handleProviderFailover(ctx);

      expect(mockDb.setCodexExhausted).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('does NOT set codex_exhausted flag when provider is not codex or claude-cli', () => {
      mockDb.isProviderQuotaError.mockReturnValue(true);
      mockDb.getNextFallbackProvider.mockReturnValue(null);

      const task = makeTask({ provider: 'anthropic', retry_count: 0 });
      const proc = makeProc({ errorOutput: 'Rate limit exceeded' });
      const ctx = makeCtx({ status: 'failed', task, proc, code: 1 });

      closePhases.handleProviderFailover(ctx);

      expect(mockDb.setCodexExhausted).not.toHaveBeenCalled();
    });
  });
});
