'use strict';

/**
 * Experiment 6: A/B Provider Comparison Tool Definitions
 */

module.exports = [
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
          description: 'First provider (e.g., "codex", "hashline-ollama", "ollama")',
        },
        provider_b: {
          type: 'string',
          description: 'Second provider (e.g., "codex", "hashline-ollama", "ollama")',
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
];
