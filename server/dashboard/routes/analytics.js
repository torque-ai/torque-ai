/**
 * Analytics route handlers — stats, strategic, finance, workflows.
 *
 * Merged from: stats.js, strategic.js, finance.js, workflows.js
 */
const taskCore = require('../../db/task-core');
const costTracking = require('../../db/cost-tracking');
const eventTracking = require('../../db/event-tracking');
const fileTracking = require('../../db/file-tracking');
const providerRoutingCore = require('../../db/provider-routing-core');
const webhooksStreaming = require('../../db/webhooks-streaming');
const workflowEngine = require('../../db/workflow-engine');
const serverConfig = require('../../config');
const { getProviderHealthStatus } = require('../../utils/provider-health-status');
const { sendJson, sendError, parseBody, enrichTaskWithHostName } = require('../utils');
const { getStrategicStatus } = require('../../handlers/orchestrator-handlers');
const { evaluateWorkflowVisibility, getWorkflowTaskCounts } = require('../../handlers/shared');

// ── Stats ────────────────────────────────────────────────────────────────

function parseEventDataOrNull(raw) {
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clampQueryInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseDays(days, fallback = 7) {
  return clampQueryInt(days, 1, 365, fallback);
}

function parseLimit(limit, fallback = 50) {
  return clampQueryInt(limit, 1, 1000, fallback);
}

/**
 * GET /api/stats/overview - Dashboard overview stats.
 * Uses efficient COUNT queries instead of fetching all records.
 */
function handleStatsOverview(req, res) {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  // Use calendar-day boundaries (midnight to midnight UTC) for "today" counts
  // Count only completed + failed + running — not cancelled/pending/blocked
  const todayCompleted = taskCore.countTasks({ completed_from: today, completed_to: tomorrow, status: 'completed' });
  const todayFailed = taskCore.countTasks({ completed_from: today, completed_to: tomorrow, status: 'failed' });
  const todayRunning = taskCore.countTasks({ from_date: today, to_date: tomorrow, status: 'running' });
  const todayTotal = todayCompleted + todayFailed + todayRunning;
  const todaySuccessRate = (todayCompleted + todayFailed) > 0
    ? Math.round((todayCompleted / ((todayCompleted + todayFailed) || 1)) * 100)
    : 0;

  // Yesterday's stats — same methodology: completed + failed only
  const yesterdayCompleted = taskCore.countTasks({ completed_from: yesterday, completed_to: today, status: 'completed' });
  const yesterdayFailed = taskCore.countTasks({ completed_from: yesterday, completed_to: today, status: 'failed' });
  const yesterdayTotal = yesterdayCompleted + yesterdayFailed;

  // Current active tasks using COUNT queries
  const runningCount = taskCore.countTasks({ status: 'running' });
  const queuedCount = taskCore.countTasks({ status: 'queued' });
  const pendingSwitchCount = taskCore.countTasks({ status: 'pending_provider_switch' });

  // Provider breakdown
  const codexStats = fileTracking.getProviderStats('codex', 1);
  const claudeStats = fileTracking.getProviderStats('claude-cli', 1);

  // MCP SSE notification stats
  let sseSubscribers = 0;
  let ssePendingEvents = 0;
  try {
    const mcpSse = require('../../mcp/sse');
    sseSubscribers = mcpSse.getActiveSessionCount();
    for (const [, session] of mcpSse.sessions) {
      ssePendingEvents += session.pendingEvents ? session.pendingEvents.length : 0;
    }
  } catch (e) { /* mcp-sse not loaded */ }

  // Total counts by status (for kanban column badges)
  const completedCount = taskCore.countTasks({ status: 'completed' });
  const failedCount = taskCore.countTasks({ status: 'failed' });
  const cancelledCount = taskCore.countTasks({ status: 'cancelled' });

  sendJson(res, {
    today: {
      total: todayTotal,
      completed: todayCompleted,
      failed: todayFailed,
      successRate: todaySuccessRate,
    },
    yesterday: {
      total: yesterdayTotal,
    },
    active: {
      running: runningCount,
      queued: queuedCount,
      pendingSwitch: pendingSwitchCount,
    },
    totals: {
      running: runningCount,
      queued: queuedCount,
      completed: completedCount,
      failed: failedCount,
      cancelled: cancelledCount,
      pending_provider_switch: pendingSwitchCount,
    },
    notifications: {
      sseSubscribers,
      pendingEvents: ssePendingEvents,
    },
    providers: {
      codex: codexStats,
      'claude-cli': claudeStats,
    },
  });
}

/**
 * GET /api/stats/timeseries - Time series data for charts.
 * Uses efficient COUNT queries instead of fetching all records.
 */
function handleTimeSeries(req, res, query) {
  const days = parseDays(query?.days, 7);
  const provider = query?.provider; // optional filter
  const interval = query?.interval === 'hour' ? 'hour' : 'day';

  const series = [];
  const now = new Date();

  if (interval === 'hour') {
    // Hourly buckets — uses setHours() to avoid DST drift
    const totalHours = days * 24;
    for (let i = totalHours - 1; i >= 0; i--) {
      const hour = new Date(now);
      hour.setMinutes(0, 0, 0);
      hour.setHours(hour.getHours() - i);
      const nextHour = new Date(hour);
      nextHour.setHours(nextHour.getHours() + 1);

      const baseFilters = {
        completed_from: hour.toISOString(),
        completed_to: nextHour.toISOString(),
        includeArchived: true,
      };
      if (provider) baseFilters.provider = provider;

      const completed = taskCore.countTasks({ ...baseFilters, status: 'completed' });
      const failed = taskCore.countTasks({ ...baseFilters, status: 'failed' });
      const total = completed + failed;

      series.push({
        date: hour.toISOString(),
        hour: hour.getHours(),
        total,
        completed,
        failed,
        successRate: total > 0
          ? Math.round((completed / (completed + failed || 1)) * 100)
          : 0,
      });
    }
  } else {
    // Daily buckets (default)
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);
      const nextDateStr = nextDate.toISOString().split('T')[0];

      const baseFilters = {
        completed_from: dateStr,
        completed_to: nextDateStr,
        includeArchived: true,
      };
      if (provider) baseFilters.provider = provider;

      const completed = taskCore.countTasks({ ...baseFilters, status: 'completed' });
      const failed = taskCore.countTasks({ ...baseFilters, status: 'failed' });
      const total = completed + failed;

      series.push({
        date: dateStr,
        total,
        completed,
        failed,
        successRate: total > 0
          ? Math.round((completed / (completed + failed || 1)) * 100)
          : 0,
      });
    }
  }

  sendJson(res, series);
}

