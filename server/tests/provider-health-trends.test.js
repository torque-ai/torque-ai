'use strict';

const mockDb = {
  getHealthTrend: vi.fn(),
  getHealthHistory: vi.fn(),
  listProviders: vi.fn(),
};

const mockTaskManager = {
  processQueue: vi.fn(),
};

const mockDashboard = {
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(),
};

const providerFixtures = {
  codex: {
    trend: 'stable',
    previous_failure_rate: 0.2,
    recent_failure_rate: 0.2,
  },
  ollama: {
    trend: 'degrading',
    previous_failure_rate: 0.15,
    recent_failure_rate: 0.35,
  },
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

function loadProviderHandlers() {
  delete require.cache[require.resolve('../handlers/provider-handlers')];
  installCjsModuleMock('../db/task-core', {});
  installCjsModuleMock('../db/event-tracking', {});
  installCjsModuleMock('../db/file-tracking', {});
  installCjsModuleMock('../db/host-management', {});
  installCjsModuleMock('../db/provider-routing-core', {
    getHealthTrend: mockDb.getHealthTrend,
    listProviders: mockDb.listProviders,
  });
  installCjsModuleMock('../task-manager', mockTaskManager);
  installCjsModuleMock('../dashboard-server', mockDashboard);
  installCjsModuleMock('../handlers/provider-ollama-hosts', {});
  installCjsModuleMock('../handlers/provider-tuning', {});
  return require('../handlers/provider-handlers');
}

function makeHistory(provider, count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    provider,
    window_start: `2026-03-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    failure_rate: 0.1 + (index * 0.05),
  }));
}

function resetMocks() {
  mockDb.listProviders.mockReset();
  mockDb.listProviders.mockReturnValue([
    { provider: 'codex' },
    { provider: 'ollama' },
    { provider: 'ollama' },
  ]);

  mockDb.getHealthHistory.mockReset();
  mockDb.getHealthHistory.mockImplementation((provider) => makeHistory(provider));

  mockDb.getHealthTrend.mockReset();
  mockDb.getHealthTrend.mockImplementation((provider, days = 30) => {
    const history = mockDb.getHealthHistory(provider, days);

    if (history.length === 0) {
      return {
        provider,
        days,
        trend: 'insufficient_data',
        window_count: 0,
        previous_failure_rate: null,
        recent_failure_rate: null,
      };
    }

    const fixture = providerFixtures[provider] || providerFixtures.codex;
    return {
      provider,
      days,
      trend: fixture.trend,
      window_count: history.length,
      previous_failure_rate: fixture.previous_failure_rate,
      recent_failure_rate: fixture.recent_failure_rate,
    };
  });

  mockTaskManager.processQueue.mockReset();
  mockDashboard.start.mockReset();
  mockDashboard.stop.mockReset();
  mockDashboard.getStatus.mockReset();
}

function expectMcpTextResponse(result) {
  expect(result).toBeTruthy();
  expect(Array.isArray(result.content)).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  expect(typeof result.content[0].text).toBe('string');
}

describe('handleGetProviderHealthTrends', () => {
  let handleGetProviderHealthTrends;

  beforeEach(() => {
    resetMocks();
    ({ handleGetProviderHealthTrends } = loadProviderHandlers());
  });

  it('returns trend for a specific provider when provider arg is given', () => {
    const result = handleGetProviderHealthTrends({ provider: 'ollama', days: 7 });

    expectMcpTextResponse(result);
    expect(mockDb.listProviders).not.toHaveBeenCalled();
    expect(mockDb.getHealthTrend).toHaveBeenCalledWith('ollama', 7);
    expect(mockDb.getHealthHistory).toHaveBeenCalledWith('ollama', 7);
    expect(JSON.parse(result.content[0].text)).toEqual([{
      provider: 'ollama',
      days: 7,
      trend: 'degrading',
      window_count: 4,
      previous_failure_rate: 0.15,
      recent_failure_rate: 0.35,
    }]);
  });

  it('returns trends for all providers when no provider arg is given', () => {
    const result = handleGetProviderHealthTrends({});

    expectMcpTextResponse(result);
    expect(mockDb.listProviders).toHaveBeenCalledTimes(1);
    expect(mockDb.getHealthTrend).toHaveBeenCalledTimes(3);
    expect(mockDb.getHealthTrend).toHaveBeenNthCalledWith(1, 'codex', undefined);
    expect(mockDb.getHealthTrend).toHaveBeenNthCalledWith(2, 'ollama', undefined);
    expect(mockDb.getHealthTrend).toHaveBeenNthCalledWith(3, 'ollama', undefined);
    expect(JSON.parse(result.content[0].text)).toEqual([
      {
        provider: 'codex',
        days: 30,
        trend: 'stable',
        window_count: 4,
        previous_failure_rate: 0.2,
        recent_failure_rate: 0.2,
      },
      {
        provider: 'ollama',
        days: 30,
        trend: 'degrading',
        window_count: 4,
        previous_failure_rate: 0.15,
        recent_failure_rate: 0.35,
      },
      {
        provider: 'ollama',
        days: 30,
        trend: 'degrading',
        window_count: 4,
        previous_failure_rate: 0.15,
        recent_failure_rate: 0.35,
      },
    ]);
  });

  it('handles empty history with an insufficient_data trend gracefully', () => {
    mockDb.getHealthHistory.mockImplementation((provider) => (
      provider === 'ollama' ? [] : makeHistory(provider)
    ));

    const result = handleGetProviderHealthTrends({ provider: 'ollama', days: 14 });

    expectMcpTextResponse(result);
    expect(JSON.parse(result.content[0].text)).toEqual([{
      provider: 'ollama',
      days: 14,
      trend: 'insufficient_data',
      window_count: 0,
      previous_failure_rate: null,
      recent_failure_rate: null,
    }]);
  });

  it('uses default days=30 when days is not specified', () => {
    const result = handleGetProviderHealthTrends({ provider: 'codex' });
    const parsed = JSON.parse(result.content[0].text);

    expectMcpTextResponse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].days).toBe(30);
    expect(mockDb.getHealthHistory).toHaveBeenCalledWith('codex', 30);
  });

  it('returns a valid MCP response format with a text content entry', () => {
    const result = handleGetProviderHealthTrends({ provider: 'codex', days: 3 });

    expectMcpTextResponse(result);
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });
});
