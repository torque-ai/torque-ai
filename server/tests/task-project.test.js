function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearCjsModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module was not loaded in this test.
  }
}

function clearModules(modulePaths) {
  for (const modulePath of modulePaths) {
    clearCjsModule(modulePath);
  }
}

function textOf(result) {
  return result?.content?.find((item) => item.type === 'text')?.text || '';
}

function createSharedMock() {
  const shared = {
    ErrorCodes: {
      INVALID_PARAM: 'INVALID_PARAM',
      MISSING_REQUIRED_PARAM: 'MISSING_REQUIRED_PARAM',
      PATH_TRAVERSAL: 'PATH_TRAVERSAL',
      RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
      TASK_NOT_FOUND: 'TASK_NOT_FOUND',
    },
    MAX_BATCH_SIZE: 100,
    safeLimit: vi.fn((value, fallback) => (value === undefined ? fallback : value)),
    safeDate: vi.fn((value) => value),
    isPathTraversalSafe: vi.fn(() => true),
  };
  shared.makeError = vi.fn((errorCode, message) => ({
    isError: true,
    error_code: errorCode,
    content: [{ type: 'text', text: message }],
  }));
  return shared;
}

function createLoggerMock() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  logger.child = vi.fn(() => logger);
  return logger;
}

function createTaskProjectDbMock(overrides = {}) {
  const statsFactory = overrides.getProjectStats || (() => ({
    total_tasks: 7,
    tasks_by_status: { running: 2, completed: 5 },
    pipelines: 1,
    scheduled_tasks: 0,
    cost: { total_tokens: 9876, total_cost: 3.25 },
    top_templates: [],
    top_tags: [],
    recent_tasks: [],
  }));
  const configFactory = overrides.getEffectiveProjectConfig || (() => ({
    max_concurrent: 3,
    max_daily_cost: 5,
    max_daily_tokens: 20000,
    default_timeout: 30,
    default_priority: 0,
    auto_approve: false,
    enabled: true,
    global_max_concurrent: 9,
  }));

  return {
    getProjectRoot: vi.fn(overrides.getProjectRoot || ((workingDir) => `${workingDir}\\root`)),
    getCurrentProject: vi.fn(overrides.getCurrentProject || (() => overrides.project ?? 'alpha')),
    getProjectStats: vi.fn((project) => statsFactory(project)),
    getEffectiveProjectConfig: vi.fn((project) => configFactory(project)),
    canProjectStartTask: vi.fn(overrides.canProjectStartTask || (() => ({ allowed: true }))),
    getProjectRunningCount: vi.fn(overrides.getProjectRunningCount || (() => 2)),
    getProjectDailyUsage: vi.fn(overrides.getProjectDailyUsage || (() => ({ cost: 1.5, tokens: 1500 }))),
    setProjectConfig: vi.fn((project, config) => ({
      project,
      max_concurrent: 0,
      max_daily_cost: 0,
      max_daily_tokens: 0,
      default_timeout: 30,
      default_priority: 0,
      auto_approve: false,
      enabled: true,
      build_verification_enabled: false,
      build_command: null,
      build_timeout: null,
      rollback_on_build_failure: true,
      test_verification_enabled: false,
      test_command: null,
      test_timeout: null,
      rollback_on_test_failure: false,
      ...config,
    })),
    listProjectConfigs: vi.fn(overrides.listProjectConfigs || (() => [])),
    listProjects: vi.fn(overrides.listProjects || (() => [])),
  };
}

function createAutomationDbMock(options = {}) {
  let currentConfig = options.initialConfig === undefined ? null : { ...options.initialConfig };
  const metadata = { ...(options.metadata || {}) };
  return {
    getProjectFromPath: vi.fn(options.getProjectFromPath || (() => options.project ?? 'alpha')),
    safeAddColumn: vi.fn(),
    setProjectConfig: vi.fn((project, configUpdate) => {
      currentConfig = { ...(currentConfig || {}), ...configUpdate };
      return currentConfig;
    }),
    getProjectConfig: vi.fn(() => currentConfig),
    setProjectMetadata: vi.fn((project, key, value) => {
      metadata[key] = value;
    }),
    getProjectMetadata: vi.fn((project, key) => metadata[key] ?? null),
  };
}

