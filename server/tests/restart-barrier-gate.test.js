'use strict';

const { setupE2eDb, teardownE2eDb } = require('./e2e-helpers');
const { isRestartBarrierActive } = require('../execution/restart-barrier');

const SLOT_PULL_PATH = require.resolve('../execution/slot-pull-scheduler');

let ctx;
let db;

function rawDb() {
  return db.getDbInstance();
}

function createBarrierTask(overrides = {}) {
  const id = overrides.id || 'barrier-1';
  const status = overrides.status || 'running';
  db.createTask({
    id,
    task_description: overrides.task_description || 'Restart barrier',
    working_directory: process.cwd(),
    provider: 'system',
    model: null,
    status: 'queued',
    metadata: {},
  });
  rawDb().prepare('UPDATE tasks SET provider = ?, status = ? WHERE id = ?')
    .run('system', status, id);
  return id;
}

function createUnassignedQueuedTask(overrides = {}) {
  const id = overrides.id || `queued-${Math.random().toString(16).slice(2, 8)}`;
  db.createTask({
    id,
    task_description: 'queued work',
    working_directory: process.cwd(),
    provider: 'codex',
    status: 'queued',
    metadata: {},
  });
  const meta = overrides.metadata || {
    eligible_providers: ['codex'],
    capability_requirements: [],
    quality_tier: 'normal',
  };
  rawDb().prepare(`
    UPDATE tasks
    SET provider = NULL,
        status = 'queued',
        metadata = ?
    WHERE id = ?
  `).run(JSON.stringify(meta), id);
  return id;
}

function createRunningTask(id = 'running-1', provider = 'codex') {
  db.createTask({
    id,
    task_description: 'busy',
    working_directory: process.cwd(),
    provider,
    status: 'queued',
    metadata: {},
  });
  rawDb().prepare("UPDATE tasks SET status = 'running', provider = ? WHERE id = ?")
    .run(provider, id);
  return id;
}

describe('isRestartBarrierActive (helper)', () => {
  beforeEach(() => {
    ctx = setupE2eDb('restart-barrier-helper');
    db = ctx.db;
  });

  afterEach(async () => {
    if (ctx) await teardownE2eDb(ctx);
    ctx = null;
    db = null;
  });

  it('returns null when no barrier task exists', () => {
    expect(isRestartBarrierActive(db)).toBeNull();
  });

  it('returns the barrier row when one is running', () => {
    createBarrierTask({ status: 'running' });
    const row = isRestartBarrierActive(db);
    expect(row).toBeTruthy();
    expect(row.id).toBe('barrier-1');
    expect(row.provider).toBe('system');
  });

  it('returns the barrier row when one is queued', () => {
    createBarrierTask({ status: 'queued' });
    const row = isRestartBarrierActive(db);
    expect(row).toBeTruthy();
    expect(row.id).toBe('barrier-1');
  });

  it('ignores non-system tasks in running/queued', () => {
    createRunningTask('running-codex', 'codex');
    createUnassignedQueuedTask({ id: 'queued-codex' });
    expect(isRestartBarrierActive(db)).toBeNull();
  });

  it('returns null when db lacks listTasks', () => {
    expect(isRestartBarrierActive({})).toBeNull();
    expect(isRestartBarrierActive(null)).toBeNull();
  });
});

describe('slot-pull runSlotPullPass honors restart barrier', () => {
  let scheduler;
  let startTask;

  beforeEach(() => {
    ctx = setupE2eDb('restart-barrier-slotpull');
    db = ctx.db;
    db.setConfig('scheduling_mode', 'slot-pull');

    delete require.cache[SLOT_PULL_PATH];
    scheduler = require('../execution/slot-pull-scheduler');
    startTask = vi.fn();
    scheduler.init({ db, startTask });
  });

  afterEach(async () => {
    if (scheduler) scheduler.stopHeartbeat();
    if (ctx) await teardownE2eDb(ctx);
    ctx = null;
    db = null;
    scheduler = null;
    startTask = null;
  });

  it('does NOT promote queued tasks while a barrier is running', () => {
    createBarrierTask({ status: 'running' });
    createUnassignedQueuedTask({ id: 'q-1' });
    createUnassignedQueuedTask({ id: 'q-2' });
    createUnassignedQueuedTask({ id: 'q-3' });

    const result = scheduler.runSlotPullPass();

    expect(result).toEqual({ assigned: 0, skipped: 0 });
    expect(startTask).not.toHaveBeenCalled();

    const rows = rawDb()
      .prepare("SELECT id, status, provider FROM tasks WHERE id LIKE 'q-%' ORDER BY id")
      .all();
    for (const row of rows) {
      expect(row.status).toBe('queued');
      expect(row.provider).toBeNull();
    }
  });

  it('does NOT promote queued tasks while a barrier is queued', () => {
    createBarrierTask({ status: 'queued' });
    createUnassignedQueuedTask({ id: 'q-1' });

    const result = scheduler.runSlotPullPass();

    expect(result).toEqual({ assigned: 0, skipped: 0 });
    expect(startTask).not.toHaveBeenCalled();
  });

  it('resumes promoting queued tasks after the barrier completes', () => {
    const barrierId = createBarrierTask({ status: 'running' });
    createUnassignedQueuedTask({ id: 'q-after' });

    expect(scheduler.runSlotPullPass()).toEqual({ assigned: 0, skipped: 0 });
    expect(startTask).not.toHaveBeenCalled();

    rawDb().prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(barrierId);

    scheduler.runSlotPullPass();
    expect(startTask).toHaveBeenCalledWith('q-after');
  });
});
