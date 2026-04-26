'use strict';

const perfCounters = require('../operations-perf-counters');

const DEFAULT_WARNING_PERCENT = 80;
const DEFAULT_DOWNGRADE_PERCENT = 90;
const DEFAULT_HARD_STOP_PERCENT = 100;
const DEFAULT_DOWNGRADE_TEMPLATE = 'Cost Saver';

const NOOP_EVENT_BUS = Object.freeze({
  emit: () => {},
});

let globalState = {
  db: null,
  eventBus: NOOP_EVENT_BUS,
};

// Cache for hasThresholdConfigColumn results keyed by db instance.
// WeakMap so entries are GC'd when the db instance is no longer referenced.
const _hasThresholdConfigColumnCache = new WeakMap();

function init(dbInstance, eventBus) {
  globalState = {
    db: dbInstance || null,
    eventBus: eventBus || NOOP_EVENT_BUS,
  };
}

function requireDb(dbInstance) {
  const database = dbInstance || globalState.db;
  if (!database || typeof database.prepare !== 'function') {
    throw new Error('budget-watcher requires a valid BetterSQLite3 database');
  }
  return database;
}

function resolveEventBus(eventBus) {
  if (eventBus && typeof eventBus.emit === 'function') {
    return eventBus;
  }
  return globalState.eventBus || NOOP_EVENT_BUS;
}

function normalizePercent(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }
  return numericValue;
}

function normalizeBudgetAmount(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return 0;
  }
  return Number(numericValue.toFixed(6));
}

function roundPercent(value) {
  return Number(Number(value || 0).toFixed(2));
}

