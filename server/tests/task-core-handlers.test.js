'use strict';

const fs = require('fs');
const path = require('path');
const { createConfigMock } = require('./test-helpers');

const HANDLER_MODULE = '../handlers/task/core';
const MODULE_PATHS = [
  HANDLER_MODULE,
  '../database',
  '../config',
  '../task-manager',
  '../handlers/integration/routing',
  '../handlers/shared',
  '../handlers/task/utils',
  '../constants',
  '../logger',
  'uuid',
];

let uuidCounter = 0;
const TEMP_ROOT = path.join(process.cwd(), 'server', 'tests', '.tmp-task-core-handlers');

function makeTempDir(name) {
  const dir = path.join(TEMP_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const mockDb = {
  getConfig: vi.fn(),
  getDefaultProvider: vi.fn(),
  getProvider: vi.fn(),
  analyzeTaskForRouting: vi.fn(),
  isCodexExhausted: vi.fn(),
  hasHealthyOllamaHost: vi.fn(),
  estimateCost: vi.fn(),
  checkBudgetBeforeSubmission: vi.fn(),
  createTask: vi.fn(),
  getTask: vi.fn(),
  listTasks: vi.fn(),
  listArtifacts: vi.fn(),
  getOllamaHost: vi.fn(),
  getCurrentProject: vi.fn(),
  setConfig: vi.fn(),
  getAllConfig: vi.fn(),
  getLatestStreamChunks: vi.fn(),
  updateTaskStatus: vi.fn(),
};

const mockTaskManager = {
  startTask: vi.fn(),
  getRunningTaskCount: vi.fn(),
  getTaskProgress: vi.fn(),
  getTaskActivity: vi.fn(),
  getResourcePressureInfo: vi.fn(),
  cancelTask: vi.fn(),
  processQueue: vi.fn(),
  evaluateTaskSubmissionPolicy: vi.fn(),
};

const mockPolicyEngine = {
  evaluate: vi.fn(),
};

const mockRouting = {
  handleSmartSubmitTask: vi.fn(),
};

const mockShared = {
  safeLimit: vi.fn(),
  MAX_BATCH_SIZE: 100,
  MAX_TASK_LENGTH: 5000,
  ErrorCodes: {
    MISSING_REQUIRED_PARAM: 'MISSING_REQUIRED_PARAM',
    INVALID_PARAM: 'INVALID_PARAM',
    RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
    PROVIDER_ERROR: 'PROVIDER_ERROR',
    NO_HOSTS_AVAILABLE: 'NO_HOSTS_AVAILABLE',
    BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
    TASK_NOT_FOUND: 'TASK_NOT_FOUND',
    INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
    OPERATION_FAILED: 'OPERATION_FAILED',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
  },
  makeError: vi.fn(),
  isPathTraversalSafe: vi.fn(),
  checkProviderAvailability: vi.fn(() => null),
  requireTask: vi.fn((db, taskId) => {
    if (!taskId) return { error: mockShared.makeError(mockShared.ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id is required') };
    const task = db.getTask(taskId);
    if (!task) return { error: mockShared.makeError(mockShared.ErrorCodes.TASK_NOT_FOUND, `Task not found: ${taskId}`) };
    return { task };
  }),
};

const mockTaskUtils = {
  formatTime: vi.fn(),
  calculateDuration: vi.fn(),
};

const mockConstants = {
  PROVIDER_DEFAULT_TIMEOUTS: {
    codex: 45,
    ollama: 90,
    aider: 75,
  },
};

const mockLogger = {
  debug: vi.fn(),
};
mockLogger.child = vi.fn(() => mockLogger);

const mockUuid = {
  v4: vi.fn(),
};

const currentModules = {
  database: mockDb,
  config: null,
  taskManager: mockTaskManager,
  routing: mockRouting,
  shared: mockShared,
  taskUtils: mockTaskUtils,
  constants: mockConstants,
  logger: mockLogger,
  uuid: mockUuid,
};

vi.mock('../database', () => currentModules.database);
vi.mock('../config', () => currentModules.config);
vi.mock('../task-manager', () => currentModules.taskManager);
vi.mock('../handlers/integration/routing', () => currentModules.routing);
vi.mock('../handlers/shared', () => currentModules.shared);
vi.mock('../handlers/task/utils', () => currentModules.taskUtils);
vi.mock('../constants', () => currentModules.constants);
vi.mock('../logger', () => currentModules.logger);
vi.mock('uuid', () => currentModules.uuid);

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function createDbConfigMock(dbRef) {
  return {
    init: vi.fn(),
    get: vi.fn((key, fallback) => {
      const val = dbRef.getConfig(key);
      return val !== null && val !== undefined ? val : (fallback !== undefined ? fallback : null);
    }),
    getInt: vi.fn((key, fallback) => {
      const val = dbRef.getConfig(key);
      if (val === null || val === undefined) return fallback !== undefined ? fallback : 0;
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? (fallback !== undefined ? fallback : 0) : parsed;
    }),
    getBool: vi.fn((key) => {
      const val = dbRef.getConfig(key);
      if (val === null || val === undefined) return true;
      return val !== '0' && val !== 'false';
    }),
    isOptIn: vi.fn((key) => {
      const val = dbRef.getConfig(key);
      return val === '1' || val === 'true';
    }),
    getFloat: vi.fn(),
    getJson: vi.fn(),
    getApiKey: vi.fn(),
    hasApiKey: vi.fn(),
    getPort: vi.fn(),
  };
}

function clearLoadedModules() {
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that were not loaded.
    }
  }
}

function loadHandlers() {
  clearLoadedModules();
  currentModules.database = mockDb;
  currentModules.config = createDbConfigMock(mockDb);
  currentModules.taskManager = mockTaskManager;
  currentModules.routing = mockRouting;
  currentModules.shared = mockShared;
  currentModules.taskUtils = mockTaskUtils;
  currentModules.constants = mockConstants;
  currentModules.logger = mockLogger;
  currentModules.uuid = mockUuid;

  installCjsModuleMock('../database', currentModules.database);
  installCjsModuleMock('../config', currentModules.config);
  installCjsModuleMock('../task-manager', currentModules.taskManager);
  installCjsModuleMock('../handlers/integration/routing', currentModules.routing);
  installCjsModuleMock('../handlers/shared', currentModules.shared);
  installCjsModuleMock('../handlers/task/utils', currentModules.taskUtils);
  installCjsModuleMock('../constants', currentModules.constants);
  installCjsModuleMock('../logger', currentModules.logger);
  installCjsModuleMock('uuid', currentModules.uuid);
  return require(HANDLER_MODULE);
}

function textOf(result) {
  return result?.content?.map((part) => part.text || '').join('\n') || '';
}

function lastCreatedTask() {
  const calls = mockDb.createTask.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

function lastCreatedTaskMetadata() {
  const task = lastCreatedTask();
  return task ? JSON.parse(task.metadata) : null;
}

function makeTask(overrides = {}) {
  const task = {
    id: overrides.id || 'task-12345678',
    status: 'pending',
    task_description: 'Example task',
    working_directory: 'C:\\work',
    timeout_minutes: 30,
    auto_approve: false,
    priority: 0,
    provider: 'codex',
    model: null,
    created_at: '2026-03-01T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    exit_code: null,
    output: '',
    error_output: '',
    metadata: null,
    files_modified: null,
    progress_percent: 0,
    project: 'torque',
    ollama_host_id: null,
    ...overrides,
  };

  if (!Object.prototype.hasOwnProperty.call(overrides, 'description')) {
    task.description = task.task_description;
  }

  return task;
}

function resetMockDefaults() {
  uuidCounter = 0;

  mockUuid.v4.mockReset();
  mockUuid.v4.mockImplementation(() => {
    uuidCounter += 1;
    return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
  });

  mockShared.makeError.mockReset();
  mockShared.makeError.mockImplementation((code, message) => ({
    isError: true,
    error_code: code,
    content: [{ type: 'text', text: message }],
  }));

  mockShared.safeLimit.mockReset();
  mockShared.safeLimit.mockImplementation((value, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, fallback);
  });

  mockShared.isPathTraversalSafe.mockReset();
  mockShared.isPathTraversalSafe.mockImplementation((value) => !String(value || '').includes('..'));

  mockTaskUtils.formatTime.mockReset();
  mockTaskUtils.formatTime.mockImplementation((value) => `fmt(${value})`);

  mockTaskUtils.calculateDuration.mockReset();
  mockTaskUtils.calculateDuration.mockReturnValue('duration(5s)');

  mockLogger.debug.mockReset();
  mockLogger.child.mockReset();
  mockLogger.child.mockImplementation(() => mockLogger);

  mockDb.getConfig.mockReset();
  mockDb.getConfig.mockImplementation(createConfigMock({ default_timeout: '33', budget_check_enabled: '1' }));

  mockDb.getDefaultProvider.mockReset();
  mockDb.getDefaultProvider.mockReturnValue('codex');

  mockDb.getProvider.mockReset();
  mockDb.getProvider.mockImplementation((provider) => ({
    provider,
    enabled: true,
  }));

  mockDb.analyzeTaskForRouting.mockReset();
  mockDb.analyzeTaskForRouting.mockReturnValue({
    provider: 'deepinfra',
    reason: 'slot-pull tier list',
    complexity: 'normal',
    eligible_providers: ['deepinfra', 'codex'],
    capability_requirements: ['file_creation'],
    quality_tier: 'normal',
  });

  mockDb.isCodexExhausted.mockReset();
  mockDb.isCodexExhausted.mockReturnValue(false);

  mockDb.hasHealthyOllamaHost.mockReset();
  mockDb.hasHealthyOllamaHost.mockReturnValue(true);

  mockDb.estimateCost.mockReset();
  mockDb.estimateCost.mockReturnValue({ estimated_cost_usd: 0.25 });

  mockDb.checkBudgetBeforeSubmission.mockReset();
  mockDb.checkBudgetBeforeSubmission.mockReturnValue({
    allowed: true,
    budget: 'daily',
    current: 1.25,
    limit: 10,
  });

  mockDb.createTask.mockReset();
  mockDb.createTask.mockImplementation((task) => task);

  mockDb.getTask.mockReset();
  mockDb.getTask.mockReturnValue(null);

  mockDb.listTasks.mockReset();
  mockDb.listTasks.mockReturnValue([]);

  mockDb.listArtifacts.mockReset();
  mockDb.listArtifacts.mockReturnValue([]);

  mockDb.getOllamaHost.mockReset();
  mockDb.getOllamaHost.mockReturnValue(null);

  mockDb.getCurrentProject.mockReset();
  mockDb.getCurrentProject.mockReturnValue('torque');

  mockDb.setConfig.mockReset();
  mockDb.setConfig.mockImplementation(() => undefined);

  mockDb.getAllConfig.mockReset();
  mockDb.getAllConfig.mockReturnValue({
    max_concurrent: '2',
    default_timeout: '33',
  });

  mockDb.getLatestStreamChunks.mockReset();
  mockDb.getLatestStreamChunks.mockReturnValue([]);

  mockDb.updateTaskStatus.mockReset();
  mockDb.updateTaskStatus.mockImplementation(() => undefined);

  mockTaskManager.startTask.mockReset();
  mockTaskManager.startTask.mockReturnValue({ queued: false });

  mockTaskManager.getRunningTaskCount.mockReset();
  mockTaskManager.getRunningTaskCount.mockReturnValue(1);

  mockTaskManager.getTaskProgress.mockReset();
  mockTaskManager.getTaskProgress.mockReturnValue(null);

  mockTaskManager.getTaskActivity.mockReset();
  mockTaskManager.getTaskActivity.mockReturnValue(null);

  mockTaskManager.getResourcePressureInfo.mockReset();
  mockTaskManager.getResourcePressureInfo.mockReturnValue(null);

  mockTaskManager.cancelTask.mockReset();
  mockTaskManager.cancelTask.mockReturnValue(true);

  mockTaskManager.processQueue.mockReset();
  mockTaskManager.processQueue.mockImplementation(() => undefined);

  mockPolicyEngine.evaluate.mockReset();
  mockPolicyEngine.evaluate.mockReturnValue(null);

  mockTaskManager.evaluateTaskSubmissionPolicy.mockReset();
  mockTaskManager.evaluateTaskSubmissionPolicy.mockImplementation((taskData) => mockPolicyEngine.evaluate(taskData));

  mockRouting.handleSmartSubmitTask.mockReset();
  mockRouting.handleSmartSubmitTask.mockReturnValue({
    __subscribe_task_id: 'smart-task-1',
    content: [{ type: 'text', text: 'Smart routed task started.' }],
  });
}

describe('task-core handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    clearLoadedModules();
  });

  describe('handleSubmitTask', () => {
    it('rejects a missing task', () => {
      const result = handlers.handleSubmitTask({ auto_route: false });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('task must be a non-empty string');
    });

    it('rejects a task longer than MAX_TASK_LENGTH', () => {
      const result = handlers.handleSubmitTask({
        task: 'x'.repeat(mockShared.MAX_TASK_LENGTH + 1),
        auto_route: false,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('exceeds maximum length');
    });

    it('rejects a negative timeout', () => {
      const result = handlers.handleSubmitTask({
        task: 'Run tests',
        timeout_minutes: -1,
        auto_route: false,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('timeout_minutes');
    });

    it('rejects a non-numeric priority', () => {
      const result = handlers.handleSubmitTask({
        task: 'Run tests',
        priority: 'high',
        auto_route: false,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('priority must be a number');
    });

    it('rejects an unknown explicit provider', () => {
      mockDb.getProvider.mockReturnValue(null);

      const result = handlers.handleSubmitTask({
        task: 'Use a provider',
        provider: 'missing-provider',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(textOf(result)).toContain('Unknown provider');
    });

    it('rejects a disabled explicit provider', () => {
      mockDb.getProvider.mockReturnValue({ provider: 'ollama', enabled: false });

      const result = handlers.handleSubmitTask({
        task: 'Use ollama',
        provider: 'ollama',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('PROVIDER_ERROR');
      expect(textOf(result)).toContain('disabled');
    });

    it('delegates to smart_submit_task when auto routing is enabled without an explicit provider', () => {
      const routedResult = {
        __subscribe_task_id: 'smart-routed-123',
        content: [{ type: 'text', text: 'Smart routing handled this submission.' }],
      };
      mockRouting.handleSmartSubmitTask.mockReturnValue(routedResult);

      const result = handlers.handleSubmitTask({
        task: 'Route this task',
        working_directory: 'C:\\repo',
        timeout_minutes: 12,
        priority: 4,
        model: 'gpt-5.3-codex',
        files: ['server/handlers/task/core.js'],
        context_stuff: true,
        context_depth: 2,
        tuning: { temperature: 0.2 },
      });

      expect(result).toBe(routedResult);
      expect(mockRouting.handleSmartSubmitTask).toHaveBeenCalledWith({
        task: 'Route this task',
        working_directory: 'C:\\repo',
        timeout_minutes: 12,
        priority: 4,
        model: 'gpt-5.3-codex',
        files: ['server/handlers/task/core.js'],
        context_stuff: true,
        context_depth: 2,
        tuning: { temperature: 0.2 },
      });
      expect(mockDb.createTask).not.toHaveBeenCalled();
      expect(mockTaskManager.startTask).not.toHaveBeenCalled();
    });

    it('does not delegate to smart_submit_task when auto routing is disabled', () => {
      handlers.handleSubmitTask({
        task: 'Handle locally',
        auto_route: false,
      });

      expect(mockRouting.handleSmartSubmitTask).not.toHaveBeenCalled();
      expect(lastCreatedTask()).toMatchObject({
        task_description: 'Handle locally',
        provider: null,
      });
    });

    it('does not delegate to smart_submit_task when an explicit provider is supplied', () => {
      handlers.handleSubmitTask({
        task: 'Use explicit provider',
        provider: 'ollama',
      });

      expect(mockRouting.handleSmartSubmitTask).not.toHaveBeenCalled();
      expect(lastCreatedTask()).toMatchObject({
        task_description: 'Use explicit provider',
        provider: null,
      });
    });

    it('rejects auto-routed submission when codex is exhausted and no ollama host is healthy', () => {
      mockDb.isCodexExhausted.mockReturnValue(true);
      mockDb.hasHealthyOllamaHost.mockReturnValue(false);
      mockShared.checkProviderAvailability.mockReturnValueOnce({
        error: {
          isError: true,
          error_code: 'NO_HOSTS_AVAILABLE',
          content: [{ type: 'text', text: 'No providers available: Codex quota exhausted and local LLM offline.' }],
        },
      });

      const result = handlers.handleSubmitTask({ task: 'Fallback blocked', auto_route: false });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('NO_HOSTS_AVAILABLE');
      expect(textOf(result)).toContain('No providers available');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });

    it('creates a task with explicit provider metadata and provider timeout defaults', () => {
      const result = handlers.handleSubmitTask({
        task: '  Ship feature  ',
        provider: 'ollama',
        auto_approve: true,
        priority: 7,
        model: 'qwen2.5-coder:32b',
      });

      expect(result.isError).toBeUndefined();
      expect(mockTaskManager.startTask).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001');
      expect(textOf(result)).toContain('Task started');
      expect(textOf(result)).toContain('provider: ollama');

      const createdTask = lastCreatedTask();
      expect(createdTask).toMatchObject({
        id: '00000000-0000-0000-0000-000000000001',
        status: 'pending',
        task_description: 'Ship feature',
        timeout_minutes: 90,
        auto_approve: true,
        priority: 7,
        provider: null,
        model: 'qwen2.5-coder:32b',
      });
      expect(JSON.parse(createdTask.metadata)).toEqual({
        intended_provider: 'ollama',
        user_provider_override: true,
      });
    });

    it('stores tier-list metadata and leaves provider unassigned in slot-pull mode', () => {
      mockDb.getConfig.mockImplementation(createConfigMock({
        default_timeout: '33',
        budget_check_enabled: '1',
        scheduling_mode: 'slot-pull',
      }));

      handlers.handleSubmitTask({
        task: 'Create a new scheduler helper',
        auto_route: false,
      });

      expect(lastCreatedTask()).toMatchObject({
        provider: null,
      });
      expect(lastCreatedTaskMetadata()).toEqual({
        eligible_providers: ['deepinfra', 'codex'],
        intended_provider: 'deepinfra',
        capability_requirements: ['file_creation'],
        quality_tier: 'normal',
        user_provider_override: false,
      });
      expect(mockDb.analyzeTaskForRouting).toHaveBeenCalledWith(
        'Create a new scheduler helper',
        null,
        [],
        {
          tierList: true,
          isUserOverride: false,
          overrideProvider: null,
        }
      );
    });

    it('locks explicit providers into singleton eligible lists in slot-pull mode', () => {
      mockDb.getConfig.mockImplementation(createConfigMock({
        default_timeout: '33',
        budget_check_enabled: '1',
        scheduling_mode: 'slot-pull',
      }));
      mockDb.analyzeTaskForRouting.mockReturnValue({
        provider: 'ollama',
        reason: 'explicit slot-pull tier list',
        complexity: 'normal',
        eligible_providers: ['ollama'],
        capability_requirements: ['reasoning'],
        quality_tier: 'normal',
      });

      handlers.handleSubmitTask({
        task: 'Run on ollama only',
        provider: 'ollama',
      });

      expect(lastCreatedTask()).toMatchObject({
        provider: 'ollama',
      });
      expect(lastCreatedTaskMetadata()).toEqual({
        eligible_providers: ['ollama'],
        intended_provider: 'ollama',
        capability_requirements: ['reasoning'],
        quality_tier: 'normal',
        user_provider_override: true,
      });
      expect(mockDb.analyzeTaskForRouting).toHaveBeenCalledWith(
        'Run on ollama only',
        null,
        [],
        {
          tierList: true,
          isUserOverride: true,
          overrideProvider: 'ollama',
        }
      );
    });

    it('uses the default provider and stores empty metadata for auto-routed submissions', () => {
      const result = handlers.handleSubmitTask({ task: 'Auto route me', auto_route: false });

      expect(result.isError).toBeUndefined();

      const createdTask = lastCreatedTask();
      expect(createdTask.provider).toBe(null);
      expect(createdTask.timeout_minutes).toBe(45);
      expect(JSON.parse(createdTask.metadata)).toEqual({ intended_provider: 'codex' });
    });

    it('accepts a null timeout and falls back to the provider timeout default', () => {
      handlers.handleSubmitTask({
        task: 'Null timeout fallback',
        provider: 'ollama',
        timeout_minutes: null,
      });

      expect(lastCreatedTask()).toMatchObject({
        provider: null,
        timeout_minutes: 90,
      });
    });

    it('prefers an explicit timeout over provider defaults', () => {
      handlers.handleSubmitTask({
        task: 'Custom timeout',
        provider: 'ollama',
        timeout_minutes: 12,
      });

      expect(lastCreatedTask().timeout_minutes).toBe(12);
    });

    it('falls back to the configured default timeout when provider has no specific default', () => {
      mockDb.getDefaultProvider.mockReturnValue('custom-provider');

      handlers.handleSubmitTask({ task: 'Use fallback timeout', auto_route: false });

      expect(lastCreatedTask().provider).toBeNull();
      expect(lastCreatedTask().timeout_minutes).toBe(33);
    });

    it('persists the trimmed description, working directory, and subscribe task id for started tasks', () => {
      const result = handlers.handleSubmitTask({
        task: '  Persist submit payload  ',
        working_directory: 'C:\\repo\\torque',
        auto_route: false,
      });

      expect(result.__subscribe_task_id).toBe('00000000-0000-0000-0000-000000000001');
      expect(lastCreatedTask()).toMatchObject({
        id: '00000000-0000-0000-0000-000000000001',
        task_description: 'Persist submit payload',
        working_directory: 'C:\\repo\\torque',
      });
    });

    it('stores falsey auto_approve and zero priority without coercing them upward', () => {
      handlers.handleSubmitTask({
        task: 'Keep default flags',
        auto_route: false,
        auto_approve: 0,
        priority: 0,
      });

      expect(lastCreatedTask()).toMatchObject({
        auto_approve: false,
        priority: 0,
      });
      expect(mockPolicyEngine.evaluate).toHaveBeenCalledWith(expect.objectContaining({
        auto_approve: false,
        priority: 0,
      }));
    });

    it('returns a queued message when task manager reports queueing', () => {
      mockTaskManager.startTask.mockReturnValue({ queued: true });
      mockTaskManager.getRunningTaskCount.mockReturnValue(4);

      const result = handlers.handleSubmitTask({
        task: 'Queue me',
        provider: 'codex',
      });

      expect(textOf(result)).toContain('Task queued');
      expect(textOf(result)).toContain('Current running tasks: 4');
    });

    it('uses the explicit model for cost estimation while keeping the default provider budget bucket', () => {
      handlers.handleSubmitTask({
        task: 'Default provider with explicit model',
        auto_route: false,
        model: 'gpt-5.3-codex',
      });

      expect(mockDb.getProvider).not.toHaveBeenCalled();
      expect(mockDb.estimateCost).toHaveBeenCalledWith('Default provider with explicit model', 'gpt-5.3-codex');
      expect(mockDb.checkBudgetBeforeSubmission).toHaveBeenCalledWith('codex', 0.25);
      expect(lastCreatedTask()).toMatchObject({
        provider: null,
        model: 'gpt-5.3-codex',
      });
    });

    it('passes hasExplicitProvider=true to provider availability checks for explicit providers', () => {
      handlers.handleSubmitTask({
        task: 'Check provider gate',
        provider: 'ollama',
      });

      expect(mockShared.checkProviderAvailability).toHaveBeenLastCalledWith(mockDb, { hasExplicitProvider: true });
    });

    it('passes hasExplicitProvider=false to provider availability checks for default-provider submissions', () => {
      handlers.handleSubmitTask({
        task: 'Default provider gate',
        auto_route: false,
      });

      expect(mockShared.checkProviderAvailability).toHaveBeenLastCalledWith(mockDb, { hasExplicitProvider: false });
    });

    it('checks budget using the chosen provider and model hint', () => {
      handlers.handleSubmitTask({
        task: 'Budgeted task',
        provider: 'ollama',
        model: 'qwen2.5-coder:14b',
      });

      expect(mockDb.estimateCost).toHaveBeenCalledWith('Budgeted task', 'qwen2.5-coder:14b');
      expect(mockDb.checkBudgetBeforeSubmission).toHaveBeenCalledWith('ollama', 0.25);
    });

    it('uses the selected provider as the budget hint when no model is supplied', () => {
      handlers.handleSubmitTask({
        task: 'Budget by provider',
        provider: 'ollama',
      });

      expect(mockDb.estimateCost).toHaveBeenCalledWith('Budget by provider', 'ollama');
    });

    it('skips budget estimation when budget checks are disabled', () => {
      mockDb.getConfig.mockImplementation(createConfigMock({ default_timeout: '33', budget_check_enabled: '0' }));

      const result = handlers.handleSubmitTask({
        task: 'No budget gate',
        auto_route: false,
      });

      expect(result.isError).toBeUndefined();
      expect(mockDb.estimateCost).not.toHaveBeenCalled();
      expect(mockDb.checkBudgetBeforeSubmission).not.toHaveBeenCalled();
    });

    it('returns BUDGET_EXCEEDED when the budget check fails', () => {
      mockDb.checkBudgetBeforeSubmission.mockReturnValue({
        allowed: false,
        budget: 'daily',
        current: 9.9,
        limit: 10,
      });

      const result = handlers.handleSubmitTask({ task: 'Too expensive', auto_route: false });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('BUDGET_EXCEEDED');
      expect(textOf(result)).toContain('Budget would be exceeded');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });

    it('evaluates submission policy with normalized task data and explicit-provider metadata', () => {
      handlers.handleSubmitTask({
        task: '  Normalize submit payload  ',
        provider: 'ollama',
        auto_approve: 1,
        priority: 6,
        model: 'qwen2.5-coder:32b',
      });

      expect(mockPolicyEngine.evaluate).toHaveBeenCalledWith({
        id: '00000000-0000-0000-0000-000000000001',
        task_description: 'Normalize submit payload',
        working_directory: null,
        timeout_minutes: 90,
        auto_approve: true,
        priority: 6,
        provider: 'ollama',
        model: 'qwen2.5-coder:32b',
        metadata: {
          user_provider_override: true,
          intended_provider: 'ollama',
        },
      });
    });

    it('evaluates submission policy with default-provider metadata when no explicit provider is supplied', () => {
      handlers.handleSubmitTask({
        task: 'Default policy payload',
        auto_route: false,
      });

      expect(mockPolicyEngine.evaluate).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'codex',
        model: null,
        metadata: {
          intended_provider: 'codex',
        },
      }));
    });

    it('blocks submit_task when policy evaluation returns a reason', () => {
      mockPolicyEngine.evaluate.mockReturnValue({
        blocked: true,
        reason: 'Daily policy quota reached',
      });

      const result = handlers.handleSubmitTask({
        task: 'Blocked by policy',
        auto_route: false,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain('Daily policy quota reached');
      expect(mockDb.createTask).not.toHaveBeenCalled();
      expect(mockTaskManager.startTask).not.toHaveBeenCalled();
    });

    it('blocks submit_task when policy evaluation returns only an error string', () => {
      mockPolicyEngine.evaluate.mockReturnValue({
        blocked: true,
        error: 'Policy engine hard stop',
      });

      const result = handlers.handleSubmitTask({
        task: 'Blocked by policy error',
        auto_route: false,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain('Policy engine hard stop');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });

    it('continues submit_task when policy evaluation is unavailable', () => {
      const originalPolicyEvaluator = mockTaskManager.evaluateTaskSubmissionPolicy;
      mockTaskManager.evaluateTaskSubmissionPolicy = undefined;

      try {
        const result = handlers.handleSubmitTask({
          task: 'Submit without policy hook',
          auto_route: false,
        });

        expect(result.isError).toBeUndefined();
        expect(mockPolicyEngine.evaluate).not.toHaveBeenCalled();
        expect(lastCreatedTask()).toMatchObject({
          task_description: 'Submit without policy hook',
        });
      } finally {
        mockTaskManager.evaluateTaskSubmissionPolicy = originalPolicyEvaluator;
      }
    });

    it('returns OPERATION_FAILED when task startup is blocked after creation', () => {
      mockTaskManager.startTask.mockReturnValue({
        blocked: true,
        reason: 'Scheduler denied startup',
      });

      const result = handlers.handleSubmitTask({
        task: 'Start me later',
        auto_route: false,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain('Scheduler denied startup');
      expect(mockDb.createTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleQueueTask', () => {
    it('rejects a missing task', () => {
      const result = handlers.handleQueueTask({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('task must be a non-empty string');
    });

    it('rejects a task longer than MAX_TASK_LENGTH', () => {
      const result = handlers.handleQueueTask({
        task: 'x'.repeat(mockShared.MAX_TASK_LENGTH + 1),
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('exceeds maximum length');
    });

    it('rejects a negative timeout', () => {
      const result = handlers.handleQueueTask({
        task: 'Queue timeout',
        timeout_minutes: -1,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('timeout_minutes');
    });

    it('rejects a non-numeric priority', () => {
      const result = handlers.handleQueueTask({
        task: 'Queue priority',
        priority: 'urgent',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('priority must be a number');
    });

    it('rejects an unknown explicit provider', () => {
      mockDb.getProvider.mockReturnValue(null);

      const result = handlers.handleQueueTask({
        task: 'Queue unknown provider',
        provider: 'missing-provider',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(textOf(result)).toContain('Unknown provider');
    });

    it('rejects a disabled explicit provider', () => {
      mockDb.getProvider.mockReturnValue({ provider: 'ollama', enabled: false });

      const result = handlers.handleQueueTask({
        task: 'Queue disabled provider',
        provider: 'ollama',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('PROVIDER_ERROR');
      expect(textOf(result)).toContain('disabled');
    });

    it('creates queued tasks with an explicit provider and configured priority', () => {
      const result = handlers.handleQueueTask({
        task: 'Queue this',
        provider: 'ollama',
        priority: 3,
      });

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain('Task queued');

      const createdTask = lastCreatedTask();
      expect(createdTask).toMatchObject({
        id: '00000000-0000-0000-0000-000000000001',
        status: 'queued',
        provider: null,
        timeout_minutes: 90,
        priority: 3,
      });
      expect(mockTaskManager.startTask).not.toHaveBeenCalled();
    });

    it('stores user_provider_override metadata for queued tasks with an explicit provider', () => {
      handlers.handleQueueTask({
        task: 'Queue explicit metadata',
        provider: 'ollama',
      });

      expect(lastCreatedTaskMetadata()).toEqual({
        intended_provider: 'ollama',
        user_provider_override: true,
      });
    });

    it('stores empty metadata for queued tasks without an explicit provider', () => {
      handlers.handleQueueTask({
        task: 'Queue default metadata',
      });

      expect(lastCreatedTaskMetadata()).toEqual({ intended_provider: 'codex' });
    });

    it('accepts a null timeout and falls back to the provider timeout default when queueing', () => {
      handlers.handleQueueTask({
        task: 'Queue null timeout fallback',
        provider: 'ollama',
        timeout_minutes: null,
      });

      expect(lastCreatedTask()).toMatchObject({
        provider: null,
        timeout_minutes: 90,
      });
    });

    it('uses configured timeout fallback when the default provider lacks a specific timeout override', () => {
      mockDb.getDefaultProvider.mockReturnValue('custom-provider');

      handlers.handleQueueTask({ task: 'Queue fallback timeout' });

      expect(lastCreatedTask().timeout_minutes).toBe(33);
      expect(lastCreatedTask().provider).toBeNull();
    });

    it('prefers an explicit timeout over provider defaults when queueing', () => {
      handlers.handleQueueTask({
        task: 'Queue custom timeout',
        provider: 'ollama',
        timeout_minutes: 14,
      });

      expect(lastCreatedTask().timeout_minutes).toBe(14);
    });

    it('persists the trimmed description and working directory while omitting a subscribe task id', () => {
      const result = handlers.handleQueueTask({
        task: '  Persist queue payload  ',
        working_directory: 'C:\\repo\\queue',
      });

      expect(result.__subscribe_task_id).toBeUndefined();
      expect(lastCreatedTask()).toMatchObject({
        task_description: 'Persist queue payload',
        working_directory: 'C:\\repo\\queue',
      });
    });

    it('stores falsey auto_approve and zero priority when queueing', () => {
      handlers.handleQueueTask({
        task: 'Queue default flags',
        auto_approve: 0,
        priority: 0,
      });

      expect(lastCreatedTask()).toMatchObject({
        auto_approve: false,
        priority: 0,
      });
      expect(mockPolicyEngine.evaluate).toHaveBeenCalledWith(expect.objectContaining({
        auto_approve: false,
        priority: 0,
      }));
    });

    it('passes hasExplicitProvider=true to provider availability checks for queued explicit providers', () => {
      handlers.handleQueueTask({
        task: 'Queue provider gate',
        provider: 'ollama',
      });

      expect(mockShared.checkProviderAvailability).toHaveBeenLastCalledWith(mockDb, { hasExplicitProvider: true });
    });

    it('rejects auto-routed queueing when no providers are available', () => {
      mockDb.isCodexExhausted.mockReturnValue(true);
      mockDb.hasHealthyOllamaHost.mockReturnValue(false);
      mockShared.checkProviderAvailability.mockReturnValueOnce({
        error: {
          isError: true,
          error_code: 'NO_HOSTS_AVAILABLE',
          content: [{ type: 'text', text: 'No providers available: Codex quota exhausted and local LLM offline.' }],
        },
      });

      const result = handlers.handleQueueTask({ task: 'Cannot queue' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('NO_HOSTS_AVAILABLE');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });

    it('returns budget errors before queueing the task', () => {
      mockDb.checkBudgetBeforeSubmission.mockReturnValue({
        allowed: false,
        budget: 'weekly',
        current: 49,
        limit: 50,
      });

      const result = handlers.handleQueueTask({ task: 'Over budget queue' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('BUDGET_EXCEEDED');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });

    it('uses the selected provider as the budget hint for queue_task when no model is supplied', () => {
      handlers.handleQueueTask({
        task: 'Queue budget by provider',
        provider: 'ollama',
      });

      expect(mockDb.estimateCost).toHaveBeenCalledWith('Queue budget by provider', 'ollama');
    });

    it('uses the explicit model for cost estimation while keeping the default provider budget bucket when queueing', () => {
      handlers.handleQueueTask({
        task: 'Queue default provider with model',
        model: 'gpt-5.3-codex',
      });

      expect(mockDb.getProvider).not.toHaveBeenCalled();
      expect(mockDb.estimateCost).toHaveBeenCalledWith('Queue default provider with model', 'gpt-5.3-codex');
      expect(mockDb.checkBudgetBeforeSubmission).toHaveBeenCalledWith('codex', 0.25);
      expect(lastCreatedTask()).toMatchObject({
        provider: null,
        model: 'gpt-5.3-codex',
      });
    });

    it('skips queue budget estimation when budget checks are disabled', () => {
      mockDb.getConfig.mockImplementation(createConfigMock({ default_timeout: '33', budget_check_enabled: '0' }));

      const result = handlers.handleQueueTask({
        task: 'Queue without budget gate',
      });

      expect(result.isError).toBeUndefined();
      expect(mockDb.estimateCost).not.toHaveBeenCalled();
      expect(mockDb.checkBudgetBeforeSubmission).not.toHaveBeenCalled();
    });

    it('evaluates queue policy with normalized task data and explicit-provider metadata', () => {
      handlers.handleQueueTask({
        task: '  Normalize queue payload  ',
        provider: 'ollama',
        auto_approve: 1,
        priority: 4,
        model: 'qwen2.5-coder:14b',
      });

      expect(mockPolicyEngine.evaluate).toHaveBeenCalledWith({
        id: '00000000-0000-0000-0000-000000000001',
        task_description: 'Normalize queue payload',
        working_directory: null,
        timeout_minutes: 90,
        auto_approve: true,
        priority: 4,
        provider: 'ollama',
        model: 'qwen2.5-coder:14b',
        metadata: {
          user_provider_override: true,
          intended_provider: 'ollama',
        },
      });
    });

    it('evaluates queue policy with default-provider metadata when no explicit provider is supplied', () => {
      handlers.handleQueueTask({
        task: 'Queue default policy payload',
      });

      expect(mockPolicyEngine.evaluate).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'codex',
        model: null,
        metadata: {
          intended_provider: 'codex',
        },
      }));
    });

    it('blocks queue_task when policy evaluation returns a reason', () => {
      mockPolicyEngine.evaluate.mockReturnValue({
        blocked: true,
        reason: 'Queue policy limit reached',
      });

      const result = handlers.handleQueueTask({
        task: 'Blocked queue task',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain('Queue policy limit reached');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });

    it('blocks queue_task when policy evaluation returns only an error string', () => {
      mockPolicyEngine.evaluate.mockReturnValue({
        blocked: true,
        error: 'Queue policy hard stop',
      });

      const result = handlers.handleQueueTask({
        task: 'Blocked queue policy error',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain('Queue policy hard stop');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });

    it('continues queue_task when policy evaluation is unavailable', () => {
      const originalPolicyEvaluator = mockTaskManager.evaluateTaskSubmissionPolicy;
      mockTaskManager.evaluateTaskSubmissionPolicy = undefined;

      try {
        const result = handlers.handleQueueTask({
          task: 'Queue without policy hook',
        });

        expect(result.isError).toBeUndefined();
        expect(mockPolicyEngine.evaluate).not.toHaveBeenCalled();
        expect(lastCreatedTask()).toMatchObject({
          task_description: 'Queue without policy hook',
        });
      } finally {
        mockTaskManager.evaluateTaskSubmissionPolicy = originalPolicyEvaluator;
      }
    });
  });

  describe('handleCheckStatus', () => {
    it('returns TASK_NOT_FOUND for a missing task id', () => {
      const result = handlers.handleCheckStatus({ task_id: 'missing-task' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('formats an individual task including progress and active status details', () => {
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-running',
        status: 'running',
        task_description: 'Check status',
        timeout_minutes: 55,
        auto_approve: true,
        priority: 9,
        provider: 'ollama',
        model: 'qwen',
        created_at: '2026-03-01T00:00:00.000Z',
        started_at: '2026-03-01T00:01:00.000Z',
        exit_code: 0,
      }));
      mockTaskManager.getTaskProgress.mockReturnValue({
        progress: 65,
        elapsedSeconds: 12,
      });
      mockTaskManager.getTaskActivity.mockReturnValue({
        isStalled: false,
        lastActivitySeconds: 8,
      });

      const result = handlers.handleCheckStatus({ task_id: 'task-running' });
      const text = textOf(result);

      expect(text).toContain('## Task: task-running');
      expect(text).toContain('**Provider:** ollama');
      expect(text).toContain('**Model:** qwen');
      expect(text).toContain('**Progress:** 65%');
      expect(text).toContain('**Elapsed:** 12s');
      expect(text).toContain('**Activity:**');
      expect(text).toContain('Active');
      expect(text).toContain('**Exit Code:** 0');
    });

    it('falls back to unknown pressure and raw host ids when status formatting cannot resolve them', () => {
      mockTaskManager.getResourcePressureInfo.mockImplementation(() => {
        throw new Error('pressure unavailable');
      });
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-completed',
        status: 'completed',
        started_at: '2026-03-01T00:00:00.000Z',
        completed_at: '2026-03-01T00:00:05.000Z',
        exit_code: 0,
        ollama_host_id: 'host-raw-id',
      }));

      const result = handlers.handleCheckStatus({ task_id: 'task-completed' });
      const text = textOf(result);

      expect(result.pressureLevel).toBe('unknown');
      expect(text).toContain('**Resource Pressure:** unknown');
      expect(text).toContain('**Ollama Host:** host-raw-id');
      expect(text).toContain('**Completed:** fmt(2026-03-01T00:00:05.000Z)');
      expect(text).toContain('**Duration:** duration(5s)');
    });

    it('builds a summary for running, queued, and recent tasks', () => {
      const runningTask = makeTask({
        id: 'running-abcdefgh',
        status: 'running',
        task_description: 'Long running task description',
        model: 'gpt-5',
      });
      const queuedTask = makeTask({
        id: 'queued-abcdefgh',
        status: 'queued',
        task_description: 'Queued task description',
        priority: 5,
        model: 'qwen2.5-coder:32b',
      });
      const recentTask = makeTask({
        id: 'recent-abcdefgh',
        status: 'completed',
        task_description: 'Recent task description',
      });

      mockDb.listTasks.mockImplementation((args = {}) => {
        if (args.status === 'running') return [runningTask];
        if (args.status === 'queued') return [queuedTask];
        if (args.limit === 5) return [recentTask];
        return [];
      });
      mockTaskManager.getTaskProgress.mockReturnValue({ progress: 30 });
      mockTaskManager.getTaskActivity.mockReturnValue({
        isStalled: true,
        lastActivitySeconds: 61,
      });

      const result = handlers.handleCheckStatus({});
      const text = textOf(result);

      expect(text).toContain('## TORQUE Task Status');
      expect(text).toContain('### Running Tasks');
      expect(text).toContain('### Queued Tasks');
      expect(text).toContain('### Recent Tasks');
      expect(text).toContain('running-');
      expect(text).toContain('priority: 5');
      expect(text).toContain('STALLED');
      expect(text).toContain('[completed]');
    });
  });

  describe('handleGetResult', () => {
    it('returns a still-running message for non-terminal tasks', () => {
      mockDb.getTask.mockReturnValue(makeTask({ status: 'running' }));

      const result = handlers.handleGetResult({ task_id: 'task-12345678' });

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain('Task is still running');
    });

    it('renders requested-model overrides, host names, file lists, and errors', () => {
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-result',
        status: 'failed',
        provider: 'ollama',
        model: 'fallback-model',
        metadata: JSON.stringify({ requested_model: 'preferred-model' }),
        started_at: '2026-03-01T00:00:00.000Z',
        completed_at: '2026-03-01T00:00:05.000Z',
        exit_code: 1,
        output: 'partial output',
        error_output: 'fatal error',
        files_modified: ['src/task-core.js', 'server/tests/task-core-handlers.test.js'],
        ollama_host_id: 'host-1',
      }));
      mockDb.listArtifacts.mockReturnValue([
        {
          id: 'artifact-1',
          task_id: 'task-result',
          name: 'bundle.json',
          file_path: 'C:/artifacts/bundle.json',
          mime_type: 'application/json',
          metadata: {
            source: 'peek_diagnose',
            kind: 'bundle_json',
            contract: { name: 'peek_investigation_bundle', version: 1 },
            signed_metadata: {
              bundle_version: 1,
              checksum: 'abc123',
              algorithm: 'sha256',
              signed_at: '2026-03-10T00:00:00.000Z',
              signer: 'torque-agent',
            },
            integrity: {
              valid: true,
            },
          },
        },
      ]);
      mockDb.getOllamaHost.mockReturnValue({
        name: 'Local Host',
        url: 'http://localhost:11434',
      });

      const result = handlers.handleGetResult({ task_id: 'task-result' });
      const text = textOf(result);

      expect(text).toContain('## Task Result: task-result');
      expect(text).toContain('**Requested Model:** preferred-model');
      expect(text).toContain('overridden to fallback-model');
      expect(text).toContain('**Host:** Local Host');
      expect(text).toContain('**Files Modified:** src/task-core.js, server/tests/task-core-handlers.test.js');
      expect(text).toContain('### Bundle Artifacts');
      expect(text).toContain('bundle.json: C:/artifacts/bundle.json');
      expect(text).toContain('signed sha256:abc123 by torque-agent at 2026-03-10T00:00:00.000Z (valid)');
      expect(text).toContain('### Errors');
      expect(text).toContain('fatal error');
    });

    it('logs and continues when metadata is invalid JSON', () => {
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-invalid-meta',
        status: 'completed',
        metadata: '{bad json',
        started_at: '2026-03-01T00:00:00.000Z',
        completed_at: '2026-03-01T00:00:05.000Z',
        exit_code: 0,
        output: 'done',
      }));

      const result = handlers.handleGetResult({ task_id: 'task-invalid-meta' });

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain('done');
      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    });

    it('logs and continues when bundle artifact lookup fails', () => {
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-artifact-fail',
        status: 'completed',
        started_at: '2026-03-01T00:00:00.000Z',
        completed_at: '2026-03-01T00:00:05.000Z',
        exit_code: 0,
        output: 'artifact lookup failed but task result still renders',
      }));
      mockDb.listArtifacts.mockImplementation(() => {
        throw new Error('artifact db unavailable');
      });

      const result = handlers.handleGetResult({ task_id: 'task-artifact-fail' });
      const text = textOf(result);

      expect(result.isError).toBeUndefined();
      expect(text).toContain('artifact lookup failed but task result still renders');
      expect(text).not.toContain('### Bundle Artifacts');
      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleWaitForTask', () => {
    it('requires task_id', async () => {
      const result = await handlers.handleWaitForTask({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns the result immediately when the task is already terminal', async () => {
      const terminalTask = makeTask({
        id: 'task-complete',
        status: 'completed',
        started_at: '2026-03-01T00:00:00.000Z',
        completed_at: '2026-03-01T00:00:05.000Z',
        exit_code: 0,
        output: 'already done',
      });
      mockDb.getTask.mockImplementation(() => terminalTask);

      const result = await handlers.handleWaitForTask({ task_id: 'task-complete' });

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain('already done');
    });

    it('returns TASK_NOT_FOUND if the task disappears while waiting', async () => {
      vi.useFakeTimers();

      let currentTask = makeTask({
        id: 'task-gone',
        status: 'running',
      });
      mockDb.getTask.mockImplementation(() => currentTask);

      const pending = handlers.handleWaitForTask({
        task_id: 'task-gone',
        timeout_seconds: 5,
      });

      currentTask = null;
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(textOf(result)).toContain('deleted while waiting');
    });

    it('returns a timeout summary when the task keeps running', async () => {
      vi.useFakeTimers();

      const currentTask = makeTask({
        id: 'task-timeout',
        status: 'running',
        progress_percent: 55,
      });
      mockDb.getTask.mockImplementation(() => currentTask);

      const pending = handlers.handleWaitForTask({
        task_id: 'task-timeout',
        timeout_seconds: 1,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain('## Timeout waiting for task task-timeout');
      expect(textOf(result)).toContain('**Progress:** 55%');
      expect(textOf(result)).toContain('Task is still running');
    });

    it('returns the full result once the task reaches a terminal state during polling', async () => {
      vi.useFakeTimers();

      let currentTask = makeTask({
        id: 'task-finish-later',
        status: 'running',
      });
      mockDb.getTask.mockImplementation(() => currentTask);

      const pending = handlers.handleWaitForTask({
        task_id: 'task-finish-later',
        timeout_seconds: 10,
      });

      currentTask = makeTask({
        id: 'task-finish-later',
        status: 'completed',
        started_at: '2026-03-01T00:00:00.000Z',
        completed_at: '2026-03-01T00:00:05.000Z',
        exit_code: 0,
        output: 'finished during wait',
      });

      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain('finished during wait');
    });
  });

  describe('handleListTasks', () => {
    it('uses the detected current project and shows the all_projects tip when nothing matches', () => {
      const result = handlers.handleListTasks({});

      expect(mockDb.getCurrentProject).toHaveBeenCalledWith(process.cwd());
      expect(mockDb.listTasks).toHaveBeenCalledWith({
        status: undefined,
        tags: undefined,
        project: 'torque',
        project_id: undefined,
        limit: 20,
      });
      expect(textOf(result)).toContain('No tasks found in project: torque');
      expect(textOf(result)).toContain('all_projects: true');
    });

    it('renders filtered task tables with host names and truncated model names', () => {
      mockDb.listTasks.mockReturnValue([
        makeTask({
          id: 'abcdef1234567890',
          status: 'queued',
          task_description: 'Generate a long and very descriptive task title',
          model: 'super-long-model-name-that-will-truncate',
          created_at: '2026-03-03T12:00:00.000Z',
          ollama_host_id: 'host-12345',
        }),
      ]);
      mockDb.getOllamaHost.mockReturnValue({ name: 'BuildHost-01' });

      const result = handlers.handleListTasks({
        all_projects: true,
        status: 'queued',
        tags: ['alpha', 'beta'],
        limit: 10,
      });
      const text = textOf(result);

      expect(mockDb.listTasks).toHaveBeenCalledWith({
        status: 'queued',
        tags: ['alpha', 'beta'],
        project: null,
        project_id: undefined,
        limit: 10,
      });
      expect(text).toContain('## Tasks (all projects, queued, tags: alpha, beta)');
      expect(text).toContain('| abcdef12... | queued | super-long-mode');
      expect(text).toContain('| BuildHost- |');
    });
  });

  describe('handleCancelTask', () => {
    it('requires task_id', () => {
      const result = handlers.handleCancelTask({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns a safety check for running tasks without confirm', () => {
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'cancel-me',
        status: 'running',
        project: 'torque',
        provider: 'codex',
        created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        description: 'Safety check description',
      }));

      const result = handlers.handleCancelTask({ task_id: 'cancel-me' });
      const text = textOf(result);

      expect(result.isError).toBeUndefined();
      expect(text).toContain('## Cancel Safety Check');
      expect(text).toContain('**Status:** running');
      expect(text).toContain('**Provider:** codex');
      expect(text).toContain('Safety check description');
      expect(mockTaskManager.cancelTask).not.toHaveBeenCalled();
    });

    it('cancels confirmed tasks and forwards custom reasons', () => {
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'cancel-confirmed',
        status: 'queued',
        description: 'Queued description',
      }));

      const result = handlers.handleCancelTask({
        task_id: 'cancel-confirmed',
        confirm: true,
        reason: 'No longer needed',
      });

      expect(result.isError).toBeUndefined();
      expect(mockTaskManager.cancelTask).toHaveBeenCalledWith('cancel-confirmed', 'No longer needed');
      expect(textOf(result)).toContain('Task cancel-confirmed cancelled.');
    });

    it('maps cancelTask throws to INVALID_STATUS_TRANSITION when the task still exists', () => {
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'cancel-throw',
        status: 'completed',
      }));
      mockTaskManager.cancelTask.mockImplementation(() => {
        throw new Error('cannot cancel');
      });

      const result = handlers.handleCancelTask({
        task_id: 'cancel-throw',
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      expect(textOf(result)).toContain('Cannot cancel task cancel-throw');
    });

    it('returns INVALID_STATUS_TRANSITION when cancelTask returns false', () => {
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'cancel-false',
        status: 'completed',
      }));
      mockTaskManager.cancelTask.mockReturnValue(false);

      const result = handlers.handleCancelTask({
        task_id: 'cancel-false',
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
    });
  });

  describe('handleConfigure', () => {
    it('rejects non-finite max_concurrent values', () => {
      const result = handlers.handleConfigure({ max_concurrent: Number.NaN });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('max_concurrent must be a finite number');
    });

    it('clamps values and triggers queue processing when configuration changes', () => {
      const result = handlers.handleConfigure({
        max_concurrent: 20,
        default_timeout: 200,
      });

      expect(result.isError).toBeUndefined();
      expect(mockDb.setConfig).toHaveBeenCalledWith('max_concurrent', 10);
      expect(mockDb.setConfig).toHaveBeenCalledWith('default_timeout', 120);
      expect(mockTaskManager.processQueue).toHaveBeenCalledTimes(1);
      expect(textOf(result)).toContain('Configuration updated');
    });

    it('returns the current configuration without processing the queue when nothing changed', () => {
      const result = handlers.handleConfigure({});

      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain('## Configuration');
      expect(mockTaskManager.processQueue).not.toHaveBeenCalled();
    });
  });

  describe('handleGetProgress', () => {
    it('requires task_id', () => {
      const result = handlers.handleGetProgress({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns TASK_NOT_FOUND when the task manager has no progress entry', () => {
      const result = handlers.handleGetProgress({ task_id: 'missing-progress' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('uses stream chunks for live output and tails the requested number of lines', () => {
      mockTaskManager.getTaskProgress.mockReturnValue({
        running: true,
        progress: 42,
        elapsedSeconds: 17,
        output: '[Streaming: waiting for chunks]',
      });
      mockDb.getLatestStreamChunks.mockReturnValue([
        { chunk_data: 'line-1\nline-2\nline-3\nline-4' },
      ]);

      const result = handlers.handleGetProgress({
        task_id: 'task-stream',
        tail_lines: 2,
      });
      const text = textOf(result);

      expect(mockDb.getLatestStreamChunks).toHaveBeenCalledWith('task-stream', 0, 200);
      expect(text).toContain('## Task Progress: task-str');
      expect(text).toContain('**Status:** running');
      expect(text).toContain('**Progress:** 42%');
      expect(text).toContain('line-3\nline-4');
    });

    it('falls back to progress output and logs when stream chunk retrieval fails', () => {
      mockTaskManager.getTaskProgress.mockReturnValue({
        running: true,
        progress: 17,
        output: '[Streaming: waiting for chunks]',
      });
      mockDb.getLatestStreamChunks.mockImplementation(() => {
        throw new Error('stream unavailable');
      });

      const result = handlers.handleGetProgress({
        task_id: 'task-progress-fallback',
        tail_lines: 3,
      });
      const text = textOf(result);

      expect(result.isError).toBeUndefined();
      expect(text).toContain('[Streaming: waiting for chunks]');
      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    });

    it('shows finished tasks with no output placeholder when the buffer is empty', () => {
      mockTaskManager.getTaskProgress.mockReturnValue({
        running: false,
        progress: 100,
        output: '',
      });

      const result = handlers.handleGetProgress({
        task_id: 'task-finished',
        tail_lines: 1,
      });
      const text = textOf(result);

      expect(result.isError).toBeUndefined();
      expect(text).toContain('**Status:** finished');
      expect(text).toContain('last 1 lines');
      expect(text).toContain('(no output yet)');
    });
  });

  describe('handleShareContext', () => {
    it('requires a string task_id', () => {
      const result = handlers.handleShareContext({
        content: 'context body',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('task_id must be a non-empty string');
    });

    it('requires string content', () => {
      const result = handlers.handleShareContext({
        task_id: 'task-share',
        content: null,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('content must be a non-empty string');
    });

    it('rejects missing working directories', () => {
      const missingDir = path.join(TEMP_ROOT, 'missing-share-dir');
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-share-missing-dir',
        working_directory: missingDir,
      }));

      const result = handlers.handleShareContext({
        task_id: 'task-share-missing-dir',
        content: 'notes',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain(`Working directory does not exist: ${missingDir}`);
    });

    it('rejects symlink working directories', () => {
      const workDir = makeTempDir('share-symlink');
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-share-symlink',
        working_directory: workDir,
      }));
      vi.spyOn(fs, 'lstatSync').mockReturnValue({
        isDirectory: () => true,
        isSymbolicLink: () => true,
      });

      const result = handlers.handleShareContext({
        task_id: 'task-share-symlink',
        content: 'notes',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain(`Working directory is a symlink: ${workDir}`);
    });

    it('writes sanitized context files and merges the latest task context state', () => {
      const workDir = makeTempDir('share-success');
      const initialTask = makeTask({
        id: 'task-share-success',
        status: 'running',
        working_directory: workDir,
        context: { legacy: 'C:\\ctx\\legacy.md' },
      });
      const refreshedTask = {
        ...initialTask,
        status: 'queued',
        context: { legacy: 'C:\\ctx\\legacy.md' },
      };
      mockDb.getTask
        .mockImplementationOnce(() => initialTask)
        .mockImplementationOnce(() => refreshedTask);

      const result = handlers.handleShareContext({
        task_id: 'task-share-success',
        content: '# Build notes',
        context_type: 'build&notes',
      });
      const expectedFile = path.join(workDir, '.codex-context', 'build_notes.md');

      expect(result.isError).toBeUndefined();
      expect(fs.readFileSync(expectedFile, 'utf8')).toBe('# Build notes');
      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-share-success', 'queued', {
        context: {
          legacy: 'C:\\ctx\\legacy.md',
          build_notes: expectedFile,
        },
      });
      expect(textOf(result)).toContain(expectedFile);
    });

    it('falls back to the original task status when the refresh read returns null', () => {
      const workDir = makeTempDir('share-refresh-null');
      const originalTask = makeTask({
        id: 'task-share-refresh-null',
        status: 'running',
        working_directory: workDir,
      });
      mockDb.getTask
        .mockImplementationOnce(() => originalTask)
        .mockImplementationOnce(() => null);

      handlers.handleShareContext({
        task_id: 'task-share-refresh-null',
        content: 'follow-up notes',
        context_type: 'review',
      });

      expect(mockDb.updateTaskStatus).toHaveBeenCalledWith('task-share-refresh-null', 'running', {
        context: {
          review: path.join(workDir, '.codex-context', 'review.md'),
        },
      });
    });
  });

  describe('handleSyncFiles', () => {
    it('requires a string task_id', () => {
      const result = handlers.handleSyncFiles({
        files: ['server/tests/task-core-handlers.test.js'],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('task_id must be a non-empty string');
    });

    it('requires a non-empty files array', () => {
      const result = handlers.handleSyncFiles({
        task_id: 'task-sync',
        files: [],
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('files must be a non-empty array');
    });

    it('rejects file batches larger than MAX_BATCH_SIZE', () => {
      const result = handlers.handleSyncFiles({
        task_id: 'task-sync',
        files: Array.from({ length: mockShared.MAX_BATCH_SIZE + 1 }, (_, index) => `file-${index}.txt`),
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain(`files array cannot exceed ${mockShared.MAX_BATCH_SIZE} items`);
    });

    it('rejects unsupported sync directions', () => {
      const result = handlers.handleSyncFiles({
        task_id: 'task-sync',
        files: ['file.txt'],
        direction: 'sideways',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('direction must be "push" or "pull"');
    });

    it('pushes files into the task workspace using only the source basename', () => {
      const taskDir = makeTempDir('sync-push-task');
      const sourceDir = makeTempDir('sync-push-source');
      const nestedDir = path.join(sourceDir, 'nested');
      const sourceFile = path.join(nestedDir, 'payload.txt');
      const expectedDest = path.join(taskDir, 'payload.txt');
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(sourceFile, 'push payload');
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-sync-push',
        working_directory: taskDir,
      }));

      const result = handlers.handleSyncFiles({
        task_id: 'task-sync-push',
        files: [sourceFile],
        direction: 'push',
      });
      const text = textOf(result);

      expect(text).toContain(`✓ Pushed: ${sourceFile} → ${expectedDest}`);
      expect(fs.readFileSync(expectedDest, 'utf8')).toBe('push payload');
    });

    it('reports available files from the task workspace when pulling', () => {
      const taskDir = makeTempDir('sync-pull-task');
      const nestedDir = path.join(taskDir, 'reports');
      const relativeFile = path.join('reports', 'summary.txt');
      const resolvedFile = path.resolve(taskDir, relativeFile);
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(resolvedFile, 'summary');
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-sync-pull',
        working_directory: taskDir,
      }));

      const result = handlers.handleSyncFiles({
        task_id: 'task-sync-pull',
        files: [relativeFile],
      });

      expect(textOf(result)).toContain(`✓ Available: ${resolvedFile}`);
    });

    it('blocks traversal attempts before any file operation occurs', () => {
      const taskDir = makeTempDir('sync-traversal-precheck');
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-sync-traversal-precheck',
        working_directory: taskDir,
      }));

      const result = handlers.handleSyncFiles({
        task_id: 'task-sync-traversal-precheck',
        files: ['..\\secrets.txt'],
      });

      expect(textOf(result)).toContain('✗ Path traversal blocked: ..\\secrets.txt');
    });

    it('blocks resolved pull paths that escape the task workspace', () => {
      const taskDir = makeTempDir('sync-traversal-resolved');
      const outsideFile = path.join(TEMP_ROOT, 'outside.txt');
      fs.writeFileSync(outsideFile, 'outside');
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-sync-traversal-resolved',
        working_directory: taskDir,
      }));

      const result = handlers.handleSyncFiles({
        task_id: 'task-sync-traversal-resolved',
        files: [outsideFile],
      });

      expect(textOf(result)).toContain(`✗ Path traversal blocked: ${outsideFile}`);
    });

    it('reports invalid file entries and missing push sources inline', () => {
      const taskDir = makeTempDir('sync-mixed-errors');
      const missingFile = path.join(TEMP_ROOT, 'missing-source.txt');
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-sync-mixed-errors',
        working_directory: taskDir,
      }));

      const result = handlers.handleSyncFiles({
        task_id: 'task-sync-mixed-errors',
        files: [null, missingFile],
        direction: 'push',
      });
      const text = textOf(result);

      expect(text).toContain('✗ Invalid file path: null');
      expect(text).toContain(`✗ Source not found: ${missingFile}`);
    });

    it('reports filesystem copy errors without aborting the rest of the batch', () => {
      const taskDir = makeTempDir('sync-copy-error-task');
      const sourceDir = makeTempDir('sync-copy-error-source');
      const sourceFile = path.join(sourceDir, 'copy-me.txt');
      fs.writeFileSync(sourceFile, 'copy me');
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-sync-copy-error',
        working_directory: taskDir,
      }));
      vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
        throw new Error('permission denied');
      });

      const result = handlers.handleSyncFiles({
        task_id: 'task-sync-copy-error',
        files: [sourceFile],
        direction: 'push',
      });

      expect(textOf(result)).toContain(`✗ Error with ${sourceFile}: permission denied`);
    });
  });

  describe('handleTaskInfo', () => {
    it('defaults to status mode and returns the queue summary with pressure metadata', () => {
      mockTaskManager.getResourcePressureInfo.mockReturnValue({ level: 'high' });

      const result = handlers.handleTaskInfo({});

      expect(result.isError).toBeUndefined();
      expect(result.pressureLevel).toBe('high');
      expect(textOf(result)).toContain('## TORQUE Task Status');
      expect(textOf(result)).toContain('**Resource Pressure:** high');
    });

    it('requires task_id for result mode', () => {
      const result = handlers.handleTaskInfo({ mode: 'result' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('task_id is required for mode=result');
    });

    it('requires task_id for progress mode', () => {
      const result = handlers.handleTaskInfo({ mode: 'progress' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('task_id is required for mode=progress');
    });

    it('adds pressure metadata to result mode responses', () => {
      mockTaskManager.getResourcePressureInfo.mockReturnValue({ level: 'medium' });
      mockDb.getTask.mockReturnValue(makeTask({
        id: 'task-taskinfo-result',
        status: 'completed',
        started_at: '2026-03-01T00:00:00.000Z',
        completed_at: '2026-03-01T00:00:05.000Z',
        exit_code: 0,
        output: 'task_info result body',
      }));

      const result = handlers.handleTaskInfo({
        mode: 'result',
        task_id: 'task-taskinfo-result',
      });

      expect(result.isError).toBeUndefined();
      expect(result.pressureLevel).toBe('medium');
      expect(textOf(result)).toContain('task_info result body');
    });

    it('adds unknown pressure metadata to progress mode when pressure inspection fails', () => {
      mockTaskManager.getResourcePressureInfo.mockImplementation(() => {
        throw new Error('pressure read failed');
      });
      mockTaskManager.getTaskProgress.mockReturnValue({
        running: true,
        progress: 88,
        output: 'progress body',
      });

      const result = handlers.handleTaskInfo({
        mode: 'progress',
        task_id: 'task-taskinfo-progress',
      });

      expect(result.isError).toBeUndefined();
      expect(result.pressureLevel).toBe('unknown');
      expect(textOf(result)).toContain('progress body');
    });

    it('rejects unknown task_info modes', () => {
      const result = handlers.handleTaskInfo({
        mode: 'mystery',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('Unknown mode: mystery. Valid: status, result, progress');
    });
  });
});
