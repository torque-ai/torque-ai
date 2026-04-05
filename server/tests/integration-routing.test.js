'use strict';

const fs = require('fs');
const { createConfigMock } = require('./test-helpers');

const HANDLER_MODULE = '../handlers/integration/routing';
const MODULE_PATHS = [
  HANDLER_MODULE,
  '../database',
  '../task-manager',
  '../constants',
  '../handlers/error-codes',
  '../handlers/shared',
  '../utils/context-stuffing',
  '../utils/smart-scan',
  '../logger',
  '../config',
  '../db/config-core',
  '../db/host-management',
  '../db/provider-routing-core',
  '../db/task-core',
  '../db/workflow-engine',
  '../db/model-roles',
  '../db/model-capabilities',
  '../providers/ollama-shared',
  'uuid',
];

let routing;
let configValues;
let providerConfigs;
let defaultProvider;
let taskStore;
let workflowStore;
let dependencyLinks;
let uuidCounter = 0;

const mockDb = {
  checkOllamaHealth: vi.fn(),
  analyzeTaskForRouting: vi.fn(),
  getConfig: vi.fn(),
  getProvider: vi.fn(),
  getDefaultProvider: vi.fn(),
  determineTaskComplexity: vi.fn(),
  getSplitAdvisory: vi.fn(),
  getProviderHealthScore: vi.fn(),
  getProviderFallbackChain: vi.fn(),
  isCodexExhausted: vi.fn(),
  hasHealthyOllamaHost: vi.fn(),
  isProviderHealthy: vi.fn(),
  classifyTaskType: vi.fn(),
  detectTaskLanguage: vi.fn(),
  listOllamaHosts: vi.fn(),
  selectBestModel: vi.fn(),
  getModelTierForComplexity: vi.fn(),
  selectOllamaHostForModel: vi.fn(),
  createTask: vi.fn(),
  getTask: vi.fn(),
  getDbInstance: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  addTaskDependency: vi.fn(),
  decomposeTask: vi.fn(),
  createRoutingRule: vi.fn(),
  updateRoutingRule: vi.fn(),
  deleteRoutingRule: vi.fn(),
  patchTaskMetadata: vi.fn(),
};

const mockTaskManager = {
  processQueue: vi.fn(),
  resolveFileReferences: vi.fn(),
  extractJsFunctionBoundaries: vi.fn(),
  evaluateTaskSubmissionPolicy: vi.fn(),
  PROVIDER_DEFAULT_TIMEOUTS: {
    codex: 60,
    ollama: 25,
    'claude-cli': 45,
    openrouter: 50,
  },
};

const mockShared = {
  MAX_TASK_LENGTH: 5000,
  isPathTraversalSafe: vi.fn(),
  checkProviderAvailability: vi.fn(),
};

const mockConstants = {
  PROVIDER_DEFAULTS: {
    BATCH_LINE_LIMIT: 150,
    MOD_SAFE_LINE_LIMIT: 250,
  },
};

const ErrorCodes = {
  INVALID_PARAM: 'INVALID_PARAM',
  MISSING_REQUIRED_PARAM: 'MISSING_REQUIRED_PARAM',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  OPERATION_FAILED: 'OPERATION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

const mockErrorCodes = {
  ErrorCodes,
  makeError: vi.fn(),
};

const mockContextStuffing = {
  CONTEXT_STUFFING_PROVIDERS: new Set(['openrouter', 'google-ai']),
};

const mockSmartScan = {
  resolveContextFiles: vi.fn(),
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
};

const mockUuid = {
  v4: vi.fn(),
};

const mockModelRoles = {
  getModelForRole: vi.fn(),
  setModelRole: vi.fn(),
  clearModelRole: vi.fn(),
  listModelRoles: vi.fn(),
  VALID_ROLES: ['default', 'fallback', 'fast', 'balanced', 'quality'],
  ROLE_FALLBACK_CHAINS: { fast: ['fast', 'default'], balanced: ['balanced', 'default'], quality: ['quality', 'default'], default: ['default'], fallback: ['fallback', 'default'] },
  setDb: vi.fn(),
  createModelRoles: vi.fn(),
};

const mockModelCaps = {
  getModelCapabilities: vi.fn(),
  listModelCapabilities: vi.fn(),
  upsertModelCapabilities: vi.fn(),
  selectBestModel: vi.fn(),
  classifyTaskType: vi.fn(),
  detectTaskLanguage: vi.fn(),
  recordTaskOutcome: vi.fn(),
  getModelFormatFailures: vi.fn(),
  computeAdaptiveScores: vi.fn(),
  getModelLeaderboard: vi.fn(),
  setDb: vi.fn(),
  createModelCapabilities: vi.fn(),
};

const mockOllamaShared = {
  resolveOllamaModel: vi.fn((taskModel, requestedModel) => requestedModel || taskModel || 'mock-default-model'),
};

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function createConfigModuleMock() {
  return {
    init: vi.fn(),
    get: vi.fn((key, fallback) => {
      if (Object.prototype.hasOwnProperty.call(configValues, key)) {
        return configValues[key];
      }
      return fallback !== undefined ? fallback : null;
    }),
    getInt: vi.fn((key, fallback) => {
      if (!Object.prototype.hasOwnProperty.call(configValues, key)) {
        return fallback !== undefined ? fallback : 0;
      }
      const parsed = parseInt(configValues[key], 10);
      return Number.isNaN(parsed) ? (fallback !== undefined ? fallback : 0) : parsed;
    }),
    getBool: vi.fn((key) => {
      if (!Object.prototype.hasOwnProperty.call(configValues, key)) {
        return false;
      }
      const value = configValues[key];
      return value === true || value === '1' || value === 'true';
    }),
    isOptIn: vi.fn((key) => {
      if (!Object.prototype.hasOwnProperty.call(configValues, key)) {
        return false;
      }
      const value = configValues[key];
      return value === true || value === '1' || value === 'true';
    }),
  };
}

function setMockDbConfig(overrides = {}) {
  if (Object.keys(overrides).length > 0) {
    configValues = { ...configValues, ...overrides };
  }

  mockDb.getConfig.mockImplementation(createConfigMock(configValues));
}

function clearLoadedModules() {
  for (const modulePath of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that are not in cache yet.
    }
  }
}

