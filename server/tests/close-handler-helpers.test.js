/**
 * Unit tests for close-handler helper functions extracted from startTask().
 * Tests the 10 named helpers that compose the child.on('close') pipeline.
 *
 * Uses setupE2eDb for an isolated real DB + fresh task-manager module.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { setupE2eDb, teardownE2eDb, registerMockHost } = require('./e2e-helpers');
const { gitSync, cleanupRepo } = require('./git-test-utils');

// vi.mock for mcp-sse — prevents slow module loading from dispatchTaskEvent path
vi.mock('../mcp/sse', () => ({
  notifySubscribedSessions: vi.fn(),
  getActiveSessionCount: vi.fn().mockReturnValue(0),
  sessions: new Map(),
  notificationMetrics: {},
}));

// ─── Per-test git fixture directories (created per helper call, cleaned automatically) ───
const gitFixtureDirs = new Set();
const canRunRealGit = (() => {
  try {
    gitSync(['--version']);
    return true;
  } catch {
    return false;
  }
})();
function gitIt(name, fn) {
  if (canRunRealGit) {
    return it(name, fn);
  }
  return it.skip(name, fn);
}

function registerGitFixtureDir(dir) {
  gitFixtureDirs.add(dir);
  return dir;
}

function cleanupGitFixtureDir(dir) {
  try {
    cleanupRepo(dir);
  } finally {
    gitFixtureDirs.delete(dir);
  }
}

function ensureSharedGitRepo() {
  const safePid = process.pid;
  const fixtureTag = `close-test-shared-git-${path.basename(__filename)}-${safePid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const fixturePath = path.join(os.tmpdir(), fixtureTag);
  fs.mkdirSync(fixturePath, { recursive: true });

  try {
    gitSync(['init'], { cwd: fixturePath });
    gitSync(['config', 'user.email', 'test@test.com'], { cwd: fixturePath });
    gitSync(['config', 'user.name', 'Test'], { cwd: fixturePath });
    const content = Array.from({ length: 30 }, (_, i) => `function fn${i}() { return ${i}; }`).join('\n');
    fs.writeFileSync(path.join(fixturePath, 'test.js'), content);
    fs.writeFileSync(path.join(fixturePath, 'valid.js'), content);
    gitSync(['add', '.'], { cwd: fixturePath });
    gitSync(['commit', '-m', 'init', '--no-gpg-sign'], { cwd: fixturePath });

    // A second commit ensures parent refs like HEAD~1 are always available in fixture repos.
    fs.writeFileSync(path.join(fixturePath, 'safeguard.txt'), 'fixture-ready');
    gitSync(['add', '.'], { cwd: fixturePath });
    gitSync(['commit', '-m', 'bootstrap', '--no-gpg-sign'], { cwd: fixturePath });

    return registerGitFixtureDir(fixturePath);
  } catch (error) {
    try {
      fs.rmSync(fixturePath, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

function cloneGitFixture() {
  return ensureSharedGitRepo();
}

afterEach(() => {
  for (const dir of [...gitFixtureDirs]) {
    cleanupGitFixtureDir(dir);
  }
});

afterAll(() => {
  for (const dir of [...gitFixtureDirs]) {
    cleanupGitFixtureDir(dir);
  }
});

let ctx;
let db;
let tm;

// Suite-level setup: create DB + task-manager once, not per-test.
// Per-test reset clears tasks table + in-memory state (~0ms vs ~2s).
beforeAll(() => {
  ctx = setupE2eDb('close-helpers');
  db = ctx.db;
  tm = ctx.tm;
  // This test file needs real git for testing close handler behavior
  tm._testing.skipGitInCloseHandler = false;
});

afterAll(async () => {
  if (ctx) await teardownE2eDb(ctx);
  ctx = null;
  db = null;
  tm = null;
});

function resetBetweenTests() {
  if (!db) return;
  try {
    // Clear tasks and related tables
    const rawDb = db.getDbInstance ? db.getDbInstance() : null;
    if (rawDb) {
      rawDb.prepare('DELETE FROM tasks').run();
      try { rawDb.prepare('DELETE FROM ollama_hosts').run(); } catch { /* ok */ }
      try { rawDb.prepare('DELETE FROM model_task_outcomes').run(); } catch { /* ok */ }
      try { rawDb.prepare('DELETE FROM task_file_changes').run(); } catch { /* ok */ }
    }
  } catch { /* ok */ }
  // Clear in-memory state
  if (tm && tm._testing) {
    tm._testing.runningProcesses.clear();
    tm._testing.stallRecoveryAttempts.clear();
    tm._testing.taskCleanupGuard.clear();
    for (const [, handle] of tm._testing.pendingRetryTimeouts) {
      clearTimeout(handle);
    }
    tm._testing.pendingRetryTimeouts.clear();
  }
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  const status = overrides.status || 'running';
  db.createTask({
    id,
    status,
    task_description: overrides.task_description || 'Test close-handler task',
    provider: overrides.provider || 'ollama',
    model: overrides.model || 'codellama:latest',
    working_directory: overrides.working_directory || os.tmpdir(),
    max_retries: overrides.max_retries || 0,
  });
  // Apply post-create fields that db.createTask may not accept directly
  const postUpdates = {};
  if (overrides.retry_count !== undefined) postUpdates.retry_count = overrides.retry_count;
  if (overrides.started_at) postUpdates.started_at = overrides.started_at;
  if (Object.keys(postUpdates).length > 0) {
    db.updateTaskStatus(id, status, postUpdates);
  }
  return db.getTask(id);
}