const TASK_PROJECT_MODULES = [
  '../handlers/task/project',
  '../db/config-core',
  '../db/cost-tracking',
  '../db/task-core',
  '../db/event-tracking',
  '../db/project-config-core',
  '../db/task-metadata',
  '../config',
  '../task-manager',
  '../handlers/shared',
  '../handlers/task/utils',
  '../logger',
];

const AUTOMATION_MODULES = [
  '../handlers/automation-handlers',
  '../handlers/automation-ts-tools',
  '../handlers/automation-batch-orchestration',
  '../database',
  '../db/config-core',
  '../db/task-core',
  '../db/project-config-core',
  '../task-manager',
  '../handlers/shared',
  '../logger',
  '../constants',
  '../utils/context-enrichment',
  '../utils/safe-exec',
  '../execution/command-policy',
  '../test-runner-registry',
];

function loadTaskProject({ dbMock, sharedMock, loggerMock, formatTimeMock }) {
  clearModules(TASK_PROJECT_MODULES);
  installCjsModuleMock('../db/config-core', {});
  installCjsModuleMock('../db/cost-tracking', {});
  installCjsModuleMock('../db/task-core', {});
  installCjsModuleMock('../db/event-tracking', {});
  installCjsModuleMock('../db/project-config-core', dbMock);
  installCjsModuleMock('../db/task-metadata', {});
  installCjsModuleMock('../config', { get: vi.fn(() => null) });
  installCjsModuleMock('../task-manager', { startTask: vi.fn() });
  installCjsModuleMock('../handlers/shared', sharedMock);
  installCjsModuleMock('../handlers/task/utils', { formatTime: formatTimeMock });
  installCjsModuleMock('../logger', loggerMock);
  return require('../handlers/task/project');
}

function loadAutomationHandlers({ dbMock, sharedMock, loggerMock }) {
  clearModules(AUTOMATION_MODULES);
  installCjsModuleMock('../database', dbMock);
  installCjsModuleMock('../db/config-core', {});
  installCjsModuleMock('../db/task-core', {});
  installCjsModuleMock('../db/project-config-core', dbMock);
  installCjsModuleMock('../task-manager', {});
  installCjsModuleMock('../handlers/shared', sharedMock);
  installCjsModuleMock('../logger', loggerMock);
  installCjsModuleMock('../constants', { TASK_TIMEOUTS: {} });
  installCjsModuleMock('../utils/context-enrichment', {
    buildErrorFeedbackPrompt: vi.fn(() => 'feedback prompt'),
  });
  installCjsModuleMock('../utils/safe-exec', {
    safeExecChain: vi.fn(() => ({ exitCode: 0, output: 'ok' })),
  });
  installCjsModuleMock('../execution/command-policy', {
    executeValidatedCommandSync: vi.fn(() => ''),
  });
  installCjsModuleMock('../test-runner-registry', {
    createTestRunnerRegistry: vi.fn(() => ({
      runVerifyCommand: vi.fn(),
      runRemoteOrLocal: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    })),
  });
  installCjsModuleMock('../handlers/automation-ts-tools', {});
  installCjsModuleMock('../handlers/automation-batch-orchestration', {});
  return require('../handlers/automation-handlers');
}

afterEach(() => {
  vi.restoreAllMocks();
  clearModules([...new Set([...TASK_PROJECT_MODULES, ...AUTOMATION_MODULES])]);
});

