const { randomUUID } = require('crypto');
const path = require('path');

const BASE_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 120000;

describe('retry scheduling exponential backoff', () => {
  let db;
  let mod;
  let setTimeoutSpy;
  let tasks;
  let hosts;
  let taskCounter = 0;

  beforeEach(() => {
    taskCounter = 0;
    tasks = new Map();
    hosts = new Map();

    db = {
      _config: {
        max_hashline_local_retries: '10',
        hashline_capable_models: 'qwen2.5-coder',
      },
      addTask(task) {
        tasks.set(task.id, task);
      },
      getTask(taskId) {
        return tasks.get(taskId);
      },
      updateTaskStatus(taskId, status, fields = {}) {
        const task = tasks.get(taskId);
        if (!task) return null;
        const updated = { ...task, status, ...fields };
        tasks.set(taskId, updated);
        return updated;
      },
      getConfig(key) {
        return this._config[key];
      },
      selectOllamaHostForModel(model, options = {}) {
        const excludeHostIds = new Set(options.excludeHostIds || []);
        for (const host of hosts.values()) {
          if (excludeHostIds.has(host.id)) continue;
          if (host.models.includes(model)) {
            return { host: { id: host.id, name: host.name } };
          }
        }
        return null;
      },
      recordFailoverEvent() {},
    };

    mod = require('../execution/fallback-retry');
    mod.init({
      db,
      dashboard: { notifyTaskUpdated: () => {} },
      processQueue: () => {},
      cancelTask: () => ({ status: 'cancelled' }),
      stopTaskForRestart: () => {},
      stallRecoveryAttempts: new Map(),
      runningProcesses: new Map(),
    });
  });

  afterEach(() => {
    if (setTimeoutSpy) {
      setTimeoutSpy.mockRestore();
      setTimeoutSpy = null;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function registerHost(name, modelNames) {
    const id = `host-${name}-${++taskCounter}`;
    hosts.set(id, {
      id,
      name,
      models: modelNames.map(m => (typeof m === 'string' ? m : m.name)),
    });
    return id;
  }

  function createTask(overrides = {}) {
    const taskId = overrides.id || randomUUID();
    const task = {
      id: taskId,
      status: overrides.status || 'running',
      task_description: overrides.task_description || 'p3-exponential-backoff task',
      provider: overrides.provider || 'hashline-ollama',
      model: overrides.model || 'qwen2.5-coder:14b',
      working_directory: overrides.working_directory || path.join(process.cwd(), 'tmp'),
      ollama_host_id: overrides.ollama_host_id || null,
      metadata: overrides.metadata || null,
      error_output: overrides.error_output || '',
      retry_count: overrides.retry_count,
    };
    db.addTask(task);
    return task;
  }

  function getScheduledDelayForRetryCount(retryCount) {
    vi.useFakeTimers();
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const hostA = registerHost('hashline-host-a', ['qwen2.5-coder:14b']);
    registerHost('hashline-host-b', ['qwen2.5-coder:14b']);

    const task = createTask({
      provider: 'hashline-ollama',
      model: 'qwen2.5-coder:14b',
      ollama_host_id: hostA,
      retry_count: retryCount,
    });

    const ok = mod.tryHashlineTieredFallback(task.id, task, 'temporary transport issue');
    expect(ok).toBe(true);

    expect(setTimeoutSpy).toHaveBeenCalled();
    const lastCall = setTimeoutSpy.mock.calls.at(-1);
    return lastCall[1];
  }

  it('uses base delay for first retry attempt', () => {
    const delay = getScheduledDelayForRetryCount(1);
    expect(delay).toBe(BASE_RETRY_DELAY_MS);
  });

  it('uses exponential delay for third retry attempt', () => {
    const delay = getScheduledDelayForRetryCount(3);
    expect(delay).toBe(BASE_RETRY_DELAY_MS * 4);
  });

  it('caps retry delay at MAX_RETRY_DELAY_MS', () => {
    const delay = getScheduledDelayForRetryCount(20);
    expect(delay).toBe(MAX_RETRY_DELAY_MS);
  });
});
