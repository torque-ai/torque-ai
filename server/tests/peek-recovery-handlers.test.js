import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

const { installMock } = require('./cjs-mock');
const realShared = require('../handlers/shared');
const realRollback = require('../handlers/peek/rollback');
const realLiveAutonomy = require('../handlers/peek/live-autonomy');

const { ErrorCodes, makeError } = realShared;
const RECOVERY_MODULE_PATH = require.resolve('../handlers/peek/recovery');

let currentModules = {};

vi.mock('../database', () => currentModules.db);
vi.mock('../db/config-core', () => currentModules.db);
vi.mock('../db/peek-recovery-approvals', () => currentModules.db);
vi.mock('../db/recovery-metrics', () => currentModules.db);
vi.mock('../handlers/peek/shared', () => currentModules.peekShared);
vi.mock('../handlers/peek/rollback', () => currentModules.rollback);
vi.mock('../handlers/peek/live-autonomy', () => currentModules.liveAutonomy);
vi.mock('../policy-engine/task-hooks', () => currentModules.taskHooks);
vi.mock('../handlers/peek/webhook-outbound', () => currentModules.webhookOutbound);
vi.mock('../logger', () => currentModules.loggerModule);

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function expectError(result, errorCode, textFragment) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(errorCode);
  if (textFragment) {
    expect(getText(result)).toContain(textFragment);
  }
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createAllowedActionResponse(action = 'close_dialog', overrides = {}) {
  const actionSpecOverride = overrides.action_spec || {};

  return {
    data: {
      allowed: true,
      action_spec: {
        name: action,
        max_retries: 1,
        timeout_ms: 5000,
        ...actionSpecOverride,
      },
      ...overrides,
    },
  };
}

function createExecuteResponse(overrides = {}) {
  return {
    data: {
      success: true,
      attempts: 1,
      ...overrides,
      audit_entry: {
        executor: 'peek',
        ...(overrides.audit_entry || {}),
      },
    },
  };
}

function queueAllowed(postSpy, action = 'close_dialog', overrides = {}) {
  postSpy.mockResolvedValueOnce(createAllowedActionResponse(action, overrides));
}

function queueExecute(postSpy, overrides = {}) {
  postSpy.mockResolvedValueOnce(createExecuteResponse(overrides));
}

function getPostCalls(spy, endpoint) {
  return spy.mock.calls.filter(([url]) => String(url).endsWith(endpoint));
}

function createApproval(status, overrides = {}) {
  return {
    id: 71,
    status,
    requested_by: 'ops@example.com',
    approved_by: status === 'approved' ? 'lead@example.com' : null,
    requested_at: '2026-03-12T10:00:00.000Z',
    resolved_at: status === 'approved' ? '2026-03-12T10:05:00.000Z' : null,
    ...overrides,
  };
}

function createModules() {
  const loggerInstance = createLogger();

  return {
    db: {
      getConfig() {
        return null;
      },
      recordRecoveryMetric() {},
      getApprovalForAction() {
        return null;
      },
      requestApproval(action, taskId, requestedBy) {
        return createApproval('pending', {
          id: 91,
          action,
          task_id: taskId,
          requested_by: requestedBy,
        });
      },
    },
    peekShared: {
      async peekHttpGetWithRetry() {
        return { data: {} };
      },
      async peekHttpPostWithRetry(url, payload) {
        if (String(url).endsWith('/recovery/is-allowed-action')) {
          return createAllowedActionResponse(payload?.action || 'close_dialog');
        }
        if (String(url).endsWith('/recovery/execute')) {
          return createExecuteResponse();
        }
        return { data: {} };
      },
      resolvePeekHost() {
        return {
          hostName: 'peek-host',
          hostUrl: 'http://peek-host:9876',
        };
      },
      resolvePeekTaskContext() {
        return {
          task: null,
          taskId: null,
          workflowId: null,
          taskLabel: null,
        };
      },
    },
    rollback: {
      ...realRollback,
    },
    liveAutonomy: {
      ...realLiveAutonomy,
    },
    taskHooks: {
      evaluateAtStage() {
        return {
          shadow: false,
          blocked: false,
          total_results: 1,
          created_at: '2026-03-12T10:00:00.000Z',
          summary: {
            passed: 1,
            warned: 0,
            failed: 0,
            blocked: 0,
          },
          results: [{
            policy_id: 'peek-recovery-policy',
            outcome: 'pass',
            mode: 'advisory',
            evidence: {
              bounded: true,
            },
          }],
        };
      },
    },
    webhookOutbound: {
      fireWebhookForEvent: vi.fn(async () => undefined),
    },
    loggerModule: {
      child: vi.fn(() => loggerInstance),
    },
    loggerInstance,
  };
}

