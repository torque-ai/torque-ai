vi.mock('../providers/registry', () => {
  const categories = {
    ollama: 'ollama',
    'aider-ollama': 'ollama',
    'hashline-ollama': 'ollama',
    codex: 'codex',
    'claude-cli': 'codex',
    anthropic: 'api',
    groq: 'api',
    hyperbolic: 'api',
    deepinfra: 'api',
    'ollama-cloud': 'api',
    cerebras: 'api',
    'google-ai': 'api',
    openrouter: 'api',
  };

  return {
    getProviderInstance: vi.fn().mockReturnValue({}),
    listProviders: vi.fn().mockReturnValue([]),
    getProviderConfig: vi.fn(),
    getCategory: (provider) => categories[provider] || null,
  };
});

const logger = require('../logger');

const trackerLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.spyOn(logger, 'child').mockReturnValue(trackerLogger);

const FreeQuotaTracker = require('../free-quota-tracker');

const limits = [
  { provider: 'groq', rpm_limit: 30, rpd_limit: 14400, tpm_limit: 6000, tpd_limit: 500000, daily_reset_hour: 0, daily_reset_tz: 'UTC' },
  { provider: 'cerebras', rpm_limit: 30, rpd_limit: 14400, tpm_limit: 64000, tpd_limit: 1000000, daily_reset_hour: 0, daily_reset_tz: 'UTC' },
  { provider: 'google-ai', rpm_limit: 10, rpd_limit: 250, tpm_limit: 250000, tpd_limit: null, daily_reset_hour: 0, daily_reset_tz: 'America/Los_Angeles' },
  { provider: 'openrouter', rpm_limit: 20, rpd_limit: 50, tpm_limit: null, tpd_limit: null, daily_reset_hour: 0, daily_reset_tz: 'UTC' },
];

function createTracker() {
  return new FreeQuotaTracker(limits);
}

function getAvailableProviderNames(tracker) {
  return tracker.getAvailableProviders().map(entry => entry.provider);
}

function resetMinuteWindow(tracker, provider) {
  const state = tracker.providers.get(provider);
  state.minute_resets_at = Date.now();
  tracker.tick();
}

describe('FreeQuotaTracker free-tier overflow integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('full lifecycle: submit, hit 429, cooldown, recover', () => {
    const tracker = createTracker();

    expect(getAvailableProviderNames(tracker)).toHaveLength(4);

    tracker.recordUsage('groq', 500);

    expect(tracker.getStatus().groq.minute_requests).toBe(1);

    tracker.recordRateLimit('groq', 60);

    expect(tracker.canSubmit('groq')).toBe(false);

    const availableDuringCooldown = getAvailableProviderNames(tracker);
    expect(availableDuringCooldown).toHaveLength(3);
    expect(availableDuringCooldown).not.toContain('groq');

    vi.advanceTimersByTime(61000);

    expect(tracker.canSubmit('groq')).toBe(true);
    expect(getAvailableProviderNames(tracker)).toHaveLength(4);
  });

  it('load balances across providers by remaining quota', () => {
    const tracker = createTracker();

    for (let i = 0; i < 25; i += 1) {
      if (i === 20) {
        resetMinuteWindow(tracker, 'openrouter');
      }

      tracker.recordUsage('openrouter', 10);
    }

    const available = tracker.getAvailableProviders();

    expect(available[0].provider).not.toBe('openrouter');
    expect(available[available.length - 1].provider).toBe('openrouter');
  });

  it('all providers exhausted returns empty', () => {
    const tracker = createTracker();

    for (const provider of ['groq', 'cerebras', 'google-ai', 'openrouter']) {
      tracker.recordRateLimit(provider, 120);
    }

    expect(tracker.getAvailableProviders()).toHaveLength(0);
  });

  it('mixed cooldown and quota exhaustion', () => {
    const tracker = createTracker();

    tracker.recordRateLimit('groq', 60);

    for (let i = 0; i < 50; i += 1) {
      if (i > 0 && i % 20 === 0) {
        resetMinuteWindow(tracker, 'openrouter');
      }

      tracker.recordUsage('openrouter', 10);
    }

    const availableProviders = getAvailableProviderNames(tracker);

    expect(availableProviders).toHaveLength(2);
    expect(availableProviders).toEqual(expect.arrayContaining(['cerebras', 'google-ai']));
  });

  it('exponential backoff progression', () => {
    const tracker = createTracker();

    tracker.recordRateLimit('groq', null);
    expect(tracker.getStatus().groq.cooldown_remaining_seconds).toBe(30);

    vi.advanceTimersByTime(31000);
    tracker.recordRateLimit('groq', null);
    expect(tracker.getStatus().groq.cooldown_remaining_seconds).toBe(60);

    vi.advanceTimersByTime(61000);
    tracker.recordRateLimit('groq', null);
    expect(tracker.getStatus().groq.cooldown_remaining_seconds).toBe(120);

    vi.advanceTimersByTime(121000);
    tracker.recordRateLimit('groq', null);
    expect(tracker.getStatus().groq.cooldown_remaining_seconds).toBe(300);

    vi.advanceTimersByTime(301000);
    tracker.recordRateLimit('groq', null);
    expect(tracker.getStatus().groq.cooldown_remaining_seconds).toBe(300);
  });
});

