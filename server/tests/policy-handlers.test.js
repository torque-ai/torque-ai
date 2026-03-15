'use strict';

const mockEngine = {
  evaluatePolicies: vi.fn(),
};

const mockEvaluationStore = {
  listPolicyEvaluations: vi.fn(),
  getPolicyEvaluation: vi.fn(),
  createPolicyOverride: vi.fn(),
};

const mockProfileStore = {
  listPolicyRules: vi.fn(),
  getPolicyRule: vi.fn(),
  savePolicyRule: vi.fn(),
  getPolicyProfile: vi.fn(),
  resolvePolicyProfile: vi.fn(),
  listPolicyBindings: vi.fn(),
  buildEffectiveRule: vi.fn(),
};

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/policy-handlers')];
  installMock('../policy-engine/engine', mockEngine);
  installMock('../policy-engine/evaluation-store', mockEvaluationStore);
  installMock('../policy-engine/profile-store', mockProfileStore);
  installMock('../handlers/error-codes', require('../handlers/error-codes'));
  installMock('../handlers/shared', require('../handlers/shared'));
  return require('../handlers/policy-handlers');
}

function resetAllMocks() {
  for (const store of [mockEngine, mockEvaluationStore, mockProfileStore]) {
    for (const fn of Object.values(store)) {
      if (typeof fn.mockReset === 'function') fn.mockReset();
    }
  }
}