/**
 * GET /api/stats/quality - Quality score statistics.
 * Returns average quality, provider breakdown, and validation failure rate.
 */
function handleQualityStats(req, res, query) {
  const hours = parseInt(query.hours, 10) || 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  // Get overall quality stats
  const overallStats = fileTracking.getOverallQualityStats(since);

  // Get quality by provider
  const providerStats = fileTracking.getQualityStatsByProvider(since);

  // Get validation failure rate
  const validationStats = fileTracking.getValidationFailureRate(since);

  sendJson(res, {
    period: { hours, since },
    overall: overallStats,
    byProvider: providerStats,
    validation: validationStats,
  });
}

/**
 * GET /api/stats/stuck - Tasks needing attention.
 * Returns tasks stuck in various states that need user action.
 */
function handleStuckTasks(req, res, query) {
  const now = Date.now();

  // Rows are serialized to the client (.slice(0,10) below) — use the standard
  // list projection so we skip the heavy output/error_output/context blobs.
  const listOpts = (status) => ({ status, limit: 50, columns: taskCore.TASK_LIST_COLUMNS });

  // Tasks pending approval for >15 minutes
  const pendingApprovalThreshold = 15 * 60 * 1000;
  const pendingApproval = taskCore.listTasks(listOpts('pending_approval'))
    .filter(t => {
      const createdAt = new Date(t.created_at).getTime();
      return (now - createdAt) > pendingApprovalThreshold;
    }).map(enrichTaskWithHostName);

  // Tasks pending provider switch for >15 minutes
  const pendingSwitch = taskCore.listTasks(listOpts('pending_provider_switch'))
    .filter(t => {
      const createdAt = new Date(t.provider_switched_at || t.created_at).getTime();
      return (now - createdAt) > pendingApprovalThreshold;
    }).map(enrichTaskWithHostName);

  // Tasks running for >30 minutes (potential stalls)
  const longRunningThreshold = 30 * 60 * 1000;
  const longRunning = taskCore.listTasks(listOpts('running'))
    .filter(t => {
      const startedAt = new Date(t.started_at).getTime();
      return (now - startedAt) > longRunningThreshold;
    }).map(enrichTaskWithHostName);

  // Tasks in waiting status with failed dependencies
  const waitingTasks = taskCore.listTasks(listOpts('waiting')).map(enrichTaskWithHostName);

  sendJson(res, {
    pendingApproval: {
      count: pendingApproval.length,
      threshold: '15 minutes',
      tasks: pendingApproval.slice(0, 10),
    },
    pendingSwitch: {
      count: pendingSwitch.length,
      threshold: '15 minutes',
      tasks: pendingSwitch.slice(0, 10),
    },
    longRunning: {
      count: longRunning.length,
      threshold: '30 minutes',
      tasks: longRunning.slice(0, 10),
    },
    waiting: {
      count: waitingTasks.length,
      tasks: waitingTasks.slice(0, 10),
    },
    totalNeedsAttention: pendingApproval.length + pendingSwitch.length + longRunning.length + waitingTasks.length,
  });
}

