import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

function createRecoveryTask(db, testDir, overrides = {}) {
  return db.createTask({
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'peek high-risk approval task',
    status: overrides.status || 'queued',
    provider: overrides.provider || 'codex',
    working_directory: overrides.working_directory || testDir,
    ...overrides,
  }).id;
}

function buildApprovalContext(taskId, action, overrides = {}) {
  return {
    __taskId: taskId,
    action,
    params: overrides.params || {},
    requestedBy: overrides.requestedBy || 'operator-1',
    ...overrides,
  };
}

const mockShared = {
  peekHttpGetWithRetry: vi.fn(),
  peekHttpPostWithRetry: vi.fn(),
  resolvePeekHost: vi.fn(),
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

let db;
let testDir;
let handlePeekRecovery;

function loadRecoveryHandler() {
  delete require.cache[require.resolve('../plugins/snapscope/handlers/recovery')];
  ({ handlePeekRecovery } = require('../plugins/snapscope/handlers/recovery'));
}

function primeAllowedAction(action, maxRetries = 0, timeoutMs = 5000) {
  mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
    data: {
      allowed: true,
      action_spec: {
        name: action,
        max_retries: maxRetries,
        timeout_ms: timeoutMs,
      },
    },
  });
}

function primeExecutionSuccess(auditEntry = { recovery_id: 'recovery-1' }, attempts = 1) {
  mockShared.peekHttpPostWithRetry.mockResolvedValueOnce({
    data: {
      success: true,
      attempts,
      audit_entry: auditEntry,
    },
  });
}

function listApprovalRows(action, taskId) {
  return db.getDbInstance().prepare(`
    SELECT id, action, task_id, requested_by, approved_by, status, requested_at, resolved_at
    FROM peek_recovery_approvals
    WHERE action = ? AND task_id = ?
    ORDER BY id ASC
  `).all(action, taskId);
}

