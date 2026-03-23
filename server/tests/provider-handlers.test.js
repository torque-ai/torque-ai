'use strict';

const { TEST_MODELS } = require('./test-helpers');
const realErrorCodes = require('../handlers/error-codes');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const mockDb = {
  approveProviderSwitch: vi.fn(),
  rejectProviderSwitch: vi.fn(),
  listProviders: vi.fn(),
  configureProvider: vi.fn(),
  getProviderStats: vi.fn(),
  setDefaultProvider: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  getFallbackChain: vi.fn(),
  setFallbackChain: vi.fn(),
  getProviderHealthHistory: vi.fn(),
  getFormatSuccessRates: vi.fn(),
  getModelLeaderboard: vi.fn(),
  getDefaultProvider: vi.fn(),
  getProvider: vi.fn(),
  updateProvider: vi.fn(),
  setProviderFallbackChain: vi.fn(),
  detectProviderDegradation: vi.fn(),
  getFormatSuccessRate: vi.fn(),
  getBestFormatForModel: vi.fn(),
  getFormatSuccessRatesSummary: vi.fn(),
  getHealthTrend: vi.fn(),
  listTasks: vi.fn(),
};

const mockTaskManager = {
  processQueue: vi.fn(),
};

const mockDashboard = {
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(),
};

const mockProviderRegistry = {
  isApiProvider: vi.fn(),
};

function resetMocks() {
  for (const fn of Object.values(mockDb)) {
    fn.mockReset();
  }

  mockTaskManager.processQueue.mockReset();

  mockDashboard.start.mockReset();
  mockDashboard.stop.mockReset();
  mockDashboard.getStatus.mockReset();
  mockProviderRegistry.isApiProvider.mockReset();

  mockDb.listProviders.mockReturnValue([]);
  mockDb.getDefaultProvider.mockReturnValue('codex');
  mockDb.getProvider.mockReturnValue(null);
  mockDb.updateProvider.mockImplementation((provider, updates) => ({
    provider,
    enabled: updates.enabled ?? 1,
    priority: 1,
    cli_path: updates.cli_path || null,
    max_concurrent: updates.max_concurrent || 4,
    quota_error_patterns: updates.quota_error_patterns || [],
  }));
  mockDb.getProviderStats.mockReturnValue({
    total_tasks: 0,
    successful_tasks: 0,
    failed_tasks: 0,
    success_rate: 0,
    total_tokens: 0,
    total_cost: 0,
    avg_duration_seconds: 0,
  });
  mockDb.detectProviderDegradation.mockReturnValue([]);
  mockDb.getFormatSuccessRate.mockReturnValue({
    total: 0,
    successes: 0,
    rate: 0,
    avg_duration: 0,
  });
  mockDb.getBestFormatForModel.mockReturnValue({
    format: null,
    reason: 'insufficient data',
  });
  mockDb.getFormatSuccessRatesSummary.mockReturnValue([]);
  mockDb.getHealthTrend.mockImplementation((provider, days = 30) => ({
    provider,
    days,
    trend: 'stable',
  }));
  mockDb.listTasks.mockReturnValue([]);
  mockDb.getModelLeaderboard.mockReturnValue([]);
  mockProviderRegistry.isApiProvider.mockReturnValue(false);

  mockDashboard.start.mockResolvedValue({
    success: true,
    url: 'http://localhost:3456',
    port: 3456,
  });
  mockDashboard.getStatus.mockReturnValue({ running: true });
  mockDashboard.stop.mockReturnValue({ success: true });
}

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/provider-handlers')];
  installMock('../db/task-core', {
    listTasks: mockDb.listTasks,
  });
  installMock('../db/event-tracking', {
    getFormatSuccessRate: mockDb.getFormatSuccessRate,
    getBestFormatForModel: mockDb.getBestFormatForModel,
    getFormatSuccessRatesSummary: mockDb.getFormatSuccessRatesSummary,
  });
  installMock('../db/file-tracking', {
    detectProviderDegradation: mockDb.detectProviderDegradation,
  });
  installMock('../db/host-management', {
    getModelLeaderboard: mockDb.getModelLeaderboard,
  });
  installMock('../db/provider-routing-core', {
    approveProviderSwitch: mockDb.approveProviderSwitch,
    rejectProviderSwitch: mockDb.rejectProviderSwitch,
    listProviders: mockDb.listProviders,
    getDefaultProvider: mockDb.getDefaultProvider,
    getProvider: mockDb.getProvider,
    updateProvider: mockDb.updateProvider,
    getProviderStats: mockDb.getProviderStats,
    setDefaultProvider: mockDb.setDefaultProvider,
    setProviderFallbackChain: mockDb.setProviderFallbackChain,
    getHealthTrend: mockDb.getHealthTrend,
  });
  installMock('../task-manager', mockTaskManager);
  installMock('../dashboard-server', mockDashboard);
  installMock('../providers/registry', mockProviderRegistry);
  installMock('../handlers/error-codes', realErrorCodes);
  installMock('../handlers/provider-ollama-hosts', {});
  installMock('../handlers/provider-tuning', {});
  return require('../handlers/provider-handlers');
}