function loadHandlers() {
  vi.resetModules();

  vi.doMock('../database', () => currentModules.db);
  vi.doMock('../db/config-core', () => currentModules.db);
  vi.doMock('../db/peek-recovery-approvals', () => currentModules.db);
  vi.doMock('../db/recovery-metrics', () => currentModules.db);
  vi.doMock('../handlers/peek/shared', () => currentModules.peekShared);
  vi.doMock('../handlers/peek/rollback', () => currentModules.rollback);
  vi.doMock('../handlers/peek/live-autonomy', () => currentModules.liveAutonomy);
  vi.doMock('../policy-engine/task-hooks', () => currentModules.taskHooks);
  vi.doMock('../handlers/peek/webhook-outbound', () => currentModules.webhookOutbound);
  vi.doMock('../logger', () => currentModules.loggerModule);

  installMock('../database', currentModules.db);
  installMock('../db/config-core', currentModules.db);
  installMock('../db/peek-recovery-approvals', currentModules.db);
  installMock('../db/recovery-metrics', currentModules.db);
  installMock('../handlers/peek/shared', currentModules.peekShared);
  installMock('../handlers/peek/rollback', currentModules.rollback);
  installMock('../handlers/peek/live-autonomy', currentModules.liveAutonomy);
  installMock('../policy-engine/task-hooks', currentModules.taskHooks);
  installMock('../handlers/peek/webhook-outbound', currentModules.webhookOutbound);
  installMock('../logger', currentModules.loggerModule);

  delete require.cache[RECOVERY_MODULE_PATH];
  return require('../handlers/peek/recovery');
}

