const path = require('path');
const fs = require('fs');

const evaluationStore = require('../policy-engine/evaluation-store');
const profileStore = require('../policy-engine/profile-store');
const promotion = require('../policy-engine/promotion');
const {
  loadTorqueDefaults,
} = require('../policy-engine/profile-loader');
const shadowEnforcer = require('../policy-engine/shadow-enforcer');
const taskHooks = require('../policy-engine/task-hooks');
const {
  setupTestDb,
  teardownTestDb,
} = require('./vitest-setup');

function resolvePolicyFixtureRoot() {
  const preferredRoot = path.resolve(__dirname, '..', '..');
  const preferredPath = path.join(preferredRoot, 'artifacts', 'policy', 'config', 'torque-dev-policy.seed.json');
  if (fs.existsSync(preferredPath)) {
    return preferredRoot;
  }

  const fallbackRoot = path.resolve(__dirname, '..', '..', '..', 'Torque');
  const fallbackPath = path.join(fallbackRoot, 'artifacts', 'policy', 'config', 'torque-dev-policy.seed.json');
  if (fs.existsSync(fallbackPath)) {
    return fallbackRoot;
  }

  return preferredRoot;
}

const projectRoot = resolvePolicyFixtureRoot();

function mapRulesById(rules) {
  return new Map(rules.map((rule) => [rule.policy_id || rule.id, rule]));
}

