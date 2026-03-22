const { randomUUID } = require('crypto');
const { setupTestDbModule, teardownTestDb, rawDb } = require('./vitest-setup');

let db, mod;
const taskCore = require('../db/task-core');

function setup() {
  ({ db, mod } = setupTestDbModule('../db/task-metadata', 'task-artifacts'));
}

function resetState() {
  rawDb().prepare('DELETE FROM task_artifacts').run();
  // Reset artifact config to defaults
  mod.setArtifactConfig('max_per_task', '20');
  mod.setArtifactConfig('retention_days', '30');
}

function mkTask(overrides = {}) {
  const task = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'artifact test task',
    working_directory: overrides.working_directory || '/tmp/test',
    status: overrides.status || 'queued',
    timeout_minutes: overrides.timeout_minutes ?? 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    max_retries: overrides.max_retries ?? 2,
    retry_count: overrides.retry_count ?? 0,
    provider: overrides.provider || 'codex'
  };
  taskCore.createTask(task);
  return taskCore.getTask(task.id);
}

describe('task-artifacts module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { resetState(); });

  describe('storeArtifact + getArtifact', () => {
    it('stores and retrieves artifact with metadata', () => {
      const t = mkTask({ task_description: 'artifact task' });
      const id = randomUUID();
      const stored = mod.storeArtifact({
        id,
        task_id: t.id,
        name: 'report.json',
        file_path: '/tmp/report.json',
        mime_type: 'application/json',
        size_bytes: 1234,
        checksum: 'abc123',
        metadata: { source: 'unit-test' }
      });

      expect(stored.id).toBe(id);
      const loaded = mod.getArtifact(id);
      expect(loaded.metadata).toEqual({ source: 'unit-test' });
      expect(loaded.mime_type).toBe('application/json');
      expect(loaded.size_bytes).toBe(1234);
    });

    it('stores artifact with minimal fields', () => {
      const t = mkTask();
      const id = randomUUID();
      const stored = mod.storeArtifact({
        id,
        task_id: t.id,
        name: 'simple.txt',
        file_path: '/tmp/simple.txt'
      });

      expect(stored.name).toBe('simple.txt');
      expect(stored.metadata).toBeNull();
      expect(stored.mime_type).toBeNull();
    });

    it('returns undefined for non-existent artifact', () => {
      expect(mod.getArtifact('missing-id')).toBeUndefined();
    });

    it('sets expires_at based on retention_days config', () => {
      const t = mkTask();
      const id = randomUUID();
      mod.storeArtifact({
        id,
        task_id: t.id,
        name: 'expiring.txt',
        file_path: '/tmp/expiring.txt'
      });

      const loaded = mod.getArtifact(id);
      expect(loaded.expires_at).toBeTruthy();
      const expiresDate = new Date(loaded.expires_at);
      const now = new Date();
      // Should expire roughly 30 days from now
      const diffDays = (expiresDate - now) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(28);
      expect(diffDays).toBeLessThan(32);
    });
  });

  describe('listArtifacts', () => {
    it('returns only artifacts for the requested task', () => {
      const t1 = mkTask({ task_description: 'artifact owner 1' });
      const t2 = mkTask({ task_description: 'artifact owner 2' });
      mod.storeArtifact({ id: randomUUID(), task_id: t1.id, name: 'a.txt', file_path: '/tmp/a.txt' });
      mod.storeArtifact({ id: randomUUID(), task_id: t1.id, name: 'b.txt', file_path: '/tmp/b.txt' });
      mod.storeArtifact({ id: randomUUID(), task_id: t2.id, name: 'c.txt', file_path: '/tmp/c.txt' });

      const list1 = mod.listArtifacts(t1.id);
      expect(list1).toHaveLength(2);
      expect(list1.every(a => a.task_id === t1.id)).toBe(true);
    });

    it('returns empty array for task with no artifacts', () => {
      expect(mod.listArtifacts('no-artifacts-task')).toEqual([]);
    });

    it('parses metadata in listed artifacts', () => {
      const t = mkTask();
      mod.storeArtifact({
        id: randomUUID(),
        task_id: t.id,
        name: 'meta.txt',
        file_path: '/tmp/meta.txt',
        metadata: { key: 'value' }
      });

      const [artifact] = mod.listArtifacts(t.id);
      expect(artifact.metadata).toEqual({ key: 'value' });
    });
  });

  describe('deleteArtifact', () => {
    it('deletes an existing artifact', () => {
      const t = mkTask();
      const aid = randomUUID();
      mod.storeArtifact({ id: aid, task_id: t.id, name: 'del.txt', file_path: '/tmp/del.txt' });

      expect(mod.deleteArtifact(aid)).toBe(true);
      expect(mod.getArtifact(aid)).toBeUndefined();
    });

    it('returns false for non-existent artifact', () => {
      expect(mod.deleteArtifact('does-not-exist')).toBe(false);
    });
  });

  describe('artifact config', () => {
    it('gets and sets config values', () => {
      mod.setArtifactConfig('max_per_task', '5');
      const config = mod.getArtifactConfig();
      expect(config.max_per_task).toBe('5');
    });

    it('converts values to strings', () => {
      mod.setArtifactConfig('retention_days', 90);
      const config = mod.getArtifactConfig();
      expect(config.retention_days).toBe('90');
    });

    it('returns full config object', () => {
      const config = mod.getArtifactConfig();
      expect(config.max_per_task).toBeTruthy();
      expect(config.retention_days).toBeTruthy();
    });
  });

  describe('max_per_task enforcement', () => {
    it('enforces max_per_task limit', () => {
      const t = mkTask({ task_description: 'artifact limit task' });
      mod.setArtifactConfig('max_per_task', '2');

      mod.storeArtifact({ id: randomUUID(), task_id: t.id, name: 'first.txt', file_path: '/tmp/1.txt' });
      mod.storeArtifact({ id: randomUUID(), task_id: t.id, name: 'second.txt', file_path: '/tmp/2.txt' });

      expect(() => mod.storeArtifact({
        id: randomUUID(),
        task_id: t.id,
        name: 'third.txt',
        file_path: '/tmp/3.txt'
      })).toThrow(/Maximum artifacts per task/);
    });

    it('allows artifacts on different tasks independently', () => {
      mod.setArtifactConfig('max_per_task', '1');
      const t1 = mkTask();
      const t2 = mkTask();

      mod.storeArtifact({ id: randomUUID(), task_id: t1.id, name: 'a.txt', file_path: '/tmp/a.txt' });
      // This should succeed because it's a different task
      const stored = mod.storeArtifact({ id: randomUUID(), task_id: t2.id, name: 'b.txt', file_path: '/tmp/b.txt' });
      expect(stored).toBeTruthy();
    });
  });

  describe('expired artifacts', () => {
    it('getExpiredArtifacts returns artifacts past expiration', () => {
      const t = mkTask();
      const id = randomUUID();
      mod.storeArtifact({ id, task_id: t.id, name: 'old.txt', file_path: '/tmp/old.txt' });

      // Force expire the artifact
      rawDb().prepare('UPDATE task_artifacts SET expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 86400000).toISOString(), id);

      const expired = mod.getExpiredArtifacts();
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe(id);
    });

    it('getExpiredArtifacts returns empty when nothing expired', () => {
      const t = mkTask();
      mod.storeArtifact({ id: randomUUID(), task_id: t.id, name: 'fresh.txt', file_path: '/tmp/fresh.txt' });

      const expired = mod.getExpiredArtifacts();
      expect(expired).toEqual([]);
    });

    it('cleanupExpiredArtifacts removes expired artifacts', () => {
      const t = mkTask();
      const id1 = randomUUID();
      const id2 = randomUUID();
      mod.storeArtifact({ id: id1, task_id: t.id, name: 'old1.txt', file_path: '/tmp/old1.txt' });
      mod.storeArtifact({ id: id2, task_id: t.id, name: 'fresh.txt', file_path: '/tmp/fresh.txt' });

      rawDb().prepare('UPDATE task_artifacts SET expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 86400000).toISOString(), id1);

      const result = mod.cleanupExpiredArtifacts();
      expect(result.deleted_count).toBe(1);
      expect(mod.getArtifact(id1)).toBeUndefined();
      expect(mod.getArtifact(id2)).toBeTruthy();
    });

    it('cleanupExpiredArtifacts returns zero when nothing to clean', () => {
      const result = mod.cleanupExpiredArtifacts();
      expect(result.deleted_count).toBe(0);
      expect(result.artifacts).toEqual([]);
    });
  });
});