describe('policy-handlers', () => {
  let h;

  beforeEach(() => {
    resetAllMocks();
    h = loadHandlers();
  });

  // ── Constants ──────────────────────────────────────────────

  it('exports expected constants', () => {
    expect(h.POLICY_STAGES).toContain('task_submit');
    expect(h.POLICY_MODES).toContain('block');
    expect(h.POLICY_OUTCOMES).toContain('pass');
    expect(h.POLICY_ERROR_CODES.VALIDATION).toBe('validation_error');
  });

  // ── handleListPolicies ─────────────────────────────────────

  describe('handleListPolicies', () => {
    it('returns error for null args', () => {
      const result = h.handleListPolicies(null);
      expect(result.isError).toBe(true);
    });

    it('returns policies list', () => {
      const rules = [
        { id: 'p1', category: 'safety', mode: 'block' },
        { id: 'p2', category: 'quality', mode: 'warn' },
      ];
      mockProfileStore.listPolicyRules.mockReturnValue(rules);

      const result = h.handleListPolicies({});

      expect(result.isError).toBeUndefined();
      expect(result.policies).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.content[0].text).toContain('Found 2 policy');
    });

    it('filters by stage', () => {
      mockProfileStore.listPolicyRules.mockReturnValue([]);

      h.handleListPolicies({ stage: 'task_submit' });

      expect(mockProfileStore.listPolicyRules).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'task_submit' })
      );
    });

    it('returns error for invalid stage', () => {
      const result = h.handleListPolicies({ stage: 'invalid_stage' });
      expect(result.isError).toBe(true);
    });

    it('returns error for invalid mode', () => {
      const result = h.handleListPolicies({ mode: 'invalid_mode' });
      expect(result.isError).toBe(true);
    });

    it('scopes by profile_id', () => {
      const profile = { id: 'prof-1', name: 'Test' };
      mockProfileStore.listPolicyRules.mockReturnValue([{ id: 'p1' }]);
      mockProfileStore.getPolicyProfile.mockReturnValue(profile);
      mockProfileStore.listPolicyBindings.mockReturnValue([{ policy_id: 'p1' }]);
      mockProfileStore.buildEffectiveRule.mockImplementation((rule) => rule);

      const result = h.handleListPolicies({ profile_id: 'prof-1' });

      expect(result.isError).toBeUndefined();
      expect(result.profile_id).toBe('prof-1');
      expect(mockProfileStore.getPolicyProfile).toHaveBeenCalledWith('prof-1');
    });

    it('returns error for non-existent profile_id', () => {
      mockProfileStore.listPolicyRules.mockReturnValue([]);
      mockProfileStore.getPolicyProfile.mockReturnValue(null);

      const result = h.handleListPolicies({ profile_id: 'missing' });
      expect(result.isError).toBe(true);
    });

    it('scopes by project_id', () => {
      mockProfileStore.listPolicyRules.mockReturnValue([]);
      mockProfileStore.resolvePolicyProfile.mockReturnValue(null);

      const result = h.handleListPolicies({ project_id: 'proj-1' });

      expect(result.isError).toBeUndefined();
      expect(result.policies).toHaveLength(0);
    });

    it('returns singular message for 1 policy', () => {
      mockProfileStore.listPolicyRules.mockReturnValue([{ id: 'p1' }]);

      const result = h.handleListPolicies({});

      expect(result.content[0].text).toBe('Found 1 policy');
    });

    it('catches thrown errors from profileStore', () => {
      mockProfileStore.listPolicyRules.mockImplementation(() => {
        throw new Error('DB down');
      });

      const result = h.handleListPolicies({});
      expect(result.isError).toBe(true);
    });
  });

  // ── handleGetPolicy ────────────────────────────────────────

  describe('handleGetPolicy', () => {
    it('returns error when policy_id is missing', () => {
      const result = h.handleGetPolicy({});
      expect(result.isError).toBe(true);
    });

    it('returns error when policy_id is empty', () => {
      const result = h.handleGetPolicy({ policy_id: '  ' });
      expect(result.isError).toBe(true);
    });

    it('returns error when policy is not found', () => {
      mockProfileStore.getPolicyRule.mockReturnValue(null);

      const result = h.handleGetPolicy({ policy_id: 'missing' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('returns the policy', () => {
      const policy = { id: 'p1', name: 'Test', mode: 'warn' };
      mockProfileStore.getPolicyRule.mockReturnValue(policy);

      const result = h.handleGetPolicy({ policy_id: 'p1' });

      expect(result.isError).toBeUndefined();
      expect(result.policy).toEqual(policy);
      expect(result.content[0].text).toContain('Loaded policy p1');
    });
  });

  // ── handleSetPolicyMode ────────────────────────────────────

  describe('handleSetPolicyMode', () => {
    it('returns error when policy_id is missing', () => {
      const result = h.handleSetPolicyMode({});
      expect(result.isError).toBe(true);
    });

    it('returns error when mode is invalid', () => {
      const result = h.handleSetPolicyMode({ policy_id: 'p1', mode: 'invalid', reason: 'test' });
      expect(result.isError).toBe(true);
    });

    it('returns error when reason is missing', () => {
      const result = h.handleSetPolicyMode({ policy_id: 'p1', mode: 'block' });
      expect(result.isError).toBe(true);
    });

    it('returns error when policy is not found', () => {
      mockProfileStore.getPolicyRule.mockReturnValue(null);

      const result = h.handleSetPolicyMode({ policy_id: 'missing', mode: 'block', reason: 'test' });
      expect(result.isError).toBe(true);
    });

    it('sets the mode and returns previous mode', () => {
      const oldRule = { id: 'p1', mode: 'warn' };
      const newRule = { id: 'p1', mode: 'block' };
      mockProfileStore.getPolicyRule.mockReturnValue(oldRule);
      mockProfileStore.savePolicyRule.mockReturnValue(newRule);

      const result = h.handleSetPolicyMode({ policy_id: 'p1', mode: 'block', reason: 'hardening' });

      expect(result.isError).toBeUndefined();
      expect(result.previous_mode).toBe('warn');
      expect(result.policy.mode).toBe('block');
      expect(result.changed).toBe(true);
      expect(result.reason).toBe('hardening');
      expect(result.content[0].text).toContain('mode set to block');
    });

    it('reports changed=false when mode is unchanged', () => {
      const rule = { id: 'p1', mode: 'block' };
      mockProfileStore.getPolicyRule.mockReturnValue(rule);
      mockProfileStore.savePolicyRule.mockReturnValue(rule);

      const result = h.handleSetPolicyMode({ policy_id: 'p1', mode: 'block', reason: 'no-op' });

      expect(result.changed).toBe(false);
    });
  });

  // ── handleEvaluatePolicies ─────────────────────────────────

  describe('handleEvaluatePolicies', () => {
    it('returns error when stage is missing', () => {
      const result = h.handleEvaluatePolicies({});
      expect(result.isError).toBe(true);
    });

    it('returns error when stage is invalid', () => {
      const result = h.handleEvaluatePolicies({
        stage: 'bad_stage',
        target_type: 'task',
        target_id: 't-1',
      });
      expect(result.isError).toBe(true);
    });

    it('returns error when target_type is missing', () => {
      const result = h.handleEvaluatePolicies({
        stage: 'task_submit',
        target_id: 't-1',
      });
      expect(result.isError).toBe(true);
    });

    it('returns error when target_id is missing', () => {
      const result = h.handleEvaluatePolicies({
        stage: 'task_submit',
        target_type: 'task',
      });
      expect(result.isError).toBe(true);
    });

    it('evaluates policies and returns result', () => {
      const evalResult = {
        stage: 'task_submit',
        target: { type: 'task', id: 't-1' },
        total_results: 3,
        results: [],
      };
      mockEngine.evaluatePolicies.mockReturnValue(evalResult);

      const result = h.handleEvaluatePolicies({
        stage: 'task_submit',
        target_type: 'task',
        target_id: 't-1',
      });

      expect(result.isError).toBeUndefined();
      expect(result.total_results).toBe(3);
      expect(result.content[0].text).toContain('Evaluated 3 policy result(s)');
    });

    it('catches thrown errors from engine', () => {
      mockEngine.evaluatePolicies.mockImplementation(() => {
        throw new Error('engine crash');
      });

      const result = h.handleEvaluatePolicies({
        stage: 'task_submit',
        target_type: 'task',
        target_id: 't-1',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── handleListPolicyEvaluations ────────────────────────────

  describe('handleListPolicyEvaluations', () => {
    it('returns error for null args', () => {
      const result = h.handleListPolicyEvaluations(null);
      expect(result.isError).toBe(true);
    });

    it('returns evaluations list', () => {
      const evals = [{ id: 'e1' }, { id: 'e2' }];
      mockEvaluationStore.listPolicyEvaluations.mockReturnValue(evals);

      const result = h.handleListPolicyEvaluations({});

      expect(result.isError).toBeUndefined();
      expect(result.evaluations).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.content[0].text).toContain('Found 2 policy evaluations');
    });

    it('returns error for invalid stage filter', () => {
      const result = h.handleListPolicyEvaluations({ stage: 'invalid' });
      expect(result.isError).toBe(true);
    });

    it('returns error for invalid outcome filter', () => {
      const result = h.handleListPolicyEvaluations({ outcome: 'invalid' });
      expect(result.isError).toBe(true);
    });

    it('passes limit and offset to store', () => {
      mockEvaluationStore.listPolicyEvaluations.mockReturnValue([]);

      const result = h.handleListPolicyEvaluations({ limit: 10, offset: 5 });

      expect(result.isError).toBeUndefined();
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(5);
      expect(mockEvaluationStore.listPolicyEvaluations).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 5 })
      );
    });
  });

  // ── getPolicyEvaluationCore ────────────────────────────────

  describe('getPolicyEvaluationCore', () => {
    it('returns error when evaluation_id is missing', () => {
      const result = h.getPolicyEvaluationCore({});
      expect(h.isCoreError(result)).toBe(true);
    });

    it('returns error when evaluation is not found', () => {
      mockEvaluationStore.getPolicyEvaluation.mockReturnValue(null);

      const result = h.getPolicyEvaluationCore({ evaluation_id: 'missing' });
      expect(h.isCoreError(result)).toBe(true);
      expect(result.error.code).toBe('evaluation_not_found');
    });

    it('returns the evaluation', () => {
      const evaluation = { id: 'e1', policy_id: 'p1', outcome: 'pass' };
      mockEvaluationStore.getPolicyEvaluation.mockReturnValue(evaluation);

      const result = h.getPolicyEvaluationCore({ evaluation_id: 'e1' });
      expect(h.isCoreError(result)).toBe(false);
      expect(result.evaluation).toEqual(evaluation);
    });
  });

  // ── handleOverridePolicyDecision ───────────────────────────

  describe('handleOverridePolicyDecision', () => {
    it('returns error when evaluation_id is missing', () => {
      const result = h.handleOverridePolicyDecision({});
      expect(result.isError).toBe(true);
    });

    it('returns error when reason_code is missing', () => {
      const result = h.handleOverridePolicyDecision({ evaluation_id: 'e1' });
      expect(result.isError).toBe(true);
    });

    it('returns error when evaluation is not found', () => {
      mockEvaluationStore.getPolicyEvaluation.mockReturnValue(null);

      const result = h.handleOverridePolicyDecision({
        evaluation_id: 'missing',
        reason_code: 'false_positive',
      });
      expect(result.isError).toBe(true);
    });

    it('returns error when override is not allowed', () => {
      mockEvaluationStore.getPolicyEvaluation.mockReturnValue({
        id: 'e1',
        policy_id: 'p1',
        override_allowed: false,
      });

      const result = h.handleOverridePolicyDecision({
        evaluation_id: 'e1',
        reason_code: 'false_positive',
      });
      expect(result.isError).toBe(true);
    });

    it('returns error when policy_id does not match', () => {
      mockEvaluationStore.getPolicyEvaluation.mockReturnValue({
        id: 'e1',
        policy_id: 'p1',
        override_allowed: true,
      });

      const result = h.handleOverridePolicyDecision({
        evaluation_id: 'e1',
        reason_code: 'false_positive',
        policy_id: 'p-wrong',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not match');
    });

    it('returns error when reason_code is not in allowed list', () => {
      mockEvaluationStore.getPolicyEvaluation.mockReturnValue({
        id: 'e1',
        policy_id: 'p1',
        override_allowed: true,
        evaluation: {
          override_policy: {
            reason_codes: ['acceptable_risk', 'false_positive'],
          },
        },
      });

      const result = h.handleOverridePolicyDecision({
        evaluation_id: 'e1',
        reason_code: 'bad_reason',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not allowed');
    });

    it('creates override successfully', () => {
      mockEvaluationStore.getPolicyEvaluation.mockReturnValue({
        id: 'e1',
        policy_id: 'p1',
        override_allowed: true,
      });
      mockEvaluationStore.createPolicyOverride.mockReturnValue({
        override: { id: 'o1', evaluation_id: 'e1' },
        evaluation: { id: 'e1', outcome: 'overridden' },
      });

      const result = h.handleOverridePolicyDecision({
        evaluation_id: 'e1',
        reason_code: 'false_positive',
      });

      expect(result.isError).toBeUndefined();
      expect(result.override.id).toBe('o1');
      expect(result.content[0].text).toContain('Recorded policy override o1');
    });

    it('returns error for invalid expires_at', () => {
      mockEvaluationStore.getPolicyEvaluation.mockReturnValue({
        id: 'e1',
        policy_id: 'p1',
        override_allowed: true,
      });

      const result = h.handleOverridePolicyDecision({
        evaluation_id: 'e1',
        reason_code: 'false_positive',
        expires_at: 'not-a-date',
      });
      expect(result.isError).toBe(true);
    });

    it('returns error when expires_at is not a string', () => {
      const result = h.handleOverridePolicyDecision({
        evaluation_id: 'e1',
        reason_code: 'false_positive',
        expires_at: 12345,
      });
      expect(result.isError).toBe(true);
    });
  });

  // ── isCoreError ────────────────────────────────────────────

  describe('isCoreError', () => {
    it('returns true for core errors', () => {
      expect(h.isCoreError({ error: { code: 'test' } })).toBe(true);
    });

    it('returns false for non-errors', () => {
      expect(h.isCoreError({ policies: [] })).toBe(false);
      expect(h.isCoreError(null)).toBe(false);
      expect(h.isCoreError(undefined)).toBe(false);
    });
  });

  // ── mapPolicyError ─────────────────────────────────────────

  describe('error mapping', () => {
    it('maps "policy not found" errors to POLICY_NOT_FOUND', () => {
      mockProfileStore.getPolicyRule.mockImplementation(() => {
        throw new Error('Policy not found: p1');
      });

      const result = h.getPolicyCore({ policy_id: 'p1' });
      expect(h.isCoreError(result)).toBe(true);
      expect(result.error.code).toBe('policy_not_found');
    });

    it('maps "policy evaluation not found" errors', () => {
      mockEvaluationStore.getPolicyEvaluation.mockImplementation(() => {
        throw new Error('Policy evaluation not found');
      });

      const result = h.getPolicyEvaluationCore({ evaluation_id: 'e1' });
      expect(h.isCoreError(result)).toBe(true);
      expect(result.error.code).toBe('evaluation_not_found');
    });

    it('maps "does not allow overrides" errors', () => {
      mockEvaluationStore.getPolicyEvaluation.mockImplementation(() => {
        throw new Error('Policy does not allow overrides');
      });

      const result = h.overridePolicyDecisionCore({
        evaluation_id: 'e1',
        reason_code: 'test',
      });
      expect(h.isCoreError(result)).toBe(true);
      expect(result.error.code).toBe('override_not_allowed');
    });
  });
});
