const {
  attachRollbackData,
  createRollbackPlan,
  formatPolicyProof,
} = require('../handlers/peek/rollback');

const mockShared = {
  peekHttpGetWithRetry: vi.fn(),
  peekHttpPostWithRetry: vi.fn(),
  resolvePeekHost: vi.fn(),
  resolvePeekTaskContext: vi.fn(),
};

const mockShadowEnforcer = {
  enforceMode: vi.fn(),
};

const mockTaskHooks = {
  evaluateAtStage: vi.fn(),
};

const mockLogger = {
  child: vi.fn(() => ({
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
};

const configCore = require('../db/config-core');
const sharedModule = require('../handlers/peek/shared');
const shadowEnforcerModule = require('../policy-engine/shadow-enforcer');
const taskHooksModule = require('../policy-engine/task-hooks');
const loggerModule = require('../logger');

const originalShared = {
  peekHttpGetWithRetry: sharedModule.peekHttpGetWithRetry,
  peekHttpPostWithRetry: sharedModule.peekHttpPostWithRetry,
  resolvePeekHost: sharedModule.resolvePeekHost,
  resolvePeekTaskContext: sharedModule.resolvePeekTaskContext,
};
const originalEnforceMode = shadowEnforcerModule.enforceMode;
const originalEvaluateAtStage = taskHooksModule.evaluateAtStage;
const originalLoggerChild = loggerModule.child;
const originalGetConfig = configCore.getConfig;

let handlePeekRecovery;

describe('peek rollback helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    sharedModule.peekHttpGetWithRetry = mockShared.peekHttpGetWithRetry;
    sharedModule.peekHttpPostWithRetry = mockShared.peekHttpPostWithRetry;
    sharedModule.resolvePeekHost = mockShared.resolvePeekHost;
    sharedModule.resolvePeekTaskContext = mockShared.resolvePeekTaskContext;
    shadowEnforcerModule.enforceMode = mockShadowEnforcer.enforceMode;
    taskHooksModule.evaluateAtStage = mockTaskHooks.evaluateAtStage;
    loggerModule.child = mockLogger.child;
    configCore.getConfig = vi.fn(() => null);

    delete require.cache[require.resolve('../handlers/peek/recovery')];
    ({ handlePeekRecovery } = require('../handlers/peek/recovery'));

    mockShared.resolvePeekHost.mockReturnValue({
      hostName: 'snap-host',
      hostUrl: 'http://snap-host',
    });
    mockShared.resolvePeekTaskContext.mockReturnValue({
      task: null,
      taskId: null,
      workflowId: null,
      taskLabel: null,
    });
    mockShadowEnforcer.enforceMode.mockImplementation((requestedMode) => requestedMode);
  });

  afterAll(() => {
    sharedModule.peekHttpGetWithRetry = originalShared.peekHttpGetWithRetry;
    sharedModule.peekHttpPostWithRetry = originalShared.peekHttpPostWithRetry;
    sharedModule.resolvePeekHost = originalShared.resolvePeekHost;
    sharedModule.resolvePeekTaskContext = originalShared.resolvePeekTaskContext;
    shadowEnforcerModule.enforceMode = originalEnforceMode;
    taskHooksModule.evaluateAtStage = originalEvaluateAtStage;
    loggerModule.child = originalLoggerChild;
    configCore.getConfig = originalGetConfig;
  });

  it('createRollbackPlan generates valid plans for each supported action type', () => {
    const plans = [
      createRollbackPlan('restart_process', { processName: 'notepad.exe' }),
      createRollbackPlan('clear_temp_cache', {
        deleted_paths: ['C:\\temp\\cache\\a.tmp', 'C:\\temp\\cache\\b.tmp'],
      }),
      createRollbackPlan('reset_window_position', {
        title: 'Calculator',
        original_position: { x: 10, y: 20, width: 300, height: 400 },
      }),
      createRollbackPlan('close_dialog', { title: 'Hung Dialog' }),
      createRollbackPlan('kill_hung_thread', {
        threadId: 'thread-9',
        thread_state: { wait_reason: 'io', stack: ['frame-a'] },
      }),
      createRollbackPlan('force_kill_process', {
        processName: 'stuck-app.exe',
        pid: 8421,
        killReason: 'unresponsive',
      }),
      createRollbackPlan('modify_registry_key', {
        registryPath: 'HKCU\\Software\\Torque\\FeatureFlag',
        originalValue: 'disabled',
        newValue: 'enabled',
      }),
      createRollbackPlan('inject_accessibility_hook', {
        targetProcess: 'reader.exe',
        hookType: 'uia',
        injectionMethod: 'remote_thread',
      }),
    ];

    for (const plan of plans) {
      expect(plan.action).toBeTruthy();
      expect(Array.isArray(plan.rollback_steps)).toBe(true);
      expect(plan.rollback_steps.length).toBeGreaterThan(0);
      expect(typeof plan.can_rollback).toBe('boolean');
      expect(typeof plan.estimated_impact).toBe('string');
    }
  });

  it('restart_process has can_rollback=false', () => {
    const plan = createRollbackPlan('restart_process', { processName: 'notepad.exe' });

    expect(plan.can_rollback).toBe(false);
    expect(plan.rollback_steps).toEqual([
      expect.objectContaining({
        step: 'noop',
        process_name: 'notepad.exe',
      }),
    ]);
  });

  it('reset_window_position has can_rollback=true', () => {
    const plan = createRollbackPlan('reset_window_position', {
      title: 'Calculator',
      original_position: { x: 50, y: 75, width: 640, height: 480 },
    });

    expect(plan.can_rollback).toBe(true);
    expect(plan.rollback_steps).toEqual([
      expect.objectContaining({
        step: 'restore_window_position',
        window: 'Calculator',
        original_position: { x: 50, y: 75, width: 640, height: 480 },
      }),
    ]);
  });

  it('formatPolicyProof formats evaluation results correctly', () => {
    const evaluationResult = {
      shadow: false,
      blocked: true,
      created_at: '2026-03-10T18:30:00.000Z',
      total_results: 3,
      summary: {
        passed: 1,
        warned: 1,
        failed: 2,
        blocked: 1,
      },
      results: [
        {
          policy_id: 'policy-pass',
          outcome: 'pass',
          mode: 'advisory',
          evidence: { verify_command_passed: true },
        },
        {
          policy_id: 'policy-warn',
          outcome: 'fail',
          mode: 'warn',
          evidence: { retry_budget: 1 },
        },
      ],
      suppressed_results: [
        {
          policy_id: 'policy-blocked',
          outcome: 'fail',
          mode: 'block',
          evidence: { approval_recorded: false },
        },
      ],
    };

    expect(formatPolicyProof(evaluationResult)).toEqual({
      evaluated_at: '2026-03-10T18:30:00.000Z',
      policies_checked: 3,
      passed: 1,
      warned: 1,
      failed: 2,
      blocked: 1,
      mode: 'block',
      details: [
        {
          policy_id: 'policy-pass',
          result: 'pass',
          evidence: { verify_command_passed: true },
        },
        {
          policy_id: 'policy-warn',
          result: 'fail',
          evidence: { retry_budget: 1 },
        },
        {
          policy_id: 'policy-blocked',
          result: 'fail',
          evidence: { approval_recorded: false },
        },
      ],
    });
  });

  it('attachRollbackData adds rollback info to an audit entry', () => {
    const auditEntry = {
      action_name: 'clear_temp_cache',
      success: true,
    };
    const rollbackPlan = createRollbackPlan('clear_temp_cache', {
      deleted_paths: ['C:\\temp\\cache\\one.tmp'],
    });

    expect(attachRollbackData(auditEntry, rollbackPlan)).toEqual({
      action_name: 'clear_temp_cache',
      success: true,
      rollback_plan: rollbackPlan,
    });
  });

  it('attaches policy proof and rollback plan throughout the recovery audit flow', async () => {
    configCore.getConfig.mockReturnValue('1');
    const rawPolicyEvaluation = {
      shadow: false,
      blocked: false,
      created_at: '2026-03-10T18:45:00.000Z',
      total_results: 2,
      summary: {
        passed: 1,
        warned: 1,
        failed: 1,
        blocked: 0,
      },
      results: [
        {
          policy_id: 'recovery-window-safe',
          outcome: 'pass',
          mode: 'advisory',
          evidence: { bounded: true },
        },
        {
          policy_id: 'recovery-window-audit',
          outcome: 'fail',
          mode: 'warn',
          evidence: { params_present: ['original_position', 'title'] },
        },
      ],
      suppressed_results: [],
    };

    mockTaskHooks.evaluateAtStage.mockReturnValue(rawPolicyEvaluation);
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: {
            name: 'reset_window_position',
            max_retries: 1,
            timeout_ms: 4000,
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          attempts: 1,
          audit_entry: {
            recovery_id: 'rec-rollback-1',
          },
        },
      });

    const params = {
      title: 'Calculator',
      original_position: { x: 20, y: 40, width: 500, height: 300 },
    };
    const expectedProof = {
      evaluated_at: '2026-03-10T18:45:00.000Z',
      policies_checked: 2,
      passed: 1,
      warned: 1,
      failed: 1,
      blocked: 0,
      mode: 'advisory',
      details: [
        {
          policy_id: 'recovery-window-safe',
          result: 'pass',
          evidence: { bounded: true },
        },
        {
          policy_id: 'recovery-window-audit',
          result: 'fail',
          evidence: { params_present: ['original_position', 'title'] },
        },
      ],
    };

    const result = await handlePeekRecovery({
      action: 'reset_window_position',
      params,
    });

    expect(result.success).toBe(true);
    expect(result.policy_proof).toEqual(expectedProof);
    expect(result.audit_entry).toMatchObject({
      recovery_id: 'rec-rollback-1',
      action_name: 'reset_window_position',
      mode: 'live',
      success: true,
      attempts: 1,
      policy_proof: expectedProof,
      rollback_plan: createRollbackPlan('reset_window_position', params),
    });
    expect(mockTaskHooks.evaluateAtStage).toHaveBeenCalledWith(
      'task_pre_execute',
      expect.objectContaining({
        command: 'peek_recovery:reset_window_position',
      }),
    );
  });
});
