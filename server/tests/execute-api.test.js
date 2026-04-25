'use strict';

const SUBJECT_PATH = require.resolve('../providers/execute-api');
const LOGGER_PATH = require.resolve('../logger');
const SANITIZE_PATH = require.resolve('../utils/sanitize');
const CONTEXT_STUFFING_PATH = require.resolve('../utils/context-stuffing');
const STUDY_ENGINE_PATH = require.resolve('../integrations/codebase-study-engine');
const MODEL_ROLES_PATH = require.resolve('../db/model-roles');
const PROVIDER_MODEL_SCORES_PATH = require.resolve('../db/provider-model-scores');

const ORIGINAL_CACHE_ENTRIES = new Map([
  [LOGGER_PATH, require.cache[LOGGER_PATH]],
  [SANITIZE_PATH, require.cache[SANITIZE_PATH]],
  [CONTEXT_STUFFING_PATH, require.cache[CONTEXT_STUFFING_PATH]],
  [STUDY_ENGINE_PATH, require.cache[STUDY_ENGINE_PATH]],
  [MODEL_ROLES_PATH, require.cache[MODEL_ROLES_PATH]],
  [PROVIDER_MODEL_SCORES_PATH, require.cache[PROVIDER_MODEL_SCORES_PATH]],
]);

let nextTaskId = 0;

function installMock(resolvedPath, exports) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports,
  };
}

function restoreModuleCache() {
  delete require.cache[SUBJECT_PATH];
  for (const [resolvedPath, originalEntry] of ORIGINAL_CACHE_ENTRIES.entries()) {
    if (originalEntry) require.cache[resolvedPath] = originalEntry;
    else delete require.cache[resolvedPath];
  }
}

function loadSubject(options = {}) {
  const loggerInstance = {
    info: vi.fn(),
    debug: vi.fn(),
  };
  const loggerMock = {
    child: vi.fn(() => loggerInstance),
  };
  const sanitizeMock = {
    redactSecrets: vi.fn((text) => {
      if (text == null) return '';
      return `redacted:${text}`;
    }),
  };
  const stuffContextImpl = options.stuffContext
    || (async ({ taskDescription }) => ({ enrichedDescription: `${taskDescription} [enriched]` }));
  const contextStuffingMock = {
    stuffContext: vi.isMockFunction(stuffContextImpl) ? stuffContextImpl : vi.fn(stuffContextImpl),
    CONTEXT_STUFFING_PROVIDERS: options.contextProviders
      || new Set(['groq', 'cerebras', 'google-ai', 'openrouter', 'ollama-cloud']),
  };
  const studyEngineMock = {
    applyStudyContextPrompt: options.applyStudyContextPrompt
      || vi.fn((taskDescription) => taskDescription),
  };
  const modelRolesMock = options.modelRoles || null;
  const providerModelScoresMock = options.providerModelScores || null;

  installMock(LOGGER_PATH, loggerMock);
  installMock(SANITIZE_PATH, sanitizeMock);
  installMock(CONTEXT_STUFFING_PATH, contextStuffingMock);
  installMock(STUDY_ENGINE_PATH, studyEngineMock);
  if (modelRolesMock) {
    installMock(MODEL_ROLES_PATH, modelRolesMock);
  } else if (options.modelRoles === null) {
    delete require.cache[MODEL_ROLES_PATH];
  } else if (!require.cache[MODEL_ROLES_PATH]) {
    // Keep real module cache state unless explicitly mocked.
    delete require.cache[MODEL_ROLES_PATH];
  }
  if (providerModelScoresMock) {
    installMock(PROVIDER_MODEL_SCORES_PATH, providerModelScoresMock);
  } else if (options.providerModelScores === null) {
    delete require.cache[PROVIDER_MODEL_SCORES_PATH];
  } else if (!require.cache[PROVIDER_MODEL_SCORES_PATH]) {
    delete require.cache[PROVIDER_MODEL_SCORES_PATH];
  }
  delete require.cache[SUBJECT_PATH];

  return {
    mod: require('../providers/execute-api'),
    loggerInstance,
    loggerMock,
    sanitizeMock,
    contextStuffingMock,
    studyEngineMock,
    modelRolesMock,
    providerModelScoresMock,
  };
}

function makeTask(overrides = {}) {
  nextTaskId += 1;
  return {
    id: `task-${nextTaskId}`,
    task_description: 'Write comprehensive tests',
    provider: 'openrouter',
    status: 'pending',
    model: null,
    metadata: null,
    timeout_minutes: null,
    working_directory: 'C:/repo',
    ...overrides,
  };
}

function makeProvider(overrides = {}) {
  return {
    name: 'openrouter',
    submit: vi.fn(async () => ({
      output: 'Provider response output',
      usage: { tokens: 150, prompt_tokens: 100, completion_tokens: 50 },
    })),
    ...overrides,
  };
}

