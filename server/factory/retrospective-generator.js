'use strict';

/**
 * server/factory/retrospective-generator.js — Retrospective generator service.
 *
 * Collects deterministic stats from a completed workflow's tasks and produces
 * a deterministic narrative. The result is stored
 * via the retrospectives CRUD module.
 *
 * Factory function: createRetrospectiveGenerator(deps)
 * Public API:      generateRetrospective(workflowId, projectId)
 */

const logger = require('../logger').child({ component: 'retrospective-generator' });

// ---------------------------------------------------------------------------
// Stat collection helpers
// ---------------------------------------------------------------------------

/**
 * Compute deterministic stats from an array of workflow tasks.
 *
 * @param {object[]} tasks - task rows from workflow-engine.getWorkflowTasks
 * @param {Function} getTaskTokenUsage - cost-tracking.getTaskTokenUsage
 * @returns {{ duration_seconds, total_cost, files_changed, retry_count,
 *             verify_pass_count, verify_fail_count, flaky_count }}
 */
function collectStats(tasks, getTaskTokenUsage) {
  let earliestStart = null;
  let latestEnd = null;
  let totalCost = 0;
  let filesChanged = 0;
  let retryCount = 0;
  let verifyPassCount = 0;
  let verifyFailCount = 0;
  let flakyCount = 0;

  for (const task of tasks) {
    // Duration: workflow start → end is earliest started_at → latest completed_at
    const started = task.started_at ? Date.parse(task.started_at) : NaN;
    const completed = task.completed_at ? Date.parse(task.completed_at) : NaN;
    if (Number.isFinite(started) && (earliestStart === null || started < earliestStart)) {
      earliestStart = started;
    }
    if (Number.isFinite(completed) && (latestEnd === null || completed > latestEnd)) {
      latestEnd = completed;
    }

    // Cost: sum estimated_cost_usd from token_usage rows per task
    if (typeof getTaskTokenUsage === 'function') {
      try {
        const usageRows = getTaskTokenUsage(task.id);
        if (Array.isArray(usageRows)) {
          for (const row of usageRows) {
            const cost = Number(row.estimated_cost_usd);
            if (Number.isFinite(cost)) {
              totalCost += cost;
            }
          }
        }
      } catch (err) {
        logger.debug('Failed to read token usage for task', { task_id: task.id, err: err.message });
      }
    }

    // Files changed: count from files_modified array
    const modified = task.files_modified;
    if (Array.isArray(modified)) {
      filesChanged += modified.length;
    }

    // Retry count
    const taskRetries = Number(task.retry_count);
    if (Number.isFinite(taskRetries) && taskRetries > 0) {
      retryCount += taskRetries;
    }

    // Verify / flaky counts from tags
    const tags = Array.isArray(task.tags) ? task.tags : [];
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      if (tag === 'tests:pass') verifyPassCount++;
      else if (tag === 'tests:fail') verifyFailCount++;
      else if (tag === 'tests:flaky') flakyCount++;
    }
  }

  const durationSeconds = (earliestStart !== null && latestEnd !== null)
    ? Math.max(0, Math.round((latestEnd - earliestStart) / 1000))
    : null;

  return {
    duration_seconds: durationSeconds,
    total_cost: Math.round(totalCost * 1_000_000) / 1_000_000, // 6 decimal places
    files_changed: filesChanged,
    retry_count: retryCount,
    verify_pass_count: verifyPassCount,
    verify_fail_count: verifyFailCount,
    flaky_count: flakyCount,
  };
}

// ---------------------------------------------------------------------------
// Deterministic narrative
// ---------------------------------------------------------------------------

function inferSmoothnessFromStats(stats) {
  if (stats.verify_fail_count > 1 || stats.retry_count > 3 || stats.flaky_count > 2) {
    return 'rough';
  }
  if (stats.retry_count > 0 || stats.verify_fail_count > 0 || stats.flaky_count > 0) {
    return 'bumpy';
  }
  return 'smooth';
}

