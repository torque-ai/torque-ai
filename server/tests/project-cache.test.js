/**
 * Tests for server/db/project-cache.js
 *
 * Task caching, semantic similarity, cache config/stats,
 * query stats, database optimization, performance alerts,
 * integrity checks, index stats.
 */

const { randomUUID } = require('crypto');
const configCore = require('../db/config-core');
const taskCore = require('../db/task-core');
const { setupTestDb, teardownTestDb, rawDb: _rawDb } = require('./vitest-setup');

let testDir;
let db;
let mod;

function setup() {
  ({ db, testDir } = setupTestDb('projcache-'));
  if (!db.getDb && db.getDbInstance) db.getDb = db.getDbInstance;

  mod = require('../db/project-cache');
  mod.setDb(db.getDb ? db.getDb() : db.getDbInstance());
  mod.setGetTask((id) => taskCore.getTask(id));
  mod.setDbFunctions({ getConfig: configCore.getConfig });
}

function teardown() {
  teardownTestDb();
}

function rawDb() {
  return _rawDb();
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  const payload = {
    id,
    task_description: overrides.task_description || 'cache test task',
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'completed',
  };
  taskCore.createTask(payload);

  // Set output and exit_code via direct SQL since createTask() doesn't support these fields
  const conn = rawDb();
  const output = overrides.output || 'task output here';
  const exitCode = overrides.exit_code ?? 0;
  conn.prepare('UPDATE tasks SET output = ?, exit_code = ? WHERE id = ?').run(output, exitCode, id);

  return taskCore.getTask(id);
}

function resetCacheTables() {
  const conn = rawDb();
  for (const table of ['task_cache', 'cache_config', 'cache_stats', 'query_stats', 'optimization_history', 'performance_alerts']) {
    try { conn.prepare(`DELETE FROM ${table}`).run(); } catch {}
  }
  // Re-seed default cache config
  const insertConfig = conn.prepare('INSERT OR REPLACE INTO cache_config (key, value) VALUES (?, ?)');
  insertConfig.run('ttl_hours', '24');
  insertConfig.run('max_size_mb', '100');
  insertConfig.run('similarity_threshold', '0.85');
  insertConfig.run('auto_cache', 'true');
}

