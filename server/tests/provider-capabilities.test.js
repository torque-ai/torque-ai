'use strict';

const providerCapabilities = require('../db/provider/capabilities');

describe('provider-capabilities', () => {
  beforeEach(() => {
    providerCapabilities.setDb(null);
  });

  afterEach(() => {
    providerCapabilities.setDb(null);
  });

  describe('getProviderCapabilities', () => {
    it('returns tags for a known provider and an empty array for unknown providers', () => {
      expect(providerCapabilities.getProviderCapabilities('codex')).toEqual([
        'file_creation',
        'file_edit',
        'multi_file',
        'reasoning',
      ]);
      expect(providerCapabilities.getProviderCapabilities('ollama-cloud')).toEqual([
        'file_creation',
        'file_edit',
        'multi_file',
        'reasoning',
        'large_context',
        'code_review',
      ]);
      expect(providerCapabilities.getProviderCapabilities('does-not-exist')).toEqual([]);
    });

    it('prefers capability tags from the injected db provider config', () => {
      providerCapabilities.setDb({
        getProvider(provider) {
          if (provider !== 'codex') return null;
          return {
            capability_tags: JSON.stringify(['db_tag', 'reasoning']),
          };
        },
      });

      expect(providerCapabilities.getProviderCapabilities('codex')).toEqual(['db_tag', 'reasoning']);
    });
  });

  describe('getQualityBand', () => {
    it('returns the default quality band mapping for known providers', () => {
      expect(providerCapabilities.getQualityBand('codex')).toBe('A');
      expect(providerCapabilities.getQualityBand('deepinfra')).toBe('B');
      expect(providerCapabilities.getQualityBand('ollama-cloud')).toBe('B');
      expect(providerCapabilities.getQualityBand('groq')).toBe('D');
    });

    it('prefers quality_band from the injected db provider config', () => {
      providerCapabilities.setDb({
        getProvider(provider) {
          if (provider !== 'codex') return null;
          return { quality_band: 'C' };
        },
      });

      expect(providerCapabilities.getQualityBand('codex')).toBe('C');
    });
  });

  describe('meetsCapabilityRequirements', () => {
    it('matches when a provider satisfies a single requirement', () => {
      expect(providerCapabilities.meetsCapabilityRequirements('codex', ['file_creation'])).toBe(true);
    });

    it('fails when a provider does not satisfy a required capability', () => {
      expect(providerCapabilities.meetsCapabilityRequirements('ollama', ['file_creation'])).toBe(false);
    });

    it('treats empty requirements as matching any provider', () => {
      expect(providerCapabilities.meetsCapabilityRequirements('ollama', [])).toBe(true);
      expect(providerCapabilities.meetsCapabilityRequirements('ollama', null)).toBe(true);
    });

    it('requires all capabilities to be present for multi-capability checks', () => {
      expect(providerCapabilities.meetsCapabilityRequirements('codex', ['file_creation', 'multi_file'])).toBe(true);
      expect(providerCapabilities.meetsCapabilityRequirements('codex', ['file_creation', 'large_context'])).toBe(false);
    });
  });

  describe('passesQualityGate', () => {
    it('allows band A for complex work', () => {
      expect(providerCapabilities.passesQualityGate('A', 'complex')).toBe(true);
    });

    it('blocks band C for complex work', () => {
      expect(providerCapabilities.passesQualityGate('C', 'complex')).toBe(false);
    });

    it('allows band C for normal work', () => {
      expect(providerCapabilities.passesQualityGate('C', 'normal')).toBe(true);
    });

    it('never allows band D through the configured quality gates', () => {
      expect(providerCapabilities.passesQualityGate('D', 'complex')).toBe(false);
      expect(providerCapabilities.passesQualityGate('D', 'normal')).toBe(false);
      expect(providerCapabilities.passesQualityGate('D', 'simple')).toBe(false);
    });
  });

  describe('inferCapabilityRequirements', () => {
    it('infers file_creation from create language', () => {
      expect(providerCapabilities.inferCapabilityRequirements('Create a new API handler')).toEqual(['file_creation']);
    });

    it('infers file_edit from fix language', () => {
      expect(providerCapabilities.inferCapabilityRequirements('Fix the broken retry logic')).toEqual(['file_edit']);
    });

    it('infers both code_review and reasoning for review work', () => {
      expect(providerCapabilities.inferCapabilityRequirements('Review the authentication flow')).toEqual([
        'code_review',
        'reasoning',
      ]);
    });

    it('infers multi_file for refactors across files', () => {
      expect(providerCapabilities.inferCapabilityRequirements('Refactor across multiple files in the scheduler')).toEqual([
        'file_edit',
        'multi_file',
      ]);
    });

    it('returns an empty list for generic descriptions with no matching patterns', () => {
      expect(providerCapabilities.inferCapabilityRequirements('Run it')).toEqual([]);
    });
  });

  describe('generateEligibleProviders', () => {
    it('returns codex first for complex file_creation work and excludes unsupported providers', () => {
      const providers = providerCapabilities.generateEligibleProviders({
        capabilityRequirements: ['file_creation'],
        qualityTier: 'complex',
      });

      expect(providers[0]).toBe('codex');
      expect(providers).toContain('claude-cli');
      expect(providers).toContain('ollama-cloud');
      expect(providers).not.toContain('ollama');
      expect(providers).not.toContain('groq');
    });

    it('returns a broad simple-tier list while excluding band D providers', () => {
      const providers = providerCapabilities.generateEligibleProviders({
        qualityTier: 'simple',
      });

      expect(providers).toContain('codex');
      expect(providers).toContain('ollama');
      expect(providers).toContain('deepinfra');
      expect(providers).not.toContain('groq');
      expect(providers).not.toContain('cerebras');
      expect(providers).not.toContain('google-ai');
    });

    it('uses db-backed enablement checks and empirical ranking within the same band', () => {
      providerCapabilities.setDb({
        getProvider(provider) {
          if (provider === 'codex') {
            return {
              enabled: 1,
              capability_tags: ['file_creation', 'file_edit', 'multi_file', 'reasoning'],
              quality_band: 'A',
            };
          }
          if (provider === 'claude-cli') {
            return {
              enabled: 0,
              capability_tags: ['file_creation', 'file_edit', 'multi_file', 'reasoning'],
              quality_band: 'A',
            };
          }
          if (provider === 'claude-code-sdk') {
            return {
              enabled: 0,
              capability_tags: ['file_creation', 'file_edit', 'multi_file', 'reasoning'],
              quality_band: 'A',
            };
          }
          return { enabled: 1 };
        },
      });

      const providers = providerCapabilities.generateEligibleProviders({
        capabilityRequirements: ['file_creation'],
        qualityTier: 'complex',
        getEmpiricalRank(provider) {
          return provider === 'codex' ? 2 : 0;
        },
      });

      expect(providers).toEqual(['codex', 'ollama-cloud']);
    });
  });
});
