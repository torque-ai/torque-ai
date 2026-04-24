'use strict';

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getEffectiveGlobalMaxConcurrent } = require('../execution/effective-concurrency.js');

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

  it('keeps the configured global cap even when auto_compute is true', () => {
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

    expect(result).toBe(10);
    expect(options.logger.warn).toHaveBeenCalledWith(
      '[Concurrency] Enabled provider limits sum to 18, but configured max_concurrent=10 is enforced as the global cap.',
    );
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

    expect(result).toBe(10);
    expect(options.safeConfigInt).toHaveBeenCalledTimes(1);
    expect(options.safeConfigInt).toHaveBeenCalledWith('max_concurrent', 20);
    expect(options.safeConfigInt).not.toHaveBeenCalledWith('max_ollama_concurrent', 8);
    expect(options.safeConfigInt).not.toHaveBeenCalledWith('max_codex_concurrent', 6);
    expect(options.safeConfigInt).not.toHaveBeenCalledWith('max_api_concurrent', 4);
    expect(options.logger.warn).toHaveBeenCalledWith(
      '[Concurrency] Enabled provider limits sum to 15, but configured max_concurrent=10 is enforced as the global cap.',
    );
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

    expect(result).toBe(10);
  });
});
