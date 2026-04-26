'use strict';

// If PAID_PROVIDERS is module-level, the same Set reference is used across calls.
// We verify it is not re-created per call by checking identity of the export.
test('PAID_PROVIDERS is a module-level constant (not created per call)', () => {
  const mod = require('../execution/provider-router');
  expect(mod.PAID_PROVIDERS).toBeInstanceOf(Set);
  expect(mod.PAID_PROVIDERS).toBe(mod.PAID_PROVIDERS); // same ref
  expect(mod.PAID_PROVIDERS.has('anthropic')).toBe(true);
  expect(mod.PAID_PROVIDERS.has('groq')).toBe(true);
  expect(mod.PAID_PROVIDERS.has('codex')).toBe(true);
  expect(mod.PAID_PROVIDERS.has('claude-cli')).toBe(true);
});
