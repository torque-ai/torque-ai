'use strict';

/**
 * Experiment handlers — A/B provider comparison + Experiment SDK MCP tools.
 *
 * The A/B tools (submit_ab_test, compare_ab_test) predate the SDK.
 * The SDK tools (run_experiment, get_experiment_result, diff_experiments,
 * list_experiment_results) wrap the eval primitives (task-spec, run-sample,
 * scorer) into a higher-level experiment API with immutable results and
 * dataset-aware diffing.
 */

const { randomUUID } = require('crypto');
const { resolveDatabaseFacade } = require('../db/database-facade-resolver');
const taskCore = require('../db/task-core');
const { ErrorCodes, makeError } = require('./error-codes');
const logger = require('../logger').child({ component: 'experiment-handlers' });
const { unwrapDbHandle } = require('../utils/db-accessor');
const { createScorer } = require('../evals/scorer');
const { createSolver } = require('../evals/solver');

function getRawDb() {
  return unwrapDbHandle(resolveDatabaseFacade({
    serviceName: 'experiment handlers',
  }));
}

// ── In-memory experiment result store ──
// Keyed by experiment ID. Results are immutable once stored.
const _experimentResults = new Map();
const MAX_STORED_EXPERIMENTS = 200;

function storeExperimentResult(result) {
  // Evict oldest if over capacity
  if (_experimentResults.size >= MAX_STORED_EXPERIMENTS) {
    const oldestKey = _experimentResults.keys().next().value;
    _experimentResults.delete(oldestKey);
  }
  _experimentResults.set(result.id, result);
}

function getExperimentResult(experimentId) {
  return _experimentResults.get(experimentId) || null;
}

function listExperimentResults() {
  return Array.from(_experimentResults.values());
}

// Exported for testing
function clearExperimentResults() {
  _experimentResults.clear();
}

// ── A/B Provider Comparison (existing) ──

/**
 * Submit the same task to two providers for A/B comparison.
 */
function handleSubmitAbTest(args) {
  if (!args?.task_description || typeof args.task_description !== 'string' || !args.task_description.trim()) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_description is required');
  }
  if (!args?.provider_a || typeof args.provider_a !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider_a is required');
  }
  if (!args?.provider_b || typeof args.provider_b !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider_b is required');
  }
  if (args.provider_a === args.provider_b) {
    return makeError(ErrorCodes.INVALID_PARAM, 'provider_a and provider_b must be different');
  }
  if (!args?.working_directory || typeof args.working_directory !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const abTestId = randomUUID();
  const taskIdA = randomUUID();
  const taskIdB = randomUUID();
  const description = args.task_description.trim();
  const workDir = args.working_directory.trim();

  const sharedMetadata = {
    ab_test_id: abTestId,
    ab_test_description: description.slice(0, 200),
  };

  try {
    const rawDb = getRawDb();
    const createBothTasks = rawDb.transaction(() => {
      taskCore.createTask({
        id: taskIdA,
        task_description: description,
        working_directory: workDir,
        provider: args.provider_a,
        model: args.model_a || null,
        status: 'queued',
        metadata: JSON.stringify({
          ...sharedMetadata,
          ab_variant: 'A',
          ab_provider: args.provider_a,
          ab_peer_task_id: taskIdB,
        }),
      });

      taskCore.createTask({
        id: taskIdB,
        task_description: description,
        working_directory: workDir,
        provider: args.provider_b,
        model: args.model_b || null,
        status: 'queued',
        metadata: JSON.stringify({
          ...sharedMetadata,
          ab_variant: 'B',
          ab_provider: args.provider_b,
          ab_peer_task_id: taskIdA,
        }),
      });
    });
    createBothTasks();
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, `Failed to create A/B tasks: ${err.message}`);
  }

  logger.info(`[AbTest] Created A/B test ${abTestId}: A=${args.provider_a} (${taskIdA}), B=${args.provider_b} (${taskIdB})`);

  return {
    content: [{
      type: 'text',
      text: [
        '## A/B Provider Test Created',
        '',
        `**Test ID:** ${abTestId}`,
        `**Task:** ${description.slice(0, 100)}${description.length > 100 ? '...' : ''}`,
        '',
        '| Variant | Provider | Task ID |',
        '|---------|----------|---------|',
        `| **A** | ${args.provider_a} | \`${taskIdA}\` |`,
        `| **B** | ${args.provider_b} | \`${taskIdB}\` |`,
        '',
        'Both tasks are now queued. Use `check_status` on each task ID to monitor progress.',
        'When both complete, compare outputs with `get_result` to evaluate provider quality.',
      ].join('\n'),
    }],
  };
}

