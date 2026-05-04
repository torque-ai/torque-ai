'use strict';

const factoryHealth = require('../db/factory/health');
const factoryFeedback = require('../db/factory/feedback');
const guardrailDb = require('../db/factory/guardrails');
const logger = require('../logger').child({ component: 'factory-feedback-analysis' });

const VALID_CORRECTION_TYPES = new Set([
  'priority_override',
  'scope_change',
  'plan_rejection',
  'trust_adjustment',
]);

let _db = null;

function init(deps = {}) {
  if (deps.db) {
    _db = deps.db;
  }
  return module.exports;
}

function analyzeBatch(project_id, batch_id, options = {}) {
  if (!project_id) throw new Error('project_id is required');

  const latestScores = factoryHealth.getLatestScores(project_id);
  const health_delta = buildHealthDelta(project_id, latestScores);
  const execution_metrics = buildExecutionMetrics(options, health_delta);
  const guardrail_activity = getGuardrailActivity(project_id, batch_id);
  const summary = buildAnalysisSummary(health_delta, execution_metrics);

  const record = factoryFeedback.recordFeedback({
    project_id,
    batch_id,
    health_delta,
    execution_metrics,
    guardrail_activity,
    human_corrections: options.human_corrections ?? null,
  });

  logger.debug(
    {
      project_id,
      batch_id,
      feedback_id: record.id,
      task_count: execution_metrics.task_count,
      total_guardrail_events: guardrail_activity.total,
    },
    'Recorded post-batch feedback analysis'
  );

  return {
    feedback_id: record.id,
    health_delta,
    execution_metrics,
    guardrail_activity,
    summary,
  };
}

function detectDrift(project_id, options = {}) {
  if (!project_id) throw new Error('project_id is required');

  const window = toPositiveInteger(options.window, 10);
  const recentPatterns = factoryFeedback.getPatterns(project_id, { limit: window });
  if (recentPatterns.length < 3) {
    return {
      drift_detected: false,
      patterns: [],
      message: 'Insufficient history (need 3+ batches)',
    };
  }

  const history = [...recentPatterns].reverse();
  const dimensions = collectDimensions(history);
  const patterns = [];

  const oscillatingDimensions = dimensions.filter((dimension) =>
    hasAlternatingSignRun(history.map((entry) => getDimensionDelta(entry, dimension)), 3)
  );
  if (oscillatingDimensions.length > 0) {
    patterns.push({
      type: 'priority_oscillation',
      severity: 'warning',
      details: `Alternating delta direction detected in recent batches (${oscillatingDimensions.join(', ')})`,
      dimensions: oscillatingDimensions,
    });
  }

  const diminishingDimensions = dimensions.filter((dimension) => {
    const lastThree = history
      .slice(-3)
      .map((entry) => getDimensionDelta(entry, dimension));

    return (
      lastThree.length === 3 &&
      lastThree.every((value) => typeof value === 'number' && value > 0) &&
      lastThree[0] > lastThree[1] &&
      lastThree[1] > lastThree[2]
    );
  });
  if (diminishingDimensions.length > 0) {
    patterns.push({
      type: 'diminishing_returns',
      severity: 'info',
      details: `Latest positive gains are shrinking across recent batches (${diminishingDimensions.join(', ')})`,
      dimensions: diminishingDimensions,
    });
  }

  const scopeRun = findIncreasingRun(history.map((entry) => getExecutionMetric(entry, 'task_count')), 3);
  if (scopeRun) {
    patterns.push({
      type: 'scope_creep',
      severity: 'warning',
      details: `Task count increased across ${scopeRun.length} consecutive batches (${scopeRun.values.join(' -> ')})`,
      dimensions: [],
    });
  }

  const costRun = findIncreasingRun(
    history.map((entry) => getExecutionMetric(entry, 'cost_per_health_point')),
    3
  );
  if (costRun) {
    patterns.push({
      type: 'cost_creep',
      severity: 'critical',
      details: `Cost per health point increased across ${costRun.length} consecutive batches (${costRun.values.map(formatNumber).join(' -> ')})`,
      dimensions: [],
    });
  }

  return {
    drift_detected: patterns.length > 0,
    patterns,
    message:
      patterns.length > 0
        ? `Detected ${patterns.length} drift pattern(s): ${patterns.map((pattern) => pattern.type).join(', ')}`
        : 'No systemic drift detected in recent feedback history',
  };
}

