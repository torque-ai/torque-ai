const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir, origDataDir, db, mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;
const projectConfigCore = require('../db/project-config-core');
const taskCore = require('../db/task-core');

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-schedauto-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;
  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  mod = require('../db/scheduling-automation');
  mod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  // Inject cross-module dependencies
  mod.setGetTask((id) => taskCore.getTask(id));
  mod.setRecordTaskEvent((..._args) => { /* no-op for tests */ });
  mod.setGetPipeline((id) => projectConfigCore.getPipeline(id));
  mod.setCreatePipeline((...args) => projectConfigCore.createPipeline(...args));
}

function teardown() {
  if (db) try { db.close(); } catch {}
  if (testDir) {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    if (origDataDir !== undefined) process.env.TORQUE_DATA_DIR = origDataDir;
    else delete process.env.TORQUE_DATA_DIR;
  }
}

function rawDb() {
  return db.getDb ? db.getDb() : db.getDbInstance();
}

function resetTables() {
  const conn = rawDb();
  const tables = [
    'approval_requests',
    'approval_rules',
    'audit_log',
    'audit_config',
    'maintenance_schedule',
    'templates',
    'pipeline_steps',
    'pipelines',
    'tasks'
  ];
  for (const table of tables) {
    try {
      conn.prepare(`DELETE FROM ${table}`).run();
    } catch {}
  }
}

function createTask(overrides = {}) {
  const payload = {
    id: randomUUID(),
    task_description: 'scheduling-automation unit test task',
    working_directory: testDir,
    status: 'queued',
    project: 'proj-a',
    priority: 0,
    ...overrides
  };
  taskCore.createTask(payload);
  return taskCore.getTask(payload.id);
}

