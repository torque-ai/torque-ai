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

// resetAiderConfigs removed — aider provider no longer exists

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

  // buildAiderOllamaCommand tests removed — aider provider no longer exists

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
