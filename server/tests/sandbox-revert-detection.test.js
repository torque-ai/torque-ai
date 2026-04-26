'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
// Importing git-test-utils restores real git — required for production code
// (sandbox-revert-detection.js) that calls execFile('git') directly.
const { gitSync, cleanupRepo } = require('./git-test-utils');

const {
  detectSandboxReverts,
  _testing: { isCodexProvider, parseDiffStats, checkFileForRevert },
} = require('../execution/sandbox-revert-detection');

// ─── Git fixture helpers ─────────────────────────────────────────────────

const gitFixtureDirs = new Set();

function createGitRepo() {
  const tag = `sandbox-revert-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(os.tmpdir(), tag);
  fs.mkdirSync(dir, { recursive: true });

  gitSync(['init'], { cwd: dir });
  gitSync(['config', 'user.email', 'test@test.com'], { cwd: dir });
  gitSync(['config', 'user.name', 'Test'], { cwd: dir });

  gitFixtureDirs.add(dir);
  return dir;
}

function cleanupFixture(dir) {
  try {
    cleanupRepo(dir);
  } finally {
    gitFixtureDirs.delete(dir);
  }
}

afterEach(() => {
  for (const dir of [...gitFixtureDirs]) {
    cleanupFixture(dir);
  }
});

afterAll(() => {
  for (const dir of [...gitFixtureDirs]) {
    cleanupFixture(dir);
  }
});

function commitFile(dir, filename, content) {
  fs.writeFileSync(path.join(dir, filename), content);
  gitSync(['add', filename], { cwd: dir });
  gitSync(['commit', '-m', `add ${filename}`, '--no-gpg-sign'], { cwd: dir });
}

function makeCtx(overrides = {}) {
  return {
    taskId: overrides.taskId || 'task-001',
    status: overrides.status || 'completed',
    code: overrides.code !== undefined ? overrides.code : 0,
    proc: {
      provider: overrides.provider || 'codex',
      output: '',
      errorOutput: '',
      // Revert detection only applies to isolated codex worktrees.
      worktreeInfo: { root: overrides.working_directory || os.tmpdir() },
      ...(overrides.proc || {}),
    },
    task: {
      id: overrides.taskId || 'task-001',
      provider: overrides.provider || 'codex',
      working_directory: overrides.working_directory || os.tmpdir(),
      task_description: 'Test task',
      ...(overrides.task || {}),
    },
    filesModified: overrides.filesModified || [],
    output: overrides.output || '',
    errorOutput: overrides.errorOutput || '',
    earlyExit: false,
    validationStages: {},
    pipelineError: false,
  };
}

// ─── isCodexProvider ─────────────────────────────────────────────────────

describe('isCodexProvider', () => {
  it('returns true for "codex"', () => {
    expect(isCodexProvider('codex')).toBe(true);
  });

  it('returns true for "codex-spark"', () => {
    expect(isCodexProvider('codex-spark')).toBe(true);
  });

  it('returns true for mixed case "Codex"', () => {
    expect(isCodexProvider('Codex')).toBe(true);
  });

  it('returns false for "ollama"', () => {
    expect(isCodexProvider('ollama')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isCodexProvider(null)).toBe(false);
    expect(isCodexProvider(undefined)).toBe(false);
    expect(isCodexProvider('')).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(isCodexProvider(123)).toBe(false);
  });
});

// ─── parseDiffStats ──────────────────────────────────────────────────────

describe('parseDiffStats', () => {
  it('counts added and removed lines', () => {
    const diff = [
      '--- a/file.js',
      '+++ b/file.js',
      '@@ -1,5 +1,3 @@',
      ' unchanged',
      '-removed line 1',
      '-removed line 2',
      '-removed line 3',
      '+added line 1',
      ' unchanged end',
    ].join('\n');

    const result = parseDiffStats(diff);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(3);
  });

  it('does not count --- and +++ header lines', () => {
    const diff = [
      '--- a/file.js',
      '+++ b/file.js',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
    ].join('\n');

    const result = parseDiffStats(diff);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it('returns zeros for empty/null input', () => {
    expect(parseDiffStats('')).toEqual({ added: 0, removed: 0 });
    expect(parseDiffStats(null)).toEqual({ added: 0, removed: 0 });
    expect(parseDiffStats(undefined)).toEqual({ added: 0, removed: 0 });
  });

  it('handles additions-only diff', () => {
    const diff = '+new line 1\n+new line 2\n+new line 3';
    const result = parseDiffStats(diff);
    expect(result.added).toBe(3);
    expect(result.removed).toBe(0);
  });

  it('handles removals-only diff', () => {
    const diff = '-old line 1\n-old line 2\n-old line 3\n-old line 4\n-old line 5';
    const result = parseDiffStats(diff);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(5);
  });
});

// ─── checkFileForRevert ──────────────────────────────────────────────────

describe('checkFileForRevert', () => {
  it('returns a Promise (async conversion confirmed)', async () => {
    const dir = createGitRepo();
    commitFile(dir, 'clean.js', 'const x = 1;\n');
    const result = checkFileForRevert('clean.js', dir);
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('returns null when file matches HEAD (no diff)', async () => {
    const dir = createGitRepo();
    commitFile(dir, 'clean.js', 'const x = 1;\n');

    const result = await checkFileForRevert('clean.js', dir);
    expect(result).toBeNull();
  });

  it('detects a revert when lines are removed from HEAD', async () => {
    const dir = createGitRepo();
    // Initial commit with substantial content
    const originalContent = Array.from({ length: 20 }, (_, i) => `function fn${i}() { return ${i}; }`).join('\n');
    commitFile(dir, 'module.js', originalContent);

    // Simulate sandbox writing a stale/smaller version
    const staleContent = Array.from({ length: 5 }, (_, i) => `function fn${i}() { return ${i}; }`).join('\n');
    fs.writeFileSync(path.join(dir, 'module.js'), staleContent);

    const result = await checkFileForRevert('module.js', dir);
    expect(result).not.toBeNull();
    expect(result.reverted).toBe(true);
    expect(result.removed).toBeGreaterThanOrEqual(5);
    expect(result.removed).toBeGreaterThan(result.added);
  });

  it('does not flag additions-only changes as a revert', async () => {
    const dir = createGitRepo();
    commitFile(dir, 'grow.js', 'const x = 1;\n');

    // Add more lines — this is not a revert
    const newContent = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
    fs.writeFileSync(path.join(dir, 'grow.js'), newContent);

    const result = await checkFileForRevert('grow.js', dir);
    expect(result).not.toBeNull();
    expect(result.reverted).toBe(false);
  });

  it('does not flag small removals (< 5 lines) as a revert', async () => {
    const dir = createGitRepo();
    const content = 'line1\nline2\nline3\nline4\nline5\n';
    commitFile(dir, 'small.js', content);

    // Remove 3 lines — below threshold
    fs.writeFileSync(path.join(dir, 'small.js'), 'line1\nline2\n');

    const result = await checkFileForRevert('small.js', dir);
    expect(result).not.toBeNull();
    // removed=3, but threshold is 5
    expect(result.reverted).toBe(false);
  });

  it('returns null for non-existent files', async () => {
    const dir = createGitRepo();
    commitFile(dir, 'exists.js', 'x');

    const result = await checkFileForRevert('nonexistent.js', dir);
    // git diff on a non-tracked file returns empty or errors — both produce null
    expect(result).toBeNull();
  });

  it('truncates large diffs', async () => {
    const dir = createGitRepo();
    // Create a file with lots of lines
    const bigContent = Array.from({ length: 200 }, (_, i) => `// line ${i}`).join('\n') + '\n';
    commitFile(dir, 'big.js', bigContent);

    // "Revert" to a much smaller version
    fs.writeFileSync(path.join(dir, 'big.js'), '// stub\n');

    const result = await checkFileForRevert('big.js', dir);
    expect(result).not.toBeNull();
    expect(result.reverted).toBe(true);
    // The diff text should be present (truncated or not)
    expect(typeof result.diff).toBe('string');
    expect(result.diff.length).toBeGreaterThan(0);
  });
});

