import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const REGISTRY_PATH = require.resolve('../providers/registry');
const LOGGER_PATH = require.resolve('../logger');
const CONFIG_PATH = require.resolve('../config');
const TRACKED_ENV_KEYS = [
  'UNIT_TEST_PROVIDER_API_KEY',
  'CLAUDE_CLI_API_KEY',
  'ANTHROPIC_API_KEY',
];
const ORIGINAL_CACHE_ENTRIES = new Map([
  [LOGGER_PATH, require.cache[LOGGER_PATH]],
  [CONFIG_PATH, require.cache[CONFIG_PATH]],
]);

function createHarness() {
  const loggerInstance = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };

  return {
    loggerInstance,
    loggerModule: {
      child: vi.fn(() => loggerInstance),
    },
    configModule: {
      get: vi.fn(() => null),
      getApiKey: vi.fn(() => null),
      init: vi.fn(),
    },
  };
}

function installMock(resolvedPath, exportsValue) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsValue,
  };
}

function restoreModuleCache() {
  delete require.cache[REGISTRY_PATH];

  for (const [resolvedPath, originalEntry] of ORIGINAL_CACHE_ENTRIES.entries()) {
    if (originalEntry) require.cache[resolvedPath] = originalEntry;
    else delete require.cache[resolvedPath];
  }
}

function loadRegistry() {
  const harness = createHarness();

  installMock(LOGGER_PATH, harness.loggerModule);
  installMock(CONFIG_PATH, harness.configModule);
  delete require.cache[REGISTRY_PATH];

  return {
    registry: require('../providers/registry'),
    ...harness,
  };
}