/**
 * Compare results of a completed A/B test.
 */
function handleCompareAbTest(args) {
  if (!args?.task_id_a || typeof args.task_id_a !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id_a is required');
  }
  if (!args?.task_id_b || typeof args.task_id_b !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id_b is required');
  }

  const taskA = taskCore.getTask(args.task_id_a);
  const taskB = taskCore.getTask(args.task_id_b);

  if (!taskA) return makeError(ErrorCodes.TASK_NOT_FOUND, `Task A not found: ${args.task_id_a}`);
  if (!taskB) return makeError(ErrorCodes.TASK_NOT_FOUND, `Task B not found: ${args.task_id_b}`);

  function extractDuration(task) {
    if (!task.started_at || !task.completed_at) return null;
    return Math.round((new Date(task.completed_at) - new Date(task.started_at)) / 1000);
  }

  function extractOutputLength(task) {
    return (task.output || '').length;
  }

  const durationA = extractDuration(taskA);
  const durationB = extractDuration(taskB);
  const outputLenA = extractOutputLength(taskA);
  const outputLenB = extractOutputLength(taskB);

  const metaA = (() => { try { return JSON.parse(taskA.metadata || '{}'); } catch { return {}; } })();
  const metaB = (() => { try { return JSON.parse(taskB.metadata || '{}'); } catch { return {}; } })();

  const lines = [
    '## A/B Test Comparison',
    '',
    `**Test ID:** ${metaA.ab_test_id || metaB.ab_test_id || 'unknown'}`,
    '',
    '| Metric | Variant A | Variant B | Winner |',
    '|--------|-----------|-----------|--------|',
    `| **Provider** | ${taskA.provider} | ${taskB.provider} | - |`,
    `| **Status** | ${taskA.status} | ${taskB.status} | ${taskA.status === 'completed' && taskB.status !== 'completed' ? 'A' : taskB.status === 'completed' && taskA.status !== 'completed' ? 'B' : 'Tie'} |`,
    `| **Exit Code** | ${taskA.exit_code} | ${taskB.exit_code} | ${taskA.exit_code === 0 && taskB.exit_code !== 0 ? 'A' : taskB.exit_code === 0 && taskA.exit_code !== 0 ? 'B' : 'Tie'} |`,
    `| **Duration** | ${durationA != null ? durationA + 's' : 'N/A'} | ${durationB != null ? durationB + 's' : 'N/A'} | ${durationA != null && durationB != null ? (durationA < durationB ? 'A' : durationB < durationA ? 'B' : 'Tie') : '-'} |`,
    `| **Output Size** | ${outputLenA.toLocaleString()} chars | ${outputLenB.toLocaleString()} chars | - |`,
  ];

  const reviewA = metaA.strategic_review;
  const reviewB = metaB.strategic_review;
  if (reviewA || reviewB) {
    lines.push(`| **Review** | ${reviewA?.decision || 'N/A'} | ${reviewB?.decision || 'N/A'} | ${reviewA?.decision === 'approve' && reviewB?.decision !== 'approve' ? 'A' : reviewB?.decision === 'approve' && reviewA?.decision !== 'approve' ? 'B' : 'Tie'} |`);
  }

  let scoreA = 0, scoreB = 0;
  if (taskA.status === 'completed') scoreA += 3;
  if (taskB.status === 'completed') scoreB += 3;
  if (taskA.exit_code === 0) scoreA += 2;
  if (taskB.exit_code === 0) scoreB += 2;
  if (durationA != null && durationB != null && durationA < durationB) scoreA += 1;
  if (durationA != null && durationB != null && durationB < durationA) scoreB += 1;

  lines.push('');
  lines.push(`**Overall Score:** A=${scoreA}, B=${scoreB} → **${scoreA > scoreB ? `${taskA.provider} (A) wins` : scoreB > scoreA ? `${taskB.provider} (B) wins` : 'Tie'}**`);

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// ── Experiment SDK handlers ──

/**
 * Run an experiment via MCP: supply a name, inline dataset, scorer kind,
 * and solver kind. The handler builds the eval primitives and delegates
 * to runExperiment().
 *
 * @param {object} args
 * @param {string} args.name - Experiment name
 * @param {Array<object>} args.dataset - Array of sample objects
 * @param {string} [args.scorer_kind] - 'match' | 'choice' (default: 'match')
 * @param {string} [args.target_field] - Dataset field to use as scorer target (default: 'expected')
 * @param {string} [args.input_field] - Dataset field to use as solver input (default: 'input')
 * @param {number} [args.limit] - Max samples to run
 * @param {object} [args.metadata] - Extra metadata
 */
async function handleRunExperiment(args) {
  if (!args?.name || typeof args.name !== 'string' || !args.name.trim()) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name is required');
  }
  if (!args?.dataset || !Array.isArray(args.dataset) || args.dataset.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'dataset must be a non-empty array');
  }
  if (args.dataset.length > 1000) {
    return makeError(ErrorCodes.INVALID_PARAM, 'dataset must have at most 1000 samples');
  }

  const scorerKind = args.scorer_kind || 'match';
  if (!['match', 'choice'].includes(scorerKind)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'scorer_kind must be "match" or "choice"');
  }

  const targetField = args.target_field || 'expected';
  const inputField = args.input_field || 'input';

  const scorer = createScorer({
    kind: scorerKind,
    target: (sample) => sample[targetField],
  });

  // Simple echo solver — takes input_field from the sample and returns it as output.
  // In a real workflow, the solver would call an LLM or tool.
  const solver = createSolver({
    name: 'passthrough',
    run: (sample) => ({ output: sample[inputField] }),
  });

  try {
    const { runExperiment } = require('../evals/experiment');
    const result = await runExperiment(args.name.trim(), {
      dataset: args.dataset,
      solver,
      scorers: scorer,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      metadata: args.metadata || {},
    });

    storeExperimentResult(result);

    const lines = [
      '## Experiment Completed',
      '',
      `**ID:** \`${result.id}\``,
      `**Name:** ${result.name}`,
      `**Dataset:** ${result.aggregate.executed} / ${result.aggregate.requested} samples`,
      `**Mean Score:** ${result.aggregate.mean_value !== null ? result.aggregate.mean_value.toFixed(3) : 'N/A'}`,
      `**Completed:** ${result.aggregate.completed} | **Errored:** ${result.aggregate.errored} | **Blocked:** ${result.aggregate.blocked}`,
      '',
      `Use \`get_experiment_result { experiment_id: "${result.id}" }\` to retrieve full results.`,
      `Use \`diff_experiments\` to compare against another experiment on the same dataset.`,
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    logger.error(`[ExperimentSDK] runExperiment failed: ${err.message}`);
    return makeError(ErrorCodes.INTERNAL_ERROR, `Experiment failed: ${err.message}`);
  }
}

