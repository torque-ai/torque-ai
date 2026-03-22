/**
 * Unit tests for server/providers/aider-command.js
 *
 * Tests buildAiderCommand() and configureAiderHost() with fully mocked dependencies.
 * No real DB or filesystem — all deps are vi.fn() stubs injected via init().
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

// Spy on fs methods before requiring the module under test
const existsSyncSpy = vi.spyOn(fs, 'existsSync');
const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
const readdirSyncSpy = vi.spyOn(fs, 'readdirSync');

// Load module once — init() resets closure state between tests
const mod = require('../providers/aider-command');

// ─── helpers ────────────────────────────────────────────────────────

function createMockDb(overrides = {}) {
  const configDefaults = {
    ollama_model: 'qwen2.5-coder:7b',
    aider_edit_format: 'diff',
    aider_map_tokens: '0',
    aider_auto_commits: '0',
    aider_subtree_only: '1',
    aider_model_edit_formats: null,
    proactive_format_selection_enabled: '1',
    aider_whole_format_threshold: '50',
    aider_auto_switch_format: '1',
    ollama_host: 'http://localhost:11434',
    ollama_model_settings: null,
  };
  const configStore = { ...configDefaults, ...(overrides.config || {}) };

  return {
    getConfig: vi.fn((key) => configStore[key] !== undefined ? configStore[key] : null),
    listOllamaHosts: vi.fn(() => overrides.hosts || []),
    selectOllamaHostForModel: vi.fn(() => overrides.selectResult || { host: null, reason: 'no hosts' }),
    updateTaskStatus: vi.fn(),
    recordHostModelUsage: vi.fn(),
    getHostSettings: vi.fn(() => overrides.hostSettings || null),
  };
}

function createMockDeps(overrides = {}) {
  return {
    wrapWithInstructions: vi.fn((desc, provider, model) => {
      return `[${provider}:${model}] ${desc}`;
    }),
    detectTaskTypes: vi.fn(() => overrides.taskTypes || []),
    isLargeModelBlockedOnHost: vi.fn(() => overrides.vramCheck || { blocked: false }),
    tryReserveHostSlotWithFallback: vi.fn(() => overrides.slotResult || { success: true }),
    processQueue: vi.fn(),
    extractTargetFilesFromDescription: vi.fn(() => overrides.extractedFiles || []),
    ensureTargetFilesExist: vi.fn((workDir, files) =>
      overrides.ensuredPaths || files.map(f => path.resolve(workDir, f))
    ),
  };
}

function createTask(overrides = {}) {
  return {
    id: overrides.id || 'task-001',
    task_description: overrides.task_description || 'Write unit tests for utils.js',
    provider: overrides.provider || 'aider-ollama',
    model: overrides.model !== undefined ? overrides.model : null,
    working_directory: overrides.working_directory || '/projects/myapp',
    files: overrides.files !== undefined ? overrides.files : null,
    project: overrides.project || null,
    retry_count: overrides.retry_count !== undefined ? overrides.retry_count : 0,
    metadata: overrides.metadata || null,
    error_output: overrides.error_output || null,
  };
}

/** Initialise module DI and return mocks for assertions. */
function initModule(dbOverrides = {}, depOverrides = {}) {
  const mockDb = createMockDb(dbOverrides);
  const mockDeps = createMockDeps(depOverrides);
  const mockDashboard = { broadcast: vi.fn(), notifyTaskUpdated: vi.fn() };

  mod.init({
    db: mockDb,
    dashboard: mockDashboard,
    wrapWithInstructions: mockDeps.wrapWithInstructions,
    detectTaskTypes: mockDeps.detectTaskTypes,
    isLargeModelBlockedOnHost: mockDeps.isLargeModelBlockedOnHost,
    tryReserveHostSlotWithFallback: mockDeps.tryReserveHostSlotWithFallback,
    processQueue: mockDeps.processQueue,
    extractTargetFilesFromDescription: mockDeps.extractTargetFilesFromDescription,
    ensureTargetFilesExist: mockDeps.ensureTargetFilesExist,
  });

  return { db: mockDb, deps: mockDeps, dashboard: mockDashboard };
}

function resetFsSpies() {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  readdirSyncSpy.mockReset();
  // Default: nothing exists
  existsSyncSpy.mockReturnValue(false);
  readFileSyncSpy.mockReturnValue('');
  readdirSyncSpy.mockReturnValue([]);
}