describe('scheduling-automation module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetTables(); });

  describe('templates', () => {
    it('saveTemplate stores and getTemplate retrieves template fields', () => {
      const saved = mod.saveTemplate({
        name: 'build-template',
        description: 'build flow',
        task_template: 'npm run build',
        default_timeout: 60,
        default_priority: 3,
        auto_approve: true
      });

      expect(saved.name).toBe('build-template');
      expect(saved.task_template).toBe('npm run build');
      expect(saved.default_timeout).toBe(60);
      expect(saved.default_priority).toBe(3);
      expect(saved.auto_approve).toBe(true);

      const fetched = mod.getTemplate('build-template');
      expect(fetched).toBeTruthy();
      expect(fetched.name).toBe('build-template');
      expect(fetched.auto_approve).toBe(true);
    });

    it('saveTemplate applies defaults when optional fields are missing', () => {
      const saved = mod.saveTemplate({
        name: 'defaults-template',
        task_template: 'echo ok'
      });

      expect(saved.default_timeout).toBe(30);
      expect(saved.default_priority).toBe(0);
      expect(saved.auto_approve).toBe(false);
      expect(saved.description).toBeNull();
      expect(saved.usage_count).toBe(0);
    });

    it('saveTemplate update preserves usage_count', () => {
      mod.saveTemplate({
        name: 'usage-template',
        task_template: 'echo one'
      });
      mod.incrementTemplateUsage('usage-template');
      mod.incrementTemplateUsage('usage-template');

      const updated = mod.saveTemplate({
        name: 'usage-template',
        task_template: 'echo two',
        description: 'updated'
      });

      expect(updated.task_template).toBe('echo two');
      expect(updated.description).toBe('updated');
      expect(updated.usage_count).toBe(2);
    });

    it('getTemplate returns undefined for missing name', () => {
      expect(mod.getTemplate('missing-template')).toBeUndefined();
    });

    it('listTemplates orders by usage_count descending', () => {
      mod.saveTemplate({ name: 't-low', task_template: 'echo low' });
      mod.saveTemplate({ name: 't-high', task_template: 'echo high' });
      mod.incrementTemplateUsage('t-high');
      mod.incrementTemplateUsage('t-high');
      mod.incrementTemplateUsage('t-low');

      const list = mod.listTemplates();
      expect(Array.isArray(list)).toBe(true);
      expect(list[0].name).toBe('t-high');
      expect(list[1].name).toBe('t-low');
      expect(typeof list[0].auto_approve).toBe('boolean');
    });

    it('incrementTemplateUsage increases usage count', () => {
      mod.saveTemplate({ name: 'use-template', task_template: 'echo x' });
      mod.incrementTemplateUsage('use-template');
      mod.incrementTemplateUsage('use-template');
      const fetched = mod.getTemplate('use-template');
      expect(fetched.usage_count).toBe(2);
    });

    it('deleteTemplate removes an existing template', () => {
      mod.saveTemplate({ name: 'to-delete', task_template: 'echo delete' });
      expect(mod.deleteTemplate('to-delete')).toBe(true);
      expect(mod.getTemplate('to-delete')).toBeUndefined();
    });

    it('deleteTemplate returns false for missing template', () => {
      expect(mod.deleteTemplate('missing-delete')).toBe(false);
    });

    it('saveTemplate throws when required fields are missing', () => {
      expect(() => mod.saveTemplate({
        name: 'bad-template'
      })).toThrow();
    });
  });

  describe('maintenance schedules', () => {
    it('setMaintenanceSchedule creates interval schedule and computes next_run_at', () => {
      const before = Date.now();
      const schedule = mod.setMaintenanceSchedule({
        id: 'maint-interval',
        task_type: 'cleanup',
        schedule_type: 'interval',
        interval_minutes: 10
      });

      expect(schedule.id).toBe('maint-interval');
      expect(schedule.enabled).toBe(true);
      expect(schedule.next_run_at).toBeTruthy();
      expect(new Date(schedule.next_run_at).getTime()).toBeGreaterThan(before);
    });

    it('setMaintenanceSchedule honors explicit next_run_at and disabled state', () => {
      const explicit = new Date(Date.now() + 3600 * 1000).toISOString();
      const schedule = mod.setMaintenanceSchedule({
        id: 'maint-explicit',
        task_type: 'backup',
        schedule_type: 'cron',
        cron_expression: '0 * * * *',
        next_run_at: explicit,
        enabled: false
      });

      expect(schedule.next_run_at).toBe(explicit);
      expect(schedule.enabled).toBe(false);
      expect(schedule.cron_expression).toBe('0 * * * *');
    });

    it('getMaintenanceSchedule returns undefined for missing id', () => {
      expect(mod.getMaintenanceSchedule('missing-maint')).toBeUndefined();
    });

    it('listMaintenanceSchedules sorts by task_type and casts enabled to boolean', () => {
      mod.setMaintenanceSchedule({
        id: 'm-b',
        task_type: 'zz-maint',
        schedule_type: 'interval',
        interval_minutes: 5,
        enabled: false
      });
      mod.setMaintenanceSchedule({
        id: 'm-a',
        task_type: 'aa-maint',
        schedule_type: 'interval',
        interval_minutes: 5
      });

      const rows = mod.listMaintenanceSchedules();
      expect(rows.map(r => r.id)).toEqual(['m-a', 'm-b']);
      expect(typeof rows[0].enabled).toBe('boolean');
      expect(typeof rows[1].enabled).toBe('boolean');
    });

    it('getDueMaintenanceTasks returns only enabled due schedules', () => {
      const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      mod.setMaintenanceSchedule({
        id: 'due-yes',
        task_type: 'rotate',
        schedule_type: 'interval',
        interval_minutes: 5,
        next_run_at: past
      });
      mod.setMaintenanceSchedule({
        id: 'due-future',
        task_type: 'rotate2',
        schedule_type: 'interval',
        interval_minutes: 5,
        next_run_at: future
      });
      mod.setMaintenanceSchedule({
        id: 'due-disabled',
        task_type: 'rotate3',
        schedule_type: 'interval',
        interval_minutes: 5,
        next_run_at: past,
        enabled: false
      });

      const due = mod.getDueMaintenanceTasks();
      const ids = new Set(due.map(d => d.id));
      expect(ids.has('due-yes')).toBe(true);
      expect(ids.has('due-future')).toBe(false);
      expect(ids.has('due-disabled')).toBe(false);
      expect(due.every(d => d.enabled === true)).toBe(true);
    });

    it('markMaintenanceRun updates last_run_at and next_run_at for interval schedules', () => {
      mod.setMaintenanceSchedule({
        id: 'maint-run',
        task_type: 'index',
        schedule_type: 'interval',
        interval_minutes: 5
      });

      const updated = mod.markMaintenanceRun('maint-run');
      expect(updated).toBeTruthy();
      expect(updated.last_run_at).toBeTruthy();
      expect(updated.next_run_at).toBeTruthy();
      expect(new Date(updated.next_run_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('markMaintenanceRun returns null for missing schedule', () => {
      expect(mod.markMaintenanceRun('missing-run')).toBeNull();
    });

    it('calculateNextMaintenanceRun returns null for cron schedules', () => {
      const next = mod.calculateNextMaintenanceRun({
        schedule_type: 'cron',
        cron_expression: '*/5 * * * *'
      });
      expect(next).toBeNull();
    });

    it('deleteMaintenanceSchedule deletes existing rows and reports missing rows', () => {
      mod.setMaintenanceSchedule({
        id: 'del-maint',
        task_type: 'temp',
        schedule_type: 'interval',
        interval_minutes: 5
      });

      expect(mod.deleteMaintenanceSchedule('del-maint')).toBe(true);
      expect(mod.deleteMaintenanceSchedule('del-maint')).toBe(false);
    });
  });

  describe('approvals', () => {
    it('createApprovalRule + getApprovalRule round-trip condition and options', () => {
      const ruleId = mod.createApprovalRule(
        'priority gate',
        'priority',
        { minPriority: 5 },
        { project: 'proj-a', requiredApprovers: 2, autoApproveAfterMinutes: 30 }
      );
      const rule = mod.getApprovalRule(ruleId);

      expect(rule).toBeTruthy();
      expect(rule.name).toBe('priority gate');
      expect(rule.project).toBe('proj-a');
      expect(rule.rule_type).toBe('priority');
      expect(rule.required_approvers).toBe(2);
      expect(rule.auto_approve_after_minutes).toBe(30);
      expect(rule.condition).toEqual({ minPriority: 5 });
    });

    it('createApprovalRule throws for missing condition payload', () => {
      expect(() => mod.createApprovalRule('bad', 'all')).toThrow();
    });

    it('listApprovalRules filters by project and includes global rules', () => {
      mod.createApprovalRule('global', 'all', {});
      mod.createApprovalRule('proj-a-only', 'all', {}, { project: 'proj-a' });
      mod.createApprovalRule('proj-b-only', 'all', {}, { project: 'proj-b' });

      const rules = mod.listApprovalRules({ project: 'proj-a' });
      const names = rules.map(r => r.name);
      expect(names).toContain('global');
      expect(names).toContain('proj-a-only');
      expect(names).not.toContain('proj-b-only');
    });

    it('listApprovalRules excludes disabled rules by default and includes them when requested', () => {
      const enabledId = mod.createApprovalRule('enabled-rule', 'all', {});
      const disabledId = mod.createApprovalRule('disabled-rule', 'all', {});
      rawDb().prepare('UPDATE approval_rules SET enabled = 0 WHERE id = ?').run(disabledId);

      const enabledOnly = mod.listApprovalRules();
      expect(enabledOnly.some(r => r.id === enabledId)).toBe(true);
      expect(enabledOnly.some(r => r.id === disabledId)).toBe(false);

      const withDisabled = mod.listApprovalRules({ enabledOnly: false });
      expect(withDisabled.some(r => r.id === disabledId)).toBe(true);
    });

    it('checkApprovalRequired returns not required when no rule matches', () => {
      mod.createApprovalRule('priority-10', 'priority', { minPriority: 10 }, { project: 'proj-a' });
      const result = mod.checkApprovalRequired({
        project: 'proj-a',
        priority: 2
      });
      expect(result.required).toBe(false);
      expect(result.rule).toBeNull();
    });

    it('checkApprovalRequired returns matching rule when rule matches', () => {
      const ruleId = mod.createApprovalRule('priority-3', 'priority', { minPriority: 3 }, { project: 'proj-a' });
      const result = mod.checkApprovalRequired({
        project: 'proj-a',
        priority: 5
      });
      expect(result.required).toBe(true);
      expect(result.rule.id).toBe(ruleId);
    });

    it('checkApprovalRequired by task id creates pending approval request', () => {
      const task = createTask({ project: 'proj-a', priority: 5 });
      const ruleId = mod.createApprovalRule('priority-3', 'priority', { minPriority: 3 }, { project: 'proj-a' });

      const result = mod.checkApprovalRequired(task.id);

      expect(result.required).toBe(true);
      expect(result.status).toBe('pending');
      expect(result.rule.id).toBe(ruleId);

      const approvalRequest = rawDb().prepare('SELECT * FROM approval_requests WHERE task_id = ? ORDER BY requested_at DESC LIMIT 1').get(task.id);
      expect(approvalRequest).toBeTruthy();
      expect(approvalRequest.status).toBe('pending');
      expect(approvalRequest.rule_id).toBe(ruleId);
    });

    it('checkApprovalRequired returns existing approval status when request already exists', () => {
      const task = createTask({ project: 'proj-a', priority: 5 });
      const ruleId = mod.createApprovalRule('priority-3', 'priority', { minPriority: 3 }, { project: 'proj-a' });
      const requestId = mod.createApprovalRequest(task.id, ruleId);

      rawDb().prepare(`
        UPDATE approval_requests
        SET status = 'approved', approved_at = datetime('now'), approved_by = 'auto'
        WHERE id = ?
      `).run(requestId);

      const result = mod.checkApprovalRequired(task.id);

      expect(result.required).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.rule.id).toBe(ruleId);
    });

    it('matchesApprovalRule supports auto_approve, all, and priority rules', () => {
      expect(mod.matchesApprovalRule(
        { auto_approve: 1 },
        { rule_type: 'auto_approve', condition: {} }
      )).toBe(true);

      expect(mod.matchesApprovalRule(
        { priority: 7 },
        { rule_type: 'priority', condition: { minPriority: 5 } }
      )).toBe(true);

      expect(mod.matchesApprovalRule(
        { priority: 2 },
        { rule_type: 'all', condition: {} }
      )).toBe(true);
    });

    it('matchesApprovalRule supports directory and keyword matching', () => {
      expect(mod.matchesApprovalRule(
        { working_directory: '/repo/apps/api' },
        { rule_type: 'directory', condition: { directories: ['/apps', '/scripts'] } }
      )).toBe(true);

      expect(mod.matchesApprovalRule(
        { task_description: 'Need DB MIGRATION before deploy' },
        { rule_type: 'keyword', condition: { keywords: ['migration'] } }
      )).toBe(true);
    });

    it('matchesApprovalRule returns false for unknown rule types', () => {
      expect(mod.matchesApprovalRule(
        { priority: 100 },
        { rule_type: 'not-a-rule', condition: {} }
      )).toBe(false);
    });

    it('createApprovalRequest inserts request and updates task approval status', () => {
      const task = createTask({ approval_status: 'not_required' });
      const ruleId = mod.createApprovalRule('all', 'all', {}, { project: task.project });

      const requestId = mod.createApprovalRequest(task.id, ruleId);
      expect(typeof requestId).toBe('string');

      const request = mod.getApprovalRequest(task.id);
      expect(request).toBeTruthy();
      expect(request.status).toBe('pending');
      expect(request.rule_id).toBe(ruleId);

      const updatedTask = taskCore.getTask(task.id);
      expect(updatedTask.approval_status).toBe('pending');
    });

    it('createApprovalRequest throws when required args are missing', () => {
      const task = createTask();
      expect(() => mod.createApprovalRequest(task.id)).toThrow();
      expect(() => mod.createApprovalRequest(null, 'rule-id')).toThrow();
    });

    it('approveTask approves a pending request and rejects repeated approvals', () => {
      const task = createTask();
      const ruleId = mod.createApprovalRule('all', 'all', {});
      mod.createApprovalRequest(task.id, ruleId);

      expect(mod.approveTask(task.id, 'alice', 'looks good')).toBe(true);
      const req = mod.getApprovalRequest(task.id);
      expect(req.status).toBe('approved');
      expect(req.approved_by).toBe('alice');
      expect(req.comment).toBe('looks good');
      expect(taskCore.getTask(task.id).approval_status).toBe('approved');

      expect(() => mod.approveTask(task.id, 'bob')).toThrow(/not pending/i);
    });

    it('approveTask emits queue-changed when approval is granted', () => {
      const task = createTask();
      const ruleId = mod.createApprovalRule('all', 'all', {});
      mod.createApprovalRequest(task.id, ruleId);

      const eventBus = require('../event-bus');
      const emitSpy = vi.spyOn(eventBus, 'emitQueueChanged').mockImplementation(() => {});

      expect(mod.approveTask(task.id, 'alice')).toBe(true);
      expect(emitSpy).toHaveBeenCalled();

      emitSpy.mockRestore();
    });

    it('cannot double-decide an approval after it is processed', () => {
      const task = createTask();
      const ruleId = mod.createApprovalRule('all', 'all', {});
      mod.createApprovalRequest(task.id, ruleId);

      expect(mod.approveTask(task.id, 'alice')).toBe(true);
      expect(() => mod.rejectApproval(task.id, 'reviewer', 'late note')).toThrow(/not pending/i);
      expect(() => mod.approveTask(task.id, 'alice')).toThrow(/not pending/i);
    });

    it('approveTask throws when there is no request for the task', () => {
      const task = createTask();
      expect(() => mod.approveTask(task.id, 'alice')).toThrow(/No approval request found/i);
    });

    it('rejectApproval rejects a pending request and rejects repeated rejections', () => {
      const task = createTask();
      const ruleId = mod.createApprovalRule('all', 'all', {});
      mod.createApprovalRequest(task.id, ruleId);

      expect(mod.rejectApproval(task.id, 'reviewer', 'needs fixes')).toBe(true);
      const req = mod.getApprovalRequest(task.id);
      expect(req.status).toBe('rejected');
      expect(req.approved_by).toBe('reviewer');
      expect(req.comment).toBe('needs fixes');
      const rejectedTask = taskCore.getTask(task.id);
      expect(rejectedTask.approval_status).toBe('rejected');
      expect(rejectedTask.status).toBe('cancelled');
      expect(rejectedTask.error_output).toBe('Approval rejected by reviewer: needs fixes');

      expect(() => mod.rejectApproval(task.id, 'other')).toThrow(/not pending/i);
    });

    it('listPendingApprovals filters by project and respects limit', () => {
      const ruleA = mod.createApprovalRule('r-a', 'all', {}, { project: 'proj-a' });
      const ruleB = mod.createApprovalRule('r-b', 'all', {}, { project: 'proj-b' });

      const taskA1 = createTask({ project: 'proj-a', priority: 1 });
      const taskA2 = createTask({ project: 'proj-a', priority: 2 });
      const taskB = createTask({ project: 'proj-b', priority: 3 });

      mod.createApprovalRequest(taskA1.id, ruleA);
      mod.createApprovalRequest(taskA2.id, ruleA);
      mod.createApprovalRequest(taskB.id, ruleB);

      const projAOnly = mod.listPendingApprovals({ project: 'proj-a', limit: 10 });
      expect(projAOnly.length).toBe(2);
      expect(projAOnly.every(p => p.project === 'proj-a')).toBe(true);

      const limited = mod.listPendingApprovals({ limit: 1 });
      expect(limited.length).toBe(1);
    });
  });

  describe('processAutoApprovals', () => {
    it('returns 0 when there are no pending approval requests', () => {
      expect(mod.processAutoApprovals()).toBe(0);
    });

    it('returns 0 when pending requests have no auto_approve_after_minutes', () => {
      const task = createTask();
      const ruleId = mod.createApprovalRule('no-auto', 'all', {});
      mod.createApprovalRequest(task.id, ruleId);

      expect(mod.processAutoApprovals()).toBe(0);

      // Request should still be pending
      const req = mod.getApprovalRequest(task.id);
      expect(req.status).toBe('pending');
    });

    it('does not auto-approve requests that have not exceeded the timeout', () => {
      const task = createTask();
      const ruleId = mod.createApprovalRule('future-auto', 'all', {}, { autoApproveAfterMinutes: 60 });
      mod.createApprovalRequest(task.id, ruleId);

      // Request was just created (now), so 60 minutes hasn't elapsed
      expect(mod.processAutoApprovals()).toBe(0);

      const req = mod.getApprovalRequest(task.id);
      expect(req.status).toBe('pending');
    });

    it('auto-approves requests that have exceeded the timeout', () => {
      const task = createTask();
      const ruleId = mod.createApprovalRule('quick-auto', 'all', {}, { autoApproveAfterMinutes: 5 });
      const requestId = mod.createApprovalRequest(task.id, ruleId);

      // Backdate the request to 10 minutes ago
      rawDb().prepare(`
        UPDATE approval_requests SET requested_at = datetime('now', '-10 minutes') WHERE id = ?
      `).run(requestId);

      expect(mod.processAutoApprovals()).toBe(1);

      const req = mod.getApprovalRequest(task.id);
      expect(req.status).toBe('approved');
      expect(req.approved_by).toBe('auto');
      expect(req.auto_approved).toBe(1);

      const updatedTask = taskCore.getTask(task.id);
      expect(updatedTask.approval_status).toBe('approved');
    });

    it('auto-approves multiple requests in one call', () => {
      const task1 = createTask();
      const task2 = createTask();
      const task3 = createTask();
      const ruleId = mod.createApprovalRule('batch-auto', 'all', {}, { autoApproveAfterMinutes: 5 });

      const reqId1 = mod.createApprovalRequest(task1.id, ruleId);
      const reqId2 = mod.createApprovalRequest(task2.id, ruleId);
      const reqId3 = mod.createApprovalRequest(task3.id, ruleId);

      // Backdate all requests
      rawDb().prepare(`
        UPDATE approval_requests SET requested_at = datetime('now', '-10 minutes')
        WHERE id IN (?, ?, ?)
      `).run(reqId1, reqId2, reqId3);

      expect(mod.processAutoApprovals()).toBe(3);

      for (const task of [task1, task2, task3]) {
        const req = mod.getApprovalRequest(task.id);
        expect(req.status).toBe('approved');
        expect(req.approved_by).toBe('auto');
        expect(taskCore.getTask(task.id).approval_status).toBe('approved');
      }
    });

    it('only auto-approves expired requests, leaving non-expired ones pending', () => {
      const taskExpired = createTask();
      const taskFresh = createTask();
      const ruleId = mod.createApprovalRule('mixed-auto', 'all', {}, { autoApproveAfterMinutes: 30 });

      const expiredReqId = mod.createApprovalRequest(taskExpired.id, ruleId);
      mod.createApprovalRequest(taskFresh.id, ruleId);

      // Only backdate one request
      rawDb().prepare(`
        UPDATE approval_requests SET requested_at = datetime('now', '-60 minutes') WHERE id = ?
      `).run(expiredReqId);

      expect(mod.processAutoApprovals()).toBe(1);

      expect(mod.getApprovalRequest(taskExpired.id).status).toBe('approved');
      expect(mod.getApprovalRequest(taskFresh.id).status).toBe('pending');
    });

    it('skips already approved or rejected requests', () => {
      const taskApproved = createTask();
      const taskRejected = createTask();
      const taskPending = createTask();
      const ruleId = mod.createApprovalRule('skip-auto', 'all', {}, { autoApproveAfterMinutes: 5 });

      const reqApproved = mod.createApprovalRequest(taskApproved.id, ruleId);
      const reqRejected = mod.createApprovalRequest(taskRejected.id, ruleId);
      const reqPending = mod.createApprovalRequest(taskPending.id, ruleId);

      // Backdate all
      rawDb().prepare(`
        UPDATE approval_requests SET requested_at = datetime('now', '-10 minutes')
        WHERE id IN (?, ?, ?)
      `).run(reqApproved, reqRejected, reqPending);

      // Manually approve and reject
      mod.approveTask(taskApproved.id, 'alice');
      mod.rejectApproval(taskRejected.id, 'bob');

      // Only the pending one should be auto-approved
      expect(mod.processAutoApprovals()).toBe(1);
      expect(mod.getApprovalRequest(taskPending.id).status).toBe('approved');
      expect(mod.getApprovalRequest(taskPending.id).approved_by).toBe('auto');
    });

    it('calls recordTaskEventFn for each auto-approved request', () => {
      const events = [];
      mod.setRecordTaskEvent((taskId, type, from, to, meta) => {
        events.push({ taskId, type, from, to, meta });
      });

      const task = createTask();
      const ruleId = mod.createApprovalRule('event-auto', 'all', {}, { autoApproveAfterMinutes: 1 });
      const reqId = mod.createApprovalRequest(task.id, ruleId);

      rawDb().prepare(`
        UPDATE approval_requests SET requested_at = datetime('now', '-5 minutes') WHERE id = ?
      `).run(reqId);

      mod.processAutoApprovals();

      expect(events.length).toBe(1);
      expect(events[0].taskId).toBe(task.id);
      expect(events[0].type).toBe('approval');
      expect(events[0].from).toBe('pending');
      expect(events[0].to).toBe('auto_approved');

      // Restore no-op
      mod.setRecordTaskEvent((..._args) => {});
    });

    it('returns 0 on second call after all eligible requests were processed', () => {
      const task = createTask();
      const ruleId = mod.createApprovalRule('once-auto', 'all', {}, { autoApproveAfterMinutes: 5 });
      const reqId = mod.createApprovalRequest(task.id, ruleId);

      rawDb().prepare(`
        UPDATE approval_requests SET requested_at = datetime('now', '-10 minutes') WHERE id = ?
      `).run(reqId);

      expect(mod.processAutoApprovals()).toBe(1);
      expect(mod.processAutoApprovals()).toBe(0);
    });
  });

  describe('audit', () => {
    it('getAuditConfig returns null for unknown key', () => {
      expect(mod.getAuditConfig('missing-key')).toBeNull();
    });

    it('setAuditConfig inserts and updates values', () => {
      expect(mod.setAuditConfig('enabled', '1')).toBe(true);
      expect(mod.getAuditConfig('enabled')).toBe('1');

      expect(mod.setAuditConfig('enabled', '0')).toBe(true);
      expect(mod.getAuditConfig('enabled')).toBe('0');
    });

    it('recordAuditLog stores entries and serializes object values', () => {
      const id = mod.recordAuditLog(
        'task',
        'task-1',
        'update',
        'user-a',
        { status: 'queued' },
        { status: 'running' },
        { source: 'unit-test' }
      );

      expect(typeof id).toBe('number');
      const rows = mod.getAuditLog({ entityType: 'task', entityId: 'task-1' });
      expect(rows.length).toBe(1);
      expect(rows[0].action).toBe('update');
      expect(rows[0].actor).toBe('user-a');
      expect(JSON.parse(rows[0].old_value)).toEqual({ status: 'queued' });
      expect(JSON.parse(rows[0].new_value)).toEqual({ status: 'running' });
      expect(JSON.parse(rows[0].metadata)).toEqual({ source: 'unit-test' });
    });

    it('recordAuditLog returns null when auditing is disabled', () => {
      mod.setAuditConfig('enabled', '0');
      const id = mod.recordAuditLog('task', 't1', 'create', 'user-a');
      expect(id).toBeNull();
      expect(mod.getAuditLogCount()).toBe(0);
    });

    it('recordAuditLog respects tracked_actions filtering', () => {
      mod.setAuditConfig('enabled', '1');
      mod.setAuditConfig('tracked_actions', JSON.stringify(['allowed_action']));

      const dropped = mod.recordAuditLog('task', 't1', 'ignored_action', 'user-a');
      const kept = mod.recordAuditLog('task', 't1', 'allowed_action', 'user-a');

      expect(dropped).toBeNull();
      expect(typeof kept).toBe('number');
      expect(mod.getAuditLogCount()).toBe(1);
    });

    it('getAuditLog filters and paginates results', () => {
      mod.recordAuditLog('task', 'a', 'create', 'alice');
      mod.recordAuditLog('task', 'a', 'update', 'alice');
      mod.recordAuditLog('task', 'b', 'update', 'bob');

      const filtered = mod.getAuditLog({ entityType: 'task', entityId: 'a', actor: 'alice' });
      expect(filtered.length).toBe(2);
      expect(filtered.every(r => r.entity_id === 'a')).toBe(true);

      const firstPage = mod.getAuditLog({ action: 'update', limit: 1, offset: 0 });
      const secondPage = mod.getAuditLog({ action: 'update', limit: 1, offset: 1 });
      expect(firstPage.length).toBe(1);
      expect(secondPage.length).toBe(1);
      expect(firstPage[0].id).not.toBe(secondPage[0].id);
    });

    it('getAuditLogCount applies filters', () => {
      mod.recordAuditLog('task', 'x', 'create', 'alice');
      mod.recordAuditLog('task', 'x', 'update', 'alice');
      mod.recordAuditLog('task', 'x', 'update', 'bob');

      expect(mod.getAuditLogCount({ actor: 'alice' })).toBe(2);
      expect(mod.getAuditLogCount({ action: 'update' })).toBe(2);
      expect(mod.getAuditLogCount({ entityId: 'x' })).toBe(3);
    });

    it('exportAuditLog returns JSON and raw array fallback for unknown format', () => {
      mod.recordAuditLog('task', 'j1', 'create', 'alice');
      const jsonOut = mod.exportAuditLog({ format: 'json' });
      expect(typeof jsonOut).toBe('string');

      const parsed = JSON.parse(jsonOut);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);

      const raw = mod.exportAuditLog({ format: 'ndjson' });
      expect(Array.isArray(raw)).toBe(true);
      expect(raw.length).toBe(1);
    });

    it('exportAuditLog returns CSV rows with expected headers and escaping', () => {
      mod.recordAuditLog('task', 'csv-1', 'create', 'alice', null, 'hello, "world"', null);
      const csv = mod.exportAuditLog({ format: 'csv' });
      const lines = csv.split('\n');

      expect(lines[0]).toBe('id,entity_type,entity_id,action,actor,old_value,new_value,timestamp');
      expect(lines.length).toBe(2);
      expect(lines[1]).toContain('csv-1');
      expect(lines[1]).toContain('"hello, ""world"""');
    });

    it('exportAuditLog returns CSV header only when there are no rows', () => {
      const csv = mod.exportAuditLog({ format: 'csv' });
      expect(csv).toBe('id,entity_type,entity_id,action,actor,old_value,new_value,timestamp\n');
    });

    it('cleanupAuditLog uses retention config and enforces minimum bound', () => {
      const oldId = mod.recordAuditLog('task', 'old-1', 'create', 'alice');
      rawDb().prepare("UPDATE audit_log SET timestamp = datetime('now', '-10 days') WHERE id = ?").run(oldId);

      mod.setAuditConfig('retention_days', '-5');
      const removed = mod.cleanupAuditLog();
      expect(removed).toBe(1);
      expect(mod.getAuditLogCount()).toBe(0);
    });

    it('getAuditStats returns grouped counts and supports since filter', () => {
      const oldId = mod.recordAuditLog('task', 'older', 'create', 'alice');
      rawDb().prepare("UPDATE audit_log SET timestamp = datetime('now', '-5 days') WHERE id = ?").run(oldId);
      mod.recordAuditLog('task', 'new-1', 'update', 'alice');
      mod.recordAuditLog('pipeline', 'new-2', 'update', 'bob');

      const all = mod.getAuditStats();
      expect(all.total).toBe(3);
      expect(all.byEntity.some(e => e.entity_type === 'task')).toBe(true);
      expect(all.byAction.some(e => e.action === 'update')).toBe(true);
      expect(all.byActor.some(e => e.actor === 'alice')).toBe(true);

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recent = mod.getAuditStats({ since });
      expect(recent.total).toBe(2);
    });
  });
});
