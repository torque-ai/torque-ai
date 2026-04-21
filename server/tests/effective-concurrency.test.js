'use strict';

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Module = require('module');
const { getEffectiveGlobalMaxConcurrent } = require('../execution/effective-concurrency.js');

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function createOptions(overrides = {}) {
  const safeConfigInt = vi.fn((key, defaultValue) => {
    const configValues = {
      max_ollama_concurrent: 8,
      max_codex_concurrent: 6,
      max_api_concurrent: 4,
      max_concurrent: 20,
      ...overrides.configValues,
    };
    return key in configValues ? configValues[key] : defaultValue;
  });

  const serverConfig = overrides.serverConfig ?? {
    getBool: vi.fn(() => false),
  };

  const db = overrides.db;
  const logger = overrides.logger ?? {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    preRead: overrides.preRead ?? {},
    safeConfigInt,
    serverConfig,
    db,
    logger,
  };
}

describe('execution/effective-concurrency', () => {
  it('concurrency handlers use injected database dependencies without loading the database facade', () => {
    const handlerPath = require.resolve('../handlers/concurrency-handlers');
    const containerPath = require.resolve('../container');
    const hostManagementPath = require.resolve('../db/host-management');
    const originalLoad = Module._load;
    const blockedRequests = [];
    const db = {
      prepare: vi.fn(() => ({
        all: vi.fn(() => []),
      })),
    };
    delete require.cache[handlerPath];
    installCjsModuleMock('../container', {
      defaultContainer: {
        get: vi.fn(() => {
          throw new Error('container db unavailable');
        }),
      },
    });
    installCjsModuleMock('../db/host-management', {
      getVramOverheadFactor: vi.fn(() => 0.75),
      listOllamaHosts: vi.fn(() => []),
    });
    const databaseLoadSpy = vi.spyOn(Module, '_load').mockImplementation(function patchedLoad(request, parent, isMain) {
      const parentFile = parent?.filename ? parent.filename.replace(/\\/g, '/') : '';
      if (request === '../database' && parentFile.endsWith('server/handlers/concurrency-handlers.js')) {
        blockedRequests.push(request);
        throw new Error('concurrency handler should not require database facade');
      }
      return originalLoad.call(this, request, parent, isMain);
    });

    try {
      const concurrencyHandlers = require('../handlers/concurrency-handlers');
      const injectedHandlers = concurrencyHandlers.createConcurrencyHandlers({ db });
      const result = injectedHandlers.handleGetConcurrencyLimits();

      expect(result.isError).toBeFalsy();
      expect(result.structuredData.providers).toEqual([]);
      expect(db.prepare).toHaveBeenCalledWith('SELECT provider, max_concurrent, enabled FROM provider_config ORDER BY provider');
      expect(blockedRequests).toEqual([]);
    } finally {
      databaseLoadSpy.mockRestore();
      delete require.cache[handlerPath];
      delete require.cache[containerPath];
      delete require.cache[hostManagementPath];
      vi.restoreAllMocks();
    }
  });

  it('returns configured max_concurrent when auto_compute is false and no db method exists', () => {
    const options = createOptions({
      configValues: {
        max_ollama_concurrent: 8,
        max_codex_concurrent: 6,
        max_api_concurrent: 4,
        max_concurrent: 11,
      },
      serverConfig: {
        getBool: vi.fn(() => false),
      },
      db: {},
    });

    const result = getEffectiveGlobalMaxConcurrent(options);

    expect(result).toBe(11);
    expect(options.serverConfig.getBool).toHaveBeenCalledWith('auto_compute_max_concurrent');
  });

  it('returns the larger of configured max_concurrent and provider sum when auto_compute is true', () => {
    const options = createOptions({
      configValues: {
        max_ollama_concurrent: 8,
        max_codex_concurrent: 6,
        max_api_concurrent: 4,
        max_concurrent: 10,
      },
      serverConfig: {
        getBool: vi.fn(() => true),
      },
    });

    const result = getEffectiveGlobalMaxConcurrent(options);

    expect(result).toBe(18);
  });

  it('uses preRead provider limits instead of calling safeConfigInt for those keys', () => {
    const options = createOptions({
      preRead: {
        maxOllamaConcurrent: 3,
        maxCodexConcurrent: 5,
        maxApiConcurrent: 7,
      },
      configValues: {
        max_concurrent: 10,
      },
      serverConfig: {
        getBool: vi.fn(() => true),
      },
    });

    const result = getEffectiveGlobalMaxConcurrent(options);

    expect(result).toBe(15);
    expect(options.safeConfigInt).toHaveBeenCalledTimes(1);
    expect(options.safeConfigInt).toHaveBeenCalledWith('max_concurrent', 20);
    expect(options.safeConfigInt).not.toHaveBeenCalledWith('max_ollama_concurrent', 8);
    expect(options.safeConfigInt).not.toHaveBeenCalledWith('max_codex_concurrent', 6);
    expect(options.safeConfigInt).not.toHaveBeenCalledWith('max_api_concurrent', 4);
  });

  it('uses db.getEffectiveMaxConcurrent when it returns a valid positive number', () => {
    const db = {
      getEffectiveMaxConcurrent: vi.fn(() => ({
        effectiveMaxConcurrent: 27,
      })),
    };
    const options = createOptions({
      configValues: {
        max_concurrent: 10,
      },
      serverConfig: {
        getBool: vi.fn(() => true),
      },
      db,
    });

    const result = getEffectiveGlobalMaxConcurrent(options);

    expect(result).toBe(27);
    expect(db.getEffectiveMaxConcurrent).toHaveBeenCalledWith({
      configuredMaxConcurrent: 10,
      autoComputeMaxConcurrent: true,
      logger: options.logger,
    });
  });

  it('falls back to config-based calculation when db.getEffectiveMaxConcurrent returns an invalid value', () => {
    const db = {
      getEffectiveMaxConcurrent: vi.fn(() => ({
        effectiveMaxConcurrent: 0,
      })),
    };
    const options = createOptions({
      configValues: {
        max_ollama_concurrent: 8,
        max_codex_concurrent: 6,
        max_api_concurrent: 4,
        max_concurrent: 10,
      },
      serverConfig: {
        getBool: vi.fn(() => true),
      },
      db,
    });

    const result = getEffectiveGlobalMaxConcurrent(options);

    expect(result).toBe(18);
  });
});
