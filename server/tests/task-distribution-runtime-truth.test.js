'use strict';

const { setupE2eDb, teardownE2eDb } = require('./e2e-helpers');
const { TEST_MODELS } = require('./test-helpers');

describe('task distribution runtime truth', () => {
  describe('requeueTaskAfterAttemptedStart', () => {
    let ctx;
    let db;

    beforeEach(() => {
      ctx = setupE2eDb('task-distribution-runtime-truth');
      db = ctx.db;
    });

    afterEach(async () => {
      await teardownE2eDb(ctx);
      ctx = null;
      db = null;
    });

    it('clears attempted-start artifacts when returning work to queue', () => {
      const id = 'runtime-truth-requeue';
      db.createTask({
        id,
        status: 'queued',
        task_description: 'Requeue after attempted start',
        working_directory: process.cwd(),
        provider: 'ollama',
        model: TEST_MODELS.SMALL,
      });

      db.updateTaskStatus(id, 'running', {
        pid: 4242,
        progress_percent: 55,
        mcp_instance_id: 'mcp-lock-1',
        ollama_host_id: 'host-1',
        exit_code: 9,
        completed_at: '2026-03-12T00:00:00.000Z',
      });

      db.requeueTaskAfterAttemptedStart(id, {
        error_output: 'Temporarily requeued: provider unavailable',
      });

      const task = db.getTask(id);
      expect(task.status).toBe('queued');
      expect(task.started_at).toBeNull();
      expect(task.completed_at).toBeNull();
      expect(task.pid).toBeNull();
      expect(task.progress_percent).toBeNull();
      expect(task.exit_code).toBeNull();
      expect(task.mcp_instance_id).toBeNull();
      expect(task.ollama_host_id).toBeNull();
      expect(task.error_output).toBe('Temporarily requeued: provider unavailable');
    });
  });

  describe('startTask disabled-provider unwind', () => {
    let ctx;
    let db;
    let tm;

    beforeEach(() => {
      ctx = setupE2eDb('task-distribution-disabled-provider');
      db = ctx.db;
      tm = ctx.tm;
      db.setConfig('rate_limit_enabled', '0');
      db.setConfig('duplicate_check_enabled', '0');
      db.setConfig('budget_check_enabled', '0');
      db.updateProvider('claude-cli', { enabled: 0 });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await teardownE2eDb(ctx);
      ctx = null;
      db = null;
      tm = null;
    });

    it('requeues without leaving slot-claim artifacts behind', async () => {
      const id = 'disabled-provider-requeue';
      db.createTask({
        id,
        status: 'pending',
        task_description: 'Task should requeue cleanly',
        working_directory: process.cwd(),
        provider: 'claude-cli',
      });

      const result = await tm.startTask(id);
      const task = db.getTask(id);

      expect(result).toEqual(expect.objectContaining({ queued: true }));
      expect(task.status).toBe('queued');
      expect(task.started_at).toBeNull();
      expect(task.completed_at).toBeNull();
      expect(task.pid).toBeNull();
      expect(task.progress_percent).toBeNull();
      expect(task.mcp_instance_id).toBeNull();
    });
  });
});