function makeDeps(initialTasks = [], options = {}) {
  const tasks = new Map(initialTasks.map(task => [task.id, { ...task }]));
  const streams = new Map();
  const usageRecords = [];
  const providerConfigs = new Map(Object.entries(options.providerConfigs || {}));
  const providerHealth = options.providerHealth || {};

  const db = {
    updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
      const current = tasks.get(taskId) || { id: taskId };
      const next = { ...current, ...patch, status };
      tasks.set(taskId, next);
      return next;
    }),
    requeueTaskAfterAttemptedStart: vi.fn((taskId, patch = {}) => {
      const current = tasks.get(taskId) || { id: taskId };
      const next = {
        ...current,
        started_at: null,
        completed_at: null,
        pid: null,
        progress_percent: null,
        exit_code: null,
        mcp_instance_id: null,
        ollama_host_id: null,
        ...patch,
        status: 'queued',
      };
      tasks.set(taskId, next);
      return next;
    }),
    updateTask: vi.fn((taskId, patch = {}) => {
      const current = tasks.get(taskId) || { id: taskId };
      const next = { ...current, ...patch };
      tasks.set(taskId, next);
      return next;
    }),
    getTask: vi.fn((taskId) => tasks.get(taskId) || null),
    getProvider: vi.fn((providerName) => providerConfigs.get(providerName) || null),
    isProviderHealthy: vi.fn((providerName) => providerHealth[providerName] !== false),
    getOrCreateTaskStream: vi.fn((taskId, streamType) => {
      const streamId = `${taskId}:${streamType}`;
      if (!streams.has(streamId)) streams.set(streamId, []);
      return streamId;
    }),
    addStreamChunk: vi.fn((streamId, token, streamType) => {
      if (!streams.has(streamId)) streams.set(streamId, []);
      streams.get(streamId).push({ token, streamType });
    }),
    recordUsage: vi.fn((taskId, providerName, model, usage) => {
      usageRecords.push({ taskId, providerName, model, usage });
    }),
  };

  return {
    db,
    dashboard: {
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    },
    apiAbortControllers: new Map(),
    processQueue: vi.fn(),
    seedTask(task) {
      tasks.set(task.id, { ...task });
      return task;
    },
    readTask(taskId) {
      return tasks.get(taskId);
    },
    readStream(taskId, streamType = 'output') {
      return streams.get(`${taskId}:${streamType}`) || [];
    },
    usageRecords,
  };
}

