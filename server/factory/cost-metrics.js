'use strict';

const logger = require('../logger').child({ component: 'factory-cost-metrics' });

const EMPTY_SUMMARY = Object.freeze({
  cycle_count: 0,
  total_cost: 0,
  total_improvement: 0,
  tasks: [],
});

const EMPTY_TASK_COST_DATA = Object.freeze({
  total_cost: 0,
  provider: null,
  has_cost_data: false,
});

const BATCH_TAG_PREFIXES = Object.freeze(['', 'batch:', 'factory:', 'workflow:']);

// ── Legacy module-level state, written only by init() (deprecated) ─────────
// Phase 4 of the universal-DI migration. Coexistence pattern.
let _db = null;

/** @deprecated Use createCostMetrics(deps) or container.get('costMetrics'). */
function init(deps = {}) {
  if (deps.db) {
    _db = deps.db;
  }
  return module.exports;
}

function getCostPerCycle(project_id, summary = buildProjectCostSummary(project_id)) {
  if (summary.cycle_count === 0 || summary.total_cost <= 0) {
    return 0;
  }

  return roundMetric(summary.total_cost / summary.cycle_count);
}

function getCostPerHealthPoint(project_id, summary = buildProjectCostSummary(project_id)) {
  if (summary.total_cost <= 0 || summary.total_improvement <= 0) {
    return 0;
  }

  return roundMetric(summary.total_cost / summary.total_improvement);
}

function getProviderEfficiency(project_id, summary = buildProjectCostSummary(project_id)) {
  if (!summary.tasks.length) {
    return [];
  }

  const byProvider = new Map();
  for (const task of summary.tasks) {
    const provider = normalizeProvider(task.provider);
    const current = byProvider.get(provider) || {
      provider,
      total_cost: 0,
      task_count: 0,
    };

    current.total_cost += task.total_cost;
    current.task_count += 1;
    byProvider.set(provider, current);
  }

  return [...byProvider.values()]
    .map((entry) => ({
      provider: entry.provider,
      total_cost: roundMetric(entry.total_cost),
      task_count: entry.task_count,
      cost_per_task: entry.task_count > 0
        ? roundMetric(entry.total_cost / entry.task_count)
        : 0,
    }))
    .sort((left, right) => {
      if (right.total_cost !== left.total_cost) {
        return right.total_cost - left.total_cost;
      }
      return left.provider.localeCompare(right.provider);
    });
}

function buildProjectCostSummary(project_id) {
  if (!project_id) {
    return EMPTY_SUMMARY;
  }

  const db = getRawDb();
  if (!db) {
    return EMPTY_SUMMARY;
  }

  try {
    const cycles = getProjectCycles(db, project_id);
    if (!cycles.length) {
      return EMPTY_SUMMARY;
    }

    const batchIds = cycles.map((cycle) => cycle.batch_id).filter(Boolean);
    if (!batchIds.length) {
      return EMPTY_SUMMARY;
    }

    const taskRows = getRelevantTasks(db, batchIds);
    const taskCostData = getTaskCostData(db, taskRows.map((task) => task.id));
    const tasks = taskRows
      .map((task) => {
        const costData = taskCostData.get(task.id) || EMPTY_TASK_COST_DATA;
        if (!costData.has_cost_data) {
          return null;
        }

        return {
          id: task.id,
          provider: costData.provider || task.provider,
          total_cost: roundMetric(costData.total_cost),
        };
      })
      .filter(Boolean);

    return {
      cycle_count: batchIds.length,
      total_cost: roundMetric(tasks.reduce((sum, task) => sum + task.total_cost, 0)),
      total_improvement: roundMetric(getTotalImprovement(cycles)),
      tasks,
    };
  } catch (error) {
    logger.debug({ project_id, error: error.message }, 'Unable to compute factory cost metrics');
    return EMPTY_SUMMARY;
  }
}

function getProjectCycles(db, project_id) {
  return db.prepare(`
    SELECT batch_id, health_delta_json
    FROM factory_feedback
    WHERE project_id = ?
      AND batch_id IS NOT NULL
      AND id IN (
        SELECT MAX(id)
        FROM factory_feedback
        WHERE project_id = ?
          AND batch_id IS NOT NULL
        GROUP BY batch_id
      )
    ORDER BY created_at ASC, id ASC
  `).all(project_id, project_id);
}

