'use strict';

/**
 * Task Intelligence Module
 *
 * Extracted from task-metadata.js — suggestions, similarity search,
 * pattern learning, and smart defaults.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

const { safeJsonParse } = require('../utils/json');

let db;

// Lazy module-level cache of prepared statements keyed by a stable name.
const _stmtCache = new Map();
function _getStmt(key, sql) {
  const cached = _stmtCache.get(key);
  if (cached) return cached;
  const stmt = db.prepare(sql);
  _stmtCache.set(key, stmt);
  return stmt;
}
let getTaskFn;

function setDb(dbInstance) { db = dbInstance; _stmtCache.clear(); }
function setGetTask(fn) { getTaskFn = fn; }

function addTaskSuggestion(taskId, suggestionType, suggestionText, confidence = 0.5) {
  const stmt = db.prepare(`
    INSERT INTO task_suggestions (task_id, suggestion_type, suggestion_text, confidence, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  const result = stmt.run(taskId, suggestionType, suggestionText, confidence);
  return result.lastInsertRowid;
}

/**
 * Get suggestions for a task
 */
function getTaskSuggestions(taskId) {
  const stmt = db.prepare(`
    SELECT * FROM task_suggestions WHERE task_id = ?
    ORDER BY confidence DESC, created_at DESC
  `);
  return stmt.all(taskId);
}

/**
 * Mark a suggestion as applied
 */
function markSuggestionApplied(suggestionId) {
  const stmt = db.prepare(`UPDATE task_suggestions SET applied = 1 WHERE id = ?`);
  return stmt.run(suggestionId).changes > 0;
}

/**
 * Calculate text similarity using word overlap (Jaccard similarity)
 */
function calculateTextSimilarity(text1, text2) {
  const normalize = (text) => text.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2);

  const words1 = new Set(normalize(text1));
  const words2 = new Set(normalize(text2));

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * Find tasks similar to a given task
 */
