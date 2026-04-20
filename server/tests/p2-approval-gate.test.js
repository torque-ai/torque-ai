const { randomUUID } = require('crypto');

const { setupTestDbOnly, teardownTestDb, rawDb: _rawDb } = require('./vitest-setup');

vi.mock('../providers/registry', () => ({
  getProviderInstance: vi.fn().mockReturnValue({}),
  listProviders: vi.fn().mockReturnValue([]),
  getProviderConfig: vi.fn(),
  getCategory: vi.fn().mockReturnValue(null),
}));

let db;
let scheduler;
let testDir;
let safeStartTask;
let schedulingAutomation;
let hostManagement;
let taskCore;

function setup() {
  ({ db, testDir } = setupTestDbOnly('p2-approval-gate-'));
  const conn = db.getDbInstance();
  for (const table of ['tasks', 'approval_requests', 'approval_rules', 'ollama_hosts']) {
    try { conn.prepare(`DELETE FROM ${table}`).run(); } catch { /* ignore */ }
  }
  schedulingAutomation = require('../db/scheduling-automation');
  hostManagement = require('../db/host-management');
  taskCore = require('../db/task-core');

  delete require.cache[require.resolve('../execution/queue-scheduler')];
  scheduler = require('../execution/queue-scheduler');

  safeStartTask = vi.fn().mockReturnValue(true);

  scheduler.init({
    db,
    safeStartTask,
    safeConfigInt: (key, defaultVal) => {
      if (key === 'max_concurrent') return 10;
      if (key === 'max_per_host') return 4;
      if (key === 'max_ollama_concurrent') return 8;
      if (key === 'max_codex_concurrent') return 3;
      if (key === 'max_api_concurrent') return 2;
      return defaultVal;
    },
    isLargeModelBlockedOnHost: vi.fn().mockReturnValue({ blocked: false }),
    cleanupOrphanedRetryTimeouts: vi.fn(),
  });

  hostManagement.selectOllamaHostForModel = vi.fn().mockReturnValue({
    host: { id: 'host-1', name: 'host-1', running_tasks: 0 },
    reason: 'available',
  });
}

function teardown() {
  teardownTestDb();
}

function createQueuedTask(approvalStatus) {
  const taskId = randomUUID();
  taskCore.createTask({
    id: taskId,
    task_description: 'approval gate test task',
    working_directory: testDir,
    status: 'queued',
    provider: 'ollama',
    model: 'mistral:7b',
  });
  db.getDbInstance()
    .prepare('UPDATE tasks SET approval_status = ? WHERE id = ?')
    .run(approvalStatus, taskId);
  return taskCore.getTask(taskId);
}

function createQueuedTaskForRule(overrides = {}) {
  const taskId = randomUUID();
  taskCore.createTask({
    id: taskId,
    task_description: overrides.task_description || 'approval gate rule test task',
    working_directory: testDir,
    status: 'queued',
    provider: 'ollama',
    model: 'mistral:7b',
    project: 'rule-proj',
    priority: 0,
    ...overrides,
  });
  db.getDbInstance()
    .prepare(`UPDATE tasks SET approval_status = 'not_required' WHERE id = ?`)
    .run(taskId);

  return taskCore.getTask(taskId);
}

describe('Approval gate enforcement in processQueue', () => {
  beforeEach(() => {
    setup();
  });

  afterEach(() => {
    teardown();
  });

  it('does NOT start queued task with pending approval_status', () => {
    createQueuedTask('pending');

    scheduler.processQueueInternal();

    expect(safeStartTask).not.toHaveBeenCalled();
  });

  it('starts queued task with approved approval_status', () => {
    const task = createQueuedTask('approved');

    scheduler.processQueueInternal();

    expect(safeStartTask).toHaveBeenCalledTimes(1);
    expect(safeStartTask).toHaveBeenCalledWith(task.id, 'ollama');
  });

  it('starts queued task with null approval_status', () => {
    const task = createQueuedTask(null);

    scheduler.processQueueInternal();

    expect(safeStartTask).toHaveBeenCalledTimes(1);
    expect(safeStartTask).toHaveBeenCalledWith(task.id, 'ollama');
  });

  it('does NOT start queued task with rejected approval_status', () => {
    createQueuedTask('rejected');

    scheduler.processQueueInternal();

    expect(safeStartTask).not.toHaveBeenCalled();
  });

  it('starts queued task with not_required approval_status (default)', () => {
    const task = createQueuedTask('not_required');

    scheduler.processQueueInternal();

    expect(safeStartTask).toHaveBeenCalledTimes(1);
    expect(safeStartTask).toHaveBeenCalledWith(task.id, 'ollama');
  });

  it('does NOT start queued task when matching approval rule is pending', () => {
    const ruleId = schedulingAutomation.createApprovalRule(
      'priority 5 gate',
      'priority',
      { minPriority: 5 },
      { project: 'rule-proj' }
    );

    const task = createQueuedTaskForRule({ project: 'rule-proj', priority: 10 });

    scheduler.processQueueInternal();

    expect(ruleId).toBeTruthy();
    expect(safeStartTask).not.toHaveBeenCalled();

    const approval = db.getDbInstance().prepare(
      'SELECT * FROM approval_requests WHERE task_id = ? ORDER BY requested_at DESC LIMIT 1'
    ).get(task.id);
    expect(approval).toBeTruthy();
    expect(approval.status).toBe('pending');
  });

  it('starts queued task once approval request is approved', () => {
    const ruleId = schedulingAutomation.createApprovalRule(
      'priority 5 gate',
      'priority',
      { minPriority: 5 },
      { project: 'rule-proj' }
    );
    const task = createQueuedTaskForRule({ project: 'rule-proj', priority: 10 });
    const requestId = schedulingAutomation.createApprovalRequest(task.id, ruleId);

    db.getDbInstance().prepare(`
      UPDATE approval_requests
      SET status = 'approved', approved_at = datetime('now'), approved_by = 'qa'
      WHERE id = ?
    `).run(requestId);
    db.getDbInstance().prepare(`UPDATE tasks SET approval_status = 'approved' WHERE id = ?`).run(task.id);

    scheduler.processQueueInternal();

    expect(safeStartTask).toHaveBeenCalledTimes(1);
    expect(safeStartTask).toHaveBeenCalledWith(task.id, 'ollama');
  });

  it('starts queued task with no matching approval rule', () => {
    const task = createQueuedTaskForRule({
      project: 'rule-proj-no-match',
      priority: 10,
    });

    scheduler.processQueueInternal();

    expect(safeStartTask).toHaveBeenCalledTimes(1);
    expect(safeStartTask).toHaveBeenCalledWith(task.id, 'ollama');
  });
});

describe('tryClaimTaskSlot approval enforcement', () => {
  beforeEach(() => {
    setup();
  });

  afterEach(() => {
    teardown();
  });

  it('does not claim queued tasks when approval is pending', () => {
    const task = createQueuedTask('pending');

    const claim = db.tryClaimTaskSlot(task.id, 10, 'queue-lock-id', 'ollama', null, ['ollama']);

    expect(claim.success).toBe(false);
    expect(claim.reason).toBe('approval_not_approved');
    expect(taskCore.getTask(task.id).status).toBe('queued');
  });

  it('claims queued tasks that are already approved', () => {
    const task = createQueuedTask('approved');

    const claim = db.tryClaimTaskSlot(task.id, 10, 'queue-lock-id', 'ollama', null, ['ollama']);
    expect(claim.success).toBe(true);
    expect(claim.task.id).toBe(task.id);
    expect(taskCore.getTask(task.id).status).toBe('running');
  });
});
