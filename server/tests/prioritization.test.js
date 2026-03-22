const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const taskCore = require('../db/task-core');

let testDir, origDataDir, db, mod;
const TEMPLATE_BUF_PATH = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
let templateBuffer;

function setup() {
  testDir = path.join(os.tmpdir(), `torque-vtest-prioritization-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  origDataDir = process.env.TORQUE_DATA_DIR;
  process.env.TORQUE_DATA_DIR = testDir;

  db = require('../database');
  if (!templateBuffer) templateBuffer = fs.readFileSync(TEMPLATE_BUF_PATH);
  db.resetForTest(templateBuffer);
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;
  mod = require('../db/analytics');
  mod.setDb(db.getDb());
  mod.setGetTask((id) => taskCore.getTask(id));
  // Provide a stub findSimilarTasks that returns empty by default
  mod.setFindSimilarTasks(() => []);
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
  const tables = ['task_priority_scores', 'priority_config', 'duration_predictions', 'task_dependencies', 'tasks'];
  for (const table of tables) {
    try { rawDb().prepare(`DELETE FROM ${table}`).run(); } catch {}
  }
}

function mkTask(overrides = {}) {
  const task = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || `prio-task-${Math.random().toString(36).slice(2)}`,
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'queued',
    timeout_minutes: overrides.timeout_minutes ?? 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    max_retries: overrides.max_retries ?? 2,
    retry_count: overrides.retry_count ?? 0,
    provider: overrides.provider || 'codex',
    workflow_id: overrides.workflow_id || null
  };
  taskCore.createTask(task);
  return taskCore.getTask(task.id);
}

describe('prioritization module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetState(); });

  describe('computeResourceScore', () => {
    it('gives higher score to shorter tasks', () => {
      const shortTask = mkTask({ timeout_minutes: 5 });
      const longTask = mkTask({ timeout_minutes: 60 });

      const shortScore = mod.computeResourceScore(shortTask);
      const longScore = mod.computeResourceScore(longTask);

      expect(shortScore).toBeGreaterThan(longScore);
    });

    it('uses duration prediction when available', () => {
      const task = mkTask({ timeout_minutes: 60 });
      rawDb().prepare(`
        INSERT INTO duration_predictions (task_id, predicted_seconds, confidence, factors, created_at)
        VALUES (?, 60, 0.8, '[]', ?)
      `).run(task.id, new Date().toISOString());

      const score = mod.computeResourceScore(task);
      // 60 seconds out of 3600 max = high score
      expect(score).toBeGreaterThan(0.9);
    });

    it('returns score between 0 and 1', () => {
      const task = mkTask({ timeout_minutes: 30 });
      const score = mod.computeResourceScore(task);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe('computeSuccessScore', () => {
    it('returns 0.5 when no similar tasks found', () => {
      const task = mkTask();
      const score = mod.computeSuccessScore(task);
      expect(score).toBe(0.5);
    });

    it('computes success rate from similar tasks', () => {
      // findSimilarTasks returns [{ task, similarity }] shape
      mod.setFindSimilarTasks(() => [
        { task: { status: 'completed', exit_code: 0 }, similarity: 0.9 },
        { task: { status: 'completed', exit_code: 0 }, similarity: 0.8 },
        { task: { status: 'failed', exit_code: 1 }, similarity: 0.7 }
      ]);

      const task = mkTask();
      const score = mod.computeSuccessScore(task);
      expect(score).toBeCloseTo(2/3, 2);

      // Reset stub
      mod.setFindSimilarTasks(() => []);
    });

    it('returns 0 when all similar tasks failed', () => {
      mod.setFindSimilarTasks(() => [
        { task: { status: 'failed', exit_code: 1 }, similarity: 0.9 },
        { task: { status: 'failed', exit_code: 1 }, similarity: 0.8 }
      ]);

      const task = mkTask();
      const score = mod.computeSuccessScore(task);
      expect(score).toBe(0);

      mod.setFindSimilarTasks(() => []);
    });
  });

  describe('computeDependencyScore', () => {
    it('returns 0.5 when task has no workflow', () => {
      const task = mkTask();
      const score = mod.computeDependencyScore(task);
      expect(score).toBe(0.5);
    });

    it('returns 0 when task has no dependents', () => {
      const task = mkTask({ workflow_id: 'wf-1' });
      const score = mod.computeDependencyScore(task);
      expect(score).toBe(0);
    });
  });

  describe('priority weights', () => {
    it('returns default weights when not configured', () => {
      const weights = mod.getPriorityWeights();
      expect(weights.resource).toBe(0.3);
      expect(weights.success).toBe(0.3);
      expect(weights.dependency).toBe(0.4);
    });

    it('persists custom weights', () => {
      mod.setPriorityWeights({ resource: 0.5, success: 0.3, dependency: 0.2 });

      const weights = mod.getPriorityWeights();
      expect(weights.resource).toBe(0.5);
      expect(weights.dependency).toBe(0.2);
    });

    it('updates individual weights without affecting others', () => {
      mod.setPriorityWeights({ resource: 0.5, success: 0.3, dependency: 0.2 });
      mod.setPriorityWeights({ resource: 0.8 });

      const weights = mod.getPriorityWeights();
      expect(weights.resource).toBe(0.8);
      expect(weights.success).toBe(0.3);
    });
  });

  describe('computePriorityScore', () => {
    it('computes and stores combined priority score', () => {
      const task = mkTask();
      const result = mod.computePriorityScore(task.id);

      expect(result).toBeTruthy();
      expect(result.task_id).toBe(task.id);
      expect(result.combined_score).toBeGreaterThanOrEqual(0);
      expect(result.combined_score).toBeLessThanOrEqual(1);
      expect(result.factors).toBeTruthy();
      expect(result.factors.resource).toBeTruthy();
      expect(result.factors.success).toBeTruthy();
      expect(result.factors.dependency).toBeTruthy();
    });

    it('returns null for non-existent task', () => {
      expect(mod.computePriorityScore('missing-task')).toBeNull();
    });

    it('stores score in database', () => {
      const task = mkTask();
      mod.computePriorityScore(task.id);

      const row = rawDb().prepare('SELECT * FROM task_priority_scores WHERE task_id = ?').get(task.id);
      expect(row).toBeTruthy();
      expect(row.combined_score).toBeGreaterThanOrEqual(0);
    });

    it('includes factor breakdown', () => {
      const task = mkTask();
      const result = mod.computePriorityScore(task.id);

      expect(result.factors.resource.score).toBeDefined();
      expect(result.factors.resource.weight).toBeDefined();
      expect(result.factors.success.score).toBeDefined();
      expect(result.factors.dependency.score).toBeDefined();
    });
  });

  describe('getPriorityQueue', () => {
    it('returns queued tasks ordered by priority score', () => {
      const high = mkTask({ status: 'queued', task_description: 'high prio' });
      const low = mkTask({ status: 'queued', task_description: 'low prio' });

      mod.computePriorityScore(high.id);
      mod.computePriorityScore(low.id);

      // Boost the high priority task
      mod.boostPriority(high.id, 0.4, 'important');

      const queue = mod.getPriorityQueue();
      expect(queue.length).toBeGreaterThanOrEqual(2);
      expect(queue[0].id).toBe(high.id);
    });

    it('excludes non-queued/pending tasks', () => {
      mkTask({ status: 'completed' });
      mkTask({ status: 'queued' });

      const queue = mod.getPriorityQueue();
      expect(queue).toHaveLength(1);
    });

    it('respects minScore filter', () => {
      const task = mkTask({ status: 'queued' });
      mod.computePriorityScore(task.id);

      const queue = mod.getPriorityQueue(50, 0.99);
      // All tasks with scores below 0.99 should be excluded
      expect(queue.every(t => t.combined_score === null || t.combined_score >= 0.99)).toBe(true);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        mkTask({ status: 'queued' });
      }

      const queue = mod.getPriorityQueue(2);
      expect(queue).toHaveLength(2);
    });
  });

  describe('getHighestPriorityQueuedTask', () => {
    it('returns the highest priority queued task', () => {
      const high = mkTask({ status: 'queued' });
      const low = mkTask({ status: 'queued' });

      mod.computePriorityScore(high.id);
      mod.computePriorityScore(low.id);
      mod.boostPriority(high.id, 0.4, 'urgent');

      const top = mod.getHighestPriorityQueuedTask();
      expect(top.id).toBe(high.id);
    });

    it('returns undefined when no queued tasks exist', () => {
      mkTask({ status: 'completed' });
      expect(mod.getHighestPriorityQueuedTask()).toBeUndefined();
    });
  });

  describe('boostPriority', () => {
    it('boosts existing priority score', () => {
      const task = mkTask({ status: 'queued' });
      mod.computePriorityScore(task.id);

      const existing = rawDb().prepare('SELECT combined_score FROM task_priority_scores WHERE task_id = ?').get(task.id);
      const result = mod.boostPriority(task.id, 0.2, 'urgent');

      expect(result.previous_score).toBe(existing.combined_score);
      expect(result.new_score).toBeCloseTo(existing.combined_score + 0.2, 5);
    });

    it('creates new entry when no existing score', () => {
      const task = mkTask({ status: 'queued' });
      const result = mod.boostPriority(task.id, 0.3, 'new boost');

      expect(result.previous_score).toBe(0.5);
      expect(result.new_score).toBe(0.8);
    });

    it('clamps score to [0, 1] range', () => {
      const task = mkTask({ status: 'queued' });
      const result = mod.boostPriority(task.id, 0.9, 'max boost');
      expect(result.new_score).toBeLessThanOrEqual(1);

      const result2 = mod.boostPriority(task.id, -2.0, 'negative boost');
      expect(result2.new_score).toBeGreaterThanOrEqual(0);
    });

    it('records manual_boost in factors', () => {
      const task = mkTask({ status: 'queued' });
      mod.boostPriority(task.id, 0.1, 'test reason');

      const row = rawDb().prepare('SELECT factors FROM task_priority_scores WHERE task_id = ?').get(task.id);
      const factors = JSON.parse(row.factors);
      expect(factors.manual_boost).toBeTruthy();
      expect(factors.manual_boost.reason).toBe('test reason');
    });
  });
});
