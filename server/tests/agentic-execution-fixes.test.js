'use strict';

const { EventEmitter } = require('events');

const { TEST_MODELS } = require('./test-helpers');

const SUBJECT_PATH = require.resolve('../providers/execution');
const EXECUTE_API_PATH = require.resolve('../providers/execute-api');
const EXECUTE_OLLAMA_PATH = require.resolve('../providers/execute-ollama');
const EXECUTE_HASHLINE_PATH = require.resolve('../providers/execute-hashline');
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
const ROUTING_CORE_PATH = require.resolve('../db/provider-routing-core');
const OLLAMA_AGENTIC_PATH = require.resolve('../providers/ollama-agentic');

const TRACKED_CACHE_PATHS = [
  SUBJECT_PATH,
  EXECUTE_API_PATH,
  EXECUTE_OLLAMA_PATH,
  EXECUTE_HASHLINE_PATH,
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
  ROUTING_CORE_PATH,
  OLLAMA_AGENTIC_PATH,
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
        agentic_max_iterations: '15',
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
  const executeHashlineMock = {
    init: vi.fn(),
    executeHashlineOllamaTask: vi.fn(),
    runOllamaGenerate: vi.fn(),
    parseAndApplyEdits: vi.fn(),
    runErrorFeedbackLoop: vi.fn(),
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
  };

  installMock(LOGGER_PATH, loggerMock);
  installMock(CONFIG_PATH, configMock);
  installMock(GIT_SAFETY_PATH, gitSafetyMock);
  installMock(EXECUTE_API_PATH, executeApiMock);
  installMock(EXECUTE_OLLAMA_PATH, executeOllamaMock);
  installMock(EXECUTE_HASHLINE_PATH, executeHashlineMock);
  installMock(EXECUTE_CLI_PATH, executeCliMock);
  installMock(AGENTIC_CAPABILITY_PATH, capabilityMock);
  installMock(OLLAMA_TOOLS_PATH, { createToolExecutor: vi.fn(), TOOL_DEFINITIONS: [] });
  installMock(OLLAMA_CHAT_PATH, {});
  installMock(OPENAI_CHAT_PATH, {});
  installMock(GOOGLE_CHAT_PATH, {});
  installMock(PROVIDER_CONFIG_PATH, providerConfigMock);
  installMock(OLLAMA_SHARED_PATH, ollamaSharedMock);
  installMock(REGISTRY_PATH, { selectBestApprovedModel: vi.fn(() => null) });
  installMock(ROUTING_CORE_PATH, { recordProviderOutcome: vi.fn() });
  installMock(OLLAMA_AGENTIC_PATH, { runAgenticLoop: vi.fn() });

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

afterEach(() => {
  vi.restoreAllMocks();
  restoreModuleCache();
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
        { type: 'result', output: 'done', toolLog: [], tokenUsage: {}, changedFiles: [], iterations: 1 },
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
});
