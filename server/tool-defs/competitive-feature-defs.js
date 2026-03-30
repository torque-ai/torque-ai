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
];