/**
 * GET /api/stats/models?days=7 - Per-model performance breakdown.
 * Returns model-level aggregations: task count, success rate, avg duration, cost.
 */
function handleModelStats(req, res, query) {
  const days = parseDays(query?.days, 7);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const rows = typeof taskCore.getModelUsageStats === 'function'
      ? taskCore.getModelUsageStats(since)
      : [];

    const modelMap = {};
    for (const row of rows) {
      if (!modelMap[row.model]) {
        modelMap[row.model] = {
          model: row.model,
          providers: [],
          total: 0,
          completed: 0,
          failed: 0,
          avg_duration_seconds: null,
          last_used: null,
          _totalDuration: 0,
          _totalCount: 0,
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

    const dailySeries = typeof taskCore.getModelDailyUsageSeries === 'function'
      ? taskCore.getModelDailyUsageSeries(since)
      : [];

    sendJson(res, { models, dailySeries, days });
  } catch (err) {
    sendJson(res, { models: [], dailySeries: [], days, error: err.message });
  }
}

/**
 * GET /api/stats/format-success - Format success rates summary.
 */
function handleFormatSuccess(req, res) {
  try {
    const summary = eventTracking.getFormatSuccessRatesSummary();
    return sendJson(res, summary);
  } catch (err) {
    return sendJson(res, []);
  }
}

/**
 * GET /api/stats/notifications - MCP push notification stats.
 * Returns active SSE session count and per-session pending event counts.
 */
function handleNotificationStats(req, res) {
  try {
    const { sessions, getActiveSessionCount, notificationMetrics } = require('../../mcp/sse');
    const sessionCount = getActiveSessionCount();
    const sessionDetails = [];
    let totalPending = 0;

    for (const [id, session] of sessions) {
      const pending = session.pendingEvents ? session.pendingEvents.length : 0;
      totalPending += pending;
      sessionDetails.push({
        id: id.substring(0, 8),
        pending,
        eventFilter: session.eventFilter ? [...session.eventFilter] : [],
        taskFilter: session.taskFilter ? session.taskFilter.size : 0,
        connected: !session.res.writableEnded,
      });
    }

    sendJson(res, {
      activeSessions: sessionCount,
      totalPendingEvents: totalPending,
      sessions: sessionDetails,
      metrics: notificationMetrics || {},
    });
  } catch (err) {
    sendJson(res, { activeSessions: 0, totalPendingEvents: 0, sessions: [], metrics: {}, error: err.message });
  }
}

/**
 * GET /api/stats/event-history - Recent task events from DB.
 */
function handleEventHistory(req, res, query) {
  try {
    const { getTaskEvents } = require('../../hooks/event-dispatch');
    const events = getTaskEvents({
      task_id: query?.task_id || undefined,
      event_type: query?.event_type || undefined,
      limit: parseLimit(query?.limit, 50),
    });

    const parsed = events.map(e => ({
      ...e,
      event_data: parseEventDataOrNull(e.event_data),
    }));

    sendJson(res, { events: parsed, count: parsed.length });
  } catch (err) {
    sendJson(res, { events: [], count: 0, error: err.message });
  }
}

/**
 * GET /api/stats/webhooks - Webhook delivery stats.
 */
function handleWebhookStats(req, res) {
  try {
    const stats = webhooksStreaming.getWebhookStats ? webhooksStreaming.getWebhookStats() : { webhooks: { total: 0, active: 0 }, deliveries_24h: { total: 0, successful: 0, failed: 0 } };
    const webhooks = webhooksStreaming.listWebhooks ? webhooksStreaming.listWebhooks() : [];
    sendJson(res, { stats, webhooks });
  } catch (err) {
    sendJson(res, { stats: { webhooks: { total: 0, active: 0 }, deliveries_24h: { total: 0, successful: 0, failed: 0 } }, webhooks: [], error: err.message });
  }
}

/**
 * Get time series data for a specific provider.
 * Uses efficient COUNT queries instead of fetching all records.
 */
function getProviderTimeSeries(providerId, days) {
  const series = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = nextDate.toISOString().split('T')[0];

    const baseFilters = {
      provider: providerId,
      completed_from: dateStr,
      completed_to: nextDateStr,
      includeArchived: true,
    };

    const completed = taskCore.countTasks({ ...baseFilters, status: 'completed' });
    const failed = taskCore.countTasks({ ...baseFilters, status: 'failed' });
    const total = completed + failed;

    series.push({
      date: dateStr,
      total,
      completed,
      failed,
    });
  }

  return series;
}

// ── Strategic ────────────────────────────────────────────────────────────

function handleGetStrategicStatus(_req, res) {
  const status = getStrategicStatus();
  sendJson(res, status);
}

function handleGetRecentOperations(_req, res, query) {
  const limit = parseInt(query.limit, 10) || 20;
  // Strategic operations are tasks that used strategic_decompose, strategic_diagnose, or strategic_review
  const tasks = taskCore.listTasks ? taskCore.listTasks({
    limit,
    order: 'desc',
    columns: taskCore.TASK_LIST_COLUMNS,
  }) : [];

  // Filter to strategic-related tasks (those submitted via strategic tools)
  const strategicTasks = tasks.filter((t) => {
    const desc = (t.description || '').toLowerCase();
    return desc.includes('strategic') || desc.includes('decompos') || desc.includes('diagnos') || desc.includes('review');
  }).slice(0, limit);

  sendJson(res, { operations: strategicTasks });
}

/**
 * GET /api/strategic/decisions - Recent routing decisions extracted from task metadata
 *
 * Returns tasks that were routed via smart_routing, with metadata like
 * complexity, provider, model, and whether fallback was used.
 */
function handleGetRoutingDecisions(_req, res, query) {
  const limit = parseInt(query.limit, 10) || 50;

  // Fetch recent tasks — smart-routed tasks have metadata.smart_routing=true or metadata.auto_routed=true.
  // Narrow projection — we only read routing metadata + a short description slice.
  const rawTasks = taskCore.listTasks ? taskCore.listTasks({
    limit: limit * 3, // Over-fetch since we filter client-side
    order: 'desc',
    columns: taskCore.TASK_ROUTING_DECISION_COLUMNS,
  }) : [];

  const taskList = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks || []);

  const decisions = [];
  for (const task of taskList) {
    if (decisions.length >= limit) break;

    let metadata = {};
    if (task.metadata) {
      try {
        metadata = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
      } catch { /* skip unparseable */ }
    }

    // Include tasks that went through smart routing or auto routing
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
      split_advisory: !!metadata.split_advisory,
      description: (task.description || '').slice(0, 120),
    });
  }

  sendJson(res, { decisions });
}

