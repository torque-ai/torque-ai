import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const Database = require('better-sqlite3');

const {
  rawDb,
  resetTables,
  setupTestDbModule,
  teardownTestDb,
} = require('./vitest-setup');

let approvals;

function createApprovalTable(handle) {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS peek_recovery_approvals (
      id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      task_id TEXT,
      requested_by TEXT,
      approved_by TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
      requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );
  `);
}

function insertApproval(overrides = {}) {
  const row = {
    action: 'force_kill_process',
    task_id: null,
    requested_by: 'operator-1',
    approved_by: null,
    status: 'pending',
    requested_at: '2026-03-11 12:00:00',
    resolved_at: null,
    ...overrides,
  };

  const result = rawDb().prepare(`
    INSERT INTO peek_recovery_approvals (
      action,
      task_id,
      requested_by,
      approved_by,
      status,
      requested_at,
      resolved_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.action,
    row.task_id,
    row.requested_by,
    row.approved_by,
    row.status,
    row.requested_at,
    row.resolved_at,
  );

  return Object.prototype.hasOwnProperty.call(overrides, 'id')
    ? Number(overrides.id)
    : Number(result.lastInsertRowid);
}

function getStoredApproval(id) {
  return rawDb().prepare(`
    SELECT *
    FROM peek_recovery_approvals
    WHERE id = ?
  `).get(id);
}

function listStoredApprovals() {
  return rawDb().prepare(`
    SELECT *
    FROM peek_recovery_approvals
    ORDER BY id ASC
  `).all();
}

beforeAll(() => {
  ({ mod: approvals } = setupTestDbModule('../db/peek-recovery-approvals', 'db-peek-recovery-approvals'));
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  resetTables('peek_recovery_approvals');
  approvals.setDb(rawDb());
});

afterEach(() => {
  approvals.setDb(rawDb());
});

