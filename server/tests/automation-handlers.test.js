'use strict';

const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const automationHandlersPath = require.resolve('../handlers/automation-handlers');
const tempDirs = new Set();

let currentModules = {};

vi.mock('../database', () => currentModules.database);
vi.mock('../db/config-core', () => currentModules.configCore);
vi.mock('../db/task-core', () => currentModules.taskCore);
vi.mock('../db/project-config-core', () => currentModules.projectConfigCore);
vi.mock('../db/workflow-engine', () => currentModules.workflowEngine);
vi.mock('../task-manager', () => currentModules.taskManager);
vi.mock('../test-runner-registry', () => ({
  createTestRunnerRegistry: currentModules.createTestRunnerRegistry,
}));
vi.mock('../utils/context-enrichment', () => ({
  buildErrorFeedbackPrompt: currentModules.buildErrorFeedbackPrompt,
}));
vi.mock('../utils/safe-exec', () => ({
  safeExecChain: currentModules.safeExecChain,
}));
vi.mock('../execution/command-policy', () => ({
  executeValidatedCommandSync: currentModules.executeValidatedCommandSync,
}));
vi.mock('../logger', () => currentModules.loggerModule);
vi.mock('../index', () => currentModules.indexModule);
vi.mock('../container', () => currentModules.containerModule);
vi.mock('uuid', () => currentModules.uuidModule);
vi.mock('../handlers/automation-ts-tools', () => currentModules.tsTools);
vi.mock('../handlers/automation-batch-orchestration', () => currentModules.batchOrchestration);

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function extractJsonBlock(text) {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  return match ? JSON.parse(match[1]) : null;
}

