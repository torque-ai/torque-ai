'use strict';

/**
 * Focused tests for the main handlers exported from provider-handlers.js.
 *
 * The task prompt references older names that do not exist in the current
 * module. These tests cover the current equivalents in the main file:
 * - handleSetDefaultProvider: switch-provider/default-provider behavior
 * - handleProviderStats: per-provider stats output
 * - handleDetectProviderDegradation: provider health summary
 */

const mockRoutingCore = {
  getProvider: vi.fn(),
  listProviders: vi.fn(),
  getHealthTrend: vi.fn(),
  getProviderStats: vi.fn(),
  getDefaultProvider: vi.fn(),
  setDefaultProvider: vi.fn(),
};

const mockFileTracking = {
  detectProviderDegradation: vi.fn(),
};

const mockTaskManager = {
  processQueue: vi.fn(),
};

const mockDashboard = {
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(),
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
  installCjsModuleMock('../db/provider/routing-core', mockRoutingCore);
  installCjsModuleMock('../db/file-tracking', mockFileTracking);
  installCjsModuleMock('../task-manager', mockTaskManager);
  installCjsModuleMock('../dashboard/server', mockDashboard);
  installCjsModuleMock('../handlers/provider-ollama-hosts', {});
  installCjsModuleMock('../handlers/provider-tuning', {});
  return require('../handlers/provider-handlers');
}

vi.mock('../db/provider/routing-core', () => mockRoutingCore);
vi.mock('../db/file-tracking', () => mockFileTracking);
vi.mock('../task-manager', () => mockTaskManager);
vi.mock('../dashboard/server', () => mockDashboard);
vi.mock('../handlers/provider-ollama-hosts', () => ({}));
vi.mock('../handlers/provider-tuning', () => ({}));

function resetMockDefaults() {
  mockRoutingCore.getProvider.mockReset();
  mockRoutingCore.getProvider.mockReturnValue(null);

  mockRoutingCore.listProviders.mockReset();
  mockRoutingCore.listProviders.mockReturnValue([]);

  mockRoutingCore.getHealthTrend.mockReset();
  mockRoutingCore.getHealthTrend.mockImplementation((provider, days = 30) => ({
    provider,
    days,
    trend: 'stable',
    window_count: 2,
    previous_failure_rate: 0.1,
    recent_failure_rate: 0.1,
  }));

  mockRoutingCore.getProviderStats.mockReset();
  mockRoutingCore.getProviderStats.mockReturnValue({
    total_tasks: 0,
    successful_tasks: 0,
    failed_tasks: 0,
    success_rate: 0,
    total_tokens: 0,
    total_cost: 0,
    avg_duration_seconds: 0,
  });

  mockRoutingCore.getDefaultProvider.mockReset();
  mockRoutingCore.getDefaultProvider.mockReturnValue('codex');

  mockRoutingCore.setDefaultProvider.mockReset();
  mockRoutingCore.setDefaultProvider.mockImplementation(() => undefined);

  mockFileTracking.detectProviderDegradation.mockReset();
  mockFileTracking.detectProviderDegradation.mockReturnValue([]);

  mockTaskManager.processQueue.mockReset();

  mockDashboard.start.mockReset();
  mockDashboard.stop.mockReset();
  mockDashboard.getStatus.mockReset();
  mockDashboard.getStatus.mockReturnValue({ running: false });
}