function recordHumanCorrection(project_id, correction) {
  if (!project_id) throw new Error('project_id is required');
  validateCorrection(correction);

  const correctionRecord = {
    ...correction,
    type: correction.type,
    description: correction.description,
    recorded_at: new Date().toISOString(),
  };

  const latestFeedback = factoryFeedback.getProjectFeedback(project_id, { limit: 1 })[0];
  if (!latestFeedback) {
    const created = factoryFeedback.recordFeedback({
      project_id,
      human_corrections: [correctionRecord],
    });

    logger.debug(
      { project_id, feedback_id: created.id, correction_type: correctionRecord.type },
      'Recorded human correction on new feedback entry'
    );

    return { recorded: true, feedback_id: created.id, correction: correctionRecord };
  }

  const rawDb = getRawDb();
  const existingCorrections = parseCorrectionList(
    latestFeedback.human_corrections,
    latestFeedback.human_corrections_json,
    latestFeedback.id
  );
  existingCorrections.push(correctionRecord);

  rawDb
    .prepare('UPDATE factory_feedback SET human_corrections_json = ? WHERE id = ?')
    .run(JSON.stringify(existingCorrections), latestFeedback.id);

  logger.debug(
    { project_id, feedback_id: latestFeedback.id, correction_type: correctionRecord.type },
    'Recorded human correction on existing feedback'
  );

  return { recorded: true, feedback_id: latestFeedback.id, correction: correctionRecord };
}

function buildHealthDelta(project_id, latestScores) {
  const healthDelta = {};

  for (const [dimension, latestScore] of Object.entries(latestScores || {})) {
    const recentHistory = getRecentScoreHistory(project_id, dimension);
    const after = recentHistory.length > 0
      ? toNumber(recentHistory[recentHistory.length - 1].score, latestScore)
      : toNumber(latestScore);
    const before = recentHistory.length > 1
      ? toNumber(recentHistory[recentHistory.length - 2].score, after)
      : after;

    healthDelta[dimension] = {
      before,
      after,
      delta: after - before,
    };
  }

  return healthDelta;
}

function buildExecutionMetrics(options, health_delta) {
  const task_count = toNumber(options.task_count);
  const retry_count = toNumber(options.retry_count);
  const duration_seconds = toNumber(options.duration_seconds);
  const estimated_cost = toNumber(options.estimated_cost);
  const totalImprovement = getTotalImprovement(health_delta);

  return {
    task_count,
    retry_count,
    duration_seconds,
    estimated_cost,
    remediation_rate: retry_count / Math.max(task_count, 1),
    cost_per_health_point: estimated_cost / Math.max(totalImprovement, 0.01),
  };
}

function getGuardrailActivity(project_id, batch_id) {
  const events = guardrailDb
    .getEvents(project_id, { batch_id: batch_id ?? null, limit: 100 });

  let pass_count = 0;
  let warn_count = 0;
  let fail_count = 0;

  for (const event of events) {
    if (event.status === 'pass') pass_count += 1;
    else if (event.status === 'warn') warn_count += 1;
    else if (event.status === 'fail') fail_count += 1;
  }

  return {
    total: events.length,
    pass_count,
    warn_count,
    fail_count,
  };
}

function buildAnalysisSummary(health_delta, execution_metrics) {
  const totalImprovement = getTotalImprovement(health_delta);
  const weakestDelta = getWeakestDelta(health_delta);
  const weakestLabel = weakestDelta
    ? `${weakestDelta.dimension} ${formatSigned(weakestDelta.delta)}`
    : 'none';

  return [
    `Total improvement ${formatSigned(totalImprovement)}`,
    `weakest delta ${weakestLabel}`,
    `cost efficiency ${formatCurrency(execution_metrics.cost_per_health_point)} per health point`,
  ].join('; ');
}

function getRecentScoreHistory(project_id, dimension) {
  const history = factoryHealth.getScoreHistory(project_id, dimension, 2, { order: 'DESC' }) || [];
  return history.reverse();
}

function getExecutionMetric(entry, key) {
  const metrics = entry && entry.execution_metrics;
  if (!metrics || metrics[key] === undefined || metrics[key] === null) {
    return null;
  }
  return toNumber(metrics[key], null);
}

