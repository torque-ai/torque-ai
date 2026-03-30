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