function loadHandler() {
  clearLoadedModules();
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../task-manager', mockTaskManager);
  installCjsModuleMock('../constants', mockConstants);
  installCjsModuleMock('../handlers/error-codes', mockErrorCodes);
  installCjsModuleMock('../handlers/shared', mockShared);
  installCjsModuleMock('../utils/context-stuffing', mockContextStuffing);
  installCjsModuleMock('../utils/smart-scan', mockSmartScan);
  installCjsModuleMock('../logger', mockLogger);
  installCjsModuleMock('../config', createConfigModuleMock());
  installCjsModuleMock('../db/config-core', mockDb);
  installCjsModuleMock('../db/host-management', mockDb);
  installCjsModuleMock('../db/provider-routing-core', mockDb);
  installCjsModuleMock('../db/task-core', mockDb);
  installCjsModuleMock('../db/workflow-engine', mockDb);
  installCjsModuleMock('../db/model-roles', mockModelRoles);
  installCjsModuleMock('../db/model-capabilities', mockModelCaps);
  installCjsModuleMock('../providers/ollama-shared', mockOllamaShared);
  installCjsModuleMock('uuid', mockUuid);
  return require(HANDLER_MODULE);
}

function baseRoutingResult(overrides = {}) {
  return {
    provider: 'ollama',
    complexity: 'normal',
    reason: 'Default smart routing',
    rule: null,
    fallbackApplied: false,
    selectedHost: null,
    hostId: null,
    ...overrides,
  };
}

function textOf(result) {
  return result?.content?.map(part => part.text || '').join('\n') || '';
}

function getStoredTask(taskId) {
  return taskId ? taskStore.get(taskId) || null : null;
}

function taskFromResult(result) {
  return getStoredTask(result?.task_id || result?.__subscribe_task_id || null);
}

function makeLineCountText(lineCount) {
  return Array.from({ length: lineCount }, (_, idx) => `line-${idx + 1}`).join('\n');
}