function getDimensionDelta(entry, dimension) {
  const dimensionDelta = entry && entry.health_delta && entry.health_delta[dimension];
  if (!dimensionDelta || dimensionDelta.delta === undefined || dimensionDelta.delta === null) {
    return null;
  }
  return toNumber(dimensionDelta.delta, null);
}

function collectDimensions(history) {
  const dimensions = new Set();
  for (const entry of history) {
    for (const dimension of Object.keys(entry.health_delta || {})) {
      dimensions.add(dimension);
    }
  }
  return [...dimensions];
}

function getTotalImprovement(health_delta) {
  return Object.values(health_delta || {}).reduce((sum, entry) => {
    const delta = entry && typeof entry.delta === 'number' ? entry.delta : 0;
    return sum + (delta > 0 ? delta : 0);
  }, 0);
}

function getWeakestDelta(health_delta) {
  let weakest = null;

  for (const [dimension, entry] of Object.entries(health_delta || {})) {
    if (!entry || typeof entry.delta !== 'number') continue;
    if (!weakest || entry.delta < weakest.delta) {
      weakest = { dimension, delta: entry.delta };
    }
  }

  return weakest;
}

function hasAlternatingSignRun(values, minLength) {
  let previousSign = 0;
  let runLength = 0;

  for (const value of values) {
    const sign = getSign(value);
    if (sign === 0) {
      previousSign = 0;
      runLength = 0;
      continue;
    }

    if (previousSign === 0) {
      previousSign = sign;
      runLength = 1;
      continue;
    }

    if (sign === previousSign * -1) {
      runLength += 1;
    } else {
      runLength = 1;
    }

    previousSign = sign;
    if (runLength >= minLength) {
      return true;
    }
  }

  return false;
}

function findIncreasingRun(values, minLength) {
  let runStart = 0;
  let runLength = 1;

  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];

    if (typeof previous !== 'number' || typeof current !== 'number') {
      runStart = index;
      runLength = 1;
      continue;
    }

    if (current > previous) {
      runLength += 1;
    } else {
      runStart = index;
      runLength = 1;
    }

    if (runLength >= minLength) {
      return {
        length: runLength,
        values: values.slice(runStart, index + 1),
      };
    }
  }

  return null;
}

function validateCorrection(correction) {
  if (!correction || typeof correction !== 'object' || Array.isArray(correction)) {
    throw new Error('correction must be an object');
  }
  if (!correction.type || typeof correction.type !== 'string' || !VALID_CORRECTION_TYPES.has(correction.type)) {
    throw new Error(`correction.type must be one of: ${[...VALID_CORRECTION_TYPES].join(', ')}`);
  }
  if (!correction.description || typeof correction.description !== 'string') {
    throw new Error('correction.description is required');
  }
}

function parseCorrectionList(parsedCorrections, jsonValue, feedbackId) {
  if (Array.isArray(parsedCorrections)) return [...parsedCorrections];
  if (!jsonValue) return [];

  try {
    const value = JSON.parse(jsonValue);
    return Array.isArray(value) ? value : [];
  } catch (error) {
    logger.warn(
      { feedback_id: feedbackId, err: error.message },
      'Failed to parse existing human corrections JSON'
    );
    return [];
  }
}

function ensureDbInitialized() {
  if (_db) return;
  try {
    const { defaultContainer } = require('../container');
    if (defaultContainer && defaultContainer.has && defaultContainer.has('db')) {
      _db = defaultContainer.get('db');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Lazy DI init failed for factory feedback analysis');
  }
}

function getRawDb() {
  ensureDbInitialized();
  const rawDb = typeof _db?.getDbInstance === 'function'
    ? _db.getDbInstance()
    : (typeof _db?.prepare === 'function' ? _db : null);
  if (!rawDb) {
    throw new Error('Factory feedback analysis requires an active database connection');
  }
  return rawDb;
}

function getSign(value) {
  if (typeof value !== 'number' || value === 0) return 0;
  return value > 0 ? 1 : -1;
}

function toPositiveInteger(value, fallback) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function toNumber(value, fallback = 0) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function formatNumber(value) {
  return toNumber(value).toFixed(2);
}

function formatSigned(value) {
  const normalized = toNumber(value);
  return `${normalized > 0 ? '+' : ''}${normalized.toFixed(2)}`;
}

function formatCurrency(value) {
  return `$${toNumber(value).toFixed(2)}`;
}

module.exports = {
  init,
  analyzeBatch,
  detectDrift,
  recordHumanCorrection,
};
