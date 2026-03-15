const path = require('path');
const fs = require('fs');

const evaluationStore = require('../policy-engine/evaluation-store');
const profileLoader = require('../policy-engine/profile-loader');
const profileStore = require('../policy-engine/profile-store');
const promotion = require('../policy-engine/promotion');
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

const policyFixtureRoot = resolvePolicyFixtureRoot();
const seedPath = path.join(policyFixtureRoot, 'artifacts', 'policy', 'config', 'torque-dev-policy.seed.json');
const hasSeedFile = fs.existsSync(seedPath);
const seedFixture = hasSeedFile ? require(seedPath) : {};

const projectRoot = policyFixtureRoot;

describe.skipIf(!hasSeedFile)('policy promotion', () => {
  function createEvaluation(policyId, taskId, overrides = {}) {
    const rule = profileStore.getPolicyRule(policyId);
    if (!rule) {
      throw new Error(`Missing policy rule: ${policyId}`);
    }

    return evaluationStore.createPolicyEvaluation({
      policy_id: policyId,
      profile_id: 'torque-dev',
      stage: rule.stage,
      target_type: 'task',
      target_id: taskId,
      project: 'Torque',
      mode: overrides.mode || rule.mode,
      outcome: overrides.outcome || 'fail',
      severity: overrides.severity || 'warning',
      message: overrides.message || `${policyId} failed`,
      override_allowed: true,
      created_at: overrides.created_at,
      evaluation: {
        override_policy: {
          allowed: true,
          reason_codes: ['policy_false_positive', 'approved_exception'],
        },
      },
    });
  }

  function seedPromotionWindow(policyId, options = {}) {
    const evaluations = options.evaluations ?? 20;
    const falsePositiveOverrides = options.falsePositiveOverrides ?? 0;
    const otherOverrides = options.otherOverrides ?? 0;
    const created = [];

    for (let index = 0; index < evaluations; index += 1) {
      created.push(
        createEvaluation(policyId, `${policyId}-task-${index}`),
      );
    }

    for (let index = 0; index < falsePositiveOverrides; index += 1) {
      evaluationStore.createPolicyOverride({
        evaluation_id: created[index].id,
        reason_code: 'policy_false_positive',
        actor: 'operator-promotion',
      });
    }

    for (let index = 0; index < otherOverrides; index += 1) {
      evaluationStore.createPolicyOverride({
        evaluation_id: created[falsePositiveOverrides + index].id,
        reason_code: 'approved_exception',
        actor: 'operator-promotion',
      });
    }
  }

  beforeEach(() => {
    setupTestDb('policy-promotion');
    profileLoader.loadTorqueDefaults(projectRoot);
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('canPromote returns eligible when false-positive rate is below threshold', () => {
    seedPromotionWindow('verification_required_for_code_changes', {
      evaluations: 20,
      falsePositiveOverrides: 1,
    });

    expect(promotion.canPromote('verification_required_for_code_changes')).toEqual({
      eligible: true,
      currentMode: 'advisory',
      suggestedMode: 'warn',
      falsePositiveRate: 0.05,
      evaluationCount: 20,
    });
  });

  it('canPromote returns ineligible when false-positive rate is above 10%', () => {
    seedPromotionWindow('public_surface_change_requires_docs', {
      evaluations: 20,
      falsePositiveOverrides: 3,
    });

    expect(promotion.canPromote('public_surface_change_requires_docs')).toMatchObject({
      eligible: false,
      currentMode: 'advisory',
      suggestedMode: 'advisory',
      falsePositiveRate: 0.15,
      evaluationCount: 20,
    });
  });

  it('canPromote returns ineligible with insufficient evaluations', () => {
    seedPromotionWindow('schema_change_requires_migration_and_tests', {
      evaluations: 19,
      falsePositiveOverrides: 0,
    });

    expect(promotion.canPromote('schema_change_requires_migration_and_tests')).toEqual({
      eligible: false,
      currentMode: 'warn',
      suggestedMode: 'warn',
      falsePositiveRate: 0,
      evaluationCount: 19,
    });
  });

  it('promote moves shadow to advisory', () => {
    const binding = profileStore.getPolicyBinding('torque-dev', 'verification_required_for_code_changes');
    profileStore.savePolicyBinding({
      ...binding,
      mode_override: 'shadow',
    });

    const updated = promotion.promote('verification_required_for_code_changes', 'advisory');
    const persisted = profileStore.getPolicyBinding('torque-dev', 'verification_required_for_code_changes');

    expect(updated.mode).toBe('advisory');
    expect(persisted.mode_override).toBe('advisory');
  });

  it('promote rejects invalid transitions', () => {
    const binding = profileStore.getPolicyBinding('torque-dev', 'verification_required_for_code_changes');
    profileStore.savePolicyBinding({
      ...binding,
      mode_override: 'shadow',
    });

    expect(() => promotion.promote('verification_required_for_code_changes', 'block'))
      .toThrow(/invalid promotion transition/i);
  });

  it('demote moves block to warn', () => {
    const binding = profileStore.getPolicyBinding('torque-dev', 'command_profile_required');
    profileStore.savePolicyBinding({
      ...binding,
      mode_override: 'block',
    });

    const updated = promotion.demote(
      'command_profile_required',
      'False-positive spike during canary window.',
    );
    const persisted = profileStore.getPolicyBinding('torque-dev', 'command_profile_required');

    expect(updated.mode).toBe('warn');
    expect(persisted.mode_override).toBe('warn');
    expect(persisted.binding_json.promotion.last_demotion).toMatchObject({
      from_mode: 'block',
      to_mode: 'warn',
      reason: 'False-positive spike during canary window.',
    });
  });

  it('getPromotionStatus lists all policies with stats', () => {
    seedPromotionWindow('verification_required_for_code_changes', {
      evaluations: 20,
      falsePositiveOverrides: 1,
      otherOverrides: 1,
    });

    const status = promotion.getPromotionStatus();
    const verificationStatus = status.find(
      (entry) => entry.policyId === 'verification_required_for_code_changes',
    );

    expect(status).toHaveLength(seedFixture.rules.length);
    expect(status.map((entry) => entry.policyId).sort()).toEqual(
      seedFixture.rules.map((rule) => rule.id).sort(),
    );
    expect(verificationStatus).toMatchObject({
      policyId: 'verification_required_for_code_changes',
      currentMode: 'advisory',
      suggestedMode: 'warn',
      overrideRate: 0.1,
      falsePositiveRate: 0.05,
      evaluationCount: 20,
      eligible: true,
    });
  });
});
