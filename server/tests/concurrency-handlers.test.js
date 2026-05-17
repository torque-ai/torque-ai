'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

// Validates that getConcurrencyLimits uses the database facade's
// getAllProviderConfigs() helper rather than issuing raw SQL directly.

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function removeCjsModuleMock(...modulePaths) {
  for (const p of modulePaths) {
    try {
      delete require.cache[require.resolve(p)];
    } catch (_) {
      // ignore
    }
  }
}

vi.mock('../container', () => ({ defaultContainer: {} }));

describe('concurrency-handlers — getAllProviderConfigs facade usage', () => {
  let handlers;
  let getAllProviderConfigsSpy;

  beforeEach(() => {
    const providerRows = [
      { provider: 'codex', max_concurrent: 2, enabled: 1 },
      { provider: 'ollama', max_concurrent: 4, enabled: 1 },
    ];

    getAllProviderConfigsSpy = vi.fn(() => providerRows);

    const facade = {
      getAllProviderConfigs: getAllProviderConfigsSpy,
      // getDbInstance intentionally omitted — getConcurrencyLimits should not
      // need the raw handle for the provider query anymore.
    };

    const mockContainer = {
      has: (name) => name === 'db',
      get: (name) => (name === 'db' ? facade : null),
      peek: (name) => (name === 'db' ? facade : undefined),
    };

    installCjsModuleMock('../container', { defaultContainer: mockContainer });
    removeCjsModuleMock('../handlers/concurrency-handlers');
    handlers = require('../handlers/concurrency-handlers');
  });

  afterEach(() => {
    removeCjsModuleMock('../container', '../handlers/concurrency-handlers');
    getAllProviderConfigsSpy = null;
  });

  it('getConcurrencyLimits calls facade.getAllProviderConfigs()', () => {
    const result = handlers.handleGetConcurrencyLimits();
    expect(getAllProviderConfigsSpy).toHaveBeenCalledTimes(1);

    const text = result?.content?.[0]?.text || '';
    expect(text).not.toMatch(/Failed to get/);

    const data = JSON.parse(text);
    expect(data.providers).toHaveLength(2);

    const codex = data.providers.find((p) => p.provider === 'codex');
    expect(codex).toBeTruthy();
    expect(codex.max_concurrent).toBe(2);

    const ollama = data.providers.find((p) => p.provider === 'ollama');
    expect(ollama).toBeTruthy();
    expect(ollama.max_concurrent).toBe(4);
  });

  it('getConcurrencyLimits does not call getDbInstance for provider query', () => {
    const getDbInstanceSpy = vi.fn();
    const facade = {
      getAllProviderConfigs: () => [{ provider: 'test', max_concurrent: 1, enabled: 1 }],
      getDbInstance: getDbInstanceSpy,
    };

    const mockContainer = {
      has: (name) => name === 'db',
      get: (name) => (name === 'db' ? facade : null),
      peek: (name) => (name === 'db' ? facade : undefined),
    };

    installCjsModuleMock('../container', { defaultContainer: mockContainer });
    removeCjsModuleMock('../handlers/concurrency-handlers');
    const freshHandlers = require('../handlers/concurrency-handlers');

    freshHandlers.handleGetConcurrencyLimits();

    // getDbInstance should NOT be called for the provider listing path
    expect(getDbInstanceSpy).not.toHaveBeenCalled();
  });
});

