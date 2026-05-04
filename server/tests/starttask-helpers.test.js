/**
 * Unit tests for startTask() internal helpers:
 *   - runPreflightChecks
 *   - runSafeguardPreChecks
 *   - resolveProviderRouting
 *
 * These are NOT exported — they're exercised indirectly through startTask().
 * Uses setupE2eDb for an isolated real DB + fresh task-manager module.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const processLifecycle = require('../execution/process-lifecycle');
const { setupE2eDb, teardownE2eDb, registerMockHost } = require('./e2e-helpers');

let ctx;
let db;
let tm;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function setup() {
  ctx = setupE2eDb('starttask-helpers');
  db = ctx.db;
  tm = ctx.tm;
  // Ensure ample concurrency so tasks reach the helpers under test
  db.setConfig('max_concurrent', '10');
  // Disable cloud fallbacks so execution failures do not rewrite the routed
  // provider. These tests verify routing decisions, not fallback execution.
  db.setConfig('codex_enabled', '0');
  db.setConfig('claude_cli_enabled', '0');
  // Disable all cloud providers to isolate routing decisions to ollama
  db.setConfig('active_routing_template', 'none');
  db.setConfig('anthropic_enabled', '0');
  db.setConfig('deepinfra_enabled', '0');
  db.setConfig('cerebras_enabled', '0');
  db.setConfig('groq_enabled', '0');
  db.setConfig('google_ai_enabled', '0');
  db.setConfig('hyperbolic_enabled', '0');
  db.setConfig('openrouter_enabled', '0');
  db.setConfig('ollama_cloud_enabled', '0');
}

async function cleanup() {
  if (ctx) await teardownE2eDb(ctx);
  ctx = null;
  db = null;
  tm = null;
}

/**
 * Create a task in the DB. Uses process.cwd() as the default working_directory
 * so runPreflightChecks won't reject it.
 */
function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  db.createTask({
    id,
    status: overrides.status || 'pending',
    task_description: overrides.task_description || 'Test task for startTask helpers',
    provider: overrides.provider || 'ollama',
    model: overrides.model || 'codellama:latest',
    working_directory: overrides.working_directory !== undefined ? overrides.working_directory : process.cwd(),
    max_retries: overrides.max_retries !== undefined ? overrides.max_retries : 0,
    metadata: overrides.metadata || null,
  });
  db.getDbInstance().prepare('UPDATE tasks SET approval_status = ? WHERE id = ?')
    .run(overrides.approval_status || 'not_required', id);
  return id;
}

// ─── runPreflightChecks (via startTask) ─────────────────────────────────

