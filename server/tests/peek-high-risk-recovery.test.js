const {
  RISK_CLASSIFICATION,
  classifyActionRisk,
  createRollbackPlan,
  validateHighRiskEvidence,
} = require('../plugins/snapscope/handlers/rollback');
const { resolveRecoveryMode } = require('../plugins/snapscope/handlers/recovery');

const HIGH_RISK_ACTIONS = [
  'force_kill_process',
  'modify_registry_key',
  'inject_accessibility_hook',
];

describe('peek high-risk recovery actions', () => {
  it('stores the new recovery actions as high-risk shadow-only approvals', () => {
    for (const action of HIGH_RISK_ACTIONS) {
      expect(RISK_CLASSIFICATION[action]).toEqual(expect.objectContaining({
        level: 'high',
        requires_approval: true,
        approval_required: true,
        shadow_only: true,
        verification_callback: expect.any(String),
        rollback_plan: expect.any(String),
      }));
      expect(resolveRecoveryMode(action)).toBe('shadow');
    }
  });

  it('returns the rollback plan for force_kill_process', () => {
    expect(createRollbackPlan('force_kill_process', {
      processName: 'frozen-app.exe',
      pid: 3210,
      killReason: 'operator confirmed hang',
    })).toEqual({
      action: 'force_kill_process',
      rollback_steps: [{
        step: 'log_process_termination',
        description: 'Record terminated process details for operator review and potential restart.',
        process_name: 'frozen-app.exe',
        pid: 3210,
        kill_reason: 'operator confirmed hang',
      }],
      can_rollback: false,
      estimated_impact: 'high',
      rollback_plan: 'Restart process from saved state',
      verification_callback: 'verify_process_killed',
    });
  });

  it('returns the rollback plan for modify_registry_key', () => {
    expect(createRollbackPlan('modify_registry_key', {
      registryPath: 'HKCU\\Software\\Torque\\Mode',
      originalValue: 'safe',
      newValue: 'recovery',
    })).toEqual({
      action: 'modify_registry_key',
      rollback_steps: [{
        step: 'restore_registry_value',
        description: 'Restore the original registry value before modification.',
        registry_path: 'HKCU\\Software\\Torque\\Mode',
        original_value: 'safe',
        new_value: 'recovery',
      }],
      can_rollback: true,
      estimated_impact: 'high',
      rollback_plan: 'Restore registry key from backup',
      verification_callback: 'verify_registry_restored',
    });
  });

  it('returns the rollback plan for inject_accessibility_hook', () => {
    expect(createRollbackPlan('inject_accessibility_hook', {
      targetProcess: 'reader.exe',
      hookType: 'uia',
      injectionMethod: 'set_windows_hook_ex',
    })).toEqual({
      action: 'inject_accessibility_hook',
      rollback_steps: [{
        step: 'remove_accessibility_hook',
        description: 'Remove the injected accessibility hook from the target process.',
        target_process: 'reader.exe',
        hook_type: 'uia',
        injection_method: 'set_windows_hook_ex',
      }],
      can_rollback: true,
      estimated_impact: 'high',
      rollback_plan: 'Remove injected hook and restore original state',
      verification_callback: 'verify_hook_injected',
    });
  });

  it('marks the expected rollback capability and verification callbacks', () => {
    const forceKillPlan = createRollbackPlan('force_kill_process', {
      process_name: 'frozen-app.exe',
      pid: 3210,
      kill_reason: 'operator confirmed hang',
    });
    const registryPlan = createRollbackPlan('modify_registry_key', {
      registry_path: 'HKCU\\Software\\Torque\\Mode',
      original_value: 'safe',
      new_value: 'recovery',
    });
    const hookPlan = createRollbackPlan('inject_accessibility_hook', {
      target_process: 'reader.exe',
      hook_type: 'uia',
      injection_method: 'set_windows_hook_ex',
    });

    expect(forceKillPlan.rollback_plan).toBe('Restart process from saved state');
    expect(forceKillPlan.verification_callback).toBe('verify_process_killed');
    expect(registryPlan.can_rollback).toBe(true);
    expect(registryPlan.rollback_plan).toBe('Restore registry key from backup');
    expect(hookPlan.can_rollback).toBe(true);
    expect(hookPlan.verification_callback).toBe('verify_hook_injected');
  });

  it('accepts complete high-risk evidence', () => {
    expect(validateHighRiskEvidence('modify_registry_key', {
      registry_path: 'HKCU\\Software\\Torque\\Mode',
      original_value: 0,
      new_value: 1,
    })).toEqual({
      sufficient: true,
      missing: [],
    });
  });

  it('reports missing or empty high-risk evidence fields', () => {
    expect(validateHighRiskEvidence('force_kill_process', {
      process_name: '   ',
      pid: 3210,
    })).toEqual({
      sufficient: false,
      missing: ['process_name', 'kill_reason'],
    });
  });

  it('classifies all new recovery actions as high risk', () => {
    for (const action of HIGH_RISK_ACTIONS) {
      expect(classifyActionRisk(action).level).toBe('high');
    }
  });
});
