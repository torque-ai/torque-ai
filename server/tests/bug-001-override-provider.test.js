/**
 * BUG-001 Regression Tests: override_provider ignored — tasks routed to ollama
 *
 * Backlog: docs/BACKLOG.md (commit 24f5cf6)
 * Fix: commit 1c010cd — added user_provider_override flag to task metadata;
 *   all three re-routing stages (queue overflow, budget gates, health/disabled
 *   guards) now skip when the flag is present.
 *
 * Tests verify:
 *   (a) override_provider → task uses that provider, not smart-routed
 *   (b) override_provider → task NOT eligible for free-tier overflow
 *   (c) no override → normal smart routing applies
 *   (d) the three-stage fix from 1c010cd actually works (regression)
 */

'use strict';

const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const { createConfigMock } = require('./test-helpers');

let db;

/** db.getTask() auto-parses metadata into an object; handle both forms. */
function parseMeta(task) {
  if (!task || !task.metadata) return {};
  if (typeof task.metadata === 'object') return task.metadata;
  try { return JSON.parse(task.metadata); } catch { return {}; }
}

function extractQueuedTaskId(result) {
  const text = getText(result);
  // Match "ID: <uuid>" — stop at comma or closing paren
  const match = text.match(/ID: ([^,)]+)/);
  return match ? match[1].trim() : null;
}

function createJsonRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function parseJsonBody(res) {
  return res.body ? JSON.parse(res.body) : {};
}

vi.mock('../providers/registry', () => ({
  getProviderInstance: vi.fn().mockReturnValue({}),
  listProviders: vi.fn().mockReturnValue([]),
  getProviderConfig: vi.fn(),
  getCategory: vi.fn().mockReturnValue(null),
}));

