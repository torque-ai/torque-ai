const logger = require('../logger');
const trackerLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.spyOn(logger, 'child').mockReturnValue(trackerLogger);

const FreeQuotaTracker = require('../free-quota-tracker');

const defaultLimits = [
  { provider: 'groq', rpm_limit: 30, rpd_limit: 14400, tpm_limit: 6000, tpd_limit: 500000, daily_reset_hour: 0, daily_reset_tz: 'UTC' },
  { provider: 'cerebras', rpm_limit: 30, rpd_limit: 14400, tpm_limit: 64000, tpd_limit: 1000000, daily_reset_hour: 0, daily_reset_tz: 'UTC' },
  { provider: 'google-ai', rpm_limit: 10, rpd_limit: 250, tpm_limit: 250000, tpd_limit: null, daily_reset_hour: 0, daily_reset_tz: 'America/Los_Angeles' },
  { provider: 'openrouter', rpm_limit: 20, rpd_limit: 50, tpm_limit: null, tpd_limit: null, daily_reset_hour: 0, daily_reset_tz: 'UTC' },
];

function createTracker() {
  return new FreeQuotaTracker(defaultLimits);
}

describe('FreeQuotaTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('initializes all configured providers', () => {
      const tracker = createTracker();

      expect(tracker.providers.size).toBe(4);
      expect(Array.from(tracker.providers.keys())).toEqual([
        'groq',
        'cerebras',
        'google-ai',
        'openrouter',
      ]);
    });

    it('starts all usage counters at zero', () => {
      const tracker = createTracker();
      const status = tracker.getStatus();

      expect(status.groq.minute_requests).toBe(0);
      expect(status.groq.minute_tokens).toBe(0);
      expect(status.groq.daily_requests).toBe(0);
      expect(status.groq.daily_tokens).toBe(0);
      expect(status['google-ai'].minute_requests).toBe(0);
      expect(status.openrouter.daily_tokens).toBe(0);
    });

    it('stores reset metadata on provider state', () => {
      const tracker = createTracker();
      const google = tracker.providers.get('google-ai');

      expect(google.daily_reset_hour).toBe(0);
      expect(google.daily_reset_tz).toBe('America/Los_Angeles');
    });
  });

  describe('canSubmit', () => {
    it('returns true when provider has quota available', () => {
      const tracker = createTracker();

      expect(tracker.canSubmit('groq')).toBe(true);
    });

    it('returns false for an unknown provider', () => {
      const tracker = createTracker();

      expect(tracker.canSubmit('missing-provider')).toBe(false);
    });

    it('returns false when RPM is exhausted', () => {
      const tracker = createTracker();
      const state = tracker.providers.get('groq');
      state.minute_requests = state.rpm_limit;

      expect(tracker.canSubmit('groq')).toBe(false);
    });

    it('returns false when RPD is exhausted', () => {
      const tracker = createTracker();
      const state = tracker.providers.get('groq');
      state.daily_requests = state.rpd_limit;

      expect(tracker.canSubmit('groq')).toBe(false);
    });

    it('returns false when TPM is exhausted', () => {
      const tracker = createTracker();
      const state = tracker.providers.get('groq');
      state.minute_tokens = state.tpm_limit;

      expect(tracker.canSubmit('groq')).toBe(false);
    });

    it('returns false when TPD is exhausted', () => {
      const tracker = createTracker();
      const state = tracker.providers.get('groq');
      state.daily_tokens = state.tpd_limit;

      expect(tracker.canSubmit('groq')).toBe(false);
    });

    it('returns false while provider is in cooldown', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordRateLimit('groq', 45);

      expect(tracker.canSubmit('groq')).toBe(false);
    });

    it('returns true again after cooldown expires', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordRateLimit('groq', 30);

      vi.advanceTimersByTime(30000);

      expect(tracker.canSubmit('groq')).toBe(true);
    });

    it('automatically resets an expired minute window on submit check', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      const state = tracker.providers.get('groq');
      state.minute_requests = state.rpm_limit;

      vi.advanceTimersByTime(60000);

      expect(tracker.canSubmit('groq')).toBe(true);
      expect(state.minute_requests).toBe(0);
    });
  });

  describe('recordUsage', () => {
    it('increments request counters for both windows', () => {
      const tracker = createTracker();

      tracker.recordUsage('groq', 250);

      const state = tracker.providers.get('groq');
      expect(state.minute_requests).toBe(1);
      expect(state.daily_requests).toBe(1);
    });

    it('increments token counters for both windows', () => {
      const tracker = createTracker();

      tracker.recordUsage('cerebras', 1234);

      const state = tracker.providers.get('cerebras');
      expect(state.minute_tokens).toBe(1234);
      expect(state.daily_tokens).toBe(1234);
    });

    it('resets backoff step after successful usage', () => {
      const tracker = createTracker();
      const state = tracker.providers.get('groq');
      state.backoff_step = 3;

      tracker.recordUsage('groq', 50);

      expect(state.backoff_step).toBe(0);
    });

    it('ignores unknown providers', () => {
      const tracker = createTracker();

      expect(() => tracker.recordUsage('missing', 10)).not.toThrow();
    });
  });

  describe('recordRateLimit', () => {
    it('uses explicit retry-after seconds when provided', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      const state = tracker.providers.get('groq');
      state.backoff_step = 2;

      tracker.recordRateLimit('groq', 15);

      expect(state.cooldown_until).toBe(Date.now() + 15000);
      expect(state.backoff_step).toBe(0);
    });

    it('logs the explicit retry-after cooldown', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordRateLimit('groq', 15);

      expect(trackerLogger.info).toHaveBeenCalledWith('[FreeQuota] groq: cooldown 15s');
    });

    it('starts exponential backoff at 30 seconds when retry-after is missing', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordRateLimit('groq', null);

      const state = tracker.providers.get('groq');
      expect(state.cooldown_until).toBe(Date.now() + 30000);
      expect(state.backoff_step).toBe(1);
    });

    it('uses 60 seconds on the second backoff step', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordRateLimit('groq', null);
      tracker.recordRateLimit('groq', null);

      const state = tracker.providers.get('groq');
      expect(state.cooldown_until).toBe(Date.now() + 60000);
      expect(state.backoff_step).toBe(2);
    });

    it('uses 120 seconds on the third backoff step', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordRateLimit('groq', null);
      tracker.recordRateLimit('groq', null);
      tracker.recordRateLimit('groq', null);

      const state = tracker.providers.get('groq');
      expect(state.cooldown_until).toBe(Date.now() + 120000);
      expect(state.backoff_step).toBe(3);
    });

    it('caps exponential backoff at 300 seconds', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordRateLimit('groq', null);
      tracker.recordRateLimit('groq', null);
      tracker.recordRateLimit('groq', null);
      tracker.recordRateLimit('groq', null);
      tracker.recordRateLimit('groq', null);

      const state = tracker.providers.get('groq');
      expect(state.cooldown_until).toBe(Date.now() + 300000);
      expect(state.backoff_step).toBe(5);
      expect(trackerLogger.info).toHaveBeenLastCalledWith('[FreeQuota] groq: cooldown 300s');
    });
  });

  describe('getAvailableProviders', () => {
    it('sorts providers by remaining daily quota percentage descending', () => {
      const tracker = createTracker();

      tracker.providers.get('groq').daily_requests = 7200;
      tracker.providers.get('cerebras').daily_requests = 1440;
      tracker.providers.get('google-ai').daily_requests = 125;
      tracker.providers.get('openrouter').daily_requests = 40;

      expect(tracker.getAvailableProviders()).toEqual([
        { provider: 'cerebras', dailyRemainingPct: 0.9 },
        { provider: 'groq', dailyRemainingPct: 0.5 },
        { provider: 'google-ai', dailyRemainingPct: 0.5 },
        { provider: 'openrouter', dailyRemainingPct: 0.2 },
      ]);
    });

    it('excludes providers that are in cooldown', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordRateLimit('groq', 30);

      const providers = tracker.getAvailableProviders().map(entry => entry.provider);
      expect(providers).not.toContain('groq');
    });

    it('excludes exhausted providers', () => {
      const tracker = createTracker();
      tracker.providers.get('google-ai').daily_requests = 250;
      tracker.providers.get('openrouter').minute_requests = 20;

      const providers = tracker.getAvailableProviders().map(entry => entry.provider);
      expect(providers).toEqual(['groq', 'cerebras']);
    });

    it('returns an empty array when no providers are available', () => {
      const tracker = createTracker();

      for (const state of tracker.providers.values()) {
        state.minute_requests = state.rpm_limit;
      }

      expect(tracker.getAvailableProviders()).toEqual([]);
    });

    it('treats an rpd_limit of zero as 100% remaining for sorting', () => {
      const tracker = createTracker();
      tracker.updateLimits('groq', { rpd_limit: 0 });

      expect(tracker.getAvailableProviders()[0]).toEqual({
        provider: 'groq',
        dailyRemainingPct: 1,
      });
    });
  });

  describe('window resets', () => {
    it('resets minute usage after 60 seconds when tick is called', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordUsage('groq', 400);

      vi.advanceTimersByTime(60000);
      tracker.tick();

      const state = tracker.providers.get('groq');
      expect(state.minute_requests).toBe(0);
      expect(state.minute_tokens).toBe(0);
      expect(state.daily_requests).toBe(1);
      expect(state.daily_tokens).toBe(400);
    });

    it('resets daily usage after 24 hours when tick is called', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordUsage('groq', 400);

      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      tracker.tick();

      const state = tracker.providers.get('groq');
      expect(state.daily_requests).toBe(0);
      expect(state.daily_tokens).toBe(0);
      expect(state.minute_requests).toBe(0);
      expect(state.minute_tokens).toBe(0);
    });

    it('clears expired cooldowns when tick is called', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordRateLimit('groq', 30);

      vi.advanceTimersByTime(30000);
      tracker.tick();

      expect(tracker.providers.get('groq').cooldown_until).toBeNull();
    });
  });

  describe('updateLimits', () => {
    it('updates request limits dynamically', () => {
      const tracker = createTracker();
      tracker.updateLimits('groq', { rpm_limit: 1, rpd_limit: 1 });

      tracker.recordUsage('groq', 10);

      expect(tracker.canSubmit('groq')).toBe(false);
    });

    it('updates token limits dynamically', () => {
      const tracker = createTracker();
      tracker.updateLimits('groq', { tpm_limit: 100, tpd_limit: 100 });

      tracker.recordUsage('groq', 100);

      expect(tracker.canSubmit('groq')).toBe(false);
    });

    it('ignores unknown fields in updates', () => {
      const tracker = createTracker();
      tracker.updateLimits('groq', { imaginary_limit: 123, rpm_limit: 29 });

      const state = tracker.providers.get('groq');
      expect(state.imaginary_limit).toBeUndefined();
      expect(state.rpm_limit).toBe(29);
    });
  });

  describe('getStatus', () => {
    it('returns a complete status snapshot for each provider', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordUsage('groq', 250);
      tracker.recordRateLimit('groq', 30);

      const status = tracker.getStatus();

      expect(status.groq).toEqual({
        rpm_limit: 30,
        rpd_limit: 14400,
        tpm_limit: 6000,
        tpd_limit: 500000,
        minute_requests: 1,
        minute_tokens: 250,
        daily_requests: 1,
        daily_tokens: 250,
        cooldown_remaining_seconds: 30,
        minute_resets_in_seconds: 60,
        daily_resets_in_seconds: 86400,
        avg_latency_ms: 5000,
      });
    });

    it('reports countdown values as zero once cooldown has expired', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));

      const tracker = createTracker();
      tracker.recordRateLimit('groq', 5);

      vi.advanceTimersByTime(5000);

      const status = tracker.getStatus();
      expect(status.groq.cooldown_remaining_seconds).toBe(0);
    });
  });

  describe('scan-only enforcement', () => {
    it('returns providers for scan task type', () => {
      const tracker = createTracker();
      const result = tracker.getAvailableProvidersSmart({ taskType: 'scan' });
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns providers for reasoning task type', () => {
      const tracker = createTracker();
      const result = tracker.getAvailableProvidersSmart({ taskType: 'reasoning' });
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns providers for docs task type', () => {
      const tracker = createTracker();
      const result = tracker.getAvailableProvidersSmart({ taskType: 'docs' });
      expect(result.length).toBeGreaterThan(0);
    });

    it('blocks code_gen tasks from free providers', () => {
      const tracker = createTracker();
      const result = tracker.getAvailableProvidersSmart({ taskType: 'code_gen' });
      expect(result).toEqual([]);
    });

    it('blocks testing tasks from free providers', () => {
      const tracker = createTracker();
      const result = tracker.getAvailableProvidersSmart({ taskType: 'testing' });
      expect(result).toEqual([]);
    });

    it('blocks refactoring tasks from free providers', () => {
      const tracker = createTracker();
      const result = tracker.getAvailableProvidersSmart({ taskType: 'refactoring' });
      expect(result).toEqual([]);
    });

    it('allows routing when no taskType specified (backwards compat)', () => {
      const tracker = createTracker();
      const result = tracker.getAvailableProvidersSmart({});
      expect(result.length).toBeGreaterThan(0);
    });

    it('exports FREE_PROVIDER_SCAN_ONLY_TYPES set', () => {
      expect(FreeQuotaTracker.FREE_PROVIDER_SCAN_ONLY_TYPES).toBeInstanceOf(Set);
      expect(FreeQuotaTracker.FREE_PROVIDER_SCAN_ONLY_TYPES.has('scan')).toBe(true);
      expect(FreeQuotaTracker.FREE_PROVIDER_SCAN_ONLY_TYPES.has('reasoning')).toBe(true);
      expect(FreeQuotaTracker.FREE_PROVIDER_SCAN_ONLY_TYPES.has('docs')).toBe(true);
      expect(FreeQuotaTracker.FREE_PROVIDER_SCAN_ONLY_TYPES.has('code_gen')).toBe(false);
    });
  });
});
