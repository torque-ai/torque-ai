'use strict';

const { setupE2eDb, teardownE2eDb } = require('./e2e-helpers');
const { TEST_MODELS } = require('./test-helpers');
const { createTaskWorkspaceManager } = require('./task-workspace-helpers');

let taskWorkspaces;

function taskWorkspace() {
  return taskWorkspaces.create();
}

beforeEach(() => {
  taskWorkspaces = createTaskWorkspaceManager({ prefix: 'torque-runtime-truth-' });
});

afterEach(() => {
  if (taskWorkspaces) {
    taskWorkspaces.cleanup();
  }
  taskWorkspaces = null;
});

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
        working_directory: taskWorkspace(),
        provider: 'ollama',
        model: TEST_MODELS.SMALL,
      });

      db.updateTaskStatus(id, 'running', {
        pid: 4242,
        subprocess_pid: 5151,
        output_log_path: '/tmp/torque/stdout.log',
        error_log_path: '/tmp/torque/stderr.log',
        output_log_offset: 128,
        error_log_offset: 64,
        last_activity_at: '2026-03-12T00:01:00.000Z',
        completion_detected_at: '2026-03-12T00:02:00.000Z',
        stall_recovery_attempts: 2,
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
      expect(task.subprocess_pid).toBeNull();
      expect(task.output_log_path).toBeNull();
      expect(task.error_log_path).toBeNull();
      expect(task.output_log_offset).toBe(0);
      expect(task.error_log_offset).toBe(0);
      expect(task.last_activity_at).toBeNull();
      expect(task.completion_detected_at).toBeNull();
      expect(task.stall_recovery_attempts).toBe(2);
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
        working_directory: taskWorkspace(),
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
      working_directory: taskWorkspace(),
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

  it('fails task with OOM Protection when model exceeds host memory and cloud fallback declines', async () => {
    const mod = require('../providers/execute-ollama');
    const safeUpdateTaskStatus = vi.fn();
    const tryOllamaCloudFallback = vi.fn(() => false);
    const tryReserveHostSlotWithFallback = vi.fn();
    const recordTaskStartedAuditEvent = vi.fn();

    mod.init({
      db: {
        listOllamaHosts: vi.fn(() => [{ id: 'host-1', name: 'host-1', url: 'http://127.0.0.1:11434', enabled: 1, status: 'healthy' }]),
        selectOllamaHostForModel: vi.fn(() => ({
          host: null,
          memoryError: true,
          reason: 'Model requires 48 GB but host-1 only has 8 GB VRAM',
          suggestedModels: [
            { name: 'qwen2.5-coder:7b', sizeGb: 4.5 },
            { name: 'deepseek-coder:6.7b', sizeGb: 3.8 },
          ],
        })),
        selectHostWithModelVariant: vi.fn(() => ({ host: null })),
        getOllamaHost: vi.fn(() => null),
        requeueTaskAfterAttemptedStart: vi.fn(),
        updateTaskStatus: vi.fn(),
        recordHostModelUsage: vi.fn(),
        decrementHostTasks: vi.fn(),
      },
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      tryReserveHostSlotWithFallback,
      tryOllamaCloudFallback,
      isLargeModelBlockedOnHost: vi.fn(() => ({ blocked: false })),
      buildFileContext: vi.fn().mockResolvedValue(''),
      processQueue: vi.fn(),
      recordTaskStartedAuditEvent,
    });

    const task = {
      id: 'ollama-oom-task',
      task_description: 'Test OOM rejection path',
      provider: 'ollama',
      model: TEST_MODELS.SMALL,
      metadata: null,
      error_output: '',
    };

    const result = await mod.executeOllamaTask(task);

    // OOM path returns undefined (bare return)
    expect(result).toBeUndefined();

    // Cloud fallback was attempted with the OOM error message
    expect(tryOllamaCloudFallback).toHaveBeenCalledWith(
      task.id,
      task,
      expect.stringContaining('OOM Protection')
    );

    // Since cloud fallback returned false, task was marked failed
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      task.id,
      'failed',
      expect.objectContaining({
        error_output: expect.stringMatching(/OOM Protection[\s\S]*Suggested alternatives[\s\S]*qwen2\.5-coder:7b[\s\S]*4\.5 GB[\s\S]*deepseek-coder:6\.7b[\s\S]*3\.8 GB/),
      })
    );

    // No host slot was ever reserved — tryReserveHostSlotWithFallback should not have been called
    expect(tryReserveHostSlotWithFallback).not.toHaveBeenCalled();

    // task_started audit event should NOT fire — execution never began
    expect(recordTaskStartedAuditEvent).not.toHaveBeenCalled();
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

  // work-item #2334 — host-slot release on failure path
  it('releases host slot exactly once when the HTTP request rejects (failure-path slot decrement)', async () => {
    const http = require('http');
    const { EventEmitter } = require('events');
    const mod = require('../providers/execute-ollama');
    const decrementHostTasks = vi.fn();
    const safeUpdateTaskStatus = vi.fn();
    const recordTaskStartedAuditEvent = vi.fn();

    const host = { id: 'host-1', name: 'host-1', url: 'http://127.0.0.1:11434', enabled: 1, status: 'healthy', models: [TEST_MODELS.SMALL] };

    mod.init({
      db: {
        listOllamaHosts: vi.fn(() => [host]),
        getOllamaHost: vi.fn(() => host),
        selectOllamaHostForModel: vi.fn(() => ({ host, model: TEST_MODELS.SMALL, reason: 'exact match' })),
        selectHostWithModelVariant: vi.fn(() => ({ host: null })),
        getConfig: vi.fn(() => null),
        getHostSettings: vi.fn(() => null),
        getAggregatedModels: vi.fn(() => [TEST_MODELS.SMALL]),
        recordHostModelUsage: vi.fn(),
        updateTaskStatus: vi.fn(),
        getOrCreateTaskStream: vi.fn(() => 'stream-1'),
        addStreamChunk: vi.fn(),
        getTask: vi.fn(() => ({ id: 'slot-release-task', status: 'running' })),
        isProviderQuotaError: vi.fn(() => false),
        recordProviderUsage: vi.fn(),
        decrementHostTasks,
        requeueTaskAfterAttemptedStart: vi.fn(),
      },
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      tryReserveHostSlotWithFallback: vi.fn(() => ({ success: true })),
      tryOllamaCloudFallback: vi.fn(() => false),
      isLargeModelBlockedOnHost: vi.fn(() => ({ blocked: false })),
      buildFileContext: vi.fn().mockResolvedValue(''),
      processQueue: vi.fn(),
      recordTaskStartedAuditEvent,
    });

    // Spy on http.request to simulate a connection failure after slot is reserved
    vi.spyOn(http, 'request').mockImplementation((_options, _callback) => {
      const req = new EventEmitter();
      req.write = vi.fn();
      req.end = vi.fn(() => {
        process.nextTick(() => req.emit('error', new Error('connection refused')));
      });
      req.destroy = vi.fn();
      return req;
    });

    const task = {
      id: 'slot-release-task',
      task_description: 'Test host-slot release on failure',
      provider: 'ollama',
      model: TEST_MODELS.SMALL,
      ollama_host_id: 'host-1',
      metadata: null,
      error_output: '',
      working_directory: taskWorkspace(),
    };

    await mod.executeOllamaTask(task);

    // The host slot must be decremented exactly once — not zero (leak) or twice (double-release)
    expect(decrementHostTasks).toHaveBeenCalledTimes(1);
    expect(decrementHostTasks).toHaveBeenCalledWith('host-1');

    // The slot reservation happened before the failure
    expect(recordTaskStartedAuditEvent).toHaveBeenCalledTimes(1);

    // Task was marked failed (not silently swallowed)
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      'slot-release-task',
      'failed',
      expect.objectContaining({
        error_output: expect.stringContaining('connection refused'),
      })
    );
  });
});
