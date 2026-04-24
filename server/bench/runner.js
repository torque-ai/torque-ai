'use strict';

const { randomUUID } = require('crypto');
const db = require('../database');
const workflowHandlers = require('../handlers/workflow');
const { handleRunWorkflowSpec } = require('../handlers/workflow-spec-handlers');
const { computeCompositeScore } = require('./score');
const logger = require('../logger').child({ component: 'bench' });

const DEFAULT_TIMEOUT_MINUTES = 30;
const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);

function getRawDbHandle() {
  const rawDb = typeof db.getDbInstance === 'function' ? db.getDbInstance() : db;
  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('Benchmark runner requires a database handle with prepare()');
  }
  return rawDb;
}

function extractToolErrorMessage(result, fallbackMessage) {
  const contentText = Array.isArray(result?.content)
    ? result.content.find((entry) => typeof entry?.text === 'string' && entry.text.trim().length > 0)?.text
    : null;
  if (contentText) return contentText;
  if (typeof result?.error === 'string' && result.error.trim().length > 0) return result.error;
  if (typeof result?.message === 'string' && result.message.trim().length > 0) return result.message;
  return fallbackMessage;
}

function assertToolSuccess(result, fallbackMessage, options = {}) {
  if (!result?.isError) return result;
  if (options.allowRunning && result.error_code === 'TASK_ALREADY_RUNNING') {
    return result;
  }
  throw new Error(extractToolErrorMessage(result, fallbackMessage));
}

function parseBenchArgs(args = {}) {
  const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
  if (!goal) {
    throw new Error('goal is required');
  }

  if (!Array.isArray(args.specs) || args.specs.length === 0) {
    throw new Error('specs must contain at least one workflow spec path');
  }

  const specs = args.specs.map((spec, index) => {
    if (typeof spec !== 'string' || spec.trim().length === 0) {
      throw new Error(`specs[${index}] must be a non-empty string`);
    }
    return spec.trim();
  });

  const rawRunsPerVariant = args.runs_per_variant ?? 1;
  const runsPerVariant = typeof rawRunsPerVariant === 'string'
    ? Number(rawRunsPerVariant)
    : rawRunsPerVariant;
  if (!Number.isInteger(runsPerVariant) || runsPerVariant < 1) {
    throw new Error('runs_per_variant must be an integer greater than or equal to 1');
  }

  return {
    goal,
    specs,
    runs_per_variant: runsPerVariant,
    working_directory: args.working_directory,
  };
}

function parseTaskTags(task) {
  if (Array.isArray(task?.tags)) {
    return task.tags.filter((tag) => typeof tag === 'string');
  }

  if (typeof task?.tags !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(task.tags);
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function collectMetrics(workflowId) {
  const workflow = typeof db.getWorkflow === 'function' ? db.getWorkflow(workflowId) : null;
  if (!workflow) {
    throw new Error(`Workflow not found after execution: ${workflowId}`);
  }

  const tasks = typeof db.getWorkflowTasks === 'function' ? (db.getWorkflowTasks(workflowId) || []) : [];
  const verifyTags = tasks
    .flatMap(parseTaskTags)
    .filter((tag) => tag.startsWith('tests:'));
  const passCount = verifyTags.filter((tag) => tag === 'tests:pass').length;
  const totalVerified = verifyTags.length;
  const totalCost = tasks.reduce((sum, task) => sum + (Number(task?.cost_usd) || 0), 0);

  const startMs = Date.parse(workflow.started_at || workflow.created_at || new Date().toISOString());
  const endMs = Date.parse(workflow.completed_at || new Date().toISOString());
  const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : 0;

  return {
    status: workflow.status || 'unknown',
    task_count: tasks.length,
    completed_count: tasks.filter((task) => task.status === 'completed').length,
    failed_count: tasks.filter((task) => task.status === 'failed').length,
    verify_pass_rate: totalVerified > 0 ? passCount / totalVerified : null,
    cost_usd: Number(totalCost.toFixed(6)),
    duration_seconds: Math.max(0, Math.round(durationMs / 1000)),
  };
}

async function waitForWorkflowCompletion(workflowId, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES) {
  const deadline = Date.now() + (timeoutMinutes * 60 * 1000);

  while (true) {
    const current = typeof db.getWorkflow === 'function' ? db.getWorkflow(workflowId) : null;
    if (!current) {
      throw new Error(`Workflow not found while awaiting completion: ${workflowId}`);
    }

    if (TERMINAL_WORKFLOW_STATUSES.has(current.status)) {
      return current;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Workflow ${workflowId} did not complete within ${timeoutMinutes} minutes`);
    }

    const awaitResult = await workflowHandlers.handleAwaitWorkflow({
      workflow_id: workflowId,
      timeout_minutes: Math.max(0.01, remainingMs / 60000),
      heartbeat_minutes: 0,
    });
    assertToolSuccess(awaitResult, `Failed while awaiting workflow ${workflowId}`);
  }
}

async function runBench(args) {
  const { goal, specs, runs_per_variant, working_directory } = parseBenchArgs(args);
  const rawDb = getRawDbHandle();
  const benchId = randomUUID();
  const allRuns = [];

  // Sequential by default — parallel would race for codex slots and skew cost/duration metrics
  for (const specPath of specs) {
    for (let i = 0; i < runs_per_variant; i++) {
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      logger.info(`[bench] ${benchId} run ${runId} for ${specPath} (attempt ${i + 1}/${runs_per_variant})`);

      rawDb.prepare(`INSERT INTO bench_runs (id, bench_id, spec_path, goal, started_at, status)
                  VALUES (?, ?, ?, ?, ?, 'pending')`).run(
        runId, benchId, specPath, goal, startedAt
      );

      let workflowId = null;
      let metrics = {};

      try {
        const createResult = await Promise.resolve(handleRunWorkflowSpec({
          spec_path: specPath,
          working_directory,
          goal,
        }));
        assertToolSuccess(createResult, `Failed to create workflow from spec ${specPath}`);

        workflowId = createResult?.structuredData?.workflow_id || createResult?.workflow_id || null;
        if (!workflowId) {
          throw new Error(`Workflow created from ${specPath} but no workflow_id was returned`);
        }

        const runResult = await Promise.resolve(workflowHandlers.handleRunWorkflow({ workflow_id: workflowId }));
        assertToolSuccess(runResult, `Failed to start workflow ${workflowId}`, { allowRunning: true });

        await waitForWorkflowCompletion(workflowId, DEFAULT_TIMEOUT_MINUTES);
        metrics = collectMetrics(workflowId);
      } catch (err) {
        logger.info(`[bench] run ${runId} failed: ${err.message}`);
        metrics = { status: 'failed', error: err.message };
      }

      const composite = computeCompositeScore(metrics);
      rawDb.prepare(`UPDATE bench_runs SET workflow_id = ?, completed_at = ?, status = ?, metrics_json = ?, composite_score = ?
                  WHERE id = ?`).run(
        workflowId,
        new Date().toISOString(),
        metrics.status || 'unknown',
        JSON.stringify(metrics),
        composite,
        runId
      );

      allRuns.push({
        id: runId,
        spec_path: specPath,
        workflow_id: workflowId,
        metrics,
        composite_score: composite,
      });
    }
  }

  return { bench_id: benchId, runs: allRuns };
}

module.exports = { runBench };
