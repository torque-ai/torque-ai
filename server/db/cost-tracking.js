'use strict';

/**
 * Cost Tracking Module
 *
 * Extracted from database.js — token usage recording, cost estimation,
 * budget management, and cost summary functions.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 * Uses setGetTask() to receive the getTask helper (avoids circular require).
 */

const logger = require('../logger').child({ component: 'cost-tracking' });

const VALID_COST_PERIOD_FORMATS = Object.freeze({
  hour: '%Y-%m-%d %H:00',
  day: '%Y-%m-%d',
  week: '%Y-W%W',
  month: '%Y-%m',
});

let db;
let getTaskFn;

function setDb(dbInstance) {
  db = dbInstance;
  if (db && typeof db.prepare === 'function') {
    _ensureFreeTierTable();
  }
}

function setGetTask(fn) {
  getTaskFn = fn;
}

function normalizeTokenCount(value) {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function normalizeTaskMetadata(rawMetadata) {
  if (!rawMetadata) {
    return {};
  }

  if (typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
    return { ...rawMetadata };
  }

  if (typeof rawMetadata !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(rawMetadata);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return { ...parsed };
  } catch {
    return {};
  }
}

function markTaskBudgetExceeded(taskId, budgetResult, provider, estimatedCostUsd) {
  if (!taskId || !db) {
    return false;
  }

  const task = getTaskFn ? getTaskFn(taskId) : null;
  if (!task) {
    return false;
  }

  const metadata = normalizeTaskMetadata(task.metadata);
  metadata.budget_exceeded = true;
  metadata.budget_exceeded_info = {
    provider: provider || null,
    budget: budgetResult?.budget,
    current: budgetResult?.current,
    limit: budgetResult?.limit,
    estimated_cost_usd: estimatedCostUsd,
    checked_at: new Date().toISOString(),
  };

  const stmt = db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?');
  stmt.run(JSON.stringify(metadata), taskId);
  return true;
}

function checkBudgetBeforeSubmission(provider, estimatedCost) {
  if (!db) {
    return { allowed: true, skipped: true };
  }

  if (!Number.isFinite(estimatedCost) || estimatedCost <= 0) {
    return { allowed: true, skipped: true };
  }

  const budgets = db.prepare(
    'SELECT * FROM cost_budgets WHERE (provider = ? OR provider IS NULL) AND enabled = 1'
  ).all(provider);

  if (!budgets || budgets.length === 0) {
    return { allowed: true, skipped: true };
  }

  for (const budget of budgets) {
    const projectedSpend = budget.current_spend + estimatedCost;
    if (projectedSpend > budget.budget_usd) {
      return {
        allowed: false,
        budget: budget.name,
        current: budget.current_spend,
        limit: budget.budget_usd
      };
    }
  }

  return { allowed: true, checkedBudgets: budgets.length };
}

// Cost estimates per 1K tokens (approximate, may vary)
const COST_PER_1K_TOKENS = {
  'gpt-4': { input: 0.03, output: 0.06 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-5': { input: 0.02, output: 0.06 },
  'gpt-5.2': { input: 0.015, output: 0.045 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'codex': { input: 0.01, output: 0.02 },
  'default': { input: 0.01, output: 0.02 }
};

/**
 * Get model pricing with DB override support.
 * Checks for a database-stored custom pricing entry first,
 * falling back to the hardcoded COST_PER_1K_TOKENS table.
 */
function getModelPricing(model) {
  // Check DB for custom pricing first
  try {
    if (db) {
      const configKey = `pricing_${model.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const custom = db.prepare('SELECT value FROM config WHERE key = ?').get(configKey);
      if (custom && custom.value) return JSON.parse(custom.value);
    }
  } catch { /* fall through to defaults */ }
  // Fall back to hardcoded defaults
  return COST_PER_1K_TOKENS[model] || COST_PER_1K_TOKENS.default;
}

// ============================================
// Token Usage Tracking
// ============================================

function recordTokenUsage(taskId, usage) {
  const inputRaw = usage && usage.input_tokens;
  const outputRaw = usage && usage.output_tokens;

  if ((typeof inputRaw === 'number' && (inputRaw < 0 || !Number.isFinite(inputRaw))) ||
      (typeof outputRaw === 'number' && (outputRaw < 0 || !Number.isFinite(outputRaw)))) {
    return 0;
  }

  const model = usage.model || 'default';
  const costs = getModelPricing(model);
  const inputTokens = normalizeTokenCount(inputRaw);
  const outputTokens = normalizeTokenCount(outputRaw);

  const inputCost = (inputTokens / 1000) * costs.input;
  const outputCost = (outputTokens / 1000) * costs.output;
  const estimatedCost = inputCost + outputCost;

  const task = getTaskFn ? getTaskFn(taskId) : null;
  const project = task ? task.project : null;

  const stmt = db.prepare(`
    INSERT INTO token_usage (
      task_id, input_tokens, output_tokens, total_tokens,
      estimated_cost_usd, model, recorded_at, project
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    taskId,
    inputTokens,
    outputTokens,
    inputTokens + outputTokens,
    estimatedCost,
    model,
    new Date().toISOString(),
    project
  );

  return {
    task_id: taskId,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    estimated_cost_usd: estimatedCost,
    model,
    project
  };
}

function getTaskTokenUsage(taskId) {
  const stmt = db.prepare(`
    SELECT * FROM token_usage WHERE task_id = ? ORDER BY recorded_at DESC
  `);
  return stmt.all(taskId);
}

function getTokenUsageSummary(options = {}) {
  let query = `
    SELECT
      COUNT(DISTINCT task_id) as task_count,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(estimated_cost_usd), 0) as total_cost_usd,
      COALESCE(AVG(total_tokens), 0) as avg_tokens_per_task,
      COALESCE(AVG(estimated_cost_usd), 0) as avg_cost_per_task
    FROM token_usage
    WHERE 1=1
  `;
  const values = [];

  if (options.project) {
    query += ' AND project = ?';
    values.push(options.project);
  }

  if (options.since) {
    query += ' AND recorded_at >= ?';
    values.push(options.since);
  }

  if (options.until) {
    query += ' AND recorded_at <= ?';
    values.push(options.until);
  }

  const stmt = db.prepare(query);
  const summary = stmt.get(...values);

  let modelQuery = `
    SELECT
      model,
      COUNT(*) as task_count,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(estimated_cost_usd), 0) as total_cost
    FROM token_usage
    WHERE 1=1
  `;
  const modelValues = [];

  if (options.project) {
    modelQuery += ' AND project = ?';
    modelValues.push(options.project);
  }

  if (options.since) {
    modelQuery += ' AND recorded_at >= ?';
    modelValues.push(options.since);
  }

  if (options.until) {
    modelQuery += ' AND recorded_at <= ?';
    modelValues.push(options.until);
  }

  modelQuery += ' GROUP BY model ORDER BY total_cost DESC';

  const modelBreakdownStmt = db.prepare(modelQuery);
  const modelBreakdown = modelBreakdownStmt.all(...modelValues);

  const byModel = {};
  for (const row of modelBreakdown) {
    byModel[row.model] = {
      task_count: row.task_count,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cost_usd: row.total_cost
    };
  }

  return {
    ...summary,
    by_model: byModel
  };
}

function getCostByPeriod(period = 'day', limit = 30) {
  const fmt = VALID_COST_PERIOD_FORMATS[period];
  if (!fmt) {
    throw new Error('Invalid period');
  }

  const stmt = db.prepare(`
    SELECT
      strftime(?, recorded_at) as period,
      COUNT(DISTINCT task_id) as tasks,
      SUM(total_tokens) as tokens,
      SUM(estimated_cost_usd) as cost
    FROM token_usage
    GROUP BY strftime(?, recorded_at)
    ORDER BY period DESC
    LIMIT ?
  `);

  return stmt.all(fmt, fmt, limit);
}

function estimateCost(taskDescription, model = 'codex') {
  const estimatedInputTokens = Math.ceil(taskDescription.length / 4);
  const estimatedOutputTokens = estimatedInputTokens * 2;

  const costs = getModelPricing(model);
  const inputCost = (estimatedInputTokens / 1000) * costs.input;
  const outputCost = (estimatedOutputTokens / 1000) * costs.output;

  return {
    estimated_input_tokens: estimatedInputTokens,
    estimated_output_tokens: estimatedOutputTokens,
    estimated_total_tokens: estimatedInputTokens + estimatedOutputTokens,
    estimated_cost_usd: inputCost + outputCost,
    model,
    note: 'Estimates based on task description length. Actual usage may vary.'
  };
}

// ============================================
// Provider Cost Tracking & Budgets
// ============================================

function recordCost(provider, taskId, inputTokens, outputTokens, model) {
  if ((typeof inputTokens === 'number' && (inputTokens < 0 || !Number.isFinite(inputTokens))) ||
      (typeof outputTokens === 'number' && (outputTokens < 0 || !Number.isFinite(outputTokens)))) {
    return 0;
  }

  const normalizedInputTokens = normalizeTokenCount(inputTokens);
  const normalizedOutputTokens = normalizeTokenCount(outputTokens);
  const costRates = {
    'claude-cli': { input: 0.003, output: 0.015 },
    'codex': { input: 0.002, output: 0.010 },
    'aider-ollama': { input: 0, output: 0 }
  };

  const rates = costRates[provider] || { input: 0.003, output: 0.015 };
  const costUsd = (normalizedInputTokens / 1000 * rates.input) + (normalizedOutputTokens / 1000 * rates.output);

  const stmt = db.prepare(`
    INSERT INTO cost_tracking (provider, task_id, input_tokens, output_tokens, cost_usd, model, tracked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(provider, taskId, normalizedInputTokens, normalizedOutputTokens, costUsd, model, new Date().toISOString());

  const budgetUpdate = updateBudgetSpend(provider, costUsd);
  if (budgetUpdate && budgetUpdate.allowed === false) {
    markTaskBudgetExceeded(taskId, budgetUpdate, provider, costUsd);
  }

  return costUsd;
}

function updateBudgetSpend(provider, costUsd) {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    return { allowed: true, skipped: true };
  }

  const txn = db.transaction(() => {
    const budgetRows = db.prepare(
      'SELECT * FROM cost_budgets WHERE (provider = ? OR provider IS NULL) AND enabled = 1'
    ).all(provider).filter(Boolean);

    if (!budgetRows || budgetRows.length === 0) {
      return { allowed: true, skipped: true };
    }

    for (const budget of budgetRows) {
      const projectedSpend = budget.current_spend + costUsd;
      if (projectedSpend > budget.budget_usd) {
        return {
          allowed: false,
          budget: budget.name,
          current: budget.current_spend,
          limit: budget.budget_usd
        };
      }
    }

    const updateStmt = db.prepare('UPDATE cost_budgets SET current_spend = current_spend + ? WHERE id = ?');
    for (const budget of budgetRows) {
      updateStmt.run(costUsd, budget.id);
    }

    return { allowed: true, updatedBudgets: budgetRows.length };
  });

  return txn();
}

function resetExpiredBudgets() {
  const budgets = db.prepare(
    'SELECT * FROM cost_budgets WHERE enabled = 1 AND reset_at IS NOT NULL'
  ).all();

  let resetCount = 0;
  const now = new Date();

  for (const budget of budgets) {
    const resetAt = new Date(budget.reset_at);
    let periodMs;
    switch (budget.period) {
      case 'daily': periodMs = 24 * 60 * 60 * 1000; break;
      case 'weekly': periodMs = 7 * 24 * 60 * 60 * 1000; break;
      case 'monthly': periodMs = 30 * 24 * 60 * 60 * 1000; break;
      case 'total': continue; // Total budgets never auto-reset; they are cumulative by design.
      default: continue;
    }

    if (now.getTime() - resetAt.getTime() >= periodMs) {
      db.prepare('UPDATE cost_budgets SET current_spend = 0, reset_at = ? WHERE id = ?')
        .run(now.toISOString(), budget.id);
      logger.info(`[Budget] Reset "${budget.name}" (period: ${budget.period}, was: $${budget.current_spend.toFixed(2)})`);
      resetCount++;
    }
  }
  return resetCount;
}

function deleteBudget(budgetId) {
  const result = db.prepare('DELETE FROM cost_budgets WHERE id = ?').run(budgetId);
  if (result.changes === 0) {
    // Try by name
    const byName = db.prepare('DELETE FROM cost_budgets WHERE name = ?').run(budgetId);
    return { deleted: byName.changes > 0, id: budgetId };
  }
  return { deleted: true, id: budgetId };
}

function getCostSummary(provider = null, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  if (provider) {
    return db.prepare(`
      SELECT provider, COUNT(*) as task_count, SUM(input_tokens) as total_input,
             SUM(output_tokens) as total_output, SUM(cost_usd) as total_cost
      FROM cost_tracking WHERE provider = ? AND tracked_at > ?
      GROUP BY provider
    `).get(provider, since);
  }

  return db.prepare(`
    SELECT provider, COUNT(*) as task_count, SUM(input_tokens) as total_input,
           SUM(output_tokens) as total_output, SUM(cost_usd) as total_cost
    FROM cost_tracking WHERE tracked_at > ?
    GROUP BY provider
  `).all(since);
}

function getBudgetStatus(budgetId = null) {
  if (budgetId) {
    return db.prepare('SELECT * FROM cost_budgets WHERE id = ?').get(budgetId);
  }
  return db.prepare('SELECT * FROM cost_budgets WHERE enabled = 1').all();
}

function isBudgetExceeded(provider = null) {
  const budgets = provider
    ? db.prepare('SELECT * FROM cost_budgets WHERE (provider = ? OR provider IS NULL) AND enabled = 1').all(provider)
    : db.prepare('SELECT * FROM cost_budgets WHERE enabled = 1').all();

  for (const budget of budgets) {
    if (budget.current_spend >= budget.budget_usd) {
      return { exceeded: true, budget: budget.name, spent: budget.current_spend, limit: budget.budget_usd };
    }
    if (budget.current_spend >= budget.budget_usd * (budget.alert_threshold_percent / 100)) {
      return { warning: true, budget: budget.name, spent: budget.current_spend, limit: budget.budget_usd };
    }
  }
  return { exceeded: false, warning: false };
}

function setBudget(name, budgetUsd, provider = null, period = 'monthly', alertThreshold = 80) {
  const id = `budget-${name.toLowerCase().replace(/\s+/g, '-')}`;
  const now = new Date().toISOString();

  // Try update-by-name first (handles seeded rows with different IDs)
  const existing = db.prepare('SELECT id FROM cost_budgets WHERE name = ?').get(name);
  if (existing) {
    db.prepare(`
      UPDATE cost_budgets SET budget_usd = ?, provider = ?, period = ?, alert_threshold_percent = ?
      WHERE name = ?
    `).run(budgetUsd, provider, period, alertThreshold, name);
    return { id: existing.id, name, budget_usd: budgetUsd, provider, period, alert_threshold: alertThreshold };
  }

  const stmt = db.prepare(`
    INSERT INTO cost_budgets (id, name, provider, budget_usd, period, alert_threshold_percent, enabled, current_spend, created_at, reset_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      provider = excluded.provider,
      budget_usd = excluded.budget_usd,
      period = excluded.period,
      alert_threshold_percent = excluded.alert_threshold_percent,
      reset_at = COALESCE(cost_budgets.reset_at, excluded.reset_at)
  `);

  stmt.run(id, name, provider, budgetUsd, period, alertThreshold, now, now);

  return { id, name, budget_usd: budgetUsd, provider, period, alert_threshold: alertThreshold };
}

/**
 * Get cost forecast based on historical spending data.
 * @param {number} [days=30] - Number of days of history to analyze
 * @returns {{ daily_avg: number, projected_monthly: number, budgets: Array }}
 */
function getCostForecast(days = 30) {
  const periods = getCostByPeriod('day', days);
  const totalCost = periods.reduce((sum, p) => sum + (p.cost || 0), 0);
  const dailyAvg = periods.length > 0 ? totalCost / periods.length : 0;
  const projectedMonthly = dailyAvg * 30;
  let slope = 0;
  let trendDirection = 'stable';
  let trendAdjustedMonthly = projectedMonthly;

  if (periods.length >= 3) {
    const sortedPeriods = periods.slice().sort((a, b) => {
      const left = String(a.period || '');
      const right = String(b.period || '');
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });

    const n = sortedPeriods.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;

    for (let dayIndex = 0; dayIndex < n; dayIndex += 1) {
      const cost = Number(sortedPeriods[dayIndex]?.cost || 0);
      sumX += dayIndex;
      sumY += cost;
      sumXY += dayIndex * cost;
      sumX2 += dayIndex * dayIndex;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator !== 0) {
      slope = (n * sumXY - sumX * sumY) / denominator;
      const intercept = (sumY - slope * sumX) / n;
      if (slope > 0.000001) {
        trendDirection = 'increasing';
      } else if (slope < -0.000001) {
        trendDirection = 'decreasing';
      }

      const nextStart = n;
      const nextEnd = n + 29;
      trendAdjustedMonthly = 0;
      for (let dayIndex = nextStart; dayIndex <= nextEnd; dayIndex += 1) {
        trendAdjustedMonthly += intercept + slope * dayIndex;
      }
    }
  }

  const budgets = getBudgetStatus();
  const budgetForecasts = (Array.isArray(budgets) ? budgets : budgets ? [budgets] : []).map(b => {
    const remaining = b.budget_usd - b.current_spend;
    const daysRemaining = dailyAvg > 0 ? remaining / dailyAvg : Infinity;
    const exhaustionDate = daysRemaining !== Infinity
      ? new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000).toISOString()
      : null;

    return {
      name: b.name,
      budget_usd: b.budget_usd,
      current_spend: b.current_spend,
      remaining_usd: Math.round(remaining * 100) / 100,
      days_remaining: daysRemaining === Infinity ? Infinity : Math.round(daysRemaining * 10) / 10,
      projected_exhaustion_date: exhaustionDate,
      period: b.period,
      utilization_percent: b.budget_usd > 0 ? Math.round(b.current_spend / b.budget_usd * 100) : 0
    };
  });

  return {
    daily_avg: Math.round(dailyAvg * 100) / 100,
    projected_monthly: Math.round(projectedMonthly * 100) / 100,
    days_analyzed: periods.length,
    total_cost_analyzed: Math.round(totalCost * 100) / 100,
    slope: slope,
    trend_direction: trendDirection,
    trend_adjusted_monthly: Math.round(trendAdjustedMonthly * 100) / 100,
    budgets: budgetForecasts
  };
}

function getWorkflowCostSummary(workflowId) {
  // Get all task IDs in this workflow
  const tasks = db.prepare(`
    SELECT id FROM tasks WHERE workflow_id = ?
  `).all(workflowId);

  if (!tasks || tasks.length === 0) {
    return { total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, by_model: [] };
  }

  const taskIds = tasks.map(t => t.id);
  const placeholders = taskIds.map(() => '?').join(',');

  const summary = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(estimated_cost_usd), 0) as total_cost_usd
    FROM token_usage
    WHERE task_id IN (${placeholders})
  `).get(...taskIds);

  const byModel = db.prepare(`
    SELECT
      model,
      COUNT(*) as task_count,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(estimated_cost_usd), 0) as cost_usd
    FROM token_usage
    WHERE task_id IN (${placeholders})
    GROUP BY model
    ORDER BY cost_usd DESC
  `).all(...taskIds);

  return {
    total_cost_usd: summary.total_cost_usd,
    total_input_tokens: summary.total_input_tokens,
    total_output_tokens: summary.total_output_tokens,
    by_model: byModel,
  };
}

// ============================================================
// Free Tier History (merged from free-tier-history.js)
// ============================================================

function _ensureFreeTierTable() {
  if (!db) return;
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS free_tier_daily_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        date TEXT NOT NULL,
        total_requests INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        rate_limit_hits INTEGER DEFAULT 0,
        avg_latency_ms REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(provider, date)
      )
    `).run();
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_free_tier_daily_usage_date
        ON free_tier_daily_usage(date)
    `).run();
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_free_tier_daily_usage_provider_date
        ON free_tier_daily_usage(provider, date)
    `).run();
  } catch {
    // Table may already exist
  }
}

function recordDailySnapshot(provider, stats = {}) {
  if (!provider || typeof provider !== 'string') {
    throw new Error('provider is required');
  }
  _ensureFreeTierTable();

  const date = stats.date || new Date().toISOString().slice(0, 10);
  const totalRequests = Number(stats.total_requests) || 0;
  const totalTokens = Number(stats.total_tokens) || 0;
  const rateLimitHits = Number(stats.rate_limit_hits) || 0;
  const avgLatencyMs = Number(stats.avg_latency_ms) || 0;

  db.prepare(`
    INSERT INTO free_tier_daily_usage (provider, date, total_requests, total_tokens, rate_limit_hits, avg_latency_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, date) DO UPDATE SET
      total_requests = excluded.total_requests,
      total_tokens = excluded.total_tokens,
      rate_limit_hits = excluded.rate_limit_hits,
      avg_latency_ms = excluded.avg_latency_ms
  `).run(provider, date, totalRequests, totalTokens, rateLimitHits, avgLatencyMs);

  logger.debug(`Recorded daily snapshot for ${provider} on ${date}: ${totalRequests} reqs, ${totalTokens} tokens`);
}

function getUsageHistory(days = 7) {
  _ensureFreeTierTable();
  const safeDays = Number.isFinite(Number(days)) ? Math.max(1, Number(days)) : 7;
  const cutoffDate = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return db.prepare(`
    SELECT provider, date, total_requests, total_tokens, rate_limit_hits, avg_latency_ms, created_at
    FROM free_tier_daily_usage
    WHERE date >= ?
    ORDER BY date ASC, provider ASC
  `).all(cutoffDate).map(_mapFreeTierRow);
}

function getProviderHistory(provider, days = 7) {
  if (!provider || typeof provider !== 'string') {
    return [];
  }
  _ensureFreeTierTable();
  const safeDays = Number.isFinite(Number(days)) ? Math.max(1, Number(days)) : 7;
  const cutoffDate = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return db.prepare(`
    SELECT provider, date, total_requests, total_tokens, rate_limit_hits, avg_latency_ms, created_at
    FROM free_tier_daily_usage
    WHERE provider = ? AND date >= ?
    ORDER BY date ASC
  `).all(provider, cutoffDate).map(_mapFreeTierRow);
}

function _mapFreeTierRow(row) {
  if (!row) return row;
  return {
    provider: row.provider,
    date: row.date,
    total_requests: Number(row.total_requests) || 0,
    total_tokens: Number(row.total_tokens) || 0,
    rate_limit_hits: Number(row.rate_limit_hits) || 0,
    avg_latency_ms: Number(row.avg_latency_ms) || 0,
    created_at: row.created_at,
  };
}

module.exports = {
  setDb,
  setGetTask,
  COST_PER_1K_TOKENS,
  getModelPricing,
  // Token Usage
  recordTokenUsage,
  getTaskTokenUsage,
  getTokenUsageSummary,
  getCostByPeriod,
  estimateCost,
  // Provider Cost Tracking
  recordCost,
  checkBudgetBeforeSubmission,
  updateBudgetSpend,
  resetExpiredBudgets,
  deleteBudget,
  getCostSummary,
  getBudgetStatus,
  isBudgetExceeded,
  setBudget,
  // Workflow Cost
  getWorkflowCostSummary,
  // Cost Forecasting
  getCostForecast,
  // Free Tier History (from free-tier-history.js)
  recordDailySnapshot,
  getUsageHistory,
  getProviderHistory,
};