function safeJsonParse(value, fallback = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_error) {
    // intentionally ignore malformed JSON and use defaults
  }
  return fallback;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return null;
  }
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
    default:
      {
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

function hasThresholdConfigColumn(database) {
  if (_hasThresholdConfigColumnCache.has(database)) {
    return _hasThresholdConfigColumnCache.get(database);
  }
  const columns = database.prepare('PRAGMA table_info(cost_budgets)').all();
  const result = columns.some((column) => column.name === 'threshold_config');
  _hasThresholdConfigColumnCache.set(database, result);
  perfCounters.increment('pragmaCostBudgets');
  return result;
}

function hasBudgetThresholdActionsTable(database) {
  const row = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'budget_threshold_actions'
  `).get();
  return !!row;
}

function ensureBudgetThresholdActionsTable(database) {
  database.prepare(`
    CREATE TABLE IF NOT EXISTS budget_threshold_actions (
      budget_id TEXT PRIMARY KEY,
      warning_percent REAL,
      downgrade_percent REAL,
      downgrade_template TEXT,
      hard_stop_percent REAL
    )
  `).run();
}

function ensureThresholdConfigStorage(database) {
  if (hasThresholdConfigColumn(database)) {
    return 'column';
  }

  try {
    database.prepare('ALTER TABLE cost_budgets ADD COLUMN threshold_config TEXT').run();
    return 'column';
  } catch (_error) {
    ensureBudgetThresholdActionsTable(database);
    return 'table';
  }
}

function readThresholdConfig(database, budget) {
  if (!budget || !budget.id) {
    return null;
  }

  if (hasThresholdConfigColumn(database)) {
    return safeJsonParse(budget.threshold_config);
  }

  if (!hasBudgetThresholdActionsTable(database)) {
    return null;
  }

  const row = database.prepare(`
    SELECT warning_percent, downgrade_percent, downgrade_template, hard_stop_percent
    FROM budget_threshold_actions
    WHERE budget_id = ?
  `).get(budget.id);

  if (!row) {
    return null;
  }

  return {
    warningPercent: row.warning_percent,
    downgradePercent: row.downgrade_percent,
    downgradeTemplate: row.downgrade_template,
    hardStopPercent: row.hard_stop_percent,
  };
}

function resolveThresholds(database, budget) {
  const raw = readThresholdConfig(database, budget);
  const warningPercent = normalizePercent(
    raw?.warningPercent,
    DEFAULT_WARNING_PERCENT
  );
  const downgradePercent = normalizePercent(
    raw?.downgradePercent,
    DEFAULT_DOWNGRADE_PERCENT
  );
  const hardStopPercent = normalizePercent(
    raw?.hardStopPercent,
    DEFAULT_HARD_STOP_PERCENT
  );
  const downgradeTemplate = typeof raw?.downgradeTemplate === 'string'
    ? raw.downgradeTemplate.trim()
    : '';

  return {
    warningPercent,
    downgradePercent,
    hardStopPercent,
    downgradeTemplate: downgradeTemplate || DEFAULT_DOWNGRADE_TEMPLATE,
  };
}

function getCurrentSpend(database, budget) {
  const { start, end } = getPeriodWindow(budget.period || 'monthly');
  const provider = budget.provider || null;

  if (provider) {
    if (start === null || end === null) {
      const row = database.prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) AS spend
        FROM cost_tracking
        WHERE provider = ?
      `).get(provider);
      return Number(Number(row?.spend || 0).toFixed(6));
    }

    const row = database.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS spend
      FROM cost_tracking
      WHERE provider = ? AND tracked_at >= ? AND tracked_at < ?
    `).get(provider, start, end);
    return Number(Number(row?.spend || 0).toFixed(6));
  }

  if (start === null || end === null) {
    const row = database.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS spend
      FROM cost_tracking
    `).get();
    return Number(Number(row?.spend || 0).toFixed(6));
  }

  const row = database.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS spend
    FROM cost_tracking
    WHERE tracked_at >= ? AND tracked_at < ?
  `).get(start, end);
  return Number(Number(row?.spend || 0).toFixed(6));
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
      action: 'activate_cost_saver',
    };
  }

  if (spendPercent >= thresholds.warningPercent) {
    return {
      thresholdBreached: 'warning',
      action: 'emit_warning',
    };
  }

  return {
    thresholdBreached: null,
    action: null,
  };
}

function buildBudgetStatus(database, budget) {
  const budgetAmount = normalizeBudgetAmount(budget.budget_amount);
  const spendAmount = getCurrentSpend(database, budget);
  const spendPercent = budgetAmount > 0
    ? roundPercent((spendAmount / budgetAmount) * 100)
    : (spendAmount > 0 ? 100 : 0);
  const thresholds = resolveThresholds(database, budget);
  const status = evaluateThreshold(spendPercent, thresholds);

  return {
    budgetName: budget.name,
    provider: budget.provider,
    spendAmount,
    budgetAmount,
    spendPercent,
    thresholdBreached: status.thresholdBreached,
    action: status.action,
  };
}

function compareBudgetStatuses(left, right) {
  const priority = {
    hard_stop: 3,
    downgrade: 2,
    warning: 1,
    null: 0,
  };
  const leftPriority = priority[left.thresholdBreached || 'null'] || 0;
  const rightPriority = priority[right.thresholdBreached || 'null'] || 0;

  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }

  if (left.spendPercent !== right.spendPercent) {
    return right.spendPercent - left.spendPercent;
  }

  return String(left.budgetName).localeCompare(String(right.budgetName));
}

function listEnabledBudgets(database, provider) {
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
    WHERE enabled = 1
      AND (provider = ? OR provider IS NULL)
    ORDER BY name ASC
  `).all(provider);
}

function emitBudgetEvent(eventBus, status) {
  if (!status || !status.thresholdBreached) {
    return;
  }

  switch (status.thresholdBreached) {
    case 'warning':
      eventBus.emit('budget:warning', {
        budgetName: status.budgetName,
        provider: status.provider,
        spendPercent: status.spendPercent,
      });
      break;
    case 'downgrade':
      eventBus.emit('budget:downgrade', {
        budgetName: status.budgetName,
        provider: status.provider,
        spendPercent: status.spendPercent,
        template: 'Cost Saver',
      });
      break;
    case 'hard_stop':
      eventBus.emit('budget:hard_stop', {
        budgetName: status.budgetName,
        provider: status.provider,
        spendPercent: status.spendPercent,
      });
      break;
    default:
      break;
  }
}

function checkBudgetThresholdsInternal(database, eventBus, provider) {
  const budgets = listEnabledBudgets(database, provider);
  if (!budgets.length) {
    return null;
  }

  const statuses = budgets.map((budget) => buildBudgetStatus(database, budget))
    .sort(compareBudgetStatuses);

  const highest = statuses[0] || null;
  if (!highest) {
    return null;
  }

  emitBudgetEvent(eventBus, highest);
  return highest;
}

