'use strict';

const { VALID_CONFIG_KEYS } = require('../db/config-keys');

describe('db/config-keys', () => {
  it('exports VALID_CONFIG_KEYS as a Set', () => {
    expect(VALID_CONFIG_KEYS).toBeInstanceOf(Set);
  });

  it('contains expected known config keys', () => {
    expect(VALID_CONFIG_KEYS.has('default_provider')).toBe(true);
    expect(VALID_CONFIG_KEYS.has('max_concurrent')).toBe(true);
    expect(VALID_CONFIG_KEYS.has('ollama_host')).toBe(true);
    expect(VALID_CONFIG_KEYS.has('scheduling_mode')).toBe(true);
  });

  it('does not contain arbitrary invalid keys', () => {
    expect(VALID_CONFIG_KEYS.has('totally_invalid_key')).toBe(false);
    expect(VALID_CONFIG_KEYS.has('default-provider')).toBe(false);
    expect(VALID_CONFIG_KEYS.has('')).toBe(false);
  });

  it('stores only non-empty strings', () => {
    for (const key of VALID_CONFIG_KEYS) {
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('has a reasonable number of known keys', () => {
    expect(VALID_CONFIG_KEYS.size).toBeGreaterThan(100);
  });

  it('contains no blank or whitespace-only keys', () => {
    for (const key of VALID_CONFIG_KEYS) {
      expect(key.trim()).toBe(key);
      expect(key.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses unique entries for all known keys', () => {
    const entries = Array.from(VALID_CONFIG_KEYS);
    expect(new Set(entries).size).toBe(entries.length);
  });
});
