'use strict';

const { createScoutProviderResolver } = require('../factory/scout-provider-resolver');

const ELIGIBLE = new Set(['codex', 'codex-spark', 'claude-cli', 'ollama', 'ollama-cloud']);

function makeResolver(overrides = {}) {
  const defaults = {
    eligibleProviders: ELIGIBLE,
    getProviderLanePolicyFromProject: () => null,
    getProjectDefaults: () => null,
    logger: { warn: vi.fn() },
  };
  return createScoutProviderResolver({ ...defaults, ...overrides });
}

describe('createScoutProviderResolver', () => {
  it('throws when eligibleProviders is missing or not a Set', () => {
    expect(() => createScoutProviderResolver({
      getProviderLanePolicyFromProject: () => null,
    })).toThrow(/eligibleProviders Set is required/);

    expect(() => createScoutProviderResolver({
      eligibleProviders: ['codex', 'ollama'],
      getProviderLanePolicyFromProject: () => null,
    })).toThrow(/eligibleProviders Set is required/);
  });

  it('throws when getProviderLanePolicyFromProject is missing', () => {
    expect(() => createScoutProviderResolver({
      eligibleProviders: ELIGIBLE,
    })).toThrow(/getProviderLanePolicyFromProject is required/);
  });

  it('returns lane policy provider when eligible (legacy path)', () => {
    const resolver = makeResolver({
      getProviderLanePolicyFromProject: () => ({ expected_provider: 'codex' }),
    });
    expect(resolver({ id: 'p1', path: '/proj' })).toBe('codex');
  });

  it('returns lane policy provider for ollama-cloud (existing eligibility)', () => {
    const resolver = makeResolver({
      getProviderLanePolicyFromProject: () => ({ expected_provider: 'ollama-cloud' }),
    });
    expect(resolver({ id: 'p1', path: '/proj' })).toBe('ollama-cloud');
  });

  it('returns lane policy provider for plain ollama (newly eligible)', () => {
    const resolver = makeResolver({
      getProviderLanePolicyFromProject: () => ({ expected_provider: 'ollama' }),
    });
    expect(resolver({ id: 'p1', path: '/proj' })).toBe('ollama');
  });

  it('rejects lane policy provider that is not in the eligible set', () => {
    const resolver = makeResolver({
      getProviderLanePolicyFromProject: () => ({ expected_provider: 'cerebras' }),
      // No project_defaults fallback set up — should return null.
    });
    expect(resolver({ id: 'p1', path: '/proj' })).toBe(null);
  });

  it('falls back to project_defaults.provider when no lane policy', () => {
    const getProjectDefaults = vi.fn().mockReturnValue({ provider: 'ollama' });
    const resolver = makeResolver({
      getProviderLanePolicyFromProject: () => null,
      getProjectDefaults,
    });
    expect(resolver({ id: 'p1', path: 'C:/proj' })).toBe('ollama');
    expect(getProjectDefaults).toHaveBeenCalledWith('C:/proj');
  });

  it('falls back to project_defaults.provider when lane policy has no expected_provider', () => {
    const getProjectDefaults = vi.fn().mockReturnValue({ provider: 'codex' });
    const resolver = makeResolver({
      getProviderLanePolicyFromProject: () => ({ allowed_providers: ['ollama'] }),
      getProjectDefaults,
    });
    expect(resolver({ id: 'p1', path: 'C:/proj' })).toBe('codex');
  });

  it('does NOT fall back to project_defaults when lane policy provider is set but ineligible', () => {
    // Design choice: an explicit lane policy is authoritative even when
    // it names an ineligible provider. We don't silently substitute.
    const getProjectDefaults = vi.fn().mockReturnValue({ provider: 'ollama' });
    const resolver = makeResolver({
      getProviderLanePolicyFromProject: () => ({ expected_provider: 'cerebras' }),
      getProjectDefaults,
    });
    expect(resolver({ id: 'p1', path: 'C:/proj' })).toBe(null);
    expect(getProjectDefaults).not.toHaveBeenCalled();
  });

  it('returns null when project_defaults provider is also ineligible', () => {
    const resolver = makeResolver({
      getProjectDefaults: () => ({ provider: 'deepinfra' }),
    });
    expect(resolver({ id: 'p1', path: 'C:/proj' })).toBe(null);
  });

  it('returns null when no project.path is available', () => {
    const getProjectDefaults = vi.fn().mockReturnValue({ provider: 'ollama' });
    const resolver = makeResolver({ getProjectDefaults });
    expect(resolver({ id: 'p1' })).toBe(null);
    expect(getProjectDefaults).not.toHaveBeenCalled();
  });

  it('handles null/undefined project gracefully', () => {
    const resolver = makeResolver();
    expect(resolver(null)).toBe(null);
    expect(resolver(undefined)).toBe(null);
    expect(resolver({})).toBe(null);
  });

  it('logs and returns null when getProjectDefaults throws', () => {
    const logger = { warn: vi.fn() };
    const getProjectDefaults = vi.fn(() => { throw new Error('db down'); });
    const resolver = makeResolver({ getProjectDefaults, logger });
    expect(resolver({ id: 'p1', path: 'C:/proj' })).toBe(null);
    expect(logger.warn).toHaveBeenCalledWith(
      'resolveScoutProvider: project_defaults lookup failed',
      expect.objectContaining({
        project_id: 'p1',
        project_path: 'C:/proj',
        err: 'db down',
      }),
    );
  });

  it('logs and continues when getProviderLanePolicyFromProject throws', () => {
    const logger = { warn: vi.fn() };
    const getProjectDefaults = vi.fn().mockReturnValue({ provider: 'ollama' });
    const resolver = makeResolver({
      getProviderLanePolicyFromProject: () => { throw new Error('parse error'); },
      getProjectDefaults,
      logger,
    });
    // Should still fall through to project_defaults
    expect(resolver({ id: 'p1', path: 'C:/proj' })).toBe('ollama');
    expect(logger.warn).toHaveBeenCalledWith(
      'resolveScoutProvider: lane policy lookup failed',
      expect.objectContaining({ project_id: 'p1', err: 'parse error' }),
    );
  });

  it('normalizes case and trims whitespace on provider strings', () => {
    const resolver = makeResolver({
      getProviderLanePolicyFromProject: () => ({ expected_provider: '  Ollama  ' }),
    });
    expect(resolver({ id: 'p1', path: 'C:/proj' })).toBe('ollama');
  });

  it('treats empty/non-string provider values as missing', () => {
    const resolver = makeResolver({
      getProviderLanePolicyFromProject: () => ({ expected_provider: '' }),
      getProjectDefaults: () => ({ provider: null }),
    });
    expect(resolver({ id: 'p1', path: 'C:/proj' })).toBe(null);
  });
});
