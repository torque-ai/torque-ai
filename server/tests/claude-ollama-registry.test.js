'use strict';

const { PROVIDER_CATEGORIES, ALL_PROVIDERS, getCategory } = require('../providers/registry');
const { PROVIDER_DEFAULTS } = require('../constants');

describe('providers/registry — claude-ollama', () => {
  it('claude-ollama is categorized under codex (CLI-spawned)', () => {
    expect(PROVIDER_CATEGORIES.codex).toContain('claude-ollama');
  });
  it('claude-ollama appears in ALL_PROVIDERS', () => {
    expect(ALL_PROVIDERS.has('claude-ollama')).toBe(true);
  });
  it('getCategory("claude-ollama") returns "codex"', () => {
    expect(getCategory('claude-ollama')).toBe('codex');
  });
});

describe('constants.PROVIDER_DEFAULTS — claude-ollama', () => {
  it('claude-ollama default is disabled', () => {
    const entry = PROVIDER_DEFAULTS['claude-ollama'];
    expect(entry).toBeDefined();
    expect(entry.enabled).toBe(false);
  });
});
