'use strict';

/**
 * Cost Ceiling Enforcement
 *
 * Provider cost classification and workflow cost ceiling checks.
 * Subscription providers are charged via flat monthly subscription (not
 * per-token API pricing) — their token cost is $0 so the API-cost ceiling
 * is irrelevant, but they still count against the task-count ceiling.
 *
 * Accepts `db` as a parameter for testability — callers resolve from the
 * container via `defaultContainer.get('database')`.
 */

const { getWorkflowCostSummary } = require('../db/cost-tracking');

// Providers charged via flat monthly subscription, not per-token API pricing.
const SUBSCRIPTION_PROVIDERS = new Set([
  'codex',
  'codex-spark',
  'claude-cli',
  'claude-code-sdk',
  'claude-ollama',
]);

/**
 * Returns `true` if the provider is subscription-based (not metered per-token).
 * @param {string} provider
 * @returns {boolean}
 */
function isSubscriptionProvider(provider) {
  return SUBSCRIPTION_PROVIDERS.has(provider);
}

/**
 * Check whether a workflow has exceeded its cost or task-count ceiling.
 *
 * Ceiling values are read from the workflow row — first from direct columns
 * (`cost_ceiling_usd`, `task_count_ceiling`) if the schema migration has
 * landed, then falling back to the `context` JSON column.
 *
 * @param {object} db - better-sqlite3 database instance
 * @param {string} workflowId
 * @returns {{ exceeded: boolean, reason: string|null, api_cost_usd: number,
 *             subscription_task_count: number, cost_ceiling_usd: number|null,
 *             task_count_ceiling: number|null }}
 */
function checkWorkflowCostCeiling(db, workflowId) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
  if (!workflow) {
    return { exceeded: false, reason: null, api_cost_usd: 0, subscription_task_count: 0, cost_ceiling_usd: null, task_count_ceiling: null };
  }

  // Read ceilings — prefer direct columns, fall back to context JSON.
  let costCeilingUsd = workflow.cost_ceiling_usd ?? null;
  let taskCountCeiling = workflow.task_count_ceiling ?? null;

  if (costCeilingUsd == null || taskCountCeiling == null) {
    let ctx = null;
    if (workflow.context) {
      try {
        ctx = typeof workflow.context === 'string'
          ? JSON.parse(workflow.context)
          : workflow.context;
      } catch { /* malformed context — treat as absent */ }
    }
    if (ctx && typeof ctx === 'object') {
      if (costCeilingUsd == null && ctx.cost_ceiling_usd != null) {
        costCeilingUsd = Number(ctx.cost_ceiling_usd);
      }
      if (taskCountCeiling == null && ctx.task_count_ceiling != null) {
        taskCountCeiling = Number(ctx.task_count_ceiling);
      }
    }
  }

  // Normalize to null when missing / non-finite.
  if (!Number.isFinite(costCeilingUsd) || costCeilingUsd <= 0) costCeilingUsd = null;
  if (!Number.isFinite(taskCountCeiling) || taskCountCeiling <= 0) taskCountCeiling = null;

  if (costCeilingUsd == null && taskCountCeiling == null) {
    return { exceeded: false, reason: null, api_cost_usd: 0, subscription_task_count: 0, cost_ceiling_usd: null, task_count_ceiling: null };
  }

  // Current API cost from token_usage records.
  const costSummary = getWorkflowCostSummary(workflowId);
  const apiCostUsd = costSummary?.total_cost_usd ?? 0;

  // Count completed/failed tasks that ran on subscription providers.
  const providerPlaceholders = [...SUBSCRIPTION_PROVIDERS].map(() => '?').join(', ');
  const subscriptionRow = db.prepare(
    `SELECT COUNT(*) as count FROM tasks
     WHERE workflow_id = ?
       AND status IN ('completed', 'failed')
       AND provider IN (${providerPlaceholders})`
  ).get(workflowId, ...SUBSCRIPTION_PROVIDERS);
  const subscriptionTaskCount = subscriptionRow?.count ?? 0;

  // Evaluate ceilings.
  if (costCeilingUsd != null && apiCostUsd >= costCeilingUsd) {
    return {
      exceeded: true,
      reason: `API cost $${apiCostUsd.toFixed(4)} reached ceiling $${costCeilingUsd.toFixed(4)}`,
      api_cost_usd: apiCostUsd,
      subscription_task_count: subscriptionTaskCount,
      cost_ceiling_usd: costCeilingUsd,
      task_count_ceiling: taskCountCeiling,
    };
  }

  if (taskCountCeiling != null && subscriptionTaskCount >= taskCountCeiling) {
    return {
      exceeded: true,
      reason: `Subscription task count ${subscriptionTaskCount} reached ceiling ${taskCountCeiling}`,
      api_cost_usd: apiCostUsd,
      subscription_task_count: subscriptionTaskCount,
      cost_ceiling_usd: costCeilingUsd,
      task_count_ceiling: taskCountCeiling,
    };
  }

  return {
    exceeded: false,
    reason: null,
    api_cost_usd: apiCostUsd,
    subscription_task_count: subscriptionTaskCount,
    cost_ceiling_usd: costCeilingUsd,
    task_count_ceiling: taskCountCeiling,
  };
}

/**
 * Fail a workflow because its budget ceiling was exhausted.
 *
 * Sets the workflow status to `failed`, stores `failure_class` in the
 * context JSON, and cancels all remaining queued/pending tasks.
 *
 * @param {object} db - better-sqlite3 database instance
 * @param {string} workflowId
 * @param {string} reason - human-readable explanation
 */
function failWorkflowBudgetExhausted(db, workflowId, reason) {
  const now = new Date().toISOString();

  // Read existing context so we can merge failure_class into it.
  const workflow = db.prepare('SELECT context FROM workflows WHERE id = ?').get(workflowId);
  let ctx = {};
  if (workflow?.context) {
    try {
      ctx = typeof workflow.context === 'string'
        ? JSON.parse(workflow.context)
        : workflow.context;
      if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) ctx = {};
    } catch { ctx = {}; }
  }
  ctx.failure_class = 'budget_exhausted';
  ctx.budget_exhausted_reason = reason;
  ctx.budget_exhausted_at = now;

  db.prepare(
    `UPDATE workflows
     SET status = 'failed', context = ?, completed_at = ?
     WHERE id = ?`
  ).run(JSON.stringify(ctx), now, workflowId);

  // Cancel remaining queued/pending tasks belonging to this workflow.
  db.prepare(
    `UPDATE tasks
     SET status = 'cancelled', cancel_reason = ?, completed_at = ?
     WHERE workflow_id = ?
       AND status IN ('queued', 'pending')`
  ).run('Budget ceiling exceeded', now, workflowId);
}

module.exports = {
  SUBSCRIPTION_PROVIDERS,
  isSubscriptionProvider,
  checkWorkflowCostCeiling,
  failWorkflowBudgetExhausted,
};
