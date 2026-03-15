const fs = require('fs');
const path = require('path');

const engine = require('../policy-engine/engine');
const profileStore = require('../policy-engine/profile-store');
const promotion = require('../policy-engine/promotion');
const { loadTorqueDefaults } = require('../policy-engine/profile-loader');
const {
  rawDb,
  setupTestDb,
  teardownTestDb,
} = require('./vitest-setup');

const seedFixture = require('../../artifacts/policy/config/torque-dev-policy.seed.json');

const projectRoot = path.resolve(__dirname, '..', '..');
const ARCHITECTURE_POLICY_ID = 'architecture_boundary_violation';
const PARITY_POLICY_ID = 'canonical_surface_parity_required';

function mapRulesById(rules) {
  return new Map(rules.map((rule) => [rule.policy_id || rule.id, rule]));
}

describe('policy architecture integration', () => {
  let db;
  let testDir;

  beforeEach(() => {
    ({ db, testDir } = setupTestDb('policy-architecture-integration'));
    loadTorqueDefaults(projectRoot);
    db.setProjectMetadata('Torque', 'policy_profile_id', 'torque-dev');
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

  function writeProjectFile(relativePath, content) {
    const fullPath = path.join(testDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return relativePath;
  }

  function getResult(result, policyId) {
    return result.results.find((entry) => entry.policy_id === policyId);
  }

  it('loads the seed profile with both architecture policies and default boundaries', () => {
    const boundaryRule = seedFixture.rules.find((rule) => rule.id === ARCHITECTURE_POLICY_ID);
    const parityRule = seedFixture.rules.find((rule) => rule.id === PARITY_POLICY_ID);
    const completeRules = mapRulesById(profileStore.resolvePoliciesForStage({
      stage: 'task_complete',
      project_id: 'Torque',
      project_path: testDir,
    }));

    expect(boundaryRule).toMatchObject({
      id: ARCHITECTURE_POLICY_ID,
      category: 'architecture',
      description: 'Flag imports that cross declared architecture boundaries',
      stage: 'task_complete',
      mode: 'advisory',
      signal_type: 'structural',
      evidence_keys: ['violations', 'boundaries_checked', 'files_scanned'],
      condition: 'violations.length > 0',
      required_evidence: [ARCHITECTURE_POLICY_ID],
    });
    expect(parityRule).toMatchObject({
      id: PARITY_POLICY_ID,
      category: 'architecture',
      description: 'Ensure durable capabilities are available across MCP and REST transports',
      stage: 'task_complete',
      mode: 'advisory',
      signal_type: 'structural',
      evidence_keys: ['mcp_only_tools', 'rest_only_endpoints', 'parity_score'],
      condition: 'mcp_only_tools.length > 0 || rest_only_endpoints.length > 0',
    });
    expect(seedFixture.profile.architecture_boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'torque_handlers_layer_boundary',
        project: 'Torque',
        boundary_type: 'layer',
        source_patterns: ['server/handlers/**'],
        forbidden_dependencies: ['server/task-manager.js', 'server/database.js'],
      }),
      expect.objectContaining({
        id: 'torque_policy_adapters_layer_boundary',
        project: 'Torque',
        boundary_type: 'layer',
        source_patterns: ['server/policy-engine/adapters/**'],
        forbidden_dependencies: ['server/task-manager.js'],
      }),
    ]));
    expect(completeRules.get(ARCHITECTURE_POLICY_ID)).toMatchObject({
      policy_id: ARCHITECTURE_POLICY_ID,
      category: 'architecture',
      stage: 'task_complete',
      mode: 'advisory',
    });
    expect(completeRules.get(PARITY_POLICY_ID)).toMatchObject({
      policy_id: PARITY_POLICY_ID,
      category: 'architecture',
      stage: 'task_complete',
      mode: 'advisory',
    });
    expect(profileStore.getPolicyBinding('torque-dev', ARCHITECTURE_POLICY_ID)).toMatchObject({
      mode_override: 'advisory',
    });
    expect(profileStore.getPolicyBinding('torque-dev', PARITY_POLICY_ID)).toMatchObject({
      mode_override: 'advisory',
    });
  });

  it('evaluates architecture boundary violations at task_complete as advisory warnings', () => {
    createTask('task-architecture-violation');
    writeProjectFile(
      'server/handlers/violating-handler.js',
      "const taskManager = require('../task-manager.js');\nmodule.exports = taskManager;\n",
    );

    const boundaryCountBefore = rawDb().prepare(`
      SELECT COUNT(*) AS count
      FROM architecture_boundaries
    `).get();

    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-architecture-violation',
      project_id: 'Torque',
      project_path: testDir,
      changed_files: ['server/handlers/violating-handler.js'],
      evidence: {
        verify_command_passed: true,
      },
    });

    const architectureResult = getResult(result, ARCHITECTURE_POLICY_ID);
    const requirement = architectureResult.evidence.requirements.find(
      (entry) => entry.type === ARCHITECTURE_POLICY_ID,
    );
    const boundaryCountAfter = rawDb().prepare(`
      SELECT COUNT(*) AS count
      FROM architecture_boundaries
    `).get();
    const storedViolations = rawDb().prepare(`
      SELECT boundary_id, source_file, imported_file, violation_type
      FROM architecture_violations
      ORDER BY imported_file ASC
    `).all();

    expect(boundaryCountBefore.count).toBe(0);
    expect(architectureResult).toMatchObject({
      policy_id: ARCHITECTURE_POLICY_ID,
      outcome: 'fail',
      mode: 'advisory',
      severity: 'warning',
    });
    expect(requirement).toMatchObject({
      type: ARCHITECTURE_POLICY_ID,
      available: true,
      satisfied: false,
      value: {
        boundaries_checked: 2,
        files_scanned: 1,
      },
    });
    expect(requirement.value.violations).toHaveLength(1);
    expect(requirement.value.violations[0]).toMatchObject({
      boundary_id: 'torque_handlers_layer_boundary',
      source_file: 'server/handlers/violating-handler.js',
      imported_file: 'server/task-manager.js',
      violation_type: 'forbidden_import',
    });
    expect(result.summary).toMatchObject({
      failed: 1,
      warned: 1,
      blocked: 0,
    });
    expect(boundaryCountAfter.count).toBe(2);
    expect(storedViolations).toEqual([
      {
        boundary_id: 'torque_handlers_layer_boundary',
        source_file: 'server/handlers/violating-handler.js',
        imported_file: 'server/task-manager.js',
        violation_type: 'forbidden_import',
      },
    ]);
  });

  it('returns a clean evaluation when no architecture boundaries are violated', () => {
    createTask('task-architecture-clean');
    writeProjectFile(
      'server/handlers/clean-handler.js',
      "const shared = require('./shared.js');\nmodule.exports = shared;\n",
    );

    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-architecture-clean',
      project_id: 'Torque',
      project_path: testDir,
      changed_files: ['server/handlers/clean-handler.js'],
      evidence: {
        verify_command_passed: true,
      },
    });

    const architectureResult = getResult(result, ARCHITECTURE_POLICY_ID);
    const requirement = architectureResult.evidence.requirements.find(
      (entry) => entry.type === ARCHITECTURE_POLICY_ID,
    );

    expect(architectureResult).toMatchObject({
      policy_id: ARCHITECTURE_POLICY_ID,
      outcome: 'pass',
      mode: 'advisory',
    });
    expect(requirement).toMatchObject({
      type: ARCHITECTURE_POLICY_ID,
      available: true,
      satisfied: true,
      value: {
        boundaries_checked: 2,
        files_scanned: 1,
        violations: [],
      },
    });
    expect(result.summary).toMatchObject({
      failed: 0,
      warned: 0,
      blocked: 0,
    });
  });

  it('supports promotion through the standard policy ladder', () => {
    expect(profileStore.getPolicyBinding('torque-dev', ARCHITECTURE_POLICY_ID)).toMatchObject({
      mode_override: 'advisory',
    });

    const warnPolicy = promotion.promote(ARCHITECTURE_POLICY_ID, 'warn');
    const blockPolicy = promotion.promote(ARCHITECTURE_POLICY_ID, 'block');

    expect(warnPolicy).toMatchObject({
      policy_id: ARCHITECTURE_POLICY_ID,
      mode: 'warn',
    });
    expect(blockPolicy).toMatchObject({
      policy_id: ARCHITECTURE_POLICY_ID,
      mode: 'block',
    });
    expect(profileStore.getPolicyBinding('torque-dev', ARCHITECTURE_POLICY_ID)).toMatchObject({
      mode_override: 'block',
    });
  });
});
