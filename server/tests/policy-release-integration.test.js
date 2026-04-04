const fs = require('fs');
const path = require('path');

const engine = require('../policy-engine/engine');
const profileStore = require('../policy-engine/profile-store');
const promotion = require('../policy-engine/promotion');
const { loadTorqueDefaults } = require('../policy-engine/profile-loader');
const shadowEnforcer = require('../policy-engine/shadow-enforcer');
const taskHooks = require('../policy-engine/task-hooks');
const {
  rawDb,
  setupTestDbOnly,
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
const FEATURE_FLAG_POLICY_ID = 'feature_flag_required_for_user_visible_change';
const RELEASE_GATE_POLICY_ID = 'release_gate_required_for_production_surface';

function mapRulesById(rules) {
  return new Map(rules.map((rule) => [rule.policy_id || rule.id, rule]));
}

describe.skipIf(!hasSeedFile)('policy release integration', () => {
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

  function writeFixture(relativePath, content) {
    const absolutePath = path.join(testDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
    return relativePath.replace(/\\/g, '/');
  }

  function createTask(id, overrides = {}) {
    db.createTask({
      id,
      task_description: overrides.task_description || `Task ${id}`,
      status: overrides.status || 'completed',
      provider: overrides.provider || 'codex',
      working_directory: overrides.working_directory || testDir,
      project: overrides.project || 'Torque',
      ...overrides,
    });
    return id;
  }

  function seedRelease(id, project = 'Torque') {
    rawDb().prepare(`
      INSERT INTO releases (id, project, version, status)
      VALUES (?, ?, ?, ?)
    `).run(id, project, '1.0.0', 'gating');
  }

  function seedReleaseGate({
    id,
    releaseId,
    project = 'Torque',
    name,
    gateType,
    threshold = {},
    status = 'open',
  }) {
    rawDb().prepare(`
      INSERT INTO release_gates (
        id, project, release_id, name, gate_type, threshold, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      project,
      releaseId,
      name,
      gateType,
      JSON.stringify(threshold),
      status,
    );
  }

  function getResult(result, policyId) {
    return result.results.find((entry) => entry.policy_id === policyId);
  }

  beforeEach(() => {
    ({ db, testDir } = setupTestDbOnly('policy-release-integration'));
    setLivePolicyFlags();
    loadTorqueDefaults(projectRoot);
  });

  afterEach(() => {
    shadowEnforcer.setConfigReader(null);
    teardownTestDb();
  });

  it('loads both release policies from the seed profile', () => {
    const seedFeatureRule = seedFixture.rules.find((rule) => rule.id === FEATURE_FLAG_POLICY_ID);
    const seedReleaseRule = seedFixture.rules.find((rule) => rule.id === RELEASE_GATE_POLICY_ID);
    const completeRules = mapRulesById(profileStore.resolvePoliciesForStage({
      stage: 'task_complete',
      project_id: 'Torque',
      project_path: testDir,
    }));
    const manualReviewRules = mapRulesById(profileStore.resolvePoliciesForStage({
      stage: 'manual_review',
      project_id: 'Torque',
      project_path: testDir,
    }));

    expect(seedFeatureRule).toMatchObject({
      id: FEATURE_FLAG_POLICY_ID,
      category: 'release',
      description: 'Require feature flag for user-visible changes',
      stage: 'task_complete',
      mode: 'advisory',
      signal_type: 'structural',
      evidence_keys: ['user_visible_changes', 'feature_flags_found', 'has_feature_flag'],
      condition: 'user_visible_changes.length > 0 && !has_feature_flag',
    });
    expect(seedReleaseRule).toMatchObject({
      id: RELEASE_GATE_POLICY_ID,
      category: 'release',
      description: 'All release gates must pass before production deployment',
      stage: 'manual_review',
      mode: 'warn',
      signal_type: 'deterministic',
      evidence_keys: ['gates', 'all_passed', 'blocking_gates'],
      condition: '!all_passed',
    });
    expect(completeRules.get(FEATURE_FLAG_POLICY_ID)).toMatchObject({
      policy_id: FEATURE_FLAG_POLICY_ID,
      stage: 'task_complete',
      mode: 'advisory',
    });
    expect(manualReviewRules.get(RELEASE_GATE_POLICY_ID)).toMatchObject({
      policy_id: RELEASE_GATE_POLICY_ID,
      stage: 'manual_review',
      mode: 'warn',
    });
    expect(profileStore.getPolicyBinding('torque-dev', FEATURE_FLAG_POLICY_ID)).toMatchObject({
      mode_override: 'advisory',
    });
    expect(profileStore.getPolicyBinding('torque-dev', RELEASE_GATE_POLICY_ID)).toMatchObject({
      mode_override: 'warn',
    });
  });

  it('warns when a user-visible change has no feature flag', () => {
    const taskId = createTask('task-feature-flag-missing');
    const filePath = writeFixture(
      'src/components/NavShell.jsx',
      `
        export function NavShell() {
          return <nav>Navigation</nav>;
        }
      `,
    );

    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: taskId,
      project_id: 'Torque',
      project_path: testDir,
      changed_files: [filePath],
      evidence: {
        verify_command_passed: true,
      },
    });
    const featureFlagResult = getResult(result, FEATURE_FLAG_POLICY_ID);
    const requirement = featureFlagResult.evidence.requirements.find(
      (entry) => entry.type === FEATURE_FLAG_POLICY_ID,
    );

    expect(featureFlagResult).toMatchObject({
      outcome: 'fail',
      mode: 'advisory',
      severity: 'warning',
    });
    expect(requirement).toMatchObject({
      type: FEATURE_FLAG_POLICY_ID,
      available: true,
      satisfied: false,
      value: {
        has_feature_flag: false,
      },
    });
    expect(requirement.value.user_visible_changes).toEqual([
      expect.objectContaining({
        file_path: 'src/components/NavShell.jsx',
        reasons: expect.arrayContaining(['surface_path', 'react_component_export']),
      }),
    ]);
    expect(result.summary).toMatchObject({
      failed: 0,
      warned: 1,
      blocked: 0,
    });
  });

  it('stays clean when a user-visible change is covered by a feature flag', () => {
    const taskId = createTask('task-feature-flag-present');
    const filePath = writeFixture(
      'src/dashboard/ReleasePanel.jsx',
      `
        export function ReleasePanel() {
          if (featureFlags.isEnabled('release-panel-redesign')) {
            return <section>Redesign</section>;
          }
          return <section>Classic</section>;
        }
      `,
    );

    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: taskId,
      project_id: 'Torque',
      project_path: testDir,
      changed_files: [filePath],
      evidence: {
        verify_command_passed: true,
      },
    });
    const featureFlagResult = getResult(result, FEATURE_FLAG_POLICY_ID);
    const requirement = featureFlagResult.evidence.requirements.find(
      (entry) => entry.type === FEATURE_FLAG_POLICY_ID,
    );

    expect(featureFlagResult).toMatchObject({
      outcome: 'pass',
      mode: 'advisory',
      severity: null,
    });
    expect(requirement).toMatchObject({
      type: FEATURE_FLAG_POLICY_ID,
      available: true,
      satisfied: true,
      value: {
        has_feature_flag: true,
      },
    });
    expect(requirement.value.user_visible_changes).toHaveLength(1);
    expect(requirement.value.feature_flags_found).toEqual([
      expect.objectContaining({
        file_path: 'src/dashboard/ReleasePanel.jsx',
        flag_name: 'release-panel-redesign',
      }),
    ]);
    expect(result.summary).toMatchObject({
      failed: 0,
      warned: 0,
      blocked: 0,
    });
  });

  it('manual review evaluates release gates and returns a warn-level finding when gates fail', () => {
    seedRelease('release-manual-review');
    seedReleaseGate({
      id: 'gate-manual-signoff',
      releaseId: 'release-manual-review',
      name: 'Manual sign-off',
      gateType: 'manual_sign_off',
      status: 'open',
    });

    const result = taskHooks.onManualReview({
      release_id: 'release-manual-review',
      project: 'Torque',
      working_directory: testDir,
    });
    const releaseGateResult = getResult(result, RELEASE_GATE_POLICY_ID);
    const requirement = releaseGateResult.evidence.requirements.find(
      (entry) => entry.type === RELEASE_GATE_POLICY_ID,
    );
    const stored = rawDb().prepare(`
      SELECT target_type, target_id, stage, mode, outcome
      FROM policy_evaluations
      WHERE policy_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(RELEASE_GATE_POLICY_ID);

    expect(result.shadow).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.summary).toMatchObject({
      failed: 0,
      warned: 1,
      blocked: 0,
    });
    expect(releaseGateResult).toMatchObject({
      outcome: 'fail',
      mode: 'warn',
      severity: 'warning',
    });
    expect(requirement).toMatchObject({
      type: RELEASE_GATE_POLICY_ID,
      available: true,
      satisfied: false,
      value: {
        all_passed: false,
      },
    });
    expect(requirement.value.blocking_gates).toEqual([
      expect.objectContaining({
        id: 'gate-manual-signoff',
        gate_type: 'manual_sign_off',
        blocking: true,
      }),
    ]);
    expect(stored).toEqual({
      target_type: 'release',
      target_id: 'release-manual-review',
      stage: 'manual_review',
      mode: 'warn',
      outcome: 'fail',
    });
  });

  it('supports promotion for both release policies through the standard ladder', () => {
    expect(profileStore.getPolicyBinding('torque-dev', FEATURE_FLAG_POLICY_ID)).toMatchObject({
      mode_override: 'advisory',
    });
    expect(profileStore.getPolicyBinding('torque-dev', RELEASE_GATE_POLICY_ID)).toMatchObject({
      mode_override: 'warn',
    });

    const featureWarn = promotion.promote(FEATURE_FLAG_POLICY_ID, 'warn');
    const featureBlock = promotion.promote(FEATURE_FLAG_POLICY_ID, 'block');
    const releaseBlock = promotion.promote(RELEASE_GATE_POLICY_ID, 'block');

    expect(featureWarn).toMatchObject({
      policy_id: FEATURE_FLAG_POLICY_ID,
      mode: 'warn',
    });
    expect(featureBlock).toMatchObject({
      policy_id: FEATURE_FLAG_POLICY_ID,
      mode: 'block',
    });
    expect(releaseBlock).toMatchObject({
      policy_id: RELEASE_GATE_POLICY_ID,
      mode: 'block',
    });
    expect(profileStore.getPolicyBinding('torque-dev', FEATURE_FLAG_POLICY_ID)).toMatchObject({
      mode_override: 'block',
    });
    expect(profileStore.getPolicyBinding('torque-dev', RELEASE_GATE_POLICY_ID)).toMatchObject({
      mode_override: 'block',
    });
  });
});
