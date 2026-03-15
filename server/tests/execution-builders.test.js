const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

let testDir;
let origDataDir;
let db;
let mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function initExecution(overrides = {}) {
  const helpers = {
    wrapWithInstructions: (taskDescription, provider, model, ctx) => {
      const modelPart = model ? `:${model}` : '';
      const fileContext = ctx && ctx.fileContext ? `\n${ctx.fileContext}` : '';
      return `[${provider}${modelPart}] ${taskDescription}${fileContext}`;
    },
    shellEscape: (s) => s,
    getProjectDefaults: () => ({}),
    buildFileContextString: (fc) => fc || '',
    getEffectiveModel: (task) => task.model || 'qwen3:8b',
    startTask: () => {},
    classifyError: () => 'unknown',
    detectTaskTypes: () => [],
    extractTargetFilesFromDescription: () => [],
    ensureTargetFilesExist: (workingDir, filePaths) =>
      [...new Set(filePaths)].map((p) => path.resolve(workingDir, p)),
    isLargeModelBlockedOnHost: () => ({ blocked: false }),
    resolveWindowsCmdToNode: () => null,
    cancelTask: () => {},
    ...overrides.helpers,
  };

  mod.init({
    db,
    dashboard: { broadcast: () => {}, broadcastTaskUpdate: () => {}, notifyTaskUpdated: () => {} },
    runningProcesses: new Map(),
    apiAbortControllers: new Map(),
    processQueue: () => {},
    helpers,
    NVM_NODE_PATH: overrides.NVM_NODE_PATH !== undefined ? overrides.NVM_NODE_PATH : null,
    QUEUE_LOCK_HOLDER_ID: 'test-lock',
    MAX_OUTPUT_BUFFER: 10 * 1024 * 1024,
    pendingRetryTimeouts: new Map(),
    taskCleanupGuard: new Map(),
    selectHashlineFormat: () => 'diff',
    isHashlineCapableModel: () => true,
    findNextHashlineModel: () => null,
    tryHashlineTieredFallback: () => null,
    hashlineOllamaSystemPrompt: 'test prompt',
    hashlineLiteSystemPrompt: 'test lite prompt',
    tryReserveHostSlotWithFallback: overrides.tryReserveHostSlotWithFallback || (() => ({ success: true })),
  });
}

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-execution-builders-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  mod = require('../providers/execution');
  initExecution();
}

function teardown() {
  try {
    if (db) db.close();
  } catch {}

  if (origDataDir !== undefined) {
    process.env.TORQUE_DATA_DIR = origDataDir;
  } else {
    delete process.env.TORQUE_DATA_DIR;
  }

  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}
}

function resetAiderConfigs() {
  db.setConfig('aider_edit_format', 'diff');
  db.setConfig('aider_map_tokens', '0');
  db.setConfig('aider_auto_commits', '0');
  db.setConfig('aider_subtree_only', '1');
  db.setConfig('aider_auto_switch_format', '0');
  db.setConfig('proactive_format_selection_enabled', '0');
  db.setConfig('aider_model_edit_formats', '');
  db.setConfig('ollama_model_settings', '');
  db.setConfig('ollama_host', 'http://localhost:11434');
}

function clearHosts() {
  for (const host of db.listOllamaHosts()) {
    db.removeOllamaHost(host.id);
  }
}

function addHost({
  id = randomUUID(),
  name = 'test-host',
  url = 'http://127.0.0.1:11434',
  model = 'qwen2.5-coder:7b',
  settings = null,
} = {}) {
  db.addOllamaHost({
    id,
    name,
    url,
    max_concurrent: 2,
    memory_limit_mb: 8192,
  });
  db.updateOllamaHost(id, {
    enabled: 1,
    status: 'healthy',
    running_tasks: 0,
    models_cache: JSON.stringify([{ name: model, size: 4 * 1024 * 1024 * 1024 }]),
    settings: settings ? JSON.stringify(settings) : null,
  });
  return { id, url };
}