describe('task-project project configuration handlers', () => {
  let sharedMock;
  let loggerMock;
  let formatTimeMock;
  let dbMock;
  let handlers;

  beforeEach(() => {
    sharedMock = createSharedMock();
    loggerMock = createLoggerMock();
    formatTimeMock = vi.fn((value) => `FMT(${value})`);
    dbMock = createTaskProjectDbMock();
    handlers = loadTaskProject({ dbMock, sharedMock, loggerMock, formatTimeMock });
  });

  it('handleCurrentProject uses the provided working directory for project resolution', () => {
    const result = handlers.handleCurrentProject({ working_directory: 'C:\\repo\\alpha\\src' });

    expect(dbMock.getProjectRoot).toHaveBeenCalledWith('C:\\repo\\alpha\\src');
    expect(dbMock.getCurrentProject).toHaveBeenCalledWith('C:\\repo\\alpha\\src');
    expect(textOf(result)).toContain('**Working Directory:** C:\\repo\\alpha\\src');
    expect(textOf(result)).toContain('**Project Root:** C:\\repo\\alpha\\src\\root');
    expect(textOf(result)).toContain('**Project:** alpha');
  });

  it('handleCurrentProject falls back to process.cwd when no working directory is passed', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\repo\\beta\\pkg');
    dbMock.getProjectRoot.mockReturnValue('C:\\repo\\beta');
    dbMock.getCurrentProject.mockReturnValue('beta');

    const result = handlers.handleCurrentProject({});

    expect(dbMock.getProjectRoot).toHaveBeenCalledWith('C:\\repo\\beta\\pkg');
    expect(dbMock.getCurrentProject).toHaveBeenCalledWith('C:\\repo\\beta\\pkg');
    expect(textOf(result)).toContain('**Project:** beta');
  });

  it('handleCurrentProject returns a none-detected message for invalid projects', () => {
    dbMock.getCurrentProject.mockReturnValue(null);

    const result = handlers.handleCurrentProject({ working_directory: 'C:\\outside\\repo' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('**Project:** (none detected)');
    expect(textOf(result)).toContain('derived from the project root directory');
  });

  it('handleCurrentProject omits quota output when the effective config is unlimited', () => {
    dbMock.getEffectiveProjectConfig.mockReturnValue({
      max_concurrent: 0,
      max_daily_cost: 0,
      max_daily_tokens: 0,
      default_timeout: 30,
      default_priority: 0,
      auto_approve: false,
      enabled: true,
      global_max_concurrent: 9,
    });

    const result = handlers.handleCurrentProject({ working_directory: 'C:\\repo\\alpha' });

    expect(textOf(result)).not.toContain('### Quotas');
  });

  it('handleCurrentProject renders quota rejection reasons when the project is blocked', () => {
    dbMock.canProjectStartTask.mockReturnValue({ allowed: false, reason: 'daily cost cap reached' });

    const result = handlers.handleCurrentProject({ working_directory: 'C:\\repo\\alpha' });

    expect(textOf(result)).toContain('**Can Submit Tasks:** No - daily cost cap reached');
    expect(textOf(result)).toContain('- **Concurrency:** 2/3');
    expect(textOf(result)).toContain('- **Daily Cost:** $1.50/$5.00');
    expect(textOf(result)).toContain('- **Daily Tokens:** 1500/20000');
  });

  it('handleProjectStats renders templates, tags, and recent tasks for an explicit project', () => {
    dbMock.getProjectStats.mockReturnValue({
      total_tasks: 9,
      tasks_by_status: { pending: 2, completed: 7 },
      pipelines: 2,
      scheduled_tasks: 1,
      cost: { total_tokens: 12345, total_cost: 6.789 },
      top_templates: [{ template_name: 'Bugfix', count: 4 }],
      top_tags: [{ tag: 'backend', count: 3 }],
      recent_tasks: [
        {
          id: '12345678-abcd-efab-cdef-1234567890ab',
          status: 'completed',
          task_description: 'Investigate project defaults drift',
          created_at: '2026-03-01T12:00:00.000Z',
        },
      ],
    });

    const result = handlers.handleProjectStats({ project: 'gamma' });

    expect(dbMock.getProjectStats).toHaveBeenCalledWith('gamma');
    expect(formatTimeMock).toHaveBeenCalledWith('2026-03-01T12:00:00.000Z');
    expect(textOf(result)).toContain('## Project: gamma');
    expect(textOf(result)).toContain('- Bugfix: 4 uses');
    expect(textOf(result)).toContain('- backend: 3 tasks');
    expect(textOf(result)).toContain('| 12345678... | completed | Investigate project defau...');
    expect(textOf(result)).toContain('FMT(2026-03-01T12:00:00.000Z)');
  });

  it('handleProjectStats resolves the project from process.cwd when omitted', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\repo\\delta\\services');
    dbMock.getCurrentProject.mockReturnValue('delta');

    const result = handlers.handleProjectStats({});

    expect(dbMock.getCurrentProject).toHaveBeenCalledWith('C:\\repo\\delta\\services');
    expect(dbMock.getProjectStats).toHaveBeenCalledWith('delta');
    expect(textOf(result)).toContain('## Project: delta');
  });

  it('handleProjectStats returns a missing-param error when no project can be resolved', () => {
    dbMock.getCurrentProject.mockReturnValue(null);

    const result = handlers.handleProjectStats({});

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe(sharedMock.ErrorCodes.MISSING_REQUIRED_PARAM);
    expect(textOf(result)).toContain('Unable to determine project');
  });

  it('handleConfigureProject resolves the project from cwd and persists only provided settings', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\repo\\omega\\src');
    dbMock.getCurrentProject.mockReturnValue('omega');

    const result = handlers.handleConfigureProject({
      max_concurrent: 4,
      default_timeout: 45,
      auto_approve: true,
      build_verification_enabled: true,
      build_command: 'npm run build',
      test_verification_enabled: true,
      test_command: 'npm test',
      rollback_on_test_failure: true,
    });

    expect(dbMock.setProjectConfig).toHaveBeenCalledWith('omega', {
      max_concurrent: 4,
      default_timeout: 45,
      auto_approve: true,
      build_verification_enabled: true,
      build_command: 'npm run build',
      test_verification_enabled: true,
      test_command: 'npm test',
      rollback_on_test_failure: true,
    });
    expect(textOf(result)).toContain('| Max Concurrent | 4 |');
    expect(textOf(result)).toContain('| Build Command | npm run build |');
    expect(textOf(result)).toContain('| Test Command | npm test |');
    expect(textOf(result)).toContain('| Rollback on Failure | Yes |');
  });

  it('handleConfigureProject falls back to the current config view when no settings are provided', () => {
    const result = handlers.handleConfigureProject({ project: 'alpha' });

    expect(dbMock.setProjectConfig).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('## Project Configuration: alpha');
  });

  it('handleConfigureProject returns a missing-param error for invalid projects', () => {
    dbMock.getCurrentProject.mockReturnValue(null);

    const result = handlers.handleConfigureProject({});

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe(sharedMock.ErrorCodes.MISSING_REQUIRED_PARAM);
    expect(textOf(result)).toContain('Please specify a project name');
  });

  it('handleGetProjectConfig resolves the project from cwd and renders global fallback values', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\repo\\sigma\\app');
    dbMock.getCurrentProject.mockReturnValue('sigma');
    dbMock.getEffectiveProjectConfig.mockReturnValue({
      max_concurrent: 0,
      max_daily_cost: 0,
      max_daily_tokens: 50000,
      default_timeout: 20,
      default_priority: 2,
      auto_approve: true,
      enabled: false,
      global_max_concurrent: 11,
    });
    dbMock.getProjectRunningCount.mockReturnValue(3);
    dbMock.getProjectDailyUsage.mockReturnValue({ cost: 2.75, tokens: 4200 });
    dbMock.canProjectStartTask.mockReturnValue({ allowed: false, reason: 'disabled' });

    const result = handlers.handleGetProjectConfig({});

    expect(dbMock.getCurrentProject).toHaveBeenCalledWith('C:\\repo\\sigma\\app');
    expect(textOf(result)).toContain('| Max Concurrent | Global (11) | 3 running |');
    expect(textOf(result)).toContain('| Max Daily Cost | Unlimited | $2.75 used |');
    expect(textOf(result)).toContain('| Max Daily Tokens | 50,000 | 4,200 used |');
    expect(textOf(result)).toContain('**Can Submit Tasks:** No - disabled');
  });

  it('handleGetProjectConfig returns a missing-param error when no project is resolved', () => {
    dbMock.getCurrentProject.mockReturnValue(null);

    const result = handlers.handleGetProjectConfig({});

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe(sharedMock.ErrorCodes.MISSING_REQUIRED_PARAM);
  });

  it('handleListProjectConfigs returns an empty state when no configs exist', () => {
    dbMock.listProjectConfigs.mockReturnValue([]);

    const result = handlers.handleListProjectConfigs({});

    expect(textOf(result)).toContain('No project configurations found');
  });

  it('handleListProjectConfigs renders configured project rows', () => {
    dbMock.listProjectConfigs.mockReturnValue([
      {
        project: 'alpha',
        max_concurrent: 0,
        max_daily_cost: 12.5,
        max_daily_tokens: 50000,
        enabled: true,
      },
      {
        project: 'beta',
        max_concurrent: 2,
        max_daily_cost: 0,
        max_daily_tokens: 0,
        enabled: false,
      },
    ]);

    const result = handlers.handleListProjectConfigs({});

    expect(textOf(result)).toContain('| alpha | Global | $12.50 | 50,000 | Yes |');
    expect(textOf(result)).toContain('| beta | 2 | - | - | No |');
  });
});