/**
 * GET /api/strategic/provider-health - Provider health summary
 *
 * Returns health status for each provider: success rate, task counts, latency, and enabled status.
 */
function handleGetProviderHealth(_req, res) {
  const providers = (typeof providerRoutingCore.listProviders === 'function') ? providerRoutingCore.listProviders() : [];
  const healthCards = [];

  for (const p of providers) {
    // Get stats for the last 1 day (24h)
    const dayStats = (typeof fileTracking.getProviderStats === 'function')
      ? fileTracking.getProviderStats(p.provider, 1)
      : { total_tasks: 0, successful_tasks: 0, failed_tasks: 0, success_rate: 0, avg_duration_seconds: 0 };

    // Get in-memory health scoring
    const health = (typeof providerRoutingCore.getProviderHealth === 'function')
      ? providerRoutingCore.getProviderHealth(p.provider)
      : { successes: 0, failures: 0, failureRate: 0 };

    const { status: healthStatus } = getProviderHealthStatus(p, health);

    healthCards.push({
      provider: p.provider,
      enabled: !!p.enabled,
      health_status: healthStatus,
      success_rate_1h: health.successes + health.failures > 0
        ? Math.round((health.successes / (health.successes + health.failures)) * 100)
        : null,
      successes_1h: health.successes,
      failures_1h: health.failures,
      tasks_today: dayStats.total_tasks || 0,
      completed_today: dayStats.successful_tasks || 0,
      failed_today: dayStats.failed_tasks || 0,
      avg_duration_seconds: dayStats.avg_duration_seconds || 0,
    });
  }

  sendJson(res, { providers: healthCards });
}