function resetMockState() {
  configValues = {
    default_timeout: '33',
    auto_approve_simple: '0',
    require_review_for_complex: '1',
    codex_enabled: '1',
    codex_spark_enabled: '1',
    claude_cli_enabled: '1',
    ollama_presets: JSON.stringify({
      precise: {
        temperature: 0.2,
        top_p: 0.75,
        num_ctx: 4096,
        mirostat: 1,
      },
    }),
    ollama_balanced_model_fallback: 'fallback-balanced-model',
  };

  providerConfigs = {
    codex: { name: 'codex', enabled: true },
    'claude-cli': { name: 'claude-cli', enabled: true },
    ollama: { name: 'ollama', enabled: true },
    openrouter: { name: 'openrouter', enabled: true },
    'google-ai': { name: 'google-ai', enabled: true },
  };

  defaultProvider = 'codex';
  taskStore = new Map();
  workflowStore = new Map();
  dependencyLinks = [];
  uuidCounter = 0;

  mockUuid.v4.mockReset();
  mockUuid.v4.mockImplementation(() => {
    uuidCounter += 1;
    return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
  });

  mockErrorCodes.makeError.mockReset();
  mockErrorCodes.makeError.mockImplementation((code, message) => ({
    isError: true,
    error_code: code,
    content: [{ type: 'text', text: message }],
  }));

  mockShared.isPathTraversalSafe.mockReset();
  mockShared.isPathTraversalSafe.mockImplementation((candidate) => !String(candidate || '').includes('..'));

  mockShared.checkProviderAvailability.mockReset();
  mockShared.checkProviderAvailability.mockReturnValue(null);

  mockTaskManager.processQueue.mockReset();
  mockTaskManager.resolveFileReferences.mockReset();
  mockTaskManager.resolveFileReferences.mockReturnValue({ resolved: [], unresolved: [] });
  mockTaskManager.extractJsFunctionBoundaries.mockReset();
  mockTaskManager.extractJsFunctionBoundaries.mockReturnValue([]);
  mockTaskManager.evaluateTaskSubmissionPolicy.mockReset();
  mockTaskManager.evaluateTaskSubmissionPolicy.mockReturnValue(null);

  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.debug.mockReset();
  mockLogger.child.mockReset();
  mockLogger.child.mockImplementation(() => mockLogger);

  mockSmartScan.resolveContextFiles.mockReset();
  mockSmartScan.resolveContextFiles.mockReturnValue({
    contextFiles: [],
    reasons: new Map(),
  });

  mockModelRoles.getModelForRole.mockReset();
  mockModelRoles.getModelForRole.mockReturnValue('mock-default-model');

  mockModelCaps.getModelCapabilities.mockReset();
  mockModelCaps.getModelCapabilities.mockReturnValue({
    max_safe_edit_lines: 250,
    can_create_files: 1,
    can_edit_safely: 1,
    is_agentic: 0,
  });

  mockOllamaShared.resolveOllamaModel.mockReset();
  mockOllamaShared.resolveOllamaModel.mockImplementation(
    (taskModel, requestedModel) => requestedModel || taskModel || 'mock-default-model'
  );

  mockDb.checkOllamaHealth.mockReset();
  mockDb.checkOllamaHealth.mockResolvedValue(true);

  mockDb.analyzeTaskForRouting.mockReset();
  mockDb.analyzeTaskForRouting.mockReturnValue(baseRoutingResult());

  mockDb.getConfig.mockReset();
  setMockDbConfig();

  mockDb.getProvider.mockReset();
  mockDb.getProvider.mockImplementation((name) => providerConfigs[name] || null);

  mockDb.getDefaultProvider.mockReset();
  mockDb.getDefaultProvider.mockImplementation(() => defaultProvider);

  mockDb.determineTaskComplexity.mockReset();
  mockDb.determineTaskComplexity.mockImplementation(() => 'normal');

  mockDb.getSplitAdvisory.mockReset();
  mockDb.getSplitAdvisory.mockImplementation((complexity, files = []) => complexity === 'complex' && files.length >= 3);

  mockDb.getProviderHealthScore.mockReset();
  mockDb.getProviderHealthScore.mockImplementation((providerName) => {
    if (providerName === 'claude-cli') return 0.95;
    if (providerName === 'codex') return 0.8;
    return 0.5;
  });

  mockDb.getProviderFallbackChain.mockReset();
  mockDb.getProviderFallbackChain.mockImplementation((providerName) => [providerName, 'claude-cli', 'codex']);

  mockDb.isCodexExhausted.mockReset();
  mockDb.isCodexExhausted.mockReturnValue(false);

  mockDb.hasHealthyOllamaHost.mockReset();
  mockDb.hasHealthyOllamaHost.mockReturnValue(true);

  mockDb.isProviderHealthy.mockReset();
  mockDb.isProviderHealthy.mockReturnValue(true);

  mockDb.classifyTaskType.mockReset();
  mockDb.classifyTaskType.mockReturnValue('code_gen');

  mockDb.detectTaskLanguage.mockReset();
  mockDb.detectTaskLanguage.mockReturnValue('javascript');

  mockDb.listOllamaHosts.mockReset();
  mockDb.listOllamaHosts.mockReturnValue([
    { name: 'primary-host', enabled: true, status: 'healthy', models: JSON.stringify(['smart-primary', 'smart-secondary']) },
  ]);

  mockDb.selectBestModel.mockReset();
  mockDb.selectBestModel.mockImplementation((_taskType, _language, _complexity, availableModels) => (
    availableModels.map((model, idx) => ({
      model,
      score: 100 - idx,
      reason: `rank-${idx + 1}`,
    }))
  ));

  mockDb.getModelTierForComplexity.mockReset();
  mockDb.getModelTierForComplexity.mockImplementation((complexity) => ({
    tier: complexity === 'simple' ? 'fast' : complexity === 'complex' ? 'quality' : 'balanced',
    modelConfig: complexity === 'simple' ? 'tier-fast-model' : complexity === 'complex' ? 'tier-quality-model' : 'tier-balanced-model',
  }));

  mockDb.selectOllamaHostForModel.mockReset();
  mockDb.selectOllamaHostForModel.mockImplementation((model) => ({
    host: {
      name: `${model}-host`,
      running_tasks: 0,
    },
  }));

  mockDb.createTask.mockReset();
  mockDb.createTask.mockImplementation((task) => {
    const stored = {
      ...task,
      metadata: typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata,
    };
    taskStore.set(task.id, stored);
    return stored;
  });

  mockDb.getTask.mockReset();
  mockDb.getTask.mockImplementation((taskId) => taskStore.get(taskId) || null);

  mockDb.getDbInstance.mockReset();
  mockDb.getDbInstance.mockImplementation(() => ({
    prepare: (sql) => {
      if (sql === 'UPDATE tasks SET metadata = ? WHERE id = ?') {
        return {
          run: (metadataJson, taskId) => {
            const task = taskStore.get(taskId);
            if (!task) {
              return { changes: 0 };
            }
            task.metadata = JSON.parse(metadataJson);
            taskStore.set(taskId, task);
            return { changes: 1 };
          },
        };
      }
      if (sql === 'UPDATE tasks SET provider = NULL, metadata = ? WHERE id = ?') {
        return {
          run: (metadataJson, taskId) => {
            const task = taskStore.get(taskId);
            if (!task) {
              return { changes: 0 };
            }
            task.provider = null;
            task.metadata = JSON.parse(metadataJson);
            taskStore.set(taskId, task);
            return { changes: 1 };
          },
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  }));

  mockDb.createWorkflow.mockReset();
  mockDb.createWorkflow.mockImplementation((workflow) => {
    workflowStore.set(workflow.id, { ...workflow });
    return workflow;
  });

  mockDb.updateWorkflow.mockReset();
  mockDb.updateWorkflow.mockImplementation((workflowId, updates) => {
    const existing = workflowStore.get(workflowId) || { id: workflowId };
    const next = { ...existing, ...updates };
    workflowStore.set(workflowId, next);
    return next;
  });

  mockDb.addTaskDependency.mockReset();
  mockDb.addTaskDependency.mockImplementation((dependency) => {
    dependencyLinks.push(dependency);
    return dependency;
  });

  mockDb.decomposeTask.mockReset();
  mockDb.decomposeTask.mockReturnValue([]);

  mockDb.createRoutingRule.mockReset();
  mockDb.createRoutingRule.mockImplementation((rule) => ({
    id: 101,
    priority: rule.priority ?? 100,
    enabled: rule.enabled ?? true,
    ...rule,
  }));

  mockDb.updateRoutingRule.mockReset();
  mockDb.updateRoutingRule.mockImplementation((ruleId, updates) => ({
    id: 202,
    name: typeof ruleId === 'string' ? ruleId : 'updated-rule',
    rule_type: 'keyword',
    pattern: 'old-pattern',
    target_provider: 'codex',
    priority: 30,
    enabled: true,
    ...updates,
  }));

  mockDb.deleteRoutingRule.mockReset();
  mockDb.deleteRoutingRule.mockImplementation((ruleId) => ({
    rule: {
      name: String(ruleId),
      pattern: 'security',
      target_provider: 'codex',
    },
  }));

  mockDb.patchTaskMetadata.mockReset();
  mockDb.patchTaskMetadata.mockImplementation((taskId, metadata) => {
    const task = taskStore.get(taskId);
    if (task) {
      task.metadata = metadata;
      taskStore.set(taskId, task);
    }
    return { changes: task ? 1 : 0 };
  });
}

beforeAll(() => {
  resetMockState();
  routing = loadHandler();
});

beforeEach(() => {
  vi.restoreAllMocks();
  resetMockState();
});

afterAll(() => {
  clearLoadedModules();
  vi.restoreAllMocks();
});

describe('integration routing handlers', () => {
  describe('handleTestRouting', () => {
    it('rejects missing task descriptions', () => {
      const result = routing.handleTestRouting({});

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('task must be a non-empty string');
    });

    it('rejects path traversal in file arguments', () => {
      const result = routing.handleTestRouting({
        task: 'Inspect routing',
        files: ['../secrets.txt'],
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('path traversal');
    });

    it('formats matched rule details and passes normalized files to routing analysis', () => {
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'codex',
        reason: 'Matched security regex',
        rule: {
          name: 'security-audit',
          rule_type: 'regex',
          priority: 5,
          pattern: '\\bsecurity\\b',
          description: 'Prefer Codex for security review tasks',
        },
      }));

      const result = routing.handleTestRouting({
        task: 'Run a security audit on auth token handling',
        files: 'src/auth.js',
      });

      expect(mockDb.analyzeTaskForRouting).toHaveBeenCalledWith(
        'Run a security audit on auth token handling',
        null,
        ['src/auth.js']
      );

      const text = textOf(result);
      expect(text).toContain('Routing Test Result');
      expect(text).toContain('security-audit');
      expect(text).toContain('Matched security regex');
      expect(text).toContain('Prefer Codex for security review tasks');
      expect(text).toContain('src/auth.js');
    });
  });

  describe('routing rule CRUD handlers', () => {
    it('rejects unknown providers when adding rules', () => {
      const result = routing.handleAddRoutingRule({
        name: 'bad-provider',
        pattern: 'README',
        target_provider: 'missing-provider',
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Unknown provider');
    });

    it('creates rules with a default keyword type', () => {
      const result = routing.handleAddRoutingRule({
        name: 'docs-route',
        pattern: 'README',
        target_provider: 'codex',
      });

      expect(mockDb.createRoutingRule).toHaveBeenCalledWith(expect.objectContaining({
        name: 'docs-route',
        pattern: 'README',
        target_provider: 'codex',
        rule_type: 'keyword',
      }));

      const text = textOf(result);
      expect(text).toContain('Routing Rule Created');
      expect(text).toContain('docs-route');
      expect(text).toContain('keyword');
    });

    it('rejects missing identifiers when updating rules', () => {
      const result = routing.handleUpdateRoutingRule({ pattern: 'new-pattern' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('rule (ID or name) is required');
    });

    it('returns not found when updating a missing rule', () => {
      mockDb.updateRoutingRule.mockImplementationOnce(() => {
        throw new Error('missing');
      });

      const result = routing.handleUpdateRoutingRule({
        rule: 'missing-rule',
        pattern: 'new-pattern',
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Routing rule not found: missing-rule');
    });

    it('formats updated rule details on success', () => {
      const result = routing.handleUpdateRoutingRule({
        rule: 'docs-route',
        target_provider: 'claude-cli',
        priority: 12,
      });

      expect(mockDb.updateRoutingRule).toHaveBeenCalledWith('docs-route', {
        target_provider: 'claude-cli',
        priority: 12,
      });

      const text = textOf(result);
      expect(text).toContain('Routing Rule Updated');
      expect(text).toContain('claude-cli');
      expect(text).toContain('12');
    });

    it('returns not found when delete reports zero changes', () => {
      mockDb.deleteRoutingRule.mockReturnValueOnce({ changes: 0 });

      const result = routing.handleDeleteRoutingRule({ rule: 'missing-rule' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Routing rule not found: missing-rule');
    });

    it('formats deleted rule details when delete succeeds', () => {
      const result = routing.handleDeleteRoutingRule({ rule: 'security-route' });

      const text = textOf(result);
      expect(text).toContain('Routing Rule Deleted');
      expect(text).toContain('security-route');
      expect(text).toContain('security');
      expect(text).toContain('codex');
    });
  });

  describe('handleSmartSubmitTask basics', () => {
    it('rejects invalid tuning payloads', async () => {
      const result = await routing.handleSmartSubmitTask({
        task: 'Create a formatter',
        tuning: [1, 2, 3],
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('tuning must be an object');
    });

    it('applies preset tuning and explicit overrides to stored metadata', async () => {
      const result = await routing.handleSmartSubmitTask({
        task: 'Create a formatter',
        provider: 'codex',
        tuning: {
          preset: 'precise',
          temperature: 0.35,
        },
      });

      const task = taskFromResult(result);
      expect(task).toBeTruthy();
      expect(task.metadata.tuning_overrides).toEqual({
        temperature: 0.35,
        top_p: 0.75,
        num_ctx: 4096,
        mirostat: 1,
      });
    });

    it('rejects unknown tuning presets', async () => {
      const result = await routing.handleSmartSubmitTask({
        task: 'Create a formatter',
        tuning: { preset: 'missing-preset' },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Unknown tuning preset');
    });

    it('respects explicit provider overrides and skips smart routing analysis', async () => {
      const result = await routing.handleSmartSubmitTask({
        task: 'Tweak queue telemetry',
        provider: 'claude-cli',
      });

      const task = taskFromResult(result);
      expect(task).toBeTruthy();
      expect(task.provider).toBe('claude-cli');
      expect(task.metadata.user_provider_override).toBe(true);
      expect(task.metadata.requested_provider).toBe('claude-cli');
      expect(mockDb.analyzeTaskForRouting).not.toHaveBeenCalled();
      expect(mockDb.checkOllamaHealth).not.toHaveBeenCalled();
      expect(result.subscription_target).toMatchObject({
        kind: 'task',
        task_id: result.task_id,
        task_ids: [result.task_id],
      });
    });

    it('stores tier-list metadata and leaves provider unassigned in slot-pull mode', async () => {
      setMockDbConfig({ scheduling_mode: 'slot-pull' });
      mockDb.analyzeTaskForRouting
        .mockReturnValueOnce(baseRoutingResult({
          provider: 'ollama',
          complexity: 'normal',
          reason: 'Default smart routing',
        }))
        .mockReturnValueOnce(baseRoutingResult({
          provider: 'ollama',
          complexity: 'normal',
          reason: 'Tier-list routing',
          eligible_providers: ['codex', 'deepinfra', 'ollama'],
          capability_requirements: ['file_creation'],
          quality_tier: 'normal',
        }));

      const result = await routing.handleSmartSubmitTask({
        task: 'Create a new scheduler helper module',
      });

      const task = taskFromResult(result);
      expect(task).toBeTruthy();
      expect(task.provider).toBeNull();
      expect(task.metadata).toMatchObject({
        eligible_providers: ['codex', 'deepinfra', 'ollama'],
        capability_requirements: ['file_creation'],
        quality_tier: 'normal',
        user_provider_override: false,
      });
      expect(mockDb.analyzeTaskForRouting).toHaveBeenNthCalledWith(
        2,
        'Create a new scheduler helper module',
        process.cwd(),
        undefined,
        {
          tierList: true,
          isUserOverride: false,
          overrideProvider: null,
        }
      );
    });

    it('locks explicit providers into singleton tier lists in slot-pull mode', async () => {
      setMockDbConfig({ scheduling_mode: 'slot-pull' });
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'claude-cli',
        complexity: 'normal',
        reason: 'Override tier-list routing',
        eligible_providers: ['claude-cli'],
        capability_requirements: ['reasoning'],
        quality_tier: 'normal',
      }));

      const result = await routing.handleSmartSubmitTask({
        task: 'Tweak queue telemetry',
        provider: 'claude-cli',
      });

      const task = taskFromResult(result);
      expect(task).toBeTruthy();
      expect(task.provider).toBe('claude-cli');
      expect(task.metadata).toMatchObject({
        eligible_providers: ['claude-cli'],
        capability_requirements: ['reasoning'],
        quality_tier: 'normal',
        user_provider_override: true,
        requested_provider: 'claude-cli',
      });
      expect(mockDb.analyzeTaskForRouting).toHaveBeenCalledWith(
        'Tweak queue telemetry',
        process.cwd(),
        undefined,
        {
          tierList: true,
          isUserOverride: true,
          overrideProvider: 'claude-cli',
        }
      );
    });

    it('uses determineTaskComplexity when an override bypasses routing complexity', async () => {
      await routing.handleSmartSubmitTask({
        task: 'Create a formatter',
        provider: 'codex',
        files: ['src/formatter.js'],
      });

      expect(mockDb.determineTaskComplexity).toHaveBeenCalledWith('Create a formatter', ['src/formatter.js']);
    });

    it('returns provider availability errors before creating tasks', async () => {
      mockShared.checkProviderAvailability.mockReturnValueOnce({
        error: mockErrorCodes.makeError(ErrorCodes.OPERATION_FAILED, 'No providers available'),
      });

      const result = await routing.handleSmartSubmitTask({
        task: 'Create a formatter',
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('No providers available');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });

    it('promotes test-writing tasks to Codex Spark', async () => {
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'ollama',
        complexity: 'normal',
      }));

      const result = await routing.handleSmartSubmitTask({
        task: 'Write unit tests for the queue scheduler',
      });

      const task = taskFromResult(result);
      expect(task.provider).toBe('codex');
      expect(task.model).toBe('gpt-5.3-codex-spark');
      expect(task.timeout_minutes).toBe(25);
    });

    it('routes greenfield local tasks to Codex Spark when Codex is enabled', async () => {
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'ollama',
        complexity: 'normal',
      }));

      const result = await routing.handleSmartSubmitTask({
        task: 'Create a new scheduler helper module',
      });

      const task = taskFromResult(result);
      expect(task.provider).toBe('codex');
      expect(task.model).toBe('gpt-5.3-codex-spark');
    });
  });

  describe('handleSmartSubmitTask routing heuristics', () => {
    it('routes small-file modification tasks to the local safe model', async () => {
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'ollama',
        complexity: 'normal',
      }));
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(makeLineCountText(40));

      const result = await routing.handleSmartSubmitTask({
        task: 'Implement retry logic in scheduler.js',
        files: ['src/scheduler.js'],
        working_directory: process.cwd(),
      });

      const task = taskFromResult(result);
      expect(task.provider).toBe('ollama');
      expect(task.model).toBe('mock-default-model');
      expect(textOf(result)).toContain('local model (safe)');
    });

    it('routes large-file modification tasks to Codex Spark', async () => {
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'ollama',
        complexity: 'normal',
      }));
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(makeLineCountText(400));

      const result = await routing.handleSmartSubmitTask({
        task: 'Implement retry logic in scheduler.js',
        files: ['src/scheduler.js'],
        working_directory: process.cwd(),
      });

      const task = taskFromResult(result);
      expect(task.provider).toBe('codex');
      expect(task.model).toBe('gpt-5.3-codex-spark');
      expect(textOf(result)).toContain('Codex Spark');
    });

    it('routes modifications to claude-cli when Codex is disabled', async () => {
      setMockDbConfig({ codex_enabled: '0' });
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'ollama',
        complexity: 'normal',
      }));
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(makeLineCountText(400));

      const result = await routing.handleSmartSubmitTask({
        task: 'Implement retry logic in scheduler.js',
        files: ['src/scheduler.js'],
        working_directory: process.cwd(),
      });

      const task = taskFromResult(result);
      expect(task.provider).toBe('claude-cli');
      expect(task.model).toBeNull();
    });

    it('falls back to the model-roles fallback when Codex and claude-cli are unavailable', async () => {
      setMockDbConfig({ codex_enabled: '0', claude_cli_enabled: '0' });
      mockModelRoles.getModelForRole.mockImplementation((provider, role) => {
        if (role === 'fallback') return 'mock-fallback-model';
        return 'mock-default-model';
      });
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'ollama',
        complexity: 'normal',
      }));
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(makeLineCountText(400));

      const result = await routing.handleSmartSubmitTask({
        task: 'Implement retry logic in scheduler.js',
        files: ['src/scheduler.js'],
        working_directory: process.cwd(),
      });

      const task = taskFromResult(result);
      expect(task.provider).toBe('ollama');
      expect(task.model).toBe('mock-fallback-model');
    });

    it('uses smart model fallback when the primary host is busy', async () => {
      setMockDbConfig({ codex_enabled: '0' });
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'ollama',
        complexity: 'normal',
      }));
      mockDb.selectBestModel
        .mockReturnValueOnce([
          { model: 'smart-primary', score: 98, reason: 'best fit' },
          { model: 'smart-secondary', score: 92, reason: 'backup fit' },
        ])
        .mockReturnValueOnce([
          { model: 'smart-primary', score: 98, reason: 'best fit' },
          { model: 'smart-secondary', score: 92, reason: 'backup fit' },
        ]);
      mockDb.selectOllamaHostForModel.mockImplementation((model) => {
        if (model === 'smart-primary') {
          return { host: { name: 'busy-host', running_tasks: 2 } };
        }
        return { host: { name: 'idle-host', running_tasks: 0 } };
      });

      const result = await routing.handleSmartSubmitTask({
        task: 'Review scheduler.js for current behavior',
        files: ['src/scheduler.js'],
      });

      const task = taskFromResult(result);
      expect(task.provider).toBe('ollama');
      expect(task.model).toBe('smart-secondary');
    });

    it('keeps the primary model when async-heavy tasks skip host fallback', async () => {
      setMockDbConfig({ codex_enabled: '0' });
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'ollama',
        complexity: 'normal',
      }));
      mockDb.selectBestModel.mockReturnValueOnce([
        { model: 'smart-primary', score: 98, reason: 'best fit' },
        { model: 'smart-secondary', score: 92, reason: 'backup fit' },
      ]);
      mockDb.selectOllamaHostForModel.mockImplementation((model) => {
        if (model === 'smart-primary') {
          return { host: { name: 'busy-host', running_tasks: 2 } };
        }
        return { host: { name: 'idle-host', running_tasks: 0 } };
      });

      const result = await routing.handleSmartSubmitTask({
        task: 'Review async await flow in scheduler.js',
        files: ['src/scheduler.js'],
      });

      const task = taskFromResult(result);
      expect(task.model).toBe('smart-primary');
    });

    it('falls back to the default provider when the selected provider is disabled', async () => {
      providerConfigs.openrouter.enabled = false;
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'openrouter',
        complexity: 'normal',
        reason: 'Rule selected openrouter',
      }));

      const result = await routing.handleSmartSubmitTask({
        task: 'Summarize existing scheduler behavior',
      });

      const task = taskFromResult(result);
      expect(task.provider).toBe('codex');
      expect(task.metadata.routing_reason).toContain('original provider disabled');
    });

    it('falls back to the healthiest provider when the selected provider is unhealthy', async () => {
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'openrouter',
        complexity: 'normal',
        reason: 'Selected openrouter',
      }));
      mockDb.isProviderHealthy.mockImplementation((providerName) => providerName !== 'openrouter');
      mockDb.getProviderFallbackChain.mockReturnValueOnce(['openrouter', 'codex', 'claude-cli']);
      mockDb.getProviderHealthScore.mockImplementation((providerName) => {
        if (providerName === 'claude-cli') return 0.99;
        if (providerName === 'codex') return 0.7;
        return 0.2;
      });

      const result = await routing.handleSmartSubmitTask({
        task: 'Summarize existing scheduler behavior',
      });

      const task = taskFromResult(result);
      expect(task.provider).toBe('claude-cli');
      expect(textOf(result)).toContain('openrouter unhealthy');
    });

    it('returns policy rejections without creating tasks', async () => {
      mockTaskManager.evaluateTaskSubmissionPolicy.mockReturnValueOnce({
        blocked: true,
        reason: 'Manual approval required',
      });

      const result = await routing.handleSmartSubmitTask({
        task: 'Create a formatter',
        provider: 'codex',
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Manual approval required');
      expect(mockDb.createTask).not.toHaveBeenCalled();
    });
  });

  describe('handleSmartSubmitTask workflows and metadata', () => {
    it('auto-decomposes complex C# tasks into a workflow subscription', async () => {
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'ollama',
        complexity: 'complex',
        reason: 'Complex C# task',
      }));
      mockDb.decomposeTask.mockReturnValueOnce([
        'Extract repository interface',
        'Wire repository into service',
      ]);

      const result = await routing.handleSmartSubmitTask({
        task: 'Refactor Service.cs in C# to add a repository abstraction',
        files: ['src/Service.cs'],
        working_directory: process.cwd(),
      });

      expect(result.workflow_id).toBeTruthy();
      expect(result.task_ids).toHaveLength(2);
      expect(result.subscription_target).toMatchObject({
        kind: 'workflow',
        workflow_id: result.workflow_id,
        task_ids: result.task_ids,
      });
      expect(mockDb.createWorkflow).toHaveBeenCalledTimes(1);
      expect(dependencyLinks).toHaveLength(1);
      expect(textOf(result)).toContain('Task Auto-Decomposed into Workflow');
      expect(textOf(result)).toContain('### Subscribe');
    });

    it('auto-decomposes large JS files into function batches', async () => {
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(makeLineCountText(620));
      mockTaskManager.extractJsFunctionBoundaries.mockReturnValueOnce([
        { name: 'alpha', startLine: 1, endLine: 80, lineCount: 80 },
        { name: 'beta', startLine: 81, endLine: 160, lineCount: 80 },
        { name: 'gamma', startLine: 161, endLine: 240, lineCount: 80 },
        { name: 'delta', startLine: 241, endLine: 320, lineCount: 80 },
      ]);

      const result = await routing.handleSmartSubmitTask({
        task: 'Add logging to src/app.js',
        files: ['src/app.js'],
        working_directory: process.cwd(),
      });

      expect(result.workflow_id).toBeTruthy();
      expect(result.task_ids).toHaveLength(4);
      expect(textOf(result)).toContain('JS File Auto-Decomposed into Workflow');
      expect(textOf(result)).toContain('### Subscribe');
    });

    it('stores split suggestions for complex multi-file tasks', async () => {
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'codex',
        complexity: 'complex',
      }));

      const result = await routing.handleSmartSubmitTask({
        task: 'Implement routing across multiple files',
        files: [
          'src/task-types.ts',
          'server/tests/task-router.spec.js',
          'server/handlers/task-router.js',
        ],
      });

      const task = taskFromResult(result);
      expect(task.metadata.split_advisory).toBe(true);
      expect(task.metadata.split_suggestions).toEqual([
        'Update type definitions in src/task-types.ts',
        'Write tests in server/tests/task-router.spec.js',
        'Implement changes in server/handlers/task-router.js',
      ]);
    });

    it('stores context files for providers that support context stuffing', async () => {
      mockSmartScan.resolveContextFiles.mockReturnValueOnce({
        contextFiles: ['src/app.js', 'src/util.js'],
        reasons: new Map([
          ['src/app.js', 'task mention'],
          ['src/util.js', 'import graph'],
        ]),
      });

      const result = await routing.handleSmartSubmitTask({
        task: 'Explain scheduler flow',
        provider: 'openrouter',
        context_depth: 2,
      });

      const task = taskFromResult(result);
      expect(mockSmartScan.resolveContextFiles).toHaveBeenCalledWith({
        taskDescription: 'Explain scheduler flow',
        workingDirectory: process.cwd(),
        files: [],
        contextDepth: 2,
      });
      expect(task.metadata.context_files).toEqual(['src/app.js', 'src/util.js']);
      expect(task.metadata.context_scan_reasons).toEqual({
        'src/app.js': 'task mention',
        'src/util.js': 'import graph',
      });
    });

    it('skips context stuffing when explicitly disabled', async () => {
      const result = await routing.handleSmartSubmitTask({
        task: 'Explain scheduler flow',
        provider: 'openrouter',
        context_stuff: false,
      });

      expect(taskFromResult(result)).toBeTruthy();
      expect(mockSmartScan.resolveContextFiles).not.toHaveBeenCalled();
    });

    it('marks complex tasks for review when configured', async () => {
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'codex',
        complexity: 'complex',
      }));

      const result = await routing.handleSmartSubmitTask({
        task: 'Design a distributed scheduler with retries and failover',
      });

      const task = taskFromResult(result);
      expect(task.review_status).toBe('pending');
      expect(task.metadata.needs_review).toBe(true);
    });

    it('auto-approves simple tasks when auto_approve_simple is enabled', async () => {
      setMockDbConfig({ auto_approve_simple: '1' });
      mockDb.analyzeTaskForRouting.mockReturnValueOnce(baseRoutingResult({
        provider: 'codex',
        complexity: 'simple',
      }));

      const result = await routing.handleSmartSubmitTask({
        task: 'Rename a variable',
      });

      const task = taskFromResult(result);
      expect(task.review_status).toBeNull();
      expect(textOf(result)).toContain('No (auto-approve)');
    });
  });
});
