'use strict';

const { safeJsonParse, safeJsonStringify } = require('../utils/json');

const DEFAULT_WARNING_PERCENT = 80;
const DEFAULT_DOWNGRADE_PERCENT = 90;
const DEFAULT_HARD_STOP_PERCENT = 100;

const THRESHOLD_PRIORITY = Object.freeze({
  hard_stop: 3,
  downgrade: 2,
  warning: 1,
  null: 0,
});

let db;
let budgetMetadataColumnExists = null;

function init(dbInstance) {
  db = dbInstance;
  budgetMetadataColumnExists = null;
}

function requireDb() {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('budget-watcher has not been initialized');
  }
  return db;
}

function normalizePercent(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }
  return numericValue;
}

function normalizeBudgetLimit(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return 0;
  }
  return numericValue;
}

function roundCurrency(value) {
  return Number(Number(value || 0).toFixed(6));
}

function roundPercent(value) {
  return Number(Number(value || 0).toFixed(2));
}

function getBudgetMetadata(rawMetadata) {
  const parsed = safeJsonParse(rawMetadata, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return { ...parsed };
}

function hasBudgetMetadataColumn() {
  if (budgetMetadataColumnExists !== null) {
    return budgetMetadataColumnExists;
  }

  const database = requireDb();
  const columns = database.prepare('PRAGMA table_info(cost_budgets)').all();
  budgetMetadataColumnExists = columns.some((column) => column.name === 'metadata');
  return budgetMetadataColumnExists;
}

function getPeriodWindow(period, referenceTime = new Date()) {
  const now = new Date(referenceTime);

  switch (period) {
    case 'daily': {
      const start = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0
      ));
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);
      return { start: start.toISOString(), end: end.toISOString() };
    }
    case 'weekly': {
      const start = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0
      ));
      const dayOfWeek = start.getUTCDay();
      const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      start.setUTCDate(start.getUTCDate() - diffToMonday);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 7);
      return { start: start.toISOString(), end: end.toISOString() };
    }
    case 'hourly':
    case 'hour': {
      const start = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        0,
        0,
        0
      ));
      const end = new Date(start);
      end.setUTCHours(end.getUTCHours() + 1);
      return { start: start.toISOString(), end: end.toISOString() };
    }
    case 'total':
      return { start: null, end: null };
    case 'monthly':
    default: {
      const start = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        1,
        0,
        0,
        0,
        0
      ));
      const end = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() + 1,
        1,
        0,
        0,
        0,
        0
      ));
      return { start: start.toISOString(), end: end.toISOString() };
    }
  }
}

function calculateCurrentSpend(budget) {
  const database = requireDb();
  const provider = budget.provider || null;
  const { start, end } = getPeriodWindow(budget.period || 'monthly');

  if (start === null || end === null) {
    if (provider) {
      const row = database.prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) AS spend
        FROM cost_tracking
        WHERE provider = ?
      `).get(provider);
      return roundCurrency(row?.spend || 0);
    }

    const row = database.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS spend
      FROM cost_tracking
    `).get();
    return roundCurrency(row?.spend || 0);
  }

  if (provider) {
    const row = database.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS spend
      FROM cost_tracking
      WHERE provider = ? AND tracked_at >= ? AND tracked_at < ?
    `).get(provider, start, end);
    return roundCurrency(row?.spend || 0);
  }

  const row = database.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS spend
    FROM cost_tracking
    WHERE tracked_at >= ? AND tracked_at < ?
  `).get(start, end);
  return roundCurrency(row?.spend || 0);
}

function resolveThresholds(budget) {
  const metadata = getBudgetMetadata(budget.metadata);

  return {
    warningPercent: normalizePercent(
      budget.alert_threshold_percent,
      DEFAULT_WARNING_PERCENT
    ),
    downgradePercent: normalizePercent(
      metadata.downgradePercent,
      DEFAULT_DOWNGRADE_PERCENT
    ),
    downgradeTemplate: typeof metadata.downgradeTemplate === 'string' && metadata.downgradeTemplate.trim()
      ? metadata.downgradeTemplate.trim()
      : null,
    hardStopPercent: normalizePercent(
      metadata.hardStopPercent,
      DEFAULT_HARD_STOP_PERCENT
    ),
  };
}

function evaluateThreshold(spendPercent, thresholds) {
  if (spendPercent >= thresholds.hardStopPercent) {
    return {
      thresholdBreached: 'hard_stop',
      action: 'block_submissions',
    };
  }

  if (spendPercent >= thresholds.downgradePercent) {
    return {
      thresholdBreached: 'downgrade',
      action: 'activate_cost_saver_template',
    };
  }

  if (spendPercent >= thresholds.warningPercent) {
    return {
      thresholdBreached: 'warning',
      action: null,
    };
  }

  return {
    thresholdBreached: null,
    action: null,
  };
}

