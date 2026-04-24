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
const ROUTING_CORE_PATH = require.resolve('../db/provider-routing-core');
const OLLAMA_AGENTIC_PATH = require.resolve('../providers/ollama-agentic');

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
    revertScopedChanges: vi.fn(() => ({ reverted: [], kept: [], report: '' })),
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
    expect(updated.metadata.user_provider_override).toBe(true);
    expect(updated.metadata.requested_provider).toBe('codex');
    expect(updated.metadata.agentic_handoff_reason).toContain('Agentic no-op');
    expect(safeUpdateTaskStatus).not.toHaveBeenCalledWith(
      task.id,
      'completed',
      expect.anything(),
    );
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
    expect(updated.metadata.user_provider_override).toBe(true);
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
    }));
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
    expect(capturedWorkerData.maxIterations).toBe(15);
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
