let testDir;
let db;
let taskCore;
let mod;
let seq = 0;

const { setupTestDbOnly, teardownTestDb, rawDb: _rawDb } = require('./vitest-setup');

function setup() {
  ({ db, testDir } = setupTestDbOnly('toctou-'));
  taskCore = require('../db/task-core');
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;

  mod = require('../db/provider-routing-core');
  mod.setDb(db.getDb());
}

function teardown() {
  teardownTestDb();
}

function id(prefix) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

function rawDb() {
  return _rawDb();
}

function createTask(overrides = {}) {
  const taskId = overrides.id || id('task');
  taskCore.createTask({
    id: taskId,
    task_description: overrides.task_description || `Task ${taskId}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    project: overrides.project || 'proj-tests',
    provider: overrides.provider || 'codex',
    ...overrides,
  });
  return taskId;
}

function resetTables() {
  const conn = rawDb();
  for (const table of ['rate_limits', 'task_quotas', 'tasks']) {
    try {
      conn.prepare(`DELETE FROM ${table}`).run();
    } catch {}
  }
}

describe('p1 provider-routing TOCTOU regressions', () => {
  beforeAll(() => {
    setup();
  });

  afterAll(() => {
    teardown();
  });

  beforeEach(() => {
    resetTables();
  });

  it('rate limit blocks when max value is reached', () => {
    const projectId = 'proj-toctou-rate';
    const rid = id('rate-limit');

    mod.setRateLimit({
      id: rid,
      project_id: projectId,
      limit_type: 'submit',
      max_value: 2,
      window_seconds: 3600,
    });

    const first = mod.checkRateLimit(projectId, 'submit');
    const second = mod.checkRateLimit(projectId, 'submit');
    const third = mod.checkRateLimit(projectId, 'submit');
    const fourth = mod.checkRateLimit(projectId, 'submit');

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(fourth.allowed).toBe(false);
    expect(third.reason).toBe('rate_limit_exceeded');
    expect(mod.getRateLimit(rid).current_value).toBe(2);
  });

  it('task quota blocks when max value is reached', () => {
    const projectId = 'proj-toctou-quota';
    const qid = id('task-quota');

    mod.setTaskQuota({
      id: qid,
      project_id: projectId,
      quota_type: 'task_submit',
      max_value: 2,
      reset_period: null,
    });

    const first = mod.checkTaskQuota(projectId, 'task_submit', () => createTask({ project: projectId, task_description: 'quota-task-1' }));
    const second = mod.checkTaskQuota(projectId, 'task_submit', () => createTask({ project: projectId, task_description: 'quota-task-2' }));
    const third = mod.checkTaskQuota(projectId, 'task_submit', () => createTask({ project: projectId, task_description: 'quota-task-3' }));

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(first.task).toBeTruthy();
    expect(second.task).toBeTruthy();
    expect(third.reason).toBe('quota_exceeded');

    const quotaRow = mod.getTaskQuota(qid);
    expect(quotaRow.current_value).toBe(2);

    const taskCount = rawDb().prepare('SELECT COUNT(*) AS c FROM tasks WHERE project = ?').get(projectId);
    expect(taskCount.c).toBe(2);
  });

  it('keeps rate-limit and quota checks bounded during rapid sequential calls', () => {
    const projectId = 'proj-toctou-both';
    const rid = id('both-limit');
    const qid = id('both-quota');

    mod.setRateLimit({
      id: rid,
      project_id: projectId,
      limit_type: 'submit',
      max_value: 2,
      window_seconds: 3600,
    });

    mod.setTaskQuota({
      id: qid,
      project_id: projectId,
      quota_type: 'task_submit',
      max_value: 2,
      reset_period: null,
    });

    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      const rateLimit = mod.checkRateLimit(projectId, 'submit');
      const quota = mod.checkTaskQuota(projectId, 'task_submit', () => createTask({
        project: projectId,
        task_description: `bounded-seq-${i}`,
      }));

      outcomes.push({ rate: rateLimit.allowed, quota: quota.allowed, quotaReason: quota.reason });
    }

    expect(outcomes[0].rate).toBe(true);
    expect(outcomes[0].quota).toBe(true);
    expect(outcomes[1].rate).toBe(true);
    expect(outcomes[1].quota).toBe(true);
    expect(outcomes[2].rate).toBe(false);
    expect(outcomes[2].quota).toBe(false);
    expect(outcomes[3].rate).toBe(false);
    expect(outcomes[3].quota).toBe(false);
    expect(outcomes[4].rate).toBe(false);
    expect(outcomes[4].quota).toBe(false);

    const rateLimitRow = mod.getRateLimit(rid);
    const taskQuotaRow = mod.getTaskQuota(qid);
    const taskCount = rawDb().prepare('SELECT COUNT(*) AS c FROM tasks WHERE project = ?').get(projectId);

    expect(rateLimitRow.current_value).toBe(2);
    expect(taskQuotaRow.current_value).toBe(2);
    expect(taskCount.c).toBe(2);
    expect(outcomes[2].quotaReason).toBe('quota_exceeded');
  });
});