describe('db/peek-recovery-approvals', () => {
  describe('setDb and database guards', () => {
    it('throws when the database handle is not initialized', () => {
      approvals.setDb(null);

      expect(() => approvals.requestApproval('force_kill_process')).toThrow(
        'Peek recovery approvals database is not initialized',
      );
    });

    it('throws when the configured handle does not expose prepare', () => {
      approvals.setDb({});

      expect(() => approvals.getApprovalStatus(1)).toThrow(
        'Peek recovery approvals database is not initialized',
      );
    });

    it('switches the active database handle for subsequent reads and writes', () => {
      const alternateDb = new Database(':memory:');

      try {
        createApprovalTable(alternateDb);
        approvals.setDb(alternateDb);

        const created = approvals.requestApproval('alt_action', 'task-alt', 'alt-user');

        expect(created).toMatchObject({
          id: 1,
          action: 'alt_action',
          task_id: 'task-alt',
          requested_by: 'alt-user',
          status: 'pending',
        });
        expect(approvals.getApprovalStatus(created.id)).toMatchObject({
          id: 1,
          action: 'alt_action',
        });
        expect(listStoredApprovals()).toEqual([]);
      } finally {
        approvals.setDb(rawDb());
        alternateDb.close();
      }
    });
  });

  describe('requestApproval', () => {
    it.each([undefined, null, '', '   ', 123])(
      'requires a non-empty string action (%p)',
      (action) => {
        expect(() => approvals.requestApproval(action)).toThrow('action is required');
      },
    );

    it('creates a pending approval with trimmed values', () => {
      const created = approvals.requestApproval('  force_kill_process  ', '  task-1  ', '  operator-1  ');

      expect(created).toMatchObject({
        id: expect.any(Number),
        action: 'force_kill_process',
        task_id: 'task-1',
        requested_by: 'operator-1',
        approved_by: null,
        status: 'pending',
        requested_at: expect.any(String),
        resolved_at: null,
      });
      expect(getStoredApproval(created.id)).toMatchObject({
        action: 'force_kill_process',
        task_id: 'task-1',
        requested_by: 'operator-1',
        approved_by: null,
        status: 'pending',
      });
    });

    it('defaults requested_by to system when omitted or blank', () => {
      const omitted = approvals.requestApproval('action-omitted', 'task-1');
      const blank = approvals.requestApproval('action-blank', 'task-2', '   ');

      expect(omitted.requested_by).toBe('system');
      expect(blank.requested_by).toBe('system');
    });

    it('defaults requested_by to system when the caller is not a string', () => {
      const created = approvals.requestApproval('action-non-string', 'task-1', { user: 'operator-1' });

      expect(created.requested_by).toBe('system');
    });

    it('stores null task ids for blank task strings', () => {
      const created = approvals.requestApproval('global-action', '   ', 'operator-1');

      expect(created.task_id).toBeNull();
      expect(getStoredApproval(created.id).task_id).toBeNull();
    });

    it('stores null task ids for non-string task identifiers', () => {
      const created = approvals.requestApproval('global-action-number', 42, 'operator-1');

      expect(created.task_id).toBeNull();
    });

    it('returns the existing pending approval for the same action and task', () => {
      const first = approvals.requestApproval('inject_accessibility_hook', 'task-1', 'operator-1');
      const second = approvals.requestApproval('inject_accessibility_hook', 'task-1', 'operator-2');

      expect(second).toEqual(first);
      expect(listStoredApprovals()).toHaveLength(1);
    });

    it('returns the existing approved approval for the same action and task', () => {
      const first = approvals.requestApproval('modify_registry_key', 'task-1', 'operator-1');
      const approved = approvals.grantApproval(first.id, 'reviewer-1');
      const second = approvals.requestApproval('modify_registry_key', 'task-1', 'operator-2');

      expect(approved.status).toBe('approved');
      expect(second).toEqual(approved);
      expect(listStoredApprovals()).toHaveLength(1);
    });

    it('creates a fresh pending approval after a denial for the same action and task', () => {
      const first = approvals.requestApproval('force_kill_process', 'task-1', 'operator-1');
      approvals.denyApproval(first.id, 'reviewer-1');

      const second = approvals.requestApproval('force_kill_process', 'task-1', 'operator-2');

      expect(second.id).not.toBe(first.id);
      expect(second).toMatchObject({
        action: 'force_kill_process',
        task_id: 'task-1',
        requested_by: 'operator-2',
        approved_by: null,
        status: 'pending',
        resolved_at: null,
      });
      expect(listStoredApprovals()).toHaveLength(2);
    });

    it('creates independent approval chains for different task ids', () => {
      const first = approvals.requestApproval('force_kill_process', 'task-1', 'operator-1');
      const second = approvals.requestApproval('force_kill_process', 'task-2', 'operator-1');

      expect(first.id).not.toBe(second.id);
      expect(first.task_id).toBe('task-1');
      expect(second.task_id).toBe('task-2');
    });

    it('keeps global and task-scoped approvals separate for the same action', () => {
      const globalApproval = approvals.requestApproval('modify_registry_key', null, 'operator-1');
      const taskApproval = approvals.requestApproval('modify_registry_key', 'task-1', 'operator-1');

      expect(globalApproval.task_id).toBeNull();
      expect(taskApproval.task_id).toBe('task-1');
      expect(globalApproval.id).not.toBe(taskApproval.id);
    });

    it('creates a fresh approval when the newest historical row is denied even if an older row was approved', () => {
      insertApproval({
        action: 'inject_accessibility_hook',
        task_id: 'task-1',
        requested_by: 'operator-1',
        approved_by: 'reviewer-1',
        status: 'approved',
        requested_at: '2026-03-11 12:00:00',
        resolved_at: '2026-03-11 12:05:00',
      });
      insertApproval({
        action: 'inject_accessibility_hook',
        task_id: 'task-1',
        requested_by: 'operator-2',
        approved_by: 'reviewer-2',
        status: 'denied',
        requested_at: '2026-03-11 12:10:00',
        resolved_at: '2026-03-11 12:11:00',
      });

      const created = approvals.requestApproval('inject_accessibility_hook', 'task-1', 'operator-3');

      expect(created).toMatchObject({
        id: 3,
        action: 'inject_accessibility_hook',
        task_id: 'task-1',
        requested_by: 'operator-3',
        status: 'pending',
      });
      expect(listStoredApprovals()).toHaveLength(3);
    });
  });

  describe('getApprovalForAction', () => {
    it.each([undefined, null, '', '   ', 123])(
      'returns null for blank or non-string actions (%p)',
      (action) => {
        expect(approvals.getApprovalForAction(action, 'task-1')).toBeNull();
      },
    );

    it('returns the latest task-scoped approval ordered by requested_at descending', () => {
      insertApproval({
        action: 'force_kill_process',
        task_id: 'task-1',
        requested_by: 'operator-oldest',
        requested_at: '2026-03-11 12:00:00',
      });
      insertApproval({
        action: 'force_kill_process',
        task_id: 'task-1',
        requested_by: 'operator-latest',
        requested_at: '2026-03-11 12:10:00',
      });
      insertApproval({
        action: 'force_kill_process',
        task_id: 'task-2',
        requested_by: 'operator-other',
        requested_at: '2026-03-11 12:20:00',
      });

      expect(approvals.getApprovalForAction('  force_kill_process  ', '  task-1  ')).toMatchObject({
        id: 2,
        requested_by: 'operator-latest',
      });
    });

    it('breaks requested_at ties by id descending', () => {
      insertApproval({
        action: 'modify_registry_key',
        task_id: 'task-1',
        requested_by: 'operator-1',
        requested_at: '2026-03-11 12:00:00',
      });
      insertApproval({
        action: 'modify_registry_key',
        task_id: 'task-1',
        requested_by: 'operator-2',
        requested_at: '2026-03-11 12:00:00',
      });

      expect(approvals.getApprovalForAction('modify_registry_key', 'task-1')).toMatchObject({
        id: 2,
        requested_by: 'operator-2',
      });
    });

    it('returns the latest global approval when the task id is blank or non-string', () => {
      insertApproval({
        action: 'global-action',
        task_id: null,
        requested_by: 'operator-1',
        requested_at: '2026-03-11 12:00:00',
      });
      insertApproval({
        action: 'global-action',
        task_id: null,
        requested_by: 'operator-2',
        requested_at: '2026-03-11 12:05:00',
      });
      insertApproval({
        action: 'global-action',
        task_id: 'task-1',
        requested_by: 'operator-task',
        requested_at: '2026-03-11 12:10:00',
      });

      expect(approvals.getApprovalForAction('global-action', '   ')).toMatchObject({
        id: 2,
        task_id: null,
        requested_by: 'operator-2',
      });
      expect(approvals.getApprovalForAction('global-action', 55)).toMatchObject({
        id: 2,
        task_id: null,
        requested_by: 'operator-2',
      });
    });

    it('does not match global approvals when a task id is provided', () => {
      insertApproval({
        action: 'task-only-action',
        task_id: null,
        requested_by: 'operator-global',
      });

      expect(approvals.getApprovalForAction('task-only-action', 'task-1')).toBeNull();
    });

    it('does not match task-scoped approvals when querying the global action', () => {
      insertApproval({
        action: 'global-only-action',
        task_id: 'task-1',
        requested_by: 'operator-task',
      });

      expect(approvals.getApprovalForAction('global-only-action')).toBeNull();
    });
  });

  describe('getApprovalStatus', () => {
    it.each([undefined, null, '', '   ', 'abc', 0, -1, 1.25])(
      'returns null for invalid approval ids (%p)',
      (approvalId) => {
        expect(approvals.getApprovalStatus(approvalId)).toBeNull();
      },
    );

    it('returns null when the approval id does not exist', () => {
      expect(approvals.getApprovalStatus(999999)).toBeNull();
    });

    it('normalizes stored row values on lookup', () => {
      const id = insertApproval({
        action: '  inject_accessibility_hook  ',
        task_id: '  task-1  ',
        requested_by: '  operator-1  ',
        approved_by: '  reviewer-1  ',
        status: 'approved',
        requested_at: '  2026-03-11 12:00:00  ',
        resolved_at: '  2026-03-11 12:05:00  ',
      });

      expect(approvals.getApprovalStatus(String(id))).toEqual({
        id,
        action: 'inject_accessibility_hook',
        task_id: 'task-1',
        requested_by: 'operator-1',
        approved_by: 'reviewer-1',
        status: 'approved',
        requested_at: '2026-03-11 12:00:00',
        resolved_at: '2026-03-11 12:05:00',
      });
    });
  });

  describe('grantApproval and denyApproval', () => {
    it.each([undefined, null, '', '   ', 'abc', 0, -1, 1.25])(
      'grantApproval rejects invalid approval ids (%p)',
      (approvalId) => {
        expect(() => approvals.grantApproval(approvalId, 'reviewer-1')).toThrow(
          'approvalId must be a positive integer',
        );
      },
    );

    it.each([undefined, null, '', '   ', 'abc', 0, -1, 1.25])(
      'denyApproval rejects invalid approval ids (%p)',
      (approvalId) => {
        expect(() => approvals.denyApproval(approvalId, 'reviewer-1')).toThrow(
          'approvalId must be a positive integer',
        );
      },
    );

    it('grantApproval returns null when the approval does not exist', () => {
      expect(approvals.grantApproval(999999, 'reviewer-1')).toBeNull();
    });

    it('denyApproval returns null when the approval does not exist', () => {
      expect(approvals.denyApproval(999999, 'reviewer-1')).toBeNull();
    });

    it('transitions pending approvals to approved and records resolver metadata', () => {
      const created = approvals.requestApproval('modify_registry_key', 'task-1', 'operator-1');

      const approved = approvals.grantApproval(String(created.id), '  reviewer-1  ');

      expect(approved).toMatchObject({
        id: created.id,
        action: 'modify_registry_key',
        task_id: 'task-1',
        requested_by: 'operator-1',
        approved_by: 'reviewer-1',
        status: 'approved',
        requested_at: expect.any(String),
        resolved_at: expect.any(String),
      });
      expect(getStoredApproval(created.id)).toMatchObject({
        status: 'approved',
        approved_by: 'reviewer-1',
      });
    });

    it('transitions pending approvals to denied and records resolver metadata', () => {
      const created = approvals.requestApproval('inject_accessibility_hook', 'task-1', 'operator-1');

      const denied = approvals.denyApproval(created.id, 'reviewer-2');

      expect(denied).toMatchObject({
        id: created.id,
        approved_by: 'reviewer-2',
        status: 'denied',
        resolved_at: expect.any(String),
      });
      expect(getStoredApproval(created.id)).toMatchObject({
        status: 'denied',
        approved_by: 'reviewer-2',
      });
    });

    it('defaults approved_by to system when granting without a reviewer name', () => {
      const created = approvals.requestApproval('force_kill_process', 'task-1', 'operator-1');

      const approved = approvals.grantApproval(created.id);

      expect(approved.approved_by).toBe('system');
      expect(approved.status).toBe('approved');
    });

    it('defaults approved_by to system when denying with a non-string reviewer', () => {
      const created = approvals.requestApproval('force_kill_process', 'task-1', 'operator-1');

      const denied = approvals.denyApproval(created.id, { reviewer: 'ops' });

      expect(denied.approved_by).toBe('system');
      expect(denied.status).toBe('denied');
    });

    it('does not overwrite a previously approved approval with a later denial', () => {
      const created = approvals.requestApproval('modify_registry_key', 'task-1', 'operator-1');
      const approved = approvals.grantApproval(created.id, 'reviewer-1');

      const deniedLater = approvals.denyApproval(created.id, 'reviewer-2');

      expect(deniedLater).toEqual(approved);
      expect(getStoredApproval(created.id)).toMatchObject({
        status: 'approved',
        approved_by: 'reviewer-1',
      });
    });

    it('does not overwrite a previously denied approval with a later grant', () => {
      const created = approvals.requestApproval('inject_accessibility_hook', 'task-1', 'operator-1');
      const denied = approvals.denyApproval(created.id, 'reviewer-2');

      const approvedLater = approvals.grantApproval(created.id, 'reviewer-1');

      expect(approvedLater).toEqual(denied);
      expect(getStoredApproval(created.id)).toMatchObject({
        status: 'denied',
        approved_by: 'reviewer-2',
      });
    });
  });
});
