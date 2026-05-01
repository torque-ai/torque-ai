'use strict';

/**
 * Model capabilities, scoring, classification, and outcome tracking.
 */

let db;

function setDb(instance) {
  db = instance;
}

function getModelCapabilities(modelName) {
  return db.prepare('SELECT * FROM model_capabilities WHERE model_name = ?').get(modelName) || null;
}

function listModelCapabilities() {
  return db.prepare('SELECT * FROM model_capabilities ORDER BY model_name').all();
}

function upsertModelCapabilities(modelName, updates) {
  const existing = getModelCapabilities(modelName);
  const defaults = {
    score_code_gen: 0.5, score_refactoring: 0.5, score_testing: 0.5,
    score_reasoning: 0.5, score_docs: 0.5,
    lang_typescript: 0.5, lang_javascript: 0.5, lang_python: 0.5,
    lang_csharp: 0.5, lang_go: 0.5, lang_rust: 0.5, lang_general: 0.5,
    context_window: 8192, param_size_b: 0, is_thinking_model: 0, source: 'benchmark',
    can_create_files: 1, can_edit_safely: 1, max_safe_edit_lines: 250, is_agentic: 0
  };
  const merged = { ...defaults, ...existing, ...updates, model_name: modelName };
  delete merged.updated_at;

  db.prepare(`INSERT OR REPLACE INTO model_capabilities
    (model_name, score_code_gen, score_refactoring, score_testing, score_reasoning, score_docs,
     lang_typescript, lang_javascript, lang_python, lang_csharp, lang_go, lang_rust, lang_general,
     context_window, param_size_b, is_thinking_model, source,
     can_create_files, can_edit_safely, max_safe_edit_lines, is_agentic, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
    merged.model_name, merged.score_code_gen, merged.score_refactoring, merged.score_testing,
    merged.score_reasoning, merged.score_docs,
    merged.lang_typescript, merged.lang_javascript, merged.lang_python,
    merged.lang_csharp, merged.lang_go, merged.lang_rust, merged.lang_general,
    merged.context_window, merged.param_size_b, merged.is_thinking_model, merged.source,
    merged.can_create_files, merged.can_edit_safely, merged.max_safe_edit_lines, merged.is_agentic
  );
}

// ── Model Selection (scored ranking) ─────────────────────────────────────────

/**
 * Score and rank available models for a given task.
 * Formula: 0.6 * taskTypeScore + 0.3 * languageScore + 0.1 * complexityBonus
 * Filters out models whose context window is too small for the estimated tokens.
 *
 * @param {string} taskType - One of: code_gen, refactoring, testing, reasoning, docs
 * @param {string} language - One of: typescript, javascript, python, csharp, go, rust, general
 * @param {string} complexity - One of: simple, normal, complex
 * @param {string[]} availableModels - Model names to consider
 * @param {object} [options] - Optional settings
 * @param {number} [options.estimatedTokens=0] - Estimated input tokens (0 = skip context check)
 * @returns {Array<{model: string, score: number, reason: string}>} Ranked list, descending by score
 */
function selectBestModel(taskType, language, complexity, availableModels, options = {}) {
  if (!availableModels || availableModels.length === 0) return [];

  const { estimatedTokens = 0 } = options;
  const results = [];

  for (const modelName of availableModels) {
    const caps = getModelCapabilities(modelName);

    const taskScoreMap = {
      code_gen: caps ? caps.score_code_gen : 0.5,
      refactoring: caps ? caps.score_refactoring : 0.5,
      testing: caps ? caps.score_testing : 0.5,
      reasoning: caps ? caps.score_reasoning : 0.5,
      docs: caps ? caps.score_docs : 0.5,
    };

    const langScoreMap = {
      typescript: caps ? caps.lang_typescript : 0.5,
      javascript: caps ? caps.lang_javascript : 0.5,
      python: caps ? caps.lang_python : 0.5,
      csharp: caps ? caps.lang_csharp : 0.5,
      go: caps ? caps.lang_go : 0.5,
      rust: caps ? caps.lang_rust : 0.5,
      general: caps ? caps.lang_general : 0.5,
    };

    const contextWindow = caps ? caps.context_window : 8192;
    if (estimatedTokens > 0 && contextWindow < estimatedTokens * 1.3) {
      continue;
    }

    let taskTypeScore = taskScoreMap[taskType] || 0.5;
    const languageScore = langScoreMap[language] || 0.5;

    const adaptive = computeAdaptiveScores(modelName);
    if (adaptive && adaptive[taskType]) {
      taskTypeScore = 0.7 * taskTypeScore + 0.3 * adaptive[taskType].successRate;
    }

    let complexityBonus = 0.5;
    const paramSize = caps ? caps.param_size_b : 0;
    if (complexity === 'complex') {
      complexityBonus = Math.min(1.0, paramSize / 35);
    } else if (complexity === 'simple') {
      complexityBonus = Math.min(1.0, 1.0 - (paramSize / 50));
    } else {
      complexityBonus = 0.5;
    }

    const score = 0.6 * taskTypeScore + 0.3 * languageScore + 0.1 * complexityBonus;

    const reason = `${taskType}=${taskTypeScore.toFixed(2)}, ${language}=${languageScore.toFixed(2)}, complexity=${complexityBonus.toFixed(2)}`;

    results.push({ model: modelName, score: Math.round(score * 1000) / 1000, reason });
  }

  results.sort((a, b) => b.score - a.score);

  return results;
}

// ============================================================
// Task Classification Helpers
// ============================================================

const TASK_TYPE_PATTERNS = [
  { type: 'scan',        pattern: /\b(scan|audit|review|inspect|check|lint|find\s+(?:problems|issues|bugs)|code\s*review)\b/i },
  { type: 'testing',     pattern: /\b(test|tests|testing|spec|specs|coverage)\b/i },
  { type: 'refactoring', pattern: /\b(refactor|extract|rename|move|reorganize|restructure|decompose|simplify)\b/i },
  { type: 'reasoning',   pattern: /\b(debug|root.?cause|analyze|analysis|investigate|why\s+does|why\s+is|diagnose|bottleneck|performance)\b/i },
  { type: 'docs',        pattern: /\b(document|readme|jsdoc|changelog|comment|comments|documentation|docs)\b/i },
];

/**
 * Classify a task description into a task type.
 * Priority order: testing > refactoring > reasoning > docs > code_gen (default)
 * @param {string|null|undefined} description - Task description text
 * @returns {string} One of: 'testing', 'refactoring', 'reasoning', 'docs', 'code_gen'
 */
function classifyTaskType(description) {
  if (!description) return 'code_gen';
  for (const { type, pattern } of TASK_TYPE_PATTERNS) {
    if (pattern.test(description)) return type;
  }
  return 'code_gen';
}

const EXTENSION_LANGUAGE_MAP = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.vue': 'javascript', '.svelte': 'javascript',
  '.py': 'python',
  '.cs': 'csharp',
  '.go': 'go',
  '.rs': 'rust',
};

const DESCRIPTION_LANGUAGE_PATTERNS = [
  { language: 'python',     pattern: /\bpython\b/i },
  { language: 'typescript', pattern: /\btypescript\b/i },
  { language: 'javascript', pattern: /\bjavascript\b/i },
  { language: 'go',         pattern: /\bgo\b/i },
  { language: 'rust',       pattern: /\brust\b/i },
  { language: 'csharp',     pattern: /\bc#\b/i },
];

/**
 * Detect the primary programming language of a task from file extensions and description.
 * Primary: majority file extension. Secondary: description keywords. Fallback: 'general'.
 * @param {string|null|undefined} description - Task description text
 * @param {string[]|null|undefined} files - Array of file paths
 * @returns {string} Language identifier (e.g. 'typescript', 'python', 'general')
 */
function detectTaskLanguage(description, files) {
  if (files && Array.isArray(files) && files.length > 0) {
    const counts = {};
    for (const file of files) {
      const ext = '.' + file.split('.').pop();
      const lang = EXTENSION_LANGUAGE_MAP[ext];
      if (lang) {
        counts[lang] = (counts[lang] || 0) + 1;
      }
    }
    let maxLang = null;
    let maxCount = 0;
    for (const [lang, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        maxLang = lang;
      }
    }
    if (maxLang) return maxLang;
  }

  if (description) {
    for (const { language, pattern } of DESCRIPTION_LANGUAGE_PATTERNS) {
      if (pattern.test(description)) return language;
    }
  }

  return 'general';
}

// ============================================================
// Adaptive Scoring — Outcome Tracking
// ============================================================

/**
 * Record a task outcome for adaptive model scoring.
 * @param {string} modelName - The model that executed the task.
 * @param {string} taskType - Classification (code_gen, testing, docs, etc.).
 * @param {string|null} language - Detected language, or null.
 * @param {boolean} success - Whether the task succeeded.
 * @param {number|null} durationS - Duration in seconds, or null.
 * @param {string|null} failureCategory - Failure category for unsuccessful tasks, or null.
 */
function recordTaskOutcome(modelName, taskType, language, success, durationS, failureCategory) {
  db.prepare(`INSERT INTO model_task_outcomes (model_name, task_type, language, success, duration_s, failure_category)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    modelName,
    taskType,
    language || null,
    success ? 1 : 0,
    durationS != null ? durationS : null,
    failureCategory || null
  );
}