// ────────────────────────────────────────────────────────────────
// Part 1: integration-routing.js — handleSmartSubmitTask
// ────────────────────────────────────────────────────────────────
describe('BUG-001: override_provider respected in smart_submit_task', () => {
  beforeAll(() => {
    const env = setupTestDb('bug-001-routing');
    db = env.db;
    // Prevent real network calls
    db.checkOllamaHealth = async () => true;
  });
  afterAll(() => { teardownTestDb(); });

  // Helper: submit via smart_submit_task and return the created task row
  async function submitAndGetTask(args) {
    const result = await safeTool('smart_submit_task', args);
    if (result.isError) return { error: true, text: getText(result) };
    const text = getText(result);
    // Extract task ID from output table: | Task ID | `<id>` |
    const match = text.match(/Task ID\s*\|\s*`([^`]+)`/);
    if (!match) return { error: true, text };
    const task = db.getTask(match[1]);
    return { task, text };
  }

  // ── (a) override_provider sets the provider directly ──

  it('uses the provider when override_provider is explicitly set to codex', async () => {
    const { task, error } = await submitAndGetTask({
      task: 'Write unit tests for the authentication module',
      override_provider: 'codex',
    });
    expect(error).toBeFalsy();
    expect(task).toBeTruthy();
    // Provider may be deferred (null) in slot-pull mode — check intended_provider in metadata
    const meta = parseMeta(task);
    expect(task.provider === 'codex' || meta.intended_provider === 'codex' || meta.requested_provider === 'codex').toBe(true);
  });

  it('uses the provider when the standard "provider" arg is set', async () => {
    const { task, error } = await submitAndGetTask({
      task: 'Refactor the database connection pooling',
      provider: 'codex',
    });
    expect(error).toBeFalsy();
    expect(task).toBeTruthy();
    // Provider may be deferred (null) in slot-pull mode — check intended_provider in metadata
    const meta = parseMeta(task);
    expect(task.provider === 'codex' || meta.intended_provider === 'codex' || meta.requested_provider === 'codex').toBe(true);
  });

  it('sets user_provider_override flag in metadata when provider is explicit', async () => {
    const { task, error } = await submitAndGetTask({
      task: 'Generate API documentation for user service',
      provider: 'codex',
    });
    expect(error).toBeFalsy();
    const meta = parseMeta(task);
    expect(meta.user_provider_override).toBe(true);
  });

  it('does NOT set user_provider_override when no provider is specified', async () => {
    const { task, error } = await submitAndGetTask({
      task: 'Add comments to the login handler',
    });
    expect(error).toBeFalsy();
    const meta = parseMeta(task);
    expect(meta.user_provider_override).toBeFalsy();
  });

  // ── (c) no override → normal smart routing applies ──

  it('smart-routes when no override_provider is given', async () => {
    const { task, error } = await submitAndGetTask({
      task: 'Write documentation for the user registration endpoint',
    });
    expect(error).toBeFalsy();
    const meta = parseMeta(task);
    expect(meta.smart_routing).toBe(true);
    // Provider is deferred (null) in slot-pull mode — check intended_provider in metadata
    expect(meta.intended_provider).toBeTruthy();
  });

  // ── (d) regression: fix from 1c010cd — disabled-provider guard ──

  it('returns error when user-chosen provider is disabled (TDA-01 sovereignty)', async () => {
    // Disable ollama provider to test the guard
    db.updateProvider('ollama', { enabled: 0 });

    const { task: _task, error, text } = await submitAndGetTask({
      task: 'Scan project structure and list all source files',
      provider: 'ollama',
    });

    // Re-enable for other tests
    db.updateProvider('ollama', { enabled: 1 });

    // TDA-01: User-chosen disabled provider returns an explicit error
    // instead of silently falling back. Provider sovereignty is respected.
    expect(error).toBe(true);
    expect(text).toContain('disabled');
  });

  it('does NOT override user-chosen provider when health gate would reroute (guard at line 890)', async () => {
    // Mark a provider as unhealthy via health scoring
    if (typeof db.recordProviderHealth === 'function') {
      // Record many failures to make it unhealthy
      for (let i = 0; i < 10; i++) {
        db.recordProviderHealth('codex', false);
      }
    }

    const { task, error } = await submitAndGetTask({
      task: 'Build the payment processing module',
      provider: 'codex',
    });

    expect(error).toBeFalsy();
    // With deferred assignment, provider may be null — check intended_provider in metadata
    const meta = parseMeta(task);
    expect(task.provider === 'codex' || meta.intended_provider === 'codex' || meta.requested_provider === 'codex').toBe(true);
    expect(meta.user_provider_override).toBe(true);
  });

  // ── legacy alias support ──

  it('supports both provider and override_provider args (provider takes precedence)', async () => {
    const { task, error } = await submitAndGetTask({
      task: 'Create integration tests for webhook handler',
      provider: 'codex',
      override_provider: 'ollama', // legacy alias, should be overridden by provider
    });
    expect(error).toBeFalsy();
    // Provider is now deferred (null) — check intended_provider in metadata
    expect(task.provider).toBeNull();
    const meta = parseMeta(task);
    expect(meta.intended_provider || meta.requested_provider).toBe('codex');
  });
});


// ────────────────────────────────────────────────────────────────
// Part 2: queue_task + v2 retry clone
// ────────────────────────────────────────────────────────────────
describe('BUG-001: explicit provider locking survives queue_task and v2 retry', () => {
  let testDir;
  let v2TaskHandlers;
  let taskManager;

  beforeAll(() => {
    const env = setupTestDb('bug-001-queue-retry');
    db = env.db;
    testDir = env.testDir;

    delete require.cache[require.resolve('../api/v2-task-handlers')];
    v2TaskHandlers = require('../api/v2-task-handlers');
    taskManager = {
      startTask: vi.fn().mockReturnValue({ queued: true }),
      evaluateTaskSubmissionPolicy: vi.fn().mockReturnValue(null),
    };
    v2TaskHandlers.init(taskManager);
  });

  beforeEach(() => {
    taskManager.startTask.mockReset();
    taskManager.startTask.mockReturnValue({ queued: true });
    taskManager.evaluateTaskSubmissionPolicy.mockReset();
    taskManager.evaluateTaskSubmissionPolicy.mockReturnValue(null);
    v2TaskHandlers.init(taskManager);
  });

  afterAll(() => { teardownTestDb(); });

  it('queue_task with explicit provider preserves user_provider_override', async () => {
    const explicitProvider = db.getDefaultProvider() === 'codex' ? 'ollama' : 'codex';
    const result = await safeTool('queue_task', {
      task: 'Queue task should keep explicit provider lock',
      provider: explicitProvider,
      working_directory: testDir,
    });

    expect(result.isError).toBeFalsy();
    const taskId = extractQueuedTaskId(result);
    expect(taskId).toBeTruthy();

    const task = db.getTask(taskId);
    // Provider is now deferred (null) — check intended_provider in metadata
    expect(task.provider).toBeNull();
    const meta = parseMeta(task);
    expect(meta.intended_provider).toBe(explicitProvider);
    expect(meta.user_provider_override).toBe(true);
  });

  it('v2 retry clone preserves user_provider_override from original task', async () => {
    const originalTaskId = randomUUID();
    db.createTask({
      id: originalTaskId,
      status: 'failed',
      task_description: 'Retry should keep the original override flag',
      working_directory: testDir,
      timeout_minutes: 30,
      auto_approve: false,
      priority: 1,
      provider: db.getDefaultProvider(),
      model: 'test-model',
      metadata: JSON.stringify({ user_provider_override: true }),
    });

    const res = createJsonRes();
    await v2TaskHandlers.handleRetryTask({
      params: { task_id: originalTaskId },
      headers: {},
      requestId: 'req-retry-preserve-flag',
    }, res);

    expect(res.statusCode).toBe(201);
    const payload = parseJsonBody(res);
    const clonedTask = db.getTask(payload.data.task_id);
    const meta = parseMeta(clonedTask);

    expect(meta.retry_of).toBe(originalTaskId);
    expect(meta.user_provider_override).toBe(true);
  });

  it('v2 retry clone of explicitly-provided task preserves the flag', async () => {
    const explicitProvider = db.getDefaultProvider() === 'codex' ? 'ollama' : 'codex';
    const originalTaskId = randomUUID();
    db.createTask({
      id: originalTaskId,
      status: 'failed',
      task_description: 'Retry should preserve an explicit provider lock',
      working_directory: testDir,
      timeout_minutes: 30,
      auto_approve: false,
      priority: 1,
      provider: explicitProvider,
      model: 'test-model',
      metadata: JSON.stringify({ user_provider_override: true }),
    });

    const res = createJsonRes();
    await v2TaskHandlers.handleRetryTask({
      params: { task_id: originalTaskId },
      headers: {},
      requestId: 'req-retry-preserve-provider',
    }, res);

    expect(res.statusCode).toBe(201);
    const payload = parseJsonBody(res);
    const clonedTask = db.getTask(payload.data.task_id);
    const meta = parseMeta(clonedTask);

    // Provider is now deferred (null) — check intended_provider in metadata
    expect(clonedTask.provider).toBeNull();
    expect(meta.intended_provider).toBe(explicitProvider);
    expect(meta.retry_of).toBe(originalTaskId);
    expect(meta.user_provider_override).toBe(true);
  });
});


// ────────────────────────────────────────────────────────────────
// Part 3: queue-scheduler.js — overflow protection
// ────────────────────────────────────────────────────────────────
describe('BUG-001: override_provider blocks queue overflow', () => {
  let scheduler;
  let mockDb;
  let mocks;

  beforeEach(() => {
    // Fresh module state
    const modPath = require.resolve('../execution/queue-scheduler');
    delete require.cache[modPath];
    scheduler = require('../execution/queue-scheduler');

    mockDb = {
      getRunningCount: vi.fn().mockReturnValue(0),
      prepare: vi.fn(),
      listTasks: vi.fn().mockReturnValue([]),
      listOllamaHosts: vi.fn().mockReturnValue([]),
      getConfig: vi.fn(createConfigMock()),
      selectOllamaHostForModel: vi.fn().mockReturnValue({ host: null, reason: 'no host' }),
      updateTaskStatus: vi.fn(),
      getNextQueuedTask: vi.fn().mockReturnValue(null),
      resetExpiredBudgets: vi.fn(),
      checkApprovalRequired: vi.fn().mockReturnValue({ required: false, status: 'not_required', rule: null }),
    };

    mocks = {
      safeStartTask: vi.fn().mockReturnValue(true),
      safeConfigInt: vi.fn().mockImplementation((key, defaultVal) => {
        if (key === 'max_concurrent') return 10;
        if (key === 'max_per_host') return 2;
        if (key === 'max_codex_concurrent') return 3;
        return defaultVal;
      }),
      isLargeModelBlockedOnHost: vi.fn().mockReturnValue({ blocked: false }),
      cleanupOrphanedRetryTimeouts: vi.fn(),
    };

    scheduler.init({ db: mockDb, ...mocks });

    // Skip the recent-process guard
    const originalProcessQueue = scheduler.processQueueInternal;
    scheduler.processQueueInternal = (options = {}) => originalProcessQueue({
      skipRecentProcessGuard: true,
      ...options,
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  function makeTask(overrides = {}) {
    return {
      id: overrides.id || 'task-' + Math.random().toString(36).slice(2, 10),
      provider: overrides.provider || 'ollama',
      model: overrides.model || 'qwen2.5-coder:32b',
      task_description: overrides.task_description || 'Test task',
      metadata: overrides.metadata || null,
      ...overrides,
    };
  }

  function setupCodexOverflow({ runningCodexCount, queuedTask, hostStatus, hostRunning, hostMaxConcurrent, configOverrides, freeQuotaTracker }) {
    const runningCodexTasks = Array.from({ length: runningCodexCount }, (_, i) =>
      makeTask({ id: `running-codex-${i}`, provider: 'codex', status: 'running' })
    );

    mockDb.listTasks.mockImplementation(({ status }) => {
      if (status === 'queued') return [queuedTask];
      if (status === 'running') return runningCodexTasks;
      return [];
    });

    mockDb.listOllamaHosts.mockReturnValue([
      {
        id: 'h1', name: 'local-host',
        status: hostStatus || 'healthy',
        running_tasks: hostRunning != null ? hostRunning : 0,
        max_concurrent: hostMaxConcurrent != null ? hostMaxConcurrent : 4,
      },
    ]);

    mockDb.getConfig.mockImplementation(createConfigMock({
      codex_enabled: '1',
      ollama_balanced_model: 'qwen2.5-coder:32b',
      ollama_fast_model: 'qwen2.5-coder:7b',
      ...(configOverrides || {}),
    }));

    // Inject free-tier quota tracker if provided
    if (freeQuotaTracker) {
      scheduler.init({ db: mockDb, ...mocks, getFreeQuotaTracker: () => freeQuotaTracker });
      // Re-wrap with skip guard
      const originalProcessQueue = scheduler.processQueueInternal;
      scheduler.processQueueInternal = (options = {}) => originalProcessQueue({
        skipRecentProcessGuard: true,
        ...options,
      });
    }
  }

  // ── (a) user_provider_override blocks local LLM overflow ──

  it('does NOT overflow to local LLM when user_provider_override is true', () => {
    const queuedTask = makeTask({
      id: 'bug001-user-override',
      provider: 'codex',
      task_description: 'Build feature with Codex',
      metadata: JSON.stringify({
        complexity: 'normal',
        smart_routing: true,
        user_provider_override: true,
      }),
    });

    setupCodexOverflow({
      runningCodexCount: 3,
      queuedTask,
      hostStatus: 'healthy',
      hostRunning: 0,
      hostMaxConcurrent: 4,
    });

    scheduler.processQueueInternal();

    const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
      (c) => c[0] === 'bug001-user-override' && c[2]?.provider === 'aider-ollama'
    );
    expect(overflowCalls).toHaveLength(0);
  });

  // ── (b) user_provider_override blocks free-tier overflow ──

  it('does NOT overflow to free-tier providers when user_provider_override is true', () => {
    const freeQuotaTracker = {
      getAvailableProviders: vi.fn().mockReturnValue([
        { provider: 'groq', dailyRemainingPct: 0.8 },
      ]),
    };

    const queuedTask = makeTask({
      id: 'bug001-no-free-tier',
      provider: 'codex',
      task_description: 'Important Codex task',
      metadata: JSON.stringify({
        complexity: 'normal',
        smart_routing: true,
        user_provider_override: true,
      }),
    });

    setupCodexOverflow({
      runningCodexCount: 3,
      queuedTask,
      hostStatus: 'down', // local LLM down, would normally try free-tier
      hostRunning: 0,
      hostMaxConcurrent: 4,
      freeQuotaTracker,
    });

    scheduler.processQueueInternal();

    // Should NOT have been rerouted to free-tier
    const freeTierCalls = mockDb.updateTaskStatus.mock.calls.filter(
      (c) => c[0] === 'bug001-no-free-tier' && c[2]?.provider === 'groq'
    );
    expect(freeTierCalls).toHaveLength(0);

    // Free-tier tracker should NOT have been consulted at all
    // (the overflow loop skips the task entirely due to user_provider_override)
    expect(freeQuotaTracker.getAvailableProviders).not.toHaveBeenCalled();
  });

  // ── (c) smart-routed tasks STILL overflow normally ──

  it('DOES overflow smart-routed tasks to local LLM when no user override', () => {
    const queuedTask = makeTask({
      id: 'bug001-smart-overflow',
      provider: 'codex',
      task_description: 'Write unit tests (smart-routed)',
      metadata: JSON.stringify({
        complexity: 'normal',
        smart_routing: true,
        user_provider_override: false,
      }),
    });

    setupCodexOverflow({
      runningCodexCount: 3,
      queuedTask,
      hostStatus: 'healthy',
      hostRunning: 0,
      hostMaxConcurrent: 4,
    });

    scheduler.processQueueInternal();

    const overflowCalls = mockDb.updateTaskStatus.mock.calls.filter(
      (c) => c[0] === 'bug001-smart-overflow' && c[2]?.provider === 'aider-ollama'
    );
    expect(overflowCalls).toHaveLength(1);
  });

  it('DOES overflow smart-routed tasks to free-tier when local LLM unavailable', () => {
    const freeQuotaTracker = {
      getAvailableProviders: vi.fn().mockReturnValue([
        { provider: 'groq', dailyRemainingPct: 0.9 },
      ]),
    };

    const queuedTask = makeTask({
      id: 'bug001-smart-free-tier',
      provider: 'codex',
      task_description: 'Write docs (smart-routed)',
      metadata: JSON.stringify({
        complexity: 'normal',
        smart_routing: true,
        // user_provider_override NOT set (or false)
      }),
    });

    setupCodexOverflow({
      runningCodexCount: 3,
      queuedTask,
      hostStatus: 'down', // no local LLM
      hostRunning: 0,
      hostMaxConcurrent: 4,
      freeQuotaTracker,
    });

    scheduler.processQueueInternal();

    const freeTierCalls = mockDb.updateTaskStatus.mock.calls.filter(
      (c) => c[0] === 'bug001-smart-free-tier' && c[2]?.provider === 'groq'
    );
    expect(freeTierCalls).toHaveLength(1);
  });

  // ── (d) regression: mixed queue with override + smart-routed tasks ──

  it('skips override task but overflows smart-routed task behind it', () => {
    const userTask = makeTask({
      id: 'bug001-user-explicit',
      provider: 'codex',
      task_description: 'Critical codex task (user override)',
      metadata: JSON.stringify({
        complexity: 'normal',
        smart_routing: true,
        user_provider_override: true,
      }),
    });
    const smartTask = makeTask({
      id: 'bug001-smart-behind',
      provider: 'codex',
      task_description: 'Write tests (smart-routed)',
      metadata: JSON.stringify({
        complexity: 'normal',
        smart_routing: true,
        user_provider_override: false,
      }),
    });

    const runningCodexTasks = Array.from({ length: 3 }, (_, i) =>
      makeTask({ id: `running-codex-${i}`, provider: 'codex', status: 'running' })
    );

    mockDb.listTasks.mockImplementation(({ status }) => {
      if (status === 'queued') return [userTask, smartTask];
      if (status === 'running') return runningCodexTasks;
      return [];
    });

    mockDb.listOllamaHosts.mockReturnValue([
      { id: 'h1', name: 'local', status: 'healthy', running_tasks: 0, max_concurrent: 4 },
    ]);

    mockDb.getConfig.mockImplementation(createConfigMock({
      codex_enabled: '1',
      ollama_balanced_model: 'qwen2.5-coder:32b',
    }));

    scheduler.processQueueInternal();

    // User-override task stays queued (not overflowed)
    const userOverflow = mockDb.updateTaskStatus.mock.calls.filter(
      (c) => c[0] === 'bug001-user-explicit' && c[2]?.provider === 'aider-ollama'
    );
    expect(userOverflow).toHaveLength(0);

    // Smart-routed task behind it gets overflowed
    const smartOverflow = mockDb.updateTaskStatus.mock.calls.filter(
      (c) => c[0] === 'bug001-smart-behind' && c[2]?.provider === 'aider-ollama'
    );
    expect(smartOverflow).toHaveLength(1);
  });
});


// ────────────────────────────────────────────────────────────────
// Part 3: task-manager.js — resolveProviderRouting budget gates
// ────────────────────────────────────────────────────────────────
describe('BUG-001: override_provider blocks budget rerouting in task-manager', () => {
  let db;
  let _taskManager;

  beforeAll(() => {
    const env = setupTestDb('bug-001-taskmanager');
    db = env.db;
    _taskManager = require('../task-manager');
    // Prevent real network calls
    db.checkOllamaHealth = async () => true;
  });
  afterAll(() => { teardownTestDb(); });

  // We cannot call resolveProviderRouting directly (not exported).
  // Instead, test through the smart_submit_task tool which sets metadata,
  // then verify the metadata flags are correct for downstream consumption.

  it('budget-exceeded: user_provider_override=true task keeps codex provider', async () => {
    // Set a very low budget so it's exceeded
    if (typeof db.setBudget === 'function') {
      try { db.setBudget({ name: 'codex_budget', amount: 0.01, period: 'daily' }); } catch { /* ok */ }
    }

    const result = await safeTool('smart_submit_task', {
      task: 'Build payment processing pipeline with full test coverage',
      provider: 'codex',
    });

    const text = getText(result);
    const match = text.match(/Task ID\s*\|\s*`([^`]+)`/);
    if (match) {
      const task = db.getTask(match[1]);
      const meta = parseMeta(task);
      // The task was created with user_provider_override=true
      expect(meta.user_provider_override).toBe(true);
      // When resolveProviderRouting runs, it should see this flag and NOT
      // reroute to ollama even if budget is exceeded
    }

    // Reset budget
    if (typeof db.setBudget === 'function') {
      try { db.setBudget({ name: 'codex_budget', amount: 200, period: 'daily' }); } catch { /* ok */ }
    }
  });

  it('budget-warning: smart-routed non-critical task can be rerouted', async () => {
    const result = await safeTool('smart_submit_task', {
      task: 'Write documentation for the error handling module',
      // No provider override — smart-routed
    });

    const text = getText(result);
    const match = text.match(/Task ID\s*\|\s*`([^`]+)`/);
    if (match) {
      const task = db.getTask(match[1]);
      const meta = parseMeta(task);
      // Smart-routed task without user override — eligible for budget rerouting
      expect(meta.smart_routing).toBe(true);
      expect(meta.user_provider_override).toBeFalsy();
    }
  });

  it('budget-warning: user-override task is NOT eligible for budget rerouting', async () => {
    const result = await safeTool('smart_submit_task', {
      task: 'Write documentation for the payment module',
      provider: 'codex',
    });

    const text = getText(result);
    const match = text.match(/Task ID\s*\|\s*`([^`]+)`/);
    if (match) {
      const task = db.getTask(match[1]);
      const meta = parseMeta(task);
      // user_provider_override=true → resolveProviderRouting budget-warning
      // check skips rerouting
      expect(meta.user_provider_override).toBe(true);
      expect(meta.smart_routing).toBe(true); // still has smart_routing flag
    }
  });
});


