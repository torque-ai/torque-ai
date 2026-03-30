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

function getExecutePayload() {
  return mockShared.peekHttpPostWithRetry.mock.calls[1]?.[1];
}

describe('peek recovery risk-based mode resolution', () => {
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

  it('returns live for low risk when live mode is enabled', () => {
    configCore.getConfig.mockReturnValue('1');
    expect(resolveRecoveryMode('low')).toBe('live');
    expect(resolveRecoveryMode('close_dialog')).toBe('live');
  });

  it('returns shadow for low risk when live mode is disabled', () => {
    expect(resolveRecoveryMode('low')).toBe('shadow');
    expect(resolveRecoveryMode('close_dialog')).toBe('shadow');
  });

  it('returns canary for medium risk', () => {
    expect(resolveRecoveryMode('medium')).toBe('canary');
  });

  it('returns shadow for high risk', () => {
    expect(resolveRecoveryMode('high')).toBe('shadow');
  });

  it('returns shadow for unknown actions and missing risk', () => {
    expect(resolveRecoveryMode('unknown_action')).toBe('shadow');
    expect(resolveRecoveryMode()).toBe('shadow');
  });

  it('uses action risk classification to force high-risk recovery into shadow mode', async () => {
    mockShared.peekHttpPostWithRetry
      .mockResolvedValueOnce({
        data: {
          allowed: true,
          action_spec: {
            name: 'kill_hung_thread',
            max_retries: 0,
            timeout_ms: 5000,
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
      params: { thread_id: 7 },
    });

    expect(result).toMatchObject({
      success: true,
      action: 'kill_hung_thread',
      mode: 'shadow',
      risk_level: 'high',
      audit_entry: {
        action_name: 'kill_hung_thread',
        mode: 'shadow',
        risk_level: 'high',
        success: true,
      },
    });
    expect(getExecutePayload()).toMatchObject({
      action: 'kill_hung_thread',
      mode: 'shadow',
      simulate: true,
      dry_run: true,
      extra_monitoring: false,
    });
  });
});