/**
 * Return models with recent repeated format-related failures.
 * @param {number} minFailures - Minimum failure count to include.
 * @returns {Array<{ model_name: string, failure_category: string, failure_count: number }>}
 */
function getModelFormatFailures(minFailures = 3) {
  // @full-scan: aggregation over a 30-day window with multiple
  // post-filter columns; the IN-clause on failure_category and the
  // GROUP BY drive the plan more than success=0 would.
  return db.prepare(`
    SELECT model_name, failure_category, COUNT(*) as failure_count
    FROM model_task_outcomes
    WHERE success = 0
      AND failure_category IN ('parse_error', 'format_mismatch')
      AND created_at > datetime('now', '-30 days')
    GROUP BY model_name, failure_category
    HAVING COUNT(*) >= ?
  `).all(minFailures);
}

/**
 * Compute per-task-type success rates for a model over the last 30 days.
 * Returns null if fewer than 5 outcomes exist (insufficient data).
 * @param {string} modelName - The model to score.
 * @returns {object|null} Map of taskType -> { successRate, count }, or null.
 */
function computeAdaptiveScores(modelName) {
  const total = db.prepare(
    `SELECT COUNT(*) as cnt FROM model_task_outcomes
     WHERE model_name = ? AND created_at > datetime('now', '-30 days')`
  ).get(modelName);

  if (!total || total.cnt < 5) return null;

  const rows = db.prepare(
    `SELECT task_type,
            COUNT(*) as count,
            SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
     FROM model_task_outcomes
     WHERE model_name = ? AND created_at > datetime('now', '-30 days')
     GROUP BY task_type`
  ).all(modelName);

  const scores = {};
  for (const row of rows) {
    scores[row.task_type] = {
      successRate: row.count > 0 ? row.successes / row.count : 0,
      count: row.count
    };
  }
  return scores;
}

