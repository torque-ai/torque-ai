'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let currentIndexModules = null;

vi.mock('../logger', () => currentIndexModules.logger);
vi.mock('../database', () => currentIndexModules.db);
vi.mock('../container', () => currentIndexModules.container);
vi.mock('../config', () => currentIndexModules.config);
vi.mock('../task-manager', () => currentIndexModules.taskManager);
vi.mock('../dashboard-server', () => currentIndexModules.dashboardServer);
vi.mock('../api-server', () => currentIndexModules.apiServer);
vi.mock('../mcp', () => currentIndexModules.mcpGateway);
vi.mock('../mcp-sse', () => currentIndexModules.mcpSse);
vi.mock('../tools', () => currentIndexModules.tools);
vi.mock('../mcp-protocol', () => currentIndexModules.mcpProtocol);
vi.mock('../plugins/loader', () => currentIndexModules.pluginsLoader);
vi.mock('../scripts/gpu-metrics-server', () => currentIndexModules.gpuMetricsServer);
vi.mock('../execution/slot-pull-scheduler', () => currentIndexModules.slotPullScheduler);
vi.mock('../discovery/config-migrator', () => currentIndexModules.configMigrator);
vi.mock('../discovery', () => currentIndexModules.discovery);
vi.mock('../providers/adapter-registry', () => currentIndexModules.adapterRegistry);
vi.mock('../validation/auto-verify-retry', () => currentIndexModules.autoVerifyRetry);
vi.mock('../validation/post-task', () => currentIndexModules.postTask);
vi.mock('../validation/build-verification', () => currentIndexModules.buildVerification);
vi.mock('../remote/agent-registry', () => currentIndexModules.remoteAgentRegistry);