// ── Finance ──────────────────────────────────────────────────────────────

function handleBudgetSummary(req, res, query) {
  const days = parseInt(query.days, 10) || 30;

  const providerRows = costTracking.getCostSummary(null, days);

  let totalCost = 0;
  let taskCount = 0;
  const byProvider = {};
  for (const row of providerRows || []) {
    totalCost += row.total_cost || 0;
    taskCount += row.task_count || 0;
    byProvider[row.provider] = row.total_cost || 0;
  }

  let daily = [];
  const dailyRows = costTracking.getCostByPeriod('day', days);
  if (dailyRows && dailyRows.length > 0) {
    daily = dailyRows.map(r => ({ date: r.period, cost: r.cost || 0 })).reverse();
  }

  return sendJson(res, { total_cost: totalCost, task_count: taskCount, by_provider: byProvider, daily });
}

function handleBudgetStatus(req, res) {
  const budgets = costTracking.getBudgetStatus();
  const arr = Array.isArray(budgets) ? budgets : budgets ? [budgets] : [];

  const primary = arr[0];
  const limit = primary?.budget_usd || 0;
  const used = primary?.current_spend || 0;

  return sendJson(res, { limit, used, budgets: arr });
}

async function handleSetBudget(req, res) {
  const body = await parseBody(req);
  const budgetUsd = parseFloat(body.budget_usd);
  if (!budgetUsd || budgetUsd <= 0) {
    return sendError(res, 'budget_usd must be a positive number', 400);
  }
  const name = body.name || 'Monthly Budget';
  const provider = body.provider || null;
  const period = body.period || 'monthly';
  const alertThreshold = parseInt(body.alert_threshold, 10) || 80;

  const result = costTracking.setBudget(name, budgetUsd, provider, period, alertThreshold);
  return sendJson(res, result, 201);
}

let _quotaTrackerGetter = null;

function setQuotaTrackerGetter(getter) {
  _quotaTrackerGetter = getter;
}

function handleQuotaStatus(req, res) {
  try {
    const tracker = typeof _quotaTrackerGetter === 'function' ? _quotaTrackerGetter() : null;
    if (!tracker) {
      sendJson(res, { status: 'ok', providers: {}, message: 'FreeQuotaTracker not initialized' });
      return;
    }
    sendJson(res, { status: 'ok', providers: tracker.getStatus() });
  } catch (err) {
    sendJson(res, { error: err.message }, 500);
  }
}

function handleQuotaHistory(req, res, query) {
  try {
    const days = Math.max(1, Math.min(90, parseInt(query.days, 10) || 7));
    const history = costTracking.getUsageHistory(days);
    sendJson(res, { status: 'ok', history });
  } catch (err) {
    sendJson(res, { error: err.message }, 500);
  }
}

