import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const approvalAdapter = require('../policy-engine/adapters/approval');
const schedulingAutomation = require('../db/scheduling-automation');

describe('policy approval adapter', () => {
  let db;
  let testDir;

  beforeEach(() => {
    ({ db, testDir } = setupTestDbOnly('policy-approval-adapter'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownTestDb();
  });

  function createTask(overrides = {}) {
    const task = db.createTask({
      id: overrides.id || randomUUID(),
      task_description: overrides.task_description || 'policy approval adapter task',
      status: 'queued',
      provider: 'codex',
      working_directory: overrides.working_directory || testDir,
      ...overrides,
    });

    return task.id;
  }

  function seedApprovalRequest(taskId, status = 'pending') {
    const ruleId = db.createApprovalRule(`approval-${status}`, 'all', {});
    const requestId = db.createApprovalRequest(taskId, ruleId);

    if (status === 'approved') {
      db.approveTask(taskId, 'reviewer', 'approved for execution');
    } else if (status === 'rejected') {
      db.rejectApproval(taskId, 'reviewer', 'rejected for execution');
    }

    return { ruleId, requestId };
  }

  it('returns unavailable approval evidence when no approval request exists', () => {
    const taskId = createTask();

    expect(approvalAdapter.collectApprovalEvidence({ task_id: taskId })).toEqual({
      type: 'approval_recorded',
      available: false,
      satisfied: false,
    });
  });

  it('returns unsatisfied evidence for pending approvals', () => {
    const taskId = createTask();
    seedApprovalRequest(taskId, 'pending');

    expect(approvalAdapter.collectApprovalEvidence({ task_id: taskId })).toEqual({
      type: 'approval_recorded',
      available: true,
      satisfied: false,
    });
  });

  it('returns satisfied evidence for approved requests', () => {
    const taskId = createTask();
    seedApprovalRequest(taskId, 'approved');

    expect(approvalAdapter.collectApprovalEvidence({ task_id: taskId })).toEqual({
      type: 'approval_recorded',
      available: true,
      satisfied: true,
    });
  });

  it('returns unsatisfied evidence for rejected requests', () => {
    const taskId = createTask();
    seedApprovalRequest(taskId, 'rejected');

    expect(approvalAdapter.collectApprovalEvidence({ task_id: taskId })).toEqual({
      type: 'approval_recorded',
      available: true,
      satisfied: false,
    });
  });

  it('requires approval for warn-mode policy failures', () => {
    const taskId = createTask();

    expect(approvalAdapter.requireApprovalForOutcome(
      {
        policy_id: 'policy-warn-review',
        outcome: 'fail',
        mode: 'warn',
      },
      { task_id: taskId },
    )).toBe(true);
  });

  it('attaches approval requests through the existing scheduler-backed createApprovalRequest path', () => {
    const taskId = createTask();
    const createApprovalSpy = vi.spyOn(schedulingAutomation, 'createApprovalRequest');

    const result = approvalAdapter.attachApprovalRequest(taskId, 'policy-scheduler-review');
    const request = db.getApprovalRequest(taskId);

    expect(createApprovalSpy).toHaveBeenCalledWith(taskId, result.rule_id);
    expect(result).toMatchObject({
      attached: true,
      bypassed: false,
      request_id: request.id,
    });
    expect(request.status).toBe('pending');
    expect(db.getTask(taskId).approval_status).toBe('pending');
  });

  it('bypasses approval creation when an override is already recorded', () => {
    const taskId = createTask();
    db.savePolicyRule({
      id: 'policy-override-bypass',
      name: 'policy-override-bypass',
      category: 'change_safety',
      stage: 'task_complete',
      mode: 'warn',
      matcher: {},
      required_evidence: [],
      actions: [{ type: 'emit_violation', severity: 'warning' }],
      override_policy: { allowed: true },
      enabled: true,
    });
    const evaluation = db.createPolicyEvaluation({
      policy_id: 'policy-override-bypass',
      stage: 'task_complete',
      target_type: 'task',
      target_id: taskId,
      mode: 'warn',
      outcome: 'fail',
      override_allowed: true,
      evidence: {},
      evaluation: {},
    });
    db.createPolicyOverride({
      evaluation_id: evaluation.id,
      policy_id: 'policy-override-bypass',
      reason_code: 'approved_exception',
      actor: 'operator-1',
    });

    const createApprovalSpy = vi.spyOn(schedulingAutomation, 'createApprovalRequest');
    const result = approvalAdapter.attachApprovalRequest(taskId, 'policy-override-bypass', {
      evaluation_id: evaluation.id,
    });

    expect(result).toEqual({
      attached: false,
      bypassed: true,
      request_id: null,
      rule_id: null,
    });
    expect(createApprovalSpy).not.toHaveBeenCalled();
    expect(db.getApprovalRequest(taskId) || null).toBeNull();
    expect(['not_required', null]).toContain(db.getTask(taskId).approval_status || null);
  });
});