describe('peek/recovery exported handlers', () => {
  let handlers;
  let mocks;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    currentModules = createModules();
    mocks = currentModules;
    handlers = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    currentModules = {};
    delete require.cache[RECOVERY_MODULE_PATH];
  });

  describe('resolveRecoveryMode', () => {
    it('returns live for low risk when the config flag is numeric 1', () => {
      vi.spyOn(mocks.db, 'getConfig').mockReturnValue(1);

      handlers = loadHandlers();

      expect(handlers.resolveRecoveryMode('low')).toBe('live');
    });

    it('returns live for low-risk actions when the config flag is a truthy string', () => {
      vi.spyOn(mocks.db, 'getConfig').mockReturnValue('yes');

      handlers = loadHandlers();

      expect(handlers.resolveRecoveryMode('close_dialog')).toBe('live');
    });

    it('returns live for trimmed low risk values when the config flag is boolean true', () => {
      vi.spyOn(mocks.db, 'getConfig').mockReturnValue(true);

      handlers = loadHandlers();

      expect(handlers.resolveRecoveryMode(' low ')).toBe('live');
    });

    it('returns shadow for low risk when live mode is disabled', () => {
      vi.spyOn(mocks.db, 'getConfig').mockReturnValue('off');

      handlers = loadHandlers();

      expect(handlers.resolveRecoveryMode('low')).toBe('shadow');
    });

    it('returns shadow for low risk when config lookup returns null', () => {
      vi.spyOn(mocks.db, 'getConfig').mockReturnValue(null);

      handlers = loadHandlers();

      expect(handlers.resolveRecoveryMode('close_dialog')).toBe('shadow');
    });

    it('returns shadow for low risk when config lookup throws', () => {
      vi.spyOn(mocks.db, 'getConfig').mockImplementation(() => {
        throw new Error('db offline');
      });

      handlers = loadHandlers();

      expect(handlers.resolveRecoveryMode('low')).toBe('shadow');
    });

    it('returns canary for medium risk values', () => {
      handlers = loadHandlers();

      expect(handlers.resolveRecoveryMode('medium')).toBe('canary');
    });

    it('returns canary for medium-risk actions', () => {
      handlers = loadHandlers();

      expect(handlers.resolveRecoveryMode('restart_process')).toBe('canary');
    });

    it('returns shadow for high risk values', () => {
      handlers = loadHandlers();

      expect(handlers.resolveRecoveryMode('high')).toBe('shadow');
    });

    it('keeps high-risk actions in shadow mode even when live mode is enabled', () => {
      vi.spyOn(mocks.db, 'getConfig').mockReturnValue('1');

      handlers = loadHandlers();

      expect(handlers.resolveRecoveryMode('force_kill_process')).toBe('shadow');
    });

    it('returns shadow for unknown actions and missing input', () => {
      handlers = loadHandlers();

      expect(handlers.resolveRecoveryMode('unknown_action')).toBe('shadow');
      expect(handlers.resolveRecoveryMode()).toBe('shadow');
    });
  });

  describe('handlePeekRecoveryStatus', () => {
    it('returns host resolution errors directly', async () => {
      const hostError = makeError(ErrorCodes.HOST_NOT_FOUND, 'peek host missing');
      vi.spyOn(mocks.peekShared, 'resolvePeekHost').mockReturnValue({ error: hostError });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecoveryStatus({ host: 'missing' });

      expect(result).toBe(hostError);
    });

    it('calls the status endpoint with the resolved timeout', async () => {
      const getSpy = vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry').mockResolvedValue({
        data: {
          allowed_actions: ['close_dialog'],
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecoveryStatus({ timeout_seconds: 7 });

      expect(result.success).toBe(true);
      expect(getSpy).toHaveBeenCalledWith('http://peek-host:9876/recovery/status', 7000);
    });

    it('returns an operation failed error when the status request returns an error field', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry').mockResolvedValue({
        error: 'backend unavailable',
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecoveryStatus({});

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'Recovery status failed: backend unavailable');
    });

    it('returns an operation failed error when the payload includes a backend error', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry').mockResolvedValue({
        data: {
          error: ' status service failed ',
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecoveryStatus({});

      expectError(result, ErrorCodes.OPERATION_FAILED.code, 'Recovery status failed: status service failed');
    });

    it('returns an internal error when status lookup throws', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry').mockRejectedValue(new Error('socket closed'));

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecoveryStatus({});

      expectError(result, ErrorCodes.INTERNAL_ERROR.code, 'socket closed');
    });

    it('normalizes string allowed actions into sorted capabilities', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry').mockResolvedValue({
        data: {
          allowed_actions: ['restart_process', 'close_dialog'],
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecoveryStatus({});

      expect(result).toEqual({
        success: true,
        mode: 'shadow',
        allowed_actions: ['close_dialog', 'restart_process'],
        retry_budgets: {
          close_dialog: 0,
          restart_process: 0,
        },
        stop_conditions: {
          close_dialog: 'Stop after 1 attempt(s).',
          restart_process: 'Stop after 1 attempt(s).',
        },
      });
    });

    it('honors retry budget and stop condition overrides for allowed_actions objects', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry').mockResolvedValue({
        data: {
          allowed_actions: [{
            action: 'close_dialog',
            action_spec: {
              max_retries: 3,
              timeout_ms: 600,
              stop_condition: 'original stop condition',
            },
          }],
          retry_budgets: {
            close_dialog: 5,
          },
          stop_conditions: {
            close_dialog: 'Stop when dialog is dismissed.',
          },
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecoveryStatus({});

      expect(result.retry_budgets).toEqual({
        close_dialog: 5,
      });
      expect(result.stop_conditions).toEqual({
        close_dialog: 'Stop when dialog is dismissed.',
      });
    });

    it('merges actions arrays and action_specs with later records taking precedence', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry').mockResolvedValue({
        data: {
          allowed_actions: ['close_dialog'],
          actions: [{
            action: 'restart_process',
            spec: {
              max_retries: 1,
              timeout_ms: 400,
            },
          }],
          action_specs: {
            restart_process: {
              max_retries: 2,
              timeout_ms: 1200,
            },
            kill_hung_thread: {
              max_retries: 0,
            },
          },
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecoveryStatus({});

      expect(result.allowed_actions).toEqual([
        'close_dialog',
        'kill_hung_thread',
        'restart_process',
      ]);
      expect(result.retry_budgets).toEqual({
        close_dialog: 0,
        kill_hung_thread: 0,
        restart_process: 2,
      });
      expect(result.stop_conditions).toEqual({
        close_dialog: 'Stop after 1 attempt(s).',
        kill_hung_thread: 'Stop after 1 attempt(s).',
        restart_process: 'Stop after 3 attempt(s) or 1200 ms.',
      });
    });

    it('accepts spec aliases on allowed action objects', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry').mockResolvedValue({
        data: {
          allowed_actions: [{
            action_name: 'focus_window',
            spec: {
              max_retries: 4,
              timeout_ms: 750,
            },
          }],
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecoveryStatus({});

      expect(result.allowed_actions).toEqual(['focus_window']);
      expect(result.retry_budgets).toEqual({
        focus_window: 4,
      });
      expect(result.stop_conditions).toEqual({
        focus_window: 'Stop after 5 attempt(s) or 750 ms.',
      });
    });

    it('ignores invalid capability entries and returns empty maps for unusable payloads', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry').mockResolvedValue({
        data: {
          allowed_actions: [null, '', { no_action: true }],
          actions: ['restart_process'],
          action_specs: 'invalid',
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecoveryStatus({});

      expect(result).toEqual({
        success: true,
        mode: 'shadow',
        allowed_actions: [],
        retry_budgets: {},
        stop_conditions: {},
      });
    });

    it('keeps status mode in shadow even when live mode is enabled globally', async () => {
      vi.spyOn(mocks.db, 'getConfig').mockReturnValue('1');
      vi.spyOn(mocks.peekShared, 'peekHttpGetWithRetry').mockResolvedValue({
        data: {
          allowed_actions: ['close_dialog'],
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecoveryStatus({});

      expect(result.mode).toBe('shadow');
    });
  });

  describe('handlePeekRecovery', () => {
    it('returns a missing parameter error when action is not provided', async () => {
      const metricSpy = vi.spyOn(mocks.db, 'recordRecoveryMetric');

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({});

      expectError(result, ErrorCodes.MISSING_REQUIRED_PARAM.code, 'action is required');
      expect(metricSpy).not.toHaveBeenCalled();
      expect(mocks.webhookOutbound.fireWebhookForEvent).not.toHaveBeenCalled();
    });

    it('accepts action_name and recovery_params aliases', async () => {
      vi.spyOn(mocks.db, 'getConfig').mockReturnValue('1');
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy, {
        audit_entry: {
          phase: 'live',
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action_name: ' close_dialog ',
        recovery_params: {
          title: 'Update available',
        },
      });

      expect(result).toMatchObject({
        success: true,
        action: 'close_dialog',
        mode: 'live',
      });
      expect(getPostCalls(postSpy, '/recovery/execute')[0][1]).toMatchObject({
        action: 'close_dialog',
        params: {
          title: 'Update available',
        },
        mode: 'live',
        simulate: false,
        dry_run: false,
        extra_monitoring: false,
        monitoring: {
          level: 'live',
          extra: false,
        },
      });
    });

    it('prefers params over action_params and recovery_params', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy);

      handlers = loadHandlers();
      await handlers.handlePeekRecovery({
        action: 'close_dialog',
        params: { source: 'params' },
        action_params: { source: 'action_params' },
        recovery_params: { source: 'recovery_params' },
      });

      expect(getPostCalls(postSpy, '/recovery/execute')[0][1].params).toEqual({
        source: 'params',
      });
    });

    it('accepts action_params when params is missing', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy);

      handlers = loadHandlers();
      await handlers.handlePeekRecovery({
        action: 'close_dialog',
        action_params: { source: 'action_params' },
      });

      expect(getPostCalls(postSpy, '/recovery/execute')[0][1].params).toEqual({
        source: 'action_params',
      });
    });

    it('rejects non-plain params payloads', async () => {
      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
        params: ['not', 'plain'],
      });

      expectError(result, ErrorCodes.INVALID_PARAM.code, 'params must be a plain object');
    });

    it('returns host resolution errors directly', async () => {
      const hostError = makeError(ErrorCodes.HOST_NOT_FOUND, 'peek host missing');
      vi.spyOn(mocks.peekShared, 'resolvePeekHost').mockReturnValue({ error: hostError });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result).toBe(hostError);
      expect(mocks.webhookOutbound.fireWebhookForEvent).not.toHaveBeenCalled();
    });

    it('calls allowed-action validation with the resolved timeout and normalized action', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy);

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: ' close_dialog ',
        timeout_seconds: 8,
      });

      expect(result.success).toBe(true);
      expect(getPostCalls(postSpy, '/recovery/is-allowed-action')[0]).toEqual([
        'http://peek-host:9876/recovery/is-allowed-action',
        { action: 'close_dialog' },
        8000,
      ]);
    });

    it('returns a structured failure when allowed-action validation throws', async () => {
      const metricSpy = vi.spyOn(mocks.db, 'recordRecoveryMetric');
      vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockRejectedValue(new Error('socket closed'));

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result).toMatchObject({
        success: false,
        action: 'close_dialog',
        mode: 'shadow',
        audit_entry: {
          error: 'Allowed-action validation failed: socket closed',
        },
      });
      expect(metricSpy).toHaveBeenCalledWith(expect.objectContaining({
        action: 'close_dialog',
        mode: 'shadow',
        success: false,
        host: 'peek-host',
      }));
      expect(mocks.webhookOutbound.fireWebhookForEvent).toHaveBeenCalledWith(
        'peek.recovery.executed',
        {
          action: 'close_dialog',
          mode: 'shadow',
          success: false,
        },
      );
    });

    it('returns a structured failure when allowed-action validation returns an error field', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValue({
        error: 'backend rejected request',
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.audit_entry.error).toBe('Allowed-action validation failed: backend rejected request');
      expect(result.success).toBe(false);
    });

    it('returns the payload reason when the action is not allowed', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValue({
        data: {
          allowed: false,
          reason: 'Window is already closed.',
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result).toMatchObject({
        success: false,
        audit_entry: {
          error: 'Window is already closed.',
        },
      });
    });

    it('uses the payload error field as the disallow reason', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValue({
        data: {
          allowed: false,
          error: 'Host vetoed action.',
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.audit_entry.error).toBe('Host vetoed action.');
    });

    it('falls back to a default not-allowed error when the payload is unusable', async () => {
      vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry').mockResolvedValue({
        data: 'invalid payload',
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.audit_entry.error).toBe("Recovery action 'close_dialog' is not allowed.");
    });

    it('treats a spec-only allowed payload as implicitly allowed', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      postSpy
        .mockResolvedValueOnce({
          data: {
            spec: {
              max_retries: 2,
              timeout_ms: 900,
            },
          },
        })
        .mockResolvedValueOnce(createExecuteResponse());

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.success).toBe(true);
      expect(getPostCalls(postSpy, '/recovery/execute')).toHaveLength(1);
    });

    it('rejects requests that already exceed the retry budget via retry_count', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      const rollbackSpy = vi.spyOn(mocks.rollback, 'createRollbackPlan').mockReturnValue({
        action: 'close_dialog',
        rollback_steps: [{ step: 'noop' }],
        can_rollback: false,
        estimated_impact: 'low',
      });
      queueAllowed(postSpy, 'close_dialog', {
        action_spec: {
          max_retries: 1,
          timeout_ms: 500,
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
        retry_count: 2,
      });

      expect(result).toMatchObject({
        success: false,
        audit_entry: {
          error: "Retry budget exceeded for 'close_dialog': 2 > 1.",
          rollback_plan: rollbackSpy.mock.results[0].value,
        },
      });
      expect(getPostCalls(postSpy, '/recovery/execute')).toHaveLength(0);
    });

    it('rejects requests that already exceed the retry budget via attempts alias', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog', {
        action_spec: {
          max_retries: 0,
          timeout_ms: 500,
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
        attempts: 1,
      });

      expect(result.audit_entry.error).toBe("Retry budget exceeded for 'close_dialog': 1 > 0.");
      expect(getPostCalls(postSpy, '/recovery/execute')).toHaveLength(0);
    });

    it('continues when task context resolution fails', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      vi.spyOn(mocks.peekShared, 'resolvePeekTaskContext').mockImplementation(() => {
        throw new Error('task metadata unavailable');
      });
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy);

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.success).toBe(true);
      expect(mocks.loggerInstance.warn).toHaveBeenCalledWith(
        'Recovery task context resolution failed for close_dialog: task metadata unavailable',
      );
    });

    it('passes normalized policy task data to the policy engine', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      const contextSpy = vi.spyOn(mocks.peekShared, 'resolvePeekTaskContext').mockReturnValue({
        task: {
          project: 'desk-ops',
          project_id: 'proj-7',
          working_directory: 'C:\\workspace\\desk',
        },
        taskId: 'task-7',
        workflowId: 'wf-9',
        taskLabel: 'peek recovery',
      });
      const evaluateSpy = vi.spyOn(mocks.taskHooks, 'evaluateAtStage');
      queueAllowed(postSpy, 'close_dialog', {
        action_spec: {
          max_retries: 2,
          timeout_ms: 2500,
        },
      });
      queueExecute(postSpy);

      handlers = loadHandlers();
      await handlers.handlePeekRecovery({
        action: 'close_dialog',
        params: {
          zeta: true,
          alpha: true,
        },
      });

      expect(contextSpy).toHaveBeenCalled();
      expect(evaluateSpy).toHaveBeenCalledWith(
        'task_pre_execute',
        {
          id: 'task-7',
          taskId: 'task-7',
          project: 'desk-ops',
          project_id: 'proj-7',
          working_directory: 'C:\\workspace\\desk',
          provider: 'peek',
          command: 'peek_recovery:close_dialog',
          evidence: {
            peek_recovery: true,
            host: 'peek-host',
            action: 'close_dialog',
            mode: 'shadow',
            bounded: true,
            retry_budget: 2,
            stop_condition: 'Stop after 3 attempt(s) or 2500 ms.',
            params_present: ['alpha', 'zeta'],
          },
        },
      );
    });

    it('stops execution when the policy engine blocks the action', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      vi.spyOn(mocks.taskHooks, 'evaluateAtStage').mockReturnValue({
        blocked: true,
        shadow: false,
        total_results: 1,
        summary: {
          passed: 0,
          warned: 0,
          failed: 1,
          blocked: 1,
        },
        results: [{
          policy_id: 'block-recovery',
          outcome: 'fail',
          mode: 'block',
          evidence: {
            action: 'close_dialog',
          },
        }],
      });
      queueAllowed(postSpy, 'close_dialog');

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result).toMatchObject({
        success: false,
        policy_proof: {
          mode: 'block',
          blocked: 1,
        },
        audit_entry: {
          error: 'Blocked by policy engine.',
        },
      });
      expect(getPostCalls(postSpy, '/recovery/execute')).toHaveLength(0);
    });

    it('allows execution to continue when the policy engine is shadow-only', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      vi.spyOn(mocks.taskHooks, 'evaluateAtStage').mockReturnValue({
        blocked: true,
        shadow: true,
        total_results: 1,
        summary: {
          passed: 0,
          warned: 0,
          failed: 1,
          blocked: 1,
        },
        results: [{
          policy_id: 'shadow-recovery',
          outcome: 'fail',
          mode: 'block',
        }],
      });
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy);

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.success).toBe(true);
      expect(result.policy_proof).toMatchObject({
        mode: 'shadow',
        blocked: 1,
      });
      expect(getPostCalls(postSpy, '/recovery/execute')).toHaveLength(1);
    });

    it('continues high-risk execution when an approval is already granted', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      vi.spyOn(mocks.db, 'getApprovalForAction').mockReturnValue(createApproval('approved', {
        id: '44',
      }));
      const metricSpy = vi.spyOn(mocks.db, 'recordRecoveryMetric');
      queueAllowed(postSpy, 'force_kill_process', {
        action_spec: {
          max_retries: 0,
        },
      });
      queueExecute(postSpy, {
        attempts: 0,
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'force_kill_process',
        params: {
          process_name: 'app.exe',
          pid: 111,
          kill_reason: 'hung',
        },
      });

      expect(result).toMatchObject({
        success: true,
        action: 'force_kill_process',
        mode: 'shadow',
        risk_level: 'high',
        audit_entry: {
          approval: {
            approved: true,
            approval_id: 44,
            approved_by: 'lead@example.com',
          },
        },
      });
      expect(metricSpy).toHaveBeenCalledWith(expect.objectContaining({
        approval_required: true,
        approval_granted: true,
      }));
    });

    it('blocks high-risk execution when the latest approval is still pending', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      vi.spyOn(mocks.db, 'getApprovalForAction').mockReturnValue(createApproval('pending', {
        id: '45',
      }));
      queueAllowed(postSpy, 'force_kill_process');

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'force_kill_process',
      });

      expect(result).toMatchObject({
        success: false,
        blocked: true,
        approval_required: true,
        approval_id: 45,
        audit_entry: {
          error: 'High-risk action requires approval',
          approval: {
            approved: false,
            status: 'pending',
          },
        },
      });
      expect(getPostCalls(postSpy, '/recovery/execute')).toHaveLength(0);
    });

    it('requests approval when none exists and uses requested_by from args', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      const requestSpy = vi.spyOn(mocks.db, 'requestApproval').mockReturnValue(createApproval('pending', {
        id: '46',
        requested_by: 'alice@example.com',
      }));
      queueAllowed(postSpy, 'force_kill_process');

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'force_kill_process',
        requested_by: 'alice@example.com',
      });

      expect(requestSpy).toHaveBeenCalledWith('force_kill_process', null, 'alice@example.com');
      expect(result).toMatchObject({
        success: false,
        blocked: true,
        approval_required: true,
        approval_id: 46,
        audit_entry: {
          approval: {
            requested_by: 'alice@example.com',
          },
        },
      });
    });

    it('falls back to the task context requester when requesting approval', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      vi.spyOn(mocks.peekShared, 'resolvePeekTaskContext').mockReturnValue({
        task: {
          created_by: 'task-owner@example.com',
        },
        taskId: 'task-22',
        workflowId: 'wf-22',
        taskLabel: 'high-risk recovery',
      });
      const requestSpy = vi.spyOn(mocks.db, 'requestApproval').mockReturnValue(createApproval('pending', {
        requested_by: 'task-owner@example.com',
      }));
      queueAllowed(postSpy, 'force_kill_process');

      handlers = loadHandlers();
      await handlers.handlePeekRecovery({
        action: 'force_kill_process',
      });

      expect(requestSpy).toHaveBeenCalledWith('force_kill_process', 'task-22', 'task-owner@example.com');
    });

    it('falls back to a default blocked approval record when approval storage methods are unavailable', async () => {
      delete mocks.db.getApprovalForAction;
      delete mocks.db.requestApproval;
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'force_kill_process');

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'force_kill_process',
      });

      expect(result).toMatchObject({
        success: false,
        blocked: true,
        approval_required: true,
        audit_entry: {
          approval: {
            approval_required: true,
            approved: false,
            reason: 'High-risk action requires approval',
          },
        },
      });
    });

    it('logs approval lookup failures and returns the default blocked approval record', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      vi.spyOn(mocks.db, 'getApprovalForAction').mockImplementation(() => {
        throw new Error('approval db unavailable');
      });
      queueAllowed(postSpy, 'force_kill_process');

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'force_kill_process',
      });

      expect(result.success).toBe(false);
      expect(result.audit_entry.approval.approved).toBe(false);
      expect(mocks.loggerInstance.warn).toHaveBeenCalledWith(
        'Approval lookup failed for force_kill_process: approval db unavailable',
      );
    });

    it('executes low-risk recovery in live mode when live execution is enabled', async () => {
      vi.spyOn(mocks.db, 'getConfig').mockReturnValue('1');
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy, {
        attempts: 1,
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result).toMatchObject({
        success: true,
        mode: 'live',
        live_eligible: true,
        eligibility: {
          live_eligible: true,
          resolved_mode: 'live',
        },
      });
      expect(getPostCalls(postSpy, '/recovery/execute')[0][1]).toMatchObject({
        mode: 'live',
        simulate: false,
        dry_run: false,
        extra_monitoring: false,
      });
    });

    it('runs medium-risk recovery in canary mode with a shadow precheck first', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'restart_process');
      queueExecute(postSpy, {
        attempts: 0,
        audit_entry: {
          phase: 'shadow',
        },
      });
      queueExecute(postSpy, {
        attempts: 1,
        audit_entry: {
          phase: 'canary',
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'restart_process',
      });

      const executeCalls = getPostCalls(postSpy, '/recovery/execute');
      expect(result).toMatchObject({
        success: true,
        mode: 'canary',
        audit_entry: {
          phase: 'canary',
          shadow_precheck: {
            mode: 'shadow',
            success: true,
            attempts: 0,
          },
        },
      });
      expect(executeCalls).toHaveLength(2);
      expect(executeCalls[0][1]).toMatchObject({
        mode: 'shadow',
        simulate: true,
        dry_run: true,
        extra_monitoring: false,
      });
      expect(executeCalls[1][1]).toMatchObject({
        mode: 'canary',
        simulate: false,
        dry_run: false,
        extra_monitoring: true,
      });
    });

    it('stops canary execution when the shadow precheck reports a failure', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'restart_process');
      queueExecute(postSpy, {
        success: false,
        attempts: 0,
        error: 'Shadow run detected a crash.',
        audit_entry: {
          phase: 'shadow',
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'restart_process',
      });

      expect(result).toMatchObject({
        success: false,
        mode: 'canary',
        audit_entry: {
          error: 'Shadow run detected a crash.',
          mode: 'canary',
          shadow_precheck: {
            mode: 'shadow',
            success: false,
            error: 'Shadow run detected a crash.',
          },
        },
      });
      expect(getPostCalls(postSpy, '/recovery/execute')).toHaveLength(1);
    });

    it('returns shadow precheck transport failures without running the canary step', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'restart_process');
      postSpy.mockRejectedValueOnce(new Error('shadow transport failed'));

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'restart_process',
      });

      expect(result).toMatchObject({
        success: false,
        mode: 'canary',
        audit_entry: {
          attempts: 0,
          error: 'shadow transport failed',
          shadow_precheck: {
            success: false,
            attempts: 0,
            error: 'shadow transport failed',
          },
        },
      });
      expect(getPostCalls(postSpy, '/recovery/execute')).toHaveLength(1);
    });

    it('executes high-risk recovery in shadow mode without extra monitoring', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'kill_hung_thread');
      queueExecute(postSpy, {
        attempts: 0,
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'kill_hung_thread',
        params: {
          thread_id: 7,
        },
      });

      expect(result).toMatchObject({
        success: true,
        mode: 'shadow',
        risk_level: 'high',
      });
      expect(getPostCalls(postSpy, '/recovery/execute')[0][1]).toMatchObject({
        mode: 'shadow',
        simulate: true,
        dry_run: true,
        extra_monitoring: false,
      });
    });

    it('uses zero attempts when shadow execution throws', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'kill_hung_thread');
      postSpy.mockRejectedValueOnce(new Error('transport unavailable'));

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'kill_hung_thread',
      });

      expect(result).toMatchObject({
        success: false,
        audit_entry: {
          attempts: 0,
          error: 'transport unavailable',
        },
      });
    });

    it('uses one attempt when live execution throws', async () => {
      vi.spyOn(mocks.db, 'getConfig').mockReturnValue('1');
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog');
      postSpy.mockRejectedValueOnce(new Error('live transport failed'));

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result).toMatchObject({
        success: false,
        mode: 'live',
        audit_entry: {
          attempts: 1,
          error: 'live transport failed',
        },
      });
    });

    it('prefixes execution transport errors returned by the backend wrapper', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog');
      postSpy.mockResolvedValueOnce({
        error: 'rpc failed',
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.audit_entry.error).toBe('Recovery execution failed: rpc failed');
    });

    it('uses the trimmed backend error string from execution data', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy, {
        success: true,
        error: ' backend unhappy ',
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result).toMatchObject({
        success: false,
        audit_entry: {
          error: 'backend unhappy',
        },
      });
    });

    it('fails execution when the retry budget is exceeded mid-flight', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog', {
        action_spec: {
          max_retries: 1,
        },
      });
      queueExecute(postSpy, {
        attempts: 4,
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result).toMatchObject({
        success: false,
        audit_entry: {
          attempts: 4,
          error: "Retry budget exceeded for 'close_dialog': 3 > 1.",
        },
      });
    });

    it('returns a failed result with null error when execution reports false without details', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy, {
        success: false,
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.success).toBe(false);
      expect(result.audit_entry.error).toBeNull();
    });

    it('falls back to the mode default attempt count when execution data is not an object', async () => {
      vi.spyOn(mocks.db, 'getConfig').mockReturnValue('1');
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog');
      postSpy.mockResolvedValueOnce({
        data: null,
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result).toMatchObject({
        success: false,
        mode: 'live',
        audit_entry: {
          attempts: 1,
          error: null,
        },
      });
    });

    it('preserves backend audit fields when they are already valid', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'close_dialog', {
        action_spec: {
          max_retries: 10,
        },
      });
      queueExecute(postSpy, {
        attempts: 2,
        audit_entry: {
          action_name: 'backend-action',
          mode: 'backend-mode',
          duration_ms: 12,
          attempts: 4,
          completed_at: '2026-03-12T11:11:11.000Z',
          error: 'backend error',
          custom: true,
        },
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.audit_entry).toMatchObject({
        action_name: 'backend-action',
        mode: 'backend-mode',
        duration_ms: 12,
        attempts: 4,
        completed_at: '2026-03-12T11:11:11.000Z',
        error: 'backend error',
        custom: true,
      });
      expect(result.audit_entry.rollback_plan).toBeTruthy();
    });

    it('normalizes eligibility data returned by live autonomy helpers', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      vi.spyOn(mocks.liveAutonomy, 'buildLiveEligibilityRecord').mockReturnValue({
        action: 'custom-action',
        risk_level: 'low',
        live_eligible: false,
        resolved_mode: 'warn',
        risk_justification: 'custom reason',
      });
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy);

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.eligibility).toEqual({
        action: 'custom-action',
        risk_level: 'low',
        live_eligible: false,
        resolved_mode: 'warn',
        risk_justification: 'custom reason',
      });
      expect(result.audit_entry).toMatchObject({
        live_eligible: false,
        risk_justification: 'custom reason',
      });
    });

    it('records recovery metrics and fires a webhook on success', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      const metricSpy = vi.spyOn(mocks.db, 'recordRecoveryMetric');
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy);

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.success).toBe(true);
      expect(metricSpy).toHaveBeenCalledWith(expect.objectContaining({
        action: 'close_dialog',
        mode: 'shadow',
        success: true,
        risk_level: 'low',
        host: 'peek-host',
        policy_blocked: false,
        approval_required: false,
        approval_granted: false,
      }));
      expect(mocks.webhookOutbound.fireWebhookForEvent).toHaveBeenCalledWith(
        'peek.recovery.executed',
        {
          action: 'close_dialog',
          mode: 'shadow',
          success: true,
        },
      );
    });

    it('swallows metric logging errors and webhook rejections', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      vi.spyOn(mocks.db, 'recordRecoveryMetric').mockImplementation(() => {
        throw new Error('metrics sink offline');
      });
      mocks.webhookOutbound.fireWebhookForEvent.mockRejectedValueOnce(new Error('webhook offline'));
      queueAllowed(postSpy, 'close_dialog');
      queueExecute(postSpy);

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result.success).toBe(true);
      expect(mocks.webhookOutbound.fireWebhookForEvent).toHaveBeenCalledTimes(1);
    });

    it('returns a structured failure when policy evaluation throws unexpectedly', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      vi.spyOn(mocks.taskHooks, 'evaluateAtStage').mockImplementation(() => {
        throw new Error('policy engine exploded');
      });
      queueAllowed(postSpy, 'close_dialog');

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'close_dialog',
      });

      expect(result).toMatchObject({
        success: false,
        audit_entry: {
          error: 'policy engine exploded',
        },
      });
      expect(mocks.loggerInstance.warn).toHaveBeenCalledWith(
        'Recovery handler failed for close_dialog: policy engine exploded',
      );
    });

    it('classifies unknown actions as high risk and attaches the default rollback plan', async () => {
      const postSpy = vi.spyOn(mocks.peekShared, 'peekHttpPostWithRetry');
      queueAllowed(postSpy, 'unknown_action');
      queueExecute(postSpy, {
        attempts: 0,
      });

      handlers = loadHandlers();
      const result = await handlers.handlePeekRecovery({
        action: 'unknown_action',
      });

      expect(result).toMatchObject({
        success: true,
        mode: 'shadow',
        risk_level: 'high',
        audit_entry: {
          rollback_plan: {
            action: 'unknown_action',
            rollback_steps: [{
              step: 'log_manual_follow_up',
            }],
          },
        },
      });
    });
  });
});
