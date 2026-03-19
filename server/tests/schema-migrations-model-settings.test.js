'use strict';
/* global describe, it, expect, beforeEach */

/**
 * Tests for the ollama_model_settings merge semantics in schema-migrations.js.
 *
 * The migration that sets default temperatures for qwen2.5-coder:32b and
 * codestral:22b must preserve any existing user customizations rather than
 * unconditionally overwriting them.
 */

const { runMigrations } = require('../db/schema-migrations');

/**
 * Build a minimal in-memory config store with getConfig/setConfig.
 */
function makeConfig(initial = {}) {
  const store = { ...initial };
  return {
    getConfig: (key) => store[key] ?? null,
    setConfig: (key, value) => { store[key] = value; },
    store,
  };
}

/**
 * Build stub helpers that satisfy runMigrations without a real DB.
 * safeAddColumn is a no-op; db.exec / db.prepare are stubs.
 */
function makeStubs() {
  const prepareStub = {
    run: function () {},
    get: function () { return null; },
    all: function () { return []; },
  };
  const db = {
    exec: function () {},
    prepare: function () { return prepareStub; },
    pragma: function () {},
  };
  const logger = { debug: function () {} };
  const safeAddColumn = function () {};
  return { db, logger, safeAddColumn };
}

describe('schema-migrations: ollama_model_settings merge semantics', () => {
  let db, logger, safeAddColumn;

  beforeEach(() => {
    ({ db, logger, safeAddColumn } = makeStubs());
  });

  it('writes defaults when no existing settings are present', () => {
    const { getConfig, setConfig, store } = makeConfig();

    runMigrations(db, logger, safeAddColumn, { getConfig, setConfig });

    const result = JSON.parse(store['ollama_model_settings'] || 'null');
    expect(result).not.toBeNull();
    expect(result['qwen2.5-coder:32b']).toBeDefined();
    expect(result['codestral:22b']).toBeDefined();
  });

  it('preserves custom settings when user has customized qwen2.5-coder:32b with num_ctx=16384', () => {
    // R115 (line ~295) leaves the entry alone when num_ctx === 16384.
    // After R115 runs, the R-hashline migration must also leave existing values intact.
    const customSettings = {
      'qwen2.5-coder:32b': { temperature: 0.42, num_ctx: 16384, description: 'my custom config' },
      // Give codestral temperature=0.2 so R115 also leaves it alone
      'codestral:22b': { temperature: 0.2, num_ctx: 8192 },
    };
    const { getConfig, setConfig, store } = makeConfig({
      'ollama_model_settings': JSON.stringify(customSettings),
    });

    runMigrations(db, logger, safeAddColumn, { getConfig, setConfig });

    const result = JSON.parse(store['ollama_model_settings']);
    // The R-hashline merge must not overwrite values already present
    expect(result['qwen2.5-coder:32b'].temperature).toBe(0.42);
    expect(result['qwen2.5-coder:32b'].num_ctx).toBe(16384);
    expect(result['qwen2.5-coder:32b'].description).toBe('my custom config');
    // codestral kept its temperature
    expect(result['codestral:22b'].temperature).toBe(0.2);
  });

  it('adds default model keys when they are absent from existing settings', () => {
    // Only has a user-defined third model; no entry for qwen2.5-coder or codestral
    const customSettings = {
      'llama3:8b': { temperature: 0.5 },
    };
    const { getConfig, setConfig, store } = makeConfig({
      'ollama_model_settings': JSON.stringify(customSettings),
    });

    runMigrations(db, logger, safeAddColumn, { getConfig, setConfig });

    const result = JSON.parse(store['ollama_model_settings']);
    // Default entries should be present now
    expect(result['qwen2.5-coder:32b']).toBeDefined();
    expect(result['codestral:22b']).toBeDefined();
    // Original user model must still be present
    expect(result['llama3:8b']).toEqual({ temperature: 0.5 });
  });

  it('overwrites with defaults when existing value is corrupted JSON', () => {
    const { getConfig, setConfig, store } = makeConfig({
      'ollama_model_settings': 'NOT_VALID_JSON{{{{',
    });

    runMigrations(db, logger, safeAddColumn, { getConfig, setConfig });

    // After corruption, the migration must still write valid defaults
    const result = JSON.parse(store['ollama_model_settings']);
    expect(result['qwen2.5-coder:32b']).toBeDefined();
    expect(result['codestral:22b']).toBeDefined();
  });

  it('does not mutate user settings that were set after an earlier migration', () => {
    // Simulate a user who added 'codestral:22b' settings from a later migration
    // (e.g., the R115 migration which sets more complete settings)
    const advancedSettings = {
      'qwen2.5-coder:32b': {
        temperature: 0.2, top_k: 30, num_ctx: 16384, repeat_penalty: 1.15,
        description: 'Quality tier — complex tasks, multi-requirement code gen'
      },
      'codestral:22b': {
        temperature: 0.2, top_k: 30, num_ctx: 8192, repeat_penalty: 1.1,
        description: 'Fast tier — simple/medium tasks, speed over completeness'
      },
    };
    const { getConfig, setConfig, store } = makeConfig({
      'ollama_model_settings': JSON.stringify(advancedSettings),
    });

    runMigrations(db, logger, safeAddColumn, { getConfig, setConfig });

    const result = JSON.parse(store['ollama_model_settings']);
    // The richer settings from the later migration must not be overwritten
    expect(result['qwen2.5-coder:32b'].num_ctx).toBe(16384);
    expect(result['qwen2.5-coder:32b'].top_k).toBe(30);
    expect(result['codestral:22b'].num_ctx).toBe(8192);
    expect(result['codestral:22b'].description).toBe(
      'Fast tier — simple/medium tasks, speed over completeness'
    );
  });
});