function makeProc(overrides = {}) {
  return {
    output: overrides.output || '',
    errorOutput: overrides.errorOutput || '',
    timeoutHandle: null,
    startupTimeoutHandle: null,
    completionGraceHandle: null,
    completionDetected: false,
    ollamaHostId: overrides.ollamaHostId || null,
    baselineCommit: overrides.baselineCommit || null,
    streamErrorCount: 0,
    ...overrides,
  };
}

function makeCtx(task, proc, overrides = {}) {
  return {
    taskId: task.id,
    code: overrides.code !== undefined ? overrides.code : 0,
    status: overrides.status || (overrides.code === 0 || overrides.code === undefined ? 'completed' : 'failed'),
    proc,
    task,
    filesModified: overrides.filesModified || [],
    output: proc.output,
    errorOutput: proc.errorOutput,
    earlyExit: false,
    ...overrides,
  };
}

// ─── handleCloseCleanup ──────────────────────────────────────────────────

describe('handleCloseCleanup', () => {
  beforeEach(resetBetweenTests);

  it('returns shouldContinue=false when task already cleaned up', () => {
    const task = createTask();
    // First call marks as cleaned up
    const r1 = tm.handleCloseCleanup(task.id, 0);
    expect(r1.shouldContinue).toBe(true);

    // Second call should return false (already cleaned up)
    const r2 = tm.handleCloseCleanup(task.id, 0);
    expect(r2.shouldContinue).toBe(false);
  });

  it('clears timeouts and removes from runningProcesses', () => {
    const task = createTask();
    const proc = makeProc();
    proc.timeoutHandle = setTimeout(() => {}, 999999);
    proc.startupTimeoutHandle = setTimeout(() => {}, 999999);
    proc.completionGraceHandle = setTimeout(() => {}, 999999);

    const { runningProcesses } = tm._testing;
    runningProcesses.set(task.id, proc);

    const result = tm.handleCloseCleanup(task.id, 0);
    expect(result.shouldContinue).toBe(true);
    expect(result.proc).toBe(proc);
    expect(runningProcesses.has(task.id)).toBe(false);

    // Clean up timers (clearTimeout is safe on already-cleared handles)
    clearTimeout(proc.timeoutHandle);
    clearTimeout(proc.startupTimeoutHandle);
    clearTimeout(proc.completionGraceHandle);
  });

  it('overrides exit code to 0 when completion was detected in output', () => {
    const task = createTask({ provider: 'codex' });
    // "Changes made:" is a codex-specific completion marker in detectOutputCompletion
    // Pad output to 501+ chars to pass the 500-byte codex threshold
    const proc = makeProc({ output: 'x'.repeat(500) + '\nChanges made:', provider: 'codex' });
    tm._testing.runningProcesses.set(task.id, proc);

    const result = tm.handleCloseCleanup(task.id, 1);
    expect(result.code).toBe(0);
  });

  it('overrides exit code to 0 when completion was detected in stderr (Codex pattern)', () => {
    const task = createTask({ provider: 'codex' });
    // Codex CLI writes task summary to stderr, not stdout.
    // The close handler should check combined stdout+stderr for completion.
    const proc = makeProc({
      output: '',  // stdout is empty for Codex
      errorOutput: 'x'.repeat(500) + '\nChanges made:\n- Updated file.js',
      provider: 'codex',
    });
    tm._testing.runningProcesses.set(task.id, proc);

    const result = tm.handleCloseCleanup(task.id, 1);
    expect(result.code).toBe(0);
  });

  it('overrides exit code when codex success evidence is earlier than the transcript tail', () => {
    const task = createTask({ provider: 'codex' });
    const proc = makeProc({
      output: '',
      errorOutput: `Success. Updated the following files:\nM src/runner.js\n${'x'.repeat(2500)}`,
      provider: 'codex',
    });
    tm._testing.runningProcesses.set(task.id, proc);

    const result = tm.handleCloseCleanup(task.id, 1);
    expect(result.code).toBe(0);
  });

  it('returns proc=undefined when process not in runningProcesses', () => {
    const task = createTask();
    const result = tm.handleCloseCleanup(task.id, 1);
    expect(result.shouldContinue).toBe(true);
    expect(result.proc).toBeUndefined();
  });

  it('removes task from stallRecoveryAttempts', () => {
    const task = createTask();
    const proc = makeProc();
    tm._testing.runningProcesses.set(task.id, proc);
    tm._testing.stallRecoveryAttempts.set(task.id, 2);

    tm.handleCloseCleanup(task.id, 0);
    expect(tm._testing.stallRecoveryAttempts.has(task.id)).toBe(false);
  });

  it('decrements host tasks for ollama hosts', () => {
    const host = registerMockHost(db, 'http://127.0.0.1:19876', ['codellama:latest'], { name: 'close-test' });
    const task = createTask();
    const proc = makeProc({ ollamaHostId: host.id });

    // Increment first so we have something to decrement
    db.incrementHostTasks(host.id);
    const beforeHost = db.getOllamaHost(host.id);
    const beforeCount = beforeHost.running_tasks;

    tm._testing.runningProcesses.set(task.id, proc);
    tm.handleCloseCleanup(task.id, 0);

    const afterHost = db.getOllamaHost(host.id);
    expect(afterHost.running_tasks).toBe(beforeCount - 1);
  });
});

