// server/tool-defs/diffusion-defs.js
'use strict';

module.exports = [
  {
    name: 'submit_scout',
    description: 'Submit a scout-mode task that analyzes the codebase without modifying files. The scout produces a structured diffusion plan (patterns, exemplar diffs, file manifest) that can be used with create_diffusion_plan to fan out work across multiple providers. Scouts require filesystem access — only codex and claude-cli providers are supported.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Description of what to analyze (e.g., "find all test files importing database.js directly")' },
        working_directory: { type: 'string', description: 'Project root directory' },
        file_patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional glob patterns to focus analysis (e.g., ["server/tests/**/*.test.js"]). Expanded server-side into a file list.',
        },
        provider: { type: 'string', description: 'Provider to use (must be filesystem-capable: codex, claude-cli). Default: codex.' },
        timeout_minutes: { type: 'number', description: 'Scout timeout in minutes (default: 10)' },
      },
      required: ['scope', 'working_directory'],
    },
  },
  {
    name: 'create_diffusion_plan',
    description: 'Generate a TORQUE workflow from a diffusion plan (produced by a scout task or constructed manually). Converts the plan into batched subtasks with DAG or optimistic-parallel convergence. Returns a workflow ID for use with await_workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'object', description: 'Diffusion plan JSON (matching the schema from submit_scout output)' },
        working_directory: { type: 'string', description: 'Project root directory for fan-out tasks' },
        batch_size: { type: 'number', description: 'Files per subtask (default: 1, or plan recommended_batch_size)' },
        provider: { type: 'string', description: 'Provider preference for fan-out tasks (default: smart routing)' },
        convergence: { type: 'string', enum: ['optimistic', 'dag'], description: 'Override convergence strategy (default: auto-selected from plan)' },
        depth: { type: 'number', description: 'Recursive diffusion depth counter (default: 0). Max: 2.' },
        auto_run: { type: 'boolean', description: 'Start the workflow immediately (default: true)' },
        verify_command: { type: 'string', description: 'Build/compile command to verify fan-out task output (e.g., "dotnet build", "npx tsc --noEmit"). Required — falls back to project defaults if not provided.' },
        compute_provider: { type: 'string', description: 'Provider for compute stage (reasoning, no filesystem needed). E.g., "cerebras", "groq". If set, enables compute→apply pipeline.' },
        apply_provider: { type: 'string', description: 'Provider for apply stage (filesystem access required). E.g., "ollama", "codex". Default: "ollama".' },
      },
      required: ['plan', 'working_directory'],
    },
  },
  {
    name: 'diffusion_status',
    description: 'View active diffusion sessions. Shows scout tasks pending, fan-out workflows in progress, convergence state, and depth counters. Data is derived from workflow metadata (no new database tables).',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Optional: filter to a specific diffusion workflow' },
      },
    },
  },
];