describe('provider-handlers main-file handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadProviderHandlers();
  });

  describe('handleSetDefaultProvider (switch-provider equivalent)', () => {
    it('returns an error when provider is missing', () => {
      const result = handlers.handleSetDefaultProvider({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(result.content[0].text).toContain('provider is required');
      expect(mockRoutingCore.listProviders).not.toHaveBeenCalled();
      expect(mockRoutingCore.setDefaultProvider).not.toHaveBeenCalled();
    });

    it('returns an error when provider is blank or invalid', () => {
      mockRoutingCore.listProviders.mockReturnValue([
        { provider: 'codex' },
        { provider: 'ollama' },
      ]);

      const blankResult = handlers.handleSetDefaultProvider({ provider: '   ' });
      const invalidResult = handlers.handleSetDefaultProvider({ provider: 'groq' });

      expect(blankResult.isError).toBe(true);
      expect(blankResult.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(blankResult.content[0].text).toContain('provider is required');

      expect(invalidResult.isError).toBe(true);
      expect(invalidResult.error_code).toBe('INVALID_PARAM');
      expect(invalidResult.content[0].text).toContain('Unknown provider: groq');
      expect(invalidResult.content[0].text).toContain('codex, ollama');
      expect(mockRoutingCore.setDefaultProvider).not.toHaveBeenCalled();
    });

    it('sets the default provider and returns a success message', () => {
      mockRoutingCore.listProviders.mockReturnValue([
        { provider: 'codex' },
        { provider: 'ollama' },
      ]);

      const result = handlers.handleSetDefaultProvider({ provider: 'ollama' });

      expect(result.isError).toBeFalsy();
      expect(mockRoutingCore.setDefaultProvider).toHaveBeenCalledWith('ollama');
      expect(result.content[0].text).toContain('Default Provider Updated');
      expect(result.content[0].text).toContain('New tasks will now use **ollama** by default.');
    });
  });

  describe('handleProviderStats (get-provider-stats equivalent)', () => {
    it('returns an error when provider is missing', () => {
      const result = handlers.handleProviderStats({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(result.content[0].text).toContain('provider is required');
      expect(mockRoutingCore.getProviderStats).not.toHaveBeenCalled();
      expect(mockRoutingCore.getProvider).not.toHaveBeenCalled();
    });

    it('returns stats for the requested provider', () => {
      mockRoutingCore.getProvider.mockReturnValue({
        provider: 'ollama',
        enabled: 1,
        priority: 2,
        max_concurrent: 6,
      });
      mockRoutingCore.getProviderStats.mockReturnValue({
        total_tasks: 20,
        successful_tasks: 15,
        failed_tasks: 5,
        success_rate: 75,
        total_tokens: 12345,
        total_cost: 1.5,
        avg_duration_seconds: 12.2,
      });

      const result = handlers.handleProviderStats({ provider: 'ollama', days: 7 });

      expect(result.isError).toBeFalsy();
      expect(mockRoutingCore.getProviderStats).toHaveBeenCalledWith('ollama', 7);
      expect(mockRoutingCore.getProvider).toHaveBeenCalledWith('ollama');
      expect(result.content[0].text).toContain('Provider Statistics: ollama');
      expect(result.content[0].text).toContain('Last 7 days');
      expect(result.content[0].text).toContain('| Enabled | Yes |');
      expect(result.content[0].text).toContain('| Total Tasks | 20 |');
      expect(result.content[0].text).toContain('| Success Rate | 75% |');
      expect(result.content[0].text).toContain('| Total Tokens | 12,345 |');
      expect(result.content[0].text).toContain('| Total Cost | $1.5000 |');
      expect(result.content[0].text).toContain('| Avg Duration | 12s |');
    });

    it('handles a minimal db response when the provider configuration is missing', () => {
      mockRoutingCore.getProvider.mockReturnValue(null);
      mockRoutingCore.getProviderStats.mockReturnValue({
        total_tasks: 0,
        successful_tasks: 0,
        failed_tasks: 0,
        success_rate: 0,
        total_tokens: 0,
        total_cost: 0,
        avg_duration_seconds: 0,
      });

      const result = handlers.handleProviderStats({ provider: 'missing-provider' });

      expect(result.isError).toBeFalsy();
      expect(mockRoutingCore.getProviderStats).toHaveBeenCalledWith('missing-provider', 30);
      expect(result.content[0].text).toContain('Provider Statistics: missing-provider');
      expect(result.content[0].text).toContain('*Provider not found*');
    });
  });

  describe('handleDetectProviderDegradation (current health/dashboard equivalent)', () => {
    it('works with an empty or minimal db state', () => {
      mockFileTracking.detectProviderDegradation.mockReturnValue([]);

      const result = handlers.handleDetectProviderDegradation({});

      expect(result.isError).toBeFalsy();
      expect(mockFileTracking.detectProviderDegradation).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('Provider Health');
      expect(result.content[0].text).toContain('No degradation detected');
    });

    it('returns degraded provider health details when issues exist', () => {
      mockFileTracking.detectProviderDegradation.mockReturnValue([
        {
          provider: 'ollama',
          failure_rate: 0.4,
          failed_tasks: 4,
          total_tasks: 10,
        },
      ]);

      const result = handlers.handleDetectProviderDegradation({});

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Provider Degradation Detected');
      expect(result.content[0].text).toContain('| **ollama** | 40.0% | 4 / 10 |');
      expect(result.content[0].text).toContain('adjusting fallback chains');
    });
  });

  describe('handleGetProviderHealthTrends', () => {
    it('returns a single-provider trend as MCP JSON text', () => {
      mockRoutingCore.getHealthTrend.mockReturnValue({
        provider: 'ollama',
        days: 7,
        trend: 'improving',
        window_count: 4,
        previous_failure_rate: 0.4,
        recent_failure_rate: 0.1,
      });

      const result = handlers.handleGetProviderHealthTrends({ provider: 'ollama', days: 7 });

      expect(result.isError).toBeFalsy();
      expect(mockRoutingCore.getHealthTrend).toHaveBeenCalledWith('ollama', 7);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual([{
        provider: 'ollama',
        days: 7,
        trend: 'improving',
        window_count: 4,
        previous_failure_rate: 0.4,
        recent_failure_rate: 0.1,
      }]);
    });

    it('returns all configured provider trends when provider is omitted', () => {
      mockRoutingCore.listProviders.mockReturnValue([
        { provider: 'codex' },
        { provider: 'ollama' },
      ]);
      mockRoutingCore.getHealthTrend
        .mockReturnValueOnce({
          provider: 'codex',
          days: 30,
          trend: 'stable',
          window_count: 2,
          previous_failure_rate: 0.2,
          recent_failure_rate: 0.2,
        })
        .mockReturnValueOnce({
          provider: 'ollama',
          days: 30,
          trend: 'degrading',
          window_count: 2,
          previous_failure_rate: 0.1,
          recent_failure_rate: 0.3,
        });

      const result = handlers.handleGetProviderHealthTrends({});

      expect(result.isError).toBeFalsy();
      expect(mockRoutingCore.listProviders).toHaveBeenCalledTimes(1);
      expect(mockRoutingCore.getHealthTrend).toHaveBeenNthCalledWith(1, 'codex', undefined);
      expect(mockRoutingCore.getHealthTrend).toHaveBeenNthCalledWith(2, 'ollama', undefined);
      expect(JSON.parse(result.content[0].text)).toEqual([
        {
          provider: 'codex',
          days: 30,
          trend: 'stable',
          window_count: 2,
          previous_failure_rate: 0.2,
          recent_failure_rate: 0.2,
        },
        {
          provider: 'ollama',
          days: 30,
          trend: 'degrading',
          window_count: 2,
          previous_failure_rate: 0.1,
          recent_failure_rate: 0.3,
        },
      ]);
    });

    it('returns INVALID_PARAM for invalid input values', () => {
      const invalidProvider = handlers.handleGetProviderHealthTrends({ provider: 42 });
      const invalidDays = handlers.handleGetProviderHealthTrends({ days: 0 });

      expect(invalidProvider.isError).toBe(true);
      expect(invalidProvider.error_code).toBe('INVALID_PARAM');
      expect(invalidProvider.content[0].text).toContain('provider must be a string');
      expect(invalidDays.isError).toBe(true);
      expect(invalidDays.error_code).toBe('INVALID_PARAM');
      expect(invalidDays.content[0].text).toContain('days must be a positive number');
      expect(mockRoutingCore.getHealthTrend).not.toHaveBeenCalled();
    });
  });
});
