'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TEST_MODELS } = require('./test-helpers');

const SUBJECT_PATH = require.resolve('../providers/execution');
const EXECUTE_API_PATH = require.resolve('../providers/execute-api');
const EXECUTE_OLLAMA_PATH = require.resolve('../providers/execute-ollama');
const EXECUTE_CLI_PATH = require.resolve('../providers/execute-cli');
const AGENTIC_CAPABILITY_PATH = require.resolve('../providers/agentic-capability');
const OLLAMA_TOOLS_PATH = require.resolve('../providers/ollama-tools');
const GIT_SAFETY_PATH = require.resolve('../providers/agentic-git-safety');
const OLLAMA_CHAT_PATH = require.resolve('../providers/adapters/ollama-chat');
const OPENAI_CHAT_PATH = require.resolve('../providers/adapters/openai-chat');
const GOOGLE_CHAT_PATH = require.resolve('../providers/adapters/google-chat');
const LOGGER_PATH = require.resolve('../logger');
const CONFIG_PATH = require.resolve('../config');
const PROVIDER_CONFIG_PATH = require.resolve('../providers/config');
const OLLAMA_SHARED_PATH = require.resolve('../providers/ollama-shared');
const REGISTRY_PATH = require.resolve('../models/registry');
const MODEL_ROLES_PATH = require.resolve('../db/model-roles');
const ROUTING_CORE_PATH = require.resolve('../db/provider/routing-core');
const PROVIDER_MODEL_SCORES_PATH = require.resolve('../db/provider/model-scores');
const OLLAMA_AGENTIC_PATH = require.resolve('../providers/ollama-agentic');
const HOST_MUTEX_PATH = require.resolve('../providers/host-mutex');

const TRACKED_CACHE_PATHS = [
  SUBJECT_PATH,
  EXECUTE_API_PATH,
  EXECUTE_OLLAMA_PATH,
  EXECUTE_CLI_PATH,
  AGENTIC_CAPABILITY_PATH,
  OLLAMA_TOOLS_PATH,
  GIT_SAFETY_PATH,
  OLLAMA_CHAT_PATH,
  OPENAI_CHAT_PATH,
  GOOGLE_CHAT_PATH,
  LOGGER_PATH,
  CONFIG_PATH,
  PROVIDER_CONFIG_PATH,
  OLLAMA_SHARED_PATH,
  REGISTRY_PATH,
  MODEL_ROLES_PATH,
  ROUTING_CORE_PATH,
  PROVIDER_MODEL_SCORES_PATH,
  OLLAMA_AGENTIC_PATH,
  HOST_MUTEX_PATH,
];

const ORIGINAL_CACHE_ENTRIES = new Map(
  TRACKED_CACHE_PATHS.map((resolvedPath) => [resolvedPath, require.cache[resolvedPath]])
);

function installMock(resolvedPath, exportsValue) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsValue,
  };
}

function restoreModuleCache() {
  for (const [resolvedPath, originalEntry] of ORIGINAL_CACHE_ENTRIES.entries()) {
    if (originalEntry) require.cache[resolvedPath] = originalEntry;
    else delete require.cache[resolvedPath];
  }
}

function createWorkerCtor(messages) {
  let index = 0;
  return function FakeWorker() {
    const emitter = new EventEmitter();
    const message = messages[index++];
    this.postMessage = vi.fn();
    this.terminate = vi.fn();
    this.on = (eventName, handler) => emitter.on(eventName, handler);
    setImmediate(() => emitter.emit('message', message));
  };
}

function createDeferredWorkerControl() {
  const instances = [];
  function WorkerCtor() {
    const emitter = new EventEmitter();
    this.postMessage = vi.fn();
    this.terminate = vi.fn(() => {
      setImmediate(() => emitter.emit('exit', 1));
    });
    this.on = (eventName, handler) => emitter.on(eventName, handler);
    this.once = (eventName, handler) => emitter.once(eventName, handler);
    this.removeAllListeners = (eventName) => emitter.removeAllListeners(eventName);
    instances.push({
      emitMessage: (msg) => emitter.emit('message', msg),
      emitExit: (code = 0) => emitter.emit('exit', code),
      worker: this,
    });
  }
  return {
    WorkerCtor,
    latest() {
      return instances[instances.length - 1];
    },
  };
}

function loadSubject(overrides = {}) {
  const loggerInstance = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const loggerMock = {
    child: vi.fn(() => loggerInstance),
  };
  const configMock = {
    get: vi.fn((key) => {
      const defaults = {
        ollama_model: TEST_MODELS.DEFAULT,
        ollama_agentic_enabled: '1',
        ollama_host: 'http://localhost:11434',
        agentic_max_iterations: '25',
        agentic_command_mode: 'unrestricted',
        agentic_command_allowlist: '',
        agentic_git_safety: 'on',
      };
      return defaults[key] ?? null;
    }),
    getApiKey: vi.fn(() => null),
  };
  const gitSafetyMock = {
    captureSnapshot: vi.fn(() => null),
    checkAndRevert: vi.fn(() => ({ report: '' })),
    revertScopedChanges: vi.fn(() => ({ reverted: [], kept: [], report: '' })),
    serializeSnapshot: vi.fn((snapshot, workingDir) => (snapshot ? {
      isGitRepo: snapshot.isGitRepo === true,
      _snapshotFailed: snapshot._snapshotFailed === true,
      dirtyFiles: Array.from(snapshot.dirtyFiles || []),
      untrackedFiles: Array.from(snapshot.untrackedFiles || []),
      working_directory: workingDir,
    } : null)),
  };
  const executeApiMock = {
    init: vi.fn(),
    executeApiProvider: vi.fn(),
  };
  const executeOllamaMock = {
    init: vi.fn(),
    estimateRequiredContext: vi.fn(),
    executeOllamaTask: vi.fn(async () => ({ legacy: true })),
  };
  const executeCliMock = {
    init: vi.fn(),
    buildAiderOllamaCommand: vi.fn(),
    buildClaudeCliCommand: vi.fn(),
    buildCodexCommand: vi.fn(),
    spawnAndTrackProcess: vi.fn(),
  };
  const capabilityMock = {
    init: vi.fn(),
    isAgenticCapable: vi.fn(() => ({ capable: true, reason: 'ok' })),
    needsPromptInjection: vi.fn(() => false),
  };
  const providerConfigMock = {
    resolveOllamaTuning: vi.fn(() => ({
      temperature: 0.3,
      numCtx: 8192,
      numPredict: 256,
      topP: 0.9,
      topK: 40,
      repeatPenalty: 1.1,
    })),
    resolveSystemPrompt: vi.fn(() => 'base prompt'),
  };
  const ollamaSharedMock = {
    hasModelOnAnyHost: vi.fn(() => true),
    findBestAvailableModel: vi.fn(() => TEST_MODELS.DEFAULT),
    resolveOllamaModel: vi.fn((task) => task.model || TEST_MODELS.DEFAULT),
  };
  const registryMock = {
    selectBestApprovedModel: vi.fn(() => null),
  };
  const modelRolesMock = overrides.modelRolesMock || {
    getModelForRole: vi.fn(() => null),
  };
  const providerModelScoresMock = overrides.providerModelScoresMock || {
    init: vi.fn(),
    getTopModelScores: vi.fn(() => []),
    recordModelTaskOutcome: vi.fn(),
  };

  installMock(LOGGER_PATH, loggerMock);
  installMock(CONFIG_PATH, configMock);
  installMock(GIT_SAFETY_PATH, gitSafetyMock);
  installMock(EXECUTE_API_PATH, executeApiMock);
  installMock(EXECUTE_OLLAMA_PATH, executeOllamaMock);
  installMock(EXECUTE_CLI_PATH, executeCliMock);
  installMock(AGENTIC_CAPABILITY_PATH, capabilityMock);
  installMock(OLLAMA_TOOLS_PATH, { createToolExecutor: vi.fn(), TOOL_DEFINITIONS: [] });
  installMock(OLLAMA_CHAT_PATH, {});
  installMock(OPENAI_CHAT_PATH, {});
  installMock(GOOGLE_CHAT_PATH, {});
  installMock(PROVIDER_CONFIG_PATH, providerConfigMock);
  installMock(OLLAMA_SHARED_PATH, ollamaSharedMock);
  installMock(REGISTRY_PATH, registryMock);
  installMock(MODEL_ROLES_PATH, modelRolesMock);
  installMock(ROUTING_CORE_PATH, { recordProviderOutcome: vi.fn() });
  installMock(PROVIDER_MODEL_SCORES_PATH, providerModelScoresMock);
  installMock(OLLAMA_AGENTIC_PATH, { runAgenticLoop: vi.fn() });
  installMock(HOST_MUTEX_PATH, overrides.hostMutexMock || { acquireHostLock: vi.fn(async () => vi.fn()) });

  delete require.cache[SUBJECT_PATH];

  return {
    mod: require('../providers/execution'),
    loggerInstance,
    configMock,
    gitSafetyMock,
    executeApiMock,
    executeOllamaMock,
    capabilityMock,
    providerConfigMock,
    ollamaSharedMock,
    registryMock,
    modelRolesMock,
    providerModelScoresMock,
    ...overrides,
  };
}

function buildWorkerConfig(entry) {
  return {
    adapterType: 'openai',
    adapterOptions: { provider: entry.provider, model: entry.model || 'default' },
    systemPrompt: 'test',
    taskPrompt: 'do the thing',
    workingDir: 'C:/repo',
    timeoutMs: 30000,
    maxIterations: 10,
    contextBudget: 16000,
    promptInjectedTools: false,
    commandMode: 'unrestricted',
    commandAllowlist: [],
  };
}

let tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-execution-policy-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(dir, relPath, content) {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreModuleCache();
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tempDirs = [];
});

