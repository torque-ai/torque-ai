const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const profileStore = require('../policy-engine/profile-store');
const engine = require('../policy-engine/engine');
const shadowEnforcer = require('../policy-engine/shadow-enforcer');
const taskHooks = require('../policy-engine/task-hooks');

describe('policy shadow rollout', () => {
  let db;
  let testDir;

  beforeEach(() => {
    ({ db, testDir } = setupTestDbOnly('policy-shadow-rollout'));
  });

  afterEach(() => {
    shadowEnforcer.setConfigReader(null);
    vi.restoreAllMocks();
    teardownTestDb();
  });

  function setFlagReader(overrides = {}) {
    const values = {
      policy_engine_enabled: '0',
      policy_engine_shadow_only: '1',
      policy_block_mode_enabled: '0',
      ...overrides,
    };
    shadowEnforcer.setConfigReader((key) => values[key] ?? null);
    return values;
  }

  function getSeededConfigValue(key) {
    const row = rawDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  function seedPolicy({
    profileId = 'shadow-rollout-profile',
    ruleId = 'shadow-rollout-rule',
    stage = 'task_submit',
    mode = 'warn',
    matcher = { target_types_any: ['task'] },
    requiredEvidence = [{ type: 'verify_command_passed' }],
    actions,
    overridePolicy = { allowed: true, reason_codes: ['approved_exception'] },
  } = {}) {
    profileStore.savePolicyProfile({
      id: profileId,
      name: `Profile ${profileId}`,
      project: null,
      defaults: { mode: 'advisory' },
      enabled: true,
    });
    profileStore.savePolicyRule({
      id: ruleId,
      name: ruleId,
      category: 'validation',
      stage,
      mode,
      priority: 100,
      matcher,
      required_evidence: requiredEvidence,
      actions: actions || [{ type: 'emit_violation', severity: mode === 'block' ? 'error' : 'warning' }],
      override_policy: overridePolicy,
      enabled: true,
    });
    profileStore.savePolicyBinding({
      id: `${profileId}:${ruleId}`,
      profile_id: profileId,
      policy_id: ruleId,
      enabled: true,
    });
  }

  function makeTaskData(overrides = {}) {
    return {
      id: 'task-shadow-rollout',
      project: 'Torque',
      working_directory: testDir,
      provider: 'codex',
      ...overrides,
    };
  }

  it('enforceMode returns off when engine disabled', () => {
    setFlagReader({ policy_engine_enabled: '0' });

    expect(shadowEnforcer.enforceMode('block')).toBe('off');
  });

  it('enforceMode returns shadow when shadow_only enabled', () => {
    setFlagReader({
      policy_engine_enabled: '1',
      policy_engine_shadow_only: '1',
    });

    expect(shadowEnforcer.enforceMode('block')).toBe('shadow');
  });

  it('enforceMode returns requested mode when shadow_only disabled and engine enabled', () => {
    setFlagReader({
      policy_engine_enabled: '1',
      policy_engine_shadow_only: '0',
    });

    expect(shadowEnforcer.enforceMode('warn')).toBe('warn');
  });

  it('enforceMode downgrades block to warn when block_mode disabled', () => {
    setFlagReader({
      policy_engine_enabled: '1',
      policy_engine_shadow_only: '0',
      policy_block_mode_enabled: '0',
    });

    expect(shadowEnforcer.enforceMode('block')).toBe('warn');
  });

  it('onTaskSubmit returns skipped when engine disabled', () => {
    setFlagReader({ policy_engine_enabled: '0' });

    expect(taskHooks.onTaskSubmit(makeTaskData())).toEqual({
      skipped: true,
      reason: 'policy_engine_disabled',
    });
  });

  it('onTaskSubmit evaluates policies when engine enabled', () => {
    setFlagReader({
      policy_engine_enabled: '1',
      policy_engine_shadow_only: '0',
    });
    seedPolicy({
      profileId: 'policy-submit-pass-profile',
      ruleId: 'policy-submit-pass-rule',
      stage: 'task_submit',
    });

    const result = taskHooks.onTaskSubmit(makeTaskData({
      id: 'task-submit-pass',
      evidence: { verify_command_passed: true },
    }));

    expect(result.skipped).toBeUndefined();
    expect(result.shadow).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.summary).toMatchObject({
      passed: 1,
      failed: 0,
      blocked: 0,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      policy_id: 'policy-submit-pass-rule',
      outcome: 'pass',
    });
  });

  it('onTaskSubmit returns shadow=true and blocked=false even with failing policies in shadow mode', () => {
    setFlagReader({
      policy_engine_enabled: '1',
      policy_engine_shadow_only: '1',
    });
    seedPolicy({
      profileId: 'policy-submit-shadow-profile',
      ruleId: 'policy-submit-shadow-rule',
      stage: 'task_submit',
      mode: 'block',
    });

    const result = taskHooks.onTaskSubmit(makeTaskData({
      id: 'task-submit-shadow',
      evidence: { verify_command_passed: false },
    }));

    expect(result.shadow).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.summary.failed).toBe(1);
    expect(result.results[0]).toMatchObject({
      policy_id: 'policy-submit-shadow-rule',
      outcome: 'fail',
      mode: 'shadow',
    });
  });

  it('onTaskSubmit returns blocked=true when a blocking policy fails in live mode', () => {
    setFlagReader({
      policy_engine_enabled: '1',
      policy_engine_shadow_only: '0',
      policy_block_mode_enabled: '1',
    });
    seedPolicy({
      profileId: 'policy-submit-live-profile',
      ruleId: 'policy-submit-live-rule',
      stage: 'task_submit',
      mode: 'block',
    });

    const result = taskHooks.onTaskSubmit(makeTaskData({
      id: 'task-submit-live',
      evidence: { verify_command_passed: false },
    }));

    expect(result.shadow).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.summary).toMatchObject({
      blocked: 1,
    });
    expect(result.results[0]).toMatchObject({
      policy_id: 'policy-submit-live-rule',
      outcome: 'fail',
      mode: 'block',
    });
  });

  it('onTaskComplete persists evaluation records', () => {
    setFlagReader({
      policy_engine_enabled: '1',
      policy_engine_shadow_only: '0',
    });
    seedPolicy({
      profileId: 'policy-complete-profile',
      ruleId: 'policy-complete-rule',
      stage: 'task_complete',
    });

    const result = taskHooks.onTaskComplete(makeTaskData({
      id: 'task-complete-persisted',
      evidence: { verify_command_passed: false },
    }));

    const stored = db.listPolicyEvaluations({
      stage: 'task_complete',
      target_id: 'task-complete-persisted',
    });

    expect(result.results).toHaveLength(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: result.results[0].evaluation_id,
      policy_id: 'policy-complete-rule',
      target_type: 'task',
      target_id: 'task-complete-persisted',
      project: 'Torque',
      stage: 'task_complete',
      outcome: 'fail',
    });
  });

  it('feature flags read from config correctly', () => {
    shadowEnforcer.setConfigReader((key) => getSeededConfigValue(key));

    expect(getSeededConfigValue('policy_engine_enabled')).toBe('0');
    expect(getSeededConfigValue('policy_engine_shadow_only')).toBe('1');
    expect(getSeededConfigValue('policy_block_mode_enabled')).toBe('0');
    expect(getSeededConfigValue('policy_rest_enabled')).toBe('0');
    expect(getSeededConfigValue('policy_mcp_enabled')).toBe('0');
    expect(getSeededConfigValue('policy_profile_torque_default_enabled')).toBe('0');
    expect(shadowEnforcer.isEngineEnabled()).toBe(false);
    expect(shadowEnforcer.isShadowOnly()).toBe(true);
    expect(shadowEnforcer.isBlockModeEnabled()).toBe(false);

    rawDb().prepare('UPDATE config SET value = ? WHERE key = ?').run('1', 'policy_engine_enabled');
    rawDb().prepare('UPDATE config SET value = ? WHERE key = ?').run('0', 'policy_engine_shadow_only');
    rawDb().prepare('UPDATE config SET value = ? WHERE key = ?').run('1', 'policy_block_mode_enabled');

    expect(shadowEnforcer.isEngineEnabled()).toBe(true);
    expect(shadowEnforcer.isShadowOnly()).toBe(false);
    expect(shadowEnforcer.isBlockModeEnabled()).toBe(true);
  });

  it('returns skipped with the error message when evaluation throws', () => {
    setFlagReader({
      policy_engine_enabled: '1',
      policy_engine_shadow_only: '0',
    });
    vi.spyOn(engine, 'evaluatePolicies').mockImplementation(() => {
      throw new Error('evaluation blew up');
    });

    const result = taskHooks.onTaskSubmit(makeTaskData({ id: 'task-submit-error' }));

    expect(result).toEqual({
      skipped: true,
      reason: 'evaluation_error',
      error: 'evaluation blew up',
    });
  });

  it('all 6 feature flags are seeded in schema-seeds.js', () => {
    expect({
      policy_engine_enabled: getSeededConfigValue('policy_engine_enabled'),
      policy_engine_shadow_only: getSeededConfigValue('policy_engine_shadow_only'),
      policy_rest_enabled: getSeededConfigValue('policy_rest_enabled'),
      policy_mcp_enabled: getSeededConfigValue('policy_mcp_enabled'),
      policy_block_mode_enabled: getSeededConfigValue('policy_block_mode_enabled'),
      policy_profile_torque_default_enabled: getSeededConfigValue('policy_profile_torque_default_enabled'),
    }).toEqual({
      policy_engine_enabled: '0',
      policy_engine_shadow_only: '1',
      policy_rest_enabled: '0',
      policy_mcp_enabled: '0',
      policy_block_mode_enabled: '0',
      policy_profile_torque_default_enabled: '0',
    });
  });
});
