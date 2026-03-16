'use strict';

/**
 * Analytics Module
 *
 * Consolidated analytics domain: duration prediction, prioritization,
 * failure prediction, adaptive retry, and experimentation.
 *
 * Merged from: duration-prediction.js, prioritization.js, failure-prediction.js,
 *              adaptive-retry.js, experimentation.js
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 */

const crypto = require('crypto');

let db;
let getTaskFn;
const dbFunctions = {};

function setDb(dbInstance) { db = dbInstance; }
function setGetTask(fn) { getTaskFn = fn; }
function setDbFunctions(fns) { Object.assign(dbFunctions, fns); }
function setFindSimilarTasks(fn) { findSimilarTasksFn = fn; }
function setSetPriorityWeights(fn) { _setWeightsFn = fn; }

let findSimilarTasksFn;
let _setWeightsFn;

function safeJsonParse(value, defaultValue = null) {
  if (!value) return defaultValue;
  try { return JSON.parse(value); } catch { return defaultValue; }
}

// ============================================================
// Duration Prediction (merged from duration-prediction.js)
// ============================================================

/**
 * Record a duration prediction
 */
function recordDurationPrediction(prediction) {
  const stmt = db.prepare(`
    INSERT INTO duration_predictions (
      task_id, predicted_seconds, confidence, factors, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    prediction.task_id,
    prediction.predicted_seconds,
    prediction.confidence || 0.5,
    JSON.stringify(prediction.factors),
    new Date().toISOString()
  );

  return result.lastInsertRowid;
}

/**
 * Update a prediction with actual duration
 */
function updatePredictionActual(taskId, actualSeconds) {
  const stmt = db.prepare(`
    UPDATE duration_predictions
    SET actual_seconds = ?,
        error_percent = ABS((predicted_seconds - ?) / NULLIF(?, 0) * 100)
    WHERE task_id = ? AND actual_seconds IS NULL
  `);

  stmt.run(actualSeconds, actualSeconds, actualSeconds, taskId);
}

/**
 * Get prediction model by type and key
 */
function getPredictionModel(modelType, modelKey = null) {
  const stmt = modelKey
    ? db.prepare('SELECT * FROM prediction_models WHERE model_type = ? AND model_key = ?')
    : db.prepare('SELECT * FROM prediction_models WHERE model_type = ? AND model_key IS NULL');

  return modelKey ? stmt.get(modelType, modelKey) : stmt.get(modelType);
}

/**
 * Update or create a prediction model
 */
function updatePredictionModel(model) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO prediction_models (
      id, model_type, model_key, sample_count, avg_seconds, std_deviation, last_calibrated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const id = model.id || `${model.model_type}:${model.model_key || 'global'}`;

  stmt.run(
    id,
    model.model_type,
    model.model_key || null,
    model.sample_count || 0,
    model.avg_seconds || null,
    model.std_deviation || null,
    new Date().toISOString()
  );

  return getPredictionModel(model.model_type, model.model_key);
}

/**
 * Predict task duration based on multiple factors
 */
function predictDuration(taskDescription, options = {}) {
  const getTemplate = dbFunctions.getTemplate;
  const factors = [];
  let totalWeight = 0;
  let weightedSum = 0;

  // Factor 1: Template match (40%)
  if (options.template_name) {
    const template = getTemplate(options.template_name);
    if (template && template.avg_duration) {
      factors.push({
        source: 'template',
        name: options.template_name,
        value: template.avg_duration,
        weight: 0.4
      });
      weightedSum += template.avg_duration * 0.4;
      totalWeight += 0.4;
    }
  }

  // Factor 2: Pattern match (30%)
  const patternModel = getPredictionModel('pattern', extractPatternKey(taskDescription));
  if (patternModel && patternModel.avg_seconds) {
    factors.push({
      source: 'pattern',
      name: patternModel.model_key,
      value: patternModel.avg_seconds,
      weight: 0.3
    });
    weightedSum += patternModel.avg_seconds * 0.3;
    totalWeight += 0.3;
  }

  // Factor 3: Keyword analysis (20%)
  const keywordEstimate = estimateFromKeywords(taskDescription);
  if (keywordEstimate) {
    factors.push({
      source: 'keywords',
      name: keywordEstimate.keywords.join(', '),
      value: keywordEstimate.seconds,
      weight: 0.2
    });
    weightedSum += keywordEstimate.seconds * 0.2;
    totalWeight += 0.2;
  }

  // Factor 4: Global average (10%)
  const globalModel = getPredictionModel('global');
  if (globalModel && globalModel.avg_seconds) {
    factors.push({
      source: 'global',
      name: 'average',
      value: globalModel.avg_seconds,
      weight: 0.1
    });
    weightedSum += globalModel.avg_seconds * 0.1;
    totalWeight += 0.1;
  }

  // Calculate final prediction
  let predictedSeconds = totalWeight > 0 ? weightedSum / totalWeight : 300; // Default 5 min
  let confidence = Math.min(totalWeight / 0.7, 1); // Scale confidence

  // If no data, use fallback
  if (factors.length === 0) {
    predictedSeconds = 300;
    confidence = 0.2;
    factors.push({ source: 'fallback', name: 'default', value: 300, weight: 1.0 });
  }

  return {
    predicted_seconds: Math.round(predictedSeconds),
    predicted_minutes: Math.round(predictedSeconds / 60 * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    factors
  };
}

/**
 * Extract pattern key from task description
 */
function extractPatternKey(description) {
  const lower = description.toLowerCase();

  if (lower.includes('test')) return 'test';
  if (lower.includes('build')) return 'build';
  if (lower.includes('lint')) return 'lint';
  if (lower.includes('refactor')) return 'refactor';
  if (lower.includes('fix')) return 'fix';
  if (lower.includes('add') || lower.includes('create')) return 'create';
  if (lower.includes('update') || lower.includes('modify')) return 'update';
  if (lower.includes('delete') || lower.includes('remove')) return 'delete';

  return 'general';
}

/**
 * Estimate duration from keywords
 */
function estimateFromKeywords(description) {
  const keywords = [];
  const lower = description.toLowerCase();
  let baseSeconds = 180; // Default 3 minutes

  const keywordMultipliers = {
    'test': { seconds: 120, multiplier: 1.0 },
    'unit test': { seconds: 60, multiplier: 1.0 },
    'integration': { seconds: 300, multiplier: 1.5 },
    'build': { seconds: 180, multiplier: 1.2 },
    'compile': { seconds: 120, multiplier: 1.0 },
    'lint': { seconds: 60, multiplier: 0.8 },
    'format': { seconds: 30, multiplier: 0.5 },
    'refactor': { seconds: 600, multiplier: 2.0 },
    'complex': { seconds: 0, multiplier: 2.0 },
    'simple': { seconds: 0, multiplier: 0.5 },
    'quick': { seconds: 0, multiplier: 0.3 }
  };

  let multiplier = 1.0;
  for (const [keyword, data] of Object.entries(keywordMultipliers)) {
    if (lower.includes(keyword)) {
      keywords.push(keyword);
      if (data.seconds > 0) baseSeconds = data.seconds;
      multiplier *= data.multiplier;
    }
  }

  if (keywords.length === 0) return null;

  return {
    keywords,
    seconds: Math.round(baseSeconds * multiplier)
  };
}

/**
 * Calibrate prediction models from historical data
 */
function calibratePredictionModels() {
  const results = {
    models_updated: 0,
    samples_processed: 0
  };

  // Calibrate global model
  const globalStats = db.prepare(`
    SELECT COUNT(*) as count, AVG((julianday(completed_at) - julianday(started_at)) * 86400) as avg_seconds
    FROM tasks
    WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
  `).get();

  if (globalStats.count > 0) {
    updatePredictionModel({
      model_type: 'global',
      model_key: null,
      sample_count: globalStats.count,
      avg_seconds: globalStats.avg_seconds
    });
    results.models_updated++;
    results.samples_processed += globalStats.count;
  }

  // Calibrate pattern models
  const patterns = ['test', 'build', 'lint', 'refactor', 'fix', 'create', 'update', 'delete', 'general'];

  for (const pattern of patterns) {
    const patternCondition = getPatternCondition(pattern);
    const stmt = db.prepare(`
      SELECT COUNT(*) as count,
             AVG((julianday(completed_at) - julianday(started_at)) * 86400) as avg_seconds,
             AVG((julianday(completed_at) - julianday(started_at)) * 86400 * (julianday(completed_at) - julianday(started_at)) * 86400) as avg_sq
      FROM tasks
      WHERE status = 'completed'
        AND started_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND (${patternCondition})
    `);

    const stats = stmt.get();
    if (stats.count >= 3) {
      const variance = stats.avg_sq - (stats.avg_seconds * stats.avg_seconds);
      const stdDev = variance > 0 ? Math.sqrt(variance) : 0;

      updatePredictionModel({
        model_type: 'pattern',
        model_key: pattern,
        sample_count: stats.count,
        avg_seconds: stats.avg_seconds,
        std_deviation: stdDev
      });
      results.models_updated++;
    }
  }

  // Calibrate template models
  const templateStats = db.prepare(`
    SELECT template_name, COUNT(*) as count,
           AVG((julianday(completed_at) - julianday(started_at)) * 86400) as avg_seconds
    FROM tasks
    WHERE status = 'completed'
      AND template_name IS NOT NULL
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
    GROUP BY template_name
    HAVING count >= 2
  `).all();

  for (const tpl of templateStats) {
    updatePredictionModel({
      model_type: 'template',
      model_key: tpl.template_name,
      sample_count: tpl.count,
      avg_seconds: tpl.avg_seconds
    });
    results.models_updated++;
  }

  return results;
}

/**
 * Get SQL condition for pattern matching
 */
function getPatternCondition(pattern) {
  const conditions = {
    'test': "LOWER(task_description) LIKE '%test%'",
    'build': "LOWER(task_description) LIKE '%build%'",
    'lint': "LOWER(task_description) LIKE '%lint%'",
    'refactor': "LOWER(task_description) LIKE '%refactor%'",
    'fix': "LOWER(task_description) LIKE '%fix%'",
    'create': "LOWER(task_description) LIKE '%add%' OR LOWER(task_description) LIKE '%create%'",
    'update': "LOWER(task_description) LIKE '%update%' OR LOWER(task_description) LIKE '%modify%'",
    'delete': "LOWER(task_description) LIKE '%delete%' OR LOWER(task_description) LIKE '%remove%'",
    'general': "1=1"
  };

  return conditions[pattern] || "1=1";
}

/**
 * Get duration insights for analytics
 */
function getDurationInsights(options = {}) {
  const { project, limit = 20 } = options;

  let whereClause = 'actual_seconds IS NOT NULL';
  const params = [];

  if (project) {
    whereClause += ' AND task_id IN (SELECT id FROM tasks WHERE project = ?)';
    params.push(project);
  }

  // Get recent predictions with actuals
  const predictions = db.prepare(`
    SELECT * FROM duration_predictions
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit);

  // Calculate overall accuracy
  const accuracy = db.prepare(`
    SELECT
      COUNT(*) as total,
      AVG(error_percent) as avg_error,
      AVG(CASE WHEN error_percent < 20 THEN 1 ELSE 0 END) * 100 as within_20_pct
    FROM duration_predictions
    WHERE ${whereClause}
  `).get(...params);

  // Get model performance
  const modelPerformance = db.prepare(`
    SELECT model_type, model_key, sample_count, avg_seconds, std_deviation
    FROM prediction_models
    ORDER BY sample_count DESC
  `).all();

  return {
    recent_predictions: predictions.map(p => ({
      ...p,
      factors: safeJsonParse(p.factors, [])
    })),
    accuracy: {
      total_predictions: accuracy.total,
      avg_error_percent: Math.round(accuracy.avg_error * 10) / 10,
      within_20_percent: Math.round(accuracy.within_20_pct * 10) / 10
    },
    models: modelPerformance
  };
}