describe('queue-scheduler free-tier overflow slot gating', () => {
  let scheduler;
  let mockDb;
  let mockTracker;
  let safeConfigInt;
  let safeStartTask;

  function makeTask(overrides = {}) {
    return {
      id: overrides.id || 'task-' + Math.random().toString(36).slice(2, 10),
      provider: overrides.provider || 'codex',
      status: overrides.status || 'queued',
      model: overrides.model || null,
      task_description: overrides.task_description || 'Write unit tests for scheduler',
      metadata: overrides.metadata !== undefined
        ? overrides.metadata
        : JSON.stringify({ smart_routing: true, complexity: 'normal' }),
      ...overrides,
    };
  }

  function configureScheduler({ runningCodexCount = 0, maxCodexConcurrent = 2, queuedTasks = [] } = {}) {
    const runningTasks = Array.from({ length: runningCodexCount }, (_, index) =>
      makeTask({
        id: `running-codex-${index}`,
        provider: 'codex',
        status: 'running',
        metadata: JSON.stringify({ complexity: 'normal' }),
      })
    );

    safeConfigInt.mockImplementation((key, defaultVal) => {
      if (key === 'max_concurrent') return 20;
      if (key === 'max_per_host') return 4;
      if (key === 'max_codex_concurrent') return maxCodexConcurrent;
      if (key === 'max_ollama_concurrent') return 8;
      if (key === 'max_api_concurrent') return 4;
      return defaultVal;
    });

    mockDb.getRunningCount.mockReturnValue(runningTasks.length);
    mockDb.listQueuedTasksLightweight.mockReturnValue(queuedTasks);
    mockDb.listTasks.mockImplementation(({ status }) => {
      if (status === 'running') return runningTasks;
      if (status === 'queued') return queuedTasks;
      return [];
    });
    mockDb.getConfig.mockImplementation((key) => {
      if (key === 'codex_enabled') return '1';
      if (key === 'free_tier_auto_scale_enabled') return 'true';
      if (key === 'free_tier_cooldown_seconds') return '0';
      if (key === 'codex_overflow_to_local') return '0';
      return null;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();

    const modPath = require.resolve('../execution/queue-scheduler');
    delete require.cache[modPath];
    scheduler = require('../execution/queue-scheduler');

    mockTracker = {
      getAvailableProviders: vi.fn().mockReturnValue([
        { provider: 'groq', dailyRemainingPct: 0.9 },
      ]),
      getAvailableProvidersSmart: vi.fn().mockReturnValue([
        { provider: 'groq', score: 0.95, dailyRemainingPct: 0.9 },
      ]),
    };

    mockDb = {
      getRunningCount: vi.fn().mockReturnValue(0),
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
      listTasks: vi.fn().mockReturnValue([]),
      listQueuedTasksLightweight: vi.fn().mockReturnValue([]),
      listOllamaHosts: vi.fn().mockReturnValue([]),
      getConfig: vi.fn().mockReturnValue(null),
      selectOllamaHostForModel: vi.fn().mockReturnValue({ host: null, reason: 'no host' }),
      updateTaskStatus: vi.fn(),
      getNextQueuedTask: vi.fn().mockReturnValue(null),
      resetExpiredBudgets: vi.fn(),
      checkApprovalRequired: vi.fn().mockReturnValue({ required: false, status: 'not_required', rule: null }),
    };

    safeStartTask = vi.fn().mockReturnValue(true);
    safeConfigInt = vi.fn();

    scheduler.init({
      db: mockDb,
      safeStartTask,
      safeConfigInt,
      isLargeModelBlockedOnHost: vi.fn().mockReturnValue({ blocked: false }),
      getFreeQuotaTracker: vi.fn().mockReturnValue(mockTracker),
      cleanupOrphanedRetryTimeouts: vi.fn(),
    });

    const originalProcess = scheduler.processQueueInternal;
    scheduler.processQueueInternal = (options = {}) => originalProcess({
      skipRecentProcessGuard: true,
      ...options,
    });
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('does NOT overflow when Codex still has available slots', () => {
    configureScheduler({
      runningCodexCount: 1,
      maxCodexConcurrent: 3,
      queuedTasks: [
        makeTask({ id: 'codex-open-1' }),
        makeTask({ id: 'codex-open-2' }),
      ],
    });

    scheduler.processQueueInternal();

    expect(safeStartTask).toHaveBeenCalledWith('codex-open-1', 'codex');
    expect(safeStartTask).toHaveBeenCalledWith('codex-open-2', 'codex');
    expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    expect(mockTracker.getAvailableProvidersSmart).not.toHaveBeenCalled();
  });

  it('does overflow when all Codex slots are already full', () => {
    configureScheduler({
      runningCodexCount: 2,
      maxCodexConcurrent: 2,
      queuedTasks: [
        makeTask({ id: 'codex-full-1' }),
      ],
    });

    scheduler.processQueueInternal();

    expect(safeStartTask).not.toHaveBeenCalled();
    expect(mockTracker.getAvailableProvidersSmart).toHaveBeenCalledTimes(1);

    const rerouteCall = mockDb.updateTaskStatus.mock.calls.find(
      (call) => call[0] === 'codex-full-1' && call[2]?.provider === 'groq'
    );
    expect(rerouteCall).toBeTruthy();

    const metadata = JSON.parse(rerouteCall[2].metadata);
    expect(metadata.original_provider).toBe('codex');
    expect(metadata.free_tier_overflow).toBe(true);
    expect(metadata.free_tier_auto_scale).toBe(true);
  });

  it('never overflows tasks with user_provider_override', () => {
    configureScheduler({
      runningCodexCount: 2,
      maxCodexConcurrent: 2,
      queuedTasks: [
        makeTask({
          id: 'codex-user-locked',
          metadata: JSON.stringify({
            smart_routing: true,
            complexity: 'normal',
            user_provider_override: true,
          }),
        }),
      ],
    });

    scheduler.processQueueInternal();

    expect(safeStartTask).not.toHaveBeenCalled();
    expect(mockDb.updateTaskStatus).not.toHaveBeenCalled();
    expect(mockTracker.getAvailableProvidersSmart).not.toHaveBeenCalled();
  });
});
