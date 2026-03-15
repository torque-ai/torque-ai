'use strict';
/* global describe, it, expect, beforeEach, afterEach */

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const MODULE_PATH = '../policy-engine/shadow-enforcer';
const LOGGER_PATH = '../logger';

const mockLogger = {
  child() {
    return mockLogger;
  },
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function loadShadowEnforcer() {
  installMock(LOGGER_PATH, mockLogger);
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

describe('policy-engine/shadow-enforcer', () => {
  let shadowEnforcer;
  let config;

  function setConfig(overrides = {}) {
    config = {
      policy_engine_enabled: '0',
      policy_engine_shadow_only: '1',
      policy_block_mode_enabled: '0',
      ...overrides,
    };
    shadowEnforcer.setConfigReader((key) => config[key]);
  }

  beforeEach(() => {
    shadowEnforcer = loadShadowEnforcer();
    setConfig();
  });

  afterEach(() => {
    delete require.cache[require.resolve(MODULE_PATH)];
  });

  it('setConfigReader injects the config function used by the readers', () => {
    const requestedKeys = [];

    shadowEnforcer.setConfigReader((key) => {
      requestedKeys.push(key);
      return key === 'policy_engine_enabled' ? '1' : undefined;
    });

    expect(shadowEnforcer.isEngineEnabled()).toBe(true);
    expect(requestedKeys).toEqual(['policy_engine_enabled']);
  });

  describe('isEngineEnabled()', () => {
    it('returns false when no config reader is installed', () => {
      shadowEnforcer = loadShadowEnforcer();

      expect(shadowEnforcer.isEngineEnabled()).toBe(false);
    });

    it('returns true only when the engine flag is enabled', () => {
      setConfig({ policy_engine_enabled: '1' });
      expect(shadowEnforcer.isEngineEnabled()).toBe(true);

      setConfig({ policy_engine_enabled: '0' });
      expect(shadowEnforcer.isEngineEnabled()).toBe(false);
    });
  });

  describe('isShadowOnly()', () => {
    it('returns true when shadow-only mode is enabled', () => {
      setConfig({ policy_engine_shadow_only: '1' });

      expect(shadowEnforcer.isShadowOnly()).toBe(true);
    });

    it('returns false when shadow-only mode is disabled', () => {
      setConfig({ policy_engine_shadow_only: '0' });

      expect(shadowEnforcer.isShadowOnly()).toBe(false);
    });

    it('defaults to true when no config reader is installed', () => {
      shadowEnforcer = loadShadowEnforcer();

      expect(shadowEnforcer.isShadowOnly()).toBe(true);
    });
  });

  describe('isBlockModeEnabled()', () => {
    it('returns true when block mode is enabled', () => {
      setConfig({ policy_block_mode_enabled: '1' });

      expect(shadowEnforcer.isBlockModeEnabled()).toBe(true);
    });

    it('returns false when block mode is disabled or no reader is installed', () => {
      setConfig({ policy_block_mode_enabled: '0' });
      expect(shadowEnforcer.isBlockModeEnabled()).toBe(false);

      shadowEnforcer = loadShadowEnforcer();
      expect(shadowEnforcer.isBlockModeEnabled()).toBe(false);
    });
  });

  describe('enforceMode()', () => {
    it('returns off when the engine is disabled', () => {
      setConfig({
        policy_engine_enabled: '0',
        policy_engine_shadow_only: '0',
        policy_block_mode_enabled: '1',
      });

      expect(shadowEnforcer.enforceMode('block')).toBe('off');
    });

    it('returns shadow when the engine is shadow-only', () => {
      setConfig({
        policy_engine_enabled: '1',
        policy_engine_shadow_only: '1',
        policy_block_mode_enabled: '1',
      });

      expect(shadowEnforcer.enforceMode('warn')).toBe('shadow');
    });

    it('downgrades block requests to warn when block mode is disabled', () => {
      setConfig({
        policy_engine_enabled: '1',
        policy_engine_shadow_only: '0',
        policy_block_mode_enabled: '0',
      });

      expect(shadowEnforcer.enforceMode('block')).toBe('warn');
    });

    it('returns the requested mode when enforcement is fully enabled', () => {
      setConfig({
        policy_engine_enabled: '1',
        policy_engine_shadow_only: '0',
        policy_block_mode_enabled: '1',
      });

      expect(shadowEnforcer.enforceMode('block')).toBe('block');
      expect(shadowEnforcer.enforceMode('warn')).toBe('warn');
    });
  });
});