function createIndexMocks(tempDir) {
  const mockLoggerChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockDb = {
    getDataDir: vi.fn(() => tempDir),
    init: vi.fn(),
    close: vi.fn(),
    getDbInstance: vi.fn(() => ({})),
    listTasks: vi.fn(() => []),
    updateTaskStatus: vi.fn(),
    decrementHostTasks: vi.fn(),
    getConfig: vi.fn(() => null),
  };

  const mockTaskManager = {
    registerInstance: vi.fn(),
    startInstanceHeartbeat: vi.fn(),
    processQueue: vi.fn(),
    updateInstanceInfo: vi.fn(),
    getMcpInstanceId: vi.fn(() => 'test-instance'),
    hasRunningProcess: vi.fn(() => false),
    isInstanceAlive: vi.fn(() => false),
    getRunningTaskCount: vi.fn(() => 0),
    shutdown: vi.fn(),
    unregisterInstance: vi.fn(),
  };

  const resolvedStart = vi.fn(async () => ({ success: false }));

  currentIndexModules = {
    logger: {
      child: vi.fn(() => mockLoggerChild),
    },
    db: mockDb,
    container: {
      defaultContainer: {
        has: vi.fn(() => false),
        registerValue: vi.fn(),
        boot: vi.fn(),
        get: vi.fn(() => null),
      },
    },
    config: {
      init: vi.fn(),
      get: vi.fn((key, fallback = null) => {
        const value = mockDb.getConfig(key);
        return value == null ? fallback : value;
      }),
      getInt: vi.fn((key, fallback = 0) => {
        const value = mockDb.getConfig(key);
        if (value == null) return fallback;
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
      }),
      setEpoch: vi.fn(),
    },
    taskManager: mockTaskManager,
    dashboardServer: {
      start: resolvedStart,
      stop: vi.fn(),
    },
    apiServer: {
      start: resolvedStart,
      stop: vi.fn(),
    },
    mcpGateway: {
      start: resolvedStart,
      stop: vi.fn(),
    },
    mcpSse: {
      start: resolvedStart,
      stop: vi.fn(),
    },
    tools: {
      TOOLS: [],
      handleToolCall: vi.fn(),
    },
    mcpProtocol: {
      init: vi.fn(),
      handleRequest: vi.fn(),
    },
    pluginsLoader: {
      loadPlugins: vi.fn(() => []),
    },
    gpuMetricsServer: {
      start: resolvedStart,
      stop: vi.fn(),
    },
    slotPullScheduler: {
      init: vi.fn(),
      startHeartbeat: vi.fn(),
      stopHeartbeat: vi.fn(),
    },
    configMigrator: {
      migrateConfigToRegistry: vi.fn(),
    },
    discovery: {
      initDiscovery: vi.fn(),
      initAutoScanFromConfig: vi.fn(),
      stopAutoScan: vi.fn(),
      shutdownDiscovery: vi.fn(),
    },
    adapterRegistry: {
      discoverAllModels: vi.fn(async () => ({})),
    },
    autoVerifyRetry: {
      init: vi.fn(),
    },
    postTask: {
      init: vi.fn(),
    },
    buildVerification: {
      init: vi.fn(),
    },
    remoteAgentRegistry: {
      RemoteAgentRegistry: vi.fn(() => ({})),
    },
  };

  vi.doMock('../logger', () => currentIndexModules.logger);
  vi.doMock('../database', () => currentIndexModules.db);
  vi.doMock('../container', () => currentIndexModules.container);
  vi.doMock('../config', () => currentIndexModules.config);
  vi.doMock('../task-manager', () => currentIndexModules.taskManager);
  vi.doMock('../dashboard-server', () => currentIndexModules.dashboardServer);
  vi.doMock('../api-server', () => currentIndexModules.apiServer);
  vi.doMock('../mcp', () => currentIndexModules.mcpGateway);
  vi.doMock('../mcp-sse', () => currentIndexModules.mcpSse);
  vi.doMock('../tools', () => currentIndexModules.tools);
  vi.doMock('../mcp-protocol', () => currentIndexModules.mcpProtocol);
  vi.doMock('../plugins/loader', () => currentIndexModules.pluginsLoader);
  vi.doMock('../scripts/gpu-metrics-server', () => currentIndexModules.gpuMetricsServer);
  vi.doMock('../execution/slot-pull-scheduler', () => currentIndexModules.slotPullScheduler);
  vi.doMock('../discovery/config-migrator', () => currentIndexModules.configMigrator);
  vi.doMock('../discovery', () => currentIndexModules.discovery);
  vi.doMock('../providers/adapter-registry', () => currentIndexModules.adapterRegistry);
  vi.doMock('../validation/auto-verify-retry', () => currentIndexModules.autoVerifyRetry);
  vi.doMock('../validation/post-task', () => currentIndexModules.postTask);
  vi.doMock('../validation/build-verification', () => currentIndexModules.buildVerification);
  vi.doMock('../remote/agent-registry', () => currentIndexModules.remoteAgentRegistry);

  return {
    mockDb,
    mockTaskManager,
  };
}

function loadIndex(tempDir) {
  vi.resetModules();
  const mocks = createIndexMocks(tempDir);
  vi.spyOn(process, 'on').mockImplementation(() => process);
  vi.spyOn(process, 'exit').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const dashboardServer = require('../dashboard-server');
  const apiServer = require('../api-server');
  const mcpGateway = require('../mcp');
  const mcpSse = require('../mcp-sse');
  const gpuMetricsServer = require('../scripts/gpu-metrics-server');
  vi.spyOn(dashboardServer, 'start').mockResolvedValue({ success: false });
  vi.spyOn(dashboardServer, 'stop').mockImplementation(() => {});
  // At least one critical transport must succeed to avoid checkCriticalPorts exit
  vi.spyOn(apiServer, 'start').mockResolvedValue({ success: true, port: 3457 });
  vi.spyOn(apiServer, 'stop').mockImplementation(() => {});
  vi.spyOn(mcpGateway, 'start').mockResolvedValue({ success: false });
  vi.spyOn(mcpGateway, 'stop').mockImplementation(() => {});
  vi.spyOn(mcpSse, 'start').mockResolvedValue({ success: false });
  vi.spyOn(mcpSse, 'stop').mockImplementation(() => {});
  vi.spyOn(gpuMetricsServer, 'start').mockResolvedValue({ success: false });
  vi.spyOn(gpuMetricsServer, 'stop').mockImplementation(() => {});
  return {
    index: require('../index'),
    mocks,
  };
}