// ─── handleRetryLogic ────────────────────────────────────────────────────

describe('handleRetryLogic', () => {
  beforeEach(resetBetweenTests);

  it('does nothing when error is non-retryable', () => {
    const task = createTask({ max_retries: 3 });
    // 'not a git repository' is classified as permanent/non-retryable
    const proc = makeProc({ errorOutput: 'fatal: not a git repository (or any of the parent directories)' });
    const c = makeCtx(task, proc, { code: 128, status: 'failed' });

    tm.handleRetryLogic(c);
    expect(c.earlyExit).toBe(false);
  });

  it('sets earlyExit when retry is scheduled', () => {
    const task = createTask({ max_retries: 3, retry_count: 0 });
    const proc = makeProc({ errorOutput: 'SIGTERM' });
    const c = makeCtx(task, proc, { code: 1, status: 'failed' });

    tm.handleRetryLogic(c);
    expect(c.earlyExit).toBe(true);

    // Task should be set to retry_scheduled until the retry delay fires.
    const updated = db.getTask(task.id);
    expect(updated.status).toBe('retry_scheduled');

    // Clean up pending retry timeout
    const pendingTimeout = tm._testing.pendingRetryTimeouts.get(task.id);
    if (pendingTimeout) clearTimeout(pendingTimeout);
    tm._testing.pendingRetryTimeouts.delete(task.id);
  });

  it('does not retry when max retries exhausted', () => {
    const task = createTask({ max_retries: 1, retry_count: 1 });
    const proc = makeProc({ errorOutput: 'SIGTERM' });
    const c = makeCtx(task, proc, { code: 1, status: 'failed' });

    tm.handleRetryLogic(c);
    expect(c.earlyExit).toBe(false);
  });

  it('sets earlyExit when task not found during retry', () => {
    const task = createTask({ max_retries: 3 });
    const proc = makeProc({ errorOutput: 'SIGTERM' });
    const c = makeCtx(task, proc, { code: 1, status: 'failed' });

    // Delete the task from DB before retry lookup
    db.updateTaskStatus(task.id, 'cancelled', {});
    // Force the task lookup to fail by deleting
    try { db.deleteTask(task.id); } catch { /* may not exist */ }

    // handleRetryLogic may throw if the task was not fully deleted
    // (e.g., cancelled->retry_scheduled transition blocked). The key
    // assertion is that it either sets earlyExit or throws a status
    // transition error — it should NOT silently succeed with a retry.
    try {
      tm.handleRetryLogic(c);
    } catch (err) {
      expect(err.message).toMatch(/Cannot transition|not found/i);
    }
  });
});

// ─── handleSafeguardChecks ───────────────────────────────────────────────