describe('policy phase 5 integration', () => {
  let db;
  let testDir;

  function setLivePolicyFlags(overrides = {}) {
    const values = {
      policy_engine_enabled: '1',
      policy_engine_shadow_only: '0',
      policy_block_mode_enabled: '0',
      ...overrides,
    };
    shadowEnforcer.setConfigReader((key) => values[key] ?? null);
  }

  function makeTaskData(overrides = {}) {
    return {
      id: 'task-phase5',
      project: 'Torque',
      provider: 'codex',
      working_directory: testDir,
      ...overrides,
    };
  }

  function getResult(result, policyId) {
    return result.results.find((entry) => entry.policy_id === policyId);
  }

  beforeEach(() => {
    ({ db, testDir } = setupTestDb('policy-phase5-integration'));
    setLivePolicyFlags();
    loadTorqueDefaults(projectRoot);
  });

  afterEach(() => {
    shadowEnforcer.setConfigReader(null);
    teardownTestDb();
  });

  it('loads the seed profile with deterministic submit policies starting in advisory mode', () => {
    const submitRules = mapRulesById(profileStore.resolvePoliciesForStage({
      stage: 'task_submit',
      project_id: 'Torque',
      project_path: testDir,
    }));
    const completeRules = mapRulesById(profileStore.resolvePoliciesForStage({
      stage: 'task_complete',
      project_id: 'Torque',
      project_path: testDir,
    }));

    expect(submitRules.get('command_profile_required')).toMatchObject({
      mode: 'advisory',
    });
    expect(submitRules.get('sensitive_path_provider_restriction')).toMatchObject({
      mode: 'advisory',
    });
    expect(completeRules.get('verification_required_for_code_changes')).toMatchObject({
      mode: 'advisory',
    });
  });

  it('returns an advisory warning when command_profile_required is violated', () => {
    const result = taskHooks.onTaskSubmit(makeTaskData({
      id: 'task-command-profile-warning',
      changed_files: ['docs/README.md'],
      evidence: {
        command_profile_valid: false,
      },
    }));

    expect(result.shadow).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.summary).toMatchObject({
      failed: 1,
      warned: 1,
      blocked: 0,
      degraded: 0,
    });
    expect(getResult(result, 'command_profile_required')).toMatchObject({
      outcome: 'fail',
      mode: 'advisory',
      severity: 'warning',
    });
  });

  it('returns an advisory warning when sensitive_path_provider_restriction is violated', () => {
    const result = taskHooks.onTaskSubmit(makeTaskData({
      id: 'task-sensitive-path-warning',
      changed_files: ['server/config.js'],
      evidence: {
        command_profile_valid: true,
        provider_allowed: false,
      },
    }));

    expect(result.shadow).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.summary).toMatchObject({
      failed: 1,
      warned: 1,
      blocked: 0,
      degraded: 0,
    });
    expect(getResult(result, 'command_profile_required')).toMatchObject({
      outcome: 'pass',
      mode: 'advisory',
    });
    expect(getResult(result, 'sensitive_path_provider_restriction')).toMatchObject({
      outcome: 'fail',
      mode: 'advisory',
      severity: 'warning',
    });
  });

  it('returns no violations for a clean task', () => {
    const result = taskHooks.onTaskSubmit(makeTaskData({
      id: 'task-clean-submit',
      changed_files: ['docs/README.md'],
      evidence: {
        command_profile_valid: true,
      },
    }));

    expect(result.shadow).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.summary).toMatchObject({
      failed: 0,
      warned: 0,
      blocked: 0,
      degraded: 0,
    });
    expect(getResult(result, 'command_profile_required')).toMatchObject({
      outcome: 'pass',
      mode: 'advisory',
    });
    expect(getResult(result, 'sensitive_path_provider_restriction')).toMatchObject({
      outcome: 'skipped',
      mode: 'advisory',
    });
  });

  it('promotes a policy from shadow to advisory to warn when rollout metrics stay healthy', () => {
    const rolloutMetrics = {
      benchmark_pass_rate: 0.99,
      false_positive_rate: 0.03,
      override_rate: 0.05,
      canary_review_completed: true,
      override_path_verified: true,
      deterministic: true,
    };

    const shadowDecision = promotion.evaluatePromotion({
      current_mode: 'shadow',
      ...rolloutMetrics,
    });
    const advisoryDecision = promotion.evaluatePromotion({
      current_mode: shadowDecision.next_mode,
      ...rolloutMetrics,
    });

    expect(shadowDecision).toMatchObject({
      current_mode: 'shadow',
      next_mode: 'advisory',
      decision: 'promote',
    });
    expect(advisoryDecision).toMatchObject({
      current_mode: 'advisory',
      next_mode: 'warn',
      decision: 'promote',
    });
  });

  it('demotes warn back to advisory when the false-positive rate exceeds the threshold', () => {
    const demotionDecision = promotion.evaluatePromotion({
      current_mode: 'warn',
      benchmark_pass_rate: 0.99,
      false_positive_rate: 0.25,
      override_rate: 0.05,
      canary_review_completed: true,
      override_path_verified: true,
      deterministic: true,
    });

    expect(demotionDecision).toMatchObject({
      current_mode: 'warn',
      next_mode: 'advisory',
      decision: 'demote',
    });
    expect(demotionDecision.reasons).toContain('false_positive_rate_exceeds_threshold');
  });

  it('persists override-rate tracking across evaluations', () => {
    const first = taskHooks.onTaskSubmit(makeTaskData({
      id: 'task-override-rate-1',
      changed_files: ['docs/README.md'],
      evidence: {
        command_profile_valid: false,
      },
    }));

    const firstEvaluationId = getResult(first, 'command_profile_required').evaluation_id;
    const overrideResult = db.createPolicyOverride({
      evaluation_id: firstEvaluationId,
      reason_code: 'testing',
      actor: 'operator-1',
    });

    expect(overrideResult.evaluation.outcome).toBe('overridden');
    expect(evaluationStore.getOverrideRate('command_profile_required')).toEqual({
      total_evaluations: 1,
      overrides: 1,
      rate: 1,
    });

    taskHooks.onTaskSubmit(makeTaskData({
      id: 'task-override-rate-2',
      changed_files: ['docs/README.md'],
      evidence: {
        command_profile_valid: false,
      },
    }));

    expect(evaluationStore.getOverrideRate('command_profile_required')).toEqual({
      total_evaluations: 2,
      overrides: 1,
      rate: 0.5,
    });
  });
});
