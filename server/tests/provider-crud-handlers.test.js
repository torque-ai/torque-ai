import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('module');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const HANDLER_MODULE = '../handlers/provider-crud-handlers';
const HANDLER_FILE = require.resolve(HANDLER_MODULE);
const MOCKED_MODULE_PATHS = [
  HANDLER_MODULE,
  '../database',
  '../db/provider-routing-core',
  '../task-manager',
  '../utils/credential-crypto',
  '../logger',
  '../providers/adapter-registry',
  '../providers/registry',
  '../utils/host-monitoring',
  '../utils/sensitive-keys',
];

let currentModules = {};
let handlers = null;
let helperFns = null;

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearLoadedModules() {
  for (const modulePath of MOCKED_MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore unloaded modules.
    }
  }
}

function createMockDb(options = {}) {
  const providers = new Map(
    (options.providers || []).map((provider) => [
      provider.provider,
      {
        enabled: 1,
        priority: 1,
        transport: 'api',
        max_concurrent: 3,
        api_key_encrypted: null,
        provider_type: 'custom',
        default_model: null,
        api_base_url: null,
        ...provider,
      },
    ]),
  );
  const tasks = (options.tasks || []).map((task) => ({
    archived: 0,
    metadata: '{}',
    original_provider: null,
    created_at: '2026-04-04T00:00:00.000Z',
    ...task,
  }));
  const models = (options.models || []).map((model) => ({
    host_id: '',
    status: 'pending',
    ...model,
  }));
  const config = new Map(Object.entries(options.config || {}));
  const records = {
    insertProviderRuns: [],
    deleteProviderRuns: [],
    setApiKeyRuns: [],
    clearApiKeyRuns: [],
    rerouteTaskRuns: [],
    unresolvedTaskRuns: [],
    removedModelRuns: [],
  };

  function getTaskSummaryRows(providerName) {
    const counts = new Map();
    for (const task of tasks) {
      if (task.provider !== providerName) continue;
      if (task.archived) continue;
      if (task.status !== 'queued' && task.status !== 'running') continue;
      counts.set(task.status, (counts.get(task.status) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([status, count]) => ({ status, count }));
  }

  function getModelSummary(providerName) {
    const matching = models.filter((model) => model.provider === providerName);
    return {
      total: matching.length,
      pending: matching.filter((model) => model.status === 'pending').length,
      removed: matching.filter((model) => model.status === 'removed').length,
      approved: matching.filter((model) => model.status === 'approved').length,
    };
  }

  const db = {
    providers,
    tasks,
    models,
    config,
    records,
    transaction: vi.fn((fn) => (...args) => fn(...args)),
    prepare: vi.fn((sql) => {
      const normalized = normalizeSql(sql);

      return {
        get: vi.fn((...args) => {
          if (normalized.includes('SELECT provider FROM provider_config WHERE provider = ?')) {
            const providerName = args[0];
            return providers.has(providerName) ? { provider: providerName } : undefined;
          }

          if (normalized.includes('SELECT COALESCE(MAX(priority), 0) + 1 AS next_priority FROM provider_config')) {
            return { next_priority: options.nextPriority ?? 1 };
          }

          if (normalized.includes('SELECT COUNT(*) AS total')) {
            return getModelSummary(args[0]);
          }

          if (normalized.includes("SELECT value FROM config WHERE key = 'default_provider'")) {
            return config.has('default_provider') ? { value: config.get('default_provider') } : undefined;
          }

          if (normalized.includes('SELECT api_key_encrypted FROM provider_config WHERE provider = ?')) {
            const provider = providers.get(args[0]);
            if (!provider) return undefined;
            return { api_key_encrypted: provider.api_key_encrypted || null };
          }

          if (normalized.includes('SELECT id FROM model_registry')) {
            const [providerName, modelName] = args;
            const match = models.find(
              (model) => model.provider === providerName
                && (model.host_id || '') === ''
                && model.model_name === modelName,
            );
            return match ? { id: match.id } : undefined;
          }

          throw new Error(`Unhandled get SQL in test double: ${normalized}`);
        }),

        all: vi.fn((...args) => {
          if (normalized.includes('FROM tasks') && normalized.includes('GROUP BY status')) {
            return getTaskSummaryRows(args[0]);
          }

          if (normalized.includes('SELECT id, provider, original_provider, task_description, working_directory, metadata')) {
            return tasks
              .filter((task) => task.provider === args[0] && task.status === 'queued' && task.archived === 0)
              .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
          }

          throw new Error(`Unhandled all SQL in test double: ${normalized}`);
        }),

        run: vi.fn((...args) => {
          if (normalized.includes('INSERT INTO provider_config')) {
            const [
              providerName,
              enabled,
              priority,
              cliPath,
              transport,
              quotaErrorPatterns,
              maxConcurrent,
              createdAt,
              updatedAt,
              apiBaseUrl,
              apiKeyEncrypted,
              providerType,
              defaultModel,
            ] = args;

            providers.set(providerName, {
              provider: providerName,
              enabled,
              priority,
              cli_path: cliPath,
              transport,
              quota_error_patterns: quotaErrorPatterns,
              max_concurrent: maxConcurrent,
              created_at: createdAt,
              updated_at: updatedAt,
              api_base_url: apiBaseUrl,
              api_key_encrypted: apiKeyEncrypted,
              provider_type: providerType,
              default_model: defaultModel,
            });
            records.insertProviderRuns.push(args);
            return { changes: 1 };
          }

          if (normalized.includes("UPDATE model_registry SET status = 'pending'")) {
            const [firstSeenAt, lastSeenAt, id] = args;
            const model = models.find((candidate) => candidate.id === id);
            if (model) {
              model.status = 'pending';
              model.first_seen_at = model.first_seen_at || firstSeenAt;
              model.last_seen_at = lastSeenAt;
              model.approved_at = null;
              model.approved_by = null;
            }
            return { changes: model ? 1 : 0 };
          }

          if (normalized.includes('INSERT INTO model_registry')) {
            const [id, providerName, modelName, firstSeenAt, lastSeenAt] = args;
            models.push({
              id,
              provider: providerName,
              host_id: '',
              model_name: modelName,
              status: 'pending',
              first_seen_at: firstSeenAt,
              last_seen_at: lastSeenAt,
            });
            return { changes: 1 };
          }

          if (normalized.includes("UPDATE model_registry SET status = 'removed'")) {
            const [lastSeenAt, providerName] = args;
            let changes = 0;
            for (const model of models) {
              if (model.provider === providerName) {
                model.status = 'removed';
                model.last_seen_at = lastSeenAt;
                changes += 1;
              }
            }
            records.removedModelRuns.push(args);
            return { changes };
          }

          if (normalized.includes('DELETE FROM provider_config WHERE provider = ?')) {
            providers.delete(args[0]);
            records.deleteProviderRuns.push(args);
            return { changes: 1 };
          }

          if (normalized.includes('UPDATE tasks SET provider = ?,') && normalized.includes('WHERE id = ?')) {
            const [nextProvider, originalProvider, switchedAt, metadataText, taskId] = args;
            const task = tasks.find((candidate) => candidate.id === taskId);
            if (task) {
              task.provider = nextProvider;
              task.model = null;
              task.original_provider = task.original_provider || originalProvider;
              task.provider_switched_at = switchedAt;
              task.metadata = metadataText;
            }
            records.rerouteTaskRuns.push(args);
            return { changes: task ? 1 : 0 };
          }

          if (normalized.includes('UPDATE tasks SET provider = NULL,') && normalized.includes('WHERE id = ?')) {
            const [originalProvider, switchedAt, metadataText, taskId] = args;
            const task = tasks.find((candidate) => candidate.id === taskId);
            if (task) {
              task.provider = null;
              task.model = null;
              task.original_provider = task.original_provider || originalProvider;
              task.provider_switched_at = switchedAt;
              task.metadata = metadataText;
            }
            records.unresolvedTaskRuns.push(args);
            return { changes: task ? 1 : 0 };
          }

          if (normalized.includes("INSERT INTO config (key, value) VALUES ('default_provider', ?)")) {
            config.set('default_provider', args[0]);
            return { changes: 1 };
          }

          if (normalized.includes("DELETE FROM config WHERE key = 'default_provider'")) {
            config.delete('default_provider');
            return { changes: 1 };
          }

          if (normalized.includes("UPDATE provider_config SET api_key_encrypted = ?, updated_at = datetime('now') WHERE provider = ?")) {
            const [encryptedValue, providerName] = args;
            const provider = providers.get(providerName);
            if (provider) {
              provider.api_key_encrypted = encryptedValue;
            }
            records.setApiKeyRuns.push(args);
            return { changes: provider ? 1 : 0 };
          }

          if (normalized.includes("UPDATE provider_config SET api_key_encrypted = NULL, updated_at = datetime('now') WHERE provider = ?")) {
            const [providerName] = args;
            const provider = providers.get(providerName);
            if (provider) {
              provider.api_key_encrypted = null;
            }
            records.clearApiKeyRuns.push(args);
            return { changes: provider ? 1 : 0 };
          }

          throw new Error(`Unhandled run SQL in test double: ${normalized}`);
        }),
      };
    }),
  };

  return db;
}

function createDefaultModules(overrides = {}) {
  const db = overrides.db || createMockDb(overrides.dbOptions);
  const providerRoutingCore = overrides.providerRoutingCore || {
    normalizeProviderTransport: vi.fn((transport) => {
      if (transport === null || transport === undefined || transport === '') return 'api';
      const normalized = String(transport).trim().toLowerCase();
      return ['api', 'cli', 'hybrid'].includes(normalized) ? normalized : 'api';
    }),
    listProviders: vi.fn(() => overrides.providersList || []),
    analyzeTaskForRouting: vi.fn(() => overrides.routedTask || null),
  };

  return {
    db,
    database: {
      getDb: vi.fn(() => db),
      getDbInstance: vi.fn(() => db),
    },
    providerRoutingCore,
    taskManager: overrides.taskManager || {
      processQueue: vi.fn(),
    },
    credentialCrypto: overrides.credentialCrypto || {
      getOrCreateKey: vi.fn(() => 'credential-key'),
      encrypt: vi.fn((plaintext) => ({
        encrypted_value: `cipher-${plaintext}`,
        iv: 'test-iv',
        auth_tag: 'test-tag',
      })),
      decrypt: vi.fn((encryptedValue) => (
        typeof encryptedValue === 'string' && encryptedValue.startsWith('cipher-')
          ? encryptedValue.slice('cipher-'.length)
          : null
      )),
    },
    logger: overrides.logger || {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    adapterRegistry: overrides.adapterRegistry || {
      invalidateAdapterCache: vi.fn(),
    },
    providerRegistry: overrides.providerRegistry || {
      resetInstances: vi.fn(),
    },
    hostMonitoring: overrides.hostMonitoring || {
      runHostHealthChecks: vi.fn(() => Promise.resolve()),
    },
    sensitiveKeys: overrides.sensitiveKeys || {
      redactValue: vi.fn((value) => `${value.slice(0, 2)}***${value.slice(-2)}`),
    },
  };
}

function loadInternalHelpers() {
  const source = fs.readFileSync(HANDLER_FILE, 'utf8');
  const injectedSource = `${source}\nmodule.exports.__test__ = { normalizeRequiredString, normalizeInteger };`;
  const testModule = new Module(HANDLER_FILE);
  testModule.filename = HANDLER_FILE;
  testModule.paths = Module._nodeModulePaths(path.dirname(HANDLER_FILE));
  testModule._compile(injectedSource, HANDLER_FILE);
  return testModule.exports.__test__;
}

async function loadProviderCrudHandlers(overrides = {}) {
  currentModules = createDefaultModules(overrides);

  vi.resetModules();
  vi.doMock('../database', () => currentModules.database);
  vi.doMock('../db/provider-routing-core', () => currentModules.providerRoutingCore);
  vi.doMock('../task-manager', () => currentModules.taskManager);
  vi.doMock('../utils/credential-crypto', () => currentModules.credentialCrypto);
  vi.doMock('../logger', () => currentModules.logger);
  vi.doMock('../providers/adapter-registry', () => currentModules.adapterRegistry);
  vi.doMock('../providers/registry', () => currentModules.providerRegistry);
  vi.doMock('../utils/host-monitoring', () => currentModules.hostMonitoring);
  vi.doMock('../utils/sensitive-keys', () => currentModules.sensitiveKeys);

  installCjsModuleMock('../database', currentModules.database);
  installCjsModuleMock('../db/provider-routing-core', currentModules.providerRoutingCore);
  installCjsModuleMock('../task-manager', currentModules.taskManager);
  installCjsModuleMock('../utils/credential-crypto', currentModules.credentialCrypto);
  installCjsModuleMock('../logger', currentModules.logger);
  installCjsModuleMock('../providers/adapter-registry', currentModules.adapterRegistry);
  installCjsModuleMock('../providers/registry', currentModules.providerRegistry);
  installCjsModuleMock('../utils/host-monitoring', currentModules.hostMonitoring);
  installCjsModuleMock('../utils/sensitive-keys', currentModules.sensitiveKeys);

  const imported = await import('../handlers/provider-crud-handlers.js');
  const loadedHandlers = imported.default ?? imported;
  handlers = typeof loadedHandlers.createProviderCrudHandlers === 'function'
    ? loadedHandlers.createProviderCrudHandlers({ db: currentModules.db })
    : loadedHandlers;
  helperFns = loadInternalHelpers();

  return currentModules;
}

function captureThrown(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function parseJsonText(result) {
  return JSON.parse(result?.content?.[0]?.text || '{}');
}

beforeEach(() => {
  setupTestDbOnly('provider-crud-handlers');
});

afterEach(() => {
  handlers?.validatingProviders?.clear();
  handlers = null;
  helperFns = null;
  currentModules = {};
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearLoadedModules();
  teardownTestDb();
});

describe('provider-crud-handlers', () => {
  it('uses injected database dependencies without loading the database facade', async () => {
    const originalLoad = Module._load;
    const blockedRequests = [];
    const databaseLoadSpy = vi.spyOn(Module, '_load').mockImplementation(function patchedLoad(request, parent, isMain) {
      const parentFile = parent?.filename ? parent.filename.replace(/\\/g, '/') : '';
      if (request === '../database' && parentFile.endsWith('server/handlers/provider-crud-handlers.js')) {
        blockedRequests.push(request);
        throw new Error('provider CRUD handler should not require database facade');
      }
      return originalLoad.call(this, request, parent, isMain);
    });

    try {
      const modules = await loadProviderCrudHandlers({
        dbOptions: { nextPriority: 4 },
      });

      const result = handlers.handleAddProvider({
        name: 'custom-cloud',
        provider_type: 'custom',
        api_base_url: 'https://api.example.test/v1',
      });

      expect(result.isError).toBeFalsy();
      expect(modules.db.prepare).toHaveBeenCalled();
      expect(modules.db.providers.has('custom-cloud')).toBe(true);
      expect(blockedRequests).toEqual([]);
    } finally {
      databaseLoadSpy.mockRestore();
    }
  });

  it('handleAddProvider creates a new provider with valid params', async () => {
    const modules = await loadProviderCrudHandlers({
      dbOptions: { nextPriority: 7 },
    });

    const result = handlers.handleAddProvider({
      name: 'custom-cloud',
      provider_type: 'custom',
      api_base_url: 'https://api.example.test/v1',
    });

    expect(result).toMatchObject({
      provider: 'custom-cloud',
      created: true,
      provider_type: 'custom',
      api_base_url: 'https://api.example.test/v1',
      max_concurrent: 3,
      priority: 7,
      transport: 'api',
      models_registered: 0,
      models: [],
    });
    expect(result.content[0].text).toContain('Provider `custom-cloud` created.');
    expect(modules.db.providers.get('custom-cloud')).toMatchObject({
      provider: 'custom-cloud',
      provider_type: 'custom',
      api_base_url: 'https://api.example.test/v1',
      max_concurrent: 3,
      transport: 'api',
    });
    expect(modules.db.records.insertProviderRuns).toHaveLength(1);
  });

  it('handleAddProvider rejects missing required fields', async () => {
    const modules = await loadProviderCrudHandlers();

    const result = handlers.handleAddProvider({
      provider_type: 'custom',
      api_base_url: 'https://api.example.test/v1',
    });

    expect(result).toMatchObject({
      isError: true,
      error_code: 'MISSING_REQUIRED_PARAM',
      code: 'validation_error',
      status: 400,
      details: { field: 'name' },
    });
    expect(modules.db.prepare).not.toHaveBeenCalled();
  });

  it('handleAddProvider rejects invalid provider types', async () => {
    const modules = await loadProviderCrudHandlers();

    const result = handlers.handleAddProvider({
      name: 'bad-provider',
      provider_type: 'invalid-type',
      api_base_url: 'https://api.example.test/v1',
    });

    expect(result).toMatchObject({
      isError: true,
      error_code: 'INVALID_PARAM',
      code: 'validation_error',
      status: 400,
      details: { field: 'provider_type', value: 'invalid-type' },
    });
    expect(result.content[0].text).toContain('provider_type must be one of ollama, cloud-cli, cloud-api, custom');
    expect(modules.db.prepare).not.toHaveBeenCalled();
  });

  it('handleRemoveProvider removes an existing provider', async () => {
    const modules = await loadProviderCrudHandlers({
      dbOptions: {
        providers: [
          { provider: 'groq', provider_type: 'cloud-api', transport: 'api' },
        ],
        models: [
          { id: 'model-1', provider: 'groq', model_name: 'llama-1', status: 'pending' },
          { id: 'model-2', provider: 'groq', model_name: 'llama-2', status: 'approved' },
        ],
      },
    });

    const result = handlers.handleRemoveProvider({
      provider: 'groq',
      confirm: true,
    });

    expect(result).toMatchObject({
      provider: 'groq',
      deleted: true,
      rerouted_tasks: 0,
      unresolved_tasks: 0,
      running_tasks: 0,
      affected_models: {
        total: 2,
        pending: 1,
        removed: 0,
        approved: 1,
      },
    });
    expect(result.content[0].text).toContain('Provider `groq` removed.');
    expect(modules.db.providers.has('groq')).toBe(false);
    expect(modules.taskManager.processQueue).toHaveBeenCalledTimes(1);
    expect(modules.db.records.deleteProviderRuns).toHaveLength(1);
    expect(modules.db.models.every((model) => model.status === 'removed')).toBe(true);
  });

  it('handleRemoveProvider returns error for a non-existent provider', async () => {
    await loadProviderCrudHandlers();

    const result = handlers.handleRemoveProvider({
      provider: 'missing-provider',
      confirm: true,
    });

    expect(result).toMatchObject({
      isError: true,
      error_code: 'RESOURCE_NOT_FOUND',
      code: 'provider_not_found',
      status: 404,
      details: { provider: 'missing-provider' },
    });
  });

  it('handleSetApiKey encrypts and stores the API key', async () => {
    const modules = await loadProviderCrudHandlers({
      dbOptions: {
        providers: [
          { provider: 'groq', provider_type: 'cloud-api', transport: 'api' },
        ],
      },
    });

    const result = handlers.handleSetApiKey({
      provider: 'groq',
      api_key: '  sk-live-123  ',
    });

    const payload = parseJsonText(result);
    expect(payload).toEqual({
      status: 'saved',
      masked: 'sk***23',
      validating: true,
    });
    expect(modules.credentialCrypto.getOrCreateKey).toHaveBeenCalledTimes(1);
    expect(modules.credentialCrypto.encrypt).toHaveBeenCalledWith('sk-live-123', 'credential-key');
    expect(modules.db.providers.get('groq').api_key_encrypted).toBe('test-iv:test-tag:cipher-sk-live-123');
    expect(modules.adapterRegistry.invalidateAdapterCache).toHaveBeenCalledWith('groq');
    expect(modules.providerRegistry.resetInstances).toHaveBeenCalledTimes(1);
    expect(modules.hostMonitoring.runHostHealthChecks).toHaveBeenCalledTimes(1);
    expect(modules.logger.info).toHaveBeenCalledWith('API key set for provider groq');
  });

  it('handleClearApiKey removes the stored API key', async () => {
    const modules = await loadProviderCrudHandlers({
      dbOptions: {
        providers: [
          {
            provider: 'groq',
            provider_type: 'cloud-api',
            transport: 'api',
            api_key_encrypted: 'test-iv:test-tag:cipher-sk-live-123',
          },
        ],
      },
    });
    handlers.validatingProviders.set('groq', Date.now());

    const result = handlers.handleClearApiKey({
      provider: 'groq',
    });

    expect(parseJsonText(result)).toEqual({ status: 'cleared' });
    expect(modules.db.providers.get('groq').api_key_encrypted).toBeNull();
    expect(handlers.validatingProviders.has('groq')).toBe(false);
    expect(modules.adapterRegistry.invalidateAdapterCache).toHaveBeenCalledWith('groq');
    expect(modules.providerRegistry.resetInstances).toHaveBeenCalledTimes(1);
    expect(modules.logger.info).toHaveBeenCalledWith('API key cleared for provider groq');
  });

  it('getApiKeyStatus reports when a key is configured for a provider', async () => {
    await loadProviderCrudHandlers({
      dbOptions: {
        providers: [
          {
            provider: 'groq',
            provider_type: 'cloud-api',
            transport: 'api',
            api_key_encrypted: 'test-iv:test-tag:cipher-sk-live-123',
          },
        ],
      },
    });

    expect(handlers.getApiKeyStatus('groq')).toBe('stored');
    expect(handlers.getApiKeyStatus('missing-provider')).toBe('not_set');
  });

  it('normalizeRequiredString throws for empty or whitespace-only strings', async () => {
    await loadProviderCrudHandlers();

    const emptyError = captureThrown(() => helperFns.normalizeRequiredString('', 'name'));
    const whitespaceError = captureThrown(() => helperFns.normalizeRequiredString('   ', 'name'));

    expect(emptyError).toMatchObject({
      isError: true,
      error_code: 'MISSING_REQUIRED_PARAM',
      code: 'validation_error',
      status: 400,
      details: { field: 'name' },
    });
    expect(whitespaceError).toMatchObject({
      isError: true,
      error_code: 'MISSING_REQUIRED_PARAM',
      code: 'validation_error',
      status: 400,
      details: { field: 'name' },
    });
  });

  it('normalizeInteger throws for non-integer values', async () => {
    await loadProviderCrudHandlers();

    const stringError = captureThrown(() => helperFns.normalizeInteger('3', 'max_concurrent'));
    const floatError = captureThrown(() => helperFns.normalizeInteger(1.5, 'max_concurrent'));

    expect(stringError).toMatchObject({
      isError: true,
      error_code: 'INVALID_PARAM',
      code: 'validation_error',
      status: 400,
      details: { field: 'max_concurrent', value: '3' },
    });
    expect(floatError).toMatchObject({
      isError: true,
      error_code: 'INVALID_PARAM',
      code: 'validation_error',
      status: 400,
      details: { field: 'max_concurrent', value: 1.5 },
    });
  });
});
