'use strict';

/**
 * server/factory/retrospective-generator.js — Retrospective generator service.
 *
 * Collects deterministic stats from a completed workflow's tasks and optionally
 * submits an LLM prompt to produce a structured narrative. The result is stored
 * via the retrospectives CRUD module.
 *
 * Factory function: createRetrospectiveGenerator(deps)
 * Public API:      generateRetrospective(workflowId, projectId)
 */

const logger = require('../logger').child({ component: 'retrospective-generator' });

const RETRO_TASK_TIMEOUT_MINUTES = 10;
const RETRO_POLL_INTERVAL_MS = 3000;
const LLM_UNAVAILABLE_PLACEHOLDER = '[LLM unavailable — stats only]';

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);

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
// Prompt building
// ---------------------------------------------------------------------------

function buildRetrospectivePrompt(stats, taskCount) {
  return [
    'You are reviewing a completed software factory workflow execution.',
    'Analyse the stats below and produce a retrospective.',
    '',
    '## Workflow stats',
    `- Tasks: ${taskCount}`,
    `- Duration: ${stats.duration_seconds !== null ? `${stats.duration_seconds}s` : 'unknown'}`,
    `- Total cost: $${stats.total_cost}`,
    `- Files changed: ${stats.files_changed}`,
    `- Retry count: ${stats.retry_count}`,
    `- Verify passes: ${stats.verify_pass_count}`,
    `- Verify failures: ${stats.verify_fail_count}`,
    `- Flaky tests: ${stats.flaky_count}`,
    '',
    '## Output format',
    'Return ONLY valid JSON matching this exact shape — no explanation outside the JSON:',
    '```json',
    '{',
    '  "smoothness_rating": "smooth | bumpy | rough",',
    '  "learnings": ["string", "..."],',
    '  "friction_points": ["string", "..."],',
    '  "open_items": ["string", "..."],',
    '  "narrative": "Free-text summary of the workflow execution."',
    '}',
    '```',
    '',
    'Rules:',
    '- smoothness_rating MUST be one of: "smooth", "bumpy", "rough".',
    '- "smooth": zero retries, zero verify failures, zero flaky tests.',
    '- "bumpy": some retries or flaky tests but the workflow completed.',
    '- "rough": multiple verify failures, high retry count, or flaky tests.',
    '- learnings: 1-5 short observations about what went well or poorly.',
    '- friction_points: 0-5 specific issues encountered (empty array if none).',
    '- open_items: 0-3 items that warrant follow-up (empty array if none).',
    '- narrative: 2-4 sentence human-readable summary.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

const VALID_SMOOTHNESS_RATINGS = new Set(['smooth', 'bumpy', 'rough']);

function parseRetrospectiveResponse(output) {
  if (typeof output !== 'string' || !output.trim()) {
    return null;
  }

  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== 'object') return null;

    const smoothness = typeof parsed.smoothness_rating === 'string'
      ? parsed.smoothness_rating.trim().toLowerCase()
      : null;

    return {
      smoothness_rating: VALID_SMOOTHNESS_RATINGS.has(smoothness) ? smoothness : null,
      learnings: Array.isArray(parsed.learnings) ? parsed.learnings.filter(s => typeof s === 'string') : [],
      friction_points: Array.isArray(parsed.friction_points) ? parsed.friction_points.filter(s => typeof s === 'string') : [],
      open_items: Array.isArray(parsed.open_items) ? parsed.open_items.filter(s => typeof s === 'string') : [],
      narrative: typeof parsed.narrative === 'string' ? parsed.narrative.trim() : '',
    };
  } catch (err) {
    logger.warn('Failed to parse retrospective LLM response', { err: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic fallback when LLM is unavailable
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
  return {
    smoothness_rating: inferSmoothnessFromStats(stats),
    narrative: LLM_UNAVAILABLE_PLACEHOLDER,
    learnings: [LLM_UNAVAILABLE_PLACEHOLDER],
    friction_points: [],
    open_items: [],
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
   * Submit a retrospective prompt to an LLM via the factory internal-task
   * pipeline and poll for a result. Returns null on any failure.
   */
  async function submitRetrospectiveLLM(prompt, projectId, projectPath) {
    const taskCore = require('../db/task-core');
    const { submitFactoryInternalTask } = require('./internal-task-submit');

    const taskDescription = [
      'You are a retrospective analyst for a software factory.',
      'Read the workflow stats below and return ONLY valid JSON matching the specified format.',
      'No explanation outside the JSON.',
      '',
      prompt,
    ].join('\n');

    let taskId;
    try {
      const result = await submitFactoryInternalTask({
        task: taskDescription,
        working_directory: projectPath || '.',
        kind: 'retrospective_generation',
        project_id: projectId,
        context_stuff: false,
        study_context: false,
        timeout_minutes: RETRO_TASK_TIMEOUT_MINUTES,
      });
      taskId = result.task_id;
      if (!taskId) {
        log.warn('[retrospective-gen] no task_id returned from submit', { project_id: projectId });
        return null;
      }
    } catch (err) {
      log.warn('[retrospective-gen] submit failed', { project_id: projectId, err: err.message });
      return null;
    }

    // Poll until terminal state
    while (true) { // eslint-disable-line no-constant-condition
      let task;
      try {
        task = taskCore.getTask(taskId);
      } catch (err) {
        log.warn('[retrospective-gen] poll error', { task_id: taskId, err: err.message });
        return null;
      }

      if (!task) {
        log.warn('[retrospective-gen] task vanished mid-poll', { task_id: taskId });
        return null;
      }

      if (task.status === 'completed') {
        return task.output || '';
      }

      if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'skipped') {
        const errSnippet = (task.error_output || '').slice(-200);
        log.warn(`[retrospective-gen] task_${task.status}`, {
          task_id: taskId,
          project_id: projectId,
          provider: task.provider || '?',
          error_tail: errSnippet,
        });
        return null;
      }

      await new Promise(resolve => setTimeout(resolve, RETRO_POLL_INTERVAL_MS));
    }
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

    // 1. Get workflow metadata for project path
    const workflow = getWorkflow(workflowId);
    const projectPath = workflow?.context?.working_directory
      || workflow?.context?.project_path
      || '.';

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

    // 4. Attempt LLM narrative generation
    let narrative;
    const prompt = buildRetrospectivePrompt(stats, safeTasks.length);
    try {
      const llmOutput = await submitRetrospectiveLLM(prompt, projectId, projectPath);
      narrative = parseRetrospectiveResponse(llmOutput);
    } catch (err) {
      log.warn('[retrospective-gen] LLM narrative generation failed', {
        workflow_id: workflowId,
        err: err.message,
      });
      narrative = null;
    }

    // 5. Fallback if LLM was unavailable or returned garbage
    if (!narrative) {
      log.info('[retrospective-gen] using deterministic fallback', { workflow_id: workflowId });
      narrative = buildFallbackNarrative(stats);
    }

    // 6. Store via CRUD module
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
