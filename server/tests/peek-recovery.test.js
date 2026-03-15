const mockShared = {
  peekHttpGetWithRetry: vi.fn(),
  peekHttpPostWithRetry: vi.fn(),
  resolvePeekHost: vi.fn(),
  resolvePeekTaskContext: vi.fn(),
};
const { createRollbackPlan, formatPolicyProof } = require('../handlers/peek/rollback');

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

const databaseModule = require('../database');
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
const originalGetConfig = databaseModule.getConfig;

let handlePeekRecovery;
let handlePeekRecoveryStatus;

function getExecutePayload() {
  const executeCalls = mockShared.peekHttpPostWithRetry.mock.calls.filter(
    ([url]) => typeof url === 'string' && url.includes('/recovery/execute'),
  );
  return executeCalls[executeCalls.length - 1]?.[1];
}

function getExecuteCalls() {
  return mockShared.peekHttpPostWithRetry.mock.calls.filter(
    ([url]) => typeof url === 'string' && url.includes('/recovery/execute'),
  );
}

describe('peek recovery handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    sharedModule.peekHttpGetWithRetry = mockShared.peekHttpGetWithRetry;
    sharedModule.peekHttpPostWithRetry = mockShared.peekHttpPostWithRetry;
    sharedModule.resolvePeekHost = mockShared.resolvePeekHost;
    sharedModule.resolvePeekTaskContext = mockShared.resolvePeekTaskContext;
    shadowEnforcerModule.enforceMode = mockShadowEnforcer.enforceMode;
    taskHooksModule.evaluateAtStage = mockTaskHooks.evaluateAtStage;
    loggerModule.child = mockLogger.child;
    databaseModule.getConfig = vi.fn(() => null);

    delete require.cache[require.resolve('../handlers/peek/recovery')];

    ({
      handlePeekRecovery,
      handlePeekRecoveryStatus,
    } = require('../handlers/peek/recovery'));

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
    mockShared.peekHttpGetWithRetry.mockResolvedValue({
      data: {
        allowed_actions: [],
        retry_budgets: {},
        stop_conditions: {},
      },
    });
    mockShadowEnforcer.enforceMode.mockImplementation((requestedMode) => requestedMode);
    mockTaskHooks.evaluateAtStage.mockReturnValue({
      shadow: false,
      blocked: false,
      summary: { passed: 1, failed: 0, blocked: 0 },
      results: [{ policy_id: 'recovery-policy', outcome: 'pass' }],
    });
  });

  afterAll(() => {
    sharedModule.peekHttpGetWithRetry = originalShared.peekHttpGetWithRetry;
    sharedModule.peekHttpPostWithRetry = originalShared.peekHttpPostWithRetry;
    sharedModule.resolvePeekHost = originalShared.resolvePeekHost;
    sharedModule.resolvePeekTaskContext = originalShared.resolvePeekTaskContext;
    shadowEnforcerModule.enforceMode = originalEnforceMode;
    taskHooksModule.evaluateAtStage = originalEvaluateAtStage;
    loggerModule.child = originalLoggerChild;
    databaseModule.getConfig = originalGetConfig;
  });

  it('handlePeekRecovery rejects unknown actions', async () => {
    mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
      data: {
        allowed: false,
        reason: 'Unknown recovery action',
      },
    });

    const result = await handlePeekRecovery({
      action: 'reboot_machine',
    });

    expect(result).toMatchObject({
      success: false,
      action: 'reboot_machine',
      mode: 'shadow',
      risk_level: 'high',
      audit_entry: {
        risk_level: 'high',
      },
    });
    expect(result.audit_entry.error).toContain('Unknown recovery action');
    expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledTimes(1);
    expect(mockTaskHooks.evaluateAtStage).not.toHaveBeenCalled();
  });

  it('Shadow mode only simulates, never executes live recovery', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: {
            name: 'kill_hung_thread',
            max_retries: 1,
            timeout_ms: 15000,
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          attempts: 0,
        },
      });

    const result = await handlePeekRecovery({
      action: 'kill_hung_thread',
      params: { threadId: 'thread-7' },
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('shadow');
    expect(getExecutePayload()).toMatchObject({
      action: 'kill_hung_thread',
      mode: 'shadow',
      simulate: true,
      dry_run: true,
      extra_monitoring: false,
    });
  });

  it('Canary mode executes with monitoring flag', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: {
            name: 'restart_process',
            max_retries: 1,
            timeout_ms: 15000,
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          attempts: 0,
          audit_entry: {
            recovery_id: 'rec-shadow-1',
            mode: 'shadow',
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          attempts: 1,
        },
      });

    const result = await handlePeekRecovery({
      action: 'restart_process',
      params: { processName: 'notepad.exe' },
    });

    const executeCalls = getExecuteCalls();

    expect(result.success).toBe(true);
    expect(result.mode).toBe('canary');
    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[0][1]).toMatchObject({
      action: 'restart_process',
      mode: 'shadow',
      simulate: true,
      dry_run: true,
      extra_monitoring: false,
      monitoring: {
        level: 'shadow',
        extra: false,
      },
    });
    expect(getExecutePayload()).toMatchObject({
      action: 'restart_process',
      mode: 'canary',
      simulate: false,
      dry_run: false,
      extra_monitoring: true,
      monitoring: {
        level: 'canary',
        extra: true,
      },
    });
  });

  it('Policy proof is attached to recovery decisions', async () => {
    databaseModule.getConfig.mockReturnValue('1');
    const rawPolicyProof = {
      shadow: false,
      blocked: false,
      created_at: '2026-03-10T19:00:00.000Z',
      total_results: 1,
      summary: { passed: 1, failed: 0, blocked: 0 },
      results: [{ policy_id: 'torque.recovery.low-risk.v1', outcome: 'pass', mode: 'advisory' }],
    };
    const formattedPolicyProof = formatPolicyProof(rawPolicyProof);
    mockTaskHooks.evaluateAtStage.mockReturnValue(rawPolicyProof);
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
            recovery_id: 'rec-123',
            action_name: 'reset_window_position',
            mode: 'live',
          },
        },
    });

    const result = await handlePeekRecovery({
      action: 'reset_window_position',
      params: {
        title: 'Calculator',
        original_position: { x: 15, y: 25, width: 600, height: 400 },
      },
    });

    expect(result.success).toBe(true);
    expect(result.policy_proof).toEqual(formattedPolicyProof);
    expect(result.audit_entry.policy_proof).toEqual(formattedPolicyProof);
    expect(result.audit_entry.rollback_plan).toEqual(createRollbackPlan('reset_window_position', {
      title: 'Calculator',
      original_position: { x: 15, y: 25, width: 600, height: 400 },
    }));
    expect(mockTaskHooks.evaluateAtStage).toHaveBeenCalledWith(
      'task_pre_execute',
      expect.objectContaining({
        command: 'peek_recovery:reset_window_position',
      }),
    );
  });

  it('handlePeekRecoveryStatus lists available actions', async () => {
    mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
      data: {
        allowed_actions: ['restart_process', 'close_dialog'],
        retry_budgets: {
          restart_process: 1,
          close_dialog: 1,
        },
        stop_conditions: {
          restart_process: 'Stop after 2 attempt(s) or 15000 ms.',
          close_dialog: 'Stop after 2 attempt(s) or 3000 ms.',
        },
      },
    });

    const result = await handlePeekRecoveryStatus({});

    expect(result).toEqual({
      success: true,
      mode: 'shadow',
      allowed_actions: ['close_dialog', 'restart_process'],
      retry_budgets: {
        close_dialog: 1,
        restart_process: 1,
      },
      stop_conditions: {
        close_dialog: 'Stop after 2 attempt(s) or 3000 ms.',
        restart_process: 'Stop after 2 attempt(s) or 15000 ms.',
      },
    });
  });

  it('Recovery respects retry budget limits', async () => {
    mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
      data: {
        allowed: true,
        action_spec: {
          name: 'restart_process',
          max_retries: 1,
          timeout_ms: 15000,
        },
      },
    });

    const result = await handlePeekRecovery({
      action: 'restart_process',
      retry_count: 2,
      params: { processName: 'notepad.exe' },
    });

    expect(result.success).toBe(false);
    expect(result.audit_entry.error).toContain("Retry budget exceeded for 'restart_process': 2 > 1.");
    expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledTimes(1);
  });

  it('Errors in recovery do not crash the handler', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: {
            name: 'clear_temp_cache',
            max_retries: 0,
            timeout_ms: 10000,
          },
        },
      })
      .mockRejectedValueOnce(new Error('executor exploded'));

    const result = await handlePeekRecovery({
      action: 'clear_temp_cache',
      params: { directory: 'C:\\temp\\cache' },
    });

    expect(result).toMatchObject({
      success: false,
      action: 'clear_temp_cache',
      mode: 'shadow',
    });
    expect(result.audit_entry.error).toContain('executor exploded');
  });

  // --- Edge cases: missing/invalid arguments ---

  it('rejects missing action with MISSING_REQUIRED_PARAM error', async () => {
    const result = await handlePeekRecovery({});
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('rejects missing action when args is null', async () => {
    const result = await handlePeekRecovery(null);
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('rejects non-object params with INVALID_PARAM error', async () => {
    const result = await handlePeekRecovery({
      action: 'restart_process',
      params: 'not-an-object',
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
  });

  it('rejects array params as invalid', async () => {
    const result = await handlePeekRecovery({
      action: 'restart_process',
      params: [1, 2, 3],
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('INVALID_PARAM');
  });

  // --- Host resolution error ---

  it('returns host error when resolvePeekHost fails', async () => {
    mockShared.resolvePeekHost.mockReturnValue({
      error: { error: 'No peek host configured' },
    });

    const result = await handlePeekRecovery({
      action: 'restart_process',
      params: {},
    });
    expect(result.error).toBeDefined();
  });

  // --- Custom timeout_seconds ---

  it('passes custom timeout to HTTP calls', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: { name: 'click_button', max_retries: 0, timeout_ms: 5000 },
        },
      })
      .mockResolvedValueOnce({
        data: { success: true, attempts: 1 },
      });

    await handlePeekRecovery({
      action: 'click_button',
      params: {},
      timeout_seconds: 30,
    });

    // allowed-action check should use 30000ms timeout
    expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
      expect.stringContaining('/recovery/is-allowed-action'),
      expect.any(Object),
      30000,
    );
    // execute call should also use 30000ms
    expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
      expect.stringContaining('/recovery/execute'),
      expect.any(Object),
      30000,
    );
  });

  it('uses default timeout when timeout_seconds is invalid', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: { name: 'click_button', max_retries: 0, timeout_ms: 5000 },
        },
      })
      .mockResolvedValueOnce({
        data: { success: true, attempts: 1 },
      });

    await handlePeekRecovery({
      action: 'click_button',
      params: {},
      timeout_seconds: -5,
    });

    expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      15000,
    );
  });

  // --- Allowed-action HTTP error ---

  it('handles allowed-action HTTP error response', async () => {
    mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
      error: 'Connection refused',
    });

    const result = await handlePeekRecovery({
      action: 'restart_process',
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.audit_entry.error).toContain('Allowed-action validation failed');
  });

  it('handles allowed-action HTTP exception', async () => {
    mockShared.peekHttpPostWithRetry.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await handlePeekRecovery({
      action: 'restart_process',
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.audit_entry.error).toContain('ECONNREFUSED');
  });

  // --- Policy engine blocking ---

  it('blocks recovery when policy engine rejects in non-shadow mode', async () => {
    mockTaskHooks.evaluateAtStage.mockReturnValue({
      shadow: false,
      blocked: true,
      summary: { passed: 0, failed: 1, blocked: 1 },
      results: [{ policy_id: 'recovery-deny', outcome: 'block' }],
    });
    mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
      data: {
        allowed: true,
        action_spec: { name: 'reformat_disk', max_retries: 0, timeout_ms: 5000 },
      },
    });

    const result = await handlePeekRecovery({
      action: 'reformat_disk',
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.audit_entry.error).toContain('Blocked by policy engine');
    expect(result.policy_proof).toBeDefined();
    // Should NOT call the execute endpoint
    expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledTimes(1);
  });

  it('allows recovery when policy blocks in shadow mode', async () => {
    mockTaskHooks.evaluateAtStage.mockReturnValue({
      shadow: true,
      blocked: true,
      summary: { passed: 0, failed: 1, blocked: 1 },
      results: [{ policy_id: 'recovery-deny', outcome: 'block' }],
    });
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: { name: 'test_action', max_retries: 0, timeout_ms: 5000 },
        },
      })
      .mockResolvedValueOnce({
        data: { success: true, attempts: 1 },
      });

    const result = await handlePeekRecovery({
      action: 'test_action',
      params: {},
    });

    expect(result.success).toBe(true);
    // Execute was called despite policy block (shadow mode)
    expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledTimes(2);
  });

  // --- Execution result with error string ---

  it('detects error string in execution result', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: { name: 'fix_layout', max_retries: 0, timeout_ms: 5000 },
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          attempts: 1,
          error: 'Partial failure: layout not fully restored',
        },
      });

    const result = await handlePeekRecovery({
      action: 'fix_layout',
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.audit_entry.error).toContain('Partial failure');
  });

  // --- Execution result with retry budget exceeded ---

  it('detects execution attempts exceeding retry budget', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: { name: 'retry_action', max_retries: 1, timeout_ms: 5000 },
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          attempts: 5,
        },
      });

    const result = await handlePeekRecovery({
      action: 'retry_action',
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.audit_entry.error).toContain('Retry budget exceeded');
  });

  // --- Execute result with error response ---

  it('handles execute endpoint returning error', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: { name: 'stop_service', max_retries: 0, timeout_ms: 5000 },
        },
      })
      .mockResolvedValueOnce({
        error: 'Service not found',
      });

    const result = await handlePeekRecovery({
      action: 'stop_service',
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.audit_entry.error).toContain('Recovery execution failed');
  });

  // --- Action name variations ---

  it('trims whitespace from action name', async () => {
    const result = await handlePeekRecovery({
      action: '   ',
      params: {},
    });
    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
  });

  it('accepts action_name as alias', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: { allowed: false, reason: 'not allowed' },
      });

    const result = await handlePeekRecovery({
      action_name: 'some_action',
      params: {},
    });

    expect(result.action).toBe('some_action');
  });

  // --- Alternative param key names ---

  it('accepts action_params as alias for params', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: { name: 'click', max_retries: 0, timeout_ms: 5000 },
        },
      })
      .mockResolvedValueOnce({
        data: { success: true, attempts: 1 },
      });

    const result = await handlePeekRecovery({
      action: 'click',
      action_params: { x: 100, y: 200 },
    });

    expect(result.success).toBe(true);
  });

  it('accepts recovery_params as alias for params', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: { name: 'click', max_retries: 0, timeout_ms: 5000 },
        },
      })
      .mockResolvedValueOnce({
        data: { success: true, attempts: 1 },
      });

    const result = await handlePeekRecovery({
      action: 'click',
      recovery_params: { x: 100, y: 200 },
    });

    expect(result.success).toBe(true);
  });

  // --- Task context resolution error ---

  it('continues when task context resolution throws', async () => {
    mockShared.resolvePeekTaskContext.mockImplementation(() => { throw new Error('no context'); });
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: { name: 'fix', max_retries: 0, timeout_ms: 5000 },
        },
      })
      .mockResolvedValueOnce({
        data: { success: true, attempts: 1 },
      });

    const result = await handlePeekRecovery({
      action: 'fix',
      params: {},
    });

    expect(result.success).toBe(true);
    expect(mockTaskHooks.evaluateAtStage).toHaveBeenCalled();
  });

  // --- handlePeekRecoveryStatus edge cases ---

  it('handlePeekRecoveryStatus returns error when host fails', async () => {
    mockShared.resolvePeekHost.mockReturnValue({
      error: { error: 'no host' },
    });

    const result = await handlePeekRecoveryStatus({});
    expect(result.error).toBeDefined();
  });

  it('handlePeekRecoveryStatus handles HTTP error', async () => {
    mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
      error: 'Connection timeout',
    });

    const result = await handlePeekRecoveryStatus({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection timeout');
  });

  it('handlePeekRecoveryStatus handles error in response data', async () => {
    mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
      data: { error: 'Internal server error' },
    });

    const result = await handlePeekRecoveryStatus({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal server error');
  });

  it('handlePeekRecoveryStatus handles exceptions', async () => {
    mockShared.peekHttpGetWithRetry.mockRejectedValueOnce(new Error('network down'));

    const result = await handlePeekRecoveryStatus({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network down');
  });

  it('handlePeekRecoveryStatus normalizes complex action specs', async () => {
    mockShared.peekHttpGetWithRetry.mockResolvedValueOnce({
      data: {
        actions: [
          { name: 'click_button', action_spec: { max_retries: 3, timeout_ms: 10000 } },
          { action: 'scroll_to', max_retries: 1 },
        ],
        action_specs: {
          type_text: { max_retries: 2, timeout_ms: 5000 },
        },
        retry_budgets: { click_button: 5 },
        stop_conditions: { scroll_to: 'Stop after scroll completes' },
      },
    });

    const result = await handlePeekRecoveryStatus({});
    expect(result.success).toBe(true);
    expect(result.allowed_actions).toContain('click_button');
    expect(result.allowed_actions).toContain('scroll_to');
    expect(result.allowed_actions).toContain('type_text');
    // retry_budgets override from top-level
    expect(result.retry_budgets.click_button).toBe(5);
    expect(result.stop_conditions.scroll_to).toBe('Stop after scroll completes');
  });

  // --- Retry count aliases ---

  it('accepts retryCount as retry count alias', async () => {
    mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
      data: {
        allowed: true,
        action_spec: { name: 'act', max_retries: 0, timeout_ms: 5000 },
      },
    });

    const result = await handlePeekRecovery({
      action: 'act',
      retryCount: 2,
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.audit_entry.error).toContain('Retry budget exceeded');
  });

  it('accepts attempt as retry count alias', async () => {
    mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
      data: {
        allowed: true,
        action_spec: { name: 'act', max_retries: 1, timeout_ms: 5000 },
      },
    });

    const result = await handlePeekRecovery({
      action: 'act',
      attempt: 3,
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.audit_entry.error).toContain('Retry budget exceeded');
  });

  // --- Allowed action implicit detection ---

  it('infers allowed=true from actionSpec presence when allowed not explicitly set', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          spec: { name: 'nudge_window', max_retries: 0, timeout_ms: 2000 },
        },
      })
      .mockResolvedValueOnce({
        data: { success: true, attempts: 1 },
      });

    const result = await handlePeekRecovery({
      action: 'nudge_window',
      params: {},
    });

    expect(result.success).toBe(true);
  });

  // --- Duration tracking ---

  it('includes duration_ms in recovery result', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: { name: 'act', max_retries: 0, timeout_ms: 5000 },
        },
      })
      .mockResolvedValueOnce({
        data: { success: true, attempts: 1 },
      });

    const result = await handlePeekRecovery({
      action: 'act',
      params: {},
    });

    expect(result.duration_ms).toBeDefined();
    expect(typeof result.duration_ms).toBe('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('records a recovery metric when finalizing a recovery result', async () => {
    const databaseModule = require('../database');
    const originalRecordRecoveryMetric = databaseModule.recordRecoveryMetric;
    const recordRecoveryMetric = vi.fn();
    databaseModule.recordRecoveryMetric = recordRecoveryMetric;
    databaseModule.getConfig.mockReturnValue('1');

    try {
      mockShared.peekHttpPostWithRetry
        .mockResolvedValueOnce({
          data: {
            allowed: true,
            action_spec: { name: 'close_dialog', max_retries: 0, timeout_ms: 5000 },
          },
        })
        .mockResolvedValueOnce({
          data: { success: true, attempts: 1 },
        });

      const result = await handlePeekRecovery({
        action: 'close_dialog',
        params: { title: 'Hung Dialog' },
      });

      expect(result.success).toBe(true);
      expect(recordRecoveryMetric).toHaveBeenCalledWith(expect.objectContaining({
        action: 'close_dialog',
        mode: 'live',
        success: true,
        risk_level: 'low',
        duration_ms: expect.any(Number),
        attempts: 1,
        error: null,
        host: 'snap-host',
        policy_blocked: false,
        approval_required: false,
        approval_granted: false,
      }));
    } finally {
      databaseModule.recordRecoveryMetric = originalRecordRecoveryMetric;
    }
  });
});
