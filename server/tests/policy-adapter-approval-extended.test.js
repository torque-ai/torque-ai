import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

const { installMock } = require('./cjs-mock');

const SUBJECT_MODULE = '../policy-engine/adapters/approval';
const SCHEDULING_AUTOMATION_MODULE = '../db/scheduling-automation';
const EVALUATION_STORE_MODULE = '../policy-engine/evaluation-store';
const ROLLBACK_MODULE = '../handlers/peek/rollback';

const subjectPath = require.resolve(SUBJECT_MODULE);
const schedulingAutomationPath = require.resolve(SCHEDULING_AUTOMATION_MODULE);
const evaluationStorePath = require.resolve(EVALUATION_STORE_MODULE);
const rollbackPath = require.resolve(ROLLBACK_MODULE);

let currentModules = {};

vi.mock('../db/scheduling-automation', () => currentModules.schedulingAutomation);
vi.mock('../policy-engine/evaluation-store', () => currentModules.evaluationStore);
vi.mock('../handlers/peek/rollback', () => currentModules.rollback);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function approvalEvidence(available, satisfied) {
  return {
    type: 'approval_recorded',
    available,
    satisfied,
  };
}

function createApprovalState() {
  return {
    rules: [],
    historyByTask: new Map(),
    nextRuleId: 1,
    nextRequestId: 1,
    getRequests(taskId) {
      return this.historyByTask.get(taskId) || [];
    },
    addRule(rule = {}) {
      const record = {
        id: hasOwn(rule, 'id') ? rule.id : `rule-${this.nextRuleId++}`,
        name: hasOwn(rule, 'name') ? rule.name : null,
        project: hasOwn(rule, 'project') ? rule.project : null,
        rule_type: hasOwn(rule, 'rule_type') ? rule.rule_type : 'keyword',
        condition: hasOwn(rule, 'condition') ? rule.condition : {},
      };
      this.rules.push(record);
      return record;
    },
    addRequest(taskId, request = {}) {
      const record = {
        id: hasOwn(request, 'id') ? request.id : `request-${this.nextRequestId++}`,
        task_id: String(taskId).trim(),
        rule_id: hasOwn(request, 'rule_id') ? request.rule_id : null,
        rule_name: hasOwn(request, 'rule_name') ? request.rule_name : null,
        status: hasOwn(request, 'status') ? request.status : 'pending',
        expires_at: hasOwn(request, 'expires_at') ? request.expires_at : null,
      };

      if (record.rule_name === null && record.rule_id) {
        const rule = this.rules.find((entry) => entry.id === record.rule_id);
        if (rule) {
          record.rule_name = rule.name;
        }
      }

      const history = this.getRequests(record.task_id).slice();
      history.push(record);
      this.historyByTask.set(record.task_id, history);
      return record;
    },
    updateRequest(taskId, requestId, patch = {}) {
      const history = this.getRequests(taskId);
      const record = history.find((entry) => entry.id === requestId);
      if (!record) return null;
      Object.assign(record, patch);
      return record;
    },
  };
}

function createSchedulingAutomationMock(overrides = {}) {
  const approvalState = createApprovalState();

  const schedulingAutomation = {
    listApprovalRules: vi.fn((options = {}) => approvalState.rules.filter((rule) => {
      if (options.project) {
        return rule.project === options.project;
      }
      return true;
    })),
    getApprovalHistory: vi.fn((taskId) => approvalState.getRequests(taskId).slice()),
    getApprovalRequest: vi.fn((taskId) => {
      const requests = approvalState.getRequests(taskId);
      return requests.length > 0 ? requests[requests.length - 1] : null;
    }),
    createApprovalRule: vi.fn((name, ruleType, condition, options = {}) => {
      return approvalState.addRule({
        name,
        rule_type: ruleType,
        condition,
        project: hasOwn(options, 'project') ? options.project : null,
      }).id;
    }),
    getApprovalRule: vi.fn((id) => approvalState.rules.find((rule) => rule.id === id) || null),
    createApprovalRequest: vi.fn((taskId, ruleId) => {
      return approvalState.addRequest(taskId, { rule_id: ruleId }).id;
    }),
  };

  Object.assign(schedulingAutomation, overrides);

  return {
    schedulingAutomation,
    approvalState,
  };
}