// ─── detectSandboxReverts (pipeline stage) ───────────────────────────────

describe('detectSandboxReverts', () => {
  it('returns a Promise (async conversion confirmed)', async () => {
    const ctx = makeCtx({ provider: 'ollama', filesModified: ['file.js'] });
    const result = detectSandboxReverts(ctx);
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('skips non-codex providers', async () => {
    const ctx = makeCtx({ provider: 'ollama', filesModified: ['file.js'] });
    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toBeUndefined();
  });

  it('skips failed tasks', async () => {
    const ctx = makeCtx({ status: 'failed', filesModified: ['file.js'] });
    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toBeUndefined();
  });

  it('skips tasks with no files modified', async () => {
    const ctx = makeCtx({ filesModified: [] });
    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toBeUndefined();
  });

  it('skips tasks with undefined filesModified', async () => {
    const ctx = makeCtx({});
    ctx.filesModified = undefined;
    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toBeUndefined();
  });

  it('skips direct codex runs without worktree isolation', async () => {
    const ctx = makeCtx({
      filesModified: ['file.js'],
      proc: { worktreeInfo: null },
    });

    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toBeUndefined();
  });

  it('does not flag clean files (no revert)', async () => {
    const dir = createGitRepo();
    commitFile(dir, 'clean.js', 'const x = 1;\n');

    const ctx = makeCtx({
      working_directory: dir,
      filesModified: ['clean.js'],
      task: { working_directory: dir },
    });

    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toBeUndefined();
    expect(ctx.errorOutput).toBe('');
  });

  it('detects reverted files and sets ctx.sandboxReverts', async () => {
    const dir = createGitRepo();
    const original = Array.from({ length: 20 }, (_, i) => `export function f${i}() {}`).join('\n') + '\n';
    commitFile(dir, 'system.ts', original);

    // Simulate sandbox writing stale version
    const stale = Array.from({ length: 5 }, (_, i) => `export function f${i}() {}`).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'system.ts'), stale);

    const ctx = makeCtx({
      working_directory: dir,
      filesModified: ['system.ts'],
      task: { working_directory: dir },
    });

    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toBeDefined();
    expect(ctx.sandboxReverts).toHaveLength(1);
    expect(ctx.sandboxReverts[0].file).toBe('system.ts');
    expect(ctx.sandboxReverts[0].removed).toBeGreaterThan(ctx.sandboxReverts[0].added);
  });

  it('appends warning to errorOutput', async () => {
    const dir = createGitRepo();
    const original = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n';
    commitFile(dir, 'data.ts', original);

    fs.writeFileSync(path.join(dir, 'data.ts'), 'line0\n');

    const ctx = makeCtx({
      working_directory: dir,
      filesModified: ['data.ts'],
      task: { working_directory: dir },
      errorOutput: 'existing error',
    });

    await detectSandboxReverts(ctx);
    expect(ctx.errorOutput).toContain('[SANDBOX REVERT]');
    expect(ctx.errorOutput).toContain('data.ts');
    expect(ctx.errorOutput).toContain('existing error');
    expect(ctx.errorOutput).toContain('auto-restored from HEAD');
  });

  it('does not change ctx.status (advisory only)', async () => {
    const dir = createGitRepo();
    const original = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n';
    commitFile(dir, 'keep.ts', original);

    fs.writeFileSync(path.join(dir, 'keep.ts'), 'line0\n');

    const ctx = makeCtx({
      working_directory: dir,
      filesModified: ['keep.ts'],
      task: { working_directory: dir },
    });

    await detectSandboxReverts(ctx);
    expect(ctx.status).toBe('completed');
    expect(ctx.earlyExit).toBe(false);
  });

  it('handles mixed reverted and clean files', async () => {
    const dir = createGitRepo();
    const bigContent = Array.from({ length: 20 }, (_, i) => `fn${i}`).join('\n') + '\n';
    commitFile(dir, 'reverted.js', bigContent);
    commitFile(dir, 'clean.js', 'const ok = true;\n');

    // Revert one, leave the other
    fs.writeFileSync(path.join(dir, 'reverted.js'), 'fn0\n');
    // clean.js stays unchanged

    const ctx = makeCtx({
      working_directory: dir,
      filesModified: ['reverted.js', 'clean.js'],
      task: { working_directory: dir },
    });

    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toHaveLength(1);
    expect(ctx.sandboxReverts[0].file).toBe('reverted.js');
  });

  it('handles multiple reverted files', async () => {
    const dir = createGitRepo();
    const bigContent = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n';
    commitFile(dir, 'a.ts', bigContent);
    commitFile(dir, 'b.ts', bigContent);

    fs.writeFileSync(path.join(dir, 'a.ts'), 'line0\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'line0\n');

    const ctx = makeCtx({
      working_directory: dir,
      filesModified: ['a.ts', 'b.ts'],
      task: { working_directory: dir },
    });

    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toHaveLength(2);
    expect(ctx.errorOutput).toContain('2 file(s)');
  });

  it('accepts codex-spark as a codex provider', async () => {
    const dir = createGitRepo();
    const bigContent = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n';
    commitFile(dir, 'file.ts', bigContent);
    fs.writeFileSync(path.join(dir, 'file.ts'), 'line0\n');

    const ctx = makeCtx({
      provider: 'codex-spark',
      working_directory: dir,
      filesModified: ['file.ts'],
      task: { provider: 'codex-spark', working_directory: dir },
    });

    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toBeDefined();
    expect(ctx.sandboxReverts).toHaveLength(1);
  });

  it('skips null/invalid entries in filesModified', async () => {
    const dir = createGitRepo();
    const bigContent = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n';
    commitFile(dir, 'real.ts', bigContent);
    fs.writeFileSync(path.join(dir, 'real.ts'), 'line0\n');

    const ctx = makeCtx({
      working_directory: dir,
      filesModified: [null, '', undefined, 123, 'real.ts'],
      task: { working_directory: dir },
    });

    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toHaveLength(1);
    expect(ctx.sandboxReverts[0].file).toBe('real.ts');
  });

  it('uses proc.provider over task.provider', async () => {
    const ctx = makeCtx({
      provider: 'ollama',
      filesModified: ['file.js'],
    });
    // Override proc.provider to codex
    ctx.proc.provider = 'codex';
    ctx.task.provider = 'ollama';

    await detectSandboxReverts(ctx);
    expect(ctx.sandboxReverts).toBeUndefined(); // no reverts detected (diff fails = null)
  });

  it('auto-restores reverted files from HEAD', async () => {
    const dir = createGitRepo();
    const original = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n';
    commitFile(dir, 'restored.ts', original);

    // Simulate codex writing a stale version
    fs.writeFileSync(path.join(dir, 'restored.ts'), 'line0\n');

    const ctx = makeCtx({
      working_directory: dir,
      filesModified: ['restored.ts'],
      task: { working_directory: dir },
    });

    await detectSandboxReverts(ctx);

    // File should be restored to HEAD content (normalize line endings for Windows)
    const content = fs.readFileSync(path.join(dir, 'restored.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(content).toBe(original);

    // Restored file should be removed from filesModified
    expect(ctx.filesModified).not.toContain('restored.ts');
    expect(ctx.errorOutput).toContain('auto-restored from HEAD');
  });

  it('preserves non-reverted files in filesModified after auto-restore', async () => {
    const dir = createGitRepo();
    const bigContent = Array.from({ length: 20 }, (_, i) => `fn${i}`).join('\n') + '\n';
    commitFile(dir, 'reverted.js', bigContent);
    commitFile(dir, 'newfile.js', 'original\n');

    // Revert one, legitimately modify the other
    fs.writeFileSync(path.join(dir, 'reverted.js'), 'fn0\n');
    fs.writeFileSync(path.join(dir, 'newfile.js'), 'original\nnewline added\n');

    const ctx = makeCtx({
      working_directory: dir,
      filesModified: ['reverted.js', 'newfile.js'],
      task: { working_directory: dir },
    });

    await detectSandboxReverts(ctx);

    // reverted.js should be auto-restored and removed from filesModified
    expect(ctx.filesModified).not.toContain('reverted.js');
    // newfile.js should still be in filesModified (it was a legitimate change)
    expect(ctx.filesModified).toContain('newfile.js');
  });

  it('falls back to task.provider when proc.provider is missing', async () => {
    const ctx = makeCtx({
      filesModified: ['file.js'],
    });
    ctx.proc.provider = null;
    ctx.task.provider = 'codex';

    await detectSandboxReverts(ctx);
    // Should have attempted detection (not skipped)
    expect(ctx.sandboxReverts).toBeUndefined();
  });
});

// ─── Integration with task-finalizer pipeline ────────────────────────────

describe('integration: detectSandboxReverts in finalizer pipeline', () => {
  it('is registered as a pipeline stage in task-finalizer', () => {
    const finalizer = require('../execution/task-finalizer');

    // Verify the stage is wired by running finalizeTask with a mock that tracks calls
    const stagesCalled = [];
    const mockDb = {
      getTask: vi.fn(() => ({
        id: 'int-001',
        status: 'running',
        provider: 'codex',
        task_description: 'integration test',
        metadata: null,
        output: '',
        error_output: '',
        started_at: new Date(Date.now() - 1000).toISOString(),
      })),
      updateTaskStatus: vi.fn(),
    };

    const trackStage = (name) => vi.fn(() => { stagesCalled.push(name); });

    finalizer.init({
      db: mockDb,
      safeUpdateTaskStatus: vi.fn((...args) => mockDb.updateTaskStatus(...args)),
      sanitizeTaskOutput: (v) => v || '',
      extractModifiedFiles: vi.fn(() => []),
      handleRetryLogic: trackStage('retry_logic'),
      handleSafeguardChecks: trackStage('safeguard_checks'),
      handleFuzzyRepair: trackStage('fuzzy_repair'),
      handleNoFileChangeDetection: trackStage('no_file_change_detection'),
      handleSandboxRevertDetection: trackStage('sandbox_revert_detection'),
      handleAutoValidation: trackStage('auto_validation'),
      handleBuildTestStyleCommit: trackStage('build_test_style_commit'),
      handleAutoVerifyRetry: vi.fn(async () => { stagesCalled.push('auto_verify_retry'); }),
      handleProviderFailover: trackStage('provider_failover'),
      handlePostCompletion: trackStage('post_completion'),
    });

    return finalizer.finalizeTask('int-001', { exitCode: 0 }).then((result) => {
      expect(result.finalized).toBe(true);
      expect(stagesCalled).toContain('sandbox_revert_detection');

      // Verify ordering: sandbox_revert_detection comes after no_file_change_detection
      // and before auto_validation
      const noFileIdx = stagesCalled.indexOf('no_file_change_detection');
      const sandboxIdx = stagesCalled.indexOf('sandbox_revert_detection');
      const autoValIdx = stagesCalled.indexOf('auto_validation');
      expect(sandboxIdx).toBeGreaterThan(noFileIdx);
      expect(sandboxIdx).toBeLessThan(autoValIdx);

      // Verify the stage is recorded in validationStages
      expect(result.validationStages).toHaveProperty('sandbox_revert_detection');
    });
  });
});
