'use strict';

/**
 * Experiment tool definitions — A/B provider comparison + Experiment SDK.
 */

module.exports = [
  // ── A/B Provider Comparison (existing) ──
  {
    name: 'submit_ab_test',
    description: 'Submit the same task to two different providers for A/B comparison. Creates two identical tasks with different providers, both queued simultaneously. Use compare_ab_test after both complete to see results.',
    inputSchema: {
      type: 'object',
      properties: {
        task_description: {
          type: 'string',
          description: 'The task description to send to both providers (identical)',
        },
        provider_a: {
          type: 'string',
          description: 'First provider (e.g., "codex", "ollama")',
        },
        provider_b: {
          type: 'string',
          description: 'Second provider (e.g., "codex", "ollama")',
        },
        working_directory: {
          type: 'string',
          description: 'Working directory for both tasks',
        },
        model_a: {
          type: 'string',
          description: 'Optional model override for provider A',
        },
        model_b: {
          type: 'string',
          description: 'Optional model override for provider B',
        },
      },
      required: ['task_description', 'provider_a', 'provider_b', 'working_directory'],
    },
  },
  {
    name: 'compare_ab_test',
    description: 'Compare results of a completed A/B provider test. Shows side-by-side metrics: status, duration, output size, exit code, and overall winner.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id_a: {
          type: 'string',
          description: 'Task ID for variant A',
        },
        task_id_b: {
          type: 'string',
          description: 'Task ID for variant B',
        },
      },
      required: ['task_id_a', 'task_id_b'],
    },
  },

  // ── Experiment SDK ──
  {
    name: 'run_experiment',
    description: 'Run an experiment: execute a solver against a dataset and score every row using the eval primitives (task-spec, run-sample, scorer). Returns an experiment result with stable IDs, aggregate scores, and per-row results. Results are stored in memory and can be retrieved via get_experiment_result or compared via diff_experiments.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable experiment name',
        },
        dataset: {
          type: 'array',
          description: 'Array of sample objects. Each sample should have an input field and an expected field for scoring.',
          items: { type: 'object' },
        },
        scorer_kind: {
          type: 'string',
          description: 'Scorer kind: "match" (exact equality) or "choice" (option selection). Default: "match"',
          enum: ['match', 'choice'],
        },
        target_field: {
          type: 'string',
          description: 'Dataset field to use as the scorer target. Default: "expected"',
        },
        input_field: {
          type: 'string',
          description: 'Dataset field used as solver input. Default: "input"',
        },
        limit: {
          type: 'number',
          description: 'Max number of samples to run. Default: all',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary metadata to attach to the experiment result',
        },
      },
      required: ['name', 'dataset'],
    },
  },
  {
    name: 'get_experiment_result',
    description: 'Retrieve a stored experiment result by ID. Shows aggregate scores, dataset identity, and per-row results.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment_id: {
          type: 'string',
          description: 'The experiment ID returned by run_experiment',
        },
      },
      required: ['experiment_id'],
    },
  },
  {
    name: 'diff_experiments',
    description: 'Compare two experiment results on the same dataset. Reports added, removed, changed, and unchanged rows with score deltas. Rejects comparisons across different datasets.',
    inputSchema: {
      type: 'object',
      properties: {
        base_experiment_id: {
          type: 'string',
          description: 'ID of the baseline experiment',
        },
        new_experiment_id: {
          type: 'string',
          description: 'ID of the new experiment to compare against baseline',
        },
      },
      required: ['base_experiment_id', 'new_experiment_id'],
    },
  },
  {
    name: 'list_experiment_results',
    description: 'List all stored experiment results with their IDs, names, sample counts, and mean scores.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
