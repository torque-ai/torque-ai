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