function buildBudgetStatus(budget) {
  const budgetUsd = normalizeBudgetLimit(budget.budget_usd);
  const currentSpend = calculateCurrentSpend(budget);
  const spendPercent = budgetUsd > 0
    ? roundPercent((currentSpend / budgetUsd) * 100)
    : (currentSpend > 0 ? DEFAULT_HARD_STOP_PERCENT : 0);
  const thresholds = resolveThresholds(budget);
  const status = evaluateThreshold(spendPercent, thresholds);

  return {
    budgetName: budget.name,
    budgetUsd,
    currentSpend,
    spendPercent,
    thresholdBreached: status.thresholdBreached,
    action: status.action,
  };
}

function listEnabledBudgets(provider = undefined) {
  const database = requireDb();

  if (provider === undefined || provider === null) {
    return database.prepare(`
      SELECT *
      FROM cost_budgets
      WHERE enabled = 1
      ORDER BY name ASC
    `).all();
  }

  return database.prepare(`
    SELECT *
    FROM cost_budgets
    WHERE enabled = 1 AND (provider = ? OR provider IS NULL)
    ORDER BY name ASC
  `).all(provider);
}

function compareBudgetStatuses(left, right) {
  const leftPriority = THRESHOLD_PRIORITY[left.thresholdBreached || 'null'] || 0;
  const rightPriority = THRESHOLD_PRIORITY[right.thresholdBreached || 'null'] || 0;

  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }

  if (left.spendPercent !== right.spendPercent) {
    return right.spendPercent - left.spendPercent;
  }

  return String(left.budgetName).localeCompare(String(right.budgetName));
}

function checkBudgetThresholds(provider) {
  const budgets = listEnabledBudgets(provider);
  if (!budgets.length) {
    return null;
  }

  const budgetStatuses = budgets.map(buildBudgetStatus).sort(compareBudgetStatuses);
  return budgetStatuses[0] || null;
}

function getActiveBudgets() {
  return listEnabledBudgets().map(buildBudgetStatus);
}

function configureBudgetAction(budgetName, config = {}) {
  const database = requireDb();
  const budget = database.prepare(`
    SELECT *
    FROM cost_budgets
    WHERE name = ?
  `).get(budgetName);

  if (!budget) {
    return null;
  }

  const warningPercent = Object.prototype.hasOwnProperty.call(config, 'warningPercent')
    ? normalizePercent(config.warningPercent, DEFAULT_WARNING_PERCENT)
    : normalizePercent(budget.alert_threshold_percent, DEFAULT_WARNING_PERCENT);
  const currentMetadata = getBudgetMetadata(budget.metadata);
  const nextMetadata = { ...currentMetadata };

  if (Object.prototype.hasOwnProperty.call(config, 'downgradePercent')) {
    nextMetadata.downgradePercent = normalizePercent(config.downgradePercent, DEFAULT_DOWNGRADE_PERCENT);
  }

  if (Object.prototype.hasOwnProperty.call(config, 'hardStopPercent')) {
    nextMetadata.hardStopPercent = normalizePercent(config.hardStopPercent, DEFAULT_HARD_STOP_PERCENT);
  }

  if (Object.prototype.hasOwnProperty.call(config, 'downgradeTemplate')) {
    if (config.downgradeTemplate) {
      nextMetadata.downgradeTemplate = String(config.downgradeTemplate);
    } else {
      delete nextMetadata.downgradeTemplate;
    }
  }

  if (hasBudgetMetadataColumn()) {
    database.prepare(`
      UPDATE cost_budgets
      SET alert_threshold_percent = ?, metadata = ?
      WHERE name = ?
    `).run(
      warningPercent,
      safeJsonStringify(nextMetadata),
      budgetName
    );
  } else {
    database.prepare(`
      UPDATE cost_budgets
      SET alert_threshold_percent = ?
      WHERE name = ?
    `).run(
      warningPercent,
      budgetName
    );
  }

  return {
    budgetName,
    warningPercent,
    downgradePercent: normalizePercent(nextMetadata.downgradePercent, DEFAULT_DOWNGRADE_PERCENT),
    downgradeTemplate: nextMetadata.downgradeTemplate || null,
    hardStopPercent: normalizePercent(nextMetadata.hardStopPercent, DEFAULT_HARD_STOP_PERCENT),
  };
}

function shouldBlockSubmission(provider) {
  const budgets = listEnabledBudgets(provider);
  if (!budgets.length) {
    return false;
  }

  return budgets.some((budget) => buildBudgetStatus(budget).thresholdBreached === 'hard_stop');
}

// ============================================================
// Factory function (dependency injection without singletons)
// ============================================================

function createBudgetWatcher({ db: dbInstance } = {}) {
  if (dbInstance) init(dbInstance);
  return module.exports;
}

module.exports = {
  init,
  createBudgetWatcher,
  checkBudgetThresholds,
  getActiveBudgets,
  configureBudgetAction,
  shouldBlockSubmission,
};
