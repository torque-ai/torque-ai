'use strict';

test('getProviderCapabilitySet returns a Set', () => {
  const { createProviderCapabilities } = require('../db/provider-capabilities');
  const caps = createProviderCapabilities();
  const s = caps.getProviderCapabilitySet('codex');
  expect(s).toBeInstanceOf(Set);
  expect(s.size).toBeGreaterThan(0);
});

test('100 calls to getProviderCapabilitySet build the Set exactly once (cache hit)', () => {
  const { createProviderCapabilities } = require('../db/provider-capabilities');
  const caps = createProviderCapabilities();
  let buildCount = 0;
  const orig = caps.getProviderCapabilities.bind(caps);
  caps.getProviderCapabilities = (p) => { buildCount++; return orig(p); };
  for (let i = 0; i < 100; i++) caps.getProviderCapabilitySet('codex');
  // The cache is populated on first call; subsequent 99 calls skip getProviderCapabilities.
  expect(buildCount).toBe(1);
});

test('setDb clears the capability set cache', () => {
  const { createProviderCapabilities } = require('../db/provider-capabilities');
  const caps = createProviderCapabilities();
  caps.getProviderCapabilitySet('codex'); // populate cache
  const s1 = caps.getProviderCapabilitySet('codex');
  caps.setDb(null); // clear
  const s2 = caps.getProviderCapabilitySet('codex');
  // After setDb, a new Set is created — different reference
  expect(s1).not.toBe(s2);
});