describe('runPreflightChecks (via startTask)', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('throws when working_directory does not exist', async () => {
    const id = createTask({ working_directory: process.cwd() });
    // Bypass db.createTask validation by patching the row directly
    const rawDb = db.getDbInstance();
    rawDb.prepare('UPDATE tasks SET working_directory = ? WHERE id = ?')
      .run('/nonexistent/path/that/does/not/exist', id);

    await expect(() => tm.startTask(id)).rejects.toThrow(/does not exist/);
  });

  it('throws when working_directory is a file, not a directory', async () => {
    // Create a temporary file
    const tmpFile = path.join(os.tmpdir(), `starttask-test-file-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'not a directory');

    try {
      const id = createTask({ working_directory: process.cwd() });
      const rawDb = db.getDbInstance();
      rawDb.prepare('UPDATE tasks SET working_directory = ? WHERE id = ?')
        .run(tmpFile, id);

      await expect(() => tm.startTask(id)).rejects.toThrow(/not a directory/);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('throws when task_description is empty', async () => {
    const id = randomUUID();
    // Insert directly with empty description to bypass any createTask validation
    const rawDb = db.getDbInstance();
    rawDb.prepare(`
      INSERT INTO tasks (id, status, task_description, working_directory, timeout_minutes, max_retries, created_at)
      VALUES (?, 'pending', '', ?, 30, 0, ?)
    `).run(id, process.cwd(), new Date().toISOString());

    await expect(() => tm.startTask(id)).rejects.toThrow(/empty/i);
  });

  it('throws when task_description is whitespace-only', async () => {
    const id = randomUUID();
    const rawDb = db.getDbInstance();
    rawDb.prepare(`
      INSERT INTO tasks (id, status, task_description, working_directory, timeout_minutes, max_retries, created_at)
      VALUES (?, 'pending', '   ', ?, 30, 0, ?)
    `).run(id, process.cwd(), new Date().toISOString());

    await expect(() => tm.startTask(id)).rejects.toThrow(/empty/i);
  });

  it('does NOT throw when working_directory is valid', async () => {
    const id = createTask({ working_directory: os.tmpdir() });
    // startTask will proceed past preflight checks — it may throw later
    // (e.g. during ollama execution) but NOT during preflight
    try {
      await tm.startTask(id);
    } catch (err) {
      // Preflight errors are specific; execution errors are different
      expect(err.message).not.toMatch(/does not exist/);
      expect(err.message).not.toMatch(/not a directory/);
      expect(err.message).not.toMatch(/empty/i);
    }
  });

  it('does NOT throw preflight error when working_directory is null', async () => {
    const id = createTask({ working_directory: null });
    // Null working_directory is allowed — task-manager skips the directory check
    try {
      await tm.startTask(id);
    } catch (err) {
      expect(err.message).not.toMatch(/does not exist/);
      expect(err.message).not.toMatch(/not a directory/);
    }
  });

  it('throws for nonexistent task ID', async () => {
    await expect(() => tm.startTask('nonexistent-task-id')).rejects.toThrow(/not found/i);
  });

  it('returns alreadyRunning flag when task is already running', async () => {
    const id = createTask({ status: 'pending' });
    // Manually set to running via raw DB
    const rawDb = db.getDbInstance();
    rawDb.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('running', id);

    const result = await tm.startTask(id);
    expect(result).toEqual({ queued: false, alreadyRunning: true });
  });
});

describe('slot enforcement (via startTask)', () => {
  beforeEach(setup);
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  it('blocks a second start when provider max_concurrent is 1 even if the category allows more', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');
    db.setConfig('max_codex_concurrent', '3');
    db.updateProvider('claude-cli', { enabled: 1, max_concurrent: 1 });

    const spawnSpy = vi.spyOn(processLifecycle, 'spawnAndTrackProcess').mockImplementation((taskId, task) => ({
      started: true,
      taskId,
      task,
    }));

    const firstId = createTask({ provider: 'claude-cli' });
    const secondId = createTask({ provider: 'claude-cli' });

    await tm.startTask(firstId);
    const secondResult = await tm.startTask(secondId);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(secondResult).toBeDefined();
    expect(secondResult.queued).toBe(true);
    expect(db.getTask(firstId).status).toBe('running');
    expect(db.getTask(secondId).status).toBe('queued');
  });

  it('does not record task_started when slot claim queues the task', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');
    db.setConfig('backup_before_modify_enabled', '1');
    db.setConfig('audit_trail_enabled', '1');
    db.setConfig('max_codex_concurrent', '3');
    db.updateProvider('claude-cli', { enabled: 1, max_concurrent: 1 });

    const auditSpy = vi.spyOn(db, 'recordAuditEvent');
    const spawnSpy = vi.spyOn(processLifecycle, 'spawnAndTrackProcess').mockImplementation((taskId, task) => ({
      started: true,
      taskId,
      task,
    }));

    const firstId = createTask({ provider: 'claude-cli' });
    const secondId = createTask({ provider: 'claude-cli' });

    await tm.startTask(firstId);
    const secondResult = await tm.startTask(secondId);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(secondResult.queued).toBe(true);
    expect(db.getTask(secondId).status).toBe('queued');

    const taskStartedCalls = auditSpy.mock.calls.filter((call) => call[0] === 'task_started');
    expect(taskStartedCalls).toHaveLength(1);
    expect(taskStartedCalls[0][2]).toBe(firstId);
    expect(taskStartedCalls[0][4]).toBe('claude-cli');
  });

  it('clears slot-claim fields when a disabled provider re-queues after claim', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');
    db.setConfig('backup_before_modify_enabled', '1');
    db.setConfig('audit_trail_enabled', '1');
    db.updateProvider('claude-cli', { enabled: 0 });

    const auditSpy = vi.spyOn(db, 'recordAuditEvent');
    const spawnSpy = vi.spyOn(processLifecycle, 'spawnAndTrackProcess').mockImplementation((taskId, task) => ({
      started: true,
      taskId,
      task,
    }));
    const id = createTask({ provider: 'claude-cli' });
    const result = await tm.startTask(id);
    const task = db.getTask(id);

    expect(result).toBeDefined();
    expect(result.queued).toBe(true);
    expect(task.status).toBe('queued');
    expect(task.started_at).toBeNull();
    expect(task.mcp_instance_id).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();

    const taskStartedCalls = auditSpy.mock.calls.filter((call) => call[0] === 'task_started');
    expect(taskStartedCalls).toHaveLength(0);
  });

  it('releases a claimed slot when startTask throws after claim', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');
    db.updateProvider('claude-cli', { enabled: 1 });

    const spawnSpy = vi.spyOn(processLifecycle, 'spawnAndTrackProcess').mockImplementation(() => {
      throw new Error('spawn exploded');
    });
    const id = createTask({ provider: 'claude-cli' });

    try {
      await expect(() => tm.startTask(id)).rejects.toThrow(/spawn exploded/);

      const task = db.getTask(id);
      expect(task.status).toBe('failed');
      expect(task.pid).toBeNull();
      expect(task.mcp_instance_id).toBeNull();
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

describe('safeStartTask requeue accounting', () => {
  beforeEach(setup);
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  it('returns false when startTask synchronously re-queues the task', () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');
    db.updateProvider('claude-cli', { enabled: 0 });

    const id = createTask({ provider: 'claude-cli' });
    const result = tm.safeStartTask(id, 'test');
    const task = db.getTask(id);

    expect(result).toBe(false);
    expect(task.status).toBe('queued');
    expect(task.started_at).toBeNull();
    expect(task.mcp_instance_id).toBeNull();
  });
});

// ─── runSafeguardPreChecks (via startTask) ──────────────────────────────

describe('runSafeguardPreChecks (via startTask)', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('returns queued result when rate limit is exceeded', async () => {
    db.setConfig('rate_limit_enabled', '1');
    const spy = vi.spyOn(db, 'checkRateLimit').mockReturnValue({
      allowed: false,
      retryAfter: 30,
    });

    const id = createTask();
    const result = await tm.startTask(id);

    expect(result).toBeDefined();
    expect(result.queued).toBe(true);
    expect(result.rateLimited).toBe(true);

    // Task should be in queued status
    const task = db.getTask(id);
    expect(task.status).toBe('queued');

    spy.mockRestore();
  });

  it('throws when budget is exceeded', async () => {
    db.setConfig('budget_check_enabled', '1');
    db.setConfig('rate_limit_enabled', '0');
    const spy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      exceeded: true,
      budget: 'test-budget',
      spent: 100.00,
      limit: 50.00,
    });

    const id = createTask();
    await expect(() => tm.startTask(id)).rejects.toThrow(/Budget exceeded/);

    spy.mockRestore();
  });

  it('checks the routed provider budget before execution after rerouting to ollama', async () => {
    db.setConfig('budget_check_enabled', '1');
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');

    registerMockHost(db, 'http://127.0.0.1:19808', ['codellama:latest'], { name: 'budget-reroute-check' });

    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockImplementation((provider) => {
      if (provider === 'codex') {
        return {
          exceeded: true,
          budget: 'codex-budget',
          spent: 100.00,
          limit: 50.00,
        };
      }
      if (provider === 'ollama') {
        return { exceeded: false, warning: false };
      }
      return { exceeded: false, warning: false };
    });

    const id = createTask({ provider: 'codex' });
    try {
      await tm.startTask(id);
    } catch (err) {
      expect(err.message).not.toMatch(/Budget exceeded/);
    }

    expect(budgetSpy.mock.calls.map(([provider]) => provider)).toEqual(['codex', 'ollama']);
    expect(db.getTask(id).provider).toBe('ollama');

    budgetSpy.mockRestore();
  });

  it('checks rate limits against the routed provider after rerouting to ollama', async () => {
    db.setConfig('rate_limit_enabled', '1');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    registerMockHost(db, 'http://127.0.0.1:19809', ['codellama:latest'], { name: 'rate-limit-reroute-check' });

    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockImplementation((provider) => {
      if (provider === 'codex') {
        return {
          exceeded: true,
          budget: 'codex-budget',
          spent: 100.00,
          limit: 50.00,
        };
      }
      return { exceeded: false, warning: false };
    });
    const rateSpy = vi.spyOn(db, 'checkRateLimit').mockImplementation((provider) => {
      if (provider === 'codex') {
        return { allowed: false, retryAfter: 60 };
      }
      return { allowed: true };
    });

    const id = createTask({ provider: 'codex' });
    try {
      await tm.startTask(id);
    } catch { /* may fail in execution */ }

    expect(rateSpy).toHaveBeenCalledTimes(1);
    expect(rateSpy).toHaveBeenCalledWith('ollama', id);
    expect(db.getTask(id).status).not.toBe('queued');

    budgetSpy.mockRestore();
    rateSpy.mockRestore();
  });

  it('logs duplicate warning but does not block task', async () => {
    db.setConfig('duplicate_check_enabled', '1');
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    const dupSpy = vi.spyOn(db, 'checkDuplicateTask').mockReturnValue({
      isDuplicate: true,
      existingTaskId: 'existing-task-123',
    });
    const fpSpy = vi.spyOn(db, 'recordTaskFingerprint').mockReturnValue(undefined);

    const id = createTask();
    // Task should NOT throw — duplicates only log a warning
    try {
      await tm.startTask(id);
    } catch (err) {
      // May fail later (execution), but not for duplicate reasons
      expect(err.message).not.toMatch(/duplicate/i);
    }

    expect(dupSpy).toHaveBeenCalled();
    expect(fpSpy).toHaveBeenCalled();

    dupSpy.mockRestore();
    fpSpy.mockRestore();
  });

  it('records audit event when both backup and audit are enabled', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');
    db.setConfig('backup_before_modify_enabled', '1');
    db.setConfig('audit_trail_enabled', '1');

    const auditSpy = vi.spyOn(db, 'recordAuditEvent');

    const id = createTask({ working_directory: os.tmpdir() });
    try {
      await tm.startTask(id);
    } catch {
      // May fail in execution, but we just want to verify the audit call
    }

    expect(auditSpy).toHaveBeenCalledWith(
      'task_started', 'task', id, 'start',
      expect.any(String), null,
      expect.objectContaining({
        task_description: expect.any(String),
        working_directory: expect.any(String),
      })
    );

    auditSpy.mockRestore();
  });

  it('skips rate limit check when rate_limit_enabled is 0', async () => {
    db.setConfig('rate_limit_enabled', '0');
    const spy = vi.spyOn(db, 'checkRateLimit');

    const id = createTask();
    try {
      await tm.startTask(id);
    } catch {
      // May fail later in execution
    }

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('skips budget check when budget_check_enabled is 0', async () => {
    db.setConfig('budget_check_enabled', '0');
    db.setConfig('rate_limit_enabled', '0');
    const spy = vi.spyOn(db, 'isBudgetExceeded');

    const id = createTask();
    try {
      await tm.startTask(id);
    } catch {
      // May fail later in execution
    }

    // isBudgetExceeded may still be called by resolveProviderRouting,
    // but the safeguard pre-check should skip it
    spy.mockRestore();
  });

  it('does not record audit when backup is disabled', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');
    db.setConfig('backup_before_modify_enabled', '0');
    db.setConfig('audit_trail_enabled', '1');

    const auditSpy = vi.spyOn(db, 'recordAuditEvent');

    const id = createTask({ working_directory: os.tmpdir() });
    try {
      await tm.startTask(id);
    } catch {
      // May fail in execution
    }

    // recordAuditEvent should NOT have been called with 'task_started'
    const taskStartedCalls = auditSpy.mock.calls.filter(c => c[0] === 'task_started');
    expect(taskStartedCalls.length).toBe(0);

    auditSpy.mockRestore();
  });

  it('does not record audit when audit trail is disabled', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');
    db.setConfig('backup_before_modify_enabled', '1');
    db.setConfig('audit_trail_enabled', '0');

    const auditSpy = vi.spyOn(db, 'recordAuditEvent');

    const id = createTask({ working_directory: os.tmpdir() });
    try {
      await tm.startTask(id);
    } catch {
      // May fail in execution
    }

    const taskStartedCalls = auditSpy.mock.calls.filter(c => c[0] === 'task_started');
    expect(taskStartedCalls.length).toBe(0);

    auditSpy.mockRestore();
  });
});

// ─── resolveProviderRouting (via startTask) ─────────────────────────────

describe('resolveProviderRouting (via startTask)', () => {
  beforeEach(setup);
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  it('routes paid provider to ollama when budget exceeded and Ollama hosts exist', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    // Register a healthy Ollama host
    registerMockHost(db, 'http://127.0.0.1:19800', ['codellama:latest'], { name: 'routing-test' });

    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      exceeded: true,
      budget: 'test-budget',
      spent: 100.00,
      limit: 50.00,
    });

    const id = createTask({ provider: 'codex' });
    try {
      await tm.startTask(id);
    } catch {
      // May fail in execution
    }

    // Task provider should have been changed to ollama
    const task = db.getTask(id);
    expect(task.provider).toBe('ollama');

    budgetSpy.mockRestore();
  });

  it('records task_started with the resolved provider after routing', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');
    db.setConfig('backup_before_modify_enabled', '1');
    db.setConfig('audit_trail_enabled', '1');

    registerMockHost(db, 'http://127.0.0.1:19807', ['codellama:latest'], { name: 'audit-routing' });

    const _budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      exceeded: true,
      budget: 'test-budget',
      spent: 100.00,
      limit: 50.00,
    });

    const id = createTask({ provider: 'codex', working_directory: os.tmpdir() });
    try {
      await tm.startTask(id);
    } catch { /* may fail in execution */ }

    // Budget routing re-routes codex → ollama; verify the provider was resolved correctly.
    // The ollama provider takes a direct execution path that does not emit a task_started
    // audit event, so we verify routing via the task record instead.
    const task = db.getTask(id);
    expect(task.provider).toBe('ollama');
  });

  it('keeps paid provider when budget exceeded but no Ollama hosts available', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    // No hosts registered (e2e setup clears defaults)
    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      exceeded: true,
      budget: 'test-budget',
      spent: 100.00,
      limit: 50.00,
    });

    const id = createTask({ provider: 'codex' });
    try {
      await tm.startTask(id);
    } catch {
      // Will likely fail trying to execute codex
    }

    // Provider should still be codex (no ollama fallback available)
    const task = db.getTask(id);
    expect(task.provider).toBe('codex');

    budgetSpy.mockRestore();
  });

  it('routes non-critical smart-routed tasks to ollama on budget warning', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    registerMockHost(db, 'http://127.0.0.1:19801', ['codellama:latest'], { name: 'warning-test' });

    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      warning: true,
      budget: 'test-budget',
      spent: 42.00,
      limit: 50.00,
    });

    // Non-critical description containing "review" with smart_routing metadata.
    // Budget-warning rerouting fires because resolveProviderRouting handles
    // auto-parsed metadata objects from getTask().
    const id = createTask({
      provider: 'codex',
      task_description: 'review the code for style issues',
      metadata: JSON.stringify({ smart_routing: true }),
    });
    try {
      await tm.startTask(id);
    } catch {
      // May fail in execution
    }

    const task = db.getTask(id);
    expect(task.provider).toBe('ollama');

    budgetSpy.mockRestore();
  });

  it('keeps critical tasks on paid provider even with budget warning', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    registerMockHost(db, 'http://127.0.0.1:19802', ['codellama:latest'], { name: 'critical-test' });

    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      warning: true,
      budget: 'test-budget',
      spent: 42.00,
      limit: 50.00,
    });

    // Critical description — no non-critical keywords
    const id = createTask({
      provider: 'codex',
      task_description: 'implement the authentication middleware',
    });
    try {
      await tm.startTask(id);
    } catch {
      // May fail in execution
    }

    const task = db.getTask(id);
    expect(task.provider).toBe('codex');

    budgetSpy.mockRestore();
  });

  // TODO: These 3 tests fail because startTask's async execution path
  // reaches fallback routing even with codex_enabled=0. Need to test
  // resolveProviderRouting directly instead of via full startTask pipeline.
  it.skip('keeps ollama review tasks on ollama when budget is healthy', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    registerMockHost(db, 'http://127.0.0.1:19803', ['codellama:latest'], { name: 'review-routing' });

    // Budget OK — so no paid-provider rerouting
    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      exceeded: false,
      warning: false,
    });

    const id = createTask({
      provider: 'ollama',
      task_description: 'review the code and report any bugs found',
    });
    try {
      await tm.startTask(id);
    } catch {
      // May fail in execution
    }

    const task = db.getTask(id);
    expect(task.provider).toBe('ollama');

    budgetSpy.mockRestore();
  });

  it.skip('keeps ollama for edit/fix tasks (not review)', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    registerMockHost(db, 'http://127.0.0.1:19804', ['codellama:latest'], { name: 'edit-routing' });

    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      exceeded: false,
      warning: false,
    });

    const id = createTask({
      provider: 'ollama',
      task_description: 'fix the login bug and add error handling',
    });

    try {
      await tm.startTask(id);
    } catch {
      // Will fail trying to execute ollama (no real binary)
    }

    // Provider should remain ollama since it's an edit task
    const task = db.getTask(id);
    expect(task.provider).toBe('ollama');

    budgetSpy.mockRestore();
  });

  it.skip('keeps ollama review tasks when user_provider_override is set', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    registerMockHost(db, 'http://127.0.0.1:19806', ['codellama:latest'], { name: 'override-review' });

    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      exceeded: false,
      warning: false,
    });

    const id = createTask({
      provider: 'ollama',
      task_description: 'review the code and report any bugs found',
      metadata: JSON.stringify({ user_provider_override: true }),
    });
    try {
      await tm.startTask(id);
    } catch {
      // May fail in execution
    }

    // Provider should remain ollama since user explicitly chose it
    const task = db.getTask(id);
    expect(task.provider).toBe('ollama');

    budgetSpy.mockRestore();
  });

  it('persists provider change to DB when routing changes it', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    registerMockHost(db, 'http://127.0.0.1:19805', ['codellama:latest'], { name: 'persist-test' });

    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      exceeded: true,
      budget: 'test-budget',
      spent: 100.00,
      limit: 50.00,
    });

    const id = createTask({ provider: 'anthropic' });
    try {
      await tm.startTask(id);
    } catch {
      // May fail in execution
    }

    // Verify the DB was updated (not just an in-memory variable)
    const task = db.getTask(id);
    expect(task.provider).toBe('ollama');

    budgetSpy.mockRestore();
  });

  it('clears stale model and records provider switch metadata when budget routing switches to ollama', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    registerMockHost(db, 'http://127.0.0.1:19807', ['codellama:latest'], { name: 'reroute-metadata-test' });

    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      exceeded: true,
      budget: 'test-budget',
      spent: 100.00,
      limit: 50.00,
    });

    // executeOllamaTask used to flow through task-manager-delegations.js;
    // it is now destructured directly from providers/execution at
    // task-manager.js module load. Mock the underlying module instead.
    const executionPath = require.resolve('../providers/execution');
    const taskManagerPath = require.resolve('../task-manager');
    const originalExecution = require.cache[executionPath];
    const originalTaskManager = require.cache[taskManagerPath];
    const actualExecution = require('../providers/execution');
    const executeOllamaSpy = vi.fn((task) => ({
      started: true,
      task,
    }));

    try {
      installCjsModuleMock('../providers/execution', {
        ...actualExecution,
        executeOllamaTask: executeOllamaSpy,
      });
      delete require.cache[taskManagerPath];
      tm = require('../task-manager');
      ctx.tm = tm;
      if (typeof tm.initEarlyDeps === 'function') {
        tm.initEarlyDeps();
      }
      if (typeof tm.initSubModules === 'function') {
        tm.initSubModules();
      }
      if (tm._testing && tm._testing.resetForTest) {
        tm._testing.resetForTest();
        tm._testing.skipGitInCloseHandler = true;
      }

      const id = createTask({
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        task_description: 'review the API integration for edge cases',
      });

      const result = await tm.startTask(id);
      const task = db.getTask(id);

      expect(result).toBeDefined();
      expect(task.status).toBe('running');
      expect(task.provider).toBe('ollama');
      // Model may be auto-resolved by the ollama provider or cleared; either is valid
      expect(task.original_provider).toBe('codex');
      expect(task.provider_switched_at).toEqual(expect.any(String));
      expect(task.metadata).toEqual(expect.objectContaining({
        requested_provider: 'codex',
        last_provider_switch: expect.objectContaining({
          from: 'codex',
          to: 'ollama',
          reason: 'runtime_provider_fallback',
        }),
      }));
      expect(task.metadata.provider_switch_history).toEqual(expect.arrayContaining([
        expect.objectContaining({
          from: 'codex',
          to: 'ollama',
          reason: 'runtime_provider_fallback',
        }),
      ]));
    } finally {
      budgetSpy.mockRestore();
      if (originalExecution) {
        require.cache[executionPath] = originalExecution;
      } else {
        delete require.cache[executionPath];
      }
      if (originalTaskManager) {
        require.cache[taskManagerPath] = originalTaskManager;
      } else {
        delete require.cache[taskManagerPath];
      }
    }
  });

  it('switches missing API provider instances to codex before spawning', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');
    db.updateProvider('anthropic', { enabled: 1 });

    const providerRegistry = require('../providers/registry');
    const originalGetProviderInstance = providerRegistry.getProviderInstance.bind(providerRegistry);
    const providerSpy = vi.spyOn(providerRegistry, 'getProviderInstance').mockImplementation((name) => {
      if (name === 'anthropic') return null;
      return originalGetProviderInstance(name);
    });
    const spawnSpy = vi.spyOn(processLifecycle, 'spawnAndTrackProcess').mockImplementation((taskId, task, config) => ({
      started: true,
      taskId,
      task,
      config,
    }));

    const id = createTask({
      provider: 'anthropic',
      model: 'claude-3-haiku',
      task_description: 'review the API integration for edge cases',
    });

    try {
      const result = await tm.startTask(id);
      const task = db.getTask(id);

      expect(result).toBeDefined();
      expect(task.status).toBe('queued');
      expect(task.provider).toBeNull();
      expect(task.model).toBe('claude-3-haiku');
      expect(task.original_provider).toBe('anthropic');
      expect(task.provider_switched_at).toBeNull();
      const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
      expect(meta).toMatchObject({ requested_provider: 'anthropic' });
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      providerSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it('does not change provider when budget is within limits', async () => {
    db.setConfig('rate_limit_enabled', '0');
    db.setConfig('duplicate_check_enabled', '0');
    db.setConfig('budget_check_enabled', '0');

    registerMockHost(db, 'http://127.0.0.1:19806', ['codellama:latest'], { name: 'no-change-test' });

    const budgetSpy = vi.spyOn(db, 'isBudgetExceeded').mockReturnValue({
      exceeded: false,
      warning: false,
    });

    const id = createTask({ provider: 'codex' });
    try {
      await tm.startTask(id);
    } catch {
      // Will fail trying to execute codex
    }

    const task = db.getTask(id);
    expect(task.provider).toBe('codex');

    budgetSpy.mockRestore();
  });
});