function createEvaluationStoreMock(overrides = {}) {
  return {
    getPolicyEvaluation: vi.fn(() => null),
    listPolicyEvaluations: vi.fn(() => []),
    ...overrides,
  };
}

function createRollbackMock(overrides = {}) {
  return {
    RISK_CLASSIFICATION: {
      close_dialog: { requires_approval: false },
      force_kill_process: { requires_approval: true },
      inject_accessibility_hook: { requires_approval: true },
      modify_registry_key: { requires_approval: true },
      restart_process: { requires_approval: false },
      scroll: { requires_approval: false },
    },
    ...overrides,
  };
}

function createModules(overrides = {}) {
  const { schedulingAutomation, approvalState } = createSchedulingAutomationMock(
    overrides.schedulingAutomation,
  );

  return {
    schedulingAutomation,
    evaluationStore: createEvaluationStoreMock(overrides.evaluationStore),
    rollback: createRollbackMock(overrides.rollback),
    approvalState,
  };
}

function loadSubject(overrides = {}) {
  currentModules = createModules(overrides);

  vi.resetModules();
  vi.doMock(SCHEDULING_AUTOMATION_MODULE, () => currentModules.schedulingAutomation);
  vi.doMock(EVALUATION_STORE_MODULE, () => currentModules.evaluationStore);
  vi.doMock(ROLLBACK_MODULE, () => currentModules.rollback);

  installMock(SCHEDULING_AUTOMATION_MODULE, currentModules.schedulingAutomation);
  installMock(EVALUATION_STORE_MODULE, currentModules.evaluationStore);
  installMock(ROLLBACK_MODULE, currentModules.rollback);

  delete require.cache[subjectPath];

  return {
    subject: require(SUBJECT_MODULE),
    schedulingAutomation: currentModules.schedulingAutomation,
    evaluationStore: currentModules.evaluationStore,
    approvalState: currentModules.approvalState,
  };
}

function addPolicyRule(approvalState, policyId, overrides = {}) {
  return approvalState.addRule({
    name: `Policy approval: ${policyId}`,
    condition: {
      source: 'policy-engine',
      policy_id: policyId,
    },
    ...overrides,
  });
}

function addHighRiskRule(approvalState, action, overrides = {}) {
  return approvalState.addRule({
    name: `Peek recovery high-risk approval: ${action}`,
    condition: {
      source: 'peek-recovery',
      approval_type: 'peek_recovery_high_risk',
      action,
    },
    ...overrides,
  });
}

function addRuleRequest(approvalState, taskId, rule, overrides = {}) {
  return approvalState.addRequest(taskId, {
    rule_id: rule.id,
    ...overrides,
  });
}

