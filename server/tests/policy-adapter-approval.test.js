'use strict';

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SUBJECT_MODULE = '../policy-engine/adapters/approval';
const SCHEDULING_AUTOMATION_MODULE = '../db/scheduling-automation';
const EVALUATION_STORE_MODULE = '../policy-engine/evaluation-store';

const subjectPath = require.resolve(SUBJECT_MODULE);
const schedulingAutomationPath = require.resolve(SCHEDULING_AUTOMATION_MODULE);
const evaluationStorePath = require.resolve(EVALUATION_STORE_MODULE);

function createSchedulingAutomationMock(overrides = {}) {
  return {
    listApprovalRules: vi.fn(() => []),
    getApprovalHistory: vi.fn(() => []),
    getApprovalRequest: vi.fn(() => null),
    createApprovalRule: vi.fn(() => 'rule-created'),
    getApprovalRule: vi.fn((id) => ({ id, name: `resolved-${id}` })),
    createApprovalRequest: vi.fn(() => 'request-created'),
    ...overrides,
  };
}

function createEvaluationStoreMock(overrides = {}) {
  return {
    getPolicyEvaluation: vi.fn(() => null),
    listPolicyEvaluations: vi.fn(() => []),
    ...overrides,
  };
}

function loadSubject(options = {}) {
  const schedulingAutomation = createSchedulingAutomationMock(options.schedulingAutomation);
  const evaluationStore = createEvaluationStoreMock(options.evaluationStore);

  delete require.cache[subjectPath];
  delete require.cache[schedulingAutomationPath];
  delete require.cache[evaluationStorePath];
  installMock(SCHEDULING_AUTOMATION_MODULE, schedulingAutomation);
  installMock(EVALUATION_STORE_MODULE, evaluationStore);

  return {
    schedulingAutomation,
    evaluationStore,
    ...require(SUBJECT_MODULE),
  };
}

function approvalEvidence(available, satisfied) {
  return {
    type: 'approval_recorded',
    available,
    satisfied,
  };
}

afterEach(() => {
  delete require.cache[subjectPath];
  delete require.cache[schedulingAutomationPath];
  delete require.cache[evaluationStorePath];
  vi.clearAllMocks();
});