describe('provider execution attempted-start cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requeues failed free-provider API work through the cleanup helper', async () => {
    const mod = require('../providers/execute-api');
    const tasks = new Map();
    const task = {
      id: 'api-requeue-task',
      task_description: 'Test API retry cleanup',
      provider: 'groq',
      status: 'pending',
      model: null,
      metadata: null,
      timeout_minutes: 1,
      working_directory: process.cwd(),
    };
    tasks.set(task.id, { ...task });

    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      requeueTaskAfterAttemptedStart: vi.fn((taskId, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const { provider: patchProvider, metadata: patchMetadata, ...restPatch } = patch;
        const metadata = patchProvider
          ? {
            ...(current.metadata || {}),
            ...(patchMetadata || {}),
            intended_provider: patchProvider,
            eligible_providers: [patchProvider],
          }
          : patchMetadata ?? current.metadata ?? null;
        const next = {
          ...current,
          started_at: null,
          completed_at: null,
          pid: null,
          progress_percent: null,
          exit_code: null,
          mcp_instance_id: null,
          ollama_host_id: null,
          ...restPatch,
          metadata,
          provider: null,
          status: 'queued',
        };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getProvider: vi.fn((name) => (name === 'codex' ? { enabled: true } : { enabled: true })),
      isProviderHealthy: vi.fn(() => true),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      recordUsage: vi.fn(),
    };
    const dashboard = {
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    };
    const recordTaskStartedAuditEvent = vi.fn();

    mod.init({
      db,
      dashboard,
      apiAbortControllers: new Map(),
      processQueue: vi.fn(),
      recordTaskStartedAuditEvent,
    });

    const provider = {
      name: 'groq',
      supportsStreaming: false,
      submit: vi.fn(async () => {
        const err = new Error('provider overloaded');
        err.status = 503;
        throw err;
      }),
    };

    await mod.executeApiProvider(task, provider);

    expect(recordTaskStartedAuditEvent).toHaveBeenCalledWith(task, task.id, 'groq');
    expect(db.requeueTaskAfterAttemptedStart).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        provider: 'codex',
        model: null,
        output: null,
        error_output: null,
      })
    );

    const updatedTask = tasks.get(task.id);
    expect(updatedTask.status).toBe('queued');
    expect(updatedTask.provider).toBeNull();
    expect(updatedTask.metadata).toMatchObject({
      free_provider_retry: true,
      intended_provider: 'codex',
      eligible_providers: ['codex'],
    });
    expect(updatedTask.started_at).toBeNull();
    expect(updatedTask.completed_at).toBeNull();
    expect(updatedTask.mcp_instance_id).toBeNull();
  });

  it('does not emit task_started when Ollama unwinds before actual execution begins', async () => {
    const mod = require('../providers/execute-ollama');
    const requeueTaskAfterAttemptedStart = vi.fn();
    const recordTaskStartedAuditEvent = vi.fn();

    mod.init({
      db: {
        listOllamaHosts: vi.fn(() => [{ id: 'host-1', name: 'host-1', url: 'http://127.0.0.1:11434', enabled: 1, status: 'healthy' }]),
        selectOllamaHostForModel: vi.fn((model) => ({
          host: { id: 'host-1', name: 'host-1', url: 'http://127.0.0.1:11434' },
          model,
          reason: 'selected host-1',
        })),
        selectHostWithModelVariant: vi.fn(() => ({ host: null })),
        getOllamaHost: vi.fn(() => null),
        requeueTaskAfterAttemptedStart,
        updateTaskStatus: vi.fn(),
        recordHostModelUsage: vi.fn(),
      },
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus: vi.fn(),
      tryReserveHostSlotWithFallback: vi.fn(() => ({ success: false, reason: 'Host at capacity' })),
      tryOllamaCloudFallback: vi.fn(() => false),
      isLargeModelBlockedOnHost: vi.fn(() => ({ blocked: false })),
      buildFileContext: vi.fn().mockResolvedValue(''),
      processQueue: vi.fn(),
      recordTaskStartedAuditEvent,
    });

    const task = {
      id: 'ollama-unwind-task',
      task_description: 'Test ollama unwind',
      provider: 'ollama',
      model: TEST_MODELS.SMALL,
      metadata: null,
      error_output: '',
    };

    const result = await mod.executeOllamaTask(task);

    expect(result).toEqual(expect.objectContaining({ success: true, requeued: true }));
    expect(requeueTaskAfterAttemptedStart).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        error_output: expect.stringContaining('Host at capacity'),
      })
    );
    expect(recordTaskStartedAuditEvent).not.toHaveBeenCalled();
  });
});
