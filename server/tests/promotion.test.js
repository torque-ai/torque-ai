'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

const mockEvaluationStore = {
  getEvaluationStats: vi.fn(),
  getOverrideRate: vi.fn(),
  listPolicyOverrides: vi.fn(),
};

const mockProfileStore = {
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  getPolicyRule: vi.fn(),
  listPolicyBindings: vi.fn(),
  savePolicyRule: vi.fn(),
  savePolicyBinding: vi.fn(),
  listPolicyRules: vi.fn(),
};

installMock('../policy-engine/evaluation-store', mockEvaluationStore);
installMock('../policy-engine/profile-store', mockProfileStore);

delete require.cache[require.resolve('../policy-engine/promotion')];
const promotion = require('../policy-engine/promotion');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function configureProfileState({ rules = [], bindings = [] } = {}) {
  const ruleMap = new Map(rules.map((rule) => [rule.id, clone(rule)]));
  const bindingMap = new Map(bindings.map((binding) => [binding.id, clone(binding)]));

  mockProfileStore.getProfile.mockReturnValue({ id: 'profile-1' });
  mockProfileStore.updateProfile.mockImplementation((profile) => clone(profile));

  mockProfileStore.getPolicyRule.mockImplementation((policyId) => {
    const rule = ruleMap.get(policyId);
    return rule ? clone(rule) : null;
  });

  mockProfileStore.listPolicyBindings.mockImplementation((query = {}) => (
    Array.from(bindingMap.values())
      .filter((binding) => binding.policy_id === query.policy_id)
      .filter((binding) => (query.enabled_only ? binding.enabled !== false : true))
      .map((binding) => clone(binding))
  ));

  mockProfileStore.savePolicyRule.mockImplementation((rule) => {
    const stored = clone(rule);
    ruleMap.set(stored.id, stored);
    return clone(stored);
  });

  mockProfileStore.savePolicyBinding.mockImplementation((binding) => {
    const stored = clone(binding);
    bindingMap.set(stored.id, stored);
    return clone(stored);
  });

  mockProfileStore.listPolicyRules.mockImplementation((query = {}) => (
    Array.from(ruleMap.values())
      .filter((rule) => (query.enabled_only ? rule.enabled !== false : true))
      .map((rule) => clone(rule))
  ));

  return { ruleMap, bindingMap };
}

function configureEvaluationState({ overrideRates = {}, overrides = {} } = {}) {
  const overrideRateMap = new Map(
    Object.entries(overrideRates).map(([policyId, stats]) => [policyId, clone(stats)]),
  );
  const overrideListMap = new Map(
    Object.entries(overrides).map(([policyId, items]) => [policyId, clone(items)]),
  );

  mockEvaluationStore.getEvaluationStats.mockImplementation((policyId) => {
    const stats = overrideRateMap.get(policyId) || {};
    return {
      total: Number(stats.total_evaluations || 0),
      pass_rate: 1,
      false_positive_rate: 0,
      override_rate: Number(stats.rate || 0),
    };
  });

  mockEvaluationStore.getOverrideRate.mockImplementation((policyId) => (
    clone(overrideRateMap.get(policyId))
    || { total_evaluations: 0, rate: 0 }
  ));

  mockEvaluationStore.listPolicyOverrides.mockImplementation((query = {}) => (
    clone(overrideListMap.get(query.policy_id)) || []
  ));
}

