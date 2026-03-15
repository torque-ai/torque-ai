const fs = require('fs');
const path = require('path');

const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');
const featureFlagAdapter = require('../policy-engine/adapters/feature-flag');
const releaseGateAdapter = require('../policy-engine/adapters/release-gate');

describe('policy release gating adapters', () => {
  let testDir;

  beforeEach(() => {
    ({ testDir } = setupTestDb('policy-release-gating'));
  });

  afterEach(() => {
    teardownTestDb();
  });

  function writeFixture(relativePath, content) {
    const absolutePath = path.join(testDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
    return relativePath.replace(/\\/g, '/');
  }

  function hasFeatureFlagViolation(evidence) {
    return evidence.user_visible_changes.length > 0 && !evidence.has_feature_flag;
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

  function seedPolicyRule(id, stage = 'task_complete') {
    rawDb().prepare(`
      INSERT INTO policy_rules (
        id, name, category, stage, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      `Policy ${id}`,
      'release',
      stage,
      '2026-03-10T00:00:00.000Z',
      '2026-03-10T00:00:00.000Z',
    );
  }

  function seedPolicyEvaluation({
    id,
    policyId,
    project = 'Torque',
    outcome = 'pass',
    stage = 'manual_review',
  }) {
    rawDb().prepare(`
      INSERT INTO policy_evaluations (
        id, policy_id, profile_id, stage, target_type, target_id, project,
        mode, outcome, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      policyId,
      null,
      stage,
      'release',
      'release-1',
      project,
      'warn',
      outcome,
      '2026-03-10T12:00:00.000Z',
    );
  }

  it('feature-flag adapter detects env var flags', () => {
    const filePath = writeFixture(
      'src/components/BetaBanner.jsx',
      `
        export function BetaBanner() {
          return process.env.FEATURE_NEW_BANNER ? <div>Beta</div> : null;
        }
      `,
    );

    const evidence = featureFlagAdapter.collectEvidence(
      { id: 'task-feature-env', working_directory: testDir },
      [filePath],
    );

    expect(evidence.has_feature_flag).toBe(true);
    expect(evidence.feature_flags_found).toEqual([
      expect.objectContaining({
        file_path: 'src/components/BetaBanner.jsx',
        flag_name: 'FEATURE_NEW_BANNER',
        flag_type: 'env',
      }),
    ]);

    const persisted = rawDb().prepare(`
      SELECT task_id, file_path, flag_name, flag_type
      FROM feature_flag_evidence
      WHERE task_id = ?
    `).all('task-feature-env');
    expect(persisted).toEqual([
      {
        task_id: 'task-feature-env',
        file_path: 'src/components/BetaBanner.jsx',
        flag_name: 'FEATURE_NEW_BANNER',
        flag_type: 'env',
      },
    ]);
  });

  it('feature-flag adapter identifies user-visible file changes', () => {
    const filePath = writeFixture(
      'src/components/NavShell.jsx',
      `
        export function NavShell() {
          return <nav>Navigation</nav>;
        }
      `,
    );

    const evidence = featureFlagAdapter.collectEvidence(
      { id: 'task-visible-surface', working_directory: testDir },
      [filePath],
    );

    expect(evidence.user_visible_changes).toEqual([
      {
        file_path: 'src/components/NavShell.jsx',
        reasons: expect.arrayContaining(['surface_path', 'react_component_export']),
      },
    ]);
  });

  it('feature-flag adapter produces violation when user-visible change lacks flag', () => {
    const filePath = writeFixture(
      'src/routes/account.js',
      `
        export async function GET() {
          return Response.json({ ok: true });
        }
      `,
    );

    const evidence = featureFlagAdapter.collectEvidence(
      { id: 'task-visible-no-flag', working_directory: testDir },
      [filePath],
    );

    expect(evidence.user_visible_changes).toHaveLength(1);
    expect(evidence.has_feature_flag).toBe(false);
    expect(hasFeatureFlagViolation(evidence)).toBe(true);
  });

  it('feature-flag adapter produces no violation when flag is present', () => {
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

    const evidence = featureFlagAdapter.collectEvidence(
      { id: 'task-visible-flagged', working_directory: testDir },
      [filePath],
    );

    expect(evidence.user_visible_changes).toHaveLength(1);
    expect(evidence.has_feature_flag).toBe(true);
    expect(hasFeatureFlagViolation(evidence)).toBe(false);
  });

  it('release-gate adapter evaluates policy_aggregate gate', () => {
    seedRelease('release-1');
    seedReleaseGate({
      id: 'gate-policy',
      releaseId: 'release-1',
      name: 'Policy aggregate',
      gateType: 'policy_aggregate',
      threshold: { minimum_pass_rate: 0.75, minimum_evaluations: 4, stage: 'manual_review' },
    });
    seedPolicyRule('policy-1', 'manual_review');
    seedPolicyRule('policy-2', 'manual_review');
    seedPolicyEvaluation({ id: 'eval-1', policyId: 'policy-1', outcome: 'pass' });
    seedPolicyEvaluation({ id: 'eval-2', policyId: 'policy-1', outcome: 'pass' });
    seedPolicyEvaluation({ id: 'eval-3', policyId: 'policy-2', outcome: 'pass' });
    seedPolicyEvaluation({ id: 'eval-4', policyId: 'policy-2', outcome: 'fail' });

    const result = releaseGateAdapter.evaluateGates('release-1', 'Torque');

    expect(result.all_passed).toBe(true);
    expect(result.blocking_gates).toEqual([]);
    expect(result.gates).toEqual([
      expect.objectContaining({
        id: 'gate-policy',
        gate_type: 'policy_aggregate',
        status: 'passed',
        checked: true,
        passed: true,
        blocking: false,
        metrics: expect.objectContaining({
          total_evaluations: 4,
          passing_evaluations: 3,
          pass_rate: 0.75,
          minimum_pass_rate: 0.75,
          minimum_evaluations: 4,
        }),
      }),
    ]);

    const storedGate = rawDb().prepare(`
      SELECT status, evaluated_at
      FROM release_gates
      WHERE id = ?
    `).get('gate-policy');
    expect(storedGate.status).toBe('passed');
    expect(storedGate.evaluated_at).toBeTruthy();
  });

  it('release-gate adapter reports blocking gates', () => {
    seedRelease('release-2');
    seedReleaseGate({
      id: 'gate-signoff',
      releaseId: 'release-2',
      name: 'Manual sign-off',
      gateType: 'manual_sign_off',
      status: 'open',
    });
    seedReleaseGate({
      id: 'gate-approval',
      releaseId: 'release-2',
      name: 'Approvals',
      gateType: 'approval_count',
      status: 'open',
    });

    const result = releaseGateAdapter.evaluateGates('release-2', 'Torque');

    expect(result.all_passed).toBe(false);
    expect(result.blocking_gates).toHaveLength(2);
    expect(result.blocking_gates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'gate-signoff',
        gate_type: 'manual_sign_off',
        blocking: true,
      }),
      expect.objectContaining({
        id: 'gate-approval',
        gate_type: 'approval_count',
        blocking: true,
        checked: false,
        reason: 'not implemented',
      }),
    ]));
  });

  it('release-gate adapter handles empty gate list', () => {
    seedRelease('release-empty');

    const result = releaseGateAdapter.evaluateGates('release-empty', 'Torque');

    expect(result).toEqual({
      gates: [],
      all_passed: true,
      blocking_gates: [],
    });
  });
});