describe('MCPPlatform', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.TORQUE_MCP_PLATFORM_ENABLED;
  });

  it('defaults to disabled and keeps lifecycle methods as no-ops', () => {
    const { MCPPlatform, isPlatformEnabled } = require('../mcp/platform');
    const platform = new MCPPlatform({ env: {} });

    expect(isPlatformEnabled({})).toBe(false);
    expect(platform.init()).toBe(false);
    expect(platform.start()).toBe(false);
    expect(platform.isReady()).toBe(false);
    expect(platform.stop()).toBe(false);
  });

  it('treats supported feature-flag values as enabled and rejects other values', () => {
    const { isPlatformEnabled } = require('../mcp/platform');

    expect(isPlatformEnabled({ TORQUE_MCP_PLATFORM_ENABLED: '1' })).toBe(true);
    expect(isPlatformEnabled({ TORQUE_MCP_PLATFORM_ENABLED: 'true' })).toBe(true);
    expect(isPlatformEnabled({ TORQUE_MCP_PLATFORM_ENABLED: ' YES ' })).toBe(true);
    expect(isPlatformEnabled({ TORQUE_MCP_PLATFORM_ENABLED: 'On' })).toBe(true);

    expect(isPlatformEnabled({ TORQUE_MCP_PLATFORM_ENABLED: '0' })).toBe(false);
    expect(isPlatformEnabled({ TORQUE_MCP_PLATFORM_ENABLED: 'false' })).toBe(false);
    expect(isPlatformEnabled({ TORQUE_MCP_PLATFORM_ENABLED: 'disabled' })).toBe(false);
  });

  it('wraps request and response envelopes with correlation IDs and duration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-06T16:00:00.000Z'));

    const { MCPPlatform } = require('../mcp/platform');
    const platform = new MCPPlatform({
      env: { TORQUE_MCP_PLATFORM_ENABLED: 'true' },
    });

    expect(platform.start()).toBe(true);
    expect(platform.isReady()).toBe(true);

    const request = platform.wrapRequest('torque.task.submit', { task: 'ship sprint 0' });
    expect(request.id).toMatch(UUID_PATTERN);
    expect(request).toMatchObject({
      tool: 'torque.task.submit',
      params: { task: 'ship sprint 0' },
      timestamp: '2026-03-06T16:00:00.000Z',
    });

    vi.advanceTimersByTime(25);

    const response = platform.wrapResponse(request.id, { ok: true });
    expect(response).toEqual({
      id: request.id,
      result: { ok: true },
      duration_ms: 25,
      timestamp: '2026-03-06T16:00:00.025Z',
    });

    expect(platform.stop()).toBe(true);
    expect(platform.isReady()).toBe(false);
  });
});

describe('ToolRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('registers namespaced tools and lists them by namespace', () => {
    const { ToolRegistry } = require('../mcp/tool-registry');
    const registry = new ToolRegistry();
    const handler = vi.fn();

    const taskName = registry.registerTool('task', 'submit', {
      type: 'object',
      properties: {
        task: { type: 'string' },
      },
      required: ['task'],
      additionalProperties: false,
    }, handler);

    registry.registerTool('workflow', 'create', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }, handler);

    expect(taskName).toBe('torque.task.submit');
    expect(registry.getTool(taskName)).toMatchObject({
      schema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
        },
        required: ['task'],
        additionalProperties: false,
      },
      handler,
    });
    expect(registry.listTools().map((tool) => tool.name)).toEqual([
      'torque.task.submit',
      'torque.workflow.create',
    ]);
    expect(registry.listTools('task').map((tool) => tool.name)).toEqual([
      'torque.task.submit',
    ]);
  });

  it('validates params against the registered schema', () => {
    const { ToolRegistry } = require('../mcp/tool-registry');
    const registry = new ToolRegistry();

    registry.registerTool('provider', 'setWeight', {
      type: 'object',
      properties: {
        provider: { type: 'string', minLength: 1 },
        weight: { type: 'integer', minimum: 1 },
        metadata: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['manual', 'auto'] },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
      required: ['provider', 'weight'],
      additionalProperties: false,
    }, vi.fn());

    expect(registry.validateParams('torque.provider.setWeight', {
      provider: 'codex',
      weight: 2,
      metadata: { source: 'manual' },
    })).toEqual({
      valid: true,
      errors: [],
    });

    expect(registry.validateParams('torque.provider.setWeight', {
      provider: '',
      weight: 0,
      metadata: { source: 'invalid', extra: true },
      extra: 'forbidden',
    })).toEqual({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          path: '$.provider',
          message: 'Expected minimum length 1',
        }),
        expect.objectContaining({
          path: '$.weight',
          message: 'Expected minimum value 1',
        }),
        expect.objectContaining({
          path: '$.metadata.source',
          message: 'Value must be one of: manual, auto',
        }),
        expect.objectContaining({
          path: '$.metadata.extra',
          message: 'Unknown property is not allowed',
        }),
        expect.objectContaining({
          path: '$.extra',
          message: 'Unknown property is not allowed',
        }),
      ]),
    });
  });

  it('rejects unsupported namespaces and unknown tools', () => {
    const { ToolRegistry } = require('../mcp/tool-registry');
    const registry = new ToolRegistry();

    expect(() => registry.registerTool('alerts', 'create', { type: 'object' }, vi.fn()))
      .toThrow('Unsupported tool namespace: alerts');
    expect(registry.validateParams('torque.system.health', {})).toEqual({
      valid: false,
      errors: [{ path: '$', message: 'Tool not registered: torque.system.health' }],
    });
  });
});