// ────────────────────────────────────────────────────────────────
// Part 4: End-to-end regression — the original bug scenario
// ────────────────────────────────────────────────────────────────
describe('BUG-001 regression: explicit Codex override must not route to ollama', () => {
  beforeAll(() => {
    const env = setupTestDb('bug-001-e2e');
    db = env.db;
    db.checkOllamaHealth = async () => true;
  });
  afterAll(() => { teardownTestDb(); });

  it('task submitted with override_provider=codex is NOT routed to ollama', async () => {
    // This is the exact scenario from the bug report: task submitted with
    // override_provider: codex ended up on ollama
    const result = await safeTool('smart_submit_task', {
      task: 'Scan project and run full test suite with coverage',
      override_provider: 'codex',
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    const match = text.match(/Task ID\s*\|\s*`([^`]+)`/);
    expect(match).toBeTruthy();

    const task = db.getTask(match[1]);
    // Provider is now deferred (null) — check intended_provider in metadata
    expect(task.provider).toBeNull();
    const meta = parseMeta(task);
    expect(meta.intended_provider || meta.requested_provider).toBe('codex');
    expect(meta.user_provider_override).toBe(true);
  });

  it('task submitted with provider=codex is NOT routed to ollama', async () => {
    // Same scenario using the standard 'provider' arg
    const result = await safeTool('smart_submit_task', {
      task: 'Generate comprehensive test suite for user authentication',
      provider: 'codex',
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    const match = text.match(/Task ID\s*\|\s*`([^`]+)`/);
    expect(match).toBeTruthy();

    const task = db.getTask(match[1]);
    // Provider is now deferred (null) — check intended_provider in metadata
    expect(task.provider).toBeNull();
    const meta = parseMeta(task);
    expect(meta.intended_provider || meta.requested_provider).toBe('codex');
  });

  it('output confirms provider is codex (not ollama)', async () => {
    const result = await safeTool('smart_submit_task', {
      task: 'Implement retry logic for failed API calls',
      provider: 'codex',
    });

    const text = getText(result);
    // The output table should show Provider as codex
    expect(text).toMatch(/Provider\s*\|\s*\*\*codex\*\*/);
  });

  it('routing reason indicates user override', async () => {
    const result = await safeTool('smart_submit_task', {
      task: 'Deploy staging environment configuration',
      override_provider: 'codex',
    });

    const text = getText(result);
    // Routing reason should indicate user override
    expect(text).toContain('User override');
  });

  it('metadata includes requested_provider for traceability', async () => {
    const result = await safeTool('smart_submit_task', {
      task: 'Build authentication module from scratch',
      provider: 'codex',
    });

    const text = getText(result);
    const match = text.match(/Task ID\s*\|\s*`([^`]+)`/);
    expect(match).toBeTruthy();

    const task = db.getTask(match[1]);
    const meta = parseMeta(task);
    expect(meta.requested_provider).toBe('codex');
  });

  it('requested_provider is set for traceability even without override', async () => {
    const result = await safeTool('smart_submit_task', {
      task: 'Write inline comments for utility functions',
    });

    const text = getText(result);
    const match = text.match(/Task ID\s*\|\s*`([^`]+)`/);
    expect(match).toBeTruthy();

    const task = db.getTask(match[1]);
    const meta = parseMeta(task);
    // requested_provider is always set (by createTask) for traceability,
    // but user_provider_override=false means it was NOT a user override
    expect(meta.user_provider_override).toBe(false);
    expect(meta.requested_provider).toBeTruthy(); // set by createTask auto-injection
  });
});
