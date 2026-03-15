'use strict';

const HANDLER_MODULE = '../handlers/task/core';
const MODULE_PATHS = [
  HANDLER_MODULE,
  '../database',
  '../config',
  '../task-manager',
  '../contracts/peek',
  '../handlers/shared',
  '../handlers/task/utils',
  '../utils/context-stuffing',
  '../utils/smart-scan',
  '../constants',
  '../logger',
  'uuid',
];

let configState;
let handlers;

function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
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

const mockDb = {
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  getAllConfig: vi.fn(),
};

const mockConfig = {
  init: vi.fn(),
  get: vi.fn(),
  getInt: vi.fn(),
  getBool: vi.fn(),
  isOptIn: vi.fn(),
  getFloat: vi.fn(),
  getJson: vi.fn(),
  getApiKey: vi.fn(),
  hasApiKey: vi.fn(),
  getPort: vi.fn(),
};

const mockTaskManager = {
  getRunningTaskCount: vi.fn(),
  processQueue: vi.fn(),
};

const mockPeek = {
  buildPeekArtifactReferencesFromTaskArtifacts: vi.fn(() => []),
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
  isPathTraversalSafe: vi.fn(() => true),
  checkProviderAvailability: vi.fn(() => null),
  requireTask: vi.fn(),
};

const mockTaskUtils = {
  formatTime: vi.fn(),
  calculateDuration: vi.fn(),
};

const mockContextStuffing = {
  CONTEXT_STUFFING_PROVIDERS: [],
};

const mockSmartScan = {
  resolveContextFiles: vi.fn(() => []),
};

const mockConstants = {
  PROVIDER_DEFAULT_TIMEOUTS: {},
};