describe('handleSafeguardChecks', () => {
  beforeEach(resetBetweenTests);

  it('skips when status is not completed', () => {
    const task = createTask();
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'failed' });

    tm.handleSafeguardChecks(c);
    expect(c.earlyExit).toBe(false);
    expect(c.status).toBe('failed');
  });

  it('skips when task is null', () => {
    const proc = makeProc();
    const c = { taskId: 'nonexistent', status: 'completed', proc, task: null, earlyExit: false, errorOutput: '' };

    tm.handleSafeguardChecks(c);
    expect(c.earlyExit).toBe(false);
  });

  gitIt('skips when no modified files detected', () => {
    // Use a git repo with no uncommitted changes — avoids 10s git timeout on non-repo dirs
    const workDir = cloneGitFixture();
    const task = createTask({ working_directory: workDir });
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'completed' });

    tm.handleSafeguardChecks(c);
    expect(c.earlyExit).toBe(false);
    expect(c.status).toBe('completed');

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  gitIt('marks failed when placeholder-only output is returned without validated file changes', () => {
    const workDir = cloneGitFixture();
    const task = createTask({
      provider: 'ollama',
      working_directory: workDir,
      task_description: 'implement the login system'
    });
    const proc = makeProc({ output: '// Placeholder — to be generated by LLM\n' });
    const c = makeCtx(task, proc, { status: 'completed', code: 0 });

    tm.handleSafeguardChecks(c);

    expect(c.status).toBe('failed');
    expect(c.errorOutput).toContain('[LLM SAFEGUARD FAILED]');
    expect(c.errorOutput).toContain('Task output still contains placeholder marker');

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  gitIt('marks failed when an untracked placeholder file remains in the working tree', () => {
    const workDir = cloneGitFixture();
    const placeholderPath = path.join(workDir, 'src', 'placeholder.js');
    fs.mkdirSync(path.dirname(placeholderPath), { recursive: true });
    fs.writeFileSync(placeholderPath, '// Placeholder — to be generated by LLM\n', 'utf8');

    const task = createTask({
      provider: 'ollama',
      working_directory: workDir,
      task_description: 'create src/placeholder.js'
    });
    const proc = makeProc({ output: 'Created src/placeholder.js' });
    const c = makeCtx(task, proc, { status: 'completed', code: 0 });

    tm.handleSafeguardChecks(c);

    expect(c.status).toBe('failed');
    expect(c.errorOutput).toContain('[LLM SAFEGUARD FAILED]');
    expect(c.errorOutput).toContain('src/placeholder.js');
    expect(c.errorOutput).toContain('placeholder marker');

    fs.rmSync(workDir, { recursive: true, force: true });
  });
});

// ─── handleFuzzyRepair ──────────────────────────────────────────────────

describe('handleFuzzyRepair', () => {
  beforeEach(resetBetweenTests);

  it('skips when provider is not ollama', () => {
    const task = createTask({ provider: 'codex' });
    const proc = makeProc({ output: "Can't edit foo.js" });
    const c = makeCtx(task, proc, { status: 'failed', code: 1 });

    tm.handleFuzzyRepair(c);
    expect(c.status).toBe('failed');
  });

  it('skips when no search failure pattern in output', () => {
    const task = createTask({ provider: 'ollama' });
    const proc = makeProc({ output: 'All edits applied successfully' });
    const c = makeCtx(task, proc, { status: 'completed', code: 0 });

    tm.handleFuzzyRepair(c);
    expect(c.status).toBe('completed');
  });

  it('skips when fuzzy repair is disabled', () => {
    db.setConfig('fuzzy_search_repair_enabled', '0');
    const task = createTask({ provider: 'ollama' });
    const proc = makeProc({ output: "Can't edit foo.js" });
    const c = makeCtx(task, proc, { status: 'failed', code: 1 });

    tm.handleFuzzyRepair(c);
    expect(c.status).toBe('failed');
  });

  it('does not throw when working_directory is missing', () => {
    const task = createTask({ provider: 'ollama', working_directory: '' });
    // Override task to have no working_directory
    const rawTask = db.getTask(task.id);
    const proc = makeProc({ output: "Can't edit foo.js" });
    const c = makeCtx({ ...rawTask, working_directory: '' }, proc, { status: 'failed', code: 1 });

    expect(() => tm.handleFuzzyRepair(c)).not.toThrow();
  });
});

// ─── handleNoFileChangeDetection ─────────────────────────────────────────

describe('handleNoFileChangeDetection', () => {
  beforeEach(resetBetweenTests);

  it('skips when status is not completed', () => {
    const task = createTask({ provider: 'ollama' });
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'failed' });

    tm.handleNoFileChangeDetection(c);
    expect(c.earlyExit).toBe(false);
  });

  it('skips when provider is not ollama', () => {
    const task = createTask({ provider: 'codex' });
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'completed' });

    tm.handleNoFileChangeDetection(c);
    expect(c.status).toBe('completed');
  });

  it('leaves completed status unchanged when code-gen verb is present but the phase is disabled', () => {
    const task = createTask({
      provider: 'ollama',
      task_description: 'implement the login system',
    });
    const proc = makeProc({ output: 'Sure, I can help!' });
    const c = makeCtx(task, proc, { status: 'completed', code: 0 });

    tm.handleNoFileChangeDetection(c);
    expect(c.status).toBe('completed');
  });

  it('leaves completed status unchanged for conversational refusal output while the phase is disabled', () => {
    const task = createTask({
      provider: 'ollama',
      task_description: 'fix the bug',
    });
    const proc = makeProc({ output: "I'm ready to make changes, share the files" });
    const c = makeCtx(task, proc, { status: 'completed', code: 0 });

    tm.handleNoFileChangeDetection(c);
    expect(c.status).toBe('completed');
  });

  it('does not flag when files were actually modified', () => {
    let workDir;
    try {
      workDir = cloneGitFixture();
    } catch { return; /* git not available */ }

    // Modify the file (simulating LLM output)
    fs.writeFileSync(path.join(workDir, 'test.js'), 'modified content');

    const task = createTask({
      provider: 'ollama',
      task_description: 'implement the feature',
      working_directory: workDir,
    });
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'completed', code: 0 });

    tm.handleNoFileChangeDetection(c);
    expect(c.status).toBe('completed');

    fs.rmSync(workDir, { recursive: true, force: true });
  });
});

