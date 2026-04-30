'use strict';

function defaultEscapePrometheusLabel(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
}

function appendTaskStatusMetrics(metrics, db, escapeLabel) {
  const taskCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM tasks
    GROUP BY status
  `).all();

  for (const { status, count } of taskCounts) {
    metrics.push(`torque_tasks_total{status="${escapeLabel(status)}"} ${count}`);
  }
}

function appendActiveAgentMetrics(metrics, db) {
  const agentCount = db.prepare(`
    SELECT COUNT(*) as count FROM agents WHERE status = 'online'
  `).get();
  metrics.push(`torque_active_agents ${agentCount.count}`);
}

function appendTaskDurationBucketMetrics(metrics, db) {
  const durations = db.prepare(`
    SELECT
      CASE
        WHEN julianday(completed_at) - julianday(started_at) <= 1.0/24/60 THEN '60'
        WHEN julianday(completed_at) - julianday(started_at) <= 5.0/24/60 THEN '300'
        WHEN julianday(completed_at) - julianday(started_at) <= 30.0/24/60 THEN '1800'
        ELSE '3600'
      END as bucket,
      COUNT(*) as count
    FROM tasks
    WHERE completed_at IS NOT NULL AND started_at IS NOT NULL
    GROUP BY bucket
  `).all();

  for (const { bucket, count } of durations) {
    metrics.push(`torque_task_duration_seconds_bucket{le="${bucket}"} ${count}`);
  }
}

function appendWorkflowStatusMetrics(metrics, db, escapeLabel) {
  const workflowCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM workflows
    GROUP BY status
  `).all();

  for (const { status, count } of workflowCounts) {
    metrics.push(`torque_workflows_total{status="${escapeLabel(status)}"} ${count}`);
  }
}

function appendDailyTokenCostMetrics(metrics, db) {
  const tokenUsage = db.prepare(`
    SELECT SUM(total_tokens) as total, SUM(estimated_cost_usd) as cost
    FROM token_usage
    WHERE recorded_at >= date('now', '-1 day')
  `).get();

  metrics.push(`torque_tokens_daily_total ${tokenUsage.total || 0}`);
  metrics.push(`torque_cost_daily_usd ${tokenUsage.cost || 0}`);
}

function appendQueueWaitBucketMetrics(metrics, db) {
  const queueWaits = db.prepare(`
    SELECT
      CASE
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 10 THEN '10'
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 30 THEN '30'
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 60 THEN '60'
        WHEN (julianday(started_at) - julianday(created_at)) * 86400 <= 300 THEN '300'
        ELSE '600'
      END as bucket,
      COUNT(*) as count
    FROM tasks
    WHERE created_at IS NOT NULL AND started_at IS NOT NULL
    GROUP BY bucket
  `).all();

  for (const { bucket, count } of queueWaits) {
    metrics.push(`torque_queue_wait_seconds_bucket{le="${bucket}"} ${count}`);
  }
}

function appendProviderTaskCountMetrics(metrics, db, escapeLabel) {
  const providerTasks = db.prepare(`
    SELECT provider, COUNT(*) as count
    FROM tasks
    WHERE provider IS NOT NULL
    GROUP BY provider
  `).all();

  for (const { provider, count } of providerTasks) {
    metrics.push(`torque_provider_tasks_total{provider="${escapeLabel(provider)}"} ${count}`);
  }
}

function appendProviderDurationMetrics(metrics, db, escapeLabel) {
  const providerDurations = db.prepare(`
    SELECT provider,
      AVG((julianday(completed_at) - julianday(started_at)) * 86400) as avg_duration
    FROM tasks
    WHERE provider IS NOT NULL AND completed_at IS NOT NULL AND started_at IS NOT NULL
    GROUP BY provider
  `).all();

  for (const { provider, avg_duration } of providerDurations) {
    metrics.push(`torque_provider_duration_seconds{provider="${escapeLabel(provider)}"} ${(avg_duration || 0).toFixed(2)}`);
  }
}

function appendHostSlotMetrics(metrics, db, escapeLabel) {
  try {
    const hostSlots = db.prepare(`
      SELECT name, running_tasks, max_concurrent
      FROM ollama_hosts
      WHERE enabled = 1
    `).all();

    for (const { name, running_tasks, max_concurrent } of hostSlots) {
      metrics.push(`torque_host_slots_used{host="${escapeLabel(name)}"} ${running_tasks || 0}`);
      metrics.push(`torque_host_slots_total{host="${escapeLabel(name)}"} ${max_concurrent || 1}`);
    }
  } catch {
    // ollama_hosts table may not exist in test environments.
  }
}

function appendStallRetryTotals(metrics, db) {
  const stallCount = db.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE status = 'failed' AND exit_code = -2
  `).get();
  metrics.push(`torque_stall_total ${stallCount.count}`);

  const retryCount = db.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE retry_count > 0
  `).get();
  metrics.push(`torque_retry_total ${retryCount.count}`);
}

