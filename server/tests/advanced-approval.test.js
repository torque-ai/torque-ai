'use strict';

// require.cache manipulation is intentionally used here rather than vi.mock().
// The database module (database.js) re-exports functions defined in sub-modules
// (e.g. db/validation-rules.js) that hold a reference to the internal SQLite
// connection, not to the exported object. vi.mock('../database') replaces the
// require() return value but cannot intercept those internal references, so the
// real sub-module functions still run against the uninitialized SQLite connection
// (db = null) and throw. installMock() directly patches require.cache so the
// handler picks up mockDb when it first loads. The handler cache entry is evicted
// on every beforeEach so it reloads and re-binds to the fresh mock.

const realShared = require('../handlers/shared');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const mockDb = {
  saveApprovalRule: vi.fn(),
  getApprovalRules: vi.fn(),
  decideApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  getAuditLog: vi.fn(),
  getAuditLogCount: vi.fn(),
  getAuditStats: vi.fn(),
  setAuditConfig: vi.fn(),
  getAllAuditConfig: vi.fn(),
};

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/advanced/approval')];
  installMock('../database', mockDb);
  installMock('../handlers/shared', realShared);
  return require('../handlers/advanced/approval');
}

function resetMockDefaults() {
  for (const fn of Object.values(mockDb)) {
    if (typeof fn?.mockReset === 'function') {
      fn.mockReset();
    }
  }

  mockDb.saveApprovalRule.mockReturnValue(undefined);
  mockDb.getApprovalRules.mockReturnValue([]);
  mockDb.decideApproval.mockReturnValue(null);
  mockDb.getPendingApprovals.mockReturnValue([]);
  mockDb.getAuditLog.mockReturnValue([]);
  mockDb.getAuditLogCount.mockReturnValue(0);
  mockDb.getAuditStats.mockReturnValue({
    total: 0,
    byEntity: [],
    byActor: [],
    byAction: [],
  });
  mockDb.setAuditConfig.mockReturnValue(undefined);
  mockDb.getAllAuditConfig.mockReturnValue({
    retention_days: '30',
    track_reads: 'false',
    track_config_changes: 'true',
    track_task_operations: 'true',
  });
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('advanced/approval handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleAddApprovalRule', () => {
    it('returns MISSING_REQUIRED_PARAM when required fields are missing', () => {
      const result = handlers.handleAddApprovalRule({
        description: 'Require review',
        rule_type: 'directory',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('name, description, and rule_type are required');
      expect(mockDb.saveApprovalRule).not.toHaveBeenCalled();
    });

    it('returns INVALID_PARAM for an unknown rule_type', () => {
      const result = handlers.handleAddApprovalRule({
        name: 'Unknown Gate',
        description: 'Bad type',
        rule_type: 'unsupported',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('rule_type must be one of');
      expect(mockDb.saveApprovalRule).not.toHaveBeenCalled();
    });

    it('saves the rule and renders the new approval rule details', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);

      const result = handlers.handleAddApprovalRule({
        name: 'Directory Gate',
        description: 'Require review for src/',
        rule_type: 'directory',
        auto_reject: true,
      });

      expect(mockDb.saveApprovalRule).toHaveBeenCalledWith({
        id: 'apr-1700000000000',
        name: 'Directory Gate',
        description: 'Require review for src/',
        rule_type: 'directory',
        condition: null,
        auto_reject: true,
      });
      expect(getText(result)).toContain('Approval Rule Added');
      expect(getText(result)).toContain('apr-1700000000000');
      expect(getText(result)).toContain('Directory Gate');
      expect(getText(result)).toContain('Auto-Reject:** Yes');
    });
  });

  describe('handleListApprovalRules', () => {
    it('returns an empty state when no rules are available', () => {
      const result = handlers.handleListApprovalRules({});

      expect(mockDb.getApprovalRules).toHaveBeenCalledWith(true);
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No approval rules found');
    });

    it('renders the approval rules table', () => {
      mockDb.getApprovalRules.mockReturnValue([
        {
          name: 'Rule A',
          rule_type: 'directory',
          auto_reject: true,
          enabled: true,
        },
        {
          name: 'Rule B',
          rule_type: 'keyword',
          auto_reject: false,
          enabled: false,
        },
      ]);

      const result = handlers.handleListApprovalRules({ enabled_only: false });
      const text = getText(result);

      expect(mockDb.getApprovalRules).toHaveBeenCalledWith(false);
      expect(text).toContain('## Approval Rules');
      expect(text).toContain('| Rule A | directory | ✓ | ✓ |');
      expect(text).toContain('| Rule B | keyword | - | ✗ |');
    });
  });

  describe('handleApproveTask', () => {
    it('returns MISSING_REQUIRED_PARAM when approval_id is missing', () => {
      const result = handlers.handleApproveTask({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('approval_id is required');
      expect(mockDb.decideApproval).not.toHaveBeenCalled();
    });

    it('returns OPERATION_FAILED when the backend reports a missing approval', () => {
      mockDb.decideApproval.mockReturnValue({ error: 'approval not found' });

      const result = handlers.handleApproveTask({ approval_id: 'apr-missing' });

      expect(mockDb.decideApproval).toHaveBeenCalledWith('apr-missing', true, 'user', null);
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(getText(result)).toContain('Approval failed: approval not found');
    });

    it('approves the task and includes notes in the response', () => {
      const result = handlers.handleApproveTask({
        approval_id: 'apr-1',
        notes: 'Looks good',
      });

      expect(mockDb.decideApproval).toHaveBeenCalledWith('apr-1', true, 'user', 'Looks good');
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Approved');
      expect(getText(result)).toContain('Approval apr-1 has been approved.');
      expect(getText(result)).toContain('Notes: Looks good');
    });
  });

  describe('handleListPendingApprovals', () => {
    it('returns an empty state when no pending approvals exist for a task', () => {
      const result = handlers.handleListPendingApprovals({ task_id: 'task-1' });

      expect(mockDb.getPendingApprovals).toHaveBeenCalledWith('task-1');
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No pending approvals for task task-1.');
    });

    it('renders pending approval details', () => {
      mockDb.getPendingApprovals.mockReturnValue([
        {
          id: 'pa-1',
          task_id: 'task-1',
          rule_name: 'Directory Gate',
          reason: 'Touched protected path',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ]);

      const result = handlers.handleListPendingApprovals({});
      const text = getText(result);

      expect(mockDb.getPendingApprovals).toHaveBeenCalledWith(undefined);
      expect(text).toContain('## Pending Approvals');
      expect(text).toContain('### pa-1');
      expect(text).toContain('**Task:** task-1');
      expect(text).toContain('**Rule:** Directory Gate');
      expect(text).toContain('**Reason:** Touched protected path');
    });
  });

  describe('handleGetAuditLog', () => {
    it('returns an empty state when no audit entries match', () => {
      const result = handlers.handleGetAuditLog({});

      expect(mockDb.getAuditLog).toHaveBeenCalledWith({
        entityType: undefined,
        entityId: undefined,
        action: undefined,
        actor: undefined,
        since: undefined,
        until: undefined,
        limit: 100,
        offset: 0,
      });
      expect(mockDb.getAuditLogCount).toHaveBeenCalledWith({
        entityType: undefined,
        entityId: undefined,
        action: undefined,
        actor: undefined,
        since: undefined,
        until: undefined,
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No audit entries found matching the criteria.');
    });

    it('passes filters through and renders table rows with truncation and offset', () => {
      vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Mock Local Time');
      mockDb.getAuditLog.mockReturnValue([
        {
          timestamp: '2026-01-01T01:00:00.000Z',
          entity_type: 'task',
          entity_id: 'task-123456789',
          action: 'updated',
          actor: 'admin',
          new_value: '0123456789012345678901234567890123456789',
        },
      ]);
      mockDb.getAuditLogCount.mockReturnValue(7);

      const result = handlers.handleGetAuditLog({
        entity_type: 'task',
        entity_id: 'task-123456789',
        action: 'updated',
        actor: 'admin',
        start_date: '2026-01-01',
        end_date: '2026-01-02',
        limit: 5,
        offset: 2,
      });
      const text = getText(result);

      expect(mockDb.getAuditLog).toHaveBeenCalledWith({
        entityType: 'task',
        entityId: 'task-123456789',
        action: 'updated',
        actor: 'admin',
        since: '2026-01-01',
        until: '2026-01-02',
        limit: 5,
        offset: 2,
      });
      expect(mockDb.getAuditLogCount).toHaveBeenCalledWith({
        entityType: 'task',
        entityId: 'task-123456789',
        action: 'updated',
        actor: 'admin',
        since: '2026-01-01',
        until: '2026-01-02',
      });
      expect(text).toContain('## Audit Log');
      expect(text).toContain('| Mock Local Time | task:task-123 | updated | admin | 012345678901234567890123456789... |');
      expect(text).toContain('**Showing:** 1 of 7 entries (offset: 2)');
    });
  });

  describe('handleExportAuditReport', () => {
    it('returns a no-data message when there are no audit rows to export', () => {
      const result = handlers.handleExportAuditReport({});

      expect(mockDb.getAuditLog).toHaveBeenCalledWith({
        since: undefined,
        until: undefined,
        entityType: undefined,
        limit: 10000,
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No audit entries found for the specified criteria.');
    });

    it('exports the report in csv format and escapes quotes', () => {
      mockDb.getAuditLog.mockReturnValue([
        {
          id: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          entity_type: 'task',
          entity_id: 'task-1',
          action: 'updated',
          actor: 'admin',
          old_value: 'old "quoted"',
          new_value: 'new "quoted"',
        },
      ]);

      const result = handlers.handleExportAuditReport({
        format: 'csv',
        start_date: '2026-01-01',
        end_date: '2026-01-31',
        entity_type: 'task',
      });
      const text = getText(result);

      expect(mockDb.getAuditStats).toHaveBeenCalledWith({
        since: '2026-01-01',
        until: '2026-01-31',
      });
      expect(text).toContain('Audit Report (CSV)');
      expect(text).toContain('id,timestamp,entity_type,entity_id,action,actor,old_value,new_value');
      expect(text).toContain('"old ""quoted"""');
      expect(text).toContain('"new ""quoted"""');
    });

    it('exports the report in json format with statistics and truncation note', () => {
      const rows = Array.from({ length: 55 }, (_, index) => ({
        id: index + 1,
        timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        entity_type: 'task',
        entity_id: `task-${index}`,
        action: index % 2 === 0 ? 'created' : 'updated',
        actor: 'system',
        old_value: null,
        new_value: `value-${index}`,
      }));
      mockDb.getAuditLog.mockReturnValue(rows);
      mockDb.getAuditStats.mockReturnValue({
        total: 55,
        byEntity: [{ entity_type: 'task', count: 55 }],
        byActor: [{ actor: 'system', count: 55 }],
        byAction: [
          { action: 'created', count: 28 },
          { action: 'updated', count: 27 },
        ],
      });

      const result = handlers.handleExportAuditReport({});
      const text = getText(result);

      expect(text).toContain('Audit Report (JSON)');
      expect(text).toContain('| Total Actions | 55 |');
      expect(text).toContain('| Unique Entities | 1 |');
      expect(text).toContain('| Unique Actors | 1 |');
      expect(text).toContain('**created:** 28');
      expect(text).toContain('**updated:** 27');
      expect(text).toContain('// ... 5 more entries');
    });
  });

  describe('handleConfigureAudit', () => {
    it('returns current settings and stats when no updates are provided', () => {
      mockDb.getAuditStats.mockReturnValue({
        total: 4,
        byEntity: [{ entity_type: 'task', count: 2 }],
        byActor: [{ actor: 'user', count: 2 }],
        byAction: [],
      });

      const result = handlers.handleConfigureAudit({});
      const text = getText(result);

      expect(mockDb.setAuditConfig).not.toHaveBeenCalled();
      expect(mockDb.getAllAuditConfig).toHaveBeenCalledTimes(1);
      expect(mockDb.getAuditStats).toHaveBeenCalledWith({});
      expect(text).toContain('## Audit Configuration');
      expect(text).toContain('| retention_days | 30 |');
      expect(text).toContain('| track_reads | false |');
      expect(text).not.toContain('**Updated:**');
      expect(text).toContain('**Total logged actions:** 4');
    });

    it('persists updated settings as strings and renders the updated values', () => {
      mockDb.getAllAuditConfig.mockReturnValue({
        retention_days: '14',
        track_reads: 'true',
        track_config_changes: 'false',
        track_task_operations: 'true',
      });

      const result = handlers.handleConfigureAudit({
        retention_days: 14,
        track_reads: true,
        track_config_changes: false,
        track_task_operations: true,
      });
      const text = getText(result);

      expect(mockDb.setAuditConfig).toHaveBeenCalledWith('retention_days', '14');
      expect(mockDb.setAuditConfig).toHaveBeenCalledWith('track_reads', 'true');
      expect(mockDb.setAuditConfig).toHaveBeenCalledWith('track_config_changes', 'false');
      expect(mockDb.setAuditConfig).toHaveBeenCalledWith('track_task_operations', 'true');
      expect(text).toContain('**Updated:**');
      expect(text).toContain('retention_days = 14');
      expect(text).toContain('track_reads = true');
      expect(text).toContain('track_config_changes = false');
      expect(text).toContain('track_task_operations = true');
      expect(text).toContain('| retention_days | 14 |');
    });
  });
});
