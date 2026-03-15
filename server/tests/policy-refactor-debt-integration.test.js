const path = require('path');
const fs = require('fs');

const engine = require('../policy-engine/engine');
const profileStore = require('../policy-engine/profile-store');
const promotion = require('../policy-engine/promotion');
const { loadTorqueDefaults } = require('../policy-engine/profile-loader');
const {
  rawDb,
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
const seedFixture = require(path.join(policyFixtureRoot, 'artifacts', 'policy', 'config', 'torque-dev-policy.seed.json'));

const projectRoot = policyFixtureRoot;
const POLICY_ID = 'refactor_backlog_required_for_hotspot_worsening';

function mapRulesById(rules) {
  return new Map(rules.map((rule) => [rule.policy_id || rule.id, rule]));
}

describe('policy refactor debt integration', () => {
  let db;
  let testDir;

  beforeEach(() => {
    ({ db, testDir } = setupTestDb('policy-refactor-debt-integration'));
    loadTorqueDefaults(projectRoot);
  });

  afterEach(() => {
    teardownTestDb();
  });

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

  function seedComplexityMetric({
    taskId,
    filePath,
    cyclomatic,
    cognitive,
    analyzedAt,
    linesOfCode = 100,
    functionCount = 4,
    maxNestingDepth = 3,
    maintainabilityIndex = 70,
  }) {
    rawDb().prepare(`
      INSERT INTO complexity_metrics (
        task_id, file_path, cyclomatic_complexity, cognitive_complexity,
        lines_of_code, function_count, max_nesting_depth, maintainability_index, analyzed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      filePath,
      cyclomatic,
      cognitive,
      linesOfCode,
      functionCount,
      maxNestingDepth,
      maintainabilityIndex,
      analyzedAt,
    );
  }

  it('loads the refactor backlog policy from the default seed profile', () => {
    const seedRule = seedFixture.rules.find((rule) => rule.id === POLICY_ID);
    const completeRules = mapRulesById(profileStore.resolvePoliciesForStage({
      stage: 'task_complete',
      project_id: 'Torque',
      project_path: testDir,
    }));

    expect(seedRule).toMatchObject({
      id: POLICY_ID,
      category: 'architecture',
      description: 'Require a refactor backlog item when file complexity worsens',
      stage: 'task_complete',
      mode: 'advisory',
      signal_type: 'structural',
      evidence_keys: ['hotspots_worsened', 'has_backlog_item', 'files_checked'],
      condition: 'hotspots_worsened.length > 0 && !has_backlog_item',
    });
    expect(completeRules.get(POLICY_ID)).toMatchObject({
      policy_id: POLICY_ID,
      category: 'architecture',
      stage: 'task_complete',
      mode: 'advisory',
    });
    expect(profileStore.getPolicyBinding('torque-dev', POLICY_ID)).toMatchObject({
      mode_override: 'advisory',
    });
  });

  it('evaluates the refactor debt policy at task_complete and warns without blocking', () => {
    const filePath = 'server/policy-engine/refactor-target.js';
    createTask('task-refactor-prev');
    createTask('task-refactor-now');
    seedComplexityMetric({
      taskId: 'task-refactor-prev',
      filePath,
      cyclomatic: 10,
      cognitive: 18,
      analyzedAt: '2026-03-09T11:00:00.000Z',
    });
    seedComplexityMetric({
      taskId: 'task-refactor-now',
      filePath,
      cyclomatic: 15,
      cognitive: 27,
      analyzedAt: '2026-03-10T11:00:00.000Z',
    });

    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-refactor-now',
      project_id: 'Torque',
      project_path: testDir,
      changed_files: [filePath],
      evidence: {
        verify_command_passed: true,
      },
    });
    const refactorResult = result.results.find((entry) => entry.policy_id === POLICY_ID);
    const requirement = refactorResult.evidence.requirements[0];
    const hotspotCount = rawDb().prepare(`
      SELECT COUNT(*) AS count
      FROM refactor_hotspots
      WHERE project = ? AND file_path = ?
    `).get('Torque', filePath);

    expect(refactorResult).toMatchObject({
      outcome: 'fail',
      mode: 'advisory',
      severity: 'warning',
    });
    expect(requirement).toMatchObject({
      type: POLICY_ID,
      available: true,
      satisfied: false,
      value: {
        has_backlog_item: false,
        files_checked: 1,
      },
    });
    expect(requirement.value.hotspots_worsened).toHaveLength(1);
    expect(requirement.value.hotspots_worsened[0]).toMatchObject({
      file_path: filePath,
      trend: 'worsening',
      backlog_item_exists: false,
    });
    expect(result.summary).toMatchObject({
      failed: 1,
      warned: 1,
      blocked: 0,
    });
    expect(hotspotCount.count).toBe(1);
  });

  it('supports promotion through the standard policy ladder', () => {
    expect(profileStore.getPolicyBinding('torque-dev', POLICY_ID)).toMatchObject({
      mode_override: 'advisory',
    });

    const warnPolicy = promotion.promote(POLICY_ID, 'warn');
    const blockPolicy = promotion.promote(POLICY_ID, 'block');

    expect(warnPolicy).toMatchObject({
      policy_id: POLICY_ID,
      mode: 'warn',
    });
    expect(blockPolicy).toMatchObject({
      policy_id: POLICY_ID,
      mode: 'block',
    });
    expect(profileStore.getPolicyBinding('torque-dev', POLICY_ID)).toMatchObject({
      mode_override: 'block',
    });
  });
});
