const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const engine = require('../policy-engine/engine');
const policyDefs = require('../tool-defs/policy-defs');

const POLICY_MODES = ['off', 'shadow', 'advisory', 'warn', 'block'];
const POLICY_STAGES = [
  'task_submit',
  'task_pre_execute',
  'task_complete',
  'workflow_submit',
  'workflow_run',
  'manual_review',
];

describe('MCP policy tools', () => {
  let db;
  let testDir;

  beforeEach(() => {
    ({ db, testDir } = setupTestDb('mcp-policy-tools'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownTestDb();
  });

  function seedProfile({
    id = 'policy-profile-1',
    project = null,
    defaults = { mode: 'advisory' },
    project_match = {},
    policy_overrides = {},
    enabled = true,
  } = {}) {
    return db.savePolicyProfile({
      id,
      name: `Profile ${id}`,
      project,
      defaults,
      project_match,
      policy_overrides,
      enabled,
    });
  }

  function seedRule({
    id,
    name = id,
    category = 'change_safety',
    stage = 'task_complete',
    mode = 'advisory',
    priority = 100,
    matcher = {},
    required_evidence = [],
    actions = [{ type: 'emit_violation', severity: 'warning' }],
    override_policy = { allowed: true, reason_codes: ['approved_exception'] },
    tags = ['policy'],
    enabled = true,
  }) {
    return db.savePolicyRule({
      id,
      name,
      category,
      stage,
      mode,
      priority,
      matcher,
      required_evidence,
      actions,
      override_policy,
      tags,
      enabled,
    });
  }

  function seedBinding({
    id,
    profile_id,
    policy_id,
    mode_override = null,
    binding_json = {},
    enabled = true,
  }) {
    return db.savePolicyBinding({
      id,
      profile_id,
      policy_id,
      mode_override,
      binding_json,
      enabled,
    });
  }

  it('exports six typed policy tool definitions', () => {
    expect(policyDefs.map((tool) => tool.name)).toEqual([
      'list_policies',
      'get_policy',
      'set_policy_mode',
      'evaluate_policies',
      'list_policy_evaluations',
      'override_policy_decision',
    ]);

    const setPolicyMode = policyDefs.find((tool) => tool.name === 'set_policy_mode');
    const evaluatePolicies = policyDefs.find((tool) => tool.name === 'evaluate_policies');

    expect(setPolicyMode.inputSchema.properties.mode.enum).toEqual(POLICY_MODES);
    expect(setPolicyMode.inputSchema.required).toEqual(['policy_id', 'mode', 'reason']);
    expect(evaluatePolicies.inputSchema.properties.stage.enum).toEqual(POLICY_STAGES);
    expect(evaluatePolicies.inputSchema.required).toEqual(['stage', 'target_type', 'target_id']);
  });

  it('list_policies returns filtered rules', async () => {
    seedProfile({ id: 'profile-filtered' });
    db.setProjectMetadata('Torque', 'policy_profile_id', 'profile-filtered');

    seedRule({
      id: 'policy-blocked',
      category: 'change_safety',
      stage: 'task_complete',
      mode: 'warn',
      matcher: { changed_file_globs_any: ['server/**/*.js'] },
    });
    seedRule({
      id: 'policy-advisory',
      category: 'change_safety',
      stage: 'task_complete',
      mode: 'advisory',
    });
    seedRule({
      id: 'policy-submit-only',
      category: 'change_safety',
      stage: 'task_submit',
      mode: 'block',
    });

    seedBinding({
      id: 'binding-blocked',
      profile_id: 'profile-filtered',
      policy_id: 'policy-blocked',
      mode_override: 'block',
    });
    seedBinding({
      id: 'binding-advisory',
      profile_id: 'profile-filtered',
      policy_id: 'policy-advisory',
    });
    seedBinding({
      id: 'binding-submit',
      profile_id: 'profile-filtered',
      policy_id: 'policy-submit-only',
    });

    const result = await safeTool('list_policies', {
      project_id: 'Torque',
      category: 'change_safety',
      stage: 'task_complete',
      mode: 'block',
      enabled_only: true,
    });

    expect(result.isError).toBeUndefined();
    expect(result.profile_id).toBe('profile-filtered');
    expect(result.project_id).toBe('Torque');
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]).toMatchObject({
      id: 'policy-blocked',
      policy_id: 'policy-blocked',
      profile_id: 'profile-filtered',
      mode: 'block',
      category: 'change_safety',
      stage: 'task_complete',
      enabled: true,
    });
    expect(getText(result)).toContain('Found 1 policy');
  });

  it('get_policy returns full policy object', async () => {
    seedRule({
      id: 'policy-rich',
      name: 'Require review for critical writes',
      category: 'privacy_security',
      stage: 'task_pre_execute',
      mode: 'warn',
      priority: 5,
      matcher: {
        changed_file_globs_any: ['server/**/*.js'],
        exclude_globs_any: ['server/tests/**/*.js'],
      },
      required_evidence: [{ type: 'approval_recorded' }],
      actions: [{ type: 'emit_violation', severity: 'error' }],
      override_policy: { allowed: true, reason_codes: ['approved_exception', 'known_flake'] },
      tags: ['critical', 'server'],
    });

    const result = await safeTool('get_policy', { policy_id: 'policy-rich' });

    expect(result.isError).toBeUndefined();
    expect(result.policy).toMatchObject({
      id: 'policy-rich',
      name: 'Require review for critical writes',
      category: 'privacy_security',
      stage: 'task_pre_execute',
      mode: 'warn',
      priority: 5,
      matcher: {
        changed_file_globs_any: ['server/**/*.js'],
        exclude_globs_any: ['server/tests/**/*.js'],
      },
      required_evidence: [{ type: 'approval_recorded' }],
      actions: [{ type: 'emit_violation', severity: 'error' }],
      override_policy: { allowed: true, reason_codes: ['approved_exception', 'known_flake'] },
      tags: ['critical', 'server'],
      enabled: true,
    });
    expect(getText(result)).toContain('Loaded policy policy-rich');
  });

  it('set_policy_mode validates mode enum', async () => {
    seedRule({ id: 'policy-mode-validation' });

    const result = await safeTool('set_policy_mode', {
      policy_id: 'policy-mode-validation',
      mode: 'invalid-mode',
      reason: 'Trying an unsupported value',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(getText(result)).toContain(`mode must be one of: ${POLICY_MODES.join(', ')}`);
    expect(db.getPolicyRule('policy-mode-validation').mode).toBe('advisory');
  });

  it('evaluate_policies calls engine and returns results', async () => {
    const evaluation = {
      evaluation_id: 'batch-1',
      stage: 'task_complete',
      target: { type: 'task', id: 'task-123' },
      profile_id: 'profile-eval',
      summary: {
        passed: 0,
        failed: 1,
        warned: 1,
        blocked: 0,
        degraded: 0,
        skipped: 0,
        overridden: 0,
        suppressed: 0,
      },
      results: [{
        evaluation_id: 'eval-1',
        policy_id: 'policy-1',
        outcome: 'fail',
        mode: 'warn',
        severity: 'warning',
        message: 'required evidence failed: approval_recorded',
      }],
      suppressed_results: [],
      total_results: 1,
      created_at: '2026-03-10T00:00:00.000Z',
    };

    const spy = vi.spyOn(engine, 'evaluatePolicies').mockReturnValue(evaluation);
    const args = {
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-123',
      project_id: 'Torque',
      project_path: testDir,
      provider: 'codex',
    };

    const result = await safeTool('evaluate_policies', args);

    expect(spy).toHaveBeenCalledWith(args);
    expect(result.isError).toBeUndefined();
    expect(result).toMatchObject(evaluation);
    expect(getText(result)).toContain('Evaluated 1 policy result(s) for task_complete:task:task-123');
  });

  it('list_policy_evaluations supports filtering', async () => {
    seedProfile({ id: 'profile-history' });
    seedRule({ id: 'policy-history', stage: 'task_complete' });
    seedRule({ id: 'policy-history-other', stage: 'task_complete' });

    db.createPolicyEvaluation({
      id: 'eval-filter-match',
      policy_id: 'policy-history',
      profile_id: 'profile-history',
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-filter-1',
      project: 'Torque',
      mode: 'warn',
      outcome: 'fail',
      severity: 'warning',
      message: 'approval missing',
      evidence: { requirements: [{ type: 'approval_recorded', available: true, satisfied: false }] },
      evaluation: { batch_id: 'batch-filter' },
      override_allowed: true,
      suppressed: false,
      created_at: '2026-03-10T00:00:00.000Z',
    });
    db.createPolicyEvaluation({
      id: 'eval-filter-other',
      policy_id: 'policy-history-other',
      profile_id: 'profile-history',
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-filter-2',
      project: 'Torque',
      mode: 'advisory',
      outcome: 'pass',
      severity: null,
      message: 'policy requirements satisfied',
      evidence: { requirements: [] },
      evaluation: { batch_id: 'batch-filter' },
      override_allowed: false,
      suppressed: true,
      suppression_reason: 'unchanged_scope_replay',
      created_at: '2026-03-10T00:01:00.000Z',
    });

    const result = await safeTool('list_policy_evaluations', {
      project_id: 'Torque',
      policy_id: 'policy-history',
      profile_id: 'profile-history',
      stage: 'task_complete',
      outcome: 'fail',
      suppressed: false,
      target_type: 'task',
      target_id: 'task-filter-1',
      limit: 10,
      offset: 0,
    });

    expect(result.isError).toBeUndefined();
    expect(result.count).toBe(1);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]).toMatchObject({
      id: 'eval-filter-match',
      policy_id: 'policy-history',
      profile_id: 'profile-history',
      project: 'Torque',
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-filter-1',
      outcome: 'fail',
      suppressed: false,
    });
    expect(getText(result)).toContain('Found 1 policy evaluation');
  });

  it('override_policy_decision validates reason_code', async () => {
    seedProfile({ id: 'profile-override-validation' });
    seedRule({
      id: 'policy-override-validation',
      stage: 'task_complete',
      mode: 'warn',
      override_policy: { allowed: true, reason_codes: ['approved_exception'] },
    });

    const evaluation = db.createPolicyEvaluation({
      id: 'eval-override-validation',
      policy_id: 'policy-override-validation',
      profile_id: 'profile-override-validation',
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-override-validation',
      project: 'Torque',
      mode: 'warn',
      outcome: 'fail',
      severity: 'warning',
      message: 'approval missing',
      evidence: { requirements: [{ type: 'approval_recorded', available: true, satisfied: false }] },
      evaluation: {
        override_policy: {
          allowed: true,
          reason_codes: ['approved_exception'],
        },
      },
      override_allowed: true,
      suppressed: false,
      created_at: '2026-03-10T00:00:00.000Z',
    });

    const result = await safeTool('override_policy_decision', {
      evaluation_id: evaluation.id,
      reason_code: 'not_allowed_here',
      actor: 'operator-1',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
    expect(getText(result)).toContain('Override reason_code not_allowed_here is not allowed');
    expect(db.listPolicyOverrides({ evaluation_id: evaluation.id })).toHaveLength(0);
  });

  it('missing required args return appropriate errors', async () => {
    const cases = [
      {
        tool: 'get_policy',
        args: {},
        code: 'MISSING_REQUIRED_PARAM',
        text: 'policy_id is required and must be a non-empty string',
      },
      {
        tool: 'set_policy_mode',
        args: { policy_id: 'policy-1', mode: 'warn' },
        code: 'MISSING_REQUIRED_PARAM',
        text: 'reason is required and must be a non-empty string',
      },
      {
        tool: 'evaluate_policies',
        args: { stage: 'task_complete', target_type: 'task' },
        code: 'MISSING_REQUIRED_PARAM',
        text: 'target_id is required and must be a non-empty string',
      },
      {
        tool: 'override_policy_decision',
        args: { evaluation_id: 'eval-1' },
        code: 'MISSING_REQUIRED_PARAM',
        text: 'reason_code is required and must be a non-empty string',
      },
    ];

    for (const testCase of cases) {
      const result = await safeTool(testCase.tool, testCase.args);

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(testCase.code);
      expect(getText(result)).toContain(testCase.text);
    }
  });
});
