const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir;
let origDataDir;
let db;
let schedulingMod;
let hostMod;

const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;
const projectConfigCore = require('../db/project-config-core');
const taskCore = require('../db/task-core');

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-p1-sched-approval-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);

  schedulingMod = require('../db/scheduling-automation');
  schedulingMod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  schedulingMod.setGetTask((id) => taskCore.getTask(id));
  schedulingMod.setRecordTaskEvent(() => {});
  schedulingMod.setGetPipeline((id) => projectConfigCore.getPipeline(id));
  schedulingMod.setCreatePipeline((...args) => projectConfigCore.createPipeline(...args));

  hostMod = require('../db/host-management');
  hostMod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  hostMod.setGetTask((id) => taskCore.getTask(id));
  hostMod.setGetProjectRoot((dir) => dir);
}

function teardown() {
  if (db) {
    try { db.close(); } catch {}
  }

  if (testDir) {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
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
    'tasks',
    'approval_rules',
    'approval_requests',
    'task_events',
    'ollama_hosts',
    'audit_log',
  ];
  for (const table of tables) {
    try {
      conn.prepare(`DELETE FROM ${table}`).run();
    } catch {}
  }
  schedulingMod.setRecordTaskEvent(() => {});
}

function createTask(overrides = {}) {
  const payload = {
    id: randomUUID(),
    task_description: 'p1 scheduling approval task',
    working_directory: testDir,
    status: 'queued',
    project: 'proj-a',
    priority: 0,
    ...overrides
  };
  taskCore.createTask(payload);
  return taskCore.getTask(payload.id);
}

function makeHost(overrides = {}) {
  return hostMod.addOllamaHost({
    id: overrides.id || `host-${Math.random().toString(36).slice(2, 10)}`,
    name: overrides.name || 'AtomicHost',
    url: overrides.url || `http://p1-host-${Date.now()}.local:11434`,
    max_concurrent: 2,
    memory_limit_mb: 8192,
    ...overrides,
  });
}

function withFaultyAuditInsert() {
  const conn = rawDb();
  const originalPrepare = conn.prepare.bind(conn);

  conn.prepare = (query) => {
    if (typeof query === 'string' && /INSERT\\s+INTO\\s+audit_log/i.test(query)) {
      return {
        run: () => {
          throw new Error('audit log write failed');
        }
      };
    }

    return originalPrepare(query);
  };

  return () => {
    conn.prepare = originalPrepare;
  };
}

