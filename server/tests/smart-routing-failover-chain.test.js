'use strict';
/* global describe, it, expect, vi, beforeEach */

const { walkFailoverChain } = require('../db/smart-routing');

describe('walkFailoverChain', () => {
  it('returns first provider when no breaker', () => {
    const choice = walkFailoverChain({
      chain: [{ provider: 'groq', model: 'gpt-oss-120b' }, { provider: 'cerebras' }],
      breaker: null,
    });
    expect(choice).toEqual({ provider: 'groq', model: 'gpt-oss-120b' });
  });

  it('skips providers the breaker rejects', () => {
    const breaker = { allowRequest: vi.fn((p) => p !== 'groq') };
    const choice = walkFailoverChain({
      chain: [{ provider: 'groq' }, { provider: 'cerebras' }],
      breaker,
    });
    expect(choice.provider).toBe('cerebras');
    expect(breaker.allowRequest).toHaveBeenCalledWith('groq');
    expect(breaker.allowRequest).toHaveBeenCalledWith('cerebras');
  });

  it('returns null on chain exhaustion', () => {
    const breaker = { allowRequest: () => false };
    expect(walkFailoverChain({ chain: [{ provider: 'groq' }], breaker })).toBeNull();
  });

  it('returns null on empty chain', () => {
    expect(walkFailoverChain({ chain: [], breaker: null })).toBeNull();
  });

  it('returns null on null chain', () => {
    expect(walkFailoverChain({ chain: null, breaker: null })).toBeNull();
  });

  it('preserves model when present', () => {
    const choice = walkFailoverChain({
      chain: [{ provider: 'cerebras', model: 'qwen-3-235b' }],
      breaker: null,
    });
    expect(choice.model).toBe('qwen-3-235b');
  });

  it('returns model: null when chain entry has no model', () => {
    const choice = walkFailoverChain({
      chain: [{ provider: 'ollama' }],
      breaker: null,
    });
    expect(choice.model).toBeNull();
  });

  it('skips malformed chain entries', () => {
    const choice = walkFailoverChain({
      chain: [null, { provider: null }, {}, { provider: 'cerebras' }],
      breaker: null,
    });
    expect(choice.provider).toBe('cerebras');
  });

  it('treats malformed breaker (no allowRequest) as no-breaker', () => {
    const choice = walkFailoverChain({
      chain: [{ provider: 'groq' }, { provider: 'cerebras' }],
      breaker: {},
    });
    expect(choice.provider).toBe('groq');
  });
});

describe('routing resolver — codex-down-failover branch', () => {
  // We test the integration via resolveRoutingTemplate's deps surface, since
  // `analyzeTaskForRouting` requires a fully-initialized DB harness. The pure
  // helper `walkFailoverChain` exposes the chain walker for unit testing; the
  // resolver wires it in when the active template is the codex-down-failover preset.

  let smartRouting;
  let templateStore;
  let categoryClassifier;

  beforeEach(() => {
    // Reset module registry so we can swap mocks per test.
    delete require.cache[require.resolve('../db/smart-routing')];
    smartRouting = require('../db/smart-routing');
    templateStore = require('../routing/template-store');
    categoryClassifier = require('../routing/category-classifier');
  });

  function makeFailoverTemplate() {
    return {
      id: 'preset-codex-down-failover',
      name: 'Codex-Down Failover',
      rules: {
        simple_generation: [
          { provider: 'groq', model: 'openai/gpt-oss-120b' },
          { provider: 'cerebras', model: 'qwen-3-235b-a22b-instruct-2507' },
          { provider: 'ollama' },
        ],
        targeted_file_edit: [{ provider: 'groq' }, { provider: 'cerebras' }],
        documentation: [{ provider: 'groq' }],
        default: [{ provider: 'groq' }, { provider: 'cerebras' }],
        // Codex-only categories deliberately empty so they park.
        architectural: [],
        large_code_gen: [],
        xaml_wpf: [],
        security: [],
        reasoning: [],
        simple_generation_complex: [{ provider: 'cerebras' }],
      },
      complexity_overrides: {},
    };
  }

  it('selects first breaker-allowed provider when active template is codex-down-failover', () => {
    const template = makeFailoverTemplate();
    const breaker = { allowRequest: (p) => p === 'cerebras' };
    const deps = {
      categoryClassifier: { classify: () => 'simple_generation' },
      templateStore: {
        getExplicitActiveTemplateId: () => template.id,
        getTemplate: (id) => (id === template.id ? template : null),
        resolveProvider: templateStore.resolveProvider,
        resolveTemplateByNameOrId: () => null,
      },
      getProvider: (p) => ({ enabled: true, provider: p }),
      getQuotaStoreIfAvailable: () => null,
      hostManagementFns: { determineTaskComplexity: () => 'normal' },
      maybeApplyFallback: (r) => r,
      rankProviderCandidatesByScore: null,
      getCircuitBreaker: () => breaker,
    };

    const result = smartRouting._resolveRoutingTemplateForTest('write a test', [], {}, deps);
    expect(result).not.toBeNull();
    expect(result.provider).toBe('cerebras');
    expect(result.reason).toMatch(/codex-down-failover/i);
  });

  it('returns null/parked when failover chain is fully exhausted', () => {
    const template = makeFailoverTemplate();
    const breaker = { allowRequest: () => false };
    const deps = {
      categoryClassifier: { classify: () => 'simple_generation' },
      templateStore: {
        getExplicitActiveTemplateId: () => template.id,
        getTemplate: (id) => (id === template.id ? template : null),
        resolveProvider: templateStore.resolveProvider,
        resolveTemplateByNameOrId: () => null,
      },
      getProvider: (p) => ({ enabled: true, provider: p }),
      getQuotaStoreIfAvailable: () => null,
      hostManagementFns: { determineTaskComplexity: () => 'normal' },
      maybeApplyFallback: (r) => r,
      rankProviderCandidatesByScore: null,
      getCircuitBreaker: () => breaker,
    };

    const result = smartRouting._resolveRoutingTemplateForTest('write a test', [], {}, deps);
    expect(result).toBeNull();
  });

  it('falls back to first chain entry when no breaker is registered', () => {
    const template = makeFailoverTemplate();
    const deps = {
      categoryClassifier: { classify: () => 'simple_generation' },
      templateStore: {
        getExplicitActiveTemplateId: () => template.id,
        getTemplate: (id) => (id === template.id ? template : null),
        resolveProvider: templateStore.resolveProvider,
        resolveTemplateByNameOrId: () => null,
      },
      getProvider: (p) => ({ enabled: true, provider: p }),
      getQuotaStoreIfAvailable: () => null,
      hostManagementFns: { determineTaskComplexity: () => 'normal' },
      maybeApplyFallback: (r) => r,
      rankProviderCandidatesByScore: null,
      getCircuitBreaker: () => null,
    };

    const result = smartRouting._resolveRoutingTemplateForTest('write a test', [], {}, deps);
    expect(result).not.toBeNull();
    expect(result.provider).toBe('groq');
  });
});