function buildLines(count, prefix = 'line') {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockDb(options = {}) {
  const configStore = new Map(Object.entries(options.config || {}));
  const projectConfigs = new Map(Object.entries(options.projectConfigs || {}));
  const projectMetadata = new Map(
    Object.entries(options.projectMetadata || {}).map(([project, metadata]) => [project, { ...metadata }]),
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

function createDefaultModules(overrides = {}) {
  let uuidCounter = 0;
  const db = overrides.db || createMockDb(overrides.dbOptions);
  const database = overrides.database || {
    safeAddColumn: db.safeAddColumn,
  };
  const configCore = overrides.configCore || {
    __stores: db.__stores,
    setConfig: db.setConfig,
    getConfig: db.getConfig,
  };
  const taskCore = overrides.taskCore || {
    getTask: db.getTask,
    createTask: db.createTask,
  };
  const projectConfigCore = overrides.projectConfigCore || {
    getProjectFromPath: db.getProjectFromPath,
    setProjectConfig: db.setProjectConfig,
    getProjectConfig: db.getProjectConfig,
    setProjectMetadata: db.setProjectMetadata,
    getProjectMetadata: db.getProjectMetadata,
  };
  const workflowEngine = overrides.workflowEngine || {
    getWorkflow: db.getWorkflow,
    getWorkflowStatus: db.getWorkflowStatus,
  };
  const taskManager = overrides.taskManager || { startTask: vi.fn() };
  const logger = overrides.logger || createMockLogger();
  const router = overrides.router || {
    runVerifyCommand: vi.fn(async () => ({
      output: '',
      error: '',
      exitCode: 0,
      remote: false,
      durationMs: 0,
    })),
  };
  const governanceHooks = overrides.governanceHooks || null;
  const defaultContainer = overrides.defaultContainer || {
    has: vi.fn((name) => (name === 'governanceHooks' && Boolean(governanceHooks)) || name === 'db'),
    get: vi.fn((name) => {
      if (name === 'governanceHooks') return governanceHooks;
      if (name === 'db') return db;
      return undefined;
    }),
  };

  return {
    db,
    database,
    configCore,
    taskCore,
    projectConfigCore,
    workflowEngine,
    taskManager,
    router,
    createTestRunnerRegistry: overrides.createTestRunnerRegistry || vi.fn(() => router),
    buildErrorFeedbackPrompt: overrides.buildErrorFeedbackPrompt
      || vi.fn((prompt, originalOutput, errors) => `${prompt}\n\n${originalOutput || ''}\n\n${errors || ''}`),
    safeExecChain: overrides.safeExecChain || vi.fn(() => ({ exitCode: 0, output: '', error: '' })),
    executeValidatedCommandSync: overrides.executeValidatedCommandSync || vi.fn(() => ''),
    logger,
    loggerModule: { child: vi.fn(() => logger) },
    indexModule: overrides.indexModule || { getTestRunnerRegistry: vi.fn(() => overrides.testRunnerRegistry || null) },
    governanceHooks,
    defaultContainer,
    containerModule: overrides.containerModule || { defaultContainer },
    uuidModule: { v4: overrides.uuidV4 || vi.fn(() => `12345678-aaaa-bbbb-cccc-${String(++uuidCounter).padStart(12, '0')}`) },
    tsTools: overrides.tsTools || {},
    batchOrchestration: overrides.batchOrchestration || {},
  };
}

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadHandlers(overrides = {}) {
  currentModules = createDefaultModules(overrides);

  vi.resetModules();
  vi.doMock('../database', () => currentModules.database);
  vi.doMock('../db/config-core', () => currentModules.configCore);
  vi.doMock('../db/task-core', () => currentModules.taskCore);
  vi.doMock('../db/project-config-core', () => currentModules.projectConfigCore);
  vi.doMock('../db/workflow-engine', () => currentModules.workflowEngine);
  vi.doMock('../task-manager', () => currentModules.taskManager);
  vi.doMock('../test-runner-registry', () => ({
    createTestRunnerRegistry: currentModules.createTestRunnerRegistry,
  }));
  vi.doMock('../utils/context-enrichment', () => ({
    buildErrorFeedbackPrompt: currentModules.buildErrorFeedbackPrompt,
  }));
  vi.doMock('../utils/safe-exec', () => ({
    safeExecChain: currentModules.safeExecChain,
  }));
  vi.doMock('../execution/command-policy', () => ({
    executeValidatedCommandSync: currentModules.executeValidatedCommandSync,
  }));
  vi.doMock('../logger', () => currentModules.loggerModule);
  vi.doMock('../index', () => currentModules.indexModule);
  vi.doMock('../container', () => currentModules.containerModule);
  vi.doMock('uuid', () => currentModules.uuidModule);
  vi.doMock('../handlers/automation-ts-tools', () => currentModules.tsTools);
  vi.doMock('../handlers/automation-batch-orchestration', () => currentModules.batchOrchestration);

  installCjsModuleMock('../database', currentModules.database);
  installCjsModuleMock('../db/config-core', currentModules.configCore);
  installCjsModuleMock('../db/task-core', currentModules.taskCore);
  installCjsModuleMock('../db/project-config-core', currentModules.projectConfigCore);
  installCjsModuleMock('../db/workflow-engine', currentModules.workflowEngine);
  installCjsModuleMock('../task-manager', currentModules.taskManager);
  installCjsModuleMock('../test-runner-registry', {
    createTestRunnerRegistry: currentModules.createTestRunnerRegistry,
  });
  installCjsModuleMock('../utils/context-enrichment', {
    buildErrorFeedbackPrompt: currentModules.buildErrorFeedbackPrompt,
  });
  installCjsModuleMock('../utils/safe-exec', {
    safeExecChain: currentModules.safeExecChain,
  });
  installCjsModuleMock('../execution/command-policy', {
    executeValidatedCommandSync: currentModules.executeValidatedCommandSync,
  });
  installCjsModuleMock('../logger', currentModules.loggerModule);
  installCjsModuleMock('../index', currentModules.indexModule);
  installCjsModuleMock('../container', currentModules.containerModule);
  installCjsModuleMock('uuid', currentModules.uuidModule);
  installCjsModuleMock('../handlers/automation-ts-tools', currentModules.tsTools);
  installCjsModuleMock('../handlers/automation-batch-orchestration', currentModules.batchOrchestration);

  delete require.cache[automationHandlersPath];

  return {
    handlers: require('../handlers/automation-handlers'),
    mocks: currentModules,
  };
}

function createTempProject(entries = {}) {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-automation-handlers-'));
  tempDirs.add(workingDir);

  for (const [relativePath, content] of Object.entries(entries)) {
    const fullPath = path.join(workingDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  return workingDir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
  currentModules = {};
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

describe('automation-handlers', () => {
  it('uses injected database dependencies for project defaults without loading the database facade', () => {
    const db = createMockDb({
      projectFromPath: { 'C:\\repo': 'repo-project' },
    });
    const { handlers } = loadHandlers({ db });
    const injectedHandlers = handlers.createAutomationHandlers({ db });
    const originalLoad = Module._load;
    const blockedRequests = [];
    const databaseLoadSpy = vi.spyOn(Module, '_load').mockImplementation(function patchedLoad(request, parent, isMain) {
      const parentFile = parent?.filename ? parent.filename.replace(/\\/g, '/') : '';
      if (request === '../database' && parentFile.endsWith('server/handlers/automation-handlers.js')) {
        blockedRequests.push(request);
        throw new Error('automation handler should not require database facade');
      }
      return originalLoad.call(this, request, parent, isMain);
    });

    try {
      const result = injectedHandlers.handleSetProjectDefaults({
        working_directory: 'C:\\repo',
        provider: 'codex',
      });

      expect(result.isError).toBeFalsy();
      expect(db.safeAddColumn).toHaveBeenCalled();
      expect(db.setProjectConfig).toHaveBeenCalledWith('repo-project', expect.objectContaining({
        default_provider: 'codex',
      }));
      expect(blockedRequests).toEqual([]);
    } finally {
      databaseLoadSpy.mockRestore();
    }
  });

  describe('configuration handlers', () => {
    it('stores stall detection thresholds and recovery settings', () => {
      const { handlers, mocks } = loadHandlers();

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
      expect(mocks.configCore.__stores.configStore.get('stall_recovery_enabled')).toBe('1');
      expect(text).toContain('Set stall threshold to 180s for all providers');
      expect(text).toContain('**Auto-resubmit:** Yes');
      expect(text).toContain('**Max attempts:** 4');
    });

    it('clamps quota auto-scale thresholds before persisting them', () => {
      const { handlers, mocks } = loadHandlers();

      const result = handlers.handleConfigureQuotaAutoScale({
        enabled: true,
        queue_depth_threshold: 0.2,
        cooldown_seconds: -9,
      });
      const text = getText(result);

      expect(mocks.configCore.__stores.configStore.get('quota_auto_scale_enabled')).toBe('true');
      expect(mocks.configCore.__stores.configStore.get('quota_queue_depth_threshold')).toBe('1');
      expect(mocks.configCore.__stores.configStore.get('quota_cooldown_seconds')).toBe('0');
      expect(text).toContain('Free-tier auto-scale: enabled');
      expect(text).toContain('| Queue depth threshold | 1 |');
      expect(text).toContain('| Cooldown (seconds) | 0 |');
    });
  });

  describe('handleAutoVerifyAndFix', () => {
    it('returns a validation error when working_directory is missing', async () => {
      const { handlers } = loadHandlers();

      const result = await handlers.handleAutoVerifyAndFix({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('working_directory is required');
    });

    it('reports successful remote verification details', async () => {
      const router = {
        runVerifyCommand: vi.fn(async () => ({
          output: 'ok',
          error: '',
          exitCode: 0,
          remote: true,
          durationMs: 1500,
        })),
      };
      const { handlers, mocks } = loadHandlers({ router });

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        verify_command: 'pnpm typecheck',
        timeout_seconds: 9,
      });
      const text = getText(result);

      expect(mocks.createTestRunnerRegistry).toHaveBeenCalledTimes(1);
      expect(router.runVerifyCommand).toHaveBeenCalledWith('pnpm typecheck', 'C:\\repo', { timeout: 9000 });
      expect(text).toContain('### Result: PASSED');
      expect(text).toContain('**Execution:** remote (agent)');
      expect(text).toContain('**Duration:** 1.5s');
    });

    it('prints governance warnings and still executes verification in warn mode', async () => {
      const router = {
        runVerifyCommand: vi.fn(async () => ({
          output: 'ok',
          error: '',
          exitCode: 0,
          remote: false,
          durationMs: 0,
        })),
      };
      const governanceHooks = {
        evaluatePreVerify: vi.fn(async () => ({
          blocked: [],
          warned: [{ message: 'Test suite has been run 3 times for this change set.' }],
          shadowed: [],
          allPassed: true,
        })),
      };
      const { handlers } = loadHandlers({ router, governanceHooks });

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        verify_command: 'npx vitest run',
      });
      const text = getText(result);

      expect(governanceHooks.evaluatePreVerify).toHaveBeenCalledWith(
        expect.objectContaining({ working_directory: 'C:\\repo' }),
        expect.objectContaining({ verify_command: 'npx vitest run' }),
      );
      expect(router.runVerifyCommand).toHaveBeenCalledTimes(1);
      expect(text).toContain('**Governance warnings:**');
      expect(text).toContain('Test suite has been run 3 times for this change set.');
      expect(text).toContain('### Result: PASSED');
    });

    it('prints governance blocks and skips verification in block mode', async () => {
      const router = {
        runVerifyCommand: vi.fn(async () => ({
          output: 'ok',
          error: '',
          exitCode: 0,
          remote: false,
          durationMs: 0,
        })),
      };
      const governanceHooks = {
        evaluatePreVerify: vi.fn(async () => ({
          blocked: [{ message: 'Test suite has been run 4 times for this change set.' }],
          warned: [],
          shadowed: [],
          allPassed: false,
        })),
      };
      const { handlers } = loadHandlers({ router, governanceHooks });

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
        verify_command: 'npx vitest run',
      });
      const text = getText(result);

      expect(governanceHooks.evaluatePreVerify).toHaveBeenCalledWith(
        expect.objectContaining({ working_directory: 'C:\\repo' }),
        expect.objectContaining({ verify_command: 'npx vitest run' }),
      );
      expect(router.runVerifyCommand).not.toHaveBeenCalled();
      expect(text).toContain('**Governance blocks:**');
      expect(text).toContain('Test suite has been run 4 times for this change set.');
      expect(text).toContain('### Result: SKIPPED');
      expect(text).toContain('Verification skipped.');
    });

    it('parses TypeScript errors without submitting fixes when auto_fix is false', async () => {
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
      const { handlers, mocks } = loadHandlers({ router });

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

    it('submits fix tasks with error-feedback context from the source task', async () => {
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
      const buildErrorFeedbackPrompt = vi.fn(() => 'FEEDBACK PROMPT');
      const { handlers, mocks } = loadHandlers({ db, router, buildErrorFeedbackPrompt });

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
      expect(mocks.taskCore.createTask).toHaveBeenCalledWith(expect.objectContaining({
        id: '12345678-aaaa-bbbb-cccc-000000000001',
        task_description: 'FEEDBACK PROMPT',
        provider: null,
        timeout_minutes: 10,
        priority: 5,
      }));
      // Fix tasks now use deferred assignment with intended_provider in metadata
      const createTaskCall = mocks.taskCore.createTask.mock.calls[0][0];
      const fixMeta = JSON.parse(createTaskCall.metadata);
      expect(fixMeta.intended_provider).toBe('ollama');
      expect(mocks.taskManager.startTask).toHaveBeenCalledWith('12345678-aaaa-bbbb-cccc-000000000001');
      expect(text).toContain('Task `12345678` submitted to ollama');
      expect(text).toContain('Summary:** 2 errors, 1 fix tasks submitted');
    });

    it('reports task submission failures inline', async () => {
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
      const { handlers, mocks } = loadHandlers({ db, router });

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
      });
      const text = getText(result);

      expect(mocks.taskManager.startTask).not.toHaveBeenCalled();
      expect(text).toContain('Failed to submit fix task — db down');
      expect(text).toContain('Summary:** 1 errors, 0 fix tasks submitted');
    });

    it('wraps unexpected router errors as internal errors', async () => {
      const router = {
        runVerifyCommand: vi.fn(async () => {
          throw new Error('router exploded');
        }),
      };
      const { handlers } = loadHandlers({ router });

      const result = await handlers.handleAutoVerifyAndFix({
        working_directory: 'C:\\repo',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('router exploded');
    });
  });

  describe('handleGenerateTestTasks', () => {
    it('returns a validation error when working_directory is missing', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleGenerateTestTasks({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('working_directory is required');
    });

    it('rejects non-string source_dirs entries', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleGenerateTestTasks({
        working_directory: 'C:\\repo',
        source_dirs: ['src', 7],
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('source_dirs must be an array of strings or a string');
    });

    it('handles an empty project without generating test tasks', () => {
      const workingDir = createTempProject();
      const { handlers } = loadHandlers();

      const result = handlers.handleGenerateTestTasks({ working_directory: workingDir });
      const text = getText(result);

      expect(text).toContain('**Source files:** 0');
      expect(text).toContain('**Coverage:** 0%');
      expect(text).toContain('No suitable untested files found.');
    });

    it('reuses an existing related test file outside __tests__', () => {
      const workingDir = createTempProject({
        [path.join('src', 'handlers', 'task-pipeline.js')]: buildLines(40, 'pipeline'),
        [path.join('tests', 'handler-task-pipeline.test.js')]: 'export {}',
      });
      const { handlers } = loadHandlers();

      const result = handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        source_dirs: ['src/handlers', 'tests'],
        test_pattern: '.test.js',
        count: 1,
      });
      const text = getText(result);
      const generatedTasks = extractJsonBlock(text);

      expect(text).toContain('| src/handlers/task-pipeline.js | 40 | tests/handler-task-pipeline.test.js |');
      expect(generatedTasks).toHaveLength(1);
      expect(generatedTasks[0].task).toContain('Extend the existing test file tests/handler-task-pipeline.test.js');
    });

    it('auto-submits generated test tasks through the task manager', () => {
      const workingDir = createTempProject({
        [path.join('src', 'systems', 'QueueSystem.ts')]: buildLines(32, 'queue'),
      });
      const db = createMockDb();
      const { handlers, mocks } = loadHandlers({ db });

      const result = handlers.handleGenerateTestTasks({
        working_directory: workingDir,
        auto_submit: true,
        provider: 'claude-cli',
        count: 1,
      });
      const text = getText(result);

      expect(mocks.taskCore.createTask).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude-cli',
        working_directory: workingDir,
        timeout_minutes: 15,
      }));
      expect(mocks.taskCore.createTask.mock.calls[0][0].task_description).toContain('with ~8 tests');
      expect(mocks.taskManager.startTask).toHaveBeenCalledWith('12345678-aaaa-bbbb-cccc-000000000001');
      expect(text).toContain('Submitted 1 test tasks to claude-cli.');
    });
  });

  describe('project defaults handlers', () => {
    it('rejects set_project_defaults without a working directory', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleSetProjectDefaults({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('working_directory is required');
    });

    it('rejects unsupported default providers', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleSetProjectDefaults({
        working_directory: 'C:\\repo',
        provider: 'nonexistent-provider',
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Invalid provider "nonexistent-provider"');
    });

    it('persists project defaults and formats them on retrieval', () => {
      const workingDir = createTempProject();
      const db = createMockDb({
        projectFromPath: { [workingDir]: 'torque' },
      });
      const { handlers, mocks } = loadHandlers({ db });

      const setResult = handlers.handleSetProjectDefaults({
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
      const getResult = handlers.handleGetProjectDefaults({ working_directory: workingDir });
      const setText = getText(setResult);
      const getTextValue = getText(getResult);

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
      expect(setText).toContain('Default provider: codex');
      expect(setText).toContain('Remote agent ID: agent-7');
      expect(getTextValue).toContain('| Provider | codex |');
      expect(getTextValue).toContain('| Remote agent | agent-7 |');
      expect(getTextValue).toContain('| Step providers | types=ollama, system=codex |');
    });

    it('reports when a project has no stored configuration yet', () => {
      const workingDir = createTempProject();
      const db = createMockDb({
        projectFromPath: { [workingDir]: 'torque' },
      });
      const { handlers } = loadHandlers({ db });

      const result = handlers.handleGetProjectDefaults({ working_directory: workingDir });

      expect(result.isError).not.toBe(true);
      expect(getText(result)).toContain('No project configuration found');
    });
  });

  describe('handleGetBatchSummary', () => {
    it('returns a validation error when workflow_id is missing', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleGetBatchSummary({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('workflow_id is required');
    });

    it('returns a not found error for unknown workflows', () => {
      const { handlers } = loadHandlers();

      const result = handlers.handleGetBatchSummary({ workflow_id: 'wf-1' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Workflow not found: wf-1');
    });

    it('includes git, test, and task duration stats when commands succeed', () => {
      const workingDir = createTempProject();
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
      const { handlers } = loadHandlers({
        db,
        executeValidatedCommandSync,
        safeExecChain,
      });

      const result = handlers.handleGetBatchSummary({ workflow_id: 'wf-1' });
      const text = getText(result);

      expect(executeValidatedCommandSync).toHaveBeenCalledTimes(3);
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

    it('falls back to the base summary when git or test commands fail', () => {
      const workingDir = createTempProject();
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
      const { handlers, mocks } = loadHandlers({
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
      const { handlers } = loadHandlers();

      expect(handlers.handleUpdateProjectStats).toBeUndefined();
    });
  });
});