function appendProviderTransportTelemetry(metrics, db, escapeLabel) {
  try {
    const transportCallCounts = db.prepare(`
      SELECT
        provider,
        transport,
        CASE
          WHEN success = 1 THEN 'success'
          WHEN success = 0 THEN 'failure'
          ELSE 'unknown'
        END as outcome,
        COUNT(*) as count
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
      GROUP BY provider, transport, outcome
    `).all();

    for (const { provider, transport, outcome, count } of transportCallCounts) {
      metrics.push(`torque_provider_transport_calls_total{provider="${escapeLabel(provider)}",transport="${escapeLabel(transport)}",outcome="${escapeLabel(outcome)}"} ${count}`);
    }

    const transportDuration = db.prepare(`
      SELECT
        provider,
        transport,
        SUM(elapsed_ms) as elapsed_sum_ms,
        AVG(elapsed_ms) as elapsed_avg_ms
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
        AND elapsed_ms IS NOT NULL
      GROUP BY provider, transport
    `).all();
    for (const {
      provider,
      transport,
      elapsed_sum_ms,
      elapsed_avg_ms,
    } of transportDuration) {
      const avgMs = Number(elapsed_avg_ms);
      metrics.push(`torque_provider_transport_elapsed_ms_sum{provider="${escapeLabel(provider)}",transport="${escapeLabel(transport)}"} ${(elapsed_sum_ms || 0)}`);
      metrics.push(`torque_provider_transport_elapsed_ms_avg{provider="${escapeLabel(provider)}",transport="${escapeLabel(transport)}"} ${Number.isFinite(avgMs) ? avgMs.toFixed(2) : 0}`);
    }

    const transportRetries = db.prepare(`
      SELECT
        provider,
        transport,
        SUM(retry_count) as retry_count_sum,
        AVG(retry_count) as retry_count_avg
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
        AND retry_count IS NOT NULL
      GROUP BY provider, transport
    `).all();
    for (const { provider, transport, retry_count_sum, retry_count_avg } of transportRetries) {
      const avgRetries = Number(retry_count_avg);
      metrics.push(`torque_provider_transport_retry_count_sum{provider="${escapeLabel(provider)}",transport="${escapeLabel(transport)}"} ${retry_count_sum || 0}`);
      metrics.push(`torque_provider_transport_retry_count_avg{provider="${escapeLabel(provider)}",transport="${escapeLabel(transport)}"} ${Number.isFinite(avgRetries) ? avgRetries.toFixed(2) : 0}`);
    }

    const failureReasons = db.prepare(`
      SELECT
        provider,
        transport,
        failure_reason,
        COUNT(*) as count
      FROM provider_usage
      WHERE provider IS NOT NULL
        AND transport IS NOT NULL
        AND failure_reason IS NOT NULL
        AND TRIM(failure_reason) != ''
      GROUP BY provider, transport, failure_reason
    `).all();
    for (const { provider, transport, failure_reason, count } of failureReasons) {
      metrics.push(`torque_provider_transport_failure_reason_total{provider="${escapeLabel(provider)}",transport="${escapeLabel(transport)}",failure_reason="${escapeLabel(failure_reason)}"} ${count}`);
    }
  } catch {
    metrics.push('torque_provider_transport_metrics_unavailable 1');
  }
}

function appendValidationFailureMetrics(metrics, db) {
  try {
    const validationFails = db.prepare(`
      SELECT COUNT(*) as count FROM task_validations WHERE passed = 0
    `).get();
    metrics.push(`torque_validation_failures_total ${validationFails.count}`);
  } catch {
    metrics.push('torque_validation_failures_total 0');
  }
}

function appendCostByProviderMetrics(metrics, db, escapeLabel) {
  try {
    const costByProvider = db.prepare(`
      SELECT provider, SUM(estimated_cost_usd) as cost
      FROM token_usage
      WHERE provider IS NOT NULL
      GROUP BY provider
    `).all();

    for (const { provider, cost } of costByProvider) {
      metrics.push(`torque_cost_by_provider{provider="${escapeLabel(provider)}"} ${(cost || 0).toFixed(6)}`);
    }
  } catch {
    // token_usage may not have provider column.
  }
}

function buildPrometheusMetrics({ db, escapePrometheusLabel } = {}) {
  const escapeLabel = typeof escapePrometheusLabel === 'function'
    ? escapePrometheusLabel
    : defaultEscapePrometheusLabel;
  const metrics = [];

  appendTaskStatusMetrics(metrics, db, escapeLabel);
  appendActiveAgentMetrics(metrics, db);
  appendTaskDurationBucketMetrics(metrics, db);
  appendWorkflowStatusMetrics(metrics, db, escapeLabel);
  appendDailyTokenCostMetrics(metrics, db);
  appendQueueWaitBucketMetrics(metrics, db);
  appendProviderTaskCountMetrics(metrics, db, escapeLabel);
  appendProviderDurationMetrics(metrics, db, escapeLabel);
  appendHostSlotMetrics(metrics, db, escapeLabel);
  appendStallRetryTotals(metrics, db);
  appendProviderTransportTelemetry(metrics, db, escapeLabel);
  appendValidationFailureMetrics(metrics, db);
  appendCostByProviderMetrics(metrics, db, escapeLabel);

  return metrics.join('\n');
}

module.exports = {
  buildPrometheusMetrics,
};