function stubImmediateTimeouts() {
  const delays = [];
  const spy = vi.spyOn(global, 'setTimeout').mockImplementation((callback, ms) => {
    delays.push(ms);
    callback();
    return 0;
  });
  return {
    delays,
    restore() {
      spy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreModuleCache();
});

describe('execute-api.js', () => {
  describe('getRetryableStatus', () => {
    it('extracts status from error status, response, code, and errno fields', () => {
      const { mod } = loadSubject();

      expect(mod.getRetryableStatus({ status: 429 })).toBe(429);
      expect(mod.getRetryableStatus({ response: { status: 503 } })).toBe(503);
      expect(mod.getRetryableStatus({ code: 'ECONNRESET' })).toBe('ECONNRESET');
      expect(mod.getRetryableStatus({ errno: 'ETIMEDOUT' })).toBe('ETIMEDOUT');
      expect(mod.getRetryableStatus(null)).toBeNull();
    });
  });

  describe('isRetryableProviderError', () => {
    it('returns true only for retryable HTTP statuses', () => {
      const { mod } = loadSubject();

      for (const status of [429, 500, 502, 503, 504]) {
        expect(mod.isRetryableProviderError({ status })).toBe(true);
      }
      expect(mod.isRetryableProviderError({ response: { status: 503 } })).toBe(true);
      expect(mod.isRetryableProviderError({ status: 404 })).toBe(false);
      expect(mod.isRetryableProviderError({ code: 429 })).toBe(false);
    });

    it('parses status from error message when .status is absent', () => {
      const { mod } = loadSubject();

      expect(mod.isRetryableProviderError(new Error('Groq API error (429): rate limited'))).toBe(true);
      expect(mod.isRetryableProviderError(new Error('Google AI API error (503): overloaded'))).toBe(true);
      expect(mod.isRetryableProviderError(new Error('API error (400): bad request'))).toBe(false);
      expect(mod.isRetryableProviderError(new Error('no status here'))).toBe(false);
    });
  });

  describe('getRetryAfterFromError', () => {
    it('extracts retry_after_seconds from error message', () => {
      const { mod } = loadSubject();

      expect(mod.getRetryAfterFromError(new Error('rate limited retry_after_seconds=47'))).toBe(47);
      expect(mod.getRetryAfterFromError(new Error('error (429): body retry_after_seconds=13'))).toBe(13);
      expect(mod.getRetryAfterFromError(new Error('no retry info'))).toBeNull();
      expect(mod.getRetryAfterFromError(null)).toBeNull();
    });

    it('extracts retry-after metadata from headers and nested response fields', () => {
      const { mod } = loadSubject();

      expect(mod.getRetryAfterFromError({
        message: 'OpenRouter API error (429): rate limited',
        headers: {
          get: (name) => (name === 'Retry-After' ? '17' : null),
        },
      })).toBe(17);

      expect(mod.getRetryAfterFromError({
        status: 429,
        response: {
          headers: {
            get: (name) => (name === 'retry-after' ? '18' : null),
          },
        },
      })).toBe(18);

      expect(mod.getRetryAfterFromError({
        message: 'OpenRouter API error',
        response: {
          status: 429,
          data: { retry_after_seconds: 21 },
        },
      })).toBe(21);
    });
  });

  describe('delay', () => {
    it('resolves after the requested timeout', async () => {
      const { mod } = loadSubject();
      vi.useFakeTimers();

      let resolved = false;
      const pending = mod.delay(25).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(24);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(resolved).toBe(true);
    });
  });

  describe('submitWithRetry', () => {
    it('returns immediately on the first successful submit', async () => {
      const { mod } = loadSubject();
      const task = makeTask({ task_description: 'Retry once' });
      const provider = makeProvider({
        name: 'retry-provider',
        submit: vi.fn(async () => ({ output: 'ok' })),
      });
      const options = { timeout: 10, signal: new AbortController().signal };

      const result = await mod.submitWithRetry(task, provider, 'model-a', options, 3);

      expect(result).toEqual({ output: 'ok' });
      expect(provider.submit).toHaveBeenCalledTimes(1);
      expect(provider.submit).toHaveBeenCalledWith('Retry once', 'model-a', options);
    });

    it('retries 429 and 503 failures with exponential backoff', async () => {
      const { mod, loggerInstance } = loadSubject();
      const task = makeTask({ task_description: 'Retry sequence' });
      const provider = makeProvider({
        name: 'retry-provider',
        submit: vi.fn()
          .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
          .mockRejectedValueOnce(Object.assign(new Error('service unavailable'), { response: { status: 503 } }))
          .mockResolvedValueOnce({ output: 'recovered' }),
      });
      const timeoutStub = stubImmediateTimeouts();

      try {
        const result = await mod.submitWithRetry(task, provider, null, { timeout: 30 }, 4);

        expect(result).toEqual({ output: 'recovered' });
      } finally {
        timeoutStub.restore();
      }

      expect(provider.submit).toHaveBeenCalledTimes(3);
      expect(timeoutStub.delays).toEqual([75, 150]);
      expect(loggerInstance.info).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(`task ${task.id} retryable failure attempt`),
        { provider: 'retry-provider', status: 429, retryAfter: null }
      );
      expect(loggerInstance.info).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(`task ${task.id} retryable failure attempt`),
        { provider: 'retry-provider', status: 503, retryAfter: null }
      );
    });

    it('stops retrying on non-retryable errors', async () => {
      const { mod } = loadSubject();
      const task = makeTask({ task_description: 'Do not retry' });
      const error = Object.assign(new Error('bad request'), { status: 400 });
      const provider = makeProvider({
        submit: vi.fn(async () => {
          throw error;
        }),
      });

      await expect(mod.submitWithRetry(task, provider, null, {}, 5)).rejects.toBe(error);
      expect(provider.submit).toHaveBeenCalledTimes(1);
    });

    it('rethrows AbortError without retrying', async () => {
      const { mod } = loadSubject();
      const task = makeTask({ task_description: 'Abort me' });
      const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
      const provider = makeProvider({
        submit: vi.fn(async () => {
          throw abortError;
        }),
      });

      await expect(mod.submitWithRetry(task, provider, null, {}, 5)).rejects.toBe(abortError);
      expect(provider.submit).toHaveBeenCalledTimes(1);
    });
  });

  describe('enrichTaskDescription', () => {
    it('returns the original description when metadata JSON is malformed', async () => {
      const { mod, contextStuffingMock } = loadSubject();
      const task = makeTask({
        provider: 'openrouter',
        metadata: '{invalid-json',
      });

      const result = await mod.enrichTaskDescription(task);

      expect(result).toBe(task.task_description);
      expect(contextStuffingMock.stuffContext).not.toHaveBeenCalled();
    });

    it('returns the original description when context stuffing is disabled', async () => {
      const { mod, contextStuffingMock, studyEngineMock } = loadSubject();
      const task = makeTask({
        metadata: JSON.stringify({
          context_stuff: false,
          context_files: ['C:/repo/a.js'],
        }),
      });

      const result = await mod.enrichTaskDescription(task);

      expect(result).toBe(task.task_description);
      expect(contextStuffingMock.stuffContext).not.toHaveBeenCalled();
      expect(studyEngineMock.applyStudyContextPrompt).toHaveBeenCalledWith(task.task_description, {
        context_stuff: false,
        context_files: ['C:/repo/a.js'],
      });
    });

    it('returns the original description when no context files are present', async () => {
      const { mod, contextStuffingMock } = loadSubject();
      const task = makeTask({
        metadata: JSON.stringify({ context_files: [] }),
      });

      const result = await mod.enrichTaskDescription(task);

      expect(result).toBe(task.task_description);
      expect(contextStuffingMock.stuffContext).not.toHaveBeenCalled();
    });

    it('returns the original description for unsupported providers', async () => {
      const { mod, contextStuffingMock } = loadSubject({
        contextProviders: new Set(['groq']),
      });
      const task = makeTask({
        provider: 'anthropic',
        metadata: JSON.stringify({ context_files: ['C:/repo/a.js'] }),
      });

      const result = await mod.enrichTaskDescription(task);

      expect(result).toBe(task.task_description);
      expect(contextStuffingMock.stuffContext).not.toHaveBeenCalled();
    });

    it('uses stuffContext and returns the enriched description when enabled', async () => {
      const { mod, contextStuffingMock, studyEngineMock } = loadSubject({
        stuffContext: async () => ({ enrichedDescription: 'enriched task description' }),
      });
      const task = makeTask({
        provider: 'openrouter',
        model: 'qwen/qwen3-coder:free',
        metadata: {
          context_files: ['C:/repo/a.js', 'C:/repo/b.js'],
          context_budget: 12345,
        },
      });

      const result = await mod.enrichTaskDescription(task);

      expect(result).toBe('enriched task description');
      expect(contextStuffingMock.stuffContext).toHaveBeenCalledWith({
        contextFiles: ['C:/repo/a.js', 'C:/repo/b.js'],
        workingDirectory: 'C:/repo',
        taskDescription: 'Write comprehensive tests',
        provider: 'openrouter',
        model: 'qwen/qwen3-coder:free',
        contextBudget: 12345,
      });
      expect(studyEngineMock.applyStudyContextPrompt).toHaveBeenCalledWith('enriched task description', {
        context_files: ['C:/repo/a.js', 'C:/repo/b.js'],
        context_budget: 12345,
      });
    });

    it('appends study context when no context stuffing occurs', async () => {
      const { mod, contextStuffingMock } = loadSubject({
        applyStudyContextPrompt: vi.fn((taskDescription, metadata) => `${taskDescription}\n\n${metadata.study_context_prompt}`),
      });
      const task = makeTask({
        provider: 'anthropic',
        metadata: JSON.stringify({
          study_context_prompt: 'Study context: start with the task lifecycle flow.',
        }),
      });

      const result = await mod.enrichTaskDescription(task);

      expect(result).toBe('Write comprehensive tests\n\nStudy context: start with the task lifecycle flow.');
      expect(contextStuffingMock.stuffContext).not.toHaveBeenCalled();
    });
  });

  describe('init', () => {
    it('updates only the dependencies provided on repeated init calls', async () => {
      const { mod } = loadSubject();
      const task = makeTask();
      const depsA = makeDeps([task]);
      const depsB = makeDeps();
      const provider = makeProvider({
        submit: vi.fn(async () => ({ output: 'done' })),
      });

      mod.init(depsA);
      mod.init({ processQueue: depsB.processQueue });
      await mod.executeApiProvider(task, provider);

      expect(depsA.db.updateTaskStatus).toHaveBeenCalled();
      expect(depsA.dashboard.notifyTaskUpdated).toHaveBeenCalled();
      expect(depsA.apiAbortControllers.has(task.id)).toBe(false);
      expect(depsA.processQueue).not.toHaveBeenCalled();
      expect(depsB.processQueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeApiProvider', () => {
    it('completes non-streaming tasks, records usage, and tracks quota quotas', async () => {
      const { mod, contextStuffingMock } = loadSubject({
        stuffContext: async () => ({ enrichedDescription: 'ENRICHED TASK' }),
      });
      const task = makeTask({
        model: 'qwen/qwen3-coder:free',
        metadata: JSON.stringify({
          context_files: ['C:/repo/server/providers/execute-api.js'],
          context_budget: 9999,
        }),
      });
      const deps = makeDeps([task]);
      const tracker = {
        recordUsage: vi.fn(),
        recordLatency: vi.fn(),
        recordRateLimit: vi.fn(),
      };
      const provider = makeProvider({
        name: 'openrouter',
        submit: vi.fn(async () => ({
          output: 'final output',
          usage: { tokens: 321, prompt_tokens: 200, completion_tokens: 121 },
        })),
      });

      mod.init(deps);
      mod.setFreeQuotaTracker(() => tracker);
      await mod.executeApiProvider(task, provider);

      expect(contextStuffingMock.stuffContext).toHaveBeenCalledTimes(1);
      expect(provider.submit).toHaveBeenCalledWith(
        'ENRICHED TASK',
        'qwen/qwen3-coder:free',
        expect.objectContaining({
          timeout: 30,
          maxTokens: 4096,
          signal: expect.any(Object),
        })
      );
      expect(deps.readTask(task.id)).toMatchObject({
        status: 'completed',
        output: 'final output',
      });
      expect(deps.readTask(task.id).completed_at).toEqual(expect.any(String));
      expect(deps.db.recordUsage).toHaveBeenCalledWith(
        task.id,
        'openrouter',
        'qwen/qwen3-coder:free',
        { tokens: 321, prompt_tokens: 200, completion_tokens: 121 }
      );
      expect(tracker.recordUsage).toHaveBeenCalledWith('openrouter', 321);
      expect(tracker.recordLatency).toHaveBeenCalledWith('openrouter', expect.any(Number));
      expect(tracker.recordRateLimit).not.toHaveBeenCalled();
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(2);
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
      expect(deps.apiAbortControllers.has(task.id)).toBe(false);
    });

    it('uses an enriched task clone without mutating the original task object', async () => {
      const { mod } = loadSubject({
        stuffContext: async () => ({ enrichedDescription: 'ENRICHED TASK' }),
      });
      const task = makeTask({
        metadata: JSON.stringify({
          context_files: ['C:/repo/a.js'],
        }),
      });
      const originalDescription = task.task_description;
      const deps = makeDeps([task]);
      const provider = makeProvider({
        submit: vi.fn(async () => ({ output: 'ok' })),
      });

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(task.task_description).toBe(originalDescription);
      expect(provider.submit).toHaveBeenCalledWith(
        'ENRICHED TASK',
        null,
        expect.objectContaining({
          timeout: 30,
          maxTokens: 4096,
          signal: expect.any(Object),
        }),
      );
    });

    it('falls back to openrouter role models when task.model is null', async () => {
      const modelRolesMock = {
        getModelForRole: vi.fn((provider, role) => {
          const roleMap = {
            default: 'minimax/minimax-m2.5:free',
            fallback: 'qwen/qwen3-coder:free',
            balanced: null,
            fast: null,
            quality: null,
          };
          return roleMap[role];
        }),
      };
      const { mod } = loadSubject({ modelRoles: modelRolesMock });
      const task = makeTask({
        model: null,
        metadata: { fallbackModels: ['custom/openrouter-fallback:free'] },
      });
      const deps = makeDeps([task]);
      const provider = makeProvider({
        submit: vi.fn(async () => ({
          output: 'selected from role',
          usage: { tokens: 12, prompt_tokens: 8, completion_tokens: 4 },
        })),
      });

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(provider.submit).toHaveBeenCalledWith(
        'Write comprehensive tests',
        'custom/openrouter-fallback:free',
        expect.objectContaining({
          fallbackModels: [
            'custom/openrouter-fallback:free',
            'minimax/minimax-m2.5:free',
            'qwen/qwen3-coder:free',
          ],
        }),
      );
      expect(modelRolesMock.getModelForRole).toHaveBeenCalledTimes(5);
      expect(deps.readTask(task.id)).toMatchObject({
        status: 'completed',
        model: 'custom/openrouter-fallback:free',
      });
    });

    it('adds scored free openrouter fallback models to openrouter fallback list', async () => {
      const modelRolesMock = {
        getModelForRole: vi.fn((provider, role) => {
          const roleMap = {
            default: null,
            fallback: null,
            balanced: null,
            fast: null,
            quality: null,
          };
          return roleMap[role];
        }),
      };
      const providerModelScoresMock = {
        init: vi.fn(),
        getTopModelScores: vi.fn(() => [
          { model_name: 'top/paid:premium', metadata_json: JSON.stringify({ free: false }) },
          { model_name: 'top/fast:free', metadata_json: JSON.stringify({ free: false }) },
          { model_name: 'top/scored:free', metadata_json: '{}' },
        ]),
      };
      const { mod } = loadSubject({
        modelRoles: modelRolesMock,
        providerModelScores: providerModelScoresMock,
      });
      const task = makeTask({
        model: null,
        metadata: { fallbackModels: ['custom/openrouter-fallback:free'] },
      });
      const deps = makeDeps([task]);
      deps.db.prepare = vi.fn();
      const provider = makeProvider({
        submit: vi.fn(async () => ({
          output: 'selected from role',
          usage: { tokens: 12, prompt_tokens: 8, completion_tokens: 4 },
        })),
      });

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(provider.submit).toHaveBeenCalledWith(
        'Write comprehensive tests',
        'custom/openrouter-fallback:free',
        expect.objectContaining({
          fallbackModels: [
            'custom/openrouter-fallback:free',
            'top/fast:free',
            'top/scored:free',
          ],
        }),
      );
      expect(providerModelScoresMock.getTopModelScores).toHaveBeenCalledWith(
        'openrouter',
        expect.objectContaining({
          rateLimited: false,
          minScore: 0,
          limit: 8,
        }),
      );
      expect(modelRolesMock.getModelForRole).toHaveBeenCalledTimes(5);
      expect(deps.readTask(task.id)).toMatchObject({
        status: 'completed',
        model: 'custom/openrouter-fallback:free',
      });
    });

    it('prioritizes parser-capable openrouter fallback models for JSON-mode tasks', async () => {
      const modelRolesMock = {
        getModelForRole: vi.fn((provider, role) => {
          const roleMap = {
            default: null,
            fallback: null,
            balanced: null,
            fast: null,
            quality: null,
          };
          return roleMap[role];
        }),
      };
      const providerModelScoresMock = {
        init: vi.fn(),
        getTopModelScores: vi.fn(() => [
          { model_name: 'top/no-parser:free', metadata_json: JSON.stringify({ free: true, supported_parameters: ['tools'] }) },
          { model_name: 'top/parser:free', metadata_json: JSON.stringify({ free: true, supported_parameters: ['response_format'] }) },
        ]),
      };
      const { mod } = loadSubject({
        modelRoles: modelRolesMock,
        providerModelScores: providerModelScoresMock,
      });
      const task = makeTask({
        model: null,
        metadata: { response_format: 'json_object', fallbackModels: ['custom/openrouter-fallback:free'] },
      });
      const deps = makeDeps([task]);
      deps.db.prepare = vi.fn();
      const provider = makeProvider({
        submit: vi.fn(async () => ({
          output: 'selected from role',
          usage: { tokens: 12, prompt_tokens: 8, completion_tokens: 4 },
        })),
      });

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(provider.submit).toHaveBeenCalledWith(
        'Write comprehensive tests',
        'custom/openrouter-fallback:free',
        expect.objectContaining({
          fallbackModels: [
            'custom/openrouter-fallback:free',
            'top/parser:free',
            'top/no-parser:free',
          ],
        }),
      );
      expect(providerModelScoresMock.getTopModelScores).toHaveBeenCalledWith(
        'openrouter',
        expect.objectContaining({
          rateLimited: false,
          minScore: 0,
          limit: 8,
        }),
      );
      expect(modelRolesMock.getModelForRole).toHaveBeenCalledTimes(5);
    });

    it('uses submitStream for streaming providers and forwards chunks to the stream store and dashboard', async () => {
      const { mod } = loadSubject();
      const task = makeTask({
        provider: 'groq',
        timeout_minutes: 12,
      });
      const deps = makeDeps([task]);
      const provider = makeProvider({
        name: 'groq',
        supportsStreaming: true,
        submitStream: vi.fn(async (description, model, options) => {
          options.onChunk('Hello');
          options.onChunk(' world');
          return {
            output: 'Hello world',
            usage: { tokens: 5 },
          };
        }),
      });

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(provider.submitStream).toHaveBeenCalledWith(
        'Write comprehensive tests',
        null,
        expect.objectContaining({
          timeout: 12,
          maxTokens: 4096,
          signal: expect.any(Object),
          onChunk: expect.any(Function),
        })
      );
      expect(deps.db.getOrCreateTaskStream).toHaveBeenCalledWith(task.id, 'output');
      expect(deps.db.addStreamChunk).toHaveBeenNthCalledWith(1, `${task.id}:output`, 'Hello', 'stdout');
      expect(deps.db.addStreamChunk).toHaveBeenNthCalledWith(2, `${task.id}:output`, ' world', 'stdout');
      expect(deps.readStream(task.id)).toEqual([
        { token: 'Hello', streamType: 'stdout' },
        { token: ' world', streamType: 'stdout' },
      ]);
      expect(deps.dashboard.notifyTaskOutput).toHaveBeenNthCalledWith(1, task.id, 'Hello');
      expect(deps.dashboard.notifyTaskOutput).toHaveBeenNthCalledWith(2, task.id, ' world');
      expect(deps.readTask(task.id)).toMatchObject({
        status: 'completed',
        output: 'Hello world',
      });
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
    });

    it('skips the completion update when the abort signal is set before result handling', async () => {
      const { mod } = loadSubject();
      const task = makeTask();
      const deps = makeDeps([task]);
      const provider = makeProvider({
        submit: vi.fn(async () => {
          deps.apiAbortControllers.get(task.id).abort();
          return { output: 'ignored after abort' };
        }),
      });

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(deps.readTask(task.id)).toMatchObject({ status: 'running' });
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(1);
      expect(deps.processQueue).not.toHaveBeenCalled();
      expect(deps.apiAbortControllers.has(task.id)).toBe(false);
    });

    it('skips the failure update when an in-flight submit is aborted', async () => {
      const { mod } = loadSubject();
      const task = makeTask();
      const deps = makeDeps([task]);
      const abortError = Object.assign(new Error('cancelled by user'), { name: 'AbortError' });
      let submitReady;
      const ready = new Promise((resolve) => {
        submitReady = resolve;
      });
      const provider = makeProvider({
        submit: vi.fn((description, model, options) => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(abortError), { once: true });
          submitReady();
        })),
      });

      mod.init(deps);
      const execution = mod.executeApiProvider(task, provider);

      expect(deps.apiAbortControllers.has(task.id)).toBe(true);
      await ready;
      deps.apiAbortControllers.get(task.id).abort();
      await execution;

      expect(deps.readTask(task.id)).toMatchObject({ status: 'running' });
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(1);
      expect(deps.processQueue).not.toHaveBeenCalled();
      expect(deps.apiAbortControllers.has(task.id)).toBe(false);
    });

    it('does not overwrite a task whose status changed during execution', async () => {
      const { mod } = loadSubject();
      const task = makeTask();
      const deps = makeDeps([task]);
      const provider = makeProvider({
        submit: vi.fn(async () => {
          deps.db.updateTaskStatus(task.id, 'cancelled', { completed_at: 'external-change' });
          return { output: 'late output' };
        }),
      });

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(deps.readTask(task.id)).toMatchObject({
        status: 'cancelled',
        completed_at: 'external-change',
      });
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(1);
      expect(deps.processQueue).not.toHaveBeenCalled();
    });

    it('fails the task immediately when context stuffing exceeds the provider budget', async () => {
      const { mod, contextStuffingMock } = loadSubject({
        stuffContext: async () => {
          throw new Error('Context too large: 3 file(s), exceeds budget');
        },
      });
      const task = makeTask({
        metadata: JSON.stringify({
          context_files: ['C:/repo/a.js'],
        }),
      });
      const deps = makeDeps([task]);
      const provider = makeProvider();

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(contextStuffingMock.stuffContext).toHaveBeenCalledTimes(1);
      expect(provider.submit).not.toHaveBeenCalled();
      expect(deps.readTask(task.id)).toMatchObject({
        status: 'failed',
        error_output: 'Context too large: 3 file(s), exceeds budget',
      });
      expect(deps.readTask(task.id).completed_at).toEqual(expect.any(String));
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(2);
      expect(deps.processQueue).not.toHaveBeenCalled();
      expect(deps.apiAbortControllers.has(task.id)).toBe(false);
    });

    it('falls back to the original description when context stuffing fails for non-budget reasons', async () => {
      const { mod, loggerInstance } = loadSubject({
        stuffContext: async () => {
          throw new Error('filesystem unavailable');
        },
      });
      const task = makeTask({
        metadata: JSON.stringify({
          context_files: ['C:/repo/a.js'],
        }),
      });
      const deps = makeDeps([task]);
      const provider = makeProvider({
        submit: vi.fn(async () => ({ output: 'used original description' })),
      });

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(provider.submit).toHaveBeenCalledWith(
        'Write comprehensive tests',
        null,
        expect.objectContaining({
          timeout: 30,
          maxTokens: 4096,
        })
      );
      expect(loggerInstance.debug).toHaveBeenCalledWith(
        expect.stringContaining(`Context stuffing failed for task ${task.id}`),
      );
      expect(deps.readTask(task.id)).toMatchObject({
        status: 'completed',
        output: 'used original description',
      });
    });

    it('records rate limits on repeated 429 failures and drains the queue after failure', async () => {
      const { mod, sanitizeMock } = loadSubject();
      const task = makeTask();
      const deps = makeDeps([task]);
      const tracker = {
        recordUsage: vi.fn(),
        recordLatency: vi.fn(),
        recordRateLimit: vi.fn(),
      };
      const providerError = Object.assign(
        new Error('API error (429): rate_limit retry_after_seconds=42'),
        { status: 429 }
      );
      const provider = makeProvider({
        name: 'openrouter',
        submit: vi.fn(async () => {
          throw providerError;
        }),
      });
      const timeoutStub = stubImmediateTimeouts();

      mod.init(deps);
      mod.setFreeQuotaTracker(() => tracker);

      try {
        await mod.executeApiProvider(task, provider);
      } finally {
        timeoutStub.restore();
      }

      expect(provider.submit).toHaveBeenCalledTimes(3);
      expect(timeoutStub.delays).toEqual([42000, 42000]);
      expect(sanitizeMock.redactSecrets).toHaveBeenCalledWith('API error (429): rate_limit retry_after_seconds=42');
      expect(tracker.recordRateLimit).toHaveBeenCalledWith('openrouter', 42);
      expect(tracker.recordUsage).not.toHaveBeenCalled();
      expect(tracker.recordLatency).not.toHaveBeenCalled();
      expect(deps.readTask(task.id)).toMatchObject({
        status: 'failed',
        output: 'Provider openrouter error: redacted:API error (429): rate_limit retry_after_seconds=42',
      });
      expect(deps.readTask(task.id).completed_at).toEqual(expect.any(String));
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(2);
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
    });

    it('uses parsed header retry-after metadata when tracking provider 429 cooldowns', async () => {
      const { mod } = loadSubject();
      const task = makeTask();
      const deps = makeDeps([task]);
      const tracker = {
        recordUsage: vi.fn(),
        recordLatency: vi.fn(),
        recordRateLimit: vi.fn(),
      };
      const providerError = Object.assign(
        new Error('OpenRouter API error'),
        {
          status: 429,
          headers: {
            get: (name) => (name === 'Retry-After' || name === 'retry-after' ? '24' : null),
          },
        }
      );
      const provider = makeProvider({
        name: 'openrouter',
        submit: vi.fn(async () => {
          throw providerError;
        }),
      });
      const timeoutStub = stubImmediateTimeouts();

      mod.init(deps);
      mod.setFreeQuotaTracker(() => tracker);

      try {
        await mod.executeApiProvider(task, provider);
      } finally {
        timeoutStub.restore();
      }

      expect(provider.submit).toHaveBeenCalledTimes(3);
      expect(timeoutStub.delays).toEqual([24000, 24000]);
      expect(tracker.recordRateLimit).toHaveBeenCalledWith('openrouter', 24);
    });

    it('requeues ordinary free-provider failures to codex when codex is enabled and healthy', async () => {
      const { mod } = loadSubject();
      const task = makeTask({
        provider: 'openrouter',
        metadata: JSON.stringify({
          smart_routing: true,
        }),
      });
      const deps = makeDeps([task], {
        providerConfigs: { codex: { enabled: true } },
        providerHealth: { codex: true },
      });
      const provider = makeProvider({
        name: 'openrouter',
        submit: vi.fn(async () => {
          throw new Error('free provider failed');
        }),
      });

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(deps.db.requeueTaskAfterAttemptedStart).toHaveBeenCalledWith(task.id, expect.objectContaining({
        provider: 'codex',
        model: null,
        output: null,
        error_output: null,
        metadata: expect.objectContaining({
          smart_routing: true,
          free_provider_retry: true,
        }),
      }));
      expect(deps.readTask(task.id)).toMatchObject({
        status: 'queued',
        provider: 'codex',
      });
      expect(deps.readTask(task.id).metadata).toMatchObject({
        smart_routing: true,
        free_provider_retry: true,
      });
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(2);
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
    });

    it('does not retry ordinary free-provider failures when free_provider_retry is already set', async () => {
      const { mod } = loadSubject();
      const task = makeTask({
        provider: 'openrouter',
        metadata: JSON.stringify({
          free_provider_retry: true,
        }),
      });
      const deps = makeDeps([task], {
        providerConfigs: { codex: { enabled: true } },
        providerHealth: { codex: true },
      });
      const provider = makeProvider({
        name: 'openrouter',
        submit: vi.fn(async () => {
          throw new Error('free provider failed again');
        }),
      });

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(deps.db.updateTask).not.toHaveBeenCalled();
      expect(deps.readTask(task.id)).toMatchObject({
        status: 'failed',
        output: 'Provider openrouter error: redacted:free provider failed again',
      });
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
    });

    it('fails cleanly when the provider does not implement submit', async () => {
      const { mod } = loadSubject();
      const task = makeTask();
      const deps = makeDeps([task]);
      const provider = { name: 'missing-method-provider' };

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(deps.readTask(task.id)).toMatchObject({
        status: 'failed',
        output: 'Provider missing-method-provider error: redacted:provider.submit is not a function',
      });
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
    });

    it('fails cleanly when a streaming provider throws', async () => {
      const { mod } = loadSubject();
      const task = makeTask({ provider: 'groq' });
      const deps = makeDeps([task]);
      const provider = makeProvider({
        name: 'groq',
        supportsStreaming: true,
        submitStream: vi.fn(async () => {
          throw new Error('stream disconnected');
        }),
      });

      mod.init(deps);
      await mod.executeApiProvider(task, provider);

      expect(deps.readTask(task.id)).toMatchObject({
        status: 'failed',
        output: 'Provider groq error: redacted:stream disconnected',
      });
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(2);
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
    });
  });
});