function handleQuotaAutoScale(req, res) {
  try {
    const enabled = serverConfig.get('quota_auto_scale_enabled') === 'true';
    const queueDepthThreshold = serverConfig.getInt('quota_queue_depth_threshold', 3);
    const cooldownSeconds = serverConfig.getInt('quota_cooldown_seconds', 60);

    let codexQueueDepth = 0;
    try {
      const queued = taskCore.listTasks({
        status: 'queued',
        limit: 1000,
        columns: taskCore.TASK_PROVIDER_QUEUE_COLUMNS,
      });
      const queuedArr = Array.isArray(queued) ? queued : (queued.tasks || []);
      codexQueueDepth = queuedArr.filter(t => {
        if (t.provider === 'codex') return true;
        if (!t.provider) {
          try { const m = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : t.metadata; return m?.intended_provider === 'codex'; } catch { return false; }
        }
        return false;
      }).length;
    } catch (_e) { void _e; }

    let lastActivation = null;
    try {
      const scheduler = require('../../execution/queue-scheduler');
      const ts = scheduler._getLastAutoScaleActivation();
      if (ts > 0) lastActivation = new Date(ts).toISOString();
    } catch (_e) { void _e; }

    sendJson(res, {
      status: 'ok',
      auto_scale: {
        enabled,
        queue_depth_threshold: queueDepthThreshold,
        cooldown_seconds: cooldownSeconds,
        current_codex_queue_depth: codexQueueDepth,
        last_activation: lastActivation,
      },
    });
  } catch (err) {
    sendJson(res, { error: err.message }, 500);
  }
}

// ── Workflows ────────────────────────────────────────────────────────────

function enrichWorkflowVisibility(workflow) {
  const visibility = evaluateWorkflowVisibility(workflow);
  return {
    ...workflow,
    task_counts: getWorkflowTaskCounts(workflow),
    visibility
  };
}

/**
 * GET /api/workflows - List workflows
 */
function handleListWorkflows(req, res, query) {
  const options = {};
  if (query.status) options.status = query.status;
  if (query.limit) options.limit = parseInt(query.limit, 10);
  if (query.since) options.since = query.since;
  const workflows = workflowEngine.listWorkflows(options);
  const enriched = workflows.map((workflow) => {
    const detailed = workflowEngine.getWorkflowStatus(workflow.id) || workflow;
    return enrichWorkflowVisibility(detailed);
  });
  return sendJson(res, enriched);
}

/**
 * GET /api/workflows/:id - Get workflow details with cost
 */
function handleGetWorkflow(req, res, query, workflowId) {
  const status = workflowEngine.getWorkflowStatus(workflowId);
  if (!status) return sendError(res, 'Workflow not found', 404);
  // Merge cost summary
  const cost = costTracking.getWorkflowCostSummary(workflowId);
  return sendJson(res, { ...enrichWorkflowVisibility(status), cost });
}

/**
 * GET /api/workflows/:id/tasks - Get workflow tasks
 */
function handleGetWorkflowTasks(req, res, query, workflowId) {
  const tasks = workflowEngine.getWorkflowTasks(workflowId);
  return sendJson(res, tasks);
}

/**
 * GET /api/workflows/:id/history - Get workflow history
 */
function handleGetWorkflowHistory(req, res, query, workflowId) {
  const history = workflowEngine.getWorkflowHistory(workflowId);
  return sendJson(res, history);
}

function createDashboardAnalyticsRoutes() {
  return {
    handleStatsOverview,
    handleTimeSeries,
    handleQualityStats,
    handleStuckTasks,
    handleModelStats,
    handleFormatSuccess,
    handleNotificationStats,
    handleEventHistory,
    handleWebhookStats,
    getProviderTimeSeries,
    handleGetStrategicStatus,
    handleGetRecentOperations,
    handleGetRoutingDecisions,
    handleGetProviderHealth,
    handleBudgetSummary,
    handleBudgetStatus,
    handleSetBudget,
    handleQuotaStatus,
    handleQuotaHistory,
    handleQuotaAutoScale,
    setQuotaTrackerGetter,
    handleListWorkflows,
    handleGetWorkflow,
    handleGetWorkflowTasks,
    handleGetWorkflowHistory,
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
  handleNotificationStats,
  handleEventHistory,
  handleWebhookStats,
  getProviderTimeSeries,
  // Strategic
  handleGetStrategicStatus,
  handleGetRecentOperations,
  handleGetRoutingDecisions,
  handleGetProviderHealth,
  // Finance
  handleBudgetSummary,
  handleBudgetStatus,
  handleSetBudget,
  handleQuotaStatus,
  handleQuotaHistory,
  handleQuotaAutoScale,
  setQuotaTrackerGetter,
  // Workflows
  handleListWorkflows,
  handleGetWorkflow,
  handleGetWorkflowTasks,
  handleGetWorkflowHistory,
  createDashboardAnalyticsRoutes,
};
