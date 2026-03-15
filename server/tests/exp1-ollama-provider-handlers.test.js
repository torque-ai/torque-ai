'use strict';

const mockDb = {
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

vi.mock('../database', () => mockDb);
vi.mock('../task-manager', () => mockTaskManager);
vi.mock('../dashboard-server', () => mockDashboardServer);
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
  const databasePath = require.resolve('../database');
  const taskManagerPath = require.resolve('../task-manager');
  const dashboardServerPath = require.resolve('../dashboard-server');
  const ollamaHostsPath = require.resolve('../handlers/provider-ollama-hosts');
  const tuningPath = require.resolve('../handlers/provider-tuning');
  const providerHandlersPath = require.resolve('../handlers/provider-handlers');

  vi.resetModules();
  vi.doMock('../database', () => mockDb);
  vi.doMock('../task-manager', () => mockTaskManager);
  vi.doMock('../dashboard-server', () => mockDashboardServer);
  vi.doMock('../handlers/provider-ollama-hosts', () => ({}));
  vi.doMock('../handlers/provider-tuning', () => ({}));
  require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: mockDb };
  require.cache[taskManagerPath] = { id: taskManagerPath, filename: taskManagerPath, loaded: true, exports: mockTaskManager };
  require.cache[dashboardServerPath] = { id: dashboardServerPath, filename: dashboardServerPath, loaded: true, exports: mockDashboardServer };
  require.cache[ollamaHostsPath] = { id: ollamaHostsPath, filename: ollamaHostsPath, loaded: true, exports: {} };
  require.cache[tuningPath] = { id: tuningPath, filename: tuningPath, loaded: true, exports: {} };
  delete require.cache[providerHandlersPath];
  providerHandlers = require('../handlers/provider-handlers');
}

describe('provider-handlers direct exports', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockDb.listProviders.mockReturnValue([
      { provider: 'ollama', enabled: 1, priority: 1, cli_path: null, max_concurrent: 4 },
      { provider: 'codex', enabled: 1, priority: 2, cli_path: 'codex', max_concurrent: 2 },
    ]);
    mockDb.getDefaultProvider.mockReturnValue('codex');
    mockDb.getConfig.mockImplementation((key) => (key === 'default_provider' ? 'codex' : null));
    mockDb.getProvider.mockImplementation((provider) => {
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
    mockDb.getProviderStats.mockReturnValue({
      total_tasks: 12,
      successful_tasks: 10,
      failed_tasks: 2,
      success_rate: 83.3,
      total_tokens: 1234,
      total_cost: 1.2345,
      avg_duration_seconds: 42,
    });

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
      const totalConfigWrites = mockDb.setConfig.mock.calls.length + mockDb.setDefaultProvider.mock.calls.length;

      expect(result.isError).not.toBe(true);
      expect(totalConfigWrites).toBe(1);

      if (mockDb.setConfig.mock.calls.length > 0) {
        expect(mockDb.setConfig).toHaveBeenCalledWith('default_provider', 'ollama');
      }

      if (mockDb.setDefaultProvider.mock.calls.length > 0) {
        expect(mockDb.setDefaultProvider).toHaveBeenCalledWith('ollama');
      }

      expect(text).toContain('ollama');
      expect(text).toMatch(/default provider updated|provider/i);
    });
  });

  describe('handleGetProviderDashboard / handleListProviders', () => {
    it('works with an empty db', () => {
      mockDb.listProviders.mockReturnValue([]);
      mockDb.getDefaultProvider.mockReturnValue(null);
      mockDb.getConfig.mockReturnValue(null);

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
      expect(mockDb.getProviderStats).toHaveBeenCalled();
      expect(mockDb.getProviderStats.mock.calls[0][0]).toBe('ollama');
      expect(text).toContain('ollama');
      expect(text).toMatch(/statistics|stats/i);
    });
  });
});
