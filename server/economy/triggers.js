// Economy Triggers — auto-activate/deactivate based on budget and quota

'use strict';

const db = require('../database');
const {
  getDefaultPolicy,
  getGlobalEconomyPolicy,
  setGlobalEconomyPolicy,
} = require('./policy');

const PERIOD_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

function getDatabase() {
  if (typeof db.getDb === 'function') {
    return db.getDb();
  }

  if (typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }

  return null;
}

function getBudgetPeriodStart(resetAt, period) {
  const normalizedPeriod = String(period || 'monthly').toLowerCase();
  if (normalizedPeriod === 'total') return null;

  const ms = PERIOD_MS[normalizedPeriod] || PERIOD_MS.monthly;

  const parsedResetAt = resetAt ? new Date(resetAt) : null;
  if (parsedResetAt && Number.isFinite(parsedResetAt.getTime())) {
    return parsedResetAt.toISOString();
  }

  const now = new Date();
  return new Date(now.getTime() - ms).toISOString();
}

function getBudgetCurrentUtilization(budget) {
  const database = getDatabase();
  if (!database || !budget) return null;

  const budgetUsd = Number(budget.budget_usd);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    return 0;
  }

  const periodStart = getBudgetPeriodStart(budget.reset_at, budget.period);

  let sql = 'SELECT COALESCE(SUM(COALESCE(cost_estimate, 0)), 0) AS used_cost FROM provider_usage WHERE 1=1';
  const params = [];

  if (periodStart) {
    sql += ' AND recorded_at >= ?';
    params.push(periodStart);
  }

  if (budget.provider) {
    sql += ' AND provider = ?';
    params.push(budget.provider);
  }

  const row = database.prepare(sql).get(...params);
  const used = Number(row?.used_cost || 0);
  return (used / budgetUsd) * 100;
}

/**
 * Check if any enabled budget exceeds the threshold percentage.
 *
 * @param {number|string} threshold
 * @returns {boolean}
 */
function isEconomyBudgetThresholdMet(threshold) {
  const database = getDatabase();
  if (!database) {
    return false;
  }

  const parsedThreshold = Number(threshold);
  if (!Number.isFinite(parsedThreshold)) {
    return false;
  }

  const budgets = database.prepare('SELECT id, name, provider, period, budget_usd, alert_threshold_percent, reset_at FROM cost_budgets WHERE enabled = 1').all();

  for (const budget of budgets) {
    const utilization = getBudgetCurrentUtilization(budget);

    if (!Number.isFinite(utilization)) {
      continue;
    }

    if (utilization > parsedThreshold) {
      return true;
    }
  }

  return false;
}

function getConfigValueAsNumber(key) {
  const value = db.getConfig(key);
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function checkAutoTriggerConditions(policy) {
  const currentPolicy = policy || getGlobalEconomyPolicy() || getDefaultPolicy();
  const reasons = [];

  const threshold = Number(currentPolicy?.auto_trigger_threshold);
  if (Number.isFinite(threshold) && isEconomyBudgetThresholdMet(threshold)) {
    reasons.push(`budget utilization above ${threshold}%`);
  }

  if (db.getConfig('codex_quota_exhausted') === '1') {
    reasons.push('codex quota exhausted');
  }

  const daysRemaining = getConfigValueAsNumber('cost_days_remaining');
  if (daysRemaining !== null && daysRemaining < 2) {
    reasons.push(`cost forecast indicates only ${daysRemaining} days remaining`);
  }

  return {
    shouldTrigger: reasons.length > 0,
    reasons,
  };
}

function checkAutoLiftConditions(policy) {
  const currentPolicy = policy || getGlobalEconomyPolicy() || getDefaultPolicy();
  const conditions = currentPolicy?.auto_lift_conditions || {};
  const reasons = [];

  if (conditions.budget_reset) {
    const budgetReset = db.getConfig('budget_period_reset') === '1';
    if (!budgetReset) {
      reasons.push('budget period has not reset yet');
    }

    const utilizationBelow = Number(conditions.utilization_below);
    if (Number.isFinite(utilizationBelow) && isEconomyBudgetThresholdMet(utilizationBelow)) {
      reasons.push(`budget utilization has not fallen below ${utilizationBelow}%`);
    }
  }

  if (conditions.codex_recovered && db.getConfig('codex_quota_exhausted') === '1') {
    reasons.push('codex quota has not recovered');
  }

  return {
    shouldLift: reasons.length === 0,
    reasons,
  };
}

function activateEconomyMode(trigger, reason) {
  const currentPolicy = getGlobalEconomyPolicy() || {};
  const policy = {
    ...getDefaultPolicy(),
    ...currentPolicy,
    enabled: true,
    trigger,
    reason,
  };

  setGlobalEconomyPolicy(policy);

  if (typeof db.recordEvent === 'function') {
    try {
      db.recordEvent('economy:activated', null, { trigger, reason });
    } catch {
      // Event recording is non-critical for economy mode state transitions.
    }
  }
}

function deactivateEconomyMode(reason) {
  const currentPolicy = getGlobalEconomyPolicy() || {};
  const policy = {
    ...getDefaultPolicy(),
    ...currentPolicy,
    enabled: false,
    trigger: null,
    reason,
  };

  setGlobalEconomyPolicy(policy);

  if (typeof db.recordEvent === 'function') {
    try {
      db.recordEvent('economy:deactivated', null, { reason });
    } catch {
      // Event recording is non-critical for economy mode state transitions.
    }
  }
}

module.exports = {
  isEconomyBudgetThresholdMet,
  checkAutoTriggerConditions,
  checkAutoLiftConditions,
  activateEconomyMode,
  deactivateEconomyMode,
};
