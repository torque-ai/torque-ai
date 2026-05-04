'use strict';

const mockTaskCore = {};
const mockEventTracking = {};
const mockFileTracking = {};
const mockHostManagement = {};
const mockProviderRoutingCore = {
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  getProvider: vi.fn(),
  listProviders: vi.fn(),
  getDefaultProvider: vi.fn(),
  setDefaultProvider: vi.fn(),
  getProviderStats: vi.fn(),
};

const mockTaskManager = {
  processQueue: vi.fn(),
};

const mockDashboardServer = {
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(() => ({ running: false })),
};

const mockProviderRegistry = {
  isApiProvider: vi.fn(() => false),
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

vi.mock('../db/task-core', () => mockTaskCore);
vi.mock('../db/event-tracking', () => mockEventTracking);
vi.mock('../db/file-tracking', () => mockFileTracking);
vi.mock('../db/host-management', () => mockHostManagement);
vi.mock('../db/provider/routing-core', () => mockProviderRoutingCore);
vi.mock('../task-manager', () => mockTaskManager);
vi.mock('../dashboard/server', () => mockDashboardServer);
vi.mock('../providers/registry', () => mockProviderRegistry);
vi.mock('../handlers/provider-ollama-hosts', () => ({}));
vi.mock('../handlers/provider-tuning', () => ({}));

let providerHandlers;

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function getSwitchHandler() {
  return providerHandlers.handleSwitchProvider || providerHandlers.handleSetDefaultProvider;
}

function getDashboardHandler() {
  return providerHandlers.handleGetProviderDashboard || providerHandlers.handleListProviders;
}

function getStatsHandler() {
  return providerHandlers.handleGetProviderStats || providerHandlers.handleProviderStats;
}

function loadProviderHandlers() {
  const providerHandlersPath = require.resolve('../handlers/provider-handlers');

  vi.resetModules();
  vi.doMock('../db/task-core', () => mockTaskCore);
  vi.doMock('../db/event-tracking', () => mockEventTracking);
  vi.doMock('../db/file-tracking', () => mockFileTracking);
  vi.doMock('../db/host-management', () => mockHostManagement);
  vi.doMock('../db/provider/routing-core', () => mockProviderRoutingCore);
  vi.doMock('../task-manager', () => mockTaskManager);
  vi.doMock('../dashboard/server', () => mockDashboardServer);
  vi.doMock('../providers/registry', () => mockProviderRegistry);
  vi.doMock('../handlers/provider-ollama-hosts', () => ({}));
  vi.doMock('../handlers/provider-tuning', () => ({}));
  installCjsModuleMock('../db/task-core', mockTaskCore);
  installCjsModuleMock('../db/event-tracking', mockEventTracking);
  installCjsModuleMock('../db/file-tracking', mockFileTracking);
  installCjsModuleMock('../db/host-management', mockHostManagement);
  installCjsModuleMock('../db/provider/routing-core', mockProviderRoutingCore);
  installCjsModuleMock('../task-manager', mockTaskManager);
  installCjsModuleMock('../dashboard/server', mockDashboardServer);
  installCjsModuleMock('../providers/registry', mockProviderRegistry);
  installCjsModuleMock('../handlers/provider-ollama-hosts', {});
  installCjsModuleMock('../handlers/provider-tuning', {});
  delete require.cache[providerHandlersPath];
  providerHandlers = require('../handlers/provider-handlers');
}

describe('provider-handlers direct exports', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockProviderRoutingCore.listProviders.mockReturnValue([
      { provider: 'ollama', enabled: 1, priority: 1, cli_path: null, max_concurrent: 4 },
      { provider: 'codex', enabled: 1, priority: 2, cli_path: 'codex', max_concurrent: 2 },
    ]);
    mockProviderRoutingCore.getDefaultProvider.mockReturnValue('codex');
    mockProviderRoutingCore.getConfig.mockImplementation((key) => (key === 'default_provider' ? 'codex' : null));
    mockProviderRoutingCore.getProvider.mockImplementation((provider) => {
      if (provider === 'ollama') {
        return {
          provider: 'ollama',
          enabled: 1,
          priority: 1,
          max_concurrent: 4,
        };
      }

      if (provider === 'codex') {
        return {
          provider: 'codex',
          enabled: 1,
          priority: 2,
          max_concurrent: 2,
        };
      }

      return null;
    });
    mockProviderRoutingCore.getProviderStats.mockReturnValue({
      total_tasks: 12,
      successful_tasks: 10,
      failed_tasks: 2,
      success_rate: 83.3,
      total_tokens: 1234,
      total_cost: 1.2345,
      avg_duration_seconds: 42,
    });
    mockProviderRegistry.isApiProvider.mockReturnValue(false);

    loadProviderHandlers();
  });

  describe('handleSwitchProvider / handleSetDefaultProvider', () => {
    it('returns an error when provider is missing', () => {
      const result = getSwitchHandler()({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('provider is required');
    });

    it('returns an error when provider is invalid', () => {
      const result = getSwitchHandler()({ provider: '   ' });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('provider');
    });

    it('updates the default provider and returns a success message', () => {
      const result = getSwitchHandler()({ provider: 'ollama' });
      const text = getText(result);
      const totalConfigWrites = mockProviderRoutingCore.setConfig.mock.calls.length
        + mockProviderRoutingCore.setDefaultProvider.mock.calls.length;

      expect(result.isError).not.toBe(true);
      expect(totalConfigWrites).toBe(1);

      if (mockProviderRoutingCore.setConfig.mock.calls.length > 0) {
        expect(mockProviderRoutingCore.setConfig).toHaveBeenCalledWith('default_provider', 'ollama');
      }

      if (mockProviderRoutingCore.setDefaultProvider.mock.calls.length > 0) {
        expect(mockProviderRoutingCore.setDefaultProvider).toHaveBeenCalledWith('ollama');
      }

      expect(text).toContain('ollama');
      expect(text).toMatch(/default provider updated|provider/i);
    });
  });

  describe('handleGetProviderDashboard / handleListProviders', () => {
    it('works with an empty db', () => {
      mockProviderRoutingCore.listProviders.mockReturnValue([]);
      mockProviderRoutingCore.getDefaultProvider.mockReturnValue(null);
      mockProviderRoutingCore.getConfig.mockReturnValue(null);

      const result = getDashboardHandler()({});
      const text = getText(result);

      expect(result.isError).not.toBe(true);
      expect(text.length).toBeGreaterThan(0);

      if (typeof providerHandlers.handleGetProviderDashboard === 'function') {
        expect(text).toMatch(/provider|dashboard|stats|health|config/i);
      } else {
        expect(text).toContain('No providers configured');
      }
    });

    it('returns provider dashboard information when providers exist', () => {
      const result = getDashboardHandler()({});
      const text = getText(result);

      expect(result.isError).not.toBe(true);

      if (typeof providerHandlers.handleGetProviderDashboard === 'function') {
        expect(text).toMatch(/stats/i);
        expect(text).toMatch(/health/i);
        expect(text).toMatch(/config/i);
      } else {
        expect(text).toContain('Configured Providers');
        expect(text).toContain('Default Provider');
        expect(text).toContain('ollama');
        expect(text).toContain('codex');
      }
    });
  });

  describe('handleGetProviderStats / handleProviderStats', () => {
    it('returns an error when provider is missing', () => {
      const result = getStatsHandler()({});

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('provider is required');
    });

    it('returns stats for the requested provider', () => {
      const result = getStatsHandler()({ provider: 'ollama' });
      const text = getText(result);

      expect(result.isError).not.toBe(true);
      expect(mockProviderRoutingCore.getProviderStats).toHaveBeenCalled();
      expect(mockProviderRoutingCore.getProviderStats.mock.calls[0][0]).toBe('ollama');
      expect(text).toContain('ollama');
      expect(text).toMatch(/statistics|stats/i);
    });
  });
});
