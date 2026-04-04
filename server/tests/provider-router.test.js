import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('provider-router', () => {
  let providerRouter;
  let mockDb;
  let mockServerConfig;
  let mockProviderRegistry;
  let configValues;
  let boolValues;

  async function loadProviderRouter() {
    vi.resetModules();

    configValues = new Map();
    boolValues = new Map();

    mockDb = {
      getDefaultProvider: vi.fn().mockReturnValue('codex'),
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
    };

    providerRouter = await import('../execution/provider-router.js');
    providerRouter.init({
      db: mockDb,
      serverConfig: mockServerConfig,
      providerRegistry: mockProviderRegistry,
      parseTaskMetadata: vi.fn().mockReturnValue({}),
      safeUpdateTaskStatus: vi.fn(),
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