describe('automation project defaults handlers', () => {
  let sharedMock;
  let loggerMock;
  let dbMock;
  let handlers;

  beforeEach(() => {
    sharedMock = createSharedMock();
    loggerMock = createLoggerMock();
    dbMock = createAutomationDbMock({
      project: 'repo-root',
      initialConfig: {
        default_provider: 'codex',
        default_model: 'gpt-5.3-codex-spark',
        verify_command: 'npm run verify',
        auto_fix_enabled: 1,
        test_pattern: '.test.js',
        default_timeout: 30,
        max_concurrent: 0,
        build_verification_enabled: 0,
      },
    });
    handlers = loadAutomationHandlers({ dbMock, sharedMock, loggerMock });
  });

  it('handleSetProjectDefaults requires a working_directory', () => {
    const result = handlers.handleSetProjectDefaults({ provider: 'codex' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe(sharedMock.ErrorCodes.MISSING_REQUIRED_PARAM);
    expect(textOf(result)).toContain('working_directory is required');
  });

  it('handleSetProjectDefaults returns resource not found for invalid projects', () => {
    dbMock.getProjectFromPath.mockReturnValue(null);

    const result = handlers.handleSetProjectDefaults({ working_directory: 'C:\\outside\\repo' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe(sharedMock.ErrorCodes.RESOURCE_NOT_FOUND);
    expect(textOf(result)).toContain('Could not determine project from path');
  });

  it('handleSetProjectDefaults rejects invalid providers without writing config', () => {
    const result = handlers.handleSetProjectDefaults({
      working_directory: 'C:\\repo\\bad',
      provider: 'unknown-provider',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe(sharedMock.ErrorCodes.INVALID_PARAM);
    expect(dbMock.setProjectConfig).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('Invalid provider');
  });

  it('handleSetProjectDefaults writes verify_command and auto_fix enabled settings', () => {
    const result = handlers.handleSetProjectDefaults({
      working_directory: 'C:\\repo\\root\\packages\\service',
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
      verify_command: 'npx vitest run',
      auto_fix: true,
      test_pattern: '.spec.js',
    });

    expect(dbMock.getProjectFromPath).toHaveBeenCalledWith('C:\\repo\\root\\packages\\service');
    expect(dbMock.safeAddColumn).toHaveBeenCalledWith('project_config', 'verify_command TEXT');
    expect(dbMock.safeAddColumn).toHaveBeenCalledWith('project_config', 'auto_fix_enabled INTEGER DEFAULT 0');
    expect(dbMock.setProjectConfig).toHaveBeenCalledWith('repo-root', {
      default_provider: 'codex',
      default_model: 'gpt-5.3-codex-spark',
      verify_command: 'npx vitest run',
      auto_fix_enabled: 1,
      test_pattern: '.spec.js',
    });
    expect(textOf(result)).toContain('## Project Defaults: repo-root');
    expect(textOf(result)).toContain('Verify command: npx vitest run');
    expect(textOf(result)).toContain('Auto-fix: enabled');
    expect(textOf(result)).toContain('| Verify command | npx vitest run |');
    expect(textOf(result)).toContain('| Auto-fix | Yes |');
  });

  it('handleSetProjectDefaults writes disabled auto_fix and persists step providers metadata', () => {
    const result = handlers.handleSetProjectDefaults({
      working_directory: 'C:\\repo\\root',
      auto_fix: false,
      step_providers: { types: 'ollama', tests: 'codex' },
    });

    expect(dbMock.setProjectConfig).toHaveBeenCalledWith('repo-root', {
      auto_fix_enabled: 0,
    });
    expect(dbMock.setProjectMetadata).toHaveBeenCalledWith(
      'repo-root',
      'step_providers',
      JSON.stringify({ types: 'ollama', tests: 'codex' }),
    );
    expect(textOf(result)).toContain('Auto-fix: disabled');
    expect(textOf(result)).toContain('Step providers: {"types":"ollama","tests":"codex"}');
  });

  it('handleSetProjectDefaults returns current settings without writing when no changes are provided', () => {
    const result = handlers.handleSetProjectDefaults({
      working_directory: 'C:\\repo\\root',
    });

    expect(dbMock.setProjectConfig).not.toHaveBeenCalled();
    expect(dbMock.setProjectMetadata).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('### Current Settings');
    expect(textOf(result)).toContain('| Provider | codex |');
  });

  it('handleGetProjectDefaults requires a working_directory', () => {
    const result = handlers.handleGetProjectDefaults({});

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe(sharedMock.ErrorCodes.MISSING_REQUIRED_PARAM);
  });

  it('handleGetProjectDefaults returns resource not found for invalid projects', () => {
    dbMock.getProjectFromPath.mockReturnValue(null);

    const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\outside\\repo' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe(sharedMock.ErrorCodes.RESOURCE_NOT_FOUND);
  });

  it('handleGetProjectDefaults returns a no-config message when the project has no saved defaults', () => {
    dbMock.getProjectConfig.mockReturnValue(null);

    const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\repo\\root' });

    expect(textOf(result)).toContain('No project configuration found');
    expect(textOf(result)).toContain('set_project_defaults');
  });

  it('handleGetProjectDefaults loads verify_command, auto_fix, and step providers', () => {
    dbMock.getProjectMetadata.mockImplementation((project, key) => (
      key === 'step_providers' ? '{"types":"ollama","tests":"codex"}' : null
    ));

    const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\repo\\root' });

    expect(textOf(result)).toContain('| Provider | codex |');
    expect(textOf(result)).toContain('| Model | gpt-5.3-codex-spark |');
    expect(textOf(result)).toContain('| Verify command | npm run verify |');
    expect(textOf(result)).toContain('| Auto-fix | Yes |');
    expect(textOf(result)).toContain('| Step providers | types=ollama, tests=codex |');
  });

  it('handleGetProjectDefaults ignores invalid step provider metadata and logs the parse failure', () => {
    dbMock.getProjectMetadata.mockReturnValue('{not valid json');

    const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\repo\\root' });

    expect(loggerMock.debug).toHaveBeenCalled();
    expect(textOf(result)).toContain('### Current Settings');
    expect(textOf(result)).not.toContain('| Step providers |');
  });

  it('handleGetProjectDefaults renders smart routing defaults when no provider is configured', () => {
    dbMock.getProjectConfig.mockReturnValue({
      default_provider: null,
      default_model: null,
      verify_command: null,
      auto_fix_enabled: 0,
      test_pattern: null,
      default_timeout: null,
      max_concurrent: null,
      build_verification_enabled: 0,
    });

    const result = handlers.handleGetProjectDefaults({ working_directory: 'C:\\repo\\root' });

    expect(textOf(result)).toContain('| Provider | (smart routing) |');
    expect(textOf(result)).toContain('| Model | (auto) |');
    expect(textOf(result)).toContain('| Verify command | (none) |');
    expect(textOf(result)).toContain('| Auto-fix | No |');
    expect(textOf(result)).toContain('| Test pattern | .test.ts |');
  });
});
