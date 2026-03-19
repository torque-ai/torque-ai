'use strict';

module.exports = [
  {
    name: 'strategic_decompose',
    description: 'Decompose a feature into ordered implementation sub-tasks using a 405B strategic model. Falls back to deterministic decomposition if the model is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        feature_name: { type: 'string', description: 'Name of the feature to decompose (e.g., "UserProfile", "TradeSystem")' },
        feature_description: { type: 'string', description: 'Detailed description of what the feature should do' },
        working_directory: { type: 'string', description: 'Project root directory' },
        project_structure: { type: 'string', description: 'Optional: description of project file structure for context' },
        provider: { type: 'string', enum: ['deepinfra', 'hyperbolic'], description: 'Cloud provider for the strategic model (default: deepinfra)' },
        model: { type: 'string', description: 'Model override (default: meta-llama/Llama-3.1-405B-Instruct)' },
      },
      required: ['feature_name', 'working_directory'],
    },
  },
  {
    name: 'strategic_diagnose',
    description: 'Diagnose a failed task and recommend recovery action using a 405B strategic model. Falls back to pattern-matching rules if the model is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to diagnose (reads task details from DB)' },
        error_output: { type: 'string', description: 'Error output to diagnose (alternative to task_id)' },
        provider: { type: 'string', description: 'Provider that failed (for context)' },
        exit_code: { type: 'number', description: 'Exit code of the failed task' },
        auto_act: { type: 'boolean', description: 'If true, automatically execute the recommended recovery action (default: false)' },
        strategic_provider: { type: 'string', enum: ['deepinfra', 'hyperbolic'], description: 'Cloud provider for the strategic model (default: deepinfra)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'strategic_review',
    description: 'Review a completed task output for quality using a 405B strategic model. Falls back to rule-based validation if the model is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to review (reads output and validation from DB)' },
        task_output: { type: 'string', description: 'Task output to review (alternative to task_id)' },
        validation_failures: {
          type: 'array', description: 'Validation failures from safeguard checks',
          items: { type: 'object', properties: { severity: { type: 'string' }, rule: { type: 'string' }, details: { type: 'string' } } },
        },
        file_size_delta_pct: { type: 'number', description: 'File size change percentage' },
        strategic_provider: { type: 'string', enum: ['deepinfra', 'hyperbolic'], description: 'Cloud provider for the strategic model (default: deepinfra)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'strategic_usage',
    description: 'Get usage statistics for the strategic orchestrator layer — total calls, tokens, cost, and fallback rate.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'strategic_benchmark',
    description: 'Run the strategic brain benchmark suite — tests decomposition, diagnosis, and review against predefined coding tasks. Returns comparison-ready results.',
    inputSchema: {
      type: 'object',
      properties: {
        suite: { type: 'string', enum: ['decompose', 'diagnose', 'review', 'all'], description: 'Which benchmark suite to run (default: all)' },
        provider: { type: 'string', enum: ['deepinfra', 'hyperbolic'], description: 'Cloud provider for the strategic model (default: deepinfra)' },
        model: { type: 'string', description: 'Model override (default: meta-llama/Llama-3.1-405B-Instruct)' },
        output_format: { type: 'string', enum: ['summary', 'csv', 'full'], description: 'Output format (default: summary)' },
      },
      required: [],
    },
  },
];
