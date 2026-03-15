/**
 * db/project-cache.js — Task caching, semantic similarity, cache config/stats,
 * query stats, optimization, database health/stats, performance alerts
 * Extracted from project-config.js during decomposition
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 * Uses setter injection for cross-module dependencies.
 */

'use strict';

const crypto = require('crypto');

let db = null;
let _getTask = null;
const _dbFunctions = {};
const EXPLAIN_QUERY_ALLOWLIST = new Set([
  'tasks',
  'task_cache',
  'cache_config',
  'query_stats',
  'cache_stats',
  'optimization_history',
  'performance_alerts',
  'token_usage',
  'cost_tracking',
  'cost_budgets',
  'workflows',
  'pipeline_steps',
  'project_config'
]);
const SAFE_EXPLAIN_QUERY_PATTERN = /^SELECT\s+([\w,\s.*]+)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i;
const DANGEROUS_EXPLAIN_MARKERS = /\bUNION\b|;|--|\/\*|\*\/|\(\s*SELECT/i;
const EXPLAIN_QUERY_ERROR = 'Only SELECT queries can be explained';

function setDb(dbInstance) { db = dbInstance; }
function setGetTask(fn) { _getTask = fn; }
function setDbFunctions(fns) { Object.assign(_dbFunctions, fns); }

function getTask(...args) { return _getTask(...args); }
function _getConfig(...args) { return _dbFunctions.getConfig ? _dbFunctions.getConfig(...args) : null; }

function safeJsonParse(str, fallback = null) {
  if (!str || typeof str !== 'string') return fallback;
  if (str.length > 1048576) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function escapeLikePattern(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[%_\\]/g, '\\$&');
}

// ============================================================
// Content hashing and embedding
// ============================================================

/**
 * Compute content hash for task memoization
 */
function computeContentHash(taskDescription, workingDirectory, context) {
  const content = JSON.stringify({
    description: taskDescription,
    working_directory: workingDirectory || null,
    context: context || null
  });
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Compute TF-IDF embedding for semantic similarity
 */
function computeEmbedding(text) {
  if (!text) return {};

  // Tokenize and compute term frequencies
  const tokens = text.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const tf = {};
  tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1; });

  // Normalize to unit vector
  const magnitude = Math.sqrt(Object.values(tf).reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    Object.keys(tf).forEach(k => { tf[k] /= magnitude; });
  }

  return tf;
}

/**
 * Compute cosine similarity between two embedding vectors
 */
function cosineSimilarity(vec1, vec2) {
  if (!vec1 || !vec2) return 0;

  let dotProduct = 0;
  for (const key of Object.keys(vec1)) {
    if (vec2[key]) {
      dotProduct += vec1[key] * vec2[key];
    }
  }
  return dotProduct;
}

// ============================================================
// Task cache
// ============================================================

/**
 * Cache a task result
 * @param {string} taskId - Task identifier.
 * @param {number} [ttlHours=24] - Cache time-to-live in hours.
 * @returns {object|null} Cache record or null when not cached.
 */
function cacheTaskResult(taskId, ttlHours = 24) {
  const task = getTask(taskId);
  if (!task || task.status !== 'completed') {
    return null;
  }

  const contentHash = computeContentHash(task.task_description, task.working_directory, task.context);
  const embedding = computeEmbedding(task.task_description);
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '');

  const id = crypto.randomUUID();

  db.prepare(`
    INSERT OR REPLACE INTO task_cache
    (id, content_hash, embedding_vector, task_description, working_directory,
     result_output, result_exit_code, result_files_modified, hit_count,
     confidence_score, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0, ?, ?)
  `).run(
    id, contentHash, JSON.stringify(embedding), task.task_description,
    task.working_directory, task.output, task.exit_code,
    JSON.stringify(task.files_modified || []), now, expiresAt
  );

  return { id, content_hash: contentHash, expires_at: expiresAt };
}

/**
 * Lookup cache for exact or semantic match
 */