describe('peek high-risk recovery approvals', () => {
  beforeEach(() => {
    ({ db, testDir } = setupTestDb('peek-high-risk-approval'));
    vi.clearAllMocks();

    sharedModule.peekHttpGetWithRetry = mockShared.peekHttpGetWithRetry;
    sharedModule.peekHttpPostWithRetry = mockShared.peekHttpPostWithRetry;
    sharedModule.resolvePeekHost = mockShared.resolvePeekHost;
    sharedModule.resolvePeekTaskContext = originalShared.resolvePeekTaskContext;
    shadowEnforcerModule.enforceMode = mockShadowEnforcer.enforceMode;
    taskHooksModule.evaluateAtStage = mockTaskHooks.evaluateAtStage;
    loggerModule.child = mockLogger.child;

    loadRecoveryHandler();

    mockShared.resolvePeekHost.mockReturnValue({
      hostName: 'snap-host',
      hostUrl: 'http://snap-host',
    });
    mockShadowEnforcer.enforceMode.mockImplementation((requestedMode) => requestedMode);
    mockTaskHooks.evaluateAtStage.mockReturnValue({
      shadow: false,
      blocked: false,
      summary: { passed: 1, failed: 0, blocked: 0 },
      results: [{ policy_id: 'recovery-policy', outcome: 'pass' }],
    });
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
    delete require.cache[require.resolve('../plugins/snapscope/handlers/recovery')];
  });

  afterAll(() => {
    sharedModule.peekHttpGetWithRetry = originalShared.peekHttpGetWithRetry;
    sharedModule.peekHttpPostWithRetry = originalShared.peekHttpPostWithRetry;
    sharedModule.resolvePeekHost = originalShared.resolvePeekHost;
    sharedModule.resolvePeekTaskContext = originalShared.resolvePeekTaskContext;
    shadowEnforcerModule.enforceMode = originalEnforceMode;
    taskHooksModule.evaluateAtStage = originalEvaluateAtStage;
    loggerModule.child = originalLoggerChild;
  });

  it('persists pending approval requests for high-risk recovery actions', () => {
    const taskId = createRecoveryTask(db, testDir);

    const request = db.requestApproval('modify_registry_key', taskId, 'operator-1');

    expect(request).toMatchObject({
      id: expect.any(Number),
      action: 'modify_registry_key',
      task_id: taskId,
      requested_by: 'operator-1',
      approved_by: null,
      status: 'pending',
      requested_at: expect.any(String),
      resolved_at: null,
    });
    expect(db.getApprovalStatus(request.id)).toEqual(request);
    expect(db.getApprovalForAction('modify_registry_key', taskId)).toEqual(request);
  });

  it('records grant and deny decisions with resolver metadata', () => {
    const approvedTaskId = createRecoveryTask(db, testDir);
    const deniedTaskId = createRecoveryTask(db, testDir);

    const approvedRequest = db.requestApproval('force_kill_process', approvedTaskId, 'operator-1');
    const deniedRequest = db.requestApproval('inject_accessibility_hook', deniedTaskId, 'operator-2');

    const approved = db.grantApproval(approvedRequest.id, 'reviewer-1');
    const denied = db.denyApproval(deniedRequest.id, 'reviewer-2');

    expect(approved).toMatchObject({
      id: approvedRequest.id,
      status: 'approved',
      approved_by: 'reviewer-1',
      resolved_at: expect.any(String),
    });
    expect(denied).toMatchObject({
      id: deniedRequest.id,
      status: 'denied',
      approved_by: 'reviewer-2',
      resolved_at: expect.any(String),
    });
  });

  it('blocks execution without approval and creates a pending approval record', async () => {
    const taskId = createRecoveryTask(db, testDir);
    primeAllowedAction('force_kill_process');

    const result = await handlePeekRecovery(buildApprovalContext(taskId, 'force_kill_process', {
      params: {
        processName: 'hung-app.exe',
        pid: 3210,
        killReason: 'operator confirmed hang',
      },
      requestedBy: 'operator-1',
    }));

    const approval = db.getApprovalStatus(result.approval_id);

    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.approval_required).toBe(true);
    expect(result.approval_id).toEqual(expect.any(Number));
    expect(result.audit_entry.error).toBe('High-risk action requires approval');
    expect(result.audit_entry.approval).toMatchObject({
      action: 'force_kill_process',
      approved: false,
      blocked: true,
      approval_required: true,
      approval_id: result.approval_id,
      status: 'pending',
      requested_by: 'operator-1',
      reason: 'High-risk action requires approval',
    });
    expect(approval).toMatchObject({
      id: result.approval_id,
      action: 'force_kill_process',
      task_id: taskId,
      requested_by: 'operator-1',
      status: 'pending',
    });
    expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledTimes(1);
  });

  it('allows execution after approval is granted and records the approval audit trail', async () => {
    const taskId = createRecoveryTask(db, testDir);
    const request = db.requestApproval('modify_registry_key', taskId, 'operator-1');
    db.grantApproval(request.id, 'reviewer-1');

    primeAllowedAction('modify_registry_key');
    primeExecutionSuccess({ recovery_id: 'recovery-1' });

    const result = await handlePeekRecovery(buildApprovalContext(taskId, 'modify_registry_key', {
      params: {
        registryPath: 'HKCU\\Software\\Torque\\Mode',
        originalValue: 'safe',
        newValue: 'recovery',
      },
      requestedBy: 'operator-1',
    }));

    expect(result.success).toBe(true);
    expect(result.audit_entry).toMatchObject({
      recovery_id: 'recovery-1',
      approval: {
        action: 'modify_registry_key',
        approved: true,
        blocked: false,
        approval_required: true,
        approval_id: request.id,
        status: 'approved',
        requested_by: 'operator-1',
        approved_by: 'reviewer-1',
        reason: 'Approval granted',
      },
    });
    expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledTimes(2);
  });

  it('blocks execution after a denial and preserves the approval history', async () => {
    const taskId = createRecoveryTask(db, testDir);
    const firstRequest = db.requestApproval('inject_accessibility_hook', taskId, 'operator-1');
    db.denyApproval(firstRequest.id, 'reviewer-2');

    primeAllowedAction('inject_accessibility_hook');

    const result = await handlePeekRecovery(buildApprovalContext(taskId, 'inject_accessibility_hook', {
      params: {
        targetProcess: 'reader.exe',
        hookType: 'uia',
        injectionMethod: 'set_windows_hook_ex',
      },
      requestedBy: 'operator-1',
    }));

    const latestApproval = db.getApprovalForAction('inject_accessibility_hook', taskId);
    const history = listApprovalRows('inject_accessibility_hook', taskId);

    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.approval_required).toBe(true);
    expect(result.approval_id).toBe(latestApproval.id);
    expect(latestApproval).toMatchObject({
      status: 'pending',
      requested_by: 'operator-1',
    });
    expect(history).toEqual([
      expect.objectContaining({
        id: firstRequest.id,
        status: 'denied',
        approved_by: 'reviewer-2',
      }),
      expect.objectContaining({
        id: latestApproval.id,
        status: 'pending',
        approved_by: null,
      }),
    ]);
    expect(result.audit_entry.approval).toMatchObject({
      action: 'inject_accessibility_hook',
      approved: false,
      blocked: true,
      approval_required: true,
      approval_id: latestApproval.id,
      status: 'pending',
      reason: 'High-risk action requires approval',
    });
    expect(mockShared.peekHttpPostWithRetry).toHaveBeenCalledTimes(1);
  });
});