describe('promotion policy unit tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T12:00:00.000Z'));
    vi.clearAllMocks();
    configureProfileState();
    configureEvaluationState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('exports and mode helpers', () => {
    it('exports the promotion ladder and default thresholds', () => {
      expect(promotion.PROMOTION_ORDER).toEqual(['shadow', 'advisory', 'warn', 'block']);
      expect(promotion.PROMOTION_THRESHOLDS).toEqual({
        benchmark_pass_rate_min: 0.95,
        false_positive_rate_max: 0.10,
        override_rate_max: 0.20,
      });
    });

    it('normalizes valid modes and applies fallback behavior for missing or invalid input', () => {
      expect(promotion.normalizeMode(' Warn ')).toBe('warn');
      expect(promotion.normalizeMode('OFF')).toBe('off');
      expect(promotion.normalizeMode(null)).toBe('shadow');
      expect(promotion.normalizeMode(undefined, 'WARN')).toBe('warn');
      expect(promotion.normalizeMode('not-a-mode', 'block')).toBe('block');
    });

    it('returns the next promotion target for each supported mode', () => {
      expect(promotion.getPromotionTarget('shadow')).toBe('advisory');
      expect(promotion.getPromotionTarget('advisory')).toBe('warn');
      expect(promotion.getPromotionTarget('warn')).toBe('block');
      expect(promotion.getPromotionTarget('block')).toBe('block');
      expect(promotion.getPromotionTarget('off')).toBe('shadow');
    });

    it('returns the previous demotion target for each supported mode', () => {
      expect(promotion.getDemotionTarget('block')).toBe('warn');
      expect(promotion.getDemotionTarget('warn')).toBe('advisory');
      expect(promotion.getDemotionTarget('advisory')).toBe('shadow');
      expect(promotion.getDemotionTarget('shadow')).toBe('shadow');
    });
  });

  describe('evaluatePromotion()', () => {
    it('promotes shadow, advisory, and warn when all gates are met', () => {
      const baseInput = {
        benchmark_pass_rate: 0.95,
        false_positive_rate: 0.05,
        override_rate: 0.20,
        canary_review_completed: true,
        override_path_verified: true,
      };

      expect(promotion.evaluatePromotion({
        ...baseInput,
        current_mode: 'shadow',
      })).toMatchObject({
        current_mode: 'shadow',
        next_mode: 'advisory',
        decision: 'promote',
        reasons: ['promotion_gates_met'],
      });

      expect(promotion.evaluatePromotion({
        ...baseInput,
        current_mode: 'advisory',
      })).toMatchObject({
        current_mode: 'advisory',
        next_mode: 'warn',
        decision: 'promote',
        reasons: ['promotion_gates_met'],
      });

      expect(promotion.evaluatePromotion({
        ...baseInput,
        current_mode: 'warn',
        deterministic: true,
      })).toMatchObject({
        current_mode: 'warn',
        next_mode: 'block',
        decision: 'promote',
        reasons: ['promotion_gates_met'],
        thresholds: promotion.PROMOTION_THRESHOLDS,
        metrics: {
          benchmark_pass_rate: 0.95,
          false_positive_rate: 0.05,
          override_rate: 0.20,
        },
      });
    });

    it('holds when the benchmark pass rate is below threshold', () => {
      expect(promotion.evaluatePromotion({
        current_mode: 'shadow',
        benchmark_pass_rate: 0.94,
        false_positive_rate: 0,
        override_rate: 0,
        canary_review_completed: true,
        override_path_verified: true,
      })).toMatchObject({
        current_mode: 'shadow',
        next_mode: 'shadow',
        decision: 'hold',
        reasons: ['benchmark_pass_rate_below_threshold'],
      });
    });

    it('holds when canary review or override path validation is incomplete', () => {
      expect(promotion.evaluatePromotion({
        current_mode: 'advisory',
        benchmark_pass_rate: 0.99,
        false_positive_rate: 0,
        override_rate: 0,
        canary_review_completed: false,
        override_path_verified: false,
      })).toMatchObject({
        current_mode: 'advisory',
        next_mode: 'advisory',
        decision: 'hold',
        reasons: ['canary_review_incomplete', 'override_path_unverified'],
      });
    });

    it('holds advisory policies when false-positive rate exceeds threshold', () => {
      expect(promotion.evaluatePromotion({
        current_mode: 'advisory',
        benchmark_pass_rate: 0.99,
        false_positive_rate: 0.11,
        override_rate: 0.05,
        canary_review_completed: true,
        override_path_verified: true,
      })).toMatchObject({
        current_mode: 'advisory',
        next_mode: 'advisory',
        decision: 'hold',
        reasons: ['false_positive_rate_exceeds_threshold'],
      });
    });

    it('demotes warn and block policies when false-positive rate exceeds threshold', () => {
      expect(promotion.evaluatePromotion({
        current_mode: 'warn',
        benchmark_pass_rate: 0.99,
        false_positive_rate: 0.11,
        override_rate: 0.05,
        canary_review_completed: true,
        override_path_verified: true,
      })).toMatchObject({
        current_mode: 'warn',
        next_mode: 'advisory',
        decision: 'demote',
        reasons: ['false_positive_rate_exceeds_threshold'],
      });

      expect(promotion.evaluatePromotion({
        current_mode: 'block',
        benchmark_pass_rate: 0.99,
        false_positive_rate: 0.11,
        override_rate: 0.05,
        canary_review_completed: true,
        override_path_verified: true,
      })).toMatchObject({
        current_mode: 'block',
        next_mode: 'warn',
        decision: 'demote',
        reasons: ['false_positive_rate_exceeds_threshold'],
      });
    });

    it('holds warn policies when block-only requirements are not satisfied', () => {
      expect(promotion.evaluatePromotion({
        current_mode: 'warn',
        benchmark_pass_rate: 0.99,
        false_positive_rate: 0.05,
        override_rate: 0.21,
        canary_review_completed: true,
        override_path_verified: true,
        deterministic: true,
      })).toMatchObject({
        current_mode: 'warn',
        next_mode: 'warn',
        decision: 'hold',
        reasons: ['override_rate_exceeds_threshold'],
      });

      expect(promotion.evaluatePromotion({
        current_mode: 'warn',
        benchmark_pass_rate: 0.99,
        false_positive_rate: 0.05,
        override_rate: 0.10,
        canary_review_completed: true,
        override_path_verified: true,
        deterministic: false,
      })).toMatchObject({
        current_mode: 'warn',
        next_mode: 'warn',
        decision: 'hold',
        reasons: ['block_requires_deterministic_policy'],
      });
    });
  });

  describe('canPromote()', () => {
    it('returns an eligible assessment when the policy has enough recent evaluations', () => {
      configureProfileState({
        rules: [
          { id: 'policy-a', mode: 'shadow', enabled: true },
        ],
        bindings: [
          {
            id: 'binding-a',
            policy_id: 'policy-a',
            profile_id: 'profile-1',
            mode_override: 'advisory',
            enabled: true,
            binding_json: {},
          },
        ],
      });

      configureEvaluationState({
        overrideRates: {
          'policy-a': { total_evaluations: 20, rate: 0.10 },
        },
        overrides: {
          'policy-a': [
            {
              id: 'recent-fp',
              evaluation_id: 'eval-1',
              decision: 'override',
              reason_code: 'policy_false_positive',
              created_at: daysAgo(1),
            },
            {
              id: 'old-fp',
              evaluation_id: 'eval-2',
              decision: 'override',
              reason_code: 'policy_false_positive',
              created_at: daysAgo(8),
            },
            {
              id: 'ignored-reason',
              evaluation_id: 'eval-3',
              decision: 'override',
              reason_code: 'approved_exception',
              created_at: daysAgo(1),
            },
          ],
        },
      });

      expect(promotion.canPromote('policy-a')).toEqual({
        eligible: true,
        currentMode: 'advisory',
        suggestedMode: 'warn',
        falsePositiveRate: 0.05,
        evaluationCount: 20,
      });

      expect(mockEvaluationStore.getOverrideRate).toHaveBeenCalledWith('policy-a', 7);
      expect(mockProfileStore.getPolicyRule).toHaveBeenCalledWith('policy-a');
    });

    it('returns an ineligible assessment when there are fewer than 20 evaluations', () => {
      configureProfileState({
        rules: [
          { id: 'policy-b', mode: 'warn', enabled: true },
        ],
      });

      configureEvaluationState({
        overrideRates: {
          'policy-b': { total_evaluations: 19, rate: 0.05 },
        },
      });

      expect(promotion.canPromote('policy-b')).toEqual({
        eligible: false,
        currentMode: 'warn',
        suggestedMode: 'warn',
        falsePositiveRate: 0,
        evaluationCount: 19,
      });
    });
  });

  describe('promote()', () => {
    it('persists the next mode through policy bindings and returns the effective policy', () => {
      configureProfileState({
        rules: [
          { id: 'policy-promote', mode: 'shadow', enabled: true, override_policy: {} },
        ],
        bindings: [
          {
            id: 'binding-promote',
            policy_id: 'policy-promote',
            profile_id: 'profile-1',
            mode_override: 'shadow',
            enabled: true,
            binding_json: { source: 'seed' },
          },
        ],
      });

      const updated = promotion.promote('policy-promote', 'Advisory');

      expect(mockProfileStore.savePolicyBinding).toHaveBeenCalledWith(expect.objectContaining({
        id: 'binding-promote',
        mode_override: 'advisory',
      }));
      expect(updated).toMatchObject({
        id: 'policy-promote',
        policy_id: 'policy-promote',
        profile_id: 'profile-1',
        binding_id: 'binding-promote',
        mode: 'advisory',
        binding_json: { source: 'seed' },
      });
    });

    it('falls back to saving the rule when no enabled bindings exist', () => {
      configureProfileState({
        rules: [
          { id: 'policy-rule-only', mode: 'advisory', enabled: true, override_policy: { note: 'existing' } },
        ],
      });

      const updated = promotion.promote('policy-rule-only', 'warn');

      expect(mockProfileStore.savePolicyRule).toHaveBeenCalledWith(expect.objectContaining({
        id: 'policy-rule-only',
        mode: 'warn',
        override_policy: { note: 'existing' },
      }));
      expect(updated).toMatchObject({
        id: 'policy-rule-only',
        policy_id: 'policy-rule-only',
        profile_id: null,
        binding_id: null,
        mode: 'warn',
      });
    });
  });

  describe('demote()', () => {
    it('persists demotion metadata on bindings and returns the new mode', () => {
      configureProfileState({
        rules: [
          { id: 'policy-demote', mode: 'block', enabled: true, override_policy: {} },
        ],
        bindings: [
          {
            id: 'binding-demote',
            policy_id: 'policy-demote',
            profile_id: 'profile-1',
            mode_override: 'block',
            enabled: true,
            binding_json: {
              promotion: {
                demotions: [
                  {
                    from_mode: 'warn',
                    to_mode: 'advisory',
                    reason: 'Older demotion',
                    recorded_at: '2026-03-01T00:00:00.000Z',
                  },
                ],
              },
            },
          },
        ],
      });

      const updated = promotion.demote('policy-demote', '  False positives spiked during canary.  ');

      expect(mockProfileStore.savePolicyBinding).toHaveBeenCalledWith(expect.objectContaining({
        id: 'binding-demote',
        mode_override: 'warn',
        binding_json: {
          promotion: {
            last_demotion: {
              from_mode: 'block',
              to_mode: 'warn',
              reason: 'False positives spiked during canary.',
              recorded_at: '2026-03-11T12:00:00.000Z',
            },
            demotions: [
              {
                from_mode: 'block',
                to_mode: 'warn',
                reason: 'False positives spiked during canary.',
                recorded_at: '2026-03-11T12:00:00.000Z',
              },
              {
                from_mode: 'warn',
                to_mode: 'advisory',
                reason: 'Older demotion',
                recorded_at: '2026-03-01T00:00:00.000Z',
              },
            ],
          },
        },
      }));
      expect(updated.mode).toBe('warn');
    });

    it('persists demotion metadata on the rule when bindings do not exist', () => {
      configureProfileState({
        rules: [
          {
            id: 'policy-rule-demote',
            mode: 'advisory',
            enabled: true,
            override_policy: { owner: 'ops' },
          },
        ],
      });

      const updated = promotion.demote('policy-rule-demote', 'Needs more tuning');

      expect(mockProfileStore.savePolicyRule).toHaveBeenCalledWith(expect.objectContaining({
        id: 'policy-rule-demote',
        mode: 'shadow',
        override_policy: {
          owner: 'ops',
          promotion: {
            last_demotion: {
              from_mode: 'advisory',
              to_mode: 'shadow',
              reason: 'Needs more tuning',
              recorded_at: '2026-03-11T12:00:00.000Z',
            },
            demotions: [
              {
                from_mode: 'advisory',
                to_mode: 'shadow',
                reason: 'Needs more tuning',
                recorded_at: '2026-03-11T12:00:00.000Z',
              },
            ],
          },
        },
      }));
      expect(updated).toMatchObject({
        policy_id: 'policy-rule-demote',
        mode: 'shadow',
      });
    });
  });

  describe('getPromotionStatus()', () => {
    it('combines per-policy stats with promotion readiness and sorts by policy id', () => {
      configureProfileState({
        rules: [
          { id: 'z-policy', mode: 'shadow', enabled: true },
          { id: 'a-policy', mode: 'warn', enabled: true },
        ],
        bindings: [
          {
            id: 'binding-z',
            policy_id: 'z-policy',
            profile_id: 'profile-1',
            mode_override: 'advisory',
            enabled: true,
            binding_json: {},
          },
          {
            id: 'binding-a1',
            policy_id: 'a-policy',
            profile_id: 'profile-1',
            mode_override: 'warn',
            enabled: true,
            binding_json: {},
          },
          {
            id: 'binding-a2',
            policy_id: 'a-policy',
            profile_id: 'profile-2',
            mode_override: 'advisory',
            enabled: true,
            binding_json: {},
          },
        ],
      });

      configureEvaluationState({
        overrideRates: {
          'z-policy': { total_evaluations: 20, rate: 0.20 },
          'a-policy': { total_evaluations: 30, rate: 0.05 },
        },
        overrides: {
          'z-policy': [
            {
              id: 'z-fp',
              evaluation_id: 'z-eval-1',
              decision: 'override',
              reason_code: 'policy_false_positive',
              created_at: daysAgo(2),
            },
          ],
          'a-policy': [],
        },
      });

      expect(promotion.getPromotionStatus()).toEqual([
        {
          policyId: 'a-policy',
          currentMode: 'mixed',
          suggestedMode: 'mixed',
          overrideRate: 0.05,
          falsePositiveRate: 0,
          evaluationCount: 30,
          eligible: false,
        },
        {
          policyId: 'z-policy',
          currentMode: 'advisory',
          suggestedMode: 'warn',
          overrideRate: 0.20,
          falsePositiveRate: 0.05,
          evaluationCount: 20,
          eligible: true,
        },
      ]);

      expect(mockProfileStore.listPolicyRules).toHaveBeenCalledWith({ enabled_only: false });
    });
  });
});
