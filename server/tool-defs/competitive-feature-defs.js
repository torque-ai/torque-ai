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
  {
    name: 'index_project',
    description: 'Parse project source files with tree-sitter and build a symbol index (functions, classes, interfaces, types). Enables symbol-level context stuffing instead of whole-file reads. Incremental — only re-parses changed files.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: { type: 'string', description: 'Project directory to index' },
        force: { type: 'boolean', description: 'Force full re-index (ignore content hashes)' },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'search_symbols',
    description: 'Search the symbol index for functions, classes, interfaces, types by name. Returns file location and line numbers. Requires index_project to have been run first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name to search for' },
        working_directory: { type: 'string', description: 'Project directory scope' },
        mode: { type: 'string', enum: ['contains', 'prefix', 'exact'], description: 'Match mode (default: contains)' },
        kind: { type: 'string', enum: ['function', 'class', 'method', 'interface', 'type', 'enum'], description: 'Filter by symbol kind' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: ['query', 'working_directory'],
    },
  },
  {
    name: 'get_symbol_source',
    description: 'Get the source code for a specific symbol by its index ID. Returns the exact lines from the file.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol_id: { type: 'number', description: 'Symbol ID from search_symbols results' },
      },
      required: ['symbol_id'],
    },
  },
  {
    name: 'get_file_outline',
    description: 'Get a hierarchical outline of all symbols in a file (functions, classes, methods). Requires index_project first.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        working_directory: { type: 'string', description: 'Project directory scope' },
      },
      required: ['file_path', 'working_directory'],
    },
  },
];