function getRelevantTasks(db, batchIds) {
  if (!batchIds.length) {
    return [];
  }

  const conditions = [];
  const values = [];

  conditions.push(`workflow_id IN (${batchIds.map(() => '?').join(', ')})`);
  values.push(...batchIds);

  for (const batchId of batchIds) {
    for (const prefix of BATCH_TAG_PREFIXES) {
      conditions.push(`tags LIKE ? ESCAPE '\\'`);
      values.push(`%"${escapeLikePattern(`${prefix}${batchId}`)}"%`);
    }
  }

  const rows = db.prepare(`
    SELECT id, provider
    FROM tasks
    WHERE ${conditions.join(' OR ')}
  `).all(...values);

  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function getTaskCostData(db, taskIds) {
  if (!Array.isArray(taskIds) || !taskIds.length) {
    return new Map();
  }

  const costData = new Map();
  for (const row of getTaskUsageRows(db, taskIds)) {
    if ((Number(row?.row_count) || 0) <= 0) {
      continue;
    }

    costData.set(row.task_id, {
      total_cost: toNumber(row.total_cost),
      provider: null,
      has_cost_data: true,
    });
  }

  for (const row of getTaskTrackingRows(db, taskIds)) {
    if ((Number(row?.row_count) || 0) <= 0 || costData.has(row.task_id)) {
      continue;
    }

    costData.set(row.task_id, {
      total_cost: toNumber(row.total_cost),
      provider: row.provider || null,
      has_cost_data: true,
    });
  }

  return costData;
}

function getTaskUsageRows(db, taskIds) {
  if (!Array.isArray(taskIds) || !taskIds.length) {
    return [];
  }

  const placeholders = taskIds.map(() => '?').join(', ');
  try {
    return db.prepare(`
      SELECT task_id,
             COALESCE(SUM(estimated_cost_usd), 0) AS total_cost,
             COUNT(*) AS row_count
      FROM token_usage
      WHERE task_id IN (${placeholders})
      GROUP BY task_id
    `).all(...taskIds);
  } catch {
    return [];
  }
}

function getTaskTrackingRows(db, taskIds) {
  if (!Array.isArray(taskIds) || !taskIds.length) {
    return [];
  }

  const placeholders = taskIds.map(() => '?').join(', ');
  try {
    return db.prepare(`
      SELECT task_id,
             COALESCE(SUM(cost_usd), 0) AS total_cost,
             COUNT(*) AS row_count,
             MAX(provider) AS provider
      FROM cost_tracking
      WHERE task_id IN (${placeholders})
      GROUP BY task_id
    `).all(...taskIds);
  } catch {
    // cost_tracking may not exist in lightweight test DBs.
    return [];
  }
}

function getTotalImprovement(cycles) {
  return cycles.reduce((sum, cycle) => {
    const healthDelta = parseJson(cycle.health_delta_json);
    if (!healthDelta) {
      return sum;
    }

    return sum + Object.values(healthDelta).reduce((cycleSum, entry) => {
      const delta = toNumber(entry?.delta);
      return cycleSum + (delta > 0 ? delta : 0);
    }, 0);
  }, 0);
}

function getRawDb() {
  try {
    if (!_db) {
      return null;
    }
    return typeof _db.getDbInstance === 'function'
      ? _db.getDbInstance()
      : (typeof _db.prepare === 'function' ? _db : null);
  } catch {
    return null;
  }
}

function parseJson(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeProvider(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'unknown';
}

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function toNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

function roundMetric(value) {
  const normalized = toNumber(value);
  return Math.round(normalized * 10000) / 10000;
}

// ── New factory shape (preferred) ─────────────────────────────────────────
function createCostMetrics(deps = {}) {
  const local = { _db: deps.db };
  function withLocalDeps(fn) {
    const prev = { _db };
    if (local._db !== undefined) _db = local._db;
    try { return fn(); } finally { _db = prev._db; }
  }
  return {
    getCostPerCycle: (...args) => withLocalDeps(() => getCostPerCycle(...args)),
    getCostPerHealthPoint: (...args) => withLocalDeps(() => getCostPerHealthPoint(...args)),
    getProviderEfficiency: (...args) => withLocalDeps(() => getProviderEfficiency(...args)),
    buildProjectCostSummary: (...args) => withLocalDeps(() => buildProjectCostSummary(...args)),
  };
}

function register(container) {
  container.register('costMetrics', ['db'], (deps) => createCostMetrics(deps));
}

module.exports = {
  // New shape (preferred)
  createCostMetrics,
  register,
  // Legacy shape (kept until task-manager.js migrates)
  init,
  getCostPerCycle,
  getCostPerHealthPoint,
  getProviderEfficiency,
  buildProjectCostSummary,
};