describe('Provider Registry', () => {
  let registry;
  let loggerInstance;
  let loggerModule;
  let configModule;
  let originalEnv;

  beforeEach(() => {
    vi.resetModules();
    restoreModuleCache();

    originalEnv = {};
    for (const key of TRACKED_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }

    ({ registry, loggerInstance, loggerModule, configModule } = loadRegistry());
  });

  afterEach(() => {
    restoreModuleCache();

    for (const key of TRACKED_ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }

    vi.restoreAllMocks();
  });

  describe('module bootstrap', () => {
    it('creates a child logger scoped to the provider registry', () => {
      expect(loggerModule.child).toHaveBeenCalledTimes(1);
      expect(loggerModule.child).toHaveBeenCalledWith({ component: 'provider-registry' });
    });
  });

  describe('PROVIDER_CATEGORIES', () => {
    it('defines the expected top-level categories', () => {
      expect(Object.keys(registry.PROVIDER_CATEGORIES)).toEqual(['ollama', 'codex', 'api', 'system']);
    });

    it('includes all local ollama providers in the ollama category', () => {
      expect(registry.PROVIDER_CATEGORIES.ollama).toEqual([
        'ollama',
      ]);
    });

    it('includes all local CLI providers in the codex category', () => {
      expect(registry.PROVIDER_CATEGORIES.codex).toEqual(['codex', 'codex-spark', 'claude-cli']);
    });

    it('includes all cloud providers in the api category', () => {
      expect(registry.PROVIDER_CATEGORIES.api).toEqual([
        'anthropic',
        'groq',
        'hyperbolic',
        'deepinfra',
        'ollama-cloud',
        'cerebras',
        'google-ai',
        'openrouter',
      ]);
    });

    it('assigns every provider to exactly one category', () => {
      const flattened = Object.values(registry.PROVIDER_CATEGORIES).flat();

      expect(new Set(flattened).size).toBe(flattened.length);
    });

    it('keeps local and cloud providers separated by category', () => {
      const localProviders = [
        ...registry.PROVIDER_CATEGORIES.ollama,
        ...registry.PROVIDER_CATEGORIES.codex,
      ];

      for (const provider of localProviders) {
        expect(registry.PROVIDER_CATEGORIES.api).not.toContain(provider);
      }
    });

    it('exports ALL_PROVIDERS as the flattened category set', () => {
      const flattened = Object.values(registry.PROVIDER_CATEGORIES).flat();

      expect([...registry.ALL_PROVIDERS].sort()).toEqual(flattened.sort());
    });

    it('exports CATEGORY_BY_PROVIDER entries for every known provider', () => {
      for (const [category, providers] of Object.entries(registry.PROVIDER_CATEGORIES)) {
        for (const provider of providers) {
          expect(registry.CATEGORY_BY_PROVIDER.get(provider)).toBe(category);
        }
      }
    });
  });

  describe('category helpers', () => {
    it('returns ollama for all ollama-family providers', () => {
      for (const provider of registry.PROVIDER_CATEGORIES.ollama) {
        expect(registry.getCategory(provider)).toBe('ollama');
      }
    });

    it('returns codex for all codex-family providers', () => {
      for (const provider of registry.PROVIDER_CATEGORIES.codex) {
        expect(registry.getCategory(provider)).toBe('codex');
      }
    });

    it('returns api for all cloud providers', () => {
      for (const provider of registry.PROVIDER_CATEGORIES.api) {
        expect(registry.getCategory(provider)).toBe('api');
      }
    });

    it('returns null for unknown, empty, and undefined providers', () => {
      expect(registry.getCategory('does-not-exist')).toBeNull();
      expect(registry.getCategory('')).toBeNull();
      expect(registry.getCategory(undefined)).toBeNull();
    });

    it('identifies only ollama-family providers as ollama providers', () => {
      for (const provider of registry.ALL_PROVIDERS) {
        expect(registry.isOllamaProvider(provider)).toBe(
          registry.PROVIDER_CATEGORIES.ollama.includes(provider)
        );
      }
    });

    it('identifies only codex-family providers as codex providers', () => {
      for (const provider of registry.ALL_PROVIDERS) {
        expect(registry.isCodexProvider(provider)).toBe(
          registry.PROVIDER_CATEGORIES.codex.includes(provider)
        );
      }
    });

    it('identifies only cloud providers as api providers', () => {
      for (const provider of registry.ALL_PROVIDERS) {
        expect(registry.isApiProvider(provider)).toBe(
          registry.PROVIDER_CATEGORIES.api.includes(provider)
        );
      }
    });

    it('reports all built-in providers as known and unknown values as unknown', () => {
      for (const provider of registry.ALL_PROVIDERS) {
        expect(registry.isKnownProvider(provider)).toBe(true);
      }

      expect(registry.isKnownProvider('unit-test-provider')).toBe(false);
      expect(registry.isKnownProvider(null)).toBe(false);
    });

    it('makes the category predicates mutually exclusive for every known provider', () => {
      for (const provider of registry.ALL_PROVIDERS) {
        const matches = [
          registry.isOllamaProvider(provider),
          registry.isCodexProvider(provider),
          registry.isApiProvider(provider),
          typeof registry.isSystemProvider === 'function' ? registry.isSystemProvider(provider) : false,
        ].filter(Boolean);

        expect(matches.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('returns the registered ollama providers for the ollama category', () => {
      expect(registry.getProvidersInCategory('ollama')).toBe(registry.PROVIDER_CATEGORIES.ollama);
    });

    it('returns the registered codex providers for the codex category', () => {
      expect(registry.getProvidersInCategory('codex')).toBe(registry.PROVIDER_CATEGORIES.codex);
    });

    it('returns the registered cloud providers for the api category', () => {
      expect(registry.getProvidersInCategory('api')).toBe(registry.PROVIDER_CATEGORIES.api);
    });

    it('returns an empty array for unknown categories', () => {
      expect(registry.getProvidersInCategory('local')).toEqual([]);
      expect(registry.getProvidersInCategory('missing')).toEqual([]);
    });
  });

  describe('provider registration and lookup', () => {
    it('returns null and warns when looking up an unregistered provider', () => {
      expect(registry.getProviderInstance('missing-provider')).toBeNull();
      expect(loggerInstance.warn).toHaveBeenCalledWith(
        '[registry] No constructor registered for provider "missing-provider"'
      );
    });

    it('registers a provider class without instantiating it immediately', () => {
      let constructCount = 0;

      class MockProvider {
        constructor(options) {
          constructCount += 1;
          this.options = options;
        }
      }

      registry.registerProviderClass('unit-test-provider', MockProvider);

      expect(constructCount).toBe(0);
    });

    it('lazy-initializes a provider on first lookup and caches the instance', () => {
      let constructCount = 0;

      class MockProvider {
        constructor(options) {
          constructCount += 1;
          this.options = options;
        }
      }

      registry.registerProviderClass('unit-test-provider', MockProvider);

      const first = registry.getProviderInstance('unit-test-provider');
      const second = registry.getProviderInstance('unit-test-provider');

      expect(first).toBeInstanceOf(MockProvider);
      expect(second).toBe(first);
      expect(constructCount).toBe(1);
    });

    it('dispatches lookups to the constructor registered for each provider name', () => {
      class ApiProvider {
        constructor() {
          this.kind = 'api';
        }
      }

      class CliProvider {
        constructor() {
          this.kind = 'cli';
        }
      }

      registry.registerProviderClass('anthropic', ApiProvider);
      registry.registerProviderClass('codex', CliProvider);

      expect(registry.getProviderInstance('anthropic')).toBeInstanceOf(ApiProvider);
      expect(registry.getProviderInstance('codex')).toBeInstanceOf(CliProvider);
    });

    it('supports registering custom providers that are not in the built-in category map', () => {
      class CustomProvider {}

      expect(registry.isKnownProvider('unit-test-provider')).toBe(false);

      registry.registerProviderClass('unit-test-provider', CustomProvider);

      expect(registry.getProviderInstance('unit-test-provider')).toBeInstanceOf(CustomProvider);
    });

    it('resolves API keys via serverConfig.getApiKey', () => {
      class MockProvider {
        constructor(options) {
          this.options = options;
        }
      }

      configModule.getApiKey.mockReturnValue('resolved-key');
      registry.registerProviderClass('unit-test-provider', MockProvider);

      const instance = registry.getProviderInstance('unit-test-provider');

      expect(configModule.getApiKey).toHaveBeenCalledWith('unit-test-provider');
      expect(instance.options).toEqual({ apiKey: 'resolved-key' });
    });

    it('passes null apiKey when getApiKey returns null', () => {
      class MockProvider {
        constructor(options) {
          this.options = options;
        }
      }

      configModule.getApiKey.mockReturnValue(null);
      registry.registerProviderClass('anthropic', MockProvider);

      const instance = registry.getProviderInstance('anthropic');

      expect(configModule.getApiKey).toHaveBeenCalledWith('anthropic');
      expect(instance.options).toEqual({ apiKey: null });
    });

    it('passes the provider name directly to getApiKey for hyphenated names', () => {
      class MockProvider {
        constructor(options) {
          this.options = options;
        }
      }

      configModule.getApiKey.mockReturnValue('hyphenated-key');
      registry.registerProviderClass('claude-cli', MockProvider);

      const instance = registry.getProviderInstance('claude-cli');

      expect(configModule.getApiKey).toHaveBeenCalledWith('claude-cli');
      expect(instance.options).toEqual({ apiKey: 'hyphenated-key' });
    });

    it('preserves provider instance state such as enabled flags for caller-side checks', () => {
      class DisabledProvider {
        constructor() {
          this.enabled = false;
        }
      }

      registry.registerProviderClass('anthropic', DisabledProvider);

      expect(registry.getProviderInstance('anthropic')).toMatchObject({ enabled: false });
    });

    it('uses the latest registered constructor when re-registered before first lookup', () => {
      class FirstProvider {
        constructor() {
          this.source = 'first';
        }
      }

      class ReplacementProvider {
        constructor() {
          this.source = 'replacement';
        }
      }

      registry.registerProviderClass('anthropic', FirstProvider);
      registry.registerProviderClass('anthropic', ReplacementProvider);

      expect(registry.getProviderInstance('anthropic')).toMatchObject({ source: 'replacement' });
    });

    it('keeps returning the cached instance until resetInstances is called', () => {
      class FirstProvider {
        constructor() {
          this.source = 'first';
        }
      }

      class ReplacementProvider {
        constructor() {
          this.source = 'replacement';
        }
      }

      registry.registerProviderClass('anthropic', FirstProvider);
      const first = registry.getProviderInstance('anthropic');

      registry.registerProviderClass('anthropic', ReplacementProvider);
      const second = registry.getProviderInstance('anthropic');

      expect(first).toBe(second);
      expect(second).toMatchObject({ source: 'first' });
    });

    it('resetInstances clears the cache but keeps constructor registrations intact', () => {
      let constructCount = 0;

      class MockProvider {
        constructor() {
          constructCount += 1;
        }
      }

      registry.registerProviderClass('anthropic', MockProvider);

      registry.getProviderInstance('anthropic');
      registry.resetInstances();
      registry.getProviderInstance('anthropic');

      expect(constructCount).toBe(2);
    });

    it('resetInstances clears cached instances for multiple providers independently', () => {
      let apiConstructCount = 0;
      let cliConstructCount = 0;

      class ApiProvider {
        constructor() {
          apiConstructCount += 1;
        }
      }

      class CliProvider {
        constructor() {
          cliConstructCount += 1;
        }
      }

      registry.registerProviderClass('anthropic', ApiProvider);
      registry.registerProviderClass('codex', CliProvider);

      registry.getProviderInstance('anthropic');
      registry.getProviderInstance('codex');
      registry.resetInstances();
      registry.getProviderInstance('anthropic');
      registry.getProviderInstance('codex');

      expect(apiConstructCount).toBe(2);
      expect(cliConstructCount).toBe(2);
    });

    it('allows resetInstances to be called even when nothing has been constructed yet', () => {
      expect(() => registry.resetInstances()).not.toThrow();
    });
  });

  describe('init', () => {
    it('forwards the database dependency to server config initialization', () => {
      const db = { getConfig: vi.fn() };

      registry.init({ db });

      expect(configModule.init).toHaveBeenCalledWith({ db });
    });

    it('accepts an empty dependency object and forwards an undefined db', () => {
      expect(() => registry.init({})).not.toThrow();
      expect(configModule.init).toHaveBeenCalledWith({ db: undefined });
    });
  });
});