describe('policy-engine/adapters/approval', () => {
  describe('exports', () => {
    it('exports the peek recovery high-risk approval type constant', () => {
      const { PEEK_HIGH_RISK_APPROVAL_TYPE } = loadSubject();

      expect(PEEK_HIGH_RISK_APPROVAL_TYPE).toBe('peek_recovery_high_risk');
    });
  });

  describe('collectApprovalEvidence', () => {
    it('returns unavailable evidence when task id cannot be resolved', () => {
      const { collectApprovalEvidence, schedulingAutomation } = loadSubject();

      expect(collectApprovalEvidence({ policy_id: 'policy-a' })).toEqual(
        approvalEvidence(false, false),
      );
      expect(schedulingAutomation.getApprovalRequest).not.toHaveBeenCalled();
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
    });

    it('uses direct request lookup when policy id is absent and normalizes approved status', () => {
      const { collectApprovalEvidence, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          getApprovalRequest: vi.fn(() => ({ id: 'request-1', status: ' APPROVED ' })),
        },
      });

      expect(collectApprovalEvidence({
        task: { id: 'task-1' },
      })).toEqual(approvalEvidence(true, true));
      expect(schedulingAutomation.getApprovalRequest).toHaveBeenCalledWith('task-1');
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
    });

    it('returns unavailable evidence when policy-less request lookup throws', () => {
      const { collectApprovalEvidence, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          getApprovalRequest: vi.fn(() => {
            throw new Error('request lookup failed');
          }),
        },
      });

      expect(collectApprovalEvidence({
        target_id: 'task-lookup-error',
      })).toEqual(approvalEvidence(false, false));
      expect(schedulingAutomation.getApprovalRequest).toHaveBeenCalledWith('task-lookup-error');
    });

    it('matches approval history by rule id using policy approval rules and project resolution', () => {
      const { collectApprovalEvidence, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => [
            {
              id: 'rule-7',
              condition: {
                source: 'policy-engine',
                policy_id: 'policy-a',
              },
            },
          ]),
          getApprovalHistory: vi.fn(() => [
            {
              id: 'request-7',
              rule_id: 'rule-7',
              status: ' approved ',
            },
          ]),
        },
      });

      expect(collectApprovalEvidence({
        target: {
          id: 'task-7',
          project: 'Project-X',
        },
        policy: {
          id: 'policy-a',
        },
      })).toEqual(approvalEvidence(true, true));
      expect(schedulingAutomation.listApprovalRules).toHaveBeenCalledWith({
        enabledOnly: false,
        limit: 1000,
        project: 'Project-X',
      });
      expect(schedulingAutomation.getApprovalRequest).not.toHaveBeenCalled();
    });

    it('falls back to rule-name matching when rule listing fails', () => {
      const { collectApprovalEvidence, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => {
            throw new Error('rule listing failed');
          }),
          getApprovalHistory: vi.fn(() => [
            {
              id: 'request-8',
              rule_name: 'Policy approval: policy-b',
              status: ' rejected ',
            },
          ]),
        },
      });

      expect(collectApprovalEvidence({
        taskId: 'task-8',
        policyId: 'policy-b',
        project: 'Project-Y',
      })).toEqual(approvalEvidence(true, false));
      expect(schedulingAutomation.listApprovalRules).toHaveBeenCalledWith({
        enabledOnly: false,
        limit: 1000,
        project: 'Project-Y',
      });
    });

    it('returns unavailable evidence when approval history is not an array', () => {
      const { collectApprovalEvidence, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          getApprovalHistory: vi.fn(() => ({ status: 'approved' })),
        },
      });

      expect(collectApprovalEvidence({
        task_id: 'task-history-object',
        policy_id: 'policy-c',
      })).toEqual(approvalEvidence(false, false));
      expect(schedulingAutomation.listApprovalRules).not.toHaveBeenCalled();
    });
  });

  describe('requireApprovalForOutcome', () => {
    [
      [{ outcome: 'pass', mode: 'warn' }, 'non-failing outcomes'],
      [{ outcome: 'fail', mode: 'enforce' }, 'non-warn failures'],
    ].forEach(([policyOutcome, label]) => {
      it(`returns false for ${label}`, () => {
        const { requireApprovalForOutcome, schedulingAutomation, evaluationStore } = loadSubject();

        expect(requireApprovalForOutcome(policyOutcome, { task_id: 'task-skip' })).toBe(false);
        expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
        expect(evaluationStore.getPolicyEvaluation).not.toHaveBeenCalled();
        expect(evaluationStore.listPolicyEvaluations).not.toHaveBeenCalled();
      });
    });

    it('returns false when overrideRecorded is explicitly true in the context', () => {
      const { requireApprovalForOutcome, schedulingAutomation, evaluationStore } = loadSubject();

      expect(requireApprovalForOutcome(
        {
          outcome: ' FAIL ',
          mode: ' WARN ',
          policy_id: 'policy-d',
        },
        {
          taskId: 'task-explicit-bypass',
          overrideRecorded: ' true ',
        },
      )).toBe(false);
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
      expect(evaluationStore.getPolicyEvaluation).not.toHaveBeenCalled();
      expect(evaluationStore.listPolicyEvaluations).not.toHaveBeenCalled();
    });

    it('returns false when the referenced evaluation already contains an override', () => {
      const { requireApprovalForOutcome, schedulingAutomation, evaluationStore } = loadSubject({
        evaluationStore: {
          getPolicyEvaluation: vi.fn(() => ({
            id: 'eval-1',
            policy_id: 'policy-e',
            outcome: 'fail',
            latest_override: { id: 'override-1' },
          })),
        },
      });

      expect(requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
          policyId: 'policy-e',
        },
        {
          task_id: 'task-eval-bypass',
          evaluation: { id: 'eval-1' },
        },
      )).toBe(false);
      expect(evaluationStore.getPolicyEvaluation).toHaveBeenCalledWith('eval-1', {
        include_overrides: true,
      });
      expect(evaluationStore.listPolicyEvaluations).not.toHaveBeenCalled();
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
    });

    it('falls back to task-based evaluation lookup and requires approval when no request exists', () => {
      const { requireApprovalForOutcome, evaluationStore, schedulingAutomation } = loadSubject({
        evaluationStore: {
          getPolicyEvaluation: vi.fn(() => ({
            id: 'eval-mismatch',
            policy_id: 'other-policy',
            outcome: 'overridden',
            latest_override: { id: 'override-other' },
          })),
          listPolicyEvaluations: vi.fn(() => [
            {
              id: 'eval-task',
              policy_id: 'policy-f',
              outcome: 'fail',
              latest_override: null,
            },
          ]),
        },
      });

      expect(requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
          policy_id: 'policy-f',
        },
        {
          target_id: 'task-fallback-lookup',
          evaluation_id: 'eval-mismatch',
          override_recorded: 'false',
        },
      )).toBe(true);
      expect(evaluationStore.getPolicyEvaluation).toHaveBeenCalledWith('eval-mismatch', {
        include_overrides: true,
      });
      expect(evaluationStore.listPolicyEvaluations).toHaveBeenCalledWith({
        policy_id: 'policy-f',
        target_type: 'task',
        target_id: 'task-fallback-lookup',
        include_overrides: true,
        limit: 1,
      });
      expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledWith('task-fallback-lookup');
    });

    ['approved', 'rejected', 'pending'].forEach((status) => {
      it(`returns false when a matching approval request is already ${status}`, () => {
        const { requireApprovalForOutcome, schedulingAutomation } = loadSubject({
          schedulingAutomation: {
            listApprovalRules: vi.fn(() => []),
            getApprovalHistory: vi.fn(() => [
              {
                id: `request-${status}`,
                rule_name: 'Policy approval: policy-g',
                status,
              },
            ]),
          },
        });

        expect(requireApprovalForOutcome(
          {
            outcome: 'fail',
            mode: 'warn',
            policy_id: 'policy-g',
          },
          {
            task_id: 'task-existing-request',
          },
        )).toBe(false);
        expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledWith('task-existing-request');
      });
    });

    it('requires a fresh approval when lookup errors occur and the existing request status is unrecognized', () => {
      const { requireApprovalForOutcome, evaluationStore } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => []),
          getApprovalHistory: vi.fn(() => [
            {
              id: 'request-expired',
              rule_name: 'Policy approval: policy-h',
              status: 'expired',
            },
          ]),
        },
        evaluationStore: {
          getPolicyEvaluation: vi.fn(() => {
            throw new Error('evaluation missing');
          }),
          listPolicyEvaluations: vi.fn(() => {
            throw new Error('evaluation list unavailable');
          }),
        },
      });

      expect(requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
          policy_id: 'policy-h',
        },
        {
          task_id: 'task-expired-request',
          evaluationId: 'eval-throw',
        },
      )).toBe(true);
      expect(evaluationStore.getPolicyEvaluation).toHaveBeenCalledWith('eval-throw', {
        include_overrides: true,
      });
      expect(evaluationStore.listPolicyEvaluations).toHaveBeenCalledWith({
        policy_id: 'policy-h',
        target_type: 'task',
        target_id: 'task-expired-request',
        include_overrides: true,
        limit: 1,
      });
    });

    it('requires approval for high-risk peek recovery actions when no request exists', () => {
      const { requireApprovalForOutcome, schedulingAutomation, evaluationStore } = loadSubject();

      expect(requireApprovalForOutcome(
        {
          outcome: 'pass',
          mode: 'enforce',
        },
        {
          task: {
            id: 'task-high-risk-missing',
            project: 'Project-Peek',
          },
          evidence: {
            peek_recovery: true,
            action: 'force_kill_process',
          },
        },
      )).toBe(true);
      expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledWith('task-high-risk-missing');
      expect(schedulingAutomation.listApprovalRules).not.toHaveBeenCalled();
      expect(evaluationStore.getPolicyEvaluation).not.toHaveBeenCalled();
      expect(evaluationStore.listPolicyEvaluations).not.toHaveBeenCalled();
    });

    ['approved', 'rejected', 'pending'].forEach((status) => {
      it(`returns false when a high-risk peek recovery request is already ${status}`, () => {
        const { requireApprovalForOutcome, schedulingAutomation } = loadSubject({
          schedulingAutomation: {
            listApprovalRules: vi.fn(() => []),
            getApprovalHistory: vi.fn(() => [
              {
                id: `high-risk-${status}`,
                rule_name: 'Peek recovery high-risk approval: force_kill_process',
                status,
              },
            ]),
          },
        });

        expect(requireApprovalForOutcome(
          {},
          {
            task_id: 'task-high-risk-existing',
            project: 'Project-Peek',
            evidence: {
              peek_recovery: true,
              action_name: 'force_kill_process',
            },
          },
        )).toBe(false);
        expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledWith('task-high-risk-existing');
        expect(schedulingAutomation.listApprovalRules).toHaveBeenCalledWith({
          enabledOnly: false,
          limit: 1000,
          project: 'Project-Peek',
        });
      });
    });

    it('requires a fresh approval when a high-risk peek recovery request has an unrecognized status', () => {
      const { requireApprovalForOutcome, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => []),
          getApprovalHistory: vi.fn(() => [
            {
              id: 'high-risk-expired',
              rule_name: 'Peek recovery high-risk approval: force_kill_process',
              status: 'expired',
            },
          ]),
        },
      });

      expect(requireApprovalForOutcome(
        {},
        {
          task_id: 'task-high-risk-expired',
          project: 'Project-Peek',
          evidence: {
            peek_recovery: true,
            action: 'force_kill_process',
          },
        },
      )).toBe(true);
      expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledWith('task-high-risk-expired');
    });
  });

  describe('requireHighRiskApproval', () => {
    it('returns approved when the action is not classified as high risk', () => {
      const { requireHighRiskApproval, schedulingAutomation } = loadSubject();

      expect(requireHighRiskApproval('scroll', {
        task_id: 'task-low-risk',
      })).toEqual({
        approved: true,
        approval_id: null,
        reason: 'Approval not required',
      });
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
      expect(schedulingAutomation.createApprovalRule).not.toHaveBeenCalled();
      expect(schedulingAutomation.createApprovalRequest).not.toHaveBeenCalled();
    });

    it('returns unapproved when a high-risk action lacks a task id', () => {
      const { requireHighRiskApproval, schedulingAutomation } = loadSubject();

      expect(requireHighRiskApproval('force_kill_process', {
        project: 'Project-Peek',
      })).toEqual({
        approved: false,
        approval_id: null,
        reason: 'High-risk action requires approval',
      });
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
      expect(schedulingAutomation.createApprovalRule).not.toHaveBeenCalled();
    });

    it('returns approved when a matching high-risk request is already approved', () => {
      const { requireHighRiskApproval, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => {
            throw new Error('rule lookup failed');
          }),
          getApprovalHistory: vi.fn(() => [
            {
              id: 'approval-existing',
              rule_name: 'Peek recovery high-risk approval: force_kill_process',
              status: ' approved ',
            },
          ]),
        },
      });

      expect(requireHighRiskApproval(' force_kill_process ', {
        task: {
          id: 'task-approved',
          project: 'Project-Peek',
        },
      })).toEqual({
        approved: true,
        approval_id: 'approval-existing',
        reason: 'Approval granted',
      });
      expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledWith('task-approved');
      expect(schedulingAutomation.createApprovalRequest).not.toHaveBeenCalled();
    });

    it('returns unapproved when a matching high-risk request is pending', () => {
      const { requireHighRiskApproval, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => []),
          getApprovalHistory: vi.fn(() => [
            {
              id: 'approval-pending',
              rule_name: 'Peek recovery high-risk approval: force_kill_process',
              status: 'pending',
            },
          ]),
        },
      });

      expect(requireHighRiskApproval('force_kill_process', {
        task_id: 'task-pending',
        project: 'Project-Peek',
      })).toEqual({
        approved: false,
        approval_id: 'approval-pending',
        reason: 'High-risk action requires approval',
      });
      expect(schedulingAutomation.createApprovalRequest).not.toHaveBeenCalled();
    });

    it('attaches a new high-risk request and returns the synthetic pending approval id when follow-up lookup is empty', () => {
      const { requireHighRiskApproval, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => []),
          getApprovalHistory: vi.fn(() => []),
          createApprovalRule: vi.fn(() => 'rule-high-risk'),
          getApprovalRule: vi.fn((id) => ({ id, name: `resolved-${id}` })),
          createApprovalRequest: vi.fn(() => 'request-high-risk'),
        },
      });

      expect(requireHighRiskApproval('force_kill_process', {
        task: {
          id: 'task-create-high-risk',
          project: 'Project-Peek',
        },
      })).toEqual({
        approved: false,
        approval_id: 'request-high-risk',
        reason: 'High-risk action requires approval',
      });
      expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledTimes(2);
      expect(schedulingAutomation.createApprovalRule).toHaveBeenCalledWith(
        'Peek recovery high-risk approval: force_kill_process',
        'keyword',
        {
          source: 'peek-recovery',
          approval_type: 'peek_recovery_high_risk',
          action: 'force_kill_process',
          manual_only: true,
          keywords: ['__torque_peek_recovery_high_risk__:force_kill_process'],
        },
        {
          project: 'Project-Peek',
        },
      );
      expect(schedulingAutomation.createApprovalRequest).toHaveBeenCalledWith(
        'task-create-high-risk',
        'rule-high-risk',
      );
    });

    it('returns approved when a newly attached high-risk request is approved on follow-up lookup', () => {
      const { requireHighRiskApproval, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => []),
          getApprovalHistory: vi.fn()
            .mockReturnValueOnce([])
            .mockReturnValueOnce([
              {
                id: 'approval-after-attach',
                rule_name: 'Peek recovery high-risk approval: force_kill_process',
                status: 'approved',
              },
            ]),
          createApprovalRequest: vi.fn(() => 'request-created'),
        },
      });

      expect(requireHighRiskApproval('force_kill_process', {
        task_id: 'task-approved-after-attach',
        project: 'Project-Peek',
      })).toEqual({
        approved: true,
        approval_id: 'approval-after-attach',
        reason: 'Approval granted',
      });
      expect(schedulingAutomation.createApprovalRequest).toHaveBeenCalledWith(
        'task-approved-after-attach',
        'rule-created',
      );
    });

    it('returns unapproved when the matching high-risk request has no usable id', () => {
      const { requireHighRiskApproval } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => []),
          getApprovalHistory: vi.fn(() => [
            {
              id: '   ',
              rule_name: 'Peek recovery high-risk approval: force_kill_process',
              status: 'approved',
            },
          ]),
        },
      });

      expect(requireHighRiskApproval('force_kill_process', {
        task_id: 'task-blank-id',
      })).toEqual({
        approved: false,
        approval_id: null,
        reason: 'High-risk action requires approval',
      });
    });
  });

  describe('attachApprovalRequest', () => {
    it('throws when taskId is missing', () => {
      const { attachApprovalRequest } = loadSubject();

      expect(() => attachApprovalRequest()).toThrow('taskId is required');
    });

    it('throws when policyId is missing', () => {
      const { attachApprovalRequest } = loadSubject();

      expect(() => attachApprovalRequest('task-1', '   ')).toThrow('policyId is required');
    });

    it('bypasses attachment when policy outcome already reports an override', () => {
      const { attachApprovalRequest, schedulingAutomation } = loadSubject();

      expect(attachApprovalRequest('task-override', 'policy-i', {
        policyOutcome: {
          outcome: 'overridden',
        },
      })).toEqual({
        attached: false,
        bypassed: true,
        request_id: null,
        rule_id: null,
      });
      expect(schedulingAutomation.createApprovalRule).not.toHaveBeenCalled();
      expect(schedulingAutomation.createApprovalRequest).not.toHaveBeenCalled();
    });

    it('reuses an existing policy approval rule and attaches a request', () => {
      const { attachApprovalRequest, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => [
            {
              id: 'rule-existing',
              name: 'Policy approval: policy-j',
            },
          ]),
          createApprovalRequest: vi.fn(() => 'request-existing'),
        },
      });

      expect(attachApprovalRequest(' task-existing ', ' policy-j ', {
        context: {
          project: 'Project-Existing',
        },
      })).toEqual({
        attached: true,
        bypassed: false,
        request_id: 'request-existing',
        rule_id: 'rule-existing',
      });
      expect(schedulingAutomation.listApprovalRules).toHaveBeenCalledWith({
        enabledOnly: false,
        limit: 1000,
        project: 'Project-Existing',
      });
      expect(schedulingAutomation.createApprovalRule).not.toHaveBeenCalled();
      expect(schedulingAutomation.createApprovalRequest).toHaveBeenCalledWith('task-existing', 'rule-existing');
    });

    it('creates a new approval rule with scheduler options before attaching the request', () => {
      const { attachApprovalRequest, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          createApprovalRule: vi.fn(() => 'rule-created-1'),
          getApprovalRule: vi.fn((id) => ({
            id,
            name: 'resolved-rule',
          })),
          createApprovalRequest: vi.fn(() => 'request-created-1'),
        },
      });

      expect(attachApprovalRequest('task-create', 'policy-k', {
        project: 'Project-New',
        requiredApprovers: 2,
        autoApproveAfterMinutes: 30,
      })).toEqual({
        attached: true,
        bypassed: false,
        request_id: 'request-created-1',
        rule_id: 'rule-created-1',
      });
      expect(schedulingAutomation.createApprovalRule).toHaveBeenCalledWith(
        'Policy approval: policy-k',
        'keyword',
        {
          source: 'policy-engine',
          policy_id: 'policy-k',
          manual_only: true,
          keywords: ['__torque_policy_approval__:policy-k'],
        },
        {
          project: 'Project-New',
          requiredApprovers: 2,
          autoApproveAfterMinutes: 30,
        },
      );
      expect(schedulingAutomation.getApprovalRule).toHaveBeenCalledWith('rule-created-1');
      expect(schedulingAutomation.createApprovalRequest).toHaveBeenCalledWith('task-create', 'rule-created-1');
    });

    it('falls back to a synthetic rule object when getApprovalRule is unavailable', () => {
      const { attachApprovalRequest, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          createApprovalRule: vi.fn(() => 'rule-created-2'),
          getApprovalRule: undefined,
          createApprovalRequest: vi.fn(() => 'request-created-2'),
        },
      });

      expect(attachApprovalRequest('task-fallback', 'policy-l', {
        context: {
          target: {
            project: 'Project-Context',
          },
        },
      })).toEqual({
        attached: true,
        bypassed: false,
        request_id: 'request-created-2',
        rule_id: 'rule-created-2',
      });
      expect(schedulingAutomation.listApprovalRules).toHaveBeenCalledWith({
        enabledOnly: false,
        limit: 1000,
        project: 'Project-Context',
      });
      expect(schedulingAutomation.createApprovalRequest).toHaveBeenCalledWith('task-fallback', 'rule-created-2');
    });

    it('throws when approval rule creation is unavailable', () => {
      const { attachApprovalRequest } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: undefined,
          createApprovalRule: undefined,
        },
      });

      expect(() => attachApprovalRequest('task-no-rule-creator', 'policy-m')).toThrow(
        'approval rule creation is unavailable',
      );
    });

    it('throws when the created rule cannot be resolved to a rule id', () => {
      const { attachApprovalRequest, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          createApprovalRule: vi.fn(() => 'rule-created-3'),
          getApprovalRule: vi.fn(() => null),
        },
      });

      expect(() => attachApprovalRequest('task-unresolved-rule', 'policy-n')).toThrow(
        'Unable to resolve approval rule for policy policy-n',
      );
      expect(schedulingAutomation.createApprovalRequest).not.toHaveBeenCalled();
    });

    it('throws when approval request creation is unavailable after resolving a rule', () => {
      const { attachApprovalRequest } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => [
            {
              id: 'rule-condition',
              condition: {
                source: 'policy-engine',
                policy_id: 'policy-o',
              },
            },
          ]),
          createApprovalRequest: undefined,
        },
      });

      expect(() => attachApprovalRequest('task-no-request-creator', 'policy-o')).toThrow(
        'approval request creation is unavailable',
      );
    });

    it('does not bypass high-risk approval attachments even when override metadata is present', () => {
      const { attachApprovalRequest, schedulingAutomation, PEEK_HIGH_RISK_APPROVAL_TYPE } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => []),
          createApprovalRule: vi.fn(() => 'rule-high-risk'),
          getApprovalRule: vi.fn((id) => ({
            id,
            name: 'resolved-high-risk-rule',
          })),
          createApprovalRequest: vi.fn(() => 'request-high-risk'),
        },
      });

      expect(attachApprovalRequest('task-high-risk', 'force_kill_process', {
        approvalType: PEEK_HIGH_RISK_APPROVAL_TYPE,
        context: {
          project: 'Project-Peek',
        },
        policyOutcome: {
          outcome: 'overridden',
        },
      })).toEqual({
        attached: true,
        bypassed: false,
        request_id: 'request-high-risk',
        rule_id: 'rule-high-risk',
      });
      expect(schedulingAutomation.createApprovalRule).toHaveBeenCalledWith(
        'Peek recovery high-risk approval: force_kill_process',
        'keyword',
        {
          source: 'peek-recovery',
          approval_type: 'peek_recovery_high_risk',
          action: 'force_kill_process',
          manual_only: true,
          keywords: ['__torque_peek_recovery_high_risk__:force_kill_process'],
        },
        {
          project: 'Project-Peek',
        },
      );
      expect(schedulingAutomation.createApprovalRequest).toHaveBeenCalledWith(
        'task-high-risk',
        'rule-high-risk',
      );
    });
  });
});