// ============================================================
// Prioritization (merged from prioritization.js)
// ============================================================

/**
 * Compute resource score based on predicted duration and cost
 */
function computeResourceScore(task) {
  // Get predicted duration
  const prediction = db.prepare(`
    SELECT predicted_seconds FROM duration_predictions
    WHERE task_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(task.id);

  const predictedDuration = prediction ? prediction.predicted_seconds : task.timeout_minutes * 60;

  // Normalize: shorter tasks get higher scores
  // Max expected duration: 60 minutes
  const maxDuration = 3600;
  const score = Math.max(0, 1 - (predictedDuration / maxDuration));

  return Math.min(1, Math.max(0, score));
}

/**
 * Compute success score based on historical similar task outcomes
 */
function computeSuccessScore(task) {
  if (!task.id) return 0.5;

  // findSimilarTasks(taskId, options) returns [{ task, similarity }]
  const similar = findSimilarTasksFn(task.id, { limit: 10 });

  if (!similar || similar.length === 0) {
    return 0.5; // Default neutral score
  }

  // Calculate success rate from the nested task objects
  const completed = similar.filter(r => r.task && r.task.status === 'completed' && r.task.exit_code === 0).length;
  return completed / similar.length;
}

/**
 * Compute dependency score based on workflow impact
 */
function computeDependencyScore(task) {
  if (!task.workflow_id) {
    return 0.5; // No workflow context
  }

  // Count downstream dependent tasks
  const dependents = db.prepare(`
    WITH RECURSIVE downstream AS (
      SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?
      UNION ALL
      SELECT td.task_id FROM task_dependencies td
      JOIN downstream d ON td.depends_on_task_id = d.task_id
    )
    SELECT COUNT(*) as count FROM downstream
  `).get(task.id);

  // Normalize: more dependents = higher priority
  // Cap at 10 for normalization
  const score = Math.min(1, (dependents?.count || 0) / 10);

  return score;
}

/**
 * Get priority weights configuration
 */
function getPriorityWeights() {
  const config = {};
  const rows = db.prepare('SELECT key, value FROM priority_config').all();
  rows.forEach(r => { config[r.key] = parseFloat(r.value); });
  return {
    resource: config.resource_weight || 0.3,
    success: config.success_weight || 0.3,
    dependency: config.dependency_weight || 0.4
  };
}

/**
 * Set priority weights
 */
function setPriorityWeights(weights) {
  if (weights.resource !== undefined) {
    db.prepare('INSERT OR REPLACE INTO priority_config (key, value) VALUES (?, ?)').run('resource_weight', weights.resource.toString());
  }
  if (weights.success !== undefined) {
    db.prepare('INSERT OR REPLACE INTO priority_config (key, value) VALUES (?, ?)').run('success_weight', weights.success.toString());
  }
  if (weights.dependency !== undefined) {
    db.prepare('INSERT OR REPLACE INTO priority_config (key, value) VALUES (?, ?)').run('dependency_weight', weights.dependency.toString());
  }
}

/**
 * Compute combined priority score for a task
 */
function computePriorityScore(taskId) {
  const getTask = getTaskFn;
  const task = getTask(taskId);
  if (!task) return null;

  const weights = getPriorityWeights();
  const resourceScore = computeResourceScore(task);
  const successScore = computeSuccessScore(task);
  const dependencyScore = computeDependencyScore(task);

  const totalWeight = weights.resource + weights.success + weights.dependency;
  const combinedScore = (
    weights.resource * resourceScore +
    weights.success * successScore +
    weights.dependency * dependencyScore
  ) / totalWeight;

  const factors = {
    resource: { score: resourceScore, weight: weights.resource },
    success: { score: successScore, weight: weights.success },
    dependency: { score: dependencyScore, weight: weights.dependency }
  };

  // Store in database
  db.prepare(`
    INSERT OR REPLACE INTO task_priority_scores
    (task_id, resource_score, success_score, dependency_score, combined_score, factors, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, resourceScore, successScore, dependencyScore, combinedScore, JSON.stringify(factors), new Date().toISOString());

  return {
    task_id: taskId,
    resource_score: resourceScore,
    success_score: successScore,
    dependency_score: dependencyScore,
    combined_score: combinedScore,
    factors
  };
}

/**
 * Get priority queue - tasks ordered by priority
 */
function getPriorityQueue(limit = 50, minScore = 0) {
  return db.prepare(`
    SELECT t.*, p.combined_score, p.resource_score, p.success_score, p.dependency_score, p.factors
    FROM tasks t
    LEFT JOIN task_priority_scores p ON t.id = p.task_id
    WHERE t.status IN ('pending', 'queued')
    AND (p.combined_score IS NULL OR p.combined_score >= ?)
    ORDER BY COALESCE(p.combined_score, 0.5) DESC, t.created_at ASC
    LIMIT ?
  `).all(minScore, limit);
}

/**
 * Get highest priority queued task
 */
function getHighestPriorityQueuedTask() {
  return db.prepare(`
    SELECT t.* FROM tasks t
    LEFT JOIN task_priority_scores p ON t.id = p.task_id
    WHERE t.status = 'queued'
    ORDER BY COALESCE(p.combined_score, 0.5) DESC, t.created_at ASC
    LIMIT 1
  `).get();
}

/**
 * Manually boost priority
 */
function boostPriority(taskId, boostAmount, reason) {
  const existing = db.prepare('SELECT * FROM task_priority_scores WHERE task_id = ?').get(taskId);

  if (existing) {
    const newScore = Math.min(1, Math.max(0, existing.combined_score + boostAmount));
    const factors = safeJsonParse(existing.factors, {});
    factors.manual_boost = { amount: boostAmount, reason, applied_at: new Date().toISOString() };

    db.prepare(`
      UPDATE task_priority_scores
      SET combined_score = ?, factors = ?, computed_at = ?
      WHERE task_id = ?
    `).run(newScore, JSON.stringify(factors), new Date().toISOString(), taskId);

    return { task_id: taskId, previous_score: existing.combined_score, new_score: newScore };
  }

  // Create new entry with boost
  const newScore = Math.min(1, Math.max(0, 0.5 + boostAmount));
  const factors = { manual_boost: { amount: boostAmount, reason, applied_at: new Date().toISOString() } };

  db.prepare(`
    INSERT INTO task_priority_scores
    (task_id, combined_score, factors, computed_at)
    VALUES (?, ?, ?, ?)
  `).run(taskId, newScore, JSON.stringify(factors), new Date().toISOString());

  return { task_id: taskId, previous_score: 0.5, new_score: newScore };
}


// ============================================================
// Failure Prediction (merged from failure-prediction.js)
// ============================================================

/**
 * Extract keywords from text for pattern matching
 */
function extractKeywords(text) {
  if (!text) return [];

  // Common high-signal words for failures
  const signalWords = [
    'deploy', 'production', 'prod', 'delete', 'remove', 'drop',
    'migrate', 'migration', 'upgrade', 'install', 'build', 'test',
    'compile', 'publish', 'release', 'rollback', 'revert'
  ];

  const tokens = text.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  return tokens.filter(t => signalWords.includes(t));
}

/**
 * Learn failure pattern from a failed task
 */
function learnFailurePattern(taskId) {
  const getTask = getTaskFn;
  const task = getTask(taskId);
  if (!task || task.status !== 'failed') {
    return null;
  }

  const patterns = [];
  const now = new Date().toISOString();

  // Keyword patterns
  const keywords = extractKeywords(task.task_description);
  for (const keyword of keywords) {
    const patternDef = { keyword, context: 'description' };
    const patternId = crypto.createHash('md5').update(`keyword:${keyword}`).digest('hex').substring(0, 16);

    const existing = db.prepare('SELECT * FROM failure_patterns WHERE id = ?').get(patternId);

    if (existing) {
      db.prepare(`
        UPDATE failure_patterns
        SET failure_count = failure_count + 1,
            total_matches = total_matches + 1,
            failure_rate = CAST(failure_count + 1 AS REAL) / (total_matches + 1),
            last_updated_at = ?
        WHERE id = ?
      `).run(now, patternId);
    } else {
      db.prepare(`
        INSERT INTO failure_patterns (id, pattern_type, pattern_definition, failure_count, total_matches, failure_rate, confidence, created_at, last_updated_at)
        VALUES (?, 'keyword', ?, 1, 1, 1.0, 0.3, ?, ?)
      `).run(patternId, JSON.stringify(patternDef), now, now);
    }
    patterns.push({ id: patternId, type: 'keyword', definition: patternDef });
  }

  // Time-based pattern
  const hour = new Date(task.created_at).getHours();
  const timePatternDef = { hour_start: hour, hour_end: hour + 1 };
  const timePatternId = crypto.createHash('md5').update(`time:${hour}`).digest('hex').substring(0, 16);

  const existingTime = db.prepare('SELECT * FROM failure_patterns WHERE id = ?').get(timePatternId);
  if (existingTime) {
    db.prepare(`
      UPDATE failure_patterns
      SET failure_count = failure_count + 1,
          total_matches = total_matches + 1,
          failure_rate = CAST(failure_count + 1 AS REAL) / (total_matches + 1),
          last_updated_at = ?
      WHERE id = ?
    `).run(now, timePatternId);
  } else {
    db.prepare(`
      INSERT INTO failure_patterns (id, pattern_type, pattern_definition, failure_count, total_matches, failure_rate, confidence, created_at, last_updated_at)
      VALUES (?, 'time_based', ?, 1, 1, 1.0, 0.2, ?, ?)
    `).run(timePatternId, JSON.stringify(timePatternDef), now, now);
  }
  patterns.push({ id: timePatternId, type: 'time_based', definition: timePatternDef });

  // Resource pattern (long-running tasks)
  if (task.completed_at && task.started_at) {
    const duration = (new Date(task.completed_at) - new Date(task.started_at)) / 1000;
    if (duration > 1800) { // > 30 min
      const resourcePatternDef = { duration_threshold: 1800 };
      const resourcePatternId = crypto.createHash('md5').update('resource:duration:1800').digest('hex').substring(0, 16);

      const existingResource = db.prepare('SELECT * FROM failure_patterns WHERE id = ?').get(resourcePatternId);
      if (existingResource) {
        db.prepare(`
          UPDATE failure_patterns
          SET failure_count = failure_count + 1,
              total_matches = total_matches + 1,
              failure_rate = CAST(failure_count + 1 AS REAL) / (total_matches + 1),
              last_updated_at = ?
          WHERE id = ?
        `).run(now, resourcePatternId);
      } else {
        db.prepare(`
          INSERT INTO failure_patterns (id, pattern_type, pattern_definition, failure_count, total_matches, failure_rate, confidence, created_at, last_updated_at)
          VALUES (?, 'resource', ?, 1, 1, 1.0, 0.2, ?, ?)
        `).run(resourcePatternId, JSON.stringify(resourcePatternDef), now, now);
      }
      patterns.push({ id: resourcePatternId, type: 'resource', definition: resourcePatternDef });
    }
  }

  return patterns;
}

/**
 * Match patterns against a task
 */
function matchPatterns(taskDescription, _workingDirectory) {
  const patterns = db.prepare(`
    SELECT * FROM failure_patterns
    WHERE confidence >= 0.3
    ORDER BY failure_rate DESC
  `).all();

  const matches = [];
  const keywords = extractKeywords(taskDescription);
  const hour = new Date().getHours();

  for (const pattern of patterns) {
    const def = safeJsonParse(pattern.pattern_definition, {});
    let matched = false;

    switch (pattern.pattern_type) {
      case 'keyword':
        matched = keywords.includes(def.keyword);
        break;
      case 'time_based':
        matched = hour >= def.hour_start && hour < def.hour_end;
        break;
      case 'resource':
        // Can't match resource patterns until task runs
        break;
      case 'sequence':
        // Would need task history context
        break;
    }

    if (matched) {
      matches.push(pattern);
    }
  }

  return matches;
}

/**
 * Predict failure probability for a task
 */
function predictFailureForTask(taskDescription, workingDirectory) {
  const matchedPatterns = matchPatterns(taskDescription, workingDirectory);

  if (matchedPatterns.length === 0) {
    return { probability: 0.1, patterns: [], confidence: 0.5 };
  }

  // Weighted average of pattern failure rates
  let totalWeight = 0;
  let weightedSum = 0;

  for (const pattern of matchedPatterns) {
    const weight = pattern.confidence * pattern.total_matches;
    weightedSum += pattern.failure_rate * weight;
    totalWeight += weight;
  }

  const probability = totalWeight > 0 ? weightedSum / totalWeight : 0.1;
  const confidence = Math.min(1.0, totalWeight / 100);

  return {
    probability,
    patterns: matchedPatterns.map(p => ({
      id: p.id,
      type: p.pattern_type,
      definition: safeJsonParse(p.pattern_definition, {}),
      failure_rate: p.failure_rate,
      confidence: p.confidence
    })),
    confidence
  };
}

/**
 * List failure patterns
 */
function listFailurePatterns(options = {}) {
  const { patternType, minConfidence = 0, limit = 50 } = options;

  let query = 'SELECT * FROM failure_patterns WHERE confidence >= ?';
  const params = [minConfidence];

  if (patternType) {
    query += ' AND pattern_type = ?';
    params.push(patternType);
  }

  query += ' ORDER BY failure_rate DESC, total_matches DESC LIMIT ?';
  params.push(limit);

  const patterns = db.prepare(query).all(...params);
  return patterns.map(p => ({
    ...p,
    pattern_definition: safeJsonParse(p.pattern_definition, {}),
    suggested_intervention: safeJsonParse(p.suggested_intervention, null)
  }));
}

/**
 * Delete a failure pattern
 */
function deleteFailurePattern(patternId) {
  const result = db.prepare('DELETE FROM failure_patterns WHERE id = ?').run(patternId);
  return result.changes > 0;
}

/**
 * Generate intervention suggestions based on matched patterns
 */
function suggestIntervention(taskDescription, workingDirectory) {
  const prediction = predictFailureForTask(taskDescription, workingDirectory);
  const interventions = [];

  if (prediction.probability > 0.5) {
    interventions.push({
      type: 'flag_for_review',
      reason: `High failure probability (${(prediction.probability * 100).toFixed(1)}%)`,
      priority: 'high'
    });
  }

  for (const pattern of prediction.patterns) {
    if (pattern.type === 'keyword' && ['deploy', 'production', 'prod'].includes(pattern.definition.keyword)) {
      interventions.push({
        type: 'increase_timeout',
        factor: 1.5,
        reason: `Production deployment detected`
      });
      interventions.push({
        type: 'add_retry_delay',
        seconds: 30,
        reason: 'Allow for deployment propagation'
      });
    }

    if (pattern.type === 'time_based') {
      interventions.push({
        type: 'suggest_reschedule',
        reason: `Tasks at this hour have ${(pattern.failure_rate * 100).toFixed(1)}% failure rate`
      });
    }
  }

  return { prediction, interventions };
}

/**
 * Log intelligence action
 */
function logIntelligenceAction(taskId, actionType, actionDetails, confidence) {
  db.prepare(`
    INSERT INTO intelligence_log (task_id, action_type, action_details, confidence, outcome, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(taskId, actionType, JSON.stringify(actionDetails), confidence, new Date().toISOString());

  return db.prepare('SELECT last_insert_rowid() as id').get().id;
}

/**
 * Update intelligence outcome for feedback loop
 */
function updateIntelligenceOutcome(logId, outcome) {
  db.prepare(`
    UPDATE intelligence_log SET outcome = ? WHERE id = ?
  `).run(outcome, logId);

  // Get the log entry to update pattern confidence
  const log = db.prepare('SELECT * FROM intelligence_log WHERE id = ?').get(logId);
  if (log && log.action_type === 'failure_predicted') {
    const details = safeJsonParse(log.action_details, {});

    // Update pattern confidence based on outcome
    for (const patternId of (details.pattern_ids || [])) {
      const adjustment = outcome === 'correct' ? 0.05 : -0.1;
      db.prepare(`
        UPDATE failure_patterns
        SET confidence = MIN(1.0, MAX(0.1, confidence + ?)),
            last_updated_at = ?
        WHERE id = ?
      `).run(adjustment, new Date().toISOString(), patternId);
    }

    // Prune low-confidence patterns with enough samples
    db.prepare(`
      DELETE FROM failure_patterns
      WHERE confidence < 0.3 AND total_matches >= 20
    `).run();
  }
}


// ============================================================
// Adaptive Retry (merged from adaptive-retry.js)
// ============================================================

/**
 * Analyze retry patterns to find what works
 */
function analyzeRetryPatterns(since = null) {
  const whereClause = since ? 'WHERE rh.timestamp >= ?' : '';
  const params = since ? [since] : [];

  const results = db.prepare(`
    SELECT
      rh.strategy_used,
      SUBSTR(t.error_output, 1, 100) as error_type,
      COUNT(*) as attempts,
      SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as successes
    FROM retry_history rh
    JOIN tasks t ON rh.task_id = t.id
    ${whereClause}
    GROUP BY rh.strategy_used, SUBSTR(t.error_output, 1, 100)
    HAVING attempts >= 3
    ORDER BY successes DESC
  `).all(...params);

  return results.map(r => ({
    ...r,
    success_rate: r.attempts > 0 ? r.successes / r.attempts : 0
  }));
}

/**
 * Create or update adaptive retry rule
 */
function createAdaptiveRetryRule(errorPattern, ruleType, adjustment) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO adaptive_retry_rules (id, error_pattern, rule_type, adjustment, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, errorPattern, ruleType, JSON.stringify(adjustment), new Date().toISOString());
  return id;
}

/**
 * Get adaptive retry rules
 */
function getAdaptiveRetryRules(errorText = null) {
  if (errorText) {
    return db.prepare(`
      SELECT * FROM adaptive_retry_rules
      WHERE enabled = 1 AND ? LIKE '%' || error_pattern || '%'
      ORDER BY success_count DESC
    `).all(errorText).map(r => {
      try { return { ...r, adjustment: JSON.parse(r.adjustment) }; }
      catch { return { ...r, adjustment: {} }; }
    });
  }

  return db.prepare('SELECT * FROM adaptive_retry_rules WHERE enabled = 1').all().map(r => {
    try { return { ...r, adjustment: JSON.parse(r.adjustment) }; }
    catch { return { ...r, adjustment: {} }; }
  });
}

/**
 * Update retry rule stats
 */
function updateRetryRuleStats(ruleId, succeeded) {
  if (succeeded) {
    db.prepare('UPDATE adaptive_retry_rules SET success_count = success_count + 1 WHERE id = ?').run(ruleId);
  } else {
    db.prepare('UPDATE adaptive_retry_rules SET failure_count = failure_count + 1 WHERE id = ?').run(ruleId);
  }
}

/**
 * Get retry recommendation for a task
 */
function getRetryRecommendation(taskId, previousError) {
  const getTask = getTaskFn;
  const task = getTask(taskId);
  if (!task) return null;

  const adaptations = {};
  const appliedRules = [];

  // Check adaptive rules
  const rules = getAdaptiveRetryRules(previousError);
  for (const rule of rules) {
    appliedRules.push(rule.id);
    Object.assign(adaptations, rule.adjustment);
  }

  // Default adaptations based on error patterns
  if (!rules.length) {
    if (previousError && previousError.includes('timeout')) {
      adaptations.timeout_factor = 1.5;
    }
    if (previousError && (previousError.includes('rate limit') || previousError.includes('429'))) {
      adaptations.delay_seconds = 60;
    }
    if (previousError && (previousError.includes('memory') || previousError.includes('OOM'))) {
      adaptations.suggest_smaller_scope = true;
    }
  }

  return {
    task_id: taskId,
    original_timeout: task.timeout_minutes,
    adaptations,
    applied_rules: appliedRules
  };
}


// ============================================================
// Experimentation (merged from experimentation.js)
// ============================================================

/**
 * Create A/B experiment
 */
function createExperiment(name, strategyType, variantA, variantB, sampleSize = 100) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO strategy_experiments
    (id, name, strategy_type, variant_a, variant_b, status, sample_size_target, results_a, results_b, created_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
  `).run(
    id, name, strategyType,
    JSON.stringify(variantA), JSON.stringify(variantB),
    sampleSize,
    JSON.stringify({ count: 0, successes: 0, total_duration: 0 }),
    JSON.stringify({ count: 0, successes: 0, total_duration: 0 }),
    now
  );

  return { id, name, strategy_type: strategyType };
}

/**
 * Get experiment by ID
 */
function getExperiment(experimentId) {
  const exp = db.prepare('SELECT * FROM strategy_experiments WHERE id = ?').get(experimentId);
  if (!exp) return null;

  const safeParse = (v) => { try { return JSON.parse(v); } catch { return null; } };
  return {
    ...exp,
    variant_a: safeParse(exp.variant_a),
    variant_b: safeParse(exp.variant_b),
    results_a: safeParse(exp.results_a),
    results_b: safeParse(exp.results_b)
  };
}

/**
 * List experiments
 */
function listExperiments(status = null) {
  const safeParse = (v) => { try { return JSON.parse(v); } catch { return null; } };
  const query = status
    ? 'SELECT * FROM strategy_experiments WHERE status = ? ORDER BY created_at DESC'
    : 'SELECT * FROM strategy_experiments ORDER BY created_at DESC';
  const params = status ? [status] : [];

  return db.prepare(query).all(...params).map(exp => ({
    ...exp,
    variant_a: safeParse(exp.variant_a),
    variant_b: safeParse(exp.variant_b),
    results_a: safeParse(exp.results_a),
    results_b: safeParse(exp.results_b)
  }));
}

/**
 * Assign experiment variant to task
 */
function assignExperimentVariant(taskId, experimentId) {
  // Deterministic assignment based on task ID hash
  const hash = crypto.createHash('md5').update(taskId + experimentId).digest('hex');
  return parseInt(hash.slice(0, 8), 16) % 2 === 0 ? 'a' : 'b';
}

/**
 * Record experiment outcome
 */
function recordExperimentOutcome(experimentId, variant, succeeded, duration) {
  const exp = getExperiment(experimentId);
  if (!exp || exp.status !== 'running') return false;

  const resultsKey = variant === 'a' ? 'results_a' : 'results_b';
  const results = variant === 'a' ? exp.results_a : exp.results_b;

  results.count++;
  if (succeeded) results.successes++;
  results.total_duration += duration || 0;

  db.prepare(`UPDATE strategy_experiments SET ${resultsKey} = ? WHERE id = ?`).run(
    JSON.stringify(results), experimentId
  );

  return true;
}

/**
 * Compute experiment significance
 */
function computeExperimentSignificance(experimentId) {
  const exp = getExperiment(experimentId);
  if (!exp) return null;

  const a = exp.results_a;
  const b = exp.results_b;

  if (a.count < 10 || b.count < 10) {
    return { significant: false, reason: 'insufficient_samples', experiment: exp };
  }

  const rateA = a.successes / a.count;
  const rateB = b.successes / b.count;

  // Simple z-test for proportions
  const pooledRate = (a.successes + b.successes) / (a.count + b.count);
  const se = Math.sqrt(pooledRate * (1 - pooledRate) * (1/a.count + 1/b.count));
  const z = se > 0 ? Math.abs(rateA - rateB) / se : 0;

  return {
    significant: z > 1.96,
    z_score: z,
    rate_a: rateA,
    rate_b: rateB,
    winner: rateA > rateB ? 'a' : 'b',
    experiment: exp
  };
}

/**
 * Conclude experiment
 */
function concludeExperiment(experimentId, applyWinner = false) {
  const setCacheConfig = dbFunctions.setCacheConfig;
  const significance = computeExperimentSignificance(experimentId);
  if (!significance) return null;

  const winner = significance.significant ? significance.winner : null;

  db.prepare(`
    UPDATE strategy_experiments
    SET status = 'completed', winner = ?, completed_at = ?
    WHERE id = ?
  `).run(winner, new Date().toISOString(), experimentId);

  if (applyWinner && winner) {
    const exp = significance.experiment;
    const winningConfig = winner === 'a' ? exp.variant_a : exp.variant_b;

    // Apply winning config based on strategy type
    if (exp.strategy_type === 'prioritization') {
      setPriorityWeights(winningConfig);
    } else if (exp.strategy_type === 'caching') {
      Object.entries(winningConfig).forEach(([k, v]) => setCacheConfig(k, v.toString()));
    }
  }

  return { ...significance, applied: applyWinner && winner };
}

/**
 * Get intelligence dashboard metrics
 */
function getIntelligenceDashboard(since = null) {
  const getCacheStats = dbFunctions.getCacheStats;
  const params = since ? [since] : [];

  // Cache stats
  const cacheStats = getCacheStats(since);

  // Prediction accuracy
  const predictionStats = db.prepare(`
    SELECT
      COUNT(*) as total_predictions,
      COUNT(CASE WHEN outcome = 'correct' THEN 1 END) as correct,
      COUNT(CASE WHEN outcome = 'incorrect' THEN 1 END) as incorrect,
      COUNT(CASE WHEN outcome = 'pending' THEN 1 END) as pending
    FROM intelligence_log
    WHERE action_type = 'failure_predicted'
    ${since ? 'AND created_at >= ?' : ''}
  `).get(...params);

  // Pattern stats
  const patternStats = db.prepare(`
    SELECT
      COUNT(*) as total_patterns,
      AVG(confidence) as avg_confidence,
      AVG(failure_rate) as avg_failure_rate
    FROM failure_patterns
  `).get();

  // Experiment stats
  const experimentStats = db.prepare(`
    SELECT
      COUNT(*) as total_experiments,
      COUNT(CASE WHEN status = 'running' THEN 1 END) as running,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed
    FROM strategy_experiments
  `).get();

  return {
    cache: cacheStats,
    predictions: {
      ...predictionStats,
      accuracy: (predictionStats.correct + predictionStats.incorrect) > 0
        ? predictionStats.correct / (predictionStats.correct + predictionStats.incorrect)
        : null
    },
    patterns: patternStats,
    experiments: experimentStats
  };
}


module.exports = {
  // DI
  setDb,
  setGetTask,
  setDbFunctions,
  setFindSimilarTasks,
  setSetPriorityWeights,
  // Duration Prediction
  recordDurationPrediction,
  updatePredictionActual,
  getPredictionModel,
  updatePredictionModel,
  predictDuration,
  extractPatternKey,
  estimateFromKeywords,
  calibratePredictionModels,
  getPatternCondition,
  getDurationInsights,
  // Prioritization
  setPriorityWeights,
  computeResourceScore,
  computeSuccessScore,
  computeDependencyScore,
  getPriorityWeights,
  computePriorityScore,
  getPriorityQueue,
  getHighestPriorityQueuedTask,
  boostPriority,
  // Failure Prediction
  extractKeywords,
  learnFailurePattern,
  matchPatterns,
  predictFailureForTask,
  listFailurePatterns,
  deleteFailurePattern,
  suggestIntervention,
  logIntelligenceAction,
  updateIntelligenceOutcome,
  // Adaptive Retry
  analyzeRetryPatterns,
  createAdaptiveRetryRule,
  getAdaptiveRetryRules,
  updateRetryRuleStats,
  getRetryRecommendation,
  // Experimentation
  createExperiment,
  getExperiment,
  listExperiments,
  assignExperimentVariant,
  recordExperimentOutcome,
  computeExperimentSignificance,
  concludeExperiment,
  getIntelligenceDashboard,
};