describe('execution.js CLI builders', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });

  describe('estimateRequiredContext', () => {
    it('returns small tier for simple typo on one small file', () => {
      const result = mod.estimateRequiredContext('Fix typo in docs', ['README.md']);
      expect(result.contextSize).toBe(4096);
      expect(result.tier).toBe('small');
      expect(result.reason).toContain('Simple task pattern matched');
    });

    it('returns xlarge tier for explicit large-context tasks', () => {
      const result = mod.estimateRequiredContext('Need a large context review entire codebase', ['src/index.js']);
      expect(result.contextSize).toBe(32768);
      expect(result.tier).toBe('xlarge');
      expect(result.reason).toContain('X-large context task pattern matched');
    });

    it('returns large tier when three or more files are involved', () => {
      const result = mod.estimateRequiredContext('Update tests', ['a.js', 'b.js', 'c.js']);
      expect(result.contextSize).toBe(16384);
      expect(result.tier).toBe('large');
      expect(result.reason).toContain('Complex task');
    });

    it('returns medium tier by default for non-matching tasks', () => {
      const result = mod.estimateRequiredContext('Investigate one module', ['notes.bin']);
      expect(result.contextSize).toBe(8192);
      expect(result.tier).toBe('medium');
      expect(result.reason).toContain('Standard task');
    });
  });

  describe('buildAiderOllamaCommand', () => {
    it('builds default single-host command with expected args and env', () => {
      resetAiderConfigs();
      clearHosts();
      initExecution();

      const task = {
        id: randomUUID(),
        provider: 'aider-ollama',
        task_description: 'Patch a file',
        model: 'qwen3:8b',
        files: [],
        retry_count: 0,
        working_directory: testDir,
      };
      const result = mod.buildAiderOllamaCommand(task, 'CTX', []);

      expect(result.selectedOllamaHostId).toBeNull();
      expect(result.usedEditFormat).toBe('diff');
      expect(result.stdinPrompt).toBeNull();
      expect(result.cliPath).toBe(
        process.platform === 'win32'
          ? path.join(os.homedir(), '.local', 'bin', 'aider.exe')
          : path.join(process.env.HOME || os.homedir(), '.local', 'bin', 'aider')
      );
      expect(result.finalArgs).toContain('--model');
      expect(result.finalArgs).toContain('ollama/qwen3:8b');
      expect(result.finalArgs).toContain('--thinking-tokens');
      expect(result.finalArgs).toContain('0');
      expect(result.finalArgs).toContain('--no-check-model-accepts-settings');
      expect(result.finalArgs).toContain('--message');
      expect(result.finalArgs).toContain('[aider-ollama:qwen3:8b] Patch a file\nCTX');
      expect(result.finalArgs).toContain(path.join(path.dirname(require.resolve('../providers/execution')), '..', 'aider-model-metadata.json'));
      expect(result.envExtras.OLLAMA_API_BASE).toBe('http://localhost:11434');
      expect(result.envExtras.LITELLM_NUM_RETRIES).toBe('3');
      expect(result.envExtras.LITELLM_REQUEST_TIMEOUT).toBe('120');
    });

    it('adds unique resolved target file paths to aider args', () => {
      resetAiderConfigs();
      clearHosts();
      initExecution({
        helpers: {
          extractTargetFilesFromDescription: () => ['src/from-desc.js', 'src/from-task.js'],
          ensureTargetFilesExist: (workingDir, filePaths) =>
            [...new Set(filePaths)].map((p) => path.resolve(workingDir, p)),
        },
      });

      const task = {
        id: randomUUID(),
        provider: 'aider-ollama',
        task_description: 'Update src/from-desc.js and src/from-task.js',
        model: 'qwen2.5-coder:7b',
        files: ['src/from-task.js'],
        retry_count: 0,
        working_directory: testDir,
      };
      const result = mod.buildAiderOllamaCommand(task, '', ['src/from-resolved.js', 'src/from-task.js']);

      expect(result.finalArgs).toContain(path.resolve(testDir, 'src/from-task.js'));
      expect(result.finalArgs).toContain(path.resolve(testDir, 'src/from-desc.js'));
      expect(result.finalArgs).toContain(path.resolve(testDir, 'src/from-resolved.js'));
      expect(result.finalArgs.filter((a) => a === path.resolve(testDir, 'src/from-task.js')).length).toBe(1);
    });

    it('uses model-specific edit format when configured', () => {
      resetAiderConfigs();
      clearHosts();
      db.setConfig('aider_model_edit_formats', JSON.stringify({ 'qwen2.5-coder': 'whole' }));
      initExecution();

      const task = {
        id: randomUUID(),
        provider: 'aider-ollama',
        task_description: 'Adjust file',
        model: 'qwen2.5-coder:7b',
        retry_count: 0,
        working_directory: testDir,
      };
      const result = mod.buildAiderOllamaCommand(task, '', []);

      expect(result.usedEditFormat).toBe('whole');
      const editFlagIndex = result.finalArgs.indexOf('--edit-format');
      expect(editFlagIndex).toBeGreaterThan(-1);
      expect(result.finalArgs[editFlagIndex + 1]).toBe('whole');
    });

    it('applies stall recovery edit format over model format', () => {
      resetAiderConfigs();
      clearHosts();
      db.setConfig('aider_model_edit_formats', JSON.stringify({ 'qwen2.5-coder': 'whole' }));
      initExecution();

      const task = {
        id: randomUUID(),
        provider: 'aider-ollama',
        task_description: 'Adjust file',
        model: 'qwen2.5-coder:7b',
        retry_count: 0,
        metadata: JSON.stringify({ stallRecoveryEditFormat: 'diff' }),
        working_directory: testDir,
      };
      const result = mod.buildAiderOllamaCommand(task, '', []);

      expect(result.usedEditFormat).toBe('diff');
      const editFlagIndex = result.finalArgs.indexOf('--edit-format');
      expect(result.finalArgs[editFlagIndex + 1]).toBe('diff');
    });

    it('selects registered host and applies host/model/task tuning precedence', () => {
      resetAiderConfigs();
      clearHosts();
      const host = addHost({
        name: 'host-a',
        url: 'http://10.0.0.5:11434',
        settings: { num_ctx: 2048, num_gpu: 1, num_thread: 2 },
      });
      db.setConfig('ollama_model_settings', JSON.stringify({
        'qwen2.5-coder:7b': { num_ctx: 4096, num_gpu: 2, num_thread: 4 },
      }));
      initExecution({
        tryReserveHostSlotWithFallback: () => ({ success: true }),
      });

      const task = {
        id: randomUUID(),
        provider: 'aider-ollama',
        task_description: 'Tune model',
        model: 'qwen2.5-coder:7b',
        retry_count: 0,
        metadata: JSON.stringify({ tuning_overrides: { num_ctx: 8192, num_gpu: 3, num_thread: 6 } }),
        working_directory: testDir,
      };
      const result = mod.buildAiderOllamaCommand(task, '', []);

      expect(result.selectedOllamaHostId).toBe(host.id);
      expect(result.envExtras.OLLAMA_API_BASE).toBe('http://10.0.0.5:11434');
      expect(result.envExtras.OLLAMA_NUM_CTX).toBe('8192');
      expect(result.envExtras.OLLAMA_NUM_GPU).toBe('3');
      expect(result.envExtras.OLLAMA_NUM_THREAD).toBe('6');
      expect(result.envExtras.LITELLM_NUM_RETRIES).toBe('3');
      expect(result.envExtras.LITELLM_REQUEST_TIMEOUT).toBe('120');
    });

    it('returns requeued result when host slot reservation fails', () => {
      resetAiderConfigs();
      clearHosts();
      addHost();
      initExecution({
        tryReserveHostSlotWithFallback: () => ({ success: false, reason: 'host at capacity' }),
      });

      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Task for requeue',
        status: 'running',
        provider: 'aider-ollama',
        working_directory: testDir,
      });

      const task = {
        id: taskId,
        provider: 'aider-ollama',
        task_description: 'Task for requeue',
        model: 'qwen2.5-coder:7b',
        retry_count: 0,
        error_output: 'prior',
        working_directory: testDir,
      };
      const result = mod.buildAiderOllamaCommand(task, '', []);

      expect(result).toEqual({ requeued: true, reason: 'host at capacity' });
      expect(db.getTask(taskId).status).toBe('queued');
    });
  });

  describe('buildClaudeCliCommand', () => {
    it('builds default claude-cli command with stdin prompt', () => {
      initExecution();
      const task = {
        id: randomUUID(),
        provider: 'claude-cli',
        task_description: 'Review this change',
        working_directory: testDir,
      };
      const result = mod.buildClaudeCliCommand(task, 'FILECTX', null);

      expect(result.cliPath).toBe(process.platform === 'win32' ? 'claude.cmd' : 'claude');
      expect(result.finalArgs).toEqual([
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
        '--strict-mcp-config',
        '-p',
      ]);
      expect(result.stdinPrompt).toBe('[claude-cli] Review this change\nFILECTX');
      expect(result.envExtras).toEqual({});
      expect(result.selectedOllamaHostId).toBeNull();
      expect(result.usedEditFormat).toBeNull();
    });

    it('uses provider cli_path and appends .cmd on Windows if needed', () => {
      initExecution();
      const task = {
        id: randomUUID(),
        provider: 'claude-cli',
        task_description: 'Review this change',
      };
      const basePath = process.platform === 'win32' ? path.join(testDir, 'claude-custom') : '/usr/local/bin/claude-custom';
      const result = mod.buildClaudeCliCommand(task, '', { cli_path: basePath });

      const expectedPath = process.platform === 'win32' ? `${basePath}.cmd` : basePath;
      expect(result.cliPath).toBe(expectedPath);
    });
  });

  describe('buildCodexCommand', () => {
    it('builds codex command with model/full-auto/cwd and stdin dash', () => {
      initExecution();
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Implement tests',
        model: 'gpt-5-codex',
        auto_approve: 0,
        working_directory: testDir,
      };
      const result = mod.buildCodexCommand(task, 'CTX', null);

      expect(result.cliPath).toBe(process.platform === 'win32' ? 'codex.cmd' : 'codex');
      expect(result.finalArgs).toContain('exec');
      expect(result.finalArgs).toContain('--skip-git-repo-check');
      expect(result.finalArgs).toContain('--full-auto');
      expect(result.finalArgs).toContain('-m');
      expect(result.finalArgs).toContain('gpt-5-codex');
      expect(result.finalArgs).toContain('-C');
      expect(result.finalArgs).toContain(testDir);
      expect(result.finalArgs[result.finalArgs.length - 1]).toBe('-');
      expect(result.stdinPrompt).toBe('[codex] Implement tests\nCTX');
      expect(result.envExtras).toEqual({});
    });

    it('uses bypass approvals flag when auto_approve is set', () => {
      initExecution();
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Implement tests',
        auto_approve: 1,
      };
      const result = mod.buildCodexCommand(task, '', null);

      expect(result.finalArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(result.finalArgs).not.toContain('--full-auto');
    });

    it('uses provider cli_path and appends .cmd on Windows if missing extension', () => {
      initExecution();
      const task = {
        id: randomUUID(),
        provider: 'codex',
        task_description: 'Implement tests',
      };
      const basePath = process.platform === 'win32' ? path.join(testDir, 'codex-custom') : '/usr/local/bin/codex-custom';
      const result = mod.buildCodexCommand(task, '', { cli_path: basePath });

      const expectedPath = process.platform === 'win32' ? `${basePath}.cmd` : basePath;
      expect(result.cliPath).toBe(expectedPath);
    });

  });
});
