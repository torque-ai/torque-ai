import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('provider-router', () => {
  let providerRouter;
  let mockDb;
  let mockServerConfig;
  let mockProviderRegistry;
  let mockParseTaskMetadata;
  let mockCircuitBreaker;
  let mockDefaultContainer;
  let configValues;
  let boolValues;

  async function loadProviderRouter() {
    vi.resetModules();

    configValues = new Map();
    boolValues = new Map();

    mockDb = {
      getDefaultProvider: vi.fn().mockReturnValue('codex'),
      patchTaskMetadata: vi.fn().mockReturnValue(true),
      isBudgetExceeded: vi.fn().mockReturnValue({ exceeded: false, warning: false }),
      listOllamaHosts: vi.fn().mockReturnValue([]),
    };

    mockServerConfig = {
      get: vi.fn((key) => configValues.get(key)),
      getBool: vi.fn((key) => boolValues.get(key) ?? false),
    };

    const providerCategories = {
      ollama: 'ollama',
      codex: 'codex',
      'claude-cli': 'codex',
      anthropic: 'api',
      groq: 'api',
      openrouter: 'api',
    };

    const providerGroups = {
      ollama: ['ollama'],
      codex: ['codex', 'claude-cli'],
      api: ['anthropic', 'groq', 'openrouter'],
    };

    mockProviderRegistry = {
      getCategory: vi.fn((provider) => providerCategories[provider] ?? null),
      getProvidersInCategory: vi.fn((category) => providerGroups[category] ?? []),
      isKnownProvider: vi.fn((provider) => Object.prototype.hasOwnProperty.call(providerCategories, provider)),
    };

    mockParseTaskMetadata = vi.fn().mockReturnValue({});
    mockCircuitBreaker = {
      allowRequest: vi.fn().mockReturnValue(true),
    };
    mockDefaultContainer = {
      has: vi.fn().mockReturnValue(false),
      get: vi.fn().mockReturnValue(mockCircuitBreaker),
    };

    providerRouter = await import('../execution/provider-router.js');
    providerRouter.init({
      db: mockDb,
      serverConfig: mockServerConfig,
      providerRegistry: mockProviderRegistry,
      parseTaskMetadata: mockParseTaskMetadata,
      safeUpdateTaskStatus: vi.fn(),
      defaultContainer: mockDefaultContainer,
    });
  }

  beforeEach(async () => {
    await loadProviderRouter();
  });

  describe('safeConfigInt', () => {
    it('returns default when config not available', () => {
      expect(providerRouter.safeConfigInt('missing_key', 7, 1, 20)).toBe(7);
    });

    it('returns configured value when valid', () => {
      configValues.set('max_concurrent', '12');

      expect(providerRouter.safeConfigInt('max_concurrent', 7, 1, 20)).toBe(12);
    });

    it('clamps to min/max bounds', () => {
      configValues.set('low_limit', '0');
      configValues.set('high_limit', '99');

      expect(providerRouter.safeConfigInt('low_limit', 7, 2, 20)).toBe(2);
      expect(providerRouter.safeConfigInt('high_limit', 7, 2, 20)).toBe(20);
    });

    it('honors 0-as-disabled when defaultVal is 0 (regression: queue_task_ttl_minutes silently clamping to 1)', () => {
      // When the registry default is 0 (meaning "disabled") and no override is set,
      // the resolved value MUST stay 0 — not get clamped up to minVal=1.
      // The queue_task_ttl_minutes key relies on this: 0 means "no expiry."
      // Before the fix, this returned 1 and silently auto-cancelled queued tasks
      // older than 1 minute.
      configValues.set('queue_task_ttl_minutes', '0');
      expect(providerRouter.safeConfigInt('queue_task_ttl_minutes', 0)).toBe(0);
    });

    it('still clamps positive values even when defaultVal is 0', () => {
      configValues.set('some_minutes', '5');
      // Caller didn't override minVal — gets the default minVal=1, which lets 5 through unchanged
      expect(providerRouter.safeConfigInt('some_minutes', 0)).toBe(5);
    });

    it('still clamps to minVal when defaultVal is non-zero (existing behavior unchanged)', () => {
      configValues.set('cap', '0');
      // defaultVal=7, value=0 → 0 is below minVal=2 → clamps to 2 (no 0-as-disabled here)
      expect(providerRouter.safeConfigInt('cap', 7, 2, 20)).toBe(2);
    });
  });

  describe('getEffectiveGlobalMaxConcurrent', () => {
    it('returns configured max_concurrent when auto_compute is off', () => {
      configValues.set('max_concurrent', '12');
      configValues.set('max_ollama_concurrent', '30');
      configValues.set('max_codex_concurrent', '30');
      configValues.set('max_api_concurrent', '30');
      boolValues.set('auto_compute_max_concurrent', false);

      expect(providerRouter.getEffectiveGlobalMaxConcurrent()).toBe(12);
    });

    it('returns max of configured and provider sum when auto_compute is on', () => {
      configValues.set('max_concurrent', '5');
      configValues.set('max_ollama_concurrent', '8');
      configValues.set('max_codex_concurrent', '6');
      configValues.set('max_api_concurrent', '4');
      boolValues.set('auto_compute_max_concurrent', true);

      expect(providerRouter.getEffectiveGlobalMaxConcurrent()).toBe(18);
    });

    it('uses db.getEffectiveMaxConcurrent when available', () => {
      configValues.set('max_concurrent', '5');
      configValues.set('max_ollama_concurrent', '8');
      configValues.set('max_codex_concurrent', '6');
      configValues.set('max_api_concurrent', '4');
      boolValues.set('auto_compute_max_concurrent', true);
      mockDb.getEffectiveMaxConcurrent = vi.fn().mockReturnValue({ effectiveMaxConcurrent: 27 });

      expect(providerRouter.getEffectiveGlobalMaxConcurrent()).toBe(27);
      expect(mockDb.getEffectiveMaxConcurrent).toHaveBeenCalledWith(expect.objectContaining({
        configuredMaxConcurrent: 5,
        autoComputeMaxConcurrent: true,
        logger: expect.any(Object),
      }));
    });
  });

  describe('normalizeProviderOverride', () => {
    it('falls back to the default provider for empty or non-string input', () => {
      expect(providerRouter.normalizeProviderOverride({}, undefined, 'task-1')).toBe('codex');
      expect(providerRouter.normalizeProviderOverride({}, '   ', 'task-2')).toBe('codex');
    });

    it('lowercases and trims provider name', () => {
      expect(providerRouter.normalizeProviderOverride({}, '  Ollama-Cloud  ', 'task-3')).toBe('ollama-cloud');
    });

    it('returns normalized unknown providers even when a registry is available', () => {
      expect(providerRouter.normalizeProviderOverride({}, '  Custom-Provider  ', 'task-4')).toBe('custom-provider');
      expect(mockProviderRegistry.getCategory).not.toHaveBeenCalled();
    });
  });

  describe('buildProviderDecisionTrace', () => {
    it('records selected, fallback, and blocked candidates in a persisted-friendly shape', () => {
      const trace = providerRouter.buildProviderDecisionTrace(
        { original_provider: 'codex' },
        { user_provider_override: false, auto_routed: true },
        'codex',
        'ollama',
        {
          provider: 'ollama',
          role: 'fallback',
          reason: 'Fallback candidate because codex exceeded budget',
          cause: 'budget_exceeded',
          switchReason: 'codex -> ollama (budget exceeded)',
        },
        [
          { provider: 'codex', role: 'primary', reason: 'Requested/default provider', cause: 'requested_provider' },
          { provider: 'ollama', role: 'fallback', reason: 'Fallback candidate because codex exceeded budget', cause: 'budget_exceeded', switchReason: 'codex -> ollama (budget exceeded)' },
        ],
        new Set(['codex']),
        'codex -> ollama (budget exceeded)',
      );

      expect(trace).toEqual(expect.objectContaining({
        version: 1,
        selected_provider: 'ollama',
        chosen_provider: 'ollama',
        requested_provider: 'codex',
        original_provider: 'codex',
        user_provider_override: false,
        auto_routed: true,
        switch_reason: 'codex -> ollama (budget exceeded)',
        selected_candidate: expect.objectContaining({
          provider: 'ollama',
          role: 'fallback',
          selected: true,
        }),
      }));
      expect(trace.fallback_candidates).toEqual([
        expect.objectContaining({
          provider: 'ollama',
          role: 'fallback',
          cause: 'budget_exceeded',
        }),
      ]);
      expect(trace.blocked_candidates).toEqual([
        expect.objectContaining({
          provider: 'codex',
          blocked: true,
          blocked_reason: 'circuit_breaker_open',
        }),
      ]);
    });
  });

  describe('resolveProviderRouting', () => {
    it('persists provider decision trace metadata when budget routing falls back to ollama', () => {
      mockParseTaskMetadata.mockReturnValue({ smart_routing: true, auto_routed: true });
      mockDb.isBudgetExceeded.mockReturnValue({ exceeded: true, warning: false });
      mockDb.listOllamaHosts.mockReturnValue([{ id: 'host-1', enabled: true, status: 'healthy' }]);

      const task = {
        provider: 'codex',
        metadata: {},
        task_description: 'Write a docs update',
      };

      const result = providerRouter.resolveProviderRouting(task, 'task-budget');

      expect(result).toEqual(expect.objectContaining({
        provider: 'ollama',
        switchReason: 'codex -> ollama (budget exceeded)',
        decisionTrace: expect.objectContaining({
          selected_provider: 'ollama',
          requested_provider: 'codex',
          user_provider_override: false,
        }),
      }));
      expect(mockDb.patchTaskMetadata).toHaveBeenCalledWith('task-budget', expect.objectContaining({
        requested_provider: 'codex',
        intended_provider: 'ollama',
        _provider_switch_reason: 'codex -> ollama (budget exceeded)',
        provider_decision_trace: expect.objectContaining({
          selected_provider: 'ollama',
          requested_provider: 'codex',
          switch_reason: 'codex -> ollama (budget exceeded)',
          fallback_candidates: [
            expect.objectContaining({
              provider: 'ollama',
              role: 'fallback',
            }),
          ],
          blocked_candidates: [],
        }),
      }));
      expect(task.metadata).toEqual(expect.objectContaining({
        requested_provider: 'codex',
        intended_provider: 'ollama',
        provider_decision_trace: expect.objectContaining({
          selected_provider: 'ollama',
        }),
      }));
    });

    it('records blocked candidates when the circuit breaker skips a fallback provider', () => {
      mockDb.isBudgetExceeded.mockReturnValue({ exceeded: true, warning: false });
      mockDb.listOllamaHosts.mockReturnValue([{ id: 'host-1', enabled: true, status: 'healthy' }]);
      mockDefaultContainer.has.mockReturnValue(true);
      mockCircuitBreaker.allowRequest.mockImplementation((provider) => provider !== 'ollama');

      const task = {
        provider: 'codex',
        metadata: {},
        task_description: 'Patch a failing test',
      };

      const result = providerRouter.resolveProviderRouting(task, 'task-circuit');
      const persistedTrace = mockDb.patchTaskMetadata.mock.calls.at(-1)?.[1]?.provider_decision_trace;

      expect(result.provider).toBe('codex');
      expect(result.switchReason).toBeNull();
      expect(persistedTrace).toEqual(expect.objectContaining({
        selected_provider: 'codex',
        fallback_candidates: [
          expect.objectContaining({
            provider: 'ollama',
            role: 'fallback',
          }),
        ],
        blocked_candidates: [
          expect.objectContaining({
            provider: 'ollama',
            blocked: true,
            blocked_reason: 'circuit_breaker_open',
          }),
        ],
      }));
    });
  });

  describe('getProviderSlotLimits', () => {
    it('returns ollama limits for ollama provider', () => {
      configValues.set('max_ollama_concurrent', '11');

      expect(providerRouter.getProviderSlotLimits('ollama', { max_concurrent: '3' })).toEqual({
        providerLimit: 3,
        providerGroup: [],
        categoryLimit: 11,
        categoryProviderGroup: ['ollama'],
      });
    });

    it('returns codex limits for codex provider', () => {
      configValues.set('max_codex_concurrent', '9');

      expect(providerRouter.getProviderSlotLimits('codex', { max_concurrent: '4' })).toEqual({
        providerLimit: 4,
        providerGroup: [],
        categoryLimit: 9,
        categoryProviderGroup: ['codex', 'claude-cli'],
      });
    });

    it('returns api limits for api-category providers', () => {
      configValues.set('max_api_concurrent', '7');

      expect(providerRouter.getProviderSlotLimits('anthropic', { max_concurrent: '5' })).toEqual({
        providerLimit: 5,
        providerGroup: [],
        categoryLimit: 7,
        categoryProviderGroup: ['anthropic', 'groq', 'openrouter'],
      });
    });
  });

  describe('createProviderRouter', () => {
    it('returns object with all expected methods', () => {
      const router = providerRouter.createProviderRouter();
      const expectedKeys = [
        'init',
        'safeConfigInt',
        'tryReserveHostSlotWithFallback',
        'tryCreateAutoPR',
        'buildProviderDecisionTrace',
        'resolveProviderRouting',
        'normalizeProviderOverride',
        'failTaskForInvalidProvider',
        'getProviderSlotLimits',
        'getEffectiveGlobalMaxConcurrent',
      ];

      expect(Object.keys(router).sort()).toEqual(expectedKeys.slice().sort());
      for (const key of expectedKeys) {
        expect(router[key]).toEqual(expect.any(Function));
      }
    });
  });
});
