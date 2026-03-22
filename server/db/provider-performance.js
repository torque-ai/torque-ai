'use strict';
let _db = null;
function setDb(db) { _db = db; }

function getWindowKey() {
  return new Date().toISOString().slice(0, 10);
}

function recordTaskOutcome({ provider, taskType, durationSeconds, success, resubmitted, autoCheckPassed }) {
  if (!_db) return;
  const window = getWindowKey();
  const rawDb = _db.getDbInstance();
  rawDb.prepare(`
    INSERT INTO provider_performance (provider, task_type, window_start, total_tasks, successful_tasks, failed_tasks, resubmitted_tasks, avg_duration_seconds, auto_check_pass_rate, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(provider, task_type, window_start) DO UPDATE SET
      avg_duration_seconds = (avg_duration_seconds * total_tasks + ?) / (total_tasks + 1),
      auto_check_pass_rate = (auto_check_pass_rate * total_tasks + ?) / (total_tasks + 1),
      total_tasks = total_tasks + 1,
      successful_tasks = successful_tasks + ?,
      failed_tasks = failed_tasks + ?,
      resubmitted_tasks = resubmitted_tasks + ?,
      updated_at = datetime('now')
  `).run(
    provider, taskType, window,
    success ? 1 : 0, success ? 0 : 1, resubmitted ? 1 : 0,
    durationSeconds, autoCheckPassed ? 1.0 : 0.0,
    durationSeconds, autoCheckPassed ? 1.0 : 0.0,
    success ? 1 : 0, success ? 0 : 1, resubmitted ? 1 : 0
  );
}

function getProviderTaskStats(provider, taskType, days = 7) {
  if (!_db) return { total_tasks: 0, successful_tasks: 0, failed_tasks: 0, resubmitted_tasks: 0, avg_duration_seconds: 0, auto_check_pass_rate: 0 };
  const rawDb = _db.getDbInstance();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const row = rawDb.prepare(`
    SELECT
      COALESCE(SUM(total_tasks), 0) as total_tasks,
      COALESCE(SUM(successful_tasks), 0) as successful_tasks,
      COALESCE(SUM(failed_tasks), 0) as failed_tasks,
      COALESCE(SUM(resubmitted_tasks), 0) as resubmitted_tasks,
      CASE WHEN SUM(total_tasks) > 0 THEN SUM(avg_duration_seconds * total_tasks) / SUM(total_tasks) ELSE 0 END as avg_duration_seconds,
      CASE WHEN SUM(total_tasks) > 0 THEN SUM(auto_check_pass_rate * total_tasks) / SUM(total_tasks) ELSE 0 END as auto_check_pass_rate
    FROM provider_performance
    WHERE provider = ? AND task_type = ? AND window_start >= ?
  `).get(provider, taskType, cutoff);
  return row || { total_tasks: 0, successful_tasks: 0, failed_tasks: 0, resubmitted_tasks: 0, avg_duration_seconds: 0, auto_check_pass_rate: 0 };
}

const MIN_SAMPLES = 5;

function getEmpiricalRank(provider, taskType) {
  const stats = getProviderTaskStats(provider, taskType);
  if (stats.total_tasks < MIN_SAMPLES) return 0;
  const successRate = stats.total_tasks > 0 ? stats.successful_tasks / stats.total_tasks : 0;
  if (successRate >= 0.9) return -1;
  if (successRate < 0.5) return 1;
  return 0;
}

const TASK_TYPE_PATTERNS = [
  { pattern: /\b(create|write new|generate new|scaffold|new file)\b/i, type: 'file_creation' },
  { pattern: /\b(review|analyze|audit|inspect)\b/i, type: 'code_review' },
  { pattern: /\b(fix|patch|debug|repair)\b/i, type: 'code_edit' },
  { pattern: /\b(refactor|rename|restructure|move)\b/i, type: 'refactoring' },
  { pattern: /\b(test|spec|assert|coverage)\b/i, type: 'test_writing' },
  { pattern: /\b(doc|comment|jsdoc|readme)\b/i, type: 'documentation' },
];

function inferTaskType(taskDescription) {
  for (const { pattern, type } of TASK_TYPE_PATTERNS) {
    if (pattern.test(taskDescription)) return type;
  }
  return 'general';
}

// ============================================================
// Factory function (dependency injection without singletons)
// ============================================================

function createProviderPerformance({ db: dbInstance } = {}) {
  if (dbInstance) setDb(dbInstance);
  return module.exports;
}

module.exports = { setDb, createProviderPerformance, recordTaskOutcome, getProviderTaskStats, getEmpiricalRank, inferTaskType };