// Tests for effective-concurrency fallback behavior
describe('concurrency-handlers — effective-concurrency fallback tests', () => {
  let effectiveConcurrencyModule;
  let safeConfigInt;
  let serverConfig;
  let db;
  let logger;
  let warningCache;

  beforeEach(() => {
    const require = createRequire(import.meta.url);
    effectiveConcurrencyModule = require('../execution/effective-concurrency.js');
    
    safeConfigInt = vi.fn((key, defaultValue) => {
      const configValues = {
        max_ollama_concurrent: 8,
        max_codex_concurrent: 6,
        max_api_concurrent: 4,
        max_concurrent: 20,
      };
      return key in configValues ? configValues[key] : defaultValue;
    });

    serverConfig = {
      getBool: vi.fn(() => false),
    };

    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    warningCache = new Set();
  });

  it('returns configured max_concurrent when db.getEffectiveMaxConcurrent returns invalid value', () => {
    db = {
      getEffectiveMaxConcurrent: vi.fn(() => ({
        effectiveMaxConcurrent: 0,
      })),
    };

    const result = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db,
      logger,
      warningCache,
    });

    expect(result).toBe(20);
    expect(db.getEffectiveMaxConcurrent).toHaveBeenCalledWith({
      configuredMaxConcurrent: 20,
      autoComputeMaxConcurrent: false,
      logger,
    });
  });

  it('returns configured max_concurrent when db.getEffectiveMaxConcurrent returns negative value', () => {
    db = {
      getEffectiveMaxConcurrent: vi.fn(() => ({
        effectiveMaxConcurrent: -5,
      })),
    };

    const result = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db,
      logger,
      warningCache,
    });

    expect(result).toBe(20);
  });

  it('returns configured max_concurrent when db.getEffectiveMaxConcurrent returns non-numeric value', () => {
    db = {
      getEffectiveMaxConcurrent: vi.fn(() => ({
        effectiveMaxConcurrent: 'invalid',
      })),
    };

    const result = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db,
      logger,
      warningCache,
    });

    expect(result).toBe(20);
  });

  it('returns configured max_concurrent when db.getEffectiveMaxConcurrent is not a function', () => {
    db = {
      getEffectiveMaxConcurrent: null,
    };

    const result = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db,
      logger,
      warningCache,
    });

    expect(result).toBe(20);
  });

  it('returns configured max_concurrent when db is undefined', () => {
    db = undefined;

    const result = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db,
      logger,
      warningCache,
    });

    expect(result).toBe(20);
  });

  it('uses db.getEffectiveMaxConcurrent when it returns a valid positive number', () => {
    db = {
      getEffectiveMaxConcurrent: vi.fn(() => ({
        effectiveMaxConcurrent: 27,
      })),
    };

    const result = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig: { getBool: vi.fn(() => true) },
      db,
      logger,
      warningCache,
    });

    expect(result).toBe(27);
    expect(db.getEffectiveMaxConcurrent).toHaveBeenCalledWith({
      configuredMaxConcurrent: 20,
      autoComputeMaxConcurrent: true,
      logger,
    });
  });

  it('warns once when auto_compute is true and provider sum exceeds cap', () => {
    serverConfig = {
      getBool: vi.fn(() => true),
    };

    const result = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db: {},
      logger,
      warningCache,
    });

    expect(result).toBe(20);
    expect(logger.warn).toHaveBeenCalledWith(
      '[Concurrency] Enabled provider limits sum to 18, but configured max_concurrent=20 is enforced as the global cap.',
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates warnings using warningCache', () => {
    const warningCache = new Set();
    serverConfig = {
      getBool: vi.fn(() => true),
    };

    const result1 = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db: {},
      logger,
      warningCache,
    });

    const result2 = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db: {},
      logger,
      warningCache,
    });

    expect(result1).toBe(20);
    expect(result2).toBe(20);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('returns configured max_concurrent when db.getEffectiveMaxConcurrent returns null', () => {
    db = {
      getEffectiveMaxConcurrent: vi.fn(() => null),
    };

    const result = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db,
      logger,
      warningCache,
    });

    expect(result).toBe(20);
  });

  it('returns configured max_concurrent when db.getEffectiveMaxConcurrent returns undefined', () => {
    db = {
      getEffectiveMaxConcurrent: vi.fn(() => undefined),
    };

    const result = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db,
      logger,
      warningCache,
    });

    expect(result).toBe(20);
  });

  it('returns configured max_concurrent when db.getEffectiveMaxConcurrent returns NaN', () => {
    db = {
      getEffectiveMaxConcurrent: vi.fn(() => ({
        effectiveMaxConcurrent: NaN,
      })),
    };

    const result = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db,
      logger,
      warningCache,
    });

    expect(result).toBe(20);
  });

  it('returns configured max_concurrent when db.getEffectiveMaxConcurrent throws an exception', () => {
    db = {
      getEffectiveMaxConcurrent: vi.fn(() => {
        throw new Error('DB error');
      }),
    };

    const result = effectiveConcurrencyModule.getEffectiveGlobalMaxConcurrent({
      safeConfigInt,
      serverConfig,
      db,
      logger,
      warningCache,
    });

    expect(result).toBe(20);
  });
});
