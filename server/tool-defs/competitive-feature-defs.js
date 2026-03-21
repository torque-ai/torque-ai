module.exports = [
  {
    name: 'get_tool_schema',
    description: 'Get the full inputSchema for a specific MCP tool by name. Use this for on-demand schema discovery instead of loading all schemas at once.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Exact name of the tool to look up' },
      },
      required: ['tool_name'],
    },
  },
  {
    name: 'compare_providers',
    description: 'Run the same prompt on multiple providers and compare results side-by-side. Returns timing, output length, and success status for each.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to all providers' },
        providers: { type: 'array', items: { type: 'string' }, description: 'Array of provider IDs to compare (e.g., ["codex", "deepinfra", "ollama"])' },
        working_directory: { type: 'string', description: 'Working directory for task execution' },
        timeout_minutes: { type: 'number', description: 'Max wait time per provider (default: 5)' },
      },
      required: ['prompt', 'providers'],
    },
  },
  {
    name: 'review_task_output',
    description: 'Run AI-powered structured code review on a completed task. Creates an async review task that checks for logic errors, readability, performance, test coverage, and security.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the completed task to review' },
        provider: { type: 'string', description: 'Provider for the review (default: codex)' },
        working_directory: { type: 'string', description: 'Working directory for git diff' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'discover_agents',
    description: 'Auto-detect installed AI CLI tools (Claude, Codex, Gemini, Ollama, Aider) and suggest configuration. Returns installed/missing agents with version info.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'detect_project_type',
    description: 'Auto-detect project type (Node.js, TypeScript, Python, etc.) from file markers and dependencies. Returns framework-specific agent context for prompt injection.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: { type: 'string', description: 'Project directory to scan' },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'list_project_templates',
    description: 'List all available project type templates with their detection markers and priorities.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_provider_scores',
    description: 'View provider scoring metrics — composite scores, reliability, speed, quality, and cost efficiency. Scores are computed from actual task completion data.',
    inputSchema: {
      type: 'object',
      properties: {
        trusted_only: { type: 'boolean', description: 'Only show providers with 5+ samples (default: true)' },
      },
      required: [],
    },
  },
  {
    name: 'get_circuit_breaker_status',
    description: 'View circuit breaker status for all providers. Shows which providers are tripped (OPEN), probing (HALF_OPEN), or healthy (CLOSED).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'polish_task_description',
    description: 'Convert rough task text into structured format with title, description, and acceptance criteria.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Raw task description text to polish' },
      },
      required: ['text'],
    },
  },
];