// ─── buildAiderCommand ──────────────────────────────────────────────

describe('buildAiderCommand', () => {
  beforeEach(resetFsSpies);

  it('returns correct cliPath for current platform', () => {
    initModule();
    const task = createTask();
    const result = mod.buildAiderCommand(task, '', []);

    const expectedPath = process.platform === 'win32'
      ? path.join(os.homedir(), '.local', 'bin', 'aider.exe')
      : path.join(os.homedir(), '.local', 'bin', 'aider');
    expect(result.cliPath).toBe(expectedPath);
  });

  it('uses default model from db config when task has no model', () => {
    initModule({ config: { ollama_model: 'codestral:22b' } });
    const task = createTask({ model: null });
    const result = mod.buildAiderCommand(task, '', []);

    const modelArg = result.finalArgs[result.finalArgs.indexOf('--model') + 1];
    expect(modelArg).toBe('ollama/codestral:22b');
  });

  it('uses task-specific model when provided', () => {
    initModule({ config: { ollama_model: 'codestral:22b' } });
    const task = createTask({ model: 'qwen3:8b' });
    const result = mod.buildAiderCommand(task, '', []);

    const modelArg = result.finalArgs[result.finalArgs.indexOf('--model') + 1];
    expect(modelArg).toBe('ollama/qwen3:8b');
  });

  it('applies model-specific edit format from config', () => {
    const modelFormats = JSON.stringify({ 'gemma3:4b': 'whole', 'codestral': 'udiff' });
    initModule({ config: { aider_model_edit_formats: modelFormats } });
    const task = createTask({ model: 'gemma3:4b' });
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('whole');
    const fmtArg = result.finalArgs[result.finalArgs.indexOf('--edit-format') + 1];
    expect(fmtArg).toBe('whole');
  });

  it('stall recovery format overrides model-specific format', () => {
    const modelFormats = JSON.stringify({ 'gemma3:4b': 'diff-fenced' });
    initModule({ config: { aider_model_edit_formats: modelFormats } });
    const meta = JSON.stringify({ stallRecoveryEditFormat: 'whole' });
    const task = createTask({ model: 'gemma3:4b', metadata: meta });
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('whole');
  });

  it('falls back when model edit formats JSON is empty', () => {
    initModule({ config: { aider_model_edit_formats: '' } });
    const task = createTask({ model: 'codestral:22b' });
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('diff');
  });

  it('falls back when model edit formats JSON is malformed', () => {
    initModule({ config: { aider_model_edit_formats: '{"codestral:22b": "whole"' } });
    const task = createTask({ model: 'codestral:22b' });
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('diff');
  });

  it('handles malformed task metadata without altering edit format', () => {
    initModule();
    const task = createTask({
      model: 'codestral:22b',
      metadata: '{"stallRecoveryEditFormat": "whole"',
      files: [],
    });
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('diff');
  });

  it('handles empty task metadata JSON', () => {
    initModule();
    const task = createTask({
      model: 'codestral:22b',
      metadata: '',
      files: [],
    });
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('diff');
  });

  it('proactive format selection for file-creation tasks', () => {
    initModule({}, { taskTypes: ['file-creation'] });
    const task = createTask({ model: 'codestral:22b', retry_count: 0 });
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('whole');
  });

  it('proactive format selection for small models', () => {
    initModule({}, { taskTypes: ['single-file-task'] });
    const task = createTask({ model: 'gemma3:4b', retry_count: 0 });
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('whole');
  });

  it('proactive format selection for small files', () => {
    initModule({}, { taskTypes: ['single-file-task'] });
    const task = createTask({
      model: 'codestral:22b',
      retry_count: 0,
      task_description: 'Fix the bug in utils.js',
      working_directory: '/projects/myapp',
    });

    // File exists and is small (20 lines < 50 threshold)
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(Array(20).fill('line').join('\n'));

    const result = mod.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('whole');
  });

  it('auto-switches to whole on retry', () => {
    initModule({}, { taskTypes: [] });
    const task = createTask({ model: 'codestral:22b', retry_count: 1 });
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.usedEditFormat).toBe('whole');
  });

  it('adds --thinking-tokens 0 for thinking models (qwen3)', () => {
    initModule();
    const task = createTask({ model: 'qwen3:8b' });
    const result = mod.buildAiderCommand(task, '', []);

    const thinkIdx = result.finalArgs.indexOf('--thinking-tokens');
    expect(thinkIdx).toBeGreaterThan(-1);
    expect(result.finalArgs[thinkIdx + 1]).toBe('0');
    expect(result.finalArgs).toContain('--no-check-model-accepts-settings');
  });

  it('adds --thinking-tokens 0 for thinking models (deepseek-r1)', () => {
    initModule();
    const task = createTask({ model: 'deepseek-r1:14b' });
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.finalArgs).toContain('--thinking-tokens');
    expect(result.finalArgs).toContain('--no-check-model-accepts-settings');
  });

  it('adds --subtree-only when enabled', () => {
    initModule({ config: { aider_subtree_only: '1' } });
    const task = createTask();
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.finalArgs).toContain('--subtree-only');
  });

  it('omits --subtree-only when disabled', () => {
    initModule({ config: { aider_subtree_only: '0' } });
    const task = createTask();
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.finalArgs).not.toContain('--subtree-only');
  });

  it('adds target files to args', () => {
    const { deps } = initModule({}, {
      extractedFiles: ['extra.js'],
      ensuredPaths: ['/projects/myapp/src/utils.js', '/projects/myapp/extra.js'],
    });
    const task = createTask({
      files: ['src/utils.js'],
      working_directory: '/projects/myapp',
    });
    const result = mod.buildAiderCommand(task, '', []);

    expect(result.finalArgs).toContain('/projects/myapp/src/utils.js');
    expect(result.finalArgs).toContain('/projects/myapp/extra.js');
    expect(deps.ensureTargetFilesExist).toHaveBeenCalled();
  });

  it('calls wrapWithInstructions with correct params', () => {
    const { deps } = initModule();
    const task = createTask({
      task_description: 'Add logging',
      model: 'qwen2.5-coder:7b',
      files: ['app.js'],
      project: 'myproject',
    });
    const fileContext = 'file context string';

    mod.buildAiderCommand(task, fileContext, []);

    expect(deps.wrapWithInstructions).toHaveBeenCalledWith(
      'Add logging',
      'aider-ollama',
      'qwen2.5-coder:7b',
      { files: ['app.js'], project: 'myproject', fileContext: 'file context string' }
    );
  });

  it('sets --model-metadata-file path relative to server dir, not providers dir', () => {
    initModule();
    const task = createTask();
    const result = mod.buildAiderCommand(task, '', []);

    const metaIdx = result.finalArgs.indexOf('--model-metadata-file');
    expect(metaIdx).toBeGreaterThan(-1);
    const metaPath = result.finalArgs[metaIdx + 1];
    // __dirname in the module is server/providers, so the resolved path should be
    // server/aider-model-metadata.json (one level up from providers/)
    const expectedPath = path.join(__dirname, '..', 'aider-model-metadata.json');
    expect(path.resolve(metaPath)).toBe(path.resolve(expectedPath));
  });
});

