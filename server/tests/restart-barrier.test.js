'use strict';

const { describe, it, expect } = require('vitest');
const providerRegistry = require('../providers/registry');

describe('system provider category', () => {
  it('recognizes system as a known provider', () => {
    expect(providerRegistry.isKnownProvider('system')).toBe(true);
  });

  it('categorizes system in its own category', () => {
    expect(providerRegistry.getCategory('system')).toBe('system');
  });

  it('does not include system in ollama, codex, or api categories', () => {
    expect(providerRegistry.isOllamaProvider('system')).toBe(false);
    expect(providerRegistry.isCodexProvider('system')).toBe(false);
    expect(providerRegistry.isApiProvider('system')).toBe(false);
  });
});