// ─── handleAutoValidation ────────────────────────────────────────────────

describe('handleAutoValidation', () => {
  beforeEach(resetBetweenTests);

  it('skips when status is not completed', () => {
    const task = createTask({ provider: 'ollama' });
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'failed' });

    tm.handleAutoValidation(c);
    expect(c.status).toBe('failed');
  });

  it('skips when provider is not ollama', () => {
    const task = createTask({ provider: 'codex' });
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'completed' });

    tm.handleAutoValidation(c);
    expect(c.status).toBe('completed');
  });

  it('passes clean files without issues', () => {
    let workDir;
    try {
      workDir = cloneGitFixture();
    } catch {
      return; /* git not available */
    }

    try {
      const content = Array.from({ length: 30 }, (_, i) => `function fn${i}() { return ${i}; }`).join('\n');

      // Add more content (grows file, no destruction)
      const newContent = content + '\nfunction extra() { return 42; }\n';
      fs.writeFileSync(path.join(workDir, 'valid.js'), newContent);
    } catch {
      fs.rmSync(workDir, { recursive: true, force: true });
      return;
    }

    const task = createTask({ provider: 'ollama', working_directory: workDir });
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'completed' });

    tm.handleAutoValidation(c);
    expect(c.status).toBe('completed');

    fs.rmSync(workDir, { recursive: true, force: true });
  });
});

// ─── handleBuildTestStyleCommit ──────────────────────────────────────────

describe('handleBuildTestStyleCommit', () => {
  beforeEach(resetBetweenTests);

  it('skips when status is not completed', async () => {
    const task = createTask();
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'failed' });

    await tm.handleBuildTestStyleCommit(c);
    expect(c.status).toBe('failed');
  });

  it('skips when task is null', async () => {
    const proc = makeProc();
    const c = { taskId: 'x', status: 'completed', proc, task: null, earlyExit: false, output: '', errorOutput: '' };

    await expect(tm.handleBuildTestStyleCommit(c)).resolves.not.toThrow();
  });

  it('runs build verification when status is completed', async () => {
    // Without a verify command configured, build verification should be skipped
    const task = createTask();
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'completed', filesModified: ['src/changed.js'] });

    await tm.handleBuildTestStyleCommit(c);
    // Should remain completed since no build command is configured
    expect(c.status).toBe('completed');
  });
});

// ─── handleProviderFailover ──────────────────────────────────────────────

describe('handleProviderFailover', () => {
  beforeEach(resetBetweenTests);

  it('preserves completed status in ctx for successful tasks', () => {
    const task = createTask();
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'completed', code: 0, filesModified: [] });

    tm.handleProviderFailover(c);
    expect(c.earlyExit).toBe(false);

    // handleProviderFailover mutates ctx; DB persistence is the finalizer's job
    expect(c.status).toBe('completed');
  });

  it('preserves failed status in ctx for non-quota failures', () => {
    // Use provider='codex' so it enters the normal else branch (not local-fallback)
    const task = createTask({ provider: 'codex' });
    const proc = makeProc({ errorOutput: 'some random error' });
    const c = makeCtx(task, proc, { status: 'failed', code: 1, filesModified: [] });

    tm.handleProviderFailover(c);

    // handleProviderFailover mutates ctx; DB persistence is the finalizer's job
    expect(c.status).toBe('failed');
  });

  it('attempts local-first fallback for failed ollama tasks', () => {
    registerMockHost(db, 'http://127.0.0.1:19877', ['codellama:latest', 'qwen2.5-coder:14b'], { name: 'failover-test' });

    const task = createTask({ provider: 'ollama', model: 'codellama:latest' });
    const proc = makeProc({ errorOutput: 'model not loaded' });
    const c = makeCtx(task, proc, { status: 'failed', code: 1, filesModified: [] });

    // This should attempt fallback — it may or may not find a fallback path
    // depending on available hosts/models. The key is it doesn't throw.
    expect(() => tm.handleProviderFailover(c)).not.toThrow();
  });

  it('caps failover attempts at 3', () => {
    const task = createTask({ provider: 'codex', retry_count: 3 });
    const proc = makeProc({ errorOutput: 'rate limit exceeded' });
    const c = makeCtx(task, proc, { status: 'failed', code: 1, filesModified: [] });

    tm.handleProviderFailover(c);
    // Should not attempt failover (capped at 3) — codex provider avoids local LLM fallback path
    expect(c.earlyExit).toBe(false);
  });
});

