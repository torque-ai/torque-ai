'use strict';

const CORE_MODULE_PATH = require.resolve('../db/provider-routing-core');
const LOGGER_MODULE_PATH = require.resolve('../logger');
const DATABASE_MODULE_PATH = require.resolve('../database');
const CONFIG_MODULE_PATH = require.resolve('../config');
const PROVIDER_CAPABILITIES_MODULE_PATH = require.resolve('../db/provider-capabilities');
const PROVIDER_PERFORMANCE_MODULE_PATH = require.resolve('../db/provider-performance');

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function createProviderMap(overrides = {}) {
  const providers = {
    codex: {
      provider: 'codex',
      enabled: 1,
      priority: 10,
      transport: null,
      quota_error_patterns: '["429","quota exceeded"]',
    },
    'claude-cli': {
      provider: 'claude-cli',
      enabled: 1,
      priority: 20,
      transport: null,
      quota_error_patterns: '["rate limit"]',
    },
    anthropic: {
      provider: 'anthropic',
      enabled: 1,
      priority: 30,
      transport: 'api',
      quota_error_patterns: '[]',
    },
    groq: {
      provider: 'groq',
      enabled: 1,
      priority: 40,
      transport: 'api',
      quota_error_patterns: '[]',
    },
    hyperbolic: {
      provider: 'hyperbolic',
      enabled: 1,
      priority: 50,
      transport: 'api',
      quota_error_patterns: '[]',
    },
    deepinfra: {
      provider: 'deepinfra',
      enabled: 1,
      priority: 60,
      transport: 'api',
      quota_error_patterns: '[]',
    },
    ollama: {
      provider: 'ollama',
      enabled: 1,
      priority: 70,
      transport: 'api',
      quota_error_patterns: '[]',
    },
    'hashline-ollama': {
      provider: 'hashline-ollama',
      enabled: 1,
      priority: 90,
      transport: 'api',
      quota_error_patterns: '[]',
    },
    'ollama-cloud': {
      provider: 'ollama-cloud',
      enabled: 1,
      priority: 100,
      transport: 'api',
      quota_error_patterns: '[]',
    },
  };

  for (const [providerId, partial] of Object.entries(overrides)) {
    providers[providerId] = {
      enabled: 1,
      priority: 999,
      transport: 'api',
      quota_error_patterns: '[]',
      ...(providers[providerId] || {}),
      ...partial,
      provider: providerId,
    };
  }

  return providers;
}

function createDbHarness(overrides = {}) {
  const state = {
    config: new Map(
      Object.entries({
        smart_routing_enabled: '1',
        default_provider: 'codex',
        smart_routing_default_provider: 'hashline-ollama',
        ollama_fallback_provider: 'codex',
        ...overrides.config,
      }),
    ),
    providers: new Map(Object.entries(createProviderMap(overrides.providers))),
    rules: (overrides.rules || []).map((rule) => ({
      enabled: 1,
      priority: 50,
      ...rule,
    })),
  };

  const db = {
    prepare(sql) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      if (normalizedSql === 'SELECT value FROM config WHERE key = ?') {
        return {
          get(key) {
            return state.config.has(key) ? { value: state.config.get(key) } : undefined;
          },
        };
      }

      if (normalizedSql === 'SELECT * FROM provider_config WHERE provider = ?') {
        return {
          get(providerId) {
            return cloneValue(state.providers.get(providerId));
          },
        };
      }

      if (normalizedSql.startsWith('SELECT * FROM routing_rules WHERE 1=1')) {
        return {
          all(...params) {
            let index = 0;
            let rules = [...state.rules];

            if (normalizedSql.includes('AND enabled = ?')) {
              const enabled = params[index];
              index += 1;
              rules = rules.filter((rule) => (rule.enabled ? 1 : 0) === enabled);
            }

            if (normalizedSql.includes('AND rule_type = ?')) {
              const ruleType = params[index];
              rules = rules.filter((rule) => rule.rule_type === ruleType);
            }

            return rules
              .sort((left, right) => (left.priority || 0) - (right.priority || 0))
              .map((rule) => cloneValue(rule));
          },
        };
      }

      throw new Error(`Unhandled SQL in slot-pull-routing test double: ${normalizedSql}`);
    },
    getConfig(key) {
      return state.config.get(key) || null;
    },
  };

  return { db, state };
}

function resetModuleCache() {
  delete require.cache[CORE_MODULE_PATH];
  delete require.cache[LOGGER_MODULE_PATH];
  delete require.cache[DATABASE_MODULE_PATH];
  delete require.cache[CONFIG_MODULE_PATH];
  delete require.cache[PROVIDER_CAPABILITIES_MODULE_PATH];
  delete require.cache[PROVIDER_PERFORMANCE_MODULE_PATH];
}

function loadCore(overrides = {}) {
  const loggerChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const loggerMock = {
    child: vi.fn(() => loggerChild),
  };
  const { db } = createDbHarness(overrides.db);
  const databaseModuleMock = {
    getDbInstance: vi.fn(() => db),
  };

  vi.resetModules();
  resetModuleCache();
  installCjsModuleMock('../logger', loggerMock);
  installCjsModuleMock('../database', databaseModuleMock);

  const serverConfigMock = require('../config');
  serverConfigMock.init({ db });
  installCjsModuleMock('../config', serverConfigMock);

  const core = require('../db/provider-routing-core');
  core.setDb(db);
  core.setGetTask(() => null);
  core.setHostManagement(overrides.hostManagement || null);
  core.setOllamaHealthy(true);

  return { core };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  resetModuleCache();
});

describe('slot-pull routing tier lists', () => {
  it('returns eligible_providers array when tierList=true', () => {
    const { core } = loadCore();

    const result = core.analyzeTaskForRouting('Create a new API handler', 'C:/repo', [], {
      tierList: true,
    });

    expect(result.provider).toBe('hashline-ollama');
    expect(result.eligible_providers).toEqual(expect.any(Array));
    expect(result.eligible_providers.length).toBeGreaterThan(0);
    expect(result.eligible_providers).toContain('codex');
  });

  it('still returns single provider when tierList=false', () => {
    const { core } = loadCore();

    const result = core.analyzeTaskForRouting('Create a new API handler', 'C:/repo');

    expect(result).toEqual({
      provider: 'hashline-ollama',
      rule: null,
      reason: 'No rule matched, using smart routing default: hashline-ollama',
    });
  });

  it('file creation tasks include the file_creation capability requirement', () => {
    const { core } = loadCore();

    const result = core.analyzeTaskForRouting('Create a new API handler', 'C:/repo', [], {
      tierList: true,
    });

    expect(result.capability_requirements).toContain('file_creation');
    expect(result.quality_tier).toBe('normal');
  });

  it('user override returns singleton eligible_providers', () => {
    const { core } = loadCore();

    const result = core.analyzeTaskForRouting('Coordinate task execution', 'C:/repo', [], {
      tierList: true,
      isUserOverride: true,
      overrideProvider: 'claude-cli',
    });

    expect(result.provider).toBe('claude-cli');
    expect(result.eligible_providers).toEqual(['claude-cli']);
  });
});