const mockLogger = {
  child: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
mockLogger.child.mockImplementation(() => mockLogger);

const mockUuid = {
  v4: vi.fn(() => 'test-uuid'),
};

function resetMockDefaults() {
  configState = {
    max_concurrent: 2,
    default_timeout: 30,
    scheduling_mode: 'legacy',
  };

  for (const fn of Object.values(mockDb)) {
    fn.mockReset();
  }
  for (const fn of Object.values(mockConfig)) {
    fn.mockReset();
  }
  for (const fn of Object.values(mockTaskManager)) {
    fn.mockReset();
  }
  mockPeek.buildPeekArtifactReferencesFromTaskArtifacts.mockReset();
  mockShared.safeLimit.mockReset();
  mockShared.makeError.mockReset();
  mockShared.isPathTraversalSafe.mockReset();
  mockShared.checkProviderAvailability.mockReset();
  mockShared.requireTask.mockReset();
  mockTaskUtils.formatTime.mockReset();
  mockTaskUtils.calculateDuration.mockReset();
  mockSmartScan.resolveContextFiles.mockReset();
  mockLogger.child.mockReset();
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mockUuid.v4.mockReset();

  mockDb.getConfig.mockImplementation((key) => (
    Object.prototype.hasOwnProperty.call(configState, key) ? configState[key] : null
  ));
  mockDb.setConfig.mockImplementation((key, value) => {
    configState[key] = value;
  });
  mockDb.getAllConfig.mockImplementation(() => ({ ...configState }));

  mockConfig.get.mockImplementation((key, fallback) => {
    const value = mockDb.getConfig(key);
    return value !== null && value !== undefined ? value : fallback;
  });
  mockConfig.getInt.mockImplementation((key, fallback = 0) => {
    const value = mockDb.getConfig(key);
    if (value === null || value === undefined) {
      return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  });
  mockConfig.getBool.mockImplementation((key) => {
    const value = mockDb.getConfig(key);
    return value !== '0' && value !== 'false';
  });
  mockConfig.isOptIn.mockReturnValue(false);
  mockConfig.getFloat.mockReturnValue(null);
  mockConfig.getJson.mockReturnValue(null);
  mockConfig.getApiKey.mockReturnValue(null);
  mockConfig.hasApiKey.mockReturnValue(false);
  mockConfig.getPort.mockReturnValue(null);

  mockTaskManager.getRunningTaskCount.mockReturnValue(3);
  mockTaskManager.processQueue.mockReturnValue(undefined);

  mockPeek.buildPeekArtifactReferencesFromTaskArtifacts.mockReturnValue([]);
  mockShared.makeError.mockImplementation((errorCode, message) => ({
    isError: true,
    error_code: errorCode,
    content: [{ type: 'text', text: message }],
  }));
  mockShared.isPathTraversalSafe.mockReturnValue(true);
  mockShared.checkProviderAvailability.mockReturnValue(null);
  mockLogger.child.mockImplementation(() => mockLogger);
  mockUuid.v4.mockReturnValue('test-uuid');
}

function loadHandlers() {
  clearLoadedModules();
  installMock('../database', mockDb);
  installMock('../config', mockConfig);
  installMock('../task-manager', mockTaskManager);
  installMock('../contracts/peek', mockPeek);
  installMock('../handlers/shared', mockShared);
  installMock('../handlers/task/utils', mockTaskUtils);
  installMock('../utils/context-stuffing', mockContextStuffing);
  installMock('../utils/smart-scan', mockSmartScan);
  installMock('../constants', mockConstants);
  installMock('../logger', mockLogger);
  installMock('uuid', mockUuid);
  return require(HANDLER_MODULE);
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('handleConfigure scheduling_mode', () => {
  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    clearLoadedModules();
    vi.restoreAllMocks();
  });

  it('sets scheduling_mode to slot-pull and returns updated output', () => {
    const result = handlers.handleConfigure({ scheduling_mode: 'slot-pull' });
    const text = getText(result);

    expect(result.isError).toBeUndefined();
    expect(mockDb.setConfig).toHaveBeenCalledWith('scheduling_mode', 'slot-pull');
    expect(text).toContain('**Scheduling Mode:** slot-pull');
    expect(text).toContain('Configuration updated');
    expect(mockTaskManager.processQueue).toHaveBeenCalledTimes(1);
  });

  it('sets scheduling_mode to legacy and returns updated output', () => {
    configState.scheduling_mode = 'slot-pull';

    const result = handlers.handleConfigure({ scheduling_mode: 'legacy' });
    const text = getText(result);

    expect(result.isError).toBeUndefined();
    expect(mockDb.setConfig).toHaveBeenCalledWith('scheduling_mode', 'legacy');
    expect(text).toContain('**Scheduling Mode:** legacy');
    expect(text).toContain('Configuration updated');
    expect(mockTaskManager.processQueue).toHaveBeenCalledTimes(1);
  });

  it('returns INVALID_PARAM for unsupported scheduling_mode values', () => {
    const result = handlers.handleConfigure({ scheduling_mode: 'invalid' });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(getText(result)).toContain('scheduling_mode must be "legacy" or "slot-pull"');
    expect(mockDb.setConfig).not.toHaveBeenCalled();
    expect(mockTaskManager.processQueue).not.toHaveBeenCalled();
  });

  it('does not call setConfig for scheduling_mode when it is not provided', () => {
    const result = handlers.handleConfigure({ max_concurrent: 4 });
    const text = getText(result);

    expect(result.isError).toBeUndefined();
    expect(mockDb.setConfig).toHaveBeenCalledTimes(1);
    expect(mockDb.setConfig).toHaveBeenCalledWith('max_concurrent', 4);
    expect(mockDb.setConfig).not.toHaveBeenCalledWith('scheduling_mode', expect.anything());
    expect(text).toContain('**Scheduling Mode:** legacy');
  });

  it('includes a Scheduling Mode line in the configuration output', () => {
    configState.scheduling_mode = 'slot-pull';

    const result = handlers.handleConfigure({});
    const text = getText(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain('**Scheduling Mode:** slot-pull');
    expect(mockDb.setConfig).not.toHaveBeenCalled();
    expect(mockTaskManager.processQueue).not.toHaveBeenCalled();
  });

  it('can set scheduling_mode alongside max_concurrent in the same call', () => {
    const result = handlers.handleConfigure({
      max_concurrent: 6,
      scheduling_mode: 'slot-pull',
    });
    const text = getText(result);

    expect(result.isError).toBeUndefined();
    expect(mockDb.setConfig).toHaveBeenNthCalledWith(1, 'max_concurrent', 6);
    expect(mockDb.setConfig).toHaveBeenNthCalledWith(2, 'scheduling_mode', 'slot-pull');
    expect(text).toContain('**Max Concurrent Tasks:** 6');
    expect(text).toContain('**Scheduling Mode:** slot-pull');
    expect(text).toContain('Configuration updated');
    expect(mockTaskManager.processQueue).toHaveBeenCalledTimes(1);
  });
});