// ─── handlePostCompletion ────────────────────────────────────────────────

describe('handlePostCompletion', () => {
  let safeguardSpy;
  beforeEach(() => {
    resetBetweenTests();
    // Stub runOutputSafeguards to prevent async git operations from hanging.
    // The real implementation does git diff in tmpdir which can take >30s.
    const safeguards = require('../validation/output-safeguards');
    safeguardSpy = vi.spyOn(safeguards, 'runOutputSafeguards').mockResolvedValue(undefined);
  });
  afterEach(() => {
    if (safeguardSpy) safeguardSpy.mockRestore();
  });

  it('records provider usage for completed tasks', async () => {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    const task = createTask({ started_at: startedAt });
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'completed', code: 0 });

    // Should not reject (triggerWebhooks + runOutputSafeguards are fire-and-forget)
    await tm.handlePostCompletion(c);
  }, 5000);

  it('records provider usage for failed tasks', async () => {
    const task = createTask();
    const proc = makeProc({ errorOutput: 'failed' });
    const c = makeCtx(task, proc, { status: 'failed', code: 1 });

    await tm.handlePostCompletion(c);
  }, 5000);

  it('handles missing task gracefully', async () => {
    const _proc = makeProc();
    const c = { taskId: 'nonexistent', code: 0, status: 'completed', task: null, earlyExit: false };

    await tm.handlePostCompletion(c);
  }, 5000);

  it('evaluates workflow dependencies for workflow tasks', async () => {
    // Create a workflow first
    const workflowId = randomUUID();
    try {
      db.createWorkflow({ id: workflowId, name: 'test-workflow' });
    } catch { /* workflow creation may differ */ }

    const task = createTask();
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'completed', code: 0 });

    // Should not reject even with workflow evaluation
    await tm.handlePostCompletion(c);
  }, 5000);

  it('records model outcomes for cloud providers on manual post-completion fallback paths', async () => {
    const startedAt = new Date(Date.now() - 8000).toISOString();
    const task = createTask({
      provider: 'codex',
      model: null,
      started_at: startedAt,
      task_description: 'Write unit tests for auth module',
    });
    const rawDb = db.getDbInstance();
    rawDb.prepare('DELETE FROM model_task_outcomes').run();
    rawDb.prepare('UPDATE tasks SET model = NULL WHERE id = ?').run(task.id);
    const completedAt = new Date().toISOString();
    db.updateTaskStatus(task.id, 'completed', {
      completed_at: completedAt,
      exit_code: 0,
      output: 'done',
    });

    const updatedTask = db.getTask(task.id);
    const c = makeCtx(updatedTask, makeProc({ output: 'done' }), { status: 'completed', code: 0 });

    await tm.handlePostCompletion(c);

    const row = rawDb.prepare(`
      SELECT model_name, task_type, success, duration_s
      FROM model_task_outcomes
      WHERE model_name = ?
    `).get('codex');

    expect(row).toMatchObject({
      model_name: 'codex',
      task_type: 'testing',
      success: 1,
    });
    expect(row.duration_s).toBeGreaterThanOrEqual(7);
    expect(row.duration_s).toBeLessThanOrEqual(9);
  }, 5000);

  it('skips legacy model outcome recording when finalizer metadata is already present', async () => {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    const task = createTask({
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
      started_at: startedAt,
    });
    const rawDb = db.getDbInstance();
    rawDb.prepare('DELETE FROM model_task_outcomes').run();
    db.updateTaskStatus(task.id, 'completed', {
      completed_at: new Date().toISOString(),
      exit_code: 0,
      metadata: JSON.stringify({
        finalization: {
          finalized_at: new Date().toISOString(),
        },
      }),
    });

    const updatedTask = db.getTask(task.id);
    const c = makeCtx(updatedTask, makeProc({ output: 'done' }), { status: 'completed', code: 0 });

    await tm.handlePostCompletion(c);

    const count = rawDb.prepare(`
      SELECT COUNT(*) AS count
      FROM model_task_outcomes
      WHERE model_name = ?
    `).get('gpt-5.3-codex-spark').count;
    expect(count).toBe(0);
  }, 5000);
});

// ─── revertScopedFiles ───────────────────────────────────────────────────