/**
 * Get model performance leaderboard from task outcomes.
 * @param {{ task_type?: string, language?: string, days?: number, limit?: number }} options
 * @returns {Array<{ rank: number, model_name: string, success_rate: number, avg_duration_s: number, task_count: number, successes: number, failures: number }>}
 */
function getModelLeaderboard(options = {}) {
  const { task_type, language, days = 30, limit = 20 } = options;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = `
    SELECT model_name,
           COUNT(*) as task_count,
           ROUND(AVG(success) * 100, 1) as success_rate,
           ROUND(AVG(duration_s), 1) as avg_duration_s,
           SUM(success) as successes,
           COUNT(*) - SUM(success) as failures
    FROM model_task_outcomes
    WHERE created_at > ?
  `;
  const params = [since];

  if (task_type) {
    query += ' AND task_type = ?';
    params.push(task_type);
  }
  if (language) {
    query += ' AND language = ?';
    params.push(language);
  }

  query += ' GROUP BY model_name ORDER BY success_rate DESC, avg_duration_s ASC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params);

  return rows.map((row, i) => ({
    rank: i + 1,
    model_name: row.model_name,
    success_rate: row.success_rate,
    avg_duration_s: row.avg_duration_s,
    task_count: row.task_count,
    successes: row.successes,
    failures: row.failures
  }));
}

// ============================================================
// Factory function (dependency injection without singletons)
// ============================================================

function createModelCapabilities({ db: dbInstance } = {}) {
  if (dbInstance) setDb(dbInstance);
  return module.exports;
}

module.exports = {
  setDb,
  createModelCapabilities,
  getModelCapabilities,
  listModelCapabilities,
  upsertModelCapabilities,
  selectBestModel,
  classifyTaskType,
  detectTaskLanguage,
  recordTaskOutcome,
  getModelFormatFailures,
  computeAdaptiveScores,
  getModelLeaderboard,
};
