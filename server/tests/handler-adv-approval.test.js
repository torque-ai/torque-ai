const validationRules = require('../db/validation-rules');
const schedulingAutomation = require('../db/scheduling-automation');

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/advanced/approval')];
  return require('../handlers/advanced/approval');
}

const handlers = new Proxy({}, {
  get(_target, prop) {
    return loadHandlers()[prop];
  },
});

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

describe('handler:adv-approval', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('handleAddApprovalRule', () => {
    it('returns INVALID_PARAM for unknown rule_type', () => {
      const result = handlers.handleAddApprovalRule({
        name: 'Rule 1',
        description: 'desc',
        rule_type: 'unknown_type'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('rule_type must be one of');
    });

    it('returns MISSING_REQUIRED_PARAM when required fields are absent', () => {
      const result = handlers.handleAddApprovalRule({
        description: 'missing name',
        rule_type: 'all'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('name, description, and rule_type are required');
    });

    it('saves approval rule with default auto_reject and null condition', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
      const saveSpy = vi.spyOn(validationRules, 'saveApprovalRule').mockReturnValue(undefined);

      const result = handlers.handleAddApprovalRule({
        name: 'Directory Gate',
        description: 'Require review for src/',
        rule_type: 'directory'
      });

      expect(saveSpy).toHaveBeenCalledWith({
        id: 'apr-1700000000000',
        name: 'Directory Gate',
        description: 'Require review for src/',
        rule_type: 'directory',
        condition: null,
        auto_reject: false
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Approval Rule Added');
      expect(textOf(result)).toContain('Auto-Reject:** No');
    });

    it('supports auto_reject=true and includes it in output', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1700000001234);
      vi.spyOn(validationRules, 'saveApprovalRule').mockReturnValue(undefined);

      const result = handlers.handleAddApprovalRule({
        name: 'Keyword Block',
        description: 'Reject dangerous terms',
        rule_type: 'keyword',
        condition: 'rm -rf',
        auto_reject: true
      });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('apr-1700000001234');
      expect(textOf(result)).toContain('Auto-Reject:** Yes');
    });
  });

  describe('handleListApprovalRules', () => {
    it('returns empty-state message when no rules exist', () => {
      const getRulesSpy = vi.spyOn(validationRules, 'getApprovalRules').mockReturnValue([]);

      const result = handlers.handleListApprovalRules({});

      expect(getRulesSpy).toHaveBeenCalledWith(true);
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('No approval rules found');
    });

    it('passes enabled_only=false to database query', () => {
      const getRulesSpy = vi.spyOn(validationRules, 'getApprovalRules').mockReturnValue([]);

      handlers.handleListApprovalRules({ enabled_only: false });

      expect(getRulesSpy).toHaveBeenCalledWith(false);
    });

    it('renders approval rules table with enabled and auto-reject markers', () => {
      vi.spyOn(validationRules, 'getApprovalRules').mockReturnValue([
        {
          id: 'r1',
          name: 'Rule A',
          rule_type: 'directory',
          auto_reject: true,
          enabled: true
        },
        {
          id: 'r2',
          name: 'Rule B',
          rule_type: 'all',
          auto_reject: false,
          enabled: false
        }
      ]);

      const result = handlers.handleListApprovalRules({});
      const text = textOf(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('## Approval Rules');
      expect(text).toContain('| Rule A | directory | ✓ | ✓ |');
      expect(text).toContain('| Rule B | all | - | ✗ |');
    });
  });

  describe('handleApproveTask', () => {
    it('returns MISSING_REQUIRED_PARAM when approval_id is missing', () => {
      const result = handlers.handleApproveTask({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('approval_id is required');
    });

    it('passes user actor and null notes when no notes are provided', () => {
      const decideSpy = vi.spyOn(validationRules, 'decideApproval').mockReturnValue(null);

      const result = handlers.handleApproveTask({ approval_id: 'appr-1' });

      expect(decideSpy).toHaveBeenCalledWith('appr-1', true, 'user', null);
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Approved ✓');
      expect(textOf(result)).toContain('Approval appr-1 has been approved');
    });

    it('includes notes in approval decision and output', () => {
      const decideSpy = vi.spyOn(validationRules, 'decideApproval').mockReturnValue(null);

      const result = handlers.handleApproveTask({
        approval_id: 'appr-2',
        notes: 'Looks safe'
      });

      expect(decideSpy).toHaveBeenCalledWith('appr-2', true, 'user', 'Looks safe');
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Notes: Looks safe');
    });

    it('returns OPERATION_FAILED when decision backend reports error', () => {
      vi.spyOn(validationRules, 'decideApproval').mockReturnValue({ error: 'already decided' });

      const result = handlers.handleApproveTask({ approval_id: 'appr-3' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain('Approval failed: already decided');
    });
  });

  describe('handleListPendingApprovals', () => {
    it('renders empty-state without task suffix when task_id is not provided', () => {
      vi.spyOn(validationRules, 'getPendingApprovals').mockReturnValue([]);

      const result = handlers.handleListPendingApprovals({});

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('No pending approvals.');
    });

    it('renders empty-state with task suffix when task_id is provided', () => {
      vi.spyOn(validationRules, 'getPendingApprovals').mockReturnValue([]);

      const result = handlers.handleListPendingApprovals({ task_id: 'task-7' });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('No pending approvals for task task-7.');
    });

    it('lists pending approvals with task/rule/reason details', () => {
      vi.spyOn(validationRules, 'getPendingApprovals').mockReturnValue([
        {
          id: 'pa-1',
          task_id: 'task-1',
          rule_name: 'Directory Gate',
          reason: 'Touched production path',
          created_at: '2026-01-01T00:00:00.000Z'
        },
        {
          id: 'pa-2',
          task_id: 'task-2',
          rule_name: 'Keyword Gate',
          reason: 'Contains deploy keyword',
          created_at: '2026-01-02T00:00:00.000Z'
        }
      ]);

      const result = handlers.handleListPendingApprovals({});
      const text = textOf(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('## Pending Approvals');
      expect(text).toContain('### pa-1');
      expect(text).toContain('### pa-2');
      expect(text).toContain('Directory Gate');
      expect(text).toContain('Contains deploy keyword');
    });
  });

  describe('handleGetAuditLog', () => {
    it('returns empty-state when no audit entries match', () => {
      vi.spyOn(schedulingAutomation, 'getAuditLog').mockReturnValue([]);
      vi.spyOn(schedulingAutomation, 'getAuditLogCount').mockReturnValue(0);

      const result = handlers.handleGetAuditLog({});

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('No audit entries found matching the criteria.');
    });

    it('passes filter and pagination options to database queries', () => {
      const getAuditLogSpy = vi.spyOn(schedulingAutomation, 'getAuditLog').mockReturnValue([
        {
          timestamp: '2026-01-01T01:00:00.000Z',
          entity_type: 'task',
          entity_id: 'task-123456789',
          action: 'updated',
          actor: 'user',
          new_value: 'value'
        }
      ]);
      const getCountSpy = vi.spyOn(schedulingAutomation, 'getAuditLogCount').mockReturnValue(12);

      handlers.handleGetAuditLog({
        entity_type: 'task',
        entity_id: 'task-123456789',
        action: 'updated',
        actor: 'user',
        start_date: '2026-01-01',
        end_date: '2026-01-02',
        limit: 10,
        offset: 5
      });

      expect(getAuditLogSpy).toHaveBeenCalledWith({
        entityType: 'task',
        entityId: 'task-123456789',
        action: 'updated',
        actor: 'user',
        since: '2026-01-01',
        until: '2026-01-02',
        limit: 10,
        offset: 5
      });
      expect(getCountSpy).toHaveBeenCalledWith({
        entityType: 'task',
        entityId: 'task-123456789',
        action: 'updated',
        actor: 'user',
        since: '2026-01-01',
        until: '2026-01-02'
      });
    });

    it('renders row details with truncation and offset indicator', () => {
      vi.spyOn(schedulingAutomation, 'getAuditLog').mockReturnValue([
        {
          timestamp: '2026-01-01T01:00:00.000Z',
          entity_type: null,
          entity_id: null,
          action: 'updated',
          actor: 'admin',
          new_value: '0123456789012345678901234567890123456789'
        }
      ]);
      vi.spyOn(schedulingAutomation, 'getAuditLogCount').mockReturnValue(99);

      const result = handlers.handleGetAuditLog({ offset: 2 });
      const text = textOf(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('## Audit Log');
      expect(text).toContain('| ?: | updated | admin | 012345678901234567890123456789...');
      expect(text).toContain('**Showing:** 1 of 99 entries (offset: 2)');
    });

    it('omits offset suffix when offset is zero', () => {
      vi.spyOn(schedulingAutomation, 'getAuditLog').mockReturnValue([
        {
          timestamp: '2026-01-01T01:00:00.000Z',
          entity_type: 'task',
          entity_id: 'task-1',
          action: 'created',
          actor: 'system',
          new_value: null
        }
      ]);
      vi.spyOn(schedulingAutomation, 'getAuditLogCount').mockReturnValue(1);

      const result = handlers.handleGetAuditLog({ offset: 0 });

      expect(textOf(result)).toContain('**Showing:** 1 of 1 entries');
      expect(textOf(result)).not.toContain('(offset:');
    });
  });

  describe('handleExportAuditReport', () => {
    it('returns no-data message when export query is empty', () => {
      vi.spyOn(schedulingAutomation, 'getAuditLog').mockReturnValue([]);

      const result = handlers.handleExportAuditReport({});

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('No audit entries found for the specified criteria.');
    });

    it('exports CSV report and escapes quote characters', () => {
      vi.spyOn(schedulingAutomation, 'getAuditLog').mockReturnValue([
        {
          id: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          entity_type: 'task',
          entity_id: 'task-1',
          action: 'updated',
          actor: 'admin',
          old_value: 'old "quoted"',
          new_value: 'new "quoted"'
        }
      ]);
      vi.spyOn(schedulingAutomation, 'getAuditStats').mockReturnValue({ total: 1, byEntity: [], byActor: [] });

      const result = handlers.handleExportAuditReport({ format: 'csv' });
      const text = textOf(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Audit Report (CSV)');
      expect(text).toContain('id,timestamp,entity_type,entity_id,action,actor,old_value,new_value');
      expect(text).toContain('"old ""quoted"""');
      expect(text).toContain('"new ""quoted"""');
    });

    it('exports JSON report with stats and truncation note for large datasets', () => {
      const rows = Array.from({ length: 55 }, (_, i) => ({
        id: i + 1,
        timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        entity_type: 'task',
        entity_id: `task-${i}`,
        action: i % 2 === 0 ? 'created' : 'updated',
        actor: 'system',
        old_value: null,
        new_value: `value-${i}`
      }));

      vi.spyOn(schedulingAutomation, 'getAuditLog').mockReturnValue(rows);
      vi.spyOn(schedulingAutomation, 'getAuditStats').mockReturnValue({
        total: 55,
        byEntity: [{ entity_type: 'task', count: 55 }],
        byActor: [{ actor: 'system', count: 55 }],
        byAction: [
          { action: 'created', count: 28 },
          { action: 'updated', count: 27 }
        ]
      });

      const result = handlers.handleExportAuditReport({});
      const text = textOf(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Audit Report (JSON)');
      expect(text).toContain('| Total Actions | 55 |');
      expect(text).toContain('**created:** 28');
      expect(text).toContain('// ... 5 more entries');
    });
  });

  describe('handleConfigureAudit', () => {
    it('returns current settings and stats when no updates are provided', () => {
      vi.spyOn(schedulingAutomation, 'getAllAuditConfig').mockReturnValue({
        retention_days: '30',
        track_reads: 'true',
        track_config_changes: 'true',
        track_task_operations: 'true'
      });
      vi.spyOn(schedulingAutomation, 'getAuditStats').mockReturnValue({
        total: 4,
        byEntity: [{ entity_type: 'task', count: 2 }],
        byActor: [{ actor: 'user', count: 2 }]
      });

      const result = handlers.handleConfigureAudit({});
      const text = textOf(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('## Audit Configuration');
      expect(text).toContain('| retention_days | 30 |');
      expect(text).toContain('### Audit Statistics');
      expect(text).toContain('**Total logged actions:** 4');
    });

    it('persists provided settings as strings and lists updated values', () => {
      const setSpy = vi.spyOn(schedulingAutomation, 'setAuditConfig').mockReturnValue(undefined);
      vi.spyOn(schedulingAutomation, 'getAllAuditConfig').mockReturnValue({
        retention_days: '14',
        track_reads: 'false',
        track_config_changes: 'false',
        track_task_operations: 'true'
      });
      vi.spyOn(schedulingAutomation, 'getAuditStats').mockReturnValue({
        total: 0,
        byEntity: [],
        byActor: []
      });

      const result = handlers.handleConfigureAudit({
        retention_days: 14,
        track_reads: false,
        track_config_changes: false,
        track_task_operations: true
      });

      expect(setSpy).toHaveBeenCalledWith('retention_days', '14');
      expect(setSpy).toHaveBeenCalledWith('track_reads', 'false');
      expect(setSpy).toHaveBeenCalledWith('track_config_changes', 'false');
      expect(setSpy).toHaveBeenCalledWith('track_task_operations', 'true');
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('retention_days = 14');
      expect(textOf(result)).toContain('track_reads = false');
      expect(textOf(result)).toContain('track_task_operations = true');
    });
  });
});