function findSimilarTasks(taskId, options = {}) {
  const getTask = getTaskFn;
  const { limit = 10, minSimilarity = 0.3, statusFilter } = options;

  const task = getTask(taskId);
  if (!task) return [];

  // Get candidate tasks
  let query = `SELECT * FROM tasks WHERE id != ?`;
  const params = [taskId];

  if (statusFilter) {
    query += ` AND status = ?`;
    params.push(statusFilter);
  }

  query += ` ORDER BY created_at DESC LIMIT 500`; // Limit candidates for performance

  const stmt = db.prepare(query);
  const candidates = stmt.all(...params);

  // Calculate similarity scores
  const results = candidates
    .map(candidate => ({
      task: candidate,
      similarity: calculateTextSimilarity(task.task_description, candidate.task_description)
    }))
    .filter(r => r.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  // Cache results in similar_tasks table
  const insertSimilarTask = _getStmt('insertSimilarTask', `
    INSERT OR REPLACE INTO similar_tasks (source_task_id, similar_task_id, similarity_score, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `);
  for (const result of results) {
    try {
      insertSimilarTask.run(taskId, result.task.id, result.similarity);
    } catch (_e) {
      void _e;
      // Ignore caching errors
    }
  }

  return results;
}

/**
 * Get cached similar tasks
 */
function getCachedSimilarTasks(taskId, limit = 10) {
  const stmt = db.prepare(`
    SELECT st.*, t.*
    FROM similar_tasks st
    JOIN tasks t ON st.similar_task_id = t.id
    WHERE st.source_task_id = ?
    ORDER BY st.similarity_score DESC
    LIMIT ?
  `);
  return stmt.all(taskId, limit);
}

/**
 * Analyze failed task and generate improvement suggestions
 */
function generateTaskSuggestions(taskId) {
  const getTask = getTaskFn;
  const task = getTask(taskId);
  if (!task) return [];

  const suggestions = [];

  // Only analyze failed tasks
  if (task.status !== 'failed') {
    return suggestions;
  }

  const errorOutput = task.error_output || '';
  const _description = task.task_description || '';

  // Check for common error patterns
  const errorPatterns = [
    { pattern: /timeout/i, type: 'timeout', suggestion: 'Consider increasing timeout_minutes', confidence: 0.8 },
    { pattern: /permission denied/i, type: 'permission', suggestion: 'Task may need auto_approve=true or different permissions', confidence: 0.7 },
    { pattern: /not found|no such file/i, type: 'missing_file', suggestion: 'Verify working directory and file paths exist', confidence: 0.75 },
    { pattern: /syntax error/i, type: 'syntax', suggestion: 'Review task description for syntax issues', confidence: 0.6 },
    { pattern: /memory|out of memory|heap/i, type: 'memory', suggestion: 'Task may require more memory or optimization', confidence: 0.7 },
    { pattern: /network|connection|ECONNREFUSED/i, type: 'network', suggestion: 'Check network connectivity and service availability', confidence: 0.65 },
    { pattern: /rate limit|429/i, type: 'rate_limit', suggestion: 'Add delays or reduce request frequency', confidence: 0.8 },
  ];

  for (const { pattern, type, suggestion, confidence } of errorPatterns) {
    if (pattern.test(errorOutput)) {
      suggestions.push({ type, suggestion, confidence });
    }
  }

  // Check for similar successful tasks
  const similarSuccessful = findSimilarTasks(taskId, { limit: 3, statusFilter: 'completed' });
  if (similarSuccessful.length > 0) {
    const bestMatch = similarSuccessful[0];
    suggestions.push({
      type: 'similar_success',
      suggestion: `Similar task succeeded (${Math.round(bestMatch.similarity * 100)}% match). ` +
        `Consider: timeout=${bestMatch.task.timeout_minutes}min, auto_approve=${bestMatch.task.auto_approve ? 'true' : 'false'}`,
      confidence: bestMatch.similarity * 0.9
    });
  }

  // Check if retries might help
  if (task.retry_count < task.max_retries) {
    suggestions.push({
      type: 'retry',
      suggestion: `Task has ${task.max_retries - task.retry_count} retries remaining. Consider triggering a retry.`,
      confidence: 0.5
    });
  }

  // Save suggestions to database
  for (const s of suggestions) {
    addTaskSuggestion(taskId, s.type, s.suggestion, s.confidence);
  }

  return suggestions;
}

/**
 * Learn patterns from successful task configurations
 */
function learnFromTask(taskId) {
  const getTask = getTaskFn;
  const task = getTask(taskId);
  if (!task || task.status !== 'completed') return null;

  const description = task.task_description.toLowerCase();
  const patterns = [];

  // Extract keyword patterns
  const keywords = [
    'test', 'build', 'deploy', 'migrate', 'refactor', 'fix', 'add', 'create',
    'update', 'delete', 'lint', 'format', 'analyze', 'generate', 'install'
  ];

  for (const keyword of keywords) {
    if (description.includes(keyword)) {
      patterns.push({
        type: 'keyword',
        value: keyword,
        config: {
          timeout_minutes: task.timeout_minutes,
          auto_approve: task.auto_approve,
          priority: task.priority
        }
      });
    }
  }

  // Extract project-based patterns
  if (task.project) {
    patterns.push({
      type: 'project',
      value: task.project,
      config: {
        timeout_minutes: task.timeout_minutes,
        auto_approve: task.auto_approve,
        priority: task.priority
      }
    });
  }

  // Calculate duration
  let durationSeconds = null;
  if (task.started_at && task.completed_at) {
    durationSeconds = (new Date(task.completed_at) - new Date(task.started_at)) / 1000;
  }

  // Save/update patterns
  const selectPattern = _getStmt('selectPattern', `
    SELECT * FROM task_patterns WHERE pattern_type = ? AND pattern_value = ?
  `);
  for (const p of patterns) {
    const existing = selectPattern.get(p.type, p.value);

    if (existing) {
      // Update existing pattern with running average
      const newHitCount = existing.hit_count + 1;
      const existingConfig = safeJsonParse(existing.suggested_config, { timeout_minutes: 30, priority: 5, auto_approve: false });

      // Calculate weighted average for numeric configs
      const updatedConfig = {
        timeout_minutes: Math.round(((existingConfig.timeout_minutes || 30) * existing.hit_count + p.config.timeout_minutes) / newHitCount),
        auto_approve: p.config.auto_approve, // Use most recent
        priority: Math.round(((existingConfig.priority || 5) * existing.hit_count + p.config.priority) / newHitCount)
      };

      const isSuccess = (task.exit_code === 0 || task.exit_code === null) ? 1 : 0;
      const newSuccessRate = (existing.success_rate * existing.hit_count + isSuccess) / newHitCount;
      const newAvgDuration = durationSeconds && existing.avg_duration_seconds
        ? (existing.avg_duration_seconds * existing.hit_count + durationSeconds) / newHitCount
        : durationSeconds || existing.avg_duration_seconds;

      _getStmt('updatePattern', `
        UPDATE task_patterns
        SET suggested_config = ?, hit_count = ?, success_rate = ?, avg_duration_seconds = ?, last_matched_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(updatedConfig), newHitCount, newSuccessRate, newAvgDuration, existing.id);
    } else {
      // Create new pattern
      _getStmt('insertPattern', `
        INSERT INTO task_patterns (pattern_type, pattern_value, suggested_config, hit_count, success_rate, avg_duration_seconds, created_at)
        VALUES (?, ?, ?, 1, 1.0, ?, datetime('now'))
      `).run(p.type, p.value, JSON.stringify(p.config), durationSeconds);
    }
  }

  return patterns;
}

/**
 * Get learned patterns
 */
function getTaskPatterns(options = {}) {
  const { type, minHitCount = 1, limit = 50 } = options;

  let query = `SELECT * FROM task_patterns WHERE hit_count >= ?`;
  const params = [minHitCount];

  if (type) {
    query += ` AND pattern_type = ?`;
    params.push(type);
  }

  query += ` ORDER BY hit_count DESC, success_rate DESC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(query);
  const patterns = stmt.all(...params);

  return patterns.map(p => ({
    ...p,
    suggested_config: safeJsonParse(p.suggested_config, {})
  }));
}

/**
 * Get smart defaults for a task description
 */
function getSmartDefaults(taskDescription, project = null) {
  const description = taskDescription.toLowerCase();
  const defaults = {
    timeout_minutes: 30,
    auto_approve: false,
    priority: 0,
    confidence: 0,
    matched_patterns: []
  };

  // Get all patterns sorted by hit count
  const patterns = getTaskPatterns({ minHitCount: 2 });

  let totalWeight = 0;
  let weightedTimeout = 0;
  let weightedPriority = 0;

  for (const pattern of patterns) {
    let matches = false;

    if (pattern.pattern_type === 'keyword' && description.includes(pattern.pattern_value)) {
      matches = true;
    } else if (pattern.pattern_type === 'project' && project === pattern.pattern_value) {
      matches = true;
    }

    if (matches) {
      const weight = pattern.hit_count * pattern.success_rate;
      totalWeight += weight;
      weightedTimeout += pattern.suggested_config.timeout_minutes * weight;
      weightedPriority += pattern.suggested_config.priority * weight;

      // Use auto_approve from most successful pattern
      if (pattern.success_rate > defaults.confidence) {
        defaults.auto_approve = pattern.suggested_config.auto_approve;
        defaults.confidence = pattern.success_rate;
      }

      defaults.matched_patterns.push({
        type: pattern.pattern_type,
        value: pattern.pattern_value,
        hit_count: pattern.hit_count,
        success_rate: pattern.success_rate
      });
    }
  }

  if (totalWeight > 0) {
    defaults.timeout_minutes = Math.round(weightedTimeout / totalWeight);
    defaults.priority = Math.round(weightedPriority / totalWeight);
  }

  return defaults;
}

/**
 * Trigger learning from recent successful tasks
 */
function learnFromRecentTasks(limit = 100) {
  const stmt = db.prepare(`
    SELECT id FROM tasks
    WHERE status = 'completed'
    ORDER BY completed_at DESC
    LIMIT ?
  `);
  const tasks = stmt.all(limit);

  let learned = 0;
  for (const task of tasks) {
    const patterns = learnFromTask(task.id);
    if (patterns && patterns.length > 0) learned++;
  }

  return { tasksProcessed: tasks.length, patternsLearned: learned };
}

module.exports = {
  setDb,
  setGetTask,
  addTaskSuggestion,
  getTaskSuggestions,
  markSuggestionApplied,
  calculateTextSimilarity,
  findSimilarTasks,
  getCachedSimilarTasks,
  generateTaskSuggestions,
  learnFromTask,
  getTaskPatterns,
  getSmartDefaults,
  learnFromRecentTasks,
};
