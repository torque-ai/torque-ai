'use strict';

/**
 * V2 Control-Plane Analytics & Budget Handlers
 *
 * Structured JSON REST handlers for stats, budget, strategic brain,
 * and webhook/notification visibility.
 * These return { data, meta } envelopes via v2-control-plane helpers.
 */

const taskCore = require('../db/task-core');
const costTracking = require('../db/cost-tracking');
const eventTracking = require('../db/event-tracking');
const fileTracking = require('../db/file-tracking');
const providerRoutingCore = require('../db/provider-routing-core');
const webhooksStreaming = require('../db/webhooks-streaming');
const serverConfig = require('../config');
const {
  sendSuccess,
  sendError,
  sendList,
  resolveRequestId,
} = require('./v2-control-plane');

// ─── Helpers ────────────────────────────────────────────────────────────────

function clampInt(value, min, max, fallback) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseEventDataOrNull(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function buildTimeSeries(days, provider, interval = 'day') {
  const series = [];
  const now = new Date();

  if (interval === 'hour') {
    const totalHours = days * 24;
    for (let i = totalHours - 1; i >= 0; i--) {
      const hour = new Date(now);
      hour.setMinutes(0, 0, 0);
      hour.setHours(hour.getHours() - i);
      const nextHour = new Date(hour);
      nextHour.setHours(nextHour.getHours() + 1);

      const filters = { completed_from: hour.toISOString(), completed_to: nextHour.toISOString(), includeArchived: true };
      if (provider) filters.provider = provider;

      const completed = taskCore.countTasks ? taskCore.countTasks({ ...filters, status: 'completed' }) : 0;
      const failed = taskCore.countTasks ? taskCore.countTasks({ ...filters, status: 'failed' }) : 0;
      const total = completed + failed;

      series.push({
        date: hour.toISOString(),
        hour: hour.getHours(),
        total,
        completed,
        failed,
        success_rate: total > 0
          ? Math.round((completed / ((completed + failed) || 1)) * 100)
          : 0,
      });
    }
    return series;
  }

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = nextDate.toISOString().split('T')[0];

    // Use completed_at for historical accuracy (include archived tasks)
    const filters = { completed_from: dateStr, completed_to: nextDateStr, includeArchived: true };
    if (provider) filters.provider = provider;

    const completed = taskCore.countTasks ? taskCore.countTasks({ ...filters, status: 'completed' }) : 0;
    const failed = taskCore.countTasks ? taskCore.countTasks({ ...filters, status: 'failed' }) : 0;
    const total = completed + failed;

    series.push({
      date: dateStr,
      total,
      completed,
      failed,
      success_rate: total > 0
        ? Math.round((completed / ((completed + failed) || 1)) * 100)
        : 0,
    });
  }

  return series;
}

function getRecentStrategicOperations(limit) {
  const rawTasks = taskCore.listTasks ? taskCore.listTasks({ limit: limit * 3, order: 'desc' }) : [];
  const taskList = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks || []);

  return taskList.filter((task) => {
    const description = String(task?.task_description || task?.description || '').toLowerCase();
    return description.includes('strategic')
      || description.includes('decompos')
      || description.includes('diagnos')
      || description.includes('review');
  }).slice(0, limit);
}

// ─── Stats Overview ─────────────────────────────────────────────────────────

async function handleStatsOverview(req, res) {
  const requestId = resolveRequestId(req);

  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  // Use calendar-day boundaries for all "today" counts (midnight to midnight UTC)
  const todayCompleted = taskCore.countTasks ? taskCore.countTasks({ completed_from: today, completed_to: tomorrow, status: 'completed' }) : 0;
  const todayFailed = taskCore.countTasks ? taskCore.countTasks({ completed_from: today, completed_to: tomorrow, status: 'failed' }) : 0;
  const todayRunning = taskCore.countTasks ? taskCore.countTasks({ from_date: today, to_date: tomorrow, status: 'running' }) : 0;
  const todayTotal = todayCompleted + todayFailed + todayRunning;

  // Batch all status counts into a single grouped query to avoid 5 separate DB round-trips
  const statusCounts = taskCore.countTasksByStatus ? taskCore.countTasksByStatus() : {};
  const runningCount = statusCounts.running ?? 0;
  const queuedCount = statusCounts.queued ?? 0;
  const completedCount = statusCounts.completed ?? 0;
  const failedCount = statusCounts.failed ?? 0;
  const cancelledCount = statusCounts.cancelled ?? 0;

  const successRate = todayTotal > 0
    ? Math.round((todayCompleted / ((todayCompleted + todayFailed) || 1)) * 100) : 0;

  sendSuccess(res, requestId, {
    today: {
      total: todayTotal,
      completed: todayCompleted,
      failed: todayFailed,
      success_rate: successRate,
      successRate,
    },
    active: { running: runningCount, queued: queuedCount },
    totals: {
      running: runningCount,
      queued: queuedCount,
      completed: completedCount,
      failed: failedCount,
      cancelled: cancelledCount,
    },
  }, 200, req);
}

