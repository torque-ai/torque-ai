'use strict';

const {
  normalizeProviderLanePolicy,
  normalizeByKindMap,
  specializePolicyForKind,
  isProviderAllowedByLanePolicy,
  getProviderLanePolicyFromMetadata,
} = require('../factory/provider-lane-policy');

describe('Phase H: by_kind in provider lane policy', () => {
  describe('normalizeByKindMap', () => {
    it('parses a simple kind→provider map', () => {
      expect(normalizeByKindMap({
        plan_generation: 'codex',
        architect_cycle: 'codex',
        verify_review: 'codex',
      })).toEqual({
        plan_generation: 'codex',
        architect_cycle: 'codex',
        verify_review: 'codex',
      });
    });

    it('lowercases kind names and provider values, trims whitespace', () => {
      expect(normalizeByKindMap({
        '  Plan_Generation  ': '  CODEX  ',
        'Architect_Cycle': 'Codex',
      })).toEqual({
        plan_generation: 'codex',
        architect_cycle: 'codex',
      });
    });

    it('drops entries with empty/non-string keys or values', () => {
      expect(normalizeByKindMap({
        plan_generation: 'codex',
        '': 'codex',
        verify_review: '',
        '   ': '   ',
        architect_cycle: null,
        bad: 42,
      })).toEqual({ plan_generation: 'codex' });
    });

    it('returns empty object for null/undefined/non-object input', () => {
      expect(normalizeByKindMap(null)).toEqual({});
      expect(normalizeByKindMap(undefined)).toEqual({});
      expect(normalizeByKindMap('not an object')).toEqual({});
      expect(normalizeByKindMap([])).toEqual({});
    });
  });

  describe('normalizeProviderLanePolicy includes by_kind', () => {
    it('parses by_kind alongside expected_provider/allowed_providers', () => {
      const policy = normalizeProviderLanePolicy({
        expected_provider: 'ollama',
        allowed_providers: ['ollama'],
        enforce_handoffs: true,
        by_kind: { plan_generation: 'codex' },
      });
      expect(policy).toEqual({
        expected_provider: 'ollama',
        allowed_fallback_providers: [],
        allowed_providers: ['ollama'],
        by_kind: { plan_generation: 'codex' },
        enforce_handoffs: true,
      });
    });

    it('accepts byKind and kindOverrides aliases', () => {
      const a = normalizeProviderLanePolicy({
        expected_provider: 'ollama',
        byKind: { plan_generation: 'codex' },
      });
      const b = normalizeProviderLanePolicy({
        expected_provider: 'ollama',
        kindOverrides: { plan_generation: 'codex' },
      });
      expect(a.by_kind).toEqual({ plan_generation: 'codex' });
      expect(b.by_kind).toEqual({ plan_generation: 'codex' });
    });

    it('treats a policy with ONLY by_kind as non-empty', () => {
      // Even without expected_provider/allowed_providers, a by_kind map
      // is meaningful — the project wants kind X routed to provider Y.
      const policy = normalizeProviderLanePolicy({
        by_kind: { plan_generation: 'codex' },
      });
      expect(policy).not.toBe(null);
      expect(policy.by_kind).toEqual({ plan_generation: 'codex' });
    });

    it('returns null for fully-empty policies', () => {
      expect(normalizeProviderLanePolicy(null)).toBe(null);
      expect(normalizeProviderLanePolicy({})).toBe(null);
      expect(normalizeProviderLanePolicy({ enforce_handoffs: true })).toBe(null);
    });
  });

  describe('specializePolicyForKind', () => {
    const basePolicy = {
      expected_provider: 'ollama',
      allowed_providers: ['ollama'],
      allowed_fallback_providers: [],
      by_kind: {
        plan_generation: 'codex',
        architect_cycle: 'codex',
        verify_review: 'codex',
      },
      enforce_handoffs: true,
    };

    it('overrides expected_provider with the by_kind entry for the given kind', () => {
      const sp = specializePolicyForKind(basePolicy, 'plan_generation');
      expect(sp.expected_provider).toBe('codex');
    });

    it('adds the override provider to allowed_providers (preserving worker-lane provider)', () => {
      const sp = specializePolicyForKind(basePolicy, 'plan_generation');
      expect(sp.allowed_providers).toEqual(expect.arrayContaining(['ollama', 'codex']));
    });

    it('returns the original policy unchanged when kind has no by_kind entry', () => {
      const sp = specializePolicyForKind(basePolicy, 'execute_task');
      expect(sp).toBe(basePolicy);
    });

    it('returns the original policy unchanged when kind is missing/empty', () => {
      expect(specializePolicyForKind(basePolicy, '')).toBe(basePolicy);
      expect(specializePolicyForKind(basePolicy, null)).toBe(basePolicy);
      expect(specializePolicyForKind(basePolicy, undefined)).toBe(basePolicy);
    });

    it('handles policy with no by_kind map at all', () => {
      const noByKind = { ...basePolicy };
      delete noByKind.by_kind;
      const sp = specializePolicyForKind(noByKind, 'plan_generation');
      expect(sp).toBe(noByKind);
    });

    it('lowercases the kind argument before lookup', () => {
      const sp = specializePolicyForKind(basePolicy, '  PLAN_GENERATION  ');
      expect(sp.expected_provider).toBe('codex');
    });

    it('does not duplicate provider in allowed_providers if already present', () => {
      const policy = {
        ...basePolicy,
        allowed_providers: ['ollama', 'codex'],
      };
      const sp = specializePolicyForKind(policy, 'plan_generation');
      expect(sp.allowed_providers).toEqual(['ollama', 'codex']);
    });
  });

  describe('isProviderAllowedByLanePolicy with specialized policy', () => {
    const dlphonePolicy = {
      expected_provider: 'ollama',
      allowed_providers: ['ollama'],
      allowed_fallback_providers: [],
      by_kind: { plan_generation: 'codex' },
      enforce_handoffs: true,
    };

    it('without specialization, codex is BLOCKED on ollama-pinned project', () => {
      expect(isProviderAllowedByLanePolicy(dlphonePolicy, 'codex')).toBe(false);
      expect(isProviderAllowedByLanePolicy(dlphonePolicy, 'ollama')).toBe(true);
    });

    it('after specializing for plan_generation, BOTH codex and ollama are allowed', () => {
      const sp = specializePolicyForKind(dlphonePolicy, 'plan_generation');
      expect(isProviderAllowedByLanePolicy(sp, 'codex')).toBe(true);
      expect(isProviderAllowedByLanePolicy(sp, 'ollama')).toBe(true);
    });

    it('after specializing, OTHER providers are still blocked', () => {
      const sp = specializePolicyForKind(dlphonePolicy, 'plan_generation');
      expect(isProviderAllowedByLanePolicy(sp, 'cerebras')).toBe(false);
      expect(isProviderAllowedByLanePolicy(sp, 'deepinfra')).toBe(false);
    });
  });

  describe('getProviderLanePolicyFromMetadata auto-specializes when kind is in metadata', () => {
    it('returns kind-specialized policy when metadata.kind matches a by_kind entry', () => {
      const policy = getProviderLanePolicyFromMetadata({
        provider_lane_policy: {
          expected_provider: 'ollama',
          allowed_providers: ['ollama'],
          enforce_handoffs: true,
          by_kind: { plan_generation: 'codex' },
        },
        kind: 'plan_generation',
      });
      expect(policy.expected_provider).toBe('codex');
      expect(policy.allowed_providers).toEqual(expect.arrayContaining(['ollama', 'codex']));
    });

    it('returns un-specialized policy when metadata has no kind', () => {
      const policy = getProviderLanePolicyFromMetadata({
        provider_lane_policy: {
          expected_provider: 'ollama',
          allowed_providers: ['ollama'],
          enforce_handoffs: true,
          by_kind: { plan_generation: 'codex' },
        },
      });
      expect(policy.expected_provider).toBe('ollama');
    });

    it('returns un-specialized policy when kind has no by_kind entry', () => {
      const policy = getProviderLanePolicyFromMetadata({
        provider_lane_policy: {
          expected_provider: 'ollama',
          allowed_providers: ['ollama'],
          enforce_handoffs: true,
          by_kind: { plan_generation: 'codex' },
        },
        kind: 'some_other_kind',
      });
      expect(policy.expected_provider).toBe('ollama');
    });
  });
});