describe('MCP telemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('records call metrics and supports reset for tests', () => {
    const { MCPPlatformTelemetry } = require('../mcp/telemetry');
    const telemetry = new MCPPlatformTelemetry();

    telemetry.recordCall('torque.task.submit', 12, true);
    telemetry.recordCall('torque.task.submit', 1200, false);

    expect(telemetry.getMetrics()).toMatchObject({
      calls_total: 2,
      errors_total: 1,
      duration_histogram: expect.objectContaining({
        count: 2,
        buckets: expect.objectContaining({
          lt_50ms: 1,
          gte_1000ms: 1,
        }),
      }),
      error_codes: {
        TOOL_CALL_FAILED: 1,
      },
      tools: {
        'torque.task.submit': expect.objectContaining({
          calls_total: 2,
          errors_total: 1,
        }),
      },
    });

    telemetry.resetMetrics();

    expect(telemetry.getMetrics()).toMatchObject({
      calls_total: 0,
      errors_total: 0,
      duration_histogram: expect.objectContaining({
        count: 0,
      }),
      tools: {},
      error_codes: {},
    });
  });

  it('keeps the existing singleton snapshot helpers working', () => {
    const telemetry = require('../mcp/telemetry');
    telemetry.reset();
    telemetry.incrementToolCall('torque.task.get');
    telemetry.observeLatency('torque.task.get', 20);
    telemetry.incrementError('VALIDATION_FAILED');

    expect(telemetry.snapshot()).toMatchObject({
      counters: {
        tool_calls: {
          'torque.task.get': 1,
        },
        errors: {
          VALIDATION_FAILED: 1,
        },
      },
      latency: {
        'torque.task.get': {
          p50: 20,
          p95: 20,
          count: 1,
        },
      },
    });
  });
});

describe('server index MCP platform startup hook', () => {
  let tempDir;
  let index;

  afterEach(() => {
    try { index?._testing?.resetForTest(); } catch { /* ignore */ }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    currentIndexModules = null;
    delete process.env.TORQUE_MCP_PLATFORM_ENABLED;
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tempDir = null;
    }
    index = null;
  });

  it('initializes MCPPlatform during startup when the feature flag is enabled', () => {
    vi.useFakeTimers();
    process.env.TORQUE_MCP_PLATFORM_ENABLED = '1';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-mcp-platform-enabled-'));

    ({ index } = loadIndex(tempDir));
    index.init();

    const platform = index._testing.getMcpPlatform();
    expect(platform).toBeTruthy();
    expect(platform.isReady()).toBe(true);
  });

  it('skips MCPPlatform initialization when the feature flag is disabled', () => {
    vi.useFakeTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-mcp-platform-disabled-'));

    ({ index } = loadIndex(tempDir));
    index.init();

    expect(index._testing.getMcpPlatform()).toBeNull();
  });
});