describe('policy-engine/adapters/approval extended', () => {
  beforeEach(() => {
    currentModules = {};
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.resetModules();
    currentModules = {};
    delete require.cache[subjectPath];
    delete require.cache[schedulingAutomationPath];
    delete require.cache[evaluationStorePath];
    delete require.cache[rollbackPath];
  });

  describe('PEEK_HIGH_RISK_APPROVAL_TYPE', () => {
    it('exports the high-risk approval type constant', () => {
      const { subject } = loadSubject();

      expect(subject.PEEK_HIGH_RISK_APPROVAL_TYPE).toBe('peek_recovery_high_risk');
    });
  });

  describe('collectApprovalEvidence', () => {
    it('reads a persisted pending request through direct lookup when policy id is absent', () => {
      const { subject, schedulingAutomation, approvalState } = loadSubject();

      approvalState.addRequest('task-direct-pending');

      expect(subject.collectApprovalEvidence({
        taskId: 'task-direct-pending',
      })).toEqual(approvalEvidence(true, false));
      expect(schedulingAutomation.getApprovalRequest).toHaveBeenCalledWith('task-direct-pending');
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
    });

    it('treats blank-status direct lookups as available but unsatisfied', () => {
      const { subject, approvalState } = loadSubject();

      approvalState.addRequest('task-direct-blank', {
        status: '   ',
      });

      expect(subject.collectApprovalEvidence({
        task_id: 'task-direct-blank',
      })).toEqual(approvalEvidence(true, false));
    });

    it('returns unavailable when history only contains requests for other policies', () => {
      const { subject, schedulingAutomation, approvalState } = loadSubject();

      const otherRule = addPolicyRule(approvalState, 'policy-other');
      addRuleRequest(approvalState, 'task-policy-miss', otherRule, {
        status: 'approved',
      });

      expect(subject.collectApprovalEvidence({
        task_id: 'task-policy-miss',
        policy_id: 'policy-target',
      })).toEqual(approvalEvidence(false, false));
      expect(schedulingAutomation.listApprovalRules).toHaveBeenCalledWith({
        enabledOnly: false,
        limit: 1000,
      });
    });

    it('matches persisted requests by rule id even when rule name is absent', () => {
      const { subject, approvalState } = loadSubject();

      const rule = addPolicyRule(approvalState, 'policy-rule-id', {
        name: null,
        project: 'Project-Rule-Id',
      });
      addRuleRequest(approvalState, 'task-rule-id', rule, {
        rule_name: null,
        status: 'approved',
      });

      expect(subject.collectApprovalEvidence({
        target: {
          id: 'task-rule-id',
          project: 'Project-Rule-Id',
        },
        policy: {
          id: 'policy-rule-id',
        },
      })).toEqual(approvalEvidence(true, true));
    });

    it('ignores high-risk rules when querying standard policy evidence', () => {
      const { subject, approvalState } = loadSubject();

      const highRiskRule = addHighRiskRule(approvalState, 'force_kill_process');
      addRuleRequest(approvalState, 'task-high-risk-only', highRiskRule, {
        status: 'approved',
      });

      expect(subject.collectApprovalEvidence({
        task_id: 'task-high-risk-only',
        policy_id: 'force_kill_process',
      })).toEqual(approvalEvidence(false, false));
    });

    it('falls back to rule-name matching when rule listing is unavailable', () => {
      const { subject, schedulingAutomation, approvalState } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: undefined,
        },
      });

      approvalState.addRequest('task-rule-name-fallback', {
        rule_name: 'Policy approval: policy-rule-name',
        status: 'approved',
      });

      expect(subject.collectApprovalEvidence({
        task_id: 'task-rule-name-fallback',
        policy_id: 'policy-rule-name',
      })).toEqual(approvalEvidence(true, true));
      expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledWith('task-rule-name-fallback');
    });

    it('ignores non-object contexts', () => {
      const { subject, schedulingAutomation } = loadSubject();

      expect(subject.collectApprovalEvidence(null)).toEqual(approvalEvidence(false, false));
      expect(subject.collectApprovalEvidence('task-direct')).toEqual(approvalEvidence(false, false));
      expect(schedulingAutomation.getApprovalRequest).not.toHaveBeenCalled();
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
    });

    it('returns unavailable when history lookup throws for policy-scoped evidence', () => {
      const { subject, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          getApprovalHistory: vi.fn(() => {
            throw new Error('history exploded');
          }),
        },
      });

      expect(subject.collectApprovalEvidence({
        task_id: 'task-history-error',
        policy_id: 'policy-history-error',
      })).toEqual(approvalEvidence(false, false));
      expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledWith('task-history-error');
    });
  });

  describe('requireApprovalForOutcome', () => {
    it('returns false for low-risk peek recovery actions', () => {
      const { subject, schedulingAutomation, evaluationStore } = loadSubject();

      expect(subject.requireApprovalForOutcome(
        {
          outcome: 'pass',
          mode: 'enforce',
        },
        {
          task_id: 'task-low-risk-peek',
          evidence: {
            peek_recovery: true,
            action: 'close_dialog',
          },
        },
      )).toBe(false);
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
      expect(evaluationStore.getPolicyEvaluation).not.toHaveBeenCalled();
    });

    it('resolves a high-risk peek action from policyOutcome.action and blocks without approval', () => {
      const { subject, schedulingAutomation } = loadSubject();

      expect(subject.requireApprovalForOutcome(
        {
          action: 'force_kill_process',
        },
        {
          task_id: 'task-action-from-policy-outcome',
          project: 'Project-Peek',
          evidence: {
            peek_recovery: true,
          },
        },
      )).toBe(true);
      expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledWith('task-action-from-policy-outcome');
    });

    it('uses direct approval request lookup when policy id is absent and the request is approved', () => {
      const { subject, schedulingAutomation, approvalState } = loadSubject();

      approvalState.addRequest('task-direct-approved', {
        status: ' approved ',
      });

      expect(subject.requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
        },
        {
          task_id: 'task-direct-approved',
        },
      )).toBe(false);
      expect(schedulingAutomation.getApprovalRequest).toHaveBeenCalledWith('task-direct-approved');
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
    });

    it('requires a fresh approval when policy id is absent and the persisted request is expired', () => {
      const { subject, approvalState } = loadSubject();

      approvalState.addRequest('task-direct-expired', {
        status: 'expired',
        expires_at: '2026-03-12T11:00:00.000Z',
      });

      expect(subject.requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
        },
        {
          task_id: 'task-direct-expired',
        },
      )).toBe(true);
    });

    it('does not treat nested policyOutcome metadata as a bypass when the top-level outcome is fail', () => {
      const { subject, schedulingAutomation, evaluationStore } = loadSubject();

      expect(subject.requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
          policy_id: 'policy-nested-override',
        },
        {
          task_id: 'task-nested-override',
          policyOutcome: {
            outcome: 'overridden',
          },
        },
      )).toBe(true);
      expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledWith('task-nested-override');
      expect(evaluationStore.getPolicyEvaluation).not.toHaveBeenCalled();
    });

    it('skips approval when the latest task evaluation outcome is overridden', () => {
      const { subject, evaluationStore, schedulingAutomation } = loadSubject({
        evaluationStore: {
          listPolicyEvaluations: vi.fn(() => [{
            id: 'eval-overridden',
            policy_id: 'policy-evaluation-override',
            outcome: 'overridden',
            latest_override: null,
          }]),
        },
      });

      expect(subject.requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
          policy_id: 'policy-evaluation-override',
        },
        {
          task_id: 'task-evaluation-override',
        },
      )).toBe(false);
      expect(evaluationStore.listPolicyEvaluations).toHaveBeenCalledWith({
        policy_id: 'policy-evaluation-override',
        target_type: 'task',
        target_id: 'task-evaluation-override',
        include_overrides: true,
        limit: 1,
      });
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
    });

    it('requires approval when task evaluation lookup returns a non-array and no request exists', () => {
      const { subject, evaluationStore, schedulingAutomation } = loadSubject({
        evaluationStore: {
          listPolicyEvaluations: vi.fn(() => ({ id: 'not-an-array' })),
        },
      });

      expect(subject.requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
          policy_id: 'policy-non-array-evaluations',
        },
        {
          task_id: 'task-non-array-evaluations',
        },
      )).toBe(true);
      expect(evaluationStore.listPolicyEvaluations).toHaveBeenCalled();
      expect(schedulingAutomation.getApprovalHistory).toHaveBeenCalledWith('task-non-array-evaluations');
    });

    it('fails closed when a policy approval request uses an unrecognized denied status', () => {
      const { subject, approvalState } = loadSubject();

      const rule = addPolicyRule(approvalState, 'policy-denied');
      addRuleRequest(approvalState, 'task-policy-denied', rule, {
        status: 'denied',
      });

      expect(subject.requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
          policy_id: 'policy-denied',
        },
        {
          task_id: 'task-policy-denied',
        },
      )).toBe(true);
    });

    it('fails closed when a high-risk approval request uses an unrecognized denied status', () => {
      const { subject, approvalState } = loadSubject();

      const rule = addHighRiskRule(approvalState, 'force_kill_process', {
        project: 'Project-Peek',
      });
      addRuleRequest(approvalState, 'task-high-risk-denied', rule, {
        status: 'denied',
      });

      expect(subject.requireApprovalForOutcome(
        {},
        {
          task_id: 'task-high-risk-denied',
          project: 'Project-Peek',
          evidence: {
            peek_recovery: true,
            action: 'force_kill_process',
          },
        },
      )).toBe(true);
    });

    it('matches high-risk requests by rule condition when the persisted request has no rule name', () => {
      const { subject, schedulingAutomation, approvalState } = loadSubject();

      const rule = addHighRiskRule(approvalState, 'force_kill_process', {
        name: null,
        project: 'Project-Condition',
      });
      addRuleRequest(approvalState, 'task-high-risk-condition', rule, {
        rule_name: null,
        status: 'pending',
      });

      expect(subject.requireApprovalForOutcome(
        {},
        {
          task_id: 'task-high-risk-condition',
          project: 'Project-Condition',
          evidence: {
            peek_recovery: true,
            action_name: 'force_kill_process',
          },
        },
      )).toBe(false);
      expect(schedulingAutomation.listApprovalRules).toHaveBeenCalledWith({
        enabledOnly: false,
        limit: 1000,
        project: 'Project-Condition',
      });
    });

    it('fails closed for warn failures without a task id or override metadata', () => {
      const { subject, schedulingAutomation } = loadSubject();

      expect(subject.requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
          policy_id: 'policy-no-task',
        },
        {
          project: 'Project-No-Task',
        },
      )).toBe(true);
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
    });

    it('resolves project from nested target.project when evaluating persisted policy approvals', () => {
      const { subject, schedulingAutomation, approvalState } = loadSubject();

      const rule = addPolicyRule(approvalState, 'policy-target-project', {
        project: 'Project-Target',
      });
      addRuleRequest(approvalState, 'task-target-project', rule, {
        status: 'approved',
      });

      expect(subject.requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
          policy_id: 'policy-target-project',
        },
        {
          target: {
            id: 'task-target-project',
            project: 'Project-Target',
          },
        },
      )).toBe(false);
      expect(schedulingAutomation.listApprovalRules).toHaveBeenCalledWith({
        enabledOnly: false,
        limit: 1000,
        project: 'Project-Target',
      });
    });

    it('falls back to the standard warn-failure path for non-high-risk peek actions', () => {
      const { subject, schedulingAutomation, approvalState } = loadSubject();

      approvalState.addRequest('task-low-risk-standard', {
        status: 'approved',
      });

      expect(subject.requireApprovalForOutcome(
        {
          outcome: 'fail',
          mode: 'warn',
        },
        {
          task_id: 'task-low-risk-standard',
          evidence: {
            peek_recovery: true,
            action: 'close_dialog',
          },
        },
      )).toBe(false);
      expect(schedulingAutomation.getApprovalRequest).toHaveBeenCalledWith('task-low-risk-standard');
    });
  });

  describe('requireHighRiskApproval', () => {
    it('treats blank actions as not requiring approval', () => {
      const { subject, schedulingAutomation } = loadSubject();

      expect(subject.requireHighRiskApproval('   ', {
        task_id: 'task-blank-action',
      })).toEqual({
        approved: true,
        approval_id: null,
        reason: 'Approval not required',
      });
      expect(schedulingAutomation.getApprovalHistory).not.toHaveBeenCalled();
    });

    it('grants approval when a persisted approved request matches by rule condition', () => {
      const { subject, approvalState } = loadSubject();

      const rule = addHighRiskRule(approvalState, 'modify_registry_key', {
        name: null,
        project: 'Project-Rule-Condition',
      });
      addRuleRequest(approvalState, 'task-rule-condition', rule, {
        rule_name: null,
        status: 'approved',
      });

      expect(subject.requireHighRiskApproval('modify_registry_key', {
        task_id: 'task-rule-condition',
        project: 'Project-Rule-Condition',
      })).toEqual({
        approved: true,
        approval_id: 'request-1',
        reason: 'Approval granted',
      });
    });

    it('blocks when a persisted high-risk request is rejected', () => {
      const { subject, approvalState } = loadSubject();

      const rule = addHighRiskRule(approvalState, 'force_kill_process');
      addRuleRequest(approvalState, 'task-high-risk-rejected', rule, {
        status: 'rejected',
      });

      expect(subject.requireHighRiskApproval('force_kill_process', {
        task_id: 'task-high-risk-rejected',
      })).toEqual({
        approved: false,
        approval_id: 'request-1',
        reason: 'High-risk action requires approval',
      });
    });

    it('blocks when a persisted high-risk request is expired', () => {
      const { subject, approvalState } = loadSubject();

      const rule = addHighRiskRule(approvalState, 'force_kill_process');
      addRuleRequest(approvalState, 'task-high-risk-expired', rule, {
        status: 'expired',
        expires_at: '2026-03-12T09:00:00.000Z',
      });

      expect(subject.requireHighRiskApproval('force_kill_process', {
        task_id: 'task-high-risk-expired',
      })).toEqual({
        approved: false,
        approval_id: 'request-1',
        reason: 'High-risk action requires approval',
      });
    });

    it('creates and persists a request using project resolved from target.project', () => {
      const { subject, schedulingAutomation, approvalState } = loadSubject();

      const result = subject.requireHighRiskApproval('force_kill_process', {
        target: {
          id: 'task-target-project-create',
          project: 'Project-Target-Create',
        },
      });

      expect(result).toEqual({
        approved: false,
        approval_id: 'request-1',
        reason: 'High-risk action requires approval',
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
          project: 'Project-Target-Create',
        },
      );
      expect(approvalState.getRequests('task-target-project-create')).toHaveLength(1);
    });

    it('does not create duplicate requests when a pending approval already exists', () => {
      const { subject, schedulingAutomation } = loadSubject();

      const first = subject.requireHighRiskApproval('force_kill_process', {
        task_id: 'task-no-duplicate',
        project: 'Project-No-Duplicate',
      });
      const second = subject.requireHighRiskApproval('force_kill_process', {
        task_id: 'task-no-duplicate',
        project: 'Project-No-Duplicate',
      });

      expect(first).toEqual({
        approved: false,
        approval_id: 'request-1',
        reason: 'High-risk action requires approval',
      });
      expect(second).toEqual({
        approved: false,
        approval_id: 'request-1',
        reason: 'High-risk action requires approval',
      });
      expect(schedulingAutomation.createApprovalRequest).toHaveBeenCalledTimes(1);
    });

    it('returns granted after a persisted high-risk request is manually approved', () => {
      const { subject, approvalState } = loadSubject();

      subject.requireHighRiskApproval('force_kill_process', {
        task_id: 'task-approved-later',
      });
      approvalState.updateRequest('task-approved-later', 'request-1', {
        status: 'approved',
      });

      expect(subject.requireHighRiskApproval('force_kill_process', {
        task_id: 'task-approved-later',
      })).toEqual({
        approved: true,
        approval_id: 'request-1',
        reason: 'Approval granted',
      });
    });

    it('remains blocked after a persisted high-risk request is manually rejected', () => {
      const { subject, approvalState } = loadSubject();

      subject.requireHighRiskApproval('force_kill_process', {
        task_id: 'task-rejected-later',
      });
      approvalState.updateRequest('task-rejected-later', 'request-1', {
        status: 'rejected',
      });

      expect(subject.requireHighRiskApproval('force_kill_process', {
        task_id: 'task-rejected-later',
      })).toEqual({
        approved: false,
        approval_id: 'request-1',
        reason: 'High-risk action requires approval',
      });
    });

    it('propagates attachment failures when approval rules cannot be created', () => {
      const { subject } = loadSubject({
        schedulingAutomation: {
          createApprovalRule: undefined,
        },
      });

      expect(() => subject.requireHighRiskApproval('force_kill_process', {
        task_id: 'task-attach-failure',
      })).toThrow('approval rule creation is unavailable');
    });

    it('fails closed when a newly created request cannot be resolved to a usable id', () => {
      const { subject, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          createApprovalRequest: vi.fn(() => '   '),
          getApprovalHistory: vi.fn(() => []),
        },
      });

      expect(subject.requireHighRiskApproval('force_kill_process', {
        task_id: 'task-blank-request-id',
      })).toEqual({
        approved: false,
        approval_id: null,
        reason: 'High-risk action requires approval',
      });
      expect(schedulingAutomation.createApprovalRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('attachApprovalRequest', () => {
    it('bypasses attachment when override_recorded is explicitly true', () => {
      const { subject, schedulingAutomation } = loadSubject();

      expect(subject.attachApprovalRequest('task-override-recorded', 'policy-override-recorded', {
        context: {
          override_recorded: true,
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

    it('bypasses attachment when the evaluation store already reports a matching override', () => {
      const { subject, evaluationStore, schedulingAutomation } = loadSubject({
        evaluationStore: {
          getPolicyEvaluation: vi.fn(() => ({
            id: 'eval-existing-override',
            policy_id: 'policy-eval-bypass',
            outcome: 'fail',
            latest_override: {
              id: 'override-1',
            },
          })),
        },
      });

      expect(subject.attachApprovalRequest('task-eval-bypass', 'policy-eval-bypass', {
        context: {
          evaluation_id: 'eval-existing-override',
        },
      })).toEqual({
        attached: false,
        bypassed: true,
        request_id: null,
        rule_id: null,
      });
      expect(evaluationStore.getPolicyEvaluation).toHaveBeenCalledWith('eval-existing-override', {
        include_overrides: true,
      });
      expect(schedulingAutomation.createApprovalRule).not.toHaveBeenCalled();
    });

    it('reuses an existing rule when it matches by condition instead of name', () => {
      const { subject, schedulingAutomation, approvalState } = loadSubject();

      const rule = addPolicyRule(approvalState, 'policy-condition-match', {
        name: null,
      });

      expect(subject.attachApprovalRequest('task-condition-match', 'policy-condition-match')).toEqual({
        attached: true,
        bypassed: false,
        request_id: 'request-1',
        rule_id: rule.id,
      });
      expect(schedulingAutomation.createApprovalRule).not.toHaveBeenCalled();
    });

    it('creates a new rule when rule listing throws', () => {
      const { subject, schedulingAutomation } = loadSubject({
        schedulingAutomation: {
          listApprovalRules: vi.fn(() => {
            throw new Error('rules unavailable');
          }),
        },
      });

      expect(subject.attachApprovalRequest('task-rule-error', 'policy-rule-error')).toEqual({
        attached: true,
        bypassed: false,
        request_id: 'request-1',
        rule_id: 'rule-1',
      });
      expect(schedulingAutomation.createApprovalRule).toHaveBeenCalledTimes(1);
    });

    it('preserves zero-valued scheduler options when creating a rule', () => {
      const { subject, schedulingAutomation } = loadSubject();

      subject.attachApprovalRequest('task-zero-options', 'policy-zero-options', {
        requiredApprovers: 0,
        autoApproveAfterMinutes: 0,
      });

      expect(schedulingAutomation.createApprovalRule).toHaveBeenCalledWith(
        'Policy approval: policy-zero-options',
        'keyword',
        {
          source: 'policy-engine',
          policy_id: 'policy-zero-options',
          manual_only: true,
          keywords: ['__torque_policy_approval__:policy-zero-options'],
        },
        {
          requiredApprovers: 0,
          autoApproveAfterMinutes: 0,
        },
      );
    });

    it('resolves the project from policyOutcome.task.project when creating a rule', () => {
      const { subject, schedulingAutomation } = loadSubject();

      subject.attachApprovalRequest('task-project-from-outcome', 'policy-project-from-outcome', {
        policyOutcome: {
          task: {
            project: 'Project-From-Outcome',
          },
        },
      });

      expect(schedulingAutomation.createApprovalRule).toHaveBeenCalledWith(
        'Policy approval: policy-project-from-outcome',
        'keyword',
        {
          source: 'policy-engine',
          policy_id: 'policy-project-from-outcome',
          manual_only: true,
          keywords: ['__torque_policy_approval__:policy-project-from-outcome'],
        },
        {
          project: 'Project-From-Outcome',
        },
      );
    });

    it('supports the approval_type option key for high-risk approval requests', () => {
      const { subject, schedulingAutomation } = loadSubject();

      expect(subject.attachApprovalRequest('task-high-risk-type-key', 'inject_accessibility_hook', {
        approval_type: 'peek_recovery_high_risk',
        context: {
          project: 'Project-Type-Key',
        },
      })).toEqual({
        attached: true,
        bypassed: false,
        request_id: 'request-1',
        rule_id: 'rule-1',
      });
      expect(schedulingAutomation.createApprovalRule).toHaveBeenCalledWith(
        'Peek recovery high-risk approval: inject_accessibility_hook',
        'keyword',
        {
          source: 'peek-recovery',
          approval_type: 'peek_recovery_high_risk',
          action: 'inject_accessibility_hook',
          manual_only: true,
          keywords: ['__torque_peek_recovery_high_risk__:inject_accessibility_hook'],
        },
        {
          project: 'Project-Type-Key',
        },
      );
    });

    it('throws when the resolved approval rule object has an empty id', () => {
      const { subject } = loadSubject({
        schedulingAutomation: {
          getApprovalRule: vi.fn(() => ({
            id: '',
            name: 'rule-with-empty-id',
          })),
        },
      });

      expect(() => subject.attachApprovalRequest('task-empty-rule-id', 'policy-empty-rule-id')).toThrow(
        'Unable to resolve approval rule for policy policy-empty-rule-id',
      );
    });

    it('persists created approval requests into history that can be queried later', () => {
      const { subject, approvalState } = loadSubject();

      const attachment = subject.attachApprovalRequest(' task-persisted ', ' policy-persisted ', {
        project: 'Project-Persisted',
      });

      expect(attachment).toEqual({
        attached: true,
        bypassed: false,
        request_id: 'request-1',
        rule_id: 'rule-1',
      });
      expect(approvalState.getRequests('task-persisted')).toEqual([{
        id: 'request-1',
        task_id: 'task-persisted',
        rule_id: 'rule-1',
        rule_name: 'Policy approval: policy-persisted',
        status: 'pending',
        expires_at: null,
      }]);
      expect(subject.collectApprovalEvidence({
        task_id: 'task-persisted',
        policy_id: 'policy-persisted',
        project: 'Project-Persisted',
      })).toEqual(approvalEvidence(true, false));
    });

    it('does not bypass when override_recorded is explicitly false', () => {
      const { subject, schedulingAutomation } = loadSubject();

      expect(subject.attachApprovalRequest('task-false-override', 'policy-false-override', {
        context: {
          override_recorded: ' false ',
        },
      })).toEqual({
        attached: true,
        bypassed: false,
        request_id: 'request-1',
        rule_id: 'rule-1',
      });
      expect(schedulingAutomation.createApprovalRequest).toHaveBeenCalledWith(
        'task-false-override',
        'rule-1',
      );
    });
  });
});
