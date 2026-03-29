module.exports = [
  {
    name: 'search_symbols',
    description: 'Search indexed code symbols (functions, classes, interfaces) by name. Returns symbol locations without reading full files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name to search for' },
        working_directory: { type: 'string', description: 'Project directory' },
        kind: { type: 'string', enum: ['function', 'class', 'interface', 'method', 'type', 'enum', 'const'], description: 'Filter by symbol kind' },
        limit: { type: 'number', description: 'Max results (default: 50)', default: 50 },
      },
      required: ['query', 'working_directory'],
    },
  },
  {
    name: 'get_file_outline',
    description: 'Get a structural outline of a file showing all symbols (functions, classes, methods) with line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File to outline' },
        working_directory: { type: 'string', description: 'Project directory' },
      },
      required: ['file_path', 'working_directory'],
    },
  },
  {
    name: 'index_project',
    description: 'Trigger symbol indexing for a project. Incrementally indexes only changed files.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: { type: 'string', description: 'Project directory to index' },
      },
      required: ['working_directory'],
    },
  },
];
