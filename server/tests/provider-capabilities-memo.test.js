'use strict';

test('getProviderCapabilitySet returns a Set', () => {
  const { createProviderCapabilities } = require('../db/provider/capabilities');
  const caps = createProviderCapabilities();
  const s = caps.getProviderCapabilitySet('codex');
  expect(s).toBeInstanceOf(Set);
  expect(s.size).toBeGreaterThan(0);
});

test('100 calls to getProviderCapabilitySet return the exact same Set reference (cache hit)', () => {
  const { createProviderCapabilities } = require('../db/provider/capabilities');
  const caps = createProviderCapabilities();
  // The first call builds and caches the Set; all subsequent calls return the same reference.
  const first = caps.getProviderCapabilitySet('codex');
  for (let i = 1; i < 100; i++) {
    const s = caps.getProviderCapabilitySet('codex');
    expect(s).toBe(first); // exact same Set object — cache hit
  }
});

test('setDb clears the capability set cache', () => {
  const { createProviderCapabilities } = require('../db/provider/capabilities');
  const caps = createProviderCapabilities();
  caps.getProviderCapabilitySet('codex'); // populate cache
  const s1 = caps.getProviderCapabilitySet('codex');
  caps.setDb(null); // clear
  const s2 = caps.getProviderCapabilitySet('codex');
  // After setDb, a new Set is created — different reference
  expect(s1).not.toBe(s2);
});