// ─── configureAiderHost ─────────────────────────────────────────────

describe('configureAiderHost', () => {
  beforeEach(resetFsSpies);

  it('single-host mode: sets OLLAMA_API_BASE from config', () => {
    initModule({
      hosts: [],
      config: { ollama_host: 'http://192.0.2.50:11434' },
    });
    const task = createTask();
    const envVars = {};
    const result = mod.configureAiderHost(task, 'task-001', envVars);

    expect(envVars.OLLAMA_API_BASE).toBe('http://192.0.2.50:11434');
    expect(result.selectedHostId).toBeNull();
    expect(result.requeued).toBeUndefined();
  });

  it('multi-host mode: selects best host and reserves slot', () => {
    const host = { id: 'host-1', url: 'http://192.0.2.100:11434', name: 'remote-gpu-host' };
    const { db } = initModule({
      hosts: [host],
      selectResult: { host, reason: 'least loaded' },
    });
    const task = createTask();
    const envVars = {};
    const result = mod.configureAiderHost(task, 'task-001', envVars);

    expect(envVars.OLLAMA_API_BASE).toBe('http://192.0.2.100:11434');
    expect(result.selectedHostId).toBe('host-1');
    expect(result.requeued).toBeUndefined();
    expect(db.recordHostModelUsage).toHaveBeenCalledWith('host-1', 'qwen2.5-coder:7b');
  });

  it('VRAM guard blocks and requeues', () => {
    const host = { id: 'host-1', url: 'http://localhost:11434', name: 'local' };
    const { db, deps, dashboard } = initModule({
      hosts: [host],
      selectResult: { host, reason: 'selected' },
    }, {
      vramCheck: { blocked: true, reason: 'VRAM conflict with qwen2.5-coder:32b' },
    });
    const task = createTask();
    const envVars = {};
    const result = mod.configureAiderHost(task, 'task-001', envVars);

    expect(result.requeued).toBe(true);
    expect(result.result.reason).toContain('VRAM conflict');
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-001', 'queued', expect.objectContaining({
      pid: null, started_at: null, ollama_host_id: null,
    }));
    expect(deps.processQueue).toHaveBeenCalled();
    expect(dashboard.notifyTaskUpdated).toHaveBeenCalledWith('task-001');
  });

  it('race condition on slot reservation causes requeue', () => {
    const host = { id: 'host-1', url: 'http://localhost:11434', name: 'local' };
    const { db } = initModule({
      hosts: [host],
      selectResult: { host, reason: 'selected' },
    }, {
      slotResult: { success: false, reason: 'Host at capacity (3/3)' },
    });
    const task = createTask();
    const envVars = {};
    const result = mod.configureAiderHost(task, 'task-001', envVars);

    expect(result.requeued).toBe(true);
    expect(result.result.reason).toContain('Host at capacity');
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-001', 'queued', expect.objectContaining({
      pid: null, started_at: null, ollama_host_id: null,
    }));
  });

  it('OOM protection throws error with suggestions', () => {
    initModule({
      hosts: [{ id: 'host-1', url: 'http://localhost:11434' }],
      selectResult: {
        host: null,
        memoryError: true,
        reason: 'qwen2.5-coder:32b requires 20GB, only 8GB available',
        suggestedModels: [
          { name: 'qwen3:8b', sizeGb: 5.2 },
          { name: 'gemma3:4b', sizeGb: 3.3 },
        ],
      },
    });
    const task = createTask({ model: 'qwen2.5-coder:32b' });
    const envVars = {};

    expect(() => mod.configureAiderHost(task, 'task-001', envVars))
      .toThrow(/OOM Protection/);
  });

  it('OOM protection includes suggested model names in error', () => {
    initModule({
      hosts: [{ id: 'host-1', url: 'http://localhost:11434' }],
      selectResult: {
        host: null,
        memoryError: true,
        reason: 'qwen2.5-coder:32b requires 20GB',
        suggestedModels: [
          { name: 'qwen3:8b', sizeGb: 5.2 },
          { name: 'gemma3:4b', sizeGb: 3.3 },
        ],
      },
    });
    const task = createTask({ model: 'qwen2.5-coder:32b' });
    const envVars = {};

    expect(() => mod.configureAiderHost(task, 'task-001', envVars))
      .toThrow(/qwen3:8b \(5\.2 GB\)/);
  });

  it('at-capacity requeues task', () => {
    const { db } = initModule({
      hosts: [{ id: 'host-1', url: 'http://localhost:11434' }],
      selectResult: { host: null, atCapacity: true, reason: 'All hosts at max concurrent' },
    });
    const task = createTask();
    const envVars = {};
    const result = mod.configureAiderHost(task, 'task-001', envVars);

    expect(result.requeued).toBe(true);
    expect(result.result.reason).toContain('All hosts at max concurrent');
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-001', 'queued', expect.objectContaining({
      pid: null, started_at: null, ollama_host_id: null,
    }));
  });

  it('applies per-host settings (num_ctx, num_gpu)', () => {
    const host = { id: 'host-1', url: 'http://192.0.2.100:11434', name: 'remote-gpu-host' };
    initModule({
      hosts: [host],
      selectResult: { host, reason: 'selected' },
      hostSettings: { hostName: 'remote-gpu-host', num_ctx: 16384, num_gpu: 48 },
    });
    const task = createTask();
    const envVars = {};
    mod.configureAiderHost(task, 'task-001', envVars);

    expect(envVars.OLLAMA_NUM_CTX).toBe('16384');
    expect(envVars.OLLAMA_NUM_GPU).toBe('48');
  });

  it('applies per-model tuning profiles', () => {
    const host = { id: 'host-1', url: 'http://localhost:11434', name: 'local' };
    const modelSettings = JSON.stringify({
      'qwen2.5-coder:7b': { num_ctx: 8192, num_gpu: 32 },
    });
    initModule({
      hosts: [host],
      selectResult: { host, reason: 'selected' },
      config: { ollama_model_settings: modelSettings },
    });
    const task = createTask({ model: 'qwen2.5-coder:7b' });
    const envVars = {};
    mod.configureAiderHost(task, 'task-001', envVars);

    expect(envVars.OLLAMA_NUM_CTX).toBe('8192');
    expect(envVars.OLLAMA_NUM_GPU).toBe('32');
  });

  it('ignores malformed per-model settings JSON', () => {
    const host = { id: 'host-1', url: 'http://localhost:11434', name: 'local' };
    initModule({
      hosts: [host],
      selectResult: { host, reason: 'selected' },
      config: { ollama_model_settings: '{"qwen2.5-coder:7b": { "num_ctx": 8192' },
    });
    const task = createTask({ model: 'qwen2.5-coder:7b' });
    const envVars = {};
    mod.configureAiderHost(task, 'task-001', envVars);

    expect(envVars.OLLAMA_NUM_CTX).toBeUndefined();
    expect(envVars.OLLAMA_NUM_GPU).toBeUndefined();
  });

  it('ignores empty per-model settings JSON', () => {
    const host = { id: 'host-1', url: 'http://localhost:11434', name: 'local' };
    initModule({
      hosts: [host],
      selectResult: { host, reason: 'selected' },
      config: { ollama_model_settings: '' },
    });
    const task = createTask({ model: 'qwen2.5-coder:7b' });
    const envVars = {};
    mod.configureAiderHost(task, 'task-001', envVars);

    expect(envVars.OLLAMA_NUM_CTX).toBeUndefined();
    expect(envVars.OLLAMA_NUM_GPU).toBeUndefined();
  });

  it('applies per-task tuning overrides (highest priority)', () => {
    const host = { id: 'host-1', url: 'http://localhost:11434', name: 'local' };
    const modelSettings = JSON.stringify({
      'qwen2.5-coder:7b': { num_ctx: 8192 },
    });
    initModule({
      hosts: [host],
      selectResult: { host, reason: 'selected' },
      hostSettings: { hostName: 'local', num_ctx: 16384 },
      config: { ollama_model_settings: modelSettings },
    });
    const meta = JSON.stringify({ tuning_overrides: { num_ctx: 32768, num_gpu: 99 } });
    const task = createTask({ model: 'qwen2.5-coder:7b', metadata: meta });
    const envVars = {};
    mod.configureAiderHost(task, 'task-001', envVars);

    // Per-task overrides should win (applied last)
    expect(envVars.OLLAMA_NUM_CTX).toBe('32768');
    expect(envVars.OLLAMA_NUM_GPU).toBe('99');
  });

  it('ignores malformed task metadata tuning overrides', () => {
    const host = { id: 'host-1', url: 'http://localhost:11434', name: 'local' };
    const modelSettings = JSON.stringify({
      'qwen2.5-coder:7b': { num_ctx: 8192, num_gpu: 32 },
    });
    initModule({
      hosts: [host],
      selectResult: { host, reason: 'selected' },
      config: { ollama_model_settings: modelSettings },
    });
    const task = createTask({
      model: 'qwen2.5-coder:7b',
      metadata: '{"tuning_overrides": { "num_ctx": 32768 }',
    });
    const envVars = {};
    mod.configureAiderHost(task, 'task-001', envVars);

    expect(envVars.OLLAMA_NUM_CTX).toBe('8192');
    expect(envVars.OLLAMA_NUM_GPU).toBe('32');
  });

  it('ignores empty task metadata when applying tuning overrides', () => {
    const host = { id: 'host-1', url: 'http://localhost:11434', name: 'local' };
    const modelSettings = JSON.stringify({
      'qwen2.5-coder:7b': { num_ctx: 8192, num_gpu: 32 },
    });
    initModule({
      hosts: [host],
      selectResult: { host, reason: 'selected' },
      config: { ollama_model_settings: modelSettings },
    });
    const task = createTask({ model: 'qwen2.5-coder:7b', metadata: '' });
    const envVars = {};
    mod.configureAiderHost(task, 'task-001', envVars);

    expect(envVars.OLLAMA_NUM_CTX).toBe('8192');
    expect(envVars.OLLAMA_NUM_GPU).toBe('32');
  });

  it('sets LITELLM env vars in all modes', () => {
    initModule({ hosts: [] });
    const envVars = {};
    mod.configureAiderHost(createTask(), 'task-001', envVars);

    expect(envVars.LITELLM_NUM_RETRIES).toBe('3');
    expect(envVars.LITELLM_REQUEST_TIMEOUT).toBe('120');
  });
});
