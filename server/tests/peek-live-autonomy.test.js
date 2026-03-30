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
const { classifyActionRisk } = require('../plugins/snapscope/handlers/rollback');
const { buildLiveEligibilityRecord, isLiveEligible } = require('../plugins/snapscope/handlers/live-autonomy');
const sharedModule = require('../plugins/snapscope/handlers/shared');
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
let resolveRecoveryMode;

function expectNonEmptyJustification(eligibility) {
  expect(typeof eligibility.risk_justification).toBe('string');
  expect(eligibility.risk_justification.trim().length).toBeGreaterThan(0);
}

function getExecuteCalls() {
  return mockShared.peekHttpPostWithRetry.mock.calls.filter(
    ([url]) => typeof url === 'string' && url.includes('/recovery/execute'),
  );
}

describe('peek live autonomy', () => {
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

    delete require.cache[require.resolve('../plugins/snapscope/handlers/recovery')];

    ({
      handlePeekRecovery,
      resolveRecoveryMode,
    } = require('../plugins/snapscope/handlers/recovery'));

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
    configCore.getConfig = originalGetConfig;
  });

  it('marks low-risk live mode actions as live eligible', () => {
    configCore.getConfig.mockReturnValue('1');
    const mode = resolveRecoveryMode('low');
    const eligibility = buildLiveEligibilityRecord(
      'close_dialog',
      classifyActionRisk('close_dialog'),
      mode,
    );

    expect(mode).toBe('live');
    expect(isLiveEligible('low', 'live')).toBe(true);
    expect(eligibility).toMatchObject({
      action: 'close_dialog',
      risk_level: 'low',
      live_eligible: true,
      resolved_mode: 'live',
    });
    expectNonEmptyJustification(eligibility);
  });

  it('marks low-risk actions as shadowed and not live eligible when live mode is disabled', () => {
    const mode = resolveRecoveryMode('low');
    const eligibility = buildLiveEligibilityRecord(
      'clear_temp_cache',
      classifyActionRisk('clear_temp_cache'),
      mode,
    );

    expect(mode).toBe('shadow');
    expect(isLiveEligible('low', 'shadow')).toBe(false);
    expect(eligibility).toMatchObject({
      action: 'clear_temp_cache',
      risk_level: 'low',
      live_eligible: false,
      resolved_mode: 'shadow',
    });
    expectNonEmptyJustification(eligibility);
  });

  it('marks medium-risk actions as canary-gated and not live eligible', () => {
    const mode = resolveRecoveryMode('medium');
    const eligibility = buildLiveEligibilityRecord(
      'restart_process',
      classifyActionRisk('restart_process'),
      mode,
    );

    expect(mode).toBe('canary');
    expect(eligibility).toMatchObject({
      action: 'restart_process',
      risk_level: 'medium',
      live_eligible: false,
      resolved_mode: 'canary',
    });
    expectNonEmptyJustification(eligibility);
  });

  it('marks high-risk actions as shadowed and not live eligible', () => {
    const mode = resolveRecoveryMode('high');
    const eligibility = buildLiveEligibilityRecord(
      'kill_hung_thread',
      classifyActionRisk('kill_hung_thread'),
      mode,
    );

    expect(mode).toBe('shadow');
    expect(eligibility).toMatchObject({
      action: 'kill_hung_thread',
      risk_level: 'high',
      live_eligible: false,
      resolved_mode: 'shadow',
    });
    expectNonEmptyJustification(eligibility);
  });

  it('treats unknown actions as high risk and not live eligible', () => {
    const riskClassification = classifyActionRisk('unknown_action');
    const mode = resolveRecoveryMode('unknown_action');
    const eligibility = buildLiveEligibilityRecord('unknown_action', riskClassification, mode);

    expect(mode).toBe('shadow');
    expect(eligibility).toMatchObject({
      action: 'unknown_action',
      risk_level: 'high',
      live_eligible: false,
      resolved_mode: 'shadow',
    });
    expectNonEmptyJustification(eligibility);
  });

  it('executes low-risk live mode directly without a shadow step', async () => {
    configCore.getConfig.mockReturnValue('1');
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: {
            name: 'close_dialog',
            max_retries: 1,
            timeout_ms: 3000,
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          attempts: 1,
          audit_entry: {
            recovery_id: 'rec-live-1',
          },
        },
      });

    const result = await handlePeekRecovery({
      action: 'close_dialog',
      params: { title: 'Hung Dialog' },
    });

    const executeCalls = getExecuteCalls();

    expect(result).toMatchObject({
      success: true,
      action: 'close_dialog',
      mode: 'live',
      risk_level: 'low',
      live_eligible: true,
      eligibility: {
        action: 'close_dialog',
        risk_level: 'low',
        live_eligible: true,
        resolved_mode: 'live',
      },
      audit_entry: {
        action_name: 'close_dialog',
        mode: 'live',
        risk_level: 'low',
        live_eligible: true,
      },
    });
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0][1]).toMatchObject({
      action: 'close_dialog',
      mode: 'live',
      simulate: false,
      dry_run: false,
      extra_monitoring: false,
      monitoring: {
        level: 'live',
        extra: false,
      },
    });
    expectNonEmptyJustification(result.eligibility);
    expect(result.audit_entry.risk_justification).toBe(result.eligibility.risk_justification);
  });

  it('runs a shadow step before canary execution for medium-risk actions', async () => {
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
          audit_entry: {
            recovery_id: 'rec-canary-1',
            mode: 'canary',
          },
        },
      });

    const result = await handlePeekRecovery({
      action: 'restart_process',
      params: { processName: 'notepad.exe' },
    });

    const executeCalls = getExecuteCalls();

    expect(result).toMatchObject({
      success: true,
      action: 'restart_process',
      mode: 'canary',
      risk_level: 'medium',
      live_eligible: false,
      eligibility: {
        action: 'restart_process',
        risk_level: 'medium',
        live_eligible: false,
        resolved_mode: 'canary',
      },
      audit_entry: {
        action_name: 'restart_process',
        mode: 'canary',
        risk_level: 'medium',
        live_eligible: false,
        shadow_precheck: {
          mode: 'shadow',
          success: true,
          attempts: 0,
          error: null,
        },
      },
    });
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
    expect(executeCalls[1][1]).toMatchObject({
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
    expectNonEmptyJustification(result.eligibility);
    expect(result.audit_entry.risk_justification).toBe(result.eligibility.risk_justification);
  });

  it('keeps high-risk actions in shadow-only mode', async () => {
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
          audit_entry: {
            recovery_id: 'rec-shadow-high-1',
            mode: 'shadow',
          },
        },
      });

    const result = await handlePeekRecovery({
      action: 'kill_hung_thread',
      params: { threadId: 'thread-7' },
    });

    const executeCalls = getExecuteCalls();

    expect(result).toMatchObject({
      success: true,
      action: 'kill_hung_thread',
      mode: 'shadow',
      risk_level: 'high',
      live_eligible: false,
      eligibility: {
        action: 'kill_hung_thread',
        risk_level: 'high',
        live_eligible: false,
        resolved_mode: 'shadow',
      },
      audit_entry: {
        action_name: 'kill_hung_thread',
        mode: 'shadow',
        risk_level: 'high',
        live_eligible: false,
      },
    });
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0][1]).toMatchObject({
      action: 'kill_hung_thread',
      mode: 'shadow',
      simulate: true,
      dry_run: true,
      extra_monitoring: false,
      monitoring: {
        level: 'shadow',
        extra: false,
      },
    });
    expectNonEmptyJustification(result.eligibility);
    expect(result.audit_entry.risk_justification).toBe(result.eligibility.risk_justification);
  });
});
