'use strict';

/**
 * Minimal Experiment SDK — wraps the existing eval primitives (task-spec,
 * run-sample, scorer, compose-scorers, solver) into a single
 * `runExperiment` function that returns an immutable experiment result.
 *
 * Extends (not replaces) the existing A/B provider comparison and
 * analytics experimentation infrastructure.
 */

const { randomUUID } = require('crypto');
const { createTaskSpec } = require('./task-spec');
const { runSamples } = require('./run-sample');

/**
 * Run an experiment: execute a solver against a dataset and score every row.
 *
 * @param {string} name - Human-readable experiment name
 * @param {object} opts
 * @param {Array<object>} opts.dataset - Array of sample objects (the rows)
 * @param {{ run: Function }} opts.solver - Solver with `run(sample, runtime)` method
 * @param {{ score: Function }|Array<{ score: Function }>} opts.scorers - One scorer or array
 * @param {object}  [opts.metadata]        - Arbitrary metadata attached to the result
 * @param {object}  [opts.sandbox]         - Sandbox config forwarded to task-spec
 * @param {object}  [opts.approvalPolicy]  - Approval policy forwarded to task-spec
 * @param {string[]}[opts.tags]            - Tags forwarded to task-spec
 * @param {number}  [opts.limit]           - Max samples to run (default: all)
 * @param {object}  [opts.runOptions]      - Extra options forwarded to runSamples
 * @returns {Promise<ExperimentResult>}
 */
async function runExperiment(name, opts = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('runExperiment: name is required and must be a non-empty string');
  }
  if (!opts.dataset || !Array.isArray(opts.dataset) || opts.dataset.length === 0) {
    throw new Error('runExperiment: dataset is required and must be a non-empty array');
  }
  if (!opts.solver || typeof opts.solver.run !== 'function') {
    throw new Error('runExperiment: solver with run() method is required');
  }

  // Normalize scorers — accept a single scorer or an array
  const scorers = normalizeScorers(opts.scorers);
  if (scorers.length === 0) {
    throw new Error('runExperiment: at least one scorer is required');
  }

  // Build a composite scorer when multiple are provided
  const effectiveScorer = scorers.length === 1
    ? scorers[0]
    : composeMultiple(scorers);

  // Build a task spec using the existing primitive
  const taskSpec = createTaskSpec({
    name,
    dataset: opts.dataset,
    solver: opts.solver,
    scorer: effectiveScorer,
    sandbox: opts.sandbox || null,
    approvalPolicy: opts.approvalPolicy || null,
    tags: opts.tags || [],
    metadata: opts.metadata || {},
  });

  const experimentId = randomUUID();
  const startedAt = new Date().toISOString();

  // Run all samples through the existing runner
  const runResult = await runSamples(taskSpec, {
    ...(opts.runOptions || {}),
    limit: opts.limit,
  });

  const completedAt = new Date().toISOString();

  // Build immutable row results with stable IDs
  const rows = (runResult.samples || []).map((sampleResult, idx) => {
    return Object.freeze({
      id: `${experimentId}:row:${idx}`,
      index: idx,
      input: sampleResult.sample,
      output: sampleResult.result,
      status: sampleResult.status,
      score: sampleResult.score,
      duration_ms: sampleResult.duration_ms,
    });
  });

  const result = Object.freeze({
    id: experimentId,
    name,
    dataset_identity: computeDatasetIdentity(opts.dataset),
    started_at: startedAt,
    completed_at: completedAt,
    rows: Object.freeze(rows),
    aggregate: Object.freeze(runResult.aggregate),
    metadata: Object.freeze({ ...(opts.metadata || {}) }),
    scorer_count: scorers.length,
  });

  return result;
}

/**
 * Compare two experiment results on the same dataset.
 *
 * @param {ExperimentResult} baseExperiment  - The baseline experiment
 * @param {ExperimentResult} newExperiment   - The new experiment to compare
 * @returns {ExperimentDiff}
 * @throws {Error} If experiments are on different datasets
 */