function lookupCache(taskDescription, workingDirectory, context, similarityThreshold = 0.85) {
  const contentHash = computeContentHash(taskDescription, workingDirectory, context);

  // First try exact match
  const exactMatch = db.prepare(`
    SELECT * FROM task_cache
    WHERE content_hash = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
    LIMIT 1
  `).get(contentHash);

  if (exactMatch) {
    // Update hit count
    db.prepare(`
      UPDATE task_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?
    `).run(new Date().toISOString().replace('T', ' ').replace('Z', ''), exactMatch.id);

    return {
      ...exactMatch,
      match_type: 'exact',
      similarity: 1.0,
      embedding_vector: safeJsonParse(exactMatch.embedding_vector, null)
    };
  }

  // Try semantic similarity match
  const queryEmbedding = computeEmbedding(taskDescription);
  const candidates = db.prepare(`
    SELECT * FROM task_cache
    WHERE expires_at IS NULL OR expires_at > datetime('now')
  `).all();

  let bestMatch = null;
  let bestSimilarity = 0;

  for (const candidate of candidates) {
    const candidateEmbedding = safeJsonParse(candidate.embedding_vector, {});
    const similarity = cosineSimilarity(queryEmbedding, candidateEmbedding);

    if (similarity > bestSimilarity && similarity >= similarityThreshold) {
      bestSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (bestMatch) {
    // Update hit count
    db.prepare(`
      UPDATE task_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?
    `).run(new Date().toISOString().replace('T', ' ').replace('Z', ''), bestMatch.id);

    return {
      ...bestMatch,
      match_type: 'semantic',
      similarity: bestSimilarity,
      confidence_score: bestSimilarity,
      embedding_vector: safeJsonParse(bestMatch.embedding_vector, null)
    };
  }

  return null;
}

/**
 * Invalidate cache entries
 */
function invalidateCache(options = {}) {
  const { cacheId, contentHash, pattern, olderThan } = options;

  if (cacheId) {
    const result = db.prepare('DELETE FROM task_cache WHERE id = ?').run(cacheId);
    return { deleted: result.changes };
  }

  if (contentHash) {
    const result = db.prepare('DELETE FROM task_cache WHERE content_hash = ?').run(contentHash);
    return { deleted: result.changes };
  }

  if (pattern) {
    const result = db.prepare("DELETE FROM task_cache WHERE task_description LIKE ? ESCAPE '\\'").run(`%${escapeLikePattern(pattern)}%`);
    return { deleted: result.changes };
  }

  if (olderThan) {
    const result = db.prepare('DELETE FROM task_cache WHERE created_at < ?').run(olderThan);
    return { deleted: result.changes };
  }

  // Clear expired entries
  const result = db.prepare(`DELETE FROM task_cache WHERE expires_at < datetime('now')`).run();
  return { deleted: result.changes };
}

/**
 * Get cache configuration
 */
function getCacheConfig(key = null) {
  if (key) {
    const row = db.prepare('SELECT value FROM cache_config WHERE key = ?').get(key);
    return row ? row.value : null;
  }
  const rows = db.prepare('SELECT key, value FROM cache_config').all();
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  return config;
}

/**
 * Set cache configuration
 */
function setCacheConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO cache_config (key, value) VALUES (?, ?)').run(key, value);
}

/**
 * Warm cache from historical successful tasks
 */
function warmCache(limit = 100, _minSuccessRate = 0.9, since = null) {
  const whereClause = since ? 'AND created_at >= ?' : '';
  const params = since ? [since] : [];

  // Get successful tasks that aren't already cached
  const _tasks = db.prepare(`
    SELECT t.* FROM tasks t
    LEFT JOIN task_cache c ON c.content_hash = ?
    WHERE t.status = 'completed'
    AND t.exit_code = 0
    AND c.id IS NULL
    ${whereClause}
    ORDER BY t.completed_at DESC
    LIMIT ?
  `).all('placeholder', ...params, limit);

  // Actually we need to check each task's hash
  const successfulTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'completed' AND exit_code = 0
    ${whereClause}
    ORDER BY completed_at DESC
    LIMIT ?
  `).all(...params, limit * 2);

  let cached = 0;
  const ttlHours = parseInt(getCacheConfig('ttl_hours') || '24', 10);

  for (const task of successfulTasks) {
    if (cached >= limit) break;

    const contentHash = computeContentHash(task.task_description, task.working_directory, task.context);
    const existing = db.prepare('SELECT id FROM task_cache WHERE content_hash = ?').get(contentHash);

    if (!existing) {
      cacheTaskResult(task.id, ttlHours);
      cached++;
    }
  }

  return { cached, scanned: successfulTasks.length };
}

// ============================================================
// Query statistics
// ============================================================

/**
 * Record query execution statistics
 */
function recordQueryStat(queryPattern, executionTimeMs) {
  const now = new Date().toISOString();
  const hash = crypto.createHash('md5').update(queryPattern).digest('hex').substring(0, 16);

  const existing = db.prepare(`
    SELECT * FROM query_stats WHERE query_hash = ?
  `).get(hash);

  if (existing) {
    const newCount = existing.execution_count + 1;
    const newTotal = existing.total_time_ms + executionTimeMs;
    const newAvg = newTotal / newCount;
    const newMax = Math.max(existing.max_time_ms, executionTimeMs);
    const newMin = Math.min(existing.min_time_ms, executionTimeMs);

    db.prepare(`
      UPDATE query_stats SET
        execution_count = ?,
        total_time_ms = ?,
        avg_time_ms = ?,
        max_time_ms = ?,
        min_time_ms = ?,
        last_executed_at = ?
      WHERE query_hash = ?
    `).run(newCount, newTotal, newAvg, newMax, newMin, now, hash);
  } else {
    db.prepare(`
      INSERT INTO query_stats (
        query_hash, query_pattern, execution_count, total_time_ms,
        avg_time_ms, max_time_ms, min_time_ms, last_executed_at, first_executed_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(hash, queryPattern, executionTimeMs, executionTimeMs, executionTimeMs, executionTimeMs, now, now);
  }
}

/**
 * Get slow queries ordered by avg execution time
 */
function getSlowQueries(limit = 20, minAvgMs = 10) {
  return db.prepare(`
    SELECT * FROM query_stats
    WHERE avg_time_ms >= ?
    ORDER BY avg_time_ms DESC
    LIMIT ?
  `).all(minAvgMs, limit);
}

/**
 * Get most frequent queries
 */
function getFrequentQueries(limit = 20) {
  return db.prepare(`
    SELECT * FROM query_stats
    ORDER BY execution_count DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Clear query statistics
 */
function clearQueryStats() {
  return db.prepare('DELETE FROM query_stats').run();
}

// ============================================================
// Cache statistics
// ============================================================

/**
 * Update cache statistics
 */
function updateCacheStats(cacheName, hit, evicted = false) {
  const now = new Date().toISOString();

  const existing = db.prepare(`
    SELECT * FROM cache_stats WHERE cache_name = ?
  `).get(cacheName);

  if (existing) {
    const updates = {
      hits: existing.hits + (hit ? 1 : 0),
      misses: existing.misses + (hit ? 0 : 1),
      evictions: existing.evictions + (evicted ? 1 : 0),
      last_hit_at: hit ? now : existing.last_hit_at,
      last_miss_at: !hit ? now : existing.last_miss_at
    };

    db.prepare(`
      UPDATE cache_stats SET
        hits = ?, misses = ?, evictions = ?,
        last_hit_at = ?, last_miss_at = ?
      WHERE cache_name = ?
    `).run(updates.hits, updates.misses, updates.evictions,
           updates.last_hit_at, updates.last_miss_at, cacheName);
  } else {
    db.prepare(`
      INSERT INTO cache_stats (
        cache_name, hits, misses, evictions, created_at,
        last_hit_at, last_miss_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(cacheName, hit ? 1 : 0, hit ? 0 : 1, now,
           hit ? now : null, hit ? null : now);
  }
}

/**
 * Update cache entry count
 */
function updateCacheEntryCount(cacheName, totalEntries) {
  db.prepare(`
    UPDATE cache_stats SET total_entries = ? WHERE cache_name = ?
  `).run(totalEntries, cacheName);
}

/**
 * Get all cache statistics
 */
function getCacheStats() {
  const stats = db.prepare('SELECT * FROM cache_stats').all();
  return stats.map(s => ({
    ...s,
    hit_rate: s.hits + s.misses > 0
      ? ((s.hits / (s.hits + s.misses)) * 100).toFixed(2) + '%'
      : '0%'
  }));
}

/**
 * Clear cache statistics
 */
function clearCacheStats(cacheName = null) {
  if (cacheName) {
    return db.prepare('DELETE FROM cache_stats WHERE cache_name = ?').run(cacheName);
  }
  return db.prepare('DELETE FROM cache_stats').run();
}

// ============================================================
// Database optimization and stats
// ============================================================

/**
 * Record optimization operation
 */
function recordOptimization(operationType, tableName, details, durationMs, sizeBefore, sizeAfter) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO optimization_history (
      operation_type, table_name, details, duration_ms,
      size_before_bytes, size_after_bytes, executed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(operationType, tableName, details, durationMs, sizeBefore, sizeAfter, now);
}

/**
 * Get optimization history
 */
function getOptimizationHistory(limit = 50) {
  return db.prepare(`
    SELECT * FROM optimization_history
    ORDER BY executed_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Get database size in bytes
 */
function getDatabaseSize() {
  try {
    const result = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get();
    return result ? result.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Run VACUUM on the database
 */
function vacuumDatabase() {
  const startTime = Date.now();
  const sizeBefore = getDatabaseSize();

  db.exec('VACUUM');

  const durationMs = Date.now() - startTime;
  const sizeAfter = getDatabaseSize();

  recordOptimization('vacuum', null, 'Full database vacuum', durationMs, sizeBefore, sizeAfter);

  return {
    duration_ms: durationMs,
    size_before: sizeBefore,
    size_after: sizeAfter,
    space_saved: sizeBefore - sizeAfter
  };
}

/**
 * Run ANALYZE on tables
 * @param {string|null} [tableName=null] - Optional table name to analyze.
 * @returns {object} Analysis timing details.
 */
function analyzeDatabase(tableName = null) {
  const startTime = Date.now();

  if (tableName) {
    // Validate table name to prevent SQL injection (only allow identifier chars)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }
    db.prepare(`ANALYZE "${tableName}"`).run();
  } else {
    db.prepare('ANALYZE').run();
  }

  const durationMs = Date.now() - startTime;
  recordOptimization('analyze', tableName, tableName ? `Analyzed ${tableName}` : 'Analyzed all tables', durationMs, null, null);

  return { duration_ms: durationMs, table: tableName || 'all' };
}

/**
 * Get comprehensive database statistics
 */
function getDatabaseStats() {
  const tableStats = db.prepare(`
    SELECT name,
           (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name = m.name) as index_count
    FROM sqlite_master m
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();

  const stats = tableStats.map(t => {
    try {
      const countResult = db.prepare(`SELECT COUNT(*) as count FROM "${t.name}"`).get();
      return {
        table_name: t.name,
        row_count: countResult.count,
        index_count: t.index_count
      };
    } catch {
      return {
        table_name: t.name,
        row_count: 0,
        index_count: t.index_count
      };
    }
  });

  const totalRows = stats.reduce((sum, s) => sum + s.row_count, 0);
  const totalIndexes = stats.reduce((sum, s) => sum + s.index_count, 0);
  const dbSize = getDatabaseSize();

  return {
    database_size_bytes: dbSize,
    database_size_mb: (dbSize / (1024 * 1024)).toFixed(2),
    total_tables: stats.length,
    total_rows: totalRows,
    total_indexes: totalIndexes,
    tables: stats.sort((a, b) => b.row_count - a.row_count)
  };
}

/**
 * Get EXPLAIN QUERY PLAN for a query
 */
function explainQueryPlan(query) {
  try {
    if (typeof query !== 'string') {
      return { error: EXPLAIN_QUERY_ERROR };
    }

    const trimmed = query.trim();
    if (!trimmed) {
      return { error: EXPLAIN_QUERY_ERROR };
    }

    if (DANGEROUS_EXPLAIN_MARKERS.test(trimmed)) {
      return { error: EXPLAIN_QUERY_ERROR };
    }

    const match = trimmed.match(SAFE_EXPLAIN_QUERY_PATTERN);
    if (!match) {
      return { error: EXPLAIN_QUERY_ERROR };
    }

    const selectClause = match[1].replace(/\s+/g, ' ').trim();
    const tableName = match[2].toLowerCase();
    if (!EXPLAIN_QUERY_ALLOWLIST.has(tableName)) {
      return { error: EXPLAIN_QUERY_ERROR };
    }

    const normalizedQuery = `SELECT ${selectClause} FROM ${tableName}`;
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${normalizedQuery}`).all();
    return { plan, query };
  } catch (err) {
    return { error: err.message, query };
  }
}

/**
 * Create a performance alert
 */
function createPerformanceAlert(alertType, severity, message, details = null, queryHash = null) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO performance_alerts (
      id, alert_type, severity, message, details, query_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, alertType, severity, message, details, queryHash, now);

  return { id, alert_type: alertType, severity, message };
}

/**
 * Get performance alerts
 */
function getPerformanceAlerts(includeAcknowledged = false, limit = 50) {
  const query = includeAcknowledged
    ? 'SELECT * FROM performance_alerts ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM performance_alerts WHERE acknowledged = 0 ORDER BY created_at DESC LIMIT ?';

  return db.prepare(query).all(limit);
}

/**
 * Acknowledge a performance alert
 * @param {string} alertId - Alert identifier.
 * @returns {object} Result of the update.
 */
function acknowledgePerformanceAlert(alertId) {
  const now = new Date().toISOString();
  return db.prepare(`
    UPDATE performance_alerts SET acknowledged = 1, acknowledged_at = ?
    WHERE id = ?
  `).run(now, alertId);
}

/**
 * Run integrity check
 */
function integrityCheck() {
  const result = db.prepare('PRAGMA integrity_check').all();
  const isOk = result.length === 1 && result[0].integrity_check === 'ok';

  recordOptimization('integrity_check', null,
    isOk ? 'Database integrity OK' : `Issues found: ${JSON.stringify(result)}`,
    0, null, null);

  return { ok: isOk, result };
}

/**
 * Get index statistics
 */
function getIndexStats() {
  const indexes = db.prepare(`
    SELECT
      m.name as index_name,
      m.tbl_name as table_name,
      ii.name as column_name
    FROM sqlite_master m
    LEFT JOIN pragma_index_info(m.name) ii ON 1=1
    WHERE m.type = 'index' AND m.name NOT LIKE 'sqlite_%'
    ORDER BY m.tbl_name, m.name
  `).all();

  // Group by index
  const grouped = {};
  for (const idx of indexes) {
    if (!grouped[idx.index_name]) {
      grouped[idx.index_name] = {
        index_name: idx.index_name,
        table_name: idx.table_name,
        columns: []
      };
    }
    if (idx.column_name) {
      grouped[idx.index_name].columns.push(idx.column_name);
    }
  }

  return Object.values(grouped);
}

// ============================================================
// Module exports
// ============================================================

module.exports = {
  setDb,
  setGetTask,
  setDbFunctions,
  computeContentHash,
  computeEmbedding,
  cosineSimilarity,
  cacheTaskResult,
  lookupCache,
  invalidateCache,
  getCacheConfig,
  setCacheConfig,
  warmCache,
  recordQueryStat,
  getSlowQueries,
  getFrequentQueries,
  clearQueryStats,
  updateCacheStats,
  updateCacheEntryCount,
  getCacheStats,
  clearCacheStats,
  recordOptimization,
  getOptimizationHistory,
  vacuumDatabase,
  analyzeDatabase,
  getDatabaseSize,
  getDatabaseStats,
  explainQueryPlan,
  createPerformanceAlert,
  getPerformanceAlerts,
  acknowledgePerformanceAlert,
  integrityCheck,
  getIndexStats,
};
