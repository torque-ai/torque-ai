import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const SUBJECT_MODULE = '../db/approval-workflows';
const EVENT_BUS_MODULE = '../event-bus';

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module may not have been loaded yet in this worker.
  }
}

function loadApprovalWorkflows(eventBusMock) {
  clearModule(SUBJECT_MODULE);
  clearModule(EVENT_BUS_MODULE);
  installCjsModuleMock(EVENT_BUS_MODULE, eventBusMock);
  return require(SUBJECT_MODULE);
}

function insertTask(dbHandle, testDir, overrides = {}) {
  const id = overrides.id || randomUUID();
  dbHandle.prepare(`
    INSERT INTO tasks (
      id,
      status,
      task_description,
      working_directory,
      provider,
      created_at,
      project,
      priority,
      approval_status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.status || 'queued',
    overrides.task_description || 'approval workflow test task',
    overrides.working_directory || testDir,
    overrides.provider || 'codex',
    overrides.created_at || new Date().toISOString(),
    overrides.project || 'proj-a',
    overrides.priority ?? 0,
    overrides.approval_status || 'not_required',
  );

  return id;
}

function resetTables(dbHandle) {
  for (const table of ['approval_requests', 'approval_rules', 'tasks']) {
    dbHandle.prepare(`DELETE FROM ${table}`).run();
  }
}

describe('db/approval-workflows', () => {
  let rawDb;
  let testDir;
  let mod;
  let eventBusMock;
  let getTaskMock;
  let recordTaskEventMock;
  let recordAuditLogMock;

  beforeEach(() => {
    const setup = setupTestDbOnly(`approval-workflows-${Date.now()}`);
    rawDb = setup.db.getDbInstance();
    testDir = setup.testDir;

    resetTables(rawDb);

    eventBusMock = {
      emit: vi.fn(),
      emitQueueChanged: vi.fn(),
    };
    getTaskMock = vi.fn((taskId) => ({
      id: taskId,
      status: 'pending_approval',
      provider: 'codex',
    }));
    recordTaskEventMock = vi.fn();
    recordAuditLogMock = vi.fn();

    mod = loadApprovalWorkflows(eventBusMock);
    mod.setDb(rawDb);
    mod.setGetTask(getTaskMock);
    mod.setRecordTaskEvent(recordTaskEventMock);
    mod.setRecordAuditLog(recordAuditLogMock);
  });

  afterEach(() => {
    clearModule(SUBJECT_MODULE);
    clearModule(EVENT_BUS_MODULE);
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('creates and retrieves approval rules with parsed JSON conditions', () => {
    const ruleId = mod.createApprovalRule(
      'priority gate',
      'priority',
      { minPriority: 5 },
      { project: 'proj-a', requiredApprovers: 2, autoApproveAfterMinutes: 15 },
    );

    const rule = mod.getApprovalRule(ruleId);

    expect(ruleId).toEqual(expect.any(String));
    expect(rule).toMatchObject({
      id: ruleId,
      name: 'priority gate',
      project: 'proj-a',
      rule_type: 'priority',
      required_approvers: 2,
      auto_approve_after_minutes: 15,
    });
    expect(rule.condition).toEqual({ minPriority: 5 });
  });

  it('lists approval rules with project, type, and enabled filters', () => {
    const globalPriorityId = mod.createApprovalRule('global priority', 'priority', { minPriority: 8 });
    const projectPriorityId = mod.createApprovalRule('proj-a priority', 'priority', { minPriority: 3 }, { project: 'proj-a' });
    const disabledKeywordId = mod.createApprovalRule('proj-a keyword', 'keyword', { keywords: ['deploy'] }, { project: 'proj-a' });
    mod.createApprovalRule('proj-b priority', 'priority', { minPriority: 2 }, { project: 'proj-b' });

    mod.updateApprovalRule(disabledKeywordId, { enabled: false });

    const filtered = mod.listApprovalRules({
      project: 'proj-a',
      ruleType: 'priority',
      enabledOnly: true,
      limit: 10,
    });

    expect(filtered.map((rule) => rule.id).sort()).toEqual([globalPriorityId, projectPriorityId].sort());
    expect(filtered.every((rule) => rule.rule_type === 'priority')).toBe(true);
    expect(filtered.every((rule) => rule.enabled === 1)).toBe(true);

    const withDisabled = mod.listApprovalRules({
      project: 'proj-a',
      enabledOnly: false,
      limit: 10,
    });

    expect(withDisabled.some((rule) => rule.id === disabledKeywordId)).toBe(true);
  });

  it('updates approval rule fields and persists the new condition', () => {
    const ruleId = mod.createApprovalRule('keyword gate', 'keyword', { keywords: ['migration'] });

    const updated = mod.updateApprovalRule(ruleId, {
      name: 'release gate',
      condition: { keywords: ['release'] },
    });

    expect(updated).toBe(true);
    expect(mod.getApprovalRule(ruleId)).toMatchObject({
      id: ruleId,
      name: 'release gate',
      condition: { keywords: ['release'] },
    });
  });

  it('deletes approval rules', () => {
    const ruleId = mod.createApprovalRule('delete me', 'all', {});

    expect(mod.deleteApprovalRule(ruleId)).toBe(true);
    expect(mod.getApprovalRule(ruleId)).toBeUndefined();
  });

  it('matches supported rules and rejects unsupported provider/complexity rule types', () => {
    expect(mod.matchesApprovalRule(
      { working_directory: `${testDir}\\apps\\api` },
      { rule_type: 'directory', condition: { directories: ['apps\\api'] } },
    )).toBe(true);

    expect(mod.matchesApprovalRule(
      { task_description: 'Need a database migration before deploy' },
      { rule_type: 'keyword', condition: { keywords: ['migration'] } },
    )).toBe(true);

    expect(mod.matchesApprovalRule(
      { priority: 7 },
      { rule_type: 'priority', condition: { minPriority: 5 } },
    )).toBe(true);

    expect(mod.matchesApprovalRule(
      { provider: 'codex' },
      { rule_type: 'provider_match', condition: { providers: ['codex'] } },
    )).toBe(false);

    expect(mod.matchesApprovalRule(
      { complexity: 'high' },
      { rule_type: 'complexity_match', condition: { levels: ['high'] } },
    )).toBe(false);
  });

  it('creates and retrieves pending approval requests', () => {
    const taskId = insertTask(rawDb, testDir, { project: 'proj-a' });
    const ruleId = mod.createApprovalRule('all tasks', 'all', {}, { project: 'proj-a' });

    const requestId = mod.createApprovalRequest(taskId, ruleId);
    const request = mod.getApprovalRequest(taskId);

    expect(requestId).toEqual(expect.any(String));
    expect(request).toMatchObject({
      id: requestId,
      task_id: taskId,
      rule_id: ruleId,
      status: 'pending',
      rule_name: 'all tasks',
      rule_type: 'all',
    });

    const task = rawDb.prepare('SELECT approval_status FROM tasks WHERE id = ?').get(taskId);
    expect(task.approval_status).toBe('pending');
  });

  it('approves tasks, records task events, and updates the task state', () => {
    const taskId = insertTask(rawDb, testDir, { project: 'proj-a' });
    const ruleId = mod.createApprovalRule('manual gate', 'all', {}, { project: 'proj-a' });
    mod.createApprovalRequest(taskId, ruleId);

    const approved = mod.approveTask(taskId, 'reviewer-1', 'looks good');
    const request = mod.getApprovalRequest(taskId);
    const task = rawDb.prepare('SELECT approval_status FROM tasks WHERE id = ?').get(taskId);

    expect(approved).toBe(true);
    expect(request).toMatchObject({
      task_id: taskId,
      status: 'approved',
      approved_by: 'reviewer-1',
      comment: 'looks good',
    });
    expect(task.approval_status).toBe('approved');
    expect(recordTaskEventMock).toHaveBeenCalledWith(
      taskId,
      'approval',
      'pending',
      'approved',
      { approvedBy: 'reviewer-1', comment: 'looks good' },
    );
    expect(recordAuditLogMock).toHaveBeenCalled();
    expect(eventBusMock.emitQueueChanged).toHaveBeenCalled();
  });

  it('lists pending approvals and auto-approves expired requests', () => {
    const taskId = insertTask(rawDb, testDir, { project: 'proj-a', priority: 4 });
    const ruleId = mod.createApprovalRule(
      'timed gate',
      'all',
      {},
      { project: 'proj-a', autoApproveAfterMinutes: 5 },
    );
    const requestId = mod.createApprovalRequest(taskId, ruleId);

    rawDb.prepare(`
      UPDATE approval_requests
      SET requested_at = datetime('now', '-10 minutes')
      WHERE id = ?
    `).run(requestId);

    const pending = mod.listPendingApprovals({ project: 'proj-a', limit: 10 });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      task_id: taskId,
      rule_id: ruleId,
      status: 'pending',
      project: 'proj-a',
    });

    expect(mod.processAutoApprovals()).toBe(1);

    const request = mod.getApprovalRequest(taskId);
    const task = rawDb.prepare('SELECT approval_status FROM tasks WHERE id = ?').get(taskId);

    expect(request).toMatchObject({
      id: requestId,
      status: 'approved',
      approved_by: 'auto',
      auto_approved: 1,
    });
    expect(task.approval_status).toBe('approved');
    expect(mod.listPendingApprovals({ project: 'proj-a', limit: 10 })).toHaveLength(0);
    expect(recordTaskEventMock).toHaveBeenCalledWith(taskId, 'approval', 'pending', 'auto_approved', null);
    expect(eventBusMock.emitQueueChanged).toHaveBeenCalled();
  });
});
