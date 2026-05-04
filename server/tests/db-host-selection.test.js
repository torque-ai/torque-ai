'use strict';
/* global describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi */

const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');
const { setupTestDbOnly, teardownTestDb, rawDb, resetTables } = require('./vitest-setup');
const { TEST_MODELS } = require('./test-helpers');

const SUBJECT_PATH = '../db/host/selection';
const BENCHMARKING_PATH = '../db/host/benchmarking';
const RESET_TABLES = ['ollama_hosts', 'config'];

let db;
let mod;
let logger;
let ensureModelsLoadedSpy;
let hostSeq = 0;

function ensureColumn(tableName, columnName, definition) {
  const exists = rawDb()
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);

  if (!exists) {
    rawDb().exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function createLoggerMock() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createStandaloneSelectionDb() {
  const conn = new Database(':memory:');
  conn.exec(`
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE ollama_hosts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      enabled INTEGER DEFAULT 1,
      status TEXT DEFAULT 'unknown',
      consecutive_failures INTEGER DEFAULT 0,
      last_health_check TEXT,
      last_healthy TEXT,
      running_tasks INTEGER DEFAULT 0,
      models_cache TEXT,
      models_updated_at TEXT,
      created_at TEXT NOT NULL,
      memory_limit_mb INTEGER,
      max_concurrent INTEGER DEFAULT 1,
      last_model_used TEXT,
      model_loaded_at TEXT
    );
  `);
  return conn;
}

function loadSubject(customLogger = createLoggerMock()) {
  delete require.cache[require.resolve(SUBJECT_PATH)];
  delete require.cache[require.resolve(BENCHMARKING_PATH)];

  const loggerModule = require('../logger');
  const childSpy = vi.spyOn(loggerModule, 'child').mockReturnValue(customLogger);
  const hostBenchmarking = require(BENCHMARKING_PATH);
  const ensureSpy = vi.spyOn(hostBenchmarking, 'ensureModelsLoaded').mockReturnValue(0);
  const subject = require(SUBJECT_PATH);

  childSpy.mockRestore();
  subject.setDb(rawDb());

  return {
    mod: subject,
    logger: customLogger,
    ensureModelsLoadedSpy: ensureSpy,
  };
}

function insertHostRow(connection, overrides = {}) {
  hostSeq += 1;

  const id = overrides.id || `host-sel-${hostSeq}`;
  const name = overrides.name || `Host Selection ${hostSeq}`;
  const url = overrides.url || `http://127.0.0.1:${18000 + hostSeq}`;
  const enabled = overrides.enabled !== undefined ? (overrides.enabled ? 1 : 0) : 1;
  const status = overrides.status || 'healthy';
  const runningTasks = overrides.running_tasks ?? 0;
  const maxConcurrent = overrides.max_concurrent ?? 4;
  const models = Object.prototype.hasOwnProperty.call(overrides, 'models')
    ? overrides.models
    : [{ name: TEST_MODELS.SMALL, size: 512 * 1024 * 1024 }];
  const modelsCache = Object.prototype.hasOwnProperty.call(overrides, 'models_cache')
    ? overrides.models_cache
    : JSON.stringify(models);
  const createdAt = overrides.created_at || new Date().toISOString();
  const memoryLimitMb = overrides.memory_limit_mb ?? null;
  const lastModelUsed = overrides.last_model_used ?? null;
  const modelLoadedAt = overrides.model_loaded_at ?? null;

  connection.prepare(`
    INSERT INTO ollama_hosts (
      id, name, url, enabled, status, running_tasks, max_concurrent,
      models_cache, created_at, memory_limit_mb, last_model_used, model_loaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    url,
    enabled,
    status,
    runningTasks,
    maxConcurrent,
    modelsCache,
    createdAt,
    memoryLimitMb,
    lastModelUsed,
    modelLoadedAt,
  );

  return id;
}

function insertHost(overrides = {}) {
  return insertHostRow(rawDb(), overrides);
}

function insertRegistryModel(modelName, parameterSizeB, overrides = {}) {
  rawDb().prepare(`
    INSERT INTO model_registry (
      id, provider, host_id, model_name, parameter_size_b, status, first_seen_at, last_seen_at
    ) VALUES (?, ?, NULL, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    overrides.id || `model-${randomUUID()}`,
    overrides.provider || 'ollama',
    modelName,
    parameterSizeB,
    overrides.status || 'approved',
  );
}

describe('db/host/selection (real DB)', () => {
  beforeAll(() => {
    ({ db } = setupTestDbOnly('db-host-sel'));
    ensureColumn('ollama_hosts', 'memory_limit_mb', 'memory_limit_mb INTEGER');
    ensureColumn('ollama_hosts', 'max_concurrent', 'max_concurrent INTEGER DEFAULT 1');
    ensureColumn('ollama_hosts', 'last_model_used', 'last_model_used TEXT');
    ensureColumn('ollama_hosts', 'model_loaded_at', 'model_loaded_at TEXT');
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetTables(RESET_TABLES);
    hostSeq = 0;
    ({ mod, logger, ensureModelsLoadedSpy } = loadSubject());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete require.cache[require.resolve(SUBJECT_PATH)];
    delete require.cache[require.resolve(BENCHMARKING_PATH)];
  });

  describe('setDb and getAggregatedModels', () => {
    it('setDb routes reads through the provided sqlite handle', () => {
      const alternateDb = createStandaloneSelectionDb();

      try {
        insertHostRow(alternateDb, {
          id: 'alt-host',
          name: 'Alternate Host',
          models: [{ name: 'alt:model', size: 12345 }],
        });

        mod.setDb(alternateDb);

        expect(mod.getAggregatedModels()).toEqual([
          {
            name: 'alt:model',
            size: 12345,
            hosts: [{ id: 'alt-host', name: 'Alternate Host' }],
          },
        ]);
        expect(rawDb().prepare('SELECT COUNT(*) AS count FROM ollama_hosts').get().count).toBe(0);
      } finally {
        mod.setDb(rawDb());
        alternateDb.close();
      }
    });

    it('aggregates models across healthy hosts and sorts by model name', () => {
      const hostA = insertHost({
        id: 'agg-a',
        name: 'Agg A',
        status: 'healthy',
        models: [
          { name: 'mistral:7b', size: 512 * 1024 * 1024 },
          { name: TEST_MODELS.SMALL, size: 768 * 1024 * 1024 },
        ],
      });
      const hostB = insertHost({
        id: 'agg-b',
        name: 'Agg B',
        status: 'healthy',
        models: [{ name: TEST_MODELS.SMALL, size: 768 * 1024 * 1024 }],
      });

      const models = mod.getAggregatedModels();

      expect(models.map((model) => model.name)).toEqual(['mistral:7b', TEST_MODELS.SMALL]);
      expect(models.find((model) => model.name === TEST_MODELS.SMALL)).toEqual({
        name: TEST_MODELS.SMALL,
        size: 768 * 1024 * 1024,
        hosts: expect.arrayContaining([
          { id: hostA, name: 'Agg A' },
          { id: hostB, name: 'Agg B' },
        ]),
      });
    });

    it('excludes disabled or down hosts and ignores broken model caches when aggregating', () => {
      insertHost({
        id: 'healthy-host',
        name: 'Healthy Host',
        enabled: true,
        status: 'healthy',
        models: [
          'zeta:1b',
          { name: 'alpha:2b', size: 2222 },
        ],
      });
      insertHost({
        id: 'disabled-host',
        name: 'Disabled Host',
        enabled: false,
        status: 'healthy',
        models: [{ name: 'beta:3b', size: 3333 }],
      });
      insertHost({
        id: 'down-host',
        name: 'Down Host',
        enabled: true,
        status: 'down',
        models: [{ name: 'gamma:4b', size: 4444 }],
      });
      insertHost({
        id: 'broken-cache-host',
        name: 'Broken Cache Host',
        enabled: true,
        status: 'healthy',
        models_cache: '{bad-json',
      });

      const models = mod.getAggregatedModels();

      expect(models).toEqual([
        {
          name: 'alpha:2b',
          size: 2222,
          hosts: [{ id: 'healthy-host', name: 'Healthy Host' }],
        },
        {
          name: 'zeta:1b',
          size: null,
          hosts: [{ id: 'healthy-host', name: 'Healthy Host' }],
        },
      ]);
    });
  });

  describe('selectOllamaHostForModel', () => {
    it('calls ensureModelsLoaded and returns no host when none are healthy', () => {
      insertHost({
        id: 'disabled-only',
        enabled: false,
        status: 'healthy',
        models: [{ name: TEST_MODELS.SMALL, size: 512 * 1024 * 1024 }],
      });
      insertHost({
        id: 'down-only',
        enabled: true,
        status: 'down',
        models: [{ name: TEST_MODELS.SMALL, size: 512 * 1024 * 1024 }],
      });

      const result = mod.selectOllamaHostForModel(TEST_MODELS.SMALL);

      expect(ensureModelsLoadedSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        host: null,
        reason: 'No healthy Ollama hosts available',
        modelTier: null,
      });
    });

    it('returns atCapacity when every healthy host is full', () => {
      insertHost({
        name: 'Full A',
        running_tasks: 2,
        max_concurrent: 2,
        models: [],
      });
      insertHost({
        name: 'Full B',
        running_tasks: 4,
        max_concurrent: 4,
        models: [],
      });

      const result = mod.selectOllamaHostForModel(null);

      expect(result.host).toBeNull();
      expect(result.atCapacity).toBe(true);
      expect(result.reason).toContain('All hosts at capacity');
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('selects the least-loaded host when no model is specified and no hosts have cached models', () => {
      insertHost({
        name: 'Heavy Empty',
        running_tasks: 3,
        models: [],
      });
      const chosenId = insertHost({
        name: 'Light Empty',
        running_tasks: 1,
        models: [],
      });

      const result = mod.selectOllamaHostForModel(null);

      expect(result.host.id).toBe(chosenId);
      expect(result.reason).toContain('no model specified');
    });

    it('prefers a host with parsed models when no model is specified', () => {
      insertHost({
        name: 'Broken Cache',
        running_tasks: 0,
        models_cache: '{broken',
      });
      const chosenId = insertHost({
        name: 'Loaded Models',
        running_tasks: 1,
        models: [{ name: TEST_MODELS.SMALL, size: 512 * 1024 * 1024 }],
      });

      const result = mod.selectOllamaHostForModel(null);

      expect(result.host.id).toBe(chosenId);
      expect(result.reason).toContain('with 1 models');
    });

    it('selects the least-loaded host that has an exact model match', () => {
      insertHost({
        name: 'Exact Heavy',
        running_tasks: 2,
        models: [{ name: 'mistral:7b', size: 512 * 1024 * 1024 }],
      });
      const chosenId = insertHost({
        name: 'Exact Light',
        running_tasks: 0,
        models: [{ name: 'mistral:7b', size: 512 * 1024 * 1024 }],
      });

      const result = mod.selectOllamaHostForModel('mistral:7b');

      expect(result.host.id).toBe(chosenId);
      expect(result.reason).toContain("has model 'mistral:7b'");
    });

    it('returns atCapacity when only exact-match hosts are full', () => {
      insertHost({
        name: 'Full Exact Host',
        running_tasks: 2,
        max_concurrent: 2,
        models: [{ name: 'llama3.2:3b', size: 256 * 1024 * 1024 }],
      });
      insertHost({
        name: 'Available Other Host',
        running_tasks: 0,
        max_concurrent: 2,
        models: [{ name: TEST_MODELS.FAST, size: 256 * 1024 * 1024 }],
      });

      const result = mod.selectOllamaHostForModel('llama3.2:3b');

      expect(result.host).toBeNull();
      expect(result.atCapacity).toBe(true);
      expect(result.reason).toContain("Host with model 'llama3.2:3b' at capacity");
    });

    it('supports base-model matching when the request has no explicit tag', () => {
      const hostId = insertHost({
        name: 'Base Match',
        models: [{ name: TEST_MODELS.SMALL, size: 512 * 1024 * 1024 }],
      });

      const result = mod.selectOllamaHostForModel(TEST_MODELS.SMALL.split(':')[0]);

      expect(result.host.id).toBe(hostId);
      expect(result.reason).toContain(`has model '${TEST_MODELS.SMALL.split(':')[0]}'`);
    });

    it('returns unique available models when no host has the requested model', () => {
      insertRegistryModel(TEST_MODELS.QUALITY, 32);
      insertHost({
        name: 'Available One',
        models: [
          { name: TEST_MODELS.FAST, size: 256 * 1024 * 1024 },
          { name: TEST_MODELS.SMALL, size: 512 * 1024 * 1024 },
        ],
      });
      insertHost({
        name: 'Available Two',
        models: [{ name: TEST_MODELS.SMALL, size: 512 * 1024 * 1024 }],
      });

      const result = mod.selectOllamaHostForModel(TEST_MODELS.QUALITY);

      expect(result.host).toBeNull();
      expect(result.reason).toBe(`No host has model '${TEST_MODELS.QUALITY}' available`);
      expect(result.availableModels.sort()).toEqual([TEST_MODELS.FAST, TEST_MODELS.SMALL].sort());
      expect(result.modelTier).toBe('quality');
    });

    it('prefers tier-hinted hosts for known model tiers', () => {
      insertRegistryModel(TEST_MODELS.QUALITY, 32);
      const qualityHost = insertHost({
        id: 'quality-host',
        name: 'Quality Host',
        running_tasks: 1,
        models: [{ name: TEST_MODELS.QUALITY, size: 2 * 1024 * 1024 * 1024 }],
      });
      insertHost({
        id: 'fast-host',
        name: 'Fast Host',
        running_tasks: 0,
        models: [{ name: TEST_MODELS.QUALITY, size: 2 * 1024 * 1024 * 1024 }],
      });

      mod.setHostTierHint(qualityHost, 'quality');
      mod.setHostTierHint('fast-host', 'fast');

      const result = mod.selectOllamaHostForModel(TEST_MODELS.QUALITY);

      expect(result.modelTier).toBe('quality');
      expect(result.host.id).toBe(qualityHost);
    });

    it('honors excludeHostIds when selecting a matching host', () => {
      const excludedId = insertHost({
        name: 'Excluded Host',
        running_tasks: 0,
        models: [{ name: TEST_MODELS.FAST, size: 256 * 1024 * 1024 }],
      });
      const allowedId = insertHost({
        name: 'Allowed Host',
        running_tasks: 1,
        models: [{ name: TEST_MODELS.FAST, size: 256 * 1024 * 1024 }],
      });

      const result = mod.selectOllamaHostForModel(TEST_MODELS.FAST, {
        excludeHostIds: [excludedId],
      });

      expect(result.host.id).toBe(allowedId);
    });

    it('uses the default host memory limit config and suggests smaller fitting models', () => {
      db.setConfig('default_host_memory_limit_mb', '512');
      insertHost({
        name: 'Memory Bound',
        models: [
          { name: 'giant:70b', size: 2 * 1024 * 1024 * 1024 },
          { name: 'medium:8b', size: 400 * 1024 * 1024 },
          { name: 'small:3b', size: 128 * 1024 * 1024 },
        ],
      });

      const result = mod.selectOllamaHostForModel('giant:70b');

      expect(result.host).toBeNull();
      expect(result.memoryError).toBe(true);
      expect(result.modelSizeGb).toBe('2.00');
      expect(result.reason).toContain('exceeds memory limits');
      expect(result.suggestedModels).toEqual([
        { name: 'medium:8b', sizeGb: '0.39', host: 'Memory Bound' },
        { name: 'small:3b', sizeGb: '0.13', host: 'Memory Bound' },
      ]);
    });

    it('rejects unknown model sizes when reject_unknown_model_sizes is enabled', () => {
      db.setConfig('reject_unknown_model_sizes', '1');
      insertHost({
        name: 'Strict Unknown',
        memory_limit_mb: 1024,
        models: ['mystery-model:9b'],
      });

      const result = mod.selectOllamaHostForModel('mystery-model:9b');

      expect(result.host).toBeNull();
      expect(result.memoryError).toBe(true);
      expect(result.unknownSize).toBe(true);
      expect(result.reason).toContain('unknown size');
    });

    it('allows unknown model sizes when strict rejection is disabled', () => {
      const hostId = insertHost({
        name: 'Lenient Unknown',
        memory_limit_mb: 1024,
        models: ['mystery-model:9b'],
      });

      const result = mod.selectOllamaHostForModel('mystery-model:9b');

      expect(result.host.id).toBe(hostId);
      expect(result.memoryError).toBeUndefined();
    });
  });

  describe('selectHostWithModelVariant', () => {
    it('returns no host when no healthy hosts are available', () => {
      insertHost({
        enabled: false,
        status: 'healthy',
        models: [{ name: TEST_MODELS.SMALL, size: 512 * 1024 * 1024 }],
      });

      const result = mod.selectHostWithModelVariant(TEST_MODELS.SMALL.split(':')[0]);

      expect(result).toEqual({
        host: null,
        model: null,
        reason: 'No healthy Ollama hosts available',
      });
    });

    it('returns available model bases when no host has a matching variant', () => {
      insertHost({
        models: [{ name: TEST_MODELS.FAST, size: 256 * 1024 * 1024 }],
      });
      insertHost({
        models: [{ name: 'llama3.2:3b', size: 256 * 1024 * 1024 }],
      });

      const result = mod.selectHostWithModelVariant('nonexistent-model');

      expect(result.host).toBeNull();
      expect(result.model).toBeNull();
      expect(result.reason).toContain("No host has model matching 'nonexistent-model'");
      expect(result.availableModels.sort()).toEqual([TEST_MODELS.FAST.split(':')[0], 'llama3.2'].sort());
    });

    it('skips full hosts and performs weighted selection based on available slots', () => {
      db.setConfig('warm_host_preference', '0');

      insertHost({
        name: 'Already Full',
        running_tasks: 2,
        max_concurrent: 2,
        models: [{ name: TEST_MODELS.SMALL, size: 512 * 1024 * 1024 }],
      });
      insertHost({
        name: 'Many Slots',
        running_tasks: 0,
        max_concurrent: 6,
        models: [{ name: TEST_MODELS.SMALL, size: 512 * 1024 * 1024 }],
      });
      const chosenId = insertHost({
        name: 'One Slot',
        running_tasks: 5,
        max_concurrent: 6,
        models: [{ name: TEST_MODELS.SMALL, size: 512 * 1024 * 1024 }],
      });

      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);

      try {
        const result = mod.selectHostWithModelVariant(TEST_MODELS.SMALL.split(':')[0]);

        expect(result.host.id).toBe(chosenId);
        expect(result.model).toBe(TEST_MODELS.SMALL);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Already Full'));
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('applies warm host preference in weighted variant selection', () => {
      db.setConfig('warm_host_preference', '1');

      insertHost({
        name: 'Cold Host',
        running_tasks: 0,
        max_concurrent: 1,
        models: [{ name: TEST_MODELS.DEFAULT, size: 1024 * 1024 * 1024 }],
      });
      const warmHostId = insertHost({
        name: 'Warm Host',
        running_tasks: 0,
        max_concurrent: 1,
        models: [{ name: TEST_MODELS.DEFAULT, size: 1024 * 1024 * 1024 }],
        last_model_used: TEST_MODELS.DEFAULT,
        model_loaded_at: new Date(Date.now() - 30 * 1000).toISOString(),
      });

      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

      try {
        const result = mod.selectHostWithModelVariant(TEST_MODELS.DEFAULT.split(':')[0]);

        expect(result.host.id).toBe(warmHostId);
        expect(result.model).toBe(TEST_MODELS.DEFAULT);
        expect(result.reason).toContain('warm');
      } finally {
        randomSpy.mockRestore();
      }
    });
  });
});
