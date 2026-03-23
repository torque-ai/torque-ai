'use strict';

describe('server/config.js — unified config resolution', () => {
  let config;
  let mockConfigCore;
  const savedEnv = {};

  beforeEach(() => {
    // Fresh require to reset module state
    vi.resetModules();
    config = require('../config');
    mockConfigCore = require('../db/config-core');
    vi.spyOn(mockConfigCore, 'getConfig').mockReturnValue(null);
    vi.spyOn(mockConfigCore, 'setConfig').mockImplementation(() => {});

    // Save env vars we'll modify
    for (const key of Object.values(config.API_KEY_ENV_VARS)) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    savedEnv.TORQUE_DASHBOARD_PORT = process.env.TORQUE_DASHBOARD_PORT;
    delete process.env.TORQUE_DASHBOARD_PORT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  // ── get() ──────────────────────────────────────────────────────────────

  describe('get()', () => {
    it('returns DB value when available', () => {
      mockConfigCore.getConfig.mockReturnValueOnce('hello');
      expect(config.get('some_key')).toBe('hello');
    });

    it('returns registry default when DB returns null', () => {
      expect(config.get('dashboard_port')).toBe(3456);
    });

    it('returns explicit fallback when key not in registry or DB', () => {
      expect(config.get('unknown_key', 'fallback')).toBe('fallback');
    });

    it('returns null when key not found anywhere', () => {
      expect(config.get('unknown_key')).toBeNull();
    });

    it('prefers env var over DB value for registered keys', () => {
      process.env.TORQUE_DASHBOARD_PORT = '9999';
      mockConfigCore.getConfig.mockReturnValue('3456');
      expect(config.get('dashboard_port')).toBe('9999');
    });

    it('prefers DB value over registry default', () => {
      mockConfigCore.getConfig.mockReturnValue('4000');
      expect(config.get('dashboard_port')).toBe('4000');
    });
  });

  // ── getInt() ───────────────────────────────────────────────────────────

  describe('getInt()', () => {
    it('parses DB string value as integer', () => {
      mockConfigCore.getConfig.mockReturnValue('42');
      expect(config.getInt('max_concurrent')).toBe(42);
    });

    it('returns registry default when DB returns null', () => {
      expect(config.getInt('max_concurrent')).toBe(20);
    });

    it('returns explicit fallback for unregistered keys', () => {
      expect(config.getInt('unregistered_key', 99)).toBe(99);
    });

    it('returns 0 for NaN with no default', () => {
      mockConfigCore.getConfig.mockReturnValue('not-a-number');
      expect(config.getInt('unregistered_key')).toBe(0);
    });

    it('returns default for NaN when default exists', () => {
      mockConfigCore.getConfig.mockReturnValue('not-a-number');
      expect(config.getInt('max_concurrent')).toBe(20);
    });
  });

  // ── getFloat() ─────────────────────────────────────────────────────────

  describe('getFloat()', () => {
    it('parses float values', () => {
      mockConfigCore.getConfig.mockReturnValue('0.7');
      expect(config.getFloat('ollama_temperature')).toBeCloseTo(0.7);
    });

    it('returns registry default for null', () => {
      expect(config.getFloat('ollama_temperature')).toBeCloseTo(0.2);
    });
  });

  // ── getBool() ──────────────────────────────────────────────────────────

  describe('getBool() — opt-out semantics', () => {
    it('returns true by default (opt-out)', () => {
      expect(config.getBool('smart_routing_enabled')).toBe(true);
    });

    it('returns false when set to "0"', () => {
      mockConfigCore.getConfig.mockReturnValue('0');
      expect(config.getBool('smart_routing_enabled')).toBe(false);
    });

    it('returns false when set to "false"', () => {
      mockConfigCore.getConfig.mockReturnValue('false');
      expect(config.getBool('smart_routing_enabled')).toBe(false);
    });

    it('returns true for any other truthy value', () => {
      mockConfigCore.getConfig.mockReturnValue('1');
      expect(config.getBool('smart_routing_enabled')).toBe(true);
    });

    it('returns false for missing unregistered keys', () => {
      expect(config.getBool('missing_bool')).toBe(false);
    });
  });

  // ── isOptIn() ──────────────────────────────────────────────────────────

  describe('isOptIn() — opt-in semantics', () => {
    it('returns false by default', () => {
      expect(config.isOptIn('codex_enabled')).toBe(false);
    });

    it('returns true when set to "1"', () => {
      mockConfigCore.getConfig.mockReturnValue('1');
      expect(config.isOptIn('codex_enabled')).toBe(true);
    });

    it('returns true when set to "true"', () => {
      mockConfigCore.getConfig.mockReturnValue('true');
      expect(config.isOptIn('codex_enabled')).toBe(true);
    });

    it('returns false for "0"', () => {
      mockConfigCore.getConfig.mockReturnValue('0');
      expect(config.isOptIn('codex_enabled')).toBe(false);
    });
  });

  // ── getJson() ──────────────────────────────────────────────────────────

  describe('getJson()', () => {
    it('parses valid JSON', () => {
      mockConfigCore.getConfig.mockReturnValue('{"a":1}');
      expect(config.getJson('some_key')).toEqual({ a: 1 });
    });

    it('returns fallback for invalid JSON', () => {
      mockConfigCore.getConfig.mockReturnValue('not-json');
      expect(config.getJson('some_key', {})).toEqual({});
    });

    it('returns null for missing key with no fallback', () => {
      expect(config.getJson('missing_key')).toBeNull();
    });
  });

  // ── getApiKey() ────────────────────────────────────────────────────────

  describe('getApiKey()', () => {
    it('returns env var when set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-123';
      expect(config.getApiKey('anthropic')).toBe('sk-test-123');
    });

    it('falls back to DB config when env var not set', () => {
      mockConfigCore.getConfig.mockImplementation((key) => {
        if (key === 'anthropic_api_key') return 'db-key-456';
        return null;
      });
      expect(config.getApiKey('anthropic')).toBe('db-key-456');
    });

    it('prefers env var over DB', () => {
      process.env.DEEPINFRA_API_KEY = 'env-key';
      mockConfigCore.getConfig.mockReturnValue('db-key');
      expect(config.getApiKey('deepinfra')).toBe('env-key');
    });

    it('returns null when neither env nor DB has key', () => {
      expect(config.getApiKey('anthropic')).toBeNull();
    });

    it('handles hyphenated provider names', () => {
      process.env.GOOGLE_AI_API_KEY = 'google-key';
      expect(config.getApiKey('google-ai')).toBe('google-key');
    });
  });

  // ── hasApiKey() ────────────────────────────────────────────────────────

  describe('hasApiKey()', () => {
    it('returns true when key exists', () => {
      process.env.GROQ_API_KEY = 'key';
      expect(config.hasApiKey('groq')).toBe(true);
    });

    it('returns false when no key', () => {
      expect(config.hasApiKey('groq')).toBe(false);
    });
  });

  // ── getPort() ──────────────────────────────────────────────────────────

  describe('getPort()', () => {
    it('returns default port for known services', () => {
      expect(config.getPort('dashboard')).toBe(3456);
      expect(config.getPort('api')).toBe(3457);
      expect(config.getPort('mcp')).toBe(3458);
      expect(config.getPort('gpu')).toBe(9394);
    });

    it('returns DB-configured port', () => {
      mockConfigCore.getConfig.mockImplementation((key) => {
        if (key === 'api_port') return '8080';
        return null;
      });
      expect(config.getPort('api')).toBe(8080);
    });

    it('returns env var port over DB', () => {
      process.env.TORQUE_DASHBOARD_PORT = '5000';
      mockConfigCore.getConfig.mockReturnValue('3456');
      expect(config.getPort('dashboard')).toBe(5000);
    });

    it('returns 0 for unknown service', () => {
      expect(config.getPort('nonexistent')).toBe(0);
    });
  });

  // ── init() ─────────────────────────────────────────────────────────────

  describe('init()', () => {
    it('works without db', () => {
      vi.resetModules();
      const freshConfig = require('../config');
      freshConfig.init({});
      expect(freshConfig.get('unknown')).toBeNull();
    });
  });

  // ── REGISTRY ───────────────────────────────────────────────────────────

  describe('REGISTRY', () => {
    it('has types for all entries', () => {
      for (const [key, entry] of Object.entries(config.REGISTRY)) {
        expect(entry.type, `${key} missing type`).toBeDefined();
        expect(entry.default, `${key} missing default`).toBeDefined();
      }
    });

    it('has valid types', () => {
      const validTypes = ['int', 'float', 'bool', 'bool-optin', 'string'];
      for (const [key, entry] of Object.entries(config.REGISTRY)) {
        expect(validTypes, `${key} has invalid type: ${entry.type}`).toContain(entry.type);
      }
    });
  });
});