function buildFallbackNarrative(stats) {
  const smoothness = inferSmoothnessFromStats(stats);
  const friction = [];
  const open = [];
  if (stats.retry_count > 0) friction.push(`${stats.retry_count} retry event(s) occurred.`);
  if (stats.verify_fail_count > 0) friction.push(`${stats.verify_fail_count} verify failure(s) occurred.`);
  if (stats.flaky_count > 0) {
    friction.push(`${stats.flaky_count} flaky test signal(s) were recorded.`);
    open.push('Review flaky test signals before reusing this workflow shape.');
  }
  if (smoothness !== 'smooth' && open.length === 0) {
    open.push('Review failed or retried tasks before repeating this workflow pattern.');
  }

  return {
    smoothness_rating: smoothness,
    narrative: `Workflow recorded ${stats.retry_count} retry event(s), ${stats.verify_fail_count} verify failure(s), ${stats.flaky_count} flaky test signal(s), and ${stats.files_changed} changed file(s).`,
    learnings: smoothness === 'smooth'
      ? ['Workflow completed without recorded retry or verify friction.']
      : ['Use retry, verify, and flaky-task counts to tighten the next workflow plan.'],
    friction_points: friction,
    open_items: open,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.db                  - raw better-sqlite3 handle (or runtime-store)
 * @param {object} deps.retrospectives      - CRUD module from server/db/retrospectives.js
 * @param {Function} deps.getWorkflowTasks  - workflow-engine.getWorkflowTasks
 * @param {Function} deps.getWorkflow       - workflow-engine.getWorkflow
 * @param {Function} deps.getTaskTokenUsage - cost-tracking.getTaskTokenUsage
 * @param {object}  [deps.log]             - optional child logger
 */
function createRetrospectiveGenerator(deps = {}) {
  const {
    retrospectives,
    getWorkflowTasks,
    getWorkflow,
    getTaskTokenUsage,
    log = logger,
  } = deps;

  if (!retrospectives || typeof retrospectives.insertRetrospective !== 'function') {
    throw new TypeError('createRetrospectiveGenerator: deps.retrospectives (with insertRetrospective) is required');
  }
  if (typeof getWorkflowTasks !== 'function') {
    throw new TypeError('createRetrospectiveGenerator: deps.getWorkflowTasks is required');
  }
  if (typeof getWorkflow !== 'function') {
    throw new TypeError('createRetrospectiveGenerator: deps.getWorkflow is required');
  }

  /**
   * Generate and store a retrospective for a completed workflow.
   *
   * @param {string} workflowId
   * @param {string} projectId
   * @returns {Promise<object>} The stored retrospective row.
   */
  async function generateRetrospective(workflowId, projectId) {
    if (!workflowId) {
      throw new Error('generateRetrospective: workflowId is required');
    }

    // 1. Get workflow metadata. Kept for future project attribution.
    getWorkflow(workflowId);

    // 2. Fetch all tasks for this workflow
    const tasks = getWorkflowTasks(workflowId);
    if (!Array.isArray(tasks) || tasks.length === 0) {
      log.warn('[retrospective-gen] no tasks found for workflow', { workflow_id: workflowId });
    }

    const safeTasks = Array.isArray(tasks) ? tasks : [];

    // 3. Collect deterministic stats
    const stats = collectStats(safeTasks, getTaskTokenUsage);
    log.info('[retrospective-gen] stats collected', {
      workflow_id: workflowId,
      project_id: projectId,
      task_count: safeTasks.length,
      ...stats,
    });

    // 4. Build deterministic narrative. This path deliberately does not
    // submit internal LLM work, so LEARN does not consume provider quota or
    // fall back to unavailable local models.
    const narrative = buildFallbackNarrative(stats);

    // 5. Store via CRUD module
    const retroData = {
      workflow_id: workflowId,
      project_id: projectId || null,
      duration_seconds: stats.duration_seconds,
      total_cost: stats.total_cost,
      files_changed: stats.files_changed,
      retry_count: stats.retry_count,
      verify_pass_count: stats.verify_pass_count,
      verify_fail_count: stats.verify_fail_count,
      flaky_count: stats.flaky_count,
      smoothness_rating: narrative.smoothness_rating,
      narrative: narrative.narrative,
      learnings: narrative.learnings,
      friction_points: narrative.friction_points,
      open_items: narrative.open_items,
      raw_stats: {
        task_count: safeTasks.length,
        task_statuses: safeTasks.reduce((acc, t) => {
          const s = t.status || 'unknown';
          acc[s] = (acc[s] || 0) + 1;
          return acc;
        }, {}),
      },
    };

    let rowId;
    try {
      rowId = retrospectives.insertRetrospective(retroData);
    } catch (err) {
      // Duplicate workflow_id — return existing row
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        log.info('[retrospective-gen] retrospective already exists', { workflow_id: workflowId });
        return retrospectives.getByWorkflowId(workflowId);
      }
      throw err;
    }

    log.info('[retrospective-gen] retrospective stored', {
      workflow_id: workflowId,
      project_id: projectId,
      row_id: rowId,
      smoothness_rating: narrative.smoothness_rating,
    });

    return retrospectives.getByWorkflowId(workflowId) || { ...retroData, id: rowId };
  }

  return {
    generateRetrospective,
  };
}

module.exports = { createRetrospectiveGenerator };
