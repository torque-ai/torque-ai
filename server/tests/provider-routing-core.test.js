'use strict';

const { EventEmitter } = require('events');
const { TEST_MODELS } = require('./test-helpers');
const http = require('http');

const CORE_MODULE_PATH = require.resolve('../db/provider/routing-core');
const LOGGER_MODULE_PATH = require.resolve('../logger');
const CONFIG_MODULE_PATH = require.resolve('../config');
const CONFIG_CORE_MODULE_PATH = require.resolve('../db/config-core');
const SMART_ROUTING_MODULE_PATH = require.resolve('../db/smart-routing');
const OLLAMA_HEALTH_MODULE_PATH = require.resolve('../db/ollama-health');
const CATEGORY_CLASSIFIER_MODULE_PATH = require.resolve('../routing/category-classifier');
const TEMPLATE_STORE_MODULE_PATH = require.resolve('../routing/template-store');
const PROVIDER_QUOTAS_MODULE_PATH = require.resolve('../db/provider/quotas');

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
    'ollama': {
      provider: 'ollama',
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
        smart_routing_default_provider: 'ollama',
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
    tasks: new Map(
      Object.entries(overrides.tasks || {}).map(([taskId, task]) => [
        taskId,
        {
          provider: 'codex',
          status: 'queued',
          retry_count: 0,
          progress_percent: 0,
          ...task,
          id: taskId,
        },
      ]),
    ),
    failoverEvents: (overrides.failoverEvents || []).map((row) => ({ ...row })),
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

      if (normalizedSql === 'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)') {
        return {
          run(key, value) {
            state.config.set(key, String(value));
            return { changes: 1 };
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

      if (normalizedSql === 'SELECT * FROM provider_config ORDER BY priority ASC') {
        return {
          all() {
            return Array.from(state.providers.values())
              .sort((left, right) => (left.priority || 0) - (right.priority || 0))
              .map((provider) => cloneValue(provider));
          },
        };
      }

      if (normalizedSql === 'SELECT provider FROM provider_config WHERE enabled = 1 ORDER BY priority ASC LIMIT 1') {
        return {
          all() {
            return Array.from(state.providers.values())
              .filter((provider) => provider && provider.enabled)
              .sort((left, right) => (left.priority || 0) - (right.priority || 0))
              .slice(0, 1)
              .map((provider) => ({ provider: provider.provider }));
          },
        };
      }

      if (normalizedSql.startsWith('UPDATE provider_config SET ')) {
        return {
          run(...values) {
            const providerId = values[values.length - 1];
            const provider = state.providers.get(providerId);
            if (!provider) return { changes: 0 };

            const setClause = normalizedSql.match(/^UPDATE provider_config SET (.+) WHERE provider = \?$/)[1];
            const assignments = setClause.split(',').map((part) => part.trim().split(' = ')[0]);
            for (let i = 0; i < assignments.length; i += 1) {
              provider[assignments[i]] = values[i];
            }

            return { changes: 1 };
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

      if (normalizedSql.includes('SELECT DISTINCT to_provider FROM failover_events')) {
        return {
          all(taskId) {
            const seen = new Set();
            return state.failoverEvents
              .filter((row) => row.task_id === taskId)
              .filter((row) => row.to_provider && row.to_provider.trim() !== '')
              .filter((row) => {
                if (seen.has(row.to_provider)) return false;
                seen.add(row.to_provider);
                return true;
              })
              .map((row) => ({ to_provider: row.to_provider }));
          },
        };
      }

      if (normalizedSql.startsWith("UPDATE tasks SET status = 'pending_provider_switch'")) {
        return {
          run(suffix, taskId) {
            const task = state.tasks.get(taskId);
            if (!task) return { changes: 0 };

            task.status = 'pending_provider_switch';
            task.error_output = `${task.error_output || ''}${suffix}`;
            return { changes: 1 };
          },
        };
      }

      if (normalizedSql.startsWith("UPDATE tasks SET status = 'queued'")) {
        return {
          run(...args) {
            const [switchedAt, metadataJson, taskDescription, taskId] = args.length === 4
              ? args
              : [args[0], args[1], undefined, args[2]];
            const task = state.tasks.get(taskId);
            if (!task) return { changes: 0 };

            task.status = 'queued';
            task.original_provider = task.original_provider || task.provider;
            task.provider = null;
            task.provider_switched_at = switchedAt;
            task.retry_count = (task.retry_count || 0) + 1;
            task.started_at = null;
            task.completed_at = null;
            task.exit_code = null;
            task.pid = null;
            task.progress_percent = 0;
            task.model = null;
            task.ollama_host_id = null;
            task.metadata = JSON.parse(metadataJson);
            if (taskDescription !== undefined) {
              task.task_description = taskDescription;
            }
            return { changes: 1 };
          },
        };
      }

      if (normalizedSql.startsWith("UPDATE tasks SET status = 'failed'")) {
        return {
          run(completedAt, suffix, taskId) {
            const task = state.tasks.get(taskId);
            if (!task) return { changes: 0 };

            task.status = 'failed';
            task.completed_at = completedAt;
            task.error_output = `${task.error_output || ''}${suffix}`;
            return { changes: 1 };
          },
        };
      }

      throw new Error(`Unhandled SQL in provider-routing-core test double: ${normalizedSql}`);
    },
    // High-level config accessor for serverConfig.getApiKey() compatibility
    getConfig(key) {
      return state.config.get(key) || null;
    },
  };

  return { db, state };
}

function createHostManagement(overrides = {}) {
  return {
    determineTaskComplexity: vi.fn(() => 'normal'),
    routeTask: vi.fn(() => null),
    listOllamaHosts: vi.fn(() => []),
    hasHealthyOllamaHost: vi.fn(() => false),
    ...overrides,
  };
}

function resetModuleCache() {
  delete require.cache[CORE_MODULE_PATH];
  delete require.cache[LOGGER_MODULE_PATH];
  delete require.cache[CONFIG_MODULE_PATH];
  delete require.cache[CONFIG_CORE_MODULE_PATH];
  delete require.cache[SMART_ROUTING_MODULE_PATH];
  delete require.cache[OLLAMA_HEALTH_MODULE_PATH];
  delete require.cache[CATEGORY_CLASSIFIER_MODULE_PATH];
  delete require.cache[TEMPLATE_STORE_MODULE_PATH];
  delete require.cache[PROVIDER_QUOTAS_MODULE_PATH];
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
  const { db, state } = createDbHarness(overrides.db);

  vi.resetModules();
  resetModuleCache();
  installCjsModuleMock('../logger', loggerMock);

  const configCore = require('../db/config-core');
  configCore.setDb(db);
  configCore.clearConfigCache();

  // Install server/config.js mock that delegates getApiKey to the mock DB
  const serverConfigMock = require('../config');
  serverConfigMock.init({ db });
  installCjsModuleMock('../config', serverConfigMock);
  for (const [modulePath, exportsValue] of Object.entries(overrides.moduleMocks || {})) {
    installCjsModuleMock(modulePath, exportsValue);
  }

  const core = require('../db/provider/routing-core');
  core.setDb(db);
  core.setGetTask((taskId) => cloneValue(state.tasks.get(taskId)) || null);
  core.setHostManagement(overrides.hostManagement || null);
  const ollamaHealthOverride = Object.prototype.hasOwnProperty.call(overrides, 'ollamaHealthy')
    ? overrides.ollamaHealthy
    : true;
  // When null, skip setOllamaHealthy entirely so the internal cache stays in its
  // default uninitialized (stale) state — this lets tests exercise the host-management fallback path.
  if (ollamaHealthOverride !== null) {
    core.setOllamaHealthy(ollamaHealthOverride);
  }

  return {
    core,
    db,
    state,
    loggerChild,
  };
}

function makeRequestMock(statusCode = 200) {
  return vi.spyOn(http, 'get').mockImplementation((url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = vi.fn();
    process.nextTick(() => callback({ statusCode, resume: vi.fn() }));
    return req;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  resetModuleCache();
});

describe('provider-routing-core', () => {
  describe('provider CRUD and defaults', () => {
    it('normalizes provider transports and provider-specific defaults', () => {
      const { core } = loadCore();

      expect(core.normalizeProviderTransport(' Cli ', 'codex')).toBe('cli');
      expect(core.normalizeProviderTransport(undefined, 'codex')).toBe('hybrid');
      expect(core.normalizeProviderTransport(undefined, 'claude-cli')).toBe('cli');
      expect(core.normalizeProviderTransport(undefined, 'anthropic')).toBe('api');
    });

    it('enriches provider rows with parsed quota patterns and booleans', () => {
      const { core } = loadCore();

      const provider = core.enrichProviderRow({
        provider: 'codex',
        enabled: 1,
        transport: null,
        quota_error_patterns: '["429","quota"]',
      });

      expect(provider.enabled).toBe(true);
      expect(provider.transport).toBe('hybrid');
      expect(provider.quota_error_patterns).toEqual(['429', 'quota']);
    });

    it('falls back to an empty quota pattern list when provider JSON is invalid', () => {
      const { core } = loadCore();

      const provider = core.enrichProviderRow({
        provider: 'codex',
        enabled: 1,
        transport: 'hybrid',
        quota_error_patterns: '{broken',
      });

      expect(provider.quota_error_patterns).toEqual([]);
    });

    it('gets providers from the mocked db and preserves priority order in listProviders', () => {
      const { core } = loadCore({
        db: {
          providers: {
            codex: { priority: 30 },
            'claude-cli': { priority: 10 },
            anthropic: { priority: 20 },
          },
        },
      });

      expect(core.getProvider('codex')).toMatchObject({
        provider: 'codex',
        enabled: true,
        transport: 'hybrid',
      });

      expect(core.listProviders().slice(0, 3).map((provider) => provider.provider)).toEqual([
        'claude-cli',
        'anthropic',
        'codex',
      ]);
    });

    it('updates provider fields and serializes quota patterns', () => {
      const { core } = loadCore();

      const updated = core.updateProvider('codex', {
        enabled: 0,
        priority: 77,
        cli_path: '/tmp/codex',
        cli_args: '--json',
        max_concurrent: 6,
        quota_error_patterns: ['429', 'limit'],
        transport: 'api',
      });

      expect(updated).toMatchObject({
        provider: 'codex',
        enabled: false,
        priority: 77,
        cli_path: '/tmp/codex',
        cli_args: '--json',
        max_concurrent: 6,
        transport: 'api',
      });
      expect(updated.quota_error_patterns).toEqual(['429', 'limit']);
      expect(updated.updated_at).toEqual(expect.any(String));
    });

    it('rejects invalid transport values during provider updates', () => {
      const { core } = loadCore();
      expect(() => core.updateProvider('codex', { transport: 'sftp' })).toThrow(/invalid transport/i);
    });

    it('persists the default provider when the target is enabled', () => {
      const { core, state } = loadCore();

      expect(core.setDefaultProvider('claude-cli')).toBe('claude-cli');
      expect(core.getDefaultProvider()).toBe('claude-cli');
      expect(state.config.get('default_provider')).toBe('claude-cli');
    });

    it('rejects unknown or disabled default providers', () => {
      const { core } = loadCore({
        db: {
          providers: {
            anthropic: { enabled: 0 },
          },
        },
      });

      expect(() => core.setDefaultProvider('no-such-provider')).toThrow(/unknown provider/i);
      expect(() => core.setDefaultProvider('anthropic')).toThrow(/disabled/i);
    });
  });

  describe('analyzeTaskForRouting', () => {
    it('returns the configured default provider when smart routing is disabled', () => {
      const { core } = loadCore({
        db: {
          config: {
            smart_routing_enabled: '0',
            default_provider: 'claude-cli',
          },
        },
      });

      // 2026-05-03: analyzeTaskForRouting now also attaches the
      // routing_decision_trace to its result for downstream
      // observability. Use toMatchObject so the trace doesn't bust
      // these strict-equality assertions; the trace's own contract is
      // covered by tests/routing-trace.test.js.
      expect(core.analyzeTaskForRouting('Write docs', 'C:/repo')).toMatchObject({
        provider: 'claude-cli',
        rule: null,
        reason: 'Smart routing disabled',
      });
    });

    it('populates caller-provided routing trace without changing the default return shape', () => {
      const { core } = loadCore({
        db: {
          config: {
            smart_routing_enabled: '0',
            default_provider: 'claude-cli',
          },
        },
      });
      const trace = [];

      const result = core.analyzeTaskForRouting('Write docs', 'C:/repo', [], { trace });

      expect(result).toEqual({
        provider: 'claude-cli',
        rule: null,
        reason: 'Smart routing disabled',
      });
      expect(trace).toEqual([
        expect.objectContaining({
          stage: 'default_provider',
          to: 'claude-cli',
        }),
      ]);
    });

    it('attaches routing trace only when includeTrace is requested', () => {
      const { core } = loadCore({
        db: {
          config: {
            smart_routing_enabled: '0',
            default_provider: 'claude-cli',
          },
        },
      });
      const trace = [];

      const result = core.analyzeTaskForRouting('Write docs', 'C:/repo', [], {
        trace,
        includeTrace: true,
      });

      expect(result).toEqual({
        provider: 'claude-cli',
        rule: null,
        reason: 'Smart routing disabled',
        trace,
      });
      expect(result.trace).toBe(trace);
    });

    it('falls back to the first enabled provider when smart routing is disabled and the default is disabled', () => {
      const { core, loggerChild } = loadCore({
        db: {
          config: {
            smart_routing_enabled: '0',
            default_provider: 'codex',
          },
          providers: {
            codex: { enabled: 0, priority: 10 },
            'claude-cli': { enabled: 1, priority: 20 },
          },
        },
      });

      const result = core.analyzeTaskForRouting('Write docs', 'C:/repo');

      expect(result).toMatchObject({
        provider: 'claude-cli',
        rule: null,
        reason: 'Smart routing disabled',
      });
      expect(loggerChild.warn).toHaveBeenCalledWith(
        '[SmartRouting] Invalid provider resolved (codex) — falling back to claude-cli',
      );
    });

    it('routes security tasks to default provider (anthropic demoted to opt-in)', () => {
      const { core } = loadCore({
        db: {
          config: {
            anthropic_api_key: 'anthropic-key',
          },
        },
      });

      const result = core.analyzeTaskForRouting('Audit auth token handling for security issues', 'C:/repo');

      expect(result.provider).toBe('claude-cli');
      expect(result.reason).toContain('Security task routed to Claude CLI');
    });

    it('routes xaml tasks to default provider (anthropic demoted to opt-in)', () => {
      const { core } = loadCore({
        db: {
          config: {
            anthropic_api_key: 'anthropic-key',
          },
        },
      });

      const result = core.analyzeTaskForRouting('Adjust bindings', 'C:/repo', ['Views/MainWindow.xaml']);

      expect(result.provider).toBe('codex');
      expect(result.reason).toContain('XAML/WPF task routed to Codex');
    });

    it('routes complex reasoning tasks to deepinfra with the large-model reason', () => {
      const { core } = loadCore({
        db: {
          config: {
            deepinfra_api_key: 'deepinfra-key',
          },
        },
      });

      const result = core.analyzeTaskForRouting('Need deep analysis for the production root cause', 'C:/repo');

      expect(result.provider).toBe('deepinfra');
      expect(result.reason).toContain('large model');
    });

    it('routes reasoning tasks to hyperbolic when deepinfra is unavailable', () => {
      const { core } = loadCore({
        db: {
          config: {
            deepinfra_api_key: '',
            hyperbolic_api_key: 'hyperbolic-key',
          },
        },
      });

      const result = core.analyzeTaskForRouting('Analyze the architecture root cause', 'C:/repo');

      expect(result.provider).toBe('hyperbolic');
      expect(result.reason).toContain('DeepInfra unavailable');
    });

    it('routes documentation work to groq when configured', () => {
      const { core } = loadCore({
        db: {
          config: {
            groq_api_key: 'groq-key',
          },
        },
      });

      const result = core.analyzeTaskForRouting('Summarize module behavior for README docs', 'C:/repo');

      expect(result.provider).toBe('groq');
      expect(result.reason).toContain('documentation task');
    });

    it('uses host management routing and preserves the selected model and host', () => {
      const hostManagement = createHostManagement({
        determineTaskComplexity: vi.fn(() => 'complex'),
        routeTask: vi.fn(() => ({
          provider: 'ollama',
          hostId: 'desktop-17',
          model: 'qwen3:14b',
          rule: { name: 'capability-match' },
          fallbackApplied: false,
        })),
      });
      const { core } = loadCore({ hostManagement });

      const result = core.analyzeTaskForRouting('Implement a feature in src/service.js', 'C:/repo', [
        'src/service.js',
      ]);

      expect(hostManagement.determineTaskComplexity).toHaveBeenCalledWith(
        'Implement a feature in src/service.js',
        ['src/service.js'],
      );
      expect(hostManagement.routeTask).toHaveBeenCalledWith('complex');
      expect(result).toMatchObject({
        provider: 'ollama',
        complexity: 'complex',
        hostId: 'desktop-17',
        selectedHost: 'desktop-17',
        model: 'qwen3:14b',
      });
      expect(result.reason).toContain('Complexity-based routing');
    });

    it('upgrades targeted local edits to ollama', () => {
      const hostManagement = createHostManagement({
        determineTaskComplexity: vi.fn(() => 'normal'),
        routeTask: vi.fn(() => ({
          provider: 'ollama',
          hostId: 'host-local',
          model: TEST_MODELS.SMALL,
        })),
      });
      const { core } = loadCore({ hostManagement });

      const result = core.analyzeTaskForRouting('Add jsdoc comments to src/app.js', 'C:/repo', [
        'src/app.js',
      ]);

      expect(result.provider).toBe('ollama');
      expect(result.model).toBe(TEST_MODELS.SMALL);
      expect(result.reason).toContain('ollama');
    });

    it('keeps targeted codex edits on codex when no hashline cloud provider is configured', () => {
      const hostManagement = createHostManagement({
        determineTaskComplexity: vi.fn(() => 'simple'),
        routeTask: vi.fn(() => ({
          provider: 'codex',
          hostId: null,
          model: 'gpt-5.1',
        })),
      });
      const { core } = loadCore({ hostManagement });

      const result = core.analyzeTaskForRouting('Fix validation in src/api.ts and add jsdoc', 'C:/repo', [
        'src/api.ts',
      ]);

      expect(result.provider).toBe('codex');
      expect(result.model).toBe('gpt-5.1');
      expect(result.reason).not.toContain('upgraded to');
    });

    it('applies the configured ollama fallback when the selected rule targets an unhealthy ollama provider', () => {
      const { core } = loadCore({
        ollamaHealthy: false,
        db: {
          config: {
            ollama_fallback_provider: 'claude-cli',
          },
          rules: [
            {
              name: 'docs-rule',
              rule_type: 'keyword',
              pattern: 'readme|docs',
              target_provider: 'ollama',
              priority: 1,
            },
          ],
        },
      });

      const result = core.analyzeTaskForRouting('Update README docs', 'C:/repo');

      expect(result).toMatchObject({
        provider: 'claude-cli',
        originalProvider: 'ollama',
        fallbackApplied: true,
      });
      expect(result.reason).toContain('Ollama unavailable');
    });

    it('skips ollama fallback when skipHealthCheck is enabled', () => {
      const { core } = loadCore({
        ollamaHealthy: false,
        db: {
          rules: [
            {
              name: 'docs-rule',
              rule_type: 'keyword',
              pattern: 'docs',
              target_provider: 'ollama',
              priority: 1,
            },
          ],
        },
      });

      const result = core.analyzeTaskForRouting('Write docs', 'C:/repo', [], { skipHealthCheck: true });

      expect(result.provider).toBe('ollama');
      expect(result.fallbackApplied).toBeUndefined();
    });

    it('does not apply ollama fallback when health is unknown', () => {
      const { core } = loadCore({
        ollamaHealthy: null,
        db: {
          rules: [
            {
              name: 'docs-rule',
              rule_type: 'keyword',
              pattern: 'docs',
              target_provider: 'ollama',
              priority: 1,
            },
          ],
        },
      });

      const result = core.analyzeTaskForRouting('Write docs', 'C:/repo');

      expect(result.provider).toBe('ollama');
      expect(result.fallbackApplied).toBeUndefined();
    });

    it('matches keyword rules in priority order', () => {
      const { core } = loadCore({
        db: {
          rules: [
            {
              name: 'lower-priority',
              rule_type: 'keyword',
              pattern: 'readme',
              target_provider: 'codex',
              priority: 10,
            },
            {
              name: 'higher-priority',
              rule_type: 'keyword',
              pattern: 'readme',
              target_provider: 'claude-cli',
              priority: 1,
            },
          ],
        },
      });

      const result = core.analyzeTaskForRouting('Update README copy', 'C:/repo');

      expect(result.provider).toBe('claude-cli');
      expect(result.reason).toContain("Matched keyword rule 'higher-priority'");
    });

    it('matches extension rules using the supplied file list', () => {
      const { core } = loadCore({
        db: {
          rules: [
            {
              name: 'csharp-rule',
              rule_type: 'extension',
              pattern: '.cs|.csproj',
              target_provider: 'claude-cli',
              priority: 1,
            },
          ],
        },
      });

      const result = core.analyzeTaskForRouting('Adjust model bindings', 'C:/repo', ['src/ViewModel.CS']);

      expect(result.provider).toBe('claude-cli');
      expect(result.reason).toContain("Matched extension rule 'csharp-rule'");
    });

    it('matches regex rules and skips invalid or unsafe regex patterns', () => {
      const { core, loggerChild } = loadCore({
        db: {
          rules: [
            {
              name: 'invalid',
              rule_type: 'regex',
              pattern: '[unterminated',
              target_provider: 'codex',
              priority: 1,
            },
            {
              name: 'unsafe',
              rule_type: 'regex',
              pattern: 'x'.repeat(201),
              target_provider: 'codex',
              priority: 2,
            },
            {
              name: 'ticket-id',
              rule_type: 'regex',
              pattern: 'foo\\d+',
              target_provider: 'claude-cli',
              priority: 3,
            },
          ],
        },
      });

      const result = core.analyzeTaskForRouting('Please inspect foo123 quickly', 'C:/repo');

      expect(result.provider).toBe('claude-cli');
      expect(result.reason).toContain("Matched regex rule 'ticket-id'");
      expect(loggerChild.warn).toHaveBeenCalledWith(expect.stringContaining('Unsafe regex pattern skipped:'));
    });

    it('can filter rule evaluation to enabled extension rules only', () => {
      const { core } = loadCore({
        db: {
          rules: [
            {
              name: 'disabled-ext',
              rule_type: 'extension',
              pattern: '.js',
              target_provider: 'codex',
              priority: 1,
              enabled: 0,
            },
            {
              name: 'enabled-ext',
              rule_type: 'extension',
              pattern: '.js',
              target_provider: 'claude-cli',
              priority: 2,
              enabled: 1,
            },
            {
              name: 'keyword',
              rule_type: 'keyword',
              pattern: 'readme',
              target_provider: 'anthropic',
              priority: 3,
              enabled: 1,
            },
          ],
        },
      });

      const result = core.analyzeTaskForRouting('Readme change', 'C:/repo', ['src/index.js'], {
        enabled: true,
        rule_type: 'extension',
      });

      expect(result.provider).toBe('claude-cli');
      expect(result.reason).toContain("Matched extension rule 'enabled-ext'");
    });

    it('skips quota-exhausted providers in active template fallback chains', () => {
      const { createQuotaStore } = require('../db/provider/quotas');
      const quotaStore = createQuotaStore();
      quotaStore.updateFromHeaders('cerebras', {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '0',
      });

      const activeTemplate = { id: 'tmpl-1', name: 'Quota Template' };
      const categoryClassifierMock = {
        classify: vi.fn(() => 'backend'),
      };
      const templateStoreMock = {
        getExplicitActiveTemplateId: vi.fn(() => activeTemplate.id),
        getTemplate: vi.fn((templateId) => (templateId === activeTemplate.id ? activeTemplate : null)),
        resolveProvider: vi.fn(() => ({
          provider: 'groq',
          model: null,
          chain: [
            { provider: 'groq', model: null },
            { provider: 'cerebras', model: 'cerebras/llama-4-scout' },
            { provider: 'openrouter', model: 'openrouter/auto' },
          ],
        })),
      };

      const { core, loggerChild } = loadCore({
        db: {
          providers: {
            groq: { enabled: 0 },
            cerebras: { enabled: 1, priority: 45 },
            openrouter: { enabled: 1, priority: 46 },
          },
          rules: [],
        },
        moduleMocks: {
          '../routing/category-classifier': categoryClassifierMock,
          '../routing/template-store': templateStoreMock,
          '../db/provider/quotas': { getQuotaStore: () => quotaStore },
        },
      });

      const result = core.analyzeTaskForRouting('Investigate provider failover path', 'C:/repo');

      expect(result).toMatchObject({
        provider: 'openrouter',
        model: 'openrouter/auto',
      });
      expect(result.reason).toContain("Template 'Quota Template': backend -> groq (unavailable), chain fallback -> openrouter");
      expect(loggerChild.info).toHaveBeenCalledWith('[SmartRouting] Skipping cerebras — quota exhausted');
      expect(templateStoreMock.resolveProvider).toHaveBeenCalledWith(activeTemplate, 'backend', 'normal');
    });

    it('uses the smart routing default provider when no rule matches', () => {
      const { core } = loadCore({
        db: {
          config: {
            smart_routing_default_provider: 'codex',
          },
          rules: [],
        },
      });

      const result = core.analyzeTaskForRouting('Perform a generic task', 'C:/repo');

      // toMatchObject: routing_decision_trace was added 2026-05-03
      // and is asserted in tests/routing-trace.test.js.
      expect(result).toMatchObject({
        provider: 'codex',
        rule: null,
        reason: 'No rule matched, using smart routing default: codex',
      });
    });

    it('falls back to the first enabled provider when the smart routing default is disabled', () => {
      const { core, loggerChild } = loadCore({
        db: {
          config: {
            smart_routing_default_provider: 'codex',
          },
          providers: {
            codex: { enabled: 0, priority: 10 },
            'claude-cli': { enabled: 1, priority: 20 },
          },
          rules: [],
        },
      });

      const result = core.analyzeTaskForRouting('Perform a generic task', 'C:/repo');

      expect(result).toMatchObject({
        provider: 'claude-cli',
        rule: null,
        reason: 'No rule matched, using smart routing default: codex',
      });
      expect(loggerChild.warn).toHaveBeenCalledWith(
        '[SmartRouting] Invalid provider resolved (codex) — falling back to claude-cli',
      );
    });
  });

  describe('fallback chains and provider switching', () => {
    it('returns the built-in fallback chain when no override is configured', () => {
      const { core } = loadCore();
      expect(core.getProviderFallbackChain('codex')).toEqual([
        'claude-cli',
        'deepinfra',
        'ollama-cloud',
        'ollama',
      ]);
    });

    it('stores and reads custom fallback chains', () => {
      const { core } = loadCore();

      core.setProviderFallbackChain('codex', ['claude-cli', 'ollama']);
      expect(core.getProviderFallbackChain('codex')).toEqual(['claude-cli', 'ollama']);
    });

    it('validates fallback chain input for self loops, duplicates, and unknown providers', () => {
      const { core } = loadCore();

      expect(() => core.setProviderFallbackChain('codex', ['codex'])).toThrow(/self-loop/i);
      expect(() => core.setProviderFallbackChain('codex', ['claude-cli', 'claude-cli'])).toThrow(
        /duplicate provider/i,
      );
      expect(() => core.setProviderFallbackChain('codex', ['no-such-provider'])).toThrow(
        /unknown provider/i,
      );
    });

    it('traverses the fallback chain past failover history and the current provider', () => {
      const { core } = loadCore({
        db: {
          config: {
            fallback_chain_codex: '["claude-cli","ollama","anthropic"]',
          },
          tasks: {
            'task-1': {
              provider: 'claude-cli',
              original_provider: 'codex',
              status: 'failed',
              task_description: 'Fix auth.ts validation',
            },
          },
          failoverEvents: [
            { task_id: 'task-1', to_provider: 'claude-cli' },
            { task_id: 'task-1', to_provider: 'ollama' },
          ],
        },
      });

      expect(core.getNextFallbackProvider('task-1')).toBe('anthropic');
    });

    it('skips raw ollama for greenfield file creation tasks', () => {
      const { core } = loadCore({
        db: {
          config: {
            fallback_chain_codex: '["ollama","claude-cli"]',
          },
          tasks: {
            'task-1': {
              provider: 'codex',
              original_provider: 'codex',
              status: 'failed',
              task_description: 'Create a new test file for auth coverage',
            },
          },
        },
        moduleMocks: {
          '../providers/agentic-capability': {
            isAgenticCapable: () => ({ capable: false, reason: 'test mock', source: 'test' }),
          },
        },
      });

      expect(core.getNextFallbackProvider('task-1')).toBe('claude-cli');
    });

    it('skips disabled fallback providers and returns the next enabled option', () => {
      const { core } = loadCore({
        db: {
          config: {
            fallback_chain_codex: '["deepinfra","anthropic"]',
          },
          providers: {
            deepinfra: { enabled: 0 },
            anthropic: { enabled: 1 },
          },
          tasks: {
            'task-1': {
              provider: 'codex',
              original_provider: 'codex',
              status: 'failed',
              task_description: 'Fix auth.ts validation',
            },
          },
        },
      });

      expect(core.getNextFallbackProvider('task-1')).toBe('anthropic');
    });

    it('returns null when the fallback chain is exhausted', () => {
      const { core } = loadCore({
        db: {
          config: {
            fallback_chain_codex: '["claude-cli"]',
          },
          tasks: {
            'task-1': {
              provider: 'claude-cli',
              original_provider: 'codex',
              status: 'failed',
              task_description: 'Fix auth.ts validation',
            },
          },
          failoverEvents: [{ task_id: 'task-1', to_provider: 'claude-cli' }],
        },
      });

      expect(core.getNextFallbackProvider('task-1')).toBeNull();
    });

    it('approves provider switches, defers the new provider to metadata, resets task execution fields, and emits queue-changed', () => {
      const eventBus = require('../event-bus');
      const emitSpy = vi.spyOn(eventBus, 'emitQueueChanged');
      const { core } = loadCore({
        db: {
          tasks: {
            'task-1': {
              provider: 'codex',
              status: 'pending_provider_switch',
              model: 'gpt-5',
              ollama_host_id: 'host-7',
              started_at: '2026-03-09T00:00:00.000Z',
              completed_at: '2026-03-09T00:01:00.000Z',
              exit_code: 1,
              pid: 1234,
              progress_percent: 55,
              metadata: {
                provider_switch_target: 'claude-cli',
                quota_overflow: true,
                original_provider: 'codex',
              },
            },
          },
        },
      });

      const updated = core.approveProviderSwitch('task-1', 'claude-cli');

      expect(updated).toMatchObject({
        provider: null,
        original_provider: 'codex',
        status: 'queued',
        retry_count: 1,
        started_at: null,
        completed_at: null,
        exit_code: null,
        pid: null,
        progress_percent: 0,
        model: null,
        ollama_host_id: null,
        metadata: {
          provider_switch_target: 'claude-cli',
          failover_provider: 'claude-cli',
          failover_from: 'codex',
          intended_provider: 'claude-cli',
        },
      });
      expect(updated.provider_switched_at).toEqual(expect.any(String));
      expect(emitSpy).toHaveBeenCalled();
    });

    it('rejects provider approval when the task is not pending or the provider is unavailable', () => {
      const { core } = loadCore({
        db: {
          tasks: {
            'task-1': {
              provider: 'codex',
              status: 'queued',
            },
            'task-2': {
              provider: 'codex',
              status: 'pending_provider_switch',
            },
          },
          providers: {
            anthropic: { enabled: 0 },
          },
        },
      });

      expect(() => core.approveProviderSwitch('task-1', 'claude-cli')).toThrow(/not pending provider switch/i);
      expect(() => core.approveProviderSwitch('task-2', 'anthropic')).toThrow(/not available/i);
    });

    it('rejects provider switches and appends the rejection reason', () => {
      const { core } = loadCore({
        db: {
          tasks: {
            'task-1': {
              provider: 'codex',
              status: 'pending_provider_switch',
              error_output: 'quota hit',
            },
          },
        },
      });

      const updated = core.rejectProviderSwitch('task-1', 'user denied');

      expect(updated.status).toBe('failed');
      expect(updated.completed_at).toEqual(expect.any(String));
      expect(updated.error_output).toContain('quota hit');
      expect(updated.error_output).toContain('[Provider Switch Rejected] user denied');
    });

    it('detects quota errors with case-insensitive provider patterns', () => {
      const { core } = loadCore();

      expect(core.isProviderQuotaError('codex', 'HTTP 429 TOO MANY REQUESTS')).toBe(true);
      expect(core.isProviderQuotaError('codex', 'socket hang up')).toBe(false);
      expect(core.isProviderQuotaError('no-such-provider', '429')).toBe(false);
    });

    it('does not treat auth failures as quota exhaustion', () => {
      const { core } = loadCore();

      expect(core.isProviderQuotaError('codex', '401 Unauthorized while handling 429 retry')).toBe(false);
      expect(core.isProviderQuotaError('codex', 'authentication failed: rate limit unavailable')).toBe(false);
    });

    it('tracks codex exhaustion state in config', () => {
      const { core, state } = loadCore();

      expect(core.isCodexExhausted()).toBe(false);
      core.setCodexExhausted(true);
      expect(core.isCodexExhausted()).toBe(true);
      expect(state.config.get('codex_exhausted_at')).toEqual(expect.any(String));

      core.setCodexExhausted(false);
      expect(core.isCodexExhausted()).toBe(false);
    });
  });

  describe('provider health helpers', () => {
    it('uses healthy host-management state when ollama cache is stale', () => {
      const hostManagement = createHostManagement({
        listOllamaHosts: vi.fn(() => [
          { enabled: true, status: 'healthy' },
          { enabled: true, status: 'unhealthy' },
        ]),
      });
      const { core } = loadCore({
        hostManagement,
        ollamaHealthy: null,
      });

      expect(core.isOllamaHealthy()).toBe(true);
      expect(hostManagement.listOllamaHosts).toHaveBeenCalledTimes(1);
    });

    it('returns null when no cached health or healthy hosts are available', () => {
      const hostManagement = createHostManagement({
        listOllamaHosts: vi.fn(() => [{ enabled: true, status: 'unhealthy' }]),
      });
      const { core } = loadCore({
        hostManagement,
        ollamaHealthy: null,
      });

      expect(core.isOllamaHealthy()).toBeNull();
    });

    it('delegates hasHealthyOllamaHost to host management when available', () => {
      const hostManagement = createHostManagement({
        hasHealthyOllamaHost: vi.fn(() => true),
      });
      const { core } = loadCore({ hostManagement });

      expect(core.hasHealthyOllamaHost()).toBe(true);
      expect(hostManagement.hasHealthyOllamaHost).toHaveBeenCalledTimes(1);
    });

    it('checks ollama health over http and reuses the cached result', async () => {
      const { core } = loadCore({
        db: {
          config: {
            ollama_auto_detect_wsl_host: '0',
            ollama_host: 'http://ollama.local:11434',
          },
        },
        ollamaHealthy: null,
      });
      const getSpy = makeRequestMock(200);

      await expect(core.checkOllamaHealth(true)).resolves.toBe(true);
      await expect(core.checkOllamaHealth(false)).resolves.toBe(true);

      expect(getSpy).toHaveBeenCalledTimes(1);
    });
  });
});