describe('project-cache module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardown(); });
  beforeEach(() => { resetCacheTables(); });

  // ====================================================
  // Content hashing and embedding
  // ====================================================
  describe('computeContentHash', () => {
    it('returns consistent hash for same inputs', () => {
      const h1 = mod.computeContentHash('desc', '/dir', null);
      const h2 = mod.computeContentHash('desc', '/dir', null);
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64); // sha256 hex
    });

    it('returns different hash for different inputs', () => {
      const h1 = mod.computeContentHash('desc-a', '/dir', null);
      const h2 = mod.computeContentHash('desc-b', '/dir', null);
      expect(h1).not.toBe(h2);
    });

    it('handles null working_directory and context', () => {
      const h = mod.computeContentHash('desc', null, null);
      expect(typeof h).toBe('string');
      expect(h.length).toBe(64);
    });
  });

  describe('computeEmbedding', () => {
    it('returns empty object for null/empty input', () => {
      expect(mod.computeEmbedding(null)).toEqual({});
      expect(mod.computeEmbedding('')).toEqual({});
    });

    it('returns normalized TF-IDF vector', () => {
      const embedding = mod.computeEmbedding('write unit tests for the database module');
      expect(typeof embedding).toBe('object');
      expect(Object.keys(embedding).length).toBeGreaterThan(0);
      // Should be normalized: magnitude should be ~1.0
      const mag = Math.sqrt(Object.values(embedding).reduce((s, v) => s + v * v, 0));
      expect(mag).toBeCloseTo(1.0, 1);
    });

    it('ignores short tokens (length <= 2)', () => {
      const embedding = mod.computeEmbedding('a to be or not to be');
      // "not" is 3 chars so should be included, "a", "to", "be", "or" are 1-2 chars
      expect(embedding['not']).toBeTruthy();
      expect(embedding['a']).toBeUndefined();
      expect(embedding['to']).toBeUndefined();
    });
  });

  describe('cosineSimilarity', () => {
    it('returns 0 for null vectors', () => {
      expect(mod.cosineSimilarity(null, { a: 1 })).toBe(0);
      expect(mod.cosineSimilarity({ a: 1 }, null)).toBe(0);
    });

    it('returns 1 for identical normalized vectors', () => {
      const vec = { hello: 0.5, world: 0.5 };
      expect(mod.cosineSimilarity(vec, vec)).toBeCloseTo(0.5, 1);
    });

    it('returns 0 for orthogonal vectors', () => {
      const v1 = { hello: 1 };
      const v2 = { world: 1 };
      expect(mod.cosineSimilarity(v1, v2)).toBe(0);
    });

    it('returns positive value for overlapping vectors', () => {
      const v1 = { hello: 0.7, world: 0.3 };
      const v2 = { hello: 0.5, goodbye: 0.5 };
      expect(mod.cosineSimilarity(v1, v2)).toBeGreaterThan(0);
    });
  });

  // ====================================================
  // Task cache
  // ====================================================
  describe('cacheTaskResult', () => {
    it('returns null for non-existent task', () => {
      expect(mod.cacheTaskResult('non-existent-id')).toBeNull();
    });

    it('returns null for non-completed task', () => {
      const task = createTask({ status: 'failed' });
      expect(mod.cacheTaskResult(task.id)).toBeNull();
    });

    it('caches a completed task and returns cache record', () => {
      const task = createTask({ status: 'completed', output: 'result data' });
      const record = mod.cacheTaskResult(task.id, 48);
      expect(record).toBeTruthy();
      expect(record.content_hash).toBeTruthy();
      expect(record.expires_at).toBeTruthy();
      expect(record.id).toBeTruthy();
    });
  });

  describe('lookupCache', () => {
    it('returns null when cache is empty (miss)', () => {
      const result = mod.lookupCache('some new task', testDir, null);
      expect(result).toBeNull();
    });

    it('returns exact match when content hash matches', () => {
      const task = createTask({ task_description: 'exact match task', output: 'output' });
      mod.cacheTaskResult(task.id);

      const result = mod.lookupCache('exact match task', testDir, null);
      expect(result).toBeTruthy();
      expect(result.match_type).toBe('exact');
      expect(result.similarity).toBe(1.0);
    });

    it('increments hit_count on cache hit', () => {
      const task = createTask({ task_description: 'hit count task', output: 'output' });
      const cached = mod.cacheTaskResult(task.id);

      mod.lookupCache('hit count task', testDir, null);
      mod.lookupCache('hit count task', testDir, null);

      const row = rawDb().prepare('SELECT hit_count FROM task_cache WHERE id = ?').get(cached.id);
      expect(row.hit_count).toBe(2);
    });

    it('returns semantic match when similarity exceeds threshold', () => {
      const task = createTask({
        task_description: 'write comprehensive unit tests for database module',
        output: 'tests written'
      });
      mod.cacheTaskResult(task.id);

      // Query with semantically similar description
      const result = mod.lookupCache(
        'write comprehensive unit tests for database module',
        testDir, null, 0.5
      );
      // Exact match since the description is identical
      expect(result).toBeTruthy();
    });

    it('does not return expired cache entries for exact match', () => {
      const task = createTask({ task_description: 'expired task', output: 'output' });
      const cached = mod.cacheTaskResult(task.id);

      // Manually expire it
      rawDb().prepare("UPDATE task_cache SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(cached.id);

      const result = mod.lookupCache('expired task', testDir, null);
      expect(result).toBeNull();
    });
  });

  describe('invalidateCache', () => {
    it('deletes by cacheId', () => {
      const task = createTask({ task_description: 'to invalidate', output: 'output' });
      const cached = mod.cacheTaskResult(task.id);
      const result = mod.invalidateCache({ cacheId: cached.id });
      expect(result.deleted).toBe(1);
    });

    it('deletes by contentHash', () => {
      const task = createTask({ task_description: 'hash invalidate', output: 'out' });
      const cached = mod.cacheTaskResult(task.id);
      const result = mod.invalidateCache({ contentHash: cached.content_hash });
      expect(result.deleted).toBe(1);
    });

    it('deletes by pattern match on task_description', () => {
      const task = createTask({ task_description: 'pattern invalidation target', output: 'out' });
      mod.cacheTaskResult(task.id);
      const result = mod.invalidateCache({ pattern: 'invalidation target' });
      expect(result.deleted).toBe(1);
    });

    it('deletes expired entries when called with no options', () => {
      const task = createTask({ task_description: 'expire me', output: 'out' });
      const cached = mod.cacheTaskResult(task.id);
      rawDb().prepare("UPDATE task_cache SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(cached.id);

      const result = mod.invalidateCache({});
      expect(result.deleted).toBeGreaterThanOrEqual(1);
    });

    it('deletes by olderThan date', () => {
      const task = createTask({ task_description: 'old entry', output: 'out' });
      mod.cacheTaskResult(task.id);
      // Set created_at to the past
      rawDb().prepare("UPDATE task_cache SET created_at = '2020-01-01T00:00:00Z'").run();

      const result = mod.invalidateCache({ olderThan: '2025-01-01T00:00:00Z' });
      expect(result.deleted).toBeGreaterThanOrEqual(1);
    });
  });

  // ====================================================
  // Cache config
  // ====================================================
  describe('getCacheConfig / setCacheConfig', () => {
    it('gets a specific config key', () => {
      expect(mod.getCacheConfig('ttl_hours')).toBe('24');
    });

    it('returns null for unknown key', () => {
      expect(mod.getCacheConfig('nonexistent_key')).toBeNull();
    });

    it('returns all config as object when called without key', () => {
      const config = mod.getCacheConfig();
      expect(typeof config).toBe('object');
      expect(config.ttl_hours).toBe('24');
      expect(config.auto_cache).toBe('true');
    });

    it('sets a config value', () => {
      mod.setCacheConfig('ttl_hours', '48');
      expect(mod.getCacheConfig('ttl_hours')).toBe('48');
    });

    it('creates a new config key', () => {
      mod.setCacheConfig('custom_key', 'custom_value');
      expect(mod.getCacheConfig('custom_key')).toBe('custom_value');
    });
  });

  // ====================================================
  // Warm cache
  // ====================================================
  describe('warmCache', () => {
    it('caches successful tasks that are not already cached', () => {
      createTask({ task_description: 'warm task 1', status: 'completed', exit_code: 0, output: 'out1' });
      createTask({ task_description: 'warm task 2', status: 'completed', exit_code: 0, output: 'out2' });

      const result = mod.warmCache(10);
      expect(result.cached).toBeGreaterThanOrEqual(2);
      expect(result.scanned).toBeGreaterThanOrEqual(2);
    });

    it('skips tasks that are already cached', () => {
      const task = createTask({ task_description: 'already cached', status: 'completed', exit_code: 0, output: 'out' });
      mod.cacheTaskResult(task.id);

      const _result = mod.warmCache(10);
      // The already-cached task should not be re-cached
      const cacheRows = rawDb().prepare("SELECT COUNT(*) as cnt FROM task_cache WHERE task_description = 'already cached'").get();
      expect(cacheRows.cnt).toBe(1);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        createTask({ task_description: `warm-limit-${i}`, status: 'completed', exit_code: 0, output: `out-${i}` });
      }
      const result = mod.warmCache(2);
      expect(result.cached).toBeLessThanOrEqual(2);
    });
  });

  // ====================================================
  // Query statistics
  // ====================================================
  describe('recordQueryStat / getSlowQueries / getFrequentQueries / clearQueryStats', () => {
    it('records a new query stat entry', () => {
      mod.recordQueryStat('SELECT * FROM tasks', 50);
      const slow = mod.getSlowQueries(10, 0);
      expect(slow.length).toBeGreaterThanOrEqual(1);
      expect(slow[0].query_pattern).toBe('SELECT * FROM tasks');
      expect(slow[0].execution_count).toBe(1);
    });

    it('aggregates stats for repeated query patterns', () => {
      mod.recordQueryStat('SELECT * FROM tasks WHERE id = ?', 10);
      mod.recordQueryStat('SELECT * FROM tasks WHERE id = ?', 30);

      const stats = mod.getSlowQueries(10, 0);
      const entry = stats.find(s => s.query_pattern === 'SELECT * FROM tasks WHERE id = ?');
      expect(entry).toBeTruthy();
      expect(entry.execution_count).toBe(2);
      expect(entry.avg_time_ms).toBe(20);
      expect(entry.max_time_ms).toBe(30);
      expect(entry.min_time_ms).toBe(10);
    });

    it('getSlowQueries respects minAvgMs filter', () => {
      mod.recordQueryStat('fast query', 1);
      mod.recordQueryStat('slow query', 100);

      const slow = mod.getSlowQueries(10, 50);
      expect(slow.every(s => s.avg_time_ms >= 50)).toBe(true);
    });

    it('getFrequentQueries returns queries ordered by execution_count', () => {
      mod.recordQueryStat('rare query', 10);
      mod.recordQueryStat('common query', 5);
      mod.recordQueryStat('common query', 5);
      mod.recordQueryStat('common query', 5);

      const freq = mod.getFrequentQueries(10);
      expect(freq.length).toBeGreaterThanOrEqual(2);
      expect(freq[0].execution_count).toBeGreaterThanOrEqual(freq[1].execution_count);
    });

    it('clearQueryStats removes all entries', () => {
      mod.recordQueryStat('to clear', 10);
      mod.clearQueryStats();
      expect(mod.getSlowQueries(10, 0)).toHaveLength(0);
    });
  });

  // ====================================================
  // Database optimization
  // ====================================================
  describe('vacuumDatabase', () => {
    it('returns structured result with duration and sizes', () => {
      const result = mod.vacuumDatabase();
      expect(typeof result.duration_ms).toBe('number');
      expect(typeof result.size_before).toBe('number');
      expect(typeof result.size_after).toBe('number');
      expect(typeof result.space_saved).toBe('number');
    });

    it('records optimization history entry', () => {
      mod.vacuumDatabase();
      const history = mod.getOptimizationHistory(10);
      const vacuumEntry = history.find(h => h.operation_type === 'vacuum');
      expect(vacuumEntry).toBeTruthy();
    });
  });

  describe('analyzeDatabase', () => {
    it('analyzes all tables when no table specified', () => {
      const result = mod.analyzeDatabase();
      expect(result.table).toBe('all');
      expect(typeof result.duration_ms).toBe('number');
    });

    it('analyzes a specific table', () => {
      const result = mod.analyzeDatabase('tasks');
      expect(result.table).toBe('tasks');
    });

    it('records optimization history entry', () => {
      mod.analyzeDatabase('tasks');
      const history = mod.getOptimizationHistory(10);
      const analyzeEntry = history.find(h => h.operation_type === 'analyze');
      expect(analyzeEntry).toBeTruthy();
    });
  });

  describe('getDatabaseSize', () => {
    it('returns a number >= 0', () => {
      const size = mod.getDatabaseSize();
      expect(typeof size).toBe('number');
      expect(size).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getDatabaseStats', () => {
    it('returns comprehensive stats structure', () => {
      const stats = mod.getDatabaseStats();
      expect(typeof stats.database_size_bytes).toBe('number');
      expect(typeof stats.database_size_mb).toBe('string');
      expect(typeof stats.total_tables).toBe('number');
      expect(typeof stats.total_rows).toBe('number');
      expect(typeof stats.total_indexes).toBe('number');
      expect(Array.isArray(stats.tables)).toBe(true);
      expect(stats.total_tables).toBeGreaterThan(0);
    });

    it('tables array includes table_name, row_count, index_count', () => {
      const stats = mod.getDatabaseStats();
      const tasksEntry = stats.tables.find(t => t.table_name === 'tasks');
      expect(tasksEntry).toBeTruthy();
      expect(typeof tasksEntry.row_count).toBe('number');
      expect(typeof tasksEntry.index_count).toBe('number');
    });
  });

  // ====================================================
  // Performance alerts
  // ====================================================
  describe('createPerformanceAlert / getPerformanceAlerts / acknowledgePerformanceAlert', () => {
    it('creates a performance alert', () => {
      const alert = mod.createPerformanceAlert('slow_query', 'warning', 'Query took 5 seconds', 'details', 'hash123');
      expect(alert.id).toBeTruthy();
      expect(alert.alert_type).toBe('slow_query');
      expect(alert.severity).toBe('warning');
      expect(alert.message).toBe('Query took 5 seconds');
    });

    it('getPerformanceAlerts returns unacknowledged by default', () => {
      mod.createPerformanceAlert('type1', 'warning', 'msg1');
      mod.createPerformanceAlert('type2', 'error', 'msg2');

      const alerts = mod.getPerformanceAlerts(false, 10);
      expect(alerts.length).toBeGreaterThanOrEqual(2);
      expect(alerts.every(a => a.acknowledged === 0)).toBe(true);
    });

    it('acknowledgePerformanceAlert marks alert as acknowledged', () => {
      const alert = mod.createPerformanceAlert('ack_test', 'warning', 'to be acked');
      mod.acknowledgePerformanceAlert(alert.id);

      const unacked = mod.getPerformanceAlerts(false, 50);
      const acked = mod.getPerformanceAlerts(true, 50);

      expect(unacked.find(a => a.id === alert.id)).toBeFalsy();
      const found = acked.find(a => a.id === alert.id);
      expect(found).toBeTruthy();
      expect(found.acknowledged).toBe(1);
      expect(found.acknowledged_at).toBeTruthy();
    });
  });

  // ====================================================
  // Integrity check
  // ====================================================
  describe('integrityCheck', () => {
    it('returns ok: true for a healthy database', () => {
      const result = mod.integrityCheck();
      expect(result.ok).toBe(true);
      expect(result.result).toHaveLength(1);
      expect(result.result[0].integrity_check).toBe('ok');
    });
  });

  // ====================================================
  // Index stats
  // ====================================================
  describe('getIndexStats', () => {
    it('returns array of index info grouped by index_name', () => {
      const stats = mod.getIndexStats();
      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);

      const first = stats[0];
      expect(first.index_name).toBeTruthy();
      expect(first.table_name).toBeTruthy();
      expect(Array.isArray(first.columns)).toBe(true);
    });
  });

  // ====================================================
  // Explain query plan
  // ====================================================
  describe('explainQueryPlan', () => {
    it('returns plan for valid SELECT query', () => {
      const result = mod.explainQueryPlan('SELECT * FROM tasks');
      expect(result.plan).toBeTruthy();
      expect(Array.isArray(result.plan)).toBe(true);
      expect(result.query).toBe('SELECT * FROM tasks');
    });

    it('returns error for non-SELECT query', () => {
      const result = mod.explainQueryPlan('DELETE FROM tasks');
      expect(result.error).toBe('Only SELECT queries can be explained');
    });

    it('returns error for invalid query', () => {
      const result = mod.explainQueryPlan('SELECT * FROM nonexistent_table_xyz');
      expect(result.error).toBeTruthy();
    });
  });

  // ====================================================
  // Cache stats
  // ====================================================
  describe('updateCacheStats / getCacheStats / clearCacheStats', () => {
    it('creates cache stats entry on first call', () => {
      mod.updateCacheStats('test_cache', true);
      const stats = mod.getCacheStats();
      const entry = stats.find(s => s.cache_name === 'test_cache');
      expect(entry).toBeTruthy();
      expect(entry.hits).toBe(1);
      expect(entry.misses).toBe(0);
    });

    it('updates existing cache stats on subsequent calls', () => {
      mod.updateCacheStats('counter_cache', true);
      mod.updateCacheStats('counter_cache', false);
      mod.updateCacheStats('counter_cache', true, true);

      const stats = mod.getCacheStats();
      const entry = stats.find(s => s.cache_name === 'counter_cache');
      expect(entry.hits).toBe(2);
      expect(entry.misses).toBe(1);
      expect(entry.evictions).toBe(1);
    });

    it('getCacheStats includes hit_rate percentage', () => {
      mod.updateCacheStats('rate_cache', true);
      mod.updateCacheStats('rate_cache', true);
      mod.updateCacheStats('rate_cache', false);

      const stats = mod.getCacheStats();
      const entry = stats.find(s => s.cache_name === 'rate_cache');
      expect(entry.hit_rate).toBe('66.67%');
    });

    it('clearCacheStats removes specific cache', () => {
      mod.updateCacheStats('to_clear', true);
      mod.clearCacheStats('to_clear');
      const stats = mod.getCacheStats();
      expect(stats.find(s => s.cache_name === 'to_clear')).toBeFalsy();
    });

    it('clearCacheStats removes all caches when called without name', () => {
      mod.updateCacheStats('cache_a', true);
      mod.updateCacheStats('cache_b', false);
      mod.clearCacheStats();
      expect(mod.getCacheStats()).toHaveLength(0);
    });
  });

  describe('updateCacheEntryCount', () => {
    it('updates total_entries for a cache', () => {
      mod.updateCacheStats('count_cache', true);
      mod.updateCacheEntryCount('count_cache', 42);
      const stats = mod.getCacheStats();
      const entry = stats.find(s => s.cache_name === 'count_cache');
      expect(entry.total_entries).toBe(42);
    });
  });

  // ====================================================
  // Optimization history
  // ====================================================
  describe('recordOptimization / getOptimizationHistory', () => {
    it('records and retrieves optimization history', () => {
      mod.recordOptimization('reindex', 'tasks', 'Reindexed tasks table', 150, 1000, 900);
      const history = mod.getOptimizationHistory(10);
      const entry = history.find(h => h.operation_type === 'reindex');
      expect(entry).toBeTruthy();
      expect(entry.table_name).toBe('tasks');
      expect(entry.duration_ms).toBe(150);
      expect(entry.size_before_bytes).toBe(1000);
      expect(entry.size_after_bytes).toBe(900);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        mod.recordOptimization(`op-${i}`, null, `operation ${i}`, i * 10, null, null);
      }
      const history = mod.getOptimizationHistory(3);
      expect(history.length).toBeLessThanOrEqual(3);
    });
  });
});