describe('providers/execution agentic fixes', () => {
  it('passes the task description into git revert checks between fallback attempts', async () => {
    const { mod, gitSafetyMock } = loadSubject();
    gitSafetyMock.captureSnapshot.mockReturnValue({ isGitRepo: true });

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        { type: 'error', message: '429 Too Many Requests' },
        { type: 'result', output: 'ok', toolLog: [], tokenUsage: {}, changedFiles: [], iterations: 1 },
      ])
    );

    const task = {
      id: 'task-fallback',
      task_description: 'Preserve this description',
      working_directory: 'C:/repo',
    };
    const chain = [
      { provider: 'cerebras', model: 'fast-model' },
      { provider: 'openrouter', model: 'fallback-model' },
    ];

    await mod.executeWithFallback(task, chain, buildWorkerConfig, {});

    expect(gitSafetyMock.checkAndRevert).toHaveBeenCalled();
    expect(gitSafetyMock.checkAndRevert.mock.calls.every(([, , description]) => description === task.task_description)).toBe(true);
  });

  it('falls back when a free agentic provider returns missing tool evidence', async () => {
    const { mod } = loadSubject();

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: 'Task stopped: model answered without using required repository tools.',
          stopReason: 'missing_tool_evidence',
          toolLog: [],
          tokenUsage: { prompt_tokens: 20, completion_tokens: 10 },
          changedFiles: [],
          iterations: 2,
        },
        {
          type: 'result',
          output: 'Verified from package.json.',
          stopReason: 'model_finished',
          toolLog: [{ name: 'read_file', error: false }],
          tokenUsage: { prompt_tokens: 30, completion_tokens: 12 },
          changedFiles: [],
          iterations: 1,
        },
      ])
    );

    const task = {
      id: 'task-missing-tool-evidence-fallback',
      task_description: 'Inspect repository configuration and report facts only.',
      working_directory: 'C:/repo',
      metadata: JSON.stringify({ plan_task_title: 'Verify repository configuration' }),
    };
    const chain = [
      { provider: 'cerebras', model: 'qwen-3-coder' },
      { provider: 'google-ai', model: 'gemini-2.5-flash' },
    ];

    const result = await mod.executeWithFallback(task, chain, buildWorkerConfig, {});

    expect(result.provider).toBe('google-ai');
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.chainPosition).toBe(2);
    expect(result.output).toBe('Verified from package.json.');
  });

  it('falls back when a free agentic provider returns an empty toolless result', async () => {
    const { mod } = loadSubject();

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: '',
          stopReason: 'model_finished',
          toolLog: [],
          tokenUsage: { prompt_tokens: 20, completion_tokens: 0 },
          changedFiles: [],
          iterations: 2,
        },
        {
          type: 'result',
          output: 'Verified from package.json.',
          stopReason: 'model_finished',
          toolLog: [{ name: 'read_file', error: false }],
          tokenUsage: { prompt_tokens: 30, completion_tokens: 12 },
          changedFiles: [],
          iterations: 1,
        },
      ])
    );

    const task = {
      id: 'task-empty-result-fallback',
      task_description: 'Inspect repository configuration and report facts only.',
      working_directory: 'C:/repo',
      metadata: JSON.stringify({ plan_task_title: 'Verify repository configuration' }),
    };
    const chain = [
      { provider: 'cerebras', model: 'qwen-3-coder' },
      { provider: 'google-ai', model: 'gemini-2.5-flash' },
    ];

    const result = await mod.executeWithFallback(task, chain, buildWorkerConfig, {});

    expect(result.provider).toBe('google-ai');
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.chainPosition).toBe(2);
    expect(result.output).toBe('Verified from package.json.');
  });

  it('falls back when a free agentic provider returns tool logs without a final answer', async () => {
    const { mod } = loadSubject();

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: 'Task stopped: model did not produce a final answer after repository tool use.\n\n--- Tool Execution Log (1 calls) ---\n[1] list_directory({"path":"."}) -> OK',
          stopReason: 'empty_final_output',
          toolLog: [{ name: 'list_directory', error: false }],
          tokenUsage: { prompt_tokens: 20, completion_tokens: 0 },
          changedFiles: [],
          iterations: 3,
        },
        {
          type: 'result',
          output: 'Generated the requested Markdown plan.',
          stopReason: 'model_finished',
          toolLog: [{ name: 'read_file', error: false }],
          tokenUsage: { prompt_tokens: 30, completion_tokens: 12 },
          changedFiles: [],
          iterations: 1,
        },
      ])
    );

    const task = {
      id: 'task-empty-final-output-fallback',
      task_description: 'Generate an execution plan for DLPhone.',
      working_directory: 'C:/repo',
      metadata: JSON.stringify({ plan_task_title: 'Plan DLPhone typed failure coverage' }),
    };
    const chain = [
      { provider: 'cerebras', model: 'qwen-3-coder' },
      { provider: 'google-ai', model: 'gemini-2.5-flash' },
    ];

    const result = await mod.executeWithFallback(task, chain, buildWorkerConfig, {});

    expect(result.provider).toBe('google-ai');
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.chainPosition).toBe(2);
    expect(result.output).toBe('Generated the requested Markdown plan.');
  });

  it('falls back when an OpenRouter agentic attempt produces no first response', async () => {
    vi.useFakeTimers();

    const { mod, configMock } = loadSubject();
    configMock.get.mockImplementation((key) => (
      key === 'openrouter_agentic_first_response_timeout_seconds' ? '1' : null
    ));

    const runningProcesses = new Map();
    runningProcesses.stallAttempts = new Map();
    mod.init({ runningProcesses });

    const workers = [];
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker() {
      const emitter = new EventEmitter();
      const index = workers.length;
      this.postMessage = vi.fn((msg) => {
        if (index === 0 && msg?.type === 'abort') {
          queueMicrotask(() => emitter.emit('message', { type: 'error', message: 'aborted' }));
        }
      });
      this.terminate = vi.fn(() => Promise.resolve(1));
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      workers.push({ emitter, worker: this });

      if (index === 1) {
        queueMicrotask(() => emitter.emit('message', {
          type: 'result',
          output: 'second provider completed',
          toolLog: [],
          tokenUsage: {},
          changedFiles: [],
          iterations: 1,
        }));
      }
    });

    const task = {
      id: 'task-openrouter-first-response-timeout',
      task_description: 'Read only inspect',
      working_directory: 'C:/repo',
    };
    const chain = [
      { provider: 'openrouter', model: 'silent/free:free' },
      { provider: 'cerebras', model: 'fast-model' },
    ];

    const resultPromise = mod.executeWithFallback(task, chain, buildWorkerConfig, {});

    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(workers).toHaveLength(2);
    expect(workers[0].worker.postMessage).toHaveBeenCalledWith({ type: 'abort' });
    expect(result.provider).toBe('cerebras');
    expect(result.output).toBe('second provider completed');
    expect(runningProcesses.has(task.id)).toBe(false);
  });

  it('resolves an omitted OpenRouter template model from the approved registry', async () => {
    const { mod, configMock, registryMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'openrouter' ? 'openrouter-key' : null));
    registryMock.selectBestApprovedModel.mockImplementation((provider) => (
      provider === 'openrouter' ? { model_name: 'minimax/minimax-m2.5:free' } : null
    ));

    const task = {
      id: 'task-openrouter-registry-model',
      provider: 'openrouter',
      model: null,
      task_description: 'Read-only inspect package metadata.',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      metadata: JSON.stringify({ read_only: true }),
    };
    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus: vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch)),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    let workerData;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      workerData = options.workerData;
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      queueMicrotask(() => emitter.emit('message', {
        type: 'result',
        output: 'registry model completed',
        toolLog: [],
        tokenUsage: {},
        changedFiles: [],
        iterations: 1,
      }));
    });

    await mod.executeApiProvider(task, { name: 'openrouter' });

    expect(registryMock.selectBestApprovedModel).toHaveBeenCalledWith('openrouter');
    expect(workerData.adapterOptions).toMatchObject({
      providerName: 'openrouter',
      model: 'minimax/minimax-m2.5:free',
    });
    expect(workerData.taskPrompt).toContain('Read-only completion rule');
    expect(tasks.get(task.id).status).toBe('completed');
  });

  it('resolves an omitted OpenRouter model from the default model role before registry fallback', async () => {
    const modelRolesMock = {
      getModelForRole: vi.fn((provider, role) => (
        provider === 'openrouter' && role === 'default'
          ? 'scouted/default:free'
          : null
      )),
    };
    const { mod, configMock, registryMock } = loadSubject({ modelRolesMock });
    configMock.getApiKey.mockImplementation((provider) => (provider === 'openrouter' ? 'openrouter-key' : null));

    const task = {
      id: 'task-openrouter-role-model',
      provider: 'openrouter',
      model: null,
      task_description: 'Read-only inspect package metadata.',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      metadata: JSON.stringify({ read_only: true }),
    };
    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const next = { ...(tasks.get(taskId) || { id: taskId }), ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus: vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch)),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    let workerData;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      workerData = options.workerData;
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      queueMicrotask(() => emitter.emit('message', {
        type: 'result',
        output: 'role model completed',
        toolLog: [],
        tokenUsage: {},
        changedFiles: [],
        iterations: 1,
      }));
    });

    await mod.executeApiProvider(task, { name: 'openrouter' });

    expect(registryMock.selectBestApprovedModel).not.toHaveBeenCalled();
    expect(workerData.adapterOptions.model).toBe('scouted/default:free');
    expect(tasks.get(task.id).model).toBe('scouted/default:free');
  });

  it('builds an OpenRouter same-provider model fallback chain from model roles', async () => {
    vi.useFakeTimers();
    const modelRolesMock = {
      getModelForRole: vi.fn((provider, role) => {
        if (provider !== 'openrouter') return null;
        if (role === 'fallback') return 'scouted/fallback:free';
        if (role === 'balanced') return 'scouted/balanced:free';
        return null;
      }),
    };
    const { mod, configMock } = loadSubject({ modelRolesMock });
    configMock.getApiKey.mockImplementation((provider) => (provider === 'openrouter' ? 'openrouter-key' : null));
    configMock.get.mockImplementation((key) => (
      key === 'openrouter_agentic_first_response_timeout_seconds' ? '1' : null
    ));

    const task = {
      id: 'task-openrouter-model-fallback',
      provider: 'openrouter',
      model: 'scouted/default:free',
      task_description: 'Read-only inspect.',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      metadata: JSON.stringify({ read_only: true }),
    };
    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const next = { ...(tasks.get(taskId) || { id: taskId }), ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus: vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch)),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    const workerModels = [];
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      const model = options.workerData.adapterOptions.model;
      workerModels.push(model);
      this.postMessage = vi.fn((msg) => {
        if (msg?.type === 'abort') {
          queueMicrotask(() => emitter.emit('message', { type: 'error', message: 'aborted' }));
        }
      });
      this.terminate = vi.fn();
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      if (model === 'scouted/fallback:free') {
        queueMicrotask(() => emitter.emit('message', {
          type: 'result',
          output: 'fallback model completed',
          toolLog: [],
          tokenUsage: {},
          changedFiles: [],
          iterations: 1,
        }));
      }
    });

    const resultPromise = mod.executeApiProvider(task, { name: 'openrouter' });
    await vi.advanceTimersByTimeAsync(1000);
    await resultPromise;

    expect(workerModels).toEqual(['scouted/default:free', 'scouted/fallback:free']);
    expect(tasks.get(task.id).status).toBe('completed');
  });

  it('adds scored openrouter fallback models into the same-provider agentic chain', async () => {
    const modelRolesMock = {
      getModelForRole: vi.fn((provider, role) => {
        if (provider !== 'openrouter') return null;
        if (role === 'fallback') return 'scouted/fallback:free';
        return null;
      }),
    };
    const providerModelScoresMock = {
      init: vi.fn(),
      getTopModelScores: vi.fn(() => [
        { model_name: 'scored/first:free', metadata_json: JSON.stringify({ free: true }) },
      ]),
      recordModelTaskOutcome: vi.fn(),
    };
    const { mod, configMock } = loadSubject({ modelRolesMock, providerModelScoresMock });
    configMock.getApiKey.mockImplementation((provider) => (provider === 'openrouter' ? 'openrouter-key' : null));
    configMock.get.mockImplementation((key) => (
      key === 'openrouter_agentic_first_response_timeout_seconds' ? '1' : null
    ));

    const task = {
      id: 'task-openrouter-model-fallback-scores',
      provider: 'openrouter',
      model: 'scouted/default:free',
      task_description: 'Read-only inspect.',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      metadata: JSON.stringify({ read_only: true }),
    };
    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const next = { ...(tasks.get(taskId) || { id: taskId }), ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
      prepare: vi.fn(),
    };
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus: vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch)),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    const workerModels = [];
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      const model = options.workerData.adapterOptions.model;
      workerModels.push(model);
      this.postMessage = vi.fn();
      this.terminate = vi.fn(() => Promise.resolve(1));
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      if (model === 'scored/first:free') {
        queueMicrotask(() => emitter.emit('message', {
          type: 'result',
          output: 'scored model completed',
          toolLog: [],
          tokenUsage: {},
          changedFiles: [],
          iterations: 1,
        }));
      } else {
        queueMicrotask(() => emitter.emit('message', {
          type: 'error',
          message: '429 Too Many Requests',
        }));
      }
    });

    await mod.executeApiProvider(task, { name: 'openrouter' });

    expect(workerModels).toEqual([
      'scouted/default:free',
      'scouted/fallback:free',
      'scored/first:free',
    ]);
    expect(tasks.get(task.id).status).toBe('completed');
    expect(tasks.get(task.id).model).toBe('scored/first:free');
    expect(providerModelScoresMock.getTopModelScores).toHaveBeenCalledWith(
      'openrouter',
      expect.objectContaining({ rateLimited: false, limit: 8 }),
    );
  });

  it('orders parser-capable openrouter scored models first for JSON-mode agentic tasks', async () => {
    const modelRolesMock = {
      getModelForRole: vi.fn((provider, role) => {
        if (provider !== 'openrouter') return null;
        if (role === 'fallback') return 'scouted/fallback:free';
        return null;
      }),
    };
    const providerModelScoresMock = {
      init: vi.fn(),
      getTopModelScores: vi.fn(() => ([
        { model_name: 'scored/no-parser:free', metadata_json: JSON.stringify({ free: true, supported_parameters: ['tools'] }) },
        { model_name: 'scored/parser:free', metadata_json: JSON.stringify({ free: true, metadata: { supports_response_format: false }, supported_parameters: ['response_format'] }) },
      ])),
      recordModelTaskOutcome: vi.fn(),
    };
    const { mod, configMock } = loadSubject({ modelRolesMock, providerModelScoresMock });
    configMock.getApiKey.mockImplementation((provider) => (provider === 'openrouter' ? 'openrouter-key' : null));
    configMock.get.mockImplementation((key) => (
      key === 'openrouter_agentic_first_response_timeout_seconds' ? '1' : null
    ));

    const task = {
      id: 'task-openrouter-json-parser-ordering',
      provider: 'openrouter',
      model: 'scouted/default:free',
      task_description: 'Read-only inspect.',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      metadata: JSON.stringify({ read_only: true, response_format: 'json_object' }),
    };
    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const next = { ...(tasks.get(taskId) || { id: taskId }), ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
      prepare: vi.fn(),
    };
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus: vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch)),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    const workerModels = [];
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      const model = options.workerData.adapterOptions.model;
      workerModels.push(model);
      this.postMessage = vi.fn();
      this.terminate = vi.fn(() => Promise.resolve(1));
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      if (model === 'scored/parser:free') {
        queueMicrotask(() => emitter.emit('message', {
          type: 'error',
          message: '429 Too Many Requests',
        }));
      } else if (model === 'scored/no-parser:free') {
        queueMicrotask(() => emitter.emit('message', {
          type: 'result',
          output: 'scored no-parser model completed',
          toolLog: [],
          tokenUsage: {},
          changedFiles: [],
          iterations: 1,
        }));
      } else {
        queueMicrotask(() => emitter.emit('message', {
          type: 'error',
          message: '429 Too Many Requests',
        }));
      }
    });

    await mod.executeApiProvider(task, { name: 'openrouter' });

    expect(workerModels).toEqual([
      'scouted/default:free',
      'scouted/fallback:free',
      'scored/parser:free',
      'scored/no-parser:free',
    ]);
    expect(tasks.get(task.id).status).toBe('completed');
  });

  it('requeues no-op ollama-cloud agentic tasks to codex for button-up', async () => {
    const { mod, configMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'ollama-cloud' ? 'cloud-key' : null));

    const task = {
      id: 'task-api-noop-handoff',
      provider: 'ollama-cloud',
      model: null,
      task_description: 'Create tools/validate_unity_host_join_smoke.py',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      metadata: JSON.stringify({
        _routing_chain: [
          { provider: 'ollama-cloud', model: 'kimi-k2:1t' },
          { provider: 'codex' },
        ],
        file_paths: ['tools/validate_unity_host_join_smoke.py'],
      }),
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    };
    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: 'I would create the validator and tests.',
          toolLog: [],
          tokenUsage: { prompt_tokens: 12, completion_tokens: 8 },
          changedFiles: [],
          iterations: 2,
        },
      ])
    );

    await mod.executeApiProvider(task, { name: 'ollama-cloud' });

    const updated = tasks.get(task.id);
    expect(updated.status).toBe('queued');
    expect(updated.provider).toBe('codex');
    expect(updated.model).toBeNull();
    expect(updated.metadata.user_provider_override).toBe(false);
    expect(updated.metadata.provider_selection_locked).toBe(true);
    expect(updated.metadata.provider_selection_lock_reason).toBe('agentic_handoff');
    expect(updated.metadata.agentic_handoff).toBe(true);
    expect(updated.metadata.agentic_handoff_mode).toBe('button_up');
    expect(updated.metadata.agentic_handoff_from).toBe('ollama-cloud');
    expect(updated.metadata.agentic_handoff_to).toBe('codex');
    expect(updated.metadata.fallback_provider).toBe('codex');
    expect(updated.metadata.original_requested_provider).toBe('ollama-cloud');
    expect(updated.metadata.requested_provider).toBe('codex');
    expect(updated.metadata.agentic_handoff_reason).toContain('Agentic no-op');
    expect(safeUpdateTaskStatus).not.toHaveBeenCalledWith(
      task.id,
      'completed',
      expect.anything(),
    );
  });

  it('fails no-op ollama-cloud tasks instead of handing off when provider lane blocks codex', async () => {
    const { mod, configMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'ollama-cloud' ? 'cloud-key' : null));

    const task = {
      id: 'task-api-noop-lane-block',
      provider: 'ollama-cloud',
      model: null,
      task_description: 'Create tools/validate_unity_host_join_smoke.py',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      metadata: JSON.stringify({
        _routing_chain: [
          { provider: 'ollama-cloud', model: 'kimi-k2:1t' },
          { provider: 'codex' },
        ],
        file_paths: ['tools/validate_unity_host_join_smoke.py'],
        provider_lane_policy: {
          expected_provider: 'ollama-cloud',
          allowed_fallback_providers: [],
          enforce_handoffs: true,
        },
      }),
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: 'I would create the validator and tests.',
          toolLog: [],
          tokenUsage: { prompt_tokens: 12, completion_tokens: 8 },
          changedFiles: [],
          iterations: 2,
        },
      ])
    );

    await mod.executeApiProvider(task, { name: 'ollama-cloud' });

    const updated = tasks.get(task.id);
    expect(updated.status).toBe('failed');
    expect(updated.provider).toBe('ollama-cloud');
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      task.id,
      'failed',
      expect.objectContaining({
        exit_code: 1,
      }),
    );
  });

  it('does not requeue read-only openrouter reports that mention forbidden edit verbs', async () => {
    const { mod, configMock, providerModelScoresMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'openrouter' ? 'openrouter-key' : null));

    const task = {
      id: 'task-openrouter-readonly-report',
      provider: 'openrouter',
      model: 'openrouter/free',
      task_description: 'This is read-only: do not edit, create, delete, move, or format any files. Inspect the NetSim repository and report what you find.',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      metadata: JSON.stringify({
        _routing_chain: [
          { provider: 'openrouter', model: 'openrouter/free' },
          { provider: 'codex' },
        ],
        file_paths: ['package.json'],
      }),
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: 'NetSim report: package.json is present.',
          toolLog: [],
          tokenUsage: { prompt_tokens: 12, completion_tokens: 8 },
          changedFiles: [],
          iterations: 1,
        },
      ])
    );

    await mod.executeApiProvider(task, { name: 'openrouter' });

    const updated = tasks.get(task.id);
    expect(updated.status).toBe('completed');
    expect(updated.provider).toBe('openrouter');
    expect(updated.output).toContain('NetSim report');
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      task.id,
      'completed',
      expect.objectContaining({
        exit_code: 0,
        progress_percent: 100,
      }),
    );
    expect(providerModelScoresMock.recordModelTaskOutcome).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openrouter',
      modelName: 'openrouter/free',
      success: true,
      readOnly: true,
      toolCount: 0,
    }));
  });

  it('fails read-only openrouter reports when the agentic loop stops for missing tool evidence', async () => {
    const { mod, configMock, providerModelScoresMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'openrouter' ? 'openrouter-key' : null));

    const task = {
      id: 'task-openrouter-missing-tool-evidence',
      provider: 'openrouter',
      model: 'openrouter/free',
      task_description: 'Read-only inspection. Use repository tools and report facts only.',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([{
        type: 'result',
        output: 'Task stopped: model answered without using required repository tools.',
        stopReason: 'missing_tool_evidence',
        toolLog: [],
        tokenUsage: { prompt_tokens: 12, completion_tokens: 8 },
        changedFiles: [],
        iterations: 2,
      }])
    );

    await mod.executeApiProvider(task, { name: 'openrouter' });

    const updated = tasks.get(task.id);
    expect(updated.status).toBe('failed');
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      task.id,
      'failed',
      expect.objectContaining({
        exit_code: 1,
        error_output: expect.stringContaining('missing_tool_evidence'),
      }),
    );
    expect(safeUpdateTaskStatus).not.toHaveBeenCalledWith(
      task.id,
      'completed',
      expect.anything(),
    );
    expect(providerModelScoresMock.recordModelTaskOutcome).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openrouter',
      modelName: 'openrouter/free',
      success: false,
      stopReason: 'missing_tool_evidence',
    }));
  });

  it('requires repository tool evidence for free cloud providers beyond openrouter', async () => {
    const { mod, configMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'google-ai' ? 'google-key' : null));

    const task = {
      id: 'task-google-tool-evidence',
      provider: 'google-ai',
      model: 'gemini-2.5-flash',
      task_description: 'Inspect the repository and report facts from the tools.',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    let capturedWorkerData = null;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      capturedWorkerData = options.workerData;
      const emitter = new EventEmitter();
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      setImmediate(() => emitter.emit('message', {
        type: 'result',
        output: 'Observed files from repository tools.',
        stopReason: 'model_finished',
        toolLog: [{ name: 'list_directory', error: false }],
        tokenUsage: { prompt_tokens: 12, completion_tokens: 8 },
        changedFiles: [],
        iterations: 1,
      }));
    });

    await mod.executeApiProvider(task, { name: 'google-ai' });

    expect(capturedWorkerData.requireToolUseBeforeFinal).toBe(true);
  });

  it('does not fail explicit verification plan tasks just because no files changed', async () => {
    const { mod, configMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'openrouter' ? 'openrouter-key' : null));

    const task = {
      id: 'task-verify-readonly-plan-title',
      provider: 'openrouter',
      model: 'openrouter/free',
      task_description: [
        'Plan Task 1: Verify LanStartupCoordinator typed failure implementation',
        'Read the implementation and tests, then report whether they match the plan.',
        'Step 5: git commit -m "docs: verify typed lan startup failure reasons implementation"',
        'After making the edits, stop.',
      ].join('\n'),
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      metadata: {
        plan_task_title: 'Verify LanStartupCoordinator typed failure implementation',
        plan_task_number: 1,
      },
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([{
        type: 'result',
        output: 'Verified the implementation from read_file results. No edits were made.',
        stopReason: 'model_finished',
        toolLog: [{ name: 'read_file', error: false }],
        tokenUsage: { prompt_tokens: 12, completion_tokens: 8 },
        changedFiles: [],
        iterations: 1,
      }])
    );

    await mod.executeApiProvider(task, { name: 'openrouter' });

    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      task.id,
      'completed',
      expect.objectContaining({
        exit_code: 0,
      }),
    );
    expect(safeUpdateTaskStatus).not.toHaveBeenCalledWith(
      task.id,
      'failed',
      expect.anything(),
    );
  });

  it('fails read-only openrouter reports when the agentic loop stops for consecutive tool errors', async () => {
    const { mod, configMock, providerModelScoresMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'openrouter' ? 'openrouter-key' : null));

    const task = {
      id: 'task-openrouter-consecutive-tool-errors',
      provider: 'openrouter',
      model: 'openrouter/free',
      task_description: 'Read-only inspection. Use repository tools and report facts only.',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([{
        type: 'result',
        output: 'Task stopped: consecutive errors from read_file after 2 iterations.',
        stopReason: 'consecutive_tool_errors',
        toolLog: [{ name: 'read_file', error: true }],
        tokenUsage: { prompt_tokens: 12, completion_tokens: 8 },
        changedFiles: [],
        iterations: 2,
      }])
    );

    await mod.executeApiProvider(task, { name: 'openrouter' });

    const updated = tasks.get(task.id);
    expect(updated.status).toBe('failed');
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      task.id,
      'failed',
      expect.objectContaining({
        exit_code: 1,
        error_output: expect.stringContaining('consecutive_tool_errors'),
      }),
    );
    expect(safeUpdateTaskStatus).not.toHaveBeenCalledWith(
      task.id,
      'completed',
      expect.anything(),
    );
    expect(providerModelScoresMock.recordModelTaskOutcome).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openrouter',
      modelName: 'openrouter/free',
      success: false,
      stopReason: 'consecutive_tool_errors',
    }));
  });

  it('applies valid ollama-cloud proposal output without a codex apply task', async () => {
    const { mod, configMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'ollama-cloud' ? 'cloud-key' : null));

    const workingDir = makeTempDir();
    const originalTask = 'Create tools/validate_unity_host_join_smoke.py';
    const task = {
      id: 'task-api-proposal-apply',
      provider: 'ollama-cloud',
      model: null,
      task_description: originalTask,
      working_directory: workingDir,
      timeout_minutes: 1,
      metadata: JSON.stringify({
        _routing_chain: [
          { provider: 'ollama-cloud', model: 'kimi-k2:1t' },
          { provider: 'codex' },
        ],
        file_paths: ['tools/validate_unity_host_join_smoke.py'],
        ollama_cloud_repo_write_mode: 'proposal_apply',
        proposal_apply_provider: 'codex',
        agentic_allowed_tools: ['read_file', 'list_directory', 'search_files'],
      }),
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: JSON.stringify({
            file_edits: [
              {
                file: 'tools/validate_unity_host_join_smoke.py',
                operations: [
                  {
                    type: 'create',
                    old_text: '',
                    new_text: 'print("ok")\n',
                  },
                ],
              },
            ],
          }),
          toolLog: [],
          tokenUsage: { prompt_tokens: 20, completion_tokens: 40 },
          changedFiles: [],
          iterations: 1,
        },
      ])
    );

    await mod.executeApiProvider(task, { name: 'ollama-cloud' });

    const updated = tasks.get(task.id);
    expect(updated.status).toBe('completed');
    expect(updated.provider).toBe('ollama-cloud');
    expect(updated.output).toContain('--- Proposal Apply ---');
    expect(updated.files_modified).toEqual(['tools/validate_unity_host_join_smoke.py']);
    expect(fs.readFileSync(path.join(workingDir, 'tools/validate_unity_host_join_smoke.py'), 'utf-8'))
      .toBe('print("ok")\n');
    const completionMetadata = JSON.parse(updated.task_metadata);
    expect(completionMetadata.proposal_apply).toBe(true);
    expect(completionMetadata.proposal_apply_mode).toBe('deterministic');
    expect(completionMetadata.proposal_apply_parse_status).toBe('valid');
    expect(completionMetadata.proposal_compute_output.file_edits).toHaveLength(1);
    expect(completionMetadata.original_task_description).toBe(originalTask);
    expect(completionMetadata.proposal_apply_from).toBe('ollama-cloud');
    expect(completionMetadata.proposal_apply_operation_count).toBe(1);
    expect(safeUpdateTaskStatus).toHaveBeenCalledWith(
      task.id,
      'completed',
      expect.objectContaining({
        exit_code: 0,
        progress_percent: 100,
      }),
    );
  });

  it('applies ollama-cloud proposal replacements across CRLF/LF line-ending differences', async () => {
    const { mod, configMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'ollama-cloud' ? 'cloud-key' : null));

    const workingDir = makeTempDir();
    fs.mkdirSync(path.join(workingDir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(workingDir, 'tools/existing.py'), 'def main():\r\n    return "current"\r\n', 'utf-8');
    const task = {
      id: 'task-api-proposal-apply-eol',
      provider: 'ollama-cloud',
      model: null,
      task_description: 'Update tools/existing.py',
      working_directory: workingDir,
      timeout_minutes: 1,
      metadata: JSON.stringify({
        _routing_chain: [
          { provider: 'ollama-cloud', model: 'kimi-k2:1t' },
          { provider: 'codex' },
        ],
        file_paths: ['tools/existing.py'],
        ollama_cloud_repo_write_mode: 'proposal_apply',
        proposal_apply_provider: 'codex',
        agentic_allowed_tools: ['read_file', 'list_directory', 'search_files'],
      }),
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: JSON.stringify({
            file_edits: [
              {
                file: 'tools/existing.py',
                operations: [
                  {
                    type: 'replace',
                    old_text: 'def main():\n    return "current"\n',
                    new_text: 'def main():\n    return "updated"\n',
                  },
                ],
              },
            ],
          }),
          toolLog: [],
          tokenUsage: { prompt_tokens: 20, completion_tokens: 40 },
          changedFiles: [],
          iterations: 1,
        },
      ])
    );

    await mod.executeApiProvider(task, { name: 'ollama-cloud' });

    const updated = tasks.get(task.id);
    expect(updated.status).toBe('completed');
    expect(updated.provider).toBe('ollama-cloud');
    expect(fs.readFileSync(path.join(workingDir, 'tools/existing.py'), 'utf-8'))
      .toBe('def main():\r\n    return "updated"\r\n');
    const completionMetadata = JSON.parse(updated.task_metadata);
    expect(completionMetadata.proposal_apply_warnings)
      .toContain('tools/existing.py: applied replacement after line-ending normalization');
  });

  it('does not treat factory architect JSON output as repo-write proposal output', async () => {
    const { mod, configMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'ollama-cloud' ? 'cloud-key' : null));

    const workingDir = makeTempDir();
    const task = {
      id: 'task-api-architect-proposal-scope',
      provider: 'ollama-cloud',
      model: null,
      task_description: 'Create an implementation backlog. Return JSON only.',
      working_directory: workingDir,
      timeout_minutes: 1,
      metadata: JSON.stringify({
        _routing_chain: [
          { provider: 'ollama-cloud', model: 'mistral-large-3:675b' },
          { provider: 'codex' },
        ],
        factory_internal: true,
        kind: 'architect_cycle',
        target_project: 'DLPhone',
        ollama_cloud_repo_write_mode: 'proposal_apply',
        proposal_apply_provider: 'codex',
        provider_lane_policy: {
          expected_provider: 'ollama-cloud',
          allowed_fallback_providers: [],
          enforce_handoffs: true,
        },
        agentic_allowed_tools: ['read_file', 'list_directory', 'search_files'],
      }),
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: JSON.stringify({
            reasoning: 'Rank first-run smoke coverage first.',
            backlog: [],
            flags: [],
          }),
          toolLog: [],
          tokenUsage: { prompt_tokens: 20, completion_tokens: 40 },
          changedFiles: [],
          iterations: 1,
        },
      ])
    );

    await mod.executeApiProvider(task, { name: 'ollama-cloud' });

    const updated = tasks.get(task.id);
    expect(updated.status).toBe('completed');
    expect(updated.provider).toBe('ollama-cloud');
    expect(updated.output).toContain('Rank first-run smoke coverage first');
    expect(updated.error_output).toBeUndefined();
  });

  it('falls back to codex proposal apply when exact deterministic apply is unsafe', async () => {
    const { mod, configMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'ollama-cloud' ? 'cloud-key' : null));

    const workingDir = makeTempDir();
    fs.mkdirSync(path.join(workingDir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(workingDir, 'tools/existing.py'), 'print("current")\n', 'utf-8');
    const task = {
      id: 'task-api-proposal-apply-fallback',
      provider: 'ollama-cloud',
      model: null,
      task_description: 'Update tools/existing.py',
      working_directory: workingDir,
      timeout_minutes: 1,
      metadata: JSON.stringify({
        _routing_chain: [
          { provider: 'ollama-cloud', model: 'kimi-k2:1t' },
          { provider: 'codex' },
        ],
        file_paths: ['tools/existing.py'],
        ollama_cloud_repo_write_mode: 'proposal_apply',
        proposal_apply_provider: 'codex',
        agentic_allowed_tools: ['read_file', 'list_directory', 'search_files'],
      }),
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: JSON.stringify({
            file_edits: [
              {
                file: 'tools/existing.py',
                operations: [
                  {
                    type: 'replace',
                    old_text: 'print("missing")\n',
                    new_text: 'print("updated")\n',
                  },
                ],
              },
            ],
          }),
          toolLog: [],
          tokenUsage: { prompt_tokens: 20, completion_tokens: 40 },
          changedFiles: [],
          iterations: 1,
        },
      ])
    );

    await mod.executeApiProvider(task, { name: 'ollama-cloud' });

    const updated = tasks.get(task.id);
    expect(updated.status).toBe('queued');
    expect(updated.provider).toBe('codex');
    expect(updated.metadata.proposal_apply).toBe(true);
    expect(updated.metadata.proposal_apply_mode).toBe('provider_handoff');
    expect(updated.metadata.agentic_handoff_mode).toBe('proposal_apply');
    expect(updated.metadata.proposal_apply_deterministic_apply_failed).toBe(true);
    expect(updated.metadata.proposal_apply_deterministic_failure_reason)
      .toContain('exact old_text was not found');
    expect(fs.readFileSync(path.join(workingDir, 'tools/existing.py'), 'utf-8'))
      .toBe('print("current")\n');
  });

  it('requeues proposal apply to the lane provider when codex apply is forbidden', async () => {
    const { mod, configMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'ollama-cloud' ? 'cloud-key' : null));

    const workingDir = makeTempDir();
    fs.mkdirSync(path.join(workingDir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(workingDir, 'tools/existing.py'), 'print("current")\n', 'utf-8');
    const task = {
      id: 'task-api-proposal-apply-lane-block',
      provider: 'ollama-cloud',
      model: null,
      task_description: 'Update tools/existing.py',
      working_directory: workingDir,
      timeout_minutes: 1,
      metadata: JSON.stringify({
        _routing_chain: [
          { provider: 'ollama-cloud', model: 'kimi-k2:1t' },
          { provider: 'codex' },
        ],
        file_paths: ['tools/existing.py'],
        ollama_cloud_repo_write_mode: 'proposal_apply',
        proposal_apply_provider: 'codex',
        provider_lane_policy: {
          expected_provider: 'ollama-cloud',
          allowed_fallback_providers: [],
          enforce_handoffs: true,
        },
        agentic_allowed_tools: ['read_file', 'list_directory', 'search_files'],
      }),
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const safeUpdateTaskStatus = vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch));
    mod.init({
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus,
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    });

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: JSON.stringify({
            file_edits: [
              {
                file: 'tools/existing.py',
                operations: [
                  {
                    type: 'replace',
                    old_text: 'print("missing")\n',
                    new_text: 'print("updated")\n',
                  },
                ],
              },
            ],
          }),
          toolLog: [],
          tokenUsage: { prompt_tokens: 20, completion_tokens: 40 },
          changedFiles: [],
          iterations: 1,
        },
      ])
    );

    await mod.executeApiProvider(task, { name: 'ollama-cloud' });

    const updated = tasks.get(task.id);
    expect(updated.status).toBe('queued');
    expect(updated.provider).toBe('ollama-cloud');
    expect(updated.metadata.proposal_apply).toBe(true);
    expect(updated.metadata.proposal_apply_mode).toBe('provider_handoff');
    expect(updated.metadata.agentic_handoff_mode).toBe('proposal_apply');
    expect(updated.metadata.agentic_handoff_to).toBe('ollama-cloud');
    expect(updated.metadata.proposal_apply_provider).toBe('ollama-cloud');
    expect(updated.metadata.proposal_apply_deterministic_apply_failed).toBe(true);
    expect(updated.metadata.proposal_apply_deterministic_failure_reason)
      .toContain('exact old_text was not found');
    expect(updated.metadata.ollama_cloud_repo_write_mode).toBeUndefined();
    expect(updated.metadata.agentic_allowed_tools).toBeUndefined();
    expect(updated.task_description).toContain('Apply the following repository edits drafted by the proposal phase.');
    expect(fs.readFileSync(path.join(workingDir, 'tools/existing.py'), 'utf-8'))
      .toBe('print("current")\n');
  });

  it('requeues ollama-cloud failures to codex when the next chain entry requires CLI execution', async () => {
    const { mod, configMock } = loadSubject();
    configMock.getApiKey.mockImplementation((provider) => (provider === 'ollama-cloud' ? 'cloud-key' : null));

    const task = {
      id: 'task-api-error-handoff',
      provider: 'ollama-cloud',
      model: null,
      task_description: 'Create tools/validate_unity_host_join_smoke.py',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      metadata: JSON.stringify({
        _routing_chain: [
          { provider: 'ollama-cloud', model: 'kimi-k2:1t' },
          { provider: 'codex' },
        ],
        file_paths: ['tools/validate_unity_host_join_smoke.py'],
      }),
    };

    const tasks = new Map([[task.id, { ...task, status: 'queued' }]]);
    const db = {
      updateTaskStatus: vi.fn((taskId, status, patch = {}) => {
        const current = tasks.get(taskId) || { id: taskId };
        const next = { ...current, ...patch, status };
        tasks.set(taskId, next);
        return next;
      }),
      getTask: vi.fn((taskId) => tasks.get(taskId) || null),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      addStreamChunk: vi.fn(),
      updateTask: vi.fn(),
      getProvider: vi.fn(() => ({ enabled: true })),
      isProviderHealthy: vi.fn(() => true),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus: vi.fn((taskId, status, patch = {}) => db.updateTaskStatus(taskId, status, patch)),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
      runningProcesses: Object.assign(new Map(), { stallAttempts: new Map() }),
    };
    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'error',
          message: 'Ollama chat API error (401): unauthorized',
        },
      ])
    );

    await mod.executeApiProvider(task, { name: 'ollama-cloud' });

    const updated = tasks.get(task.id);
    expect(updated.status).toBe('queued');
    expect(updated.provider).toBe('codex');
    expect(updated.metadata.user_provider_override).toBe(false);
    expect(updated.metadata.provider_selection_locked).toBe(true);
    expect(updated.metadata.provider_selection_lock_reason).toBe('agentic_handoff');
    expect(updated.metadata.agentic_handoff).toBe(true);
    expect(updated.metadata.agentic_handoff_mode).toBe('button_up');
    expect(updated.metadata.agentic_handoff_from).toBe('ollama-cloud');
    expect(updated.metadata.agentic_handoff_to).toBe('codex');
    expect(updated.metadata.fallback_provider).toBe('codex');
    expect(updated.metadata.original_requested_provider).toBe('ollama-cloud');
    expect(updated.metadata.requested_provider).toBe('codex');
    expect(updated.metadata.agentic_handoff_reason).toContain('failed');
  });

  it('reserves and releases the selected Ollama host slot around agentic execution', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn(() => ({ status: 'running' })),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        { type: 'result', output: 'done', toolLog: [], tokenUsage: {}, changedFiles: ['src/fixed.js'], iterations: 1 },
      ])
    );

    await mod.executeOllamaTask({
      id: 'task-ollama',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Fix the bug',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
    });

    expect(db.tryReserveHostSlot).toHaveBeenCalledWith('host-1', TEST_MODELS.DEFAULT);
    expect(db.releaseHostSlot).toHaveBeenCalledWith('host-1');
    expect(db.decrementHostTasks).not.toHaveBeenCalled();
    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-ollama',
      'completed',
      expect.objectContaining({
        output: 'done',
        exit_code: 0,
      }),
    );
  });

  it('tracks agentic Ollama workers in runningProcesses until completion', async () => {
    const { mod } = loadSubject();
    const workerControl = createDeferredWorkerControl();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const runningProcesses = new Map();
    runningProcesses.stallAttempts = new Map();
    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses,
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(workerControl.WorkerCtor);

    const taskPromise = mod.executeOllamaTask({
      id: 'task-ollama',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Fix the bug',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(runningProcesses.has('task-ollama')).toBe(true);
    expect(runningProcesses.get('task-ollama')).toEqual(expect.objectContaining({
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      workingDirectory: 'C:/repo',
      isAgenticWorker: true,
      timeoutMs: 60000,
    }));
    expect(runningProcesses.get('task-ollama').silentHeartbeatHandle).toBeTruthy();
    expect(typeof runningProcesses.get('task-ollama').process.kill).toBe('function');

    workerControl.latest().emitMessage({
      type: 'result',
      output: 'done',
      toolLog: [],
      tokenUsage: {},
      changedFiles: [],
      iterations: 1,
    });

    await taskPromise;

    expect(runningProcesses.has('task-ollama')).toBe(false);
  });

  it('tracks agentic Ollama tasks while they wait for the host mutex', async () => {
    let resolveHostLock;
    const releaseHostLock = vi.fn();
    const hostMutexMock = {
      acquireHostLock: vi.fn(() => new Promise((resolve) => {
        resolveHostLock = () => resolve(releaseHostLock);
      })),
    };
    const { mod } = loadSubject({ hostMutexMock });
    const workerControl = createDeferredWorkerControl();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const runningProcesses = new Map();
    runningProcesses.stallAttempts = new Map();
    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses,
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    const workerSpy = vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(workerControl.WorkerCtor);

    const taskPromise = mod.executeOllamaTask({
      id: 'task-ollama-waiting',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Generate a plan',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(hostMutexMock.acquireHostLock).toHaveBeenCalledWith('host-1');
    expect(workerSpy).not.toHaveBeenCalled();
    expect(runningProcesses.get('task-ollama-waiting')).toEqual(expect.objectContaining({
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      workingDirectory: 'C:/repo',
      isAgenticWorker: true,
      waitingForHostLock: true,
      timeoutMs: 60000,
    }));
    expect(typeof runningProcesses.get('task-ollama-waiting').process.kill).toBe('function');

    resolveHostLock();
    await new Promise((resolve) => setImmediate(resolve));

    expect(workerSpy).toHaveBeenCalledTimes(1);
    expect(runningProcesses.get('task-ollama-waiting')).toEqual(expect.objectContaining({
      isAgenticWorker: true,
    }));
    expect(runningProcesses.get('task-ollama-waiting').waitingForHostLock).toBeUndefined();

    workerControl.latest().emitMessage({
      type: 'result',
      output: 'done',
      toolLog: [],
      tokenUsage: {},
      changedFiles: [],
      iterations: 1,
    });

    await taskPromise;

    expect(releaseHostLock).toHaveBeenCalledTimes(1);
    expect(runningProcesses.has('task-ollama-waiting')).toBe(false);
  });

  it('does not start stale Ollama work after status changes while waiting for the host mutex', async () => {
    let resolveHostLock;
    const releaseHostLock = vi.fn();
    const hostMutexMock = {
      acquireHostLock: vi.fn(() => new Promise((resolve) => {
        resolveHostLock = () => resolve(releaseHostLock);
      })),
    };
    const { mod } = loadSubject({ hostMutexMock });
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const runningProcesses = new Map();
    runningProcesses.stallAttempts = new Map();
    let taskStatus = 'running';
    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: taskStatus })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses,
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    const workerSpy = vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(createDeferredWorkerControl().WorkerCtor);

    const taskPromise = mod.executeOllamaTask({
      id: 'task-ollama-stale-waiter',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Generate a plan',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(runningProcesses.has('task-ollama-stale-waiter')).toBe(true);

    taskStatus = 'skipped';
    resolveHostLock();

    await taskPromise;

    expect(workerSpy).not.toHaveBeenCalled();
    expect(releaseHostLock).toHaveBeenCalledTimes(1);
    expect(runningProcesses.has('task-ollama-stale-waiter')).toBe(false);
    expect(deps.safeUpdateTaskStatus).not.toHaveBeenCalledWith(
      'task-ollama-stale-waiter',
      'failed',
      expect.anything(),
    );
  });

  it('passes factory structured Ollama tasks as non-modification agentic work', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const runningProcesses = new Map();
    runningProcesses.stallAttempts = new Map();
    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses,
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    let workerData;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      workerData = options.workerData;
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      this.once = (eventName, handler) => emitter.once(eventName, handler);
      this.removeAllListeners = (eventName) => emitter.removeAllListeners(eventName);
      setImmediate(() => emitter.emit('message', {
        type: 'result',
        output: '## Task 1: Add startup diagnostic coverage',
        toolLog: [],
        tokenUsage: {},
        changedFiles: [],
        iterations: 1,
        stopReason: 'model_finished',
      }));
    });

    await mod.executeOllamaTask({
      id: 'task-ollama-plan-generation',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Generate an execution plan to fix LAN startup failure reason handling.',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      metadata: JSON.stringify({
        factory_internal: true,
        kind: 'plan_generation',
      }),
    });

    expect(workerData.taskExpectsModification).toBe(false);
    expect(workerData.taskPrompt).toContain('Generate an execution plan');
    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-ollama-plan-generation',
      'completed',
      expect.objectContaining({
        output: expect.stringContaining('## Task 1:'),
        exit_code: 0,
      }),
    );
  });

  it('marks Ollama agentic modification tasks failed when the model changes no files', async () => {
    const { mod } = loadSubject();
    const workerControl = createDeferredWorkerControl();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const runningProcesses = new Map();
    runningProcesses.stallAttempts = new Map();
    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses,
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(workerControl.WorkerCtor);

    const taskPromise = mod.executeOllamaTask({
      id: 'task-ollama-noop',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Add focused parser test coverage',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));

    workerControl.latest().emitMessage({
      type: 'result',
      output: 'I would add the test file with the following contents.',
      toolLog: [],
      tokenUsage: {},
      changedFiles: [],
      iterations: 1,
    });

    await taskPromise;

    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-ollama-noop',
      'failed',
      expect.objectContaining({
        exit_code: 1,
        error_output: expect.stringContaining('Agentic no-op from ollama'),
      }),
    );
    expect(deps.safeUpdateTaskStatus).not.toHaveBeenCalledWith(
      'task-ollama-noop',
      'completed',
      expect.anything(),
    );
  });

  it('marks factory execution tasks failed when no tools or files were changed even if text lacks edit verbs', async () => {
    const { mod } = loadSubject();
    const workerControl = createDeferredWorkerControl();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const runningProcesses = new Map();
    runningProcesses.stallAttempts = new Map();
    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses,
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(workerControl.WorkerCtor);

    const taskPromise = mod.executeOllamaTask({
      id: 'task-factory-exec-noop',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Plan task 1: validator coverage',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
      tags: JSON.stringify([
        'factory:batch_id=factory-b9261762-7be5-4fc9-9794-f18c3e404fcb-2057',
        'factory:plan_task_number=1',
        'project:DLPhone',
      ]),
    });

    await new Promise((resolve) => setImmediate(resolve));

    workerControl.latest().emitMessage({
      type: 'result',
      output: 'The validator coverage is already present.',
      toolLog: [],
      tokenUsage: {},
      changedFiles: [],
      iterations: 1,
    });

    await taskPromise;

    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-factory-exec-noop',
      'failed',
      expect.objectContaining({
        exit_code: 1,
        error_output: expect.stringContaining('Agentic no-op from ollama'),
      }),
    );
    expect(deps.safeUpdateTaskStatus).not.toHaveBeenCalledWith(
      'task-factory-exec-noop',
      'completed',
      expect.anything(),
    );
  });

  it('marks Ollama agentic modification tasks failed when write tools only error', async () => {
    const { mod } = loadSubject();
    const workerControl = createDeferredWorkerControl();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const runningProcesses = new Map();
    runningProcesses.stallAttempts = new Map();
    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses,
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(workerControl.WorkerCtor);

    const taskPromise = mod.executeOllamaTask({
      id: 'task-ollama-failed-write',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Add focused parser test coverage',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));

    workerControl.latest().emitMessage({
      type: 'result',
      output: 'Task stopped: 7 consecutive iterations with no successful file modifications.',
      toolLog: [
        { name: 'read_file', error: false },
        { name: 'edit_file', error: true },
      ],
      tokenUsage: {},
      changedFiles: [],
      iterations: 7,
    });

    await taskPromise;

    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-ollama-failed-write',
      'failed',
      expect.objectContaining({
        exit_code: 1,
        error_output: expect.stringContaining('Agentic no-op from ollama'),
      }),
    );
    expect(deps.safeUpdateTaskStatus).not.toHaveBeenCalledWith(
      'task-ollama-failed-write',
      'completed',
      expect.anything(),
    );
  });

  it('marks Ollama agentic modification tasks failed when max iterations stop after partial edits', async () => {
    const { mod } = loadSubject();
    const workerControl = createDeferredWorkerControl();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const runningProcesses = new Map();
    runningProcesses.stallAttempts = new Map();
    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses,
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(workerControl.WorkerCtor);

    const taskPromise = mod.executeOllamaTask({
      id: 'task-ollama-partial-max-iterations',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Add focused parser test coverage',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));

    workerControl.latest().emitMessage({
      type: 'result',
      output: 'Task reached maximum iterations (10). 10 tool calls executed.',
      toolLog: [
        { name: 'read_file', error: false },
        { name: 'edit_file', error: false },
        { name: 'edit_file', error: true },
      ],
      tokenUsage: {},
      changedFiles: ['Modules/Tests/Parser.Vendors.Tests.ps1'],
      iterations: 10,
      stopReason: 'max_iterations',
    });

    await taskPromise;

    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-ollama-partial-max-iterations',
      'failed',
      expect.objectContaining({
        exit_code: 1,
        error_output: expect.stringContaining('exhausted its iteration budget'),
      }),
    );
    expect(deps.safeUpdateTaskStatus).not.toHaveBeenCalledWith(
      'task-ollama-partial-max-iterations',
      'completed',
      expect.anything(),
    );
  });

  it('reverts partial edits when Ollama agentic tasks fail by non-convergence', async () => {
    const { mod, gitSafetyMock } = loadSubject();
    const workerControl = createDeferredWorkerControl();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    const snapshot = { isGitRepo: true, dirtyFiles: new Set(), untrackedFiles: new Set() };
    gitSafetyMock.captureSnapshot.mockReturnValue(snapshot);
    gitSafetyMock.checkAndRevert.mockReturnValue({ reverted: [], kept: [], report: '' });
    gitSafetyMock.revertScopedChanges.mockReturnValue({
      reverted: ['Modules/Tests/Parser.Vendors.Tests.ps1'],
      kept: [],
      report: 'Reverted Modules/Tests/Parser.Vendors.Tests.ps1',
    });

    const runningProcesses = new Map();
    runningProcesses.stallAttempts = new Map();
    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses,
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(workerControl.WorkerCtor);

    const taskPromise = mod.executeOllamaTask({
      id: 'task-ollama-revert-non-converged',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Add focused parser test coverage',
      working_directory: workDir,
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));

    workerControl.latest().emitMessage({
      type: 'result',
      output: 'Task reached maximum iterations (10). 10 tool calls executed.',
      toolLog: [
        { name: 'read_file', error: false },
        { name: 'edit_file', error: false },
        { name: 'edit_file', error: true },
      ],
      tokenUsage: {},
      changedFiles: ['Modules/Tests/Parser.Vendors.Tests.ps1'],
      iterations: 10,
      stopReason: 'max_iterations',
    });

    await taskPromise;

    expect(gitSafetyMock.revertScopedChanges).toHaveBeenCalledWith(
      workDir,
      snapshot,
      ['Modules/Tests/Parser.Vendors.Tests.ps1'],
    );

    const failureCall = deps.safeUpdateTaskStatus.mock.calls.find(
      ([taskId, status]) => taskId === 'task-ollama-revert-non-converged' && status === 'failed'
    );
    expect(failureCall).toBeTruthy();
    expect(failureCall[2]).toEqual(expect.objectContaining({
      exit_code: 1,
      error_output: expect.stringContaining('Reverted Modules/Tests/Parser.Vendors.Tests.ps1'),
    }));

    const metadata = JSON.parse(failureCall[2].task_metadata);
    expect(metadata.agentic_reverted_changes).toEqual(['Modules/Tests/Parser.Vendors.Tests.ps1']);
    expect(metadata.agentic_revert_report).toBe('Reverted Modules/Tests/Parser.Vendors.Tests.ps1');
  });

  it('persists the agentic git snapshot for restart orphan rollback', async () => {
    const { mod, gitSafetyMock } = loadSubject();
    const workerControl = createDeferredWorkerControl();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const snapshot = {
      isGitRepo: true,
      dirtyFiles: new Set(['Logs/Reports/UnusedExports.json']),
      untrackedFiles: new Set(['.worktrees/']),
    };
    gitSafetyMock.captureSnapshot.mockReturnValue(snapshot);

    const runningProcesses = new Map();
    runningProcesses.stallAttempts = new Map();
    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      updateTask: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running', metadata: { existing: true } })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses,
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(workerControl.WorkerCtor);

    const taskPromise = mod.executeOllamaTask({
      id: 'task-ollama-persist-snapshot',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Read the project',
      working_directory: 'C:/repo',
      timeout_minutes: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));

    workerControl.latest().emitMessage({
      type: 'result',
      output: 'done',
      toolLog: [{ name: 'read_file', error: false }],
      tokenUsage: {},
      changedFiles: [],
      iterations: 1,
      stopReason: 'model_finished',
    });

    await taskPromise;

    expect(db.updateTask).toHaveBeenCalledWith(
      'task-ollama-persist-snapshot',
      {
        metadata: expect.objectContaining({
          existing: true,
          agentic_git_snapshot: expect.objectContaining({
            isGitRepo: true,
            dirtyFiles: ['Logs/Reports/UnusedExports.json'],
            untrackedFiles: ['.worktrees/'],
            working_directory: 'C:/repo',
          }),
        }),
      },
    );
  });

  it('derives worker policy from task metadata and NEXT_TASK.md', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.md', [
      '# Next Task',
      '',
      '## Read Files',
      '- `client/UnityProject/Assets/Scripts/NetcodeCore/NetDatagramReassembler.cs`',
      '',
      '## Allowed Files',
      '- `client/UnityProject/Assets/Scripts/NetcodeCore/NetDatagramReassembler.cs`',
      '- `docs/autodev/SESSION_LOG.md`',
      '',
      '## Allowed Tools',
      '- `read_file`',
      '- `replace_lines`',
      '- `run_command`',
      '',
      '## Verification Command',
      '`pwsh -File scripts/autodev-verify.ps1`',
      '',
      '## Actionless Iteration Limit',
      '`2`',
    ].join('\n'));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    let capturedWorkerData = null;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      capturedWorkerData = options.workerData;
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      setImmediate(() => emitter.emit('message', {
        type: 'result',
        output: 'done',
        toolLog: [],
        tokenUsage: {},
        changedFiles: [],
        iterations: 1,
      }));
    });

    await mod.executeOllamaTask({
      id: 'task-policy',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Read docs/autodev/TASK_BRIEF.md and docs/autodev/NEXT_TASK.md, then implement exactly one bounded repair.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_allowed_read_paths: ['docs/autodev/TASK_BRIEF.md'],
        agentic_allowed_write_paths: ['docs/autodev/SESSION_LOG.md'],
        agentic_allowed_commands: ['pwsh -File scripts/autodev-verify.ps1'],
        agentic_constraints_from_next_task: true,
        agentic_next_task_path: 'docs/autodev/NEXT_TASK.md',
        agentic_max_iterations: 4,
        agentic_diagnostic_read_limit_after_failed_command: 1,
        agentic_write_after_read_paths: [
          'docs/autodev/SESSION_LOG.md',
          'docs/autodev/NEXT_TASK.md',
        ],
      },
    });

    expect(capturedWorkerData.maxIterations).toBe(4);
    expect(capturedWorkerData.commandMode).toBe('allowlist');
    expect(capturedWorkerData.commandAllowlist).toEqual(['pwsh -File scripts/autodev-verify.ps1']);
    expect(capturedWorkerData.toolAllowlist).toEqual(['read_file', 'replace_lines', 'run_command']);
    expect(capturedWorkerData.actionlessIterationLimit).toBe(2);
    expect(capturedWorkerData.readAllowlist).toEqual(expect.arrayContaining([
      'docs/autodev/TASK_BRIEF.md',
      'docs/autodev/NEXT_TASK.md',
      'client/UnityProject/Assets/Scripts/NetcodeCore/NetDatagramReassembler.cs',
      'docs/autodev/SESSION_LOG.md',
    ]));
    expect(capturedWorkerData.writeAllowlist).toEqual(expect.arrayContaining([
      'docs/autodev/SESSION_LOG.md',
      'client/UnityProject/Assets/Scripts/NetcodeCore/NetDatagramReassembler.cs',
    ]));
    expect(capturedWorkerData.writeAfterReadPaths).toEqual([
      'docs/autodev/SESSION_LOG.md',
      'docs/autodev/NEXT_TASK.md',
    ]);
    expect(capturedWorkerData.diagnosticReadLimitAfterFailedCommand).toBe(1);
  });

  it('prefers NEXT_TASK.json over markdown when deriving worker policy', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.md', [
      '# Next Task',
      '',
      '## Read Files',
      '- `client/UnityProject/Assets/Scripts/NetcodeCore/FromMarkdown.cs`',
      '',
      '## Allowed Files',
      '- `client/UnityProject/Assets/Scripts/NetcodeCore/FromMarkdown.cs`',
    ].join('\n'));
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline',
      read_files: [
        'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonRead.cs',
      ],
      allowed_files: [
        'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonWrite.cs',
        'docs/autodev/SESSION_LOG.md',
      ],
      verification_command: 'pwsh -File scripts/autodev-verify.ps1',
    }, null, 2));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    let capturedWorkerData = null;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      capturedWorkerData = options.workerData;
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      setImmediate(() => emitter.emit('message', {
        type: 'result',
        output: 'done',
        toolLog: [],
        tokenUsage: {},
        changedFiles: [],
        iterations: 1,
      }));
    });

    await mod.executeOllamaTask({
      id: 'task-policy-json',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Read docs/autodev/TASK_BRIEF.md and docs/autodev/NEXT_TASK.json, then implement exactly one bounded repair.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_allowed_read_paths: ['docs/autodev/TASK_BRIEF.md'],
        agentic_allowed_write_paths: ['docs/autodev/SESSION_LOG.md'],
        agentic_constraints_from_next_task: true,
        agentic_next_task_path: 'docs/autodev/NEXT_TASK.md',
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
      },
    });

    expect(capturedWorkerData.readAllowlist).toEqual(expect.arrayContaining([
      'docs/autodev/TASK_BRIEF.md',
      'docs/autodev/NEXT_TASK.md',
      'docs/autodev/NEXT_TASK.json',
      'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonRead.cs',
      'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonWrite.cs',
    ]));
    expect(capturedWorkerData.readAllowlist).not.toContain(
      'client/UnityProject/Assets/Scripts/NetcodeCore/FromMarkdown.cs'
    );
    expect(capturedWorkerData.writeAllowlist).toEqual(expect.arrayContaining([
      'docs/autodev/SESSION_LOG.md',
      'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonWrite.cs',
    ]));
    expect(capturedWorkerData.writeAllowlist).not.toContain(
      'client/UnityProject/Assets/Scripts/NetcodeCore/FromMarkdown.cs'
    );
  });

  it('accepts max_iterations from NEXT_TASK.json when task metadata does not override it', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline build.',
      allowed_files: ['src/FixMe.cs'],
      max_iterations: 7,
      verification_command: 'pwsh -File scripts/autodev-verify.ps1',
    }, null, 2));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    let capturedWorkerData = null;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      capturedWorkerData = options.workerData;
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      setImmediate(() => emitter.emit('message', {
        type: 'result',
        output: 'done',
        toolLog: [],
        tokenUsage: {},
        changedFiles: [],
        iterations: 1,
      }));
    });

    await mod.executeOllamaTask({
      id: 'task-spec-max-iterations',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Low-context execution pass for example-project.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_constraints_from_next_task: true,
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
      },
    });

    expect(capturedWorkerData.maxIterations).toBe(7);
  });

  it('persists constrained NEXT_TASK metadata and derives a verification-only command allowlist', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline',
      read_files: [
        'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonRead.cs',
      ],
      allowed_files: [
        'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonWrite.cs',
        'docs/autodev/SESSION_LOG.md',
      ],
      allowed_tools: ['read_file', 'replace_lines', 'run_command'],
      required_modified_paths: [
        'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonWrite.cs',
        'docs/autodev/SESSION_LOG.md',
      ],
      verification_command: 'pwsh -File scripts/autodev-verify.ps1',
      actionless_iteration_limit: 2,
    }, null, 2));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    let capturedWorkerData = null;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      capturedWorkerData = options.workerData;
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      setImmediate(() => emitter.emit('message', {
        type: 'result',
        output: 'done',
        toolLog: [],
        tokenUsage: {},
        changedFiles: [],
        iterations: 1,
      }));
    });

    await mod.executeOllamaTask({
      id: 'task-policy-json-sync',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Read docs/autodev/TASK_BRIEF.md and docs/autodev/NEXT_TASK.json, then implement exactly one bounded repair.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_allowed_read_paths: ['docs/autodev/TASK_BRIEF.md'],
        agentic_allowed_write_paths: ['docs/autodev/SESSION_LOG.md'],
        agentic_constraints_from_next_task: true,
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
      },
    });

    expect(capturedWorkerData.commandMode).toBe('allowlist');
    expect(capturedWorkerData.commandAllowlist).toEqual(['pwsh -File scripts/autodev-verify.ps1']);
    expect(capturedWorkerData.toolAllowlist).toEqual(['read_file', 'replace_lines', 'run_command']);
    expect(capturedWorkerData.actionlessIterationLimit).toBe(2);
    expect(db.updateTask).toHaveBeenCalledWith(
      'task-policy-json-sync',
      expect.objectContaining({
        metadata: expect.objectContaining({
          agentic_allowed_read_paths: expect.arrayContaining([
            'docs/autodev/TASK_BRIEF.md',
            'docs/autodev/NEXT_TASK.json',
            'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonRead.cs',
            'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonWrite.cs',
            'docs/autodev/SESSION_LOG.md',
          ]),
          agentic_allowed_write_paths: expect.arrayContaining([
            'docs/autodev/SESSION_LOG.md',
            'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonWrite.cs',
          ]),
          agentic_allowed_tools: ['read_file', 'replace_lines', 'run_command'],
          agentic_required_modified_paths: [
            'client/UnityProject/Assets/Scripts/NetcodeCore/FromJsonWrite.cs',
            'docs/autodev/SESSION_LOG.md',
          ],
          agentic_verification_command: 'pwsh -File scripts/autodev-verify.ps1',
          agentic_allowed_commands: ['pwsh -File scripts/autodev-verify.ps1'],
          agentic_command_mode: 'allowlist',
          agentic_actionless_iteration_limit: 2,
        }),
      }),
    );
  });

  it('falls back to NEXT_TASK.md when NEXT_TASK.json is invalid', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.md', [
      '# Next Task',
      '',
      '## Read Files',
      '- `client/UnityProject/Assets/Scripts/NetcodeCore/FromMarkdown.cs`',
      '',
      '## Allowed Files',
      '- `client/UnityProject/Assets/Scripts/NetcodeCore/FromMarkdown.cs`',
      '- `docs/autodev/SESSION_LOG.md`',
    ].join('\n'));
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', '{ invalid json');

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    let capturedWorkerData = null;
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      capturedWorkerData = options.workerData;
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      setImmediate(() => emitter.emit('message', {
        type: 'result',
        output: 'done',
        toolLog: [],
        tokenUsage: {},
        changedFiles: [],
        iterations: 1,
      }));
    });

    await mod.executeOllamaTask({
      id: 'task-policy-json-fallback',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Read docs/autodev/TASK_BRIEF.md and docs/autodev/NEXT_TASK.md, then implement exactly one bounded repair.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_allowed_read_paths: ['docs/autodev/TASK_BRIEF.md'],
        agentic_constraints_from_next_task: true,
        agentic_next_task_path: 'docs/autodev/NEXT_TASK.md',
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
      },
    });

    expect(capturedWorkerData.readAllowlist).toEqual(expect.arrayContaining([
      'docs/autodev/TASK_BRIEF.md',
      'docs/autodev/NEXT_TASK.md',
      'docs/autodev/NEXT_TASK.json',
      'client/UnityProject/Assets/Scripts/NetcodeCore/FromMarkdown.cs',
    ]));
    expect(capturedWorkerData.writeAllowlist).toEqual(expect.arrayContaining([
      'client/UnityProject/Assets/Scripts/NetcodeCore/FromMarkdown.cs',
      'docs/autodev/SESSION_LOG.md',
    ]));
  });

  it('short-circuits synced planning tasks before reserving an Ollama host', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.md', [
      '# Next Task',
      '',
      '## Goal',
      '',
      'Repair the baseline `build`.',
      '',
      '## Why Now',
      '',
      'Keep the core verification path green.',
      '',
      '## Read Files',
      '- `docs/autodev/TASK_BRIEF.md`',
      '- `src/FixMe.cs`',
      '',
      '## Specific Actions',
      '- `Repair the malformed duplicate method.`',
      '',
      '## Allowed Files',
      '- `src/FixMe.cs`',
      '- `docs/autodev/SESSION_LOG.md`',
      '',
      '## Verification Command',
      '`pwsh -File scripts/autodev-verify.ps1`',
      '',
      '## Stop Conditions',
      '- `Stop after the baseline is green.`',
    ].join('\n'));
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline build.',
      why_now: 'Keep the core verification path green.',
      read_files: ['docs/autodev/TASK_BRIEF.md', 'src/FixMe.cs'],
      specific_actions: ['Repair the malformed duplicate method.'],
      allowed_files: ['src/FixMe.cs', 'docs/autodev/SESSION_LOG.md'],
      verification_command: 'pwsh -File scripts/autodev-verify.ps1',
      stop_conditions: ['Stop after the baseline is green.'],
    }, null, 2));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'completed' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    const workerSpy = vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(() => {
      throw new Error('worker should not be started for a synced planning no-op');
    });

    await mod.executeOllamaTask({
      id: 'task-planner-noop',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Low-context planning pass for example-project.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_noop_when_task_spec_synced: true,
        agentic_next_task_path: 'docs/autodev/NEXT_TASK.md',
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
        agentic_allowed_read_paths: [
          'docs/autodev/TASK_BRIEF.md',
          'docs/autodev/ROADMAP.md',
          'docs/autodev/NEXT_TASK.md',
          'docs/autodev/NEXT_TASK.json',
        ],
        agentic_allowed_write_paths: [
          'docs/autodev/ROADMAP.md',
          'docs/autodev/NEXT_TASK.md',
          'docs/autodev/NEXT_TASK.json',
        ],
        agentic_allowed_commands: [],
      },
    });

    expect(workerSpy).not.toHaveBeenCalled();
    expect(db.selectOllamaHostForModel).not.toHaveBeenCalled();
    expect(db.tryReserveHostSlot).not.toHaveBeenCalled();
    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-planner-noop',
      'completed',
      expect.objectContaining({
        output: expect.stringContaining('Planning short-circuit'),
        exit_code: 0,
      }),
    );
  });

  it('does not short-circuit synced planning tasks when required modified paths are configured', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.md', [
      '# Next Task',
      '',
      '## Goal',
      '',
      'Repair the baseline build.',
      '',
      '## Why Now',
      '',
      'Keep the core verification path green.',
      '',
      '## Read Files',
      '- `docs/autodev/TASK_BRIEF.md`',
      '- `src/FixMe.cs`',
      '',
      '## Specific Actions',
      '- `Repair the malformed duplicate method.`',
      '',
      '## Allowed Files',
      '- `src/FixMe.cs`',
      '- `docs/autodev/SESSION_LOG.md`',
      '',
      '## Verification Command',
      '`pwsh -File scripts/autodev-verify.ps1`',
      '',
      '## Stop Conditions',
      '- `Stop after the baseline is green.`',
    ].join('\n'));
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline build.',
      why_now: 'Keep the core verification path green.',
      read_files: ['docs/autodev/TASK_BRIEF.md', 'src/FixMe.cs'],
      specific_actions: ['Repair the malformed duplicate method.'],
      allowed_files: ['src/FixMe.cs', 'docs/autodev/SESSION_LOG.md'],
      verification_command: 'pwsh -File scripts/autodev-verify.ps1',
      stop_conditions: ['Stop after the baseline is green.'],
    }, null, 2));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'failed' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    const workerSpy = vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        { type: 'result', output: 'done', toolLog: [], tokenUsage: {}, changedFiles: [], iterations: 1 },
      ])
    );

    await mod.executeOllamaTask({
      id: 'task-planner-required-write',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Low-context planning pass for example-project.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_noop_when_task_spec_synced: true,
        agentic_strict_completion: true,
        agentic_required_modified_paths: ['docs/autodev/NEXT_TASK.json'],
        agentic_fail_on_missing_required_paths: true,
        agentic_next_task_path: 'docs/autodev/NEXT_TASK.md',
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
        agentic_allowed_commands: [],
      },
    });

    expect(workerSpy).toHaveBeenCalled();
    expect(db.selectOllamaHostForModel).toHaveBeenCalledWith(TEST_MODELS.DEFAULT);
    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-planner-required-write',
      'failed',
      expect.objectContaining({
        error_output: expect.stringContaining('Required files were not modified: docs/autodev/NEXT_TASK.json'),
      }),
    );
  });

  it('keeps planning tasks on the normal path when SESSION_LOG.md is newer than synced NEXT_TASK docs', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.md', [
      '# Next Task',
      '',
      '## Goal',
      '',
      'Repair the baseline build.',
      '',
      '## Why Now',
      '',
      'Keep the core verification path green.',
      '',
      '## Read Files',
      '- `docs/autodev/TASK_BRIEF.md`',
      '- `src/FixMe.cs`',
      '',
      '## Specific Actions',
      '- `Repair the malformed duplicate method.`',
      '',
      '## Allowed Files',
      '- `src/FixMe.cs`',
      '- `docs/autodev/SESSION_LOG.md`',
      '',
      '## Verification Command',
      '`pwsh -File scripts/autodev-verify.ps1`',
      '',
      '## Stop Conditions',
      '- `Stop after the baseline is green.`',
    ].join('\n'));
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline build.',
      why_now: 'Keep the core verification path green.',
      read_files: ['docs/autodev/TASK_BRIEF.md', 'src/FixMe.cs'],
      specific_actions: ['Repair the malformed duplicate method.'],
      allowed_files: ['src/FixMe.cs', 'docs/autodev/SESSION_LOG.md'],
      verification_command: 'pwsh -File scripts/autodev-verify.ps1',
      stop_conditions: ['Stop after the baseline is green.'],
    }, null, 2));
    writeFile(workDir, 'docs/autodev/SESSION_LOG.md', 'fresh failure evidence');
    const freshDate = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(workDir, 'docs', 'autodev', 'SESSION_LOG.md'), freshDate, freshDate);

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    let capturedWorkerData = null;
    const workerSpy = vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(function MockWorker(_filename, options) {
      const emitter = new EventEmitter();
      capturedWorkerData = options.workerData;
      this.postMessage = vi.fn();
      this.terminate = vi.fn();
      this.on = (eventName, handler) => emitter.on(eventName, handler);
      setImmediate(() => emitter.emit('message', {
        type: 'result',
        output: 'done',
        toolLog: [],
        tokenUsage: {},
        changedFiles: [],
        iterations: 1,
      }));
    });

    await mod.executeOllamaTask({
      id: 'task-planner-fresh-session-log',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Low-context planning pass for example-project.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_noop_when_task_spec_synced: true,
        agentic_next_task_path: 'docs/autodev/NEXT_TASK.md',
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
        agentic_allowed_commands: [],
      },
    });

    expect(workerSpy).toHaveBeenCalled();
    expect(db.selectOllamaHostForModel).toHaveBeenCalledWith(TEST_MODELS.DEFAULT);
    expect(db.tryReserveHostSlot).toHaveBeenCalledWith('host-1', TEST_MODELS.DEFAULT);
    expect(capturedWorkerData.maxIterations).toBe(25);
    expect(capturedWorkerData.actionlessIterationLimit).toBeNull();
  });

  it('keeps planning tasks on the normal agentic path when NEXT_TASK docs diverge', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.md', [
      '# Next Task',
      '',
      '## Goal',
      '',
      'Repair the baseline build.',
      '',
      '## Why Now',
      '',
      'Keep the core verification path green.',
      '',
      '## Read Files',
      '- `src/FromMarkdown.cs`',
      '',
      '## Specific Actions',
      '- `Repair the malformed duplicate method.`',
      '',
      '## Allowed Files',
      '- `src/FromMarkdown.cs`',
      '',
      '## Verification Command',
      '`pwsh -File scripts/autodev-verify.ps1`',
      '',
      '## Stop Conditions',
      '- `Stop after the baseline is green.`',
    ].join('\n'));
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline build.',
      why_now: 'Keep the core verification path green.',
      read_files: ['src/FromJson.cs'],
      specific_actions: ['Repair the malformed duplicate method.'],
      allowed_files: ['src/FromJson.cs'],
      verification_command: 'pwsh -File scripts/autodev-verify.ps1',
      stop_conditions: ['Stop after the baseline is green.'],
    }, null, 2));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'running' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    const workerSpy = vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        { type: 'result', output: 'done', toolLog: [], tokenUsage: {}, changedFiles: [], iterations: 1 },
      ])
    );

    await mod.executeOllamaTask({
      id: 'task-planner-diverged',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Low-context planning pass for example-project.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_noop_when_task_spec_synced: true,
        agentic_next_task_path: 'docs/autodev/NEXT_TASK.md',
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
        agentic_allowed_commands: [],
      },
    });

    expect(workerSpy).toHaveBeenCalled();
    expect(db.selectOllamaHostForModel).toHaveBeenCalledWith(TEST_MODELS.DEFAULT);
    expect(db.tryReserveHostSlot).toHaveBeenCalledWith('host-1', TEST_MODELS.DEFAULT);
  });

  it('fails strict execution tasks when the verification command fails', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline build.',
      allowed_files: ['src/FixMe.cs'],
      verification_command: 'pwsh -File scripts/autodev-verify.ps1',
    }, null, 2));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'failed' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: 'verification failed',
          toolLog: [{
            iteration: 1,
            name: 'run_command',
            command: 'pwsh -File scripts/autodev-verify.ps1',
            arguments_preview: '{"command":"pwsh -File scripts/autodev-verify.ps1"}',
            result_preview: 'Command failed (exit 1): build red',
            error: true,
            duration_ms: 50,
          }],
          tokenUsage: {},
          changedFiles: [],
          iterations: 1,
          stopReason: 'model_finished',
        },
      ])
    );

    await mod.executeOllamaTask({
      id: 'task-execute-fails-verify',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Low-context execution pass for example-project.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_constraints_from_next_task: true,
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
      },
    });

    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-execute-fails-verify',
      'failed',
      expect.objectContaining({
        error_output: expect.stringContaining('Verification command failed'),
        output: expect.stringContaining('verification failed'),
      })
    );
  });

  it('fails strict execution tasks when they exhaust the iteration budget', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline build.',
      allowed_files: ['src/FixMe.cs'],
    }, null, 2));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'failed' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: 'Task reached maximum iterations (4). 0 tool calls executed.',
          toolLog: [],
          tokenUsage: {},
          changedFiles: [],
          iterations: 4,
          stopReason: 'max_iterations',
        },
      ])
    );

    await mod.executeOllamaTask({
      id: 'task-execute-max-iterations',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Low-context execution pass for example-project.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_constraints_from_next_task: true,
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
        agentic_max_iterations: 4,
      },
    });

    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-execute-max-iterations',
      'failed',
      expect.objectContaining({
        error_output: expect.stringContaining('iteration budget (4)'),
      })
    );
  });

  it('framework-appends SESSION_LOG.md and satisfies the required modified path', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline build.',
      allowed_files: ['src/FixMe.cs', 'docs/autodev/SESSION_LOG.md'],
      required_modified_paths: ['docs/autodev/SESSION_LOG.md'],
    }, null, 2));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'completed' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: 'done',
          toolLog: [],
          tokenUsage: {},
          changedFiles: [path.join(workDir, 'src', 'FixMe.cs')],
          iterations: 1,
          stopReason: 'model_finished',
        },
      ])
    );

    await mod.executeOllamaTask({
      id: 'task-execute-missing-session-log',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Low-context execution pass for example-project.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_constraints_from_next_task: true,
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
      },
    });

    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-execute-missing-session-log',
      'completed',
      expect.objectContaining({
        output: expect.stringContaining('Framework Session Log'),
      })
    );
    expect(
      fs.readFileSync(path.join(workDir, 'docs', 'autodev', 'SESSION_LOG.md'), 'utf-8')
    ).toContain('Files Changed: src/FixMe.cs');
  });

  it('merges explicit required modified paths with NEXT_TASK required paths for constrained tasks', async () => {
    const { mod } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline build.',
      allowed_files: ['src/FixMe.cs', 'docs/autodev/SESSION_LOG.md'],
      required_modified_paths: ['src/FixMe.cs'],
    }, null, 2));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'failed' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: 'done',
          toolLog: [],
          tokenUsage: {},
          changedFiles: [path.join(workDir, 'docs', 'autodev', 'SESSION_LOG.md')],
          iterations: 1,
          stopReason: 'model_finished',
        },
      ])
    );

    await mod.executeOllamaTask({
      id: 'task-execute-required-path-merge',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Low-context execution pass for example-project.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_constraints_from_next_task: true,
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
        agentic_required_modified_paths: ['docs/autodev/SESSION_LOG.md'],
      },
    });

    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-execute-required-path-merge',
      'failed',
      expect.objectContaining({
        error_output: expect.stringContaining('Required files were not modified: src/FixMe.cs'),
      })
    );
  });

  it('reverts changed files after strict completion review fails', async () => {
    const { mod, gitSafetyMock } = loadSubject();
    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline build.',
      allowed_files: ['src/FixMe.cs', 'docs/autodev/SESSION_LOG.md'],
      verification_command: 'pwsh -File scripts/autodev-verify.ps1',
    }, null, 2));

    const snapshot = { isGitRepo: true, dirtyFiles: new Set(), untrackedFiles: new Set() };
    gitSafetyMock.captureSnapshot.mockReturnValue(snapshot);
    gitSafetyMock.checkAndRevert.mockReturnValue({ reverted: [], kept: [], report: '' });
    gitSafetyMock.revertScopedChanges.mockReturnValue({
      reverted: ['src/FixMe.cs'],
      kept: [],
      report: 'Reverted 1 failed task change: src/FixMe.cs',
    });

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'failed' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    const changedFile = path.join(workDir, 'src', 'FixMe.cs');
    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        {
          type: 'result',
          output: 'done',
          toolLog: [],
          tokenUsage: {},
          changedFiles: [changedFile],
          iterations: 1,
          stopReason: 'model_finished',
        },
      ])
    );

    await mod.executeOllamaTask({
      id: 'task-execute-revert-on-failure',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Low-context execution pass for example-project.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_constraints_from_next_task: true,
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
      },
    });

    expect(gitSafetyMock.revertScopedChanges).toHaveBeenCalledWith(
      workDir,
      snapshot,
      [changedFile]
    );
    expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(
      'task-execute-revert-on-failure',
      'failed',
      expect.objectContaining({
        error_output: expect.stringContaining('Reverted 1 failed task change: src/FixMe.cs'),
      })
    );
    expect(
      fs.readFileSync(path.join(workDir, 'docs', 'autodev', 'SESSION_LOG.md'), 'utf-8')
    ).toContain('Notes: Reverted 1 failed task change: src/FixMe.cs');
  });

  it('passes the resolved write allowlist into git safety checks', async () => {
    const { mod, gitSafetyMock } = loadSubject();
    gitSafetyMock.captureSnapshot.mockReturnValue({ isGitRepo: true });
    gitSafetyMock.checkAndRevert.mockReturnValue({ reverted: [], kept: [], report: '' });

    const host = { id: 'host-1', url: 'http://ollama-host:11434' };
    const workDir = makeTempDir();
    writeFile(workDir, 'docs/autodev/NEXT_TASK.json', JSON.stringify({
      goal: 'Repair the baseline build.',
      allowed_files: ['src/FixMe.cs', 'docs/autodev/SESSION_LOG.md'],
    }, null, 2));

    const db = {
      listOllamaHosts: vi.fn(() => [host]),
      selectOllamaHostForModel: vi.fn(() => ({ host })),
      tryReserveHostSlot: vi.fn(() => ({ acquired: true })),
      releaseHostSlot: vi.fn(),
      decrementHostTasks: vi.fn(),
      updateTaskStatus: vi.fn(),
      getOrCreateTaskStream: vi.fn(() => 'stream-1'),
      getTask: vi.fn((taskId) => ({ id: taskId, status: 'completed' })),
      addStreamChunk: vi.fn(),
    };
    const deps = {
      db,
      dashboard: {
        notifyTaskUpdated: vi.fn(),
        notifyTaskOutput: vi.fn(),
      },
      runningProcesses: new Map(),
      safeUpdateTaskStatus: vi.fn(),
      processQueue: vi.fn(),
      handleWorkflowTermination: vi.fn(),
      apiAbortControllers: new Map(),
    };

    mod.init(deps);

    vi.spyOn(require('worker_threads'), 'Worker').mockImplementation(
      createWorkerCtor([
        { type: 'result', output: 'done', toolLog: [], tokenUsage: {}, changedFiles: [], iterations: 1, stopReason: 'model_finished' },
      ])
    );

    await mod.executeOllamaTask({
      id: 'task-git-allowlist',
      provider: 'ollama',
      model: TEST_MODELS.DEFAULT,
      task_description: 'Low-context execution pass for example-project.',
      working_directory: workDir,
      timeout_minutes: 1,
      metadata: {
        agentic_constraints_from_next_task: true,
        agentic_next_task_json_path: 'docs/autodev/NEXT_TASK.json',
      },
    });

    expect(gitSafetyMock.checkAndRevert).toHaveBeenCalledWith(
      workDir,
      expect.any(Object),
      'Low-context execution pass for example-project.',
      expect.any(String),
      expect.objectContaining({
        authorizedPaths: expect.arrayContaining(['src/FixMe.cs', 'docs/autodev/SESSION_LOG.md']),
      })
    );
  });
});
