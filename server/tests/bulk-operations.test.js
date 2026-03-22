const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

let testDir, origDataDir, db, taskCore, mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-bulk-operations-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  taskCore = require('../db/task-core');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  mod = require('../db/task-metadata');
  mod.setDb(db.getDb());
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
  if (db.getDb) return db.getDb();
  return db.getDbInstance();
}

function resetState() {
  const tables = ['bulk_operations', 'tasks'];
  for (const table of tables) {
    rawDb().prepare(`DELETE FROM ${table}`).run();
  }
}

function mkTask(overrides = {}) {
  const task = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || `bulk-task-${Math.random().toString(36).slice(2)}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    timeout_minutes: overrides.timeout_minutes ?? 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    max_retries: overrides.max_retries ?? 2,
    retry_count: overrides.retry_count ?? 0,
    provider: overrides.provider || 'codex',
    project: overrides.project || null,
    tags: overrides.tags
  };
  taskCore.createTask(task);
  return taskCore.getTask(task.id);
}

function patchTask(taskId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  rawDb().prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...entries.map(([, v]) => v), taskId);
}

function isoNowMinusHours(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

describe('bulk-operations module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  describe('createBulkOperation + getBulkOperation', () => {
    it('round-trips JSON fields correctly', () => {
      const created = mod.createBulkOperation({
        id: 'bulk-1',
        operation_type: 'cancel',
        status: 'pending',
        filter_criteria: { status: ['queued'] },
        affected_task_ids: ['t1', 't2'],
        total_tasks: 2,
        dry_run: true,
        results: { preview: true }
      });

      expect(created.id).toBe('bulk-1');
      expect(created.filter_criteria).toEqual({ status: ['queued'] });
      expect(created.affected_task_ids).toEqual(['t1', 't2']);
      expect(created.dry_run).toBe(true);
      expect(created.results).toEqual({ preview: true });
    });

    it('applies default values for optional fields', () => {
      const created = mod.createBulkOperation({
        id: 'bulk-defaults',
        operation_type: 'tag',
        filter_criteria: {}
      });

      expect(created.status).toBe('pending');
      expect(created.total_tasks).toBe(0);
      expect(created.succeeded_tasks).toBe(0);
      expect(created.failed_tasks).toBe(0);
      expect(created.dry_run).toBe(false);
    });

    it('returns null for non-existent bulk operation', () => {
      expect(mod.getBulkOperation('missing')).toBeUndefined();
    });
  });

  describe('updateBulkOperation', () => {
    it('updates progress and stamps completed_at on completion', () => {
      mod.createBulkOperation({ id: 'bulk-upd', operation_type: 'tag', filter_criteria: {} });
      const updated = mod.updateBulkOperation('bulk-upd', {
        status: 'completed',
        total_tasks: 3,
        succeeded_tasks: 2,
        failed_tasks: 1,
        results: { ok: ['a', 'b'], failed: ['c'] }
      });

      expect(updated.status).toBe('completed');
      expect(updated.total_tasks).toBe(3);
      expect(updated.results.failed).toEqual(['c']);
      expect(updated.completed_at).toBeTruthy();
    });

    it('stamps completed_at on failed status', () => {
      mod.createBulkOperation({ id: 'bulk-fail', operation_type: 'cancel', filter_criteria: {} });
      const updated = mod.updateBulkOperation('bulk-fail', {
        status: 'failed',
        error: 'something went wrong'
      });

      expect(updated.status).toBe('failed');
      expect(updated.completed_at).toBeTruthy();
    });

    it('updates affected_task_ids', () => {
      mod.createBulkOperation({ id: 'bulk-ids', operation_type: 'tag', filter_criteria: {} });
      const updated = mod.updateBulkOperation('bulk-ids', {
        affected_task_ids: ['a', 'b', 'c']
      });

      expect(updated.affected_task_ids).toEqual(['a', 'b', 'c']);
    });

    it('returns unchanged when no fields provided', () => {
      mod.createBulkOperation({ id: 'bulk-noop', operation_type: 'cancel', filter_criteria: {} });
      const result = mod.updateBulkOperation('bulk-noop', {});
      expect(result.status).toBe('pending');
    });
  });

  describe('listBulkOperations', () => {
    it('lists all bulk operations', () => {
      mod.createBulkOperation({ id: 'list-1', operation_type: 'cancel', filter_criteria: {} });
      mod.createBulkOperation({ id: 'list-2', operation_type: 'tag', filter_criteria: {} });

      const list = mod.listBulkOperations();
      expect(list).toHaveLength(2);
    });

    it('filters by operation_type', () => {
      mod.createBulkOperation({ id: 'type-1', operation_type: 'cancel', filter_criteria: {} });
      mod.createBulkOperation({ id: 'type-2', operation_type: 'tag', filter_criteria: {} });

      const cancels = mod.listBulkOperations({ operation_type: 'cancel' });
      expect(cancels).toHaveLength(1);
      expect(cancels[0].id).toBe('type-1');
    });

    it('filters by status', () => {
      mod.createBulkOperation({ id: 'stat-1', operation_type: 'cancel', filter_criteria: {} });
      mod.updateBulkOperation('stat-1', { status: 'completed' });
      mod.createBulkOperation({ id: 'stat-2', operation_type: 'cancel', filter_criteria: {} });

      const completed = mod.listBulkOperations({ status: 'completed' });
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe('stat-1');
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        mod.createBulkOperation({ id: `lim-${i}`, operation_type: 'cancel', filter_criteria: {} });
      }

      const limited = mod.listBulkOperations({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it('returns parsed JSON fields', () => {
      mod.createBulkOperation({
        id: 'json-test',
        operation_type: 'tag',
        filter_criteria: { status: 'queued' },
        dry_run: true
      });

      const [op] = mod.listBulkOperations();
      expect(op.filter_criteria).toEqual({ status: 'queued' });
      expect(op.dry_run).toBe(true);
    });
  });

  describe('dryRunBulkOperation', () => {
    it('returns affected ids and preview', () => {
      const t1 = mkTask({ status: 'queued', task_description: 'first queued task description that is long enough to truncate' });
      const t2 = mkTask({ status: 'queued', task_description: 'second queued task description that is long enough to truncate' });
      mkTask({ status: 'completed', task_description: 'not matched' });

      const preview = mod.dryRunBulkOperation('cancel', { status: 'queued' });
      expect(preview.operation_type).toBe('cancel');
      expect(preview.total_tasks).toBe(2);
      expect(preview.affected_task_ids.sort()).toEqual([t1.id, t2.id].sort());
      expect(preview.preview.length).toBeLessThanOrEqual(10);
    });

    it('returns empty results for non-matching filter', () => {
      const preview = mod.dryRunBulkOperation('cancel', { status: 'completed' });
      expect(preview.total_tasks).toBe(0);
      expect(preview.affected_task_ids).toEqual([]);
    });
  });

  describe('getTasksMatchingFilter', () => {
    it('filters by status array', () => {
      mkTask({ status: 'queued' });
      mkTask({ status: 'failed' });
      mkTask({ status: 'completed' });

      const tasks = mod.getTasksMatchingFilter({ status: ['queued', 'failed'] });
      expect(tasks).toHaveLength(2);
    });

    it('filters by single status string', () => {
      mkTask({ status: 'queued' });
      mkTask({ status: 'failed' });

      const tasks = mod.getTasksMatchingFilter({ status: 'queued' });
      expect(tasks).toHaveLength(1);
    });

    it('filters by tags', () => {
      mkTask({ status: 'queued', tags: ['frontend'] });
      mkTask({ status: 'queued', tags: ['backend'] });

      const tasks = mod.getTasksMatchingFilter({ tags: ['frontend'] });
      expect(tasks).toHaveLength(1);
    });

    it('filters by project', () => {
      mkTask({ status: 'queued', project: 'alpha' });
      mkTask({ status: 'queued', project: 'beta' });

      const tasks = mod.getTasksMatchingFilter({ project: 'alpha' });
      expect(tasks).toHaveLength(1);
    });

    it('filters by older_than_hours', () => {
      const old = mkTask({ status: 'queued' });
      const fresh = mkTask({ status: 'queued' });
      patchTask(old.id, { created_at: isoNowMinusHours(5) });
      patchTask(fresh.id, { created_at: isoNowMinusHours(1) });

      const tasks = mod.getTasksMatchingFilter({ older_than_hours: 3 });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(old.id);
    });

    it('combines multiple filters', () => {
      const target = mkTask({ status: 'queued', project: 'proj-a', tags: ['tag-x'] });
      patchTask(target.id, { created_at: isoNowMinusHours(5) });
      mkTask({ status: 'queued', project: 'proj-b', tags: ['tag-x'] });
      mkTask({ status: 'failed', project: 'proj-a', tags: ['tag-x'] });

      const tasks = mod.getTasksMatchingFilter({
        status: 'queued',
        project: 'proj-a',
        tags: ['tag-x'],
        older_than_hours: 3
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(target.id);
    });

    it('returns all tasks with empty filter', () => {
      mkTask({});
      mkTask({});
      mkTask({});

      const tasks = mod.getTasksMatchingFilter({});
      expect(tasks).toHaveLength(3);
    });
  });
});