function getActiveBudgetsInternal(database) {
  return listEnabledBudgets(database).map((budget) => buildBudgetStatus(database, budget));
}

function configureBudgetActionInternal(database, budgetId, config = {}) {
  const budget = database.prepare(`
    SELECT *
    FROM cost_budgets
    WHERE id = ?
  `).get(budgetId);

  if (!budget) {
    return null;
  }

  const current = resolveThresholds(database, budget);
  const storage = ensureThresholdConfigStorage(database);
  const next = {
    warningPercent: Object.prototype.hasOwnProperty.call(config, 'warningPercent')
      ? normalizePercent(config.warningPercent, current.warningPercent)
      : current.warningPercent,
    downgradePercent: Object.prototype.hasOwnProperty.call(config, 'downgradePercent')
      ? normalizePercent(config.downgradePercent, current.downgradePercent)
      : current.downgradePercent,
    hardStopPercent: Object.prototype.hasOwnProperty.call(config, 'hardStopPercent')
      ? normalizePercent(config.hardStopPercent, current.hardStopPercent)
      : current.hardStopPercent,
    downgradeTemplate: Object.prototype.hasOwnProperty.call(config, 'downgradeTemplate')
      ? (typeof config.downgradeTemplate === 'string' ? config.downgradeTemplate.trim() : '')
      : current.downgradeTemplate,
  };

  if (next.downgradeTemplate === '') {
    next.downgradeTemplate = DEFAULT_DOWNGRADE_TEMPLATE;
  }

  if (storage === 'column') {
    const normalized = {
      warningPercent: next.warningPercent,
      downgradePercent: next.downgradePercent,
      downgradeTemplate: next.downgradeTemplate,
      hardStopPercent: next.hardStopPercent,
    };
    const serialized = safeJsonStringify(normalized);
    if (serialized !== null) {
      database.prepare(`
        UPDATE cost_budgets
        SET threshold_config = ?
        WHERE id = ?
      `).run(serialized, budgetId);
    }
  } else {
    ensureBudgetThresholdActionsTable(database);
    database.prepare(`
      INSERT INTO budget_threshold_actions (
        budget_id, warning_percent, downgrade_percent, downgrade_template, hard_stop_percent
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(budget_id) DO UPDATE SET
        warning_percent = excluded.warning_percent,
        downgrade_percent = excluded.downgrade_percent,
        downgrade_template = excluded.downgrade_template,
        hard_stop_percent = excluded.hard_stop_percent
    `).run(
      budgetId,
      next.warningPercent,
      next.downgradePercent,
      next.downgradeTemplate,
      next.hardStopPercent
    );
  }

  return {
    warningPercent: next.warningPercent,
    downgradePercent: next.downgradePercent,
    downgradeTemplate: next.downgradeTemplate,
    hardStopPercent: next.hardStopPercent,
  };
}

function shouldBlockSubmissionInternal(database, provider) {
  const result = checkBudgetThresholdsInternal(database, NOOP_EVENT_BUS, provider);
  return result?.thresholdBreached === 'hard_stop';
}

function createBudgetWatcher({ db: dbInstance, eventBus } = {}) {
  const database = requireDb(dbInstance);
  const watcherEventBus = resolveEventBus(eventBus);

  return {
    checkBudgetThresholds: (provider) => checkBudgetThresholdsInternal(database, watcherEventBus, provider),
    getActiveBudgets: () => getActiveBudgetsInternal(database),
    configureBudgetAction: (budgetId, config) => configureBudgetActionInternal(database, budgetId, config),
    shouldBlockSubmission: (provider) => shouldBlockSubmissionInternal(database, provider),
  };
}

module.exports = {
  createBudgetWatcher,
  init,
  hasThresholdConfigColumn,
  checkBudgetThresholds: (provider) => createBudgetWatcher({}).checkBudgetThresholds(provider),
  getActiveBudgets: () => createBudgetWatcher({}).getActiveBudgets(),
  configureBudgetAction: (budgetId, config) => createBudgetWatcher({}).configureBudgetAction(budgetId, config),
  shouldBlockSubmission: (provider) => createBudgetWatcher({}).shouldBlockSubmission(provider),
};