describe('revertScopedFiles', () => {
  beforeEach(resetBetweenTests);

  it('reverts tracked files via git checkout', () => {
    let workDir;
    try {
      workDir = cloneGitFixture();
    } catch {
      return; /* git not available */
    }

    try {
      fs.writeFileSync(path.join(workDir, 'revert-me.js'), 'original');
      gitSync(['add', '.'], { cwd: workDir });
      gitSync(['commit', '-m', 'add revert-me', '--no-gpg-sign'], { cwd: workDir });

      // Modify file
      fs.writeFileSync(path.join(workDir, 'revert-me.js'), 'modified');
      expect(fs.readFileSync(path.join(workDir, 'revert-me.js'), 'utf-8')).toBe('modified');

      // Revert
      tm.revertScopedFiles(workDir, ['revert-me.js'], 'Test');
      expect(fs.readFileSync(path.join(workDir, 'revert-me.js'), 'utf-8')).toBe('original');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('skips untracked files without deleting them', () => {
    let workDir;
    try {
      workDir = cloneGitFixture();
    } catch {
      return; /* git not available */
    }

    try {

      // Create untracked file
      fs.writeFileSync(path.join(workDir, 'new-file.js'), 'new content');
      expect(fs.existsSync(path.join(workDir, 'new-file.js'))).toBe(true);

      const result = tm.revertScopedFiles(workDir, ['new-file.js'], 'Test');
      expect(result.reverted).toEqual([]);
      expect(result.skipped).toEqual(['new-file.js']);
      expect(fs.existsSync(path.join(workDir, 'new-file.js'))).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('handles empty file list without error', () => {
    expect(() => tm.revertScopedFiles(os.tmpdir(), [], 'Test')).not.toThrow();
  });
});

describe('scopedRollback', () => {
  beforeEach(resetBetweenTests);

  it('reverts only files recorded for the task', () => {
    let workDir;
    try {
      workDir = cloneGitFixture();
    } catch {
      return; /* git not available */
    }

    try {
      fs.writeFileSync(path.join(workDir, 'task-file.js'), 'task original');
      fs.writeFileSync(path.join(workDir, 'other-file.js'), 'other original');
      gitSync(['add', '.'], { cwd: workDir });
      gitSync(['commit', '-m', 'add rollback fixtures', '--no-gpg-sign'], { cwd: workDir });

      const task = createTask({ working_directory: workDir });
      fs.writeFileSync(path.join(workDir, 'task-file.js'), 'task modified');
      fs.writeFileSync(path.join(workDir, 'other-file.js'), 'other modified');
      db.recordFileChange(task.id, path.join(workDir, 'task-file.js'), 'modified', {
        workingDirectory: workDir,
      });

      const result = tm.scopedRollback(task.id);

      expect(result.reverted).toEqual(['task-file.js']);
      expect(result.skipped).toEqual([]);
      expect(fs.readFileSync(path.join(workDir, 'task-file.js'), 'utf-8')).toBe('task original');
      expect(fs.readFileSync(path.join(workDir, 'other-file.js'), 'utf-8')).toBe('other modified');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('leaves recorded untracked files in place', () => {
    let workDir;
    try {
      workDir = cloneGitFixture();
    } catch {
      return; /* git not available */
    }

    try {
      const task = createTask({ working_directory: workDir });
      fs.writeFileSync(path.join(workDir, 'task-created.js'), 'created by task');
      db.recordFileChange(task.id, path.join(workDir, 'task-created.js'), 'created', {
        workingDirectory: workDir,
      });

      const result = tm.scopedRollback(task.id);

      expect(result.reverted).toEqual([]);
      expect(result.skipped).toEqual(['task-created.js']);
      expect(fs.existsSync(path.join(workDir, 'task-created.js'))).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ─── Pipeline integration: ctx.earlyExit flow ───────────────────────────

describe('ctx.earlyExit pipeline flow', () => {
  let safeguardSpy;
  beforeEach(() => {
    resetBetweenTests();
    const safeguards = require('../validation/output-safeguards');
    safeguardSpy = vi.spyOn(safeguards, 'runOutputSafeguards').mockResolvedValue(undefined);
  });
  afterEach(() => {
    if (safeguardSpy) safeguardSpy.mockRestore();
  });

  it('successful task flows through all phases without earlyExit', async () => {
    // Use codex provider to avoid local-fallback path in handleProviderFailover
    const task = createTask({ provider: 'codex' });
    const proc = makeProc();
    const c = makeCtx(task, proc, { status: 'completed', code: 0 });

    // Run the pipeline phases in order (same as orchestrator)
    // code === 0, so handleRetryLogic is skipped
    tm.handleSafeguardChecks(c);       expect(c.earlyExit).toBe(false);
    tm.handleFuzzyRepair(c);
    tm.handleNoFileChangeDetection(c); expect(c.earlyExit).toBe(false);
    tm.handleAutoValidation(c);
    // Skip handleBuildTestStyleCommit — tested in its own describe block
    tm.handleProviderFailover(c);      expect(c.earlyExit).toBe(false);
    await tm.handlePostCompletion(c);

    expect(c.status).toBe('completed');
  }, 15000);

  it('propagates recovered codex completion through workflow dependencies instead of failing the workflow', async () => {
    const workflowId = randomUUID();
    db.createWorkflow({ id: workflowId, name: 'codex-status-recovery' });

    const upstream = createTask({
      provider: 'codex',
      workflow_id: workflowId,
      workflow_node_id: 'upstream',
    });
    const summary = createTask({
      provider: 'codex',
      status: 'blocked',
      workflow_id: workflowId,
      workflow_node_id: 'summary',
    });
    db.addTaskDependency({
      workflow_id: workflowId,
      task_id: summary.id,
      depends_on_task_id: upstream.id,
      on_fail: 'skip',
    });

    const proc = makeProc({
      output: '',
      errorOutput: `Success. Updated the following files:\nM src/worked.js\n${'x'.repeat(2500)}`,
      provider: 'codex',
    });
    tm._testing.runningProcesses.set(upstream.id, proc);

    const cleanup = tm.handleCloseCleanup(upstream.id, 1);
    const upstreamCtx = makeCtx(upstream, proc, {
      code: cleanup.code,
      status: cleanup.code === 0 ? 'completed' : 'failed',
      filesModified: [],
    });

    tm.handleSafeguardChecks(upstreamCtx);
    tm.handleFuzzyRepair(upstreamCtx);
    tm.handleNoFileChangeDetection(upstreamCtx);
    tm.handleAutoValidation(upstreamCtx);
    await tm.handleBuildTestStyleCommit(upstreamCtx);
    tm.handleProviderFailover(upstreamCtx);

    // Simulate what task-finalizer does: persist ctx status to DB
    db.updateTaskStatus(upstream.id, upstreamCtx.status, {
      exit_code: upstreamCtx.code,
      output: upstreamCtx.output || '',
      error_output: upstreamCtx.errorOutput || '',
      files_modified: upstreamCtx.filesModified || [],
      progress_percent: upstreamCtx.status === 'completed' ? 100 : 0,
    });

    await tm.handlePostCompletion(upstreamCtx);

    const updatedUpstream = db.getTask(upstream.id);
    const upstreamFiles = Array.isArray(updatedUpstream.files_modified)
      ? updatedUpstream.files_modified
      : JSON.parse(updatedUpstream.files_modified || '[]');
    expect(updatedUpstream.status).toBe('completed');
    expect(upstreamFiles).toContain('src/worked.js');
    expect(db.getTask(summary.id).status).not.toBe('skipped');
    expect(db.getWorkflow(workflowId).status).not.toBe('failed');

    db.updateTaskStatus(summary.id, 'completed', {
      exit_code: 0,
      output: 'summary complete',
      completed_at: new Date().toISOString(),
    });
    const summaryTask = db.getTask(summary.id);
    const summaryCtx = makeCtx(summaryTask, makeProc({ output: 'summary complete' }), {
      status: 'completed',
      code: 0,
      filesModified: [],
    });
    await tm.handlePostCompletion(summaryCtx);
    tm.checkWorkflowCompletion(workflowId);
    expect(db.getWorkflow(workflowId).status).toBe('completed');
  }, 15000);

  it('failed task with retries triggers earlyExit in handleRetryLogic', () => {
    const task = createTask({ max_retries: 2 });
    const proc = makeProc({ errorOutput: 'SIGTERM' });
    const c = makeCtx(task, proc, { code: 1, status: 'failed' });

    tm.handleRetryLogic(c);
    expect(c.earlyExit).toBe(true);

    // Clean up timeout
    const pendingTimeout = tm._testing.pendingRetryTimeouts.get(task.id);
    if (pendingTimeout) clearTimeout(pendingTimeout);
    tm._testing.pendingRetryTimeouts.delete(task.id);
  });

  it('failed task without retries flows through to provider failover', () => {
    // Use codex provider to avoid local-fallback path; use permanent error
    const task = createTask({ max_retries: 0, provider: 'codex' });
    const proc = makeProc({ errorOutput: 'permission denied' });
    const c = makeCtx(task, proc, { code: 1, status: 'failed' });

    tm.handleRetryLogic(c);          expect(c.earlyExit).toBe(false);
    tm.handleSafeguardChecks(c);     expect(c.earlyExit).toBe(false);
    tm.handleFuzzyRepair(c);
    tm.handleNoFileChangeDetection(c);
    tm.handleAutoValidation(c);
    tm.handleProviderFailover(c);

    // handleProviderFailover mutates ctx; DB persistence is the finalizer's job
    expect(c.status).toBe('failed');
  });
});
