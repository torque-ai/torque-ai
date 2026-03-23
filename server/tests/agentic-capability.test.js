'use strict';

/**
 * agentic-capability.test.js — Tests for the 3-layer capability detection module.
 *
 * Covers: excluded providers, global config kill-switch, per-provider config overrides,
 * probe cache (DB), built-in whitelist, custom whitelist, and the default fallback.
 *
 * Strategy: import module once; re-call init() with fresh mocks in each test so module-level
 * state (_db, _serverConfig) is replaced without needing jest.resetModules().
 */

const mod = require('../providers/agentic-capability');
const { init, isAgenticCapable } = mod;

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

/** Mutable config store — reset in beforeEach */
let mockConfigStore = {};

/** Mutable probe result — reset in beforeEach */
let probeResult = undefined;

function makeMocks() {
  const serverConfig = {
    get: (key) => (mockConfigStore[key] !== undefined ? mockConfigStore[key] : null),
  };
  const db = {
    prepare: () => ({
      get: (_model, _provider) => probeResult,
    }),
  };
  return { serverConfig, db };
}

beforeEach(() => {
  mockConfigStore = {};
  probeResult = undefined;
  // Re-inject fresh mocks so each test starts with a clean state
  const { serverConfig, db } = makeMocks();
  init({ db, serverConfig });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isAgenticCapable — global kill switch', () => {
  it('returns false with source=config when agentic_enabled is "0"', () => {
    mockConfigStore['agentic_enabled'] = '0';
    const result = isAgenticCapable('ollama', 'qwen3-coder:30b');
    expect(result.capable).toBe(false);
    expect(result.source).toBe('config');
  });
});

describe('isAgenticCapable — excluded providers', () => {
  it('returns false for hashline-ollama with hashline reason', () => {
    const result = isAgenticCapable('hashline-ollama', 'qwen3-coder:30b');
    expect(result.capable).toBe(false);
    expect(result.reason).toBe('hashline protocol preferred');
    expect(result.source).toBe('config');
  });

  it('returns false for codex', () => {
    const result = isAgenticCapable('codex', 'gpt-4');
    expect(result.capable).toBe(false);
    expect(result.source).toBe('config');
    expect(result.reason).toContain('codex');
  });

  it('returns false for claude-cli', () => {
    const result = isAgenticCapable('claude-cli', 'claude-3-opus');
    expect(result.capable).toBe(false);
    expect(result.source).toBe('config');
    expect(result.reason).toContain('claude-cli');
  });

});

describe('isAgenticCapable — whitelist (built-in)', () => {
  it('returns true for qwen3-coder:30b on ollama — source=whitelist', () => {
    const result = isAgenticCapable('ollama', 'qwen3-coder:30b');
    expect(result.capable).toBe(true);
    expect(result.source).toBe('whitelist');
  });

  it('returns true for groq provider (cloud) — source=whitelist', () => {
    const result = isAgenticCapable('groq', 'llama-3.1-70b');
    expect(result.capable).toBe(true);
    expect(result.source).toBe('whitelist');
  });
});

describe('isAgenticCapable — per-provider config overrides', () => {
  it('returns false when per-provider override is "0" — source=config', () => {
    mockConfigStore['agentic_provider_ollama'] = '0';
    const result = isAgenticCapable('ollama', 'qwen3-coder:30b');
    expect(result.capable).toBe(false);
    expect(result.source).toBe('config');
  });

  it('returns true when per-provider override is "1" — source=config', () => {
    mockConfigStore['agentic_provider_ollama'] = '1';
    const result = isAgenticCapable('ollama', 'unknown-model:7b');
    expect(result.capable).toBe(true);
    expect(result.source).toBe('config');
  });

  it('converts hyphens to underscores for the key lookup (google-ai)', () => {
    mockConfigStore['agentic_provider_google_ai'] = '0';
    const result = isAgenticCapable('google-ai', 'gemini-pro');
    expect(result.capable).toBe(false);
    expect(result.source).toBe('config');
  });
});

describe('isAgenticCapable — unknown model default', () => {
  it('returns false for unknown model not on any whitelist — source=default', () => {
    const result = isAgenticCapable('ollama', 'totally-unknown-model:3b');
    expect(result.capable).toBe(false);
    expect(result.source).toBe('default');
    expect(result.reason).toBe('model not recognized as tool-capable');
  });
});

describe('isAgenticCapable — custom whitelist via config', () => {
  it('extends built-in whitelist with custom prefixes', () => {
    mockConfigStore['agentic_whitelist'] = 'phi3, deepseek';

    const phi3Result = isAgenticCapable('ollama', 'phi3:mini');
    expect(phi3Result.capable).toBe(true);
    expect(phi3Result.source).toBe('whitelist');

    const deepseekResult = isAgenticCapable('ollama', 'deepseek-coder:7b');
    expect(deepseekResult.capable).toBe(true);
    expect(deepseekResult.source).toBe('whitelist');
  });
});

describe('isAgenticCapable — probe cache', () => {
  it('returns true source=probe when DB returns supports_tools=1', () => {
    probeResult = { supports_tools: 1 };
    // Re-inject mocks so the probe closure captures the updated probeResult reference
    const { serverConfig, db } = makeMocks();
    init({ db, serverConfig });

    const result = isAgenticCapable('ollama', 'some-probed-model:7b');
    expect(result.capable).toBe(true);
    expect(result.source).toBe('probe');
  });

  it('returns false source=probe when DB returns supports_tools=0', () => {
    probeResult = { supports_tools: 0 };
    const { serverConfig, db } = makeMocks();
    init({ db, serverConfig });

    const result = isAgenticCapable('ollama', 'some-probed-model:7b');
    expect(result.capable).toBe(false);
    expect(result.source).toBe('probe');
  });
});

describe('module exports', () => {
  it('exports the expected constants and functions', () => {
    expect(typeof mod.isAgenticCapable).toBe('function');
    expect(typeof mod.init).toBe('function');
    expect(mod.EXCLUDED_PROVIDERS).toBeInstanceOf(Set);
    expect(mod.CLOUD_TOOL_CAPABLE).toBeInstanceOf(Set);
    expect(Array.isArray(mod.WHITELIST_PREFIXES)).toBe(true);
  });
});
