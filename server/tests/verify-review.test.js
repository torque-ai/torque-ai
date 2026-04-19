'use strict';

describe('verify-review module exports', () => {
  it('exports reviewVerifyFailure, detectEnvironmentFailure, parseFailingTests, getModifiedFiles, runLlmTiebreak, and constants', () => {
    const mod = require('../factory/verify-review');
    expect(typeof mod.reviewVerifyFailure).toBe('function');
    expect(typeof mod.detectEnvironmentFailure).toBe('function');
    expect(typeof mod.parseFailingTests).toBe('function');
    expect(typeof mod.getModifiedFiles).toBe('function');
    expect(typeof mod.runLlmTiebreak).toBe('function');
    expect(mod.LLM_TIMEOUT_MS).toBe(60_000);
    expect(mod.ENVIRONMENT_EXIT_CODES).toBeInstanceOf(Set);
    expect(Array.isArray(mod.ENVIRONMENT_STDERR_PATTERNS)).toBe(true);
  });
});