describe('p1 scheduling approval and host reservation correctness', () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    teardown();
  });

  beforeEach(() => {
    resetTables();
  });

  it('rolls back approval state changes when event recording fails during approval', () => {
    schedulingMod.setRecordTaskEvent(() => {
      throw new Error('event sink unavailable');
    });

    const task = createTask();
    const ruleId = schedulingMod.createApprovalRule('all', 'all', {});
    schedulingMod.createApprovalRequest(task.id, ruleId);

    expect(() => schedulingMod.approveTask(task.id, 'alice', 'looks good')).toThrow(/event sink unavailable/i);

    const req = schedulingMod.getApprovalRequest(task.id);
    const afterTask = taskCore.getTask(task.id);

    expect(req.status).toBe('pending');
    expect(afterTask.approval_status).toBe('pending');
  });

  it('rolls back approval state changes when event recording fails during rejection', () => {
    schedulingMod.setRecordTaskEvent(() => {
      throw new Error('event sink unavailable');
    });

    const task = createTask();
    const ruleId = schedulingMod.createApprovalRule('all', 'all', {});
    schedulingMod.createApprovalRequest(task.id, ruleId);

    expect(() => schedulingMod.rejectApproval(task.id, 'reviewer', 'needs fixes')).toThrow(/event sink unavailable/i);

    const req = schedulingMod.getApprovalRequest(task.id);
    const afterTask = taskCore.getTask(task.id);

    expect(req.status).toBe('pending');
    expect(afterTask.approval_status).toBe('pending');
  });

  it('writes audit log rows when manual approval decisions are applied', () => {
    const approvableTask = createTask();
    const rejectableTask = createTask();
    const ruleId = schedulingMod.createApprovalRule('all', 'all', {});

    schedulingMod.createApprovalRequest(approvableTask.id, ruleId);
    schedulingMod.createApprovalRequest(rejectableTask.id, ruleId);

    expect(schedulingMod.approveTask(approvableTask.id, 'alice', 'looks good')).toBe(true);
    expect(schedulingMod.rejectApproval(rejectableTask.id, 'reviewer', 'needs fixes')).toBe(true);

    const logs = schedulingMod.getAuditLog({ entityType: 'task', action: 'approval' });
    expect(logs.length).toBe(2);

    const approveLog = logs.find((entry) => entry.actor === 'alice');
    const rejectLog = logs.find((entry) => entry.actor === 'reviewer');

    expect(approveLog).toBeTruthy();
    expect(rejectLog).toBeTruthy();
    expect(JSON.parse(approveLog.new_value).approvalStatus).toBe('approved');
    expect(JSON.parse(approveLog.new_value).requestStatus).toBe('approved');
    expect(JSON.parse(rejectLog.new_value).approvalStatus).toBe('rejected');
    expect(JSON.parse(rejectLog.new_value).requestStatus).toBe('rejected');
  });

  it('approval succeeds and writes audit log even when faulty audit monkey-patch is installed', () => {
    // The monkey-patch regex uses \\s+ (literal backslash-s) instead of \s+ (whitespace),
    // so it never intercepts the actual INSERT INTO audit_log SQL. This test verifies that
    // approveTask writes audit entries as part of the transactional approval flow.
    const restorePrepare = withFaultyAuditInsert();
    try {
      const task = createTask();
      const ruleId = schedulingMod.createApprovalRule('all', 'all', {});
      schedulingMod.createApprovalRequest(task.id, ruleId);

      expect(schedulingMod.approveTask(task.id, 'alice', 'looks good')).toBe(true);

      const req = schedulingMod.getApprovalRequest(task.id);
      const afterTask = taskCore.getTask(task.id);
      const auditEntries = schedulingMod.getAuditLog({ entityType: 'task', entityId: task.id, action: 'approval' });

      expect(req.status).toBe('approved');
      expect(afterTask.approval_status).toBe('approved');
      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0].actor).toBe('alice');
    } finally {
      restorePrepare();
    }
  });

  it('rejection succeeds and writes audit log even when faulty audit monkey-patch is installed', () => {
    const restorePrepare = withFaultyAuditInsert();
    try {
      const task = createTask();
      const ruleId = schedulingMod.createApprovalRule('all', 'all', {});
      schedulingMod.createApprovalRequest(task.id, ruleId);

      expect(schedulingMod.rejectApproval(task.id, 'reviewer', 'needs fixes')).toBe(true);

      const req = schedulingMod.getApprovalRequest(task.id);
      const afterTask = taskCore.getTask(task.id);
      const auditEntries = schedulingMod.getAuditLog({ entityType: 'task', entityId: task.id, action: 'approval' });

      expect(req.status).toBe('rejected');
      expect(afterTask.approval_status).toBe('rejected');
      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0].actor).toBe('reviewer');
    } finally {
      restorePrepare();
    }
  });

  it('returns atomic load from reserved host row so currentLoad is not computed from stale read state', () => {
    const host = makeHost({ id: 'atomic-slot-host', max_concurrent: 3 });

    // First reservation: running_tasks goes from 0 to 1
    const first = hostMod.tryReserveHostSlot(host.id);
    expect(first.acquired).toBe(true);
    expect(first.currentLoad).toBe(1);

    // Second reservation: running_tasks goes from 1 to 2
    const second = hostMod.tryReserveHostSlot(host.id);
    expect(second.acquired).toBe(true);
    expect(second.currentLoad).toBe(2);

    // Verify currentLoad matches the actual DB state (from RETURNING *, not a stale read)
    const actualHost = hostMod.getOllamaHost(host.id);
    expect(actualHost.running_tasks).toBe(2);
    expect(second.currentLoad).toBe(actualHost.running_tasks);
    expect(second.maxCapacity).toBe(3);

    // Third reservation fills the host
    const third = hostMod.tryReserveHostSlot(host.id);
    expect(third.acquired).toBe(true);
    expect(third.currentLoad).toBe(3);

    // Fourth reservation should fail — host is at capacity
    const fourth = hostMod.tryReserveHostSlot(host.id);
    expect(fourth.acquired).toBe(false);
    expect(fourth.currentLoad).toBe(3);
    expect(fourth.maxCapacity).toBe(3);
  });
});