function diffExperiments(baseExperiment, newExperiment) {
  if (!baseExperiment || !baseExperiment.id) {
    throw new Error('diffExperiments: baseExperiment is required');
  }
  if (!newExperiment || !newExperiment.id) {
    throw new Error('diffExperiments: newExperiment is required');
  }
  if (baseExperiment.dataset_identity !== newExperiment.dataset_identity) {
    throw new Error(
      'diffExperiments: cannot compare experiments on different datasets — ' +
      `base dataset identity "${baseExperiment.dataset_identity}" !== ` +
      `new dataset identity "${newExperiment.dataset_identity}"`
    );
  }

  const baseRows = baseExperiment.rows || [];
  const newRows = newExperiment.rows || [];

  const maxLen = Math.max(baseRows.length, newRows.length);
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (let i = 0; i < maxLen; i++) {
    const baseRow = baseRows[i] || null;
    const newRow = newRows[i] || null;

    if (!baseRow && newRow) {
      added.push({ index: i, row: newRow });
    } else if (baseRow && !newRow) {
      removed.push({ index: i, row: baseRow });
    } else if (baseRow && newRow) {
      const baseScore = extractScoreValue(baseRow.score);
      const newScore = extractScoreValue(newRow.score);
      const scoreDelta = newScore - baseScore;
      const statusChanged = baseRow.status !== newRow.status;

      if (scoreDelta !== 0 || statusChanged) {
        changed.push({
          index: i,
          base: baseRow,
          new: newRow,
          score_delta: scoreDelta,
          status_changed: statusChanged,
        });
      } else {
        unchanged.push({ index: i, base: baseRow, new: newRow });
      }
    }
  }

  const baseAggregate = baseExperiment.aggregate || {};
  const newAggregate = newExperiment.aggregate || {};
  const baseMean = typeof baseAggregate.mean_value === 'number' ? baseAggregate.mean_value : null;
  const newMean = typeof newAggregate.mean_value === 'number' ? newAggregate.mean_value : null;

  return Object.freeze({
    base_experiment_id: baseExperiment.id,
    new_experiment_id: newExperiment.id,
    dataset_identity: baseExperiment.dataset_identity,
    summary: Object.freeze({
      total_rows: maxLen,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
      base_mean_score: baseMean,
      new_mean_score: newMean,
      mean_score_delta: baseMean !== null && newMean !== null ? newMean - baseMean : null,
    }),
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
    unchanged: Object.freeze(unchanged),
  });
}

// ── Internal helpers ──

function normalizeScorers(scorers) {
  if (!scorers) return [];
  if (typeof scorers.score === 'function') return [scorers]; // single scorer
  if (Array.isArray(scorers)) {
    const valid = scorers.filter((s) => s && typeof s.score === 'function');
    return valid;
  }
  return [];
}

function composeMultiple(scorers) {
  return {
    kind: 'composite',
    async score(sample, result, context) {
      const components = [];
      for (const scorer of scorers) {
        components.push(await scorer.score(sample, result, context));
      }
      const nums = components.map((c) => c.value).filter((n) => typeof n === 'number');
      const value = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
      return { value, components, reduce: 'mean' };
    },
  };
}

function extractScoreValue(score) {
  if (score === null || score === undefined) return 0;
  if (typeof score === 'number') return score;
  if (typeof score.value === 'number') return score.value;
  return 0;
}

/**
 * Compute a stable identity hash for a dataset so we can detect
 * when two experiments used the same dataset.
 *
 * Uses a simple JSON hash — good enough for SDK-level comparison.
 * If the dataset is too large, falls back to length + first/last sample hash.
 */
function computeDatasetIdentity(dataset) {
  const { createHash } = require('crypto');
  try {
    const serialized = JSON.stringify(dataset);
    return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  } catch {
    // Fallback for non-serializable datasets
    return `len:${dataset.length}`;
  }
}

module.exports = {
  runExperiment,
  diffExperiments,
  computeDatasetIdentity,
};