/**
 * Retrieve a stored experiment result by ID.
 */
function handleGetExperimentResult(args) {
  if (!args?.experiment_id || typeof args.experiment_id !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'experiment_id is required');
  }

  const result = getExperimentResult(args.experiment_id);
  if (!result) {
    return makeError(ErrorCodes.EXPERIMENT_NOT_FOUND, `Experiment not found: ${args.experiment_id}`);
  }

  const rowSummaries = (result.rows || []).slice(0, 50).map((row) => {
    const scoreVal = row.score && typeof row.score.value === 'number'
      ? row.score.value.toFixed(3)
      : 'N/A';
    return `| ${row.index} | ${row.status} | ${scoreVal} | ${row.duration_ms || 0}ms |`;
  });

  const lines = [
    `## Experiment: ${result.name}`,
    '',
    `**ID:** \`${result.id}\``,
    `**Dataset Identity:** \`${result.dataset_identity}\``,
    `**Started:** ${result.started_at}`,
    `**Completed:** ${result.completed_at}`,
    `**Scorer Count:** ${result.scorer_count}`,
    '',
    '### Aggregate',
    `- Executed: ${result.aggregate.executed} / ${result.aggregate.requested}`,
    `- Completed: ${result.aggregate.completed}`,
    `- Errored: ${result.aggregate.errored}`,
    `- Blocked: ${result.aggregate.blocked}`,
    `- Mean Score: ${result.aggregate.mean_value !== null ? result.aggregate.mean_value.toFixed(3) : 'N/A'}`,
    '',
    '### Row Results (first 50)',
    '| Index | Status | Score | Duration |',
    '|-------|--------|-------|----------|',
    ...rowSummaries,
  ];

  if (result.rows.length > 50) {
    lines.push(``, `_...and ${result.rows.length - 50} more rows_`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * Diff two experiments on the same dataset.
 */
function handleDiffExperiments(args) {
  if (!args?.base_experiment_id || typeof args.base_experiment_id !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'base_experiment_id is required');
  }
  if (!args?.new_experiment_id || typeof args.new_experiment_id !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'new_experiment_id is required');
  }

  const baseResult = getExperimentResult(args.base_experiment_id);
  const newResult = getExperimentResult(args.new_experiment_id);

  if (!baseResult) {
    return makeError(ErrorCodes.EXPERIMENT_NOT_FOUND, `Base experiment not found: ${args.base_experiment_id}`);
  }
  if (!newResult) {
    return makeError(ErrorCodes.EXPERIMENT_NOT_FOUND, `New experiment not found: ${args.new_experiment_id}`);
  }

  try {
    const { diffExperiments } = require('../evals/experiment');
    const diff = diffExperiments(baseResult, newResult);

    const changedRows = (diff.changed || []).slice(0, 20).map((ch) => {
      const delta = ch.score_delta >= 0 ? `+${ch.score_delta.toFixed(3)}` : ch.score_delta.toFixed(3);
      return `| ${ch.index} | ${ch.base.status} → ${ch.new.status} | ${delta} |`;
    });

    const lines = [
      '## Experiment Diff',
      '',
      `**Base:** \`${diff.base_experiment_id}\``,
      `**New:** \`${diff.new_experiment_id}\``,
      `**Dataset:** \`${diff.dataset_identity}\``,
      '',
      '### Summary',
      `- Total rows: ${diff.summary.total_rows}`,
      `- Changed: ${diff.summary.changed}`,
      `- Unchanged: ${diff.summary.unchanged}`,
      `- Added: ${diff.summary.added}`,
      `- Removed: ${diff.summary.removed}`,
      `- Base mean score: ${diff.summary.base_mean_score !== null ? diff.summary.base_mean_score.toFixed(3) : 'N/A'}`,
      `- New mean score: ${diff.summary.new_mean_score !== null ? diff.summary.new_mean_score.toFixed(3) : 'N/A'}`,
      `- Mean score delta: ${diff.summary.mean_score_delta !== null ? (diff.summary.mean_score_delta >= 0 ? '+' : '') + diff.summary.mean_score_delta.toFixed(3) : 'N/A'}`,
    ];

    if (changedRows.length > 0) {
      lines.push(
        '',
        '### Changed Rows (first 20)',
        '| Index | Status Change | Score Delta |',
        '|-------|---------------|-------------|',
        ...changedRows,
      );
      if (diff.changed.length > 20) {
        lines.push(``, `_...and ${diff.changed.length - 20} more changed rows_`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INVALID_PARAM, err.message);
  }
}

/**
 * List all stored experiment results.
 */
function handleListExperimentResults(args) {
  const results = listExperimentResults();

  if (results.length === 0) {
    return {
      content: [{ type: 'text', text: 'No experiment results stored. Run `run_experiment` to create one.' }],
    };
  }

  const rows = results.map((r) => {
    const mean = r.aggregate && r.aggregate.mean_value !== null
      ? r.aggregate.mean_value.toFixed(3)
      : 'N/A';
    return `| \`${r.id.slice(0, 8)}…\` | ${r.name} | ${r.aggregate.executed}/${r.aggregate.requested} | ${mean} | ${r.completed_at || 'N/A'} |`;
  });

  const lines = [
    `## Experiment Results (${results.length})`,
    '',
    '| ID | Name | Samples | Mean Score | Completed |',
    '|----|------|---------|------------|-----------|',
    ...rows,
  ];

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function createExperimentHandlers() {
  return {
    handleSubmitAbTest,
    handleCompareAbTest,
    handleRunExperiment,
    handleGetExperimentResult,
    handleDiffExperiments,
    handleListExperimentResults,
  };
}

module.exports = {
  handleSubmitAbTest,
  handleCompareAbTest,
  handleRunExperiment,
  handleGetExperimentResult,
  handleDiffExperiments,
  handleListExperimentResults,
  createExperimentHandlers,
  // Exported for testing
  clearExperimentResults,
};
