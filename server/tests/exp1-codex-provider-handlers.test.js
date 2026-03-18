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

const mockDb = {
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  getProvider: vi.fn(),
  listProviders: vi.fn(),
  getHealthTrend: vi.fn(),
  getProviderStats: vi.fn(),
  getDefaultProvider: vi.fn(),
  setDefaultProvider: vi.fn(),
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
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../task-manager', mockTaskManager);
  installCjsModuleMock('../dashboard-server', mockDashboard);
  installCjsModuleMock('../handlers/provider-ollama-hosts', {});
  installCjsModuleMock('../handlers/provider-tuning', {});
  return require('../handlers/provider-handlers');
}

vi.mock('../database', () => mockDb);
vi.mock('../task-manager', () => mockTaskManager);
vi.mock('../dashboard-server', () => mockDashboard);
vi.mock('../handlers/provider-ollama-hosts', () => ({}));
vi.mock('../handlers/provider-tuning', () => ({}));

function resetMockDefaults() {
  mockDb.getConfig.mockReset();
  mockDb.getConfig.mockReturnValue(null);

  mockDb.setConfig.mockReset();
  mockDb.setConfig.mockImplementation(() => undefined);

  mockDb.getProvider.mockReset();
  mockDb.getProvider.mockReturnValue(null);

  mockDb.listProviders.mockReset();
  mockDb.listProviders.mockReturnValue([]);

  mockDb.getHealthTrend.mockReset();
  mockDb.getHealthTrend.mockImplementation((provider, days = 30) => ({
    provider,
    days,
    trend: 'stable',
    window_count: 2,
    previous_failure_rate: 0.1,
    recent_failure_rate: 0.1,
  }));

  mockDb.getProviderStats.mockReset();
  mockDb.getProviderStats.mockReturnValue({
    total_tasks: 0,
    successful_tasks: 0,
    failed_tasks: 0,
    success_rate: 0,
    total_tokens: 0,
    total_cost: 0,
    avg_duration_seconds: 0,
  });

  mockDb.getDefaultProvider.mockReset();
  mockDb.getDefaultProvider.mockReturnValue('codex');

  mockDb.setDefaultProvider.mockReset();
  mockDb.setDefaultProvider.mockImplementation(() => undefined);

  mockDb.detectProviderDegradation.mockReset();
  mockDb.detectProviderDegradation.mockReturnValue([]);

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
      expect(mockDb.listProviders).not.toHaveBeenCalled();
      expect(mockDb.setDefaultProvider).not.toHaveBeenCalled();
    });

    it('returns an error when provider is blank or invalid', () => {
      mockDb.listProviders.mockReturnValue([
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
      expect(mockDb.setDefaultProvider).not.toHaveBeenCalled();
    });

    it('sets the default provider and returns a success message', () => {
      mockDb.listProviders.mockReturnValue([
        { provider: 'codex' },
        { provider: 'ollama' },
      ]);

      const result = handlers.handleSetDefaultProvider({ provider: 'ollama' });

      expect(result.isError).toBeFalsy();
      expect(mockDb.setDefaultProvider).toHaveBeenCalledWith('ollama');
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
      expect(mockDb.getProviderStats).not.toHaveBeenCalled();
      expect(mockDb.getProvider).not.toHaveBeenCalled();
    });

    it('returns stats for the requested provider', () => {
      mockDb.getProvider.mockReturnValue({
        provider: 'ollama',
        enabled: 1,
        priority: 2,
        max_concurrent: 6,
      });
      mockDb.getProviderStats.mockReturnValue({
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
      expect(mockDb.getProviderStats).toHaveBeenCalledWith('ollama', 7);
      expect(mockDb.getProvider).toHaveBeenCalledWith('ollama');
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
      mockDb.getProvider.mockReturnValue(null);
      mockDb.getProviderStats.mockReturnValue({
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
      expect(mockDb.getProviderStats).toHaveBeenCalledWith('missing-provider', 30);
      expect(result.content[0].text).toContain('Provider Statistics: missing-provider');
      expect(result.content[0].text).toContain('*Provider not found*');
    });
  });

  describe('handleDetectProviderDegradation (current health/dashboard equivalent)', () => {
    it('works with an empty or minimal db state', () => {
      mockDb.detectProviderDegradation.mockReturnValue([]);

      const result = handlers.handleDetectProviderDegradation({});

      expect(result.isError).toBeFalsy();
      expect(mockDb.detectProviderDegradation).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('Provider Health');
      expect(result.content[0].text).toContain('No degradation detected');
    });

    it('returns degraded provider health details when issues exist', () => {
      mockDb.detectProviderDegradation.mockReturnValue([
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
      mockDb.getHealthTrend.mockReturnValue({
        provider: 'ollama',
        days: 7,
        trend: 'improving',
        window_count: 4,
        previous_failure_rate: 0.4,
        recent_failure_rate: 0.1,
      });

      const result = handlers.handleGetProviderHealthTrends({ provider: 'ollama', days: 7 });

      expect(result.isError).toBeFalsy();
      expect(mockDb.getHealthTrend).toHaveBeenCalledWith('ollama', 7);
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
      mockDb.listProviders.mockReturnValue([
        { provider: 'codex' },
        { provider: 'ollama' },
      ]);
      mockDb.getHealthTrend
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
      expect(mockDb.listProviders).toHaveBeenCalledTimes(1);
      expect(mockDb.getHealthTrend).toHaveBeenNthCalledWith(1, 'codex', undefined);
      expect(mockDb.getHealthTrend).toHaveBeenNthCalledWith(2, 'ollama', undefined);
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
      expect(mockDb.getHealthTrend).not.toHaveBeenCalled();
    });
  });
});