// ─── Time Series ────────────────────────────────────────────────────────────

async function handleTimeSeries(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const days = clampInt(query.days, 1, 365, 7);
  const provider = query.provider || null;

  const interval = query.interval === 'hour' ? 'hour' : 'day';
  const series = buildTimeSeries(days, provider, interval);
  sendSuccess(res, requestId, { days, provider, interval, series }, 200, req);
}

// ─── Quality Stats ──────────────────────────────────────────────────────────

async function handleQualityStats(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const hours = clampInt(query.hours, 1, 720, 24);
  const since = new Date(Date.now() - hours * 3600000).toISOString();

  try {
    const overall = fileTracking.getOverallQualityStats ? fileTracking.getOverallQualityStats(since) : {};
    const byProvider = fileTracking.getQualityStatsByProvider ? fileTracking.getQualityStatsByProvider(since) : [];
    const validation = fileTracking.getValidationFailureRate ? fileTracking.getValidationFailureRate(since) : {};

    sendSuccess(res, requestId, {
      period: { hours, since },
      overall,
      by_provider: byProvider,
      validation,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Stuck Tasks ────────────────────────────────────────────────────────────

async function handleStuckTasks(req, res) {
  const requestId = resolveRequestId(req);
  const now = Date.now();

  const pendingApprovalThreshold = 15 * 60 * 1000;
  const longRunningThreshold = 30 * 60 * 1000;

  const pendingApproval = (taskCore.listTasks
    ? taskCore.listTasks({ status: 'pending_approval', limit: 50 })
    : []).filter(t => (now - new Date(t.created_at).getTime()) > pendingApprovalThreshold);

  const pendingSwitch = (taskCore.listTasks
    ? taskCore.listTasks({ status: 'pending_provider_switch', limit: 50 })
    : []).filter(t => (now - new Date(t.provider_switched_at || t.created_at).getTime()) > pendingApprovalThreshold);

  const longRunning = (taskCore.listTasks
    ? taskCore.listTasks({ status: 'running', limit: 50 })
    : []).filter(t => (now - new Date(t.started_at).getTime()) > longRunningThreshold);

  const waiting = taskCore.listTasks ? taskCore.listTasks({ status: 'waiting', limit: 50 }) : [];

  sendSuccess(res, requestId, {
    pending_approval: { count: pendingApproval.length, tasks: pendingApproval.slice(0, 10) },
    pending_switch: { count: pendingSwitch.length, tasks: pendingSwitch.slice(0, 10) },
    long_running: { count: longRunning.length, tasks: longRunning.slice(0, 10) },
    waiting: { count: waiting.length, tasks: waiting.slice(0, 10) },
    total_needs_attention: pendingApproval.length + pendingSwitch.length + longRunning.length + waiting.length,
  }, 200, req);
}

// ─── Model Stats ────────────────────────────────────────────────────────────

async function handleModelStats(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const days = clampInt(query.days, 1, 365, 7);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    let sqlDb;
    try {
      const { defaultContainer } = require('../container');
      sqlDb = defaultContainer.get('db');
    } catch (_e) {
      const database = require('../database');
      sqlDb = typeof database.getDbInstance === 'function' ? database.getDbInstance() : database;
    }
    if (!sqlDb || !sqlDb.prepare) {
      return sendSuccess(res, requestId, { models: [], days }, 200, req);
    }

    const rows = sqlDb.prepare(`
      SELECT model, provider,
        COUNT(*) as total,
        COUNT(*) as task_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
          THEN (julianday(completed_at) - julianday(started_at)) * 86400
          ELSE NULL END) as avg_duration_seconds,
        MAX(created_at) as last_used
      FROM tasks WHERE created_at >= ? AND model IS NOT NULL AND model != ''
      GROUP BY model, provider ORDER BY total DESC
    `).all(since);

    const modelMap = {};
    for (const row of rows) {
      if (!modelMap[row.model]) {
        modelMap[row.model] = {
          model: row.model, providers: [], total: 0, completed: 0, failed: 0,
          avg_duration_seconds: null, last_used: null,
          _totalDuration: 0, _totalCount: 0,
        };
      }
      const m = modelMap[row.model];
      m.providers.push(row.provider);
      m.total += row.total;
      m.completed += row.completed;
      m.failed += row.failed;
      if (!m.last_used || row.last_used > m.last_used) m.last_used = row.last_used;
      if (row.avg_duration_seconds != null) {
        m._totalDuration += row.avg_duration_seconds * row.task_count;
        m._totalCount += row.task_count;
        m.avg_duration_seconds = m._totalDuration / m._totalCount;
      }
    }

    const models = Object.values(modelMap).map(m => ({
      ...m,
      success_rate: m.total > 0 ? Math.round(m.completed / m.total * 100) : 0,
    }));

    const dailySeries = sqlDb.prepare(`
      SELECT
        model,
        DATE(created_at) as date,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM tasks
      WHERE created_at >= ?
        AND model IS NOT NULL
        AND model != ''
      GROUP BY model, DATE(created_at)
      ORDER BY date ASC
    `).all(since);

    sendSuccess(res, requestId, { models, dailySeries, days }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Format Success ─────────────────────────────────────────────────────────

async function handleFormatSuccess(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const summary = eventTracking.getFormatSuccessRatesSummary ? eventTracking.getFormatSuccessRatesSummary() : [];
    sendSuccess(res, requestId, { formats: summary }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Event History ──────────────────────────────────────────────────────────

async function handleEventHistory(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const limit = clampInt(query.limit, 1, 1000, 50);

  try {
    const { getTaskEvents } = require('../hooks/event-dispatch');
    const events = getTaskEvents({
      task_id: query.task_id || undefined,
      event_type: query.event_type || undefined,
      limit,
    });

    const parsed = (Array.isArray(events) ? events : []).map(e => ({
      ...e,
      event_data: parseEventDataOrNull(e.event_data),
    }));

    sendSuccess(res, requestId, { events: parsed, count: parsed.length }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Webhook Stats ──────────────────────────────────────────────────────────

async function handleWebhookStats(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const stats = webhooksStreaming.getWebhookStats ? webhooksStreaming.getWebhookStats() : {
      webhooks: { total: 0, active: 0 },
      deliveries_24h: { total: 0, successful: 0, failed: 0 },
    };
    const webhooks = webhooksStreaming.listWebhooks ? webhooksStreaming.listWebhooks() : [];

    sendSuccess(res, requestId, { stats, webhooks }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Notification Stats ─────────────────────────────────────────────────────

async function handleNotificationStats(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const { sessions, getActiveSessionCount, notificationMetrics } = require('../mcp-sse');
    const sessionCount = getActiveSessionCount();
    const sessionDetails = [];
    let totalPending = 0;

    for (const [id, session] of sessions) {
      const pending = session.pendingEvents ? session.pendingEvents.length : 0;
      totalPending += pending;
      sessionDetails.push({
        id: id.substring(0, 8),
        pending,
        event_filter: session.eventFilter ? [...session.eventFilter] : [],
        task_filter_count: session.taskFilter ? session.taskFilter.size : 0,
        connected: !session.res.writableEnded,
      });
    }

    sendSuccess(res, requestId, {
      active_sessions: sessionCount,
      total_pending_events: totalPending,
      sessions: sessionDetails,
      metrics: notificationMetrics || {},
    }, 200, req);
  } catch (_err) {
    sendSuccess(res, requestId, {
      active_sessions: 0, total_pending_events: 0, sessions: [], metrics: {},
    }, 200, req);
  }
}

async function handleThroughputMetrics(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const metrics = require('../db/throughput-metrics');
    const windowHours = parseInt(req.query?.window_hours || '24', 10);
    const summary = metrics.getThroughputSummary(windowHours);
    sendSuccess(res, requestId, summary, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Budget ─────────────────────────────────────────────────────────────────

async function handleBudgetSummary(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const days = clampInt(query.days, 1, 365, 30);

  try {
    const providerRows = costTracking.getCostSummary ? costTracking.getCostSummary(null, days) : [];
    let totalCost = 0;
    let taskCount = 0;
    const byProvider = {};
    for (const row of providerRows || []) {
      totalCost += row.total_cost ?? 0;
      taskCount += row.task_count ?? 0;
      byProvider[row.provider] = row.total_cost ?? 0;
    }

    let daily = [];
    const dailyRows = costTracking.getCostByPeriod ? costTracking.getCostByPeriod('day', days) : [];
    if (dailyRows && dailyRows.length > 0) {
      daily = dailyRows.map(r => ({ date: r.period, cost: r.cost || 0 })).reverse();
    }

    sendSuccess(res, requestId, {
      total_cost: totalCost,
      task_count: taskCount,
      by_provider: byProvider,
      daily,
      days,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleBudgetStatus(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const budgets = costTracking.getBudgetStatus ? costTracking.getBudgetStatus() : [];
    const arr = Array.isArray(budgets) ? budgets : budgets ? [budgets] : [];
    const primary = arr[0];

    sendSuccess(res, requestId, {
      limit: primary?.budget_usd || 0,
      used: primary?.current_spend || 0,
      budgets: arr,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleSetBudget(req, res) {
  const requestId = resolveRequestId(req);
  const { parseBody: parseBodyFn } = require('./middleware');
  const body = req.body || await parseBodyFn(req);

  const budgetUsd = parseFloat(body.budget_usd);
  if (isNaN(budgetUsd) || budgetUsd < 0) {
    return sendError(res, requestId, 'validation_error', 'budget_usd must be a non-negative number', 400, undefined, req);
  }

  try {
    if (budgetUsd === 0) {
      // Clear all budgets
      const budgets = costTracking.getBudgetStatus ? costTracking.getBudgetStatus() : [];
      const arr = Array.isArray(budgets) ? budgets : budgets ? [budgets] : [];
      let deleted = 0;
      for (const b of arr) {
        if (b.id && typeof costTracking.deleteBudget === 'function') {
          costTracking.deleteBudget(b.id);
          deleted++;
        }
      }
      sendSuccess(res, requestId, { cleared: true, deleted }, 200, req);
      return;
    }
    const result = costTracking.setBudget(
      body.name || 'Monthly Budget',
      budgetUsd,
      body.provider || null,
      body.period || 'monthly',
      parseInt(body.alert_threshold, 10) || 80
    );
    sendSuccess(res, requestId, result, 201, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Strategic Brain ────────────────────────────────────────────────────────

async function handleStrategicStatus(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const { getStrategicStatus } = require('../handlers/orchestrator-handlers');
    const status = getStrategicStatus();
    sendSuccess(res, requestId, status, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

async function handleRoutingDecisions(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const limit = clampInt(query.limit, 1, 200, 50);

  const rawTasks = taskCore.listTasks ? taskCore.listTasks({ limit: limit * 3, order: 'desc' }) : [];
  const taskList = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks || []);

  const decisions = [];
  for (const task of taskList) {
    if (decisions.length >= limit) break;

    let metadata = {};
    if (task.metadata) {
      try { metadata = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata; }
      catch { /* skip */ }
    }
    if (!metadata.smart_routing && !metadata.auto_routed) continue;

    decisions.push({
      task_id: task.id,
      created_at: task.created_at,
      complexity: task.complexity || metadata.complexity || 'unknown',
      provider: task.provider || 'unknown',
      model: task.model || null,
      status: task.status,
      fallback_used: !!metadata.user_provider_override || !!metadata.fallback_provider,
      needs_review: !!metadata.needs_review,
      description: (task.task_description || '').slice(0, 120),
    });
  }

  sendSuccess(res, requestId, { decisions }, 200, req);
}

async function handleProviderHealth(req, res) {
  const requestId = resolveRequestId(req);

  const providers = providerRoutingCore.listProviders ? providerRoutingCore.listProviders() : [];
  const healthCards = [];

  for (const p of providers) {
    const dayStats = fileTracking.getProviderStats ? fileTracking.getProviderStats(p.provider, 1) : {};
    const health = providerRoutingCore.getProviderHealth ? providerRoutingCore.getProviderHealth(p.provider) : { successes: 0, failures: 0, failureRate: 0 };
    const isHealthy = providerRoutingCore.isProviderHealthy ? providerRoutingCore.isProviderHealthy(p.provider) : true;

    let healthStatus = 'healthy';
    if (!p.enabled) healthStatus = 'disabled';
    else if (!isHealthy) healthStatus = 'degraded';
    else if (health.failureRate > 0.1 && (health.successes + health.failures) >= 3) healthStatus = 'warning';

    healthCards.push({
      provider: p.provider,
      enabled: !!p.enabled,
      health_status: healthStatus,
      success_rate_1h: health.successes + health.failures > 0
        ? Math.round((health.successes / (health.successes + health.failures)) * 100) : null,
      successes_1h: health.successes,
      failures_1h: health.failures,
      tasks_today: dayStats.total_tasks ?? 0,
      completed_today: dayStats.successful_tasks || 0,
      failed_today: dayStats.failed_tasks || 0,
      avg_duration_seconds: dayStats.avg_duration_seconds || 0,
    });
  }

  sendSuccess(res, requestId, { providers: healthCards }, 200, req);
}

// ─── Free-Tier Status ──────────────────────────────────────────────────────

async function handleQuotaStatus(req, res) {
  const requestId = resolveRequestId(req);
  try {
    // Free-tier tracker may not be initialized
    const providers = {};
    sendSuccess(res, requestId, { providers, message: 'Free-tier status' }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Free-Tier History ─────────────────────────────────────────────────────

async function handleQuotaHistory(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const days = Math.max(1, Math.min(90, parseInt(query.days, 10) || 7));
  try {
    const history = typeof costTracking.getUsageHistory === 'function' ? costTracking.getUsageHistory(days) : [];
    sendSuccess(res, requestId, { history, days }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Free-Tier Auto-Scale ──────────────────────────────────────────────────

async function handleQuotaAutoScale(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const enabled = serverConfig.isOptIn('quota_auto_scale_enabled');
    const queueDepthThreshold = serverConfig.getInt('quota_queue_depth_threshold', 3);
    const cooldownSeconds = serverConfig.getInt('quota_cooldown_seconds', 60);

    let codexQueueDepth = 0;
    try {
      const queued = taskCore.listTasks({ status: 'queued', limit: 1000 });
      const queuedArr = Array.isArray(queued) ? queued : (queued.tasks || []);
      codexQueueDepth = queuedArr.filter(t => {
        if (t.provider === 'codex') return true;
        if (!t.provider) {
          try { const m = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : t.metadata; return m?.intended_provider === 'codex'; } catch { return false; }
        }
        return false;
      }).length;
    } catch { /* non-critical */ }

    sendSuccess(res, requestId, {
      enabled,
      queue_depth_threshold: queueDepthThreshold,
      cooldown_seconds: cooldownSeconds,
      codex_queue_depth: codexQueueDepth,
    }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Prometheus Metrics ────────────────────────────────────────────────────

async function handlePrometheusMetrics(req, res) {
  const requestId = resolveRequestId(req);
  try {
    const toolsModule = require('../tools');
    const result = toolsModule.callTool('export_metrics_prometheus', {});
    const text = result?.content?.[0]?.text || '';
    sendSuccess(res, requestId, { format: 'prometheus', metrics: text }, 200, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

// ─── Strategic Operations ──────────────────────────────────────────────────

async function handleStrategicOperations(req, res) {
  const requestId = resolveRequestId(req);
  const query = req.query || {};
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  try {
    const operations = getRecentStrategicOperations(limit);
    sendList(res, requestId, operations, operations.length, req);
  } catch (err) {
    sendError(res, requestId, 'operation_failed', err.message, 500, {}, req);
  }
}

function createV2AnalyticsHandlers(_deps) {
  return {
    handleStatsOverview,
    handleTimeSeries,
    handleQualityStats,
    handleStuckTasks,
    handleModelStats,
    handleFormatSuccess,
    handleEventHistory,
    handleWebhookStats,
    handleNotificationStats,
    handleThroughputMetrics,
    handleBudgetSummary,
    handleBudgetStatus,
    handleSetBudget,
    handleStrategicStatus,
    handleRoutingDecisions,
    handleProviderHealth,
    handleQuotaStatus,
    handleQuotaHistory,
    handleQuotaAutoScale,
    handlePrometheusMetrics,
    handleStrategicOperations,
  };
}

module.exports = {
  // Stats
  handleStatsOverview,
  handleTimeSeries,
  handleQualityStats,
  handleStuckTasks,
  handleModelStats,
  handleFormatSuccess,
  handleEventHistory,
  handleWebhookStats,
  handleNotificationStats,
  handleThroughputMetrics,
  // Budget
  handleBudgetSummary,
  handleBudgetStatus,
  handleSetBudget,
  // Strategic
  handleStrategicStatus,
  handleRoutingDecisions,
  handleProviderHealth,
  // Free-Tier
  handleQuotaStatus,
  handleQuotaHistory,
  handleQuotaAutoScale,
  // Metrics
  handlePrometheusMetrics,
  // Strategic Operations
  handleStrategicOperations,
  createV2AnalyticsHandlers,
};
