/**
 * Unit tests for server/handlers/automation-handlers.js main handlers.
 *
 * Loads the CommonJS source with injected mocks so database, task-manager,
 * filesystem, command execution, and router dependencies stay isolated.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { ErrorCodes, makeError } = require('../handlers/error-codes');
const { TEST_MODELS } = require('./test-helpers');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function buildLines(count, prefix = 'line') {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');
}

function extractJsonBlock(text) {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  return match ? JSON.parse(match[1]) : null;
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockTaskManager() {
  return {
    startTask: vi.fn(),
  };
}

function createMockDb(options = {}) {
  const configStore = new Map(Object.entries(options.config || {}));
  const projectConfigs = new Map(Object.entries(options.projectConfigs || {}));
  const projectMetadata = new Map(
    Object.entries(options.projectMetadata || {}).map(([project, metadata]) => [project, { ...metadata }])
  );
  const tasks = new Map(Object.entries(options.tasks || {}));

  const db = {
    __stores: { configStore, projectConfigs, projectMetadata, tasks },
    setConfig: vi.fn((key, value) => {
      configStore.set(key, value);
    }),
    getConfig: vi.fn((key) => (configStore.has(key) ? configStore.get(key) : null)),
    getTask: vi.fn((taskId) => tasks.get(taskId) ?? null),
    createTask: vi.fn((payload) => payload),
    safeAddColumn: vi.fn(),
    getProjectFromPath: vi.fn((workingDir) => {
      if (options.projectFromPath && Object.prototype.hasOwnProperty.call(options.projectFromPath, workingDir)) {
        return options.projectFromPath[workingDir];
      }
      return options.defaultProject === undefined ? 'torque' : options.defaultProject;
    }),
    setProjectConfig: vi.fn((project, update) => {
      const next = { ...(projectConfigs.get(project) || {}), ...update };
      projectConfigs.set(project, next);
      return next;
    }),
    getProjectConfig: vi.fn((project) => projectConfigs.get(project) ?? null),
    setProjectMetadata: vi.fn((project, key, value) => {
      const next = { ...(projectMetadata.get(project) || {}) };
      next[key] = value;
      projectMetadata.set(project, next);
    }),
    getProjectMetadata: vi.fn((project, key) => {
      const metadata = projectMetadata.get(project);
      return metadata && Object.prototype.hasOwnProperty.call(metadata, key) ? metadata[key] : null;
    }),
    getWorkflow: vi.fn((workflowId) => {
      const workflow = options.workflow ?? null;
      if (!workflow) return null;
      if (!workflow.id || workflow.id === workflowId) return workflow;
      return null;
    }),
    getWorkflowStatus: vi.fn((workflowId) => {
      const status = options.workflowStatus ?? null;
      if (!status) return null;
      if (!status.id || status.id === workflowId) return status;
      return null;
    }),
  };

  if (options.methods) {
    Object.assign(db, options.methods);
  }

  return db;
}

function createDirent(name, kind) {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

function createVirtualFs(initialEntries = {}) {
  const dirs = new Set();
  const files = new Map();
  const writes = [];

  function normalizeFsPath(targetPath) {
    return path.resolve(targetPath);
  }

  function ensureDir(dirPath) {
    const resolved = normalizeFsPath(dirPath);
    if (dirs.has(resolved)) return;
    const parent = path.dirname(resolved);
    if (parent !== resolved) {
      ensureDir(parent);
    }
    dirs.add(resolved);
  }

  function addFile(filePath, content = '') {
    const resolved = normalizeFsPath(filePath);
    ensureDir(path.dirname(resolved));
    files.set(resolved, String(content));
  }

  function addDir(dirPath) {
    ensureDir(dirPath);
  }

  for (const [entryPath, value] of Object.entries(initialEntries)) {
    if (value && typeof value === 'object' && value.type === 'dir') {
      addDir(entryPath);
    } else {
      addFile(entryPath, value);
    }
  }

  const fsMock = {
    existsSync: vi.fn((targetPath) => {
      const resolved = normalizeFsPath(targetPath);
      return dirs.has(resolved) || files.has(resolved);
    }),
    readdirSync: vi.fn((dirPath, options = undefined) => {
      const resolved = normalizeFsPath(dirPath);
      if (!dirs.has(resolved)) {
        const error = new Error(`ENOENT: no such file or directory, scandir '${dirPath}'`);
        error.code = 'ENOENT';
        throw error;
      }

      const children = new Map();
      for (const dir of dirs) {
        if (dir !== resolved && path.dirname(dir) === resolved) {
          children.set(path.basename(dir), createDirent(path.basename(dir), 'dir'));
        }
      }
      for (const filePath of files.keys()) {
        if (path.dirname(filePath) === resolved) {
          children.set(path.basename(filePath), createDirent(path.basename(filePath), 'file'));
        }
      }

      const sorted = Array.from(children.values()).sort((a, b) => a.name.localeCompare(b.name));
      if (options && options.withFileTypes) {
        return sorted;
      }
      return sorted.map((entry) => entry.name);
    }),
    readFileSync: vi.fn((filePath) => {
      const resolved = normalizeFsPath(filePath);
      if (!files.has(resolved)) {
        const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(resolved);
    }),
    writeFileSync: vi.fn((filePath, content) => {
      const resolved = normalizeFsPath(filePath);
      ensureDir(path.dirname(resolved));
      const text = String(content);
      files.set(resolved, text);
      writes.push({ path: resolved, content: text });
    }),
    __addDir: addDir,
    __addFile: addFile,
    __getFile: (filePath) => files.get(normalizeFsPath(filePath)),
    __writes: writes,
  };

  return fsMock;
}

function loadAutomationModule(overrides = {}) {
  const resolvedPath = path.resolve(__dirname, '../handlers/automation-handlers.js');
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const requireFromModule = createRequire(resolvedPath);

  const mockDb = overrides.db || createMockDb(overrides.dbOptions);
  const mockDatabase = overrides.database || {
    safeAddColumn: mockDb.safeAddColumn,
  };
  const mockConfigCore = overrides.configCore || {
    __stores: mockDb.__stores,
    setConfig: mockDb.setConfig,
    getConfig: mockDb.getConfig,
  };
  const mockTaskCore = overrides.taskCore || {
    getTask: mockDb.getTask,
    createTask: mockDb.createTask,
  };
  const mockProjectConfigCore = overrides.projectConfigCore || {
    getProjectFromPath: mockDb.getProjectFromPath,
    setProjectConfig: mockDb.setProjectConfig,
    getProjectConfig: mockDb.getProjectConfig,
    setProjectMetadata: mockDb.setProjectMetadata,
    getProjectMetadata: mockDb.getProjectMetadata,
  };
  const mockWorkflowEngine = overrides.workflowEngine || {
    getWorkflow: mockDb.getWorkflow,
    getWorkflowStatus: mockDb.getWorkflowStatus,
  };
  const mockTaskManager = overrides.taskManager || createMockTaskManager();
  const mockFs = overrides.fs || createVirtualFs();
  const mockLogger = overrides.logger || createMockLogger();
  const mockRouter = overrides.router || {
    runVerifyCommand: vi.fn(async () => ({
      output: '',
      error: '',
      exitCode: 0,
      remote: false,
      durationMs: 0,
    })),
  };
  const createTestRunnerRegistry = overrides.createTestRunnerRegistry || vi.fn(() => mockRouter);
  const buildErrorFeedbackPrompt = overrides.buildErrorFeedbackPrompt || vi.fn((prompt) => `[error-feedback]\n${prompt}`);
  const safeExecChain = overrides.safeExecChain || vi.fn(() => ({ exitCode: 0, output: '', error: '' }));
  const executeValidatedCommandSync = overrides.executeValidatedCommandSync || vi.fn(() => '');
  const uuidV4 = overrides.uuidV4 || vi.fn(() => '12345678-aaaa-bbbb-cccc-123456789012');
  const indexModule = overrides.indexModule || {
    getTestRunnerRegistry: vi.fn(() => overrides.testRunnerRegistry || null),
  };

  const throwRequests = new Map(Object.entries(overrides.throwRequests || {}));
  const requireCounts = {};

  const injectedModules = {
    path,
    fs: mockFs,
    '../constants': { TASK_TIMEOUTS: { GIT_DIFF: 5000, TEST_RUN: 120000, VERIFY_COMMAND: 120000 } },
    '../utils/context-enrichment': { buildErrorFeedbackPrompt },
    '../utils/safe-exec': { safeExecChain },
    '../execution/command-policy': { executeValidatedCommandSync },
    './shared': { ErrorCodes, makeError },
    '../test-runner-registry': { createTestRunnerRegistry },
    '../logger': { child: vi.fn(() => mockLogger) },
    '../database': mockDatabase,
    '../db/config-core': mockConfigCore,
    '../db/task-core': mockTaskCore,
    '../db/project-config-core': mockProjectConfigCore,
    '../db/workflow-engine': mockWorkflowEngine,
    '../task-manager': mockTaskManager,
    '../index': indexModule,
    uuid: { v4: uuidV4 },
    './automation-ts-tools': {},
    './automation-batch-orchestration': {},
    ...(overrides.extraModules || {}),
  };

  const exportedModule = { exports: {} };
  const customRequire = (request) => {
    requireCounts[request] = (requireCounts[request] || 0) + 1;
    if (throwRequests.has(request)) {
      throw throwRequests.get(request);
    }
    if (Object.prototype.hasOwnProperty.call(injectedModules, request)) {
      return injectedModules[request];
    }
    return requireFromModule(request);
  };

  const compiled = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    `const db = database;
${source}
module.exports.__testHelpers = {
  sanitizeTemplateVariable,
  db,
  taskManager,
  getVerifyRouter,
  findRelatedExistingTestPath,
  scanDirectory,
  formatProjectConfig,
};
`,
  );

  compiled(customRequire, exportedModule, exportedModule.exports, resolvedPath, path.dirname(resolvedPath));

  return {
    handlers: exportedModule.exports,
    helpers: exportedModule.exports.__testHelpers,
    mocks: {
      db: mockDatabase,
      configCore: mockConfigCore,
      taskCore: mockTaskCore,
      projectConfigCore: mockProjectConfigCore,
      workflowEngine: mockWorkflowEngine,
      taskManager: mockTaskManager,
      fs: mockFs,
      logger: mockLogger,
      router: mockRouter,
      createTestRunnerRegistry,
      buildErrorFeedbackPrompt,
      safeExecChain,
      executeValidatedCommandSync,
      uuidV4,
      indexModule,
    },
    requireCounts,
  };
}

describe('automation-handlers main unit suite', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('helpers', () => {
    it('sanitizeTemplateVariable truncates long values and strips shell template syntax', () => {
      const { helpers } = loadAutomationModule();

      const result = helpers.sanitizeTemplateVariable('`$(danger)${expr}`' + 'x'.repeat(10250));

      expect(result).toContain('... [truncated]');
      expect(result).not.toContain('`');
      expect(result).not.toContain('$(');
      expect(result).not.toContain('${');
      expect(result).toContain('(danger)');
      expect(result).toContain('{expr}');
    });

    it('sanitizeTemplateVariable stringifies non-string values', () => {
      const { helpers } = loadAutomationModule();

      expect(helpers.sanitizeTemplateVariable(42)).toBe('42');
    });

    it('lazy-loads database and task-manager only once', () => {
      const { helpers, mocks, requireCounts } = loadAutomationModule();

      expect(helpers.db()).toBe(mocks.db);
      expect(helpers.db()).toBe(mocks.db);
      expect(helpers.taskManager()).toBe(mocks.taskManager);
      expect(helpers.taskManager()).toBe(mocks.taskManager);
      expect(requireCounts['../database']).toBe(1);
      expect(requireCounts['../task-manager']).toBe(1);
    });

    it('getVerifyRouter memoizes the registry returned by the index module', () => {
      const router = { runVerifyCommand: vi.fn() };
      const createTestRunnerRegistry = vi.fn(() => ({ runVerifyCommand: vi.fn() }));
      const indexModule = { getTestRunnerRegistry: vi.fn(() => router) };
      const { helpers, mocks } = loadAutomationModule({
        createTestRunnerRegistry,
        indexModule,
      });

      expect(helpers.getVerifyRouter()).toBe(router);
      expect(helpers.getVerifyRouter()).toBe(router);
      expect(createTestRunnerRegistry).not.toHaveBeenCalled();
      expect(mocks.indexModule.getTestRunnerRegistry).toHaveBeenCalledTimes(1);
    });

    it('getVerifyRouter falls back to createTestRunnerRegistry when the index module cannot be loaded', () => {
      const router = { runVerifyCommand: vi.fn() };
      const createTestRunnerRegistry = vi.fn(() => router);
      const { helpers, mocks } = loadAutomationModule({
        createTestRunnerRegistry,
        throwRequests: { '../index': new Error('index unavailable') },
      });

      expect(helpers.getVerifyRouter()).toBe(router);
      expect(createTestRunnerRegistry).toHaveBeenCalledTimes(1);
      expect(mocks.indexModule.getTestRunnerRegistry).not.toHaveBeenCalled();
    });

    it('findRelatedExistingTestPath prefers exact __tests__ matches', () => {
      const { helpers } = loadAutomationModule();
      const testFiles = new Set(['src/core/__tests__/queue.test.ts']);

      const result = helpers.findRelatedExistingTestPath('src/core/queue.ts', testFiles, '.test.ts');

      expect(result).toBe('src/core/__tests__/queue.test.ts');
    });

    it('findRelatedExistingTestPath falls back to suffix-based matches in sibling tests directories', () => {
      const { helpers } = loadAutomationModule();
      const testFiles = new Set(['tests/handler-task-pipeline.test.js']);

      const result = helpers.findRelatedExistingTestPath('src/handlers/task-pipeline.js', testFiles, '.test.js');

      expect(result).toBe('tests/handler-task-pipeline.test.js');
    });

    it('findRelatedExistingTestPath returns null when no related tests exist', () => {
      const { helpers } = loadAutomationModule();
      const testFiles = new Set(['src/core/__tests__/other.test.ts']);

      expect(helpers.findRelatedExistingTestPath('src/core/queue.ts', testFiles, '.test.ts')).toBeNull();
    });

    it('scanDirectory collects source files and recognizes test files', () => {
      const workingDir = 'C:\\repo';
      const fsMock = createVirtualFs({
        [path.join(workingDir, 'src', 'core', 'queue.ts')]: buildLines(3, 'queue'),
        [path.join(workingDir, 'src', 'core', 'queue.test.ts')]: 'export {}',
        [path.join(workingDir, 'src', 'core', 'queue.spec.js')]: 'export {}',
        [path.join(workingDir, 'src', 'ui', 'panel.jsx')]: buildLines(4, 'panel'),
      });
      const { helpers } = loadAutomationModule({ fs: fsMock });
      const sourceFiles = [];
      const testFiles = new Set();

      helpers.scanDirectory(path.join(workingDir, 'src'), workingDir, sourceFiles, testFiles, '.test.ts');

      expect(sourceFiles).toEqual([
        { relativePath: 'src/core/queue.ts', lines: 3 },
        { relativePath: 'src/ui/panel.jsx', lines: 4 },
      ]);
      expect(Array.from(testFiles).sort()).toEqual([
        'src/core/queue.spec.js',
        'src/core/queue.test.ts',
      ]);
    });

    it('scanDirectory ignores build output, coverage, and mock directories', () => {
      const workingDir = 'C:\\repo';
      const fsMock = createVirtualFs({
        [path.join(workingDir, 'src', 'main.ts')]: buildLines(2, 'main'),
        [path.join(workingDir, 'src', 'node_modules', 'pkg.js')]: buildLines(2, 'pkg'),
        [path.join(workingDir, 'src', 'dist', 'bundle.js')]: buildLines(2, 'bundle'),
        [path.join(workingDir, 'src', '__mocks__', 'file.js')]: buildLines(2, 'mock'),
        [path.join(workingDir, 'src', 'coverage', 'report.js')]: buildLines(2, 'coverage'),
      });
      const { helpers } = loadAutomationModule({ fs: fsMock });
      const sourceFiles = [];
      const testFiles = new Set();

      helpers.scanDirectory(path.join(workingDir, 'src'), workingDir, sourceFiles, testFiles, '.test.ts');

      expect(sourceFiles).toEqual([{ relativePath: 'src/main.ts', lines: 2 }]);
      expect(testFiles.size).toBe(0);
    });

    it('scanDirectory tolerates file read failures by recording zero lines', () => {
      const workingDir = 'C:\\repo';
      const fsMock = createVirtualFs({
        [path.join(workingDir, 'src', 'broken.js')]: buildLines(5, 'broken'),
      });
      const baseReadFileSync = fsMock.readFileSync.getMockImplementation();
      fsMock.readFileSync.mockImplementation((filePath, encoding) => {
        if (path.basename(filePath) === 'broken.js') {
          throw new Error('read failed');
        }
        return baseReadFileSync(filePath, encoding);
      });
      const { helpers } = loadAutomationModule({ fs: fsMock });
      const sourceFiles = [];
      const testFiles = new Set();

      helpers.scanDirectory(path.join(workingDir, 'src'), workingDir, sourceFiles, testFiles, '.test.ts');

      expect(sourceFiles).toEqual([{ relativePath: 'src/broken.js', lines: 0 }]);
    });
  });

  describe('handleConfigureStallDetection', () => {
    it('writes all provider thresholds, enables recovery, and reports current settings', () => {
      const { handlers, mocks } = loadAutomationModule();

      const result = handlers.handleConfigureStallDetection({
        provider: 'all',
        stall_threshold_seconds: 180,
        auto_resubmit: true,
        max_resubmit_attempts: 4,
      });
      const text = getText(result);

      expect(mocks.configCore.__stores.configStore.get('stall_threshold_codex')).toBe('180');
      expect(mocks.configCore.__stores.configStore.get('stall_threshold_ollama')).toBe('180');
      expect(mocks.configCore.__stores.configStore.get('stall_threshold_hashline')).toBe('180');
      expect(mocks.configCore.__stores.configStore.get('stall_threshold_claude')).toBe('180');
      expect(mocks.configCore.__stores.configStore.get('stall_auto_resubmit')).toBe('1');
      expect(mocks.configCore.__stores.configStore.get('stall_recovery_max_attempts')).toBe('4');
      expect(mocks.configCore.__stores.configStore.get('auto_cancel_stalled')).toBe('1');
      expect(mocks.configCore.__stores.configStore.get('stall_recovery_enabled')).toBe('1');
      expect(text).toContain('Set stall threshold to 180s for all providers');
      expect(text).toContain('**Auto-resubmit:** Yes');
      expect(text).toContain('**Max attempts:** 4');
      expect(text).toContain('**Recovery enabled:** true');
    });

    it('returns current settings when no changes are requested', () => {
      const db = createMockDb({
        config: {
          stall_threshold_codex: '240',
          stall_threshold_ollama: '120',
          stall_threshold_hashline: '90',
          stall_threshold_claude: 'null (excluded)',
          stall_auto_resubmit: '0',
          stall_recovery_max_attempts: '2',
          stall_recovery_enabled: '0',
        },
      });
      const { handlers } = loadAutomationModule({ db });

      const result = handlers.handleConfigureStallDetection({});
      const text = getText(result);

      expect(text).not.toContain('Changes Applied');
      expect(text).toContain('| codex | 240 |');
      expect(text).toContain('**Auto-resubmit:** No');
      expect(text).toContain('**Recovery enabled:** false');
    });
  });

  describe('handleConfigureQuotaAutoScale', () => {
    it('clamps thresholds and stores the configuration', () => {
      const { handlers, mocks } = loadAutomationModule();

      const result = handlers.handleConfigureQuotaAutoScale({
        enabled: true,
        queue_depth_threshold: 0.3,
        cooldown_seconds: -8,
      });
      const text = getText(result);

      expect(mocks.configCore.__stores.configStore.get('quota_auto_scale_enabled')).toBe('true');
      expect(mocks.configCore.__stores.configStore.get('quota_queue_depth_threshold')).toBe('1');
      expect(mocks.configCore.__stores.configStore.get('quota_cooldown_seconds')).toBe('0');
      expect(text).toContain('Free-tier auto-scale: enabled');
      expect(text).toContain('| Queue depth threshold | 1 |');
      expect(text).toContain('| Cooldown (seconds) | 0 |');
    });

    it('shows default values when no config exists', () => {
      const { handlers } = loadAutomationModule();

      const result = handlers.handleConfigureQuotaAutoScale({});
      const text = getText(result);

      expect(text).toContain('| Enabled | false |');
      expect(text).toContain('| Queue depth threshold | 3 |');
      expect(text).toContain('| Cooldown (seconds) | 60 |');
    });
  });

  describe('handleAutoVerifyAndFix', () => {
    it('returns a missing parameter error when working_directory is absent', async () => {
      const { handlers } = loadAutomationModule();

      const result = await handlers.handleAutoVerifyAndFix({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('working_directory is required');
    });

    it('reports successful verification with remote execution details', async () => {
      const workingDir = 'C:\\repo';
      const router = {
        runVerifyCommand: vi.fn(async () => ({
          output: 'ok',
          error: '',
          exitCode: 0,
          remote: true,
          durationMs: 1500,
        })),
      };
      const { handlers } = loadAutomationModule({ router });

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: workingDir,
        verify_command: 'pnpm typecheck',
        timeout_seconds: 9,
      });
      const text = getText(result);

      expect(router.runVerifyCommand).toHaveBeenCalledWith('pnpm typecheck', workingDir, { timeout: 9000 });
      expect(text).toContain('### Result: PASSED');
      expect(text).toContain('**Execution:** remote (agent)');
      expect(text).toContain('**Duration:** 1.5s');
    });

    it('parses TypeScript failures without auto-submitting fixes when auto_fix is false', async () => {
      const router = {
        runVerifyCommand: vi.fn(async () => ({
          output: [
            'src/foo.ts(12,5): error TS2322: Type "string" is not assignable to type "number".',
            'src\\bar.ts(1,1): error TS7006: Parameter "value" implicitly has an "any" type.',
          ].join('\n'),
          error: '',
          exitCode: 2,
          remote: false,
          durationMs: 0,
        })),
      };
      const { handlers, mocks } = loadAutomationModule({ router });

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        auto_fix: false,
      });
      const text = getText(result);

      expect(text).toContain('FAILED (2 errors in 2 files)');
      expect(text).toContain('**src/foo.ts:**');
      expect(text).toContain('**src/bar.ts:**');
      expect(text).toContain('Summary:** 2 errors, 0 fix tasks submitted');
      expect(mocks.taskCore.createTask).not.toHaveBeenCalled();
    });

    it('submits fix tasks with error-feedback context when a source task is provided', async () => {
      const router = {
        runVerifyCommand: vi.fn(async () => ({
          output: [
            'src/app.ts(8,2): error TS2304: Cannot find name "missingThing".',
            'src/app.ts(12,4): error TS2345: Argument of type "string" is not assignable to parameter of type "number".',
          ].join('\n'),
          error: '',
          exitCode: 2,
          remote: false,
          durationMs: 0,
        })),
      };
      const db = createMockDb({
        tasks: {
          'source-task': { id: 'source-task', output: 'original task context' },
        },
      });
      db.createTask.mockReturnValue({ id: '12345678-abcd-efgh' });
      const buildErrorFeedbackPrompt = vi.fn(() => 'FEEDBACK PROMPT');
      const { handlers, mocks } = loadAutomationModule({
        db,
        router,
        buildErrorFeedbackPrompt,
      });

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        source_task_id: 'source-task',
        fix_provider: 'ollama',
      });
      const text = getText(result);

      expect(buildErrorFeedbackPrompt).toHaveBeenCalledWith(
        expect.stringContaining('Fix TypeScript errors in src/app.ts'),
        'original task context',
        expect.stringContaining('TS2304'),
      );
      expect(mocks.uuidV4).toHaveBeenCalledTimes(1);
      expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({
        id: '12345678-aaaa-bbbb-cccc-123456789012',
        task_description: 'FEEDBACK PROMPT',
        provider: null,
        timeout_minutes: 10,
        priority: 5,
      }));
      // Fix tasks now use deferred assignment with intended_provider in metadata
      const createTaskCall = db.createTask.mock.calls[0][0];
      const fixMeta = JSON.parse(createTaskCall.metadata);
      expect(fixMeta.intended_provider).toBe('ollama');
      expect(mocks.taskManager.startTask).toHaveBeenCalledWith('12345678-abcd-efgh');
      expect(text).toContain('Task `12345678` submitted to ollama');
      expect(text).toContain('Summary:** 2 errors, 1 fix tasks submitted');
    });

    it('reports fix task submission failures inline', async () => {
      const router = {
        runVerifyCommand: vi.fn(async () => ({
          output: 'src/app.ts(8,2): error TS2304: Cannot find name "missingThing".',
          error: '',
          exitCode: 2,
          remote: false,
          durationMs: 0,
        })),
      };
      const db = createMockDb();
      db.createTask.mockImplementation(() => {
        throw new Error('db down');
      });
      const { handlers, mocks } = loadAutomationModule({ db, router });

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
      });
      const text = getText(result);

      expect(mocks.taskManager.startTask).not.toHaveBeenCalled();
      expect(text).toContain('Failed to submit fix task — db down');
      expect(text).toContain('Summary:** 1 errors, 0 fix tasks submitted');
    });

    it('returns an internal error when verification throws unexpectedly', async () => {
      const router = {
        runVerifyCommand: vi.fn(async () => {
          throw new Error('router exploded');
        }),
      };
      const { handlers } = loadAutomationModule({ router });

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain(`${ErrorCodes.INTERNAL_ERROR.code}: router exploded`);
    });
  });

  describe('handleGenerateTestTasks', () => {
    it('returns a missing parameter error when working_directory is absent', () => {
      const { handlers } = loadAutomationModule();

      const result = handlers.handleGenerateTestTasks({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('working_directory is required');
    });

    it('rejects non-string source_dirs values', () => {
      const { handlers } = loadAutomationModule();

      const result = handlers.handleGenerateTestTasks({
        working_directory: 'C:\\repo',
        source_dirs: ['src', 7],
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('source_dirs must be an array of strings or a string');
    });

    it('reports when no suitable untested files remain after filtering', () => {
      const workingDir = 'C:\\repo';
      const fsMock = createVirtualFs({
        [path.join(workingDir, 'src', 'main.ts')]: buildLines(30, 'main'),
        [path.join(workingDir, 'src', 'tiny.ts')]: buildLines(3, 'tiny'),
      });
      const { handlers } = loadAutomationModule({ fs: fsMock });

      const result = handlers.handleGenerateTestTasks({ working_directory: workingDir });
      const text = getText(result);

      expect(text).toContain('Test Gap Analysis');
      expect(text).toContain('No suitable untested files found.');
    });

    it('reuses an existing related test file outside __tests__ when generating tasks', () => {
      const workingDir = 'C:\\repo';
      const fsMock = createVirtualFs({
        [path.join(workingDir, 'src', 'handlers', 'task-pipeline.js')]: buildLines(40, 'pipeline'),
        [path.join(workingDir, 'tests', 'handler-task-pipeline.test.js')]: 'export {}',
      });
      const { handlers } = loadAutomationModule({ fs: fsMock });

      const result = handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        source_dirs: ['src/handlers', 'tests'],
        test_pattern: '.test.js',
        count: 1,
      });
      const text = getText(result);
      const json = extractJsonBlock(text);

      expect(text).toContain('| src/handlers/task-pipeline.js | 40 | tests/handler-task-pipeline.test.js |');
      expect(json).toHaveLength(1);
      expect(json[0].task).toContain('Extend the existing test file tests/handler-task-pipeline.test.js');
    });

    it('auto-submits generated tasks and starts the task manager', () => {
      const workingDir = 'C:\\repo';
      const fsMock = createVirtualFs({
        [path.join(workingDir, 'src', 'systems', 'QueueSystem.ts')]: buildLines(32, 'queue-system'),
      });
      const db = createMockDb();
      db.createTask.mockReturnValue({ id: 'testtask1-abcdef' });
      const { handlers, mocks } = loadAutomationModule({ fs: fsMock, db });

      const result = handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        auto_submit: true,
        provider: 'claude-cli',
        count: 1,
      });
      const text = getText(result);

      expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude-cli',
        working_directory: workingDir,
        timeout_minutes: 15,
      }));
      expect(db.createTask.mock.calls[0][0].task_description).toContain('with ~8 tests');
      expect(mocks.taskManager.startTask).toHaveBeenCalledWith('testtask1-abcdef');
      expect(text).toContain('submitted');
      expect(text).toContain('Submitted 1 test tasks to claude-cli.');
    });
  });

  describe('project defaults handlers', () => {
    it('handleSetProjectDefaults rejects a missing working directory', () => {
      const { handlers } = loadAutomationModule();

      const result = handlers.handleSetProjectDefaults({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('working_directory is required');
    });

    it('handleSetProjectDefaults rejects unsupported providers', () => {
      const { handlers } = loadAutomationModule();

      const result = handlers.handleSetProjectDefaults({
        working_directory: 'C:\\repo',
        provider: 'nonexistent-provider',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Invalid provider "nonexistent-provider"');
    });

    it('handleSetProjectDefaults persists config updates, remote test settings, and step providers', () => {
      const workingDir = 'C:\\repo';
      const db = createMockDb({
        projectFromPath: { [workingDir]: 'torque' },
      });
      const { handlers, mocks } = loadAutomationModule({ db });

      const result = handlers.handleSetProjectDefaults({
        working_directory: workingDir,
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        verify_command: 'pnpm verify',
        auto_fix: true,
        test_pattern: '.spec.ts',
        auto_verify_on_completion: true,
        remote_agent_id: 'agent-7',
        remote_project_path: 'D:\\remote\\torque',
        prefer_remote_tests: true,
        step_providers: { types: 'ollama', system: 'codex' },
      });
      const text = getText(result);

      expect(db.safeAddColumn).toHaveBeenCalledWith('project_config', 'default_provider TEXT');
      expect(db.safeAddColumn).toHaveBeenCalledWith('project_config', 'remote_agent_id TEXT');
      expect(db.safeAddColumn).toHaveBeenCalledWith('project_config', 'prefer_remote_tests INTEGER DEFAULT 0');
      expect(mocks.projectConfigCore.setProjectConfig).toHaveBeenCalledWith('torque', {
        default_provider: 'codex',
        default_model: 'gpt-5.3-codex-spark',
        verify_command: 'pnpm verify',
        auto_fix_enabled: 1,
        test_pattern: '.spec.ts',
        auto_verify_on_completion: 1,
        remote_agent_id: 'agent-7',
        remote_project_path: 'D:\\remote\\torque',
        prefer_remote_tests: 1,
      });
      expect(mocks.projectConfigCore.setProjectMetadata).toHaveBeenCalledWith('torque', 'step_providers', '{"types":"ollama","system":"codex"}');
      expect(text).toContain('Default provider: codex');
      expect(text).toContain('Remote agent ID: agent-7');
      expect(text).toContain('Step providers: {"types":"ollama","system":"codex"}');
      expect(text).toContain('| Provider | codex |');
    });

    it('handleGetProjectDefaults returns a not found error when the project cannot be resolved', () => {
      const db = createMockDb({ defaultProject: null });
      const { handlers } = loadAutomationModule({ db });

      const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\repo' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Could not determine project from path');
    });

    it('handleGetProjectDefaults reports when no config exists for the project', () => {
      const workingDir = 'C:\\repo';
      const db = createMockDb({
        projectFromPath: { [workingDir]: 'torque' },
      });
      const { handlers } = loadAutomationModule({ db });

      const result = handlers.handleGetProjectDefaults({ working_directory: workingDir });

      expect(getText(result)).toContain('No project configuration found');
    });

    it('handleGetProjectDefaults includes remote settings and parsed step providers', () => {
      const workingDir = 'C:\\repo';
      const db = createMockDb({
        projectFromPath: { [workingDir]: 'torque' },
        projectConfigs: {
          torque: {
            default_provider: 'ollama',
            default_model: TEST_MODELS.SMALL,
            verify_command: 'pnpm verify',
            auto_fix_enabled: 1,
            test_pattern: '.test.js',
            remote_agent_id: 'agent-1',
            remote_project_path: 'D:\\remote\\torque',
            prefer_remote_tests: 1,
          },
        },
        projectMetadata: {
          torque: {
            step_providers: '{"types":"ollama","system":"codex"}',
          },
        },
      });
      const { handlers } = loadAutomationModule({ db });

      const result = handlers.handleGetProjectDefaults({ working_directory: workingDir });
      const text = getText(result);

      expect(text).toContain('| Remote agent | agent-1 |');
      expect(text).toContain('| Remote path | D:\\remote\\torque |');
      expect(text).toContain('| Prefer remote tests | Yes |');
      expect(text).toContain('| Step providers | types=ollama, system=codex |');
    });

    it('handleGetProjectDefaults tolerates invalid step provider metadata', () => {
      const workingDir = 'C:\\repo';
      const db = createMockDb({
        projectFromPath: { [workingDir]: 'torque' },
        projectConfigs: {
          torque: {
            default_provider: 'codex',
          },
        },
        projectMetadata: {
          torque: {
            step_providers: '{invalid json',
          },
        },
      });
      const { handlers, mocks } = loadAutomationModule({ db });

      const result = handlers.handleGetProjectDefaults({ working_directory: workingDir });
      const text = getText(result);

      expect(mocks.logger.debug).toHaveBeenCalledWith(
        '[automation-handlers] invalid step_providers JSON for project defaults:',
        expect.any(String),
      );
      expect(text).not.toContain('Step providers');
    });

    it('formatProjectConfig renders smart-routing defaults when config is empty', () => {
      const { helpers } = loadAutomationModule();

      const text = helpers.formatProjectConfig({}, null);

      expect(text).toContain('| Provider | (smart routing) |');
      expect(text).toContain('| Model | (auto) |');
      expect(text).toContain('| Verify command | (none) |');
      expect(text).toContain('| Test pattern | .test.ts |');
    });
  });

  describe('handleGetBatchSummary', () => {
    it('requires workflow_id', () => {
      const { handlers } = loadAutomationModule();

      const result = handlers.handleGetBatchSummary({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('workflow_id is required');
    });

    it('returns a workflow not found error when the workflow is missing', () => {
      const { handlers } = loadAutomationModule({ db: createMockDb() });

      const result = handlers.handleGetBatchSummary({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found: wf-1');
    });

    it('returns an operation failed error when workflow status is unavailable', () => {
      const db = createMockDb({
        workflow: { id: 'wf-1', working_directory: 'C:\\repo' },
      });
      const { handlers } = loadAutomationModule({ db });

      const result = handlers.handleGetBatchSummary({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Could not get workflow status');
    });

    it('includes git diff stats, test results, and task durations when commands succeed', () => {
      const workingDir = 'C:\\repo';
      const db = createMockDb({
        workflow: { id: 'wf-1', working_directory: workingDir },
        workflowStatus: {
          id: 'wf-1',
          name: 'Main Batch',
          status: 'completed',
          summary: { completed: 1, failed: 1, total: 2 },
          started_at: '2026-03-12T00:00:00.000Z',
          completed_at: new Date('2026-03-12T00:01:05.000Z').getTime(),
          tasks: {
            lint: {
              id: 'task-11111111',
              node_id: 'lint',
              status: 'completed',
              started_at: '2026-03-12T00:00:00.000Z',
              completed_at: '2026-03-12T00:00:15.000Z',
              working_directory: workingDir,
            },
            tests: {
              id: 'task-22222222',
              node_id: 'tests',
              status: 'failed',
              started_at: '2026-03-12T00:00:20.000Z',
              completed_at: '2026-03-12T00:00:50.000Z',
              working_directory: workingDir,
            },
          },
        },
      });
      const executeValidatedCommandSync = vi.fn((_command, args) => {
        if (args[1] === '--stat') return ' src/app.ts | 4 ++--';
        if (args[1] === '--name-status') return 'A\tserver/tests/new.test.js\nM\tserver/handlers/app.js';
        if (args[1] === '--shortstat') return ' 2 files changed, 5 insertions(+), 3 deletions(-)';
        return '';
      });
      const safeExecChain = vi.fn(() => ({
        exitCode: 0,
        output: '7 passed (3)',
        error: '',
      }));
      const { handlers } = loadAutomationModule({
        db,
        executeValidatedCommandSync,
        safeExecChain,
      });

      const result = handlers.handleGetBatchSummary({ workflow_id: 'wf-1' });
      const text = getText(result);

      expect(executeValidatedCommandSync).toHaveBeenCalledTimes(3);
      expect(executeValidatedCommandSync).toHaveBeenNthCalledWith(
        1,
        'git',
        ['diff', '--stat', 'HEAD~1'],
        expect.objectContaining({ cwd: workingDir }),
      );
      expect(safeExecChain).toHaveBeenCalledWith(
        'npx vitest run --reporter=verbose',
        expect.objectContaining({ cwd: workingDir }),
      );
      expect(text).toContain('**Status:** completed');
      expect(text).toContain('**Duration:** 65s');
      expect(text).toContain('### Git Changes');
      expect(text).toContain('**Files added:** 1');
      expect(text).toContain('**Files modified:** 1');
      expect(text).toContain('**Changes:** 2 files changed, 5 insertions(+), 3 deletions(-)');
      expect(text).toContain('### Test Results');
      expect(text).toContain('**Tests passing:** 7');
      expect(text).toContain('**Test files:** 3');
      expect(text).toContain('| lint | completed | 15s |');
      expect(text).toContain('| tests | failed | 30s |');
    });

    it('continues when git or test commands fail', () => {
      const workingDir = 'C:\\repo';
      const db = createMockDb({
        workflow: { id: 'wf-1', working_directory: workingDir },
        workflowStatus: {
          id: 'wf-1',
          name: 'Fallback Batch',
          status: 'completed',
          summary: { completed: 1, failed: 0, total: 1 },
          tasks: {
            task1: {
              id: 'task-1',
              status: 'completed',
              node_id: 'task1',
            },
          },
        },
      });
      const executeValidatedCommandSync = vi.fn(() => {
        throw new Error('git unavailable');
      });
      const safeExecChain = vi.fn(() => {
        throw new Error('vitest unavailable');
      });
      const { handlers, mocks } = loadAutomationModule({
        db,
        executeValidatedCommandSync,
        safeExecChain,
      });

      const result = handlers.handleGetBatchSummary({ workflow_id: 'wf-1' });
      const text = getText(result);

      expect(text).toContain('## Batch Summary: Fallback Batch');
      expect(text).toContain('### Task Breakdown');
      expect(text).not.toContain('### Git Changes');
      expect(text).not.toContain('### Test Results');
      expect(mocks.logger.debug).toHaveBeenCalled();
    });
  });

  describe('handleUpdateProjectStats', () => {
    it('is no longer exported from automation handlers', () => {
      const { handlers } = loadAutomationModule();

      expect(handlers.handleUpdateProjectStats).toBeUndefined();
    });
  });
});