function getText(result) {
  return result.content[0].text;
}

describe('provider-handlers.js', () => {
  let handlers;

  beforeEach(() => {
    resetMocks();
    handlers = loadHandlers();
  });

  describe('handleApproveProviderSwitch', () => {
    it('returns an error when task_id is missing', () => {
      const result = handlers.handleApproveProviderSwitch({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.approveProviderSwitch).not.toHaveBeenCalled();
      expect(mockTaskManager.processQueue).not.toHaveBeenCalled();
    });

    it('approves the switch, processes the queue, and formats the task response', () => {
      mockDb.approveProviderSwitch.mockReturnValue({
        status: 'queued',
        provider: 'ollama',
        original_provider: 'codex',
        provider_switched_at: '2026-03-11T18:22:00Z',
      });

      const result = handlers.handleApproveProviderSwitch({
        task_id: 'task-123',
        new_provider: 'ollama',
      });

      expect(mockDb.approveProviderSwitch).toHaveBeenCalledWith('task-123', 'ollama');
      expect(mockTaskManager.processQueue).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('Provider Switch Approved');
      expect(getText(result)).toContain('Task **task-123** will now retry with **ollama**.');
      expect(getText(result)).toContain('| Status | queued |');
      expect(getText(result)).toContain('| Provider | ollama |');
      expect(getText(result)).toContain('| Original Provider | codex |');
      expect(getText(result)).toContain('| Switched At | 2026-03-11T18:22:00Z |');
    });
  });

  describe('handleRejectProviderSwitch', () => {
    it('returns an error when task_id is missing', () => {
      const result = handlers.handleRejectProviderSwitch({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.rejectProviderSwitch).not.toHaveBeenCalled();
    });

    it('rejects the switch and renders the rejection details', () => {
      mockDb.rejectProviderSwitch.mockReturnValue({
        status: 'failed',
        provider: 'codex',
      });

      const result = handlers.handleRejectProviderSwitch({
        task_id: 'task-456',
        reason: 'manual rejection',
      });

      expect(mockDb.rejectProviderSwitch).toHaveBeenCalledWith('task-456', 'manual rejection');
      expect(getText(result)).toContain('Provider Switch Rejected');
      expect(getText(result)).toContain('Task **task-456** has been marked as failed.');
      expect(getText(result)).toContain('**Reason:** manual rejection');
      expect(getText(result)).toContain('| Status | failed |');
      expect(getText(result)).toContain('| Provider | codex |');
    });
  });

  describe('handleListProviders', () => {
    it('returns a markdown provider table with default and quota details', () => {
      mockDb.listProviders.mockReturnValue([
        {
          provider: 'codex',
          enabled: 1,
          priority: 1,
          cli_path: null,
          max_concurrent: 4,
          quota_error_patterns: ['429', 'quota exceeded'],
        },
        {
          provider: 'ollama',
          enabled: 0,
          priority: 2,
          cli_path: '/usr/local/bin/ollama',
          max_concurrent: 2,
          quota_error_patterns: [],
        },
      ]);
      mockDb.getDefaultProvider.mockReturnValue('codex');

      const result = handlers.handleListProviders();

      expect(mockDb.listProviders).toHaveBeenCalledTimes(1);
      expect(mockDb.getDefaultProvider).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('Configured Providers');
      expect(getText(result)).toContain('**Default Provider:** codex');
      expect(getText(result)).toContain('| Provider | Enabled | Priority | CLI Path | Max Concurrent |');
      expect(getText(result)).toContain('| codex (default) | Yes | 1 | auto | 4 |');
      expect(getText(result)).toContain('| ollama | No | 2 | /usr/local/bin/ollama | 2 |');
      expect(getText(result)).toContain('Quota Error Patterns');
      expect(getText(result)).toContain('**codex:** 429, quota exceeded');
    });
  });

  describe('handleConfigureProvider', () => {
    it('returns an error when provider is missing', () => {
      const result = handlers.handleConfigureProvider({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('provider is required');
      expect(mockDb.getProvider).not.toHaveBeenCalled();
      expect(mockDb.updateProvider).not.toHaveBeenCalled();
    });

    it('updates a known provider and returns the formatted settings table', () => {
      mockDb.getProvider.mockReturnValue({ provider: 'codex' });
      mockDb.updateProvider.mockReturnValue({
        enabled: 0,
        priority: 3,
        cli_path: '/opt/codex',
        max_concurrent: 6,
        quota_error_patterns: ['429', 'budget'],
      });

      const result = handlers.handleConfigureProvider({
        provider: 'codex',
        enabled: false,
        cli_path: '/opt/codex',
        quota_error_patterns: ['429', 'budget'],
        max_concurrent: 6,
      });

      expect(mockDb.getProvider).toHaveBeenCalledWith('codex');
      expect(mockDb.updateProvider).toHaveBeenCalledWith('codex', {
        enabled: 0,
        cli_path: '/opt/codex',
        quota_error_patterns: ['429', 'budget'],
        max_concurrent: 6,
      });
      expect(getText(result)).toContain('Provider Updated: codex');
      expect(getText(result)).toContain('| Enabled | No |');
      expect(getText(result)).toContain('| Priority | 3 |');
      expect(getText(result)).toContain('| CLI Path | /opt/codex |');
      expect(getText(result)).toContain('| Max Concurrent | 6 |');
      expect(getText(result)).toContain('| Quota Patterns | 429, budget |');
    });
  });

  describe('handleProviderStats', () => {
    it('returns provider stats as markdown', () => {
      mockDb.getProvider.mockReturnValue({
        enabled: 1,
        priority: 2,
        max_concurrent: 5,
      });
      mockDb.getProviderStats.mockReturnValue({
        total_tasks: 24,
        successful_tasks: 18,
        failed_tasks: 6,
        success_rate: 75,
        total_tokens: 12345,
        total_cost: 1.2345,
        avg_duration_seconds: 12.4,
      });

      const result = handlers.handleProviderStats({ provider: 'ollama', days: 14 });

      expect(mockDb.getProviderStats).toHaveBeenCalledWith('ollama', 14);
      expect(mockDb.getProvider).toHaveBeenCalledWith('ollama');
      expect(getText(result)).toContain('Provider Statistics: ollama');
      expect(getText(result)).toContain('**Period:** Last 14 days');
      expect(getText(result)).toContain('### Configuration');
      expect(getText(result)).toContain('| Enabled | Yes |');
      expect(getText(result)).toContain('### Usage Statistics');
      expect(getText(result)).toContain('| Total Tasks | 24 |');
      expect(getText(result)).toContain('| Success Rate | 75% |');
      expect(getText(result)).toContain('| Total Cost | $1.2345 |');
      expect(getText(result)).toContain('| Avg Duration | 12s |');
    });
  });

  describe('handleSetDefaultProvider', () => {
    it('sets the default provider and returns a confirmation', () => {
      mockDb.listProviders.mockReturnValue([
        { provider: 'codex' },
        { provider: 'ollama' },
      ]);

      const result = handlers.handleSetDefaultProvider({ provider: 'ollama' });

      expect(mockDb.setDefaultProvider).toHaveBeenCalledWith('ollama');
      expect(getText(result)).toContain('Default Provider Updated');
      expect(getText(result)).toContain('New tasks will now use **ollama** by default.');
      expect(getText(result)).toContain('Existing tasks retain their original provider.');
    });
  });

  describe('handleStartDashboard and handleStopDashboard', () => {
    it('starts the dashboard through the dashboard module', async () => {
      const result = await handlers.handleStartDashboard({
        port: 4567,
        open_browser: false,
      });

      expect(mockDashboard.start).toHaveBeenCalledWith({
        port: 4567,
        openBrowser: false,
      });
      expect(getText(result)).toContain('Dashboard Started');
      expect(getText(result)).toContain('| URL | http://localhost:3456 |');
    });

    it('stops the dashboard through the dashboard module', () => {
      const result = handlers.handleStopDashboard({});

      expect(mockDashboard.getStatus).toHaveBeenCalledTimes(1);
      expect(mockDashboard.stop).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('Dashboard Stopped');
      expect(getText(result)).toContain('Use `start_dashboard` to start it again.');
    });
  });

  describe('handleConfigureFallbackChain', () => {
    it('returns an error when provider is missing', () => {
      const result = handlers.handleConfigureFallbackChain({ chain: 'ollama,claude-cli' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('provider is required');
      expect(mockDb.setProviderFallbackChain).not.toHaveBeenCalled();
    });

    it('stores the parsed fallback chain and returns the chain summary', () => {
      const result = handlers.handleConfigureFallbackChain({
        provider: 'codex',
        chain: 'ollama, claude-cli',
      });

      expect(mockDb.setProviderFallbackChain).toHaveBeenCalledWith('codex', ['ollama', 'claude-cli']);
      expect(getText(result)).toContain('Fallback Chain Updated: codex');
      expect(getText(result)).toContain('ollama');
      expect(getText(result)).toContain('claude-cli');
      expect(getText(result)).toContain('When codex fails');
    });
  });

  describe('handleDetectProviderDegradation', () => {
    it('returns provider degradation analysis', () => {
      mockDb.detectProviderDegradation.mockReturnValue([
        {
          provider: 'ollama',
          failure_rate: 0.375,
          failed_tasks: 3,
          total_tasks: 8,
        },
      ]);

      const result = handlers.handleDetectProviderDegradation({});

      expect(mockDb.detectProviderDegradation).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('Provider Degradation Detected');
      expect(getText(result)).toContain('| **ollama** | 37.5% | 3 / 8 |');
      expect(getText(result)).toContain('adjusting fallback chains');
    });
  });

  describe('handleGetFormatSuccessRates', () => {
    it('returns model-specific format success rates', () => {
      mockDb.getFormatSuccessRate
        .mockReturnValueOnce({ total: 20, successes: 16, rate: 0.8, avg_duration: 14 })
        .mockReturnValueOnce({ total: 20, successes: 12, rate: 0.6, avg_duration: 9 });
      mockDb.getBestFormatForModel.mockReturnValue({
        format: 'hashline',
        reason: 'higher success rate',
      });

      const result = handlers.handleGetFormatSuccessRates({ model: TEST_MODELS.DEFAULT });

      expect(mockDb.getFormatSuccessRate).toHaveBeenNthCalledWith(1, TEST_MODELS.DEFAULT, 'hashline');
      expect(mockDb.getFormatSuccessRate).toHaveBeenNthCalledWith(2, TEST_MODELS.DEFAULT, 'hashline-lite');
      expect(mockDb.getBestFormatForModel).toHaveBeenCalledWith(TEST_MODELS.DEFAULT);
      expect(getText(result)).toContain(`Format Success Rates: ${TEST_MODELS.DEFAULT}`);
      expect(getText(result)).toContain('| hashline | 20 | 16 | 80% | 14s |');
      expect(getText(result)).toContain('| hashline-lite | 20 | 12 | 60% | 9s |');
      expect(getText(result)).toContain('**Recommended:** hashline (higher success rate)');
    });

    it('returns the all-model summary table when no model is provided', () => {
      mockDb.getFormatSuccessRatesSummary.mockReturnValue([
        {
          model: TEST_MODELS.DEFAULT,
          edit_format: 'hashline',
          total: 18,
          successes: 15,
          failures: 3,
          success_rate_pct: 83,
          avg_duration_s: 11,
          failure_reasons: 'timeout',
        },
      ]);

      const result = handlers.handleGetFormatSuccessRates({});

      expect(mockDb.getFormatSuccessRatesSummary).toHaveBeenCalledTimes(1);
      expect(getText(result)).toContain('Format Success Rates (All Models)');
      expect(getText(result)).toContain(`| ${TEST_MODELS.DEFAULT} | hashline | 18 | 15 | 3 | 83% | 11s | timeout |`);
    });
  });

  describe('handleGetProviderHealthTrends', () => {
    it('returns provider health trends as JSON text', () => {
      mockDb.getHealthTrend.mockReturnValue({
        provider: 'ollama',
        days: 7,
        trend: 'improving',
        previous_failure_rate: 0.4,
        recent_failure_rate: 0.1,
      });

      const result = handlers.handleGetProviderHealthTrends({
        provider: 'ollama',
        days: 7,
      });

      expect(mockDb.getHealthTrend).toHaveBeenCalledWith('ollama', 7);
      expect(JSON.parse(getText(result))).toEqual([{
        provider: 'ollama',
        days: 7,
        trend: 'improving',
        previous_failure_rate: 0.4,
        recent_failure_rate: 0.1,
      }]);
    });
  });

  describe('handleGetModelLeaderboard', () => {
    it('returns the leaderboard payload as formatted JSON text', () => {
      mockDb.getModelLeaderboard.mockReturnValue([
        {
          model: TEST_MODELS.DEFAULT,
          provider: 'ollama',
          success_rate: 0.92,
        },
      ]);

      const result = handlers.handleGetModelLeaderboard({
        task_type: 'testing',
        language: 'javascript',
        days: 30,
        limit: 5,
      });

      expect(mockDb.getModelLeaderboard).toHaveBeenCalledWith({
        task_type: 'testing',
        language: 'javascript',
        days: 30,
        limit: 5,
      });
      expect(JSON.parse(getText(result))).toEqual([
        {
          model: TEST_MODELS.DEFAULT,
          provider: 'ollama',
          success_rate: 0.92,
        },
      ]);
    });
  });

  describe('handleGetProviderPercentiles', () => {
    it('uses listTasks with from_date and formats percentile output', () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-18T12:00:00.000Z'));
      mockDb.listTasks.mockReturnValue([
        {
          started_at: '2026-03-18T11:00:00.000Z',
          completed_at: '2026-03-18T11:00:10.000Z',
        },
        {
          started_at: '2026-03-18T10:00:00.000Z',
          completed_at: '2026-03-18T10:00:40.000Z',
        },
      ]);

      try {
        const result = handlers.handleGetProviderPercentiles({ provider: 'ollama', days: 7 });

        expect(mockDb.listTasks).toHaveBeenCalledWith({
          provider: 'ollama',
          from_date: '2026-03-11T12:00:00.000Z',
          limit: 1000,
        });
        expect(mockDb.listTasks.mock.calls[0][0]).not.toHaveProperty('since');
        expect(getText(result)).toContain('Provider Percentiles: ollama');
        expect(getText(result)).toContain('Sample Size:** 2 completed tasks');
        expect(getText(result)).toContain('| Min | 10s |');
        expect(getText(result)).toContain('| P50 (median) | 40s |');
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});
